"""Google Drive API クライアント
ファイル一覧取得・ダウンロードを担当。
"""

import io

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

from src.config import DriveConfig
from src.logging.logger import setup_logger
from src.models import DriveFile

logger = setup_logger()


class DriveClient:
    # 読み取り + ファイル名 rename（files.update のメタデータ変更）に drive スコープが必要。
    # SA が編集者として共有されているファイルだけが対象。
    SCOPES = [
        "https://www.googleapis.com/auth/drive",
    ]

    # 成功時にファイル名先頭へ付与するプレフィックス
    DONE_PREFIX = "【済】"
    # 既にこれらで始まっていれば二重付与しない
    _ALREADY_DONE_PREFIXES = ("[済]", "【済】")

    # 再帰探索の MIME type
    _FOLDER_MIME = "application/vnd.google-apps.folder"
    _SHORTCUT_MIME = "application/vnd.google-apps.shortcut"

    # 探索フォルダ数の上限（暴発防止）
    _MAX_FOLDERS_TO_TRAVERSE = 100

    def __init__(self, config: DriveConfig, credentials_path: str | None = None):
        self._config = config
        if credentials_path:
            creds = service_account.Credentials.from_service_account_file(
                credentials_path, scopes=self.SCOPES
            )
        else:
            import google.auth

            creds, _ = google.auth.default(scopes=self.SCOPES)
        self._service = build("drive", "v3", credentials=creds)

    def list_files(self, folder_id: str) -> list[DriveFile]:
        """指定フォルダ配下のレシートファイルを**再帰的に**取得する。

        - 画像 / PDF だけを対象（`supported_mime_types`）
        - サブフォルダも BFS で辿る（月別フォルダ等に対応）
        - ショートカット（`application/vnd.google-apps.shortcut`）は辿らない
        - `excluded_file_name_prefixes` にマッチするファイルは除外（[済] / 【済】等）
        - 同一ファイル ID の重複は排除
        - 循環参照防止のため訪問済みフォルダを記録
        - 探索フォルダ数は `_MAX_FOLDERS_TO_TRAVERSE` で上限
        """
        if not folder_id:
            raise ValueError("folder_id が空です")

        excluded_prefixes = self._config.excluded_file_name_prefixes
        target_mimes = set(self._config.supported_mime_types)

        # 「対象MIME or フォルダMIME」を1クエリでまとめて取得
        mime_parts = [f"mimeType='{m}'" for m in self._config.supported_mime_types]
        mime_parts.append(f"mimeType='{self._FOLDER_MIME}'")
        mime_filter = " or ".join(mime_parts)

        seen_folders: set[str] = set()
        seen_file_ids: set[str] = set()
        files: list[DriveFile] = []
        excluded_count = 0
        queue: list[str] = [folder_id]

        while queue:
            if len(seen_folders) >= self._MAX_FOLDERS_TO_TRAVERSE:
                logger.warning(
                    f"探索フォルダ数上限 {self._MAX_FOLDERS_TO_TRAVERSE} 到達、以降打ち切り",
                    extra={"step": "drive_list_limit"},
                )
                break

            current = queue.pop(0)
            if current in seen_folders:
                continue
            seen_folders.add(current)

            query = f"'{current}' in parents and ({mime_filter}) and trashed=false"
            page_token: str | None = None
            while True:
                resp = (
                    self._service.files()
                    .list(
                        q=query,
                        fields="nextPageToken, files(id, name, mimeType)",
                        pageSize=100,
                        pageToken=page_token,
                    )
                    .execute()
                )
                for f in resp.get("files", []):
                    mime = f.get("mimeType", "")
                    fid = f["id"]
                    name = f["name"]

                    if mime == self._FOLDER_MIME:
                        # 子フォルダはキューに積む（未訪問のみ）
                        if fid not in seen_folders:
                            queue.append(fid)
                        continue

                    if mime == self._SHORTCUT_MIME:
                        # ショートカットは辿らない
                        continue

                    if mime not in target_mimes:
                        # 対象 MIME 以外（念のためのガード）
                        continue

                    if fid in seen_file_ids:
                        # 重複排除
                        continue
                    seen_file_ids.add(fid)

                    # [済]/【済】等のプレフィックス除外
                    if any(name.startswith(p) for p in excluded_prefixes):
                        excluded_count += 1
                        logger.info(
                            f"除外: {name}（プレフィックスマッチ）",
                            extra={"step": "drive_list_exclude", "file_id": fid},
                        )
                        continue

                    files.append(
                        DriveFile(
                            file_id=fid,
                            file_name=name,
                            mime_type=mime,
                            folder_id=current,
                        )
                    )

                page_token = resp.get("nextPageToken")
                if not page_token:
                    break

        logger.info(
            (
                f"Drive 再帰探索: 開始={folder_id}, "
                f"走査フォルダ={len(seen_folders)}件, "
                f"対象ファイル={len(files)}件, 除外={excluded_count}件"
            ),
            extra={"step": "drive_list"},
        )
        return files

    def rename_file_as_done(self, file: DriveFile) -> str | None:
        """成功したファイルのファイル名先頭に `【済】` を付与する。
        既に [済] / 【済】 で始まる場合は何もしない。
        戻り値: 新しいファイル名（付与した場合）、または None（付与しなかった場合）
        """
        if any(file.file_name.startswith(p) for p in self._ALREADY_DONE_PREFIXES):
            logger.info(
                f"rename スキップ（既に済プレフィックス付き）: {file.file_name}",
                extra={"step": "drive_rename_skip", "file_id": file.file_id},
            )
            return None

        new_name = f"{self.DONE_PREFIX}{file.file_name}"
        self._service.files().update(
            fileId=file.file_id,
            body={"name": new_name},
        ).execute()
        logger.info(
            f"rename: {file.file_name} → {new_name}",
            extra={"step": "drive_rename", "file_id": file.file_id},
        )
        # インメモリのオブジェクトも更新しておく
        file.file_name = new_name
        return new_name

    def download_file(self, file: DriveFile) -> DriveFile:
        """ファイルをメモリにダウンロードする"""
        req = self._service.files().get_media(fileId=file.file_id)
        buf = io.BytesIO()
        dl = MediaIoBaseDownload(buf, req)
        done = False
        while not done:
            _, done = dl.next_chunk()
        file.content = buf.getvalue()
        logger.info(
            f"DL: {file.file_name} ({len(file.content)} bytes)",
            extra={"step": "drive_download", "file_id": file.file_id},
        )
        return file

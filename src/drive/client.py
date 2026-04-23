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
    # 出納帳は手動作成運用に切り替えたため、読み取り専用スコープで十分
    SCOPES = [
        "https://www.googleapis.com/auth/drive.readonly",
    ]

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
        """指定フォルダ内の対象ファイル一覧を取得する。
        excluded_file_name_prefixes で始まるファイルは除外する（例: `[済]` 付き）。
        """
        if not folder_id:
            raise ValueError("folder_id が空です")
        mime_filter = " or ".join(f"mimeType='{m}'" for m in self._config.supported_mime_types)
        query = f"'{folder_id}' in parents and ({mime_filter}) and trashed=false"
        excluded_prefixes = self._config.excluded_file_name_prefixes
        raw_files: list[DriveFile] = []
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
                raw_files.append(
                    DriveFile(
                        file_id=f["id"],
                        file_name=f["name"],
                        mime_type=f["mimeType"],
                        folder_id=folder_id,
                    )
                )
            page_token = resp.get("nextPageToken")
            if not page_token:
                break

        files: list[DriveFile] = []
        excluded_count = 0
        for f in raw_files:
            if any(f.file_name.startswith(p) for p in excluded_prefixes):
                excluded_count += 1
                logger.info(
                    f"除外: {f.file_name}（プレフィックスマッチ）",
                    extra={"step": "drive_list_exclude", "file_id": f.file_id},
                )
            else:
                files.append(f)

        logger.info(
            f"Drive: {folder_id} から {len(files)} 件検出（除外 {excluded_count} 件）",
            extra={"step": "drive_list"},
        )
        return files

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

"""Google Drive API クライアント"""

import io
from typing import Optional

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

from src.config import DriveConfig
from src.models import DriveFile
from src.logging.logger import setup_logger

logger = setup_logger()


class DriveClient:
    SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

    def __init__(self, config: DriveConfig, credentials_path: Optional[str] = None):
        self._config = config
        if credentials_path:
            creds = service_account.Credentials.from_service_account_file(
                credentials_path, scopes=self.SCOPES
            )
        else:
            import google.auth
            creds, _ = google.auth.default(scopes=self.SCOPES)
        self._service = build("drive", "v3", credentials=creds)

    def list_files(self, folder_id: Optional[str] = None) -> list[DriveFile]:
        target = folder_id or self._config.source_folder_id
        if not target:
            raise ValueError("DRIVE_FOLDER_ID が未設定です")

        mime_filter = " or ".join(
            f"mimeType='{m}'" for m in self._config.supported_mime_types
        )
        query = f"'{target}' in parents and ({mime_filter}) and trashed=false"
        files: list[DriveFile] = []
        page_token: Optional[str] = None

        while True:
            resp = self._service.files().list(
                q=query,
                fields="nextPageToken, files(id, name, mimeType)",
                pageSize=100,
                pageToken=page_token,
            ).execute()
            for f in resp.get("files", []):
                files.append(DriveFile(
                    file_id=f["id"], file_name=f["name"],
                    mime_type=f["mimeType"], folder_id=target,
                ))
            page_token = resp.get("nextPageToken")
            if not page_token:
                break

        logger.info(
            f"Drive: {len(files)} 件検出",
            extra={"step": "drive_list"},
        )
        return files

    def download_file(self, file: DriveFile) -> DriveFile:
        request = self._service.files().get_media(fileId=file.file_id)
        buf = io.BytesIO()
        dl = MediaIoBaseDownload(buf, request)
        done = False
        while not done:
            _, done = dl.next_chunk()
        file.content = buf.getvalue()
        logger.info(
            f"ダウンロード: {file.file_name} ({len(file.content)} bytes)",
            extra={"step": "drive_download", "file_id": file.file_id},
        )
        return file

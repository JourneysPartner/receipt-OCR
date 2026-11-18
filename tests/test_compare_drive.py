"""比較の Drive は読取り専用だけ（S2）のテスト"""

from unittest.mock import MagicMock, patch

import pytest

from src.config import DriveConfig
from src.drive.client import DriveClient
from src.models import DriveFile

READ_ONLY = "https://www.googleapis.com/auth/drive.readonly"


class TestReadOnlyScopes:
    def test_credentials_use_only_drive_readonly(self):
        with (
            patch(
                "src.drive.client.service_account.Credentials.from_service_account_file"
            ) as from_file,
            patch("src.drive.client.build") as build,
        ):
            DriveClient(DriveConfig(), "cred.json", read_only=True)
        from_file.assert_called_once_with("cred.json", scopes=[READ_ONLY])
        build.assert_called_once()

    def test_default_credentials_use_only_drive_readonly(self):
        with (
            patch("google.auth.default") as default,
            patch("src.drive.client.build"),
        ):
            default.return_value = (MagicMock(), "project")
            DriveClient(DriveConfig(), read_only=True)
        default.assert_called_once_with(scopes=[READ_ONLY])

    def test_write_client_keeps_old_scope(self):
        with (
            patch(
                "src.drive.client.service_account.Credentials.from_service_account_file"
            ) as from_file,
            patch("src.drive.client.build"),
        ):
            DriveClient(DriveConfig(), "cred.json")
        assert "https://www.googleapis.com/auth/drive" in from_file.call_args.kwargs["scopes"]
        assert READ_ONLY not in from_file.call_args.kwargs["scopes"]


class TestReadOnlyRename:
    def _client(self):
        client = DriveClient.__new__(DriveClient)
        client._config = DriveConfig()
        client._read_only = True
        client._service = MagicMock()
        return client

    def test_rename_raises_without_api_call(self):
        client = self._client()
        file = DriveFile(
            file_id="FILE_A1234567890",
            file_name="a.jpg",
            mime_type="image/jpeg",
            folder_id="F",
        )
        with pytest.raises(RuntimeError, match="読取り専用"):
            client.rename_file_as_done(file)
        client._service.files.assert_not_called()
        assert file.file_name == "a.jpg"


class TestGetName:
    def test_get_name_reads_only_name_field(self):
        client = DriveClient.__new__(DriveClient)
        client._config = DriveConfig()
        client._service = MagicMock()
        client._service.files.return_value.get.return_value.execute.return_value = {
            "name": "テスト用フォルダ"
        }
        assert client.get_name("FOLDER_A1234567890") == "テスト用フォルダ"
        client._service.files.return_value.get.assert_called_once_with(
            fileId="FOLDER_A1234567890", fields="name"
        )

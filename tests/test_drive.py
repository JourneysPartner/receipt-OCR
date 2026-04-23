"""DriveClient のテスト（API モック）"""

from unittest.mock import MagicMock

from src.config import DriveConfig
from src.drive.client import DriveClient
from src.models import DriveFile


def _make_client(config: DriveConfig | None = None) -> tuple[DriveClient, MagicMock]:
    """API を叩かないモック化された DriveClient を作る。
    戻り値: (client, mock_files_list)
    """
    dc = DriveClient.__new__(DriveClient)
    dc._config = config or DriveConfig()

    mock_files = MagicMock()
    mock_svc = MagicMock()
    mock_svc.files.return_value = mock_files
    dc._service = mock_svc
    return dc, mock_files.list


def _make_client_with_update() -> tuple[DriveClient, MagicMock]:
    dc = DriveClient.__new__(DriveClient)
    dc._config = DriveConfig()
    mock_files = MagicMock()
    mock_svc = MagicMock()
    mock_svc.files.return_value = mock_files
    dc._service = mock_svc
    return dc, mock_files.update


def _files_response(names: list[str]) -> dict:
    return {
        "files": [
            {"id": f"id{i}", "name": n, "mimeType": "image/jpeg"} for i, n in enumerate(names)
        ],
    }


class TestListFilesExclusion:
    def test_excludes_sumi_bracket_prefix(self):
        """`[済]` で始まるファイルは除外される"""
        dc, mock_list = _make_client()
        mock_list.return_value.execute.return_value = _files_response(
            ["receipt_A.jpg", "[済] receipt_B.jpg", "[済]receipt_C.jpg", "receipt_D.pdf"]
        )
        result = dc.list_files("folder_X")
        names = [f.file_name for f in result]
        assert "receipt_A.jpg" in names
        assert "receipt_D.pdf" in names
        assert "[済] receipt_B.jpg" not in names
        assert "[済]receipt_C.jpg" not in names

    def test_excludes_zenkaku_sumi_bracket(self):
        """全角`【済】`で始まるファイルも除外される"""
        dc, mock_list = _make_client()
        mock_list.return_value.execute.return_value = _files_response(
            ["【済】 receipt.jpg", "通常.jpg"]
        )
        result = dc.list_files("folder_X")
        names = [f.file_name for f in result]
        assert names == ["通常.jpg"]

    def test_custom_prefixes_via_config(self):
        """excluded_file_name_prefixes を上書きできる"""
        cfg = DriveConfig(excluded_file_name_prefixes=("DONE:",))
        dc, mock_list = _make_client(cfg)
        mock_list.return_value.execute.return_value = _files_response(
            ["DONE: a.jpg", "[済] b.jpg", "c.jpg"]
        )
        result = dc.list_files("folder_X")
        names = [f.file_name for f in result]
        # "[済] b.jpg" はこの設定では除外対象ではないので残る
        assert "[済] b.jpg" in names
        assert "DONE: a.jpg" not in names
        assert "c.jpg" in names

    def test_no_exclusion_without_match(self):
        """プレフィックスにマッチしないものは全て残る"""
        dc, mock_list = _make_client()
        mock_list.return_value.execute.return_value = _files_response(
            ["a.jpg", "b.pdf", "完了 c.jpg"]
        )
        result = dc.list_files("folder_X")
        assert len(result) == 3


class TestRenameFileAsDone:
    def _make_file(self, name: str) -> DriveFile:
        return DriveFile(file_id="abc", file_name=name, mime_type="image/jpeg", folder_id="f1")

    def test_adds_sumi_prefix(self):
        dc, mock_update = _make_client_with_update()
        f = self._make_file("receipt_A.jpg")
        new = dc.rename_file_as_done(f)
        assert new == "【済】receipt_A.jpg"
        mock_update.assert_called_once_with(fileId="abc", body={"name": "【済】receipt_A.jpg"})
        # file オブジェクトも更新される
        assert f.file_name == "【済】receipt_A.jpg"

    def test_skip_when_already_zenkaku_sumi(self):
        dc, mock_update = _make_client_with_update()
        f = self._make_file("【済】receipt.jpg")
        result = dc.rename_file_as_done(f)
        assert result is None
        mock_update.assert_not_called()
        assert f.file_name == "【済】receipt.jpg"  # 変更されない

    def test_skip_when_already_hankaku_sumi(self):
        dc, mock_update = _make_client_with_update()
        f = self._make_file("[済] receipt.jpg")
        result = dc.rename_file_as_done(f)
        assert result is None
        mock_update.assert_not_called()

    def test_drive_scope_includes_write(self):
        """rename のために drive スコープ（読み書き両方）を要求している"""
        assert "https://www.googleapis.com/auth/drive" in DriveClient.SCOPES

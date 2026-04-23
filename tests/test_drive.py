"""DriveClient のテスト（API モック）"""

from unittest.mock import MagicMock

from src.config import DriveConfig
from src.drive.client import DriveClient


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

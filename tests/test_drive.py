"""DriveClient のテスト（API モック）"""

from unittest.mock import MagicMock

from src.config import DriveConfig
from src.drive.client import DriveClient
from src.models import DriveFile

FOLDER_MIME = "application/vnd.google-apps.folder"
SHORTCUT_MIME = "application/vnd.google-apps.shortcut"


def _file_entry(fid: str, name: str, mime: str = "image/jpeg") -> dict:
    return {"id": fid, "name": name, "mimeType": mime}


def _folder_entry(fid: str, name: str) -> dict:
    return {"id": fid, "name": name, "mimeType": FOLDER_MIME}


def _make_client(
    folder_contents: dict[str, list[dict]],
    config: DriveConfig | None = None,
) -> DriveClient:
    """
    folder_contents: {folder_id: [file/folder entry, ...]}
    files.list の呼び出しで q='{folder_id}' in parents ... を解析し、
    該当フォルダの子を返すモック。
    """
    dc = DriveClient.__new__(DriveClient)
    dc._config = config or DriveConfig()

    mock_files = MagicMock()
    mock_svc = MagicMock()
    mock_svc.files.return_value = mock_files
    dc._service = mock_svc

    def _side_effect(**kwargs):
        q = kwargs["q"]
        # "'{folder_id}' in parents and ..." から folder_id を抽出
        parent_id = q.split("'")[1]
        entries = folder_contents.get(parent_id, [])
        response = MagicMock()
        response.execute.return_value = {"files": entries}
        return response

    mock_files.list.side_effect = _side_effect
    return dc


def _make_client_with_update() -> tuple[DriveClient, MagicMock]:
    dc = DriveClient.__new__(DriveClient)
    dc._config = DriveConfig()
    mock_files = MagicMock()
    mock_svc = MagicMock()
    mock_svc.files.return_value = mock_files
    dc._service = mock_svc
    return dc, mock_files.update


# ================================================================
# 再帰探索
# ================================================================
class TestListFilesRecursive:
    def test_single_flat_folder(self):
        """サブフォルダなしの単一フォルダ"""
        dc = _make_client({"root": [_file_entry("f1", "a.jpg")]})
        result = dc.list_files("root")
        assert [f.file_name for f in result] == ["a.jpg"]

    def test_descends_into_subfolder(self):
        """D列フォルダ配下の月別サブフォルダも辿る"""
        dc = _make_client(
            {
                "root": [
                    _file_entry("f1", "direct.jpg"),
                    _folder_entry("sub1", "2026-04"),
                ],
                "sub1": [_file_entry("f2", "in_april.pdf", "application/pdf")],
            }
        )
        result = dc.list_files("root")
        names = sorted(f.file_name for f in result)
        assert names == ["direct.jpg", "in_april.pdf"]

    def test_deep_nested_folders(self):
        """孫フォルダまで辿る"""
        dc = _make_client(
            {
                "root": [_folder_entry("sub1", "2026")],
                "sub1": [_folder_entry("sub2", "04")],
                "sub2": [_folder_entry("sub3", "現金")],
                "sub3": [_file_entry("f1", "receipt.jpg")],
            }
        )
        result = dc.list_files("root")
        assert [f.file_name for f in result] == ["receipt.jpg"]

    def test_excluded_prefix_applied_recursively(self):
        """[済] 除外は子フォルダ内のファイルにも適用される"""
        dc = _make_client(
            {
                "root": [_folder_entry("sub", "月別")],
                "sub": [
                    _file_entry("f1", "receipt.jpg"),
                    _file_entry("f2", "[済] 処理済み.jpg"),
                    _file_entry("f3", "【済】 全角済み.pdf", "application/pdf"),
                ],
            }
        )
        result = dc.list_files("root")
        names = [f.file_name for f in result]
        assert names == ["receipt.jpg"]

    def test_shortcut_not_followed(self):
        """Drive ショートカットは辿らない"""
        dc = _make_client(
            {
                "root": [
                    {"id": "sc1", "name": "外部ショートカット", "mimeType": SHORTCUT_MIME},
                    _file_entry("f1", "ok.jpg"),
                ],
            }
        )
        result = dc.list_files("root")
        assert [f.file_name for f in result] == ["ok.jpg"]

    def test_deduplicates_file_ids(self):
        """同じ file_id が複数の親にあっても1つだけ返す"""
        # ※ 実際には 1 ファイルが複数の parents を持ちうる
        dc = _make_client(
            {
                "root": [
                    _folder_entry("sub1", "a"),
                    _folder_entry("sub2", "b"),
                ],
                "sub1": [_file_entry("shared", "同じ.jpg")],
                "sub2": [_file_entry("shared", "同じ.jpg")],
            }
        )
        result = dc.list_files("root")
        assert len(result) == 1
        assert result[0].file_id == "shared"

    def test_no_infinite_loop_on_cycle(self):
        """サブフォルダがループ参照しても無限ループしない"""
        dc = _make_client(
            {
                "root": [_folder_entry("a", "A")],
                "a": [_folder_entry("b", "B")],
                "b": [_folder_entry("a", "A again"), _file_entry("f1", "ok.jpg")],
            }
        )
        result = dc.list_files("root")
        assert [f.file_name for f in result] == ["ok.jpg"]

    def test_folder_id_recorded_to_discovered_parent(self):
        """DriveFile.folder_id には実際に発見されたサブフォルダIDが入る"""
        dc = _make_client(
            {
                "root": [_folder_entry("sub", "2026-04")],
                "sub": [_file_entry("f1", "r.jpg")],
            }
        )
        result = dc.list_files("root")
        assert result[0].folder_id == "sub"

    def test_empty_folder_returns_empty(self):
        dc = _make_client({"root": []})
        assert dc.list_files("root") == []

    def test_raises_on_empty_folder_id(self):
        dc = _make_client({})
        import pytest

        with pytest.raises(ValueError):
            dc.list_files("")

    def test_non_target_mime_filtered(self):
        """対象 MIME 以外（docx 等）は返らない。
        実際のクエリでもサーバ側で弾かれるが、念のため。
        """
        dc = _make_client(
            {
                "root": [
                    _file_entry("f1", "a.jpg"),
                    # 対象 MIME 以外 — 本来 API クエリで除外されるがローカルモックでは来てしまう
                    {"id": "f2", "name": "doc.docx", "mimeType": "application/vnd.docx"},
                ],
            }
        )
        result = dc.list_files("root")
        assert [f.file_name for f in result] == ["a.jpg"]


# ================================================================
# rename
# ================================================================
class TestRenameFileAsDone:
    def _make_file(self, name: str) -> DriveFile:
        return DriveFile(file_id="abc", file_name=name, mime_type="image/jpeg", folder_id="f1")

    def test_adds_sumi_prefix(self):
        dc, mock_update = _make_client_with_update()
        f = self._make_file("receipt_A.jpg")
        new = dc.rename_file_as_done(f)
        assert new == "【済】receipt_A.jpg"
        mock_update.assert_called_once_with(fileId="abc", body={"name": "【済】receipt_A.jpg"})
        assert f.file_name == "【済】receipt_A.jpg"

    def test_skip_when_already_zenkaku_sumi(self):
        dc, mock_update = _make_client_with_update()
        f = self._make_file("【済】receipt.jpg")
        result = dc.rename_file_as_done(f)
        assert result is None
        mock_update.assert_not_called()
        assert f.file_name == "【済】receipt.jpg"

    def test_skip_when_already_hankaku_sumi(self):
        dc, mock_update = _make_client_with_update()
        f = self._make_file("[済] receipt.jpg")
        result = dc.rename_file_as_done(f)
        assert result is None
        mock_update.assert_not_called()

    def test_drive_scope_includes_write(self):
        assert "https://www.googleapis.com/auth/drive" in DriveClient.SCOPES

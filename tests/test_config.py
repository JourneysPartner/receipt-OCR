"""設定読み込みのテスト"""

from src.config import _parse_int_tuple, load_config


class TestParseIntTuple:
    def test_none(self):
        assert _parse_int_tuple(None, (1, 2)) == (1, 2)

    def test_csv(self):
        assert _parse_int_tuple("0,1,2", ()) == (0, 1, 2)

    def test_spaces(self):
        assert _parse_int_tuple("3, 5, 13", ()) == (3, 5, 13)


class TestLoadConfig:
    def test_defaults(self, monkeypatch):
        for k in [
            "MASTER_SPREADSHEET_ID",
            "INDIVIDUAL_TEMPLATE_SPREADSHEET_ID",
            "CORPORATE_TEMPLATE_SPREADSHEET_ID",
            "CASHBOOK_OUTPUT_FOLDER_ID",
            "GEMINI_API_KEY",
            "CASHBOOK_COLUMN_MAP",
            "CASHBOOK_OCCUPIED_CHECK_COLUMNS",
        ]:
            monkeypatch.delenv(k, raising=False)
        c = load_config()
        assert c.master.spreadsheet_id == ""
        assert c.master.target_entry_type == "当方記帳"
        assert c.sheets.occupied_check_columns == (0, 1, 2)
        assert c.sheets.protected_columns == (3, 13)
        assert c.ai.engine == "gemini"
        assert c.reservation_ttl_minutes == 30
        assert "ファイルリンク" in c.sheets.cashbook_column_map

    def test_master_override(self, monkeypatch):
        monkeypatch.setenv("MASTER_SPREADSHEET_ID", "master1")
        monkeypatch.setenv("MASTER_TARGET_ENTRY_TYPE", "先方記帳")
        c = load_config()
        assert c.master.spreadsheet_id == "master1"
        assert c.master.target_entry_type == "先方記帳"

    def test_template_override(self, monkeypatch):
        monkeypatch.setenv("INDIVIDUAL_TEMPLATE_SPREADSHEET_ID", "ind1")
        monkeypatch.setenv("CORPORATE_TEMPLATE_SPREADSHEET_ID", "corp1")
        monkeypatch.setenv("CASHBOOK_OUTPUT_FOLDER_ID", "folder1")
        c = load_config()
        assert c.template.individual_template_id == "ind1"
        assert c.template.corporate_template_id == "corp1"
        assert c.template.output_folder_id == "folder1"

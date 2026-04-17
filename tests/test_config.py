"""設定読み込みのテスト"""

from src.config import load_config, _parse_int_tuple


class TestParseIntTuple:
    def test_none_returns_default(self):
        assert _parse_int_tuple(None, (1, 2, 3)) == (1, 2, 3)

    def test_empty_returns_default(self):
        assert _parse_int_tuple("", (1, 2, 3)) == (1, 2, 3)

    def test_parses_csv(self):
        assert _parse_int_tuple("0,1,2", ()) == (0, 1, 2)

    def test_parses_with_spaces(self):
        assert _parse_int_tuple("3, 5, 13", ()) == (3, 5, 13)

    def test_single(self):
        assert _parse_int_tuple("1", ()) == (1,)


class TestLoadConfig:
    def test_defaults(self, monkeypatch):
        for k in ["DRIVE_FOLDER_ID", "SPREADSHEET_ID", "GEMINI_API_KEY",
                   "CASHBOOK_COLUMN_MAP", "CASHBOOK_PROTECTED_COLUMNS",
                   "CASHBOOK_FORMULA_COPY_COLUMNS", "CASHBOOK_OCCUPIED_CHECK_COLUMNS",
                   "RESERVATION_TTL_MINUTES"]:
            monkeypatch.delenv(k, raising=False)
        c = load_config()
        assert c.sheets.occupied_check_columns == (0, 1, 2)
        assert c.sheets.cashbook_data_start_row == 5
        assert c.sheets.protected_columns == (3, 13)
        assert c.sheets.formula_copy_columns == (3, 13)
        assert c.ai.engine == "gemini"
        assert c.reservation_ttl_minutes == 30
        assert "ファイルリンク" in c.sheets.cashbook_column_map
        assert c.sheets.cashbook_column_map["ファイルリンク"] == 0

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv("DRIVE_FOLDER_ID", "f1")
        monkeypatch.setenv("SPREADSHEET_ID", "s1")
        monkeypatch.setenv("DRY_RUN", "true")
        monkeypatch.setenv("RESERVATION_TTL_MINUTES", "60")
        monkeypatch.setenv("CASHBOOK_OCCUPIED_CHECK_COLUMNS", "0,1")
        c = load_config()
        assert c.drive.source_folder_id == "f1"
        assert c.dry_run is True
        assert c.reservation_ttl_minutes == 60
        assert c.sheets.occupied_check_columns == (0, 1)

    def test_protected_columns_override(self, monkeypatch):
        monkeypatch.setenv("CASHBOOK_PROTECTED_COLUMNS", "3,5,13")
        c = load_config()
        assert c.sheets.protected_columns == (3, 5, 13)

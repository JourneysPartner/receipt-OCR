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

    def test_cashbook_sheet_name_default_when_env_unset(self, monkeypatch):
        """
        CASHBOOK_SHEET_NAME 未設定時は `入力用` になること。
        回帰防止: load_config() の os.environ.get フォールバックが
        誤って `現金出納帳` を返さないことを保証する。
        """
        monkeypatch.delenv("CASHBOOK_SHEET_NAME", raising=False)
        c = load_config()
        assert c.sheets.cashbook_sheet_name == "入力用"

    def test_cashbook_sheet_name_env_override(self, monkeypatch):
        """env で明示指定すればその値が使われる"""
        monkeypatch.setenv("CASHBOOK_SHEET_NAME", "別タブ")
        c = load_config()
        assert c.sheets.cashbook_sheet_name == "別タブ"

    def test_error_detail_column_default(self, monkeypatch):
        """エラー詳細列の既定値は O列 (14)"""
        monkeypatch.delenv("CASHBOOK_ERROR_DETAIL_COLUMN", raising=False)
        c = load_config()
        assert c.sheets.error_detail_column == 14

    def test_error_detail_column_override(self, monkeypatch):
        """CASHBOOK_ERROR_DETAIL_COLUMN で上書き可能"""
        monkeypatch.setenv("CASHBOOK_ERROR_DETAIL_COLUMN", "20")
        c = load_config()
        assert c.sheets.error_detail_column == 20

    def test_excluded_file_name_prefixes_default(self, monkeypatch):
        """既定で [済] と 【済】 が除外プレフィックスに含まれる"""
        monkeypatch.delenv("EXCLUDED_FILE_NAME_PREFIXES", raising=False)
        c = load_config()
        assert "[済]" in c.drive.excluded_file_name_prefixes
        assert "【済】" in c.drive.excluded_file_name_prefixes

    def test_excluded_file_name_prefixes_override(self, monkeypatch):
        monkeypatch.setenv("EXCLUDED_FILE_NAME_PREFIXES", "DONE:,FINISHED:")
        c = load_config()
        assert c.drive.excluded_file_name_prefixes == ("DONE:", "FINISHED:")

    def test_account_code_lookup_columns_default(self, monkeypatch):
        """Q:R 参照表の既定位置は Q列(16) / R列(17)、開始行1"""
        for k in (
            "CASHBOOK_ACCOUNT_CODE_COLUMN",
            "CASHBOOK_ACCOUNT_NAME_COLUMN",
            "CASHBOOK_ACCOUNT_TABLE_START_ROW",
        ):
            monkeypatch.delenv(k, raising=False)
        c = load_config()
        assert c.sheets.account_code_column == 16
        assert c.sheets.account_name_column == 17
        assert c.sheets.account_table_start_row == 1

    def test_account_code_lookup_columns_override(self, monkeypatch):
        monkeypatch.setenv("CASHBOOK_ACCOUNT_CODE_COLUMN", "5")
        monkeypatch.setenv("CASHBOOK_ACCOUNT_NAME_COLUMN", "6")
        monkeypatch.setenv("CASHBOOK_ACCOUNT_TABLE_START_ROW", "2")
        c = load_config()
        assert c.sheets.account_code_column == 5
        assert c.sheets.account_name_column == 6
        assert c.sheets.account_table_start_row == 2

    def test_account_alias_map_default(self, monkeypatch):
        """既定で複数の表記揺れ吸収が登録されている"""
        monkeypatch.delenv("CASHBOOK_ACCOUNT_ALIAS_MAP", raising=False)
        c = load_config()
        m = c.sheets.account_alias_map
        # 主要なケースが入っていること
        assert m.get("接待交際費") == "交際費"
        assert m.get("接待費") == "交際費"
        assert m.get("交通費") == "旅費交通費"
        assert m.get("ガソリン代") == "車両費"
        assert m.get("印紙代") == "租税公課"

    def test_ocr_fallback_default_none(self, monkeypatch):
        monkeypatch.delenv("OCR_FALLBACK_ENGINE", raising=False)
        c = load_config()
        assert c.ocr.fallback_engine is None
        assert c.ocr.fallback_confidence_threshold == 0.6

    def test_ocr_fallback_env_override(self, monkeypatch):
        monkeypatch.setenv("OCR_FALLBACK_ENGINE", "vision_document")
        monkeypatch.setenv("OCR_FALLBACK_CONFIDENCE_THRESHOLD", "0.75")
        c = load_config()
        assert c.ocr.fallback_engine == "vision_document"
        assert c.ocr.fallback_confidence_threshold == 0.75

    def test_amount_validation_retry_default_on(self, monkeypatch):
        monkeypatch.delenv("ENABLE_AMOUNT_VALIDATION_RETRY", raising=False)
        c = load_config()
        assert c.ai.enable_amount_validation_retry is True

    def test_amount_validation_retry_can_be_disabled(self, monkeypatch):
        monkeypatch.setenv("ENABLE_AMOUNT_VALIDATION_RETRY", "false")
        c = load_config()
        assert c.ai.enable_amount_validation_retry is False

    def test_account_alias_map_env_override(self, monkeypatch):
        """JSON で別名辞書を全置換できる"""
        monkeypatch.setenv(
            "CASHBOOK_ACCOUNT_ALIAS_MAP",
            '{"外注費": "業務委託費", "接待交際費": "交際費"}',
        )
        c = load_config()
        assert c.sheets.account_alias_map == {
            "外注費": "業務委託費",
            "接待交際費": "交際費",
        }

    def test_master_override(self, monkeypatch):
        monkeypatch.setenv("MASTER_SPREADSHEET_ID", "master1")
        monkeypatch.setenv("MASTER_TARGET_ENTRY_TYPE", "先方記帳")
        c = load_config()
        assert c.master.spreadsheet_id == "master1"
        assert c.master.target_entry_type == "先方記帳"

    def test_template_config_still_loadable(self, monkeypatch):
        """テンプレート系は現在は未使用だが、設定読み込み自体は壊れていないこと"""
        monkeypatch.setenv("INDIVIDUAL_TEMPLATE_SPREADSHEET_ID", "ind1")
        monkeypatch.setenv("CORPORATE_TEMPLATE_SPREADSHEET_ID", "corp1")
        monkeypatch.setenv("CASHBOOK_OUTPUT_FOLDER_ID", "folder1")
        c = load_config()
        assert c.template.individual_template_id == "ind1"
        assert c.template.corporate_template_id == "corp1"
        assert c.template.output_folder_id == "folder1"

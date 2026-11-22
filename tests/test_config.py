"""設定読み込みのテスト"""

import pytest

from src.config import (
    AiConfig,
    _parse_ai_thinking_level,
    _parse_int_tuple,
    load_config,
)


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

    def test_extraction_retry_default_on(self, monkeypatch):
        monkeypatch.delenv("ENABLE_EXTRACTION_RETRY", raising=False)
        c = load_config()
        assert c.ai.enable_extraction_retry is True

    def test_extraction_retry_can_be_disabled(self, monkeypatch):
        monkeypatch.setenv("ENABLE_EXTRACTION_RETRY", "false")
        c = load_config()
        assert c.ai.enable_extraction_retry is False

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


class TestPromptVersionAndFlow:
    def test_defaults(self, monkeypatch):
        monkeypatch.delenv("AI_PROMPT_VERSION", raising=False)
        monkeypatch.delenv("AI_FLOW", raising=False)
        c = load_config()
        assert c.ai.prompt_version == "v2"
        assert c.ai.flow == "dual"

    def test_blank_values_are_defaults(self, monkeypatch):
        monkeypatch.setenv("AI_PROMPT_VERSION", "   ")
        monkeypatch.setenv("AI_FLOW", "  ")
        c = load_config()
        assert c.ai.prompt_version == "v2"
        assert c.ai.flow == "dual"

    def test_valid_values(self, monkeypatch):
        monkeypatch.setenv("AI_PROMPT_VERSION", "v2")
        monkeypatch.setenv("AI_FLOW", "dual")
        c = load_config()
        assert c.ai.prompt_version == "v2"
        assert c.ai.flow == "dual"

    def test_values_are_normalized(self, monkeypatch):
        monkeypatch.setenv("AI_PROMPT_VERSION", " V2 ")
        monkeypatch.setenv("AI_FLOW", " Dual ")
        c = load_config()
        assert c.ai.prompt_version == "v2"
        assert c.ai.flow == "dual"

    def test_invalid_prompt_version(self, monkeypatch):
        # v3 を足したので、誤った値は v4 で確かめる（仕様 review_precision §6.1）
        monkeypatch.setenv("AI_PROMPT_VERSION", "v4")
        with pytest.raises(ValueError) as e:
            load_config()
        assert "AI_PROMPT_VERSION は 'v1' / 'v2' / 'v3' のいずれか" in str(e.value)

    def test_invalid_flow(self, monkeypatch):
        monkeypatch.setenv("AI_FLOW", "both")
        with pytest.raises(ValueError) as e:
            load_config()
        assert "AI_FLOW は 'text_first' / 'dual' のいずれか" in str(e.value)


AI_DEFAULT_ENV = (
    "AI_MODEL",
    "AI_PROMPT_VERSION",
    "AI_FLOW",
    "AI_THINKING_LEVEL",
)


class TestAiDefaults:
    def test_load_config_defaults(self, monkeypatch):
        for name in AI_DEFAULT_ENV:
            monkeypatch.delenv(name, raising=False)
        c = load_config()
        assert c.ai.model == "gemini-3.5-flash-lite"
        assert c.ai.prompt_version == "v2"
        assert c.ai.flow == "dual"
        assert c.ai.thinking_level == "low"

    def test_ai_config_defaults(self):
        ai = AiConfig()
        assert ai.model == "gemini-3.5-flash-lite"
        assert ai.prompt_version == "v2"
        assert ai.flow == "dual"
        assert ai.thinking_level == "low"

    def test_other_defaults_unchanged(self, monkeypatch):
        for name in AI_DEFAULT_ENV:
            monkeypatch.delenv(name, raising=False)
        c = load_config()
        assert c.ai.engine == "gemini"
        assert c.ai.max_tokens == 2048
        assert c.ai.temperature == 0.1
        assert c.ai.confidence_threshold == 0.7
        assert c.ai.enable_amount_validation_retry is True
        assert c.ai.enable_extraction_retry is True
        assert c.ai.request_timeout_seconds is None

    def test_env_restores_previous_behavior(self, monkeypatch):
        monkeypatch.setenv("AI_MODEL", "gemini-2.5-flash")
        monkeypatch.setenv("AI_PROMPT_VERSION", "v1")
        monkeypatch.setenv("AI_FLOW", "text_first")
        monkeypatch.setenv("AI_THINKING_LEVEL", "none")
        c = load_config()
        assert c.ai.model == "gemini-2.5-flash"
        assert c.ai.prompt_version == "v1"
        assert c.ai.flow == "text_first"
        assert c.ai.thinking_level is None


class TestAiThinkingLevel:
    @pytest.mark.parametrize(
        "raw, expected",
        [
            (None, "low"),
            ("", "low"),
            ("   ", "low"),
            ("none", None),
            ("NONE", None),
            (" None ", None),
            ("low", "low"),
            ("HIGH", "high"),
        ],
    )
    def test_values(self, raw, expected):
        assert _parse_ai_thinking_level(raw) == expected

    def test_invalid_value_raises(self):
        with pytest.raises(ValueError) as e:
            _parse_ai_thinking_level("max")
        assert "AI_THINKING_LEVEL" in str(e.value)

    def test_load_config_none_means_no_thinking(self, monkeypatch):
        monkeypatch.setenv("AI_THINKING_LEVEL", "NONE")
        c = load_config()
        assert c.ai.thinking_level is None

    def test_load_config_invalid_value_raises(self, monkeypatch):
        monkeypatch.setenv("AI_THINKING_LEVEL", "max")
        with pytest.raises(ValueError) as e:
            load_config()
        assert "AI_THINKING_LEVEL" in str(e.value)


SECOND_READER_ENV = (
    *AI_DEFAULT_ENV,
    "AI_SECOND_READER",
    "RUN_MODE",
    "TARGET_SCOPE",
    "TARGET_ROW",
)


def _load_with_second(monkeypatch, value=None):
    for name in SECOND_READER_ENV:
        monkeypatch.delenv(name, raising=False)
    if value is not None:
        monkeypatch.setenv("AI_SECOND_READER", value)
    return load_config()


class TestAiSecondReader:
    @pytest.mark.parametrize("raw", [None, "", "   ", "none", "NONE", " None "])
    def test_off_values(self, monkeypatch, raw):
        c = _load_with_second(monkeypatch, raw)
        assert c.ai.second_reader_model is None
        assert c.ai.second_reader_thinking_level is None

    def test_model_only_uses_the_main_thinking_level(self, monkeypatch):
        c = _load_with_second(monkeypatch, "gemini-3.8-flash")
        assert c.ai.second_reader_model == "gemini-3.8-flash"
        assert c.ai.second_reader_thinking_level == "low"

    def test_thinking_level_is_part_of_the_value(self, monkeypatch):
        c = _load_with_second(monkeypatch, " gemini-3.8-flash @ HIGH ")
        assert c.ai.second_reader_model == "gemini-3.8-flash"
        assert c.ai.second_reader_thinking_level == "high"

    def test_at_none_means_no_thinking(self, monkeypatch):
        c = _load_with_second(monkeypatch, "gemini-3.8-flash@none")
        assert c.ai.second_reader_model == "gemini-3.8-flash"
        assert c.ai.second_reader_thinking_level is None

    def test_model_only_follows_ai_thinking_level_none(self, monkeypatch):
        for name in SECOND_READER_ENV:
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("AI_THINKING_LEVEL", "none")
        monkeypatch.setenv("AI_SECOND_READER", "gemini-3.8-flash")
        c = load_config()
        assert c.ai.second_reader_thinking_level is None

    @pytest.mark.parametrize(
        "raw",
        [
            "gemini-3.8-flash@",
            "gemini-3.8-flash@ ",
            "gemini-3.8-flash@max",
            "claude-haiku-test",
            "gpt-test",
            "gemini-bad!",
            " gemini-3.8-flash@low@high",
        ],
    )
    def test_invalid_values_raise(self, monkeypatch, raw):
        with pytest.raises(ValueError) as e:
            _load_with_second(monkeypatch, raw)
        assert "AI_SECOND_READER" in str(e.value)

    def test_non_gemini_message(self, monkeypatch):
        with pytest.raises(ValueError) as e:
            _load_with_second(monkeypatch, "claude-haiku-test")
        assert "AI_SECOND_READER の型名は gemini- で始めてください" in str(e.value)

    def test_same_model_as_ai_model_is_rejected(self, monkeypatch):
        for name in SECOND_READER_ENV:
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("AI_MODEL", "gemini-3.8-flash")
        monkeypatch.setenv("AI_SECOND_READER", "gemini-3.8-flash")
        with pytest.raises(ValueError) as e:
            load_config()
        assert "AI_SECOND_READER には AI_MODEL と別の型を書いてください" in str(e.value)

    def test_compare_does_not_read_the_value(self, monkeypatch):
        for name in SECOND_READER_ENV:
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("RUN_MODE", "compare")
        monkeypatch.setenv("AI_SECOND_READER", "claude-haiku-test")
        c = load_config()
        assert c.ai.second_reader_model is None
        assert c.ai.second_reader_thinking_level is None

    def test_text_first_still_parses_the_value(self, monkeypatch):
        for name in SECOND_READER_ENV:
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("AI_FLOW", "text_first")
        monkeypatch.setenv("AI_SECOND_READER", "gemini-3.8-flash")
        c = load_config()
        assert c.ai.flow == "text_first"
        assert c.ai.second_reader_model == "gemini-3.8-flash"


class TestAiSecondReaderSameModelNormalisation:
    @pytest.mark.parametrize(
        "ai_model",
        [
            "GEMINI-3.8-FLASH",
            "models/gemini-3.8-flash",
            " gemini-3.8-flash ",
            "models/GEMINI-3.8-FLASH",
        ],
    )
    def test_same_model_after_normalisation_is_rejected(self, monkeypatch, ai_model):
        for name in SECOND_READER_ENV:
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("AI_MODEL", ai_model)
        monkeypatch.setenv("AI_SECOND_READER", "gemini-3.8-flash")

        with pytest.raises(ValueError) as e:
            load_config()
        assert "AI_SECOND_READER には AI_MODEL と別の型を書いてください" in str(e.value)

    def test_the_configured_model_names_stay_as_written(self, monkeypatch):
        for name in SECOND_READER_ENV:
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("AI_MODEL", "models/Gemini-Main-01")
        monkeypatch.setenv("AI_SECOND_READER", " gemini-3.8-flash @ HIGH ")

        c = load_config()

        assert c.ai.model == "models/Gemini-Main-01"
        assert c.ai.second_reader_model == "gemini-3.8-flash"
        assert c.ai.second_reader_thinking_level == "high"

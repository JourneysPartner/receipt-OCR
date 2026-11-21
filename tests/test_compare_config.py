"""比較モードの設定（COMPARE_*）のテスト"""

import re
from datetime import UTC, datetime

import pytest

from src.compare.config import (
    DEFAULT_PRICES,
    CompareModel,
    load_compare_config,
)
from src.config import load_config

RESULT_ID = "R" * 24
FOLDER_ID = "F" * 12


def _env(**overrides) -> dict[str, str]:
    env = {
        "COMPARE_RESULT_SPREADSHEET_ID": RESULT_ID,
        "COMPARE_FOLDER_IDS": FOLDER_ID,
    }
    env.update({key: value for key, value in overrides.items() if value is not None})
    for key, value in overrides.items():
        if value is None:
            env.pop(key, None)
    return env


class TestDefaults:
    def test_collect_defaults(self):
        cfg = load_compare_config(_env())
        assert cfg.step == "collect"
        assert cfg.result_spreadsheet_id == RESULT_ID
        assert cfg.folder_ids == (FOLDER_ID,)
        assert [m.label for m in cfg.models] == [
            "gemini-2.5-flash",
            "gemini-3.5-flash-lite",
            "gemini-3.8-flash",
        ]
        assert cfg.models[0] == CompareModel("gemini-2.5-flash", "gemini-2.5-flash", None)
        assert cfg.methods == ("text", "image")
        assert cfg.max_files is None
        assert cfg.max_workers == 4
        assert cfg.time_budget_seconds == 3300
        assert cfg.prices == DEFAULT_PRICES
        assert cfg.temperature == 0.1
        assert cfg.thinking_level == "low"
        assert cfg.max_tokens == 2048
        assert cfg.request_timeout_seconds is None
        assert cfg.effective_request_timeout == 180

    def test_run_label_default_is_jst_minutes(self):
        now = datetime(2026, 11, 18, 22, 5, tzinfo=UTC)
        cfg = load_compare_config(_env(), now=now)
        # 日本時間 2026-11-19 07:05
        assert cfg.run_label == "20261119-0705"

    def test_score_label_can_be_omitted(self):
        env = _env(COMPARE_STEP="score", COMPARE_FOLDER_IDS=None)
        cfg = load_compare_config(env)
        assert cfg.step == "score"
        assert cfg.run_label is None
        assert cfg.folder_ids == ()

    def test_score_does_not_require_folders(self):
        env = _env(COMPARE_STEP="score", COMPARE_FOLDER_IDS=None)
        assert load_compare_config(env).folder_ids == ()

    def test_score_ignores_folder_value(self):
        env = _env(COMPARE_STEP="score", COMPARE_FOLDER_IDS="not-a-folder")
        assert load_compare_config(env).folder_ids == ()

    def test_cloud_run_execution_becomes_label(self):
        cfg = load_compare_config(
            _env(COMPARE_RUN_LABEL=None, CLOUD_RUN_EXECUTION="receipt-ocr-job-abc_123")
        )
        assert cfg.run_label == "receipt-ocr-job-abc_123"

    def test_cloud_run_execution_label_removes_chars_and_keeps_last_40(self):
        execution = "projects/1/executions/" + "a" * 30 + "/run 01#x_"
        cfg = load_compare_config(_env(COMPARE_RUN_LABEL=None, CLOUD_RUN_EXECUTION=execution))
        cleaned = "projects1executions" + "a" * 30 + "run01x_"
        assert cfg.run_label == cleaned[-40:]

    def test_cloud_run_execution_ignored_when_label_is_given(self):
        cfg = load_compare_config(
            _env(COMPARE_RUN_LABEL="L1", CLOUD_RUN_EXECUTION="receipt-ocr-job-abc")
        )
        assert cfg.run_label == "L1"

    def test_cloud_run_execution_is_not_used_for_score(self):
        cfg = load_compare_config(
            _env(
                COMPARE_STEP="score",
                COMPARE_FOLDER_IDS=None,
                COMPARE_RUN_LABEL=None,
                CLOUD_RUN_EXECUTION="receipt-ocr-job-abc",
            )
        )
        assert cfg.run_label is None


class TestParsing:
    def test_urls_are_extracted(self):
        env = {
            "COMPARE_RESULT_SPREADSHEET_ID": (
                "https://docs.google.com/spreadsheets/d/" + RESULT_ID + "/edit#gid=0"
            ),
            "COMPARE_FOLDER_IDS": (
                "https://drive.google.com/drive/folders/" + FOLDER_ID + "?usp=sharing"
            ),
        }
        cfg = load_compare_config(env)
        assert cfg.result_spreadsheet_id == RESULT_ID
        assert cfg.folder_ids == (FOLDER_ID,)

    def test_models_with_thinking_and_duplicates(self):
        cfg = load_compare_config(
            _env(COMPARE_MODELS="gemini-2.5-flash@low,gemini-2.5-flash@low,gemini-3.8-flash@high")
        )
        assert [m.label for m in cfg.models] == [
            "gemini-2.5-flash@low",
            "gemini-3.8-flash@high",
        ]
        assert cfg.models[0].name == "gemini-2.5-flash"
        assert cfg.models[0].thinking_level == "low"
        assert cfg.models[1].thinking_level == "high"

    def test_methods_canonical_order(self):
        cfg = load_compare_config(_env(COMPARE_METHODS="image,text"))
        assert cfg.methods == ("text", "image")
        cfg = load_compare_config(_env(COMPARE_METHODS="image"))
        assert cfg.methods == ("image",)

    def test_max_files_and_limits(self):
        cfg = load_compare_config(
            _env(COMPARE_MAX_FILES="3", COMPARE_MAX_WORKERS="8", COMPARE_TIME_BUDGET_SECONDS="60")
        )
        assert cfg.max_files == 3
        assert cfg.max_workers == 8
        assert cfg.time_budget_seconds == 60

    def test_prices_overlay(self):
        cfg = load_compare_config(
            _env(COMPARE_PRICES_JSON='{"gemini-test": [1.0, 2.0], "gemini-2.5-flash": [3, 4]}')
        )
        assert cfg.prices["gemini-test"] == (1.0, 2.0)
        assert cfg.prices["gemini-2.5-flash"] == (3.0, 4.0)
        assert cfg.prices["gemini-3.8-flash"] == (1.50, 7.50)

    def test_ai_settings(self):
        cfg = load_compare_config(
            _env(
                AI_TEMPERATURE="none",
                AI_THINKING_LEVEL="medium",
                AI_MAX_TOKENS="4096",
                AI_REQUEST_TIMEOUT_SECONDS="45",
            )
        )
        assert cfg.temperature is None
        assert cfg.thinking_level == "medium"
        assert cfg.max_tokens == 4096
        assert cfg.request_timeout_seconds == 45


class TestReaders:
    def test_defaults(self):
        cfg = load_compare_config(_env())
        assert cfg.readers == ()
        assert cfg.form_base == "gemini-2.5-flash"
        assert cfg.ocr_price_per_page_usd == 0.0015
        assert cfg.reader_max_tokens == 8192

    def test_default_prices_include_both_readers(self):
        assert DEFAULT_PRICES["claude-haiku-5-5"] == (0.10, 0.50)
        assert DEFAULT_PRICES["gpt-5.4-mini"] == (0.75, 4.50)

    def test_reader_vendors_and_thinking(self):
        cfg = load_compare_config(
            _env(
                COMPARE_READERS=(
                    "gemini-3.7-flash,claude-haiku-5-5@high,gpt-5.4-mini,claude-haiku-5-5@high"
                ),
                AI_THINKING_LEVEL="medium",
            )
        )
        assert [reader.label for reader in cfg.readers] == [
            "gemini-3.7-flash",
            "claude-haiku-5-5@high",
            "gpt-5.4-mini",
        ]
        assert [reader.vendor for reader in cfg.readers] == [
            "gemini",
            "anthropic",
            "openai",
        ]
        assert cfg.readers[0].thinking_level == "medium"  # Gemini は AI_THINKING_LEVEL
        assert cfg.readers[1].thinking_level == "high"
        assert cfg.readers[2].thinking_level is None  # @ が無ければ送らない

    def test_form_base_and_costs(self):
        cfg = load_compare_config(
            _env(
                COMPARE_FORM_BASE="gemini-3.5-flash-lite@low",
                COMPARE_OCR_PRICE_PER_PAGE_USD="0.002",
                COMPARE_READER_MAX_TOKENS="1024",
            )
        )
        assert cfg.form_base == "gemini-3.5-flash-lite@low"
        assert cfg.ocr_price_per_page_usd == 0.002
        assert cfg.reader_max_tokens == 1024

    def test_score_without_models_leaves_form_base_to_the_result_tab(self):
        cfg = load_compare_config(
            _env(COMPARE_STEP="score", COMPARE_FOLDER_IDS=None, COMPARE_MODELS=None)
        )
        assert cfg.form_base is None

    def test_readers_accept_uppercase_thinking_and_keep_the_label(self):
        cfg = load_compare_config(_env(COMPARE_READERS="claude-haiku-5-5@HIGH,gpt-5.4-mini@Low"))
        assert [reader.label for reader in cfg.readers] == [
            "claude-haiku-5-5@HIGH",
            "gpt-5.4-mini@Low",
        ]
        assert [reader.thinking_level for reader in cfg.readers] == ["high", "low"]

    def test_score_does_not_reject_the_same_element_in_both_variables(self):
        # score は読み手を呼ばない。COMPARE_MODELS を省くと既定の型と当たる（§14.4）
        env = _env(
            COMPARE_STEP="score",
            COMPARE_FOLDER_IDS=None,
            COMPARE_MODELS=None,
            COMPARE_READERS="gemini-2.5-flash",
        )
        cfg = load_compare_config(env)
        assert [reader.label for reader in cfg.readers] == ["gemini-2.5-flash"]

    def test_score_does_not_use_the_form_base_from_a_skipped_overlap(self):
        env = _env(
            COMPARE_STEP="score",
            COMPARE_FOLDER_IDS=None,
            COMPARE_MODELS="gemini-test",
            COMPARE_READERS="gemini-test",
        )
        cfg = load_compare_config(env)
        assert cfg.form_base == "gemini-test"
        assert [reader.label for reader in cfg.readers] == ["gemini-test"]

    def test_score_with_models_uses_the_first(self):
        cfg = load_compare_config(
            _env(
                COMPARE_STEP="score",
                COMPARE_FOLDER_IDS=None,
                COMPARE_MODELS="gemini-test@low",
            )
        )
        assert cfg.form_base == "gemini-test@low"

    @pytest.mark.parametrize("value", ["nan", "NaN", "inf", "-inf", "Infinity"])
    def test_ocr_price_rejects_nan_and_inf(self, value):
        with pytest.raises(ValueError, match="COMPARE_OCR_PRICE_PER_PAGE_USD"):
            load_compare_config(_env(COMPARE_OCR_PRICE_PER_PAGE_USD=value))

    @pytest.mark.parametrize(
        "overrides, message",
        [
            (
                {"COMPARE_READERS": "mystery-model"},
                "COMPARE_READERS の型名は gemini- / claude- / gpt- で始めてください",
            ),
            (
                {"COMPARE_READERS": "mystery-model@low"},
                "COMPARE_READERS の型名は gemini- / claude- / gpt- で始めてください",
            ),
            (
                {"COMPARE_MODELS": "claude-haiku-5-5"},
                "COMPARE_MODELS には Gemini の型だけを書けます",
            ),
            (
                {"COMPARE_MODELS": "gpt-5.4-mini"},
                "COMPARE_MODELS には Gemini の型だけを書けます",
            ),
            (
                {"COMPARE_READERS": "claude-haiku-5-5", "COMPARE_MODELS": "claude-haiku-5-5"},
                "COMPARE_MODELS には Gemini の型だけを書けます",
            ),
            (
                {
                    "COMPARE_MODELS": "gemini-test",
                    "COMPARE_READERS": "gemini-test",
                },
                "同じ要素",
            ),
            (
                {"COMPARE_READERS": "claude-haiku-5-5@minimal"},
                "minimal",
            ),
            (
                {"COMPARE_OCR_PRICE_PER_PAGE_USD": "-1"},
                "COMPARE_OCR_PRICE_PER_PAGE_USD",
            ),
            (
                {"COMPARE_OCR_PRICE_PER_PAGE_USD": "x"},
                "COMPARE_OCR_PRICE_PER_PAGE_USD",
            ),
            (
                {"COMPARE_READER_MAX_TOKENS": "255"},
                "COMPARE_READER_MAX_TOKENS",
            ),
            (
                {"COMPARE_FORM_BASE": "  "},
                None,
            ),
        ],
    )
    def test_invalid_values(self, overrides, message):
        if message is None:
            # 空の COMPARE_FORM_BASE は既定（最初の型）にする
            cfg = load_compare_config(_env(**overrides))
            assert cfg.form_base == "gemini-2.5-flash"
            return
        with pytest.raises(ValueError, match=re.escape(message)):
            load_compare_config(_env(**overrides))


class TestErrors:
    @pytest.mark.parametrize(
        "overrides, message",
        [
            ({"COMPARE_STEP": "run"}, "COMPARE_STEP"),
            ({"COMPARE_RESULT_SPREADSHEET_ID": "short"}, "COMPARE_RESULT_SPREADSHEET_ID"),
            ({"COMPARE_RESULT_SPREADSHEET_ID": None}, "COMPARE_RESULT_SPREADSHEET_ID"),
            ({"COMPARE_FOLDER_IDS": "short"}, "COMPARE_FOLDER_IDS"),
            ({"COMPARE_FOLDER_IDS": None}, "COMPARE_FOLDER_IDS"),
            ({"COMPARE_MODELS": "Gemini-2.5"}, "COMPARE_MODELS"),
            ({"COMPARE_MODELS": "gemini-2.5-flash@max"}, "考える量"),
            ({"COMPARE_MODELS": "gemini-2.5-flash@"}, "考える量"),
            ({"COMPARE_METHODS": "ocr"}, "COMPARE_METHODS"),
            ({"COMPARE_RUN_LABEL": "は いけない"}, "COMPARE_RUN_LABEL"),
            ({"COMPARE_MAX_FILES": "0"}, "COMPARE_MAX_FILES"),
            ({"COMPARE_MAX_FILES": "x"}, "COMPARE_MAX_FILES"),
            ({"COMPARE_MAX_WORKERS": "0"}, "COMPARE_MAX_WORKERS"),
            ({"COMPARE_MAX_WORKERS": "9"}, "COMPARE_MAX_WORKERS"),
            ({"COMPARE_TIME_BUDGET_SECONDS": "59"}, "COMPARE_TIME_BUDGET_SECONDS"),
            ({"COMPARE_PRICES_JSON": "not json"}, "COMPARE_PRICES_JSON"),
            ({"COMPARE_PRICES_JSON": "[1, 2]"}, "COMPARE_PRICES_JSON"),
            ({"COMPARE_PRICES_JSON": '{"x": [1]}'}, "COMPARE_PRICES_JSON"),
            ({"AI_TEMPERATURE": "warm"}, "AI_TEMPERATURE"),
            ({"AI_THINKING_LEVEL": "max"}, "AI_THINKING_LEVEL"),
            ({"AI_REQUEST_TIMEOUT_SECONDS": "0"}, "AI_REQUEST_TIMEOUT_SECONDS"),
            ({"AI_MAX_TOKENS": "0"}, "AI_MAX_TOKENS"),
        ],
    )
    def test_invalid_values(self, overrides, message):
        with pytest.raises(ValueError, match=re.escape(message)):
            load_compare_config(_env(**overrides))


class TestRunModeCompare:
    def test_run_mode_compare_is_accepted(self, monkeypatch):
        monkeypatch.setenv("RUN_MODE", "compare")
        monkeypatch.setenv("TARGET_SCOPE", "selected")
        monkeypatch.setenv("TARGET_ROW", "999")
        config = load_config()
        assert config.runtime.is_compare
        # 比較では TARGET_* を無視する
        assert config.runtime.target_scope == "all"
        assert config.runtime.target_row is None

    def test_invalid_run_mode_message_lists_compare(self, monkeypatch):
        monkeypatch.setenv("RUN_MODE", "preview")
        with pytest.raises(ValueError) as error:
            load_config()
        assert "'prod' / 'validate' / 'compare'" in str(error.value)

    def test_ai_defaults_keep_prod_unchanged(self, monkeypatch):
        for name in (
            "AI_TEMPERATURE",
            "AI_THINKING_LEVEL",
            "AI_REQUEST_TIMEOUT_SECONDS",
        ):
            monkeypatch.delenv(name, raising=False)
        config = load_config()
        assert config.ai.temperature == 0.1
        assert config.ai.thinking_level == "low"
        assert config.ai.request_timeout_seconds is None

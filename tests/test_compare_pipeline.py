"""現行の流れの組み立てとやり直し（仕様 §8・§5.5）のテスト"""

from src.compare.pipeline import (
    AttemptOutcome,
    build_current_flow_row,
    extract_with_retries,
    is_retryable,
    make_result_row,
    settings_text,
)
from src.config import AiConfig
from src.models import DriveFile, ReceiptItem

FILE = DriveFile(
    file_id="FILE_A1234567890",
    file_name="テスト商店_レシート.jpg",
    mime_type="image/jpeg",
    folder_id="FOLDER_A1234567890",
    content=b"fake",
)
OCR_TEXT = "テスト商店 合計 1,600円"


def _info(input_tokens=10, output_tokens=2, thinking=0, latency=100):
    return {
        "model": "gemini-test",
        "latency_ms": latency,
        "finish_reason": "STOP",
        "prompt_tokens": input_tokens,
        "output_tokens": output_tokens,
        "thinking_tokens": thinking,
        "raw_text": "[]",
        "error": None,
    }


def _row(method, items, *, error=None, info=None, tokens=10):
    outcome = AttemptOutcome(
        items=list(items),
        error=error,
        info=info if info is not None else _info(input_tokens=tokens),
    )
    return make_result_row(
        run_label="L1",
        recorded_at="2026-11-18 12:00:00",
        file=FILE,
        folder_name="テスト用フォルダ",
        model_label="gemini-test@low",
        model_name="gemini-test",
        method=method,
        outcome=outcome,
        retries=0,
        settings="temperature=0.1, thinking=low, max_tokens=2048",
        ocr_text=OCR_TEXT,
    )


def _item(amount=1600, date="2026-01-02", vendor="テスト商店", tax="課税仕入10%"):
    return ReceiptItem(
        date=date,
        amount=amount,
        vendor=vendor,
        description="テスト品",
        account="消耗品費",
        tax_category=tax,
        confidence=0.9,
    )


def _current(text_items, image_items, ai_config=None):
    return build_current_flow_row(
        run_label="L1",
        recorded_at="2026-11-18 12:00:00",
        file=FILE,
        folder_name="テスト用フォルダ",
        model_label="gemini-test@low",
        model_name="gemini-test",
        text_row=_row("text", text_items),
        image_row=_row("image", image_items, tokens=20),
        ocr_text=OCR_TEXT,
        ai_config=ai_config or AiConfig(),
        settings="temperature=0.1, thinking=low, max_tokens=2048",
    )


class TestCurrentFlow:
    def test_text_ok_is_auto(self):
        row = _current([_item()], [])
        assert row.result == "自動"
        assert row.amount == 1600
        assert row.date == "2026-01-02"
        assert "文字:ok" in row.amount_validation

    def test_text_empty_uses_image(self):
        row = _current([], [_item()])
        assert row.result == "自動"
        assert "画像:ok" in row.amount_validation

    def test_amount_ng_replaced_by_image(self):
        row = _current([_item(amount=41600)], [_item(amount=1600)])
        assert row.result == "自動"
        assert row.amount == 1600
        assert "文字:digit_inflation→画像:ok" in row.amount_validation
        # 画像を呼んだ分だけトークンを足す
        assert row.input_tokens == 30

    def test_both_ng_is_manual(self):
        row = _current([_item(amount=41600)], [_item(amount=41601)])
        assert row.result == "要手入力"
        assert row.amount is None

    def test_mapping_impossible_is_manual(self):
        text_items = [_item(amount=41600), _item(amount=9999)]
        row = _current(text_items, [_item(amount=1600)])
        assert row.result == "要手入力"
        assert "対応なし" in row.amount_validation

    def test_partial_is_manual_only_for_ng_item(self):
        row = _current([_item(amount=1600), _item(amount=41600)], [])
        assert row.result == "一部要手入力"
        assert row.count == 2

    def test_extraction_retry_disabled(self):
        row = _current([], [_item()], AiConfig(enable_extraction_retry=False))
        assert row.result == "要手入力"
        assert row.input_tokens == 10  # 画像は呼ばれない

    def test_image_tokens_only_when_called(self):
        row = _current([_item()], [_item(amount=9999)])
        assert row.input_tokens == 10
        row = _current([_item(amount=41600)], [_item(amount=1600)])
        assert row.input_tokens == 30

    def test_rule_corrector_is_applied(self):
        item = _item()
        item.description = "ガソリン給油"
        item.account = "雑費"
        row = _current([item], [])
        assert row.accounts == "車両費"

    def test_text_empty_retry_disabled_has_no_image(self):
        row = _current([], [_item()], AiConfig(enable_extraction_retry=False))
        assert "文字:なし" in row.amount_validation
        assert "画像" not in row.amount_validation

    def test_ocr_failed_is_manual_with_zero_cost(self):
        row = build_current_flow_row(
            run_label="L1",
            recorded_at="2026-11-18 12:00:00",
            file=FILE,
            folder_name="テスト用フォルダ",
            model_label="gemini-test@low",
            model_name="gemini-test",
            text_row=_row("text", []),
            image_row=_row("image", [_item()], tokens=20),
            ocr_text="",
            ai_config=AiConfig(),
            settings="temperature=0.1, thinking=low, max_tokens=2048",
            ocr_failed=True,
        )
        # 本番は OCR 失敗なら AI を呼ばない（§8）
        assert row.result == "要手入力"
        assert row.amount_validation == "OCR失敗"
        assert row.latency_ms == 0
        assert row.input_tokens == 0
        assert row.output_tokens == 0
        assert row.thinking_tokens == 0


def _outcome(error, detail=None):
    return AttemptOutcome(
        items=[],
        error=error,
        info={"error": detail} if detail is not None else None,
    )


class TestExtractionRetries:
    def test_429_twice_then_success(self):
        outcomes = [
            _outcome("api_error", "429 RESOURCE_EXHAUSTED"),
            _outcome("api_error", "503 UNAVAILABLE"),
            AttemptOutcome(items=[_item()], error=None, info=_info()),
        ]
        calls = []
        sleeps = []

        def call():
            calls.append(1)
            return outcomes[len(calls) - 1]

        result, retries = extract_with_retries(call, sleeps=(10, 30, 60), sleep=sleeps.append)
        assert result.items
        assert retries == 2
        assert sleeps == [10, 30]
        assert len(calls) == 3

    def test_four_429_stops_with_three_retries(self):
        sleeps = []
        result, retries = extract_with_retries(
            lambda: _outcome("api_error", "504 DEADLINE_EXCEEDED"),
            sleeps=(10, 30, 60),
            sleep=sleeps.append,
        )
        assert result.error == "api_error"
        assert retries == 3
        assert sleeps == [10, 30, 60]

    def test_400_is_not_retried(self):
        sleeps = []
        result, retries = extract_with_retries(
            lambda: _outcome("api_error", "400 INVALID_ARGUMENT"),
            sleeps=(10, 30, 60),
            sleep=sleeps.append,
        )
        assert result.error == "api_error"
        assert retries == 0
        assert sleeps == []

    def test_timeout_word_is_retryable(self):
        sleeps = []
        extract_with_retries(
            lambda: _outcome("api_error", "request timed out"),
            sleeps=(0,),
            sleep=sleeps.append,
        )
        assert sleeps == [0]

    def test_non_api_error_is_not_retried(self):
        sleeps = []
        _, retries = extract_with_retries(
            lambda: _outcome("zero_items"),
            sleeps=(10,),
            sleep=sleeps.append,
        )
        assert retries == 0
        assert sleeps == []

    def _coded(self, code, detail="500 INTERNAL"):
        return AttemptOutcome(
            items=[],
            error="api_error",
            info={"error": detail, "error_code": code},
        )

    def test_integer_code_400_is_not_retried_even_if_text_has_500(self):
        sleeps = []
        _, retries = extract_with_retries(
            lambda: self._coded(400, "400 INVALID_ARGUMENT: 500"),
            sleeps=(10,),
            sleep=sleeps.append,
        )
        assert retries == 0
        assert sleeps == []

    def test_integer_code_503_is_retried(self):
        sleeps = []
        _, retries = extract_with_retries(
            lambda: self._coded(503, "503 UNAVAILABLE"),
            sleeps=(0,),
            sleep=sleeps.append,
        )
        assert retries == 1
        assert sleeps == [0]

    def test_should_stop_prevents_retry_wait(self):
        sleeps = []
        result, retries = extract_with_retries(
            lambda: _outcome("api_error", "503 UNAVAILABLE"),
            sleeps=(10,),
            sleep=sleeps.append,
            should_stop=lambda: True,
        )
        assert result.error == "api_error"
        assert retries == 0
        assert sleeps == []


def test_empty_response_is_not_api_error():
    outcome = AttemptOutcome(
        items=[],
        error="api_error",
        info={
            "finish_reason": "MAX_TOKENS",
            "error": None,
            "raw_text": None,
            "error_code": None,
        },
    )
    row = make_result_row(
        run_label="L1",
        recorded_at="2026-11-18 12:00:00",
        file=FILE,
        folder_name="テスト用フォルダ",
        model_label="gemini-test",
        model_name="gemini-test",
        method="text",
        outcome=outcome,
        retries=0,
        settings="temperature=0.1, thinking=なし, max_tokens=2048",
        ocr_text=OCR_TEXT,
    )
    assert row.result == "失敗:empty_response"
    assert row.finish_reason == "MAX_TOKENS"
    assert is_retryable(outcome) is False


def test_non_object_json_text_stays_api_error():
    # 配列だが中身がオブジェクトでない応答（例 ["a"]）は、本文が空ではないので api_error
    row = _row(
        "text",
        [],
        error="api_error",
        info={
            "finish_reason": "STOP",
            "error": None,
            "raw_text": '["a"]',
            "error_code": None,
        },
    )
    assert row.result == "失敗:api_error"
    assert row.raw_text == '["a"]'


def test_settings_text():
    assert settings_text(0.1, None, 2048) == "temperature=0.1, thinking=なし, max_tokens=2048"
    assert settings_text(None, "high", 4096) == "temperature=none, thinking=high, max_tokens=4096"

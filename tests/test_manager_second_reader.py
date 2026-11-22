"""両読み + もう 1 人の読み手（形 B・仕様 spec_second_reader §4〜§6）のテスト。

API も Drive も Sheets もすべて偽物。テストの日付・金額・店名は架空のもの。
"""

import sys
from unittest.mock import MagicMock
from unittest.mock import call as mock_call

import pytest

import src.main as main_module
import src.processing.manager as manager_module
from src.ai.gemini import GeminiExtractor
from src.config import (
    AiConfig,
    AppConfig,
    DriveConfig,
    MasterConfig,
    OcrConfig,
    SheetsConfig,
    TemplateConfig,
)
from src.models import (
    AiLogRecord,
    CorrectedItem,
    CustomerRow,
    DriveFile,
    OcrResult,
    ProcessRecord,
    ProcessStatus,
    ReceiptDetails,
    ReceiptItem,
)
from src.processing.duplicates import SAME_FILE_DUPLICATE_NOTE, ReceiptSource
from src.processing.manager import ProcessingManager

OCR_TEXT = "合計 ¥1,200"
SECOND_MODEL = "gemini-3.8-flash"
FAKE_KEY = "fake-gemini-key-AAA"
TODAY = "2025-04-02"
NOW = "2025-04-02T10:00"


def _make_manager(
    *,
    flow: str = "dual",
    dry_run: bool = False,
    with_second: bool = True,
    second_items=None,
    second_error=None,
    second_side_effect=None,
    second_model: str | None = SECOND_MODEL,
) -> tuple[ProcessingManager, dict[str, MagicMock], MagicMock | None]:
    config = AppConfig(
        master=MasterConfig(spreadsheet_id="m"),
        template=TemplateConfig(),
        drive=DriveConfig(),
        sheets=SheetsConfig(),
        ocr=OcrConfig(),
        ai=AiConfig(
            flow=flow,
            second_reader_model=second_model if with_second else None,
            second_reader_thinking_level="low" if with_second else None,
        ),
        gemini_api_key=FAKE_KEY,
        dry_run=dry_run,
    )
    mocks = {
        "drive": MagicMock(),
        "master": MagicMock(),
        "ocr": MagicMock(),
        "ai": MagicMock(),
        "corrector": MagicMock(),
    }
    mocks["drive"].download_file.side_effect = lambda f: f
    mocks["ai"].last_extraction_error = None
    mocks["ocr"].extract_text.return_value = OcrResult(
        raw_text=OCR_TEXT, engine="vision", confidence=0.9
    )
    mocks["corrector"].apply.side_effect = lambda it: CorrectedItem(
        original=it,
        date=it.date,
        amount=it.amount,
        time=it.time,
        receipt_no=it.receipt_no,
        vendor=it.vendor,
        description=it.description,
        account=it.account,
        tax_category=it.tax_category,
        confidence=it.confidence,
        is_expense=it.is_expense,
        memo=it.memo,
        needs_review=False,
    )

    second = None
    if with_second:
        second = MagicMock()
        second.last_extraction_error = second_error
        if second_side_effect is not None:
            second.extract_from_file.side_effect = second_side_effect
        else:
            second.extract_from_file.return_value = list(second_items or [])

    manager = ProcessingManager(
        config=config,
        drive=mocks["drive"],
        master=mocks["master"],
        ocr=mocks["ocr"],
        ai=mocks["ai"],
        corrector=mocks["corrector"],
        second_ai=second,
    )
    return manager, mocks, second


def _file(mime_type: str = "image/jpeg") -> DriveFile:
    return DriveFile(
        file_id="fid-1",
        file_name="receipt-1.jpg",
        mime_type=mime_type,
        folder_id="folder-1",
    )


def _cb_mock() -> MagicMock:
    cb = MagicMock()
    cb.reserve_rows.side_effect = lambda **kwargs: [
        (100 + i, f"rid-{i}") for i in range(kwargs["count"])
    ]
    return cb


def _item(
    date: str,
    amount: int,
    *,
    vendor: str = "テスト店",
    description: str = "テスト摘要",
    account: str = "雑費",
    tax_category: str = "課税仕入10%",
    time: str | None = None,
    receipt_no: str | None = None,
) -> ReceiptItem:
    return ReceiptItem(
        date=date,
        amount=amount,
        time=time,
        receipt_no=receipt_no,
        vendor=vendor,
        description=description,
        account=account,
        tax_category=tax_category,
        confidence=0.9,
    )


def _run(m, cb, *, processed_keys=None, known=None):
    return m._process_file(
        _file(),
        cb,
        processed_keys or set(),
        TODAY,
        NOW,
        known_receipts=known,
    )


def _row_calls(cb) -> dict[int, list]:
    rows: dict[int, list] = {}
    for call in cb.write_cashbook_row.call_args_list:
        rows.setdefault(call.args[0] - 100, []).append(call)
    return rows


def _manual_calls(cb) -> dict[int, list]:
    rows: dict[int, list] = {}
    for call in cb.write_manual_entry_row.call_args_list:
        rows.setdefault(call.args[0] - 100, []).append(call)
    return rows


def _ai_logs(cb) -> dict[int, object]:
    return {call.args[0].receipt_index: call.args[0] for call in cb.append_ai_log.call_args_list}


A = ("2025-04-02", 1200)
B = ("2025-04-03", 900)


class TestSecondReaderCall:
    def test_matched_by_second_is_booked_like_any_item(self):
        m, mocks, second = _make_manager(
            second_items=[
                _item(*A, vendor="別店A", account="消耗品費"),
                _item(*B, vendor="別店B", account="通信費"),
            ]
        )
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*B)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        result = _run(m, cb)

        assert result.success == 2
        assert result.manual_entry == 0
        assert result.errors == 0
        second.extract_from_file.assert_called_once()
        mocks["ai"].extract_from_file.assert_called_once()
        mocks["ai"].extract_receipt_data.assert_called_once()
        cb.reserve_rows.assert_called_once()
        assert cb.reserve_rows.call_args.kwargs["receipt_indices"] == [0, 1]
        cb.write_manual_entry_row.assert_not_called()
        mocks["drive"].rename_file_as_done.assert_called_once()

        rows = _row_calls(cb)
        assert set(rows) == {0, 1}
        # N3: 表に書く値は主の画像からの読み（もう 1 人の店名・科目は使わない）
        assert rows[1][0].args[1].vendor == "テスト店"
        assert rows[1][0].args[1].account == "雑費"
        assert cb.reserve_rows.call_args.kwargs["details"][1].vendor == "テスト店"
        assert cb.reserve_rows.call_args.kwargs["details"][1].time == ""

        logs = _ai_logs(cb)
        assert "両読み=一致 | " in logs[0].memo
        assert "もう1人: " not in logs[0].memo
        assert "両読み=一致（もう1人: gemini-3.8-flash） | " in logs[1].memo
        assert "もう1人=2025-04-02/1200, 2025-04-03/900" in logs[1].memo

    def test_second_reader_gets_only_the_real_ocr_text(self):
        # N4: 41600 は Vision の 1,600 と桁が合わない。もう 1 人が同じ 41600 でも
        # 本物の OCR の文字で照らすので自動にならない。
        m, mocks, second = _make_manager(second_items=[_item("2031-06-17", 41600)])
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item("2031-06-17", 41600)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2031-06-17", 41600)]

        result = _run(m, cb)

        assert second.extract_from_file.call_count == 1
        assert result.success == 0
        assert result.manual_entry == 1
        cb.write_cashbook_row.assert_not_called()
        message = cb.write_manual_entry_row.call_args.args[3]
        assert "先頭の桁の読み違いの疑い" in message
        assert cb.write_manual_entry_row.call_args.kwargs["short_label"] == "※金額要確認"

    def test_called_once_even_with_many_unmatched_items(self):
        m, mocks, second = _make_manager(
            second_items=[_item(*A), _item(*B), _item("2025-04-04", 500)]
        )
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [
            _item(*A),
            _item(*B),
            _item("2025-04-04", 500),
        ]
        mocks["ai"].extract_receipt_data.return_value = []

        _run(m, cb)

        second.extract_from_file.assert_called_once()
        mocks["ai"].extract_from_file.assert_called_once()
        mocks["ai"].extract_receipt_data.assert_called_once()


class TestSecondReaderNotCalled:
    def test_without_a_second_reader(self):
        m, mocks, _ = _make_manager(with_second=False)
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(A[0], 1500)]

        result = _run(m, cb)

        assert result.manual_entry == 1
        message = cb.write_manual_entry_row.call_args.args[3]
        assert "もう1人" not in message
        assert cb.append_ai_log.call_args[0][0].memo.count("もう1人") == 0

    def test_empty_image_reading(self):
        m, mocks, second = _make_manager(second_items=[_item(*A), _item(*B)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = []
        mocks["ai"].extract_receipt_data.return_value = [_item(*A), _item(*B)]

        result = _run(m, cb)

        second.extract_from_file.assert_not_called()
        assert result.manual_entry == 2
        cb.write_cashbook_row.assert_not_called()

    def test_ocr_failed(self):
        m, mocks, second = _make_manager(second_items=[_item(*A)])
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="", engine="vision", confidence=0.0, error="ocr error"
        )
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        result = _run(m, cb)

        second.extract_from_file.assert_not_called()
        assert result.manual_entry == 1
        assert cb.write_manual_entry_row.call_args.kwargs["short_label"] == "※読み取り要確認"

    def test_ocr_text_empty(self):
        m, mocks, second = _make_manager(second_items=[_item(*A)])
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="   ", engine="vision", confidence=0.9
        )
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        result = _run(m, cb)

        second.extract_from_file.assert_not_called()
        assert result.manual_entry == 1

    def test_every_item_matched(self):
        m, mocks, second = _make_manager(second_items=[_item(*A)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        result = _run(m, cb)

        second.extract_from_file.assert_not_called()
        assert result.success == 1

    def test_numbered_marks(self):
        m, mocks, second = _make_manager(second_items=[_item(*A), _item(*B)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*B)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        result = _run(m, cb, processed_keys={"fid-1:0"})

        second.extract_from_file.assert_not_called()
        assert result.skipped == 1
        assert result.success == 0
        assert result.manual_entry == 1
        assert cb.write_manual_entry_row.call_args.kwargs["short_label"] == "※再読取要確認"


class TestSecondReaderFailures:
    @pytest.mark.parametrize(
        ("items", "error", "expected"),
        [
            ([], "zero_items", "読めなかった（zero_items）"),
            ([], "parse_error", "読めなかった（parse_error）"),
            ([], None, "読めなかった（zero_items）"),
        ],
    )
    def test_empty_or_failed_reading_keeps_today_review(self, items, error, expected):
        m, mocks, second = _make_manager(second_items=items, second_error=error)
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(A[0], 1500)]

        result = _run(m, cb)

        second.extract_from_file.assert_called_once()
        assert result.manual_entry == 1
        assert result.success == 0
        assert result.errors == 0
        cb.write_cashbook_row.assert_not_called()
        message = cb.write_manual_entry_row.call_args.args[3]
        assert f"もう1人: {expected}" in message
        assert "画像=2025-04-02/1200 ｜ 文字=2025-04-02/1500" in message
        assert "もう1人=" in message
        assert cb.write_manual_entry_row.call_args.kwargs["short_label"] == "※金額要確認"

    def test_exception_keeps_today_review_and_the_job_continues(self):
        m, mocks, second = _make_manager(second_side_effect=RuntimeError("boom"))
        second.last_extraction_error = "api_error"
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(A[0], 1500)]

        result = _run(m, cb)

        second.extract_from_file.assert_called_once()
        assert result.manual_entry == 1
        assert result.errors == 0
        message = cb.write_manual_entry_row.call_args.args[3]
        assert "もう1人: 読めなかった（api_error）" in message
        assert "もう1人=なし" in message
        assert "boom" not in message

    def test_more_items_than_the_image_is_not_automatic(self):
        m, mocks, _ = _make_manager(second_items=[_item(*A), _item("2025-04-04", 500)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(A[0], 1500)]

        result = _run(m, cb)

        assert result.manual_entry == 1
        assert result.success == 0
        message = cb.write_manual_entry_row.call_args.args[3]
        assert "もう1人: もう1人は 2 件、画像からは 1 件" in message
        assert cb.write_manual_entry_row.call_args.kwargs["short_label"] == "※金額要確認"

    def test_same_amount_with_a_different_date_is_review(self):
        m, mocks, _ = _make_manager(second_items=[_item("2025-04-03", 1200)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(A[0], 1500)]

        result = _run(m, cb)

        assert result.manual_entry == 1
        message = cb.write_manual_entry_row.call_args.args[3]
        assert "もう1人: 日付が食い違う" in message
        # K 列の短いラベルは D0 のラベルのまま（§6）
        assert cb.write_manual_entry_row.call_args.kwargs["short_label"] == "※金額要確認"


class TestD0MatchesAreKept:
    def test_second_disagreement_does_not_drop_a_d0_match(self):
        m, mocks, _ = _make_manager(second_items=[_item("2025-04-04", 500)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*B)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        result = _run(m, cb)

        assert result.success == 1
        assert result.manual_entry == 1
        rows = _row_calls(cb)
        assert set(rows) == {0}
        assert rows[0][0].args[1].amount == 1200

    def test_second_with_more_items_does_not_drop_a_d0_match(self):
        m, mocks, _ = _make_manager(second_items=[_item(*A), _item(*B), _item("2025-04-04", 500)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*B)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        result = _run(m, cb)

        assert result.success == 1
        assert result.manual_entry == 1
        assert set(_row_calls(cb)) == {0}

    def test_second_exception_does_not_drop_a_d0_match(self):
        m, mocks, _ = _make_manager(second_side_effect=RuntimeError("boom"))
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*B)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        result = _run(m, cb)

        assert result.success == 1
        assert result.manual_entry == 1
        assert set(_row_calls(cb)) == {0}


class TestSecondReaderRows:
    def test_text_read_one_more_but_second_matches_the_image(self):
        m, mocks, _ = _make_manager(second_items=[_item(*A)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A), _item(*B)]

        result = _run(m, cb)

        assert result.success == 1
        assert result.manual_entry == 0
        cb.write_manual_entry_row.assert_not_called()
        mocks["drive"].rename_file_as_done.assert_called_once()
        logs = _ai_logs(cb)
        assert "両読み=一致（もう1人: gemini-3.8-flash）" in logs[0].memo

    def test_all_automatic_including_second_marks_the_file_done(self):
        m, mocks, _ = _make_manager(second_items=[_item(*A), _item(*B)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*B)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        result = _run(m, cb)

        assert result.success == 2
        assert result.manual_entry == 0
        mocks["drive"].rename_file_as_done.assert_called_once()

    def test_one_review_left_prevents_done(self):
        m, mocks, _ = _make_manager(second_items=[_item(*A)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*B)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        result = _run(m, cb)

        assert result.success == 1
        assert result.manual_entry == 1
        mocks["drive"].rename_file_as_done.assert_not_called()

    def test_same_file_duplicate_note_still_follows(self):
        m, mocks, _ = _make_manager(second_items=[_item(*A), _item(*A)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(A[0], 1500)]

        result = _run(m, cb)

        assert result.success == 2
        calls = _row_calls(cb)
        assert calls[0][0].kwargs["error_detail"] is None
        assert calls[1][0].kwargs["error_detail"] == SAME_FILE_DUPLICATE_NOTE

    def test_review_row_keeps_the_duplicate_note_at_the_end(self):
        m, mocks, _ = _make_manager(second_items=[_item("2025-04-04", 500)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(A[0], 1500)]

        result = _run(m, cb)

        assert result.manual_entry == 2
        messages = [call.args[3] for call in cb.write_manual_entry_row.call_args_list]
        assert messages[1].endswith(f"／{SAME_FILE_DUPLICATE_NOTE}")

    def test_second_matched_cross_file_duplicate_is_recorded_not_booked(self):
        known = ReceiptSource(
            file_id="fid-old",
            file_name="old.jpg",
            index=0,
            date=A[0],
            amount=A[1],
            vendor="テスト店",
        )
        m, mocks, _ = _make_manager(second_items=[_item(*A)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(A[0], 1500)]

        result = _run(m, cb, known=[known])

        assert result.skipped == 1
        assert result.success == 0
        cb.write_cashbook_row.assert_not_called()
        cb.append_process_record.assert_called_once()
        record = cb.append_process_record.call_args.args[0]
        assert record.status == "duplicate"
        assert record.duplicate_of == "fid-old:0"
        mocks["drive"].rename_file_as_duplicate.assert_called_once()


class TestSecondReaderDryRun:
    def test_dry_run_counts_second_matches_and_writes_nothing(self):
        m, mocks, second = _make_manager(dry_run=True, second_items=[_item(*A), _item(*B)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*B)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        result = _run(m, cb)

        second.extract_from_file.assert_called_once()
        assert result.success == 2
        assert result.manual_entry == 0
        cb.reserve_rows.assert_not_called()
        cb.write_cashbook_row.assert_not_called()
        cb.write_manual_entry_row.assert_not_called()
        cb.append_ai_log.assert_not_called()


class TestSecondReaderLogs:
    def test_per_file_log_has_no_key(self, monkeypatch):
        fake_logger = MagicMock()
        monkeypatch.setattr(manager_module, "logger", fake_logger)
        m, mocks, _ = _make_manager(second_items=[_item(*A), _item(*B)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*B)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        _run(m, cb)

        calls = [
            call
            for call in fake_logger.info.call_args_list
            if call.kwargs.get("extra", {}).get("step") == "second_reader"
        ]
        assert len(calls) == 1
        message = calls[0].args[0]
        assert "receipt-1.jpg" in message
        assert SECOND_MODEL in message
        assert "明細=2" in message
        assert "もう1人で一致=1" in message
        assert FAKE_KEY not in message
        assert FAKE_KEY not in str(cb.write_cashbook_row.call_args_list)
        assert FAKE_KEY not in str(cb.append_ai_log.call_args_list)

    def test_validate_log_has_the_second_side(self, monkeypatch):
        fake_logger = MagicMock()
        monkeypatch.setattr(manager_module, "logger", fake_logger)
        m, mocks, _ = _make_manager(dry_run=True, second_items=[_item(*A), _item(*B)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*B)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        _run(m, cb)

        calls = [
            call
            for call in fake_logger.info.call_args_list
            if call.kwargs.get("extra", {}).get("step") == "validate_file"
        ]
        assert len(calls) == 1
        message = calls[0].args[0]
        assert "両読み: 画像=2025-04-02/1200, 2025-04-03/900" in message
        assert "もう1人=2025-04-02/1200, 2025-04-03/900" in message

    def test_run_summary_is_emitted_only_with_a_second_reader(self, monkeypatch):
        monkeypatch.setattr(manager_module, "CashbookClient", MagicMock())

        for with_second, expected in ((True, True), (False, False)):
            fake_logger = MagicMock()
            monkeypatch.setattr(manager_module, "logger", fake_logger)
            m, mocks, _ = _make_manager(with_second=with_second)
            mocks["master"].read_customer_rows.return_value = [_customer()]
            mocks["drive"].list_files.return_value = []

            summary = m.run()

            steps = [
                call.kwargs.get("extra", {}).get("step") for call in fake_logger.info.call_args_list
            ]
            assert ("second_reader_summary" in steps) is expected
            assert "second_reader_summary" not in summary
            assert summary["total_customers"] == 1


def _customer() -> CustomerRow:
    return CustomerRow(
        row_number=2,
        customer_name="テスト顧客",
        entry_type="当方記帳",
        folder_url="https://drive.google.com/drive/folders/folder-1",
        sheet_url="https://docs.google.com/spreadsheets/d/sheet-1/edit",
    )


# ── main() の組み立て（§4・N9・N12） ─────────────────────


SECOND_READER_MAIN_ENV = (
    "RUN_MODE",
    "TARGET_SCOPE",
    "TARGET_ROW",
    "MASTER_SPREADSHEET_ID",
    "AI_MODEL",
    "AI_FLOW",
    "AI_THINKING_LEVEL",
    "AI_SECOND_READER",
    "GEMINI_API_KEY",
)


def _patch_main(monkeypatch, *, flow="dual", second_value=None, mode="prod"):
    import os

    for name in SECOND_READER_MAIN_ENV:
        monkeypatch.delenv(name, raising=False)
    for name in list(os.environ):
        if name.startswith("COMPARE_"):
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("RUN_MODE", mode)
    monkeypatch.setenv("MASTER_SPREADSHEET_ID", "MASTER")
    monkeypatch.setenv("AI_MODEL", "gemini-3.5-flash-lite")
    monkeypatch.setenv("AI_FLOW", flow)
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)
    if second_value is not None:
        monkeypatch.setenv("AI_SECOND_READER", second_value)

    created: list[tuple[AiConfig, str | None]] = []

    def create(config, api_key=None):
        created.append((config, api_key))
        return MagicMock()

    create_mock = MagicMock(side_effect=create)
    managers = MagicMock()
    managers.return_value.run.return_value = {}
    fake_logger = MagicMock()
    monkeypatch.setattr(main_module, "create_ai_extractor", create_mock)
    monkeypatch.setattr(main_module, "ProcessingManager", managers)
    monkeypatch.setattr(main_module, "MasterSheetClient", MagicMock())
    monkeypatch.setattr(main_module, "DriveClient", MagicMock())
    monkeypatch.setattr(main_module, "create_ocr_engine", MagicMock())
    monkeypatch.setattr(main_module, "RuleCorrector", MagicMock())
    monkeypatch.setattr(main_module, "setup_logger", MagicMock(return_value=fake_logger))
    monkeypatch.setattr(main_module, "run_compare", MagicMock(return_value=0))
    return created, create_mock, managers, fake_logger


@pytest.mark.parametrize("value", [None, "none", "NONE"])
def test_main_creates_only_one_extractor_by_default(monkeypatch, value):
    created, create_mock, managers, _ = _patch_main(monkeypatch, second_value=value)

    assert main_module.main() == 0
    assert create_mock.call_count == 1
    assert managers.call_args.kwargs["second_ai"] is None


def test_main_creates_the_second_extractor_for_dual(monkeypatch):
    created, create_mock, managers, _ = _patch_main(
        monkeypatch, second_value="gemini-3.8-flash@high"
    )

    assert main_module.main() == 0
    assert create_mock.call_count == 2
    main_config, main_key = created[0]
    second_config, second_key = created[1]
    assert main_key == second_key == FAKE_KEY
    assert main_config.model == "gemini-3.5-flash-lite"
    assert second_config.model == "gemini-3.8-flash"
    assert main_config.thinking_level == "low"
    assert second_config.thinking_level == "high"
    # 型名と考える量だけが主と違う（§4）
    assert second_config.prompt_version == main_config.prompt_version
    assert second_config.temperature == main_config.temperature
    assert second_config.max_tokens == main_config.max_tokens
    assert second_config.request_timeout_seconds == main_config.request_timeout_seconds
    assert second_config.engine == main_config.engine
    assert managers.call_args.kwargs["second_ai"] is not None


def test_main_does_not_create_the_second_extractor_for_text_first(monkeypatch):
    _, create_mock, managers, fake_logger = _patch_main(
        monkeypatch, flow="text_first", second_value="gemini-3.8-flash"
    )

    assert main_module.main() == 0
    assert create_mock.call_count == 1
    assert managers.call_args.kwargs["second_ai"] is None
    warnings = [str(call) for call in fake_logger.warning.call_args_list]
    assert any("AI_SECOND_READER は AI_FLOW=dual のときだけ使います" in text for text in warnings)


def test_main_does_not_create_the_second_extractor_for_compare(monkeypatch):
    created, create_mock, managers, fake_logger = _patch_main(
        monkeypatch, mode="compare", second_value="claude-haiku-test"
    )

    assert main_module.main() == 0
    assert create_mock.call_count == 0
    managers.assert_not_called()
    fake_logger.warning.assert_not_called()


def test_main_stops_before_any_client_on_an_invalid_value(monkeypatch):
    created, create_mock, managers, _ = _patch_main(monkeypatch, second_value="claude-haiku-test")
    drive = MagicMock()
    master = MagicMock()
    monkeypatch.setattr(main_module, "DriveClient", drive)
    monkeypatch.setattr(main_module, "MasterSheetClient", master)

    assert main_module.main() == 1
    assert created == []
    create_mock.assert_not_called()
    managers.assert_not_called()
    drive.assert_not_called()
    master.assert_not_called()


@pytest.mark.parametrize("mode", ["prod", "validate"])
def test_main_does_not_import_the_other_sdks(monkeypatch, mode):
    monkeypatch.delitem(sys.modules, "anthropic", raising=False)
    monkeypatch.delitem(sys.modules, "openai", raising=False)
    _patch_main(monkeypatch, mode=mode, second_value="gemini-3.8-flash")

    assert main_module.main() == 0
    assert "anthropic" not in sys.modules
    assert "openai" not in sys.modules


def test_main_rejects_the_same_model_as_ai_model(monkeypatch):
    import os

    for name in SECOND_READER_MAIN_ENV:
        monkeypatch.delenv(name, raising=False)
    for name in list(os.environ):
        if name.startswith("COMPARE_"):
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("RUN_MODE", "prod")
    monkeypatch.setenv("MASTER_SPREADSHEET_ID", "MASTER")
    monkeypatch.setenv("AI_MODEL", "gemini-3.8-flash")
    monkeypatch.setenv("AI_SECOND_READER", "gemini-3.8-flash")
    create_mock = MagicMock()
    managers = MagicMock()
    monkeypatch.setattr(main_module, "create_ai_extractor", create_mock)
    monkeypatch.setattr(main_module, "ProcessingManager", managers)
    monkeypatch.setattr(main_module, "setup_logger", MagicMock(return_value=MagicMock()))

    assert main_module.main() == 1
    create_mock.assert_not_called()
    managers.assert_not_called()


# ── §13.1 N1 を文字どおりに確かめる（もう 1 人なし） ─────────────

DRIVE_LINK = "https://drive.google.com/file/d/fid-1/view"


def _main_corrected(item: ReceiptItem) -> CorrectedItem:
    """`_make_manager` の corrector が返す形（補正なし）。"""
    return CorrectedItem(
        original=item,
        date=item.date,
        amount=item.amount,
        time=item.time,
        receipt_no=item.receipt_no,
        vendor=item.vendor,
        description=item.description,
        account=item.account,
        tax_category=item.tax_category,
        confidence=item.confidence,
        is_expense=item.is_expense,
        memo=item.memo,
        needs_review=False,
    )


def _details(date: str, amount: int, vendor: str = "テスト店") -> ReceiptDetails:
    return ReceiptDetails(date=date, time="", amount=amount, vendor=vendor, receipt_no="")


class TestN1ExactBehaviour:
    def test_all_matched(self):
        m, mocks, _ = _make_manager(with_second=False)
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        result = _run(m, cb)

        assert (result.success, result.manual_entry, result.errors, result.skipped) == (1, 0, 0, 0)
        mocks["ai"].extract_from_file.assert_called_once()
        mocks["ai"].extract_receipt_data.assert_called_once()
        cb.reserve_rows.assert_called_once_with(
            count=1,
            file_id="fid-1",
            file_name="receipt-1.jpg",
            receipt_indices=[0],
            details={0: _details("2025-04-02", 1200)},
        )
        cb.write_cashbook_row.assert_called_once_with(
            100, _main_corrected(_item(*A)), DRIVE_LINK, error_detail=None
        )
        cb.write_manual_entry_row.assert_not_called()
        cb.append_ai_log.assert_called_once_with(
            AiLogRecord(
                timestamp=NOW,
                file_id="fid-1",
                file_name="receipt-1.jpg",
                receipt_index=0,
                ocr_engine="vision",
                ocr_confidence=0.9,
                date="2025-04-02",
                amount="1200",
                vendor="テスト店",
                description="テスト摘要",
                account="雑費",
                tax_category="課税仕入10%",
                corrected_account="雑費",
                corrected_tax_category="課税仕入10%",
                corrections_applied="",
                needs_review=False,
                memo=(
                    "両読み=一致 | 画像=2025-04-02/1200 ｜ 文字=2025-04-02/1200 | "
                    "retry=no | amount_status=ok | adopted=primary | "
                    "金額候補: [200, 1200] (status=ok)"
                ),
            )
        )
        mocks["drive"].rename_file_as_done.assert_called_once()

    def test_one_amount_mismatch(self):
        m, mocks, _ = _make_manager(with_second=False)
        cb = _cb_mock()
        image_item = _item(*A)
        mocks["ai"].extract_from_file.return_value = [image_item]
        mocks["ai"].extract_receipt_data.return_value = [_item(A[0], 1500)]

        result = _run(m, cb)

        assert (result.success, result.manual_entry, result.errors) == (0, 1, 0)
        mocks["ai"].extract_from_file.assert_called_once()
        mocks["ai"].extract_receipt_data.assert_called_once()
        cb.reserve_rows.assert_called_once_with(
            count=1,
            file_id="fid-1",
            file_name="receipt-1.jpg",
            receipt_indices=[0],
            details={0: _details("2025-04-02", 1200)},
        )
        cb.write_cashbook_row.assert_not_called()
        expected = "両読み要確認（金額が食い違う）: 画像=2025-04-02/1200 ｜ 文字=2025-04-02/1500"
        cb.write_manual_entry_row.assert_called_once_with(
            100,
            DRIVE_LINK,
            "2025-04-02",
            expected,
            corrected=_main_corrected(image_item),
            short_label="※金額要確認",
        )
        cb.append_ai_log.assert_called_once_with(
            AiLogRecord(
                timestamp=NOW,
                file_id="fid-1",
                file_name="receipt-1.jpg",
                receipt_index=0,
                ocr_engine="vision",
                ocr_confidence=0.9,
                date="2025-04-02",
                amount="1200",
                vendor="テスト店",
                description="テスト摘要",
                account="雑費",
                tax_category="課税仕入10%",
                corrected_account="雑費",
                corrected_tax_category="課税仕入10%",
                corrections_applied="",
                needs_review=True,
                memo=expected,
            )
        )
        mocks["drive"].rename_file_as_done.assert_not_called()

    def test_text_read_one_more(self):
        m, mocks, _ = _make_manager(with_second=False)
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A), _item(*B)]

        result = _run(m, cb)

        assert (result.success, result.manual_entry, result.errors) == (0, 1, 0)
        cb.reserve_rows.assert_called_once_with(
            count=1,
            file_id="fid-1",
            file_name="receipt-1.jpg",
            receipt_indices=[0],
            details={0: _details("2025-04-02", 1200)},
        )
        expected = (
            "両読み要確認（文字からは 2 件、画像からは 1 件）: "
            "画像=2025-04-02/1200 ｜ 文字=2025-04-02/1200, 2025-04-03/900"
        )
        cb.write_manual_entry_row.assert_called_once_with(
            100,
            DRIVE_LINK,
            "2025-04-02",
            expected,
            corrected=_main_corrected(_item(*A)),
            short_label="※明細数要確認",
        )
        mocks["drive"].rename_file_as_done.assert_not_called()

    def test_image_empty_text_only(self):
        m, mocks, _ = _make_manager(with_second=False)
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = []
        mocks["ai"].extract_receipt_data.return_value = [_item(*A), _item(*B)]

        result = _run(m, cb)

        assert (result.success, result.manual_entry, result.errors) == (0, 2, 0)
        mocks["ai"].extract_from_file.assert_called_once()
        mocks["ai"].extract_receipt_data.assert_called_once()
        cb.reserve_rows.assert_called_once_with(
            count=2,
            file_id="fid-1",
            file_name="receipt-1.jpg",
            receipt_indices=[0, 1],
            details={
                0: _details("2025-04-02", 1200),
                1: _details("2025-04-03", 900),
            },
        )
        expected = (
            "両読み要確認（画像からの読みが無い）: "
            "画像=なし ｜ 文字=2025-04-02/1200, 2025-04-03/900"
        )
        assert cb.write_manual_entry_row.call_args_list == [
            mock_call(
                100,
                DRIVE_LINK,
                "2025-04-02",
                expected,
                corrected=_main_corrected(_item(*A)),
                short_label="※読み取り要確認",
            ),
            mock_call(
                101,
                DRIVE_LINK,
                "2025-04-03",
                expected,
                corrected=_main_corrected(_item(*B)),
                short_label="※読み取り要確認",
            ),
        ]
        memos = [c.args[0].memo for c in cb.append_ai_log.call_args_list]
        assert memos == [expected, expected]
        mocks["drive"].rename_file_as_done.assert_not_called()

    def test_numbered_marks(self):
        m, mocks, _ = _make_manager(with_second=False)
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*B)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        result = _run(m, cb, processed_keys={"fid-1:0"})

        assert (result.success, result.manual_entry, result.errors, result.skipped) == (
            0,
            1,
            0,
            1,
        )
        cb.reserve_rows.assert_called_once_with(
            count=1,
            file_id="fid-1",
            file_name="receipt-1.jpg",
            receipt_indices=[1],
            details={
                0: _details("2025-04-02", 1200),
                1: _details("2025-04-03", 900),
            },
        )
        expected = (
            "両読み要確認（前の回と明細の数か並びが変わった疑い）: "
            "画像=2025-04-02/1200, 2025-04-03/900 ｜ 文字=2025-04-02/1200"
        )
        cb.write_manual_entry_row.assert_called_once_with(
            100,
            DRIVE_LINK,
            "2025-04-03",
            expected,
            corrected=_main_corrected(_item(*B)),
            short_label="※再読取要確認",
        )
        mocks["drive"].rename_file_as_done.assert_not_called()

    def test_cross_file_duplicate(self):
        known = ReceiptSource(
            file_id="fid-old",
            file_name="old.jpg",
            index=0,
            date="2025-04-02",
            amount=1200,
            vendor="テスト店",
        )
        m, mocks, _ = _make_manager(with_second=False)
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        result = _run(m, cb, known=[known])

        assert (result.success, result.manual_entry, result.errors, result.skipped) == (
            0,
            0,
            0,
            1,
        )
        cb.reserve_rows.assert_not_called()
        cb.write_cashbook_row.assert_not_called()
        cb.write_manual_entry_row.assert_not_called()
        cb.append_process_record.assert_called_once_with(
            ProcessRecord(
                file_id="fid-1",
                file_name="receipt-1.jpg",
                receipt_index=0,
                mime_type="image/jpeg",
                processed_at=NOW,
                status=ProcessStatus.DUPLICATE.value,
                source_folder_id="folder-1",
                details=_details("2025-04-02", 1200),
                duplicate_of="fid-old:0",
            )
        )
        mocks["drive"].append_description_lines.assert_called_once_with(
            _file(),
            [
                "重複: 1 枚目 → 重複元 old.jpg "
                "https://drive.google.com/file/d/fid-old/view（1 枚目）"
            ],
        )
        mocks["drive"].rename_file_as_duplicate.assert_called_once()


# ── §13.2 N3（書く値・重複の判断・_remember_booked は主の画像から） ──

SECOND_ONLY_VENDOR = "副店"
MAIN_ONLY_VENDOR = "主店"


def _n3_setup(known=None):
    """主の画像からは店名・時刻・レシート番号を持ち、もう 1 人が別の値を持つ。"""
    main_item = _item(*A, vendor=MAIN_ONLY_VENDOR)
    second_item = _item(
        *A,
        vendor=SECOND_ONLY_VENDOR,
        time="18:30",
        receipt_no="SUB-0002",
    )
    m, mocks, second = _make_manager(second_items=[second_item])
    mocks["ai"].extract_from_file.return_value = [main_item]
    mocks["ai"].extract_receipt_data.return_value = [_item(A[0], 1500)]
    cb = _cb_mock()
    run_known = [] if known is None else known
    result = _run(m, cb, known=run_known)
    return result, cb, mocks, second, run_known


class TestN3MainValuesOnly:
    def test_second_matched_item_keeps_the_main_details(self):
        result, cb, mocks, second, _ = _n3_setup()

        second.extract_from_file.assert_called_once()
        assert (result.success, result.manual_entry, result.errors) == (1, 0, 0)
        reserved = cb.reserve_rows.call_args.kwargs
        assert reserved["details"][0] == ReceiptDetails(
            date="2025-04-02",
            time="",
            amount=1200,
            vendor=MAIN_ONLY_VENDOR,
            receipt_no="",
        )
        # 表に書く値も主の画像から（もう 1 人の店名・時刻・レシート番号は使わない）
        written = cb.write_cashbook_row.call_args.args[1]
        assert written.vendor == MAIN_ONLY_VENDOR
        assert written.time is None
        assert written.receipt_no is None

    def test_cross_file_duplicate_uses_the_main_vendor(self):
        known = ReceiptSource(
            file_id="fid-old",
            file_name="old.jpg",
            index=0,
            date="2025-04-02",
            amount=1200,
            vendor=MAIN_ONLY_VENDOR,
        )
        result, cb, _, _, _ = _n3_setup(known=[known])

        assert (result.success, result.skipped) == (0, 1)
        cb.write_cashbook_row.assert_not_called()
        record = cb.append_process_record.call_args.args[0]
        assert record.details == ReceiptDetails(
            date="2025-04-02",
            time="",
            amount=1200,
            vendor=MAIN_ONLY_VENDOR,
            receipt_no="",
        )

    def test_cross_file_duplicate_does_not_match_the_second_vendors_vendor(self):
        known = ReceiptSource(
            file_id="fid-old",
            file_name="old.jpg",
            index=0,
            date="2025-04-02",
            amount=1200,
            vendor=SECOND_ONLY_VENDOR,
        )
        result, cb, _, _, _ = _n3_setup(known=[known])

        assert (result.success, result.skipped) == (1, 0)
        cb.append_process_record.assert_not_called()
        cb.write_cashbook_row.assert_called_once()

    def test_remember_booked_uses_the_main_values(self):
        _, _, _, _, known = _n3_setup()

        assert known == [
            ReceiptSource(
                file_id="fid-1",
                file_name="receipt-1.jpg",
                index=0,
                date="2025-04-02",
                time="",
                amount=1200,
                vendor=MAIN_ONLY_VENDOR,
                receipt_no="",
            )
        ]


# ── §13.3/§13.4 ログ・まとめ・失敗・MIME・dry_run・N9 ─────────────


def _cashbook_mock() -> MagicMock:
    return _cb_mock()


def _run_customer_with_files(monkeypatch, m, files):
    """1 顧客を `_process_customer` に通す（CashbookClient だけ差し替え）。"""
    cb = _cashbook_mock()
    cb.get_processed_keys.return_value = set()
    cb.get_duplicate_candidates.return_value = []
    monkeypatch.setattr(manager_module, "CashbookClient", lambda **kwargs: cb)
    m._drive.list_files.return_value = files
    result = m._process_customer(_customer())
    return result, cb


def _run_job_with_files(monkeypatch, m, files):
    """`run()` を 1 顧客ぶん通す（まとめのログまで確かめる）。"""
    cb = _cashbook_mock()
    cb.get_processed_keys.return_value = set()
    cb.get_duplicate_candidates.return_value = []
    monkeypatch.setattr(manager_module, "CashbookClient", lambda **kwargs: cb)
    m._drive.list_files.return_value = files
    m._master.read_customer_rows.return_value = [_customer()]
    return m.run(), cb


class TestSummaryAndFailureLogs:
    def test_run_summary_counts_files_and_matched_items(self, monkeypatch):
        files = [
            _file(),
            DriveFile(
                file_id="fid-2",
                file_name="receipt-2.jpg",
                mime_type="image/jpeg",
                folder_id="folder-1",
            ),
        ]
        m, mocks, _ = _make_manager(second_items=[_item(*B)])
        mocks["ai"].extract_from_file.side_effect = lambda f: {
            "fid-1": [_item(*A)],
            "fid-2": [_item(*B)],
        }[f.file_id]
        mocks["ai"].extract_receipt_data.side_effect = lambda ocr, name: {
            "receipt-1.jpg": [_item(*A)],
            "receipt-2.jpg": [_item(B[0], 1500)],
        }[name]
        fake_logger = MagicMock()
        monkeypatch.setattr(manager_module, "logger", fake_logger)

        result, cb = _run_job_with_files(monkeypatch, m, files)

        assert (result["planned_success"], result["planned_manual_entry"]) == (2, 0)
        steps = {
            c.kwargs.get("extra", {}).get("step"): c.args[0]
            for c in fake_logger.info.call_args_list
        }
        assert steps["second_reader_summary"] == (
            "もう1人の読み手のまとめ: 呼んだファイル=1, もう1人で合った明細=1"
        )
        assert steps["second_reader"] == (
            "もう1人で読みました: receipt-2.jpg 型=gemini-3.8-flash "
            "明細=1 失敗=none もう1人で一致=1"
        )
        assert cb.write_cashbook_row.call_count == 2

    def test_file_log_shows_the_failure_type(self, monkeypatch):
        m, mocks, second = _make_manager(second_side_effect=RuntimeError("boom"))
        second.last_extraction_error = "api_error"
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(A[0], 1500)]
        fake_logger = MagicMock()
        monkeypatch.setattr(manager_module, "logger", fake_logger)

        _run_customer_with_files(monkeypatch, m, [_file()])

        lines = [
            c.args[0]
            for c in fake_logger.info.call_args_list
            if c.kwargs.get("extra", {}).get("step") == "second_reader"
        ]
        assert lines == [
            "もう1人で読みました: receipt-1.jpg 型=gemini-3.8-flash "
            "明細=0 失敗=api_error もう1人で一致=0"
        ]

    def test_exception_on_the_first_file_does_not_stop_the_second(self, monkeypatch):
        files = [
            _file(),
            DriveFile(
                file_id="fid-2",
                file_name="receipt-2.jpg",
                mime_type="image/jpeg",
                folder_id="folder-1",
            ),
        ]

        def second_extract(f):
            if f.file_id == "fid-1":
                raise RuntimeError("boom")
            return [_item(*B)]

        m, mocks, second = _make_manager(second_side_effect=second_extract)
        mocks["ai"].extract_from_file.side_effect = lambda f: {
            "fid-1": [_item(*A)],
            "fid-2": [_item(*B)],
        }[f.file_id]
        mocks["ai"].extract_receipt_data.side_effect = lambda ocr, name: {
            "receipt-1.jpg": [_item(A[0], 1500)],
            "receipt-2.jpg": [_item(B[0], 1500)],
        }[name]

        result, cb = _run_customer_with_files(monkeypatch, m, files)

        assert second.extract_from_file.call_count == 2
        assert (result.success, result.manual_entry, result.errors) == (1, 1, 0)
        written = [c.args[1] for c in cb.write_cashbook_row.call_args_list]
        assert [(item.date, item.amount) for item in written] == [("2025-04-03", 900)]
        assert cb.write_manual_entry_row.call_count == 1


class TestSecondReaderBadReturns:
    @pytest.mark.parametrize(
        ("second_items", "second_side_effect", "expected_reason"),
        [
            (None, None, "読めなかった（zero_items）"),
            (None, lambda _f: None, "読めなかった（zero_items）"),
            (None, lambda _f: 5, "読めなかった（api_error）"),
            ([_item(A[0], "1200")], None, "金額が食い違う"),
            ([_item("2025-02-30", 1200)], None, "日付が食い違う"),
        ],
    )
    def test_bad_return_stays_review_and_the_job_continues(
        self, second_items, second_side_effect, expected_reason
    ):
        m, mocks, second = _make_manager(
            second_items=second_items,
            second_side_effect=second_side_effect,
        )
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(A[0], 1500)]

        result = _run(m, cb)

        second.extract_from_file.assert_called_once()
        assert (result.success, result.manual_entry, result.errors) == (0, 1, 0)
        cb.write_cashbook_row.assert_not_called()
        message = cb.write_manual_entry_row.call_args.args[3]
        assert f"もう1人: {expected_reason}" in message

    def test_unsupported_mime_is_not_sent_to_the_second_reader(self):
        m, mocks, second = _make_manager(second_items=[_item(*A)])
        cb = _cb_mock()
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-03", 1200)]
        mocks["ai"].extract_from_file.return_value = [_item(*A)]

        result = m._process_file(_file("application/msword"), cb, set(), TODAY, NOW)

        second.extract_from_file.assert_not_called()
        mocks["ai"].extract_from_file.assert_not_called()
        mocks["ai"].extract_receipt_data.assert_called_once()
        assert result.success == 1


class TestDryRunWritesNothing:
    def test_second_match_is_counted_but_nothing_is_written(self):
        m, mocks, second = _make_manager(dry_run=True, second_items=[_item(*A)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(A[0], 1500)]

        result = _run(m, cb)

        second.extract_from_file.assert_called_once()
        assert (result.success, result.manual_entry) == (1, 0)
        cb.reserve_rows.assert_not_called()
        cb.write_cashbook_row.assert_not_called()
        cb.write_manual_entry_row.assert_not_called()
        cb.append_ai_log.assert_not_called()
        cb.append_process_record.assert_not_called()
        mocks["drive"].rename_file_as_done.assert_not_called()
        mocks["drive"].rename_file_as_duplicate.assert_not_called()
        mocks["drive"].append_description_lines.assert_not_called()

    def test_duplicate_is_counted_but_not_recorded(self):
        known = ReceiptSource(
            file_id="fid-old",
            file_name="old.jpg",
            index=0,
            date="2025-04-02",
            amount=1200,
            vendor="テスト店",
        )
        m, mocks, _ = _make_manager(dry_run=True, second_items=[_item(*A)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(A[0], 1500)]

        result = _run(m, cb, known=[known])

        assert (result.success, result.skipped) == (0, 1)
        cb.reserve_rows.assert_not_called()
        cb.append_process_record.assert_not_called()
        cb.write_manual_entry_row.assert_not_called()
        mocks["drive"].rename_file_as_duplicate.assert_not_called()
        mocks["drive"].append_description_lines.assert_not_called()


# ── §13.3 もう 1 人の例外ログ（N10） ─────────────────────────────


class TestSecondReaderErrorLog:
    def test_exception_text_is_not_logged(self, monkeypatch):
        fake_logger = MagicMock()
        monkeypatch.setattr(manager_module, "logger", fake_logger)
        m, mocks, _ = _make_manager(second_side_effect=RuntimeError(f"failed with key {FAKE_KEY}"))
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(A[0], 1500)]

        _run(m, cb)

        errors = [
            c.args[0]
            for c in fake_logger.error.call_args_list
            if c.kwargs.get("extra", {}).get("step") == "second_reader_error"
        ]
        assert errors == [
            "両読み もう1人の抽出例外: receipt-1.jpg: RuntimeError",
        ]
        all_logged = []
        for method in (
            fake_logger.debug,
            fake_logger.info,
            fake_logger.warning,
            fake_logger.error,
        ):
            all_logged.extend(str(c) for c in method.call_args_list)
        assert all(FAKE_KEY not in text for text in all_logged)


# ── §13.3 main() の組み立て順 ───────────────────────────────


def _prepare_main_environment(monkeypatch, *, flow="dual", second_value=None, mode="prod"):
    import os

    for name in SECOND_READER_MAIN_ENV:
        monkeypatch.delenv(name, raising=False)
    for name in list(os.environ):
        if name.startswith("COMPARE_"):
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("RUN_MODE", mode)
    monkeypatch.setenv("MASTER_SPREADSHEET_ID", "MASTER")
    monkeypatch.setenv("AI_MODEL", "gemini-3.5-flash-lite")
    monkeypatch.setenv("AI_FLOW", flow)
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)
    if second_value is not None:
        monkeypatch.setenv("AI_SECOND_READER", second_value)


def test_main_builds_drive_master_ocr_before_the_readers(monkeypatch):
    _prepare_main_environment(monkeypatch, second_value="gemini-3.8-flash")
    order: list[str] = []

    def factory(label: str, result):
        def build(*args, **kwargs):
            order.append(label)
            return result

        return MagicMock(side_effect=build)

    def create(config, api_key=None):
        order.append("ai" if config.model == "gemini-3.5-flash-lite" else "second")
        return MagicMock()

    drive = MagicMock()
    master = MagicMock()
    ocr = MagicMock()
    monkeypatch.setattr(main_module, "create_ai_extractor", create)
    managers = MagicMock()
    managers.return_value.run.return_value = {}
    monkeypatch.setattr(main_module, "ProcessingManager", managers)
    monkeypatch.setattr(main_module, "DriveClient", factory("drive", drive))
    monkeypatch.setattr(main_module, "MasterSheetClient", factory("master", master))
    monkeypatch.setattr(main_module, "create_ocr_engine", factory("ocr", ocr))
    monkeypatch.setattr(main_module, "RuleCorrector", MagicMock())
    monkeypatch.setattr(main_module, "setup_logger", MagicMock(return_value=MagicMock()))

    assert main_module.main() == 0
    assert order == ["drive", "master", "ocr", "ai", "second"]
    kwargs = managers.call_args.kwargs
    assert kwargs["drive"] is drive
    assert kwargs["master"] is master
    assert kwargs["ocr"] is ocr


def test_n9_real_extractors_with_only_the_client_faked(monkeypatch):
    monkeypatch.delitem(sys.modules, "anthropic", raising=False)
    monkeypatch.delitem(sys.modules, "openai", raising=False)
    _prepare_main_environment(monkeypatch, mode="prod", second_value="gemini-3.8-flash@high")
    fake_client = MagicMock()
    fake_client_class = MagicMock(return_value=fake_client)
    monkeypatch.setattr("src.ai.gemini.genai.Client", fake_client_class)
    managers = MagicMock()
    managers.return_value.run.return_value = {}
    monkeypatch.setattr(main_module, "ProcessingManager", managers)
    monkeypatch.setattr(main_module, "MasterSheetClient", MagicMock())
    monkeypatch.setattr(main_module, "DriveClient", MagicMock())
    monkeypatch.setattr(main_module, "create_ocr_engine", MagicMock())
    monkeypatch.setattr(main_module, "RuleCorrector", MagicMock())
    monkeypatch.setattr(main_module, "setup_logger", MagicMock(return_value=MagicMock()))

    assert main_module.main() == 0
    assert fake_client_class.call_count == 2
    kwargs = managers.call_args.kwargs
    assert isinstance(kwargs["ai"], GeminiExtractor)
    assert isinstance(kwargs["second_ai"], GeminiExtractor)
    assert kwargs["ai"]._config.model == "gemini-3.5-flash-lite"
    assert kwargs["second_ai"]._config.model == "gemini-3.8-flash"
    assert kwargs["second_ai"]._config.thinking_level == "high"
    assert "anthropic" not in sys.modules
    assert "openai" not in sys.modules

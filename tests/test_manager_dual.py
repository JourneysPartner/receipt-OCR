"""両読み（AI_FLOW=dual）の _process_file のテスト。"""

from unittest.mock import ANY, MagicMock

import pytest

from src.config import (
    AiConfig,
    AppConfig,
    DriveConfig,
    MasterConfig,
    OcrConfig,
    SheetsConfig,
    TemplateConfig,
)
from src.models import CorrectedItem, DriveFile, OcrResult, ReceiptItem
from src.processing.manager import ProcessingManager

OCR_TEXT = "合計 ¥1,200"


def _make_manager(
    *, flow: str = "dual", dry_run: bool = False
) -> tuple[ProcessingManager, dict[str, MagicMock]]:
    config = AppConfig(
        master=MasterConfig(spreadsheet_id="m"),
        template=TemplateConfig(),
        drive=DriveConfig(),
        sheets=SheetsConfig(),
        ocr=OcrConfig(),
        ai=AiConfig(flow=flow),
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
        vendor=it.vendor,
        description=it.description,
        account=it.account,
        tax_category=it.tax_category,
        confidence=it.confidence,
        is_expense=it.is_expense,
        memo=it.memo,
        needs_review=False,
    )
    manager = ProcessingManager(
        config=config,
        drive=mocks["drive"],
        master=mocks["master"],
        ocr=mocks["ocr"],
        ai=mocks["ai"],
        corrector=mocks["corrector"],
    )
    return manager, mocks


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


def _item(date: str, amount: int) -> ReceiptItem:
    return ReceiptItem(
        date=date,
        amount=amount,
        vendor="店",
        description="摘要",
        account="雑費",
        tax_category="課税仕入10%",
        confidence=0.9,
    )


def _record_calls(mocks: dict[str, MagicMock], calls: list[str]) -> None:
    def image(_file):
        calls.append("image")
        return mocks["ai"].extract_from_file.return_value

    def text(_ocr, _name):
        calls.append("text")
        return mocks["ai"].extract_receipt_data.return_value

    mocks["ai"].extract_from_file.side_effect = image
    mocks["ai"].extract_receipt_data.side_effect = text


class TestDualAllMatched:
    def test_all_matched_is_written_and_marked_done(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        calls: list[str] = []
        mocks["ai"].extract_from_file.return_value = [_item("2025-04-02", 1200)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-02", 1200)]
        _record_calls(mocks, calls)

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert calls == ["image", "text"]
        mocks["ai"].extract_from_file.assert_called_once()
        mocks["ai"].extract_receipt_data.assert_called_once()
        assert result.success == 1
        assert result.manual_entry == 0
        cb.reserve_rows.assert_called_once_with(
            count=1,
            file_id="fid-1",
            file_name="receipt-1.jpg",
            receipt_indices=[0],
            details=ANY,
        )
        reserved = cb.reserve_rows.call_args.kwargs
        assert reserved["details"][0].amount == 1200
        cb.write_cashbook_row.assert_called_once()
        cb.write_manual_entry_row.assert_not_called()
        mocks["drive"].rename_file_as_done.assert_called_once()

    def test_matched_item_memo_has_agreement(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item("2025-04-02", 1200)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-02", 1200)]

        m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        record = cb.append_ai_log.call_args[0][0]
        assert "両読み=一致" in record.memo


class TestDualAmountMismatch:
    def test_mismatch_becomes_manual_entry_with_both_readings(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item("2025-04-02", 1200)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-02", 1500)]

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert result.manual_entry == 1
        assert result.success == 0
        cb.write_cashbook_row.assert_not_called()
        cb.write_manual_entry_row.assert_called_once()
        args = cb.write_manual_entry_row.call_args[0]
        kwargs = cb.write_manual_entry_row.call_args[1]
        assert kwargs["short_label"] == "※金額要確認"
        assert isinstance(kwargs["corrected"], CorrectedItem)
        assert kwargs["corrected"].date == "2025-04-02"
        assert "画像=2025-04-02/1200" in args[3]
        assert "文字=2025-04-02/1500" in args[3]
        cb.update_reservation_status.assert_any_call("rid-0", "manual_entry")
        # AI 詳細ログも要確認で残る
        assert cb.append_ai_log.call_args[0][0].needs_review is True
        mocks["drive"].rename_file_as_done.assert_not_called()

    def test_two_items_one_matched(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [
            _item("2025-04-02", 1200),
            _item("2025-04-03", 900),
        ]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-02", 1200)]

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert result.success == 1
        assert result.manual_entry == 1
        cb.reserve_rows.assert_called_once_with(
            count=2,
            file_id="fid-1",
            file_name="receipt-1.jpg",
            receipt_indices=[0, 1],
            details=ANY,
        )
        cb.write_cashbook_row.assert_called_once()
        cb.write_manual_entry_row.assert_called_once()
        mocks["drive"].rename_file_as_done.assert_not_called()


class TestDualImageEmpty:
    def test_image_empty_text_present_all_reviewed(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = []
        mocks["ai"].extract_receipt_data.return_value = [
            _item("2025-04-02", 1200),
            _item("2025-04-03", 900),
        ]

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert result.manual_entry == 2
        cb.write_cashbook_row.assert_not_called()
        assert cb.write_manual_entry_row.call_count == 2
        for call in cb.write_manual_entry_row.call_args_list:
            assert call.kwargs["short_label"] == "※読み取り要確認"
        assert "画像=なし" in cb.write_manual_entry_row.call_args_list[0].args[3]
        mocks["drive"].rename_file_as_done.assert_not_called()


class TestDualBothEmpty:
    def test_both_empty_one_manual_row(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = []
        mocks["ai"].extract_receipt_data.return_value = []

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert result.manual_entry == 1
        cb.reserve_rows.assert_called_once_with(
            count=1, file_id="fid-1", file_name="receipt-1.jpg", receipt_indices=[-1]
        )
        cb.write_manual_entry_row.assert_called_once()
        assert cb.write_manual_entry_row.call_args[1]["short_label"] == "※AI抽出要確認"


class TestDualOcrFailed:
    def test_ocr_failed_skips_text_extraction(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="", engine="vision", confidence=0.0, error="ocr error"
        )
        mocks["ai"].extract_from_file.return_value = [_item("2025-04-02", 1200)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-02", 1200)]

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        mocks["ai"].extract_from_file.assert_called_once()
        mocks["ai"].extract_receipt_data.assert_not_called()
        assert result.manual_entry == 1
        cb.write_manual_entry_row.assert_called_once()
        assert cb.write_manual_entry_row.call_args[1]["short_label"] == "※読み取り要確認"


class TestDualExceptions:
    def test_image_exception_does_not_escape(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.side_effect = RuntimeError("boom")
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-02", 1200)]

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert result.manual_entry == 1
        mocks["ai"].extract_receipt_data.assert_called_once()
        cb.write_manual_entry_row.assert_called_once()
        assert cb.write_manual_entry_row.call_args[1]["short_label"] == "※読み取り要確認"

    def test_text_exception_does_not_escape(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item("2025-04-02", 1200)]
        mocks["ai"].extract_receipt_data.side_effect = RuntimeError("boom")

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert result.manual_entry == 1
        cb.write_cashbook_row.assert_not_called()
        assert cb.write_manual_entry_row.call_args[1]["short_label"] == "※読み取り要確認"


class TestDualUnsupportedMime:
    def test_unsupported_mime_uses_text_first(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        calls: list[str] = []
        mocks["ai"].extract_from_file.return_value = [_item("2025-04-02", 1200)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-02", 1200)]
        _record_calls(mocks, calls)

        result = m._process_file(
            _file("application/msword"), cb, set(), "2025-04-02", "2025-04-02T10:00"
        )

        assert calls == ["text"]
        mocks["ai"].extract_receipt_data.assert_called_once()
        mocks["ai"].extract_from_file.assert_not_called()
        assert result.success == 1
        cb.write_cashbook_row.assert_called_once()


class TestDualProcessedKeys:
    def test_processed_item_is_neither_written_nor_reserved(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [
            _item("2025-04-02", 1200),
            _item("2025-04-03", 900),
        ]
        mocks["ai"].extract_receipt_data.return_value = [
            _item("2025-04-02", 1200),
            _item("2025-04-03", 900),
        ]

        result = m._process_file(_file(), cb, {"fid-1:0"}, "2025-04-02", "2025-04-02T10:00")

        # 番号 0 は書かず・予約もしない。番号 1 は読み直しなので自動にしない
        assert result.skipped == 1
        assert result.success == 0
        assert result.manual_entry == 1
        cb.reserve_rows.assert_called_once_with(
            count=1,
            file_id="fid-1",
            file_name="receipt-1.jpg",
            receipt_indices=[1],
            details=ANY,
        )
        reserved = cb.reserve_rows.call_args.kwargs
        assert reserved["details"][1].amount == 900
        cb.write_cashbook_row.assert_not_called()
        cb.write_manual_entry_row.assert_called_once()
        assert cb.write_manual_entry_row.call_args[1]["short_label"] == "※再読取要確認"
        assert cb.write_manual_entry_row.call_args[1]["corrected"].amount == 900
        mocks["drive"].rename_file_as_done.assert_not_called()


class TestDualDryRun:
    def test_dry_run_only_counts(self):
        m, mocks = _make_manager(dry_run=True)
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [
            _item("2025-04-02", 1200),
            _item("2025-04-03", 900),
        ]
        mocks["ai"].extract_receipt_data.return_value = [
            _item("2025-04-02", 1200),
            _item("2025-04-03", 900),
        ]

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert result.success == 2
        assert result.manual_entry == 0
        cb.reserve_rows.assert_not_called()
        cb.write_cashbook_row.assert_not_called()
        cb.write_manual_entry_row.assert_not_called()
        cb.append_ai_log.assert_not_called()
        mocks["drive"].rename_file_as_done.assert_not_called()

    def test_dry_run_counts_manual_reviews(self):
        m, mocks = _make_manager(dry_run=True)
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [
            _item("2025-04-02", 1200),
            _item("2025-04-03", 900),
        ]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-02", 1200)]

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert result.success == 1
        assert result.manual_entry == 1
        cb.reserve_rows.assert_not_called()
        cb.write_cashbook_row.assert_not_called()
        cb.write_manual_entry_row.assert_not_called()


class TestDualReread:
    def test_unmarked_items_after_a_mark_are_not_automatic(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [
            _item("2025-04-02", 1200),
            _item("2025-04-03", 900),
        ]
        mocks["ai"].extract_receipt_data.return_value = [
            _item("2025-04-02", 1200),
            _item("2025-04-03", 900),
        ]

        result = m._process_file(_file(), cb, {"fid-1:0"}, "2025-04-02", "2025-04-02T10:00")

        assert result.skipped == 1
        assert result.success == 0
        assert result.manual_entry == 1
        assert result.errors == 0
        cb.reserve_rows.assert_called_once_with(
            count=1,
            file_id="fid-1",
            file_name="receipt-1.jpg",
            receipt_indices=[1],
            details=ANY,
        )
        cb.write_cashbook_row.assert_not_called()
        cb.write_manual_entry_row.assert_called_once()
        assert cb.write_manual_entry_row.call_args[1]["short_label"] == "※再読取要確認"
        assert cb.write_manual_entry_row.call_args[1]["corrected"].amount == 900
        mocks["drive"].rename_file_as_done.assert_not_called()

    def test_reread_when_the_order_of_numbers_changed(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        new_item = _item("2025-04-04", 500)
        first = _item("2025-04-02", 1200)
        second = _item("2025-04-03", 900)
        mocks["ai"].extract_from_file.return_value = [new_item, first, second]
        mocks["ai"].extract_receipt_data.return_value = [new_item, first, second]

        result = m._process_file(
            _file(), cb, {"fid-1:0", "fid-1:1"}, "2025-04-02", "2025-04-02T10:00"
        )

        assert result.skipped == 2
        assert result.success == 0
        assert result.manual_entry == 1
        cb.reserve_rows.assert_called_once_with(
            count=1,
            file_id="fid-1",
            file_name="receipt-1.jpg",
            receipt_indices=[2],
            details=ANY,
        )
        cb.write_cashbook_row.assert_not_called()
        cb.write_manual_entry_row.assert_called_once()
        assert cb.write_manual_entry_row.call_args[1]["short_label"] == "※再読取要確認"
        assert cb.write_manual_entry_row.call_args[1]["corrected"].amount == 900
        mocks["drive"].rename_file_as_done.assert_not_called()

    def test_marks_of_another_file_with_the_same_prefix_do_not_count(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item("2025-04-02", 1200)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-02", 1200)]

        result = m._process_file(_file(), cb, {"fid-19:0"}, "2025-04-02", "2025-04-02T10:00")

        assert result.success == 1
        assert result.manual_entry == 0
        cb.write_cashbook_row.assert_called_once()
        cb.write_manual_entry_row.assert_not_called()
        mocks["drive"].rename_file_as_done.assert_called_once()

    def test_dry_run_counts_reread_items_as_manual(self):
        m, mocks = _make_manager(dry_run=True)
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [
            _item("2025-04-02", 1200),
            _item("2025-04-03", 900),
        ]
        mocks["ai"].extract_receipt_data.return_value = [
            _item("2025-04-02", 1200),
            _item("2025-04-03", 900),
        ]

        result = m._process_file(_file(), cb, {"fid-1:0"}, "2025-04-02", "2025-04-02T10:00")

        assert result.success == 1
        assert result.low_confidence == 0
        assert result.manual_entry == 1
        cb.reserve_rows.assert_not_called()
        cb.write_cashbook_row.assert_not_called()
        cb.write_manual_entry_row.assert_not_called()
        cb.append_ai_log.assert_not_called()
        mocks["drive"].rename_file_as_done.assert_not_called()


class TestDualReviewLabels:
    def test_text_has_more_items_than_image(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item("2025-04-02", 1200)]
        mocks["ai"].extract_receipt_data.return_value = [
            _item("2025-04-02", 1200),
            _item("2025-04-03", 900),
        ]

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert result.manual_entry == 1
        cb.reserve_rows.assert_called_once_with(
            count=1,
            file_id="fid-1",
            file_name="receipt-1.jpg",
            receipt_indices=[0],
            details=ANY,
        )
        cb.write_cashbook_row.assert_not_called()
        assert cb.write_manual_entry_row.call_args[1]["short_label"] == "※明細数要確認"

    def test_digit_inflation_is_reviewed(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )
        mocks["ai"].extract_from_file.return_value = [_item("2026-04-27", 41600)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2026-04-27", 41600)]

        result = m._process_file(_file(), cb, set(), "2026-04-27", "2026-04-27T10:00")

        assert result.manual_entry == 1
        assert result.success == 0
        cb.write_cashbook_row.assert_not_called()
        assert cb.write_manual_entry_row.call_args[1]["short_label"] == "※金額要確認"

    def test_zero_amount_is_not_automatic(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item("2025-04-02", 0)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-02", 0)]

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert result.manual_entry == 1
        assert result.success == 0
        cb.write_cashbook_row.assert_not_called()
        assert cb.write_manual_entry_row.call_args[1]["short_label"] == "※金額要確認"

    def test_ocr_failed_and_no_image_uses_ocr_extraction_label(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="", engine="vision", confidence=0.0, error="ocr error"
        )
        mocks["ai"].extract_from_file.return_value = []
        mocks["ai"].extract_receipt_data.return_value = []

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert result.manual_entry == 1
        assert cb.write_manual_entry_row.call_args[1]["short_label"] == "※OCR/抽出要確認"


class TestDualWriteFailures:
    def test_review_write_exception_becomes_error(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item("2025-04-02", 1200)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-02", 1500)]
        cb.write_manual_entry_row.side_effect = RuntimeError("boom")

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert result.errors == 1
        assert result.manual_entry == 0
        cb.update_reservation_status.assert_any_call("rid-0", "error")
        mocks["drive"].rename_file_as_done.assert_not_called()

    def test_cashbook_write_exception_falls_back_to_manual_row(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item("2025-04-02", 1200)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-02", 1200)]
        cb.write_cashbook_row.side_effect = RuntimeError("boom")

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert result.manual_entry == 1
        assert result.errors == 0
        cb.write_manual_entry_row.assert_called_once()
        cb.update_reservation_status.assert_any_call("rid-0", "manual_entry")
        mocks["drive"].rename_file_as_done.assert_not_called()

    def test_cashbook_write_exception_with_failed_manual_row_is_error(self):
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item("2025-04-02", 1200)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-02", 1200)]
        cb.write_cashbook_row.side_effect = RuntimeError("boom")
        cb.write_manual_entry_row.side_effect = RuntimeError("boom again")

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert result.errors == 1
        cb.update_reservation_status.assert_any_call("rid-0", "error")
        mocks["drive"].rename_file_as_done.assert_not_called()


_A = ("2025-04-02", 1200)
_B = ("2025-04-03", 900)


@pytest.mark.parametrize(
    ("image", "text", "matched"),
    [
        ([_A, _B], [_A, _B], {0, 1}),
        ([_A, _B], [_A], {0}),
        ([_A], [("2025-04-02", 1500)], set()),
        ([_A], [("2025-04-03", 1200)], set()),
        ([_A], [], set()),
        ([_A], [_A, _B], set()),
    ],
)
def test_only_matched_items_are_written_automatically(image, text, matched):
    m, mocks = _make_manager()
    cb = _cb_mock()
    mocks["ai"].extract_from_file.return_value = [_item(*pair) for pair in image]
    mocks["ai"].extract_receipt_data.return_value = [_item(*pair) for pair in text]

    result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

    written: dict[int, str] = {}
    for call in cb.write_cashbook_row.call_args_list:
        written[call.args[0] - 100] = "cashbook"
    for call in cb.write_manual_entry_row.call_args_list:
        written[call.args[0] - 100] = "manual"
    assert written == {
        index: ("cashbook" if index in matched else "manual") for index in range(len(image))
    }
    assert cb.write_cashbook_row.call_count == len(matched)
    assert cb.write_manual_entry_row.call_count == len(image) - len(matched)
    assert result.success == len(matched)
    assert result.manual_entry == len(image) - len(matched)


class TestTextFirstUnchanged:
    def test_text_first_calls_text_before_image(self):
        m, mocks = _make_manager(flow="text_first")
        cb = _cb_mock()
        calls: list[str] = []
        mocks["ai"].extract_from_file.return_value = [_item("2025-04-02", 1200)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-02", 1200)]
        _record_calls(mocks, calls)

        result = m._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert calls == ["text"]
        mocks["ai"].extract_from_file.assert_not_called()
        assert result.success == 1
        cb.write_cashbook_row.assert_called_once()
        mocks["drive"].rename_file_as_done.assert_called_once()

    def test_text_first_skips_file_with_minus_one_key(self):
        m, mocks = _make_manager(flow="text_first")
        cb = _cb_mock()

        result = m._process_file(_file(), cb, {"fid-1:-1"}, "2025-04-02", "2025-04-02T10:00")

        assert result.skipped == 1
        mocks["ai"].extract_receipt_data.assert_not_called()

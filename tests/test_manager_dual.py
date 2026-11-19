"""両読み（AI_FLOW=dual）の _process_file のテスト。"""

from unittest.mock import MagicMock

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
            count=1, file_id="fid-1", file_name="receipt-1.jpg", receipt_indices=[0]
        )
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
        cb.reserve_rows.assert_called_once()
        assert cb.reserve_rows.call_args[1]["count"] == 2
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

        assert result.skipped == 1
        assert result.success == 1
        cb.reserve_rows.assert_called_once_with(
            count=1, file_id="fid-1", file_name="receipt-1.jpg", receipt_indices=[1]
        )
        cb.write_cashbook_row.assert_called_once()
        written = cb.write_cashbook_row.call_args[0][1]
        assert written.amount == 900
        mocks["drive"].rename_file_as_done.assert_called_once()


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

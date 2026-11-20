"""重複したレシートの見分け（仕様 `docs/spec_duplicates.md`）のテスト。

API・Drive・Sheets はすべて偽物。データは架空のものだけを使う。
"""

from unittest.mock import MagicMock

import pytest

import src.main as main_module
from src.ai import prompts
from src.config import (
    AiConfig,
    AppConfig,
    DriveConfig,
    MasterConfig,
    OcrConfig,
    SheetsConfig,
    TemplateConfig,
)
from src.drive.client import DriveClient
from src.models import (
    CorrectedItem,
    CustomerRow,
    DriveFile,
    OcrResult,
    ProcessRecord,
    ProcessStatus,
    ReceiptDetails,
    ReceiptItem,
)
from src.processing.duplicates import (
    SAME_FILE_DUPLICATE_NOTE,
    ReceiptSource,
    is_same_voucher,
    normalize_receipt_no,
    normalize_time,
    same_file_duplicate_indices,
)
from src.processing.manager import ProcessingManager
from src.sheets.client import (
    _DONE_STATUSES,
    PROCESS_LOG_HEADERS,
    CashbookClient,
    ProcessLogHeaderError,
)

OCR_TEXT = "合計 ¥1,200"


# ── 偽物の組み立て ─────────────────────────────────────
def _make_manager(
    *, flow: str = "text_first", dry_run: bool = False
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
    mocks["corrector"].apply.side_effect = _passthrough
    manager = ProcessingManager(
        config=config,
        drive=mocks["drive"],
        master=mocks["master"],
        ocr=mocks["ocr"],
        ai=mocks["ai"],
        corrector=mocks["corrector"],
    )
    return manager, mocks


def _passthrough(item: ReceiptItem) -> CorrectedItem:
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


def _file(file_id: str = "fid-1", name: str = "receipt-1.jpg") -> DriveFile:
    return DriveFile(file_id=file_id, file_name=name, mime_type="image/jpeg", folder_id="folder-1")


def _cb_mock() -> MagicMock:
    cb = MagicMock()
    cb.reserve_rows.side_effect = lambda **kwargs: [
        (100 + i, f"rid-{i}") for i in range(kwargs["count"])
    ]
    return cb


def _item(
    date: str = "2025-04-02",
    amount: int = 1200,
    *,
    vendor: str = "テスト商店",
    time: str | None = None,
    receipt_no: str | None = None,
) -> ReceiptItem:
    return ReceiptItem(
        date=date,
        amount=amount,
        time=time,
        receipt_no=receipt_no,
        vendor=vendor,
        description="テスト品",
        account="消耗品費",
        tax_category="課税仕入10%",
        confidence=0.9,
    )


def _source(
    *,
    file_id: str = "src-1",
    file_name: str = "元のレシート.jpg",
    index: int = 0,
    date: str = "2025-04-02",
    amount: int | None = 1200,
    vendor: str = "テスト商店",
    time: str = "",
    receipt_no: str = "",
) -> ReceiptSource:
    return ReceiptSource(
        file_id=file_id,
        file_name=file_name,
        index=index,
        date=date,
        time=time,
        amount=amount,
        vendor=vendor,
        receipt_no=receipt_no,
    )


def _run_text(manager, mocks, cb, items, known=None, file=None):
    mocks["ai"].extract_receipt_data.return_value = items
    return manager._process_file(
        file or _file(),
        cb,
        set(),
        "2025-04-02",
        "2025-04-02T10:00",
        known_receipts=known,
    )


# ── §3 同じ証憑かの判断 ────────────────────────────────
class TestIsSameVoucher:
    def test_same_date_amount_vendor_without_time_or_number_is_same(self):
        assert is_same_voucher(_item(), _item())

    def test_time_differs_on_both_is_different(self):
        left = _item(time="17:32")
        right = _item(time="17:33")
        assert not is_same_voucher(left, right)

    def test_time_on_one_side_only_is_same(self):
        assert is_same_voucher(_item(time="17:32"), _item())

    def test_receipt_no_differs_on_both_is_different(self):
        assert not is_same_voucher(_item(receipt_no="0012"), _item(receipt_no="0013"))

    def test_receipt_no_on_one_side_only_is_same(self):
        assert is_same_voucher(_item(receipt_no="0012"), _item())

    def test_receipt_no_normalization(self):
        assert normalize_receipt_no(" 0012 ") == "0012"
        assert normalize_receipt_no("0012-34") == "001234"
        assert normalize_receipt_no("００１２－３４") == "001234"
        assert normalize_receipt_no("r-0012") == "R0012"
        assert is_same_voucher(_item(receipt_no="R-0012"), _item(receipt_no="r 0012"))

    def test_time_normalization(self):
        assert normalize_time("9:05") == "09:05"
        assert normalize_time("０９：０５") == "09:05"
        assert normalize_time("25:00") == ""
        assert is_same_voucher(_item(time="9:05"), _item(time="09:05"))

    def test_vendor_corporate_word_and_branch_name(self):
        assert is_same_voucher(
            _item(vendor="株式会社テスト商店 駅前支店"),
            _item(vendor="テスト商店"),
        )

    def test_empty_vendor_does_not_match(self):
        assert not is_same_voucher(_item(vendor=""), _item(vendor="テスト商店"))

    def test_unreadable_date_is_not_same(self):
        assert not is_same_voucher(_item(date=None), _item())  # type: ignore[arg-type]
        assert not is_same_voucher(_item(date="2025-13-40"), _item())
        # 仕様 §3 は `YYYY-MM-DD` の形そのものだけを読めているとみなす
        assert not is_same_voucher(_item(date="2025/04/02"), _item())

    def test_unreadable_amount_is_not_same(self):
        assert not is_same_voucher(_item(amount=None), _item())  # type: ignore[arg-type]
        assert not is_same_voucher(_item(amount=0), _item())

    def test_different_amount_is_different(self):
        assert not is_same_voucher(_item(amount=1200), _item(amount=1500))

    def test_different_date_is_different(self):
        assert not is_same_voucher(_item(date="2025-04-02"), _item(date="2025-04-03"))


class TestSameFileDuplicateIndices:
    def test_second_and_third_are_duplicates(self):
        items = [_item(), _item(), _item()]
        assert same_file_duplicate_indices(items) == {1, 2}

    def test_different_times_are_not_duplicates(self):
        items = [_item(amount=20, time="17:32"), _item(amount=20, time="17:33")]
        assert same_file_duplicate_indices(items) == set()


# ── §5 同じファイルの中 ────────────────────────────────
class TestSameFileDuplicates:
    def test_second_and_third_rows_get_the_note_first_does_not(self):
        """D2: 同じファイルの重複は記帳し、2 枚目以降の O 列に注記する。"""
        manager, mocks = _make_manager()
        cb = _cb_mock()

        result = _run_text(manager, mocks, cb, [_item(), _item(), _item()])

        assert result.success == 3
        assert result.manual_entry == 0
        cb.reserve_rows.assert_called_once()
        assert cb.reserve_rows.call_args.kwargs["receipt_indices"] == [0, 1, 2]
        note_calls = cb.write_error_detail.call_args_list
        assert [call.args[0] for call in note_calls] == [101, 102]
        assert all(call.args[1] == SAME_FILE_DUPLICATE_NOTE for call in note_calls)
        mocks["drive"].rename_file_as_done.assert_called_once()

    def test_three_rows_with_different_times_have_no_note(self):
        manager, mocks = _make_manager()
        cb = _cb_mock()
        items = [
            _item(amount=20, time="17:32"),
            _item(amount=20, time="17:33"),
            _item(amount=20, time="17:34"),
        ]
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥20", engine="vision", confidence=0.9
        )

        result = _run_text(manager, mocks, cb, items)

        assert result.success == 3
        cb.write_error_detail.assert_not_called()

    def test_note_is_appended_to_existing_text_on_manual_row(self):
        manager, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )
        items = [_item(amount=41600), _item(amount=41600)]

        result = _run_text(manager, mocks, cb, items)

        assert result.manual_entry == 2
        second = cb.write_manual_entry_row.call_args_list[1]
        assert second.args[3].endswith(f"／{SAME_FILE_DUPLICATE_NOTE}")
        assert cb.write_error_detail.call_count == 0


# ── §6 別のファイル ───────────────────────────────────
class TestCrossFileDuplicates:
    def test_duplicate_is_not_written_and_gets_a_duplicate_record(self):
        manager, mocks = _make_manager()
        cb = _cb_mock()

        result = _run_text(manager, mocks, cb, [_item()], known=[_source(index=2)])

        assert result.success == 0
        assert result.skipped == 1
        cb.write_cashbook_row.assert_not_called()
        cb.reserve_rows.assert_not_called()
        record = cb.append_process_record.call_args[0][0]
        assert record.status == ProcessStatus.DUPLICATE.value
        assert record.duplicate_of == "src-1:2"
        assert record.details.date == "2025-04-02"
        assert record.details.amount == 1200
        mocks["drive"].rename_file_as_duplicate.assert_called_once()
        mocks["drive"].rename_file_as_done.assert_not_called()
        lines = mocks["drive"].append_description_lines.call_args[0][1]
        assert lines == [
            "重複: 1 枚目 → 重複元 元のレシート.jpg "
            "https://drive.google.com/file/d/src-1/view（3 枚目）"
        ]

    def test_partial_duplicate_books_the_rest_and_marks_done(self):
        manager, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,200 と ¥900", engine="vision", confidence=0.9
        )
        items = [_item(), _item(date="2025-04-03", amount=900)]

        result = _run_text(manager, mocks, cb, items, known=[_source()])

        assert result.success == 1
        assert result.skipped == 1
        cb.reserve_rows.assert_called_once_with(
            count=1,
            file_id="fid-1",
            file_name="receipt-1.jpg",
            receipt_indices=[1],
        )
        cb.write_cashbook_row.assert_called_once()
        mocks["drive"].rename_file_as_done.assert_called_once()
        mocks["drive"].rename_file_as_duplicate.assert_not_called()
        mocks["drive"].append_description_lines.assert_called_once()

    def test_later_file_in_same_run_is_duplicate(self):
        manager, mocks = _make_manager()
        cb = _cb_mock()
        known: list[ReceiptSource] = []

        first = _run_text(
            manager, mocks, cb, [_item()], known=known, file=_file("fid-1", "1枚目.jpg")
        )
        second = _run_text(
            manager, mocks, cb, [_item()], known=known, file=_file("fid-2", "2枚目.jpg")
        )

        assert first.success == 1
        assert second.success == 0
        assert second.skipped == 1
        record = cb.append_process_record.call_args[0][0]
        assert record.file_id == "fid-2"
        assert record.duplicate_of == "fid-1:0"
        mocks["drive"].rename_file_as_duplicate.assert_called_once()

    def test_records_of_the_same_file_id_are_not_sources(self):
        manager, mocks = _make_manager()
        cb = _cb_mock()

        result = _run_text(manager, mocks, cb, [_item()], known=[_source(file_id="fid-1")])

        assert result.success == 1
        cb.write_cashbook_row.assert_called_once()
        cb.append_process_record.assert_not_called()

    def test_rename_failure_does_not_roll_back_the_duplicate_record(self):
        manager, mocks = _make_manager()
        cb = _cb_mock()
        mocks["drive"].rename_file_as_duplicate.side_effect = RuntimeError("boom")

        result = _run_text(manager, mocks, cb, [_item()], known=[_source()])

        assert result.skipped == 1
        cb.append_process_record.assert_called_once()
        mocks["drive"].rename_file_as_duplicate.assert_called_once()

    def test_done_rename_failure_keeps_the_booking_and_the_description(self):
        manager, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,200 と ¥900", engine="vision", confidence=0.9
        )
        mocks["drive"].rename_file_as_done.side_effect = RuntimeError("boom")
        items = [_item(), _item(date="2025-04-03", amount=900)]

        result = _run_text(manager, mocks, cb, items, known=[_source()])

        assert result.success == 1
        assert result.skipped == 1
        cb.write_cashbook_row.assert_called_once()
        assert cb.append_process_record.call_count == 1
        mocks["drive"].append_description_lines.assert_called_once()


class TestProcessLogReading:
    def _client(self, rows: list[list]) -> CashbookClient:
        cb = CashbookClient.__new__(CashbookClient)
        cb._config = SheetsConfig()
        cb._spreadsheet_id = "dummy"
        cb._sheet_id_cache = {}
        cb._account_code_cache = {}
        sheets = MagicMock()
        sheets.values.return_value.get.return_value.execute.return_value = {"values": rows}
        cb._sheets = sheets
        return cb

    def _row(self, status: str, **overrides) -> list:
        row = [
            "f1",
            "元.jpg",
            0,
            "image/jpeg",
            "2025-04-02T10:00",
            status,
            10,
            "",
            "False",
            "folder",
            "rid",
            "2025-04-02",
            "",
            "1200",
            "テスト商店",
            "",
            "",
        ]
        positions = {
            "file_id": 0,
            "date": 11,
            "time": 12,
            "amount": 13,
            "vendor": 14,
            "receipt_no": 15,
        }
        for key, value in overrides.items():
            row[positions[key]] = value
        return row

    def test_new_columns_are_read(self):
        record = self._row("success")[:16]
        record[15] = "'0012"
        cb = self._client([PROCESS_LOG_HEADERS, record])

        candidates = cb.get_duplicate_candidates()

        assert len(candidates) == 1
        assert candidates[0].details.date == "2025-04-02"
        assert candidates[0].details.amount == 1200

    def test_row_without_receipt_no_is_still_a_source(self):
        # レシート番号が空だと表は A..O までしか返さないことがある
        record = self._row("success")[:15]
        cb = self._client([PROCESS_LOG_HEADERS, record])

        candidates = cb.get_duplicate_candidates()

        assert len(candidates) == 1
        assert candidates[0].details.receipt_no == ""

    def test_amount_may_be_read_back_as_a_number_or_with_commas(self):
        first = self._row("success", amount=1200)[:16]
        second = self._row("written", amount="1,200")[:16]
        second[0] = "f2"
        cb = self._client([PROCESS_LOG_HEADERS, first, second])

        candidates = cb.get_duplicate_candidates()

        assert [c.details.amount for c in candidates] == [1200, 1200]

    def test_old_records_without_new_columns_are_not_sources(self):
        old = self._row("success")[:11]
        cb = self._client([PROCESS_LOG_HEADERS, old])
        assert cb.get_duplicate_candidates() == []

    @pytest.mark.parametrize("status", ["error", "expired", "duplicate"])
    def test_not_booked_statuses_are_not_sources(self, status):
        cb = self._client([PROCESS_LOG_HEADERS, self._row(status)])
        assert cb.get_duplicate_candidates() == []

    def test_duplicate_counts_as_done(self):
        duplicate = self._row("duplicate")[:11]
        cb = self._client([PROCESS_LOG_HEADERS, duplicate])
        assert cb.get_processed_keys() == {"f1:0"}


# ── §6.4 処理管理の欄 ─────────────────────────────────
class TestProcessLogColumns:
    def _client(self, header: list) -> tuple[CashbookClient, MagicMock]:
        cb = CashbookClient.__new__(CashbookClient)
        cb._config = SheetsConfig()
        cb._spreadsheet_id = "dummy"
        cb._sheet_id_cache = {}
        cb._account_code_cache = {}
        sheets = MagicMock()
        sheets.get.return_value.execute.return_value = {
            "sheets": [{"properties": {"title": "処理管理"}}]
        }
        sheets.values.return_value.get.return_value.execute.return_value = (
            {"values": [header]} if header else {}
        )
        cb._sheets = sheets
        return cb, sheets

    def test_missing_header_is_appended(self):
        cb, sheets = self._client(PROCESS_LOG_HEADERS[:11])

        cb.ensure_log_sheets_exist()

        update = sheets.values.return_value.update
        update.assert_called_once()
        kwargs = update.call_args.kwargs
        assert kwargs["range"].endswith("!L1:Q1")
        assert kwargs["body"]["values"] == [
            ["receiptDate", "receiptTime", "amount", "vendor", "receiptNo", "duplicateOf"]
        ]

    def test_same_header_is_left_alone(self):
        cb, sheets = self._client(PROCESS_LOG_HEADERS)
        cb.ensure_log_sheets_exist()
        sheets.values.return_value.update.assert_not_called()

    def test_different_header_stops_without_writing(self):
        """D6: 見出しが違えば何も書かずに止まる。"""
        wrong = PROCESS_LOG_HEADERS[:]
        wrong[11] = "別の見出し"
        cb, sheets = self._client(wrong)

        with pytest.raises(ProcessLogHeaderError):
            cb.ensure_log_sheets_exist()

        sheets.values.return_value.update.assert_not_called()
        sheets.batchUpdate.assert_not_called()

    def test_empty_tab_gets_all_headers(self):
        cb, sheets = self._client([])
        cb.ensure_log_sheets_exist()
        calls = sheets.values.return_value.update.call_args_list
        process_calls = [call for call in calls if "'処理管理'!A1:Q1" in call.kwargs["range"]]
        assert len(process_calls) == 1
        assert process_calls[0].kwargs["body"]["values"] == [PROCESS_LOG_HEADERS]

    def test_d5_validate_does_not_write_headers(self):
        """D5: validate / dry_run では処理管理の見出しも書かない。"""
        cb, sheets = self._client([])
        cb.ensure_log_sheets_exist(write=False)
        sheets.values.return_value.update.assert_not_called()
        sheets.batchUpdate.assert_not_called()

    def test_append_uses_text_for_leading_zeros_time_and_amount(self):
        cb = CashbookClient.__new__(CashbookClient)
        cb._config = SheetsConfig()
        cb._spreadsheet_id = "dummy"
        cb._sheet_id_cache = {}
        cb._account_code_cache = {}
        sheets = MagicMock()
        cb._sheets = sheets

        cb.append_process_record(
            ProcessRecord(
                file_id="f1",
                file_name="a.jpg",
                receipt_index=0,
                status=ProcessStatus.DUPLICATE.value,
                details=ReceiptDetails(
                    date="2026-01-02",
                    time="9:05",
                    amount=1200,
                    vendor="テスト商店",
                    receipt_no="0012",
                ),
                duplicate_of="src:0",
            )
        )

        row = sheets.values.return_value.append.call_args.kwargs["body"]["values"][0]
        assert row[11:] == ["'2026-01-02", "'9:05", "'1200", "'テスト商店", "'0012", "'src:0"]

    def test_reserved_row_details_use_text_cells(self):
        cb = CashbookClient.__new__(CashbookClient)
        cb._config = SheetsConfig()
        cb._spreadsheet_id = "dummy"
        cb._sheet_id_cache = {}
        cb._account_code_cache = {}
        sheets = MagicMock()
        sheets.values.return_value.get.return_value.execute.return_value = {
            "values": [
                PROCESS_LOG_HEADERS,
                ["f1", "a.jpg", 0, "", "", "reserved", 10, "", "False", "", "rid-1"],
            ]
        }
        cb._sheets = sheets

        cb.write_receipt_details(
            [
                (
                    "rid-1",
                    ReceiptDetails(
                        date="2026-01-02",
                        time="9:05",
                        amount=1200,
                        vendor="テスト商店",
                        receipt_no="0012",
                    ),
                )
            ]
        )

        data = sheets.values.return_value.batchUpdate.call_args.kwargs["body"]["data"]
        sent = {item["range"]: item["values"] for item in data}
        assert sent["'処理管理'!L2"] == [["'2026-01-02"]]
        assert sent["'処理管理'!M2"] == [["'9:05"]]
        assert sent["'処理管理'!N2"] == [["'1200"]]
        assert sent["'処理管理'!O2"] == [["'テスト商店"]]
        assert sent["'処理管理'!P2"] == [["'0012"]]


# ── 安全の条件 ─────────────────────────────────────────
class TestSafety:
    def test_d1_unreadable_date_is_booked_not_duplicate(self):
        manager, mocks = _make_manager()
        cb = _cb_mock()

        result = _run_text(
            manager,
            mocks,
            cb,
            [_item(date="読めない")],
            known=[_source()],
        )

        assert result.success == 1
        cb.write_cashbook_row.assert_called_once()
        cb.append_process_record.assert_not_called()

    def test_d1_unreadable_amount_is_booked_not_duplicate(self):
        manager, mocks = _make_manager()
        cb = _cb_mock()

        _run_text(
            manager,
            mocks,
            cb,
            [_item(amount=None)],  # type: ignore[arg-type]
            known=[_source()],
        )

        cb.append_process_record.assert_not_called()
        assert cb.write_cashbook_row.called or cb.write_manual_entry_row.called

    def test_d3_duplicate_item_is_neither_booked_nor_reserved(self):
        manager, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,200 と ¥900", engine="vision", confidence=0.9
        )
        items = [_item(), _item(date="2025-04-03", amount=900)]

        _run_text(manager, mocks, cb, items, known=[_source()])

        assert cb.reserve_rows.call_args.kwargs["count"] == 1
        written = [call.args[1].amount for call in cb.write_cashbook_row.call_args_list]
        assert written == [900]

    def test_d4_duplicate_prefix_is_excluded_and_duplicate_is_done(self):
        assert "【重複】" in DriveConfig().excluded_file_name_prefixes
        assert "【重複】" in DriveClient._ALREADY_DONE_PREFIXES
        assert ProcessStatus.DUPLICATE.value in _DONE_STATUSES

    def test_d6_customer_stops_before_master_status_when_header_is_wrong(self, monkeypatch):
        manager, mocks = _make_manager()
        fake_cb = MagicMock()
        fake_cb.ensure_log_sheets_exist.side_effect = ProcessLogHeaderError(
            ["receiptDate"], ["別の見出し"]
        )
        monkeypatch.setattr("src.processing.manager.CashbookClient", lambda **kwargs: fake_cb)
        cust = CustomerRow(
            row_number=2,
            customer_name="テスト顧客",
            entry_type="当方記帳",
            folder_url="https://drive.google.com/drive/folders/FOLDER1",
            sheet_url="https://docs.google.com/spreadsheets/d/SHEET1/edit",
        )

        with pytest.raises(ProcessLogHeaderError):
            manager._process_customer(cust)

        mocks["master"].update_customer_status.assert_not_called()

    def test_d5_validate_does_not_cleanup_or_recover(self, monkeypatch):
        manager, mocks = _make_manager(dry_run=True)
        fake_cb = MagicMock()
        monkeypatch.setattr("src.processing.manager.CashbookClient", lambda **kwargs: fake_cb)
        mocks["drive"].list_files.return_value = []
        cust = CustomerRow(
            row_number=2,
            customer_name="テスト顧客",
            entry_type="当方記帳",
            folder_url="https://drive.google.com/drive/folders/FOLDER1",
            sheet_url="https://docs.google.com/spreadsheets/d/SHEET1/edit",
        )

        manager._process_customer(cust)

        fake_cb.cleanup_stale_reservations.assert_not_called()
        fake_cb.recover_stale_written.assert_not_called()
        fake_cb.reserve_rows.assert_not_called()
        fake_cb.append_process_record.assert_not_called()
        fake_cb.write_receipt_details.assert_not_called()

    def test_d5_dry_run_writes_nothing_but_logs_the_decision(self, monkeypatch):
        manager, mocks = _make_manager(dry_run=True)
        cb = _cb_mock()
        logged: list[str] = []
        monkeypatch.setattr(
            "src.processing.manager.logger.info",
            lambda message, **kwargs: logged.append(str(message)),
        )

        result = _run_text(manager, mocks, cb, [_item()], known=[_source()])

        assert result.skipped == 1
        cb.reserve_rows.assert_not_called()
        cb.write_cashbook_row.assert_not_called()
        cb.append_process_record.assert_not_called()
        cb.write_receipt_details.assert_not_called()
        mocks["drive"].rename_file_as_duplicate.assert_not_called()
        mocks["drive"].rename_file_as_done.assert_not_called()
        mocks["drive"].append_description_lines.assert_not_called()
        assert any("重複（別のファイル）" in message for message in logged)

    def test_d7_v1_prompt_and_text_first_call_order_are_unchanged(self):
        from tests.test_prompts import V1_SYSTEM_INSTRUCTION

        assert prompts.system_instruction("v1") == V1_SYSTEM_INSTRUCTION

        manager, mocks = _make_manager(flow="text_first")
        cb = _cb_mock()
        calls: list[str] = []

        def text(_ocr, _name):
            calls.append("text")
            return [_item()]

        mocks["ai"].extract_receipt_data.side_effect = text
        manager._process_file(_file(), cb, set(), "2025-04-02", "2025-04-02T10:00")

        assert calls == ["text"]
        mocks["ai"].extract_from_file.assert_not_called()

    def test_d8_compare_mode_does_not_create_processing_managers(self, monkeypatch):
        for name in ("RUN_MODE", "TARGET_SCOPE", "TARGET_ROW"):
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("RUN_MODE", "compare")
        monkeypatch.delenv("MASTER_SPREADSHEET_ID", raising=False)
        run_compare = MagicMock(return_value=0)
        managers = MagicMock()
        monkeypatch.setattr(main_module, "run_compare", run_compare)
        monkeypatch.setattr(main_module, "ProcessingManager", managers)

        assert main_module.main() == 0
        run_compare.assert_called_once()
        managers.assert_not_called()

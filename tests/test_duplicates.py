"""重複したレシートの見分け（仕様 `docs/spec_duplicates.md`）のテスト。

API・Drive・Sheets はすべて偽物。データは架空のものだけを使う。
"""

import re
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from googleapiclient.errors import HttpError

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
    AI_LOG_HEADERS,
    PROCESS_LOG_HEADERS,
    CashbookClient,
    ProcessLogHeaderError,
)

OCR_TEXT = "合計 ¥1,200"


def _http_error(status: int) -> HttpError:
    """Sheets API の HttpError を模す（429 など）。"""
    resp = SimpleNamespace(status=status, reason="Too Many Requests")
    return HttpError(resp, b"{}")


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


def _run_dual(
    manager,
    mocks,
    cb,
    image_items,
    text_items=None,
    *,
    known=None,
    processed_keys=None,
    file=None,
    ocr_text=OCR_TEXT,
):
    mocks["ai"].extract_from_file.return_value = image_items
    mocks["ai"].extract_receipt_data.return_value = (
        image_items if text_items is None else text_items
    )
    mocks["ocr"].extract_text.return_value = OcrResult(
        raw_text=ocr_text, engine="vision", confidence=0.9
    )
    return manager._process_file(
        file or _file(),
        cb,
        processed_keys or set(),
        "2025-04-02",
        "2025-04-02T10:00",
        known_receipts=known,
    )


# ── 偽の Sheets（出納帳・処理管理・AI詳細ログ） ─────────────
_CELL_RE = re.compile(r"^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$")


def _col_index(letters: str) -> int:
    value = 0
    for char in letters:
        value = value * 26 + (ord(char) - 64)
    return value - 1


def _split_range(range_text: str) -> tuple[str, str]:
    title, _, cells = range_text.partition("!")
    return title.strip("'"), cells


class _Exec:
    def __init__(self, result=None):
        self._result = result if result is not None else {}

    def execute(self):
        return self._result


class _FakeSheetService:
    """CashbookClient が使う範囲だけを真似る、メモリ上の表。"""

    def __init__(self):
        self.tabs: dict[str, list[list]] = {
            "入力用": [[] for _ in range(4)],
            "処理管理": [list(PROCESS_LOG_HEADERS)],
            "AI詳細ログ": [list(AI_LOG_HEADERS)],
        }

    def spreadsheets(self):
        return self

    def values(self):
        return self

    def get(self, **kwargs):
        if "range" in kwargs:
            return _Exec({"values": self._read(kwargs["range"])})
        return _Exec(
            {
                "sheets": [
                    {"properties": {"title": title, "sheetId": index}}
                    for index, title in enumerate(self.tabs)
                ]
            }
        )

    def append(self, **kwargs):
        title, _ = _split_range(kwargs["range"])
        self.tabs.setdefault(title, []).extend([list(row) for row in kwargs["body"]["values"]])
        return _Exec()

    def update(self, **kwargs):
        title, cells = _split_range(kwargs["range"])
        self._write(title, cells, kwargs["body"]["values"])
        return _Exec()

    def batchUpdate(self, **kwargs):  # noqa: N802 - Google Sheets API の名前
        body = kwargs["body"]
        for item in body.get("data", []):
            title, cells = _split_range(item["range"])
            self._write(title, cells, item["values"])
        return _Exec()

    def _read(self, range_text: str) -> list[list]:
        title, cells = _split_range(range_text)
        rows = self.tabs.get(title, [])
        if not cells:
            return [list(row) for row in rows]
        match = _CELL_RE.match(cells)
        assert match, cells
        start_col = _col_index(match.group(1))
        start_row = int(match.group(2)) - 1 if match.group(2) else None
        end_col = _col_index(match.group(3) or match.group(1))
        end_row = int(match.group(4)) - 1 if match.group(4) else None
        selected = (
            rows
            if start_row is None
            else rows[start_row : (end_row + 1 if end_row is not None else None)]
        )
        return [list(row[start_col : end_col + 1]) for row in selected]

    def _write(self, title: str, cells: str, values: list[list]) -> None:
        match = _CELL_RE.match(cells)
        assert match, cells
        start_col = _col_index(match.group(1))
        start_row = int(match.group(2)) - 1 if match.group(2) else 0
        tab = self.tabs.setdefault(title, [])
        for offset, row in enumerate(values):
            row_index = start_row + offset
            while len(tab) <= row_index:
                tab.append([])
            target = tab[row_index]
            while len(target) < start_col + len(row):
                target.append("")
            for index, value in enumerate(row):
                target[start_col + index] = value


def _real_cashbook(service: _FakeSheetService) -> CashbookClient:
    cb = CashbookClient.__new__(CashbookClient)
    cb._config = SheetsConfig()
    cb._spreadsheet_id = "sheet-1"
    cb._sheet_id_cache = {}
    cb._account_code_cache = {}
    cb._sheets = service
    return cb


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
        # 時は 0〜29（深夜の営業日の書き方。仕様 §11.2）
        assert normalize_time("25:00") == "25:00"
        assert is_same_voucher(_item(time="9:05"), _item(time="09:05"))

    def test_time_normalization_of_seconds_and_japanese_forms(self):
        assert normalize_time("10:05:12") == "10:05"
        assert normalize_time("17時32分") == "17:32"
        assert normalize_time("17時") == "17:00"
        assert normalize_time("午後3:40") == "15:40"
        assert normalize_time("PM 3:40") == "15:40"
        assert normalize_time("午前9:05") == "09:05"
        assert is_same_voucher(_item(time="17時32分"), _item(time="17:32"))
        assert is_same_voucher(_item(time="午後3:40"), _item(time="15:40"))
        assert is_same_voucher(_item(time="9:05"), _item(time="09:05:30"))

    def test_unreadable_raw_times_are_compared_as_text(self):
        assert not is_same_voucher(_item(time="abc"), _item(time="xyz"))
        assert is_same_voucher(_item(time="abc"), _item(time="ａｂｃ"))
        assert not is_same_voucher(_item(time="10:05:12"), _item(time="15:40:01"))
        assert not is_same_voucher(_item(time="25:10"), _item(time="26:40"))

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
        # 注記は出納帳の行を書く同じ 1 回（write_cashbook_row）に入る（§11.4）
        notes = [call.kwargs["error_detail"] for call in cb.write_cashbook_row.call_args_list]
        assert notes == [None, SAME_FILE_DUPLICATE_NOTE, SAME_FILE_DUPLICATE_NOTE]
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
        assert all(
            call.kwargs["error_detail"] is None for call in cb.write_cashbook_row.call_args_list
        )

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
        cb.reserve_rows.assert_called_once()
        reserved = cb.reserve_rows.call_args.kwargs
        assert reserved["count"] == 1
        assert reserved["receipt_indices"] == [1]
        # 予約の追記に入るのは、記帳する明細（番号 1）の値（§11.4）
        assert reserved["details"][1].amount == 900
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

    def test_failed_duplicate_record_skips_duplicate_rename_and_description(self):
        """§11.6: 記録が 1 件でも書けなければ、【重複】も説明欄も付けない。"""
        manager, mocks = _make_manager()
        cb = _cb_mock()
        cb.append_process_record.side_effect = RuntimeError("429")

        result = _run_text(manager, mocks, cb, [_item()], known=[_source()])

        assert result.errors == 1
        assert result.skipped == 1
        cb.reserve_rows.assert_not_called()
        cb.write_cashbook_row.assert_not_called()
        mocks["drive"].rename_file_as_duplicate.assert_not_called()
        mocks["drive"].append_description_lines.assert_not_called()

    def test_failed_duplicate_record_skips_only_its_own_description_line(self):
        """§11.6: 一部が重複のときは、書けた明細の説明だけを足す。"""
        manager, mocks = _make_manager()
        cb = _cb_mock()
        items = [
            _item(),
            _item(date="2025-04-03", amount=900),
            _item(date="2025-04-04", amount=500),
        ]
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,200 と ¥900 と ¥500", engine="vision", confidence=0.9
        )
        cb.append_process_record.side_effect = [None, RuntimeError("429")]

        result = _run_text(
            manager,
            mocks,
            cb,
            items,
            known=[
                _source(),
                _source(index=1, date="2025-04-03", amount=900),
            ],
        )

        assert result.errors == 1
        assert result.success == 1
        lines = mocks["drive"].append_description_lines.call_args[0][1]
        assert lines == [
            "重複: 1 枚目 → 重複元 元のレシート.jpg "
            "https://drive.google.com/file/d/src-1/view（1 枚目）"
        ]

    def test_early_return_does_not_rename_when_only_some_items_are_duplicates(self):
        """全部が重複でないのに、【重複】を付けない（早期 return の条件）。"""
        manager, mocks = _make_manager()
        cb = _cb_mock()
        items = [_item(), _item(date="2025-04-03", amount=900)]
        mocks["ai"].extract_receipt_data.return_value = items

        # 番号 0 は前の回に済み。残りの番号 1 だけが別のファイルと同じ。
        result = manager._process_file(
            _file(),
            cb,
            {"fid-1:0"},
            "2025-04-02",
            "2025-04-02T10:00",
            known_receipts=[_source(date="2025-04-03", amount=900)],
        )

        assert result.skipped == 2
        cb.reserve_rows.assert_not_called()
        mocks["drive"].rename_file_as_duplicate.assert_not_called()

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
    def _client(self, rows: list[list], *, tab_exists: bool = True) -> CashbookClient:
        cb = CashbookClient.__new__(CashbookClient)
        cb._config = SheetsConfig()
        cb._spreadsheet_id = "dummy"
        cb._sheet_id_cache = {}
        cb._account_code_cache = {}
        sheets = MagicMock()
        sheets.get.return_value.execute.return_value = {
            "sheets": [{"properties": {"title": "処理管理"}}] if tab_exists else []
        }
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

    def test_reserved_is_a_source(self):
        """予約中の明細も照らす相手にする（§6.1）。"""
        cb = self._client([PROCESS_LOG_HEADERS, self._row("reserved")])
        candidates = cb.get_duplicate_candidates()
        assert len(candidates) == 1
        assert candidates[0].status == "reserved"

    def test_429_while_reading_is_raised_not_treated_as_empty(self):
        """§11.5: タブがあるのに読めないときは例外にして顧客を止める。"""
        cb = self._client([PROCESS_LOG_HEADERS])
        cb._sheets.values.return_value.get.side_effect = _http_error(429)

        with pytest.raises(HttpError):
            cb.get_processed_keys()
        with pytest.raises(HttpError):
            cb.get_duplicate_candidates()

    def test_missing_tab_returns_empty_without_reading_rows(self):
        """§11.5: タブが無い（dry_run の新しい出納帳）ときだけ空。"""
        cb = self._client([], tab_exists=False)

        assert cb.get_processed_keys() == set()
        assert cb.get_duplicate_candidates() == []
        cb._sheets.values.return_value.get.assert_not_called()


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

    def test_reservation_append_writes_details_in_the_same_a_to_q_row(self):
        cb = CashbookClient.__new__(CashbookClient)
        cb._config = SheetsConfig()
        cb._spreadsheet_id = "dummy"
        cb._sheet_id_cache = {}
        cb._account_code_cache = {}
        sheets = MagicMock()
        cb._sheets = sheets
        cb.find_available_rows = lambda count: [10, 11]
        cb.get_active_reservations = lambda: {}
        cb._get_occupied_rows = lambda: set()

        cb.reserve_rows(
            count=2,
            file_id="f1",
            file_name="a.jpg",
            receipt_indices=[1, 3],
            details={
                1: ReceiptDetails(
                    date="2026-01-02",
                    time="9:05",
                    amount=1200,
                    vendor="テスト商店",
                    receipt_no="0012",
                ),
                3: ReceiptDetails(date="2026-01-03", amount=800, vendor="別店", receipt_no=""),
            },
        )

        calls = sheets.values.return_value.append.call_args_list
        assert [call.kwargs["range"] for call in calls] == ["'処理管理'!A:Q", "'処理管理'!A:Q"]
        first = calls[0].kwargs["body"]["values"][0]
        second = calls[1].kwargs["body"]["values"][0]
        assert first[11:16] == ["'2026-01-02", "'9:05", "'1200", "'テスト商店", "'0012"]
        assert second[2] == 3
        assert second[11:16] == ["'2026-01-03", "", "'800", "'別店", ""]

    def test_reservation_without_details_leaves_l_to_p_empty(self):
        cb = CashbookClient.__new__(CashbookClient)
        cb._config = SheetsConfig()
        cb._spreadsheet_id = "dummy"
        cb._sheet_id_cache = {}
        cb._account_code_cache = {}
        sheets = MagicMock()
        cb._sheets = sheets
        cb.find_available_rows = lambda count: [10]
        cb.get_active_reservations = lambda: {}
        cb._get_occupied_rows = lambda: set()

        cb.reserve_rows(count=1, file_id="f1", file_name="a.jpg", receipt_indices=[0])

        call = sheets.values.return_value.append.call_args
        row = call.kwargs["body"]["values"][0]
        assert row[2] == 0
        assert row[11:] == [] or not any(row[11:])


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
        fake_cb.ensure_log_sheets_exist.assert_called_once_with(write=False)

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


# ── §5・§6 を両読みでも確かめる（§11.11） ─────────────────
class TestDualSameFile:
    def test_note_on_normal_row(self):
        manager, mocks = _make_manager(flow="dual")
        cb = _cb_mock()

        result = _run_dual(manager, mocks, cb, [_item(), _item()])

        assert result.success == 2
        notes = [call.kwargs["error_detail"] for call in cb.write_cashbook_row.call_args_list]
        assert notes == [None, SAME_FILE_DUPLICATE_NOTE]

    def test_note_on_review_row(self):
        manager, mocks = _make_manager(flow="dual")
        cb = _cb_mock()

        result = _run_dual(manager, mocks, cb, [_item(), _item()], [_item()])

        assert result.success == 1
        assert result.manual_entry == 1
        message = cb.write_manual_entry_row.call_args.args[3]
        assert message.endswith(f"／{SAME_FILE_DUPLICATE_NOTE}")


class TestDualCrossFile:
    def test_all_duplicate_is_not_booked_and_gets_the_duplicate_mark(self):
        manager, mocks = _make_manager(flow="dual")
        cb = _cb_mock()

        result = _run_dual(manager, mocks, cb, [_item()], known=[_source(index=2)])

        assert result.success == 0
        assert result.skipped == 1
        cb.write_cashbook_row.assert_not_called()
        cb.reserve_rows.assert_not_called()
        record = cb.append_process_record.call_args[0][0]
        assert record.status == ProcessStatus.DUPLICATE.value
        assert record.duplicate_of == "src-1:2"
        assert record.details.amount == 1200
        mocks["drive"].rename_file_as_duplicate.assert_called_once()
        mocks["drive"].rename_file_as_done.assert_not_called()
        lines = mocks["drive"].append_description_lines.call_args[0][1]
        assert lines == [
            "重複: 1 枚目 → 重複元 元のレシート.jpg "
            "https://drive.google.com/file/d/src-1/view（3 枚目）"
        ]

    def test_partial_duplicate_books_the_rest_and_marks_done(self):
        manager, mocks = _make_manager(flow="dual")
        cb = _cb_mock()
        items = [_item(), _item(date="2025-04-03", amount=900)]

        result = _run_dual(
            manager,
            mocks,
            cb,
            items,
            known=[_source()],
            ocr_text="合計 ¥1,200 と ¥900",
        )

        assert result.success == 1
        assert result.skipped == 1
        reserved = cb.reserve_rows.call_args.kwargs
        assert reserved["count"] == 1
        assert reserved["receipt_indices"] == [1]
        assert reserved["details"][1].amount == 900
        cb.write_cashbook_row.assert_called_once()
        mocks["drive"].rename_file_as_done.assert_called_once()
        mocks["drive"].rename_file_as_duplicate.assert_not_called()
        mocks["drive"].append_description_lines.assert_called_once()

    def test_d1_unreadable_amount_is_not_duplicate(self):
        manager, mocks = _make_manager(flow="dual")
        cb = _cb_mock()
        item = _item(amount=None)  # type: ignore[arg-type]

        result = _run_dual(manager, mocks, cb, [item], known=[_source()])

        assert result.success == 0
        assert result.manual_entry == 1
        cb.append_process_record.assert_not_called()

    def test_d3_duplicate_item_is_neither_booked_nor_reserved(self):
        manager, mocks = _make_manager(flow="dual")
        cb = _cb_mock()
        items = [_item(), _item(date="2025-04-03", amount=900)]

        _run_dual(
            manager,
            mocks,
            cb,
            items,
            known=[_source()],
            ocr_text="合計 ¥1,200 と ¥900",
        )

        reserved = cb.reserve_rows.call_args.kwargs
        assert reserved["receipt_indices"] == [1]
        booked = [call.args[1].amount for call in cb.write_cashbook_row.call_args_list]
        assert booked == [900]

    def test_d5_dry_run_writes_nothing_and_does_not_count_duplicates_as_booked(self, monkeypatch):
        manager, mocks = _make_manager(flow="dual", dry_run=True)
        cb = _cb_mock()
        logged: list[str] = []
        monkeypatch.setattr(
            "src.processing.manager.logger.info",
            lambda message, **kwargs: logged.append(str(message)),
        )

        result = _run_dual(manager, mocks, cb, [_item()], known=[_source()])

        assert result.skipped == 1
        assert result.success == 0
        assert result.manual_entry == 0
        cb.reserve_rows.assert_not_called()
        cb.write_cashbook_row.assert_not_called()
        cb.append_process_record.assert_not_called()
        mocks["drive"].rename_file_as_duplicate.assert_not_called()
        mocks["drive"].rename_file_as_done.assert_not_called()
        mocks["drive"].append_description_lines.assert_not_called()
        assert any("重複（別のファイル）" in message for message in logged)


class TestDualDetails:
    def test_details_use_only_the_paired_text_item_for_time_and_number(self):
        """§11.1: 並びの位置で文字からの明細を借りない（監査 H1）。"""
        manager, mocks = _make_manager(flow="dual")
        cb = _cb_mock()
        p = _item(amount=500, time="10:00")
        q = ReceiptItem(
            date="2026-01-02",
            amount=None,
            time=None,
            vendor="テスト商店",
            description="テスト品",
            account="消耗品費",
            tax_category="課税仕入10%",
            confidence=0.9,
        )
        text_q = _item(amount=800, time="15:00")
        text_p = _item(amount=500, time="10:00")

        result = _run_dual(
            manager,
            mocks,
            cb,
            [p, q],
            [text_q, text_p],
            known=[_source(file_id="booked", amount=500, time="10:00")],
        )

        assert result.skipped == 1
        assert result.manual_entry == 1
        reserved = cb.reserve_rows.call_args.kwargs
        assert reserved["receipt_indices"] == [1]
        assert reserved["details"][1].amount is None
        assert reserved["details"][1].date == "2026-01-02"
        # 組にならなかった明細は画像からの値だけ（並びの位置で文字からを借りない）
        assert reserved["details"][1].time == ""
        mocks["drive"].rename_file_as_duplicate.assert_not_called()

    def test_paired_item_fills_only_empty_time_and_number_from_text(self):
        manager, mocks = _make_manager(flow="dual")
        cb = _cb_mock()
        image = _item(time=None, receipt_no=None)
        text = _item(time="15:00", receipt_no="0012", vendor="別の店名")

        result = _run_dual(manager, mocks, cb, [image], [text])

        assert result.success == 1
        details = cb.reserve_rows.call_args.kwargs["details"][0]
        assert details.date == "2025-04-02"
        assert details.amount == 1200
        # 日付・金額・店名は画像からの値だけ
        assert details.vendor == "テスト商店"
        # 空の time・receipt_no だけ文字からで埋める
        assert details.time == "15:00"
        assert details.receipt_no == "0012"


class TestDualReread:
    def test_cross_file_duplicate_is_not_excluded_when_the_file_has_marks(self):
        """§11.3: 前の回の印があるファイルでは、別のファイルとの重複で外さない。"""
        manager, mocks = _make_manager(flow="dual")
        cb = _cb_mock()
        first = _item()
        second = _item(date="2025-04-03", amount=900)

        result = _run_dual(
            manager,
            mocks,
            cb,
            [first, second],
            processed_keys={"F2:0"},
            known=[_source(index=4, date="2025-04-03", amount=900)],
            file=_file("F2", "2枚目.jpg"),
        )

        assert result.skipped == 1
        assert result.manual_entry == 1
        assert result.success == 0
        reserved = cb.reserve_rows.call_args.kwargs
        assert reserved["receipt_indices"] == [1]
        message = cb.write_manual_entry_row.call_args.args[3]
        assert message.endswith(
            "／別のファイルに同じ内容の明細があります（重複元 元のレシート.jpg 5 枚目）"
        )
        cb.append_process_record.assert_not_called()
        mocks["drive"].rename_file_as_duplicate.assert_not_called()
        mocks["drive"].append_description_lines.assert_not_called()

    def test_failed_duplicate_record_skips_duplicate_rename_and_description(self):
        """§11.6: 記録が書けなければ、【重複】も説明欄も付けない（両読み）。"""
        manager, mocks = _make_manager(flow="dual")
        cb = _cb_mock()
        cb.append_process_record.side_effect = RuntimeError("429")

        result = _run_dual(manager, mocks, cb, [_item()], known=[_source()])

        assert result.errors == 1
        assert result.skipped == 1
        cb.reserve_rows.assert_not_called()
        cb.write_cashbook_row.assert_not_called()
        mocks["drive"].rename_file_as_duplicate.assert_not_called()
        mocks["drive"].append_description_lines.assert_not_called()


# ── 顧客単位・通しの動き（§11.4・§11.5・§11.11） ───────────
def _customer() -> CustomerRow:
    return CustomerRow(
        row_number=2,
        customer_name="テスト顧客",
        entry_type="当方記帳",
        folder_url="https://drive.google.com/drive/folders/FOLDER1",
        sheet_url="https://docs.google.com/spreadsheets/d/SHEET1/edit",
    )


class TestCustomerLevel:
    def test_later_file_in_the_same_run_is_duplicate(self, monkeypatch):
        """同じ実行で先に記帳した明細も照らす相手にする（§6.1）。"""
        manager, mocks = _make_manager(flow="text_first")
        fake_cb = MagicMock()
        fake_cb.get_processed_keys.return_value = set()
        fake_cb.get_duplicate_candidates.return_value = []
        fake_cb.reserve_rows.side_effect = lambda **kwargs: [
            (100 + i, f"rid-{i}") for i in range(kwargs["count"])
        ]
        monkeypatch.setattr("src.processing.manager.CashbookClient", lambda **kwargs: fake_cb)
        mocks["drive"].list_files.return_value = [
            _file("fid-1", "1枚目.jpg"),
            _file("fid-2", "2枚目.jpg"),
        ]
        mocks["ai"].extract_receipt_data.return_value = [_item()]

        manager._process_customer(_customer())

        records = [call.args[0] for call in fake_cb.append_process_record.call_args_list]
        assert any(
            record.status == ProcessStatus.DUPLICATE.value and record.file_id == "fid-2"
            for record in records
        )
        assert fake_cb.write_cashbook_row.call_count == 1

    def test_process_log_history_is_used_at_customer_start(self, monkeypatch):
        """前の回の処理管理（照らす相手）を、顧客の始めに読む（§6.1）。"""
        manager, mocks = _make_manager(flow="text_first")
        fake_cb = MagicMock()
        fake_cb.get_processed_keys.return_value = set()
        fake_cb.get_duplicate_candidates.return_value = [
            ProcessRecord(
                file_id="F0",
                file_name="前の回.jpg",
                receipt_index=0,
                status=ProcessStatus.SUCCESS.value,
                details=ReceiptDetails(date="2025-04-02", amount=1200, vendor="テスト商店"),
            )
        ]
        monkeypatch.setattr("src.processing.manager.CashbookClient", lambda **kwargs: fake_cb)
        mocks["drive"].list_files.return_value = [_file()]
        mocks["ai"].extract_receipt_data.return_value = [_item()]

        manager._process_customer(_customer())

        records = [call.args[0] for call in fake_cb.append_process_record.call_args_list]
        assert any(
            record.status == ProcessStatus.DUPLICATE.value and record.file_id == "fid-1"
            for record in records
        )
        fake_cb.write_cashbook_row.assert_not_called()

    def test_429_on_processed_keys_stops_the_customer(self, monkeypatch):
        """§11.5: 処理管理が読めないときは顧客を止め、何も記帳しない。"""
        manager, mocks = _make_manager(flow="text_first")
        fake_cb = MagicMock()
        fake_cb.get_processed_keys.side_effect = _http_error(429)
        monkeypatch.setattr("src.processing.manager.CashbookClient", lambda **kwargs: fake_cb)
        mocks["drive"].list_files.return_value = [_file()]
        mocks["master"].read_customer_rows.return_value = [_customer()]

        summary = manager.run()

        assert summary["error_customers"] == 1
        fake_cb.reserve_rows.assert_not_called()
        fake_cb.write_cashbook_row.assert_not_called()
        statuses = [call.args[1] for call in mocks["master"].update_customer_status.call_args_list]
        assert any(str(status).startswith("エラー:") for status in statuses)

    def test_error_item_is_not_added_as_a_source_for_a_later_file(self):
        """失敗した明細（error）は、同じ実行の後のファイルの照らす相手にしない。"""
        manager, mocks = _make_manager(flow="text_first")
        failing_cb = _cb_mock()
        failing_cb.write_cashbook_row.side_effect = RuntimeError("boom")
        failing_cb.write_manual_entry_row.side_effect = RuntimeError("boom again")
        known: list[ReceiptSource] = []

        first = _run_text(
            manager,
            mocks,
            failing_cb,
            [_item()],
            known=known,
            file=_file("fid-1", "1枚目.jpg"),
        )
        second = _run_text(
            manager, mocks, _cb_mock(), [_item()], known=known, file=_file("fid-2", "2枚目.jpg")
        )

        assert first.errors == 1
        assert second.success == 1

    def test_text_first_amount_retry_is_not_called_for_an_all_duplicate_file(self):
        """§11.7: 全部が重複なら、金額 NG でも AI を呼び直さない。"""
        manager, mocks = _make_manager(flow="text_first")
        cb = _cb_mock()
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )

        result = _run_text(
            manager,
            mocks,
            cb,
            [_item(amount=41600)],
            known=[_source(amount=41600)],
        )

        assert result.skipped == 1
        mocks["ai"].extract_from_file.assert_not_called()

    def test_text_first_amount_retry_ignores_a_duplicate_amount_ng_item(self):
        """§11.7: 重複で外す明細が金額 NG でも、記帳する明細が正常なら呼ばない。"""
        manager, mocks = _make_manager(flow="text_first")
        cb = _cb_mock()
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600 と ¥1,200", engine="vision", confidence=0.9
        )
        items = [_item(amount=41600), _item(date="2025-04-03", amount=1200)]
        mocks["ai"].extract_receipt_data.return_value = items

        result = manager._process_file(
            _file(),
            cb,
            set(),
            "2025-04-02",
            "2025-04-02T10:00",
            known_receipts=[_source(amount=41600)],
        )

        assert result.skipped == 1
        assert result.success == 1
        mocks["ai"].extract_from_file.assert_not_called()

    def test_text_first_amount_retry_is_called_for_a_bookable_amount_ng_item(self):
        """§11.7: 記帳する明細に金額 NG があれば、今までどおり 1 回だけ呼ぶ。"""
        manager, mocks = _make_manager(flow="text_first")
        cb = _cb_mock()
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )
        mocks["ai"].extract_receipt_data.return_value = [_item(amount=41600)]
        mocks["ai"].extract_from_file.return_value = []

        manager._process_file(
            _file(),
            cb,
            set(),
            "2025-04-02",
            "2025-04-02T10:00",
            known_receipts=[_source(date="2025-04-03")],
        )

        mocks["ai"].extract_from_file.assert_called_once()


class TestRoundTrip:
    def test_second_run_reads_the_written_details_and_finds_the_duplicate(self):
        service = _FakeSheetService()
        first_manager, first_mocks = _make_manager(flow="dual")
        first_cb = _real_cashbook(service)
        first_mocks["ai"].extract_from_file.return_value = [_item()]
        first_mocks["ai"].extract_receipt_data.return_value = [_item()]

        first = first_manager._process_file(
            _file("F1", "1枚目.jpg"), first_cb, set(), "2025-04-02", "2025-04-02T10:00"
        )
        assert first.success == 1

        log = service.tabs["処理管理"]
        written = next(row for row in log[1:] if row[5] == "success")
        assert written[11:16] == ["'2025-04-02", "", "'1200", "'テスト商店", ""]

        second_manager, second_mocks = _make_manager(flow="dual")
        second_cb = _real_cashbook(service)
        processed_keys = second_cb.get_processed_keys()
        known = second_manager._load_duplicate_sources(second_cb)
        assert processed_keys == {"F1:0"}
        assert [source.amount for source in known] == [1200]

        second_mocks["ai"].extract_from_file.return_value = [_item()]
        second_mocks["ai"].extract_receipt_data.return_value = [_item()]
        second_mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text=OCR_TEXT, engine="vision", confidence=0.9
        )
        second = second_manager._process_file(
            _file("F2", "2枚目.jpg"),
            second_cb,
            processed_keys,
            "2025-04-02",
            "2025-04-02T10:00",
            known_receipts=known,
        )

        assert second.skipped == 1
        assert second.success == 0
        duplicates = [row for row in service.tabs["処理管理"][1:] if row[0] == "F2"]
        assert len(duplicates) == 1
        assert duplicates[0][5] == ProcessStatus.DUPLICATE.value
        assert duplicates[0][16] == "'F1:0"
        assert second_mocks["drive"].rename_file_as_duplicate.called
        assert all("F2" not in str(row[0]) for row in service.tabs["入力用"] if row)

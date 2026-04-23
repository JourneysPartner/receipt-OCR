"""Sheets クライアントのテスト"""

from unittest.mock import MagicMock

from src.config import SheetsConfig
from src.models import ProcessStatus
from src.sheets.client import (
    _BLOCKING_STATUSES,
    _DONE_STATUSES,
    _PL_CASHBOOK_ROW,
    _PL_FILE_ID,
    _PL_RECEIPT_INDEX,
    _PL_RESERVATION_ID,
    _PL_STATUS,
    PROCESS_LOG_HEADERS,
    CashbookClient,
    _col_letter,
)


def _make_client(config: SheetsConfig | None = None) -> tuple[CashbookClient, MagicMock]:
    """API を叩かないモック化された CashbookClient を作る。
    戻り値: (client, mock_values_batchUpdate)
    """
    cb = CashbookClient.__new__(CashbookClient)
    cb._config = config or SheetsConfig()
    cb._spreadsheet_id = "dummy"
    cb._sheet_id_cache = {}

    mock_values = MagicMock()
    mock_sheets = MagicMock()
    mock_sheets.values.return_value = mock_values
    cb._sheets = mock_sheets
    return cb, mock_values.batchUpdate


class TestCashbookSheetName:
    def test_default_is_nyuuryokuyou(self):
        """既定の記帳対象タブ名は `入力用`"""
        assert SheetsConfig().cashbook_sheet_name == "入力用"

    def test_cashbook_client_uses_config_name(self):
        """CashbookClient は config.cashbook_sheet_name をそのまま返す"""
        cb = CashbookClient.__new__(CashbookClient)
        cb._config = SheetsConfig()
        assert cb.cashbook_sheet_name == "入力用"

    def test_cashbook_client_respects_override(self):
        """config で上書きすればその値が使われる"""
        cb = CashbookClient.__new__(CashbookClient)
        cb._config = SheetsConfig(cashbook_sheet_name="別タブ名")
        assert cb.cashbook_sheet_name == "別タブ名"


class TestColLetter:
    def test_basic(self):
        assert _col_letter(0) == "A"
        assert _col_letter(3) == "D"
        assert _col_letter(13) == "N"
        assert _col_letter(26) == "AA"


class TestProcessLogLayout:
    def test_columns(self):
        assert PROCESS_LOG_HEADERS[_PL_FILE_ID] == "fileId"
        assert PROCESS_LOG_HEADERS[_PL_RECEIPT_INDEX] == "receiptIndex"
        assert PROCESS_LOG_HEADERS[_PL_STATUS] == "status"
        assert PROCESS_LOG_HEADERS[_PL_CASHBOOK_ROW] == "cashbookRow"
        assert PROCESS_LOG_HEADERS[_PL_RESERVATION_ID] == "reservationId"
        assert _PL_RESERVATION_ID == len(PROCESS_LOG_HEADERS) - 1


class TestStatuses:
    def test_written_blocks(self):
        assert ProcessStatus.WRITTEN.value in _BLOCKING_STATUSES
        assert ProcessStatus.RESERVED.value in _BLOCKING_STATUSES
        assert ProcessStatus.EXPIRED.value not in _BLOCKING_STATUSES

    def test_written_is_done(self):
        assert ProcessStatus.WRITTEN.value in _DONE_STATUSES
        assert ProcessStatus.RESERVED.value not in _DONE_STATUSES


class TestErrorDetailColumnConfig:
    def test_default_is_o_column(self):
        """既定のエラー詳細列は O列 (index=14)"""
        assert SheetsConfig().error_detail_column == 14
        assert _col_letter(SheetsConfig().error_detail_column) == "O"


class TestWriteManualEntryRow:
    def test_c_column_has_short_label_only(self):
        """C列は短文固定「※要手入力」のみ。長文エラーは入らない"""
        cb, batch = _make_client()
        cb.write_manual_entry_row(
            row=10,
            file_link="https://drive.google.com/file/d/abc/view",
            date_hint="2026-04-23",
            error_hint="OCR失敗: Cloud Vision API has not been used...",
        )

        sent = batch.call_args.kwargs["body"]["data"]
        c_writes = [d for d in sent if "!C10" in d["range"]]
        assert len(c_writes) == 1
        assert c_writes[0]["values"] == [["※要手入力"]]

    def test_o_column_has_error_detail(self):
        """O列にはエラー詳細（長文）が入る"""
        cb, batch = _make_client()
        long_error = (
            "OCR失敗: Cloud Vision API has not been used in project ... enable it by visiting ..."
        )
        cb.write_manual_entry_row(
            row=10,
            file_link="https://drive.google.com/file/d/abc/view",
            date_hint="2026-04-23",
            error_hint=long_error,
        )

        sent = batch.call_args.kwargs["body"]["data"]
        o_writes = [d for d in sent if "!O10" in d["range"]]
        assert len(o_writes) == 1
        assert o_writes[0]["values"] == [[long_error]]

    def test_a_and_b_columns_preserved(self):
        """A列リンク、B列日付も従来通り書き込まれる"""
        cb, batch = _make_client()
        cb.write_manual_entry_row(
            row=7,
            file_link="https://drive.google.com/file/d/xyz/view",
            date_hint="2026-04-23",
            error_hint="err",
        )
        ranges = [d["range"] for d in batch.call_args.kwargs["body"]["data"]]
        assert any("!A7" in r for r in ranges)
        assert any("!B7" in r for r in ranges)

    def test_d_and_n_columns_not_written(self):
        """保護列 D/N には絶対に書き込まない"""
        cb, batch = _make_client()
        cb.write_manual_entry_row(
            row=5,
            file_link="link",
            date_hint="2026-04-23",
            error_hint="e",
        )
        ranges = [d["range"] for d in batch.call_args.kwargs["body"]["data"]]
        assert not any("!D5" in r for r in ranges)
        assert not any("!N5" in r for r in ranges)

    def test_custom_error_column_respected(self):
        """CASHBOOK_ERROR_DETAIL_COLUMN で列を変更できる"""
        # 14(O列) → 20(U列) に変更
        cfg = SheetsConfig(error_detail_column=20)
        cb, batch = _make_client(cfg)
        cb.write_manual_entry_row(
            row=3,
            file_link="l",
            date_hint="d",
            error_hint="X",
        )
        ranges = [d["range"] for d in batch.call_args.kwargs["body"]["data"]]
        assert any("!U3" in r for r in ranges)
        assert not any("!O3" in r for r in ranges)

    def test_error_column_skipped_if_protected(self):
        """エラー列が保護列と重なっていたら書き込まない"""
        cfg = SheetsConfig(
            protected_columns=(3, 13, 14),  # O列(14)も保護
            error_detail_column=14,
        )
        cb, batch = _make_client(cfg)
        cb.write_manual_entry_row(
            row=2,
            file_link="l",
            date_hint="d",
            error_hint="E",
        )
        ranges = [d["range"] for d in batch.call_args.kwargs["body"]["data"]]
        assert not any("!O2" in r for r in ranges)


class TestWriteCashbookRowDoesNotTouchErrorColumn:
    """正常記帳時は O列 に何も書き込まないこと"""

    def test_o_column_untouched_in_normal_write(self):
        from src.models import CorrectedItem, ReceiptItem

        cb, batch = _make_client()
        item = CorrectedItem(
            original=ReceiptItem(),
            date="2026-04-23",
            amount=1000,
            vendor="店",
            description="品",
            account="雑費",
            tax_category="課税仕入10%",
            is_expense=True,
        )
        cb.write_cashbook_row(row=10, item=item, file_link="link")
        ranges = [d["range"] for d in batch.call_args.kwargs["body"]["data"]]
        assert not any("!O10" in r for r in ranges)

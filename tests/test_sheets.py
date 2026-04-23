"""Sheets クライアントのテスト"""

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

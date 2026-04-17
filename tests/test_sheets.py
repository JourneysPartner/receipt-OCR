"""Sheets クライアントのテスト"""

from src.models import ProcessStatus
from src.sheets.client import (
    _col_letter,
    PROCESS_LOG_HEADERS,
    _PL_FILE_ID, _PL_RECEIPT_INDEX, _PL_PROCESSED_AT,
    _PL_STATUS, _PL_CASHBOOK_ROW, _PL_RESERVATION_ID,
    _BLOCKING_STATUSES, _DONE_STATUSES,
)


class TestColLetter:
    def test_basic(self):
        assert _col_letter(0) == "A"
        assert _col_letter(1) == "B"
        assert _col_letter(3) == "D"
        assert _col_letter(13) == "N"
        assert _col_letter(25) == "Z"
        assert _col_letter(26) == "AA"
        assert _col_letter(52) == "BA"


class TestProcessLogLayout:
    def test_columns_match_headers(self):
        assert PROCESS_LOG_HEADERS[_PL_FILE_ID] == "fileId"
        assert PROCESS_LOG_HEADERS[_PL_RECEIPT_INDEX] == "receiptIndex"
        assert PROCESS_LOG_HEADERS[_PL_PROCESSED_AT] == "processedAt"
        assert PROCESS_LOG_HEADERS[_PL_STATUS] == "status"
        assert PROCESS_LOG_HEADERS[_PL_CASHBOOK_ROW] == "cashbookRow"
        assert PROCESS_LOG_HEADERS[_PL_RESERVATION_ID] == "reservationId"
        assert _PL_RESERVATION_ID == len(PROCESS_LOG_HEADERS) - 1


class TestBlockingStatuses:
    def test_reserved_and_written_block(self):
        assert ProcessStatus.RESERVED.value in _BLOCKING_STATUSES
        assert ProcessStatus.WRITTEN.value in _BLOCKING_STATUSES
        assert ProcessStatus.SUCCESS.value in _BLOCKING_STATUSES

    def test_expired_does_not_block(self):
        assert ProcessStatus.EXPIRED.value not in _BLOCKING_STATUSES
        assert ProcessStatus.ERROR.value not in _BLOCKING_STATUSES


class TestDoneStatuses:
    def test_written_is_done(self):
        assert ProcessStatus.WRITTEN.value in _DONE_STATUSES

    def test_reserved_not_done(self):
        assert ProcessStatus.RESERVED.value not in _DONE_STATUSES
        assert ProcessStatus.EXPIRED.value not in _DONE_STATUSES
        assert ProcessStatus.ERROR.value not in _DONE_STATUSES

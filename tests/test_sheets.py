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


def _make_client_with_sheets(sheet_titles: list[str]) -> CashbookClient:
    """APIを呼ばずに _sheet_id_cache だけセットしたインスタンスを生成"""
    c = CashbookClient.__new__(CashbookClient)
    c._config = SheetsConfig()
    c._spreadsheet_id = "dummy"
    c._customer_name = "テスト"
    c._sheet_id_cache = {name: i for i, name in enumerate(sheet_titles)}
    c._resolved_sheet_name = None
    return c


class TestResolveSheetName:
    def test_primary_preferred(self):
        """【顧客名】現金出納帳 が存在すればそれを採用"""
        c = _make_client_with_sheets(["【テスト】現金出納帳", "現金出納帳", "その他"])
        assert c._resolve_sheet_name() == "【テスト】現金出納帳"

    def test_fallback_to_legacy(self):
        """【顧客名】現金出納帳 がなければ `現金出納帳` にフォールバック"""
        c = _make_client_with_sheets(["現金出納帳", "その他"])
        assert c._resolve_sheet_name() == "現金出納帳"

    def test_no_tab_uses_primary(self):
        """どちらも無ければ第一候補（rename前提）"""
        c = _make_client_with_sheets(["その他"])
        assert c._resolve_sheet_name() == "【テスト】現金出納帳"

    def test_cached(self):
        """1度解決したらキャッシュされる"""
        c = _make_client_with_sheets(["【テスト】現金出納帳"])
        first = c._resolve_sheet_name()
        c._sheet_id_cache.clear()  # キャッシュをクリアしても
        assert c._resolve_sheet_name() == first  # 解決結果は保持される

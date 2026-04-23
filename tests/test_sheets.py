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


class TestDefaultColumnMap:
    def test_actual_sheet_layout(self):
        """実シート構成（A/B/F/G/K/M）に合わせた既定列マップ"""
        m = SheetsConfig().cashbook_column_map
        assert m["ファイルリンク"] == 0  # A
        assert m["日付"] == 1  # B
        assert m["勘定科目コード"] == 2  # C
        assert m["取引先"] == 5  # F
        assert m["税区分"] == 6  # G
        assert m["摘要"] == 10  # K
        assert m["支出金額"] == 12  # M

    def test_old_fields_removed(self):
        """旧来の汎用レイアウトのフィールドは含まれない"""
        m = SheetsConfig().cashbook_column_map
        assert "勘定科目" not in m  # 勘定科目名ではなくコードで書く
        assert "収入金額" not in m  # 既定では支出のみ


class TestWriteManualEntryRow:
    def test_k_column_has_short_label(self):
        """短文「※要手入力」は K列（摘要）に入る。C列には入らない。"""
        cb, batch = _make_client()
        cb.write_manual_entry_row(
            row=10,
            file_link="https://drive.google.com/file/d/abc/view",
            date_hint="2026-04-23",
            error_hint="OCR失敗",
        )
        sent = batch.call_args.kwargs["body"]["data"]
        k_writes = [d for d in sent if "!K10" in d["range"]]
        c_writes = [d for d in sent if "!C10" in d["range"]]
        assert len(k_writes) == 1
        assert k_writes[0]["values"] == [["※要手入力"]]
        assert c_writes == []  # C列は触らない

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
        cb, batch = _make_client()
        cb.write_manual_entry_row(row=7, file_link="link", date_hint="2026-04-23", error_hint="err")
        ranges = [d["range"] for d in batch.call_args.kwargs["body"]["data"]]
        assert any("!A7" in r for r in ranges)
        assert any("!B7" in r for r in ranges)

    def test_d_and_n_columns_not_written(self):
        """保護列 D/N には絶対に書き込まない"""
        cb, batch = _make_client()
        cb.write_manual_entry_row(row=5, file_link="l", date_hint="d", error_hint="e")
        ranges = [d["range"] for d in batch.call_args.kwargs["body"]["data"]]
        assert not any("!D5" in r for r in ranges)
        assert not any("!N5" in r for r in ranges)

    def test_custom_error_column_respected(self):
        cfg = SheetsConfig(error_detail_column=20)
        cb, batch = _make_client(cfg)
        cb.write_manual_entry_row(row=3, file_link="l", date_hint="d", error_hint="X")
        ranges = [d["range"] for d in batch.call_args.kwargs["body"]["data"]]
        assert any("!U3" in r for r in ranges)
        assert not any("!O3" in r for r in ranges)

    def test_error_column_skipped_if_protected(self):
        cfg = SheetsConfig(protected_columns=(3, 13, 14), error_detail_column=14)
        cb, batch = _make_client(cfg)
        cb.write_manual_entry_row(row=2, file_link="l", date_hint="d", error_hint="E")
        ranges = [d["range"] for d in batch.call_args.kwargs["body"]["data"]]
        assert not any("!O2" in r for r in ranges)


class TestWriteCashbookRow:
    """正常記帳の列マッピング検証"""

    def _item(self, **kw):
        from src.models import CorrectedItem, ReceiptItem

        d = {
            "original": ReceiptItem(),
            "date": "2026-04-23",
            "amount": 1000,
            "vendor": "店",
            "description": "品",
            "account": "雑費",
            "tax_category": "課税仕入10%",
            "is_expense": True,
        }
        d.update(kw)
        return CorrectedItem(**d)

    def test_description_to_k_not_c(self):
        """摘要は K列に入る（C列には入らない）"""
        cb, batch = _make_client()
        cb.write_cashbook_row(row=10, item=self._item(description="テスト摘要"), file_link="l")
        sent = batch.call_args.kwargs["body"]["data"]
        k_writes = [d for d in sent if "!K10" in d["range"]]
        c_writes = [d for d in sent if "!C10" in d["range"]]
        assert k_writes == [{"range": "'入力用'!K10", "values": [["テスト摘要"]]}]
        # account_code_map が空なので C列は書かれない
        assert c_writes == []

    def test_amount_to_m_for_expense(self):
        """支出金額は M列に入る"""
        cb, batch = _make_client()
        cb.write_cashbook_row(row=10, item=self._item(amount=1234, is_expense=True), file_link="l")
        sent = batch.call_args.kwargs["body"]["data"]
        m_writes = [d for d in sent if "!M10" in d["range"]]
        assert m_writes == [{"range": "'入力用'!M10", "values": [[1234]]}]

    def test_vendor_to_f_tax_to_g(self):
        cb, batch = _make_client()
        cb.write_cashbook_row(
            row=10, item=self._item(vendor="ENEOS", tax_category="課税仕入10%"), file_link="l"
        )
        ranges = {d["range"]: d["values"] for d in batch.call_args.kwargs["body"]["data"]}
        assert ranges["'入力用'!F10"] == [["ENEOS"]]
        assert ranges["'入力用'!G10"] == [["課税仕入10%"]]

    def test_o_column_untouched_in_normal_write(self):
        cb, batch = _make_client()
        cb.write_cashbook_row(row=10, item=self._item(), file_link="l")
        ranges = [d["range"] for d in batch.call_args.kwargs["body"]["data"]]
        assert not any("!O10" in r for r in ranges)

    def test_d_and_n_protected_in_normal_write(self):
        cb, batch = _make_client()
        cb.write_cashbook_row(row=10, item=self._item(), file_link="l")
        ranges = [d["range"] for d in batch.call_args.kwargs["body"]["data"]]
        assert not any("!D10" in r for r in ranges)
        assert not any("!N10" in r for r in ranges)

    def test_c_column_not_written_without_code_map(self):
        """account_code_map が空のとき C列は触らない（既存値/数式を保護）"""
        cb, batch = _make_client()
        cb.write_cashbook_row(row=10, item=self._item(account="雑費"), file_link="l")
        ranges = [d["range"] for d in batch.call_args.kwargs["body"]["data"]]
        assert not any("!C10" in r for r in ranges)

    def test_c_column_written_when_code_mapped(self):
        """account_code_map にエントリがあるとき C列にコードを書く"""
        cfg = SheetsConfig(account_code_map={"雑費": "999", "消耗品費": "401"})
        cb, batch = _make_client(cfg)
        cb.write_cashbook_row(row=10, item=self._item(account="雑費"), file_link="l")
        sent = batch.call_args.kwargs["body"]["data"]
        c_writes = [d for d in sent if "!C10" in d["range"]]
        assert c_writes == [{"range": "'入力用'!C10", "values": [["999"]]}]

    def test_c_column_skipped_when_account_not_in_map(self):
        """map にない勘定科目なら C列は触らない"""
        cfg = SheetsConfig(account_code_map={"消耗品費": "401"})
        cb, batch = _make_client(cfg)
        cb.write_cashbook_row(row=10, item=self._item(account="雑費"), file_link="l")
        ranges = [d["range"] for d in batch.call_args.kwargs["body"]["data"]]
        assert not any("!C10" in r for r in ranges)

    def test_income_amount_not_written_without_income_column(self):
        """既定 col_map には収入金額の列が無いので収入時は金額を書かない"""
        cb, batch = _make_client()
        cb.write_cashbook_row(row=10, item=self._item(amount=500, is_expense=False), file_link="l")
        sent = batch.call_args.kwargs["body"]["data"]
        # M列に収入金額が誤って入らないこと
        m_writes = [d for d in sent if "!M10" in d["range"]]
        assert m_writes == []

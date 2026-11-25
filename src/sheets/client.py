"""
Google Sheets API クライアント

2つの役割:
1. マスターシートの読み書き（MasterSheetClient）
2. 各顧客の出納帳スプレッドシートへの書き込み（CashbookClient）
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from src.compare.normalize import parse_amount_cell
from src.config import MasterConfig, SheetsConfig
from src.logging.logger import setup_logger
from src.models import (
    AiLogRecord,
    CorrectedItem,
    CustomerRow,
    ProcessRecord,
    ProcessStatus,
    ReceiptDetails,
)

logger = setup_logger()
JST = timezone(timedelta(hours=9))

# ── 処理管理シート ─────────────────────────────────
# A..K は今までどおり。L..Q は重複の判断に使う欄（仕様 §6.4）。
PROCESS_LOG_HEADERS = [
    "fileId",
    "fileName",
    "receiptIndex",
    "mimeType",
    "processedAt",
    "status",
    "cashbookRow",
    "errorMessage",
    "retryable",
    "sourceFolderId",
    "reservationId",
    "receiptDate",
    "receiptTime",
    "amount",
    "vendor",
    "receiptNo",
    "duplicateOf",
]
_PL_FILE_ID = 0
_PL_FILE_NAME = 1
_PL_RECEIPT_INDEX = 2
_PL_PROCESSED_AT = 4
_PL_STATUS = 5
_PL_CASHBOOK_ROW = 6
_PL_RESERVATION_ID = 10
_PL_RECEIPT_DATE = 11
_PL_RECEIPT_TIME = 12
_PL_AMOUNT = 13
_PL_VENDOR = 14
_PL_RECEIPT_NO = 15
_PL_DUPLICATE_OF = 16

# 重複を照らす相手にする状態（記帳した・記帳中の明細。仕様 §6.1）
_DUPLICATE_SOURCE_STATUSES = {
    ProcessStatus.SUCCESS.value,
    ProcessStatus.LOW_CONFIDENCE.value,
    ProcessStatus.MANUAL_ENTRY.value,
    ProcessStatus.WRITTEN.value,
    ProcessStatus.RESERVED.value,
}

AI_LOG_HEADERS = [
    "timestamp",
    "fileId",
    "fileName",
    "receiptIndex",
    "OCR方式",
    "信頼度",
    "日付",
    "金額",
    "取引先",
    "摘要",
    "勘定科目候補",
    "税区分候補",
    "補正後勘定科目",
    "補正後税区分",
    "適用補正",
    "要確認",
    "メモ",
]

_BLOCKING_STATUSES = {
    ProcessStatus.RESERVED.value,
    ProcessStatus.WRITTEN.value,
    ProcessStatus.SUCCESS.value,
    ProcessStatus.LOW_CONFIDENCE.value,
    ProcessStatus.MANUAL_ENTRY.value,
}
_DONE_STATUSES = {
    ProcessStatus.SUCCESS.value,
    ProcessStatus.LOW_CONFIDENCE.value,
    ProcessStatus.MANUAL_ENTRY.value,
    ProcessStatus.WRITTEN.value,
    ProcessStatus.DUPLICATE.value,
}


class ProcessLogHeaderError(RuntimeError):
    """処理管理タブの L..Q の見出しが決まった並びと違う（仕様 §6.4・D6）。"""

    def __init__(self, expected: list[str], actual: list[str]):
        self.expected = list(expected)
        self.actual = list(actual)
        super().__init__("処理管理タブの L..Q の見出しが決まった並びと違います")


def _log_cell(value) -> str:
    """USER_ENTERED でも数値・日付に変えないよう、先頭に ' を付けた文字列にする。"""
    if value is None:
        return ""
    text = str(value)
    if not text:
        return ""
    if text.startswith("'"):
        return text
    return f"'{text}"


def _plain_cell(value) -> str:
    """表から読んだ値の先頭の ' を外し、前後の空白を除く。"""
    if value is None:
        return ""
    text = str(value).strip()
    if text.startswith("'"):
        text = text[1:]
    return text


def _build_sheets_service(credentials_path: str | None = None):
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    if credentials_path:
        creds = service_account.Credentials.from_service_account_file(
            credentials_path, scopes=scopes
        )
    else:
        import google.auth

        creds, _ = google.auth.default(scopes=scopes)
    return build("sheets", "v4", credentials=creds)


@dataclass
class ActiveReservation:
    sheet_row: int
    cashbook_row: int
    reservation_id: str
    status: str
    processed_at: str


# ================================================================
# マスターシート操作
# ================================================================


class MasterSheetClient:
    """現金自動記帳マスターの読み書き"""

    def __init__(self, config: MasterConfig, credentials_path: str | None = None):
        self._config = config
        self._service = _build_sheets_service(credentials_path)
        self._sheets = self._service.spreadsheets()

    def read_customer_rows(self) -> list[CustomerRow]:
        """マスターシートから全顧客行を読み込む"""
        sheet = self._config.sheet_name
        start = self._config.data_start_row
        cols = self._config.columns
        max_col_index = max(
            cols.customer_name,
            cols.staff,
            cols.entry_type,
            cols.folder_url,
            cols.status,
            cols.sheet_url,
            cols.category,
            cols.last_processed,
        )
        rng = f"'{sheet}'!A{start}:{_col_letter(max_col_index)}"
        result = (
            self._sheets.values()
            .get(
                spreadsheetId=self._config.spreadsheet_id,
                range=rng,
            )
            .execute()
        )
        values = result.get("values", [])

        rows: list[CustomerRow] = []
        for i, row in enumerate(values):

            def _get(idx: int) -> str:
                return row[idx].strip() if idx < len(row) and row[idx] else ""

            name = _get(cols.customer_name)
            if not name:
                continue

            rows.append(
                CustomerRow(
                    row_number=start + i,
                    customer_name=name,
                    staff=_get(cols.staff),
                    entry_type=_get(cols.entry_type),
                    folder_url=_get(cols.folder_url),
                    status=_get(cols.status),
                    sheet_url=_get(cols.sheet_url),
                    category=_get(cols.category),
                    last_processed=_get(cols.last_processed),
                )
            )

        logger.info(f"マスター: {len(rows)} 顧客行を読み込み", extra={"step": "master_read"})
        return rows

    def update_customer_status(self, row_number: int, status: str, last_processed: str) -> None:
        """マスターの F列(状態) と I列(最終処理日時) を更新する"""
        sheet = self._config.sheet_name
        cols = self._config.columns
        data = [
            {"range": f"'{sheet}'!{_col_letter(cols.status)}{row_number}", "values": [[status]]},
            {
                "range": f"'{sheet}'!{_col_letter(cols.last_processed)}{row_number}",
                "values": [[last_processed]],
            },
        ]
        self._sheets.values().batchUpdate(
            spreadsheetId=self._config.spreadsheet_id,
            body={"valueInputOption": "USER_ENTERED", "data": data},
        ).execute()

    def write_sheet_url(self, row_number: int, url: str) -> None:
        """マスターの G列にシートURLを書き戻す"""
        sheet = self._config.sheet_name
        col = self._config.columns.sheet_url
        self._sheets.values().update(
            spreadsheetId=self._config.spreadsheet_id,
            range=f"'{sheet}'!{_col_letter(col)}{row_number}",
            valueInputOption="USER_ENTERED",
            body={"values": [[url]]},
        ).execute()
        logger.info(f"マスター行{row_number}: G列にURL書き戻し", extra={"step": "master_write_url"})


# ================================================================
# 顧客ごとの出納帳スプレッドシート操作
# ================================================================


class CashbookClient:
    """1顧客の出納帳スプレッドシートへの読み書き。

    記帳対象タブ名は `config.cashbook_sheet_name`（既定: `入力用`）で固定。
    スプレッドシートのファイル名とは別概念。
    """

    def __init__(
        self,
        config: SheetsConfig,
        spreadsheet_id: str,
        credentials_path: str | None = None,
    ):
        self._config = config
        self._spreadsheet_id = spreadsheet_id
        self._service = _build_sheets_service(credentials_path)
        self._sheets = self._service.spreadsheets()
        self._sheet_id_cache: dict[str, int] = {}
        # 勘定科目名 → コード の参照表（シート Q:R から構築）。None 未取得、{} 取得済み空
        self._account_code_cache: dict[str, str] | None = None

    @property
    def cashbook_sheet_name(self) -> str:
        """記帳対象タブ名（固定）"""
        return self._config.cashbook_sheet_name

    # ── 勘定科目名の正規化（表記揺れ吸収） ───────────────
    def _canonicalize_account(self, name: str | None) -> str:
        """AI が返した勘定科目名を、R列側の正規名に揃える。
        account_alias_map にエントリがあればその値を返し、無ければ入力をそのまま返す。
        例: 「接待交際費」→「交際費」
        """
        if not name:
            return ""
        key = name.strip()
        return self._config.account_alias_map.get(key, key)

    # ── 勘定科目コード参照表（シート内 Q:R） ─────────────
    def _account_code_lookup(self) -> dict[str, str]:
        """記帳対象タブ内の Q:R 対応表を読み取り、
        {勘定科目名(R列値): コード(Q列値)} の dict を返す。
        インスタンス内でキャッシュ。"""
        if self._account_code_cache is not None:
            return self._account_code_cache

        cfg = self._config
        q_col = cfg.account_code_column
        r_col = cfg.account_name_column
        lo, hi = min(q_col, r_col), max(q_col, r_col)
        start = cfg.account_table_start_row
        rng = f"'{self.cashbook_sheet_name}'!{_col_letter(lo)}{start}:{_col_letter(hi)}"

        try:
            resp = (
                self._sheets.values().get(spreadsheetId=self._spreadsheet_id, range=rng).execute()
            )
        except HttpError:
            self._account_code_cache = {}
            return self._account_code_cache

        code_off = q_col - lo
        name_off = r_col - lo
        lookup: dict[str, str] = {}
        for row in resp.get("values", []):
            code = str(row[code_off]).strip() if code_off < len(row) and row[code_off] else ""
            name = str(row[name_off]).strip() if name_off < len(row) and row[name_off] else ""
            if code and name:
                lookup[name] = code

        self._account_code_cache = lookup
        logger.info(
            f"勘定科目コード参照表: {len(lookup)} 件読み込み",
            extra={"step": "account_code_lookup"},
        )
        return lookup

    # ── シート ID ──────────────────────────────────
    def _get_sheet_id(self, sheet_name: str) -> int:
        if sheet_name in self._sheet_id_cache:
            return self._sheet_id_cache[sheet_name]
        meta = self._sheets.get(
            spreadsheetId=self._spreadsheet_id,
            fields="sheets.properties",
        ).execute()
        self._sheet_id_cache.clear()
        for s in meta.get("sheets", []):
            p = s["properties"]
            self._sheet_id_cache[p["title"]] = p["sheetId"]
        return self._sheet_id_cache[sheet_name]

    # ── 処理管理シート全行 ─────────────────────────────
    def _read_process_log_all(self) -> list[list[str]]:
        sheet = self._config.process_log_sheet_name
        try:
            r = (
                self._sheets.values()
                .get(
                    spreadsheetId=self._spreadsheet_id,
                    range=f"'{sheet}'!A:Q",
                )
                .execute()
            )
        except HttpError:
            return []
        return r.get("values", [])

    def _process_log_tab_exists(self) -> bool:
        name = self._config.process_log_sheet_name
        meta = self._sheets.get(
            spreadsheetId=self._spreadsheet_id,
            fields="sheets.properties.title",
        ).execute()
        return any(
            str(s.get("properties", {}).get("title", "")) == name for s in meta.get("sheets", [])
        )

    def _read_process_log_strict(self) -> list[list[str]]:
        """顧客の始めに読む処理管理（仕様 §11.5）。

        タブがあるのに読めないときは例外にする（429 などもそのまま上げる）。
        タブが無い（dry_run の新しい出納帳）ときだけ空。ほかの呼び出し元は
        `_read_process_log_all` のまま変えない。
        """
        if not self._process_log_tab_exists():
            return []
        sheet = self._config.process_log_sheet_name
        r = (
            self._sheets.values()
            .get(
                spreadsheetId=self._spreadsheet_id,
                range=f"'{sheet}'!A:Q",
            )
            .execute()
        )
        return r.get("values", [])

    # ── 有効予約 ───────────────────────────────────
    def get_active_reservations(self) -> dict[int, list[ActiveReservation]]:
        values = self._read_process_log_all()
        result: dict[int, list[ActiveReservation]] = {}
        for i, row in enumerate(values[1:], start=2):
            if len(row) <= _PL_CASHBOOK_ROW:
                continue
            st = row[_PL_STATUS] if len(row) > _PL_STATUS else ""
            if st not in (ProcessStatus.RESERVED.value, ProcessStatus.WRITTEN.value):
                continue
            try:
                cb = int(row[_PL_CASHBOOK_ROW])
            except (ValueError, TypeError):
                continue
            rid = row[_PL_RESERVATION_ID] if len(row) > _PL_RESERVATION_ID else ""
            pa = row[_PL_PROCESSED_AT] if len(row) > _PL_PROCESSED_AT else ""
            result.setdefault(cb, []).append(
                ActiveReservation(
                    sheet_row=i,
                    cashbook_row=cb,
                    reservation_id=rid,
                    status=st,
                    processed_at=pa,
                )
            )
        return result

    # ── 使用済み行 ─────────────────────────────────
    def _get_occupied_rows(self) -> set[int]:
        sheet = self.cashbook_sheet_name
        cols = self._config.occupied_check_columns
        start = self._config.cashbook_data_start_row
        if not cols:
            return set()
        lo, hi = min(cols), max(cols)
        rng = f"'{sheet}'!{_col_letter(lo)}{start}:{_col_letter(hi)}"
        r = (
            self._sheets.values()
            .get(
                spreadsheetId=self._spreadsheet_id,
                range=rng,
            )
            .execute()
        )
        offsets = [c - lo for c in cols]
        occupied: set[int] = set()
        for i, row in enumerate(r.get("values", [])):
            for off in offsets:
                if off < len(row) and row[off] and str(row[off]).strip():
                    occupied.add(start + i)
                    break
        return occupied

    # ── 空き行 ──────────────────────────────────
    def find_available_rows(self, count: int) -> list[int]:
        occupied = self._get_occupied_rows()
        active = self.get_active_reservations()
        blocked = occupied | set(active.keys())
        start = self._config.cashbook_data_start_row
        avail: list[int] = []
        c = start
        while len(avail) < count:
            if c not in blocked:
                avail.append(c)
            c += 1
            if c > start + 10000:
                raise RuntimeError(f"空き行なし ({start}〜{c})")
        return avail

    # ── 行予約 ──────────────────────────────────
    def reserve_rows(
        self,
        count: int,
        file_id: str,
        file_name: str,
        receipt_indices: list[int],
        details: dict[int, ReceiptDetails] | None = None,
    ) -> list[tuple[int, str]]:
        """行を予約し、L〜P も同じ 1 回の追記で書く（仕様 §11.4）。

        `details` は明細の番号（`receipt_indices` の値）→ 処理管理に書く値。
        渡さなければ L〜P は空（今までの呼び方）。
        """
        now = datetime.now(JST).isoformat()
        details = details or {}
        for attempt in range(3):
            rows = self.find_available_rows(count)
            reservations: list[tuple[int, str]] = []
            for row, idx in zip(rows, receipt_indices):
                rid = str(uuid.uuid4())
                self.append_process_record(
                    ProcessRecord(
                        file_id=file_id,
                        file_name=file_name,
                        receipt_index=idx,
                        processed_at=now,
                        status=ProcessStatus.RESERVED.value,
                        cashbook_row=row,
                        reservation_id=rid,
                        details=details.get(idx, ReceiptDetails()),
                    )
                )
                reservations.append((row, rid))

            my_rids = {r for _, r in reservations}
            active = self.get_active_reservations()
            occupied = self._get_occupied_rows()
            conflict = False
            for row, _ in reservations:
                if row in occupied:
                    conflict = True
                    break
                if any(a.reservation_id not in my_rids for a in active.get(row, [])):
                    conflict = True
                    break
            if not conflict:
                logger.info(f"行予約成功: {rows}", extra={"step": "row_reserve"})
                return reservations
            for _, rid in reservations:
                self.update_reservation_status(rid, ProcessStatus.EXPIRED.value)

        rows = self.find_available_rows(count)
        res: list[tuple[int, str]] = []
        for row, idx in zip(rows, receipt_indices):
            rid = str(uuid.uuid4())
            self.append_process_record(
                ProcessRecord(
                    file_id=file_id,
                    file_name=file_name,
                    receipt_index=idx,
                    processed_at=now,
                    status=ProcessStatus.RESERVED.value,
                    cashbook_row=row,
                    reservation_id=rid,
                    details=details.get(idx, ReceiptDetails()),
                )
            )
            res.append((row, rid))
        return res

    # ── 予約ステータス更新 ─────────────────────────────
    def update_reservation_status(self, reservation_id: str, new_status: str) -> bool:
        sheet = self._config.process_log_sheet_name
        values = self._read_process_log_all()
        for i, row in enumerate(values[1:], start=2):
            if len(row) > _PL_RESERVATION_ID and row[_PL_RESERVATION_ID] == reservation_id:
                self._sheets.values().update(
                    spreadsheetId=self._spreadsheet_id,
                    range=f"'{sheet}'!F{i}",
                    valueInputOption="RAW",
                    body={"values": [[new_status]]},
                ).execute()
                return True
        return False

    # ── stale reserved 回収 ────────────────────────────
    def cleanup_stale_reservations(self, ttl_minutes: int = 30) -> int:
        values = self._read_process_log_all()
        sheet = self._config.process_log_sheet_name
        cutoff = datetime.now(JST) - timedelta(minutes=ttl_minutes)
        count = 0
        for i, row in enumerate(values[1:], start=2):
            if len(row) <= _PL_STATUS or row[_PL_STATUS] != ProcessStatus.RESERVED.value:
                continue
            pa = row[_PL_PROCESSED_AT] if len(row) > _PL_PROCESSED_AT else ""
            try:
                t = datetime.fromisoformat(pa)
                if t.tzinfo is None:
                    t = t.replace(tzinfo=JST)
            except (ValueError, TypeError):
                continue
            if t < cutoff:
                self._sheets.values().update(
                    spreadsheetId=self._spreadsheet_id,
                    range=f"'{sheet}'!F{i}",
                    valueInputOption="RAW",
                    body={"values": [[ProcessStatus.EXPIRED.value]]},
                ).execute()
                count += 1
        if count:
            logger.info(f"stale reserved {count} 件回収", extra={"step": "cleanup"})
        return count

    # ── stale written 復旧 ─────────────────────────────
    def recover_stale_written(self, ttl_minutes: int = 30) -> int:
        values = self._read_process_log_all()
        sheet = self._config.process_log_sheet_name
        cutoff = datetime.now(JST) - timedelta(minutes=ttl_minutes)
        occupied = self._get_occupied_rows()
        count = 0
        for i, row in enumerate(values[1:], start=2):
            if len(row) <= _PL_STATUS or row[_PL_STATUS] != ProcessStatus.WRITTEN.value:
                continue
            pa = row[_PL_PROCESSED_AT] if len(row) > _PL_PROCESSED_AT else ""
            try:
                t = datetime.fromisoformat(pa)
                if t.tzinfo is None:
                    t = t.replace(tzinfo=JST)
            except (ValueError, TypeError):
                continue
            if t >= cutoff:
                continue
            try:
                cb = int(row[_PL_CASHBOOK_ROW])
            except (ValueError, TypeError):
                continue
            new_st = ProcessStatus.SUCCESS.value if cb in occupied else ProcessStatus.EXPIRED.value
            self._sheets.values().update(
                spreadsheetId=self._spreadsheet_id,
                range=f"'{sheet}'!F{i}",
                valueInputOption="RAW",
                body={"values": [[new_st]]},
            ).execute()
            count += 1
        if count:
            logger.info(f"stale written {count} 件復旧", extra={"step": "recover"})
        return count

    # ── 数式コピー ─────────────────────────────────
    def copy_formulas_to_row(self, target_row: int) -> None:
        cols = self._config.formula_copy_columns
        if not cols:
            return
        sid = self._get_sheet_id(self.cashbook_sheet_name)
        src = max(target_row - 1, self._config.cashbook_data_start_row)
        if src == target_row:
            return
        reqs = [
            {
                "copyPaste": {
                    "source": {
                        "sheetId": sid,
                        "startRowIndex": src - 1,
                        "endRowIndex": src,
                        "startColumnIndex": c,
                        "endColumnIndex": c + 1,
                    },
                    "destination": {
                        "sheetId": sid,
                        "startRowIndex": target_row - 1,
                        "endRowIndex": target_row,
                        "startColumnIndex": c,
                        "endColumnIndex": c + 1,
                    },
                    "pasteType": "PASTE_FORMULA",
                    "pasteOrientation": "NORMAL",
                }
            }
            for c in cols
        ]
        self._sheets.batchUpdate(
            spreadsheetId=self._spreadsheet_id,
            body={"requests": reqs},
        ).execute()

    # ── 出納帳: 通常行 ─────────────────────────────────
    def write_cashbook_row(
        self,
        row: int,
        item: CorrectedItem,
        file_link: str,
        *,
        error_detail: str | None = None,
    ) -> int:
        """実シート構成に合わせた書き込み:
        A=リンク, B=日付, C=勘定科目コード（変換可能時のみ）,
        D=保護(数式), F=取引先, G=税区分, K=摘要, M=支出金額, N=保護(数式)。
        vals に含まれないフィールドは一切書き込まない（既存値/数式を保護する）。
        `error_detail` は O 列（同じファイルの中の重複の注記。仕様 §5・§11.4）。
        """
        sheet = self.cashbook_sheet_name
        col_map = self._config.cashbook_column_map
        prot = set(self._config.protected_columns)

        vals: dict[str, object] = {
            "ファイルリンク": file_link,
            "日付": item.date or "",
            "取引先": item.vendor or "",
            "税区分": item.tax_category or "",
            "摘要": item.description or "",
        }
        # 支出金額は支出時のみ書き込む
        if item.is_expense and item.amount:
            vals["支出金額"] = item.amount
        elif (not item.is_expense) and item.amount:
            vals["収入金額"] = item.amount

        # 勘定科目コードはシート内 Q:R 参照表で引く。
        # AI 抽出の勘定科目名を account_alias_map で正規化してから R列を参照する。
        # 一致しなければ C列は書き込まない（既存値/数式を保護）。
        if item.account:
            canonical = self._canonicalize_account(item.account)
            code = self._account_code_lookup().get(canonical)
            if code:
                vals["勘定科目コード"] = code

        # vals に入っているフィールドだけ書く。未登録列は触らない。
        data = [
            {"range": f"'{sheet}'!{_col_letter(ci)}{row}", "values": [[vals[fn]]]}
            for fn, ci in col_map.items()
            if ci not in prot and fn in vals
        ]
        err_col = self._config.error_detail_column
        if error_detail and err_col is not None and err_col not in prot:
            data.append(
                {
                    "range": f"'{sheet}'!{_col_letter(err_col)}{row}",
                    "values": [[error_detail]],
                }
            )
        if data:
            self._sheets.values().batchUpdate(
                spreadsheetId=self._spreadsheet_id,
                body={"valueInputOption": "USER_ENTERED", "data": data},
            ).execute()
        return row

    # ── 出納帳: 要手入力行 ─────────────────────────────
    # 書き込み仕様:
    #   A列: ファイルリンク
    #   B列: 日付（推定 or 処理日）
    #   C列: 勘定科目コード（candidate がコード解決できるなら書く）
    #   F列: 取引先候補（candidate.vendor）
    #   G列: 税区分候補（candidate.tax_category）
    #   K列: ラベル + 摘要候補
    #   M列: 通常は書かない（金額NGのため）。読み手の間で金額が合った要確認の行だけ、
    #        呼び出し側が `amount`（主の画像からの金額）を渡したときに書く（仕様 §5）
    #   O列 (error_detail_column): エラー詳細（長文）
    #   D/N など保護列: 触らない（数式は事前にコピー済み）
    MANUAL_ENTRY_SHORT_LABEL = "※要手入力"

    def write_manual_entry_row(
        self,
        row: int,
        file_link: str,
        date_hint: str,
        error_hint: str,
        *,
        corrected: CorrectedItem | None = None,
        short_label: str | None = None,
        amount: int | None = None,
    ) -> int:
        """要手入力行を書き込む。

        candidate (= corrected) があれば、A/B/C/F/G/K に候補を埋める。
        K列は「{short_label} / 摘要候補」の形式。摘要候補が無ければラベルのみ。
        金額は signal が壊れている前提で書かない（M列を触らない）。
        ただし `amount`（1 以上の整数。読み手の間で金額が合った要確認の行）を渡した
        ときだけ M列にも書く。`amount` が None・1 未満・bool・整数でない・
        `支出金額` の列が無い・守る列のときは M列を触らない（仕様 §5）。
        """
        sheet = self.cashbook_sheet_name
        col_map = self._config.cashbook_column_map
        prot = set(self._config.protected_columns)
        err_col = self._config.error_detail_column
        label = short_label or self.MANUAL_ENTRY_SHORT_LABEL

        vals: dict[str, object] = {
            "ファイルリンク": file_link,
            "日付": date_hint,
        }
        # 読み手の間で金額が合った行だけ、M列に書く（列の対応に無い・守る列なら
        # 下の data の組み立てで落ちる）。1 以上の整数だけを書く。
        if isinstance(amount, int) and not isinstance(amount, bool) and amount >= 1:
            vals["支出金額"] = amount
        if corrected is not None:
            if corrected.date:
                vals["日付"] = corrected.date
            if corrected.vendor:
                vals["取引先"] = corrected.vendor
            if corrected.tax_category:
                vals["税区分"] = corrected.tax_category
            # 摘要欄は「ラベル / 候補」で残す
            if corrected.description:
                vals["摘要"] = f"{label} / {corrected.description}"
            else:
                vals["摘要"] = label
            # C列コードは Q:R で解決できる時だけ
            if corrected.account:
                canonical = self._canonicalize_account(corrected.account)
                code = self._account_code_lookup().get(canonical)
                if code:
                    vals["勘定科目コード"] = code
        else:
            vals["摘要"] = label

        data = [
            {"range": f"'{sheet}'!{_col_letter(ci)}{row}", "values": [[vals[fn]]]}
            for fn, ci in col_map.items()
            if ci not in prot and fn in vals
        ]

        # O列（エラー詳細）。保護列なら書き込まない。
        if err_col is not None and err_col not in prot:
            data.append(
                {
                    "range": f"'{sheet}'!{_col_letter(err_col)}{row}",
                    "values": [[error_hint]],
                }
            )

        if data:
            self._sheets.values().batchUpdate(
                spreadsheetId=self._spreadsheet_id,
                body={"valueInputOption": "USER_ENTERED", "data": data},
            ).execute()
        return row

    # ── 重複防止 ───────────────────────────────────
    def get_processed_keys(self) -> set[str]:
        values = self._read_process_log_strict()
        keys: set[str] = set()
        for row in values[1:]:
            if len(row) < 6:
                continue
            if row[_PL_STATUS] in _DONE_STATUSES:
                keys.add(f"{row[_PL_FILE_ID]}:{row[_PL_RECEIPT_INDEX]}")
        return keys

    def get_duplicate_candidates(self) -> list[ProcessRecord]:
        """重複を照らす相手（仕様 §6.1）の明細を返す。

        L..Q の欄が埋まっていて、状態が記帳した・記帳中のものだけ。
        `duplicate` の記録は相手にしない（重複の重複を作らない）。
        """
        values = self._read_process_log_strict()
        records: list[ProcessRecord] = []
        for row in values[1:]:
            if len(row) <= _PL_STATUS:
                continue
            status = _plain_cell(row[_PL_STATUS])
            if status not in _DUPLICATE_SOURCE_STATUSES:
                continue

            def cell(index: int) -> str:
                return _plain_cell(row[index]) if index < len(row) else ""

            receipt_date = cell(_PL_RECEIPT_DATE)
            receipt_time = cell(_PL_RECEIPT_TIME)
            amount_text = cell(_PL_AMOUNT)
            vendor = cell(_PL_VENDOR)
            receipt_no = cell(_PL_RECEIPT_NO)
            # 欄が空の古い記録は相手にしない
            if not receipt_date or not amount_text or not vendor:
                continue
            try:
                receipt_index = int(float(cell(_PL_RECEIPT_INDEX)))
            except ValueError:
                continue
            amount = parse_amount_cell(amount_text)
            if amount is None:
                continue

            records.append(
                ProcessRecord(
                    file_id=cell(_PL_FILE_ID),
                    file_name=cell(_PL_FILE_NAME),
                    receipt_index=receipt_index,
                    status=status,
                    details=ReceiptDetails(
                        date=receipt_date,
                        time=receipt_time,
                        amount=amount,
                        vendor=vendor,
                        receipt_no=receipt_no,
                    ),
                    duplicate_of=cell(_PL_DUPLICATE_OF),
                )
            )
        return records

    def append_process_record(self, record: ProcessRecord) -> None:
        sheet = self._config.process_log_sheet_name
        row = [
            record.file_id,
            record.file_name,
            record.receipt_index,
            record.mime_type,
            record.processed_at,
            record.status,
            record.cashbook_row,
            record.error_message,
            str(record.retryable),
            record.source_folder_id,
            record.reservation_id,
        ]
        details = record.details
        new_cells = [
            _log_cell(details.date),
            _log_cell(details.time),
            _log_cell(details.amount),
            _log_cell(details.vendor),
            _log_cell(details.receipt_no),
            _log_cell(record.duplicate_of),
        ]
        if any(new_cells):
            # A..K は今までどおり。L..Q は ' 付きの文字列で足す。
            self._sheets.values().append(
                spreadsheetId=self._spreadsheet_id,
                range=f"'{sheet}'!A:Q",
                valueInputOption="USER_ENTERED",
                insertDataOption="INSERT_ROWS",
                body={"values": [row + new_cells]},
            ).execute()
            return
        self._sheets.values().append(
            spreadsheetId=self._spreadsheet_id,
            range=f"'{sheet}'!A:K",
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": [row]},
        ).execute()

    # ── AI詳細ログ ─────────────────────────────────
    def append_ai_log(self, record: AiLogRecord) -> None:
        sheet = self._config.ai_log_sheet_name
        row = [
            record.timestamp,
            record.file_id,
            record.file_name,
            record.receipt_index,
            record.ocr_engine,
            record.ocr_confidence,
            record.date,
            record.amount,
            record.vendor,
            record.description,
            record.account,
            record.tax_category,
            record.corrected_account,
            record.corrected_tax_category,
            record.corrections_applied,
            str(record.needs_review),
            record.memo,
        ]
        self._sheets.values().append(
            spreadsheetId=self._spreadsheet_id,
            range=f"'{sheet}'!A:Q",
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": [row]},
        ).execute()

    # ── シート初期化 ───────────────────────────────
    def ensure_log_sheets_exist(self, *, write: bool = True) -> None:
        """処理管理・AI詳細ログのタブと見出しを用意する。

        `write=False`（validate / dry_run）では何も書かず、見出しが違えば
        同じように例外にする（D5・D6）。
        """
        meta = self._sheets.get(
            spreadsheetId=self._spreadsheet_id,
            fields="sheets.properties.title",
        ).execute()
        existing = {s["properties"]["title"] for s in meta.get("sheets", [])}
        self._ensure_process_log_sheet(existing, write=write)
        self._ensure_sheet(self._config.ai_log_sheet_name, AI_LOG_HEADERS, existing, write=write)

    def _ensure_process_log_sheet(self, existing: set[str], *, write: bool = True) -> None:
        """処理管理タブを用意し、L..Q の見出しを確かめる（仕様 §6.4・D6）。

        L1 から右が空なら見出しを足す。違う見出しがあれば何も書かずに例外。
        `write=False` では足さずに確かめるだけ。
        """
        name = self._config.process_log_sheet_name
        if name not in existing:
            if not write:
                return
            self._sheets.batchUpdate(
                spreadsheetId=self._spreadsheet_id,
                body={"requests": [{"addSheet": {"properties": {"title": name}}}]},
            ).execute()
            self._sheet_id_cache.clear()

        rng = f"'{name}'!A1:{_col_letter(len(PROCESS_LOG_HEADERS) - 1)}1"
        r = (
            self._sheets.values()
            .get(
                spreadsheetId=self._spreadsheet_id,
                range=rng,
            )
            .execute()
        )
        values = r.get("values") or []
        actual = list(values[0]) if values else []
        if not actual:
            if not write:
                return
            self._sheets.values().update(
                spreadsheetId=self._spreadsheet_id,
                range=rng,
                valueInputOption="RAW",
                body={"values": [PROCESS_LOG_HEADERS]},
            ).execute()
            return

        expected_tail = PROCESS_LOG_HEADERS[_PL_RECEIPT_DATE:]
        actual_tail = [
            str(value).strip() if value is not None else "" for value in actual[_PL_RECEIPT_DATE:]
        ]
        actual_tail += [""] * (len(expected_tail) - len(actual_tail))
        if not any(actual_tail):
            if not write:
                return
            tail_range = (
                f"'{name}'!{_col_letter(_PL_RECEIPT_DATE)}1:"
                f"{_col_letter(len(PROCESS_LOG_HEADERS) - 1)}1"
            )
            self._sheets.values().update(
                spreadsheetId=self._spreadsheet_id,
                range=tail_range,
                valueInputOption="RAW",
                body={"values": [expected_tail]},
            ).execute()
            return
        if actual_tail != expected_tail:
            raise ProcessLogHeaderError(expected_tail, actual_tail)

    def _ensure_sheet(
        self,
        name: str,
        headers: list[str],
        existing: set[str],
        *,
        write: bool = True,
    ) -> None:
        if name not in existing:
            if not write:
                return
            self._sheets.batchUpdate(
                spreadsheetId=self._spreadsheet_id,
                body={"requests": [{"addSheet": {"properties": {"title": name}}}]},
            ).execute()
            self._sheet_id_cache.clear()
        rng = f"'{name}'!A1:{_col_letter(len(headers) - 1)}1"
        r = (
            self._sheets.values()
            .get(
                spreadsheetId=self._spreadsheet_id,
                range=rng,
            )
            .execute()
        )
        if r.get("values") or not write:
            return
        self._sheets.values().update(
            spreadsheetId=self._spreadsheet_id,
            range=rng,
            valueInputOption="RAW",
            body={"values": [headers]},
        ).execute()


def _col_letter(index: int) -> str:
    result = ""
    while True:
        result = chr(65 + index % 26) + result
        index = index // 26 - 1
        if index < 0:
            break
    return result

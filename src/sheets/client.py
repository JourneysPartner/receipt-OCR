"""
Google Sheets API クライアント

2つの役割:
1. マスターシートの読み書き（MasterSheetClient）
2. 各顧客の現金出納帳への書き込み（CashbookClient）
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from src.config import MasterConfig, SheetsConfig
from src.logging.logger import setup_logger
from src.models import (
    AiLogRecord,
    CorrectedItem,
    CustomerRow,
    ProcessRecord,
    ProcessStatus,
    build_cashbook_sheet_name,
)

logger = setup_logger()
JST = timezone(timedelta(hours=9))

# ── 処理管理シート ─────────────────────────────────
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
]
_PL_FILE_ID = 0
_PL_RECEIPT_INDEX = 2
_PL_PROCESSED_AT = 4
_PL_STATUS = 5
_PL_CASHBOOK_ROW = 6
_PL_RESERVATION_ID = 10

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
}


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
# 顧客ごとの現金出納帳操作
# ================================================================


class CashbookClient:
    """1顧客の現金出納帳への読み書き。
    spreadsheet_id と customer_name を顧客ごとに受け取る。
    記帳対象タブ名は「【顧客名】現金出納帳」（第二候補: 「現金出納帳」）。
    """

    def __init__(
        self,
        config: SheetsConfig,
        spreadsheet_id: str,
        customer_name: str,
        credentials_path: str | None = None,
    ):
        self._config = config
        self._spreadsheet_id = spreadsheet_id
        self._customer_name = customer_name
        self._service = _build_sheets_service(credentials_path)
        self._sheets = self._service.spreadsheets()
        self._sheet_id_cache: dict[str, int] = {}
        self._resolved_sheet_name: str | None = None

    # ── シート名の解決（第一候補/フォールバック） ─────────────
    def _resolve_sheet_name(self) -> str:
        """
        記帳対象タブ名を解決する。
        1. 【顧客名】現金出納帳 が存在すればそれ
        2. なければ `現金出納帳` （旧互換）
        3. どちらもなければ第一候補を返す（まだ rename 前等）
        結果はキャッシュする。
        """
        if self._resolved_sheet_name is not None:
            return self._resolved_sheet_name

        primary = build_cashbook_sheet_name(self._customer_name)
        existing = self._get_existing_sheet_names()
        fallback = self._config.cashbook_sheet_name

        if primary in existing:
            self._resolved_sheet_name = primary
        elif fallback in existing:
            logger.warning(
                f"フォールバック: タブ '{fallback}' を使用 (期待: '{primary}')",
                extra={"step": "sheet_resolve"},
            )
            self._resolved_sheet_name = fallback
        else:
            logger.warning(
                f"記帳対象タブ未検出、第一候補 '{primary}' で続行",
                extra={"step": "sheet_resolve"},
            )
            self._resolved_sheet_name = primary
        return self._resolved_sheet_name

    # ── シート ID ──────────────────────────────────
    def _refresh_sheet_id_cache(self) -> None:
        meta = self._sheets.get(
            spreadsheetId=self._spreadsheet_id,
            fields="sheets.properties",
        ).execute()
        self._sheet_id_cache.clear()
        for s in meta.get("sheets", []):
            p = s["properties"]
            self._sheet_id_cache[p["title"]] = p["sheetId"]

    def _get_sheet_id(self, sheet_name: str) -> int:
        if sheet_name in self._sheet_id_cache:
            return self._sheet_id_cache[sheet_name]
        self._refresh_sheet_id_cache()
        return self._sheet_id_cache[sheet_name]

    def _get_existing_sheet_names(self) -> set[str]:
        if not self._sheet_id_cache:
            self._refresh_sheet_id_cache()
        return set(self._sheet_id_cache.keys())

    # ── シート rename ──────────────────────────────
    def rename_sheet(self, old_name: str, new_name: str) -> bool:
        """
        シートタブ名を rename する。old_name が無ければ何もしない（False）。
        new_name が既に存在する場合も何もしない（False）。
        """
        self._refresh_sheet_id_cache()
        if new_name in self._sheet_id_cache:
            return False
        if old_name not in self._sheet_id_cache:
            return False
        sheet_id = self._sheet_id_cache[old_name]
        self._sheets.batchUpdate(
            spreadsheetId=self._spreadsheet_id,
            body={
                "requests": [{
                    "updateSheetProperties": {
                        "properties": {"sheetId": sheet_id, "title": new_name},
                        "fields": "title",
                    }
                }]
            },
        ).execute()
        self._refresh_sheet_id_cache()
        self._resolved_sheet_name = None  # 解決結果は無効化
        logger.info(
            f"シート名変更: '{old_name}' → '{new_name}'",
            extra={"step": "sheet_rename"},
        )
        return True

    def ensure_cashbook_tab_renamed(self) -> str:
        """
        記帳対象タブを `【顧客名】現金出納帳` に揃える。
        すでに揃っていれば何もしない。必要なら `現金出納帳` から rename する。
        戻り値: 最終的な記帳対象タブ名
        """
        target = build_cashbook_sheet_name(self._customer_name)
        existing = self._get_existing_sheet_names()
        if target in existing:
            self._resolved_sheet_name = target
            return target
        fallback = self._config.cashbook_sheet_name
        if fallback in existing:
            self.rename_sheet(fallback, target)
            return target
        # どちらも無い場合は何もしない（テンプレが特殊構造の可能性）
        logger.warning(
            f"記帳対象タブが見つからず rename できません (期待: '{target}')",
            extra={"step": "ensure_rename"},
        )
        return target

    # ── 処理管理シート全行 ─────────────────────────────
    def _read_process_log_all(self) -> list[list[str]]:
        sheet = self._config.process_log_sheet_name
        try:
            r = (
                self._sheets.values()
                .get(
                    spreadsheetId=self._spreadsheet_id,
                    range=f"'{sheet}'!A:K",
                )
                .execute()
            )
        except HttpError:
            return []
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
        sheet = self._resolve_sheet_name()
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
    ) -> list[tuple[int, str]]:
        now = datetime.now(JST).isoformat()
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
        sid = self._get_sheet_id(self._resolve_sheet_name())
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
    def write_cashbook_row(self, row: int, item: CorrectedItem, file_link: str) -> int:
        sheet = self._resolve_sheet_name()
        col_map = self._config.cashbook_column_map
        prot = set(self._config.protected_columns)
        vals = {
            "ファイルリンク": file_link,
            "日付": item.date or "",
            "摘要": item.description or "",
            "取引先": item.vendor or "",
            "勘定科目": item.account or "",
            "税区分": item.tax_category or "",
            "収入金額": item.amount if not item.is_expense and item.amount else "",
            "支出金額": item.amount if item.is_expense and item.amount else "",
        }
        data = [
            {"range": f"'{sheet}'!{_col_letter(ci)}{row}", "values": [[vals.get(fn, "")]]}
            for fn, ci in col_map.items()
            if ci not in prot
        ]
        if data:
            self._sheets.values().batchUpdate(
                spreadsheetId=self._spreadsheet_id,
                body={"valueInputOption": "USER_ENTERED", "data": data},
            ).execute()
        return row

    # ── 出納帳: 要手入力行 ─────────────────────────────
    def write_manual_entry_row(
        self, row: int, file_link: str, date_hint: str, error_hint: str
    ) -> int:
        sheet = self._resolve_sheet_name()
        col_map = self._config.cashbook_column_map
        prot = set(self._config.protected_columns)
        vals = {"ファイルリンク": file_link, "日付": date_hint, "摘要": f"※要手入力: {error_hint}"}
        data = []
        for fn in ("ファイルリンク", "日付", "摘要"):
            ci = col_map.get(fn)
            if ci is not None and ci not in prot:
                data.append(
                    {"range": f"'{sheet}'!{_col_letter(ci)}{row}", "values": [[vals.get(fn, "")]]}
                )
        if data:
            self._sheets.values().batchUpdate(
                spreadsheetId=self._spreadsheet_id,
                body={"valueInputOption": "USER_ENTERED", "data": data},
            ).execute()
        return row

    # ── 重複防止 ───────────────────────────────────
    def get_processed_keys(self) -> set[str]:
        values = self._read_process_log_all()
        keys: set[str] = set()
        for row in values[1:]:
            if len(row) < 6:
                continue
            if row[_PL_STATUS] in _DONE_STATUSES:
                keys.add(f"{row[_PL_FILE_ID]}:{row[_PL_RECEIPT_INDEX]}")
        return keys

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
    def ensure_log_sheets_exist(self) -> None:
        existing = self._get_existing_sheet_names()
        self._ensure_sheet(self._config.process_log_sheet_name, PROCESS_LOG_HEADERS, existing)
        self._ensure_sheet(self._config.ai_log_sheet_name, AI_LOG_HEADERS, existing)

    def _ensure_sheet(self, name: str, headers: list[str], existing: set[str]) -> None:
        if name not in existing:
            self._sheets.batchUpdate(
                spreadsheetId=self._spreadsheet_id,
                body={"requests": [{"addSheet": {"properties": {"title": name}}}]},
            ).execute()
            self._refresh_sheet_id_cache()
        rng = f"'{name}'!A1:{_col_letter(len(headers) - 1)}1"
        r = (
            self._sheets.values()
            .get(
                spreadsheetId=self._spreadsheet_id,
                range=rng,
            )
            .execute()
        )
        if r.get("values"):
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

"""
Google Sheets API クライアント

責務:
- 出納帳の使用済み行判定（A/B/C複数列、occupied_check_columns）
- 行予約（reservation_id ベースの排他制御）
- 数式コピー（D列/N列等）
- 出納帳書き込み（通常行 / 要手入力行）
- 処理管理シート（重複防止 / ステータス管理）
- AI詳細ログシート
- stale reserved の回収 / stale written の復旧
- ログシートの自動作成
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from typing import Optional

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from src.config import SheetsConfig
from src.models import CorrectedItem, ProcessRecord, AiLogRecord, ProcessStatus
from src.logging.logger import setup_logger

logger = setup_logger()

JST = timezone(timedelta(hours=9))

# ── 処理管理シート ヘッダー・列インデックス ──────────────────
PROCESS_LOG_HEADERS = [
    "fileId", "fileName", "receiptIndex", "mimeType", "processedAt",
    "status", "cashbookRow", "errorMessage", "retryable", "sourceFolderId",
    "reservationId",
]
_PL_FILE_ID = 0
_PL_RECEIPT_INDEX = 2
_PL_PROCESSED_AT = 4
_PL_STATUS = 5
_PL_CASHBOOK_ROW = 6
_PL_RESERVATION_ID = 10

AI_LOG_HEADERS = [
    "timestamp", "fileId", "fileName", "receiptIndex",
    "OCR方式", "信頼度", "日付", "金額", "取引先", "摘要",
    "勘定科目候補", "税区分候補", "補正後勘定科目", "補正後税区分",
    "適用補正", "要確認", "メモ",
]

# 行を塞ぐステータス（空き行判定で除外する）
_BLOCKING_STATUSES = {
    ProcessStatus.RESERVED.value,
    ProcessStatus.WRITTEN.value,
    ProcessStatus.SUCCESS.value,
    ProcessStatus.LOW_CONFIDENCE.value,
    ProcessStatus.MANUAL_ENTRY.value,
}

# 再記入防止対象（get_processed_keys に含める）
_DONE_STATUSES = {
    ProcessStatus.SUCCESS.value,
    ProcessStatus.LOW_CONFIDENCE.value,
    ProcessStatus.MANUAL_ENTRY.value,
    ProcessStatus.WRITTEN.value,
}


@dataclass
class ActiveReservation:
    """処理管理シート上の有効な予約"""
    sheet_row: int          # 処理管理シートの行 (1-indexed)
    cashbook_row: int       # 出納帳の行
    reservation_id: str
    status: str
    processed_at: str


class SheetsClient:
    SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

    def __init__(self, config: SheetsConfig, credentials_path: Optional[str] = None):
        self._config = config
        if credentials_path:
            creds = service_account.Credentials.from_service_account_file(
                credentials_path, scopes=self.SCOPES)
        else:
            import google.auth
            creds, _ = google.auth.default(scopes=self.SCOPES)
        self._service = build("sheets", "v4", credentials=creds)
        self._sheets = self._service.spreadsheets()
        self._sheet_id_cache: dict[str, int] = {}

    # ── シート ID ─────────────────────────────────────
    def _get_sheet_id(self, sheet_name: str) -> int:
        if sheet_name in self._sheet_id_cache:
            return self._sheet_id_cache[sheet_name]
        meta = self._sheets.get(
            spreadsheetId=self._config.spreadsheet_id,
            fields="sheets.properties",
        ).execute()
        for s in meta.get("sheets", []):
            p = s["properties"]
            self._sheet_id_cache[p["title"]] = p["sheetId"]
        return self._sheet_id_cache[sheet_name]

    # ── 処理管理シート 全行読み取り ───────────────────────
    def _read_process_log_all(self) -> list[list[str]]:
        sheet = self._config.process_log_sheet_name
        try:
            r = self._sheets.values().get(
                spreadsheetId=self._config.spreadsheet_id,
                range=f"'{sheet}'!A:K",
            ).execute()
        except HttpError:
            return []
        return r.get("values", [])

    # ── 有効予約の取得 ────────────────────────────────
    def get_active_reservations(self) -> dict[int, list[ActiveReservation]]:
        """cashbookRow → [ActiveReservation, ...] を返す。
        reserved / written が対象。"""
        values = self._read_process_log_all()
        result: dict[int, list[ActiveReservation]] = {}
        for i, row in enumerate(values[1:], start=2):
            if len(row) <= _PL_CASHBOOK_ROW:
                continue
            status = row[_PL_STATUS] if len(row) > _PL_STATUS else ""
            if status not in (ProcessStatus.RESERVED.value, ProcessStatus.WRITTEN.value):
                continue
            try:
                cb = int(row[_PL_CASHBOOK_ROW])
            except (ValueError, TypeError):
                continue
            rid = row[_PL_RESERVATION_ID] if len(row) > _PL_RESERVATION_ID else ""
            pat = row[_PL_PROCESSED_AT] if len(row) > _PL_PROCESSED_AT else ""
            result.setdefault(cb, []).append(ActiveReservation(
                sheet_row=i, cashbook_row=cb,
                reservation_id=rid, status=status, processed_at=pat,
            ))
        return result

    # ── 出納帳: 使用済み行 ───────────────────────────────
    def _get_occupied_rows_from_cashbook(self) -> set[int]:
        """occupied_check_columns のいずれかに値がある行を返す。"""
        sheet = self._config.cashbook_sheet_name
        cols = self._config.occupied_check_columns
        start = self._config.cashbook_data_start_row
        if not cols:
            return set()

        lo, hi = min(cols), max(cols)
        rng = f"'{sheet}'!{_col_letter(lo)}{start}:{_col_letter(hi)}"
        r = self._sheets.values().get(
            spreadsheetId=self._config.spreadsheet_id, range=rng,
        ).execute()
        values = r.get("values", [])
        offsets = [c - lo for c in cols]

        occupied: set[int] = set()
        for i, row in enumerate(values):
            for off in offsets:
                if off < len(row) and row[off] and str(row[off]).strip():
                    occupied.add(start + i)
                    break
        return occupied

    # ── 出納帳: 空き行検索 ──────────────────────────────
    def find_available_rows(self, count: int) -> list[int]:
        occupied = self._get_occupied_rows_from_cashbook()
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

    # ── 行予約 ──────────────────────────────────────
    def reserve_rows(
        self, count: int, file_id: str, file_name: str,
        receipt_indices: list[int],
    ) -> list[tuple[int, str]]:
        """行予約 + 競合検知。戻り値: [(行番号, reservation_id), ...]"""
        now = datetime.now(JST).isoformat()
        for attempt in range(3):
            rows = self.find_available_rows(count)
            reservations: list[tuple[int, str]] = []
            for row, idx in zip(rows, receipt_indices):
                rid = str(uuid.uuid4())
                self.append_process_record(ProcessRecord(
                    file_id=file_id, file_name=file_name, receipt_index=idx,
                    processed_at=now, status=ProcessStatus.RESERVED.value,
                    cashbook_row=row, reservation_id=rid,
                ))
                reservations.append((row, rid))

            # 競合チェック
            my_rids = {r for _, r in reservations}
            active = self.get_active_reservations()
            occupied = self._get_occupied_rows_from_cashbook()
            conflict = False
            for row, _ in reservations:
                if row in occupied:
                    conflict = True
                    break
                others = [a for a in active.get(row, []) if a.reservation_id not in my_rids]
                if others:
                    conflict = True
                    break

            if not conflict:
                logger.info(f"行予約成功: {rows} (attempt {attempt + 1})",
                             extra={"step": "row_reserve", "file_id": file_id})
                return reservations

            logger.warning(f"行予約競合 (attempt {attempt + 1}): {rows}",
                            extra={"step": "row_reserve_conflict"})
            for _, rid in reservations:
                self.update_reservation_status(rid, ProcessStatus.EXPIRED.value)

        # フォールバック
        rows = self.find_available_rows(count)
        res: list[tuple[int, str]] = []
        for row, idx in zip(rows, receipt_indices):
            rid = str(uuid.uuid4())
            self.append_process_record(ProcessRecord(
                file_id=file_id, file_name=file_name, receipt_index=idx,
                processed_at=now, status=ProcessStatus.RESERVED.value,
                cashbook_row=row, reservation_id=rid,
            ))
            res.append((row, rid))
        logger.warning(f"行予約フォールバック: {rows}",
                        extra={"step": "row_reserve_fallback"})
        return res

    # ── 予約ステータス更新 ──────────────────────────────
    def update_reservation_status(self, reservation_id: str, new_status: str) -> bool:
        sheet = self._config.process_log_sheet_name
        values = self._read_process_log_all()
        for i, row in enumerate(values[1:], start=2):
            if len(row) > _PL_RESERVATION_ID and row[_PL_RESERVATION_ID] == reservation_id:
                self._sheets.values().update(
                    spreadsheetId=self._config.spreadsheet_id,
                    range=f"'{sheet}'!F{i}", valueInputOption="RAW",
                    body={"values": [[new_status]]},
                ).execute()
                logger.info(f"予約更新: rid={reservation_id[:8]}… → {new_status}",
                             extra={"step": "update_reservation"})
                return True
        logger.warning(f"予約未検出: rid={reservation_id[:8]}…",
                        extra={"step": "update_reservation"})
        return False

    # ── stale reserved の回収 ────────────────────────────
    def cleanup_stale_reservations(self, ttl_minutes: int = 30) -> int:
        values = self._read_process_log_all()
        sheet = self._config.process_log_sheet_name
        cutoff = datetime.now(JST) - timedelta(minutes=ttl_minutes)
        count = 0
        for i, row in enumerate(values[1:], start=2):
            if len(row) <= _PL_STATUS or row[_PL_STATUS] != ProcessStatus.RESERVED.value:
                continue
            pa = row[_PL_PROCESSED_AT] if len(row) > _PL_PROCESSED_AT else ""
            if not pa:
                continue
            try:
                t = datetime.fromisoformat(pa)
                if t.tzinfo is None:
                    t = t.replace(tzinfo=JST)
            except (ValueError, TypeError):
                continue
            if t < cutoff:
                self._sheets.values().update(
                    spreadsheetId=self._config.spreadsheet_id,
                    range=f"'{sheet}'!F{i}", valueInputOption="RAW",
                    body={"values": [[ProcessStatus.EXPIRED.value]]},
                ).execute()
                count += 1
        if count:
            logger.info(f"stale reserved {count} 件回収", extra={"step": "cleanup"})
        return count

    # ── stale written の復旧 ─────────────────────────────
    def recover_stale_written(self, ttl_minutes: int = 30) -> int:
        values = self._read_process_log_all()
        sheet = self._config.process_log_sheet_name
        cutoff = datetime.now(JST) - timedelta(minutes=ttl_minutes)
        occupied = self._get_occupied_rows_from_cashbook()
        count = 0
        for i, row in enumerate(values[1:], start=2):
            if len(row) <= _PL_STATUS or row[_PL_STATUS] != ProcessStatus.WRITTEN.value:
                continue
            pa = row[_PL_PROCESSED_AT] if len(row) > _PL_PROCESSED_AT else ""
            if not pa:
                continue
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
            new_st = (ProcessStatus.SUCCESS.value if cb in occupied
                      else ProcessStatus.EXPIRED.value)
            self._sheets.values().update(
                spreadsheetId=self._config.spreadsheet_id,
                range=f"'{sheet}'!F{i}", valueInputOption="RAW",
                body={"values": [[new_st]]},
            ).execute()
            count += 1
            logger.info(f"written復旧: 行{cb} → {new_st}",
                         extra={"step": "recover_written"})
        if count:
            logger.info(f"stale written {count} 件復旧", extra={"step": "recover_written"})
        return count

    # ── 数式コピー ──────────────────────────────────
    def copy_formulas_to_row(self, target_row: int) -> None:
        cols = self._config.formula_copy_columns
        if not cols:
            return
        sheet_name = self._config.cashbook_sheet_name
        sid = self._get_sheet_id(sheet_name)
        src = max(target_row - 1, self._config.cashbook_data_start_row)
        if src == target_row:
            return
        reqs = [{
            "copyPaste": {
                "source": {"sheetId": sid, "startRowIndex": src - 1, "endRowIndex": src,
                           "startColumnIndex": c, "endColumnIndex": c + 1},
                "destination": {"sheetId": sid, "startRowIndex": target_row - 1,
                                "endRowIndex": target_row,
                                "startColumnIndex": c, "endColumnIndex": c + 1},
                "pasteType": "PASTE_FORMULA", "pasteOrientation": "NORMAL",
            }
        } for c in cols]
        self._sheets.batchUpdate(
            spreadsheetId=self._config.spreadsheet_id,
            body={"requests": reqs},
        ).execute()
        names = ",".join(_col_letter(c) for c in cols)
        logger.info(f"数式コピー: 行{src}→{target_row} ({names}列)",
                     extra={"step": "formula_copy"})

    # ── 出納帳: 通常行 ──────────────────────────────────
    def write_cashbook_row(
        self, row: int, item: CorrectedItem, file_link: str
    ) -> int:
        sheet = self._config.cashbook_sheet_name
        col_map = self._config.cashbook_column_map
        prot = set(self._config.protected_columns)
        vals = {
            "ファイルリンク": file_link, "日付": item.date or "",
            "摘要": item.description or "", "取引先": item.vendor or "",
            "勘定科目": item.account or "", "税区分": item.tax_category or "",
            "収入金額": item.amount if not item.is_expense and item.amount else "",
            "支出金額": item.amount if item.is_expense and item.amount else "",
        }
        data = [{"range": f"'{sheet}'!{_col_letter(ci)}{row}", "values": [[vals.get(fn, "")]]}
                for fn, ci in col_map.items() if ci not in prot]
        if data:
            self._sheets.values().batchUpdate(
                spreadsheetId=self._config.spreadsheet_id,
                body={"valueInputOption": "USER_ENTERED", "data": data},
            ).execute()
        logger.info(f"出納帳 行{row} 書き込み完了", extra={"step": "cashbook_write"})
        return row

    # ── 出納帳: 要手入力行 ──────────────────────────────
    def write_manual_entry_row(
        self, row: int, file_link: str, date_hint: str, error_hint: str
    ) -> int:
        sheet = self._config.cashbook_sheet_name
        col_map = self._config.cashbook_column_map
        prot = set(self._config.protected_columns)
        vals = {"ファイルリンク": file_link, "日付": date_hint,
                "摘要": f"※要手入力: {error_hint}"}
        data = []
        for fn in ("ファイルリンク", "日付", "摘要"):
            ci = col_map.get(fn)
            if ci is not None and ci not in prot:
                data.append({"range": f"'{sheet}'!{_col_letter(ci)}{row}",
                             "values": [[vals.get(fn, "")]]})
        if data:
            self._sheets.values().batchUpdate(
                spreadsheetId=self._config.spreadsheet_id,
                body={"valueInputOption": "USER_ENTERED", "data": data},
            ).execute()
        logger.info(f"出納帳 行{row} 要手入力行作成", extra={"step": "manual_entry"})
        return row

    # ── 処理管理: 重複防止 ──────────────────────────────
    def get_processed_keys(self) -> set[str]:
        """written も含む再記入防止キー集合 "fileId:receiptIndex" """
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
            record.file_id, record.file_name, record.receipt_index,
            record.mime_type, record.processed_at, record.status,
            record.cashbook_row, record.error_message,
            str(record.retryable), record.source_folder_id,
            record.reservation_id,
        ]
        self._sheets.values().append(
            spreadsheetId=self._config.spreadsheet_id,
            range=f"'{sheet}'!A:K", valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS", body={"values": [row]},
        ).execute()

    # ── AI詳細ログ ──────────────────────────────────
    def append_ai_log(self, record: AiLogRecord) -> None:
        sheet = self._config.ai_log_sheet_name
        row = [
            record.timestamp, record.file_id, record.file_name,
            record.receipt_index, record.ocr_engine, record.ocr_confidence,
            record.date, record.amount, record.vendor, record.description,
            record.account, record.tax_category,
            record.corrected_account, record.corrected_tax_category,
            record.corrections_applied, str(record.needs_review), record.memo,
        ]
        self._sheets.values().append(
            spreadsheetId=self._config.spreadsheet_id,
            range=f"'{sheet}'!A:Q", valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS", body={"values": [row]},
        ).execute()

    # ── シート初期化 ─────────────────────────────────
    def ensure_log_sheets_exist(self) -> None:
        existing = self._get_existing_sheet_names()
        self._ensure_sheet(self._config.process_log_sheet_name,
                           PROCESS_LOG_HEADERS, existing)
        self._ensure_sheet(self._config.ai_log_sheet_name,
                           AI_LOG_HEADERS, existing)

    def _get_existing_sheet_names(self) -> set[str]:
        meta = self._sheets.get(
            spreadsheetId=self._config.spreadsheet_id,
            fields="sheets.properties.title",
        ).execute()
        return {s["properties"]["title"] for s in meta.get("sheets", [])}

    def _ensure_sheet(
        self, name: str, headers: list[str], existing: set[str]
    ) -> None:
        if name not in existing:
            self._sheets.batchUpdate(
                spreadsheetId=self._config.spreadsheet_id,
                body={"requests": [{"addSheet": {"properties": {"title": name}}}]},
            ).execute()
            logger.info(f"シート '{name}' 作成")
            self._sheet_id_cache.clear()
        rng = f"'{name}'!A1:{_col_letter(len(headers) - 1)}1"
        r = self._sheets.values().get(
            spreadsheetId=self._config.spreadsheet_id, range=rng,
        ).execute()
        if r.get("values"):
            return
        self._sheets.values().update(
            spreadsheetId=self._config.spreadsheet_id, range=rng,
            valueInputOption="RAW", body={"values": [headers]},
        ).execute()
        logger.info(f"シート '{name}' ヘッダー作成")


def _col_letter(index: int) -> str:
    result = ""
    while True:
        result = chr(65 + index % 26) + result
        index = index // 26 - 1
        if index < 0:
            break
    return result

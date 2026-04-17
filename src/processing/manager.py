"""
処理オーケストレーター

1明細のフロー: reserved → 数式コピー → 出納帳書き込み → written → AIログ → success
クラッシュ復旧: ジョブ開始時に stale reserved → expired / stale written → success or expired
"""

from datetime import datetime, timezone, timedelta

from src.config import AppConfig
from src.models import (
    DriveFile, OcrResult, ReceiptItem, CorrectedItem,
    ProcessRecord, AiLogRecord, ProcessStatus,
)
from src.drive.client import DriveClient
from src.sheets.client import SheetsClient
from src.ocr.base import OcrEngine
from src.ai.base import AiExtractor
from src.rules.corrections import RuleCorrector
from src.logging.logger import setup_logger

logger = setup_logger()
JST = timezone(timedelta(hours=9))


class ProcessingManager:
    def __init__(
        self, config: AppConfig, drive: DriveClient, sheets: SheetsClient,
        ocr: OcrEngine, ai: AiExtractor, corrector: RuleCorrector,
    ):
        self._config = config
        self._drive = drive
        self._sheets = sheets
        self._ocr = ocr
        self._ai = ai
        self._corrector = corrector

    def run(self) -> dict:
        summary = {
            "total_files": 0, "processed_items": 0, "skipped_items": 0,
            "manual_entries": 0, "error_items": 0, "skipped_files": 0,
        }

        self._sheets.ensure_log_sheets_exist()
        ttl = self._config.reservation_ttl_minutes
        self._sheets.cleanup_stale_reservations(ttl_minutes=ttl)
        self._sheets.recover_stale_written(ttl_minutes=ttl)

        files = self._drive.list_files()
        summary["total_files"] = len(files)

        processed_keys = self._sheets.get_processed_keys()
        logger.info(f"処理済みキー: {len(processed_keys)}", extra={"step": "dedup"})

        for file in files:
            r = self._process_file(file, processed_keys)
            summary["processed_items"] += r["processed"]
            summary["skipped_items"] += r["skipped"]
            summary["manual_entries"] += r["manual"]
            summary["error_items"] += r["errors"]
            if r["processed"] == 0 and r["skipped"] > 0 and r["manual"] == 0:
                summary["skipped_files"] += 1

        logger.info(f"ジョブ完了: {summary}", extra={"step": "summary"})
        return summary

    def _process_file(self, file: DriveFile, processed_keys: set[str]) -> dict:
        r = {"processed": 0, "skipped": 0, "manual": 0, "errors": 0}
        now = datetime.now(JST).isoformat()
        today = datetime.now(JST).strftime("%Y-%m-%d")

        if f"{file.file_id}:-1" in processed_keys:
            r["skipped"] = 1
            return r

        # ダウンロード
        try:
            file = self._drive.download_file(file)
        except Exception as e:
            r["manual"] += 1
            self._manual_entry(file, f"ダウンロード失敗: {e}", today, now)
            return r

        # OCR
        ocr = self._ocr.extract_text(file)
        if ocr.error or not ocr.raw_text.strip():
            r["manual"] += 1
            self._manual_entry(file, f"OCR失敗: {ocr.error or 'テキスト空'}", today, now)
            return r

        # AI
        items = self._ai.extract_receipt_data(ocr, file.file_name)
        if not items:
            r["manual"] += 1
            self._manual_entry(file, "AI解析で明細抽出不可", today, now)
            return r

        corrected = [self._corrector.apply(it) for it in items]

        if self._config.dry_run:
            logger.info(f"DRY RUN: {file.file_name} → {len(corrected)} 明細",
                         extra={"step": "dry_run"})
            return r

        # 未処理明細
        pending = [i for i in range(len(corrected))
                   if f"{file.file_id}:{i}" not in processed_keys]
        r["skipped"] = len(corrected) - len(pending)
        if not pending:
            return r

        # 行予約
        reservations = self._sheets.reserve_rows(
            count=len(pending), file_id=file.file_id,
            file_name=file.file_name, receipt_indices=pending,
        )

        for (row, rid), idx in zip(reservations, pending):
            try:
                self._write_item(
                    file, items[idx], corrected[idx], idx, row, rid, ocr, now, today,
                )
                r["processed"] += 1
            except Exception as e:
                logger.error(f"明細失敗: {file.file_name}[{idx}]: {e}",
                              extra={"step": "item_error", "file_id": file.file_id})
                try:
                    self._sheets.write_manual_entry_row(
                        row, file.drive_link, corrected[idx].date or today,
                        f"明細[{idx}]書き込み失敗: {e}")
                    self._sheets.update_reservation_status(
                        rid, ProcessStatus.MANUAL_ENTRY.value)
                    r["manual"] += 1
                except Exception as ie:
                    logger.error(f"要手入力も失敗: {ie}")
                    self._sheets.update_reservation_status(
                        rid, ProcessStatus.ERROR.value)
                    r["errors"] += 1
        return r

    def _write_item(
        self, file: DriveFile, item: ReceiptItem, corrected: CorrectedItem,
        idx: int, row: int, rid: str, ocr: OcrResult, now: str, today: str,
    ) -> None:
        # 数式コピー → 出納帳書き込み → written → AIログ → success
        self._sheets.copy_formulas_to_row(row)
        self._sheets.write_cashbook_row(row, corrected, file.drive_link)
        self._sheets.update_reservation_status(rid, ProcessStatus.WRITTEN.value)

        self._sheets.append_ai_log(AiLogRecord(
            timestamp=now, file_id=file.file_id, file_name=file.file_name,
            receipt_index=idx, ocr_engine=ocr.engine, ocr_confidence=ocr.confidence,
            date=item.date or "", amount=str(item.amount) if item.amount else "",
            vendor=item.vendor or "", description=item.description or "",
            account=item.account or "", tax_category=item.tax_category or "",
            corrected_account=corrected.account or "",
            corrected_tax_category=corrected.tax_category or "",
            corrections_applied=", ".join(corrected.corrections_applied),
            needs_review=corrected.needs_review, memo=corrected.memo or "",
        ))

        final = (ProcessStatus.LOW_CONFIDENCE if corrected.needs_review
                 else ProcessStatus.SUCCESS)
        self._sheets.update_reservation_status(rid, final.value)

    def _manual_entry(
        self, file: DriveFile, msg: str, date: str, now: str
    ) -> None:
        logger.warning(f"要手入力: {file.file_name}: {msg}",
                        extra={"step": "manual_entry", "file_id": file.file_id})
        if self._config.dry_run:
            return
        try:
            res = self._sheets.reserve_rows(
                count=1, file_id=file.file_id,
                file_name=file.file_name, receipt_indices=[-1],
            )
            row, rid = res[0]
            self._sheets.copy_formulas_to_row(row)
            self._sheets.write_manual_entry_row(
                row, file.drive_link, date, f"{file.file_name}: {msg}")
            self._sheets.update_reservation_status(rid, ProcessStatus.WRITTEN.value)
            self._sheets.update_reservation_status(rid, ProcessStatus.MANUAL_ENTRY.value)
        except Exception as e:
            logger.error(f"要手入力行作成失敗: {e}",
                          extra={"step": "manual_entry_error"})
            try:
                self._sheets.append_process_record(ProcessRecord(
                    file_id=file.file_id, file_name=file.file_name,
                    receipt_index=-1, mime_type=file.mime_type,
                    processed_at=now, status=ProcessStatus.ERROR.value,
                    error_message=f"{msg} / 行作成も失敗: {e}", retryable=True,
                    source_folder_id=file.folder_id,
                ))
            except Exception:
                logger.error("管理レコード記録すら失敗", exc_info=True)

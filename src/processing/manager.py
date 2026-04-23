"""
処理オーケストレーター
マスターシート起点で全顧客を順次処理する。
顧客ごとの処理結果を集計し、マスターF列に詳細な状態を書き戻す。
"""

from datetime import datetime, timedelta, timezone

from src.ai.base import AiExtractor
from src.config import AppConfig
from src.drive.client import DriveClient
from src.logging.logger import setup_logger
from src.models import (
    AiLogRecord,
    CorrectedItem,
    CustomerResult,
    CustomerRow,
    DriveFile,
    OcrResult,
    ProcessRecord,
    ProcessStatus,
    ReceiptItem,
)
from src.ocr.base import OcrEngine
from src.rules.amount_validation import AmountValidation, validate_amount
from src.rules.corrections import RuleCorrector
from src.sheets.client import CashbookClient, MasterSheetClient

logger = setup_logger()
JST = timezone(timedelta(hours=9))


class ProcessingManager:
    def __init__(
        self,
        config: AppConfig,
        drive: DriveClient,
        master: MasterSheetClient,
        ocr: OcrEngine,
        ai: AiExtractor,
        corrector: RuleCorrector,
    ):
        self._config = config
        self._drive = drive
        self._master = master
        self._ocr = ocr
        self._ai = ai
        self._corrector = corrector

    # ── 全顧客処理 ─────────────────────────────────
    def run(self) -> dict:
        summary = {
            "total_customers": 0,
            "processed_customers": 0,
            "skipped_customers": 0,
            "error_customers": 0,
            "total_items": 0,
        }

        customers = self._master.read_customer_rows()
        target = self._config.master.target_entry_type

        for cust in customers:
            summary["total_customers"] += 1

            if cust.entry_type != target:
                logger.info(
                    f"スキップ（記帳区分={cust.entry_type}）: {cust.customer_name}",
                    extra={"step": "customer_skip"},
                )
                summary["skipped_customers"] += 1
                continue

            if not cust.folder_url.strip():
                logger.warning(
                    f"フォルダURL未設定: {cust.customer_name}", extra={"step": "customer_skip"}
                )
                now = datetime.now(JST).isoformat()
                try:
                    self._master.update_customer_status(
                        cust.row_number, "スキップ / フォルダURL未設定", now
                    )
                except Exception:
                    pass
                summary["skipped_customers"] += 1
                continue

            # G列（シートリンク）未設定ならスキップ。
            # 新規作成はせず、マスターに明確な状態を書き戻して人間対応に委ねる。
            if not cust.has_cashbook:
                logger.warning(
                    f"シートURL未設定: {cust.customer_name} "
                    "(手動で出納帳作成しG列に記入してください)",
                    extra={"step": "customer_skip_no_sheet"},
                )
                now = datetime.now(JST).isoformat()
                try:
                    self._master.update_customer_status(
                        cust.row_number, "スキップ / シートURL未設定", now
                    )
                except Exception:
                    pass
                summary["skipped_customers"] += 1
                continue

            try:
                result = self._process_customer(cust)
                summary["processed_customers"] += 1
                summary["total_items"] += result.total_processed
            except Exception as e:
                summary["error_customers"] += 1
                now = datetime.now(JST).isoformat()
                logger.error(
                    f"顧客処理失敗: {cust.customer_name}: {e}",
                    extra={"step": "customer_error"},
                    exc_info=True,
                )
                try:
                    self._master.update_customer_status(
                        cust.row_number,
                        f"エラー: {str(e)[:50]}",
                        now,
                    )
                except Exception:
                    pass

        logger.info(f"全顧客処理完了: {summary}", extra={"step": "summary"})
        return summary

    # ── 1顧客の処理 ────────────────────────────────
    def _process_customer(self, cust: CustomerRow) -> CustomerResult:
        now_str = datetime.now(JST).isoformat()
        today = datetime.now(JST).strftime("%Y-%m-%d")

        logger.info(f"顧客処理開始: {cust.customer_name}", extra={"step": "customer_start"})

        self._master.update_customer_status(cust.row_number, "処理中", now_str)

        cashbook_id = cust.spreadsheet_id
        if not cashbook_id:
            raise RuntimeError("出納帳スプレッドシートIDを取得できません")

        folder_id = cust.folder_id
        if not folder_id:
            raise RuntimeError("フォルダIDを取得できません")

        cb = CashbookClient(
            config=self._config.sheets,
            spreadsheet_id=cashbook_id,
            credentials_path=self._config.google_credentials_path,
        )

        cb.ensure_log_sheets_exist()
        ttl = self._config.reservation_ttl_minutes
        cb.cleanup_stale_reservations(ttl_minutes=ttl)
        cb.recover_stale_written(ttl_minutes=ttl)

        # レシートファイル取得
        files = self._drive.list_files(folder_id)
        if not files:
            logger.info(f"レシートなし: {cust.customer_name}", extra={"step": "customer_no_files"})
            self._master.update_customer_status(cust.row_number, "完了（対象なし）", now_str)
            return CustomerResult()

        processed_keys = cb.get_processed_keys()

        # 全ファイルを処理し、結果を集計
        total = CustomerResult()
        for file in files:
            file_result = self._process_file(file, cb, processed_keys, today, now_str)
            total.success += file_result.success
            total.low_confidence += file_result.low_confidence
            total.manual_entry += file_result.manual_entry
            total.skipped += file_result.skipped
            total.errors += file_result.errors

        # 集計結果からF列の状態文字列を生成
        status_str = total.to_status_string()
        now_final = datetime.now(JST).isoformat()
        self._master.update_customer_status(cust.row_number, status_str, now_final)

        logger.info(
            f"顧客処理完了: {cust.customer_name} → {status_str}",
            extra={"step": "customer_complete"},
        )
        return total

    # ── 1ファイルの処理 ────────────────────────────────
    def _process_file(
        self,
        file: DriveFile,
        cb: CashbookClient,
        processed_keys: set[str],
        today: str,
        now: str,
    ) -> CustomerResult:
        result = CustomerResult()

        # ファイル単位スキップ
        if f"{file.file_id}:-1" in processed_keys:
            result.skipped = 1
            return result

        # ダウンロード
        try:
            file = self._drive.download_file(file)
        except Exception as e:
            self._manual_entry(file, cb, f"DL失敗: {e}", today, now)
            result.manual_entry = 1
            return result

        # OCR
        ocr = self._ocr.extract_text(file)
        if ocr.error or not ocr.raw_text.strip():
            self._manual_entry(file, cb, f"OCR失敗: {ocr.error or 'テキスト空'}", today, now)
            result.manual_entry = 1
            return result

        # AI
        items = self._ai.extract_receipt_data(ocr, file.file_name)
        if not items:
            self._manual_entry(file, cb, "AI解析で明細抽出不可", today, now)
            result.manual_entry = 1
            return result

        corrected = [self._corrector.apply(it) for it in items]
        # 金額検証（OCR 候補との突合）
        validations = [validate_amount(it.amount, ocr.raw_text) for it in items]

        if self._config.dry_run:
            logger.info(
                f"DRY RUN: {file.file_name} → {len(corrected)} 明細", extra={"step": "dry_run"}
            )
            return result

        # 未処理明細
        pending = [i for i in range(len(corrected)) if f"{file.file_id}:{i}" not in processed_keys]
        result.skipped = len(corrected) - len(pending)
        if not pending:
            return result

        # 行予約
        reservations = cb.reserve_rows(
            count=len(pending),
            file_id=file.file_id,
            file_name=file.file_name,
            receipt_indices=pending,
        )

        for (row, rid), idx in zip(reservations, pending):
            validation = validations[idx]

            # 金額検証で明らかに不整合なら強制 manual_entry
            if validation.should_manual_entry:
                try:
                    self._write_amount_invalid_as_manual(
                        file,
                        items[idx],
                        corrected[idx],
                        validation,
                        idx,
                        row,
                        rid,
                        cb,
                        ocr,
                        now,
                        today,
                    )
                    result.manual_entry += 1
                except Exception as e:
                    logger.error(
                        f"金額検証NG行作成失敗: {file.file_name}[{idx}]: {e}",
                        extra={"step": "item_error_amount"},
                    )
                    cb.update_reservation_status(rid, ProcessStatus.ERROR.value)
                    result.errors += 1
                continue

            try:
                is_low = self._write_item(
                    file,
                    items[idx],
                    corrected[idx],
                    idx,
                    row,
                    rid,
                    cb,
                    ocr,
                    now,
                    today,
                    validation=validation,
                )
                if is_low:
                    result.low_confidence += 1
                else:
                    result.success += 1
            except Exception as e:
                logger.error(
                    f"明細失敗: {file.file_name}[{idx}]: {e}", extra={"step": "item_error"}
                )
                try:
                    cb.write_manual_entry_row(
                        row, file.drive_link, corrected[idx].date or today, f"明細[{idx}]失敗: {e}"
                    )
                    cb.update_reservation_status(rid, ProcessStatus.MANUAL_ENTRY.value)
                    result.manual_entry += 1
                except Exception:
                    cb.update_reservation_status(rid, ProcessStatus.ERROR.value)
                    result.errors += 1

        # 全明細が成功（success/low_confidence）で、manual_entry/error が1件もなければ
        # 元ファイル名に 【済】 を付与する
        fully_successful = (
            (result.success + result.low_confidence) > 0
            and result.manual_entry == 0
            and result.errors == 0
        )
        if fully_successful and not self._config.dry_run:
            try:
                self._drive.rename_file_as_done(file)
            except Exception as e:
                logger.error(
                    f"【済】付与失敗: {file.file_name}: {e}",
                    extra={"step": "rename_failed", "file_id": file.file_id},
                )

        return result

    # ── 1明細の書き込み ────────────────────────────────
    def _write_item(
        self,
        file: DriveFile,
        item: ReceiptItem,
        corrected: CorrectedItem,
        idx: int,
        row: int,
        rid: str,
        cb: CashbookClient,
        ocr: OcrResult,
        now: str,
        today: str,
        validation: AmountValidation | None = None,
    ) -> bool:
        """戻り値: True なら低信頼"""
        cb.copy_formulas_to_row(row)
        cb.write_cashbook_row(row, corrected, file.drive_link)
        cb.update_reservation_status(rid, ProcessStatus.WRITTEN.value)

        memo = corrected.memo or ""
        if validation and validation.matched_candidates:
            v_memo = f"金額候補: {validation.matched_candidates} (status={validation.status})"
            memo = f"{memo} | {v_memo}" if memo else v_memo

        cb.append_ai_log(
            AiLogRecord(
                timestamp=now,
                file_id=file.file_id,
                file_name=file.file_name,
                receipt_index=idx,
                ocr_engine=ocr.engine,
                ocr_confidence=ocr.confidence,
                date=item.date or "",
                amount=str(item.amount) if item.amount else "",
                vendor=item.vendor or "",
                description=item.description or "",
                account=item.account or "",
                tax_category=item.tax_category or "",
                corrected_account=corrected.account or "",
                corrected_tax_category=corrected.tax_category or "",
                corrections_applied=", ".join(corrected.corrections_applied),
                needs_review=corrected.needs_review,
                memo=memo,
            )
        )

        final = ProcessStatus.LOW_CONFIDENCE if corrected.needs_review else ProcessStatus.SUCCESS
        cb.update_reservation_status(rid, final.value)
        return corrected.needs_review

    # ── 金額検証 NG を manual_entry として書き込む ─────────
    def _write_amount_invalid_as_manual(
        self,
        file: DriveFile,
        item: ReceiptItem,
        corrected: CorrectedItem,
        validation: AmountValidation,
        idx: int,
        row: int,
        rid: str,
        cb: CashbookClient,
        ocr: OcrResult,
        now: str,
        today: str,
    ) -> None:
        """金額検証で NG になった明細を、詳細をO列に残して manual_entry 行にする"""
        error_msg = (
            f"金額検証NG ({validation.status}): {validation.reason} / "
            f"OCR候補: {validation.matched_candidates}"
        )
        logger.warning(
            f"金額検証NG → manual_entry: {file.file_name}[{idx}]: {error_msg}",
            extra={"step": "amount_invalid", "file_id": file.file_id},
        )
        cb.copy_formulas_to_row(row)
        cb.write_manual_entry_row(
            row,
            file.drive_link,
            corrected.date or today,
            error_msg,
        )
        cb.update_reservation_status(rid, ProcessStatus.WRITTEN.value)

        cb.append_ai_log(
            AiLogRecord(
                timestamp=now,
                file_id=file.file_id,
                file_name=file.file_name,
                receipt_index=idx,
                ocr_engine=ocr.engine,
                ocr_confidence=ocr.confidence,
                date=item.date or "",
                amount=str(item.amount) if item.amount else "",
                vendor=item.vendor or "",
                description=item.description or "",
                account=item.account or "",
                tax_category=item.tax_category or "",
                corrected_account=corrected.account or "",
                corrected_tax_category=corrected.tax_category or "",
                corrections_applied=", ".join(corrected.corrections_applied),
                needs_review=True,
                memo=(
                    f"金額検証NG: {validation.reason} / OCR候補: {validation.matched_candidates}"
                ),
            )
        )
        cb.update_reservation_status(rid, ProcessStatus.MANUAL_ENTRY.value)

    # ── 要手入力行 ─────────────────────────────────
    def _manual_entry(
        self,
        file: DriveFile,
        cb: CashbookClient,
        msg: str,
        date: str,
        now: str,
    ) -> None:
        logger.warning(f"要手入力: {file.file_name}: {msg}", extra={"step": "manual_entry"})
        if self._config.dry_run:
            return
        try:
            res = cb.reserve_rows(
                count=1, file_id=file.file_id, file_name=file.file_name, receipt_indices=[-1]
            )
            row, rid = res[0]
            cb.copy_formulas_to_row(row)
            cb.write_manual_entry_row(row, file.drive_link, date, f"{file.file_name}: {msg}")
            cb.update_reservation_status(rid, ProcessStatus.WRITTEN.value)
            cb.update_reservation_status(rid, ProcessStatus.MANUAL_ENTRY.value)
        except Exception as e:
            logger.error(f"要手入力行作成失敗: {e}", extra={"step": "manual_entry_error"})
            try:
                cb.append_process_record(
                    ProcessRecord(
                        file_id=file.file_id,
                        file_name=file.file_name,
                        receipt_index=-1,
                        mime_type=file.mime_type,
                        processed_at=now,
                        status=ProcessStatus.ERROR.value,
                        error_message=f"{msg} / 行作成も失敗: {e}",
                        retryable=True,
                        source_folder_id=file.folder_id,
                    )
                )
            except Exception:
                logger.error("管理レコード記録すら失敗", exc_info=True)

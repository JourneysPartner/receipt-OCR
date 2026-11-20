"""
処理オーケストレーター
マスターシート起点で全顧客を順次処理する。
顧客ごとの処理結果を集計し、マスターF列に詳細な状態を書き戻す。
"""

from datetime import datetime, timedelta, timezone

from src.ai.base import AiExtractor
from src.ai.gemini import RETRY_SUPPORTED_MIMES
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
    ReceiptDetails,
    ReceiptItem,
)
from src.ocr.base import OcrEngine
from src.processing.duplicates import (
    SAME_FILE_DUPLICATE_NOTE,
    ReceiptSource,
    description_line,
    details_of,
    is_same_voucher,
    same_file_duplicate_indices,
    source_of,
)
from src.processing.reconcile import (
    LABEL_READ,
    LABEL_REREAD,
    ItemDecision,
    readings_text,
    reconcile,
)
from src.rules.amount_validation import AmountValidation, build_review_label, validate_amount
from src.rules.corrections import RuleCorrector
from src.sheets.client import CashbookClient, MasterSheetClient, ProcessLogHeaderError

logger = setup_logger()
JST = timezone(timedelta(hours=9))


def _has_numbered_marks(file_id: str, processed_keys: set[str]) -> bool:
    """このファイルの番号 0 以上の処理済みの印があるか（`:-1` は数えない）。"""
    prefix = f"{file_id}:"
    for key in processed_keys:
        if key.startswith(prefix) and key[len(prefix) :].isdigit():
            return True
    return False


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
            # validate 用の予定件数
            "planned_success": 0,
            "planned_low_confidence": 0,
            "planned_manual_entry": 0,
            "planned_errors": 0,
            "planned_skipped": 0,
            # 実行モードを残す（後で集計ログに出す）
            "run_mode": self._config.runtime.run_mode,
            "target_scope": self._config.runtime.target_scope,
        }

        customers = self._master.read_customer_rows()

        # selected の場合は対象1顧客に絞る
        rt = self._config.runtime
        if rt.is_selected:
            customers = [self._select_target_customer(customers, rt.target_row)]
            logger.info(
                f"selected mode: 対象顧客 row={customers[0].row_number} "
                f"name={customers[0].customer_name!r}",
                extra={"step": "runtime_select"},
            )

        # ジョブ開始ログ
        logger.info(
            f"ジョブ開始: run_mode={rt.run_mode}, target_scope={rt.target_scope}, "
            f"target_row={rt.target_row}, 対象顧客数={len(customers)}",
            extra={"step": "job_runtime"},
        )

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
                if not rt.is_validate:
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
                if not rt.is_validate:
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
                # validate 集計（dry_run 時も結果は CustomerResult に詰まっている前提だが、
                # 現実装では _process_customer 経由の dry_run 経路で 0 件になることもあるので、
                # ここでは _process_file 単位の計上ではなく "計画件数" を別途取りたい）
                summary["planned_success"] += result.success
                summary["planned_low_confidence"] += result.low_confidence
                summary["planned_manual_entry"] += result.manual_entry
                summary["planned_errors"] += result.errors
                summary["planned_skipped"] += result.skipped
            except Exception as e:
                summary["error_customers"] += 1
                logger.error(
                    f"顧客処理失敗: {cust.customer_name}: {e}",
                    extra={"step": "customer_error"},
                    exc_info=True,
                )
                if not rt.is_validate:
                    now = datetime.now(JST).isoformat()
                    try:
                        self._master.update_customer_status(
                            cust.row_number,
                            f"エラー: {str(e)[:50]}",
                            now,
                        )
                    except Exception:
                        pass

        if rt.is_validate:
            logger.info(
                f"VALIDATE 集計: success予定={summary['planned_success']}, "
                f"low_conf予定={summary['planned_low_confidence']}, "
                f"manual_entry予定={summary['planned_manual_entry']}, "
                f"skipped={summary['planned_skipped']}, "
                f"error予定={summary['planned_errors']}",
                extra={"step": "validate_summary"},
            )
        logger.info(f"全顧客処理完了: {summary}", extra={"step": "summary"})
        return summary

    @staticmethod
    def _select_target_customer(customers, target_row: int | None):
        """selected モード時に対象 1 顧客を抽出する。
        - target_row が None / マッチ無し / 顧客行ではない場合は ValueError
        """
        if target_row is None:
            raise ValueError("TARGET_ROW が指定されていません (selected モード)")
        for c in customers:
            if c.row_number == target_row:
                if not c.customer_name.strip():
                    raise ValueError(f"指定行 {target_row} の顧客名が空欄です")
                return c
        raise ValueError(
            f"指定行 {target_row} に有効な顧客行が見つかりません "
            f"(マスター読み取り対象は data_start_row 以降)"
        )

    # ── 重複の判断（仕様 §3・§5・§6） ─────────────────────
    def _load_duplicate_sources(self, cb: CashbookClient) -> list[ReceiptSource]:
        """同じ顧客の処理管理から、照らす相手（§6.1）を読む。"""
        try:
            records = cb.get_duplicate_candidates()
        except Exception as e:
            logger.error(
                f"重複の照らす相手を読めません: {e}",
                extra={"step": "duplicate_history_error"},
            )
            return []
        if not isinstance(records, list):
            return []
        sources: list[ReceiptSource] = []
        for record in records:
            details = getattr(record, "details", None)
            index = getattr(record, "receipt_index", None)
            if not isinstance(details, ReceiptDetails) or not isinstance(index, int):
                continue
            sources.append(
                source_of(
                    str(getattr(record, "file_id", "")),
                    str(getattr(record, "file_name", "")),
                    index,
                    details,
                )
            )
        return sources

    @staticmethod
    def _details_for_items(
        items: list[ReceiptItem],
        text_items: list[ReceiptItem] | None = None,
        decisions: list[ItemDecision] | None = None,
    ) -> dict[int, ReceiptDetails]:
        """明細ごとの処理管理の値。両読みでは画像から、空なら文字から。"""
        details: dict[int, ReceiptDetails] = {}
        texts = list(text_items or [])
        for index, item in enumerate(items):
            fallback = None
            if texts:
                text_index = None
                if decisions is not None and index < len(decisions):
                    text_index = decisions[index].text_index
                if text_index is None and index < len(texts):
                    text_index = index
                if text_index is not None and text_index < len(texts):
                    fallback = texts[text_index]
            details[index] = details_of(item, fallback)
        return details

    @staticmethod
    def _cross_file_duplicates(
        file: DriveFile,
        details: dict[int, ReceiptDetails],
        indices: list[int],
        known: list[ReceiptSource],
    ) -> dict[int, ReceiptSource]:
        """別のファイルの明細と同じ証憑になる明細 → 重複元（§6.2）。"""
        duplicates: dict[int, ReceiptSource] = {}
        for index in indices:
            item = source_of(file.file_id, file.file_name, index, details[index])
            for source in known:
                if source.file_id == file.file_id:
                    continue
                if is_same_voucher(item, source):
                    duplicates[index] = source
                    break
        return duplicates

    def _log_duplicate_decisions(
        self,
        file: DriveFile,
        same_file: set[int],
        cross_file: dict[int, ReceiptSource],
    ) -> None:
        for index in sorted(same_file):
            logger.info(
                f"重複（同じファイル内）: {file.file_name}[{index}] → {SAME_FILE_DUPLICATE_NOTE}",
                extra={"step": "duplicate_decision", "file_id": file.file_id},
            )
        for index, source in sorted(cross_file.items()):
            logger.info(
                f"重複（別のファイル）: {file.file_name}[{index}] → {source.key}",
                extra={"step": "duplicate_decision", "file_id": file.file_id},
            )

    def _append_duplicate_records(
        self,
        file: DriveFile,
        cb: CashbookClient,
        details: dict[int, ReceiptDetails],
        cross_file: dict[int, ReceiptSource],
        now: str,
    ) -> None:
        """重複の明細は記帳せず、状態 `duplicate` の記録を 1 行ずつ書く（§6.2）。"""
        for index, source in sorted(cross_file.items()):
            cb.append_process_record(
                ProcessRecord(
                    file_id=file.file_id,
                    file_name=file.file_name,
                    receipt_index=index,
                    mime_type=file.mime_type,
                    processed_at=now,
                    status=ProcessStatus.DUPLICATE.value,
                    source_folder_id=file.folder_id,
                    details=details[index],
                    duplicate_of=source.key,
                )
            )

    def _write_duplicate_descriptions(
        self,
        file: DriveFile,
        cross_file: dict[int, ReceiptSource],
    ) -> None:
        if not cross_file:
            return
        lines = [description_line(index, source) for index, source in sorted(cross_file.items())]
        try:
            self._drive.append_description_lines(file, lines)
        except Exception as e:
            logger.error(
                f"説明欄の更新失敗: {file.file_name}: {e}",
                extra={"step": "description_failed", "file_id": file.file_id},
            )

    def _remember_booked(
        self,
        known: list[ReceiptSource],
        file: DriveFile,
        details: dict[int, ReceiptDetails],
        indices: list[int],
    ) -> None:
        """同じ実行の中で先に処理した明細も、後のファイルの照らす相手にする。"""
        for index in indices:
            known.append(source_of(file.file_id, file.file_name, index, details[index]))

    # ── 1顧客の処理 ────────────────────────────────
    def _process_customer(self, cust: CustomerRow) -> CustomerResult:
        now_str = datetime.now(JST).isoformat()
        today = datetime.now(JST).strftime("%Y-%m-%d")

        logger.info(f"顧客処理開始: {cust.customer_name}", extra={"step": "customer_start"})

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

        # 見出しが違えば、マスターの「処理中」も含めて何も書かずに止める（D6）。
        # 見出しを読めない等のその他の失敗は、今までどおりこの後の処理に任せる。
        try:
            cb.ensure_log_sheets_exist(write=False)
        except ProcessLogHeaderError:
            raise
        except Exception:
            pass

        # validate モードではマスターのF/I列を実書き換えしない（運用混乱防止）
        if not self._config.runtime.is_validate:
            self._master.update_customer_status(cust.row_number, "処理中", now_str)

        cb.ensure_log_sheets_exist(write=not self._config.dry_run)
        ttl = self._config.reservation_ttl_minutes
        if not self._config.dry_run:
            cb.cleanup_stale_reservations(ttl_minutes=ttl)
            cb.recover_stale_written(ttl_minutes=ttl)

        # レシートファイル取得
        files = self._drive.list_files(folder_id)
        if not files:
            logger.info(f"レシートなし: {cust.customer_name}", extra={"step": "customer_no_files"})
            if not self._config.runtime.is_validate:
                self._master.update_customer_status(cust.row_number, "完了（対象なし）", now_str)
            return CustomerResult()

        processed_keys = cb.get_processed_keys()
        # 別のファイルの重複を照らす相手（§6.1）。同じ実行で先に処理した分も足していく。
        known_sources = self._load_duplicate_sources(cb)

        # 全ファイルを処理し、結果を集計
        total = CustomerResult()
        for file in files:
            file_result = self._process_file(
                file,
                cb,
                processed_keys,
                today,
                now_str,
                known_receipts=known_sources,
            )
            total.success += file_result.success
            total.low_confidence += file_result.low_confidence
            total.manual_entry += file_result.manual_entry
            total.skipped += file_result.skipped
            total.errors += file_result.errors

        # 集計結果からF列の状態文字列を生成
        status_str = total.to_status_string()
        now_final = datetime.now(JST).isoformat()
        if not self._config.runtime.is_validate:
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
        *,
        known_receipts: list[ReceiptSource] | None = None,
    ) -> CustomerResult:
        if getattr(self._config.ai, "flow", "text_first") == "dual":
            return self._process_file_dual(
                file, cb, processed_keys, today, now, known_receipts=known_receipts
            )
        return self._process_file_text_first(
            file, cb, processed_keys, today, now, known_receipts=known_receipts
        )

    def _process_file_text_first(
        self,
        file: DriveFile,
        cb: CashbookClient,
        processed_keys: set[str],
        today: str,
        now: str,
        *,
        known_receipts: list[ReceiptSource] | None = None,
    ) -> CustomerResult:
        result = CustomerResult()
        known = known_receipts if known_receipts is not None else []

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

        # AI 抽出（OCRテキストから）
        items = self._ai.extract_receipt_data(ocr, file.file_name)
        first_extraction_error = self._ai.last_extraction_error
        first_extraction_count = len(items)

        # ── 抽出 retry ─────────────────────────────────────────
        # 初回抽出が 0 明細 / parse_error だった場合、Gemini multimodal で画像から再抽出
        extraction_retry_attempted = False
        extraction_retry_error: str | None = None
        extraction_retry_count = 0
        adopted_extraction_engine = "primary"
        if not items and self._config.ai.enable_extraction_retry:
            extraction_retry_attempted = True
            try:
                retry_extracted = self._ai.extract_from_file(file)
            except Exception as e:
                logger.error(
                    f"抽出retry例外: {file.file_name}: {e}",
                    extra={"step": "extraction_retry_error", "file_id": file.file_id},
                )
                retry_extracted = []
            extraction_retry_error = self._ai.last_extraction_error
            extraction_retry_count = len(retry_extracted)
            if retry_extracted:
                items = retry_extracted
                adopted_extraction_engine = "retry"
                logger.info(
                    f"AI抽出retry採用: {file.file_name} "
                    f"({first_extraction_error} → {extraction_retry_count}件)",
                    extra={"step": "extraction_retry_adopt", "file_id": file.file_id},
                )

        if not items:
            # 初回も retry もダメ → 抽出失敗 manual_entry
            ext_summary = self._format_extraction_memo(
                first_error=first_extraction_error,
                first_count=first_extraction_count,
                retry_attempted=extraction_retry_attempted,
                retry_error=extraction_retry_error,
                retry_count=extraction_retry_count,
                adopted=adopted_extraction_engine,
            )
            reason_label = self._extraction_failure_label(
                first_extraction_error, extraction_retry_attempted
            )
            self._manual_entry(
                file,
                cb,
                f"AI抽出失敗 ({first_extraction_error or 'unknown'}): {ext_summary}",
                today,
                now,
                short_label=reason_label,
            )
            result.manual_entry = 1
            return result

        corrected = [self._corrector.apply(it) for it in items]
        # 金額検証（OCR 候補との突合）
        validations = [validate_amount(it.amount, ocr.raw_text) for it in items]

        # 通常書き込みパスで AI詳細ログ memo に残す extraction 経路
        extraction_memo = self._format_extraction_memo(
            first_error=first_extraction_error,
            first_count=first_extraction_count,
            retry_attempted=extraction_retry_attempted,
            retry_error=extraction_retry_error,
            retry_count=extraction_retry_count,
            adopted=adopted_extraction_engine,
        )

        details_by_index = self._details_for_items(items)
        same_file_duplicates = same_file_duplicate_indices(items)

        if self._config.dry_run:
            # validate / dry_run: 書き込みは一切せず、判定のみで結果を集計する。
            # 予定件数を CustomerResult に詰めて返す（success/manual の候補件数が分かるよう）。
            cross_file = self._cross_file_duplicates(
                file, details_by_index, list(range(len(items))), known
            )
            self._log_duplicate_decisions(file, same_file_duplicates, cross_file)
            planned_success = 0
            planned_low = 0
            planned_manual = 0
            for i in range(len(corrected)):
                if i in cross_file:
                    continue
                v = validations[i]
                if v.should_manual_entry:
                    planned_manual += 1
                elif corrected[i].needs_review:
                    planned_low += 1
                else:
                    planned_success += 1
            result.success = planned_success
            result.low_confidence = planned_low
            result.manual_entry = planned_manual
            result.skipped = len(cross_file)
            self._remember_booked(
                known,
                file,
                details_by_index,
                [i for i in range(len(items)) if i not in cross_file],
            )
            logger.info(
                f"VALIDATE: {file.file_name} → "
                f"success予定={planned_success}, "
                f"low_conf予定={planned_low}, "
                f"manual予定={planned_manual}, "
                f"重複予定={len(cross_file)} "
                f"(total {len(corrected)} 明細, {extraction_memo})",
                extra={"step": "validate_file", "file_id": file.file_id},
            )
            return result

        # 未処理明細
        pending = [i for i in range(len(corrected)) if f"{file.file_id}:{i}" not in processed_keys]
        cross_file = self._cross_file_duplicates(file, details_by_index, pending, known)
        bookable = [i for i in pending if i not in cross_file]
        result.skipped = (len(corrected) - len(pending)) + len(cross_file)

        if cross_file:
            try:
                self._append_duplicate_records(file, cb, details_by_index, cross_file, now)
            except Exception as e:
                logger.error(
                    f"重複の記録失敗: {file.file_name}: {e}",
                    extra={"step": "duplicate_record_failed", "file_id": file.file_id},
                )
                result.errors += len(cross_file)

        if not bookable:
            if cross_file:
                self._write_duplicate_descriptions(file, cross_file)
                if len(cross_file) == len(items):
                    self._rename_as_duplicate(file)
            return result

        # ── Gemini 再抽出（amount_validation NG 時の第二段） ─────
        # NG 明細が1件以上あればファイル単位で1回だけ Gemini multimodal に画像/PDFを直接渡す
        retry_items: list[ReceiptItem] = []
        retry_attempted = False
        if self._config.ai.enable_amount_validation_retry and any(
            validations[i].should_manual_entry for i in bookable
        ):
            retry_attempted = True
            try:
                retry_items = self._ai.extract_from_file(file)
                logger.info(
                    f"AI再抽出: {file.file_name} → {len(retry_items)} 明細",
                    extra={"step": "ai_retry", "file_id": file.file_id},
                )
            except Exception as e:
                logger.error(
                    f"AI再抽出例外: {file.file_name}: {e}",
                    extra={"step": "ai_retry_error", "file_id": file.file_id},
                )

        # 行予約（重複の明細は予約しない）
        reservations = cb.reserve_rows(
            count=len(bookable),
            file_id=file.file_id,
            file_name=file.file_name,
            receipt_indices=bookable,
        )
        if reservations:
            try:
                reservation_details = [
                    (rid, details_by_index[idx]) for (_row, rid), idx in zip(reservations, bookable)
                ]
                cb.write_receipt_details(reservation_details)
            except Exception as e:
                logger.error(
                    f"処理管理の欄の書き込み失敗: {file.file_name}: {e}",
                    extra={"step": "receipt_details_failed", "file_id": file.file_id},
                )

        booked_indices: list[int] = []
        for (row, rid), idx in zip(reservations, bookable):
            primary_validation = validations[idx]
            cur_item = items[idx]
            cur_corrected = corrected[idx]
            cur_validation = primary_validation
            adopted_engine = "primary"
            retry_validation: AmountValidation | None = None
            duplicate_note = SAME_FILE_DUPLICATE_NOTE if idx in same_file_duplicates else None

            # 再抽出の採用判定: primary で NG だった明細だけ retry を試す
            if primary_validation.should_manual_entry and retry_items:
                retry_item = self._select_retry_item(retry_items, idx, len(items))
                if retry_item is not None:
                    rv = validate_amount(retry_item.amount, ocr.raw_text)
                    retry_validation = rv
                    if rv.is_valid:
                        # 採用: 再抽出結果で置き換え
                        cur_item = retry_item
                        cur_corrected = self._corrector.apply(retry_item)
                        cur_validation = rv
                        adopted_engine = "retry"
                        logger.info(
                            f"AI再抽出採用: {file.file_name}[{idx}] "
                            f"({primary_validation.status} → {rv.status})",
                            extra={"step": "ai_retry_adopt", "file_id": file.file_id},
                        )
                    else:
                        logger.info(
                            f"AI再抽出却下: {file.file_name}[{idx}] "
                            f"(primary={primary_validation.status}, retry={rv.status})",
                            extra={"step": "ai_retry_reject", "file_id": file.file_id},
                        )

            # 最終判定: それでも NG なら manual_entry
            if cur_validation.should_manual_entry:
                try:
                    self._write_amount_invalid_as_manual(
                        file,
                        cur_item,
                        cur_corrected,
                        cur_validation,
                        idx,
                        row,
                        rid,
                        cb,
                        ocr,
                        now,
                        today,
                        primary_validation=primary_validation,
                        retry_attempted=retry_attempted,
                        retry_validation=retry_validation,
                        adopted_engine=adopted_engine,
                        duplicate_note=duplicate_note,
                    )
                    result.manual_entry += 1
                    booked_indices.append(idx)
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
                    cur_item,
                    cur_corrected,
                    idx,
                    row,
                    rid,
                    cb,
                    ocr,
                    now,
                    today,
                    validation=cur_validation,
                    primary_validation=primary_validation,
                    retry_attempted=retry_attempted,
                    retry_validation=retry_validation,
                    adopted_engine=adopted_engine,
                    extraction_memo=extraction_memo,
                    duplicate_note=duplicate_note,
                )
                if is_low:
                    result.low_confidence += 1
                else:
                    result.success += 1
                booked_indices.append(idx)
            except Exception as e:
                logger.error(
                    f"明細失敗: {file.file_name}[{idx}]: {e}", extra={"step": "item_error"}
                )
                try:
                    message = f"明細[{idx}]失敗: {e}"
                    if duplicate_note:
                        message = f"{message}／{duplicate_note}"
                    cb.write_manual_entry_row(
                        row,
                        file.drive_link,
                        cur_corrected.date or today,
                        message,
                    )
                    cb.update_reservation_status(rid, ProcessStatus.MANUAL_ENTRY.value)
                    result.manual_entry += 1
                    booked_indices.append(idx)
                except Exception:
                    cb.update_reservation_status(rid, ProcessStatus.ERROR.value)
                    result.errors += 1

        self._remember_booked(known, file, details_by_index, booked_indices)

        # 全明細が成功（success/low_confidence）で、manual_entry/error が1件もなければ
        # 元ファイル名に 【済】 を付与する
        fully_successful = (
            (result.success + result.low_confidence) > 0
            and result.manual_entry == 0
            and result.errors == 0
        )
        self._write_duplicate_descriptions(file, cross_file)
        if len(cross_file) == len(items) and items:
            self._rename_as_duplicate(file)
        elif fully_successful and not self._config.dry_run:
            try:
                self._drive.rename_file_as_done(file)
            except Exception as e:
                logger.error(
                    f"【済】付与失敗: {file.file_name}: {e}",
                    extra={"step": "rename_failed", "file_id": file.file_id},
                )

        return result

    def _rename_as_duplicate(self, file: DriveFile) -> None:
        if self._config.dry_run:
            return
        try:
            self._drive.rename_file_as_duplicate(file)
        except Exception as e:
            logger.error(
                f"【重複】付与失敗: {file.file_name}: {e}",
                extra={"step": "rename_duplicate_failed", "file_id": file.file_id},
            )

    # ── 1ファイルの処理（両読み） ──────────────────────────
    def _process_file_dual(
        self,
        file: DriveFile,
        cb: CashbookClient,
        processed_keys: set[str],
        today: str,
        now: str,
        *,
        known_receipts: list[ReceiptSource] | None = None,
    ) -> CustomerResult:
        result = CustomerResult()
        known = known_receipts if known_receipts is not None else []

        # ファイル単位スキップ
        if f"{file.file_id}:-1" in processed_keys:
            result.skipped = 1
            return result

        # 画像からに使えない MIME は、ダウンロードの前に今までの流れへ回す
        if file.mime_type not in RETRY_SUPPORTED_MIMES:
            return self._process_file_text_first(
                file, cb, processed_keys, today, now, known_receipts=known
            )

        # ダウンロード
        try:
            file = self._drive.download_file(file)
        except Exception as e:
            self._manual_entry(file, cb, f"DL失敗: {e}", today, now)
            result.manual_entry = 1
            return result

        # OCR（失敗か空でも止めず、文字は空として進む）
        ocr = self._ocr.extract_text(file)
        ocr_ok = not ocr.error and bool(ocr.raw_text.strip())
        ocr_text = ocr.raw_text if ocr_ok else ""

        # 画像から（1 回だけ。先に呼ぶ）
        try:
            image_items = self._ai.extract_from_file(file)
            image_error = self._ai.last_extraction_error
        except Exception as e:
            logger.error(
                f"両読み 画像からの抽出例外: {file.file_name}: {e}",
                extra={"step": "dual_image_error", "file_id": file.file_id},
            )
            image_items = []
            image_error = "api_error"

        # 文字から（OCR が失敗か空なら呼ばない。1 回だけ）
        if ocr_ok:
            try:
                text_items = self._ai.extract_receipt_data(ocr, file.file_name)
                text_error = self._ai.last_extraction_error
            except Exception as e:
                logger.error(
                    f"両読み 文字からの抽出例外: {file.file_name}: {e}",
                    extra={"step": "dual_text_error", "file_id": file.file_id},
                )
                text_items = []
                text_error = "api_error"
        else:
            text_items = []
            text_error = "ocr_failed"

        # どちらも空 → 今の「抽出失敗」と同じ要確認の行を 1 行
        if not image_items and not text_items:
            reason_label = "※OCR/抽出要確認" if not ocr_ok else "※AI抽出要確認"
            self._manual_entry(
                file,
                cb,
                f"AI抽出失敗（両読み）: 画像={image_error or 'none'}, 文字={text_error or 'none'}",
                today,
                now,
                short_label=reason_label,
            )
            result.manual_entry = 1
            return result

        # 画像からが空で文字からがある → 文字からの明細を全部要確認
        if not image_items:
            items = text_items
            decisions = [
                ItemDecision(False, LABEL_READ, "画像からの読みが無い", None) for _ in items
            ]
        else:
            items = image_items
            decisions = reconcile(image_items, text_items, ocr_text)

        corrected = [self._corrector.apply(it) for it in items]
        # 金額検証（記録用。合ったかどうかの判断には使わない）
        validations = [validate_amount(it.amount, ocr_text) for it in items]
        summary = readings_text(image_items, text_items)
        fallback_items = text_items if image_items else []
        details_by_index = self._details_for_items(items, fallback_items, decisions)
        same_file_duplicates = same_file_duplicate_indices(items)

        # 未処理明細（番号は使う明細の並び順）
        pending = [i for i in range(len(items)) if f"{file.file_id}:{i}" not in processed_keys]

        # 読み直し: このファイルの番号 0 以上の印が 1 つでもあれば、
        # まだ印の無い明細は合っていても自動にしない（二重の転記を避ける。監査 H1）
        if _has_numbered_marks(file.file_id, processed_keys):
            reread = ItemDecision(False, LABEL_REREAD, "前の回と明細の数か並びが変わった疑い", None)
            decisions = [reread if i in pending else d for i, d in enumerate(decisions)]

        if self._config.dry_run:
            # validate / dry_run: 書き込みは一切せず、判定のみで結果を集計する。
            cross_file = self._cross_file_duplicates(
                file, details_by_index, list(range(len(items))), known
            )
            self._log_duplicate_decisions(file, same_file_duplicates, cross_file)
            planned_success = 0
            planned_low = 0
            planned_manual = 0
            for i in range(len(items)):
                if i in cross_file:
                    continue
                if not decisions[i].matched:
                    planned_manual += 1
                elif corrected[i].needs_review:
                    planned_low += 1
                else:
                    planned_success += 1
            result.success = planned_success
            result.low_confidence = planned_low
            result.manual_entry = planned_manual
            result.skipped = len(cross_file)
            self._remember_booked(
                known,
                file,
                details_by_index,
                [i for i in range(len(items)) if i not in cross_file],
            )
            logger.info(
                f"VALIDATE: {file.file_name} → "
                f"success予定={planned_success}, "
                f"low_conf予定={planned_low}, "
                f"manual予定={planned_manual}, "
                f"重複予定={len(cross_file)} "
                f"(total {len(items)} 明細, 両読み: {summary})",
                extra={"step": "validate_file", "file_id": file.file_id},
            )
            return result

        # 未処理明細の数から、処理済みの数を残す。重複は予約しない。
        cross_file = self._cross_file_duplicates(file, details_by_index, pending, known)
        bookable = [i for i in pending if i not in cross_file]
        result.skipped = (len(items) - len(pending)) + len(cross_file)

        if cross_file:
            try:
                self._append_duplicate_records(file, cb, details_by_index, cross_file, now)
            except Exception as e:
                logger.error(
                    f"重複の記録失敗: {file.file_name}: {e}",
                    extra={"step": "duplicate_record_failed", "file_id": file.file_id},
                )
                result.errors += len(cross_file)

        if not bookable:
            if cross_file:
                self._write_duplicate_descriptions(file, cross_file)
                if len(cross_file) == len(items):
                    self._rename_as_duplicate(file)
            return result

        # 行予約（予約する行の数 = 記帳する明細の数）
        reservations = cb.reserve_rows(
            count=len(bookable),
            file_id=file.file_id,
            file_name=file.file_name,
            receipt_indices=bookable,
        )
        if reservations:
            try:
                reservation_details = [
                    (rid, details_by_index[idx]) for (_row, rid), idx in zip(reservations, bookable)
                ]
                cb.write_receipt_details(reservation_details)
            except Exception as e:
                logger.error(
                    f"処理管理の欄の書き込み失敗: {file.file_name}: {e}",
                    extra={"step": "receipt_details_failed", "file_id": file.file_id},
                )

        booked_indices: list[int] = []
        for (row, rid), idx in zip(reservations, bookable):
            decision = decisions[idx]
            duplicate_note = SAME_FILE_DUPLICATE_NOTE if idx in same_file_duplicates else None

            if decision.matched:
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
                        validation=validations[idx],
                        extraction_memo=f"両読み=一致 | {summary}",
                        duplicate_note=duplicate_note,
                    )
                    if is_low:
                        result.low_confidence += 1
                    else:
                        result.success += 1
                    booked_indices.append(idx)
                except Exception as e:
                    logger.error(
                        f"明細失敗: {file.file_name}[{idx}]: {e}",
                        extra={"step": "item_error"},
                    )
                    try:
                        message = f"明細[{idx}]失敗: {e}"
                        if duplicate_note:
                            message = f"{message}／{duplicate_note}"
                        cb.write_manual_entry_row(
                            row,
                            file.drive_link,
                            corrected[idx].date or today,
                            message,
                        )
                        cb.update_reservation_status(rid, ProcessStatus.MANUAL_ENTRY.value)
                        result.manual_entry += 1
                        booked_indices.append(idx)
                    except Exception:
                        cb.update_reservation_status(rid, ProcessStatus.ERROR.value)
                        result.errors += 1
                continue

            try:
                self._write_dual_review(
                    file,
                    items[idx],
                    corrected[idx],
                    decision,
                    idx,
                    row,
                    rid,
                    cb,
                    ocr,
                    now,
                    today,
                    summary,
                    duplicate_note=duplicate_note,
                )
                result.manual_entry += 1
                booked_indices.append(idx)
            except Exception as e:
                logger.error(
                    f"両読み要確認行作成失敗: {file.file_name}[{idx}]: {e}",
                    extra={"step": "item_error_dual"},
                )
                cb.update_reservation_status(rid, ProcessStatus.ERROR.value)
                result.errors += 1

        self._remember_booked(known, file, details_by_index, booked_indices)

        # 全明細が成功（success/low_confidence）で、manual_entry/error が1件もなければ
        # 元ファイル名に 【済】 を付与する
        fully_successful = (
            (result.success + result.low_confidence) > 0
            and result.manual_entry == 0
            and result.errors == 0
        )
        self._write_duplicate_descriptions(file, cross_file)
        if len(cross_file) == len(items) and items:
            self._rename_as_duplicate(file)
        elif fully_successful and not self._config.dry_run:
            try:
                self._drive.rename_file_as_done(file)
            except Exception as e:
                logger.error(
                    f"【済】付与失敗: {file.file_name}: {e}",
                    extra={"step": "rename_failed", "file_id": file.file_id},
                )

        return result

    # ── 両読みで合わなかった明細を manual_entry として書き込む ─────
    def _write_dual_review(
        self,
        file: DriveFile,
        item: ReceiptItem,
        corrected: CorrectedItem,
        decision: ItemDecision,
        idx: int,
        row: int,
        rid: str,
        cb: CashbookClient,
        ocr: OcrResult,
        now: str,
        today: str,
        summary: str,
        *,
        duplicate_note: str | None = None,
    ) -> None:
        """画像からの明細を、両方の読みを残して manual_entry 行にする。"""
        error_msg = f"両読み要確認（{decision.reason}）: {summary}"
        if duplicate_note:
            error_msg = f"{error_msg}／{duplicate_note}"
        logger.warning(
            f"両読み要確認 → manual_entry: {file.file_name}[{idx}]: {error_msg}",
            extra={"step": "dual_review", "file_id": file.file_id},
        )
        cb.copy_formulas_to_row(row)
        cb.write_manual_entry_row(
            row,
            file.drive_link,
            corrected.date or today,
            error_msg,
            corrected=corrected,
            short_label=decision.label,
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
                memo=error_msg,
            )
        )
        cb.update_reservation_status(rid, ProcessStatus.MANUAL_ENTRY.value)

    @staticmethod
    def _select_retry_item(
        retry_items: list[ReceiptItem],
        idx: int,
        original_count: int,
    ) -> ReceiptItem | None:
        """再抽出結果から idx 番目に対応する明細を選ぶ。
        - retry_items 件数 == 元 items 件数 → retry_items[idx]
        - 1:1 マッピング不能でも 1件 vs 1件なら retry_items[0]
        - それ以外（明細件数が変わった等）はマッピング不能で None
        """
        if not retry_items:
            return None
        if len(retry_items) == original_count and idx < len(retry_items):
            return retry_items[idx]
        if len(retry_items) == 1 and original_count == 1:
            return retry_items[0]
        return None

    @staticmethod
    def _format_extraction_memo(
        *,
        first_error: str | None,
        first_count: int,
        retry_attempted: bool,
        retry_error: str | None,
        retry_count: int,
        adopted: str,
    ) -> str:
        """AI抽出 retry の経路を構造化文字列化する。
        例:
        `extraction=retry_used:zero_items→3items | adopted=retry`
        `extraction=primary_only:3items`
        `extraction=retry_failed:parse_error→0items | adopted=primary`
        """
        if not retry_attempted:
            return f"extraction=primary_only:{first_count}items (error={first_error or 'none'})"
        suffix = "retry_used" if adopted == "retry" else "retry_failed"
        return (
            f"extraction={suffix}:"
            f"{first_error or 'none'}→"
            f"{retry_count}items "
            f"(retry_error={retry_error or 'none'}, adopted={adopted})"
        )

    @staticmethod
    def _extraction_failure_label(first_error: str | None, retry_attempted: bool) -> str:
        """抽出失敗 manual_entry に付ける短文ラベル。
        - retry を試みた → `※AI抽出要確認`
        - そもそも OCR が空など → `※OCR/抽出要確認`
        - その他 → `※抽出失敗要確認`
        """
        if first_error == "ocr_empty":
            return "※OCR/抽出要確認"
        if retry_attempted:
            return "※AI抽出要確認"
        return "※抽出失敗要確認"

    @staticmethod
    def _format_retry_memo(
        primary: AmountValidation | None,
        retry_attempted: bool,
        retry: AmountValidation | None,
        adopted: str,
    ) -> str:
        """AI詳細ログ memo に乗せる retry 関連情報を整形する。
        例: `retry=gemini_image | amount_status=digit_inflation→ok | adopted=retry`
        """
        parts: list[str] = []
        if retry_attempted:
            parts.append("retry=gemini_image")
        else:
            parts.append("retry=no")
        primary_st = primary.status if primary else "-"
        retry_st = retry.status if retry else "-"
        if retry_attempted:
            parts.append(f"amount_status={primary_st}→{retry_st}")
        else:
            parts.append(f"amount_status={primary_st}")
        parts.append(f"adopted={adopted}")
        return " | ".join(parts)

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
        primary_validation: AmountValidation | None = None,
        retry_attempted: bool = False,
        retry_validation: AmountValidation | None = None,
        adopted_engine: str = "primary",
        extraction_memo: str | None = None,
        duplicate_note: str | None = None,
    ) -> bool:
        """戻り値: True なら低信頼"""
        cb.copy_formulas_to_row(row)
        cb.write_cashbook_row(row, corrected, file.drive_link)
        if duplicate_note:
            try:
                cb.write_error_detail(row, duplicate_note)
            except Exception as e:
                logger.error(
                    f"重複の注記に失敗: {file.file_name}[{idx}]: {e}",
                    extra={"step": "duplicate_note_failed", "file_id": file.file_id},
                )
        cb.update_reservation_status(rid, ProcessStatus.WRITTEN.value)

        memo = corrected.memo or ""
        retry_memo = self._format_retry_memo(
            primary=primary_validation or validation,
            retry_attempted=retry_attempted,
            retry=retry_validation,
            adopted=adopted_engine,
        )
        memo = f"{memo} | {retry_memo}" if memo else retry_memo
        if extraction_memo:
            memo = f"{extraction_memo} | {memo}" if memo else extraction_memo
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
        primary_validation: AmountValidation | None = None,
        retry_attempted: bool = False,
        retry_validation: AmountValidation | None = None,
        adopted_engine: str = "primary",
        duplicate_note: str | None = None,
    ) -> None:
        """金額検証で NG になった明細を、詳細をO列に残して manual_entry 行にする。
        candidate（corrected）の取引先・摘要・税区分・勘定科目コード等は
        書き込んだうえで、K列冒頭に `※金額要確認` 等の具体ラベルを付ける。
        AI再抽出の有無と判定遷移は memo / O列に残す。
        """
        retry_memo = self._format_retry_memo(
            primary=primary_validation or validation,
            retry_attempted=retry_attempted,
            retry=retry_validation,
            adopted=adopted_engine,
        )
        error_msg = (
            f"金額検証NG ({validation.status}): {validation.reason} / "
            f"OCR候補: {validation.matched_candidates} | {retry_memo}"
        )
        if duplicate_note:
            error_msg = f"{error_msg}／{duplicate_note}"
        logger.warning(
            f"金額検証NG → manual_entry: {file.file_name}[{idx}]: {error_msg}",
            extra={"step": "amount_invalid", "file_id": file.file_id},
        )
        label = build_review_label(amount_validation=validation)
        cb.copy_formulas_to_row(row)
        cb.write_manual_entry_row(
            row,
            file.drive_link,
            corrected.date or today,
            error_msg,
            corrected=corrected,
            short_label=label,
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
                    f"金額検証NG: {validation.reason} / "
                    f"OCR候補: {validation.matched_candidates} | {retry_memo}"
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
        *,
        short_label: str | None = None,
    ) -> None:
        logger.warning(
            f"要手入力: {file.file_name}: {msg} (label={short_label or '※要手入力'})",
            extra={"step": "manual_entry"},
        )
        if self._config.dry_run:
            return
        try:
            res = cb.reserve_rows(
                count=1, file_id=file.file_id, file_name=file.file_name, receipt_indices=[-1]
            )
            row, rid = res[0]
            cb.copy_formulas_to_row(row)
            cb.write_manual_entry_row(
                row,
                file.drive_link,
                date,
                f"{file.file_name}: {msg}",
                short_label=short_label,
            )
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

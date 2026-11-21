"""RUN_MODE=compare の実行（仕様 §5）。"""

import os
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone

from src.ai.factory import create_ai_extractor
from src.compare.answers import attach_values, build_answer_plan
from src.compare.config import (
    METHOD_LABELS,
    VENDOR_ANTHROPIC,
    VENDOR_GEMINI,
    VENDOR_GOOGLE,
    VENDOR_OPENAI,
    CompareConfig,
    CompareModel,
    load_compare_config,
    ocr_tab_name,
    result_tab_name,
    summary_tab_name,
    vendor_of,
)
from src.compare.forms import build_form_tables, build_inputs, needs_call
from src.compare.pipeline import (
    METHOD_CURRENT,
    METHOD_DUAL,
    METHOD_IMAGE,
    METHOD_TEXT,
    AttemptOutcome,
    CompareRow,
    build_current_flow_row,
    build_dual_row,
    extract_once,
    extract_with_retries,
    make_result_row,
    settings_text,
)
from src.compare.readers import (
    create_compare_reader,
    create_model_checker,
    reader_settings_text,
    redact_secrets,
)
from src.compare.score import derive_methods, derive_models, estimate_cost, summary_rows
from src.compare.sheet import (
    ANSWER_CELLS,
    ANSWER_HEADERS,
    FORM_DETAIL_HEADERS,
    FORM_HEADERS,
    MULTI_ANSWER_HEADERS,
    MULTI_ANSWER_TITLE,
    OCR_HEADERS,
    OCR_HEADERS_OLD,
    RESULT_HEADERS,
    SUMMARY_HEADERS,
    CompareSheetClient,
    HeaderMismatchError,
    form_detail_tab_name,
    form_tab_name,
    multi_answer_layout,
)
from src.config import AiConfig, AppConfig
from src.drive.client import DriveClient
from src.logging.logger import setup_logger
from src.models import extract_id_from_url
from src.ocr.factory import create_ocr_engine
from src.processing.reconcile import reconcile

logger = setup_logger()
JST = timezone(timedelta(hours=9))

DEFAULT_RETRY_SLEEPS = (10, 30, 60)


def _not_found(error) -> bool:
    code = getattr(error, "code", None)
    if code is None:
        code = getattr(error, "status_code", None)
    resp = getattr(error, "resp", None)
    if code is None:
        code = getattr(resp, "status", None)
    if code is not None:
        try:
            if int(code) == 404:
                return True
        except (TypeError, ValueError):
            pass
    text = str(error).upper()
    return "NOT_FOUND" in text or "404" in text


class _ThreadResources:
    """Drive と OCR はスレッドごと、GeminiExtractor はスレッドと型の組ごとに作る。"""

    def __init__(self, drive_factory, ocr_factory, extractor_factory, reader_factory=None):
        self._drive_factory = drive_factory
        self._ocr_factory = ocr_factory
        self._extractor_factory = extractor_factory
        self._reader_factory = reader_factory
        self._local = threading.local()

    def drive(self):
        drive = getattr(self._local, "drive", None)
        if drive is None:
            drive = self._drive_factory()
            self._local.drive = drive
        return drive

    def ocr(self):
        ocr = getattr(self._local, "ocr", None)
        if ocr is None:
            ocr = self._ocr_factory()
            self._local.ocr = ocr
        return ocr

    def extractor(self, model: CompareModel, ai_config: AiConfig):
        # スレッド番号は使い回されるので鍵にしない（スレッドごとの辞書に型で引く）
        extractors = getattr(self._local, "extractors", None)
        if extractors is None:
            extractors = {}
            self._local.extractors = extractors
        extractor = extractors.get(model.label)
        if extractor is None:
            extractor = self._extractor_factory(ai_config)
            extractors[model.label] = extractor
        return extractor

    def reader(self, model: CompareModel, ai_config: AiConfig):
        """読み手も、スレッドと型の組ごとに作る（§5.2）。"""
        readers = getattr(self._local, "readers", None)
        if readers is None:
            readers = {}
            self._local.readers = readers
        reader = readers.get(model.label)
        if reader is None:
            reader = self._reader_factory(ai_config)
            readers[model.label] = reader
        return reader


@dataclass
class _FileTask:
    file: object
    folder_name: str
    models: list[CompareModel]
    readers: list[CompareModel] = field(default_factory=list)


class CompareRunner:
    def __init__(
        self,
        config: AppConfig,
        compare_config: CompareConfig,
        *,
        sheet: CompareSheetClient,
        drive_factory,
        ocr_factory,
        extractor_factory,
        model_checker,
        reader_checker=None,
        reader_factory=None,
        judge_post=None,
        sleep=time.sleep,
        clock=time.monotonic,
        jst_now=None,
        retry_sleeps=DEFAULT_RETRY_SLEEPS,
        started_at: float | None = None,
    ):
        self._config = config
        self._compare = compare_config
        self._sheet = sheet
        self._sleep = sleep
        self._clock = clock
        # 時間の数え始めはプロセスの始め（run_compare に入った時点）
        self._started_at = self._clock() if started_at is None else started_at
        self._jst_now = jst_now or (lambda: datetime.now(JST))
        self._retry_sleeps = tuple(retry_sleeps)
        self._resources = _ThreadResources(
            drive_factory, ocr_factory, extractor_factory, reader_factory
        )
        self._model_checker = model_checker
        self._reader_checker = reader_checker
        self._judge_post = judge_post
        self._unusable: list[str] = []

    # ── 入口 ────────────────────────────────────
    def run(self) -> int:
        if self._compare.step == "score":
            return self._run_score()
        return self._run_collect()

    def _run_score(self) -> int:
        titles = self._sheet.get_sheet_titles()
        label = self._compare.run_label
        if not label:
            result_titles = [title for title in titles if title.startswith("結果_")]
            if len(result_titles) > 1:
                # 名前の大小は新しさと関係が無いので、推測せずに選ばせる
                logger.error(
                    "COMPARE_RUN_LABEL を指定してください（結果_ で始まるタブが複数あります）: "
                    + ", ".join(result_titles),
                    extra={"step": "compare_label_error"},
                )
                return 1
            if not result_titles:
                logger.error(
                    "COMPARE_RUN_LABEL が無く、結果_<ラベル> タブも見つかりません",
                    extra={"step": "compare_label_error"},
                )
                return 1
            label = result_titles[0][len("結果_") :]
        result_title = result_tab_name(label)
        answer_title = "答え"
        if result_title not in titles or answer_title not in titles:
            logger.error(
                f"比較の表に必要なタブがありません: {result_title} / {answer_title}",
                extra={"step": "compare_tab_error"},
            )
            return 1

        # 何かを書く前に 1 行目を読むだけで確かめる（列を足すと「メモ」を上書きしうる）
        if not self._verify_headers(
            titles,
            [
                (answer_title, ANSWER_HEADERS, True),
                (result_title, RESULT_HEADERS, False),
                (MULTI_ANSWER_TITLE, MULTI_ANSWER_HEADERS, False),
            ],
        ):
            return 1

        try:
            self._ensure_multi_answer()
        except HeaderMismatchError as error:
            logger.error(
                f"{error}。列を足したり並べ替えたりせずに直してください",
                extra={"step": "compare_header_mismatch"},
            )
            return 1

        result_rows = self._sheet.read_dicts(result_title)
        answer_rows = attach_values(
            self._sheet.read_dicts(answer_title, formatted=True, cells=ANSWER_CELLS)
        )
        plan = build_answer_plan(
            answer_title=answer_title,
            existing_rows=answer_rows,
            file_infos=[],
            result_rows=result_rows,
            now_text=self._now_text(),
        )
        self._sheet.batch_update_cells(plan.updates)
        self._sheet.append_rows(answer_title, plan.append_rows, len(ANSWER_HEADERS))
        answer_rows = attach_values(
            self._sheet.read_dicts(answer_title, formatted=True, cells=ANSWER_CELLS)
        )

        # COMPARE_MODELS / COMPARE_METHODS を省いたときは、結果タブの列から並びを作る
        config = self._compare
        if not config.models_set:
            config = replace(config, models=derive_models(result_rows) or config.models)
        if not config.methods_set:
            config = replace(config, methods=derive_methods(result_rows) or config.methods)

        failed = False
        multi_rows: list[dict] = []
        try:
            multi_rows = self._read_multi_answers()
        except Exception as error:
            logger.error(
                f"答えを読めません: {type(error).__name__}: {self._redact_secrets(error)}",
                extra={"step": "compare_finalize_error"},
            )
            failed = True

        summary_title = summary_tab_name(label)
        self._sheet.ensure_tab(summary_title, SUMMARY_HEADERS, check_headers=False)
        self._sheet.replace_all(
            summary_title,
            summary_rows(
                config=config,
                result_rows=result_rows,
                answer_rows=answer_rows,
                label=label,
                now_text=self._now_text(),
                multi_rows=multi_rows,
            ),
        )
        forms_ok = self._write_forms(label, result_rows, answer_rows, multi_rows)
        logger.info(f"比較の集計を更新: {label}", extra={"step": "compare_score"})
        return 1 if failed or not forms_ok else 0

    def _run_collect(self) -> int:
        label = self._compare.run_label
        if not label:
            logger.error(
                "COMPARE_RUN_LABEL を決められません", extra={"step": "compare_label_error"}
            )
            return 1
        result_title = result_tab_name(label)
        ocr_title = ocr_tab_name(label)
        answer_title = "答え"
        summary_title = summary_tab_name(label)

        # タブを作る・列を足す・見出しを書く前に、既にあるタブの 1 行目を読むだけで確かめる
        if not self._verify_headers(
            self._sheet.get_sheet_titles(),
            [
                (answer_title, ANSWER_HEADERS, True),
                (result_title, RESULT_HEADERS, False),
                (ocr_title, OCR_HEADERS, False),
                (MULTI_ANSWER_TITLE, MULTI_ANSWER_HEADERS, False),
            ],
        ):
            return 1

        try:
            self._sheet.ensure_tab(answer_title, ANSWER_HEADERS, prefix_only=True)
            self._sheet.ensure_tab(result_title, RESULT_HEADERS)
            # ページ数の無い古い OCR タブも通す（見出しは書き直さず、列だけ足す）
            self._sheet.ensure_tab(ocr_title, OCR_HEADERS, check_headers=False)
            self._ensure_multi_answer()
        except HeaderMismatchError as error:
            # 列が足されると「メモ」などを上書きしうるので、何も書かずに 1 で終わる
            logger.error(
                f"{error}。列を足したり並べ替えたりせずに直してください",
                extra={"step": "compare_header_mismatch"},
            )
            return 1

        infos: list = []
        models_left: dict[str, list] = {}
        submitted_ids: set[str] = set()
        budget_exceeded = False
        failed = False

        try:
            self._check_models()
            self._check_readers()
            usable = [m for m in self._compare.models if m.label not in self._unusable]
            usable_readers = [
                reader for reader in self._compare.readers if reader.label not in self._unusable
            ]

            infos = self._collect_files()
            done = self._done_map(self._sheet.read_dicts(result_title))
            models_left = {
                info.file.file_id: [
                    model
                    for model in usable
                    if not self._model_done(done, info.file.file_id, model)
                ]
                for info in infos
            }
            readers_left = {
                info.file.file_id: [
                    reader
                    for reader in usable_readers
                    if not self._reader_done(done, info.file.file_id, reader)
                ]
                for info in infos
            }

            with ThreadPoolExecutor(max_workers=self._compare.max_workers) as executor:
                iterator = iter(infos)
                pending: dict = {}
                while True:
                    while len(pending) < self._compare.max_workers and not budget_exceeded:
                        if iterator is None:
                            break
                        try:
                            info = next(iterator)
                        except StopIteration:
                            iterator = None
                            break
                        if self._time_over_budget():
                            budget_exceeded = True
                            break
                        models = models_left[info.file.file_id]
                        readers = readers_left[info.file.file_id]
                        if not models and not readers:
                            continue  # 全部済みのファイルはダウンロードもしない
                        task = _FileTask(
                            file=info.file,
                            folder_name=info.folder_name,
                            models=models,
                            readers=readers,
                        )
                        pending[executor.submit(self._process_file, task)] = task
                        submitted_ids.add(info.file.file_id)

                    if not pending:
                        if budget_exceeded or iterator is None:
                            break
                        continue

                    completed, _ = wait(pending, return_when=FIRST_COMPLETED)
                    for future in completed:
                        task = pending.pop(future)
                        try:
                            rows, ocr_row = future.result()
                        except Exception as error:  # 念のための最終防衛
                            logger.error(
                                f"ファイル処理が異常終了: {task.file.file_name}: "
                                f"{self._redact_secrets(error)}",
                                extra={"step": "compare_file_fatal"},
                            )
                            rows, ocr_row = [], None
                        if rows:
                            self._sheet.append_rows(
                                result_title,
                                [row.to_sheet_row() for row in rows],
                                len(RESULT_HEADERS),
                            )
                        if ocr_row is not None:
                            self._sheet.append_rows(ocr_title, [ocr_row], len(OCR_HEADERS))

                    if budget_exceeded and not pending:
                        break
        except Exception as error:
            # 表への追記の失敗など。それまでの結果で答えと集計は書いてから 1 にする
            logger.error(
                f"比較の実行中に例外: {type(error).__name__}: {self._redact_secrets(error)}",
                extra={"step": "compare_collect_error"},
            )
            failed = True

        if budget_exceeded:
            remaining = sum(
                1
                for info in infos
                if info.file.file_id not in submitted_ids
                and (models_left.get(info.file.file_id) or readers_left.get(info.file.file_id))
            )
            logger.info(
                f"時間切れのため新しいファイルを始めません: 残り {remaining} 本。"
                f"同じ COMPARE_RUN_LABEL={label} で再実行すると続きから",
                extra={"step": "compare_time_budget"},
            )

        # 審判の回（仕様 spec_judge_form §5.1）。COMPARE_JUDGES が無ければ何もしない。
        if not self._run_judges(label, result_title, ocr_title, infos):
            failed = True

        # それまでの結果で「答え」と「集計」を書けるだけ書く（書けなくても次を試す）
        try:
            result_rows = self._sheet.read_dicts(result_title)
        except Exception as error:
            logger.error(
                f"結果を読めません: {type(error).__name__}: {self._redact_secrets(error)}",
                extra={"step": "compare_finalize_error"},
            )
            return 1

        answer_rows: list[dict] = []
        try:
            answer_rows = attach_values(
                self._sheet.read_dicts(answer_title, formatted=True, cells=ANSWER_CELLS)
            )
            plan = build_answer_plan(
                answer_title=answer_title,
                existing_rows=answer_rows,
                file_infos=[
                    {
                        "file_id": info.file.file_id,
                        "file_name": info.file.file_name,
                        "folder_name": info.folder_name,
                    }
                    for info in infos
                ],
                result_rows=result_rows,
                now_text=self._now_text(),
            )
            self._sheet.batch_update_cells(plan.updates)
            self._sheet.append_rows(answer_title, plan.append_rows, len(ANSWER_HEADERS))
            answer_rows = attach_values(
                self._sheet.read_dicts(answer_title, formatted=True, cells=ANSWER_CELLS)
            )
        except Exception as error:
            logger.error(
                f"答えを書けません: {type(error).__name__}: {self._redact_secrets(error)}",
                extra={"step": "compare_finalize_error"},
            )
            answer_rows = []
            failed = True

        multi_rows: list[dict] = []
        try:
            multi_rows = self._read_multi_answers()
        except Exception as error:
            logger.error(
                f"答えを読めません: {type(error).__name__}: {self._redact_secrets(error)}",
                extra={"step": "compare_finalize_error"},
            )
            failed = True

        try:
            self._sheet.ensure_tab(summary_title, SUMMARY_HEADERS, check_headers=False)
            self._sheet.replace_all(
                summary_title,
                summary_rows(
                    config=self._compare,
                    result_rows=result_rows,
                    answer_rows=answer_rows,
                    label=label,
                    now_text=self._now_text(),
                    unusable_models=self._unusable,
                    multi_rows=multi_rows,
                ),
            )
        except Exception as error:
            logger.error(
                f"集計を書けません: {type(error).__name__}: {self._redact_secrets(error)}",
                extra={"step": "compare_finalize_error"},
            )
            return 1

        forms_ok = self._write_forms(label, result_rows, answer_rows, multi_rows)
        logger.info(
            f"比較の collect 完了: {label}（処理 {len(submitted_ids)} 本）",
            extra={"step": "compare_collect"},
        )
        return 1 if failed or not forms_ok else 0

    # ── 準備 ────────────────────────────────────
    def _ensure_multi_answer(self) -> None:
        ensure = getattr(self._sheet, "ensure_multi_answer_tab", None)
        if ensure is not None:
            ensure()
            return
        self._sheet.ensure_tab(MULTI_ANSWER_TITLE, MULTI_ANSWER_HEADERS)

    def _read_multi_answers(self) -> list[dict]:
        reader = getattr(self._sheet, "read_multi_answer_rows", None)
        if reader is not None:
            return reader()
        return self._sheet.read_dicts(MULTI_ANSWER_TITLE, formatted=True)

    def _read_header_for(self, title: str) -> list[str]:
        if title == MULTI_ANSWER_TITLE:
            reader = getattr(self._sheet, "read_multi_answer_header", None)
            if reader is not None:
                return reader()
        return self._sheet.read_header(title)

    def _now_text(self) -> str:
        return self._jst_now().strftime("%Y-%m-%d %H:%M:%S")

    def _time_over_budget(self) -> bool:
        return self._clock() - self._started_at > self._compare.time_budget_seconds

    def _redact_secrets(self, value) -> str:
        """3 つの鍵の値と一部を伏せた鍵をログ・表に出さない（R4・S8・§14.4）。"""
        return redact_secrets(value, self._all_api_keys())

    def _all_api_keys(self) -> tuple:
        return (
            self._config.gemini_api_key,
            self._config.anthropic_api_key,
            self._config.openai_api_key,
        )

    def _verify_headers(self, titles: list[str], checks) -> bool:
        """既にあるタブの 1 行目を、書く前に読むだけで確かめる（S6）。

        checks の要素は (title, headers, prefix_only)。prefix_only なら先頭 len(headers)
        個だけを比べる（それより右は見ない）。後ろの空のセルは同じとみなす。
        1 つでも違えばログを出して False。
        """
        existing = set(titles)
        try:
            for title, headers, prefix_only in checks:
                if title not in existing:
                    continue
                actual = self._read_header_for(title)
                expected = [str(header) for header in headers]
                if not actual:
                    continue
                if title == MULTI_ANSWER_TITLE:
                    # 1.7 の 9 列か 1.6 までの 8 列。メモより右は見ない。
                    if multi_answer_layout(actual) is None:
                        raise HeaderMismatchError(title, headers, actual)
                    continue
                if expected == OCR_HEADERS and actual == OCR_HEADERS_OLD:
                    # ページ数の無い古い OCR タブも、続きからも score も通す（§5.3）
                    continue
                compared = actual[: len(expected)] if prefix_only else actual
                if compared == expected:
                    continue
                if (
                    not prefix_only
                    and expected
                    and expected[-1] == "明細JSON"
                    and actual == expected[:-1]
                ):
                    logger.error(
                        f"タブ '{title}' は古い形です。"
                        "新しいラベルで collect からやり直してください",
                        extra={"step": "compare_old_format"},
                    )
                    return False
                raise HeaderMismatchError(title, headers, actual)
        except HeaderMismatchError as error:
            logger.error(
                f"{error}。列を足したり並べ替えたりせずに直してください",
                extra={"step": "compare_header_mismatch"},
            )
            return False
        return True

    def _check_models(self) -> None:
        for model in self._compare.models:
            try:
                available = self._model_checker(model.name)
            except Exception as error:
                if _not_found(error):
                    self._unusable.append(model.label)
                    logger.warning(
                        f"使えない型のため外します: {model.name}",
                        extra={"step": "compare_model_missing"},
                    )
                else:
                    logger.warning(
                        f"型の有無を確かめられませんでした（外さず続行）: {model.name} "
                        f"({type(error).__name__})",
                        extra={"step": "compare_model_check_error"},
                    )
                continue
            if available is False:
                self._unusable.append(model.label)
                logger.warning(
                    f"使えない型のため外します: {model.name}",
                    extra={"step": "compare_model_missing"},
                )

    def _check_readers(self) -> None:
        for reader in self._compare.readers:
            try:
                if reader.vendor == VENDOR_GEMINI:
                    available = self._model_checker(reader.name)
                elif self._reader_checker is not None:
                    available = self._reader_checker(reader.name)
                else:
                    available = True
            except Exception as error:
                if _not_found(error):
                    self._unusable.append(reader.label)
                    logger.warning(
                        f"使えない型のため外します: {reader.name}",
                        extra={"step": "compare_model_missing"},
                    )
                else:
                    logger.warning(
                        f"型の有無を確かめられませんでした（外さず続行）: {reader.name} "
                        f"({type(error).__name__})",
                        extra={"step": "compare_model_check_error"},
                    )
                continue
            if available is False:
                self._unusable.append(reader.label)
                logger.warning(
                    f"使えない型のため外します: {reader.name}",
                    extra={"step": "compare_model_missing"},
                )

    def _collect_files(self) -> list:
        seen: dict[str, object] = {}
        for folder_id in self._compare.folder_ids:
            try:
                files = self._resources.drive().list_files(folder_id)
            except Exception as error:
                logger.error(
                    f"フォルダの一覧を取れません: {folder_id}: {type(error).__name__}",
                    extra={"step": "compare_list_error"},
                )
                continue
            for file in files:
                seen.setdefault(file.file_id, file)

        names: dict[str, str] = {}
        for file in seen.values():
            if file.folder_id in names:
                continue
            try:
                names[file.folder_id] = self._resources.drive().get_name(file.folder_id)
            except Exception:
                names[file.folder_id] = file.folder_id

        infos = [
            _FileInfo(file=file, folder_name=names.get(file.folder_id, ""))
            for file in seen.values()
        ]
        infos.sort(key=lambda info: (info.folder_name, info.file.file_name, info.file.file_id))
        if self._compare.max_files is not None:
            infos = infos[: self._compare.max_files]
        return infos

    def _done_map(self, result_rows: list[dict]) -> dict[tuple[str, str], set[str]]:
        # （ファイル, 型, 方式）ごとに一番下の行で決める（§5.4）
        latest: dict[tuple[str, str, str], str] = {}
        for row in result_rows:
            key = (
                str(row.get("fileId", "")).strip(),
                str(row.get("型", "")).strip(),
                str(row.get("方式", "")).strip(),
            )
            latest[key] = str(row.get("結果", "")).strip()
        done: dict[tuple[str, str], set[str]] = {}
        for (file_id, model, method), result in latest.items():
            if result.startswith("失敗:api_error") or result.startswith("失敗:file_error"):
                continue
            done.setdefault((file_id, model), set()).add(method)
        return done

    def _model_done(self, done, file_id: str, model: CompareModel) -> bool:
        methods = {METHOD_LABELS[method] for method in self._compare.methods}
        return methods.issubset(done.get((file_id, model.label), set()))

    def _reader_done(self, done, file_id: str, reader: CompareModel) -> bool:
        """読み手は `画像から` の行だけで決める（§5.2）。"""
        return METHOD_LABELS[METHOD_IMAGE] in done.get((file_id, reader.label), set())

    def _reader_ai_config(self, reader: CompareModel) -> AiConfig:
        return replace(
            self._config.ai,
            model=reader.name,
            temperature=None,
            thinking_level=reader.thinking_level,
            max_tokens=self._compare.reader_max_tokens,
            request_timeout_seconds=self._compare.effective_request_timeout,
        )

    def _model_ai_config(self, model: CompareModel) -> AiConfig:
        thinking = model.thinking_level or self._compare.thinking_level
        return replace(
            self._config.ai,
            model=model.name,
            temperature=self._compare.temperature,
            thinking_level=thinking,
            max_tokens=self._compare.max_tokens,
            request_timeout_seconds=self._compare.effective_request_timeout,
        )

    def _reader_ai_settings(self, reader: CompareModel) -> tuple[AiConfig, str]:
        """読み手の AiConfig と「設定」の欄（Gemini は今までの文字列のまま）。"""
        if reader.vendor == VENDOR_GEMINI:
            ai_config = self._model_ai_config(reader)
            settings = settings_text(
                ai_config.temperature,
                ai_config.thinking_level,
                ai_config.max_tokens,
                getattr(ai_config, "prompt_version", "v1"),
            )
        else:
            ai_config = self._reader_ai_config(reader)
            settings = reader_settings_text(
                reader.vendor,
                reader.thinking_level,
                ai_config.max_tokens,
                getattr(ai_config, "prompt_version", "v1"),
            )
        return ai_config, settings

    def _reader_error_row(
        self, task: _FileTask, reader: CompareModel, error: Exception, recorded_at: str
    ) -> CompareRow:
        """その読み手の行だけを `失敗:file_error` にする（§14.1）。"""
        _, settings = self._reader_ai_settings(reader)
        detail = self._redact_secrets(f"{type(error).__name__}: {error}")[:300]
        return CompareRow(
            run_label=self._compare.run_label,
            recorded_at=recorded_at,
            file_id=task.file.file_id,
            folder_name=task.folder_name,
            file_name=task.file.file_name,
            model_label=reader.label,
            model_name=reader.name,
            method=METHOD_LABELS[METHOD_IMAGE],
            result="失敗:file_error",
            settings=settings,
            error_detail=detail,
        )

    # ── 1 ファイル（作業スレッド） ────────────────────────
    def _process_file(self, task: _FileTask):
        file = task.file
        rows: list[CompareRow] = []
        ocr_row = None
        recorded_at = self._now_text()
        try:
            self._resources.drive().download_file(file)
            # この回に呼ぶのが読み手だけなら Vision を呼ばない（§5.2）
            ocr = None
            ocr_failed = False
            if task.models:
                ocr = self._resources.ocr().extract_text(file)
                ocr_failed = bool(ocr.error) or not ocr.raw_text.strip()
                ocr_row = [
                    self._compare.run_label,
                    file.file_id,
                    file.file_name,
                    ocr.engine,
                    ocr.confidence,
                    len(ocr.raw_text),
                    ocr.raw_text[:40000],
                    ocr.error or "",
                    getattr(ocr, "page_count", 1) or 1,
                ]
            ocr_text = ocr.raw_text if ocr is not None else ""

            for model in task.models:
                if self._time_over_budget():
                    # その型の行は書かない（次の続きからで呼ばれる）
                    logger.info(
                        f"時間切れのため残りの型を呼びません: {file.file_name}: {model.label}",
                        extra={"step": "compare_time_budget_model"},
                    )
                    break
                ai_config = self._model_ai_config(model)
                extractor = self._resources.extractor(model, ai_config)
                settings = settings_text(
                    ai_config.temperature,
                    ai_config.thinking_level,
                    ai_config.max_tokens,
                    getattr(ai_config, "prompt_version", "v1"),
                )
                by_method: dict[str, CompareRow] = {}
                model_rows: list[CompareRow] = []
                for method in self._compare.methods:
                    if method == METHOD_TEXT and ocr_failed:
                        outcome = AttemptOutcome([], "ocr_failed", None)
                        row = make_result_row(
                            run_label=self._compare.run_label,
                            recorded_at=recorded_at,
                            file=file,
                            folder_name=task.folder_name,
                            model_label=model.label,
                            model_name=model.name,
                            method=method,
                            outcome=outcome,
                            retries=0,
                            settings=settings,
                            ocr_text=ocr_text,
                        )
                    else:
                        outcome, retries = extract_with_retries(
                            lambda m=method: extract_once(extractor, m, ocr, file),
                            sleeps=self._retry_sleeps,
                            sleep=self._sleep,
                            should_stop=self._time_over_budget,
                        )
                        row = make_result_row(
                            run_label=self._compare.run_label,
                            recorded_at=recorded_at,
                            file=file,
                            folder_name=task.folder_name,
                            model_label=model.label,
                            model_name=model.name,
                            method=method,
                            outcome=outcome,
                            retries=retries,
                            settings=settings,
                            ocr_text=ocr_text,
                        )
                    by_method[method] = row
                    model_rows.append(row)

                if METHOD_TEXT in by_method and METHOD_IMAGE in by_method:
                    model_rows.append(
                        build_current_flow_row(
                            run_label=self._compare.run_label,
                            recorded_at=recorded_at,
                            file=file,
                            folder_name=task.folder_name,
                            model_label=model.label,
                            model_name=model.name,
                            text_row=by_method[METHOD_TEXT],
                            image_row=by_method[METHOD_IMAGE],
                            ocr_text=ocr_text,
                            ai_config=ai_config,
                            settings=settings,
                            ocr_failed=ocr_failed,
                        )
                    )
                    model_rows.append(
                        build_dual_row(
                            run_label=self._compare.run_label,
                            recorded_at=recorded_at,
                            file=file,
                            folder_name=task.folder_name,
                            model_label=model.label,
                            model_name=model.name,
                            text_row=by_method[METHOD_TEXT],
                            image_row=by_method[METHOD_IMAGE],
                            ocr_text=ocr_text,
                            ai_config=ai_config,
                            settings=settings,
                            ocr_failed=ocr_failed,
                        )
                    )
                for row in model_rows:
                    if row.cost_usd is None:
                        row.cost_usd = estimate_cost(
                            self._compare.prices,
                            model.label,
                            row.input_tokens,
                            row.output_tokens,
                            row.thinking_tokens,
                        )
                rows.extend(model_rows)

            for reader in task.readers:
                if self._time_over_budget():
                    logger.info(
                        f"時間切れのため残りの読み手を呼びません: {file.file_name}: {reader.label}",
                        extra={"step": "compare_time_budget_model"},
                    )
                    break
                # 読み手の失敗はその読み手だけに留める（§14.1）。読み手を作る所も囲む
                try:
                    ai_config, settings = self._reader_ai_settings(reader)
                    if reader.vendor == VENDOR_GEMINI:
                        extractor = self._resources.extractor(reader, ai_config)
                    else:
                        extractor = self._resources.reader(reader, ai_config)
                    outcome, retries = extract_with_retries(
                        lambda: extract_once(extractor, METHOD_IMAGE, ocr, file),
                        sleeps=self._retry_sleeps,
                        sleep=self._sleep,
                        should_stop=self._time_over_budget,
                    )
                    row = make_result_row(
                        run_label=self._compare.run_label,
                        recorded_at=recorded_at,
                        file=file,
                        folder_name=task.folder_name,
                        model_label=reader.label,
                        model_name=reader.name,
                        method=METHOD_IMAGE,
                        outcome=outcome,
                        retries=retries,
                        settings=settings,
                        ocr_text=ocr_text,
                    )
                    if row.cost_usd is None:
                        row.cost_usd = estimate_cost(
                            self._compare.prices,
                            reader.label,
                            row.input_tokens,
                            row.output_tokens,
                            row.thinking_tokens,
                        )
                    rows.append(row)
                except Exception as error:
                    logger.error(
                        f"読み手の処理で予期しない例外: {file.file_name}: {reader.label}: "
                        f"{type(error).__name__}: {self._redact_secrets(error)}",
                        extra={"step": "compare_reader_error"},
                    )
                    rows.append(self._reader_error_row(task, reader, error, recorded_at))
        except Exception as error:
            logger.error(
                f"ファイル処理で予期しない例外: {file.file_name}: {self._redact_secrets(error)}",
                extra={"step": "compare_file_error"},
            )
            rows, ocr_row = self._file_error_rows(task, error, recorded_at), ocr_row
        finally:
            # 読み取りが終わったら中身のバイト列を持ち続けない
            file.content = b""
        return rows, ocr_row

    # ── 審判の回（仕様 spec_judge_form §5.1） ────────────────
    def _judge_api_key(self, judge: CompareModel) -> str | None:
        if judge.vendor == VENDOR_GOOGLE:
            return self._config.gemini_api_key
        return self._config.openai_api_key

    def _run_judges(self, label: str, result_title: str, ocr_title: str, infos: list) -> bool:
        """読み取りの後・形の計算の前に、対象のファイルだけ審判を 1 回ずつ呼ぶ。"""
        if not self._compare.judges:
            # J1: 頼まれていなければ import もしない
            return True
        if self._time_over_budget():
            logger.info(
                "時間切れのため審判の回を始めません。同じ COMPARE_RUN_LABEL="
                f"{label} で再実行すると続きから",
                extra={"step": "compare_judge_time_budget"},
            )
            return True
        try:
            # J2: 比較の collect の中でだけ import する
            from src.compare import judges as judge_module
        except Exception as error:
            logger.error(
                f"審判のモジュールを読めません: {type(error).__name__}: "
                f"{self._redact_secrets(error)}",
                extra={"step": "compare_judge_error"},
            )
            return False

        try:
            result_rows = self._sheet.read_dicts(result_title)
            try:
                ocr_rows = self._sheet.read_dicts(ocr_title)
            except Exception as error:
                logger.warning(
                    "OCR タブを読めません（審判の回は OCR の文字なしで続けます）: "
                    f"{type(error).__name__}",
                    extra={"step": "compare_judge_ocr_error"},
                )
                ocr_rows = []
            base_label = self._resolve_form_base(result_rows)
            if not base_label:
                logger.warning(
                    "主の読み手が決まらないため審判の回を飛ばします（COMPARE_FORM_BASE か"
                    " 両読みの行を確かめてください）",
                    extra={"step": "compare_judge_base_missing"},
                )
                return True
            files, _ = build_inputs(result_rows, ocr_rows, base_label)
            target_ids = {info.file.file_id for info in infos}
            mime_by_id = {info.file.file_id: info.file.mime_type for info in infos}
            done = self._done_map(result_rows)
            judge_method = METHOD_LABELS["judge"]

            jobs = []
            for file in files:
                if file.file_id not in target_ids:
                    continue
                file.mime_type = mime_by_id.get(file.file_id, "")
                d0 = reconcile(file.image_items or [], file.text_items or [], file.ocr_text)
                if not needs_call(file.image_items or [], d0):
                    continue
                vendors = [item.vendor for item in (file.image_items or [])]
                plan = judge_module.build_questions(
                    file.image_items or [], file.text_items or [], d0, vendors
                )
                # 枚数の質問だけで明細の質問が無いファイルは呼ばない（行も作らない。§12.3）
                if not plan.items:
                    continue
                left = [
                    judge
                    for judge in self._compare.judges
                    if judge_method not in done.get((file.file_id, judge.label), set())
                ]
                if left:
                    jobs.append((file, plan, left))
            if not jobs:
                return True

            unavailable: set[str] = set()
            lock = threading.Lock()
            budget_exceeded = False
            judge_failed = False
            with ThreadPoolExecutor(max_workers=self._compare.max_workers) as executor:
                iterator = iter(jobs)
                pending: dict = {}
                while True:
                    while len(pending) < self._compare.max_workers and not budget_exceeded:
                        # 並びを最後まで出した後は next() を呼ばない（読み取りの回と同じ）
                        if iterator is None:
                            break
                        try:
                            file, plan, judges = next(iterator)
                        except StopIteration:
                            iterator = None
                            break
                        if self._time_over_budget():
                            budget_exceeded = True
                            break
                        future = executor.submit(
                            self._process_judge_file, file, plan, judges, unavailable, lock
                        )
                        pending[future] = file
                    if not pending:
                        if budget_exceeded or iterator is None:
                            break
                        continue
                    completed, _ = wait(pending, return_when=FIRST_COMPLETED)
                    for future in completed:
                        file = pending.pop(future, None)
                        try:
                            rows = future.result()
                        except Exception as error:  # 念のための最終防衛
                            # ほかのファイルの行は書いてから、この実行を 1 で終える（§12.1）
                            judge_failed = True
                            logger.error(
                                "審判のファイル処理が異常終了: "
                                f"{getattr(file, 'file_name', '')}: "
                                f"{type(error).__name__}: {self._redact_secrets(error)}",
                                extra={"step": "compare_judge_fatal"},
                            )
                            continue
                        if rows:
                            self._sheet.append_rows(
                                result_title,
                                [row.to_sheet_row() for row in rows],
                                len(RESULT_HEADERS),
                            )
                    if budget_exceeded and not pending:
                        break
            if budget_exceeded:
                logger.info(
                    "時間切れのため残りの審判を呼びません。同じ COMPARE_RUN_LABEL="
                    f"{label} で再実行すると続きから",
                    extra={"step": "compare_judge_time_budget"},
                )
            return not judge_failed
        except Exception as error:
            logger.error(
                f"審判の回で例外: {type(error).__name__}: {self._redact_secrets(error)}",
                extra={"step": "compare_judge_error"},
            )
            return False

    def _process_judge_file(self, file, plan, judges, unavailable, lock):
        from src.compare import judges as judge_module

        rows: list[CompareRow] = []
        recorded_at = self._now_text()
        with lock:
            left = [judge for judge in judges if judge.label not in unavailable]
        if not left:
            # 使える審判が残っていないファイルは Drive から取らない（§12.3）
            return rows

        if plan.too_many:
            # 明細が多すぎるファイルは Drive から取らずに失敗の行だけ書く（§12.3）
            for judge in left:
                attempt = judge_module.JudgeAttempt(
                    result=judge_module.FAIL_TOO_MANY_ITEMS,
                    info={
                        "latency_ms": 0,
                        "prompt_tokens": None,
                        "output_tokens": 0,
                        "error": None,
                        "error_code": None,
                    },
                )
                rows.append(self._judge_row(file, judge, plan, attempt, 0, recorded_at))
            return rows

        try:
            self._resources.drive().download_file(file)
        except Exception as error:
            detail = self._redact_secrets(f"{type(error).__name__}: {error}")[:300]
            for judge in left:
                rows.append(self._judge_error_row(file, judge, plan, error, recorded_at, detail))
            return rows

        try:
            for judge in judges:
                if self._time_over_budget():
                    logger.info(
                        f"時間切れのため残りの審判を呼びません: {file.file_name}: {judge.label}",
                        extra={"step": "compare_judge_time_budget"},
                    )
                    break
                with lock:
                    if judge.label in unavailable:
                        continue
                try:
                    row = self._call_judge(file, judge, plan, recorded_at)
                except Exception as error:
                    logger.error(
                        f"審判の処理で予期しない例外: {file.file_name}: {judge.label}: "
                        f"{type(error).__name__}: {self._redact_secrets(error)}",
                        extra={"step": "compare_judge_error"},
                    )
                    detail = self._redact_secrets(f"{type(error).__name__}: {error}")[:300]
                    row = self._judge_error_row(file, judge, plan, error, recorded_at, detail)
                if row.result == judge_module.FAIL_API and row.error_detail.startswith("HTTP 404"):
                    with lock:
                        unavailable.add(judge.label)
                    logger.warning(
                        f"使えない審判: {judge.name}",
                        extra={"step": "compare_judge_unusable"},
                    )
                rows.append(row)
        finally:
            file.content = b""
        return rows

    def _call_judge(self, file, judge: CompareModel, plan, recorded_at: str) -> CompareRow:
        from src.compare import judges as judge_module

        client = judge_module.JudgeClient(
            judge,
            self._judge_api_key(judge),
            resolution=self._compare.judge_image_resolution,
            timeout=self._compare.effective_request_timeout,
            post=self._judge_post,
            redact_keys=self._all_api_keys(),
        )
        attempt, retries = extract_with_retries(
            lambda: client.call(file, plan),
            sleeps=self._retry_sleeps,
            sleep=self._sleep,
            should_stop=self._time_over_budget,
        )
        return self._judge_row(file, judge, plan, attempt, retries, recorded_at)

    def _judge_row(
        self, file, judge: CompareModel, plan, attempt, retries: int, recorded_at: str
    ) -> CompareRow:
        from src.compare import judges as judge_module

        info = attempt.info if isinstance(attempt.info, dict) else {}
        input_tokens = info.get("prompt_tokens")
        cost = estimate_cost(self._compare.prices, judge.label, input_tokens, 0, 0)
        items_json = ""
        if attempt.result == judge_module.SUCCESS:
            items_json = judge_module.build_items_json(
                plan, attempt.answers, judge_module.base_for_file(file)
            )
        return CompareRow(
            run_label=self._compare.run_label,
            recorded_at=recorded_at,
            file_id=file.file_id,
            folder_name=getattr(file, "folder_name", ""),
            file_name=file.file_name,
            model_label=judge.label,
            model_name=judge.name,
            method=METHOD_LABELS["judge"],
            result=attempt.result,
            retries=retries,
            count=plan.question_count,
            latency_ms=info.get("latency_ms"),
            input_tokens=input_tokens,
            output_tokens=0,
            thinking_tokens=0,
            cost_usd=cost,
            settings=judge_module.judge_settings_text(judge, self._compare.judge_image_resolution),
            error_detail=self._redact_secrets(info.get("error") or "")[:300],
            raw_text=self._redact_secrets(attempt.raw_answers)[:2000],
            items_json=items_json,
        )

    def _judge_error_row(
        self, file, judge: CompareModel, plan, error, recorded_at: str, detail: str
    ) -> CompareRow:
        from src.compare import judges as judge_module

        return CompareRow(
            run_label=self._compare.run_label,
            recorded_at=recorded_at,
            file_id=file.file_id,
            folder_name=getattr(file, "folder_name", ""),
            file_name=file.file_name,
            model_label=judge.label,
            model_name=judge.name,
            method=METHOD_LABELS["judge"],
            result=judge_module.FAIL_FILE_ERROR,
            count=plan.question_count,
            cost_usd=0.0,
            settings=judge_module.judge_settings_text(judge, self._compare.judge_image_resolution),
            error_detail=detail,
        )

    def _resolve_form_base(self, result_rows: list[dict]) -> str | None:
        if self._compare.form_base:
            return self._compare.form_base
        for row in result_rows:
            if str(row.get("方式", "")).strip() == METHOD_LABELS[METHOD_DUAL]:
                label = str(row.get("型", "")).strip()
                if label:
                    return label
        return None

    def _ocr_rows(self, label: str) -> list[dict]:
        title = ocr_tab_name(label)
        try:
            return self._sheet.read_dicts(title)
        except Exception as error:
            logger.warning(
                f"OCR タブを読めません（形の費用は 1 ページで数えます）: {type(error).__name__}",
                extra={"step": "compare_forms"},
            )
            return []

    def _write_forms(
        self,
        label: str,
        result_rows: list[dict],
        answer_rows: list[dict],
        multi_rows: list[dict] | None,
    ) -> bool:
        """形の 2 つのタブだけを消して書き直す（R6・R8）。

        計算か書き込みに失敗したら、例外の型と伏せた文をログに出して偽を返す
        （呼んだ実行は終了コード 1。§14.2）。
        """
        try:
            base_label = self._resolve_form_base(result_rows)
            # 2 つのタブの行を両方作ってから書く（片方だけ新しくしない）
            tables = build_form_tables(
                result_rows=result_rows,
                ocr_rows=self._ocr_rows(label),
                answer_rows=answer_rows,
                multi_rows=multi_rows,
                base_label=base_label,
                ocr_price_per_page=self._compare.ocr_price_per_page_usd,
                label=label,
                now_text=self._now_text(),
                judge_thresholds=self._compare.judge_thresholds,
            )
            if tables is None:
                logger.info(
                    "形のタブは作りません（主の読み手の行がありません）",
                    extra={"step": "compare_forms"},
                )
                return True
            summary_title = form_tab_name(label)
            detail_title = form_detail_tab_name(label)
            self._sheet.ensure_tab(summary_title, FORM_HEADERS, check_headers=False)
            self._sheet.replace_all(summary_title, tables.summary_rows)
            self._sheet.ensure_tab(detail_title, FORM_DETAIL_HEADERS, check_headers=False)
            self._sheet.replace_all(detail_title, tables.detail_rows)
            logger.info(
                f"形を計算しました: {label}（{len(tables.metrics)} の形）",
                extra={"step": "compare_forms"},
            )
            return True
        except Exception as error:
            logger.error(
                f"形を書けません: {type(error).__name__}: {self._redact_secrets(error)}",
                extra={"step": "compare_forms"},
            )
            return False

    def _file_error_rows(
        self, task: _FileTask, error: Exception, recorded_at: str
    ) -> list[CompareRow]:
        rows: list[CompareRow] = []
        detail = self._redact_secrets(f"{type(error).__name__}: {error}")[:300]
        # このファイルで今回呼ぶ型だけ。済んだ型の成功を失敗で上書きしない（§5.4）
        for model in task.models:
            if model.label in self._unusable:
                continue
            ai_config = self._model_ai_config(model)
            settings = settings_text(
                ai_config.temperature,
                ai_config.thinking_level,
                ai_config.max_tokens,
                getattr(ai_config, "prompt_version", "v1"),
            )
            methods = list(self._compare.methods)
            if METHOD_TEXT in methods and METHOD_IMAGE in methods:
                methods.append(METHOD_CURRENT)
                methods.append(METHOD_DUAL)
            for method in methods:
                rows.append(
                    CompareRow(
                        run_label=self._compare.run_label,
                        recorded_at=recorded_at,
                        file_id=task.file.file_id,
                        folder_name=task.folder_name,
                        file_name=task.file.file_name,
                        model_label=model.label,
                        model_name=model.name,
                        method=METHOD_LABELS[method],
                        result="失敗:file_error",
                        settings=settings,
                        error_detail=detail,
                    )
                )
        for reader in task.readers:
            if reader.label in self._unusable:
                continue
            _, settings = self._reader_ai_settings(reader)
            rows.append(
                CompareRow(
                    run_label=self._compare.run_label,
                    recorded_at=recorded_at,
                    file_id=task.file.file_id,
                    folder_name=task.folder_name,
                    file_name=task.file.file_name,
                    model_label=reader.label,
                    model_name=reader.name,
                    method=METHOD_LABELS[METHOD_IMAGE],
                    result="失敗:file_error",
                    settings=settings,
                    error_detail=detail,
                )
            )
        return rows


@dataclass
class _FileInfo:
    file: object
    folder_name: str


def _default_model_checker(api_key: str | None):
    from google import genai

    client = genai.Client(api_key=api_key)

    def check(name: str) -> bool:
        client.models.get(model=name)
        return True

    return check


def _default_reader_checker(config: AppConfig, timeout: int):
    """Anthropic・OpenAI の型の有無。その会社の型を初めて確かめるときだけ作る（R2）。"""
    checkers: dict[str, object] = {}

    def check(name: str) -> bool:
        vendor = vendor_of(name)
        checker = checkers.get(vendor)
        if checker is None:
            if vendor == VENDOR_ANTHROPIC:
                api_key = config.anthropic_api_key
            elif vendor == VENDOR_OPENAI:
                api_key = config.openai_api_key
            else:
                return True
            checker = create_model_checker(name, api_key, timeout)
            checkers[vendor] = checker
        return checker(name)

    return check


def _redact_config_secrets(text, config: AppConfig) -> str:
    return redact_secrets(
        text,
        (config.gemini_api_key, config.anthropic_api_key, config.openai_api_key),
    )


def _missing_reader_keys(config: AppConfig, compare_config: CompareConfig) -> list[str]:
    missing: list[str] = []
    vendors = {reader.vendor for reader in compare_config.readers}
    if VENDOR_ANTHROPIC in vendors and not (config.anthropic_api_key or "").strip():
        missing.append("ANTHROPIC_API_KEY")
    if VENDOR_OPENAI in vendors and not (config.openai_api_key or "").strip():
        missing.append("OPENAI_API_KEY")
    return missing


def _missing_judge_keys(config: AppConfig, compare_config: CompareConfig) -> list[str]:
    """J3: 頼んだ審判の会社の鍵が空なら、何も呼ばずに 1 で終わる。"""
    missing: list[str] = []
    vendors = {judge.vendor for judge in compare_config.judges}
    if VENDOR_GOOGLE in vendors and not (config.gemini_api_key or "").strip():
        missing.append("GEMINI_API_KEY")
    if VENDOR_OPENAI in vendors and not (config.openai_api_key or "").strip():
        missing.append("OPENAI_API_KEY")
    return missing


def run_compare(
    config: AppConfig,
    env=None,
    *,
    sheet_client: CompareSheetClient | None = None,
    drive_factory=None,
    ocr_factory=None,
    extractor_factory=None,
    model_checker=None,
    reader_checker=None,
    reader_factory=None,
    judge_post=None,
    sleep=time.sleep,
    clock=time.monotonic,
    jst_now=None,
    retry_sleeps=DEFAULT_RETRY_SLEEPS,
) -> int:
    """比較モードの入口。設定の誤りと表を開けないときだけ 1 を返す。"""
    # 時間の数え始めはプロセスの始め（この関数に入った時点）
    started_at = clock()
    try:
        compare_config = load_compare_config(env if env is not None else os.environ)
    except ValueError as error:
        logger.error(f"比較の設定が不正: {error}", extra={"step": "compare_config_error"})
        return 1

    # S3: 書くのは比較の表だけ。マスターと同じなら何も読まず・書かずに 1
    master_raw = (config.master.spreadsheet_id or "").strip()
    master_id = extract_id_from_url(master_raw) if master_raw else ""
    if master_id and master_id == compare_config.result_spreadsheet_id:
        logger.error(
            "COMPARE_RESULT_SPREADSHEET_ID が MASTER_SPREADSHEET_ID と同じです",
            extra={"step": "compare_master_conflict"},
        )
        return 1

    # R3: 読み手の鍵が空なら、API も Drive も表も呼ばずに 1
    if compare_config.step == "collect":
        missing_keys = _missing_reader_keys(config, compare_config)
        if missing_keys:
            logger.error(
                "比較の読み手の鍵が空です: " + ", ".join(missing_keys),
                extra={"step": "compare_reader_key_error"},
            )
            return 1
        missing_judge_keys = _missing_judge_keys(config, compare_config)
        if missing_judge_keys:
            logger.error(
                "比較の審判の鍵が空です: " + ", ".join(missing_judge_keys),
                extra={"step": "compare_judge_key_error"},
            )
            return 1

    if sheet_client is None:
        try:
            sheet_client = CompareSheetClient(
                compare_config.result_spreadsheet_id,
                config.google_credentials_path,
                sleep=sleep,
                retry_sleeps=retry_sleeps,
            )
        except Exception as error:
            logger.error(
                f"比較の表を開けません: {type(error).__name__}",
                extra={"step": "compare_sheet_open_error"},
            )
            return 1
    else:
        try:
            sheet_client.get_sheet_titles()
        except Exception as error:
            logger.error(
                f"比較の表を開けません: {type(error).__name__}",
                extra={"step": "compare_sheet_open_error"},
            )
            return 1

    drive_factory = drive_factory or (
        lambda: DriveClient(config.drive, config.google_credentials_path, read_only=True)
    )
    ocr_factory = ocr_factory or (lambda: create_ocr_engine(config.ocr))
    extractor_factory = extractor_factory or (
        lambda ai_config: create_ai_extractor(ai_config, api_key=config.gemini_api_key)
    )

    def _default_reader_factory(ai_config):
        vendor = vendor_of(ai_config.model)
        api_key = config.anthropic_api_key if vendor == VENDOR_ANTHROPIC else config.openai_api_key
        return create_compare_reader(
            ai_config.model,
            ai_config,
            api_key=api_key,
            # どれかの会社の鍵が例外の文に混ざっても伏せる（R4）
            redact_keys=(
                config.gemini_api_key,
                config.anthropic_api_key,
                config.openai_api_key,
            ),
        )

    if reader_factory is None:
        reader_factory = _default_reader_factory
    if reader_checker is None:
        reader_checker = _default_reader_checker(config, compare_config.effective_request_timeout)

    if model_checker is None:
        # score では型を呼ばないので、クライアントも作らない
        if compare_config.step == "collect":
            try:
                model_checker = _default_model_checker(config.gemini_api_key)
            except Exception as error:
                logger.error(
                    f"Gemini のクライアントを作れません: {type(error).__name__}",
                    extra={"step": "compare_client_error"},
                )
                return 1
        else:

            def _available(name: str) -> bool:
                return True

            model_checker = _available

    runner = CompareRunner(
        config,
        compare_config,
        sheet=sheet_client,
        drive_factory=drive_factory,
        ocr_factory=ocr_factory,
        extractor_factory=extractor_factory,
        model_checker=model_checker,
        reader_checker=reader_checker,
        reader_factory=reader_factory,
        judge_post=judge_post,
        sleep=sleep,
        clock=clock,
        jst_now=jst_now,
        retry_sleeps=retry_sleeps,
        started_at=started_at,
    )
    try:
        return runner.run()
    except Exception as error:
        logger.error(
            f"比較の実行が異常終了: {type(error).__name__}: "
            f"{_redact_config_secrets(error, config)}",
            extra={"step": "compare_fatal"},
        )
        return 1

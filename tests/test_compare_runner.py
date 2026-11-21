"""比較モードの実行（S2/S3/S8・続きから・時間切れなど）のテスト"""

import json
import logging
import re
import threading
from dataclasses import replace
from datetime import UTC, datetime

from src.compare.config import CompareModel, load_compare_config
from src.compare.pipeline import CompareRow
from src.compare.runner import CompareRunner, _ThreadResources, run_compare
from src.compare.sheet import ANSWER_HEADERS, OCR_HEADERS, RESULT_HEADERS
from src.config import (
    AiConfig,
    AppConfig,
    DriveConfig,
    MasterConfig,
    OcrConfig,
    SheetsConfig,
    TemplateConfig,
)
from src.models import DriveFile, OcrResult, ReceiptItem

RESULT_ID = "R" * 24
FOLDER = "FOLDER_A1234567890"
FOLDER_2 = "FOLDER_B1234567890"
KEY = "FAKE_API_KEY_DO_NOT_LEAK_12345"
NOW = datetime(2026, 11, 18, 3, 0, tzinfo=UTC)


def _env(**overrides):
    env = {
        "COMPARE_RESULT_SPREADSHEET_ID": RESULT_ID,
        "COMPARE_FOLDER_IDS": FOLDER,
        "COMPARE_MODELS": "m1,m2",
        "COMPARE_METHODS": "text,image",
        "COMPARE_RUN_LABEL": "L1",
        "COMPARE_MAX_WORKERS": "2",
        "COMPARE_TIME_BUDGET_SECONDS": "60",
    }
    env.update(overrides)
    return env


def _app_config(master="MASTER_A1234567890"):
    return AppConfig(
        master=MasterConfig(spreadsheet_id=master),
        template=TemplateConfig(),
        drive=DriveConfig(),
        sheets=SheetsConfig(),
        ocr=OcrConfig(),
        ai=AiConfig(),
        gemini_api_key=KEY,
    )


class FakeSheet:
    """CompareSheetClient の代わり（API を呼ばない）。"""

    def __init__(self):
        self.tabs: dict[str, list[list]] = {}
        self.appended: list[tuple[str, list[list]]] = []
        self.batch_calls: list[list[dict]] = []
        self.replaced: list[str] = []
        self.read_calls: list[tuple[str, str | None]] = []

    def get_sheet_titles(self):
        return list(self.tabs)

    def ensure_tab(self, title, headers, *, check_headers=True, prefix_only=False):
        if title not in self.tabs:
            self.tabs[title] = [list(headers)]

    def read_dicts(self, title, *, formatted=False, cells=None):
        self.read_calls.append((title, cells))
        values = self.tabs.get(title, [])
        if not values:
            return []
        headers = [str(h) for h in values[0]]
        rows = []
        for offset, row in enumerate(values[1:], start=2):
            padded = list(row) + [""] * (len(headers) - len(row))
            record = {headers[i]: padded[i] for i in range(len(headers))}
            record["_row"] = offset
            rows.append(record)
        return rows

    def read_header(self, title):
        values = self.tabs.get(title, [])
        if not values:
            return []
        header = ["" if value is None else str(value) for value in values[0]]
        while header and header[-1] == "":
            header.pop()
        return header

    def append_rows(self, title, rows, columns):
        if not rows:
            return
        self.appended.append((title, rows))
        self.ensure_tab(title, [])
        self.tabs.setdefault(title, [[]])
        self.tabs[title].extend(rows)

    def batch_update_cells(self, data):
        if data:
            self.batch_calls.append(data)
            for update in data:
                match = re.match(r"^'(.+)'!([A-Z]+)(\d+)$", update["range"])
                assert match, update["range"]
                title, column, row = match.groups()
                index = _column_index(column)
                row_number = int(row)
                values = self.tabs[title]
                while len(values) < row_number:
                    values.append([])
                target = values[row_number - 1]
                while len(target) <= index:
                    target.append("")
                target[index] = update["values"][0][0]

    def replace_all(self, title, rows):
        self.replaced.append(title)
        self.tabs[title] = [list(row) for row in rows]


def _column_index(column: str) -> int:
    result = 0
    for char in column:
        result = result * 26 + (ord(char) - 64)
    return result - 1


class FakeDrive:
    def __init__(self, folders=None, names=None):
        self.folders = folders or {}
        self.names = names or {}
        self.downloads = []
        self.renames = 0

    def list_files(self, folder_id):
        return list(self.folders.get(folder_id, []))

    def get_name(self, file_id):
        return self.names.get(file_id, file_id)

    def download_file(self, file):
        self.downloads.append(file.file_id)
        file.content = b"downloaded"
        return file

    def rename_file_as_done(self, file):
        self.renames += 1


class FakeOcr:
    def __init__(self, text="テスト商店 合計 1,600円", error=None):
        self.text = text
        self.error = error
        self.calls = 0

    def extract_text(self, file):
        self.calls += 1
        return OcrResult(raw_text=self.text, engine="fake", confidence=0.9, error=self.error)


class FakeExtractor:
    def __init__(self, model, history, items=None):
        self.model = model
        self.history = history
        self.items = items

    def _result(self):
        if self.items is not None:
            return list(self.items)
        return [
            ReceiptItem(
                date="2026-01-02",
                amount=1600,
                vendor="テスト商店",
                description="テスト品",
                account="消耗品費",
                tax_category="課税仕入10%",
                confidence=0.9,
            )
        ]

    def extract_receipt_data(self, ocr_result, file_name):
        self.history.append((self.model, "text", file_name))
        self.last_extraction_error = None
        self.last_call_info = _info()
        return self._result()

    def extract_from_file(self, file):
        self.history.append((self.model, "image", file.file_name))
        self.last_extraction_error = None
        self.last_call_info = _info()
        return self._result()


def _info(tokens=10):
    return {
        "model": "m",
        "latency_ms": 12,
        "finish_reason": "STOP",
        "prompt_tokens": tokens,
        "output_tokens": 2,
        "thinking_tokens": 0,
        "raw_text": "[]",
        "error": None,
    }


def _file(fid, name, folder=FOLDER):
    return DriveFile(file_id=fid, file_name=name, mime_type="image/jpeg", folder_id=folder)


def _extractor_factory(history, items=None):
    return lambda ai_config: FakeExtractor(ai_config.model, history, items)


def _collect(sheet, drive, history, *, env=None, config=None, ocr=None, checker=None):
    records = []

    class _Capture(logging.Handler):
        def emit(self, record):
            records.append(record)

    handler = _Capture()
    logger = logging.getLogger("receipt_ocr")
    logger.addHandler(handler)
    try:
        code = run_compare(
            config or _app_config(),
            env or _env(),
            sheet_client=sheet,
            drive_factory=lambda: drive,
            ocr_factory=lambda: ocr or FakeOcr(),
            extractor_factory=_extractor_factory(history),
            model_checker=checker or (lambda name: True),
            sleep=lambda seconds: None,
            jst_now=lambda: NOW,
        )
    finally:
        logger.removeHandler(handler)
    return code, records


class TestCollect:
    def test_writes_results_ocr_answers_and_summary(self):
        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        history = []
        code, records = _collect(sheet, drive, history)
        assert code == 0
        result_rows = sheet.tabs["結果_L1"]
        assert result_rows[0] == RESULT_HEADERS
        assert len(result_rows) == 1 + 2 * 4  # 2 型 × (文字・画像・現行・両読み)
        assert {row[6] for row in result_rows[1:]} == {"m1", "m2"}
        assert {row[7] for row in result_rows[1:]} == {
            "文字から",
            "画像から",
            "現行の流れ",
            "両読み",
        }

        ocr_rows = sheet.tabs["OCR_L1"]
        assert ocr_rows[0] == OCR_HEADERS
        assert len(ocr_rows) == 2  # 1 ファイル

        answer_rows = sheet.tabs["答え"]
        assert answer_rows[0] == ANSWER_HEADERS
        assert len(answer_rows) == 2  # 1 ファイル
        assert answer_rows[1][5:9] == ["2026-01-02", "1600", "10%", "テスト商店"]
        assert answer_rows[1][9] == "自動（全一致）"
        assert answer_rows[1][10] == ""

        assert "集計_L1" in sheet.replaced
        # S2: 比較の実行全体で rename を呼ばない
        assert drive.renames == 0

        # S8: API キーをログ・表に出さない
        assert all(KEY not in record.getMessage() for record in records)
        assert KEY not in str(sheet.tabs)
        assert all(KEY not in str(call) for call in sheet.batch_calls)

    def test_one_file_writes_text_image_current_and_dual_rows(self):
        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        code, _ = _collect(sheet, drive, [], env=_env(COMPARE_MODELS="m1"))
        assert code == 0
        result_rows = sheet.tabs["結果_L1"]
        assert [row[7] for row in result_rows[1:]] == [
            "文字から",
            "画像から",
            "現行の流れ",
            "両読み",
        ]
        dual = result_rows[-1]
        assert json.loads(dual[-1])[0]["r"] == "自動"

    def test_prompt_version_is_written_in_settings(self):
        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        config = replace(_app_config(), ai=AiConfig(prompt_version="v2"))
        code, _ = _collect(sheet, drive, [], config=config, env=_env(COMPARE_MODELS="m1"))
        assert code == 0
        settings = [row[25] for row in sheet.tabs["結果_L1"][1:]]
        assert settings
        assert all(value.endswith(", prompt=v2") for value in settings)

    def test_result_row_has_estimated_cost(self):
        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        code, _ = _collect(sheet, drive, [], env=_env(COMPARE_MODELS="gemini-2.5-flash@low"))
        assert code == 0
        row = sheet.tabs["結果_L1"][1]
        assert row[6] == "gemini-2.5-flash@low"
        assert float(row[24]) > 0

    def test_drive_download_content_is_released(self):
        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        code, _ = _collect(sheet, drive, [])
        assert code == 0
        assert file.content == b""

    def test_drive_list_failure_does_not_stop(self):
        class BrokenDrive(FakeDrive):
            def list_files(self, folder_id):
                raise RuntimeError("drive down")

        sheet = FakeSheet()
        code, _ = _collect(sheet, BrokenDrive(), [])
        assert code == 0
        assert "集計_L1" in sheet.replaced


class TestContinuation:
    def _done_row(self, file, model, method):
        return CompareRow(
            run_label="L1",
            recorded_at="2026-11-18 12:00:00",
            file_id=file.file_id,
            folder_name="テスト用フォルダ",
            file_name=file.file_name,
            model_label=model,
            model_name=model,
            method=method,
            result="成功",
        ).to_sheet_row()

    def test_all_done_file_is_not_downloaded(self):
        done_file = _file("FILE_A1234567890", "a.jpg")
        new_file = _file("FILE_B1234567890", "b.jpg")
        drive = FakeDrive({FOLDER: [done_file, new_file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        sheet.tabs["結果_L1"] = [list(RESULT_HEADERS)]
        for model in ("m1", "m2"):
            for method in ("文字から", "画像から"):
                sheet.tabs["結果_L1"].append(self._done_row(done_file, model, method))
        history = []
        code, _ = _collect(sheet, drive, history)
        assert code == 0
        assert done_file.file_id not in drive.downloads
        assert new_file.file_id in drive.downloads
        assert all(name != done_file.file_name for _, _, name in history)

    def test_partially_done_file_calls_only_missing_models(self):
        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        sheet.tabs["結果_L1"] = [list(RESULT_HEADERS)]
        for method in ("文字から", "画像から"):
            sheet.tabs["結果_L1"].append(self._done_row(file, "m1", method))
        history = []
        code, _ = _collect(sheet, drive, history)
        assert code == 0
        assert file.file_id in drive.downloads  # m2 の分は読み直す
        assert {model for model, _, _ in history} == {"m2"}

    def test_api_error_row_is_retried(self):
        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        sheet.tabs["結果_L1"] = [list(RESULT_HEADERS)]
        row = self._done_row(file, "m1", "文字から")
        row[8] = "失敗:api_error"
        sheet.tabs["結果_L1"].append(row)
        sheet.tabs["結果_L1"].append(self._done_row(file, "m1", "画像から"))
        history = []
        code, _ = _collect(sheet, drive, history, env=_env(COMPARE_MODELS="m1"))
        assert code == 0
        assert [entry[1] for entry in history] == ["text", "image"]

    def test_ocr_failed_row_counts_as_done(self):
        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        sheet.tabs["結果_L1"] = [list(RESULT_HEADERS)]
        row = self._done_row(file, "m1", "文字から")
        row[8] = "失敗:ocr_failed"
        sheet.tabs["結果_L1"].append(row)
        sheet.tabs["結果_L1"].append(self._done_row(file, "m1", "画像から"))
        history = []
        code, _ = _collect(sheet, drive, history, env=_env(COMPARE_MODELS="m1"))
        assert code == 0
        assert history == []
        assert drive.downloads == []


class TestContinuationBottomRow:
    def _row(self, file, model, method, result):
        return CompareRow(
            run_label="L1",
            recorded_at="2026-11-18 12:00:00",
            file_id=file.file_id,
            folder_name="テスト用フォルダ",
            file_name=file.file_name,
            model_label=model,
            model_name=model,
            method=method,
            result=result,
        ).to_sheet_row()

    def test_bottom_api_error_is_not_done_even_if_success_is_above(self):
        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        sheet.tabs["結果_L1"] = [list(RESULT_HEADERS)]
        sheet.tabs["結果_L1"].append(self._row(file, "m1", "文字から", "成功"))
        sheet.tabs["結果_L1"].append(self._row(file, "m1", "文字から", "失敗:api_error"))
        history = []
        code, _ = _collect(
            sheet, drive, history, env=_env(COMPARE_MODELS="m1", COMPARE_METHODS="text")
        )
        assert code == 0
        assert [entry[1] for entry in history] == ["text"]

    def test_only_remaining_models_get_file_error_rows(self):
        class FailingDownloadDrive(FakeDrive):
            def download_file(self, file):
                raise RuntimeError("download failed")

        file = _file("FILE_A1234567890", "a.jpg")
        drive = FailingDownloadDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        sheet.tabs["結果_L1"] = [list(RESULT_HEADERS)]
        for method in ("文字から", "画像から"):
            sheet.tabs["結果_L1"].append(self._row(file, "m1", method, "成功"))
        history = []
        code, _ = _collect(sheet, drive, history)
        assert code == 0
        m1_rows = [row for row in sheet.tabs["結果_L1"][1:] if row[6] == "m1"]
        m2_rows = [row for row in sheet.tabs["結果_L1"][1:] if row[6] == "m2"]
        assert len(m1_rows) == 2  # 済んだ型の成功を失敗で上書きしない
        assert all(row[8] != "失敗:file_error" for row in m1_rows)
        assert m2_rows and all(row[8] == "失敗:file_error" for row in m2_rows)

        summary = sheet.tabs["集計_L1"]
        headers = summary[7]
        m1_text = next(row for row in summary[8:] if row[0] == "m1" and row[1] == "文字から")
        assert m1_text[headers.index("失敗")] == 0


class TestEmptyResponse:
    class _Extractor:
        def __init__(self, history):
            self.history = history

        def extract_receipt_data(self, ocr_result, file_name):
            self.history.append(file_name)
            self.last_extraction_error = "api_error"
            self.last_call_info = {
                "model": "m1",
                "latency_ms": 12,
                "finish_reason": "MAX_TOKENS",
                "prompt_tokens": 10,
                "output_tokens": 0,
                "thinking_tokens": 0,
                "raw_text": None,
                "error": None,
                "error_code": None,
            }
            return []

        def extract_from_file(self, file):
            return self.extract_receipt_data(None, file.file_name)

    def _run(self, sheet, drive, history):
        return run_compare(
            _app_config(),
            _env(COMPARE_MODELS="m1", COMPARE_METHODS="text"),
            sheet_client=sheet,
            drive_factory=lambda: drive,
            ocr_factory=lambda: FakeOcr(),
            extractor_factory=lambda ai_config: self._Extractor(history),
            model_checker=lambda name: True,
            sleep=lambda seconds: None,
            jst_now=lambda: NOW,
        )

    def test_none_text_with_finish_reason_is_empty_response_and_not_retried(self):
        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        history = []
        assert self._run(sheet, drive, history) == 0
        row = sheet.tabs["結果_L1"][1]
        assert row[8] == "失敗:empty_response"
        assert row[9] == "MAX_TOKENS"
        assert len(history) == 1

        # 続きからでは呼ばない（empty_response は済み）
        history.clear()
        assert self._run(sheet, drive, history) == 0
        assert history == []
        assert drive.downloads == [file.file_id]


class TestOcrFailureCurrentFlow:
    def test_empty_ocr_current_flow_is_manual_with_zero_cost(self):
        class EmptyOcr:
            def extract_text(self, file):
                return OcrResult(raw_text="", engine="fake", confidence=0.0, error=None)

        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        # 単価の表に無い型でも、AI を呼ばないので費用は 0
        code, _ = _collect(sheet, drive, [], ocr=EmptyOcr())
        assert code == 0
        current = next(row for row in sheet.tabs["結果_L1"][1:] if row[7] == "現行の流れ")
        assert current[8] == "要手入力"
        assert current[19] == "OCR失敗"
        assert current[20] == 0  # 応答ms
        assert current[21:25] == [0, 0, 0, "0.000000"]


class TestScoreDerivesModels:
    def test_score_without_compare_models_uses_result_tab(self):
        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        _collect(sheet, drive, [], env=_env(COMPARE_MODELS="gemini-3.8-flash@low"))

        code = run_compare(
            _app_config(),
            _env(
                COMPARE_STEP="score",
                COMPARE_RUN_LABEL="L1",
                COMPARE_FOLDER_IDS="",
                COMPARE_MODELS=None,
                COMPARE_METHODS=None,
            ),
            sheet_client=sheet,
            jst_now=lambda: NOW,
        )
        assert code == 0
        summary = sheet.tabs["集計_L1"]
        assert any(row[0] == "gemini-3.8-flash@low" for row in summary[8:])
        assert all(row[0] != "gemini-2.5-flash" for row in summary[8:])
        # 主の読み手も、両読みの行がある型のうち最初のものを使う（§4）
        assert sheet.tabs["形_L1"][2] == ["主の読み手", "gemini-3.8-flash@low"]


class TestTimeBudget:
    def test_stops_starting_new_files_and_still_writes_answers(self):
        files = [
            _file("FILE_A1234567890", "a.jpg"),
            _file("FILE_B1234567890", "b.jpg"),
        ]
        drive = FakeDrive({FOLDER: files}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        history = []
        # run_compare に入った時点 / 1 本目の開始 / 1 本目の型の前 / 2 本目の開始
        ticks = iter([0, 0, 0, 999])

        code = run_compare(
            _app_config(),
            _env(COMPARE_MAX_WORKERS="1", COMPARE_MODELS="m1"),
            sheet_client=sheet,
            drive_factory=lambda: drive,
            ocr_factory=lambda: FakeOcr(),
            extractor_factory=_extractor_factory(history),
            model_checker=lambda name: True,
            sleep=lambda seconds: None,
            clock=lambda: next(ticks),
            jst_now=lambda: NOW,
        )
        assert code == 0
        assert len(drive.downloads) == 1
        result_rows = sheet.tabs["結果_L1"]
        file_ids = {row[2] for row in result_rows[1:]}
        assert file_ids == {"FILE_A1234567890"}
        assert "集計_L1" in sheet.replaced
        # 始めていないファイルの答えの行は足さない
        assert len(sheet.tabs["答え"]) == 2

    def test_budget_stops_calling_remaining_models(self):
        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        history = []
        # run_compare の始め / 1 本目の開始 / m1 の前 / m2 の前（ここで時間切れ）
        ticks = iter([0, 0, 0, 999])

        code = run_compare(
            _app_config(),
            _env(COMPARE_MODELS="m1,m2", COMPARE_METHODS="text"),
            sheet_client=sheet,
            drive_factory=lambda: drive,
            ocr_factory=lambda: FakeOcr(),
            extractor_factory=_extractor_factory(history),
            model_checker=lambda name: True,
            sleep=lambda seconds: None,
            clock=lambda: next(ticks),
            jst_now=lambda: NOW,
        )
        assert code == 0
        assert {model for model, _, _ in history} == {"m1"}
        results = sheet.tabs["結果_L1"][1:]
        assert {row[6] for row in results} == {"m1"}
        m2_rows = [row for row in results if row[6] == "m2"]
        assert m2_rows == []  # 時間切れの型の行は書かない（続きから呼ばれる）

    def test_budget_stops_retry_wait(self):
        class AlwaysRetryable:
            def __init__(self, history):
                self.history = history

            def _fail(self, name):
                self.history.append(name)
                self.last_extraction_error = "api_error"
                self.last_call_info = {
                    "model": "m1",
                    "latency_ms": 12,
                    "finish_reason": None,
                    "prompt_tokens": None,
                    "output_tokens": None,
                    "thinking_tokens": None,
                    "raw_text": None,
                    "error": "503 UNAVAILABLE",
                    "error_code": None,
                }
                return []

            def extract_receipt_data(self, ocr_result, file_name):
                return self._fail(file_name)

            def extract_from_file(self, file):
                return self._fail(file.file_name)

        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        history = []
        sleeps = []
        # 始め / 開始 / 型の前 / やり直しの待ちの前（ここで時間切れ）
        ticks = iter([0, 0, 0, 999])

        code = run_compare(
            _app_config(),
            _env(COMPARE_MODELS="m1", COMPARE_METHODS="text"),
            sheet_client=sheet,
            drive_factory=lambda: drive,
            ocr_factory=lambda: FakeOcr(),
            extractor_factory=lambda ai_config: AlwaysRetryable(history),
            model_checker=lambda name: True,
            sleep=sleeps.append,
            clock=lambda: next(ticks),
            jst_now=lambda: NOW,
        )
        assert code == 0
        assert len(history) == 1  # やり直さない
        assert sleeps == []


class TestExceptionWhileRunning:
    def test_append_failure_still_writes_answers_and_summary(self):
        class BrokenAppendSheet(FakeSheet):
            def append_rows(self, title, rows, columns):
                if not rows:
                    return
                raise RuntimeError("sheet write failed")

        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = BrokenAppendSheet()
        code, records = _collect(sheet, drive, [])
        assert code == 1
        assert "集計_L1" in sheet.replaced
        assert any(
            record.levelname == "ERROR" and "例外" in record.getMessage() for record in records
        )

    def test_answer_write_failure_still_writes_summary(self):
        class BrokenAnswerSheet(FakeSheet):
            def append_rows(self, title, rows, columns):
                if title == "答え" and rows:
                    raise RuntimeError("answer write failed")
                super().append_rows(title, rows, columns)

        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = BrokenAnswerSheet()
        code, _ = _collect(sheet, drive, [])
        assert code == 1
        assert "集計_L1" in sheet.replaced


class TestModels:
    def test_missing_model_is_excluded_and_listed(self):
        class NotFoundError(Exception):
            code = 404

        def checker(name):
            if name == "m1":
                raise NotFoundError("not found")
            return True

        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        history = []
        code, _ = _collect(sheet, drive, history, checker=checker)
        assert code == 0
        result_rows = sheet.tabs["結果_L1"]
        assert {row[6] for row in result_rows[1:]} == {"m2"}
        assert all(model == "m2" for model, _, _ in history)
        summary = sheet.tabs["集計_L1"]
        assert ["m1", "使えない型"] in [row[:2] for row in summary]

    def test_other_check_error_keeps_model(self):
        def checker(name):
            raise RuntimeError("network down")

        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        code, _ = _collect(sheet, drive, [], checker=checker)
        assert code == 0
        assert {row[6] for row in sheet.tabs["結果_L1"][1:]} == {"m1", "m2"}


class TestOrdering:
    def test_sorted_and_max_files(self):
        files_folder_a = [
            _file("FILE_B1234567890", "b.jpg", FOLDER),
            _file("FILE_A1234567890", "a.jpg", FOLDER),
        ]
        files_folder_b = [_file("FILE_C1234567890", "a.jpg", FOLDER_2)]
        drive = FakeDrive(
            {FOLDER: files_folder_a, FOLDER_2: files_folder_b},
            {FOLDER: "あ", FOLDER_2: "い"},
        )
        sheet = FakeSheet()
        history = []
        code, _ = _collect(
            sheet,
            drive,
            history,
            env=_env(
                COMPARE_FOLDER_IDS=f"{FOLDER},{FOLDER_2}",
                COMPARE_MODELS="m1",
                COMPARE_METHODS="image",
                COMPARE_MAX_FILES="1",
            ),
        )
        assert code == 0
        assert drive.downloads == ["FILE_A1234567890"]


class TestThreadResources:
    """§5.2: Drive と OCR はスレッドごと、GeminiExtractor はスレッドと型の組ごと。"""

    @staticmethod
    def _models():
        # 記録は ai_config.model（＝型名）で取る。2 つの型を取り違えないよう名前を変える
        return [
            (CompareModel(label="m1", name="m1"), replace(AiConfig(), model="m1")),
            (CompareModel(label="m2", name="m2"), replace(AiConfig(), model="m2")),
        ]

    def test_drive_and_ocr_per_thread_and_extractor_per_thread_and_model(self):
        created = {"drive": [], "ocr": [], "extractor": []}
        lock = threading.Lock()
        barrier = threading.Barrier(2, timeout=10)

        def drive_factory():
            with lock:
                created["drive"].append(threading.get_ident())
            return object()

        def ocr_factory():
            with lock:
                created["ocr"].append(threading.get_ident())
            return object()

        def extractor_factory(ai_config):
            with lock:
                created["extractor"].append((threading.get_ident(), ai_config.model))
            return object()

        resources = _ThreadResources(drive_factory, ocr_factory, extractor_factory)
        models = self._models()
        per_thread = {}

        def work():
            resources.drive()
            resources.drive()
            resources.ocr()
            first = resources.extractor(*models[0])
            again = resources.extractor(*models[0])
            other = resources.extractor(*models[1])
            per_thread[threading.get_ident()] = (first, again, other)
            # 2 つのスレッドが同時に生きている間に作らせる（番号が重ならない前提を置かない）
            barrier.wait()

        threads = [threading.Thread(target=work) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        assert len(created["drive"]) == 2
        assert len(created["ocr"]) == 2
        assert len(created["extractor"]) == 4  # 2 スレッド × 2 型
        assert len(set(created["drive"])) == 2

        by_thread = {}
        for ident, model in created["extractor"]:
            by_thread.setdefault(ident, []).append(model)
        assert sorted(by_thread.values()) == [["m1", "m2"], ["m1", "m2"]]

        for first, again, other in per_thread.values():
            assert first is again  # 同じスレッド・同じ型では作り直さない
            assert first is not other  # 型が違えば別の extractor
        assert len({id(entry[0]) for entry in per_thread.values()}) == 2

    def test_extractor_is_recreated_after_a_thread_ends_even_if_the_id_is_reused(self):
        created = []
        lock = threading.Lock()

        def extractor_factory(ai_config):
            with lock:
                created.append((threading.get_ident(), ai_config.model))
            return object()

        resources = _ThreadResources(lambda: object(), lambda: object(), extractor_factory)
        models = self._models()

        def work():
            for model, ai_config in models:
                resources.extractor(model, ai_config)

        # 1 つ目が終わってから 2 つ目を始める（Linux ではスレッド番号が使い回される）
        first = threading.Thread(target=work)
        first.start()
        first.join()
        second = threading.Thread(target=work)
        second.start()
        second.join()

        assert len(created) == 4  # 2 スレッド × 2 型（前のスレッドの extractor を使い回さない）
        assert [model for _, model in created] == ["m1", "m2", "m1", "m2"]


class TestS3:
    def test_master_equal_result_id_returns_1_without_sheet_api(self):
        class GuardSheet(FakeSheet):
            def __init__(self):
                super().__init__()
                self.calls = 0

            def get_sheet_titles(self):
                self.calls += 1
                return super().get_sheet_titles()

        sheet = GuardSheet()
        code = run_compare(
            _app_config(master=RESULT_ID),
            _env(),
            sheet_client=sheet,
            drive_factory=lambda: (_ for _ in ()).throw(AssertionError("drive")),
            ocr_factory=lambda: (_ for _ in ()).throw(AssertionError("ocr")),
            extractor_factory=lambda ai_config: (_ for _ in ()).throw(AssertionError("extractor")),
            model_checker=lambda name: (_ for _ in ()).throw(AssertionError("model")),
        )
        assert code == 1
        assert sheet.calls == 0

    def test_master_url_is_extracted_before_comparing(self):
        class GuardSheet(FakeSheet):
            def __init__(self):
                super().__init__()
                self.calls = 0

            def get_sheet_titles(self):
                self.calls += 1
                return super().get_sheet_titles()

        sheet = GuardSheet()
        master_url = f"https://docs.google.com/spreadsheets/d/{RESULT_ID}/edit#gid=0"
        code = run_compare(
            _app_config(master=master_url),
            _env(),
            sheet_client=sheet,
            drive_factory=lambda: (_ for _ in ()).throw(AssertionError("drive")),
            ocr_factory=lambda: (_ for _ in ()).throw(AssertionError("ocr")),
            extractor_factory=lambda ai_config: (_ for _ in ()).throw(AssertionError("extractor")),
            model_checker=lambda name: (_ for _ in ()).throw(AssertionError("model")),
        )
        assert code == 1
        assert sheet.calls == 0


class TestConfigErrors:
    def test_invalid_compare_env_returns_1(self):
        sheet = FakeSheet()
        code = run_compare(_app_config(), _env(COMPARE_MAX_WORKERS="9"), sheet_client=sheet)
        assert code == 1
        assert sheet.tabs == {}


class TestScoreStep:
    def test_score_without_label_uses_the_only_result_tab(self):
        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()
        _collect(sheet, drive, [])
        # 結果_ で始まるタブは 結果_L1 だけ
        code, _ = _collect(
            sheet,
            drive,
            [],
            env=_env(
                COMPARE_STEP="score",
                COMPARE_RUN_LABEL="",
                COMPARE_FOLDER_IDS="",
                COMPARE_MODELS="m1,m2",
            ),
        )
        assert code == 0
        assert "集計_L1" in sheet.replaced

    def test_score_without_label_and_two_result_tabs_returns_1_without_writes(self):
        sheet = FakeSheet()
        sheet.tabs["結果_L1"] = [list(RESULT_HEADERS)]
        sheet.tabs["結果_L2"] = [list(RESULT_HEADERS)]
        sheet.tabs["答え"] = [list(ANSWER_HEADERS)]
        code, records = _collect(
            sheet,
            FakeDrive(),
            [],
            env=_env(
                COMPARE_STEP="score",
                COMPARE_RUN_LABEL="",
                COMPARE_FOLDER_IDS="",
                COMPARE_MODELS="m1,m2",
            ),
        )
        assert code == 1
        assert sheet.appended == []
        assert sheet.batch_calls == []
        assert sheet.replaced == []
        assert list(sheet.tabs) == ["結果_L1", "結果_L2", "答え"]
        messages = " ".join(record.getMessage() for record in records)
        assert "COMPARE_RUN_LABEL を指定してください" in messages
        assert "結果_L1" in messages and "結果_L2" in messages


class TestAnswerReadRange:
    def test_answer_reads_in_collect_and_score_end_at_p(self):
        file = _file("FILE_A1234567890", "a.jpg")
        drive = FakeDrive({FOLDER: [file]}, {FOLDER: "テスト用フォルダ"})
        sheet = FakeSheet()

        code, _ = _collect(sheet, drive, [])
        assert code == 0
        collect_reads = [cells for title, cells in sheet.read_calls if title == "答え"]
        assert collect_reads
        assert all(cells == "A:P" for cells in collect_reads)

        sheet.read_calls.clear()
        code, _ = _collect(
            sheet,
            drive,
            [],
            env=_env(COMPARE_STEP="score", COMPARE_FOLDER_IDS=""),
        )
        assert code == 0
        score_reads = [cells for title, cells in sheet.read_calls if title == "答え"]
        assert score_reads
        assert all(cells == "A:P" for cells in score_reads)


class TestModelAiConfigThinking:
    """§9.1: `@` の無い型は AI_THINKING_LEVEL に従い、`@` があればそちらが優先。"""

    @staticmethod
    def _ai_configs(env):
        cfg = load_compare_config(env)
        runner = CompareRunner(
            _app_config(),
            cfg,
            sheet=None,
            drive_factory=None,
            ocr_factory=None,
            extractor_factory=None,
            model_checker=None,
        )
        return cfg, [runner._model_ai_config(model) for model in cfg.models]

    def test_model_without_at_uses_default_low(self):
        cfg, ai_configs = self._ai_configs(_env(COMPARE_MODELS="m1"))
        assert cfg.thinking_level == "low"
        assert cfg.models[0].thinking_level is None
        assert ai_configs[0].thinking_level == "low"

    def test_thinking_level_none_makes_model_without_at_send_no_thinking(self):
        cfg, ai_configs = self._ai_configs(_env(COMPARE_MODELS="m1", AI_THINKING_LEVEL="none"))
        assert cfg.thinking_level is None
        assert ai_configs[0].thinking_level is None

    def test_at_level_wins_over_default_low(self):
        _, ai_configs = self._ai_configs(_env(COMPARE_MODELS="m1@high"))
        assert ai_configs[0].thinking_level == "high"

    def test_at_level_wins_over_thinking_level_none(self):
        _, ai_configs = self._ai_configs(_env(COMPARE_MODELS="m1@medium", AI_THINKING_LEVEL="none"))
        assert ai_configs[0].thinking_level == "medium"

"""審判の collect（仕様 spec_judge_form §5.1・§5.3・J1〜J8）のテスト。"""

import json
import logging
import re

import httpx

from src.compare.judges import JudgeTransportError
from src.compare.pipeline import CompareRow
from src.compare.runner import run_compare
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
from src.models import DriveFile, OcrResult

RESULT_ID = "R" * 24
FOLDER = "FOLDER_A1234567890"
GEMINI_KEY = "fake-gemini-key-AAA"
OPENAI_KEY = "fake-openai-key-BBB"
BASE = "gemini-base"


def _env(**overrides):
    env = {
        "COMPARE_RESULT_SPREADSHEET_ID": RESULT_ID,
        "COMPARE_FOLDER_IDS": FOLDER,
        "COMPARE_MODELS": BASE,
        "COMPARE_METHODS": "text,image",
        "COMPARE_RUN_LABEL": "L1",
        "COMPARE_MAX_WORKERS": "1",
        "COMPARE_TIME_BUDGET_SECONDS": "60",
        "COMPARE_JUDGES": "gemini-decision-1",
    }
    env.update({key: value for key, value in overrides.items() if value is not None})
    for key, value in overrides.items():
        if value is None:
            env.pop(key, None)
    return env


def _app_config(**overrides):
    values = {
        "master": MasterConfig(spreadsheet_id="MASTER_A1234567890"),
        "template": TemplateConfig(),
        "drive": DriveConfig(),
        "sheets": SheetsConfig(),
        "ocr": OcrConfig(),
        "ai": AiConfig(),
        "gemini_api_key": GEMINI_KEY,
        "openai_api_key": OPENAI_KEY,
    }
    values.update(overrides)
    return AppConfig(**values)


class FakeSheet:
    def __init__(self):
        self.tabs = {}
        self.appended = []
        self.replaced = []
        self.read_calls = []
        self.batch_calls = []

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
        headers = [str(value) for value in values[0]]
        rows = []
        for offset, row in enumerate(values[1:], start=2):
            padded = list(row) + [""] * (len(headers) - len(row))
            record = {headers[index]: padded[index] for index in range(len(headers))}
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
        self.tabs.setdefault(title, [[]])
        self.tabs[title].extend(rows)

    def batch_update_cells(self, data):
        if not data:
            return
        self.batch_calls.append(data)
        for update in data:
            match = re.match(r"^'(.+)'!([A-Z]+)(\d+)$", update["range"])
            assert match, update["range"]
            title, column, row = match.groups()
            index = 0
            for char in column:
                index = index * 26 + ord(char) - 64
            index -= 1
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


class FakeDrive:
    def __init__(self, files, contents=None):
        self.files = files
        self.contents = contents or {}
        self.downloads = []

    def list_files(self, folder_id):
        return list(self.files)

    def get_name(self, file_id):
        return "テスト用フォルダ"

    def download_file(self, file):
        self.downloads.append(file.file_id)
        file.content = self.contents.get(file.file_id, b"downloaded")
        return file


class FakeOcr:
    def __init__(self):
        self.calls = 0

    def extract_text(self, file):
        self.calls += 1
        return OcrResult(
            raw_text="テスト商店 合計 1,600円",
            engine="fake",
            confidence=0.9,
            error=None,
            page_count=1,
        )


class FakeExtractor:
    def __init__(self, history):
        self.history = history

    def extract_receipt_data(self, ocr_result, file_name):
        self.history.append((file_name, "text"))
        self.last_extraction_error = None
        self.last_call_info = _info()
        return []

    def extract_from_file(self, file):
        self.history.append((file.file_name, "image"))
        self.last_extraction_error = None
        self.last_call_info = _info()
        return []


def _info():
    return {
        "model": BASE,
        "latency_ms": 1,
        "finish_reason": "STOP",
        "prompt_tokens": 1,
        "output_tokens": 1,
        "thinking_tokens": 0,
        "raw_text": "[]",
        "error": None,
    }


class FakePost:
    def __init__(self, responder):
        self.calls = []
        self.responder = responder

    def __call__(self, url, *, headers, body, timeout):
        self.calls.append({"url": url, "headers": headers, "body": body, "timeout": timeout})
        return self.responder(url, headers, body)


def _success(url, headers, body):
    """質問の最初の候補（＝Ib の値）で答える偽の返り。"""
    if "generativelanguage" in url:
        answers = {}
        for key, question in body["questions"].items():
            if question["type"] == "choice":
                answers[key] = {
                    "type": "choice",
                    "choice": next(iter(question["criteria"])),
                    "confidence": 0.95,
                }
            else:
                answers[key] = {"type": "noul", "noul": 0.95}
        return httpx.Response(
            200,
            json={"answers": answers, "usage": {"total_input_tokens": 10}},
        )
    answers = []
    for question in body["questions"]:
        if question["type"] == "choice":
            answers.append(
                {
                    "name": question["name"],
                    "type": "choice",
                    "choice": question["choices"][0]["value"],
                    "confidence": 0.95,
                }
            )
        else:
            answers.append({"name": question["name"], "type": "predicate", "probability": 0.95})
    return httpx.Response(200, json={"answers": answers, "usage": {"input_tokens": 10}})


def _file(file_id="FILE_A1234567890", name="a.jpg"):
    return DriveFile(file_id=file_id, file_name=name, mime_type="image/jpeg", folder_id=FOLDER)


def _items(*pairs):
    return [{"d": date, "a": amount} for date, amount in pairs]


def _row(file_id, method, items, *, model=BASE, result="成功", cost="0.001000"):
    return CompareRow(
        run_label="L1",
        recorded_at="2026-11-21 12:00:00",
        file_id=file_id,
        folder_name="テスト用フォルダ",
        file_name="a.jpg",
        model_label=model,
        model_name=model,
        method=method,
        result=result,
        count=len(items),
        cost_usd=None if cost == "" else float(cost),
        items_json=json.dumps(items, ensure_ascii=False),
    ).to_sheet_row()


def _prepare(sheet, files, *, image_items=None, text_items=None):
    image_items = image_items or _items(("2026-01-02", 1600))
    text_items = text_items if text_items is not None else _items(("2026-01-02", 1500))
    if "答え" not in sheet.tabs:
        sheet.tabs["答え"] = [list(ANSWER_HEADERS)]
    result = [list(RESULT_HEADERS)]
    ocr = [list(OCR_HEADERS)]
    for file in files:
        result.append(_row(file.file_id, "文字から", text_items))
        result.append(_row(file.file_id, "画像から", image_items))
        ocr.append(
            [
                "L1",
                file.file_id,
                file.file_name,
                "fake",
                0.9,
                10,
                "テスト商店 合計 1,600円",
                "",
                1,
            ]
        )
        sheet.tabs["答え"].append(
            [file.file_id, "a.jpg", "テスト用フォルダ", "a.jpg", "", "2026-01-02", "1600"]
            + [""] * 9
        )
    sheet.tabs["結果_L1"] = result
    sheet.tabs["OCR_L1"] = ocr
    return sheet


def _run(
    sheet,
    drive,
    *,
    post=None,
    env=None,
    config=None,
    ocr=None,
    history=None,
    clock=None,
):
    records = []

    class _Capture(logging.Handler):
        def emit(self, record):
            records.append(record)

    handler = _Capture()
    logger = logging.getLogger("receipt_ocr")
    logger.addHandler(handler)
    try:
        history = history if history is not None else []
        code = run_compare(
            config or _app_config(),
            env or _env(),
            sheet_client=sheet,
            drive_factory=lambda: drive,
            ocr_factory=lambda: ocr or FakeOcr(),
            extractor_factory=lambda ai_config: FakeExtractor(history),
            model_checker=lambda name: True,
            reader_checker=lambda name: True,
            judge_post=post,
            sleep=lambda seconds: None,
            clock=clock or (lambda: 0),
        )
    finally:
        logger.removeHandler(handler)
    return code, records


def _judge_rows(sheet):
    values = sheet.tabs.get("結果_L1", [])
    if not values:
        return []
    header = [str(value) for value in values[0]]
    rows = [dict(zip(header, row, strict=True)) for row in values[1:]]
    return [row for row in rows if row.get("方式") == "審判"]


class TestJ1:
    def test_without_compare_judges_nothing_is_sent_or_written(self):
        file = _file()
        drive = FakeDrive([file])
        sheet = _prepare(FakeSheet(), [file])
        post = FakePost(lambda *args: httpx.Response(500))
        ocr = FakeOcr()
        code, _ = _run(
            sheet,
            drive,
            post=post,
            env=_env(COMPARE_JUDGES=None),
            ocr=ocr,
        )
        assert code == 0
        assert post.calls == []
        assert _judge_rows(sheet) == []
        assert all(row[3] != "C" for row in sheet.tabs.get("形の明細_L1", [[]])[1:] if len(row) > 3)
        assert ocr.calls == 0  # 読み取りはすべて済み

    def test_judge_rows_are_not_counted_by_the_score_summary(self):
        # §5.4: 審判の行を足しても、集計タブの読み手の行は増えない
        file = _file()
        drive = FakeDrive([file])
        sheet = _prepare(FakeSheet(), [file])
        code, _ = _run(sheet, drive, post=FakePost(_success))
        assert code == 0
        assert _judge_rows(sheet)
        summary = sheet.tabs["集計_L1"]
        assert all(row[0] != "gemini-decision-1" for row in summary[8:])

        # score で COMPARE_MODELS を省いても、審判は型として拾わない
        code, _ = _run(
            sheet,
            drive,
            post=FakePost(_success),
            env=_env(
                COMPARE_STEP="score",
                COMPARE_FOLDER_IDS=None,
                COMPARE_MODELS=None,
                COMPARE_JUDGES=None,
            ),
        )
        assert code == 0
        summary = sheet.tabs["集計_L1"]
        assert all(row[0] != "gemini-decision-1" for row in summary[8:])


class TestCollect:
    def test_judge_row_fields_and_form_c(self):
        file = _file()
        drive = FakeDrive([file])
        sheet = _prepare(FakeSheet(), [file])
        code, _ = _run(sheet, drive, post=FakePost(_success))
        assert code == 0
        rows = _judge_rows(sheet)
        assert len(rows) == 1
        row = rows[0]
        assert row["型"] == "gemini-decision-1"
        assert row["方式"] == "審判"
        assert row["結果"] == "成功"
        assert row["件数"] == 2
        assert row["入力トークン"] == 10
        assert row["出力トークン"] == 0
        assert row["設定"] == "provider=google, judge, resolution=high, prompt=judge-1"
        data = json.loads(row["明細JSON"])
        assert data["judge"] == 1
        assert data["base"] == [["2026-01-02", 1600]]
        assert data["items"][0]["a"]["choice"] == "1600"
        assert "形_L1" in sheet.tabs
        assert "形の明細_L1" in sheet.tabs
        assert any(row[3] == "C" for row in sheet.tabs["形の明細_L1"][1:])

    def test_only_files_with_mismatched_items_are_called(self):
        bad = _file("FILE_A1234567890", "a.jpg")
        good = _file("FILE_B1234567890", "b.jpg")
        drive = FakeDrive([bad, good])
        sheet = FakeSheet()
        sheet.tabs["答え"] = [list(ANSWER_HEADERS)]
        result = [list(RESULT_HEADERS)]
        ocr = [list(OCR_HEADERS)]
        cases = (
            (bad, _items(("2026-01-02", 1500))),
            (good, _items(("2026-01-02", 1600))),
        )
        for file, text in cases:
            result += [
                _row(file.file_id, "文字から", text),
                _row(file.file_id, "画像から", _items(("2026-01-02", 1600))),
            ]
            ocr.append(["L1", file.file_id, file.file_name, "fake", 0.9, 10, "OCR", "", 1])
            sheet.tabs["答え"].append(
                [file.file_id, file.file_name, "", file.file_name, "", "2026-01-02", "1600"]
                + [""] * 9
            )
        sheet.tabs["結果_L1"] = result
        sheet.tabs["OCR_L1"] = ocr
        post = FakePost(_success)
        code, _ = _run(sheet, drive, post=post)
        assert code == 0
        assert len(post.calls) == 1
        rows = _judge_rows(sheet)
        assert [row["fileId"] for row in rows] == [bad.file_id]

    def test_resume_skips_done_and_retries_api_error(self):
        file = _file()
        drive = FakeDrive([file])
        sheet = _prepare(FakeSheet(), [file])
        post = FakePost(_success)
        assert _run(sheet, drive, post=post)[0] == 0
        assert len(post.calls) == 1

        # 済みの審判は呼ばない
        post.calls.clear()
        assert _run(sheet, drive, post=post)[0] == 0
        assert post.calls == []

        # 一番下が api_error ならやり直す
        judge_header = [str(value) for value in sheet.tabs["結果_L1"][0]]
        for row in sheet.tabs["結果_L1"][1:]:
            record = dict(zip(judge_header, row, strict=True))
            if record["方式"] == "審判":
                row[judge_header.index("結果")] = "失敗:api_error"
        post.calls.clear()
        sheet.appended.clear()
        assert _run(sheet, drive, post=post)[0] == 0
        assert len(post.calls) == 1
        assert _judge_rows(sheet)[-1]["結果"] == "成功"

    def test_questions_are_built_from_the_sheet_values(self):
        file = _file()
        drive = FakeDrive([file])
        sheet = _prepare(FakeSheet(), [file])
        post = FakePost(_success)
        assert _run(sheet, drive, post=post)[0] == 0
        body = post.calls[0]["body"]
        assert body["questions"]["a0"]["criteria"]["1600"] == "1,600 円"
        assert body["questions"]["d0"]["criteria"]["2026-01-02"] == "2026年1月2日"

    def test_one_judge_failure_does_not_spread(self):
        file = _file()
        drive = FakeDrive([file])
        sheet = _prepare(FakeSheet(), [file])
        env = _env(COMPARE_JUDGES="gemini-decision-bad,gemini-decision-1")

        def responder(url, headers, body):
            if body["model"] == "gemini-decision-bad":
                return httpx.Response(500, text="down")
            return _success(url, headers, body)

        post = FakePost(responder)
        code, _ = _run(sheet, drive, post=post, env=env)
        assert code == 0
        rows = {row["型"]: row for row in _judge_rows(sheet)}
        assert rows["gemini-decision-bad"]["結果"] == "失敗:api_error"
        assert rows["gemini-decision-1"]["結果"] == "成功"

    def test_404_stops_the_remaining_files_of_that_judge(self):
        first = _file("FILE_A1234567890", "a.jpg")
        second = _file("FILE_B1234567890", "b.jpg")
        drive = FakeDrive([first, second])
        sheet = FakeSheet()
        sheet.tabs["答え"] = [list(ANSWER_HEADERS)]
        result = [list(RESULT_HEADERS)]
        ocr = [list(OCR_HEADERS)]
        for file in (first, second):
            result += [
                _row(file.file_id, "文字から", _items(("2026-01-02", 1500))),
                _row(file.file_id, "画像から", _items(("2026-01-02", 1600))),
            ]
            ocr.append(["L1", file.file_id, file.file_name, "fake", 0.9, 10, "OCR", "", 1])
            sheet.tabs["答え"].append(
                [file.file_id, file.file_name, "", file.file_name, "", "2026-01-02", "1600"]
                + [""] * 9
            )
        sheet.tabs["結果_L1"] = result
        sheet.tabs["OCR_L1"] = ocr
        calls = []

        def responder(url, headers, body):
            calls.append(body["model"])
            return httpx.Response(404, text="not found")

        post = FakePost(responder)
        code, records = _run(sheet, drive, post=post)
        assert code == 0
        assert len(post.calls) == 1
        assert len(_judge_rows(sheet)) == 1
        assert any("使えない審判" in record.getMessage() for record in records)

    def test_time_budget_skips_the_judge_pass(self):
        file = _file()
        drive = FakeDrive([file])
        sheet = _prepare(FakeSheet(), [file])
        post = FakePost(_success)
        ticks = {"count": 0}

        def clock():
            ticks["count"] += 1
            return 0 if ticks["count"] == 1 else 999

        code, _ = _run(sheet, drive, post=post, clock=clock)
        assert code == 0
        assert post.calls == []
        assert _judge_rows(sheet) == []

    def test_max_files_limits_the_judge_targets(self):
        first = _file("FILE_A1234567890", "a.jpg")
        second = _file("FILE_B1234567890", "b.jpg")
        drive = FakeDrive([first, second])
        sheet = _prepare(FakeSheet(), [first, second])
        post = FakePost(_success)
        code, _ = _run(sheet, drive, post=post, env=_env(COMPARE_MAX_FILES="1"))
        assert code == 0
        assert len(post.calls) == 1
        assert [row["fileId"] for row in _judge_rows(sheet)] == [first.file_id]

    def test_too_many_items_writes_a_failure_row_without_a_call(self):
        file = _file()
        drive = FakeDrive([file])
        image = _items(*[("2026-01-02", 100 + index) for index in range(21)])
        text = _items(*[("2026-01-02", 1) for _ in range(21)])
        sheet = _prepare(FakeSheet(), [file], image_items=image, text_items=text)
        post = FakePost(_success)
        code, _ = _run(sheet, drive, post=post)
        assert code == 0
        assert post.calls == []
        rows = _judge_rows(sheet)
        assert rows[0]["結果"] == "失敗:too_many_items"

    def test_vision_is_not_called_when_only_the_judge_is_left(self):
        file = _file()
        drive = FakeDrive([file])
        sheet = _prepare(FakeSheet(), [file])
        ocr = FakeOcr()
        code, _ = _run(sheet, drive, post=FakePost(_success), ocr=ocr)
        assert code == 0
        assert ocr.calls == 0


class TestKeys:
    def test_missing_google_key_exits_1_without_any_call(self):
        file = _file()
        drive = FakeDrive([file])
        sheet = _prepare(FakeSheet(), [file])
        post = FakePost(_success)
        code, records = _run(
            sheet,
            drive,
            post=post,
            config=_app_config(gemini_api_key=""),
        )
        assert code == 1
        assert post.calls == []
        assert drive.downloads == []
        assert sheet.read_calls == []
        assert any("GEMINI_API_KEY" in record.getMessage() for record in records)

    def test_missing_openai_key_exits_1_without_any_call(self):
        file = _file()
        drive = FakeDrive([file])
        sheet = _prepare(FakeSheet(), [file])
        post = FakePost(_success)
        code, _ = _run(
            sheet,
            drive,
            post=post,
            env=_env(COMPARE_JUDGES="gpt-6-luna"),
            config=_app_config(openai_api_key=""),
        )
        assert code == 1
        assert post.calls == []
        assert drive.downloads == []

    def test_score_works_without_keys_and_sends_no_http(self):
        file = _file()
        drive = FakeDrive([file])
        sheet = _prepare(FakeSheet(), [file])
        post = FakePost(_success)
        code, _ = _run(
            sheet,
            drive,
            post=post,
            env=_env(
                COMPARE_STEP="score",
                COMPARE_FOLDER_IDS=None,
                COMPARE_JUDGES=None,
            ),
            config=_app_config(gemini_api_key="", openai_api_key=""),
        )
        assert code == 0
        assert post.calls == []
        assert drive.downloads == []

    def test_error_details_and_logs_hide_the_keys(self):
        file = _file()
        drive = FakeDrive([file])
        sheet = _prepare(FakeSheet(), [file])

        def responder(url, headers, body):
            raise JudgeTransportError(
                f"boom {GEMINI_KEY} {OPENAI_KEY} "
                f"https://generativelanguage.googleapis.com/v1beta/decisions?key={GEMINI_KEY}"
            )

        post = FakePost(responder)
        code, records = _run(sheet, drive, post=post)
        assert code == 0
        rows = _judge_rows(sheet)
        assert rows[0]["結果"] == "失敗:api_error"
        assert GEMINI_KEY not in rows[0]["エラー詳細"]
        assert OPENAI_KEY not in rows[0]["エラー詳細"]
        assert "***" in rows[0]["エラー詳細"]
        messages = " ".join(record.getMessage() for record in records)
        assert GEMINI_KEY not in messages
        assert OPENAI_KEY not in messages
        call = post.calls[0]
        assert GEMINI_KEY not in call["url"]
        assert GEMINI_KEY not in json.dumps(call["body"], ensure_ascii=False)
        assert call["headers"]["x-goog-api-key"] == GEMINI_KEY

    def test_openai_judge_uses_the_openai_url_and_header(self):
        file = _file()
        drive = FakeDrive([file])
        sheet = _prepare(FakeSheet(), [file])
        post = FakePost(_success)
        code, _ = _run(
            sheet,
            drive,
            post=post,
            env=_env(COMPARE_JUDGES="gpt-6-luna"),
            config=_app_config(openai_api_key=OPENAI_KEY),
        )
        assert code == 0
        call = post.calls[0]
        assert call["url"] == "https://api.openai.com/v1/decisions"
        assert call["headers"]["Authorization"] == f"Bearer {OPENAI_KEY}"
        assert _judge_rows(sheet)[0]["設定"].startswith("provider=openai, judge")

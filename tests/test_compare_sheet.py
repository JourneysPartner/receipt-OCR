"""比較の表への書込み（S5: すべて RAW）のテスト"""

import re
from datetime import UTC, datetime

from src.compare.runner import run_compare
from src.compare.sheet import (
    ANSWER_HEADERS,
    RESULT_HEADERS,
    CompareSheetClient,
    HeaderMismatchError,
    cell_range,
)
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


class _Exec:
    def __init__(self, result=None):
        self._result = result if result is not None else {}

    def execute(self):
        return self._result


class _Values:
    def __init__(self, calls, titles):
        self.calls = calls
        self.titles = titles

    def get(self, **kwargs):
        self.calls.append(("get", kwargs))
        return _Exec({"values": []})

    def update(self, **kwargs):
        self.calls.append(("update", kwargs))
        if kwargs["range"].endswith("!A1"):
            body = kwargs.get("body", {}).get("values", [])
            if body:
                self.titles.add(body[0][0])
        return _Exec()

    def append(self, **kwargs):
        self.calls.append(("append", kwargs))
        return _Exec()

    def batchUpdate(self, **kwargs):  # noqa: N802 - Google Sheets API の名前
        self.calls.append(("values.batchUpdate", kwargs))
        return _Exec()

    def clear(self, **kwargs):
        self.calls.append(("clear", kwargs))
        return _Exec()


class _Spreadsheets:
    def __init__(self, calls, titles):
        self._values = _Values(calls, titles)
        self.calls = calls
        self.titles = titles

    def values(self):
        return self._values

    def get(self, **kwargs):
        self.calls.append(("sheets.get", kwargs))
        return _Exec(
            {"sheets": [{"properties": {"title": title}} for title in sorted(self.titles)]}
        )

    def batchUpdate(self, **kwargs):  # noqa: N802 - Google Sheets API の名前
        self.calls.append(("sheets.batchUpdate", kwargs))
        return _Exec()


class _Service:
    def __init__(self):
        self.calls = []
        self.titles = set()
        self._spreadsheets = _Spreadsheets(self.calls, self.titles)

    def spreadsheets(self):
        return self._spreadsheets


def _client():
    return CompareSheetClient("R" * 24, service=_Service(), sleep=lambda seconds: None)


def test_all_writes_are_raw():
    client = _client()
    service = client._service
    client.ensure_tab("結果_L1", ["型", "方式"])
    client.append_rows("結果_L1", [["=SUM(A1)", "文字から"]], 2)
    client.batch_update_cells([{"range": cell_range("結果_L1", 0, 3), "values": [["=1+1"]]}])
    client.replace_all("集計_L1", [["見出し", "=SUM(B1:B2)"]])

    writes = [kwargs for _, kwargs in service.calls if "valueInputOption" in kwargs]
    assert writes
    assert all(kwargs["valueInputOption"] == "RAW" for kwargs in writes)

    appended = [kwargs for name, kwargs in service.calls if name == "append"][0]
    assert appended["body"]["values"] == [["=SUM(A1)", "文字から"]]
    assert appended["valueInputOption"] == "RAW"

    updated = [
        kwargs
        for name, kwargs in service.calls
        if name == "update" and kwargs["range"].startswith("'集計_L1'")
    ][0]
    assert updated["body"]["values"] == [["見出し", "=SUM(B1:B2)"]]
    assert updated["valueInputOption"] == "RAW"

    clears = [kwargs for name, kwargs in service.calls if name == "clear"]
    assert clears and clears[0]["range"].startswith("'集計_L1'")


class _HttpError(Exception):
    def __init__(self, status):
        super().__init__(f"status {status}")
        self.resp = type("Resp", (), {"status": status})()


class _FlakyValues(_Values):
    def __init__(self, calls, titles, failures):
        super().__init__(calls, titles)
        self.failures = list(failures)

    def get(self, **kwargs):
        if self.failures:
            raise _HttpError(self.failures.pop(0))
        return super().get(**kwargs)


class _FlakyService(_Service):
    def __init__(self, failures):
        super().__init__()
        self._spreadsheets = _Spreadsheets(self.calls, self.titles)
        self._spreadsheets._values = _FlakyValues(self.calls, self.titles, failures)


def test_sheet_read_retries_429_and_5xx_only():
    sleeps = []
    client = CompareSheetClient(
        "R" * 24,
        service=_FlakyService([429, 503]),
        sleep=sleeps.append,
        retry_sleeps=(10, 30, 60),
    )
    assert client.read_values("結果_L1") == []
    assert sleeps == [10, 30]

    sleeps = []
    client = CompareSheetClient(
        "R" * 24,
        service=_FlakyService([400]),
        sleep=sleeps.append,
        retry_sleeps=(10, 30, 60),
    )
    try:
        client.read_values("結果_L1")
    except _HttpError:
        pass
    else:  # pragma: no cover - 400 はそのまま投げる
        raise AssertionError("400 should not be retried")
    assert sleeps == []


def test_ensure_tab_adds_sheet_and_header_once():
    client = _client()
    service = client._service
    client.ensure_tab("答え", ANSWER_HEADERS)
    adds = [kwargs for name, kwargs in service.calls if name == "sheets.batchUpdate"]
    assert adds and adds[0]["body"]["requests"][0]["addSheet"]["properties"]["title"] == "答え"
    service.titles.add("答え")
    client.ensure_tab("答え", ANSWER_HEADERS)
    adds = [kwargs for name, kwargs in service.calls if name == "sheets.batchUpdate"]
    assert len(adds) == 1


# ── タブごとの列数を持つ偽の Sheets（§6・指摘 1） ──────────────
class _FakeApiError(Exception):
    def __init__(self, status=400, message="exceeds grid limits"):
        super().__init__(message)
        self.resp = type("Resp", (), {"status": status})()


_CELL_RE = re.compile(
    r"^(?P<start>[A-Z]+)(?P<start_row>\d+)?(?::(?P<end>[A-Z]+)(?P<end_row>\d+)?)?$"
)
_ROW_RE = re.compile(r"^(?P<start_row>\d+):(?P<end_row>\d+)$")


def _column_index(letters: str) -> int:
    value = 0
    for char in letters:
        value = value * 26 + (ord(char) - 64)
    return value - 1


def _parse_range(range_text: str):
    title, _, cells = range_text.partition("!")
    if title.startswith("'") and title.endswith("'"):
        title = title[1:-1]
    if not cells:
        return title, 0, None, None, None
    row_match = _ROW_RE.match(cells)
    if row_match:
        # 行だけの範囲（例 1:1）。列を指定しないので列数の上限に触れない
        return (
            title,
            0,
            int(row_match.group("start_row")) - 1,
            None,
            int(row_match.group("end_row")) - 1,
        )
    match = _CELL_RE.match(cells)
    assert match, cells
    start_col = _column_index(match.group("start"))
    start_row = int(match.group("start_row")) - 1 if match.group("start_row") else None
    end_col = _column_index(match.group("end")) if match.group("end") else start_col
    end_row = int(match.group("end_row")) - 1 if match.group("end_row") else start_row
    return title, start_col, start_row, end_col, end_row


class _FakeTab:
    def __init__(self, sheet_id: int, title: str, columns: int, values=None):
        self.sheet_id = sheet_id
        self.title = title
        self.columns = columns
        self.values: list[list] = [list(row) for row in (values or [])]


class FakeSheetsService:
    """タブごとの列数を持ち、列数を超える範囲の読み書きに 400 を返す。"""

    def __init__(self):
        self.tabs: dict[str, _FakeTab] = {}
        self.write_calls: list[tuple] = []
        self._next_sheet_id = 1

    def add_tab(self, title, columns=26, values=None):
        tab = _FakeTab(self._next_sheet_id, title, columns, values)
        self._next_sheet_id += 1
        self.tabs[title] = tab
        return tab

    def spreadsheets(self):
        return _FakeSpreadsheets(self)

    # ── 範囲の検査と読み書き ─────────────────────────────
    def _tab(self, title):
        if title not in self.tabs:
            raise _FakeApiError(400, f"Unable to parse range: {title}")
        return self.tabs[title]

    def _check_columns(self, tab, max_col):
        if max_col is not None and max_col >= tab.columns:
            raise _FakeApiError(400, "exceeds grid limits")

    def read(self, range_text):
        title, start_col, start_row, end_col, end_row = _parse_range(range_text)
        tab = self._tab(title)
        self._check_columns(tab, end_col)
        rows = tab.values if start_row is None else tab.values[start_row : (end_row + 1)]
        if end_col is None:
            return [list(row) for row in rows]
        return [list(row[start_col : end_col + 1]) for row in rows]

    def _write(self, tab, start_col, start_row, rows):
        for offset, row in enumerate(rows):
            row_index = (start_row or 0) + offset
            while len(tab.values) <= row_index:
                tab.values.append([])
            target = tab.values[row_index]
            while len(target) < start_col + len(row):
                target.append("")
            for index, value in enumerate(row):
                target[start_col + index] = value

    def update(self, range_text, values):
        title, start_col, start_row, end_col, end_row = _parse_range(range_text)
        tab = self._tab(title)
        widest = max(
            [end_col if end_col is not None else 0]
            + [start_col + len(row) - 1 for row in values if row]
        )
        self._check_columns(tab, widest)
        self._write(tab, start_col, start_row, values)
        self.write_calls.append(("update", range_text))

    def append(self, range_text, values):
        title, start_col, _, end_col, _ = _parse_range(range_text)
        tab = self._tab(title)
        widest = max(
            [end_col if end_col is not None else 0]
            + [start_col + len(row) - 1 for row in values if row]
        )
        self._check_columns(tab, widest)
        tab.values.extend([list(row) for row in values])
        self.write_calls.append(("append", range_text))

    def clear(self, range_text):
        title, _, _, end_col, _ = _parse_range(range_text)
        tab = self._tab(title)
        self._check_columns(tab, end_col)
        tab.values = []
        self.write_calls.append(("clear", range_text))

    def batch_update_values(self, data):
        for item in data:
            title, start_col, start_row, end_col, _ = _parse_range(item["range"])
            tab = self._tab(title)
            self._check_columns(tab, max(end_col or 0, start_col))
            self._write(tab, start_col, start_row, item["values"])
        self.write_calls.append(("values.batchUpdate", ""))
        return {}


class _FakeValues:
    def __init__(self, service):
        self._service = service

    def get(self, **kwargs):
        return _Exec({"values": self._service.read(kwargs["range"])})

    def update(self, **kwargs):
        self._service.update(kwargs["range"], kwargs.get("body", {}).get("values", []))
        return _Exec()

    def append(self, **kwargs):
        self._service.append(kwargs["range"], kwargs.get("body", {}).get("values", []))
        return _Exec()

    def clear(self, **kwargs):
        self._service.clear(kwargs["range"])
        return _Exec()

    def batchUpdate(self, **kwargs):  # noqa: N802 - Google Sheets API の名前
        return _Exec(self._service.batch_update_values(kwargs.get("body", {}).get("data", [])))


class _FakeSpreadsheets:
    def __init__(self, service):
        self._service = service
        self._values = _FakeValues(service)

    def values(self):
        return self._values

    def get(self, **kwargs):
        return _Exec(
            {
                "sheets": [
                    {
                        "properties": {
                            "sheetId": tab.sheet_id,
                            "title": tab.title,
                            "gridProperties": {"rowCount": 1000, "columnCount": tab.columns},
                        }
                    }
                    for tab in self._service.tabs.values()
                ]
            }
        )

    def batchUpdate(self, **kwargs):  # noqa: N802 - Google Sheets API の名前
        service = self._service
        for request in kwargs.get("body", {}).get("requests", []):
            if "addSheet" in request:
                properties = request["addSheet"].get("properties", {})
                grid = properties.get("gridProperties") or {}
                service.add_tab(properties["title"], int(grid.get("columnCount") or 26))
                service.write_calls.append(("addSheet", properties["title"]))
            if "appendDimension" in request:
                append = request["appendDimension"]
                tab = next(
                    tab for tab in service.tabs.values() if tab.sheet_id == append["sheetId"]
                )
                tab.columns += int(append["length"])
                service.write_calls.append(("appendDimension", tab.title))
        return _Exec()


class _CollectDrive:
    def __init__(self, files):
        self.files = list(files)
        self.downloads = []

    def list_files(self, folder_id):
        return list(self.files)

    def get_name(self, file_id):
        return "テスト用フォルダ"

    def download_file(self, file):
        self.downloads.append(file.file_id)
        file.content = b"downloaded"
        return file


class _CollectOcr:
    def extract_text(self, file):
        return OcrResult(
            raw_text="テスト商店 合計 1,600円", engine="fake", confidence=0.9, error=None
        )


class _CollectExtractor:
    def __init__(self, model):
        self.model = model

    def _items(self):
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

    def _info(self):
        return {
            "model": self.model,
            "latency_ms": 12,
            "finish_reason": "STOP",
            "prompt_tokens": 10,
            "output_tokens": 2,
            "thinking_tokens": 0,
            "raw_text": "[]",
            "error": None,
            "error_code": None,
        }

    def extract_receipt_data(self, ocr_result, file_name):
        self.last_extraction_error = None
        self.last_call_info = self._info()
        return self._items()

    def extract_from_file(self, file):
        self.last_extraction_error = None
        self.last_call_info = self._info()
        return self._items()


RESULT_ID = "R" * 24
FOLDER = "FOLDER_A1234567890"
NOW = datetime(2026, 11, 18, 3, 0, tzinfo=UTC)


def _app_config():
    return AppConfig(
        master=MasterConfig(),
        template=TemplateConfig(),
        drive=DriveConfig(),
        sheets=SheetsConfig(),
        ocr=OcrConfig(),
        ai=AiConfig(),
        gemini_api_key="FAKE",
    )


def _env():
    return {
        "COMPARE_RESULT_SPREADSHEET_ID": RESULT_ID,
        "COMPARE_FOLDER_IDS": FOLDER,
        "COMPARE_MODELS": "m1",
        "COMPARE_METHODS": "text,image",
        "COMPARE_RUN_LABEL": "L1",
        "COMPARE_TIME_BUDGET_SECONDS": "60",
    }


def _collect_into(service):
    client = CompareSheetClient(RESULT_ID, service=service, sleep=lambda seconds: None)
    drive = _CollectDrive(
        [
            DriveFile(
                file_id="FILE_A1234567890",
                file_name="a.jpg",
                mime_type="image/jpeg",
                folder_id=FOLDER,
            )
        ]
    )
    code = run_compare(
        _app_config(),
        _env(),
        sheet_client=client,
        drive_factory=lambda: drive,
        ocr_factory=lambda: _CollectOcr(),
        extractor_factory=lambda ai_config: _CollectExtractor(ai_config.model),
        model_checker=lambda name: True,
        sleep=lambda seconds: None,
        jst_now=lambda: NOW,
    )
    return code, service


def _score_into(service, *, label="L1"):
    client = CompareSheetClient(RESULT_ID, service=service, sleep=lambda seconds: None)
    return run_compare(
        _app_config(),
        {
            "COMPARE_STEP": "score",
            "COMPARE_RESULT_SPREADSHEET_ID": RESULT_ID,
            "COMPARE_FOLDER_IDS": "",
            "COMPARE_RUN_LABEL": label,
        },
        sheet_client=client,
        jst_now=lambda: NOW,
    )


def test_collect_finishes_with_new_tabs_of_28_columns():
    service = FakeSheetsService()
    code, service = _collect_into(service)
    assert code == 0
    result_tab = service.tabs["結果_L1"]
    assert result_tab.columns == 28
    assert result_tab.values[0] == RESULT_HEADERS
    assert len(result_tab.values) == 1 + 3  # 1 ファイル × (文字・画像・現行)
    assert "集計_L1" in service.tabs


def test_collect_finishes_with_existing_26_column_tabs():
    service = FakeSheetsService()
    for title in ("答え", "結果_L1", "OCR_L1"):
        service.add_tab(title, columns=26)
    code, service = _collect_into(service)
    assert code == 0
    result_tab = service.tabs["結果_L1"]
    assert result_tab.columns == 28
    assert len(result_tab.values) == 1 + 3
    assert ("appendDimension", "結果_L1") in service.write_calls


def test_ensure_tab_expands_columns_and_reads_the_header_range():
    service = FakeSheetsService()
    service.add_tab("結果_L1", columns=26)
    client = CompareSheetClient("R" * 24, service=service, sleep=lambda seconds: None)
    headers = [f"列{i}" for i in range(28)]
    client.ensure_tab("結果_L1", headers)
    assert service.tabs["結果_L1"].columns == 28
    assert service.read("'結果_L1'!A1:AB1")[0] == headers
    # 2 回目は足さず、見出しも書き直さない
    writes = len(service.write_calls)
    client.ensure_tab("結果_L1", headers)
    assert service.tabs["結果_L1"].columns == 28
    assert len(service.write_calls) == writes


def test_existing_tab_is_expanded_before_reading_the_header():
    service = FakeSheetsService()
    service.add_tab("結果_L1", columns=26, values=[RESULT_HEADERS])
    client = CompareSheetClient("R" * 24, service=service, sleep=lambda seconds: None)
    client.ensure_tab("結果_L1", RESULT_HEADERS)
    assert service.tabs["結果_L1"].columns == 28
    assert ("appendDimension", "結果_L1") in service.write_calls
    assert not any(name == "update" for name, _ in service.write_calls)


def test_header_mismatch_returns_1_without_any_write():
    service = FakeSheetsService()
    service.add_tab(
        "答え",
        columns=26,
        values=[ANSWER_HEADERS[:5] + ["余分な列"] + ANSWER_HEADERS[5:]],
    )
    code, service = _collect_into(service)
    assert code == 1
    assert service.write_calls == []
    assert list(service.tabs) == ["答え"]


def test_score_with_added_answer_column_returns_1_without_any_write():
    service = FakeSheetsService()
    service.add_tab(
        "答え",
        columns=26,
        values=[ANSWER_HEADERS[:5] + ["余分な列"] + ANSWER_HEADERS[5:]],
    )
    service.add_tab("結果_L1", columns=28, values=[RESULT_HEADERS])
    assert _score_into(service) == 1
    assert service.write_calls == []


def test_score_with_added_result_column_returns_1_without_any_write():
    service = FakeSheetsService()
    service.add_tab("答え", columns=26, values=[ANSWER_HEADERS])
    service.add_tab(
        "結果_L1",
        columns=30,
        values=[RESULT_HEADERS[:5] + ["余分な列"] + RESULT_HEADERS[5:]],
    )
    assert _score_into(service) == 1
    assert service.write_calls == []


def test_collect_with_wrong_result_header_does_not_create_or_expand_before_stopping():
    service = FakeSheetsService()
    service.add_tab(
        "結果_L1",
        columns=26,
        values=[RESULT_HEADERS[:5] + ["別の列"] + RESULT_HEADERS[5:]],
    )
    code, service = _collect_into(service)
    assert code == 1
    assert service.write_calls == []
    assert list(service.tabs) == ["結果_L1"]


def test_collect_with_small_wrong_header_does_not_expand_columns():
    service = FakeSheetsService()
    service.add_tab("答え", columns=3, values=[["fileId", "別の列", "さらに別"]])
    code, service = _collect_into(service)
    assert code == 1
    assert service.write_calls == []
    assert service.tabs["答え"].columns == 3


def test_header_trailing_empty_cells_are_same():
    service = FakeSheetsService()
    service.add_tab("答え", columns=26, values=[list(ANSWER_HEADERS) + ["", ""]])
    client = CompareSheetClient("R" * 24, service=service, sleep=lambda seconds: None)
    client.ensure_tab("答え", ANSWER_HEADERS)
    assert service.write_calls == []


def test_header_mismatch_raises_from_ensure_tab():
    service = FakeSheetsService()
    service.add_tab("結果_L1", columns=26, values=[["型", "別の列"]])
    client = CompareSheetClient("R" * 24, service=service, sleep=lambda seconds: None)
    try:
        client.ensure_tab("結果_L1", ["型", "方式"])
    except HeaderMismatchError:
        pass
    else:  # pragma: no cover - 見出しが違えば必ず上げる
        raise AssertionError("HeaderMismatchError should be raised")

"""比較の表への書込み（S5: すべて RAW）のテスト"""

from src.compare.sheet import ANSWER_HEADERS, CompareSheetClient, cell_range


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

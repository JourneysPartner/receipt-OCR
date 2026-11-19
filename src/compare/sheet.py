"""比較結果を書くスプレッドシート（仕様 §6）。

表への書込みはすべて valueInputOption=RAW。Sheets API は主のスレッドだけが使う。
"""

import time

from google.oauth2 import service_account
from googleapiclient.discovery import build

from src.logging.logger import setup_logger

logger = setup_logger()

ANSWER_HEADERS = [
    "fileId",
    "ファイル",
    "フォルダ",
    "ファイル名",
    "状態",
    "正解_日付",
    "正解_金額",
    "正解_税率",
    "正解_店名",
    "答えの出どころ",
    "メモ",
    "候補_日付",
    "候補_金額",
    "候補_税率",
    "候補_店名",
    "更新",
]

# 「答え」を読む範囲（P 列まで。Q 列より右は読まない。監査 M5）
ANSWER_CELLS = "A:P"

MULTI_ANSWER_TITLE = "答え_複数"
MULTI_ANSWER_HEADERS = [
    "fileId",
    "ファイル名",
    "番号",
    "正解_日付",
    "正解_金額",
    "正解_税率",
    "正解_店名",
    "メモ",
]

RESULT_HEADERS = [
    "実行ラベル",
    "記録時刻",
    "fileId",
    "ファイル",
    "フォルダ",
    "ファイル名",
    "型",
    "方式",
    "結果",
    "終了理由",
    "再試行",
    "件数",
    "日付",
    "合計金額",
    "税率",
    "店名",
    "摘要",
    "勘定科目",
    "信頼度",
    "金額照合",
    "応答ms",
    "入力トークン",
    "出力トークン",
    "思考トークン",
    "推定費用USD",
    "設定",
    "エラー詳細",
    "生の応答",
    "明細JSON",
]

OCR_HEADERS = [
    "実行ラベル",
    "fileId",
    "ファイル名",
    "OCR方式",
    "信頼度",
    "文字数",
    "OCR文字",
    "エラー",
]

SUMMARY_HEADERS = [
    "型",
    "方式",
    "ファイル数",
    "失敗",
    "MAX_TOKENS",
    "金額照合NG",
    "日付",
    "金額",
    "税率",
    "店名",
    "日付と金額",
    "正しく自動",
    "誤って自動",
    "要手入力",
    "平均応答ms",
    "最大応答ms",
    "入力トークン",
    "出力トークン",
    "思考トークン",
    "推定費用USD",
    "1本あたりUSD",
]

SPREADSHEET_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
DEFAULT_RETRY_SLEEPS = (10, 30, 60)
# API で作ったタブの既定の列数（A〜Z）。見出しがこれより多いときは足す
DEFAULT_COLUMN_COUNT = 26


class HeaderMismatchError(RuntimeError):
    """既にあるタブの 1 行目が、決まった見出しと違う（S6: 列の位置に頼る）。"""

    def __init__(self, title: str, expected: list[str], actual: list[str]):
        self.title = title
        self.expected = list(expected)
        self.actual = list(actual)
        super().__init__(f"タブ {title!r} の見出しが決まった並びと違います")


def _col_letter(index: int) -> str:
    result = ""
    while True:
        result = chr(65 + index % 26) + result
        index = index // 26 - 1
        if index < 0:
            return result


def _trim_trailing_empty(row) -> list[str]:
    """見出しの後ろに空のセルがあるだけなら同じとみなす。"""
    values = list(row)
    while values and (values[-1] is None or str(values[-1]) == ""):
        values.pop()
    return [str(value) if value is not None else "" for value in values]


def _status_code(error) -> int | None:
    resp = getattr(error, "resp", None)
    status = getattr(resp, "status", None)
    if status is None:
        status = getattr(error, "status_code", None)
    try:
        return int(status)
    except (TypeError, ValueError):
        return None


def _is_retryable(error) -> bool:
    status = _status_code(error)
    return status == 429 or (status is not None and 500 <= status < 600)


def _build_service(credentials_path: str | None):
    if credentials_path:
        creds = service_account.Credentials.from_service_account_file(
            credentials_path, scopes=SPREADSHEET_SCOPES
        )
    else:
        import google.auth

        creds, _ = google.auth.default(scopes=SPREADSHEET_SCOPES)
    return build("sheets", "v4", credentials=creds)


class CompareSheetClient:
    """比較結果の 1 スプレッドシート。"""

    def __init__(
        self,
        spreadsheet_id: str,
        credentials_path: str | None = None,
        *,
        service=None,
        sleep=time.sleep,
        retry_sleeps=DEFAULT_RETRY_SLEEPS,
    ):
        self._spreadsheet_id = spreadsheet_id
        self._service = service if service is not None else _build_service(credentials_path)
        self._sheets = self._service.spreadsheets()
        self._sleep = sleep
        self._retry_sleeps = tuple(retry_sleeps)

    # ── 低レベル ──────────────────────────────────
    def _execute(self, call):
        for attempt in range(len(self._retry_sleeps) + 1):
            try:
                return call()
            except Exception as error:
                if attempt >= len(self._retry_sleeps) or not _is_retryable(error):
                    raise
                logger.warning(
                    f"比較の表 API が {_status_code(error)} のため再試行します",
                    extra={"step": "compare_sheet_retry"},
                )
                self._sleep(self._retry_sleeps[attempt])

    def get_sheet_properties(self) -> list[dict]:
        meta = self._execute(
            lambda: self._sheets.get(
                spreadsheetId=self._spreadsheet_id,
                fields="sheets.properties",
            ).execute()
        )
        return [s.get("properties", {}) for s in meta.get("sheets", [])]

    def get_sheet_titles(self) -> list[str]:
        return [str(properties.get("title", "")) for properties in self.get_sheet_properties()]

    def _expand_columns(self, properties: dict, needed: int) -> int:
        """既にあるタブの列数が見出しより少なければ COLUMNS を足す。"""
        grid = properties.get("gridProperties") or {}
        current = int(grid.get("columnCount") or DEFAULT_COLUMN_COUNT)
        if current >= needed:
            return current
        self._execute(
            lambda: self._sheets.batchUpdate(
                spreadsheetId=self._spreadsheet_id,
                body={
                    "requests": [
                        {
                            "appendDimension": {
                                "sheetId": properties.get("sheetId"),
                                "dimension": "COLUMNS",
                                "length": needed - current,
                            }
                        }
                    ]
                },
            ).execute()
        )
        return needed

    def ensure_tab(
        self,
        title: str,
        headers: list[str],
        *,
        check_headers: bool = True,
        prefix_only: bool = False,
    ) -> None:
        properties = {str(p.get("title", "")): p for p in self.get_sheet_properties()}
        needed = max(len(headers), DEFAULT_COLUMN_COUNT)
        if title in properties:
            # 見出しより列が少なければ先に足してから読む（400 を避ける）
            total_columns = self._expand_columns(properties[title], len(headers))
            if prefix_only:
                # 先頭 len(headers) 個だけを見る（それより右は読まない）
                read_columns = min(max(total_columns, 1), len(headers))
            else:
                read_columns = max(total_columns, 1)
            header_last_col = _col_letter(read_columns - 1)
            values = self.read_values(title, f"A1:{header_last_col}1")
            actual = _trim_trailing_empty(values[0]) if values else []
            if actual:
                if not check_headers:
                    return
                expected = [str(header) for header in headers]
                compared = actual[: len(expected)] if prefix_only else actual
                if compared != expected:
                    raise HeaderMismatchError(title, headers, actual)
                return
        else:
            self._execute(
                lambda: self._sheets.batchUpdate(
                    spreadsheetId=self._spreadsheet_id,
                    body={
                        "requests": [
                            {
                                "addSheet": {
                                    "properties": {
                                        "title": title,
                                        "gridProperties": {"columnCount": needed},
                                    }
                                }
                            }
                        ]
                    },
                ).execute()
            )

        last_col = _col_letter(len(headers) - 1)
        self._execute(
            lambda: (
                self._sheets.values()
                .update(
                    spreadsheetId=self._spreadsheet_id,
                    range=f"'{title}'!A1:{last_col}1",
                    valueInputOption="RAW",
                    body={"values": [headers]},
                )
                .execute()
            )
        )

    def read_header(self, title: str) -> list[str]:
        """既にあるタブの 1 行目だけを読む（列数に収まるので列を足さない）。"""
        values = self.read_values(title, "1:1")
        if not values:
            return []
        return _trim_trailing_empty(values[0])

    def read_values(
        self, title: str, cells: str | None = None, *, formatted: bool = False
    ) -> list[list]:
        render = "FORMATTED_VALUE" if formatted else "UNFORMATTED_VALUE"
        cell_range = f"'{title}'" if cells is None else f"'{title}'!{cells}"
        result = self._execute(
            lambda: (
                self._sheets.values()
                .get(
                    spreadsheetId=self._spreadsheet_id,
                    range=cell_range,
                    valueRenderOption=render,
                )
                .execute()
            )
        )
        return result.get("values", [])

    def read_dicts(
        self, title: str, *, formatted: bool = False, cells: str | None = None
    ) -> list[dict]:
        values = self.read_values(title, cells, formatted=formatted)
        if not values:
            return []
        headers = [str(h) for h in values[0]]
        rows: list[dict] = []
        for offset, row in enumerate(values[1:], start=2):
            padded = list(row) + [""] * (len(headers) - len(row))
            item = {headers[i]: padded[i] for i in range(len(headers))}
            item["_row"] = offset
            rows.append(item)
        return rows

    def append_rows(self, title: str, rows: list[list], columns: int) -> None:
        if not rows:
            return
        last_col = _col_letter(columns - 1)
        self._execute(
            lambda: (
                self._sheets.values()
                .append(
                    spreadsheetId=self._spreadsheet_id,
                    range=f"'{title}'!A:{last_col}",
                    valueInputOption="RAW",
                    insertDataOption="INSERT_ROWS",
                    body={"values": rows},
                )
                .execute()
            )
        )

    def batch_update_cells(self, data: list[dict]) -> None:
        if not data:
            return
        self._execute(
            lambda: (
                self._sheets.values()
                .batchUpdate(
                    spreadsheetId=self._spreadsheet_id,
                    body={"valueInputOption": "RAW", "data": data},
                )
                .execute()
            )
        )

    def replace_all(self, title: str, rows: list[list]) -> None:
        self._execute(
            lambda: (
                self._sheets.values()
                .clear(
                    spreadsheetId=self._spreadsheet_id,
                    range=f"'{title}'",
                )
                .execute()
            )
        )
        if not rows:
            return
        self._execute(
            lambda: (
                self._sheets.values()
                .update(
                    spreadsheetId=self._spreadsheet_id,
                    range=f"'{title}'!A1",
                    valueInputOption="RAW",
                    body={"values": rows},
                )
                .execute()
            )
        )


def cell_range(title: str, column_index: int, row_number: int) -> str:
    return f"'{title}'!{_col_letter(column_index)}{row_number}"

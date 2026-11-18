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


def _col_letter(index: int) -> str:
    result = ""
    while True:
        result = chr(65 + index % 26) + result
        index = index // 26 - 1
        if index < 0:
            return result


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

    def get_sheet_titles(self) -> list[str]:
        meta = self._execute(
            lambda: self._sheets.get(
                spreadsheetId=self._spreadsheet_id,
                fields="sheets.properties.title",
            ).execute()
        )
        return [s["properties"]["title"] for s in meta.get("sheets", [])]

    def ensure_tab(self, title: str, headers: list[str]) -> None:
        if title not in self.get_sheet_titles():
            self._execute(
                lambda: self._sheets.batchUpdate(
                    spreadsheetId=self._spreadsheet_id,
                    body={"requests": [{"addSheet": {"properties": {"title": title}}}]},
                ).execute()
            )
        last_col = _col_letter(len(headers) - 1)
        values = self.read_values(title, f"A1:{last_col}1")
        if values:
            return
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

    def read_values(
        self, title: str, cells: str = "A:ZZ", *, formatted: bool = False
    ) -> list[list]:
        render = "FORMATTED_VALUE" if formatted else "UNFORMATTED_VALUE"
        result = self._execute(
            lambda: (
                self._sheets.values()
                .get(
                    spreadsheetId=self._spreadsheet_id,
                    range=f"'{title}'!{cells}",
                    valueRenderOption=render,
                )
                .execute()
            )
        )
        return result.get("values", [])

    def read_dicts(self, title: str, *, formatted: bool = False) -> list[dict]:
        values = self.read_values(title, formatted=formatted)
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
                    range=f"'{title}'!A:ZZZ",
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

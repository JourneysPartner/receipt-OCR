"""
アプリケーション設定
環境変数から読み込み、デフォルト値を持つ。
"""

import os
from dataclasses import dataclass, field
from typing import Optional


@dataclass(frozen=True)
class DriveConfig:
    source_folder_id: str = ""
    supported_mime_types: tuple[str, ...] = (
        "image/jpeg",
        "image/png",
        "application/pdf",
    )


@dataclass(frozen=True)
class SheetsConfig:
    spreadsheet_id: str = ""
    cashbook_sheet_name: str = "現金出納帳"
    process_log_sheet_name: str = "処理管理"
    ai_log_sheet_name: str = "AI詳細ログ"

    # 現金出納帳の書き込み列マッピング (0-indexed)
    cashbook_column_map: dict[str, int] = field(default_factory=lambda: {
        "ファイルリンク": 0,  # A列
        "日付": 1,            # B列
        "摘要": 2,            # C列
        "取引先": 4,          # E列
        "勘定科目": 5,        # F列
        "税区分": 6,          # G列
        "収入金額": 7,        # H列
        "支出金額": 8,        # I列
    })

    # 使用済み行判定に使う列 (0-indexed)
    # いずれかに値があればその行は使用済み
    occupied_check_columns: tuple[int, ...] = (0, 1, 2)  # A/B/C列

    # データ開始行 (1-indexed)
    cashbook_data_start_row: int = 5

    # 保護列（値を書き込まない列、0-indexed）
    protected_columns: tuple[int, ...] = (3, 13)  # D列, N列

    # 数式コピー対象列（新規行に直前行の数式をコピーする列）
    formula_copy_columns: tuple[int, ...] = (3, 13)  # D列, N列


@dataclass(frozen=True)
class OcrConfig:
    engine: str = "vision"
    max_pdf_pages: int = 5


@dataclass(frozen=True)
class AiConfig:
    engine: str = "gemini"
    model: str = "gemini-2.5-flash"
    max_tokens: int = 2048
    confidence_threshold: float = 0.7


@dataclass(frozen=True)
class AppConfig:
    drive: DriveConfig
    sheets: SheetsConfig
    ocr: OcrConfig
    ai: AiConfig
    google_credentials_path: Optional[str] = None
    gemini_api_key: Optional[str] = None
    dry_run: bool = False
    log_level: str = "INFO"
    reservation_ttl_minutes: int = 30


def _parse_int_tuple(
    env_value: Optional[str], default: tuple[int, ...]
) -> tuple[int, ...]:
    """カンマ区切りの環境変数を int のタプルに変換する"""
    if not env_value:
        return default
    return tuple(int(x.strip()) for x in env_value.split(","))


def load_config() -> AppConfig:
    """環境変数から設定を読み込む"""
    column_map_default = SheetsConfig().cashbook_column_map
    column_map_env = os.environ.get("CASHBOOK_COLUMN_MAP")
    if column_map_env:
        import json
        column_map_default = json.loads(column_map_env)

    return AppConfig(
        drive=DriveConfig(
            source_folder_id=os.environ.get("DRIVE_FOLDER_ID", ""),
        ),
        sheets=SheetsConfig(
            spreadsheet_id=os.environ.get("SPREADSHEET_ID", ""),
            cashbook_sheet_name=os.environ.get("CASHBOOK_SHEET_NAME", "現金出納帳"),
            process_log_sheet_name=os.environ.get("PROCESS_LOG_SHEET_NAME", "処理管理"),
            ai_log_sheet_name=os.environ.get("AI_LOG_SHEET_NAME", "AI詳細ログ"),
            cashbook_column_map=column_map_default,
            occupied_check_columns=_parse_int_tuple(
                os.environ.get("CASHBOOK_OCCUPIED_CHECK_COLUMNS"),
                SheetsConfig().occupied_check_columns,
            ),
            cashbook_data_start_row=int(os.environ.get("CASHBOOK_DATA_START_ROW", "5")),
            protected_columns=_parse_int_tuple(
                os.environ.get("CASHBOOK_PROTECTED_COLUMNS"),
                SheetsConfig().protected_columns,
            ),
            formula_copy_columns=_parse_int_tuple(
                os.environ.get("CASHBOOK_FORMULA_COPY_COLUMNS"),
                SheetsConfig().formula_copy_columns,
            ),
        ),
        ocr=OcrConfig(
            engine=os.environ.get("OCR_ENGINE", "vision"),
            max_pdf_pages=int(os.environ.get("OCR_MAX_PDF_PAGES", "5")),
        ),
        ai=AiConfig(
            engine=os.environ.get("AI_ENGINE", "gemini"),
            model=os.environ.get("AI_MODEL", "gemini-2.5-flash"),
            max_tokens=int(os.environ.get("AI_MAX_TOKENS", "2048")),
            confidence_threshold=float(os.environ.get("AI_CONFIDENCE_THRESHOLD", "0.7")),
        ),
        google_credentials_path=os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"),
        gemini_api_key=os.environ.get("GEMINI_API_KEY"),
        dry_run=os.environ.get("DRY_RUN", "false").lower() == "true",
        log_level=os.environ.get("LOG_LEVEL", "INFO"),
        reservation_ttl_minutes=int(os.environ.get("RESERVATION_TTL_MINUTES", "30")),
    )

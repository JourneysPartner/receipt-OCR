"""
アプリケーション設定
現金自動記帳マスター起点の複数顧客処理に対応。
"""

import os
from dataclasses import dataclass, field
from typing import Optional


# ── マスターシートの列インデックス (0-indexed) ─────────────
@dataclass(frozen=True)
class MasterColumns:
    """現金自動記帳マスターの列定義"""
    customer_name: int = 0   # A列: 顧客名
    staff: int = 1           # B列: 担当者
    entry_type: int = 2      # C列: 記帳区分
    folder_url: int = 3      # D列: フォルダURL
    status: int = 5          # F列: 状態
    sheet_url: int = 6       # G列: シートリンク
    category: int = 7        # H列: 種別（個人/法人）
    last_processed: int = 8  # I列: 最終処理日時


@dataclass(frozen=True)
class MasterConfig:
    """マスターシート関連設定"""
    spreadsheet_id: str = ""
    sheet_name: str = "シート1"
    data_start_row: int = 2          # ヘッダー行の次
    target_entry_type: str = "当方記帳"  # 処理対象の記帳区分
    columns: MasterColumns = field(default_factory=MasterColumns)


@dataclass(frozen=True)
class TemplateConfig:
    """テンプレート・出力先設定"""
    individual_template_id: str = ""   # 個人用テンプレート
    corporate_template_id: str = ""    # 法人用テンプレート
    output_folder_id: str = ""         # 出納帳の保存先フォルダ


@dataclass(frozen=True)
class DriveConfig:
    supported_mime_types: tuple[str, ...] = (
        "image/jpeg",
        "image/png",
        "application/pdf",
    )


@dataclass(frozen=True)
class SheetsConfig:
    """各顧客の現金出納帳への書き込み設定"""
    cashbook_sheet_name: str = "現金出納帳"
    process_log_sheet_name: str = "処理管理"
    ai_log_sheet_name: str = "AI詳細ログ"

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

    occupied_check_columns: tuple[int, ...] = (0, 1, 2)
    cashbook_data_start_row: int = 5
    protected_columns: tuple[int, ...] = (3, 13)
    formula_copy_columns: tuple[int, ...] = (3, 13)


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
    master: MasterConfig
    template: TemplateConfig
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
    if not env_value:
        return default
    return tuple(int(x.strip()) for x in env_value.split(","))


def load_config() -> AppConfig:
    column_map_default = SheetsConfig().cashbook_column_map
    column_map_env = os.environ.get("CASHBOOK_COLUMN_MAP")
    if column_map_env:
        import json
        column_map_default = json.loads(column_map_env)

    return AppConfig(
        master=MasterConfig(
            spreadsheet_id=os.environ.get("MASTER_SPREADSHEET_ID", ""),
            sheet_name=os.environ.get("MASTER_SHEET_NAME", "シート1"),
            data_start_row=int(os.environ.get("MASTER_DATA_START_ROW", "2")),
            target_entry_type=os.environ.get("MASTER_TARGET_ENTRY_TYPE", "当方記帳"),
        ),
        template=TemplateConfig(
            individual_template_id=os.environ.get("INDIVIDUAL_TEMPLATE_SPREADSHEET_ID", ""),
            corporate_template_id=os.environ.get("CORPORATE_TEMPLATE_SPREADSHEET_ID", ""),
            output_folder_id=os.environ.get("CASHBOOK_OUTPUT_FOLDER_ID", ""),
        ),
        drive=DriveConfig(),
        sheets=SheetsConfig(
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

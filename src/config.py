"""
アプリケーション設定
現金自動記帳マスター起点の複数顧客処理に対応。
"""

import os
from dataclasses import dataclass, field


# ── マスターシートの列インデックス (0-indexed) ─────────────
@dataclass(frozen=True)
class MasterColumns:
    """現金自動記帳マスターの列定義"""

    customer_name: int = 0  # A列: 顧客名
    staff: int = 1  # B列: 担当者
    entry_type: int = 2  # C列: 記帳区分
    folder_url: int = 3  # D列: フォルダURL
    status: int = 5  # F列: 状態
    sheet_url: int = 6  # G列: シートリンク
    category: int = 7  # H列: 種別（個人/法人）
    last_processed: int = 8  # I列: 最終処理日時


@dataclass(frozen=True)
class MasterConfig:
    """マスターシート関連設定"""

    spreadsheet_id: str = ""
    sheet_name: str = "シート1"
    data_start_row: int = 2  # ヘッダー行の次
    target_entry_type: str = "当方記帳"  # 処理対象の記帳区分
    columns: MasterColumns = field(default_factory=MasterColumns)


@dataclass(frozen=True)
class TemplateConfig:
    """テンプレート・出力先設定"""

    individual_template_id: str = ""  # 個人用テンプレート
    corporate_template_id: str = ""  # 法人用テンプレート
    output_folder_id: str = ""  # 出納帳の保存先フォルダ


@dataclass(frozen=True)
class DriveConfig:
    supported_mime_types: tuple[str, ...] = (
        "image/jpeg",
        "image/png",
        "application/pdf",
    )
    # このプレフィックスで始まるファイル名は list_files で除外する
    # （既に処理済みで人手で印をつけたファイル等を再処理しない）
    excluded_file_name_prefixes: tuple[str, ...] = ("[済]", "【済】")


@dataclass(frozen=True)
class SheetsConfig:
    """各顧客の出納帳スプレッドシートへの書き込み設定"""

    # 記帳対象タブ名（固定、既定: 入力用）。スプレッドシートのファイル名とは別。
    cashbook_sheet_name: str = "入力用"
    process_log_sheet_name: str = "処理管理"
    ai_log_sheet_name: str = "AI詳細ログ"

    # 実シートの列構成に合わせたマッピング (0-indexed)
    #   A(0) = ファイルリンク
    #   B(1) = 日付
    #   C(2) = 勘定科目コード（account_code_map で変換可能な時だけ書く）
    #   D(3) = 既存数式列 → protected
    #   F(5) = 取引先
    #   G(6) = 税区分
    #   K(10) = 摘要
    #   M(12) = 支出金額（= 支払い）
    #   N(13) = 既存数式列 → protected
    #   O(14) = エラー詳細（manual_entry 時のみ、error_detail_column 参照）
    cashbook_column_map: dict[str, int] = field(
        default_factory=lambda: {
            "ファイルリンク": 0,  # A列
            "日付": 1,  # B列
            "勘定科目コード": 2,  # C列（条件付き書き込み）
            "取引先": 5,  # F列
            "税区分": 6,  # G列
            "摘要": 10,  # K列
            "支出金額": 12,  # M列（= 支払い）
        }
    )

    # 勘定科目コード参照表（記帳対象タブ内、Q:R 列）。
    # AI が抽出した勘定科目名が `account_name_column` (R列) の値に一致した行の
    # `account_code_column` (Q列) の値を C列へ書き込む。
    # 一致する行がなければ C列は書き込まない（既存値/数式を保護）。
    account_code_column: int = 16  # Q列
    account_name_column: int = 17  # R列
    account_table_start_row: int = 1  # 1-indexed

    # 勘定科目名の別名辞書（AI出力→R列の正規名）。
    # Q:R 参照の前に正規化し、表記揺れを吸収する。
    # 例: AI が「接待交際費」を返し、R列は「交際費」しかない → 「交際費」で引ける
    account_alias_map: dict[str, str] = field(
        default_factory=lambda: {
            "接待交際費": "交際費",
        }
    )

    occupied_check_columns: tuple[int, ...] = (0, 1, 2)
    cashbook_data_start_row: int = 5
    protected_columns: tuple[int, ...] = (3, 13)
    formula_copy_columns: tuple[int, ...] = (3, 13)

    # 要手入力行のエラー詳細を書き込む列 (0-indexed、既定: O列=14)
    # 短文ラベル「※要手入力」は K列（摘要）に入れ、長文エラーはこの列に入れる
    error_detail_column: int = 14


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
    google_credentials_path: str | None = None
    gemini_api_key: str | None = None
    dry_run: bool = False
    log_level: str = "INFO"
    reservation_ttl_minutes: int = 30


def _parse_int_tuple(env_value: str | None, default: tuple[int, ...]) -> tuple[int, ...]:
    if not env_value:
        return default
    return tuple(int(x.strip()) for x in env_value.split(","))


def _parse_str_tuple(env_value: str | None, default: tuple[str, ...]) -> tuple[str, ...]:
    if not env_value:
        return default
    return tuple(s.strip() for s in env_value.split(",") if s.strip())


def load_config() -> AppConfig:
    import json

    column_map_default = SheetsConfig().cashbook_column_map
    column_map_env = os.environ.get("CASHBOOK_COLUMN_MAP")
    if column_map_env:
        column_map_default = json.loads(column_map_env)

    alias_map_default = SheetsConfig().account_alias_map
    alias_map_env = os.environ.get("CASHBOOK_ACCOUNT_ALIAS_MAP")
    if alias_map_env:
        alias_map_default = json.loads(alias_map_env)

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
        drive=DriveConfig(
            excluded_file_name_prefixes=_parse_str_tuple(
                os.environ.get("EXCLUDED_FILE_NAME_PREFIXES"),
                DriveConfig().excluded_file_name_prefixes,
            ),
        ),
        sheets=SheetsConfig(
            cashbook_sheet_name=os.environ.get("CASHBOOK_SHEET_NAME", "入力用"),
            process_log_sheet_name=os.environ.get("PROCESS_LOG_SHEET_NAME", "処理管理"),
            ai_log_sheet_name=os.environ.get("AI_LOG_SHEET_NAME", "AI詳細ログ"),
            cashbook_column_map=column_map_default,
            account_code_column=int(
                os.environ.get(
                    "CASHBOOK_ACCOUNT_CODE_COLUMN",
                    str(SheetsConfig().account_code_column),
                )
            ),
            account_name_column=int(
                os.environ.get(
                    "CASHBOOK_ACCOUNT_NAME_COLUMN",
                    str(SheetsConfig().account_name_column),
                )
            ),
            account_table_start_row=int(
                os.environ.get(
                    "CASHBOOK_ACCOUNT_TABLE_START_ROW",
                    str(SheetsConfig().account_table_start_row),
                )
            ),
            account_alias_map=alias_map_default,
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
            error_detail_column=int(
                os.environ.get(
                    "CASHBOOK_ERROR_DETAIL_COLUMN",
                    str(SheetsConfig().error_detail_column),
                )
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

"""データモデル定義"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class ProcessStatus(str, Enum):
    SUCCESS = "success"
    ERROR = "error"
    SKIPPED = "skipped"
    LOW_CONFIDENCE = "low_confidence"
    MANUAL_ENTRY = "manual_entry"
    RESERVED = "reserved"
    WRITTEN = "written"
    EXPIRED = "expired"


@dataclass
class CustomerRow:
    """マスターシートの1顧客行"""
    row_number: int          # マスターシート上の行番号 (1-indexed)
    customer_name: str
    staff: str = ""
    entry_type: str = ""     # 記帳区分
    folder_url: str = ""     # D列: Drive フォルダURL
    status: str = ""         # F列: 状態
    sheet_url: str = ""      # G列: 出納帳URL
    category: str = ""       # H列: 種別（個人/法人）
    last_processed: str = "" # I列: 最終処理日時

    @property
    def folder_id(self) -> str:
        """フォルダURLからフォルダIDを抽出"""
        return extract_id_from_url(self.folder_url)

    @property
    def spreadsheet_id(self) -> str:
        """シートURLからスプレッドシートIDを抽出"""
        return extract_id_from_url(self.sheet_url)

    @property
    def has_cashbook(self) -> bool:
        return bool(self.sheet_url.strip())

    @property
    def is_individual(self) -> bool:
        return self.category.strip() != "法人"


def extract_id_from_url(url: str) -> str:
    """Google Drive/Sheets の URL から ID を抽出する。
    対応形式:
      https://drive.google.com/drive/folders/FOLDER_ID
      https://drive.google.com/drive/folders/FOLDER_ID?...
      https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
      https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit#gid=0
      FOLDER_ID (URLでなく生IDも許容)
    """
    url = url.strip()
    if not url:
        return ""
    # /folders/ID パターン
    if "/folders/" in url:
        part = url.split("/folders/")[1]
        return part.split("?")[0].split("#")[0].split("/")[0]
    # /d/ID/ パターン
    if "/d/" in url:
        part = url.split("/d/")[1]
        return part.split("/")[0].split("?")[0].split("#")[0]
    # URL でなければ生 ID として扱う
    if "/" not in url and len(url) > 10:
        return url
    return url


@dataclass
class DriveFile:
    file_id: str
    file_name: str
    mime_type: str
    folder_id: str
    content: bytes = field(default=b"", repr=False)

    @property
    def drive_link(self) -> str:
        return f"https://drive.google.com/file/d/{self.file_id}/view"


@dataclass
class OcrResult:
    raw_text: str
    engine: str
    confidence: float
    page_count: int = 1
    error: Optional[str] = None


@dataclass
class ReceiptItem:
    date: Optional[str] = None
    amount: Optional[int] = None
    vendor: Optional[str] = None
    description: Optional[str] = None
    account: Optional[str] = None
    tax_category: Optional[str] = None
    confidence: float = 0.0
    is_expense: bool = True
    memo: Optional[str] = None


@dataclass
class CorrectedItem:
    original: ReceiptItem
    date: Optional[str] = None
    amount: Optional[int] = None
    vendor: Optional[str] = None
    description: Optional[str] = None
    account: Optional[str] = None
    tax_category: Optional[str] = None
    confidence: float = 0.0
    is_expense: bool = True
    corrections_applied: list[str] = field(default_factory=list)
    needs_review: bool = False
    memo: Optional[str] = None


@dataclass
class ProcessRecord:
    file_id: str
    file_name: str
    receipt_index: int
    mime_type: str = ""
    processed_at: str = ""
    status: str = ""
    cashbook_row: int = 0
    error_message: str = ""
    retryable: bool = False
    source_folder_id: str = ""
    reservation_id: str = ""


@dataclass
class CustomerResult:
    """1顧客の処理結果集計"""
    success: int = 0
    low_confidence: int = 0
    manual_entry: int = 0
    skipped: int = 0
    errors: int = 0

    @property
    def total_processed(self) -> int:
        return self.success + self.low_confidence + self.manual_entry

    @property
    def has_issues(self) -> bool:
        return self.manual_entry > 0 or self.low_confidence > 0 or self.errors > 0

    def to_status_string(self) -> str:
        """マスターシート F列に書く状態文字列を生成する"""
        total = self.success + self.low_confidence + self.manual_entry + self.errors
        if total == 0 and self.skipped == 0:
            return "完了（対象なし）"
        if total == 0 and self.skipped > 0:
            return "完了（対象なし）"
        if self.errors > 0 and self.success == 0 and self.manual_entry == 0:
            return "エラー / 詳細はログ参照"

        parts: list[str] = []
        if self.success > 0:
            parts.append(f"成功{self.success}")
        if self.low_confidence > 0:
            parts.append(f"低信頼{self.low_confidence}")
        if self.manual_entry > 0:
            parts.append(f"手入力{self.manual_entry}")
        if self.errors > 0:
            parts.append(f"エラー{self.errors}")

        detail = " / ".join(parts)
        label = "要確認" if self.has_issues else "完了"
        return f"{label} / {detail}"


@dataclass
class AiLogRecord:
    timestamp: str = ""
    file_id: str = ""
    file_name: str = ""
    receipt_index: int = 0
    ocr_engine: str = ""
    ocr_confidence: float = 0.0
    date: str = ""
    amount: str = ""
    vendor: str = ""
    description: str = ""
    account: str = ""
    tax_category: str = ""
    corrected_account: str = ""
    corrected_tax_category: str = ""
    corrections_applied: str = ""
    needs_review: bool = False
    memo: str = ""

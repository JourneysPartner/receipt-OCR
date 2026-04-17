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
    """処理管理レコード。主キー: file_id + receipt_index。"""
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

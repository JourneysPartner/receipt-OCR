"""AI 解析エンジンの抽象基底クラス"""

from abc import ABC, abstractmethod
from src.models import OcrResult, ReceiptItem


class AiExtractor(ABC):
    @abstractmethod
    def extract_receipt_data(
        self, ocr_result: OcrResult, file_name: str
    ) -> list[ReceiptItem]: ...

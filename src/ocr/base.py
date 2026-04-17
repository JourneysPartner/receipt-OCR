"""OCR エンジンの抽象基底クラス"""

from abc import ABC, abstractmethod

from src.models import DriveFile, OcrResult


class OcrEngine(ABC):
    @abstractmethod
    def extract_text(self, file: DriveFile) -> OcrResult: ...

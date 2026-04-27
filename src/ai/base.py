"""AI 解析エンジンの抽象基底クラス"""

from abc import ABC, abstractmethod

from src.models import DriveFile, OcrResult, ReceiptItem


class AiExtractor(ABC):
    @abstractmethod
    def extract_receipt_data(self, ocr_result: OcrResult, file_name: str) -> list[ReceiptItem]: ...

    def extract_from_file(self, file: DriveFile) -> list[ReceiptItem]:
        """画像/PDF を直接渡して再抽出する（マルチモーダル対応エンジン用）。
        既定は未対応で空リスト。amount_validation NG 時の再読取に使う。
        """
        return []

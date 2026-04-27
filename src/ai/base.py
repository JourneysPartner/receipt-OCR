"""AI 解析エンジンの抽象基底クラス"""

from abc import ABC, abstractmethod

from src.models import DriveFile, OcrResult, ReceiptItem

# extract 系メソッド呼び出し後、抽出が空 / 失敗だった場合の理由種別。
# - "parse_error": レスポンスを JSON にパースできなかった
# - "zero_items":  パースは成功したが配列が空だった
# - "api_error":   API 呼び出し自体が例外を投げた
# - None:          成功（items が1件以上取れた）
ExtractionErrorType = str  # 上記のいずれか


class AiExtractor(ABC):
    """AI 抽出エンジンの抽象基底。

    抽出失敗の理由を `last_extraction_error` に記録する（parse_error / zero_items / api_error）。
    呼び出し側はこの値を見て「抽出 retry」を発火させるかを判断する。
    """

    def __init__(self) -> None:
        self.last_extraction_error: ExtractionErrorType | None = None

    @abstractmethod
    def extract_receipt_data(self, ocr_result: OcrResult, file_name: str) -> list[ReceiptItem]: ...

    def extract_from_file(self, file: DriveFile) -> list[ReceiptItem]:
        """画像/PDF を直接渡して再抽出する（マルチモーダル対応エンジン用）。
        既定は未対応で空リスト。amount_validation NG 時の再読取に使う。
        """
        return []

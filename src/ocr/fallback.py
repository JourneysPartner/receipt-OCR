"""フォールバック OCR エンジン

primary OCR が低 confidence または失敗した場合に、
secondary OCR を試して**より良い結果を選ぶ**ラッパー。

「より良い」の判定:
- primary がエラー / テキスト空 → fallback を試す
- primary の confidence が threshold 未満 → fallback を試し、conf が高い方を返す
- primary が十分高 confidence → fallback を呼ばない（API コスト削減）

注意: 本層では amount_validation の結果は見ない。
amount_validation NG 時の再 OCR を行いたい場合は manager 側の追加実装が必要。
"""

from src.logging.logger import setup_logger
from src.models import DriveFile, OcrResult
from src.ocr.base import OcrEngine

logger = setup_logger()


class FallbackOcrEngine(OcrEngine):
    def __init__(
        self,
        primary: OcrEngine,
        fallback: OcrEngine,
        confidence_threshold: float = 0.6,
    ):
        self._primary = primary
        self._fallback = fallback
        self._threshold = confidence_threshold

    def extract_text(self, file: DriveFile) -> OcrResult:
        primary_result = self._primary.extract_text(file)

        if not self._needs_fallback(primary_result):
            return primary_result

        logger.info(
            f"OCR fallback 試行: {file.file_name} "
            f"(primary conf={primary_result.confidence:.2f}, error={primary_result.error})",
            extra={"step": "ocr_fallback_try", "file_id": file.file_id},
        )

        try:
            fb_result = self._fallback.extract_text(file)
        except Exception as e:
            logger.error(
                f"fallback OCR 例外: {e}",
                extra={"step": "ocr_fallback_error", "file_id": file.file_id},
            )
            return primary_result

        chosen = self._choose_better(primary_result, fb_result)
        if chosen is fb_result:
            logger.info(
                f"OCR fallback 採用: {file.file_name} "
                f"({primary_result.engine} conf={primary_result.confidence:.2f} → "
                f"{fb_result.engine} conf={fb_result.confidence:.2f})",
                extra={"step": "ocr_fallback_used", "file_id": file.file_id},
            )
        else:
            logger.info(
                f"OCR fallback 却下: {file.file_name} (primary 維持)",
                extra={"step": "ocr_fallback_rejected", "file_id": file.file_id},
            )
        return chosen

    def _needs_fallback(self, r: OcrResult) -> bool:
        if r.error:
            return True
        if not r.raw_text or not r.raw_text.strip():
            return True
        if r.confidence < self._threshold:
            return True
        return False

    @staticmethod
    def _choose_better(primary: OcrResult, fb: OcrResult) -> OcrResult:
        """primary と fallback の結果から「より良い」方を選ぶ。
        判定基準:
          1. fb がエラー → primary
          2. fb が空 → primary
          3. primary が空 / エラー → fb
          4. fb の confidence が primary より高い → fb
          5. それ以外 → primary
        """
        if fb.error or not (fb.raw_text and fb.raw_text.strip()):
            return primary
        if primary.error or not (primary.raw_text and primary.raw_text.strip()):
            return fb
        if fb.confidence > primary.confidence:
            return fb
        return primary

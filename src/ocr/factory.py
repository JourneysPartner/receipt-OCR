"""OCR エンジンのファクトリ"""

from src.config import OcrConfig
from src.ocr.base import OcrEngine
from src.ocr.vision import VisionOcrEngine


def create_ocr_engine(config: OcrConfig) -> OcrEngine:
    engines = {"vision": VisionOcrEngine}
    cls = engines.get(config.engine)
    if not cls:
        raise ValueError(f"未対応OCRエンジン: {config.engine}")
    return cls(config)

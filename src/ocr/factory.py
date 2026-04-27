"""OCR エンジンのファクトリ

primary エンジンを必ず生成し、fallback_engine が指定されていれば
FallbackOcrEngine でラップして返す。
"""

from src.config import OcrConfig
from src.ocr.base import OcrEngine
from src.ocr.fallback import FallbackOcrEngine
from src.ocr.vision import VisionDocumentOcrEngine, VisionOcrEngine

_REGISTRY: dict[str, type[OcrEngine]] = {
    "vision": VisionOcrEngine,
    "vision_document": VisionDocumentOcrEngine,
}


def _create_single(name: str, config: OcrConfig) -> OcrEngine:
    cls = _REGISTRY.get(name)
    if not cls:
        raise ValueError(f"未対応OCRエンジン: {name} (使える名前: {list(_REGISTRY)})")
    return cls(config)


def create_ocr_engine(config: OcrConfig) -> OcrEngine:
    primary = _create_single(config.engine, config)
    if not config.fallback_engine:
        return primary
    if config.fallback_engine == config.engine:
        # 同一エンジンを fallback に指定しても意味が無い
        return primary
    fallback = _create_single(config.fallback_engine, config)
    return FallbackOcrEngine(
        primary=primary,
        fallback=fallback,
        confidence_threshold=config.fallback_confidence_threshold,
    )

"""FallbackOcrEngine と factory のテスト（API モック）"""

from unittest.mock import MagicMock

from src.config import OcrConfig
from src.models import DriveFile, OcrResult
from src.ocr.factory import create_ocr_engine
from src.ocr.fallback import FallbackOcrEngine


def _file() -> DriveFile:
    return DriveFile(file_id="f1", file_name="r.jpg", mime_type="image/jpeg", folder_id="x")


def _eng(result: OcrResult) -> MagicMock:
    e = MagicMock()
    e.extract_text.return_value = result
    return e


class TestFallbackOcrEngine:
    def test_high_confidence_no_fallback(self):
        primary = _eng(OcrResult(raw_text="ok", engine="vision", confidence=0.95))
        fallback = _eng(OcrResult(raw_text="alt", engine="vision_document", confidence=0.99))
        eng = FallbackOcrEngine(primary, fallback, confidence_threshold=0.6)
        r = eng.extract_text(_file())
        assert r.raw_text == "ok"
        fallback.extract_text.assert_not_called()

    def test_low_confidence_fallback_better(self):
        """primary 低 conf → fallback の方が高ければ採用"""
        primary = _eng(OcrResult(raw_text="weak", engine="vision", confidence=0.4))
        fallback = _eng(OcrResult(raw_text="strong", engine="vision_document", confidence=0.85))
        eng = FallbackOcrEngine(primary, fallback, confidence_threshold=0.6)
        r = eng.extract_text(_file())
        assert r.raw_text == "strong"
        assert r.engine == "vision_document"
        fallback.extract_text.assert_called_once()

    def test_low_confidence_fallback_worse(self):
        """primary 低 conf でも fallback がさらに低ければ primary 維持"""
        primary = _eng(OcrResult(raw_text="weak", engine="vision", confidence=0.5))
        fallback = _eng(OcrResult(raw_text="zzz", engine="vision_document", confidence=0.2))
        eng = FallbackOcrEngine(primary, fallback, confidence_threshold=0.6)
        r = eng.extract_text(_file())
        assert r.raw_text == "weak"

    def test_primary_error_fallback_used(self):
        """primary がエラーなら fallback を試す"""
        primary = _eng(
            OcrResult(raw_text="", engine="vision", confidence=0.0, error="API disabled")
        )
        fallback = _eng(OcrResult(raw_text="recovered", engine="vision_document", confidence=0.7))
        eng = FallbackOcrEngine(primary, fallback, confidence_threshold=0.6)
        r = eng.extract_text(_file())
        assert r.raw_text == "recovered"

    def test_primary_empty_fallback_used(self):
        """primary が空テキストでも fallback を試す"""
        primary = _eng(OcrResult(raw_text="", engine="vision", confidence=0.0))
        fallback = _eng(OcrResult(raw_text="something", engine="vision_document", confidence=0.5))
        eng = FallbackOcrEngine(primary, fallback, confidence_threshold=0.6)
        r = eng.extract_text(_file())
        assert r.raw_text == "something"

    def test_fallback_exception_returns_primary(self):
        """fallback が例外を投げても primary を返す"""
        primary = _eng(OcrResult(raw_text="weak", engine="vision", confidence=0.3))
        fallback = MagicMock()
        fallback.extract_text.side_effect = RuntimeError("boom")
        eng = FallbackOcrEngine(primary, fallback, confidence_threshold=0.6)
        r = eng.extract_text(_file())
        assert r.raw_text == "weak"

    def test_fallback_error_returns_primary(self):
        """fallback がエラー結果を返しても primary を返す"""
        primary = _eng(OcrResult(raw_text="weak", engine="vision", confidence=0.3))
        fallback = _eng(OcrResult(raw_text="", engine="vision_document", confidence=0.0, error="x"))
        eng = FallbackOcrEngine(primary, fallback, confidence_threshold=0.6)
        r = eng.extract_text(_file())
        assert r.raw_text == "weak"


class TestCreateOcrEngineWithFallback:
    def test_no_fallback_returns_single_engine(self, monkeypatch):
        """fallback 未設定 → 単一エンジン"""
        # Vision クライアント生成を回避
        from src.ocr import vision as vmod

        monkeypatch.setattr(vmod.vision, "ImageAnnotatorClient", MagicMock())
        eng = create_ocr_engine(OcrConfig(engine="vision", fallback_engine=None))
        from src.ocr.vision import VisionOcrEngine

        assert isinstance(eng, VisionOcrEngine)
        assert not isinstance(eng, FallbackOcrEngine)

    def test_with_fallback_wraps(self, monkeypatch):
        """fallback 設定で FallbackOcrEngine ラッパーが返る"""
        from src.ocr import vision as vmod

        monkeypatch.setattr(vmod.vision, "ImageAnnotatorClient", MagicMock())
        eng = create_ocr_engine(OcrConfig(engine="vision", fallback_engine="vision_document"))
        assert isinstance(eng, FallbackOcrEngine)

    def test_same_engine_as_fallback_is_skipped(self, monkeypatch):
        """同じエンジンを fallback に指定しても意味がないので primary のみ返す"""
        from src.ocr import vision as vmod

        monkeypatch.setattr(vmod.vision, "ImageAnnotatorClient", MagicMock())
        eng = create_ocr_engine(OcrConfig(engine="vision", fallback_engine="vision"))
        assert not isinstance(eng, FallbackOcrEngine)

    def test_unknown_engine_raises(self, monkeypatch):
        from src.ocr import vision as vmod

        monkeypatch.setattr(vmod.vision, "ImageAnnotatorClient", MagicMock())
        import pytest

        with pytest.raises(ValueError):
            create_ocr_engine(OcrConfig(engine="unknown_engine"))

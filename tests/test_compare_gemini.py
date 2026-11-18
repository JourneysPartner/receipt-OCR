"""GeminiExtractor の設定（S7）と last_call_info のテスト"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from src.ai.gemini import GeminiExtractor
from src.config import AiConfig
from src.models import DriveFile, OcrResult


def _response(text='[{"amount": 100, "confidence": 0.9}]'):
    response = MagicMock()
    response.text = text
    response.candidates = [
        SimpleNamespace(finish_reason=SimpleNamespace(name="STOP")),
    ]
    response.usage_metadata = SimpleNamespace(
        prompt_token_count=11,
        candidates_token_count=5,
        thoughts_token_count=3,
    )
    return response


def _ocr():
    return OcrResult(raw_text="テスト商店 合計 100円", engine="fake", confidence=0.9)


class TestDefaults:
    def test_default_config_sends_temperature_0_1_without_thinking_or_http_options(self):
        client = MagicMock()
        client.models.generate_content.return_value = _response()
        with patch("src.ai.gemini.genai.Client", return_value=client) as ctor:
            extractor = GeminiExtractor(AiConfig(), api_key="fake")
        ctor.assert_called_once_with(api_key="fake")
        extractor.extract_receipt_data(_ocr(), "a.jpg")
        call = client.models.generate_content.call_args.kwargs
        config = call["config"]
        assert config.temperature == 0.1
        assert config.thinking_config is None
        assert config.max_output_tokens == 2048

    def test_thinking_and_timeout_are_passed(self):
        client = MagicMock()
        client.models.generate_content.return_value = _response()
        with patch("src.ai.gemini.genai.Client", return_value=client) as ctor:
            extractor = GeminiExtractor(
                AiConfig(thinking_level="low", request_timeout_seconds=30, temperature=None),
                api_key="fake",
            )
        kwargs = ctor.call_args.kwargs
        assert kwargs["http_options"].timeout == 30_000
        extractor.extract_from_file(
            DriveFile(
                file_id="x",
                file_name="a.jpg",
                mime_type="image/jpeg",
                folder_id="f",
                content=b"data",
            )
        )
        config = client.models.generate_content.call_args.kwargs["config"]
        assert config.temperature is None
        assert config.thinking_config is not None
        assert str(config.thinking_config.thinking_level).lower().endswith("low")


class TestLastCallInfo:
    def _extractor(self, response):
        client = MagicMock()
        client.models.generate_content.return_value = response
        with patch("src.ai.gemini.genai.Client", return_value=client):
            return GeminiExtractor(AiConfig(), api_key="fake")

    def test_usage_finish_reason_and_latency(self):
        extractor = self._extractor(_response())
        items = extractor.extract_receipt_data(_ocr(), "a.jpg")
        assert items
        info = extractor.last_call_info
        assert info["model"] == "gemini-2.5-flash"
        assert info["finish_reason"] == "STOP"
        assert info["prompt_tokens"] == 11
        assert info["output_tokens"] == 5
        assert info["thinking_tokens"] == 3
        assert isinstance(info["latency_ms"], int)
        assert info["error"] is None
        assert info["raw_text"].startswith("[")

    def test_none_text_keeps_finish_reason(self):
        response = _response()
        response.text = None
        extractor = self._extractor(response)
        assert extractor.extract_receipt_data(_ocr(), "a.jpg") == []
        assert extractor.last_extraction_error == "api_error"
        assert extractor.last_call_info["finish_reason"] == "STOP"

    def test_exception_records_error(self):
        client = MagicMock()
        client.models.generate_content.side_effect = RuntimeError("429 quota")
        with patch("src.ai.gemini.genai.Client", return_value=client):
            extractor = GeminiExtractor(AiConfig(), api_key="fake")
        assert extractor.extract_receipt_data(_ocr(), "a.jpg") == []
        assert extractor.last_extraction_error == "api_error"
        assert "429 quota" in extractor.last_call_info["error"]
        assert isinstance(extractor.last_call_info["latency_ms"], int)

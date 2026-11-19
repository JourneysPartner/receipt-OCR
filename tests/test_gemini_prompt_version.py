"""GeminiExtractor が指示文の版を切り替えることのテスト（API は偽物）"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from src.ai import prompts
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


def _file():
    return DriveFile(
        file_id="x",
        file_name="テスト領収書.jpg",
        mime_type="image/jpeg",
        folder_id="f",
        content=b"data",
    )


def _extractor(config, client):
    with patch("src.ai.gemini.genai.Client", return_value=client):
        return GeminiExtractor(config, api_key="fake")


class TestSystemInstruction:
    def test_v1(self):
        client = MagicMock()
        client.models.generate_content.return_value = _response()
        extractor = _extractor(AiConfig(), client)
        extractor.extract_receipt_data(_ocr(), "テスト領収書.jpg")
        config = client.models.generate_content.call_args.kwargs["config"]
        assert config.system_instruction == prompts.SYSTEM_INSTRUCTION_V1

    def test_v2(self):
        client = MagicMock()
        client.models.generate_content.return_value = _response()
        extractor = _extractor(AiConfig(prompt_version="v2"), client)
        extractor.extract_receipt_data(_ocr(), "テスト領収書.jpg")
        config = client.models.generate_content.call_args.kwargs["config"]
        assert config.system_instruction == prompts.SYSTEM_INSTRUCTION_V2
        assert config.system_instruction != prompts.SYSTEM_INSTRUCTION_V1


class TestUserMessages:
    def test_text_v1(self):
        client = MagicMock()
        client.models.generate_content.return_value = _response()
        extractor = _extractor(AiConfig(), client)
        extractor.extract_receipt_data(_ocr(), "テスト領収書.jpg")
        kwargs = client.models.generate_content.call_args.kwargs
        assert kwargs["contents"] == prompts.text_user_message(
            "v1", "テスト領収書.jpg", "テスト商店 合計 100円"
        )

    def test_text_v2(self):
        client = MagicMock()
        client.models.generate_content.return_value = _response()
        extractor = _extractor(AiConfig(prompt_version="v2"), client)
        extractor.extract_receipt_data(_ocr(), "テスト領収書.jpg")
        kwargs = client.models.generate_content.call_args.kwargs
        assert kwargs["contents"] == prompts.text_user_message(
            "v2", "テスト領収書.jpg", "テスト商店 合計 100円"
        )

    def test_image_v1(self):
        client = MagicMock()
        client.models.generate_content.return_value = _response()
        extractor = _extractor(AiConfig(), client)
        extractor.extract_from_file(_file())
        kwargs = client.models.generate_content.call_args.kwargs
        assert kwargs["contents"][1] == prompts.image_user_message("v1", "テスト領収書.jpg")

    def test_image_v2(self):
        client = MagicMock()
        client.models.generate_content.return_value = _response()
        extractor = _extractor(AiConfig(prompt_version="v2"), client)
        extractor.extract_from_file(_file())
        kwargs = client.models.generate_content.call_args.kwargs
        assert kwargs["contents"][1] == prompts.image_user_message("v2", "テスト領収書.jpg")


class TestConfigWithoutPromptVersion:
    def test_falls_back_to_v1(self):
        """prompt_version を持たない偽の設定でも v1 で動く"""
        config = SimpleNamespace(
            model="gemini-2.5-flash",
            max_tokens=2048,
            temperature=0.1,
            thinking_level=None,
            request_timeout_seconds=None,
        )
        client = MagicMock()
        client.models.generate_content.return_value = _response()
        extractor = _extractor(config, client)
        extractor.extract_receipt_data(_ocr(), "テスト領収書.jpg")
        call = client.models.generate_content.call_args.kwargs
        assert call["config"].system_instruction == prompts.SYSTEM_INSTRUCTION_V1
        assert call["contents"] == prompts.text_user_message(
            "v1", "テスト領収書.jpg", "テスト商店 合計 100円"
        )

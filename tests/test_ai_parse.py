"""AI レスポンスパースのテスト"""

from src.ai.gemini import GeminiExtractor, _safe_int
from src.config import AiConfig


class TestSafeInt:
    def test_int(self):
        assert _safe_int(1234) == 1234

    def test_comma(self):
        assert _safe_int("1,234") == 1234

    def test_yen(self):
        assert _safe_int("1234円") == 1234

    def test_yen_sign(self):
        assert _safe_int("¥1,234") == 1234

    def test_none(self):
        assert _safe_int(None) is None

    def test_invalid(self):
        assert _safe_int("abc") is None

    def test_float(self):
        assert _safe_int("1234.0") == 1234


def _ext() -> GeminiExtractor:
    e = GeminiExtractor.__new__(GeminiExtractor)
    e._config = AiConfig()
    return e


class TestParseResponse:
    def test_json_array(self):
        r = _ext()._parse_response(
            '[{"date":"2026-01-15","amount":1080,"vendor":"店","description":"品",'
            '"account":"消耗品費","tax_category":"課税仕入10%","confidence":0.9}]',
            "t.jpg",
        )
        assert len(r) == 1 and r[0].amount == 1080

    def test_code_block(self):
        r = _ext()._parse_response(
            '```json\n[{"date":"2026-01-15","amount":500,"vendor":"X",'
            '"description":"Y","account":"雑費","confidence":0.8}]\n```',
            "t.jpg",
        )
        assert len(r) == 1

    def test_single_object(self):
        r = _ext()._parse_response(
            '{"date":"2026-01-15","amount":300,"vendor":"X",'
            '"description":"Y","account":"雑費","confidence":0.5}',
            "t.jpg",
        )
        assert len(r) == 1

    def test_multiple(self):
        r = _ext()._parse_response(
            '[{"amount":1000,"confidence":0.9},{"amount":2000,"confidence":0.8}]',
            "t.jpg",
        )
        assert len(r) == 2

    def test_invalid(self):
        assert _ext()._parse_response("not json", "t.jpg") == []


class TestExtractFromFile:
    """画像/PDFを直接渡す再抽出ルート"""

    def _make(self):
        from unittest.mock import MagicMock

        from src.ai.gemini import GeminiExtractor
        from src.config import AiConfig

        ext = GeminiExtractor.__new__(GeminiExtractor)
        ext._config = AiConfig()
        ext._client = MagicMock()
        return ext

    def test_unsupported_mime_returns_empty(self):
        from src.models import DriveFile

        ext = self._make()
        f = DriveFile(
            file_id="x",
            file_name="a.txt",
            mime_type="text/plain",
            folder_id="f",
            content=b"hello",
        )
        assert ext.extract_from_file(f) == []

    def test_empty_content_returns_empty(self):
        from src.models import DriveFile

        ext = self._make()
        f = DriveFile(
            file_id="x",
            file_name="a.jpg",
            mime_type="image/jpeg",
            folder_id="f",
            content=b"",
        )
        assert ext.extract_from_file(f) == []

    def test_supported_mime_calls_api(self):
        """JPEG が渡されれば API が呼ばれて parse される"""
        from unittest.mock import MagicMock

        from src.models import DriveFile

        ext = self._make()
        mock_resp = MagicMock()
        mock_resp.text = '[{"date":"2026-04-27","amount":1600,"confidence":0.9}]'
        ext._client.models.generate_content.return_value = mock_resp

        f = DriveFile(
            file_id="x",
            file_name="a.jpg",
            mime_type="image/jpeg",
            folder_id="f",
            content=b"\x89PNG fake",
        )
        items = ext.extract_from_file(f)
        assert len(items) == 1
        assert items[0].amount == 1600
        ext._client.models.generate_content.assert_called_once()

    def test_pdf_supported(self):
        from unittest.mock import MagicMock

        from src.models import DriveFile

        ext = self._make()
        mock_resp = MagicMock()
        mock_resp.text = '[{"amount":100,"confidence":0.5}]'
        ext._client.models.generate_content.return_value = mock_resp

        f = DriveFile(
            file_id="x",
            file_name="a.pdf",
            mime_type="application/pdf",
            folder_id="f",
            content=b"%PDF-1.4 fake",
        )
        items = ext.extract_from_file(f)
        assert len(items) == 1

    def test_api_exception_returns_empty(self):
        from src.models import DriveFile

        ext = self._make()
        ext._client.models.generate_content.side_effect = RuntimeError("rate limit")
        f = DriveFile(
            file_id="x",
            file_name="a.jpg",
            mime_type="image/jpeg",
            folder_id="f",
            content=b"data",
        )
        assert ext.extract_from_file(f) == []

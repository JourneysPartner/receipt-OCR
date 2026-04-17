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

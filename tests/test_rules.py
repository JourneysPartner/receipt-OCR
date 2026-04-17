"""業務ルール補正のテスト"""

from src.models import ReceiptItem
from src.rules.corrections import RuleCorrector


def _item(**kw) -> ReceiptItem:
    d = {"date": "2026-01-15", "amount": 1000, "vendor": "テスト",
         "description": "テスト", "account": "雑費",
         "tax_category": "課税仕入10%", "confidence": 0.9}
    d.update(kw)
    return ReceiptItem(**d)


class TestRuleCorrector:
    def setup_method(self):
        self.c = RuleCorrector(confidence_threshold=0.7)

    def test_gasoline(self):
        r = self.c.apply(_item(description="レギュラーガソリン", vendor="ENEOS"))
        assert r.account == "車両費"

    def test_parking(self):
        r = self.c.apply(_item(description="駐車場料金"))
        assert r.account == "旅費交通費"

    def test_postal(self):
        r = self.c.apply(_item(description="レターパック"))
        assert r.account == "通信費"

    def test_stamp(self):
        r = self.c.apply(_item(description="収入印紙"))
        assert r.account == "租税公課"
        assert r.tax_category == "対象外"

    def test_no_match(self):
        r = self.c.apply(_item(description="弁当", vendor="ほっともっと"))
        assert r.account == "雑費"
        assert len(r.corrections_applied) == 0

    def test_low_confidence(self):
        assert self.c.apply(_item(confidence=0.3)).needs_review is True

    def test_high_confidence(self):
        assert self.c.apply(_item(confidence=0.9)).needs_review is False

    def test_original_preserved(self):
        r = self.c.apply(_item(description="ガソリン", account="消耗品費"))
        assert r.original.account == "消耗品費"
        assert r.account == "車両費"

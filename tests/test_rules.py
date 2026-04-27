"""業務ルール補正のテスト"""

from src.models import ReceiptItem
from src.rules.corrections import RuleCorrector


def _item(**kw) -> ReceiptItem:
    d = {
        "date": "2026-01-15",
        "amount": 1000,
        "vendor": "テスト",
        "description": "テスト",
        "account": "雑費",
        "tax_category": "課税仕入10%",
        "confidence": 0.9,
    }
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
        """どのルールにもマッチしなければ AI の account（雑費）のまま"""
        r = self.c.apply(_item(description="汎用品購入", vendor="テスト社"))
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

    # ── 弁当→会議費 ─────────────────────────────────
    def test_bento_to_meeting_expense(self):
        """description に「弁当」→ 会議費"""
        r = self.c.apply(_item(description="弁当 10個"))
        assert r.account == "会議費"

    def test_obento_to_meeting_expense(self):
        """description に「お弁当」→ 会議費"""
        r = self.c.apply(_item(description="お弁当"))
        assert r.account == "会議費"

    def test_bento_dai_to_meeting_expense(self):
        """description に「弁当代」→ 会議費"""
        r = self.c.apply(_item(description="弁当代 3,500円"))
        assert r.account == "会議費"

    def test_obento_dai_to_meeting_expense(self):
        """description に「お弁当代」→ 会議費"""
        r = self.c.apply(_item(description="お弁当代"))
        assert r.account == "会議費"

    def test_bento_overrides_shomouhin(self):
        """AI が消耗品費と返しても、弁当なら会議費に上書きされる"""
        r = self.c.apply(_item(description="お弁当代", account="消耗品費"))
        assert r.account == "会議費"
        # 元の値は保持される
        assert r.original.account == "消耗品費"

    def test_bento_in_vendor(self):
        """vendor 側に「弁当」があっても会議費"""
        r = self.c.apply(_item(description="昼食", vendor="ほっともっと弁当店"))
        assert r.account == "会議費"

    def test_lunch_without_bento_keyword_not_changed(self):
        """「弁当」の文字列が無ければ会議費にはならない（誤マッチ防止）"""
        r = self.c.apply(_item(description="昼食", vendor="ほっともっと", account="雑費"))
        assert r.account == "雑費"
        r2 = self.c.apply(_item(description="ランチ", account="雑費"))
        assert r2.account == "雑費"

    def test_existing_rules_still_work(self):
        """他の既存ルールに悪影響がない"""
        # ガソリン → 車両費 は健在
        assert self.c.apply(_item(description="ガソリン")).account == "車両費"
        # 駐車場 → 旅費交通費 は健在
        assert self.c.apply(_item(description="駐車場")).account == "旅費交通費"
        # 収入印紙 → 租税公課 / 対象外 も健在
        r = self.c.apply(_item(description="収入印紙"))
        assert r.account == "租税公課"
        assert r.tax_category == "対象外"

    # ── 車関連 → 車両費 ──────────────────────────────
    def test_jyuryouzei_to_vehicle(self):
        """重量税 → 車両費"""
        r = self.c.apply(_item(description="重量税"))
        assert r.account == "車両費"

    def test_jibaiseki_to_vehicle(self):
        """自賠責 → 車両費"""
        r = self.c.apply(_item(description="自賠責保険料"))
        assert r.account == "車両費"

    def test_shaken_tesuuryou_to_vehicle(self):
        """車検手数料 → 車両費"""
        r = self.c.apply(_item(description="車検手数料"))
        assert r.account == "車両費"

    def test_inshi_with_shaken_context_to_vehicle(self):
        """車検文脈の印紙代 → 車両費に上書き（収入印紙ルールより後勝ち）"""
        r = self.c.apply(_item(description="車検 印紙代", account="雑費"))
        assert r.account == "車両費"

    def test_inshi_with_unyu_shikyoku_to_vehicle(self):
        """運輸支局での印紙代 → 車両費"""
        r = self.c.apply(_item(description="運輸支局 印紙代", vendor="陸運局"))
        assert r.account == "車両費"

    def test_inshi_general_stays_sozeikouka(self):
        """車関連文脈なしの印紙代 → 租税公課のまま（既存ルール維持）"""
        r = self.c.apply(_item(description="収入印紙", vendor="郵便局"))
        assert r.account == "租税公課"
        assert r.tax_category == "対象外"

    def test_inshi_at_konbini_stays_sozeikouka(self):
        """コンビニで買った印紙 → 租税公課のまま"""
        r = self.c.apply(_item(description="印紙", vendor="セブンイレブン"))
        assert r.account == "租税公課"

    def test_jidousha_keyword_to_vehicle(self):
        """「自動車」を含む → 車両費"""
        r = self.c.apply(_item(description="自動車税納付", account="雑費"))
        assert r.account == "車両費"

    def test_keizoku_kensa_to_vehicle(self):
        r = self.c.apply(_item(description="継続検査"))
        assert r.account == "車両費"

    def test_shaken_overrides_ai_sozeikouka(self):
        """AI が「租税公課」と返しても車関連文脈で車両費に上書き"""
        r = self.c.apply(_item(description="車検代行 手数料", account="租税公課"))
        assert r.account == "車両費"

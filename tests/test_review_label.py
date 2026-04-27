"""build_review_label のテスト"""

from src.rules.amount_validation import (
    AmountValidation,
    build_review_label,
)


class TestBuildReviewLabel:
    def test_default_no_signal(self):
        """何も指定なし → 既定の ※要手入力"""
        assert build_review_label() == "※要手入力"

    def test_amount_digit_inflation(self):
        v = AmountValidation(status="digit_inflation", reason="...")
        assert build_review_label(amount_validation=v) == "※金額要確認"

    def test_amount_missing_in_ocr(self):
        v = AmountValidation(status="missing_in_ocr", reason="...")
        assert build_review_label(amount_validation=v) == "※金額要確認"

    def test_amount_ok_no_label(self):
        """金額 OK で needs_review なし → 既定"""
        v = AmountValidation(status="ok")
        assert build_review_label(amount_validation=v) == "※要手入力"

    def test_low_confidence_alone(self):
        assert build_review_label(needs_review=True) == "※内容要確認"

    def test_amount_plus_low_confidence(self):
        """金額 NG + 低信頼 → 金額のみ（重複させない）"""
        v = AmountValidation(status="digit_inflation")
        assert build_review_label(amount_validation=v, needs_review=True) == "※金額要確認"

    def test_extra_reasons(self):
        v = AmountValidation(status="digit_inflation")
        out = build_review_label(amount_validation=v, extra_reasons=["勘定科目"])
        assert out == "※金額・勘定科目要確認"

    def test_extra_reasons_only(self):
        out = build_review_label(extra_reasons=["相手取引先", "摘要"])
        assert out == "※相手取引先・摘要要確認"

    def test_no_candidates_amount_no_label(self):
        """no_candidates / no_ai_amount は金額NG扱いしない（is_valid=True）"""
        v = AmountValidation(status="no_candidates")
        assert build_review_label(amount_validation=v) == "※要手入力"
        v2 = AmountValidation(status="no_ai_amount")
        assert build_review_label(amount_validation=v2) == "※要手入力"

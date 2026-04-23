"""金額バリデーションのテスト"""

from src.rules.amount_validation import (
    AmountValidation,
    extract_amount_candidates,
    validate_amount,
)


class TestExtractAmountCandidates:
    def test_plain_digits(self):
        assert 1600 in extract_amount_candidates("1600")

    def test_comma_separated(self):
        assert 1600 in extract_amount_candidates("1,600")

    def test_with_yen_mark(self):
        assert 1600 in extract_amount_candidates("¥1,600")
        assert 1600 in extract_amount_candidates("￥1600")

    def test_with_yen_suffix(self):
        assert 1600 in extract_amount_candidates("1,600円")

    def test_mixed_in_sentence(self):
        text = "合計 ¥1,600 税込 (内消費税 145円)"
        c = extract_amount_candidates(text)
        assert 1600 in c
        # 145 は3桁以上の連続数字または円付きで拾う
        assert 145 in c

    def test_empty_and_invalid(self):
        assert extract_amount_candidates("") == []
        assert extract_amount_candidates("テキストのみ") == []

    def test_very_large_filtered(self):
        """1億以上の非現実的な値は除外（OCRノイズ想定）"""
        c = extract_amount_candidates("123456789012")
        assert all(v < 10**8 for v in c)


class TestValidateAmount:
    def test_ok_exact_match(self):
        v = validate_amount(1600, "合計 ¥1,600")
        assert v.status == "ok"
        assert v.is_valid
        assert not v.should_manual_entry

    def test_digit_inflation_misread(self):
        """先頭に余計な 4 が付いた誤読パターン。これが今回の主目的"""
        v = validate_amount(41600, "合計 ¥1,600")
        assert v.status == "digit_inflation"
        assert not v.is_valid
        assert v.should_manual_entry
        assert 1600 in v.matched_candidates

    def test_missing_in_ocr(self):
        """OCR に見当たらない額"""
        v = validate_amount(9999, "合計 1,600")
        assert v.status == "missing_in_ocr"
        assert v.should_manual_entry

    def test_no_ai_amount(self):
        v = validate_amount(None, "何か")
        assert v.status == "no_ai_amount"
        assert not v.should_manual_entry

    def test_no_candidates(self):
        """OCR に数値が無い場合は判断不能でOK扱い（success 継続）"""
        v = validate_amount(1600, "テキストのみ")
        assert v.status == "no_candidates"
        assert v.is_valid
        assert not v.should_manual_entry

    def test_three_digit_amount_no_false_positive(self):
        """3桁の場合は先頭削っても2桁になり digit_inflation 判定されない"""
        v = validate_amount(500, "¥100 ¥200")
        # 500 は候補に無いので missing_in_ocr
        assert v.status == "missing_in_ocr"

    def test_returns_dataclass(self):
        v = validate_amount(1000, "")
        assert isinstance(v, AmountValidation)

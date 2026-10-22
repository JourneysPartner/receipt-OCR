"""金額抽出・検証・確認ラベルの性質テスト"""

import pytest
from hypothesis import example, given
from hypothesis import strategies as st

from src.rules.amount_validation import (
    AmountValidation,
    build_review_label,
    extract_amount_candidates,
    validate_amount,
)

OCR_TEXT = st.one_of(
    st.text(max_size=512),
    st.text(alphabet="0123456789０１２３４５６７８９,，¥￥円+-−. \n", max_size=512),
)
INTEGERS = st.one_of(
    st.integers(),
    st.sampled_from([-(10**100), -1, 0, 1, 10**8 - 1, 10**8, 10**100]),
)
VALID_AMOUNT = st.integers(min_value=1, max_value=10**8 - 1)
STATUSES = ("ok", "no_ai_amount", "no_candidates", "digit_inflation", "missing_in_ocr")
VALIDATION = st.one_of(st.none(), st.builds(AmountValidation, status=st.sampled_from(STATUSES)))


@given(text=OCR_TEXT)
@example(text="9" * 5000)
def test_candidates_are_sorted_unique_and_bounded(text):
    """OCR ノイズを含む文字列でも、候補は重複のない昇順の1億円未満の正整数になる。"""
    candidates = extract_amount_candidates(text)
    assert candidates == sorted(set(candidates))
    assert all(type(value) is int and 1 <= value < 10**8 for value in candidates)


@given(text=OCR_TEXT)
def test_candidates_are_deterministic(text):
    """抽出は外部状態に依存せず、同じ OCR 文字列から同じ候補を返す。"""
    assert extract_amount_candidates(text) == extract_amount_candidates(text)


@given(
    amount=VALID_AMOUNT,
    template=st.sampled_from(["¥{}", "￥{}", "{}円"]),
    comma=st.booleans(),
    fullwidth=st.booleans(),
)
@example(amount=1, template="¥{}", comma=False, fullwidth=False)
@example(amount=99_999_999, template="￥{}", comma=True, fullwidth=True)
def test_formatted_amount_round_trips(amount, template, comma, fullwidth):
    """円記号・円接尾辞と ASCII カンマに対応し、全角数字も int に変換できる。"""
    digits = f"{amount:,}" if comma else str(amount)
    if fullwidth:
        digits = digits.translate(str.maketrans("0123456789", "０１２３４５６７８９"))
    assert amount in extract_amount_candidates(f"合計 {template.format(digits)} 税込")


@given(amount=st.one_of(st.just(0), st.integers(min_value=10**8, max_value=10**100)))
def test_zero_and_oversized_amounts_are_not_candidates(amount):
    """0 と1億円以上は実装のノイズ除去範囲なので、元の金額そのものを採用しない。"""
    assert amount not in extract_amount_candidates(f"合計 ¥{amount:,}")


@given(ai_amount=st.one_of(st.none(), INTEGERS), text=OCR_TEXT)
def test_validation_is_deterministic(ai_amount, text):
    """任意の文字列と整数・None に対する検証は、同じ入力なら同じ結果を返す。"""
    result = validate_amount(ai_amount, text)
    assert isinstance(result, AmountValidation)
    assert result == validate_amount(ai_amount, text)


@pytest.mark.xfail(strict=True, reason='反例: AI=10**4300, OCR="¥1" で ValueError')
@given(exponent=st.integers(min_value=0, max_value=5000))
@example(exponent=4300)
def test_validation_accepts_very_large_integers(exponent):
    """型注釈に上限のない int を受け取るため、巨大な AI 金額でも検証結果を返す。"""
    # 最小反例: exponent=4300（Python の既定の変換上限は4300桁）。
    # 期待は AmountValidation、実際は str(ai_amount) で ValueError。src は変更しない。
    assert isinstance(validate_amount(10**exponent, "¥1"), AmountValidation)


@given(amount=VALID_AMOUNT, others=st.lists(VALID_AMOUNT, max_size=8))
def test_matching_candidate_remains_valid_with_other_amounts(amount, others):
    """一致する候補があれば、別の候補を追加しても金額一致の判定は変わらない。"""
    text = "\n".join(f"¥{value:,}" for value in [amount, *others])
    result = validate_amount(amount, text)
    assert result.status == "ok"
    assert result.chosen_amount == amount
    assert result.is_valid and not result.should_manual_entry


@given(ai_amount=INTEGERS, amount=VALID_AMOUNT)
@example(ai_amount=-1, amount=1)
@example(ai_amount=0, amount=1)
def test_candidate_membership_controls_manual_entry(ai_amount, amount):
    """候補が存在する場合、一致と手入力判定は排他的で、元の AI 金額も保存される。"""
    text = f"合計 ¥{amount:,}"
    candidates = extract_amount_candidates(text)
    result = validate_amount(ai_amount, text)
    matches = ai_amount in candidates
    assert (result.status == "ok") == matches
    assert result.is_valid == matches
    assert result.should_manual_entry == (not matches)
    assert result.matched_candidates == candidates
    assert result.chosen_amount == ai_amount


@given(text=OCR_TEXT)
def test_missing_ai_amount_is_independent_of_ocr(text):
    """AI 金額なしは OCR の内容によらず専用状態になり、金額誤りの手入力判定を出さない。"""
    result = validate_amount(None, text)
    assert result.status == "no_ai_amount"
    assert result.chosen_amount is None
    assert result.matched_candidates == []
    assert result.is_valid and not result.should_manual_entry


@given(ai_amount=INTEGERS, text=st.text(alphabet="合計税込abc¥￥円 ,，\n\t", max_size=128))
def test_absent_candidates_preserve_ai_amount(ai_amount, text):
    """数字のない OCR は判断不能として通し、AI 金額を変更しない契約を保つ。"""
    result = validate_amount(ai_amount, text)
    assert result.status == "no_candidates"
    assert result.chosen_amount == ai_amount
    assert result.is_valid and not result.should_manual_entry


@given(status=st.sampled_from(STATUSES), reason=st.text(), amount=st.one_of(st.none(), INTEGERS))
def test_validation_flags_are_exclusive(status, reason, amount):
    """既知の状態では理由や金額によらず、有効判定と手入力判定の片方だけが真になる。"""
    result = AmountValidation(status=status, reason=reason, chosen_amount=amount)
    assert result.is_valid != result.should_manual_entry


@given(candidates=st.lists(INTEGERS, max_size=8))
def test_validation_candidate_lists_are_independent(candidates):
    """結果ごとの候補リストは独立し、他の検証結果へ候補が混入しない。"""
    first = AmountValidation(status="ok")
    second = AmountValidation(status="ok")
    first.matched_candidates.extend(candidates)
    assert second.matched_candidates == []


@given(
    validation=VALIDATION,
    needs_review=st.booleans(),
    reasons=st.lists(st.text(max_size=32), max_size=8),
)
def test_review_label_ignores_empty_and_duplicate_reasons(validation, needs_review, reasons):
    """任意の理由文字列でも、空理由や既出理由の再追加で確認ラベルを変えない。"""
    original = list(reasons)
    label = build_review_label(
        amount_validation=validation, needs_review=needs_review, extra_reasons=reasons
    )
    assert label == build_review_label(
        amount_validation=validation,
        needs_review=needs_review,
        extra_reasons=[*reasons, "", *reasons],
    )
    assert reasons == original


@given(
    status=st.sampled_from(["digit_inflation", "missing_in_ocr"]),
    reasons=st.lists(st.text(max_size=32), max_size=8),
)
def test_amount_review_takes_priority_over_low_confidence(status, reasons):
    """金額誤りがある場合は金額を先頭理由にし、低信頼フラグの追加で理由を重複させない。"""
    validation = AmountValidation(status=status)
    label = build_review_label(amount_validation=validation, extra_reasons=reasons)
    assert label.startswith("※金額")
    assert label == build_review_label(
        amount_validation=validation, needs_review=True, extra_reasons=reasons
    )

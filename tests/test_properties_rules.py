"""レシート補正の性質テスト"""

import math
from dataclasses import fields, replace

from hypothesis import example, given
from hypothesis import strategies as st

from src.models import CorrectedItem, ReceiptItem
from src.rules.corrections import RuleCorrector

OPTIONAL_TEXT = st.one_of(st.none(), st.text(max_size=128))
RULE_TEXT = st.one_of(
    OPTIONAL_TEXT,
    st.lists(
        st.sampled_from(["ガソリン", "駐車場", "印紙", "郵便", "弁当", "車検", "文具", "JR"]),
        min_size=1,
        max_size=5,
    ).map(" ".join),
)
RECEIPTS = st.builds(
    ReceiptItem,
    date=OPTIONAL_TEXT,
    amount=st.one_of(st.none(), st.integers(), st.sampled_from([-(10**100), 0, 1, 10**100])),
    vendor=RULE_TEXT,
    description=RULE_TEXT,
    account=OPTIONAL_TEXT,
    tax_category=OPTIONAL_TEXT,
    confidence=st.floats(),
    is_expense=st.booleans(),
    memo=OPTIONAL_TEXT,
)


def _as_receipt(item: CorrectedItem) -> ReceiptItem:
    return ReceiptItem(**{field.name: getattr(item, field.name) for field in fields(ReceiptItem)})


def _assert_receipt_values_equal(actual: ReceiptItem, expected: ReceiptItem) -> None:
    # NaN は自分自身とも等しくないため、値が保存されたかを別に比較する。
    assert actual.confidence == expected.confidence or (
        math.isnan(actual.confidence) and math.isnan(expected.confidence)
    )
    assert replace(actual, confidence=0.0) == replace(expected, confidence=0.0)


@given(item=RECEIPTS)
def test_correction_accepts_arbitrary_receipt_fields(item):
    """任意の型どおりの項目と非有限の信頼度でも、例外なく補正結果と元データを返す。"""
    result = RuleCorrector().apply(item)
    assert isinstance(result, CorrectedItem)
    assert result.original is item


@given(item=RECEIPTS)
def test_correction_does_not_mutate_input(item):
    """複数ルールが競合しても、入力のレシート自体を書き換えない。"""
    original = replace(item)
    RuleCorrector().apply(item)
    _assert_receipt_values_equal(item, original)


@given(item=RECEIPTS)
def test_correction_preserves_fields_outside_account_and_tax(item):
    """補正対象は勘定科目と税区分なので、金額・日付・摘要など他の入力値を保存する。"""
    result = RuleCorrector().apply(item)
    _assert_receipt_values_equal(
        _as_receipt(result), replace(item, account=result.account, tax_category=result.tax_category)
    )


@given(item=RECEIPTS)
@example(item=ReceiptItem(description="印紙 車検 弁当", account="雑費"))
def test_account_and_tax_correction_is_idempotent(item):
    """補正結果を ReceiptItem に戻して再適用しても勘定科目・税区分は変わらない。"""
    corrector = RuleCorrector()
    first = corrector.apply(item)
    second = corrector.apply(_as_receipt(first))
    # 補正履歴は再適用時にも記録され得るため、業務値の冪等性だけを検証する。
    assert (second.account, second.tax_category) == (first.account, first.tax_category)


@given(
    confidence=st.floats(allow_nan=False),
    threshold=st.floats(min_value=0, max_value=1),
)
@example(confidence=0.7, threshold=0.7)
@example(confidence=math.nextafter(0.7, -math.inf), threshold=0.7)
def test_review_flag_obeys_strict_confidence_threshold(confidence, threshold):
    """信頼度が閾値未満のときだけ確認対象となり、閾値ちょうどは確認対象にならない。"""
    result = RuleCorrector(confidence_threshold=threshold).apply(ReceiptItem(confidence=confidence))
    assert result.needs_review == (confidence < threshold)


@given(item=RECEIPTS, threshold=st.floats(min_value=0, max_value=1))
def test_review_threshold_does_not_change_account_or_tax(item, threshold):
    """信頼度閾値は確認フラグのための設定なので、勘定科目・税区分の補正には影響しない。"""
    default = RuleCorrector().apply(item)
    changed = RuleCorrector(confidence_threshold=threshold).apply(item)
    assert (changed.account, changed.tax_category) == (default.account, default.tax_category)

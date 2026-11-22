"""reconcile（画像からの読みと文字からの読みの照合）のテスト。"""

import pytest
from hypothesis import given
from hypothesis import strategies as st

from src.models import ReceiptItem
from src.processing.reconcile import (
    LABEL_AMOUNT,
    LABEL_COUNT,
    LABEL_DATE,
    LABEL_READ,
    ItemDecision,
    merge_second_reader,
    needs_second_reader,
    readings_text,
    reconcile,
    second_reader_reason,
)


def _item(date, amount) -> ReceiptItem:
    return ReceiptItem(
        date=date,
        amount=amount,
        vendor="店",
        description="摘要",
        account="雑費",
        tax_category="課税仕入10%",
        confidence=0.9,
    )


class TestReconcile:
    def test_all_matched(self):
        images = [_item("2025-04-02", 1200), _item("2025-04-03", 800)]
        texts = [_item("2025-04-02", 1200), _item("2025-04-03", 800)]

        decisions = reconcile(images, texts, "合計 ¥1,200 と ¥800")

        assert [d.matched for d in decisions] == [True, True]
        assert [d.label for d in decisions] == ["", ""]
        assert [d.text_index for d in decisions] == [0, 1]

    def test_amount_differs(self):
        images = [_item("2025-04-02", 1200)]
        texts = [_item("2025-04-02", 1500)]

        decisions = reconcile(images, texts, "合計 ¥1,200")

        assert len(decisions) == 1
        assert decisions[0].matched is False
        assert decisions[0].label == LABEL_AMOUNT
        assert decisions[0].text_index is None

    def test_only_date_differs(self):
        images = [_item("2025-04-02", 1200)]
        texts = [_item("2025-04-03", 1200)]

        decisions = reconcile(images, texts, "合計 ¥1,200")

        assert decisions[0].matched is False
        assert decisions[0].label == LABEL_DATE
        assert decisions[0].text_index is None

    def test_text_empty(self):
        images = [_item("2025-04-02", 1200), _item("2025-04-03", 800)]

        decisions = reconcile(images, [], "")

        assert len(decisions) == 2
        assert all(d.label == LABEL_READ for d in decisions)
        assert all(d.matched is False for d in decisions)

    def test_text_more_than_image(self):
        images = [_item("2025-04-02", 1200)]
        texts = [_item("2025-04-02", 1200), _item("2025-04-03", 800)]

        decisions = reconcile(images, texts, "合計 ¥1,200 と ¥800")

        assert len(decisions) == 1
        assert decisions[0].matched is False
        assert decisions[0].label == LABEL_COUNT
        assert decisions[0].text_index is None

    def test_image_more_than_text(self):
        images = [_item("2025-04-02", 1200), _item("2025-04-03", 800)]
        texts = [_item("2025-04-02", 1200)]

        decisions = reconcile(images, texts, "合計 ¥1,200")

        assert [d.matched for d in decisions] == [True, False]
        assert decisions[1].label == LABEL_AMOUNT

    def test_three_same_items_all_matched(self):
        images = [
            _item("2025-04-02", 20),
            _item("2025-04-02", 20),
            _item("2025-04-02", 20),
        ]
        texts = [
            _item("2025-04-02", 20),
            _item("2025-04-02", 20),
            _item("2025-04-02", 20),
        ]

        decisions = reconcile(images, texts, "20 円")

        assert [d.matched for d in decisions] == [True, True, True]
        assert [d.text_index for d in decisions] == [0, 1, 2]

    def test_three_same_items_one_text_matched_once(self):
        images = [
            _item("2025-04-02", 20),
            _item("2025-04-02", 20),
            _item("2025-04-02", 20),
        ]
        texts = [_item("2025-04-02", 20)]

        decisions = reconcile(images, texts, "20 円")

        assert [d.matched for d in decisions] == [True, False, False]
        assert decisions[0].text_index == 0
        assert decisions[1].label == LABEL_AMOUNT
        assert decisions[2].label == LABEL_AMOUNT

    def test_digit_inflation_is_reviewed(self):
        images = [_item("2026-04-27", 41600)]
        texts = [_item("2026-04-27", 41600)]

        decisions = reconcile(images, texts, "合計 ¥1,600")

        assert decisions[0].matched is False
        assert decisions[0].label == LABEL_AMOUNT
        # 組にはなっている（文字からの位置を残す）
        assert decisions[0].text_index == 0

    def test_missing_amount_or_date_is_not_matched(self):
        images = [
            ReceiptItem(date="2025-04-02", amount=None),
            ReceiptItem(date="", amount=1200),
        ]
        texts = [_item("2025-04-02", 1200)]

        decisions = reconcile(images, texts, "合計 ¥1,200")

        assert len(decisions) == 2
        assert all(d.matched is False for d in decisions)
        assert all(d.text_index is None for d in decisions)

    def test_different_date_format_same_day_matches(self):
        images = [_item("2025/4/2", 1200)]
        texts = [_item("2025-04-02", 1200)]

        decisions = reconcile(images, texts, "合計 ¥1,200")

        assert decisions[0].matched is True
        assert decisions[0].label == ""

    def test_no_items(self):
        assert reconcile([], [], "") == []
        # T が多い場合でも戻り値の長さは I の件数
        assert reconcile([], [_item("2025-04-02", 1200)], "") == []


class TestReconcileKeys:
    def test_zero_amount_is_not_matched_even_if_both_are_zero(self):
        decisions = reconcile([_item("2025-04-02", 0)], [_item("2025-04-02", 0)], "")

        assert decisions[0].matched is False
        assert decisions[0].label == LABEL_AMOUNT
        assert decisions[0].reason == "金額が 0 以下"
        assert decisions[0].text_index is None

    @pytest.mark.parametrize("amount", [-50, -500])
    def test_negative_amount_is_not_matched(self, amount):
        decisions = reconcile([_item("2025-04-02", amount)], [_item("2025-04-02", amount)], "")

        assert decisions[0].matched is False
        assert decisions[0].label == LABEL_AMOUNT

    @pytest.mark.parametrize("date", ["2025-02-30", "R7.5.13", "不明"])
    def test_unreadable_date_is_not_matched(self, date):
        decisions = reconcile([_item(date, 1200)], [_item(date, 1200)], "合計 ¥1,200")

        assert decisions[0].matched is False
        assert decisions[0].label == LABEL_DATE
        assert decisions[0].text_index is None

    def test_unreadable_date_with_equal_amount_is_date_review(self):
        decisions = reconcile(
            [_item("2025-02-30", 1200)], [_item("2025-04-02", 1200)], "合計 ¥1,200"
        )

        assert decisions[0].matched is False
        assert decisions[0].label == LABEL_DATE
        assert decisions[0].text_index is None

    def test_date_must_be_written_as_yyyy_mm_dd(self):
        images = [_item("20250402", 1200)]
        texts = [_item("20250402", 1200)]

        decisions = reconcile(images, texts, "合計 ¥1,200")

        assert decisions[0].matched is False
        assert decisions[0].text_index is None

    def test_week_date_is_not_matched(self):
        images = [_item("2025-W14-3", 1200)]
        texts = [_item("2025-W14-3", 1200)]

        decisions = reconcile(images, texts, "合計 ¥1,200")

        assert decisions[0].matched is False
        assert decisions[0].text_index is None

    def test_slash_and_iso_dates_still_match(self):
        images = [_item("2025/4/2", 1200)]
        texts = [_item("2025-04-02", 1200)]

        decisions = reconcile(images, texts, "合計 ¥1,200")

        assert decisions[0].matched is True
        assert decisions[0].label == ""

    def test_zero_amount_on_the_text_side_does_not_make_a_pair(self):
        decisions = reconcile([_item("2025-04-02", 1200)], [_item("2025-04-02", 0)], "")

        assert decisions[0].matched is False
        assert decisions[0].label == LABEL_AMOUNT


class TestReadingsText:
    def test_both_sides(self):
        images = [_item("2025-04-02", 1200), _item("2025-04-03", 800)]
        texts = [_item("2025-04-02", 1200)]

        assert (
            readings_text(images, texts)
            == "画像=2025-04-02/1200, 2025-04-03/800 ｜ 文字=2025-04-02/1200"
        )

    def test_empty_sides(self):
        assert readings_text([], []) == "画像=なし ｜ 文字=なし"
        assert readings_text([], [_item("2025-04-02", 1200)]) == (
            "画像=なし ｜ 文字=2025-04-02/1200"
        )

    def test_unknown_values(self):
        images = [ReceiptItem(date=None, amount=None)]

        assert readings_text(images, []) == "画像=?/? ｜ 文字=なし"

    def test_missing_amount_is_question_mark(self):
        images = [ReceiptItem(date="2025-04-02", amount=None)]

        assert readings_text(images, []) == "画像=2025-04-02/? ｜ 文字=なし"

    def test_zero_and_negative_amounts_are_shown_as_is(self):
        images = [_item("2025-04-02", 0), _item("2025-04-03", -500)]

        assert readings_text(images, []) == "画像=2025-04-02/0, 2025-04-03/-500 ｜ 文字=なし"

    def test_more_than_ten_items(self):
        images = [_item("2025-04-02", i) for i in range(1, 13)]

        text = readings_text(images, [])

        assert "画像=2025-04-02/1," in text
        assert "2025-04-02/10" in text
        assert "2025-04-02/11" not in text
        assert "…ほか 2 件" in text

    def test_second_side_is_added_only_when_given(self):
        images = [_item("2025-04-02", 1200)]
        texts = [_item("2025-04-03", 900)]

        without = readings_text(images, texts)
        assert without == "画像=2025-04-02/1200 ｜ 文字=2025-04-03/900"
        assert readings_text(images, texts, None) == without
        assert readings_text(images, texts, [_item("2025-04-02", 1200)]) == (
            "画像=2025-04-02/1200 ｜ 文字=2025-04-03/900 ｜ もう1人=2025-04-02/1200"
        )

    def test_second_side_empty_is_none(self):
        assert readings_text([], [], []) == "画像=なし ｜ 文字=なし ｜ もう1人=なし"


class TestNeedsSecondReader:
    def test_requires_an_image_item(self):
        assert not needs_second_reader(
            [], [ItemDecision(False, LABEL_AMOUNT, "金額が食い違う", None)]
        )
        assert not needs_second_reader([], [])

    def test_requires_an_unmatched_item(self):
        matched = [ItemDecision(True, "", "", 0)]
        unmatched = [ItemDecision(False, LABEL_AMOUNT, "金額が食い違う", None)]
        images = [_item("2025-04-02", 1200)]

        assert not needs_second_reader(images, matched)
        assert needs_second_reader(images, matched + unmatched)
        assert not needs_second_reader(images, [])

    def test_never_raises_on_missing_decisions(self):
        assert not needs_second_reader([_item("2025-04-02", 1200)], None)


class TestMergeSecondReader:
    def test_keeps_d0_matches_and_adds_dx_matches(self):
        d0 = [
            ItemDecision(True, "", "", 0),
            ItemDecision(False, LABEL_AMOUNT, "金額が食い違う", 1),
            ItemDecision(False, LABEL_DATE, "日付が食い違う", None),
        ]
        dx = [
            ItemDecision(False, LABEL_AMOUNT, "金額が食い違う", None),
            ItemDecision(True, "", "", None),
            ItemDecision(False, LABEL_DATE, "日付が食い違う", None),
        ]

        merged, matched = merge_second_reader(d0, dx)

        assert len(merged) == 3
        assert [decision.matched for decision in merged] == [True, True, False]
        assert merged[1].label == "" and merged[1].reason == ""
        assert merged[1].text_index == 1
        assert merged[2] is d0[2]
        assert matched == {1}

    def test_short_long_and_none_dx_do_not_raise(self):
        d0 = [
            ItemDecision(False, LABEL_AMOUNT, "金額が食い違う", None),
            ItemDecision(False, LABEL_AMOUNT, "金額が食い違う", None),
        ]

        for dx in (None, [], [ItemDecision(True, "", "", None)]):
            merged, matched = merge_second_reader(d0, dx)
            assert len(merged) == 2
            if dx:
                assert merged[0].matched and matched == {0}
                assert not merged[1].matched
            else:
                assert not any(decision.matched for decision in merged)
                assert matched == set()

        merged, matched = merge_second_reader(
            d0,
            [
                ItemDecision(True, "", "", None),
                ItemDecision(True, "", "", None),
                ItemDecision(True, "", "", None),
            ],
        )
        assert len(merged) == 2 and matched == {0, 1}

    def test_never_raises_for_broken_input(self):
        merged, matched = merge_second_reader(None, None)
        assert merged == [] and matched == set()


class TestSecondReaderReason:
    def test_zero_items_uses_the_error_type(self):
        assert second_reader_reason([], 1, None, "api_error") == "読めなかった（api_error）"
        assert second_reader_reason([], 1, None) == "読めなかった（zero_items）"

    def test_more_items_than_the_image(self):
        second = [_item("2025-04-02", 1200), _item("2025-04-03", 900)]
        assert second_reader_reason(second, 1, None) == "もう1人は 2 件、画像からは 1 件"

    def test_otherwise_uses_the_dx_reason(self):
        decision = ItemDecision(False, LABEL_DATE, "日付が食い違う", None)
        assert second_reader_reason([_item("2025-04-03", 1200)], 1, decision) == "日付が食い違う"

    def test_missing_reason_falls_back(self):
        decision = ItemDecision(False, "", "", None)
        assert second_reader_reason([_item("2025-04-03", 1200)], 1, decision) == "金額が食い違う"


def test_decision_defaults_are_plain():
    """ItemDecision はそのまま比較できる（frozen dataclass）。"""
    assert ItemDecision(True, "", "", None) == ItemDecision(True, "", "", None)


@given(
    st.lists(st.booleans(), max_size=4),
    st.lists(st.booleans(), max_size=4),
)
def test_merge_second_reader_invariants(d0_flags, dx_flags):
    """長さは D0 の長さ。D0 の一致は残る。戻りの一致は D0 か Dx の一致（N2・N11）。"""
    d0 = [
        ItemDecision(flag, "" if flag else LABEL_AMOUNT, "" if flag else "金額が食い違う", None)
        for flag in d0_flags
    ]
    dx = [
        ItemDecision(flag, "" if flag else LABEL_AMOUNT, "" if flag else "金額が食い違う", None)
        for flag in dx_flags
    ]

    merged, matched = merge_second_reader(d0, dx)

    assert len(merged) == len(d0)
    assert matched <= set(range(len(d0)))
    for index, flag in enumerate(d0_flags):
        if flag:
            assert merged[index].matched
    for index, decision in enumerate(merged):
        if decision.matched:
            assert d0_flags[index] or (index < len(dx_flags) and dx_flags[index])

"""reconcile（画像からの読みと文字からの読みの照合）のテスト。"""

import pytest

from src.models import ReceiptItem
from src.processing.reconcile import (
    LABEL_AMOUNT,
    LABEL_COUNT,
    LABEL_DATE,
    LABEL_READ,
    ItemDecision,
    readings_text,
    reconcile,
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


def test_decision_defaults_are_plain():
    """ItemDecision はそのまま比較できる（frozen dataclass）。"""
    assert ItemDecision(True, "", "", None) == ItemDecision(True, "", "", None)

"""reconcile（画像からの読みと文字からの読みの照合）のテスト。"""

from collections import Counter

import pytest
from hypothesis import given
from hypothesis import strategies as st

from src.models import ReceiptItem
from src.processing.reconcile import (
    LABEL_AMOUNT,
    LABEL_COUNT,
    LABEL_DATE,
    LABEL_READ,
    LABEL_REREAD,
    ItemDecision,
    assign_review_amounts,
    merge_second_reader,
    needs_second_reader,
    readings_text,
    reconcile,
    review_amount,
    second_reader_reason,
)
from src.rules.amount_validation import validate_amount


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


class TestReviewAmount:
    """要確認の行で M 列に書いてよい金額か（仕様 review_amount §4）。"""

    @staticmethod
    def _d0(label: str) -> ItemDecision:
        return ItemDecision(False, label, "理由", None)

    def test_d0_date_only_agreement_returns_the_main_amount(self):
        image = _item("2025-04-02", 1200)

        assert review_amount(image, self._d0(LABEL_DATE), None, "合計 ¥1,200") == 1200

    def test_d0_amount_but_dx_date_only_returns_the_main_amount(self):
        image = _item("2025-04-02", 1200)

        assert (
            review_amount(
                image,
                self._d0(LABEL_AMOUNT),
                self._d0(LABEL_DATE),
                "合計 ¥1,200",
            )
            == 1200
        )

    def test_dx_date_agreement_with_digit_inflation_returns_none(self):
        """Dx が日付だけ食い違って金額が合っても、桁の疑いがあれば書かない（W3）。"""
        image = _item("2026-04-27", 41600)

        assert (
            review_amount(
                image,
                self._d0(LABEL_AMOUNT),
                self._d0(LABEL_DATE),
                "合計 ¥1,600",
            )
            is None
        )

    def test_d0_and_dx_amount_mismatches_return_none(self):
        image = _item("2025-04-02", 1200)

        assert (
            review_amount(image, self._d0(LABEL_AMOUNT), self._d0(LABEL_AMOUNT), "合計 ¥1,200")
            is None
        )

    def test_d0_with_count_returns_none_even_if_dx_agrees(self):
        image = _item("2025-04-02", 1200)

        assert (
            review_amount(image, self._d0(LABEL_COUNT), self._d0(LABEL_DATE), "合計 ¥1,200") is None
        )

    def test_d0_reread_returns_none(self):
        image = _item("2025-04-02", 1200)

        assert review_amount(image, self._d0(LABEL_REREAD), None, "合計 ¥1,200") is None

    def test_digit_inflation_returns_none(self):
        # D0 は日付だけ食い違う（reconcile は桁の検査を掛けない）が、Vision の文字には
        # 先頭 1 桁を取った金額があるので書かない（W3）。
        image = _item("2026-04-27", 41600)

        assert review_amount(image, self._d0(LABEL_DATE), None, "合計 ¥1,600") is None

    @pytest.mark.parametrize("ocr_text", ["", "   ", "\n\t "])
    def test_empty_ocr_text_returns_none(self, ocr_text):
        image = _item("2025-04-02", 1200)

        assert review_amount(image, self._d0(LABEL_DATE), None, ocr_text) is None

    @pytest.mark.parametrize("amount", [0, -1, -1200, None, True, False, "1200", 1200.0])
    def test_bad_amounts_return_none(self, amount):
        image = _item("2025-04-02", amount)

        assert review_amount(image, self._d0(LABEL_DATE), None, "合計 ¥1,200") is None

    def test_non_expense_returns_none(self):
        image = ReceiptItem(date="2025-04-02", amount=1200, is_expense=False)

        assert review_amount(image, self._d0(LABEL_DATE), None, "合計 ¥1,200") is None

    def test_d0_missing_returns_none(self):
        image = _item("2025-04-02", 1200)

        assert review_amount(image, None, self._d0(LABEL_DATE), "合計 ¥1,200") is None

    def test_dx_missing_keeps_the_d0_date_agreement(self):
        image = _item("2025-04-02", 1200)

        assert review_amount(image, self._d0(LABEL_DATE), None, "合計 ¥1,200") == 1200

    def test_matched_d0_is_not_a_review_row(self):
        """自動で書く明細は要確認の行ではないので、M 列には書かない。"""
        image = _item("2025-04-02", 1200)
        d0 = ItemDecision(True, "", "", 0)

        assert review_amount(image, d0, self._d0(LABEL_DATE), "合計 ¥1,200") is None

    def test_broken_input_never_raises(self):
        assert review_amount(None, None, None, "") is None
        assert review_amount(object(), object(), object(), None) is None
        assert review_amount(_item("2025-04-02", 1200), "x", 3, 4) is None


def _amount_counts(items) -> Counter:
    """明細の金額（1 以上の整数）を、使われたかによらず全部数える（仕様 §11.1）。"""
    counts: Counter = Counter()
    for item in items:
        amount = getattr(item, "amount", None)
        if isinstance(amount, bool) or not isinstance(amount, int) or amount < 1:
            continue
        counts[amount] += 1
    return counts


class TestAssignReviewAmounts:
    """M に書く金額を枚数の決まりで決める（仕様 review_amount §11.1）。"""

    OCR = "合計 ¥1,200"

    def test_two_same_amounts_with_one_on_the_text_side_write_none(self):
        images = [_item("2025-04-02", 1200), _item("2025-04-03", 1200)]
        texts = [_item("2025-04-04", 1200)]
        d0 = reconcile(images, texts, self.OCR)

        result = assign_review_amounts(images, texts, [], d0, None, self.OCR, [0, 1])

        # 主の画像からは 2 枚、文字からは 1 枚しか見ていないので、どちらも書かない。
        assert result == {}

    def test_two_same_amounts_on_both_sides_write_both(self):
        images = [_item("2025-04-02", 1200), _item("2025-04-03", 1200)]
        texts = [_item("2025-04-04", 1200), _item("2025-04-05", 1200)]
        d0 = reconcile(images, texts, self.OCR)

        result = assign_review_amounts(images, texts, [], d0, None, self.OCR, [0, 1])

        assert result == {0: 1200, 1: 1200}

    def test_items_used_in_matched_pairs_count_toward_the_text_side(self):
        images = [_item("2025-04-03", 1200), _item("2025-04-04", 1200)]
        texts = [_item("2025-04-03", 1200), _item("2025-04-05", 1200)]
        d0 = reconcile(images, texts, self.OCR)
        assert d0[0].matched and d0[0].text_index == 0
        assert d0[1].label == LABEL_DATE

        result = assign_review_amounts(images, texts, [], d0, None, self.OCR, [1])

        # 自動になった組に使われた文字からの 1 枚も数える（主 2 枚 <= 文字 2 枚）。
        assert result == {1: 1200}

    def test_items_used_in_digit_flagged_pairs_count_toward_the_text_side(self):
        images = [_item("2026-04-27", 1200), _item("2026-04-28", 1200)]
        texts = [_item("2026-04-27", 1200), _item("2026-04-30", 1200)]
        d0 = [
            ItemDecision(False, LABEL_AMOUNT, "先頭の桁の読み違いの疑い", 0),
            ItemDecision(False, LABEL_DATE, "日付が食い違う", None),
        ]

        result = assign_review_amounts(images, texts, [], d0, None, self.OCR, [1])

        # 桁の疑いの組に使われた文字からの 1 枚も数える（主 2 枚 <= 文字 2 枚）。
        assert result == {1: 1200}

    def test_second_side_with_one_item_cannot_back_two_rows(self):
        images = [_item("2025-04-02", 1200), _item("2025-04-03", 1200)]
        second = [_item("2025-04-04", 1200)]
        d0 = reconcile(images, [], self.OCR)
        dx = reconcile(images, second, self.OCR)
        assert [d0[0].label, d0[1].label] == [LABEL_READ, LABEL_READ]
        assert [dx[0].label, dx[1].label] == [LABEL_DATE, LABEL_DATE]

        result = assign_review_amounts(images, [], second, d0, dx, self.OCR, [0, 1])

        # もう 1 人は 1 枚しか見ていないので、2 行とも書かない。
        assert result == {}

    def test_indices_outside_eligible_are_not_written_but_are_still_counted(self):
        images = [
            _item("2025-04-02", 1200),
            _item("2025-04-03", 1200),
            _item("2025-04-04", 1200),
        ]
        texts = [_item("2025-04-05", 1200)]
        d0 = reconcile(images, texts, self.OCR)
        assert all(decision.label == LABEL_DATE for decision in d0)

        result = assign_review_amounts(images, texts, [], d0, None, self.OCR, [2])

        # eligible の外の 2 枚も主の画像からの枚数に数える（主 3 枚 > 文字 1 枚）。
        assert result == {}

    def test_first_item_matched_by_the_second_leaves_the_second_without_m(self):
        """§11.2 (a): 1 つ目がもう 1 人で自動 → 2 つ目は M なし。"""
        images = [_item("2025-04-02", 1200), _item("2025-04-03", 1200)]
        texts = [_item("2025-04-04", 1200)]
        second = [_item("2025-04-02", 1200)]
        d0 = reconcile(images, texts, self.OCR)
        dx = reconcile(images, second, self.OCR)
        merged, matched = merge_second_reader(d0, dx)
        assert matched == {0}
        assert not merged[1].matched

        result = assign_review_amounts(images, texts, second, d0, dx, self.OCR, [1])

        assert result == {}

    def test_first_item_matched_by_text_leaves_the_second_without_m(self):
        """§11.2 (b): 1 つ目が文字からで自動・2 つ目がもう 1 人の日付だけ → M なし。"""
        images = [_item("2025-04-02", 1200), _item("2025-04-03", 1200)]
        texts = [_item("2025-04-02", 1200)]
        second = [_item("2025-04-04", 1200)]
        d0 = reconcile(images, texts, self.OCR)
        dx = reconcile(images, second, self.OCR)
        merged, matched = merge_second_reader(d0, dx)
        assert matched == set()
        assert merged[0].matched
        assert d0[1].label == LABEL_AMOUNT
        assert dx[1].label == LABEL_DATE

        result = assign_review_amounts(images, texts, second, d0, dx, self.OCR, [1])

        assert result == {}

    def test_both_items_date_only_on_both_sides_write_none(self):
        """§11.2 (c): 2 つとも両方の読み手と日付だけ → 2 つとも M なし。"""
        images = [_item("2025-04-02", 1200), _item("2025-04-03", 1200)]
        texts = [_item("2025-04-04", 1200)]
        second = [_item("2025-04-05", 1200)]
        d0 = reconcile(images, texts, self.OCR)
        dx = reconcile(images, second, self.OCR)
        assert [decision.label for decision in d0] == [LABEL_DATE, LABEL_DATE]
        assert [decision.label for decision in dx] == [LABEL_DATE, LABEL_DATE]

        result = assign_review_amounts(images, texts, second, d0, dx, self.OCR, [0, 1])

        assert result == {}

    def test_text_side_with_two_of_the_same_amount_writes_both(self):
        """§11.2: 文字からが 2 枚見ていれば、日付だけの 2 つとも M。"""
        images = [_item("2025-04-02", 1200), _item("2025-04-03", 1200)]
        texts = [_item("2025-04-04", 1200), _item("2025-04-05", 1200)]
        second = [_item("2025-04-06", 1200)]
        d0 = reconcile(images, texts, self.OCR)
        dx = reconcile(images, second, self.OCR)
        assert [decision.label for decision in d0] == [LABEL_DATE, LABEL_DATE]

        result = assign_review_amounts(images, texts, second, d0, dx, self.OCR, [0, 1])

        assert result == {0: 1200, 1: 1200}

    def test_second_side_with_two_of_the_same_amount_writes_both(self):
        """§11.2: もう 1 人が 2 枚見ていれば、日付だけの 2 つとも M。"""
        images = [_item("2025-04-02", 1200), _item("2025-04-03", 1200)]
        texts = [_item("2025-04-04", 1200)]
        second = [_item("2025-04-05", 1200), _item("2025-04-06", 1200)]
        d0 = reconcile(images, texts, self.OCR)
        dx = reconcile(images, second, self.OCR)
        assert [decision.label for decision in d0] == [LABEL_DATE, LABEL_DATE]
        assert [decision.label for decision in dx] == [LABEL_DATE, LABEL_DATE]

        result = assign_review_amounts(images, texts, second, d0, dx, self.OCR, [0, 1])

        assert result == {0: 1200, 1: 1200}

    def test_none_and_mismatched_lengths_fall_back_to_not_writing(self):
        image = _item("2025-04-02", 1200)
        text = _item("2025-04-03", 1200)
        d0 = [ItemDecision(False, LABEL_DATE, "日付が食い違う", None)]

        assert assign_review_amounts([image], [text], [], None, None, self.OCR, [0]) == {}
        assert assign_review_amounts([image], [text], [], d0, None, self.OCR, [0]) == {0: 1200}
        # 範囲の外の番号・d0 が短い・images が短い
        assert assign_review_amounts([image], [text], [], d0, None, self.OCR, [1, -1]) == {}
        assert assign_review_amounts([], [text], [], d0, None, self.OCR, [0]) == {}
        # 主の画像からが 2 枚、文字からが 1 枚なので書かない（d0 が短い 1 番目は飛ばす）
        assert assign_review_amounts([image, image], [text], [], d0, None, self.OCR, [0, 1]) == {}


_AMOUNT_STRATEGY = st.one_of(st.none(), st.integers(), st.booleans(), st.text())
_LABEL_STRATEGY = st.sampled_from(
    ["", LABEL_AMOUNT, LABEL_DATE, LABEL_COUNT, LABEL_READ, LABEL_REREAD, "その他"]
)
_DECISION_STRATEGY = st.one_of(
    st.none(),
    st.builds(
        ItemDecision,
        matched=st.booleans(),
        label=_LABEL_STRATEGY,
        reason=st.text(),
        text_index=st.one_of(st.none(), st.integers()),
    ),
)
_IMAGE_ITEM_STRATEGY = st.builds(
    ReceiptItem,
    date=st.one_of(st.none(), st.text()),
    amount=_AMOUNT_STRATEGY,
    is_expense=st.booleans(),
)


@given(
    st.one_of(st.none(), st.integers(), st.text(), _IMAGE_ITEM_STRATEGY),
    _DECISION_STRATEGY,
    _DECISION_STRATEGY,
    st.one_of(st.none(), st.text(), st.integers(), st.floats()),
)
def test_review_amount_never_raises(image_item, d0_decision, dx_decision, ocr_text):
    review_amount(image_item, d0_decision, dx_decision, ocr_text)


@given(_IMAGE_ITEM_STRATEGY, _DECISION_STRATEGY, _DECISION_STRATEGY, st.text())
def test_review_amount_is_the_main_image_amount_or_none(
    image_item, d0_decision, dx_decision, ocr_text
):
    result = review_amount(image_item, d0_decision, dx_decision, ocr_text)

    if result is not None:
        assert isinstance(result, int) and not isinstance(result, bool)
        assert result >= 1
        assert result == image_item.amount


@given(_IMAGE_ITEM_STRATEGY, _DECISION_STRATEGY, _DECISION_STRATEGY, st.text())
def test_review_amount_needs_agreement_and_the_digit_check(
    image_item, d0_decision, dx_decision, ocr_text
):
    result = review_amount(image_item, d0_decision, dx_decision, ocr_text)

    if result is not None:
        labels = {getattr(decision, "label", None) for decision in (d0_decision, dx_decision)}
        assert LABEL_DATE in labels
        assert validate_amount(result, ocr_text).status != "digit_inflation"


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


@given(
    st.lists(
        st.tuples(st.booleans(), st.one_of(st.none(), st.integers(min_value=0, max_value=3))),
        max_size=5,
    ),
    st.lists(st.booleans(), max_size=5),
)
def test_merge_second_reader_matched_indices_are_exact(d0_spec, dx_flags):
    """「もう 1 人で合った番号」は D0 が合わず Dx が合った番号ちょうど。"""
    d0 = [
        ItemDecision(
            flag,
            "" if flag else LABEL_AMOUNT,
            "" if flag else "金額が食い違う",
            text_index,
        )
        for flag, text_index in d0_spec
    ]
    dx = [
        ItemDecision(flag, "" if flag else LABEL_AMOUNT, "" if flag else "金額が食い違う", None)
        for flag in dx_flags
    ]

    merged, matched = merge_second_reader(d0, dx)

    expected = {
        index
        for index, (flag, _) in enumerate(d0_spec)
        if not flag and index < len(dx_flags) and dx_flags[index]
    }
    assert matched == expected
    for index, (flag, text_index) in enumerate(d0_spec):
        if flag:
            assert merged[index] == d0[index]
            assert merged[index].text_index == text_index
        else:
            assert merged[index].matched == (index in expected)


_ASSIGN_ITEM_STRATEGY = st.builds(
    ReceiptItem,
    date=st.one_of(st.none(), st.text()),
    amount=_AMOUNT_STRATEGY,
    is_expense=st.booleans(),
)
_ASSIGN_ITEMS_STRATEGY = st.lists(_ASSIGN_ITEM_STRATEGY, max_size=5)
_ASSIGN_DECISIONS_STRATEGY = st.lists(_DECISION_STRATEGY, max_size=5)
_ASSIGN_ELIGIBLE_STRATEGY = st.lists(st.integers(min_value=-2, max_value=6), max_size=6)


@given(
    _ASSIGN_ITEMS_STRATEGY,
    _ASSIGN_ITEMS_STRATEGY,
    _ASSIGN_ITEMS_STRATEGY,
    st.one_of(st.none(), _ASSIGN_DECISIONS_STRATEGY),
    st.one_of(st.none(), _ASSIGN_DECISIONS_STRATEGY),
    st.text(),
    _ASSIGN_ELIGIBLE_STRATEGY,
)
def test_assign_review_amounts_keys_values_and_counts(
    images, texts, seconds, d0, dx, ocr_text, eligible
):
    """鍵は eligible の中だけ・値は主の画像からの金額・裏付けた枚数を超えない。"""
    result = assign_review_amounts(images, texts, seconds, d0, dx, ocr_text, eligible)

    assert set(result) <= set(eligible)
    image_count = _amount_counts(images)
    text_count = _amount_counts(texts)
    second_count = _amount_counts(seconds) if dx is not None else Counter()
    d0_list = list(d0 or [])
    dx_list = list(dx or [])
    for index, amount in result.items():
        assert 0 <= index < len(images)
        assert amount == images[index].amount
        dx_decision = dx_list[index] if index < len(dx_list) else None
        assert review_amount(images[index], d0_list[index], dx_decision, ocr_text) is not None
        by_text = (
            getattr(d0_list[index], "label", "") == LABEL_DATE
            and image_count[amount] <= text_count[amount]
        )
        by_second = (
            dx_decision is not None
            and getattr(dx_decision, "label", "") == LABEL_DATE
            and image_count[amount] <= second_count[amount]
        )
        assert by_text or by_second


_REAL_DATES = ["2025-04-02", "2025-04-03", "2025-04-04"]
_REAL_AMOUNTS = [1200, 900, 300]
_REAL_OCR_TEXT = "合計 ¥1,200 と ¥900 と ¥300"
_REAL_ITEM_STRATEGY = st.builds(
    ReceiptItem,
    date=st.sampled_from(_REAL_DATES),
    amount=st.sampled_from(_REAL_AMOUNTS),
    vendor=st.just("テスト店"),
    description=st.just("テスト摘要"),
    account=st.just("雑費"),
    tax_category=st.just("課税仕入10%"),
    confidence=st.just(0.9),
    is_expense=st.just(True),
)


@given(
    st.lists(_REAL_ITEM_STRATEGY, max_size=3),
    st.lists(_REAL_ITEM_STRATEGY, max_size=3),
    st.lists(_REAL_ITEM_STRATEGY, max_size=3),
)
def test_assign_review_amounts_real_decisions_stay_within_the_readers(images, texts, seconds):
    """reconcile と merge_second_reader の本物の判定でも、裏付けた枚数を超えない。"""
    d0 = reconcile(images, texts, _REAL_OCR_TEXT)
    dx = reconcile(images, seconds, _REAL_OCR_TEXT)
    merged, _ = merge_second_reader(d0, dx)
    eligible = [index for index, decision in enumerate(merged) if not decision.matched]

    result = assign_review_amounts(images, texts, seconds, d0, dx, _REAL_OCR_TEXT, eligible)

    image_count = _amount_counts(images)
    text_count = _amount_counts(texts)
    second_count = _amount_counts(seconds)
    assert set(result) <= set(eligible)
    for index, amount in result.items():
        assert amount == images[index].amount
        dx_decision = dx[index] if index < len(dx) else None
        assert review_amount(images[index], d0[index], dx_decision, _REAL_OCR_TEXT) is not None
        assert (d0[index].label == LABEL_DATE and image_count[amount] <= text_count[amount]) or (
            dx_decision is not None
            and dx_decision.label == LABEL_DATE
            and image_count[amount] <= second_count[amount]
        )

    for amount in set(result.values()):
        assert image_count[amount] <= max(text_count[amount], second_count[amount])


_MESSY_ASSIGN_LIST_STRATEGY = st.lists(
    st.one_of(
        st.none(),
        st.integers(),
        st.text(),
        _ASSIGN_ITEM_STRATEGY,
        _DECISION_STRATEGY,
        st.lists(st.integers(), max_size=2),
    ),
    max_size=4,
)


@given(
    st.one_of(st.none(), _MESSY_ASSIGN_LIST_STRATEGY),
    st.one_of(st.none(), _MESSY_ASSIGN_LIST_STRATEGY),
    st.one_of(st.none(), _MESSY_ASSIGN_LIST_STRATEGY),
    st.one_of(st.none(), _MESSY_ASSIGN_LIST_STRATEGY),
    st.one_of(st.none(), _MESSY_ASSIGN_LIST_STRATEGY),
    st.one_of(st.none(), st.text(), st.integers(), st.floats(allow_nan=True)),
    st.one_of(
        st.none(),
        st.lists(st.one_of(st.none(), st.integers(), st.text()), max_size=4),
    ),
)
def test_assign_review_amounts_never_raises(images, texts, seconds, d0, dx, ocr_text, eligible):
    """どんな入力（None・長さの違い・型違い）でも例外を投げない。"""
    assign_review_amounts(images, texts, seconds, d0, dx, ocr_text, eligible)

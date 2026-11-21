"""値のそろえ方と一致の判定（仕様 §7）のテスト"""

import pytest

from src.compare.normalize import (
    FIELD_AMOUNT,
    FIELD_DATE,
    FIELD_TAX,
    FIELD_VENDOR,
    extract_amount,
    extract_date,
    extract_tax,
    extract_vendor,
    field_values_agree,
    normalize_date,
    normalize_tax,
    normalize_vendor,
    parse_amount_cell,
    parse_tax_cell,
    value_matches_answer,
    vendor_matches,
)
from src.models import ReceiptItem


class TestDate:
    def test_each_written_form(self):
        assert normalize_date("2026-01-02") == "2026-01-02"
        assert normalize_date("2026/1/2") == "2026-01-02"
        assert normalize_date("2026/01/02") == "2026-01-02"
        assert normalize_date("2026.1.2") == "2026-01-02"
        assert normalize_date("2026年1月2日") == "2026-01-02"

    def test_invalid_real_date_is_kept(self):
        assert normalize_date("2026-02-30") == "2026-02-30"
        assert normalize_date(" 2026/13/1 ") == "2026/13/1"

    def test_unknown_is_kept_stripped(self):
        assert normalize_date(" 不明 ") == "不明"
        assert normalize_date(None) == ""

    def test_file_date_joins_distinct_values(self):
        items = [
            ReceiptItem(date="2026/1/2"),
            ReceiptItem(date="2026-01-02"),
            ReceiptItem(date="2026.1.3"),
            ReceiptItem(date=None),
        ]
        assert extract_date(items) == "2026-01-02・2026-01-03"


class TestAmount:
    def test_sum_and_none(self):
        assert extract_amount([ReceiptItem(amount=100), ReceiptItem(amount=200)]) == 300
        assert extract_amount([ReceiptItem(amount=None), ReceiptItem(amount=200)]) is None
        assert extract_amount([]) is None

    def test_table_cell(self):
        assert parse_amount_cell("¥1,234") == 1234
        assert parse_amount_cell("￥ 1 234 円") == 1234
        assert parse_amount_cell("1234.0") == 1234
        assert parse_amount_cell(1234) == 1234
        assert parse_amount_cell("") is None
        assert parse_amount_cell("abc") is None

    @pytest.mark.parametrize("value", ["inf", "Infinity", "1e999"])
    def test_infinite_values_are_not_amounts(self, value):
        # OverflowError は「金額なし」（ほかの読めない文字と同じ。§12.3）
        assert parse_amount_cell(value) is None


class TestTax:
    @pytest.mark.parametrize(
        "value, expected",
        [
            ("課税仕入10%", "10%"),
            ("課税仕入8%（軽減）", "8%"),
            ("8%・10%", "8%・10%"),
            ("非課税", "非課税"),
            ("不課税", "対象外"),
            ("対象外", "対象外"),
            ("", ""),
            (None, ""),
            ("よくわからない", "不明"),
        ],
    )
    def test_normalize_tax(self, value, expected):
        assert "・".join(normalize_tax(value)) == expected

    def test_file_tax_canonical_order(self):
        items = [
            ReceiptItem(tax_category="課税仕入10%"),
            ReceiptItem(tax_category="課税仕入8%（軽減）"),
            ReceiptItem(tax_category="10%"),
            ReceiptItem(tax_category=None),
        ]
        assert extract_tax(items) == "8%・10%"

    def test_table_cell(self):
        assert parse_tax_cell("8%・10%") == ["8%", "10%"]
        assert parse_tax_cell("10") == ["10%"]
        assert parse_tax_cell("8%,10%") == ["8%", "10%"]
        assert parse_tax_cell("") == []


class TestVendor:
    def test_normalize_removes_corporate_form_and_symbols(self):
        assert normalize_vendor("株式会社 テスト商店") == "テスト商店"
        assert normalize_vendor("㈱テスト・ストア") == "テストストア"
        assert normalize_vendor("テスト商店（新宿店）") == "テスト商店新宿店"

    def test_matches(self):
        assert vendor_matches("株式会社テスト商店", "テスト商店")
        assert vendor_matches("テスト商店 新宿支店", "テスト商店")
        assert not vendor_matches("テスト店", "店")
        assert not vendor_matches("", "テスト商店")
        assert not vendor_matches("テスト商店", "別の商店")

    def test_file_vendor_is_first_item_as_is(self):
        items = [ReceiptItem(vendor=None), ReceiptItem(vendor="テスト商店")]
        assert extract_vendor(items) == ""
        assert extract_vendor([ReceiptItem(vendor="テスト商店")]) == "テスト商店"


class TestAgreement:
    def test_needs_two_rows(self):
        assert not field_values_agree(FIELD_DATE, ["2026-01-01"])

    def test_date_amount_tax_must_all_be_present_and_equal(self):
        assert field_values_agree(FIELD_DATE, ["2026/1/1", "2026-01-01"])
        assert not field_values_agree(FIELD_DATE, ["2026-01-01", ""])
        assert field_values_agree(FIELD_AMOUNT, ["1,600", 1600])
        assert not field_values_agree(FIELD_AMOUNT, [None, 1600])
        assert field_values_agree(FIELD_TAX, ["8%・10%", "10%・8%"])
        assert not field_values_agree(FIELD_TAX, ["", "8%"])

    def test_vendor_pairs(self):
        assert field_values_agree(FIELD_VENDOR, ["株式会社テスト商店", "テスト商店 新宿支店"])
        assert not field_values_agree(FIELD_VENDOR, ["テスト店", "店"])

    def test_answer_match(self):
        assert value_matches_answer(FIELD_DATE, "2026/1/1", "2026-01-01")
        assert value_matches_answer(FIELD_AMOUNT, "¥1,600", 1600)
        assert value_matches_answer(FIELD_TAX, "課税仕入10%", "10%")
        assert value_matches_answer(FIELD_VENDOR, "株式会社テスト商店", "テスト商店")
        assert not value_matches_answer(FIELD_AMOUNT, "", 1600)

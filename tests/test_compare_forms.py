"""「形」の計算（仕様 spec_reader_compare §8・§9）のテスト。"""

import json

from hypothesis import given
from hypothesis import strategies as st

from src.compare import forms
from src.compare.forms import (
    FORM_A2,
    FORM_B,
    FORM_CURRENT,
    GRADE_CORRECT,
    GRADE_NO_ANSWER,
    GRADE_REVIEW,
    GRADE_WRONG,
    build_form_tables,
)
from src.processing.reconcile import ItemDecision

BASE = "gemini-base"
READER = "claude-reader"
OCR_TEXT = "テスト商店 合計 1,600円"


def _items(*pairs, **extra):
    entries = []
    for date, amount in pairs:
        entry = {"d": date, "a": amount}
        entry.update(extra)
        entries.append(entry)
    return entries


def _row(
    file_id,
    label,
    method,
    items,
    *,
    result="成功",
    cost="0.001000",
    name="a.jpg",
    folder="テスト用フォルダ",
    r_flags=None,
):
    payload = []
    for index, entry in enumerate(items):
        copied = dict(entry)
        if r_flags is not None:
            copied["r"] = r_flags[index]
        payload.append(copied)
    return {
        "fileId": file_id,
        "ファイル名": name,
        "フォルダ": folder,
        "型": label,
        "方式": method,
        "結果": result,
        "推定費用USD": cost,
        "明細JSON": json.dumps(payload, ensure_ascii=False),
    }


def _answer(file_id, date="2026-01-02", amount=1600):
    return {"fileId": file_id, "正解_日付": date, "正解_金額": amount}


def _base_rows(file_id, image, text, *, image_result="成功", text_result="成功"):
    return [
        _row(file_id, BASE, "画像から", image, result=image_result, cost="0.010000"),
        _row(file_id, BASE, "文字から", text, result=text_result, cost="0.020000"),
    ]


def _ocr(file_id, *, page=1, text=OCR_TEXT, page_known=True):
    row = {
        "fileId": file_id,
        "OCR文字": text,
    }
    if page_known:
        row["ページ数"] = page
    return row


def _tables(
    result_rows,
    answer_rows,
    *,
    ocr_rows=None,
    multi_rows=None,
    base=BASE,
    price=0.5,
):
    return build_form_tables(
        result_rows=result_rows,
        ocr_rows=ocr_rows or [],
        answer_rows=answer_rows,
        multi_rows=multi_rows,
        base_label=base,
        ocr_price_per_page=price,
        label="L1",
        now_text="2026-11-20 12:00:00",
    )


def _metric(tables, form, reader=None):
    header = tables.summary_rows[4]
    for row in tables.summary_rows[5:]:
        record = dict(zip(header, row, strict=True))
        if record["形"] == form and (reader is None or record["もう1人の読み手"] == reader):
            return record
    raise AssertionError((form, reader))


def _detail(tables, form, reader=None, file_id="F1"):
    header = tables.detail_rows[0]
    for row in tables.detail_rows[1:]:
        record = dict(zip(header, row, strict=True))
        if record["fileId"] == file_id and record["形"] == form:
            if reader is None or record["もう1人の読み手"] == reader:
                return record
    raise AssertionError((form, reader, file_id))


class TestCurrent:
    def test_all_match_is_correct(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1600)))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        metric = _metric(tables, FORM_CURRENT)
        assert metric["正しく自動"] == "1/1 (100.0%)"
        assert metric["明細の数"] == 1
        assert metric["自動の明細"] == "1/1 (100.0%)"

    def test_amount_difference_is_review(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1500)))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        metric = _metric(tables, FORM_CURRENT)
        assert metric["要確認"] == "1/1 (100.0%)"
        assert _detail(tables, FORM_CURRENT)["判定"].startswith("※")

    def test_date_difference_is_review(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-03", 1600)))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        assert _detail(tables, FORM_CURRENT)["成績"] == GRADE_REVIEW

    def test_empty_text_is_review(self):
        rows = _base_rows(
            "F1",
            _items(("2026-01-02", 1600)),
            [],
            text_result="失敗:api_error",
        )
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        assert _detail(tables, FORM_CURRENT)["成績"] == GRADE_REVIEW

    def test_text_more_items_is_review(self):
        rows = _base_rows(
            "F1",
            _items(("2026-01-02", 1600)),
            _items(("2026-01-02", 1600), ("2026-01-02", 500)),
        )
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        assert _detail(tables, FORM_CURRENT)["判定"] == "※明細数要確認"

    def test_empty_image_is_review_with_zero_items(self):
        rows = _base_rows("F1", [], _items(("2026-01-02", 1600)))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        metric = _metric(tables, FORM_CURRENT)
        assert metric["明細の数"] == 0
        assert metric["要確認"] == "1/1 (100.0%)"

    def test_digit_inflation_is_review(self):
        rows = _base_rows("F1", _items(("2026-01-02", 41600)), _items(("2026-01-02", 41600)))
        tables = _tables(rows, [_answer("F1", amount=41600)], ocr_rows=[_ocr("F1")])
        assert _detail(tables, FORM_CURRENT)["判定"] == "※金額要確認"

    def test_same_date_and_amount_twice_both_match(self):
        rows = _base_rows(
            "F1",
            _items(("2026-01-02", 500), ("2026-01-02", 500)),
            _items(("2026-01-02", 500), ("2026-01-02", 500)),
        )
        multi = [
            {"fileId": "F1", "番号": "1", "正解_日付": "2026-01-02", "正解_金額": "500"},
            {"fileId": "F1", "番号": "2", "正解_日付": "2026-01-02", "正解_金額": "500"},
        ]
        tables = _tables(rows, [], multi_rows=multi, ocr_rows=[_ocr("F1")])
        assert _detail(tables, FORM_CURRENT)["成績"] == GRADE_CORRECT


class TestA2:
    def test_matches_without_ocr_text(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-03", 900)))
        rows.append(_row("F1", READER, "画像から", _items(("2026-01-02", 1600))))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        assert _metric(tables, FORM_A2, READER)["正しく自動"] == "1/1 (100.0%)"

    def test_ocr_text_is_not_passed(self):
        # 画像からも文字からも 41600 だが、OCR には 1600 がある（桁の疑い）。
        # A2 は Vision を使わないので、その疑いを当てない。
        rows = _base_rows("F1", _items(("2026-01-02", 41600)), _items(("2026-01-02", 41600)))
        rows.append(_row("F1", READER, "画像から", _items(("2026-01-02", 41600))))
        tables = _tables(rows, [_answer("F1", amount=41600)], ocr_rows=[_ocr("F1")])
        assert _detail(tables, FORM_A2, READER)["成績"] == GRADE_CORRECT

    def test_reader_empty_is_review(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1600)))
        rows.append(_row("F1", READER, "画像から", [], result="失敗:api_error"))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        assert _detail(tables, FORM_A2, READER)["成績"] == GRADE_REVIEW

    def test_reader_more_items_is_review(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1600)))
        rows.append(
            _row(
                "F1",
                READER,
                "画像から",
                _items(("2026-01-02", 1600), ("2026-01-02", 500)),
            )
        )
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        assert _detail(tables, FORM_A2, READER)["判定"] == "※明細数要確認"

    def test_missing_reader_row_is_excluded_and_noted(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1600)))
        rows.append(_row("F2", READER, "画像から", _items(("2026-01-02", 1600))))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        metric = _metric(tables, FORM_A2, READER)
        assert metric["ファイル数"] == 0
        assert "もう1人の読みが無いファイル 1" in metric["注"]


class TestB:
    def test_not_called_file_keeps_current_result_and_cost(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1600)))
        # 読み手は違う金額でも、呼ばないので B は今（両読み）と同じく正しい
        rows.append(_row("F1", READER, "画像から", _items(("2026-01-02", 999))))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1", page=2)])
        metric = _metric(tables, FORM_B, READER)
        assert metric["正しく自動"] == "1/1 (100.0%)"
        assert metric["もう1人を呼んだ本数"] == 0
        # 今（両読み）= 0.01 + 0.02 + 2 × 0.5。X の分は足さない
        assert metric["推定費用USD"] == f"{0.010 + 0.020 + 1.0:.6f}"

    def test_called_file_matches_with_the_other_reader(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1500)))
        rows.append(_row("F1", READER, "画像から", _items(("2026-01-02", 1600)), cost="0.030000"))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        metric = _metric(tables, FORM_B, READER)
        assert metric["もう1人を呼んだ本数"] == 1
        assert metric["正しく自動"] == "1/1 (100.0%)"
        detail = _detail(tables, FORM_B, READER)
        assert detail["呼んだ"] == "はい"
        assert detail["判定"] == "一致（もう1人）"
        assert metric["推定費用USD"] == f"{0.01 + 0.02 + 0.5 + 0.03:.6f}"

    def test_called_file_but_reader_disagrees_is_review(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1500)))
        rows.append(_row("F1", READER, "画像から", _items(("2026-01-02", 900))))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        assert _detail(tables, FORM_B, READER)["成績"] == GRADE_REVIEW

    def test_count_mismatch_can_be_matched_by_the_other_reader(self):
        rows = _base_rows(
            "F1",
            _items(("2026-01-02", 1600)),
            _items(("2026-01-02", 1600), ("2026-01-02", 500)),
        )
        rows.append(_row("F1", READER, "画像から", _items(("2026-01-02", 1600))))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        assert _detail(tables, FORM_B, READER)["成績"] == GRADE_CORRECT

    def test_called_file_keeps_d0_matches_even_if_the_reader_disagrees(self):
        rows = _base_rows(
            "F1",
            _items(("2026-01-02", 1600), ("2026-01-02", 500)),
            _items(("2026-01-02", 1600), ("2026-01-02", 700)),
        )
        # 呼ぶファイル。D0 で 1600 は合い、500 は食い違う。もう 1 人は両方外す
        rows.append(
            _row("F1", READER, "画像から", _items(("2026-01-02", 900), ("2026-01-02", 800)))
        )
        multi = [
            {"fileId": "F1", "番号": "1", "正解_日付": "2026-01-02", "正解_金額": "1600"},
            {"fileId": "F1", "番号": "2", "正解_日付": "2026-01-02", "正解_金額": "500"},
        ]
        tables = _tables(rows, [], multi_rows=multi, ocr_rows=[_ocr("F1")])
        detail = _detail(tables, FORM_B, READER)
        assert detail["呼んだ"] == "はい"
        assert detail["自動の明細"] == 1

    def test_d0_match_keeps_the_plain_label(self):
        rows = _base_rows(
            "F1",
            _items(("2026-01-02", 1600), ("2026-01-02", 500)),
            _items(("2026-01-02", 1600), ("2026-01-02", 700)),
        )
        rows.append(
            _row("F1", READER, "画像から", _items(("2026-01-02", 1600), ("2026-01-02", 500)))
        )
        multi = [
            {"fileId": "F1", "番号": "1", "正解_日付": "2026-01-02", "正解_金額": "1600"},
            {"fileId": "F1", "番号": "2", "正解_日付": "2026-01-02", "正解_金額": "500"},
        ]
        tables = _tables(rows, [], multi_rows=multi, ocr_rows=[_ocr("F1")])
        detail = _detail(tables, FORM_B, READER)
        # D0 で合っていた 1600 は `一致`、D0 が合わず Dx が合った 500 だけ `一致（もう1人）`
        assert detail["判定"] == "一致・一致（もう1人）"
        assert detail["自動の明細"] == 2

    def test_auto_of_b_includes_auto_of_current(self):
        rows = _base_rows(
            "F1",
            _items(("2026-01-02", 1600), ("2026-01-02", 500)),
            _items(("2026-01-02", 1600), ("2026-01-02", 700)),
        )
        rows.append(
            _row("F1", READER, "画像から", _items(("2026-01-02", 1600), ("2026-01-02", 500)))
        )
        tables = _tables(
            rows,
            [_answer("F1", amount=1600), _answer("F1", amount=500)],
            ocr_rows=[_ocr("F1")],
        )
        current = _detail(tables, FORM_CURRENT)
        b = _detail(tables, FORM_B, READER)
        assert current["自動の明細"] == 1
        assert b["自動の明細"] == 2


class TestGrade:
    def test_grades_do_not_overlap_and_no_answer_is_separate(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1600)))
        rows += _base_rows("F2", _items(("2026-01-02", 700)), _items(("2026-01-02", 800)))
        rows += _base_rows("F3", _items(("2026-01-02", 900)), _items(("2026-01-02", 900)))
        answers = [_answer("F1"), _answer("F2")]
        tables = _tables(rows, answers, ocr_rows=[_ocr("F1"), _ocr("F2"), _ocr("F3")])
        metric = _metric(tables, FORM_CURRENT)
        assert metric["正しく自動"] == "1/2 (50.0%)"
        assert metric["要確認"] == "1/2 (50.0%)"
        assert metric["ファイル数"] == 3
        assert _detail(tables, FORM_CURRENT, file_id="F3")["成績"] == GRADE_NO_ANSWER

    def test_wrong_auto_when_an_auto_item_matches_no_answer(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1600)))
        tables = _tables(rows, [_answer("F1", amount=999)], ocr_rows=[_ocr("F1")])
        assert _detail(tables, FORM_CURRENT)["成績"] == GRADE_WRONG

    def test_wrong_auto_when_fewer_items_than_answers(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1600)))
        answers = [_answer("F1"), _answer("F1", amount=500)]
        tables = _tables(rows, answers, ocr_rows=[_ocr("F1")])
        assert _detail(tables, FORM_CURRENT)["成績"] == GRADE_WRONG


class TestMultiAnswers:
    def test_multi_answers_are_used(self):
        rows = _base_rows(
            "F1",
            _items(("2026-01-02", 1600), ("2026-01-02", 500)),
            _items(("2026-01-02", 1600), ("2026-01-02", 500)),
        )
        multi = [
            {"fileId": "F1", "番号": "1", "正解_日付": "2026-01-02", "正解_金額": "1600"},
            {"fileId": "F1", "番号": "2", "正解_日付": "2026-01-02", "正解_金額": "500"},
        ]
        tables = _tables(rows, [], multi_rows=multi, ocr_rows=[_ocr("F1")])
        assert _detail(tables, FORM_CURRENT)["成績"] == GRADE_CORRECT
        assert _detail(tables, FORM_CURRENT)["答え"] == "2026-01-02/1600, 2026-01-02/500"


class TestCosts:
    def test_costs_and_vision_pages(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1000)))
        rows.append(_row("F1", READER, "画像から", _items(("2026-01-02", 1600)), cost="0.030000"))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1", page=3)])
        current = _metric(tables, FORM_CURRENT)
        a2 = _metric(tables, FORM_A2, READER)
        b = _metric(tables, FORM_B, READER)
        assert current["推定費用USD"] == f"{0.01 + 0.02 + 1.5:.6f}"
        assert a2["推定費用USD"] == f"{0.01 + 0.03:.6f}"
        assert b["推定費用USD"] == f"{0.01 + 0.02 + 1.5 + 0.03:.6f}"
        assert current["1本あたりUSD"] == current["推定費用USD"]

    def test_missing_cost_counts_zero_and_is_noted(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1600)))
        for row in rows:
            row["推定費用USD"] = ""
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1", page=1)])
        current = _metric(tables, FORM_CURRENT)
        assert current["推定費用USD"] == f"{0.5:.6f}"

    def test_old_ocr_tab_without_page_count_is_one_page(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1600)))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1", page_known=False)], price=0.5)
        metric = _metric(tables, FORM_CURRENT)
        assert "ページ数の無い古いOCRタブ 1" in metric["注"]


class TestSharedGrading:
    def test_forms_use_the_shared_assign_auto(self, monkeypatch):
        monkeypatch.setattr(forms, "assign_auto", lambda auto, expected: False)
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1600)))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        assert _detail(tables, FORM_CURRENT)["成績"] == GRADE_WRONG


class TestDualMismatch:
    def test_saved_dual_difference_is_noted(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1600)))
        rows.append(
            _row(
                "F1",
                BASE,
                "両読み",
                _items(("2026-01-02", 1600)),
                r_flags=["要確認"],
            )
        )
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        assert "両読みの保存と違うファイル 1" in _metric(tables, FORM_CURRENT)["注"]


class TestMissingRows:
    def test_file_without_an_ocr_row_uses_zero_pages_and_is_noted(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1600)))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[], price=0.5)
        metric = _metric(tables, FORM_CURRENT)
        assert "OCR の行が無いファイル 1" in metric["注"]
        assert "ページ数の無い古いOCRタブ" not in metric["注"]
        assert metric["推定費用USD"] == f"{0.01 + 0.02:.6f}"

    def test_empty_saved_dual_is_noted_as_uncomparable(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1600)))
        dual = _row("F1", BASE, "両読み", _items(("2026-01-02", 1600)))
        dual["明細JSON"] = ""
        rows.append(dual)
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        note = _metric(tables, FORM_CURRENT)["注"]
        assert "両読みの保存と比べられないファイル 1" in note
        assert "両読みの保存と違うファイル" not in note

    def test_saved_dual_with_a_different_item_count_is_noted_as_uncomparable(self):
        rows = _base_rows(
            "F1",
            _items(("2026-01-02", 1600), ("2026-01-02", 500)),
            _items(("2026-01-02", 1600), ("2026-01-02", 500)),
        )
        rows.append(
            _row(
                "F1",
                BASE,
                "両読み",
                _items(("2026-01-02", 1600)),
                r_flags=["自動"],
            )
        )
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        note = _metric(tables, FORM_CURRENT)["注"]
        assert "両読みの保存と比べられないファイル 1" in note
        assert "両読みの保存と違うファイル" not in note


class TestNoForms:
    def test_no_base_label_returns_none(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1600)))
        assert _tables(rows, [_answer("F1")], base=None) is None

    def test_missing_base_rows_returns_none(self):
        rows = [_row("F1", READER, "画像から", _items(("2026-01-02", 1600)))]
        assert _tables(rows, [_answer("F1")]) is None

    def test_only_current_when_no_reader(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1600)))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        assert [metric.name for metric in tables.metrics] == [FORM_CURRENT]
        assert tables.readers == []


class TestR7Reconcile:
    def test_forms_use_reconcile(self, monkeypatch):
        def fake_reconcile(image_items, text_items, ocr_text):
            return [ItemDecision(True, "", "", 0) for _ in image_items]

        monkeypatch.setattr(forms, "reconcile", fake_reconcile)
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-03", 900)))
        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        assert _detail(tables, FORM_CURRENT)["成績"] == GRADE_CORRECT


class TestSharedSecondReader:
    def test_b_uses_the_shared_needs_function(self, monkeypatch):
        monkeypatch.setattr(forms, "needs_second_reader", lambda items, decisions: False)
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1500)))
        rows.append(_row("F1", READER, "画像から", _items(("2026-01-02", 1600))))

        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])

        detail = _detail(tables, FORM_B, READER)
        assert detail["呼んだ"] == "いいえ"
        assert detail["成績"] == GRADE_REVIEW

    def test_b_uses_the_shared_merge_function(self, monkeypatch):
        def fake_merge(d0, dx):
            return [ItemDecision(True, "", "", None) for _ in d0], set(range(len(d0)))

        monkeypatch.setattr(forms, "merge_second_reader", fake_merge)
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1500)))
        rows.append(_row("F1", READER, "画像から", _items(("2026-01-02", 999))))

        tables = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])

        detail = _detail(tables, FORM_B, READER)
        assert detail["呼んだ"] == "はい"
        assert detail["判定"] == "一致（もう1人）"
        assert detail["成績"] == GRADE_CORRECT


@st.composite
def _readings(draw):
    size = draw(st.integers(min_value=0, max_value=3))
    images = [
        draw(
            st.tuples(
                st.sampled_from(["2026-01-02", "2026-01-03"]),
                st.sampled_from([500, 1600]),
            )
        )
        for _ in range(size)
    ]
    texts = [
        draw(
            st.tuples(
                st.sampled_from(["2026-01-02", "2026-01-03"]),
                st.sampled_from([500, 1600]),
            )
        )
        for _ in range(draw(st.integers(min_value=0, max_value=3)))
    ]
    others = [
        draw(
            st.tuples(
                st.sampled_from(["2026-01-02", "2026-01-03"]),
                st.sampled_from([500, 1600]),
            )
        )
        for _ in range(draw(st.integers(min_value=0, max_value=3)))
    ]
    return images, texts, others


class TestProperties:
    @given(_readings())
    def test_b_auto_includes_current_auto_and_length_is_image_length(self, reading):
        images, texts, others = reading
        rows = _base_rows(
            "F1",
            _items(*images),
            _items(*texts),
        )
        rows.append(_row("F1", READER, "画像から", _items(*others)))
        answers = [_answer("F1", date=date, amount=amount) for date, amount in images] or [
            _answer("F1")
        ]
        tables = _tables(rows, answers, ocr_rows=[_ocr("F1")])
        current = next(result for result in tables.file_results if result.form == FORM_CURRENT)
        b = next(result for result in tables.file_results if result.form == FORM_B)
        assert len(b.flags) == len(images) == len(current.flags)
        assert all(
            (not base_flag) or b_flag
            for base_flag, b_flag in zip(current.flags, b.flags, strict=True)
        )

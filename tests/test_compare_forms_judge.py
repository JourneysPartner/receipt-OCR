"""形 C（仕様 spec_judge_form §7）のテスト。"""

import json

import pytest
from hypothesis import given
from hypothesis import strategies as st

from src.compare.forms import (
    FORM_A2,
    FORM_B,
    FORM_C,
    FORM_CURRENT,
    GRADE_CORRECT,
    GRADE_REVIEW,
    build_form_tables,
)

BASE = "gemini-base"
READER = "claude-reader"
JUDGE = "gemini-decision-1"
OCR_TEXT = "テスト商店 合計 1,600円"


def _items(*pairs):
    return [{"d": date, "a": amount} for date, amount in pairs]


def _row(file_id, label, method, items, *, result="成功", cost="0.001000", name="a.jpg"):
    return {
        "fileId": file_id,
        "ファイル名": name,
        "フォルダ": "テスト用フォルダ",
        "型": label,
        "方式": method,
        "結果": result,
        "推定費用USD": cost,
        "明細JSON": json.dumps(items, ensure_ascii=False),
    }


def _answer(file_id, date="2026-01-02", amount=1600):
    return {"fileId": file_id, "正解_日付": date, "正解_金額": amount}


def _base_rows(file_id, image, text):
    return [
        _row(file_id, BASE, "画像から", image, cost="0.010000"),
        _row(file_id, BASE, "文字から", text, cost="0.020000"),
    ]


def _ocr(file_id, *, page=1, text=OCR_TEXT):
    return {"fileId": file_id, "OCR文字": text, "ページ数": page}


def _judge_row(file_id, base, items, *, result="成功", count=None, cost="0.030000", judge=JUDGE):
    data = {"judge": 1, "base": base, "items": items}
    if count is not None:
        data["count"] = count
    return {
        "fileId": file_id,
        "ファイル名": "a.jpg",
        "フォルダ": "テスト用フォルダ",
        "型": judge,
        "方式": "審判",
        "結果": result,
        "推定費用USD": cost,
        "明細JSON": json.dumps(data, ensure_ascii=False),
    }


def _judge_item(index=0, amount="1600", date="2026-01-02", confidence=0.95, **changes):
    item = {
        "i": index,
        "a": {
            "options": ["1600", "1500", "other"],
            "choice": amount,
            "confidence": confidence,
        },
        "d": {
            "options": ["2026-01-02", "2026-01-03", "other"],
            "choice": date,
            "confidence": confidence,
        },
    }
    item.update(changes)
    return item


def _tables(
    result_rows,
    answer_rows,
    *,
    ocr_rows=None,
    thresholds=(0.90,),
    base=BASE,
    price=0.5,
):
    return build_form_tables(
        result_rows=result_rows,
        ocr_rows=ocr_rows or [],
        answer_rows=answer_rows,
        multi_rows=None,
        base_label=base,
        ocr_price_per_page=price,
        label="L1",
        now_text="2026-11-21 12:00:00",
        judge_thresholds=thresholds,
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
        if record["fileId"] != file_id or record["形"] != form:
            continue
        if reader is None or record["もう1人の読み手"] == reader:
            return record
    raise AssertionError((form, reader, file_id))


def _scenario(*, judge_row=None, image=None, text=None, answer=None, thresholds=(0.90,)):
    image = image or _items(("2026-01-02", 1600))
    text = text or _items(("2026-01-02", 1500))
    rows = _base_rows("F1", image, text)
    if judge_row is not None:
        rows.append(judge_row)
    return _tables(
        rows,
        [answer or _answer("F1")],
        ocr_rows=[_ocr("F1")],
        thresholds=thresholds,
    )


class TestFormC:
    def test_judge_makes_a_mismatched_item_auto(self):
        base = [["2026-01-02", 1600]]
        judge = _judge_row("F1", base, [_judge_item()])
        tables = _scenario(judge_row=judge)
        metric = _metric(tables, FORM_C, f"{JUDGE} ≥0.90")
        assert metric["正しく自動"] == "1/1 (100.0%)"
        assert metric["もう1人を呼んだ本数"] == 1
        detail = _detail(tables, FORM_C, f"{JUDGE} ≥0.90")
        assert detail["判定"] == "一致（審判）"
        assert detail["呼んだ"] == "はい"
        assert detail["読み"].startswith("主画像=2026-01-02/1600")
        assert "審判=1:1600(0.95)/2026-01-02(0.95)" in detail["読み"]

    def test_values_stay_the_base_image_reading(self):
        # 審判が別の金額を選んでも、書く値は Ib のまま（J6）
        base = [["2026-01-02", 1600]]
        judge = _judge_row("F1", base, [_judge_item(amount="1500")])
        tables = _scenario(judge_row=judge, image=_items(("2026-01-02", 1600)))
        detail = _detail(tables, FORM_C, f"{JUDGE} ≥0.90")
        assert detail["判定"] == "※金額要確認"
        assert "主画像=2026-01-02/1600" in detail["読み"]
        c = next(result for result in tables.file_results if result.form == FORM_C)
        assert c.file.image_items[0].amount == 1600

    def test_not_called_file_keeps_current_result(self):
        judge = _judge_row("F1", [["2026-01-02", 1600]], [])
        tables = _scenario(judge_row=judge, text=_items(("2026-01-02", 1600)))
        detail = _detail(tables, FORM_C, f"{JUDGE} ≥0.90")
        assert detail["呼んだ"] == "いいえ"
        assert detail["成績"] == GRADE_CORRECT
        assert detail["判定"] == "一致"

    def test_missing_judge_row_is_review_and_noted(self):
        # 別のファイルの審判の行だけがあり、F1 の行が無い
        tables = _scenario(judge_row=_judge_row("F2", [], []))
        metric = _metric(tables, FORM_C, f"{JUDGE} ≥0.90")
        assert metric["要確認"] == "1/1 (100.0%)"
        assert "審判の行が無いファイル 1" in metric["注"]

    def test_failed_judge_row_is_review_and_noted(self):
        judge = _judge_row("F1", [], [], result="失敗:api_error")
        tables = _scenario(judge_row=judge)
        metric = _metric(tables, FORM_C, f"{JUDGE} ≥0.90")
        assert metric["要確認"] == "1/1 (100.0%)"
        assert "審判が失敗したファイル 1（失敗:api_error 1）" in metric["注"]

    def test_bad_response_row_is_review(self):
        judge = _judge_row(
            "F1", [["2026-01-02", 1600]], [_judge_item()], result="失敗:bad_response"
        )
        tables = _scenario(judge_row=judge)
        metric = _metric(tables, FORM_C, f"{JUDGE} ≥0.90")
        assert metric["要確認"] == "1/1 (100.0%)"
        assert "審判が失敗したファイル 1（失敗:bad_response 1）" in metric["注"]

    def test_base_snapshot_mismatch_is_review_and_noted(self):
        judge = _judge_row("F1", [["2026-01-02", 999]], [_judge_item()])
        tables = _scenario(judge_row=judge)
        metric = _metric(tables, FORM_C, f"{JUDGE} ≥0.90")
        assert metric["要確認"] == "1/1 (100.0%)"
        assert "審判に見せた読みと違うファイル 1" in metric["注"]

    def test_missing_item_is_review(self):
        judge = _judge_row("F1", [["2026-01-02", 1600]], [])
        tables = _scenario(judge_row=judge)
        assert _detail(tables, FORM_C, f"{JUDGE} ≥0.90")["成績"] == GRADE_REVIEW

    def test_other_choice_is_review(self):
        judge = _judge_row("F1", [["2026-01-02", 1600]], [_judge_item(amount="other")])
        tables = _scenario(judge_row=judge)
        assert _detail(tables, FORM_C, f"{JUDGE} ≥0.90")["成績"] == GRADE_REVIEW

    def test_choice_outside_the_options_is_review(self):
        entry = _judge_item()
        entry["a"]["choice"] = "999"
        judge = _judge_row("F1", [["2026-01-02", 1600]], [entry])
        tables = _scenario(judge_row=judge)
        assert _detail(tables, FORM_C, f"{JUDGE} ≥0.90")["成績"] == GRADE_REVIEW

    def test_answer_whose_options_lack_the_base_value_is_review(self):
        entry = _judge_item()
        entry["a"]["options"] = ["1500", "other"]
        judge = _judge_row("F1", [["2026-01-02", 1600]], [entry])
        tables = _scenario(judge_row=judge)
        assert _detail(tables, FORM_C, f"{JUDGE} ≥0.90")["成績"] == GRADE_REVIEW

    @pytest.mark.parametrize("raw", ["", "{broken"])
    def test_unreadable_judge_json_is_review_and_noted(self, raw):
        judge = _judge_row("F1", [["2026-01-02", 1600]], [_judge_item()])
        judge["明細JSON"] = raw
        tables = _scenario(judge_row=judge)
        metric = _metric(tables, FORM_C, f"{JUDGE} ≥0.90")
        assert metric["要確認"] == "1/1 (100.0%)"
        assert "審判の行を読めないファイル 1" in metric["注"]

    def test_confidence_below_theta_is_review_and_exact_theta_is_auto(self):
        base = [["2026-01-02", 1600]]
        low = _judge_row("F1", base, [_judge_item(confidence=0.89)])
        tables = _scenario(judge_row=low)
        assert _detail(tables, FORM_C, f"{JUDGE} ≥0.90")["成績"] == GRADE_REVIEW

        exact = _judge_row("F1", base, [_judge_item(confidence=0.90)])
        tables = _scenario(judge_row=exact)
        assert _detail(tables, FORM_C, f"{JUDGE} ≥0.90")["成績"] == GRADE_CORRECT

    def test_null_string_and_nan_confidence_are_review(self):
        base = [["2026-01-02", 1600]]
        for value in (None, "0.95", float("nan"), True):
            entry = _judge_item()
            entry["a"]["confidence"] = value
            judge = _judge_row("F1", base, [entry])
            tables = _scenario(judge_row=judge)
            assert _detail(tables, FORM_C, f"{JUDGE} ≥0.90")["成績"] == GRADE_REVIEW

    def test_amount_only_match_is_not_enough(self):
        entry = _judge_item(date="2026-01-03")
        judge = _judge_row("F1", [["2026-01-02", 1600]], [entry])
        tables = _scenario(judge_row=judge)
        assert _detail(tables, FORM_C, f"{JUDGE} ≥0.90")["成績"] == GRADE_REVIEW

    def test_count_question_is_required_when_text_has_more_items(self):
        image = _items(("2026-01-02", 1600))
        text = _items(("2026-01-02", 1000), ("2026-01-03", 500))
        judge = _judge_row("F1", [["2026-01-02", 1600]], [_judge_item()])
        tables = _scenario(judge_row=judge, image=image, text=text)
        assert _detail(tables, FORM_C, f"{JUDGE} ≥0.90")["成績"] == GRADE_REVIEW

        with_count = _judge_row(
            "F1",
            [["2026-01-02", 1600]],
            [_judge_item()],
            count={"asked": 1, "p": 0.90},
        )
        tables = _scenario(judge_row=with_count, image=image, text=text)
        assert _detail(tables, FORM_C, f"{JUDGE} ≥0.90")["成績"] == GRADE_CORRECT

    def test_count_probability_below_theta_or_wrong_asked_is_review(self):
        image = _items(("2026-01-02", 1600))
        text = _items(("2026-01-02", 1000), ("2026-01-03", 500))
        for count in (
            {"asked": 1, "p": 0.89},
            {"asked": 2, "p": 0.99},
            {"asked": 1, "p": True},
        ):
            judge = _judge_row("F1", [["2026-01-02", 1600]], [_judge_item()], count=count)
            tables = _scenario(judge_row=judge, image=image, text=text)
            assert _detail(tables, FORM_C, f"{JUDGE} ≥0.90")["成績"] == GRADE_REVIEW

    def test_c_auto_includes_current_auto(self):
        image = _items(("2026-01-02", 1600), ("2026-01-02", 500))
        text = _items(("2026-01-02", 1600), ("2026-01-02", 700))
        entry = _judge_item(index=1, amount="500")
        entry["a"]["options"] = ["500", "700", "other"]
        judge = _judge_row(
            "F1",
            [["2026-01-02", 1600], ["2026-01-02", 500]],
            [entry],
        )
        tables = _scenario(
            judge_row=judge,
            image=image,
            text=text,
            answer={"fileId": "F1", "正解_日付": "2026-01-02", "正解_金額": "1600"},
        )
        detail = _detail(tables, FORM_C, f"{JUDGE} ≥0.90")
        assert detail["判定"] == "一致・一致（審判）"
        assert detail["自動の明細"] == 2

    def test_raising_theta_never_adds_auto_items(self):
        base = [["2026-01-02", 1600]]
        judge = _judge_row("F1", base, [_judge_item(confidence=0.92)])
        tables = _scenario(judge_row=judge, thresholds=(0.90, 0.97))
        low = _metric(tables, FORM_C, f"{JUDGE} ≥0.90")
        high = _metric(tables, FORM_C, f"{JUDGE} ≥0.97")
        assert low["自動の明細"] == "1/1 (100.0%)"
        assert int(high["自動の明細"].split("/")[0]) <= int(low["自動の明細"].split("/")[0])

    def test_cost_and_order_of_c_rows(self):
        judge = _judge_row("F1", [["2026-01-02", 1600]], [_judge_item()])
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1500)))
        rows.append(judge)
        tables = _tables(
            rows,
            [_answer("F1")],
            ocr_rows=[_ocr("F1", page=2)],
            thresholds=(0.97, 0.90),
        )
        names = [metric.reader for metric in tables.metrics if metric.name == FORM_C]
        assert names == [f"{JUDGE} ≥0.90", f"{JUDGE} ≥0.97"]
        metric = _metric(tables, FORM_C, f"{JUDGE} ≥0.90")
        # 今 = 0.01 + 0.02 + 2 × 0.5、審判 = 0.03
        assert metric["推定費用USD"] == f"{0.01 + 0.02 + 1.0 + 0.03:.6f}"

    def test_reading_includes_count_probability(self):
        image = _items(("2026-01-02", 1600))
        text = _items(("2026-01-02", 1000), ("2026-01-03", 500))
        judge = _judge_row(
            "F1",
            [["2026-01-02", 1600]],
            [_judge_item()],
            count={"asked": 1, "p": 0.97},
        )
        tables = _scenario(judge_row=judge, image=image, text=text)
        reading = _detail(tables, FORM_C, f"{JUDGE} ≥0.90")["読み"]
        assert "審判=1:1600(0.95)/2026-01-02(0.95), 枚数=0.97" in reading

    def test_c_rows_do_not_change_current_a2_or_b(self):
        rows = _base_rows("F1", _items(("2026-01-02", 1600)), _items(("2026-01-02", 1500)))
        rows.append(_row("F1", READER, "画像から", _items(("2026-01-02", 1600))))
        without = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        rows.append(_judge_row("F1", [["2026-01-02", 1600]], [_judge_item()]))
        with_judge = _tables(rows, [_answer("F1")], ocr_rows=[_ocr("F1")])
        for form, reader in (
            (FORM_CURRENT, None),
            (FORM_A2, READER),
            (FORM_B, READER),
        ):
            assert _metric(with_judge, form, reader) == _metric(without, form, reader)
        assert without.readers == with_judge.readers == [READER]

    def test_more_than_1000_form_detail_rows_are_produced(self):
        rows = []
        answers = []
        for index in range(156):
            file_id = f"FILE_{index:04d}"
            rows += _base_rows(
                file_id,
                _items(("2026-01-02", 1600)),
                _items(("2026-01-02", 1500)),
            )
            rows.append(_judge_row(file_id, [["2026-01-02", 1600]], [_judge_item()]))
            rows.append(
                _judge_row(
                    file_id,
                    [["2026-01-02", 1600]],
                    [_judge_item()],
                    judge="gpt-6-luna",
                )
            )
            answers.append(_answer(file_id))
        tables = _tables(
            rows,
            answers,
            ocr_rows=[],
            thresholds=(0.70, 0.90, 0.97),
        )
        assert len(tables.detail_rows) > 1000


@st.composite
def _readings(draw):
    size = draw(st.integers(min_value=1, max_value=3))
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
    judged = [
        {
            "i": index,
            "a": {
                "options": [str(amount), "other"],
                "choice": draw(st.sampled_from([str(amount), "other"])),
                "confidence": draw(st.sampled_from([0.0, 0.9, 1.0])),
            },
            "d": {
                "options": [date, "other"],
                "choice": draw(st.sampled_from([date, "other"])),
                "confidence": draw(st.sampled_from([0.0, 0.9, 1.0])),
            },
        }
        for index, (date, amount) in enumerate(images)
    ]
    return images, texts, judged


class TestProperties:
    @given(_readings())
    def test_raising_theta_never_adds_auto_items(self, reading):
        images, texts, judged = reading
        rows = _base_rows("F1", _items(*images), _items(*texts))
        rows.append(_judge_row("F1", [[date, amount] for date, amount in images], judged))
        answer = [_answer("F1", date=images[0][0], amount=images[0][1])]
        counts = []
        for theta in (0.0, 0.5, 1.0):
            tables = _tables(
                rows,
                answer,
                ocr_rows=[_ocr("F1")],
                thresholds=(theta,),
            )
            metric = _metric(tables, FORM_C, f"{JUDGE} ≥{theta:.2f}")
            counts.append(int(metric["自動の明細"].split("/")[0]))
        assert counts[0] >= counts[1] >= counts[2]

    @given(_readings())
    def test_c_auto_includes_current_auto_and_length_is_ib(self, reading):
        images, texts, judged = reading
        rows = _base_rows("F1", _items(*images), _items(*texts))
        rows.append(_judge_row("F1", [[date, amount] for date, amount in images], judged))
        tables = _tables(
            rows,
            [_answer("F1", date=images[0][0], amount=images[0][1])],
            ocr_rows=[_ocr("F1")],
        )
        current = next(result for result in tables.file_results if result.form == FORM_CURRENT)
        c = next(result for result in tables.file_results if result.form == FORM_C)
        assert len(c.flags) == len(images)
        assert all(
            (not base_flag) or c_flag
            for base_flag, c_flag in zip(current.flags, c.flags, strict=True)
        )

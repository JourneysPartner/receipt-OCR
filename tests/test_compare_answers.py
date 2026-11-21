"""「答え」タブの更新（仕様 §9）と S6 のテスト"""

from hypothesis import given
from hypothesis import strategies as st

from src.compare.answers import attach_values, build_answer_plan, build_candidates
from src.compare.sheet import ANSWER_HEADERS, cell_range

FILE_A = "FILE_A1234567890"
FILE_B = "FILE_B1234567890"


def _result(
    file_id=FILE_A,
    model="gemini-test",
    method="文字から",
    result="成功",
    date="2026-01-02",
    amount=1600,
    tax="10%",
    vendor="テスト商店",
    finish="STOP",
    validation="ok",
):
    return {
        "fileId": file_id,
        "型": model,
        "方式": method,
        "結果": result,
        "日付": date,
        "合計金額": amount,
        "税率": tax,
        "店名": vendor,
        "終了理由": finish,
        "金額照合": validation,
    }


def _file_infos(*file_ids):
    return [
        {"file_id": file_id, "file_name": f"{file_id}.jpg", "folder_name": "テスト用フォルダ"}
        for file_id in file_ids
    ]


def _answer_row(file_id=FILE_A, row=2, answers=("", "", "", ""), source="", memo=""):
    values = [
        file_id,
        f"https://drive.google.com/file/d/{file_id}/view",
        "テスト用フォルダ",
        f"{file_id}.jpg",
        "",
        answers[0],
        answers[1],
        answers[2],
        answers[3],
        source,
        memo,
        "",
        "",
        "",
        "",
        "",
    ]
    record = dict(zip(ANSWER_HEADERS, values, strict=True))
    record["_row"] = row
    return attach_values([record])[0]


def _columns_in(plan):
    return [update["range"] for update in plan.updates]


class TestNewRow:
    def test_all_matched_fills_answers_and_source(self):
        rows = [
            _result(method="文字から"),
            _result(model="gemini-other", method="画像から"),
        ]
        plan = build_answer_plan(
            answer_title="答え",
            existing_rows=[],
            file_infos=_file_infos(FILE_A),
            result_rows=rows,
            now_text="2026-11-18 12:00:00",
        )
        assert plan.updates == []
        assert len(plan.append_rows) == 1
        row = plan.append_rows[0]
        assert row[0] == FILE_A
        assert row[5:9] == ["2026-01-02", "1600", "10%", "テスト商店"]
        assert row[9] == "自動（全一致）"
        assert row[4] == "全一致（自動）"
        assert row[10] == ""  # メモ
        assert "2026-01-02 ← test/文字から" in row[11]
        assert "test/文字から" in row[11]

    def test_bottom_row_is_used_for_matching(self):
        rows = [
            _result(method="文字から", date="2026-01-01"),
            _result(method="文字から", date="2026-01-02"),
            _result(method="画像から", date="2026-01-02"),
        ]
        plan = build_answer_plan(
            answer_title="答え",
            existing_rows=[],
            file_infos=_file_infos(FILE_A),
            result_rows=rows,
            now_text="2026-11-18 12:00:00",
        )
        assert plan.append_rows[0][5] == "2026-01-02"

    def test_one_success_only_is_not_matched(self):
        plan = build_answer_plan(
            answer_title="答え",
            existing_rows=[],
            file_infos=_file_infos(FILE_A),
            result_rows=[_result()],
            now_text="2026-11-18 12:00:00",
        )
        row = plan.append_rows[0]
        assert row[5:9] == ["", "", "", ""]
        assert row[9] == ""
        assert row[4] == "要確認: 日付・金額・税率・店名"

    def test_current_flow_is_not_used_for_matching(self):
        rows = [
            _result(method="文字から", date="2026-01-02"),
            _result(method="画像から", date="2026-01-02"),
            # 現行の流れだけ違う日付でも、一致の判定には入れない
            _result(method="現行の流れ", result="自動", date="2026-01-03"),
        ]
        plan = build_answer_plan(
            answer_title="答え",
            existing_rows=[],
            file_infos=_file_infos(FILE_A),
            result_rows=rows,
            now_text="2026-11-18 12:00:00",
        )
        assert plan.append_rows[0][5:9] == ["2026-01-02", "1600", "10%", "テスト商店"]

    def test_other_files_are_ignored_for_names(self):
        plan = build_answer_plan(
            answer_title="答え",
            existing_rows=[],
            file_infos=_file_infos(FILE_A),
            result_rows=[
                _result(file_id=FILE_A),
                _result(file_id=FILE_B, model="other"),
            ],
            now_text="2026-11-18 12:00:00",
        )
        assert [row[0] for row in plan.append_rows] == [FILE_A, FILE_B]


class TestExistingRow:
    def test_non_empty_answers_source_and_memo_are_not_overwritten(self):
        existing = _answer_row(
            answers=("2026-01-01", "999", "8%", "別の商店"),
            source="人",
            memo="これは残す",
        )
        plan = build_answer_plan(
            answer_title="答え",
            existing_rows=[existing],
            file_infos=_file_infos(FILE_A),
            result_rows=[_result(), _result(model="gemini-other", method="画像から")],
            now_text="2026-11-18 12:00:00",
        )
        assert plan.append_rows == []
        ranges = _columns_in(plan)
        for index in range(5, 11):
            assert cell_range("答え", index, 2) not in ranges
        # 状態は人入力なので確認済み
        assert cell_range("答え", 4, 2) in ranges
        assert any(
            update["values"][0][0] == "確認済み"
            for update in plan.updates
            if update["range"].endswith("E2")
        )

    def test_empty_cells_are_filled_and_source_set(self):
        existing = _answer_row(answers=("", "", "", ""), source="", memo="残す")
        plan = build_answer_plan(
            answer_title="答え",
            existing_rows=[existing],
            file_infos=_file_infos(FILE_A),
            result_rows=[_result(), _result(model="gemini-other", method="画像から")],
            now_text="2026-11-18 12:00:00",
        )
        ranges = _columns_in(plan)
        for index in range(5, 10):
            assert cell_range("答え", index, 2) in ranges
        assert cell_range("答え", 10, 2) not in ranges  # メモ
        assert any(
            update["range"] == cell_range("答え", 9, 2) and update["values"] == [["自動（全一致）"]]
            for update in plan.updates
        )

    def test_whitespace_only_cells_are_not_overwritten(self):
        existing = _answer_row(
            answers=(" ", "\u3000", " ", "\u3000"),
            source=" ",
            memo=" ",
        )
        plan = build_answer_plan(
            answer_title="答え",
            existing_rows=[existing],
            file_infos=_file_infos(FILE_A),
            result_rows=[_result(), _result(model="gemini-other", method="画像から")],
            now_text="2026-11-18 12:00:00",
        )
        ranges = _columns_in(plan)
        for index in range(5, 11):
            assert cell_range("答え", index, 2) not in ranges

    def test_wrong_prefilled_answer_with_auto_source_needs_review(self):
        existing = _answer_row(
            answers=("2026-01-01", "1600", "10%", "テスト商店"),
            source="自動（全一致）",
        )
        plan = build_answer_plan(
            answer_title="答え",
            existing_rows=[existing],
            file_infos=_file_infos(FILE_A),
            result_rows=[_result(), _result(model="gemini-other", method="画像から")],
            now_text="2026-11-18 12:00:00",
        )
        state_updates = [
            update["values"][0][0]
            for update in plan.updates
            if update["range"] == cell_range("答え", 4, 2)
        ]
        assert state_updates == ["要確認: 日付"]
        # 正解の欄は空でないので変わらない
        assert cell_range("答え", 5, 2) not in _columns_in(plan)


class TestCandidates:
    def test_values_and_failures(self):
        rows = [
            _result(method="文字から", amount=1600),
            _result(model="gemini-other", method="画像から", amount=1600),
            _result(model="gemini-bad", method="画像から", result="失敗:api_error"),
        ]
        candidates = build_candidates(rows)
        assert "1600 ← test/文字から, other/画像から" in candidates["金額"]
        assert "失敗: bad/画像から" in candidates["金額"]

    def test_judge_failures_are_not_candidates(self):
        # 審判の失敗は「答え」タブの候補に出さない（spec_judge_form §12.3）
        rows = [
            _result(method="文字から"),
            _result(model="gemini-other", method="画像から"),
            _result(model="gemini-decision-1", method="審判", result="失敗:api_error"),
        ]
        candidates = build_candidates(rows)
        assert "審判" not in candidates["金額"]
        assert "decision-1" not in candidates["金額"]

    def test_vendor_tie_breaks_by_shorter(self):
        plan = build_answer_plan(
            answer_title="答え",
            existing_rows=[],
            file_infos=_file_infos(FILE_A),
            result_rows=[
                _result(vendor="株式会社テスト商店"),
                _result(model="gemini-other", method="画像から", vendor="テスト商店"),
            ],
            now_text="2026-11-18 12:00:00",
        )
        assert plan.append_rows[0][8] == "テスト商店"


_NON_EMPTY_OR_EMPTY = st.one_of(
    st.just(""),
    st.builds(lambda s: "X" + s, st.text()),
)


@given(
    date_answer=_NON_EMPTY_OR_EMPTY,
    amount_answer=_NON_EMPTY_OR_EMPTY,
    tax_answer=_NON_EMPTY_OR_EMPTY,
    vendor_answer=_NON_EMPTY_OR_EMPTY,
    source=_NON_EMPTY_OR_EMPTY,
    memo=st.builds(lambda s: "M" + s, st.text()),
    result_date=st.text(),
    result_amount=st.text(),
    result_vendor=st.text(),
)
def test_s6_never_overwrites_non_empty_answer_cells(
    date_answer,
    amount_answer,
    tax_answer,
    vendor_answer,
    source,
    memo,
    result_date,
    result_amount,
    result_vendor,
):
    answers = (date_answer, amount_answer, tax_answer, vendor_answer)
    existing = _answer_row(answers=answers, source=source, memo=memo)
    rows = [
        _result(
            date=result_date,
            amount=result_amount,
            tax="8%",
            vendor=result_vendor,
        ),
        _result(model="gemini-other", method="画像から", date=result_date, amount=result_amount),
    ]
    plan = build_answer_plan(
        answer_title="答え",
        existing_rows=[existing],
        file_infos=_file_infos(FILE_A),
        result_rows=rows,
        now_text="2026-11-18 12:00:00",
    )
    ranges = _columns_in(plan)
    for offset, value in enumerate(answers):
        if value != "":
            assert cell_range("答え", 5 + offset, 2) not in ranges
    if source != "":
        assert cell_range("答え", 9, 2) not in ranges
    # メモには常に書かない
    assert cell_range("答え", 10, 2) not in ranges
    assert plan.append_rows == []

"""集計（仕様 §10）のテスト"""

from src.compare.config import CompareConfig, CompareModel
from src.compare.score import (
    estimate_cost,
    format_ratio,
    metric_rows,
    summary_rows,
)
from src.compare.sheet import SUMMARY_HEADERS

MODEL = CompareModel(label="gemini-test", name="gemini-test")


def _config(models=(MODEL,), methods=("text", "image"), prices=None):
    return CompareConfig(
        result_spreadsheet_id="R" * 24,
        models=tuple(models),
        methods=tuple(methods),
        prices=prices if prices is not None else {"gemini-test": (1.0, 2.0)},
    )


def _answer(file_id, date="", amount="", tax="", vendor="", state=""):
    return {
        "fileId": file_id,
        "正解_日付": date,
        "正解_金額": amount,
        "正解_税率": tax,
        "正解_店名": vendor,
        "状態": state,
    }


def _row(
    file_id,
    method="文字から",
    result="成功",
    date="2026-01-02",
    amount=1600,
    tax="10%",
    vendor="テスト商店",
    finish="STOP",
    validation="ok",
    latency=100,
    input_tokens=1000,
    output_tokens=100,
    thinking=0,
    model="gemini-test",
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
        "応答ms": latency,
        "入力トークン": input_tokens,
        "出力トークン": output_tokens,
        "思考トークン": thinking,
    }


def _find(metrics, model="gemini-test", method="文字から"):
    return next(m for m in metrics if m.get("型") == model and m.get("方式") == method)


class TestAccuracy:
    def test_denominator_is_answered_files_and_failures_are_wrong(self):
        answers = [
            _answer("A", date="2026-01-02", amount="1600"),
            _answer("B"),
            _answer("C", date="2026-01-02", amount="1600"),
        ]
        rows = [
            _row("A", date="2026-01-02", amount=999),
            _row("B", date="2026-01-02", amount=1600),
            _row("C", result="失敗:api_error"),
        ]
        metric = _find(metric_rows(_config(), rows, answers))
        assert metric["ファイル数"] == 3
        assert metric["日付"] == "1/2 (50.0%)"
        assert metric["金額"] == "0/2 (0.0%)"
        assert metric["失敗"] == 1

    def test_no_answer_is_dash(self):
        metrics = metric_rows(_config(), [_row("A")], [])
        assert _find(metrics)["日付"] == "-"

    def test_date_and_amount_needs_both_answers(self):
        answers = [
            _answer("A", date="2026-01-02", amount="1600"),
            _answer("B", date="2026-01-02"),
        ]
        rows = [_row("A"), _row("B")]
        metric = _find(metric_rows(_config(), rows, answers))
        assert metric["日付と金額"] == "1/1 (100.0%)"

    def test_bottom_row_is_used(self):
        rows = [
            _row("A", result="失敗:api_error", date="", amount=None),
            _row("A", result="成功"),
        ]
        answers = [_answer("A", date="2026-01-02", amount="1600")]
        metric = _find(metric_rows(_config(), rows, answers))
        assert metric["失敗"] == 0
        assert metric["日付"] == "1/1 (100.0%)"


class TestCurrentFlowMetrics:
    def _current(self, file_id, result, date="2026-01-02", amount=1600):
        return _row(file_id, method="現行の流れ", result=result, date=date, amount=amount)

    def test_auto_correct_and_wrong_and_manual(self):
        answers = [
            _answer("A", date="2026-01-02", amount="1600"),
            _answer("B", date="2026-01-02", amount="1600"),
            _answer("C", date="2026-01-02", amount="1600"),
        ]
        rows = [
            self._current("A", "自動"),
            self._current("B", "自動", amount=999),
            self._current("C", "一部要手入力"),
        ]
        metric = _find(metric_rows(_config(), rows, answers), method="現行の流れ")
        assert metric["正しく自動"] == 1
        assert metric["誤って自動"] == 1
        assert metric["要手入力"] == 1
        # 現行の流れには失敗・MAX_TOKENS・金額照合NG を出さない
        assert metric["失敗"] == ""
        assert metric["MAX_TOKENS"] == ""
        assert metric["金額照合NG"] == ""

    def test_wrong_auto_requires_both_answers(self):
        answers = [_answer("A", date="2026-01-02")]
        metrics = metric_rows(_config(), [self._current("A", "自動", amount=999)], answers)
        metric = _find(metrics, method="現行の流れ")
        assert metric["誤って自動"] == 0
        assert metric["正しく自動"] == 0


class TestModelReadMetrics:
    def test_failures_tokens_and_amount_ng(self):
        rows = [
            _row("A", result="失敗:api_error"),
            _row("B", finish="MAX_TOKENS"),
            _row("C", validation="digit_inflation"),
            _row("D", validation="ok・missing_in_ocr"),
        ]
        answers = [_answer(file_id) for file_id in ("A", "B", "C", "D")]
        metric = _find(metric_rows(_config(), rows, answers))
        assert metric["失敗"] == 1
        assert metric["MAX_TOKENS"] == 1
        assert metric["金額照合NG"] == 2
        assert metric["正しく自動"] == ""
        assert metric["要手入力"] == ""

    def test_latency_and_tokens(self):
        rows = [
            _row("A", latency=100, input_tokens=1000, output_tokens=100),
            _row("B", latency=300, input_tokens=2000, output_tokens=200),
        ]
        metric = _find(metric_rows(_config(), rows, []))
        assert metric["平均応答ms"] == 200
        assert metric["最大応答ms"] == 300
        assert metric["入力トークン"] == 3000
        assert metric["出力トークン"] == 300


class TestCost:
    def test_formula_and_per_file(self):
        assert estimate_cost({"gemini-test": (1.0, 2.0)}, "gemini-test", 1_000_000, 0, 0) == 1.0
        assert (
            estimate_cost({"gemini-test": (1.0, 2.0)}, "gemini-test@low", 0, 500_000, 500_000)
            == 2.0
        )
        rows = [_row("A", input_tokens=1_000_000, output_tokens=0, thinking=0)]
        metric = _find(metric_rows(_config(), rows, []))
        assert metric["推定費用USD"] == "1.000000"
        assert metric["1本あたりUSD"] == "1.000000"

    def test_missing_price(self):
        rows = [_row("A")]
        metric = _find(metric_rows(_config(prices={}), rows, []))
        assert metric["推定費用USD"] == "単価未設定"
        assert metric["1本あたりUSD"] == "単価未設定"


def test_format_ratio():
    assert format_ratio(0, 0) == "-"
    assert format_ratio(1, 3) == "1/3 (33.3%)"


class TestSummary:
    def test_layout_and_unusable_model(self):
        rows = [
            _row("A", input_tokens=10, output_tokens=1),
            _row("B", result="失敗:api_error"),
        ]
        answers = [
            _answer("A", date="2026-01-02", amount="1600", state="要確認: 日付"),
            _answer("B"),
        ]
        config = _config(models=(MODEL, CompareModel("gemini-gone", "gemini-gone")))
        summary = summary_rows(
            config=config,
            result_rows=rows,
            answer_rows=answers,
            label="L1",
            now_text="2026-11-18 12:00:00",
            unusable_models=["gemini-gone"],
        )
        assert summary[0] == ["実行ラベル", "L1"]
        assert summary[1] == ["集計時刻", "2026-11-18 12:00:00"]
        assert summary[3][1] == "日付 1・金額 1・税率 0・店名 0（全 2 本）"
        assert summary[4] == ["要確認のファイル", 1]
        assert summary[5] == [""]
        assert summary[6] == SUMMARY_HEADERS
        methods = [row[1] for row in summary[7:]]
        assert methods == ["文字から", "画像から", "現行の流れ", "使えない型"]
        assert summary[-1][0] == "gemini-gone"
        assert summary[-1][1] == "使えない型"

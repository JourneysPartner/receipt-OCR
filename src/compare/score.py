"""集計（仕様 §10）。"""

from collections.abc import Iterable

from src.compare.config import CompareConfig
from src.compare.normalize import (
    FIELD_AMOUNT,
    FIELD_DATE,
    FIELD_TAX,
    FIELD_VENDOR,
    value_matches_answer,
)
from src.compare.sheet import SUMMARY_HEADERS

METHOD_TEXT_LABEL = "文字から"
METHOD_IMAGE_LABEL = "画像から"
METHOD_CURRENT_LABEL = "現行の流れ"
METHOD_LABELS = (METHOD_TEXT_LABEL, METHOD_IMAGE_LABEL, METHOD_CURRENT_LABEL)
SUCCESS = "成功"
AUTO = "自動"

RESULT_COLUMNS = {
    FIELD_DATE: "日付",
    FIELD_AMOUNT: "合計金額",
    FIELD_TAX: "税率",
    FIELD_VENDOR: "店名",
}
ANSWER_COLUMNS = {
    FIELD_DATE: "正解_日付",
    FIELD_AMOUNT: "正解_金額",
    FIELD_TAX: "正解_税率",
    FIELD_VENDOR: "正解_店名",
}


def _text(value) -> str:
    return "" if value is None else str(value).strip()


def _int_or_none(value) -> int | None:
    if value is None or _text(value) == "":
        return None
    try:
        return int(float(str(value).replace(",", "")))
    except ValueError:
        return None


def base_model_name(label: str) -> str:
    return _text(label).split("@", 1)[0]


def estimate_cost(
    prices: dict[str, tuple[float, float]],
    label: str,
    input_tokens,
    output_tokens,
    thinking_tokens,
) -> float | None:
    price = prices.get(base_model_name(label))
    if price is None:
        return None
    input_count = _int_or_none(input_tokens) or 0
    output_count = _int_or_none(output_tokens) or 0
    thinking_count = _int_or_none(thinking_tokens) or 0
    input_price, output_price = price
    return (input_count * input_price + (output_count + thinking_count) * output_price) / 1_000_000


def format_ratio(numerator: int, denominator: int) -> str:
    if denominator == 0:
        return "-"
    percent = numerator / denominator * 100
    return f"{numerator}/{denominator} ({percent:.1f}%)"


def _format_cost(value: float | None) -> str:
    if value is None:
        return "単価未設定"
    return f"{value:.6f}"


def bottom_rows(result_rows: list[dict]) -> list[dict]:
    """（fileId, 型, 方式）ごとに、下にある行を使う。"""
    latest: dict[tuple[str, str, str], dict] = {}
    for row in result_rows:
        key = (_text(row.get("fileId")), _text(row.get("型")), _text(row.get("方式")))
        latest[key] = row
    return list(latest.values())


def _answer(answer_by_file: dict[str, dict], file_id: str, field: str) -> str:
    return _text((answer_by_file.get(file_id) or {}).get(ANSWER_COLUMNS[field]))


def _correct(row: dict, field: str, answer: str) -> bool:
    result = _text(row.get("結果"))
    if result not in (SUCCESS, AUTO):
        return False
    return value_matches_answer(field, row.get(RESULT_COLUMNS[field]), answer)


def _accuracy(rows: list[dict], answer_by_file: dict[str, dict], field: str) -> tuple[int, int]:
    numerator = 0
    denominator = 0
    for row in rows:
        answer = _answer(answer_by_file, _text(row.get("fileId")), field)
        if not answer:
            continue
        denominator += 1
        if _correct(row, field, answer):
            numerator += 1
    return numerator, denominator


def _date_and_amount(rows: list[dict], answer_by_file: dict[str, dict]) -> tuple[int, int]:
    numerator = 0
    denominator = 0
    for row in rows:
        file_id = _text(row.get("fileId"))
        date_answer = _answer(answer_by_file, file_id, FIELD_DATE)
        amount_answer = _answer(answer_by_file, file_id, FIELD_AMOUNT)
        if not date_answer or not amount_answer:
            continue
        denominator += 1
        if _correct(row, FIELD_DATE, date_answer) and _correct(row, FIELD_AMOUNT, amount_answer):
            numerator += 1
    return numerator, denominator


def _auto_counts(rows: list[dict], answer_by_file: dict[str, dict]) -> tuple[int, int, int]:
    correct = 0
    wrong = 0
    manual = 0
    for row in rows:
        result = _text(row.get("結果"))
        if result in ("要手入力", "一部要手入力"):
            manual += 1
            continue
        if result != AUTO:
            continue
        file_id = _text(row.get("fileId"))
        date_answer = _answer(answer_by_file, file_id, FIELD_DATE)
        amount_answer = _answer(answer_by_file, file_id, FIELD_AMOUNT)
        if not date_answer or not amount_answer:
            continue
        if value_matches_answer(FIELD_DATE, row.get("日付"), date_answer) and value_matches_answer(
            FIELD_AMOUNT, row.get("合計金額"), amount_answer
        ):
            correct += 1
        else:
            wrong += 1
    return correct, wrong, manual


def _metric(
    *,
    label: str,
    method: str,
    rows: list[dict],
    answer_by_file: dict[str, dict],
    prices: dict[str, tuple[float, float]],
) -> dict:
    files = {_text(row.get("fileId")) for row in rows}
    date_n, date_m = _accuracy(rows, answer_by_file, FIELD_DATE)
    amount_n, amount_m = _accuracy(rows, answer_by_file, FIELD_AMOUNT)
    tax_n, tax_m = _accuracy(rows, answer_by_file, FIELD_TAX)
    vendor_n, vendor_m = _accuracy(rows, answer_by_file, FIELD_VENDOR)
    both_n, both_m = _date_and_amount(rows, answer_by_file)
    auto_ok, auto_bad, manual = _auto_counts(rows, answer_by_file)

    latencies = [
        value for value in (_int_or_none(row.get("応答ms")) for row in rows) if value is not None
    ]
    input_tokens = sum(
        value
        for value in (_int_or_none(row.get("入力トークン")) for row in rows)
        if value is not None
    )
    output_tokens = sum(
        value
        for value in (_int_or_none(row.get("出力トークン")) for row in rows)
        if value is not None
    )
    thinking_tokens = sum(
        value
        for value in (_int_or_none(row.get("思考トークン")) for row in rows)
        if value is not None
    )
    costs = [
        estimate_cost(
            prices,
            label,
            row.get("入力トークン"),
            row.get("出力トークン"),
            row.get("思考トークン"),
        )
        for row in rows
    ]
    has_price = base_model_name(label) in prices
    cost_sum = None if not has_price or any(cost is None for cost in costs) else sum(costs)
    cost_per_file = cost_sum / len(files) if cost_sum is not None and files else cost_sum

    is_current = method == METHOD_CURRENT_LABEL
    is_model_read = method in (METHOD_TEXT_LABEL, METHOD_IMAGE_LABEL)
    return {
        "型": label,
        "方式": method,
        "ファイル数": len(files),
        "失敗": _count_prefix(rows, "失敗:") if is_model_read else "",
        "MAX_TOKENS": _count_finish(rows, "MAX_TOKENS") if is_model_read else "",
        "金額照合NG": _count_amount_ng(rows) if is_model_read else "",
        "日付": format_ratio(date_n, date_m),
        "金額": format_ratio(amount_n, amount_m),
        "税率": format_ratio(tax_n, tax_m),
        "店名": format_ratio(vendor_n, vendor_m),
        "日付と金額": format_ratio(both_n, both_m),
        "正しく自動": auto_ok if is_current else "",
        "誤って自動": auto_bad if is_current else "",
        "要手入力": manual if is_current else "",
        "平均応答ms": int(sum(latencies) / len(latencies)) if latencies else "",
        "最大応答ms": max(latencies) if latencies else "",
        "入力トークン": input_tokens,
        "出力トークン": output_tokens,
        "思考トークン": thinking_tokens,
        "推定費用USD": _format_cost(cost_sum),
        "1本あたりUSD": _format_cost(cost_per_file),
    }


def _count_prefix(rows: Iterable[dict], prefix: str) -> int:
    return sum(1 for row in rows if _text(row.get("結果")).startswith(prefix))


def _count_finish(rows: Iterable[dict], value: str) -> int:
    return sum(1 for row in rows if _text(row.get("終了理由")) == value)


def _count_amount_ng(rows: Iterable[dict]) -> int:
    return sum(
        1
        for row in rows
        if "digit_inflation" in _text(row.get("金額照合"))
        or "missing_in_ocr" in _text(row.get("金額照合"))
    )


def metric_rows(
    config: CompareConfig,
    result_rows: list[dict],
    answer_rows: list[dict],
    unusable_models: list[str] | None = None,
) -> list[dict]:
    latest = bottom_rows(result_rows)
    answer_by_file = {_text(row.get("fileId")): row for row in answer_rows}

    methods: list[str] = []
    if "text" in config.methods:
        methods.append(METHOD_TEXT_LABEL)
    if "image" in config.methods:
        methods.append(METHOD_IMAGE_LABEL)
    if len(methods) == 2:
        methods.append(METHOD_CURRENT_LABEL)

    metrics: list[dict] = []
    for model in config.models:
        if unusable_models and model.label in unusable_models:
            metrics.append({"型": model.label, "方式": "使えない型"})
            continue
        for method in methods:
            rows = [
                row
                for row in latest
                if _text(row.get("型")) == model.label and _text(row.get("方式")) == method
            ]
            metrics.append(
                _metric(
                    label=model.label,
                    method=method,
                    rows=rows,
                    answer_by_file=answer_by_file,
                    prices=config.prices,
                )
            )
    return metrics


def summary_rows(
    *,
    config: CompareConfig,
    result_rows: list[dict],
    answer_rows: list[dict],
    label: str,
    now_text: str,
    unusable_models: list[str] | None = None,
) -> list[list]:
    file_ids = {_text(row.get("fileId")) for row in result_rows if _text(row.get("fileId"))}
    answers_by_file = {_text(row.get("fileId")): row for row in answer_rows}
    counts = {
        field: sum(
            1
            for file_id in file_ids
            if _text((answers_by_file.get(file_id) or {}).get(ANSWER_COLUMNS[field]))
        )
        for field in (FIELD_DATE, FIELD_AMOUNT, FIELD_TAX, FIELD_VENDOR)
    }
    needs_review = sum(
        1
        for file_id in file_ids
        if _text((answers_by_file.get(file_id) or {}).get("状態")).startswith("要確認")
    )
    settings = next((_text(row.get("設定")) for row in result_rows if _text(row.get("設定"))), "")

    rows: list[list] = [
        ["実行ラベル", label],
        ["集計時刻", now_text],
        ["設定", settings],
        [
            "答えのあるファイル",
            (
                f"日付 {counts[FIELD_DATE]}・金額 {counts[FIELD_AMOUNT]}・"
                f"税率 {counts[FIELD_TAX]}・店名 {counts[FIELD_VENDOR]}"
                f"（全 {len(file_ids)} 本）"
            ),
        ],
        ["要確認のファイル", needs_review],
        [""],
        list(SUMMARY_HEADERS),
    ]
    for metric in metric_rows(config, result_rows, answer_rows, unusable_models):
        rows.append([metric.get(column, "") for column in SUMMARY_HEADERS])
    return rows

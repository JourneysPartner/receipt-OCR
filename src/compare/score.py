"""集計（仕様 §10）。"""

import json
from collections.abc import Iterable

from src.compare.config import CompareConfig, CompareModel
from src.compare.normalize import (
    FIELD_AMOUNT,
    FIELD_DATE,
    FIELD_TAX,
    FIELD_VENDOR,
    normalize_date,
    parse_amount_cell,
    value_matches_answer,
)
from src.compare.sheet import SUMMARY_HEADERS

METHOD_TEXT_LABEL = "文字から"
METHOD_IMAGE_LABEL = "画像から"
METHOD_CURRENT_LABEL = "現行の流れ"
METHOD_DUAL_LABEL = "両読み"
METHOD_LABELS = (
    METHOD_TEXT_LABEL,
    METHOD_IMAGE_LABEL,
    METHOD_CURRENT_LABEL,
    METHOD_DUAL_LABEL,
)
SUCCESS = "成功"
AUTO = "自動"

# 明細JSON の欄名（設計 §7.3）
RECEIPT_KEYS = {
    FIELD_DATE: "d",
    FIELD_AMOUNT: "a",
    FIELD_TAX: "t",
    FIELD_VENDOR: "v",
}
RECEIPT_AUTO_KEY = "r"

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


def derive_models(result_rows: list[dict]) -> tuple[CompareModel, ...]:
    """結果タブの「型」の列から、出てきた順に並びを作る（score で env 省略時）。"""
    labels: list[str] = []
    for row in result_rows:
        label = _text(row.get("型"))
        if label and label not in labels:
            labels.append(label)
    return tuple(CompareModel(label=label, name=base_model_name(label)) for label in labels)


def derive_methods(result_rows: list[dict]) -> tuple[str, ...]:
    """結果タブの「方式」の列から、出てきた順に並びを作る（現行の流れは除く）。"""
    by_label = {METHOD_TEXT_LABEL: "text", METHOD_IMAGE_LABEL: "image"}
    found: list[str] = []
    for row in result_rows:
        key = by_label.get(_text(row.get("方式")))
        if key and key not in found:
            found.append(key)
    return tuple(found)


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


def _answer_receipt(answer: dict | None) -> dict:
    if answer is None:
        return {}
    return {
        field: _text(answer.get(ANSWER_COLUMNS[field]))
        for field in (FIELD_DATE, FIELD_AMOUNT, FIELD_TAX, FIELD_VENDOR)
    }


def _receipt_value(receipt: dict, field: str):
    """答え（日本語の欄名）と読み（明細JSON の短い鍵）のどちらからも値を取る。"""
    if field in receipt:
        return receipt.get(field)
    return receipt.get(RECEIPT_KEYS[field])


def multi_by_file(multi_rows: list[dict] | None) -> dict[str, list[dict]]:
    """「答え_複数」の行を fileId ごとにまとめる。"""
    grouped: dict[str, list[dict]] = {}
    for row in multi_rows or []:
        file_id = _text(row.get("fileId"))
        if file_id:
            grouped.setdefault(file_id, []).append(row)
    return grouped


def expected_receipts(
    file_id: str,
    answer_by_file: dict[str, dict],
    multi: dict[str, list[dict]],
) -> list[dict]:
    """このファイルの答え（レシートの並び）。無ければ []。"""
    rows = multi.get(file_id) or []
    if rows:
        numbers = [_int_or_none(row.get("番号")) for row in rows]
        if all(number is not None for number in numbers):
            order = sorted(range(len(rows)), key=lambda index: numbers[index])
        else:
            order = list(range(len(rows)))
        return [
            {
                FIELD_DATE: _text(rows[index].get("正解_日付")),
                FIELD_AMOUNT: _text(rows[index].get("正解_金額")),
                FIELD_TAX: _text(rows[index].get("正解_税率")),
                FIELD_VENDOR: _text(rows[index].get("正解_店名")),
            }
            for index in order
        ]
    answer = answer_by_file.get(file_id)
    if answer is None:
        return []
    return [_answer_receipt(answer)]


def _usable_for_read(row: dict) -> bool:
    method = _text(row.get("方式"))
    result = _text(row.get("結果"))
    if method in (METHOD_TEXT_LABEL, METHOD_IMAGE_LABEL):
        return result == SUCCESS
    if method == METHOD_CURRENT_LABEL:
        return result == AUTO
    if method == METHOD_DUAL_LABEL:
        return True
    return False


def read_receipts(row: dict) -> list[dict] | None:
    """明細JSON を読む。読みとして使えない行・空・壊れている行は None。"""
    if not _usable_for_read(row):
        return None
    return _parse_receipts(row)


def _parse_receipts(row: dict) -> list[dict] | None:
    """明細JSON をそのまま読む（行の結果は見ない）。空・壊れている行は None。"""
    raw = _text(row.get("明細JSON"))
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, list) or not data:
        return None
    if any(not isinstance(item, dict) for item in data):
        return None
    return list(data)


def _sort_key(receipt: dict):
    amount = parse_amount_cell(_receipt_value(receipt, FIELD_AMOUNT))
    date = normalize_date(_receipt_value(receipt, FIELD_DATE))
    if amount is None:
        return (1, 0, date)
    return (0, amount, date)


def _sorted(receipts: list[dict]) -> list[dict]:
    """金額（空は最後）→ 日付 の順。"""
    return sorted(receipts, key=_sort_key)


def _field_ok(row: dict, expected: list[dict], field: str) -> bool:
    read = read_receipts(row)
    if read is None or len(read) != len(expected):
        return False
    return all(
        value_matches_answer(
            field, _receipt_value(read_item, field), _receipt_value(expected_item, field)
        )
        for read_item, expected_item in zip(_sorted(read), _sorted(expected), strict=True)
    )


def _has_answer(expected: list[dict], fields) -> bool:
    if not expected:
        return False
    return all(_text(_receipt_value(receipt, field)) for receipt in expected for field in fields)


def _accuracy(
    rows: list[dict],
    answer_by_file: dict[str, dict],
    multi: dict[str, list[dict]],
    field: str,
) -> tuple[int, int]:
    numerator = 0
    denominator = 0
    for row in rows:
        expected = expected_receipts(_text(row.get("fileId")), answer_by_file, multi)
        if not _has_answer(expected, (field,)):
            continue
        denominator += 1
        if _field_ok(row, expected, field):
            numerator += 1
    return numerator, denominator


def _date_and_amount(
    rows: list[dict],
    answer_by_file: dict[str, dict],
    multi: dict[str, list[dict]],
) -> tuple[int, int]:
    numerator = 0
    denominator = 0
    for row in rows:
        expected = expected_receipts(_text(row.get("fileId")), answer_by_file, multi)
        if not _has_answer(expected, (FIELD_DATE, FIELD_AMOUNT)):
            continue
        denominator += 1
        if _field_ok(row, expected, FIELD_DATE) and _field_ok(row, expected, FIELD_AMOUNT):
            numerator += 1
    return numerator, denominator


def _auto_receipts(row: dict) -> list[dict] | None:
    """明細JSON の r が `自動` のもの（行の結果は見ない。監査 M3）。"""
    receipts = _parse_receipts(row)
    if receipts is None:
        return None
    return [item for item in receipts if _text(item.get(RECEIPT_AUTO_KEY)) == AUTO]


def _assign_auto(auto: list[dict], expected: list[dict]) -> bool:
    """自動の明細を、答えのまだ使っていないレシートに 1 対 1 で当てる。"""
    used: set[int] = set()
    for item in auto:
        for index, expected_item in enumerate(expected):
            if index in used:
                continue
            if value_matches_answer(
                FIELD_DATE,
                _receipt_value(item, FIELD_DATE),
                _receipt_value(expected_item, FIELD_DATE),
            ) and value_matches_answer(
                FIELD_AMOUNT,
                _receipt_value(item, FIELD_AMOUNT),
                _receipt_value(expected_item, FIELD_AMOUNT),
            ):
                used.add(index)
                break
        else:
            return False
    return True


def _auto_counts(
    rows: list[dict],
    answer_by_file: dict[str, dict],
    multi: dict[str, list[dict]],
) -> tuple[int, int, int]:
    correct = 0
    wrong = 0
    manual = 0
    for row in rows:
        expected = expected_receipts(_text(row.get("fileId")), answer_by_file, multi)
        result = _text(row.get("結果"))
        if not _has_answer(expected, (FIELD_DATE, FIELD_AMOUNT)):
            # 日付か金額の答えが欠けたファイルは、自動以外を要手入力に数える
            if result != AUTO:
                manual += 1
            continue
        auto = _auto_receipts(row)
        if auto is None:
            # 明細JSON が空・壊れている行は自動の明細 0 件として数える
            auto = []
        if result == AUTO and len(auto) < len(expected):
            # レシートが抜けたまま済みになる（監査 M4）
            wrong += 1
            continue
        if not _assign_auto(auto, expected):
            wrong += 1
            continue
        if result == AUTO and len(auto) == len(expected):
            correct += 1
        else:
            manual += 1
    return correct, wrong, manual


def _metric(
    *,
    label: str,
    method: str,
    rows: list[dict],
    answer_by_file: dict[str, dict],
    multi: dict[str, list[dict]],
    prices: dict[str, tuple[float, float]],
) -> dict:
    files = {_text(row.get("fileId")) for row in rows}
    date_n, date_m = _accuracy(rows, answer_by_file, multi, FIELD_DATE)
    amount_n, amount_m = _accuracy(rows, answer_by_file, multi, FIELD_AMOUNT)
    tax_n, tax_m = _accuracy(rows, answer_by_file, multi, FIELD_TAX)
    vendor_n, vendor_m = _accuracy(rows, answer_by_file, multi, FIELD_VENDOR)
    both_n, both_m = _date_and_amount(rows, answer_by_file, multi)
    auto_ok, auto_bad, manual = _auto_counts(rows, answer_by_file, multi)

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

    is_auto = method in (METHOD_CURRENT_LABEL, METHOD_DUAL_LABEL)
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
        "正しく自動": auto_ok if is_auto else "",
        "誤って自動": auto_bad if is_auto else "",
        "要手入力": manual if is_auto else "",
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
    multi_rows: list[dict] | None = None,
) -> list[dict]:
    latest = bottom_rows(result_rows)
    answer_by_file = {_text(row.get("fileId")): row for row in answer_rows}
    multi = multi_by_file(multi_rows)

    methods: list[str] = []
    if "text" in config.methods:
        methods.append(METHOD_TEXT_LABEL)
    if "image" in config.methods:
        methods.append(METHOD_IMAGE_LABEL)
    if len(methods) == 2:
        methods.append(METHOD_CURRENT_LABEL)
        methods.append(METHOD_DUAL_LABEL)

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
                    multi=multi,
                    prices=config.prices,
                )
            )
    known = {model.label for model in config.models}
    for label in unusable_models or []:
        if label not in known:
            metrics.append({"型": label, "方式": "使えない型"})
    return metrics


def summary_rows(
    *,
    config: CompareConfig,
    result_rows: list[dict],
    answer_rows: list[dict],
    label: str,
    now_text: str,
    unusable_models: list[str] | None = None,
    multi_rows: list[dict] | None = None,
) -> list[list]:
    file_ids = {_text(row.get("fileId")) for row in result_rows if _text(row.get("fileId"))}
    answers_by_file = {_text(row.get("fileId")): row for row in answer_rows}
    multi = multi_by_file(multi_rows)
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
        ["複数レシートのファイル", sum(1 for file_id in file_ids if file_id in multi)],
        [""],
        list(SUMMARY_HEADERS),
    ]
    for metric in metric_rows(
        config, result_rows, answer_rows, unusable_models, multi_rows=multi_rows
    ):
        rows.append([metric.get(column, "") for column in SUMMARY_HEADERS])
    return rows

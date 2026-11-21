"""「答え」タブの更新（仕様 §9）。

collect の終わりと score で同じ処理を使う。正解の欄は空のセルにだけ書き、
「メモ」には触れない（S6）。
"""

from collections import Counter
from dataclasses import dataclass, field

from src.compare.normalize import (
    FIELD_AMOUNT,
    FIELD_DATE,
    FIELD_TAX,
    FIELD_VENDOR,
    FIELDS,
    field_values_agree,
    normalize_date,
    parse_amount_cell,
    parse_tax_cell,
    value_matches_answer,
)
from src.compare.sheet import ANSWER_HEADERS, cell_range

ANSWER_COLUMNS = {
    FIELD_DATE: "正解_日付",
    FIELD_AMOUNT: "正解_金額",
    FIELD_TAX: "正解_税率",
    FIELD_VENDOR: "正解_店名",
}
RESULT_COLUMNS = {
    FIELD_DATE: "日付",
    FIELD_AMOUNT: "合計金額",
    FIELD_TAX: "税率",
    FIELD_VENDOR: "店名",
}
SOURCE_COLUMN = "答えの出どころ"
AUTO_SOURCE = "自動（全一致）"
SUCCESS = "成功"
TEXT_METHOD = "文字から"
IMAGE_METHOD = "画像から"


@dataclass
class AnswerPlan:
    append_rows: list[list] = field(default_factory=list)
    updates: list[dict] = field(default_factory=list)


def _text(value) -> str:
    return "" if value is None else str(value).strip()


def short_model(label: str) -> str:
    text = _text(label)
    return text[len("gemini-") :] if text.startswith("gemini-") else text


def _column_index(name: str) -> int:
    return ANSWER_HEADERS.index(name)


def _display_value(field: str, value) -> str:
    if field == FIELD_DATE:
        return normalize_date(value)
    if field == FIELD_AMOUNT:
        amount = parse_amount_cell(value)
        return "" if amount is None else str(amount)
    if field == FIELD_TAX:
        return "・".join(parse_tax_cell(value))
    return _text(value)


def build_candidates(result_rows: list[dict]) -> dict[str, str]:
    """欄ごとの候補文字列（`<値> ← <型>/<方式>` を ` ｜ ` でつなぐ）。"""
    candidates: dict[str, str] = {}
    successful = [row for row in result_rows if _text(row.get("結果")) == SUCCESS]
    for field_name in FIELDS:
        groups: dict[str, list[str]] = {}
        for row in successful:
            value = _display_value(field_name, row.get(RESULT_COLUMNS[field_name]))
            if not value:
                continue
            label = f"{short_model(row.get('型'))}/{_text(row.get('方式'))}"
            labels = groups.setdefault(value, [])
            if label not in labels:
                labels.append(label)
        parts = [f"{value} ← {', '.join(labels)}" for value, labels in groups.items()]
        failures = [
            f"{short_model(row.get('型'))}/{_text(row.get('方式'))}"
            for row in result_rows
            # 審判の失敗は答えの候補に出さない（spec_judge_form §12.3）
            if _text(row.get("結果")).startswith("失敗:") and _text(row.get("方式")) != "審判"
        ]
        if failures:
            parts.append("失敗: " + ", ".join(dict.fromkeys(failures)))
        candidates[field_name] = " ｜ ".join(parts)
    return candidates


def _successful_for_match(result_rows: list[dict]) -> list[dict]:
    return [
        row
        for row in result_rows
        if _text(row.get("結果")) == SUCCESS
        and _text(row.get("方式")) in (TEXT_METHOD, IMAGE_METHOD)
    ]


def _matched_values(result_rows: list[dict]) -> dict[str, object]:
    successful = _successful_for_match(result_rows)
    matched: dict[str, object] = {}
    for field_name in FIELDS:
        values = [row.get(RESULT_COLUMNS[field_name]) for row in successful]
        if not field_values_agree(field_name, values):
            continue
        if field_name == FIELD_DATE:
            matched[field_name] = normalize_date(values[0])
        elif field_name == FIELD_AMOUNT:
            matched[field_name] = parse_amount_cell(values[0])
        elif field_name == FIELD_TAX:
            matched[field_name] = "・".join(parse_tax_cell(values[0]))
        else:
            matched[field_name] = _pick_vendor(values)
    return matched


def _pick_vendor(values: list) -> str:
    """合った店名のうち最も多く出た元の文字列。同数なら短い方。"""
    texts = [_text(value) for value in values if _text(value)]
    if not texts:
        return ""
    counts = Counter(texts)
    most = max(counts.values())
    candidates = [text for text, count in counts.items() if count == most]
    return sorted(candidates, key=lambda text: (len(text), text))[0]


def _needs_review(
    field: str,
    answer: str,
    source: str,
    successful: list[dict],
) -> bool:
    if not answer:
        return True
    if source != AUTO_SOURCE:
        return False
    return any(
        not value_matches_answer(field, row.get(RESULT_COLUMNS[field]), answer)
        for row in successful
    )


def _state(result_rows: list[dict], answers: dict[str, str], source: str) -> str:
    successful = _successful_for_match(result_rows)
    needs = [
        field
        for field in FIELDS
        if _needs_review(field, answers.get(field, ""), source, successful)
    ]
    if needs:
        return "要確認: " + "・".join(needs)
    if source == AUTO_SOURCE:
        return "全一致（自動）"
    return "確認済み"


def _row_value(values: list, index: int) -> str:
    return _text(values[index]) if index < len(values) else ""


def _cell(row: dict | None, column: str) -> str:
    if row is None:
        return ""
    values = row.get("_values")
    if values is not None:
        return _row_value(values, _column_index(column))
    return _text(row.get(column))


def _is_empty(row: dict, column: str) -> bool:
    """セルが本当に空か（空白だけのセルは「値あり」として触らない）。"""
    values = row.get("_values")
    if values is not None:
        index = _column_index(column)
        if index >= len(values):
            return True
        value = values[index]
    else:
        value = row.get(column)
    return value is None or str(value) == ""


def build_answer_plan(
    *,
    answer_title: str,
    existing_rows: list[dict],
    file_infos: list[dict],
    result_rows: list[dict],
    now_text: str,
) -> AnswerPlan:
    """答えタブの新しい行と、変わるセルの更新を作る。"""
    plan = AnswerPlan()
    # 同じ（ファイル ID, 型, 方式）が複数あれば、下にある行を使う（§5.4）
    latest: dict[tuple[str, str, str], dict] = {}
    for row in result_rows:
        key = (
            _text(row.get("fileId")),
            _text(row.get("型")),
            _text(row.get("方式")),
        )
        latest[key] = row
    by_file: dict[str, list[dict]] = {}
    for row in latest.values():
        by_file.setdefault(_text(row.get("fileId")), []).append(row)

    existing_by_file: dict[str, dict] = {}
    for row in existing_rows:
        existing_by_file[_text(row.get("fileId"))] = row

    ordered: list[dict] = []
    seen: set[str] = set()
    for info in file_infos:
        file_id = _text(info.get("file_id"))
        # 結果の行が無いファイル（時間切れで始めていない等）は答えに足さない
        if file_id and file_id not in seen and file_id in by_file:
            seen.add(file_id)
            ordered.append(info)
    for file_id, rows in by_file.items():
        if not file_id or file_id in seen:
            continue
        seen.add(file_id)
        ordered.append(
            {
                "file_id": file_id,
                "file_name": _text(rows[0].get("ファイル名")),
                "folder_name": _text(rows[0].get("フォルダ")),
            }
        )

    for info in ordered:
        file_id = _text(info.get("file_id"))
        rows = by_file.get(file_id, [])
        candidates = build_candidates(rows)
        matched = _matched_values(rows)
        existing = existing_by_file.get(file_id)

        answer_values = [_cell(existing, ANSWER_COLUMNS[field]) for field in FIELDS]
        source = _cell(existing, SOURCE_COLUMN)

        inserted = False
        for i, field_name in enumerate(FIELDS):
            if not answer_values[i] and field_name in matched and _text(matched[field_name]):
                answer_values[i] = _text(matched[field_name])
                inserted = True
        if existing is None:
            inserted = any(answer_values)
        if inserted and not source:
            source = AUTO_SOURCE

        state = _state(rows, dict(zip(FIELDS, answer_values, strict=True)), source)

        if existing is None:
            row = [
                file_id,
                f"https://drive.google.com/file/d/{file_id}/view",
                _text(info.get("folder_name")),
                _text(info.get("file_name")),
                state,
                answer_values[0],
                answer_values[1],
                answer_values[2],
                answer_values[3],
                source,
                "",  # メモには書かない
                candidates[FIELD_DATE],
                candidates[FIELD_AMOUNT],
                candidates[FIELD_TAX],
                candidates[FIELD_VENDOR],
                now_text,
            ]
            plan.append_rows.append(row)
            continue

        row_number = int(existing["_row"])

        for i, field_name in enumerate(FIELDS):
            column = ANSWER_COLUMNS[field_name]
            index = _column_index(column)
            if _is_empty(existing, column) and answer_values[i]:
                plan.updates.append(
                    {
                        "range": cell_range(answer_title, index, row_number),
                        "values": [[answer_values[i]]],
                    }
                )

        if source and _is_empty(existing, SOURCE_COLUMN):
            plan.updates.append(
                {
                    "range": cell_range(answer_title, _column_index(SOURCE_COLUMN), row_number),
                    "values": [[source]],
                }
            )

        for column, value in (
            ("状態", state),
            ("候補_日付", candidates[FIELD_DATE]),
            ("候補_金額", candidates[FIELD_AMOUNT]),
            ("候補_税率", candidates[FIELD_TAX]),
            ("候補_店名", candidates[FIELD_VENDOR]),
            ("更新", now_text),
        ):
            index = _column_index(column)
            if _cell(existing, column) != value:
                plan.updates.append(
                    {
                        "range": cell_range(answer_title, index, row_number),
                        "values": [[value]],
                    }
                )

    return plan


def attach_values(rows: list[dict]) -> list[dict]:
    """read_dicts の行に、見出し順の値リストを `_values` として足す。"""
    for row in rows:
        row["_values"] = [row.get(header, "") for header in ANSWER_HEADERS]
    return rows

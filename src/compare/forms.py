"""「形」（読み手の組み合わせ）の計算（仕様 §8・§9）。

API もファイルも触らない純粋な関数。合ったかどうかは必ず本番と同じ
`src.processing.reconcile.reconcile` で決める（R7）。書く側（runner）は、
ここが返す行を `replace_all`（RAW）で書くだけにする。
"""

import json
from dataclasses import dataclass, field

from src.compare.normalize import (
    FIELD_AMOUNT,
    FIELD_DATE,
    normalize_date,
    parse_amount_cell,
)
from src.compare.score import assign_auto, expected_receipts, format_ratio, multi_by_file
from src.compare.sheet import FORM_DETAIL_HEADERS, FORM_HEADERS
from src.processing.reconcile import reconcile

FORM_CURRENT = "今（両読み）"
FORM_A2 = "A2"
FORM_B = "B"
METHOD_IMAGE = "画像から"
METHOD_TEXT = "文字から"
METHOD_DUAL = "両読み"
SUCCESS = "成功"
GRADE_CORRECT = "正しく自動"
GRADE_WRONG = "誤って自動"
GRADE_REVIEW = "要確認"
GRADE_NO_ANSWER = "答えなし"
MAX_READINGS = 10


@dataclass
class ReadingItem:
    """reconcile に渡す小さな入れ物（日付と金額だけ）。"""

    date: str | None = None
    amount: int | None = None


@dataclass
class ReadingFile:
    file_id: str
    file_name: str = ""
    folder_name: str = ""
    image_items: list | None = None
    text_items: list | None = None
    readers: dict[str, list] = field(default_factory=dict)
    ocr_text: str = ""
    page_count: int = 1
    page_count_known: bool = True
    has_ocr_row: bool = True
    costs: dict[tuple[str, str], float | None] = field(default_factory=dict)
    dual_flags: list[bool] | None = None
    dual_saved: bool = False


@dataclass
class FileResult:
    file: ReadingFile
    form: str
    reader: str | None
    flags: list[bool]
    labels: list[str]
    called: bool
    grade: str
    expected: list[dict]


@dataclass
class FormMetric:
    name: str
    reader: str | None
    files: int
    correct: int
    wrong: int
    review: int
    graded: int
    items: int
    auto_items: int
    called: int | str
    cost: float
    missing_cost_rows: int
    note: str = ""


@dataclass
class FormTables:
    base_label: str
    readers: list[str]
    metrics: list[FormMetric]
    file_results: list[FileResult]
    summary_rows: list[list] = field(default_factory=list)
    detail_rows: list[list] = field(default_factory=list)


def _text(value) -> str:
    return "" if value is None else str(value).strip()


def _int_or_none(value) -> int | None:
    if value is None or _text(value) == "":
        return None
    try:
        return int(float(str(value).replace(",", "")))
    except (TypeError, ValueError):
        return None


def _item_of(receipt: dict) -> ReadingItem:
    date = receipt.get("d")
    amount = receipt.get("a")
    if amount is None:
        amount = receipt.get("amount")
    if isinstance(amount, bool) or not isinstance(amount, int):
        amount = parse_amount_cell(amount)
    return ReadingItem(date=date, amount=amount)


def items_from_row(row: dict) -> list:
    """結果の行の `明細JSON` を ReadingItem の並びにする（空・壊れていれば []）。"""
    raw = _text(row.get("明細JSON"))
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(data, list) or any(not isinstance(entry, dict) for entry in data):
        return []
    return [_item_of(entry) for entry in data]


def _cost_of(value) -> float | None:
    text = _text(value)
    if not text or text == "単価未設定":
        return None
    try:
        return float(text)
    except ValueError:
        return None


def bottom_rows(result_rows: list[dict]) -> list[dict]:
    latest: dict[tuple[str, str, str], dict] = {}
    for row in result_rows:
        key = (
            _text(row.get("fileId")),
            _text(row.get("型")),
            _text(row.get("方式")),
        )
        latest[key] = row
    return list(latest.values())


def reader_labels(result_rows: list[dict], base_label: str) -> list[str]:
    """画像からの行があり、両読みの行が無い型（＝COMPARE_READERS で読んだ型）。"""
    rows = bottom_rows(result_rows)
    image_labels: list[str] = []
    dual_labels: set[str] = set()
    for row in rows:
        label = _text(row.get("型"))
        method = _text(row.get("方式"))
        if not label:
            continue
        if method == METHOD_IMAGE and label not in image_labels:
            image_labels.append(label)
        if method == METHOD_DUAL:
            dual_labels.add(label)
    return [label for label in image_labels if label != base_label and label not in dual_labels]


def build_inputs(result_rows: list[dict], ocr_rows: list[dict], base_label: str):
    """結果・OCR の行から、形の計算に使うファイルの並びを作る。"""
    rows = bottom_rows(result_rows)
    by_file: dict[str, dict[tuple[str, str], dict]] = {}
    for row in rows:
        file_id = _text(row.get("fileId"))
        if not file_id:
            continue
        key = (_text(row.get("型")), _text(row.get("方式")))
        by_file.setdefault(file_id, {})[key] = row

    labels = reader_labels(result_rows, base_label)
    ocr_by_file: dict[str, tuple[str, int, bool]] = {}
    for row in ocr_rows or []:
        file_id = _text(row.get("fileId"))
        if not file_id:
            continue
        page_raw = row.get("ページ数")
        known = page_raw is not None and _text(page_raw) != ""
        page = _int_or_none(page_raw)
        if page is None or page < 1:
            page = 1
        ocr_by_file[file_id] = (_text(row.get("OCR文字")), page, known)

    files: list[ReadingFile] = []
    for file_id, methods in by_file.items():
        image_row = methods.get((base_label, METHOD_IMAGE))
        text_row = methods.get((base_label, METHOD_TEXT))
        if image_row is None or text_row is None:
            continue
        if file_id in ocr_by_file:
            ocr_text, page_count, known = ocr_by_file[file_id]
            has_ocr_row = True
        else:
            # Vision を呼んでいないファイルは 0 ページで数える（§14.4）
            ocr_text, page_count, known, has_ocr_row = "", 0, True, False
        costs: dict[tuple[str, str], float | None] = {}
        for (label, method), row in methods.items():
            costs[(label, method)] = _cost_of(row.get("推定費用USD"))
        readers: dict[str, list] = {}
        for label in labels:
            row = methods.get((label, METHOD_IMAGE))
            if row is None:
                continue
            readers[label] = items_from_row(row) if _text(row.get("結果")) == SUCCESS else []

        dual_row = methods.get((base_label, METHOD_DUAL))
        dual_flags = _saved_dual_flags(dual_row) if dual_row is not None else None

        files.append(
            ReadingFile(
                file_id=file_id,
                file_name=_text(image_row.get("ファイル名")),
                folder_name=_text(image_row.get("フォルダ")),
                image_items=(
                    items_from_row(image_row) if _text(image_row.get("結果")) == SUCCESS else []
                ),
                text_items=(
                    items_from_row(text_row) if _text(text_row.get("結果")) == SUCCESS else []
                ),
                readers=readers,
                ocr_text=ocr_text,
                page_count=page_count,
                page_count_known=known,
                has_ocr_row=has_ocr_row,
                costs=costs,
                dual_flags=dual_flags,
                dual_saved=dual_row is not None,
            )
        )
    files.sort(key=lambda entry: (entry.folder_name, entry.file_name, entry.file_id))
    return files, labels


def _saved_dual_flags(row: dict) -> list[bool] | None:
    """保存された `両読み` の `明細JSON` の `r`。比べられなければ None（§14.4）。"""
    raw = _text(row.get("明細JSON"))
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, list):
        return None
    entries = [entry for entry in data if isinstance(entry, dict)]
    items = items_from_row(row)
    if len(entries) != len(items):
        return None
    return [_text(entry.get("r")) == "自動" for entry in entries]


def _answers(
    answer_rows: list[dict], multi_rows: list[dict] | None, file_ids: list[str]
) -> dict[str, list[dict]]:
    answer_by_file = {_text(row.get("fileId")): row for row in answer_rows}
    multi = multi_by_file(multi_rows)
    return {file_id: expected_receipts(file_id, answer_by_file, multi) for file_id in file_ids}


def _complete(expected: list[dict]) -> bool:
    return bool(expected) and all(
        _text(receipt.get(FIELD_DATE)) and _text(receipt.get(FIELD_AMOUNT)) for receipt in expected
    )


def grade(items: list, flags: list[bool], expected: list[dict]) -> str:
    """§8.3 の 3 つ（重ならない）。答えがそろっていなければ `答えなし`。

    `答えなし` の除外だけをここに残し、自動の明細の当て方は `score.py` の
    同じ関数（`assign_auto`）を使う（§14.4）。
    """
    if not _complete(expected) or len(items) != len(flags):
        return GRADE_NO_ANSWER
    if not items:
        return GRADE_REVIEW
    auto = [
        {FIELD_DATE: item.date, FIELD_AMOUNT: item.amount}
        for item, flag in zip(items, flags, strict=True)
        if flag
    ]
    if not assign_auto(auto, expected):
        return GRADE_WRONG
    if all(flags) and len(items) < len(expected):
        return GRADE_WRONG
    if all(flags) and len(items) == len(expected):
        return GRADE_CORRECT
    return GRADE_REVIEW


def _current(file: ReadingFile, expected: list[dict]) -> FileResult:
    decisions = reconcile(file.image_items or [], file.text_items or [], file.ocr_text)
    flags = [decision.matched for decision in decisions]
    labels = [decision.label for decision in decisions]
    return FileResult(
        file=file,
        form=FORM_CURRENT,
        reader=None,
        flags=flags,
        labels=labels,
        called=False,
        grade=grade(file.image_items or [], flags, expected),
        expected=expected,
    )


def _a2(file: ReadingFile, reader: str, expected: list[dict]) -> FileResult:
    decisions = reconcile(file.image_items or [], file.readers.get(reader) or [], "")
    flags = [decision.matched for decision in decisions]
    labels = [decision.label for decision in decisions]
    return FileResult(
        file=file,
        form=FORM_A2,
        reader=reader,
        flags=flags,
        labels=labels,
        called=False,
        grade=grade(file.image_items or [], flags, expected),
        expected=expected,
    )


def _b(file: ReadingFile, reader: str, expected: list[dict]) -> FileResult:
    items = file.image_items or []
    current = reconcile(items, file.text_items or [], file.ocr_text)
    called = bool(items) and any(not decision.matched for decision in current)
    flags = [decision.matched for decision in current]
    labels = [decision.label for decision in current]
    if called:
        other = reconcile(items, file.readers.get(reader) or [], file.ocr_text)
        for index, decision in enumerate(other):
            if index >= len(flags):
                break
            # D0 で合っていた明細は `一致` のまま（§14.4）
            if decision.matched and not flags[index]:
                flags[index] = True
                labels[index] = "一致（もう1人）"
    return FileResult(
        file=file,
        form=FORM_B,
        reader=reader,
        flags=flags,
        labels=labels,
        called=called,
        grade=grade(items, flags, expected),
        expected=expected,
    )


def _cost(file: ReadingFile, label: str, method: str) -> tuple[float, int]:
    value = file.costs.get((label, method))
    if value is None:
        return 0.0, 1
    return value, 0


def _metric(
    name: str,
    reader: str | None,
    results: list[FileResult],
    *,
    called_files: int | None,
    cost_per_file,
    note: str,
) -> FormMetric:
    correct = sum(1 for result in results if result.grade == GRADE_CORRECT)
    wrong = sum(1 for result in results if result.grade == GRADE_WRONG)
    review = sum(1 for result in results if result.grade == GRADE_REVIEW)
    graded = sum(1 for result in results if result.grade != GRADE_NO_ANSWER)
    no_answer = sum(1 for result in results if result.grade == GRADE_NO_ANSWER)
    if no_answer:
        note = (
            f"{note}、答えがそろっていないファイル {no_answer}"
            if note
            else f"答えがそろっていないファイル {no_answer}"
        )
    items = sum(len(result.flags) for result in results)
    auto = sum(sum(1 for flag in result.flags if flag) for result in results)
    cost = 0.0
    missing = 0
    for result in results:
        value, absent = cost_per_file(result)
        cost += value
        missing += absent
    if called_files is None:
        called = ""
    else:
        called = called_files
    if missing:
        note = f"{note}、費用の無い行 {missing}" if note else f"費用の無い行 {missing}"
    return FormMetric(
        name=name,
        reader=reader,
        files=len(results),
        correct=correct,
        wrong=wrong,
        review=review,
        graded=graded,
        items=items,
        auto_items=auto,
        called=called,
        cost=cost,
        missing_cost_rows=missing,
        note=note,
    )


def _metric_row(metric: FormMetric) -> list:
    items_review = metric.items - metric.auto_items
    return [
        metric.name,
        metric.reader or "",
        metric.files,
        format_ratio(metric.correct, metric.graded),
        format_ratio(metric.wrong, metric.graded),
        format_ratio(metric.review, metric.graded),
        metric.items,
        format_ratio(metric.auto_items, metric.items),
        format_ratio(items_review, metric.items),
        metric.called,
        f"{metric.cost:.6f}",
        f"{(metric.cost / metric.files) if metric.files else 0.0:.6f}",
        metric.note,
    ]


def _reading(item) -> str:
    date = normalize_date(getattr(item, "date", None)) or "?"
    amount = getattr(item, "amount", None)
    return f"{date}/{amount if amount is not None else '?'}"


def _side(items) -> str:
    values = [_reading(item) for item in items or []]
    if not values:
        return "なし"
    return ", ".join(values[:MAX_READINGS])


def _answer_text(expected: list[dict]) -> str:
    values = []
    for receipt in expected:
        date = normalize_date(receipt.get(FIELD_DATE)) or "?"
        amount = _text(receipt.get(FIELD_AMOUNT)) or "?"
        values.append(f"{date}/{amount}")
    return ", ".join(values)


def _reading_text(result: FileResult) -> str:
    file = result.file
    parts = [f"主画像={_side(file.image_items or [])}"]
    if result.form in (FORM_CURRENT, FORM_B):
        parts.append(f"主文字={_side(file.text_items or [])}")
    if result.form == FORM_A2 or (result.form == FORM_B and result.called):
        parts.append(f"もう1人={_side(file.readers.get(result.reader) or [])}")
    return " ｜ ".join(parts)


def _detail_row(result: FileResult) -> list:
    file = result.file
    judgment = "・".join(label if label else "一致" for label in result.labels)
    if result.form == FORM_CURRENT:
        called = ""
    else:
        called = "はい" if result.called else "いいえ"
    return [
        file.file_id,
        f"https://drive.google.com/file/d/{file.file_id}/view",
        file.file_name,
        result.form,
        result.reader or "",
        result.grade,
        len(result.flags),
        sum(1 for flag in result.flags if flag),
        judgment,
        _reading_text(result),
        _answer_text(result.expected),
        called,
    ]


def build_form_tables(
    *,
    result_rows: list[dict],
    ocr_rows: list[dict],
    answer_rows: list[dict],
    multi_rows: list[dict] | None,
    base_label: str | None,
    ocr_price_per_page: float,
    label: str,
    now_text: str,
) -> FormTables | None:
    """形の 2 つのタブの行を作る。主の読み手が無ければ None（タブを作らない）。"""
    if not base_label:
        return None
    rows = bottom_rows(result_rows)
    base_image_files = {
        _text(row.get("fileId"))
        for row in rows
        if _text(row.get("型")) == base_label and _text(row.get("方式")) == METHOD_IMAGE
    }
    if not base_image_files:
        return None

    files, readers = build_inputs(result_rows, ocr_rows, base_label)
    expected = _answers(answer_rows, multi_rows, [file.file_id for file in files])

    all_results: list[FileResult] = []
    metrics: list[FormMetric] = []

    missing_base = len(base_image_files) - len(files)
    current_results = [_current(file, expected[file.file_id]) for file in files]
    all_results.extend(current_results)

    def current_cost(result: FileResult):
        image, image_absent = _cost(result.file, base_label, METHOD_IMAGE)
        text, text_absent = _cost(result.file, base_label, METHOD_TEXT)
        vision = result.file.page_count * ocr_price_per_page
        return image + text + vision, image_absent + text_absent

    old_ocr = sum(1 for file in files if file.has_ocr_row and not file.page_count_known)
    missing_ocr = sum(1 for file in files if not file.has_ocr_row)
    uncomparable_dual = sum(
        1
        for file, result in zip(files, current_results, strict=True)
        if file.dual_saved
        and (file.dual_flags is None or len(file.dual_flags) != len(result.flags))
    )
    current_note = []
    if missing_base:
        current_note.append(f"主の読みがそろわないファイル {missing_base}")
    if old_ocr:
        current_note.append(f"ページ数の無い古いOCRタブ {old_ocr}（1 ページで数えた）")
    if missing_ocr:
        current_note.append(f"OCR の行が無いファイル {missing_ocr}")
    if uncomparable_dual:
        current_note.append(f"両読みの保存と比べられないファイル {uncomparable_dual}")
    mismatch = _dual_mismatches(files, current_results)
    if mismatch:
        current_note.append(f"両読みの保存と違うファイル {mismatch}")
    metrics.append(
        _metric(
            FORM_CURRENT,
            None,
            current_results,
            called_files=None,
            cost_per_file=current_cost,
            note="、".join(current_note),
        )
    )

    for reader in readers:
        a2_results = [
            _a2(file, reader, expected[file.file_id]) for file in files if reader in file.readers
        ]
        missing = len(files) - len(a2_results)
        note = []
        if missing:
            note.append(f"もう1人の読みが無いファイル {missing}")
        metrics.append(
            _metric(
                FORM_A2,
                reader,
                a2_results,
                called_files=len(a2_results),
                cost_per_file=lambda result, r=reader: _a2_cost(result, base_label, r),
                note="、".join(note),
            )
        )
        all_results.extend(a2_results)

        b_results = [
            _b(file, reader, expected[file.file_id]) for file in files if reader in file.readers
        ]
        b_note = []
        if missing:
            b_note.append(f"もう1人の読みが無いファイル {missing}")
        metrics.append(
            _metric(
                FORM_B,
                reader,
                b_results,
                called_files=sum(1 for result in b_results if result.called),
                cost_per_file=lambda result, r=reader, b=b_results: _b_cost(
                    result, base_label, r, ocr_price_per_page
                ),
                note="、".join(b_note),
            )
        )
        all_results.extend(b_results)

    summary = [
        ["実行ラベル", label],
        ["集計時刻", now_text],
        ["主の読み手", base_label],
        [""],
        list(FORM_HEADERS),
    ]
    for metric in metrics:
        summary.append(_metric_row(metric))
    detail = [list(FORM_DETAIL_HEADERS)]
    for result in all_results:
        detail.append(_detail_row(result))

    return FormTables(
        base_label=base_label,
        readers=readers,
        metrics=metrics,
        file_results=all_results,
        summary_rows=summary,
        detail_rows=detail,
    )


def _a2_cost(result: FileResult, base_label: str, reader: str) -> tuple[float, int]:
    image, image_absent = _cost(result.file, base_label, METHOD_IMAGE)
    other, other_absent = _cost(result.file, reader, METHOD_IMAGE)
    return image + other, image_absent + other_absent


def _b_cost(
    result: FileResult, base_label: str, reader: str, ocr_price_per_page: float
) -> tuple[float, int]:
    image, image_absent = _cost(result.file, base_label, METHOD_IMAGE)
    text, text_absent = _cost(result.file, base_label, METHOD_TEXT)
    vision = result.file.page_count * ocr_price_per_page
    other, other_absent = (0.0, 0)
    if result.called:
        other, other_absent = _cost(result.file, reader, METHOD_IMAGE)
    return image + text + vision + other, image_absent + text_absent + other_absent


def _dual_mismatches(files: list[ReadingFile], results: list[FileResult]) -> int:
    count = 0
    for file, result in zip(files, results, strict=True):
        if file.dual_flags is None or len(file.dual_flags) != len(result.flags):
            continue
        if any(saved != computed for saved, computed in zip(file.dual_flags, result.flags)):
            count += 1
    return count

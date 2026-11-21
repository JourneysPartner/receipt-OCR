"""1 ファイルの読み取り結果の組み立てと「現行の流れ」（仕様 §8）。

ここでは API を呼ばない。読み取りそのもの（Gemini）は runner が行い、
その結果（items / last_extraction_error / last_call_info）をこのモジュールで
表の行と現行の流れに組み立てる。
"""

import json
import time
from dataclasses import dataclass, field

from src.compare.config import METHOD_LABELS
from src.compare.normalize import (
    extract_amount,
    extract_date,
    extract_tax,
    extract_vendor,
    normalize_date,
    normalize_tax,
)
from src.config import AiConfig
from src.models import CorrectedItem, OcrResult, ReceiptItem
from src.processing.manager import ProcessingManager
from src.processing.reconcile import ItemDecision, reconcile
from src.rules.amount_validation import validate_amount
from src.rules.corrections import RuleCorrector

RETRYABLE_MARKERS = (
    "429",
    "500",
    "502",
    "503",
    "504",
    "resource_exhausted",
    "unavailable",
    "deadline_exceeded",
    "internal",
    "timeout",
    "timed out",
)

DEFAULT_RETRY_SLEEPS = (10, 30, 60)
RETRYABLE_CODES = (429, 500, 502, 503, 504, 529)  # 529 は Anthropic の混雑（§14.4）

METHOD_TEXT = "text"
METHOD_IMAGE = "image"
METHOD_CURRENT = "current"
METHOD_DUAL = "dual"

# 明細JSON の上限（これを超えたら空にして「エラー詳細」に理由を残す）
MAX_ITEMS_JSON = 40000
ITEMS_JSON_TOO_LONG = "明細JSONが長すぎる"


@dataclass
class AttemptOutcome:
    """1 回の Gemini 呼び出しの結果。"""

    items: list[ReceiptItem] = field(default_factory=list)
    error: str | None = None
    info: dict | None = None


@dataclass
class CompareRow:
    """結果_<ラベル> の 1 行。"""

    run_label: str
    recorded_at: str
    file_id: str
    folder_name: str
    file_name: str
    model_label: str
    model_name: str
    method: str
    result: str
    finish_reason: str = ""
    retries: int = 0
    count: int = 0
    date: str = ""
    amount: int | None = None
    tax: str = ""
    vendor: str = ""
    description: str = ""
    accounts: str = ""
    confidence: str = ""
    amount_validation: str = ""
    latency_ms: int | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    thinking_tokens: int | None = None
    cost_usd: float | None = None
    settings: str = ""
    error_detail: str = ""
    raw_text: str = ""
    items_json: str = ""
    items: list = field(default_factory=list, repr=False)

    @property
    def file_url(self) -> str:
        return f"https://drive.google.com/file/d/{self.file_id}/view"

    def to_sheet_row(self) -> list:
        return [
            self.run_label,
            self.recorded_at,
            self.file_id,
            self.file_url,
            self.folder_name,
            self.file_name,
            self.model_label,
            self.method,
            self.result,
            self.finish_reason,
            self.retries,
            self.count,
            self.date,
            self.amount if self.amount is not None else "",
            self.tax,
            self.vendor,
            self.description,
            self.accounts,
            self.confidence,
            self.amount_validation,
            self.latency_ms if self.latency_ms is not None else "",
            self.input_tokens if self.input_tokens is not None else "",
            self.output_tokens if self.output_tokens is not None else "",
            self.thinking_tokens if self.thinking_tokens is not None else "",
            f"{self.cost_usd:.6f}" if self.cost_usd is not None else "",
            self.settings,
            self.error_detail,
            self.raw_text,
            self.items_json,
        ]


def settings_text(
    temperature: float | None,
    thinking_level: str | None,
    max_tokens: int,
    prompt_version: str = "v1",
) -> str:
    temperature_text = "none" if temperature is None else f"{temperature:g}"
    thinking_text = thinking_level or "なし"
    text = f"temperature={temperature_text}, thinking={thinking_text}, max_tokens={max_tokens}"
    if prompt_version and prompt_version != "v1":
        text += f", prompt={prompt_version}"
    return text


def _json_amount(value) -> int | None:
    """明細JSON の金額（整数だけ。bool とその他の型は null）。"""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _matched(decision) -> bool:
    """ItemDecision（または真偽値）が「自動で書いてよい」か。"""
    return bool(getattr(decision, "matched", decision))


# 計算の欄（仕様 review_precision §6.1・§6.6）。None は書かない。
CALC_ITEM_KEYS = (
    ("pt", "pretax"),
    ("tx", "tax"),
    ("td", "tendered"),
    ("ch", "change"),
)


def _calc_value(item, name: str) -> int | None:
    """補正後の明細でも、補正前の明細から計算の欄を読む。"""
    value = getattr(item, name, None)
    if value is None:
        original = getattr(item, "original", None)
        if original is not None:
            value = getattr(original, name, None)
    return _json_amount(value)


def items_json(items, decisions=None) -> str:
    """明細を 1 つの JSON 文字列にする（設計 §7.3）。明細なし・4 万字超えは空。"""
    if not items:
        return ""
    data: list[dict] = []
    for index, item in enumerate(items):
        entry = {
            "d": normalize_date(getattr(item, "date", None)),
            "a": _json_amount(getattr(item, "amount", None)),
            "t": "・".join(normalize_tax(getattr(item, "tax_category", None))),
            "v": str(getattr(item, "vendor", "") or ""),
            "s": str(getattr(item, "description", "") or ""),
            "c": str(getattr(item, "account", "") or ""),
        }
        if decisions is not None:
            decision = decisions[index] if index < len(decisions) else None
            entry["r"] = "自動" if _matched(decision) else "要確認"
        for key, name in CALC_ITEM_KEYS:
            value = _calc_value(item, name)
            if value is not None:
                entry[key] = value
        data.append(entry)
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if len(text) > MAX_ITEMS_JSON:
        return ""
    return text


def _error_detail(base: str, too_long: bool) -> str:
    text = str(base or "")[:300]
    if not too_long:
        return text
    return (text + " " + ITEMS_JSON_TOO_LONG).strip()


def is_retryable(outcome: AttemptOutcome) -> bool:
    if outcome.error != "api_error":
        return False
    info = outcome.info if isinstance(outcome.info, dict) else {}
    code = info.get("error_code")
    if isinstance(code, int) and not isinstance(code, bool):
        # 例外に整数の code があれば、その値だけで決める（本文の数字に頼らない）
        return code in RETRYABLE_CODES
    detail = str(info.get("error") or "")
    lowered = detail.lower()
    return any(marker in lowered for marker in RETRYABLE_MARKERS)


def extract_with_retries(
    call,
    *,
    sleeps=DEFAULT_RETRY_SLEEPS,
    sleep=time.sleep,
    should_stop=None,
) -> tuple[AttemptOutcome, int]:
    """429 / 5xx 系だけを 10・30・60 秒待って最大 3 回やり直す。

    should_stop が真を返したら（時間切れ）、待たずにその回で終える。
    """
    retries = 0
    while True:
        outcome = call()
        if not is_retryable(outcome) or retries >= len(sleeps):
            return outcome, retries
        if should_stop is not None and should_stop():
            return outcome, retries
        sleep(sleeps[retries])
        retries += 1


def extract_once(extractor, method: str, ocr: OcrResult, file) -> AttemptOutcome:
    """アダプタ: 抽出器の戻り値と last_* を AttemptOutcome にそろえる。"""
    if method == METHOD_TEXT:
        items = extractor.extract_receipt_data(ocr, file.file_name)
    else:
        items = extractor.extract_from_file(file)
    return AttemptOutcome(
        items=list(items or []),
        error=getattr(extractor, "last_extraction_error", None),
        info=getattr(extractor, "last_call_info", None),
    )


def _present(items) -> dict:
    """明細（ReceiptItem / CorrectedItem）から表に書く値を組み立てる。"""
    if not items:
        return {
            "count": 0,
            "date": "",
            "amount": None,
            "tax": "",
            "vendor": "",
            "description": "",
            "accounts": "",
            "confidence": "",
        }
    descriptions = [
        str(getattr(item, "description", "") or "").strip()
        for item in items
        if str(getattr(item, "description", "") or "").strip()
    ]
    accounts: list[str] = []
    for item in items:
        account = str(getattr(item, "account", "") or "").strip()
        if account and account not in accounts:
            accounts.append(account)
    confidences = [float(getattr(item, "confidence", 0.0) or 0.0) for item in items]
    return {
        "count": len(items),
        "date": extract_date(items),
        "amount": extract_amount(items),
        "tax": extract_tax(items),
        "vendor": extract_vendor(items),
        "description": " / ".join(descriptions)[:200],
        "accounts": "・".join(accounts),
        "confidence": f"{min(confidences):.2f}",
    }


def amount_validation_text(items, ocr_text: str) -> str:
    if not ocr_text.strip():
        return "OCRなし"
    statuses = [validate_amount(getattr(item, "amount", None), ocr_text).status for item in items]
    return "・".join(statuses)


def _blank_text(value) -> bool:
    return value is None or not str(value).strip()


def make_result_row(
    *,
    run_label: str,
    recorded_at: str,
    file,
    folder_name: str,
    model_label: str,
    model_name: str,
    method: str,
    outcome: AttemptOutcome,
    retries: int,
    settings: str,
    ocr_text: str,
) -> CompareRow:
    """文字から / 画像からの 1 行。"""
    items = outcome.items
    info = outcome.info if isinstance(outcome.info, dict) else {}
    presented = _present(items)
    if items:
        result = "成功"
    elif method == METHOD_TEXT and outcome.error == "ocr_failed":
        result = "失敗:ocr_failed"
    elif (
        outcome.error == "api_error"
        and info.get("error") is None
        and _blank_text(info.get("raw_text"))
    ):
        # API は答えたが出力の上限などで本文が空。やり直しても同じなので分ける（§5.5）
        # 本文があるのに読めない（例 ["a"]）ときは api_error のまま
        result = "失敗:empty_response"
    else:
        result = f"失敗:{outcome.error or 'unknown'}"
    error_text = info.get("error")
    items_json_text = items_json(items)
    return CompareRow(
        run_label=run_label,
        recorded_at=recorded_at,
        file_id=file.file_id,
        folder_name=folder_name,
        file_name=file.file_name,
        model_label=model_label,
        model_name=model_name,
        method=METHOD_LABELS[method],
        result=result,
        finish_reason=str(info.get("finish_reason") or ""),
        retries=retries,
        count=presented["count"],
        date=presented["date"],
        amount=presented["amount"],
        tax=presented["tax"],
        vendor=presented["vendor"],
        description=presented["description"],
        accounts=presented["accounts"],
        confidence=presented["confidence"],
        amount_validation=amount_validation_text(items, ocr_text) if items else "",
        latency_ms=info.get("latency_ms"),
        input_tokens=info.get("prompt_tokens"),
        output_tokens=info.get("output_tokens"),
        thinking_tokens=info.get("thinking_tokens"),
        settings=settings,
        error_detail=_error_detail(error_text, bool(items) and not items_json_text),
        raw_text=str(info.get("raw_text") or "")[:2000],
        items_json=items_json_text,
        items=list(items),
    )


def _sum_optional(values: list[int | None]) -> int | None:
    if all(value is None for value in values):
        return None
    return sum(int(value or 0) for value in values)


def build_current_flow_row(
    *,
    run_label: str,
    recorded_at: str,
    file,
    folder_name: str,
    model_label: str,
    model_name: str,
    text_row: CompareRow,
    image_row: CompareRow,
    ocr_text: str,
    ai_config: AiConfig,
    settings: str,
    ocr_failed: bool = False,
) -> CompareRow:
    """本番 `ProcessingManager._process_file` の判断を API を追加で呼ばずにまねる。"""
    if ocr_failed:
        # 本番は OCR が失敗か空なら AI を一度も呼ばずに要手入力にする（§8）
        return CompareRow(
            run_label=run_label,
            recorded_at=recorded_at,
            file_id=file.file_id,
            folder_name=folder_name,
            file_name=file.file_name,
            model_label=model_label,
            model_name=model_name,
            method=METHOD_LABELS[METHOD_CURRENT],
            result="要手入力",
            retries=0,
            count=0,
            amount_validation="OCR失敗",
            latency_ms=0,
            input_tokens=0,
            output_tokens=0,
            thinking_tokens=0,
            cost_usd=0.0,
            settings=settings,
        )

    text_items = list(text_row.items)
    image_items = list(image_row.items)

    used: list[ReceiptItem] = []
    statuses: list[str] = []
    manual = 0
    total = 0
    image_called = False

    if not text_items:
        if ai_config.enable_extraction_retry:
            image_called = True
            source_items = image_items
            total = len(source_items)
            for item in source_items:
                validation = validate_amount(item.amount, ocr_text)
                statuses.append(f"画像:{validation.status}")
                if validation.should_manual_entry:
                    manual += 1
                else:
                    used.append(item)
            if not source_items:
                statuses.append("文字:なし→画像:なし")
        else:
            statuses.append("文字:なし")
    else:
        total = len(text_items)
        for idx, item in enumerate(text_items):
            validation = validate_amount(item.amount, ocr_text)
            if not validation.should_manual_entry:
                used.append(item)
                statuses.append(f"文字:{validation.status}")
                continue
            if not ai_config.enable_amount_validation_retry:
                manual += 1
                statuses.append(f"文字:{validation.status}")
                continue
            image_called = True
            retry_item = ProcessingManager._select_retry_item(image_items, idx, total)
            if retry_item is None:
                manual += 1
                statuses.append(f"文字:{validation.status}→画像:対応なし")
                continue
            retry_validation = validate_amount(retry_item.amount, ocr_text)
            if retry_validation.is_valid:
                used.append(retry_item)
                statuses.append(f"文字:{validation.status}→画像:{retry_validation.status}")
            else:
                manual += 1
                statuses.append(f"文字:{validation.status}→画像:{retry_validation.status}")

    corrector = RuleCorrector(confidence_threshold=ai_config.confidence_threshold)
    corrected: list[CorrectedItem] = [corrector.apply(item) for item in used]
    presented = _present(corrected)

    if total == 0 or not used:
        result = "要手入力"
    elif manual > 0:
        result = "一部要手入力"
    else:
        result = "自動"

    metadata_rows = [text_row] + ([image_row] if image_called else [])
    return CompareRow(
        run_label=run_label,
        recorded_at=recorded_at,
        file_id=file.file_id,
        folder_name=folder_name,
        file_name=file.file_name,
        model_label=model_label,
        model_name=model_name,
        method=METHOD_LABELS[METHOD_CURRENT],
        result=result,
        finish_reason=text_row.finish_reason or (image_row.finish_reason if image_called else ""),
        retries=sum(row.retries for row in metadata_rows),
        count=total,
        date=presented["date"],
        amount=presented["amount"],
        tax=presented["tax"],
        vendor=presented["vendor"],
        description=presented["description"],
        accounts=presented["accounts"],
        confidence=presented["confidence"],
        amount_validation="・".join(statuses),
        latency_ms=_sum_optional([row.latency_ms for row in metadata_rows]),
        input_tokens=_sum_optional([row.input_tokens for row in metadata_rows]),
        output_tokens=_sum_optional([row.output_tokens for row in metadata_rows]),
        thinking_tokens=_sum_optional([row.thinking_tokens for row in metadata_rows]),
        settings=settings,
        items_json=items_json(corrected, [ItemDecision(True, "", "", None) for _ in corrected]),
        items=list(corrected),
    )


def build_dual_row(
    *,
    run_label: str,
    recorded_at: str,
    file,
    folder_name: str,
    model_label: str,
    model_name: str,
    text_row: CompareRow,
    image_row: CompareRow,
    ocr_text: str,
    ai_config: AiConfig,
    settings: str,
    ocr_failed: bool = False,
) -> CompareRow:
    """両読み（設計 §7.3）。本番と同じ `reconcile` で決め、API は呼ばない。"""
    image_items = list(image_row.items)
    text_items = [] if ocr_failed else list(text_row.items)

    if not image_items and not text_items:
        result = "要確認"
        decisions: list[ItemDecision] = []
        items: list = []
        amount_validation = "読みなし"
    else:
        if not image_items:
            # 画像からの読みが無い（T だけがある）
            items = text_items
            decisions = [
                ItemDecision(False, "※読み取り要確認", "画像からの読みが無い", None) for _ in items
            ]
        else:
            items = image_items
            decisions = reconcile(image_items, text_items, "" if ocr_failed else ocr_text)
        matched = sum(1 for decision in decisions if decision.matched)
        if matched == len(decisions):
            result = "自動"
        elif matched:
            result = "一部要確認"
        else:
            result = "要確認"
        amount_validation = "・".join(
            "一致" if decision.matched else decision.label for decision in decisions
        )

    corrector = RuleCorrector(confidence_threshold=ai_config.confidence_threshold)
    corrected: list[CorrectedItem] = [corrector.apply(item) for item in items]
    presented = _present(corrected)
    items_json_text = items_json(corrected, decisions)

    metadata_rows = [image_row, text_row]
    return CompareRow(
        run_label=run_label,
        recorded_at=recorded_at,
        file_id=file.file_id,
        folder_name=folder_name,
        file_name=file.file_name,
        model_label=model_label,
        model_name=model_name,
        method=METHOD_LABELS[METHOD_DUAL],
        result=result,
        finish_reason=image_row.finish_reason or text_row.finish_reason,
        retries=sum(row.retries for row in metadata_rows),
        count=len(items),
        date=presented["date"],
        amount=presented["amount"],
        tax=presented["tax"],
        vendor=presented["vendor"],
        description=presented["description"],
        accounts=presented["accounts"],
        confidence=presented["confidence"],
        amount_validation=amount_validation,
        latency_ms=_sum_optional([row.latency_ms for row in metadata_rows]),
        input_tokens=_sum_optional([row.input_tokens for row in metadata_rows]),
        output_tokens=_sum_optional([row.output_tokens for row in metadata_rows]),
        thinking_tokens=_sum_optional([row.thinking_tokens for row in metadata_rows]),
        settings=settings,
        error_detail=_error_detail("", bool(corrected) and not items_json_text),
        items_json=items_json_text,
        items=list(corrected),
    )

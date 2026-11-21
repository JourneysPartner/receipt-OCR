"""読み取った文を明細にする（仕様 §6.4）。

Gemini・Anthropic・OpenAI の 3 つの読み手が、この同じ関数で応答文を
`ReceiptItem` の並びにする。動きは今までの `GeminiExtractor._parse_response`
と `_safe_int` から 1 つも変えない。
"""

import json

from src.logging.logger import setup_logger
from src.models import ReceiptItem

logger = setup_logger()


def _safe_int(value) -> int | None:
    if value is None:
        return None
    try:
        cleaned = str(value).replace(",", "").replace("円", "").replace("¥", "").strip()
        return int(float(cleaned))
    except (ValueError, TypeError):
        return None


def _optional_amount(value) -> int | None:
    """計算の欄（仕様 §6.1）。無い・整数でない・真偽値・負の数は None。"""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0:
        return None
    return value


def parse_receipt_items(
    raw: str, file_name: str, *, read_calc_fields: bool = False
) -> tuple[list[ReceiptItem], str | None]:
    """応答文を明細の並びにする。戻り値は (明細, 失敗の種類か None)。

    `read_calc_fields` は既定で偽（指示文が v1・v2 のとき）。真にするのは v3 の
    呼び出しだけ（仕様 §14.4）。偽のときは計算の 4 欄を常に None にする。
    """
    text = raw
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:])
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        logger.warning(f"JSONパース失敗: {file_name}: {e}", extra={"step": "ai_parse"})
        return [], "parse_error"

    if isinstance(data, dict):
        data = [data]

    items: list[ReceiptItem] = []
    for entry in data:
        try:
            items.append(
                ReceiptItem(
                    date=entry.get("date"),
                    amount=_safe_int(entry.get("amount")),
                    time=entry.get("time"),
                    receipt_no=entry.get("receipt_no"),
                    vendor=entry.get("vendor"),
                    description=entry.get("description"),
                    account=entry.get("account"),
                    tax_category=entry.get("tax_category"),
                    confidence=float(entry.get("confidence", 0.0)),
                    is_expense=entry.get("is_expense", True),
                    memo=entry.get("memo"),
                    pretax=_optional_amount(entry.get("pretax")) if read_calc_fields else None,
                    tax=_optional_amount(entry.get("tax")) if read_calc_fields else None,
                    tendered=(
                        _optional_amount(entry.get("tendered")) if read_calc_fields else None
                    ),
                    change=_optional_amount(entry.get("change")) if read_calc_fields else None,
                )
            )
        except (ValueError, TypeError) as e:
            logger.warning(f"明細パース失敗: {file_name}: {e}", extra={"step": "ai_parse"})
    if not items:
        return items, "zero_items"
    return items, None

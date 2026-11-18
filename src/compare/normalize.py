"""値のそろえ方と一致の判定（仕様 §7）。"""

import re
import unicodedata
from datetime import date

_DATE_PATTERNS = (
    re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})$"),
    re.compile(r"^(\d{4})/(\d{1,2})/(\d{1,2})$"),
    re.compile(r"^(\d{4})\.(\d{1,2})\.(\d{1,2})$"),
    re.compile(r"^(\d{4})年(\d{1,2})月(\d{1,2})日$"),
)

_AMOUNT_STRIP_RE = re.compile(r"[¥￥,，円\s\u3000]")

_CORP_WORDS = ("株式会社", "有限会社", "合同会社", "(株)", "(有)", "㈱", "㈲")
_VENDOR_SYMBOLS = set("・-‐－ー—–_.,，。、'\"()（）「」[]【】/／&＆")

_TAX_ORDER = ("8%", "10%", "非課税", "対象外", "不明")
_TAX_SPLIT_RE = re.compile(r"[・,，、/／]")
_TAX_10_RE = re.compile(r"(?<!\d)10(?!\d)")
_TAX_8_RE = re.compile(r"(?<!\d)8(?!\d)")

FIELD_DATE = "日付"
FIELD_AMOUNT = "金額"
FIELD_TAX = "税率"
FIELD_VENDOR = "店名"
FIELDS = (FIELD_DATE, FIELD_AMOUNT, FIELD_TAX, FIELD_VENDOR)


def normalize_date(value) -> str:
    """読める日付は YYYY-MM-DD、読めなければ前後の空白を除いたそのまま。"""
    if value is None:
        return ""
    text = unicodedata.normalize("NFKC", str(value)).strip()
    if not text:
        return ""
    for pattern in _DATE_PATTERNS:
        m = pattern.match(text)
        if not m:
            continue
        year, month, day = (int(x) for x in m.groups())
        try:
            parsed = date(year, month, day)
        except ValueError:
            return text
        return parsed.isoformat()
    return text


def parse_amount_cell(value) -> int | None:
    """表の金額を整数にする（¥・￥・,・円・空白を除く。1234.0 も 1234）。"""
    if value is None:
        return None
    text = unicodedata.normalize("NFKC", str(value))
    text = _AMOUNT_STRIP_RE.sub("", text)
    if not text:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def normalize_tax(value) -> list[str]:
    """税率の文字列を 8% / 10% / 非課税 / 対象外 / 不明 の並びにする。"""
    if value is None:
        return []
    text = unicodedata.normalize("NFKC", str(value)).strip()
    if not text:
        return []
    if "非課税" in text:
        return ["非課税"]
    if "対象外" in text or "不課税" in text:
        return ["対象外"]
    found: set[str] = set()
    if _TAX_10_RE.search(text):
        found.add("10%")
    if _TAX_8_RE.search(text):
        found.add("8%")
    if not found:
        return ["不明"]
    return [token for token in _TAX_ORDER if token in found]


def parse_tax_cell(value) -> list[str]:
    """表の税率セルを区切って同じ規則を当てる（`10` だけでも `10%`）。"""
    if value is None:
        return []
    text = unicodedata.normalize("NFKC", str(value)).strip()
    if not text:
        return []
    found: set[str] = set()
    for part in _TAX_SPLIT_RE.split(text):
        found.update(normalize_tax(part))
    return [token for token in _TAX_ORDER if token in found]


def normalize_vendor(value) -> str:
    """NFKC → 小文字 → 法人格と空白・記号を除く。"""
    if value is None:
        return ""
    text = unicodedata.normalize("NFKC", str(value)).lower()
    for word in _CORP_WORDS:
        text = text.replace(word, "")
    return "".join(ch for ch in text if not ch.isspace() and ch not in _VENDOR_SYMBOLS)


def vendor_matches(left, right) -> bool:
    a = normalize_vendor(left)
    b = normalize_vendor(right)
    if not a or not b:
        return False
    if a == b:
        return True
    short, long = (a, b) if len(a) <= len(b) else (b, a)
    return len(short) >= 2 and short in long


def extract_date(items) -> str:
    values: list[str] = []
    for item in items:
        normalized = normalize_date(getattr(item, "date", None))
        if normalized and normalized not in values:
            values.append(normalized)
    return "・".join(values)


def extract_amount(items) -> int | None:
    amounts = [getattr(item, "amount", None) for item in items]
    if not amounts or any(amount is None for amount in amounts):
        return None
    return sum(amounts)


def extract_tax(items) -> str:
    found: set[str] = set()
    for item in items:
        found.update(normalize_tax(getattr(item, "tax_category", None)))
    return "・".join(token for token in _TAX_ORDER if token in found)


def extract_vendor(items) -> str:
    """最初の明細の vendor をそのまま（無ければ空）。"""
    if not items:
        return ""
    vendor = getattr(items[0], "vendor", None)
    return "" if vendor is None else str(vendor)


def field_values_agree(field: str, values: list) -> bool:
    """この欄の値が全部そろって一致しているか（値なしは一致にしない）。"""
    if len(values) < 2:
        return False
    if field == FIELD_DATE:
        normalized = [normalize_date(value) for value in values]
        return all(normalized) and len(set(normalized)) == 1
    if field == FIELD_AMOUNT:
        parsed = [parse_amount_cell(value) for value in values]
        return all(value is not None for value in parsed) and len(set(parsed)) == 1
    if field == FIELD_TAX:
        parsed_tax = [parse_tax_cell(value) for value in values]
        return all(parsed_tax) and all(value == parsed_tax[0] for value in parsed_tax)
    if field == FIELD_VENDOR:
        normalized = [normalize_vendor(value) for value in values]
        if not all(normalized):
            return False
        return all(
            vendor_matches(values[i], values[j])
            for i in range(len(values))
            for j in range(i + 1, len(values))
        )
    return False


def value_matches_answer(field: str, value, answer) -> bool:
    """1 つの行の値が答えと合うか。"""
    if field == FIELD_DATE:
        normalized_value = normalize_date(value)
        normalized_answer = normalize_date(answer)
        return bool(normalized_value) and normalized_value == normalized_answer
    if field == FIELD_AMOUNT:
        parsed_value = parse_amount_cell(value)
        parsed_answer = parse_amount_cell(answer)
        return parsed_value is not None and parsed_value == parsed_answer
    if field == FIELD_TAX:
        parsed_value = parse_tax_cell(value)
        return bool(parsed_value) and parsed_value == parse_tax_cell(answer)
    if field == FIELD_VENDOR:
        return vendor_matches(value, answer)
    return False

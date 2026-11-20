"""重複したレシートの見分け（仕様 `docs/spec_duplicates.md` §3–§5）。

API もファイルも触らない純粋な関数だけを置く。店名の合い方は比較の道具と
同じ `vendor_matches` を使う。ここでは「同じ証憑か」と、同じファイルの中で
2 枚目以降にあたる明細の番号を返す。
"""

import re
import unicodedata
from dataclasses import dataclass
from datetime import date as date_type

from src.compare.normalize import parse_amount_cell, vendor_matches
from src.models import ReceiptDetails

# 同じファイルの中で 2 枚目以降の行の O 列に書く文（仕様 §5）
SAME_FILE_DUPLICATE_NOTE = "同じ内容の行があります（二重スキャンかも）"

_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})$")
_RECEIPT_NO_STRIP = set("-‐－ー")
_RECEIPT_NO_SPACE = set(" \t\r\n\u3000")


@dataclass(frozen=True)
class ReceiptSource:
    """同じ証憑かを照らす 1 枚分の値。"""

    file_id: str
    file_name: str
    index: int
    date: str = ""
    time: str = ""
    amount: int | None = None
    vendor: str = ""
    receipt_no: str = ""

    @property
    def key(self) -> str:
        """`duplicateOf` に書く `<ファイル ID>:<番号>`。"""
        return f"{self.file_id}:{self.index}"

    @property
    def drive_link(self) -> str:
        return f"https://drive.google.com/file/d/{self.file_id}/view"


def _value(item, name: str):
    if isinstance(item, dict):
        return item.get(name)
    return getattr(item, name, None)


def _clean_text(value) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    # 表に書くときの先頭のアポストロフィ（文字列として保存するため）
    if text.startswith("'"):
        text = text[1:]
    return text


def normalize_time(value) -> str:
    """`H:MM`・`HH:MM` を `HH:MM` にそろえる。読めなければ空。"""
    text = unicodedata.normalize("NFKC", _clean_text(value))
    match = _TIME_RE.match(text)
    if not match:
        return ""
    hour, minute = (int(part) for part in match.groups())
    if hour > 23 or minute > 59:
        return ""
    return f"{hour:02d}:{minute:02d}"


def normalize_receipt_no(value) -> str:
    """NFKC → 空白とハイフン類を除く → 英字を大文字に。"""
    text = unicodedata.normalize("NFKC", _clean_text(value))
    kept = [
        char for char in text if char not in _RECEIPT_NO_SPACE and char not in _RECEIPT_NO_STRIP
    ]
    return "".join(kept).upper()


def _date_of(item) -> str:
    """YYYY-MM-DD の形そのものの実在する日付だけを返す（それ以外は空）。"""
    text = _clean_text(_value(item, "date"))
    if not _ISO_DATE_RE.match(text):
        return ""
    try:
        parsed = date_type.fromisoformat(text)
    except ValueError:
        return ""
    if parsed.isoformat() != text:
        return ""
    return text


def _amount_of(item) -> int | None:
    """1 以上の整数の金額だけを返す（bool・0 以下・読めない値は金額なし）。"""
    raw = _value(item, "amount")
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw if raw >= 1 else None
    parsed = parse_amount_cell(_clean_text(raw))
    if parsed is None or parsed < 1:
        return None
    return parsed


def is_same_voucher(left, right) -> bool:
    """2 枚が同じ証憑か（仕様 §3）。読めない日付・金額は「同じ」にしない。"""
    left_date = _date_of(left)
    right_date = _date_of(right)
    if not left_date or not right_date or left_date != right_date:
        return False

    left_amount = _amount_of(left)
    right_amount = _amount_of(right)
    if left_amount is None or right_amount is None or left_amount != right_amount:
        return False

    if not vendor_matches(_value(left, "vendor"), _value(right, "vendor")):
        return False

    left_time = normalize_time(_value(left, "time"))
    right_time = normalize_time(_value(right, "time"))
    if left_time and right_time and left_time != right_time:
        return False

    left_no = normalize_receipt_no(_value(left, "receipt_no"))
    right_no = normalize_receipt_no(_value(right, "receipt_no"))
    if left_no and right_no and left_no != right_no:
        return False

    return True


def same_file_duplicate_indices(items) -> set[int]:
    """同じファイルの中で、前の明細と同じ証憑になる明細の番号を返す（§5）。"""
    values = list(items)
    duplicates: set[int] = set()
    for index, item in enumerate(values):
        for earlier in range(index):
            if is_same_voucher(item, values[earlier]):
                duplicates.add(index)
                break
    return duplicates


def details_of(item, fallback=None) -> ReceiptDetails:
    """明細から、処理管理に書く値を取り出す。

    `fallback` を渡すと、空の欄だけそちらで埋める（両読みの文字からの値）。
    """

    def pick(name: str, default=""):
        own = _value(item, name)
        other = _value(fallback, name) if fallback is not None else None
        if name == "amount":
            if own is not None:
                return own
            return other
        own_text = _clean_text(own)
        if own_text:
            return own_text
        return _clean_text(other) or default

    amount = pick("amount")
    if isinstance(amount, bool) or not isinstance(amount, int):
        amount = parse_amount_cell(_clean_text(amount))

    return ReceiptDetails(
        date=pick("date"),
        time=pick("time"),
        amount=amount,
        vendor=pick("vendor"),
        receipt_no=pick("receipt_no"),
    )


def source_of(
    file_id: str,
    file_name: str,
    index: int,
    details: ReceiptDetails,
) -> ReceiptSource:
    return ReceiptSource(
        file_id=file_id,
        file_name=file_name,
        index=index,
        date=details.date,
        time=details.time,
        amount=details.amount,
        vendor=details.vendor,
        receipt_no=details.receipt_no,
    )


def description_line(duplicate_index: int, source: ReceiptSource) -> str:
    """Drive の説明欄に足す 1 行（§6.3）。番号は人が読む 1 始まり。"""
    return (
        f"重複: {duplicate_index + 1} 枚目 → 重複元 {source.file_name} "
        f"{source.drive_link}（{source.index + 1} 枚目）"
    )

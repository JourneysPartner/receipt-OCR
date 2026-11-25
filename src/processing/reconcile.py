"""画像からの読みと文字からの読みを照らす（仕様 §5.2）。

API もファイルも触らない純粋な関数。本番の両読みの流れと比較の道具が共用する。
"""

from dataclasses import dataclass
from datetime import date as date_type

from src.compare.normalize import normalize_date
from src.rules.amount_validation import validate_amount

LABEL_AMOUNT = "※金額要確認"
LABEL_DATE = "※日付要確認"
LABEL_COUNT = "※明細数要確認"
LABEL_READ = "※読み取り要確認"
LABEL_REREAD = "※再読取要確認"

# readings_text で各側に出す明細の上限
_MAX_READINGS = 10


@dataclass(frozen=True)
class ItemDecision:
    """画像からの 1 明細をどう扱うかの判定。"""

    matched: bool  # True = 合った（自動で書いてよい）
    label: str  # matched のときは ""
    reason: str  # 人が読む短い理由（日本語）
    text_index: int | None  # 組にした文字からの位置（無ければ None）


def _integer_amount_of(item) -> int | None:
    """整数の金額をそのまま返す（bool・その他の型は金額なし。0 以下も返す）。"""
    amount = getattr(item, "amount", None)
    if isinstance(amount, bool) or not isinstance(amount, int):
        return None
    return amount


def _amount_of(item) -> int | None:
    """1 以上の整数の金額だけを返す（bool・0 以下・その他の型は金額なし）。"""
    amount = _integer_amount_of(item)
    if amount is None or amount < 1:
        return None
    return amount


def _date_of(item) -> str:
    """YYYY-MM-DD の形そのものの実在する日付だけを返す（それ以外は空）。"""
    text = normalize_date(getattr(item, "date", None))
    if not text:
        return ""
    try:
        parsed = date_type.fromisoformat(text)
    except ValueError:
        return ""
    if parsed.isoformat() != text:
        return ""
    return text


def _key(item) -> tuple[str, int] | None:
    """照らす鍵 = (そろえた日付, 金額)。日付が読めないか金額が無ければ鍵なし。"""
    date = _date_of(item)
    amount = _amount_of(item)
    if not date or amount is None:
        return None
    return (date, amount)


def _is_digit_inflation(amount: int, ocr_text: str) -> bool:
    try:
        return validate_amount(amount, ocr_text).status == "digit_inflation"
    except Exception:
        return False


def reconcile(image_items, text_items, ocr_text: str) -> list[ItemDecision]:
    """画像からの明細ごとに (合ったか, ラベル, 理由, 組にした位置) を返す。

    戻り値の長さは必ず len(image_items)。例外を投げない。
    """
    images = list(image_items or [])
    texts = list(text_items or [])
    total_image = len(images)
    total_text = len(texts)

    if total_text > total_image:
        reason = f"文字からは {total_text} 件、画像からは {total_image} 件"
        return [ItemDecision(False, LABEL_COUNT, reason, None) for _ in images]

    if not texts:
        return [ItemDecision(False, LABEL_READ, "文字からの読みが無い", None) for _ in images]

    used: set[int] = set()
    decisions: list[ItemDecision | None] = [None] * total_image

    # 先に全部の組を作る（I を先頭から順に、T の未使用の最初のものと組にする）
    for index, image_item in enumerate(images):
        key = _key(image_item)
        if key is None:
            continue
        for text_index, text_item in enumerate(texts):
            if text_index in used:
                continue
            if _key(text_item) != key:
                continue
            used.add(text_index)
            if _is_digit_inflation(key[1], ocr_text):
                decisions[index] = ItemDecision(
                    False, LABEL_AMOUNT, "先頭の桁の読み違いの疑い", text_index
                )
            else:
                decisions[index] = ItemDecision(True, "", "", text_index)
            break

    # 組ができなかった明細は、全部の組を作り終えてから決める
    for index in range(total_image):
        if decisions[index] is not None:
            continue
        raw_amount = _integer_amount_of(images[index])
        if raw_amount is not None and raw_amount <= 0:
            decisions[index] = ItemDecision(False, LABEL_AMOUNT, "金額が 0 以下", None)
            continue
        amount = _amount_of(images[index])
        date_only = False
        if amount is not None:
            for text_index, text_item in enumerate(texts):
                if text_index in used:
                    continue
                if _amount_of(text_item) == amount:
                    date_only = True
                    break
        if date_only:
            decisions[index] = ItemDecision(False, LABEL_DATE, "日付が食い違う", None)
        else:
            decisions[index] = ItemDecision(False, LABEL_AMOUNT, "金額が食い違う", None)

    fallback = ItemDecision(False, LABEL_AMOUNT, "金額が食い違う", None)
    return [decision if decision is not None else fallback for decision in decisions]


def review_amount(
    image_item,
    d0_decision: ItemDecision | None,
    dx_decision: ItemDecision | None,
    ocr_text: str,
) -> int | None:
    """要確認の行の M 列（支出金額）に書いてよい金額を返す（仕様 review_amount §4）。

    返すのは主の画像からの金額（`image_item.amount`）だけ。次の全部を満たすときだけ
    1 以上の整数を返し、それ以外は None:
    - D0 があり、合っていない（要確認の行である）
    - D0 のラベルが `※明細数要確認`・`※再読取要確認` でない
    - D0 か Dx のラベルが `※日付要確認`（読み手の間で金額が合った）
    - 主の画像からの金額が 1 以上の整数（bool でない）
    - 支出の明細（is_expense）
    - Vision の文字があり、桁の検査（digit_inflation）に掛からない
    もう 1 人を呼んだファイルだけ Dx を渡す（呼んでいなければ None）。番号 0 以上の
    処理済みの印があるファイルでは呼び出さない（呼ぶ側の責任）。

    API もファイルも触らない・例外を投げない・判定できなければ None。
    """
    try:
        if d0_decision is None or getattr(d0_decision, "matched", False):
            return None
        d0_label = getattr(d0_decision, "label", "")
        if d0_label in (LABEL_COUNT, LABEL_REREAD):
            return None
        amount = _amount_of(image_item)
        if amount is None or not getattr(image_item, "is_expense", False):
            return None
        text = ocr_text if isinstance(ocr_text, str) else ""
        if not text.strip():
            return None
        dx_label = getattr(dx_decision, "label", "") if dx_decision is not None else ""
        if d0_label != LABEL_DATE and dx_label != LABEL_DATE:
            return None
        # reconcile は日付だけ食い違う明細に桁の検査を掛けない。ここで必ず掛ける（W3）。
        if validate_amount(amount, text).status == "digit_inflation":
            return None
        return amount
    except Exception:
        return None


def _unmatched_decision() -> ItemDecision:
    return ItemDecision(False, LABEL_AMOUNT, "金額が食い違う", None)


def needs_second_reader(image_items, decisions) -> bool:
    """もう 1 人の読み手を呼ぶ条件（§5.1 の 2 と 4）。API もファイルも触らない。"""
    items = list(image_items or [])
    if not items:
        return False
    return any(not getattr(decision, "matched", False) for decision in list(decisions or []))


def merge_second_reader(d0, dx) -> tuple[list[ItemDecision], set[int]]:
    """D0 と Dx を明細ごとに合わせる（§5.3）。例外を投げない。

    - D0[i] が合っている → D0[i] のまま（N11）
    - D0[i] が合わず Dx[i] が合っている → 合った判定（ラベル・理由は空、
      text_index は D0[i] のまま）にし、番号 i を「もう 1 人で合った」に入れる
    - どちらも合わない → D0[i] のまま

    戻りの長さは必ず D0 の長さ。Dx が短い・長い・None でも例外にしない。
    """
    try:
        base = list(d0 or [])
    except TypeError:
        base = []
    try:
        other = list(dx or [])
    except TypeError:
        other = []

    merged: list[ItemDecision] = []
    matched_by_second: set[int] = set()
    for index, decision in enumerate(base):
        if decision is not None and getattr(decision, "matched", False):
            merged.append(decision)
            continue
        candidate = other[index] if index < len(other) else None
        if candidate is not None and getattr(candidate, "matched", False):
            text_index = getattr(decision, "text_index", None)
            merged.append(ItemDecision(True, "", "", text_index))
            matched_by_second.add(index)
        else:
            merged.append(decision if decision is not None else _unmatched_decision())
    return merged, matched_by_second


def second_reader_reason(
    second_items,
    image_count: int,
    decision: ItemDecision | None,
    error: str | None = None,
) -> str:
    """要確認の行に書く、もう 1 人の側の理由（§6）。例外を投げない。"""
    try:
        items = list(second_items or [])
    except TypeError:
        items = []
    if not items:
        return f"読めなかった（{error or 'zero_items'}）"
    try:
        count = int(image_count)
    except (TypeError, ValueError):
        count = 0
    if len(items) > count:
        return f"もう1人は {len(items)} 件、画像からは {count} 件"
    reason = getattr(decision, "reason", "") if decision is not None else ""
    return reason or _unmatched_decision().reason


def _reading(item) -> str:
    date = normalize_date(getattr(item, "date", None)) or "?"
    amount = _integer_amount_of(item)
    return f"{date}/{amount if amount is not None else '?'}"


def _side_text(items) -> str:
    values = [_reading(item) for item in items]
    if not values:
        return "なし"
    shown = values[:_MAX_READINGS]
    text = ", ".join(shown)
    rest = len(values) - len(shown)
    if rest > 0:
        text = f"{text}, …ほか {rest} 件"
    return text


def readings_text(image_items, text_items, second_items=None) -> str:
    """`画像=<日付>/<金額>, … ｜ 文字=<日付>/<金額>, …` の 1 行にする。

    `second_items` を渡したときだけ、後ろに `｜ もう1人=<…>` を足す。
    None（既定）のときの戻りは今までと同じ文字列。
    """
    text = (
        f"画像={_side_text(list(image_items or []))} ｜ 文字={_side_text(list(text_items or []))}"
    )
    if second_items is None:
        return text
    return f"{text} ｜ もう1人={_side_text(list(second_items or []))}"

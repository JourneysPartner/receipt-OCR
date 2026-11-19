"""画像からの読みと文字からの読みを照らす（仕様 §5.2）。

API もファイルも触らない純粋な関数。本番の両読みの流れと比較の道具が共用する。
"""

from dataclasses import dataclass

from src.compare.normalize import normalize_date
from src.rules.amount_validation import validate_amount

LABEL_AMOUNT = "※金額要確認"
LABEL_DATE = "※日付要確認"
LABEL_COUNT = "※明細数要確認"
LABEL_READ = "※読み取り要確認"

# readings_text で各側に出す明細の上限
_MAX_READINGS = 10


@dataclass(frozen=True)
class ItemDecision:
    """画像からの 1 明細をどう扱うかの判定。"""

    matched: bool  # True = 合った（自動で書いてよい）
    label: str  # matched のときは ""
    reason: str  # 人が読む短い理由（日本語）
    text_index: int | None  # 組にした文字からの位置（無ければ None）


def _amount_of(item) -> int | None:
    """整数の金額だけを返す（bool とその他の型は金額なし）。"""
    amount = getattr(item, "amount", None)
    if isinstance(amount, bool) or not isinstance(amount, int):
        return None
    return amount


def _key(item) -> tuple[str, int] | None:
    """照らす鍵 = (そろえた日付, 金額)。日付が空か金額が無ければ鍵なし。"""
    date = normalize_date(getattr(item, "date", None))
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


def _reading(item) -> str:
    date = normalize_date(getattr(item, "date", None)) or "?"
    amount = _amount_of(item)
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


def readings_text(image_items, text_items) -> str:
    """`画像=<日付>/<金額>, … ｜ 文字=<日付>/<金額>, …` の 1 行にする。"""
    return (
        f"画像={_side_text(list(image_items or []))} ｜ 文字={_side_text(list(text_items or []))}"
    )

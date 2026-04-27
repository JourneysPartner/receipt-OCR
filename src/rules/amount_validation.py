"""金額バリデーション

AI が返した amount を OCR テキストの金額候補と突合し、
confidence が高くても不整合を検知して安全側に倒す（manual_entry へ）。

主な誤読パターン:
- ¥ / ￥ を数字 4 などと誤読し、先頭に余計な1桁が付く
  例: 実際 1,600 → OCR 41,600 → AI もそれを信じる
"""

import re
from dataclasses import dataclass, field

# 金額候補の抽出パターン
#   ¥1,234 / ￥1,234 / 1,234円 / 1,234 / 1234 など
_AMOUNT_PATTERNS = [
    re.compile(r"[¥￥]\s*(\d{1,3}(?:,\d{3})+|\d+)"),  # ¥付き
    re.compile(r"(\d{1,3}(?:,\d{3})+|\d+)\s*円"),  # 円付き
    re.compile(r"(?<!\d)(\d{1,3}(?:,\d{3})+)(?!\d)"),  # カンマ区切り
    re.compile(r"(?<![\d.])(\d{3,})(?!\d)"),  # 3桁以上の連続数字
]


@dataclass
class AmountValidation:
    """金額検証の結果"""

    status: str  # "ok" | "no_ai_amount" | "no_candidates" | "digit_inflation" | "missing_in_ocr"
    reason: str = ""
    matched_candidates: list[int] = field(default_factory=list)
    chosen_amount: int | None = None

    @property
    def is_valid(self) -> bool:
        """success として記帳してよいか。
        - ok: 完全一致
        - no_candidates: OCR に数値が無く判断不能 → 通す
        - no_ai_amount: AI 側の問題、別途ハンドル
        """
        return self.status in ("ok", "no_candidates", "no_ai_amount")

    @property
    def should_manual_entry(self) -> bool:
        """明らかに金額誤りが疑われるか"""
        return self.status in ("digit_inflation", "missing_in_ocr")


def extract_amount_candidates(text: str) -> list[int]:
    """OCR 生テキストから金額候補（int）のソート済みリストを返す"""
    if not text:
        return []
    candidates: set[int] = set()
    for pat in _AMOUNT_PATTERNS:
        for m in pat.finditer(text):
            raw = m.group(1).replace(",", "")
            try:
                v = int(raw)
            except ValueError:
                continue
            # ノイズ除去: 大きすぎる値や 0
            if 1 <= v < 10**8:
                candidates.add(v)
    return sorted(candidates)


def validate_amount(ai_amount: int | None, ocr_text: str) -> AmountValidation:
    """AI amount と OCR 候補の整合性を検証する"""
    if ai_amount is None:
        return AmountValidation(status="no_ai_amount", reason="AIがamount未抽出")

    candidates = extract_amount_candidates(ocr_text)
    if not candidates:
        return AmountValidation(
            status="no_candidates",
            reason="OCR内に数値候補が見当たらない",
            chosen_amount=ai_amount,
        )

    if ai_amount in candidates:
        return AmountValidation(
            status="ok",
            reason="",
            matched_candidates=candidates,
            chosen_amount=ai_amount,
        )

    # digit_inflation チェック: 先頭1桁だけ余計に付いた疑い
    # 例: AI=41600, candidates に 1600 があれば怪しい
    s = str(ai_amount)
    if len(s) >= 4:  # 4桁以上なら先頭削って3桁以上残る
        try:
            tail = int(s[1:])
            if tail in candidates:
                return AmountValidation(
                    status="digit_inflation",
                    reason=(
                        f"AI amount {ai_amount} の下位桁 {tail} が OCR 候補にあり、"
                        f"先頭1桁の誤読疑い"
                    ),
                    matched_candidates=candidates,
                    chosen_amount=ai_amount,
                )
        except ValueError:
            pass

    return AmountValidation(
        status="missing_in_ocr",
        reason=f"AI amount {ai_amount} が OCR 候補に無い (候補: {candidates})",
        matched_candidates=candidates,
        chosen_amount=ai_amount,
    )


def build_review_label(
    *,
    amount_validation: AmountValidation | None = None,
    needs_review: bool = False,
    extra_reasons: list[str] | None = None,
) -> str:
    """要確認/要手入力ラベルを文脈に応じて生成する。

    優先順:
    - amount_validation が digit_inflation / missing_in_ocr → 「金額」を含める
    - needs_review (低信頼) → 「要確認」を含める
    - extra_reasons があればそれぞれ追加
    - 何も該当しなければ既定の「※要手入力」

    例:
    - 金額NGのみ → `※金額要確認`
    - 金額NG + 勘定科目疑わしい → `※金額・勘定科目要確認`
    - OCR/AI 失敗等で何も候補が無い → `※要手入力`
    """
    reasons: list[str] = []

    if amount_validation is not None and amount_validation.should_manual_entry:
        reasons.append("金額")

    if needs_review:
        # 低信頼で全体が怪しい場合
        if "金額" not in reasons:
            reasons.append("内容")

    if extra_reasons:
        for r in extra_reasons:
            if r and r not in reasons:
                reasons.append(r)

    if not reasons:
        return "※要手入力"

    return f"※{'・'.join(reasons)}要確認"

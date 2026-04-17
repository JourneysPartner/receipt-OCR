"""業務ルール補正"""

import re
from dataclasses import dataclass

from src.models import ReceiptItem, CorrectedItem
from src.logging.logger import setup_logger

logger = setup_logger()


@dataclass
class CorrectionRule:
    name: str
    patterns: list[str]
    account: str | None = None
    tax_category: str | None = None


CORRECTION_RULES: list[CorrectionRule] = [
    CorrectionRule(
        name="燃料費→車両費",
        patterns=[r"ガソリン", r"給油", r"燃料", r"ENEOS", r"出光", r"コスモ",
                  r"apollostation", r"キグナス"],
        account="車両費",
    ),
    CorrectionRule(
        name="駐車場→旅費交通費",
        patterns=[r"駐車場", r"パーキング", r"コインパーキング", r"タイムズ"],
        account="旅費交通費",
    ),
    CorrectionRule(
        name="高速道路→旅費交通費",
        patterns=[r"高速", r"ETC", r"NEXCO", r"首都高", r"阪神高速"],
        account="旅費交通費",
    ),
    CorrectionRule(
        name="コピー・印刷→雑費",
        patterns=[r"コピー", r"印刷", r"プリント"],
        account="雑費",
    ),
    CorrectionRule(
        name="郵便→通信費",
        patterns=[r"郵便", r"レターパック", r"ゆうパック", r"切手", r"はがき"],
        account="通信費",
    ),
    CorrectionRule(
        name="収入印紙→租税公課",
        patterns=[r"収入印紙", r"印紙"],
        account="租税公課",
        tax_category="対象外",
    ),
    CorrectionRule(
        name="タクシー→旅費交通費",
        patterns=[r"タクシー", r"ハイヤー"],
        account="旅費交通費",
    ),
    CorrectionRule(
        name="電車・バス→旅費交通費",
        patterns=[r"JR", r"電車", r"バス", r"鉄道", r"Suica", r"PASMO", r"ICOCA"],
        account="旅費交通費",
    ),
    CorrectionRule(
        name="宅配便→通信費",
        patterns=[r"宅急便", r"宅配便", r"ヤマト", r"佐川", r"クロネコ"],
        account="通信費",
    ),
    CorrectionRule(
        name="文具→消耗品費",
        patterns=[r"文具", r"ボールペン", r"ノート", r"コクヨ", r"事務用品"],
        account="消耗品費",
    ),
]


class RuleCorrector:
    def __init__(
        self,
        rules: list[CorrectionRule] | None = None,
        confidence_threshold: float = 0.7,
    ):
        self._rules = rules or CORRECTION_RULES
        self._threshold = confidence_threshold

    def apply(self, item: ReceiptItem) -> CorrectedItem:
        corrected = CorrectedItem(
            original=item,
            date=item.date, amount=item.amount, vendor=item.vendor,
            description=item.description, account=item.account,
            tax_category=item.tax_category, confidence=item.confidence,
            is_expense=item.is_expense, memo=item.memo,
        )
        text = " ".join(filter(None, [item.description, item.vendor]))
        for rule in self._rules:
            if self._matches(text, rule.patterns):
                if rule.account and rule.account != corrected.account:
                    corrected.account = rule.account
                    corrected.corrections_applied.append(
                        f"{rule.name}: 勘定科目→{rule.account}"
                    )
                if rule.tax_category and rule.tax_category != corrected.tax_category:
                    corrected.tax_category = rule.tax_category
                    corrected.corrections_applied.append(
                        f"{rule.name}: 税区分→{rule.tax_category}"
                    )
        if corrected.confidence < self._threshold:
            corrected.needs_review = True
        return corrected

    @staticmethod
    def _matches(text: str, patterns: list[str]) -> bool:
        return any(re.search(p, text, re.IGNORECASE) for p in patterns)

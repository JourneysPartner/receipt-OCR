"""Gemini API による AI 解析エンジン"""

import json

from google import genai
from google.genai import types

from src.ai.base import AiExtractor
from src.config import AiConfig
from src.logging.logger import setup_logger
from src.models import OcrResult, ReceiptItem

logger = setup_logger()

SYSTEM_INSTRUCTION = """\
あなたは日本の経理業務に精通したアシスタントです。
レシートや領収書のOCRテキストから、以下の情報を正確に抽出してJSON配列で返してください。

1枚のレシートに複数明細がある場合は、複数のオブジェクトに分けてください。
ただし、通常のレシート（スーパー、コンビニなど）は合計金額で1明細にまとめてください。

各オブジェクトのフィールド:
- date: 日付 (YYYY-MM-DD 形式。年が不明なら今年と推定)
- amount: 税込金額 (整数、円単位)
- vendor: 取引先名
- description: 摘要（何を買ったか / 何の費用か）
- account: 勘定科目候補（消耗品費、旅費交通費、通信費、車両費、雑費、租税公課、接待交際費、会議費 など）
- tax_category: 税区分候補（課税仕入10%、課税仕入8%（軽減）、非課税、対象外 など）
- confidence: 抽出の信頼度 (0.0〜1.0)
- is_expense: 支出かどうか (true/false、通常はtrue)
- memo: 補足（OCR品質が低い部分や推測した箇所の説明）

JSON配列のみを返してください。マークダウンのコードブロックや説明文は不要です。
"""


class GeminiExtractor(AiExtractor):
    def __init__(self, config: AiConfig, api_key: str | None = None):
        self._config = config
        self._client = genai.Client(api_key=api_key)

    def extract_receipt_data(self, ocr_result: OcrResult, file_name: str) -> list[ReceiptItem]:
        if not ocr_result.raw_text.strip():
            logger.warning(f"OCRテキスト空: {file_name}", extra={"step": "ai_extract"})
            return []

        user_msg = (
            f"以下はレシート画像「{file_name}」のOCRテキストです。\n"
            f"情報を抽出してJSON配列で返してください。\n\n"
            f"---\n{ocr_result.raw_text}\n---"
        )
        try:
            resp = self._client.models.generate_content(
                model=self._config.model,
                contents=user_msg,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_INSTRUCTION,
                    max_output_tokens=self._config.max_tokens,
                    temperature=0.1,
                ),
            )
            items = self._parse_response(resp.text.strip(), file_name)
            logger.info(f"AI抽出: {file_name} → {len(items)} 明細", extra={"step": "ai_extract"})
            return items
        except Exception as e:
            logger.error(
                f"AI抽出失敗: {file_name}: {e}", extra={"step": "ai_extract", "error": str(e)}
            )
            return []

    def _parse_response(self, raw: str, file_name: str) -> list[ReceiptItem]:
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
            return []

        if isinstance(data, dict):
            data = [data]

        items = []
        for entry in data:
            try:
                items.append(
                    ReceiptItem(
                        date=entry.get("date"),
                        amount=_safe_int(entry.get("amount")),
                        vendor=entry.get("vendor"),
                        description=entry.get("description"),
                        account=entry.get("account"),
                        tax_category=entry.get("tax_category"),
                        confidence=float(entry.get("confidence", 0.0)),
                        is_expense=entry.get("is_expense", True),
                        memo=entry.get("memo"),
                    )
                )
            except (ValueError, TypeError) as e:
                logger.warning(f"明細パース失敗: {file_name}: {e}", extra={"step": "ai_parse"})
        return items


def _safe_int(value) -> int | None:
    if value is None:
        return None
    try:
        cleaned = str(value).replace(",", "").replace("円", "").replace("¥", "").strip()
        return int(float(cleaned))
    except (ValueError, TypeError):
        return None

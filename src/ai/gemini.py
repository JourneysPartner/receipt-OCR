"""Gemini API による AI 解析エンジン"""

import json
import time

from google import genai
from google.genai import types

from src.ai import prompts
from src.ai.base import AiExtractor
from src.config import AiConfig
from src.logging.logger import setup_logger
from src.models import DriveFile, OcrResult, ReceiptItem

# 再抽出用 (画像/PDF を直接渡す) MIME 許容リスト
_RETRY_SUPPORTED_MIMES = ("image/jpeg", "image/png", "image/webp", "application/pdf")
# 両読みの流れからも使う公開名（元の名前も残す）
RETRY_SUPPORTED_MIMES = _RETRY_SUPPORTED_MIMES

logger = setup_logger()

# 今までの名前を残す（第 1 版の指示文）。
SYSTEM_INSTRUCTION = prompts.SYSTEM_INSTRUCTION_V1


class GeminiExtractor(AiExtractor):
    def __init__(self, config: AiConfig, api_key: str | None = None):
        super().__init__()
        self._config = config
        self.last_call_info: dict | None = None
        client_kwargs: dict = {"api_key": api_key}
        if config.request_timeout_seconds is not None:
            client_kwargs["http_options"] = types.HttpOptions(
                timeout=config.request_timeout_seconds * 1000
            )
        self._client = genai.Client(**client_kwargs)

    def _prompt_version(self) -> str:
        return getattr(self._config, "prompt_version", "v1")

    def _generate_config(self) -> types.GenerateContentConfig:
        kwargs: dict = {
            "system_instruction": prompts.system_instruction(self._prompt_version()),
            "max_output_tokens": self._config.max_tokens,
        }
        if self._config.temperature is not None:
            kwargs["temperature"] = self._config.temperature
        if self._config.thinking_level is not None:
            kwargs["thinking_config"] = types.ThinkingConfig(
                thinking_level=self._config.thinking_level
            )
        return types.GenerateContentConfig(**kwargs)

    def _generate_content(self, **kwargs):
        """1 回の generate_content を呼び、last_call_info を残す。"""
        self.last_call_info = None
        started = time.monotonic()
        model = kwargs.get("model", self._config.model)
        try:
            resp = self._client.models.generate_content(**kwargs)
        except Exception as e:
            code = getattr(e, "code", None)
            self.last_call_info = {
                "model": model,
                "latency_ms": int((time.monotonic() - started) * 1000),
                "finish_reason": None,
                "prompt_tokens": None,
                "output_tokens": None,
                "thinking_tokens": None,
                "raw_text": None,
                "error": str(e),
                "error_code": code
                if isinstance(code, int) and not isinstance(code, bool)
                else None,
            }
            raise
        latency_ms = int((time.monotonic() - started) * 1000)
        self.last_call_info = {
            "model": model,
            "latency_ms": latency_ms,
            "finish_reason": _finish_reason(resp),
            "prompt_tokens": _usage_value(resp, "prompt_token_count"),
            "output_tokens": _usage_value(resp, "candidates_token_count"),
            "thinking_tokens": _usage_value(resp, "thoughts_token_count"),
            "raw_text": _safe_text(resp),
            "error": None,
            "error_code": None,
        }
        return resp

    def extract_receipt_data(self, ocr_result: OcrResult, file_name: str) -> list[ReceiptItem]:
        self.last_extraction_error = None
        if not ocr_result.raw_text.strip():
            logger.warning(f"OCRテキスト空: {file_name}", extra={"step": "ai_extract"})
            self.last_extraction_error = "ocr_empty"
            return []

        user_msg = prompts.text_user_message(self._prompt_version(), file_name, ocr_result.raw_text)
        try:
            resp = self._generate_content(
                model=self._config.model,
                contents=user_msg,
                config=self._generate_config(),
            )
            items = self._parse_response(resp.text.strip(), file_name)
            if not items:
                # _parse_response 内で last_extraction_error が parse_error or zero_items に
                # セットされている。ここでは何もしない。
                pass
            else:
                self.last_extraction_error = None
            logger.info(
                f"AI抽出: {file_name} → {len(items)} 明細 (error={self.last_extraction_error})",
                extra={"step": "ai_extract"},
            )
            return items
        except Exception as e:
            logger.error(
                f"AI抽出失敗: {file_name}: {e}",
                extra={"step": "ai_extract", "error": str(e)},
            )
            self.last_extraction_error = "api_error"
            return []

    def extract_from_file(self, file: DriveFile) -> list[ReceiptItem]:
        """画像/PDFを Gemini multimodal に直接渡して再抽出する。
        - 抽出 retry（初回 0件 / parse_error 時）
        - amount_validation NG retry（金額誤読疑い時）
        の両方で使われる。
        """
        self.last_extraction_error = None
        if file.mime_type not in _RETRY_SUPPORTED_MIMES:
            logger.warning(
                f"再抽出: 未対応MIME {file.mime_type}: {file.file_name}",
                extra={"step": "ai_retry"},
            )
            self.last_extraction_error = "unsupported_mime"
            return []
        if not file.content:
            logger.warning(
                f"再抽出: ファイル中身が空: {file.file_name}",
                extra={"step": "ai_retry"},
            )
            self.last_extraction_error = "empty_content"
            return []

        user_msg = prompts.image_user_message(self._prompt_version(), file.file_name)
        try:
            resp = self._generate_content(
                model=self._config.model,
                contents=[
                    types.Part.from_bytes(data=file.content, mime_type=file.mime_type),
                    user_msg,
                ],
                config=self._generate_config(),
            )
            items = self._parse_response(resp.text.strip(), file.file_name)
            if items:
                self.last_extraction_error = None
            logger.info(
                f"AI再抽出(画像): {file.file_name} → {len(items)} 明細 "
                f"(error={self.last_extraction_error})",
                extra={"step": "ai_retry"},
            )
            return items
        except Exception as e:
            logger.error(
                f"AI再抽出失敗: {file.file_name}: {e}",
                extra={"step": "ai_retry", "error": str(e)},
            )
            self.last_extraction_error = "api_error"
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
            self.last_extraction_error = "parse_error"
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
        if not items:
            self.last_extraction_error = "zero_items"
        return items


def _safe_int(value) -> int | None:
    if value is None:
        return None
    try:
        cleaned = str(value).replace(",", "").replace("円", "").replace("¥", "").strip()
        return int(float(cleaned))
    except (ValueError, TypeError):
        return None


def _finish_reason(resp) -> str | None:
    candidates = getattr(resp, "candidates", None)
    if not candidates:
        return None
    try:
        first = candidates[0]
    except (IndexError, KeyError, TypeError):
        return None
    reason = getattr(first, "finish_reason", None)
    if reason is None:
        return None
    return getattr(reason, "name", None) or str(reason)


def _usage_value(resp, name: str) -> int | None:
    usage = getattr(resp, "usage_metadata", None)
    if usage is None:
        return None
    value = getattr(usage, name, None)
    return value if isinstance(value, int) else None


def _safe_text(resp) -> str | None:
    try:
        text = resp.text
    except Exception:
        return None
    return text if isinstance(text, str) else None

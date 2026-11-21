"""もう 1 人の読み手（Anthropic・OpenAI。仕様 §6）。

`anthropic` と `openai` の import は、読み手を作る関数の中だけで行う（R1）。
本番（`prod` / `validate`）はこのモジュールの関数を呼ばないので、SDK を
import しない。画像を送るかどうかは `COMPARE_READERS` にその会社の型が
書いてあるかで決まる（R2）。
"""

import base64
import time

from src.ai import prompts
from src.ai.base import AiExtractor
from src.ai.parsing import parse_receipt_items
from src.compare.config import (
    ANTHROPIC_EFFORTS,
    VENDOR_ANTHROPIC,
    VENDOR_GEMINI,
    VENDOR_OPENAI,
    reader_vendor_or_error,
)
from src.logging.logger import setup_logger

logger = setup_logger()

SUPPORTED_MIMES = ("image/jpeg", "image/png", "image/webp", "application/pdf")
DEFAULT_TIMEOUT_SECONDS = 180
ANTHROPIC_IMAGE_BASE64_LIMIT = 10 * 1024 * 1024
ANTHROPIC_PDF_LIMIT = 32 * 1024 * 1024
OPENAI_FILE_LIMIT = 50 * 1024 * 1024


def _prompt_version(config) -> str:
    return getattr(config, "prompt_version", "v1")


def _timeout_seconds(config) -> int:
    value = getattr(config, "request_timeout_seconds", None)
    return value if isinstance(value, int) and value > 0 else DEFAULT_TIMEOUT_SECONDS


def _effort(config) -> str | None:
    value = getattr(config, "thinking_level", None)
    return value if value in ANTHROPIC_EFFORTS else None


def _int_or_none(value) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _latency_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _error_code(error, status_cls, connection_cls) -> int | None:
    """例外から HTTP の状態を決める。つながらない・時間切れは 503。"""
    if isinstance(error, status_cls):
        value = getattr(error, "status_code", None)
        return _int_or_none(value)
    if isinstance(error, connection_cls):
        return 503
    value = getattr(error, "status_code", None)
    return _int_or_none(value)


class _ReaderBase(AiExtractor):
    provider = ""

    def __init__(self, config, api_key: str | None = None):
        super().__init__()
        self._config = config
        self._api_key = api_key
        self.last_call_info: dict | None = None

    def _redact(self, value) -> str:
        """鍵の値を例外の文・ログに出さない（R4）。"""
        text = str(value)
        if self._api_key:
            text = text.replace(str(self._api_key), "***")
        return text

    def extract_receipt_data(self, ocr_result, file_name):
        raise NotImplementedError("読み手は文字からは読みません")

    def _start(self) -> None:
        self.last_extraction_error = None
        self.last_call_info = None

    def _info(
        self,
        *,
        model: str,
        started: float,
        finish_reason=None,
        prompt_tokens=None,
        output_tokens=None,
        thinking_tokens=None,
        raw_text=None,
        error=None,
        error_code=None,
    ) -> dict:
        return {
            "model": model,
            "latency_ms": _latency_ms(started),
            "finish_reason": finish_reason,
            "prompt_tokens": _int_or_none(prompt_tokens),
            "output_tokens": _int_or_none(output_tokens),
            "thinking_tokens": _int_or_none(thinking_tokens),
            "raw_text": raw_text,
            "error": error,
            "error_code": error_code,
        }

    def _check_file(self, file) -> bool:
        """使える種類・中身・大きさを確かめる。呼ばないときは False。"""
        if file.mime_type not in SUPPORTED_MIMES:
            logger.warning(
                f"読み手: 未対応MIME {file.mime_type}: {file.file_name}",
                extra={"step": "compare_reader"},
            )
            self.last_extraction_error = "unsupported_mime"
            return False
        if not file.content:
            logger.warning(
                f"読み手: ファイル中身が空: {file.file_name}",
                extra={"step": "compare_reader"},
            )
            self.last_extraction_error = "empty_content"
            return False
        return True

    def _too_large(self, file) -> bool:
        return False

    def _finish_items(self, text: str | None, file_name: str, info: dict) -> list:
        """返った文を明細にする。文が無ければ `疑似 api_error`（empty_response）。"""
        if not text:
            info["raw_text"] = None
            info["error"] = None
            self.last_call_info = info
            self.last_extraction_error = "api_error"
            return []
        info["raw_text"] = text
        self.last_call_info = info
        items, error = parse_receipt_items(
            text, file_name, read_calc_fields=_prompt_version(self._config) == "v3"
        )
        self.last_extraction_error = error
        logger.info(
            f"読み手({self.provider}): {file_name} → {len(items)} 明細 (error={error})",
            extra={"step": "compare_reader"},
        )
        return items

    def _record_error(self, model: str, started: float, error, code) -> None:
        self.last_call_info = self._info(
            model=model,
            started=started,
            error=self._redact(error),
            error_code=code,
        )
        self.last_extraction_error = "api_error"
        logger.error(
            f"読み手({self.provider})が失敗: {type(error).__name__}",
            extra={"step": "compare_reader"},
        )


class AnthropicReader(_ReaderBase):
    provider = VENDOR_ANTHROPIC

    def __init__(self, config, api_key: str | None = None):
        super().__init__(config, api_key)
        import anthropic  # R1: 読み手を作るときだけ import する

        self._anthropic = anthropic
        self._client = anthropic.Anthropic(
            api_key=api_key,
            timeout=_timeout_seconds(config),
            max_retries=0,
        )

    def extract_from_file(self, file):
        self._start()
        if not self._check_file(file) or self._too_large(file):
            return []
        data = base64.b64encode(file.content).decode("ascii")
        if file.mime_type == "application/pdf":
            source = {"type": "base64", "media_type": "application/pdf", "data": data}
            block = {"type": "document", "source": source}
        else:
            source = {"type": "base64", "media_type": file.mime_type, "data": data}
            block = {"type": "image", "source": source}

        version = _prompt_version(self._config)
        kwargs = {
            "model": self._config.model,
            "max_tokens": self._config.max_tokens,
            "system": prompts.system_instruction(version),
            "messages": [
                {
                    "role": "user",
                    "content": [
                        block,
                        {
                            "type": "text",
                            "text": prompts.image_user_message(version, file.file_name),
                        },
                    ],
                }
            ],
        }
        effort = _effort(self._config)
        if effort is not None:
            kwargs["output_config"] = {"effort": effort}

        started = time.monotonic()
        try:
            response = self._client.messages.create(**kwargs)
        except Exception as error:
            code = _error_code(
                error, self._anthropic.APIStatusError, self._anthropic.APIConnectionError
            )
            self._record_error(self._config.model, started, error, code)
            return []

        blocks = getattr(response, "content", None) or []
        text = "".join(
            str(getattr(block, "text", "") or "")
            for block in blocks
            if getattr(block, "type", None) == "text"
        )
        usage = getattr(response, "usage", None)
        info = self._info(
            model=self._config.model,
            started=started,
            finish_reason=getattr(response, "stop_reason", None),
            prompt_tokens=getattr(usage, "input_tokens", None),
            output_tokens=getattr(usage, "output_tokens", None),
            thinking_tokens=None,
        )
        return self._finish_items(text, file.file_name, info)

    def _too_large(self, file) -> bool:
        if file.mime_type == "application/pdf":
            limit = ANTHROPIC_PDF_LIMIT
            size = len(file.content)
        else:
            limit = ANTHROPIC_IMAGE_BASE64_LIMIT
            size = len(base64.b64encode(file.content))
        if size > limit:
            logger.warning(
                f"読み手: 大きすぎるため送りません: {file.file_name}",
                extra={"step": "compare_reader"},
            )
            self.last_extraction_error = "too_large"
            return True
        return False


class OpenAIReader(_ReaderBase):
    provider = VENDOR_OPENAI

    def __init__(self, config, api_key: str | None = None):
        super().__init__(config, api_key)
        import openai  # R1: 読み手を作るときだけ import する

        self._openai = openai
        self._client = openai.OpenAI(
            api_key=api_key,
            timeout=_timeout_seconds(config),
            max_retries=0,
        )

    def _too_large(self, file) -> bool:
        if len(file.content) > OPENAI_FILE_LIMIT:
            logger.warning(
                f"読み手: 大きすぎるため送りません: {file.file_name}",
                extra={"step": "compare_reader"},
            )
            self.last_extraction_error = "too_large"
            return True
        return False

    def extract_from_file(self, file):
        self._start()
        if not self._check_file(file) or self._too_large(file):
            return []
        data = base64.b64encode(file.content).decode("ascii")
        if file.mime_type == "application/pdf":
            block = {
                "type": "input_file",
                "filename": file.file_name,
                "file_data": f"data:application/pdf;base64,{data}",
                "detail": "high",
            }
        else:
            block = {
                "type": "input_image",
                "image_url": f"data:{file.mime_type};base64,{data}",
                "detail": "high",
            }

        version = _prompt_version(self._config)
        kwargs = {
            "model": self._config.model,
            "instructions": prompts.system_instruction(version),
            "input": [
                {
                    "role": "user",
                    "content": [
                        block,
                        {
                            "type": "input_text",
                            "text": prompts.image_user_message(version, file.file_name),
                        },
                    ],
                }
            ],
            "max_output_tokens": self._config.max_tokens,
        }
        effort = _effort(self._config)
        if effort is not None:
            kwargs["reasoning"] = {"effort": effort}

        started = time.monotonic()
        try:
            response = self._client.responses.create(**kwargs)
        except Exception as error:
            code = _error_code(error, self._openai.APIStatusError, self._openai.APIConnectionError)
            self._record_error(self._config.model, started, error, code)
            return []

        text = getattr(response, "output_text", None)
        status = getattr(response, "status", None)
        finish_reason = status
        if status == "incomplete":
            details = getattr(response, "incomplete_details", None)
            reason = getattr(details, "reason", None)
            finish_reason = f"incomplete:{reason}"
        usage = getattr(response, "usage", None)
        details = getattr(usage, "output_tokens_details", None)
        reasoning_tokens = _int_or_none(getattr(details, "reasoning_tokens", None))
        output_tokens = _int_or_none(getattr(usage, "output_tokens", None))
        if output_tokens is not None and reasoning_tokens is not None:
            # 費用の式が「出力＋考える分」なので、二重に数えない（仕様 §6.3）
            output_tokens = max(0, output_tokens - reasoning_tokens)
        info = self._info(
            model=self._config.model,
            started=started,
            finish_reason=finish_reason,
            prompt_tokens=getattr(usage, "input_tokens", None),
            output_tokens=output_tokens,
            thinking_tokens=reasoning_tokens,
        )
        return self._finish_items(text, file.file_name, info)


def create_model_checker(
    model_name: str, api_key: str | None, timeout: int = DEFAULT_TIMEOUT_SECONDS
):
    """型の有無を確かめる関数を作る（Anthropic・OpenAI は models.retrieve）。"""
    vendor = reader_vendor_or_error(model_name)
    if vendor == VENDOR_ANTHROPIC:
        import anthropic

        client = anthropic.Anthropic(api_key=api_key, timeout=timeout, max_retries=0)

        def check(name: str) -> bool:
            client.models.retrieve(name)
            return True

        return check
    if vendor == VENDOR_OPENAI:
        import openai

        client = openai.OpenAI(api_key=api_key, timeout=timeout, max_retries=0)

        def check(name: str) -> bool:
            client.models.retrieve(name)
            return True

        return check
    raise ValueError("Gemini の型は Gemini の models.get で確かめてください")


def create_compare_reader(model_name: str, config, api_key: str | None = None):
    """型名から読み手を作る。Gemini は呼ばない（runner が GeminiExtractor を使う）。"""
    vendor = reader_vendor_or_error(model_name)
    if vendor == VENDOR_GEMINI:
        raise ValueError("Gemini の読み手は GeminiExtractor を使ってください")
    if vendor == VENDOR_ANTHROPIC:
        return AnthropicReader(config, api_key=api_key)
    if vendor == VENDOR_OPENAI:
        return OpenAIReader(config, api_key=api_key)
    raise ValueError(f"未対応の読み手です: {model_name!r}")


def reader_settings_text(
    vendor: str, effort: str | None, max_tokens: int, prompt_version: str = "v1"
) -> str:
    """読み手の「設定」の欄（仕様 §6.1）。Gemini の行は今の文字列のまま。"""
    text = f"provider={vendor}, effort={effort or 'なし'}, max_tokens={max_tokens}"
    if prompt_version and prompt_version != "v1":
        text += f", prompt={prompt_version}"
    return text

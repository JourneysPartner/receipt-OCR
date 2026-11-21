"""審判（Decisions API。仕様 spec_judge_form §5.2・§6）。

`httpx` で公式の REST を直接呼ぶ。SDK は使わない。HTTP を送る関数は
`post` として差し替えられるようにし、テストはネットワークを開かない。
鍵は HTTP のヘッダーにだけ入れ、URL にも本文にも入れない（J4）。
"""

import base64
import json
import math
import time
from dataclasses import dataclass, field
from datetime import date as date_type

import httpx

from src.compare.config import (
    VENDOR_GOOGLE,
    VENDOR_OPENAI,
    CompareModel,
    judge_vendor_or_error,
)
from src.compare.forms import base_snapshot
from src.compare.readers import SUPPORTED_MIMES, redact_secrets
from src.logging.logger import setup_logger
from src.processing.reconcile import LABEL_COUNT

logger = setup_logger()

GOOGLE_DECISIONS_URL = "https://generativelanguage.googleapis.com/v1beta/decisions"
OPENAI_DECISIONS_URL = "https://api.openai.com/v1/decisions"
JUDGE_PROMPT_VERSION = "judge-1"

# 仕様 §6.2・§6.3。画像の上限は公式に数が無いため控えめに決めた値（§6.4）
GOOGLE_IMAGE_LIMIT = 20 * 1024 * 1024
GOOGLE_PDF_LIMIT = 50 * 1024 * 1024
OPENAI_IMAGE_LIMIT = 20 * 1024 * 1024
MAX_ITEMS_JSON = 40000

MAX_ITEM_QUESTIONS = 20
MAX_CHOICES = 6

SUCCESS = "成功"
FAIL_API = "失敗:api_error"
FAIL_BAD_RESPONSE = "失敗:bad_response"
FAIL_UNSUPPORTED_MIME = "失敗:unsupported_mime"
FAIL_TOO_LARGE = "失敗:too_large"
FAIL_EMPTY_CONTENT = "失敗:empty_content"
FAIL_TOO_MANY_ITEMS = "失敗:too_many_items"
FAIL_FILE_ERROR = "失敗:file_error"

OTHER_KEY = "other"
OTHER_AMOUNT_TEXT = "どの金額でもない、または読み取れない"
OTHER_DATE_TEXT = "どの日付でもない、または読み取れない"

COMMON_INPUT_TEXT = (
    "次の画像または PDF には、日本のレシート・領収書が 1 枚以上写っています。"
    "質問ごとに、指定したレシートについて答えてください。"
    "合計金額は、値引きと消費税を含めて実際に支払った金額です"
    "（小計・お預かり・お釣り・ポイントではありません）。"
    "日付は発行日・利用日です（お届け日・有効期限・印刷日ではありません）。"
)


class JudgeTransportError(Exception):
    """つながらない・時間切れ。503 としてやり直す（仕様 §6.1）。"""


class JudgeProtocolError(Exception):
    """ヘッダーの値が不正など（httpx.LocalProtocolError）。

    例外の文には送った値が repr で入るので、表・ログには型の名前だけを残す
    （仕様 §12.2）。やり直さない。
    """


@dataclass(frozen=True)
class ChoiceOption:
    key: str
    description: str


@dataclass(frozen=True)
class ChoiceQuestion:
    key: str
    instructions: str
    options: tuple[ChoiceOption, ...]


@dataclass(frozen=True)
class CountQuestion:
    key: str
    instructions: str


@dataclass(frozen=True)
class ItemQuestions:
    index: int
    amount: ChoiceQuestion
    date: ChoiceQuestion


@dataclass
class JudgePlan:
    """1 ファイル分の質問（仕様 §5.2）。"""

    items: list[ItemQuestions] = field(default_factory=list)
    count: CountQuestion | None = None
    too_many: bool = False

    @property
    def questions(self):
        found = []
        for item in self.items:
            found.append(item.amount)
            found.append(item.date)
        if self.count is not None:
            found.append(self.count)
        return found

    @property
    def question_count(self) -> int:
        return len(self.questions)

    @property
    def empty(self) -> bool:
        return not self.questions


@dataclass(frozen=True)
class JudgeAnswer:
    key: str
    kind: str  # "choice" or "count"
    choice: str | None = None
    confidence: float | None = None
    probability: float | None = None


@dataclass
class JudgeAttempt:
    """1 回の審判の呼び出しの結果（再試行の判定にも使う）。"""

    result: str
    answers: list[JudgeAnswer] = field(default_factory=list)
    raw_answers: str = ""
    error: str | None = None
    info: dict = field(default_factory=dict)


def _text(value) -> str:
    return "" if value is None else str(value)


def _iso_date(value) -> str:
    """実在する YYYY-MM-DD だけを返す（それ以外は空）。"""
    text = _text(value).strip()
    if not text:
        return ""
    try:
        parsed = date_type.fromisoformat(text)
    except ValueError:
        return ""
    if parsed.isoformat() != text:
        return ""
    return text


def _positive_amount(value) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 1:
        return None
    return value


def _confidence(value) -> float | None:
    """bool でない有限の数で 0 以上 1 以下だけを返す（§6.4）。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number) or number < 0 or number > 1:
        return None
    return number


def _receipt_reference(index: int, image_items, vendors) -> str:
    if len(image_items) == 1:
        reference = "このレシート"
    else:
        reference = f"上から（ページ順に）{index + 1} 番目のレシート"
    vendor = ""
    if index < len(vendors or ()):
        vendor = _text(vendors[index]).replace("\r", " ").replace("\n", " ").strip()[:40]
    if vendor:
        reference += f"（店名は「{vendor}」と読めます）"
    return reference


def _dedupe(values) -> list:
    found = []
    for value in values:
        if value not in found:
            found.append(value)
    return found


def _choice_options(values, describe) -> tuple[ChoiceOption, ...]:
    """数値の候補を最大 5 個にし、最後に `other` を必ず 1 つ置く。"""
    unique = _dedupe(values)[: MAX_CHOICES - 1]
    options = [ChoiceOption(key=str(value), description=describe(value)) for value in unique]
    return tuple(options)


def _amount_options(amount: int, inflation: bool, unmatched_texts) -> tuple[ChoiceOption, ...]:
    values: list[int] = [amount]
    if inflation:
        without_first = str(amount)[1:]
        if without_first:
            try:
                candidate = int(without_first)
            except ValueError:
                candidate = 0
            if candidate >= 1:
                values.append(candidate)
    for item in unmatched_texts:
        candidate = _positive_amount(getattr(item, "amount", None))
        if candidate is not None:
            values.append(candidate)
    options = _choice_options(values, lambda value: f"{value:,} 円")
    return options + (ChoiceOption(key=OTHER_KEY, description=OTHER_AMOUNT_TEXT),)


def _date_options(own_date: str, unmatched_texts) -> tuple[ChoiceOption, ...]:
    values: list[str] = [own_date]
    for item in unmatched_texts:
        candidate = _iso_date(getattr(item, "date", None))
        if candidate:
            values.append(candidate)
    options = _choice_options(values, _date_description)
    return options + (ChoiceOption(key=OTHER_KEY, description=OTHER_DATE_TEXT),)


def _date_description(value: str) -> str:
    parsed = date_type.fromisoformat(value)
    return f"{parsed.year}年{parsed.month}月{parsed.day}日"


def build_questions(image_items, text_items, decisions, vendors=None) -> JudgePlan:
    """D0 で合わなかった明細の質問を作る（仕様 §5.2、純粋な関数）。"""
    images = list(image_items or [])
    texts = list(text_items or [])
    paired = {
        decision.text_index
        for decision in (decisions or [])
        if getattr(decision, "text_index", None) is not None
    }
    unmatched_texts = [item for index, item in enumerate(texts) if index not in paired]

    plans: list[ItemQuestions] = []
    for index, item in enumerate(images):
        if index < len(decisions) and getattr(decisions[index], "matched", False):
            continue
        amount = _positive_amount(getattr(item, "amount", None))
        own_date = _iso_date(getattr(item, "date", None))
        if amount is None or not own_date:
            # 質問を作らない明細（要確認のまま。仕様 §5.2）
            continue
        inflation = (
            index < len(decisions)
            and _text(getattr(decisions[index], "reason", "")) == "先頭の桁の読み違いの疑い"
        )
        reference = _receipt_reference(index, images, vendors)
        amount_question = ChoiceQuestion(
            key=f"a{index}",
            instructions=f"{reference}について、支払った合計金額（円）はどれですか。",
            options=_amount_options(amount, inflation, unmatched_texts),
        )
        date_question = ChoiceQuestion(
            key=f"d{index}",
            instructions=f"{reference}について、日付はどれですか。",
            options=_date_options(own_date, unmatched_texts),
        )
        plans.append(ItemQuestions(index=index, amount=amount_question, date=date_question))

    count_question = None
    if any(getattr(decision, "label", "") == LABEL_COUNT for decision in (decisions or [])):
        total = len(images)
        count_question = CountQuestion(
            key="n",
            instructions=(
                "この画像または PDF に写っているレシート・領収書は、"
                f"全部でちょうど {total} 枚ですか。"
            ),
        )

    return JudgePlan(
        items=plans,
        count=count_question,
        too_many=len(plans) > MAX_ITEM_QUESTIONS,
    )


def build_google_body(plan: JudgePlan, file, model_name: str, resolution: str) -> dict:
    """Google の Decisions API の本文（仕様 §6.2）。"""
    data = base64.b64encode(file.content).decode("ascii")
    if file.mime_type == "application/pdf":
        block = {
            "type": "document",
            "data": data,
            "mime_type": "application/pdf",
        }
    else:
        block = {
            "type": "image",
            "data": data,
            "mime_type": file.mime_type,
            "resolution": resolution,
        }
    questions: dict[str, dict] = {}
    for question in plan.questions:
        if isinstance(question, ChoiceQuestion):
            questions[question.key] = {
                "type": "choice",
                "instructions": question.instructions,
                "criteria": {option.key: option.description for option in question.options},
            }
        else:
            questions[question.key] = {
                "type": "noul",
                "instructions": question.instructions,
            }
    return {
        "model": model_name,
        "input": [{"type": "text", "text": COMMON_INPUT_TEXT}, block],
        "questions": questions,
    }


def build_openai_body(plan: JudgePlan, file, model_name: str) -> dict:
    """OpenAI の Decisions API の本文（仕様 §6.3）。PDF は送らない。"""
    if file.mime_type == "application/pdf":
        raise ValueError("OpenAI の審判には PDF を送れません")
    data = base64.b64encode(file.content).decode("ascii")
    questions = []
    for question in plan.questions:
        if isinstance(question, ChoiceQuestion):
            questions.append(
                {
                    "type": "choice",
                    "name": question.key,
                    "instructions": question.instructions,
                    "choices": [
                        {"value": option.key, "description": option.description}
                        for option in question.options
                    ],
                }
            )
        else:
            questions.append(
                {
                    "type": "predicate",
                    "name": question.key,
                    "instructions": question.instructions,
                }
            )
    return {
        "model": model_name,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": COMMON_INPUT_TEXT},
                    {
                        "type": "input_image",
                        "image_url": f"data:{file.mime_type};base64,{data}",
                    },
                ],
            }
        ],
        "questions": questions,
    }


def _validate_answers(plan: JudgePlan, raw, vendor: str) -> list[JudgeAnswer] | None:
    """返りが §6.4 の形か確かめ、質問の順に答えを返す。"""
    if vendor == VENDOR_GOOGLE:
        if not isinstance(raw, dict):
            return None
        lookup = raw.get
    else:
        if not isinstance(raw, list):
            return None
        by_name: dict[str, dict] = {}
        for entry in raw:
            if isinstance(entry, dict) and isinstance(entry.get("name"), str):
                by_name.setdefault(entry["name"], entry)

        def lookup(name):
            return by_name.get(name)

    validated: list[JudgeAnswer] = []
    for question in plan.questions:
        answer = lookup(question.key)
        if not isinstance(answer, dict):
            return None
        if isinstance(question, ChoiceQuestion):
            if answer.get("type") != "choice":
                return None
            choice = answer.get("choice")
            if not isinstance(choice, str):
                return None
            if choice not in {option.key for option in question.options}:
                return None
            confidence = _confidence(answer.get("confidence"))
            if confidence is None:
                return None
            validated.append(
                JudgeAnswer(
                    key=question.key,
                    kind="choice",
                    choice=choice,
                    confidence=confidence,
                )
            )
        else:
            if vendor == VENDOR_GOOGLE:
                if answer.get("type") != "noul":
                    return None
                probability = _confidence(answer.get("noul"))
            else:
                if answer.get("type") != "predicate":
                    return None
                probability = _confidence(answer.get("probability"))
            if probability is None:
                return None
            validated.append(JudgeAnswer(key=question.key, kind="count", probability=probability))
    return validated


def _raw_answers_text(raw) -> str:
    try:
        return json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(raw)


def _input_tokens(data, vendor: str) -> int | None:
    usage = data.get("usage") if isinstance(data, dict) else None
    if not isinstance(usage, dict):
        return None
    key = "total_input_tokens" if vendor == VENDOR_GOOGLE else "input_tokens"
    value = usage.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def judge_settings_text(judge: CompareModel, resolution: str) -> str:
    provider = "google" if judge.vendor == VENDOR_GOOGLE else "openai"
    resolution_text = resolution if provider == "google" else "なし"
    return (
        f"provider={provider}, judge, resolution={resolution_text}, prompt={JUDGE_PROMPT_VERSION}"
    )


def build_items_json(plan: JudgePlan, answers, base: list[list]) -> str:
    """結果タブの `明細JSON`（仕様 §5.3）。"""
    by_key = {answer.key: answer for answer in answers}
    data: dict = {"judge": 1, "base": base}
    if plan.count is not None and plan.count.key in by_key:
        count_answer = by_key[plan.count.key]
        data["count"] = {"asked": len(base), "p": count_answer.probability}
    items = []
    for item in plan.items:
        amount = by_key.get(item.amount.key)
        date = by_key.get(item.date.key)
        if amount is None or date is None:
            continue
        items.append(
            {
                "i": item.index,
                "a": {
                    "options": [option.key for option in item.amount.options],
                    "choice": amount.choice,
                    "confidence": amount.confidence,
                },
                "d": {
                    "options": [option.key for option in item.date.options],
                    "choice": date.choice,
                    "confidence": date.confidence,
                },
            }
        )
    data["items"] = items
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if len(text) > MAX_ITEMS_JSON:
        return ""
    return text


def _default_post(url, *, headers, body, timeout, transport=None):
    """httpx で送る。テストは `transport=httpx.MockTransport(...)` で網を開かない。"""
    try:
        if transport is None:
            return httpx.post(url, headers=headers, json=body, timeout=timeout)
        with httpx.Client(transport=transport) as client:
            return client.post(url, headers=headers, json=body, timeout=timeout)
    except httpx.LocalProtocolError as error:
        # 文にはヘッダーの値（鍵）が repr で入る。型の名前だけを渡す（§12.2）
        raise JudgeProtocolError(type(error).__name__) from error
    except httpx.TimeoutException as error:
        raise JudgeTransportError(f"{type(error).__name__}: {error}") from error
    except httpx.TransportError as error:
        raise JudgeTransportError(f"{type(error).__name__}: {error}") from error


class JudgeClient:
    """1 つの審判の型。HTTP は `post` で差し替えられる（テストは偽物を使う）。"""

    def __init__(
        self,
        judge: CompareModel,
        api_key: str | None,
        *,
        resolution: str = "high",
        timeout: int = 180,
        post=None,
        redact_keys=(),
    ):
        self.judge = judge
        self.vendor = judge_vendor_or_error(judge.name)
        original_key = "" if api_key is None else str(api_key)
        # ヘッダーに入れるのは前後の空白・改行を除いた値（§12.2）
        self.api_key = original_key.strip()
        self.resolution = resolution
        self.timeout = timeout
        self._post = post or _default_post
        keys = list(redact_keys or ())
        # 元の値・除いた値の両方を伏せる（§12.2）
        keys.extend((original_key, self.api_key))
        self._redact_keys = tuple(dict.fromkeys(str(key) for key in keys if key))

    def _redact(self, value) -> str:
        return redact_secrets(value, self._redact_keys)

    def _failure(
        self,
        result: str,
        started: float,
        *,
        error: str | None,
        detail: str = "",
        error_code: int | None = None,
        raw_answers: str = "",
    ) -> JudgeAttempt:
        return JudgeAttempt(
            result=result,
            answers=[],
            raw_answers=raw_answers,
            error=error,
            info={
                "latency_ms": int((time.monotonic() - started) * 1000),
                "prompt_tokens": None,
                "output_tokens": 0,
                "error": self._redact(detail) if detail else None,
                "error_code": error_code,
            },
        )

    def _check_file(self, file) -> str | None:
        if file.mime_type not in SUPPORTED_MIMES:
            return FAIL_UNSUPPORTED_MIME
        if self.vendor == VENDOR_OPENAI and file.mime_type == "application/pdf":
            # OpenAI の Decisions はファイルの入力に対応していない（§6.3）
            return FAIL_UNSUPPORTED_MIME
        if not file.content:
            return FAIL_EMPTY_CONTENT
        size = len(file.content)
        if self.vendor == VENDOR_GOOGLE:
            limit = GOOGLE_PDF_LIMIT if file.mime_type == "application/pdf" else GOOGLE_IMAGE_LIMIT
        else:
            limit = OPENAI_IMAGE_LIMIT
        if size > limit:
            return FAIL_TOO_LARGE
        return None

    def call(self, file, plan: JudgePlan) -> JudgeAttempt:
        started = time.monotonic()
        problem = self._check_file(file)
        if problem is not None:
            return self._failure(problem, started, error=problem.replace("失敗:", ""))

        if self.vendor == VENDOR_GOOGLE:
            url = GOOGLE_DECISIONS_URL
            headers = {
                "x-goog-api-key": self.api_key,
                "Content-Type": "application/json",
            }
            body = build_google_body(plan, file, self.judge.name, self.resolution)
        else:
            url = OPENAI_DECISIONS_URL
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            }
            body = build_openai_body(plan, file, self.judge.name)

        try:
            response = self._post(url, headers=headers, body=body, timeout=self.timeout)
        except JudgeProtocolError as error:
            # 型の名前だけを書き、やり直さない（error_code は None。§12.2）
            return self._failure(
                FAIL_API,
                started,
                error="api_error",
                detail=str(error),
            )
        except JudgeTransportError as error:
            # つながらない・時間切れは 503 としてやり直す（§6.1）
            return self._failure(
                FAIL_API,
                started,
                error="api_error",
                detail=f"{type(error).__name__}: {error}",
                error_code=503,
            )

        status = getattr(response, "status_code", None)
        try:
            status_code = int(status)
        except (TypeError, ValueError):
            status_code = None
        response_text = _text(getattr(response, "text", ""))
        if status_code != 200:
            return self._failure(
                FAIL_API,
                started,
                error="api_error",
                detail=f"HTTP {status_code}: {response_text}"[:300],
                error_code=status_code,
            )

        try:
            data = response.json()
        except (TypeError, ValueError):
            return self._failure(
                FAIL_BAD_RESPONSE,
                started,
                error="bad_response",
                detail="返りが JSON ではありません",
                raw_answers=response_text[:2000],
            )
        if not isinstance(data, dict):
            return self._failure(
                FAIL_BAD_RESPONSE,
                started,
                error="bad_response",
                detail="返りがオブジェクトではありません",
                raw_answers=_raw_answers_text(data)[:2000],
            )
        raw_answers = data.get("answers")
        validated = _validate_answers(plan, raw_answers, self.vendor)
        raw_text = _raw_answers_text(raw_answers)[:2000]
        if validated is None:
            return self._failure(
                FAIL_BAD_RESPONSE,
                started,
                error="bad_response",
                detail="返りの形が質問と合いません",
                raw_answers=raw_text,
            )
        return JudgeAttempt(
            result=SUCCESS,
            answers=validated,
            raw_answers=raw_text,
            error=None,
            info={
                "latency_ms": int((time.monotonic() - started) * 1000),
                "prompt_tokens": _input_tokens(data, self.vendor),
                "output_tokens": 0,
                "error": None,
                "error_code": None,
            },
        )


def judge_api_key_label(judge: CompareModel) -> str:
    return "GEMINI_API_KEY" if judge.vendor == VENDOR_GOOGLE else "OPENAI_API_KEY"


def base_for_file(file) -> list[list]:
    """審判に見せた Ib の写し（日付・金額だけ。§5.3）。"""
    return base_snapshot(file.image_items or [])

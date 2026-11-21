"""比較モード（RUN_MODE=compare）の設定。

環境変数の誤りは API を呼ぶ前に ValueError にし、runner がログに出して
終了コード 1 にする。
"""

import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from src.config import (
    THINKING_LEVELS,
    _parse_ai_request_timeout,
    _parse_ai_temperature,
    _parse_ai_thinking_level,
)
from src.models import extract_id_from_url

JST = timezone(timedelta(hours=9))

_MODEL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9.\-]*$")
_MODEL_ELEMENT_RE = re.compile(r"^[a-z0-9][a-z0-9.\-]*(@(minimal|low|medium|high))?$")
_RESULT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{20,}$")
_FOLDER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,}$")
_LABEL_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_LABEL_DISALLOWED_RE = re.compile(r"[^A-Za-z0-9_-]")

# もう 1 人の読み手の会社（型名の頭で決める。仕様 §4）
VENDOR_GEMINI = "gemini"
VENDOR_ANTHROPIC = "anthropic"
VENDOR_OPENAI = "openai"
# 審判の会社（型名の頭で決める。仕様 spec_judge_form §4）
VENDOR_GOOGLE = "google"
VENDOR_PREFIXES = {
    "gemini-": VENDOR_GEMINI,
    "claude-": VENDOR_ANTHROPIC,
    "gpt-": VENDOR_OPENAI,
}
JUDGE_VENDOR_PREFIXES = {
    "gemini-decision-": VENDOR_GOOGLE,
    "gpt-": VENDOR_OPENAI,
}
RESTRICTED_VENDOR_PREFIXES = ("claude-", "gpt-")
ANTHROPIC_EFFORTS = ("low", "medium", "high")
DEFAULT_OCR_PRICE_PER_PAGE_USD = 0.0015
DEFAULT_READER_MAX_TOKENS = 8192
READER_MAX_TOKENS_MIN = 256

# 審判（仕様 spec_judge_form §4）
METHOD_JUDGE = "審判"
JUDGE_RESOLUTIONS = ("low", "medium", "high", "ultra_high")
DEFAULT_JUDGE_THRESHOLDS = (0.70, 0.90, 0.97)
JUDGE_THRESHOLDS_MIN = 0.50
JUDGE_THRESHOLDS_MAX = 0.99
JUDGE_THRESHOLDS_MAX_COUNT = 5
_JUDGE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

DEFAULT_MODELS = "gemini-2.5-flash,gemini-3.5-flash-lite,gemini-3.8-flash"
DEFAULT_METHODS = ("text", "image")
METHOD_LABELS = {
    "text": "文字から",
    "image": "画像から",
    "current": "現行の流れ",
    "dual": "両読み",
    "judge": METHOD_JUDGE,
}

# 2026-11-18 に公式の料金表で確認した既定単価（100 万トークンあたり USD）
DEFAULT_PRICES: dict[str, tuple[float, float]] = {
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-3.5-flash-lite": (0.30, 2.50),
    # 2027-01-01 からの単価。長く使う前提で比べるためこちらを使う
    "gemini-3.8-flash": (1.50, 7.50),
    # 2026-11-17・11-20 に公式で確認（入力 10 万トークンまで。レシート 1 枚は数千）
    "claude-haiku-5-5": (0.10, 0.50),
    # 2026-11-20 に公式の料金表（標準）で確認
    "gpt-5.4-mini": (0.75, 4.50),
    # 2026-11-21 に公式で確認（審判。仕様 spec_judge_form §8）
    "gemini-decision-1": (0.10, 0.0),
    "gpt-6-luna": (0.10, 0.0),
    "gemini-4-hydrogen": (1.50, 7.50),
}


def vendor_of(name: str) -> str | None:
    """型名の頭から会社を決める。どれでもなければ None（仕様 §4）。"""
    text = (name or "").strip()
    for prefix, vendor in VENDOR_PREFIXES.items():
        if text.startswith(prefix):
            return vendor
    return None


def reader_vendor_or_error(name: str) -> str:
    vendor = vendor_of(name)
    if vendor is None:
        raise ValueError(
            "COMPARE_READERS の型名は gemini- / claude- / gpt- で始めてください"
            f" (received={name!r})"
        )
    return vendor


def judge_vendor_or_error(name: str) -> str:
    """審判の型名の頭から会社を決める。どれでもなければ ValueError（§4）。

    表の「型」と API に送る型名は書いたまま（大文字もそのまま）。会社の判定だけ
    小文字で行う（読み手の §14.6 と同じ注意）。
    """
    text = (name or "").strip()
    lowered = text.lower()
    for prefix, vendor in JUDGE_VENDOR_PREFIXES.items():
        if lowered.startswith(prefix):
            return vendor
    raise ValueError(
        f"COMPARE_JUDGES の型名は gemini-decision- / gpt- で始めてください (received={name!r})"
    )


@dataclass(frozen=True)
class CompareModel:
    """`型名` か `型名@考える量` の 1 要素。"""

    label: str
    name: str
    thinking_level: str | None = None
    vendor: str = VENDOR_GEMINI


@dataclass(frozen=True)
class CompareConfig:
    step: str = "collect"
    result_spreadsheet_id: str = ""
    folder_ids: tuple[str, ...] = ()
    models: tuple[CompareModel, ...] = ()
    methods: tuple[str, ...] = DEFAULT_METHODS
    # score で省略されたときは None（runner が既存タブから決める）
    run_label: str | None = None
    max_files: int | None = None
    max_workers: int = 4
    time_budget_seconds: int = 3300
    prices: dict[str, tuple[float, float]] = field(default_factory=dict)
    temperature: float | None = 0.1
    thinking_level: str | None = None
    max_tokens: int = 2048
    request_timeout_seconds: int | None = None
    # もう 1 人の読み手と「形」の計算（仕様 §4）
    readers: tuple[CompareModel, ...] = ()
    form_base: str | None = None
    ocr_price_per_page_usd: float = DEFAULT_OCR_PRICE_PER_PAGE_USD
    reader_max_tokens: int = DEFAULT_READER_MAX_TOKENS
    # 審判（仕様 spec_judge_form §4）。form C の下限 θ は score でも同じ変数を使う
    judges: tuple[CompareModel, ...] = ()
    judge_thresholds: tuple[float, ...] = DEFAULT_JUDGE_THRESHOLDS
    judge_image_resolution: str = "high"
    # score で COMPARE_MODELS / COMPARE_METHODS を省いたとき、結果タブから並びを作る
    models_set: bool = False
    methods_set: bool = False
    readers_set: bool = False
    form_base_set: bool = False
    judges_set: bool = False

    @property
    def result_tab(self) -> str:
        return result_tab_name(self.run_label or "")

    @property
    def ocr_tab(self) -> str:
        return ocr_tab_name(self.run_label or "")

    @property
    def summary_tab(self) -> str:
        return summary_tab_name(self.run_label or "")

    @property
    def effective_request_timeout(self) -> int:
        return self.request_timeout_seconds or 180


def result_tab_name(label: str) -> str:
    return f"結果_{label}"


def ocr_tab_name(label: str) -> str:
    return f"OCR_{label}"


def summary_tab_name(label: str) -> str:
    return f"集計_{label}"


def default_run_label(now: datetime | None = None) -> str:
    return (now or datetime.now(JST)).astimezone(JST).strftime("%Y%m%d-%H%M")


def label_from_execution(execution: str | None) -> str:
    """Cloud Run の実行名からラベルを作る（同じ実行のやり直しは同じ値）。"""
    cleaned = _LABEL_DISALLOWED_RE.sub("", execution or "")
    return cleaned[-40:]


def _require_int(
    env: dict,
    name: str,
    default: int | None,
    *,
    minimum: int,
    maximum: int | None = None,
) -> int | None:
    raw = env.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        value = int(str(raw).strip())
    except ValueError as e:
        raise ValueError(f"{name} は整数でなければなりません (received={raw!r})") from e
    if value < minimum or (maximum is not None and value > maximum):
        if maximum is None:
            raise ValueError(f"{name} は {minimum} 以上でなければなりません (received={value})")
        raise ValueError(f"{name} は {minimum}〜{maximum} でなければなりません (received={value})")
    return value


def _parse_models(raw: str | None) -> tuple[CompareModel, ...]:
    text = (raw or "").strip() or DEFAULT_MODELS
    models: list[CompareModel] = []
    seen: set[str] = set()
    for part in text.split(","):
        element = part.strip()
        if not element:
            continue
        label = element
        name = element
        thinking: str | None = None
        if "@" in element:
            name, _, level = element.partition("@")
            name = name.strip()
            level = level.strip().lower()
            if not level:
                raise ValueError(f"COMPARE_MODELS の @考える量 が空です (received={element!r})")
            if level not in THINKING_LEVELS:
                raise ValueError(
                    f"COMPARE_MODELS の考える量は {' / '.join(THINKING_LEVELS)} のいずれか "
                    f"(received={level!r})"
                )
            thinking = level
        if not _MODEL_NAME_RE.match(name):
            raise ValueError(f"COMPARE_MODELS の型名が不正です (received={element!r})")
        if name.startswith(RESTRICTED_VENDOR_PREFIXES):
            raise ValueError(
                "COMPARE_MODELS には Gemini の型だけを書けます。ほかの会社の型は COMPARE_READERS へ"
            )
        if label in seen:
            continue
        seen.add(label)
        models.append(CompareModel(label=label, name=name, thinking_level=thinking))
    if not models:
        raise ValueError("COMPARE_MODELS が空です")
    return tuple(models)


def _parse_readers(
    raw: str | None,
    models: tuple[CompareModel, ...],
    default_thinking: str | None,
    *,
    check_overlap: bool = True,
) -> tuple[CompareModel, ...]:
    """COMPARE_READERS を読む（仕様 §4）。

    Gemini は `@` が無ければ AI_THINKING_LEVEL に従う。Anthropic・OpenAI は
    low / medium / high だけ。`@` が無ければ何も送らない（その型の既定）。
    考える量は `COMPARE_MODELS` と同じく大文字でも受け、表の「型」は
    書いたまま（§14.4）。score は読み手を呼ばないので、`COMPARE_MODELS` との
    同じ要素の検査をしない（`check_overlap=False`）。
    """
    text = (raw or "").strip()
    if not text:
        return ()
    base_labels = {model.label for model in models}
    readers: list[CompareModel] = []
    seen: set[str] = set()
    for part in text.split(","):
        element = part.strip()
        if not element:
            continue
        label = element
        name = element
        thinking: str | None = None
        if "@" in element:
            name, _, level = element.partition("@")
            name = name.strip()
            level = level.strip().lower()
            if not level:
                raise ValueError(f"COMPARE_READERS の @考える量 が空です (received={element!r})")
            if level not in THINKING_LEVELS:
                raise ValueError(
                    f"COMPARE_READERS の考える量は {' / '.join(THINKING_LEVELS)} のいずれか "
                    f"(received={level!r})"
                )
            thinking = level
        if not _MODEL_NAME_RE.match(name):
            raise ValueError(f"COMPARE_READERS の要素が不正です (received={element!r})")
        vendor = reader_vendor_or_error(name)
        if vendor == VENDOR_GEMINI:
            if thinking is None:
                thinking = default_thinking
        else:
            if thinking == "minimal":
                raise ValueError(
                    "COMPARE_READERS の Anthropic・OpenAI の考える量は "
                    "low / medium / high のいずれか (received='minimal')"
                )
        if check_overlap and label in base_labels:
            raise ValueError(
                f"COMPARE_READERS と COMPARE_MODELS に同じ要素は書けません (received={label!r})"
            )
        if label in seen:
            continue
        seen.add(label)
        readers.append(CompareModel(label=label, name=name, thinking_level=thinking, vendor=vendor))
    return tuple(readers)


def _parse_judges(
    raw: str | None,
    models: tuple[CompareModel, ...],
    readers: tuple[CompareModel, ...],
    *,
    check_overlap: bool = True,
) -> tuple[CompareModel, ...]:
    """COMPARE_JUDGES を読む（仕様 spec_judge_form §4）。

    `@考える量` は書けない。重複は 1 つにする。collect では `COMPARE_MODELS`・
    `COMPARE_READERS` と同じ型名を断る（score は審判を呼ばないので検査しない）。
    """
    text = (raw or "").strip()
    if not text:
        return ()
    base_labels = {model.label for model in models} | {reader.label for reader in readers}
    judges: list[CompareModel] = []
    seen: set[str] = set()
    for part in text.split(","):
        element = part.strip()
        if not element:
            continue
        if "@" in element:
            raise ValueError(f"COMPARE_JUDGES に @考える量 は書けません (received={element!r})")
        if not _JUDGE_NAME_RE.match(element):
            raise ValueError(f"COMPARE_JUDGES の型名が不正です (received={element!r})")
        vendor = judge_vendor_or_error(element)
        if check_overlap and element in base_labels:
            raise ValueError(
                "COMPARE_JUDGES と COMPARE_MODELS / COMPARE_READERS に"
                f"同じ型名は書けません (received={element!r})"
            )
        if element in seen:
            continue
        seen.add(element)
        judges.append(CompareModel(label=element, name=element, vendor=vendor))
    return tuple(judges)


def _parse_judge_thresholds(raw: str | None) -> tuple[float, ...]:
    """COMPARE_JUDGE_THRESHOLDS を読む（§4）。小さい順・重複なし。"""
    if raw is None:
        return DEFAULT_JUDGE_THRESHOLDS
    text = str(raw).strip()
    if not text:
        raise ValueError("COMPARE_JUDGE_THRESHOLDS が空です")
    values: list[float] = []
    for part in text.split(","):
        element = part.strip()
        if not element:
            raise ValueError("COMPARE_JUDGE_THRESHOLDS に空の要素があります")
        try:
            value = float(element)
        except ValueError as e:
            raise ValueError(
                f"COMPARE_JUDGE_THRESHOLDS は数値でなければなりません (received={element!r})"
            ) from e
        if not math.isfinite(value):
            raise ValueError(
                f"COMPARE_JUDGE_THRESHOLDS は有限の数でなければなりません (received={value})"
            )
        if value < JUDGE_THRESHOLDS_MIN or value > JUDGE_THRESHOLDS_MAX:
            raise ValueError(
                "COMPARE_JUDGE_THRESHOLDS は "
                f"{JUDGE_THRESHOLDS_MIN:.2f}〜{JUDGE_THRESHOLDS_MAX:.2f} の数にしてください "
                f"(received={value})"
            )
        values.append(value)
    unique = sorted(set(values))
    if not unique:
        raise ValueError("COMPARE_JUDGE_THRESHOLDS が空です")
    if len(unique) > JUDGE_THRESHOLDS_MAX_COUNT:
        raise ValueError(
            "COMPARE_JUDGE_THRESHOLDS は "
            f"{JUDGE_THRESHOLDS_MAX_COUNT} 個までにしてください (received={len(unique)})"
        )
    return tuple(unique)


def _parse_judge_resolution(raw: str | None) -> str:
    value = (raw or "").strip().lower() or "high"
    if value not in JUDGE_RESOLUTIONS:
        raise ValueError(
            "COMPARE_JUDGE_IMAGE_RESOLUTION は "
            f"{' / '.join(JUDGE_RESOLUTIONS)} のいずれか (received={raw!r})"
        )
    return value


def _require_float(env: dict, name: str, default: float, *, minimum: float) -> float:
    raw = env.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        value = float(str(raw).strip())
    except ValueError as e:
        raise ValueError(f"{name} は数値でなければなりません (received={raw!r})") from e
    if not math.isfinite(value):  # nan / inf を受け付けない（§14.4）
        raise ValueError(f"{name} は有限の数でなければなりません (received={value})")
    if value < minimum:
        raise ValueError(f"{name} は {minimum} 以上でなければなりません (received={value})")
    return value


def _parse_methods(raw: str | None) -> tuple[str, ...]:
    text = (raw or "").strip()
    if not text:
        return DEFAULT_METHODS
    found: set[str] = set()
    for part in text.split(","):
        value = part.strip().lower()
        if not value:
            continue
        if value not in ("text", "image"):
            raise ValueError(f"COMPARE_METHODS は text / image のいずれか (received={part!r})")
        found.add(value)
    if not found:
        raise ValueError("COMPARE_METHODS が空です")
    return tuple(m for m in DEFAULT_METHODS if m in found)


def _parse_folder_ids(raw: str | None, *, required: bool) -> tuple[str, ...]:
    text = (raw or "").strip()
    if not text:
        if required:
            raise ValueError("COMPARE_FOLDER_IDS は必須です")
        return ()
    ids: list[str] = []
    for part in text.split(","):
        value = part.strip()
        if not value:
            continue
        folder_id = extract_id_from_url(value)
        if not _FOLDER_ID_RE.match(folder_id):
            raise ValueError(f"COMPARE_FOLDER_IDS の ID が不正です (received={value!r})")
        ids.append(folder_id)
    if not ids:
        raise ValueError("COMPARE_FOLDER_IDS が空です")
    return tuple(ids)


def _parse_result_id(raw: str | None) -> str:
    value = (raw or "").strip()
    if not value:
        raise ValueError("COMPARE_RESULT_SPREADSHEET_ID は必須です")
    spreadsheet_id = extract_id_from_url(value)
    if not _RESULT_ID_RE.match(spreadsheet_id):
        raise ValueError(f"COMPARE_RESULT_SPREADSHEET_ID の ID が不正です (received={value!r})")
    return spreadsheet_id


def _parse_prices(raw: str | None) -> dict[str, tuple[float, float]]:
    prices = dict(DEFAULT_PRICES)
    if raw is None or not raw.strip():
        return prices
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"COMPARE_PRICES_JSON が JSON として読めません: {e}") from e
    if not isinstance(data, dict):
        raise ValueError('COMPARE_PRICES_JSON は {"型名": [入力, 出力]} の形にしてください')
    for name, value in data.items():
        if (
            not isinstance(value, (list, tuple))
            or len(value) != 2
            or not all(isinstance(v, (int, float)) for v in value)
        ):
            raise ValueError(
                f"COMPARE_PRICES_JSON の {name!r} は [入力単価, 出力単価] にしてください"
            )
        prices[str(name)] = (float(value[0]), float(value[1]))
    return prices


def _parse_label(
    raw: str | None,
    step: str,
    now: datetime | None,
    cloud_execution: str | None = None,
) -> str | None:
    value = (raw or "").strip()
    if not value and step == "collect":
        # Cloud Run の自動のやり直しでは同じ実行名なので、続きからになる
        value = label_from_execution(cloud_execution)
    if not value:
        return default_run_label(now) if step == "collect" else None
    if not _LABEL_RE.match(value):
        raise ValueError(f"COMPARE_RUN_LABEL が不正です (received={value!r})")
    return value


def load_compare_config(env, now: datetime | None = None) -> CompareConfig:
    """比較の環境変数を読む。誤りは ValueError（メッセージは日本語）。"""
    step = (env.get("COMPARE_STEP") or "collect").strip().lower() or "collect"
    if step not in ("collect", "score"):
        raise ValueError(f"COMPARE_STEP は 'collect' か 'score' のいずれか (received={step!r})")

    result_spreadsheet_id = _parse_result_id(env.get("COMPARE_RESULT_SPREADSHEET_ID"))
    if step == "collect":
        folder_ids = _parse_folder_ids(env.get("COMPARE_FOLDER_IDS"), required=True)
    else:
        # score では使わない（値が残っていても読まない）
        folder_ids = ()
    models_raw = env.get("COMPARE_MODELS")
    methods_raw = env.get("COMPARE_METHODS")
    models = _parse_models(models_raw)
    methods = _parse_methods(methods_raw)
    run_label = _parse_label(
        env.get("COMPARE_RUN_LABEL"), step, now, env.get("CLOUD_RUN_EXECUTION")
    )
    max_files = _require_int(env, "COMPARE_MAX_FILES", None, minimum=1)
    max_workers = _require_int(env, "COMPARE_MAX_WORKERS", 4, minimum=1, maximum=8)
    time_budget = _require_int(env, "COMPARE_TIME_BUDGET_SECONDS", 3300, minimum=60)
    prices = _parse_prices(env.get("COMPARE_PRICES_JSON"))

    default_thinking = _parse_ai_thinking_level(env.get("AI_THINKING_LEVEL"))
    readers_raw = env.get("COMPARE_READERS")
    readers = _parse_readers(readers_raw, models, default_thinking, check_overlap=step != "score")
    judges_raw = env.get("COMPARE_JUDGES")
    judges = _parse_judges(judges_raw, models, readers, check_overlap=step != "score")
    judge_thresholds = _parse_judge_thresholds(env.get("COMPARE_JUDGE_THRESHOLDS"))
    judge_resolution = _parse_judge_resolution(env.get("COMPARE_JUDGE_IMAGE_RESOLUTION"))
    ocr_price = _require_float(
        env,
        "COMPARE_OCR_PRICE_PER_PAGE_USD",
        DEFAULT_OCR_PRICE_PER_PAGE_USD,
        minimum=0.0,
    )
    reader_max_tokens = _require_int(
        env,
        "COMPARE_READER_MAX_TOKENS",
        DEFAULT_READER_MAX_TOKENS,
        minimum=READER_MAX_TOKENS_MIN,
    )
    form_base_raw = (env.get("COMPARE_FORM_BASE") or "").strip()
    if form_base_raw and not _MODEL_ELEMENT_RE.match(form_base_raw):
        raise ValueError(f"COMPARE_FORM_BASE が不正です (received={form_base_raw!r})")
    if form_base_raw:
        form_base = form_base_raw
    elif step == "collect":
        form_base = models[0].label
    else:
        # score で COMPARE_MODELS を省いたときは、結果タブから決める（runner）
        form_base = models[0].label if (models_raw or "").strip() else None

    max_tokens_raw = env.get("AI_MAX_TOKENS")
    max_tokens = 2048
    if max_tokens_raw is not None and str(max_tokens_raw).strip():
        try:
            max_tokens = int(str(max_tokens_raw).strip())
        except ValueError as e:
            raise ValueError(
                f"AI_MAX_TOKENS は整数でなければなりません (received={max_tokens_raw!r})"
            ) from e
        if max_tokens <= 0:
            raise ValueError(
                f"AI_MAX_TOKENS は正の整数でなければなりません (received={max_tokens})"
            )

    return CompareConfig(
        step=step,
        result_spreadsheet_id=result_spreadsheet_id,
        folder_ids=folder_ids,
        models=models,
        methods=methods,
        run_label=run_label,
        max_files=max_files,
        max_workers=max_workers,
        time_budget_seconds=time_budget,
        prices=prices,
        temperature=_parse_ai_temperature(env.get("AI_TEMPERATURE")),
        thinking_level=_parse_ai_thinking_level(env.get("AI_THINKING_LEVEL")),
        max_tokens=max_tokens,
        request_timeout_seconds=_parse_ai_request_timeout(env.get("AI_REQUEST_TIMEOUT_SECONDS")),
        readers=readers,
        form_base=form_base,
        ocr_price_per_page_usd=ocr_price,
        reader_max_tokens=reader_max_tokens,
        judges=judges,
        judge_thresholds=judge_thresholds,
        judge_image_resolution=judge_resolution,
        models_set=bool((models_raw or "").strip()),
        methods_set=bool((methods_raw or "").strip()),
        readers_set=bool((readers_raw or "").strip()),
        form_base_set=bool(form_base_raw),
        judges_set=bool((judges_raw or "").strip()),
    )

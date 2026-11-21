"""もう 1 人の読み手（Anthropic・OpenAI）と安全の条件 R1〜R5 のテスト。

SDK は sandbox に入っていないので、偽のモジュールを `sys.modules` に入れる。
"""

import base64
import importlib
import logging
import sys
from datetime import UTC, datetime
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock

import pytest

import src.compare.readers as readers_module
import src.main as main_module
from src.ai import prompts
from src.ai.parsing import parse_receipt_items
from src.compare.pipeline import (
    AttemptOutcome,
    CompareRow,
    extract_once,
    extract_with_retries,
    make_result_row,
)
from src.compare.readers import (
    AnthropicReader,
    OpenAIReader,
    create_compare_reader,
    create_model_checker,
    reader_settings_text,
)
from src.compare.runner import run_compare
from src.compare.sheet import RESULT_HEADERS
from src.config import (
    AiConfig,
    AppConfig,
    DriveConfig,
    MasterConfig,
    OcrConfig,
    SheetsConfig,
    TemplateConfig,
)
from src.models import DriveFile, OcrResult

KEY = "fake-anthropic-key-AAA"
OPENAI_KEY = "fake-openai-key-BBB"
GEMINI_KEY = "fake-gemini-key-CCC"
RESULT_ID = "R" * 24
FOLDER = "FOLDER_A1234567890"
NOW = datetime(2026, 11, 20, 3, 0, tzinfo=UTC)


# ── 偽の SDK ───────────────────────────────────────────
class FakeStatusError(Exception):
    def __init__(self, status_code, message=None):
        self.status_code = status_code
        super().__init__(message or f"status {status_code}")


class FakeConnectionError(Exception):
    pass


def _install_sdk(monkeypatch, name):
    """`anthropic` / `openai` の偽モジュールを入れる。"""
    holder = {"init": [], "calls": [], "models": [], "response": None, "respond": None}

    def create(**kwargs):
        holder["calls"].append(kwargs)
        if holder["respond"] is not None:
            return holder["respond"](kwargs)
        return holder["response"]

    def retrieve(model_id):
        holder["models"].append(model_id)

    class Client:
        def __init__(self, **kwargs):
            holder["init"].append(kwargs)
            holder["client"] = self
            self.messages = SimpleNamespace(create=create)
            self.responses = SimpleNamespace(create=create)
            self.models = SimpleNamespace(retrieve=retrieve)

    module = ModuleType(name)
    if name == "anthropic":
        module.Anthropic = Client
    else:
        module.OpenAI = Client
    module.APIStatusError = FakeStatusError
    module.APIConnectionError = FakeConnectionError
    monkeypatch.setitem(sys.modules, name, module)
    return holder


def _config(model="claude-haiku-5-5", **overrides):
    values = {
        "model": model,
        "max_tokens": 8192,
        "temperature": None,
        "thinking_level": "low",
        "request_timeout_seconds": 45,
        "prompt_version": "v3",
    }
    values.update(overrides)
    return AiConfig(**values)


def _file(mime="image/jpeg", content=b"fake-image-bytes", name="a.jpg"):
    return DriveFile(
        file_id="FILE_A1234567890",
        file_name=name,
        mime_type=mime,
        folder_id=FOLDER,
        content=content,
    )


def _text_response(text='[{"date":"2026-01-02","amount":1600,"confidence":0.9}]'):
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)],
        stop_reason="end_turn",
        usage=SimpleNamespace(input_tokens=11, output_tokens=5),
    )


def _openai_response(text='[{"date":"2026-01-02","amount":1600,"confidence":0.9}]'):
    return SimpleNamespace(
        output_text=text,
        status="completed",
        incomplete_details=None,
        usage=SimpleNamespace(
            input_tokens=10,
            output_tokens=7,
            output_tokens_details=SimpleNamespace(reasoning_tokens=3),
        ),
    )


class TestAnthropicPayload:
    def test_image_payload_and_settings(self, monkeypatch):
        holder = _install_sdk(monkeypatch, "anthropic")
        holder["response"] = _text_response()
        reader = AnthropicReader(_config(), api_key=KEY)
        items = reader.extract_from_file(_file())
        assert len(items) == 1
        call = holder["calls"][0]
        assert call["model"] == "claude-haiku-5-5"
        assert call["max_tokens"] == 8192
        assert call["system"] == prompts.system_instruction("v3")
        content = call["messages"][0]["content"]
        assert content[0] == {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": base64.b64encode(b"fake-image-bytes").decode("ascii"),
            },
        }
        assert content[1] == {
            "type": "text",
            "text": prompts.image_user_message("v3", "a.jpg"),
        }
        assert call["output_config"] == {"effort": "low"}
        assert "temperature" not in call
        assert "thinking" not in call
        assert holder["init"] == [{"api_key": KEY, "timeout": 45, "max_retries": 0}]
        info = reader.last_call_info
        assert info["model"] == "claude-haiku-5-5"
        assert info["finish_reason"] == "end_turn"
        assert info["prompt_tokens"] == 11
        assert info["output_tokens"] == 5
        assert info["thinking_tokens"] is None
        assert info["error"] is None
        assert info["error_code"] is None
        assert info["raw_text"].startswith("[")

    def test_pdf_payload(self, monkeypatch):
        holder = _install_sdk(monkeypatch, "anthropic")
        holder["response"] = _text_response()
        reader = AnthropicReader(_config(thinking_level=None), api_key=KEY)
        reader.extract_from_file(_file("application/pdf", b"%PDF-fake", "a.pdf"))
        call = holder["calls"][0]
        block = call["messages"][0]["content"][0]
        assert block == {
            "type": "document",
            "source": {
                "type": "base64",
                "media_type": "application/pdf",
                "data": base64.b64encode(b"%PDF-fake").decode("ascii"),
            },
        }
        assert "output_config" not in call

    def test_unsupported_mime_and_empty_content_do_not_call(self, monkeypatch):
        holder = _install_sdk(monkeypatch, "anthropic")
        reader = AnthropicReader(_config(), api_key=KEY)
        assert reader.extract_from_file(_file("text/plain", b"x", "a.txt")) == []
        assert reader.last_extraction_error == "unsupported_mime"
        assert reader.extract_from_file(_file(content=b"")) == []
        assert reader.last_extraction_error == "empty_content"
        assert holder["calls"] == []

    def test_too_large_is_not_sent(self, monkeypatch):
        holder = _install_sdk(monkeypatch, "anthropic")
        monkeypatch.setattr(readers_module, "ANTHROPIC_IMAGE_BASE64_LIMIT", 4)
        reader = AnthropicReader(_config(), api_key=KEY)
        assert reader.extract_from_file(_file(content=b"12345")) == []
        assert reader.last_extraction_error == "too_large"
        assert holder["calls"] == []

    def test_too_large_pdf_is_not_sent(self, monkeypatch):
        holder = _install_sdk(monkeypatch, "anthropic")
        monkeypatch.setattr(readers_module, "ANTHROPIC_PDF_LIMIT", 4)
        reader = AnthropicReader(_config(), api_key=KEY)
        assert reader.extract_from_file(_file("application/pdf", b"12345", "a.pdf")) == []
        assert reader.last_extraction_error == "too_large"
        assert holder["calls"] == []

    def test_extract_receipt_data_is_not_implemented(self, monkeypatch):
        _install_sdk(monkeypatch, "anthropic")
        reader = AnthropicReader(_config(), api_key=KEY)
        with pytest.raises(NotImplementedError):
            reader.extract_receipt_data(OcrResult("x", "fake", 0.9), "a.jpg")


class TestOpenAIPayload:
    def test_image_payload_and_tokens(self, monkeypatch):
        holder = _install_sdk(monkeypatch, "openai")
        holder["response"] = _openai_response()
        reader = OpenAIReader(_config("gpt-5.4-mini"), api_key=OPENAI_KEY)
        items = reader.extract_from_file(_file())
        assert len(items) == 1
        call = holder["calls"][0]
        assert call["model"] == "gpt-5.4-mini"
        assert call["instructions"] == prompts.system_instruction("v3")
        assert call["max_output_tokens"] == 8192
        parts = call["input"][0]["content"]
        assert parts[0] == {
            "type": "input_image",
            "image_url": (
                "data:image/jpeg;base64," + base64.b64encode(b"fake-image-bytes").decode("ascii")
            ),
            "detail": "high",
        }
        assert parts[1] == {
            "type": "input_text",
            "text": prompts.image_user_message("v3", "a.jpg"),
        }
        assert call["reasoning"] == {"effort": "low"}
        assert "temperature" not in call
        assert holder["init"] == [{"api_key": OPENAI_KEY, "timeout": 45, "max_retries": 0}]
        info = reader.last_call_info
        assert info["finish_reason"] == "completed"
        assert info["prompt_tokens"] == 10
        assert info["thinking_tokens"] == 3
        assert info["output_tokens"] == 4  # 7 - 3（二重に数えない）

    def test_pdf_payload_and_incomplete(self, monkeypatch):
        holder = _install_sdk(monkeypatch, "openai")
        response = _openai_response()
        response.status = "incomplete"
        response.incomplete_details = SimpleNamespace(reason="max_output_tokens")
        holder["response"] = response
        reader = OpenAIReader(_config("gpt-5.4-mini", thinking_level=None), api_key=OPENAI_KEY)
        reader.extract_from_file(_file("application/pdf", b"%PDF-fake", "a.pdf"))
        call = holder["calls"][0]
        block = call["input"][0]["content"][0]
        assert block == {
            "type": "input_file",
            "filename": "a.pdf",
            "file_data": (
                "data:application/pdf;base64," + base64.b64encode(b"%PDF-fake").decode("ascii")
            ),
            "detail": "high",
        }
        assert "reasoning" not in call
        assert reader.last_call_info["finish_reason"] == "incomplete:max_output_tokens"

    def test_too_large_is_not_sent(self, monkeypatch):
        holder = _install_sdk(monkeypatch, "openai")
        monkeypatch.setattr(readers_module, "OPENAI_FILE_LIMIT", 4)
        reader = OpenAIReader(_config("gpt-5.4-mini"), api_key=OPENAI_KEY)
        assert reader.extract_from_file(_file(content=b"12345")) == []
        assert reader.last_extraction_error == "too_large"
        assert holder["calls"] == []


class TestEmptyResponse:
    def test_no_text_is_empty_response_for_anthropic(self, monkeypatch):
        holder = _install_sdk(monkeypatch, "anthropic")
        holder["response"] = SimpleNamespace(
            content=[],
            stop_reason="max_tokens",
            usage=SimpleNamespace(input_tokens=11, output_tokens=5),
        )
        reader = AnthropicReader(_config(), api_key=KEY)
        file = _file()
        assert reader.extract_from_file(file) == []
        info = reader.last_call_info
        assert reader.last_extraction_error == "api_error"
        assert info["error"] is None
        assert info["raw_text"] is None
        assert info["finish_reason"] == "max_tokens"
        row = make_result_row(
            run_label="L1",
            recorded_at="2026-11-20 12:00:00",
            file=file,
            folder_name="テスト用フォルダ",
            model_label="claude-haiku-5-5",
            model_name="claude-haiku-5-5",
            method="image",
            outcome=AttemptOutcome([], reader.last_extraction_error, info),
            retries=0,
            settings="x",
            ocr_text="",
        )
        assert row.result == "失敗:empty_response"
        assert row.finish_reason == "max_tokens"

    def test_no_text_is_empty_response_for_openai(self, monkeypatch):
        holder = _install_sdk(monkeypatch, "openai")
        response = _openai_response()
        response.output_text = None
        holder["response"] = response
        reader = OpenAIReader(_config("gpt-5.4-mini"), api_key=OPENAI_KEY)
        assert reader.extract_from_file(_file()) == []
        assert reader.last_extraction_error == "api_error"
        assert reader.last_call_info["error"] is None
        assert reader.last_call_info["raw_text"] is None

    def test_broken_json_is_parse_error(self, monkeypatch):
        holder = _install_sdk(monkeypatch, "anthropic")
        holder["response"] = _text_response("not json")
        reader = AnthropicReader(_config(), api_key=KEY)
        assert reader.extract_from_file(_file()) == []
        assert reader.last_extraction_error == "parse_error"


class TestRetries:
    def _reader(self, monkeypatch, responses):
        holder = _install_sdk(monkeypatch, "anthropic")
        calls = {"count": 0}

        def respond(kwargs):
            index = calls["count"]
            calls["count"] += 1
            outcome = responses[min(index, len(responses) - 1)]
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        holder["respond"] = respond
        return holder, AnthropicReader(_config(), api_key=KEY)

    def _run(self, reader):
        return extract_with_retries(
            lambda: extract_once(reader, "image", None, _file()),
            sleeps=(10, 30, 60),
            sleep=lambda seconds: None,
        )

    def test_429_is_retried(self, monkeypatch):
        _, reader = self._reader(monkeypatch, [FakeStatusError(429), _text_response()])
        outcome, retries = self._run(reader)
        assert retries == 1
        assert outcome.error is None
        assert outcome.info["error_code"] is None

    def test_400_is_not_retried(self, monkeypatch):
        _, reader = self._reader(monkeypatch, [FakeStatusError(400)])
        outcome, retries = self._run(reader)
        assert retries == 0
        assert outcome.error == "api_error"
        assert outcome.info["error_code"] == 400

    def test_connection_error_is_503_and_retried(self, monkeypatch):
        _, reader = self._reader(monkeypatch, [FakeConnectionError("down"), _text_response()])
        outcome, retries = self._run(reader)
        assert retries == 1
        assert outcome.error is None

    def test_connection_error_alone_has_503(self, monkeypatch):
        _, reader = self._reader(
            monkeypatch, [FakeConnectionError("down"), FakeConnectionError("down")]
        )
        outcome, retries = self._run(reader)
        assert retries == 3
        assert outcome.info["error_code"] == 503


class TestSettingsText:
    def test_provider_and_prompt_version(self):
        assert (
            reader_settings_text("anthropic", "low", 8192, "v1")
            == "provider=anthropic, effort=low, max_tokens=8192"
        )
        assert (
            reader_settings_text("openai", None, 8192, "v3")
            == "provider=openai, effort=なし, max_tokens=8192, prompt=v3"
        )


class TestFactory:
    def test_gemini_is_rejected(self):
        with pytest.raises(ValueError):
            create_compare_reader("gemini-test", _config("gemini-test"))

    def test_unknown_vendor_is_rejected(self):
        with pytest.raises(ValueError):
            create_compare_reader("mystery-model", _config("mystery-model"))

    def test_model_checker_uses_models_retrieve(self, monkeypatch):
        holder = _install_sdk(monkeypatch, "anthropic")
        check = create_model_checker("claude-haiku-5-5", KEY, 30)
        assert check("claude-haiku-5-5") is True
        assert holder["models"] == ["claude-haiku-5-5"]
        assert holder["init"] == [{"api_key": KEY, "timeout": 30, "max_retries": 0}]


# ── 統合（R1〜R5） ──────────────────────────────────────
class FakeSheet:
    def __init__(self):
        self.tabs: dict[str, list[list]] = {}
        self.appended = []
        self.batch_calls = []
        self.replaced = []
        self.calls = 0

    def get_sheet_titles(self):
        self.calls += 1
        return list(self.tabs)

    def ensure_tab(self, title, headers, *, check_headers=True, prefix_only=False):
        if title not in self.tabs:
            self.tabs[title] = [list(headers)]

    def read_dicts(self, title, *, formatted=False, cells=None):
        values = self.tabs.get(title, [])
        if not values:
            return []
        headers = [str(h) for h in values[0]]
        rows = []
        for offset, row in enumerate(values[1:], start=2):
            padded = list(row) + [""] * (len(headers) - len(row))
            record = {headers[i]: padded[i] for i in range(len(headers))}
            record["_row"] = offset
            rows.append(record)
        return rows

    def read_header(self, title):
        values = self.tabs.get(title, [])
        if not values:
            return []
        header = ["" if value is None else str(value) for value in values[0]]
        while header and header[-1] == "":
            header.pop()
        return header

    def append_rows(self, title, rows, columns):
        if not rows:
            return
        self.appended.append((title, rows))
        self.tabs.setdefault(title, [[]])
        self.tabs[title].extend(rows)

    def batch_update_cells(self, data):
        if data:
            self.batch_calls.append(data)

    def replace_all(self, title, rows):
        self.replaced.append(title)
        self.tabs[title] = [list(row) for row in rows]


class FakeDrive:
    def __init__(self, files=None):
        self.files = files or []
        self.downloads = []

    def list_files(self, folder_id):
        return list(self.files)

    def get_name(self, file_id):
        return "テスト用フォルダ"

    def download_file(self, file):
        self.downloads.append(file.file_id)
        file.content = b"downloaded"
        return file


class FakeOcr:
    def __init__(self, text="テスト商店 合計 1,600円"):
        self.text = text
        self.calls = 0

    def extract_text(self, file):
        self.calls += 1
        return OcrResult(raw_text=self.text, engine="fake", confidence=0.9, page_count=1)


class FakeExtractor:
    def __init__(self, model):
        self.model = model

    def _items(self):
        from src.models import ReceiptItem

        return [
            ReceiptItem(
                date="2026-01-02",
                amount=1600,
                vendor="テスト商店",
                description="テスト品",
                account="消耗品費",
                tax_category="課税仕入10%",
                confidence=0.9,
            )
        ]

    def _info(self):
        return {
            "model": self.model,
            "latency_ms": 12,
            "finish_reason": "STOP",
            "prompt_tokens": 10,
            "output_tokens": 2,
            "thinking_tokens": 0,
            "raw_text": "[]",
            "error": None,
            "error_code": None,
        }

    def extract_receipt_data(self, ocr_result, file_name):
        self.last_extraction_error = None
        self.last_call_info = self._info()
        return self._items()

    def extract_from_file(self, file):
        self.last_extraction_error = None
        self.last_call_info = self._info()
        return self._items()


def _app_config(**overrides):
    values = {
        "master": MasterConfig(),
        "template": TemplateConfig(),
        "drive": DriveConfig(),
        "sheets": SheetsConfig(),
        "ocr": OcrConfig(),
        "ai": AiConfig(),
        "gemini_api_key": GEMINI_KEY,
    }
    values.update(overrides)
    return AppConfig(**values)


def _env(**overrides):
    env = {
        "COMPARE_RESULT_SPREADSHEET_ID": RESULT_ID,
        "COMPARE_FOLDER_IDS": FOLDER,
        "COMPARE_MODELS": "m1",
        "COMPARE_METHODS": "text,image",
        "COMPARE_RUN_LABEL": "L1",
        "COMPARE_TIME_BUDGET_SECONDS": "60",
    }
    env.update(overrides)
    return env


def _collect(sheet, *, config=None, env=None, reader_factory=None, reader_checker=None):
    records = []

    class Capture(logging.Handler):
        def emit(self, record):
            records.append(record)

    handler = Capture()
    logger = logging.getLogger("receipt_ocr")
    logger.addHandler(handler)
    try:
        code = run_compare(
            config or _app_config(),
            env or _env(),
            sheet_client=sheet,
            drive_factory=lambda: FakeDrive(
                [
                    DriveFile(
                        file_id="FILE_A1234567890",
                        file_name="a.jpg",
                        mime_type="image/jpeg",
                        folder_id=FOLDER,
                    )
                ]
            ),
            ocr_factory=lambda: FakeOcr(),
            extractor_factory=lambda ai_config: FakeExtractor(ai_config.model),
            model_checker=lambda name: True,
            reader_checker=reader_checker or (lambda name: True),
            reader_factory=reader_factory,
            sleep=lambda seconds: None,
            jst_now=lambda: NOW,
        )
    finally:
        logger.removeHandler(handler)
    return code, records


def _result_rows(sheet):
    values = sheet.tabs.get("結果_L1", [])
    if not values:
        return []
    header = [str(value) for value in values[0]]
    return [dict(zip(header, row, strict=False)) for row in values[1:]]


class TestR1:
    def test_importing_the_readers_module_does_not_import_the_sdks(self, monkeypatch):
        monkeypatch.delitem(sys.modules, "anthropic", raising=False)
        monkeypatch.delitem(sys.modules, "openai", raising=False)
        importlib.reload(readers_module)
        assert "anthropic" not in sys.modules
        assert "openai" not in sys.modules

    def _run_main(self, monkeypatch, mode):
        for name in ("RUN_MODE", "TARGET_SCOPE", "TARGET_ROW"):
            monkeypatch.delenv(name, raising=False)
        import os

        for name in list(os.environ):
            if name.startswith("COMPARE_"):
                monkeypatch.delenv(name, raising=False)
        monkeypatch.delitem(sys.modules, "anthropic", raising=False)
        monkeypatch.delitem(sys.modules, "openai", raising=False)
        monkeypatch.setenv("RUN_MODE", mode)
        monkeypatch.setenv("MASTER_SPREADSHEET_ID", "MASTER")
        managers = MagicMock()
        managers.return_value.run.return_value = {}
        monkeypatch.setattr(main_module, "ProcessingManager", managers)
        monkeypatch.setattr(main_module, "MasterSheetClient", MagicMock())
        monkeypatch.setattr(main_module, "DriveClient", MagicMock())
        monkeypatch.setattr(main_module, "create_ocr_engine", MagicMock())
        monkeypatch.setattr(main_module, "create_ai_extractor", MagicMock())
        monkeypatch.setattr(main_module, "RuleCorrector", MagicMock())
        assert main_module.main() == 0
        assert "anthropic" not in sys.modules
        assert "openai" not in sys.modules

    def test_prod_does_not_import_or_build_readers(self, monkeypatch):
        self._run_main(monkeypatch, "prod")

    def test_validate_does_not_import_or_build_readers(self, monkeypatch):
        self._run_main(monkeypatch, "validate")


class TestR2:
    def test_only_the_requested_vendor_client_is_created(self, monkeypatch):
        anthropic = _install_sdk(monkeypatch, "anthropic")
        openai = _install_sdk(monkeypatch, "openai")
        anthropic["response"] = _text_response()
        sheet = FakeSheet()
        code, _ = _collect(
            sheet,
            env=_env(COMPARE_READERS="claude-haiku-5-5@low"),
            config=_app_config(anthropic_api_key=KEY, openai_api_key=OPENAI_KEY),
        )
        assert code == 0
        assert len(anthropic["init"]) == 1
        assert len(anthropic["calls"]) == 1
        assert openai["init"] == []
        assert openai["calls"] == []

    def test_without_readers_the_reader_factory_is_not_used(self):
        sheet = FakeSheet()
        called = []

        def factory(ai_config):
            called.append(ai_config.model)
            raise AssertionError("reader_factory")

        code, _ = _collect(sheet, reader_factory=factory)
        assert code == 0
        assert called == []
        methods = [row["方式"] for row in _result_rows(sheet)]
        assert methods == ["文字から", "画像から", "現行の流れ", "両読み"]

    def test_reader_rows_are_image_only_and_do_not_create_dual(self):
        sheet = FakeSheet()
        code, _ = _collect(
            sheet,
            env=_env(COMPARE_READERS="claude-haiku-5-5@low"),
            config=_app_config(anthropic_api_key=KEY),
            reader_factory=lambda ai_config: FakeExtractor(ai_config.model),
        )
        assert code == 0
        rows = _result_rows(sheet)
        reader_rows = [row for row in rows if row["型"] == "claude-haiku-5-5@low"]
        assert [row["方式"] for row in reader_rows] == ["画像から"]
        assert all(row["結果"] == "成功" for row in reader_rows)


class TestReaderSettings:
    def test_reader_rows_use_the_reader_settings_and_prompt_version(self):
        config = _app_config(
            anthropic_api_key=KEY,
            ai=AiConfig(prompt_version="v3"),
        )
        captured = []

        def factory(ai_config):
            captured.append(ai_config)
            return FakeExtractor(ai_config.model)

        sheet = FakeSheet()
        code, _ = _collect(
            sheet,
            env=_env(COMPARE_READERS="claude-haiku-5-5@low"),
            config=config,
            reader_factory=factory,
        )
        assert code == 0
        assert captured[0].prompt_version == "v3"
        assert captured[0].max_tokens == 8192
        reader_row = next(row for row in _result_rows(sheet) if row["型"] == "claude-haiku-5-5@low")
        assert reader_row["設定"] == ("provider=anthropic, effort=low, max_tokens=8192, prompt=v3")


class TestUnusableReader:
    def test_missing_reader_is_excluded_and_listed(self):
        class NotFoundError(Exception):
            status_code = 404

        def checker(name):
            raise NotFoundError("not found")

        sheet = FakeSheet()
        code, _ = _collect(
            sheet,
            env=_env(COMPARE_READERS="claude-haiku-5-5@low"),
            config=_app_config(anthropic_api_key=KEY),
            reader_checker=checker,
            reader_factory=lambda ai_config: (_ for _ in ()).throw(AssertionError("reader")),
        )
        assert code == 0
        assert all(row["型"] != "claude-haiku-5-5@low" for row in _result_rows(sheet))
        summary = sheet.tabs["集計_L1"]
        assert any(row[:2] == ["claude-haiku-5-5@low", "使えない型"] for row in summary)


class TestResumeReadersOnly:
    def _done_row(self, model, method):
        return CompareRow(
            run_label="L1",
            recorded_at="2026-11-20 12:00:00",
            file_id="FILE_A1234567890",
            folder_name="テスト用フォルダ",
            file_name="a.jpg",
            model_label=model,
            model_name=model,
            method=method,
            result="成功",
        ).to_sheet_row()

    def test_only_readers_left_does_not_call_vision(self):
        sheet = FakeSheet()
        sheet.tabs["結果_L1"] = [list(RESULT_HEADERS)]
        sheet.tabs["結果_L1"].append(self._done_row("m1", "文字から"))
        sheet.tabs["結果_L1"].append(self._done_row("m1", "画像から"))
        ocr = FakeOcr()
        records = []

        class Capture(logging.Handler):
            def emit(self, record):
                records.append(record)

        handler = Capture()
        logger = logging.getLogger("receipt_ocr")
        logger.addHandler(handler)
        try:
            code = run_compare(
                _app_config(anthropic_api_key=KEY),
                _env(COMPARE_READERS="claude-haiku-5-5@low"),
                sheet_client=sheet,
                drive_factory=lambda: FakeDrive(
                    [
                        DriveFile(
                            file_id="FILE_A1234567890",
                            file_name="a.jpg",
                            mime_type="image/jpeg",
                            folder_id=FOLDER,
                        )
                    ]
                ),
                ocr_factory=lambda: ocr,
                extractor_factory=lambda ai_config: (_ for _ in ()).throw(AssertionError("gemini")),
                model_checker=lambda name: True,
                reader_checker=lambda name: True,
                reader_factory=lambda ai_config: FakeExtractor(ai_config.model),
                sleep=lambda seconds: None,
                jst_now=lambda: NOW,
            )
        finally:
            logger.removeHandler(handler)
        assert code == 0
        assert ocr.calls == 0
        assert len(sheet.tabs.get("OCR_L1", [])) == 1  # 見出しだけ
        reader_rows = [row for row in _result_rows(sheet) if row["型"] == "claude-haiku-5-5@low"]
        assert [row["方式"] for row in reader_rows] == ["画像から"]


class TestR3:
    def test_missing_anthropic_key_stops_before_any_call(self):
        sheet = FakeSheet()
        code, records = _collect(
            sheet,
            env=_env(COMPARE_READERS="claude-haiku-5-5"),
            config=_app_config(anthropic_api_key=None),
            reader_factory=lambda ai_config: (_ for _ in ()).throw(AssertionError()),
        )
        assert code == 1
        assert sheet.calls == 0
        assert sheet.tabs == {}
        assert any("ANTHROPIC_API_KEY" in record.getMessage() for record in records)

    def test_missing_openai_key_stops_before_any_call(self):
        sheet = FakeSheet()
        code, records = _collect(
            sheet,
            env=_env(COMPARE_READERS="gpt-5.4-mini"),
            config=_app_config(openai_api_key=None),
            reader_factory=lambda ai_config: (_ for _ in ()).throw(AssertionError()),
        )
        assert code == 1
        assert sheet.calls == 0
        assert any("OPENAI_API_KEY" in record.getMessage() for record in records)

    def test_key_is_never_written_to_logs_or_sheets(self, monkeypatch):
        holder = _install_sdk(monkeypatch, "anthropic")
        holder["respond"] = lambda kwargs: (_ for _ in ()).throw(
            FakeStatusError(400, f"bad key {KEY}")
        )
        reader = AnthropicReader(_config("claude-haiku-5-5"), api_key=KEY)
        sheet = FakeSheet()
        code, records = _collect(
            sheet,
            env=_env(COMPARE_READERS="claude-haiku-5-5@low"),
            config=_app_config(anthropic_api_key=KEY),
            reader_factory=lambda ai_config: reader,
        )
        assert code == 0
        assert KEY not in str(sheet.tabs)
        assert all(KEY not in record.getMessage() for record in records)
        assert KEY not in str(reader.last_call_info)
        assert KEY not in str(sheet.batch_calls)


class TestR5:
    def test_score_works_without_keys_and_without_models_or_drive(self):
        sheet = FakeSheet()
        code, _ = _collect(sheet)
        assert code == 0
        score = run_compare(
            _app_config(anthropic_api_key=None, openai_api_key=None),
            _env(
                COMPARE_STEP="score",
                COMPARE_RUN_LABEL="L1",
                COMPARE_FOLDER_IDS="",
                COMPARE_MODELS=None,
                COMPARE_READERS="claude-haiku-5-5",
            ),
            sheet_client=sheet,
            drive_factory=lambda: (_ for _ in ()).throw(AssertionError("drive")),
            extractor_factory=lambda ai_config: (_ for _ in ()).throw(AssertionError("model")),
            model_checker=lambda name: (_ for _ in ()).throw(AssertionError("model")),
            jst_now=lambda: NOW,
        )
        assert score == 0
        assert "集計_L1" in sheet.replaced
        assert "形_L1" in sheet.replaced


class TestParsingShared:
    def test_all_three_readers_use_the_same_parser(self, monkeypatch):
        holder = _install_sdk(monkeypatch, "anthropic")
        holder["response"] = _text_response(
            '[{"date":"2026-01-02","amount":1600,"confidence":0.9,'
            '"pretax":1455,"tax":145,"tendered":2000,"change":400}]'
        )
        reader = AnthropicReader(_config(), api_key=KEY)
        items = reader.extract_from_file(_file())
        assert items[0].pretax == 1455
        assert items[0].tax == 145
        assert items[0].tendered == 2000
        assert items[0].change == 400
        assert parse_receipt_items('[{"amount":1600,"pretax":1455}]', "a.jpg")[0][0].pretax == 1455

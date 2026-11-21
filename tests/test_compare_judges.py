"""審判（仕様 spec_judge_form §4・§5.2・§6）のテスト。"""

import json
import math
import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from src.compare import judges
from src.compare.config import (
    DEFAULT_JUDGE_THRESHOLDS,
    VENDOR_GOOGLE,
    VENDOR_OPENAI,
    CompareModel,
    load_compare_config,
)
from src.compare.forms import ReadingItem
from src.compare.judges import (
    COMMON_INPUT_TEXT,
    GOOGLE_DECISIONS_URL,
    OPENAI_DECISIONS_URL,
    JudgeClient,
    JudgeTransportError,
    build_google_body,
    build_openai_body,
    build_questions,
)
from src.compare.pipeline import extract_with_retries, is_retryable
from src.processing.reconcile import LABEL_COUNT, ItemDecision, reconcile

RESULT_ID = "R" * 24
FOLDER_ID = "F" * 12
GEMINI_KEY = "fake-gemini-key-AAA"
OPENAI_KEY = "fake-openai-key-BBB"
GOOGLE_JUDGE = CompareModel(
    label="gemini-decision-1", name="gemini-decision-1", vendor=VENDOR_GOOGLE
)
OPENAI_JUDGE = CompareModel(label="gpt-6-luna", name="gpt-6-luna", vendor=VENDOR_OPENAI)


class _File:
    def __init__(self, mime="image/jpeg", content=b"fake-file-bytes"):
        self.file_id = "FILE_A1234567890"
        self.file_name = "a.jpg"
        self.folder_id = FOLDER_ID
        self.folder_name = "テスト用フォルダ"
        self.mime_type = mime
        self.content = content


def _env(**overrides):
    env = {
        "COMPARE_RESULT_SPREADSHEET_ID": RESULT_ID,
        "COMPARE_FOLDER_IDS": FOLDER_ID,
    }
    env.update({key: value for key, value in overrides.items() if value is not None})
    for key, value in overrides.items():
        if value is None:
            env.pop(key, None)
    return env


def _reading(date, amount, vendor=""):
    return ReadingItem(date=date, amount=amount, vendor=vendor)


def _plan(image_items=None, text_items=None, ocr="", vendors=None):
    images = image_items or [_reading("2026-01-02", 1600)]
    texts = text_items if text_items is not None else [_reading("2026-01-02", 1500)]
    decisions = reconcile(images, texts, ocr)
    return build_questions(images, texts, decisions, vendors or [item.vendor for item in images])


def _answer_plan(plan, *, amount="1600", date="2026-01-02", confidence=0.9, count=0.9):
    answers = {}
    for item in plan.items:
        answers[item.amount.key] = {
            "type": "choice",
            "choice": amount,
            "confidence": confidence,
        }
        answers[item.date.key] = {
            "type": "choice",
            "choice": date,
            "confidence": confidence,
        }
    if plan.count is not None:
        answers[plan.count.key] = {"type": "noul", "noul": count}
    return answers


def _openai_answers(plan, **kwargs):
    return [{"name": key, **value} for key, value in _answer_plan(plan, **kwargs).items()]


class TestConfig:
    def test_defaults(self):
        cfg = load_compare_config(_env())
        assert cfg.judges == ()
        assert cfg.judge_thresholds == DEFAULT_JUDGE_THRESHOLDS
        assert cfg.judge_image_resolution == "high"
        assert cfg.judges_set is False

    def test_judges_vendor_and_duplicates(self):
        cfg = load_compare_config(
            _env(COMPARE_JUDGES=(" gemini-decision-1 , gpt-6-luna , gemini-decision-1 "))
        )
        assert [judge.label for judge in cfg.judges] == [
            "gemini-decision-1",
            "gpt-6-luna",
        ]
        assert [judge.vendor for judge in cfg.judges] == [VENDOR_GOOGLE, VENDOR_OPENAI]
        assert cfg.judges_set is True

    def test_uppercase_is_kept_as_the_type(self):
        cfg = load_compare_config(_env(COMPARE_JUDGES="Gemini-Decision-1"))
        assert cfg.judges[0].label == "Gemini-Decision-1"
        assert cfg.judges[0].name == "Gemini-Decision-1"
        assert cfg.judges[0].vendor == VENDOR_GOOGLE

    @pytest.mark.parametrize(
        "value, message",
        [
            ("gemini-decision-1@low", "@考える量"),
            ("claude-haiku-5-5", "gemini-decision- / gpt-"),
            ("gemini-3.8-flash", "gemini-decision- / gpt-"),
        ],
    )
    def test_invalid_judges(self, value, message):
        with pytest.raises(ValueError, match=message):
            load_compare_config(_env(COMPARE_JUDGES=value))

    def test_judge_name_must_not_overlap_models_or_readers(self):
        with pytest.raises(ValueError, match="同じ型名"):
            load_compare_config(
                _env(COMPARE_MODELS="gemini-decision-1", COMPARE_JUDGES="gemini-decision-1")
            )
        with pytest.raises(ValueError, match="同じ型名"):
            load_compare_config(_env(COMPARE_READERS="gpt-6-luna", COMPARE_JUDGES="gpt-6-luna"))

    def test_score_skips_the_overlap_check(self):
        cfg = load_compare_config(
            _env(
                COMPARE_STEP="score",
                COMPARE_FOLDER_IDS=None,
                COMPARE_MODELS="gemini-decision-1",
                COMPARE_JUDGES="gemini-decision-1",
            )
        )
        assert [judge.label for judge in cfg.judges] == ["gemini-decision-1"]

    def test_thresholds_are_sorted_and_deduplicated(self):
        cfg = load_compare_config(_env(COMPARE_JUDGE_THRESHOLDS="0.97,0.70,0.90,0.70"))
        assert cfg.judge_thresholds == (0.70, 0.90, 0.97)

    @pytest.mark.parametrize(
        "value",
        ["", "0.49", "1.00", "nan", "inf", "0.50,0.60,0.70,0.80,0.90,0.95", "x"],
    )
    def test_invalid_thresholds(self, value):
        with pytest.raises(ValueError, match="COMPARE_JUDGE_THRESHOLDS"):
            load_compare_config(_env(COMPARE_JUDGE_THRESHOLDS=value))

    @pytest.mark.parametrize("value", ["low", "medium", "high", "ultra_high"])
    def test_resolution_values(self, value):
        cfg = load_compare_config(_env(COMPARE_JUDGE_IMAGE_RESOLUTION=value))
        assert cfg.judge_image_resolution == value

    def test_invalid_resolution(self):
        with pytest.raises(ValueError, match="COMPARE_JUDGE_IMAGE_RESOLUTION"):
            load_compare_config(_env(COMPARE_JUDGE_IMAGE_RESOLUTION="max"))

    def test_default_prices(self):
        cfg = load_compare_config(_env())
        assert cfg.prices["gemini-decision-1"] == (0.10, 0.0)
        assert cfg.prices["gpt-6-luna"] == (0.10, 0.0)
        assert cfg.prices["gemini-4-hydrogen"] == (1.50, 7.50)


class TestQuestions:
    def test_amount_only_difference(self):
        plan = _plan()
        assert plan.too_many is False
        assert len(plan.items) == 1
        amount = plan.items[0].amount
        assert [option.key for option in amount.options] == ["1600", "1500", "other"]
        assert amount.options[-1].description == judges.OTHER_AMOUNT_TEXT
        date = plan.items[0].date
        assert [option.key for option in date.options] == ["2026-01-02", "other"]
        assert plan.count is None

    def test_date_only_difference(self):
        plan = _plan(
            image_items=[_reading("2026-01-02", 1600)],
            text_items=[_reading("2026-01-03", 1600)],
        )
        date = plan.items[0].date
        assert [option.key for option in date.options] == [
            "2026-01-02",
            "2026-01-03",
            "other",
        ]

    def test_empty_text(self):
        plan = _plan(
            image_items=[_reading("2026-01-02", 1600)],
            text_items=[],
        )
        assert [option.key for option in plan.items[0].amount.options] == ["1600", "other"]

    def test_count_mismatch_adds_the_count_question(self):
        images = [_reading("2026-01-02", 1600)]
        texts = [_reading("2026-01-02", 1000), _reading("2026-01-03", 500)]
        decisions = reconcile(images, texts, "")
        assert decisions[0].label == LABEL_COUNT
        plan = build_questions(images, texts, decisions, ["テスト商店"])
        assert plan.count is not None
        assert plan.count.key == "n"
        assert "全部でちょうど 1 枚ですか" in plan.count.instructions
        assert plan.question_count == 3

    def test_digit_inflation_adds_the_leading_digit_removed_candidate(self):
        images = [_reading("2026-01-02", 41600)]
        texts = [_reading("2026-01-02", 41600)]
        decisions = reconcile(images, texts, "テスト商店 合計 1,600円")
        plan = build_questions(images, texts, decisions)
        keys = [option.key for option in plan.items[0].amount.options]
        assert keys == ["41600", "1600", "other"]

    def test_candidates_are_unique_and_other_is_last(self):
        images = [_reading("2026-01-02", 1600)]
        texts = [_reading("2026-01-02", amount) for amount in (1600, 1500, 1400, 1300, 1200, 1100)]
        decisions = [ItemDecision(False, "※金額要確認", "金額が食い違う", None)]
        plan = build_questions(images, texts, decisions)
        keys = [option.key for option in plan.items[0].amount.options]
        assert len(keys) == 6
        assert len(set(keys)) == 6
        assert keys[-1] == "other"
        assert keys.count("other") == 1

    def test_no_question_for_invalid_amount_or_date(self):
        images = [_reading("2026-01-02", 0), _reading("2026-13-01", 1600)]
        decisions = [
            ItemDecision(False, "※金額要確認", "金額が 0 以下", None),
            ItemDecision(False, "※日付要確認", "日付が食い違う", None),
        ]
        plan = build_questions(images, [], decisions)
        assert plan.items == []
        assert plan.empty is True

    def test_more_than_20_items_is_too_many(self):
        images = [_reading("2026-01-02", 100 + index) for index in range(21)]
        texts = [_reading("2026-01-02", 1) for _ in range(21)]
        decisions = [ItemDecision(False, "※金額要確認", "金額が食い違う", None) for _ in images]
        plan = build_questions(images, texts, decisions)
        assert len(plan.items) == 21
        assert plan.too_many is True

    def test_receipt_reference_and_vendor(self):
        one = _plan(
            image_items=[_reading("2026-01-02", 1600, "テスト商店")],
            text_items=[],
        )
        assert "このレシート" in one.items[0].amount.instructions
        assert "店名は「テスト商店」と読めます" in one.items[0].amount.instructions

        two = _plan(
            image_items=[
                _reading("2026-01-02", 1600, "あ" * 45 + "\n店"),
                _reading("2026-01-03", 500, ""),
            ],
            text_items=[],
        )
        second = two.items[1].amount.instructions
        assert "上から（ページ順に）2 番目のレシート" in second
        first = two.items[0].amount.instructions
        vendor = first.split("店名は「", 1)[1].split("」", 1)[0]
        assert len(vendor) == 40
        assert "\n" not in vendor


class TestBodies:
    def test_google_image_body(self):
        plan = _plan()
        body = build_google_body(plan, _File(), "gemini-decision-1", "high")
        assert body["model"] == "gemini-decision-1"
        assert body["input"][0] == {"type": "text", "text": COMMON_INPUT_TEXT}
        image = body["input"][1]
        assert image["type"] == "image"
        assert image["mime_type"] == "image/jpeg"
        assert image["resolution"] == "high"
        question = body["questions"]["a0"]
        assert question["type"] == "choice"
        assert question["criteria"]["other"] == judges.OTHER_AMOUNT_TEXT
        assert body["questions"]["d0"]["type"] == "choice"

    def test_google_pdf_body_has_no_resolution(self):
        plan = _plan()
        body = build_google_body(plan, _File("application/pdf"), "gemini-decision-1", "high")
        document = body["input"][1]
        assert document["type"] == "document"
        assert document["mime_type"] == "application/pdf"
        assert "resolution" not in document

    def test_google_count_question_uses_noul(self):
        images = [_reading("2026-01-02", 1600)]
        texts = [_reading("2026-01-02", 1000), _reading("2026-01-03", 500)]
        plan = build_questions(images, texts, reconcile(images, texts, ""))
        body = build_google_body(plan, _File(), "gemini-decision-1", "medium")
        assert body["questions"]["n"] == {
            "type": "noul",
            "instructions": plan.count.instructions,
        }

    def test_openai_image_body(self):
        plan = _plan()
        body = build_openai_body(plan, _File(), "gpt-6-luna")
        assert body["model"] == "gpt-6-luna"
        content = body["input"][0]["content"]
        assert content[0] == {"type": "input_text", "text": COMMON_INPUT_TEXT}
        assert content[1]["type"] == "input_image"
        assert content[1]["image_url"].startswith("data:image/jpeg;base64,")
        assert body["questions"][0]["type"] == "choice"
        assert body["questions"][0]["name"] == "a0"
        assert body["questions"][0]["choices"][-1]["value"] == "other"


class TestClient:
    def _post(self, response):
        calls = []

        def post(url, *, headers, body, timeout):
            calls.append({"url": url, "headers": headers, "body": body, "timeout": timeout})
            if isinstance(response, Exception):
                raise response
            return response

        return post, calls

    def test_google_success_url_headers_body_and_tokens(self):
        plan = _plan()
        response = httpx.Response(
            200,
            json={
                "answers": _answer_plan(plan),
                "usage": {"total_input_tokens": 123},
            },
        )
        post, calls = self._post(response)
        client = JudgeClient(GOOGLE_JUDGE, GEMINI_KEY, post=post, timeout=45)
        attempt = client.call(_File(), plan)
        assert attempt.result == "成功"
        assert attempt.info["prompt_tokens"] == 123
        assert [answer.choice for answer in attempt.answers] == ["1600", "2026-01-02"]
        call = calls[0]
        assert call["url"] == GOOGLE_DECISIONS_URL
        assert call["headers"]["x-goog-api-key"] == GEMINI_KEY
        assert call["timeout"] == 45
        assert GEMINI_KEY not in call["url"]
        assert GEMINI_KEY not in json.dumps(call["body"])

    def test_openai_success_url_headers_body_and_tokens(self):
        plan = _plan()
        response = httpx.Response(
            200,
            json={
                "answers": _openai_answers(plan),
                "usage": {"input_tokens": 77},
            },
        )
        post, calls = self._post(response)
        client = JudgeClient(OPENAI_JUDGE, OPENAI_KEY, post=post)
        attempt = client.call(_File(), plan)
        assert attempt.result == "成功"
        assert attempt.info["prompt_tokens"] == 77
        call = calls[0]
        assert call["url"] == OPENAI_DECISIONS_URL
        assert call["headers"]["Authorization"] == f"Bearer {OPENAI_KEY}"
        assert OPENAI_KEY not in call["url"]
        assert OPENAI_KEY not in json.dumps(call["body"])

    def test_openai_pdf_is_not_sent(self):
        plan = _plan()
        post, calls = self._post(httpx.Response(200, json={"answers": {}}))
        client = JudgeClient(OPENAI_JUDGE, OPENAI_KEY, post=post)
        attempt = client.call(_File("application/pdf"), plan)
        assert attempt.result == "失敗:unsupported_mime"
        assert calls == []

    @pytest.mark.parametrize(
        "mime, content, result",
        [
            ("image/gif", b"data", "失敗:unsupported_mime"),
            ("image/jpeg", b"", "失敗:empty_content"),
        ],
    )
    def test_unsupported_and_empty(self, mime, content, result):
        plan = _plan()
        post, calls = self._post(httpx.Response(200, json={"answers": {}}))
        client = JudgeClient(GOOGLE_JUDGE, GEMINI_KEY, post=post)
        attempt = client.call(_File(mime, content), plan)
        assert attempt.result == result
        assert calls == []

    def test_too_large_is_not_sent(self, monkeypatch):
        monkeypatch.setattr(judges, "GOOGLE_IMAGE_LIMIT", 3)
        plan = _plan()
        post, calls = self._post(httpx.Response(200, json={"answers": {}}))
        client = JudgeClient(GOOGLE_JUDGE, GEMINI_KEY, post=post)
        attempt = client.call(_File(content=b"abcd"), plan)
        assert attempt.result == "失敗:too_large"
        assert calls == []

    def test_http_error_is_api_error(self):
        plan = _plan()
        post, _ = self._post(httpx.Response(400, text="bad request"))
        client = JudgeClient(GOOGLE_JUDGE, GEMINI_KEY, post=post)
        attempt = client.call(_File(), plan)
        assert attempt.result == "失敗:api_error"
        assert attempt.error == "api_error"
        assert attempt.info["error_code"] == 400
        assert is_retryable(attempt) is False

    def test_timeout_is_503_and_retryable(self):
        plan = _plan()
        post, _ = self._post(JudgeTransportError("timed out"))
        client = JudgeClient(GOOGLE_JUDGE, GEMINI_KEY, post=post)
        attempt = client.call(_File(), plan)
        assert attempt.result == "失敗:api_error"
        assert attempt.info["error_code"] == 503
        assert is_retryable(attempt) is True

    def test_429_is_retried_then_succeeds(self):
        plan = _plan()
        statuses = [429, 200]

        def post(url, *, headers, body, timeout):
            status = statuses.pop(0)
            if status == 200:
                return httpx.Response(
                    200,
                    json={
                        "answers": _answer_plan(plan),
                        "usage": {"total_input_tokens": 1},
                    },
                )
            return httpx.Response(status, text="busy")

        client = JudgeClient(GOOGLE_JUDGE, GEMINI_KEY, post=post)
        sleeps = []
        attempt, retries = extract_with_retries(
            lambda: client.call(_File(), plan), sleep=sleeps.append
        )
        assert attempt.result == "成功"
        assert retries == 1
        assert sleeps == [10]

    def test_500_is_retried_then_succeeds(self):
        plan = _plan()
        statuses = [500, 200]

        def post(url, *, headers, body, timeout):
            status = statuses.pop(0)
            if status == 200:
                return httpx.Response(
                    200,
                    json={
                        "answers": _answer_plan(plan),
                        "usage": {"total_input_tokens": 1},
                    },
                )
            return httpx.Response(status, text="down")

        client = JudgeClient(GOOGLE_JUDGE, GEMINI_KEY, post=post)
        sleeps = []
        attempt, retries = extract_with_retries(
            lambda: client.call(_File(), plan), sleep=sleeps.append
        )
        assert attempt.result == "成功"
        assert retries == 1
        assert sleeps == [10]

    def test_400_is_not_retried(self):
        plan = _plan()
        calls = []

        def post(url, *, headers, body, timeout):
            calls.append(1)
            return httpx.Response(400, text="bad")

        client = JudgeClient(GOOGLE_JUDGE, GEMINI_KEY, post=post)
        _, retries = extract_with_retries(lambda: client.call(_File(), plan), sleep=lambda _: None)
        assert retries == 0
        assert len(calls) == 1

    @pytest.mark.parametrize(
        "mutate",
        [
            lambda answers: {},
            lambda answers: {**answers, "a0": {"type": "noul", "noul": 0.9}},
            lambda answers: {
                **answers,
                "a0": {"type": "choice", "choice": "999", "confidence": 0.9},
            },
            lambda answers: {
                **answers,
                "a0": {"type": "choice", "choice": "1600", "confidence": True},
            },
            lambda answers: {
                **answers,
                "a0": {"type": "choice", "choice": "1600", "confidence": 1.1},
            },
            lambda answers: {
                **answers,
                "d0": {"type": "choice", "choice": "2026-01-02"},
            },
        ],
    )
    def test_bad_response_validation(self, mutate):
        plan = _plan()
        answers = mutate(_answer_plan(plan))
        response = httpx.Response(200, json={"answers": answers})
        post, _ = self._post(response)
        client = JudgeClient(GOOGLE_JUDGE, GEMINI_KEY, post=post)
        attempt = client.call(_File(), plan)
        assert attempt.result == "失敗:bad_response"
        assert attempt.error == "bad_response"

    def test_nan_confidence_is_a_bad_response(self):
        plan = _plan()
        answers = _answer_plan(plan)
        answers["a0"]["confidence"] = float("nan")
        raw = json.dumps({"answers": answers}, ensure_ascii=False, allow_nan=True)
        response = httpx.Response(200, content=raw.encode("utf-8"))
        post, _ = self._post(response)
        client = JudgeClient(GOOGLE_JUDGE, GEMINI_KEY, post=post)
        assert client.call(_File(), plan).result == "失敗:bad_response"

    def test_extra_answers_are_ignored(self):
        plan = _plan()
        answers = {**_answer_plan(plan), "extra": {"type": "choice"}}
        response = httpx.Response(200, json={"answers": answers})
        post, _ = self._post(response)
        client = JudgeClient(GOOGLE_JUDGE, GEMINI_KEY, post=post)
        assert client.call(_File(), plan).result == "成功"

    def test_count_answer_must_be_a_probability(self):
        images = [_reading("2026-01-02", 1600)]
        texts = [_reading("2026-01-02", 1000), _reading("2026-01-03", 500)]
        plan = build_questions(images, texts, reconcile(images, texts, ""))
        answers = _answer_plan(plan)
        answers["n"] = {"type": "noul", "noul": True}
        response = httpx.Response(200, json={"answers": answers})
        post, _ = self._post(response)
        client = JudgeClient(GOOGLE_JUDGE, GEMINI_KEY, post=post)
        assert client.call(_File(), plan).result == "失敗:bad_response"

    def test_error_details_hide_keys_and_urls(self):
        plan = _plan()
        leaked = (
            f"boom {GEMINI_KEY} https://generativelanguage.googleapis.com/"
            f"v1beta/decisions?key={GEMINI_KEY}"
        )
        post, _ = self._post(JudgeTransportError(leaked))
        client = JudgeClient(GOOGLE_JUDGE, GEMINI_KEY, post=post, redact_keys=(OPENAI_KEY,))
        attempt = client.call(_File(), plan)
        assert GEMINI_KEY not in attempt.info["error"]
        assert OPENAI_KEY not in attempt.info["error"]
        assert "***" in attempt.info["error"]

    def test_401_body_with_a_key_is_redacted(self):
        plan = _plan()
        post, _ = self._post(httpx.Response(401, text=f"Incorrect API key provided: {GEMINI_KEY}"))
        client = JudgeClient(GOOGLE_JUDGE, GEMINI_KEY, post=post)
        attempt = client.call(_File(), plan)
        assert GEMINI_KEY not in attempt.info["error"]


class TestDefaultPost:
    """`_default_post` を本物の httpx の例外で通す（網は開かない。§12.2）。"""

    URL = GOOGLE_DECISIONS_URL

    def _call(self, handler, *, headers=None):
        transport = httpx.MockTransport(handler)
        return judges._default_post(
            self.URL,
            headers=headers or {"x-goog-api-key": "fake-gemini-key-AAA"},
            body={"model": "gemini-decision-1"},
            timeout=5,
            transport=transport,
        )

    @pytest.mark.parametrize(
        "error",
        [httpx.ReadTimeout("timed out"), httpx.ConnectError("no route to host")],
    )
    def test_network_errors_become_transport_errors(self, error):
        def handler(request):
            raise error

        with pytest.raises(JudgeTransportError) as info:
            self._call(handler)
        assert type(error).__name__ in str(info.value)

    def test_local_protocol_error_keeps_only_the_type_name(self):
        def handler(request):
            raise httpx.LocalProtocolError("Illegal header value b'fake-gemini-key-AAA\\n'")

        with pytest.raises(judges.JudgeProtocolError) as info:
            self._call(handler)
        assert str(info.value) == "LocalProtocolError"

    def test_success_through_the_transport(self):
        def handler(request):
            return httpx.Response(200, json={"answers": {}})

        response = self._call(handler)
        assert response.status_code == 200


class TestKeyWhitespace:
    """鍵の前後の空白・改行（§12.2）。"""

    @pytest.mark.parametrize("suffix", ["\n", "\r\n"])
    def test_trailing_newline_is_not_put_into_the_header(self, suffix):
        plan = _plan()
        seen = {}

        def handler(request):
            seen["key"] = request.headers["x-goog-api-key"]
            return httpx.Response(
                200,
                json={
                    "answers": _answer_plan(plan),
                    "usage": {"total_input_tokens": 1},
                },
            )

        transport = httpx.MockTransport(handler)
        raw_key = f"{GEMINI_KEY}{suffix}"

        def post(url, *, headers, body, timeout):
            return judges._default_post(
                url, headers=headers, body=body, timeout=timeout, transport=transport
            )

        client = JudgeClient(GOOGLE_JUDGE, raw_key, post=post)
        attempt = client.call(_File(), plan)
        assert attempt.result == "成功"
        assert seen["key"] == GEMINI_KEY
        assert "\n" not in seen["key"]
        assert "\r" not in seen["key"]

    @pytest.mark.parametrize("key", [f"{GEMINI_KEY}\n", f"{GEMINI_KEY}\r\n"])
    def test_both_the_original_and_the_stripped_key_are_redacted(self, key):
        plan = _plan()

        def post(url, *, headers, body, timeout):
            raise JudgeTransportError(f"boom {key} / {GEMINI_KEY}")

        client = JudgeClient(GOOGLE_JUDGE, key, post=post)
        attempt = client.call(_File(), plan)
        assert GEMINI_KEY not in attempt.info["error"]
        assert key not in attempt.info["error"]
        assert "***" in attempt.info["error"]

    @pytest.mark.parametrize("key", [f"{GEMINI_KEY}\n", f"{GEMINI_KEY}\r\n", "fake\nkey-AAA"])
    def test_local_protocol_error_is_not_retried_and_has_no_key(self, key):
        plan = _plan()

        def handler(request):
            raise httpx.LocalProtocolError(f"Illegal header value {key!r}")

        transport = httpx.MockTransport(handler)

        def post(url, *, headers, body, timeout):
            return judges._default_post(
                url, headers=headers, body=body, timeout=timeout, transport=transport
            )

        client = JudgeClient(GOOGLE_JUDGE, key, post=post)
        attempt = client.call(_File(), plan)
        assert attempt.result == "失敗:api_error"
        assert attempt.error == "api_error"
        assert attempt.info["error_code"] is None
        assert attempt.info["error"] == "LocalProtocolError"
        assert key.strip() not in attempt.info["error"]
        assert is_retryable(attempt) is False


class TestJ2:
    def test_prod_import_does_not_import_the_judges_module(self):
        project_root = Path(__file__).resolve().parents[1]
        code = "import src.main, sys; assert 'src.compare.judges' not in sys.modules"
        result = subprocess.run(
            [sys.executable, "-c", code],
            cwd=str(project_root),
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr


class TestJudgeJson:
    def test_items_json_shape(self):
        plan = _plan()
        answers = []
        for key in ("a0", "d0"):
            answers.append(
                judges.JudgeAnswer(key=key, kind="choice", choice="1600", confidence=0.9)
            )
        base = [[("2026-01-02"), 1600]]
        data = json.loads(judges.build_items_json(plan, answers, base))
        assert data["judge"] == 1
        assert data["base"] == [["2026-01-02", 1600]]
        assert data["items"][0]["i"] == 0
        assert data["items"][0]["a"]["choice"] == "1600"
        assert data["items"][0]["d"]["choice"] == "1600"

    def test_count_is_written_with_asked(self):
        images = [_reading("2026-01-02", 1600)]
        texts = [_reading("2026-01-02", 1000), _reading("2026-01-03", 500)]
        plan = build_questions(images, texts, reconcile(images, texts, ""))
        answers = [
            judges.JudgeAnswer(key="a0", kind="choice", choice="1600", confidence=0.9),
            judges.JudgeAnswer(key="d0", kind="choice", choice="2026-01-02", confidence=0.9),
            judges.JudgeAnswer(key="n", kind="count", probability=0.97),
        ]
        data = json.loads(judges.build_items_json(plan, answers, [["2026-01-02", 1600]]))
        assert data["count"] == {"asked": 1, "p": 0.97}


def test_nan_is_not_a_valid_confidence():
    assert judges._confidence(float("nan")) is None
    assert judges._confidence(float("inf")) is None
    assert judges._confidence(True) is None
    assert math.isfinite(judges._confidence(0.5))

"""両読みの要確認の行に、読み手の間で合った金額を M 列へ書くテスト。

仕様 docs/spec_review_amount.md（§4・§5・§6）。API も Drive も Sheets もすべて偽物。
テストの日付・金額・店名は架空のもの。
"""

from unittest.mock import MagicMock
from unittest.mock import call as mock_call

import src.processing.manager as manager_module
from src.config import (
    AiConfig,
    AppConfig,
    DriveConfig,
    MasterConfig,
    OcrConfig,
    SheetsConfig,
    TemplateConfig,
)
from src.models import CorrectedItem, DriveFile, OcrResult, ProcessStatus, ReceiptItem
from src.processing.duplicates import SAME_FILE_DUPLICATE_NOTE, ReceiptSource
from src.processing.manager import REVIEW_AMOUNT_NOTE, ProcessingManager
from src.sheets.client import _DONE_STATUSES

OCR_TEXT = "合計 ¥1,200"
TODAY = "2025-04-02"
NOW = "2025-04-02T10:00"
SECOND_MODEL = "gemini-3.8-flash"
FAKE_KEY = "fake-gemini-key-AAA"
DRIVE_LINK = "https://drive.google.com/file/d/fid-1/view"

A = ("2025-04-02", 1200)
B = ("2025-04-03", 900)


def _make_manager(
    *,
    flow: str = "dual",
    dry_run: bool = False,
    with_second: bool = False,
    second_items=None,
) -> tuple[ProcessingManager, dict[str, MagicMock], MagicMock | None]:
    config = AppConfig(
        master=MasterConfig(spreadsheet_id="m"),
        template=TemplateConfig(),
        drive=DriveConfig(),
        sheets=SheetsConfig(),
        ocr=OcrConfig(),
        ai=AiConfig(
            flow=flow,
            second_reader_model=SECOND_MODEL if with_second else None,
            second_reader_thinking_level="low" if with_second else None,
        ),
        gemini_api_key="fake-gemini-key-AAA",
        dry_run=dry_run,
    )
    mocks = {
        "drive": MagicMock(),
        "master": MagicMock(),
        "ocr": MagicMock(),
        "ai": MagicMock(),
        "corrector": MagicMock(),
    }
    mocks["drive"].download_file.side_effect = lambda f: f
    mocks["ai"].last_extraction_error = None
    mocks["ocr"].extract_text.return_value = OcrResult(
        raw_text=OCR_TEXT, engine="vision", confidence=0.9
    )
    mocks["corrector"].apply.side_effect = _corrected

    second = None
    if with_second:
        second = MagicMock()
        second.last_extraction_error = None
        second.extract_from_file.return_value = list(second_items or [])

    manager = ProcessingManager(
        config=config,
        drive=mocks["drive"],
        master=mocks["master"],
        ocr=mocks["ocr"],
        ai=mocks["ai"],
        corrector=mocks["corrector"],
        second_ai=second,
    )
    return manager, mocks, second


def _file(
    mime_type: str = "image/jpeg",
    *,
    file_id: str = "fid-1",
    file_name: str = "receipt-1.jpg",
) -> DriveFile:
    return DriveFile(
        file_id=file_id,
        file_name=file_name,
        mime_type=mime_type,
        folder_id="folder-1",
    )


def _cb_mock() -> MagicMock:
    cb = MagicMock()
    cb.reserve_rows.side_effect = lambda **kwargs: [
        (100 + i, f"rid-{i}") for i in range(kwargs["count"])
    ]
    return cb


def _item(
    date: str,
    amount,
    *,
    vendor: str = "テスト店",
    description: str = "テスト摘要",
    account: str = "雑費",
    tax_category: str = "課税仕入10%",
    is_expense: bool = True,
) -> ReceiptItem:
    return ReceiptItem(
        date=date,
        amount=amount,
        vendor=vendor,
        description=description,
        account=account,
        tax_category=tax_category,
        confidence=0.9,
        is_expense=is_expense,
    )


def _corrected(item: ReceiptItem) -> CorrectedItem:
    return CorrectedItem(
        original=item,
        date=item.date,
        amount=item.amount,
        time=item.time,
        receipt_no=item.receipt_no,
        vendor=item.vendor,
        description=item.description,
        account=item.account,
        tax_category=item.tax_category,
        confidence=item.confidence,
        is_expense=item.is_expense,
        memo=item.memo,
        needs_review=False,
    )


def _run(m, cb, *, processed_keys=None):
    return m._process_file(_file(), cb, processed_keys or set(), TODAY, NOW)


def _done_marks(cb: MagicMock, file_id: str) -> set[str]:
    """1 回目に update_reservation_status へ渡った状態から処理済みの印を作る。

    `_DONE_STATUSES` に入る状態だけを印にする（決め打ちの印は使わない）。
    """
    index_by_rid: dict[str, int] = {}
    for call in cb.reserve_rows.call_args_list:
        for position, index in enumerate(call.kwargs.get("receipt_indices", [])):
            index_by_rid[f"rid-{position}"] = index
    marks: set[str] = set()
    for call in cb.update_reservation_status.call_args_list:
        rid, status = call.args
        if status in _DONE_STATUSES and rid in index_by_rid:
            marks.add(f"{file_id}:{index_by_rid[rid]}")
    return marks


class TestReviewAmountIsWritten:
    def test_date_only_agreement_writes_the_main_amount(self):
        m, mocks, _ = _make_manager()
        cb = _cb_mock()
        image_item = _item(*A)
        mocks["ai"].extract_from_file.return_value = [image_item]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-03", 1200)]

        result = _run(m, cb)

        expected = (
            "両読み要確認（日付が食い違う）: "
            "画像=2025-04-02/1200 ｜ 文字=2025-04-03/1200"
            f"／{REVIEW_AMOUNT_NOTE}"
        )
        cb.write_manual_entry_row.assert_called_once_with(
            100,
            DRIVE_LINK,
            "2025-04-02",
            expected,
            corrected=_corrected(image_item),
            short_label="※日付要確認",
            amount=1200,
        )
        # W5: 要確認の行のまま（数える結果・処理管理の状態・AI 詳細ログ）
        assert (result.success, result.manual_entry, result.errors, result.skipped) == (
            0,
            1,
            0,
            0,
        )
        cb.write_cashbook_row.assert_not_called()
        cb.update_reservation_status.assert_any_call("rid-0", ProcessStatus.MANUAL_ENTRY.value)
        cb.append_process_record.assert_not_called()
        mocks["drive"].rename_file_as_done.assert_not_called()
        log = cb.append_ai_log.call_args[0][0]
        assert log.needs_review is True
        assert log.memo == expected
        assert "【済】" not in expected
        assert cb.reserve_rows.call_args.kwargs["receipt_indices"] == [0]

    def test_second_reader_agreement_writes_the_main_amount_not_the_seconds(self):
        """W2: 書く金額は主の画像から。もう 1 人の同じ位置の金額（999）は使わない。"""
        m, mocks, second = _make_manager(
            with_second=True,
            second_items=[
                _item("2025-04-02", 999, vendor="副店", description="副摘要"),
                _item("2025-04-03", 1200, vendor="副店2", description="副摘要2"),
            ],
        )
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*B)]
        mocks["ai"].extract_receipt_data.return_value = [
            _item("2025-04-02", 1500),
            _item("2025-04-03", 700),
        ]

        result = _run(m, cb)

        second.extract_from_file.assert_called_once()
        assert result.manual_entry == 2
        assert result.success == 0
        calls = cb.write_manual_entry_row.call_args_list
        assert [call.args[0] for call in calls] == [100, 101]
        # 1 件目: D0 は金額の食い違い、もう 1 人は日付だけ食い違う（金額 1200 が合う）
        assert calls[0].kwargs["amount"] == 1200
        assert calls[0].kwargs["short_label"] == "※日付要確認"
        assert "もう1人: 日付が食い違う" in calls[0].args[3]
        assert calls[0].args[3].endswith(f"／{REVIEW_AMOUNT_NOTE}")
        # もう 1 人の店名・摘要（副店／副摘要）は表の値に使わない（N3）
        assert calls[0].kwargs["corrected"].vendor == "テスト店"
        assert calls[0].kwargs["corrected"].description == "テスト摘要"
        # 2 件目: 金額が合わないので今までどおり M 列を書かない
        assert "amount" not in calls[1].kwargs
        assert calls[1].kwargs["short_label"] == "※金額要確認"
        assert REVIEW_AMOUNT_NOTE not in calls[1].args[3]

    def test_two_identical_items_and_one_text_item_write_no_m(self):
        """§11.1: 同じ明細 2 つに文字から 1 つなら、どちらが本物か決められず M はない。"""
        m, mocks, _ = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-03", 1200)]

        result = _run(m, cb)

        assert result.manual_entry == 2
        calls = cb.write_manual_entry_row.call_args_list
        assert [call.args[0] for call in calls] == [100, 101]
        assert [call.kwargs.get("amount") for call in calls] == [None, None]
        expected = (
            "両読み要確認（日付が食い違う）: "
            "画像=2025-04-02/1200, 2025-04-02/1200 ｜ 文字=2025-04-03/1200"
        )
        assert calls[0] == mock_call(
            100,
            DRIVE_LINK,
            "2025-04-02",
            expected,
            corrected=_corrected(_item(*A)),
            short_label="※日付要確認",
        )
        # 2 行目は今までの要確認の行のまま（重複の注記は今どおり後ろに付く）
        message = calls[1].args[3]
        assert message == f"{expected}／{SAME_FILE_DUPLICATE_NOTE}"
        assert REVIEW_AMOUNT_NOTE not in message
        assert calls[1].kwargs["short_label"] == "※日付要確認"
        assert "amount" not in calls[1].kwargs

    def test_amount_note_comes_before_the_duplicate_note(self):
        """§11.1: 文字からが同じ金額で 2 枚なら、2 行とも M。注記は金額の文が先。"""
        m, mocks, _ = _make_manager()
        cb = _cb_mock()
        images = [_item(*A), _item(*A)]
        mocks["ai"].extract_from_file.return_value = images
        mocks["ai"].extract_receipt_data.return_value = [
            _item("2025-04-03", 1200),
            _item("2025-04-04", 1200),
        ]

        result = _run(m, cb)

        assert result.manual_entry == 2
        calls = cb.write_manual_entry_row.call_args_list
        assert [call.kwargs.get("amount") for call in calls] == [1200, 1200]
        expected = (
            "両読み要確認（日付が食い違う）: "
            "画像=2025-04-02/1200, 2025-04-02/1200 "
            "｜ 文字=2025-04-03/1200, 2025-04-04/1200"
        )
        # 2 行目: 金額の文が重複の注記より前
        assert calls[1].args[3] == (f"{expected}／{REVIEW_AMOUNT_NOTE}／{SAME_FILE_DUPLICATE_NOTE}")
        assert calls[1].kwargs["short_label"] == "※日付要確認"

    def test_validate_counts_the_same_and_writes_nothing(self):
        """W8: 検証では何も書かず、予定の件数も今と同じ。"""
        m, mocks, _ = _make_manager(dry_run=True)
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-03", 1200)]

        result = _run(m, cb)

        assert (result.success, result.low_confidence, result.manual_entry) == (0, 0, 1)
        cb.reserve_rows.assert_not_called()
        cb.write_cashbook_row.assert_not_called()
        cb.write_manual_entry_row.assert_not_called()
        cb.append_ai_log.assert_not_called()
        cb.append_process_record.assert_not_called()
        mocks["drive"].rename_file_as_done.assert_not_called()


class TestCountRuleReviewAmounts:
    """§11.1: 主の画像からの枚数が、裏付ける読み手の同じ金額の枚数以下なら M を書く。"""

    def test_two_same_amounts_with_one_text_item_write_no_m(self):
        m, mocks, _ = _make_manager()
        cb = _cb_mock()
        images = [_item("2025-04-02", 1200), _item("2025-04-03", 1200)]
        mocks["ai"].extract_from_file.return_value = images
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-04", 1200)]

        result = _run(m, cb)

        assert (result.manual_entry, result.errors) == (2, 0)
        calls = cb.write_manual_entry_row.call_args_list
        assert [call.args[0] for call in calls] == [100, 101]
        expected = (
            "両読み要確認（日付が食い違う）: "
            "画像=2025-04-02/1200, 2025-04-03/1200 ｜ 文字=2025-04-04/1200"
        )
        # 主の画像からは 2 枚、文字からは 1 枚なので、2 行とも M なし
        assert cb.write_manual_entry_row.call_args_list == [
            mock_call(
                100,
                DRIVE_LINK,
                "2025-04-02",
                expected,
                corrected=_corrected(images[0]),
                short_label="※日付要確認",
            ),
            mock_call(
                101,
                DRIVE_LINK,
                "2025-04-03",
                expected,
                corrected=_corrected(images[1]),
                short_label="※日付要確認",
            ),
        ]

    def test_two_same_amounts_with_one_second_item_write_no_m(self):
        m, mocks, second = _make_manager(
            with_second=True,
            second_items=[_item("2025-04-04", 1200)],
        )
        cb = _cb_mock()
        images = [_item("2025-04-02", 1200), _item("2025-04-03", 1200)]
        mocks["ai"].extract_from_file.return_value = images
        mocks["ai"].extract_receipt_data.return_value = [
            _item("2025-04-02", 1500),
            _item("2025-04-03", 700),
        ]

        result = _run(m, cb)

        second.extract_from_file.assert_called_once()
        assert (result.manual_entry, result.errors) == (2, 0)
        calls = cb.write_manual_entry_row.call_args_list
        assert [call.args[0] for call in calls] == [100, 101]
        expected = (
            "両読み要確認（金額が食い違う／もう1人: 日付が食い違う）: "
            "画像=2025-04-02/1200, 2025-04-03/1200 "
            "｜ 文字=2025-04-02/1500, 2025-04-03/700 "
            "｜ もう1人=2025-04-04/1200"
        )
        # 主の画像からは 2 枚、もう 1 人は 1 枚なので、2 行とも M なし
        assert [call.kwargs.get("amount") for call in calls] == [None, None]
        assert calls[0].args[3] == expected
        assert calls[1].args[3] == expected
        assert calls[0].kwargs["short_label"] == "※金額要確認"
        assert calls[1].kwargs["short_label"] == "※金額要確認"

    def test_dx_date_agreement_with_a_digit_suspicion_does_not_write_m(self):
        """Dx が日付だけ食い違って金額が合っても、桁の疑いがあれば M を書かない。"""
        m, mocks, _ = _make_manager(
            with_second=True,
            second_items=[_item("2026-04-28", 41600)],
        )
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )
        cb = _cb_mock()
        image_item = _item("2026-04-27", 41600)
        mocks["ai"].extract_from_file.return_value = [image_item]
        mocks["ai"].extract_receipt_data.return_value = [_item("2026-04-27", 1500)]

        _run(m, cb)

        expected = (
            "両読み要確認（金額が食い違う／もう1人: 日付が食い違う）: "
            "画像=2026-04-27/41600 ｜ 文字=2026-04-27/1500 "
            "｜ もう1人=2026-04-28/41600"
        )
        assert cb.write_manual_entry_row.call_args_list == [
            mock_call(
                100,
                DRIVE_LINK,
                "2026-04-27",
                expected,
                corrected=_corrected(image_item),
                short_label="※金額要確認",
            )
        ]

    def test_eligible_excludes_count_and_reread_rows(self, monkeypatch):
        """§10.3: `eligible` は記帳する・合っていない・明細数/再読取でない番号だけ。"""
        seen: list[list[int]] = []
        real = manager_module.assign_review_amounts

        def spy(image_items, text_items, second_items, d0, dx, ocr_text, eligible):
            seen.append(list(eligible))
            return real(image_items, text_items, second_items, d0, dx, ocr_text, eligible)

        monkeypatch.setattr(manager_module, "assign_review_amounts", spy)
        m, mocks, _ = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        # 文字からが 1 枚多い → D0 は ※明細数要確認
        mocks["ai"].extract_receipt_data.return_value = [_item(*A), _item(*B)]

        _run(m, cb)

        assert seen == [[]]

    def test_eligible_excludes_automatic_and_cross_file_duplicate_rows(self, monkeypatch):
        """§10.3・§11.1: 自動の行と、別のファイルとの重複で記帳しない行は eligible に入らない。"""
        seen: list[list[int]] = []

        def spy(image_items, text_items, second_items, d0, dx, ocr_text, eligible):
            seen.append(list(eligible))
            return {}

        monkeypatch.setattr(manager_module, "assign_review_amounts", spy)
        m, mocks, _ = _make_manager()
        cb = _cb_mock()
        images = [
            _item("2025-04-02", 1200),  # 文字からと合う（自動）
            _item("2025-04-06", 700),  # 要確認（eligible）
            _item("2025-04-05", 800),  # 別のファイルと同じ証憑（記帳しない）
        ]
        mocks["ai"].extract_from_file.return_value = images
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-02", 1200)]
        known = [
            ReceiptSource(
                file_id="fid-other",
                file_name="other.jpg",
                index=0,
                date="2025-04-05",
                amount=800,
                vendor="テスト店",
            )
        ]

        result = m._process_file(_file(), cb, set(), TODAY, NOW, known_receipts=known)

        assert seen == [[1]]
        assert (result.success, result.manual_entry, result.skipped) == (1, 1, 1)

    def test_d0_read_with_no_text_items_can_write_m_from_the_second(self):
        m, mocks, _ = _make_manager(
            with_second=True,
            second_items=[_item("2025-04-03", 1200)],
        )
        cb = _cb_mock()
        image_item = _item(*A)
        mocks["ai"].extract_from_file.return_value = [image_item]
        mocks["ai"].extract_receipt_data.return_value = []

        result = _run(m, cb)

        assert (result.manual_entry, result.errors) == (1, 0)
        expected = (
            "両読み要確認（文字からの読みが無い／もう1人: 日付が食い違う）: "
            "画像=2025-04-02/1200 ｜ 文字=なし ｜ もう1人=2025-04-03/1200"
            f"／{REVIEW_AMOUNT_NOTE}"
        )
        assert cb.write_manual_entry_row.call_args_list == [
            mock_call(
                100,
                DRIVE_LINK,
                "2025-04-02",
                expected,
                corrected=_corrected(image_item),
                short_label="※日付要確認",
                amount=1200,
            )
        ]


class TestAfterWriteFailures:
    """§10.2: 行を書いた後の失敗で、同じ明細をもう一度記帳しない。"""

    @staticmethod
    def _fail(message: str = "boom") -> RuntimeError:
        return RuntimeError(f"{message} {FAKE_KEY}")

    def _logged_texts(self, fake_logger) -> list[str]:
        texts: list[str] = []
        for method in (
            fake_logger.debug,
            fake_logger.info,
            fake_logger.warning,
            fake_logger.error,
        ):
            texts.extend(str(call) for call in method.call_args_list)
        return texts

    def test_append_ai_log_failure_keeps_manual_entry_and_hides_the_message(self, monkeypatch):
        fake_logger = MagicMock()
        monkeypatch.setattr(manager_module, "logger", fake_logger)
        m, mocks, _ = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-03", 1200)]
        cb.append_ai_log.side_effect = self._fail()

        result = _run(m, cb)

        assert (result.manual_entry, result.errors) == (1, 0)
        statuses = [call.args[1] for call in cb.update_reservation_status.call_args_list]
        assert ProcessStatus.ERROR.value not in statuses
        assert statuses == [
            ProcessStatus.WRITTEN.value,
            ProcessStatus.MANUAL_ENTRY.value,
        ]
        steps = [
            call.kwargs.get("extra", {}).get("step") for call in fake_logger.error.call_args_list
        ]
        assert "dual_review_after_write_error" in steps
        assert all(FAKE_KEY not in text for text in self._logged_texts(fake_logger))

    def test_written_status_failure_still_tries_manual_entry(self, monkeypatch):
        fake_logger = MagicMock()
        monkeypatch.setattr(manager_module, "logger", fake_logger)
        m, mocks, _ = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-03", 1200)]

        def status_side_effect(rid, status):
            if status == ProcessStatus.WRITTEN.value:
                raise self._fail()

        cb.update_reservation_status.side_effect = status_side_effect

        result = _run(m, cb)

        assert (result.manual_entry, result.errors) == (1, 0)
        statuses = [call.args[1] for call in cb.update_reservation_status.call_args_list]
        assert statuses == [
            ProcessStatus.WRITTEN.value,
            ProcessStatus.MANUAL_ENTRY.value,
        ]
        cb.append_ai_log.assert_not_called()
        assert all(FAKE_KEY not in text for text in self._logged_texts(fake_logger))

    def test_manual_entry_failure_after_the_write_does_not_raise(self, monkeypatch):
        fake_logger = MagicMock()
        monkeypatch.setattr(manager_module, "logger", fake_logger)
        m, mocks, _ = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-03", 1200)]

        def status_side_effect(rid, status):
            if status in (ProcessStatus.WRITTEN.value, ProcessStatus.MANUAL_ENTRY.value):
                raise self._fail()

        cb.update_reservation_status.side_effect = status_side_effect

        result = _run(m, cb)

        # 例外は外へ出さず、error にもしない（状態はそのときのまま）
        assert (result.manual_entry, result.errors) == (1, 0)
        statuses = [call.args[1] for call in cb.update_reservation_status.call_args_list]
        assert ProcessStatus.ERROR.value not in statuses
        steps = [
            call.kwargs.get("extra", {}).get("step") for call in fake_logger.error.call_args_list
        ]
        assert "dual_review_after_write_error" in steps
        assert "dual_review_status_error" in steps
        assert all(FAKE_KEY not in text for text in self._logged_texts(fake_logger))

    def test_write_manual_entry_row_failure_still_sets_error(self, monkeypatch):
        fake_logger = MagicMock()
        monkeypatch.setattr(manager_module, "logger", fake_logger)
        m, mocks, _ = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-03", 1200)]
        cb.write_manual_entry_row.side_effect = RuntimeError("boom")

        result = _run(m, cb)

        # 行を書く前の失敗は今までどおり（行が無いので次の実行で読み直してよい）
        assert (result.manual_entry, result.errors) == (0, 1)
        assert cb.update_reservation_status.call_args_list == [
            mock_call("rid-0", ProcessStatus.ERROR.value)
        ]

    def test_a_mark_written_after_the_failure_prevents_a_second_row(self, monkeypatch):
        fake_logger = MagicMock()
        monkeypatch.setattr(manager_module, "logger", fake_logger)
        m, mocks, _ = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-03", 1200)]
        cb.append_ai_log.side_effect = self._fail()

        first = _run(m, cb)
        assert first.manual_entry == 1

        # 2 回目の印は、1 回目が update_reservation_status へ渡った状態から作る
        # （`_DONE_STATUSES` に入る状態だけ。決め打ちの印は使わない）。
        marks = _done_marks(cb, "fid-1")
        assert marks == {"fid-1:0"}

        m2, mocks2, _ = _make_manager()
        cb2 = _cb_mock()
        mocks2["ai"].extract_from_file.return_value = [_item(*A)]
        mocks2["ai"].extract_receipt_data.return_value = [_item("2025-04-03", 1200)]

        second = _run(m2, cb2, processed_keys=marks)

        assert (second.manual_entry, second.errors) == (0, 0)
        cb2.write_manual_entry_row.assert_not_called()
        cb2.reserve_rows.assert_not_called()

    def test_after_write_failure_the_item_is_remembered_for_later_files(self, monkeypatch):
        """§10.2: 書いた後の失敗でも、その明細を同じ回の後のファイルの重複の相手にする。"""
        fake_logger = MagicMock()
        monkeypatch.setattr(manager_module, "logger", fake_logger)
        m, mocks, _ = _make_manager()
        known: list[ReceiptSource] = []
        cb1 = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-03", 1200)]
        cb1.append_ai_log.side_effect = self._fail()

        first = m._process_file(_file(), cb1, set(), TODAY, NOW, known_receipts=known)

        assert first.manual_entry == 1
        assert [(source.file_id, source.index) for source in known] == [("fid-1", 0)]

        # 同じ回の後のファイル: 同じ日付・金額・店名なので重複として扱う
        cb2 = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]
        later = _file(file_id="fid-2", file_name="receipt-2.jpg")

        second = m._process_file(later, cb2, set(), TODAY, NOW, known_receipts=known)

        assert second.skipped == 1
        cb2.write_cashbook_row.assert_not_called()
        cb2.write_manual_entry_row.assert_not_called()


class TestReviewAmountIsNotWritten:
    """W1: §4 の条件を 1 つでも外れる行は、引数・文・ラベルが今と 1 つも変わらない。"""

    def test_both_readers_disagree_on_the_amount(self):
        m, mocks, _ = _make_manager(with_second=True, second_items=[_item("2025-04-02", 999)])
        cb = _cb_mock()
        image_item = _item(*A)
        mocks["ai"].extract_from_file.return_value = [image_item]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-02", 1500)]

        _run(m, cb)

        expected = (
            "両読み要確認（金額が食い違う／もう1人: 金額が食い違う）: "
            "画像=2025-04-02/1200 ｜ 文字=2025-04-02/1500 ｜ もう1人=2025-04-02/999"
        )
        assert cb.write_manual_entry_row.call_args_list == [
            mock_call(
                100,
                DRIVE_LINK,
                "2025-04-02",
                expected,
                corrected=_corrected(image_item),
                short_label="※金額要確認",
            )
        ]

    def test_digit_inflation_keeps_todays_row(self):
        """W3: 桁の疑いがある明細は M 列を書かない（文もラベルも今のまま）。"""
        m, mocks, _ = _make_manager()
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )
        cb = _cb_mock()
        image_item = _item("2026-04-27", 41600)
        mocks["ai"].extract_from_file.return_value = [image_item]
        mocks["ai"].extract_receipt_data.return_value = [_item("2026-04-27", 41600)]

        result = _run(m, cb)

        assert result.manual_entry == 1
        expected = (
            "両読み要確認（先頭の桁の読み違いの疑い）: "
            "画像=2026-04-27/41600 ｜ 文字=2026-04-27/41600"
        )
        assert cb.write_manual_entry_row.call_args_list == [
            mock_call(
                100,
                DRIVE_LINK,
                "2026-04-27",
                expected,
                corrected=_corrected(image_item),
                short_label="※金額要確認",
            )
        ]

    def test_digit_inflation_with_a_date_only_agreement_does_not_write_m(self):
        """W3: D0 が日付だけ食い違っても、桁の疑いがあれば M 列を書かない。"""
        m, mocks, _ = _make_manager()
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item("2026-04-27", 41600)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2026-04-28", 41600)]

        _run(m, cb)

        call = cb.write_manual_entry_row.call_args
        assert "amount" not in call.kwargs
        assert call.kwargs["short_label"] == "※日付要確認"
        assert REVIEW_AMOUNT_NOTE not in call.args[3]

    def test_empty_ocr_text_does_not_write_m(self):
        m, mocks, _ = _make_manager()
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="   ", engine="vision", confidence=0.9
        )
        cb = _cb_mock()
        image_item = _item(*A)
        mocks["ai"].extract_from_file.return_value = [image_item]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-03", 1200)]

        _run(m, cb)

        call = cb.write_manual_entry_row.call_args
        assert "amount" not in call.kwargs
        assert call.kwargs["short_label"] == "※読み取り要確認"
        assert REVIEW_AMOUNT_NOTE not in call.args[3]
        mocks["ai"].extract_receipt_data.assert_not_called()

    def test_numbered_marks_do_not_write_m(self):
        """W4: 前の回の印があるファイルの未処理の明細は M 列を書かない。"""
        m, mocks, _ = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*B)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-04", 900)]

        result = _run(m, cb, processed_keys={"fid-1:0"})

        assert result.skipped == 1
        assert result.manual_entry == 1
        assert cb.write_manual_entry_row.call_count == 1
        call = cb.write_manual_entry_row.call_args
        assert call.args[0] == 100
        assert "amount" not in call.kwargs
        assert call.kwargs["short_label"] == "※再読取要確認"

    def test_text_read_one_more_does_not_write_m_even_if_the_second_agrees(self):
        m, mocks, _ = _make_manager(with_second=True, second_items=[_item("2025-04-03", 1200)])
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A), _item(*B)]

        _run(m, cb)

        call = cb.write_manual_entry_row.call_args
        assert "amount" not in call.kwargs
        assert call.kwargs["short_label"] == "※明細数要確認"
        assert REVIEW_AMOUNT_NOTE not in call.args[3]

    def test_image_empty_text_only_does_not_write_m(self):
        m, mocks, _ = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = []
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]

        _run(m, cb)

        call = cb.write_manual_entry_row.call_args
        assert "amount" not in call.kwargs
        assert call.kwargs["short_label"] == "※読み取り要確認"
        assert REVIEW_AMOUNT_NOTE not in call.args[3]

    def test_non_expense_does_not_write_m(self):
        m, mocks, _ = _make_manager()
        cb = _cb_mock()
        image_item = _item(*A, is_expense=False)
        mocks["ai"].extract_from_file.return_value = [image_item]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-03", 1200)]

        _run(m, cb)

        call = cb.write_manual_entry_row.call_args
        assert "amount" not in call.kwargs
        assert call.kwargs["short_label"] == "※日付要確認"
        assert REVIEW_AMOUNT_NOTE not in call.args[3]


class TestOtherPathsNeverPassAmount:
    """W6: text_first・_manual_entry・金額NG・自動の行の失敗の代わりの行は変えない。"""

    def test_text_first_amount_invalid_row_is_unchanged(self):
        m, mocks, _ = _make_manager(flow="text_first")
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )
        cb = _cb_mock()
        mocks["ai"].extract_receipt_data.return_value = [_item("2026-04-27", 41600)]

        _run(m, cb)

        call = cb.write_manual_entry_row.call_args
        assert len(call.args) == 4
        assert call.args[:3] == (100, DRIVE_LINK, "2026-04-27")
        assert set(call.kwargs) == {"corrected", "short_label"}
        assert call.kwargs["short_label"] == "※金額要確認"

    def test_download_failure_row_is_unchanged(self):
        m, mocks, _ = _make_manager()
        mocks["drive"].download_file.side_effect = RuntimeError("boom")
        cb = _cb_mock()

        result = _run(m, cb)

        assert result.manual_entry == 1
        assert cb.write_manual_entry_row.call_args_list == [
            mock_call(
                100,
                DRIVE_LINK,
                TODAY,
                "receipt-1.jpg: DL失敗: boom",
                short_label=None,
            )
        ]

    def test_fallback_row_after_a_failed_automatic_write_is_unchanged(self):
        m, mocks, _ = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item(*A)]
        cb.write_cashbook_row.side_effect = RuntimeError("boom")

        result = _run(m, cb)

        assert result.manual_entry == 1
        assert cb.write_manual_entry_row.call_args_list == [
            mock_call(100, DRIVE_LINK, "2025-04-02", "明細[0]失敗: boom")
        ]

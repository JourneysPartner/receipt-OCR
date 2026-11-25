"""両読みの要確認の行に、読み手の間で合った金額を M 列へ書くテスト。

仕様 docs/spec_review_amount.md（§4・§5・§6）。API も Drive も Sheets もすべて偽物。
テストの日付・金額・店名は架空のもの。
"""

from unittest.mock import MagicMock
from unittest.mock import call as mock_call

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
from src.processing.duplicates import SAME_FILE_DUPLICATE_NOTE
from src.processing.manager import REVIEW_AMOUNT_NOTE, ProcessingManager

OCR_TEXT = "合計 ¥1,200"
TODAY = "2025-04-02"
NOW = "2025-04-02T10:00"
SECOND_MODEL = "gemini-3.8-flash"
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


def _file(mime_type: str = "image/jpeg") -> DriveFile:
    return DriveFile(
        file_id="fid-1",
        file_name="receipt-1.jpg",
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

    def test_duplicate_note_follows_the_amount_note(self):
        m, mocks, _ = _make_manager()
        cb = _cb_mock()
        mocks["ai"].extract_from_file.return_value = [_item(*A), _item(*A)]
        mocks["ai"].extract_receipt_data.return_value = [_item("2025-04-03", 1200)]

        result = _run(m, cb)

        assert result.manual_entry == 2
        calls = cb.write_manual_entry_row.call_args_list
        assert [call.kwargs["amount"] for call in calls] == [1200, 1200]
        message = calls[1].args[3]
        assert message.endswith(f"／{SAME_FILE_DUPLICATE_NOTE}")
        assert message.index(REVIEW_AMOUNT_NOTE) < message.index(SAME_FILE_DUPLICATE_NOTE)

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

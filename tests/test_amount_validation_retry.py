"""amount_validation NG 後の Gemini 再抽出フローのテスト"""

from unittest.mock import MagicMock

from src.config import (
    AiConfig,
    AppConfig,
    DriveConfig,
    MasterConfig,
    OcrConfig,
    SheetsConfig,
    TemplateConfig,
)
from src.models import CorrectedItem, DriveFile, OcrResult, ReceiptItem
from src.processing.manager import ProcessingManager


def _make_manager(*, retry_enabled: bool = True) -> tuple[ProcessingManager, dict[str, MagicMock]]:
    config = AppConfig(
        master=MasterConfig(spreadsheet_id="m"),
        template=TemplateConfig(),
        drive=DriveConfig(),
        sheets=SheetsConfig(),
        ocr=OcrConfig(),
        ai=AiConfig(enable_amount_validation_retry=retry_enabled),
    )
    mocks = {
        "drive": MagicMock(),
        "master": MagicMock(),
        "ocr": MagicMock(),
        "ai": MagicMock(),
        "corrector": MagicMock(),
    }
    m = ProcessingManager(
        config=config,
        drive=mocks["drive"],
        master=mocks["master"],
        ocr=mocks["ocr"],
        ai=mocks["ai"],
        corrector=mocks["corrector"],
    )
    return m, mocks


def _file() -> DriveFile:
    return DriveFile(file_id="fid", file_name="r.jpg", mime_type="image/jpeg", folder_id="folder")


def _cb_mock() -> MagicMock:
    cb = MagicMock()
    cb.get_processed_keys.return_value = set()
    cb.reserve_rows.return_value = [(10, "rid-1")]
    return cb


def _setup_passthrough_corrector(mocks: dict[str, MagicMock]) -> None:
    mocks["corrector"].apply.side_effect = lambda it: CorrectedItem(
        original=it,
        date=it.date,
        amount=it.amount,
        vendor=it.vendor,
        description=it.description,
        account=it.account,
        tax_category=it.tax_category,
        confidence=it.confidence,
        is_expense=it.is_expense,
        memo=it.memo,
        needs_review=False,
    )


class TestRetryAdoptsCorrectedAmount:
    def test_vision_ng_then_gemini_ok_becomes_success(self):
        """Vision で digit_inflation → Gemini で正しい amount → success として通常書き込み"""
        m, mocks = _make_manager()
        cb = _cb_mock()
        _setup_passthrough_corrector(mocks)

        # Vision OCR で 1,600 が見えている、AI は誤って 41,600
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )
        mocks["ai"].extract_receipt_data.return_value = [
            ReceiptItem(
                date="2026-04-27",
                amount=41600,
                vendor="店",
                description="領収",
                account="雑費",
                tax_category="課税仕入10%",
                confidence=0.95,
            )
        ]
        # Gemini が画像から再抽出して 1,600 と訂正
        mocks["ai"].extract_from_file.return_value = [
            ReceiptItem(
                date="2026-04-27",
                amount=1600,
                vendor="店",
                description="領収",
                account="雑費",
                tax_category="課税仕入10%",
                confidence=0.95,
            )
        ]

        result = m._process_file(_file(), cb, set(), "2026-04-27", "2026-04-27T10:00")
        assert result.success == 1
        assert result.manual_entry == 0
        # 通常記帳パス
        cb.write_cashbook_row.assert_called_once()
        cb.write_manual_entry_row.assert_not_called()
        # 採用された amount は 1600
        written_item = cb.write_cashbook_row.call_args[0][1]
        assert written_item.amount == 1600
        # 再抽出が呼ばれた
        mocks["ai"].extract_from_file.assert_called_once()
        # success → 【済】 付与
        mocks["drive"].rename_file_as_done.assert_called_once()

    def test_vision_ok_no_retry(self):
        """primary が OK なら再抽出は呼ばれない"""
        m, mocks = _make_manager()
        cb = _cb_mock()
        _setup_passthrough_corrector(mocks)
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.95
        )
        mocks["ai"].extract_receipt_data.return_value = [
            ReceiptItem(
                date="2026-04-27",
                amount=1600,
                vendor="x",
                description="y",
                account="雑費",
                tax_category="課税仕入10%",
                confidence=0.95,
            )
        ]
        m._process_file(_file(), cb, set(), "2026-04-27", "2026-04-27T10:00")
        mocks["ai"].extract_from_file.assert_not_called()

    def test_retry_still_ng_falls_to_manual_entry(self):
        """再抽出してもまだ NG なら manual_entry"""
        m, mocks = _make_manager()
        cb = _cb_mock()
        _setup_passthrough_corrector(mocks)
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )
        mocks["ai"].extract_receipt_data.return_value = [
            ReceiptItem(amount=41600, account="雑費", confidence=0.9, description="x")
        ]
        # 再抽出も 9999 で OCR 候補に無い → missing_in_ocr
        mocks["ai"].extract_from_file.return_value = [
            ReceiptItem(amount=9999, account="雑費", confidence=0.9, description="x")
        ]

        result = m._process_file(_file(), cb, set(), "2026-04-27", "2026-04-27T10:00")
        assert result.manual_entry == 1
        assert result.success == 0
        cb.write_cashbook_row.assert_not_called()
        cb.write_manual_entry_row.assert_called_once()
        mocks["ai"].extract_from_file.assert_called_once()
        mocks["drive"].rename_file_as_done.assert_not_called()

    def test_retry_disabled_falls_to_manual_directly(self):
        """ENABLE_AMOUNT_VALIDATION_RETRY=false なら再抽出を呼ばずに manual_entry"""
        m, mocks = _make_manager(retry_enabled=False)
        cb = _cb_mock()
        _setup_passthrough_corrector(mocks)
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )
        mocks["ai"].extract_receipt_data.return_value = [
            ReceiptItem(amount=41600, account="雑費", confidence=0.9, description="x")
        ]
        result = m._process_file(_file(), cb, set(), "2026-04-27", "2026-04-27T10:00")
        assert result.manual_entry == 1
        mocks["ai"].extract_from_file.assert_not_called()

    def test_retry_returns_empty_falls_to_manual(self):
        """再抽出が空 (エンジン未対応 / 例外) でも manual_entry"""
        m, mocks = _make_manager()
        cb = _cb_mock()
        _setup_passthrough_corrector(mocks)
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )
        mocks["ai"].extract_receipt_data.return_value = [
            ReceiptItem(amount=41600, account="雑費", confidence=0.9, description="x")
        ]
        mocks["ai"].extract_from_file.return_value = []

        result = m._process_file(_file(), cb, set(), "2026-04-27", "2026-04-27T10:00")
        assert result.manual_entry == 1
        cb.write_manual_entry_row.assert_called_once()


class TestSelectRetryItem:
    def test_same_length_match_by_index(self):
        from src.models import ReceiptItem

        items = [ReceiptItem(amount=1), ReceiptItem(amount=2), ReceiptItem(amount=3)]
        assert ProcessingManager._select_retry_item(items, 1, 3).amount == 2

    def test_single_to_single_use_first(self):
        from src.models import ReceiptItem

        items = [ReceiptItem(amount=99)]
        assert ProcessingManager._select_retry_item(items, 0, 1).amount == 99

    def test_count_mismatch_returns_none(self):
        """件数が違って 1:1 でも 1:N でもない → 安全側で None"""
        from src.models import ReceiptItem

        items = [ReceiptItem(amount=1), ReceiptItem(amount=2)]
        assert ProcessingManager._select_retry_item(items, 0, 3) is None

    def test_empty_returns_none(self):
        assert ProcessingManager._select_retry_item([], 0, 1) is None


class TestFormatRetryMemo:
    def test_no_retry(self):
        from src.rules.amount_validation import AmountValidation

        primary = AmountValidation(status="ok")
        memo = ProcessingManager._format_retry_memo(
            primary=primary, retry_attempted=False, retry=None, adopted="primary"
        )
        assert "retry=no" in memo
        assert "amount_status=ok" in memo
        assert "adopted=primary" in memo

    def test_with_retry_adopted(self):
        from src.rules.amount_validation import AmountValidation

        primary = AmountValidation(status="digit_inflation")
        retry = AmountValidation(status="ok")
        memo = ProcessingManager._format_retry_memo(
            primary=primary, retry_attempted=True, retry=retry, adopted="retry"
        )
        assert "retry=gemini_image" in memo
        assert "amount_status=digit_inflation→ok" in memo
        assert "adopted=retry" in memo

    def test_with_retry_rejected(self):
        from src.rules.amount_validation import AmountValidation

        primary = AmountValidation(status="missing_in_ocr")
        retry = AmountValidation(status="missing_in_ocr")
        memo = ProcessingManager._format_retry_memo(
            primary=primary, retry_attempted=True, retry=retry, adopted="primary"
        )
        assert "retry=gemini_image" in memo
        assert "amount_status=missing_in_ocr→missing_in_ocr" in memo
        assert "adopted=primary" in memo

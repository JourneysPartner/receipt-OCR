"""ProcessingManager の金額検証・【済】付与ロジックの統合テスト"""

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
from src.models import DriveFile, OcrResult, ReceiptItem
from src.processing.manager import ProcessingManager


def _make_manager() -> tuple[ProcessingManager, dict[str, MagicMock]]:
    """全外部依存をモック化した ProcessingManager"""
    config = AppConfig(
        master=MasterConfig(spreadsheet_id="master"),
        template=TemplateConfig(),
        drive=DriveConfig(),
        sheets=SheetsConfig(),
        ocr=OcrConfig(),
        ai=AiConfig(),
    )
    mocks = {
        "drive": MagicMock(),
        "master": MagicMock(),
        "ocr": MagicMock(),
        "ai": MagicMock(),
        "corrector": MagicMock(),
    }
    manager = ProcessingManager(
        config=config,
        drive=mocks["drive"],
        master=mocks["master"],
        ocr=mocks["ocr"],
        ai=mocks["ai"],
        corrector=mocks["corrector"],
    )
    return manager, mocks


def _file() -> DriveFile:
    return DriveFile(
        file_id="fid1", file_name="receipt.jpg", mime_type="image/jpeg", folder_id="folder"
    )


def _cashbook_mock() -> MagicMock:
    """CashbookClient のモック。既処理キーは空、空き行は常に 10番。"""
    cb = MagicMock()
    cb.get_processed_keys.return_value = set()
    cb.reserve_rows.return_value = [(10, "rid-1")]
    return cb


def _setup_ocr_and_ai(
    mocks: dict[str, MagicMock],
    ocr_text: str,
    item: ReceiptItem,
) -> None:
    mocks["ocr"].extract_text.return_value = OcrResult(
        raw_text=ocr_text, engine="vision", confidence=0.99
    )
    mocks["ai"].extract_receipt_data.return_value = [item]
    # corrector は pass-through
    from src.models import CorrectedItem

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


class TestAmountValidationRoutesToManualEntry:
    def test_digit_inflation_1600_to_41600_becomes_manual(self):
        """実ケース: OCR 1,600 / AI 41,600 は manual_entry 行にまわる"""
        m, mocks = _make_manager()
        cb = _cashbook_mock()
        _setup_ocr_and_ai(
            mocks,
            ocr_text="合計 ¥1,600 税込",
            item=ReceiptItem(
                date="2026-04-23",
                amount=41600,
                vendor="店",
                description="領収証",
                account="雑費",
                tax_category="課税仕入10%",
                confidence=0.95,  # confidence は高い
            ),
        )

        result = m._process_file(_file(), cb, set(), "2026-04-23", "2026-04-23T10:00:00+09:00")

        assert result.manual_entry == 1
        assert result.success == 0
        # 通常の write_cashbook_row は呼ばれない（manual_entry 経路）
        cb.write_cashbook_row.assert_not_called()
        cb.write_manual_entry_row.assert_called_once()
        # 【済】は付かない
        mocks["drive"].rename_file_as_done.assert_not_called()

    def test_ok_amount_stays_success_and_renames(self):
        """整合する金額なら success、rename で 【済】 が付く"""
        m, mocks = _make_manager()
        cb = _cashbook_mock()
        _setup_ocr_and_ai(
            mocks,
            ocr_text="合計 ¥1,600 税込",
            item=ReceiptItem(
                date="2026-04-23",
                amount=1600,
                vendor="店",
                description="領収証",
                account="雑費",
                tax_category="課税仕入10%",
                confidence=0.95,
            ),
        )

        result = m._process_file(_file(), cb, set(), "2026-04-23", "2026-04-23T10:00:00+09:00")

        assert result.success == 1
        assert result.manual_entry == 0
        cb.write_cashbook_row.assert_called_once()
        # 成功なので 【済】 が付与される
        mocks["drive"].rename_file_as_done.assert_called_once()

    def test_missing_in_ocr_becomes_manual(self):
        """OCR 候補に全く無い金額も manual_entry"""
        m, mocks = _make_manager()
        cb = _cashbook_mock()
        _setup_ocr_and_ai(
            mocks,
            ocr_text="合計 ¥500",
            item=ReceiptItem(
                date="2026-04-23",
                amount=9999,
                vendor="店",
                description="x",
                account="雑費",
                tax_category="課税仕入10%",
                confidence=0.98,
            ),
        )

        result = m._process_file(_file(), cb, set(), "2026-04-23", "2026-04-23T10:00:00+09:00")
        assert result.manual_entry == 1
        mocks["drive"].rename_file_as_done.assert_not_called()

    def test_no_ocr_candidates_does_not_block_success(self):
        """OCR 候補が取れない場合は判断不能なので success として通す"""
        m, mocks = _make_manager()
        cb = _cashbook_mock()
        _setup_ocr_and_ai(
            mocks,
            ocr_text="テキストのみ",
            item=ReceiptItem(
                date="2026-04-23",
                amount=1234,
                vendor="店",
                description="x",
                account="雑費",
                tax_category="課税仕入10%",
                confidence=0.9,
            ),
        )

        result = m._process_file(_file(), cb, set(), "2026-04-23", "2026-04-23T10:00:00+09:00")
        assert result.success == 1
        mocks["drive"].rename_file_as_done.assert_called_once()


class TestRenameTiming:
    def test_rename_not_called_when_manual_entry_happens(self):
        """OCR 失敗 → manual_entry のときは rename しない"""
        m, mocks = _make_manager()
        cb = _cashbook_mock()
        # OCR 失敗
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="", engine="vision", confidence=0.0, error="API disabled"
        )

        result = m._process_file(_file(), cb, set(), "2026-04-23", "2026-04-23T10:00:00+09:00")
        assert result.manual_entry == 1
        mocks["drive"].rename_file_as_done.assert_not_called()

    def test_rename_not_called_on_dry_run(self):
        m, mocks = _make_manager()
        m._config = AppConfig(
            master=MasterConfig(spreadsheet_id="m"),
            template=TemplateConfig(),
            drive=DriveConfig(),
            sheets=SheetsConfig(),
            ocr=OcrConfig(),
            ai=AiConfig(),
            dry_run=True,
        )
        cb = _cashbook_mock()
        _setup_ocr_and_ai(
            mocks,
            ocr_text="合計 ¥1,600",
            item=ReceiptItem(
                date="2026-04-23",
                amount=1600,
                vendor="店",
                description="x",
                account="雑費",
                tax_category="課税仕入10%",
                confidence=0.9,
            ),
        )

        m._process_file(_file(), cb, set(), "2026-04-23", "2026-04-23T10:00:00+09:00")
        mocks["drive"].rename_file_as_done.assert_not_called()

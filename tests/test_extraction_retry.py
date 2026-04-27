"""AI 抽出 retry（0件 / parse_error）のテスト"""

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


def _make_manager(
    *, extraction_retry: bool = True, amount_retry: bool = True
) -> tuple[ProcessingManager, dict[str, MagicMock]]:
    config = AppConfig(
        master=MasterConfig(spreadsheet_id="m"),
        template=TemplateConfig(),
        drive=DriveConfig(),
        sheets=SheetsConfig(),
        ocr=OcrConfig(),
        ai=AiConfig(
            enable_extraction_retry=extraction_retry,
            enable_amount_validation_retry=amount_retry,
        ),
    )
    mocks = {
        "drive": MagicMock(),
        "master": MagicMock(),
        "ocr": MagicMock(),
        "ai": MagicMock(),
        "corrector": MagicMock(),
    }
    # AI モックの初期 last_extraction_error
    mocks["ai"].last_extraction_error = None
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


def _setup_passthrough_corrector(mocks):
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


def _ai_extract_then_set_error(mocks: dict[str, MagicMock], items: list, error: str | None):
    """extract_receipt_data の戻り値を items にして、その後 last_extraction_error をセット"""

    def side_effect(*args, **kwargs):
        mocks["ai"].last_extraction_error = error
        return items

    mocks["ai"].extract_receipt_data.side_effect = side_effect


def _ai_retry_then_set_error(mocks, items: list, error: str | None):
    def side_effect(*args, **kwargs):
        mocks["ai"].last_extraction_error = error
        return items

    mocks["ai"].extract_from_file.side_effect = side_effect


class TestExtractionRetryOnZeroItems:
    def test_zero_items_then_retry_success_continues_normally(self):
        """初回0件 → retry で1件取れる → 通常 success ルート"""
        m, mocks = _make_manager()
        cb = _cb_mock()
        _setup_passthrough_corrector(mocks)
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )
        # 初回 AI: 0件 + zero_items
        _ai_extract_then_set_error(mocks, [], "zero_items")
        # retry: 正しく抽出
        _ai_retry_then_set_error(
            mocks,
            [
                ReceiptItem(
                    date="2026-04-27",
                    amount=1600,
                    vendor="店",
                    description="x",
                    account="雑費",
                    tax_category="課税仕入10%",
                    confidence=0.9,
                )
            ],
            None,
        )

        result = m._process_file(_file(), cb, set(), "2026-04-27", "2026-04-27T10:00")
        assert result.success == 1
        assert result.manual_entry == 0
        # 抽出 retry が呼ばれた
        mocks["ai"].extract_from_file.assert_called_once()
        # 通常書き込み
        cb.write_cashbook_row.assert_called_once()

    def test_zero_items_retry_also_zero_falls_to_manual(self):
        """初回0件 → retry も0件 → 抽出失敗 manual_entry"""
        m, mocks = _make_manager()
        cb = _cb_mock()
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )
        _ai_extract_then_set_error(mocks, [], "zero_items")
        _ai_retry_then_set_error(mocks, [], "zero_items")

        result = m._process_file(_file(), cb, set(), "2026-04-27", "2026-04-27T10:00")
        assert result.manual_entry == 1
        # ファイル単位 manual_entry → write_manual_entry_row が呼ばれている
        cb.write_manual_entry_row.assert_called_once()
        # ラベルが ※AI抽出要確認 になっている
        called_short_label = cb.write_manual_entry_row.call_args.kwargs.get("short_label")
        assert called_short_label == "※AI抽出要確認"

    def test_parse_error_then_retry_success(self):
        """初回 parse_error → retry で1件 → success"""
        m, mocks = _make_manager()
        cb = _cb_mock()
        _setup_passthrough_corrector(mocks)
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )
        _ai_extract_then_set_error(mocks, [], "parse_error")
        _ai_retry_then_set_error(
            mocks,
            [
                ReceiptItem(
                    amount=1600,
                    description="x",
                    account="雑費",
                    confidence=0.9,
                )
            ],
            None,
        )

        result = m._process_file(_file(), cb, set(), "2026-04-27", "2026-04-27T10:00")
        assert result.success == 1
        mocks["ai"].extract_from_file.assert_called_once()

    def test_extraction_retry_disabled(self):
        """ENABLE_EXTRACTION_RETRY=false → retry を呼ばずに manual_entry"""
        m, mocks = _make_manager(extraction_retry=False)
        cb = _cb_mock()
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="x", engine="vision", confidence=0.9
        )
        _ai_extract_then_set_error(mocks, [], "zero_items")

        result = m._process_file(_file(), cb, set(), "2026-04-27", "2026-04-27T10:00")
        assert result.manual_entry == 1
        mocks["ai"].extract_from_file.assert_not_called()

    def test_primary_success_no_extraction_retry(self):
        """初回成功なら抽出 retry は呼ばれない"""
        m, mocks = _make_manager()
        cb = _cb_mock()
        _setup_passthrough_corrector(mocks)
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.95
        )
        _ai_extract_then_set_error(
            mocks,
            [ReceiptItem(amount=1600, account="雑費", confidence=0.9, description="x")],
            None,
        )

        result = m._process_file(_file(), cb, set(), "2026-04-27", "2026-04-27T10:00")
        assert result.success == 1
        mocks["ai"].extract_from_file.assert_not_called()


class TestExtractionRetryThenAmountRetry:
    def test_extraction_retry_success_then_amount_ok(self):
        """初回0件 → 抽出retryで成功 → amount OK → success
        この経路では amount retry は呼ばれない"""
        m, mocks = _make_manager()
        cb = _cb_mock()
        _setup_passthrough_corrector(mocks)
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="合計 ¥1,600", engine="vision", confidence=0.9
        )
        _ai_extract_then_set_error(mocks, [], "zero_items")

        # 抽出 retry (extract_from_file) で正しい金額
        _ai_retry_then_set_error(
            mocks,
            [
                ReceiptItem(
                    date="2026-04-27",
                    amount=1600,
                    vendor="x",
                    description="y",
                    account="雑費",
                    tax_category="課税仕入10%",
                    confidence=0.9,
                )
            ],
            None,
        )

        result = m._process_file(_file(), cb, set(), "2026-04-27", "2026-04-27T10:00")
        assert result.success == 1
        # extract_from_file は抽出retryで1回だけ（amount retry は不要）
        assert mocks["ai"].extract_from_file.call_count == 1


class TestExtractionMemoFormat:
    def test_primary_only(self):
        memo = ProcessingManager._format_extraction_memo(
            first_error=None,
            first_count=2,
            retry_attempted=False,
            retry_error=None,
            retry_count=0,
            adopted="primary",
        )
        assert "extraction=primary_only:2items" in memo

    def test_retry_used(self):
        memo = ProcessingManager._format_extraction_memo(
            first_error="zero_items",
            first_count=0,
            retry_attempted=True,
            retry_error=None,
            retry_count=1,
            adopted="retry",
        )
        assert "extraction=retry_used" in memo
        assert "zero_items→1items" in memo
        assert "adopted=retry" in memo

    def test_retry_failed(self):
        memo = ProcessingManager._format_extraction_memo(
            first_error="parse_error",
            first_count=0,
            retry_attempted=True,
            retry_error="zero_items",
            retry_count=0,
            adopted="primary",
        )
        assert "extraction=retry_failed" in memo
        assert "parse_error→0items" in memo


class TestExtractionFailureLabel:
    def test_ocr_empty_label(self):
        assert (
            ProcessingManager._extraction_failure_label("ocr_empty", retry_attempted=False)
            == "※OCR/抽出要確認"
        )

    def test_retry_attempted_label(self):
        assert (
            ProcessingManager._extraction_failure_label("zero_items", retry_attempted=True)
            == "※AI抽出要確認"
        )

    def test_default_label(self):
        assert (
            ProcessingManager._extraction_failure_label("api_error", retry_attempted=False)
            == "※抽出失敗要確認"
        )


class TestGeminiLastExtractionError:
    """GeminiExtractor が parse_error / zero_items を区別する"""

    def _ext(self):
        from src.ai.gemini import GeminiExtractor
        from src.config import AiConfig

        ext = GeminiExtractor.__new__(GeminiExtractor)
        ext._config = AiConfig()
        ext._client = MagicMock()
        ext.last_extraction_error = None
        return ext

    def test_parse_error_recorded(self):
        ext = self._ext()
        items = ext._parse_response("not a json", "f.jpg")
        assert items == []
        assert ext.last_extraction_error == "parse_error"

    def test_zero_items_recorded(self):
        ext = self._ext()
        items = ext._parse_response("[]", "f.jpg")
        assert items == []
        assert ext.last_extraction_error == "zero_items"

    def test_success_clears_error(self):
        ext = self._ext()
        items = ext._parse_response('[{"amount":100,"confidence":0.9}]', "f.jpg")
        assert len(items) == 1
        # 個別の項目パースは last_extraction_error を変えないが
        # 配列が空でなければ zero_items にはならない
        assert ext.last_extraction_error != "zero_items"

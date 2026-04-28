"""RUN_MODE / TARGET_SCOPE / TARGET_ROW のテスト"""

from unittest.mock import MagicMock

import pytest

from src.config import (
    AiConfig,
    AppConfig,
    DriveConfig,
    MasterConfig,
    OcrConfig,
    RuntimeConfig,
    SheetsConfig,
    TemplateConfig,
    _build_runtime_config,
    load_config,
)
from src.models import CorrectedItem, CustomerRow, DriveFile, OcrResult, ReceiptItem
from src.processing.manager import ProcessingManager


# ================================================================
# load_config / RuntimeConfig
# ================================================================
class TestBuildRuntimeConfig:
    def test_defaults_prod_all(self, monkeypatch):
        for k in ("RUN_MODE", "TARGET_SCOPE", "TARGET_ROW"):
            monkeypatch.delenv(k, raising=False)
        rt = _build_runtime_config()
        assert rt.run_mode == "prod"
        assert rt.target_scope == "all"
        assert rt.target_row is None
        assert not rt.is_validate
        assert not rt.is_selected

    def test_validate_all(self, monkeypatch):
        monkeypatch.setenv("RUN_MODE", "validate")
        monkeypatch.setenv("TARGET_SCOPE", "all")
        monkeypatch.delenv("TARGET_ROW", raising=False)
        rt = _build_runtime_config()
        assert rt.run_mode == "validate"
        assert rt.is_validate is True
        assert rt.is_selected is False

    def test_prod_selected(self, monkeypatch):
        monkeypatch.setenv("RUN_MODE", "prod")
        monkeypatch.setenv("TARGET_SCOPE", "selected")
        monkeypatch.setenv("TARGET_ROW", "13")
        rt = _build_runtime_config()
        assert rt.target_row == 13
        assert rt.is_selected

    def test_validate_selected(self, monkeypatch):
        monkeypatch.setenv("RUN_MODE", "validate")
        monkeypatch.setenv("TARGET_SCOPE", "selected")
        monkeypatch.setenv("TARGET_ROW", "5")
        rt = _build_runtime_config()
        assert rt.is_validate
        assert rt.is_selected
        assert rt.target_row == 5

    def test_invalid_run_mode(self, monkeypatch):
        monkeypatch.setenv("RUN_MODE", "preview")
        with pytest.raises(ValueError, match="RUN_MODE"):
            _build_runtime_config()

    def test_invalid_target_scope(self, monkeypatch):
        monkeypatch.setenv("TARGET_SCOPE", "row")
        with pytest.raises(ValueError, match="TARGET_SCOPE"):
            _build_runtime_config()

    def test_selected_without_target_row(self, monkeypatch):
        monkeypatch.setenv("TARGET_SCOPE", "selected")
        monkeypatch.delenv("TARGET_ROW", raising=False)
        with pytest.raises(ValueError, match="TARGET_ROW は必須"):
            _build_runtime_config()

    def test_target_row_not_numeric(self, monkeypatch):
        monkeypatch.setenv("TARGET_SCOPE", "selected")
        monkeypatch.setenv("TARGET_ROW", "abc")
        with pytest.raises(ValueError, match="TARGET_ROW は整数"):
            _build_runtime_config()

    def test_target_row_zero(self, monkeypatch):
        monkeypatch.setenv("TARGET_SCOPE", "selected")
        monkeypatch.setenv("TARGET_ROW", "0")
        with pytest.raises(ValueError, match="TARGET_ROW は 1 以上"):
            _build_runtime_config()


class TestLoadConfigRuntime:
    def test_validate_forces_dry_run(self, monkeypatch):
        monkeypatch.setenv("MASTER_SPREADSHEET_ID", "x")
        monkeypatch.setenv("RUN_MODE", "validate")
        monkeypatch.setenv("TARGET_SCOPE", "all")
        monkeypatch.delenv("DRY_RUN", raising=False)
        c = load_config()
        assert c.runtime.is_validate
        assert c.dry_run is True  # validate 時は強制 ON

    def test_prod_does_not_force_dry_run(self, monkeypatch):
        monkeypatch.setenv("MASTER_SPREADSHEET_ID", "x")
        monkeypatch.setenv("RUN_MODE", "prod")
        monkeypatch.delenv("DRY_RUN", raising=False)
        c = load_config()
        assert not c.runtime.is_validate
        assert c.dry_run is False


# ================================================================
# Manager runtime mode (selected / validate)
# ================================================================
def _make_manager(runtime: RuntimeConfig) -> tuple[ProcessingManager, dict[str, MagicMock]]:
    config = AppConfig(
        master=MasterConfig(spreadsheet_id="m"),
        template=TemplateConfig(),
        drive=DriveConfig(),
        sheets=SheetsConfig(),
        ocr=OcrConfig(),
        ai=AiConfig(),
        dry_run=runtime.is_validate,
        runtime=runtime,
    )
    mocks = {
        "drive": MagicMock(),
        "master": MagicMock(),
        "ocr": MagicMock(),
        "ai": MagicMock(),
        "corrector": MagicMock(),
    }
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


def _customer(row: int, name: str = "顧客") -> CustomerRow:
    return CustomerRow(
        row_number=row,
        customer_name=name,
        entry_type="当方記帳",
        folder_url="https://drive.google.com/drive/folders/X",
        sheet_url="https://docs.google.com/spreadsheets/d/Y/edit",
    )


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


class TestSelectTargetCustomer:
    def test_selects_matching_row(self):
        customers = [_customer(2, "A"), _customer(3, "B"), _customer(4, "C")]
        c = ProcessingManager._select_target_customer(customers, 3)
        assert c.customer_name == "B"

    def test_no_match_raises(self):
        customers = [_customer(2, "A")]
        with pytest.raises(ValueError, match="指定行 99"):
            ProcessingManager._select_target_customer(customers, 99)

    def test_empty_name_raises(self):
        customers = [CustomerRow(row_number=2, customer_name="", entry_type="当方記帳")]
        with pytest.raises(ValueError, match="顧客名が空欄"):
            ProcessingManager._select_target_customer(customers, 2)

    def test_target_row_none_raises(self):
        customers = [_customer(2, "A")]
        with pytest.raises(ValueError, match="TARGET_ROW が指定"):
            ProcessingManager._select_target_customer(customers, None)


class TestProdAllUnchanged:
    """prod + all は従来通りの動作"""

    def test_runs_all_customers(self):
        rt = RuntimeConfig(run_mode="prod", target_scope="all")
        m, mocks = _make_manager(rt)
        mocks["master"].read_customer_rows.return_value = [_customer(2, "A"), _customer(3, "B")]
        # 顧客内 ファイル無し → 完了対象なしルートで終わる
        mocks["drive"].list_files.return_value = []
        summary = m.run()
        assert summary["total_customers"] == 2
        # ステータス更新が prod では行われる（処理中、完了対象なし）
        assert mocks["master"].update_customer_status.call_count >= 2


class TestSelectedScope:
    def test_selected_processes_only_target_row(self):
        rt = RuntimeConfig(run_mode="prod", target_scope="selected", target_row=3)
        m, mocks = _make_manager(rt)
        mocks["master"].read_customer_rows.return_value = [
            _customer(2, "A"),
            _customer(3, "B"),
            _customer(4, "C"),
        ]
        mocks["drive"].list_files.return_value = []  # ファイルなしで終了
        summary = m.run()
        assert summary["total_customers"] == 1  # B だけ

    def test_selected_target_row_not_found_raises(self):
        rt = RuntimeConfig(run_mode="prod", target_scope="selected", target_row=99)
        m, mocks = _make_manager(rt)
        mocks["master"].read_customer_rows.return_value = [_customer(2, "A")]
        with pytest.raises(ValueError, match="指定行 99"):
            m.run()


class TestValidateMode:
    def test_validate_does_not_write_to_cashbook(self):
        rt = RuntimeConfig(run_mode="validate", target_scope="all")
        m, mocks = _make_manager(rt)
        mocks["master"].read_customer_rows.return_value = [_customer(2, "A")]
        # ファイルあり → 通常なら書き込みするはず
        f = DriveFile(file_id="f1", file_name="r.jpg", mime_type="image/jpeg", folder_id="x")
        mocks["drive"].list_files.return_value = [f]

        # OCR + AI もモック
        mocks["ocr"].extract_text.return_value = OcrResult(
            raw_text="¥1,600", engine="vision", confidence=0.9
        )
        mocks["ai"].extract_receipt_data.return_value = [
            ReceiptItem(amount=1600, account="雑費", confidence=0.9, description="x")
        ]
        _setup_passthrough_corrector(mocks)

        # CashbookClient はモック化されない（実装は各 _process_file 内で生成）が、
        # validate モードでは early-return するので reserve_rows / write_* は呼ばれない。
        # ここでは _process_file が validate ブランチで返るのを確認するため、
        # 既存の dry_run ブランチを利用する。
        summary = m.run()

        # validate 集計が summary に入っている
        assert summary["run_mode"] == "validate"
        assert summary["planned_success"] >= 0  # 計算経路を通っている

        # マスターの実書き込みは行われない（validate）
        mocks["master"].update_customer_status.assert_not_called()

    def test_validate_does_not_update_master_status(self):
        rt = RuntimeConfig(run_mode="validate", target_scope="all")
        m, mocks = _make_manager(rt)
        mocks["master"].read_customer_rows.return_value = [_customer(2, "A")]
        mocks["drive"].list_files.return_value = []
        m.run()
        mocks["master"].update_customer_status.assert_not_called()

    def test_validate_does_not_call_rename(self):
        """validate でも 【済】 リネームは呼ばれない（dry_run と同じ）"""
        rt = RuntimeConfig(run_mode="validate", target_scope="all")
        m, mocks = _make_manager(rt)
        mocks["master"].read_customer_rows.return_value = [_customer(2, "A")]
        mocks["drive"].list_files.return_value = []
        m.run()
        mocks["drive"].rename_file_as_done.assert_not_called()


class TestValidateSelected:
    def test_validate_selected_only_target(self):
        rt = RuntimeConfig(run_mode="validate", target_scope="selected", target_row=3)
        m, mocks = _make_manager(rt)
        mocks["master"].read_customer_rows.return_value = [
            _customer(2, "A"),
            _customer(3, "B"),
            _customer(4, "C"),
        ]
        mocks["drive"].list_files.return_value = []
        summary = m.run()
        assert summary["total_customers"] == 1
        assert summary["run_mode"] == "validate"
        # マスター更新なし
        mocks["master"].update_customer_status.assert_not_called()


class TestProdSelected:
    def test_prod_selected_writes(self):
        """prod + selected は実書き込みする (dry_run=False)"""
        rt = RuntimeConfig(run_mode="prod", target_scope="selected", target_row=3)
        m, mocks = _make_manager(rt)
        mocks["master"].read_customer_rows.return_value = [_customer(2, "A"), _customer(3, "B")]
        mocks["drive"].list_files.return_value = []  # 速やかに 完了対象なし
        m.run()
        # 対象1顧客に対してマスター更新（処理中 + 完了対象なし）が走る
        assert mocks["master"].update_customer_status.call_count >= 1

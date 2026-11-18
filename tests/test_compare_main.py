"""main() の比較モード分岐（S1・S4）のテスト"""

import os
from unittest.mock import MagicMock

import src.main as main_module
from src.main import main


def _clear_runtime_env(monkeypatch):
    for name in ("RUN_MODE", "TARGET_SCOPE", "TARGET_ROW"):
        monkeypatch.delenv(name, raising=False)
    for name in list(os.environ):
        if name.startswith("COMPARE_"):
            monkeypatch.delenv(name, raising=False)


class TestS1:
    def test_compare_does_not_create_managers(self, monkeypatch):
        _clear_runtime_env(monkeypatch)
        monkeypatch.setenv("RUN_MODE", "compare")
        monkeypatch.delenv("MASTER_SPREADSHEET_ID", raising=False)
        run_compare = MagicMock(return_value=0)
        managers = MagicMock()
        master = MagicMock()
        cashbook = MagicMock()
        monkeypatch.setattr(main_module, "run_compare", run_compare)
        monkeypatch.setattr(main_module, "ProcessingManager", managers)
        monkeypatch.setattr(main_module, "MasterSheetClient", master)
        monkeypatch.setattr("src.sheets.client.CashbookClient", cashbook)

        assert main() == 0
        run_compare.assert_called_once()
        managers.assert_not_called()
        master.assert_not_called()
        cashbook.assert_not_called()

    def test_compare_returns_runner_result(self, monkeypatch):
        _clear_runtime_env(monkeypatch)
        monkeypatch.setenv("RUN_MODE", "compare")
        monkeypatch.setattr(main_module, "run_compare", MagicMock(return_value=1))
        assert main() == 1


class TestS4:
    def _patch_prod(self, monkeypatch):
        managers = MagicMock()
        managers.return_value.run.return_value = {}
        master = MagicMock()
        drive = MagicMock()
        monkeypatch.setattr(main_module, "ProcessingManager", managers)
        monkeypatch.setattr(main_module, "MasterSheetClient", master)
        monkeypatch.setattr(main_module, "DriveClient", drive)
        monkeypatch.setattr(main_module, "create_ocr_engine", MagicMock())
        monkeypatch.setattr(main_module, "create_ai_extractor", MagicMock())
        monkeypatch.setattr(main_module, "RuleCorrector", MagicMock())
        return managers, master, drive

    def test_compare_env_with_value_blocks_prod(self, monkeypatch):
        _clear_runtime_env(monkeypatch)
        monkeypatch.setenv("RUN_MODE", "prod")
        monkeypatch.setenv("MASTER_SPREADSHEET_ID", "MASTER")
        monkeypatch.setenv("COMPARE_FOLDER_IDS", "F" * 12)
        managers, master, drive = self._patch_prod(monkeypatch)
        assert main() == 1
        managers.assert_not_called()
        master.assert_not_called()
        drive.assert_not_called()

    def test_compare_env_with_value_blocks_validate(self, monkeypatch):
        _clear_runtime_env(monkeypatch)
        monkeypatch.setenv("RUN_MODE", "validate")
        monkeypatch.setenv("MASTER_SPREADSHEET_ID", "MASTER")
        monkeypatch.setenv("COMPARE_RESULT_SPREADSHEET_ID", "R" * 24)
        managers, master, drive = self._patch_prod(monkeypatch)
        assert main() == 1
        managers.assert_not_called()
        master.assert_not_called()
        drive.assert_not_called()

    def test_compare_env_with_value_blocks_unset_mode(self, monkeypatch):
        _clear_runtime_env(monkeypatch)
        monkeypatch.setenv("MASTER_SPREADSHEET_ID", "MASTER")
        monkeypatch.setenv("COMPARE_RUN_LABEL", "L1")
        managers, master, drive = self._patch_prod(monkeypatch)
        assert main() == 1
        managers.assert_not_called()
        master.assert_not_called()
        drive.assert_not_called()

    def test_compare_env_with_value_is_checked_before_master_id(self, monkeypatch):
        _clear_runtime_env(monkeypatch)
        monkeypatch.setenv("RUN_MODE", "prod")
        monkeypatch.delenv("MASTER_SPREADSHEET_ID", raising=False)
        monkeypatch.setenv("COMPARE_MODELS", "gemini-test")
        managers, master, drive = self._patch_prod(monkeypatch)
        assert main() == 1
        managers.assert_not_called()

    def test_empty_compare_values_do_not_block(self, monkeypatch):
        _clear_runtime_env(monkeypatch)
        monkeypatch.setenv("RUN_MODE", "prod")
        monkeypatch.setenv("MASTER_SPREADSHEET_ID", "MASTER")
        monkeypatch.setenv("COMPARE_FOLDER_IDS", "")
        monkeypatch.setenv("COMPARE_RESULT_SPREADSHEET_ID", "")
        managers, master, drive = self._patch_prod(monkeypatch)
        assert main() == 0
        managers.assert_called_once()

    def test_whitespace_compare_value_blocks(self, monkeypatch):
        _clear_runtime_env(monkeypatch)
        monkeypatch.setenv("RUN_MODE", "prod")
        monkeypatch.setenv("MASTER_SPREADSHEET_ID", "MASTER")
        monkeypatch.setenv("COMPARE_RUN_LABEL", "   ")
        managers, master, drive = self._patch_prod(monkeypatch)
        assert main() == 1
        managers.assert_not_called()

"""
ProcessingManager のスキップ判定ロジックのテスト
（G列未設定 / D列未設定のケース）
"""

from unittest.mock import MagicMock

from src.config import AppConfig, MasterConfig, TemplateConfig, DriveConfig, SheetsConfig, OcrConfig, AiConfig
from src.models import CustomerRow
from src.processing.manager import ProcessingManager


def _make_manager(customers: list[CustomerRow]) -> tuple[ProcessingManager, MagicMock]:
    """外部呼び出しを全てモックした ProcessingManager を生成"""
    config = AppConfig(
        master=MasterConfig(spreadsheet_id="master"),
        template=TemplateConfig(),
        drive=DriveConfig(),
        sheets=SheetsConfig(),
        ocr=OcrConfig(),
        ai=AiConfig(),
    )
    master = MagicMock()
    master.read_customer_rows.return_value = customers
    manager = ProcessingManager(
        config=config,
        drive=MagicMock(),
        master=master,
        ocr=MagicMock(),
        ai=MagicMock(),
        corrector=MagicMock(),
    )
    return manager, master


class TestCustomerSkipLogic:
    def test_skip_when_entry_type_mismatch(self):
        """記帳区分が対象外ならスキップ"""
        cust = CustomerRow(
            row_number=2, customer_name="A", entry_type="先方記帳",
            folder_url="https://drive.google.com/drive/folders/x",
            sheet_url="https://docs.google.com/spreadsheets/d/y/edit",
        )
        m, master = _make_manager([cust])
        summary = m.run()
        assert summary["skipped_customers"] == 1
        assert summary["processed_customers"] == 0
        # 記帳区分ミスマッチの場合はマスター更新はしない（状態を変えない）
        master.update_customer_status.assert_not_called()

    def test_skip_when_folder_url_empty(self):
        """D列（フォルダURL）が空ならスキップ、F列に「フォルダURL未設定」"""
        cust = CustomerRow(
            row_number=3, customer_name="B", entry_type="当方記帳",
            folder_url="",
            sheet_url="https://docs.google.com/spreadsheets/d/y/edit",
        )
        m, master = _make_manager([cust])
        summary = m.run()
        assert summary["skipped_customers"] == 1
        master.update_customer_status.assert_called_once()
        args = master.update_customer_status.call_args[0]
        assert args[0] == 3  # row_number
        assert "フォルダURL未設定" in args[1]

    def test_skip_when_sheet_url_empty(self):
        """G列（シートURL）が空ならスキップ、F列に「シートURL未設定」
        → 自動作成しないことを確認
        """
        cust = CustomerRow(
            row_number=4, customer_name="C", entry_type="当方記帳",
            folder_url="https://drive.google.com/drive/folders/x",
            sheet_url="",
        )
        m, master = _make_manager([cust])
        summary = m.run()
        assert summary["skipped_customers"] == 1
        assert summary["processed_customers"] == 0

        master.update_customer_status.assert_called_once()
        args = master.update_customer_status.call_args[0]
        assert args[0] == 4
        assert "シートURL未設定" in args[1]

        # 新規作成を行わないことを確認
        master.write_sheet_url.assert_not_called()
        m._drive.list_files.assert_not_called()

    def test_multiple_customers_mixed(self):
        """複数顧客が混在するケース: G列ありだけが処理対象候補になる"""
        customers = [
            CustomerRow(row_number=2, customer_name="A", entry_type="当方記帳",
                        folder_url="https://drive.google.com/drive/folders/x",
                        sheet_url=""),  # G列空 → スキップ
            CustomerRow(row_number=3, customer_name="B", entry_type="先方記帳",
                        folder_url="https://drive.google.com/drive/folders/x",
                        sheet_url="https://docs.google.com/spreadsheets/d/y/edit"),
            # ↑ 記帳区分ミスマッチ → スキップ
        ]
        m, master = _make_manager(customers)
        summary = m.run()
        assert summary["skipped_customers"] == 2
        assert summary["processed_customers"] == 0

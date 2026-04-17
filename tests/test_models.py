"""データモデルのテスト"""

from src.models import (
    ProcessStatus, ReceiptItem, CorrectedItem, DriveFile,
    ProcessRecord, CustomerRow, CustomerResult, extract_id_from_url,
)


class TestExtractIdFromUrl:
    def test_folder_url(self):
        url = "https://drive.google.com/drive/folders/1aBcDeFgHiJkLmNoPq"
        assert extract_id_from_url(url) == "1aBcDeFgHiJkLmNoPq"

    def test_folder_url_with_params(self):
        url = "https://drive.google.com/drive/folders/1aBcDeFg?resourcekey=xxx"
        assert extract_id_from_url(url) == "1aBcDeFg"

    def test_spreadsheet_url(self):
        url = "https://docs.google.com/spreadsheets/d/1xYz_AbCdEf/edit#gid=0"
        assert extract_id_from_url(url) == "1xYz_AbCdEf"

    def test_raw_id(self):
        assert extract_id_from_url("1aBcDeFgHiJkLmNoPqRsTuVwXyZ") == "1aBcDeFgHiJkLmNoPqRsTuVwXyZ"

    def test_empty(self):
        assert extract_id_from_url("") == ""


class TestCustomerRow:
    def test_folder_id(self):
        c = CustomerRow(
            row_number=2, customer_name="テスト",
            folder_url="https://drive.google.com/drive/folders/abc123",
        )
        assert c.folder_id == "abc123"

    def test_spreadsheet_id(self):
        c = CustomerRow(
            row_number=2, customer_name="テスト",
            sheet_url="https://docs.google.com/spreadsheets/d/xyz789/edit",
        )
        assert c.spreadsheet_id == "xyz789"

    def test_has_cashbook(self):
        assert not CustomerRow(row_number=2, customer_name="A", sheet_url="").has_cashbook
        assert CustomerRow(row_number=2, customer_name="A", sheet_url="http://x").has_cashbook

    def test_is_individual(self):
        assert CustomerRow(row_number=2, customer_name="A", category="個人").is_individual
        assert not CustomerRow(row_number=2, customer_name="A", category="法人").is_individual
        assert CustomerRow(row_number=2, customer_name="A", category="").is_individual


class TestProcessStatus:
    def test_all_values(self):
        assert len(ProcessStatus) == 8
        assert ProcessStatus.WRITTEN == "written"


class TestDriveFile:
    def test_drive_link(self):
        f = DriveFile("abc", "t.jpg", "image/jpeg", "fld")
        assert "abc" in f.drive_link


class TestProcessRecord:
    def test_reservation_id(self):
        r = ProcessRecord("f", "n", 0, reservation_id="uuid-1")
        assert r.reservation_id == "uuid-1"


class TestCustomerResult:
    def test_success_only(self):
        r = CustomerResult(success=3)
        assert r.to_status_string() == "完了 / 成功3"
        assert not r.has_issues

    def test_with_manual(self):
        r = CustomerResult(success=2, manual_entry=1)
        s = r.to_status_string()
        assert "要確認" in s
        assert "成功2" in s
        assert "手入力1" in s
        assert r.has_issues

    def test_with_low_confidence(self):
        r = CustomerResult(success=1, low_confidence=2)
        s = r.to_status_string()
        assert "要確認" in s
        assert "低信頼2" in s

    def test_all_error(self):
        r = CustomerResult(errors=3)
        assert "エラー" in r.to_status_string()
        assert "ログ参照" in r.to_status_string()

    def test_mixed_with_error(self):
        r = CustomerResult(success=1, errors=2)
        s = r.to_status_string()
        assert "要確認" in s
        assert "成功1" in s
        assert "エラー2" in s

    def test_no_files(self):
        r = CustomerResult()
        assert r.to_status_string() == "完了（対象なし）"

    def test_all_skipped(self):
        r = CustomerResult(skipped=5)
        assert r.to_status_string() == "完了（対象なし）"

    def test_total_processed(self):
        r = CustomerResult(success=2, low_confidence=1, manual_entry=3)
        assert r.total_processed == 6

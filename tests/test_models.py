"""データモデルのテスト"""

from src.models import ProcessStatus, ReceiptItem, CorrectedItem, DriveFile, ProcessRecord


class TestProcessStatus:
    def test_all_values(self):
        assert ProcessStatus.SUCCESS == "success"
        assert ProcessStatus.ERROR == "error"
        assert ProcessStatus.SKIPPED == "skipped"
        assert ProcessStatus.LOW_CONFIDENCE == "low_confidence"
        assert ProcessStatus.MANUAL_ENTRY == "manual_entry"
        assert ProcessStatus.RESERVED == "reserved"
        assert ProcessStatus.WRITTEN == "written"
        assert ProcessStatus.EXPIRED == "expired"

    def test_written_is_done_but_reserved_is_not(self):
        done = {"success", "low_confidence", "manual_entry", "written"}
        assert ProcessStatus.WRITTEN.value in done
        assert ProcessStatus.RESERVED.value not in done
        assert ProcessStatus.EXPIRED.value not in done


class TestDriveFile:
    def test_drive_link(self):
        f = DriveFile("abc", "t.jpg", "image/jpeg", "fld")
        assert f.drive_link == "https://drive.google.com/file/d/abc/view"


class TestReceiptItem:
    def test_defaults(self):
        i = ReceiptItem()
        assert i.date is None and i.amount is None
        assert i.confidence == 0.0 and i.is_expense is True


class TestCorrectedItem:
    def test_corrections(self):
        c = CorrectedItem(original=ReceiptItem())
        c.corrections_applied.append("test")
        assert len(c.corrections_applied) == 1


class TestProcessRecord:
    def test_reservation_id(self):
        r = ProcessRecord("f", "n", 0, reservation_id="uuid-1",
                          status="reserved", cashbook_row=10)
        assert r.reservation_id == "uuid-1"

    def test_written(self):
        r = ProcessRecord("f", "n", 0, status="written", cashbook_row=10)
        assert r.status == "written"

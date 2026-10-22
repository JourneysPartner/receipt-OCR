"""URL 抽出と顧客データの性質テスト"""

import string
from dataclasses import replace

from hypothesis import given
from hypothesis import strategies as st

from src.models import CustomerResult, CustomerRow, DriveFile, extract_id_from_url

IDENTIFIERS = st.text(
    alphabet=string.ascii_letters + string.digits + "_-", min_size=1, max_size=128
)
WHITESPACE = st.text(alphabet=" \t\r\n\u3000\u00a0", max_size=8)
COUNTS = st.integers(min_value=0, max_value=10**30)
RESULTS = st.builds(
    CustomerResult,
    success=COUNTS,
    low_confidence=COUNTS,
    manual_entry=COUNTS,
    skipped=COUNTS,
    errors=COUNTS,
)


@given(
    identifier=IDENTIFIERS,
    template=st.sampled_from(
        [
            "https://drive.google.com/drive/folders/{}",
            "https://drive.google.com/drive/folders/{}?resourcekey=abc#fragment",
            "https://docs.google.com/spreadsheets/d/{}/edit#gid=0",
            "https://docs.google.com/spreadsheets/d/{}?usp=sharing",
            "{}",
        ]
    ),
    left=WHITESPACE,
    right=WHITESPACE,
)
def test_supported_urls_and_raw_ids_round_trip(identifier, template, left, right):
    """区切り文字を含まない Drive/Sheets ID は、既知の URL 形式と前後の空白を経ても戻る。"""
    assert extract_id_from_url(left + template.format(identifier) + right) == identifier


@given(url=st.text(max_size=512))
def test_id_extraction_is_deterministic_for_arbitrary_text(url):
    """不正な URL を含む任意の文字列でも例外を出さず、決定的な文字列を返す。"""
    identifier = extract_id_from_url(url)
    assert isinstance(identifier, str)
    assert identifier == extract_id_from_url(url)


@given(
    segment=st.text(alphabet=string.ascii_letters + string.digits + "_-?.=#", max_size=128),
    left=WHITESPACE,
    right=WHITESPACE,
)
def test_unrecognized_urls_are_returned_after_stripping(segment, left, right):
    """既知のパス印がない URL は拒否せず、前後の空白を除いた入力をそのまま返す契約である。"""
    url = f"https://invalid.example/{segment}"
    assert extract_id_from_url(left + url + right) == url


@given(folder_id=IDENTIFIERS)
def test_customer_folder_id_round_trips(folder_id):
    """顧客の folder_id は任意の有効な ID をフォルダ URL から復元する。"""
    customer = CustomerRow(
        row_number=1,
        customer_name="テスト",
        folder_url=f"https://drive.google.com/drive/folders/{folder_id}?usp=sharing",
    )
    assert customer.folder_id == folder_id


@given(spreadsheet_id=IDENTIFIERS)
def test_customer_spreadsheet_id_round_trips(spreadsheet_id):
    """顧客の spreadsheet_id は任意の有効な ID をシート URL から復元する。"""
    customer = CustomerRow(
        row_number=1,
        customer_name="テスト",
        sheet_url=f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/edit#gid=0",
    )
    assert customer.spreadsheet_id == spreadsheet_id


@given(sheet_url=st.text(max_size=256), left=WHITESPACE, right=WHITESPACE)
def test_cashbook_presence_depends_on_non_whitespace_text(sheet_url, left, right):
    """出納帳の有無は URL の妥当性ではなく、空白以外の文字があるかで決まる。"""
    customer = CustomerRow(row_number=1, customer_name="テスト", sheet_url=left + sheet_url + right)
    assert customer.has_cashbook == bool(sheet_url.strip())


@given(
    category=st.one_of(st.text(max_size=64), st.sampled_from(["法人", "個人", ""])),
    left=WHITESPACE,
    right=WHITESPACE,
)
def test_only_exact_corporate_category_is_not_individual(category, left, right):
    """種別は前後の空白を無視し、「法人」と一致した場合だけ個人扱いを解除する。"""
    customer = CustomerRow(row_number=1, customer_name="テスト", category=left + category + right)
    assert customer.is_individual == (category.strip() != "法人")


@given(identifier=IDENTIFIERS)
def test_generated_drive_links_round_trip(identifier):
    """DriveFile の生成する /d/ 形式のリンクは同じ ID の抽出に使える。"""
    file = DriveFile(identifier, "receipt.jpg", "image/jpeg", "folder")
    assert extract_id_from_url(file.drive_link) == identifier


@given(result=RESULTS, skipped=COUNTS)
def test_skipped_count_does_not_change_customer_status(result, skipped):
    """スキップ件数は状態表示の明細に含まれず、処理対象なしの場合も同じ表示になる。"""
    assert result.to_status_string() == replace(result, skipped=skipped).to_status_string()


@given(result=RESULTS, errors=COUNTS, skipped=COUNTS)
def test_processed_count_excludes_errors_and_skips(result, errors, skipped):
    """処理済み件数は成功・低信頼・手入力の合計であり、エラーとスキップの変更に依存しない。"""
    changed = replace(result, errors=errors, skipped=skipped)
    assert result.total_processed == result.success + result.low_confidence + result.manual_entry
    assert changed.total_processed == result.total_processed


@given(result=RESULTS)
def test_completed_status_is_equivalent_to_absence_of_issues(result):
    """非負の件数では、低信頼・手入力・エラーがなければ完了、それらがあれば未完了表示になる。"""
    has_issues = any(
        count > 0 for count in (result.low_confidence, result.manual_entry, result.errors)
    )
    assert result.has_issues == has_issues
    assert result.to_status_string().startswith("完了") == (not has_issues)


@given(result=RESULTS)
def test_adding_success_increases_processed_count_and_exposes_its_count(result):
    """成功の追加で処理済み件数は1増え、状態表示に新しい成功件数が現れる。"""
    changed = replace(result, success=result.success + 1)
    assert changed.total_processed == result.total_processed + 1
    assert f"成功{changed.success}" in changed.to_status_string().split(" / ")

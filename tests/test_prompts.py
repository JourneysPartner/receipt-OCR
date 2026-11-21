"""指示文（prompts）のテスト

第 1 版の期待値は、このテストに全文を書き写す（prompts の定数を期待値に使わない）。
"""

import hashlib

import pytest

from src.ai import prompts

# 2026-11-20 の worktree の v1・v2（1 字も変えないことを固定する）
V1_SYSTEM_SHA256 = "d3a259cc2aac057c02ee9ab9caf30b1dd9df2d11ab6a48a2b48d6f1d684c4e07"
V2_SYSTEM_SHA256 = "fc8ba9080b1282aa0aa970cd9ce8c71c00d6ef5b6e8e1b66c0bd1e60420852f9"
V1_TEXT_SHA256 = "e6562358a5e3974fd9acabe6153577e7a37ef52d56fcef4770c49c54a15faa33"
V1_IMAGE_SHA256 = "b7763a4a18a650399d87e5a953eed5da0487b8b20b4c6989f22b778c7c18d517"
V2_TEXT_SHA256 = "d59773a05a94d74e35c722d9440d99e430b16eab7f79b9b8945bae9fcf0f7bf0"
V2_IMAGE_SHA256 = "0e8648cff875ccfab9f85eb272129cd0a0bd7e764e9beff0371e2eb83ec36bc3"

V1_SYSTEM_INSTRUCTION = (
    """\
あなたは日本の経理業務に精通したアシスタントです。
レシートや領収書のOCRテキストから、以下の情報を正確に抽出してJSON配列で返してください。

1枚のレシートに複数明細がある場合は、複数のオブジェクトに分けてください。
ただし、通常のレシート（スーパー、コンビニなど）は合計金額で1明細にまとめてください。

各オブジェクトのフィールド:
- date: 日付 (YYYY-MM-DD 形式。年が不明なら今年と推定)
- amount: 税込金額 (整数、円単位)
- vendor: 取引先名
- description: 摘要（何を買ったか / 何の費用か）
"""
    "- account: 勘定科目候補（消耗品費、旅費交通費、通信費、車両費、雑費、"
    "租税公課、接待交際費、会議費 など）\n"
    """\
- tax_category: 税区分候補（課税仕入10%、課税仕入8%（軽減）、非課税、対象外 など）
- confidence: 抽出の信頼度 (0.0〜1.0)
- is_expense: 支出かどうか (true/false、通常はtrue)
- memo: 補足（OCR品質が低い部分や推測した箇所の説明）

JSON配列のみを返してください。マークダウンのコードブロックや説明文は不要です。
"""
)

V1_TEXT_USER_MESSAGE = (
    "以下はレシート画像「テスト領収書.jpg」のOCRテキストです。\n"
    "情報を抽出してJSON配列で返してください。\n\n"
    "---\n"
    "テスト商店 合計 100円\n"
    "---"
)

V1_IMAGE_USER_MESSAGE = (
    "以下はレシート/領収書「テスト領収書.jpg」の画像またはPDFです。\n"
    "OCR結果は使わず、画像から直接、レシートの情報を読み取って\n"
    "JSON配列で返してください(金額の桁を特に注意して読んでください)。"
)

# 仕様 §4.2 の言葉（表の順）。
DESCRIPTION_TABLE_WORDS = [
    "駐車場代",
    "駐輪場代",
    "電車代",
    "新幹線代",
    "バス代",
    "タクシー代",
    "航空券代",
    "有料道路代",
    "レンタカー代",
    "ガソリン代",
    "洗車代",
    "車検・修理代",
    "宿泊代",
    "御食事代",
    "弁当代",
    "喫茶代",
    "食料品代",
    "飲料代",
    "お茶菓子代",
    "お土産代",
    "手土産代",
    "御祝",
    "御香典",
    "配送料",
    "切手代",
    "郵便代",
    "レターパック代",
    "はがき代",
    "梱包資材代",
    "プリント代",
    "電話料金",
    "携帯電話代",
    "インターネット代",
    "収入印紙代",
    "証明書発行手数料",
    "振込手数料",
    "両替手数料",
    "代引手数料",
    "電気代",
    "ガス代",
    "水道代",
    "灯油代",
    "文房具代",
    "コピー用紙代",
    "インク・トナー代",
    "書籍代",
    "新聞代",
    "名刺代",
    "印鑑代",
    "消耗品代",
    "日用品代",
    "清掃用品代",
    "ゴミ袋代",
    "クリーニング代",
    "鍵の複製代",
    "修理代",
    "電池代",
    "パソコン周辺機器代",
    "工具代",
    "会費",
    "研修・セミナー代",
    "医薬品代",
    "作業服代",
    "仕入",
]


class TestVersion1:
    def test_system_instruction_is_unchanged(self):
        assert prompts.system_instruction("v1") == V1_SYSTEM_INSTRUCTION

    def test_text_user_message_is_unchanged(self):
        assert (
            prompts.text_user_message("v1", "テスト領収書.jpg", "テスト商店 合計 100円")
            == V1_TEXT_USER_MESSAGE
        )

    def test_image_user_message_is_unchanged(self):
        assert prompts.image_user_message("v1", "テスト領収書.jpg") == V1_IMAGE_USER_MESSAGE


class TestVersion2:
    def test_all_description_words_are_present(self):
        text = prompts.system_instruction("v2")
        missing = [w for w in DESCRIPTION_TABLE_WORDS if w not in text]
        assert missing == []

    def test_description_words_have_no_duplicates(self):
        words = [w for w, _applies, _note in prompts.DESCRIPTION_WORDS]
        assert len(words) == len(set(words))
        assert words == DESCRIPTION_TABLE_WORDS

    def test_description_words_are_in_table_order(self):
        text = prompts.system_instruction("v2")
        section = text.split("■ 摘要の言葉\n", 1)[1]
        lines = section.splitlines()
        line_index = [
            next(i for i, line in enumerate(lines) if line.startswith(f"- {w}: "))
            for w in DESCRIPTION_TABLE_WORDS
        ]
        assert line_index == list(range(len(DESCRIPTION_TABLE_WORDS)))

    def test_description_lines_have_the_one_line_format(self):
        text = prompts.system_instruction("v2")
        assert "- 駐車場代: 車・二輪の駐車場（二輪も同じ言葉）（補足: 施設名）" in text
        assert "- バス代: バス\n" in text

    def test_text_user_message(self):
        assert prompts.text_user_message("v2", "テスト領収書.jpg", "テスト商店 合計 100円") == (
            "以下はレシート・領収書「テスト領収書.jpg」の OCR テキストです。"
            "決まりに従って JSON 配列で返してください。\n\n"
            "---\nテスト商店 合計 100円\n---"
        )

    def test_image_user_message(self):
        assert prompts.image_user_message("v2", "テスト領収書.jpg") == (
            "これはレシート・領収書「テスト領収書.jpg」の画像または PDF です。"
            "画像から直接読み取り、決まりに従って JSON 配列で返してください。"
        )

    def test_exception_line_is_present(self):
        text = prompts.system_instruction("v2")
        lines = [line for line in text.splitlines() if line.startswith("- 例外: ")]
        assert len(lines) == 1
        line = lines[0]
        for word in ("収入印紙代", "切手代", "非課税", "課税仕入10%"):
            assert word in line
        # 「並べる順は…」の行の前に置く（仕様 §4.1）
        assert text.index(line) < text.index("- 並べる順は、ページの順")

    def test_tax_category_rule_line(self):
        assert (
            "  - 収入印紙・役所の証明書の発行手数料は「非課税」。御祝・御香典は「対象外」。\n"
            in prompts.system_instruction("v2")
        )

    def test_time_and_receipt_no_fields_are_present(self):
        """仕様 §4: 第 2 版に time と receipt_no の説明がある。"""
        text = prompts.system_instruction("v2")
        assert "- time: 支払い・発行の時刻を HH:MM（24 時間）。" in text
        assert "精算（支払い）の時刻。書いていなければ空。" in text
        assert "- receipt_no: そのレシート 1 枚ごとに変わる番号" in text
        assert (
            "店の登録番号（T＋13 桁）・電話番号・車室番号・レジ番号・担当者番号は入れない。" in text
        )
        # 第 1 版には足さない
        assert "receipt_no" not in prompts.system_instruction("v1")
        assert "- time:" not in prompts.system_instruction("v1")


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


class TestVersion3:
    def test_v1_and_v2_are_byte_identical(self):
        assert _sha256(prompts.SYSTEM_INSTRUCTION_V1) == V1_SYSTEM_SHA256
        assert _sha256(prompts.SYSTEM_INSTRUCTION_V2) == V2_SYSTEM_SHA256
        assert (
            _sha256(prompts.text_user_message("v1", "テスト領収書.jpg", "テスト商店 合計 100円"))
            == V1_TEXT_SHA256
        )
        assert _sha256(prompts.image_user_message("v1", "テスト領収書.jpg")) == V1_IMAGE_SHA256
        assert (
            _sha256(prompts.text_user_message("v2", "テスト領収書.jpg", "テスト商店 合計 100円"))
            == V2_TEXT_SHA256
        )
        assert _sha256(prompts.image_user_message("v2", "テスト領収書.jpg")) == V2_IMAGE_SHA256

    def test_v3_system_is_v2_plus_the_four_fields(self):
        text = prompts.system_instruction("v3")
        assert text == prompts.SYSTEM_INSTRUCTION_V3
        assert text.replace(prompts.CALC_FIELD_LINES, "") == prompts.SYSTEM_INSTRUCTION_V2
        for field in ("- pretax:", "- tax:", "- tendered:", "- change:"):
            assert field in text
        assert "書いていなければ null。" in text
        assert "計算して埋めない。" in text

    def test_v3_user_messages_are_v2(self):
        assert prompts.text_user_message(
            "v3", "テスト領収書.jpg", "テスト商店 合計 100円"
        ) == prompts.text_user_message("v2", "テスト領収書.jpg", "テスト商店 合計 100円")
        assert prompts.image_user_message("v3", "テスト領収書.jpg") == (
            prompts.image_user_message("v2", "テスト領収書.jpg")
        )


class TestUnknownVersion:
    # v3 を足したので、知らない版は v4 で確かめる（仕様 review_precision §6.1）
    def test_system_instruction(self):
        with pytest.raises(ValueError):
            prompts.system_instruction("v4")

    def test_text_user_message(self):
        with pytest.raises(ValueError):
            prompts.text_user_message("v4", "a.jpg", "text")

    def test_image_user_message(self):
        with pytest.raises(ValueError):
            prompts.image_user_message("v4", "a.jpg")

# レシート OCR: 読み取りの質 — 設計 1.0

仕様は `docs/spec_read_quality.md`（以下「仕様」）。ここは、どのファイルのどの関数をどう変えるかを書く。食い違えば仕様が正。

## 1. 全体

```
config.py ── AiConfig.prompt_version / flow（環境変数 AI_PROMPT_VERSION / AI_FLOW）
   │
ai/prompts.py ── 指示文と依頼文（v1 = 今のまま、v2 = 新しい決まり）、摘要の言葉の表
   │
ai/gemini.py ── 版に応じて prompts から取る（呼び方は変えない）
   │
processing/reconcile.py ── 画像からと文字からを照らす純粋な関数（本番と比較で共用）
   │                └ rules/amount_validation.validate_amount、compare/normalize.normalize_date
processing/manager.py ── _process_file が flow で分かれる
   │        text_first → _process_file_text_first（今の中身をそのまま移す）
   │        dual       → _process_file_dual（新しい）
rules/corrections.py ── 決まりを 5 つ足す
   │
compare/ ── 「両読み」の行・明細JSON・1 枚ずつの答え・答えタブの右の列を許す
```

依存の向き: `processing/reconcile.py` は `src.compare.normalize` と `src.rules.amount_validation` と `src.models` だけを読む。`src.compare.pipeline` や `src.processing.manager` は読まない（循環を作らない）。

実装は 3 回に分ける（§9）。各回の終わりで `pytest` と `ruff` が通ること。

## 2. `src/config.py`

- 定数 `PROMPT_VERSIONS = ("v1", "v2")`、`AI_FLOWS = ("text_first", "dual")`。
- `AiConfig` に `prompt_version: str = "v1"`、`flow: str = "text_first"` を足す。
- `_parse_ai_prompt_version(raw)`・`_parse_ai_flow(raw)`: `None` か空白だけなら既定。前後の空白を除き小文字にして、一覧に無ければ `ValueError`（文は仕様 §4・§5 のとおり、末尾に ` (received=<repr>)`）。`_parse_ai_thinking_level` と同じ形。
- `load_config` の `AiConfig(...)` に `prompt_version=_parse_ai_prompt_version(os.environ.get("AI_PROMPT_VERSION"))`、`flow=_parse_ai_flow(os.environ.get("AI_FLOW"))`。
- 比較モードは `replace(self._config.ai, ...)` で `AiConfig` を作るので、`AI_PROMPT_VERSION` はそのまま比較にも効く（`src/compare/runner.py` の `_model_ai_config` は変えない）。

## 3. `src/ai/prompts.py`（新規）と `src/ai/gemini.py`

### 3.1 `prompts.py`

```python
SYSTEM_INSTRUCTION_V1: str          # 今の gemini.SYSTEM_INSTRUCTION を 1 字も変えずに移す
DESCRIPTION_WORDS: tuple[tuple[str, str, str], ...]   # (言葉, 当てはまるもの, 補足)。仕様 §4.2 の表の順
SYSTEM_INSTRUCTION_V2: str          # 仕様 §4.1。末尾の「■ 摘要の言葉」は DESCRIPTION_WORDS から組み立てる

def system_instruction(version: str) -> str
def text_user_message(version: str, file_name: str, ocr_text: str) -> str
def image_user_message(version: str, file_name: str) -> str
```

- 摘要の言葉の 1 行: 補足が「なし」なら `- <言葉>: <当てはまるもの>`、それ以外は `- <言葉>: <当てはまるもの>（補足: <補足>）`。
- `v1` の依頼文は今の 2 つの文字列とバイト単位で同じ（文字から: `以下はレシート画像「…」のOCRテキストです。\n情報を抽出してJSON配列で返してください。\n\n---\n<本文>\n---`、画像から: 今の 3 行）。
- `v2` の文字から: `以下はレシート・領収書「<ファイル名>」の OCR テキストです。決まりに従って JSON 配列で返してください。\n\n---\n<本文>\n---`。
- `v2` の画像から: 仕様 §4 の 1 文。
- 知らない版は `ValueError`（`load_config` で弾くので通常は起きない）。
- 指示文に実在の店名・顧客の名前を書かない（公開リポジトリ）。例は仕様 §4.1 の作り物の名前だけ。

### 3.2 `gemini.py`

- `SYSTEM_INSTRUCTION = SYSTEM_INSTRUCTION_V1` として名前を残す（今の import を壊さない）。
- `_generate_config` の `system_instruction` は `prompts.system_instruction(self._config.prompt_version)`。
- `extract_receipt_data`・`extract_from_file` の `user_msg` は `prompts.text_user_message` / `prompts.image_user_message` から取る。ほか（呼び出し、`last_call_info`、`_parse_response`）は変えない。
- `AiConfig` を偽物で渡すテストがあるので、`getattr(self._config, "prompt_version", "v1")` で読む。

## 4. `src/rules/corrections.py`

`CORRECTION_RULES` の最後に、仕様 §6 の 5 つをその順で足す。今ある「収入印紙→租税公課」の `tax_category` は `"非課税"` に変える（仕様 1.2。今あるテストのうち、この決まりの税区分が `対象外` であることを確かめている所は `非課税` に直す）。`RuleCorrector` の処理は変えない（`re.search` なので `^` は「摘要＋空白＋店名」の先頭＝摘要の先頭に当たる。摘要が空だと `filter(None, …)` で店名が先頭になる点はそのままでよい）。

## 5. `src/processing/reconcile.py`（新規）

```python
LABEL_AMOUNT = "※金額要確認"
LABEL_DATE = "※日付要確認"
LABEL_COUNT = "※明細数要確認"
LABEL_READ = "※読み取り要確認"

@dataclass(frozen=True)
class ItemDecision:
    matched: bool            # True = 合った（自動で書いてよい）
    label: str               # matched のときは ""
    reason: str              # 人が読む短い理由（日本語）
    text_index: int | None   # 組にした T の位置（無ければ None）

def reconcile(image_items, text_items, ocr_text: str) -> list[ItemDecision]
def readings_text(image_items, text_items) -> str
```

`reconcile`（戻り値の長さは必ず `len(image_items)`。例外を投げない）:

1. 鍵 = `(normalize_date(item.date), item.amount)`。日付は `YYYY-MM-DD` の実在する日付（`datetime.date.fromisoformat` で読める）になったものだけ、金額は 1 以上の `int`（`bool` は除く）だけ。それ以外の明細は鍵なし。「金額だけ等しい」を見るときの金額も同じ（1 以上の `int`）。
2. `len(text_items) > len(image_items)` → 全部 `ItemDecision(False, LABEL_COUNT, "文字からは N 件、画像からは M 件", None)`。
3. `text_items` が空 → 全部 `ItemDecision(False, LABEL_READ, "文字からの読みが無い", None)`。
4. それ以外は I を先頭から順に:
   - 鍵があり、T の未使用の中に同じ鍵がある → 最初のものを使用済みにする。`validate_amount(amount, ocr_text).status == "digit_inflation"` なら `(False, LABEL_AMOUNT, "先頭の桁の読み違いの疑い", j)`、そうでなければ `(True, "", "", j)`。
   - 組が無い明細は、全部の I を見終えてから決める（先に全部の組を作る）: T の未使用の中に金額だけ等しいものがあれば `(False, LABEL_DATE, "日付が食い違う", None)`（その T は使用済みにしない）、無ければ `(False, LABEL_AMOUNT, "金額が食い違う", None)`。
5. `ocr_text` が空のときの `validate_amount` は `no_candidates` なので通る（OCR が失敗なら T が空で 3 に入るので、実際には起きない）。

`readings_text`: `画像=<日付>/<金額>, … ｜ 文字=<日付>/<金額>, …`。空の値は `?`、明細が無い側は `なし`。各側は最大 10 件、超えた分は `…ほか N 件`。

## 6. `src/processing/manager.py`

### 6.1 分け方

```python
def _process_file(self, file, cb, processed_keys, today, now) -> CustomerResult:
    if getattr(self._config.ai, "flow", "text_first") == "dual":
        return self._process_file_dual(file, cb, processed_keys, today, now)
    return self._process_file_text_first(file, cb, processed_keys, today, now)
```

`_process_file_text_first` は今の `_process_file` の中身を**そのまま**移す（1 行も変えない。今あるテストは `_process_file` を呼ぶので、そのまま通る）。

### 6.2 `_process_file_dual`

```
1. f"{file.file_id}:-1" in processed_keys → skipped=1 で返す（今と同じ）
2. file.mime_type が gemini._RETRY_SUPPORTED_MIMES に無い → return self._process_file_text_first(...)
   （一覧は gemini.py から公開名 RETRY_SUPPORTED_MIMES として import する。元の名前も残す）
3. ダウンロード。失敗は今と同じ _manual_entry("DL失敗: …")、manual_entry=1
4. ocr = self._ocr.extract_text(file)
   ocr_ok = not ocr.error and bool(ocr.raw_text.strip());  ocr_text = ocr.raw_text if ocr_ok else ""
5. image_items = self._ai.extract_from_file(file)（例外は捕まえて []、ログ step="dual_image_error"）
   image_error = self._ai.last_extraction_error（例外なら "api_error"）
6. text_items = self._ai.extract_receipt_data(ocr, file.file_name) if ocr_ok else []
   （例外は捕まえて []、ログ step="dual_text_error"）。text_error = last_extraction_error（OCR 失敗なら "ocr_failed"）
7. 両方空 → _manual_entry(file, cb, f"AI抽出失敗（両読み）: 画像={image_error or 'none'}, 文字={text_error or 'none'}",
        today, now, short_label="※OCR/抽出要確認" if not ocr_ok else "※AI抽出要確認")、manual_entry=1 で返す
8. image_items が空（T はある）→ items = text_items、
        decisions = [ItemDecision(False, LABEL_READ, "画像からの読みが無い", None)] * len(items)
   それ以外 → items = image_items、decisions = reconcile(image_items, text_items, ocr_text)
9. corrected = [self._corrector.apply(it) for it in items]
   validations = [validate_amount(it.amount, ocr_text) for it in items]（記録用。判断には使わない）
   summary = readings_text(image_items, text_items)
10. dry_run → 書かずに数える: matched で needs_review でない = success、matched で needs_review = low_confidence、
    それ以外 = manual_entry。ログ（step="validate_file"）に summary を入れて返す
11. pending = 未処理の番号（今と同じ式）。skipped も同じ。空なら返す
11a. reread = processed_keys の中に、このファイルの番号 0 以上の印が 1 つでもあるか
     （`f"{file.file_id}:"` で始まり、残りが 0 以上の整数として読める鍵。`:-1` は入れない）。
     reread が真なら、pending の明細の decision を全部
     `ItemDecision(False, LABEL_REREAD, "前の回と明細の数か並びが変わった疑い", None)` に置き換える
     （`LABEL_REREAD = "※再読取要確認"` を reconcile.py に足す）。dry_run の数え方（10）にも同じ置き換えを先に当てる
12. reservations = cb.reserve_rows(count=len(pending), file_id, file_name, receipt_indices=pending)
13. 各 (row, rid), idx:
    matched → self._write_item(file, items[idx], corrected[idx], idx, row, rid, cb, ocr, now, today,
                 validation=validations[idx], extraction_memo=f"両読み=一致 | {summary}")
              戻り値で low_confidence / success を数える。例外は今の「明細失敗」と同じ扱い
              （write_manual_entry_row → MANUAL_ENTRY、だめなら ERROR）
    それ以外 → self._write_dual_review(...)（§6.3）、manual_entry += 1。
              例外は ERROR にして errors += 1（今の金額検証 NG と同じ形）
14. 【済】の付与は今と同じ条件・同じ処理
```

守ること: 5・6 の呼び出しは各 1 回だけ。`extract_from_file` を先に呼ぶ。7 以外で明細を捨てない（`len(reservations) == len(pending)`）。`ocr_ok` が偽でも `ocr`（`OcrResult`）はそのまま `_write_item` などに渡してよい（`engine`・`confidence` を記録するだけ）。

### 6.3 `_write_dual_review`

今の `_write_amount_invalid_as_manual` と同じ並びで書く（`copy_formulas_to_row` → `write_manual_entry_row(row, link, corrected.date or today, error_msg, corrected=corrected, short_label=decision.label)` → `update_reservation_status(WRITTEN)` → `append_ai_log(needs_review=True)` → `update_reservation_status(MANUAL_ENTRY)`）。

- `error_msg = f"両読み要確認（{decision.reason}）: {summary}"`
- AI 詳細ログの `memo` も同じ文。
- 今の `_write_amount_invalid_as_manual`・`_write_item`・`_manual_entry` は変えない。

## 7. 比較（`src/compare/`）

### 7.1 `sheet.py`

- `RESULT_HEADERS` の最後に `"明細JSON"`。
- `MULTI_ANSWER_TITLE = "答え_複数"`、`MULTI_ANSWER_HEADERS = ["fileId", "ファイル名", "番号", "正解_日付", "正解_金額", "正解_税率", "正解_店名", "メモ"]`。
- 「答え」の中身は `read_dicts(title, formatted=True, cells="A:P")` のように範囲を A〜P に限って読む（`read_dicts` に `cells: str | None = None` を足し、`read_values(title, cells, formatted=...)` へ渡す。collect・score の全部の読み出しで）。
- `ensure_tab(title, headers, *, check_headers=True, prefix_only=False)`: `prefix_only=True` のとき、既にある見出しは先頭 `len(headers)` 個だけを比べる（それより右は見ない）。見出しが空のタブに書くのは今までどおり `A1:<headers の最後の列>` だけ。
- 「答え」への書き込みは今までどおり `A:P` と個別のセルだけ（`cell_range` の列は `ANSWER_HEADERS` の位置なので P を超えない）。Q より右を消す・書く呼び出しを足さない。

### 7.2 `runner.py`

- `_verify_headers(titles, checks)`: checks の要素を `(title, headers, prefix_only)` にする。`prefix_only` なら `actual[: len(expected)]` を比べる。
- 「答え」は `prefix_only=True`（`_verify_headers` と `ensure_tab` の両方）。ほかのタブは今までどおり全体。
- 古い形の結果タブ: 実際の見出しが `RESULT_HEADERS[:-1]` と等しいとき、ログは「タブ '<名前>' は古い形です。新しいラベルで collect からやり直してください」（step=`compare_old_format`）で `False`（collect も score も終了コード 1、何も書かない）。
- 「答え_複数」: collect・score とも、見出しの確かめの後（collect は `ensure_tab` の並び、score は答えを読む前）に `ensure_tab(MULTI_ANSWER_TITLE, MULTI_ANSWER_HEADERS)`。既にあれば見出しを確かめるだけ（全体一致。違えば 1）。score でも、無ければ作る。
- `multi_rows = self._sheet.read_dicts(MULTI_ANSWER_TITLE, formatted=True)` を読み、`summary_rows(..., multi_rows=multi_rows)` に渡す。読めなければ「答えを書けません」と同じ扱い（`failed = True`、集計は `multi_rows=[]` で続ける）。
- `_process_file`: `build_current_flow_row` の後に `build_dual_row(...)` の行を足す（同じ条件: 文字から・画像からの両方があるとき）。`settings_text` に `ai_config.prompt_version` を渡す。
- `_file_error_rows`: 両方の方式があるとき `METHOD_DUAL` の行も足す。
- `_done_map`・`_model_done` は変えない（`両読み` は API を呼ばないので、済みの判定に入れない）。

### 7.3 `config.py`・`pipeline.py`

- `METHOD_LABELS` に `"dual": "両読み"`。`pipeline.METHOD_DUAL = "dual"`。
- `settings_text(temperature, thinking_level, max_tokens, prompt_version="v1")`: `v1` なら今の文字列、それ以外は末尾に `, prompt=<版>`。
- `CompareRow` に `items_json: str = ""`。`to_sheet_row` の最後に足す。
- `items_json(items, decisions=None) -> str`: 明細ごとに `{"d": normalize_date(date), "a": amount（None は null）, "t": "・".join(normalize_tax(tax_category)), "v": vendor か "", "s": description か "", "c": account か ""}`。`decisions` があれば `"r": "自動" か "要確認"`。`json.dumps(..., ensure_ascii=False, separators=(",", ":"))`。4 万字を超えたら `""` を返し、呼び出し側が `error_detail` に `明細JSONが長すぎる` を足す。
- `make_result_row`: `items_json(items)` を入れる（明細が無ければ `""`）。
- `build_current_flow_row`: `items_json(corrected, 全部 "自動")`（自動で通った明細だけ。今の `used`）。ほかは変えない。
- `build_dual_row(*, run_label, recorded_at, file, folder_name, model_label, model_name, text_row, image_row, ocr_text, ai_config, settings, ocr_failed=False) -> CompareRow`:
  - I = `image_row.items`、T = `[]` if `ocr_failed` else `text_row.items`。
  - 本番 §6.2 の 7・8 と同じ: 両方空 → 結果 `要確認`、件数 0、金額照合 `読みなし`。I が空で T あり → 明細 = T、全部 `※読み取り要確認`。それ以外 → `reconcile(I, T, "" if ocr_failed else ocr_text)`。
  - `RuleCorrector(confidence_threshold=ai_config.confidence_threshold)` を全部の明細に当て、表の値（日付・合計金額・税率・店名・摘要・勘定科目・信頼度）は `_present(補正後の全部の明細)`。
  - 結果: 全部 matched = `自動`、一部 = `一部要確認`、それ以外 = `要確認`。金額照合の欄: 明細ごとに `一致` かラベルを `・` でつなぐ。
  - `items_json(補正後, decisions)`。応答ms・トークンは文字からと画像からの合計（`_sum_optional`）。再試行も合計。終了理由は画像からの値、無ければ文字から。

### 7.4 `score.py`

入口: `summary_rows(..., multi_rows: list[dict] | None = None)`、`metric_rows(config, result_rows, answer_rows, unusable_models=None, multi_rows=None)`。

```python
METHOD_DUAL_LABEL = "両読み"

def expected_receipts(file_id, answer_by_file, multi_by_file) -> list[dict]
    # multi に行があれば「番号」の順（数として読めなければ行の順）に、1 行 = {日付, 金額, 税率, 店名}（文字列。空は ""）
    # 無ければ「答え」の 1 行を 1 件として返す。「答え」にも行が無ければ []
def read_receipts(row) -> list[dict] | None
    # 明細JSON を読む。使えない行（仕様 §7.4 の「読みとして使う行」以外、JSON が空・壊れている）は None
def _sorted(receipts)      # 金額（空は最後）→ 日付
def _field_ok(row, expected, field) -> bool
    # read が None か件数違いは False。並べ替えて 1 対 1 で value_matches_answer(field, 読み, 答え) が全部真
```

- 欄の正解率: 分母は「`expected` が 1 件以上で、全部のレシートにその欄の答えがある」ファイル。
- 日付と金額: 分母は両方の答えが全部にあるファイル。
- `_auto_counts`（`現行の流れ` と `両読み` の両方。仕様 §7.4 の 1.1 の数え方）:
  - 自動の明細 = `明細JSON` のうち `r` が `自動` のもの。**行の結果は見ない**（`一部要手入力`・`一部要確認` の行も読む。`_usable_for_read` を通さない）。`明細JSON` が空・壊れている行は自動の明細 0 件。
  - 結果が `自動` で、自動の明細の数が答えより少ない → `誤って自動`。
  - 日付か金額の答えが欠けたファイル: 結果が `自動` 以外なら `要手入力` に数え、`自動` ならどれにも数えない（今と同じ）。
  - `誤って自動`: 自動の明細を順に、答えのまだ使っていないレシートのうち日付と金額がともに合う最初のものに当てる。当たらない明細が 1 つでもあれば該当。
  - `正しく自動`: 結果が `自動` で、`誤って自動` でなく、件数が答えと同じ。
  - それ以外は `要手入力`。
- `metric_rows` の方式の並び: 文字から・画像から・現行の流れ・両読み（後ろ 2 つは両方の方式があるとき）。`正しく自動`・`誤って自動`・`要手入力` は後ろ 2 つにだけ入れる。`失敗`・`MAX_TOKENS`・`金額照合NG` は前 2 つだけ（今と同じ）。
- 1〜5 行目の「答えのあるファイル」は今の数え方のまま（「答え」タブの欄）。その下に 1 行足す: `["複数レシートのファイル", <この実行のファイルのうち 答え_複数 に行がある数>]`。表の見出し行の位置が 1 つ下がる。

### 7.5 `answers.py`

変えない（候補・状態・自動の書き込みはファイル単位のまま）。

## 8. テストの置き場所

| ファイル | 中身 |
|---|---|
| `tests/test_prompts.py`（新規） | v1 が今の文字列と等しい（期待値はテストに全文を書く）、v2 に全部の言葉、依頼文、知らない版 |
| `tests/test_config.py`（追記） | `AI_PROMPT_VERSION`・`AI_FLOW` の既定・正しい値・誤った値 |
| `tests/test_compare_gemini.py` か新規 `tests/test_gemini_prompt_version.py` | 版ごとに `system_instruction` と依頼文が切り替わる（偽のクライアント） |
| `tests/test_rules.py`（追記） | 仕様 §6 の 5 つと、今ある決まりが変わらないこと |
| `tests/test_reconcile.py`（新規） | 仕様 §8 の `reconcile` の場合分け、`readings_text` |
| `tests/test_manager_dual.py`（新規） | 仕様 §8 の両読みの `_process_file`。偽物は `tests/test_amount_validation_retry.py` の作りにならう |
| `tests/test_compare_*.py`（追記・必要な直し） | 仕様 §8 の比較の項目 |

今あるテストは、比較の見出し・行の長さ・集計の行の位置を直接確かめている所だけ直してよい（直した所は報告に全部書く）。それ以外の今あるテストを変える必要が出たら、変えずに止めて報告する。

テストの値はすべて作り物にする（実在の店名・顧客の名前・ファイル ID を書かない）。

## 9. 実装の回（go-job）

| 回 | 範囲 | 設計の節 |
|---|---|---|
| 1 | 設定・指示文・補正 | §2・§3・§4 とそのテスト |
| 2 | 両読みの本番の流れ | §5・§6 とそのテスト |
| 3 | 比較の道具と README | §7 とそのテスト。README に `AI_PROMPT_VERSION`・`AI_FLOW`・「答え_複数」・`両読み` を足す |

## 10. 記録

- 1.0（2026-11-19）: 初版。
- 1.2（2026-11-19）: 仕様 1.2（収入印紙は非課税、切手と一緒なら分ける）。§3.1 の第 2 版の指示文は仕様 §4.1 の今の文面に合わせる。§4。
- 1.1（2026-11-19）: 監査の直し（仕様 1.1）。§5 の鍵、§6.2 の 11a、§7.1 の読む範囲、§7.4 の `_auto_counts`。

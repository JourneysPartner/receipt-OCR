# レシート OCR: 読み手の比較（もう 1 人の読み手と「形」）仕様 1.1

対象は直下の `src/`（Python の Cloud Run Job）の比較モード（`RUN_MODE=compare`）。クレカ明細（`クレカ明細自動仕訳/`）には触れない。土台は `docs/spec_model_compare.md`（比較の道具）と `docs/spec_read_quality.md`（両読み・1 枚ずつの答え）。この仕様は、そこに書いてある決まりを変えずに足す。

## 1. 目的

2026-11-20 の利用者の方針: 読み手の組み合わせ方（形）を比べ、「正答率を上げつつ費用の釣り合い」で選ぶ。

今の本番は、同じ型（`gemini-3.5-flash-lite`、考える量 low）が **画像から** と **文字から**（Vision の文字）の 2 回読み、日付と金額が合った明細だけを自動にする（両読み）。テスト記帳で要確認が多かった（25 枚中 7 枚）。食い違ったときにどちらが正しいかはシステムに分からないので、別の読み手を足して確かめる。

比べる形（主の読み手はどれも 3.5-flash-lite の画像から）:

| 形 | 中身 | Vision |
|---|---|---|
| 今（両読み） | 主の画像から × 主の文字から | 使う |
| A2 | 主の画像から × もう 1 人の読み手の画像から | 使わない |
| B | 今のまま。合わない明細があるファイルだけ、もう 1 人の読み手が画像から読み、主の画像からと合えば自動 | 使う |

もう 1 人の読み手の候補: `gemini-3.8-flash`・`claude-haiku-5-5`・`gpt-5.4-mini`。

やり方: 読み手ごとに全部のファイルを 1 回ずつ読ませて表に残し、形の成績（正しく自動・誤って自動・要確認・費用）は **API を呼ばずに後から計算する**。計算のやり方を変えても、読み直しの費用はかからない。

この仕様に入れない:

- A1（Vision を別の OCR に替える）。AWS Textract はアカウントが無い。PaddleOCR・NDLOCR-Lite はイメージの作りが変わる。形の計算（§8）は「相手の読み」を差し替えられる作りにしておき、後で足せるようにする。
- 桁の検査の直し・O 列の書き方・レシートの中の計算での確かめ（別の仕様）。桁の検査を直した後に `score` をやり直せば、形の成績は新しい検査で計算し直される（§8 は本番と同じ `reconcile` を使う）。
- 本番の流れを変えること。形が決まった後の別の仕様にする。

## 2. 作業範囲

- 変える: `src/compare/` の下、`src/ai/gemini.py`（読み取った文を明細にする処理を外へ出すだけ。§6.4）、`src/config.py`（鍵 2 つを読むだけ）、`requirements.txt`、`.github/workflows/deploy.yml`（秘密を 2 つ足すだけ。§10）、`tests/`、`README.md`。
- 新しく作る: `src/ai/parsing.py`、`src/compare/readers.py`、`src/compare/forms.py`、`tests/test_compare_readers.py`、`tests/test_compare_forms.py`。
- 変えない: `src/processing/`・`src/rules/`・`src/sheets/`・`src/drive/`・`src/ocr/`・`src/ai/prompts.py`・`src/ai/factory.py`・`Dockerfile`・`.github/workflows/ci.yml`・`クレカ明細自動仕訳/`。
- テストのデータは架空のものだけ。実際のレシートの値・店名・フォルダ ID・鍵の値を書かない。
- 前提: 重複の実装（ブランチ `go/duplicates`）が main に入った後の main から始める（`src/compare/` と指示文に手が入るため）。

## 3. 安全の条件（変えない。すべてテストで確かめる）

`spec_model_compare.md` §3（S1〜S8）と `spec_read_quality.md` §3（Q1〜Q6）はすべて残す。足すもの:

- **R1 本番は外へ送らない**: `RUN_MODE` が `prod`・`validate` のとき、Anthropic・OpenAI のクライアントを作らない・`anthropic`・`openai` を import しない（import は比較で読み手を作る関数の中だけ）。本番の呼び出しの順・回数・表へ書く値は今と同じ。
- **R2 頼んだ読み手にだけ送る**: 画像を Anthropic・OpenAI へ送るのは、`COMPARE_READERS` にその会社の型が書いてあるときだけ。既定（`COMPARE_READERS` なし）では、比較も今と同じ呼び出しになる。
- **R3 鍵が無ければ始めない**: `COMPARE_READERS` に書いた型の会社の鍵（`ANTHROPIC_API_KEY`・`OPENAI_API_KEY`）が空なら、API も Drive も表も呼ばずに終了コード 1。
- **R4 鍵を出さない**: 3 つの鍵の値をログ・表・例外の文に出さない（S8 を 3 つの鍵に広げる。偽の鍵の文字列で確かめる）。
- **R5 score は外を呼ばない**: `COMPARE_STEP=score` は、型も Drive も呼ばない。読むのと書くのは比較の表だけ。鍵が無くても動く。
- **R6 人の書いたものに触れない**: 形のタブ 2 つ（§8.4）は毎回消して書き直す。それ以外のタブへの書き方は今のまま。「答え」「答え_複数」の決まり（S6・Q5）は変えない。
- **R7 形の計算は本番と同じ関数**: 合ったかどうかは必ず `src/processing/reconcile.py` の `reconcile` で決める（写しを作らない）。
- **R8 式にならない**: 新しく書く値もすべて `valueInputOption=RAW`（S5）。

## 4. 環境変数

| 変数 | 既定 | 内容 |
|---|---|---|
| `COMPARE_READERS` | なし | もう 1 人の読み手。カンマ区切り。要素は `COMPARE_MODELS` と同じ形（`型名` か `型名@考える量`）。**画像からだけ**を読む。`COMPARE_MODELS` と同じ要素を書いたら終了コード 1。重複は 1 つにする |
| `COMPARE_FORM_BASE` | `COMPARE_MODELS` の最初の要素 | 形の計算で主の読み手にする型（表の「型」の文字そのまま。例 `gemini-3.5-flash-lite@low`）。score で `COMPARE_MODELS` を省いたときは、結果タブに `両読み` の行がある型のうち最初のもの |
| `COMPARE_OCR_PRICE_PER_PAGE_USD` | `0.0015` | Vision の 1 ページあたりの費用（§9）。0 以上の数 |
| `COMPARE_READER_MAX_TOKENS` | `8192` | Anthropic・OpenAI の読み手の出力の上限（考える分を含む）。256 以上の整数。Gemini の読み手は今までどおり `AI_MAX_TOKENS` |
| `ANTHROPIC_API_KEY` | なし | `src/config.py` が読み `AppConfig.anthropic_api_key` に入れる（比較だけが使う） |
| `OPENAI_API_KEY` | なし | 同じく `AppConfig.openai_api_key` |

- 会社は型名の頭で決める: `gemini-` → Google、`claude-` → Anthropic、`gpt-` → OpenAI。それ以外は終了コード 1（文は「`COMPARE_READERS の型名は gemini- / claude- / gpt- で始めてください`」）。
- `COMPARE_MODELS` に書けるのは今までどおり Gemini の型だけ。`claude-`・`gpt-` で始まる型を書いたら終了コード 1（文は「`COMPARE_MODELS には Gemini の型だけを書けます。ほかの会社の型は COMPARE_READERS へ`」）。
- 考える量: Gemini の読み手は今の決まり（`@` が無ければ `AI_THINKING_LEVEL`）。Anthropic・OpenAI は `low`・`medium`・`high` だけ（`minimal` は終了コード 1）。`@` が無ければ何も送らない（その型の既定）。`AI_THINKING_LEVEL` は Anthropic・OpenAI には効かない。
- `COMPARE_READERS`・`COMPARE_FORM_BASE`・`COMPARE_OCR_PRICE_PER_PAGE_USD`・`COMPARE_READER_MAX_TOKENS` は名前が `COMPARE_` で始まるので、比較でない実行に値があれば S4 で止まる。

## 5. collect の変更

### 5.1 始める前

- 読み手ごとに型の有無を確かめる（Gemini は今の `models.get`、Anthropic・OpenAI は `client.models.retrieve(型名)`）。「見つからない」ならその読み手を外し、集計に `使えない型` の 1 行。ほかのエラーは外さず警告だけ（今と同じ決まり）。
- クライアントは、`COMPARE_READERS` にその会社の型があるときだけ作る（R2）。

### 5.2 1 本のファイル

`COMPARE_MODELS` の型の処理（文字から・画像から・現行の流れ・両読み）は今のまま。その後に、読み手ごとに **画像から** を 1 回読む。

- 読み手の行は「結果_<ラベル>」に、方式 `画像から` の 1 行（`現行の流れ`・`両読み` の行は作らない）。「型」は `COMPARE_READERS` の要素そのまま。
- やり直し（429・5xx は 10・30・60 秒で最大 3 回）・時間切れ・`失敗:file_error`・続きからの決まりは今と同じ。続きからで「済み」とするのは、読み手は `画像から` の行だけで決める（`_model_done` を型ごとの方式で見る）。
- **OCR を省く**: そのファイルで今回呼ぶのが読み手だけ（`COMPARE_MODELS` の型は全部済み）なら、Vision を呼ばない・「OCR_<ラベル>」に行を足さない。読み手の行の「金額照合」は、その回に OCR の文字があれば今と同じ、無ければ `OCRなし`。
- スレッドの決まりは今と同じ（読み手のクライアントも、スレッドと読み手の組ごとに作る）。

### 5.3 「OCR_<ラベル>」

見出しの最後に `ページ数` を足す（`OcrResult.page_count`。画像は 1）。`ページ数` の無い古いタブ（今までの実行）は、続きからも score も今までどおり通す（形の費用では 1 ページと数え、「注」に書く）。

## 6. 読み手（`src/compare/readers.py`）

Gemini の読み手は今の `GeminiExtractor` をそのまま使う。Anthropic・OpenAI は、同じ `AiExtractor` の形（`extract_from_file`・`last_extraction_error`・`last_call_info`）の小さなクラスを 2 つ作る。`extract_receipt_data`（文字から）は実装しない（呼ばれたら `NotImplementedError`）。

### 6.1 共通

- 指示文は Gemini と同じ: `prompts.system_instruction(版)` と `prompts.image_user_message(版, ファイル名)`（版は `AI_PROMPT_VERSION`）。読み手ごとに文を変えない（比べるため）。
- 使える種類は `image/jpeg`・`image/png`・`image/webp`・`application/pdf`。それ以外は呼ばずに `unsupported_mime`、中身が空なら `empty_content`（Gemini と同じ）。
- 返った文は §6.4 の共通の関数で明細にする。失敗の種類（`parse_error`・`zero_items`・`api_error`）の決め方は Gemini と同じ。
- 文が返らなかったとき（出力の上限・断りなど）: `last_extraction_error="api_error"`、`last_call_info["error"]=None`、`raw_text=None`（今の決まりで `失敗:empty_response` になる）。「終了理由」に理由が残る。
- `last_call_info` の鍵は Gemini と同じ 9 つ（`model`・`latency_ms`・`finish_reason`・`prompt_tokens`・`output_tokens`・`thinking_tokens`・`raw_text`・`error`・`error_code`）。`error_code` は HTTP の状態の整数。**つながらない・時間切れの例外は `error_code=503`** にする（やり直しの対象にするため）。
- SDK の自動のやり直しは切る（`max_retries=0`）。やり直しは比較の道具が数える。待ち時間の上限は `effective_request_timeout`（既定 180 秒）。
- `temperature` は送らない（どちらの型も既定以外を受け付けない）。
- 「設定」の欄: `provider=<anthropic か openai>, effort=<値かなし>, max_tokens=<値>` に、版が `v1` 以外なら `, prompt=<版>`。Gemini の行は今の文字列のまま。

### 6.2 Anthropic（`claude-…`。公式 SDK `anthropic` を使う。2026-11-20 に公式の資料で確認）

- `anthropic.Anthropic(api_key=…, timeout=秒, max_retries=0)`、`client.messages.create(model=型名, max_tokens=COMPARE_READER_MAX_TOKENS, system=指示文, messages=[{"role": "user", "content": [<ファイル>, {"type": "text", "text": 依頼文}]}])`。
- ファイルの渡し方（base64、改行なし。ファイルを先、文を後）:
  - 画像: `{"type": "image", "source": {"type": "base64", "media_type": <MIME>, "data": …}}`
  - PDF: `{"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": …}}`
- 考える量があるときだけ `output_config={"effort": <low・medium・high>}`。`thinking` は送らない（Haiku 5.5 は既定で自分で加減する）。
- 大きさ: 画像は base64 にした後が 10 MB を超えたら、PDF は元の大きさが 32 MB を超えたら、呼ばずに `last_extraction_error="too_large"`（表は `失敗:too_large`。続きからではやり直さない）。画像を縮める処理は入れない（新しい依存を増やさない。何本あったかを見てから決める）。
- 返りの読み方: 文は `response.content` のうち `type == "text"` のものをつなぐ。`finish_reason` ← `response.stop_reason`（`end_turn`・`max_tokens`・`refusal` など）。`prompt_tokens` ← `usage.input_tokens`、`output_tokens` ← `usage.output_tokens`（考える分を含む）、`thinking_tokens` は None。
- 例外は型で分ける: `anthropic.APIStatusError`（`status_code` を `error_code` に）、`anthropic.APIConnectionError`（時間切れを含む。503）。

### 6.3 OpenAI（`gpt-…`。公式 SDK `openai` の Responses API。2026-11-20 に公式の資料で、入力の形・大きさの上限・単価を確認）

- `openai.OpenAI(api_key=…, timeout=秒, max_retries=0)`、`client.responses.create(model=型名, instructions=指示文, input=[{"role": "user", "content": [<ファイル>, {"type": "input_text", "text": 依頼文}]}], max_output_tokens=COMPARE_READER_MAX_TOKENS)`。
- ファイルの渡し方:
  - 画像: `{"type": "input_image", "image_url": "data:<MIME>;base64,…", "detail": "high"}`
  - PDF: `{"type": "input_file", "filename": <ファイル名>, "file_data": "data:application/pdf;base64,…", "detail": "high"}`（PDF は既定のままだと古い型では粗い読みになるので `high` を明示する）
- 考える量があるときだけ `reasoning={"effort": <low・medium・high>}`。
- 大きさ: 元の大きさが 50 MB を超えたら呼ばずに `too_large`。
- 返りの読み方: 文は `response.output_text`。`finish_reason` ← `response.status`、`incomplete` のときは `incomplete:<incomplete_details.reason>`。`prompt_tokens` ← `usage.input_tokens`、`thinking_tokens` ← `usage.output_tokens_details.reasoning_tokens`、`output_tokens` ← `usage.output_tokens` から考える分を引いた値（費用の式が「出力＋考える分」なので、二重に数えないため）。
- 例外: `openai.APIStatusError`（`status_code`）、`openai.APIConnectionError`（時間切れを含む。503）。
- **実装の人へ**: 返りの欄の名前・例外の名前・`detail` と `reasoning` の受け付ける値は、入れた SDK の型の定義で確かめる。ここに書いた名前と違えば SDK に合わせ、違いを報告に書く（推し量って書かない）。

### 6.4 読み取った文を明細にする処理（`src/ai/parsing.py`）

`GeminiExtractor._parse_response` と `_safe_int` の中身を、`parse_receipt_items(raw, file_name) -> (明細の並び, 失敗の種類か None)` として外へ出し、`GeminiExtractor` はそれを呼ぶだけにする。**動きは 1 つも変えない**（コードブロックの外し方、1 件だけの形、欄の読み方、ログの文、`parse_error`・`zero_items` の決め方。今あるテストを変えずに全部通す）。3 つの読み手がこの同じ関数を使う。

### 6.5 依存

`requirements.txt` に `anthropic` と `openai` を足す。版は、実装の時点の PyPI の最新の安定版を調べ、その主番号の範囲で留める（今の書き方 `>=x.y,<次の主番号` に合わせる）。入れた版を報告に書く。ほかの依存は足さない。イメージは本番と同じなので本番にも入るが、R1 のとおり本番では import しない。

## 7. 単価（`DEFAULT_PRICES` に足す。100 万トークンあたり USD）

| 型 | 入力 | 出力 | 確かめた日と注 |
|---|---|---|---|
| `claude-haiku-5-5` | 0.10 | 0.50 | 2026-11-17・11-20 公式。入力 10 万トークンまでの単価（レシート 1 枚は数千） |
| `gpt-5.4-mini` | 0.75 | 4.50 | 2026-11-20 公式の料金表（標準） |

費用の式は今のまま（入力 × 入力単価 ＋（出力＋考える分）× 出力単価）。`COMPARE_PRICES_JSON` で上書きできる。

## 8. 形の計算（`src/compare/forms.py`。API もファイルも触らない純粋な関数）

collect の終わりと score で、集計（今のまま）の後に行う。

### 8.1 材料（「結果_<ラベル>」と「OCR_<ラベル>」。同じ鍵の行が複数あれば下の行）

ファイルごとに:

- Ib = 主の読み手（`COMPARE_FORM_BASE`）の `画像から` の `明細JSON`。Tb = 主の `文字から` の `明細JSON`。`成功` でない行は空の並び。
- Ix = 読み手 X の `画像から` の `明細JSON`（`成功` でなければ空）。X は、結果タブに `画像から` の行があり `両読み` の行が無い型（＝`COMPARE_READERS` で読んだ型）の全部。並びは結果タブに初めて出た順。
- OCR の文字 = 「OCR_<ラベル>」の `OCR文字`、ページ数 = `ページ数`（無ければ 1）。
- `reconcile` に渡す明細は、`明細JSON` の `d`（日付）と `a`（金額）から作る（`date`・`amount` を持つ小さな入れ物。ほかの欄は使わない）。
- 主の `画像から` か `文字から` の行が無いファイルは、どの形にも入れない。X の行が無いファイルは、X の形（A2・B）に入れない。入れなかった本数は「注」に書く。

### 8.2 明細ごとの判定

D0 = `reconcile(Ib, Tb, OCR の文字)`。

- **今（両読み）**: 明細 i は D0[i] が合えば自動。
- **A2（X）**: D = `reconcile(Ib, Ix, "")`。明細 i は D[i] が合えば自動。Vision を使わない形なので OCR の文字は渡さない（桁の検査は効かない）。
- **B（X）**: Ib が空でなく、D0 に合わない明細が 1 つでもあるファイルだけ X を「呼ぶ」。呼ぶファイルは Dx = `reconcile(Ib, Ix, OCR の文字)` とし、明細 i は D0[i] か Dx[i] のどちらかが合えば自動。呼ばないファイルは今（両読み）と同じ。

どの形も、表に入る値は主の画像からの読み（Ib）。Ib が空のファイルは、明細 0・自動 0 の「要確認」。

`reconcile` の決まりがそのまま効く: 相手の件数が Ib より多ければ全部要確認、桁の検査に掛かった組は要確認。B では、主の文字からが 1 枚多く読んだファイルも、X が主の画像からと件数も値も合えば自動になる（画像の読み手 2 人が同じ 1 枚を見落とすと誤って自動になる。§8.3 の数で確かめる）。

### 8.3 ファイルごとの成績

答えは `spec_read_quality.md` §7.2（「答え_複数」があればその並び、無ければ「答え」の 1 枚）。数え方は同 §7.4 の `両読み` と同じ関数を使う。

- `誤って自動`: 自動の明細の中に、答えのどのレシートとも日付・金額が合わないものがある。または、全部が自動なのに明細の数が答えより少ない。
- `正しく自動`: 明細が 1 つ以上あり全部が自動で、数が答えと同じで、全部の日付と金額が合う。
- `要確認`: それ以外。
- 3 つは重ならない。日付と金額の答えが全部のレシートにそろっていないファイルは、成績に入れない（費用と本数には入れ、「注」に本数を書く）。

確かめ: 計算した「今（両読み）」の明細ごとの自動・要確認が、結果タブの `両読み` の行の `明細JSON` の `r` と違うファイルの数を「注」に書く（`reconcile` を直した後の score では違ってよい。直していないのに違えば道具の誤り）。

### 8.4 タブ（どちらも毎回消して書き直す。RAW）

**「形_<ラベル>」**（1 行 = 1 つの形）。1〜3 行目: `実行ラベル` / `集計時刻` / `主の読み手`。1 行空けて表:

`形` / `もう1人の読み手` / `ファイル数` / `正しく自動` / `誤って自動` / `要確認` / `明細の数` / `自動の明細` / `要確認の明細` / `もう1人を呼んだ本数` / `推定費用USD` / `1本あたりUSD` / `注`

- 並び: `今（両読み）`、続いて X ごとに `A2`・`B`。
- `正しく自動`・`誤って自動`・`要確認` は `n/m (xx.x%)`（m は成績に入れたファイルの数。0 なら `-`）。`自動の明細`・`要確認の明細` は `n/m (xx.x%)`（m は `明細の数`）。
- `もう1人を呼んだ本数`: 今＝空、A2＝ファイル数、B＝呼んだファイルの数。

**「形の明細_<ラベル>」**（1 行 = 1 ファイル × 1 つの形。誤って自動・要確認の中身を人が見るため）:

`fileId` / `ファイル` / `ファイル名` / `形` / `もう1人の読み手` / `成績` / `明細の数` / `自動の明細` / `判定` / `読み` / `答え` / `呼んだ`

- `判定`: 明細ごとの `一致` か `※…`（`reconcile` のラベル。B は、D0 が合わず Dx が合った明細を `一致（もう1人）`）を `・` でつなぐ。
- `読み`: `主画像=<日付>/<金額>, … ｜ 主文字=… ｜ もう1人=…`（各 10 件まで。形に関係の無い側は書かない）。`答え`: `<日付>/<金額>, …`。`成績`: `正しく自動`・`誤って自動`・`要確認`・`答えなし`。`呼んだ`: `はい`・`いいえ`・空（今）。

主の読み手の行が結果タブに無い・読み手 X が 1 つも無いときは、形のタブは「今（両読み）」だけ（主も無ければ作らない）。ログに理由を出し、終了コードは 0。

## 9. 形の費用（1 ファイルごとに足し、合計と 1 本あたりを出す）

| 形 | 費用 |
|---|---|
| 今（両読み） | 主の画像から ＋ 主の文字から ＋ ページ数 × `COMPARE_OCR_PRICE_PER_PAGE_USD` |
| A2（X） | 主の画像から ＋ X の画像から |
| B（X） | 今（両読み）の費用 ＋ 呼んだファイルだけ X の画像から |

- 読み手の費用は結果タブの `推定費用USD`（空・`単価未設定` は 0 と数え、「注」に `費用の無い行 n` と書く）。
- 今までの集計の「1本あたりUSD」には Vision の料金が入っていない（トークンの分だけ）。形のタブで初めて足す。集計タブの数え方は変えない。
- Vision の単価の既定 0.0015（1,000 ページ 1.50 ドル。月 1,000 ページまでの無料分は入れない）は、**全部を流す前に公式の料金表で確かめる**（§12 の 3）。違えば環境変数で渡し、§13 に書く。

## 10. 鍵と deploy（高リスク。順を守る）

鍵は Gemini と同じく Secret Manager に置き、ジョブの環境変数として渡す。`deploy.yml` の `--set-secrets` を次の 1 行に変える:

`--set-secrets="GEMINI_API_KEY=gemini-api-key:latest,ANTHROPIC_API_KEY=anthropic-api-key:latest,OPENAI_API_KEY=openai-api-key:latest"`

- **push の前に**、利用者が Secret Manager に `anthropic-api-key`・`openai-api-key` を作り（値は利用者が貼る。会話・リポジトリ・依頼書に書かない）、ジョブのサービスアカウントが読めることを司令役が画面で確かめる。秘密が無い・読めないまま push すると、ジョブの更新が失敗するか、**本番の実行も始まらなくなる**。
- push の後、司令役がジョブの YAML で 3 つの秘密の参照を確かめ、比較の試し（§12 の 4）で実行が始まることを確かめる。本番の記帳はその後。
- 戻し方: このコミットを戻して push（参照が 1 つに戻る）。
- 鍵はジョブのどの実行にも環境変数として入るが、本番は読まない・使わない（R1）。

## 11. テスト（pytest。ネットワークを使わない。API はすべて偽物）

今あるテストは変えずに全部通す。足すもの:

- R1: `prod`・`validate` で `main()` を動かしても `anthropic`・`openai` が import されない（`sys.modules` で確かめる）・クライアントが作られない。`GeminiExtractor` の呼び出しが今と同じ。
- R2: `COMPARE_READERS` なしの比較は、作るクライアントと呼び出しが今と同じ。`claude-` だけ書いたとき OpenAI のクライアントは作らない（逆も）。
- R3: 鍵が空なら終了コード 1 で、Drive・表・型を 1 回も呼ばない（会社ごと）。
- R4: 偽の鍵 3 つの文字列がログ・表・例外の文に出ない（失敗した呼び出しを含む）。
- R5: score は鍵なしで動き、型・Drive を呼ばない。
- R6・R8: 形のタブは RAW で書かれ、書き直しても「答え」「答え_複数」「結果」「OCR」の中身は変わらない。
- R7: `forms.py` が `reconcile` を呼ぶ（差し替えた偽の `reconcile` の戻りで結果が決まる）。
- 環境変数: 会社の決め方、`COMPARE_MODELS` に他社の型、同じ要素が両方にある、`minimal` を他社に、`COMPARE_FORM_BASE` の既定と score での決め方、単価・上限の誤った値。
- 読み手（偽の SDK）: 画像と PDF の渡し方（§6.2・§6.3 の形そのまま）、考える量のあり・なし、`temperature` を送らない、大きすぎるファイルは呼ばない、文が無い返り（上限・断り）は `失敗:empty_response` になり終了理由が残る、トークンの写し方（OpenAI は考える分を引く）、429 でやり直し・400 はやり直さない・つながらないときは 503 としてやり直す、`max_retries=0`。
- `parse_receipt_items`: 今の `_parse_response` のテストがそのまま通る。3 つの読み手が同じ関数を使う。
- collect: 読み手の行は `画像から` だけ・`両読み` の行を作らない。続きから（読み手だけ残ったファイルは OCR を呼ばない・OCR の行を足さない、済んだ読み手は呼ばない）。使えない型。時間切れ。`ページ数` の列。古い「OCR」タブ（`ページ数` なし）でも止まらない。
- 形: 今／A2／B のそれぞれで、全部合う・金額違い・日付違い・相手が空・相手の件数が多い・主が空・桁の検査に掛かる組（A2 では掛からない）・同じ日付と金額が複数。B は合わないファイルだけ「呼ぶ」・呼ばないファイルの費用に X が入らない。成績の 3 つが重ならない・答えの無いファイルの扱い・1 枚ずつの答え。X の行が無いファイルを除いて「注」に書く。保存された `両読み` との違いの数。費用の 3 つの式と Vision のページ数。Hypothesis: どんな読みの組でも、B の自動の明細は今（両読み）の自動の明細を含む・戻りの長さは Ib の長さ。

確かめるコマンド: `pytest -v`、`ruff check src/ tests/`、`ruff format --check src/ tests/`。

## 12. 入れた後の手順（司令役と利用者）

1. 実装（go-job、worktree）→ 司令役が差分を読む → Opus xhigh の監査（鍵・外への送信・deploy を含むので高リスクの扱い）。
2. 利用者が Secret Manager に鍵を 2 つ置く → 司令役が読めることを確かめる → 利用者の了解で main へ ff・push（§10）。
3. 司令役が Vision の料金表を公式で確かめる。Anthropic・OpenAI の残高は利用者が確かめる。
4. 試し: 新しいラベル・`COMPARE_MAX_FILES=4`・`COMPARE_MODELS=gemini-3.5-flash-lite@low`・`COMPARE_READERS=gemini-3.8-flash,claude-haiku-5-5,gpt-5.4-mini`・`AI_PROMPT_VERSION` は既定（v2）。見るもの: 移した後のフォルダをサービスアカウントが読めるか、3 つの読み手の行、終了理由、費用、`失敗:too_large` の有無、形のタブ。
5. 利用者の了解で全部（156 本。同じ並びで、ラベルは新しいもの）。時間切れなら同じラベルで続き。
6. 司令役が「形の明細」の `誤って自動` と `要確認` を画像で確かめ、結果を利用者に出す（形ごとの 正しく自動・誤って自動・要確認・1 本あたりの費用）。利用者が形を決める。
7. 決めた形を本番に入れるのは別の仕様。

前提（利用者が 11-20 に進めた）: テスト用のレシートの画像を Anthropic と OpenAI の API へ送る。どちらも API のデータは学習に使わない（11-20 の調査。日本のリージョンに留めることは確かめられていない）。

## 13. 記録

- 利用者の了解（2026-11-20）: 鍵は Secret Manager に置き deploy の設定に足す（§10 の順で）／`anthropic`・`openai` を依存に足す／156 本は新しいラベルで主の読み手も含めて読み直す／テスト用のレシートの画像を Anthropic と OpenAI へ送る。
- 1.0（2026-11-20）: 初版。公式で確かめたもの（11-20）: Anthropic の画像の上限（base64 で 10 MB・8000×8000 px）と対応形式、PDF の渡し方、Haiku 5.5 の単価と考える量の渡し方／OpenAI の `gpt-5.4-mini` の単価、Responses API の画像と PDF の渡し方、ファイル 50 MB。確かめていないもの: Vision の単価（§9）、OpenAI の返りの欄と例外の名前（§6.3 の「実装の人へ」）。
- 1.1（2026-11-21）: 実装（ブランチ `go/reader-compare` の `b8a8a0d`）の監査（Opus xhigh。重大 0・高 0・中 4・低 11）を受けて §14 を足した。

## 14. 監査の直し（1.1）

### 14.1 読み手の失敗はその読み手だけに留める（中）

- 読み手（Anthropic・OpenAI）の `extract_from_file` は例外を外へ出さない。返った文を明細にする所で例外が出たら（JSON が `["a"]`・`null`・数だけ、など）、Gemini と同じく `last_extraction_error="api_error"` にし、`last_call_info` の `error` に伏せた文を入れる（`error_code` は None＝やり直さない）。
- collect の 1 本のファイルの中で、読み手ごとの処理（読み手を作る所を含む）を 1 つずつ囲む。例外が出たら、**その読み手の行だけ**を `失敗:file_error` にし、それまでにできた `COMPARE_MODELS` の型の行・OCR の行・ほかの読み手の行はそのまま残す。
- `失敗:file_error` の読み手は、続きからで今までどおりやり直す。

### 14.2 形のタブを書けなかったら終了コード 1（中）

- 形の計算か、形のタブ 2 つの書き込みが失敗したら、ログに例外の型と**鍵を伏せた文**を出し、その実行（collect・score）の終了コードを 1 にする。ほかのタブ（結果・OCR・答え・集計）の書き込みは今までどおり済ませる。「主の読み手の行が無いので作らない」は失敗ではない（終了コード 0 のまま）。
- 2 つのタブの行を両方作ってから書く（計算の失敗で片方だけ新しくなることを避ける）。
- 書く行の数がタブの行の数を超えるときは、書く前に行を足す（今ある列を足す処理と同じ考え方。156 本 × 7 つの形で 1,000 行を超える）。

### 14.3 テストを足す（中）

- R4: 偽の鍵 3 つ（Gemini・Anthropic・OpenAI）が、OpenAI の読み手の失敗・`失敗:file_error` の行の「エラー詳細」・collect と `run_compare` の異常終了のログに出ない。
- R2: `gpt-` だけ書いたとき Anthropic のクライアントを作らない（逆向き）。
- R1: 別のプロセスで `src.main` を import しても `anthropic`・`openai` が `sys.modules` に無い（`subprocess` で `python -c`。本物の SDK が入っている環境でも効く確かめ）。
- 読み手の時間切れ（時間の予算を超えたら残りの読み手を呼ばない・呼ばなかった読み手は続きからで読む）。
- 本物の SDK が import できる環境でだけ動くテスト（無ければ skip）: `inspect.signature` で `Anthropic(...)`・`messages.create`・`OpenAI(...)`・`responses.create` が、この仕様で渡すキーワードを受け付けること、`APITimeoutError` が `APIConnectionError` の子であること。
- §14.1・§14.2・§14.4 の直しのそれぞれ。

### 14.4 小さな直し（低）

- 形 B の「判定」: `一致（もう1人）` と書くのは、D0 が合わず Dx が合った明細だけ（D0 で合っていた明細は `一致` のまま）。
- 成績（§8.3）: `forms.py` の写しをやめ、`score.py` の両読みの数え方と同じ関数（`_assign_auto` など。名前は外から使える形に直してよい）を呼ぶ。`答えなし` の除外だけを `forms.py` に残す。
- 保存された `両読み` と比べられなかったファイル（明細の数が違う・`明細JSON` が空）は、「両読みの保存と比べられないファイル n」として「注」に別に書く。
- OCR の行が無いファイル（Vision を呼んでいない）は、Vision の費用を 0 ページで数え、「注」に「OCR の行が無いファイル n」と書く。「ページ数の無い古い OCR タブ」とは分ける。
- やり直す状態に 529（Anthropic の混雑）を足す。
- `COMPARE_STEP=score` では、`COMPARE_READERS` と `COMPARE_MODELS` の同じ要素の検査をしない（score は読み手を呼ばない。`COMPARE_MODELS` を省くと既定の型と当たって止まるため）。
- `parse_receipt_items` の `read_calc_fields` の既定を偽にする（v3 のときだけ呼ぶ側が真を渡す）。
- `COMPARE_OCR_PRICE_PER_PAGE_USD` は `nan`・`inf` を受け付けない（終了コード 1）。`COMPARE_READERS` の考える量は `COMPARE_MODELS` と同じく大文字でも受ける。
- 鍵の一部を伏せた形（`sk-` で始まり `*` や `…` を含む並び）が例外の文にあっても、「エラー詳細」とログへ出す前に `***` に置き換える（OpenAI の 401 の文に、鍵の頭と末尾が入るため）。

### 14.5 記録だけ（直さない）

- collect の集計タブには読み手の行が出ない（`使えない型` を除く）。score で `COMPARE_MODELS` を省くと、結果タブから型を拾うので読み手の `画像から` の正答率も出る＝読み手ごとの正答率を見たいときはこのやり方で。
- `AppConfig` の repr に鍵 3 つが出る（Gemini の鍵は前から。今はどこもログに出していない）。本番の設定のファイルなので、この仕様では触らない。
- 50 MB に近い PDF を OpenAI へ送ると、1 つのスレッドで約 300 MB を使う（メモリ 512 MB）。レシートでは起きにくい。
- `CorrectedItem` の 4 欄は使っていない（`items_json` は補正前の明細から読む）。害はないので残す。

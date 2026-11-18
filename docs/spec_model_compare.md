# レシート OCR: 型の比較（`RUN_MODE=compare`）仕様 1.0

2026-11-18。利用者の決定: 比較は Cloud Run の本番ジョブで動かす。答えは「型どうしで値が食い違ったものだけ人が確かめる」。

## 1. 目的

- 2026-12-01 に `gemini-2.5-flash` は `gemini-3.5-flash-lite` へ自動で回される（Google 公式の廃止表、11-18 に確認）。その前に、答えの分かったレシートで型を比べ、本番の型を明示で固定する。
- 比べるのは 2 つの読み方。
  - **文字から**: Vision の文字を型に渡す（今の本番の主の流れ。`GeminiExtractor.extract_receipt_data`）
  - **画像から**: 型が画像・PDF を直接読む（今の本番の再抽出。`GeminiExtractor.extract_from_file`。改良 ① の主の流れの候補）
- さらに、上の 2 つの結果から **現行の流れ**（本番が実際に記帳する値。文字から → 金額の照合 → 必要なら画像から）を API を追加で呼ばずに組み立てて比べる。
- 結果はスプレッドシートに書く。型どうしで食い違った欄だけを人が確かめ、確かめた答えで正解率を出す。

## 2. 作業範囲

- 変えてよい: `src/compare/`（新規）、`src/main.py`、`src/config.py`、`src/ai/gemini.py`、`src/drive/client.py`、`tests/`（新規の `tests/test_compare_*.py`。既存テストは、仕様の変更に合わせる最小の直しだけ）。
- 変えない: `src/processing/`、`src/sheets/`、`src/rules/`、`src/ocr/`、`src/models.py`、`Dockerfile`、`.github/`、`requirements*.txt`（新しい依存は入れない）、`README.md`（司令役が書く）。
- テストのデータは架空のものだけ。実際のレシートの値・店名・フォルダ ID を書かない。

## 3. 安全の条件（変えない。すべてテストで確かめる）

- **S1** `RUN_MODE=compare` のときは `ProcessingManager`・`MasterSheetClient`・`CashbookClient` を作らない。マスターと出納帳を読まない・書かない。
- **S2** 比較の Drive は読取り専用のスコープ `https://www.googleapis.com/auth/drive.readonly` で作る。`rename_file_as_done`・`files().update`・作成・削除を呼ばない。読取り専用で作った `DriveClient` の `rename_file_as_done` は、API を呼ばずに `RuntimeError` を投げる。
- **S3** 書くのは `COMPARE_RESULT_SPREADSHEET_ID` の表だけ。`MASTER_SPREADSHEET_ID` に値があり、比較の表の ID と同じなら、何も読まず・書かずに終了コード 1。
- **S4** `RUN_MODE` が `compare` 以外なのに、名前が `COMPARE_` で始まる環境変数が 1 つでも空でない値を持っていたら、何も作らず終了コード 1（比較のつもりで本番を動かす事故を防ぐ）。この確かめは `load_config()` の直後、`MASTER_SPREADSHEET_ID` の確かめより前に行う。
- **S5** 表へ書く値はすべて `valueInputOption=RAW`。型の出力が `=` や `+` で始まっても式にならない。
- **S6** 「答え」タブの「正解_日付」「正解_金額」「正解_税率」「正解_店名」「答えの出どころ」は、**空のセルにだけ**書く。値の入ったセルは上書きしない。「メモ」には書かない。
- **S7** 本番（`prod`）と検証（`validate`）の動きは変えない。新しい設定の既定値は、今と同じ呼び出しになる値にする（`temperature=0.1` を送る、考える量は指定しない、待ち時間の上限は指定しない）。既存テストはすべて通る。
- **S8** API キーの値をログ・表に出さない。

## 4. 起動と環境変数

`RUN_MODE=compare` を `_build_runtime_config` の許す値に加え、`RuntimeConfig.is_compare` を足す。誤った値のときのエラー文は「`RUN_MODE は 'prod' / 'validate' / 'compare' のいずれか`」にする。`TARGET_SCOPE`・`TARGET_ROW` は比較では使わない（値があっても無視する）。

`main()` の順:

1. `load_config()`（失敗なら今どおり終了コード 1）
2. S4 の確かめ
3. `is_compare` なら `src.compare.runner.run_compare(config)` を呼び、その戻り値（0 か 1）で終わる。`MASTER_SPREADSHEET_ID` が空でも止めない。
4. それ以外は今のまま。

比較の設定は `src/compare/config.py` の `load_compare_config(env)` が読み、誤りは API を呼ぶ前にログに出して終了コード 1。

| 変数 | 既定 | 内容 |
|---|---|---|
| `COMPARE_STEP` | `collect` | `collect` = 読み取って結果・答え・集計を書く。`score` = 型は呼ばず、答えを読み直して「答え」の状態と集計だけ書き直す |
| `COMPARE_RESULT_SPREADSHEET_ID` | 必須 | 結果を書く表の ID か URL（`extract_id_from_url` で ID にする）。ID は `^[A-Za-z0-9_-]{20,}$` |
| `COMPARE_FOLDER_IDS` | `collect` で必須 | Drive フォルダの ID か URL をカンマ区切り。下のフォルダも辿る（`DriveClient.list_files` をそのまま使う）。ID は `^[A-Za-z0-9_-]{10,}$` |
| `COMPARE_MODELS` | `gemini-2.5-flash,gemini-3.5-flash-lite,gemini-3.8-flash` | カンマ区切り。各要素は `型名` か `型名@考える量`（考える量は `minimal`・`low`・`medium`・`high`）。型名は `^[a-z0-9][a-z0-9.\-]*$`。表の「型」には要素をそのまま書く（例 `gemini-3.8-flash@low`）。同じ要素の重複は 1 つにする |
| `COMPARE_METHODS` | `text,image` | `text` と `image` の一方か両方。「現行の流れ」は両方のときだけ作る |
| `COMPARE_RUN_LABEL` | 日本時間の `YYYYMMDD-HHMM` | タブ名に使う。`^[A-Za-z0-9_-]{1,40}$`。`collect` で既にある結果タブのラベルを渡すと続きから（§5.4）。`score` で省くと、名前が「結果_」で始まるタブのうち名前が最も大きいもの |
| `COMPARE_MAX_FILES` | なし | 1 以上の整数。並べた順（§5.3）の先頭からこの本数だけ（試しの実行用） |
| `COMPARE_MAX_WORKERS` | `4` | 1〜8。同時に処理するファイルの数 |
| `COMPARE_TIME_BUDGET_SECONDS` | `3300` | 60 以上。これを過ぎたら新しいファイルを始めず、処理中の分を待ってから答え・集計を書いて終わる |
| `COMPARE_PRICES_JSON` | なし | `{"型名": [入力, 出力]}`（100 万トークンあたり USD）。§10.3 の既定の表に上書きで足す |
| `AI_TEMPERATURE` | `0.1` | 本番と共通（§11）。`none` なら temperature を送らない |
| `AI_THINKING_LEVEL` | なし | 本番と共通（§11）。`COMPARE_MODELS` の `@考える量` があればそちらが優先 |
| `AI_MAX_TOKENS` | `2048` | 既存。考えるためのトークンも含む上限 |
| `AI_REQUEST_TIMEOUT_SECONDS` | なし（比較では未設定なら 180） | 1 回の呼び出しの待ち時間の上限 |

## 5. collect の流れ

### 5.1 始める前

1. 比較の表を開く。開けなければ終了コード 1。S3 を確かめる。
2. タブ「答え」「結果_<ラベル>」「OCR_<ラベル>」が無ければ作り、1 行目に見出しを書く（§6）。あれば見出しはそのまま。
3. 型ごとに `client.models.get(model=型名)` で有無を確かめる。404 / NOT_FOUND ならその型を「使えない」として外し、ログに出し、集計に「使えない型」として 1 行書く。ほかのエラーは外さずに警告だけ出す。

### 5.2 スレッド

- `googleapiclient` のサービスはスレッドをまたいで使えないので、**Drive と OCR はスレッドごとに作る**（`threading.local`）。`GeminiExtractor` は状態（`last_extraction_error` など）を持つので、**スレッドと型の組ごとに作る**。
- 表（Sheets）を読む・書くのは**主のスレッドだけ**。
- 1 本のファイルの読み取りが終わったら、中身のバイト列は持ち続けない（メモリは 512Mi）。

### 5.3 ファイルを集める

- 各フォルダで `DriveClient(read_only=True).list_files(id)` を呼ぶ。ファイル ID で重複を除く。
- 直接の親フォルダの名前を `DriveClient.get_name(folder_id)` で引く（同じ ID は 1 回だけ引く）。表の「フォルダ」に書く。
- 並べる順は（フォルダ名, ファイル名, ファイル ID）。`COMPARE_MAX_FILES` はこの順の先頭から。

### 5.4 続きから

- 「結果_<ラベル>」に既にある行を読む。（ファイル ID, 型）について、`COMPARE_METHODS` のすべての方式に、「結果」が `失敗:api_error` でも `失敗:file_error` でもない行があれば、その組は済み。
- すべての型が済んだファイルは、ダウンロードもしない。一部の型だけ済んだファイルは、残りの型だけ呼ぶ（OCR はもう一度行う）。
- 同じ（ファイル ID, 型, 方式）の行が複数あれば、集計と答えでは**下にある行**を使う。

### 5.5 1 本のファイル（作業スレッド）

1. ダウンロード。
2. OCR（`create_ocr_engine(config.ocr)`。本番と同じ。失敗しても次へ進む）。
3. 型ごと、方式ごとに読む。
   - 文字から: OCR が失敗か空なら呼ばずに `失敗:ocr_failed`。それ以外は `extract_receipt_data(ocr, file_name)`。
   - 画像から: `extract_from_file(file)`。
   - `last_extraction_error == "api_error"` で、エラー文に `429`・`500`・`502`・`503`・`504`・`RESOURCE_EXHAUSTED`・`UNAVAILABLE`・`DEADLINE_EXCEEDED`・`INTERNAL`・`timeout`・`timed out`（大文字小文字は問わない）のどれかがあれば、10 秒・30 秒・60 秒待って最大 3 回やり直す（待ち時間はテストで 0 にできる引数にする）。やり直した回数を記録する。
4. 予期しない例外は、そのファイルの全部の型・方式を `失敗:file_error` にして続ける。

### 5.6 主のスレッド

- 作業スレッドへは、処理中が `COMPARE_MAX_WORKERS` 本を超えないように 1 本ずつ渡す。渡す前に経過時間が `COMPARE_TIME_BUDGET_SECONDS` を過ぎていたら渡すのをやめ、残りの本数とラベルをログに出す（「同じ COMPARE_RUN_LABEL で再実行すると続きから」）。
- ファイルが 1 本終わるたびに、その行（§6.2）を「結果_<ラベル>」へ 1 回の append で足し、OCR の行を「OCR_<ラベル>」へ足す。
- 表の呼び出しは、429 か 5xx なら 10 秒・30 秒・60 秒待って最大 3 回やり直す。
- 全部（か時間切れ）の後、「結果_<ラベル>」を読み直して §9 の答えの更新と §10 の集計を行う。
- ファイルごとの失敗があっても終了コード 0。設定の誤りと、比較の表を開けないときだけ 1。

## 6. 表のタブと列

### 6.1 答え（1 行 = 1 ファイル。見出しはこのとおり）

`fileId` / `ファイル` / `フォルダ` / `ファイル名` / `状態` / `正解_日付` / `正解_金額` / `正解_税率` / `正解_店名` / `答えの出どころ` / `メモ` / `候補_日付` / `候補_金額` / `候補_税率` / `候補_店名` / `更新`

- 「ファイル」は `https://drive.google.com/file/d/<id>/view`。
- 書き方・読み方は §9。

### 6.2 結果_<ラベル>（1 行 = 1 ファイル × 1 型 × 1 方式）

`実行ラベル` / `記録時刻` / `fileId` / `ファイル` / `フォルダ` / `ファイル名` / `型` / `方式` / `結果` / `終了理由` / `再試行` / `件数` / `日付` / `合計金額` / `税率` / `店名` / `摘要` / `勘定科目` / `信頼度` / `金額照合` / `応答ms` / `入力トークン` / `出力トークン` / `思考トークン` / `推定費用USD` / `設定` / `エラー詳細` / `生の応答`

- 方式: `文字から` / `画像から` / `現行の流れ`。
- 結果: 文字から・画像からは、明細が 1 件以上なら `成功`、無ければ `失敗:<理由>`（理由は `last_extraction_error` の値か `ocr_failed`・`file_error`）。現行の流れは §8。
- 終了理由: `last_call_info["finish_reason"]`（例 `STOP`・`MAX_TOKENS`）。
- 日付・合計金額・税率: §7 でそろえた値。店名: 最初の明細の vendor をそのまま。摘要: description を ` / ` でつなぎ先頭 200 字。勘定科目: account の重複を除き `・` でつなぐ。信頼度: 明細の confidence の最小（小数 2 桁）。
- 金額照合: 明細ごとの `validate_amount(amount, ocr.raw_text).status` を `・` でつなぐ。OCR の文字が無ければ `OCRなし`。
- 設定: `temperature=<値かnone>, thinking=<値かなし>, max_tokens=<値>`。
- エラー詳細: `last_call_info["error"]` の先頭 300 字。生の応答: 型の応答文の先頭 2000 字。
- 現行の流れの行の 応答ms・トークン・費用は §8。

### 6.3 OCR_<ラベル>

`実行ラベル` / `fileId` / `ファイル名` / `OCR方式` / `信頼度` / `文字数` / `OCR文字`（先頭 40000 字） / `エラー`

### 6.4 集計_<ラベル>

§10。毎回、中身を消してから書き直す。

## 7. 値のそろえ方と一致の判定（`src/compare/normalize.py`）

- **日付**: `YYYY-MM-DD`・`YYYY/MM/DD`・`YYYY/M/D`・`YYYY.M.D`・`YYYY年M月D日` を実在する日付として読めれば `YYYY-MM-DD`。読めなければ前後の空白を除いたそのまま。ファイルの値は、明細の日付の重複を除いて並べ `・` でつないだもの。
- **金額**: 明細の amount の合計。1 件でも None なら値なし。表から読むときは `¥`・`￥`・`,`・`円`・空白を除いて整数にする（`1,234` も `1234.0` も 1234）。
- **税率**: 文字列を NFKC にしてから、`非課税` を含めば `非課税`、`対象外` か `不課税` を含めば `対象外`、そうでなければ、前後が数字でない `10` があれば `10%`、前後が数字でない `8` があれば `8%`（両方あれば両方）。どれも無ければ `不明`、空は数えない。ファイルの値は全明細の重複を除いて `8%`・`10%`・`非課税`・`対象外`・`不明` の順に並べ `・` でつなぐ。表から読むときは `・`・`,`・`、`・`/` で区切って同じ規則を当てる（`10` だけでも `10%`）。
- **店名**: NFKC → 小文字 → `株式会社`・`有限会社`・`合同会社`・`(株)`・`(有)`・`㈱`・`㈲` を除く → 空白と記号（`・-‐－ー—–_.,，。、'"()（）「」[]【】/／&＆`）を除く。二つの店名が合うのは、そろえた後でどちらも空でなく、等しいか、短い方が 2 字以上で長い方に含まれるとき。
- **一致**: 欄ごとに、そのファイルのこの実行の `成功` の行（文字から・画像からだけ。現行の流れは入れない）が 2 つ以上あり、日付・金額・税率はそろえた値が全部等しく（値なしは一致にしない）、店名は全部の組が合うとき。

## 8. 現行の流れの組み立て（`src/compare/pipeline.py`。API は呼ばない）

本番 `ProcessingManager._process_file` の判断をまねる。T = 文字からの明細、I = 画像からの明細、OCR = Vision の文字。

1. T が空で `enable_extraction_retry` が真: I が空でなければ I を使う（以下、使う明細を U、元の件数を len(U)）。I も空なら `要手入力`。
2. T が空で `enable_extraction_retry` が偽: `要手入力`。
3. T が空でない: U = T。
4. U の明細ごとに `validate_amount(amount, OCR)` を見る。`should_manual_entry` なら、`enable_amount_validation_retry` が真で、1 で I を使っていないときだけ、`ProcessingManager._select_retry_item(I, idx, len(U))` の明細を取り、その `validate_amount` が `is_valid` ならそれに置き換える。置き換えられなければその明細は要手入力。1 で I を使った明細が NG なら要手入力（本番は画像からをもう一度呼ぶが、同じ結果になる前提で近似する）。
5. 残った明細に `RuleCorrector(confidence_threshold=config.ai.confidence_threshold).apply` を当てる。表の日付・合計金額・税率・店名・勘定科目は補正後の値。
6. 結果: 全部の明細が通れば `自動`、一部だけなら `一部要手入力`、全部だめなら `要手入力`。
7. 金額照合の欄: 使った読みと状態を書く（例 `文字:ok`、`文字:digit_inflation→画像:ok`、`画像:ok`）。
8. 応答ms・トークン・費用: 文字からの分に、本番が画像からを呼ぶとき（T が空、か 4 で NG の明細があった）だけ画像からの分を足す。

## 9. 答えの更新（collect の終わりと score で同じ処理）

「答え」タブを `FORMATTED_VALUE` で全部読み、`fileId` で引く。この実行の結果に出てくるファイルごとに:

- **候補**: 欄ごとに、`成功` の行の値をそろえた値でまとめ、`<値> ← <型>/<方式>, …` を ` ｜ ` でつなぐ（型は先頭の `gemini-` を除いた短い名前）。失敗した行は最後に ` ｜ 失敗: <型>/<方式>, …`。
- **行が無い**: 行を足す。一致（§7）した欄は、その値を正解の欄に入れる（店名は、合った店名のうち最も多く出た元の文字列、同数なら短い方）。1 つでも入れたら「答えの出どころ」を `自動（全一致）`。
- **行がある**: 正解の欄は**空のときだけ**、一致した値を入れる。何か入れて「答えの出どころ」が空なら `自動（全一致）`。「メモ」には触れない（S6）。
- **状態**（毎回書き直す）: 欄ごとに「確かめが要る」とは、正解が空か、または「答えの出どころ」が `自動（全一致）` で、この実行の `成功` の行に正解と合わない値があること。要る欄があれば `要確認: 日付・金額` のように欄名を `・` でつなぐ。無ければ、出どころが `自動（全一致）` なら `全一致（自動）`、それ以外なら `確認済み`。
- 候補・状態・更新（日本時間）は毎回書き直す。書くのは変わったセルだけ、`values.batchUpdate`（RAW）で。

人が答えを入れたり直したりしたら「答えの出どころ」を `人`（`自動（全一致）` 以外なら何でもよい）にする。運用は §13。

## 10. 集計（`src/compare/score.py`）

### 10.1 数え方

「結果_<ラベル>」の行を（型, 方式）ごとに、ファイルごとに下の行を使って数える。答えは「答え」タブの正解の欄（空は答え無し）。

- 日付・金額・税率・店名の正解率: 分母は、その欄の答えがあるファイルの数。分子は、`成功` か `自動` の行で値が答えと合う数（失敗・要手入力は不正解に数える）。日付と税率はそろえた値が等しいこと、金額は整数が等しいこと、店名は §7 の合い方。
- 日付と金額: 両方の答えがあるファイルで、両方が合う数。
- 現行の流れだけ: `正しく自動`（自動で日付と金額が合う）、`誤って自動`（自動で日付か金額が合わない。両方の答えがあるファイルだけ）、`要手入力`（要手入力と一部要手入力）。
- 文字から・画像からだけ: `失敗`（結果が `失敗:` で始まる数）、`MAX_TOKENS`（終了理由が MAX_TOKENS の数）、`金額照合NG`（金額照合に `digit_inflation` か `missing_in_ocr` を含む数）。
- 応答ms の平均と最大、トークンの合計、推定費用の合計と 1 本あたり。

### 10.2 集計タブ

1〜5 行目: `実行ラベル` / `集計時刻` / `設定`（最初の行の設定） / `答えのあるファイル`（`日付 n・金額 n・税率 n・店名 n（全 N 本）`） / `要確認のファイル`（この実行のファイルのうち状態が `要確認` で始まる数）。1 行空けて表:

`型` / `方式` / `ファイル数` / `失敗` / `MAX_TOKENS` / `金額照合NG` / `日付` / `金額` / `税率` / `店名` / `日付と金額` / `正しく自動` / `誤って自動` / `要手入力` / `平均応答ms` / `最大応答ms` / `入力トークン` / `出力トークン` / `思考トークン` / `推定費用USD` / `1本あたりUSD`

正解率のセルは `n/m (xx.x%)`（m が 0 なら `-`）。その方式に関係の無い列は空。並びは `COMPARE_MODELS` の順 × 文字から・画像から・現行の流れ。使えない型は「方式」に `使えない型` と書いた 1 行。

### 10.3 推定費用

`(入力トークン × 入力単価 + (出力トークン + 思考トークン) × 出力単価) / 1,000,000`。単価の表に無い型は `単価未設定`。既定の表（`@考える量` を除いた型名で引く。11-18 に公式の料金表で確認）:

| 型 | 入力 | 出力 | 注 |
|---|---|---|---|
| `gemini-2.5-flash` | 0.30 | 2.50 | |
| `gemini-3.5-flash-lite` | 0.30 | 2.50 | |
| `gemini-3.8-flash` | 1.50 | 7.50 | 2027-01-01 からの単価（2026 年中は半額）。長く使う前提で比べるため |

## 11. 既存コードへの小さな変更

- `AiConfig`: `temperature: float | None = 0.1`、`thinking_level: str | None = None`、`request_timeout_seconds: int | None = None` を足す。`load_config` は `AI_TEMPERATURE`（`none` なら None）、`AI_THINKING_LEVEL`（空なら None。値は `minimal`・`low`・`medium`・`high`、それ以外は ValueError）、`AI_REQUEST_TIMEOUT_SECONDS`（正の整数）を読む。
- `GeminiExtractor`:
  - `temperature` は `config.temperature`。None なら `GenerateContentConfig` に temperature を渡さない。
  - `thinking_level` が None でなければ `thinking_config=types.ThinkingConfig(thinking_level=...)` を渡す。None なら渡さない。
  - `request_timeout_seconds` が None でなければ `genai.Client(api_key=..., http_options=types.HttpOptions(timeout=秒×1000))`。None なら今のまま。
  - `last_call_info: dict | None` を足す。各呼び出しの初めに None、`generate_content` が返った直後（`resp.text` を触る前）に `{"model", "latency_ms", "finish_reason", "prompt_tokens", "output_tokens", "thinking_tokens", "raw_text", "error"}` を入れる（無い値は None。`finish_reason` は列挙の名前の文字列）。例外のときも `latency_ms` と `error` を入れる。戻り値と `last_extraction_error` の決め方は変えない（S7）。
- `DriveClient`: `__init__(config, credentials_path=None, read_only=False)`。`read_only` ならスコープは drive.readonly だけ、`rename_file_as_done` は S2 のとおり。`get_name(file_id) -> str` を足す（`files().get(fileId=..., fields="name")`）。
- 比較では `dataclasses.replace(config.ai, model=型名, thinking_level=..., request_timeout_seconds=config.ai.request_timeout_seconds or 180)` で型ごとの設定を作る。

## 12. テスト（pytest。ネットワークを使わない。API はすべて偽物）

- S1: compare で `main()` を呼ぶと `ProcessingManager`・`MasterSheetClient`・`CashbookClient` が作られない（patch して呼ばれないことを確かめる）。
- S2: `DriveClient(read_only=True)` が drive.readonly だけで認証を作る。読取り専用の `rename_file_as_done` は `RuntimeError` で、`files().update` を呼ばない。比較の実行全体で rename・update が 0 回。
- S3: 比較の表の ID がマスターと同じなら終了コード 1 で、表の API を 1 回も呼ばない。
- S4: `RUN_MODE=prod`（と `validate`、未設定）で `COMPARE_FOLDER_IDS` などに値があると終了コード 1 で、何も作らない。空の値なら今どおり。
- S5: 表へのすべての書込みが RAW（偽の Sheets が受けた引数で確かめる）。`=SUM(A1)` という店名がそのまま文字で入る。
- S6: 値の入った正解の欄・出どころ・メモは、一致した別の値があっても変わらない。空の欄だけが埋まる。Hypothesis で「どんな既存の答えと結果でも、空でないセルは変わらない」も確かめる。
- S7: 既定の設定で `GenerateContentConfig` に `temperature=0.1` が入り、`thinking_config` が無く、`genai.Client` に `http_options` が渡らない。既存テストがすべて通る。
- S8: ログと表に API キーの値が出ない（偽のキーの文字列で確かめる）。
- 環境変数の読み取り: 既定値、`@考える量`、重複、誤った ID・型名・ラベル・本数・同時数・時間で終了コード 1。
- そろえ方: 日付の各書き方、実在しない日付、金額の合計と値なし、税率（`課税仕入10%`・`課税仕入8%（軽減）`・`8%・10%`・`非課税`・`不課税`・空）、店名の合い方（株式会社の有無、支店名つき、1 字だけは含みで合わない）。
- 一致: 成功が 1 つだけなら一致にしない。値なしは一致にしない。現行の流れの行は数えない。
- 現行の流れ: 文字から OK → 自動 / 文字が空 → 画像から / 金額 NG で画像が OK → 置き換え / 両方 NG → 要手入力 / 件数が違って対応できない → 要手入力 / 一部だけ → 一部要手入力 / 再抽出の設定が偽のとき / 費用は画像を呼ぶときだけ足す。
- 続きから: 済んだ（ファイル, 型）は呼ばない。`api_error` の行はやり直す。全部済んだファイルはダウンロードしない。
- やり直し: 429 で 2 回失敗して 3 回目で成功 → 再試行 2。4 回とも 429 → `失敗:api_error`、再試行 3。400 はやり直さない。
- 使えない型: 404 の型は呼ばず、集計に `使えない型`。
- 時間切れ: 時間を過ぎたら新しいファイルを始めず、答えと集計は書く。
- `COMPARE_MAX_FILES` と並べる順。
- 集計: 答えが一部だけのときの分母、失敗を不正解に数える、`n/m (xx.x%)` と `-`、正しく自動・誤って自動・要手入力、単価未設定、`@考える量` の型の単価。
- `last_call_info`: 使用量・終了理由・応答時間が入る。`resp.text` が None でも `finish_reason` が残る。例外のときに `error` が入る。

確かめるコマンド（CI と同じ）: `pytest -v`、`ruff check src/ tests/`、`ruff format --check src/ tests/`。

## 13. 運用（Cloud Console。司令役と利用者）

1. 利用者が、テスト用フォルダ（ジョブのサービスアカウントが編集者のフォルダ）の中に空のスプレッドシートを作る。サービスアカウントは新しいファイルを作れないため。
2. main へ push（＝本番ジョブの作り直し）。push の前に利用者の了解を取る。
3. Cloud Console → Cloud Run → ジョブ `receipt-ocr-job` →「オーバーライドして実行」。環境変数に `RUN_MODE=compare`・`COMPARE_RESULT_SPREADSHEET_ID`・`COMPARE_FOLDER_IDS` を入れ、タスクのタイムアウトを 3600 秒にする。**押す前に `RUN_MODE=compare` が入っていることを必ず確かめる**（入っていないと本番の記帳が全顧客で動く。`COMPARE_` の値があれば S4 で止まるが、全部を書き忘れると止まらない）。
4. まず `COMPARE_MAX_FILES=4` で試す → 表と `MAX_TOKENS` を見る → 全部を流す（時間切れなら同じラベルで続き）。
5. 「答え」で `要確認` の行を確かめる（司令役が画像を見て案を書き、利用者が確かめる）。`全一致（自動）` の行からも抜き取りで確かめる。直したら「答えの出どころ」を `人` に。
6. `COMPARE_STEP=score` と `COMPARE_RUN_LABEL` で集計し直す。
7. 結果で型と設定を決め、本番の `AI_MODEL` などを明示で固定する（別の作業）。

## 14. 記録

- 1.0（2026-11-18）: 初版。

# 「要修正」（区分1）の理由を記録して画面に出す 仕様書（`spec_webapp.md` K-W22）

作成日：2026-10-04
版：1.1
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いてあることは変えない。書いていないことは安全側で決め、決めたことは全部報告する。

改訂履歴：
- 1.0（2026-10-04）：初版。ko-ch さんの依頼（2026-10-04「次の作業候補を進めて」、候補 1）。
- 1.1（2026-10-08）：実装（Codex、10-08）の監査で直した。区分1の取込の読取は＋1 ではなく＋2（§2.3・§3。実測 14→16）。テストに読取の上限（cf 7・cf 11）を足した（§4）。残したことに 2 つ足した（§7）。

---

## 1. 何を直すか

取込で区分1（`SOURCE_REQUIRES_CUSTOMER_FIX`）になったファイルは、無書込で `CUSTOMER_FIX_REQUIRED`（【要修正】）へ送られる。**なぜ要修正になったのか（どの行の何が足りないのか）が、どこにも残らない。**

- `classifyValidationResult`（`src/30_TransactionValidator.gs`）は区分1のとき `{category: 1, code: 'SOURCE_REQUIRES_CUSTOMER_FIX', reviewEntries: [], blankDateTxIds: []}` しか返さない。行の情報を捨てている。
- 取込（`processDiscoveredFile_`、`src/71_RunOrchestrator.gs`）は区分1のとき処理ログのエラー欄（W 列）に何も書かない。
- Web アプリのファイル一覧は状態を「要修正（顧客の修正待ち）」と出すだけ。

2026-10-03、ドコモカード 11 本が全部【要修正】になったとき、原因（家族カードの名義人ごとの小計行が、店名・用途の無い取引として読まれていた）を突き止めるのに、手元の写しを openpyxl で開いて行ごとに調べた。顧客に「どこを直してほしいか」を伝えるのにも同じ手間がかかる。

区分1になる材料は今 2 つだけである（`classifyValidationResult` の区分1の条件）：
1. **使用用途が空で、補完もできなかった行**（`purposeResolution.unresolvedCount > 0`。補完は元ファイル名のルール、§5.4）
2. **利用店名が空の行**（`validateTransactions` の `MERCHANT_REQUIRED`。形式が店名の空欄を許す場合は区分3なのでここに来ない）

## 1.1 本仕様がすること

1. 区分1の理由を、**区分の判定と同じ材料・同じ条件で**組み立てる純関数を足す（§2.1）。中身は「理由の種類・件数・行番号（最大 20 個）」だけで、**明細の中身（店名・金額・日付・用途の値）は入れない。**
2. 取込で区分1になったとき、その理由を**処理ログのエラー欄へ 1 件記録**し（`recordError`）、取込の戻り値（ファイルごとの結果）にも載せる（§2.2・§2.3）。
3. Web アプリのファイル一覧で、【要修正】のファイルの「状態」の下に理由を出す（§2.4・§2.5）。形式の確認で担当者が「顧客に修正を依頼」したファイル（`webAppReturnFileToCustomer` が既に記録している）も、その理由を出す。
4. Web アプリの取込が終わったときのお知らせに、【要修正】になったファイルと理由を出す（§2.5）。

## 1.2 変えないこと

- **区分の判定**（`classifyValidationResult` の中身・戻り値）。区分1になるファイル・ならないファイルは 1 本も変わらない。
- 状態の遷移・リース・転記先・取引ログ・要確認。区分1のファイルは今と同じく無書込で `CUSTOMER_FIX_REQUIRED` へ行く。
- `resolvePurposes` の戻り値の形（`{txs, unresolvedCount}`。既存のテストが形をまるごと比べている）。
- 区分1以外のファイルの取込の読取・書込の回数（`budget 1`・`multi 14` の上限 20）。
- 形式の画面（19 のプレビュー）・メニュー（96）・運用関数（97）。

---

## 2. 設計

### 2.1 理由の組み立て（`src/30_TransactionValidator.gs`）

`classifyValidationResult` の近くに次の 3 つを足す。どれも純関数で、何も読まず何も書かない。

```js
var CUSTOMER_FIX_ROWS_LIMIT_ = 20;

/**
 * 区分1の理由（K-W22）。
 * @param {!Array<!Object>} transactions 用途補完の後の取引（runPreValidationBlock の input.transactions）
 * @param {!Object} validation classifyValidationResult に渡したのと同じ判定材料
 * @return {{transactionCount: number, reasons: !Array<{kind: string, count: number, rows: !Array<number>}>}}
 */
function customerFixReasons(transactions, validation) { ... }

/** 処理ログ用の 1 行の要約（ASCII）。 */
function summarizeCustomerFixReasons(reasons) { ... }
```

規則：

1. `transactionCount` は `transactions` が配列ならその長さ、そうでなければ 0。
2. **用途の理由**：`validation.purposeResolution.unresolvedCount > 0` のとき（`classifyValidationResult` と同じ条件）だけ、`{kind: 'PURPOSE_EMPTY', count: <unresolvedCount を数にしたもの>, rows}` を**先頭に**置く。`rows` は `transactions` のうち用途が空の取引（`tx.purpose === null || tx.purpose === undefined || tx.purpose === ''`。`resolvePurposes` が「空」とみなす条件と同じ）の `sourceRow`。
3. **取引の検査の理由**：`validation.transactionValidation.issues` のうち `issue.customerFix === true || issue.kind === 'MERCHANT_REQUIRED'` のもの（`classifyValidationResult` と同じ条件）を、`kind = String(issue.code || issue.kind || 'UNKNOWN')` で束ねる。束は**最初に現れた順**に、用途の理由の後へ並べる。`count` はその束の件数、`rows` は各 issue の `sourceRow`。今の実装では `MERCHANT_REQUIRED` だけが当たる。
4. `rows` の作り方（2・3 共通）：`Number.isInteger(row) && row >= 1` のものだけを取り、重複を除き、**小さい順**に並べ、**先頭 20 個**（`CUSTOMER_FIX_ROWS_LIMIT_`）にする。`count` は切り詰めない（行番号の無い取引・21 個目以降も数に入る）。
5. どちらの条件にも当たらなければ `reasons: []`。

`summarizeCustomerFixReasons(reasons)`：各理由を `<kind>=<count>` とし、`rows` が空でなければ ` rows <rows を , で連結>` を、さらに `count > rows.length` なら ` +<count - rows.length>` を後ろに付け、`; ` で連結する。空の配列は `''`。

例：`PURPOSE_EMPTY=25 rows 6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25 +5; MERCHANT_REQUIRED=1 rows 30`

### 2.2 事前検証が理由を返す（`src/70_ImportFlow.gs` の `runPreValidationBlock`）

区分1のときだけ、戻り値の `detail` に `customerFix` を足す：

```js
if (category === 1 || category === 2) {
  var detail = {classification: classification};
  if (category === 1) detail.customerFix = customerFixReasons(input.transactions || [], validation);
  return preValidationResult_(category, classification.code, [],
    classification.reviewEntries || [], detail);
}
```

**`validation` は関数の中で組み立てた局所変数を渡す**（`input.validation` ではない）── `transactionValidation` はこの関数の中で計算して足しているので、`input.validation` には店名の材料が無いことがある。区分2・区分3・区分なしの戻り値は変えない。

### 2.3 処理ログへの記録と取込の戻り値（`src/71_RunOrchestrator.gs` の `processDiscoveredFile_`）

`processFile` が返った後（`phase('processFile')` の後）、**状態の遷移（`transitionFileState`）の前**に、区分1なら次をする：

```js
if (result.preValidation.category === 1) {
  var fix = (result.preValidation.detail && result.preValidation.detail.customerFix) ||
    {transactionCount: 0, reasons: []};
  var sheetName = resolvedSheet && resolvedSheet.name !== null && resolvedSheet.name !== undefined ?
    String(resolvedSheet.name) : null;
  outcome.customerFix = {sheetName: sheetName, transactionCount: fix.transactionCount, reasons: fix.reasons};
  try {
    recordError(fileId, {code: 'SOURCE_REQUIRES_CUSTOMER_FIX', source: 'IMPORT',
      occurredAt: nowIso_(), runId: String(runId), sheetName: sheetName,
      transactionCount: fix.transactionCount, reasons: fix.reasons,
      detail: summarizeCustomerFixReasons(fix.reasons)});
  } catch (error) {
    Logger.log('CUSTOMER_FIX_REASON_NOT_RECORDED ' + JSON.stringify({fileId: String(fileId),
      code: String((error && error.code) || (error && error.name) || 'Error')}));
  }
}
```

決まりごと：

1. **遷移の前に書く。**遷移がリースを解放する。リースを持っているあいだに書けば、同じファイルの処理ログを他の実行が同時に書くことはない。
2. **記録の失敗で区分1の結果を変えない。**記録は診断のためのもので、失敗してもファイルは今と同じく `CUSTOMER_FIX_REQUIRED` へ行き、リースは解放され、`outcome.customerFix` は返る（画面のお知らせには出る）。`FAILED` にしない。ログには固定の語と fileId・エラーの code だけを出す（エラーの message は出さない）。
3. **記録に明細の中身を入れない。**入れてよいのは上のキーだけ（種類・件数・行番号・シート名・取引件数・時刻・runId）。
4. 新しい段の名前（`phase(...)`）は足さない。記録の時間は既存の `finish` の段に入る。
5. `outcome.customerFix` は区分1のときだけ置く。区分1以外の `outcome` にはキーを作らない。

`recordError` は今のまま使う（ロックの中で処理ログの行を読み直して末尾に足す）。**読取は 2 回**（1.1 で訂正）：`getProcessLogRecord_` で行を読み、`updateProcessLogUnlocked_` が既知の行を渡されないので書く前にもう一度読む。`60` は今回変えない（共通の口で、他の呼出しにも効くため）。

### 2.4 ファイル一覧の材料（`src/80_WebApp.gs` の `webAppListFolder`）

ファイルの配列を作った後（`formatReviewId` を付けた後）、状態が `CUSTOMER_FIX_REQUIRED` のファイルにだけ `fixReason` を付ける：

1. `CUSTOMER_FIX_REQUIRED` のファイルが 1 本も無ければ、**処理ログを読まない**（今と同じ読取）。
2. 1 本以上あれば、`findRowsByColumnValues_(processLogSheet_(), PROCESS_FIELD_COLUMNS_.fileId, ids, PROCESS_LOG_WIDTH_)` を **1 回**呼ぶ。各ファイルについて、行がちょうど 1 つならその W 列（`PROCESS_FIELD_COLUMNS_.errors`）を `webAppCustomerFixReason_` に渡した結果、それ以外（0 行・2 行以上）なら `{source: 'NONE'}`。
3. この読取が例外を投げたら、**一覧は失敗させない**。`CUSTOMER_FIX_REQUIRED` の全ファイルに `{source: 'UNAVAILABLE'}` を付けて一覧を返す。
4. `CUSTOMER_FIX_REQUIRED` 以外のファイルには `fixReason` のキーを作らない。

`webAppCustomerFixReason_(errorsCell)`（新しい補助関数、80）：

1. セルを JSON として読む（`jsonCell_` 等。読めない・配列でない → `{source: 'NONE'}`）。
2. **末尾から**見て、`truncated` の印を飛ばし、`code === 'SOURCE_REQUIRES_CUSTOMER_FIX'` の**最初に見つかった 1 件**（＝いちばん新しい記録）を使う。無ければ `{source: 'NONE'}`。
3. その記録が配列の `reasons` を持てば（取込の記録）：
   ```js
   {source: 'IMPORT', occurredAt: <文字列なら値、それ以外 null>,
    sheetName: <空でない文字列なら値、それ以外 null>,
    transactionCount: <有限の数なら値、それ以外 0>,
    reasons: [{kind: String(kind), count: <有限の数なら値、それ以外 0>,
               rows: <配列の中の 1 以上の整数だけ、先頭 20 個。配列でなければ []>}]}
   ```
4. そうでなく、`detail` が文字列で `/^(PURPOSE_COLUMN_MISSING|PURPOSE_HEADER_VALUE|PURPOSE_IN_ISSUER_COLUMN|OTHER)(?:: ([\s\S]*))?$/` に当たれば（`webAppReturnFileToCustomer` の記録）：`{source: 'FORMAT_REVIEW', returnReason: <1 つ目の組>, note: <2 つ目の組。無ければ ''>}`。
5. それ以外は `{source: 'NONE'}`。

`webAppReturnFileToCustomer` は変えない（記録の形 `{code, detail: '<理由>: <メモ>'}` を上の 4 で読む）。

### 2.5 画面（`src/81_WebAppUi.html`）

純関数を 2 つ足す（`formatElapsed` と同じく、スクリプトの関数として）：

**`customerFixReasonLines(fixReason)` → 文字列の配列**

- `fixReason` が無い・`source` が `NONE`・知らない `source` → `['理由の記録はありません']`
- `UNAVAILABLE` → `['理由を読み込めませんでした']`
- `FORMAT_REVIEW` → 1 行：見出し ＋（`note` が空でなければ `'（' + note + '）'`）。見出し：
  - `PURPOSE_COLUMN_MISSING`：`「使用用途」の列がありません`
  - `PURPOSE_HEADER_VALUE`：`「使用用途」の列の見出しに用途が書かれています`
  - `PURPOSE_IN_ISSUER_COLUMN`：`カード会社の列に用途が書かれています`
  - `OTHER`：`形式の確認で顧客に修正を依頼しました`
  - それ以外：`returnReason` の文字列のまま
- `IMPORT` → 理由 1 つにつき 1 行（`reasons` が空なら `['理由の記録はありません']`）。名前は `PURPOSE_EMPTY`：`使用用途が空`、`MERCHANT_REQUIRED`：`利用店名が空`、それ以外は `kind` のまま。行の形：
  1. `transactionCount > 1` かつ `count === transactionCount` → `<名前>：すべての行（<count> 行）`
  2. そうでなく `rows` が空でない → `<名前>：` ＋（`sheetName` があれば `シート「<sheetName>」の `）＋ `rows` を `・` で連結 ＋ ` 行目` ＋（`count > rows.length` なら ` ほか <count - rows.length> 行`）
  3. それ以外 → `<名前>：<count> 行`

  例：`使用用途が空：5・7・9 行目`／`使用用途が空：シート「202506」の 5・7 行目 ほか 3 行`／`使用用途が空：すべての行（12 行）`／`利用店名が空：2 行`

**`customerFixNoticeLines(fileResults)` → 文字列の配列**

`fileResults` の各要素のうち `nextState === 'CUSTOMER_FIX_REQUIRED'` のものについて、`'【要修正】' + (fileName || fileId || '') + '：' + customerFixReasonLines(<customerFix があれば {source: 'IMPORT', ...customerFix}、無ければ null>).join('／')`。配列でなければ `[]`。

**結線：**

1. `renderFiles`：「状態」のセルは今と同じ文字を出し、`file.fixReason` があれば、その下に `customerFixReasonLines(file.fixReason)` の 1 行ずつを `div`（class `fix-reason`）で足す。**文字は `textContent` で入れる**（メモ・シート名は利用者や顧客の書いた文字なので HTML として解釈させない）。
2. CSS：`.fix-reason`（小さめの字・既存の `--warn` の色。新しい色の変数は作らない）。
3. `startImport`：呼出しが返るたび、`collectSessionFiles(result.fileResults)` の後で `warnings = warnings.concat(customerFixNoticeLines(result.fileResults))`。お知らせの文と種類（success 等）は変えない。

---

## 3. 読取と書込の回数

| 場面 | 今 | 後 |
|---|---|---|
| 区分1以外のファイルの取込 | 変わらない | 変わらない |
| 区分1のファイルの取込 | 14 読取（実測） | **16 読取（＋2：`recordError` が行を読み、書く前にもう一度読む）＋1 書込**。cf 7 が上限 16 を見る |
| ファイル一覧（要修正のファイルが無い） | 変わらない | 変わらない（処理ログを読まない） |
| ファイル一覧（要修正のファイルがある） | ── | **＋2 読取**（`findRowsByColumnValues_` のキー列と行） |

区分1のファイルは書込が無いので、1 本 20 読取前後の取込の中では小さい。

---

## 4. テスト（`cf N: …`）

置き場所：純関数は `test/phase1b-validation.test.js`、取込の流れは `test/phase6-orchestrator.test.js`（`runPreValidationBlock` は `test/phase3-importflow.test.js` でもよい）、Web アプリと画面は `test/phase8-webapp.test.js`。補助は足してよい。

**純関数（30）**
1. 用途が空の取引（`sourceRow` 9・5・7）と用途のある取引（6）、`unresolvedCount: 3` → `{transactionCount: 4, reasons: [{kind: 'PURPOSE_EMPTY', count: 3, rows: [5, 7, 9]}]}`。
2. 用途が空＋`validateTransactions` が返した店名の空欄（`MERCHANT_REQUIRED`）＋区分1でない issue（`DATE_UNREADABLE`・`ZERO_AMOUNT`・`MERCHANT_BLANK_ALLOWED`）→ 理由は `PURPOSE_EMPTY`、`MERCHANT_REQUIRED` の順の 2 つだけ。同じ入力で `classifyValidationResult` が区分1を返すことも確かめる。
3. 用途が空の取引が 25 件（`sourceRow` を逆順・1 つ重複）→ `rows` は小さい方から 20 個・重複なし、`count` は 25。
4. `unresolvedCount: 0` なら用途が空の取引があっても `PURPOSE_EMPTY` を作らない。`sourceRow` の無い取引は数に入り、行番号には出ない。
5. `summarizeCustomerFixReasons`：§2.1 の例の文字列そのもの、`rows` が空の理由（`PURPOSE_EMPTY=2`）、`[]` → `''`。

**取込の流れ（70・71）**
6. `runPreValidationBlock`：区分1なら `detail.customerFix` が `customerFixReasons` の結果と同じ。店名の材料（`transactionValidation`）を呼出側が渡さない形でも `MERCHANT_REQUIRED` が入る。区分2の `detail` には `customerFix` が無い。
7. `runImport`：CSV（2 行目 用途空・3 行目 用途あり・4 行目 用途空・5 行目 店名空で用途あり）→ ファイルの結果が区分1・`CUSTOMER_FIX_REQUIRED`・`customerFix` が `{sheetName: null, transactionCount: 4, reasons: [{PURPOSE_EMPTY, 2, [2, 4]}, {MERCHANT_REQUIRED, 1, [5]}]}`。処理ログの W 列の最後の記録が `code`・`source: 'IMPORT'`・`runId`（その実行の runId）・`occurredAt`（文字列）・同じ `reasons`・`detail: 'PURPOSE_EMPTY=2 rows 2,4; MERCHANT_REQUIRED=1 rows 5'`、エラー件数（V 列）が 1。**記録の JSON に、CSV の店名・金額・用途の文字が 1 つも無い。**
8. 記録は遷移の前：`recordError`（理由の記録）が `transitionFileState(…, 'CUSTOMER_FIX_REQUIRED', …)` より先に呼ばれる（呼び順を記録して確かめる）。
9. 理由の `recordError` が投げても：ファイルは `CUSTOMER_FIX_REQUIRED`・名前は【要修正】・有効なリースが残らない・`outcome` は `NO_WRITE` で `customerFix` を持つ・`FAILED` にならない・`CUSTOMER_FIX_REASON_NOT_RECORDED` のログが出る（店名を含まない）。
10. 区分2（形式不明）と区分なし（完了）のファイル：W 列に `SOURCE_REQUIRES_CUSTOMER_FIX` の記録が無く、結果に `customerFix` のキーが無い。

**Web アプリ（80）**
11. `webAppListFolder`：要修正（取込の記録あり）・完了・未登録の 3 本 → 要修正のファイルだけが `fixReason`（§2.4 の 3 の形）を持ち、他の 2 本は `fixReason` のキーを持たない。
12. 要修正のファイルが無いフォルダの一覧では処理ログを読まない（`findRowsByColumnValues_` を処理ログに対して呼ばない・読取の回数が直す前と同じ）。要修正があるときの増分は 2 読取以下。
13. `webAppCustomerFixReason_`：(a) 取込の記録が 2 つ → 新しい方、(b) 末尾が別のコード（`UNEXPECTED_ERROR`）でもその前の要修正の記録を使う、(c) 先頭の `truncated` の印は無視、(d) `'PURPOSE_HEADER_VALUE: メモ'` → `FORMAT_REVIEW`・`note: 'メモ'`、`'PURPOSE_COLUMN_MISSING'` → `note: ''`、(e) `''`・`'not json'`・`'{}'` → `NONE`、(f) `rows` の整数でない値は落とし、21 個以上は 20 個にする。
14. 処理ログの読取が投げても一覧は返り、要修正のファイルは `{source: 'UNAVAILABLE'}`。
15. `webAppReturnFileToCustomer` で要修正にしたファイル → 一覧の `fixReason` が `FORMAT_REVIEW` とその理由。既存の補助で作りにくければ、作れない理由を報告する（13 の (d) で代える）。

**画面（81）**
16. `customerFixReasonLines`：§2.5 の 4 つの例の文字列そのもの、`transactionCount` が 1 で `count` が 1 → 行目の形（「すべての行」にしない）、知らない `kind` はそのまま、`FORMAT_REVIEW` の 4 つの見出しとメモあり・なし、`NONE`・`UNAVAILABLE`・`null`・`IMPORT` で `reasons` が空。
17. `customerFixNoticeLines`：要修正 2 本（1 本は `customerFix` なし）と完了 1 本 → 2 行。配列でなければ `[]`。
18. 結線：`renderFiles` が `customerFixReasonLines(file.fixReason)` を使い、`startImport` が `customerFixNoticeLines(result.fileResults)` を `warnings` に足していること（ソースの確認でよい）。`81` に `innerHTML`・`outerHTML`・`insertAdjacentHTML` が無いこと。

**既存のテスト**：期待（assert）を 1 つも変えない。特に `budget 1`・`multi 14`（取込の読取の上限 20）、`webapp`・`bulk`・`kw9`・`subtotal`・`deposit`、phase1a の `resolvePurposes` の形の比較、phase3 の INV-14（区分1は 1 セルも書かない・取引ログ行も作らない）。

## 5. 変異（P1〜P20）

実装後に 1 つずつ入れて、赤になるテストを記録して戻す。

| # | 場所 | 変異 | 赤になるはずのテスト |
|---|---|---|---|
| P1 | 30 | 用途の理由を作らない | 1・7 |
| P2 | 30 | `rows` を並べ替えない | 1・3 |
| P3 | 30 | 20 個の上限を外す | 3 |
| P4 | 30 | `customerFix` でない issue も数える | 2 |
| P5 | 30 | 用途の `count` を `transactions.length` にする | 1 |
| P6 | 30 | 要約の ` rows ` を ` ` にする | 5・7 |
| P7 | 70 | 区分2にも `customerFix` を付ける | 6 |
| P8 | 70 | `input.validation` を渡す | 6 |
| P9 | 71 | `recordError` を呼ばない | 7 |
| P10 | 71 | 記録を遷移の後へ移す | 8 |
| P11 | 71 | `try`／`catch` を外す | 9 |
| P12 | 71 | 記録の各理由に店名の配列を足す | 7 |
| P13 | 71 | 区分1以外でも記録する | 10 |
| P14 | 80 | 最も古い記録を使う | 13 |
| P15 | 80 | `truncated` の印を飛ばさない | 13 |
| P16 | 80 | 要修正が無くても処理ログを読む | 12 |
| P17 | 80 | 全ファイルに `fixReason` を付ける | 11 |
| P18 | 80 | 読取の `try`／`catch` を外す | 14 |
| P19 | 81 | 「すべての行」の `transactionCount > 1` を外す | 16 |
| P20 | 81 | お知らせが要修正以外も拾う | 17 |

## 6. 受入（実機）

1. push 後、Web アプリで要修正になるファイルを取り込む（例：顧客側の不備で要修正に戻る au・enavi・SAISON_2504。ko-ch さんの操作）。お知らせに【要修正】の行と理由が出る。ファイル一覧の「状態」の下に理由が出る。
2. 出た行番号が、手元の写し（`テスト用クレカ明細/`）の実際の行と合う（Claude が確かめる）。
3. 処理ログの W 列の記録に明細の中身が無い（Claude が `opsShowFileStates` で見る）。
4. 同じ呼出しの他のファイルの読取が変わらない（`IMPORT_CALL`）。

**受入の結果（2026-10-12、gas-push-110 のまま）：**セゾンカードの SAISON_2504 だけを Web アプリで取り込んだ（取込待ちはこの 1 本だけ）。
- 1：ファイル一覧の「状態」の下に `使用用途が空：シート「SAISON_2504」の 81 行目` が出た（スクリーンショットで確認）。**お知らせはユーザーが見ていない** ── お知らせ欄はページの上端にあり、ユーザーは一覧のあたりを見ていた。消す処理は顧客の選び直し・次の取込/確定・最終確認だけなので、出ていたが画面の外だった見込み（サーバーの `fileResults` は 71 の `outcome` をそのまま渡し、`nextState` は `CUSTOMER_FIX_REQUIRED`）。
- 2：手元の写しの 81 行目は「カード年会費(本会員)」（日付・使用用途が空）。シート名も `SAISON_2504`。読取 74 行＝取引の行 7〜79 の 73 行＋81 行目で、前回の記録（read 74・excluded 8）とも合う。
- 3：処理ログ W 列は `[{"code":"SOURCE_REQUIRES_CUSTOMER_FIX","source":"IMPORT","occurredAt":…,"runId":…,"sheetName":"SAISON_2504","transactionCount":74,"reasons":[{"kind":"PURPOSE_EMPTY","count":1,"rows":[81]}],"detail":"PURPOSE_EMPTY=1 rows 81"}]` だけ。明細の中身は無い。`CUSTOMER_FIX_REASON_NOT_RECORDED` のログも無い。リース 0、他の取込待ち 6 本は不変。
- 4：1 呼出し 1 ファイルなので比べる相手は無い。`IMPORT_CALL`：ファイル 21 秒・読取 19・`NO_WRITE`、全体 49 秒・37 読取、quotaHits 0、前検査の所見 0。
- 形式の確認から差し戻す経路（FORMAT_REVIEW）は実機では見ていない（ユーザーの判断 A）。楽天カードのフォルダに未取込の 4 本（enavi202502・202510・202511・202512）があり、取り込むと一緒に書かれるため。cf 15・16 で確かめてある。
- 見つけた別件：進捗の矢印（`.progress-arrows { display: inline-flex }`）が `hidden` 属性を打ち消し、待機中も完了後も「→→→」が出たまま。完了後も「処理中 1 / 1（経過 0:51）」の文字が残る。お知らせが画面の外に出る件と合わせ、「取込が終わったことが分かりにくい」。

## 7. 判断の記録・残したこと

- **記録の置き場は処理ログのエラー欄（W 列）。**新しい列は作らない（処理ログは 40 列で固定。列を足すとシートの構成の版が変わる）。W 列は既に `{code, detail}` の記録の配列で、運用関数（97）は最後の記録の `code: detail` を出す ── `detail` に ASCII の要約を入れるのはそのため。
- **書く時点は遷移の前（`recordError` で 1 読取＋1 書込）。**終わりの `updateProcessLog` に混ぜれば読取 0 で済むが、そこはリースを解放した後で、遷移のときに読んだ古い W 列を元に書き戻すことになる。区分1のファイルは少ないので、1 読取で新しい値を読む方を取った。
- **記録の失敗は飲み込む。**理由は診断で、ファイルの行き先を変える材料ではない。取込のお知らせには戻り値から出るので、記録に失敗しても利用者は理由を見られる（一覧には「理由の記録はありません」）。
- **行番号は元ファイルの行**（`sourceRow`。xlsx はシートの行番号、CSV は記録の始まる行）。顧客がファイルを開いて同じ行を見られる。
- **残したこと（今回は直さない）：**
  1. 形式の確認以外で要修正にする操作（`52` の `REJECT_COUNT_MISMATCH`・`RETURN_TO_CUSTOMER`・ファイル分割の依頼）は理由を記録しない。一覧には「理由の記録はありません」と出る。
  2. 用途の列に外貨の金額の形（`3,000 KRW`）が入った行は、パーサーが用途を空として扱う（K-F1）。理由は「使用用途が空」になり、元ファイルでは値が見える。
  3. 区分1の記録が古いまま残ることがある：要修正 → 取込待ちへ戻す → `52` の操作で要修正、の順のとき、一覧は前の取込の理由を出す。
  4. 形式の画面のプレビュー（19）とメニュー（96）は変えない。
  5. （1.1）記録はエラー件数（処理ログ V 列）を 1 増やすので、メニュー（96）の取込状況の「エラー」の合計に区分1のファイルが入る。形式の確認で差し戻したとき（`webAppReturnFileToCustomer`）も同じ記録の仕方で、判断には使われていない。
  6. （1.1）テストで捕まえない変異（監査で確かめた。どれも表示の細部か、起きない入力）：理由を「状態」以外の列の下に出す（cf 18 はソースの文字列しか見ない）・xlsx のシート名を落とす（xlsx の区分1の取込のテストが無い）・処理ログに同じファイルの行が 2 つあるとき先頭を使う・行番号 0 を残す。

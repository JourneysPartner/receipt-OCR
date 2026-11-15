# freee 取込用 Excel（値だけ・データの行だけの 1 枚）を画面から作る 仕様書

作成日：2026-11-15
版：1.0
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いてあることは変えない。書いていないことは安全側で決め、決めたことは全部報告する。
前提：最終確認（`80_WebApp.gs` の `webAppFinalReview`・`finalReviewSheet_`・`finalReviewReconcile_`）と、入金の列（`spec_income_column.md`、顧客マスター AQ＝`columnMapping.L`）。

改訂履歴：
- 1.0（2026-11-15）：初版。利用者の依頼と決定（2026-11-15、§1.1）。

**この仕様書と、実装・テストには、実在の顧客名・顧客 ID・Drive の ID・明細の中身を書かない。**リポジトリは公開である。テストの値はすべて架空にする（例：`K9001`・`架空 太郎_20261115-1000`・`テストカード`）。

---

## 1. 何を作るか

### 1.1 背景（利用者の依頼と決定、2026-11-15）

- **依頼（③）：**転記シートの「取込用」タブを Excel にすると、空のセルを参照する数式が 0 になる。空の行にも数式が残り、freee のインポートが「データ量」で失敗する。
- 今の「Excel ダウンロード」（`81` の `downloadExcel`）は、転記シートを `export?format=xlsx` で 3 タブとも書き出す。freee のエクセルインポートは **1 枚目のシート**（＝取込用）だけを読む。
- 取込用は freee の振替伝票の 32 列（§2.2）で、2 行目から全部の行が入力用シートを数式で参照する（2〜997 行目＝入力用 5〜1000 行目。998 行目から先は入力用 1008 行目から。入力用 1001〜1007 行目はどこからも参照されない）。Google スプレッドシートでは空の参照は空だが、Excel では 0 になる。
- **利用者の決定（2026-11-15）：**
  1. freee には今のエクセルインポート（振替伝票データ）で取り込む。API は使わない。
  2. 出す前に税区分を確かめる：**名前が freee の名前と違えば出さない。空なら出す**（空の行は freee が勘定科目の税区分を使う）。
  3. **要確認が残っている転記シートからは作らない。最終確認で明細と一致しないときは、注意を出したうえで作れる**（この会話の質問への答え「要確認だけ止める」）。
- **freee のヘルプで確かめたこと（2026-11-15、Orca のブラウザで読んだ）：**
  - 「Excel・販売管理ソフトからデータを取り込む（エクセルインポート）」：複数のシートなら 1 枚目を取り込む／数式を含むならチェックを入れる。一部の数式は非対応で、値に置き換えると通る／振替伝票の必須は発生日・借方勘定科目・貸方勘定科目・借方金額・貸方金額（税額は税額の扱いによる）／日付は YYYY/MM/DD／税区分は「使用」になっている名前。率は名前の末尾に付ける（5%＝なし、8%＝`8%`、軽減 8%＝`8%（軽）`、10%＝`10%`）／経過措置の「（控xx）」のかっこは全角で、半角はエラー／振替伝票は目安 2 万行／**失敗した行だけを取り込み直すときは、成功した行を含めない（含めると重複する）**。
  - 「消費税・税区分の設定を行う」：経過措置の税区分は発生日で決まる。2023-10-01〜2026-09-30＝`課対仕入（控80）10%`・`課対仕入（控80）8%（軽）`、2026-10-01〜2028-09-30＝控70、2028-10-01〜2030-09-30＝控50、2030-10-01〜2031-09-30＝控30。
  - 「税区分の種類と選び方について」：率の無い「課対仕入」は 5% の税区分。不課税の取引は「対象外」（「対外仕入」「対外売上」でもよい）。
  - 「輸入を記帳する」：本体・関税＝`課対輸本`、輸入消費税＝`課対輸税10%`（軽減は `課対輸税8%（軽）`）＋`地消貨割10%`（`地消貨割8%（軽）`）。
  - 文字：`%` は半角（U+0025）、かっこは全角（U+FF08・U+FF09）。

### 1.2 本仕様がすること

1. **新しいファイル `src/46_FreeeExport.gs`**：転記シートの取込用の**計算後の値**を読み、確かめ（§3.2〜§3.8）、通ったときだけ、作業用フォルダに 1 枚だけの一時の Google スプレッドシートを作って値を書き、読み返して確かめる（§3.10）。古い一時ファイルの後片付け（§3.12）。
2. **Web アプリの入口** `webAppCreateFreeeExport` を `80` に足す（§3.1）。
3. **画面**：最終確認の「Excel ダウンロード」の横に「freee 取込用 Excel を作る」と「ダウンロード」を足す（§4）。ダウンロードは今の Excel ダウンロードと同じ道（Google の `export?format=xlsx`）で、一時ファイルを書き出す。

### 1.3 変えないもの・しないこと

- **転記シートには 1 セルも書かない**（雛形・取込用の数式・入力用シートとも）。読むだけ。
- 今の「Excel ダウンロード」（`downloadExcel`）。そのまま残す（中身の確認用）。
- `webAppFinalReview`・`finalReviewSheet_`・`finalReviewReconcile_`・`signedDestinationAmount_`・`webAppValidateDestination_` は**使うだけ**で、1 文字も変えない。
- 入力用シートの B1（貸方科目＝カード名）の自動入力（②）と、相手税区分の自動入力（①）。別の仕様。
- **`97_Ops.gs` は開かない・書かない**（文字列の中に生の NUL バイトがある）。
- 顧客フォルダ・明細フォルダへの書込。一時ファイルは作業用フォルダ（`SETTINGS.PARALLEL_WORK_FOLDER_ID`）にだけ作る。

---

## 2. 言葉と前提

### 2.1 言葉

| 言葉 | 意味 |
|---|---|
| 転記シート | 記帳のたびに雛形から複製されるスプレッドシート（名前 `<顧客名>_yyyyMMdd-HHmm`）。`webAppValidateDestination_` が確かめる |
| 入力用シート | 転記シートの `customer.destinationSheetName` のタブ。見出しの行は `customer.headerRow`、データは `headerRow + 1` 行目から |
| 取込用 | 転記シートの、名前がちょうど `取込用` のタブ（定数 `FREEE_IMPORT_SHEET_NAME_`） |
| 一時ファイル | 本仕様が作業用フォルダに作る、1 枚だけの Google スプレッドシート。これを xlsx で書き出したものを freee に取り込む |
| 空とみなす値 | `undefined`・`null`・`''`・数値の `0`・空白（半角・全角・タブ・改行）だけの文字列 |

### 2.2 取込用の 32 列（1 行目の見出し。この順・この文字でなければ止める）

| 列 | 見出し | 列 | 見出し |
|---|---|---|---|
| A | 日付 | Q | 借方税額 |
| B | 伝票番号 | R | 貸方勘定科目 |
| C | 決算整理仕訳 | S | 貸方科目コード |
| D | 借方勘定科目 | T | 貸方補助科目 |
| E | 借方科目コード | U | 貸方取引先 |
| F | 借方補助科目 | V | 貸方取引先コード |
| G | 借方取引先 | W | 貸方部門 |
| H | 借方取引先コード | X | 貸方品目 |
| I | 借方部門 | Y | 貸方メモタグ |
| J | 借方品目 | Z | 貸方セグメント1 |
| K | 借方メモタグ | AA | 貸方セグメント2 |
| L | 借方セグメント1 | AB | 貸方セグメント3 |
| M | 借方セグメント2 | AC | 貸方金額 |
| N | 借方セグメント3 | AD | 貸方税区分 |
| O | 借方金額 | AE | 貸方税額 |
| P | 借方税区分 | AF | 摘要 |

雛形の数式の意味（参考。実装は数式を読まない）：入力用の L（借方＝入金）・M（貸方＝出金）が両方とも空か 0 なら、勘定科目・取引先・品目・メモタグ・税区分は空。出金の行は 借方＝入力用 D（相手勘定科目）・借方税区分＝入力用 G（相手税区分）・貸方＝入力用 B1（カード名）・貸方税区分＝`対象外`。入金の行は 借方＝B1・借方税区分＝`対象外`・貸方＝入力用 D・貸方税区分＝入力用 G。O＝L が空か 0 なら M、それ以外は L。AC＝M が空か 0 なら L、それ以外は M。A＝入力用 B、AF＝入力用 K。

---

## 3. サーバー（`46`・`80`）

### 3.1 入口（`80`）

```
webAppCreateFreeeExport(customerId, destinationSpreadsheetId, fileIds, options)
```

- `webAppInvoke_` で包む。`webAppAuthorizeCustomer_(customerId, 'WEBAPP:freee取込用')` → `getCustomerById(String(customerId))` → `webAppValidateDestination_(base, destinationSpreadsheetId)` → `customer = Object.assign({}, base, {destinationSpreadsheetId: destinationId})`。ここまでは `webAppFinalReview` と同じ順。**認可と転記先の確かめが通る前に、転記シートを読まない。**
- `fileIds`：配列でなければ `[]`。最終確認と同じく、このセッションで取り込んだファイル。
- `options`：`options && options.acceptUnbalanced === true` のときだけ「不一致を承知した」とみなす。文字列の `"true"`・`1` などは承知していない。
- 本体は `46` の `freeeExportCreate_(customer, destinationId, fileIds, acceptUnbalanced)`。`80` には入口だけを足す。

### 3.2 段 A：前提（外れたらすぐ返す。何も作らない・何も読まない順に）

| コード | 条件 |
|---|---|
| `WORK_FOLDER_MISSING` | `SETTINGS.PARALLEL_WORK_FOLDER_ID` が空（前後の空白を外して） |
| `TEMPLATE_UNSUPPORTED` | `customer.columnMapping.L` が無い（入金の列が無い顧客。取込用は L を参照する） |
| `IMPORT_SHEET_MISSING` | `SpreadsheetApp.openById(destinationId).getSheetByName(FREEE_IMPORT_SHEET_NAME_)` が無い |

続いて §3.3 の読取のあと：

| コード | 条件 |
|---|---|
| `HEADER_MISMATCH` | 取込用 1 行目の A〜AF が §2.2 と 1 つでも違う（`String(値)` で完全一致。無いセルは `''`）。最初に違った `{column, expected, actual}` を返す |

### 3.3 読取（転記シートを読むのは 1 回だけ）

`sheetsBatchGetPaced_(destinationId, {ranges: [R1, R2, R3], valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER', majorDimension: 'ROWS'})` を 1 回。429・500・503 は `destinationRangeValues_`（`45`）と同じく 3 回まで待って再試行し、読取クォータのエラーは `noteSheetsQuotaExceeded_()` を呼ぶ（`46` の中に同じ形の小さな関数を作ってよい。`45` は変えない）。

- R1 ＝ `'取込用'!A1:AF`
- R2 ＝ `<入力用>!B1`（カード名）
- R3 ＝ `<入力用>!A{headerRow + 1}:{columnLetter_(rowScanLastColumn)}`

シート名は `quoteSheetName_` で囲む。返ってこない行・セルは `''` とみなす。取引ログ・処理ログの読取は §3.8 の `finalReviewReconcile_` の中のものだけ。

### 3.4 行の分け方（取込用の 2 行目から）

- 32 セルが全部「空とみなす値」の行は**空の行**として飛ばす。
- それ以外は**データ行**（取込用の行番号 `importRow` を覚える）。上から順に並べる。

### 3.5 行ごとの確かめ（データ行。1 行に問題がいくつあっても全部記録する）

| 種類 | 条件 |
|---|---|
| `FORMULA_ERROR` | どれかのセルが、前後の空白を外して `#NULL!`・`#DIV/0!`・`#VALUE!`・`#REF!`・`#NAME?`・`#NUM!`・`#N/A`・`#ERROR!` のどれかと同じ文字列（列ごとに 1 件） |
| `DATE_INVALID` | A が数値でない・整数でない・36526（2000-01-01）〜73050（2099-12-31）の外 |
| `AMOUNT_INVALID` | O・AC のどちらかが、数値でない・安全な整数でない・0・絶対値が 999,999,999,999 より大きい（列ごとに 1 件） |
| `DEBIT_CREDIT_MISMATCH` | O と AC がどちらも正しい金額で、O !== AC（入力用の 1 行に借方と貸方の両方がある） |
| `ACCOUNT_EMPTY` | D（借方勘定科目）・R（貸方勘定科目）のどちらかが空とみなす値（列ごとに 1 件） |
| `TAX_NAME_UNKNOWN` | P・AD のどちらかが、空とみなす値でなく、文字列でないか §3.6 の一覧に**完全一致**で無い（列ごとに 1 件。`hint` を付ける） |
| `TAX_DATE_MISMATCH` | P・AD が一覧にあり、その名前に期間があり、A が正しい日付で期間の外（列ごとに 1 件） |
| `TAX_AMOUNT_INVALID` | Q・AE のどちらかが、空とみなす値でなく、有限の数値でない（列ごとに 1 件） |

記録の形：`{importRow, kind, column, value, hint, date, amount, description}`。

- `column`：列の文字（`D`・`P` など）。
- `value`：`TAX_NAME_UNKNOWN`・`TAX_DATE_MISMATCH`・`FORMULA_ERROR` だけ、そのセルの値（文字列にして 40 文字まで）。それ以外は `null`。
- `date`：A が正しい日付なら `yyyy/MM/dd`、それ以外は `null`。`amount`：O が数値ならその値、それ以外は `null`。`description`：AF が文字列なら 30 文字まで、それ以外は `''`。画面で行を探す手がかりにする。

### 3.6 税区分の一覧（`46` の定数 `FREEE_TAX_CATEGORIES_`。データとして持つ）

`%` は半角、かっこは全角。期間は発生日（A）の両端を含む。

| 名前 | 期間 |
|---|---|
| `対象外`・`対外仕入`・`対外売上`・`非課仕入`・`非課売上` | なし |
| `課対仕入10%`・`課対仕入8%（軽）` | なし |
| `非対仕入10%`・`非対仕入8%（軽）`・`共対仕入10%`・`共対仕入8%（軽）` | なし |
| `課対仕返10%`・`課対仕返8%（軽）` | なし |
| `課税売上10%`・`課税売上8%（軽）`・`課税売返10%`・`課税売返8%（軽）` | なし |
| `課対輸本`・`課対輸税10%`・`課対輸税8%（軽）`・`地消貨割10%`・`地消貨割8%（軽）` | なし |
| `課対仕入（控80）10%`・`課対仕入（控80）8%（軽）` | 2023-10-01〜2026-09-30（45200〜46295） |
| `課対仕入（控70）10%`・`課対仕入（控70）8%（軽）` | 2026-10-01〜2028-09-30（46296〜47026） |
| `課対仕入（控50）10%`・`課対仕入（控50）8%（軽）` | 2028-10-01〜2030-09-30（47027〜47756） |
| `課対仕入（控30）10%`・`課対仕入（控30）8%（軽）` | 2030-10-01〜2031-09-30（47757〜48121） |

（全部で 30。括弧の中の数はシリアル値＝1899-12-30 からの日数。実装では ISO の日付で持ち、UTC で日数にしてよい。）

`TAX_NAME_UNKNOWN` の `hint`（**表示のためだけ。値は直さない**）。上から順に最初に当たったもの、当たらなければ `null`：

1. `{code: 'SPACE', suggestion}`：前後の空白を外すと一覧にある。
2. `{code: 'WIDTH', suggestion}`：`String.prototype.normalize('NFKC')` どうしで一覧のどれかと同じ（例 `課対仕入(控80)10%` → `課対仕入（控80）10%`）。
3. `{code: 'ALIAS', suggestion}`：`不課税` → `対象外`、`課対売上10%` → `課税売上10%`、`課対売上8%（軽）` → `課税売上8%（軽）`（雛形の入力規則にある、freee に無い名前）。
4. `{code: 'RATE_MISSING', suggestions: [名前 + '10%', 名前 + '8%（軽）']}`：`名前 + '10%'` が一覧にある（例 `課対仕入`）。

### 3.7 入力用と取込用の照合

R3 の行ごとに（シートの行番号 `inputRow = headerRow + 1 + 添字`）：`debit = 行[columnMapping.L - 1]`、`credit = 行[columnMapping.M - 1]`。

- 両方とも空とみなす値なら、その行は数えない。
- それ以外は**入力の行**。空とみなす値でない方が有限の数値でなければ `INPUT_AMOUNT_INVALID`（`{inputRow, column}`、最大 30 件と総数）。金額は `debit` が空とみなす値でなければ `debit`、そうでなければ `credit`。
- 入力の行の数 ≠ データ行の数 → `ROW_COUNT_MISMATCH`（`{inputRows, importRows}`）。入力用 1001〜1007 行目の行は取込用に出ないので、ここで止まる。
- `INPUT_AMOUNT_INVALID` も、O の `AMOUNT_INVALID` も無いときだけ：入力の行の金額の合計 ≠ データ行の O の合計 → `AMOUNT_TOTAL_MISMATCH`（`{inputTotal, importTotal}`）。

### 3.8 最終確認の照合（要確認・書き込み途中・別の顧客・不一致）

- R3 の行のうち、`行[columnMapping.txId - 1]` が空とみなす値でない行から `rows` を作る：`{rowNumber: inputRow, txId: String(txId), cells: [], amount}`。`amount` は `signedDestinationAmount_(customer, 行)` が数値ならその値、それ以外は `null`（`finalReviewSheet_` と同じ）。
- `reconciliation = finalReviewReconcile_(customer, rows, fileIds)`。**同じ読取（§3.3）から作るので、取込用・入力用・照合が食い違わない。**
- 行ごとの状態 `reconciliation.statusByTxId[row.txId]`：
  - `REVIEW_REQUIRED` → `REVIEW_REMAINING`（`{count, rowNumbers}`。`rowNumbers` は最大 30）
  - `PREPARED`・`WRITING` → `WRITE_IN_PROGRESS`（同じ形）
- `reconciliation.problems` のうち `kind === 'FOREIGN_CUSTOMER'` → `FOREIGN_CUSTOMER`（`{count, rowNumbers}`）。
- 不一致：`reconciliation.totals.balanced !== true`。

### 3.9 止めたときに返す値（何も作らない）

```
{
  ok: false, created: false,
  stage: 'PRECONDITION' | 'CONTENT' | 'CONFIRM',
  code,                 // stops[0].code
  stops: [{code, ...}], // 下の順
  rowProblems: [...],   // §3.5 の記録。最大 30
  rowProblemCount,      // 総数
  destinationSpreadsheetId
}
```

- `PRECONDITION`：§3.2 の 4 つ。`stops` は 1 つ。
- `CONTENT`：次のうち当たったものを**全部**、この順で（1 回で直す所が全部分かるように）：`CARD_NAME_PLACEHOLDER`（R2 が空とみなす値か、`○`（U+25CB）か `〇`（U+3007）を含む）・`NO_DATA_ROWS`・`ROW_PROBLEMS`（`{count}`）・`INPUT_AMOUNT_INVALID`・`ROW_COUNT_MISMATCH`・`AMOUNT_TOTAL_MISMATCH`・`REVIEW_REMAINING`・`WRITE_IN_PROGRESS`・`FOREIGN_CUSTOMER`。§3.8 は `CONTENT` のほかの止めがあっても行う（全部を 1 回で出すため）。
- `CONFIRM`：`CONTENT` の止めが 1 つも無く、不一致で、`acceptUnbalanced !== true` のとき。`stops = [{code: 'UNBALANCED', problemCount, problemKinds: {MISSING: n, …}, residual}]`。
- `acceptUnbalanced === true` でも `CONTENT` の止め（`FOREIGN_CUSTOMER` を含む）は止める。

### 3.10 一時ファイルを作る・読み返す（止めが無い、または不一致を承知したときだけ）

1. 後片付け（§3.12）。失敗しても続ける。
2. 作る：`Drive.Files.create({name: <転記シートの名前> + '_freee取込', mimeType: 'application/vnd.google-apps.spreadsheet', parents: [作業用フォルダ], appProperties: {ccExportKind: 'FREEE_EXPORT', ccCustomerId: customerId, ccDestinationId: destinationId}}, null, {supportsAllDrives: true})`。転記シートの名前は `DriveApp.getFileById(destinationId).getName()`。**親は作業用フォルダだけ**（顧客フォルダ・マイドライブの直下には作らない）。
3. `Sheets.Spreadsheets.get(id, {fields: 'sheets.properties'})` で、シートがちょうど 1 枚であることを確かめ、その `sheetId` を得る。1 枚でなければ `EXPORT_FILE_UNEXPECTED`。
4. `Sheets.Spreadsheets.batchUpdate` を **1 回**、要求はこの順：
   1. `updateSheetProperties`：`title: '取込用'`、`gridProperties: {rowCount: データ行の数 + 1, columnCount: 32}`（新しいシートは 26 列なので先に広げる）。
   2. `updateCells`：1 行目＝§2.2 の 32 の見出し、2 行目から＝データ行を上から順に。`fields: 'userEnteredValue'`。セルの値は、文字列 → `{stringValue}`、数値 → `{numberValue}`、真偽 → `{boolValue}`、空 → `userEnteredValue` なし。**文字列は文字列のまま書く**（`=` で始まる・日付や数に見える文字列も、式や日付にしない。`USER_ENTERED` や `Range.setValues` は使わない）。
   3. `repeatCell`：A2:A（データ行）に `userEnteredFormat.numberFormat = {type: 'DATE', pattern: 'yyyy/mm/dd'}`。
5. データ行の書く値：A・O・AC は確かめた数値。Q・AE は空とみなす値なら空、それ以外は数値。**ほかの 27 列は、空とみなす値なら空、それ以外は読んだ値そのまま**（Excel の 0 の元を出さない）。
6. 読み返し：`sheetsBatchGetPaced_(id, {ranges: ["'取込用'!A1:AF"], valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER', majorDimension: 'ROWS'})` で、行の数がデータ行＋1、全セルが書いた値と同じ（文字列・数値・真偽は `===`、空は返らないか `''`）。違えば `WRITE_VERIFY_FAILED`（`{row, column}`）。
7. 監査（§3.11）。
8. **2 の後のどこで失敗しても（例外・`EXPORT_FILE_UNEXPECTED`・`WRITE_VERIFY_FAILED`・監査の失敗）、一時ファイルを `Drive.Files.remove(id, {supportsAllDrives: true})` で消してから**、止めの値を返すか例外を投げ直す。消すのに失敗したら `Logger.log` に残す（後片付けが拾う）。

### 3.11 監査（読み返しが通った後）

`appendAudit({type: 'FREEE_EXPORT', actor: activeUserEmail_(), targetType: 'DESTINATION', targetId: destinationId, customerId: customer.customerId, after: {exportFileId, rows, total, emptyTaxRows, unbalancedAccepted, problemCount}, reason: 'FREEE_EXPORT'})`。

- `total`：O の合計。`emptyTaxRows`：P か AD が空のデータ行の数。`problemCount`：`reconciliation.problems.length`。
- 店名・摘要・取引先などの中身は監査に書かない。

### 3.12 後片付け（古い一時ファイル）

- `Drive.Files.list({q: "'<作業用フォルダ>' in parents and trashed = false and appProperties has { key='ccExportKind' and value='FREEE_EXPORT' }", fields: 'nextPageToken, files(id, mimeType, createdTime, parents, appProperties)', pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true})`。5 ページまで。
- **次を全部満たすものだけ**消す（`q` だけに頼らず、コードでも確かめる）：`appProperties.ccExportKind === 'FREEE_EXPORT'`・`mimeType` がスプレッドシート・`parents` に作業用フォルダがある・`createdTime` が読めて、今より 60 分以上前。1 回に 20 件まで。
- `Drive.Files.remove(id, {supportsAllDrives: true})`。一覧・削除の失敗は `Logger.log` に残して続ける（freee 取込用を作るのを止めない）。

### 3.13 できたときに返す値

```
{
  ok: true, created: true,
  exportSpreadsheetId, fileName,   // fileName = 一時ファイルの名前 + '.xlsx'
  rows, total, emptyTaxRows,
  unbalancedAccepted, problemCount,
  createdAt,                        // ISO 8601
  destinationSpreadsheetId
}
```

---

## 4. 画面（`81`）

### 4.1 置くもの

最終確認の `action-row`（`excel-button` の右）に：

- `freee-button`（`button`）「freee 取込用 Excel を作る」
- `freee-download`（`button`、最初は `hidden`）「ダウンロード」
- `freee-status`（`span`、`excel-status` と同じ見た目）
- その下に説明（`muted`）：「freee の『エクセルインポート』（振替伝票データ）には、ここで作ったファイルを使います。値だけ・データの行だけの 1 枚です。」

新しい要素の id は、要素を集める一覧（`'excel-button', 'excel-status', …` の並び）に足す。

### 4.2 押せるとき

`freee-button` は `excel-button` と同じ条件（転記先が選ばれている・変更中でない・最終確認が今のもの）で、さらに作っている間（`state.freeeBusy`）は押せない。

### 4.3 「freee 取込用 Excel を作る」を押したとき

1. `state.freeeBusy = true`、`freee-status`「freee 取込用を作っています…」、`freee-download` を隠す。要求の番号 `state.freeeRequest` を 1 増やして覚える。
2. `gasCall('webAppCreateFreeeExport', [state.selectedCustomerId, 転記先, state.sessionFileIds.slice(), {acceptUnbalanced: false}])`。
3. 返事が来たとき、要求の番号か転記先が変わっていれば何もしない。
4. `ok: false`・`stage: 'CONFIRM'`：`formatConfirm('freee 取込用 Excel', '最終確認で明細と一致していません（問題 N 件）。\nこのまま作ると、漏れや重複のある内容が freee に入るおそれがあります。\nそれでも作りますか？')`。「実行する」なら同じ引数で `{acceptUnbalanced: true}` にしてもう一度呼ぶ。「戻る」なら `freee-status` を空にして終わる。
5. `ok: false`（それ以外）：`showNotice(本文, 'error', 明細)`。本文と明細は §4.5。`freee-status` は空。
6. `ok: true`：`state.freeeExport = {exportSpreadsheetId, destinationId, createdAtMs: Date.now(), rows}`。`freee-status`「freee 取込用ができました（N 行）。［ダウンロード］を押してください。」＋（`emptyTaxRows > 0` なら）「税区分が空の行が M 行あります（freee が勘定科目の税区分を使います）。」＋（`unbalancedAccepted` なら）「明細と一致しないまま作りました。」。`freee-download` を出す。
7. 最後に `state.freeeBusy = false`、ボタンを更新する。例外は `showNotice(failureMessage(error), 'error')`。

### 4.4 「ダウンロード」を押したとき

- `state.freeeExport` が無い、またはその転記先が今の転記先と違う → ボタンを隠して終わる。
- `Date.now() - createdAtMs > 30 分` → 「作ってから 30 分たちました。もう一度［freee 取込用 Excel を作る］を押してください。」、ボタンを隠し、`state.freeeExport = null`。
- それ以外：**押した処理の中ですぐ** `window.open('https://docs.google.com/spreadsheets/d/' + encodeURIComponent(id) + '/export?format=xlsx', '_blank')`（サーバーの返事を待った後に開くとポップアップが止められるため、作るとダウンロードを 2 段に分ける）。`null` なら `showNotice(TEXT.exportBlocked, 'warning')`。開けたら `freee-status`「freee 取込用 ダウンロード ＋ formatDate(new Date(), true)」。

### 4.5 止めたときの文言（`TEXT` に足す）

| コード | 本文 |
|---|---|
| `WORK_FOLDER_MISSING` | 作業用フォルダが設定されていないため、freee 取込用を作れません。 |
| `TEMPLATE_UNSUPPORTED` | この顧客の転記シートには入金の列の設定が無いため、freee 取込用を作れません。 |
| `IMPORT_SHEET_MISSING` | 転記シートに「取込用」のタブがありません。 |
| `HEADER_MISMATCH` | 「取込用」の 1 行目が freee の形と違います（X 列：「期待」のはずが「実際」）。 |
| `CARD_NAME_PLACEHOLDER` | 入力用シートの B1（カード名）が「○○カード」のままか空です。freee のカードの勘定科目名を入れてください。 |
| `NO_DATA_ROWS` | 取り込む行がありません。 |
| `ROW_PROBLEMS` | 直す必要のある行が N 件あります（下の一覧）。 |
| `INPUT_AMOUNT_INVALID` | 入力用シートの借方・貸方に数として読めない値があります（N 行目…）。 |
| `ROW_COUNT_MISMATCH` | 入力用シートの金額のある行（N 行）と、取込用の行（M 行）の数が合いません。入力用シートの 1001 行目より下にある行は取込用に出ません。 |
| `AMOUNT_TOTAL_MISMATCH` | 入力用シートの金額の合計（¥A）と、取込用の合計（¥B）が合いません。 |
| `REVIEW_REMAINING` | 要確認が N 件残っています（入力用シート …行目）。確定してから作ってください。 |
| `WRITE_IN_PROGRESS` | 書き込みの途中の取引が N 件あります（…行目）。最終確認を開き直してから作ってください。 |
| `FOREIGN_CUSTOMER` | 別の顧客の取引が N 件入っています（…行目）。この転記シートからは作れません。 |
| `EXPORT_FILE_UNEXPECTED`・`WRITE_VERIFY_FAILED` | freee 取込用を正しく作れませんでした。もう一度押してください。 |

`stops` が複数あれば本文を改行でつなぐ。`ROW_PROBLEMS` の明細は 1 行ずつ：

「取込用 N 行目（日付・¥金額・摘要）：」＋種類の文言。

| 種類 | 文言 |
|---|---|
| `FORMULA_ERROR` | X 列が数式のエラー（値）です |
| `DATE_INVALID` | 日付が日付になっていません |
| `AMOUNT_INVALID` | X 列の金額が正しくありません（0・小数・文字など） |
| `DEBIT_CREDIT_MISMATCH` | 借方と貸方の金額が違います（入力用シートの 1 行に借方と貸方の両方があります） |
| `ACCOUNT_EMPTY` | X 列の勘定科目が空です |
| `TAX_NAME_UNKNOWN` | 税区分「値」は freee にありません。＋ hint：`SPACE`「前後に空白があります」／`WIDTH`「全角・半角が違います。正しくは「…」」／`ALIAS`「freee では「…」です」／`RATE_MISSING`「率がありません（率の無い名前は 5% の税区分です）。「…10%」か「…8%（軽）」にしてください」 |
| `TAX_DATE_MISMATCH` | 税区分「値」はこの日付では使えません（経過措置の控除割合は日付で決まります） |
| `TAX_AMOUNT_INVALID` | X 列の税額が数ではありません |

`rowProblemCount > 30` なら「ほか N 件」を最後に足す。

### 4.6 取り消すとき

最終確認が古くなったとき（`forgetFinalReview`・`markFinalReviewStale`）、転記先を選び直したとき（`chooseDestination`）、`excel-status` を空にしている所（顧客の切り替えなど）すべてで：`state.freeeExport = null`、`state.freeeRequest += 1`、`freee-download` を隠し、`freee-status` を空にする。

---

## 5. 安全の条件（テストで確かめる）

- S1 止めたとき（§3.9）は、Drive に何も作らない（`Drive.Files.create` 0 回）・どのスプレッドシートにも書かない・監査を書かない。
- S2 **転記シート（取込用・入力用・ほかのタブ）には、どの場合も 1 セルも書かない。**転記シートの読取は `Values.batchGet` 1 回。
- S3 一時ファイルの中身は、見出し＋データ行（取込用の順）だけで、§3.10 の 5 の値と同じ。読み返しで違えば消して `WRITE_VERIFY_FAILED`。
- S4 文字列は文字列のまま（`=1+1`・`2026/01/02`・`001`・`1/2` が、式・日付・数にならない）。
- S5 要確認（`REVIEW_REQUIRED`）・書き込み途中（`PREPARED`・`WRITING`）・別の顧客の取引が 1 行でもあれば作らない。`acceptUnbalanced` でも作らない。
- S6 不一致は `acceptUnbalanced === true` のときだけ作る（`"true"`・`1` では作らない）。
- S7 税区分：一覧に無い名前は止める・空は通す・控xx は期間の外なら止める。値は直さない。
- S8 一時ファイルは作業用フォルダにだけ作る。作った後に失敗したら消す。
- S9 後片付けは、作業用フォルダの・`ccExportKind = FREEE_EXPORT` の・スプレッドシートの・60 分以上前のものだけを消す。後片付けの失敗で作るのを止めない。
- S10 監査は読み返しの後。監査に失敗したら一時ファイルを消して失敗を返す。
- S11 認可と転記先の確かめが通らなければ、転記シートを読まない・何も作らない。
- S12 画面：不一致は利用者が「実行する」を押したときだけ `acceptUnbalanced: true` で呼ぶ。最終確認が古くなったら、作ったファイルのダウンロードを出さない。

---

## 6. テスト

### 6.1 サーバー（`fx N: …`、新しいファイル `test/freee-export.test.js`。値は全部架空）

組み立て：転記先（`架空 太郎_20261115-1000` など）に `取込用`（§2.2 の見出し＋計算後の値をそのまま置く）・入力用シート（`headerRow` まで＋データ。L・M・txId の列は顧客マスターの対応のとおり）を置く。取引ログ・処理ログは `phase8-webapp.test.js` の最終確認のテストと同じ組み立てを使ってよい。作業用フォルダを設定する。

1. 正常：出金 2 行（税区分 `課対仕入10%` と空）・入金 1 行（借方税区分 `対象外`・貸方税区分 `課対仕入10%`）、その間と後に空の行（`''` だけの行・0 だけの行）。→ `ok`・一時ファイルが作業用フォルダに 1 つ（`appProperties`・名前 `…_freee取込`・返す `fileName` は `.xlsx` 付き）・シート 1 枚 `取込用`・4 行×32 列・値が見出し＋3 行（順も）・A2:A に日付の形式の要求・`emptyTaxRows` 1・監査 1 件（`FREEE_EXPORT`、読み返しの後）・転記シートは前後で全く同じ（S2）。
2. 文字列のまま：摘要 `=1+1`・`2026/01/02`・`001`、品目 `1/2` → 一時ファイルで同じ文字列（S4）。
3. 0 と空白：データ行の 品目（J）が 0・メモタグ（K）が全角空白 → 一時ファイルでは空。0 だけの行・空白だけの行は飛ばす。
4. 前提の止め：`WORK_FOLDER_MISSING`・`TEMPLATE_UNSUPPORTED`・`IMPORT_SHEET_MISSING`・`HEADER_MISMATCH`（見出し 1 つを変える。返す `column`・`expected`・`actual`）→ `stage: 'PRECONDITION'`・作らない・書かない・監査なし（S1）。`HEADER_MISMATCH` 以外は転記シートの `Values.batchGet` も 0 回。
5. B1：`○○カード`・`〇〇カード`・空 → `CARD_NAME_PLACEHOLDER`。`テストカード` は通る。
6. 行の問題を 1 つずつ：`FORMULA_ERROR`（D に `#N/A`）・`DATE_INVALID`（A が文字列 `2026/11/03`・46329.5・100）・`AMOUNT_INVALID`（O と AC が 0 で摘要だけある行・1.5・文字列 `1,200`・1e13）・`DEBIT_CREDIT_MISMATCH`（O 100・AC 200）・`ACCOUNT_EMPTY`（D が空）・`TAX_AMOUNT_INVALID`（Q が `abc`）→ それぞれ `ROW_PROBLEMS`、`rowProblems` の `importRow`・`kind`・`column` が正しい、作らない。
7. 税区分の名前：一覧の 30 の名前が全部通る（控xx は期間の中の日付で）。止まる：`不課税`（`ALIAS` → `対象外`）・`課対売上10%`（`ALIAS` → `課税売上10%`）・`課対仕入`（`RATE_MISSING`）・`課対仕入(控80)10%`（`WIDTH` → `課対仕入（控80）10%`）・` 課対仕入10%`（`SPACE`）・`課対仕入8%`（`hint: null`）・数値の 10（`hint: null`）。
8. 税区分が空（P・AD とも空）の行は通る（S7）。
9. 期間の境目：控80 は 45199 で止まり 45200・46295 で通り 46296 で止まる。控70 は 46295 で止まり 46296・47026 で通り 47027 で止まる。控50 は 47027・47756 で通り 47757 で止まる。控30 は 47757・48121 で通り 48122 で止まる（`TAX_DATE_MISMATCH`）。
10. `ROW_COUNT_MISMATCH`：入力用の 1004 行目に金額があるが取込用に無い → 止まり、`inputRows`・`importRows` を返す。
11. `AMOUNT_TOTAL_MISMATCH`：行の数は同じで、取込用の O と AC が入力用の金額と違う → 止まる。
12. `INPUT_AMOUNT_INVALID`：入力用の M が `abc` → 止まる（`inputRow`・`column`）。
13. `NO_DATA_ROWS`：取込用が全部空、入力用にも金額なし → 止まる。
14. `REVIEW_REMAINING`：1 行の取引が `REVIEW_REQUIRED` → 止まる（`count`・`rowNumbers`）。同じ表で `COMMITTED` なら作る（S5）。
15. `WRITE_IN_PROGRESS`：`PREPARED`・`WRITING` のそれぞれで止まる。
16. `FOREIGN_CUSTOMER`：別の顧客の取引の行 → `acceptUnbalanced: true` でも止まる（S5）。
17. 不一致：ログにあってシートに無い取引（`MISSING`）→ 承知なしは `stage: 'CONFIRM'`・`UNBALANCED`・作らない。`acceptUnbalanced: true` で作る（`unbalancedAccepted: true`・監査にも）。`"true"`・`1` では作らない（S6）。
18. 止めをまとめて返す：B1 が `○○カード`＋税区分 `不課税`＋要確認 1 件 → `stops` が `CARD_NAME_PLACEHOLDER`・`ROW_PROBLEMS`・`REVIEW_REMAINING` の順。
19. `rowProblems` は 30 件まで、`rowProblemCount` は総数（35 行が悪い表）。
20. 読み返しの食い違い（スタブで一時ファイルの 1 セルを書き換える切り替え）→ `WRITE_VERIFY_FAILED`・一時ファイルは消えている・監査なし（S3・S10）。
21. 監査が投げる → 一時ファイルは消えている・例外が出る（S10）。
22. 作った後の `batchUpdate` が投げる → 一時ファイルは消えている・例外が出る（S8）。
23. 後片付け：作業用フォルダに (a) 61 分前の freee 取込用 → 消える、(b) 59 分前の freee 取込用 → 残る、(c) 61 分前で `appProperties` の無いスプレッドシート → 残る、(d) 61 分前の `tmp_import_…` → 残る、(e) 61 分前で `ccExportKind` が違う → 残る、(f) 61 分前の freee 取込用だがスプレッドシートでない → 残る。一覧が投げても・削除が投げても、作るのは成功する（S9）。
24. 認可：認可されない顧客・転記先の確かめが通らない（雛形の ID・名前の規則に合わない）→ 例外、転記シートの `Values.batchGet` 0 回、作らない（S11）。
25. 読取の回数：成功のとき、転記シートへの `Values.batchGet` はちょうど 1 回（範囲 3 つ）、転記シートへの書込は 0 回（S2）。
26. 置き場：一時ファイルの親は作業用フォルダだけ（転記シートのフォルダ・顧客フォルダではない）（S8）。

### 6.2 画面（`fxu N: …`、新しいファイル `test/freee-export-ui.test.js`。`kw26-ui-helpers.js` の `browserWorld` を使う）

1. 最終確認を開くまで `freee-button` は押せない。開いた後は押せる。作っている間は押せない。
2. 押す → `webAppCreateFreeeExport` が `[顧客, 転記先, sessionFileIds, {acceptUnbalanced: false}]` で呼ばれる。`ok` で状態の文言と「ダウンロード」が出る。「ダウンロード」→ `window.open` が一時ファイルの `export?format=xlsx` で呼ばれ、文言が変わる。
3. `CONFIRM` → 確かめの画面が出る。「戻る」→ 2 回目の呼出しなし。「実行する」→ 2 回目が `{acceptUnbalanced: true}`（S12）。
4. 止め → お知らせに本文と行の明細（「取込用 N 行目」・hint の文言を含む）。「ダウンロード」は出ない。
5. 返事の前に転記先を選び直した → 返事を捨てる（「ダウンロード」は出ない）。
6. 作った後に最終確認が古くなる・転記先を選び直す → 「ダウンロード」が消え、文言が空（S12）。
7. 30 分を過ぎて「ダウンロード」→ `window.open` を呼ばず、作り直しの文言（時計は `browserWorld` の `now` で進める）。
8. `window.open` が `null` → `exportBlocked` のお知らせ。
9. 今の「Excel ダウンロード」は今までどおり転記シートの `export?format=xlsx` を開く。

---

## 7. 変異（入れて回し、赤になるテストを記録して戻す）

| # | 入れる変異 | 赤になるはずのテスト |
|---|---|---|
| R1 | 税区分の名前を確かめない | fx 7 |
| R2 | 空の税区分も止める | fx 1・fx 8 |
| R3 | 控xx の期間を見ない | fx 9 |
| R4 | 期間の終わりを含めない（`<=` を `<`） | fx 9 |
| R5 | `REVIEW_REQUIRED` で止めない | fx 14 |
| R6 | `acceptUnbalanced` を真偽で緩く見る（`if (options.acceptUnbalanced)`） | fx 17 |
| R7 | `FOREIGN_CUSTOMER` を不一致と同じ扱いにする（承知で作れる） | fx 16 |
| R8 | `=` で始まる文字列を `formulaValue` で書く | fx 2 |
| R9 | 読み返しをしない | fx 20 |
| R10 | 失敗したときに一時ファイルを消さない | fx 20・fx 21・fx 22 |
| R11 | 後片付けで作った時刻を見ない | fx 23 |
| R12 | 後片付けで `appProperties` を見ない | fx 23 |
| R13 | 一時ファイルを転記シートと同じフォルダに作る | fx 26 |
| R14 | 入力用と取込用の行数を比べない | fx 10 |
| R15 | 文字の列の 0 をそのまま書く | fx 3 |
| R16 | 監査を読み返しの前に書く | fx 20 |
| R17 | B1 を確かめない | fx 5 |
| R18 | 見出しを確かめない | fx 4 |
| R19 | 画面：確かめずに `acceptUnbalanced: true` で呼び直す | fxu 3 |
| R20 | 画面：最終確認が古くなってもダウンロードを残す | fxu 6 |
| R21 | `ROW_PROBLEMS` があると §3.8 を飛ばす（まとめて返さない） | fx 18 |

---

## 8. 変えてよいファイル

- 新しいファイル `src/46_FreeeExport.gs`
- `src/80_WebApp.gs`（`webAppCreateFreeeExport` を足すだけ。既存の関数は変えない）
- `src/81_WebAppUi.html`（§4。今の `downloadExcel` の動きは変えない）
- `test/gas-stubs.js`（足りないものを**足すだけ**。既存の振る舞いは変えない。例：`Drive.Files.create`・一覧の `appProperties`・`createdTime`・`parents`、`remove` の引数、`Sheets.Spreadsheets.get` の `sheetId`、`batchUpdate` の `updateSheetProperties`・`updateCells`・`repeatCell`、読み返しを崩す切り替え）
- `test/kw26-ui-helpers.js`（足りないものを**足すだけ**）
- 新しいテストファイル `test/freee-export.test.js`・`test/freee-export-ui.test.js`

変えないもの：上に無いファイル全部。特に `97_Ops.gs`（開かない）・`45`・`43`・`02`・`90`。既存のテストを消す・弱める・飛ばすことはしない。

---

## 9. 本番での手順（Claude）

1. 実装 → 差分を読む・監査 → main へ取り込み → main で全テスト → 利用者の許可を得て `clasp push`（`gas-push-N`）。
2. 利用者の受入：転記シートの入力用 B1 に freee のカードの勘定科目名を入れる（② ができるまでは手で）→ 最終確認 → ［freee 取込用 Excel を作る］→［ダウンロード］→ freee の［取引入力］→［エクセルインポート］→「振替伝票データ」。数式は含まないので「ファイルに数式を含む」のチェックは要らない。列の対応は前に取り込んだときと同じ見出しなので、前の設定が使われるはず（freee のヘルプ「過去に同じ…インポートされている場合、そのときと同じ内容で」）。
3. 確かめること：freee の取り込みの結果（行の数・エラーの有無）、作業用フォルダに一時ファイルが残り、次に作ったとき 60 分より前のものが消えること。

---

## 10. Claude の判断の記録（利用者の決定ではないもの）

1. **xlsx を自分で組み立てず、一時の Google スプレッドシートを Google に書き出させる。**今の Excel ダウンロードと同じ書き出しの道で、freee が読めることは今の運用で分かっている。外への要求の権限（`script.external_request`）も足さずに済む。
2. **作るとダウンロードを 2 段に分ける。**サーバーの返事を待ってから `window.open` すると、利用者の操作の外になりポップアップが止められる。
3. 一時ファイルは作業用フォルダに作り、次に作るときに 60 分より前のものを消す。画面のダウンロードは 30 分で使えなくする（消える前に止める）。
4. 税区分の一覧は 30 の名前（仕入側が中心）。ヘルプで名前そのものを見たのは：`課対仕入10%`・`課対仕入（控80〜30）10%／8%（軽）`・`課税売上10%／8%（軽）`・`課対輸本`・`課対輸税10%／8%（軽）`・`地消貨割10%／8%（軽）`・`対象外`・`対外仕入`・`対外売上`・`非課仕入`・`非課売上`。`非対仕入`・`共対仕入`・`課対仕返`・`課税売返` の率つきは、ヘルプの「率は名前の末尾に付ける」から作った。簡易課税の `課売上一〜六` などカード明細で使わない名前は入れていない（出てきたら止まるので、そのとき足す）。率の無い `課対仕入`（5%）と `課対仕入8%`（軽減でない 8%）は止める（利用者 11-15「G には必ず 10%・8%（軽）を付ける」）。
5. 依頼の「名前が違えば出さない」に、**控xx と日付の照合**を足した（名前が正しくても、日付の控除割合と違えば税額が違う）。
6. freee が受け付けない行を先に止める：勘定科目が空・日付・金額（0・小数・範囲外）・借方と貸方の金額違い・数式のエラー・税額が数でない。
7. 利用者の決定は「要確認だけ止める（不一致は注意を出して作れる）」。そのうえで、**別の顧客の取引（`FOREIGN_CUSTOMER`）と書き込みの途中（`PREPARED`・`WRITING`）は作らない**ことにした。前者は顧客の境目を越えて別の顧客のデータが freee に入る。後者は行の中身がそろっていない。
8. 入力用と取込用の行の数・金額の合計を照合する（取込用は入力用の 1001〜1007 行目を見ていない。数式が崩れた雛形も見つける）。
9. 空とみなす値（0・空白だけ）は、文字の列では空にして出す（Excel の 0 の問題の元）。金額と日付は確かめた値だけを出す。
10. 今の「Excel ダウンロード」は残す（中身の確認用）。
11. 雛形の数式は直さない（計算後の値を読むので要らない）。ただし雛形の相手税区分の入力規則に freee に無い名前（`不課税`・`課対売上10%`・`課対売上8%（軽）`）がある。使った行は止まる。入力規則を直すかは ① で決める。
12. 転記シートを読むのは 1 回の `batchGet` だけで、照合もその値から作る（取込用・入力用・照合が食い違わない）。ロックは取らない（読むだけで、書くのは自分の一時ファイルだけ）。
13. freee 側の二重の取り込み（同じファイルを 2 回取り込む）はこの仕組みでは防げない。監査に作った記録が残る。

## 11. 実装と監査の記録

（実装の後に書く）

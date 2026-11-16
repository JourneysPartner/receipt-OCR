# 入力用シートの B1（freee のカード名）を、勘定科目 CSV とカードフォルダの対応から自動で入れる 仕様書

作成日：2026-11-16
版：1.0
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いてあることは変えない。書いていないことは安全側で決め、決めたことは全部報告する。
前提：freee 取込用 Excel（`spec_freee_export.md` 1.1、`src/46_FreeeExport.gs`）・顧客登録（`spec_customer_registration.md`、`src/59_CustomerRegistration.gs`）・転記シートの複製（`src/80_WebApp.gs` の `webAppCloneDestination_`）。

改訂履歴：
- 1.0（2026-11-16）：初版。利用者の依頼と決定（2026-11-15・16、§1.1）。

**この仕様書と、実装・テストには、実在の顧客名・顧客 ID・Drive の ID・カード名・勘定科目 CSV の中身を書かない。**リポジトリは公開である。テストの値はすべて架空にする（例：`K9001`・`架空 太郎`・`テストカード`・`架空カードA`）。

---

## 1. 何を作るか

### 1.1 背景（利用者の依頼と決定）

- **依頼（2026-11-15、②）：**転記シートの入力用シートの B1（貸方科目＝カード名。雛形では `○○カード`）を自動で入れたい。取込用タブの D（借方勘定科目）・R（貸方勘定科目）が B1 を参照し、freee のエクセルインポートでは、ここがそのまま freee の勘定科目名になる。
- 今は利用者が手で入れている。入れ忘れると、freee 取込用 Excel（③）が `CARD_NAME_PLACEHOLDER` で止まる。
- **利用者の決定：**
  1. （11-15）freee API は使わない。**freee の勘定科目 CSV**（freee の［設定］→［勘定科目］→ エクスポート）で確かめる。CSV は画面からアップロードして登録し、後から差し替えられるようにする。
  2. （11-15）カードフォルダと freee のカード名の対応は、**年をまたいでもカードフォルダの名前で引き継ぐ**（顧客マスターの D は年度ごとに付け替えるが、カードフォルダの名前は同じ）。
  3. （11-15）**顧客の CSV はカード名のためだけに使う**（相手税区分〔①〕には使わない。別の仕様）。
  4. （11-16）画面は「設定」に**別の欄「freee のカード名」**を作る。登録済みの顧客なら、いつでも CSV の登録・差し替えと対応づけができる。顧客登録が終わった画面に「続けて freee のカード名を設定」のボタンを出す。**顧客登録の処理（`registerCustomer_`）には手を入れない。**
  5. （11-16）**対応づけの無いカードフォルダでも記帳は進める。**B1 は `○○カード` のまま、記帳の終わりに「freee のカード名が未設定」と知らせる（freee 取込用は今どおり B1 の確かめで止まる）。
  6. （11-16）**作成済みの転記シートの B1 は、利用者が手で直す。**自動で入れるのは、これから複製する転記シートだけ（転記シートへ書く道を増やさない）。
- **実物で確かめたこと（2026-11-15、顧客の CSV。中身はここに写さない）：**Shift_JIS・BOM なし・LF・12 列（勘定科目,表示名（決算書）,小分類,中分類,大分類,収入取引相手方勘定科目,支出取引相手方勘定科目,税区分,ショートカット1,ショートカット2,入力候補,補助科目優先タグ）。freee のヘルプの見本は UTF-8（BOM 付き）で、`入力候補` の代わりに `検索での表示`、最後に `勘定科目コード` がある 13 列。→ **列は見出しの名前で探す。UTF-8（BOM）と Shift_JIS の両方を受ける。**
  - カードは、表示名（決算書）が `未払金` の行に、勘定科目名＝カードの名前で並ぶ。同じ表示名の行に、カードでない科目（未払金そのものなど）もある。→ 候補は「表示名（決算書）＝未払金」の行にして、**どのカードフォルダにどれを当てるかは人が選ぶ**。

### 1.2 本仕様がすること

1. **新しいファイル `src/47_FreeeCardNames.gs`**：
   - 表「freeeカード科目」（マスターのスプレッドシートの新しいタブ。1 顧客 1 行）の読み書き（§2.3・§3.2）。
   - 勘定科目 CSV の読み取り（§3.3）。
   - Web アプリの 3 つの入口の本体（§3.4〜§3.6）。
   - 複製した転記シートの B1 に書く処理（§3.7）。
2. **`src/80_WebApp.gs`**：3 つの入口（§3.1）、`webAppCloneDestination_` から B1 を書く（§3.7）、記帳の結果に `cardName` を足す（§3.8）、`WEBAPP_IMPORT_BASE_TRIPS_` を 3 増やす（§3.9）。
3. **`src/46_FreeeExport.gs`**：CSV を登録した顧客では、B1 が CSV の勘定科目に無ければ止める（§3.10）。
4. **画面 `src/81_WebAppUi.html`**：「設定」に「freee のカード名」の欄（§4.1〜§4.6）、登録完了の後のボタン（§4.7）、記帳の終わりの知らせ（§4.8）、freee 取込用の止めの文言（§4.9）。

### 1.3 変えないもの・しないこと

- **顧客マスター（45 列）の形と読み方**（`02`・`CUSTOMER_MASTER_COLUMNS_`）。対応は別の表に持つ。
- **顧客登録の処理**（`59` の `registerCustomer_` など）。`59` は開いて読むのはよいが、変えない。
- **作成済みの転記シート**。B1 に書くのは、`webAppCloneDestination_` が今作った複製だけ。雛形（`customer.destinationSpreadsheetId`）には書かない。
- 転記シートの B1 以外のセル（複製の処理で今空にしている列は今のまま）。
- 記帳を止める条件（B1 が書けなくても、対応が無くても、記帳は今どおり進む）。
- freee 取込用の今の止め（`CARD_NAME_PLACEHOLDER` を含む）と、その文言。
- 相手税区分（①）。CSV の税区分の列は読まない・持たない。
- **`src/97_Ops.gs` は開かない・書かない**（文字列の中に生の NUL バイトがある）。
- `CONFIG.REQUIRED_SHEET_KEYS`・`MASTER_SHEET_SPECS_`（`04`）に新しいタブを足さない（足すと、本番でタブを作る前に設定検査が落ちる）。タブは最初の保存のときに作る（§3.2）。

---

## 2. 言葉と前提

### 2.1 言葉

| 言葉 | 意味 |
|---|---|
| 勘定科目 CSV | freee の［設定］→［勘定科目］→ エクスポートで書き出す CSV。顧客ごと |
| カードフォルダ | 顧客マスター D（`customer.sourceFolderId`、明細フォルダ）の**直下**のフォルダ。画面の「1. 顧客選定」で選ぶもの。記帳は 1 押下で 1 カードフォルダ |
| カードの候補 | 勘定科目 CSV のうち、表示名（決算書）が `未払金` の行の勘定科目名（CSV の順） |
| 対応 | カードフォルダの名前 → freee の勘定科目名（カードの候補の 1 つ） |
| フォルダの鍵 | カードフォルダの名前の前後の空白（全角を含む。`String.prototype.trim`）を外したもの。対応の鍵はこれ |
| 照合の鍵 | 名前を NFKC にし、空白（`\s` と全角空白）を全部外し、英字を小文字にしたもの。「同じ名前の候補」を探すときだけ使う（§3.4） |
| 版 | 表の行の整数。保存のたびに 1 増える。画面は読んだときの版を送り、違えば保存しない（`STALE`） |

### 2.2 B1 の位置

- 入力用シート（`customer.destinationSheetName` のタブ）の **B1**（定数 `FREEE_CARD_NAME_CELL_ = 'B1'`）。全顧客の雛形は同じ（`spec_customer_registration.md` §1.1）。
- `customer.headerRow` が 2 より小さい顧客では、B1 が見出しかデータの行になるので書かない（§3.7 の `TEMPLATE_UNSUPPORTED`）。

### 2.3 表「freeeカード科目」（マスターのスプレッドシートの新しいタブ）

- タブの名前は定数 `FREEE_CARD_NAMES_SHEET_NAME_ = 'freeeカード科目'`（`47` に置く。`00` の `CONFIG.SHEET_NAMES` には足さない）。
- 1 行目は見出し（この 11 個・この順・この文字）。2 行目から 1 顧客 1 行。

| 列 | 見出し | 中身 |
|---|---|---|
| A | 顧客ID | 顧客 ID（文字列） |
| B | 勘定科目 | CSV の勘定科目名の配列の JSON（CSV の順・重なりなし・空なし） |
| C | カード候補 | カードの候補の配列の JSON（B の部分集合・CSV の順） |
| D | 対応 | `{"<フォルダの鍵>": "<勘定科目名>"}` の JSON。無ければ `{}` |
| E | CSVファイル名 | 利用者が選んだファイルの名前（§3.5 の 2） |
| F | CSVのSHA-256 | CSV のバイト列の SHA-256（16 進の小文字 64 文字。`sha256Hex`） |
| G | CSV登録日時 | ISO 8601（`toIso8601(new Date())`） |
| H | CSV登録者 | 実行者のメール（`authorizeOwner(...).userEmail`） |
| I | 対応更新日時 | ISO 8601。対応をまだ保存していなければ空 |
| J | 対応更新者 | メール。まだなら空 |
| K | 版 | 1 以上の整数 |

**行の読み方 `freeeCardNamesParseRow_(values, rowNumber)`**（1 つでも外れたら `FREEE_CARD_TABLE_INVALID` の例外。どの行・どの列かを `detail` に）：
- A が空でない（前後の空白を外して）。
- B が JSON の配列で、要素が全部「前後の空白の無い・空でない・改行やタブなどの制御文字（U+0000〜U+001F・U+007F）を含まない文字列」で、重なりが無い。
- C が JSON の配列で、要素が全部 B にある・重なりが無い。
- D が空か JSON のオブジェクト（配列でない）で、鍵が全部空でない・前後の空白の無い文字列、値が全部文字列（C に無くてもよい。CSV の差し替えで外れたもの＝§3.7 の `NOT_IN_CSV`）。
- K が 1 以上の整数（数値か、数字だけの文字列）。
- 返す値：`{rowNumber, customerId, accountNames, candidates, mappings, csvFileName, csvSha256, csvUploadedAt, csvUploadedBy, mappingUpdatedAt, mappingUpdatedBy, version}`。

**顧客の行を引く `freeeCardNamesRowFor_(customerId)`**：
- タブが無い → `null`（読取 0 回）。
- `readSheetRows_(sheet, 11)` で 1 回読み、A が `customerId` と同じ行（前後の空白を外して完全一致）を探す。0 行 → `null`。**2 行以上 → `FREEE_CARD_TABLE_INVALID`**（どちらが正しいか決めない）。その 1 行を `freeeCardNamesParseRow_` で読む（読めなければ例外）。
- 1 行目（見出し）が §2.3 の 11 個と違えば `FREEE_CARD_TABLE_INVALID`（`readSheetRows_` とは別に、同じ 1 回の読取の中で確かめてよい。読取を 2 回にしない。方法は実装者が決めて報告する）。

---

## 3. サーバー

### 3.1 入口（`80`。中身は `47`）

```
webAppFreeeCardNamesStart(customerId)
webAppFreeeCardNamesUploadCsv(customerId, fileName, base64, expectedVersion)
webAppFreeeCardNamesSave(customerId, changes, expectedVersion)
```

- 3 つとも `webAppInvoke_` で包み、**最初に `authorizeOwner('WEBAPP:freeeカード名')`**。通らなければ、Drive も表も読まない・何も書かない（拒否の監査は `authorizeOwner` の今のとおり）。
- 続いて `loadSettingsFromProperties()`、`customer = getCustomerById(String(customerId))`。見つからなければ今の `getCustomerById` の例外のまま。`customer.isActive !== true` なら `{ok: false, code: 'CUSTOMER_INACTIVE'}`（それ以上読まない）。
- `80` には入口だけを足し、本体は `47` の `freeeCardNamesStart_(auth, customer)`・`freeeCardNamesUploadCsv_(auth, customer, fileName, base64, expectedVersion)`・`freeeCardNamesSave_(auth, customer, changes, expectedVersion)`。
- 表が壊れている（`FREEE_CARD_TABLE_INVALID`）ときは、3 つとも `{ok: false, code: 'TABLE_INVALID'}` を返す（何も書かない）。

### 3.2 表に書く（`freeeCardNamesWriteRow_(auth, customerId, newRow, existingRow, audit)`、`withScriptLock_` の中で呼ぶ）

1. 行番号：既にある行ならその行。無ければ「読んだ行のうち最後の行番号 + 1」（タブが無い・行が無ければ 2）。
2. **監査を先に書く**（`appendAuditRowsUnlocked_([...])` → `SpreadsheetApp.flush()`）。書けなければ `REQUIRED_LOG_WRITE_FAILED` の例外を投げ、表には 1 セルも書かない・**タブも作らない**（`59` の `registerCustomer_` と同じ形）。監査の中身は §3.5・§3.6。
3. タブが無ければ作る：`masterSpreadsheet_().insertSheet(FREEE_CARD_NAMES_SHEET_NAME_)`、`ensureSheetWidth_(sheet, 11)`、1 行目に §2.3 の見出しを `Sheets.Spreadsheets.Values.update(..., {valueInputOption: 'RAW'})` で書く。続いて `ensureRowExists_(sheet, rowNumber)`。
4. 行 `A{r}:K{r}` を `Sheets.Spreadsheets.Values.update({values: [row]}, masterId, range, {valueInputOption: 'RAW'})` で 1 回で書く。**RAW**（`USER_ENTERED` は `001` を数に、`=1+1` を式にする）。
5. 読み返し：`sheetsReadWithRetry_` ＋ `sheetsBatchGetPaced_(masterId, {ranges: ["'freeeカード科目'!A:A", range], valueRenderOption: 'UNFORMATTED_VALUE', majorDimension: 'ROWS'})` を 1 回。A 列でこの顧客 ID の行が**ちょうど 1 つでその行番号**であること、行の 11 セルが書いた値と同じ（文字列は `===`。K は数値で返ってもよい）であること、`freeeCardNamesParseRow_` で読めること。外れたら `WRITE_VERIFY_FAILED`。
6. 4・5 で失敗したら、失敗の監査（`reason: 'WEBAPP_FAILED'`、`after: {row, failed: code}`）を書こうとし（書けなくても元の失敗を返す）、`{ok: false, code: 'WRITE_VERIFY_FAILED', rowNumber}` を返す。

### 3.3 勘定科目 CSV を読む `freeeCardNamesParseCsv_(bytes)`

返す値は `{ok: true, accountNames, candidates, sha256, rowCount}` か `{ok: false, code, detail}`。**表には書かない・監査も書かない**（読むだけの関数）。

1. 大きさ：1〜1,048,576 バイト。外れたら `CSV_SIZE`。
2. 文字コード：`detectEncoding(bytes, ['勘定科目', '表示名'])`（`12`。BOM の UTF-8 を先に見る）。例外なら `CSV_ENCODING`。`mojibake === true` も `CSV_ENCODING`。
3. 行：`parseCsv(text)`（`12`）。1 行目の最初のセルの頭に U+FEFF が残っていれば外す。
4. 見出し（1 行目）：セルを NFKC にして空白を全部外したものが `勘定科目` の列と `表示名(決算書)` の列を探す（全角・半角のかっこのどちらでも当たる）。どちらかが無い・2 つ以上ある → `CSV_HEADER`（`detail: {missing: [...], duplicated: [...]}`）。
5. データ（2 行目から）：全部のセルが空（前後の空白を外して）の行は飛ばす。それ以外の行は：
   - 勘定科目名＝そのセルの前後の空白を外したもの。空 → `CSV_ROW_INVALID`（`{row: 物理の行番号}`。`parseCsv` の `recordStarts` を使う）。制御文字（U+0000〜U+001F・U+007F）を含む → `CSV_ROW_INVALID`。
   - 同じ勘定科目名が 2 回以上 → `CSV_DUPLICATE`（`{name, rows: [行番号, …]}`。最初に見つかった 1 つ）。
   - 表示名（決算書）のセルを NFKC にして前後の空白を外したものが `未払金` なら、カードの候補に入れる。
6. 勘定科目が 0 → `CSV_EMPTY`。3,000 より多い → `CSV_TOO_MANY`。`JSON.stringify(accountNames)` が 45,000 文字より長い → `CSV_TOO_LARGE`（セルの上限 50,000 文字に余裕を残す）。
7. `sha256 = sha256Hex(bytes)`。
- カードの候補が 0 でも `ok`（カードを freee にまだ登録していない顧客もある。画面で知らせる。§4.4）。
- 小分類・税区分・ほかの列は読まない・持たない。

### 3.4 開く `freeeCardNamesStart_(auth, customer)`（何も書かない）

1. `row = freeeCardNamesRowFor_(customer.customerId)`。
2. カードフォルダ：`DriveApp.getFolderById(customer.sourceFolderId).getFolders()` の全部を `{folderId, folderName}` にし、`webAppListFolder` と同じ順（名前、同じなら ID）に並べる。
3. 各フォルダに足す：
   - `savedAccountName`：`row.mappings[フォルダの鍵]`（無ければ `null`）。
   - `savedValid`：`savedAccountName` がカードの候補にあれば `true`。
   - `suggestion`：`savedAccountName` が `null` で、カードの候補のうち照合の鍵がフォルダ名の照合の鍵と同じものが**ちょうど 1 つ**なら、その名前。それ以外は `null`。**提案は保存しない**（利用者が［保存する］を押すまで表は変わらない）。
4. `orphans`：`row.mappings` の鍵のうち、今のカードフォルダのどのフォルダの鍵とも違うもの（`{folderName: 鍵, accountName, valid}`、鍵の順）。
5. 返す：

```
{
  ok: true, customerId, customerName,
  csv: null | {fileName, uploadedAt, uploadedBy, accountCount, candidateCount},
  candidates: [...],            // CSV が無ければ []
  folders: [{folderId, folderName, savedAccountName, savedValid, suggestion}],
  orphans: [...],
  version                        // 行が無ければ 0
}
```

- 勘定科目の全部（B 列）は返さない（画面に要らない）。

### 3.5 CSV を登録する・差し替える `freeeCardNamesUploadCsv_(auth, customer, fileName, base64, expectedVersion)`

1. `expectedVersion` が 0 以上の整数でなければ `{ok: false, code: 'STALE'}`。
2. `fileName`：文字列でなければ `''`。`/` か `\` の後ろだけを残し、制御文字を外し、前後の空白を外し、先頭 200 文字まで。空なら `勘定科目.csv`。
3. `base64`：文字列でない・空・4,000,000 文字より長い → `CSV_SIZE`。`Utilities.base64Decode(base64)` が例外 → `CSV_DECODE`。
4. `freeeCardNamesParseCsv_(bytes)`。`ok: false` ならそのまま返す（何も書かない・監査も書かない）。
5. `withScriptLock_` の中で：
   1. `current = freeeCardNamesRowFor_(customerId)`（ロックの中で読み直す）。今の版（行が無ければ 0）が `expectedVersion` と違えば `{ok: false, code: 'STALE'}`。
   2. 新しい行：A＝顧客 ID、B・C＝今回の CSV、**D＝今の対応をそのまま残す**（行が無ければ `{}`）、E・F・G・H＝今回の CSV、I・J＝今のまま（無ければ空）、K＝今の版 + 1。
   3. `invalidMappings`：D のうち、値が新しいカードの候補に無いもの（`{folderName, accountName}`）。
   4. §3.2 で書く。監査：`{type: 'FREEE_CARD_CSV', actor: auth.userEmail, targetType: 'CUSTOMER', targetId: customerId, customerId, before: current ? {version, sha256, accountCount, candidateCount} : '', after: {version, sha256, fileName, accountCount, candidateCount, invalidMappingCount}, reason: 'WEBAPP'}`。**勘定科目名は監査に書かない**（数だけ）。
6. 返す：`{ok: true, version, csv: {fileName, uploadedAt, uploadedBy, accountCount, candidateCount}, invalidMappings}`。

### 3.6 対応を保存する `freeeCardNamesSave_(auth, customer, changes, expectedVersion)`

1. `expectedVersion` が 1 以上の整数でなければ `{ok: false, code: 'STALE'}`。
2. `changes`：配列で、1〜200 個。各要素は `{folderName: 文字列, accountName: 文字列か null}`。`folderName` は前後の空白を外して空でないこと、`changes` の中で重ならないこと。外れたら `MAPPING_INVALID`（`detail: {index, reason}`）。
3. 今のカードフォルダの鍵の集合を Drive から作る（§3.4 の 2 と同じ読み方。ロックの外でよい）。
4. `withScriptLock_` の中で：
   1. `current = freeeCardNamesRowFor_(customerId)`。無ければ `{ok: false, code: 'NO_CSV'}`。版が `expectedVersion` と違えば `STALE`。
   2. 各変更を確かめる：
      - `accountName` が文字列なら、`current.candidates` にあること（完全一致）、かつ `folderName` が今のカードフォルダの鍵にあること。
      - `accountName` が `null`（外す）なら、`folderName` が今のカードフォルダの鍵にあるか、`current.mappings` の鍵にあること。
      - 外れたら `MAPPING_INVALID`（`detail: {folderName, reason: 'NOT_CANDIDATE' | 'FOLDER_NOT_FOUND'}`）。1 つでも外れたら何も書かない。
   3. 新しい対応＝`current.mappings` に変更を当てたもの（文字列は置き換え・`null` は鍵を消す）。今と全く同じなら、書かずに `{ok: true, version: current.version, changed: 0}`（監査も書かない）。
   4. 新しい行：D＝新しい対応、I・J＝今の日時と実行者、K＝版 + 1、ほかは今のまま。§3.2 で書く。監査：`{type: 'FREEE_CARD_MAPPING', actor, targetType: 'CUSTOMER', targetId: customerId, customerId, before: {version, mappings: 変わった鍵だけの今の値（無ければ null）}, after: {version, mappings: 変わった鍵だけの新しい値（外したら null）}, reason: 'WEBAPP'}`。
5. 返す：`{ok: true, version, changed: 変わった鍵の数}`。

### 3.7 複製した転記シートの B1 に書く `freeeCardWriteCardName_(customer, destinationSpreadsheetId, cardFolderName)`（`47`）

**この関数は例外を投げない。**中で起きた例外は全部 `FAILED` にし、`Logger.log('FREEE_CARD_NAME_WRITE_FAILED ' + JSON.stringify({customerId, code: エラーの code か name}))` に残す（カード名・フォルダ名はログに書かない）。返す値は `{status, folderName, accountName?}`（`folderName` はフォルダの鍵）。

1. `String(destinationSpreadsheetId) === String(customer.destinationSpreadsheetId)`（雛形）→ `FAILED`（書かない）。
2. `Number(customer.headerRow) < 2` → `TEMPLATE_UNSUPPORTED`。
3. `row = freeeCardNamesRowFor_(customer.customerId)`。例外 → `FAILED`。`null` → `NO_CSV`。
4. `mapped = row.mappings[フォルダの鍵]`。無い → `NOT_SET`。カードの候補に無い → `NOT_IN_CSV`（`accountName: mapped`）。
5. 書く：`Sheets.Spreadsheets.Values.update({values: [[mapped]]}, destinationSpreadsheetId, quoteSheetName_(customer.destinationSheetName) + '!B1', {valueInputOption: 'RAW'})` を 1 回。**B1 の 1 セルだけ。**
6. 読み返し：`sheetsReadWithRetry_` ＋ `sheetsBatchGetPaced_(destinationSpreadsheetId, {ranges: [同じ範囲], valueRenderOption: 'UNFORMATTED_VALUE', majorDimension: 'ROWS'})` を 1 回。値が `mapped` と `===` でなければ `FAILED`。
7. `WRITTEN`（`accountName: mapped`）。

**`80` の `webAppCloneDestination_(customer, now, cardFolderName)`：**
- 3 つ目の引数を足す。呼んでいる 2 か所（`webAppImportCall_` の準備の道と、1 本の道）は、どちらも `folderData.folder.getName()` を渡す。
- `schemaValidation.ok` が真のときだけ、返す直前に `cardName = freeeCardWriteCardName_(customer, destinationSpreadsheetId, cardFolderName)` を呼び、返す値に `cardName` を足す。**`customer` は `webAppCloneDestination_` の引数そのもの**（`destinationSpreadsheetId` が雛形の ID のもの。`newCustomer` ではない。§3.7 の 1 の確かめが効くように）。`schemaValidation` が偽のときは呼ばない（今の返し方のまま）。
- 今している、システム列を空にする処理・`validateDestinationSchema` は 1 文字も変えない。

### 3.8 記帳の結果に `cardName` を足す（`80` の `webAppImportCall_`）

- 1 本の道：この呼出しで複製したとき（`suppliedDestinationId` が無く、`clone.schemaValidation.ok`）だけ、`importResult.cardName = clone.cardName`。転記先を渡された呼出し（2 回目から）・並列の道（`isLane`）には `cardName` の鍵を付けない。
- 準備の道（`prepare`）：`preparedClone.schemaValidation.ok` のとき、`preparationResult.cardName = preparedClone.cardName`。
- `cardName` が何であっても、`stoppedBy`・`done`・`total` などは今のまま（**記帳を止めない**）。

### 3.9 往復の見積り（`80`）

`WEBAPP_IMPORT_BASE_TRIPS_` を 164 から **167** にする（複製に、表の読取 1・B1 の書込 1・読み返し 1 の 3 往復が増える）。上のコメントに 1 行足す（「2026-11-16 freee のカード名：複製に 3 往復」）。

### 3.10 freee 取込用の確かめ（`46` の `freeeExportCreate_`）

§3.9 の `CONTENT` の止め（`spec_freee_export.md`）の `CARD_NAME_PLACEHOLDER` の判定の直後に足す：

- `CARD_NAME_PLACEHOLDER` に当たらなかったときだけ、`cardRow = freeeCardNamesRowFor_(customer.customerId)` を呼ぶ（**B1 が `○○カード` のままなら表を読まない**）。
- `cardRow` があり、`cardRow.accountNames.indexOf(String(cardName)) < 0`（**完全一致。前後の空白も直さない**）なら、`stops` に `freeeStopEntry_('CARD_NAME_NOT_IN_FREEE', {cardName: String(cardName)})` を足す。順は `CARD_NAME_PLACEHOLDER` の位置（2 つは同時に当たらない）。
- `cardRow` が `null`（CSV を登録していない顧客）なら、今のまま（足す止めなし）。
- `freeeCardNamesRowFor_` が例外（表が壊れている）なら、**例外のまま投げる**（何も作らない。今の `webAppInvoke_` の失敗の返し方）。
- ほかの止め・順・返す値の形は変えない。

---

## 4. 画面（`81`）

### 4.1 「設定」の中を 2 つに分ける

- `settings-panel` の `panel-header` の下（`panel-body` の最初）に、切り替えのボタンを 2 つ：`settings-view-registration`「顧客一覧への登録」・`settings-view-freee-card`「freee のカード名」（`type='button'`・`className='button'`・選ばれている方に `aria-pressed='true'`）。
- 今の登録の中身（`registration-category-heading` の `section` から `registration-submit` の `action-row` まで）を `<div id="registration-view">` で囲む。**中の要素・id・順は変えない。**
- 新しく `<div id="freee-card-view" hidden>`（§4.2）。
- `settings-heading` の文字：登録を見ているときは今の「顧客一覧への登録」、freee のカード名を見ているときは「freee のカード名」。
- `openSettings()` は今どおり登録の側を開く（`state.settingsView = 'registration'`）。
- 切り替えは、どちらかが作業中（`registrationLocked()` か `state.freeeCardBusy > 0`）なら何もしない。
- `closeSettings()` は今の条件に加えて、`state.freeeCardBusy > 0` の間は閉じない。閉じたら `state.freeeCardGeneration += 1`。

### 4.2 「freee のカード名」の中身（上から）

1. `freee-card-customer-section`：見出し「1. 顧客」、`<select id="freee-card-customer">`。最初の選択肢は「（選んでください）」（値 `''`）、続いて `state.customers` の順で「顧客名（顧客 ID）」。
2. `freee-card-csv-section`（顧客を選ぶまで `hidden`）：見出し「2. 勘定科目 CSV」、
   - `freee-card-csv-status`：未登録なら「まだ登録していません。」。登録済みなら「ファイル名・登録日時（`formatDate`）・登録した人・勘定科目 N 件・カードの候補 M 件」。
   - 説明（`muted`）：「freee の［設定］→［勘定科目］→［エクスポート］で書き出した CSV を、そのまま選んでください。」
   - `<input id="freee-card-csv-file" type="file" accept=".csv,text/csv">` と、ボタン `freee-card-csv-upload`（未登録なら「この CSV を登録する」、登録済みなら「この CSV に差し替える」。ファイルを選ぶまで押せない）。
   - カードの候補が 0 件なら `settings-warning` で「この CSV には、表示名（決算書）が『未払金』の科目がありません。freee にカードを登録してから、もう一度書き出してください。」
3. `freee-card-map-section`（CSV が登録されるまで `hidden`）：見出し「3. カードフォルダと freee のカード名」、表 `freee-card-map`：
   - 列：「カードフォルダ」（`folderName`）・「freee のカード名」（`<select>`）・「状態」。
   - `<select>` の選択肢：「（未設定）」（値 `''`）＋カードの候補（CSV の順）。初めの値：`savedValid` なら `savedAccountName`、そうでなく `suggestion` があればそれ、それ以外は `''`。
   - 「状態」：保存済みで今の値と同じ →「保存済み」／`suggestion` を入れたまま →「同じ名前の候補（まだ保存していません）」／保存済みの値が候補に無い（`savedValid === false`）→「保存済みの『X』は今の CSV にありません（選び直すか、このまま保存すると外れます）」／今の値が保存済みと違う →「変更あり（まだ保存していません）」／それ以外 →「未設定」。
   - フォルダが 0 件なら「この顧客の明細フォルダにカードフォルダがありません。」
4. `freee-card-orphans`（`orphans` が 0 件なら `hidden`）：「今の明細フォルダに無いカードフォルダの対応」、1 件ずつ「フォルダ名 → 勘定科目名」と、チェックボックス「外す」。
5. `action-row`：ボタン `freee-card-save`「保存する」（`primary`）。変更が 1 つも無い・作業中 → 押せない。
6. 説明（`muted`）：「ここで保存した対応は、次に［記帳を実行］して作る転記シートから、入力用シートの B1 に入ります。今ある転記シートの B1 は変わりません（手で直してください）。」

### 4.3 開く・顧客を選ぶ

- `state.freeeCard`（`null` か §3.4 の返事）・`state.freeeCardCustomerId`・`state.freeeCardGeneration`（古い返事を捨てる番号）・`state.freeeCardBusy`（数）・`state.freeeCardSelections`（フォルダの鍵 → 選んだ値）・`state.freeeCardRemovals`（外す鍵の集合）。
- 顧客を選んだら：番号を 1 増やし、`state.freeeCard = null`、`gasCall('webAppFreeeCardNamesStart', [customerId])`。返事のときに番号か顧客が変わっていれば捨てる。`ok: false` なら `showNotice(§4.6 の文言, 'error')`。待っている間は欄に「読み込んでいます…」。
- `gasCall` に 3 つの入口の枝を足す（引数はそれぞれ 1・4・3 個）。

### 4.4 CSV を送る

1. ファイルが選ばれていない・作業中 → 何もしない。
2. `file.size` が 0 か 1,048,576 より大きい → `showNotice(TEXT.freeeCard.codes.CSV_SIZE, 'error')`（サーバーを呼ばない）。
3. `formatConfirm('勘定科目 CSV', '「ファイル名」を、顧客名 の勘定科目 CSV として登録します。' + 差し替えなら '\n今の CSV は置き換わります。保存済みの対応はそのまま残ります。')`。「戻る」なら終わる。
4. `FileReader.readAsDataURL` で読み、`,` の後ろ（base64）を取る。
5. `gasCall('webAppFreeeCardNamesUploadCsv', [customerId, file.name, base64, state.freeeCard.version])`（**ちょうど 4 つ**）。
6. `ok: true`：`showNotice('勘定科目 CSV を登録しました（勘定科目 N 件・カードの候補 M 件）。', 'success', 明細)`。明細は `invalidMappings` があれば 1 件ずつ「『フォルダ名』に当てていた『X』は新しい CSV にありません。選び直してください。」。続けて §4.3 の読み直し。ファイルの選択を空にする。
7. `ok: false`：§4.6 の文言。

### 4.5 保存する

- 送るのは**変わった所だけ**：`<select>` の値（「（未設定）」は `''`）が `savedAccountName`（`null` は `''`）と違うフォルダ → `{folderName: フォルダの鍵, accountName: 値か null（『（未設定）』のとき）}`。「外す」に印を付けた `orphans` → `{folderName, accountName: null}`。
  - したがって、開いた時点で `suggestion` が入っているフォルダ・保存済みの値が候補に無い（`savedValid === false`、`<select>` は `''` か提案で始まる）フォルダは、最初から「変わった所」に数える（［保存する］で提案を保存する・候補に無い古い対応を外す）。
- 変わった所が 0 件なら押せない。`gasCall('webAppFreeeCardNamesSave', [customerId, changes, state.freeeCard.version])`（ちょうど 3 つ）。
- `ok: true`：`changed > 0` なら「freee のカード名の対応を保存しました（N 件）。」、0 なら「変更はありませんでした。」。続けて §4.3 の読み直し。
- `ok: false`：§4.6 の文言。

### 4.6 文言（`TEXT.freeeCard.codes`）

| コード | 本文 |
|---|---|
| `CUSTOMER_INACTIVE` | この顧客は有効ではありません。 |
| `TABLE_INVALID` | freee のカード名の表を読めません。管理者に連絡してください。 |
| `CSV_SIZE` | CSV が空か、大きすぎます（1 MB まで）。 |
| `CSV_DECODE`・`CSV_ENCODING` | CSV の文字を読めませんでした。freee から書き出したファイルを、そのまま選んでください。 |
| `CSV_HEADER` | freee の勘定科目 CSV の形ではありません（「勘定科目」と「表示名（決算書）」の列が要ります）。 |
| `CSV_EMPTY` | 勘定科目が 1 行もありません。 |
| `CSV_ROW_INVALID` | N 行目の勘定科目が空か、使えない文字（改行・タブなど）を含んでいます。 |
| `CSV_DUPLICATE` | 勘定科目「X」が 2 回以上あります（N 行目・M 行目）。 |
| `CSV_TOO_MANY`・`CSV_TOO_LARGE` | 勘定科目が多すぎて登録できません。 |
| `STALE` | ほかの画面で先に変わりました。顧客を選び直してから、もう一度してください。 |
| `NO_CSV` | 先に勘定科目 CSV を登録してください。 |
| `MAPPING_INVALID` | 「X」の対応を保存できません（候補に無い名前か、今の明細フォルダに無いカードフォルダです）。顧客を選び直してください。 |
| `WRITE_VERIFY_FAILED` | 保存を確かめられませんでした。顧客を選び直して、保存されたかを見てください。 |
| `REQUIRED_LOG_WRITE_FAILED` | 監査ログに書けなかったため、保存しませんでした。 |

文字はすべて `textContent`（フォルダ名・勘定科目名・ファイル名に `<` などがあっても、そのまま文字として出す）。

### 4.7 顧客登録が終わった後のボタン

- 登録の `action-row` の下に `<div id="registration-next" hidden>`、中にボタン `registration-next-freee-card`「続けて freee のカード名を設定」。
- `submitRegistration` が `ok: true` で終わったとき（`bootstrap()` と `loadRegistrationStart()` の後）に、登録した顧客 ID を覚えて出す。`resetRegistrationSelection`・顧客フォルダを選び直したときに隠す。
- 押したら：freee のカード名の側へ切り替え、`freee-card-customer` をその顧客にして §4.3 を呼ぶ。その顧客が `state.customers` に無ければ、顧客を選ばない状態で開く。
- `submitRegistration` のほかの動きは変えない。

### 4.8 記帳の終わりの知らせ

- 1 本の道：`webAppRunImport` の返事に `cardName` があり、`status !== 'WRITTEN'` なら、`warnings` に §下の 1 行を足す（今の `warnings` の仕組みで、最後の `showNotice` の明細に出る）。
- 並列の道：`webAppPrepareImport` の返事（`preparation`）に `cardName` があれば同じく `warnings` に足す。
- `WRITTEN` のときは何も足さない。

| `status` | 1 行 |
|---|---|
| `NO_CSV` | 「フォルダ名」の freee のカード名がまだ設定されていないため（勘定科目 CSV が未登録）、入力用シートの B1 は「○○カード」のままです。今の転記シートは B1 を手で直してください。「設定」→「freee のカード名」で設定すると、次の記帳から自動で入ります。 |
| `NOT_SET` | 「フォルダ名」に freee のカード名が対応づけられていないため、入力用シートの B1 は「○○カード」のままです。（以下 `NO_CSV` と同じ 2 文） |
| `NOT_IN_CSV` | 「フォルダ名」に当てた「X」が今の勘定科目 CSV に無いため、B1 に入れませんでした。（以下同じ 2 文） |
| `TEMPLATE_UNSUPPORTED` | この顧客の転記シートの形では B1 にカード名を入れられません。B1 を手で直してください。 |
| `FAILED` | 入力用シートの B1 に freee のカード名を入れられませんでした。B1 を手で直してください。 |

### 4.9 freee 取込用の止めの文言（`TEXT` の freee 取込用の止めに足す）

| コード | 本文 |
|---|---|
| `CARD_NAME_NOT_IN_FREEE` | 入力用シートの B1（カード名）「X」は、登録した勘定科目 CSV にありません。freee の勘定科目名と同じにしてください（前後の空白・全角半角も同じに）。 |

`CARD_NAME_PLACEHOLDER` の文言は変えない。

---

## 5. 安全の条件（テストで確かめる）

- S1 3 つの入口は、オーナーでなければ拒む。拒んだとき、Drive のフォルダも表も読まない・何も書かない。
- S2 有効でない顧客には何も書かない。
- S3 CSV が §3.3 で外れたら、表にも監査にも書かない。
- S4 監査を先に書く。監査が書けなければ、表に 1 セルも書かない。
- S5 ロックの中で版を確かめ直し、違えば書かない（`STALE`）。
- S6 表へは RAW で 1 行だけ書き、読み返して確かめる（顧客 ID の行がちょうど 1 つ・11 セルが同じ）。違えば `WRITE_VERIFY_FAILED` と失敗の監査。
- S7 対応には、カードの候補にある名前だけを、今のカードフォルダの鍵にだけ保存できる（外すのは今の鍵か保存済みの鍵）。1 つでも外れたら何も書かない。
- S8 CSV を差し替えても、保存済みの対応は消さない（候補から外れたものは `invalidMappings` で知らせ、B1 には書かない）。
- S9 B1 に書くのは、**その呼出しで複製した転記シートの入力用シートの B1 の 1 セルだけ**。雛形・作成済みの転記シート（転記先を渡された呼出し・並列の道）には書かない。B1 以外のセルは、B1 を書かなかったときと全く同じ。
- S10 B1 に書けなくても・対応が無くても、記帳は止めない（`done`・`total`・`stoppedBy`・書いた取引は、`cardName` が無かったときと同じ）。`freeeCardWriteCardName_` は例外を外へ出さない。
- S11 B1 は RAW で書き、読み返して同じでなければ `FAILED`（`=1+1`・`001` が式・数にならない）。
- S12 freee 取込用：CSV を登録した顧客で B1 が CSV の勘定科目に無ければ作らない（`CARD_NAME_NOT_IN_FREEE`）。B1 が `○○カード` のままなら表を読まない（今の止めだけ）。CSV を登録していない顧客は今のまま。表が壊れていれば作らない。
- S13 表が壊れている（JSON が読めない・同じ顧客の行が 2 つ・見出しが違う）とき、どの入口も書かない。複製では B1 に書かない（`FAILED`）。
- S14 監査に勘定科目の一覧・CSV の中身を書かない（数と、変わった対応だけ）。ログにカード名・フォルダ名を書かない。
- S15 画面：文字はすべて `textContent`。古い返事は捨てる。作業中は設定を閉じない・切り替えない・ボタンを押せない。送る引数の数はちょうど（1・4・3）。変わった所だけを送る。

---

## 6. テスト

### 6.1 サーバー（`fcn N: …`、新しいファイル `test/freee-card-names.test.js`。値は全部架空）

組み立て：マスター（顧客マスターに架空の顧客 1 人、オーナーは `owner@example.com`）、顧客の D に架空のカードフォルダ（例：`テストカード`・`架空カードA`・`架空カード B `〔後ろに空白〕）、雛形と入力用シート（B1＝`○○カード`、`headerRow` 4）。取込のテストは `phase8-webapp.test.js` の記帳のテストと同じ組み立てを使ってよい。

**Shift_JIS のバイト列**は、テストの中で `new TextDecoder('shift_jis')` を 2 バイトの並び（先頭 0x81〜0x9F・0xE0〜0xFC × 後ろ 0x40〜0xFC）と 1 バイト（0x00〜0x7F・0xA1〜0xDF）に当てて、文字 → バイトの逆引きの表を作り、それで架空の CSV を作ってよい（`test/` の中に小さな関数として。外部のパッケージは足さない）。

1. CSV（Shift_JIS・BOM なし・LF・実物と同じ 12 列の見出し）：勘定科目 5 行（うち表示名（決算書）＝`未払金` が 3 行）・空の行 1 → `ok`、`accountNames` が CSV の順・`candidates` が 3 つ・`sha256` が 64 文字。
2. CSV（UTF-8・BOM 付き・CRLF・見本と同じ 13 列。`表示名(決算書)` は半角のかっこ）→ 1 と同じ結果。
3. 見出しに `表示名（決算書）` が無い → `CSV_HEADER`（`missing` に入る）。`勘定科目` が 2 列 → `CSV_HEADER`（`duplicated`）。
4. 勘定科目が空の行 → `CSV_ROW_INVALID`（物理の行番号）。改行を含む名前（引用符の中）→ `CSV_ROW_INVALID`。同じ名前 2 行 → `CSV_DUPLICATE`（2 つの行番号）。
5. 0 バイト・1,048,577 バイト → `CSV_SIZE`。base64 でない文字列 → `CSV_DECODE`。勘定科目 0 → `CSV_EMPTY`。3,001 行 → `CSV_TOO_MANY`。
6. 初めての登録：タブが無い → タブができる・1 行目が §2.3 の 11 の見出し・2 行目に 1 行（B・C・D＝`{}`・K＝1）・**監査 `FREEE_CARD_CSV` がタブと表より先**（書いた順を記録して確かめる）・監査に勘定科目名が無い・返す `version` 1。ファイル名 `=1+1.csv` が文字列のまま・表への書込の `valueInputOption` が `RAW`（スタブの記録で確かめる）。
7. 差し替え：保存済みの対応 2 つ（1 つは新しい CSV の候補に無い）→ D はそのまま・`invalidMappings` が 1 つ・版 2・E〜H が新しい値・I・J は今のまま。
8. `STALE`：登録・保存とも、古い版を送る → 書かない・監査なし。
9. オーナーでない（`authorizeOwner` が拒む）→ 3 つとも拒む・`DriveApp.getFolderById` を呼ばない・表を読まない・書かない（S1）。
10. 有効でない顧客 → 3 つとも `CUSTOMER_INACTIVE`・書かない。
11. 開く：フォルダが名前の順・保存済みの対応が出る（`savedValid`）・保存済みが候補に無い → `savedValid: false`・提案は照合の鍵で 1 つだけ当たるとき（全角英字・空白・大文字小文字の違いを含む）・2 つ当たれば `null`・`orphans`・行が無ければ `csv: null`・`version: 0`・**何も書かない**。
12. 保存：足す・変える・外す（今のフォルダと `orphans`）→ D が期待どおり・I・J・K が新しい・監査 `FREEE_CARD_MAPPING` が先で、変わった鍵だけ（before・after）。
13. 保存の拒み：候補に無い名前 → `MAPPING_INVALID`（`NOT_CANDIDATE`）・今のフォルダに無い鍵に名前を当てる → `MAPPING_INVALID`（`FOLDER_NOT_FOUND`）・`changes` の中で同じフォルダが 2 つ → `MAPPING_INVALID`・201 個 → `MAPPING_INVALID`・CSV なし → `NO_CSV`。どれも書かない・監査なし。1 つだけ外れて 1 つは正しい要求でも、何も書かない。
14. 変わらない保存 → `changed: 0`・書かない・監査なし。
15. 監査が書けない（`appendAuditRowsUnlocked_` が例外）→ 表は前と全く同じ・`REQUIRED_LOG_WRITE_FAILED`（S4）。
16. 読み返しが違う（スタブで読み返しの値を変える）→ `WRITE_VERIFY_FAILED`・失敗の監査（`WEBAPP_FAILED`）。
17. 表が壊れている（B が JSON でない・同じ顧客の行が 2 つ・見出しが違う）→ 開く・登録・保存は `TABLE_INVALID` で書かない。
18. 記帳（1 本の道）：`テストカード` に `架空カードA` を対応づけた顧客で、`テストカード` のフォルダを記帳 → 複製の入力用シートの B1＝`架空カードA`・**雛形の B1 は `○○カード` のまま**・複製の B1 以外の全セル・全タブが、対応の無い同じ記帳の複製と同じ（2 つの世界で同じ記帳をして比べてよい）・`cardName: {status: 'WRITTEN', folderName: 'テストカード', accountName: '架空カードA'}`・取引の書込は今どおり。B1 の書込は 1 セル・`valueInputOption` が `RAW`。対応の名前が `=1+1` の別の場合 → B1 が文字列 `=1+1`。
19. 記帳：表のタブが無い → `NO_CSV`・B1 は `○○カード`・`done`・`total`・`stoppedBy`・書いた取引が 18 の顧客と同じ数（S10）。対応が無いフォルダ → `NOT_SET`。候補から外れた対応 → `NOT_IN_CSV`。
20. 記帳の 2 回目（転記先を渡す）→ B1 の書込なし・`cardName` の鍵なし。並列の道（`isLane`）も同じ。
21. 準備の道（`webAppPrepareImport`、`WEBAPP_IMPORT_LANES_` を 2 にして）→ 複製の B1 が書かれる・`preparationResult.cardName`。
22. B1 の書込が例外・読み返しが違う → `FAILED`・記帳は止まらない（19 と同じ確かめ）・`Logger.log` にカード名・フォルダ名が無い。
23. `headerRow` 1 の顧客 → `TEMPLATE_UNSUPPORTED`・書かない。
24. フォルダ名の後ろの空白：フォルダ `架空カード B `・対応の鍵 `架空カード B` → `WRITTEN`。
25. freee 取込用：CSV ありで B1 が勘定科目にある → 新しい止めなし（今の fx 1 と同じに作れる）／B1 が勘定科目に無い（後ろに空白 1 つでも）→ `CARD_NAME_NOT_IN_FREEE`（`cardName` 付き）・何も作らない／B1 が `○○カード` → `CARD_NAME_PLACEHOLDER` だけ・**表を読まない**（読取の記録で確かめる）／CSV なし → 今のまま／表が壊れている → 失敗で返り、何も作らない。
26. 読取の数：開く（表あり）で表の読取は 1 回。複製で対応があるとき、表の読取 1・B1 の読み返し 1（マスターと複製への `batchGet` を記録して数える）。`WEBAPP_IMPORT_BASE_TRIPS_ === 167`。

### 6.2 画面（`fcnu N: …`、新しいファイル `test/freee-card-names-ui.test.js`。`kw26-ui-helpers.js` の `browserWorld` を使う）

1. 設定を開くと登録の側・ボタン 2 つ（登録の方が `aria-pressed='true'`）・`freee-card-view` は隠れている。切り替えると逆になり、見出しの文字が変わる。登録の中の要素は今のまま（id が全部ある）。
2. 顧客を選ぶ → `webAppFreeeCardNamesStart` を `[customerId]` で 1 回。返事を描く：CSV の状態・候補の選択肢（「（未設定）」＋候補）・保存済みが選ばれている・提案が選ばれて「同じ名前の候補（まだ保存していません）」・`orphans` の欄。
3. 古い返事を捨てる：顧客 A を選び、返事の前に B を選ぶ → A の返事が後から来ても B の内容のまま。
4. CSV：1 MB を超えるファイル → サーバーを呼ばずに `CSV_SIZE` の文言。正しいファイル → 確かめの窓 →「実行する」→ `webAppFreeeCardNamesUploadCsv` が**ちょうど 4 つ**の引数（顧客 ID・ファイル名・base64・版）で 1 回 → 成功の文言と `invalidMappings` の明細 → 読み直し。「戻る」なら呼ばない。
5. 保存：提案も候補から外れた保存済みも無い状態で、何も変えていなければ押せない。提案があれば開いた時から押せて、提案のフォルダだけが送られる。1 つ変えると押せる → `webAppFreeeCardNamesSave` が**ちょうど 3 つ**の引数で、変わったフォルダだけ。保存済みが候補に無いフォルダを「（未設定）」のまま保存 → `accountName: null` で送る。`orphans` の「外す」→ `null` で送る。
6. 文言：`STALE`・`MAPPING_INVALID`・`CSV_HEADER` などのコードで §4.6 の本文が出る。
7. 作業中（返事を待っている間）は、設定を閉じない・切り替えない・保存も送るも押せない。
8. フォルダ名・勘定科目名・ファイル名に `<img src=x onerror=alert(1)>` → 文字として出る（要素が増えない）。
9. 登録の成功の後に `registration-next-freee-card` が出る → 押すと freee のカード名の側・その顧客が選ばれ・`webAppFreeeCardNamesStart` が呼ばれる。顧客フォルダを選び直すと隠れる。
10. 記帳の終わり：1 本の道の返事 `cardName: {status: 'NOT_SET', folderName: 'テストカード'}` → 最後の知らせの明細に `NOT_SET` の 1 行（フォルダ名入り）。`WRITTEN` → その行なし。準備の道の返事の `cardName` も同じく出る。
11. freee 取込用の止め `CARD_NAME_NOT_IN_FREEE`（`cardName: '架空カードZ'`）→ §4.9 の本文（名前入り）。

### 6.3 既存のテスト

- 既存のテストを消す・弱める・飛ばすことはしない。
- `WEBAPP_IMPORT_BASE_TRIPS_` の値（164）や、記帳の呼出しの並び・数を**完全一致で**見ている既存のテストが、§3.7〜§3.9 の追加（表の読取・B1 の書込・読み返し・定数）だけで落ちるときに限り、その期待をその分だけ直してよい。直したテストの名前と、直した前後を全部報告する。**それ以外の理由で落ちたら、テストは直さずにコードを直す。**
- 既存のテストのマスターには表のタブが無いので、複製は `NO_CSV`（表の読取 0 回・書込 0 回）になり、ほとんどの既存のテストは変わらないはずである。

---

## 7. 変異（入れて回し、赤になるテストを記録して戻す）

| 番号 | 入れる変異 | 赤になるはずのテスト |
|---|---|---|
| R1 | 3 つの入口のどれかで `authorizeOwner` を外す | fcn 9 |
| R2 | `CUSTOMER_INACTIVE` の確かめを外す | fcn 10 |
| R3 | CSV の確かめで外れても書く（`ok: false` を見ない） | fcn 3〜5 のどれか |
| R4 | 監査を表の後に書く | fcn 6・15 |
| R5 | ロックの中の版の確かめを外す | fcn 8 |
| R6 | 表へ `USER_ENTERED` で書く | fcn 6 |
| R7 | 読み返しの確かめを外す | fcn 16 |
| R8 | 候補に無い名前も保存できる | fcn 13 |
| R9 | 今のフォルダに無い鍵にも名前を当てられる | fcn 13 |
| R10 | CSV の差し替えで D を `{}` にする | fcn 7 |
| R11 | 複製で、転記先を渡された呼出しでも B1 に書く | fcn 20 |
| R12 | B1 の書込の例外を外へ出す | fcn 22 |
| R13 | 候補から外れた対応（`NOT_IN_CSV`）でも B1 に書く | fcn 19 |
| R14 | フォルダの鍵の前後の空白を外さない | fcn 24 |
| R15 | freee 取込用で、B1 の確かめを前後の空白を外して比べる | fcn 25 |
| R16 | freee 取込用で、B1 が `○○カード` のときも表を読む | fcn 25 |
| R17 | 表の同じ顧客の 2 行目を無視して 1 行目を使う | fcn 17 |
| R18 | 監査に勘定科目の一覧を書く | fcn 6 |
| R19 | 画面で、保存に全部のフォルダを送る | fcnu 5 |
| R20 | 画面で、古い返事を捨てない | fcnu 3 |
| R21 | 画面で、フォルダ名を `innerHTML` で出す | fcnu 8 |
| R22 | 画面で、作業中も設定を閉じられる | fcnu 7 |
| R23 | 画面で、`cardName` の知らせを出さない | fcnu 10 |

---

## 8. 変えてよいファイル

- 新しい `src/47_FreeeCardNames.gs`
- `src/80_WebApp.gs`：§3.1 の 3 つの入口・§3.7 の `webAppCloneDestination_` と呼ぶ 2 か所・§3.8・§3.9 だけ
- `src/46_FreeeExport.gs`：§3.10 だけ
- `src/81_WebAppUi.html`：§4 の所だけ
- 新しい `test/freee-card-names.test.js`・`test/freee-card-names-ui.test.js`
- `test/gas-stubs.js`・`test/kw26-ui-helpers.js`：足りないものを**足すだけ**（既存のテストが 1 つも変わらないこと）
- 既存のテスト：§6.3 の場合だけ

**変えないもの：**上に無いファイル全部。特に `00`・`02`・`04`・`59`。`src/97_Ops.gs` は開かない・書かない。

---

## 9. 本番での手順と受入

### 9.1 手順（Claude）

1. main へ取り込んで全テスト（fixtures のある main のフォルダーで）。
2. push 前の本番と HEAD を pull で比べ、利用者の許可を得てから `clasp push`。本番＝HEAD を確かめる。GitHub へ main とタグ。
3. 表のタブは、最初の CSV の登録で自動でできる（準備の関数は要らない）。

### 9.2 受入（利用者）

1. F5 →「設定」→「freee のカード名」→ 1 人目の顧客を選ぶ。
2. freee から書き出した勘定科目 CSV を選んで登録 → 勘定科目の数とカードの候補の数が出る。
3. カードフォルダごとに freee のカード名を選んで保存（同じ名前のものは最初から選ばれている。保存するまで記録されない）。
4. 対応づけたカードフォルダで［記帳を実行］→ 新しい転記シートの入力用 B1 に、選んだ名前が入っている。
5. 最終確認 → freee 取込用 Excel を作る → ダウンロード → freee のエクセルインポート（振替伝票）で、貸方（出金）・借方（入金）がそのカードになっている。
6. 対応づけていないカードフォルダで記帳 → 終わりに「未設定」の知らせが出て、B1 は `○○カード` のまま。

---

## 10. Claude の判断の記録（利用者の決定ではないもの）

1. **対応は顧客マスターに列を足さず、別のタブ（1 顧客 1 行・JSON）に持つ。**顧客マスターは 45 列の形を多くの所が前提にしていて、1 つの不正な行で全画面が止まる（`getActiveCustomers` が投げる）。別のタブなら、壊れても記帳は止まらない（B1 を書かないだけ）。1 顧客 1 行にしたのは、1 回の書込と読み返しで確かめられるため。
2. **カードの候補は「表示名（決算書）＝未払金」の行の全部**（カードでない「未払金」などの科目も入る）。小分類・ショートカットでカードだけに絞ることはしない（freee の設定で変わりうる）。人が選ぶ。
3. **freee 取込用の確かめは「CSV の勘定科目のどれか」と完全一致**（カードの候補だけに絞らない）。カードを「未払金」そのもので記帳する事務所の使い方を止めないため。完全一致にしたのは、freee のインポートは知らない勘定科目名を新しい科目として作るので、空白 1 つの違いでも別の科目ができるおそれがあるため。
4. **同じ名前の候補は、画面で選んだ状態にするだけで、保存は利用者が押す。**名前が似ていても別のカードのことがあるため。
5. **B1 の書込は監査に書かない。**転記シートの中に値が見え、記帳の結果にも出る。監査の書込は往復が多く、記帳の時間の見積りを圧迫する。
6. **B1 の書込の前に「今 `○○カード` か」は確かめない。**今作ったばかりの雛形の写しなので、雛形の値に関わらず、対応の名前が正しい。
7. 表が壊れているときは、開く・保存とも止める（どちらの行が正しいかをシステムは決めない）。記帳は止めず B1 を書かない。freee 取込用は作らない（壊れた表で確かめを素通りさせない）。
8. CSV の大きさの上限 1 MB・勘定科目 3,000・JSON 45,000 文字・`changes` 200 個は、実物（170 行・約 20 KB）に十分な余裕を持たせた値。

---

## 11. 実装と監査の記録

（実装の後に書く）

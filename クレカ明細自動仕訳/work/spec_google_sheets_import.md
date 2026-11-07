# Google スプレッドシートの明細を取込で読む 仕様書（(d) の第 1 段）

版：1.1（2026-11-06。監査で gs 10 に同じ中身の場合を足し、gs 11 の書き方を直した。§9）
対象：`src/12_FileReader.gs`・`src/10_DriveScanner.gs`・`src/71_RunOrchestrator.gs`・`src/19_FormatRegistration.gs`・`src/80_WebApp.gs`・`src/97_Ops.gs`。
発端：1 人目の顧客の当事業年度の明細フォルダを診断（`opsDiagnoseCustomerFolder`、2026-11-02・11-03）した結果、明細 76 本のうち **CSV 0・Excel 0・Google スプレッドシート 53・ショートカット 23** だった。今の取込はこの 76 本を 1 本も拾わない。

**実名をこの文書・コード・テスト・コミットに書かない。**このリポジトリは公開である。

## 1. 背景

- 走査（`10` の `scanUnprocessedFiles`）は名前が `.csv`・`.xlsx` で終わるものしか拾わない。Google スプレッドシートには拡張子が無いので、**黙って 0 件**になる。画面の一覧（`80` の `webAppFolderFile_`）も「対象外」と出す。`readFile`（`12`）も名前で種類を決めるので `TypeError` で拒む。
- Excel は「一時的な Google スプレッドシートへ変換して `getValues()`」で読んでいる。Google スプレッドシートは**変換を飛ばすだけで同じ値・同じ型で読める**。診断 1.3 で 53 本すべて読め、23 本は今の形式で判定できた。
- 本番は作業フォルダ（`PARALLEL_WORK_FOLDER_ID`）が未設定で、Excel の一時ファイルは顧客と共有のフォルダにできる。Google スプレッドシートは変換しないので、この問題は起きない。
- **ファイルの同一性を見る 3 か所が、ファイルのバイト列を前提にしている：**
  1. 処理ログ・恒久ファイルインデックスのバイナリハッシュ（`71` の `sha256Hex(read.bytes)`）
  2. 書込直前の番人 9-2（`71` の `fetchFileRecord`：`getBlob()` を読み直して比べる）
  3. 再走査 モード 2（`10` の `scanProcessedFilesForChange` の `computeHash`）

  Google スプレッドシートの `getBlob()` は **PDF への書き出し**である。PDF は見た目しか写さず、書き出しのたびにバイトが同じとも限らない。そのまま通すと、番人が毎回 `FILE_CHANGED` と言うか、中身の変化を見逃すかのどちらかになる。どちらも二重転記の防止に関わる。
- `headRevisionId` は Drive v3 ではバイナリのファイルにしか無い。Google スプレッドシートでは `null` で、処理ログの版の列は空になる。
- **SpreadsheetApp は同じ実行の中で読み直しても新しい値を返すとは限らない。**このシステムは実機で「Sheets API で書いた行が SpreadsheetApp から見えない」を踏んでいる（`01_DataAccessCore.gs` 147 行のコメント）。番人が SpreadsheetApp で読み直すと、取込の最中にスタッフが用途を書き換えても、最初に読んだ値をもう一度返して素通りする恐れがある。Sheets API の読取は常にその時点の値を返す。

## 2. 段の分け方

- **第 1 段（本書）：**明細フォルダに直に置かれた Google スプレッドシートを、Excel と同じに取り込む。
- **第 2 段（別の仕様書）：**ショートカット。利用者の決定待ちがある（前年の利用日の除外の細部、名前の付け替えをどこにするか）。
- **第 3 段（別の仕様書）：**足りない形式・「仕入れ専用」・家族カードの会員見出し行。

第 1 段ではショートカットを**拾わない**。今は名前が `.csv`・`.xlsx` のショートカットを拾い、`getBlob()` で読めずに `FAILED` になり得る（実際の 23 本は名前に拡張子が無いので拾っていない）。第 2 段まで、名前によらず拾わないに揃える。

## 3. 決めたこと

1. **取込の対象かどうかは種類（MIME）で決める。**`application/vnd.google-apps.spreadsheet` は名前によらず対象。名前が `.csv`・`.xlsx`（大文字小文字を問わない）のものは今までどおり対象。ただし**ショートカット（`application/vnd.google-apps.shortcut`）は名前によらず対象外**、フォルダとほかの Google の種類（文書など）も対象外。この判定は 1 つの関数 `isImportableDriveFile(name, mimeType)`（`12`）にまとめ、走査（`10`）と画面の一覧（`80`）が使う。
2. **読み方は Excel と同じ。変換だけ飛ばす。**`readFile` が自分で種類を見る（呼出し元は変えない）。戻り値の `fileType` は `'xlsx'` とする ── 値の型が Excel と全く同じなので、判定・抽出・形式登録の分岐を全部 Excel と同じ道に通すためである。形式登録で保存する E 列も `XLSX` になる（E 列は記録で、判定には使っていない。2026-11-01 の決定）。戻り値に `sourceKind` を足す（Google スプレッドシートは `'GOOGLE_SHEET'`、ほかは `'FILE'`）。`bytes` は `null`。
3. **Google スプレッドシートの「バイナリハッシュ」は、Sheets API で読んだ中身のハッシュ（以下「中身ハッシュ」）とする。**
   - **取り方：**`Sheets.Spreadsheets.get(fileId, {includeGridData: true, fields: 'sheets(properties(title,index),data(rowData(values(effectiveValue,effectiveFormat/numberFormat/type))))'})` を 1 回。読取の枠を数えて待つ口（`paceSheetsRead_`・`apiReadCount_`・`sheetsReadWithRetry_`）を必ず通す。
   - **材料：**版の印 `'GOOGLE_SHEET_CONTENT_V1'`、シートの数、シートごと（`index` の順）に名前・行数・各行のセル数・各セル。セルは型の印つき ── 数 `N`＋値、文字 `S`＋値、真偽 `B`＋`1/0`、エラー `X`＋種類、空 `E`。数のセルには表示形式の種類（`DATE`・`NUMBER` など。無ければ空）も付ける。**末尾の空の行と、各行の末尾の空のセルは材料に入れない**（表の大きさが変わっただけをファイルの変更と見ない）。**中ほどの空の行は入れる**（行の位置は取引 ID の材料である）。`serializeDeterministic` で長さ付きに並べ、`sha256Hex(utf8Bytes(...))`。
   - **なぜ `effectiveValue` か：**`getValues()` が返すのも計算後の値である。表示形式の種類を入れるのは、数のセルを日付の形式に変えると `getValues()` の型（`number` → `Date`）が変わり、読んだ結果が変わるからである。
   - **なぜ読んだ値から作らないか：**番人（決定 4）は SpreadsheetApp では作れない（§1 の最後）。保存するハッシュと番人のハッシュは同じ道で作らないと比べられない。
4. **`readFile` は中身ハッシュを先に取り、それから SpreadsheetApp で値を読む。この順は必ず守る。**逆にすると、値を読んだ後・ハッシュを取る前にスタッフが書き換えたとき、保存するハッシュは書換え後、読んだ値は書換え前になり、番人は「変わっていない」と答えて古い値を書く。先に取れば、間の書換えは番人が `FILE_CHANGED` で止める（安全側の誤検知）。
5. **「いまのハッシュ」を 1 つの関数にする：**`currentFileBinaryHash(fileId)`（`12`）。Google スプレッドシートなら中身ハッシュを取り直す（SpreadsheetApp を開かない）。ほかは今と同じ `sha256Hex(getBlob().getBytes())`。番人（`71` の `fetchFileRecord`）と再走査（`10` の `computeHash`）はこれを使う。
6. **CSV・Excel のハッシュの値は変えない。**`readFile` の戻り値に `binaryHash` を足し、CSV・Excel は `sha256Hex(bytes)`（今 `71` が計算しているのと同じ値）。`bytes` も今までどおり返す。
7. **版の列は Google スプレッドシートでは空のまま。**Drive の `version` も入れない ── 名前の付け替え（【処理中】・【済】）でも上がるので、自分の付け替えを変更と見てしまう。番人は今も版を比べていない（`fetchFileRecord` はハッシュだけ返す）。再走査は変更日時の差でハッシュを取り直すので拾える。
8. **形式登録の試し読みのハッシュ（`19` の `formatHashRow_`）は、バイト列の代わりに `read.binaryHash` を受ける。**CSV・Excel の試し読みのハッシュの値は変わらない（中で `sha256Hex(bytes)` していたのと同じ値を渡すため）。
9. **診断（`97`）も Google スプレッドシートを `readFile` で読む。**`diagReadGoogleSheet_` を消す。取込と同じ読み方を診断で確かめられるようにするためである。診断の表示の `fileType: 'gsheet'` はそのまま。Excel を作業フォルダが無ければ読まない扱いも変えない。
10. **変えないもの：**取引 ID・内容ハッシュ・取引同一性ハッシュの材料、CSV と Excel の読み方とハッシュの値、名前の付け替え（Google スプレッドシートも同じ接頭辞を `setName` で付ける。中身ハッシュには名前が入らないので番人に影響しない）、10 分の待ち（Drive の変更日時で見る）、形式の判定と抽出、ショートカットの扱い（拾わない）、画面の見た目（一覧の「対象外」が「取込可能」になるだけ）。

**読取の枠：**Google スプレッドシート 1 本につき Sheets API の読取が 2 回増える（読む前と番人）。再走査では、変更日時が変わった Google スプレッドシート 1 本につき 1 回。形式登録の試し読み・診断でも 1 本 1 回。枠（60 回/分）を待つ口を通るので当たりはしないが、遅くはなる。1 人目の顧客の診断（Google スプレッドシート 74 本）は 1 分ほど長くなり、時間の枠で止まれば `nextSkip` で続きから読む。

## 4. 変更の中身

### 4.1 `src/12_FileReader.gs`

- 定数 `GOOGLE_SHEETS_MIME_ = 'application/vnd.google-apps.spreadsheet'`・`DRIVE_SHORTCUT_MIME_ = 'application/vnd.google-apps.shortcut'`。
- `isImportableDriveFile(name, mimeType)`：決定 1。ショートカットとフォルダの判定を名前の判定より先に置く。
- `readSpreadsheetSheets_(fileId, spreadsheet)`：今の Excel の読み方（`getSheets()` → シート数の上限 → 各シート `getRange(1, 1, min(MAX_ROWS, getMaxRows()), min(MAX_COLUMNS, getMaxColumns())).getValues()` → 行数の上限）を切り出す。Excel と Google スプレッドシートの両方がこれを使う。
- `googleSheetContentHash_(fileId)`：決定 3。
- `readFile`：最初に `DriveApp.getFileById(fileId)` を 1 回だけ呼び、その `File` を使い回す。
  - 種類が Google スプレッドシート：`googleSheetContentHash_` → `SpreadsheetApp.openById` → `readSpreadsheetSheets_`。`getBlob`・`Drive.Files.copy`（`convertXlsxToTemp`）は呼ばない。バイト数の上限は見ない（バイト列が無い）。シート数・行数の上限は Excel と同じ。
  - 種類がショートカット：`TypeError`（`getBlob` を呼ばない）。
  - ほか：今までどおり名前で `csv`・`xlsx` を決める（どちらでもなければ `TypeError`）。`file.getBlob().getBytes()`。
  - 戻り値に `binaryHash`・`sourceKind` を足す。
  - 段の記録（`step_`）は Google スプレッドシートでも `read:sheets` を出す。ハッシュの段は `read:hash` とする。
- `currentFileBinaryHash(fileId)`：決定 5。

### 4.2 `src/10_DriveScanner.gs`

- `scanUnprocessedFiles` の拡張子の判定を `isImportableDriveFile(file.name, file.mimeType)` に置き換える。冒頭とモード 1 のコメント（「拡張子が.csv/.xlsx」）を直す。
- `scanProcessedFilesForChange` の `computeHash` を `currentFileBinaryHash` にする。

### 4.3 `src/71_RunOrchestrator.gs`

- `binaryHash` は `read ? read.binaryHash : ''`。
- `fetchFileRecord` は `{binaryHash: currentFileBinaryHash(id)}`。

### 4.4 `src/19_FormatRegistration.gs`

- `formatHashRow_(row, fileId, binaryHash, acknowledgements)`：`sha256Hex(bytes)` の代わりに受けた `binaryHash` を材料に入れる。呼出し（今は 1 か所）は `read.binaryHash` を渡す。

### 4.5 `src/80_WebApp.gs`

- `webAppFolderFile_` の `supported` を `isImportableDriveFile(fileName, file.getMimeType())` にする。

### 4.6 `src/97_Ops.gs`

- `diagExamineFile_` は Google スプレッドシートも `readFile` で読む。`diagReadGoogleSheet_` を消す。ほかの関数は変えない。
- **この文書は NUL バイトを 2 つ含み、改行は LF である。**バイトのまま範囲を置き換え、NUL 2・CR 0 を保つ。

## 5. テスト（`test/phase6-google-sheets-import.test.js`、新規。gs 1〜14）

テストの Drive・スプレッドシートは架空の値だけを使う。Sheets API の `Spreadsheets.get` の代用品に `includeGridData` を足してよい（足すだけ。今の振る舞いを変えない）。代用品は、日付のセルを実 API と同じく**シリアル値の数＋表示形式 `DATE`** で返すこと。

- **gs 1** `isImportableDriveFile` の表：`.csv`（`text/csv`）・`.xlsx`・`.XLSX`・拡張子なしの Google スプレッドシート・名前が `.xlsx` の Google スプレッドシートは真。名前が `.xlsx` のショートカット・拡張子なしのショートカット・Google 文書・PDF・フォルダ・名前が `.csv` の Google 文書は偽。
- **gs 2** 走査：同じフォルダに Google スプレッドシート（拡張子なし）・Excel・CSV・名前が `.xlsx` のショートカット・Google 文書・PDF。候補は前の 3 つだけで、並びは今の規則（作成日時→名前→ID）、`mimeType` を持つ。変更から 10 分たたない Google スプレッドシートは候補にならない。
- **gs 3** `readFile` の Google スプレッドシート：`getBlob`・`Drive.Files.copy`・`convertXlsxToTemp` を呼ばない（呼んだら失敗にする）、スプレッドシートの数が増えない。**中身ハッシュの読取が `SpreadsheetApp.openById` より先**（呼ばれた順を記録して確かめる）。`sheets` は同じ値の Excel を変換で読んだものと一致、`fileType` は `'xlsx'`、`sourceKind` は `'GOOGLE_SHEET'`、`bytes` は `null`、`encoding` は `null`、`binaryHash` は `currentFileBinaryHash` と同じ値。シート数・行数の上限で `INPUT_LIMIT_EXCEEDED`。
- **gs 4** CSV と Excel：`binaryHash` が `sha256Hex(bytes)` と一致し、既知のバイト列で値を直書きして固定する。`sourceKind` は `'FILE'`。ショートカットは名前が `.xlsx` でも `TypeError` で、`getBlob` を呼ばない。
- **gs 5** 中身ハッシュの性質：同じ中身なら何回取っても同じ。**変わる：**文字 1 字、数 `1` → 文字 `'1'`、日付のセルの時刻だけ（シリアル値の小数）、数のセルの表示形式だけ（`NUMBER` → `DATE`）、真偽、空 → 空白 1 字、シート名、シートの順、中ほどへの空行の挿入、中ほどへの空列の挿入。**変わらない：**末尾に空の行・空の列を足す（グリッドが大きくなるだけ）、ファイル名の変更。材料に版の印が入る（同じ並びの文字列のハッシュと一致しない）。
- **gs 6** 取込の通し：Google スプレッドシートの明細 1 本 → `runImport` で `WRITTEN`。転記先の行は同じ値の Excel を取り込んだときと同じ。処理ログと恒久ファイルインデックスのバイナリハッシュは中身ハッシュ、版の列は空、名前は `【済】` ＋元の名前。取込の間に `getBlob` がどこからも呼ばれない。`SpreadsheetApp.openById` で明細を開くのは 1 回だけ、中身ハッシュの読取は 2 回（読む前と番人）。一時ファイル 0。
- **gs 7** 番人：`readFile` が値を読んだ直後（番人の前）に明細のセルを 1 つ書き換える → `FILE_CHANGED` で転記 0 行。書き換えずに通したとき（gs 6）、名前の付け替えだけでは `FILE_CHANGED` にならない。
- **gs 8** 番人の順の穴：中身ハッシュを取った後・`openById` の前に書き換える → `FILE_CHANGED`（安全側の誤検知）で転記 0 行。
- **gs 9** 再走査：取り込んだ Google スプレッドシートのセルを書き換えて変更日時を進める → `FILE_CHANGED` の要確認 1 件、`detail` の `oldBinaryHash`・`newBinaryHash` は中身ハッシュ。書き換えずに変更日時だけ進める → 要確認なし。どちらも `getBlob` を呼ばない。
- **gs 10** 同じ月の Excel と Google スプレッドシート：両方の順で、2 本目は `REVIEW_WAIT`・`PURPOSE_REVISION_CANDIDATE`・`NO_WRITE`・転記 0 行・`DUPLICATE` の要確認 1 件（`csvx 11` と同じ形）。
- **gs 10b**（1.1 で追加）同じ中身の Excel と Google スプレッドシート（Excel を変換して両方残した形。シート名まで同じで内容ハッシュが一致する）：両方の順で、2 本目は `REVIEW_WAIT`・`DUPLICATE_CONTENT`・`NO_WRITE`・転記 0 行・`DUPLICATE` の要確認 1 件。
- **gs 11** 画面の一覧：Google スプレッドシートは 10 分たてば「取込可能」で `importable` は真、たたなければ「取込待ち（あと n 分）」で `importable` は偽（今の 10 分の待ちのまま。1.0 は「真」と読める書き方だった）。名前が `.xlsx` のショートカットと Google 文書は「対象外」で偽。画面の取込（`webAppRunImport`）で Google スプレッドシートが `WRITTEN`。
- **gs 12** 形式登録：形式不明の Google スプレッドシートで、形式診断・試し読み・保存が通る。試し読みの `previewHash` は 2 回で同じ、セルを 1 つ変えると違う。**CSV と Excel の `previewHash` は変更前と同じ値**（変更前のコードで固定の入力から求めた値をテストに直書きする）。
- **gs 13** 診断：Google スプレッドシートは `readFile` を通る（回数を数える）、一時ファイルを作らない、結果（`fileType: 'gsheet'`・判定・件数）は今までと同じ。`diag 25` の「`readFile` を通らない」の確かめは「`readFile` を通り、一時ファイルを作らない」へ直す（意味を変えるのはこの 1 か所だけ）。
- **gs 14** 失敗の道：番人の中身ハッシュの読取が（再試行の後も）失敗したら、今の `getBlob` の失敗と同じく例外で `FAILED` になり、転記 0 行・リースは解放される。

既存のテストで直してよいのは、Google スプレッドシートを「読まない・拾わない」前提で書いたものだけ（直したものは全部報告する）。

## 6. 変異（S1〜S20。監査で私が入れる）

- S1 `isImportableDriveFile` から Google スプレッドシートの条件を落とす
- S2 名前が `.xlsx` のショートカットを対象に戻す
- S3 `readFile` の Google スプレッドシートで `getBlob` のバイト列のハッシュを使う
- S4 中身ハッシュの型の印を落とす（数 `1` と文字 `'1'` が同じ）
- S5 中身ハッシュからシート名を落とす
- S6 中身ハッシュで末尾の空行を落とさない
- S7 中身ハッシュで中ほどの空行も落とす
- S8 中身ハッシュから表示形式の種類を落とす
- S9 シートを `index` でなく名前の順に並べる
- S10 `readFile` で `openById` を中身ハッシュより先にする
- S11 `currentFileBinaryHash` の Google スプレッドシートを SpreadsheetApp の値から作る
- S12 `71` の `fetchFileRecord` を `getBlob` のままにする
- S13 `10` の `computeHash` を `getBlob` のままにする
- S14 `80` の `supported` を名前の判定だけに戻す
- S15 `formatHashRow_` で受けたハッシュをもう一度 `sha256Hex` する
- S16 Google スプレッドシートの `fileType` を `'gsheet'` にする
- S17 Google スプレッドシートを `convertXlsxToTemp` 経由で読む
- S18 Google スプレッドシートでシート数・行数の上限を見ない
- S19 中身ハッシュの読取を枠の口（`paceSheetsRead_`・`apiReadCount_`）に通さない
- S20 診断で `diagReadGoogleSheet_` を使い続ける

## 7. 本番での実行（私が行う。利用者の許可を得てから）

1. 全テスト → コミット → push 前の pull 比較（本番＝`gas-push-133` のはず）→ `clasp push` → push 後の比較 → タグ `gas-push-134` → GitHub。
2. **影響：**TEST01 の明細フォルダに Google スプレッドシートがあれば、画面の一覧で「取込可能」になり、次の［記帳を実行］で取り込まれる。本番の顧客は 0 人。1 人目の顧客はまだ登録していないので取込は走らない。
3. 診断を 1 人目の顧客で再実行し（読むだけ。許可を得て）、Google スプレッドシートが `readFile` を通っても 11-03 と同じ結果（判定 32・不明 42 など）になることを確かめる。

## 8. 受入

- 診断の再実行で、11-03 と判定・件数が同じ。
- TEST01 で、まだ取り込んでいない月の明細を Google スプレッドシートとしてカードフォルダに置き、［記帳を実行］で【済】になり、転記先の値が正しい（置くのは利用者。置くかどうかも利用者が決める）。

## 9. 監査の記録（2026-11-06）

- Codex（ログ `tools/codex-logs/*-20261106-172307-*`、gpt-6.1-sol xhigh、17:23〜18:06）：開始 1798/1798 → 終了 1829/1829。gs 1〜14 の 31 本は作る前に 29 本が赤（緑の 2 本は gs 12 の「変更前と同じ値」）。S1〜S20 はすべて赤。
- 差分は §4 の 6 ファイルだけ。97 は NUL 2・CR 0、ほかも LF のまま。`???` は 0 件。
- 既存のテストで直したのは `diag 25`・`26`・`27`・`28`・`31`（Google スプレッドシートを `readFile` で読まない前提だったもの）。判定・件数・読むだけ・時間の枠の確かめは保ったまま、`readFile` を通ることの確かめに置き換えた。`gas-stubs.js` は `Spreadsheets.get` の `includeGridData`、一覧の Google スプレッドシートの `headRevisionId` を省く、`getMimeType` の bind の 3 つを足しただけ。
- 私の変異 Z1〜Z12（番人が読んだときのハッシュを使い回す・行末の空セルを残す・`fileType` を `'csv'` にする・行の長さの印を落とす・ほかの Google の種類を名前で通す・走査が種類を見ない・エラーを空にする・シートの数を落とす・画面が名前の判定も残す・`71` がバイト列を数える・数を切り捨てる・ショートカットを名前の判定へ落とす）はすべて赤。
- 足したテスト：gs 10b（Codex は 2 本目の用途を変えて `PURPOSE_REVISION_CANDIDATE` を確かめたが、同じ中身の場合が無かった。確かめた結果は `DUPLICATE_CONTENT` で転記 0 行）。
- 後回し（Low）：既存の `sheetsReadWithRetry_`（`01`）は 500・503 が 4 回続くと、5 回目の待ち時間の計算で `computeBackoffMs(4)` が `RangeError` を投げる（引数は 1〜3 しか受けない）。元のエラーの代わりに `RangeError` で止まるだけで、例外で止まる（安全側）のは同じ。今回の変更の前からある。

## 10. 受入の結果

- 2026-11-06 診断の再実行：1 人目の顧客の 76 本すべてで、判定・件数・読めない行・用途の値が 11-03 と同じ（判定 32・不明 42・フォルダ 1・PDF 1、時間の枠で止まらず）。本物の Sheets API で中身ハッシュの読取が通った。
- 2026-11-07 21:11 TEST01 の auカードで受入合格：利用者が取込待ちの Excel を Google スプレッドシートとして保存し、元の Excel をフォルダの外へ移して記帳。Google スプレッドシート（Drive の版なし＝バイナリでない）が `aupay_family_x6` で判定され、読取 1・除外 21・自動転記 1・要確認 0・エラー 0 で `COMPLETED`、名前は `【済】`。書込直前の番人が `FILE_CHANGED` を出さなかった＝本物の Google で中身ハッシュが 2 回とも一致した。リースは残っていない。
- 気付き（今回の変更とは別）：元の Excel の名前に `【要修正】` が残っていたので、変換した写しも `【要修正】au202509` で登録された（恒久ファイルインデックス C 列）。名前の付け替えは接頭辞を外してから付けるので、Drive の名前は `【済】au202509` で正しい。

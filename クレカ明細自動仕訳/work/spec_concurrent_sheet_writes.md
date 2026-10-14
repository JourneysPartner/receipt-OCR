# K-W24 共有シートの書き方を並列でも安全にする 仕様書（§15-10 の 1 段目）

版：1.1（2026-10-14）

- 1.1（2026-10-14、Codex の 1 回目の停止と私の差分の確認を受けて）：**§2.5 を取り下げた**（リース表の行は今までどおり SpreadsheetApp の `deleteRow` で消す。理由は §2.5）。kw24 9・17 と M12・M13 をそれに合わせた。§3 の「直してよい既存のテスト」に 2 つを足した ── `rc 8`（読取の上限 6 → 7。§2.3-4 で増えると決めた 1 回が、`rewindFileForReimportAudited_` の `appendAudit` に当たる）と `INV-21/29`（模擬の「追記の直前」の仕掛けが、`appendRow` だけでなく `setValues` での追記でも働くようにする。テストの中身と期待は変えない）。
- 1.0（2026-10-14）：初版。
対象：`src/01_DataAccessCore.gs`・`src/11_FileStateManager.gs`・`src/43_SheetWriter.gs`・`src/45_DestinationIndex.gs`・`src/50_ReviewStore.gs`・`src/55_PartnerBatchResolution.gs`・`src/62_AuditLog.gs`。
発端：`work/spec_webapp.md` §15-10（取込の並列化）。2026-10-14 夜の調査で、並列にすると壊れ得る箇所が 10 見つかった（§1）。

## 0. 決めたこと（ko-ch さん、2026-10-14）

1. **§15-10 を 3 段に分ける。**1 段目（本書）＝共有シートの書き方を、2 つの実行が同時に動いても安全な形にする。2 段目＝同じ中身のファイル・用途だけ直したファイルの二重取込の判定をロックの中へ移す。3 段目＝2 本並列にする。段ごとに監査と本番反映をする。
2. **1 段目は利用者に見える変化を作らない。**画面・速さ・帳簿の中身は変わらない。担当者 2 人が同時に操作したときの穴も塞がる（いまは 1 人で使っているので表に出ていない）。

## 1. 調べて分かったこと（2026-10-14、公式資料とコード）

### 1.1 公式資料で確かめたこと

- **Lock.releaseLock**（developers.google.com/apps-script/reference/lock/lock、2026-04-13 更新）：「Note that if you are working with a spreadsheet, you should call SpreadsheetApp.flush() prior to releasing the lock, to commit all pending changes to the spreadsheet while you still have exclusive access to it.」── **ロックを外す前に flush せよ。**SpreadsheetApp の書込は実行の終わりまでまとめて保留され得る（SpreadsheetApp.flush の説明、同日更新）。
- **Sheets API の要求は原子的に適用される**（developers.google.com/workspace/sheets/api/limits、2026-09-03 更新：「All Sheets requests are applied atomically.」）。読取の割当は「データを取り出すあらゆるメソッドの呼出し」を 1 回と数える ── `spreadsheets.get` も 1 回。
- **公式に保証が無いこと**（Web 版 ChatGPT の調査でも裏付けが見つからなかった）：別の実行が書いて確定した内容を、長く動いている実行の SpreadsheetApp の読取（`getLastRow()`・`getMaxRows()`・`getValues()`）が必ず返すか。`flush()` が読取の控えを捨てるか。Apps Script には書込と先読みの控え（write caching・look-ahead）があることだけは公式に書かれている（Best Practices、2026-09-03 更新）。

**本書の方針：**ロックを外す前に必ず flush する。**行の位置・末尾・行数のように、間違えると他人の行を壊すものは、ロックの中で Sheets API で読んで決める。**SpreadsheetApp の見え方は「古いかもしれない」と扱う。ただし、このシステムの共有シートは（リース表を除き）**行を消さない**ので、SpreadsheetApp の `getMaxRows()`・`getLastRow()` は「本当の値以下」にしかずれない。**「足りている」という答えは信じてよく、「足りない」という答えだけを API で確かめ直す。**

### 1.2 コードを読んで見つけた穴（1 段目で塞ぐもの）

1. **ロックを外す前に flush しない。**`withScriptLock_`（`01` 101 行）は `try { return callback(); } finally { lock.releaseLock(); }` だけである。ロックの中の SpreadsheetApp の書込 ── リース表の `appendRow`・`deleteRow`（`11`）、監査の `appendRow`・`setValues`（`62`）、要確認の `appendRow`・`setValues`（`50`）、取引ログの `setValue`（`61` の状態・置き場の更新）── が、ロックを外した後まで保留され得る。別の実行はロックを取ってから読むが、相手の書込がまだ届いていない。転記先の行予約（`45` 211 行）と `ensureRowExists_`（`01` 656 行）だけは自分で flush している。
2. **行を足す位置が SpreadsheetApp の行数頼み。**`ensureRowExists_`（`01` 653 行）は `sheet.insertRowsAfter(sheet.getMaxRows(), …)` で行を足す。`getMaxRows()` が古い（小さい）と、**相手が足した行の途中に空行を差し込み、相手の行を下へずらす。**処理ログ・恒久ファイルインデックス（`60` 249 行）、取引ログ・取引インデックス（`61` 379 行）、要確認（`50` 320 行）、監査（`62` 76 行）が全部ここを通る。行が足りなくなると毎回足すので（足すのはちょうど足りない分だけ）、本番のシートはほぼ常にこの経路を通る。
3. **監査の末尾が SpreadsheetApp 頼み。**`appendAuditUnlocked_`（`62` 33 行）は `getLastRow()` と `getRange(lastRow, 15).getValue()` で直前の行のハッシュを読み、`appendRow` で足す。末尾が古いと**連鎖が枝分かれする**（2 行が同じ「直前のハッシュ」を持つ）。`appendAuditRowsUnlocked_`（53 行）は `getLastRow() + 1` へ `setValues` で書くので、末尾が古いと**相手の監査行を上書きする。**
4. **要確認の追記位置が SpreadsheetApp 頼み。**`registerPendingReviews`（`50` 319 行）は `sheet.getLastRow() + 1` へ `setValues` で書く。末尾が古いと**相手の要確認行を上書きする**（要確認の無い `REVIEW_REQUIRED` の取引が残り、誰も確定できなくなる）。同じロックの中で `allReviewRecords_()`（Sheets API）で全行を読んでいるのに、位置はそれを使っていない。
5. **リース表の行の削除が SpreadsheetApp の `deleteRow`。**行番号はロックの中の Sheets API の読取（`activeLeases_`）で決めている。§2.1 の flush で、消した結果は相手がロックを取る前に届く。**1.1 で、ここは変えないことにした**（§2.5）。
6. **転記先の行予約の範囲と、行を足す位置が `getMaxRows()` 頼み。**`reserveDestinationRows`（`45` 150 行）の `buildIndex(customer)` は範囲の終わりを `sheet.getMaxRows()` で決め、足りなければ `expandTemplateRows`（`43` 105 行）が `insertRowsAfter(sheet.getMaxRows(), …)` で足す。古いと**相手が予約・書込した行の途中に行を差し込み、相手の行をずらす**（相手の取引ログの行番号が別の行を指す）。予約の前の確かめ（`45` 193〜199 行）と拡張の確かめ（`43` 119 行・152〜155 行）は SpreadsheetApp の `getValues()`・`getFormulas()` で読む。予約の書込（205 行）も SpreadsheetApp である。

### 1.3 1 段目で塞がないもの（2 段目・3 段目）

- 同じ中身のファイル 2 本・用途だけ直したファイルの二重取込（重複判定がロックの外。2 段目）。
- 前検査が相手の取込中のファイルを見て誤報する、読取の枠の分け方、ロック待ち 20 秒、準備の呼出し、画面の割り振り（3 段目）。

## 2. 直すこと

### 2.1 ロックを外す前に flush する（`01` `withScriptLock_`）

1. 成功したとき：`callback()` の戻り値を受け取る → `SpreadsheetApp.flush()` → `lock.releaseLock()` → 戻り値を返す。
2. **flush が投げたとき**：ロックを外してから、その例外をそのまま投げる（書込が確定したと言えないので、成功として返さない）。
3. `callback()` が投げたとき：`SpreadsheetApp.flush()` を試み（**flush の例外は握りつぶす** ── 元の例外を隠さない）、ロックを外し、**元の例外を**投げ直す。途中まで書いた SpreadsheetApp の変更は、どのみち後で反映される。ロックを持っている間に反映させるほうが安全である。
4. ロックを取れなかったときは今と同じ（flush もしない）。
5. コメントに §1.1 の公式の注意（日付つき）と、「flush を呼出側の責任にすると必ずどこかで漏れるので、ロックの口で必ず行う」理由を書く。
6. `LOCK_TIMEOUT_MS`・入れ子を拒む模擬ロックの振る舞い・ロックを取る場所は変えない。

### 2.2 行は本当の末尾にだけ足す（`01` `ensureRowExists_`）

```
function ensureRowExists_(sheet, rowNumber) {
  if (rowNumber <= sheet.getMaxRows()) return;            // 小さくしかずれないので「足りている」は正しい
  var actual = apiSheetRowCount_(sheet);                  // Sheets API で本当の行数を読む（読取 1）
  if (rowNumber <= actual) return;
  sheet.insertRowsAfter(actual, rowNumber - actual + ROW_GROWTH_SLACK_);
  SpreadsheetApp.flush();
}
```

1. **`apiSheetRowCount_(sheet)`**（新規、`01`）：`Sheets.Spreadsheets.get(spreadsheetId, {ranges: [quoteSheetName_(name)], fields: 'sheets(properties(title,gridProperties(rowCount)))'})` で行数を読む。応答の中から `title` が一致するシートを選ぶ（無ければ投げる）。**読取の口を通す**：`paceSheetsRead_()` で待ち、`apiReadCount_` を 1 増やし、429・500・503 は `sheetsReadRanges_` と同じ方針で待って繰り返す（待った時間・回数も同じ変数に足す）。繰り返しの処理は `sheetsReadRanges_` と共通にしてよい。
2. **`ROW_GROWTH_SLACK_ = 500`**（新規、`01`）。行が足りないときは、足りない分に 500 行を足して挿す。いまは「ちょうど足りない分だけ」足すので、一度いっぱいになったシートは追記のたびに行を足し、そのたびに 1 の読取が要ることになる ── 余白を持たせて、行を足す（＝読む）回数を 500 行に 1 回程度にする。足した空行は、どの読取も末尾の空行として落とす（`sheetRowsFromValues_`・`lastDataRowFromValues_`）。
3. **前提をコメントに書く**：この関数は**行を消さないシートにだけ使う**（処理ログ・恒久ファイルインデックス・取引ログ・取引インデックス・要確認・監査・`04` の初期設定のマスター）。行を消すリース表に使うと「足りている」が正しくなくなる。転記先には使わない（転記先は雛形の行を複製して足す。§2.6）。
4. 挿す位置は**本当の末尾**（`actual`）である。`getMaxRows()` が古くても、相手の行の途中には挿さない。

### 2.3 監査の末尾は Sheets API で読む（`62`、`11` のリース解放、`55`）

1. **末尾の読取**（新規、`62`）：`auditTailRange_(sheet)` が窓の範囲を作り、`auditTailFromValues_(start, values)` が窓の値から末尾を決める。
   - 窓の始まり `start = Math.max(2, sheet.getLastRow())`（SpreadsheetApp の値は本当の末尾以下なので、下限として使う）。窓は `A{start}:O{start + AUDIT_TAIL_WINDOW_ - 1}`、`AUDIT_TAIL_WINDOW_ = 200`。
   - 窓の中で A 列（監査ID）が空でない最後の行を末尾とする。**窓の最後の行まで埋まっていたら**、次の窓（`start + 200` から）を読んで続ける。
   - 窓に 1 行も無く `start === 2` なら、監査行は 1 行も無い（起点を書く必要がある）。
   - 窓に 1 行も無く `start > 2` なら、SpreadsheetApp の値が本当より大きい ── 監査行は消さないので起きないはずだが、**黙って進めない**：A 列と O 列を 2 行目から全部読み直して末尾を決める（読取 1。まれ）。
   - 返す形：`{lastRow: <末尾の行番号。無ければ 1>, lastHash: <その行の O 列。無ければ null>}`。
2. **`appendAuditUnlocked_(entry, forceGenesis, knownTail)`・`appendAuditRowsUnlocked_(entries, knownTail)`**：`knownTail` が無ければ 1 の読取で末尾を決める（読取 1）。末尾が無く `forceGenesis` でなければ、今と同じ形の起点の行（`CHAIN_ANCHOR`・`GENESIS`）を先に置く。直前のハッシュは末尾の行の O 列（起点を置いたなら起点の行のハッシュ）。行は**末尾の次の行から**、`ensureRowExists_` で行を確保してから `sheet.getRange(firstRow, 1, n, AUDIT_WIDTH_).setValues(rows)` で書く（SpreadsheetApp。値の解釈は今の `appendRow`・`setValues` と同じにするため、Sheets API へ移さない）。戻り値は今と同じ（監査ID・監査IDの配列）。`appendRow` は使わなくなる。
3. **読取を増やさない場所**：同じロックの中で既にマスターを読んでいる箇所は、その読取に監査の窓を同じ `batchGet` で相乗りさせ、`knownTail` として渡す。
   - `11` のリースを消す 4 つ（`releaseLease`・`releaseLeaseById`・`forceReleaseLease`・`releaseInvestigatedLease`）：リース表の読取（`activeLeases_` と同じ範囲）と監査の窓を 1 回で読む補助（例：`activeLeasesAndAuditTail_()`）を作って使う。`releaseLease` で消す行が複数なら、監査行は `appendAuditRowsUnlocked_` で 1 回で書く（行ごとに末尾を読み直さない）。
   - `55` の確定のロックの中（`allReviewRecords_()` の読取、507 行付近）：要確認の読取に監査の窓を相乗りさせ、540 行付近の `appendAuditRowsUnlocked_` に渡す。
   - 相乗りの窓が埋まっていた（続きが要る）ときは、続きの窓を読む（読取 1。まれ）。
4. **それ以外の監査の書込**（`appendAudit`・`appendAuditBatch` を通るもの）は、末尾の読取で 1 回増える。取込の 1 ファイルの経路には無い（取込の監査行はリースの解放だけ）。
5. 連鎖の検証（`verifyChain`・`getLastAnchorRow`）は変えない（読むだけ・知らせるだけ）。

### 2.4 要確認の追記位置はロックの中の読取で決める（`50`）

1. `registerPendingReviews`：ロックの中の `allReviewRecords_()` の結果から末尾の行（行が無ければ 1）を求め、その次の行から書く。`sheet.getLastRow()` は使わない。書込は今と同じ `setValues`（SpreadsheetApp）、行の確保は `ensureRowExists_`。
2. `registerReview`（1 件）：同じロックの中で読んでいる `allReviewRecords_()` から末尾を求め、`ensureRowExists_` → `getRange(行, 1, 1, REVIEW_SHEET_WIDTH_).setValues([row])` で書く。`appendRow` は使わなくなる。
3. 読取の回数は変わらない（もう読んでいる結果を使うだけ）。
4. 末尾は A〜AF 列（`REVIEW_SHEET_WIDTH_` = 32 列）の範囲で決める。それより右の列にだけ何かがある行は空の行として扱う（いまの `registerPendingReviews` の `getLastRow()` は全列を見るので、ここだけ狭くなる。要確認シートの AG 列より右にはシステムは何も書かない）。

### 2.5 リース表の行の消し方は変えない（`11`）（1.1 で取り下げ）

1.0 では `deleteRow` を Sheets API の `deleteDimension` に置き換えるとしたが、**取り下げる。**リースを取る `acquireLease` は SpreadsheetApp の `appendRow`（位置を決めるのは SpreadsheetApp の側）で行を足す。同じ実行の中で、API で行を消した後に SpreadsheetApp が「最後の行」を正しく知っている保証は無い。知らないまま足すと空行が 1 行挟まり、`activeLeases_` が「ACTIVE でない行がある」で止まる。これは並列にしなくても、1 本ずつの取込（1 ファイル目を解放 → 2 ファイル目を取得）で起こり得る、**今は無い組合せ**である。リース表への書込は今までどおり SpreadsheetApp だけで行う（同じ実行の中の見え方が自分の書込と食い違わない）。

1. `releaseLease`・`releaseLeaseById`・`forceReleaseLease`・`releaseInvestigatedLease` は、今までどおり `leaseSheet_().deleteRow(行)` で消す。行番号はロックの中の Sheets API の読取（§2.3-3 の相乗りの読取）で得たもの。複数行は行番号の大きい順に消す（今と同じ）。
2. 監査行を書いてから消す順は今と同じ（監査が先）。
3. `acquireLease` の `appendRow`・`renewHeartbeat` は変えない。
4. 並列（3 段目）で、見え方の古い実行の SpreadsheetApp が行番号どおりに消すかは、§7 の「残る仮定」に含めて 3 段目の実機の受入で確かめる。

### 2.6 転記先の行予約と拡張は Sheets API の読取で決める（`45`・`43`）

1. `reserveDestinationRows`（ロックの中）：
   - 索引は今と同じ `buildIndex(customer)`（範囲の終わりは `getMaxRows()`）でよい ── 古くても小さくしかずれず、見えない末尾の行（相手が使った行・相手が足して余った行）を空き行として使わないだけで、壊さない。
   - **予約の前の確かめ（今の 193〜199 行）は、SpreadsheetApp で読み直さず、いま作った索引の値と数式で行う**（`getAllValuesByRow`・`getFormulasByRow` と `isDestinationRowEmpty`）。同じロックの中の Sheets API の読取なので、読み直しより新しい。
   - **予約の書込（今の 205 行）は Sheets API の `values.batchUpdate`（`RAW`）で行う。**連続行ごとに 1 範囲、全部を 1 回の要求にまとめる。直後の flush（211 行）は要らなくなる（拡張の後の flush は `expandTemplateRows` が持つ。ロックの口の flush も §2.1 で入る）。コメントの「予約は SpreadsheetApp で書いた」を直す。
2. 行が足りないとき（`plan.action === 'EXPAND'`）：
   - **本当の行数 `actual` を `apiSheetRowCount_(sheet)` で読む（読取 1。拡張するときだけ）。**
   - **`actual` が索引の範囲の終わり（`index.rangeEnd`）より大きければ**、見え方が古かった。`buildIndex(customer, {endRow: actual})` で索引を作り直し（読取 2）、空き行と `planTemplateExpansion` を**作り直した索引で求め直す。**本当は空き行が足りていれば拡張しない。
   - それでも足りなければ拡張する。`expandTemplateRows(customer, sheet, shortage, templateHint, context)` に、`actual` と索引を渡す。挿す位置は**本当の末尾**（`insertRowsAfter(actual, shortage)`）。複製元の既定（`templateHint` が無いとき）は `actual` 行目（今の `getMaxRows()` 行目と同じ意味）。**複製元の値の確かめ（今の 119 行の `getValues()`）は索引の値で行う**（ここまでで索引は 1〜`actual` を覆っている）。
   - 拡張の後の索引は `buildIndex(customer, {endRow: actual + shortage})` で作り直す（今の 180 行と同じ読取 2）。**拡張した行の確かめ（今の 152〜155 行の `getValues()`・`getFormulas()`）は、作り直した索引の値と数式で行う**（`validateExpandedRows` に索引から取り出した行を渡す）。
   - 複製（`copyTo`）・システム列の消去（`clearContent`）・flush は今と同じ SpreadsheetApp で行う（数式・書式・入力規則の複製は 4.23 の使い分けどおり）。
3. `expandTemplateRows` を他から呼ぶ箇所があれば、同じ形で本当の行数を渡す（無ければ報告する）。
4. 予約と拡張の停止条件（`INVALID_TEMPLATE_SOURCE`・`DESTINATION_TEMPLATE_ROW_NOT_EMPTY`・`planTemplateExpansion` の `STOP`）と、その文言は変えない。

## 3. 変えないこと

- 画面（`81`）・取込の流れ（`70`・`71`・`80`）・状態の遷移・リース表の列・監査行の種類と中身・要確認行の中身・帳簿に書く値。
- **取込の 1 ファイルの読取回数**（`budget 1`・`multi 14`・`bulk 1`・`kw9` の読取の数・`scope 1〜3`・`phase6-round-trips` の読取）。行を足すとき・転記先を拡張するときだけ 1 増える（余白で、まれにする）。
- 連鎖の検証・`getLastAnchorRow`・`verifyChain`。
- 位置をサーバーが決める追記（`acquireLease`・`34` の辞書・`56` の承認依頼の `appendRow`）。§2.1 の flush で相手から見えるようになる。`04` の初期設定（並行して動かない）。
- `62` の中で §2.3 の 2 つの関数を通らずに監査行を書く箇所があれば、直さずに報告する。
- `acquireLease`・`assertLeaseHeldForWrite`・`activeLeases_` の形、`LOCK_TIMEOUT_MS`。
- **既存のテストの期待（assert）。**ただし次の 2 つだけは、ロックの口の flush（§2.1）が数に混ざるので、**元の意味を保つ形に**直してよい（直したら報告する）：
  - `flush 2`（`phase6-round-trips`）：比べる flush の回数から、ロックを外した回数（模擬ロックの `releaseCount` の増分）を引いてから割合を見る。0.7 の割合は変えない。
  - `ops menu 48`（`phase7-menu-operations`）：往復の合計から、同じ操作の間にロックを外した回数を引いてから比べる。100 の上限と「3 件と 12 件で同じ」は変えない。
  - **（1.1）`rc 8`**（`phase8-webapp`）：読取の上限を 6 から **7** にする。増える 1 回は、再検査の最後の `appendAudit`（`97` の `rewindFileForReimportAudited_`）が監査の末尾を Sheets API で読む分である（§2.3-4 で増えると決めたもの）。テストのコメントに K-W24 の理由を 1 行足す。書込の先がマスターだけであることの確かめは変えない。
  - **（1.1）`INV-21/29: a nested concurrent audit append cannot branch the chain`**（`phase2-data-access`）：**テストは変えない。**模擬（`test/gas-stubs.js`）の `setBeforeAppendHook` の仕掛けを、`appendRow` に加えて、**そのシートの末尾（内容のある最後の行）より下から始まる `setValues` の書込**の直前にも働くようにする（1 回働いたら消える、は今と同じ）。監査の追記を `setValues` に変えた後も、「追記の最中に入れ子の監査追記を試みると `LEASE_CONFLICT`」を確かめ続けるためである。
  ほかの既存のテストが赤になったら、変えずに止めて報告すること。

## 4. テスト（`kw24 N: …`）

置き場所は新しいファイル `test/phase4-concurrent-writes.test.js` を基本とする（既存の準備の補助が要るなら、そのファイルに置いてよい。置いた場所を報告する）。

**古い見え方の作り方**：模擬（`test/gas-stubs.js`）に、SpreadsheetApp の `getMaxRows()`・`getLastRow()` だけが**古い値を返す**ようにする操作を足す（例：`control.setStaleSpreadsheetAppView(spreadsheetId, sheetName, {maxRows, lastRow})`・`clearStaleSpreadsheetAppView()`）。Sheets API（`values.batchGet`・`spreadsheets.get`）は本当の値を返す。「別の実行が書いた行」は、模擬のシートへ直に書いて作る。

1. **kw24 1（ロックの口で flush）**：`withScriptLock_` の中で、`SpreadsheetApp.flush` が**ロックが掛かった状態で**呼ばれ、その後にロックが外れる。成功・中身が投げた・flush が投げた、の 3 通り：成功は戻り値が返る。中身が投げたときは flush を試み、ロックが外れ、**中身の例外**が投げられる（flush も投げる場合でも中身の例外）。flush が投げたときはロックが外れ、flush の例外が投げられる。ロックが取れないときは flush しない。
2. **kw24 2（行の確保：足りている）**：`getMaxRows()` が足りていると言うとき、`spreadsheets.get` を呼ばない（読取 0）・行を足さない。
3. **kw24 3（行の確保：見え方が古い）**：本当の行数 1,000、5 行目〜1,000 行目に「別の実行の行」、SpreadsheetApp の `getMaxRows()` は 800 を返す。`ensureRowExists_(sheet, 900)` → `spreadsheets.get` を 1 回読み、**行を足さない**。どの行の中身も位置も変わらない。`ensureRowExists_(sheet, 1,010)` → 1,000 行目の後ろに `10 + 500` 行を足す。1〜1,000 行目の中身と位置は変わらない。
4. **kw24 4（`apiSheetRowCount_` は読取の口を通る）**：呼ぶと `apiReadCount_` が 1 増え、枠が埋まっていれば待つ（`paceSheetsRead_` の待ちが記録される）。429 を 1 回返すと待って繰り返し、2 回目で値を返す。
5. **kw24 5（監査：末尾が古い）**：監査行 10 行（2〜11 行目、連鎖が正しい）。そこへ「別の実行」が正しく連鎖した 3 行を直に足す（12〜14 行目）。SpreadsheetApp の `getLastRow()` は 11 を返す。`appendAudit(…)` → 新しい行は **15 行目**、直前のハッシュは 14 行目の O 列。2〜14 行目は変わらない。`verifyChain('FULL').ok === true`。
6. **kw24 6（監査：まとめ書き）**：5 と同じ状態で `appendAuditBatch([3 件])` → 15〜17 行目に書かれ、連鎖が続き、2〜14 行目は変わらない。
7. **kw24 7（監査：窓をまたぐ）**：末尾が窓（200 行）の外にあるように古い値を返す（例：本当の末尾 450、`getLastRow()` は 10）→ 窓を続けて読み、451 行目に書く。
8. **kw24 8（監査：1 行も無い）**：監査シートが見出しだけのとき `appendAudit` → 2 行目に起点、3 行目に記録。今と同じ形（`verifyChain('FULL').ok`）。
9. **kw24 9（リースの解放は読取 1 回）**：`releaseLeaseById`・`releaseLease`（2 行）・`forceReleaseLease`・`releaseInvestigatedLease` のそれぞれで、ロックの中の読取（`batchGet`）が **1 回**（リース表と監査の窓を相乗り）。監査行が正しく連鎖して書かれ、正しい行（だけ）が消える（消し方は今と同じ `deleteRow`）。
10. **kw24 10（リースの解放：位置が動いた）**：リース 3 行（A・B・C）。ロックの外で「別の実行」が A の行を消した（模擬のシートから直に消す）後に、C を `releaseLeaseById` → **C だけ**が消え、B は残る。
11. **kw24 11（要確認：末尾が古い）**：要確認 5 行（2〜6 行目）。「別の実行」が 3 行を直に足す（7〜9 行目）。SpreadsheetApp の `getLastRow()` は 6 を返す。`registerPendingReviews([2 件])` → 10〜11 行目に書かれ、2〜9 行目は変わらない。続けて `registerReview(1 件)` → 12 行目（2〜11 行目は変わらない）。
12. **kw24 12（要確認：読取は増えない）**：`registerPendingReviews` のロックの中の読取が 1 回のまま（直す前と同じ数を実測して固定する）。
13. **kw24 13（予約：SpreadsheetApp で読まない・書かない）**：`reserveDestinationRows`（拡張なし）の間、転記先のシートで SpreadsheetApp の `getValues`・`getFormulas`・`setValues` が呼ばれない（包んで数える）。予約の取引ID列は Sheets API の 1 回の `batchUpdate` で書かれる。予約の結果（行と取引IDの対応）は今と同じ。
14. **kw24 14（予約：見え方が古い）**：転記先の本当の行数 30、20〜30 行目は「別のファイル」が予約・書込した行（取引ID と値あり）、SpreadsheetApp の `getMaxRows()` は 19 を返す、索引の範囲（1〜19）の空き行は 2 行。5 件を予約 → 本当の末尾（30 行目）の後ろに 3 行を足して使う。**20〜30 行目の取引ID・値・位置は変わらない。**新しい予約は「別のファイル」の行と重ならない。
14b. **kw24 14b（予約：見え方が古く、空き行が隠れていた）**：14 と同じだが 20〜30 行目は**空き行**（雛形の数式あり・システム列は空）。5 件を予約 → 索引を 1〜30 で作り直し、**拡張せずに**空き行へ予約する（`expanded` が空、行は 30 を超えない）。
15. **kw24 15（予約の拡張：読取は 1 増えるだけ）**：拡張しない予約の読取（`batchGet`＋`spreadsheets.get`）は直す前と同じ。見え方が新しい状態で拡張する予約は、直す前より `spreadsheets.get` の 1 回だけ多い。直す前の数を実測して固定する。
16. **kw24 16（拡張の停止条件は今と同じ）**：既存の `M30`（`phase3-importflow`）の 2 本が緑のまま、かつ見え方が古い（`getMaxRows()` が小さい）状態でも同じ結果になる（複製元は数式を持つ空き行・最下行の合計は `DESTINATION_TEMPLATE_ROW_NOT_EMPTY`）。
17. **kw24 17（使う場所の決まり）**：`src/*.gs` を読み（`97_Ops.gs` はバイトのまま読んでから文字列にする）、`ensureRowExists_(` の呼出しにリース表（`leaseSheet_()`）を渡す箇所が無い。`62`・`50` に `getLastRow() + 1`・`appendRow(` が無い。`11` に `Sheets.Spreadsheets.batchUpdate` が無い（リース表は SpreadsheetApp だけで書く。§2.5）。`45` の `reserveDestinationRows` に `getValues()`・`getFormulas()`・`setValues(` が無い。

## 5. 変異（M1〜M18）── それぞれ赤になるテストを記録する

- M1：`withScriptLock_` の flush を消す
- M2：flush をロックを外した後へ動かす
- M3：中身が投げたときに flush しない
- M4：中身が投げたとき flush の例外で元の例外を上書きする
- M5：`ensureRowExists_` が `getMaxRows()` の位置へ挿す（今の形へ戻す）
- M6：`ensureRowExists_` が「足りない」のとき API を読まずに挿す
- M7：余白 `ROW_GROWTH_SLACK_` を 0 にする
- M8：監査の末尾を `getLastRow()` で決める（今の形へ戻す）
- M9：監査の窓の続きを読まない（窓の最後まで埋まっていても止まる）
- M10：監査のまとめ書きを `getLastRow() + 1` へ戻す
- M11：リース解放の監査の窓を相乗りさせない（読取が 2 回になる）
- M12：（1.1 で取り下げ。§2.5）
- M13：`releaseLease` の複数行の `deleteRow` を小さい順にする（2 行目が別の行を消す）
- M14：`registerPendingReviews` の位置を `getLastRow() + 1` へ戻す
- M15：予約の前の確かめを SpreadsheetApp の `getValues()` に戻す
- M16：拡張の位置を `getMaxRows()` へ戻す
- M17：拡張の後の索引を `endRow` なしで作り直す（拡張した行が索引に入らない）
- M18：`actual` が索引の範囲より大きくても、索引を作り直さずに拡張する

赤にならない変異があれば、テストを足して赤にできるか試し、足したものを報告する。

## 5.1 実装と監査の記録（2026-10-14）

- **Codex 1 回目**（指示書 `work/codex_prompt_concurrent_sheet_writes.txt`、ログ `tools/codex-logs/*-20261014-200925-*`）：開始時 1510/1510。kw24 を書いて赤 23・緑 6 を確かめてから実装。既存の `INV-21/29`（模擬の `appendRow` だけに掛かる仕掛け）と `rc 8`（読取 6 → 7）が赤になり、**指示どおり止まった**（どちらも仕様書の私の見落とし）。
- **私の差分の確認**：`withScriptLock_`・`ensureRowExists_`・`apiSheetRowCount_`・監査の窓・要確認の位置・予約と拡張は仕様どおり。**§2.5（リース表を `deleteDimension` で消す）は私が取り下げた**（同じ実行で API で行を消した後に SpreadsheetApp の `appendRow` で足す組合せは今は無く、保証が無い。空行が挟まると `activeLeases_` が止まる）。→ 1.1。
- **Codex 2 回目**（ログ `*-20261014-203635-*`）：1.1 の回答どおり `rc 8` を 7 に、模擬の追記の仕掛けを `setValues` の追記にも、リース表を `deleteRow` に戻した。M1〜M18（M12 は取り下げ）すべて赤。終了 1539/1539。
- **私の監査**：src の差分は 7 ファイルだけ、既存テストの変更は認めた 4 つ（`flush 2`・`ops menu 48`・`rc 8`・`INV-21/29` の模擬）だけ。97 は開始時と同一（NUL 2）、7 ファイルとも LF・BOM なし、`???` 0、U+FFFD は src 0・test は元からの 1。**私の変異 X1〜X17 のうち 5 つがすり抜けた** ── X3（`ensureRowExists_` の境目 `<=` → `<`）・X5（監査の末尾が大きく見えるときの読み直しを外す）・X6（窓の始まりの `Math.max(2, …)` を外す）・X8（`55` が窓を渡さない）・X13（`allReviewRecordsAndAuditTail_` が窓の値を使わない）。テストを 4 本足した：`kw24 3b`・`kw24 7b`・`kw24 7c`（`phase4-concurrent-writes`）・`kw24 12b`（`phase6-partner-decisions`。まとめ確定のロックの中で監査の末尾を別に読まないこと）。5 つとも足したテストで赤になる。終了 **1543/1543**。テストの中の計測用の `console.log` 3 行は消した。
- 気づいたこと（範囲外）：`fmt 112`（`phase9`）は、4 並列で全体を回したときに 1 回だけ赤になり、単独では緑（時間に依存して揺れるテスト）。

## 6. 受入（実機）

0. push の前：本番の master の各シート（処理ログ・恒久ファイルインデックス・取引ログ・要確認・監査）と取引インデックスのシートの行数を記録しておく（`opsShowSheetSizes` のような読むだけの関数が無ければ、push 後の比較は 1 ファイル取込の前後の差だけでよい）。
1. F5 で開き直し、Web アプリで取込 1 回（1〜2 ファイル）・要確認の確定 1 回。
2. `opsShowLeases` が `(リースなし)`。
3. 監査の連鎖の検証（次の［記帳を実行］の最初の呼出しで走る `verifyChain('RECENT')`）が `BROKEN_NOTIFY_ONLY` を出さない（`IMPORT_CALL`・通知で確かめる）。
4. `IMPORT_CALL` の 1 ファイルの読取が gas-push-114 と同じ（行を足した呼出しだけ +1 があり得る）。

## 7. 2 段目・3 段目への申し送り

- 2 段目：重複の判定を `updateProcessLogAndContentHash_` のロックの中で（恒久ファイルインデックスを同じ `batchGet` で読み、先に書いたほうを原本にする）、用途修正版の判定を `registerPrepared` のロックの中で（取引インデックスを読み直し、見つかれば区分 2 へ組み直す）。
- 3 段目：準備の呼出し（複製・全体の前検査）、画面の待ち行列から 2 本へ割り振る、各本の読取の枠を 27 に分ける（窓の控えを本ごとの鍵にする）、前検査から相手の取込中のファイルを外す、ロックの中では読取の均しの待ちを入れない、ロック待ちを 60 秒に。
- 1 段目で残る仮定（3 段目の実機の受入で確かめる）：SpreadsheetApp の書込（`insertRowsAfter`・`copyTo`・`setValues`・リース表の `deleteRow`・`appendRow`）は、行番号どおりにサーバーの今の状態へ当たる。見え方が古い実行で範囲外と拒まれる場合は、例外で止まる（安全側）。確かめて成り立たなければ、そのシートへの書込を Sheets API だけにまとめる（リース表なら削除を `deleteDimension`、取得を `values.append` に。同じシートで SpreadsheetApp と API の行の増減を混ぜない）。

# 整合性チェックが取引の居る転記先を見る 仕様書（`spec_webapp.md` §15-3、K-W9）

対象システム：クレジットカード明細 自動仕訳システム（Google Apps Script、リポジトリ `クレカ明細自動仕訳`）
作成日：2026-10-01
版：1.0

改訂履歴：
- 監査（2026-10-02、1.0 の実装）：1304/1304 緑（開始 1289）、§5 の M1〜M18 すべて赤、src の差分は 44・45・71・97 だけ、97 の NUL 2 個、既存テストの差分なし。Claude の変異 7 個のうち 6 個がすり抜けた ── 開けない転記先の取引数が増えない・全複製の検査がファイル状態を見ない・`totals.findings` を足さない・前検査の索引が FORMULA を読む・容量超過（429）を「開けない」に丸める・予算切れの転記先の重複（これは等価で、外から見えない）。**このうち 1 つは実装の不具合だった：`DESTINATION_UNREADABLE` の `transactions` が常に 1**（一覧が数え上げるエントリと別のオブジェクト）。直して、テスト kw9 16〜20 を Claude が足した（等価の 1 個を除き赤になることを確認）。あわせて、Codex が 97 に書いた説明コメントが `?` の羅列に化けていたのを直し（バイト単位で、NUL は 2 個のまま）、71 の古い説明コメントと、解決器の使われていない 2 メンバーを削った。
- 1.0（2026-10-01）：初版。

読者：本仕様だけを読んで実装する実装者（AI を含む）。書いていないことは実装者が決めてよいが、**書いてあることは変えない**。判断に迷ったら止めて報告する。

## 1. 何を直すか

### 1.1 いまの整合性チェックは、取引の居ない転記先を見ている

取込の前検査（`src/71_RunOrchestrator.gs` の `runCustomerIntegrityCheck_`、`runImport` の step 4）は、顧客ごとに **`buildIndex(customer, {})` を 1 回だけ**作る。この `customer` は顧客マスターの**雛形**である。ところが Web アプリは取込のたびに雛形を複製し、取引は**複製**に書かれる（取引ログ AC・AD が正本、§15-4）。前検査は範囲の取引（今回の候補・終端でないファイル）の取引ログを読み、**それを雛形の索引と突き合わせる**。結果：

| 検査（`src/44_IntegrityChecker.gs`） | 重さ | 複製に居る取引で起きること |
|---|---|---|
| `checkDuplicateDestinationRows`（`DUPLICATE_DESTINATION_ROW`） | **STOP** | 雛形に行が無いので**重複は絶対に見つからない**。複製の中の二重転記は前検査をすり抜ける。**索引に依る唯一の STOP がこれ** |
| `checkMissingDestinationRows`（`DESTINATION_ROW_MISSING`） | REVIEW | 複製に居る `COMMITTED` の取引は、雛形に行が無いので**毎回「行が無い」と誤報する** |
| `checkManualChanges`（`MANUAL_CHANGE`） | REVIEW | 雛形に行が無いので**手書き換えは見つからない** |

REVIEW の所見は `customerReport.integrity` に載るだけで、画面にも要確認にも出ない（`REVIEW_TYPE.INTEGRITY` を起票する経路は `src/` に無い）。したがって実害は、**複製の中の二重転記を検出できないこと**と、**所見が誤報で埋まっていて、本物が出ても読めないこと**である。

### 1.2 全部の複製を見る検査が無い

前検査は範囲を「今回の候補＋終端でないファイル」に絞っている（2026-09-20、固定費 221 秒を削るため）。完了済みのファイルは見ない。その代わりに「人が古い行を書き換えた場合の発見は別の定期実行の仕事である」と 71 のコメントが書いているが、**その検査は存在しない**。複製が常態の運用では、過去の転記シートの行が消えた・書き換えられたことを発見する手段が無い。

### 1.3 本仕様がすること

1. 取引ログ AC・AD（記録された転記先）で、**取引ごとに検査する転記先を決める**（§2.1〜§2.4）。前検査（取込の step 4）はこれで正しい転記先を見る。
2. 全部の複製を読むだけで検査する運用関数 `opsCheckIntegrityAllDestinations` を足す（§2.5）。**書かない。**

## 2. 設計

### 2.1 転記先ごとの索引の解決器（`src/45_DestinationIndex.gs`）

`makeDestinationIndexResolver_(customer)` を足す。`customer` は顧客マスターの行（雛形）。戻り値：

- `indexFor(tx)`：取引の物（`txLogFromRecord_` の戻り値）の**検査すべき転記先の索引**を返す。
  - 転記先の決め方：`recordedDestinationOf_(tx, customer)`（61）があればそれ（スプレッドシートID・シート名）。**無ければ（AC が空の旧い行）`customer`＝雛形**。旧い行は所在が分からないので従来どおり雛形で検査する（§15-4 の規則と同じ。雛形だと決めつけて外れた誤報は REVIEW にしかならない）。
  - 索引は `buildIndex(その転記先を当てた customer 写し, {valuesOnly: true})`（§2.2）で作り、**同じ転記先（スプレッドシートID とシート名の組）につき解決器の寿命の中で 1 回だけ**作る（結果をキャッシュする。作れなかった転記先も 1 回だけ試す）。**`indexFor` を呼ぶまで 1 つも作らない**（遅延）。
  - 転記先を**開けなかった**ときは `null` を返す。**ただし一過性の失敗は握りつぶさずそのまま投げる**：エラーの `code` が `TRANSIENT_SHEETS_ERROR` のもの、または `isSheetsQuotaError_(error)` が真のもの。それ以外（スプレッドシートが無い・権限が無い・シートが無い）が「開けない」である。
- `stats()`：`{built: 作った索引の数, unreadable: [{spreadsheetId, sheetName, transactions}]}`。`transactions` は、その転記先へ振り分けようとして `null` を返した取引の数（`indexFor` の呼び出し 1 回につき 1）。`unreadable` は最初に失敗した順。

### 2.2 `buildIndex` の `valuesOnly`（`src/45_DestinationIndex.gs`）

`buildIndex(customer, options)` に `options.valuesOnly === true` を足す。このとき **`FORMULA` の読取を行わない**（`UNFORMATTED_VALUE` の読取だけ。読取クォータ 60 回/分/ユーザーが取込の天井なので、整合性検査の読取を半分にする）。戻り値は `valuesByRow`・`byTxId` を通常と同じ値で持ち、`formulasByRow` は**空の `Map`**、`valuesOnly: true` を足す。`getFormulasByRow(index, rowNumber)` は `index.valuesOnly === true` のとき**必ず `null`** を返す（既存の「行が無ければ `null`」と同じ形）。これで `isRowEmpty` は `RangeError` を投げる（数式が無い索引で空行を判定させない ── **空と誤って答えるより止まるほうが安全**）。`valuesOnly` を指定しない呼出し（書込経路を含むすべて）は 1 文字も変わらない。

注意：`buildIndex` は 45 の末尾で `buildIndexOriginal_` を包み直して `index.columnMapping` を付けている。`options` はそのまま通るので、包みを壊さないこと。

### 2.3 `runIntegrityCheck` に `indexForTransaction` を足す（`src/44_IntegrityChecker.gs`）

`runIntegrityCheck(input)` の `input` に、**省略可**の `indexForTransaction`（`function(tx) → 索引 | null`）を足す。

- `input.index` と `input.indexForTransaction` の**どちらも無ければ**、いまと同じ `TypeError('runIntegrityCheck requires a destination index')`。`input.index` だけ（従来の呼出し）はいまと 1 文字も変わらない。
- `indexForTransaction` があるとき：`txLogs` の各取引を**1 回ずつ**その関数で振り分け、**同じ索引を返した取引ごとにまとめて**、検査 1〜3（`checkDuplicateDestinationRows`・`checkMissingDestinationRows`・`checkManualChanges`）をその索引で行う。`null` が返った取引は検査 1〜3 の対象にしない（開けなかった理由は解決器が `stats()` で持つ）。検査 4（`checkFileStateConsistency`）と検査 5（`checkPermanentIndexSync`）は**索引に依らないので、ファイル 1 件につき 1 回だけ**、`txLogs` 全部で行う（索引ごとに繰り返さない ── 同じ所見が重なる）。
- `input.index` と `input.indexForTransaction` の両方があるときは `indexForTransaction` を使う。
- 戻り値の形（`ok`・`stop`・`findings`）は変えない。検査 1〜3 の所見の順は、振り分けた索引ごとに、検査 1・2・3 の順（索引の並びは `txLogs` に最初に現れた順）。

**`runIntegrityCheck` はファイル 1 件につき 1 回だけ呼ぶ**（既存テスト `scope 1`・`scope 3` が呼出し回数を数えている。変えない）。

### 2.4 前検査（`src/71_RunOrchestrator.gs`）

`runCustomerIntegrityCheck_` の署名を `(customer, fileIdsInScope)` にする（`index` 引数を廃止）。`runImport` の step 4 の `var index = buildIndex(customer, {});` を**削る**（この `index` は他で使われていない）。処理：

1. 範囲の決め方（今回の候補＋`VALIDATING`・`WRITING`・`REVIEW_WAIT` のファイル）と、ファイルごとの取引ログの読み方（`getTransactionsByStatus` の 4 状態）・処理ログの読み方は**いまのまま**。
2. 顧客ごとに解決器を 1 つ作り（`makeDestinationIndexResolver_(customer)`）、すべてのファイルで共有する。
3. ファイルごとに `runIntegrityCheck({index: 無し, indexForTransaction: resolver.indexFor, txLogs, fileState, processLogState, permanentIndexState})` を呼ぶ。
4. すべてのファイルを見終わった後、`resolver.stats().unreadable` の各転記先について所見を 1 件ずつ足す：`{check: 'DESTINATION_UNREADABLE', severity: 'REVIEW', detail: {spreadsheetId, sheetName, transactions}}`。
5. 戻り値は `{ok, stop, findings, indexesBuilt: resolver.stats().built}`（`ok`・`stop`・`findings` の意味はいまのまま。`DESTINATION_UNREADABLE` は REVIEW なので `stop` を立てない）。

**これで起きること**：複製に居る取引は複製の索引で検査される。複製の中に取引IDが 2 行あれば `DUPLICATE_DESTINATION_ROW`（STOP）が立ち、**その顧客の取込は `INTEGRITY_STOP` で止まる**（71 の既存の分岐。Web アプリは `TEXT.integrityStop` を出す）。範囲に取引が 1 件も無ければ**索引を 1 つも作らない**（いまは毎回雛形の索引を作っている。読取が減る）。

行番号と取引ログの AE の食い違い（行が動いた）は、この検査の範囲外（いまも見ていない）。

### 2.5 全部の複製の検査（`src/97_Ops.gs` に `opsCheckIntegrityAllDestinations(customerId, options)`）

**読むだけ**。何も書かない（取引ログ・転記先・要確認・処理ログ・監査ログのどれも 1 セルも変えない。監査ログにも書かない）。

引数：
- `customerId`（省略可）：指定があればその顧客だけ。省略なら、検査対象の取引を持つ全顧客。指定した顧客が無い（`getCustomerById` が見つけない）ときは例外のままでよい。
- `options.timeBudgetMs`（省略可、既定 270000）：開始からの経過がこの値以上になったら、**新しい転記先の索引を作り始めない**。

処理：
1. 取引ログの全行を 1 回読み（`readSheetRows_(transactionLogSheet_(), TRANSACTION_LOG_WIDTH_)` → `txLogFromRecord_`）、**生きている取引**（`active` かつ状態が `PREPARED`・`WRITING`・`COMMITTED`・`REVIEW_REQUIRED`、`runCustomerIntegrityCheck_` の 4 状態と同じ）を顧客ごと・ファイルごとに分ける。ファイルの状態は恒久ファイルインデックス（`permanentIndexRowsForScan_()`）から引く（無ければ `null`）。
2. 顧客ごとに解決器を作り、ファイルごとに `runIntegrityCheck({indexForTransaction: resolver.indexFor, txLogs, fileState})`（`processLogState`・`permanentIndexState` は渡さない ── 処理ログをファイルごとに読むと往復が増える。同期検査は前検査の仕事）を呼ぶ。**範囲は絞らない**（完了済み・取消済みのファイルも見る）。
3. 時間の予算：転記先の索引を**作る前に**、予算を超えていたら作らずに止める。止めたときは、その顧客の残りの取引は検査せず、戻り値に `stoppedBy: 'TIME_BUDGET'` と、まだ作っていない転記先の一覧 `deferredDestinations: [{customerId, spreadsheetId, sheetName}]` を載せる。**`indexFor` が予算で `null` を返すのは「開けなかった」ではない**ので、`unreadable` に数えない（解決器に「予算切れ」の状態を持たせてよい）。`timeBudgetMs: 0` なら、1 つも作らずに全部 deferred になる。
4. 戻り値（`Logger.log(JSON.stringify(...))` にも出す）：
   `{customers: [{customerId, files, transactions, legacyTransactions, destinations: [{spreadsheetId, sheetName, transactions, findings: {<check>: 件数}}], unreadable: [{spreadsheetId, sheetName, transactions}], findings: {<check>: 件数}, samples: [...]}], totals: {customers, files, transactions, findings: {<check>: 件数}, unreadable}, stoppedBy: null | 'TIME_BUDGET', deferredDestinations: [...]}`
   - `destinations` は雛形（旧い行）も含む。旧い行の取引は `legacyTransactions` に数え、`destinations` では雛形の項に数える。
   - `findings` は検査名（`DUPLICATE_DESTINATION_ROW` など）ごとの件数。ファイル検査（4・5 のうち実行したもの）の所見も数える。`destinations[].findings` は索引に依る検査 1〜3 の所見だけを、その所見の取引の転記先に数える。
   - `samples`：所見のうち最大 20 件。`{check, severity, fileId, fullTxId, destinationSpreadsheetId, rowNumber, column}`（無い項目は省く）。**取引の値（`expected`・`actual`・店名・金額）は 1 つも入れない**（個人情報・取引内容を実行ログに出さない）。
   - `DESTINATION_UNREADABLE` は `unreadable` に載せ、`findings` には数えない。
5. 実行は 1 回の呼出しで 6 分の上限があるので、既定の予算は 270 秒。転記先が多い顧客は `customerId` を指定して分けて呼ぶ。

**定期実行にはしない**（本仕様の範囲外。まず手で動かして中身を見る）。メニューにも出さない。

## 3. 変えないこと

- `src/44_IntegrityChecker.gs` の検査 1〜5 の関数（`checkDuplicateDestinationRows` ほか）の中身。`runIntegrityCheck` の追加（§2.3）だけ。
- 取込の書込経路（`reserveDestinationRows`・`buildIndex` の通常の呼出し・`validateDestinationSchema`）、リース、取引ログの列、`ERROR_CATALOG`（新しい例外は作らない）。
- 54（整合性の要確認）の `CONFIRM_INTEGRITY_RESOLVED` の再検査（`buildIndex(customer2)` で単独の索引）と 52・51。
- `WEBAPP_*` の定数。**取込の読取・書込の往復を増やさない**（範囲に取引が無いとき減る。範囲に取引があるときも、`valuesOnly` で 1 転記先あたり半分）。`phase6-round-trips` の予算テストが通ること。**もし既存のテストが「往復の数が現在値とちょうど等しい」ことを固定していて、減った値で赤になるなら、テストを変えずに止めて報告する。**
- `src/97_Ops.gs` には文字列の中に生の NUL バイトが 2 つある。**消したり別の文字に置き換えたりしないこと**（編集前後で数が同じであること）。
- `test/gas-stubs.js`・`test/gas-harness.js`：足りない API を**足すだけ**なら変えてよい（既存の振る舞いを変えない。足したものは報告する）。

## 4. テスト（`test/phase8-webapp.test.js` に足す。名前は `kw9 N: …`）

既存のテストは 1 文字も変えない。既存の補助（`seedPartnerViaWeb`・`webImport`・`forceFileState`・`clearDestinationRow`・`txIdRowsIn`・`fileStateOf`・`withMocks` など）と、`txdest` の材料作り、`test/phase6-round-trips.test.js` の `setFileState`・`countPreflightChecks` の考え方は使ってよい（書き換えない。要るなら新しい補助を足す）。範囲に入れるファイルは、恒久ファイルインデックスと処理ログの状態を揃えて `REVIEW_WAIT` にする（片方だけだと同期検査が鳴る）。前検査は `runImport({customerIds: […], fileIds: ['NO_SUCH_FILE']})` で動かし（新しいファイルを取り込まない）、戻り値の `customers[0].integrity` を見る。

- **kw9 1**（複製の重複を検出して止める）：Web アプリで複製 B へ取り込み、ファイルを `REVIEW_WAIT` にし、B の別の空行へ**同じ取引IDをもう 1 つ**書く → `integrity.stop === true`、`DUPLICATE_DESTINATION_ROW`（`fullTxId`・`matchCount: 2`）、顧客の `skipped === 'INTEGRITY_STOP'`。
- **kw9 2**（複製の正常な取引は何も言わない）：kw9 1 と同じで重複なし → `integrity.ok === true`・`findings` が空・`indexesBuilt === 1`。**いまは複製の `COMMITTED` の取引を `DESTINATION_ROW_MISSING` と誤報する**（実装前は赤のはず）。
- **kw9 3**（複製の行の手書き換えと行の消失）：B の F 列を書き換える → `MANUAL_CHANGE`（`column: 'f'`・`rowNumber` は取引の行）、`stop` は偽。別の材料で B の行（取引ID列を含む）を空にする → `DESTINATION_ROW_MISSING`、`stop` は偽。
- **kw9 4**（旧い行は雛形で検査する）：(a) 取引の AC・AD を空にして、行は複製 B にしか無い → `DESTINATION_ROW_MISSING`（雛形に無いので。いまの規則のまま）、索引は 1 つ（雛形）。(b) 定期取込の経路（`runImport({})`、書込先＝雛形）で書いたファイルを `REVIEW_WAIT` にして、取引の AC・AD を空にする → 雛形に行があるので所見なし。
- **kw9 5**（転記先ごとに 1 回だけ索引を作る）：同じ顧客の 2 ファイルを別々の複製 B・C に取り込み、どちらも `REVIEW_WAIT` → `indexesBuilt === 2`。2 ファイルを同じ複製 B に取り込んだ材料では `indexesBuilt === 1`。各取引は**自分の**転記先で検査される（B のファイルの取引を C で探さない ── B・C それぞれの行を消して、所見が正しいファイルの取引に付くこと）。
- **kw9 6**（範囲に取引が無ければ索引を作らない）：`scope 1` と同じ材料（今回の候補に取引ログが無い）→ `indexesBuilt === 0`。あわせて、前検査の間に `valuesOnly: true` で呼ばれた `buildIndex` が 0 回であること（`gas.context.buildIndex` を包んで数える）。
- **kw9 7**（開けない転記先・一過性の失敗）：B をスプレッドシートごと開けなくする（スタブで `openById` が投げる形）→ `DESTINATION_UNREADABLE`（REVIEW、`spreadsheetId`・`transactions` 件数）、`stop` は偽、顧客は `skipped` にならず、今回の候補の取込は進む。**一過性**（`TRANSIENT_SHEETS_ERROR`）で投げさせると握りつぶさずに顧客が `skipped`（`error.code` が出る）になる。
- **kw9 8**（`valuesOnly`）：`buildIndex(customer, {valuesOnly: true})` で `FORMULA` の読取が 0 回（`valueRenderOption` を数える）、`byTxId`・`valuesByRow` は通常の索引と同じ、`getFormulasByRow` は `null`、`isRowEmpty` は `RangeError`。`valuesOnly` を付けない `buildIndex` は `FORMULA` も読み、`getFormulasByRow` が行を返す（いまと同じ）。
- **kw9 9**（`runIntegrityCheck` の `indexForTransaction`）：索引を 2 つ（それぞれ別の取引IDを持つ）作り、`txLogs` を 2 つの索引へ振り分ける関数で呼ぶ → 各取引は自分の索引で検査される。`null` を返した取引は検査 1〜3 に出ない。`index` も `indexForTransaction` も無ければ `TypeError`（いまと同じ）。**`fileState` が `COMPLETED` で未終端の取引が 2 つの索引にまたがるとき、`FILE_STATE_TX_MISMATCH` が取引ごとに 1 件ずつだけ**（索引ごとに繰り返さない）。`processLogState` と `permanentIndexState` が食い違うとき `PERMANENT_INDEX_DESYNC` がちょうど 1 件。
- **kw9 10**（全複製の検査・基本・書かない）：顧客に複製 B・C と雛形の旧い行を用意し、`opsCheckIntegrityAllDestinations()` → §2.5 の形で、転記先ごとの `transactions`・`findings` が正しく、`legacyTransactions` が旧い行の数。実行の前後で、取引ログ・恒久ファイルインデックス・処理ログ・要確認・監査ログ・B・C・雛形の全セルが**変わらない**（読み取って比べる）。
- **kw9 11**（全複製の検査は完了済みも見る）：B に取り込んで `COMPLETED` まで進めたファイルの行を手で書き換える → 前検査（`runImport`）には出ない（`scope 2`）が、`opsCheckIntegrityAllDestinations` には `MANUAL_CHANGE` が出る。
- **kw9 12**（`customerId` の絞り込み）：2 つの顧客に取引がある材料で、`opsCheckIntegrityAllDestinations('C001')` は C001 だけを返し、省略すると両方を返す。
- **kw9 13**（実行ログに取引の値を出さない）：`MANUAL_CHANGE` を起こした材料で、戻り値の JSON 文字列（`JSON.stringify`）に、書き換えた値・元の値・店名・金額が 1 つも含まれない。`samples` は最大 20 件。
- **kw9 14**（開けない転記先は数えて続ける）：全複製の検査で、取引ログが指す複製の 1 つを開けなくする → その転記先は `unreadable`（`transactions` 件数）に載り、ほかの転記先は検査される。`findings` に `DESTINATION_UNREADABLE` を数えない。
- **kw9 15**（時間の予算）：`opsCheckIntegrityAllDestinations(undefined, {timeBudgetMs: 0})` → `stoppedBy === 'TIME_BUDGET'`、`deferredDestinations` が取引の指す転記先をすべて含み、索引を 1 つも作らない（`unreadable` は空）。

## 5. 変異（自分で入れて、赤になることを確かめる）

入れて、`node test/run-tests.js` を回し、赤になるテストを記録して、戻す（戻したら `git diff` が変異を入れる前と同じこと）。

| # | 変異 | 赤になるはず |
|---|---|---|
| M1 | 解決器が記録された転記先を無視して常に雛形の索引を返す | kw9 1・2・3・5 |
| M2 | 旧い行（AC 空）を検査から外す（`null` を返す） | kw9 4 |
| M3 | 解決器が呼出しごとに索引を作り直す（キャッシュしない） | kw9 5 |
| M4 | 前検査が、範囲に取引が無くても雛形の索引を先に作る | kw9 6 |
| M5 | 開けない転記先の失敗をそのまま投げる（`null` にしない） | kw9 7 |
| M6 | 一過性の失敗（`TRANSIENT_SHEETS_ERROR`）も `null`（開けない）にする | kw9 7 |
| M7 | `valuesOnly` でも `FORMULA` を読む | kw9 8 |
| M8 | `valuesOnly` の `getFormulasByRow` が空の行（`''` の配列）を返す | kw9 8 |
| M9 | `runIntegrityCheck` が振り分けず、最初の索引ですべての取引を検査する | kw9 9 |
| M10 | `runIntegrityCheck` が `null` を返された取引を検査 1〜3 に回す（`TypeError`） | kw9 9 |
| M11 | `runIntegrityCheck` が検査 4・5 を索引ごとに繰り返す | kw9 9 |
| M12 | 全複製の検査が前検査と同じ範囲（終端でないファイルだけ）に絞る | kw9 11 |
| M13 | 全複製の検査が監査ログへ 1 行書く | kw9 10 |
| M14 | `samples` に `expected`・`actual` を入れる | kw9 13 |
| M15 | 全複製の検査が `customerId` を無視する | kw9 12 |
| M16 | 全複製の検査が予算を見ない | kw9 15 |
| M17 | `DESTINATION_UNREADABLE` を `stop` を立てる重さ（`STOP`）にする | kw9 7 |
| M18 | 前検査が `DESTINATION_UNREADABLE` の所見を足さない | kw9 7 |

## 6. 受入（本番。実装・監査・push の後、Claude がユーザーの許可を得て行う）

1. push の前後で `clasp pull` の比較（いつもの手順）。
2. `opsCheckIntegrityAllDestinations()`（読むだけ）を clasp で実行し、顧客ごとの `destinations`・`findings`・`unreadable` をユーザーに見せる。**特に `DUPLICATE_DESTINATION_ROW`（STOP）があれば、その顧客は次の取込が `INTEGRITY_STOP` で止まる** ── 中身を調べて報告する。`MANUAL_CHANGE`・`DESTINATION_ROW_MISSING` は本物か（手書き換え・行の消失）を見分けて報告する。
3. 次に Web アプリで取り込んだとき、前検査の所見（`customers[].integrity`）に誤報が無いこと。

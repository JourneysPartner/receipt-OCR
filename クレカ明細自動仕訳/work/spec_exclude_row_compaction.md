# 1 件ずつの「対象外」を取引 ID で確かめ、空いた行を詰める 仕様書

作成日：2026-11-11
版：1.2
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いてあることは変えない。書いていないことは安全側で決め、決めたことは全部報告する。
前提：`work/spec_other_reviews_exclude_batch.md`（まとめて対象外。本番 `gas-push-146`・受入合格）。その §2.2.1（行を取引 ID で確かめる表）と §2.2.2（書く順序）をそのまま使う。

改訂履歴：
- 1.2（2026-11-12）：§2.2.6 の「`dest` に書かれ得る取引」に、要確認行の M・N 列が `dest` を指す取引を足した（1.1 の条件では `xb 4` の (e)〔AC が空・要確認の M は複製〕を集められなかった）。`xb 4` の (c)（取引ログの AC が別のスプレッドシート）は、対象の取引が F より上にあって詰めても安全なので、詰めた後の正確な状態を期待にする。
- 1.1（2026-11-12）：監査の直し。§2.2.6（F〜L を指す別の取引があれば詰めない）・`cmp 17`・`K16`。実装の 1 回目は動く取引だけを確かめていて、`xb 4` の (e) で、対象外にならなかった取引の AE が詰めた後に別の取引の行を指した（テストはそれを許す形に緩められていた）。
- 1.0（2026-11-11）：初版。利用者の依頼（2026-11-11）：「（1 件ずつの対象外が行番号だけで消す問題を）直して。転記シート上で、できれば対象外にした行が空白の行にならないように（上の行から続けて取引が続いて記載されている形）して欲しい。」

---

## 1. 何を直すか

### 1.1 1 件ずつの対象外は、行番号だけで行を消す（中）

行ごとの［確定…］と取引先の表の「対象外」は、`webAppResolveOtherReview`（80）→ `applyResolveDecision_`（96）→ `resolveReview` → `excludeTransaction_`（51）を通る。`excludeTransaction_` は取引ログの行番号（AE）の行を `clearTransactionRows` で空にするだけで、**その行にその取引の ID が入っているかを確かめず、読み返しもしない。**行が並べ替えなどで動いていると、別の取引の行を消す。まとめて対象外（57）は §2.2.1 の表で確かめてから消す。

### 1.2 対象外にした行が、転記シートに空白の行として残る

対象外は行の B・F・I・K・M 列と取引 ID を空にするだけなので、転記シートの真ん中に空白の行が残る。Web アプリは［記帳を実行］の押下ごとに転記先の複製を作るので、後の取込がその行を埋めることもない。ダウンロードする Excel はこのシートそのものなので、空白の行が Excel にも残る。利用者は「上の行から続けて取引が続いて記載されている形」を望んでいる。

### 1.3 本仕様がすること

1. **1 件ずつの対象外を、まとめて対象外と同じ確かめ方にする**（§2.1）：リースを持ってから取引を読み直し、転記先の索引でその行にその取引の ID があることを確かめてから消し、消した後に読み返す。合わなければ何も書かずに止まる。
2. **空いた行を詰める部品を作る**（§2.2。新しいファイル `src/58_DestinationCompaction.gs`）。対象外で行を空けた後、その転記先で、空いた行より下にある取引の行を上へ詰める。**動かすのはシステムが書く列（取引 ID・B・F・I・K・M、列対応にあれば L・C・G）だけ**で、雛形の数式・既定値の列（勘定科目・消費税・残高など）と科目一覧には触れない。行を消す（行削除）はしない（残高の式が前の行を指していると `#REF!` になるため）。
3. 1 件ずつの対象外（51）とまとめて対象外（57）の両方で、行を空けた後に詰める（§2.1・§2.5）。
4. **安全に詰められないときは詰めない**（行は空けたまま。対象外そのものは済ませる）。理由を画面に出す（§2.2.2・§2.7）。
5. 詰める途中で止まっても帳簿を壊さないように、**印**（Script Properties）を書いてから動かし、取引ログの行番号を直してから印を消す。印が残っている間、その顧客の転記先への書込は全部止める。印は次の Web アプリの呼出しの頭で、取引 ID の位置から直して消す（§2.3・§2.4）。

### 1.4 変えないもの

- 計上・取引先の経路（`55` は 1 文字も変えない）。押せるかの判定（`webAppOtherReviewOptions_`・`MENU_RESOLVE_OPERATIONS_`）と操作の名前（`…対象外にする（転記行を空にします）`）。
- `43`・`45`・`50`・`53`・`61`・`70`・`71`。**`97` は開かない・書かない**（文字列の中に生の NUL バイトがある）。
- 取消し（53 の `cancelTransactions`）・復元（54）・その他の行を空ける操作は詰めない（本仕様の外）。
- 取込の行の選び方（上から空いた行を使う `findEmptyRows`）。

---

## 2. 設計

### 2.1 1 件ずつの対象外（`excludeTransaction_`、`src/51_ReviewResolution.gs`）

新しい手順（いまの手順を置き換える。`resolveReview` からの呼ばれ方・引数・戻り値の既存の鍵は変えない）：

1. `tx = getTransaction(review.fullTxId)`。いまと同じ 2 つの検査（状態が `REVIEW_REQUIRED`／`COMMITTED` でない → いまの `StateTransitionError`、freee 取込済みで `!input.allowImported` → いまの `StateTransitionError`）。文言も同じ。
2. `customer = getCustomerById(review.customerId)`、`dest = reviewWriteCustomer_(review, customer)`。
3. リースを取る（いまと同じ `acquireLease(… WRITE_ONLY)`）。以下は `try`、`finally` で必ず `releaseLeaseById(leaseId, 'RESOLVE_DONE')`。
4. **リースを持ってから読み直す：**`live = getTransaction(review.fullTxId)`。手順 1 と同じ 2 つの検査をもう一度（同じ例外・同じ文言）。`from = live.transactionStatus`。
5. **転記先と行を確かめる（まとめて対象外の §2.2 手順 5 と §2.2.1 と同じ）：**
   - `recorded = recordedDestinationOf_(live, customer)`。`recorded` があり、`spreadsheetId`・`sheetName` が `dest` と違う → **行の不一致**で止まる。
   - `live.destinationRow` が空でなく、`txHasDestinationRow_(live)` が偽 → 行の不一致で止まる。
   - `index = buildIndex(dest, {valuesOnly: true})`。`decision = excludeBatchClassifyRow_(dest, index, {tx: live, review: review, recorded: recorded})`（57 の関数をそのまま呼ぶ）。
   - `MISMATCH` → 行の不一致で止まる。
   - `CLEAR` → `clearTransactionRows(dest, [decision.rowNumber], leaseId, review.fileId)` → `verifyWrittenValues(dest, [{rowNumber, fullTxId: null, values: excludeBatchEmptyValues_(dest)}])`。`ok` が偽 → **読み返しの不一致**で止まる（取引は `CANCELED` にしない）。
   - `ALREADY_CLEARED`・`NO_ROW` → 書かない。
6. `updateTransactionStatus(review.fullTxId, from, TX_STATUS.CANCELED)`。
7. 要確認を `EXCLUDED` に・監査（いまと同じ中身。`detail` は元の検出詳細に `previousStatus: from` を足したもの）。**いまはリースを返した後に書いているが、リースを持ったまま書く**（手順 8 の前に済ませるため）。
8. `decision.kind` が `CLEAR` か `ALREADY_CLEARED` なら、**空いた行を詰める**：`compaction = compactDestinationAfterExclusion_(dest, {leaseId: leaseId, fileId: review.fileId, actor: actor, customer: customer})`（§2.2）。`NO_ROW` なら `compaction = null`。
9. 戻り値は今の鍵に `compaction` を足したもの。

止まるときの例外（何も書かない）：
- 行の不一致：`IntegrityError('DESTINATION_ROW_MISMATCH', <英語の詳細>)`、`error.displayMessage = excludeBatchMessage_('DESTINATION_ROW_MISMATCH')`。
- 読み返しの不一致：`IntegrityError('DESTINATION_VALUE_MISMATCH', <英語の詳細>)`、`error.displayMessage = excludeBatchMessage_('DESTINATION_VALUE_MISMATCH')`。
- `06_ErrorCatalog.gs` に `DESTINATION_ROW_MISMATCH` と `DESTINATION_COMPACTION_PENDING`（§2.3）を足す（`IntegrityError` は表に無いコードで作れないため）。
- `96_Menu.gs` の `menuOperationErrorMessage_` の頭に 1 行：`error.displayMessage` が空でない文字列なら、それを返す。

### 2.2 空いた行を詰める部品 `compactDestinationAfterExclusion_(dest, context)`（`src/58_DestinationCompaction.gs`）

`dest`：転記先を当てた顧客（`destinationSpreadsheetId`・`destinationSheetName`・`columnMapping`・`headerRow`・`rowScanLastColumn`・`rowScanExcludedColumns`・`accountListRange`・`customerId`）。`context`：`{leaseId, fileId, actor, customer}`（`customer` は転記先を当てる前の顧客。`recordedDestinationOf_` に渡す）。

戻り値：`{compacted: 真偽, reason: null | <コード>, reasonText: null | <文>, gapsClosed: <数>, rowsMoved: <数>, ms, reads}`。**詰められないことは例外にしない**（`compacted: false` と `reason` で返す）。呼出し側の誤り（引数の型）だけ `TypeError`。

#### 2.2.1 言葉

- **動かす列**：`txId`・`b`・`f`・`i`・`k`・`m`、列対応にあれば `l`・`c`・`g`（列番号は `writeColumnNumber_`）。
- **比べる列**：1〜`rowScanLastColumn` のうち、動かす列でも、科目一覧（`accountListRange` の 2 列。設定があれば）でもない列。
- **D**：最初のデータ行＝`Number(headerRow) + 1`。
- **取引の行**：D 以下で、取引 ID 列が空でない行。**L**：取引の行のいちばん下。
- **空き行**：D〜L のうち、取引 ID 列が空で、動かす列（G を除く）もすべて空の行。**F**：空き行のいちばん上。
- **取引 ID の無い行**：D〜L のうち、取引 ID 列が空なのに、動かす列（G を除く）のどれかに値がある行（手で入れた行・繰越や合計の行など）。F より上にあるものは触らないので構わない。
- **雛形の行 T**：L + 1。
- **動く取引**：F より下の取引の行（全部、空き行の数だけ上へ動く）。上から順に、行 F・F+1・… へ詰める。詰めた後に空く行（下から空き行の数だけ）を**空く行**と呼ぶ。

#### 2.2.2 詰めない条件（どれかに当たれば、転記先・取引ログ・要確認に何も書かずに返す）

| `reason` | 条件 | `reasonText` |
|---|---|---|
| （`null`、`compacted: false`） | 取引の行が無い、または空き行が無い（いちばん下の行を対象外にした場合を含む） | （なし） |
| `UNKNOWN_ROW_CONTENT` | F より下（F〜L）に取引 ID の無い行がある | `取引 ID の無い行（手で入れた行など）が間にあります` |
| `NO_TEMPLATE_ROW_BELOW` | T が索引の外、または `isRowEmpty(index, T, dest)` が偽 | `取引の下に空いた雛形の行がありません` |
| `MANUAL_EDIT` | F〜L のどれかの行の、比べる列のどれかの「形」が T と違う（§2.2.4） | `手で直した跡のある行があります（数式・既定値の列）` |
| `ROW_LOG_MISMATCH` | 動く取引のどれかで、取引 ID が転記先に 2 行以上ある、取引ログに有効な行がちょうど 1 つでない、取引ログの転記先が `dest` と違う、取引ログの行番号（AE）がその行と違う。**または、動く取引でない取引が F〜L の行を指している**（§2.2.6） | `転記先の行と取引ログの行番号が合いません` |
| `LEGACY_LOCATION` | 動く取引のどれかの取引ログに転記先（AC）の記録が無い | `転記先の記録が無い古い取引があります` |
| `TX_STATE` | 動く取引のどれかの状態が `COMMITTED`／`REVIEW_REQUIRED` でない | `取込の途中か、取り消した取引が下にあります` |
| `FREEE_IMPORTED` | 動く取引のどれかが freee 取込済み（`IMPORTED`／`NEEDS_FREEE_FIX`） | `freee に取り込み済みの取引が下にあります` |
| `OTHER_LEASE` | この顧客に、`context.leaseId` 以外の有効なリースがある | `この顧客のほかの処理（取込や確定）が動いています` |
| `LEASE_LOST` | `context.leaseId` のリースを持っていない | `処理の権利（リース）を失いました` |
| `TOO_MANY_ROWS` | 動かす要求（§2.2.5）が 5000 を超える | `動かす行が多すぎます` |
| `COMPACTION_PENDING` | 前の詰める処理の印が残っていて、直せない（§2.3） | `前に行を詰める途中で止まった転記先があります。次の操作のときに直します。続くときは管理者へ連絡してください` |
| `COMPACTION_FAILED` | 上のどれでもない例外（読めない・書けない。印を書いた後なら §2.2.5 の 7 の後） | `転記先を読めないか書けませんでした` |

画面には `空いた行は詰めずに残しました（<reasonText>）。` と出す（§2.7）。

#### 2.2.3 何が変わり、何が変わらないか

- 変わるのは、**F〜L の行の動かす列だけ**。動く取引の動かす列のセル（値と書式）が、その取引の新しい行へそのまま写り、空く行の動かす列は T の動かす列（空・G は雛形の既定）と同じになる。
- 変わらないもの：比べる列（数式・既定値・残高など）・科目一覧・F より上の行・T から下の行・他のシート・他の転記先。
- 取引ログ：動く取引の AE（31）を新しい行に、AS（45）を日時に。他の列は変えない。
- 要確認：動く取引の要確認（状態を問わない）のうち、M 列（転記先）が `dest` の転記先と同じものの Y 列（25、`destinationRow`）を新しい行に。他の列は変えない。
- 対象外にした取引（`CANCELED`）の AE・要確認は変えない。

#### 2.2.4 「手で直した跡」の見分け方（`MANUAL_EDIT`）

行 r・列 c の**形**：
- その列に数式があれば `'F:' + relativeFormula_(数式, r)`
- 無ければ `'V:' + JSON.stringify(値)`（`null`・`undefined` は `''`）

`relativeFormula_(formula, rowNumber)` は、数式の中の `(\$?)([A-Z]{1,3})(\$?)([1-9][0-9]*)` のうち、行の前に `$` が無いものの行番号を「`rowNumber` との差」に置き換えた文字列（例：行 6 の `=N5+L6-M6` と行 7 の `=N6+L7-M7` は同じ形、`=$N$4+L6` の `$4` は置き換えない）。文字列の中や関数名（`LOG10` など）も置き換わるが、そのときは行ごとに形が違って `MANUAL_EDIT` になる（詰めない側に倒れる）ので構わない。

数式・値は `buildIndex(dest)`（数式つき）の `getFormulasByRow`・`getAllValuesByRow` から取る。

#### 2.2.5 手順（全部を 1 つの `withScriptLock_` の中で）

0. **前の印を直す：**印（§2.3）があれば `settleDestinationCompaction_`（§2.3）を呼ぶ。直せなければ `COMPACTION_PENDING` で返す。
1. `assertLeaseHeldForWrite(context.fileId, context.leaseId)`。リース衝突なら `LEASE_LOST` で返す。
2. `index = buildIndex(dest)`（数式つき。読取 2 回）。§2.2.1 の D・L・F・T を決める。§2.2.2 の `null`・`UNKNOWN_ROW_CONTENT`・`NO_TEMPLATE_ROW_BELOW`・`MANUAL_EDIT` を確かめる。
3. 動く取引の取引 ID で取引ログを 1 回読む（`findRowsByColumnValues_(transactionLogSheet_(), 1, ids, TRANSACTION_LOG_WIDTH_)` → `txLogFromRecord_`）。`ROW_LOG_MISMATCH`・`LEGACY_LOCATION`・`TX_STATE`・`FREEE_IMPORTED` を確かめる。
4. リースを 1 回読む（`activeLeases_()`）。`OTHER_LEASE` を確かめる。
5. 要求を作る：動く取引ごとに（上から順に）、動かす列の連続した列ごとに、Sheets API の `copyPaste`（`source`＝元の行のその列、`destination`＝新しい行のその列、`pasteType: 'PASTE_NORMAL'`、`pasteOrientation: 'NORMAL'`、`sheetId` は `SpreadsheetApp` のシートの `getSheetId()`）。続けて、空く行ごとに、T の同じ列からの `copyPaste`。数が 5000 を超えたら `TOO_MANY_ROWS`。
6. **印を書く**（§2.3）：`{runId, customerId, spreadsheetId, sheetName, firstRow: F, lastRow: L, txCount: <F〜L にある取引 ID の数>, at}`。
7. **1 回の** `Sheets.Spreadsheets.batchUpdate({requests: 要求}, spreadsheetId)`。（要求ごとに分けて呼ばない ── 途中までの移動を残さないため。この API は 1 回の呼出しの要求を全部適用するか、どれも適用しない。）`faultInjectionPoint('DESTINATION_COMPACT_AFTER_MOVE', {fileId})` をこの直後に置いてよい。
8. **後始末** `settleDestinationCompaction_`（§2.3）。7 が例外でも必ず呼ぶ（API が失敗を返しても適用されている場合があるため、取引 ID の位置で決める）。
9. 結果：8 が成功し、F〜F+n−1 に動く取引が元の順に並び、空く行の動かす列（G を除く）が空なら `compacted: true`。8 が成功したが並んでいなければ（7 が適用されなかった）`compacted: false`・`COMPACTION_FAILED`。8 が失敗なら `compacted: false`・`COMPACTION_PENDING`（印は残る）。
10. **値の確かめ**（`compacted: true` のとき）：動く取引ごとに、新しい行の動かす列の値が、手順 2 の索引の元の行の値と同じか。違えば `compacted: true` のまま `valueMismatch: true` を足し、ログと監査に残す（行の位置は取引 ID で直してあるので書込は安全。値の食い違いは整合性チェックが手動変更として拾う）。
11. ログ：`Logger.log('DESTINATION_COMPACT ' + JSON.stringify({runId, compacted, reason, gapsClosed, rowsMoved, firstRow, lastRow, ms, reads, valueMismatch}))`。**転記先の ID・取引 ID・店名・ファイル名・金額を出さない。**

#### 2.2.6 F〜L の行を指す取引（1.1 で足した）

詰めると F〜L の行の中身が入れ替わる。だから**動く取引のほかに、F〜L の行を AE で指している生きた取引があってはならない**。あれば、詰めた後にその取引の AE が別の取引の行を指し、次の解決操作（取引先の採用・日付の修正など）がその行へ取引 ID と値を書いて、別の取引を上書きする。

手順 3 で取引ログを読むときに、**取引ログ全体を 1 回読み**（`readSheetRows_(transactionLogSheet_(), TRANSACTION_LOG_WIDTH_)` → `txLogFromRecord_`。1 行でも読めなければ `COMPACTION_FAILED`）、次の取引を集める：有効で、状態が `PREPARED`／`WRITING`／`COMMITTED`／`REVIEW_REQUIRED`、AE が F〜L の中、かつ**次のどれかで `dest` に書かれ得る**もの（1.2 で広げた。解決操作は取引ログの転記先〔`customerForRecordedDestination_`〕でも、要確認行の転記先〔`reviewWriteCustomer_`、M・N 列〕でも書くため、両方を見る）：
   - `recordedDestinationOf_(tx, context.customer)` が `dest` と同じ。
   - その取引の要確認（状態を問わない。`allReviewRecordsAndAuditTail_()` などで 1 回読む）のどれかの M・N 列が `dest` と同じ（N が空なら M だけで比べる）。
   - 取引ログの記録（AC）が無く、M 列のある要確認も無く、その顧客の取引で、`dest` が顧客マスターの雛形（`context.customer.destinationSpreadsheetId`・`destinationSheetName`）と同じ。集めた取引のどれかが「動く取引で、その AE が今の行と同じ」でなければ `ROW_LOG_MISMATCH` で詰めない。`CANCELED`・`DELETED_ACCEPTED` の取引は数えない（書く経路が無い）。動く取引の検査（手順 3 の残り）も、この 1 回の読取の結果で行ってよい。

例（`xb 4` の (e)）：取引ログの転記先の記録（AC）が空で行も空の取引は、まとめて対象外で `DESTINATION_ROW_MISMATCH` になり、`REVIEW_REQUIRED` のまま AE がその空の行を指して残る。同じ呼出しで他の件を対象外にして詰めると、その空の行へ下の取引が入り、この取引の AE が別の取引の行を指してしまう。

### 2.3 印と後始末（`src/58_DestinationCompaction.gs`・`src/11_FileStateManager.gs`）

**印：**Script Properties の `DESTINATION_COMPACTION_PENDING`（JSON。§2.2.5 の 6 の形）。同時に 1 つだけ（ロックの中で書くので重ならない）。

**後始末 `settleDestinationCompaction_(marker, actor)`**（ロックの中から呼ぶ。自分ではロックを取らない）：
1. 印の転記先の F〜L を 1 回読む（`buildIndex(印の転記先, {valuesOnly: true, startRow: F, endRow: L})`）。
2. 取引 ID ごとの行を集める。同じ取引 ID が 2 行以上ある、または取引 ID の数が `txCount` と違う → 失敗（印を残す）。
3. それらの取引 ID で取引ログを 1 回読む。有効な行がちょうど 1 つで、記録された転記先が印の転記先と同じ、でなければ失敗（印を残す）。
4. 要確認と監査の末尾を 1 回読む（`allReviewRecordsAndAuditTail_()`）。
5. 書く：AE が今の行と違う取引の AE（31）・AS（45）（`Sheets.Spreadsheets.Values.batchUpdate`、`RAW`、`SETTLE_BATCH_RANGES_` ごと）。§2.2.3 の要確認の Y（25）（1 回の `batchUpdate`）。
6. 監査（`appendAuditRowsUnlocked_`）：`{type: 'DESTINATION_COMPACT', actor, targetType: 'DESTINATION', targetId: marker.runId, customerId: marker.customerId, before: {firstRow, lastRow}, after: {rowsMoved: <AE を直した数>, reviewsMoved: <Y を直した数>}}`。転記先の ID は入れない。
7. 印を消す。
8. 戻り値 `{ok: true, rowsMoved, positions: {取引 ID: 行}}`。失敗なら `{ok: false, code}`（例外も `ok: false` にする）。

**門（`assertLeaseHeldForWrite`、`src/11_FileStateManager.gs`）：**今の検査の前に、印を読む（読めなければ例外のまま＝止まる側）。印があれば、その `fileId`・`leaseId` のリースの `customerId` が印の `customerId` と同じとき（印が壊れていて読めないときは全部）、`IntegrityError('DESTINATION_COMPACTION_PENDING', …)`（`displayMessage`＝`転記先の行を詰める処理が途中で止まっています。画面を開き直してから（F5）、もう一度押してください。続くときは管理者へ連絡してください。`）。これで、その顧客の転記先への書込（`writeTransactionRows`・`clearTransactionRows`・`releaseReservedRows`・`reserveDestinationRows`・`recoverPartialFailure`・科目一覧への書き足し）は全部止まる。**`43`・`45` は変えない**（全部この門を通る）。

**次の呼出しで直す（`webAppInvoke_`、`src/80_WebApp.gs`）：**`fn()` を呼ぶ前に、印があれば `withScriptLock_` の中で `settleDestinationCompaction_(印, activeUserEmail_())` を呼ぶ。例外は飲み込む（`fn()` は必ず呼ぶ。直らなければ門が書込を止める）。印が無ければ Script Properties を 1 回読むだけ。

### 2.4 「その顧客の書込を全部止める」理由

印が残るのは、行を動かした後・取引ログの行番号を直す前に止まったとき（またはその逆）。このとき取引ログの AE は動いた後の行を指していない。解決操作（取引先の採用・日付の修正など）は AE の行へ取引 ID と値を書くので、そのまま通すと**別の取引の行を上書きする**。また、同じ転記先へ別のファイルの取込が空き行を予約すると、F〜L の中の取引 ID の数が変わって後始末ができなくなる。だから印の顧客の書込は、印が消えるまで全部止める。

### 2.5 まとめて対象外（`src/57_ReviewExclusionBatch.gs`）

- 手順 7 の後（リースを持ったまま、`finally` の前）に、転記先のまとまりごとに（現れた順）、その転記先でこの呼出しが `CANCELED` にした件のうち §2.2.1 の扱いが `CLEAR` か `ALREADY_CLEARED` の件が 1 つ以上あれば、`compactDestinationAfterExclusion_(group.customer, {leaseId, fileId, actor: options.actor, customer})` を 1 回呼ぶ。
- 戻り値に `compactions: [<部品の戻り値>]` を足す（いつも配列）。他の鍵・恒等式（1 件は必ずどれか 1 つに入る）は変えない。詰める処理の結果は `resolvedReviewIds`・`errors` に影響しない。
- `EXCLUDE_BATCH` のログに `compacted`（詰めた転記先の数）と `compactionReasons`（コードの配列）を足す。

### 2.6 80・96 の戻り値

- `applyResolveDecision_`（96）：`resolveReview` の戻り値に `compaction` があれば、`outcome.compactions`（無ければ作る）へ足す。**`compaction` が無い操作では `outcome` の形を変えない。**
- `webAppResolveOtherReview`（80）：戻り値に `compaction: (outcome.compactions || [])[0] || null` を足す。
- `webAppResolveOtherReviewsBatch`（80）：部品 57 の戻り値の `compactions` を全部つないで、戻り値の `compactions` に入れる（計上の 2 つでは空の配列）。

### 2.7 画面（`src/81_WebAppUi.html`）

- 1 件ずつ（`otherResultNotice`）：`EXCLUDE`・`EXCLUDE_PRIOR_YEAR` で
  - `result.compaction` があり `compacted` → `転記行を消して下の行を上へ詰め、取引を対象外にしました。`
  - `result.compaction` があり `compacted` でない → 今の `転記行を空にし、取引を対象外にしました。`。`reason` があれば詳細に `空いた行は詰めずに残しました（<reasonText>）。` を足す（種類は今の決め方のまま。詰めなかっただけでは警告にしない）。
  - `result.compaction` が無い（`null`）→ 今の文。
- まとめて（`runOtherServerBulk` の成功の文）：対象外の操作で、`compactions` に `compacted` が 1 つ以上あれば、文の後ろに `転記先の空いた行を詰めました。`。`compacted` でない・`reason` があるものは、`reasonText` ごとに 1 行だけ詳細に `空いた行は詰めずに残しました（<reasonText>）。`。
- 確認の文 `TEXT.otherEffect` の対象外の文を `転記行を消し、下の行を上へ詰めて、取引を対象外にします（安全に詰められないときは行を空けたままにします）。取り消せません（戻すには管理者による再取込が必要です）。` に替える。
- 文字は `textContent` で入れる。

### 2.8 テストの道具（`test/gas-stubs.js`）

`Sheets.Spreadsheets.batchUpdate` に `copyPaste`（`PASTE_NORMAL`・`NORMAL`）を足す：元の範囲の値・数式・書式を先に全部控えてから、同じ大きさの先の範囲へ書く（数式は字句のまま写す。実際の Sheets は相対参照をずらすが、本仕様は数式の列を動かさないので構わない。G 列に数式がある材料は作らない）。**1 回の呼出しの要求は、全部を確かめてから適用する**（知らない要求が 1 つでもあれば、何も変えずに例外）。既存の `addSheet`・`insertDimension`・`deleteDimension` の振る舞いは変えない。

---

## 3. 安全の条件（テストで確かめる）

1 件ずつの対象外：
- **S1**：行を空にするのは、その行の取引 ID 列にその取引の ID があり、行番号が取引ログの `destinationRow` と同じで、要確認行と取引ログ（記録があれば）が同じ転記先を指すときだけ。合わなければ転記先・取引ログ・要確認・監査に何も書かずに `DESTINATION_ROW_MISMATCH`。
- **S2**：空にした後に読み返し、値が残れば取引を `CANCELED` にせず、要確認も `OPEN` のまま。
- **S3**：リースを持ってから取引の状態と freee の状態を見直す。
- **S4**：対象外にできた件の終わりの状態（転記先の全セル・取引ログの全列（AS を除く）・要確認の B・R・V・W・Z・AB・AD・AE・AF・Y・`REVIEW_RESOLVE` の監査）は、同じ材料をまとめて対象外にしたときと同じ。

詰める：
- **C1**：変わるのは F〜L の行の動かす列だけ。比べる列・科目一覧・F より上・T から下・他のシート・他の転記先は 1 セルも変わらない。
- **C2**：詰めた後、取引の並び（上から）は詰める前と同じで、各取引の動かす列の値は詰める前のその取引の行の値と同じ。空く行の動かす列は T と同じ。
- **C3**：取引ログの AE と要確認の Y は、詰めた後にその取引の ID がある行と同じ。取引ログは AE・AS 以外、要確認は Y 以外変わらない。
- **C4**：§2.2.2 の条件のどれかに当たれば、転記先・取引ログ・要確認に何も書かない（行は空けたまま）。対象外そのものは済んでいる。
- **C5**：この顧客に他のリースがあれば詰めない。
- **C6**：行は 1 回の `Spreadsheets.batchUpdate` で動かす。
- **C7**：印を書いた後に止まったら、印の顧客の転記先への書込は全部 `DESTINATION_COMPACTION_PENDING` で止まり、1 セルも書かない。他の顧客の書込は止まらない。
- **C8**：印が残っていれば、次の Web アプリの呼出しの頭で、取引 ID の位置から AE・Y を直して印を消す。同じ取引 ID が 2 行ある・数が合わない・取引ログが合わないときは直さず印を残す（書込は止まったまま）。
- **C9**：ログに明細の値・店名・ファイル名・取引先名・転記先の ID・取引 ID を出さない。
- **C10**：計上・取引先の経路、まとめて対象外の件ごとの結果（`resolvedReviewIds`・`errors` など）は変わらない。

---

## 4. 変えてよいファイル

- `src/58_DestinationCompaction.gs`（新しく作る。§2.2・§2.3）
- `src/51_ReviewResolution.gs`（`excludeTransaction_` だけ。§2.1）
- `src/57_ReviewExclusionBatch.gs`（§2.5 だけ）
- `src/11_FileStateManager.gs`（`assertLeaseHeldForWrite` の門だけ。§2.3）
- `src/06_ErrorCatalog.gs`（2 つのコードを足すだけ）
- `src/80_WebApp.gs`（`webAppInvoke_` の後始末・§2.6 の 2 つだけ）
- `src/96_Menu.gs`（`menuOperationErrorMessage_` の 1 行・`applyResolveDecision_` の §2.6 だけ）
- `src/81_WebAppUi.html`（§2.7）
- `test/gas-stubs.js`（§2.8）
- 新しいテストファイル `test/exclude-compaction.test.js`（§5。`phase8-webapp.test.js` の道具を写して使ってよい）
- 既存のテストファイル（§5.4 の直しだけ）

テストの材料は架空の表で作る（実明細の値を写さない）。

---

## 5. テスト

### 5.1 1 件ずつの対象外（`sx N: …`）

1. **sx 1（行を取引 ID で確かめる）**：次のそれぞれで、`webAppResolveOtherReview` の結果は失敗（`errors` の `message` が `excludeBatchMessage_('DESTINATION_ROW_MISMATCH')` の文）、転記先・取引ログ・要確認・監査（`REVIEW_RESOLVE`）は 1 セルも変わらない（S1）：(a) `dr` の行の取引 ID 列に別の取引の ID、(b) 行を動かした（`dr` の行を空にし、別の行にその取引の値と ID）、(c) 取引ログの AC を別のスプレッドシート ID、(d) その取引の ID が 2 行、(e) 取引ログの AC を空にし `dr` の行を空にする。
2. **sx 2（読み返し）**：`clearTransactionRows` を、行を空にしない形に包む → `DESTINATION_VALUE_MISMATCH` の文、取引は `CANCELED` でない、要確認は `OPEN`、`REVIEW_RESOLVE` の監査は増えない（S2）。
3. **sx 3（リースの中で見直す）**：リースを取った直後（2 回目の `getTransaction` の前）に (a) 取引を `CANCELED` へ、(b) freee の状態を `IMPORTED` へ → それぞれ今の文で止まり、転記先は変わらない（S3）。
4. **sx 4（既に空・行なし）**：(a) 取引ログに記録があり行が既に空 → 書かずに対象外になる（`clearTransactionRows` を呼ばない）、(b) 行が無い取引 → 書かずに対象外、`compaction` は `null`。
5. **sx 5（まとめてと同じ）**：同じ材料の世界を 2 つ（真ん中の行を含む 3 件の前年利用日）。一方は 1 件ずつ、他方はまとめて。S4 の項目が全部同じ（詰めた後の状態で比べる。AE も比べる）。

### 5.2 詰める（`cmp N: …`）

材料：取引の行 5〜9（5 件、同じファイル）、10 行目以下は雛形の行（比べる列に残高の式 `=Nr-1+Lr-Mr` の形と既定値の列を持つ）。

1. **cmp 1（真ん中の行）**：行 7 の取引を 1 件ずつ対象外 → 行 5・6 は変わらない。行 7・8 の動かす列は元の行 8・9 の値と書式、行 9 の動かす列は行 10 と同じ。比べる列は全行で前と同じ。取引ログ：元の行 8・9 の取引の AE が 7・8、AS が更新、他の列は同じ。その取引の要確認の Y が 7・8。`DESTINATION_COMPACT` の監査が 1 行。戻り `compacted: true, gapsClosed: 1, rowsMoved: 2`。画面の文が `転記行を消して下の行を上へ詰め、取引を対象外にしました。`（C1〜C3）。
2. **cmp 2（空き行が 2 つ・前からの空き）**：行 6 が前から空（取引 ID も動かす列も空）で、行 8 を対象外 → 行 5・7・9 の取引が 5・6・7 へ、行 8・9 は空く行（C2）。
3. **cmp 3（いちばん下の行）**：行 9 を対象外 → 何も動かさない（`compacted: false, reason: null`）。転記先は行 9 が空になっただけ。
4. **cmp 4（詰めない条件）**：§2.2.2 の表の `UNKNOWN_ROW_CONTENT`・`NO_TEMPLATE_ROW_BELOW`（シートの最後の行まで取引）・`MANUAL_EDIT`（(a) 行 9 の残高の式を値に書き換え、(b) 行 8 の既定値の列を別の値に）・`ROW_LOG_MISMATCH`（行 9 の取引の AE を 12 に）・`LEGACY_LOCATION`（行 9 の取引の AC を空に）・`TX_STATE`（行 9 の取引を `PREPARED` に）・`FREEE_IMPORTED`・`OTHER_LEASE`（同じ顧客の別のファイルに他者のリース）のそれぞれで、対象外そのものは済み（行 7 は空）、転記先の他の行・取引ログ・要確認は 1 セルも変わらず、戻りの `reason` と画面の詳細 `空いた行は詰めずに残しました（…）。` が出る（C4・C5）。
5. **cmp 5（科目一覧）**：`accountListRange` を走査範囲の中（`rowScanExcludedColumns` に入れた 2 列、行 5〜20）に置いた顧客で cmp 1 → 科目一覧のセルは 1 つも変わらない（C1）。
6. **cmp 6（G 列）**：行 9 の取引の G に `対象外`（キャッシュバックの行）→ 行 8 へ一緒に動き、行 9 の G は行 10 の G と同じになる。
7. **cmp 7（止まったとき・印と門）**：`Spreadsheets.batchUpdate` の後で、後始末の取引ログの書込を 1 回だけ失敗させる → 戻り `COMPACTION_PENDING`、印が残る。(a) 同じ顧客のファイルで `writeTransactionRows`・`clearTransactionRows`・`reserveDestinationRows` を呼ぶ → `DESTINATION_COMPACTION_PENDING`、転記先は 1 セルも変わらない。(b) 別の顧客の書込は通る。(c) 次に Web アプリの関数（読むだけのもの）を 1 回呼ぶ → AE・Y が直り、印が消え、cmp 1 と同じ終わりの状態。(d) その後は (a) の書込が通る（C7・C8）。
8. **cmp 8（直せない印）**：印を残した状態で、F〜L に同じ取引 ID を 2 行入れる → Web アプリの呼出しの後も印は残り、書込は止まったまま（C8）。
9. **cmp 9（動かす要求が失敗した）**：`Spreadsheets.batchUpdate` が何も適用せずに例外 → 後始末で AE は変わらず、印は消え、`compacted: false, reason: 'COMPACTION_FAILED'`、行 7 は空のまま。
10. **cmp 10（1 回で動かす）**：cmp 1 で `Spreadsheets.batchUpdate` がちょうど 1 回呼ばれる（C6）。
11. **cmp 11（まとめて対象外）**：行 6・8 を `webAppResolveOtherReviewsBatch` で対象外 → 転記先ごとに 1 回だけ詰め（部品の呼出し 1 回）、行 5・7・9 の取引が 5・6・7 へ、戻りの `compactions` に 1 つ、`resolvedReviewIds` などは詰めないときと同じ（C10）。画面の文に `転記先の空いた行を詰めました。`。
12. **cmp 12（ログ）**：`DESTINATION_COMPACT` と `EXCLUDE_BATCH` の行に、転記先のスプレッドシート ID・取引 ID・材料の店名・ファイル名・金額の文字列が出ない（C9）。
13. **cmp 13（読取の回数）**：cmp 1 の詰める処理の `batchGet` の回数を数えて報告する（取引の数を 5 件と 50 件で比べ、同じであること）。
14. **cmp 14（形の比べ方）**：`relativeFormula_` の単体：行 6 の `=N5+L6-M6` と行 7 の `=N6+L7-M7` は同じ形、`=$N$4+L6` と `=$N$4+L7` も同じ形、`=N5+L6-M6` と `=N4+L6-M6`（行 6）は違う形、数式と値は違う形。
15. **cmp 15（上の行は触らない）**：行 5 に取引 ID の無い行（動かす列の F・M に値。繰越の行の形）を置き、取引を行 6〜10 にして行 8 を対象外 → 詰める（`compacted: true`）。行 5 は 1 セルも変わらない。
16. **cmp 16**（実装の 1 回目が足した）：F より上の手で直した行を `MANUAL_EDIT` にしない。
17. **cmp 17（F〜L を指す別の取引）**（1.1）：(a) 取引ログの AE が空き行（F〜L の中の空の行）を指す `REVIEW_REQUIRED` の取引（転記先の記録あり）を置いて、別の行を対象外 → `ROW_LOG_MISMATCH` で詰めない（転記先は対象外の行が空になっただけ・取引ログと要確認は 1 セルも変わらない）。(b) 同じ形で記録（AC）が空・`dest` が雛形のとき → 同じく詰めない。(d)（1.2）記録（AC）が空で、要確認の M 列がこの転記先（複製）を指す取引 → 同じく詰めない。(c) AE が F〜L を指す取引が `CANCELED` だけなら詰める。

### 5.3 画面（`cmpu N: …`）

1. **cmpu 1**：1 件ずつの応答で `compaction: {compacted: true}` → `転記行を消して下の行を上へ詰め…`、`{compacted: false, reason: 'OTHER_LEASE', reasonText: …}` → `転記行を空にし、取引を対象外にしました。` と詳細 `空いた行は詰めずに残しました（…）。`、`compaction: null` → 今の文。
2. **cmpu 2**：まとめての応答の `compactions` で、詰めた・詰めなかった（同じ理由 2 つは 1 行）の文。
3. **cmpu 3**：対象外の確認の文に新しい `TEXT.otherEffect` の文が出る。

### 5.4 既存のテストの扱い

**既存のテストは期待を変えずに緑のままであること。**直してよいのは次だけ（直したものは全部、前後の期待を並べて報告する）：
- 対象外の後に**行が上へ詰まったために**落ちるテスト（空にした行番号が空のままであること・下の取引が元の行番号に居ることを確かめているもの）。期待を「詰めた後の状態」（取引 ID で引いた行・詰めた後の行番号）に直す。**確かめていた中身（どの取引が対象外になったか・他の取引の値が変わらないこと）は残す。**
- `TEXT.otherEffect` の対象外の文を確かめているテスト（文を新しい文に）。
- `outcome` の形を深く比べていて `compactions` が増えたために落ちるテスト（`compactions` を期待に足す）。

それ以外の既存のテストが落ちたら、テストを直さずに止まって報告する。特に緑のままであること：`pb 1`〜`16`、`pbu` の全部、`xb` の全部（詰めの分の直しを除く）、`batch` の全部、`kw2` の全部、`ob` の全部、`fc` の全部。

---

## 6. 変異（入れて回し、赤になるテストを記録して戻す）

- K1：51 で §2.2.1 の表を使わずに `dr` を消す
- K2：51 で読み返しを外す
- K3：51 でリースの中の読み直しを外す
- K4：詰めるときに動かす列以外も写す（1〜`rowScanLastColumn` の全列）
- K5：「手で直した跡」を見ない
- K6：T（雛形の行）を確かめない
- K7：他者のリースを見ない
- K8：印を書かない
- K9：門（`assertLeaseHeldForWrite`）で印を見ない
- K10：後始末で同じ取引 ID の 2 行を見ない
- K11：後始末で AE だけ直して要確認の Y を直さない
- K12：要求ごとに `Spreadsheets.batchUpdate` を呼ぶ
- K13：`webAppInvoke_` で印を直さない
- K14：57 で詰める部品を呼ばない
- K15：ログに `spreadsheetId` を足す
- K16（1.1）：§2.2.6 の検査（F〜L を指す別の取引）を外す

---

## 7. 受入（利用者。push の後）

1. 読むだけ（Claude）：`opsShowLeases` でリースが無いこと、印（Script Properties の `DESTINATION_COMPACTION_PENDING`）が無いこと。
2. 利用者：テスト用の明細を取り込み、前年利用日などの要確認を**真ん中の行で 1 件**、行ごとの［確定…］で対象外にする。
3. 期待：`転記行を消して下の行を上へ詰め、取引を対象外にしました。`。転記先を開くと、その行が無くなり下の取引が上へ詰まっている。残高・勘定科目・消費税の列の式はそのまま。
4. 利用者：［最終確認を表示］→ 突き合わせが合っていること。
5. Claude：`clasp logs` の `DESTINATION_COMPACT`（`ms`・`reads`・`rowsMoved`）を記録する。リース・印が残っていないこと。

---

## 8. Claude の判断の記録（利用者の決定ではないもの）

- **行は削除せず、システムが書く列の中身だけを上へ写す。**行を削除すると、残高のように前の行を指す式が `#REF!` になる。数式の列ごと写すと、最初の行だけ違う式を持つ雛形で式が壊れる。システムが書く列だけを写せば、雛形の数式は各行に残ったまま、詰めた後の値で計算し直される。
- **手で直した跡がある行があれば詰めない。**システムが書く列だけを動かすので、数式・既定値の列を人が直した行があると、その直しが別の取引に付いてしまう。雛形の行と「形」を比べて、違えば詰めない（行は空けたまま）。
- **安全に詰められないときは、行を空けたままにする**（今の振る舞い）。「できれば」の依頼なので、帳簿を壊す恐れがあるときは詰めないほうを選ぶ。理由は画面に出す。
- **印（Script Properties）を書いてから動かし、印が残る間はその顧客の書込を全部止める。**転記先と取引ログは別のスプレッドシートなので、2 つを同時に書くことはできない。間で止まると、取引ログの行番号が別の取引の行を指し、次の解決操作がその行を上書きする。印で書込を止め、次の Web アプリの呼出しで取引 ID の位置から直す。
- **1 つの転記先の空き行は全部詰める**（今回空けた行だけでなく、前の対象外で空いた行も）。11-11 の受入で空いた 31 行も、その転記先で次に対象外にしたときに詰まる。
- **この顧客に他のリースがあれば詰めない。**詰めると他のファイルの取引の行も動くので、他の処理が途中で古い行番号を持っていると危ない。
- **freee 取込済みの取引が下にあれば詰めない。**
- 取消し（53）・復元（54）は詰めない（依頼の外。必要になれば同じ部品を呼ぶ）。
- 操作の名前（`…（転記行を空にします）`）は変えない。確認の文で詰めることを説明する。

**見つけたこと（本仕様の外。記録）：**
- 低：対象外にした取引（`CANCELED`）の取引ログの AE は元の行番号のまま残る。詰めた後はその行に別の取引が居るが、`CANCELED` の取引の AE を使って書く経路は無い（取消し・整合性チェックは取引 ID で引く。復元は新しい行を取る）。
- 低：`clearTransactionRows` は G 列（相手税区分）を空にしない。キャッシュバックの行を対象外にすると、空いた行の G に `対象外` が残る（詰めたときは T の G で上書きされる）。

---

## 9. 実装と監査の記録（2026-11-12）

**実装：**OpenCode（Go の DeepSeek V4.1 Flash、worktree `go/import-wait-notice` の続き）。1 回目 4537 秒・$0.43、直し 1 は 2690 秒・$0.15、直し 2 は 766 秒・$0.08。変えたのは §4 のファイルと、`phase0`（エラー一覧 58→60）・`phase7`（menu 12b・16）だけ。`55`・`43`・`45`・`53`・`61`・`70`・`71` は無変更。

**監査で見つけて直したもの：**
- **高：**1 回目は動く取引しか取引ログと照らさず、F〜L を AE で指す別の生きた取引を見ていなかった。`xb 4` の (e) で、対象外にならなかった取引の AE が詰めた後に別の取引の行を指した（次の採用で上書きする）。実装者は `xb 4` を許す形に緩め、`xb 3` も行の範囲だけに緩めていた → §2.2.6（1.1）。直し 1 は条件どおりに作ったが (e) を集められず、テストを緩めずに止まって報告した → 要確認の M・N 列も見る（1.2）。`xb 3` は全セル比較、`xb 4` は元の厳しさ（(c) だけ詰めた後の正確な状態）。
- 低：`webAppInvoke_` の後始末の最初の読取が `try` の外だった → 中へ（`cmp 18`）。

**受け入れた既存テストの直し：**`phase0` のエラー一覧（2 コード追加）、`kw2 32`（確認の文）、`ops menu 12b`・`16`・`kw2 7`（詰めた後の期待。確かめる中身は残る）、`xb 1`・`2`・`5`（1 件ずつを下から。同値の比較のため）、`cmp 2` の材料（前からの空き行の取引を `CANCELED` に。§2.2.6 で止まるため）。

**テスト：**固定データ無しで 1973/2070（落ちるのは ENOENT の 97 件だけ）。固定データを写して 2070/2070。写したものは消した。

**変異：**K1〜K15（1 回目）・K16・K17（直し 2）はすべて赤。K4・K7・K11 は直し 1 で入れ直して赤。

**読取（cmp 13）：**詰める処理は 13 回（取引 5 件でも 50 件でも同じ）。1 件ずつの対象外 1 件は詰める処理を含めて 43 回（含めないと 30 回）。

**記録だけの低：**`withScriptLock_` が取れないとき理由が `LEASE_LOST` の文になる。取引ログに 1 行でも読めない行があると詰める処理は毎回 `COMPACTION_FAILED`（止まる側）。

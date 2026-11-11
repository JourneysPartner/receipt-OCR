# 「その他の要確認」をサーバー側でまとめて対象外にする（第 2 段） 仕様書

作成日：2026-11-11
版：1.0
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いてあることは変えない。書いていないことは安全側で決め、決めたことは全部報告する。
前提：`work/spec_other_reviews_server_batch.md`（全体の案。2 段に分ける決定）、`work/spec_other_reviews_post_batch.md`（第 1 段。本番 `gas-push-145`・受入合格）、`work/spec_other_reviews_bulk.md`（画面だけの版。本番 `gas-push-144`）。

改訂履歴：
- 1.0（2026-11-11）：初版。利用者の依頼（2026-11-11）：「第 2 段の仕様書を書いて」。

---

## 1. 何を直すか

### 1.1 いまの「まとめて対象外」は、中で 1 件ずつ対象外にしている

第 1 段で、まとめて確定の**計上**（`POST_PRIOR_YEAR`・`POST_ZERO_AMOUNT`）はサーバーでファイルごとにまとめるようになった（41 件・2 ファイルで 29 秒＋13 秒）。**対象外**（`EXCLUDE_PRIOR_YEAR`・`EXCLUDE`）はまだ画面だけの版のままで、選んだ行ごとに `webAppResolveOtherReview` を 1 回ずつ呼ぶ。1 件で読取を 20 回以上使うので、1 分に 2〜3 件しか進まない。

### 1.2 本仕様がすること（第 2 段）

1. 新しい部品 `excludeOtherReviewsBatch(customerId, fileId, decisions, options)` を**新しいファイル** `src/57_ReviewExclusionBatch.gs` に作る（§2.2）。1 ファイルの分の対象外を、同じ表を 1 回ずつ読んでまとめて行う。結果は 1 件ずつ対象外にしたときと同じ（§4）。
2. 公開関数 `webAppResolveOtherReviewsBatch`（80）が対象外の 2 つも受け付け、その 2 つのときだけ新しい部品を呼ぶ（§2.3）。押せるかの判定・時間の門・戻り値の形は第 1 段のまま。
3. 画面（81）：まとめて確定の 4 つの操作をすべてサーバーでまとめる流れにする。画面だけの版の「1 件ずつ順に呼ぶ」流れは使われなくなるので消す（§2.4）。

**41 件（2 ファイル）で 1 分前後**の見込み（第 1 段の実測に、転記先の読取 1 ファイル 2 回前後が足される）。

### 1.3 変えないもの

- **部品 55（`src/55_PartnerBatchResolution.gs`）は 1 文字も変えない。**第 1 段の計上と取引先の経路はそのまま（55 は対象外の操作を今どおり `TypeError` で拒む）。
- 1 件ずつの経路：`resolveReview`・`excludeTransaction_`（51）、`applyResolveDecision_`（96）、`webAppResolveOtherReview`（80）、行ごとの「操作を選ぶ」と［確定…］・取引先の表の行ごとの「対象外」（81）。
- 取引先の経路：`webAppResolveReviews`（80）。
- 43・45・50・51・53・61・96・97。**97 は触らない**（文字列の中に生の NUL バイトがある）。使うだけの関数（`clearTransactionRows`・`verifyWrittenValues`・`buildIndex`・`getRowByTxId`・`getAllValuesByRow`・`writeColumnNumber_`・`reviewWriteCustomer_`・`recordedDestinationOf_`・`txHasDestinationRow_`・`partnerBatchReadTransactions_`・`partnerBatchMessage_`・`partnerBatchClockNow_`・`appendAuditRowsUnlocked_`・`allReviewRecordsAndAuditTail_` など）も変えない。

---

## 2. 設計

### 2.1 1 件ずつの対象外が書くもの（同じにする相手）

`webAppResolveOtherReview` → `applyResolveDecision_` → `resolveReview` → `excludeTransaction_`（51）の順に、次のことをする。

1. 取引を読む（`getTransaction`。リースの外）。状態が `REVIEW_REQUIRED`／`COMMITTED` でなければ止まる。freee 取込済み（`IMPORTED`／`NEEDS_FREEE_FIX`）なら止まる。
2. ファイルのリースを取る（`WRITE_ONLY`）。
3. `tx.destinationRow` があれば、要確認行の転記先（`reviewWriteCustomer_(review)`）のその行を `clearTransactionRows` で空にする（取引 ID・B・F・I・K・M 列、列対応にあれば L・C 列）。**行に入っている取引 ID は確かめず、読み返しもしない。**
4. 取引ログ：J（10）＝`CANCELED`、AS（45）＝日時（`updateTransactionStatus`。比較更新）。
5. リースを返す。
6. 要確認行：B（2）＝`EXCLUDED`、AB（28）＝実行者、AC（29）＝日時、AD（30）＝操作コード、AE（31）＝役割（`auth.role`。空なら書かない）、Z（26）＝元の検出詳細に `previousStatus`（手順 1 で読んだ状態）を**足した** JSON、AF（32）＝`REVIEWER_JUDGEMENT`。R（18）・V（22）・W（23）には触れない。
7. 監査：`{type: 'REVIEW_RESOLVE', actor, targetType: 'TRANSACTION', targetId: fullTxId, before: {transactionStatus: <手順 1 の状態>}, after: {transactionStatus: 'CANCELED', excludeReason: 'REVIEWER_JUDGEMENT'}}`。
8. 確定の判定はしない（`CANCELED` は終端）。ファイルの後始末（`commitSettledTransactions_`・`completeFileIfFullyResolved_`）を 1 回。

書かないもの：取引ログの L 列（取引先の解決状態。対象外は変えない）と J・AS 以外の列、同じ取引の**他の**要確認（`OPEN` のまま残る。今の 1 件ずつと同じ）。

### 2.2 新しい部品 `excludeOtherReviewsBatch(customerId, fileId, decisions, options)`（`src/57_ReviewExclusionBatch.gs`）

`decisions` は `{reviewId, operation}` の配列（`operation` は `EXCLUDE_PRIOR_YEAR` か `EXCLUDE`。同じ呼出しに両方あってよい ── することは同じ）。`options` は `{actor, role, customer}`。

**戻り値は部品 55 と同じ形**（80 が同じ写し方を使えるように）：
```
{runId, fileId, customerId,
 resolvedReviewIds: [],        // 対象外にできた件
 committedReviewIds: [],       // いつも空（対象外は確定しない）
 unmet: [],                    // いつも空
 errors: [{reviewId, code, message}],
 skippedByLeaseReviewIds: [], notAttemptedReviewIds: [], leaseConflict: null | {message},
 followUp: null | {orphanCandidates}, ms, reads}
```
`decisions` の 1 件は必ず、`resolvedReviewIds`・`errors`・`skippedByLeaseReviewIds`・`notAttemptedReviewIds` のどれか 1 つだけに入る。件の失敗は `partnerBatchFail_` と同じ規則で印を件に付ける（同じ件に 2 つ目の理由は積まない）。

**文：**部品の中に文の表を持つ（下の 4 つ）。表に無いコードは `partnerBatchMessage_(code)` の文を使う。
| `code` | 文 |
|---|---|
| `DUPLICATE_TRANSACTION` | `同じ取引の要確認がほかにも選ばれています。対象外は取引ごとなので、1 件だけ選んでください。` |
| `FREEE_IMPORTED` | `freee に取り込み済みの取引です。画面からは対象外にできません。管理者へ連絡してください。` |
| `DESTINATION_ROW_MISMATCH` | `転記先の行がこの取引の行と一致しません（行が動いたか、別の取引の行になっています）。管理者へ連絡してください。` |
| `DESTINATION_VALUE_MISMATCH` | `転記行を空にしたあと読み返すと値が残っていました。取引は対象外にしていません。管理者へ連絡してください。` |

**手順：**

0. **入力の検査（読まない・書かない。外れたら `TypeError`）：**`customerId`・`fileId` が空でない文字列、`decisions` が配列で各要素がオブジェクト・`reviewId` が空でない文字列・`operation` が上の 2 つのどれか、`options` がオブジェクトで `actor` が空でない文字列、`role` は文字列か `null`／`undefined`、`options.customer` があれば `customerId` が一致。
1. **上限：**先頭 `PARTNER_BATCH_MAX_ITEMS_` 件（呼んだ時点の値）を扱い、残りは `notAttemptedReviewIds`。同じ `reviewId` の 2 回目以降は `DUPLICATE_DECISION`。
2. **要確認を 1 回読む（`allReviewRecords_()`。同じ ID が複数行なら最初の行）。**件ごとに、外れたら失敗にして以後扱わない：

| 条件 | `code` |
|---|---|
| 要確認が無い | `REVIEW_NOT_FOUND` |
| `review.customerId` が違う | `REVIEW_CUSTOMER_MISMATCH` |
| `review.fileId` が違う | `REVIEW_FILE_MISMATCH` |
| `status` が `OPEN`／`IN_PROGRESS` でない | `ALREADY_SETTLED` |
| `availableResolveOperations(review.reviewType)` に操作が無い | `OPERATION_NOT_OFFERED` |
| 同じ呼出しの先の件と同じ `review.fullTxId` | `DUPLICATE_TRANSACTION` |

   - `DUPLICATE_TRANSACTION` の理由：対象外は取引ごとなので、1 件目で取引が `CANCELED` になる。1 件ずつの経路なら 2 件目は「取引の状態 CANCELED では不可」で止まり、要確認は `OPEN` のまま残る。まとめても同じ終わりの状態にする（2 件目には書かない）。
   - 残りが 0 なら、リースを取らずに返す（`followUp: null`）。
3. **リース：**`acquireLease(customerId, fileId, runId, actor, LEASE_PURPOSE.WRITE_ONLY)` を 1 回（`runId = generateId('XB')`）。`LEASE_CONFLICT` なら残りの件を全部 `skippedByLeaseReviewIds` に入れ、`leaseConflict = {message: partnerBatchMessage_('LEASE_CONFLICT')}` で返す。他の例外はそのまま投げる。以下は `try`、`finally` で必ず `releaseLeaseById(leaseId, 'RESOLVE_DONE')`。
4. **ファイルの取引を 1 回読む（`getTransactionsForFile_(fileId)`）。**件ごとに：

| 条件 | `code` |
|---|---|
| `review.fullTxId` の有効な行が無い | `TX_NOT_FOUND` |
| 有効な行が 2 行以上 | `TRANSACTION_LOG_AMBIGUOUS` |
| 状態が `REVIEW_REQUIRED`／`COMMITTED` でない | `STATE_TRANSITION` |
| `freeeStatus` が `IMPORTED`／`NEEDS_FREEE_FIX` | `FREEE_IMPORTED` |

   - **リースを持ってから読んだ値**でもう一度確かめる（1 件ずつの経路はリースの外で読んだ値で決まる）。通った件は `item.tx`・`item.from = tx.transactionStatus` を持つ。
5. **転記先を決める（読まない）。**件ごとに `dest = reviewWriteCustomer_(review, customer)`（`customer` は `options.customer` か `getCustomerById(customerId)` を 1 回）、`recorded = recordedDestinationOf_(tx, customer)`：
   - `recorded` があり、`recorded.spreadsheetId`・`recorded.sheetName` が `dest` の `destinationSpreadsheetId`・`destinationSheetName` と違う → `DESTINATION_ROW_MISMATCH`。（要確認行と取引ログが別の転記先を指している。どちらの行を消すべきか分からないので消さない。1 件ずつの経路は要確認行の側を消す。）
   - `tx.destinationRow` が空（`''`／`null`／`undefined`）でなく、`txHasDestinationRow_(tx)` が偽 → `DESTINATION_ROW_MISSING`。
   - 同じ `(dest の転記先, destinationRow)` を 2 件以上が指す → その全部を `DESTINATION_ROW_CONFLICT`（取引ログの壊れ。どれも消さない）。
   - 残った件を `dest` の転記先（スプレッドシート ID・シート名）ごとにまとめる（最初に現れた順）。
6. **転記先ごとに（1 つの転記先の失敗で他の転記先を止めない。ただし `LEASE_CONFLICT` は全体を止める）：**
   1. 索引を 1 回作る：`index = buildIndex(dest, {valuesOnly: true})`。例外なら、その転記先の件を全部 `error.code || 'DESTINATION_READ_FAILED'` で失敗にして次の転記先へ。
   2. 件ごとに行の扱いを §2.2.1 の表で決める（`CLEAR`・`ALREADY_CLEARED`・`NO_ROW`・`DESTINATION_ROW_MISMATCH`）。
   3. `CLEAR` の行が 1 つ以上あれば `clearTransactionRows(dest, rows, leaseId, fileId)` を 1 回（行は件の順。重ねない）。
   4. 読み返す：`verifyWrittenValues(dest, rows.map(row → {rowNumber: row, fullTxId: null, values: <空の値>}))` を 1 回。<空の値> は `{b: '', f: '', i: '', k: '', m: ''}` に、列対応に C があれば `c: ''` を足したもの（`53_CancelRestoreManager.gs` の手順 9 と同じ考え方）。`ok` が偽の行の件は `DESTINATION_VALUE_MISMATCH`（**取引は `CANCELED` にしない**）。
   5. 3・4 が例外なら、その転記先の件を全部 `error.code || 'WRITE_FAILED'` で失敗にする。`code` が `LEASE_CONFLICT` なら、まだ失敗していない件を**全部** `LEASE_CONFLICT` で失敗にして、手順 7 へ進まない（リースを失ったので書かない）。
7. **取引ログ・要確認・監査（1 つの `withScriptLock_` の中で、この順に）：**手順 6 を通った件（`CLEAR` で読み返しが合った件・`ALREADY_CLEARED`・`NO_ROW`）だけ。0 件なら飛ばす（`followUp` は下の式で作る）。
   1. 読む：`current = allReviewRecordsAndAuditTail_()`、`txById = partnerBatchReadTransactions_(items)`。
   2. 件ごとに：要確認が無いか `OPEN`／`IN_PROGRESS` でない → `ALREADY_SETTLED`。取引が無いか有効でないか、状態が `item.from` と違う → `CONCURRENT_CHANGE`。
   3. 取引ログ（残った件）：J（10）＝`CANCELED`、AS（45）＝`nowIso_()`。`Sheets.Spreadsheets.Values.batchUpdate`（`valueInputOption: 'RAW'`、`SETTLE_BATCH_RANGES_` ごとに分ける）。**他の列（特に L）には書かない。**
   4. 要確認（同じ件）：B（2）＝`EXCLUDED`、AB（28）＝`actor`、AC（29）＝`nowIso_()`、AD（30）＝その件の `operation`、AE（31）＝`options.role`（空なら書かない）、Z（26）＝`JSON.stringify(Object.assign({}, current の要確認の detail ? jsonCell_(detail, {}) : {}, {previousStatus: item.from}))`、AF（32）＝`REVIEW_EXCLUDE_REASON.REVIEWER_JUDGEMENT`。R・V・W には触れない。1 回の `batchUpdate`。
   5. 監査：`appendAuditRowsUnlocked_(entries, current.auditTail)`。`entries` は件ごとに §2.1 の 7 と同じ形。
   6. 3〜5 の後で、残った件を `resolvedReviewIds` に入れる。
   - **順序（3 → 4 → 5）を変えてはならない**（§2.2.2）。
8. **後始末の材料：**`followUp = {orphanCandidates: <数>}`。数は、手順 4 で読んだファイルの取引のうち、有効で `REVIEW_REQUIRED`、手順 7 で `CANCELED` にしておらず、手順 7 で読んだ要確認（この呼出しで閉じた件を除く）に `OPEN`／`IN_PROGRESS` が 1 つも無いものの数（55 の `followUp` と同じ考え方）。手順 7 に入らなかったときも、手順 4 まで進んでいれば同じ式で作る（要確認は手順 2 で読んだもの）。手順 4 より前に終わったら `null`。
9. **ログ：**`Logger.log('EXCLUDE_BATCH ' + JSON.stringify({runId, fileId, items, operations, excluded, errors, skippedByLease, notAttempted, destinations, rowsCleared, alreadyCleared, noRow, ms, reads, orphanCandidates}))`。数とコードだけ（`operations` はその呼出しの操作コードを重ねずに並べた配列）。**明細の値・店名・ファイル名・取引先名・転記先の ID を出さない。**

**先頭の説明：**57 の冒頭に、なぜ別の部品にしたか（§9）、行を取引 ID で確かめる理由、手順 6 → 7 の順序の理由（§2.2.2）を書く。

#### 2.2.1 転記行の扱い（手順 6-2）

`dr` ＝ `tx.destinationRow`、`hit` ＝ `getRowByTxId(index, fullTxId)`、`row` ＝ `getAllValuesByRow(index, dr)`、「消す列」＝ `clearTransactionRows` が空にする列（`txId`・`b`・`f`・`i`・`k`・`m`、列対応に L があれば `l`、C があれば `c`。列番号は `writeColumnNumber_(dest, key)`）、「空」＝ `''`／`null`／`undefined`。

| 条件 | 扱い |
|---|---|
| `dr` がある、`hit` が 1 行で、その行が `dr` | `CLEAR`（`dr` を空にする） |
| `dr` がある、`hit` が 0 行、`recorded` がある、`row` が索引の中で消す列がすべて空 | `ALREADY_CLEARED`（書かない。前の呼出しが空にした後で止まった形） |
| `dr` が空、`hit` が 0 行 | `NO_ROW`（書かない。1 件ずつの経路も行を消さずに対象外にする） |
| 上のどれでもない（`hit` が別の行・2 行以上、`row` が索引の外、`recorded` が無いのに `hit` が 0 行、`row` に値が残るのに `hit` が 0 行、`dr` が空なのに `hit` がある） | `DESTINATION_ROW_MISMATCH`（書かない） |

- **行を取引 ID で確かめる理由：**1 件ずつの経路は行番号だけで消す。転記先の行が並べ替えなどで動いていると、**別の取引の行を消す**（帳簿の行が消え、取引ログはその取引が居ると言い続ける）。まとめると一度に消す行が多いので、消す前に「この行にこの取引の ID が入っている」ことを確かめる。
- **`recorded` が無い取引（取引ログ AC が空の旧い行）は `ALREADY_CLEARED` にしない：**旧い行の転記先は推測でしかないので、行が空でも「前に自分が空にした」とは言えない（K-W14：推測が外れると 1 行も消せず取引ログだけ `CANCELED` になる）。普通の場合（`CLEAR`）は旧い行でも通る。

#### 2.2.2 途中で止まったとき（手順 6 → 7 の順序の理由）

| 止まった所 | 残る状態 | もう一度同じ ID で呼ぶと |
|---|---|---|
| 手順 6 の前 | 何も変わらない | 普通に進む |
| 行を空にした後・取引ログの前（読み返し・ロック待ち・取引ログの読取の失敗など） | 行は空、取引は生きている、要確認は `OPEN` | 80 の判定は通る。部品は `ALREADY_CLEARED` で書かずに進み、取引を `CANCELED`・要確認を `EXCLUDED` にする（`recorded` がある取引だけ。無ければ `DESTINATION_ROW_MISMATCH`） |
| 取引ログの後・要確認の前 | 取引は `CANCELED`、行は空、要確認は `OPEN` | 80 で `OPERATION_DISABLED`（取引の状態 CANCELED では不可）。**画面からは閉じられない。帳簿は正しい。**1 件ずつの経路で同じ所で止まっても同じ状態になる |
| 要確認の後・監査の前 | 監査の 1 行が無い | `ALREADY_SETTLED`。1 件ずつの経路と同じ |

- **行を先に空にする**（`53` の取消しとは逆の順）。先に取引を `CANCELED` にして行を消す前に止まると、`CANCELED` の取引の行が帳簿に残り（幽霊行）、取引は終端なので画面からはどの操作も届かない。行を先に消せば、止まってもやり直せる。
- **取引ログを要確認より先に書く。**逆にすると、要確認が `EXCLUDED`・取引が `REVIEW_REQUIRED`・行は空、の形で止まり得る。この取引は要確認が残っていないので、後始末（`commitSettledTransactions_`）が**空の行のまま確定する**。

### 2.3 公開関数 `webAppResolveOtherReviewsBatch`（`src/80_WebApp.gs`）の変更

変えるのは次の 3 つだけ。他の行（要確認・取引の頭の読取、件ごとの判定、ファイルの分け方、門、戻りの写し方、リース衝突、後始末、ログ、戻り値）は 1 文字も変えない。

1. 定数：`WEBAPP_OTHER_BATCH_CODES_ = ['POST_PRIOR_YEAR', 'POST_ZERO_AMOUNT', 'EXCLUDE_PRIOR_YEAR', 'EXCLUDE']`。`WEBAPP_OTHER_EXCLUDE_CODES_ = ['EXCLUDE_PRIOR_YEAR', 'EXCLUDE']` を足す。
2. 部品の呼出し：`code` が `WEBAPP_OTHER_EXCLUDE_CODES_` にあれば
   `excludeOtherReviewsBatch(wantedCustomerId, fileId, sent.map(→ {reviewId, operation: code}), {actor: actor, role: auth.role || null, customer: customer})`、
   無ければ今の `resolvePartnerReviewsBatch(...)` の呼出しをそのまま。**関数は呼ぶ時に名前で引く**（テストが包めるように。読み込み時に変数へ控えない）。
3. コメント：関数の先頭と定数の「対象外の 2 つはここでは受けない」を、対象外は部品 57 へ渡すこと・役割を渡す理由（1 件ずつの経路は要確認行の AE に役割を書く）に直す。

押せるかの判定（`webAppOtherReviewOptions_`）は計上と同じく件ごとに掛かる。対象外では、役割（`REVIEWER` 以上）・取引の状態・freee 取込済み（`（freee取込済みのため画面から不可。管理者へ）`）・種別（`EXCLUDE_PRIOR_YEAR` は前年利用日だけ、`EXCLUDE` は取引先・利用日・金額・0 円）がここで外れる。`PARTNER` の要確認を `EXCLUDE` で送った場合も、1 件ずつの経路と同じく通る（画面の「その他の要確認」の表には出ないので、画面からは来ない）。

戻り値の `committed` はいつも 0、`unmetTexts` はいつも空になる。`label` は `前年の利用分として対象外にする（転記行を空にします）` か `対象外にする（転記行を空にします）`。

### 2.4 画面（`src/81_WebAppUi.html`）の変更

1. `OTHER_SERVER_BATCH_CODES = ['POST_PRIOR_YEAR', 'EXCLUDE_PRIOR_YEAR', 'POST_ZERO_AMOUNT', 'EXCLUDE']`（帯の操作の 4 つすべて）。
2. `runOtherBulk` は、押した時の条件（`isMutationBusy()`・選択 0・操作が空・共通部分に無い）を確かめた後、いつも `runOtherServerBulk(code, targets)` を呼ぶ。**1 件ずつ順に `webAppResolveOtherReview` を呼ぶ繰り返しと、それだけが使う関数（`otherBulkConfirmMessage` など）は消す**（使われなくなるため）。他でも使っている関数（`otherResultNotice`・`otherBulkTargetLabel`・`otherBulkReason`・`otherBulkIsCurrent`・`otherBulkTypeSummary` など）は残す。消したものは全部報告する。
3. `runOtherServerBulk` とその文は変えない（確認の文は `otherServerBulkConfirmMessage`。対象外では `TEXT.otherEffect` が `転記行の B・F・I・K・M列と取引 ID を空にし、取引を対象外にします。取り消せません（戻すには管理者による再取込が必要です）。` を出す）。新しいコード（`FREEE_IMPORTED`・`DESTINATION_ROW_MISMATCH`・`DESTINATION_VALUE_MISMATCH`・`DUPLICATE_TRANSACTION`）の文は、今の `otherServerErrorText` どおりサーバーの `message` がそのまま詳細に出る。
4. コメントの「計上の 2 つだけサーバーでまとめる。対象外の 2 つは今の 1 件ずつの流れ」を直す。
5. 1 件ずつの確定（行ごとの［確定…］・取引先の表の「対象外」）は変えない。

---

## 3. 安全の条件（テストで確かめる）

サーバー：
- **X1**：転記先で変わるのは、対象外にした取引の行の「消す列」だけ。他の行・他の列・他のシート・他の転記先は 1 セルも変わらない。
- **X2**：行を消すのは、その行の取引 ID 列にその取引の ID が入っていて、行番号が取引ログの `destinationRow` と同じで、要確認行と取引ログ（記録があれば）が同じ転記先を指すときだけ（§2.2.1）。**別の取引の行は消さない。**
- **X3**：取引を `CANCELED` にするのは、行を空にして読み返しで空と確かめた後（または `ALREADY_CLEARED`・`NO_ROW`）だけ。値が残った行の取引は `CANCELED` にしない。
- **X4**：取引ログに書くのは J（`CANCELED`）と AS だけ。L・S〜AB・AT〜AW には書かない。取引を `COMMITTED` にしない。
- **X5**：要確認を `EXCLUDED` にするのは、ロックの中で読み直して `OPEN`／`IN_PROGRESS` のときだけ、かつ同じロックで取引ログを書いた後だけ。書く列は §2.2 手順 7-4 の列だけで、Z は元の検出詳細の鍵を全部残す。
- **X6**：押せない件（役割・取引の状態・freee 取込済み・種別・顧客違い・ファイル単位・取引が特定できない）には何も書かない。リースを持ってから取引の状態か freee の状態が変わっていたら書かない（`STATE_TRANSITION`・`FREEE_IMPORTED`）。
- **X7**：リースは必ず返す（例外でも）。時間の門で 6 分の上限より前に止まる。
- **X8**：恒等式（第 1 段 §2.2.1）。
- **X9**：選んでいない要確認（同じ取引の別の要確認を含む）に触れない。
- **X10**：計上・取引先・1 件ずつの経路の振る舞いは変わらない（55 は変えない。既存のテストが期待を変えずに通る）。
- **X11**：ログに明細の値・店名・ファイル名・取引先名・転記先の ID が出ない。
- **X12**：行を空にした後・取引ログの前で止まっても、同じ ID でもう一度呼べば対象外が済み、止まらなかったときと同じ状態になる（`recorded` のある取引）。

画面：
- **V1**：まとめて確定は、4 つの操作のどれでも `webAppResolveOtherReview` を 1 回も呼ばず、`webAppResolveOtherReviewsBatch` を呼ぶ。送る ID・`code`・繰り返し・止まる条件・［中止］・画面の切替・押せない間は第 1 段の U1〜U5・U7 と同じ。
- **V2**：1 件ずつの確定は変わらない。

---

## 4. 1 件ずつの経路との違い（これ以外は同じでなければならない）

**同じでなければならないもの（対象外にできた件について）：**転記先の全セル、取引ログの全列（AS の日時を除く）、要確認行の B・R・V・W・Z・AB・AD・AE・AF、監査の `REVIEW_RESOLVE` 行（数・実行者・対象・`before`・`after`。ID・日時・並びを除く）、処理ログのファイルの状態（完了したか）、同じ取引の他の要確認（`OPEN` のまま）。

**違ってよいもの（全部）：**
1. リースをまとまりに 1 回取る（1 件ずつは件ごとに取る）。だから `LEASE_RELEASE` の監査行の数が違う。
2. 消す前に転記先の索引で行を確かめ、合わなければ `DESTINATION_ROW_MISMATCH` で書かない（1 件ずつは行番号だけで消す）。
3. 消した後に読み返し、値が残れば `DESTINATION_VALUE_MISMATCH` で取引を `CANCELED` にしない（1 件ずつは読み返さない）。
4. リースを持ってから取引の状態と freee の状態をもう一度確かめる（`STATE_TRANSITION`・`FREEE_IMPORTED`）。
5. 前の呼出しが空にした行を `ALREADY_CLEARED` として書かずに進む（1 件ずつは同じ行番号をもう一度空にする）。
6. 同じまとまりの件は同じ日時になってよい。監査行の並びは違ってよい。
7. ファイルの完了判定はファイルごとに最後に 1 回（1 件ずつは件ごと）。終わりの状態は同じ。
8. 他者のリースがあると、1 件ずつは件ごとに `LEASE_CONFLICT` の失敗、まとめてはファイルの件を `skippedByLeaseReviewIds` に入れる。
9. 同じ取引の 2 件目は `DUPLICATE_TRANSACTION`（1 件ずつは 2 件目が `OPERATION_DISABLED` で止まる。終わりの状態は同じ）。

---

## 5. 変えてよいファイル

- `src/57_ReviewExclusionBatch.gs`（新しく作る。§2.2）
- `src/80_WebApp.gs`（§2.3 の 3 つだけ）
- `src/81_WebAppUi.html`（§2.4）
- `test/phase8-webapp.test.js`（§6.1 の `xb N` を `pb` のテストの並びの後ろに足す。`pbWorld`・`pbBatch`・`pbResolve`・`pbFileReviews`・`pbSourceRow`・`pbAuditEvents`・`pbComparable`・`pbDestinationSnapshot`・`pbItemState`・`pbMeasure`・`withPartnerTiming`・`withMocks`・`transactionFor`・`reviewById`・`kw2` の道具を使ってよい）
- `test/phase9-format-registration.test.js`（§6.2 の `xbu N` を `pbu` の並びの後ろに足す。§6.3 の直し）

テストの材料は架空の表で作る（実明細の値を写さない）。

---

## 6. テスト

### 6.1 サーバー（`xb N: …`）

材料は第 1 段の `pb` と同じ作り方（個人・`fiscalYear: 2026`・`2025/…` の利用日で `PRIOR_YEAR`、金額 0 で `ZERO_AMOUNT`、`既知店` は取引先が決まり `未知店` は `PARTNER` が残る）。`DATE` の要確認は `kw2` の道具で作る（作れなければ報告して `registerReview` で足す）。

1. **xb 1（同値・前年利用日）**：同じ材料の世界を 2 つ（`既知店` 2 行・`未知店` 1 行、すべて前年利用日）。一方は `EXCLUDE_PRIOR_YEAR` で `webAppResolveOtherReview` を 1 件ずつ、他方は `webAppResolveOtherReviewsBatch` を 1 回。§4 の「同じでなければならないもの」が一致する（`pbComparable` に、同じ取引の他の要確認の状態を足して比べてよい）。戻りは `resolved: 3`・`committed: 0`・`unmetTexts: []`・`errors: []`。3 件の取引が `CANCELED`、転記行の消す列が空、`未知店` の `PARTNER` の要確認は `OPEN` のまま（X9）。
2. **xb 2（同値・`EXCLUDE`）**：`ZERO_AMOUNT` 2 件・`DATE` 1 件を `EXCLUDE` で、1 と同じ比較。別に `PARTNER` の要確認 1 件を `EXCLUDE` で送ったときも 1 件ずつと同じになる。
3. **xb 3（書く列）**：対象外の前後で、取引ログは J・AS だけ、要確認行は B・AB・AC・AD・AE・Z・AF だけが変わる。Z は元の鍵を全部残して `previousStatus` が足される。AE は 1 件ずつの経路と同じ役割。転記先は対象の行の消す列だけが変わり、他の行・列・転記先（雛形・複製）は同じ（X1・X4・X5）。
4. **xb 4（行を取引 ID で確かめる）**：次のそれぞれで、その件は `DESTINATION_ROW_MISMATCH`、その件の転記先・取引・要確認は 1 セルも変わらず、同じ呼出しの他の件は対象外になる（X2）：(a) `dr` の行の取引 ID 列に別の取引の ID を入れる、(b) 行を動かす（`dr` の行を空にし、別の行にその取引の値と ID を入れる）、(c) 取引ログの AC を別のスプレッドシート ID にする、(d) その取引の ID を 2 行に入れる、(e) 取引ログの AC を空にし、`dr` の行を空にする。
5. **xb 5（行を空にした後で止まっても、やり直せる）**：部品の手順 7 の頭（`allReviewRecordsAndAuditTail_`）で 1 回だけ例外を起こす → 送った件は `errors`、転記行は空、取引は `REVIEW_REQUIRED` のまま、要確認は `OPEN`、リースの行は残らない。もう一度同じ ID で呼ぶと全件が対象外になり、xb 1 の 1 件ずつの世界と同じ状態（監査の `REVIEW_RESOLVE` は件ごとにちょうど 1 行）。部品のログで `alreadyCleared` が件数と同じ（X12）。
6. **xb 6（読み返しで値が残ったら取り消さない）**：`clearTransactionRows` を、1 件の行だけ空にしない形に包む → その件は `DESTINATION_VALUE_MISMATCH`、取引は `CANCELED` にならず、要確認は `OPEN`、監査は増えない（X3）。他の件は対象外になる。
7. **xb 7（件ごとの番人）**：同じ呼出しに、無い ID・他の顧客の要確認・確定済みの要確認・`ZERO_AMOUNT` に `EXCLUDE_PRIOR_YEAR`・ファイル単位の要確認・取り消した取引に残った要確認・freee 取込済み（取引ログの freee の状態を `IMPORTED` にした）・同じ ID の 2 回目を混ぜる。普通の件は対象外になり、それぞれ `REVIEW_NOT_FOUND`・`REVIEW_CUSTOMER_MISMATCH`・`ALREADY_SETTLED`・`OPERATION_NOT_OFFERED`・`OPERATION_NOT_OFFERED`・`OPERATION_DISABLED`・`OPERATION_DISABLED`（`message` は `（freee取込済みのため画面から不可。管理者へ）`）・`DUPLICATE_DECISION`。失敗の件の転記先・要確認・取引は 1 セルも変わらない（X6）。恒等式が成り立つ（X8）。
8. **xb 8（リースの中で見直す）**：部品の手順 4 の読取の直前に（`withMocks` で `getTransactionsForFile_` を包む）(a) 取引を `CANCELED` へ、(b) freee の状態を `IMPORTED` へ書き換える → (a) `STATE_TRANSITION`、(b) `FREEE_IMPORTED`。どちらも転記先の行は変わらない（X6）。
9. **xb 9（閉じられた要確認・変わった取引）**：手順 7 の直前に (a) 1 件の要確認だけを `updateReviewStatus(…, 'EXCLUDED', …)` で閉じる → `ALREADY_SETTLED`、要確認は上書きされず、その取引は `CANCELED` にならない。(b) 1 件の取引の状態を別の値へ書き換える → `CONCURRENT_CHANGE`。他の件は対象外になる。どちらも報告に「行は空になったまま」と書く（§2.2.2 の残り）。
10. **xb 10（同じ取引の 2 件目）**：同じ取引の `DATE` と `ZERO_AMOUNT`（または `registerReview` で足した 2 件目）を `EXCLUDE` で同じ呼出しに入れる → 2 件目が `DUPLICATE_TRANSACTION`（§2.2 の文）、1 件目は対象外、2 件目は `OPEN` のまま。1 件ずつで同じ 2 件を順に呼んだ世界と、転記先・取引ログ・2 件の要確認の状態が同じ。
11. **xb 11（同じ転記行）**：取引ログを書き換えて 2 つの取引の `destinationRow` を同じにする → 両方 `DESTINATION_ROW_CONFLICT`、どちらの行も変わらない。
12. **xb 12（リース衝突）**：他者が 1 つ目のファイルのリースを持つ → そのファイルの件は全部 `skippedByLeaseReviewIds`、`leaseConflicts` に 1 つ、そのファイルの転記先・取引・要確認は変わらない。2 つ目のファイルの件は対象外になる。リースの行は他者の 1 行だけ残る。
13. **xb 13（例外・時間の門・上限）**：(a) `clearTransactionRows` が例外 → 送った件は `errors`、後のファイルの件は `notAttemptedReviewIds`、リースの行が残らない、もう一度呼ぶと全件が対象外。(b) `withPartnerTiming` で 1 つ目のファイルの所要を 200 秒 → 2 つ目のファイルは `notAttemptedReviewIds`、部品は 2 回目を呼ばれない。(c) `PARTNER_BATCH_MAX_ITEMS_` を 2 にして 1 ファイル 3 件 → 1 回の呼出しの中で部品が 2 回呼ばれ、3 件とも対象外。
14. **xb 14（読取が件数に依らない）**：1 ファイル 2 件と 1 ファイル 20 件の `batchGet` の回数が等しい。2 ファイル（20 件と 21 件）の回数と、1 件ずつの経路の 1 件の回数も測って報告する。
15. **xb 15（後始末）**：対象外にした件しか残らないファイル → ファイルが完了し、`completedFiles` に 1 つ。孤児の候補が 0 のとき `commitSettledTransactions_` を呼ばない（回数を数える）。部品が例外を投げたときは呼ぶ。
16. **xb 16（認可と入口）**：権限の無い実行者は例外（転記先・要確認・取引ログ・処理ログは変わらない。監査の `PERMISSION` の拒否行は増えてよい）。部品 57 に計上・取引先の操作を渡すと `TypeError`（読取の回数も変わらず何も書かない）。部品 55 に対象外の操作を渡すと今どおり `TypeError`。`EXCLUDE_PRIOR_YEAR` と `EXCLUDE` を部品 57 の 1 回の呼出しに混ぜてもよく、AD はそれぞれの操作になる。
17. **xb 17（ログ）**：`OTHER_REVIEWS_BATCH` と `EXCLUDE_BATCH` の行に、材料の店名・ファイル名・金額・転記先のスプレッドシート ID の文字列が出ない（X11）。

### 6.2 画面（`xbu N: …`）

道具は `pbu` のもの（`pbuReply`・`pbuStart`・`pbuCalls`・`pbuThreeRows` など）と `ob`・`kw2` のものを使ってよい。

1. **xbu 1（対象外もまとめて呼ぶ）**：`EXCLUDE_PRIOR_YEAR`・`EXCLUDE` のそれぞれで、3 行を選んで実行 → 確認の title は操作の `label`、message は `otherServerBulkConfirmMessage` の文（`TEXT.otherEffect` の対象外の文と `サーバーでファイルごとにまとめて確定します` を含み、`1 件ずつ順に確定します` を含まない）。呼出しは `webAppResolveOtherReviewsBatch` が 1 回で、引数は `['C001', ['r1','r2','r3'], code]`（表の順）。`webAppResolveOtherReview` は 0 回（V1）。
2. **xbu 2（全部済んだ）**：対象外の応答（`committed: 0`・`unmetTexts: []`）で `success` の `「その他の要確認」 3 件をまとめて確定しました（<label>）。`。`取引がまだ確定していません` の文は出ない。
3. **xbu 3（対象外の失敗の文）**：`r2` が `DESTINATION_ROW_MISMATCH`（`message` は §2.2 の文）→ 次を呼ばず、詳細の行が `架空明細.csv 2 行目：<その文>`。`FREEE_IMPORTED`・`DESTINATION_VALUE_MISMATCH`・`DUPLICATE_TRANSACTION` でも同じ形。

### 6.3 既存のテストの扱い

**既存のテストは期待を変えずに緑のままであること。**例外は次の 3 つだけ（直したものはすべて報告）：
- `pbu 10`（対象外は 1 件ずつ）は逆の期待になる。「4 つの操作のどれでも、まとめて確定は `webAppResolveOtherReviewsBatch` を呼び、`webAppResolveOtherReview` を呼ばない」に書き直す（題も直す）。
- `ob 5`〜`ob 11` のうち、まとめて確定を**走らせる**所（操作 `EXCLUDE_PRIOR_YEAR`）は、1 件ずつの繰り返しが無くなるので、呼出しと応答を `webAppResolveOtherReviewsBatch` の形に直す。確かめる中身は残す：ob 5 ↔ pbu 1（1 回の呼出し・表の順・同時に 2 つ呼ばない・進み具合）、ob 6 ↔ pbu 2、ob 7 ↔ pbu 4、ob 8 ↔ pbu 5、ob 9 ↔ pbu 7、ob 10 ↔ pbu 6、ob 11 ↔ pbu 9。番号は残す（題は直してよい）。走らせない所（`ob 1`〜`4`・`12`・`13`、`ob 11` の取込中・形式の操作中の所）は変えない。
- 1 件ずつの繰り返しを消したことで使われなくなる道具（`obResolveCalls` など）は、他で使っていなければ消してよい。

特に緑のままであること：`pb 1`〜`16`、`pbu 1`〜`9`、`batch 1`〜`27`、`fc` の全部、`kw2` の全部、`ob 1`〜`4`・`12`・`13`、`webapp 45h`・`45m`・`45o`、`ui 6`、`pace 1`・`budget 1`・`flush 1`。

---

## 7. 変異（入れて回し、赤になるテストを記録して戻す）

サーバー：
- E1：行の取引 ID を見ずに `dr` を消す（§2.2.1 の表を使わない）
- E2：`recorded` が無い取引も `ALREADY_CLEARED` にする
- E3：要確認行と取引ログの転記先の食い違いを見ない
- E4：読み返し（手順 6-4）を外す
- E5：手順 7 で要確認を取引ログより先に書く
- E6：手順 7 で取引ログに L 列（`RESOLVED_WITHOUT_PARTNER`）も書く
- E7：リースの中で freee の状態を見ない
- E8：リースの中で取引の状態を見ない
- E9：手順 7 で要確認の読み直し（`OPEN`／`IN_PROGRESS` か）を外す
- E10：`finally` でなく成功のときだけリースを返す
- E11：`DUPLICATE_TRANSACTION` の検査を外す
- E12：`DESTINATION_ROW_CONFLICT` の検査を外す
- E13：Z を元の検出詳細と混ぜずに `{previousStatus}` だけで上書きする
- E14：80 で役割を部品へ渡さない
- E15：80 で対象外を部品 55 へ渡す
- E16：ログに `fileName` を足す
- E17：`LEASE_CONFLICT` の後も手順 7 へ進む

画面：
- Q10：対象外を 1 件ずつ呼ぶ（`OTHER_SERVER_BATCH_CODES` を計上の 2 つに戻す）
- Q11：対象外の確認の文に `TEXT.otherEffect` を入れない

---

## 8. 受入（利用者。push の後）

1. 読むだけ（Claude）：`opsShowLeases` でリースが無いこと。
2. 利用者：F5 → TEST01 → 「その他の要確認」で対象外にしてよい行を選ぶ →「前年の利用分として対象外にする」（または「対象外にする」）→［選んだ行をまとめて確定…］→ 確認 →［実行］。
3. 期待：`まとめて確定中… 済み 0 / N 件…` の後、`「その他の要確認」 N 件をまとめて確定しました（…対象外にする…）。` 表から消える。転記先のその行の B・F・I・K・M 列と取引 ID が空になる。
4. Claude：`clasp logs` の `OTHER_REVIEWS_BATCH` と `EXCLUDE_BATCH` で `ms`・`reads`・`rowsCleared` を記録し、本節に追記する。`opsShowLeases` でリースが残っていないこと。

**受入の材料：**2026-11-11 の第 1 段の受入で、TEST01 の未解決の要確認は 0 件になった。対象外は転記行を空にする取り消せない操作なので、**対象外にしてよい行を利用者と決めてから**用意する（例：テスト用の明細を 1 本取り込み、前年利用日か 0 円の行を作る）。

---

## 9. Claude の判断の記録（利用者の決定ではないもの）

- **部品 55 に足さず、新しい部品 57 を作る。**第 1 段は「要確認の書込・確定の判定・リース・門を 1 か所に」と 55 に足した。対象外は確定の判定が無く（`CANCELED` は終端）、書く表（転記先を空にする・取引の状態・要確認の `EXCLUDED`）も監査の形も違う。55 に足すと全部の段に分かれ目が入り、本番で使っている計上・取引先の経路に手が入る。55 を変えなければ X10 はテストを足さずに守れる。時間の門・後始末・戻り値の形は 80 で共通のものを使う。
- **消す前に行を取引 ID で確かめ、消した後に読み返す**（1 件ずつより厳しい）。取り消せない書込を一度に何十件もするので、別の取引の行を消す・値が残ったまま取引を取り消す、の 2 つを書く前と書いた後で止める。読取は転記先ごとに 2 回増えるだけ。
- **行を先に空にし、取引ログ → 要確認の順に書く**（§2.2.2）。止まってもやり直せる所を一番広くし、止まったときに帳簿に幽霊行も空の行の確定も残さない順。
- **取引ログの後・要確認の前で止まった件は、画面からは閉じられない**（1 件ずつの経路と同じ）。閉じられるようにするには押せるかの判定（`webAppOtherReviewOptions_`。1 件ずつ・メニューと共通）を変えることになるので、本仕様ではしない。帳簿は正しい。
- **同じ取引の 2 件目は `DUPLICATE_TRANSACTION`**。文は計上と違い「1 件だけ選んでください」にする（対象外は取引ごとなので、1 件ずつ確定しても 2 件目は閉じられない）。
- **画面だけの版の 1 件ずつの繰り返しは消す。**4 つの操作がすべてサーバーへ行くので使われない。残すと、どこからも呼ばれないのにテストだけがある形になる。`ob 5`〜`11` は消さずにサーバーの流れの確かめに直す。
- **`PARTNER` の要確認の `EXCLUDE` も通す。**押せるかの判定を 1 件ずつの経路と同じ関数で行う以上、そこで通るものは通す（画面の「その他の要確認」の表には出ないので、画面からは来ない）。

**見つけたこと（本仕様の外。記録して利用者へ伝える）：**
- **中：1 件ずつの「対象外」（51 の `excludeTransaction_`）は、転記先の行番号だけで行を消す。**行に入っている取引 ID も、取引ログの転記先（AC・AD）も確かめない。転記先の行が並べ替えなどで動いていると、別の取引の行を消す。今の画面だけの版のまとめて対象外（`gas-push-144`）もこれを使っている。本仕様の対象外のまとめ確定はこれを避けるが、行ごとの［確定…］と取引先の表の「対象外」は 1 件ずつのまま。直すなら 51 に同じ確かめ（§2.2.1）を入れる別の仕様にする。
- 低：対象外にした取引に残った同じ取引の他の要確認は、`OPEN` のまま「取引の状態 CANCELED では不可。管理者へ」と出続ける（今の 1 件ずつと同じ）。

---

## 10. 実装と監査の記録

（実装の後に書く。）

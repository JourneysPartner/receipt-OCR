# 取引先の要確認をファイル単位でまとめて確定する土台 仕様書

作成日：2026-10-03
版：1.0
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いてあることは変えない。書いていないことは安全側で決め、決めたことは全部報告する。

改訂履歴：
- 1.0（2026-10-03）：初版。ko-ch さんの依頼（2026-10-03）：「要確認をファイル単位でまとめて確定する土台（時間の上限つき）。たまっているアマゾン 250 件の採用にも、画面の一括編集にも使います」。画面の一括編集（全件表示・複数選択・取引先の一括入力）は次の仕様で、本仕様の部品の上に作る。
  **実装（Codex）と監査（Claude）の記録：**Codex は 1324 → 1346/1346、M1〜M23 は全部赤（M15 は Codex が batch 12 を強めて赤にした）。実測：1 まとまりの読取 12 回（2 件でも 20 件でも）、自動採用の 1 ファイル 19 回（照合の読取・完了判定を含む）。**監査で見つけた不具合 1 つ：**同じ要確認が 2 回渡されると、2 回目の `DUPLICATE_DECISION` を要確認 ID で記録していたため 1 回目まで後の段から外れ、確定も報告もされずに消えた（恒等式が合わない）→ 失敗の印を件に付ける形に直し、batch 14 に 1 回目の確定と恒等式を足した。**監査で直した設計上の穴 2 つ：**(a) 自動採用で部品が一過性の例外を投げると実行ごと止まり、それまでの報告も消えた → ファイル単位で受け止めて次へ進む（batch 23）、(b) 最後の完了の掃除がファイルごとにリース表を読み直していた → 1 回に（batch 24）。**すり抜けた私の変異 3 つにテストを足した：**自動採用が部品の上限で残った件を捨てる（batch 25）、要確認を書く直前に別の経路が閉じた件を上書きする（batch 26）、F・I 列の文字列書式を付けない（batch 27）。55 に「なぜ」のコメントを足した。最終 1351/1351。

---

## 1. 何を直すか

### 1.1 いまは 1 件ずつ確定していて、1 件ごとに読取枠を 20 回前後使う

取引先の要確認（`PARTNER`）の確定は、どの経路も `resolveReview`（51）を **1 件ずつ**呼ぶ。1 件の中で同じ表を何度も読む：

| 部品 | 読取（`batchGet`） |
|---|---|
| `getReviewById`（要確認シート全体） | 1 |
| `reviewWriteCustomer_` → `getCustomerById` | 2 |
| `acquireLease` → `activeLeases_` | 1 |
| `getTransaction`（鍵列の走査＋行） | 2 |
| `writeTransactionRows` → `assertLeaseHeldForWrite` | 1 |
| `verifyWrittenValues` | 1 |
| `updateWrittenValues` → `getTransaction` | 2 |
| `updatePartnerResolution` → `getTransaction` | 2 |
| `learnFromResolution` → `readDictionary_`（学習するときだけ） | 1 |
| `settle_` → `updateReviewStatus` → 要確認シート全体 | 1 |
| `commitIfConditionsMet` → `getTransaction`＋`openReviews` | 3 |
| `updateTransactionStatus` → `getTransaction` | 2 |
| `releaseLease` → `activeLeases_` | 1 |
| **合計** | **約 20** |

**天井は Sheets API の読取枠（60 回/分/ユーザー、引き上げ不可）である。**1 件 20 回なら 1 分に 3 件しか確定できない。本番にたまっている 259 件（うち 250 件は辞書の名寄せで自動採用できるようになったアマゾン 2 店）を採用すると、**読取枠だけで 80 分以上**かかる。

### 1.2 自動採用（`opsAutoAdoptPartners`）は時間の上限を持たない

`opsAutoAdoptPartners`（97）は未解決の `PARTNER` を全部、1 件ずつ `resolveReview` に渡す。**締切を見ない**ので、件数が多いと 6 分の実行上限で途中で殺される。殺された実行は `WRITE_ONLY` リースを握ったまま残り、**次の実行は 10 分たつまで（強制解放の閾値）その ファイルの全件が `LEASE_CONFLICT` になる**（2026-09-16 の実機で、30 件の採用が 17 件と 13 件に分かれた）。250 件ではこの事故が何度も起きる。

### 1.3 本仕様がすること

1. **1 つのファイルの取引先の要確認を、まとめて確定する部品** `resolvePartnerReviewsBatch` を新しいファイル `src/55_PartnerBatchResolution.gs` に置く（§2.1〜§2.3）。読取は件数に依らない定数（1 回の呼出しで 15 回前後）、書込も件数に依らない回数にまとめる。**結果は 1 件ずつ `resolveReview` を呼んだときと同じ**にする（§2.4 に違いを全部挙げる）。
2. **時間の門**（次のまとまりを始めてよいか）を 1 つの関数にする（§2.6）。自動採用と、次の仕様の画面の一括確定が同じ門を使う。
3. `opsAutoAdoptPartners` を、ファイルごとにこの部品を呼ぶ形に作り替え、**時間の門で止まる**ようにする（§2.7）。止まったら残りの件数を返し、もう一度実行すれば続きから進む。
4. 監査ログの複数行をまとめて 1 回で書く（`appendAuditBatch` の中身を差し替える。§2.5）。
5. 辞書の学習をまとめて行う（§2.8）。

**変えないもの：**`resolveReview` とその下の 1 件ずつの経路（51 の各操作。ただし §2.3 の `reviewWriteCustomer_` に任意の引数を 1 つ足す）・`webAppResolveReviews`（画面の確定。次の仕様で本部品に載せ替える）・メニュー（96）・取込（70・71）。

---

## 2. 設計

### 2.1 部品の形

```
resolvePartnerReviewsBatch(customerId, fileId, decisions, options) → result
```

- `customerId`・`fileId`：空でない文字列。すべての `decision` はこの顧客・このファイルの要確認でなければならない。
- `decisions`：配列。各要素は
  ```
  {reviewId: string,
   operation: 'ADOPT_EXISTING_PARTNER' | 'RESOLVE_WITHOUT_PARTNER' | 'RESOLVE_PARTNER_UNKNOWN',
   partnerName: string,   // ADOPT のときだけ使う
   learn: boolean}        // ADOPT のときは必須（true/false を明示）。他の操作では見ない
  ```
- `options`：`{actor: string（必須）, customer: object（任意。getCustomerById(customerId) の戻り値。渡されたら読み直さない）}`

**呼出し側の誤り（プログラムの誤り）は、何も読まず何も書かずに `TypeError` を投げる：**`customerId`／`fileId` が空・`decisions` が配列でない・`operation` が上の 3 つ以外・ADOPT で `learn` が真偽値でない・`options.actor` が空・`options.customer` が渡されたのに `customerId` が違う。**データの状態による失敗は投げずに件ごとの `errors` に積む**（§2.2）。1 件の失敗で他の件を止めない。

戻り値：

```
{
  runId,                        // このまとまりの ID（generateId('RB')）。リースの runId にも使う
  fileId, customerId,
  resolvedReviewIds: [],        // 要確認を RESOLVED にできた件
  committedReviewIds: [],       // そのうち取引が COMMITTED へ進んだ件
  unmet: [{reviewId, unmetConditions: [], openReviewTypes: [], transactionStatus}],
                                // RESOLVED にしたが確定条件を満たさなかった件（webAppResolveReviews の unmet と同じ形）
  errors: [{reviewId, code, message}],   // 件ごとの失敗（§2.2 の表）
  skippedByLeaseReviewIds: [],  // ファイルのリースが取れず、手を付けなかった件
  notAttemptedReviewIds: [],    // 上限（PARTNER_BATCH_MAX_ITEMS_）を超えて手を付けなかった件
  leaseConflict: null | {message},
  learnedDictIds: [],           // この呼出しで新しく足した辞書行の ID
  ms, reads                     // 所要（partnerBatchClockNow_ の差）と読取回数（apiReadCount_ の差）
}
```

**勘定の恒等式：**`decisions.length ＝ resolvedReviewIds.length ＋ errors.length ＋ skippedByLeaseReviewIds.length ＋ notAttemptedReviewIds.length`。1 つの `decision` は必ずこの 4 つのどれか 1 つだけに入る。

`errors[].message` は日本語の短文にする（画面にそのまま出せるもの）。**明細の値（店名・金額・取引先名）を入れない。**

### 2.2 手順

順序を変えてはならない（§2.3 が「どこで殺されたら何が残るか」をこの順序で保証している）。

**手順 0：入力の検査**（読まない）。§2.1 の `TypeError`。

**手順 1：上限で切る。**`decisions` の先頭 `PARTNER_BATCH_MAX_ITEMS_`（＝100）件を対象とし、残りは `notAttemptedReviewIds` に入れる。対象の中で同じ `reviewId` が 2 回目以降に現れたら `DUPLICATE_DECISION`。

**手順 2：リースの前に読む。**
- `customer = options.customer || getCustomerById(customerId)`
- 要確認シートを 1 回読む（`allReviewRecords_()`）
- 件ごとに検査し、外れたら `errors` に積んで以後扱わない：

| 条件 | `code` |
|---|---|
| 要確認が無い | `REVIEW_NOT_FOUND` |
| `review.customerId` が `customerId` と違う | `REVIEW_CUSTOMER_MISMATCH` |
| `review.fileId` が `fileId` と違う | `REVIEW_FILE_MISMATCH` |
| `review.status` が `OPEN`／`IN_PROGRESS` でない | `ALREADY_SETTLED` |
| `review.reviewType` が `PARTNER` でない（`availableResolveOperations` に操作が無い） | `OPERATION_NOT_OFFERED` |
| ADOPT で `partnerName`（前後の空白を除く）が空、または `isPartnerUnknownLabel(partnerName)` | `INVALID_PARTNER_NAME` |
| ADOPT で `learn === true` かつ、`review.merchantNormalized` が空か `normalizeMerchant(review.merchantOriginal)` と違う | `LEARN_PRECONDITION` |

**`LEARN_PRECONDITION` を書く前に止めるのが、1 件ずつの経路との違いの 1 つである**（§2.4）。1 件ずつの経路は F 列と取引ログを書いた後で `learnFromResolution` が `MasterDataError` を投げ、半端な状態を残す（`spec_webapp.md` §7.4.2 判定 1）。

扱う件が 1 件も残らなければ、リースを取らずに返す。

**手順 3：ファイルのリースを 1 回取る。**`runId = generateId('RB')`、`leaseId = acquireLease(customerId, fileId, runId, options.actor, LEASE_PURPOSE.WRITE_ONLY)`。
- `LEASE_CONFLICT`（`error.code`）なら、残っている件を全部 `skippedByLeaseReviewIds` に入れ、`leaseConflict: {message}` を付けて返す。**何も書かない。**
- それ以外の例外はそのまま投げる（まだ何も書いていない）。
- **ここから先は `try { … } finally { releaseLease(fileId, runId, 'RESOLVE_DONE'); }` の中で行う。**

**`RESOLVE_WITHOUT_PARTNER` だけの件でもリースを取る。**1 件ずつの経路はこの操作でリースを取らない（`spec_webapp.md` §7.4 が「この事前確認だけが守り」と書いた穴）。まとめる以上、ファイル単位で取るほうが安全で、読取も 1 回で済む。

**手順 4：そのファイルの取引を 1 回読む**（`getTransactionsForFile_(fileId)`）。件ごとに：

| 条件 | `code` |
|---|---|
| `review.fullTxId` の有効な行が無い | `TX_NOT_FOUND` |
| 有効な行が 2 行以上 | `TRANSACTION_LOG_AMBIGUOUS` |
| ADOPT／UNKNOWN で取引の状態が `REVIEW_REQUIRED`／`COMMITTED` でない | `STATE_TRANSITION` |
| ADOPT／UNKNOWN で転記行（`destinationRow`）が正の整数でない | `DESTINATION_ROW_MISSING` |

- 書く値を作る（1 件ずつの経路と同じ式）：
  - ADOPT：`planned = Object.assign({}, tx.planned, {f: partnerName})`、書く列 `['f']`
  - UNKNOWN：`planned = Object.assign({}, tx.planned, {i: appendMemoTag(tx.planned && tx.planned.i, MEMO_TAG_PARTNER_UNKNOWN_)})`、書く列 `['i']`
  - WITHOUT：書かない
- 転記先は**要確認行の M・N 列**（`reviewWriteCustomer_(review, customer)`。§2.3）。M が空なら雛形。
- 書く件のうち、同じ転記先（スプレッドシート ID＋シート名）の同じ行を指す件が 2 つ以上あれば、**その全部**を `DESTINATION_ROW_CONFLICT` にする。

**手順 5：転記先へ書いて読み返す。**転記先ごと（初めて現れた順）に：
1. `applyPlainTextFormat(groupCustomer, 行番号の配列)`（1 回）
2. `writeTransactionRows(groupCustomer, rowWrites, leaseId, fileId)`（1 回。中でリースを確かめる）
3. `verifyWrittenValues(groupCustomer, rowWrites)`（1 回）。食い違った件は `DESTINATION_VALUE_MISMATCH`（以後扱わない。書いた値は残る ── 1 件ずつの経路と同じ）

その転記先で例外が出たら、**その転記先の件を全部** `errors` に積む（`code` は `error.code`、無ければ `WRITE_FAILED`）。**ただし例外の `code` が `LEASE_CONFLICT` なら**（自分のリースが強制解放された）、**まだ確定していない全件**を `LEASE_CONFLICT` として `errors` に積み、以後の手順を行わずに `finally` へ進む。それ以外の例外なら他の転記先は続ける。

**手順 6：取引ログを 1 回でまとめて書く**（`withScriptLock_` の中）。
1. 対象の行を**位置で読み直す**：`readRowsByNumbers_(transactionLogSheet_(), 行番号, 1, 取引ID, TRANSACTION_LOG_WIDTH_)`。`null`（鍵が外れた）なら `activeTransactionRecordsByIds_(取引ID)` で引き直す。行が無い・有効でない件は `CONCURRENT_CHANGE`（書かない）。
2. 書く範囲（1 件ずつの経路が書く列と同じ。他の列に触れない）：
   - ADOPT／UNKNOWN：S〜AB（19〜28 列）＝ 予定値 b,f,i,k,m ＋ 読取確認値 b,f,i,k,m（`plannedVerifiedArray_`。読取確認値は手順 5 の `verifyWrittenValues` が返した `values`）、AT〜AU（46〜47 列）＝ 相手税区分の予定値・読取確認値（`taxCategoryCell_`）、L（12 列）＝ ADOPT は `RESOLVED_WITH_PARTNER`・UNKNOWN は `RESOLVED_WITHOUT_PARTNER`、AS（45 列）＝ 更新日時
   - WITHOUT：L（12 列）＝ `RESOLVED_WITHOUT_PARTNER`、AS（45 列）＝ 更新日時
3. `Sheets.Spreadsheets.Values.batchUpdate` を 1 回（範囲が `SETTLE_BATCH_RANGES_` を超えたら分ける）。

**手順 7：辞書に学ぶ**（ADOPT で `learn === true`、手順 6 まで来た件だけ）。`learnFromResolutionBatch`（§2.8）を 1 回呼ぶ。例外が出たら、学習する件を全部 `LEARN_FAILED` として `errors` に積み、**その件の要確認は閉じない**（手順 8 で扱わない）。学習しない件は続ける。

**手順 8：要確認・監査・確定を 1 つのロックの中で書く**（`withScriptLock_`）。
1. 要確認シートを読み直す（1 回）。手順 7 まで来た件の要確認が同じ ID で `OPEN`／`IN_PROGRESS` のままなら書く。そうでなければ `ALREADY_SETTLED`（要確認は書かない。取引ログは手順 6 で書いたまま ── 1 件ずつの経路でも、同じ取引を別の経路が先に閉じていれば同じことが起きる）。
2. 要確認の書込（`settle_` が `updateReviewStatus` に頼む列と同じ）：B（2 列）＝ `RESOLVED`、AB（28 列）＝ `options.actor`、AC（29 列）＝ 日時、AD（30 列）＝ `operation`、AF（32 列）＝ 空、**ADOPT だけ** R（18 列）＝ `partnerName`。**AE（役割）と Z（検出詳細）には触れない**（`settle_` は渡していない）。1 回の `batchUpdate`。
3. 監査ログ：書いた件ごとに `{type: 'REVIEW_RESOLVE', actor, targetType: 'TRANSACTION', targetId: fullTxId, after: {operation}}`（`settle_` と同じ）。`appendAuditRowsUnlocked_`（§2.5）で 1 回に書く。
4. 確定の判定：取引の行を位置で読み直し（1 回。外れたら引き直す）、件ごとに **`commitBlockingReasons_`（50）で**判定する。材料は 1 件ずつの経路（`isTransactionCommittable`）と同じ：
   - `hasOpenReview`：手順 8-1 で読んだ要確認のうち、その取引の `OPEN`／`IN_PROGRESS`（**種別を問わない**）が、いま閉じた件を除いて残っているか
   - `plannedB`：読み直した取引の予定値 B
   - `partnerResolutionStatus`：読み直した取引の L 列

   理由が無く、状態が `REVIEW_REQUIRED` なら確定する（J（10 列）＝ `COMMITTED`、AS（45 列）＝ 日時。`ALLOWED_TX_TRANSITIONS` で許される遷移であることを確かめる）。理由があれば `unmet` に `{reviewId, unmetConditions, openReviewTypes, transactionStatus}`。状態が `REVIEW_REQUIRED` 以外なら `unmetConditions: ['NOT_REVIEW_REQUIRED']`（`commitIfConditionsMet` と同じ）。確定は 1 回の `batchUpdate`。

**条件を自前で書いてはならない。**確定の 3 条件を評価する箇所が 2 つになると、片方だけ直す事故が必ず起きる（50 の `commitBlockingReasons_` の説明）。

**手順 9：`finally` でリースを返す**（`releaseLease(fileId, runId, 'RESOLVE_DONE')`）。

**ログ：**呼出しごとに 1 行 `Logger.log('PARTNER_BATCH ' + JSON.stringify({runId, fileId, items, resolved, committed, errors, skippedByLease, notAttempted, destinations, ms, reads}))`。数だけを出し、**明細の値・店名・取引先名を出さない**。

**読取は件数に依らない。**手順 2（顧客 0〜2・要確認 1）、3（1）、4（2）、5（転記先ごとに 2）、6（1）、7（学習があれば 1〜2）、8（2）、9（1）で、転記先 1 つ・学習ありなら 13〜15 回である。**Sheets API の読取は既存の口（`readSheetRows_`・`readRowsByNumbers_`・`findRowsByColumnValue(s)_`・`readDestinationRows_`・`apiLastDataRow(s)_`）だけを通す。**`Sheets.Spreadsheets.Values.batchGet` を直に呼ぶと読取枠の見張り（`pace 1`）を外れる。

### 2.3 殺されたら何が残るか（手順の順序の理由）

| 殺された場所 | 残るもの | 次に何が起きるか |
|---|---|---|
| 手順 5 の書込の後 | F／I 列だけ新しい。取引ログ・要確認は前のまま | 同じ確定をもう一度すれば同じ値を書き直して進む |
| 手順 6 の後 | 取引ログは取引先解決済み、要確認は `OPEN` | 同上（同じ値を書き直す。辞書は同等行を見て足さない） |
| 手順 7 の後 | 辞書に行がある、要確認は `OPEN` | 同上 |
| 手順 8 の要確認の書込の後、確定の前 | 要確認は `RESOLVED`、取引は `REVIEW_REQUIRED` | `commitSettledTransactions_`・`opsCommitSettledTransactions` が拾う（既存の安全網） |
| どこでも | **リースが残る** | 10 分たつまでそのファイルは確定できない ── **だから呼出し側は §2.6 の門で、殺される前に止まる** |

**順序を入れ替えてはならない。**特に、確定（J 列）を要確認の書込より先にすると、「`COMMITTED` なのに要確認が `OPEN`」が残る。

`reviewWriteCustomer_(review, customer)`（51）：第 2 引数を任意で足す。渡されたらそれを使い、渡されなければ今までどおり `getCustomerById(review.customerId)` を呼ぶ。**本体の規則（M が空なら雛形、N が空なら顧客の転記先シート名）は 1 か所のまま**にする（55 に写さない）。

### 2.4 1 件ずつの経路との違い（これ以外は同じでなければならない）

**同じでなければならないもの：**確定できた件について、転記先の F・I 列、取引ログの J・L・S〜AB・AT・AU 列、要確認行の B・R・AB・AD・AF 列、辞書の行（ID と日時を除く）、監査ログの `REVIEW_RESOLVE`・`DICT_REGISTER` の行（ID と日時と並び順を除く）。

**違ってよいもの（全部）：**
1. **リースはまとまりに 1 回**（1 件ずつの経路は ADOPT／UNKNOWN の件ごと、WITHOUT は取らない）。だから `LEASE_RELEASE` の監査行は 1 まとまりに 1 行。
2. **書く前に止める件がある：**ADOPT の `STATE_TRANSITION`（1 件ずつの経路の自動採用は取引の状態を見ずに、取り消された取引の空いた行へ F 列を書く ── 幽霊行。画面は事前に見ていた）と `LEARN_PRECONDITION`。
3. 監査行の並び：`DICT_REGISTER` がまとまりの頭、`REVIEW_RESOLVE` がその後にまとまって並ぶ。
4. 日時：同じまとまりの件は同じ日時になってよい。

### 2.5 監査ログのまとめ書き（`src/62_AuditLog.gs`）

- 新しい `appendAuditRowsUnlocked_(entries)`：ロックを取らない（呼出し側が持つ）。`appendAuditUnlocked_` と同じ規則で、
  1. シートが空（`getLastRow() < 2`）なら最初に連鎖起点（GENESIS）を 1 行足す（`appendAuditUnlocked_` と同じ行）
  2. 最終行の O 列（ハッシュ）を 1 回読む
  3. 各行を `makeAuditRow_(entry, 直前の行のハッシュ, false)` で**順に**作る（1 行目の直前は最終行のハッシュ、2 行目以降は直前に作った行のハッシュ）
  4. `ensureRowExists_` で行を確保し、`getRange(最終行＋1, 1, 件数, AUDIT_WIDTH_).setValues(rows)` で **1 回で**書く
  5. 監査 ID の配列を返す
  
  `entries` が空なら何もせず `[]` を返す（読まない）。
- `appendAuditBatch(entries)` は `withScriptLock_(function() { return appendAuditRowsUnlocked_(entries); })` にする。**呼出し元は `src/` に無い**（テストだけ）。既存のテスト（`audit batch appends multiple rows under one lock …`）の期待は変えない。
- `verifyChain('FULL')` が通り、1 行ずつ `appendAudit` を呼んだときと同じハッシュの連なりになること（同じ ID・日時を与えれば行がバイト単位で同じ）。

### 2.6 時間の門（`src/55_PartnerBatchResolution.gs`）

```
partnerBatchClockNow_()                     // Date.now()。テストが差し替える
partnerBatchMayStart_(gate) → boolean
  gate = {startedAt, deadlineMs, floorMs, factor, maxBatchMs}
  predicted = max(floorMs, maxBatchMs || 0)
  return (partnerBatchClockNow_() − startedAt) + factor × predicted <= deadlineMs
```

- **最初のまとまりにも同じ式を掛ける**（`maxBatchMs` は 0 なので `floorMs` で見積もる）。
- `maxBatchMs` は**その呼出しで既に処理したまとまりの所要の最大値**（直前の 1 つではない ── 重いファイルの後に軽いファイルが来ても見積もりを軽くしない。取込の門 `fileStartGate` と同じ考え）。
- 境界（ちょうど等しい）は始める。
- 定数：`PARTNER_BATCH_MAX_ITEMS_ = 100`、`PARTNER_BATCH_FLOOR_MS_ = 60000`、`PARTNER_BATCH_FACTOR_ = 2`。

### 2.7 自動採用の作り替え（`src/97_Ops.gs` の `opsAutoAdoptPartners`）

`opsAutoAdoptPartners(options)`。引数は任意（プルダウンからは無し）。`options.deadlineMs`（既定 `OPS_AUTO_ADOPT_DEADLINE_MS_ = 300000`）。開始時刻は `partnerBatchClockNow_()`。

1. `loadSettingsFromProperties()`。辞書 2 枚・共通取引先を 1 回読む（今までどおり）。
2. **取りこぼしの確定を先に拾う**：`opsCommitSettledTransactions()`（今までは最後に呼んでいた。前の実行が `settle_` の途中で殺した取引を先に拾うという趣旨は同じ）。戻りの `committed` を `settledLate` に入れる。
3. 未解決の `PARTNER` で `status === 'OPEN'` の要確認を 1 回読み、**（顧客, ファイル）ごとに**分ける。並びは要確認シートで最初に現れた順。
4. ファイルごとに（**始める前に §2.6 の門**。`floorMs`・`factor` は `PARTNER_BATCH_*`、`maxBatchMs` はこの実行で処理したファイルの所要の最大値）：
   1. 門が閉じたら、そのファイル以降の要確認を全部 `results` に `{reviewId, deferred: 'TIME'}` として積み、ループを抜ける（`stoppedBy: 'TIME'`）。
   2. そのファイルの取引を 1 回読み（`getTransactionsForFile_`）、要確認ごとに今までと同じ照合をする（`review.merchantOriginal` を鍵にした `matchPartner`。会員値引・カード名の用途の鍵の扱いは今のコードのまま）。取引が無ければ `{reviewId, skipped: 'TX_NOT_FOUND'}`、一意に決まらなければ `{reviewId, merchant, skipped: 'NO_UNIQUE_MATCH', candidates}`（今までと同じ）。
   3. 一意に決まった件を `{operation: 'ADOPT_EXISTING_PARTNER', partnerName, learn: false}` にして `resolvePartnerReviewsBatch(customerId, fileId, decisions, {actor: activeUserEmail_(), customer})` に渡す（顧客は顧客ごとに 1 回だけ `getCustomerById` する）。
   4. 戻りを `results` に写す：確定した件 `{reviewId, merchant, partner, committed}`、`errors` の件 `{reviewId, error: code}`、リースで飛ばした件 `{reviewId, error: 'LEASE_CONFLICT'}`、上限で手を付けなかった件は**同じファイルの次のまとまり**に回す（門を通してから）。
   5. まとまりの後、そのファイルに `completeFileIfFullyResolved_(fileId, {readLeases: activeLeases_})` を掛け、完了したら `completedFiles` に入れる。
   6. このファイル（照合の読取から完了判定まで）の所要を `maxBatchMs` に反映する。
5. **全部の `REVIEW_WAIT` ファイルの完了判定**（今までの最後の段。人が別の経路で最後の 1 件を確定した後の完了を拾う）は、`(経過) + PARTNER_BATCH_FLOOR_MS_ <= deadlineMs` のときだけ行う。行わなかったら `completionSweep: 'SKIPPED_TIME'`、行ったら `'DONE'`。既に `completedFiles` にあるファイルを二重に入れない。
6. 戻り値（今までの鍵は名前も意味も変えない）：
   ```
   {adopted, skipped, errors, settledLate, completedFiles, results,
    remaining,          // deferred: 'TIME' の件数
    stoppedBy,          // 'TIME' | null
    completionSweep,    // 'DONE' | 'SKIPPED_TIME'
    files: [{fileId, adopted, errors, ms, reads}],
    elapsedMs, reads}
   ```
   `Logger.log(JSON.stringify(summary, null, 2))` は今までどおり。

**`remaining > 0` なら利用者はもう一度実行する。**門のおかげでリースは残らないので、すぐ続きから進む。

### 2.8 辞書のまとめ学習（`src/34_MerchantDictionary.gs`）

- `learnFromResolutionBatch(customerId, entries, actor)`：`entries = [{original, normalized, partnerName}]`。戻りは `entries` と同じ並びの `dictId` の配列。
  1. 件ごとに `normalizeMerchant(original) === String(normalized)` を確かめる（外れたら `MasterDataError`。本部品は手順 2 で弾いているので、ここに来るのはプログラムの誤り）。
  2. `withScriptLock_` の中で顧客辞書を 1 回読み（`readDictionary_(false)`）、**`learnFromResolution` と同じ同等行の条件**で既存の行を探す。同じ `entries` の中で同じ（original, normalized, partnerName）が 2 回現れたら 1 行だけ足し、両方に同じ `dictId` を返す。
  3. 足す行は `learnFromResolution` と同じ並び（`[dictId, original, normalized, partnerName, 'exact_normalized', '', customerId, '', '', false, actor, '', now, 1, true, false, '', '']`）。`dictionaryWriteSheet_(false)` で取ったシートへ `appendRowsBatched_` で 1 回で書く。
  4. 足した行ごとに `DICT_REGISTER` の監査行（`learnFromResolution` と同じ中身）を `appendAuditRowsUnlocked_` で 1 回で書く（同じロックの中）。
- **同等行の条件と行の並びは、`learnFromResolution` と共有する 1 つの補助関数に出す**（`learnFromResolution` もそれを使う）。2 か所に書くと片方だけ直る。`learnFromResolution` の振る舞いは変えない。

---

## 3. 変えてよいファイル

- 新規 `src/55_PartnerBatchResolution.gs`（本部品・門・定数・`partnerBatchClockNow_`）
- `src/34_MerchantDictionary.gs`（§2.8。`learnFromResolution` は補助関数を使う形にするだけ）
- `src/51_ReviewResolution.gs`（`reviewWriteCustomer_` に任意の第 2 引数。他は触らない）
- `src/62_AuditLog.gs`（§2.5）
- `src/97_Ops.gs`（`opsAutoAdoptPartners` だけ。**文字列の中に生の NUL バイトが 2 つある** ── バイトを保って編集すること）

---

## 4. テスト（`test/phase8-webapp.test.js` に `batch N: …` を足す。補助は同じファイルのものを使ってよい）

1. **同値（ADOPT 3 件）：**同じ材料の世界を 2 つ作り、一方は `resolveReview` を 1 件ずつ、他方は本部品で 1 回。転記先の F 列、取引ログの J・L・S〜AB・AT・AU、要確認行の B・R・AB・AD・AF、辞書の行（ID・日時を除く）、監査の `REVIEW_RESOLVE`・`DICT_REGISTER` の数と対象が一致する。
2. **同値（混在）：**ADOPT・WITHOUT・UNKNOWN を 1 件ずつ同じまとまりに入れ、1 と同じ比較が一致する（UNKNOWN は I 列の末尾に「取引先不明」、L は `RESOLVED_WITHOUT_PARTNER`）。
3. **読取が件数に依らない：**2 件のまとまりと 20 件のまとまり（どちらも同じ 1 ファイル・同じ転記先・学習なし）の `batchGet` の回数が等しく、上限（実測値。報告する）以下。
4. **リース衝突：**他者がそのファイルのリースを持つと、全件 `skippedByLeaseReviewIds`、`leaseConflict` あり、転記先・取引ログ・要確認・辞書・監査（`REVIEW_RESOLVE`）は変わらず、リースの行は他者の 1 行のまま。
5. **リースを必ず返す：**手順 6 の途中で例外を起こしても（`withMocks` で差し替え）、例外が呼出し側へ出て、リースの行が残らない。
6. **1 件の失敗で他を止めない：**存在しない ID・他の顧客の要確認・他のファイルの要確認・確定済みの要確認・`DATE` 種別の要確認・ADOPT の取引先名が空・ADOPT の取引先名が「取引先不明」を混ぜても、普通の件は確定し、それぞれ §2.2 の `code` になり、恒等式が成り立つ。
7. **取り消された取引への ADOPT：**`EXCLUDE` で取り消した取引の要確認（別に残した `PARTNER`）を ADOPT すると `STATE_TRANSITION`、転記先の行は空のまま。
8. **読み返しの食い違い：**1 件だけ読み返し値を変える（`readDestinationRows_` を差し替え）と、その件は `DESTINATION_VALUE_MISMATCH` で取引ログ・要確認が変わらず、他の件は確定する。
9. **学習：**同じ店名・同じ取引先の 2 件を `learn: true` → 辞書は 1 行だけ増え、`learnedDictIds` は 1 つ。既に同等行があれば増えない。`learn: false` は増えない。
10. **学習の前提：**`merchantNormalized` が空の要確認を `learn: true` で ADOPT → `LEARN_PRECONDITION`、F 列は書かれない（1 件ずつの経路との違い）。
11. **確定の判定：**同じ取引に `DATE` の要確認が開いていれば確定せず `unmet` に `openReviewTypes: ['DATE']`。予定値 B が空なら `PLANNED_B_EMPTY`。
12. **監査のまとめ書き：**`appendAuditBatch` の 3 行が 1 回の `setValues` で書かれ（`rangeWrites` の差）、`verifyChain('FULL')` が通る。空のシートでも GENESIS から始まる。同じ ID・日時を与えると、1 行ずつ `appendAudit` した行と同じハッシュになる。
13. **上限：**`PARTNER_BATCH_MAX_ITEMS_` を 2 に差し替えて 3 件渡すと、2 件を処理し 1 件が `notAttemptedReviewIds`。
14. **重複と行の衝突：**同じ `reviewId` の 2 回目は `DUPLICATE_DECISION`。2 つの要確認が同じ転記行を指すように取引ログを書き換えると、両方 `DESTINATION_ROW_CONFLICT` で書かれない。
15. **転記先が 2 つ：**同じファイルの要確認の片方の M 列を空にする（旧い要確認 ＝ 雛形）と、それぞれの転記先に書かれる（雛形と複製の同じ行番号を取り違えない）。
16. **`IN_PROGRESS` の要確認**（`REQUEST_NEW_PARTNER` の承認待ち）も ADOPT で `RESOLVED` になる（1 件ずつの経路と同じ）。
17. **殺されても戻せる：**手順 6 の後で例外を起こし（取引ログは書かれた、要確認は `OPEN`）、もう一度同じまとまりを呼ぶと全件確定し、辞書の行も監査の `DICT_REGISTER` も二重にならない。
18. **門：**`partnerBatchMayStart_` の境界（ちょうど等しいと始める・1 ms 超えると始めない）と、`maxBatchMs` が床より大きいときはそちらで見積もること。
19. **自動採用（2 ファイル）：**2 ファイルに一意に決まる店の要確認を置くと、1 回の実行で全件採用され、`files` が 2 件、両ファイルが完了し、各ファイルの読取が件数に依らない（1 ファイル 2 件と 10 件で等しい）。
20. **自動採用の門：**時計を差し替えて 1 ファイル目の所要を 200 秒にすると、2 ファイル目は始まらず `remaining` がその件数、`stoppedBy: 'TIME'`、リースの行は残らない。もう一度実行すると残りが採用される。
21. **自動採用の完了の掃除：**門で止まった実行（経過が締切 − 60 秒を超えた）では `completionSweep: 'SKIPPED_TIME'`。
22. **ログ：**`PARTNER_BATCH` の行に店名・取引先名・金額が含まれない（材料の店名・取引先名の文字列がログに出ないこと）。

既存のテストは 1 つも期待を変えずに緑のままであること。特に `opsAutoAdoptPartners` を使う `phase6-freee-template` の 3 本（`kf7 9` を含む）と `webapp 45h`・`45m`・`45o`、`audit batch …`、`dict 1`・`pace 1`・`budget 1`・`flush 1`。

---

## 5. 変異（入れて回し、赤になるテストを記録して戻す）

- M1 リースを取らずに書く（手順 3 を飛ばし、`writeTransactionRows` には偽の leaseId）
- M2 `finally` でなく成功時だけリースを返す
- M3 読み返し（手順 5-3）の結果を見ずに全件を進める
- M4 手順 6 で読取確認値の代わりに予定値を書く
- M5 手順 8 の `hasOpenReview` を `PARTNER` の要確認だけで数える
- M6 確定を要確認の書込より先に行う（順序の入れ替え）
- M7 `learn: false` の件も学習する
- M8 学習の同等行の検査を外す（毎回足す）
- M9 `LEARN_PRECONDITION` を見ずに書く
- M10 ADOPT で取引の状態を見ない
- M11 `REVIEW_CUSTOMER_MISMATCH` の検査を外す
- M12 `REVIEW_FILE_MISMATCH` の検査を外す
- M13 `IN_PROGRESS` を確定済みとして扱う
- M14 監査のまとめ書きで、2 行目以降の直前ハッシュに最終行のハッシュを使い続ける
- M15 監査のまとめ書きで GENESIS を足さない
- M16 門の `maxBatchMs` に直前のまとまりの所要を使う
- M17 門の境界を `<` にする
- M18 上限で切った残りを `notAttempted` に入れずに捨てる
- M19 自動採用で門を見ない
- M20 自動採用で完了判定を触ったファイルに掛けない
- M21 転記先を要確認の M 列でなく雛形に固定する
- M22 `DESTINATION_ROW_CONFLICT` の検査を外す
- M23 `PARTNER_BATCH` のログに `merchantOriginal` を足す

---

## 6. 受入（実機。push の後、ko-ch さんの許可を得て）

1. 読むだけ：`opsCountReviewsByType` などで、未解決 `PARTNER` の件数（約 259）と、ファイルのリースが無いこと（`opsShowLeases`）を確かめる。
2. ko-ch さんが Git Bash で `clasp -u runner run-function opsAutoAdoptPartners` を実行（本番を書く関数は Claude の実行が自動判定で拒まれるため）。
3. 期待：`errors: 0`、アマゾン 2 店の約 250 件が `adopted`（1 回で終わらなければ `remaining > 0` と `stoppedBy: 'TIME'` が返り、すぐもう一度実行して続きが進む）、実行のあとにリースが残らない、`clasp logs` の `PARTNER_BATCH` の `reads` が 1 ファイル 15 前後、`ms` が 1 ファイル数十秒以内。
4. 採用後、セゾンのファイルのうち要確認が残っていない月は【済】になる。残る要確認は本当に辞書に無い 9 件前後。

---

## 7. Claude の判断の記録（ko-ch さんの決定ではないもの）

- **`RESOLVE_WITHOUT_PARTNER` にもリースを取る**（§2.2 手順 3）。1 件ずつの経路より厳しくなるが、守りが増えるだけで、読取も増えない。
- **ADOPT の `STATE_TRANSITION`・`LEARN_PRECONDITION` を書く前に止める**（§2.4 の 2）。自動採用は今まで取り消された取引にも F 列を書き得た。
- **上限 100 件・床 60 秒・係数 2・自動採用の締切 300 秒**は、取込の門（`spec_import_multi_file.md`）と同じ考え方で置いた。1 まとまりの所要は読取 15 回前後と書込数回で、実機で 10〜30 秒の見込み。床 60 秒×2 で、最悪でも締切の 2 分前までにしか新しいまとまりを始めない。
- 取りこぼしの確定（`opsCommitSettledTransactions`）を最後から最初へ移した。時間の門で最後の段が飛ばされても、取りこぼしは必ず拾われる。

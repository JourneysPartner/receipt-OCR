# 「その他の要確認」をサーバー側でまとめて計上する（第 1 段） 仕様書

作成日：2026-11-10
版：1.1（1.0 からの変更：§2.2 手順 10 のリース衝突のときも部品の `errors` を写すことを書いた・pb 9 に足した・変異 P14。§10 に実装と監査の記録）
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いてあることは変えない。書いていないことは安全側で決め、決めたことは全部報告する。
前提：`work/spec_other_reviews_server_batch.md`（全体の案。2 段に分ける決定）、`work/spec_other_reviews_bulk.md`（画面だけの版。本番 `gas-push-144`）、`work/spec_partner_batch_resolution.md`（まとめ確定の部品 55。手順の番号はこの §2.2 のもの）。

改訂履歴：
- 1.0（2026-11-10）：初版。利用者の依頼（2026-11-10）：「サーバー側でまとめる作りの第 1 段（計上する）の仕様書を書いて」。第 2 段（対象外にする）は別の仕様書にする。
- 1.1（2026-11-11）：監査で見つけた穴。リース衝突のとき、部品がリースの前に弾いた件（手順 2）の `errors` が戻り値から消え、恒等式が崩れた（1.0 の手順 10 の書き方があいまいだった）。

---

## 1. 何を直すか

### 1.1 いまの「まとめて確定」は、中で 1 件ずつ確定している

画面だけの版（`spec_other_reviews_bulk.md`）は、選んだ行ごとに公開関数 `webAppResolveOtherReview` を 1 回ずつ呼ぶ。1 件の確定は、要確認シート・取引ログ・リース表・処理ログを件ごとに読み直すので、**1 件で読取を 20 回前後使う**。読取の上限は 1 分 60 回（引き上げ不可）なので、**1 分に 2〜3 件しか進まない**。前年利用日の 41 件は 15〜20 分かかる見込み。

取引先の要確認は同じ理由で `55_PartnerBatchResolution.gs` の `resolvePartnerReviewsBatch` を作り、1 ファイル分を読取 10〜15 回で確定している（件数に依らない）。これを使う。

### 1.2 本仕様がすること（第 1 段）

1. 部品 `resolvePartnerReviewsBatch`（55）が、取引先の操作に加えて**計上の操作 2 つ**（`POST_PRIOR_YEAR`・`POST_ZERO_AMOUNT`）を受け付けるようにする（§2.1）。転記先にも取引ログの取引先の列にも書かない。要確認を閉じ、監査を書き、確定の 3 条件を評価するだけ（1 件ずつの経路の `settle_` と同じ結論）。
2. 新しい公開関数 `webAppResolveOtherReviewsBatch(customerId, reviewIds, code)`（80）。認可と「この操作が押せるか」を件ごとに 1 件ずつの経路と同じ判定で確かめ、ファイルごとに部品へ渡し、時間の門で止まる（§2.2）。
3. 画面（81）：まとめて確定で選んだ操作が計上の 2 つのときだけ、新しい関数を呼ぶ（§2.3）。**対象外の 2 つ（`EXCLUDE_PRIOR_YEAR`・`EXCLUDE`）は今のまま 1 件ずつ**（第 2 段で差し替える）。

**41 件（2 ファイル）で 1 分前後**の見込み（読取は呼出しの頭で 6 回前後＋1 ファイル 12 回前後）。

### 1.3 変えないもの

- 1 件ずつの経路：`resolveReview`（51）、`applyResolveDecision_`（96）、`webAppResolveOtherReview`（80）、行ごとの「操作を選ぶ」と［確定…］（81）。
- 取引先の経路：`webAppResolveReviews`（80）と、部品 55 の取引先の操作の振る舞い（既存のテストが期待を変えずに通ること）。
- まとめて確定の対象外の 2 つ（81 の今の 1 件ずつの繰り返し）。
- 50・51・61・96・97。**97 は触らない**（文字列の中に生の NUL バイトがある）。

---

## 2. 設計

### 2.1 部品 55 に計上の操作を足す（`src/55_PartnerBatchResolution.gs`）

以下、手順の番号は `spec_partner_batch_resolution.md` §2.2 のもの。書いていない手順は今のまま。

**操作の定数：**`PARTNER_BATCH_POST_OPERATIONS_ = ['POST_PRIOR_YEAR', 'POST_ZERO_AMOUNT']` を足す。受け付ける操作は、今の 3 つ（`ADOPT_EXISTING_PARTNER`・`RESOLVE_WITHOUT_PARTNER`・`RESOLVE_PARTNER_UNKNOWN`）とこの 2 つ。

**手順 0（入力の検査。読まない・書かない）に足す `TypeError`：**
- 1 回の `decisions` に、取引先の操作と計上の操作が**両方**入っている（`'partner and posting operations must not be mixed'`）。呼出し側の誤り。混ぜないことで、計上の呼出しでは手順 5〜7 に何も入らない。
- 計上の操作では `partnerName`・`learn`・`scope` を見ない（渡されても無視する）。

**手順 2（リースの前）に足す検査：**
- 今の検査（`REVIEW_NOT_FOUND`・`REVIEW_CUSTOMER_MISMATCH`・`REVIEW_FILE_MISMATCH`・`ALREADY_SETTLED`・`OPERATION_NOT_OFFERED`）はそのまま効く。`availableResolveOperations` の表により、`POST_PRIOR_YEAR` は `PRIOR_YEAR` の要確認だけ、`POST_ZERO_AMOUNT` は `ZERO_AMOUNT` の要確認だけに通る。
- 計上の件で、**同じ呼出しの先の件と同じ `review.fullTxId` を指す件**は `DUPLICATE_TRANSACTION`（文：`同じ取引の要確認が複数指定されています。1 件ずつ確定してください。`）。先の件は続ける。
  - 理由：同じ取引の 2 件を同時に閉じると、確定（J 列）を 2 回書き、`committedReviewIds` が取引の数より多くなる。抑止キーにより同じ種別の未解決は 1 取引に 1 件なので、1 つの操作だけを送る画面からはこの形は来ない。来たらデータか呼出し側の誤りなので、書く前に止める。
- 取引先の名簿・辞書（`readPartnerResolutionMasters_`）は、計上だけの呼出しでは読まない（今の条件 `hasAdoption` が偽なので、何も足さなくてそうなる。テストで確かめる）。

**手順 3（リース）：**今のまま（`WRITE_ONLY` のリースをファイルに 1 回取る）。1 件ずつの経路は計上でリースを取らず、リース表を見て他者のリースがあれば止まるだけ。まとめる以上、取るほうが安全（`RESOLVE_WITHOUT_PARTNER` と同じ判断）。

**手順 4（ファイルの取引を 1 回読む）：**計上の件は
| 条件 | `code` |
|---|---|
| `review.fullTxId` の有効な行が無い | `TX_NOT_FOUND` |
| 有効な行が 2 行以上 | `TRANSACTION_LOG_AMBIGUOUS` |
| 取引の状態が `REVIEW_REQUIRED`／`COMMITTED` でない | `STATE_TRANSITION` |

- 状態の検査は 1 件ずつの経路では画面の判定（`resolveOptionsFor_` の「取引の状態 … では不可」）だけが守りで、リースの外で読んだ値で決まる。部品では**リースを持ってから読んだ値**でもう一度確かめる。取り消した取引（`CANCELED`）に残った前年利用日の要確認を「計上」で閉じると、帳簿に居ない取引を計上したと記録が残る。
- 転記行（`destinationRow`）は見ない（書かないので。`RESOLVE_WITHOUT_PARTNER` と同じ）。書く列は無い（`rowWrite` は作らない）。

**手順 5〜7：計上の呼出しでは何もしない。**特に**手順 6（取引ログ）を丸ごと飛ばす**（ロックも読取も書込もしない）。
- **計上の件では、取引ログの L 列（取引先の解決状態）に絶対に書かない。**今の手順 6 は、`ADOPT` 以外の件に `RESOLVED_WITHOUT_PARTNER` を書く形になっている。計上の件をそこへ通すと、取引先が未解決の取引の L が「解決済み」になり、確定の 3 条件の「取引先が未解決」を素通りして**取引先の無いまま確定する**。本仕様で一番大事な条件である（§3 の I2）。
- 手順 6 の後の `ready`（次の手順へ進む件）は、計上の呼出しでは手順 4 を通った件すべて（手順 6 で落とさない）。

**手順 8（要確認・監査・確定）：**今のまま。計上の件の書込は 1 件ずつの経路の `settle_`（→ `updateReviewStatus(reviewId, 'RESOLVED', {actor, operation})`）と同じ列：B（2）＝`RESOLVED`、AB（28）＝`actor`、AC（29）＝日時、AD（30）＝`operation`、AF（32）＝空。**R（18）・AE（31）・Z（26）・V（22）・W（23）には触れない。**監査は `{type: 'REVIEW_RESOLVE', actor, targetType: 'TRANSACTION', targetId: fullTxId, after: {operation}}`。確定の判定は今のまま `commitBlockingReasons_`（50）だけで行う（自前の条件を書かない）。

**手順 9：**今のまま（`finally` でリースを返す）。

**ログ：**`PARTNER_BATCH` の行に `operations`（その呼出しの操作コードを重ねずに並べた配列。例 `["POST_PRIOR_YEAR"]`）を足す。他の鍵は変えない。明細の値（店名・金額・取引先名）を出さない。

**先頭の説明：**55 の冒頭のコメントに、計上の操作も受け付けること・混ぜないこと・L 列に書かないことを足す（「なぜ」を書く）。

### 2.2 公開関数 `webAppResolveOtherReviewsBatch(customerId, reviewIds, code)`（`src/80_WebApp.gs`）

`webAppInvoke_` で包む（例外は既存と同じ日本語へ）。定数 `WEBAPP_OTHER_BATCH_CODES_ = ['POST_PRIOR_YEAR', 'POST_ZERO_AMOUNT']` を足す（第 2 段で対象外の 2 つを足す）。

**手順：**

1. `startedAt = partnerBatchClockNow_()`、`readsAtStart = apiReadCount_`。
2. 認可：`webAppAuthorizeCustomer_(customerId, 'WEBAPP:その他の要確認をまとめて確定')`。役割 `role = scope.rolesByCustomerId[customer.customerId]`（`webAppResolveOtherReview` と同じ取り方）。
3. `code = String(code)` が `WEBAPP_OTHER_BATCH_CODES_` に無ければ `{ok: false, code: 'OPERATION_NOT_BATCHABLE'}` を返す（これ以上読まない・書かない）。`reviewIds` が配列でなければ `{ok: false, code: 'INVALID_REQUEST'}`。
4. `auth = authorizeOperation(code, String(customerId), {})`（1 回。`actor = auth.userEmail`。1 件ずつの経路の `applyResolveDecision_` と同じ認可と実行者）。
5. ID を文字列にそろえる（`null`／`undefined` は `''`）。先頭 `WEBAPP_MAX_DECISIONS_`（500）件を受け付け、超えた分は `TOO_MANY_DECISIONS`（文：`一度に確定できるのは 500 件までです。`。数は定数から作る）。
6. 受け付けた件が 0 なら、読まずに §2.2.1 の形で返す。
7. 要確認シートを 1 回読む（`allReviewRecords_()`。同じ ID が複数行なら最初の行）。受け付けた順に件ごとに検査し、外れたら `errors` に積んで以後扱わない。**ここまで何も書かない。**

| 条件 | `code` | `message` |
|---|---|---|
| 同じ呼出しで 2 回目以降に現れた ID | `DUPLICATE_DECISION` | `partnerBatchMessage_('DUPLICATE_DECISION')` |
| 要確認が無い | `REVIEW_NOT_FOUND` | `''` |
| `review.customerId` が違う | `REVIEW_CUSTOMER_MISMATCH` | `''` |
| `status` が `OPEN`／`IN_PROGRESS` でない | `ALREADY_SETTLED` | `''` |
| 種別が `INTEGRITY`／`FILE_CHANGED` | `NOT_SUPPORTED` | `''` |
| 取引単位でない（ファイル単位の要確認） | `OPERATION_NOT_OFFERED` | `''` |
| `review.fileId` が空 | `REVIEW_FILE_MISSING` | `要確認の元ファイルが分かりません。管理者へ連絡してください。` |

8. 残った件の取引を 1 回で読む（`webAppTransactionsById_(fullTxId の配列)`。残りが 0 なら読まない）。件ごとに：

| 条件 | `code` | `message` |
|---|---|---|
| 有効な取引がちょうど 1 行でない（`webAppTransactionsById_` が `null`） | `TRANSACTION_MISSING` | `''` |
| `webAppOtherReviewOptions_(webAppOtherReviewItem_(review), role, tx)` に `code` が無い | `OPERATION_NOT_OFFERED` | `''` |
| その操作の `enabled` が偽 | `OPERATION_DISABLED` | その操作の `disabledReason` |

   **押せるかの判定は `webAppResolveOtherReview` と同じ関数・同じ材料で行う**（判定を写さない）。

9. 通った件を `review.fileId` ごとに分ける（ファイルの並びは最初に現れた順、ファイルの中は受け付けた順）。`customer = getCustomerById(String(customerId))` を 1 回。
10. ファイルごとに、**`webAppResolveReviews` と同じ門の掛け方**で部品を呼ぶ：
    - まとまりを始める前に毎回 `partnerBatchMayStart_({startedAt, deadlineMs: WEBAPP_DEADLINE_MS_, floorMs: PARTNER_BATCH_FLOOR_MS_, factor: PARTNER_BATCH_FACTOR_, maxBatchMs})`。`maxBatchMs` は「この呼出しで済んだファイルの所要（後始末を含む）の最大値」と「いまのファイルの経過」の大きいほう。門が閉じたら、そのファイルの残りと後のファイルの件を全部 `notAttemptedReviewIds` に入れて抜ける。
    - 呼ぶ：`resolvePartnerReviewsBatch(String(customerId), fileId, items.map(→ {reviewId, operation: code}), {actor: auth.userEmail, customer})`。
    - 戻りの写し方：
      - `resolvedReviewIds` → `resolvedReviewIds` に足す。`committedReviewIds.length` → `committed` に足す。
      - `unmet` の各要素 → `unmetTexts` に `menuUnmetText_(unmet)` を足す。
      - `errors` の各要素 → `errors` に `{reviewId, code, message: webAppResolveErrorMessage_(code, message, review, txsById)}`（`txsById` は手順 8 の取引を `{fullTxId: [tx]}` の形にしたもの）。
      - `leaseConflict` があれば（1.1：**この場合も、部品の `errors` は上の写し方どおり先に写す**。部品はリースを取る前の手順 2 で弾いた件を `errors` に入れて返すので、写さないとその件がどこにも入らず恒等式が崩れる）：返った `skippedByLeaseReviewIds`・`notAttemptedReviewIds` と、そのファイルでまだ送っていない件を**全部** `skippedByLeaseReviewIds` に入れ、`leaseConflicts` に `{fileId, fileName, message: menuLeaseConflictText_(null)}` を 1 つ足し、**そのファイルは後始末をせずに次のファイルへ**進む（他のファイルは空いているかもしれない）。
      - 返った `notAttemptedReviewIds`（部品の 100 件の上限）→ 同じファイルの次のまとまりへ回す（門を通してから）。1 件も進まなかったまとまり（送った件が全部 `notAttemptedReviewIds` で返った）なら、そのファイルの残りと後のファイルの件を `notAttemptedReviewIds` に入れて抜ける。
    - 部品が例外を投げたら：送った件を全部 `errors` に `{reviewId, code: error.code || 'RESOLVE_FAILED', message: menuOperationErrorMessage_(error)}` で積み、そのファイルの残りと後のファイルの件を `notAttemptedReviewIds` に入れ、**そのファイルの後始末だけをして**抜ける（想定外の失敗の後で他のファイルに進まない）。
11. 後始末（件を 1 つでも部品へ渡し、リース衝突で終わらなかったファイルごとに 1 回。`webAppResolveReviews` と同じ）：
    - 部品の `followUp.orphanCandidates` が 0 以上の整数で 0 と分かっているとき以外（例外があったときを含む）は `commitSettledTransactions_(fileId)`。戻りの `deferred` を `deferredCommits` に足す。
    - `completeFileIfFullyResolved_(fileId, {readLeases: activeLeases_})`。完了したら `completedFiles` に `{fileId, fileName, stateLabel: menuFileStateLabel_(state)}`。
    - どちらかが例外なら `errors` に `{fileId, code, message}`（`webAppFileError_` と同じ形。`reviewId` は無い）。他の件の結果は変えない。
12. ログ：呼出しごとに 1 行 `Logger.log('OTHER_REVIEWS_BATCH ' + JSON.stringify({code, items, resolved, committed, errors, skippedByLease, notAttempted, files, completedFiles, ms, reads}))`。数とコードだけ（`items` は受け取った ID の数、`files` は部品へ渡したファイルの数、`ms`・`reads` は手順 1 からの差）。**明細の値・店名・ファイル名・取引先名を出さない。**

#### 2.2.1 戻り値

```
{ok: true, code, label,                 // label は MENU_RESOLVE_OPERATIONS_[code].label
 resolved, committed,                   // 数
 resolvedReviewIds: [],                 // 要確認を RESOLVED にできた件
 unmetTexts: [],                        // RESOLVED にしたが取引が確定しなかった件の理由の文（menuUnmetText_）
 errors: [{reviewId, code, message}     // 件の失敗（手順 5・7・8・部品）
          | {fileId, code, message}],   // 後始末の失敗（reviewId なし）
 skippedByLeaseReviewIds: [],           // ファイルのリースが取れず手を付けなかった件
 leaseConflicts: [{fileId, fileName, message}],
 notAttemptedReviewIds: [],             // 時間の門・例外の後で手を付けなかった件（次の呼出しに回す）
 completedFiles: [{fileId, fileName, stateLabel}],
 deferredCommits}
```

**勘定の恒等式：**`reviewIds.length ＝ resolvedReviewIds.length ＋（reviewId のある errors の数）＋ skippedByLeaseReviewIds.length ＋ notAttemptedReviewIds.length`。受け取った ID は（同じ ID が 2 回あっても回ごとに）このどれか 1 つだけに入る。

`fileName` は `menuDisplayFileName_(review) || '（ファイル名不明）'`（そのファイルの最初の件の要確認から）。

### 2.3 画面（`src/81_WebAppUi.html`）

**呼出し表：**`gasCall` の関数の表に `webAppResolveOtherReviewsBatch`（引数 3 つ）を足す。

**分かれ目：**［選んだ行をまとめて確定…］で、帯で選んだ操作が `OTHER_SERVER_BATCH_CODES = ['POST_PRIOR_YEAR', 'POST_ZERO_AMOUNT']` にあれば、本節の流れ（サーバーでまとめて）。それ以外（`EXCLUDE_PRIOR_YEAR`・`EXCLUDE`）は**今の 1 件ずつの流れを 1 文字も変えずに**使う（確認の文も今のまま）。帯・チェックボックス・候補の作り方・選択の掃除（`spec_other_reviews_bulk.md` §2・§3）は変えない。

**流れ（サーバーでまとめて）：**

1. 押した時の条件（`isMutationBusy()` なら何もしない・選択 0・操作が空・共通部分に無い）と、対象（押した時点で選んでいる行を表の順に）は今と同じ。
2. 確認（`formatConfirm(title, message)`）：title＝操作の `label`。message＝
   `「その他の要確認」の N 件（<種類の内訳>）にまとめて行います。` ＋ `TEXT.otherEffect(code, {})` ＋ ` サーバーでファイルごとにまとめて確定します（目安は 1 ファイル 20〜30 秒です）。途中で［中止］を押すと、処理中のまとまりが終わったところで止まります（済んだ分は戻りません）。`
   ［戻る］なら 1 回も呼ばない（選択はそのまま）。
3. 始め：今と同じ（`token = ++state.resolveRun`、`generation`、`customerId` を控え、`state.otherBulkRun = {canceled: false}`、`state.resolveBusy = true`、`clearNotice()`、`renderSelection()`）。
4. 繰り返し：`pending`＝対象の ID（表の順）。`pending` が空になるまで：
   - 呼ぶ前に毎回：画面が変わった（`otherBulkIsCurrent` が偽）か［中止］が押されていれば、**呼ばずに**抜ける。
   - `#other-bulk-progress` を `まとめて確定中… 済み D / N 件（サーバーでファイルごとに処理しています）` にする（D はここまでに済んだ数、N は対象の数）。
   - `result = await gasCall('webAppResolveOtherReviewsBatch', [customerId, pending, code])`。**前の応答が返ってから次を呼ぶ。**
   - 例外 → 「止まった」（理由は `failureMessage(error)`）。`pending` の行は選んだまま。抜ける。
   - 応答の後、画面が変わっていたら抜ける（お知らせを出さない）。
   - `result.ok !== true` → 「止まった」（理由は 1 件ずつのときの `ok: false` の文。`OPERATION_NOT_BATCHABLE`・`INVALID_REQUEST` は `TEXT.unknownFailure`）。抜ける。
   - 分け方（**対象に無い ID は全部無視する**）：
     - `resolvedReviewIds` → 済み。`otherSelectedIds`・`otherInputs` から外す。D に数える。
     - `errors` のうち `code` が `ALREADY_SETTLED`・`REVIEW_NOT_FOUND` → 「既に片付いていた」。選択から外す。S に数える（止まらない）。
     - `errors` のその他の件 → 失敗。選んだまま。
     - `errors` の `reviewId` の無いもの → 後始末の失敗。
     - `skippedByLeaseReviewIds` → リースで見送り。選んだまま。
     - `committed`・`unmetTexts`・`completedFiles` を足し合わせる。
   - 次の `pending` ＝ `result.notAttemptedReviewIds` のうち**今の `pending` にある ID だけ**（今の `pending` の並び順）。
   - 失敗・後始末の失敗・リースで見送りのどれかが 1 つでもあれば「止まった」。抜ける（**次を呼ばない**。1 回の呼出しの中では、サーバーは失敗した件を飛ばして他の件を進めている）。
   - 次の `pending` が空なら抜ける。今の `pending` より減っていなければ「進まない」。抜ける。
5. 終わり（`finally`）：今と同じ（同じ印のときだけ `resolveBusy = false`・`otherBulkRun = null`・`#other-bulk-progress` を空・`markFinalReviewStale()`・`renderSelection()`・`loadReviews` を 1 回・`selectedFolderId` があれば `loadFiles` を 1 回）。**全部済んだとき（下の「全部済んだ」）だけ** `otherBulkCode = ''`。
6. お知らせ（画面が変わって抜けたときは出さない）。R ＝ 対象の数 − D − S。<label> は今と同じ（対象の最初の行のその操作の `label`。応答の `label` は使わない）。
   - **全部済んだ**（D ＋ S ＝ 対象の数、止まらず・中止せず）：`success` で
     `「その他の要確認」 D 件をまとめて確定しました（<label>）。` ＋（U＞0 なら）`U 件は取引がまだ確定していません（<最初の unmetTexts>）。` ＋（F＞0 なら）`ファイル F 本の要確認がすべて片付きました。` ＋（S＞0 なら）`S 件は既に片付いていました。`
     （U＝`unmetTexts` の数の合計、F＝`completedFiles` の数の合計）
   - **中止**：今と同じ文（`中止しました。D 件を確定しました（<label>）。残り R 件は選んだままです。`）。`warning`。
   - **止まった**：`warning` で `D 件を確定したところで止まりました（<label>）。` ＋ <理由> ＋ `残り R 件は選んだままです。`
     - <理由>：例外・`ok: false` のときはその文（末尾に `。` が無ければ足す。今の `otherBulkReason`）。それ以外は次をこの順につなぐ：失敗が E 件あれば `確定できなかった行が E 件あります。`、リースで見送りが L 件あれば `ほかの処理がファイルを使用中のため L 件を見送りました（10 分ほど待ってからもう一度押してください）。`、後始末の失敗があれば `確定の後始末に失敗したファイルがあります。`。
     - 詳細（`showNotice` の第 3 引数）：失敗の件ごとに `<fileName> <sourceRow> 行目：<文>`（今の `otherBulkTargetLabel`。文は、`code` が 1 件ずつのときの `ok: false` の表にあればその文〔`OPERATION_DISABLED` は `message` を理由として渡す〕、無ければ `message`、それも空なら `TEXT.unknownFailure`）。後始末の失敗は `message` をそのまま 1 行ずつ。
   - **進まない**（どれにも当たらないのに残りが減らない、または応答の数が合わず D ＋ S が対象の数に届かない）：`warning` で `D 件を確定したところで止まりました（<label>）。時間が足りず、残りを確定できませんでした。もう一度押してください。残り R 件は選んだままです。`
7. ［中止］：今と同じ（印を付けるだけ。押した後は disabled）。呼出し中に押しても、その呼出しの応答を待ってから抜ける。

---

## 3. 安全の条件（テストで確かめる）

サーバー：
- **I1**：計上で転記先は 1 セルも変わらない（雛形も複製も）。
- **I2**：計上で取引ログに書くのは、確定するときの J（`COMMITTED`）と AS（更新日時）だけ。**L（取引先の解決状態）・S〜AB・AT〜AW に書かない。**
- **I3**：取引を確定するのは `commitBlockingReasons_` が理由なしで、状態が `REVIEW_REQUIRED` のときだけ。取引先が未解決・別の要確認が残る・利用日が空の取引は `REVIEW_REQUIRED` のまま。
- **I4**：要確認を `RESOLVED` にするのは、ロックの中で読み直して `OPEN`／`IN_PROGRESS` のときだけ。他の経路が閉じた要確認を上書きしない。
- **I5**：押せない件（役割・取引の状態・種別・顧客違い・ファイル単位・取引が特定できない）には何も書かない。リースを持ってから取引の状態が変わっていたら `STATE_TRANSITION` で書かない。
- **I6**：リースは必ず返す（例外でも）。時間の門で 6 分の上限より前に止まる。
- **I7**：§2.2.1 の恒等式。
- **I8**：選んでいない要確認（同じファイル・同じ取引の別の要確認を含む）に触れない。
- **I9**：取引先の経路の振る舞いは変わらない（既存のテストが期待を変えずに通る）。
- **I10**：ログに明細の値・店名・ファイル名・取引先名が出ない。

画面：
- **U1**：送る ID は押した時点で選んでいた行のものだけ。2 回目以降は前の応答の `notAttemptedReviewIds` のうち前に送った ID だけ。`code` は帯で選んだ操作だけ。
- **U2**：確認で［戻る］なら 1 回も呼ばない。
- **U3**：同時に 2 つ呼ばない。
- **U4**：止まる条件・［中止］・画面の切替の後は 1 回も呼ばない。
- **U5**：実行中はまとめて確定・1 件ずつの確定・取引先の確定・［記帳を実行］・形式の操作が押せない（`isMutationBusy()`）。もう一度押しても呼出しは増えない。
- **U6**：計上の 2 つのまとめて確定は `webAppResolveOtherReview` を 1 回も呼ばない。対象外の 2 つは `webAppResolveOtherReviewsBatch` を 1 回も呼ばない。
- **U7**：一覧の読み直しは実行の最後に 1 回だけ。

---

## 4. 1 件ずつの経路との違い（これ以外は同じでなければならない）

**同じでなければならないもの（計上できた件について）：**転記先の全セル、取引ログの全列（AS の日時を除く）、要確認行の B・R・V・W・Z・AB・AD・AE・AF、監査の `REVIEW_RESOLVE` 行（数・実行者・対象・`after`。ID・日時・並びを除く）、処理ログのファイルの状態（完了したか）。

**違ってよいもの（全部）：**
1. リースをまとまりに 1 回取る（1 件ずつは取らない）。だから `LEASE_RELEASE` の監査行がまとまりに 1 行増える。
2. リースを持ってから取引の状態をもう一度確かめる（`STATE_TRANSITION`）。
3. 同じまとまりの件は同じ日時になってよい。監査行の並びは違ってよい。
4. ファイルの完了判定はファイルごとに最後に 1 回（1 件ずつは件ごと）。終わりの状態は同じ。
5. 他者のリースがあると、1 件ずつは件ごとに `LEASE_CONFLICT` の失敗、まとめてはファイルの件を `skippedByLeaseReviewIds` に入れる。
6. `DUPLICATE_TRANSACTION`（1 件ずつは順に閉じるので起きない）。

---

## 5. 変えてよいファイル

- `src/55_PartnerBatchResolution.gs`（§2.1）
- `src/80_WebApp.gs`（§2.2。新しい関数と定数を足すだけ。既存の関数は変えない）
- `src/81_WebAppUi.html`（§2.3）
- `test/phase8-webapp.test.js`（§6.1 の `pb N` を、`kw2` のテストの並びの後ろに足す。`kw2Seed`・`kw2TxReview`・`kw2Resolve`・`kw2Snapshot`・`kw2NoWrite`・`withPartnerTiming`・`withMocks`・`transactionFor`・`reviewById`・`destinationSnapshot` などの道具を使ってよい）
- `test/phase9-format-registration.test.js`（§6.2 の `pbu N` を `ob` の並びの後ろに足す。`browserWorld` の呼出し表に `webAppResolveOtherReviewsBatch` を足す。§6.3 の直し）

テストの材料は架空の表で作る（実明細の値を写さない）。

---

## 6. テスト

### 6.1 サーバー（`pb N: …`）

材料：個人（`customerCategory: 'INDIVIDUAL'`）・`fiscalYear: 2026` の顧客で `2025/…` の利用日の行を取り込むと `PRIOR_YEAR` が立つ（`kw2 6` と同じ作り方）。金額 0 の行で `ZERO_AMOUNT`。`既知店` は取引先が決まり、`未知店` は `PARTNER` の要確認が残る。

1. **pb 1（同値・前年利用日）**：同じ材料の世界を 2 つ（`既知店` 2 行・`未知店` 1 行、すべて前年利用日）。一方は `webAppResolveOtherReview` を 1 件ずつ、他方は `webAppResolveOtherReviewsBatch` を 1 回。§4 の「同じでなければならないもの」が一致する。`既知店` の 2 件は取引が `COMMITTED`、`未知店` の 1 件は `REVIEW_REQUIRED` のまま（I3）。戻りの `resolved: 3`・`committed: 2`・`unmetTexts` に `取引先が未解決` を含む。
2. **pb 2（同値・0 円）**：`POST_ZERO_AMOUNT` で 1 と同じ比較。
3. **pb 3（L 列に書かない）**：`未知店` の前年利用日を計上 → 取引ログの L は前の値（`UNRESOLVED`）のまま、J は `REVIEW_REQUIRED`、同じ取引の `PARTNER` の要確認は `OPEN` のまま（I2・I3・I8）。取引ログの行は J・AS を含めて 1 セルも変わらない。
4. **pb 4（転記先に書かない）**：計上の前後で、すべての転記先（雛形・複製）の内容が同じ（I1）。
5. **pb 5（読取が件数に依らない）**：1 ファイル 2 件と 1 ファイル 20 件の `batchGet` の回数が等しい。2 ファイル（20 件と 21 件）の回数も測る。上限は実測値（報告する）。比べるために 1 件ずつの経路の 1 件の回数も測って報告する。取引先の名簿・辞書のシートを読まない。
6. **pb 6（件ごとの番人）**：同じ呼出しに、無い ID・他の顧客の要確認・確定済みの要確認・`DATE` の要確認（`POST_PRIOR_YEAR` は選べない）・ファイル単位の要確認・`ZERO_AMOUNT` に `POST_PRIOR_YEAR`・取り消した取引（同じ取引の `PARTNER` を `EXCLUDE` で対象外にした）に残った前年利用日・同じ ID の 2 回目を混ぜる。普通の件は確定し、それぞれ §2.2 の `code`（`REVIEW_NOT_FOUND`・`REVIEW_CUSTOMER_MISMATCH`・`ALREADY_SETTLED`・`OPERATION_NOT_OFFERED`・`OPERATION_NOT_OFFERED`・`OPERATION_NOT_OFFERED`・`OPERATION_DISABLED`（`message` は `disabledReason`）・`DUPLICATE_DECISION`）。失敗の件の要確認・取引は 1 セルも変わらない（I5）。恒等式が成り立つ（I7）。
7. **pb 7（リースの中で状態を見直す）**：部品の手順 4 の読取の直前に（`withMocks` で `getTransactionsForFile_` を包み、先に元の取引を `CANCELED` へ書き換えてから元を呼ぶ）取引を取り消す → その件は `STATE_TRANSITION`、要確認は `OPEN` のまま、監査の `REVIEW_RESOLVE` は増えない（I5）。
8. **pb 8（閉じられた要確認を上書きしない）**：部品の手順 4 の直前に（pb 7 と同じ包み方）、1 件の要確認の状態だけを `updateReviewStatus(reviewId, 'EXCLUDED', {excludeReason: …})` で閉じておく（取引は変えない）→ その件は `ALREADY_SETTLED`、要確認行は `EXCLUDED` のまま（I4）。他の件は確定する。
9. **pb 9（リース衝突）**：他者が 1 つ目のファイルのリースを持つ → そのファイルの件は全部 `skippedByLeaseReviewIds`、`leaseConflicts` に 1 つ、そのファイルは何も変わらない。2 つ目のファイルの件は確定する。リースの行は他者の 1 行だけ残る。（1.1）同じ形で、1 つ目のファイルの 1 件を、部品が呼ばれる直前（`resolvePartnerReviewsBatch` を包む）に要確認の状態だけ閉じておくと、その件は `errors`（`ALREADY_SETTLED`）に入り、残りは `skippedByLeaseReviewIds`、恒等式が成り立つ。
10. **pb 10（リースを必ず返す・やり直せる）**：部品の手順 8 の頭（`allReviewRecordsAndAuditTail_`）で例外を起こす → 送った件は `errors`、後のファイルの件は `notAttemptedReviewIds`、リースの行が残らない（I6）。もう一度同じ ID で呼ぶと全件確定し、`REVIEW_RESOLVE` の監査行は件ごとにちょうど 1 行。
11. **pb 11（時間の門）**：`withPartnerTiming` で 1 つ目のファイルの所要を 200 秒にする → 2 つ目のファイルの件は全部 `notAttemptedReviewIds`、部品は 2 回目を呼ばれない、リースの行が残らない。もう一度呼ぶと残りが確定する。
12. **pb 12（部品の上限）**：`PARTNER_BATCH_MAX_ITEMS_` を 2 に差し替えて 1 ファイル 3 件 → 1 回の呼出しの中で部品が 2 回呼ばれ、3 件とも確定する。
13. **pb 13（後始末）**：前年利用日だけが残るファイル（`既知店` だけ）を全部計上 → ファイルが完了し、`completedFiles` に `stateLabel` 付きで 1 つ。孤児の候補が 0 のとき `commitSettledTransactions_` を呼ばない（呼ばれた回数を数える）。部品が例外を投げたときは呼ぶ。
14. **pb 14（認可と操作）**：権限の無い実行者は例外（要確認・取引ログ・転記先・処理ログは変わらない。監査の `PERMISSION` の拒否行は増えてよい）。`EXCLUDE`・`EXCLUDE_PRIOR_YEAR`・`FIX_DATE_AMOUNT`・`ADOPT_EXISTING_PARTNER` では `{ok: false, code: 'OPERATION_NOT_BATCHABLE'}`、`reviewIds` が配列でなければ `INVALID_REQUEST`。どちらもシートが 1 セルも変わらない（`kw2NoWrite` と同じ確かめ方）。501 件目以降は `TOO_MANY_DECISIONS`。
15. **pb 15（部品の入口）**：`resolvePartnerReviewsBatch` に計上と取引先の操作を混ぜると `TypeError`、読取の回数も変わらず何も書かない。同じ取引の `PRIOR_YEAR` と `ZERO_AMOUNT`（金額 0・前年の利用日の行。取込で両方が立たなければ、足りない方を `registerReview` で同じ取引に足す）をそれぞれの計上で同じ呼出しに入れると、2 件目が `DUPLICATE_TRANSACTION` で 1 件目は確定する。
16. **pb 16（ログ）**：`OTHER_REVIEWS_BATCH` の行と `PARTNER_BATCH` の行（`operations: ["POST_PRIOR_YEAR"]` を含む）に、材料の店名・ファイル名・金額の文字列が出ない（I10）。

### 6.2 画面（`pbu N: …`）

道具は `obRow`・`obZeroRow`・`obCheck`・`obCheckAll`・`obChoose`・`kw2World`・`kw2Flush` を使ってよい。応答の道具（例 `pbuReply(extra)`：`{ok: true, code, label, resolved, committed, resolvedReviewIds, unmetTexts: [], errors: [], skippedByLeaseReviewIds: [], leaseConflicts: [], notAttemptedReviewIds: [], completedFiles: [], deferredCommits: 0}`）を足してよい。

1. **pbu 1（計上はまとめて呼ぶ）**：4 行のうち 3 行を選び `POST_PRIOR_YEAR` → 確認の title・message（§2.3-2 の文そのもの）→ 呼出しは `webAppResolveOtherReviewsBatch` が 1 回で、引数は `['C001', ['r1','r2','r3'], 'POST_PRIOR_YEAR']`（表の順）。`webAppResolveOtherReview` は 0 回（U6）。応答を返すまで 2 回目は無い（U3）。`#other-bulk-progress` が `まとめて確定中… 済み 0 / 3 件（サーバーでファイルごとに処理しています）`。`POST_ZERO_AMOUNT` でも同じ。
2. **pbu 2（全部済んだ）**：`success` の文（U・F・S の各組合せ：なし、U だけ、F と S）、選択が空、`otherBulkCode` が空、`webAppListReviews`・`webAppListFolder` が 1 回ずつ（U7）、`resolveBusy` 偽、`finalReviewedFor` が `null`、進み具合が空、［中止］が隠れる。
3. **pbu 3（残りを続ける）**：1 回目の応答で `r1`・`r2` が済み、`notAttemptedReviewIds: ['r3', 'zz']`（`zz` は対象に無い）→ 2 回目は `['C001', ['r3'], 'POST_PRIOR_YEAR']` だけ（U1）。進み具合が `済み 2 / 3 件`。2 回目で済んで `success`。読み直しは全体で 1 回ずつ。
4. **pbu 4（止まる）**：1 回目の応答に `notAttemptedReviewIds: ['r3']` があっても、(a) `r2` が `OPERATION_DISABLED`（`message: '（取引の状態 CANCELED では不可。管理者へ）'`）、(b) `r2` が `skippedByLeaseReviewIds`、(c) `reviewId` の無い後始末の失敗、のそれぞれで 2 回目を呼ばない（U4）。お知らせの文（D・<理由>・R）と詳細の行（(a) は `架空明細.csv 2 行目：この操作は選べません（取引の状態 CANCELED では不可。管理者へ）。`）。(a)(b) は `r2`・`r3` が選んだまま、`r1` は外れる。(d) 例外、(e) `{ok: false, code: 'OPERATION_NOT_BATCHABLE'}` では全部が選んだまま。
5. **pbu 5（既に片付いていた）**：`r2` が `ALREADY_SETTLED`（と `REVIEW_NOT_FOUND`）→ 止まらず、選択から外れ、`success` に `1 件は既に片付いていました。`。
6. **pbu 6（中止）**：1 回目を待つ間に［中止］→ 応答に `notAttemptedReviewIds` があっても 2 回目を呼ばない。中止の文。押した後は disabled。
7. **pbu 7（画面が変わった）**：1 回目を待つ間に顧客を切り替える → 応答の後も 2 回目を呼ばない、お知らせを出さない、切り替えた先の状態を壊さない。
8. **pbu 8（進まない）**：応答が送った全部を `notAttemptedReviewIds` で返す → 2 回目を呼ばず「進まない」の文。応答が空（`resolvedReviewIds` も `errors` も空、`notAttemptedReviewIds` も空）でも「進まない」の文で、全部選んだまま（全部済んだと言わない）。
9. **pbu 9（実行中は押せない）**：実行中、`other-op`・`other-submit`・`other-select`・`other-select-all`・`#other-bulk-op`・`#other-bulk-button`・取引先の［選択した要確認を確定］が disabled。もう一度押しても呼出しは増えない（U5）。
10. **pbu 10（対象外は今のまま）**：`EXCLUDE_PRIOR_YEAR`・`EXCLUDE` では確認の文が今の 1 件ずつの文で、`webAppResolveOtherReview` を 1 件ずつ呼び、`webAppResolveOtherReviewsBatch` を 1 回も呼ばない（U6）。

### 6.3 既存のテストの扱い

**既存のテストは期待を変えずに緑のままであること。**例外は次の 2 つだけ（直したものはすべて報告）：
- `ob 5`〜`ob 11` のうち、まとめて確定を**走らせる**所で選ぶ操作 `POST_PRIOR_YEAR` を `EXCLUDE_PRIOR_YEAR` に替える（1 件ずつの流れを確かめ続けるため）。それに合わせて、期待する呼出しの引数の操作コード、`obSuccess` に渡す `code`・`label`、お知らせの文に入る操作名だけを直してよい。走らせない所（`ob 3`、`ob 11` の `importBusy`・`formatBusy` の所、`ob 12`）は変えない。
- `browserWorld` の呼出し表に `webAppResolveOtherReviewsBatch` を足す。

特に緑のままであること：`batch 1`〜`27`、`fc` の全部、`kw2` の全部、`ob 1`〜`4`・`12`・`13`、`webapp 45h`・`45m`・`45o`、`ui 6`、`pace 1`・`budget 1`・`flush 1`。

---

## 7. 変異（入れて回し、赤になるテストを記録して戻す）

サーバー：
- P1：計上の件を手順 6 に通し、L に `RESOLVED_WITHOUT_PARTNER` を書く（いちばん起きやすい誤り）
- P2：部品で計上の件の取引の状態を見ない
- P3：80 で `OPERATION_DISABLED` を見ない（押せない件も部品へ渡す）
- P4：手順 8 で `commitBlockingReasons_` を見ずに確定する
- P5：手順 8 で要確認の読み直し（`OPEN`／`IN_PROGRESS` か）を外す
- P6：`finally` でなく成功のときだけリースを返す
- P7：80 で時間の門を見ない
- P8：部品が返した `notAttemptedReviewIds` を戻り値に入れずに捨てる
- P9：`DUPLICATE_TRANSACTION` の検査を外す
- P10：操作を混ぜたときの `TypeError` を外す
- P11：後始末（`completeFileIfFullyResolved_`）を呼ばない
- P12：リース衝突のファイルの未送の件を `skippedByLeaseReviewIds` に入れない
- P13：ログに `fileName` を足す
- P14（1.1）：リース衝突のとき部品の `errors` を写さない

画面：
- Q1：計上も 1 件ずつ呼ぶ
- Q2：2 回目に対象を全部送る（`notAttemptedReviewIds` を使わない）
- Q3：`notAttemptedReviewIds` を前に送った ID と突き合わせない
- Q4：失敗があっても続ける
- Q5：［中止］を見ない
- Q6：画面の切替を見ない
- Q7：対象外もまとめて呼ぶ
- Q8：応答ごとに `loadReviews` を呼ぶ
- Q9：応答の数が合わなくても「全部済んだ」と出す

---

## 8. 受入（利用者。push の後）

1. 読むだけ（Claude）：`opsShowLeases` でリースが無いこと。
2. 利用者：F5 → TEST01 → 「その他の要確認」で前年利用日を［全部選ぶ］→「前年の利用分として計上する」→［選んだ行をまとめて確定…］→ 確認 →［実行］。
3. 期待：`まとめて確定中… 済み 0 / N 件…` の後、41 件・2 ファイルなら 1 分前後で `「その他の要確認」 41 件をまとめて確定しました（前年の利用分として計上する）。` 表から消える。他に要確認の無いファイルは完了になる。
4. Claude：`clasp logs` の `OTHER_REVIEWS_BATCH` と `PARTNER_BATCH`（`operations: ["POST_PRIOR_YEAR"]`）で `ms`・`reads` を記録し、本節に追記する。`opsShowLeases` でリースが残っていないこと。

**受入の材料：**前年利用日の要確認が要る。いまの版（1 件ずつ）で 41 件を全部確定すると、第 1 段の受入に使う件が無くなる。

**受入の記録（2026-11-11、`gas-push-145`、利用者「終わった」）：**TEST01 の前年利用日 41 件（楽天 2 本）。`clasp logs` より（時刻は日本時間）：
- 17:45:40〜17:46:09 の 1 回目：`OTHER_REVIEWS_BATCH` 38 件・2 ファイル、確定 38・取引の確定 38・失敗 0・リース見送り 0・未着手 0、完了 1 本、**29.3 秒・読取 34 回**。部品はファイルごとに 22 件 10.2 秒・16 件 9.0 秒で、**読取はどちらも 7 回**（`destinations: 0`・`orphanCandidates: 0`）。
- 17:46:37〜17:46:50 の 2 回目：3 件・1 ファイル（1 回目の 22 件と同じファイル）、確定 3・取引の確定 3、完了 1 本、**13.3 秒・読取 22 回**（部品は 6.0 秒・7 回）。
- 後で読むだけで確かめた：未解決の要確認 0 件（`opsCountReviewsByType`）、リースなし（`opsShowLeases`）。
- 1 件ずつの経路なら 1 件 24 回（pb 5）× 41 件 ≒ 1000 回の読取＝枠だけで 16 分以上かかる見込みだった。
- 2 回に分かれたのは、利用者が 1 回目に 3 件のチェックを自分で外したため（利用者に確認済み）。画面の不具合ではない。
- **受入合格。**

---

## 9. Claude の判断の記録（利用者の決定ではないもの）

- **部品 55 に足す**（新しい部品を作らない）。要確認の書込・監査・確定の判定・リース・時間の門を 1 か所のままにするため。確定の判定を 2 か所に書くと片方だけ直す事故が起きる。
- **1 回の呼出しで取引先の操作と計上の操作を混ぜない**（`TypeError`）。混ぜないことで、計上の呼出しは手順 5〜7 を丸ごと飛ばせ、L 列に書く経路が入り込まない。
- **同じ取引の 2 件目は `DUPLICATE_TRANSACTION`** で書く前に止める（確定を 2 回書かない）。
- **リースを持ってから取引の状態をもう一度確かめる**（1 件ずつより厳しい）。
- **画面は、問題が 1 つでも出た呼出しの後は次を呼ばない**（画面だけの版の「止まる」を引き継ぐ）。1 回の呼出しの中では、サーバーは失敗した件を飛ばして他の件を進める（取引先のまとめ確定と同じ）。
- **進み具合は呼出しごとの済んだ数だけ**（経過時間の表示は付けない）。1 回の呼出しで 41 件が済む見込みなので、確認の文に目安（1 ファイル 20〜30 秒）を書く。
- **`webAppResolveReviews` の繰り返しとは共通にしない**。共通にすると取引先の経路（本番で使っている）にも手が入る。門の判定（`partnerBatchMayStart_`）と後始末の関数は共通のものを呼ぶ。
- 1 行ごとの［確定…］は 1 件ずつのまま（1 件ならまとめても速くならない）。
- 読取の見込み（呼出しの頭 6 回前後＋1 ファイル 12 回前後）は、部品の取引先の実測（1 ファイル 10〜12 回・11〜22 秒）からの見積もり。pb 5 の実測で置き換える。

---

## 10. 実装と監査の記録（2026-11-11）

**実装：**OpenCode（Go の DeepSeek V4.1 Flash、worktree `go/other-reviews-post-batch`）。1 回目 4306 秒・$0.63、直し 553 秒・$0.03。変えたのは 55・80・81 と phase8・phase9 だけ。80 は足しただけ（既存の行の変更 0）。

**テスト：**固定データ無しで 1913/2010（落ちるのは固定データが無いための ENOENT の 97 件だけ）。固定データを写して 2010/2010（1 回目は `ac 6` が時刻の秒またぎで落ち、2 回目で通過）。写したものは消した。

**読取の実測（pb 5）：**1 ファイル 2 件 19 回・1 ファイル 20 件 19 回（件数に依らない）・2 ファイル 41 件 31 回・1 件ずつの経路は 1 件 24 回（41 件なら 1000 回前後）。取引先の名簿・辞書は読まない。§1.2 の見込み（頭 6 回＋1 ファイル 12 回）より多いので、受入で `OTHER_REVIEWS_BATCH` の `reads` を記録する。

**変異：**P1〜P14・Q1〜Q9 はすべて赤（実装者の記録）。Claude が自分で入れた 2 つ：X1（計上の呼出しも手順 6 に通す＝P1 と同じ）→ pb 1・2・3 が赤、X2（部品の例外の後も次のファイルへ進む）→ pb 10 が赤。

**監査で直したもの：**
- 中：リース衝突のとき 80 が部品の `errors` を写さず、§2.2.1 の恒等式が崩れた → 写してからリース衝突を見る形に直し、pb 9 に確かめを足した（P14）。仕様書 1.1。
- 低：既存の関数 `webAppResolveErrorMessage_` の 1 行目の改行が消えていた → 戻した。

**直さずに記録したもの（低）：**
- `STATE_TRANSITION` の文に出る取引の状態は、押した時に読んだ値（リースの中で読み直した値ではない）。取引先の経路（`webAppResolveReviews`）と同じ癖。
- §6.3 で変えないとした `ob 11` の取込中・形式の操作中の所でも、操作名を `EXCLUDE_PRIOR_YEAR` に替えた。押せない判定は操作の分かれ目より前なので、確かめている中身は同じ。
- 画面は、済んだ件を「まだ選んでいる件」のときだけ数える。実行中は選択を変えられないので実害なし。
- pb 1・pb 2 の同値の比較では、取引ログの C 列（取込の実行 ID）と AR・AS 列（登録・更新日時）を除いた（別々に取り込んだ 2 つの世界を比べるため）。

# 取引先以外の要確認も Web アプリで確定する 仕様書（K-W2）

版：1.1（2026-10-17。1.0 から kw2 25 の置き方・取引先の行の `exclude` の逃げ道・書き方の決まりを足した ── Codex 1 回目の停止への回答、§9）
対象：`src/80_WebApp.gs`・`src/81_WebAppUi.html`・`src/96_Menu.gs`（1 行）。
発端：`spec_webapp.md` §14 K-W2「要確認の表は `PARTNER` だけ。他種別はメニューから確定する ── 担当者が 2 つの画面を行き来する」。§15 の課題がすべて片付いた 2026-10-17、次の作業として ko-ch さんが選んだ。

## 1. 背景

- Web アプリの右の列は、取引先の要確認（`PARTNER`）だけを表に出す。ほかの種類は上の帯に「日付 1 件、…。その他の要確認はメニューから確定してください。」と件数を出すだけ（`renderOtherReviews`）。確定はスプレッドシートのメニュー「クレカ自動処理 ▸ 要確認を確定」（`menuResolveReview`）で、番号を打つ対話を 3〜5 回くぐる。
- メニューの確定は、1 つの関数 `applyResolveDecision_(item, code, inputs, options)`（`96_Menu.gs`）が全部の操作を実行する。選べる操作は `resolveOptionsFor_(item, role, live)` が決める（`MENU_RESOLVE_OPERATIONS_` に載る操作のうち、その種類に許されたもの。役割・freee 取込済み・取引の状態・転記済み取引の有無で押せなくする）。取引の確定は `51` の `resolveReview`、ファイルの確定は `52` の `resolveFileReview`、取込待ちへ戻すのは `97` の `rewindFileForReimportAudited_`、後始末は `commitSettledTransactions_` と `completeFileIfFullyResolved_`。**Web アプリはこの部品をそのまま使う。新しく確定の処理を書かない。**
- `spec_webapp.md` 1047 行の「Web アプリを使い始めたら、メニューのファイル単位の操作を押さない」（K-W14）は、§15-4（2026-09-29）で解消している ── `52` のファイル単位の操作は、取引ログ AC・AD に記録された転記先（複製）を `resolveFileDestination_` で引く。取引単位の操作（`51`）は要確認行の M・N 列（取込が複製を書く）で書き先を決める。
- 2026-10-17 時点の本番の未解決は `FORMAT_UNKNOWN` 5 件だけ（`opsCountReviewsByType`）。種類ごとの過去の頻度は数えられない（確定済みを種類別に数える公開関数が無い）。

**ko-ch さんの決定（2026-10-17）：**
1. **範囲はメニューと同じ全部。**取引の `DATE`・`AMOUNT`・`ZERO_AMOUNT`・`PRIOR_YEAR`、ファイルの `DUPLICATE`・`COUNT_TOTAL_MISMATCH`・`EMPTY_FILE`・`INPUT_LIMIT`・`SCAN_TRUNCATED`・`DESTINATION_FIX`・`FORMAT_AMBIGUOUS`・`MULTI_SHEET`・`FORMAT_UNKNOWN`。`INTEGRITY`・`FILE_CHANGED` はメニューでも確定できない（`buildResolveTargets_` が「画面から確定できない要確認」として数えるだけ）ので、今と同じく件数だけ。
2. **置き場所は右の列。**取引先の表の下に「その他の要確認」の一覧を足す。1 件ずつ操作を選び、確認を経て確定する。ファイル単位の要確認もここに出す。
3. **取引先の要確認にも「対象外にする（転記行を空にする）」を足す。**1 件ずつ・確認つき。dカード以外で「ご入金」のような転記しない行が出たときも、これで画面から外せる。

## 2. 決めたこと

1. **操作の一覧と実行はメニューの部品を使う。**選べる操作は `resolveOptionsFor_` の結果を §3.1 の規則で絞ったもの。実行は `applyResolveDecision_`。Web アプリ側は「認可・顧客の確かめ・要確認の状態・押せる操作か・入力の検査」だけを足す。
2. **Web で絞る規則（§3.1）は 2 つだけ：**
   - `PARTNER` は `EXCLUDE` だけ（採用・取引先なしは、今の取引先の表とまとめ確定の道 `webAppResolveReviews` が受け持つ）。
   - `FORMAT_UNKNOWN` は `REGISTER_FORMAT` を出さない（`CANCEL_FILE` だけ）。形式の登録と取込待ちへの戻しは、中央のファイル一覧の［形式を確認］（§15-8、`webAppRequeueFormatFiles`）が受け持つ ── あちらは戻す前に「今の形式で当たるか」を読んで確かめるが、メニューの `REGISTER_FORMAT` は確かめずに戻す。同じ画面に弱い道を並べない。
3. **押せるかの判断は、一覧のときと実行のときの 2 回。**一覧は押せない操作を理由つきで出す（押せないまま見せる）。実行のときは要確認と取引（またはファイルの転記済み取引）を読み直して、もう一度 `resolveOptionsFor_` で確かめる ── メニューも選択肢を出す直前に読み直している（`menuResolveReview` の `currentLive`）。画面から来た操作コードは信用しない。
4. **1 押下＝1 件。**まとめて確定しない（転記行を空にする・ファイルを取り消すなど、取り消せない操作が多い。種類が少なく件数も少ない）。
5. **取込待ちへ戻す操作（承認して再検査など）は、戻すだけ。**取込は利用者が［記帳を実行］を押したときだけ（K-W23 と同じ）。定期取込は止めてある（K-W10）ので、メニューの確認文の「次回の定期取込（10 分以内）で再検査されます」は Web では言わない。
6. **監査ログで Web からの戻しを見分ける。**`applyResolveDecision_` が呼ぶ `rewindFileForReimportAudited_` に `reason` を渡せるようにする（`96` の 1 行、§3.5）。Web は `'WEBAPP'`、メニューは渡さない（`97` が `MENU` にする。K-W23 で入れた `context.reason || 'MENU'`）。
7. **顧客に差し戻す操作（`REJECT_COUNT_MISMATCH`・`RESIZE_INPUT`）は理由を処理ログに残す**（§3.4）。残さないと、ファイル一覧の【要修正】に「理由の記録はありません」と出る（K-W22 の表示）。メニューから差し戻した分は今のまま（変えない）。
8. **画面の置き場所：**取引先の表とその［選択した要確認を確定］は離さない。「その他の要確認」の一覧は右の列のいちばん下（最終確認の帯の下）に置き、上の帯（`#other-reviews`）は「いちばん下の一覧で確定します」と指す案内に変える。
9. 忙しさは今の `state.resolveBusy` を使う（取込・取引先の確定・形式の操作と同時に押せない。`isMutationBusy()`）。

**ロックを足さない理由：**`applyResolveDecision_` の中の部品（51・52）が、転記先へ書く前にリースを取る・リースの有無を確かめる（ファイル単位は `menuAssertNoLease_`）。2 人が同じ要確認を同時に押しても、後の方は `Review is already settled` か、Web 側の状態の確かめ（§3.3 の 4）で止まる。メニューと同じ守りであり、Web で弱めも強めもしない。

## 3. サーバー（`80_WebApp.gs`・`96_Menu.gs`）

### 3.1 共通の部品（新規・非公開）

`webAppListReviews` の近くに置く。

```
function webAppOtherReviewItem_(review)
```
メニューの `item` と同じ形を作る：`{kind: isTransactionScopedReviewType(review.reviewType) ? 'TRANSACTION' : 'FILE', reviewType: String(review.reviewType), customerId: String(review.customerId), customerName: review.customerName, merchantOriginal: review.merchantOriginal, reviews: [review]}`。

```
function webAppOtherReviewOptions_(item, role, live)
```
- `item.reviewType` が `INTEGRITY` か `FILE_CHANGED` なら `[]`。
- それ以外は `resolveOptionsFor_(item, role, live)` を呼び、§2 の 2 の規則で絞って返す（`PARTNER` は `code === 'EXCLUDE'` だけ残す、`FORMAT_UNKNOWN` は `code !== 'REGISTER_FORMAT'` だけ残す）。並びと `{code, label, enabled, disabledReason}` の形は `resolveOptionsFor_` のまま。

`role` は `webAppAuthorizeCustomer_` の `scope.rolesByCustomerId[customer.customerId]`。`live` は、取引単位なら取引（`webAppTransactionsById_` の値。`null` は渡さない ── §3.2・§3.3 で先に弾く）、ファイル単位なら `{liveTransactionCount: n}`（`n` は、そのファイルの有効な取引のうち状態が `PREPARED`・`WRITING`・`COMMITTED`・`REVIEW_REQUIRED` の数。メニューの `menuResolveReview` と同じ数え方）。

### 3.2 一覧：`webAppListReviews(customerId, limit, offset)` を広げる

今の戻り値（`reviews`・`partnerTotal`・`otherCounts`・`offset`・`limit`）は**形も中身も変えない**。足すもの：

1. 認可の戻り値を受け取る：`var selected = webAppAuthorizeCustomer_(customerId, 'WEBAPP:一覧')`、`role = selected.scope.rolesByCustomerId[selected.customer.customerId]`。
2. `openReviews({})` を回すとき（今と同じ 1 回）、この顧客の `PARTNER` 以外を 2 つに分ける：`INTEGRITY`・`FILE_CHANGED` は数えるだけ（`unsupportedCounts.integrity`・`unsupportedCounts.fileChanged`）、それ以外は「その他」の候補。`otherCounts` は今のまま（全部の種類を数える）。
3. 「その他」の並び：取引単位（`TRANSACTION`）が先、ファイル単位（`FILE`）が後。同じ中では `registeredAt` の古い順（`menuDateMilliseconds_`）、同じなら `reviewId` の文字列順。先頭から `WEBAPP_REVIEW_LIST_LIMIT_` 件だけ返す。`otherTotal` は絞る前の件数。
4. **取引の読取は今の 1 回に相乗りさせる。**今の `webAppTransactionsById_(pageReviews の fullTxId)` を、`pageReviews` と「その他」のうち取引単位の行の `fullTxId` を合わせた 1 回の呼出しにする（重複は関数が除く）。**取引先の要確認がある顧客では、取引単位の「その他」が増えても一覧の読取回数は今と同じ**（同じ 1 回に乗る）。取引先の要確認が 1 件も無い顧客は今は取引を読まない（`findRowsByColumnValues_` は探す値が空なら読まない）ので、取引単位の「その他」があるときだけ、その 1 回の分が増える（§6 の kw2 2）。
5. **ファイル単位の行があるときだけ**、その fileId 全部（重複なし）について、取引ログを 1 回でまとめて読む：`findRowsByColumnValues_(transactionLogSheet_(), 5, fileIds, TRANSACTION_LOG_WIDTH_)`。各行を `txLogFromRecord_` で読み、`active === true` かつ状態が上の 4 つのものを fileId ごとに数える。**読めない行（`txLogFromRecord_` が投げる）は数に入れる**（取消しを押せない側に倒す。実行のときは §3.3 がもう一度数える）。
6. 「その他」の 1 行（`otherReviews` の要素）：

| 鍵 | 値 |
|---|---|
| `reviewId` | 要確認 ID |
| `reviewType` | 種類のコード |
| `typeLabel` | `MENU_REVIEW_TYPE_LABELS_[reviewType]`（無ければコードのまま）── メニューと同じ名前 |
| `scope` | `'TRANSACTION'` か `'FILE'` |
| `fileId` | 文字列 |
| `fileName` | `menuDisplayFileName_(review) || '（ファイル名不明）'`（取引先の表と同じ） |
| `sourceRow` | 要確認行の元の行（空なら `null`） |
| `usageDate`・`amount`・`purpose` | 取引単位で取引が読めたときの `planned.b`・`planned.m`・`planned.i`。ほかは `null` |
| `merchantOriginal` | 取引単位：`webAppDisplayMerchant_(review.merchantOriginal || tx.originalMerchant || (tx.planned && tx.planned.k) || '')`。ファイル単位：`null` |
| `originalDate`・`originalAmount` | 要確認行の `originalDate`・`originalAmount`（明細に書いてあった値。空なら `null`） |
| `options` | `webAppOtherReviewOptions_` の結果（`{code, label, enabled, disabledReason}` の配列） |
| `problem` | 取引単位で取引が 1 件に定まらない（`webAppTransactionsById_` が `null`）とき `'TRANSACTION_MISSING'`、そのとき `options` は `[]`。ほかは `null` |

7. 取引先の表の行（`reviews` の要素）に `exclude: {enabled, disabledReason}` を足す。`webAppOtherReviewOptions_(webAppOtherReviewItem_(review), role, tx)` から **`code === 'EXCLUDE'` で探した**値（配列の先頭を決め打ちしない）。取引が読めない（`null`）ときは `{enabled: false, disabledReason: '（取引ログで取引を特定できません。管理者へ）'}`、`EXCLUDE` が見つからないとき（いまの表では起きないが、表を変えたときに一覧全体を落とさない）は `{enabled: false, disabledReason: '（この取引は画面から対象外にできません。管理者へ）'}`。ほかの鍵は変えない。
8. 足す戻り値：`otherReviews`（上の配列）・`otherTotal`・`unsupportedCounts: {integrity, fileChanged}`。

### 3.3 確定：`webAppResolveOtherReview(customerId, reviewId, code, inputs)`（新規・公開関数）

`webAppResolveReviews` の後に置く。`webAppInvoke_` で包む。手順はこの順で、**2〜7 のどこかで止まったときは、要確認・取引ログ・処理ログ・恒久索引・転記先・監査ログに 1 行も書かない**（認可の拒否で `denyAuthorization_` が書く `PERMISSION` の監査だけは今の決まりどおり）。

1. `var startedAt = Date.now();`
2. **認可**：`webAppAuthorizeCustomer_(customerId, 'WEBAPP:その他の要確認を確定')`（`ROLE.REVIEWER`。操作ごとの役割は 6 の `applyResolveDecision_` の中の `authorizeOperation` が見る）。
3. **要確認**：`getReviewById(String(reviewId))`。無ければ `{ok: false, code: 'REVIEW_NOT_FOUND'}`。`String(review.customerId) !== String(customerId)` なら `{ok: false, code: 'REVIEW_CUSTOMER_MISMATCH'}`。状態が `OPEN`・`IN_PROGRESS` でなければ `{ok: false, code: 'ALREADY_SETTLED'}`。種類が `INTEGRITY`・`FILE_CHANGED` なら `{ok: false, code: 'NOT_SUPPORTED'}`。
4. **いまの状態を読み直す**：`item = webAppOtherReviewItem_(review)`。ファイル単位なら `live = {liveTransactionCount: getTransactionsByStatus(String(review.fileId), [PREPARED, WRITING, COMMITTED, REVIEW_REQUIRED]).length}`。取引単位なら `tx = webAppTransactionsById_([review.fullTxId])[String(review.fullTxId)]`、`null` なら `{ok: false, code: 'TRANSACTION_MISSING'}`、そうでなければ `live = tx`。
5. **押せる操作か**：`webAppOtherReviewOptions_(item, role, live)` から `String(code)` と同じ `code` を探す。無ければ `{ok: false, code: 'OPERATION_NOT_OFFERED'}`。`enabled` が偽なら `{ok: false, code: 'OPERATION_DISABLED', message: option.disabledReason}`。
6. **入力**：`decisionInputs = {reviewId: review.reviewId}`。`code === 'FIX_DATE_AMOUNT'` のときだけ `inputs` を読む（ほかの操作では `inputs` を見ない・渡さない）：
   - `var date = parseCorrectedDate_(inputs && inputs.correctedDate, new Date())`、`var amount = parseCorrectedAmount_(inputs && inputs.correctedAmount)`（メニューと同じ関数。空なら `''`、形が悪ければ `null`）。
   - `date === null` → `{ok: false, code: 'INVALID_DATE'}`。`amount === null` → `{ok: false, code: 'INVALID_AMOUNT'}`。
   - 種類が `DATE` で `date === ''` → `{ok: false, code: 'DATE_REQUIRED'}`。種類が `AMOUNT` で `amount === ''` → `{ok: false, code: 'AMOUNT_REQUIRED'}`。（メニューの `menuResolveReview` と同じ決まり。）
   - 空でない値だけを `decisionInputs.correctedDate`・`decisionInputs.correctedAmount` に入れる。
7. **実行**：`var outcome = applyResolveDecision_(item, String(code), decisionInputs, {startedAt: startedAt, auditReason: 'WEBAPP'})`。
8. **差し戻しの理由**：`code` が `REJECT_COUNT_MISMATCH` か `RESIZE_INPUT` で `outcome.resolved === 1` なら、`recordError(String(review.fileId), {code: 'SOURCE_REQUIRES_CUSTOMER_FIX', detail: String(review.reviewType)})`。これが投げたら握りつぶさず、`errors` に `{code: 'REASON_NOT_RECORDED', message: '差し戻しの理由を処理ログに残せませんでした（ファイルは【要修正】になっています）。'}` を足して続ける（確定は済んでいるので、例外にして「失敗」と見せない）。
9. **返す**：

```
{ok: true, reviewId, code, label: option.label, reviewType, typeLabel, scope: item.kind,
 fileId: String(review.fileId), fileName: menuDisplayFileName_(review) || '（ファイル名不明）',
 resolved: outcome.resolved, committed: outcome.committed,
 unmetTexts: outcome.unmet.map(menuUnmetText_),
 completedFiles: outcome.completedFiles.filter(c => c && c.completed)
   .map(c => ({fileId: String(c.fileId), stateLabel: menuFileStateLabel_(c.state)})),
 rewound: outcome.rewoundFiles.length > 0,
 errors: outcome.errors.map(e => ({code: e.code || null, message: String(e.message || '')}))
   （8 の REASON_NOT_RECORDED を含む）,
 notAttempted: outcome.notAttempted, skippedByLease: outcome.skippedByLease}
```

`applyResolveDecision_` が投げた例外（ファイル単位のリース衝突 `LEASE_CONFLICT`・`CANCEL_FILE` の転記済み取引の `StateTransitionError` など）は、今の `webAppInvoke_` がメニューと同じ日本語にして投げ直す（変えない）。

### 3.4 差し戻しの理由を一覧に出す（`webAppCustomerFixReason_`）

`SOURCE_REQUIRES_CUSTOMER_FIX` の記録の `detail` が文字列で、`/^(COUNT_TOTAL_MISMATCH|INPUT_LIMIT)$/` に当たるときは `{source: 'REVIEW_RETURN', returnReason: <当たった語>}` を返す。この判定は、今の形式の差し戻し（`FORMAT_REVIEW`）の正規表現の**前**に置く。ほかの決まり（後ろから探す・`truncated` を飛ばす・`reasons` の配列）は変えない。

### 3.5 `96_Menu.gs` の `applyResolveDecision_`（1 行）

ファイルを取込待ちへ戻す呼出し

```
        rewindFileForReimportAudited_(fileId, auth.userEmail,
          {from: FILE_STATE.VALIDATING, operation: code, customerId: item.customerId});
```

の 2 行目を `{from: FILE_STATE.VALIDATING, operation: code, customerId: item.customerId, reason: options.auditReason});` にする。**96 で変えるのはこの 1 行だけ。**メニュー（`menuResolveReview`）は `auditReason` を渡さないので、メニューの監査は今のまま `MENU`。

## 4. 画面（`81_WebAppUi.html`）

### 4.1 呼出しの口と状態

- `gasCall` に `webAppResolveOtherReview`（引数 4 つ）の枝を足す。
- `state` に足す：`otherReviews: []`・`otherTotal: 0`・`unsupportedCounts: {integrity: 0, fileChanged: 0}`・`otherInputs: new Map()`（`reviewId` → `{code, correctedDate, correctedAmount}`。描き直しても選んだ操作と入力が残るように）。
- `loadReviews` の成功時に `otherReviews`・`otherTotal`・`unsupportedCounts` を入れる（無ければ `[]`・`0`・`{integrity: 0, fileChanged: 0}`）。`otherInputs` からは、新しい `otherReviews` に無い `reviewId` を消す。
- `chooseCustomer` で 4 つとも空に戻す（`partnerInputs` と同じところで）。

### 4.2 上の帯（`renderOtherReviews` を書き直す）

`#other-reviews` に出す文（どちらも 0 件なら何も出さない。今と同じ `.other-reviews` の箱 1 つに、文を続けて入れる）：
- `otherTotal > 0` のとき：`'その他の要確認が ' + otherTotal + ' 件あります（いちばん下の「その他の要確認」で確定します）。'`
- `unsupportedCounts` のどちらかが 1 以上のとき：`'整合性 ' + integrity + ' 件・ファイル変更 ' + fileChanged + ' 件は画面から確定できません（管理者へ連絡してください）。'`

今の「種類 n 件、…」「その他の要確認はメニューから確定してください。」「（中央のファイル一覧の［形式を確認］から扱えます）」の文は出さない（形式不明の案内は §4.3 の行に移る）。

### 4.3 「その他の要確認」の一覧（新規）

HTML：`#review-content` の中、`#final-summary` の後に足す。

```
<section id="other-review-section" class="other-review-section" aria-labelledby="other-review-heading" hidden>
  <h3 id="other-review-heading" class="subheading">その他の要確認 <span id="other-review-total">0</span> 件</h3>
  <div id="other-review-list"></div>
  <div id="other-review-more" class="muted"></div>
</section>
```

新しい id は `el` を作る一覧に足す。`renderReviews` の中から `renderOtherReviewList()` を呼ぶ。

`renderOtherReviewList()`：
- `#other-review-section` は `otherTotal === 0` のとき `hidden`。`#other-review-total` は `otherTotal`。
- `#other-review-list` に表（`table.review-table.other-review-table`）。見出しは `種類`・`内容`・`元ファイル`・`行`・`操作` の 5 列。行は `otherReviews` の順、`tr.dataset.reviewId`。
  - **種類**：`typeLabel`。
  - **内容**：
    - 取引単位：1 行目に `formatDate(usageDate, false) + ' / ' + formatAmount(amount) + ' / ' + merchantOriginal`（`purpose` があれば `' / ' + purpose` を続ける）。`DATE` で `originalDate` があれば `'明細の利用日: ' + originalDate`、`AMOUNT` で `originalAmount` があれば `'明細の金額: ' + originalAmount` を次の行に。`problem === 'TRANSACTION_MISSING'` なら `TEXT.otherTransactionMissing` を次の行に。
    - 最後に種類の説明（`TEXT.otherReviewHelp[reviewType]`、§4.6）を `.muted` の行で。
  - **元ファイル**：`appendDriveFileName(cell, fileId, fileName)`（取引先の表と同じ）。
  - **行**：`sourceRow`、無ければ `—`。
  - **操作**：
    - `select.other-op`：最初の選択肢は値 `''`・文字 `操作を選ぶ`。続けて `options` の順に、値 `code`・文字 `label`（押せないものは `label + ' ' + disabledReason`、`disabled = true`）。選んでいる値は `otherInputs` の `code`（押せない・無い操作なら `''`）。変えたら `otherInputs` に入れて描き直す。
    - 選んでいる操作が `FIX_DATE_AMOUNT` のときだけ、`input[type=date].other-date`（見出し `利用日`）と `input[type=text].other-amount`（`inputmode = 'numeric'`、見出し `金額`、`placeholder` は種類が `AMOUNT` なら `金額（必須）`、ほかは `変えないなら空欄`）を出す。打った値は `otherInputs` に入れる（打っている最中に描き直さない ── `input` で `state` に入れるだけ）。
    - `button.button.other-submit`（文字 `確定…`）。`disabled = isMutationBusy() || 選んでいる操作が無い・押せない`。押すと `resolveOtherReview(review)`。
    - 忙しいとき（`isMutationBusy()`）は `select`・`input` も `disabled`。
- `otherTotal > otherReviews.length` のとき `#other-review-more` に `'他 ' + (otherTotal - otherReviews.length) + ' 件（表示分を片付けると出てきます）'`。ほかは空。

### 4.4 押したとき（`async function resolveOtherReview(review)`）と取引先の［対象外…］

共通の流れを 1 つの関数（例：`runOtherReviewOperation(review, code, inputs, title, message, onResolved)`）にまとめてよい。

1. `isMutationBusy()` なら何もしない。
2. `resolveOtherReview`：`otherInputs` の `code` が `review.options` の押せる操作でなければ何もしない。`FIX_DATE_AMOUNT` のとき、種類が `DATE` で利用日が空なら `showNotice(TEXT.otherDateRequired, 'warning')`、種類が `AMOUNT` で金額が空なら `showNotice(TEXT.otherAmountRequired, 'warning')` を出して止める（サーバーを呼ばない。サーバーも同じことを確かめる）。
3. **確認**：`formatConfirm(option.label, 対象の文 + 効果の文)`。対象の文は、取引単位なら `'「' + typeLabel + '」' + fileName + ' ' + sourceRow + ' 行目（' + formatDate(usageDate, false) + '・' + formatAmount(amount) + '・' + merchantOriginal + '）。'`、ファイル単位なら `'「' + typeLabel + '」' + fileName + '。'`（`sourceRow` が無ければ `' … 行目'` を省く）。効果の文は §4.6 の `TEXT.otherEffect(code, inputs)`。取り消したら何もしない（サーバーを呼ばない・読み直さない）。
4. `var token = ++state.resolveRun`、`generation = state.viewGeneration`、`customerId = state.selectedCustomerId` を控え、`state.resolveBusy = true`、`clearNotice()`、`renderSelection()`。
5. `gasCall('webAppResolveOtherReview', [customerId, review.reviewId, code, inputs])`。`inputs` は `FIX_DATE_AMOUNT` なら `{correctedDate, correctedAmount}`（空は `''`）、ほかは `{}`。
6. 戻ったとき、`token`・`generation`・顧客が変わっていたら何もしない（`startResolve` と同じ守り）。変わっていなければ §4.5 のお知らせを出す。
7. `finally`（`token`・`generation` が今のままのときだけ）：`state.resolveBusy = false`、`markFinalReviewStale()`、`renderSelection()`、`loadReviews(customerId, state.reviewOffset, generation)`、`state.selectedFolderId` があれば `loadFiles(customerId, state.selectedFolderId, generation)`。**サーバーを呼んだときは、成功・失敗・例外のどれでも読み直す。**
8. `ok === true` かつ `resolved === 1` のとき、`otherInputs` からその `reviewId` を消す。

**取引先の表の［対象外…］：**
- `renderReviews` の見出しの最後に `操作` を足し、各行の最後に `button.button.partner-exclude`（文字 `対象外…`）。`disabled = isMutationBusy() || !(review.exclude && review.exclude.enabled)`、`title = review.exclude && review.exclude.disabledReason || ''`。押すと `excludePartnerReview(review)`。「該当なし」の行の `colSpan` は 8 → 9。
- `excludePartnerReview(review)`：上の 1・3〜7 と同じ流れで、`code = 'EXCLUDE'`・`inputs = {}`。確認は `formatConfirm('対象外にする', TEXT.partnerExcludeConfirm(review) + TEXT.otherEffect('EXCLUDE', {}))`。`ok === true` かつ `resolved === 1` のとき、`state.selectedReviewIds`・`state.partnerInputs` からその `reviewId` を消し、`state.lastSelectedReviewId` がそれなら `null` にする。**ほかの行の選択と入力は残す**（取引先の表で作業中の選択を消さない）。

### 4.5 お知らせ

- 例外：`showNotice(failureMessage(error), 'error')`。
- `ok === false`：種類 `warning`。文は `code` で引く：

| code | 文 |
|---|---|
| `REVIEW_NOT_FOUND` | `TEXT.reviewMissing`（今ある） |
| `ALREADY_SETTLED` | `TEXT.alreadySettled`（今ある） |
| `REVIEW_CUSTOMER_MISMATCH` | `TEXT.reviewMismatch`（今ある） |
| `NOT_SUPPORTED` | `この要確認は画面から確定できません。管理者へ連絡してください。` |
| `TRANSACTION_MISSING` | `TEXT.otherTransactionMissing` |
| `OPERATION_NOT_OFFERED` | `この操作はこの要確認では選べません。画面を再読み込みしてください。` |
| `OPERATION_DISABLED` | `'この操作は選べません' + (result.message || '') + '。'` |
| `DATE_REQUIRED` | `TEXT.otherDateRequired` |
| `AMOUNT_REQUIRED` | `TEXT.otherAmountRequired` |
| `INVALID_DATE` | `利用日の形が正しくありません（例: 2026-01-05。2000 年以降、今日から 1 年先まで）。` |
| `INVALID_AMOUNT` | `金額は整数で入力してください（1 億円未満）。` |
| その他 | `TEXT.unknownFailure`（今ある） |

- `ok === true` で `resolved === 1`：本文は `'「' + typeLabel + '」の要確認を確定しました（' + label + '）。'` の後に、操作ごとの文を続ける：
  - `FIX_DATE_AMOUNT`・`POST_ZERO_AMOUNT`・`POST_PRIOR_YEAR`：`committed > 0` なら `取引を確定しました。`、そうでなく `unmetTexts` があれば `'取引はまだ確定していません（' + unmetTexts[0] + '）。'`。
  - `EXCLUDE`・`EXCLUDE_PRIOR_YEAR`：`転記行を空にし、取引を対象外にしました。`
  - `CONFIRM_EMPTY_FILE`：`'「' + fileName + '」を完了にしました。'`
  - `APPROVE_COUNT_MISMATCH`・`APPROVE_SCAN_TRUNCATION`・`REGISTER_FORMAT`・`CONFIRM_DESTINATION_FIXED`：`rewound` なら `'「' + fileName + '」を取込待ちに戻しました。［記帳を実行］で取り込み直します。'`
  - `REJECT_COUNT_MISMATCH`・`RESIZE_INPUT`：`'「' + fileName + '」を【要修正】にしました。顧客に修正を依頼してください。'`
  - `KEEP_ORIGINAL_RESULT`：`'「' + fileName + '」を対象外にしました。元のファイルの結果は変わりません。'`
  - `CANCEL_FILE`：`'「' + fileName + '」を取り消しました。'`
  - そのあと `completedFiles` の各要素について `'ファイル「' + fileName + '」の要確認がすべて片付きました（' + stateLabel + '）。'`。
  - 種類は `errors` が空なら `success`、あれば `warning`。`errors` の `message` を箇条（`showNotice` の第 3 引数）で出す。
- `ok === true` で `resolved === 0`：種類 `warning`。`errors` があれば `この要確認は確定できませんでした。` と箇条、無くて `notAttempted > 0` なら `時間が足りず確定しませんでした。もう一度押してください。`、どちらでもなければ `TEXT.unknownFailure`。

### 4.6 文言（`TEXT` に足す）

- `otherDateRequired`：`利用日を入力してください。`
- `otherAmountRequired`：`金額を入力してください。`
- `otherTransactionMissing`：`この要確認の取引を取引ログで特定できません。管理者へ連絡してください。`
- `partnerExcludeConfirm(review)`：`'「' + review.merchantOriginal + '」（' + formatDate(review.usageDate, false) + '・' + formatAmount(review.amount) + '、' + (review.fileName || '（ファイル名不明）') + ' ' + review.sourceRow + ' 行目）を対象外にします。'`（`sourceRow` が無ければ `' … 行目'` を省く）
- `otherEffect(code, inputs)`：
  - `FIX_DATE_AMOUNT`：`入力した値だけを転記先の B列（利用日）・M列（金額）へ書いて確定します。` ＋（利用日があれば `'利用日: ' + 値 + '。'`）＋（金額があれば `'金額: ' + formatAmount(値) + '。'`）＋ `取り消せません（戻すには管理者の操作が必要です）。`
  - `POST_ZERO_AMOUNT`・`POST_PRIOR_YEAR`：`要確認を確定し、いまの転記行の内容をそのまま残します。取り消せません（戻すには管理者の操作が必要です）。`
  - `EXCLUDE`・`EXCLUDE_PRIOR_YEAR`：`転記行の B・F・I・K・M列と取引 ID を空にし、取引を対象外にします。取り消せません（戻すには管理者による再取込が必要です）。`
  - `CONFIRM_EMPTY_FILE`：`0 件で正しいことを記録し、ファイルを【完了】にします。転記先には何も書きません。取り消せません（戻すには管理者の操作が必要です）。`
  - `APPROVE_COUNT_MISMATCH`・`APPROVE_SCAN_TRUNCATION`・`REGISTER_FORMAT`・`CONFIRM_DESTINATION_FIXED`：`ファイルを取込待ちに戻します。［記帳を実行］で取り込み直し、そのときもう一度確かめます。戻すだけでは転記先に何も書きません。`
  - `REJECT_COUNT_MISMATCH`・`RESIZE_INPUT`：`ファイルを【要修正】にします。顧客に修正を依頼してください。直ったら中央の一覧の［修正済み → 取込待ちに戻す］で戻せます。`
  - `KEEP_ORIGINAL_RESULT`：`この新しいファイルを【対象外】にします。既に取り込んだ元のファイルの結果は変わりません。取り消せません（戻すには管理者の操作が必要です）。`
  - `CANCEL_FILE`：`ファイルを【取消済】にします。転記先に行はありません。取り消せません（戻すには管理者の操作が必要です）。`
- `otherReviewHelp`（種類 → 説明）：
  - `DATE`：`利用日が読めないか、ありえない日付です。正しい利用日を入れて確定するか、対象外にします。`
  - `AMOUNT`：`金額が読めません。正しい金額を入れて確定するか、対象外にします。`
  - `ZERO_AMOUNT`：`金額が 0 円です。0 円のまま計上するか、対象外にします。`
  - `PRIOR_YEAR`：`利用日が前年以前です（個人の顧客）。前年の利用分として計上するか、対象外にします。`
  - `PARTNER`：（使わない）
  - `FORMAT_UNKNOWN`：`カードの形式が分かりません。形式の登録は中央のファイル一覧の［形式を確認］から行います。ここではファイルの取消しだけできます。`
  - `FORMAT_AMBIGUOUS`：`2 つ以上の形式に当たります。形式を直してから再検査します（システム管理者）。`
  - `MULTI_SHEET`：`形式に当たるシートが 2 つ以上あります。形式を直してから再検査します（システム管理者）。`
  - `DUPLICATE`：`同じ内容（または使用用途だけ違う）のファイルが既に取り込まれています。`
  - `COUNT_TOTAL_MISMATCH`：`件数・合計が明細の読取結果と合いません。承認して取り込み直すか、顧客に差し戻します。`
  - `EMPTY_FILE`：`明細が 0 件です。0 件で正しければ完了にします。`
  - `INPUT_LIMIT`：`ファイルが大きすぎて処理できません。顧客に分割を依頼します。`
  - `DESTINATION_FIX`：`転記先シートの形が合いません。転記先を直してから再検査します（システム管理者）。`
  - `SCAN_TRUNCATED`：`空行の後にも明細らしい行があります。形式を直すか、打切りを承認して再検査します（システム管理者）。`
  - 無い種類：空（説明の行を出さない）。
- `customerFixReasonLines`：`source === 'REVIEW_RETURN'` を受ける（今は知らない `source` を「理由の記録はありません」にしている ── その判定に足す）。文は `COUNT_TOTAL_MISMATCH` → `件数・合計が明細と合わないため、顧客に確認を依頼しました`、`INPUT_LIMIT` → `ファイルが大きすぎるため、顧客に分割を依頼しました`、ほか → `returnReason` のまま。

文字はすべて `textContent`（`showNotice` も今どおり）。`innerHTML` 等は使わない。

## 5. 変えないこと

- メニュー（`menuResolveReview`・`resolveOptionsFor_`・`applyResolveDecision_` の 1 行以外・確認文・結果文）、`51`・`52`・`54`・`97`。
- 取引先の確定の道（`webAppResolveReviews`・`55` のまとめ確定・取引先の表の選択・一括入力・確認ダイアログ `openConfirmation`）。
- `webAppListReviews` の既存の戻り値（`reviews` の既存の鍵・`partnerTotal`・`otherCounts`・`offset`・`limit`）と、取引先の要確認だけの顧客での読取回数。
- 形式の画面（§15-8）、要修正を戻すボタン（K-W23）、取込、最終確認・Excel。
- 既存の確認ダイアログ（`formatConfirm`）とお知らせ（`showNotice`）の作り。

## 6. テスト（`kw2 N: …`）

サーバーは `test/phase8-webapp.test.js` の最後のテストの後へ（実物の世界：`setupWorld`・`putCsv`・`webImport`・`call` など）。画面は、ボタンを押せる既存のハーネス（`test/phase9-format-registration.test.js` の world、または `test/kw26-ui-helpers.js`）か `clientEval` で書く。どこに置いたか報告する。補助が要れば、そのテストファイルの中か、新しい `test/kw2-*.js` に置いてよい（`test/gas-stubs.js`・`test/gas-harness.js`・`test/fixtures/` は変えない）。メニューのテスト（`test/phase7-menu-operations.test.js`）の、種類ごとの要確認を作る補助（`setupFileReview` など）を参考にしてよい。

1. **kw2 1（一覧）**：日付の読めない行・金額 0 円の行・辞書に無い店の行を持つ CSV を取り込む → `webAppListReviews` の `reviews` は今どおり `PARTNER` だけ、`otherCounts` も今どおり。`otherReviews` に `DATE` と `ZERO_AMOUNT` の行があり、§3.2 の表の鍵がそろう（`typeLabel` はメニューの名前、`scope: 'TRANSACTION'`、`usageDate`・`amount`・`merchantOriginal` は取引の値、`problem: null`）。`options` は同じ要確認でメニューの `resolveOptionsFor_` が返すものと同じ（`DATE` は `FIX_DATE_AMOUNT`・`EXCLUDE`、`ZERO_AMOUNT` は `POST_ZERO_AMOUNT`・`EXCLUDE`）。取引先の行に `exclude: {enabled: true, disabledReason: null}`。`otherTotal`・`unsupportedCounts: {integrity: 0, fileChanged: 0}`。
2. **kw2 2（一覧の読取）**：`webAppListReviews` 1 回の Sheets 読取（`batchGet`）を測る。(a) 取引先の要確認だけの顧客 ── **直す前に測った値と同じ**であること（直す前の値を報告に書く）。(b) 取引先の要確認と取引単位の「その他」がある顧客 ── (a) と同じ。(c) 取引単位の「その他」だけの顧客（取引先の要確認なし）と (d) ファイル単位の要確認もある顧客 ── それぞれ測った値そのものを上限に固定し、直す前の同じ世界の値との差を報告する。
3. **kw2 3（日付を直す）**：`DATE` の要確認を `FIX_DATE_AMOUNT`・利用日 `2026-01-05` で確定 → `ok: true`・`resolved: 1`。**複製**の転記行の B列が新しい利用日、**雛形の同じ行番号は変わらない**。要確認は解決済み。ほかに開いた要確認が無ければ取引は `COMMITTED`・`committed: 1`、取引先の要確認が残っていれば `committed: 0` で `unmetTexts` に「取引先が未解決」。
4. **kw2 4（入力の検査）**：`DATE` に利用日なし → `DATE_REQUIRED`、`2026-02-30` → `INVALID_DATE`、`AMOUNT` に金額なし → `AMOUNT_REQUIRED`、`12a` → `INVALID_AMOUNT`。どれも要確認・取引ログ・転記先・監査ログが呼ぶ前と同じ。`FIX_DATE_AMOUNT` 以外の操作に `inputs` を渡しても使われない（転記先の B・M 列が変わらない）。
5. **kw2 5（0 円・対象外）**：`ZERO_AMOUNT` を `POST_ZERO_AMOUNT` で確定 → 転記行はそのまま。別の `ZERO_AMOUNT`（または `DATE`）を `EXCLUDE` → 複製の転記行の B・F・I・K・M 列と取引 ID が空、取引は `CANCELED`、雛形は変わらない。
6. **kw2 6（前年）**：個人の顧客で `PRIOR_YEAR` を立て、`POST_PRIOR_YEAR` と `EXCLUDE_PRIOR_YEAR` をそれぞれ確定 → メニューで同じ操作をしたときと同じ結果（転記行・取引の状態・要確認の状態）。
7. **kw2 7（取引先の対象外）**：取引先の要確認を `EXCLUDE` で確定 → 転記行が空・取引 `CANCELED`・要確認は閉じる。同じ顧客の別の取引先の要確認は開いたまま。取引先の要確認に `ADOPT_EXISTING_PARTNER`・`RESOLVE_WITHOUT_PARTNER` を送る → `OPERATION_NOT_OFFERED`、何も書かない。
8. **kw2 8（押せない操作）**：取引の freee 取込状態を取込済みにすると、一覧の `EXCLUDE` は `enabled: false`・メニューと同じ理由（取引先の行の `exclude` も同じ）。呼ぶと `OPERATION_DISABLED` と同じ理由、何も書かない。
9. **kw2 9（0 件のファイル）**：見出しだけの CSV を取り込む → `EMPTY_FILE`。一覧で `scope: 'FILE'`・`options` が `CONFIRM_EMPTY_FILE`・`CANCEL_FILE`。`CONFIRM_EMPTY_FILE` → ファイルが `COMPLETED`、転記先は変わらない。
10. **kw2 10（重複）**：同じ中身のファイルを 2 本取り込む → 2 本目に `DUPLICATE`。`KEEP_ORIGINAL_RESULT` → 2 本目が対象外（`EXCLUDED`）、1 本目の取引と転記行は変わらない。もう 1 組で `CANCEL_FILE` → 取消済。
11. **kw2 11（件数・合計）**：`COUNT_TOTAL_MISMATCH` の要確認（実物の取込で作れなければ、メニューのテストと同じ作り方でよい）。`APPROVE_COUNT_MISMATCH` → ファイルが取込待ち（`DISCOVERED`）、承認が残る（`hasCategory2Approval`）、`rewound: true`、**戻しの監査の `reason` が `WEBAPP`**。別の組で `REJECT_COUNT_MISMATCH` → `CUSTOMER_FIX_REQUIRED`、処理ログに `SOURCE_REQUIRES_CUSTOMER_FIX`（`detail: 'COUNT_TOTAL_MISMATCH'`）、`webAppListFolder` のそのファイルの `fixReason` が `{source: 'REVIEW_RETURN', returnReason: 'COUNT_TOTAL_MISMATCH'}`。
12. **kw2 12（形式不明）**：`FORMAT_UNKNOWN` の行の `options` は `CANCEL_FILE` だけ。`REGISTER_FORMAT` を送る → `OPERATION_NOT_OFFERED`、ファイルの状態・要確認は変わらない。`CANCEL_FILE` → 取消済。
13. **kw2 13（役割）**：オーナーでない確認担当者（その顧客の `reviewers` だけに居る人）では、管理者の操作（例：`DESTINATION_FIX` の `CONFIRM_DESTINATION_FIXED`）が `enabled: false`・`（システム管理者のみ）`、呼ぶと `OPERATION_DISABLED`。オーナーでは押せる。
14. **kw2 14（転記済みの取引があるファイルの取消し）**：転記済みの取引を持つファイルにファイル単位の要確認がある → 一覧の `CANCEL_FILE` が `enabled: false`・メニューと同じ理由。呼ぶと `OPERATION_DISABLED`。
15. **kw2 15（守り）**：無い `reviewId` → `REVIEW_NOT_FOUND`。別の顧客の要確認 → `REVIEW_CUSTOMER_MISMATCH`。確定済み → `ALREADY_SETTLED`。`INTEGRITY`・`FILE_CHANGED` → `NOT_SUPPORTED`。取引ログに取引が無い取引単位の要確認 → `TRANSACTION_MISSING`。認可の無い顧客 → 投げる（`PERMISSION` の監査は今の決まりどおり 1 行）。どれも要確認・取引ログ・処理ログ・恒久索引・転記先は呼ぶ前と同じ、`REVIEW_RESOLVE` の監査は増えない。
16. **kw2 16（リース）**：ファイルにリースがある → ファイル単位の操作は投げる（メッセージはメニューのリース衝突と同じ日本語）、取引単位の操作は `errors` に `LEASE_CONFLICT`・`resolved: 0`。どちらも何も書かない。
17. **kw2 17（数えるだけの種類）**：`INTEGRITY`・`FILE_CHANGED` は `unsupportedCounts` に数えられ、`otherReviews` に出ない。`otherCounts` には今どおり出る。
18. **kw2 18（メニューは変わらない）**：`applyResolveDecision_` を `auditReason` なしで呼んで取込待ちへ戻すと、監査の `reason` は `MENU`。
19. **kw2 19（実行の読取）**：`FIX_DATE_AMOUNT` 1 件と `CONFIRM_EMPTY_FILE` 1 件の `webAppResolveOtherReview` 1 回の Sheets 読取を測り、**測った値そのものを上限**に固定する。値は報告に書く。
20. **kw2 20（帯と一覧の描画）**：「その他」が 0 件なら `#other-review-section` は `hidden`、帯は空。あるとき、帯の文が §4.2 のとおり、一覧の行が §4.3 のとおり（種類・内容・元ファイルの Drive の印・行・操作の選択肢。押せない操作は `disabled` で理由つき）。`FORMAT_UNKNOWN` の行に説明。`unsupportedCounts` の文。`otherTotal` が多いときの「他 n 件」。
21. **kw2 21（選択と入力）**：`FIX_DATE_AMOUNT` を選ぶと利用日・金額の欄が出る、ほかの操作では出ない。描き直しても選んだ操作と打った値が残る。押せる操作を選ぶまで［確定…］は押せない。忙しいときは全部 `disabled`。
22. **kw2 22（押す）**：確認で取り消す → サーバーを呼ばない・読み直さない。確認で実行 → `[顧客ID, reviewId, code, inputs]` で 1 回呼ぶ（`FIX_DATE_AMOUNT` は `{correctedDate, correctedAmount}`、ほかは `{}`）。呼んでいる間は忙しい、終わると忙しくない。お知らせが §4.5 の文（`success`）、その後に要確認とファイル一覧を 1 回ずつ読み直す、最終確認は古い扱い。`DATE` で利用日が空なら確認を出さずに `warning`。
23. **kw2 23（失敗）**：§4.5 の `ok: false` の各 code の文（`warning`）、`errors` つき成功（`warning` と箇条）、`resolved: 0`、例外（`error`）。どれも終わった後は忙しくなく、読み直す。
24. **kw2 24（取引先の［対象外…］）**：取引先の各行にボタン、`exclude.enabled` が偽なら `disabled` で `title` が理由。押す → 確認文が §4.6 のとおり → `code: 'EXCLUDE'`・`inputs: {}` で 1 回呼ぶ。成功で、その行だけ選択と入力から消え、ほかの行の選択と入力は残る。失敗では消えない。「該当なし」の行の `colSpan` が 9。
25. **kw2 25（安全な描き方）**：**振る舞いで確かめる。**`typeLabel`・`fileName`・`merchantOriginal`・`purpose`・`originalDate`・`disabledReason`・`label` に `<img src=x onerror=alert(1)>` のような文字を入れた「その他」の行と取引先の行を描き、確認ダイアログとお知らせまで通す → どれも文字のまま出て、`img` 要素が 1 つも作られない。**phase9 のファイルの中で関数のソースの文字列を調べないこと**（既存の `fmt 102` がそれを禁じている）。ソースの静的な検査（`innerHTML`・`insertAdjacentHTML`・`outerHTML`・`document.write` が足した関数に無い）も置くなら、`test/phase8-webapp.test.js` の `cf 18`・`rc 12` と同じ形（`WEBAPP_UI_SOURCE`）で phase8 に置く。
26. **kw2 26（理由の表示）**：`customerFixReasonLines` が `REVIEW_RETURN` の 2 つの語を §4.6 の文にする。知らない `returnReason` はそのまま。

## 7. 変異（R1〜R24）── それぞれ赤になるテストを記録する

- R1：`webAppResolveOtherReview` で押せる操作か（§3.3 の 5）の確かめを消す（画面の code をそのまま実行）
- R2：実行のときに状態を読み直さず、`live` を `{liveTransactionCount: 0}`・空の取引にする
- R3：顧客の一致の確かめを消す
- R4：要確認の状態（`OPEN`・`IN_PROGRESS`）の確かめを消す
- R5：`PARTNER` の絞り込みを消す（採用・取引先なしも通る）
- R6：`FORMAT_UNKNOWN` から `REGISTER_FORMAT` を外さない
- R7：`DATE` の利用日必須の確かめを消す
- R8：`FIX_DATE_AMOUNT` 以外にも `inputs` の訂正値を渡す
- R9：`auditReason: 'WEBAPP'` を渡さない
- R10：`96` で `options.auditReason` を渡さない（常に `MENU`）
- R11：差し戻しの理由（§3.3 の 8）を書かない
- R12：`webAppCustomerFixReason_` の `REVIEW_RETURN` を消す
- R13：一覧で取引の読取を相乗りさせず、「その他」の分を別に `webAppTransactionsById_` で読む
- R14：一覧の転記済み取引の数え上げ（§3.2 の 5）を、取引単位の行のファイルにもかける（ファイル単位の行が無くても取引ログを読む）
- R15：一覧の読めない行を数に入れない
- R16：`INTEGRITY` を「その他」の一覧に出す
- R17：一覧の並び（取引単位が先）を逆にする
- R18：画面で確認を出さずにサーバーを呼ぶ
- R19：成功の後にファイル一覧を読み直さない
- R20：`finally` を外す（例外のとき忙しいまま残る）
- R21：取引先の対象外の成功で、選択を全部消す
- R22：［確定…］を押せない操作のときも押せるようにする
- R23：`markFinalReviewStale()` を呼ばない
- R24：`OPERATION_DISABLED` のお知らせに理由を出さない

## 8. 受入（実機）

0. push の前後で `clasp pull` を比べる（いつもの手順）。push 直後に `opsShowLeases` が `(リースなし)`。
1. F5 で開き直し、TEST01 を選ぶ。上の帯に「その他の要確認が 5 件あります（…）」（2026-10-17 時点の形式不明 5 件）、右の列のいちばん下に「その他の要確認 5 件」の一覧が出る。各行の操作は「このファイルを取り消す」だけで、説明に［形式を確認］の案内がある。**これらはテスト用のファイルなので確定しない**（ko-ch さんの指示：放置）。
2. 取引先の要確認があるとき（2026-10-17 時点の本番は 0 件）、取引先の表の各行に［対象外…］が出る。押すと確認が出る ── **［戻る］で閉じる**（実際の帳簿の行を空にしない）。
3. 実際に確定するのは、次に取引先以外の要確認が本当に立ったとき（その種類と結果を本書に追記する）。

**受入の結果（2026-10-18）：**
- 0：2026-10-17 19:00 `56e8310`・`gas-push-119`。push 前の pull は gas-push-118・HEAD~ と 56/56 一致（HEAD との差は 80・81・96 だけ）、push 後の pull は HEAD と 56/56。push 直後の `opsShowLeases` は `(リースなし)`。
- 1：**合格。**ko-ch さんの画面（10-18 16:20 のスクリーンショット）で、上の帯が「その他の要確認が 5 件あります（いちばん下の「その他の要確認」で確定します）。」、いちばん下に「その他の要確認 5 件」（AU202511・au202509・au202510・enavi202509(6269)・meisai202504、どれも形式不明）。各行の操作は「このファイルを取り消す（【取消済】にする）」だけ、説明に［形式を確認］の案内。1 行目で操作を選んだ状態だったが確定はしておらず、直後の `opsCountReviewsByType` は `FORMAT_UNKNOWN=5` のまま。
- 2：取引先の要確認が 0 件なので見ていない（表は「確定が必要な要確認はありません。」）。
- **見つけた別の不具合（K-W2 の前から、10-03 の一括編集から）：**取引先の要確認が 0 件でも［前の 500 件］［次の 500 件］が出る。`.pager { display: flex; }` が `hidden` 属性を打ち消している（10-12 に直した `.progress-arrows` と同じ形）。直しは `.pager[hidden] { display: none; }` の 1 行。`hidden` で隠す要素のうち、`display` を指定しているのは `.pager` だけ（10-18 に確かめた）。**ko-ch さんの指示（10-18）で直した：**`spec_webapp.md` 2.9.1、テスト `ui 6`（`gas-push-120`）。

## 9. Codex 1 回目の停止への回答（2026-10-17、1.1）

- **停止は正しい。**1 回目は実装と kw2 1〜26 まで進み、追加 26 本は緑、既存 `fmt 102`（phase9 のファイルが関数のソースの文字列を調べないこと）だけが赤で止まった。原因は kw2 25 が phase9 で `source.includes(…)` を使ったこと。**1.0 の kw2 25 は「`textContent` だけを使う」とだけ書き、置き場所の決まり（`fmt 102`）に触れていなかった ── 仕様の書き落としである。**1.1 で kw2 25 を「振る舞いで確かめる」に改め、静的な検査を置くなら phase8 の `cf 18`・`rc 12` の形にすると決めた（§6 の 25）。
- 1 回目の差分を読んだ（私の監査の前段）。仕様どおりで、直す不具合は無かった。足すのは次の 3 つ：
  1. 取引先の行の `exclude` を `code === 'EXCLUDE'` で探し、見つからないときの逃げ道を置く（§3.2 の 7）。
  2. **書き方を周りに合わせる（振る舞いは変えない）。**`81` の足した描画・押下の関数は、すぐ隣の `renderReviews` と同じく 1 行に 1 文（`var a = …; a.b = …; c.appendChild(a);` のように 1 行に詰めない）。`80` の足した行は周りと同じく 100 文字前後で折る。足した関数（`webAppOtherReviewItem_`・`webAppOtherReviewOptions_`・`webAppResolveOtherReview`・`renderOtherReviewList`・`runOtherReviewOperation`・`showOtherReviewResult`）に、周りと同じ語り口の短いコメント（「なぜ」── たとえば、なぜメニューの部品を使うのか・なぜ実行のときに読み直すのか・なぜ PARTNER と FORMAT_UNKNOWN だけ絞るのか）を付ける。
  3. 1 回目で読取を測った値（kw2 2：(a) 6→6、(b) 6→6、(c) 4→6、(d) 4→7、kw2 19：日付を直す 34・0 件の確認 14）は変えない。kw2 19 の 34 回のうち、`applyResolveDecision_` の中で使った回数を報告する（Web が足した読取の大きさを知るため。上限は変えない）。

## 10. 実装と監査の記録（2026-10-17）

- Codex 1 回目（`tools/codex-logs/*-20261017-180227-*`）：開始 1601/1601。実装と kw2 1〜26（直す前は kw2 18 だけ緑）。追加 26 本は緑、既存 `fmt 102` だけ赤で正しく停止（§9）。
- Codex 2 回目（仕様書 1.1・指示書 `work/codex_prompt_webapp_other_reviews_2.txt`）：kw2 25 を振る舞いの検査へ（phase9 の DOM ハーネスで、`<img …>` を入れた文字が一覧・確認・お知らせに文字のまま出て `img` が作られない。静的な検査は既存の `rc 12` が画面全体を見ている）、`exclude` の逃げ道と kw2 27、書き方の直し。終了 1628/1628。R1〜R24 はすべて赤（各回の後に 5 ファイルの SHA-256 一致）。
- 読取（測った値そのものを上限に固定）：一覧 (a) 取引先だけ 6→6、(b) 取引先＋取引単位のその他 6→6、(c) 取引単位のその他だけ 4→6、(d) (c)＋ファイル単位 4→7。確定 1 件：日付の修正 34（`applyResolveDecision_` の中 30・外 4）、0 件の確認 14（中 11・外 3）。**Web が足した読取は 3〜4 回で、残りはメニューから同じ操作をしても払う分。**
- 監査（私）：src の差分は 80・81・96 だけ（96 は `reason: options.auditReason` の 1 行）、ほかの src・test は開始時の md5 と一致、改行は LF のまま（CR 0）、97 の NUL 2、`???` 0、新しい関数名の重複なし。差分を読んで仕様どおりと確認（直す不具合なし）。
- **私の変異 X1〜X12 のうち 9 個（X1・X2・X6〜X12）がすり抜けた → テストを 5 本足して全部赤に：**`kw2 28`（`FORMAT_UNKNOWN` だけが `REGISTER_FORMAT` を失う ── 絞り込みを全種類にかけても気付かなかった）、`kw2 29`（一覧の上限・`otherTotal`・登録順の並び）、`kw2 30`（取引が特定できない取引先の行は対象外にできない）、`kw2 31`（失敗しても打った値が残る・`AMOUNT` は金額が必須・訂正値を打った後でほかの操作に替えたら訂正値を送らない）、`kw2 32`（確認文を全操作ぶん）。初めから赤だったのは X3・X4（役割の固定 → `kw2 13`）と X5（差し戻しの理由の語 → `kw2 11`）。変異の道具は `%TEMP%\claude\kw2\mut.js`（1 か所置換 → kw2 だけ回す → バイトで戻して md5 で確かめる）。終了 1633/1633。
- **残したこと（直さない。低）：**取込は要確認行の `originalDate`・`originalAmount`（S・T 列）を埋めていない（`makeReviewRow_` に渡す取込の要確認に、その鍵が無い）。だから一覧の「明細の利用日／明細の金額」の行は、今の取込では出ない（害は無い）。元の値は、一覧のファイル名のリンクと行番号から元ファイルで見る（メニューも元の値を出していない）。取引ログの元の値（`originalDate`）を使う形にすると、日付に見える文字がシートで日付のシリアル値になって読めることがあり、表示の作りが要るので、要るときに別に扱う。

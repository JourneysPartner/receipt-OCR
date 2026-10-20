# 画面の確定の固定費を削る（同じ読取の重複だけ） 仕様書

版：1.2（2026-10-20。1.0 は既存の `bulk 16` が「衝突しなかったファイルには掃除を呼ぶ」ことまで期待しているのを見落としていた ── Codex の指摘で 1.1 に §6 の冒頭の 1 か所を足した。1.2 は同じ形の `webapp 23` を足した ── これも Codex の指摘。全テストを回してぶつかるのはこの 2 本だけ）
対象：`src/80_WebApp.gs`（`webAppResolveReviews`）・`src/55_PartnerBatchResolution.gs`（`resolvePartnerReviewsBatch` の戻り値に 1 項目）。
発端：2026-10-03 の受入で、少数の要確認が多くのファイルに散ると、画面の確定が 1 ファイル約 25 秒かかった（9 件・6 ファイルで約 2.5 分。`PARTNER_BATCH` は 1 ファイル 10〜12 読取・11〜22 秒）。

## 1. 背景（2026-10-20 にハーネスで測った）

`webAppResolveReviews` で 6 ファイル各 1 件を確定すると、Sheets の読取（`batchGet`）が 147 回・書込が 37 回。押下の固定が 6 読取、**1 ファイルあたり 27 読取**。1 ファイルの読取を呼出し元ごとに数えると、同じものを何度も読んでいる：

| 読むもの | 回数（1 ファイル） | どこで |
|---|---|---|
| 取引ログのそのファイルの取引（`getTransactionsForFile_`、1 回 2 読取＝E 列＋行） | 4 回＝8 読取 | 80 の確定の前（学習の判定と文言のため）・55 の部品（リースの後）・97 の `commitSettledTransactions_`・`isFileFullyResolved`（`completeFileIfFullyResolved_` の中） |
| 要確認の表 | 3 回 | 55 の頭・55 のロックの中（`allReviewRecordsAndAuditTail_`）・`commitSettledTransactions_` の `openReviews` |
| リース表 | 4 回 | `acquireLease`・`assertLeaseHeldForWrite`（K-W21 の柵）・解放・`completeFileIfFullyResolved_` |

**利用者の決定（2026-10-20）：**同じ読取の重複だけ削る。後始末（確定済みの反映とファイルの完了）を部品の中へまとめる案は採らない。

## 2. 決めたこと

**削らないもの：**部品のリースの後の取引の読取、ロックの中の読み直し（取引の行・要確認＋監査末尾・状態遷移の組）、読取確認、リースの確かめ（K-W21）、`completeFileIfFullyResolved_`（完了の判定はいつも新しく読む）。これらは二重書きと状態の取り違えを防ぐ土台である。

**削るもの（2 つ）：**

- **D1：80 の確定の前の取引の読取を、押下で 1 回にする。**今はファイルごとに `getTransactionsForFile_(fileId)`（2 読取）を呼ぶ。使い道は (a) 学習するか（`isCardNamePartnerPurpose(customer, tx.planned.i)`）と (b) `STATE_TRANSITION` の文言に出す取引の状態だけで、どちらもリースの前に読んだ値で今も決めている（書く判断は部品がリースの後に読み直した値で行う）。押下の頭で、確定するファイル全部の取引を `findRowsByColumnValues_` 1 回（2 読取）で読めば、読む時点も使い道も今と同じで、ファイルの数に比例しなくなる。
- **D2：孤児の確定の掃除（`commitSettledTransactions_`）を、掃除するものが無いと分かっているファイルでは呼ばない。**掃除の対象は「`REVIEW_REQUIRED` のまま、開いた要確認が 1 件も無い取引」（要確認は解決済みなのに確定が走らなかった取引。K-W19 (a)）である。部品はロックの中で、リースを持ったまま読んだそのファイルの全取引と、ロックの中で読んだ要確認の表を手元に持っている。そこから「この呼出しが終わった時点の掃除の対象の数」を数えて返し（§3）、80 は**ファイルの最後の部品の呼出しが 0 と言ったときだけ**掃除を呼ばない。数えられなかった（ロックの段まで進まなかった・例外）なら今どおり呼ぶ。
  - **安全の理由：**掃除は候補を選んだ後、1 件ずつ `commitIfConditionsMet`（取引と要確認を新しく読んで判定する）で確定する。候補の選び方が古くても、誤って確定することはない。呼ばないのは 0 件のときだけで、そのとき呼んでも何も確定しない（呼出しの間の秒単位の間に別の経路が孤児を作った場合だけ、次の確定・運用の掃除まで遅れる ── 今も同じ間が呼出しの直後に開いている）。
  - 完了（`completeFileIfFullyResolved_`）は今どおり毎回呼ぶ。掃除が 0 件なら、掃除の有無で完了の判定は変わらない。

**見込み：**1 ファイル 27 → 22 読取（D1 で −2、D2 で −3。押下では D1 の 2 読取が 1 回増える）。6 ファイル各 1 件で 147 → 約 119。実機の 1 ファイル約 25 秒が 20 秒前後。

## 3. 55（`resolvePartnerReviewsBatch`）

戻り値に `followUp` を足す。**振る舞い（書くもの・順番・判定）は一切変えない。**

- 既定は `result.followUp = null`。
- ロックの中の段（要確認・監査・確定を書く `withScriptLock_`。今の 506 行）を最後まで通ったときだけ、その段の終わりで次を入れる：
  `result.followUp = {orphanCandidates: N}`。
- `N` の数え方（すべて手元の値。**新しく読まない**）：
  1. 対象の取引：リースの後に読んだ `fileTransactions`（今の 288 行）のうち `active === true` で `transactionStatus === TX_STATUS.REVIEW_REQUIRED` のもの。
  2. そこから、この段で確定した取引（`commitUpdates` のうち `item.failed` でないもの）を除く。
  3. 開いた要確認：ロックの中で読んだ `currentReviews` のうち `status` が `OPEN`・`IN_PROGRESS` のもの。**ただしこの段で `RESOLVED` を書いた要確認（`openNow` のすべて。後で失敗した件も、要確認はもう書いた）は開いていない扱い。**
  4. `N` ＝ 2 の取引のうち、3 の要確認が 1 件も指していない（`String(review.fullTxId) === String(tx.fullTxId)` が無い）取引の数。`fullTxId` は文字列にして比べる。
- `PARTNER_BATCH` のログに `orphanCandidates`（`followUp` が無ければ `null`）を足す。
- これは `commitSettledTransactions_`（97）が同じ時点で数える `candidates` と同じ定義である（取引は `getTransactionsByStatus(fileId, [REVIEW_REQUIRED])`、開いた要確認は `openReviews({fileId})`）。違いは「読む時点がロックの中か直後か」だけ。

## 4. 80（`webAppResolveReviews`）

### 4.1 D1：取引を押下で 1 回読む

- ファイルのまとまり（`fileGroups`）を作った直後に、`fileGroups` のすべての `fileId` で `findRowsByColumnValues_(transactionLogSheet_(), 5, fileIds, TRANSACTION_LOG_WIDTH_)` を 1 回呼び、`txLogFromRecord_` で写して `active` のものだけ残し、ファイルごとの `txsById`（今と同じ形：`fullTxId` → 配列）を作る。`fileGroups` が空なら読まない。
- 読取が投げたら、今のファイルごとの読取の失敗と同じく、**すべての** まとまりの決定を `webAppDecisionError_(outcome, reviewId, code, menuOperationErrorMessage_(error))` にして（件数を `attemptedCount` に足す）、部品を呼ばずに今の終わり方（`outcome.remaining = outcome.notAttempted` を入れて返す）をする。
- ファイルの中の `getTransactionsForFile_(fileId)` の呼出しは消す。`txsById` の使い道（`learn` の判定・`webAppResolveErrorMessage_`）は変えない。
- 門（`partnerBatchMayStart_`）・`fileStartedAt` の測り方は今のまま（読取が押下の頭に移るだけ）。

### 4.2 D2：掃除を呼ぶかどうか

- ファイルごとに `followUpKnown`（初め `true`）と `orphanCandidates`（初め `null`）を持つ。
- 部品の呼出しが返るたび：`componentResult.followUp` が `{orphanCandidates: 0 以上の整数}` なら `orphanCandidates` をその値で**上書き**する（最後の呼出しが勝つ）。そうでなければ `followUpKnown = false`。部品が投げた（`componentError`）ときも `followUpKnown = false`。
- 後始末（`fileTouched && !leaseConflict` のとき）：`followUpKnown && orphanCandidates === 0` なら `commitSettledTransactions_` を**呼ばない**（`outcome.deferredCommits` は足さない）。それ以外は今どおり呼ぶ。`completeFileIfFullyResolved_(fileId, {readLeases: activeLeases_})` は今どおり**いつも**呼ぶ。
- 返す形（`outcome` の項目）は変えない。

## 5. 変えないこと

- 部品の判定・書込・順番、`commitSettledTransactions_`・`completeFileIfFullyResolved_`・`isFileFullyResolved`・`commitIfConditionsMet`（97・50）。
- 運用の自動採用（`opsAutoAdoptPartners`、97 の 299 行）とメニューの確定（`applyResolveDecision_`）、K-W2 の `webAppResolveOtherReview`。部品の戻り値に `followUp` が増えるだけで、これらは読まない。
- 画面（81）。

## 6. テスト（`fc N: …`、`test/phase8-webapp.test.js` の最後のテストの後）

**既存の期待を変えてよいのは 1 か所だけ（1.1）：**`bulk 16`（リース衝突したファイルには後始末を掛けない）の `assert.deepEqual(cleanups.commit, [seeded.fileIds[1]])` を `assert.deepEqual(cleanups.commit, [])` にする。2 本目のファイルは要確認を全部確定して孤児が無いので、D2 で掃除を呼ばない ── 変わるのは D2 そのものである。テストの目的（衝突したファイルには掃除も完了も掛けない・`cleanups.complete` は `[seeded.fileIds[1]]` のまま）は変えない。直す行のすぐ上に、理由を 1 行のコメントで書く（「孤児の無いファイルは D2 で掃除を呼ばない（spec_resolve_fixed_cost §4.2）」）。ほかの既存の期待は 1 つも変えない。

**`webapp 23`（1.2）：期待は変えず、テストの準備だけ足す。**このテストの目的は「画面から送られた掃除の上限（`maxOrphanCommits`）を無視し、掃除を `fileId` 1 つで呼ぶ」ことで、掃除が呼ばれる前提に立っている。D2 で孤児 0 件の掃除が飛ぶと、`commitArgumentCount` が `null` のまま赤になり、目的が確かめられない。そこで `withMocks` に `resolvePartnerReviewsBatch` を足し、本物を呼んだ戻り値の `followUp` を `null` にして返す（＝数えられなかった形。§4.2 で掃除を今どおり呼ぶ）。足す行のすぐ上に理由のコメントを 1 行（「D2 で掃除が飛ばないよう、数えられなかった形にする（spec_resolve_fixed_cost §6）」）。assert は 1 つも変えない。

1. **fc 1（読取の回数）**：(a) 6 ファイル各 1 件、(b) 1 ファイル 1 件、(c) 3 ファイル各 10 件（`bulk 3` と同じ形）で `webAppResolveReviews` の Sheets 読取を測る。**作る前の値と作った後の値を報告し、作った後の値そのものを上限にする。**(a) は作る前が 147 のはず（違えば報告）。
2. **fc 2（取引を読む回数）**：(a) の形で、`getTransactionsForFile_` の呼出しが 80 から 0 回・全体でファイルあたり 2 回（部品と完了の判定）、`findRowsByColumnValues_` の取引ログへの呼出しが押下で 1 回。
3. **fc 3（学習の判定は今と同じ）**：カード名を用途にする取引・空の店名・競合の印・普通の行が複数のファイルに散った押下で、学ぶ行が今と同じ（`bulk 8` と同じ期待を複数ファイルで）。
4. **fc 4（文言は今と同じ）**：取り消した取引の要確認を確定 → `STATE_TRANSITION` の文に押下の頭で読んだ状態が出る。
5. **fc 5（全部確定したファイル）**：1 ファイルの要確認を全部確定 → `followUp.orphanCandidates === 0`、掃除を呼ばない（呼出しを数える）、ファイルは今どおり `COMPLETED`。
6. **fc 6（一部だけ確定）**：2 件のうち 1 件 → 0、掃除を呼ばない、ファイルは `REVIEW_WAIT` のまま。
7. **fc 7（ほかの要確認が開いている取引）**：同じ取引に `PARTNER` と `DATE` → `PARTNER` を確定 → `unmet`、`orphanCandidates === 0`（開いた `DATE` が指している）。
8. **fc 8（押下の前からある孤児）**：同じファイルに、要確認は解決済みなのに `REVIEW_REQUIRED` の取引（K-W19 (a) の形）を作ってから、別の要確認を確定 → `orphanCandidates ≥ 1`、掃除を呼び、孤児が確定し、ファイルは今どおり `COMPLETED`。
9. **fc 9（確定の後で失敗した件）**：要確認を書いた後に取引の確定が `CONCURRENT_CHANGE` で落ちる形（テストの中で `partnerBatchReadTransactions_` を包む）→ その取引が `orphanCandidates` に数えられ、掃除を呼ぶ。
10. **fc 10（部品を何度も呼ぶファイル）**：`PARTNER_BATCH_MAX_ITEMS_ = 1` で 3 件 → 最後の呼出しの `followUp` で決める。途中の呼出しが投げる・ロックの段まで進まない（`followUp: null`）なら掃除を呼ぶ。
11. **fc 11（数え方が掃除と同じ）**：fc 5〜10 のそれぞれで、部品が返した直後に `commitSettledTransactions_(fileId, {maxOrphanCommits: 0})` の `candidates` と `followUp.orphanCandidates` が等しい（この比較のための呼出しは、測る押下とは別に行ってよい）。
12. **fc 12（数えられないとき）**：決定が全部その前で落ちる（`REVIEW_NOT_FOUND` など）・リース衝突 → `followUp` は `null`。前者は今どおり掃除と完了を呼び、後者は今どおりどちらも呼ばない（`bulk 16`）。
13. **fc 13（読取が投げる）**：押下の頭の取引の読取が投げる → すべての決定が誤りとして返り、部品を呼ばない、何も書かない。

## 7. 変異（M1〜M12）── それぞれ赤になるテストを記録する

- M1：80 がいつも掃除を呼ばない
- M2：80 がいつも掃除を呼ぶ（D2 を外す）
- M3：80 が最初の呼出しの `followUp` で決める
- M4：80 が部品の例外のあとも `followUpKnown` を保つ
- M5：80 が `followUp: null` を 0 と読む
- M6：55 がこの段で確定した取引を除かない
- M7：55 が `openNow` の要確認を開いたまま数える
- M8：55 が開いた要確認を見ない（`REVIEW_REQUIRED` を全部数える）
- M9：55 がロックの段を通らなくても `followUp` を返す
- M10：80 がファイルごとの取引の読取を残す（D1 を外す）
- M11：80 が最初のファイルの取引だけ読む
- M12：80 が押下の頭の読取の失敗を握りつぶして部品を呼ぶ

## 7.1 実装と監査の記録（2026-10-20）

- Codex 1 回目（`tools/codex-logs/*-20261020-152510-*`、gpt-6.1-sol・xhigh）：既存の `bulk 16` と D2 の食い違いを見つけ、実装前に停止 → 1.1。2 回目（`*-154254-*`）：実装して fc 21 本は緑、既存の `webapp 23` が同じ形でぶつかって停止 → 1.2。3 回目（`*-155322-*`）：1677/1677、M1〜M12 はすべて赤。読取は fc 1 (a) 147→119・(b) 32→29・(c) 79→66、取引の読取は Web から 0 回・ファイルあたり 4→2 回・押下で 1 回。
- 監査：src の差分は 55・80（`webAppResolveReviews` の中だけ）、LF のまま。ほかの src・test は開始時の md5 と一致。既存のテストで消えた行は `bulk 16` の 1 行だけ、`webapp 23` は準備の 7 行だけ（assert は不変）。`???` 0。
- 私の確かめ：`followUp.orphanCandidates` が 0 なら掃除を呼んでも何も確定しない ── 掃除は候補ごとに `isTransactionCommittable` を通し、それは開いた要確認を**全ファイルで**（`openReviews({fullTxId})`）見る。部品の数え方も全ファイルの開いた要確認で除くので、部品が 0 と言えば掃除の確定も 0 件になる（掃除の候補の選び方はファイルで絞るので数は違い得るが、結果は同じ）。
- 私の変異 Y2〜Y14 のうち 7 個を回し、4 個がすり抜けた。Y11（押下の頭の読取が無効な古い取引行も拾う → 取引が 1 件に決まらず、カード名を用途にする取引まで学習する）と Y14（判断中＝`IN_PROGRESS` の要確認を開いていない扱い → 掃除の定義とずれる）は fc 14・fc 15 を私が足して赤。Y8（読取の失敗で `attemptedCount` を足さない）と Y12（失敗した確定も確定済みとして除く）は、その値をその後どこも使わない・その形がその時点で起きないので同じ振る舞い。

## 8. 受入（実機）

push 後、次に画面で要確認を確定したとき（利用者の操作）：`clasp logs` の `PARTNER_BATCH` に `orphanCandidates` が出る、確定と完了が今どおり、1 ファイルの時間が今（1 ファイル約 25 秒）より短い。`opsShowLeases` が `(リースなし)`。

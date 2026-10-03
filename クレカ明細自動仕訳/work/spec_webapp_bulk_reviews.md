# Web アプリの要確認を全件表示し、まとめて選んで一括入力する 仕様書

作成日：2026-10-03
版：1.0
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いてあることは変えない。書いていないことは安全側で決め、決めたことは全部報告する。

前提：`work/spec_partner_batch_resolution.md`（取引先の要確認をファイル単位でまとめて確定する部品 `resolvePartnerReviewsBatch`。`src/55_PartnerBatchResolution.gs`）が入っていること。本仕様はその上に作る。

改訂履歴：
- 1.0（2026-10-03）：初版。ko-ch さんの要望（2026-10-03 未明）：「要確認を freee のように一括編集したい（チェックで複数選んで取引先を一度に入れる）。15 件ずつでなく数百件をスクロールで出したい」。
  **実装（Codex、2 回）と監査（Claude）の記録：**1 回目は §4.1 に無い既存テスト 3 本（webapp 45l・45m・fmt 92）が赤になり正しく止まった ── どれもテストの準備が古い仕組みに結び付いていたもの（45l・45m は「確定だけ走っていない取引」を画面の確定経由で作っていた、fmt 92 はチェックの印だけで選択を表していた）。**準備だけを変えてよい**と決め（assert は不変）、45l・45m は 1 件ずつの経路で状態を作り、fmt 92 は選択の集合に登録する形にした。bulk 1 は 500 件の取込で準備しない形に、bulk 13 はスクリプトの中の ID で確かめる形にした。Codex は 1371 本目前まで（1370/1370）、N1〜N17 は全部赤（N6・N12〜N15 は bulk 15〜19 を足して赤）。実測：一覧の読取 6 回（3 件でも 30 件でも）、確定 3 ファイルで 78 回（6 件でも 30 件でも、1 ファイル約 26）。**監査で直したもの 2 つ：**(a) 私の 2 回目の指示の書き方（「絞り込みで描き直しても選択が残る」）を Codex が文字どおり取り、絞り込みで選択を**残す**実装とテスト（bulk 17）にしていた → §2.3 のとおり外す形に戻し、bulk 17 を書き直した、(b) チェック・全選択・一括入力のたびに表全体（最大 500 行）を作り直しており、下のほうまでスクロールして選ぶと先頭へ戻された → その場で印と値だけを合わせる形にし、画面の模型で表が入れ替わらないことを確かめる bulk 20（`phase9-format-registration`）を足した。ほかに、80 で削られていた「取引先不明」の判定理由のコメントを戻し、上限の根拠を冒頭に書いた。私の変異：認可を外す（bulk 4 が赤）、店名が空でも学ぶ（webapp 18・bulk 8）、画面側の別顧客の検査を外す（緑 ── 55 も同じ検査をするので書込は起きない。二重の守りの片方）。最終 1371/1371。

---

## 1. 何を直すか

### 1.1 いまの画面

- 要確認の表は **1 回に 15 件**（`WEBAPP_REVIEW_LIST_LIMIT_`）。「次の 15 件」で送る。新しいカードの初回取込では 1 回で 250 件を超える要確認が立つ（2026-10-02、セゾン 11 ファイルで 256 件）ので、17 ページを行き来することになる。
- 取引先は行ごとに打つ。同じ店の 50 行に同じ取引先を入れるのに 50 回打つ。
- 1 回の押下で確定できるのは 15 件まで（`WEBAPP_MAX_DECISIONS_`）、1 回の呼出しで 8 件・1 ファイルまで（`WEBAPP_MAX_PER_CALL_`・§7.4.1 の 1 ファイル制限）。

### 1.2 遅い理由

- **一覧**は行ごとに `getTransaction` を呼ぶ（1 行 2 読取）。500 行なら 1,000 読取 ＝ 読取枠（60 回/分）で 17 分。
- **確定**は件ごとに `getReviewById`（1 読取）・`authorizeOperation`（読取あり）・`getTransaction`（2）・`resolveReview`（約 20）を払う。1 件 25 読取前後。

### 1.3 本仕様がすること

1. 一覧は**1 回の呼出しで最大 500 件**を返し、読取は件数に依らない定数にする（§2.1）。
2. 確定は**1 回の呼出しで複数ファイル・最大 500 件**を受け、ファイルごとにまとめ確定の部品へ渡す。時間はまとめ確定の門（`partnerBatchMayStart_`）で守る（§2.2）。
3. 画面は全件をスクロールで出し（見出しは固定）、**絞り込み・全選択・範囲選択（Shift）・取引先の一括入力**を持つ（§2.3）。確認ダイアログは**まとめた要約**を先に出し、1 件ずつの一覧は折りたたむ（§2.4）。

**変えないもの：**確定の意味（どの操作になるか・辞書に学ぶかの 3 判定・取引先不明の扱い・確認を出してから送る）、クライアントの繰り返し（残りだけを送る・`madeProgress`）、戻り値の鍵と勘定の恒等式、`resolveReview`（メニューの経路）、取込。

---

## 2. 設計

### 2.1 一覧 `webAppListReviews(customerId, limit, offset)`（80）

- 認可・`getCustomerById`・`openReviews({})` は今までどおり 1 回ずつ。並びは `reviewId` の昇順のまま（`offset` の意味を保つ）。
- 上限：`WEBAPP_REVIEW_LIST_LIMIT_ = 500`。`limit` の扱い（クライアントの値を上限で切る・`offset` が総数を超えたら 0 に戻す）は今までどおり。
- **取引は 1 回でまとめて読む。**表示する行の `fullTxId` を集め、`findRowsByColumnValues_(transactionLogSheet_(), 1, ids, TRANSACTION_LOG_WIDTH_)` を 1 回呼び、`txLogFromRecord_` で読んで有効な行だけに絞る。**有効な行がちょうど 1 つの取引だけを使い、0 か 2 つ以上なら `null`**（その行の利用日・金額は `null`、`learnBlockedBy` は今までどおり計算）。**1 件の異常で表全体を落とさない**（今の `getTransaction` は 2 行あると例外を投げ、表が出なくなる）。補助関数 `webAppTransactionsById_(ids)` を 80 に置く。
- 戻り値の形は変えない（`reviews`・`partnerTotal`・`otherCounts`・`offset`・`limit`。各行の鍵も同じ）。
- 読取は件数に依らない（3 行と 30 行で同じ回数）。

### 2.2 確定 `webAppResolveReviews(customerId, decisions, options)`（80）

**入口**（今までどおり）：`authorize(ROLE.REVIEWER, customerId, {operation: 'WEBAPP:要確認を確定' + batchId})`、`getCustomerById`。`decisions` のうち `WEBAPP_MAX_DECISIONS_`（＝500）を超える分は `TOO_MANY_DECISIONS`（今までどおりの文言）。

**事前の検査**（件ごと。順序は今までと同じ）：
1. 要確認は**呼出しの頭で 1 回だけ読む**（`allReviewRecords_()`）。件ごとの `getReviewById` をやめる。無ければ `REVIEW_NOT_FOUND`（今の文言）。
2. 操作コードを決める（空 → `RESOLVE_WITHOUT_PARTNER`、取引先不明 → `RESOLVE_PARTNER_UNKNOWN`、それ以外 → `ADOPT_EXISTING_PARTNER`。今までどおり）。
3. `authorizeOperation(code, review.customerId, {})` は**（code, review.customerId）ごとに 1 回だけ**呼び、戻り値または投げた例外を覚えて同じ組の件に使い回す。例外なら件ごとに今までどおり `errors`（`code` は例外の `code`、無ければ `RESOLVE_FAILED`、文言は `menuOperationErrorMessage_`）。**拒否の監査行（`PERMISSION`）は組ごとに 1 行になる**（今は件ごと）── これは意図した違いである（§4 の判断の記録）。
4. `review.customerId` が違えば `REVIEW_CUSTOMER_MISMATCH`、`OPEN`／`IN_PROGRESS` でなければ `ALREADY_SETTLED`（今の文言）。

**ファイルごとに確定する。**検査を通った件を `review.fileId` で分け（最初に現れた順）、ファイルごとに：
1. **始める前に門**：`partnerBatchMayStart_({startedAt: 呼出しの開始, deadlineMs: WEBAPP_DEADLINE_MS_, floorMs: PARTNER_BATCH_FLOOR_MS_, factor: PARTNER_BATCH_FACTOR_, maxBatchMs: この呼出しで処理したファイルの所要の最大値})`。閉じたら、このファイルと後ろのファイルの件を全部 `notAttempted` に数え、そのうちまとまりを 1 つも始めなかったファイルの件を `deferredByFile` にも数える（`deferredByFile` は `notAttempted` の内訳。恒等式に別に数えない ── 今までと同じ）。時計は `partnerBatchClockNow_()`。
2. **1 呼出しの上限**：`WEBAPP_MAX_PER_CALL_`（＝500）。この呼出しで部品へ渡した件数の合計がこれを超えないように切り、超える分は `notAttempted`。
3. 取引を 1 回読む（`getTransactionsForFile_(fileId)`）。ADOPT の件の `learn` を今までと同じ 3 判定で決める：`Boolean(review.merchantNormalized) && !isCardNamePartnerPurpose(customer, tx && tx.planned ? tx.planned.i : '') && !Boolean(decision.sameMerchantConflict)`。
4. 部品を呼ぶ：`resolvePartnerReviewsBatch(customerId, fileId, [{reviewId, operation: code, partnerName, learn}…], {actor: 認可の userEmail, customer})`。部品の上限（`PARTNER_BATCH_MAX_ITEMS_`）で残った件（`notAttemptedReviewIds`）は、**同じファイルの次のまとまりとして**、門を通してから続けて渡す。
5. 部品の戻りを写す：
   - `resolvedReviewIds` → `resolved`・`resolvedReviewIds`、`committedReviewIds` の数 → `committed`、`unmet` → `unmet`
   - `errors` → 件ごとの `errors`（文言は §2.2.1）
   - `skippedByLeaseReviewIds` → **そのファイルの先頭の 1 件だけ** `errors` に `{reviewId, code: 'LEASE_CONFLICT', message: menuLeaseConflictText_(null)}`、残りは `skippedByLease`・`skippedByLeaseReviewIds`（今の `RESOLVE_WITHOUT_PARTNER` の扱いと同じ形。`webapp 53` が固定している）
6. **後始末**（今までどおり、部品が 1 件でも手を付けた ＝ リース衝突でなかったファイルだけ）：`commitSettledTransactions_(fileId)` と `completeFileIfFullyResolved_(fileId, {readLeases: activeLeases_})`。失敗はファイル単位の `errors`（`webAppFileError_`）。
7. そのファイルの所要（取引の読取から後始末まで）を `maxBatchMs` に反映する。

**戻り値は今までと同じ鍵・同じ意味**（`resolved, committed, unmet, completedFiles, rewoundFiles, deferredCommits, skippedByLease, notAttempted, errors, maxPerCall, remaining, deferredByFile, resolvedReviewIds, skippedByLeaseReviewIds`）。`maxPerCall` は `WEBAPP_MAX_PER_CALL_`、`remaining` は `notAttempted`。**恒等式 `decisions.length ＝ resolved ＋（reviewId を持つ errors の数）＋ skippedByLease ＋ remaining` を保つ。**

**1 ファイル制限（§7.4.1）と件ごとの往復の見積（`WEBAPP_ITEM_TRIPS_`・`WEBAPP_CLEANUP_TRIPS_`）はやめる。**根拠だった「後始末と件の往復がファイル数・件数に比例する」は、まとめ確定で件数に依らなくなり、時間は門が守る。使わなくなった 2 つの定数は消す（`WEBAPP_TRIP_WORST_MS_` は取込の門がまだ使うので残す）。

#### 2.2.1 件ごとの `errors` の文言

| `code` | 文言 |
|---|---|
| `REVIEW_NOT_FOUND`・`REVIEW_CUSTOMER_MISMATCH`・`ALREADY_SETTLED`・`TOO_MANY_DECISIONS` | 今の文言のまま |
| `STATE_TRANSITION` | `'この取引は既に取り消されたか除外されています（状態 ' + 状態 + '）。画面を再読み込みしてください。'`（今の文言。状態は手順 3 で読んだ取引の状態、読めなければ `不明`）── `webapp 54` が固定している |
| `LEASE_CONFLICT` | `menuLeaseConflictText_(null)` |
| それ以外（部品の `code`） | 部品の `message`。空なら `'この要確認は確定できませんでした（' + code + '）。管理者へ連絡してください。'` |

### 2.3 画面（81）── 全件のスクロール・絞り込み・選択・一括入力

**表**
- 全件を 1 つの表に出す。表を包む箱は縦に `max-height: 60vh`・`overflow: auto`、**見出しの行は `position: sticky; top: 0`**（スクロールしても列名が見える）。
- 先頭の列の見出しに「表示中をすべて選択」のチェックボックス（`review-select-all`）。表示中の行が全部選ばれていれば ON、一部なら `indeterminate`、0 なら OFF。押すと**表示中の行だけ**を選ぶ／外す。
- 行のチェックボックスは**Shift を押しながら押すと、直前に押した行からその行までの表示中の行を同じ状態にする**。
- 行の取引先の入力欄の値は、`state.partnerInputs`（`reviewId → 文字列`）に持つ。表を描き直しても値が消えない。
- 選択は `state.selectedReviewIds`（`Set`）に持つ。

**表の上の道具の帯**
- 絞り込み（`review-filter`、`type="search"`、placeholder「摘要・ファイル名で絞り込み」）。**クライアントだけで**絞る（サーバーを呼ばない）：入力と、各行の `merchantOriginal`・`fileName` を `NFKC`＋小文字＋空白の除去で正規化し、含まれる行を出す。空なら全件。**絞り込みを変えたら選択を全部外す**（見えない行が選ばれたまま確定に送られるのを防ぐ）。
- 件数の表示：「表示 n 件 / 全 m 件・選択 k 件」。
- 一括入力（`bulk-partner`、`list` に候補）と「選択した行に入れる」ボタン（`bulk-apply`）：選択中の行の取引先欄に、その値（前後の空白を除く）を入れる。空のまま押すと選択中の行を空欄（＝取引先なし）にする。候補は選択中の行の推測候補の和集合に「取引先不明」を足したもの。**入れるだけで確定はしない**（確定は今までどおり「選択した要確認を確定」→ 確認 → 送信）。
- 「選択を解除」（`select-clear`）。

**ページ**
- `partnerTotal` が 500 を超えるときだけ、今のページ送り（前の／次の 500 件）を出す。ページを替えたら選択を全部外す（取引先欄の値は `reviewId` で持っているので残る）。

**確定のボタン**は「選択 k 件を確定」と件数を出し、選択が 0 なら押せない。`isMutationBusy()` のあいだは道具の帯・表の入力・チェックボックスを全部止める（今と同じ）。

**取り出せる純関数**（テストが `clientEval` で呼ぶ。DOM に触らない）：
- `reviewMatchesFilter(review, text) → boolean`
- `rangeIds(orderedIds, fromId, toId) → string[]`（両端を含む。どちらかが無ければ `[toId]`）
- `applyBulkPartner(inputs /* Map */, ids, value) → number`（入れた件数）
- `confirmationGroups(items) → [{merchant, partner, message, count}]`（§2.4）

### 2.4 確認ダイアログ

- 先頭に「次の n 件を確定します。取り消せません。」（今の文言）。
- その下に**まとめ**：（元店名の表示, 取引先（空なら「取引先なし」）, 辞書の扱いの文言 `dictionaryMessage(item)`）が同じ件を 1 行にまとめ、件数を付ける。並びは件数の多い順、同数なら元店名順。例：`アマゾン シーオージェーピー → Amazon（辞書に登録しません：…）× 233 件`。
- **1 件ずつの一覧は `<details>` に入れて折りたたむ**（「1 件ずつ見る（n 件）」）。中身は今の 1 件ずつの行（`店 / ファイル 行目 → 取引先（辞書の扱い）`）。**まとめだけで済ませない** ── どの件をどう書くかを利用者が確かめられることが §2.4 原理 1 の要件である。
- 形式の確認（`formatConfirm`）が同じダイアログを使うときは、まとめと `<details>` を出さない（空にして隠す）。

---

## 3. 変えてよいファイル

- `src/80_WebApp.gs`（`webAppListReviews`・`webAppResolveReviews`・定数・補助の追加。取込・形式・最終確認の関数には触らない）
- `src/81_WebAppUi.html`（要確認の表・道具の帯・確認ダイアログ・`startResolve` のまわり。取込・形式・最終確認の部分には触らない）

`src/55_PartnerBatchResolution.gs` は使うだけで変えない（足りないものがあれば止めて報告する）。

---

## 4. テスト（`test/phase8-webapp.test.js` に `bulk N: …` を足す）

1. 一覧が 500 件まで返り、読取が件数に依らない（3 件と 30 件で `batchGet` の回数が等しい）。
2. 一覧：同じ取引 ID の有効な行が 2 つある取引は、その行だけ利用日・金額が `null` で、表は落ちない。
3. 確定：3 ファイルにまたがる 30 件を 1 回の呼出しで全部確定し、`resolved` 30・`remaining` 0。読取の回数を記録し、ファイル数に比例し件数に依らないこと（同じ 3 ファイルで 6 件と 30 件で等しい）。
4. 確定：`authorizeOperation` は（操作, 顧客）ごとに 1 回（30 件・2 種類の操作で 2 回）。`getReviewById`・`getTransaction`・`resolveReview` は 1 回も呼ばれない。
5. 確定：時計を差し替えて 1 ファイル目の所要を 200 秒にすると、2 ファイル目は始まらず、その件数が `remaining`・`deferredByFile`、恒等式が成り立つ。
6. 確定：`PARTNER_BATCH_MAX_ITEMS_` を 2 に差し替えると、5 件のファイルが 1 回の呼出しの中で 3 つのまとまりに分かれて全部確定する。
7. 確定：1 ファイル目にリースがあると、そのファイルの先頭 1 件が `errors` の `LEASE_CONFLICT`（文言は `menuLeaseConflictText_(null)`）、残りが `skippedByLeaseReviewIds`、**2 ファイル目は同じ呼出しで確定する**。
8. 確定：辞書の 3 判定が今までどおり（店名が空・カード名の用途・`sameMerchantConflict` のどれかで学ばない、どれにも当たらなければ学ぶ）。
9. 画面：`reviewMatchesFilter`（全角・半角・大小・空白を見ない、ファイル名でも当たる、空は全部）。
10. 画面：`rangeIds`（順方向・逆方向・片方が無い）。
11. 画面：`applyBulkPartner`（選んだ ID だけに入る・空白を除く・空で空欄にする・入れた件数）。
12. 画面：`confirmationGroups`（同じ店・同じ取引先・同じ辞書の扱いで 1 行・件数の多い順・取引先が空は「取引先なし」）。
13. 画面の材料：表の見出しが `position: sticky`、`review-select-all`・`review-filter`・`bulk-partner`・`bulk-apply`・`select-clear` が在る。確認ダイアログに 1 件ずつの一覧を入れる `<details>` がある。
14. 定数：`WEBAPP_MAX_DECISIONS_ === WEBAPP_REVIEW_LIST_LIMIT_`（＝500）、`WEBAPP_MAX_PER_CALL_` ≧ `WEBAPP_MAX_DECISIONS_`、`WEBAPP_ITEM_TRIPS_`・`WEBAPP_CLEANUP_TRIPS_` が無い。

### 4.1 前提が変わる既存テスト（ここに挙げたものだけ、書いてあるとおりに変えてよい）

| テスト | 変わる前提 | 変え方 |
|---|---|---|
| `webapp 30` | 上限が 15 | 本体を `withMocks({WEBAPP_REVIEW_LIST_LIMIT_: 15}, …)` で包む。assert は変えない |
| `webapp 35` | 上限が 15 | 同上 |
| `webapp 38` | 上限＋1 件を実際に取り込む（500 だと 501 件の取込になる） | 本体を `withMocks({WEBAPP_MAX_DECISIONS_: 15}, …)` で包む。assert は変えない |
| `webapp 39` | 1 呼出し 1 ファイル（2 ファイル目は次回送り） | 「1 ファイル目の後に門が閉じる」形に置き換える：時計（`partnerBatchClockNow_`）を差し替え、1 ファイル目の所要を 200 秒にする。`WEBAPP_TRIP_WORST_MS_` の差し替えは外してよい。assert は変えない |
| `webapp 44` | 件ごとの往復の見積（`WEBAPP_ITEM_TRIPS_` など）と上限 8 | **廃止**し、`bulk 14` に置き換える（名前は残し、本文を「置き換えた」旨の 1 行の assert にしてもよい） |
| `webapp 45` | 往復の単価で門を閉じる | 時計を差し替えて、呼出しの頭で既に 250 秒たった形にする（1 ファイル目も始まらない）。`WEBAPP_TRIP_WORST_MS_` の差し替えは外してよい。assert は変えない |
| `webapp 47` | 1 呼出し 1 ファイル（先頭がリースで飛ばされたら、その呼出しは何も確定しない） | 1 回目の呼出しだけ時計を差し替え、1 ファイル目の後に門が閉じる形にする。assert は変えない |

**上の表に無い既存テストの期待は 1 つも変えないこと。**特に `webapp 09`・`10`・`20b`（`WEBAPP_MAX_PER_CALL_` を 1 に差し替えて呼出しを分けている）・`23`・`28`・`34`・`40`・`46`・`48`〜`54` は、本仕様の実装のまま緑でなければならない。

---

## 5. 変異（入れて回し、赤になるテストを記録して戻す）

- N1 一覧で取引を行ごとに読む（`getTransaction`）
- N2 一覧で 2 行ある取引で例外を投げる
- N3 確定で件ごとに `getReviewById` を呼ぶ
- N4 `authorizeOperation` の使い回しをやめる
- N5 門を見ない
- N6 門の `maxBatchMs` に直前のファイルの所要を使う
- N7 部品の上限で残った件を捨てる
- N8 リース衝突の件を全部 `errors` にする（先頭 1 件だけにしない）
- N9 リース衝突の件を全部 `skippedByLease` にする（先頭も）
- N10 `sameMerchantConflict` を見ない
- N11 カード名の用途の判定を外す
- N12 後始末をリース衝突のファイルにも掛ける
- N13 画面：絞り込みを変えても選択を外さない
- N14 画面：全選択が表示外の行も選ぶ
- N15 画面：一括入力が選択外の行にも入る
- N16 画面：確認ダイアログのまとめが辞書の扱いの違いを 1 行に畳む
- N17 `STATE_TRANSITION` の文言から状態を落とす

---

## 6. 受入（実機。push の後）

1. 要確認の多い顧客を選ぶと、全件が 1 つの表に出る（数秒〜十数秒）。見出しはスクロールしても残る。
2. 絞り込みに店名を入れ、全選択 → 一括入力 → 「選択した行に入れる」→「確定」。確認ダイアログのまとめが正しく、確定後に表から消える。
3. `clasp logs` の `PARTNER_BATCH` で、1 回の呼出しが複数ファイルを処理し、読取が 1 ファイル 15〜25 前後であること。

---

## 7. Claude の判断の記録（ko-ch さんの決定ではないもの）

- 上限を 500 にした（一覧・1 押下・1 呼出し）。新しいカードの初回取込で 1 顧客 250 件超が実際に立ったので、その倍を 1 画面に収める。500 を超えたらページ送りが残る。
- 拒否の監査行を（操作, 顧客）ごとに 1 行にした。同じ利用者が同じ顧客の同じ操作を 1 回の押下で拒まれた事実は 1 行で足り、件ごとに読取を払うと 500 件で枠を使い切る。
- 絞り込みを変えたら選択を外す。freee は選択を残すが、表示外の行が確定に送られる事故のほうが重い。
- 一括入力は「入れるだけ」にした（確定は確認を経る）。§2.4 原理 1（取り消せない書込の前に、何を書くかを見せる）を崩さない。

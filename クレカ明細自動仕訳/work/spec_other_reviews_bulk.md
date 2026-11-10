# 「その他の要確認」をまとめて確定する 仕様書

版：1.1（2026-11-10。1.0 からの変更：§4-3 の確認の文の所要の書き方、§3.3 に実行中の印の後始末）
対象：`src/81_WebAppUi.html` だけ（サーバーの `.gs` は変えない）。
発端：2026-11-10、利用者の依頼。前年利用日の要確認が 41 件並び、1 件ずつ「操作を選ぶ →［確定…］→ 確認」を繰り返すのが手間。まとめて処理したい。

## 1. 方針

- 行を選んで、操作を 1 つ選び、確認を 1 回だけ経て、選んだ行を**上から 1 件ずつ順に**確定する。
- サーバーは今の公開関数 `webAppResolveOtherReview(customerId, reviewId, code, inputs)` を 1 件ずつ呼ぶ。新しい公開関数は作らない。押せるかどうか・状態の読み直し・認可は、今までどおりサーバーが 1 件ごとに確かめる。
- 1 件ずつの確定（行の「操作を選ぶ」と［確定…］）は今のまま残す。

## 2. まとめて確定できる行と操作

- **まとめて確定できる操作（以下「まとめ操作」）**は次の 4 つだけ：`POST_PRIOR_YEAR`・`EXCLUDE_PRIOR_YEAR`・`POST_ZERO_AMOUNT`・`EXCLUDE`。
  - `FIX_DATE_AMOUNT`（行ごとに値が要る）と、ファイル単位の操作（`scope` が `FILE` の行の操作すべて）は、まとめては行わない。
- **選べる行**：`review.scope === 'TRANSACTION'`、`review.problem` が無い、`review.options` に「まとめ操作で `enabled` が真のもの」が 1 つ以上ある行。それ以外の行にはチェックボックスを出さない（セルは空）。

## 3. 画面

### 3.1 表

- `#other-review-list` の表の左端に 1 列足す。見出しは `['', '種類', '内容', '元ファイル', '行', '操作']` で、左端の見出しのセルに「全部選ぶ」のチェックボックス（class `other-select-all`、`aria-label`＝`選べる行をすべて選ぶ`）。
- 選べる行の左端のセルにチェックボックス（class `other-select`、`aria-label`＝`この行を選ぶ`）。
- 「全部選ぶ」は、選べる行がすべて選ばれているときだけ checked。押すと、選べる行をすべて選ぶ／すべて外す。選べる行が 0 のときは disabled。
- どのチェックボックスも `isMutationBusy()` の間は disabled。

### 3.2 まとめて確定の帯（`#other-bulk`）

`#other-review-section` の中、見出し（`#other-review-heading`）と `#other-review-list` の間に置く。選べる行が 0 のときは `hidden`。

```
<div id="other-bulk" class="other-bulk" hidden>
  <span id="other-bulk-count"></span>
  <select id="other-bulk-op"></select>
  <button id="other-bulk-button" type="button" class="button primary" disabled>選んだ行をまとめて確定…</button>
  <button id="other-bulk-stop" type="button" class="button" hidden>中止</button>
  <span id="other-bulk-progress" class="status-line" aria-live="polite"></span>
  <div id="other-bulk-hint" class="muted"></div>
</div>
```

- `#other-bulk-count`：`選択 N 件`（N は選んでいる行の数）。
- `#other-bulk-op`：先頭に `操作を選ぶ`（値は空）。その下に、**選んでいるすべての行で `enabled` が真の、まとめ操作**（コードの共通部分）を、上の §2 の順（`POST_PRIOR_YEAR`・`EXCLUDE_PRIOR_YEAR`・`POST_ZERO_AMOUNT`・`EXCLUDE`）で並べる。表示は、選んでいる最初の行のその操作の `label`。
  - 選択が変わって、選んでいた操作が共通部分から外れたら、値を空に戻す。
- `#other-bulk-hint`：1 件以上選んでいて共通のまとめ操作が 1 つも無いとき `選んだ行に共通の操作がありません。同じ種類の行だけを選んでください。`。それ以外は空。
- `#other-bulk-button`：`isMutationBusy()` でなく、1 件以上選んでいて、操作を選んでいるときだけ押せる。
- `#other-bulk-stop`：まとめて確定の実行中だけ出す（押せる）。
- `#other-bulk-op` は `isMutationBusy()` の間は disabled。
- CSS は要る分だけ足す（帯の中の間隔など）。`hidden` で隠す要素に `display` を指定したら `[hidden]` の指定もそろえる（既存の `ui 6` が確かめている）。足したら報告する。
- 新しい id は `el` の id の一覧に足す。どの id も本文にちょうど 1 回。

### 3.3 状態

- `state.otherSelectedIds`（`Set`、要確認 ID の文字列）、`state.otherBulkCode`（文字列、初めは `''`）、`state.otherBulkRun`（実行中の情報。無ければ `null`）を足す。名前は変えてよいが報告する。
- `loadReviews` で一覧を読み直したら、一覧に無い ID・選べる行でなくなった ID を `otherSelectedIds` から外す（`otherInputs` を掃除している所と同じ所）。
- 顧客を切り替えたら（`otherInputs` を空にしている所）、`otherSelectedIds` を空に、`otherBulkCode` を `''` に戻す。`otherBulkRun` も `null` に戻し、`#other-bulk-progress` を空にする（1.1。実行中の印が切替の先に残らないように。実行中の繰返しは控えた印と §4-5 の 3 条件で抜ける）。

## 4. 実行

［選んだ行をまとめて確定…］を押したとき：

1. `isMutationBusy()` なら何もしない。選択が 0 件・操作が空・操作が共通部分に無い、のどれかなら何もしない。
2. 対象は、**押した時点で選んでいる行**を、表に並んでいる順（`state.otherReviews` の順）に並べたもの。押した後に選択や一覧が変わっても、対象は増やさない。
3. 確認（`formatConfirm(title, message)`）。
   - title：選んだ操作の `label`。
   - message：`「その他の要確認」の N 件（<種類の内訳>）にまとめて行います。` ＋ `TEXT.otherEffect(code, {})` ＋ ` 1 件ずつ順に確定します（件数が多いと時間がかかります。1 分に 2〜3 件が目安です）。途中で［中止］を押すと、そこで止まります（済んだ分は戻りません）。`
   - <種類の内訳>：`typeLabel` ごとの件数を、最初に出てくる順に `、` でつなぐ（例：`前年利用日 41 件`、`前年利用日 3 件、0円 2 件`）。
   - ［戻る］なら、サーバーを 1 回も呼ばずに終わる（選択はそのまま）。
4. 実行の始め：`runOtherReviewOperation` と同じ形で、`token = ++state.resolveRun`、`generation = state.viewGeneration`、`customerId = state.selectedCustomerId` を控え、`state.resolveBusy = true`、`clearNotice()`、`renderSelection()`。
5. 対象を順に 1 件ずつ：
   - 呼ぶ前に毎回、次のどれかなら**それ以上呼ばずに**抜ける：`token !== state.resolveRun`、`generation !== state.viewGeneration`、`String(customerId) !== String(state.selectedCustomerId)`（この 3 つは「画面が変わった」）、［中止］が押された。
   - `#other-bulk-progress` を `まとめて確定中… k / N 件`（k は今から呼ぶ件の番号、1 から）にする。
   - `await gasCall('webAppResolveOtherReview', [customerId, review.reviewId, code, {}])`。**前の応答が返ってから次を呼ぶ**（同時に 2 つ呼ばない）。
   - 結果の分け方：
     - `result.ok === true && result.resolved === 1 && (result.errors || []).length === 0` → 済み。`otherSelectedIds`・`otherInputs` からその ID を外して次へ。
     - `result.ok === true && result.resolved === 1` で `errors` がある → 済みに数え、ID を外し、**そこで止める**（後始末の失敗。理由は 1 件ずつのときと同じ文）。
     - `result.ok === false` で `code` が `ALREADY_SETTLED` か `REVIEW_NOT_FOUND` → 「既に片付いていた」に数え、ID を外して次へ（止めない）。
     - それ以外（`ok === false` のほかのコード、`resolved !== 1`）→ **そこで止める**。その行は選んだまま。
     - `gasCall` が例外 → **そこで止める**。その行は選んだまま（サーバーで済んだかどうか分からないため、読み直しで確かめる）。
6. 終わり（`finally`）：`token === state.resolveRun && generation === state.viewGeneration` のときだけ、`state.resolveBusy = false`、`state.otherBulkRun = null`、`#other-bulk-progress` を空に、`markFinalReviewStale()`、`renderSelection()`、`loadReviews(customerId, state.reviewOffset, generation)`、`state.selectedFolderId` があれば `loadFiles(customerId, state.selectedFolderId, generation)`。**読み直しは実行の最後に 1 回だけ**（1 件ごとには読み直さない）。全部済んだら `state.otherBulkCode = ''`。
7. お知らせ（「画面が変わった」で抜けたときは出さない）：
   - 全部済んだ（止まらず・中止もなし）：`success` で `「その他の要確認」 D 件をまとめて確定しました（<label>）。`。既に片付いていたものが S 件あれば続けて `S 件は既に片付いていました。`。
   - 中止：`warning` で `中止しました。D 件を確定しました（<label>）。残り R 件は選んだままです。`
   - 止まった：`warning` で `D 件を確定したところで止まりました（<label>）。<止まった行>：<理由>。残り R 件は選んだままです。`
     - <止まった行>：`<fileName> <sourceRow> 行目`（`sourceRow` が無ければファイル名だけ）。
     - <理由>：1 件ずつの確定で同じ結果のときに出る文と同じもの（`showOtherReviewResult` の文を作る部分を関数に分けて使ってよい。1 件ずつのときの表示は変えない）。例外のときは `failureMessage(error)`。`errors` があればその文を `showNotice` の第 3 引数（詳細）に渡す。
   - D＝済みの数、R＝対象のうち呼ばなかった数＋止まった行（済みに数えた行は含めない）。
8. ［中止］：押すと「中止」の印を付けるだけ（実行中の呼出しは待つ）。次の件を呼ぶ前に抜ける。押した後は disabled にする。

## 5. 安全の条件（テストで確かめる）

- S1：選んでいない行の ID でサーバーを呼ばない。呼ぶ `code` は帯で選んだ操作だけ、`inputs` は `{}`。
- S2：確認で［戻る］なら 1 回も呼ばない。
- S3：同時に 2 つ呼ばない（前の応答の後に次）。
- S4：止まる条件（§4-5）に当たった後は 1 回も呼ばない。顧客の切替・［中止］の後も呼ばない。
- S5：実行中は、1 件ずつの確定・取引先の確定・［記帳を実行］・形式の操作が押せない（`isMutationBusy()`）。実行中に［選んだ行をまとめて確定…］をもう一度押しても何も起きない。
- S6：まとめ操作でないもの（`FIX_DATE_AMOUNT`・ファイル単位の操作）は帯の候補に出ない。選んだ行のどれかで `enabled` が偽の操作も出ない。
- S7：1 件ずつの確定の動きは変わらない（既存の `kw2` のテストが直さずに通る）。

## 6. 変えないこと

- サーバー（`.gs`）。`webAppResolveOtherReview` の引数と戻り値。
- 1 件ずつの確定（`resolveOtherReview`・`runOtherReviewOperation`）の動きと文。
- 取引先の要確認の表・まとめ確定・最終確認・形式の欄。

## 7. テスト（`ob N: …`。`test/phase9-format-registration.test.js` の `kw2` の並びの後ろに足す。`kw2World`・`kw2Row` などの道具を使ってよい）

1. **ob 1（選べる行）**：取引単位でまとめ操作が押せる行にだけ `other-select` が出る。ファイル単位の行・`problem` のある行・まとめ操作がどれも `enabled` 偽の行・`FIX_DATE_AMOUNT` しか押せない行には出ない。見出しは 6 列。選べる行が 0 なら `#other-bulk` は隠れ、`other-select-all` は disabled。
2. **ob 2（全部選ぶ）**：`other-select-all` で選べる行がすべて選ばれ、もう一度で外れる。1 行だけ外すと `other-select-all` は unchecked。`#other-bulk-count` の文。
3. **ob 3（操作の候補）**：前年利用日だけを選ぶと `POST_PRIOR_YEAR`・`EXCLUDE_PRIOR_YEAR`・`EXCLUDE` がこの順。前年利用日と 0 円を選ぶと `EXCLUDE` だけ。1 行で `EXCLUDE` が `enabled` 偽なら、その行を選んだとき `EXCLUDE` は出ない。共通が無いときの `#other-bulk-hint` の文とボタンの disabled。選択が変わって操作が候補から外れたら値が空に戻る。
4. **ob 4（確認）**：title＝操作の label、message に件数・種類の内訳・`TEXT.otherEffect` の文・順に確定する旨。［戻る］で呼出し 0 回、選択はそのまま（S2）。
5. **ob 5（順に 1 件ずつ）**：3 行を選んで実行。1 件目の応答を返すまで呼出しは 1 回だけ（S3）。引数は `[customerId, reviewId, code, {}]` で、表の並び順。選んでいない行は呼ばれない（S1）。`#other-bulk-progress` が `まとめて確定中… 1 / 3 件`→`2 / 3 件`→`3 / 3 件`。
6. **ob 6（全部済み）**：`success` のお知らせの文、選択が空、`otherBulkCode` が空、`webAppListReviews`・`webAppListFolder` の読み直しが**実行全体で 1 回ずつ**、`resolveBusy` 偽、`finalReviewedFor` が `null`、`#other-bulk-progress` が空、［中止］が隠れる。
7. **ob 7（途中で止まる）**：2 件目が (a) `ok:false, code:'OPERATION_DISABLED'`、(b) `ok:true, resolved:0, notAttempted:1`、(c) 例外、(d) `ok:true, resolved:1, errors:[…]` のそれぞれで、3 件目を呼ばない（S4）。お知らせの文（D・止まった行・理由・R）。(a)(b)(c) は 2 件目が選んだまま、(d) は 2 件目が外れる。読み直しは 1 回ずつ。
8. **ob 8（既に片付いていた）**：2 件目が `ALREADY_SETTLED`（と `REVIEW_NOT_FOUND`）のとき 3 件目へ進む。お知らせに `1 件は既に片付いていました。`。
9. **ob 9（画面が変わった）**：1 件目の応答を待つ間に顧客を切り替える → 応答を返しても 2 件目を呼ばない（S4）。お知らせを出さない。切り替えた先の状態（`resolveBusy` など）を壊さない。
10. **ob 10（中止）**：実行中だけ［中止］が出る。1 件目の応答を待つ間に押す → 応答の後 2 件目を呼ばない。`warning` の文。押した後は disabled。
11. **ob 11（実行中は押せない）**：実行中、`other-op`・`other-submit`・`other-select`・`other-select-all`・`#other-bulk-op`・`#other-bulk-button`・取引先の［選択した要確認を確定］が disabled。実行中にもう一度押しても呼出しは増えない（S5）。`importBusy`・`formatBusy` のときも帯の操作は disabled。
12. **ob 12（選択の掃除）**：読み直しで消えた行・選べなくなった行は選択から外れる。顧客の切替で選択と操作が空。
13. **ob 13（1 件ずつは今のまま）**：行の「操作を選ぶ」と［確定…］で 1 件だけ確定できる（選択の状態にかかわらず、呼ぶのはその行だけ）。
- 既存のテストは直さずに通ること。例外：その他の要確認の表の**見出しの列**や**セルの位置**を固定しているテスト（`kw2 20` の見出しの配列など）は、左端の 1 列を足した形に直してよい（直したものはすべて報告）。

## 8. 変異（B1〜B10）── それぞれ赤になるテストを記録して戻す

- B1：対象を「選んだ行」でなく「選べる行すべて」にする
- B2：確認の［戻る］でも実行する
- B3：前の応答を待たずに全部を同時に呼ぶ
- B4：止まる結果（`OPERATION_DISABLED`）の後も続ける
- B5：例外の後も続ける
- B6：顧客の切替の後も続ける
- B7：［中止］を押しても続ける
- B8：操作の候補を「共通部分」でなく「どれかの行で押せる操作」にする
- B9：`FIX_DATE_AMOUNT` を帯の候補に出す
- B10：1 件ごとに `loadReviews` を呼ぶ

## 9. 受入（利用者）

F5 → 顧客を選ぶ → 「その他の要確認」の表の左端にチェックボックス、表の上に帯。［全部選ぶ］→ 帯で「前年の利用分として計上する」→［選んだ行をまとめて確定…］→ 確認 → `まとめて確定中… k / N 件` と進み、終わると「N 件をまとめて確定しました」。表から消える。一部だけ対象外にしたいときは、その行だけ選んで「前年の利用分として対象外にする」。

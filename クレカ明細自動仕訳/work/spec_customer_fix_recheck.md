# 要修正のファイルを Web アプリから取込待ちへ戻す 仕様書（K-W23）

版：1.1（2026-10-14。1.0 から rc 6 の監査の期待だけを直した ── Codex の指摘）
対象：`src/80_WebApp.gs`・`src/81_WebAppUi.html`・`src/97_Ops.gs`（1 行）。
発端：2026-10-14、利用者が SAISON_2504 の元ファイルを直したのに、Web アプリの一覧で【要修正】が消えなかった。

## 1. 背景

- 【要修正】（`CUSTOMER_FIX_REQUIRED`）のファイルは、元ファイルを直しても**自動では取込待ちに戻らない**。取込の候補は「未登録」か `DISCOVERED` だけ（`scanUnprocessedFiles`・`webAppFolderFile_` の `importable`）で、定期取込は止めてある（K-W10）。これは作りであって不具合ではない ── 顧客が直し終えたかどうかは、こちらからは分からない。
- 戻す道は今 2 つだけで、どちらも Web アプリの外にある：
  1. シートのメニュー「クレカ自動処理 ▸ 要修正ファイルを再検査」（`menuRecheck` → `applyRecheck_`）。1 本ずつ選べる。
  2. 運用関数 `opsRetryCustomerFixFiles`。**全顧客の要修正を全部戻す**ので、直っていないファイル（au・enavi など）まで巻き込む。
- 利用者は Web アプリだけで作業している。直したファイルを戻す手段を Web アプリに置く。

**利用者の決定（2026-10-14）：**Web アプリに「修正済み → 取込待ちに戻す」ボタンを付ける。§15-10（取込の並列化）より先にやる。

## 2. 決めたこと

1. **ボタンはファイル 1 本ずつ。**一覧の【要修正】の行だけに出す。「直し終えたか」はファイルごとの判断なので、まとめて戻すボタンは作らない。
2. **やることはメニューの「要修正ファイルを再検査」と同じ。**リースが無いこと・状態が【要修正】のままであることを確かめてから、`rewindFileForReimportAudited_` で取込待ち（`DISCOVERED`）へ戻し、監査ログに 1 行残す。戻す処理を新しく書かない（`97` の `rewindFileForReimport_` の注記「戻す操作は必ずここを通すこと」── 内容ハッシュを消さないと再取込が INV-07 で `FAILED` になる）。
3. **戻すだけでは何も取り込まない。**取込は利用者が［記帳を実行］を押したときだけ。直っていなければ、その取込でもう一度【要修正】になり、新しい理由が出る。
4. **戻すときに転記先へは何も書かない。**読むのはマスター（リース・処理ログ・恒久索引・監査）と Drive の一覧だけ。
5. 押す前に確認を 1 回出す（既存の確認ダイアログ `formatConfirm` を使う）。
6. Drive で最近更新されたファイル（最終更新から 10 分たっていない）は、戻しても 10 分たつまで取り込めない（既存の決まり。変えない）。それを一覧とお知らせで分かるようにする（§3.2・§4.3）。

**ロックを取らない理由：**メニューの `applyRecheck_` と同じ形（リースを確かめ → 状態を確かめ → 戻す）で、ロックの中には入れない。【要修正】のファイルを動かすのは「戻す」操作（このボタン・メニュー・`opsRetryCustomerFixFiles`）と、メニューの除外・取消しだけで、取込は【要修正】のファイルを候補にしない（§15-10 で並列にしても同じ）。2 人が同時に押しても、2 回戻して監査が 2 行になるだけで、状態は同じところに着く。取込が【要修正】へ遷移した直後でリースがまだ残っている間は、リースの確かめで止まる。

## 3. サーバー（`80_WebApp.gs`・`97_Ops.gs`）

### 3.1 `webAppRecheckCustomerFixFile(customerId, folderId, fileId)`（新規・公開関数）

`webAppReturnFileToCustomer` の近く（`webAppWithdrawFormat` の前）に置く。`webAppInvoke_` で包む。手順はこの順：

1. **認可**：`webAppAuthorizeCustomer_(customerId, 'WEBAPP:要修正を取込待ちへ戻す')`（`ROLE.REVIEWER`。メニューの `applyRecheck_` と同じ役割）。
2. **ファイルがそのフォルダにあるか**：`webAppDirectChildFolder_(customer, folderId)` のフォルダの `getFiles()` から `fileId` を探す。無ければ `AuthorizationError('選択されたファイルはこのフォルダにありません。')`（`webAppFormatContext_` と同じ文言）。
3. **リース**：`menuAssertNoLease_(String(fileId), activeLeases_)`。リースがあれば投げる（`LEASE_CONFLICT`。`webAppInvoke_` がメニューと同じ日本語にする）。
4. **状態**：`getFileState(String(fileId))` が `FILE_STATE.CUSTOMER_FIX_REQUIRED` でなければ、何も書かずに
   `{ok: false, code: 'STATE_CHANGED', fileId, fileName, state, stateLabel: menuFileStateLabel_(state)}` を返す（投げない ── 画面は一覧を読み直すだけでよい）。
5. **戻す**：`rewindFileForReimportAudited_(String(fileId), scope.userEmail, {from: FILE_STATE.CUSTOMER_FIX_REQUIRED, operation: 'RECHECK', customerId: String(customerId), reason: 'WEBAPP'})`。
6. 返す：`{ok: true, fileId, fileName, nextState: FILE_STATE.DISCOVERED, waitMinutes}`。
   - `fileName` は Drive の今の名前（【要修正】の接頭辞が付いたまま。接頭辞は次の取込の状態遷移で `updateFilePrefix` が外す）。
   - `waitMinutes` は §3.2 の `webAppStableWaitMinutes_` の値（取り込めるまでの分。もう取り込めるなら 0）。

`fileId` は文字列にしてから比べる・渡す。2〜4 のどれかで止まったときは、処理ログ・恒久索引・監査ログに 1 行も書かない。

### 3.2 一覧の「取込待ち（あと n 分）」を登録済みのファイルにも出す（`webAppFolderFile_`）

いまは、未登録で 10 分たっていないファイルだけ「取込待ち（あと n 分）」と出し、登録済みのファイルは状態の名前（`DISCOVERED` なら「未処理（取込待ち） (DISCOVERED)」）を出す。戻した直後のファイルは登録済みの `DISCOVERED` なので、10 分たっていなくても「未処理（取込待ち）」と出て、［記帳を実行］を押しても取り込まれない理由が分からない。

直し方：

- 分の計算を純関数 `webAppStableWaitMinutes_(updatedMs, nowMs)` に出す：10 分たっていれば（`updatedMs <= nowMs - 10 * 60 * 1000`）0、たっていなければ今と同じ式 `Math.max(1, Math.ceil((10 * 60 * 1000 - (nowMs - updatedMs)) / (60 * 1000)))`。`webAppFolderFile_` の `stable` はこの関数が 0 かどうかで決める（境界の扱いは今と同じ）。
- 状態の名前の決め方：**登録済み・`DISCOVERED`・拡張子が csv/xlsx・10 分たっていない**ときだけ、未登録と同じ「取込待ち（あと n 分）」にする。それ以外は今のまま。
- `importable` の式は変えない。

### 3.3 `97_Ops.gs` の `rewindFileForReimportAudited_`

監査の `reason: 'MENU'` を `reason: context.reason || 'MENU'` にする。**97 で変えるのはこの 1 行だけ。**メニューの呼出し（`applyRecheck_`）は `reason` を渡さないので、メニューの監査は今のまま `MENU`。

注意：97 には文字列の中に生の NUL バイトが 2 つあり、git はバイナリとして扱う（改行を変換しない）。**改行の形（CRLF/LF）を変えないこと。**変えると全行が差分になる。

## 4. 画面（`81_WebAppUi.html`）

### 4.1 呼出しの口

`gasCall` に `webAppRecheckCustomerFixFile`（引数 3 つ）の枝を足す。

### 4.2 ボタン（`renderFiles`）

- 出す行：`file.state === 'CUSTOMER_FIX_REQUIRED'` で、`file.formatReviewId` が無い行だけ。
- 置き場所：状態の列（4 列目）。理由の行（`.fix-reason`）の後に `<br>` を置き、その後にボタン。形式不明の［形式を確認］と同じ並べ方。
- ボタン：`type = 'button'`、`className = 'button'`、文字は `修正済み → 取込待ちに戻す`（`textContent`）、`disabled = isMutationBusy()`。押すと `recheckCustomerFix(file)`。

### 4.3 押したとき（`async function recheckCustomerFix(file)`）

1. `isMutationBusy()` なら何もしない。
2. 確認：`formatConfirm('取込待ちに戻す', '「' + file.fileName + '」を取込待ちに戻します。顧客が元ファイルを直し終えたときだけ戻してください。［記帳を実行］で取り込み直し、まだ直っていなければ、もう一度【要修正】になります。戻すだけでは転記先に何も書きません。')`。取り消したら何もしない（サーバーを呼ばない）。
3. `formatSetBusy(true)` にしてから `gasCall('webAppRecheckCustomerFixFile', [state.selectedCustomerId, state.selectedFolderId, file.fileId])`。
4. 結果ごとのお知らせ（`showNotice`）：
   - `ok === true`：`'「' + result.fileName + '」を取込待ちに戻しました。［記帳を実行］で取り込みます。ファイル名の【要修正】は取り込むと外れます。'`、種類 `success`。`waitMinutes > 0` なら、その後に `'Drive で最近更新されたため、取り込めるのはあと ' + n + ' 分たってからです。'` を続ける（同じ 1 つの文。箇条にしない）。
   - `code === 'STATE_CHANGED'`：`'「' + result.fileName + '」は状態が変わっています（現在: ' + result.stateLabel + '）。一覧を読み直しました。'`、種類 `warning`。
   - それ以外の戻り値（`ok` が無いなど）：`TEXT.unknownFailure`、種類 `error`。
   - 例外：`failureMessage(error)`、種類 `error`。
5. `finally` で `formatSetBusy(false)`。
6. サーバーが応えたとき（成功・`STATE_CHANGED`・その他の戻り値・例外のどれでも）は、その後にファイル一覧を読み直す：`await loadFiles(state.selectedCustomerId, state.selectedFolderId, state.viewGeneration)`。確認で取り消したときは読み直さない。要確認の表は読み直さない（戻す操作は要確認を変えない）。

文字はすべて `textContent`（`showNotice` も今どおり）。`innerHTML` 等は使わない。

## 5. 変えないこと

- メニューの「要修正ファイルを再検査」（`menuRecheck`・`applyRecheck_`）、`opsRetryCustomerFixFiles`、`rewindFileForReimport_`。
- 取込（候補の選び方・10 分の決まり・読取回数）、確定、要修正の理由の記録と表示（K-W22）。
- `importable` の式、ファイル一覧の並び・列、形式不明の行のボタン。
- 既存の確認ダイアログ（`formatConfirm`）とお知らせ（`showNotice`）の作り。

## 6. テスト（`rc N: …`、`test/phase8-webapp.test.js` の `cf 18` の後）

サーバーは実物の世界（`setupWorld`・`putCsv`・`webImport`・`call`）で、画面は `clientEval` か、ボタンを押せる既存のハーネス（`test/phase9-format-registration.test.js` の world。DOM と `gasCall` の記録がある）で書く。どちらを使ったか報告する。

1. **rc 1（戻す）**：用途が空の行がある CSV を取り込み【要修正】にする → `webAppRecheckCustomerFixFile` → `ok: true`・`nextState: 'DISCOVERED'`・`waitMinutes: 0`・`fileName` が Drive の名前。`getFileState` が `DISCOVERED`。処理ログと恒久索引の提出時の内容ハッシュが空。監査ログに 1 行増え、`reason: 'WEBAPP'`・`before.fileState: 'CUSTOMER_FIX_REQUIRED'`・`after: {fileState: 'DISCOVERED', operation: 'RECHECK'}`・`actor` が実行者・`customerId`。**転記先（複製）の値は呼ぶ前と同じ**（転記先へ書いていない）。続けて `webAppListFolder` で、そのファイルが `importable: true`・`fixReason` なし。
2. **rc 2（直してから取り込み直す）**：rc 1 と同じように【要修正】にして戻した後、**同じ fileId の中身を用途を埋めた形に差し替え**、10 分を過ぎた時刻で取り込む → `COMPLETED`（または要確認待ち）になり、`FAILED` にならない。転記先の行は各取引ちょうど 1 回（二重に書かない）。ハーネスに中身を差し替える手段が無ければ、テストファイルの中に補助を足してよい（`test/gas-stubs.js`・`test/gas-harness.js` は変えない）。
3. **rc 3（直さずに取り込み直す）**：戻した後、中身を変えずに取り込む → もう一度 `CUSTOMER_FIX_REQUIRED`、一覧に理由が出る。転記先は変わらない。
4. **rc 4（状態が変わっていた）**：`COMPLETED` のファイルと `DISCOVERED`（戻した後）のファイルそれぞれで呼ぶ → `{ok: false, code: 'STATE_CHANGED', state, stateLabel}`。処理ログ・恒久索引・監査ログの行が呼ぶ前と同じ。
5. **rc 5（リース）**：そのファイルにリースがある状態で呼ぶ → 投げる（メッセージはメニューのリース衝突と同じ日本語）。状態は `CUSTOMER_FIX_REQUIRED` のまま、監査は増えない。
6. **rc 6（場所と認可）**：別のフォルダの fileId・顧客の直下でないフォルダ・認可の無い顧客で呼ぶ → それぞれ投げ、状態は `CUSTOMER_FIX_REQUIRED` のまま、処理ログ・恒久索引は変わらず、**戻す操作の監査（`REVIEW_RESOLVE`）は増えない**。認可の無い顧客では、既存の認可の決まり（`denyAuthorization_`）どおり `PERMISSION`（`DENIED`）の監査が 1 行増える ── これは保つ（1.1 で直した。1.0 は「監査は変わらない」と書いていて、既存の決まりと矛盾していた）。
7. **rc 7（10 分）**：`webAppStableWaitMinutes_` の境界（ちょうど 10 分前は 0、9 分 59 秒前は 1、3 分前は 7）。最終更新が 3 分前のファイルを戻すと `waitMinutes: 7`。一覧ではそのファイルが「取込待ち（あと 7 分）」・`importable: false`、10 分を過ぎると「未処理（取込待ち） (DISCOVERED)」・`importable: true`。未登録のファイルの表示は今と同じ。
8. **rc 8（読取）**：rc 1 の呼出し 1 回の Sheets 読取（`batchGet`）を測り、**測った値そのものを上限**として固定する（budget の方針）。Sheets の書込は転記先（複製）に 0 回。値は報告に書く。
9. **rc 9（ボタンの出る行）**：【要修正】の行にだけボタンが 1 つ出る（`DISCOVERED`・`COMPLETED`・未登録・形式不明の行には出ない）。文字が `修正済み → 取込待ちに戻す`。忙しいとき（取込中など）は `disabled`。
10. **rc 10（押す）**：確認で取り消す → サーバーを呼ばない・一覧を読み直さない。確認で実行 → `[顧客ID, フォルダID, fileId]` で 1 回呼ぶ、呼んでいる間は忙しい、終わると忙しくない、お知らせが §4.3 の文（`success`）、その後に一覧を 1 回読み直す。`waitMinutes > 0` の文も確かめる。
11. **rc 11（押した結果が失敗）**：`STATE_CHANGED` → `warning` の文と読み直し。例外 → `error` の文と読み直し。どちらも終わった後は忙しくない。
12. **rc 12（安全な描き方）**：`renderFiles` と `recheckCustomerFix` が `textContent` だけを使う（`innerHTML` 等が無い ── `cf 18` の検査が全体に効いていることも確かめる）。

## 7. 変異（R1〜R14）── それぞれ赤になるテストを記録する

- R1：リースの確かめを消す
- R2：状態の確かめを消す（どの状態でも戻す）
- R3：状態の確かめを戻す処理の後に動かす
- R4：`reason: 'WEBAPP'` を渡さない（監査が `MENU` になる）
- R5：97 で `context.reason` を見ない（常に `MENU`）
- R6：`rewindFileForReimportAudited_` の代わりに `updateProcessLog(fileId, {internalState: 'DISCOVERED'})` と `appendAudit` を直接呼ぶ（内容ハッシュを消さない）
- R7：フォルダにあるかの確かめを消す
- R8：`webAppStableWaitMinutes_` が常に 0 を返す
- R9：一覧で、登録済みの `DISCOVERED` に「あと n 分」を出さない（今の形に戻す）
- R10：ボタンをすべての登録済みの行に出す
- R11：確認を出さずにサーバーを呼ぶ
- R12：成功の後に一覧を読み直さない
- R13：`finally` を外す（例外のとき忙しいまま残る）
- R14：`STATE_CHANGED` のときも成功のお知らせを出す

## 7.1 実装と監査の記録（2026-10-14）

- Codex 1 回目（`tools/codex-logs/*-20261014-*`）：1.0 の rc 6 が既存の決まり（認可の拒否は `denyAuthorization_` が `PERMISSION` の監査を書く）と矛盾するのを見つけ、実装前で停止 → 1.1 で直した。
- Codex 2 回目（`out-20261014-181518-01.txt`）：開始 1497/1497 → 終了 1510/1510（rc 1〜8・12 は phase8 の `cf 18` の後、rc 9〜11 は phase9 の DOM ハーネス）。rc 8 の読取は**実測 6 回をそのまま上限**、転記先への書込 0。R1〜R14 はすべて赤。phase9 の 2 行の削除は、テストの土台（呼べる関数の一覧・画面の関数の取り出し）を広げた行の置き換えで、既存の期待は変わっていない。
- 監査：src の差分は 80・81・97 だけ（97 は `reason: context.reason || 'MENU'` の 1 行、改行は LF のまま、NUL 2 個）。他の src・test は開始時の md5 と一致。`???` 0。U+FFFD は既存の `phase1a`（わざと入れた文字）だけ。新しい関数名の重複なし。全体 1510/1510 を私の手元でも確かめた。
- 私の変異 X1〜X14（形式不明の行にもボタン・拡張子の確かめを外す・取り消しでも一覧を読み直す・認可を SYSTEM_ADMIN に上げる・fileId を文字列にしない・お知らせの種類・待ち分の文を出さない・リースと状態の順を入れ替える・ボタンを常に押せる・押した後の忙しさの確かめを外す・待ち分を常に 0・監査の顧客IDを落とす・押している間に忙しくしない・10 分ちょうどの境界）はすべて赤。
- 残したこと（直さない）：`webAppRecheckCustomerFixFile` は `file.getLastUpdated().getTime()` をそのまま使う（`webAppFolderFile_` は文字列の日付も受ける形）。Apps Script の `getLastUpdated` は常に `Date` を返すので、実害はない。

## 8. 受入（実機）

push 後、Web アプリを開き直して（F5）：

1. セゾンカードのフォルダを開くと、SAISON_2504 の行に理由と［修正済み → 取込待ちに戻す］が出る。
2. 押す → 確認 → 実行 → お知らせ「…を取込待ちに戻しました…」、一覧で SAISON_2504 が「未処理（取込待ち）」（10 分以内に直していれば「取込待ち（あと n 分）」）。
3. ［記帳を実行］→ 直っていれば【済】か要確認待ち、直っていなければもう一度【要修正】と理由。Drive のファイル名から【要修正】が外れる（もう一度【要修正】になったら付く）。
4. `opsShowLeases` が `(リースなし)`。監査ログの最後の行が `REVIEW_RESOLVE`・理由 `WEBAPP`。

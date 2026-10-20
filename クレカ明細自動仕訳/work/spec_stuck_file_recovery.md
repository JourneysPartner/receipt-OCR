# 止まった・失敗したファイルを Web アプリから取込待ちへ戻す 仕様書（K-W12）

版：1.1（2026-10-20。1.0 は「止まった」の待ち時間を 420 秒＝7 分と書いたが、それは設定の**下限**で、今の設定 `LEASE_FORCE_RELEASE_MIN_SECONDS` は 600 秒＝10 分だった ── Codex の指摘。§2 の 3・§4.1・§5.2・§7 の sf 1・4・9・11 を直した）
対象：`src/80_WebApp.gs`・`src/81_WebAppUi.html`・`src/97_Ops.gs`。
発端：`spec_webapp.md` §14 の K-W12「画面に『処理中のまま停止』を出しても、戻す手段が画面に無い」。

## 1. 背景

- 取込の途中で止まったファイルは、画面の一覧に「処理中（読取・検証中） (VALIDATING)」「処理中（転記中） (WRITING)」「失敗 (FAILED)」と出たまま、`importable: false` で何もできない。取込が `FAILED` を返すと、画面は「このファイルは処理中のまま止まっています。管理者へ連絡してください。」（81 の `TEXT.stuckFile`）を出す。メニューにも戻す操作は無い（一覧に「停止の疑い」が出るだけ）。
- 戻す道は運用関数 2 つだけで、どちらも管理者が `clasp run-function` で動かす：
  1. `opsRecoverStuckFiles`（97）：`VALIDATING`/`WRITING` のファイル（と、転記行の無い `REVIEW_REQUIRED` を持つ `REVIEW_WAIT`）を、**書きかけの行を先に仕上げてから**（`recoverPartialFailure`、43）発見へ戻す。転記先は取引ログ AC・AD から選び（`stuckFileWriteCustomer_`）、行を持つ取引がその転記先の索引に居るかを検算してから書く（K-W10・§15-4）。
  2. `opsRetryFailedFiles`（97）：`FAILED` のファイルを `rewindFileForReimport_` で**戻すだけ**。
- **2 の「戻すだけ」は二重転記を起こし得る**（2026-10-20 にコードで確かめた）。書込の途中の例外（70 の段階 2 ＝ `writeStarted && !valuesWritten`）は、転記先に取引ID入りの行を残したまま `FAILED` になる（71 の `catch` は回復しない）。戻して取り込み直すと、書込（70 の `getTransactionsByStatus(fileId, [PREPARED, WRITING])` → `reserveDestinationRows`）は残った行を見ずに**新しい行を予約する**ので、同じ取引が 2 行になる。前検査の `DUPLICATE_DESTINATION_ROW` は 2 行になった後でしか止めない。1 の手順は索引で取引IDを引いて残った行を仕上げるので、この形にならない。

**利用者の決定（2026-10-20）：**
1. 戻すボタンを出すのは「処理中のまま 7 分以上動きがないファイル」と「失敗のファイル」。動いている取込には出さない。
2. 押すと取込待ち（`DISCOVERED`）に戻すだけ。1 本ずつ・確認つき（K-W23 と同じ形）。取り込むのは続けて［記帳を実行］を押したとき。
3. 失敗のファイルの行に失敗の理由を出す（K-W22 の要修正の理由と同じ出し方）。

**私の判断（利用者に伝えて了承）：**画面のボタンは 1 の安全な手順だけを使い、`opsRetryFailedFiles` も同じ手順に直す。

## 2. 決めたこと

1. **戻す手順は 1 つだけにする。**97 に部品 `recoverStuckFile_`（§3.1）を置き、`opsRecoverStuckFiles`・`opsRetryFailedFiles`・Web アプリの 3 つがこれを使う（`rewindFileForReimport_` の注記「戻す操作は必ずここを通すこと ── 経路ごとに書くと、新しい経路を足したときに同じ失敗を繰り返す」と同じ考え）。
2. **リースを先に取り、取った後に状態を確かめ直す。**今の `opsRecoverStuckFiles` は、書くものが無いファイルをリース無しで戻し、書くものがあるときも転記先を選んでからリースを取る。確かめてから戻すまでの間に別の操作（2 人目の「戻す」→ 取込）が入ると、取込中のファイルを発見へ戻して壊し得る。リースを持っている間は取込も解決操作もそのファイルに触れないので、そこで状態を読み直せば足りる。
3. **「止まった」の判定は強制解放の待ち時間に合わせる。**`VALIDATING`/`WRITING` で、そのファイルのリースが無いか、すべてのリースの最後の心拍から `leaseForceReleaseMinSeconds_()` 秒を**超えて**いるもの。この値は設定 `LEASE_FORCE_RELEASE_MIN_SECONDS`（**今は 600 秒＝10 分**。420 秒を割る設定は拒まれる）で、`forceReleaseLease` もこれより前には解放しない。比較は `forceReleaseLease` と同じ（`elapsed > min` なら止まった、`elapsed <= min` なら動いている扱い）。心拍は今は取得時刻のまま更新されない（11 の注記）ので、この時間を超えたリースの持ち主は Apps Script の 6 分の上限で必ず止められている（K-W21）。**利用者に伝えた「7 分」は私の読み違いで、実際は設定どおり 10 分**（動いている取込を止めない、という決定の趣旨は同じ）。
4. **「失敗」は `FAILED` でリースが無いもの。**`FAILED` にリースが残っていたら状態の食い違いなので、ボタンを出さない（今どおり管理者が `opsReleaseInvestigatedLease` で調べて解放する）。
5. **`REVIEW_WAIT` は画面に出さない。**転記行の無い `REVIEW_REQUIRED` を持つ `REVIEW_WAIT` は一覧からは見分けられず、利用者の目にも止まっていない。今どおり `opsRecoverStuckFiles` だけが拾う。
6. **失敗の理由は固定の語彙だけで出す。**処理ログのエラー欄の最後の記録の `code` と、`ERROR_CATALOG` にあればその日本語。エラーの本文（`detail`・`message`）は画面へ出さない（スプレッドシートID などを含み得る。71 の通知も固定語彙だけで束ねている）。止まったファイルはエラーが記録されない（殺されたので）ので、決まった文を出す。
7. **戻すとき転記先へ書くことがある。**書きかけの行の仕上げと、取引ログに載って書かれていない取引の書込（`recoverPartialFailure` の Step 3〜5）は、今の `opsRecoverStuckFiles` と同じく行う。確認の文でそれを伝える。

## 3. 97（`97_Ops.gs`）

### 3.1 `recoverStuckFile_(row, actor, options)`（新規・非公開）

`opsRecoverStuckFiles` の今の 1 ファイルぶんの処理（`results = stuck.map(...)` の中、リースの強制解放より後）を、ここへ移す。`stuckFileWriteCustomer_` の前に置く。

引数：
- `row`：恒久索引の行の形（`fileId`・`customerId`・`state`・`originalFileName` を使う）。
- `actor`：実行者のメール。
- `options`：`{runId, everyReview, audit}`。`runId` は必須。`everyReview` が無ければ、要るとき（手順 2.4）に初めて `allReviewRecords_()` を読む（書くものが無いファイルで要確認の表を読まない）。`audit` は `null` か `{customerId, reason}`。

手順（この順）：
1. `outcome = {fileName: row.originalFileName, fileId: row.fileId, state: row.state}`。
2. `try` の中で：
   1. **リースを取る**：`leaseId = acquireLease(String(row.customerId), String(row.fileId), options.runId, actor, purpose)`。`purpose` は `row.state` が `VALIDATING`/`WRITING` なら `LEASE_PURPOSE.PROCESS`、それ以外（`FAILED`・`REVIEW_WAIT`）は `LEASE_PURPOSE.WRITE_ONLY`。
      **理由：**この処理が 6 分で殺されると取ったリースが残る。`PROCESS` のリースは、ファイルが `VALIDATING`/`WRITING` でないと `forceReleaseLease` が拒み（11）、誰も自動では解放できない。`WRITE_ONLY` は状態を問わず止まったリースとして拾える（`leaseStallCheck_`）。
   2. **状態を確かめ直す**：`current = getFileState(String(row.fileId))`。`current !== row.state` なら `outcome.code = 'STATE_CHANGED'`・`outcome.currentState = current` にして戻る（何も書かない）。
   3. `pending = recoveryTargetsFor_(row.fileId)`。空なら今と同じ：`outcome.recovered = []`・`outcome.stopped = null`・`outcome.nothingToRecover = true`、`row.state !== REVIEW_WAIT` なら戻して（§3.2）`outcome.rewound = true`。戻る。
   4. `fileTxs`・`chosen = stuckFileWriteCustomer_(row, everyReview, fileTxs)`・`outcome.destinationSource` は今と同じ。`AMBIGUOUS` なら今と同じ `outcome.error` の文に加えて `outcome.code = 'DESTINATION_AMBIGUOUS'`。戻る。
   5. `index = buildIndex(customer, {})`、行の検算は今と同じ。食い違えば今と同じ `outcome.error`・`outcome.misplaced` に加えて `outcome.code = 'DESTINATION_MISMATCH'`。戻る。
   6. `recovered = recoverPartialFailure(row.fileId, options.runId, index, leaseId, {customer: customer})`。`outcome.recovered`・`outcome.stopped` は今と同じ。`!recovered.stopped && row.state !== REVIEW_WAIT` なら戻して `outcome.rewound = true`。`recovered.stopped` があれば `outcome.code = 'RECOVERY_STOPPED'`。
3. `catch (error)`：今と同じ `outcome.error = String(code || '') + ' ' + String(message)` に加えて `outcome.code = (error && error.code) || 'UNEXPECTED_ERROR'`（`LEASE_CONFLICT` もここに来る）。
4. `finally`：`leaseId` があれば `releaseLeaseById(leaseId, 'RECOVERY_DONE')`。
5. `outcome` を返す。成功した回は `outcome.code` を付けない（`undefined`）。

### 3.2 戻し方

`options.audit` があれば `rewindFileForReimportAudited_(String(row.fileId), actor, {from: row.state, operation: 'RECOVER', customerId: String(options.audit.customerId), reason: String(options.audit.reason)})`、無ければ今と同じ `rewindFileForReimport_(row.fileId)`（運用関数の監査は今のまま増やさない）。

### 3.3 `opsRecoverStuckFiles`

- 対象の選び方（`stuck` の filter）と、ファイルごとの止まったリースの強制解放（`detectStalledLeases` → `forceReleaseLease(…, 'EXECUTION_TIMEOUT', actor)`、拒否は `outcome.leaseNote`）は今のまま。
- その後の 1 ファイルぶんは `recoverStuckFile_(row, actor, {runId: runId, everyReview: everyReview, audit: null})` を呼び、`leaseNote` があれば返った `outcome` に移す。
- 戻り値の形と `Logger.log` は今のまま（`outcome` に `code`・`currentState` が増えるだけ）。
- **振る舞いが変わる所（意図どおり）：**書くものが無いファイルもリースを取ってから戻す。強制解放が拒まれたリース（心拍から 300〜420 秒）が残っていれば、今はリース無しで戻していたが、これからは `LEASE_CONFLICT` で戻さない（その持ち主はまだ生きているかもしれない ── K-W21 の下限の理由そのもの）。

### 3.4 `opsRetryFailedFiles`

`FAILED` の行ごとに `recoverStuckFile_(row, actor, {runId: 'RUN_' + Utilities.getUuid(), everyReview: everyReview, audit: null})` を呼ぶ（`actor = activeUserEmail_()`、`everyReview` は最初に 1 回だけ読む）。`outcome.rewound === true` のファイルだけ `retried` に入れる。`Logger.log(JSON.stringify({retried: retried, results: results}, null, 2))`、戻り値は今と同じ `retried`（fileId の配列）。説明のコメントに「戻すだけだと書込の途中の例外で残った行を二重に書くので、止まったファイルと同じ手順を通す」理由を書く。

注意：97 には文字列の中に生の NUL バイトが 2 つあり、git はバイナリとして扱う（改行を変換しない）。**改行の形（今は LF）を変えないこと。NUL の 2 バイトを保つこと。**

## 4. サーバー（`80_WebApp.gs`）

### 4.1 一覧（`webAppListFolder`・`webAppFolderFile_`）

`stateByFileId` を作った後、フォルダのファイルに `VALIDATING`・`WRITING`・`FAILED` の登録済みファイルが 1 つでもあるときだけ：

1. **リースを 1 回だけ読む**：`activeLeases_()`。読めなければ（例外）、それらのファイルは `recoverable: false`・`leaseUnavailable: true`（一覧そのものは返す）。
2. ファイルごとに `recoverable` を決める（無いファイルは `recoverable: false`）：
   - `VALIDATING`/`WRITING`：そのファイルのリースが無いか、すべてのリースで `(nowMs - new Date(lease.lastHeartbeat).getTime()) / 1000 > leaseForceReleaseMinSeconds_()` なら `recoverable: true`・`stuck: true`・`stuckAfterMinutes: Math.ceil(leaseForceReleaseMinSeconds_() / 60)`（画面の文に使う。今の設定なら 10）。`stateLabel` を `'処理中のまま止まっています (' + state + ')'` にする。それ以外は今の表示のまま。
   - `FAILED`：そのファイルのリースが無ければ `recoverable: true`。
3. **失敗の理由**：`FAILED` のファイルには `failReason` を付ける。処理ログの読取は、今の要修正の理由の読取（`findRowsByColumnValues_(processLogSheet_(), …)`）と**1 回にまとめる**（要修正と失敗のファイルの fileId を合わせて渡す）。要修正のファイルの `fixReason` の決め方・失敗時の `UNAVAILABLE` は今のまま。
   - 新しい純関数 `webAppFailedFileReason_(errorsCell)`：`jsonCell_` で読み、配列でなければ `{source: 'NONE'}`。**後ろから**見て、`truncated` でなく `code` が空でない文字列の最初の記録を採る。無ければ `{source: 'NONE'}`。採れたら `{source: 'ERROR', code: String(code), label: ERROR_CATALOG[code] ? ERROR_CATALOG[code].message : null}`。**`detail` などほかの項目は返さない。**
   - 処理ログの行がちょうど 1 行でなければ `{source: 'NONE'}`、読取の例外なら `{source: 'UNAVAILABLE'}`（K-W22 と同じ）。
4. `importable` の式は変えない。

読取：上の 3 種類のファイルが無いフォルダは今と同じ回数（増やさない）。ある場合はリースの 1 回（`batchGet` 1 回）、要修正のファイルが無いのに失敗のファイルがあるときだけ処理ログの読取 1 回（`findRowsByColumnValues_` 1 回＝キー列と行で `batchGet` 2 回）が増える。

### 4.2 `webAppRecoverStuckFile(customerId, folderId, fileId)`（新規・公開関数）

`webAppRecheckCustomerFixFile` の後に置く。`webAppInvoke_` で包む。手順はこの順：

1. **認可**：`scope = authorize(ROLE.SYSTEM_ADMIN, String(customerId), {operation: 'WEBAPP:止まったファイルを取込待ちへ戻す'})`、`customer = scope.customers[0]`。**管理者にする理由：**戻すときに転記先へ書くことがあり（§2 の 7）、`forceReleaseLease` は顧客の管理者を求める。
2. **ファイルがそのフォルダにあるか**：`webAppDirectChildFolder_(customer, folderId)` のフォルダの `getFiles()` から `fileId` を探す。無ければ `AuthorizationError('選択されたファイルはこのフォルダにありません。')`。
3. **登録の行**：`permanentIndexRowsForScan_()` から `fileId` の行を探す。無ければ `{ok: false, code: 'STATE_CHANGED', fileId, fileName, state: null, stateLabel: '未登録'}` を返す（何も書かない）。行の `customerId` が `customerId` と違えば 2 と同じ `AuthorizationError`。
4. **状態**：`state = getFileState(fileId)`。`VALIDATING`・`WRITING`・`FAILED` でなければ `{ok: false, code: 'STATE_CHANGED', fileId, fileName, state, stateLabel: menuFileStateLabel_(state)}` を返す（何も書かない）。
5. **リース**：`leases = activeLeases_()` のうちこの `fileId` のもの。
   - `FAILED`：1 つでもあれば `menuAssertNoLease_` と同じく `leaseConflict_` を投げる（何も書かない）。
   - `VALIDATING`/`WRITING`：1 つでも心拍からの経過が `leaseForceReleaseMinSeconds_()` 秒以下なら、何も書かずに `{ok: false, code: 'STILL_RUNNING', fileId, fileName, waitMinutes: Math.max(1, Math.ceil((min - 最も新しいリースの経過秒) / 60))}` を返す。すべて超えていれば、それぞれ `forceReleaseLease(lease.leaseId, 'WEBAPP_STUCK_RECOVERY', scope.userEmail)`（監査 `LEASE_FORCE_RELEASE` が残る）。
6. **戻す**：`outcome = recoverStuckFile_({fileId, customerId: String(customerId), state, originalFileName: 行の originalFileName}, scope.userEmail, {runId: 'RUN_' + Utilities.getUuid(), audit: {customerId: String(customerId), reason: 'WEBAPP'}})`。
7. 返す：
   - `outcome.rewound === true`：`{ok: true, fileId, fileName, nextState: FILE_STATE.DISCOVERED, recovered: (outcome.recovered || []).length, waitMinutes: webAppStableWaitMinutes_(file.getLastUpdated().getTime(), Date.now())}`。
   - `outcome.code === 'STATE_CHANGED'`：`{ok: false, code: 'STATE_CHANGED', fileId, fileName, state: outcome.currentState, stateLabel: menuFileStateLabel_(outcome.currentState)}`。
   - それ以外：`{ok: false, code: outcome.code || 'RECOVERY_FAILED', fileId, fileName, label: ERROR_CATALOG[code] ? ERROR_CATALOG[code].message : null}`。**`outcome.error` の本文は返さない**（§2 の 6）。

`fileName` は Drive の今の名前。`fileId` は文字列にしてから比べる・渡す。2〜5 で止まったときは、処理ログ・恒久索引・取引ログ・リース・監査・転記先に 1 行も書かない（認可の拒否で既存の決まりどおり `PERMISSION` の監査が 1 行増えるのは保つ）。

### 4.3 呼出しの文言（81 の `TEXT.stuckFile`）

取込が `FILE_FAILED` で止まったときの文を、戻すボタンへ案内する形に変える：
`'取り込めなかったファイルがあります。ファイル一覧の［取込待ちに戻す］で戻してから、もう一度［記帳を実行］を押してください。同じ理由でまた止まるときは管理者へ連絡してください。'`

既存のテスト `multi 6` の期待（`clientStoppedByMessage('FILE_FAILED')` の文）だけは、この文に置き換える（**既存の期待を変えてよいのはこの 1 か所だけ**）。

## 5. 画面（`81_WebAppUi.html`）

### 5.1 呼出しの口

`gasCall` に `webAppRecoverStuckFile`（引数 3 つ）の枝を足す。

### 5.2 一覧の行（`renderFiles`）

`file.recoverable === true` の行だけ（`file.formatReviewId` が無いこと）。状態の列（4 列目）に、今の要修正の理由と同じ `div.fix-reason` で理由を足し、その後に `<br>` とボタン：

- 理由：
  - `FAILED`：純関数 `failedFileReasonLines(failReason)` で作る。`source === 'ERROR'` で `label` があれば `'理由：' + label + '（' + code + '）'`、`label` が無ければ `'理由：' + code`。`NONE`（と未知の `source`）は `'理由の記録はありません'`、`UNAVAILABLE` は `'理由を読み込めませんでした'`。
  - `stuck`：`file.stuckAfterMinutes + ' 分以上動きがありません。実行の時間の上限（6 分）で止まった可能性があります。'`
- ボタン：`type = 'button'`、`className = 'button'`、文字は `取込待ちに戻す`、`disabled = isMutationBusy()`。押すと `recoverStuckFile(file)`。

`recoverable` でない `VALIDATING`/`WRITING`/`FAILED` の行は今のまま（ボタンも理由も無い）。

### 5.3 押したとき（`async function recoverStuckFile(file)`）

1. `isMutationBusy()` なら何もしない。
2. 確認：`formatConfirm('取込待ちに戻す', '「' + file.fileName + '」を取込待ちに戻します。途中まで転記した行があれば、先に仕上げてから戻します（同じ取引を二重に書きません）。取り込み直すのは［記帳を実行］を押したときです。同じ理由でまた止まるときは管理者へ連絡してください。')`。取り消したら何もしない（サーバーを呼ばない・一覧を読み直さない）。
3. `formatSetBusy(true)` にしてから `gasCall('webAppRecoverStuckFile', [state.selectedCustomerId, state.selectedFolderId, file.fileId])`。
4. 結果ごとのお知らせ（`showNotice`）：
   - `ok === true`：`'「' + fileName + '」を取込待ちに戻しました。［記帳を実行］で取り込みます。'`。`recovered > 0` なら `'途中まで転記していた ' + recovered + ' 件を仕上げました。'`、`waitMinutes > 0` なら `'Drive で最近更新されたため、取り込めるのはあと ' + waitMinutes + ' 分たってからです。'` をこの順で続ける（1 つの文。箇条にしない）。種類 `success`。
   - `code === 'STATE_CHANGED'`：`'「' + fileName + '」は状態が変わっています（現在: ' + stateLabel + '）。一覧を読み直しました。'`、`warning`。
   - `code === 'STILL_RUNNING'`：`'「' + fileName + '」はまだ取込中の可能性があります。あと ' + waitMinutes + ' 分たってから、一覧を読み直してもう一度お試しください。'`、`warning`。
   - ほかの `code`：`'「' + fileName + '」を戻せませんでした（' + (label || code) + '）。管理者へ連絡してください。'`、`error`。
   - それ以外の戻り値：`TEXT.unknownFailure`、`error`。例外：`failureMessage(error)`、`error`。
5. `finally` で `formatSetBusy(false)`。
6. サーバーが応えたとき（どの結果・例外でも）、その後にファイル一覧を読み直す：`await loadFiles(state.selectedCustomerId, state.selectedFolderId, state.viewGeneration)`。要確認の表は読み直さない。

文字はすべて `textContent`（`showNotice` も今どおり）。`innerHTML` 等は使わない。

## 6. 変えないこと

- メニュー、取込（候補の選び方・10 分の決まり・書込・読取回数）、確定、`recoverPartialFailure`・`recoveryTargetsFor_`（43）、`stuckFileWriteCustomer_`、`rewindFileForReimport_`・`rewindFileForReimportAudited_`、`forceReleaseLease`・`leaseStallCheck_`・`detectStalledLeases` と K-W21 の下限、定期取込が `opsRecoverStuckFiles` を呼ぶこと。
- `importable` の式、ファイル一覧の並び・列、要修正の行（K-W22・K-W23）と形式不明の行のボタン。
- `opsRecoverStuckFiles` の対象の選び方と戻り値の形、`opsRetryFailedFiles` の戻り値の形。

## 7. テスト（`sf N: …`）

サーバーは `test/phase8-webapp.test.js` の最後のテストの後（実物の世界：`setupWorld`・`putCsv`・`webImport`・`seedPartnerViaWeb`・`forceFileState`・`clearDestinationRow`・`txIdRowsIn` など）、画面は `test/phase9-format-registration.test.js` の world（DOM と `gasCall` の記録）で書く。補助はテストファイルの中に置いてよい（`test/gas-stubs.js`・`test/gas-harness.js`・`test/fixtures/` は変えない）。

1. **sf 1（止まった WRITING を戻す）**：`seedPartnerViaWeb` で複製へ取り込み、1 件の行番号を消して（`clearDestinationRow`、45h と同じ）`WRITING` にする（リース無し）。一覧でそのファイルが `recoverable: true`・`stuck: true`・`stateLabel` が `処理中のまま止まっています (WRITING)`。`webAppRecoverStuckFile` → `ok: true`・`recovered: 1`・`nextState: 'DISCOVERED'`。状態が `DISCOVERED`、提出時の内容ハッシュが空、監査に `REVIEW_RESOLVE`（`reason: 'WEBAPP'`・`before.fileState: 'WRITING'`・`after: {fileState: 'DISCOVERED', operation: 'RECOVER'}`・`actor`・`customerId`）が 1 行、リースが残らない。複製の各取引はちょうど 1 行、雛形は 0 行。続けて**新しい押下（転記先を渡さない `webImport`）**で取り込み直す → `FAILED` にならず、どの転記先にも取引の行が増えない。**新しい押下が空の複製を 1 枚作るのは今の作り（押下ごとに複製を作る）で、確かめない**（1.1 で明記。行が増えないことだけを見る）。
2. **sf 2（書込の途中の例外で FAILED ── 二重転記の形）**：転記先に取引ID入りの行を残したまま取引が `WRITING`/`PREPARED` で `FAILED` になったファイルを作る（既存の障害注入点か、テストの中の補助で書込の途中に例外を起こす。作り方を報告する）。(a) 一覧で `recoverable: true`・`failReason.source: 'ERROR'`。(b) `webAppRecoverStuckFile` → `ok: true`・`recovered ≥ 1`、同じ転記先で各取引ちょうど 1 行。(c) 取り込み直しても各取引ちょうど 1 行。**同じ形で今の `opsRetryFailedFiles`（戻すだけ）→ 取込だと 2 行になることを、作る前に赤で確かめて報告する。**
3. **sf 3（何も書かずに FAILED）**：書く前の例外で `FAILED` にする → 戻す → `recovered: 0`・`DISCOVERED`。取り込み直して完了（または要確認待ち）、各取引ちょうど 1 行。
4. **sf 4（動いている取込）**：**今の設定（600 秒）のまま**、`WRITING` でリースの心拍が今・599 秒前・600 秒前 → 一覧は `recoverable: false`・今の `stateLabel`、`webAppRecoverStuckFile` → `STILL_RUNNING`（`waitMinutes` を確かめる。今なら 10、599 秒前なら 1）、処理ログ・恒久索引・取引ログ・リース・監査・転記先が呼ぶ前と同じ。601 秒前 → 一覧は `recoverable: true`・`stuckAfterMinutes: 10`、呼ぶと `ok: true`、監査に `LEASE_FORCE_RELEASE`（`reason: 'WEBAPP_STUCK_RECOVERY'`・`actor`）、リースが残らない。**続けて設定を一時的に 420 にして**（`finally` で戻す）、420 秒前は `STILL_RUNNING`、421 秒前は `recoverable: true`・`stuckAfterMinutes: 7`（判定が設定に従うこと）。
5. **sf 5（FAILED にリース）**：`FAILED` にリースがある → 一覧は `recoverable: false`、呼ぶとリース衝突の日本語で投げる。何も変わらない。
6. **sf 6（状態）**：`COMPLETED`・`DISCOVERED`・`REVIEW_WAIT`・`CUSTOMER_FIX_REQUIRED`・未登録のファイルで呼ぶ → `STATE_CHANGED`（未登録は `state: null`・`stateLabel: '未登録'`）。何も書かない。一覧でもそれらは `recoverable: false`。
7. **sf 7（リースを取った後の確かめ直し）**：`recoverStuckFile_` がリースを取った直後に状態が変わる形（テストの中で `acquireLease` を包み、取った後に状態を `DISCOVERED` へ変える）→ `STATE_CHANGED`・回復も戻しもしない・リースは解放される。Web からも同じ（`STATE_CHANGED` と今の状態が返る）。
8. **sf 8（断る形）**：45i（要確認行が別の転記先を指す）と 45j（雛形と仮定して検算が止める）と同じ形を Web から → `ok: false`・`code: 'DESTINATION_MISMATCH'`（`label` は `ERROR_CATALOG` の文）、要確認行が 2 つの転記先を指す形 → `DESTINATION_AMBIGUOUS`（`label: null`）。どれも状態は `WRITING` のまま、雛形に行が増えない、リースが残らない、戻り値に `outcome.error` の本文が無い。
9. **sf 9（場所と認可）**：別のフォルダの fileId・顧客の直下でないフォルダ・認可の無い顧客・確認担当者だけの利用者・恒久索引の顧客が違うファイル → それぞれ投げ、状態・処理ログ・恒久索引・取引ログ・要確認・リース・転記先の**値**は変わらず、`REVIEW_RESOLVE`・`LEASE_FORCE_RELEASE` の監査は増えない（認可の拒否の `PERMISSION` は既存の決まりどおり）。**比べるのは業務の表の値と、`PERMISSION` 以外の監査行だけ**（1.1 で明記。監査ログに `PERMISSION` の行が増えることで起きる表の形の違い ── 行数・空行・列幅 ── は比べない）。
10. **sf 10（失敗の理由）**：`webAppFailedFileReason_` を直接と一覧の両方で：最後の記録が `DESTINATION_MISMATCH`（`label` が `ERROR_CATALOG` の文）、カタログに無いコード（`label: null`）、前に `SOURCE_REQUIRES_CUSTOMER_FIX`・後に失敗の記録（後を採る）、先頭の `truncated` の印（飛ばす）、`code` の無い記録だけ・空・壊れた JSON（`NONE`）、処理ログの読取が投げる（`UNAVAILABLE`、一覧は返る、要修正の `fixReason` も今どおり `UNAVAILABLE`）。**どの形でも戻り値に `detail` の文字列が出ない。**
11. **sf 11（読取）**：一覧の Sheets 読取（`batchGet`）を、(a) 3 種類のファイルが無いフォルダ（**今の実装で測った値と同じ**であること）、(b) 止まった `WRITING` だけ、(c) `FAILED` だけ、(d) `FAILED` と要修正が両方、で測り、**測った値そのもの**を上限にする。`webAppRecoverStuckFile` の sf 3 の形（書くものが無い）の読取も測った値を上限にし、転記先への書込が 0 回であること。値は報告に書く。（1.0 の Codex の途中の実測：作る前 (a)〜(d) が 2・2・2・4、作った後 2・3・5・5、回復 13。§4.1 の説明どおりなので、最後のコードで測り直した値をそのまま置く。）
12. **sf 12（`opsRetryFailedFiles`）**：sf 2 の形 → `retried` にその fileId、各取引ちょうど 1 行、取り込み直しても 1 行。`FAILED` にリースがあるファイル → `retried` に入らず `FAILED` のまま。回復の間に取ったリースの目的が `WRITE_ONLY`。既存の `opsRetryFailedFiles rewinds only FAILED files to DISCOVERED` は緑のまま。
13. **sf 13（`opsRecoverStuckFiles` のリースを先に）**：書くものが無い `WRITING` に心拍から 360 秒のリース（`detectStalledLeases` は拾い、`forceReleaseLease` は拒む）→ `code: 'LEASE_CONFLICT'`・`leaseNote` あり・`rewound` なし・`WRITING` のまま（**今の実装では戻ってしまうことを赤で確かめる**）。`WRITING` の回復で取ったリースの目的が `PROCESS`、`REVIEW_WAIT` の回復では `WRITE_ONLY`。既存の 45h〜45k・notify の `opsRecoverStuckFiles` のテストは緑のまま。
14. **sf 14（取込が止まったときの文）**：`clientStoppedByMessage('FILE_FAILED')` が §4.3 の文。
15. **sf 15（ボタンの出る行）**：`recoverable` の `FAILED`・止まった `WRITING` の行にだけボタンが 1 つ（文字 `取込待ちに戻す`）。動いている `WRITING`・リースのある `FAILED`・`DISCOVERED`・`COMPLETED`・要修正（自分のボタンだけ）・形式不明・未登録の行には出ない。理由の行（`FAILED` の 3 種類と `stuck` の文）。忙しいときは `disabled`。
16. **sf 16（押す）**：確認で取り消す → サーバーを呼ばない・一覧を読み直さない。実行 → `[顧客ID, フォルダID, fileId]` で 1 回呼ぶ、呼んでいる間は忙しい、終わると忙しくない、§5.3 の `success` の文（`recovered`・`waitMinutes` のある形とない形）、一覧を 1 回読み直す。
17. **sf 17（押した結果が失敗）**：`STATE_CHANGED`・`STILL_RUNNING` → `warning` の文、ほかの `code`（`label` あり・なし）→ `error` の文、例外 → `error`。どれも読み直し、終わった後は忙しくない。
18. **sf 18（安全な描き方）**：`renderFiles`・`recoverStuckFile`・`failedFileReasonLines` が `textContent` だけを使う。

## 8. 変異（R1〜R24）── それぞれ赤になるテストを記録する

- R1：Web でリースの経過を見ない（動いている取込も戻す）
- R2：経過の比較を `>=` にする（ちょうど 420 秒を止まった扱い）
- R3：`recoverStuckFile_` がリースを取った後に状態を確かめ直さない
- R4：`recoverStuckFile_` が今の順に戻る（書くものの確かめ・転記先の選択の後にリースを取る。書くものが無ければリースを取らない）
- R5：`opsRetryFailedFiles` を戻すだけに戻す
- R6：`recoverStuckFile_` が `recoverPartialFailure` を飛ばして戻す
- R7：Web が `REVIEW_WAIT`・`COMPLETED` も受け付ける
- R8：Web の戻しが監査を残さない（`audit: null`）
- R9：Web の監査の理由が `MENU`（`reason` を渡さない）
- R10：一覧でリースのある `FAILED` を `recoverable` にする
- R11：`webAppFailedFileReason_` が前から採る
- R12：`webAppFailedFileReason_` が `detail` も返す
- R13：一覧が 3 種類のファイルが無くてもリースを読む
- R14：一覧が失敗の理由のために処理ログを別に読む（要修正と 1 回にまとめない）
- R15：Web の認可を `ROLE.REVIEWER` にする
- R16：Web のフォルダの確かめを消す
- R17：`recoverStuckFile_` のリースの目的を常に `PROCESS` にする
- R18：`recoverStuckFile_` の `finally` を外す（失敗でリースが残る）
- R19：画面でボタンを登録済みのすべての行に出す
- R20：画面で確認を出さずに呼ぶ
- R21：画面で成功の後に一覧を読み直さない
- R22：画面で `STILL_RUNNING` を成功のお知らせにする
- R23：画面の `finally` を外す（例外のとき忙しいまま残る）
- R24：Web が `outcome.error` の本文を `label` に入れて返す

## 8.1 実装と監査の記録（2026-10-20）

- Codex 1 回目（`tools/codex-logs/*-20261020-144042-*`、gpt-6.1-sol・xhigh）：1.0 の「420 秒＝7 分」が設定（600 秒）と食い違うのを見つけ、実装の途中で停止 → 1.1 で直した。止まる前に穴を 2 つとも再現：sf 2（今の `opsRetryFailedFiles` → 再取込で各取引 **2 行**）、sf 13（心拍から 360 秒のリースが残るのに `DISCOVERED` へ戻した）。
- Codex 2 回目（`*-20261020-145551-*`）：1654/1654（開始時 1634 ＋ sf 20 本）。sf 11 の読取は一覧 (a)〜(d) が 2・3・5・5（作る前 2・2・2・4）、回復 13・転記先への書込 0。R1〜R24 はすべて赤。
- 監査：src の差分は 80・81・97 だけ（97 は `recoverStuckFile_` への移し替えと `opsRetryFailedFiles`、LF のまま、NUL 2 個）。ほかの src・test 163 本は開始時の md5 と一致。`???` 0。既存の期待の変更は `multi 6` の文 1 か所だけ。
- 私の変異 X1〜X32 のうち 17 個を回し、3 個がすり抜けた：X13（リース表が読めないときにボタンを出す）・X22（一覧が隣のファイルのリースを見る）・X23（Web が隣のファイルのリースで止まる・**隣の止まったリースを強制解放する**）。sf 19・sf 20 を私が足して 3 個とも赤。X4（`REVIEW_WAIT` で書くものが無いときも戻す）はすり抜けたが、`REVIEW_WAIT` は転記行の無い取引を持つときだけ選ばれるので、書くもの無しの枝に来ない（直す前のコードと同じ守り）。
- 残したこと（直さない）：心拍の時刻が読めないリース（`NaN`）では、一覧はボタンを出さず、Web は `forceReleaseLease` の拒否で例外になる（何も書かない）。`ERROR_CATALOG[code]` は自前のコードしか来ないので `hasOwnProperty` で守っていない。

## 9. 受入（実機）

push の前に、私が読むだけの `opsShowFileStates` で `FAILED`・`VALIDATING`・`WRITING` のファイルがあるか確かめる。

push 後、Web アプリを開き直して（F5）：

1. 止まった・失敗のファイルが無ければ：どのフォルダの一覧にも［取込待ちに戻す］が出ない（要修正の［修正済み → 取込待ちに戻す］と形式不明の［形式を確認］は今どおり）。
2. あれば：その行に理由とボタンが出る → 押す → 確認 → 実行 → お知らせ、一覧で「未処理（取込待ち）」→［記帳を実行］で完了か要確認待ち。
3. `opsShowLeases` が `(リースなし)`。

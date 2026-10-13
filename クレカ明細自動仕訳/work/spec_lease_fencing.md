# K-W21 リースの世代（fencing token）仕様書

版：1.0（2026-10-13）
対象：`src/11_FileStateManager.gs`・`src/43_SheetWriter.gs`・`src/05_SettingsValidator.gs`・リースを解放する呼出し元（`51`・`52`・`54`・`55`・`71`・`97`）。
発端：`work/spec_webapp.md` §14 K-W21（2026-09-20、外部の設計レビュー）。§15-6「リース5回は触らない」と §15-10 並列化の前提。

## 0. 決めたこと（ko-ch さん、2026-10-13）

1. **範囲は「帳簿（転記先）への書込を固める」。**読取の回数は増やさない。取引ログ・要確認・処理ログの書込にリースの確認は足さない（状態の比較更新が守る。§1.4）。
2. **世代番号の列は足さない。リースIDを世代の印として使う。**本番のリース表の形（10 列）は変えない。

## 1. 調べて分かったこと（2026-10-13、コードを読んで）

### 1.1 世代の印はもうある

リースIDは `acquireLease` が取得のたびに `generateId('LEASE')`（UUID）で作り、使い回さない。転記先へ書く前には `assertLeaseHeldForWrite(fileId, leaseId)` が「自分のリースIDの行がリース表にまだ在るか」を確かめている（`43` の値の書込・消去・予約の取消し、`45` の行予約、`43` の回復）。強制解放は行を消すので、古い実行のリースIDはもう見つからず、書込は `LEASE_CONFLICT` で拒まれる。

単調増加の番号が要るのは、書かれる側（ストレージ）がリース表を見ずに「これまでに見た最大の番号」とだけ比べる場合である。ここでは確かめる側が毎回リース表そのものを読むので、**一意で使い回されない ID なら、番号と同じ働きをする。**番号の列を足しても守りは増えない（0-2 の理由）。

### 1.2 いまは時間の前提で守られている

- `renewHeartbeat` は `src/` のどこからも呼ばれていない。だからリースの「最後の心拍」（H 列）は**取得した時刻のまま**である。
- 強制解放（`forceReleaseLease`・`releaseInvestigatedLease`）は、最後の心拍から `LEASE_FORCE_RELEASE_MIN_SECONDS`（600 秒）を超えないと拒む。
- Apps Script の 1 回の実行は 6 分（360 秒）で必ず止められる。

したがって「強制解放された後に古い実行が書く」には、取得から 600 秒を超えて実行が生きている必要があり、**いまは起きない。**K-W21 は、この時間の前提（設定値を下げる・上限が変わる）が崩れても帳簿を壊さないための直しである。

### 1.3 時間の前提を外すと開く穴

1. **確かめと書込の間のすき間。**`reserveDestinationRows`（`45`）だけはスクリプトロックの中で確かめてから書く。`writeTransactionRows`・`clearTransactionRows`・`releaseReservedRows`（`43`）は**ロックの外で確かめた後に**書く。強制解放と新しい持ち主の取得はどちらもロックを取るので、確かめと書込を同じロックの中に入れれば、その間に割り込めない。
2. **他人のリースを消せる解放。**`releaseLease(fileId, runId)` は `runId` が `null`／`undefined` のとき、**そのファイルのリースを持ち主を問わず全部消す。**
   - 要確認の確定（`51` 4 か所・`52` 4 か所・`54` 2 か所）は `releaseLease(fileId, input.runId || null, …)` で解放する。画面からの確定は `runId` を持たないので、この形になる。
   - `transitionFileState(…, runId)` は終端の状態へ移すとき `releaseLease(fileId, runId)` を呼ぶ。`runId` を `null` で呼ぶ経路（`52` の `moveFile_`、`53` の `applyCancelFileState`、`97` の `completeFullyResolvedFiles_`・`completeFileIfFullyResolved_`）は、そのファイルのリースを全部消す。
   - 特に `completeFullyResolvedFiles_`（`97`、運用シートの適用 `opsApply…` と `opsResolvePartnerExemptReviews` の最後に走る）は、1 件版の `completeFileIfFullyResolved_` と違って**リース中のファイルを飛ばさない。**画面で確定している最中のファイルを完了にし、その確定のリースを消し得る。これは時間の前提と関係なく起きる。消された側は次の書込で `LEASE_CONFLICT` になる（安全側）が、利用者には「なぜか確定が失敗する」と見える。
3. **取引ログ・要確認・処理ログの書込はリースを確かめない。**§1.4 のとおり、ほとんどは状態の比較更新が代わりに守る。

### 1.4 確かめを足さない書込（0-1 の判断の根拠）

| 書込 | 守っているもの |
|---|---|
| 取引ログの確定（`settleWrittenTransactions`） | ロックの中で取引の状態を比較更新（`fromStatus` が違えば全件拒む）。回復が先に確定させていれば、古い実行の確定は弾かれる |
| 処理ログの状態（`transitionFileState`） | 状態と `runId`（A 列）の比較更新 |
| 要確認の登録・監査ログ | 追記だけ。帳簿の値は変えない |
| 書式（`applyPlainTextFormat`） | 値を書かない（F・I・K 列を文字列の書式にするだけ）。続く値の書込が確かめる |

## 2. 直すこと

### 2.1 確かめと書込を同じロックの中で行う（`43_SheetWriter.gs`）

`writeTransactionRows`・`clearTransactionRows`・`releaseReservedRows` の 3 つ：

1. `assertLeaseHeldForWrite(...)` と、その関数の `Sheets.Spreadsheets.Values.batchUpdate`（`writeTransactionRows` は RAW と USER_ENTERED の 2 回とも）を、**1 つの `withScriptLock_` の中**で行う。順序は「ロックを取る → リースを確かめる → 書く → ロックを外す」。2 回の書込の間でロックを外さない。
2. `writeTransactionRows` の `faultInjectionPoint` は今の位置（各 `batchUpdate` の直前）のまま、ロックの中に入る。障害注入で投げても `withScriptLock_` の `finally` がロックを外す。
3. 書くものが無いとき（`rowWrites`／`rowNumbers` が空）は、今と同じくロックも取らず読みもせずに戻る。
4. 戻り値・引数・エラーは変えない。ロックが取れないときは `withScriptLock_` の既存の `LEASE_CONFLICT`（`'Script lock was not acquired'`）になり、**1 セルも書かない。**呼出し側は今もリースを失ったときと同じ形で受ける（`70` の `runWriteBlock` は値書込の途中の例外として行を残し回復へ委ねる。`55` は `LEASE_CONFLICT` を「リースを失った」として扱う）。どちらも書かずに止まるので安全側である。
5. **入れ子のロックを作らないこと。**呼出し元がすでにスクリプトロックの中にいてはならない。2026-10-13 の時点で呼出し元はどれもロックの外である：`70` `runWriteBlock`、`43` `recoverPartialFailure`、`51` の 4 つの確定、`52` `writeAdoptedTransaction_` と `UPDATE_PURPOSE`、`53` `cancelTransactions`、`54` の 2 つ、`55`（377 行。406 行のロックより前）。Apps Script の `LockService` が同じ実行の中で入れ子に取ったときの振る舞いは確かめていない（内側の `releaseLock` が外側のロックまで外すおそれがある）。テストの模擬ロック（`test/gas-stubs.js` の `MemoryScriptLock`）は入れ子を拒む（`tryLock` が `false`）ので、入れ子にすると `LEASE_CONFLICT` で赤になる。
6. ロックを持つ時間は、リース表の読取 1 回と書込 1〜2 回ぶん（1〜2 秒）延びる。読取の直前のクォータ待ち（`paceSheetsRead_`）がロックの中で起き得るのは、今の `reserveDestinationRows` と同じである。

変えないもの：`reserveDestinationRows`（すでにロックの中）、`applyPlainTextFormat`、`verifyWrittenValues`、`recoverPartialFailure` の中の単独の `assertLeaseHeldForWrite`（614 行付近。その後の行予約がロックの中で確かめ直す）、`assertLeaseHeldForWrite` 自身。

### 2.2 解放は自分のリースIDで行う（`11` と呼出し元）

1. `11_FileStateManager.gs` に **`releaseLeaseById(leaseId, reason)`** を足す：
   - `leaseId` が空（`null`・`undefined`・`''`）なら `TypeError` を投げ、何もしない。
   - `withScriptLock_` の中でリース表を読み、`leaseId` が一致する行を探す。
   - 無ければ何もせず `false` を返す（強制解放された後の `finally` から呼ばれる形。監査行も書かない ── 今の `releaseLease` が対象 0 件で黙って戻るのと同じ）。
   - 在れば、今の `releaseLease` と同じ形の監査行 `LEASE_RELEASE`（`actor: lease.owner`・`targetType: 'LEASE'`・`targetId`・`customerId`・`before: {state: ACTIVE}`・`after: {state: null}`・`reason`）を書き、**その 1 行だけ**を消して `true` を返す。
2. `releaseLease(fileId, runId, reason)` は **`runId` を必須にする。**`runId` が空なら `TypeError` を投げ、何も消さない。空でなければ今と同じ（`fileId` と `runId` が一致するリースを消す）。「`runId` を省くとファイルのリースを全部消す」振る舞いを無くす。コメントでその理由を書く。
3. `transitionFileState` は、終端の状態へ移すときでも、**`runId` が空でない場合だけ** `releaseLease(fileId, runId, …)` を呼ぶ。`runId` が空なら何も解放しない（そのリースの持ち主が自分の `finally` で解放する）。
4. リースを取った呼出し元は、`finally` で**自分のリースIDで**解放する。次の 14 か所を `releaseLeaseById(leaseId, '<今と同じ理由の文字列>')` に置き換える：
   - `51_ReviewResolution.gs`：172・231・280・354 行付近（`'RESOLVE_DONE'`）
   - `52_FileResolution.gs`：230（`'ADOPT_DONE'`）・310（`'DIFF_DONE'`）・372（`'PURPOSE_DONE'`）・442（`'CANCEL_DONE'`）行付近
   - `54_IntegrityResolution.gs`：109（`'REVERT_DONE'`）・185（`'RESTORE_DONE'`）行付近
   - `55_PartnerBatchResolution.gs`：602 行付近（`'RESOLVE_DONE'`）
   - `71_RunOrchestrator.gs`：918 行付近（`'RUN_FAILURE'`。`leaseId` が `null` のときは呼ばない ── 取得に失敗した場合は 536 行で先に戻っているが、念のため）
   - `97_Ops.gs`：1338 行付近（`'RECOVERY_DONE'`。今の `if (leaseId)` はそのまま）・2138 行付近（`'CANCEL_DONE'`）
5. 置き換えた後、`src/` の中の `releaseLease(` は **`11` の定義と `transitionFileState` の中の 1 か所だけ**になる（`releaseLeaseById(` は別の名前）。
6. 呼出し元が `releaseLeaseById` の戻り値（`false`＝もう無かった）を使う必要は無い。今の `finally` は解放の失敗を投げ直さない形と投げる形が混ざっている。**投げる・飲み込むの扱いは各呼出し元の今の形のまま**にする（`71` は `try { … } catch (ignored3) {}` のまま）。

### 2.3 一括完了はリース中のファイルを飛ばす（`97_Ops.gs` `completeFullyResolvedFiles_`）

1. 1 件版 `completeFileIfFullyResolved_` と同じく、**リースを持たれているファイルは完了にしない。**
2. リース表は**完了にする候補が初めて見つかったときに 1 回だけ**読む（`activeLeases_()`）。候補が無ければ読まない。読んだ一覧を、その呼出しの間は使い回す。
3. 戻り値（完了にした `fileId` の配列）の形は変えない。飛ばしたファイルは配列に入れない。
4. 確かめてから完了にするまでの間に別の実行がリースを取る可能性は残る（1 件版と同じ）。2.2-3 により、そのとき完了の遷移は**そのリースを消さない。**

### 2.4 強制解放の待ち時間に下限を置く（`11`・`05`）

1. `11_FileStateManager.gs` に定数を置く：`GAS_MAX_EXECUTION_SECONDS_ = 360`（Apps Script の 1 回の実行の上限）、`LEASE_FORCE_RELEASE_FLOOR_SECONDS_ = 420`（上限＋60 秒。止められる直前に送った Sheets への要求が届き切るぶんの余裕）。コメントで「最後の心拍から 420 秒を超えたリースの持ち主は、必ず止められている。心拍の時刻はその実行が書いたものなので、心拍を後で更新するようにしても成り立つ」ことを書く。
2. 補助 `leaseForceReleaseMinSeconds_()`：`Number(SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS)` が有限で `LEASE_FORCE_RELEASE_FLOOR_SECONDS_` 以上ならその値を返す。そうでなければ `StateTransitionError`（メッセージに `LEASE_FORCE_RELEASE_MIN_SECONDS` と `420` を含める）を投げる。
3. `forceReleaseLease` と `releaseInvestigatedLease` は、`SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS` を直に読む代わりにこの補助を使う。**呼ぶ位置はロックを取った直後、リース表を読む前**（下限を割る設定なら、何も読まず・消さず・監査行も書かずに投げる）。
4. `05_SettingsValidator.gs` の `lockSettings`（検査 8）：今の `missingNumbers_` に加えて、`LEASE_FORCE_RELEASE_MIN_SECONDS` が `LEASE_FORCE_RELEASE_FLOOR_SECONDS_` 未満なら問題として返す（文言は `'LEASE_FORCE_RELEASE_MIN_SECONDS must be at least 420 (Apps Script runs stop at 360 s)'` の形）。欠けているときは今の文言を優先する。
5. 検出の閾値 `HEARTBEAT_TIMEOUT_SECONDS`（300 秒。一覧の「検出可」）と、`97` の表示（`leaseIsStalled_`・`collectLeaseStatus_`）は変えない。
6. `00_Config.gs` の値は 600 である。ただし `loadSettingsFromProperties` が**スクリプトプロパティで上書きする**ので、本番の実際の値は push の前に確かめる（§6 の 0）。420 以上なら本番の振る舞いは変わらない。420 未満に上書きされていると、検査 8 が取込の開始を拒むようになる。

## 3. 変えないこと

- リース表の列（10 列）、`acquireLease`、`assertLeaseHeldForWrite`、`reserveDestinationRows`、`renewHeartbeat`（呼ばれていないことの記録は §1.2 に残すだけ）、`verifyActiveLease`、`detectStalledLeases`・`leaseStallCheck_`、`opsShowLeases`・`opsReleaseStalledLeases`・`opsReleaseInvestigatedLease` の出力の形。
- **1 ファイルの取込の読取回数**（`budget 1`・`multi 14`・`bulk 1`・`kw9` の読取の数・`scope 1〜3`・`phase6-round-trips`）。2.1 は確かめの位置を動かすだけで、読取は増えない。
- エラーの種類とコード（`LEASE_CONFLICT` 等）、監査行の種類と形。
- 取引ログ・要確認・処理ログの書込（§1.4）。

## 4. テスト（`kw21 N: …`）

置き場所は `test/phase4-lease-recovery.test.js` の末尾を基本とし、8 は既存の準備の補助が使えるファイル（`test/phase4-resolution.test.js`・`phase4-file-resolution.test.js`・`phase4-integrity-resolution.test.js`）に置いてよい（置いた場所を報告する）。

1. **kw21 1（ロックの中で確かめて書く）**：`writeTransactionRows`・`clearTransactionRows`・`releaseReservedRows` のそれぞれで、リース表の読取（`activeLeases_` の呼出し）と、転記先への `batchUpdate` の全部が、**ロックが掛かった状態で、同じ 1 回のロックの中**で起きることを確かめる。方法の例：`activeLeases_` と `Sheets.Spreadsheets.Values.batchUpdate` を包み、呼ばれた時点の `gas.stubs.getScriptLock()` の `locked`・`tryCount`・`releaseCount` を記録する。全部 `locked === true`、`tryCount` と `releaseCount` が同じ値であること。`writeTransactionRows` は RAW と USER_ENTERED の 2 回の `batchUpdate` を含む行を使う。
2. **kw21 2（ロックが取れない）**：`setTryLockResults([false])` の後、3 つの関数がどれも `LEASE_CONFLICT` を投げ、転記先に 1 セルも書かず、リース表も読まない。
3. **kw21 3（リースを失った）**：リースを強制解放した後（または行を消した後）、3 つの関数がどれも `LEASE_CONFLICT` を投げ、転記先に 1 セルも書かない。
4. **kw21 4（`releaseLeaseById`）**：同じファイルにリースが 2 行ある状態（リース表へ直に書いて作る。`runId` も持ち主も違う）で、片方の ID で解放すると**その 1 行だけ**が消え、監査行 `LEASE_RELEASE` がその ID で 1 行増える。無い ID なら `false` を返し、何も消さず、監査行も増えない。空の ID は `TypeError`。
5. **kw21 5（`releaseLease` の `runId` は必須）**：`releaseLease('file1', null, …)`・`undefined`・`''` はどれも `TypeError` を投げ、そのファイルのリースを 1 行も消さない。`releaseLease('file1', 'RUN_1', …)` は `RUN_1` の行だけを消す（`RUN_2` の行は残る）。
6. **kw21 6（`runId` の無い遷移はリースを消さない）**：リースを持たれた `REVIEW_WAIT` のファイルを `transitionFileState(fileId, 'REVIEW_WAIT', 'COMPLETED', null)` で完了にしても、リースは残る。`applyCancelFileState`（`CANCELED`・`DISCOVERED` への 2 段）でも残る。
7. **kw21 7（`runId` のある遷移は自分の行だけ消す）**：同じファイルに `RUN_A`・`RUN_B` の 2 行（直に書く）。`transitionFileState(…, 'FAILED', 'RUN_A')` で `RUN_A` の行だけが消える。
8. **kw21 8（確定は自分のリースだけを返す）**：確定の途中（転記先へ書いた後・`finally` の前。例：`verifyWrittenValues` を包む）で、自分のリースの行を消し、**同じファイルに別の持ち主のリース**（別の `runId`・持ち主）を足す ── 強制解放されて別の実行が取った形。確定が終わった（成功でも失敗でもよい）後、**別の持ち主のリースが残っている**こと。少なくとも `51` の確定 1 つ（例：`RESOLVE_PARTNER_UNKNOWN`）・`52` の 1 つ（例：`UPDATE_PURPOSE`）・`54` の 1 つ（例：取消しの巻き戻し）で確かめる。
9. **kw21 9（解放の呼出しの形）**：`src/*.gs` を読み（`97_Ops.gs` は NUL を含むのでバイトのまま読み、文字列にしてから探す）、`releaseLease(` が現れるのは `11_FileStateManager.gs` の `function releaseLease(` と `transitionFileState` の中の 1 か所だけであること。`releaseLeaseById(` の呼出しが §2.2-4 の 14 か所（ファイルごとの数：`51` 4・`52` 4・`54` 2・`55` 1・`71` 1・`97` 2）在ること。
10. **kw21 10（一括完了はリース中を飛ばす）**：決着済みの `REVIEW_WAIT` のファイル 2 つ（片方だけリースあり）で `completeFullyResolvedFiles_()` → リースの無いほうだけが `COMPLETED`、リースのあるほうは `REVIEW_WAIT` のまま・リースも残る。候補が 1 つも無いときはリース表を読まない（`activeLeases_` の呼出し 0 回）。候補が複数でも読むのは 1 回。
11. **kw21 11（設定の検査）**：`LEASE_FORCE_RELEASE_MIN_SECONDS` が 419 のとき `validateSettings('IMPORT')` の問題に検査 8 があり、文言に `420` を含む。420・600 のときは検査 8 の問題が無い。未設定（`null`）のときは今の文言（`must be configured`）。
12. **kw21 12（強制解放は下限を割る設定で動かない）**：`LEASE_FORCE_RELEASE_MIN_SECONDS = 300` にし、心拍から十分に時間が経った（例 2 時間）リースに対して、`forceReleaseLease` と `releaseInvestigatedLease`（それぞれが受け持つ形のリースで）がどちらも `StateTransitionError` を投げ、リースは残り、監査行も増えない。`opsReleaseStalledLeases()` はそのリースを `released: false` で返す。設定を 600 に戻すと今までどおり解放できる。
13. **kw21 13（読取は増えない）**：`writeTransactionRows` 1 回の読取（`batchGet` の回数）が直す前と同じ（リース表の 1 回）であること。直す前の数を実測して固定する。

既存のテストの期待（assert）は変えない。

## 5. 変異（M1〜M18）── それぞれ赤になるテストを記録する

- M1：`writeTransactionRows` の `assertLeaseHeldForWrite` をロックの外（前）へ戻す
- M2：`writeTransactionRows` で RAW と USER_ENTERED を別々のロックで書く（確かめは最初のロックだけ）
- M3：`clearTransactionRows` の確かめをロックの外へ戻す
- M4：`releaseReservedRows` の確かめをロックの外へ戻す
- M5：`writeTransactionRows` の確かめを消す（ロックだけ残す）
- M6：`releaseLeaseById` が同じファイルのリースを全部消す
- M7：`releaseLeaseById` が見つからないとき投げる
- M8：`releaseLeaseById` が監査行を書かない
- M9：`releaseLease` の `runId` が空のとき、今までどおりファイルの全部を消す
- M10：`transitionFileState` の「`runId` が空でない場合だけ」の条件を外す（終端なら常に `releaseLease` を呼ぶ）
- M11：M9 と M10 を両方入れる（旧い振る舞いそのもの）
- M12：`51` の 1 か所を `releaseLease(review.fileId, input.runId || null, 'RESOLVE_DONE')` に戻す（M9 を入れない状態と入れた状態の両方で）
- M13：`55` の解放を `releaseLease(fileId, result.runId, 'RESOLVE_DONE')` に戻す
- M14：`97` の 1338 行付近を `releaseLease(row.fileId, runId, 'RECOVERY_DONE')` に戻す
- M15：`completeFullyResolvedFiles_` のリースの確認を外す
- M16：`completeFullyResolvedFiles_` が候補の数だけリース表を読む
- M17：`forceReleaseLease` が下限を見ない（`SETTINGS` を直に読む）
- M18：`lockSettings` の比較を `<=` 420 にする（420 を拒む）

## 5.1 実装と監査の記録（2026-10-13）

- Codex（`tools/codex-logs/*-20261013-*`）：開始 1480/1480。kw21 1〜13（8 は 8a・8b・8c）を足し、直す前は 1・2・4・5・6・8a〜8c・9・10・11・12 が赤、3・7・13 は緑。直した後 1494/1495 ── **既存の `batch 17`（`phase8-webapp`）が赤になり、指示どおり止まった**（変異は未実施）。読取は `writeTransactionRows` 1 回で直す前も後も `batchGet=1`、`completeFullyResolvedFiles_` は候補 0 で 0 回・候補 2 で 1 回。43 の 3 関数の呼出し元はどれもロックの外（§2.1-5 の一覧どおり）。NUL 2、`???` 0。サンドボックスの中で git が使えず `git diff` は取れなかった。
- **`batch 17` の原因はテストの停止点の数え方**：「2 回目の `withScriptLock_` の後で止める」で取引ログの書込（手順6）の直後を作っていたが、その間に転記先への書込のロックが入った。期待（assert）は変えず、停止点を 3 回目にした（私の直し。1＝リースの取得・2＝転記先への書込・3＝取引ログの書込、とコメントで書いた）。
- 私の監査：src の差分は 9 ファイルの指定箇所だけ。`writeTransactionRows` の中身の字下げをロックの中に合わせ、消えていた INV-30 の参照を戻し、下限を `GAS_MAX_EXECUTION_SECONDS_ + 60` の式にし、`completeFullyResolvedFiles_` に理由のコメントを足した（どれも振る舞いは変えない）。
- 変異：M1〜M18 はすべて赤（作業ツリーの写し 4 つで並べて回した。本体は md5 で無変更を確認）。私の変異 8 個（X1〜X8）のうち **2 個がすり抜けた** ── X2「強制解放の補助が 420 ちょうどを拒む」・X8「空の書込でもロックを取りリース表を読む」。`kw21 12b`・`kw21 13b` を足し、どちらも赤になった。
- 終了 **1497/1497**。97 の NUL 2・U+FFFD 0。改行：Codex が書いた行は LF で、もとが CRLF のファイルでは混ざった。控えの md5 で元の形を判定し、LF だった 11・43・55・71・97・`phase4-lease-recovery`・`phase8-webapp` は LF に戻した（**97 は NUL を含むので git がバイナリとして扱い改行を変換しない** ── CRLF のまま入れるとコミットの中身が全行変わる）。もとから混在していた 51・52・54・`phase4-resolution` は CRLF にそろえた（テキストなのでコミットの中身は変わらない）。
- 挙動の変化（意図どおり）：取込が殺されて古い `PROCESS` リースが残ったファイルを、メニューのファイル単位の操作（`moveFile_`）で動かしたとき、これまではそのリースが黙って消えていた。今後は残り、`opsShowLeases` に「状態の食い違い」として出て `opsReleaseInvestigatedLease` で解放する（既存の設計「食い違いは黙って消さない」のとおり）。

## 6. 受入（実機）

0. **push の前に**、本番のスクリプトプロパティに `LEASE_FORCE_RELEASE_MIN_SECONDS` があるかを見る（読むだけ）。無いか、420 以上なら push してよい。420 未満なら push しない（ko-ch さんに相談する）。
   **確かめた（2026-10-13、`clasp -u runner run-function loadSettingsFromProperties`。名前の一覧を返すだけで何も書かない）：**上書きは `EXECUTION_TIMEOUT_SECONDS`・`SAMPLE_CORPUS_FOLDER_ID`・`SNAPSHOT_SPREADSHEET_ID`・`TX_INDEX_SPREADSHEET_ID` の 4 つだけ。**`LEASE_FORCE_RELEASE_MIN_SECONDS` は上書きされておらず、本番はコードの 600 のまま。**（ついでに見えたこと：`RUN_TX_COUNT_RUN_…` が 103 個残っている。実行の終わりで消す `60` 586 行に届かずに止められた実行の残りと見られる。1 個数十バイトで害は無いが、いずれ掃除の対象。K-W21 の範囲外）

push 後、Web アプリを開き直して（F5）：

1. 取込を 1 回（取込待ちのファイルがあるカードで。無ければ取込待ち 0 本の［記帳を実行］でもよい）と、要確認の確定を 1 回、いつもどおり終わる。
2. 終わった後、`opsShowLeases` が `(リースなし)`。
3. 取込の `IMPORT_CALL` のログで、1 ファイルの読取の数が直す前（gas-push-112 の時点）と同じ。

## 7. §15-6・§15-10 への申し送り

- **§15-6：1 ファイルの取込のリースの読取 4 回は、K-W21 の後も減らせない。**取得（ロックの中）・行予約の確かめ（ロックの中）・値の書込の確かめ（ロックの中）・解放（ロックの中）は、どれも同じロックの中で書くことを守るための読取である。まとめると、その間に強制解放と新しい持ち主が割り込める。減らせる見込みがあるのは、行予約と値の書込を 1 つのロックの区間にまとめる形（−1 回）だけで、ロックを持つ時間が書式の適用ぶん延びる。いまはやらない。
- **§15-10：並列化の前提のうち K-W21 のぶんは、この直しで満たす。**残る前提は「転記先への確定を単一の書き手に寄せる」こと（行の競合・重複判定の競合・監査連鎖の順序）。2.1 で値の書込がロックの中に入ったので、複数の実行の書込はロックで 1 つずつになる。

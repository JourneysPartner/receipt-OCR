# K-W26 取込を 2 本並列にする 仕様書（§15-10 の 3 段目）

版：1.0（2026-10-16）

- 1.0（2026-10-16）：初版。
対象：`src/00_Config.gs`・`src/01_DataAccessCore.gs`・`src/71_RunOrchestrator.gs`・`src/80_WebApp.gs`・`src/81_WebAppUi.html`。
発端：`work/spec_webapp.md` §15-10（取込の並列化）の 3 段目。1 段目は `work/spec_concurrent_sheet_writes.md`（K-W24、gas-push-115、2026-10-15 受入合格）、2 段目は `work/spec_import_dedup_in_lock.md`（K-W25、gas-push-116、受入待ち）。

## 0. 決めたこと

1. （ko-ch さん、2026-10-14）§15-10 を 3 段に分ける。**3 段目（本書）＝Web アプリの取込を 2 本並列にする。**帳簿の行の並び（ファイルの順）は気にしない。見込みは最大約 1.7 倍で進める。
2. **今日の道（1 本ずつ）はそのまま残し、2 本の道を足す。**切替えは `80` の定数 `WEBAPP_IMPORT_LANES_`（2＝2 本、1＝今日の道）。本番で何かあれば 1 にして push すれば今日の動きに戻る。今日の道で変わるのは、ロック待ちの既定が 20 秒 → 60 秒になること（§2.2）だけである。
3. **2 本のうち片方が止まったら（ファイルの失敗・リースの衝突・不整合・例外）、もう片方は走っている呼出しを最後まで終え（途中では止められない）、次の呼出しを始めない。**今日の「失敗したら押下を止める」（`80` の `FILE_FAILED`）と同じ考え方である。
4. **同じ顧客の取込がまだ動いていれば、新しい押下は始めない**（`IMPORT_IN_PROGRESS`。§1.2-8）。私の提案（安全側）に ko-ch さんが同意（2026-10-16「それでいい」）。
5. 利用者に見える変化は、速さと §2.9 の新しいお知らせ 2 つだけ。進み具合の表示（「処理中 n / m（経過 …）」）は変えない。何本で走っているかは画面に出さない。

## 1. 調べて分かったこと（2026-10-16、本番のログとコード）

### 1.1 速さの上限

- 本番のログ（10-14〜15、gas-push-114〜115）：**転記したファイル 1 本＝35〜64 秒・読取 27〜29 回**（K-W25 で 1 減って 26〜28 のはず）。転記しないファイル（要修正など）は 23〜32 秒・読取 8〜10 回。呼出しの固定費は約 20〜35 秒・読取約 17 回（認可 2・走査 3・リース 1・設定 1・名前の付け直し 2・走査 3・前検査 4〜6）、押下の最初の呼出しだけ複製 4〜8 秒と監査連鎖の検証 6〜17 秒が乗る。
- **1 本ずつだと読取は 1 分 30 回前後で、枠（55 回/分）の半分しか使っていない。**時間の大半は読取以外（xlsx の変換・書込・ハッシュ・ロックの中の処理）である。
- 2 本にすると枠が天井になる：1 本あたり 27 回/分 → 1 本が転記するファイルは 1 分に 1 本まで → 2 本で 1 分 2 本。12 本（転記）なら、今 約 11〜12 分 → 約 7 分（約 1.7 倍）。**3 本以上は枠で頭打ち**なので 2 本に固定する。
- 枠は Web アプリの配備者 1 人分を、すべての実行が共有する（Web アプリは配備者として動く）。2 本で 27＋27＝54、残り 6 は画面の他の呼出しの余白。
- `google.script.run` を同時に 2 つ呼ぶと、別々の実行（それぞれ 6 分の上限）として並んで走る ── 本書はこれを前提にする（**実機の受入 §6 で確かめる**。並ばなければ遅くなるだけで、壊れはしない）。

### 1.2 2 本にすると壊れる・遅くなる所（1・2 段目で塞いでいないもの）

1. **前検査の誤報**（K-W24 §1.3 の穴 9）：`runCustomerIntegrityCheck_`（`71` 209 行）は、恒久ファイルインデックス・取引ログ・処理ログを**別々の `batchGet` で**読む。その間に相手の本が自分のファイルの状態を進めると、処理ログと恒久ファイルインデックスの状態が食い違って見え、`PERMANENT_INDEX_DESYNC`（STOP）を出す。対象に入るのは「今回の候補」と「終わっていないファイル（VALIDATING・WRITING・REVIEW_WAIT）」で、相手の取込中のファイルは後者に入る。止まる向きの誤り（帳簿は壊れない）だが、押下が止まる。
2. **ロック待ち 20 秒**（穴 10）：ロックを持った本が、ロックの中の読取で均しの待ち（枠 55 で 1.1 秒、27 なら 2.2 秒）を入れる。ロックの中の処理は本番で最長 15 秒ほど（10-14 の `pre:register` 14.5 秒）。待つ側は `LOCK_TIMEOUT_MS`（20 秒）で諦め、`LEASE_CONFLICT` でそのファイルが失敗する。
3. **読取の枠の数え方**：実行ごとの窓は自分の読取しか数えない。前の呼出しの読取を引き継ぐ控え（スクリプトキャッシュ `SHEETS_READ_WINDOW_V1`）は 1 つの鍵なので、2 本が上書きし合う。どちらも枠 55 で走れば合わせて約 110 回/分 → 429 → 20〜80 秒の罰（`sheetsReadWithRetry_`）── **ロックの中で当たれば、その間ずっとロックを持ったまま眠る。**
4. **名前の付け直しの重なり**：`runImport` は毎回 `retryPendingRenames`（`11` 108 行）で、付け直しに失敗したファイルの名前を直す。リースを取らない。2 本が同時に同じファイルを直す・相手の本が状態を進めているファイルに古い接頭辞を付けることがある。
5. **候補の取り合い**：今のサーバーは「走査 ∩ リースの無いもの」を自分で選ぶ。リースは処理中の 1 本にしか付かないので、2 本は同じ「次のファイル」を選び、遅いほうが `LEASE_CONFLICT` で止まる。→ **画面が待ち行列から重ならないように割り振る。**
6. **複製**：押下の最初の呼出しが雛形を複製する。2 本が同時に始めると複製が 2 枚できる。→ **準備の呼出しで 1 回だけ。**
7. **監査連鎖の検証**：押下に 1 回（`80` 590 行）。→ 準備の呼出しで 1 回だけ。
8. **開き直し（F5）の後の押し直し**：開き直しても、前の画面が出した呼出しはサーバーで最後まで走る（最大 5 分）。その間に押し直すと実行が 4 つ重なり（枠の 2 倍）、429 が続く。今日の道でも 2 つ重なる（今もある穴）。→ 準備の呼出しは、同じ顧客の取込のリース（取得から 7 分以内のもの）があれば始めない（§0-4）。

### 1.3 塞がないもの（本書の範囲外）

- 別の顧客の取込が同時に動くとき（担当者 2 人）の読取の枠の取り合い。今と同じ（枠は配備者 1 人分）。
- メニュー・定期実行の取込（今と同じ。定期実行は止めてある ── K-W10）。
- `queryTxIndex` の年ごとの読取（K-W25 §7 の申し送り。2027 年 1 月に前年のシートができると 1 ファイルの読取が 1 増える）。並列とは別の話なので、2026 年 12 月までに別の課題として行う。
- 準備の呼出しの守り（§2.3-5）をすり抜ける細い隙：前の画面の本が「1 本終えて次のリースを取るまで」の 1〜2 秒に押し直した場合。重なっても帳簿は壊れない（リースと状態の比較更新が守る）。遅くなるだけである。

## 2. 直すこと

### 2.1 全体の流れ（2 本の道）

```
画面：［記帳を実行］
 └ webAppPrepareImport(customerId, folderId)                      … 準備（押下に 1 回）
     認可 → フォルダ → 走査 → リース
     同じ顧客の取込のリース（7 分以内）があれば IMPORT_IN_PROGRESS で終わる
     runImport({prepareOnly: true}) … 設定・容量・名前の付け直し・前検査（全候補＋未完了。取込中は外す）・監査連鎖
     止まらなければ雛形を複製
     → {fileIds（走査順）, destinationSpreadsheetId, lanes, maxFilesPerCall}
 └ 本 0・本 1 が待ち行列から取り、それぞれ繰り返す：
     webAppRunImport(customerId, folderId, {destinationSpreadsheetId, fileIds, lane})
       読取の枠 27・本ごとの窓の控え・名前の付け直しなし・監査連鎖なし・複製なし
       前検査は「自分の分＋未完了」（取込中は外す）
       → いつもの結果 ＋ notStarted（始めなかった分）＋ skipped（候補でなくなった分）
 └ 全部終わる、またはどちらかが止まる → お知らせ → 一覧と要確認を読み直す
```

### 2.2 定数・スイッチ・ロック待ち（`80`・`00`）

1. `80` に `var WEBAPP_IMPORT_LANES_ = 2;` を足す（14〜34 行の定数の並び）。値は 1 か 2。コメントに §0-2（1 にすると今日の道）と §1.1（3 本以上は枠で頭打ち）を書く。
2. `webAppBootstrap`（`80` 189 行）の戻り値に `importLanes: WEBAPP_IMPORT_LANES_` と `maxFilesPerImport: WEBAPP_MAX_FILES_PER_IMPORT_` を足す。
3. `00` の `LOCK_TIMEOUT_MS: 20000` を `60000` にする。コメントに理由（§1.2-2：2 本並列では、相手がロックの中で最長 15 秒ほど処理する。20 秒では足りないことがある。60 秒でも 6 分の上限には届かない）を書く。

### 2.3 準備の呼出し `webAppPrepareImport(customerId, folderId)`（`80`、新しい公開関数）

`webAppRunImport` の頭（468〜576 行）と同じ部品を使う。**ファイルは 1 本も取り込まない。リースを取らない。**

1. `loadSharedReadWindowAll_(WEBAPP_IMPORT_LANES_)`（§2.5-4）で、一般の控えとすべての本の控えを窓へ読む。枠は 55（本の扱いにしない）。
2. 以下を `webAppInvoke_` の中で行う。
3. 認可：`webAppAuthorizeCustomer_(customerId, 'WEBAPP:記帳')` → `getAuthorizedCustomers` の確かめ（`80` 511〜519 行と同じ）。通らなければ `NO_AUTHORIZED_CUSTOMER`。
4. `WEBAPP_IMPORT_LANES_ < 2` なら `stoppedBy: 'PARALLEL_DISABLED'` で返す（何も書かない・複製しない）。開いたままの古い画面が、1 本に戻した後に押した場合である。
5. フォルダ（`webAppDirectChildFolder_` と直下のファイル）→ 走査（`scanUnprocessedFiles` ∩ 直下）→ リース（`activeLeases_()` を 1 回）。
   - **守り：**リースのうち、`customerId` がこの顧客・`purpose` が `PROCESS`・取得から（`lastHeartbeat` から）`LIVE_LEASE_MAX_AGE_SECONDS_`（§2.8-3、420 秒）未満のものが 1 つでもあれば、`stoppedBy: 'IMPORT_IN_PROGRESS'` で返す（複製しない・名前の付け直しもしない・何も書かない）。`WRITE_ONLY`（要確認の確定）・別の顧客・古いリースでは止めない。
   - 候補＝走査 ∩ 直下 ∩ リースの無いもの（今と同じ）。直下にファイルが無い・候補が無いなら、今と同じ形で返す（`fileIds: []`。リースだけが理由なら `LEASE_CONFLICT`）。
6. `runImport({customerIds: [id], fileIds: 候補, prepareOnly: true, verifyAuditChain: true, precheckExcludesLeasedFiles: true, now})`（§2.7）。`maxFilesPerCustomer` と `fileStartGate` は渡さない（前検査は全候補を見る）。
   - `report.stoppedBy` があれば、または顧客が `skipped` なら、今の `webAppRunImport`（604〜610 行）と同じ規則で `stoppedBy` を決めて返す（`INTEGRITY_STOP` など）。**複製しない。**
7. 止まらず、`report.customers[0].prepared`（§2.7-1）が空でなければ、`webAppCloneDestination_(customer, now)` で複製する。`schemaValidation.ok` が偽なら今と同じ形（`code` と `schemaValidation`）で返す。
   - **今の道との違い：**今は複製してから前検査する（止まると空の複製が残る）。準備では前検査の後に複製する。
8. 戻り値：`webAppImportResult_(0, n, destinationSpreadsheetId, [], stoppedBy, schemaValidation)` に `fileIds`（`prepared`、走査順。止まったときは `[]`）・`lanes: WEBAPP_IMPORT_LANES_`・`maxFilesPerCall: WEBAPP_MAX_FILES_PER_IMPORT_` を足したもの。`n` は `fileIds` の数。
9. `finally`：`saveSharedReadWindowSplit_(WEBAPP_IMPORT_LANES_)`（§2.5-5）。`IMPORT_CALL` を 1 行（§2.10）。

### 2.4 本の呼出し（`80` `webAppRunImport` の拡張）

`opts.lane` が `null`・`undefined` でなければ**本の呼出し**とする。そうでなければ**今日の道そのまま**（1 行も振る舞いを変えない）。

1. **入力の検査（何よりも先に。読取・書込の前）**：次のどれかなら、`AuthorizationError`（文言は「取込の割り振りが正しくありません。画面を開き直してから（F5）もう一度押してください。」）を投げる（`webAppInvoke_` を通る。リース・書込・複製・読取は 0）。
   - `WEBAPP_IMPORT_LANES_ < 2`
   - `opts.lane` が整数でない・`0 ≤ lane < WEBAPP_IMPORT_LANES_` でない（文字列の `'0'` も拒む）
   - `opts.destinationSpreadsheetId` が空（本は複製しない）
   - `opts.fileIds` が配列でない・空・`WEBAPP_MAX_FILES_PER_IMPORT_` を超える・空でない文字列でない要素がある・重複がある
   - 拒んだときは**読取の控えを読まず・書かない**（今の `finally` は窓を必ず書くが、空の窓で一般の鍵を上書きすると、ほかの呼出しの読取が消える）。`IMPORT_CALL` は今の例外のときと同じく 1 行出してよい。
2. `setReadLane_(lane, WEBAPP_IMPORT_LANES_)`（§2.5-1）→ `loadSharedReadWindow_()`（本の控えだけを読む）。
3. 認可・転記先の検査（`webAppValidateDestination_`）・フォルダ・走査・リースは今と同じ。そのうえで**候補を `opts.fileIds` に絞る**（並びは走査の順のまま）：
   - `candidatesBeforeLease`＝走査 ∩ 直下 ∩ `fileIds`、`candidates`＝そのうちリースの無いもの。
   - `skipped`＝`fileIds` のうち `candidates` に無いもの（`fileIds` の並び）。
   - `candidates` が空なら今と同じ規則（`candidatesBeforeLease` があれば `LEASE_CONFLICT`、無ければ `stoppedBy: null`）で返す。
4. 時間の確かめ（556〜562 行）は今と同じ。複製はしない。
5. `runImport` に渡すものは今と同じ（`fileIds: candidates`・`maxFilesPerCustomer`・`fileStartGate`・`destinationSpreadsheetId`・`verifyAuditChain: false`・`now`）に、`retryRenames: false`・`precheckExcludesLeasedFiles: true` を足す。
6. 戻り値は今と同じ形に `notStarted`・`skipped`・`lane` を足す。`notStarted`＝`candidates` のうち、結果の `fileResults`（`DEFERRED_TIME_BUDGET` を除いたもの）に無いもの（`candidates` の並び）。**`fileResults` の fileId・`notStarted`・`skipped` は、`fileIds` をちょうど分け尽くす**（重なりも漏れも無い）。`done`・`total`・`remaining`・`stoppedBy`（`FILE_FAILED`・`LEASE_CONFLICT` の規則も）は今と同じ。
   - **早く返すとき**（`NO_AUTHORIZED_CUSTOMER`・直下にファイルが無い・候補が無い・`TIME_BUDGET`）も 3 つを付けて分け尽くす：候補を決める前に返すときは全部を `skipped`、候補を決めた後に返すとき（`TIME_BUDGET`）は `candidates` を `notStarted`・残りを `skipped`。
7. `finally`：`saveSharedReadWindow_()`（本の控えだけに書く）→ `IMPORT_CALL` を 1 行（§2.10）→ `clearReadLane_()`（§2.5-1）で本の扱いを外す。本番では実行ごとにグローバルが消えるが、同じ実行の中で続けて呼ばれたとき（テスト）に残さないため。

### 2.5 読取の枠を本ごとに分ける（`01`）

1. **本の扱い**：`apiReadLane_`（`null` か本の番号）・`apiReadLanes_` を足す。`setReadLane_(lane, lanes)` は `apiReadLane_ = lane`・`apiReadLanes_ = lanes`・`apiReadBudget_ = Math.floor(55 / lanes)`（2 本で 27）にする。`resetApiReadWindow_` は本の扱いを外す（`null`・1・55）。`clearReadLane_()` は本の扱いだけを外す（`null`・1・55。窓の時刻は消さない）。`readLaneActive_()` は `apiReadLane_ !== null` を返す。
2. 控えの鍵：一般は今の `SHEETS_READ_WINDOW_V1`、本は `SHEETS_READ_WINDOW_V1_LANE_<番号>`。
3. `loadSharedReadWindow_()`・`saveSharedReadWindow_()`：本の扱いのときは本の鍵だけ、そうでなければ今と同じ（一般の鍵だけ）。中身の扱い（60 秒より古い・未来の時刻・重複を落とす、60 個まで、失敗は握りつぶして数える、TTL 120 秒）は今と同じ。
4. `loadSharedReadWindowAll_(lanes)`（準備だけが使う）：一般の鍵と本 `0..lanes-1` の鍵を全部読み、今の `loadSharedReadWindow_` と同じ規則で 1 つの窓にまとめる（重複は 1 つにする）。取り込んだ時刻の数を返す。1 つの鍵の失敗で他を捨てない（失敗の数だけ `apiSharedReadWindowErrors_` を足す）。
5. `saveSharedReadWindowSplit_(lanes)`（準備だけが使う）：直前 60 秒の時刻を古い順に並べ、一般の鍵へ全部、本 `i` の鍵へ「`j % lanes === i` の番目の時刻」を書く（**準備の読取は 2 本で半分ずつ持つ**。合計は変わらない）。書いた数（一般の鍵の数）を返す。失敗は握りつぶして数える。
   - 理由をコメントに書く：本は自分の鍵しか読まないので、準備の読取（約 20 回）をどの本も数えないと、最初の 1 分に 20＋27＋27＝74 回になり 429 に当たる。全部を両方に数えると、最初の 1 分は 20＋7＋7 しか使えない。
6. `noteSheetsQuotaExceeded_`・`READ_QUOTA_FLOOR_`（20）は変えない（本の扱いでも 5 ずつ下げて 20 で止まる）。

### 2.6 ロックの中では均しで待たない・ロックの前に空きを作る（`01`）

**本の扱いのとき（`readLaneActive_()`）だけ。**本の扱いでなければ `withScriptLock_`・`paceSheetsRead_` の振る舞いは今と同じ。

1. `withScriptLock_`：`tryLock` の**前に**、本の扱いなら `paceBeforeScriptLock_()` を呼ぶ ── 窓を刈り、窓の数 `n` が `limit = apiReadBudget_ − READ_LOCK_RESERVE_`（`READ_LOCK_RESERVE_ = 5`）を超えていれば、窓の数が `limit` 以下になるまで眠る（古い順に `n − limit` 個が窓から出ればよいので、待つ長さ＝`apiReadWindow_[n − limit − 1] + 60000 − now + 250`。`paceSheetsRead_` の窓の上限の式と同じ考え方）。`limit` が 1 未満になる枠（`noteSheetsQuotaExceeded_` で下がったとき）では `limit = 1` とする。眠った長さは `paceSheetsRead_` と同じく `apiBackoff_.paceCount`・`paceMs`・`paceWorstMs`・`apiReadPacedTotalMs_` に足す（ファイルごとの `waits` と `IMPORT_CALL` の `pacedMs` に出るように）。
   - 理由をコメントに書く：ロックの中で枠に当たると、ロックを持ったまま眠り、相手の本が待つ。待つならロックを取る前に、ロックの外で待つ。5 はロックの中の 1 回の読取の数の目安（足りなくても、枠の上限は §2.6-3 で必ず守る ── ロックの中で少し待つだけで、安全は変わらない）。
2. ロックを取れたら `scriptLockHeld_ = true`、`finally` で `false` に戻す（本の扱いでなくても行ってよい。値を見るのは本の扱いのときだけ）。
3. `paceSheetsRead_`：**本の扱い かつ `scriptLockHeld_` のときは、均し（345〜349 行）を飛ばす。窓の上限（353〜356 行）はどんなときも守る。**
4. ロックを待った時間を数える：`tryLock` の前後の時刻で、`apiScriptLockWaits_ = {count, ms, worstMs}`（窓と同じく実行の寿命。`resetApiReadWindow_` で 0 に戻す）に足す。数えるだけで振る舞いは変えない（どの扱いでも数えてよい）。`paceBeforeScriptLock_` の眠りは含めない（あちらは `pacedMs`）。
5. ロックを取れなかったときは今と同じ（flush もしない）。`LOCK_TIMEOUT_MS` は §2.2-3 の値を使う。

### 2.7 `runImport` の選択肢（`71`）

1. `opts.prepareOnly === true`：前検査（377 行）・監査連鎖（392 行）・`integrity.stop` の扱い（398 行）までは今と同じに行い、**止まらなければ `customerReport.prepared = candidates` の fileId の配列（並びのまま）を置いて、ファイルのループに入らずに次の顧客へ進む**（均しを入れない・リースを取らない）。`maxFilesPerCustomer` を渡さなければ候補を切らない（今と同じ）。
2. `opts.retryRenames === false`：名前の付け直し（356 行）を行わない（`renames` の段も記録しない）。それ以外（省略を含む）は今と同じ。
3. `opts.precheckExcludesLeasedFiles === true`：前検査を `runCustomerIntegrityCheck_(customer, ids, {excludeLeasedFiles: true})` で呼ぶ（§2.8）。それ以外は今と同じ呼び方（第 3 引数なし）。
4. 均し（405 行）：`setReadQuotaSmoothing_(filesPlanned > 1 || readLaneActive_())`。本の扱いでは 1 ファイルでも均す（本の枠 27 は 1 ファイルの読取とほぼ同じ）。
5. それ以外の段（設定・容量・走査・前検査・監査連鎖・ファイルのループ・門）は変えない。

### 2.8 前検査から取込中のファイルを外す（`71` `runCustomerIntegrityCheck_`）

第 3 引数 `options` を足す。`options.excludeLeasedFiles` が真のときだけ次を行う（偽・省略なら今と 1 行も変わらない。リースも読まない）。

1. **最初に**（恒久ファイルインデックスを読む前に）`activeLeases_()` を読む（s1）。
2. 対象の行（`targetRows`）から、s1 で**生きたリース**（3）を持つファイルを外す（取引ログ・処理ログの読取の対象にも入れない）。自分の候補（`fileIdsInScope`）でも外す（ほかの誰かが処理中である。ファイルのループでは `LEASE_CONFLICT` になる）。
3. **生きたリース**＝`customerId` がこの顧客で、`lastHeartbeat` からの経過が `LIVE_LEASE_MAX_AGE_SECONDS_`（420 秒）未満のもの。目的（`PROCESS`・`WRITE_ONLY`）は問わない。時刻が読めないリースは生きたものとして扱わない（外さない ── 前検査の対象に残すほうが見落としが無い）。`LIVE_LEASE_MAX_AGE_SECONDS_` は `71` に置き、`80` の守り（§2.3-5）も同じ値を使う。コメント：GAS の 1 回の実行は 6 分で必ず終わる。取得から 7 分を過ぎたリースの持ち主は、もう居ない（強制解放の 600 秒とは別の値。こちらは「いま誰かが書いているか」の目安で、短いほうが前検査の見落としが少ない）。
4. ファイルごとの検査（229〜249 行）は今と同じに行い、**結果をファイルごとに持つ**。
5. **全部の検査が終わった後**（`DESTINATION_UNREADABLE` を足す前）に、もう一度 `activeLeases_()` を読む（s2）。s2 で生きたリースを持つファイルの所見を捨てる。
   - 理由をコメントに書く：状態はリースを持った実行しか進めない。s1 と s2 のどちらにもリースが見えないのに、その間に状態が進むのは、相手のリースがまるごと前検査の読取の間（数秒）に収まった場合だけで、ファイル 1 本の処理（20 秒以上）では起きない。起きても止まる向きの誤り（STOP）である。
6. 戻り値に `excludedLeasedFiles`（外したファイルの数。s1 で外したもの＋s2 で所見を捨てたもの、ファイルの重複は 1 つ）を足す。`ok`・`stop` は捨てた後の所見で決める。
7. 読取：外すときだけ +2（s1・s2）。

### 2.9 画面（`81`）

1. `bootstrap`（3287 行）で `state.importLanes = Number(result.importLanes) || 1`、`state.maxFilesPerImport = Number(result.maxFilesPerImport) || 6` を覚える（`state` の初期値にも足す）。
2. `gasCall` に `webAppPrepareImport`（引数 2 つ）を足す。
3. `startImport`：頭の確かめ（1546〜1550 行）は今と同じ。`state.importLanes >= 2` なら 2 本の道（4）、そうでなければ**今のループそのまま**（1576〜1613 行の中身を変えない。関数に分けるのはよい）。`importBusy`・`token`・`generation` の扱い、`finally` の後始末（1618〜1627 行）は両方の道で今と同じ。
4. **2 本の道：**
   1. 進捗の時計を今と同じく始め、`update(0, 0)`。準備を `beginCall` → `gasCall('webAppPrepareImport', [customerId, folderId])` → `endCall`。古くなっていたら（1582〜1584 行と同じ確かめ）何もせずに終わる。
   2. 準備の `destinationSpreadsheetId` があれば、今と同じく `state.activeImportDestinationSpreadsheetId` と `state.lastCompletedDestinationSpreadsheetId` に置く。`schemaValidationLines(準備)` をお知らせの詳細に足す。
   3. 準備に `stoppedBy` があれば `stoppedByMessage` のお知らせ（`warning`）で終わる。`fileIds` が空なら `TEXT.noFiles`（`info`）で終わる。
   4. 待ち行列＝`fileIds` の写し。`total`＝その数。本の数＝`Math.max(1, Math.min(2, Number(準備.lanes) || 1))`。1 回に渡す数の上限＝`Number(準備.maxFilesPerCall) || state.maxFilesPerImport`。
   5. 本ごとに次を繰り返す非同期の関数を、本の数だけ同時に走らせ、全部が終わるのを待つ：
      - 止まった（下の「止める」）・古くなった → 抜ける。
      - 待ち行列が空：ほかの本が呼出し中なら、どれかの呼出しが返るまで待ってからもう一度見る（返ってきた `notStarted` を拾うため）。呼出し中の本が無ければ抜ける。
      - 取る数 `k`＝`Math.min(上限, Math.ceil(待ち行列の数 ÷ 呼出し中でない本の数（自分を含む）))`。待ち行列の頭から `k` 本を取る。
      - `beginCall` → `gasCall('webAppRunImport', [customerId, folderId, {destinationSpreadsheetId: 準備の転記先, fileIds: 取った分, lane: 本の番号}])` → `endCall`。
      - 古くなっていたら何も触らずに抜ける。
      - 今と同じく `collectSessionFiles`・`customerFixNoticeLines`・`schemaValidationLines` を集め、`done` を足す。
      - `notStarted`（取った分にあるものだけ）を**待ち行列の頭へ**、並びのまま戻す。`skipped`（取った分にあるものだけ）の数だけ `total` を減らす。取った分のうち、`fileResults`・`notStarted`・`skipped` のどれにも無いものも（起きないはず）`total` から減らす（2 度は送らない）。進捗を `update(done, total)`。
      - **止める：**`stoppedBy` があれば、それを止めた理由にする（先に止めたほうが勝つ）。`done` が 0 で、取った分が全部 `notStarted` で戻ったら、止めた理由を「進まなかった」にする（`fileResults` に `FAILED` があれば `TEXT.stuckFile`、無ければ `TEXT.timeBudget`。今の 1602〜1606 行と同じ）。呼出しが例外で返ったら、それを止めた理由にする。
   6. 全部の本が終わったら（古くなっていなければ）お知らせ：例外 → `showNotice(failureMessage(error), 'error')`（今の `catch` と同じ）。`stoppedBy` → `stoppedByMessage`（`warning`、詳細つき）。進まなかった → 上の文言（`warning`、詳細つき）。`done` が 0 → `TEXT.noFiles`（`info`）。それ以外 → `done + ' 件を取り込みました。'`（`success`）。
5. `stoppedByMessage` に 2 つ足す（付録 A の文言）：`IMPORT_IN_PROGRESS` → `TEXT.importInProgress`、`PARALLEL_DISABLED` → `TEXT.parallelDisabled`。
6. **進捗の時計（`startProgressTimer`、670 行）**：呼出しを数えるようにする。`beginCall()` は呼出しの印（数でよい）を返し、`endCall(印)` はその呼出しを外す（印なしの `endCall()` は最も古い呼出しを外す ── 確定の画面 1965〜1968 行は今のまま動く）。案内（「数分かかることがあります」）は、**最も古い呼出しが 60 秒を超えたら**出す（今は 1 つの呼出し）。表示の文言は変えない。
7. 本の番号は画面に出さない。

### 2.10 記録 `IMPORT_CALL`（`80`）

- **準備**：今と同じ項目に `prepare: true`・`lane: null`・`budget`（`apiReadBudget_`）・`lock`（§2.6-4 の差分 `{count, ms, worstMs}`）・`files: []` を足す。`precheck` に `excluded`（`excludedLeasedFiles`）を足す。`total` は `fileIds` の数。
- **本**：今と同じ項目に `prepare: false`・`lane`・`budget`・`lock`・`notStarted`（数）・`skipped`（数）を足す。`precheck` に `excluded`。
- **今日の道**：今と同じ（項目を足さない）。
- ファイル名・金額・店名は出さない（今と同じ）。

## 3. 変えないこと

- **今日の道**（`WEBAPP_IMPORT_LANES_` が 1、または `webAppRunImport` に `lane` を渡さない呼出し）の振る舞い・読取の数・戻り値・`IMPORT_CALL`。例外は `LOCK_TIMEOUT_MS` の既定（§2.2-3）と、ロックを待った時間を数えること（§2.6-4。記録には出さない）。
- 取込の中身（判定・転記・要確認・状態の遷移・帳簿に書く値）、1・2 段目の書き方（ロックの中の flush・Sheets API で読んだ末尾・ロックの中の重複の判定）、リース（取得・解放・強制解放・`activeLeases_`）、メニュー・定期実行の取込、要確認の確定（`webAppResolveReviews`）、最終確認・ダウンロード。
- `withScriptLock_` の入れ子を拒む模擬ロック、ロックを取る場所（新しくロックを取らない。入れ子を作らない）。
- `11`・`43`・`45`・`50`・`55`・`60`・`61`・`62`・`70`・`97` は変えない。
- **既存のテストの期待（assert）。**直してよい既存のテストは無い見込みである。既存のテストが赤になったら、変えずに止めて報告すること。

## 4. テスト（`kw26 N: …`）

置き場所は新しいファイルを基本とする（`phase8-webapp` の準備の補助が要るなら、K-W25 の `test/kw25-import-helpers.js` と同じ形で、そこから登録してよい。置いた場所を報告する）。画面のテストは `test/phase9-format-registration.test.js` 140〜185 行の模擬の DOM と `google.script.run`（`defer` で返事を遅らせられる）を手本にしてよい。

**サーバー**

1. **kw26 1（準備はファイルを取り込まない）**：候補 3 本で準備 → `fileIds` が走査の順で 3 本、複製が 1 枚でき `destinationSpreadsheetId` がそれ、3 本とも `DISCOVERED` のまま、リースは 0、取引ログ・転記先に行が増えない、監査連鎖の検証が 1 回、名前の付け直し（`PENDING_RETRY` のファイル）が 1 回行われる。`IMPORT_CALL` が `prepare: true`。
2. **kw26 2（準備は止まったら複製しない）**：未完了のファイルに `PERMANENT_INDEX_DESYNC` を作っておく → `stoppedBy: 'INTEGRITY_STOP'`、複製なし、`fileIds: []`。候補 0 本 → `fileIds: []`、複製なし、`stoppedBy: null`。
3. **kw26 3（同じ顧客の取込が動いていれば始めない）**：この顧客の別のファイルに取得 1 分前の `PROCESS` リース → `IMPORT_IN_PROGRESS`、複製なし、名前の付け直しなし、`batchUpdate` の数が変わらない。取得 8 分前の `PROCESS` リース・取得 1 分前の `WRITE_ONLY` リース・別の顧客の取得 1 分前の `PROCESS` リースでは止まらない（リースのあるファイルが候補から外れるのは今と同じ）。
4. **kw26 4（1 本に戻したとき）**：`WEBAPP_IMPORT_LANES_ = 1` で準備 → `PARALLEL_DISABLED`、複製なし・書込なし。本の呼出し（`lane: 0`）→ `AuthorizationError`。
5. **kw26 5（本の入力の検査）**：`lane` が `-1`・`2`・`'0'`・`1.5`・`null 以外の非数`、転記先なし、`fileIds` が空・7 本・重複・空文字・数値 → それぞれ `AuthorizationError`、読取・リース・書込・複製が 0。
6. **kw26 6（本は渡された分だけ、走査の順で）**：候補 4 本（f1〜f4）。`lane: 0`・`fileIds: [f3, f1]` → f1・f3 だけを走査の順で取り込み、f2・f4 は `DISCOVERED` のまま。`fileIds` に取込済みのファイルと知らない ID を混ぜる → どちらも `skipped`。重いファイルで門が止める → 残りが `notStarted`（並びのまま）。どの場合も `fileResults`・`notStarted`・`skipped` が `fileIds` を分け尽くす。
7. **kw26 7（本は名前の付け直し・監査連鎖・複製をしない）**：`PENDING_RETRY` のファイルがあっても付け直さない、`verifyChain` を呼ばない、スプレッドシートが増えない。
8. **kw26 8（本の枠と控え）**：本の呼出しのあいだ `apiReadBudget_` が 27。読むのは `SHEETS_READ_WINDOW_V1_LANE_<番号>` だけ、書くのもそれだけ（一般の鍵・相手の鍵は変わらない）。1 ファイルでも均しが入る。呼出しが返った後（例外で返った後も）は本の扱いが外れ、枠が 55 に戻っている。`resetApiReadWindow_` でも外れる。
9. **kw26 9（準備は控えを半分ずつ渡す）**：一般の鍵と本の鍵に時刻を置いて準備 → 全部（重複は 1 つ）を窓へ読み、一般の鍵に直前 60 秒の全部、本 0・本 1 の鍵に 1 つおきに書く（本 0＋本 1＝一般）。鍵 1 つの読取・書込の失敗で他を捨てない。
10. **kw26 10（ロックの中では均しで待たない）**：時計を差し替える。本の扱い・均しありで、ロックの外の続けた読取は間隔ぶん眠り、`withScriptLock_` の中の続けた読取は眠らない。窓がいっぱい（枠と同じ数）なら、ロックの中でも窓が空くまで眠る。本の扱いでなければ、ロックの中でも今と同じく均す。
11. **kw26 11（ロックの前に空きを作る）**：本の扱いで窓に `27 − 2` 個の時刻 → `withScriptLock_` が `tryLock` の前に、5 個空くまでの長さだけ眠り、それが `paceMs` に入る。窓が `22` 個以下なら眠らない。本の扱いでなければ眠らない。ロックを待った時間が `apiScriptLockWaits_` に入る。
12. **kw26 12（前検査は生きたリースのファイルを外す）**：未完了のファイル X に、別の実行の取得 1 分前のリースと `PERMANENT_INDEX_DESYNC`（恒久 `VALIDATING`・処理ログ `WRITING`）→ 外す扱いの前検査は STOP しない・`excludedLeasedFiles` が 1・X の取引ログを読まない。取得 8 分前のリース → STOP（今と同じ）。外す扱いでない（今日の道）→ STOP、リースを読まない。別の顧客のリースは外す理由にならない。
13. **kw26 13（前検査の途中で取られたリース）**：恒久ファイルインデックスを読んだ直後（s1 の後）に「相手の実行」が X のリースを取り、処理ログを `WRITING` に進める仕掛け → s2 で所見が捨てられ STOP しない・`excludedLeasedFiles` 1。s2 を読まないと赤になる形にする。外す扱いの前検査の読取は、外さない扱いより 2 多い（リース 2 回）。
14. **kw26 14（今日の道は変わらない）**：`lane` なしの `webAppRunImport` の読取の数・戻り値の鍵・`IMPORT_CALL` の鍵・名前の付け直し・枠 55・一般の鍵が直す前と同じ（直す前に実測して固定する）。
15. **kw26 15（2 本で 1 枚の複製へ）**：準備（4 本）→ `lane: 0` の `[f1, f2]`、`lane: 1` の `[f3, f4]` を順に呼ぶ → 4 本とも同じ複製へ転記、転記先に同じ取引 ID の行が 2 つ無い、取引ログの AC・AD が全部その複製、リース 0、`verifyChain('RECENT')` が ok、最終確認（`webAppFinalReview`）が一致。
16. **kw26 16（ロック待ちの既定）**：`SETTINGS.LOCK_TIMEOUT_MS` の既定が 60000、`withScriptLock_` が `tryLock` にその値を渡す。
17. **kw26 17（bootstrap）**：`importLanes: 2`・`maxFilesPerImport: 6` を返す（既存の項目は変わらない）。

**画面**（返事を遅らせられる模擬の `google.script.run` で）

18. **kw26 18（2 本が同時に走る）**：`importLanes: 2`、準備が 5 本 → どちらの返事も返す前に `webAppRunImport` が 2 つ出ている。取った分は重ならず、3 本と 2 本（`ceil(5/2)`、次は `ceil(2/1)`）。両方とも準備の転記先と `lane` 0・1 を渡す。
19. **kw26 19（戻った分は頭へ・候補でない分は数えない）**：本 0 が `notStarted: [f2]` を返す → f2 が待ち行列の頭へ戻り、次の呼出しに入る。`skipped` は `total` から減る。終わりのお知らせの件数は `done` の合計。`notStarted` で戻らない限り、同じファイルを 2 度送らない。
20. **kw26 20（待ち行列が空でも、相手の返事を待つ）**：待ち行列が空になったとき本 0 が呼出し中 → 本 1 は終わらずに待ち、本 0 が返した `notStarted` を本 1（か本 0）が拾って送る。
21. **kw26 21（片方が止まったら、もう片方は次を始めない）**：本 0 が `stoppedBy: 'FILE_FAILED'` を返す → 本 1 の呼出しが返った後、新しい呼出しは出ない。お知らせは `TEXT.stuckFile`。例外（`withFailureHandler`）・`INTEGRITY_STOP` でも同じ（お知らせはそれぞれ今の文言）。
22. **kw26 22（準備で止まる）**：`IMPORT_IN_PROGRESS`・`PARALLEL_DISABLED`・`INTEGRITY_STOP`・`fileIds: []` → `webAppRunImport` は 1 回も呼ばれず、お知らせはそれぞれ付録 A・今の文言・`TEXT.noFiles`。
23. **kw26 23（画面が古くなったら）**：押下の途中で顧客を選び直す → 本は新しい呼出しを出さず、お知らせも状態も新しい画面のものを触らない。
24. **kw26 24（1 本のときは今の道）**：`importLanes: 1` → `webAppPrepareImport` を呼ばず、`webAppRunImport` を `{}` → `{destinationSpreadsheetId}` の順で呼ぶ（今と同じ）。
25. **kw26 25（進捗と案内）**：表示の `total` が `skipped` の分だけ減る。時計を差し替えて、2 つ呼出し中のうち古いほうが 60 秒を超えたら案内が出る。`beginCall` の印で `endCall` すると、その呼出しだけが外れる。確定の画面の進捗（印なし）は今と同じ。
26. **kw26 26（押下の後）**：`lastCompletedDestinationSpreadsheetId` が準備の転記先、`sessionFileIds` に両方の本のファイル、`finally` の `loadFiles`・`loadReviews` が 1 回ずつ。
27. **kw26 27（使う場所の決まり）**：`src/*.gs` を読み（`97_Ops.gs` はバイトのまま読んでから文字列にする）、`webAppPrepareImport` が `'WEBAPP:記帳'` で認可する。`81` の 2 本の道の `webAppRunImport` の呼出しは必ず `lane` を渡す。`LIVE_LEASE_MAX_AGE_SECONDS_` を使うのは `71` と `80` だけ。

## 5. 変異（M1〜M24）── それぞれ赤になるテストを記録する

- M1：準備がファイルを取り込む（`prepareOnly` を渡さない）
- M2：準備が前検査の前に複製する
- M3：準備が控えを一般の鍵にしか書かない
- M4：本が一般の鍵を読む
- M5：本の枠が 55 のまま
- M6：本が名前の付け直しをする
- M7：本が監査連鎖を検証する
- M8：本が `fileIds` で絞らない（候補を全部取り込む）
- M9：本が `notStarted` を返さない（または `skipped` を返さない）
- M10：本の扱いでもロックの中で均しの待ちを入れる
- M11：ロックの前に空きを作らない
- M12：前検査が s2 を読まない
- M13：前検査が古いリース（7 分超）のファイルも外す
- M14：前検査が今日の道でも外す
- M15：準備の守りが `PROCESS` リースを見ない（始めてしまう）
- M16：準備の守りが `WRITE_ONLY`・別の顧客のリースでも止める
- M17：`LOCK_TIMEOUT_MS` が 20000 のまま
- M18：画面：最初の本が待ち行列を全部取る（`ceil(÷ 本の数)` をしない）
- M19：画面：片方が止まっても、もう片方が次の呼出しを出す
- M20：画面：`notStarted` を待ち行列へ戻さない
- M21：画面：待ち行列が空なら、相手が呼出し中でも本が抜ける
- M22：画面：`importLanes` を見ない（いつも 2 本の道）
- M23：本の入力の検査が `lane ≥ 本の数` を通す
- M24：進捗の案内が最も新しい呼出しで決まる

赤にならない変異があれば、テストを足して赤にできるか試し、足したものを報告する。

## 5.1 実装と監査の記録（2026-10-16）

- **Codex**（指示書 `work/codex_prompt_parallel_import.txt`、1 回で完了・止まらず）：開始時 1570/1570。kw26 を書いて赤を確かめてから実装（直す前に緑だったのは kw26 14・24 ＝今の道が今も成り立つこと）。終了 1599/1599。M1〜M24 すべて赤。模擬・ハーネス（`gas-stubs`・`gas-harness`）は無変更。テストは `test/kw26-core.test.js`（窓・均し・ロック）、`test/kw26-import-helpers.js`（取込を通すもの。`phase8-webapp` の準備の補助を使うので、そこから 2 行で登録）、`test/kw26-ui.test.js`＋`test/kw26-ui-helpers.js`（画面。`phase9` の模擬の DOM を写し、ケースごとに子プロセスで走らせる）。
- **Codex が仕様に足したこと（妥当と判断）：**(1) 準備の控えを 1 つおきに渡すと、本の窓が枠 27 を超えて始まることがある（直前 60 秒に 60 回近い読取があったとき）。今の式（最も古い 1 回が出るまで待つ）では枠を守れないので、**本の扱いだけ**、次の読取が枠に収まる数まで待つ（`apiReadWindow_[length − budget]`）。今の道の式は変えていない。(2) `webAppRunImport` と `webAppPrepareImport` は、非公開の `webAppImportCall_` を共有する（計測・認可・走査を二重に持たない）。今の道の読取・戻り値・`IMPORT_CALL` が変わらないことは kw26 14 が固定する。(3) `IMPORT_CALL` の `lock.worstMs` は呼出しの区間で測り、終わりに実行全体の最大へ戻す。
- **読取の実測（テストの固定データ。本番の数ではない）：**今の道 1 ファイル 35 → 35（不変）。準備 16（外の認可 2・走査 3・リース 1、`runImport` の設定 1・名前の付け直し 1・走査 3・前検査 3、複製 2）。本 1 ファイル 36（今の道 35 ＋前検査のリース 2 −名前の付け直し 1）。外す扱いの前検査は 4 → 6（＋2）。本の 1 ファイルのロック 11 回のうち、ロックの中の読取は最大 3 回（`READ_LOCK_RESERVE_` 5 以内）。
- **私の監査：**src の差分は 5 ファイルだけ、テストの既存ファイルの変更は `phase8-webapp` の登録 2 行だけ（md5 で開始時と比べた）。97 は開始時と同一（NUL 2）、5 ファイルとも LF・BOM なし、`???` 0、U+FFFD は src 0・test は元からの 1。差分を全部読み、仕様どおりと確認した。**私の変異 X1〜X44 のうち 19 個を回し、1 つがすり抜けた** ── X18（画面の「1 本も始めずに全部を返した呼出しの後は止める」を消す＝同じファイルを送り直し続ける）。`kw26 21b` を足して赤にした。ほかは赤。終了 **1600/1600**。
- 気づいたこと（範囲外・記録だけ）：準備は直下にファイルが無いフォルダでも走査とリースを読む（読取 4。害なし）。`design_document.md` の設定表の `LEASE_FORCE_RELEASE_MIN_SECONDS` の既定が 1,800 と書かれているが、コードは 600（前からの食い違い）。

## 6. 受入（実機）

0. **push の前**（私、ko-ch さんの許可で）：本番のスクリプトプロパティに `LOCK_TIMEOUT_MS` の上書きが無いことを、名前の一覧だけで確かめる（`loadSettingsFromProperties` は名前だけ返し、書かない）。上書きがあれば、その値のまま 60 秒にならないので報告する。
   - **2026-10-16 確認済み（ko-ch さんの許可）：**上書きは `EXECUTION_TIMEOUT_SECONDS`・`SAMPLE_CORPUS_FOLDER_ID`・`SNAPSHOT_SPREADSHEET_ID`・`TX_INDEX_SPREADSHEET_ID` の 4 つだけ。`LOCK_TIMEOUT_MS`・`LEASE_FORCE_RELEASE_MIN_SECONDS` は上書きされていない → 既定の 60000 がそのまま効く。
1. F5 で開き直し、取り込めるファイルが 4〜6 本あるカードのフォルダで［記帳を実行］。
2. ログ：`IMPORT_CALL` に `prepare: true` が 1 行、`lane: 0`・`lane: 1` の行。**本 0 と本 1 の呼出しの時間が重なっている**（§1.1 の前提）。`quotaHits` 0、`budget` 27、`lock.worstMs` が 60 秒より十分小さい。1 ファイルの読取は K-W25 の後と同じ（転記したファイルで 26〜27）。
3. `opsShowLeases` が `(リースなし)`（リース表に空行が無い ── K-W24 §7 の残る仮定）、`verifyChain('RECENT')` が ok。
4. 最終確認が一致（転記漏れ・二重転記なし）。ダウンロードした Excel の行が最終確認と同じ。
5. 所要：同じくらいの本数の今までの取込と比べる（見込み 1.5〜1.7 倍）。
6. おかしければ：`WEBAPP_IMPORT_LANES_ = 1` にして push → F5（今日の道へ戻る）。

## 7. 残る仮定・申し送り

- `google.script.run` の 2 つの呼出しが並んで走ること（§6-2 で確かめる）。
- `LockService` のロック待ちが先着順かは公式に書かれていない。60 秒で足りなければ、ログの `lock.worstMs` で分かる。
- K-W24 §7 の仮定（見え方の古い実行の SpreadsheetApp の書込が行番号どおりに当たる）は、2 本が同時に動いて初めて試される（§6-3・4）。
- `queryTxIndex` の年ごとの読取（§1.3、2026 年 12 月までに）。
- 別の顧客の同時の取込・開き直しの細い隙（§1.3）。

## 付録 A. 文言

- `TEXT.importInProgress`：「この顧客の取込がまだ動いています（別の画面か、開き直す前の画面で押した取込です）。数分待ってから、もう一度「記帳を実行」を押してください。」
- `TEXT.parallelDisabled`：「取込の設定が変わりました。画面を開き直してから（F5）、もう一度「記帳を実行」を押してください。」
- 本の入力の検査（§2.4-1）：「取込の割り振りが正しくありません。画面を開き直してから（F5）もう一度押してください。」

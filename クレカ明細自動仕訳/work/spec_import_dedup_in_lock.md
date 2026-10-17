# K-W25 二重取込の判定をロックの中へ移す 仕様書（§15-10 の 2 段目）

版：1.0（2026-10-15）

- 1.0（2026-10-15）：初版。
対象：`src/10_DriveScanner.gs`・`src/60_ProcessLog.gs`・`src/61_TransactionLog.gs`・`src/70_ImportFlow.gs`・`src/71_RunOrchestrator.gs`。
発端：`work/spec_webapp.md` §15-10（取込の並列化）の 2 段目。1 段目は `work/spec_concurrent_sheet_writes.md`（K-W24、gas-push-115、2026-10-15 受入合格）。

## 0. 決めたこと（ko-ch さん、2026-10-14）

1. §15-10 を 3 段に分ける。**2 段目（本書）＝同じ中身のファイル・用途だけ直したファイルの二重取込の判定を、ロックの中へ移す。**
2. **先にロックを通って書いたほうが原本、後のほうが「重複」「用途修正版の候補」になる。**1 本ずつ取り込むときの今の振る舞い（先に取り込んだほうが原本）と同じ規則である。
3. 利用者に見える変化は作らない（1 本ずつの取込では判定の結果も画面も変わらない）。担当者 2 人が同時に取り込んだときの二重転記も塞がる。

## 1. 調べて分かったこと（2026-10-15、コード）

### 1.1 いまの判定の位置（ロックの外）

1. **同じ中身（`DUPLICATE_CONTENT`）**：`processDiscoveredFile_`（`71` 708〜715 行）が、恒久ファイルインデックスを `permanentIndexRowsForScan_()` で**ロックの外で**読み（読取 1）、`checkDuplicateFile` で判定する。自分の明細内容ハッシュを F 列へ書くのは、その後の `updateProcessLogAndContentHash_`（`60` 420 行、ロックの中）である。
   - **穴：**同じ中身のファイル A・B を 2 つの実行が同時に取り込むと、どちらも相手のハッシュが書かれる前に読み、どちらも「重複なし」になる → **両方が転記される（二重転記）。**
2. **用途修正版（`PURPOSE_REVISION_CANDIDATE`）**：同じく `71` 722〜731 行が、恒久取引インデックスを `queryTxIndex(customerId, {purpose: 'FREEE_PENDING'})` で**ロックの外で**読み（前年・今年のシート、あるものだけ）、`checkPurposeRevisionCandidate` で判定する。自分の取引をインデックスへ書くのは、その後の `registerPrepared`（`61` 221 行、ロックの中。`70` 239 行から呼ぶ）である。
   - **穴：**元のファイル A と、顧客が用途だけ直した A' を同時に取り込むと、どちらも相手の取引が登録される前に読み、どちらも「候補なし」になる → **同じ取引が 2 回転記される。**
3. 区分の評価順は「区分 2 → 区分 1 → 区分 3」（`classifyValidationResult`、INV-14）。用途修正版の判定は区分 2 なので、区分 1（要修正）のファイルでも先に効く。**だから外の判定は残す**（区分 1 のファイルは `registerPrepared` まで来ないので、ロックの中の判定だけにすると、用途修正版で同時に要修正のファイルが区分 1 になり、評価順が変わる）。

### 1.2 読取の回数（いま）

- 重複：外の `permanentIndexRowsForScan_()` が 1、`updateProcessLogAndContentHash_` のロックの中の `getFileRecordsPair_` が 1（処理ログと恒久ファイルインデックスの自分の行を 1 回の `batchGet` で）。**計 2。**
- 用途修正版：外の `queryTxIndex` が今年・前年のシートごとに 1（取引インデックスは登録した年で分かれ、運用は 2026 年 8 月からなので、いまは前年 2025 のシートが無く 1 のはず）。`registerPrepared` のロックの中で、取引インデックスへ追記する位置を決める `apiLastDataRow_`（`appendRowsBatched_` の `append:idx:last`）が 1 ── **これは今年のシートの A1:K を全部読んでいる。**

### 1.3 塞がないもの

- 前検査が相手の取込中のファイルを見て誤報する、読取の枠の分け方、ロック待ち、準備の呼出し、画面の割り振り（3 段目）。
- `detectDisplayIdCollision`（`40`）はファイルの中の取引どうしだけを比べる（他のファイルを読まない）ので、並列の穴ではない。

## 2. 直すこと

### 2.1 重複はロックの中の読取で判定する（`60`・`71`・`10`）

1. **行の写し方を共通にする（`10`）**：`permanentIndexRowsForScan_` の中の「1 行を `{fileId, customerId, …, _rowNumber}` に写す」部分を `permanentIndexRowFromValues_(values, rowNumber)` として切り出し、`permanentIndexRowsForScan_` もそれを使う（振る舞いは変えない）。
2. **`updateProcessLogAndContentHash_(fileId, fields, duplicateCheck)`（`60`）**：第 3 引数 `duplicateCheck`（`{customerId, hashVersion}`、省略可）を足す。ロックの中で次を行う。
   - **読取は 1 回の `batchGet`（マスター）**：範囲は「処理ログの自分の行（行番号を覚えているとき）」と「恒久ファイルインデックスの `A2:M`（全行、`FILE_INDEX_WIDTH_` 列）」。`sheetsReadRanges_` を通す。
   - **自分の恒久ファイルインデックスの行は、全行の読取から A 列＝`fileId` で探す**（覚えた行番号には頼らない）。2 行以上なら、今の `cachedFileRecord_` と同じ `IntegrityError('TRANSACTION_LOG_AMBIGUOUS', 'Duplicate permanent file index fileId')` を投げる（何も書かない）。0 行なら今と同じ `REQUIRED_LOG_WRITE_FAILED`。見つけた行番号は `fileRowNumberCache_.index` に覚える。
   - 処理ログの行：覚えた行番号の読取で H 列（8 列目）が `fileId` なら使う。覚えていない・ずれていたら、今の `getFileRecordsPair_` と同じく `getProcessLogRecord_(fileId)` で引き直す（覚えた番号は消す）。
   - INV-07 の判定（両方の表の提出時点ハッシュ）は今と同じ順・同じ文言で、**書く前に**行う。
   - **`duplicateCheck` があれば**、全行の読取から「A 列が空でない・自分の `fileId` でない行」を `permanentIndexRowFromValues_` で写し、今の `71` と同じ形 `{customerId, fileId, contentHash, hashVersion, active: true}` にして `checkDuplicateFile(duplicateCheck.customerId, fields.submittedContentHash, duplicateCheck.hashVersion, rows)` で判定する。**判定は INV-07 の判定の後・書込の前**に行う。重複でも書込（F 列を含む）は今と同じく行う（1 本ずつの今の振る舞いと同じ。後から来た同じ中身のファイルもハッシュを持つ）。
   - 書込（1 回の `batchUpdate`）は今と同じ。
   - 戻り値は今の `writtenRecords_(…)` に `duplicate` を足したもの（`duplicateCheck` が無ければ `null`）。
   - `getFileRecordsPair_` は変えない（`transitionFileState` など他の呼出し元がある）。
3. **`processDiscoveredFile_`（`71`）**：708〜715 行の外の読取と `checkDuplicateFile` をやめ、`updateProcessLogAndContentHash_(fileId, {...}, {customerId: customer.customerId, hashVersion: VERSIONS.HASH})` の戻り値の `duplicate` を `validation.duplicate` に入れる。コメントで「なぜロックの中か」（§1.1-1 の穴、先に書いたほうが原本）を書く。区分の判定（`processFile` の中）は `updateProcessLogAndContentHash_` の後なので、評価順は変わらない。
4. **読取は 1 ファイルで 1 減る**（2 → 1。§1.2）。

### 2.2 用途修正版はロックの中でもう一度判定する（`61`・`70`）

外の判定（`71` 722〜731 行）は**そのまま残す**（§1.1-3）。そのうえで、取引を登録するロックの中で、もう一度同じ判定を行う。

1. **判定材料の作り方を共通にする（`61`）**：`queryTxIndex` の中の「1 行を `{fullTxId, customerId, fileId, occurrenceIndex, identityHash, contentHash, hashVersion, freeeStatus, active, registeredAt, updatedAt}` に写し、`filter` で落とす」部分を補助（例：`txIndexItemsFromRows_(records, customerId, filter, lookbackCutoff)`）に切り出し、`queryTxIndex` もそれを使う（振る舞いは変えない）。ロックの中の判定は `{purpose: 'FREEE_PENDING'}` でこの補助を通す ── **外の判定と絞り込みが食い違わないようにするため。**
2. **`registerPrepared(txs, runId, existingByIdHint, options)`（`61`）**：第 4 引数 `options`（省略可）を足す。`options.purposeRevision` が `{customerId, identityHashes, contentHash, hashVersion}` のときだけ、ロックの中で次を行う。
   - **まず書かずに組み立てる。**既存行の更新（今の `logSheet.getRange(…).setValues([updatedRow])`）は、配列に集めて後で書く。新しい行（`appends`）も今と同じく集める。
   - **新しい行が 1 つも無ければ判定しない**（その取引はすべて前の実行で登録済み＝このファイルが先に登録している。読取も増やさない）。
   - 新しい行があれば、**取引インデックスのスプレッドシートを 1 回の `batchGet` で読む**：範囲は、前年（今年 −1）のシートが在ればその `A1:K`、今年のシートが在ればその `A1:K`（年は `nowIso_()` から。`queryTxIndex` の `FREEE_PENDING` と同じ 2 年）。シートの有無は `getTxIndexSheet(customerId, year, false)` で確かめ、**判定のために新しいシートを作らない**（無ければ空として扱う）。
   - 読んだ行（各シートの 2 行目から）を 1 の補助で `FREEE_PENDING` の絞り込みに通し、`checkPurposeRevisionCandidate(customerId, identityHashes, contentHash, hashVersion, items, {})` で判定する（外の判定と同じ引数の形）。
   - **候補なら、何も書かずに**（既存行の更新も、取引ログ・取引インデックスへの追記も、シートの作成もせずに）`{registered: false, purposeRevision: <判定の結果>}` を返す。ログに 1 行 `PURPOSE_REVISION_IN_LOCK {"fileId": …, "matchedFileId": …}` を出す（ID だけ。金額・店名・用途は出さない）。
   - 候補でなければ、集めた既存行の更新を今と同じ順で書き、追記は今と同じ（取引ログは `appendRowsBatched_` が位置を読む）。**取引インデックスの追記は、いま読んだ今年のシートの末尾の次から書く**（`appendRowsBatched_` に第 5 引数 `knownLastRow` を足し、あれば `apiLastDataRow_` を読まない。末尾の求め方は `apiLastDataRows_` と同じ ── 1 行目の見出しを含め、末尾の全空行を落とした行数）。今年のシートが無かった（読まなかった）ときは今までどおり `indexSheetFor` で作り、`appendRowsBatched_` が位置を読む（その年の最初の登録だけ読取 +1）。
   - 戻り値は `{registered: true, purposeRevision: null}`。
   - `options.purposeRevision` が無いときは、今と同じ流れ（書く順も読取も）。戻り値は `{registered: true, purposeRevision: null}` でよい。
   - 読取の回数は変わらない（今の `append:idx:last` の 1 回が、前年・今年をまとめた 1 回になる）。
3. **`runPreValidationBlock`（`70`）**：`registerPrepared` を呼ぶ前に、次がすべて成り立つときだけ `options.purposeRevision` を渡す。
   - `validation.purposeRevision` が在る（取込の経路 `71` が外の判定をしたとき。手で `validation` を渡すテストや他の経路は今のまま）。
   - `validation.contentHash`・`validation.hashVersion` が在る。
   - `validationCauseApproved_(validation, 'PURPOSE_REVISION_CANDIDATE')` が偽（**承認済みなら判定しない** ── 承認した要因を再び止めると INV-28 の無限ループになる）。
   - 渡す値：`customerId` は `input.customer.customerId`、`identityHashes` は `input.transactions` の `identityHash` を並びのまま（外の判定と同じ）、`contentHash`・`hashVersion` は `validation` の値。
4. **候補が返ったら（`70`）**：`validation.purposeRevision` をその結果に置き換えて `classifyValidationResult(validation)` で判定し直し、**区分 2 として返す**（`preValidationResult_(2, code, [], 判定し直した reviewEntries, {classification: 判定し直した結果, purposeRevisionInLock: true})`）。取引単位の要確認（取引先など）は返さない。`incrementRunTransactionCount` は呼ばない。判定し直した区分が 2 でなければ（起きないはず ── 承認済みなら判定していない）`IntegrityError` を投げる（黙って書かない）。`processFile` は今の区分 2 の道（ファイル単位の要確認を登録 → `REVIEW_WAIT`）を通る。状態はまだ `VALIDATING` なので、遷移も今の区分 2 と同じ。
5. `52_FileResolution.gs` の `registerPrepared([tx], runId)` は変えない（判定しない）。

## 3. 変えないこと

- 判定の規則（`checkDuplicateFile`・`checkPurposeRevisionCandidate`・`classifyValidationResult`・`validationCauseApproved_`）、区分の評価順、要確認の種類と中身、画面（`81`・`80`）、状態の遷移、帳簿に書く値。
- 外の用途修正版の判定（`71` 722〜731 行）と、その `try/catch`。
- `getFileRecordsPair_`・`transitionFileState`・`createOrUpdateProcessLog`・`permanentIndexRowsForScan_` の振る舞い（1 の切り出しだけ）。
- `withScriptLock_`・入れ子を拒む模擬ロック・ロックを取る場所（新しくロックを取らない。入れ子を作らない）。
- 読取の回数（例外は §2.1-4 の 1 減ることと、§2.2-2 のその年の最初の登録の +1）。
- **既存のテストの期待（assert）。**ただし、次は読取が 1 減ったぶんだけ**実測値に合わせて**直してよい（直したら報告する）：
  - `pf 1`（`phase8-webapp`）：2 本目の読取 20 → 実測（19 のはず）。メッセージに K-W25 の理由を足す。
  - `budget 1`（`phase6-round-trips`）・`multi 14`（`phase8-webapp`）：上限 20 → 実測（テストのコメントどおり「上限は実測値そのもの」）。
  - 実測が 19 にならない（20 のまま、または 18 以下）なら、直さずに止めて報告すること。ほかの既存のテストが赤になったら、変えずに止めて報告すること。

## 4. テスト（`kw25 N: …`）

置き場所は新しいファイル `test/phase4-dedup-in-lock.test.js` を基本とする（取込を通す準備の補助が既存のファイルにしか無ければ、そこに置いてよい。置いた場所を報告する）。

**「別の実行が先にロックを通った」の作り方**：`withScriptLock_` を包み、対象の関数（`updateProcessLogAndContentHash_` または `registerPrepared`）の中で取られるロックの**中身が走る直前**に、「別の実行が書いた行」を模擬のシートへ直に書く（ロックを取った時点で相手の書込が済んでいる状態）。ロックの外で読んでから入る作りでは、この行が見えないので赤になる。

1. **kw25 1（重複：ロックの時点の内容で決まる）**：ファイル B を取り込む。B の `updateProcessLogAndContentHash_` のロックの中身の直前に、恒久ファイルインデックスへ別のファイル A の行（同じ顧客・同じ `hashVersion`・F 列＝B の明細内容ハッシュ）を書く。→ B は区分 2（`DUPLICATE_CONTENT`）、状態 `REVIEW_WAIT`、ファイル単位の要確認（`DUPLICATE`）が 1 件。B の取引は取引ログ・取引インデックスに 0 行、転記先は変わらない。
2. **kw25 2（重複：1 本ずつでも今と同じ）**：A を取り込み終えてから、同じ中身の B を取り込む → B は `DUPLICATE_CONTENT`（今と同じ）。A の結果は変わらない。
3. **kw25 3（自分の行・別の顧客・別の版は数えない）**：B の恒久ファイルインデックスの行の F 列に、すでに同じハッシュがある（再合流）だけなら重複にならない。同じハッシュでも別の顧客の行・別の `hashVersion` の行しか無ければ重複にならない。
4. **kw25 4（読取は 1 回・自分の行は全行の読取から）**：処理ログの行番号を覚えているとき、`updateProcessLogAndContentHash_`（`duplicateCheck` あり）の `batchGet` は 1 回。恒久ファイルインデックスの行番号の記憶が無い・別の行を指しているときも 1 回で、正しい行に書く（他のファイルの行は変わらない）。自分の `fileId` の行が 2 つあれば投げ、どちらの表にも書かない。
5. **kw25 5（重複の判定はロックの外で読まない）**：取込 1 ファイルの処理（`processDiscoveredFile_`）の間、`permanentIndexRowsForScan_` が呼ばれない。そのファイルの処理の中で恒久ファイルインデックスの全行を読むのは、`updateProcessLogAndContentHash_` のロックの中の 1 回だけ（呼出しの前の走査・前検査 `runCustomerIntegrityCheck_` の読取は数えない）。
6. **kw25 6（用途修正版：ロックの時点の内容で決まる）**：ファイル A' を取り込む。A' の `registerPrepared` のロックの中身の直前に、取引インデックス（今年のシート）へ別のファイル A の行（同じ顧客・同じ `hashVersion`・A' と同じ取引同一性ハッシュの並びと出現順・違う明細内容ハッシュ・有効・freee 未取込）を書く。→ A' は区分 2（`PURPOSE_REVISION_CANDIDATE`）、状態 `REVIEW_WAIT`、ファイル単位の要確認（`DUPLICATE`）が 1 件、取引先の要確認は 0 件。A' の取引は取引ログ・取引インデックスに 0 行、転記先は変わらない（行の予約も無い）、実行の取引件数（`incrementRunTransactionCount`）は増えない。ログに `PURPOSE_REVISION_IN_LOCK` が 1 行（ID だけ）。
7. **kw25 7（再合流でも何も書かない）**：A' の取引のうちいくつかが取引ログに `PREPARED` で既にあり（再合流）、新しい取引もある状態で 6 と同じ割込み → 既存の行は 1 セルも変わらず、追記も無い。
8. **kw25 8（承認済みなら止めない）**：A' の `PURPOSE_REVISION_CANDIDATE` が承認済み（`validationApprovals` に A' の明細内容ハッシュと版で）のとき、6 と同じ割込みがあっても登録・転記は進む（今と同じ）。そのときの取引インデックスの読取は今と同じ（`append:idx:last` の 1 回）。
9. **kw25 9（読取は増えない・追記の位置）**：前年と今年のシートがある状態で、判定ありの `registerPrepared` の取引インデックスの読取は `batchGet` 1 回（範囲に前年と今年の両方）で、`append:idx:last` の読取は無い。新しい行は今年のシートの本当の末尾の次から書かれる（前年のシートには書かない）。判定なし（`options` なし）の読取の数は直す前と同じ（直す前に実測して固定する）。
10. **kw25 10（追記が無ければ読まない）**：取引がすべて既存（再合流）なら、判定ありでも取引インデックスを読まず、既存の行の更新は今と同じ。
11. **kw25 11（絞り込みは外の判定と同じ）**：割込みの行が「無効」「freee 取込済み」「別の顧客」「別の `hashVersion`」「並びが違う」のどれかなら候補にならず、登録は進む。割込みの行が**前年のシート**にあれば候補になる。同じ材料で外の判定（`queryTxIndex` ＋ `checkPurposeRevisionCandidate`）とロックの中の判定が同じ答えを返す。
12. **kw25 12（今年のシートが無い）**：今年のシートが無く、前年のシートの行で候補になる → 今年のシートを作らない。候補でない → 今までどおり作って追記する。
13. **kw25 13（他の呼出しは変わらない）**：`registerPrepared([tx], runId)`（`options` なし）は判定せず、読取・書込が直す前と同じ。
14. **kw25 14（使う場所の決まり）**：`src/*.gs` を読み（`97_Ops.gs` はバイトのまま読んでから文字列にする）、`checkDuplicateFile(` を呼ぶのは `60` の `updateProcessLogAndContentHash_` の中だけ（`41` の定義を除く）。`71` の `processDiscoveredFile_` に `permanentIndexRowsForScan_(` が無い。`61` の `registerPrepared` が `checkPurposeRevisionCandidate(` を呼び、`queryTxIndex` とロックの中の判定が同じ補助を使う。

## 5. 変異（M1〜M18）── それぞれ赤になるテストを記録する

- M1：`71` で外の読取に戻し、その行で `checkDuplicateFile` を呼ぶ（ロックの中の結果を使わない）
- M2：`updateProcessLogAndContentHash_` が恒久ファイルインデックスをロックの前（`withScriptLock_` の外）で読む
- M3：重複の判定で自分の `fileId` の行を除かない
- M4：重複の判定の行の顧客を、判定する顧客に置き換える（別の顧客の行を数える）
- M5：戻り値の `duplicate` を `validation.duplicate` に入れない
- M6：自分の恒久ファイルインデックスの行を、全行の読取でなく覚えた行番号で決める
- M7：`registerPrepared` のロックの中の判定を消す
- M8：既存行の更新を判定の前に書く
- M9：候補のときも `incrementRunTransactionCount` を呼ぶ
- M10：承認済みでも判定する
- M11：`knownLastRow` を渡さない（`append:idx:last` を別に読む）
- M12：追記の位置を前年のシートの末尾から求める
- M13：新しい行が無くても判定する
- M14：ロックの中の判定で freee 取込済みの行を落とさない
- M15：前年のシートを読まない
- M16：判定の前に今年のシートを作る
- M17：候補のとき、取引先の要確認も返す（登録する）
- M18：`pf 1` の読取が 20 に戻る形（`71` の外の読取を、使わずに残す）

赤にならない変異があれば、テストを足して赤にできるか試し、足したものを報告する。

## 5.1 実装と監査の記録（2026-10-15）

- **Codex**（指示書 `work/codex_prompt_import_dedup_in_lock.txt`、1 回で完了・止まらず）：開始時 1543/1543。kw25 を書いて赤 21・緑 5（kw25 2・8・9 の判定なし・10・13 ＝今も成り立つ振る舞い）を確かめてから実装。終了 1569/1569。M1〜M18 すべて赤。模擬・ハーネスは無変更（「別の実行が先にロックを通った」はテストの中で `withScriptLock_` を包み、ロックを取った後・中身の直前に相手の行を書いて作った）。テストは `test/phase4-dedup-in-lock.test.js`（直接呼ぶもの）と `test/kw25-import-helpers.js`（取込を通すもの。`phase8-webapp` の準備の補助を使うので、そこから登録する）。
- 読取の実測：1 ファイル 20 → 19（`pf 1`・`budget 1`・`multi 14` を 19 に）。ハッシュの書込は 1（恒久ファイルインデックスの行番号を覚えていない・ずれているときは 3 → 1）。判定ありの登録は 2 のまま（取引ログの末尾 1・取引インデックス 1）。
- **私の監査**：src の差分は 5 ファイルだけ、既存テストの変更は認めた 3 つ（`pf 1`・`budget 1`・`multi 14`）だけ。97 は開始時と同一（NUL 2）、5 ファイルとも LF・BOM なし、`???` 0、U+FFFD は src 0・test は元からの 1。差分は仕様どおり。**私の変異 X1〜X7・X15〜X18 のうち 1 つがすり抜けた** ── X1（処理ログの覚えた行番号を H 列で照合しない＝別のファイルの行へハッシュを書く）。`kw25 4b` を足して赤にした。ほかは赤（X7「ロックの中の絞り込みを外す」は、無効の行は `checkPurposeRevisionCandidate` の中でも落ちるので freee 取込済みの行だけで赤になる）。テストの中の計測用の `console.log` 3 行は消した。終了 **1570/1570**。

## 6. 受入（実機）

1. F5 で開き直し、Web アプリで取込 1 回（1〜2 ファイル）。
2. `IMPORT_CALL`・`PHASES` の 1 ファイルの読取が、gas-push-115 の同じ種類のファイルより 1 少ない（形式が決まったファイル。転記したファイルは 27〜28 → 26〜27 のはず）。
3. `opsShowLeases` が `(リースなし)`。
4. （任意・ko-ch さんの判断）取込済みのファイルの写しを同じカードのフォルダへ入れて［記帳を実行］→「同じ内容のファイルがある」の要確認になる → そのファイルを取り消す。1 本ずつの重複の判定が新しい場所でも働くことを確かめる。

**受入の結果（2026-10-17、合格）：**ko-ch さんが楽天カード（TEST01）で取込 1 回（10-17 15:47〜15:50、gas-push-116）。1 回の呼出しで 4 本（要修正 1・転記 3）、門が 1 本を次へ回した（`GATE`）。転記したファイルの読取は 23・19・19（10-14 の au の同じ並び〔要修正の次の転記〕は 28）── 増えていない。前検査の所見 0、`quotaHits` 0、取込のあと `opsShowLeases`＝`(リースなし)`（10-17 16:06）。同じ中身・用途修正版の誤判定なし（3 本とも転記）。4 は行っていない。
- 気づいたこと（記録だけ）：enavi202511 の `register` の段が 46.9 秒（段の内訳の `steps` は約 3 秒、均しの待ちは無し）。ロック待ちか API の遅れかはこのログでは分からない（K-W26 で `IMPORT_CALL` にロック待ちの計測 `lock` を足した）。門で始めなかった 1 本の続きの呼出しは、ログに無い（16:06 まで）。

## 7. 3 段目への申し送り

- 3 段目：準備の呼出し（複製・全体の前検査）、画面の待ち行列から 2 本へ割り振る、各本の読取の枠を 27 に分ける、前検査から相手の取込中のファイルを外す、ロックの中では読取の均しの待ちを入れない、ロック待ちを 60 秒に。
- `queryTxIndex` は年ごとに 1 回ずつ読む。2027 年からは前年のシートができ、外の用途修正版の判定の読取が 1 増える。3 段目の読取の見直しで、年をまとめて 1 回の `batchGet` にする（ロックの中の判定は本書で 1 回にまとめた）。

# 取込の要確認の登録と前検査をまとめ、「処理中」に動きを付ける 仕様書（`spec_webapp.md` §15-6 の第二手）

作成日：2026-10-03
版：1.0
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いてあることは変えない。書いていないことは安全側で決め、決めたことは全部報告する。

改訂履歴：
- 1.0（2026-10-03）：初版。ko-ch さんの依頼（2026-10-03）：「取込の高速化：要確認の登録をまとめる、取込前の検査の読み直しをまとめる、「処理中」に動きを付ける」。
  **実装（Codex）と監査（Claude）の記録：**Codex は 1371 → 1381/1381、P1〜P11 は全部赤。実測（ハーネス）：要確認の登録 2 件／40 件 ＝ 6／120 読取 → 3／3、取込の結線（要確認 30 件と 0 件のファイル）＝ 123／31 → 35／31、前検査（未完了 1／5 ファイル）＝ 3／15 → 3／3。Codex の工夫：1 つの取引に日付と取引先の 2 つの要確認が立つとき、覚えた行を 2 度読んで「重複した取引」と誤認しないよう取引 ID を 1 回だけ引く。**監査で直したもの：**60 秒返らないときの案内が、確定のときにも「取り込んでいる」と言っていた → 確定用の文言を分けた（imp 11）。変異を戻した後の差分のハッシュが 1 度だけ食い違ったと Codex が報告したので、差分を全部読んで取り残しが無いことを確かめた。最終 1382/1382。

---

## 1. 何を直すか

2026-10-02 夜、セゾン 11 ファイルを Web アプリで取り込んだ実測（`IMPORT_CALL`・`PHASES`）：10 回の呼出しで 36 分、1 ファイル約 3.3 分。新しいカードで辞書に店が無く、要確認（`PARTNER`）が 256 件立った。

1. **要確認の登録（`write:reviews`）が全体の約半分：合計約 1,080 秒、1 件約 4.2 秒・約 7 読取。**`registerPendingReviews`（50）は 1 件ごとに `getTransaction`（2 読取）と `registerReview`（ロック＋要確認シート全体の読取 1＋`appendRow`）を呼ぶ。1 ファイルの読取は 62〜203 回（要確認 0 件なら約 26）。
2. **前検査（`runCustomerIntegrityCheck_`、71）が未完了のファイルを 1 件ずつ読む：**呼出しの範囲のファイルと、`VALIDATING`／`WRITING`／`REVIEW_WAIT` の全ファイルについて、`getTransactionsByStatus`（2 読取）と `getProcessLogRecord_`（1〜2 読取）を払う。`REVIEW_WAIT` が増えるたびに 1 呼出しが +4 読取・+約 4 秒（11 読取 7.6 秒 → 48 読取 49 秒）。
3. **画面の「処理中… n / m」は呼出しが返ったときしか変わらない。**1 呼出しが最大 6 ファイルになったので、最初の更新まで 3〜4 分止まって見える（ko-ch さん 2026-10-02：「待っていていいの？」。例として「処理中→→→」の矢印を動かす・点滅させる）。

## 1.1 本仕様がすること

1. `registerPendingReviews` を、**読取は件数に依らない回数（3 回前後）、書込は 1 回**にする（§2.1）。結果は 1 件ずつ登録したときと同じ。
2. 前検査の読取を、**未完了ファイルの数に依らない回数**にする（§2.2）。所見は今と同じ。
3. 画面の取込と確定の進捗に、**動く印と経過時間**を出す（§2.3）。サーバーは触らない。

---

## 2. 設計

### 2.1 要確認のまとめ登録（`src/50_ReviewStore.gs` の `registerPendingReviews`）

**署名と戻り値は変えない**（`registerPendingReviews(entries) → {registered: [{registered: true, reviewId, suppressionKey}], skipped: [{reviewType, fullTxId, reason, transactionStatus?, reviewId?}]}`）。並びも今と同じ（`entries` の順）。

手順：
1. 入力の検査（何も読まず何も書かない）：配列でなければ `TypeError`（今と同じ）。各要素に `assertReviewDetailShape_(entry.detail)` と `buildSuppressionKey(...)`（今の `registerReview` と同じ引数）を**先に全部**掛ける。1 つでも投げたら、そのまま投げる（**1 件も書かない** ── 今は前の件まで書いてから投げる。§4 の判断の記録）。`reviewType` が無い要素は `registerReview` と同じ `TypeError`。
2. 取引単位の種別の件の `fullTxId` を集め、**1 回で**引く（`activeTransactionRecordsByIds_(ids)`。取込の区間の中なら覚えた位置で 1 読取になる）。`fullTxId` が空の件は今と同じく「見つからない」。状態が `PREPARED`／`WRITING`／`REVIEW_REQUIRED` 以外なら今と同じ `skipped`（`TRANSACTION_ALREADY_SETTLED`＋`transactionStatus`）、無ければ `TRANSACTION_NOT_FOUND`（`transactionStatus: null`）。ファイル単位の種別は今と同じく状態で絞らない。
3. `withScriptLock_` の中で：
   1. 要確認シートを 1 回読む（`allReviewRecords_()`）。`OPEN`／`IN_PROGRESS` の抑止キーの集合を作る（キー → reviewId）。
   2. `entries` の順に、抑止キーが集合にあれば `skipped`（`SUPPRESSED`＋その `reviewId`）、無ければ行を作って集合に足す（**同じまとまりの中で同じキーが 2 回現れたら、2 回目は 1 回目の `reviewId` で `SUPPRESSED`**）。行の中身は `registerReview` と同じ（列・値・`generateId('RV')`・`nowIso_()`）── **行を作る処理は `registerReview` と共有する 1 つの補助関数に出す**（2 か所に書くと片方だけ直る）。
   3. 足す行があれば、`ensureRowExists_` で行を確保し、`sheet.getRange(sheet.getLastRow() + 1, 1, 件数, REVIEW_SHEET_WIDTH_).setValues(rows)` で **1 回で**書く（`appendRow` と同じ SpreadsheetApp の書込なので、値の解釈は今と変わらない）。
4. 戻り値を作る。

`registerReview`（1 件の登録）は今のまま残す（取込以外の経路が使う）。中の行を作る処理だけ、上の補助関数を使う形にする。

### 2.2 前検査の読取をまとめる（`src/71_RunOrchestrator.gs` の `runCustomerIntegrityCheck_`）

対象のファイルの決め方（今回の範囲のファイル＋その顧客の `VALIDATING`／`WRITING`／`REVIEW_WAIT`）と、`runIntegrityCheck` へ渡す材料・呼ぶ回数（**ファイル 1 件につき 1 回**。`scope 1〜3` が数えている）は変えない。変えるのは材料の読み方だけ：

1. 対象のファイルの ID を集める。0 件なら今と同じ（索引も作らない）。
2. 取引：`findRowsByColumnValues_(transactionLogSheet_(), 5, fileIds, TRANSACTION_LOG_WIDTH_)` を 1 回。`txLogFromRecord_` で読み、有効な行（`active === true`）で、状態が `PREPARED`／`WRITING`／`COMMITTED`／`REVIEW_REQUIRED` のものだけを、ファイルごとに**取引ログの行順で**並べる（今の `getTransactionsByStatus` と同じ集合・同じ並び）。
3. 処理ログ：`findRowsByColumnValues_(processLogSheet_(), 8, fileIds, PROCESS_LOG_WIDTH_)` を 1 回。1 つのファイルに行が 2 つ以上あれば、`getProcessLogRecord_` と同じ `IntegrityError('TRANSACTION_LOG_AMBIGUOUS', 'Duplicate process log fileId')` を投げる。行が無ければ `processLogState: null`（今と同じ）。
4. 読んだ処理ログの行番号を `fileRowNumberCache_.process` に覚えてよい（位置だけ。`cachedFileRecord_` が使う前に鍵列を検算するので安全）── 取込の後の段がそのファイルの処理ログを読むとき、鍵列の走査を省ける。

読取：恒久ファイルインデックス 1 ＋ 取引 2 ＋ 処理ログ 2 ＝ 5 回前後で、対象のファイル数に依らない（索引の作成は今のまま）。

### 2.3 「処理中」に動きと経過時間を出す（`src/81_WebAppUi.html`）

- 取込（`import-progress`）と確定（`resolve-progress`）の進捗の行は、処理中のあいだ次の形にする：

  `処理中 →→→ 3 / 12（経過 1:23）`

  - 「→→→」は CSS のアニメーションで左から順に濃くなる（3 つの矢印の `opacity` を時間差で上下させる `@keyframes`。1 周 1.2 秒前後）。**`@media (prefers-reduced-motion: reduce)` では動かさない**（矢印は止めて表示し、経過時間だけ進める）。
  - 経過時間は押下からの時間で、**1 秒ごとに**更新する（`setInterval`。処理が終わったら必ず止める ── 例外・世代違い・顧客の切替えでも止める）。
  - 1 回の呼出しが 60 秒を超えて返らないときは、その下に `TEXT.processingHint`：「複数のファイルをまとめて取り込んでいるため、表示が進むまで数分かかることがあります。このままお待ちください。」を出す（呼出しが返ったら消す）。
- 純関数（テストが `clientEval` で呼ぶ）：
  - `formatElapsed(ms) → 'm:ss'`（0 → `0:00`、83000 → `1:23`、3600000 → `60:00`、負や数でないものは `0:00`）
  - `progressText(done, total, elapsedMs) → string`（上の形の文字列。矢印の部分は表示用の要素なので文字列には含めず、`処理中 ` の後に置く要素を別に描く ── 文言の組み立ては関数、動きは CSS）
- `TEXT.processing` の今の呼出し（`処理中… n / m`）は、この新しい表示に置き換える。テストが `TEXT.processing` を見ている場合は、その期待を変えずに済む形（関数を残して新しい表示から使う等）にする。

---

## 3. 変えてよいファイル

- `src/50_ReviewStore.gs`（`registerPendingReviews`・`registerReview` の行を作る部分・新しい補助関数）
- `src/71_RunOrchestrator.gs`（`runCustomerIntegrityCheck_` だけ）
- `src/81_WebAppUi.html`（進捗の表示だけ。CSS・`TEXT`・`startImport`／`startResolve` の進捗の行・新しい補助関数）

---

## 4. テスト（`imp N: …`。登録と前検査は `test/phase8-webapp.test.js` か、近い既存のファイルに足す）

1. **登録の同値：**同じ `entries`（取引単位 3 件＋ファイル単位 1 件＋抑止される 1 件＋状態で外れる 1 件＋取引が無い 1 件）を、今の 1 件ずつの登録と新しいまとめ登録で入れた結果（要確認行の全列。ID と日時を除く、`registered`・`skipped` の中身と並び）が一致する。
2. **登録の読取が件数に依らない：**取引単位 2 件と 40 件で `batchGet` の回数が等しい（3 回前後。実測を報告）。書込は 1 回の `setValues`。
3. **同じまとまりの中の重複：**同じ抑止キーの 2 件は 1 行だけ登録し、2 件目は 1 件目の `reviewId` で `SUPPRESSED`。
4. **検査の失敗で 1 件も書かない：**3 件目の `detail` の形が不正なら `TypeError` を投げ、要確認シートは 1 行も増えない。
5. **取込の結線：**Web アプリ取込で、要確認が 30 件立つファイルと 0 件のファイルの読取の数（`fileResults[].reads`。`PHASES` の段ごとの読取は取れないのでファイル単位で比べる）の差が 5 以下。今の実装では差が約 90 になる（1 件 3 読取）。
6. **前検査の同値：**未完了のファイル 3 つ（`REVIEW_WAIT` 2・範囲内 1）を持つ世界で、所見（`findings` の中身と並び）・`stop`・`indexesBuilt` が今の実装と一致する（今の実装を手元で呼んで比べる形にしてよい）。
7. **前検査の読取が未完了ファイル数に依らない：**`REVIEW_WAIT` 1 つと 5 つで、前検査の `batchGet` の回数が等しい（索引の作成ぶんを除いて比べる、または転記先を共通にして揃える）。
8. **前検査の重複：**同じファイルの処理ログ行が 2 つあると、今と同じ `TRANSACTION_LOG_AMBIGUOUS` で止まる。
9. **画面：**`formatElapsed` の 4 例、`progressText` の形、CSS に `@keyframes` と `prefers-reduced-motion` がある、`processingHint` の文言がある。
10. **画面：**経過時間の更新が終わったら止まる（`startImport` の `finally` で止める関数が呼ばれる。タイマーの開始と停止を補助関数に出し、`clientEval` で開始 → 停止の後に動いていないことを確かめる形でよい）。

既存のテストの期待は 1 つも変えないこと。**とくに読取の回数を数えるテスト（`budget 1`・`budget 2`・`multi 14`・`kw9` の読取の数・`scope 1〜3`）が、回数が減ったことで赤になるなら（上限ではなく等号で固定しているなら）、変えずに止めて報告すること。**

---

## 5. 変異

- P1 まとめ登録で、同じまとまりの中の重複を見ない
- P2 まとめ登録で、既存の `OPEN` の抑止を見ない
- P3 まとめ登録で、取引の状態で外さない
- P4 まとめ登録で、検査の前に書き始める（不正な `detail` の前の件が書かれる）
- P5 まとめ登録で、行の 1 列を落とす（例：M 列 `destinationSpreadsheetId`）
- P6 前検査で、取引を状態で絞らない
- P7 前検査で、取引の並びを変える（逆順）
- P8 前検査で、処理ログの重複を見ない
- P9 前検査で、範囲内のファイルを落とす（未完了だけ見る）
- P10 画面：経過時間のタイマーを止めない
- P11 画面：`formatElapsed` の秒を 0 埋めしない

---

## 6. 受入（実機）

次の Web アプリ取込（要確認が立つファイルを含む）で `clasp logs` を読み、`PHASES` の `write:reviews` の時間と読取が要確認の件数に比例しないこと、`IMPORT_CALL` の `precheck` の段の読取が未完了ファイルの数に依らないこと、画面の矢印が動き経過時間が進むことを確かめる。

---

## 7. Claude の判断の記録

- まとめ登録は、検査に通らない要素が 1 つでもあれば 1 件も書かない（今は前の件まで書く）。取込の中で起きればプログラムの誤りで、半分だけ登録された状態のほうが後始末が難しい。
- 前検査で読んだ処理ログの位置を覚える（§2.2 の 4）。位置だけで値は覚えないので、2026-09-02 の巻き戻り事故の形にはならない。

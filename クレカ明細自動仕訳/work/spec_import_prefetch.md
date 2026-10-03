# 取込のファイル 1 本の中の読取をまとめる（先読み）仕様書（`spec_webapp.md` §15-6 の (b)）

作成日：2026-10-03
版：1.1
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いてあることは変えない。書いていないことは安全側で決め、決めたことは全部報告する。

前提：`work/spec_import_reviews_precheck.md`（要確認のまとめ登録・前検査のまとめ）が入っていること。

改訂履歴：
- 1.0（2026-10-03）：初版。ko-ch さんの依頼（2026-10-03）：「ファイル 1 本の中の読取をまとめる『先読み』」。
- 1.1（2026-10-03）：**§1.1 の #7・8 の読み違いを訂正**（1.0 は状態の更新の 2 行と書いたが、実際は内容ハッシュを処理ログと恒久ファイルインデックスへ別々のロックで書く 2 つの呼出しだった。Codex が実測 21 回で止まって判明）。§2.3 を足し、2 つを 1 つのロックの中の 1 回読み・1 回書きにする（−1、あわせて 2 つの書込の間で殺されたときの片書きを閉じる）。テスト 11〜13・変異 Q9・Q10 を足した。
  **実装（Codex、2 回）と監査（Claude）の記録：**1 回目は実測 21 回で正しく止まった（上の訂正の発端）。2 回目で 1394/1394、Q1〜Q10 は全部赤（Q6 は Codex が pf 9 を強めて赤にした）。実測（ハーネス）：2 本目以降の 1 ファイル 25 → 20 読取、`multi 14` の 1 本ごと 25 → 20・固定費 18 のまま・4 ファイル 118 → 98。上限は `budget 1`・`multi 14` を 25 → 20 に下げた。**監査で見つけた不具合 1 つ：**新しいファイルの登録を 1 回読みにした箇所で、追記先の末尾を「処理ログ・恒久ファイルインデックスの両方」常に並べていたため、**処理ログの行だけが在るファイルでは恒久ファイルインデックスの追記先を処理ログの末尾から決め、別のファイルの行を上書きし得た**（下の `cursor` は「無い側だけを詰めた配列」を前提にしている）→ 無い側だけを並べる形に直し、pf 14 を足した（直す前の形で赤を確認）。ほかに、71 で抜け落ちた理由のコメント（版の列を同じ書込に入れる・INV-05）を戻した。最終 1395/1395。

---

## 1. 何を直すか

### 1.1 いまの 1 ファイルの読取（ハーネスで 1 回ずつ記録した、要確認 0 件の新しいファイル）

`webAppRunImport` の 2 本目以降のファイル 1 本＝**25 回**。呼出し元ごと：

| # | 表 | 呼出し元 | 理由 |
|---|---|---|---|
| 1 | 処理リース | `acquireLease` | リースの取得（ロック内） |
| 2 | 処理ログ（鍵列） | `processDiscoveredFile_` → `getProcessLogRecord_` | 登録の前に既存の行を探す（**ロックの外**） |
| 3 | 恒久ファイルインデックス（鍵列） | `createOrUpdateProcessLog` → `getPermanentFileIndexRecord_` | 同上（ロック内） |
| 4 | 処理ログ＋恒久ファイルインデックス（全体） | `createOrUpdateProcessLog` → `apiLastDataRows_` | 追記先の行番号（ロック内） |
| 5 | 恒久ファイルインデックス（全体） | `permanentIndexRowsForScan_`（重複の判定） | |
| 6 | 取引インデックス | `queryTxIndex`（重複の判定） | |
| 7・8 | 処理ログの行・恒久ファイルインデックスの行 | `updateProcessLog`（提出時点の内容ハッシュほか）と、その直後の `syncPermanentContentHash` | INV-07（内容ハッシュは空か同じ値のときだけ書ける）の判定の材料。**別々のロックで、同じ時点に 2 回**（1.1 版で訂正） |
| 9 | 処理ログの行 | `getCategory2Approvals` | 区分2の承認 |
| 10 | 取引ログ（鍵列） | 事前検証の既存取引の照会 | |
| 11 | 取引ログ（全体） | `appendRowsBatched_` | 追記先の行番号（ロック内） |
| 12 | 取引インデックス（全体） | 同上 | 同上 |
| 13・14 | 処理ログの行・恒久ファイルインデックスの行 | `transitionFileState`（VALIDATING→WRITING） | 比較更新（**同じ時点に 2 回**） |
| 15 | 取引ログ（覚えた行） | 書込ブロックの取引の照会 | |
| 16 | 処理リース | `assertLeaseHeldForWrite`（行の予約） | K-W21 まで触らない |
| 17・18 | 転記先（値・式） | 行の予約の索引（ロック内） | 描画指定が要求ごとなので 2 回 |
| 19 | 処理リース | `assertLeaseHeldForWrite`（書込） | K-W21 まで触らない |
| 20 | 転記先 | 読取確認 | |
| 21 | 取引ログ（覚えた行） | 確定（ロック内の比較更新） | |
| 22 | 取引ログ（覚えた行） | `isFileFullyResolved` | |
| 23・24 | 処理ログの行・恒久ファイルインデックスの行 | `transitionFileState`（WRITING→COMPLETED） | 比較更新（**同じ時点に 2 回**） |
| 25 | 処理リース | `releaseLease` | |

**`spec_webapp.md` §15-6 (b) の見込み（43 回 → 10〜15 回）は、その後の v1.7・v1.8 の改善で大半が取り込み済みである。**残りは、ほとんどが安全のために意図して残したもの（リースの確認・ロック内の読み直し・比較更新）で、§15-6 が「触らない」と決めている。本仕様は、**同じ時点に同じスプレッドシートを 2〜3 回に分けて読んでいる箇所だけ**を 1 回の要求にまとめる。読む行・読む時点・検算は変えない。

### 1.2 本仕様がすること

1. **処理ログの行と恒久ファイルインデックスの行を 1 回の要求で読む**（#13・14、#23・24 → 各 1 回。−2）。§2.1。
3. **提出時点の内容ハッシュを、処理ログと恒久ファイルインデックスへ 1 つのロックの中で一緒に書く**（#7・8 → 1 回。−1）。§2.3。
2. **新しいファイルの登録の読取を 1 回にする**（#2・3・4 → 1 回。−2）。§2.2。

見込み：1 ファイル 25 回 → **20 回**（−20%）。12 ヶ月なら −60 回 ＝ 読取の待ちで約 1 分。

**やらないこと**（§15-6 の判断を変えない）：リースの読取（#1・16・19・25。K-W21 が前提）、転記先の 2 回（描画指定が違う）、ロック内の取引ログの読み直し（#11・21）、区分2の承認（#9。管理者がファイルを動かす経路と並ぶので、直前の値を使い回さない）、重複の判定の読取（#5・6）。

---

## 2. 設計

### 2.1 処理ログと恒久ファイルインデックスの行を 1 回で読む（`src/60_ProcessLog.gs`・`src/11_FileStateManager.gs`）

- 新しい `getFileRecordsPair_(fileId) → {process, permanent}`（60）：
  - **両方の行番号を覚えているとき**（`fileRowNumberCache_.process` と `.index` の両方）は、`sheetsReadRanges_(処理ログのシート, [処理ログの行の範囲, 恒久ファイルインデックスの行の範囲])` を **1 回**呼ぶ（2 つのシートは同じマスターのスプレッドシートなので 1 回の `batchGet` に入る。`apiLastDataRows_` が既に同じ形で 2 枚を 1 回で読んでいる）。それぞれの鍵列（処理ログは 8 列目＝H、恒久ファイルインデックスは 1 列目＝A）を**検算**し、外れた方は覚えた行番号を捨てて今までの `getProcessLogRecord_`／`getPermanentFileIndexRecord_` で読み直す（**外れた方だけ**）。
  - 片方でも覚えていなければ、今までどおり `getProcessLogRecord_(fileId)` と `getPermanentFileIndexRecord_(fileId)` を呼ぶ（読取は今と同じ）。
  - 戻りの形は `cachedFileRecord_` と同じ（`{rowNumber, values}` か `null`）。重複のときの例外も同じ。
- `updateProcessLogUnlocked_(fileId, fields, knownRecord, knownPermanent)`：第 4 引数を任意で足す。`fields.internalState` を書くとき、`knownPermanent` があればそれを使い、無ければ今までどおり読む。**`knownRecord` が無く `internalState` を書くとき**は、2 回読む代わりに `getFileRecordsPair_` を 1 回呼ぶ。**提出時点の内容ハッシュを書くとき（`submittedContentHash`）は今までどおり処理ログの行を読み直す**（INV-07。渡された行を使わない規則は変えない）── そのとき `getFileRecordsPair_` で読んだ行は「読み直した行」として使ってよい（いま読んだ値なので）。
- `updateProcessLog(fileId, fields, knownRecord, knownPermanent)`：第 4 引数を通すだけ。
- `transitionFileState`（11）：比較更新の材料を `getFileRecordsPair_` で読み、処理ログの行で今までどおり比較し、**両方の行**を `updateProcessLog` へ渡す。恒久ファイルインデックスの行が無ければ今までどおり `REQUIRED_LOG_WRITE_FAILED`（`updateProcessLogUnlocked_` が投げる）。

**読む時点は変えない。**今まで 2 回に分けて読んでいた 2 行を、同じ時点で 1 回に読むだけである。値を実行のあいだ覚えることはしない（覚えるのは今までどおり行番号だけ）。

### 2.2 新しいファイルの登録の読取を 1 回にする（`src/60_ProcessLog.gs`・`src/71_RunOrchestrator.gs`）

- `createOrUpdateProcessLog(runId, customer, file, knownProcess)` のロックの中：**処理ログの行も恒久ファイルインデックスの行も覚えていないとき**は、`sheetsReadRanges_` を **1 回**呼んで処理ログ全体（`A1:` 処理ログの幅）と恒久ファイルインデックス全体（`A1:` 恒久ファイルインデックスの幅）を読み、
  - 処理ログの 2 行目以降で H 列が `fileId` と一致する行、恒久ファイルインデックスの 2 行目以降で A 列が `fileId` と一致する行を探す（**`findRowsByColumnValue_` と同じ比較**：`String(セルの値) === String(fileId)`。2 行以上なら今と同じ `IntegrityError('TRANSACTION_LOG_AMBIGUOUS', 'Duplicate process log fileId'／'Duplicate permanent file index fileId')`）
  - 末尾のデータ行を `apiLastDataRows_` と同じ規則で求める（末尾の全空行を落とす。1 行目＝見出しを含めて数える）
  - 以上を今の `process`・`permanent`・`lastRows` の代わりに使う。見つけた行番号は今までどおり `fileRowNumberCache_` に覚える。
  - **`knownProcess` が渡されていても、この 1 回の読取の結果を使う**（ロックの中で読んだほうが新しい）。
- 片方でも行番号を覚えているときは今までの手順のまま（`knownProcess`・`getPermanentFileIndexRecord_`・`apiLastDataRows_`）。
- `processDiscoveredFile_`（71）の登録の前の `getProcessLogRecord_(fileId)`（ロックの外の鍵列の走査）は、**行番号を覚えていないときは呼ばない**（`knownProcess` を `undefined` で渡す ── 上の 1 回の読取が処理ログの行も探す）。覚えているときは今までどおり読んで渡す。
- 補助関数は 60 に置き、`findRowsByColumnValue_`・`apiLastDataRows_` の判定（文字列比較・末尾の全空行の扱い）と食い違わないこと（§4 のテストで両者を突き合わせる）。

---

### 2.3 提出時点の内容ハッシュを 2 枚へ一緒に書く（1.1 で追加。`src/60_ProcessLog.gs`・`src/71_RunOrchestrator.gs`）

いま `processDiscoveredFile_`（71）は、`updateProcessLog(fileId, {…, submittedContentHash, …})`（処理ログの行を読み直して INV-07 を判定し書く）の直後に、別のロックで `syncPermanentContentHash(fileId, contentHash)`（恒久ファイルインデックスの行を読み直して INV-07 を判定し F・L 列を書く）を呼ぶ。**同じ時点に同じスプレッドシートの 2 行を別々に読んでいる**うえ、**2 つの書込の間で殺されると、処理ログにだけ内容ハッシュが入り、恒久ファイルインデックスの F 列が空のまま残る**（同一内容の再提出を重複として見つけられなくなる。INV-05）。

- 新しい `updateProcessLogAndContentHash_(fileId, fields)`（60）：`fields.submittedContentHash` を必ず含む。`withScriptLock_` の中で、
  1. `getFileRecordsPair_(fileId)` で 2 行を**その場で**読む（覚えた行番号の位置読み 1 回。外れたら外れた方だけ読み直す）。**これは INV-07 の「読み直した行」に当たる**（ロックの中で今読んだ値である）。
  2. 処理ログの行が無ければ今と同じ `REQUIRED_LOG_WRITE_FAILED`、恒久ファイルインデックスの行が無ければ `syncPermanentContentHash` と同じ `REQUIRED_LOG_WRITE_FAILED`。
  3. **書く前に両方を判定する**：処理ログの `submittedContentHash` 列（今の `updateProcessLogUnlocked_` と同じ規則）と、恒久ファイルインデックスの F 列（今の `syncPermanentContentHash` と同じ規則・同じ例外の文言）。どちらかが外れたら**何も書かずに**投げる。
  4. 処理ログの指名された列（今の `updateProcessLogUnlocked_` と同じ範囲）と、恒久ファイルインデックスの F 列・L 列（今の `syncPermanentContentHash` と同じ）を **1 回の `batchUpdate`** で書く。`internalState` を含む場合は今の `updateProcessLogUnlocked_` と同じく恒久ファイルインデックスの D 列も書く（同じ要求に入れる）。
  5. 戻り値は `updateProcessLogUnlocked_` と同じ形（`writtenRecords_`）。
- 判定と範囲の組み立ては、**今の `updateProcessLogUnlocked_` と `syncPermanentContentHash` と共有する補助関数に出す**（2 か所に書くと片方だけ直る）。2 つの関数は今のまま残す（他の経路が使う）。
- `processDiscoveredFile_`（71）：上の 2 つの呼出しを、この 1 つの呼出しに置き換える（同じ `fields`）。

## 3. 変えてよいファイル

- `src/60_ProcessLog.gs`（`getFileRecordsPair_`・登録の 1 回読み・`updateProcessLogUnlocked_`／`updateProcessLog` の第 4 引数）
- `src/11_FileStateManager.gs`（`transitionFileState` だけ）
- `src/71_RunOrchestrator.gs`（`processDiscoveredFile_` の登録の前の 1 行と、§2.3 の内容ハッシュの 2 つの呼出しだけ）

---

## 4. テスト（`pf N: …`。`test/phase8-webapp.test.js` か近い既存のファイルに足す）

1. **1 ファイルの読取：**要確認 0 件の新しいファイルを Web アプリで取り込むと、2 本目以降のファイル 1 本の読取（`fileResults[].reads`）が今より 5 回少ない（実測を報告。上限は実測値そのもの）。`multi 14` の「1 本増えるごと」の上限（25）を下回る。
2. **2 行を 1 回で：**行番号を覚えたファイルで `transitionFileState` を呼ぶと、`batchGet` が 1 回で、処理ログと恒久ファイルインデックスの両方の状態が変わる。
3. **鍵が外れたら読み直す：**覚えた恒久ファイルインデックスの行番号を別のファイルの行に差し替える（鍵が外れる）と、その方だけ鍵列の走査で読み直し、正しい行が更新される（別のファイルの行は変わらない）。処理ログの方が外れた場合も同じ。
4. **比較更新は今のまま：**処理ログの状態が `fromState` と違えば `File compare-and-set failed`（今と同じ）、恒久ファイルインデックスの行が無ければ `REQUIRED_LOG_WRITE_FAILED`。
5. **INV-07 は今のまま：**提出時点の内容ハッシュの書込は、渡された古い行ではなく読み直した行で「空か同じ値か」を判定する（既存のテストが緑のまま。足りなければ足す）。
6. **新しいファイルの登録：**行番号を覚えていない新しいファイルの登録が `batchGet` 1 回で済み、書かれる 2 行・行番号・`fileRowNumberCache_` が今と同じ（同じ材料で今の実装と突き合わせる）。
7. **既存の行がある登録：**処理ログ・恒久ファイルインデックスに既に行がある（取り込み直し）ファイルを、行番号を覚えていない実行で登録すると、その行を更新し、行が増えない。
8. **重複：**処理ログに同じ `fileId` の行が 2 つあると、今と同じ `TRANSACTION_LOG_AMBIGUOUS` で止まり、何も書かない。恒久ファイルインデックスも同じ。
9. **末尾の判定：**末尾に空行（値の無い行）を挟んだシートで、追記先の行番号が `apiLastDataRows_` の答えと一致する。
11. **内容ハッシュを一緒に書く：**新しいファイルの取込で、処理ログの内容ハッシュと恒久ファイルインデックスの F 列が同じ 1 回の `batchUpdate` で書かれ、その前の読取は 1 回。
12. **INV-07 を両方で守る：**恒久ファイルインデックスの F 列に別のハッシュが入っていると、`Submitted content hash is immutable (INV-07)` で止まり、**処理ログにも何も書かれない**。処理ログの内容ハッシュ列に別の値が入っている場合も同じ（今の文言で止まり、恒久ファイルインデックスにも書かれない）。
13. **途中で殺されない形：**新しい関数の `batchUpdate` を 1 回目で失敗させると、2 枚とも書かれていない（片方だけ書かれた状態にならない）。
10. **数え直し：**`budget 1`・`budget 2`・`multi 14`・`pace 1` の上限を、減った実測に合わせて**下げる**（上げない）。下げた値と根拠を報告する。

既存のテストの期待は、10 で下げる上限を除き、1 つも変えないこと。読取の回数を**等号で**固定しているテストが減ったことで赤になるなら、変えずに止めて報告すること。

---

## 5. 変異

- Q1 `getFileRecordsPair_` で鍵を検算しない
- Q2 鍵が外れたとき、外れていない方まで読み直す（読取が増える。1 のテストで赤）
- Q3 `transitionFileState` が処理ログの比較更新をしない
- Q4 登録の 1 回読みで、見出しの行も鍵の照合に入れる
- Q5 登録の 1 回読みで、重複を見ない
- Q6 登録の 1 回読みで、末尾の空行を数える
- Q7 `knownProcess` がロックの外の古い行のときに、そちらを優先する
- Q8 内容ハッシュの書込で、渡された行を使う（INV-07）
- Q9 一緒に書く関数で、恒久ファイルインデックスの F 列の判定を外す
- Q10 一緒に書く関数で、判定の前に処理ログを書く（片方だけ書かれる）

---

## 6. 受入（実機）

次の Web アプリ取込で `clasp logs` の `PHASES` の `reads` が 1 ファイル 5 回前後減ったこと、`IMPORT_CALL` の `quotaHits` が 0 のままであることを確かめる。

---

## 7. Claude の判断の記録

- 見込みを小さく書いた（−20%）。§15-6 (b) の当初の見込みは v1.7・v1.8 の前のもので、残りは意図して残した読取である。リースの読取（4 回）は K-W21（世代番号）を入れてから見直す。
- 登録の 1 回読みは、2 枚のシートの全体を読む。どちらも `permanentIndexRowsForScan_` が 1 呼出しで何度も全体を読んでいる表なので、量は今と同じ桁である。

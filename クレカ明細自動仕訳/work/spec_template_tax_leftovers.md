# 雛形に残った「対象外」だけの行を片付ける運用関数 仕様書

版：1.0（2026-10-27）
対象：`src/97_Ops.gs`（新しい運用関数 1 つと、その部品）。
発端：2026-10-27、利用者がダウンロードした Amazon カードの転記シートの 47 行目・56 行目に、G 列（相手税区分）の「対象外」だけが入った行があった（Amazon の明細に返金の行は無い）。

## 1. 背景

- システムが G 列に「対象外」を書くのは、カード会社からの返金の行（顧客マスター AO 列の店名）だけ（`71` の `planned.g`、2026-09-08）。
- Web アプリ以前の取込は雛形そのものに書いていた。そのときの返金の行の取引が後で取消・取込み直しで消されたが、行を空にする処理（`clearTransactionRows`）は `txId`・B・F・I・K・M だけを消し、**G を消さない**。そのため雛形に「対象外」だけの行が残った。
- ［記帳を実行］は雛形を写して転記シートを作る。2026-10-03 までは写した後に G を消していなかったので、その間に作られた転記シートにはこの行が写り、取込はその行を使用中として飛ばした（ドコモの 47・56 行目、Amazon の 47・56 行目）。10-03 から写した後に G も消す（`webAppCloneDestination_`）ので、新しいシートには出ない。
- **利用者の決定（2026-10-27）：雛形の中に残っている「対象外」を消す。**今までの転記シートの行と、取消のときに G を消さない不具合は、今回は扱わない。

## 2. 決めたこと

1. **消すのは雛形（顧客マスターの `destinationSpreadsheetId`）だけ。**ID を引数で受け取らない（任意のシートを消せる口を作らない）。
2. **消すのは G のセル 1 つだけ。**行を消さない・ほかの列に触らない。
3. **消してよい行の条件（すべて満たす）：**データ行（`headerRow` より下）である／取引 ID 列が空／B・F・I・K・M 列がすべて空／G 列の値がちょうど「対象外」（前後の空白を除いて）。G に別の値がある「G だけの行」は消さずに報告だけする。
4. **既定は読むだけ。**`apply === true` のときだけ消す。消すときは、ロックの中で該当の行を読み直し、まだ条件を満たす行だけ消す（読んだ後に誰かが書いた行は消さない）。
5. 消したら監査ログに 1 行（何行目の G を消したか・消す前の値）。

## 3. `opsClearTemplateTaxLeftovers(customerId, apply)`（新規・公開の運用関数）

`97_Ops.gs` の運用関数の並びに置く。`loadSettingsFromProperties()` から始める。

1. `customer = getCustomerById(String(customerId))`。`columnMapping.G` が無い顧客は、何も読まずに `{customerId, spreadsheetId: null, candidates: [], others: [], cleared: [], skipped: 'NO_TAX_COLUMN'}` を返す。
2. 読む：雛形の `customer.destinationSheetName` の、`headerRow + 1` 行目から最後の行まで、A 列〜 `rowScanLastColumn` 列を **1 回**読む（`destinationRangeValues_`、`UNFORMATTED_VALUE`）。シートを開く（`openById`）のは消すときだけ。
3. 行ごとに §2 の 3 で振り分ける：
   - `candidates`：消してよい行 `{row, value}`（`row` は行番号）。
   - `others`：取引 ID と B・F・I・K・M が空で G に「対象外」以外の値がある行 `{row, value}`（消さない）。
4. `apply !== true` なら、ここで返す：`{customerId, spreadsheetId, sheetName, candidates, others, cleared: [], applied: false}`。
5. `apply === true` のとき：`withScriptLock_` の中で、`candidates` の各行を読み直し（同じ範囲の 1 行。読取は行数ぶんにせず、まとめて 1 回で読む形を選んでよい ── 選んだ形を報告）、まだ条件を満たす行の G セルだけを空にする（`Sheets.Spreadsheets.Values.batchUpdate`、RAW、空文字）。満たさなくなった行は `skippedRows` に入れて消さない。
6. 監査：消した行が 1 つでもあれば、ロックの外で `appendAudit` を 1 回（`type` は既存の監査の種類から適切なものを選ぶか、種類が自由なら `TEMPLATE_CLEANUP`。選んだものを報告）。`actor` は `activeUserEmail_()`、`targetType: 'DESTINATION'`、`targetId` は雛形の ID、`customerId`、`before: {rows: [{row, value}]}`、`after: {g: ''}`、`reason: 'TEMPLATE_TAX_LEFTOVER'`。
7. 返す：`{customerId, spreadsheetId, sheetName, candidates, others, cleared: [行番号], skippedRows: [...], applied: true}`。`Logger.log(JSON.stringify(結果))`。

取引の値・店名は返さない・ログに出さない（返すのは行番号と G の値だけ）。

## 4. 変えないこと

- `clearTransactionRows`・取消・解決操作（G を消さない不具合はそのまま。今回は扱わない）。
- `webAppCloneDestination_`、取込、転記シート（複製）。
- ほかの運用関数。

## 5. テスト（`tl N: …`、どのテストファイルに置くかは既存の運用関数のテストの並びに合わせ、報告する）

1. **tl 1（見つける）**：雛形のデータ行に、(a) G=「対象外」だけの行 2 つ、(b) G=「対象外」で取引 ID のある行、(c) G=「対象外」で B だけある行、(d) G=別の値だけの行、(e) 見出しの行の G に値、を作る → 読むだけで `candidates` は (a) の 2 行だけ、`others` は (d) だけ。雛形のどのセルも変わらない。
2. **tl 2（消す）**：`apply = true` → (a) の 2 行の G だけが空、ほかのセル（その行のほかの列・(b)〜(e)）は変わらない。監査に 1 行（行番号と消す前の値）。もう一度読むだけで `candidates` が空。
3. **tl 3（読んだ後に書かれた行）**：読むだけの後、(a) の 1 行の B に値を入れてから `apply = true` → その行は `skippedRows` で G は残る、もう 1 行は消える。
4. **tl 4（G の列が無い顧客）**：`NO_TAX_COLUMN`、何も読まない。
5. **tl 5（雛形だけ）**：複製（転記シート）に同じ形の行があっても触らない。
6. **tl 6（読取）**：読むだけの Sheets 読取（`batchGet`）と、`apply` の読取・書込を測り、**測った値そのもの**を上限にする。
7. **tl 7（取引の値を出さない）**：戻り値とログに、行のほかの列の値（店名など）が出ない。

## 6. 変異（R1〜R8）── それぞれ赤になるテストを記録する

- R1：取引 ID の確かめを外す
- R2：B・F・I・K・M の確かめを外す
- R3：「対象外」以外の値も消す
- R4：見出しの行も見る
- R5：`apply` でなくても消す
- R6：ロックの中の読み直しを外す
- R7：G 以外の列も空にする（行ごと消す）
- R8：監査を書かない

## 6.1 実装と監査の記録（2026-10-27）

- Codex（`tools/codex-logs/*-20261027-191436-*`、gpt-6.1-sol・xhigh）：1710/1710（+7、テストは新しい `test/phase6-template-tax-leftovers.test.js`）、R1〜R8 はすべて赤。読取は読むだけで `batchGet` 3（うち雛形 1）、apply で 5（うち雛形 2）・書込 1。監査の種類は `TEMPLATE_CLEANUP`。ロックの中の読み直しは候補の先頭〜末尾の行をまとめて 1 回。0・false は使用中として守る、空白だけの G は `others`、守る列が走査範囲の外なら読む前に止める。
- 監査：src の差分は 97 の新しい関数 2 つだけ（既存の部分はバイト単位で同じ、NUL 2・CR 0）。テストは架空の値だけ。全テスト 1710/1710 を私の手元でも確かめた。
- 残したこと：G のセルが数式で「対象外」を返す場合も消す（数式は見ない）。雛形の G の書き残しは取込が値で書いたもので、空き行の判定の都合でデータ行の G に数式は無いはずなので、本番では読むだけの結果（47・56 行目）を見てから消す。

## 6.2 本番の結果（2026-10-27、gas-push-125）

**読むだけの結果は候補 0 件・`others` 0 件。§1 の見立ては誤りだった。**`opsShowTaggedTransactions('キャッシュバック')`（読むだけ）で、雛形の 47・56 行目には**本物の返金の取引が 2 件**あると分かった（Web アプリ以前に雛形へ取り込んだ分。G は予定・確認とも「対象外」）。複製の 47・56 行目の「対象外」だけの行は、雛形の取引の行を写した後、システムの列（B・F・I・K・M・取引 ID）を空にしたが G を空にしなかった（10-03 まで）ために残ったもので、雛形に書き残しは無い。雛形は何も変えていない（`apply` は実行していない）。

**利用者の決定（2026-10-27）：**10-03 より前に作った複製の 47・56 行目の「対象外」は、そのままにする。この関数は既定で読むだけなので、本番に置いたままにする。

## 7. 本番での実行（私が行う。利用者の許可を得てから）

1. push 後、`opsClearTemplateTaxLeftovers('TEST01')`（読むだけ）→ `candidates` が 47・56 行目であることを利用者に見せる。
2. 許可を得て `opsClearTemplateTaxLeftovers('TEST01', true)` → `cleared` を確かめる。
3. もう一度読むだけ → `candidates` が空。

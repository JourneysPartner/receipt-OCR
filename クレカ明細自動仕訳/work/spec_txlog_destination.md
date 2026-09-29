# 取引ログに転記先を持たせる 仕様書（`spec_webapp.md` §15-4）

対象システム：クレジットカード明細 自動仕訳システム（Google Apps Script、リポジトリ `クレカ明細自動仕訳`）
作成日：2026-09-29
版：1.2

改訂履歴：
- 監査（2026-09-29、1.2 の実装）：1274/1274 緑、§9 の M1〜M25 すべて赤。src の差分は §6 のとおり（51・71・80・81 不変、97 の NUL 2 個）。既存テストの差分は §8.1 の 6 本だけ。Claude の変異 10 個のうち 4 個がすり抜けた ── 埋め戻しの読み直しが「有効か」を見ない（X3）、行を持たない旧い行も推測として検算する（X4）、中断報告が旧い行に要確認行の M列を使わない（X5）、後始末が MIXED を旧い扱いにする（X13）。コードは正しいので、テスト txdest 22〜25 を Claude が足した（4 個とも赤になることを確認）。あわせてコメントの古い記述（「AC 列は常に空」「第2段で閉じる」）を直した。シート名の違いを見ない変異（X2）は、複製が雛形と同じシート名を持つ運用なので残した。
- 1.2（2026-09-29、実装者の 2 度目の停止報告を受けて）：既存テスト `phase0.test.js` の `ERROR_CATALOG contains all 51 design codes with the required shape` が、カタログのキーを設計文書のエラー表の 51 個と厳密に比べている。§4 で `DESTINATION_MISMATCH` を足すので、このテストの一覧にも足す（§8.1）。設計文書のエラー表への追記は Claude が監査の後に行う。
- 1.1（2026-09-29、実装者の停止報告を受けて）：既存テスト `webapp 08` が「取込後の取引ログ AC・AD は空」を**期待として**固定していた。これは `spec_webapp.md` 第1段 §12.3 ケース 8 が「AC・AD は常に空なので判定に使ってはならない」という当時の事実を固定したもので、本仕様がまさにそれを覆す。§8.1 に、このテストの期待を改めることを足した（ほかに同じ種類のテストは無い）。
- 1.0（2026-09-29）：初版。

読者：本仕様だけを読んで実装する実装者（AI を含む）。書いていないことは実装者が決めてよいが、**書いてあることは変えない**。判断に迷ったら止めて報告する。

## 1. 何を直すか

### 1.1 いま「取引がどの転記先に居るか」の正本が無い

Web アプリは取込のたびに雛形を複製し（`顧客名_yyyyMMdd-HHmm`）、そこへ書く。顧客マスター F 列は「次に作るシートの雛形」であって、既に書いた取引の置き場ではない。ところが取引ログ（`クレカ取引ログ`）は**行番号（AE 列）しか持たない**：

- AC 列（転記先スプレッドシートID）・AD 列（転記先シート名）は列としては在るが、**値を書く呼出しが `src/` に 1 つも無い**。`makeTransactionRow_` は取引の物が `destinationSpreadsheetId` を持っていれば書くが、取込の取引は持たない。`settleWrittenTransactions`（61）と `updateTransactionLocation`（43）は AE だけを書く。本番の取引ログの AC・AD はすべて空である。
- 設計の元仕様（`credit_card_import_normalization_system_spec_v2.0.md` 475 行）は「転記後に転記先スプレッドシートID・シート名・行番号・読取確認値を保存し」と定めている。**実装が AE しか書いていないのは仕様からの欠落である。**

そのため、転記先を要る経路はそれぞれ別の推測をしている：

| 経路 | いまの転記先の決め方 | 外れたときの害 |
|---|---|---|
| 取引単位の要確認の確定（51 `reviewWriteCustomer_`） | 要確認行の M・N 列 | （本仕様では変えない。§6） |
| 中断ファイルの後始末（97 `opsRecoverStuckFiles` → `stuckFileWriteCustomer_`） | 要確認行の M 列、無ければ雛形と仮定し、行の検算で守る | **要確認も転記行も無い Web アプリ取込ファイル**（取込が 1 行も書く前に殺された）は雛形と仮定され、検算の効く行も無いので**雛形へ書く**（K-W10 の残る死角） |
| 中断ファイルの報告（97 `opsInspectStuckFiles`） | 雛形 | 複製へ書いた取引を「1 行も書けていない」と報告する（K-W18。実機で `rowsCarryingTxId: 0`） |
| ファイル単位の要確認（52 `CANCEL_FILE`・`APPLY_FILE_DIFF`・`ADOPT_AS_NEW_TRANSACTION`・`UPDATE_PURPOSE`）と 97 `opsReprocessFile` | 雛形（`getCustomerById`） | `CANCEL_FILE` は 1 行も消せず取引ログだけ `CANCELED` にする。`APPLY_FILE_DIFF`／`ADOPT_AS_NEW_TRANSACTION` は追加分だけ雛形へ書いて 1 ファイルを 2 枚に割る。`UPDATE_PURPOSE` は雛形の同じ行番号の無関係な行の I 列と取引ID列を上書きする（K-W14） |
| 整合性の要確認（54） | `options.customer`、無ければ雛形 | 過去の転記シートに対して確定すると雛形を開く（K-W13） |

### 1.2 1 ファイルを 2 つの転記先へ割る再取込を誰も止めない

中断したファイルを後始末で発見へ戻したあと、Web アプリで**新しいセッション**から記帳を押すと、新しい複製 C ができて、まだ書いていない取引は C へ書かれる。既に書いた取引は前の複製 B に居る。**1 ファイルの取引が 2 枚に割れる。**さらに再合流で作り直す要確認（70 の 8-10 橋渡し、K-W19）は M 列に C を持つので、その採用は **C の同じ行番号の無関係な行へ F 列と取引ID列を書く**（読取確認も C を読むので通ってしまう）。いまは運用（「同じ複製へ取り込み直す」）だけが守っている。

### 1.3 本仕様がすること

**取引ログ AC・AD 列を「取引がどの転記先に居るか（書かれる予定か）」の正本にする。**

1. 書く側（§3）：取込の登録で AC・AD に予定の転記先を書き、行番号 AE を書くときは**必ず AC・AD を同じ転記先で一緒に書く**。
2. 止める側（§4）：記録された転記先と違う転記先へ、同じファイルの取引を書こうとする取込を、書く前に止める。
3. 読む側（§5）：後始末・報告・ファイル単位の操作・整合性の操作は、まず AC・AD を見る。**AC が空の行（本仕様より前の行）は、いまの規則のまま扱う。**推測で選んだ転記先に書くときは、書く前に行の所在を検算する。
4. 旧い行の埋め戻し（§7）：本番の既存行の AC・AD を、転記先の実物を検算して埋める運用関数。既定は見るだけ。

## 2. 用語と共通の規則

- **生きている取引**：取引ログで `有効 = TRUE` かつ状態が `PREPARED`・`WRITING`・`COMMITTED`・`REVIEW_REQUIRED` のどれか。`CANCELED`・`DELETED_ACCEPTED` は行を持たないので、転記先の判断に使わない。
- **行を持つ取引**：AE 列が 1 以上の整数である取引。
- **記録された転記先**：AC 列が空でない取引の `{spreadsheetId: AC, sheetName: AD}`。**AD が空なら顧客マスターの転記先シート名（`customer.destinationSheetName`）を当てる**（`reviewWriteCustomer_` の `review.destinationSheetName || customer.destinationSheetName` と同じ規則）。2 つの転記先が等しいとは、スプレッドシートID とシート名（この当て方をした後の値）の両方が文字列として等しいことをいう。
- **空**：`''`・`null`・`undefined` のどれか（前後の空白だけの文字列も空とみなす）。**実機の Sheets API は行末の空セルを返さないことがあり、スタブは `''` を返す** ── `=== ''` だけで判定すると実機でだけ外れる。既存行の値を引き継いで書くときも、`null`・`undefined` は `''` にして書く。
- **旧い行**：AC 列が空の取引。本仕様より前に登録された行はすべてこれである。旧い行の転記先は**分からない**のであって、雛形だと決めつけない（雛形と仮定するのは、いまの規則がそうしている経路だけ）。

### 2.1 共通の部品（`src/61_TransactionLog.gs` に置く）

名前はこのとおりにする（テストが呼ぶ）。

- `recordedDestinationOf_(tx, customer)`：取引の物（`txLogFromRecord_` の戻り値）から記録された転記先を返す。AC が空なら `null`。戻り値は `{spreadsheetId: string, sheetName: string}`（§2 の当て方をした後）。
- `customerForRecordedDestination_(customer, tx)`：記録された転記先があれば、`customer` の写しに `destinationSpreadsheetId`・`destinationSheetName` を当てて返す。無ければ `customer` をそのまま返す（旧い行はいまの規則＝雛形）。
- `classifyRecordedDestinations_(txs, customer)`：取引の配列のうち**生きている取引だけ**を見て、次を返す：
  - `kind`：
    - `'NONE'`：生きている取引が 0 件。
    - `'LEGACY'`：生きている取引がすべて旧い行。
    - `'RECORDED'`：記録された転記先がちょうど 1 通りで、旧い行が 0 件。
    - `'MIXED'`：記録された転記先がちょうど 1 通りで、旧い行が 1 件以上。
    - `'AMBIGUOUS'`：記録された転記先が 2 通り以上。
  - `destinations`：記録された転記先の一覧（重複なし、最初に現れた順）。
  - `unrecorded`：生きている旧い行の取引の配列。

## 3. 書く側

### 3.1 取込の登録で予定の転記先を書く（`src/70_ImportFlow.gs` 8-12）

`runPreValidationBlock` が 8-12 で取引を組み立てるとき（`transactions = (input.transactions || []).map(...)`）、各取引の物に次を**上書きで**載せる：

- `destinationSpreadsheetId: String(input.customer.destinationSpreadsheetId)`
- `destinationSheetName: String(input.customer.destinationSheetName)`

`input.customer` は 71 が渡す書込先（Web アプリなら複製、定期取込なら雛形）である。`input.customer.destinationSpreadsheetId` が空（`null`・`undefined`・`''`）なら 2 つとも載せない（`'undefined'` という文字列を書かない）。`destinationRow` は載せない（解析からは決まらない）。`registerPrepared` → `makeTransactionRow_` が既にこの 2 つを AC・AD へ書くので、61 の新規行の組み立ては変えなくてよい。

### 3.2 再合流の登録（`src/61_TransactionLog.gs` `registerPrepared`）

既存行を組み直す箇所（いま `[28, 29, 30].forEach` で「新しい値が空なら既存行の値を引き継ぐ」をしている所）を次に改める：

- 既存行が**行を持つ**（既存行の AE が 1 以上の整数）なら、**AC・AD・AE の 3 列とも既存行の値をそのまま引き継ぐ**（AC が空の旧い行でも、空のまま引き継ぐ。今回の書込先で埋めない ── その行がどこに居るかは分からない）。
- 既存行が行を持たないなら、AC・AD は新しい値（§3.1 の予定の転記先）を使う。新しい値が空のときだけ既存行の値を引き継ぐ。AE はいまと同じ（新しい値が空なら既存行の値）。

読取確認値（23〜27・46 列）の引き継ぎは変えない。

### 3.3 確定で AC・AD を AE と一緒に書く（`settleWrittenTransactions`・`runWriteBlock`）

- `settleWrittenTransactions(entries)` の各 `entry` は `destinationSpreadsheetId`・`destinationSheetName` を持つ。**どちらかが空の `entry` が 1 つでもあれば、何も書かずに `TypeError` を投げる**（検査は書込の前に全件で行う）。
- 書く範囲は、いまの 31 列（AE）1 セルの代わりに **29〜31 列（AC・AD・AE）の 1 範囲**にする。1 取引あたりの範囲の数は変わらない（読取・書込の往復も変わらない）。
- `runWriteBlock`（70 9-7）は `toSettle` の各 `entry` に `destinationSpreadsheetId: customer.destinationSpreadsheetId`・`destinationSheetName: customer.destinationSheetName`（書いた転記先そのもの）を載せる。

### 3.4 行番号を書き直すほかの経路（`updateTransactionLocation`、`src/43_SheetWriter.gs`）

- 引数を `updateTransactionLocation(fullTxId, rowNumber, customer)` にする。`customer` が渡されたら、**AC・AD・AE の 3 列を** `customer.destinationSpreadsheetId`・`customer.destinationSheetName`・`rowNumber` で書く（AS 列＝最終更新日時もいまどおり書く）。
- `customer` を省いた呼出しは、いまどおり AE だけを書く。**これは本仕様より前に書かれたテストの準備のために残すだけである。`src/` の呼出しはすべて `customer` を渡すこと。**
- `src/` の呼出し 4 箇所すべてに、その行を書いた転記先の `customer` を渡す：
  - 43 `recordRecoveredLocation_`（回復 Step 3・4）と回復 Step 5：`options.customer`。
  - 52 `writeAdoptedTransaction_`：引数の `customer`。
  - 54 `restoreRow`：その関数が書いた `customer`。
- `recordRecoveredLocation_(tx, rowNumber, customer)` は、**行番号が同じで、かつ記録された転記先も `customer` と等しいときだけ**書かずに戻る。行番号が同じでも AC が空、または違う転記先なら書く（旧い行は回復の機会に埋まる）。

### 3.5 新しい取引を足すファイル単位の操作

52 `writeAdoptedTransaction_(customer, fileId, tx, leaseId, runId)` は `registerPrepared([tx], runId)` の前に、`tx` の写しへ `destinationSpreadsheetId`・`destinationSheetName` を `customer` から載せる（§3.1 と同じ規則。登録の時点で予定の転記先を持たせる）。どの `customer` を渡すかは §5.3 が決める。

## 4. 止める側：1 ファイルを 2 つの転記先へ割る取込を止める（`src/70_ImportFlow.gs`）

`runPreValidationBlock` で、`existingById`（8-10 の橋渡しが引いた既存行）を得た直後、要確認の組み立てと `registerPrepared` より前に、次を判定する：

- `elsewhere`：`existingById` の値のうち、生きている取引で、記録された転記先があり、それが今回の書込先（`input.customer` の `destinationSpreadsheetId`・`destinationSheetName`）と**等しくない**もの。
- `toWrite`：今回の解析結果の取引のうち、既存行が無いもの、または既存行の状態が `PREPARED`・`WRITING` のもの（＝この実行が転記先へ書く取引）。

**`elsewhere` と `toWrite` がどちらも 1 件以上なら、`IntegrityError('DESTINATION_MISMATCH', 詳細)` を投げて止める。**詳細には、ファイルID・記録された転記先の ID（重複なし）・今回の書込先の ID・`elsewhere` の件数を入れる（取引の値や店名は入れない）。このとき取引ログ・転記先・要確認のどれにも 1 セルも書かない。例外は 71 の `processDiscoveredFile_` がいまどおり `FAILED` へ落とし、`recordError` に `DESTINATION_MISMATCH` を残す。

- `elsewhere` があっても `toWrite` が 0 件なら止めない（書くものが無ければ割れない。全件確定済みのファイルを別のセッションで開き直しただけで失敗させてはならない）。
- 旧い行（AC が空）は `elsewhere` に数えない。所在が分からないものを食い違いとは言えない（§7 の埋め戻しで埋まれば効くようになる）。
- `src/06_ErrorCatalog.gs` の `ERROR_CATALOG` に `DESTINATION_MISMATCH` を 1 行足す：message「取引ログに記録された転記先と、これから書く転記先が食い違う（1 ファイルの取引を 2 つの転記先へ割る）」、retryable `false`、handler `'システム管理者'`、reviewType `null`、guidance「書かずに止める。取引ログ AC 列が指す転記先を書込先に指定して取り込み直す」。§5 の検算の失敗と転記先が一意に決まらない場合もこのコードを使う。

### 4.1 作り直す要確認の転記先（8-10 橋渡しと 8-11 の要確認）

`pendingReviews` の要確認のうち、**取引単位の種別**（`isTransactionScopedReviewType`）で、`fullTxId` の既存行が記録された転記先を持つものは、その要確認の物に `destinationSpreadsheetId`・`destinationSheetName` として**既存行の記録された転記先**を載せる。9-8 の `registerPendingReviews` は `Object.assign({既定値…}, entry)` なので、載せた値が顧客（今回の書込先）より勝つ。載せない要確認（新しい取引・旧い行の取引・ファイル単位の要確認）はいまどおり今回の書込先になる。

理由：§4 を通った実行で既存行が別の転記先に居るのは「書くものが無い再合流」だけであり、そこで作り直す要確認（K-W19）の M 列が今回の書込先を指すと、採用が無関係な行を上書きする（§1.2）。

## 5. 読む側

### 5.1 中断ファイルの後始末（`src/97_Ops.gs` `opsRecoverStuckFiles`・`stuckFileWriteCustomer_`）

`stuckFileWriteCustomer_(row, everyReview, fileTxs)` に第 3 引数（そのファイルの取引ログの行。`opsRecoverStuckFiles` が既に読んでいる全状態の取引を渡してよい）を足し、転記先の選び方を次の順にする：

1. `classifyRecordedDestinations_(fileTxs, customer)` が `'AMBIGUOUS'` → `{source: 'AMBIGUOUS', destinations: [記録された転記先の ID…]}`。
2. `'RECORDED'` または `'MIXED'` → 記録された転記先を候補にする。**そのファイルの要確認行のうち M 列が空でないものが 1 つでも候補と違えば** `{source: 'AMBIGUOUS', destinations: [候補の ID と、食い違う M 列の ID（重複なし）]}`。食い違いが無ければ `{customer: 候補を当てた customer, source: 'TX_LOG', destinations: [候補の ID]}`。
3. `'LEGACY'` または `'NONE'` → **いまの規則のまま**（要確認行の M 列 → `REVIEW_ROW`／M 列が無ければ `TEMPLATE`／要確認が無ければ `TEMPLATE_ASSUMED`／M 列が 2 通り以上なら `AMBIGUOUS`）。

選んだ後の検算（行を持つ取引が選んだ転記先の索引で同じ行に居るか。居なければ `DESTINATION_MISMATCH` で 1 行も書かない）は**変えない**。`'MIXED'` の旧い行はこの検算が確かめる。`AMBIGUOUS` のときの `outcome.error` の文言はいまのまま（`DESTINATION_AMBIGUOUS …`）でよいが、要確認行ではなく取引ログから分かった場合もあるので「転記先が一意に決まりません」の趣旨に改めてよい。

これで K-W10 の死角が閉じる：取込が 1 行も書く前に殺されても、取引ログの AC・AD に予定の転記先が残っているので、後始末はそこへ書く。

### 5.2 中断ファイルの報告（`opsInspectStuckFiles`・`opsExplainStuckFileTransactions`、読むだけ）

2 つとも、取引 1 件ごとに次の転記先を開いて「転記行に取引IDが入っているか」を見る：記録された転記先があればそれ、無ければ**ファイル単位の転記先**（`opsExplainStuckFileTransactions` のいまの規則＝要確認行の M 列、無ければ雛形）。開いたスプレッドシートは実行の中で使い回してよい。

- `opsInspectStuckFiles`：戻り値の各ファイルに `destinations`（実際に開いた転記先の ID の一覧、重複なし）を足す。いまの鍵（`fileName`・`fileId`・`state`・`transactions`・`byStatus`・`rowsCarryingTxId`・`rows`）は変えない。**これで K-W18（複製へ書いた取引を 0 件と報告する）が閉じる。**
- `opsExplainStuckFileTransactions`：ファイルに `destinationSource` を足す ── `classifyRecordedDestinations_` が `'RECORDED'`・`'MIXED'` なら `'TX_LOG'`（ファイルの `destinationSpreadsheetId` はその記録された転記先）、`'AMBIGUOUS'` なら `'AMBIGUOUS'`（ファイルの `destinationSpreadsheetId` は `''`、`destinations` に一覧）、それ以外はいまの規則（`'REVIEW_ROW'` か `'TEMPLATE'`）。**いまの鍵 `destinationFromReviewRow` は残し、`destinationSource === 'REVIEW_ROW'` のときだけ `true`**。`unfinished` の各取引に、その取引で開いた転記先の `destinationSpreadsheetId` を足す。

### 5.3 ファイル単位の操作（`src/52_FileResolution.gs`、`src/97_Ops.gs` `opsReprocessFile`）

**ファイル単位の転記先**を次で決める部品を用意する（名前は `resolveFileDestination_(customer, fileTxs)`、置き場所は 61 か 45）：

- `classifyRecordedDestinations_(fileTxs, customer)` が `'AMBIGUOUS'` → `IntegrityError('DESTINATION_MISMATCH', …)` を投げる（どれを選んでも他方の取引を取り違える）。
- `'RECORDED'`・`'MIXED'` → 記録された転記先を当てた `customer`。
- `'LEGACY'`・`'NONE'` → `customer`（雛形。いまの規則）。
- 戻り値は `{customer, kind, guessed}`。`guessed` は**所在を推測した取引**＝生きている旧い行のうち行を持つもの（`'MIXED'`・`'LEGACY'` のとき。`'RECORDED'`・`'NONE'` では空）。

**推測した取引の検算**の部品（名前は `assertGuessedRowsPresent_(index, guessed)`、置き場所は 45）：`guessed` の各取引について `getRowByTxId(index, fullTxId)` が `matchCount === 1` かつ `rowNumber === AE` でなければ、`IntegrityError('DESTINATION_MISMATCH', …)` を投げる（詳細には件数と最初の 5 件の取引IDだけ）。**`guessed` が空なら何も読まずに通す。**

各操作での使い方。**判定と検算は、取引の状態・転記先・要確認・ファイル状態のどれも変える前に行う**（止まったとき何も変わっていないこと）：

| 操作 | 転記先 | 検算 |
|---|---|---|
| 52 `CANCEL_FILE`（`cancelFileFromReview_`）と 97 `opsReprocessFile` | そのファイルの取引（全状態を読んで渡してよい。部品が生きている取引だけを見る）で `resolveFileDestination_` | 選んだ転記先で作った索引（`cancelTransactions` へ渡すのと同じもの）で `assertGuessedRowsPresent_`。`cancelTransactions` へは選んだ `customer` とその索引を渡す |
| 52 `APPLY_FILE_DIFF`・`ADOPT_AS_NEW_TRANSACTION` | そのファイルの取引で `resolveFileDestination_`。`ADOPT_AS_NEW_TRANSACTION` は `original.fileId` のファイル | `guessed` が空でなければ、選んだ転記先の索引（`buildIndex`）で `assertGuessedRowsPresent_`。`writeAdoptedTransaction_` へ選んだ `customer` を渡す（§3.5 で新しい取引の AC・AD になる） |
| 52 `UPDATE_PURPOSE`（`updatePurpose_`） | **書き換える取引 `tx` 自身の**記録された転記先（`customerForRecordedDestination_(getCustomerById(tx.customerId), tx)`）。要確認は別のファイル（重複ファイル）のものなので、ファイル単位の転記先を使ってはならない | **旧い行でも記録された行でも必ず**、書く前に、選んだ転記先の AE 行の取引ID列が `tx.fullTxId` であることを確かめる。違えば `DESTINATION_MISMATCH` で止め、何も書かない（`writeTransactionRows` は取引ID列も書くので、違う行へ書くと他の取引の行を乗っ取る）。読み方は実装者に任せる（1 行だけ読んでも、`buildIndex` でもよい） |

`CANCEL_FILE` の検算が旧い行だけを見て、記録された取引を見ないのは意図である：記録された取引が索引に見当たらないのは人が行を消した場合で、それはいまも取消しが素通りする（`cancelTransactions` は行が無ければ消さずに `CANCELED` にする）。推測した転記先が外れたのと区別できる。

### 5.4 整合性の要確認（`src/54_IntegrityResolution.gs`）

- `acceptManualChange`・`revertManualChange`・`restoreRow`：`var customer = options.customer || getCustomerById(tx.customerId)` を `options.customer || customerForRecordedDestination_(getCustomerById(tx.customerId), tx)` にする。`restoreRow` は §3.4 のとおり書いた転記先で `updateTransactionLocation` を呼ぶ。
- `resolveIntegrityReview` の `CONFIRM_INTEGRITY_RESOLVED` で自分で再検査するとき、索引を作る `customer` を、そのファイルの `COMMITTED` の取引で `resolveFileDestination_` した `customer` にする（`AMBIGUOUS` なら例外のまま止まる）。

## 6. 変えないこと

- **51（取引単位の要確認の確定）は変えない。**転記先はいまどおり要確認行の M・N 列から引く。§4 と §4.1 により、記録された取引では要確認の M 列と取引の AC は常に一致する。
- 71（`runImport`・`processDiscoveredFile_`・整合性チェック）は変えない。整合性チェックが雛形 1 枚しか見ない件（K-W9、§15-3）は本仕様の範囲外。
- 80・81（Web アプリ）は変えない。`FAILED` になったファイルは画面ではいまの「処理中のまま停止」の文言で出る。
- `WEBAPP_*` の定数、取込の往復予算（`phase6-round-trips` の `budget` の上限）。本仕様は取込の読取・書込の往復を増やさない（§3.3・§4 は既に読んだ値だけを使う）。
- 取引ログの列の数・並び、要確認シート、監査ログの形（§7 で足す 1 種類の行を除く）。
- `src/33`・`34`・`24`・`19`・`80`・`81`。
- **`src/97_Ops.gs` には文字列の中に生の NUL バイトが 2 つある。**消したり別の文字に置き換えたりしないこと（編集前後で数が同じであること）。

## 7. 旧い行の埋め戻し（`src/97_Ops.gs` に `opsBackfillTransactionDestinations(apply)` を足す）

本番の取引ログの AC・AD はすべて空である。§5 の読む側は旧い行にいまの規則を当てるので壊れはしないが、Web アプリで複製へ書いた旧い取引は、埋めるまで K-W14・K-W18 が直らない。**推測では埋めない。転記先の実物で、その行に取引IDが入っていることを確かめたものだけを埋める。**

**既定は見るだけ**：`apply` が**厳密に `true`** のときだけ書く（`undefined`・`false`・`'true'` などでは 1 セルも書かない）。

### 7.1 対象

取引ログの**有効な**行のうち、AC が空で、行を持ち（AE が 1 以上の整数）、状態が `PREPARED`・`WRITING`・`COMMITTED`・`REVIEW_REQUIRED` のもの。顧客ごとに扱う。

### 7.2 候補の転記先（顧客ごと）

次を重複なしで集める。各候補はスプレッドシートID とシート名の組である。

1. 雛形：`customer.destinationSpreadsheetId`・`customer.destinationSheetName`。
2. 雛形と同じフォルダの Web アプリの複製：雛形の親フォルダが**ちょうど 1 つ**のとき、そのフォルダ直下のスプレッドシートで、名前が `customerName + '_'` で始まり残りが `^\d{8}-\d{4}$` に一致するもの（`webAppValidateDestination_` の名前の規則と同じ）。シート名は `customer.destinationSheetName`。親が 1 つでなければこの手順を飛ばし、報告に `folderScan: 'SKIPPED'` と書く。
3. その顧客の要確認行（全状態）の M 列が空でない値：シート名は N 列、空なら `customer.destinationSheetName`。

シートが無い・開けない候補は使わず、報告に数える（`unreadableCandidates`）。

### 7.3 判定

候補ごとに `buildIndex`（その候補を当てた `customer`）で索引を 1 回作り、対象の取引ごとに、`getRowByTxId(index, fullTxId)` が `matchCount === 1` かつ `rowNumber === AE` になる候補を数える：

- ちょうど 1 つ → **埋める**（`resolved`）。埋める値はその候補のスプレッドシートID とシート名。
- 0 で、どれかの候補にその取引IDが別の行で見つかる → `moved`（埋めない）。
- 0 で、どこにも無い → `notFound`（埋めない）。
- 2 つ以上 → `ambiguous`（埋めない）。

### 7.4 書く（`apply === true` のときだけ）

1. **書く直前に、スクリプトロックの中で**、埋める行を取引ログから読み直し、取引ID・有効・AC が空・AE が最初に読んだ値と同じであることを確かめる。1 行でも違えば、**1 セルも書かずに例外で止める**（`opsDedupeDictionaryRows` の書く直前の読み直しと同じ考え方）。
2. 埋める行の AC・AD（29・30 列）と AS（45 列＝最終更新日時）だけを書く。ほかの列は 1 つも変えない。往復は行数に比例させない（Sheets API の `batchUpdate` にまとめる）。
3. 埋めた行がある顧客ごとに監査を 1 件：`{type: 'SETTING', targetType: 'TRANSACTION', customerId, targetId: 埋めた取引IDの最初の 20 件をカンマで結んだもの, before: {AC: '', rows: 件数}, after: {AC: {転記先ID: 件数, …}}, reason: 'BACKFILL_TX_DESTINATION'}`。

もう一度呼べば、埋めた行は対象から外れる（冪等）。

### 7.5 戻り値（`Logger.log(JSON.stringify(...))` にも出す）

`{apply, customers: [{customerId, folderScan, candidates, unreadableCandidates, targets, resolved, byDestination: {転記先ID: 件数}, moved, notFound, ambiguous, samples: [{fullTxId, destinationRow, verdict}]（resolved 以外を最大 20 件）}], totals: {targets, resolved, moved, notFound, ambiguous}}`。取引の店名・金額は出さない。

## 8. テスト（`test/phase8-webapp.test.js` に足す。名前は `txdest N: …`）

既存のテストは、**下の 8.1 に書いた 6 本（4 本の準備・`webapp 08` の期待・`phase0` のエラーコード一覧）を除いて** 1 文字も変えない。既存の補助（`seedPartnerViaWeb`・`webImport`・`webResolve`・`decision`・`forceFileState`・`clearDestinationRow`・`blankReviewRows`・`setReviewDestination`・`txIdRowsIn`・`fileStateOf`・`transactionFor`・`openReviewsFor`・`withMocks` など）は使ってよいが、書き換えない（要るなら新しい補助を足す）。ファイル単位の要確認（`FILE_CHANGED`・`DUPLICATE`）や整合性の要確認の材料作りに `test/phase4-*.test.js` の補助と同じものが要るなら、`phase8-webapp.test.js` に新しい補助として書いてよい。`test/gas-stubs.js`・`test/gas-harness.js` は、足りない API（例：フォルダ直下のファイルの MIME 型）を**足すだけ**なら変えてよい（既存の振る舞いを変えない。足したものは報告する）。

### 8.1 既存の 4 本は「旧い行」の固定として残す

`webapp 45f`・`45h`・`45i`・`45j` は、本仕様の後は取引ログに転記先が載るので、そのままでは前提が変わる（45h の `destinationSource` は `'TX_LOG'` になり、45i・45j は止まらずに複製へ回復する）。**この 4 本は「本仕様より前の行（AC・AD が空）」での振る舞いを固定するテストとして残す。**各テストの準備で、`seedPartnerViaWeb` の直後に**そのファイルの取引の AC・AD（29・30 列）を空にする 1 手順**を足す（補助を 1 つ足して呼ぶ形でよい）。**期待（assert）は 1 つも変えない。**本番の既存行はすべてこの形なので、旧い行の振る舞いが変わらないことはそれ自体が要件である。

**`webapp 08` だけは期待を改める（1.1）。**このテストは第1段（`spec_webapp.md` §12.3 ケース 8）が「取引ログ AC・AD は常に空」という当時の事実を固定したもので、本仕様が意図してそれを覆す。最後の 2 つの `assert.equal(tx.destinationSpreadsheetId, '')`・`assert.equal(tx.destinationSheetName, '')` を、それぞれ `seeded.destinationSpreadsheetId`（要確認と同じ複製）・`'入力用シート'` を期待する形に改める。テスト名の `while transaction AC and AD stay blank` は `and transaction AC and AD record the same clone` に改めてよい。**それ以外の行（要確認の M・N 列の assert を含む）は変えない。**

**`test/phase0.test.js` の `ERROR_CATALOG contains all 51 design codes with the required shape` は、エラーコードの一覧を足す（1.2）。**配列 `errorCodes` に `'DESTINATION_MISMATCH'` を 1 つ足し、`assert.equal(errorCodes.length, 51)` を `52` に、テスト名の `51` を `52` に改める。形の検査（`message`・`retryable`・`handler`・`reviewType`・`guidance`）とほかの行は変えない。このテストは設計文書のエラー表とカタログの一致を見張るもので、コードを足すたびに一覧も足すのが正しい。

### 8.2 足すテスト

- **txdest 1**（書く側）：Web アプリの取込で書いた取引は、AC＝そのセッションの複製、AD＝転記先シート名、AE＝行番号を持つ。定期取込の経路（`runImport({})`、書込先＝雛形）で書いた取引は AC＝雛形。要確認になった取引（`REVIEW_REQUIRED`）も AC・AD を持つ。
- **txdest 2**（登録の時点で書く）：Web アプリの取込で、行の予約（`reserveDestinationRows`）を例外にして止めた（`withMocks`）とき、取引は `PREPARED`・AE 空のまま、**AC・AD は複製を持つ**。
- **txdest 3**（K-W10 の死角が閉じる）：txdest 2 の形（要確認 0 件・転記行 0 件）のファイルを `WRITING` にして `opsRecoverStuckFiles` → `destinationSource: 'TX_LOG'`、エラーなし、**複製へ**書いて発見へ戻す。雛形には 1 行も書かない。回復した取引の AC・AD・AE が複製と書いた行を指す。
- **txdest 4**（確定で AC・AD を書く）：AC・AD が空の `PREPARED` の行を取引ログに置き（`registerPrepared` に転記先を持たない取引を渡す）、`runWriteBlock`（または `processFile`）で書く → 確定後の AC・AD が書いた `customer` の転記先。あわせて、`settleWrittenTransactions` に転記先を持たない `entry` を混ぜると `TypeError` で、取引ログが 1 セルも変わらない。
- **txdest 5**（回復が旧い行を埋める）：AC 空・AE あり・状態 `WRITING` の行で、転記先の同じ行に予定値どおり入っている取引を `recoverPartialFailure(…, {customer})` にかける（Step 3、行番号は同じ）→ AC・AD が `customer` の転記先になる。Step 4（同じ行を書き直す）と Step 5（新しい行を取る）でも AC・AD・AE が揃う。
- **txdest 6**（再合流で行を持つ取引の転記先を保つ）：Web アプリで複製 B へ取り込み、B に行を持つ取引の要確認を消して（K-W19 の形）発見へ戻し、**新しいセッション（複製 C）**で取り込み直す → 止まらない（書くものが無い）。取引の AC は B のまま・AE も同じ、作り直された要確認の M 列は **B**。C には 1 行も書かない。
- **txdest 7**（割る取込を止める）：txdest 6 と同じだが、1 件の取引を「B に行を持たない `PREPARED`」にしてから（取引ログの状態を `PREPARED`・AE を空にし、B の該当行の取引ID を消す）C へ取り込み直す → ファイルは `FAILED`、取込結果のそのファイルの `errorCode` が `DESTINATION_MISMATCH`。**B・C・雛形のどれにも 1 行も書かず、取引ログは 1 セルも変わらず（登録もしない）、要確認も増えない。**同じことを B を指定して取り込み直す（`destinationSpreadsheetId: B`）と、止まらずに B へ書く。
- **txdest 8**（旧い行では止めない）：txdest 7 と同じ形だが、ファイルの取引の AC・AD をすべて空にしてから C へ取り込み直す → 止まらない（いまの振る舞い。旧い行は所在が分からないので食い違いと言えない）。
- **txdest 9**（後始末が取引ログと要確認の食い違いを拒む）：Web アプリで取り込んだファイル（AC＝複製）の要確認行の M 列を雛形に書き換え、回復に書くものを与えて（`clearDestinationRow`）`WRITING` にする → `opsRecoverStuckFiles` は `destinationSource: 'AMBIGUOUS'`、何も書かず、状態も動かさない。
- **txdest 10**（記録が 2 通りなら拒む）：同じファイルの取引の AC を 2 つの別の転記先にして回復にかける → `AMBIGUOUS`、何も書かない。`resolveFileDestination_` は同じ材料で `DESTINATION_MISMATCH` を投げる。
- **txdest 11**（K-W18）：Web アプリで取り込んだファイルを `WRITING` にして `opsInspectStuckFiles` → `rowsCarryingTxId` が複製に行を持つ取引の数と等しく（0 ではない）、`destinations` が複製だけを含む。`opsExplainStuckFileTransactions` は `destinationSource: 'TX_LOG'`・`destinationFromReviewRow: false`、各取引の `destinationSpreadsheetId` が複製。
- **txdest 12**（`CANCEL_FILE`・K-W14）：Web アプリで複製へ取り込んだファイルにファイル単位の要確認（`FILE_CHANGED` など `CANCEL_FILE` を出す種別）を立て、`resolveFileReview(…, 'CANCEL_FILE', …)` → **複製の転記行が空になり**（取引ID・B・F・I・K・M）、雛形は 1 セルも変わらず、取引は `CANCELED`。
- **txdest 13**（旧い行の検算）：txdest 12 と同じだが、取引の AC・AD を空にしておく → `DESTINATION_MISMATCH` で止まり、**取引の状態・複製・雛形・要確認の状態・ファイル状態のどれも変わらない**。`opsReprocessFile` も同じ材料で同じく止まる。
- **txdest 14**（`opsReprocessFile`）：Web アプリで複製へ取り込んだファイルを `opsReprocessFile` → 複製の行が空になり、雛形は変わらない。
- **txdest 15**（`APPLY_FILE_DIFF`・`ADOPT_AS_NEW_TRANSACTION`）：Web アプリで複製へ取り込んだファイルに対して、それぞれ新しい取引を足す → 足した取引の行は**複製**に書かれ（雛形には書かない）、足した取引の AC・AD・AE が複製と書いた行を指す。
- **txdest 16**（`UPDATE_PURPOSE`）：複製に行を持つ取引の用途を `UPDATE_PURPOSE` で書き換える → 複製のその行の I 列が変わり、雛形は変わらない。別の材料で、取引の AE 行の取引ID列が別の取引ID（または空）になっていると `DESTINATION_MISMATCH` で止まり、どのシートも 1 セルも変わらない。
- **txdest 17**（K-W13）：複製に行を持つ `COMMITTED` の取引で、複製の行を手で書き換えてから `revertManualChange(fullTxId, actor, {})`（`options.customer` なし）→ **複製の行が**予定値へ戻り、雛形は変わらない。
- **txdest 18**（埋め戻し・見るだけ）：本仕様より前の形（AC・AD 空）の取引を、雛形に 1 件・複製 2 枚に数件ずつ置き、名前の規則に合わないスプレッドシート（同じフォルダ、同じ取引IDを同じ行に持つ）も置く。さらに `moved`（取引IDが別の行にある）・`notFound`・`ambiguous`（同じ取引IDが 2 つの候補の同じ行にある）の取引を 1 件ずつ作る。`opsBackfillTransactionDestinations()`（引数なし）と `(false)` は §7.5 の数を正しく報告し、**取引ログも監査ログも 1 セルも変えない**。名前の規則に合わないスプレッドシートだけに居る取引は `notFound`。
- **txdest 19**（埋め戻し・書く）：txdest 18 の世界で `opsBackfillTransactionDestinations(true)` → `resolved` の行だけ AC・AD が正しい転記先になり、AS が変わり、**ほかの列（A〜AB・AE〜AR・AT・AU）は 1 つも変わらない**。`moved`・`notFound`・`ambiguous` の行は AC が空のまま。監査は顧客ごとに 1 件（`reason: 'BACKFILL_TX_DESTINATION'`）。もう一度 `true` で呼ぶと `resolved: 0` で何も書かない。
- **txdest 20**（埋め戻しの読み直し）：最初の読取の後・書く前に、埋める行の 1 つの AC を別の値に書き換える（`gas.evaluate` などで仕掛けを差し込む）→ 1 セルも書かずに例外で止まる。
- **txdest 21**（再合流で行を持たない旧い行に予定の転記先を書く）：取引ログに AC・AD・AE が空の `PREPARED` の行（旧い行）を置いたファイルを、Web アプリで取り込み直し、行の予約を例外にして止める（txdest 2 と同じ仕掛け）→ その行の AC・AD が今回の複製になっている（止まる前の登録の時点で書かれている）。

## 9. 変異（自分で入れて、赤になることを確かめる）

入れて、`node test/run-tests.js` を回し、赤になるテストを記録して、戻す。

| # | 変異 | 赤になるはず |
|---|---|---|
| M1 | 8-12 で予定の転記先を載せない | txdest 1・2・3 |
| M2 | 確定（`settleWrittenTransactions`）が AE だけを書く | txdest 4 |
| M3 | 再合流で行を持つ既存行の AC・AD を今回の書込先で上書きする | txdest 6 |
| M4 | 再合流で行を持たない既存行の AC・AD を既存行から引き継ぐ（新しい値を使わない） | txdest 21 |
| M5 | §4 の判定を外す | txdest 7 |
| M6 | §4 で `toWrite` を見ない（書くものが無くても止める） | txdest 6 |
| M7 | §4 で旧い行も `elsewhere` に数える | txdest 8 |
| M8 | §4.1 で作り直す要確認に既存行の転記先を載せない | txdest 6 |
| M9 | `updateTransactionLocation` が `customer` を無視して AE だけを書く | txdest 3・5・15 |
| M10 | `recordRecoveredLocation_` が行番号だけで「同じ」と判断する | txdest 5（Step 3） |
| M11 | `stuckFileWriteCustomer_` が取引ログを見ない | txdest 3 |
| M12 | `stuckFileWriteCustomer_` が要確認行との食い違いを見ない | txdest 9 |
| M13 | 記録が 2 通りでも最初のものを選ぶ | txdest 10 |
| M14 | `opsInspectStuckFiles` が雛形を開く | txdest 11 |
| M15 | `CANCEL_FILE` が雛形で索引を作る | txdest 12 |
| M16 | `assertGuessedRowsPresent_` を呼ばない | txdest 13 |
| M17 | `APPLY_FILE_DIFF`／`ADOPT_AS_NEW_TRANSACTION` が雛形へ書く | txdest 15 |
| M18 | `UPDATE_PURPOSE` の取引ID の確かめを省く | txdest 16 |
| M19 | `opsReprocessFile` が雛形で取り消す | txdest 14 |
| M20 | 54 の既定の `customer` を雛形に戻す | txdest 17 |
| M21 | 埋め戻しが `apply` 未指定でも書く | txdest 18 |
| M22 | 埋め戻しの候補に名前の規則を当てない | txdest 18・19 |
| M23 | 埋め戻しの書く直前の読み直しを省く | txdest 20 |
| M24 | 埋め戻しが `ambiguous` の行も最初の候補で埋める | txdest 19 |
| M25 | 45h の旧い行で、回復が取引ログの空の AC を「雛形」と読む（`LEGACY` を `RECORDED` 扱い） | webapp 45h（8.1 の準備を足した後） |

## 10. 受入（本番。実装・監査・push の後、Claude がユーザーの許可を得て行う）

1. push の前後で `clasp pull` の比較（いつもの手順）。push 後にユーザーが F5。
2. `opsBackfillTransactionDestinations()`（見るだけ）を clasp で実行し、`targets`・`resolved`（転記先ごと）・`moved`・`notFound`・`ambiguous` をユーザーに見せる。`notFound`・`moved`・`ambiguous` があれば、埋める前に中身を調べて報告する。
3. ユーザーの許可を得てから `opsBackfillTransactionDestinations(true)`。もう一度見るだけで `resolved: 0` を確かめる。
4. 次に Web アプリで取り込んだファイルの取引の AC・AD が、そのセッションの複製を指すことを確かめる（取引ログを読む）。
5. 中断ファイルが出たら `opsInspectStuckFiles` の `rowsCarryingTxId` が複製の行を数えることを確かめる（出なければ見送り）。

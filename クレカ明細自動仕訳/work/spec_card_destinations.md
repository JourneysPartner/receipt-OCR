# カードフォルダを選ぶだけで、そのカードの転記シートの Excel を取れるようにする 仕様書

版：1.2（2026-10-27。1.0 は §3.1 の読取と dl 6 で認可の読取（`batchGet` 1 回）とマスターを開く `openById` を数え落としていた ── Codex の指摘で 1.1 で直した。1.2 は、§4.1 の「ファイル一覧を読んだら転記シートの一覧も読む」で呼出しの並びが 1 件増え、並びを完全一致で見る既存の 4 本とぶつかるのを足した ── これも Codex の指摘。§6 の冒頭）
対象：`src/80_WebApp.gs`（新しい公開関数 1 つ）・`src/81_WebAppUi.html`。
発端：2026-10-27、利用者「最後にエクセルをダウンロードするにはどうすればいいの？」→ 説明のうえ「画面でカードを選ぶだけで、そのカードの分の Excel をいつでもダウンロードできるようにして欲しい」。

## 1. 背景

- ［最終確認を表示］［Excel ダウンロード］は、その画面で［記帳を実行］した回の転記シート（`state.lastCompletedDestinationSpreadsheetId`）にだけ効く。F5・別のフォルダや顧客を選ぶと忘れて灰色に戻る（`invalidateOperations`・`chooseFolder`）。全部【済】になった後で Excel だけ欲しいときは、画面からは取れない。
- 転記シートは［記帳を実行］のたびに雛形と同じ Drive フォルダへ `<顧客名>_yyyyMMdd-HHmm` の名前で 1 枚作られる（`webAppCloneDestination_`）。名前にカードは入らない。何も書かなかった押下の空のシートも残る。
- どの取引がどのシートに居るかは、取引ログ AC・AD 列（転記先のスプレッドシート ID・シート名）に記録されている（§15-4）。取引ログの E 列はファイル ID で、ファイルはカードフォルダの中にある。**だから「このカードフォルダのファイルの取引が書かれたシート」は、取引ログから引ける。**

## 2. 決めたこと

1. **カードフォルダを開いたら、ファイル一覧の下に「このカードの転記シート」の一覧を出す。**自動で読む（ボタンを押させない）。
2. **一覧は取引ログから作る。**このフォルダのファイルの、生きている取引（`active` で `COMMITTED`・`REVIEW_REQUIRED`・`PREPARED`・`WRITING`）を、記録された転記先（AC 列）ごとにまとめる。取引の 1 件も無い空のシートは出ない。
3. **出すのは Web アプリが作った転記シートだけ。**雛形そのもの（Web アプリ以前の取込が書いた）と、AC が空の旧い行は出さない（件数だけ返す）。雛形は［最終確認］が受け付けない（`webAppValidateDestination_` が雛形を拒む）ので、出しても押せない。
4. **選ぶと、今の流れにそのまま乗る。**行の［最終確認と Excel］を押すと、そのシートを「この画面の転記シート」にして（`state.lastCompletedDestinationSpreadsheetId`・`state.sessionFileIds`）、すぐ最終確認を開く。開いた後は今の［Excel ダウンロード］が押せる。**最終確認を見るまでダウンロードさせない今の決まりは変えない**（以前の利用者のご要望）。
5. **一覧を作るとき、シートは開かない。**Drive で名前と置き場所だけ確かめる（`SpreadsheetApp.openById` は 1 回約 3 秒なので、一覧では使わない）。きちんとした確かめは最終確認（`webAppValidateDestination_`）が今どおり行う。
6. 1 枚のシートに別のカードの取引が混ざっていても（普通は無い：記帳はカードフォルダごと）、件数はこのカードの分だけ数え、Excel はシートの全部になる。

## 3. サーバー（`80_WebApp.gs`）

### 3.1 `webAppListDestinations(customerId, folderId)`（新規・公開関数）

`webAppListFolder` の後に置く。`webAppInvoke_` で包む。

1. 認可：`webAppAuthorizeCustomer_(customerId, 'WEBAPP:一覧')`（一覧と同じ役割）。`customer` は選んだ顧客。
2. フォルダ：`webAppDirectChildFolder_(customer, folderId)`。その `getFiles()` の ID を集める（文字列）。1 つも無ければ、Sheets を読まずに `{destinations: [], legacyTransactionCount: 0, unavailableCount: 0}` を返す。
3. 取引：`findRowsByColumnValues_(transactionLogSheet_(), 5, fileIds, TRANSACTION_LOG_WIDTH_)` を 1 回。行は `txLogFromRecord_` で写し、`active === true` で状態が上の 4 つのものだけ数える。写せない行は数えない。
4. 転記先ごとにまとめる（`recordedDestinationOf_(tx, customer)`）：
   - 記録が無い（AC 空）か、記録が雛形（`customer.destinationSpreadsheetId`）なら `legacyTransactionCount` に数える。
   - それ以外は転記先 ID ごとに `transactionCount`（件数）・`reviewCount`（`REVIEW_REQUIRED` の件数）・`fileIds`（そのシートに取引があるこのフォルダのファイル、重なりなし）を数える。
5. 転記先ごとの確かめ（Drive だけ）：雛形の親フォルダを 1 回引き（`DriveApp.getFileById(customer.destinationSpreadsheetId).getParents()`。ちょうど 1 つでなければ、全部を確かめられないものとして扱う）、転記先ごとに `DriveApp.getFileById(id)` の名前が `customer.customerName + '_' + yyyyMMdd-HHmm` の形で、親が雛形の親とちょうど同じ 1 つであること（`webAppValidateDestination_` と同じ規則のうち、名前と置き場所だけ）。合わない・例外なら一覧に出さず `unavailableCount` に数える。
6. 返す：`{destinations: [...], legacyTransactionCount, unavailableCount}`。`destinations` の各要素は `{destinationSpreadsheetId, name, createdLabel, transactionCount, reviewCount, fileIds}`。`createdLabel` は名前の `yyyyMMdd-HHmm` から `yyyy/MM/dd HH:mm`。並びは名前の日時の**新しい順**（同じなら ID の順）。

読取：Sheets の `batchGet` は、認可（`webAppAuthorizeCustomer_`、既存の 1 回）に加えて、ファイルがあれば `findRowsByColumnValues_` の 2 回（ファイルが無ければ 0）。公開関数全体ではファイルあり 3 回・ファイル無し 1 回（1.1。Codex の実測）。マスターを開く `SpreadsheetApp.openById`（認可などの既存の処理）は数えない ── **開かないのは転記シート（雛形と複製）だけ。**

## 4. 画面（`81_WebAppUi.html`）

### 4.1 呼出しと状態

- `gasCall` に `webAppListDestinations`（引数 2 つ）の枝。
- 状態 `state.destinations`（配列か `null`）・`state.loadingDestinations`・`state.destinationRequest`（古い返事を捨てる番号）・`state.destinationsError`・`state.legacyTransactionCount`・`state.unavailableDestinationCount`。
- 読む時：`loadFiles` が成功した後（同じ顧客・同じフォルダ・同じ `viewGeneration` のときだけ）に `loadDestinations(customerId, folderId, generation)` を呼ぶ。取込が終わった後（一覧を読み直す所）も同じく読み直す。フォルダ・顧客を変えたら `state.destinations = null` にして描き直す。返事が今の顧客・フォルダ・世代と合わなければ捨てる。

### 4.2 描き方（`renderDestinations`）

ファイル一覧（`file-list`）のすぐ下に、見出し「このカードの転記シート（Excel）」の欄を足す（HTML に要素を 1 つ足し、`el` に入れる）。フォルダを選んでいなければ欄ごと隠す。

- 読込中：「読み込み中…」。失敗：「転記シートを読み込めませんでした」。0 件：「このカードの取引が書かれた転記シートはまだありません。」
- 表：列は「記帳した日時」（`createdLabel`）・「件数」（`transactionCount` 件、`reviewCount > 0` なら「（うち要確認 n 件）」を続ける）・「操作」。シートの名前は `title` に入れる（`textContent` ではない所は `title` だけ）。
- 操作の列：ボタン［最終確認と Excel］（`type='button'`・`className='button'`・`disabled = isMutationBusy() || state.finalLoading`）。今「この画面の転記シート」になっている行（`destinationSpreadsheetId === state.lastCompletedDestinationSpreadsheetId`）は、ボタンの代わりに「選択中」と出す。
- 表の下の注記（あれば）：`legacyTransactionCount > 0` なら「この画面より前の取込の取引 n 件は、雛形のシートにあります（ここには出ません）。」、`unavailableCount > 0` なら「確かめられなかった転記シートが n 枚あります。」
- 文字はすべて `textContent`。

### 4.3 押したとき（`chooseDestination(destination)`）

1. `isMutationBusy()` か `state.finalLoading` なら何もしない。
2. `state.lastCompletedDestinationSpreadsheetId = destination.destinationSpreadsheetId`、`state.sessionFileIds = destination.fileIds.slice()`、`forgetFinalReview()`、`el['excel-status'].textContent = ''`。`state.activeImportDestinationSpreadsheetId` は触らない（次の［記帳を実行］は今どおり新しいシートを作る）。
3. `renderDestinations()`・`updateActionButtons()`・`setStep()`。
4. `await loadFinalReview()`（今の最終確認をそのまま開く）。

確認のダイアログは出さない（何も書かない操作なので）。

### 4.4 今の流れとの関係

- ［記帳を実行］の始めに今は `lastCompletedDestinationSpreadsheetId` を空にする ── そのまま。取込が終われば、その回のシートが「選択中」になる（一覧を読み直すので行が増え、選択中の印が付く）。
- 要確認を確定したら最終確認が古くなる（`markFinalReviewStale`）── そのまま。

## 5. 変えないこと

- 最終確認（`webAppFinalReview`・`webAppValidateDestination_`）と Excel のダウンロード（`downloadExcel`）、最終確認を見るまでダウンロードさせない決まり。
- 取込・確定・ファイル一覧・要確認の表。
- 転記シートの作り方と名前。

## 6. テスト（`dl N: …`。サーバーは `test/phase8-webapp.test.js` の最後、画面は `test/phase9-format-registration.test.js` の world）

**既存の期待を変えてよいのは 4 本だけ（1.2）：**`sf 16`・`sf 17`（K-W12 の戻すボタン）と `rc 10`・`rc 11`（K-W23 の要修正を戻すボタン）は、押した後の呼出しの並び（`gasCall` の記録）を完全一致で見ている。§4.1 で、ファイル一覧（`webAppListFolder`）を読み直した後に転記シートの一覧（`webAppListDestinations`）も 1 回読むので、並びが 1 件増える。**この 4 本の期待する並びに、`webAppListFolder` の直後の `webAppListDestinations` を 1 件ずつ足すことだけを認める**（引数は `[顧客ID, フォルダID]`）。テストの目的（お知らせの後に一覧を 1 回だけ読み直す・忙しさが外れる）は変えない ── 足した後も「`webAppListFolder` は 1 回」「`webAppListDestinations` は 1 回」を確かめる形のままにする。転記シートの一覧を読み直すのは、要確認を確定すると「うち要確認 n 件」が変わるためで、ファイル一覧と同じ時に読むのが正しい。ほかの既存の期待は 1 つも変えない。

1. **dl 1（2 回の記帳）**：同じカードフォルダで 2 回［記帳を実行］（別々の複製）→ 2 枚が新しい順、件数・要確認の件数・`fileIds` が正しい、`createdLabel` の形。
2. **dl 2（別のカード）**：別のカードフォルダの取引のシートは出ない。
3. **dl 3（雛形と旧い行）**：AC が空の取引・雛形に記録された取引は出ず、`legacyTransactionCount` に数える。
4. **dl 4（確かめられないシート）**：名前が規則に合わない・置き場所が違う・Drive で例外 → 出ず、`unavailableCount` に数える。ほかのシートは出る。
5. **dl 5（取引の状態）**：取り消した取引（`CANCELED`）・無効な行だけのシートは出ない。
6. **dl 6（読取）**：公開関数全体の Sheets の `batchGet` を測り、**測った値そのもの**を上限にする（1.1：ファイルあり 3 回・ファイル無し 1 回。認可の 1 回を含む）。**転記シート（雛形と、一覧に出る複製）の ID で `SpreadsheetApp.openById` を呼ばない**（その ID で呼んだら赤になるように包んで確かめる。マスターを開くのは既存の処理なので数えない）。
7. **dl 7（場所と認可）**：顧客の直下でないフォルダ・認可の無い顧客 → 投げる。
8. **dl 8（画面の一覧）**：フォルダを開くと一覧が出る（読込中 → 表）、0 件・失敗の文、要確認の件数、注記 2 つ、選択中の行はボタンの代わりに「選択中」、忙しいときはボタンが押せない。フォルダを変えると一覧が消えて読み直す。古い返事は捨てる。
9. **dl 9（押す）**：［最終確認と Excel］→ `webAppFinalReview` を `[顧客ID, その ID, その fileIds]` で 1 回呼ぶ、最終確認が出た後に［Excel ダウンロード］が押せる、押すとその ID の書き出しを開く。
10. **dl 10（取込の後）**：［記帳を実行］が終わると一覧を読み直し、その回のシートが選択中。
11. **dl 11（安全な描き方）**：`renderDestinations` が `textContent`（とシート名の `title`）だけを使う。

## 7. 変異（R1〜R12）── それぞれ赤になるテストを記録する

- R1：フォルダで絞らない（顧客の全取引から作る）
- R2：雛形も一覧に出す
- R3：`active` を見ない
- R4：取り消した取引も数える
- R5：名前の確かめを外す
- R6：置き場所の確かめを外す
- R7：Drive の例外で一覧ごと失敗する
- R8：古い順に並べる
- R9：押しても `sessionFileIds` を入れない
- R10：押した後に最終確認を開かない（または最終確認の前に Excel が押せる）
- R11：フォルダを変えても前の一覧が残る
- R12：取込の後に一覧を読み直さない

## 7.1 実装と監査の記録（2026-10-27）

- Codex 1 回目（`tools/codex-logs/*-20261027-170620-*`、gpt-6.1-sol・xhigh）：実装して dl 13/14 本、dl 6 の読取（認可の 1 回・マスターの `openById`）で停止 → 1.1。2 回目（`*-172902-*`）：開始時の全テストで既存の `sf 16`・`sf 17`・`rc 10`・`rc 11`（呼出しの並びの完全一致）が赤と分かり、何も変えずに停止 → 1.2。3 回目（`*-173456-*`）：1702/1702、R1〜R12 はすべて赤。読取は公開関数全体でファイルあり 3・無し 1、転記シートの ID での `openById` 0。欄はファイル一覧の直後・取込の進捗の前、CSS は既存のクラス（`.muted` など）、シート名の `title` は日時のセル。
- 監査：src の差分は 80（新しい公開関数 1 つだけ）と 81、LF のまま。既存のテストで変わったのは、phase9 の world の 2 行（呼べる関数の一覧・画面の関数の取り出し）と上の 4 本の並びだけ。`???` 0。
- 私の変異 Z1〜Z8 のうち Z5（取込中・最終確認の読込中でも選ぶ処理が状態を変える）がすり抜け → `dl 12` を私が足して赤。Z8（ファイルが無いときの早い戻りを外す）は、`findRowsByColumnValues_` が空の一覧で何も読まずに戻るので同じ振る舞い。最終 1703/1703。
- 残したこと（直さない）：Drive のごみ箱に入れたシートも一覧に出る（`isTrashed` を見ていない。今の最終確認の確かめ `webAppValidateDestination_` も見ていない）。

## 8. 受入（実機）

push 後、Web アプリを開き直して（F5）テスト顧客 → 取込済みのカード（例：Amazonカード）を開く → ファイル一覧の下に転記シートが日時の新しい順に出る → ［最終確認と Excel］→ 最終確認が出る → ［Excel ダウンロード］で xlsx が取れる。

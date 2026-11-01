# 顧客名を Drive の顧客フォルダ名に合わせる運用関数 仕様書

版：1.1（2026-10-31。監査の直し 2 つを反映）
対象：`src/97_Ops.gs`（新しい運用関数 1 つと、その部品）。
発端：2026-10-31、利用者の依頼「本番では、画面の顧客名（顧客マスター B 列）に本当の顧客名、具体的には該当の顧客フォルダ名を出したい」。

## 1. 背景

- 画面の顧客名は顧客マスター B 列の値（`customerFromRow_`）で、今は手で入れる。
- 本番の Drive は「共通フォルダ → 個人 または 法人 → 顧客名フォルダ → 当年度 → 経費 → クレカ明細 → 各カード → CSV」がほとんどだが、**顧客名フォルダより下の構成は変わるかもしれない**（利用者、2026-10-31）。
- 顧客マスター D 列（`sourceFolderId`）は画面の仕様上クレカ明細フォルダを指す（直下をカードフォルダとして並べる。`webAppListFolder`）。
- **B 列は表示だけの値ではない。**転記シートの名前は `<B列>_yyyyMMdd-HHmm` で作られ（`webAppCloneDestination_`）、一覧（`webAppListDestinations`）と書き足し（`webAppValidateDestination_`）はこの名前が今の B 列と合うかを確かめる。転記シートができた後に B 列を変えると、そのシートは一覧に出なくなり、書き足しも拒まれる。

## 2. 決めたこと

1. **顧客フォルダの見つけ方：**D 列のフォルダから親を 1 段ずつたどり、スクリプトプロパティ `CUSTOMER_ROOT_FOLDER_ID`（共通フォルダ）に着いたら止める。**共通フォルダの 2 段下（共通 → 個人/法人 → 顧客名）が顧客フォルダ。**D 列から顧客フォルダまでの段数は決め打ちしない（下の構成が変わっても正しく取れる）。
2. **ID はコードに書かない。**このリポジトリは公開である。共通フォルダの ID はスクリプトプロパティにだけ置く（本番では `saveInstallationProperties` で入れる）。
3. **画面を開くたびには読まない。**実行したときに 1 回読み、B 列へ書く。顧客一覧が遅くならず、B 列を読むほかの処理（30 か所以上）を変えずに済む。
4. **既定は読むだけ。**`apply === true` のときだけ書く（`'true'` などでは書かない）。
5. **転記シートがある顧客の B 列は変えない。**名前の規則に合う転記シートが雛形と同じフォルダに 1 枚でもあれば書かず報告する。フォルダの改名に自動で追従しない。転記シートの改名もしない。
6. **同じ名前の顧客を作らない。**顧客の取り違えを防ぐため、ほかの行の B 列、または同じ実行で書こうとしている名前と同じなら、書かず報告する。
7. **確かめられないときは書かない。**途中の親が見えない・共通フォルダに届かない・親が 2 つある・名前が空、などはその行だけ書かず、ほかの行は続ける。
8. **B のセルだけを文字のまま書く（RAW）。**フォルダ名が `1001`・`2026/10`・`=...` のような形でも、数値・日付・数式に変えない。
9. 書く前に監査ログへ残す。監査が残せなければ書かない。

## 3. `opsSetCustomerNamesFromFolders(customerId, apply, options)`（新規・公開の運用関数）

`97_Ops.gs` の `opsClearTemplateTaxLeftovers` の後に置く。`loadSettingsFromProperties()` から始める。引数なしで実行すると全顧客を読むだけで調べる（エディタのプルダウンから動かせる）。

- `customerId`：省略・`null`・空文字なら全行。指定があれば A 列が完全一致する行だけ。0 行は `MasterDataError('Customer not found: ' + id)`、2 行以上は `MasterDataError('Duplicate customerId')`。
- `options.timeBudgetMs`：既定は読むだけが 270000、`apply === true` が 135000。`opsCheckIntegrityAllDestinations` と同じ時計・同じ扱いにする。`apply` はロックの中で転記シートを数え直すので、調べる時間に同じだけ足される。全部を調べる時間に使うと 6 分の上限で殺され、何度実行しても 1 行も書けない。
- `options.startRow`：この行番号より上の行を飛ばす。既定は先頭から。

### 3.1 手順

1. `CUSTOMER_ROOT_FOLDER_ID` を読み、前後の空白を除く。空なら Drive も読まずに `{applied: false, stoppedBy: 'ROOT_NOT_CONFIGURED', nextStartRow: null, counts: {}, customers: []}` を返す。
2. `customerMasterRows_()` で全行を読む。**`getActiveCustomers`・`getCustomerById` は使わない** ── 検証で例外になる行（B が空の行など）を直すための関数なので。A 列が空の行は対象にしない。無効（C 列が FALSE）の行も対象にする。
3. 対象の行を上から順に調べる（§3.2）。行を始める前に時間予算を確かめ、超えていたら `stoppedBy: 'TIME_BUDGET'`、`nextStartRow` にその行番号を入れて、以降の行は調べない。
4. 同名の確かめ（§3.3）。
5. `apply !== true` なら報告を返す（`applied: false`）。
6. `apply === true` なら §3.4。
7. `Logger.log(JSON.stringify(報告))` して返す。

### 3.2 1 行の調べ方（`customerId`, `rowNumber`, `active`, `currentName`, `folderName`, `path`, `status`, `reason`, `destinationCount`）

例外は行ごとに受け止め、`status: 'UNRESOLVED'` と決まった語の `reason` にする。例外の本文は返さない（ID が入ることがある）。

1. D 列が空 → `NO_SOURCE_FOLDER`。
2. D 列を起点に親をたどる。`chain` は D から上へ並べたフォルダ（共通フォルダは含めない）。
   - 開始のフォルダが読めない → `FOLDER_UNREADABLE`。
   - D 列が共通フォルダそのもの → `TOO_SHALLOW`。
   - 親を読む：親が 0 個 → `ROOT_NOT_REACHED`（途中の親が見えない場合も含む）、2 個以上 → `MULTIPLE_PARENTS`、親の ID が共通フォルダ → 止まる、それ以外 → `chain` に足して続ける。
   - 20 段たどっても届かなければ `ROOT_NOT_REACHED`。
3. `chain.length < 2` → `TOO_SHALLOW`（D 列が個人/法人のフォルダ）。
4. 顧客フォルダは `chain[chain.length - 2]`、`folderName` はその名前の前後の空白を除いたもの。空 → `EMPTY_NAME`。
5. `path` は `chain` を上から下へ並べた名前（`['法人', '顧客名', '年度', '経費', 'クレカ明細']` の形。人が目で確かめるため）。
6. `folderName === currentName` → `SAME`（ここで終わり。雛形は調べない）。
7. F 列が空 → `NO_TEMPLATE`。雛形の親がちょうど 1 つでない → `TEMPLATE_LOCATION_UNKNOWN`。雛形が読めない → `TEMPLATE_UNREADABLE`。
8. `currentName` が空でなければ、雛形の親フォルダのファイルを数える：`currentName + '_'` で始まり、残りが `/^\d{8}-\d{4}$/` に合う名前（`webAppValidateDestination_` と同じ規則。**正規表現に顧客名を埋め込まない**）。数を `destinationCount` に入れる。
9. `destinationCount > 0` → `HAS_DESTINATIONS`。それ以外 → `CHANGE`。

`SAME` 以外で `UNRESOLVED` の行も、たどれたところまでの `folderName`・`path` は分かる範囲で返してよい。

### 3.3 同名の確かめ

`status: 'CHANGE'` の行の `folderName` が、(a) シートのほかの行（対象の絞り込みに関係なく全行）の今の B 列、(b) 同じ実行のほかの `CHANGE` の行の `folderName` のどちらかと完全一致したら、`status: 'DUPLICATE_NAME'` にする。(b) は両方の行が `DUPLICATE_NAME` になる。

### 3.4 書く

`status: 'CHANGE'` の行が無ければ何も書かず `applied: true` で返す。ある行は `withScriptLock_` の中で **1 回だけ** 次を行う。

1. `customerMasterRows_()` を読み直す。
2. 行ごとに、A・B・D・F 列が調べたときと同じか確かめる。違えば `status: 'STALE'`（書かない）。
3. §3.2 の 8 の転記シートの数を確かめ直す。1 枚以上なら `HAS_DESTINATIONS`、読めなければ `UNRESOLVED`（書かない）。
4. 読み直した行で §3.3 の (a) を確かめ直す。同じなら `DUPLICATE_NAME`（書かない）。
5. 残った行の監査をまとめて 1 回で書く（`appendAuditRowsUnlocked_`）：`type: 'SETTING'`、`actor: activeUserEmail_()`、`targetType: 'CUSTOMER'`、`targetId`・`customerId` は顧客 ID、`before: {B: 変更前}`、`after: {B: 変更後}`、`reason: 'CUSTOMER_NAME_FROM_FOLDER'`。**ここで失敗したら B 列を書かず、例外をそのまま投げる。**
6. `SpreadsheetApp.flush()` で監査を確定させる。監査は `Range.setValues` なので保留に入り得るが、B 列は Sheets API で即座に書かれるため、確定させないと監査の失敗が B 列を書いた後に分かる。
7. 残った行の B セルだけを `Sheets.Spreadsheets.Values.batchUpdate` 1 回で書く（`valueInputOption: 'RAW'`。`quoteSheetName_` を使う）。`status: 'WRITTEN'`。

### 3.5 返す値

`{applied, stoppedBy, nextStartRow, counts, customers}`。`counts` は `status` ごとの行数。`stoppedBy` と `nextStartRow` は無ければ `null`。**フォルダ ID・スプレッドシート ID・共通フォルダの ID は返さない・ログに出さない。**

## 4. 変えないこと

- `src/97_Ops.gs` 以外の src。`customerFromRow_`・`validateCustomerValues_`・`registerTestCustomer`・`webAppCloneDestination_`・`webAppValidateDestination_`・`webAppListDestinations`、画面、メニュー。
- 過去の処理ログ・要確認の行に残る顧客名。
- テストの土台は `test/gas-stubs.js` のフォルダの持ち手に `getParents()` を足すことだけを許す（§5.0）。

## 5. テスト（`cn N: …`、新しいファイル `test/phase6-customer-name-from-folder.test.js`）

値はすべて架空にする。

### 5.0 土台

`folderHandle` に `getParents()` を足す：`subFolderIds` にそのフォルダを持つフォルダを返す。`readAllowed === false` の親は返さない（実物の Drive で見えない親が返らないのと同じ）。既存の項目は変えない。

### 5.1 テスト

1. **cn 1（見つける）**：共通 → 法人 → 顧客 → 年度 → 経費 → クレカ明細（D 列）、B は仮の名前 → 読むだけで `CHANGE`・`folderName`・`path` が正しい。マスターのどのセルも変わらず、監査も増えず、書込回数 0。
2. **cn 2（段数が変わっても取れる）**：D 列が顧客フォルダそのもの／顧客フォルダの 1 段下／7 段下、個人の下の顧客 → すべて正しい顧客フォルダ名。
3. **cn 3（確かめられない）**：`NO_SOURCE_FOLDER`・`FOLDER_UNREADABLE`・`ROOT_NOT_REACHED`（共通フォルダの外／途中の親が見えない）・`TOO_SHALLOW`（D が共通そのもの／D が個人）・`MULTIPLE_PARENTS`・`EMPTY_NAME`（空白だけの名前）を 1 つずつ。どれも B 列は変わらず、**同じ実行のほかの行は書かれる**。
4. **cn 4（書く）**：`apply = true` → その行の B 列だけが変わり、ほかの列・ほかの行は同じ。監査 1 行（前後の値）。`getCustomerById` が新しい名前を返す。もう一度実行すると `SAME` で監査は増えない。
5. **cn 5（転記シートがある）**：雛形の親に `<B>_20261001-1200` → `HAS_DESTINATIONS`・`destinationCount: 1`、`apply` でも書かない。`<B>_メモ`・`別の顧客_20261001-1200`・`<B>_20261001-1200_写し` は数えない → `CHANGE`。B に正規表現の記号が入っていても文字どおりに扱う。
6. **cn 5b（雛形が確かめられない）**：`NO_TEMPLATE`・`TEMPLATE_LOCATION_UNKNOWN`（親 2 つ）・`TEMPLATE_UNREADABLE`。書かない。
7. **cn 6（同名）**：ほかの行の B 列と同じ／同じ実行の 2 行が同じ → `DUPLICATE_NAME`、書かない。顧客 ID を指定した実行でも、対象外の行の B 列と比べる。
8. **cn 7（読んだ後に変わった）**：`withScriptLock_` の中の読み直しの前に、(a) B 列を変える → `STALE`、(b) D 列を変える → `STALE`、(c) 転記シートが増える → `HAS_DESTINATIONS`、(d) ほかの行の B 列が同じ名前になる → `DUPLICATE_NAME`。どれも書かない。
9. **cn 8（文字のまま）**：フォルダ名 `1001`・`2026/10`・`=1+1` → B 列に同じ文字列のまま入り、`getCustomerById` の `customerName` も同じ。`RAW` で書かれている。
10. **cn 9（監査が失敗）**：`appendAuditRowsUnlocked_` が投げる → 例外が外へ出て、B 列は変わらない。
11. **cn 10（設定なし）**：プロパティなし・空白だけ → `ROOT_NOT_CONFIGURED`、Drive を読まない、書かない。
12. **cn 11（時間予算と続き）**：時計を進めて途中で `TIME_BUDGET`・`nextStartRow` → 調べた行だけ書かれる。`startRow` で続きを呼ぶと残りが書かれる。
13. **cn 12（入口）**：引数なしは全行を読むだけ。顧客 ID の指定はその行だけ。無い ID・重複した ID は `MasterDataError`。`apply` が `'true'`・`1` では書かない。
14. **cn 13（壊れた行を直せる）**：C 列が TRUE で B 列が空の行があると `getActiveCustomers` は例外になるが、この関数は動いて B 列を入れ、その後 `getActiveCustomers` が通る。
15. **cn 14（ID を出さない）**：戻り値とログに、フォルダ ID・雛形の ID・共通フォルダの ID が出ない。
16. **cn 15（回数）**：読むだけと `apply` の Sheets の読取・書込回数を測り、**測った値そのもの**を上限にする。
17. **cn 16（監査の確定）**：監査を書いた直後に `flush` し、その後で B 列を書く。
18. **cn 17（既定の予算）**：`apply` は 135 秒、読むだけは 270 秒で止まり、その 1 ミリ秒前では止まらない。

## 6. 変異（R1〜R14）── それぞれ赤になるテストを記録する

- R1：`apply` でなくても書く
- R2：`apply` を真偽値として判定する（`'true'` でも書く）
- R3：転記シートの確かめを外す
- R4：転記シートの名前の規則を前方一致だけにする
- R5：同名の確かめを外す
- R6：ロックの中の読み直しを外す
- R7：監査を書かない
- R8：監査を B 列の後に書く
- R9：`valueInputOption` を `USER_ENTERED` にする
- R10：共通フォルダの 1 段下（個人/法人）を顧客フォルダにする
- R11：親が 2 つのときに先頭を採る
- R12：例外を行ごとに受け止めない（1 行の失敗で全体が止まる）
- R13：時間予算を見ない
- R14：`startRow` を無視する

## 6.1 実装と監査の記録（2026-10-31）

- Codex（gpt-6.1-sol・xhigh）：1751/1751（+16）、R1〜R14 はすべて赤。読取は読むだけで `batchGet` 1、`apply` で 3、書込 1。src の差分は 97 だけ、土台は `getParents()` だけ。
- 監査で私が直したこと：(1) 監査の後に `flush`（§3.4 の 6。テストの模型では書込が保留されないので、緑のまま隠れていた）、(2) `apply` の既定の予算を半分に（§3 の `timeBudgetMs`）。テストに cn 16・17 を足した。
- 私の変異 Z1〜Z9 のうち 2 つがすり抜けたのでテストを足した：Z7（読むだけの報告が対象外の行との同名を見ない ── `apply` はロック内の確かめで止まる）→ cn 6、Z8（B が空でも `_日時` のファイルを数える）→ cn 13。cn 16 は最初の形だと Z1 を見逃した（監査の末尾を読むときの `flush` と区別できなかった）。
- 最終 1753/1753。97 の NUL 2・CR 0、`???` 0。

## 7. 本番での実行（私が行う。利用者の許可を得てから）

1. push 後、`saveInstallationProperties({CUSTOMER_ROOT_FOLDER_ID: <共通フォルダの ID>})`。
2. `opsSetCustomerNamesFromFolders()`（読むだけ）。`path` を確かめる。TEST01 は共通フォルダの外なら `ROOT_NOT_REACHED` で何も変わらない。
3. 本番の顧客の行が `CHANGE` なら、許可を得て `opsSetCustomerNamesFromFolders('', true)` → もう一度読むだけで `SAME`。

実行は取込の最中を避ける。転記シートの作成はスクリプトロックの外なので、取込と同時に動かすと §3.4 の確かめをすり抜けることがある（そのときも帳簿は壊れない。そのシートが一覧に出なくなるだけ）。

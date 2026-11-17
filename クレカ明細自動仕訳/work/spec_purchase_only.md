# 「仕入れ専用」の明細を用途の列なしで読む・画面の「ファイル一覧」を要確認の上へ 仕様書

作成日：2026-11-17
版：1.0
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いてあることは変えない。書いていないことは安全側で決め、決めたことは全部報告する。
前提：形式の判定（`src/13_CardDetector.gs`）・使用用途補完（`src/31_PurposeResolver.gs`）・取込（`src/71_RunOrchestrator.gs` の 8-3〜8-5）・形式の画面登録（`spec_format_registration.md`、`src/19_FormatRegistration.gs`）・画面（`src/81_WebAppUi.html`）。

改訂履歴：
- 1.0（2026-11-17）：初版。利用者の依頼と決定（2026-11-02・11-17、§1.1）。

**この仕様書と、実装・テストには、実在の顧客名・顧客 ID・Drive の ID・カード名・明細の中身（店名・金額・カード番号）を書かない。**リポジトリは公開である。テストの値はすべて架空にする（例：`K9001`・`架空ストア`・`テストカード`）。

---

## 1. 何を作るか

### 1.1 背景（利用者の依頼と決定）

- **依頼 1（2026-11-17）：**ファイル名に「仕入れ専用」と書かれたクレカ明細は、使用用途の欄に記載が無くても形式不明にせず、使用用途を「仕入れ」として転記する。
- **依頼 2（2026-11-17）：**画面の「ファイル一覧」と［記帳を実行］を、今の「要確認」の位置（右の列の上）へ移し、その下に「要確認」を置く。
- **前からの決定（2026-11-02）：**ファイル名の「仕入れ専用」は、**全行の用途を仕入として扱ってよい**（用途の欄に何か書いてある行も含む）。
- **決定（2026-11-17）：**「仕入れ専用」のファイルなら、**用途の列なしで形式を画面から登録できるようにする**（用途の列がある普通の明細が一度も来ていないカードのため）。
- **事実（本番の 1 人目の顧客、2026-11-02 の診断。中身はここに写さない）：**「仕入れ専用」の明細の多くは、同じカードの普通の明細より**右端の「使用用途」の列が 1 つ少ない**（顧客が用途の列を足していない）。列の数が登録済みの形式の上限・下限に合わないので `UNKNOWN_CARD_FORMAT`（形式不明）になる。11-17 の画面でも同じカードフォルダの「仕入れ専用」5 本が形式不明、同じフォルダの普通の明細は判定できている。

### 1.2 本仕様がすること

1. **「仕入れ専用」の見分け方**を 1 つの関数にする（§2.1）。
2. **形式の判定の予備：**「仕入れ専用」のファイルが普通の判定で形式不明のとき、登録済みの形式から**右端の用途の列を除いた形**を作って、もう一度判定する。ちょうど 1 つに決まれば、その形式（土台の形式 ID・版）で読む（§3）。
3. **用途を「仕入れ」に：**「仕入れ専用」のファイルは、全行の使用用途を `仕入れ` にする（書いてあった行も上書き。§4）。
4. **形式の登録：**「仕入れ専用」のファイルからは、用途の列を選ばずに形式を登録できる（§5）。
5. **画面の並び：**「ファイル一覧」と［記帳を実行］を新しい枠にして右の列の上に置き、「要確認」をその下にする（§6）。

### 1.3 変えないもの・しないこと

- **「仕入れ専用」でないファイルの動きは一切変えない**（判定・用途・登録・画面の文言）。
- 普通の判定の結果が `RESOLVED`・`AMBIGUOUS_CARD_FORMAT`・`MULTI_SHEET_AMBIGUOUS` のときは予備を使わない。予備は `UNKNOWN_CARD_FORMAT` のときだけ。
- 予備が 2 つ以上の形式に当たる・2 つ以上のシートに当たるときは、**形式不明のまま**にする（どれかを選ばない）。
- 予備で変えるのは「列の数」「判定キーワードの `使用用途`」「用途の列」だけ。**日付・店名・金額・予備金額・除外・件数照合・請求月・カード名の読み方は土台の形式のまま。**
- カード形式マスターに予備の形を書かない（その場で作って捨てる）。
- 明細ファイルの中身は変えない。使用用途補完マスターの中身も変えない。
- 判定の衝突検査（4.12.4、`14_ActivationGates.gs`）と `detectFormatWith` は変えない。
- 取込の往復（Sheets・Drive の読み書き）を増やさない。予備は計算だけ。

---

## 2. 言葉と前提

### 2.1 「仕入れ専用」のファイル

`isPurchaseOnlyFileName_(fileName)`（新しい関数。`31_PurposeResolver.gs` に置く。純粋な関数で、ほかのファイルに頼らない）：

- `String(fileName || '').normalize('NFKC')` に、正規表現 `/仕入れ?\s*専用/` が当たれば真。
- 例：真＝`4月引き落とし分仕入れ専用`・`【処理中】仕入専用 明細`・`仕入れ 専用`。偽＝`仕入_明細`・`専用カード`・`仕入れ用`・`仕入れ明細（専用口座）`。
- 名前の頭の状態の印（`【処理中】` など）は気にしない（含んでいても判定は同じ）。

### 2.2 用途の値

`PURCHASE_ONLY_PURPOSE_ = '仕入れ'`（`31` に定数で置く）。勘定科目の用途辞書（`39_AccountSeed.gs` の `仕入`）に部分一致で当たり、相手科目は 712（仕入高）になる。顧客が普通の明細に書いている `仕入れ ○○` と同じ書き方。

### 2.3 用途の列なしの形（予備の形）

登録済みの形式 D から、次の**全部**を満たすときだけ作る。1 つでも外れたら作らない（`null`）。

1. `D.valid === true`、`D.purposeColumn` がある。
2. `D.columnProfile` があり、`minColumns` と `maxColumns` が整数で**等しい**（幅が 1 つに決まっている）。`maxColumns - 1 >= 1`。
3. 用途の列が**右端**：`detectorColumnIndex_(D.purposeColumn) === D.columnProfile.maxColumns - 1`。
4. ほかの列の指定がすべて用途の列より左：`dateColumn`・`dateAltColumn`・`merchantColumn`・`amountColumn`・`amountFallbackColumn`・`foreignCurrencyColumn`・`foreignAmountColumn`・`exchangeRateColumn`（空は見ない）、`columnProfile.columns[].index`、`exclusionRule.rules` のうち `target: 'cell'` の `column`、`countTotalRule` の `labeledRow` の `labelColumn`・`valueColumn` と `cell` の A1 の列、`cardNameRule.sources` のうち `kind: 'cell'` の `column`（1 起算の数）。
5. `D.sectionBreakRule` が無い（区切りの後で列の並びが変わる形式は扱わない）。
6. 判定キーワード（`keywordRule` の `allOf`・`anyOf` の各条件）から、`normalizeMerchant(語) === normalizeMerchant('使用用途')` の語を除く。除いた条件は `minMatch = Math.min(minMatch, 残りの語の数)`。
   - `allOf` の条件で語が 0 になったら、作らない。
   - `anyOf` の条件で語が 0 になったら、その条件を外す。`anyOf` が空になり `allOf` も無ければ、作らない。

作る形は D の写し（元の D と、その中の物を書き換えない）で、違いは次だけ：
- `purposeColumn: null`
- `columnProfile` は写して `minColumns = maxColumns = D.columnProfile.maxColumns - 1`
- `keywordRule` は 6 の結果
- `purposeAbsentOf: D.formatId`（印）
- `formatId`・`version` は D と同じ。

**予備の形がシートに当たる条件**は、普通の判定（`evaluateFormatDetection_`：キーワード → 列の構造。列の型の過半数も含む）に当たり、さらに**そのシートの見出し行（`headerRow`）に `normalizeMerchant(セル) === normalizeMerchant('使用用途')` のセルが 1 つも無い**こと（用途の列が別の場所にある明細を拾わない。`formatPurposeGap_` の `PURPOSE_COLUMN_ABSENT` と同じ考え）。

---

## 3. 形式の判定（`13_CardDetector.gs`）

### 3.1 新しい関数

- `purposeAbsentVariant_(def)`：§2.3 の形を返す。作れなければ `null`。
- `detectFileFormat_(definitions, sheets, fileType, fileName, context)`：ファイル単位の判定。
  1. 各シートで `detectFormatWith(definitions, sheet, fileType, fileName)` → `aggregateSheetDetections(detections, context)`。今と同じ。
  2. 結果が `UNKNOWN_CARD_FORMAT` で、かつ `isPurchaseOnlyFileName_(fileName)` が真のときだけ 3 へ。それ以外は 1 の結果をそのまま返す（`purposeColumnAbsent` は付けない）。
  3. `definitions` の各形式から `purposeAbsentVariant_` を作る（`null` は捨てる）。0 個なら 1 の結果を返す。
  4. 各シートで、予備の形に `detectFormatWith` を掛け、§2.3 の見出しの条件を満たす候補だけ残す → `aggregateSheetDetections(同じ context)`。
  5. 4 が `RESOLVED` なら、その結果に `purposeColumnAbsent: true` を足して返す（`formatId`・`formatVersion` は土台の形式のもの）。`RESOLVED` でなければ（`AMBIGUOUS_CARD_FORMAT`・`MULTI_SHEET_AMBIGUOUS`・`UNKNOWN_CARD_FORMAT` のどれでも）**1 の結果（`UNKNOWN_CARD_FORMAT`）を返す**。
- 返す物は `aggregateSheetDetections` と同じ形（`status`・`sheetName`・`formatId`・`formatVersion`・`detail`）に、予備で決まったときだけ `purposeColumnAbsent: true`。

### 3.2 使う場所

- `71_RunOrchestrator.gs` の 8-3（今の `detections` と `aggregateSheetDetections` の組み）を `detectFileFormat_` に替える。`context` は今と同じ物。
- `19_FormatRegistration.gs` の `formatDetectRead_` の中身を `detectFileFormat_` に替える（`targetSheetName` の読み方は今のまま）。これで、取込待ちへ戻す（`80` の `webAppRequeueFormatFiles`）と［形式を確認］（`formatExplainUnknown_`）と登録の確かめが、同じ判定を使う。
  - 登録の確かめ（`formatPreview_` の `onNew`・`all`、`formatSave_`）は、普通の判定で決まるので予備は効かない（予備は形式不明のときだけ）。`others`（`TARGET_AMBIGUOUS`）・`REFERENCE_COLLISION`・`STATIC_COLLISION` は `detectFormatWith`・`formatGap_` のままで、予備を使わない。

### 3.3 取込での読み方（`71`）

- `purposeColumnAbsent` のとき：`cardFormat = Object.assign({}, pinFormatVersion(formatId, formatVersion), {purposeColumn: null})`。版の固定（`pinFormatVersion`）と版の確かめは土台の形式・版のまま。**以後の手順（抽出・年の補完・件数照合・前年の検査・転記）はこの `cardFormat` を使う。**用途の列は読まない（表の外の列を読まない）。
- 処理ログの形式 ID は土台の形式 ID（今と同じ列に今と同じ書き方）。
- `outcome`（取込の結果）に `purchaseOnly: {purposeColumnAbsent: true|false}` は**足さない**（画面の知らせは本仕様では変えない）。

---

## 4. 用途を「仕入れ」にする（`31_PurposeResolver.gs` の `resolvePurposes`）

- `isPurchaseOnlyFileName_(fileNameOriginal)` が真のとき：
  - **全行**の `purpose` を `仕入れ`（`PURCHASE_ONLY_PURPOSE_`）にする。書いてあった行（`返品`・`私的利用` など）も上書きする。
  - `purposeInferred: true`、`purposeInferenceRuleId: 'PURCHASE_ONLY_FILE'`。
  - 使用用途補完マスター（`rules`）は**使わない**（ファイル名に補完の語が当たっても、こちらが勝つ）。
  - `unresolvedCount: 0`。
- 偽のとき：今と同じ（1 文字も変えない）。
- **戻り値の形は今と同じ `{txs, unresolvedCount}`。**新しい項目を足さない（既存テスト `5.4 vector 6` が形をそのまま比べている）。
- 入ってきた取引の物を書き換えない（今と同じく写してから変える）。
- 取込（`71` の 8-5）と形式登録の試し読み（`19` の `formatPreviewExtraction_`）は、今と同じく `resolvePurposes` を通るので、両方で同じになる。
- **明細内容ハッシュ（`41` の `generateContentHash`）は用途を含む。**「仕入れ専用」で前に取り込んだファイルを取り込み直すと、内容ハッシュが前と変わる。二重転記は今の仕組み（同じ取引の並びで内容ハッシュが違えば `PURPOSE_REVISION_CANDIDATE` の要確認、転記しない）で止まる。ここは変えない。

---

## 5. 形式の登録（`19_FormatRegistration.gs`・`81`）

### 5.1 サーバー

- `formatPreview_`：`if (!columns.purpose) block('PURPOSE_COLUMN_REQUIRED')` を、**`!columns.purpose && !isPurchaseOnlyFileName_(context.fileName)`** のときだけにする。
- 「仕入れ専用」のファイルでは、`formatPurposeGap_` の結果を使わない（`purposeGap = null`）。理由：全行が `仕入れ` になるので、顧客に用途の列を足してもらう必要が無い。
  - `formatExplainUnknown_`：`purposeGap: null`・`customerSide: false`。
  - `formatPreview_`：`purposeGap` を `null` として扱う（`ACK_CUSTOMER_SIDE_REQUIRED` を `purposeGap` の理由では出さない。`formatDerivedSpec_` に渡す `purposeGap` も `null`）。
  - **用途の列を選んで、その見出しが `使用用途` でないとき**の `ACK_CUSTOMER_SIDE_REQUIRED` と `PURPOSE_HEADER_NOT_STANDARD` は今のまま（「仕入れ専用」でも出す）。
- `formatExplainUnknown_` の返事に `purchaseOnly: true|false`（`isPurchaseOnlyFileName_(context.fileName)`）を足す。`verdict: 'MATCHES_ACTIVE'` で予備で決まったときは `purposeColumnAbsent: true` も足す。
- 用途の列なしで保存した形式は、カード形式マスターの L 列（用途の列）が空になる（`formatDerivedSpec_` は今も `columns.purpose || ''`）。判定・取込はそのまま動く（用途は §4 で全行 `仕入れ`）。

### 5.2 画面（`81`）

- 形式の確認パネル：`d.purchaseOnly` のとき、ファイル名の行の下に 1 行出す：
  `「仕入れ専用」のファイルです。使用用途の列は選ばなくても登録できます。取り込むと全行の使用用途が「仕入れ」になります。`
- `d.verdict === 'MATCHES_ACTIVE'` で `d.purposeColumnAbsent` のとき、「登録済みの形式「…」で読めます」の行の下に 1 行出す：
  `「仕入れ専用」のファイルなので、使用用途の列が無くても読めます。取り込むと全行の使用用途が「仕入れ」になります。`
- 文言は `textContent` で入れる（`innerHTML` を使わない）。ほかの文言と動きは変えない。
- `TEXT` の `PURPOSE_COLUMN_REQUIRED` の文言は変えない（「仕入れ専用」でないファイルには今どおり出る）。

---

## 6. 画面の並び（`81`）

### 6.1 HTML

- 「Drive フォルダ」の枠（`section.panel.drive`）には「カードフォルダ」（見出しと `#folder-list`）だけを残す。
- 新しい枠 `<section class="panel files" aria-labelledby="files-heading">` を、**`section.panel.drive` の直後、`section.panel.reviews` の直前**に置く（`<main>` の直下。ほかの要素で囲まない）。中身：
  ```html
  <div class="panel-header"><h2 id="files-heading">ファイル一覧</h2></div>
  <div class="panel-body">
    <div id="files-empty" class="empty">左の一覧から顧客を選んでください。</div>
    <div id="files-content" hidden>
      <div id="file-list"></div>
      （今の #import-progress の div をそのまま）
      <div id="import-disabled-reason" class="muted"></div>
      <div class="action-row">
        <button id="import-button" type="button" class="button primary" disabled>記帳を実行</button>
      </div>
    </div>
  </div>
  ```
  - `#file-list`・`#import-progress`（中の子も）・`#import-disabled-reason`・`#import-button` は**今の要素を移すだけ**（ID・クラス・属性・中身を変えない）。今の `<h3 class="subheading">ファイル一覧</h3>` は消す（枠の見出しになる）。
- `section.panel.reviews` の中は変えない。

### 6.2 CSS

- 広い画面（今の 3 列）：
  - `.workspace` に `grid-template-rows: auto 1fr;`
  - `.panel.customers { grid-column: 1; grid-row: 1 / span 2; }`
  - `.panel.drive { grid-column: 2; grid-row: 1 / span 2; }`
  - `.panel.files { grid-column: 3; grid-row: 1; }`
  - `.panel.reviews { grid-column: 3; grid-row: 2; }`
- 狭い画面（今の `@media (max-width: 1120px)`、2 列）：
  - `.panel.customers { grid-column: 1; grid-row: 1; }`・`.panel.drive { grid-column: 2; grid-row: 1; }`
  - `.panel.files { grid-column: 1 / -1; grid-row: 2; }`・`.panel.reviews { grid-column: 1 / -1; grid-row: 3; }`（今の `grid-column: 1 / -1` は残す）
- ほかの CSS は変えない。

### 6.3 JS

- `el` の ID の一覧に `files-empty`・`files-content` を足す。
- `renderSelection` で、`drive-empty`・`drive-content` と同じく `el['files-empty'].hidden = hasCustomer; el['files-content'].hidden = !hasCustomer;`。
- ほかの JS（ファイル一覧の描き方・記帳・進み具合・ボタンの押せる条件）は変えない。

---

## 7. 安全の条件（テストで確かめる）

- S1：ファイル名に「仕入れ専用」が無いファイルは、判定・用途・登録の結果が今と同じ（同じ入力で同じ出力）。
- S2：予備は普通の判定が `UNKNOWN_CARD_FORMAT` のときだけ動く。`AMBIGUOUS_CARD_FORMAT`・`MULTI_SHEET_AMBIGUOUS` を `RESOLVED` に変えない。予備が 2 つ以上に当たれば `UNKNOWN_CARD_FORMAT`。
- S3：予備で読むとき、日付・店名・金額の列は土台の形式と同じ。用途の列は読まない。
- S4：カード形式マスター・明細ファイル・使用用途補完マスターに書かない（予備の形を保存しない）。
- S5：用途の列なしの登録は「仕入れ専用」のファイルだけ。
- S6：画面の並びを変えても、記帳・ファイル一覧・要確認の動きは同じ（既存のテストがそのまま通る。§9.3 の 1 件を除く）。

---

## 8. テスト（サーバー）

新しいファイル `test/purchase-only.test.js`。名前は `pso N: …`。値は全部架空。形式は `04_Provisioning.gs` の `ANNOTATED_FORMAT_SPECS_` の `ucs_family`（11 列・用途 K）・`jcb_family`（`使用用途` を判定キーワードに含む）・`amex_6_alt`（用途 E が右端でない）・`smbc_family_x7` を `cardFormatRowValues_` → `formatRowFromValues_` で定義にして使ってよい。架空の形式を作ってもよい。

- pso 1：`isPurchaseOnlyFileName_` の真偽（§2.1 の例を全部。全角の空白・半角の空白・`【処理中】` の頭も）。
- pso 2：`resolvePurposes` に「仕入れ専用」の名前：空の行・`返品` の行・`私的利用` の行が全部 `仕入れ`、`purposeInferred: true`、`purposeInferenceRuleId: 'PURCHASE_ONLY_FILE'`、`unresolvedCount: 0`。補完の規則（名前に当たる `経費`→`経費` の規則）があっても `仕入れ`。入ってきた取引の物は変わらない。戻り値の鍵は `txs`・`unresolvedCount` の 2 つだけ。
- pso 3：`purposeAbsentVariant_`：
  - (a) `ucs_family` → 幅 10（min・max とも）、`purposeColumn: null`、`purposeAbsentOf: 'ucs_family'`、`formatId`・`version` は同じ、日付・店名・金額の列は同じ、元の定義は変わらない。
  - (b) `jcb_family` → `使用用途` が消え、`minMatch` が 4、ほかの語は残る。
  - (c) `null` になる：`amex_6_alt`（用途が右端でない）・用途の列なし・`columnProfile` なし・`maxColumns` なし・min と max が違う・`allOf` の語が `使用用途` だけ・除外の `cell` 規則が用途の列・`amountFallbackColumn` が用途の列・`sectionBreakRule` あり・`columnProfile.columns` の index が用途の列・`cardNameRule` の `cell` の列が用途の列・`valid: false`。
- pso 4：`detectFileFormat_`（`ucs_family` を含む定義の集まり、10 列の架空の UCS 形のシート）：
  - (a) 名前が「仕入れ専用」→ `RESOLVED`・`formatId: 'ucs_family'`・`purposeColumnAbsent: true`。
  - (b) 同じシートで名前に「仕入れ専用」が無い → `UNKNOWN_CARD_FORMAT`、`purposeColumnAbsent` なし。
  - (c) 「仕入れ専用」で 11 列（用途の列あり）→ 普通の判定で `RESOLVED`、`purposeColumnAbsent` なし。
  - (d) 「仕入れ専用」で 10 列だが見出しに `使用用途` のセルがある → `UNKNOWN_CARD_FORMAT`。
  - (e) 「仕入れ専用」で予備の形が 2 つ当たる（同じ見出し・同じ幅の架空の形式を 2 つ）→ `UNKNOWN_CARD_FORMAT`（`AMBIGUOUS` にしない）。
  - (f) 「仕入れ専用」で 9 列（2 つ少ない）→ `UNKNOWN_CARD_FORMAT`。
  - (g) 「仕入れ専用」で普通の判定が `AMBIGUOUS_CARD_FORMAT` → そのまま `AMBIGUOUS_CARD_FORMAT`。
  - (h) 「仕入れ専用」で 10 列だが日付の列が日付でない（型の過半数を取れない）→ `UNKNOWN_CARD_FORMAT`。
  - (i) 2 シートのファイルで、片方だけ予備に当たる → `RESOLVED`・そのシート名。
  - (j) `jcb_family` の 12 列（用途の列なし・見出しに `使用用途` なし）を「仕入れ専用」で → `RESOLVED`・`jcb_family`。
- pso 5：取込の通し（`71`。既存の取込のテスト〔`test/phase6-orchestrator.test.js`・`test/phase6-google-sheets-import.test.js` など〕の作り方に合わせる）：「仕入れ専用」の 10 列の架空の UCS 形の明細 → 形式不明の要確認が立たない・転記した全行の用途が `仕入れ`・処理ログの形式 ID が `ucs_family`・用途の列（K）を読んでいない（K に当たる位置に何か入れても転記に出ない）。同じ明細で名前に「仕入れ専用」が無ければ、今どおり形式不明（`FORMAT_UNKNOWN` の要確認）。
- pso 6：`webAppRequeueFormatFiles`：形式不明の要確認がある「仕入れ専用」の 10 列のファイル → `requeued` に入り `formatId: 'ucs_family'`。名前に「仕入れ専用」が無い同じ形 → `skipped` の `STILL_UNKNOWN`。
- pso 7：`formatExplainUnknown_`（入口は既存の画面登録のテストと同じ道で）：
  - (a) 予備で読める「仕入れ専用」→ `verdict: 'MATCHES_ACTIVE'`・`purposeColumnAbsent: true`・`purchaseOnly: true`。
  - (b) どの形式にも当たらない「仕入れ専用」で、近い形式との違いが用途の列だけ（今なら `PURPOSE_COLUMN_ABSENT` になる形。予備が型で外れるなど）→ `purchaseOnly: true`・`purposeGap: null`・`customerSide: false`。
  - (c) 名前に「仕入れ専用」が無い同じ形 → 今どおり `purposeGap.kind: 'PURPOSE_COLUMN_ABSENT'`・`customerSide: true`・`purchaseOnly: false`。
- pso 8：`formatPreview_`・保存：
  - (a) 「仕入れ専用」で用途の列を選ばない → `PURPOSE_COLUMN_REQUIRED` も `ACK_CUSTOMER_SIDE_REQUIRED` も出ない。試し読みの全行の用途が `仕入れ`、`PURPOSE_EMPTY_ROWS` の警告が出ない。保存でき、保存した行の L 列が空。その後、同じファイルが新しい形式で普通に判定される。
  - (b) 名前に「仕入れ専用」が無い → 今どおり `PURPOSE_COLUMN_REQUIRED`。
  - (c) 「仕入れ専用」で用途の列を選び、その見出しが `使用用途` でない → 今どおり `ACK_CUSTOMER_SIDE_REQUIRED` と `PURPOSE_HEADER_NOT_STANDARD`。
- pso 9：往復：取込 1 本（「仕入れ専用」の予備で決まるファイル）の Sheets・Drive の呼び出しの数が、同じ明細を普通の形式で読むときと同じ（既存の往復のテストの数え方に合わせる）。

## 9. テスト（画面）と既存のテスト

### 9.1 画面の並び（`lay N: …`、新しいファイル `test/files-panel-layout.test.js`）

- lay 1：`<body>` の HTML で、`section.panel.files` が `section.panel.drive` の後・`section.panel.reviews` の前。`<main>` の直下にある（ほかの要素で囲まれていない）。
- lay 2：`section.panel.files` の中に `file-list`・`import-progress`・`import-disabled-reason`・`import-button` がこの順である。`section.panel.drive` の中に `folder-list` があり、`file-list`・`import-button`・`import-progress` が無い。
- lay 3：各 ID が HTML に 1 つだけ（`file-list`・`import-button`・`import-progress`・`files-empty`・`files-content`）。
- lay 4：CSS：広い画面で `.panel.files` が 3 列目の 1 行目・`.panel.reviews` が 3 列目の 2 行目・`.panel.customers` と `.panel.drive` が 2 行にまたがる。`@media (max-width: 1120px)` の中で `.panel.files` が 2 行目の全幅・`.panel.reviews` が 3 行目の全幅。
- lay 5：`kw26-ui-helpers.js` の `browserWorld` で：顧客を選ぶ前は `files-empty` が見え `files-content` が隠れる。選ぶと逆。［記帳を実行］が今どおり押せる・押せない（担当者でない顧客など）。

### 9.2 形式の確認パネル（`psou N: …`、同じく新しいファイル `test/purchase-only-ui.test.js`）

- psou 1：`purchaseOnly: true` の診断で §5.2 の 1 行目が出る。`false` では出ない。
- psou 2：`MATCHES_ACTIVE` で `purposeColumnAbsent: true` のとき §5.2 の 2 行目が出る。無いときは出ない。［登録済みの形式で再検査する］は今どおり出る。
- psou 3：文言は `textContent`（`innerHTML` を使わない。既存のテストの見張りの作り方に合わせる）。

### 9.3 既存のテスト

- 変えてよいのは **`test/phase9-format-registration.test.js` の `move 3: drive folders files progress and import keep their order` だけ**。新しい中身：`folder-list` は `section.panel.drive` の中、`file-list`・`import-progress`・`import-button` は `section.panel.files` の中でこの順。テストの名前は変えてよい（`move 3: folders stay in the drive panel and files, progress and import move to the files panel`）。
- ほかの既存のテストは 1 つも変えない。落ちたら実装を直す。
- 基準：worktree では `test/fixtures/` が無いので 97 件が ENOENT で落ちる（直さない）。`ac 6` は時刻の秒またぎで落ちることがある（直さない。もう一度回す）。

---

## 10. 変異（入れて回し、赤になるテストを記録して戻す）

- R1：`isPurchaseOnlyFileName_` が常に偽。
- R2：`isPurchaseOnlyFileName_` が常に真。
- R3：`resolvePurposes` の「仕入れ専用」で空の行だけ埋める（書いてある行を残す）。
- R4：「仕入れ専用」でも補完の規則を先に使う。
- R5：予備の形の幅を減らさない（`maxColumns` のまま）。
- R6：予備の形で用途の列が右端かを見ない。
- R7：予備の形で min と max が等しいかを見ない。
- R8：見出しの `使用用途` の条件を見ない。
- R9：普通の判定が `AMBIGUOUS_CARD_FORMAT` でも予備を使う。
- R10：予備が `RESOLVED` でないとき、予備の結果（`AMBIGUOUS` など）を返す。
- R11：`minMatch` を減らさない（`使用用途` を除いても元の数のまま）。
- R12：`71` で `purposeColumn: null` にせず、`pinFormatVersion` の結果をそのまま使う（pso 5 の「K を読まない」で赤になること）。
- R13：`PURPOSE_COLUMN_REQUIRED` をどのファイルでも出さない。
- R14：「仕入れ専用」で `purposeGap` を消さない。
- R15：`section.panel.files` を `section.panel.reviews` の後に置く。
- R16：`renderSelection` で `files-content` を出さない。
- R17：`@media` の中の `.panel.files` の全幅を消す。
- R18：§5.2 の 1 行目を `purchaseOnly` に関係なく出す。

---

## 11. 変えてよいファイル

- `src/13_CardDetector.gs`・`src/31_PurposeResolver.gs`・`src/71_RunOrchestrator.gs`・`src/19_FormatRegistration.gs`・`src/81_WebAppUi.html`
- `test/purchase-only.test.js`（新規）・`test/purchase-only-ui.test.js`（新規）・`test/files-panel-layout.test.js`（新規）
- `test/phase9-format-registration.test.js` の `move 3` だけ（§9.3）
- `test/gas-stubs.js`・`test/kw26-ui-helpers.js`（足りない部品を足すだけ。今の動きを変えない）
- `80_WebApp.gs` は変えない見込み（`formatDetectRead_` を通るため）。変える必要があれば理由を報告する。

---

## 12. 本番での手順と受入

### 12.1 手順（Claude）

1. 実装・監査・全テスト（main で）の後、利用者に聞いてから `clasp push`（手順は今までどおり。前後に pull で本番と一致を確かめ、`gas-push-N` のタグ）。
2. 利用者に F5 を頼む。

### 12.2 受入（利用者）

1. 画面：右の列の上に「ファイル一覧」と［記帳を実行］、その下に「要確認」。顧客を選ぶ前は「左の一覧から顧客を選んでください。」。
2. 形式不明の「仕入れ専用」のファイルで［形式を確認］→「登録済みの形式で読めます」と「仕入れ専用」の 1 行 →［登録済みの形式で再検査する］→［記帳を実行］→ 転記シートの全行が仕入（相手科目が仕入高）。
3. 登録済みの形式と用途の列だけでは違わない「仕入れ専用」のファイルが来たら：［形式を確認］で「仕入れ専用」の 1 行が出て、用途の列を選ばずに試し読み → 保存できる。

---

## 13. Claude の判断の記録（利用者の決定ではないもの）

- 用途の値は `仕入れ`（利用者の依頼の言葉。顧客が普通の明細に書く `仕入れ ○○` と同じ）。11-02 の記録の `仕入` とは書き方だけが違い、科目は同じ 712。
- 予備は「右端の用途の列が 1 つ無い」形だけ。用途の列が真ん中にある形式（顧客がカード会社の列に用途を書く形）では、列が欠けることが無いので扱わない。
- 予備が 2 つ以上に当たるときは形式不明のまま（安全側。どれかを選ぶと金額の列を読み違えうる）。
- 予備で決まった形式でも、処理ログの形式 ID は土台の形式（別の ID を作らない。形式の履歴〔`formatFolderHistory_`〕で同じカードとして数えられる）。
- 取込の結果の知らせは変えない（全行が `仕入れ` になったことは、転記シートの相手科目で分かる）。

## 14. 実装と監査の記録

（実装と監査の後に書く。）

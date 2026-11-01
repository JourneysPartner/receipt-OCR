# CSV と Excel を同じものとして扱う 仕様書

版：1.3（2026-11-02。実際の顧客フォルダに合わせて診断に「資料共有」の段を足し、作業フォルダが無いときは Excel を読まない。§3.7）
対象：`src/13_CardDetector.gs`・`src/24_Parser_Generic.gs`・`src/97_Ops.gs`（運用関数 2 つとその部品）。
発端：2026-11-01、利用者の決定「CSV でも Excel でも同じものとして欲しい」。本番の明細はほとんど CSV で、最初の本番の顧客（以下「1 人目の顧客」）の明細を通す準備である。

**実名をこの文書・コード・テスト・コミットに書かない。**このリポジトリは公開である。顧客の名前は実行時の引数で渡す。

## 1. 背景と下調べの結果

- 形式の判定はファイルの種類で絞っている（`13` の `matchesFileType`、形式定義 E 列）。初期形式 21 のうち CSV 用は `smbc_family_csv` だけなので、同じカードの Excel 形式があっても CSV は `UNKNOWN_CARD_FORMAT` になる。
- 読取は 2 通りある。Excel は Google スプレッドシートへ変換して `getValues()` で読み、日付は `Date`、数は `number` で、全行が同じ長さ。CSV は `parseCsv` が全セルを文字列で返し、行の長さは揃わない。
- 実サンプルの固定データ 33 本を CSV の見た目（全部文字列、日付は `yyyy/MM/dd`、行末の空を落とす、シート名なし）へ変換し、判定だけ絞りを外して比べた結果：
  - 27 本は判定・抽出が一致。**6 本が `UNKNOWN_CARD_FORMAT`**：`jal_family` 3 本と `orico_family` 1 本（日付が 5 桁のシリアル）、`aeon_x8`・`aeon_x9` 各 1 本（日付が 6 桁の `YYMMDD`）。数値セルなら読めるが、文字列では `interpretDateExpression` が読めない。
  - 判定が通っても **`jcb_family` 4 本と `saison_x8` 2 本は請求月が `NOT_FOUND`**。`billingRule` の `scanRows` の正規表現が `お支払日\s+(20\d{2})-…` で、Excel の日付セルの正準形 `yyyy-MM-dd` にしか合わない。
  - 全テスト（1753 本）で赤になるのは 3 本だけで、すべて `smbc_family_csv` の衝突（§2 の 4）。
- 本節の 3 か所の直しと §2 の 4 の扱いを写しで試した結果、33 本すべてで判定・抽出・除外・停止理由・請求月・カード名・件数照合が Excel と一致し、全テストは緑。手元の本物の CSV（三井住友系 1 本、Shift_JIS、7 列）は今のコードでは `UNKNOWN_CARD_FORMAT`、直すと `smbc_family_x7` で全件読めた。

## 2. 決めたこと

1. **形式はファイルの種類で分けない。**CSV と Excel は同じ明細の別の器である。`matchesFileType` は種類が `csv`・`xlsx` なら形式によらず真。形式定義 E 列は書き換えず、記録として残す（版やハッシュに触らない）。
2. **文字列の日付を数値セルと同じに読む。**数字だけの 6 桁は `YYMMDD`、5 桁は Excel シリアル。シリアルは 2000-01-01（36526）〜2099-12-31（73050）に限る（範囲外は今までどおり読めない）。数字 4 桁以下と 7 桁は今までどおり読めない。
3. **請求月は、元の文字で試してから、日付を `yyyy-MM-dd` へ寄せた文字で試す。**順は必ずこの順。今まで合っていた正規表現の結果を変えない。
4. **`smbc_family_csv` を退役させる。**幅の上限が無いので、絞りを外すと 7 列で `smbc_family_x7` と、8 列以上で `smbc_family_x8` などと同時に当たる。8 列の明細を G 列の用途で読む危険があるが、同時に当たれば `AMBIGUOUS` で止まるので黙って誤読はしない。7 列の読み方は `smbc_family_x7` と同じなので、本番では無効にする（運用関数を用意し、許可を得て実行）。
5. **読むだけの診断を作る。**本物の CSV を見ずに本番へ入れない（手書きの標本で実機と食い違った過去がある）。顧客フォルダの明細を読んで、カードごとに判定の結果と、読めない項目の件数を返す。取引の中身（店名・金額・用途・日付）は出さない。
6. **同じ月の CSV と Excel が両方あっても二重転記しない。**コードは変えず、テストで固定する。取引同一性ハッシュは解釈後の日付・金額・店名だけで作るので一致し、内容ハッシュはシート名を含むので違う。よって `checkPurposeRevisionCandidate` が候補にして要確認へ回す。
7. **変えないもの：**取引 ID の作り方、内容ハッシュの材料、`readFile`、`parseCsv`、形式定義の行、画面、形式名（「…Excel（…）」のまま）。`FILE_TYPE` の分岐（`formatGap_`・`explainFormatVerdict_`・`81`）は消さない（読めない種類のときだけ意味を持つ）。

## 3. 変更の中身

### 3.1 `src/13_CardDetector.gs`

`matchesFileType` だけを変える。呼出し側の形を変えないよう引数は残す。

```js
/**
 * CSV と Excel は同じ明細の別の器なので、形式は種類で分けない（2026-11-01）。
 * E列は記録として残す。読めない種類だけ落とす。
 */
function matchesFileType(formatRow, fileType) {
  var kind = String(fileType || '').toLowerCase();
  return kind === 'csv' || kind === 'xlsx';
}
```

### 3.2 `src/24_Parser_Generic.gs` の `interpretDateExpression`

文字列の経路で、8 桁の `YYYYMMDD` の照合の直後に足す。`checked` を通すので範囲の検査は数値の経路と同じになる。**`Number(text)` を経由して `interpretCompactNumericDate_` へ渡してはならない**（`050101` の先頭の 0 が消えて 5 桁になる）。

```js
  // CSV ではどのセルも文字で来る。数値セルの `YYMMDD`（イオン系）と同じに読む。
  match = text.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (match) return checked(2, Number(match[1]), Number(match[2]), Number(match[3]));
  // Excel の日付シリアルも文字で来る（JAL 系・オリコ）。数値セルと違い文字列は
  // 日付以外の 5 桁もあり得るので、2000〜2099 年に当たる値だけを日付と読む。
  if (/^\d{5}$/.test(text) && Number(text) >= CSV_SERIAL_MIN_ && Number(text) <= CSV_SERIAL_MAX_) {
    var serial = interpretDateExpression(Number(text));
    serial.rawText = rawText;
    return serial;
  }
```

定数はファイルの上のほうに置く：`var CSV_SERIAL_MIN_ = 36526;`（2000-01-01）、`var CSV_SERIAL_MAX_ = 73050;`（2099-12-31）。

### 3.3 `src/24_Parser_Generic.gs` の `extractBillingYearMonth`

`matched = new RegExp(String(source.pattern)).exec(subject);` を次に変える。`try` の中のままとする。

```js
      var compiled = new RegExp(String(source.pattern));
      matched = compiled.exec(subject) || compiled.exec(billingDateTextsCanonical_(subject));
```

部品（`extractBillingYearMonth` の前に置く）：

```js
/**
 * 文字の中の年つきの日付を `yyyy-MM-dd` へ寄せる。請求月の正規表現は Excel の日付セルの
 * 正準形を前提に書かれており、CSV では同じ日付が `2025/12/27` のまま来る。
 */
function billingDateTextsCanonical_(subject) {
  return String(subject).normalize('NFKC').replace(
    /\d{4}\s?(?:[-\/.]|年)\s?\d{1,2}\s?(?:[-\/.]|月)\s?\d{1,2}日?/g,
    function(text) {
      var parsed = interpretDateExpression(text.replace(/\s/g, ''));
      if (!parsed.ok || parsed.yearDigits !== 4) return text;
      return parsed.year + '-' + ('0' + parsed.month).slice(-2) + '-' + ('0' + parsed.day).slice(-2);
    });
}
```

### 3.4 `opsRetireSmbcCsvFormat(apply)`（`src/97_Ops.gs`、新規）

`opsDisableAeonX8` の後に置く。`loadSettingsFromProperties()` から始める。

1. `loadFormatDefinitions({formatId: 'smbc_family_x7', status: 'active', enabled: true})` のうち `valid === true` が 1 行も無ければ、書かずに `{applied: false, stoppedBy: 'X7_NOT_ACTIVE', activeVersions: <下の値>, disabledVersions: []}` を返す。
2. `loadFormatDefinitions({formatId: 'smbc_family_csv', enabled: true})` の版を `activeVersions` に入れる。
3. `apply !== true` なら `{applied: false, stoppedBy: null, activeVersions, disabledVersions: []}` を返す（`'true'` などでは書かない）。
4. `disableCardFormat_('smbc_family_csv', 'UNIFIED_WITH_SMBC_X7', activeUserEmail_())` を呼び、`{applied: true, stoppedBy: null, activeVersions, disabledVersions}` を返す。もう一度実行しても何も起きない（`disabledVersions: []`）。

戻す前に `Logger.log(JSON.stringify(...))` する（ほかの運用関数と同じ）。

### 3.5 `opsDiagnoseCustomerFolder(nameFragment, options)`（`src/97_Ops.gs`、新規）

読むだけ。`opsSetCustomerNamesFromFolders` の部品（`customerNameInspectFolder_` など）の後に置く。監査ログも、マスターも、顧客のファイルも書かない。Excel の読取は `readFile` が作業用の一時ファイルを作って消すが、顧客のフォルダには作らない。

- `nameFragment`：顧客フォルダ名の一部。空なら Drive を読まず `stoppedBy: 'NAME_REQUIRED'`。
- `options.timeBudgetMs`：既定 270000。`opsSetCustomerNamesFromFolders` と同じ時計・同じ扱い（非数は既定、負は 0）。
- `options.skip`：調べる対象のファイルを先頭から何本飛ばすか。既定 0。
- `options.folderId`：候補が複数のとき 1 つを選ぶ。候補の中に無い ID は `CUSTOMER_FOLDER_NOT_FOUND`。

**手順：**

1. `CUSTOMER_ROOT_FOLDER_ID` を読み前後の空白を除く。空なら `stoppedBy: 'ROOT_NOT_CONFIGURED'`。
2. 共通フォルダの子（個人・法人）の子を全部見て、名前が `nameFragment` を含むものを候補にする。比べるときは両方を NFKC にして空白（全角・半角）を除く。0 件は `CUSTOMER_FOLDER_NOT_FOUND`。2 件以上で `options.folderId` が無ければ `CUSTOMER_FOLDER_AMBIGUOUS` で `candidates: [{id, path}]`（`path` は `['個人', '顧客名']` の形）を返し、中は読まない。
3. 顧客フォルダから下を、名前の順にたどる（深さは 8 段まで、9 段目は見ない）。フォルダごとにファイルを名前の順に並べ、拡張子が `.csv`・`.xlsx`（大小区別なし）のものを対象にする。ほかは拡張子ごとに `ignored` で数える（拡張子なしは `(なし)`）。**ファイルの順は決まっていること**（`options.skip` の続きが同じ物を指す）。
4. 対象のファイルごとに、始める前に時間予算を確かめる。超えていたら `stoppedBy: 'TIME_BUDGET'`、`nextSkip` に「次に調べる本の番号」（`options.skip` を含む通し番号）を入れて止める。
5. 1 ファイルの調べ方（`diagExamineFile_`）：
   1. `readFile(id, name, {expectedKeywords: detectionKeywordUnion_(usable)})`（`usable` は `loadFormatDefinitions({status: 'active', enabled: true})` の `valid === true`。1 回の実行で 1 度だけ読む）。例外は `status: 'READ_FAILED'`・`code`（`error.code` か `error.name`）で記録して次へ進む。
   2. シートごとに `detectFormatWith`、まとめて `aggregateSheetDetections`（`origin: 'DISCOVERY'`、`sourceId` はファイル ID）。`status` はそのまま報告に入れる。`candidates` は全シートの候補の `formatId`（重複なし）。
   3. `RESOLVED` なら、解決したシート（CSV は 1 枚目）を `parseFile`（`{customerId: 'DIAG', fileId, fileNameOriginal}`）で読み、`extractBillingYearMonth` の `status` と次の件数を入れる：`txCount`、`purposeBlank`（`purpose === ''`）、`dateUnreadable`（`dateUnreadable === true`）、`amountUnreadable`（`amountBillingJpy === null`）、`merchantBlank`（`merchantOriginal` が空白だけ）、`excluded`（`excludedRows.length`）、`stopReason`。例外は `status: 'PARSE_FAILED'`・`code`。
   4. それ以外（`RESOLVED` でない）は、行の多いシートについて `nearest`（`formatNearest_(usable, sheet, fileType, {})` の先頭 3 件の `{formatId, stage, width}`）と `shape`（下）を入れる。
6. `shape` は先頭 12 行。行ごとに、セルを `''`（空）・`D`（`Date` または `interpretDateExpression` が読める）・`N`（`number` または `interpretAmountCell` が読める）・`T`（ほか）へ分類する。**行末の空を除いて `T` だけの行で、「様」を含むセルが無い行に限り**、`{row, cells: [...]}`（行末の空は `cells` に入れない） の `cells` を見出しの文字にする（NFKC、数字は `9` に置換、1 セル 16 文字まで）。それ以外の行は `{row, kinds: 'D|T|N|…'}` だけ。取引の行の中身を出さないため。
7. 戻り値：

```js
{
  stoppedBy: null,          // ROOT_NOT_CONFIGURED・NAME_REQUIRED・CUSTOMER_FOLDER_NOT_FOUND・
                            // CUSTOMER_FOLDER_AMBIGUOUS・TIME_BUDGET
  customerFolder: {id: '…', path: ['法人', '…']},
  candidates: [],
  nextSkip: null,
  counts: {folders: 0, examined: 0, ignoredFiles: 0, byStatus: {}, byFormat: {}},
  csvOnlyFormats: [],       // 有効な形式のうち E 列が csv だけのもの（衝突の確認用）
  folders: [{path: ['2026年度', '経費', 'クレカ明細', 'カード名'], ignored: {}, files: [
    {name: '…', fileType: 'csv', size: 0, encoding: 'Shift_JIS', rows: 0,
     status: 'RESOLVED', formatId: '…', formatVersion: 1, candidates: ['…'],
     billing: 'RESOLVED', txCount: 0, purposeBlank: 0, dateUnreadable: 0,
     amountUnreadable: 0, merchantBlank: 0, excluded: 0, stopReason: '…'}
  ]}]
}
```

`folders` には対象のファイルか `ignored` があるフォルダだけを入れる。`path` は顧客フォルダより下の名前。`Logger.log(JSON.stringify(report))` してから、素の物にして返す（`JSON.parse`）。件数の辞書は原型なしで作るので、そのまま返すと実行 API の戻り値に載らない恐れがある。Drive の項目の名前は並べ替えの前に 1 回だけ読む。

### 3.6 診断の読む範囲（1.2 の変更。§3.5 の手順 3 を置き換える）

発端：利用者の指示「読むのは当事業年度のみで、その配下にある経理フォルダ → クレカ明細（若干の名称違うことあり）フォルダ内のみ。過年度フォルダ等、当事業年度以外のフォルダは読まなくていい」。1.1 は顧客フォルダの下を全部読むので、明細以外のファイルの文字だけの行が報告に出る恐れがあった。

**読むのは次の道の先だけ：**顧客フォルダ → 当事業年度フォルダ → 経理フォルダ → 明細フォルダ（この下の各カード）。顧客フォルダ直下のファイル、当事業年度以外のフォルダ、経理以外のフォルダ、明細フォルダ以外のフォルダは、ファイルの一覧も取らない。

候補の選び方（どの段も「子フォルダの中から 1 つ」で、候補の外の ID は選べない）：

1. **当事業年度：**名前の付け方が決まっていないので自動では選ばない。`options.yearFolderId` が顧客フォルダの子の ID と一致すれば進む。無い、または一致しなければ `stoppedBy: 'YEAR_FOLDER_REQUIRED'`、`folderChoices: {level: 'year', choices: [{id, name}]}` を返して止まる（名前の順。子フォルダの名前のほかは何も読まない）。
2. **経理：**当事業年度の子のうち、名前（`diagNameKey_` を通す）が `経理` か `経費` を含むもの。ちょうど 1 つなら進む。`options.accountingFolderId` があれば、子の ID と一致するものを選び、名前の条件は見ない（一致しなければ止まる）。決まらなければ `stoppedBy: 'FOLDER_UNCLEAR'`、`folderChoices: {level: 'accounting', choices: [...]}`（子全部）。
3. **明細：**経理の子のうち、名前が `クレカ` か `クレジット` か `カード` を含むもの。ちょうど 1 つなら進む。`options.statementFolderId` の扱いと止まり方は 2 と同じ（`level: 'statement'`）。

止まるときはファイルを 1 本も読まず、`usable` の読込（マスターの読取）もしない。`counts` は 0 のまま、`customerFolder` は入れる。進むときは `report.statementFolder = {id, path}`（`path` は顧客フォルダより下の名前 3 つ）を入れ、明細フォルダから下を今までの `visit` でたどる。`folders[].path` は `statementFolder.path` の続きとする（§3.5 の例と同じく顧客フォルダより下の名前）。深さの数え方は明細フォルダを 0 段とする（8 段まで、9 段目は見ない）。

`options.skip`・`options.timeBudgetMs`・`nextSkip`・`options.folderId` と、1 ファイルの調べ方は変えない。フォルダをたどる間の時間の確認は足さない（読む範囲がカードの数だけになるので要らない）。

`stoppedBy` の値に `YEAR_FOLDER_REQUIRED`・`FOLDER_UNCLEAR` を足す。戻り値に `statementFolder: null`・`folderChoices: null` を足す。

### 3.7 「資料共有」の段と Excel（1.3 の変更）

発端：本番の診断の 1 回目で、1 人目の顧客の階層は 顧客フォルダ → 「資料共有」を含むフォルダ → 当事業年度 → 経費 → 明細 と分かった。§3.6 は 1 段少なく、そのままでは `経費` の下を全部読むしかない。また作業フォルダ（`PARALLEL_WORK_FOLDER_ID`）が未設定で、Excel の一時ファイルが顧客と共有のフォルダに出る。

1. **資料共有の段：**顧客フォルダの子のうち、名前（`diagNameKey_` を通す）が `資料共有` を含むものがちょうど 1 つなら、そこへ 1 段下りてから §3.6 の 3 段を選ぶ。`statementFolder.path` と `folders[].path` の先頭にその名前が入る。0 件なら今までどおり。2 件以上なら下りず、顧客フォルダの子の中から当事業年度を選ぶ段で止まる（§3.6 の 1。下りる先を推測しない）。
2. **Excel：**`SETTINGS.PARALLEL_WORK_FOLDER_ID` が空なら `xlsx` は読まない。`status: 'EXCEL_NOT_READ'`・名前・`fileType`・`size` だけを返し、次のファイルへ進む。設定されていれば今までどおり読む。
3. **読まないファイルの種類：**本番の診断で、明細フォルダの 76 本のうち 75 本に拡張子が無いと分かった。`csv`・`xlsx` 以外のファイルについて、戻り値の `ignoredTypes` に MIME ごとの `{count, sampleName}` を入れる（`sampleName` は並べ替えで最初に出会った名前）。中身は読まない。

## 4. テスト（`test/phase6-csv-excel-same.test.js`、新規）

実在の店名・人名・ID・カード番号を書かない。実サンプルの値を写さない。`csvx 9` だけ `test/fixtures/samples/` を読む（手元専用。`phase6-real-samples.test.js` と同じ読み方）。

- **csvx 1：**`matchesFileType` は E 列が `['xlsx']`・`['csv']`・`['csv','xlsx']` のどれでも `csv`・`xlsx`（大文字も）で真、`pdf`・`''`・`null` で偽。
- **csvx 2：**E 列が `['xlsx']` の形式が、架空の CSV の見た目の行（全部文字列・行の長さ不揃い）に当たる。E 列が `['csv']` の形式が Excel の見た目の行（`Date`・`number`・矩形）に当たる。
- **csvx 3（6 桁）：**`'251130'` と `251130` の `interpretDateExpression` が一致（`rawText` も）。全角の数字も読める。`'050101'` は `yearDigits: 2`・5 月…ではなく **年 5・1 月 1 日**（先頭の 0 が消えない）。`'251330'`・`'250032'`・`'202512'`・`'000000'` は読めない。
- **csvx 4（5 桁）：**`'45992'` と `45992` が年月日まで一致。`'36525'`・`'73051'`・`'12345'`・`'99999'` は読めない。`'36526'` は 2000-01-01、`'73050'` は 2099-12-31。4 桁・7 桁は読めない。
- **csvx 5（今までの読み方）：**`'2025/12/1'`・`'20251201'`・`'25/12/01'`・`'12/1'`・`'12月1日'`・`Date`・数値の結果が変わらない。
- **csvx 6（請求月）：**`今回のお支払日` の型の規則で、見出しが `Date` セル・`'2025/12/27'`・`'2025-12-27'`・`'2025年12月27日'`・全角の数字のどれでも同じ年月になる。
- **csvx 7（順番）：**`/` を前提に書いた規則は、元の文字に当たった結果のまま（寄せた文字で別の値にならない）。日付でない数字の並び（`1234-56-78`）を寄せない。
- **csvx 8（衝突）：**`smbc_family_csv` が有効のまま 7 列・8 列の明細を判定すると `AMBIGUOUS` で止まり、`RESOLVED` にならない。無効にすると 7 列は `smbc_family_x7`（用途 G）、8 列は `smbc_family_x8`（用途 H）で読める。
- **csvx 9（実サンプル）：**`phase6-real-samples.test.js` の `EXPECTED` の全本を §1 の変換で CSV の見た目にして、判定結果、`parseFile` の全取引の `dateHashKey`・`dateYearDigits`・`dateUnreadable`・`amountBillingJpy`・`merchantOriginal`・`purpose`・`currencyOriginal`・`amountOriginal`・`exchangeRate`・`sourceRow`、`excludedRows` の数、`stop.reason`、`extractBillingYearMonth`、`resolveCardName`、`verifyCountsAndTotals` が Excel と一致する。実サンプルの値はテストに書かず、失敗の文に値を出さない（項目名と本の名前だけ）。
- **csvx 10（取込の端から端まで）：**E 列が `['xlsx']` の形式を、Shift_JIS の CSV のバイト列で `importRun` まで通す。転記先の日付・金額が、同じ内容の Excel の見た目の取込と一致する。
- **csvx 11（二重転記）：**同じ明細を Excel → CSV の順で取り込む。2 本目は転記先の行を増やさず、`PURPOSE_REVISION_CANDIDATE` の要確認になる。CSV → Excel の順も同じ。
- **csvx 12（退役）：**`opsRetireSmbcCsvFormat()` は読むだけで何も書かない。`true` で `smbc_family_csv` の有効な版だけ無効（`smbc_family_x7` は有効のまま、監査 1 行）。`'true'` では書かない。2 回目は `disabledVersions: []`。`smbc_family_x7` が無ければ `X7_NOT_ACTIVE` で書かない。
- **diag 1：**`CUSTOMER_ROOT_FOLDER_ID` が空 → `ROOT_NOT_CONFIGURED`。`nameFragment` が空 → `NAME_REQUIRED`。どちらも Drive を読まない。
- **diag 2：**見つからない → `CUSTOMER_FOLDER_NOT_FOUND`。全角半角・空白の違いで見つかる。個人と法人の 2 つに当たる → `CUSTOMER_FOLDER_AMBIGUOUS`・`candidates`、中のファイルを読まない。`options.folderId` で 1 つ選べる。候補の外の ID は `CUSTOMER_FOLDER_NOT_FOUND`。
- **diag 3：**共通 → 法人 → 顧客 → 年度 → 経費 → クレカ明細 → カード → CSV の階層をたどる。別の顧客のフォルダは読まない。`.pdf` 等は `ignored`。深さ 9 段目は見ない。
- **diag 4：**読める CSV → `RESOLVED`・各件数が実際の行と一致（用途の空・読めない日付・読めない金額を混ぜる）。`counts.byStatus`・`byFormat`。
- **diag 5（中身を出さない）：**形式不明の CSV → `nearest`・`shape`。見出しの行は `cells`、取引の行は `kinds` だけ。戻り値の `JSON.stringify` に、架空の店名・金額・用途・「様」の氏名・カード番号の数字が含まれない。`RESOLVED` の報告にも含まれない。
- **diag 6：**1 本が読めなくても（壊れた CSV）`READ_FAILED` で次へ進む。
- **diag 7：**時間予算で `TIME_BUDGET`・`nextSkip`。`options.skip` で続きから調べ、2 回で全本を過不足なく調べる。
- **diag 8：**書かない。実行の前後でマスターの全シートの値・監査ログが同じ。セルの書込回数 0。
- **diag 16（読む範囲）：**顧客フォルダの直下・過年度フォルダ・当事業年度の経理以外のフォルダ・経理の明細以外のフォルダに CSV を置く。どれも読まれず（`readFile` の呼出しに出ない）、報告にも名前が出ない。明細フォルダの下の 2 カードの CSV だけ読む。
- **diag 17（当事業年度）：**`yearFolderId` が無い・候補の外 → `YEAR_FOLDER_REQUIRED`、`folderChoices` に顧客フォルダの子の名前だけ。ファイルを読まず、子フォルダの中も見ない。
- **diag 18（名前の揺れ）：**`経費`・`経理部`・`クレジットカード明細`・`カード明細`・全角半角の違いで進む。
- **diag 19（決まらないとき）：**経理・明細の候補が 0 件または 2 件 → `FOLDER_UNCLEAR`・`level`・`choices`、ファイルを読まない。`accountingFolderId`・`statementFolderId` で 1 つ選べて、名前が条件に合わなくても進む。候補の外の ID では止まる。
- **diag 20（続きから）：**範囲を絞っても `skip`・`nextSkip` が今までどおり効く。
- **diag 21（資料共有の段）：**資料共有の下に年度があるとき、年度が無ければ資料共有の子を候補に止まり、年度があれば明細の下だけ読む。顧客フォルダ・資料共有・過年度のファイルは読まない。
- **diag 22（資料共有が 2 つ）：**下りずに `YEAR_FOLDER_REQUIRED` で止まり、ファイルを読まない。
- **diag 23（Excel）：**作業フォルダが空なら `EXCEL_NOT_READ` で読まず、隣の CSV は読む。設定すれば読む。`diag 10` は Excel を読むので作業フォルダを設定する。
- **diag 24（読まないファイルの種類）：**`ignoredTypes` に MIME ごとの本数と名前の例だけが入り、中身は出ず、`__proto__` のような MIME でも数えられる。

§3.6 に合わせ、既存の diag の Drive の世界は 当事業年度 → 経理 → クレカ明細 の形に直してよい。`assert` の意味は変えない。`diag 3` の深さは明細フォルダから数える。

既存のテストで変えてよいのは次の 3 か所だけ：

1. `test/phase6-real-samples.test.js` の `setup()` の `gas.call('installSmbcCsvFormat', []);` を消す。
2. `test/phase6-format-batch1.test.js` の `setup()` の `gas.call('installSmbcCsvFormat', []);` を消す。
3. 同じファイルの `FAMILIES` の先頭の `expect: 'smbc_family_csv'` を `expect: 'smbc_family_x7'` にする（CSV は `smbc_family_x7` で読むようになった）。

## 5. 変異（R1〜R30）

入れたら赤になること。

- R1：`matchesFileType` を元に戻す
- R2：`matchesFileType` が `xlsx` だけを通す
- R3：`matchesFileType` が常に真（`pdf` も通す）
- R4：6 桁を `interpretCompactNumericDate_(Number(text), rawText)` で読む（先頭の 0）
- R5：6 桁の分岐を消す
- R6：5 桁の分岐を消す
- R7：シリアルの下限を外す
- R8：シリアルの上限を外す
- R9：5 桁の `rawText` を上書きしない（全角で差が出る）
- R10：請求月の再試行を消す
- R11：請求月の順を逆にする（寄せた文字を先に試す）
- R12：`billingDateTextsCanonical_` の `yearDigits !== 4` の確かめを外す
- R13：`billingDateTextsCanonical_` の NFKC を外す
- R14：`opsRetireSmbcCsvFormat` の `apply === true` の確かめを緩める
- R15：`opsRetireSmbcCsvFormat` の `X7_NOT_ACTIVE` の確かめを外す
- R16：診断が候補複数でも先頭を読む
- R17：診断の見出しの条件から「様」の確かめを外す
- R18：診断の見出しの条件を「`T` が 1 つでもあれば」に緩める（取引の店名が出る）
- R19：`nextSkip` を 1 つずらす
- R20：`READ_FAILED` で止まる（次へ進まない）
- R21：`yearFolderId` が無いとき先頭の子を選ぶ
- R22：`yearFolderId` が候補の外でも `getFolderById` で読む
- R23：経理の候補が 2 件のとき先頭を選ぶ
- R24：明細の候補が 2 件のとき先頭を選ぶ
- R25：`経費` を候補から外す
- R26：`クレジット` を候補から外す
- R27：顧客フォルダの下を全部たどる（範囲を絞らない）
- R28：止まるときにファイルを読む（`usable` を読む）
- R29：`folderChoices` に子フォルダの中のファイル名を入れる
- R30：`accountingFolderId` が候補の外でも進む
- R31：資料共有の段を下りない
- R32：資料共有が 2 件のとき先頭へ下りる
- R33：作業フォルダが空でも Excel を読む
- R34：作業フォルダがあっても Excel を読まない
- R35：`EXCEL_NOT_READ` で次のファイルへ進まない
- R36：`ignoredTypes` の本数を増やさない
- R37：`ignoredTypes` の辞書を原型ありにする

## 6. 本番での実行（私が行う。利用者の許可を得てから）

1. push の前に `clasp pull` で実機と git の一致を確かめ、push 後にもう一度確かめる。
2. push の直後に `opsRetireSmbcCsvFormat()`（読むだけ）→ 許可を得て `opsRetireSmbcCsvFormat(true)`。**この間は記帳しない**（三井住友系が `AMBIGUOUS` になる。誤読はしない）。
3. 日付の読み方に触るので `releaseGateReport` を実機で流す。
4. `opsDiagnoseCustomerFolder('<1 人目の顧客の名前>')` を読むだけで実行し、`folderChoices` のフォルダ名から当事業年度を確かめる。次に `{yearFolderId: '<当事業年度の ID>'}` を渡して実行し、カードごとの結果を利用者に見せる。Excel は作業フォルダを設定するまで `EXCEL_NOT_READ` のまま読まない（§3.7）。
5. 結果を見て、足りない読み方と本番の顧客の登録の入口を決める。

## 7. 受入

- 1 人目の顧客の実物の CSV で、§6 の 4 の `RESOLVED` の割合と読めない項目の件数を確かめる。
- 記帳はテスト顧客のカードで CSV を 1 本通し、転記シートの日付・金額・用途が Excel のときと同じ形で入ることを利用者が見る。

## 8. 監査の記録（2026-11-01）

- 実装は Codex 1 回（1753 → 1779、R1〜R20 すべて赤。R12 は通常の入力で差が出ないので `csvx 7b` を足した）。`src` の差分は 13・24 が §3 のとおり、97 は既存のバイト列が不変で追記だけ。
- 実際の状態名：衝突は `AMBIGUOUS_CARD_FORMAT`、複数シートは `MULTI_SHEET_AMBIGUOUS`。同じ月の 2 本目は `REVIEW_WAIT`・`NO_WRITE`・転記 0 行、コード `PURPOSE_REVISION_CANDIDATE`、要確認の種別 `DUPLICATE`（両方の順で確認）。
- 監査の直し 3 つ（診断だけ）：(1) 行末の空があると見出しを型でしか出さなかった。Excel の行は表の外まで空で埋まるので、形式不明のファイルほど手掛かりが消える（§3.5 の 6、`diag 10` の期待も改めた、`diag 13`）。(2) 戻り値が原型なしの辞書を含んでいた（`diag 14`）。(3) 並べ替えの比較のたびに Drive へ名前を聞いていた（`diag 14`）。
- 変異を 25 個足して回し、すり抜けた 3 個（読めない金額に 0 円を数える・「様」を 1 列目だけ見る・`csvOnlyFormats` に兼用の形式を入れる）を `diag 15` で赤にした。終了時 1782/1782。
- 請求月の 0 埋めの変異は `csvx 9`（手元の実サンプル）でだけ赤になる。
- 1.2 の実装は Codex 1 回（1782 → 1787、R21〜R30 すべて赤）。`src` の差分は `opsDiagnoseCustomerFolder` と部品 `diagChooseChildFolder_` だけ。ID の空文字は「未指定」でなく「不一致」として止める（`null`・`undefined` は未指定）。監査で変異を 20 個足し、18 個は赤。すり抜けた 2 個のうち「空文字を未指定にする」は `diag 19` で赤にした。「同じ名前の子の ID の順を外す」は候補の表示順だけで選び方に効かないので残した。`diagSortedEntries_` を使い回さないのは、名前を 1 回だけ聞く決まりを保つため。
- 1.3 の実装は小さな直しなので Claude Code が直接行った（1787 → 1790、R31〜R35 と追加の変異 4 つすべて赤）。資料共有の有無を見るので顧客フォルダの子を 2 回一覧する（`diag 17`・`diag 19` の期待に足した。読むフォルダの範囲は変わらない）。`diag 9`・`diag 10` は Excel を読むので作業フォルダを設定する。

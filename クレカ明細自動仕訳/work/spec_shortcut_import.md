# ショートカットの明細を取込で読む 仕様書（(d) の第 2 段）

版：1.0（2026-11-07。§9 に監査の記録）
対象：`src/12_FileReader.gs`・`src/10_DriveScanner.gs`・`src/71_RunOrchestrator.gs`・`src/70_ImportFlow.gs`・`src/61_TransactionLog.gs`・`src/80_WebApp.gs`・`src/81_WebAppUi.html`・`src/06_ErrorCatalog.gs`。
前提：第 1 段（`work/spec_google_sheets_import.md`。Google スプレッドシートを Excel と同じに読む。gas-push-134、11-07 受入合格）。

**実名をこの文書・コード・テスト・コミットに書かない。**このリポジトリは公開である。

## 1. 背景

- 1 人目の顧客の当事業年度の明細フォルダには、明細のショートカットが 23 本ある（診断 1.4、11-03）。**23 本とも前年度の決算フォルダ**（過年度分の決算の中の、1・2 月引落分のカード別フォルダ）を指す。名前は指す先と同じで、`【済】…` 16 本と `【翌年分】…` 7 本。
- 指す先の内訳：Google スプレッドシート 21・フォルダ 1・PDF 1。フォルダの 1 本の中身は、別の 2 本のショートカットが指すのと同じ 2 ファイルと PDF 2 である。同じ指す先を 2 本のショートカットが指すもの、指す先が当事業年度のフォルダにも普通のファイルとして置かれているものは無い。
- 今の取込はショートカットを名前によらず拾わない（第 1 段 §2）。`readFile` も拒む。
- 利用者の決定（2026-11-02・11-06）：
  1. ショートカットは**全部読む**（【済】も【翌年分】も）。
  2. **利用日が前年のものは除外する。**細部は私の案 (1)〜(4) のとおり（11-06 夜「よい」）：(1) 除外はショートカットの指す先だけに掛け、当事業年度の明細フォルダの普通のファイルは今までどおり。(2)「前年」＝当事業年度が始まる年より前の利用日。(3) 年の読めない日付は除外せず今までどおり要確認。(4) 除外した件数は取込の結果と取引ログに残し、件数照合で合わなくならないようにする。
  3. 【済】などの印は**ショートカットの名前にだけ**付け、前年度のフォルダのファイルには触らない（同一性＝ショートカットの ID）。
- 今の前年分の検査（`30` の `checkPriorYearUsage`）は個人だけ前年の利用を要確認（`PRIOR_YEAR`）に回し、法人は何もしない。決定 2 の「除外」はこれと違う動き（転記も要確認もしない）。エラーの一覧（`06` の `PRIOR_YEAR_USAGE_DATE`）には「システムは自動で取引を除外しない」とある。**この原則を外すのはショートカットから読んだ明細だけ**である。

## 2. 段の分け方

- 第 1 段（済）：明細フォルダに直に置いた Google スプレッドシート。
- **第 2 段（本書）：**Google スプレッドシートを指すショートカット。前年の利用日の除外。
- 第 3 段（別の仕様書）：足りない形式・「仕入れ専用」・家族カードの会員見出し行。

## 3. 決めたこと

1. **同一性はショートカットの ID。**処理ログ・恒久ファイルインデックス・取引 ID の材料・リース・要確認・名前の付け替えは全部ショートカットの ID で持つ。中身は指す先から読む。**指す先には何も書かない**（`setName` も含めて、指す先の `File` の変更系を 1 つも呼ばない）。名前の付け替え（`11` の `updateFilePrefix`）は ID のファイルの名前を変えるので、同一性をショートカットに置けば今のコードのままでショートカットの名前だけが変わる。
2. **取込の対象は、指す先が Google スプレッドシートのショートカットだけ。**指す先が CSV・Excel・PDF・フォルダ・ほかの種類、または指す先の種類が分からないものは対象外（画面の一覧で「対象外」）。判定は `isImportableDriveFile(name, mimeType, targetMimeType)`（`12`）に第 3 引数を足して行う。ショートカットは `targetMimeType === GOOGLE_SHEETS_MIME_` のときだけ真。ショートカットでないものは第 3 引数を見ない（今と同じ）。
   - **Excel を指すものを対象にしない理由：**変換の一時ファイル（`convertXlsxToTemp`）は、作業フォルダ（`PARALLEL_WORK_FOLDER_ID`、本番は未設定）が無いと**元のファイルの親フォルダ**にできる（Drive の copy は親を指定しないと元の親を継ぐ）。指す先の親は前年度の決算フォルダで、決定 3 に反する。CSV は名前で種類を決めているが、ショートカットの名前と指す先の名前が同じとは限らない。実物の読める 21 本は全部 Google スプレッドシートなので、要るものが出てから別の段で足す。
   - **フォルダのショートカットは中へ下りない。**中のファイルの ID は前年度のフォルダのファイルそのものなので、取り込めば名前の付け替えが前年度のフォルダに及ぶ（決定 3 に反する）。実物の 1 本は、中の明細 2 本を別のショートカットで読むので取りこぼしは無い（PDF はもともと読まない）。走査（`listFilesRecursively_`）は種類がフォルダのものにしか下りないので、今のままで下りない。
3. **10 分の待ちは指す先の変更日時で見る。**中身の編集はショートカットの変更日時を動かさない（動くのは指す先の変更日時）。
   - 走査（`scanUnprocessedFiles`）：`driveListPage_` の `fields` に `shortcutDetails(targetId,targetMimeType)` を足す。種類と状態の絞りを通ったショートカットだけ、指す先の `id,modifiedTime,headRevisionId` を `Drive.Files.get(targetId, {fields, supportsAllDrives: true})` で 1 本 1 回取る（`driveScannerCallCount_` に数える。429・500・503 は `driveListPage_` と同じ待ちで 3 回まで再試行）。待ちの判定と候補の `modifiedTime` はこの値。候補に `targetId` を足す。`revisionId` は指す先の `headRevisionId`（Google スプレッドシートは無いので `null`）。
   - 指す先のメタ情報が取れないとき（403・404 など再試行しない失敗）は、ショートカット自身の `modifiedTime` で待ちを判定して候補にする。読取（決定 4）で例外になり `FAILED` として画面に出る。**黙って候補から落とさない。**
   - 状態の絞りで落ちるショートカット（登録済みで `DISCOVERED` 以外）には呼ばない。取込を終えたショートカットは、次の走査から Drive の呼出しを増やさない。
   - 画面の一覧（`80` の `webAppFolderFile_`）も同じ規則：ショートカットなら `supported` は `isImportableDriveFile(name, mime, file.getTargetMimeType())`、待ちの基準は指す先の `getLastUpdated()`（`DriveApp.getFileById(targetId)`。例外ならショートカット自身の値）。一覧と走査で「取込可能」と候補がずれないようにする。
4. **`readFile(shortcutId)` は指す先を読む。**
   - 種類がショートカット：`targetId = file.getTargetId()`、`targetMimeType = file.getTargetMimeType()`。`targetMimeType` が Google スプレッドシートでなければ `TypeError`（指す先を開かない）。指す先の `File` を `DriveApp.getFileById(targetId)` で取り、`isTrashed()` が真なら `makeCatalogError_('SHORTCUT_TARGET_TRASHED', …)`（読まない。ゴミ箱の明細は人が消したものなので取り込まない）。そのあとは第 1 段の Google スプレッドシートと同じ道を**指す先の ID で**通る：`googleSheetContentHash_(targetId)` → `SpreadsheetApp.openById(targetId)` → `readSpreadsheetSheets_`。**中身ハッシュが先、値が後**（第 1 段 決定 4）の順を守る。
   - 戻り値：`fileType: 'xlsx'`・`bytes: null`・`encoding: null`・`binaryHash`＝指す先の中身ハッシュ・`sourceKind: 'SHORTCUT'`・`targetId`。ショートカット自身の `getBlob` は呼ばない。
   - ほかの種類は今と同じ（`sourceKind` は `'GOOGLE_SHEET'` か `'FILE'`、`targetId` は付けない）。
5. **`currentFileBinaryHash(shortcutId)` も指す先の中身ハッシュ。**決定 4 と同じ確かめ（種類が Google スプレッドシートでなければ `TypeError`、ゴミ箱なら `SHORTCUT_TARGET_TRASHED`）をしてから `googleSheetContentHash_(targetId)`。番人（`71` の `fetchFileRecord`）と再走査は今のまま `currentFileBinaryHash` を呼ぶので、取込の最中に指す先が書き換わったら `FILE_CHANGED` で止まり、例外なら第 1 段 gs 14 と同じく `FAILED` で転記 0 行。
   - ショートカットの指す先は作った後に変えられない（Drive API の `shortcutDetails.targetId` は作成時だけ指定できる）ので、指す先の ID をハッシュの材料に入れない。
6. **再走査（モード 2）は指す先の変更日時を比べる。**`getFileMetadataBatch` は、求められた ID がショートカットなら、返すメタ情報の `modifiedTime`・`revisionId` を指す先の値にする（決定 3 と同じ呼出し・数え方・再試行。求められたショートカットだけ）。指す先のメタ情報が取れない、または指す先がゴミ箱（`trashed` を `fields` に入れて見る）なら、その ID はメタ情報に入れない（今の「ファイルが無い」＝`FILE_NOT_FOUND` と同じ扱い。ハッシュを取りに行って例外で再走査ごと止めない）。登録時に入れた変更日時（決定 3）と同じものを比べるので、ショートカットの名前の付け替えだけでは中身ハッシュを取り直さない。
7. **前年の利用日の除外（決定 2）。**
   - **掛けるのは `read.sourceKind === 'SHORTCUT'` のときだけ。**普通のファイルは今と 1 つも変わらない（法人は何もしない、個人は `PRIOR_YEAR` の要確認）。
   - **基準の年は顧客マスター AK 列（`customer.fiscalYear`）＝当事業年度が始まる年。**整数 2000〜2999 でなければ、登録（処理ログ・恒久ファイルインデックス・`VALIDATING`）の直後、形式の判定より前に `makeCatalogError_('SHORTCUT_FISCAL_YEAR_REQUIRED', …)` を投げる → 今の例外の道で `FAILED`（転記 0 行・取引ログ 0 行・要確認 0 件・リース解放）。法人で AK が空の顧客（今の TEST01）はショートカットを取り込めない。AK を入れてから、止まったファイルを画面から戻して（K-W12）取り込み直す。
   - **除外する取引：**日付があり（`tx.date`）、空欄化の対象（`blankedDateTransactionIds(yearInference, dateTriage)`）に入っておらず、東京の日付の年が AK より小さいもの。**個人の前年分の検査（`checkPriorYearUsage`）が要確認にするのと同じ集まり**であり、判定は同じ材料・同じ日付の変換（`toTokyoDateString_`）で行う。年の読めない日付（年補完の行単位の不備・日付選別で空欄にする行）は除外せず、今までどおり要確認になる。元の明細に年が書かれていなくても、年補完が一意に決めたものは読めた日付として扱う（`checkPriorYearUsage` と同じ）。
   - **順番（`71` の `processDiscoveredFile_`）：**
     1. 抽出 → 用途補完 → 締め年月・年補完・日付選別（今と同じ）
     2. **件数・合計の照合は除外の前の全取引で行う**（明細に印字された件数・合計と比べるため。除外の後で比べると必ず合わない）
     3. 除外（ショートカットのときだけ）。以下「残り」＝除外しなかった取引
     4. 用途の未解決数（`validation.purposeResolution.unresolvedCount`）を**残りで数え直す**（`resolvePurposes` と同じ「用途が `null`・`undefined`・空文字」の数え方）。除外する取引に用途が無くても、ファイルを要修正（区分 1）にしない
     5. 前年分の検査（`checkPriorYearUsage`）は残りに掛ける（今と同じ呼び方）
     6. **内容ハッシュ（`generateContentHash`）は除外の前の全取引で作る。**ファイルの中身を表すハッシュであり、同じ指す先を 2 本のショートカットや普通のファイルで置いたとき `DUPLICATE_CONTENT` で止めるため。AK を変えても処理ログの提出時点ハッシュ（INV-07）が変わらないようにするためでもある
     7. 取引同一性ハッシュは全取引に付ける（取引ログの列に入る）。用途改訂候補の検査（`checkPurposeRevisionCandidate`・`registerPrepared` の中の再判定）は残りの同一性ハッシュで行う（転記するのは残りだけなので）
     8. 取引先の照合・予定値は残りだけ今と同じに作る。除外する取引は照合しない。予定値は B・I・K・M を残りと同じ規則で作り、F は空、`partnerResolutionStatus` は `RESOLVED_WITHOUT_PARTNER`
     9. `validation.effectiveTransactionCount` は全取引の数のまま（全部除外されても「空のファイル」の要確認にしない）。処理ログの読取件数（R 列）も全取引、除外件数（U 列）は今までどおり形式の除外行の数だけ
     10. `processFile` へ残りを `transactions`、除外する取引を `excludedTransactions` で渡す
   - **除外した取引は取引ログに残す（`70`・`61`）。**区分 3 か区分なし（書込へ進むとき）だけ、残りと同じ `registerPrepared` の 1 回の呼出しで、取引ログと恒久取引インデックスへ登録する。取引ログの状態（J 列）と予定最終状態（K 列）は `CANCELED`、転記先の列（AC〜AE）は空。転記・要確認・読取確認の対象にしない（書込ブロックは取引ログの `PREPARED`・`WRITING` だけを書くので、書かれない）。区分 1・2 のときは今と同じく何も登録しない。
     - 予定最終状態が `CANCELED` の行が自動除外の印である。担当者の「対象外にする」（`REVIEW_REQUIRED`・`COMMITTED` → `CANCELED`）は予定最終状態が `CANCELED` にならないので見分けがつく。
     - 最終確認（`80` の `finalReviewReconcile_`）は取引ログから作るので、コードを変えずに「明細の利用金額」に全取引、「除外した分」に除外した取引の金額が入り、差額 0 で「一致」になる。全部除外したファイルも、取引ログに行があるので表に出る（転記 0 円・一致）。
     - 恒久取引インデックスの行は、担当者の「対象外にする」と同じく有効のまま残す（後で同じ取引を含む明細が来たら、用途改訂候補として要確認に回る ── 安全側）。
     - **再合流：**既存行の照会（`activeTransactionRecordsByIds_`）に除外する取引の ID も入れる。既に `CANCELED` の行は登録し直さない（今の規則）。**食い違いは止める：**除外する取引に `CANCELED` 以外の有効な既存行がある、または除外しない取引に予定最終状態 `CANCELED` の有効な既存行がある → `IntegrityError('PRIOR_YEAR_EXCLUSION_CONFLICT', …)` で `FAILED`（AK を途中で変えた場合だけ起きる。黙って書く・黙って取り消すのどちらもしない）。この確かめは登録の前、`registerPrepared` を呼ぶ前に行う。
     - 実行単位の件数（`checkRunTransactionLimit`・`incrementRunTransactionCount`）は、登録する行の数（残り＋除外）で数える。
   - **結果に残す：**`processDiscoveredFile_` の戻り値に `priorYearExcluded: {count, fiscalYear}` を足す（ショートカットを読めたときだけ。0 件でも出す）。画面（`81`）の取込の後の知らせに、`count > 0` のファイルごとに `【前年分を除外】<ファイル名>：<fiscalYear − 1> 年以前の利用 <count> 件は転記していません` を足す（今の `customerFixNoticeLines` と同じ場所・同じ並び）。
8. **名前：**元の名前に `【済】` があれば、今の規則（状態の接頭辞を外してから付ける）で `【処理中】…`・`【済】…` などになる。`【翌年分】` は状態の接頭辞ではないので残る（`【済】【翌年分】…`）。用途の補完・締め年月・カード名の材料になる「元ファイル名」はショートカットの名前、カード名の材料になるフォルダ名はショートカットが置かれたカードフォルダの名前（今の `candidate.folderName`）である。
9. **変えないもの：**普通のファイル（CSV・Excel・Google スプレッドシート）の読み方・ハッシュ・前年分の扱い、取引 ID・内容ハッシュ・取引同一性ハッシュの材料、形式の判定と抽出、件数照合の規則、最終確認のコード、診断（`97`）、形式登録（`readFile` を通るので、形式不明のショートカットでも形式診断・試し読み・保存が動く。`19` のコードは変えない）。`97_Ops.gs` は変えない。

**読取の枠：**ショートカット 1 本の取込で Sheets API の読取は Google スプレッドシートと同じ 2 回（読む前と番人）。Drive の呼出しが走査で 1 回、`readFile` と番人で `DriveApp.getFileById` が 2 回ずつ増える（Sheets の読取の枠 60 回/分には入らない）。

## 4. 変更の中身

### 4.1 `src/12_FileReader.gs`

- `isImportableDriveFile(name, mimeType, targetMimeType)`：決定 2。
- `shortcutTarget_(file)`（新規、内部用）：ショートカットの `File` から `{targetId, file}` を返す。指す先が Google スプレッドシートでなければ `TypeError`、ゴミ箱なら `SHORTCUT_TARGET_TRASHED`。`readFile` と `currentFileBinaryHash` が使う。
- `readFile`：決定 4。今のショートカットの `TypeError` を置き換える。
- `currentFileBinaryHash`：決定 5。

### 4.2 `src/10_DriveScanner.gs`

- `driveListPage_` の `fields` に `shortcutDetails(targetId,targetMimeType)`。
- 指す先のメタ情報を取る関数（新規、内部用。再試行と数え方は `driveListPage_` と同じ）。
- `scanUnprocessedFiles`：決定 2・3。`isImportableDriveFile(file.name, file.mimeType, file.shortcutDetails && file.shortcutDetails.targetMimeType)`。候補に `targetId`（ショートカット以外は `null`）。
- `getFileMetadataBatch`：決定 6。
- 冒頭とモード 1 のコメントを直す。

### 4.3 `src/71_RunOrchestrator.gs`

- `processDiscoveredFile_`：決定 7 の AK の確かめ・除外・順番・`excludedTransactions`・`priorYearExcluded`。普通のファイルでは、今と同じ値を同じ順で計算すること（除外が空のときに今と違う呼び方をしない）。

### 4.4 `src/70_ImportFlow.gs`

- `runPreValidationBlock`：`input.excludedTransactions`（無ければ空）を受ける。取引単位の妥当性判定（`validateTransactions`）・区分判定・要確認の橋渡し・予定最終状態の導出は今と同じく `input.transactions`（残り）だけに掛ける。既存行の照会に除外する取引の ID を足す。決定 7 の食い違いの確かめ。区分 3 か区分なしのとき、除外する取引を `priorYearExcluded: true`・`plannedFinalStatus: 'CANCELED'` にして残りと一緒に `registerPrepared` へ渡す。戻り値の `transactions` は残りだけ（今と同じ形）。

### 4.5 `src/61_TransactionLog.gs`

- `makeTransactionRow_`：`tx.priorYearExcluded === true` なら状態（J 列）を `CANCELED` にする（予定最終状態は渡された `CANCELED`）。ほかの取引は今と同じ。

### 4.6 `src/80_WebApp.gs`・`src/81_WebAppUi.html`

- `webAppFolderFile_`：決定 3 の一覧の規則。
- 画面の取込の後の知らせ：決定 7 の `【前年分を除外】`（`81`）。`webAppRunImport` の `fileResults` は `processDiscoveredFile_` の戻り値をそのまま渡しているので、`80` で足すものは無い見込み（足したら報告する）。

### 4.7 `src/06_ErrorCatalog.gs`

- `SHORTCUT_FISCAL_YEAR_REQUIRED`・`SHORTCUT_TARGET_TRASHED`・`PRIOR_YEAR_EXCLUSION_CONFLICT` を、今の項目と同じ形で足す（担当はシステム管理者、再試行は不可、案内は「AK を入れてから止まったファイルを戻す」「指す先をゴミ箱から戻すか、ショートカットを消す」「止まったファイルを取り消して取り込み直す」）。エラーの一覧と設計書の対応を見るテストがあれば、それに従う。

## 5. テスト（`test/phase6-shortcut-import.test.js`、新規。sc 1〜18）

テストの Drive は架空の値だけを使う。代用品（`test/gas-stubs.js`）は足すことだけ許す：`Drive.Files.list` の `shortcutDetails`、`Drive.Files.get`、ショートカットの `File` の `getTargetId`・`getTargetMimeType`（今あるもの）と指す先の `isTrashed`、ショートカットを `getFiles()` で返すこと。指す先は顧客フォルダの**外**のフォルダ（前年度のフォルダを模したもの）に置く。

- **sc 1** `isImportableDriveFile` の表：ショートカット → Google スプレッドシートは真（名前に拡張子なし・`【済】` 付き・名前が `.pdf` でも真）。ショートカット → Excel・CSV・PDF・フォルダ・Google 文書・ショートカット・指す先の種類なし（`null`・空）は偽。ショートカットでないものは第 3 引数によらず今と同じ（第 1 段 gs 1 の表がそのまま通る）。
- **sc 2** 走査：カードフォルダに、Google スプレッドシートを指すショートカット 2 本（`【済】…`・`【翌年分】…`）、フォルダを指すショートカット、PDF を指すショートカット、Excel を指すショートカット、普通の Google スプレッドシート。候補は 2 本のショートカットと普通の Google スプレッドシートだけ。ショートカットの候補の `fileId` はショートカットの ID、`name` はショートカットの名前、`folderName` はカードフォルダの名前、`modifiedTime` は指す先の値、`targetId` は指す先の ID。フォルダのショートカットの中（指す先のフォルダの中の明細）は候補にならない。
- **sc 3** 待ち：指す先が 5 分前に変わりショートカットは 1 日前 → 候補にならない。指す先が 1 日前でショートカットが 1 分前 → 候補になる。登録済みで `COMPLETED` のショートカットには指す先のメタ情報を取りに行かない（`Drive.Files.get` の回数で確かめる）。指す先のメタ情報が 404 → ショートカットの変更日時で候補になる。429 が 2 回続いてから取れる → 指す先の値で判定する。
- **sc 4** `readFile(shortcutId)`：`sheets` は指す先を直に読んだものと一致、`fileType` は `'xlsx'`、`sourceKind` は `'SHORTCUT'`、`targetId` は指す先の ID、`bytes`・`encoding` は `null`、`binaryHash` は `currentFileBinaryHash(shortcutId)` とも `currentFileBinaryHash(targetId)` とも同じ値。**指す先の中身ハッシュの読取が `SpreadsheetApp.openById(targetId)` より先**（呼ばれた順で確かめる）。ショートカットの ID で `openById`・`getBlob` を呼ばない。指す先がゴミ箱 → `SHORTCUT_TARGET_TRASHED` で、Sheets の読取 0 回・`openById` 0 回。指す先が Excel → `TypeError` で指す先を開かない。`currentFileBinaryHash` も同じ 2 つで同じく止まる。
- **sc 5** 取込の通し（法人・AK 2026）：指す先に 2025 年の利用 2 件・2026 年の利用 3 件（日付は年あり）。`runImport` で `WRITTEN`、転記先は 2026 年の 3 行だけ。取引ログは 5 行：3 行 `COMMITTED`、2 行は状態・予定最終状態とも `CANCELED` で転記先の列が空、取引先の状態 `RESOLVED_WITHOUT_PARTNER`。恒久取引インデックスは 5 行。処理ログ・恒久ファイルインデックスの ID はショートカットの ID、バイナリハッシュは指す先の中身ハッシュ、読取件数 5。**ショートカットの名前は `【済】`＋元の名前（接頭辞を外したもの）、指す先の名前は 1 字も変わらず、指す先の `setName` は 1 回も呼ばれない。**戻り値の `priorYearExcluded` は `{count: 2, fiscalYear: 2026}`。要確認 0 件。
- **sc 6** 件数照合：件数と合計の照合の規則を持つ形式で、明細の印字が 5 件・5 件の合計 → `COUNT_TOTAL_MISMATCH` にならない（照合は除外の前）。印字が 3 件・3 件の合計（除外の後の数）→ `COUNT_TOTAL_MISMATCH` になる（除外の後で照合していないことの確かめ）。
- **sc 7** 全部除外：指す先の利用が全部 2025 年 → `COMPLETED`、転記 0 行、取引ログは全部 `CANCELED`、`EMPTY_FILE` の要確認なし、名前は `【済】`。
- **sc 8** 年の読めない日付：(a) 年補完が曖昧で行単位の不備になる行、(b) 日付選別で `OUT_OF_RANGE`・`FUTURE` として空欄にする行は除外せず、今までどおりの要確認になる。(c) 元の明細に年が無く年補完が一意に 2025 年と決めた行は除外する。
- **sc 9** 用途：除外する取引だけ用途が空 → 区分 1 にならず `WRITTEN`。残りに用途の空きがある → 区分 1（要修正）で、`customerFix` の理由に出る行は残りの行だけ。
- **sc 10** 普通のファイルは変わらない：同じ中身を普通の Google スプレッドシートとして置く → 法人では 2025 年の行も転記（今と同じ）。個人（AK 2026）では 2025 年の行は `PRIOR_YEAR` の要確認（今と同じ）で、自動の `CANCELED` は 0 行。
- **sc 11** AK が無い：法人で AK が空 → ショートカットは `FAILED`、エラーは `SHORTCUT_FISCAL_YEAR_REQUIRED`、転記 0 行・取引ログ 0 行・要確認 0 件・リースなし。同じ実行の普通のファイルは今どおり取り込まれる。AK が文字の `'2026'` でも `FAILED`。
- **sc 12** 番人：`readFile` が値を読んだ直後（番人の前）に指す先のセルを 1 つ書き換える → `FILE_CHANGED` で転記 0 行。書き換えずに通したとき、ショートカットの名前の付け替えだけでは `FILE_CHANGED` にならない。番人の時点で指す先がゴミ箱 → 例外で `FAILED`、転記 0 行、リースは解放。
- **sc 13** 再合流：書込の途中で止めた（取引ログに `PREPARED` 3 行・`CANCELED` 2 行がある）ファイルを取り込み直す → 取引ログは 5 行のまま（`CANCELED` を足し直さない）、転記先は 3 行。**食い違い：**(a) 除外する取引に `PREPARED` の既存行がある、(b) 除外しない取引に予定最終状態 `CANCELED` の既存行がある → どちらも `PRIOR_YEAR_EXCLUSION_CONFLICT` で `FAILED`、取引ログの行は増えず、転記 0 行。
- **sc 14** 再走査：取り込んだショートカットの指す先のセルを書き換えて指す先の変更日時を進める → `FILE_CHANGED` の要確認 1 件（ファイル ID はショートカットの ID）。指す先の変更日時だけ進める → 要確認なし。ショートカットの名前だけ変える（指す先は同じ）→ 中身ハッシュを取らない（Sheets の読取 0 回）。指す先をゴミ箱へ → `FILE_NOT_FOUND` と同じ扱いで要確認なし・例外なし。
- **sc 15** 同じ中身が 2 本：(a) 同じ指す先を 2 本のショートカットで置く、(b) 指す先と同じ中身の普通の Google スプレッドシートとショートカットを置く。両方の順で、2 本目は `REVIEW_WAIT`・`DUPLICATE_CONTENT`・`NO_WRITE`・転記 0 行・`DUPLICATE` の要確認 1 件、取引ログは 1 本目の分だけ。
- **sc 16** 画面：一覧で Google スプレッドシートを指すショートカットは、指す先が 10 分たてば「取込可能」で `importable` は真、指す先が 5 分前なら「取込待ち（あと n 分）」。フォルダ・PDF・Excel を指すショートカットは「対象外」。画面の取込（`webAppRunImport`）でショートカットが `WRITTEN`、`fileResults` に `priorYearExcluded`。最終確認（`finalReviewReconcile_`）でそのファイルの行は、明細の利用金額＝5 件の合計、除外した分＝2025 年の 2 件の合計、転記した金額＝3 件の合計、差額 0、一致、問題 0 件。全部除外したファイル（sc 7）も表に出て一致。
- **sc 17** 画面の知らせ：`fileResults` に `priorYearExcluded.count` が 2 のファイルと 0 のファイル → 知らせは 2 のファイルの 1 行だけで、文言は決定 7 のとおり（`2025 年以前の利用 2 件`）。
- **sc 18** 形式登録とカード名：形式不明の明細を指すショートカットで、形式診断・試し読み・保存が通り、試し読みの `previewHash` は指す先の中身で決まる（指す先のセルを変えると変わる）。用途の補完規則（ファイル名の語）はショートカットの名前で当たる。カード名はショートカットが置かれたカードフォルダの名前から取る。

既存のテストで直してよいのは、「ショートカットは名前によらず拾わない・読まない」前提で、**Google スプレッドシートを指すショートカット**を置いているものだけ（直したものは全部報告する）。指す先の種類を持たないショートカットや、ほかの種類を指すショートカットのテストは、そのまま通るはずである。

## 6. 変異（P1〜P24。監査で私も入れる）

- P1 `isImportableDriveFile` でショートカットを第 3 引数によらず偽に戻す
- P2 ショートカットの指す先の種類を見ずに真にする
- P3 走査の待ちをショートカット自身の変更日時で判定する
- P4 指す先のメタ情報が取れないショートカットを候補から落とす
- P5 `readFile` でショートカットの ID のまま `openById` する（指す先を読まない）
- P6 `readFile` で指す先の `openById` を中身ハッシュより先にする
- P7 指す先のゴミ箱を見ない
- P8 `currentFileBinaryHash` でショートカットの `getBlob` を使う
- P9 再走査のメタ情報をショートカット自身の値のままにする
- P10 除外を普通のファイルにも掛ける
- P11 除外の境目を 1 年ずらす（`<=`）
- P12 空欄化の対象の行も除外する
- P13 件数・合計の照合を除外の後の取引で行う
- P14 内容ハッシュを除外の後の取引で作る
- P15 用途の未解決数を数え直さない
- P16 除外した取引を取引ログに登録しない
- P17 除外した取引を `PREPARED` で登録する（転記される）
- P18 AK が無いときに除外せず通す
- P19 再合流の照会に除外する取引の ID を入れない
- P20 食い違いを確かめない
- P21 名前の付け替えを指す先に向ける
- P22 画面の一覧でショートカットの待ちをショートカット自身の変更日時で見る
- P23 `priorYearExcluded` の件数を全取引の数にする
- P24 画面の知らせを `count` によらず出す

## 7. 本番での実行（私が行う。利用者の許可を得てから）

1. 全テスト → コミット（第 1 段の §10 の追記も含める）→ push 前の pull 比較（本番＝`gas-push-134` のはず）→ `clasp push` → push 後の比較 → タグ `gas-push-135` → GitHub。
2. **影響：**本番の顧客は TEST01 だけ。TEST01 は法人で AK が空なので、カードフォルダに Google スプレッドシートを指すショートカットがあれば、次の［記帳を実行］で `FAILED`（`SHORTCUT_FISCAL_YEAR_REQUIRED`）になる。今 TEST01 のフォルダにショートカットがあるかは push の前に読むだけで確かめる。
3. 受入の前に、TEST01 の AK に 2026 を入れる（`setCustomerFiscalYear`、本番マスターへの書込なので利用者の許可を得てから）。法人の AK は今どこからも読まれていない（読むのは個人の前年分の検査だけ）ので、ほかの動きは変わらない。

## 8. 受入

- TEST01（AK 2026）のカードフォルダに、**顧客フォルダの外**に置いた明細（Google スプレッドシート。2025 年と 2026 年の利用を両方含むもの）へのショートカットを置き、［記帳を実行］で：ショートカットの名前が `【済】`、指す先の名前と中身が変わらない、転記先は 2026 年の行だけ、取込の後の知らせに `【前年分を除外】`、最終確認が「一致」で「除外した分」に 2025 年の分（置くのは利用者。置くかどうかも利用者が決める）。
- 1 人目の顧客の取込は、登録の入口（(f)）と第 3 段の後。

## 9. 監査の記録（2026-11-07）

- Codex（ログ `tools/codex-logs/*-20261107-221049-*` と `*-20261107-224142-resume*`、session `01a1b622-1856-7ad3-82f2-e208d0c1a35a`、gpt-6.1-sol xhigh、22:10〜）：開始 1830/1830 → 終了 1874/1874。sc 1〜18 の 42 本は作る前に 40 本が赤（緑の 2 本は sc 10 の「普通のファイルは変わらない」）。P1〜P24 はすべて赤、毎回バイトのまま戻ったことを確かめた。
- 途中で 1 回止まった：`test/phase0.test.js` の「エラーコード 54 件と完全一致」が、§4.7 の 3 コードの追加とぶつかった。§4.7 の「エラーの一覧と設計書の対応を見るテストがあれば、それに従う」に当たるので、3 コードを足して 57 件にすることを私が許可した（完全一致と型の確かめは保ったまま）。直した既存のテストはこの 1 本だけ。
- 差分は §4 の 8 ファイルと test 3 本（`gas-stubs.js` は足しただけ：`isTrashed`・`Files.list` の `shortcutDetails`・`Files.get`）。`97_Ops.gs` は差分なし（NUL 2）。src の CR 0、`???` 0 件。
- 私の変異 Z1〜Z22（食い違いの片側だけ落とす・予定最終状態の上書きを落とす・AK の文字を数に直して通す・走査が状態の絞りより先に指す先を取る・再走査がゴミ箱を残す・番人がゴミ箱を見ない・指す先の種類を見ない・日付選別の空欄化を見ない・件数の上限と加算を残りだけで数える・一覧が指す先の種類を見ない・候補の `targetId` を落とす・普通のファイルにも `priorYearExcluded` を出す・指す先のメタ情報の失敗で走査ごと止める・基準を処理日の年にする・ショートカットの ID で中身ハッシュを取る・知らせの年を 1 年ずらす・Drive の呼出しを数えない・除外分の同一性ハッシュを落とす・一覧が指す先の日時を見ない）は 21 個が赤。残った Z21（取引ログの状態を `priorYearExcluded` でなく予定最終状態 `CANCELED` で決める）は同じ意味の書き換え（予定最終状態を `CANCELED` にするのは除外した取引だけ。`derivePlannedFinalStatus` は `COMMITTED` か `REVIEW_REQUIRED` しか返さない）。
- 後回し（Low）：
  - 指す先がゴミ箱のとき、例外は `readFile` の中（登録の前）で起きるので、ショートカットは未登録のまま残り、記帳のたびに `FAILED` を返す（画面の一覧は「取込可能」のまま）。普通のファイルの読取の例外と同じ扱いで、今回の変更の前からある形。止まり方は安全側（転記 0 行）。
  - 件数照合の `cell` 規則（`30` の `reconciliationCell_`）は `sheet.values`・`sheet.cells` を読むが、読取の結果は `rows` なので、本物の取込では当たらない（照合しないのと同じ）。リポジトリの形式定義と形式登録は `labeledRow` しか作らないので、今は使われていない。今回の範囲外（Codex の報告で分かった）。

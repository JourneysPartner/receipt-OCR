# 画面の入口で設定を読む（freee 取込用の `WORK_FOLDER_MISSING`）仕様書

作成日：2026-11-22
版：1.1（1.0 の実装の後、既存のテスト 1 件が赤になったので §9 を足した。§9 が §3・§4・§5 と食い違う所は §9 が勝つ）
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いてあることは変えない。書いていないことは安全側で決め、決めたことは全部報告する。
前提：`work/spec_freee_export.md`（freee 取込用 Excel）・`work/spec_private_rules_and_wait.md` §7（止めの理由をボタンの横に出す）・`work/spec_customer_registration.md` §3.13（作業用フォルダ）。

**この仕様書と、実装・テストには、実在の顧客名・顧客 ID・Drive の ID・明細の中身を書かない。**リポジトリは公開である。テストの値はすべて架空にする。

危険度：**高**（画面のすべての入口で設定の値が変わる。一時ファイルを作る場所＝顧客フォルダに書かない守り）。

---

## 1. 何を直すか

### 1.1 背景（2026-11-22、本番の 1 人目の受入）

- 最終確認の後の［freee 取込用 Excel を作る］で、ボタンの横に「作れませんでした：作業用フォルダが設定されていないため、freee 取込用を作れません。」と出た（`WORK_FOLDER_MISSING`）。
- 本番のスクリプトのプロパティには `PARALLEL_WORK_FOLDER_ID` が入っている（Claude が `loadSettingsFromProperties` を読むだけで流して確かめた。読まれたキーは `EXECUTION_TIMEOUT_SECONDS`・`PARALLEL_WORK_FOLDER_ID`・`SAMPLE_CORPUS_FOLDER_ID`・`SNAPSHOT_SPREADSHEET_ID`・`TX_INDEX_SPREADSHEET_ID` の 5 つ）。顧客登録はこのキーで通っている。
- 原因：GAS は実行ごとにグローバルを作り直すので、`SETTINGS` は毎回 `00_Config.gs` の既定（`PARALLEL_WORK_FOLDER_ID: ''`）から始まる。`loadSettingsFromProperties()` を呼ぶ入口（取込の `runImport`・顧客登録・freee のカード名・メニュー）だけがプロパティの値になる。`webAppCreateFreeeExport` は呼ばないので、`freeeExportCreate_`（`46_FreeeExport.gs`）が空と見て止まる。
- 同じ読み忘れの別の影響：画面の形式登録（`webAppExplainUnknownFile`・`webAppPreviewFormat`・`webAppSaveFormat`・`webAppRequeueFormatFiles`）は `readFile` で Excel を読む。`convertXlsxToTemp`（`12_FileReader.gs`）は `SETTINGS.PARALLEL_WORK_FOLDER_ID` が空だと `parents` を付けずに写すので、一時コピーが**元のファイルの親＝顧客のフォルダ**にできる（4.10 の「顧客フォルダへ作らない」に反する。消すのは `disposeTemp`）。
- テストは `SETTINGS.PARALLEL_WORK_FOLDER_ID` を直に入れていたので、この読み忘れに気づかなかった。

### 1.2 本仕様がすること

1. `80_WebApp.gs` の `webAppInvoke_` の**最初の文**（`repairPendingDestinationCompaction_()` より前）で `loadSettingsFromProperties()` を 1 回呼ぶ。画面から呼ばれる入口（`doGet` と `webApp*` の 26 個）は、すべて `webAppInvoke_` を通る（`webAppRunImport`・`webAppPrepareImport` は `webAppImportCall_` の中で通る。列の並列（`lane`）の道は `runImport` が読む）。
2. 上のことを守るテストを足す（§4）。

### 1.3 変えないもの・しないこと

- 入口ごとに今ある `loadSettingsFromProperties()` の呼び出し（顧客登録・freee のカード名など）は消さない（2 回読んでも同じ値になる）。
- `freeeExportCreate_` の止めの条件・文言、`convertXlsxToTemp` の動き（空なら `parents` を付けない）、`loadSettingsFromProperties` の中身は変えない。
- メニュー・運用関数（`97_Ops.gs` など）の入口は本仕様の外。
- 既存のテストの期待値は変えない。本仕様の直しで既存のテストが赤になったら、直さずに名前と理由を報告する。

## 2. 安全の条件（テストで確かめる）

| 番号 | 条件 |
|---|---|
| S1 | 画面のどの入口でも、入口の処理（`fn`）と `repairPendingDestinationCompaction_()` より前に、スクリプトのプロパティの値が `SETTINGS` に入る |
| S2 | プロパティに作業用フォルダがあり `SETTINGS` の既定が空のとき、［freee 取込用 Excel を作る］は `WORK_FOLDER_MISSING` で止まらず、作るファイルの親は作業用フォルダ |
| S3 | プロパティにも作業用フォルダが無い（空・空白だけ）とき、今どおり `WORK_FOLDER_MISSING` で止まり、Drive に何も作らない |
| S4 | プロパティに作業用フォルダがあるとき、画面の形式登録で Excel を読むと、一時コピー（`Drive.Files.copy`）の `parents` は作業用フォルダだけ（顧客のフォルダにできない） |
| S5 | 設定の読み込みは Sheets の読取（`apiReadCount_`）を増やさない |

## 3. 実装

- `80_WebApp.gs` の `webAppInvoke_` だけを変える。足すのは `loadSettingsFromProperties();` の 1 文と、なぜここで読むかの短い注釈（GAS は実行ごとに `SETTINGS` が既定に戻ること・画面の全入口がここを通ること）。注釈の言葉づかいは周りに合わせる。

## 4. テスト（値は全部架空。新しいファイル `test/webapp-settings-load.test.js`。頭は `wsl N:`。使われていたら別の頭にして報告）

既存の `test/freee-export.test.js`・`test/phase9-format-registration.test.js` の組み立て方（`gas-stubs.js` の世界、架空の顧客・転記シート・Drive）をまねる。**`SETTINGS.PARALLEL_WORK_FOLDER_ID` は直に入れず、`PropertiesService.getScriptProperties().setProperty` で入れ、`SETTINGS.PARALLEL_WORK_FOLDER_ID` は `''` にしておく**（本番と同じ形）。

1. **wsl 1（S2）**：プロパティに架空の作業用フォルダ、ほかは作れる状態で `webAppCreateFreeeExport` → `WORK_FOLDER_MISSING` でない・できたファイルの親が作業用フォルダ。
2. **wsl 2（S3）**：プロパティが無い場合と空白だけの場合 → `WORK_FOLDER_MISSING`・Drive に作られたファイル 0。
3. **wsl 3（S4）**：プロパティに架空の作業用フォルダ、形式不明の `.xlsx` で `webAppPreviewFormat`（または `webAppExplainUnknownFile`）→ `Drive.Files.copy` の `parents` が `[作業用フォルダ]`。プロパティが無いときは今どおり `parents` なし（動きを変えていないことの確かめ）。
4. **wsl 4（S1 の順序）**：`webAppInvoke_` に、プロパティの値を見る `fn` を渡す → `fn` の中で `SETTINGS` がプロパティの値。`repairPendingDestinationCompaction_` の中でもプロパティの値になっている（呼び出しの順を記録して確かめる）。
5. **wsl 5（S1 の網羅）**：`src/*.gs` の最上位の `function doGet(` と `function webApp[A-Za-z0-9]+(`（名前が `_` で終わらないもの）を全部集め、本体の最初の文が `return webAppInvoke_(` であること。例外は `webAppRunImport`・`webAppPrepareImport` の 2 つだけで、これらは `webAppImportCall_` に渡し、`webAppImportCall_` の本体に `webAppInvoke_(` があること。数は 27（`doGet` を含む）。増減したらテストが赤になる（新しい入口を足した人が気づくため）。
6. **wsl 6（S5）**：`webAppInvoke_(function() { return 1; })` の前後で `apiReadCount_` が同じ。

## 5. 変異（入れて回し、赤になるテストを記録して戻す。最後に src に残っていないことを確かめる）

| 番号 | 変異 | 赤になるはずのテスト |
|---|---|---|
| R1 | `webAppInvoke_` の `loadSettingsFromProperties();` を消す | wsl 1・3・4 |
| R2 | 読み込みを `repairPendingDestinationCompaction_()` の後へ動かす | wsl 4 |
| R3 | 読み込みを `fn()` の後へ動かす | wsl 1・4 |
| R4 | `webAppCreateFreeeExport` の `return webAppInvoke_(` を外して中身を直に呼ぶ | wsl 1・5 |

## 6. 変えてよいファイル

- `src/80_WebApp.gs`（`webAppInvoke_` だけ）
- `test/webapp-settings-load.test.js`（新規）
- `test/gas-stubs.js`（足りないものがあるときだけ。足したら報告）
- `test/run-tests.js`（新しいファイルを登録する仕組みがあるときだけ）

## 7. Claude の判断の記録（利用者の決定ではないもの）

- 入口ごとに足すのではなく `webAppInvoke_` で読む：画面の全入口がここを通るので、読み忘れが二度と起きない。プロパティの読み込みは 1 回の `getProperties()` で、Sheets の読取クォータに入らない。
- 本番で効き方が変わるのは 5 つのキーだけ。`EXECUTION_TIMEOUT_SECONDS` を使うのは設定の検査と `runImport`（もともと読む）だけ。`TX_INDEX_SPREADSHEET_ID`・`SNAPSHOT_SPREADSHEET_ID` は、空だと取引の索引を使う所で例外になるので、読むようになって壊れる道は無い。
- しないこと（記録だけ）：`convertXlsxToTemp` を「作業用フォルダが空なら写さずに止める」にすると、今後の読み忘れでも顧客フォルダに書かない（fail-closed）。ただし空の前提の既存のテストとメニュー・運用関数の道に広く効くので、本仕様では変えない。スクリプトのプロパティに `RUN_TX_COUNT_RUN_…` が約 150 個残っている（`clearRunTransactionCount` が呼ばれない実行がある）。害はまだ無い。どちらも別の機会に。

## 8. 本番での手順と受入

1. 利用者の了解で main へ取り込み、main で全テスト → `clasp push`（`gas-push-N`）→ GitHub へ push。
2. 受入（利用者）：F5 → 1 人目のペイペイの転記シートで最終確認 → ［freee 取込用 Excel を作る］→ Excel ができる（`work/spec_private_rules_and_wait.md` §14 の 3 の 6、`work/spec_freee_export.md` の受入）。

## 9. 1.0 の実装の後の直し（1.1。2026-11-22）

### 9.1 分かったこと

- 1.0 の実装（ブランチ `go/webapp-settings-load` の `5467be2`）で、全体は fixtures の `ENOENT` 97 件のほかに 1 件だけ赤になった：`cmp 18: Script Properties が読めなくても Web アプリの関数は呼ぶ`（`test/exclude-compaction.test.js`）。
- `cmp 18` が守るのは「詰める処理の印（`DESTINATION_COMPACTION_PENDING`）が読めなくても、`repairPendingDestinationCompaction_` は例外を飲み込み、`fn()` は呼ぶ」こと。テストの作り物の `getScriptProperties()` は `getProperty`・`setProperty`・`deleteProperty` だけを持ち、`getProperties` を持たない。1.0 の `loadSettingsFromProperties()` が `getProperties()` を呼ぶので `TypeError` になった。印の扱いが壊れたのではなく、作り物が本物の API より狭いのが原因。
- 変異 R3（読み込みを `fn()` の後へ）では wsl 1・4 に加えて wsl 3 も赤になった（形式の読取も `fn` の中で起きるため）。正しい動き。§5 の表の予想は「wsl 1・3・4」と読み替える。

### 9.2 決めたこと（Claude の判断。§7 に足す）

- **スクリプトのプロパティが読めない（`getProperties()` が例外）ときは、入口の処理を呼ばずに止める（fail-closed）。**既定の値のまま進むと、作業用フォルダが空に見え、Excel の一時コピーが顧客のフォルダにできうる（本仕様が直す不具合そのもの）。取込（`runImport`）も、もともと読めなければ止まる。止めたときの知らせは、ほかの例外と同じく `webAppInvoke_` の `catch` で日本語にする。
- 印（`DESTINATION_COMPACTION_PENDING`）だけが読めないときは今どおり：直しを飛ばして `fn()` を呼ぶ（`cmp 18` の守り）。

### 9.3 実装（`80_WebApp.gs` の `webAppInvoke_` だけ）

`loadSettingsFromProperties()` と `repairPendingDestinationCompaction_()` を `try` の中へ入れ、順は 読み込み → 直し → `fn()` のまま。

```
function webAppInvoke_(fn) {
  try {
    // （1.0 の注釈。読めないときは止めることを 1 文足す）
    loadSettingsFromProperties();
    repairPendingDestinationCompaction_();
    return fn();
  } catch (error) {
    // 今のまま
  }
}
```

`repairPendingDestinationCompaction_` は自分で例外を飲み込むので、`try` の中へ入れても動きは変わらない。

### 9.4 テスト

1. **`cmp 18` の作り物に `getProperties() { return properties.getProperties(); }` を 1 つ足す**（本物の API にある関数を、包んでいる本物へ渡すだけ）。期待値（`markerReads` が 1・`otherReviews` が配列で 1 件以上）は変えない。既存のテストに手を入れるのはこれだけ。
2. **wsl 7（fail-closed）**：wsl 1 と同じ世界で、`PropertiesService.getScriptProperties()` が `getProperties()` で例外を投げる作り物を返す（ほかの関数は本物へ渡す）→ `webAppCreateFreeeExport` は例外になり、その文は `webAppInvoke_` の日本語の形（`想定していないエラーです:` で始まる、または `classifyMenuError_` の文）・Drive に作られたファイル 0・`fn` に当たる処理（転記シートの読取）が走っていない（`repairPendingDestinationCompaction_` も呼ばれていない）。
3. wsl 1〜6 はそのまま緑。

### 9.5 変異

| 番号 | 変異 | 赤になるはずのテスト |
|---|---|---|
| R5 | `loadSettingsFromProperties();` を `try { … } catch (e) {}` で包んで例外を飲む | wsl 7 |
| R6 | 読み込みを `try` の外（前）へ戻す | wsl 7（文が日本語の形にならない） |

### 9.6 変えてよいファイル

- `src/80_WebApp.gs`（`webAppInvoke_` だけ）
- `test/webapp-settings-load.test.js`（wsl 7 を足す）
- `test/exclude-compaction.test.js`（`cmp 18` の作り物に `getProperties` を足すだけ）

### 9.8 本番での結果（2026-11-22）

- 利用者の了解（「進めて」）で main を `ce57775` へ ff。main で全テスト 2382/2382。前の `clasp pull` で本番＝gas-push-160（`7aee3a8`）と 64/64 一致 → 19:43 `clasp push`＝**gas-push-161** → 後の pull で本番＝HEAD と 64/64 一致。GitHub へ main とタグを push。
- **受入（利用者、11-22）：合格**。F5 の後、［freee 取込用 Excel を作る］で Excel ができた。Drive の `tmp_import_` の残りの確かめ（監査 L7）も含めて、利用者の返事は「完了。大丈夫。」。
- 残り（後で）：M1（`convertXlsxToTemp` は作業用フォルダが空なら写さずに止める）・L1・L2・L6。

### 9.7 実装と監査の結果（2026-11-22）

- 実装：go-job 2 回（deepseek-v4.1-flash、計 約 0.1 ドル）。ブランチ `go/webapp-settings-load`（1.0 の実装・1.1 の直し）。Claude が worktree で sbx の全テスト：2285/2382、落ちた 97 件は全部 fixtures の `ENOENT`、`cmp 18`・wsl 1〜7 は緑。変異 R1〜R6 は予想どおり赤（R3 は wsl 3 も赤）。
- 監査（Opus 5.5 xhigh）：**C 0／H 0／M 1／Low 7**。S1〜S5 と §9.2 は全部 HOLDS。本番の 5 つのキーを読むようになって、黙って飛ばしていた処理が新しく書くようになる道は無い。
- M1（前からある。§7 に記録済み）：作業用フォルダが本当に空のとき、`convertXlsxToTemp` は今も `parents` なしで写す（顧客フォルダにできる）。→ **記録して後で**：空なら写さずに止める直し（別の仕様）。
- Low（記録だけ）：L1 wsl 5 の「`webAppImportCall_` が `webAppInvoke_` を通る」の確かめは、切り出しがファイルの終わりまでなので外れない（後の関数にも `webAppInvoke_(` がある）。直すなら次の top-level `function` で切る／L2 `cmp 18` の題・`repairPendingDestinationCompaction_` の注釈・`work/spec_exclude_row_compaction.md` の「`fn()` は必ず呼ぶ」は、ストア全体が読めないときは §9.2 で止まる（印だけのときの話と書き直すのは文書だけの直しで後で）／L3 プロパティが一時的に読めないと `doGet` もエラーの画面になる（ほかの入口はもともとマスターの ID をプロパティから読むので同じ）／L4 取込は `webAppInvoke_` と `runImport` で 2 回読む（その間に設定を変えたときだけ食い違う。無視できる）／L5 ブランチの土台が古い → 載せ替えた／L6 テストの頭の注釈が「版 1.0」／L7 この直しの前、画面の形式登録で Excel を読んだ一時コピー（名前 `tmp_import_…`）は顧客フォルダにでき、消すのに失敗すると残りうる → 本番反映の後に Drive で `tmp_import_` を探して残りが無いか一度だけ確かめる。

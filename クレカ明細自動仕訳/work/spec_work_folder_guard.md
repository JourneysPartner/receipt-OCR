# 作業用フォルダが空のときは Excel の一時コピーを作らない（＋監査の残りの小さな直し）

版 1.0（2026-11-24）

## 1. 目的

`work/spec_webapp_settings_load.md` §9.7 の監査で記録して後回しにした 4 点を直す。

- **M1（本体）**：作業用フォルダ（`SETTINGS.PARALLEL_WORK_FOLDER_ID`）が空のとき、`convertXlsxToTemp`（`src/12_FileReader.gs`）は今も `parents` なしで `Drive.Files.copy` を呼ぶ。`parents` なしの写しは元のファイルと同じフォルダ＝**顧客のフォルダ**にできる。空なら写さずに止める（fail-closed）。
- **L1**：`test/webapp-settings-load.test.js` の wsl 5 の「`webAppImportCall_` が `webAppInvoke_` を通る」の確かめが、外れない作りになっている。
- **L2**：`cmp 18` の題と、「`fn()` は必ず呼ぶ」の言い回しが、今の動き（プロパティ全体が読めないときは止まる）と合わない。
- **L6**：`test/webapp-settings-load.test.js` の頭の注釈が「版 1.0」のまま。

危険度：**高**（fail-closed の守り・ファイルの置き場所・取込の途中の止まり方）。本番では作業用フォルダが設定済みなので、本番の普段の動きは変わらない。

## 2. 今の動き（読んで確かめたこと）

- `convertXlsxToTemp(fileId)` を呼ぶのは `readFile`（`src/12_FileReader.gs`）の `.xlsx` の道だけ。CSV・Google スプレッドシート・ショートカットの道は呼ばない。
- `readFile` を呼ぶのは：取込 `processDiscoveredFile_`（`src/71_RunOrchestrator.gs`）、形式登録（`src/19_FormatRegistration.gs` の 5 か所）、画面の再検査（`src/80_WebApp.gs` の 1 か所）。
- 取込では、`readFile` はファイルを処理ログへ登録する前に呼ばれる（`stateNow` はまだ `null`）。ここで例外が出ると、外側の `catch` が結果を `FAILED` にし、`recordError` を呼び、リースを返す。`stateNow` が `VALIDATING`・`WRITING` でないので、ファイルの状態は動かさない。＝ `Drive.Files.copy` が失敗したときの今の動きと同じ。
- 画面の再検査（`80` の `readFile`）は、例外を `REQUEUE_FAILED` として飛ばす（今の `catch`）。
- 診断（`phase6-csv-excel-same` の `EXCEL_NOT_READ`）は、作業用フォルダが空なら Excel をもともと読まない。
- freee 取込用 Excel（`src/46_FreeeExport.gs`）は、空なら `WORK_FOLDER_MISSING` で止める（`freeePreconditionStop_`。エラーカタログのコードではなく、止めの値）。

## 3. 決めること（実装）

### 3.1 `src/06_ErrorCatalog.gs`

`ERROR_CATALOG` に 1 つ足す。

```
WORK_FOLDER_MISSING: errorCatalogEntry_('Excel を読むための作業用フォルダが設定されていない', false,
  'システム管理者', null, 'スクリプトのプロパティ PARALLEL_WORK_FOLDER_ID に作業用フォルダを設定してから、もう一度実行する')
```

`test/phase0.test.js` のコードの一覧（今 60 個）に `WORK_FOLDER_MISSING` を足し、数を 61 にする。ほかにエラーカタログの全体を数える・並べるテストや文書の照合があれば、同じく 1 つ足して報告する。

### 3.2 `src/12_FileReader.gs` の `convertXlsxToTemp`

関数の最初（`Drive` を呼ぶ前）に守りを置く。

```
function convertXlsxToTemp(fileId) {
  var workFolderId = String(SETTINGS.PARALLEL_WORK_FOLDER_ID || '').trim();
  if (!workFolderId) {
    throw new CatalogError('WORK_FOLDER_MISSING', 'fileId=' + String(fileId));
  }
  var resource = {
    mimeType: 'application/vnd.google-apps.spreadsheet',
    name: 'tmp_import_' + String(fileId),
    parents: [SETTINGS.PARALLEL_WORK_FOLDER_ID]
  };
  var created = Drive.Files.copy(resource, fileId, {supportsAllDrives: true});
  return {tempFileId: created.id, spreadsheet: SpreadsheetApp.openById(created.id)};
}
```

- 例外の作り方は、このリポジトリの今の書き方（`makeCatalogError_` があればそれ）に合わせてよい。`error.code === 'WORK_FOLDER_MISSING'` であること。
- 設定されているときの `Drive.Files.copy` の引数（`resource` の中身・`fileId`・`{supportsAllDrives: true}`）は今と同じ。`parents` に入れる値も今と同じ（`trim` した値に替えない）。
- 関数の頭の注釈に「作業用フォルダが空なら写さずに止める」を 1 文足す。
- ほかの `src/*.gs` は変えない（§3.4 の注釈だけ別）。取込の `catch`・画面の文・設定の検査（`05_SettingsValidator.gs`）には手を入れない。

### 3.3 安全の条件（テストで 1 つずつ確かめる）

| 番号 | 条件 |
|---|---|
| G1 | 作業用フォルダが空（`''`・空白だけ・`null`・`undefined`）のとき、`convertXlsxToTemp` は `code === 'WORK_FOLDER_MISSING'` の例外を投げ、**`Drive.Files.copy` を 1 回も呼ばない**。Drive にできたファイルは 0。 |
| G2 | 作業用フォルダが設定されているとき、`Drive.Files.copy` の引数は今と同じ（`parents` はその ID 1 つ・名前は `tmp_import_<fileId>`）。一時コピーは読み終わりに消える（例外の道も）。 |
| G3 | 取込（`runImport`）：作業用フォルダが空で `.xlsx` が 1 本あるとき、そのファイルの結果は `FAILED`・`errorCode` は `WORK_FOLDER_MISSING`。**ファイルの状態は呼ぶ前と同じ**（`FAILED` へ移さない・名前の頭も変えない）、リースは残らない、転記先への書込 0、Drive にできたファイル 0。 |
| G4 | G3 と同じ回に CSV が 1 本あれば、CSV は今どおり取り込まれる（1 本の止まりが回を止めない）。 |
| G5 | 作業用フォルダが空でも、CSV・Google スプレッドシート・ショートカットの `readFile` は今どおり読める（守りは `.xlsx` の道だけ）。 |
| G6 | 画面の再検査（`webAppRequeueFormatFiles` に当たる入口。`80` の `readFile` の所）：作業用フォルダが空で `.xlsx` のとき、そのファイルは `REQUEUE_FAILED` で飛ばされ、要確認は解決されず、ファイルの状態も変わらない。Drive にできたファイル 0。 |
| G7 | 形式登録の読取（`19` の `readFile` のどれか 1 つの入口で足りる）：作業用フォルダが空で `.xlsx` のとき、例外になり、Drive にできたファイル 0・形式の表への書込 0。 |

G3 で「今の動き」が §2 と違っていたら（例：状態が動く）、`71` を直さずに止めて報告する。

### 3.4 L2（言い回し。動きは変えない）

- `test/exclude-compaction.test.js`：`cmp 18` の題を `cmp 18: 詰める処理の印だけが読めなくても Web アプリの関数は呼ぶ` に変える。題のほかは変えない。
- `src/80_WebApp.gs` の `repairPendingDestinationCompaction_`：頭の注釈と `catch` の中の注釈の「`fn()` は必ず呼ぶ」を、「印だけが読めない・直せないときも、この関数は例外を出さないので `fn()` へ進む。プロパティ全体が読めないときは、その前の `loadSettingsFromProperties()` で止まる」の意味に書き直す。**注釈だけ**。コードの行は 1 文字も変えない。
- `work/spec_exclude_row_compaction.md` の §「次の呼出しで直す」の 1 文（`例外は飲み込む（fn() は必ず呼ぶ。…`）の後ろに、「（2026-11-22 から：プロパティ全体が読めないときは `work/spec_webapp_settings_load.md` §9.2 で止まる。ここは印だけが読めないときの話）」を足す。

### 3.5 L1（wsl 5）

`test/webapp-settings-load.test.js` の wsl 5 の終わりの確かめを、`webAppImportCall_` の**本体だけ**を見るように直す：`function webAppImportCall_(` から、次の行頭の `function `（top-level の次の関数）の手前までを切り出し、その中に `webAppInvoke_(` があること。次の関数が見つからなければテストを失敗にする（ファイルの終わりまでを見ない）。

### 3.6 L6

`test/webapp-settings-load.test.js` の頭の注釈の `版 1.0` を `版 1.1` に。

## 4. テスト

新しいファイル `test/work-folder-guard.test.js`（題は `wfg N: …`）。値はすべて架空（実明細・実 ID・実在の顧客名を使わない。`test/fixtures/` を読まない）。

| 番号 | 確かめること |
|---|---|
| wfg 1 | G1（`''`・`'   '`・`null`・`undefined` の 4 通り。`Drive.Files.copy` の回数 0・できたファイル 0・`code`） |
| wfg 2 | G2（引数の全体一致・正常の道と例外の道で一時コピーが消える） |
| wfg 3 | G3 |
| wfg 4 | G4 |
| wfg 5 | G5（3 つの道） |
| wfg 6 | G6 |
| wfg 7 | G7 |

**既存のテスト**：作業用フォルダが空のまま `.xlsx` を読んでいるテストは、新しい守りで赤になる。直してよいのは**準備の所だけ**（架空の作業用フォルダ ID を `SETTINGS.PARALLEL_WORK_FOLDER_ID` に入れる・作り物にそのフォルダを作る）。期待値（`assert` の行）は変えない。例外は「空のときは `parents` なしで写す」こと自体を確かめているテストだけで、それは新しい動き（G1）の確かめに書き換える。直したテストは、ファイル名・テストの題・変えた行を全部報告する。

## 5. 変異（入れて回し、赤になるテストを記録して戻す。最後に src と test に残っていないことを確かめる）

| 番号 | 変異 | 赤になるはずのテスト |
|---|---|---|
| R1 | `convertXlsxToTemp` の守りを消す（`parents` は今の `if` に戻す） | wfg 1・3・6・7 |
| R2 | 守りを `Drive.Files.copy` の後へ動かす | wfg 1（回数・できたファイル） |
| R3 | `trim()` を外す | wfg 1（空白だけ） |
| R4 | `code` の無い `new Error(...)` を投げる | wfg 1・3 |
| R5 | 守りを `readFile` の最初へ動かす（CSV も止まる） | wfg 4・5 |
| R6 | `webAppImportCall_` の中の `webAppInvoke_(` を別の名前に変える（後ろの関数の `webAppInvoke_(` は残る） | wsl 5 |

## 6. 変えてよいファイル

- `src/06_ErrorCatalog.gs`（§3.1 の 1 行）
- `src/12_FileReader.gs`（`convertXlsxToTemp` だけ）
- `src/80_WebApp.gs`（§3.4 の注釈だけ）
- `test/work-folder-guard.test.js`（新規）
- `test/webapp-settings-load.test.js`（§3.5・§3.6）
- `test/exclude-compaction.test.js`（`cmp 18` の題だけ）
- `test/phase0.test.js`（§3.1 の一覧と数）
- 既存のテストの準備の所（§4 の決まり）
- `test/run-tests.js`（新しいファイルを登録する仕組みがあるときだけ）
- `test/gas-stubs.js`（足りないものがあるときだけ。足したら報告）
- `work/spec_exclude_row_compaction.md`（§3.4 の 1 文だけ）

## 7. Claude の判断の記録（利用者の決定ではないもの）

- **守りは `convertXlsxToTemp` の中に置く。**ここが顧客フォルダに写しを作りうるただ 1 つの場所なので、どの入口から来ても、設定の読み忘れが将来また起きても、写しはできない。
- **取込の回の全体は止めない**（設定の検査 `validateSettings` に「作業用フォルダが空なら `SETTINGS_INVALID`」は足さない）。CSV・Google スプレッドシートだけの取込は作業用フォルダを使わないので、止める理由が無い。`.xlsx` のファイルは `FAILED` の結果で飛ばされ、状態は動かないので、設定を直した次の回でそのまま取り込める。
- 画面の文は足さない。本番は設定済みで、出るのは設定が壊れたときだけ。取込の結果には `WORK_FOLDER_MISSING` のコードが出る。
- 止めのコードの名前は freee 取込用 Excel と同じ `WORK_FOLDER_MISSING` にそろえた（同じ原因・同じ直し方）。

## 8. 本番での手順と受入

1. 実装（go-job・worktree）→ Claude が差分を読む・sbx で全テスト → Opus 5.5 xhigh の監査 → 直し。
2. 利用者の了解で main へ取り込み、main で全テスト → 利用者の了解で `clasp push`（前後の pull で一致・`gas-push-N`）→ GitHub へ push。
3. 受入（利用者）：F5 → Excel（`.xlsx`）の明細を 1 本［記帳を実行］で取り込めること（今までどおり）。形式不明の Excel があれば［形式を確認］が今までどおり開くこと。

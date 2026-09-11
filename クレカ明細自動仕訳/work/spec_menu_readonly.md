# 参照系カスタムメニュー 仕様書

対象システム：クレジットカード明細 自動仕訳システム（Google Apps Script、リポジトリ `クレカ明細自動仕訳`）
作成日：2026-09-10
版：1.2
読者：本仕様だけを読んで実装する実装者（AI を含む）。この文書に書いていないことは実装者が決めてよいが、**書いてあることは変えない**。判断に迷う箇所は §12「未確認事項」を先に読む。

改訂履歴：
- 1.2（2026-09-11）：§7.1 の警告行に「取込に繰り返し失敗して取込待ちに戻っているファイル」（`DISCOVERED` のままエラー記録が前回の通知評価より**増えた**、要対応）を 2 行目として追加。判定に要る記憶 `watch` は通知側が持ち、画面は `readNotificationWatch_()` で読んで `buildImportStatusView_` の第 5 引数に渡す。§10.3 にテスト 37 を追加。理由は §7.1 の v1.2 追記（2026-09-09 の事故を画面で「要対応」と読めるようにし、かつ巻戻し直後の誤警報を出さないため。メール通知 `work/spec_notifications.md` §5.1 `REPEATED_FAILURE`・§7.8 と同一の判定）。既存 5 行は不変。
- 1.1（2026-09-10）：§7.8・§9.4・テスト 26・31・付録 B を実装に合わせて修正。「`opsFilesNeedingTagBackfill().detail[]` に `customerId` を追加」は §9.4 冒頭の「戻り値を一字一句変えない」と両立しないため、`collectTagBackfillTargets_()` を抽出して collector 側だけが `customerId` を持つ形に改めた（理由は §9.4）。あわせて §7.1 に、警告行の判定を通知（`work/spec_notifications.md`）と共有するための注記を追加。

---

## 0. この文書の読み方

- 本文中の「仕様」は `credit_card_import_normalization_system_spec_v2.0.md`、「設計」は `design_document.md` を指す。§番号はそれぞれの文書の節番号。
- 「既存関数」は `src/` に現在ある関数。シグネチャは §7 の各項目と §9.3 の表に転記してある。
- 各決定には理由を添えた。**理由の方が決定より重要である。** 実装中に決定と衝突する事実が見つかったら、理由に照らして判断し、変えた場合はその旨を仕様書に追記すること。
- 断定できないことは「未確認」と書いた。未確認事項は §12 に集約し、実機での確認手順を付けた。

---

## 1. 背景と目的

本システムは実機で稼働中で、33ファイル・636明細を取り込み済みである。しかし **UI が1行も存在しない**。`onOpen`・`SpreadsheetApp.getUi`・`HtmlService`・`createMenu`・`toast` のいずれも `src/` に無い（2026-09-10 に grep で確認）。

設計 §4.2 は `01_Menu.gs`（メニュー登録・ダイアログ）を定めているが、`01_` の枠は `01_DataAccessCore.gs` が使い、メニューは作られなかった。日常運用は開発者が `clasp run` またはエディタのプルダウンで `97_Ops.gs` の `ops*` 関数（35個。2026-09-10 に `^function ops[A-Z]` で数えた）を叩く形になっている。顧客本人にも確認担当者にも、状態を見る手段が無い。

直近、**取込が10分ごとに数時間失敗し続けたのに誰も気づかない事故**が起きた（`97_Ops.gs` の `opsBackfillMemoTags` のコメント：「実機では2ファイルが10分ごとに同じ理由で落ち続けた」2026-09-09）。原因はコード側にあったが、**「今どうなっているか」が画面に出ていれば、数時間ではなく最初の1回で気づけた**。本仕様の第一の目的はこれである。

したがって本仕様で作るメニューの中心は「取込の状況」（§7.1）であり、事故の再発時に**開いた瞬間に異常が読める**ことを最優先にする。他の項目はその補助である。

（v1.2 注記）「開いた瞬間に異常が読める」のうち、事故そのものを要対応として示す行（§7.1 v1.2 の「取込に繰り返し失敗して取込待ちに戻っているファイル」）は、**メール通知（`work/spec_notifications.md`）の評価が動いていることが前提**である。通知が導入されていない・監視トリガーと定期取込のどちらも走っていない環境では、この行は出ず、事故は「△ エラー記録のあるファイル」（注意）としてしか見えない。運用手順として、通知の導入（`opsStartNotificationWatchdog`）をメニュー導入と併せて行うこと。

---

## 2. 範囲と非範囲

### 2.1 作るもの

**書込・状態変更を一切伴わない参照系メニューだけ**を作る。具体的には §5 のメニュー構成のとおり、状態の集計・一覧・診断・シートへの移動である。

### 2.2 作らないもの

仕様 §21.1 の 11 項目のうち、操作系（取込開始・再検査・再開・確定・登録・取込済み化・取消し・復元）と、プレビューは**作らない**。§5.2 に項目ごとの理由を書いた。

加えて次も作らない。

| 作らないもの | 理由 |
|---|---|
| 役割（確認担当者／システム管理者／オーナー管理者）の判定 | 設計 §4.4 `03_Authorization.gs` の責務であり未実装。参照系だけなら役割の区別は要らない（見せる範囲は顧客単位で決まる。§4） |
| 顧客を1社選んで絞る操作（仕様 §21.1「選択顧客」） | 現在の顧客は1社（`TEST01`）。プロンプト入力の解釈という新しい失敗面を増やす価値が今は無い。閲覧範囲は「許可された全顧客」とする |
| 結果をシートへ書き出す表示方式 | シートへの書込は「書込」である。マスターの必須シート集合（`CONFIG.REQUIRED_SHEET_KEYS`）に無いシートを増やすと、プロビジョニングと幅検査（`opsShowCustomerMasterLayout` が扱っている類の齟齬）の管理対象が増える |
| `google.script.run` によるダイアログからのサーバー呼出し | 呼出し側にも認可が要り、テスト面も増える。ダイアログは**描画時にデータを埋め込んだ静的HTML**に限る |
| メール通知・トースト通知 | 仕様 §21.3 は別モジュール（設計 §4.5）の責務 |

### 2.3 線引きの根拠

仕様 §20.1・§20.5 は「メニュー表示だけでなくサーバー側関数の入口でも顧客単位で認可する」「画面制御だけを認可手段とせず、サーバー側認可を必須とする」と定める。そのサーバー側認可（設計 §4.4 `authorize()`・`authorizeOperation()`）は**未実装**である。

操作系メニューを認可無しで出すと、画面に出た人は誰でも取消し・確定ができる状態になる。仕様が明示的に禁じている形である。逆に参照系は、後述の顧客単位の閲覧範囲（§4）だけで仕様 §20.1 の要求を満たせる。よって**認可モジュールが実装されるまで、操作系はメニューに出さない**。この線引きは §5.1 のメニュー構成に反映され、§11 の受入条件で検証する。

### 2.4 「書込を伴わない」の定義

本仕様で「書込」とは次のいずれかを指す。メニューから到達するコード（§9 で新設・改修する関数を含む）は、これらを**一切呼ばない**。§11 の受入条件で grep 検証する。

| 分類 | 該当する呼出し |
|---|---|
| Sheets のセル・構造 | `setValue` `setValues` `setFormula` `setFormulas` `appendRow` `insertSheet` `insertRowsAfter` `insertColumnsAfter` `deleteRow` `deleteRows` `deleteSheet` `setName`（シート）`clearContent` `protect` `Sheets.Spreadsheets.Values.batchUpdate` `Sheets.Spreadsheets.batchUpdate` |
| Drive | `File.setName` `Drive.Files.copy` `Drive.Files.remove` `DriveApp.create*` |
| Script Properties | `setProperty` `deleteProperty` `deleteAllProperties` |
| トリガー | `ScriptApp.newTrigger` `ScriptApp.deleteTrigger` |
| 本システムの状態 | `appendAudit` `appendAuditUnlocked_` `acquireLease` `releaseLease` `forceReleaseLease` `transitionFileState` `updateProcessLog` `createOrUpdateProcessLog` `updateReviewStatus` `resolveReview` `resolveFileReview` `rewindFileForReimport_` `clearSubmittedContentHash` `setMasterSpreadsheetId` `validateCustomerAccess`（**書込プローブを行う**：`file.setName` と `writeProbe.setValue`）|
| その他 | `MailApp` `GmailApp` `UrlFetchApp` `LockService`（データを書かないが他の実行を待たせる。参照系に不要） |

書込に**当たらない**もの：`SpreadsheetApp.flush()`（`sheetsReadRanges_` が読取前に呼ぶ。未送信の書込が無いので何も起きない）、`Spreadsheet.setActiveSheet` / `setActiveRange`（画面の位置を変えるだけ）、`Logger.log`、`SpreadsheetApp.getUi()` のダイアログ、`loadSettingsFromProperties()`（読取のみ）。

---

## 3. 実行環境の事実（GAS）

ここを誤ると実装が動かない。**断定していない箇所は §12 で実機確認する。**

### 3.1 どのスプレッドシートにメニューが出るか

- このスクリプトはコンテナバインドである（`.clasp.json` にあるのは `scriptId`・`rootDir: src`・`projectId` の3つで、コンテナのスプレッドシートIDは無い。実装指示書 §6「スプレッドシートに紐づくバウンドスクリプト」。メモリ `gas-environment.md`「コンテナバインドの Apps Script プロジェクトへ clasp で push 済み」）。
- カスタムメニューは**コンテナ（スクリプトが紐づいたスプレッドシート）を開いたときだけ**出る。顧客の転記先スプレッドシート（freee出納帳）を開いても出ない。
- **コンテナがマスタースプレッドシートと同一かどうかは、コードからは断定できない。** 根拠：`.clasp.json` の `projectId` は GCP プロジェクトの番号でありコンテナのIDではなく、`01_DataAccessCore.gs` の `masterSpreadsheet_()` は「設定値 → Script Properties → アクティブなスプレッドシート」の順で解決しており、コメントに「アクティブなスプレッドシートへのフォールバックはメニュー実行専用」とある。つまり**設計はコンテナ＝マスターを前提**にしているが、実機では Script Properties の `MASTER_SPREADSHEET_ID` が設定済み（メモリ）なので、コンテナが別でも動いてしまう。→ **未確認 U-1**（§12）。
- 実装は**コンテナ＝マスターに依存しない**こと。データはすべて `masterSpreadsheet_()` 経由で読み、`SpreadsheetApp.getActiveSpreadsheet()` は「処理ログを開く」（§7.4）の**移動先の判定**と「このメニューについて」（§7.9）の**表示**にだけ使う。理由：コンテナが別だった場合でも、メニューはリンク表示に切り替わるだけで壊れない。

### 3.2 `onOpen`（単純トリガー）の制約

`onOpen` は認可無しで動く単純トリガーであり、次の制約がある。

| できること | できないこと |
|---|---|
| `SpreadsheetApp.getUi().createMenu(...).addToUi()` | 認可を要するサービスの呼出し：`SpreadsheetApp.openById`（別ファイル）、`DriveApp`、拡張サービス `Sheets`／`Drive`、`ScriptApp.getProjectTriggers`／`newTrigger`、`MailApp`、`UrlFetchApp` |
| コンテナ自身の読取（本仕様では使わない） | `Session.getActiveUser().getEmail()` の取得（単純トリガーでは空文字になる） |
| `Logger.log` | 30秒を超える処理 |

さらに次の事実がある。

- ファイルを**閲覧権限・コメント権限で開いた場合は `onOpen` が動かない**（単純トリガーの制限）。したがってメニューは**コンテナの編集権限を持つ人にしか出ない**。これは §4.4 の限界に直結する。
- `onOpen` が例外を投げるとメニューは**黙って出ない**（利用者には何も表示されない。エラーは Apps Script の「実行数」画面にだけ残る）。
- プロジェクトのどれか1ファイルでも**読込時（グローバルスコープ）に例外を投げると、`onOpen` だけでなく定期取込トリガーも含めて全関数が動かなくなる**。1つのスクリプトプロジェクトだからである。メニューのファイルは §9.2 の「読込時に何もしない」規律を守る。
- メニュー項目の表示名は静的で、利用者ごとに変えられない（実行者が分からないため）。仕様 §21.1「権限のない操作を非表示」は単純トリガーでは実現できないが、本仕様の項目はすべて参照系なので隠すものが無い。

**したがって `onOpen` はメニューを組み立てる以外のことを一切しない。** 設定の読込・マスターの存在確認・実行者の確認は、各メニュー項目の関数が押されたときに行う。

### 3.3 メニュー項目関数の実行文脈

- 項目を押すと、指定した**グローバル関数が引数なし・押した利用者の権限で**実行される。6分の実行上限が適用される。
- 初回はその利用者に対して OAuth の同意画面が出る。`src/appsscript.json` の `oauthScopes`（spreadsheets・drive・script.scriptapp・script.send_mail・userinfo.email）が**全部一度に**要求される。プロジェクトの所有アカウントは Gmail（消費者アカウント）なので、**「このアプリは Google で確認されていません」の警告画面**を経る可能性が高い（→ 未確認 U-6。運用手順として §11 に含める）。
- 項目に指定する関数名は**末尾にアンダースコアを付けない**（`_` 付きの関数はエディタから見えず、メニューハンドラとしても実行できないとされる。→ 未確認 U-7。付けなければ問題は起きない）。
- `SpreadsheetApp.getUi()` は**UIの無い文脈（`clasp run`・時間主導トリガー・Apps Script API 実行）では例外を投げる**（"Cannot call SpreadsheetApp.getUi() from this context."）。よって `ops*` 関数は `getUi()` を呼んではならず（既存の `clasp run` 運用が壊れる）、メニュー関数は UI 依存部分を1箇所に閉じ込める（§6.1・§10）。

### 3.4 実行者メールアドレスの取得

- `activeUserEmail_()`（`01_DataAccessCore.gs`）は `Session.getActiveUser().getEmail()` を返す。マニフェストに `userinfo.email` スコープがあるため、**利用者が承認を済ませたメニュー実行では消費者アカウントでも取得できるはず**だが、実機未確認（→ U-2）。
- 取得できない（空文字）場合、仕様 §20.5「実行者を信頼できる方法で取得できない場合は権限操作を拒否し、匿名または空文字の実行者で処理しない」に従い、**参照であっても拒否する**（§4.2）。理由：見せる範囲を実行者で決める以上、実行者が分からなければ範囲が決まらない。

### 3.5 トリガーの可視性

`ScriptApp.getProjectTriggers()` は**現在の利用者が作成したトリガーだけ**を返す。定期取込トリガー（`scheduledImportTick`）は開発者アカウントが作成したものなので、確認担当者や顧客からは見えない。「取込の状況」（§7.1）ではこの制約を表示文言に含める。

### 3.6 表示手段の比較と採用

| 手段 | 性質 | 採用 |
|---|---|---|
| `ui.alert(title, text, buttons)` | 同期モーダル。プレーンテキスト、自動折返し。書式無し。文字数上限は公開仕様に無い（→ U-3） | **要約**（取込の状況・設定の検査・このメニューについて・エラー）に使う。本文は**全角換算 1,000 文字・30 行以内**に収める |
| `ui.prompt(title, text, buttons)` | 1行の文字入力 | 「タグ付き取引を検索」の入力にだけ使う |
| `HtmlService` モーダル（`ui.showModalDialog`） | 任意のHTML。スクロール可、表が組める、テキスト選択・コピー可、リンクを新しいタブで開ける。データはHTMLエスケープが必須 | **一覧**（ファイル一覧・要確認・リース・タグ検索・遡及対象）に使う |
| サイドバー（`ui.showSidebar`） | 幅300px固定 | 使わない。一覧に狭すぎる |
| `Spreadsheet.toast` | 右下に数秒。消える。切り詰められる | 使わない。読み損ねると意味が無い。事故の再発防止という目的に反する |
| シートへ書き出し | 永続化される | 使わない（§2.2） |

一覧をHTMLの `<table>` にする理由：`ui.alert` はプロポーショナルフォントで、`|` 区切りの列は揃わない。`<pre>` の等幅でも、日本語の全角文字は等幅フォントで2桁幅にならない環境があり列が揃わない。**表組みなら文字幅に依存しない。**

---

## 4. 暫定の閲覧範囲（認可の代替ではない）

### 4.1 閲覧範囲の決め方

各メニュー項目は、実行の最初に `menuViewerScope_()`（`96_Menu.gs` に新設。§9.3）で閲覧範囲を決め、以降のすべての一覧・集計をその範囲に**絞って**表示する。

```
menuViewerScope_() → {
  email: string,                 // activeUserEmail_() の値（小文字化しない。表示用）
  isOwner: boolean,              // マスターのオーナーか
  customers: Customer[],         // 閲覧してよい顧客（getAuthorizedCustomers の戻り値、またはオーナーなら getActiveCustomers）
  customerIds: string[],         // customers の customerId
  customerNameById: Object       // customerId → customerName
}
```

判定手順：

1. `email = activeUserEmail_()`。空文字なら `AuthorizationError` を投げる。**`detail` には §4.2 の「メール取得不能」の全文をそのまま入れる。**
2. `owner = masterSpreadsheet_().getOwner()`。`owner` が `null`（共有ドライブ）または `owner.getEmail()` が空なら `isOwner = false`。そうでなければ `isOwner = (owner.getEmail().toLowerCase() === email.toLowerCase())`。→ `getOwner().getEmail()` の取得可否は U-4。
3. `isOwner` なら `customers = getActiveCustomers()`、そうでなければ `customers = getAuthorizedCustomers(email)`。
4. `customers` が空なら `AuthorizationError` を投げる。**`detail` には §4.2 の「顧客なし」の全文（`{email}` を埋めたもの）をそのまま入れる。** オーナーで顧客が0件のときも同じ（表示するものが無い）。

`AuthorizationError(detail)` は `CatalogError(null, detail)` であり、`message` は `'処理を実行できません: ' + detail` に組み立てられる（`06_ErrorCatalog.gs` 76〜91行）。**表示に使うのは `error.detail` であって `error.message` ではない**（§8 行1）。理由：`message` を使うと先頭に「処理を実行できません: 」が付き、§4.2 の文言と一致しなくなる。投げる箇所・表示する箇所・テスト（§10.3 の 6・7）の三者で同じ文字列を指すために、**文言の正本は §4.2 の2つの文だけ**とする。

根拠：設計 §4.4.1「役割判定の順序：(1) マスタースプレッドシートのオーナー → オーナー管理者（全顧客）、(2) R列 → システム管理者、(3) Q列 → 確認担当者」。既存の `getAuthorizedCustomers(userEmail)`（`02_CustomerMaster.gs`）が (2)(3) をまとめて実装している（Q列 `reviewers`・R列 `admins` のいずれかに含まれる**有効な**顧客）。オーナーの扱いだけを足す。

注意：`getActiveCustomers()` は**有効な顧客行のどれか1行でも不正**（例：`INDIVIDUAL` なのに AK列が無い）だと `MasterDataError('CUSTOMER_MASTER_INVALID')` を投げる。これは既存の挙動であり、メニューでは §8 のエラー表示で扱う。

### 4.2 拒否の表示

`AuthorizationError` は §8 の共通処理で `ui.alert` に表示する。本文は次の2種で、**この文字列がそのまま `AuthorizationError` の `detail` になる**（§4.1）。

- メール取得不能：「実行者のメールアドレスを取得できないため表示できません（仕様 §20.5）。スクリプトの承認が済んでいるか確認してください。」
- 顧客なし：「閲覧を許可された顧客がありません。実行者: {email}。顧客マスターの Q列（確認担当者）または R列（システム管理者）にこのアドレスを登録してください。」

### 4.3 `03_Authorization.gs` との関係

- `menuViewerScope_` は**参照系の暫定措置**であり、設計 §4.4 の `authorize()` の代替ではない。**書込を伴う操作に流用してはならない**（関数コメントに明記する）。
- 設計 §4.4 が定める関数名（`authorize` `getUserRole` `hasRole` `getAuthorizedCustomerIds` `authorizeOperation` `isCorpusAdmin`）を**使わない**。後で `03_Authorization.gs` が実装されたとき衝突させないため。
- `03_Authorization.gs` 実装後は、`menuViewerScope_` の手順 2〜3 を `authorize('REVIEWER', null)` 相当に置き換える想定。それまでは本仕様のまま。

### 4.4 限界（正直に書く）

メニューは**コンテナの編集権限を持つ人にしか出ない**（§3.2）。コンテナがマスターなら、その人はマスターの全シート（全顧客の処理ログ・取引ログ・要確認）を**直接開いて読める**。したがって本仕様の顧客フィルタは「見せる範囲を整える」ものであって、**仕様 §20.1 の閲覧制限をマスター上で強制する手段にはならない**。閲覧制限の強制にはシート保護（仕様 §20.2）や実行形態の変更（設計 §4.4.2 が言及するオーナー権限で動くウェブアプリ）が要り、本仕様の範囲外である。

顧客本人にマスターの編集権限を与えるかどうかは運用判断であり、本仕様は決めない。ただし**与える場合は上記を承知のうえで与えること**を、§11 の受入条件（運用手順）に含める。

---

## 5. メニュー構成

### 5.1 構成

```
クレカ自動処理
 ├─ 取込の状況                       menuShowImportStatus
 ├─ ファイル一覧                     menuShowFileList
 ├─ 要確認を開く                     menuOpenReview
 ├─ 処理ログを開く                   menuOpenLog
 ├─ ──────────
 └─ 診断 ▸
     ├─ リースの状況                 menuShowLeases
     ├─ 設定の検査                   menuCheckSettings
     ├─ タグ付き取引を検索           menuFindTaggedTransactions
     ├─ タグ遡及の対象ファイル       menuShowTagBackfillTargets
     └─ このメニューについて         menuShowAbout
```

- トップレベル名は仕様 §21.1 どおり「クレカ自動処理」。
- 項目の**表示名・順序・関数名は上記のとおり固定**（§10 のテストで検証する）。
- `menuOpenReview` と `menuOpenLog` は設計 §4.2 の関数名をそのまま使う（設計との対応を保つ）。他は設計に無い項目なので新しい名前。

### 5.2 仕様 §21.1 の 11 項目との対応

| 仕様 §21.1 の項目 | 本仕様 | 理由 |
|---|---|---|
| 選択顧客をプレビュー | 出さない | 設計 §4.2 は「書込を伴わない」としているが、**プレビュー関数は存在しない**（`runImport` は処理ログを書く）。Drive の元ファイルを読んで判定・抽出まで走らせる新しい経路の新設は「既存の参照ロジックを呼ぶ薄い層」の範囲を超える。次段階の候補 |
| 未処理ファイルを全件プレビュー | 出さない | 同上 |
| 選択ファイルを処理 | 出さない | 書込（`DISCOVERED → VALIDATING` 以降）。認可未実装 |
| 要修正ファイルを再検査 | 出さない | 書込（`CUSTOMER_FIX_REQUIRED → VALIDATING`） |
| 処理中ファイルを再開 | 出さない | 書込（`FAILED → VALIDATING` 等） |
| 要確認を開く | **出す**（一覧＋要確認シートへのリンク） | 参照のみ。設計 §4.2「要確認シートのステータスを基準に一覧」 |
| 要確認を確定 | 出さない | 書込（`resolveReview`） |
| 新しいカード形式を登録 | 出さない | 書込（カード形式マスター・サンプル台帳） |
| freee取込済みにする | 出さない | 書込 |
| 取消し・復元 | 出さない | 書込 |
| 処理ログを開く | **出す** | 参照のみ。設計 §4.2 `menuOpenLog` |

### 5.3 仕様 §21.1 に無い項目を追加する根拠（設計 §4.2 A-27 と同じ流儀で記録する）

| 追加した項目 | 根拠 | 追加しないと成立しないこと |
|---|---|---|
| 取込の状況 | 仕様 §21.2「対象顧客、ファイル数、明細数、自動確定、要確認、除外、エラー、待機を表示する」。仕様 §19.3「中断と判定した場合は管理者へ通知する」 | §1 の事故。「今どうなっているか」を開いた瞬間に読める画面が無いと、失敗の継続に誰も気づかない |
| ファイル一覧 | 仕様 §7.1「処理状態の正本は内部ログとする」 | ファイル名の接頭辞は名称変更失敗で正本とずれる。正本（内部状態）を人が見る手段が `opsShowFileStates` の `clasp run` しか無い |
| 診断 ▸ リースの状況 | 仕様 §19.1・§19.3、設計 INV-20 | リースが残るとファイルが永久に処理されない。「なぜ動かないか」を見る手段が `opsShowLeases` しか無い（実機で28時間気づけなかった事例が `11_FileStateManager.gs` にある） |
| 診断 ▸ 設定の検査 | 仕様 §23.1「起動時に必須設定を検証し…書込みを開始しない」 | 定期取込が `SETTINGS_INVALID` で止まっているとき、**止まっている理由**を見る手段が無い |
| 診断 ▸ タグ付き取引を検索／タグ遡及の対象ファイル | 運用実績（`opsShowTaggedTransactions`・`opsFilesNeedingTagBackfill`。2026-09-08〜09 の遡及作業で使用） | 規則変更の影響範囲を画面で確認できない |
| 診断 ▸ このメニューについて | 仕様 §21.1「メニューとダイアログは現在の実行者、役割、対象顧客を表示し」 | 「何も表示されない」ときに、実行者・閲覧範囲・コンテナとマスターの対応を確認する手段が無い（U-1・U-2 の実機確認にも使う） |

---

## 6. 共通の振る舞い

### 6.1 すべてのメニュー項目関数が従う骨組み

各 `menu*` 関数は次の形に固定する。**UI に触るのは `runMenuAction_` と `present*_` だけ**であり、それ以外の関数は UI を知らない（§10 のテスト可能性のため）。

```
function menuShowImportStatus() {
  runMenuAction_('取込の状況', function(scope, now) {
    var collected = collectImportStatus_({now: now});           // 集める（97_Ops.gs）
    var triggers = ScriptApp.getProjectTriggers().filter(function(t) {
      return t.getHandlerFunction() === SCHEDULED_IMPORT_HANDLER_;
    }).length;                                                    // UI でも純粋でもない外部参照はここで済ませる
    var view = buildImportStatusView_(collected, scope, now, triggers);   // 整形する（純粋関数。§9.3）
    return {kind: 'alert', title: '取込の状況', text: view.text};
  });
}
```

`runMenuAction_(actionName, fn)` の手順：

1. `var ui = menuUi_();` ── `SpreadsheetApp.getUi()` を返す1行の関数。**ここで例外が出た場合は握りつぶさずそのまま投げる**（UI の無い文脈から呼ばれた。表示できないので呼出元に知らせる）。
2. `loadSettingsFromProperties();` ── 理由：GAS の実行はグローバルを保持しないため、`SETTINGS.HEARTBEAT_TIMEOUT_SECONDS` 等が既定値のままでは停滞判定が狂う。すべての `ops*` 関数が最初に行っているのと同じ。
3. `var now = new Date();` ── 相対時刻表示の基準。`fn` へ渡す（テストで固定するため）。
4. `var scope = menuViewerScope_();`（§4.1）
5. `var result = fn(scope, now);` ── 戻り値は §6.2 の形。
6. `presentMenuResult_(ui, result);`（§6.2）
7. 手順 2〜6 のどこで例外が出ても `try/catch` で受け、§8 の分類に従って `ui.alert` を出す。**再送出しない**（二重表示になる）。`Logger.log` に `error.stack`（無ければ `String(error)`）を残す。

`validateSettings()` を**各メニューの前提検査として掛けない**（設計 §4.2 の契約「すべてのメニューは validateSettings(scope) を通す」からの意図的な逸脱）。理由：設定が壊れているときこそ状況を見たいのであり、無関係な検査で参照を拒むのは設計 INV-41「復旧メニューは、それが是正する不備と無関係な検証で拒否されてはならない」の精神に反する。設定の状態は「設定の検査」（§7.6）で見る。参照系の実行に必要な前提は「マスターが開けること」だけで、それは `masterSpreadsheet_()` の例外を §8 で表示すれば足りる。

### 6.2 表示結果の形と表示器

`fn` の戻り値：

```
{kind: 'alert',    title: string, text: string}
{kind: 'modal',    title: string, html: string, width: number, height: number}
{kind: 'navigate', sheetName: string, masterSheet: Sheet, fallbackHtml: string, title: string}   // 「処理ログを開く」専用（§7.4）
{kind: 'none'}                                                            // プロンプトが取消された等。何も表示しない
```

`presentMenuResult_(ui, result)`：

- `alert` → `ui.alert('クレカ自動処理 ― ' + title, text, ui.ButtonSet.OK)`
- `modal` → `ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(width).setHeight(height), 'クレカ自動処理 ― ' + title)`
- `navigate` → `var active = SpreadsheetApp.getActiveSpreadsheet();` `active` が非 null かつ `active.getId() === result.masterSheet.getParent().getId()` なら `var target = active.getSheetByName(result.sheetName)` を取り直し、`target` が非 null かつ `!target.isSheetHidden()` なら `active.setActiveSheet(target)`。**それ以外（`active` が null・IDが違う・`target` が null・非表示）はすべて** `modal`（`fallbackHtml`、幅 520・高さ 200）として表示する。例外は投げない。`fallbackHtml` の中身（非表示の注記を含む）は `fn` が作る（§7.4）。
- `none` → 何もしない。

### 6.3 すべてのダイアログに付ける見出し行

仕様 §21.1「メニューとダイアログは現在の実行者、役割、対象顧客を表示し」に従い、`alert` の先頭2行・`modal` の表の上に次を出す。

```
実行者: {scope.email}{isOwner なら '（オーナー）'}
対象顧客: {顧客名(顧客ID) を「、」で連結。6社以上なら先頭5社＋'ほかN社'}　取得: {yyyy-MM-dd HH:mm}
```

役割は表示しない。理由：役割判定（設計 §4.4）が未実装であり、推測で「確認担当者」などと出すと、後で実装された役割と食い違う。

### 6.4 日時の書式

- 表示は `yyyy-MM-dd HH:mm`（Asia/Tokyo）。秒は出さない。
- `formatMenuTimestamp_(value)`（純粋関数、`96_Menu.gs`）：`''`／`null`／`undefined` → `'-'`。`Date` → `toIso8601(value)` の先頭16文字を `T` を空白に置換。数値（Sheets のシリアル値）→ `excelSerialToDate(value)` を経て同様。文字列 → ISO 8601 とみなし、先頭16文字の `T` を空白に置換（`toIso8601` の出力はすべて `+09:00` なので時差補正は不要）。それ以外 → `String(value)`。
  - 数値・`Date` の経路が要る理由：処理リースの `lastHeartbeat` は `appendRow` で書かれており、Sheets が ISO 文字列を日付セルに解釈した場合、Sheets API の `UNFORMATTED_VALUE` 読取はシリアル値を返す（→ U-8）。文字列前提だと `new Date(45000)` のような誤変換になる。
- 相対時刻 `describeAge_(fromValue, now)`：`fromValue` を上と同じ規則で `Date` に直し、`now - from` が 60秒未満 → `'たった今'`、60分未満 → `'N分前'`、48時間未満 → `'N時間前'`、それ以上 → `'N日前'`。変換不能 → `'(不明)'`。

### 6.5 件数の上限

一覧は多くても画面で読める量に切る。**切ったことを必ず表示する**（「他 N 件は表示していません」）。上限は §7 の各項目に書く。上限を超えた分は**並び順の後ろ**から落とす。理由：並び順は「要対応が先」なので、落ちるのは終了済みの行になる。

### 6.6 HTML の生成規則

- `renderMenuTable_(headerLines, columns, rows, footerLines, links)` → HTML 文字列。`columns` は見出しの配列、`rows` は行ごとのセル文字列の配列、`links` は `[{label, url}]`。
- **すべてのデータは `escapeHtml_()` を通す**（`&` `<` `>` `"` `'` の5文字）。ファイル名・店名・エラー文言は外部由来であり、`<script>` を含む名前のファイルが Drive に置かれ得る。
- 埋め込む `<style>` は最小限（`table {border-collapse: collapse; font-size: 13px}` `th, td {border: 1px solid #ccc; padding: 2px 6px; vertical-align: top}` `th {background: #f3f3f3; position: sticky; top: 0}`）。外部リソースを読まない。
- 末尾に `<button onclick="google.script.host.close()">閉じる</button>`。それ以外のスクリプトを含めない（§2.2）。
- リンクは `<a href="..." target="_blank" rel="noopener">`。
- 幅・高さの既定：960 × 600。

### 6.7 表示ラベル（付録 A）

内部状態・要確認種別・リース用途は付録 A の日本語ラベルで表示し、**英字コードを括弧書きで併記する**（例：`失敗 (FAILED)`）。理由：管理者はコードで会話し、顧客は日本語で読む。両方出せば翻訳の食い違いが起きない。

---

## 7. 各メニュー項目の詳細

### 7.1 取込の状況（`menuShowImportStatus`）

**目的**：§1 の事故を最初の1回で見つける。開いて10秒で「異常があるか・何件か・最後に動いたのはいつか」が分かること。

**呼び出す既存関数と新設関数**

| 関数 | 所在 | 役割 |
|---|---|---|
| `collectImportStatus_(options)` | `97_Ops.gs` に**新設**（§9.4） | 恒久ファイルインデックス・処理ログ・処理リース・要確認を**それぞれ1回だけ**読み、結合して返す |
| `permanentIndexRowsForScan_()` | `10_DriveScanner.gs` | ファイルごとの内部状態（正本）と `customerId` |
| `readSheetRows_(processLogSheet_(), PROCESS_LOG_WIDTH_)` | `01_DataAccessCore.gs` / `60_ProcessLog.gs` | 件数（R〜V列）・開始／終了・心拍・エラー |
| `activeLeases_()` | `11_FileStateManager.gs` | 有効リース（処理リースシートを1回読む） |
| `leaseIsStalled_(purpose, ageSeconds, processState)` | `97_Ops.gs` に**新設**（純粋関数。§9.4） | 停滞判定。`detectStalledLeases()` は**呼ばない**（下記） |
| `assessImportStatus_(scoped, now, watch)` | `97_Ops.gs` に**新設**（純粋関数。v1.1・v1.2。`work/spec_notifications.md` §9.2） | 警告行の判定。`buildImportStatusView_` が呼ぶ。日時変換は `97_Ops.gs` の `menuStatusDate_` を使う（`96_Menu.gs` の `menuDateMilliseconds_` を使うと 97 → 96 の依存になる） |
| `readNotificationWatch_()` | `95_Notifications.gs`（v1.2。同 §13.3） | `watch`（§7.1 v1.2 追記）の読取。Script Properties の `getProperties` 1 回。読取のみ |
| `openReviews({})` | `50_ReviewStore.gs` | 未解決の要確認 |
| `ScriptApp.getProjectTriggers()` | GAS | 定期取込トリガー（この操作者が作成した分のみ。§3.5） |

**`detectStalledLeases()` を呼ばない理由**：同関数は内部で `activeLeases_()` を呼び直し（`11_FileStateManager.gs` 175〜177行）、さらに `PROCESS` リースごとに `getProcessLogRecord_` を呼ぶ。後者はこの実行で初めて触るファイルIDについてキャッシュ未命中となり、`findRowsByColumnValue_` で鍵列と該当行の**2往復**を使う（`60_ProcessLog.gs` 57〜70行、`01_DataAccessCore.gs` 158〜187行）。処理リースと処理ログは `collectImportStatus_` が既に丸ごと読んでいるので、**その手元のデータから同じ判定を再現する**。判定式は `detectStalledLeases` と同一に保ち、**`lastHeartbeat` から経過秒を出す日時変換だけは §6.4 の経路に従う**（既存は `new Date(lease.lastHeartbeat)` を直接使うため、セルが日付型でシリアル値が返る場合に狂う。U-8。仕様側の経路が正しいので、判定式は変えず、日時変換だけ §6.4 に従う。`detectStalledLeases` 自体は本仕様では直さない）：

```
leaseIsStalled_(purpose, ageSeconds, processState)
  = ageSeconds が有限 かつ ageSeconds > SETTINGS.HEARTBEAT_TIMEOUT_SECONDS
    かつ ( purpose === 'WRITE_ONLY'
        ∨ processState === null            // 処理ログ行が無い（孤児リース）
        ∨ processState ∈ {VALIDATING, WRITING} )
```

`processState` は、そのリースの `fileId` を処理ログ（既読）の H列で引いた行の Q列（`internalState`）。行が無ければ `null`。`ageSeconds = (now − lastHeartbeat) / 1000`（`lastHeartbeat` は §6.4 の規則で `Date` に直す）。`detectStalledLeases` 自体は変更せず、§10.3 のテスト 34 で「同じ入力に対して同じ集合を返す」ことを固定する。

`collectImportStatus_({now})` の戻り値：

```
{
  files: [{fileId, customerId, fileName, state,                 // 恒久インデックス由来
           formatId, readCount, autoCount, reviewCount, excludedCount, errorCount,
           errorDropped,                                          // v1.2：W列先頭の打切りマーカーの droppedCount（無ければ 0）
           startedAt, endedAt, lastHeartbeat, lastError,          // 処理ログ由来（無ければ null / 0）
           lease: {leaseId, purpose, owner, lastHeartbeat, stalled} | null}],
  leases: [{leaseId, customerId, fileId, purpose, owner, lastHeartbeat, stalled}],
  reviews: [{reviewId, customerId, customerName, reviewType, status, fileId, fileNameOriginal,
             merchantOriginal, originalDate, originalAmount, registeredAt}],
  lastActivityAt: string|null   // files[].startedAt/endedAt/lastHeartbeat と leases[].lastHeartbeat の最大（ISO文字列に正規化）
}
```

`lastError` の作り方：処理ログ W列（`errors`、JSON配列）を **`try/catch` の中で** `jsonCell_(value, [])` により解析する。`jsonCell_` は不正な JSON に対して `null` を返さず `TypeError` を投げる（`01_DataAccessCore.gs` 274〜277行）ので、包まないと **W列が1行壊れているだけで「取込の状況」「ファイル一覧」全体が表示できなくなる**。例外時・配列でないとき・空のときは `null`。配列なら、`{truncated: true}` の打切りマーカー（`recordError` は配列の**先頭**に置く。`60_ProcessLog.gs` 252行）を除いた**末尾要素**を取り、`code + ': ' + detail` にして 160 文字で切る。根拠：`recordError` の呼出元（`71_RunOrchestrator.gs` 308行・525行）は `{code, detail}` を積む。

**顧客フィルタ**：`files` `leases` `reviews` を `customerId ∈ scope.customerIds` で絞る。`customerId` が空の行は**オーナーにだけ**表示し、顧客名を `（顧客不明）` とする。理由：顧客IDの無い行は異常であり、隠すと誰も気づかない。

**集計（`buildImportStatusView_(collected, scope, now, triggerCount, watch)` が純粋関数として行う。§6.1・§9.3 と同じ。第 5 引数 `watch` は v1.2 で追加・省略可）**

- 内部状態ごとの件数（9状態すべて。0件でも行を出す。理由：「行が無い」と「0件」を読み分けさせない）。
- `stuckSuspects`：`state ∈ {VALIDATING, WRITING}` かつ（有効リースが無い、または そのリースが `stalled`）のファイル数。**この定義が正**である。`opsInspectStuckFiles`（`97_Ops.gs` 460〜462行）は状態だけで選びリースを見ないが、あちらは「何が起きたか調べる」対象を広く取る関数であり、ここは「止まっている疑い」を警告する数なので、**生きたリースを持つ処理中ファイル（今まさに取込中）を数えてはならない**。数えると、定期取込が動くたびに警告が出て警告が信用されなくなる。
- `filesWithErrors`：`errorCount > 0` のファイル数。
- 明細の累計：`readCount` `autoCount` `reviewCount` `excludedCount` `errorCount` の合計（全状態）。仕様 §21.2 の項目（明細数・自動確定・要確認・除外・エラー）に対応する。**「処理後の完了表示」ではなく累計である**ことを見出しに書く。
- 要確認：件数と、種別ごとの件数（付録 A のラベル、件数降順）。
- リース：有効数・停滞数。
- 最終活動：`lastActivityAt` と `describeAge_`。
- 定期取込トリガー：`ScriptApp.getProjectTriggers()` のうち `getHandlerFunction() === SCHEDULED_IMPORT_HANDLER_` の件数。

**警告行**（該当するものを全部、この順で。1つも無ければ「異常は見つかりませんでした」）

| 条件 | 文言 |
|---|---|
| `FAILED > 0` | `⚠ 失敗したファイルが N 件あります。「ファイル一覧」で内容を確認し、管理者へ連絡してください（対処: opsRetryFailedFiles）` |
| `stuckSuspects > 0` または 停滞リース > 0 | `⚠ 処理が止まったままのファイルが N 件あります（心拍途絶）。管理者へ連絡してください（対処: opsReleaseStalledLeases → opsRecoverStuckFiles）`。**N は「`stuckSuspects` に該当するファイルの `fileId` の集合」と「停滞リース（`stalled`）が指す `fileId` の集合」の和集合の要素数。** 理由：両者は一致しない（`WRITE_ONLY` の停滞リースは `COMPLETED`／`REVIEW_WAIT` のファイルに残り `stuckSuspects` に入らないが、そのファイルの解決操作を `LEASE_CONFLICT` で塞ぐので数える価値がある。設計 INV-20）。同じファイルが両方に該当しても1件と数える |
| `CUSTOMER_FIX_REQUIRED > 0` | `⚠ 顧客の修正待ちが N 件あります。元ファイルを直して再提出してください（【要修正】の付いたファイル）` |
| `DISCOVERED > 0` かつ `lastActivityAt` が 30 分より前（または null） | `⚠ 取込待ちが N 件ありますが、30分以上動きがありません。定期取込が止まっている可能性があります（対処: opsStartScheduledImport）` |
| `filesWithErrors > 0`（上のどれにも該当しないファイルに限る） | `△ エラー記録のあるファイルが N 件あります。「ファイル一覧」の「最後のエラー」を確認してください` |

30分の根拠：定期取込は10分間隔（`opsStartScheduledImport`）。3回分動かなければ止まっているとみなしてよい。

（v1.2 追記）上の表に **2 行目として次を追加する**（`FAILED > 0` の直後、`stuckSuspects` の前。該当ファイルは `covered` に加え、以降の行から除く）：

| 条件 | 文言 |
|---|---|
| `DISCOVERED` かつ `errorTotal ≧ 1` かつ **`watch[fileId]` があり `errorTotal > watch[fileId]`**（前回の通知評価で取込待ちだったときよりエラー記録の生涯累計が**増えた**）のファイルが 1 件以上。`errorTotal = errorCount + errorDropped` | `⚠ 取込に繰り返し失敗して取込待ちに戻っているファイルが N 件あります。定期取込のたびに同じ失敗を繰り返している可能性があります（対処: 処理ログ W列の最新のエラーを確認し、原因を直してから opsReprocessFile）` |

`watch` は `{fileId: errorTotal}` の記憶で、**メール通知側（`work/spec_notifications.md` §7.8）が Script Properties に持ち、画面は読むだけ**である。`menuShowImportStatus` が `readNotificationWatch_()`（`95_Notifications.gs`。読取のみ）を `try/catch` で呼び、`buildImportStatusView_(collected, scope, now, triggerCount, watch)` の第 5 引数に渡す（失敗・未設定は `null` ＝ 空）。`watch` が空なら、この行は出ない（他の判定は変わらない）。

追加の理由：§1 の事故（2026-09-09）は、ファイルが `DISCOVERED` のまま 10 分ごとにエラー記録だけを増やし続けた。既存の 5 行ではこれは `△ エラー記録のあるファイル` にしか該当せず、**開いた瞬間に「要対応」と読めない**。「N 件以上」ではなく「増えた」にするのは、V列 `errorCount` が巻戻しで消えないためである ── 「2 件以上」にすると、過去に 2 回失敗したファイルを管理者が原因を直して巻き戻した直後にも要対応が出て、**直した直後に鳴る警報は人に警報を無視させる**。「増えた」なら、巻き戻して待っている間は鳴らず、直したはずなのにまた失敗したときにだけ鳴る。比べる値が `errorCount` ではなく `errorTotal`（V列 ＋ W列打切りマーカーの `droppedCount`）なのは、**V列は生涯累計ではない**ためである：`recordError`（`60_ProcessLog.gs` 249〜253行）は W列を `MAX_ERROR_RECORDS_PER_FILE`（200）で切り詰め、V列はマーカーを除いた件数なので打切り後は 199 で頭打ちになる。10 分ごとの失敗なら約 33 時間で頭打ちに達し、`errorCount` だけを比べると「増えた」が偽になってこの行が**黙って消える**。`droppedCount` は打切りのたびに増え続けるので、合計 `errorTotal` は頭打ちが無い。W列が壊れた JSON のときは `errorDropped` が 0 になり、199 到達後はこの行が出なくなる（取りこぼす範囲。通知の実行結果層 `RUN_FILE_FAILED` が 6 時間ごとに拾い続ける）。「増えた」の判定にはスナップショットに無い記憶が要るので、通知側の記憶を借りる。通知の評価（定期取込の先頭・監視トリガー）が一度も走っていない環境ではこの行は出ないが、`△ エラー記録のあるファイル`・`⚠ 取込待ちが…30分以上動きがありません` で気づける。この行は `work/spec_notifications.md` §5.1 の `REPEATED_FAILURE`（要対応）と同一である。

（v1.1 追記）上の警告行の**判定式・順序・文言はメール通知と共有する**。`work/spec_notifications.md` §9 に従い、判定は `97_Ops.gs` の `assessImportStatus_(scoped, now, watch)` へ抽出し、`buildImportStatusView_` はその戻り値の `findings[].line` を並べるだけにする。本節の表が判定の正本であることは変わらず、既存 5 行の文言と相対順序は一字一句変わらない（テスト 9〜11 で固定。それらは 4 引数で呼ぶので `watch` が無く、v1.2 の追加行は出ない）。画面の末尾に通知の状態を示す 2 行が加わる（同 §14）。

**表示形式**：`alert`。本文の例（見出し行は §6.3）：

```
実行者: a@example.com
対象顧客: テスト顧客(TEST01)　取得: 2026-09-10 12:34

⚠ 失敗したファイルが 2 件あります。「ファイル一覧」で内容を確認し、管理者へ連絡してください（対処: opsRetryFailedFiles）

■ ファイル（合計 33）
  失敗 (FAILED): 2
  要修正 (CUSTOMER_FIX_REQUIRED): 1
  処理中で停止の疑い: 0
  未処理 (DISCOVERED): 0
  処理中 (VALIDATING/WRITING): 0
  要確認待ち (REVIEW_WAIT): 3
  完了 (COMPLETED): 27　取消済 (CANCELED): 0　対象外 (EXCLUDED): 0
■ 明細（累計）
  読取 636 / 自動確定 590 / 要確認 40 / 除外 4 / エラー 2
■ 未解決の要確認: 12（取引先 10、日付 2）
■ リース: 有効 0 / 停滞 0
■ 最終活動: 2026-09-10 12:20（14分前）
■ 定期取込トリガー（この操作者が作成した分）: 0 件
  ※ 他の人が作成したトリガーはここに出ません
```

**件数が多い場合**：一覧を含まないので上限なし。本文は常に 30 行以内に収まる。

**失敗時**：§8。

**往復回数**：`collectImportStatus_` の Sheets API 読取（`batchGet`）は、**恒久インデックス 1・処理ログ 1・処理リース 1・要確認 1 の計 4 回ちょうど**とし、ファイル数・要確認数・リース数のいずれにも依存させない。`getProcessLogRecord_`・`detectStalledLeases`・`getCustomerById` を中で呼ばない（顧客名は `scope.customerNameById` から引く）。§10.3 のテスト 12 で「リースが 2 件ある状態でも 4 回」を固定する。（v1.2）これとは別に、`menuShowImportStatus` は `readNotificationWatch_()` と通知状態の表示（`work/spec_notifications.md` §14）のために Script Properties の `getProperties` を **1 回**呼ぶ（`collectImportStatus_` の外。テスト 12 が数える `batchGet` には含まれないので「4 回ちょうど」は変わらない）。理由：メニューは押した人を待たせる。`opsShowFileStates` のようにファイルごとに処理ログを引くと、33 ファイルで 30 秒、300 ファイルで数分になる（往復1回 0.5〜0.8 秒。メモリ `gas-round-trip-budget.md`）。

### 7.2 ファイル一覧（`menuShowFileList`）

**目的**：どのファイルがどの状態で、何が起きたかを1画面で見る。仕様 §7.1「処理状態の正本は内部ログ」を人が読む窓。

**呼び出す関数**：`collectImportStatus_({now})`（§7.1 と同じ。二重に集めない）。

**表示形式**：`modal`（表）。列：

| 列 | 内容 |
|---|---|
| 状態 | 付録 A ラベル ＋ コード。`stuckSuspects` 該当なら末尾に `（停止の疑い）` |
| ファイル名 | 恒久インデックス C列（`originalFileName`）から状態接頭辞を**表示時に剥がしたもの**。剥がすのは既存の `removableStatePrefixRegex_()`（`11_FileStateManager.gs` 40〜46行）を使い `String(name).replace(removableStatePrefixRegex_(), '')` とする。**新しい関数や正規表現を作らない。** 理由：C列は `createOrUpdateProcessLog` が発見時の名前をそのまま書く（`60_ProcessLog.gs` 100・119行）ため、発見時点で既に接頭辞が付いていたファイル（取消し後の再発見など）は接頭辞付きで入る。`opsReprocessByFileName` が `^【[^】]*】` で剥がして照合している（`97_Ops.gs` 860・864行）のはその兆候だが、あの正規表現は**状態接頭辞以外の `【…】` も消す**。顧客が自分で付けた `【経費】` のような接頭辞を表示から消すのは行き過ぎであり、`removableStatePrefixRegex_` は `STATE_TO_PREFIX` の値だけを（長い順に、先頭1個だけ）剥がすので、INV-12「この値集合だけが、元ファイル名から除去してよい接頭辞の全体」に沿う。`STATE_TO_PREFIX` の全値で剥がれ、それ以外の `【…】` が残ることを §10.3 のテスト 35 で固定する |
| 顧客 | `customerNameById[customerId]`、無ければ `（顧客不明）` |
| 形式 | 処理ログ O列 `formatId`、無ければ `-` |
| 件数 | `読取 R / 自動 A / 要確認 V / 除外 X / エラー E` |
| 開始 | `formatMenuTimestamp_(startedAt)` |
| 終了 | `formatMenuTimestamp_(endedAt)` |
| リース | 無ければ `-`。あれば `{用途ラベル} 心拍から {describeAge_}` ＋ 停滞なら `（停滞）` |
| 最後のエラー | `lastError`、無ければ `-` |

**並び順**：状態の優先度（`FAILED` 0 → `CUSTOMER_FIX_REQUIRED` 1 → `VALIDATING`/`WRITING` 2 → `REVIEW_WAIT` 3 → `DISCOVERED` 4 → `COMPLETED` 5 → `CANCELED` 6 → `EXCLUDED` 7 → 不明な状態 8）→ 顧客名 → 開始日時**降順**（新しいものが先）→ ファイル名。

**件数が多い場合**：上限 300 行。フッターに「他 N 件は表示していません（完了・取消済・対象外から順に省いています）」。表の上に状態ごとの件数を1行で出す（§7.1 と同じ数字）。

**失敗時**：§8。

### 7.3 要確認を開く（`menuOpenReview`）

**目的**：未解決の要確認を、**誰が対応すべきか**とともに見る（仕様 §21.2「誰が何をすべきかを具体的に案内する」）。

**呼び出す関数**：`openReviews({})`（`50_ReviewStore.gs`。戻り値は `reviewFromRecord_` の形で `customerId` `customerName` `fileNameOriginal` `merchantOriginal` `originalDate` `originalAmount` `registeredAt` `status` を含む）。`opsShowOpenReviews` と同じデータ源だが、あちらは `Logger` 出力が主目的なので呼ばない。

**顧客フィルタ**：`review.customerId ∈ scope.customerIds`（空はオーナーのみ）。

**表示形式**：`modal`（表）。表の上に「未解決 N 件（取引先 10、日付 2、…）」（種別ラベル、件数降順）。列：

| 列 | 内容 |
|---|---|
| 種別 | 付録 A ラベル ＋ コード |
| 担当 | 付録 A の「担当」列（確認担当者／システム管理者／顧客） |
| 状態 | `OPEN` → `未着手`、`IN_PROGRESS` → `対応中` |
| 顧客 | `customerName`（空なら `customerNameById` で補う） |
| ファイル名 | `fileNameOriginal` |
| 店名（元表記） | `merchantOriginal`、無ければ `-` |
| 利用日 / 金額 | `originalDate` を `formatMenuTimestamp_` の日付部分（先頭10文字）、`originalAmount` はそのまま。無ければ `-` |
| 登録 | `formatMenuTimestamp_(registeredAt)` |

Z列（検出詳細 JSON）は表示しない。理由：大きく、担当者の判断材料は解決画面（未実装）の責務。

**リンク**：表の下に「要確認シートを開く」→ `masterSpreadsheet_().getUrl() + '#gid=' + reviewSheet_().getSheetId()`。

**並び順**：`registeredAt` 昇順（待たせている順）→ `reviewId`。

**件数が多い場合**：上限 200 行。フッターに「他 N 件は表示していません」。

**失敗時**：§8。

### 7.4 処理ログを開く（`menuOpenLog`）

**目的**：処理ログシート（`CONFIG.SHEET_NAMES.PROCESS_LOG`＝「クレカ処理ログ」）へ移動する。

**呼び出す関数**：`processLogSheet_()`（`60_ProcessLog.gs`）。

**表示形式**：`navigate`（§6.2）。コンテナがマスターで、シートが非表示でなければ `setActiveSheet`。**`setActiveSheet` に渡す `Sheet` は、`processLogSheet_()` の戻り値ではなく、`SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAMES.PROCESS_LOG)` で取り直したもの**を使う。理由：`processLogSheet_()` は `openById` 由来の別 `Spreadsheet` インスタンスに属する `Sheet` であり、同じファイルを指していても別インスタンスの `Sheet` を `setActiveSheet` に渡して動く保証が無い（未確認）。同じ `Spreadsheet` から取れば疑問が残らない。

役割分担を固定する（B）：

- **`fn`（`menuOpenLog` 側）**が `masterSheet = processLogSheet_()` を取り（マスターにシートが無ければここで `Required sheet not found` が投げられ §8 行4 になる）、**`masterSheet.isSheetHidden()` を見て `fallbackHtml` を組む**。`fallbackHtml` の内容：リンク「クレカ処理ログを開く」（`masterSheet.getParent().getUrl() + '#gid=' + masterSheet.getSheetId()`）。非表示なら「処理ログシートは非表示になっています。管理者に再表示を依頼してください」を併記する（**再表示は書込なので行わない**）。戻り値は `{kind: 'navigate', sheetName: CONFIG.SHEET_NAMES.PROCESS_LOG, masterSheet, fallbackHtml, title}`。
- **`presentMenuResult_`**は移動できるかだけを判定する（§6.2）。`active.getSheetByName(sheetName)` が **`null` を返した場合も、非表示の場合も、コンテナ≠マスターの場合も、すべて `fallbackHtml` の `modal` を出す**（A）。`null` を例外にしない理由：`fn` が `processLogSheet_()` で既にマスター上の存在を確かめているので、コンテナ＝マスターなのに `null` になるのは実質起きない。起きたとしても利用者に必要なのは「リンクから開く」手段であり、エラー画面ではない。

**顧客フィルタ**：シートそのものへ移動するので絞れない。§4.4 の限界のとおり、マスターを開ける人は元々全行を読める。ダイアログで「このシートは全顧客の行を含みます」と注記しない（読める人にとって自明であり、注記は騒がしいだけ）。

**失敗時**：§8（`Required sheet not found` はシート欠落の文言になる）。

### 7.5 診断 ▸ リースの状況（`menuShowLeases`）

**目的**：「なぜこのファイルが動かないか」を見る。`opsShowLeases` の画面版。

**呼び出す関数**：`collectLeaseStatus_({now})`（`97_Ops.gs` に**新設**。`opsShowLeases` の本体から抽出。§9.4）。戻り値：

```
[{leaseId, customerId, fileId, fileName, fileState, purpose, owner,
  lastHeartbeat, ageSeconds, detectable, releasable}]
```

`detectable = ageSeconds > SETTINGS.HEARTBEAT_TIMEOUT_SECONDS`、`releasable = ageSeconds > SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS`（`opsShowLeases` の「検出可／解放可」と同じ式。`detectable` は心拍だけを見る粗い指標であり、§7.1 の `stalled`（`leaseIsStalled_`）とは別物なので列名も分ける）。`fileName`・`fileState` は処理ログから（無ければ `(不明)`）。ここでは既存 `opsShowLeases` と同じく、リースごとに `getProcessLogRecord_` を呼んでよい（リースは通常 0〜数件で、§7.1 のように全処理ログを読む方が高くつく）。

**表示形式**：`modal`（表）。列：ファイル名 / 顧客 / 内部状態 / 用途（付録 A）/ 所有者 / 心拍から（`describeAge_`）/ 検出（可・不可）/ 解放（可・不可）/ ファイルID。0件なら表の代わりに「有効なリースはありません」。

**並び順**：`ageSeconds` 降順。

**件数が多い場合**：上限 100 行（リースは通常数件）。

**失敗時**：§8。`activeLeases_()` は非 `ACTIVE` 行があると `IntegrityError` を投げる。そのまま §8 の汎用文言で表示する（「処理リースシートに ACTIVE 以外の行があります」と読める `message` になる）。

### 7.6 診断 ▸ 設定の検査（`menuCheckSettings`）

**目的**：定期取込が `SETTINGS_INVALID` で止まっているとき、**どの検査項目が落ちているか**を見る。

**呼び出す関数**：`validateSettings(VALIDATION_SCOPE.IMPORT, context)`（`05_SettingsValidator.gs`）。`context` は `runImport` が渡すものと**同一**にする：`{customerFolderIds: scope.customers.map(c => c.sourceFolderId), corpusFolderAccessible: true, corpusFolderAncestors: []}`。理由：ここで `ok` なら `runImport` の step 2 も通る、という対応を保つため。

**呼ばない関数**：`validateCustomerAccess`（書込プローブを含む。§2.4）。`assertSafeToWrite`（例外を投げる形。結果を表示したいだけ）。

**表示形式**：`alert`。本文：

```
（見出し行）

設定検査（scope = IMPORT）: 合格 / 不合格
  #1 masterSpreadsheet: OK
  #2 requiredSheets: NG ── missing sheets: 承認申請
  ...（settingsChecksFor('IMPORT') の全項目を id 順に。OK は "OK"、NG は detail）
Script Properties から読み込んだ設定: N 件（無視した不明キー: M 件）
```

`loadSettingsFromProperties()` の戻り値（`{loaded, ignored}`）を最終行に使う。`runMenuAction_` が既に呼んでいるので、この項目では戻り値を得るために**もう一度呼ぶ**（冪等。読取のみ）。

**失敗時**：§8。

### 7.7 診断 ▸ タグ付き取引を検索（`menuFindTaggedTransactions`）

**目的**：メモタグ（海外決済・キャッシュバック等）と相手税区分が実際に転記先へ届いたかを確認する。`opsShowTaggedTransactions(tag)` の画面版。

**入力**：`ui.prompt('クレカ自動処理 ― タグ付き取引を検索', 'メモタグを入力してください（例：海外決済、キャッシュバック）。空欄なら「海外決済」', ui.ButtonSet.OK_CANCEL)`。`getSelectedButton() !== ui.Button.OK` → `{kind: 'none'}`。応答テキストは `trim` し、空なら `'海外決済'`（`opsShowTaggedTransactions` の既定と同じ）。

プロンプトは `runMenuAction_` の `fn` の中で `menuUi_()` を再取得して呼ぶ（`fn` は `scope` と `now` しか受け取らないため）。**プロンプトを呼ぶのはこの項目だけ**。

**呼び出す関数**：`collectTaggedTransactions_(tag)`（`97_Ops.gs` に**新設**。`opsShowTaggedTransactions` の本体から抽出。§9.4）。戻り値：

```
[{customerId, fileId, merchant, memo, taxPlanned, taxVerified, destinationRow, fullTxId}]
```

取引ログの列対応（`txLogFromRecord_` より）：`customerId = v[3]`、`fileId = v[4]`、`merchant = v[15]`、`memo = v[20]`（予定値 I 列）、`taxPlanned = v[45]`、`taxVerified = v[46]`、`destinationRow = v[30]`、`fullTxId = v[0]`。`toBool(v[41])` が偽（無効化行）は除外。照合は `normalizeMerchant(memo).indexOf(normalizeMerchant(tag)) >= 0`（既存と同じ）。

**顧客フィルタ**：`customerId ∈ scope.customerIds`。

**表示形式**：`modal`（表）。表の上に「タグ「{tag}」: N 件」。列：店名（28文字で切る）/ 顧客 / メモタグ / 税区分 予定 / 税区分 確認 / 転記行 / 取引ID（先頭12文字）。0件なら「該当なし」。

**並び順**：取引ログの行順（既存と同じ）。

**件数が多い場合**：上限 200 行。

**既知の制約**：取引ログ全体を1回で読む（`readSheetRows_(transactionLogSheet_(), 47)`）。行数が数万になると応答が重くなる。現状 636 行。将来 `TX_INDEX_LOOKBACK_MONTHS` 相当の絞込を入れる余地があるが本仕様では行わない（既存 `ops*` と同じ読み方であり、挙動を変えない）。

**失敗時**：§8。

### 7.8 診断 ▸ タグ遡及の対象ファイル（`menuShowTagBackfillTargets`）

**目的**：メモタグ・税区分の規則を変えた後、**取り込み直しが必要なファイル**を実行前に見る。`opsBackfillMemoTags`（書込）の参照側の半分。

**呼び出す関数**：`collectTagBackfillTargets_()`（`97_Ops.gs` に**新設**。`opsFilesNeedingTagBackfill` の本体から抽出。§9.4）。戻り値：

```
[{fileId, customerId, fileName, state, contentHash: 'あり'|'なし', stale: string[]}]
```

`customerId` は取引ログ D列（`v[3]`）から取る。**普通の列挙可能プロパティ**として持たせる（`Object.defineProperty` で非列挙にしない。理由は §9.4）。

`opsFilesNeedingTagBackfill()` は**呼ばない**。あちらは `collectTagBackfillTargets_()` の結果から `customerId` を**落として**従来どおりの `{files, fileNames, detail}` を組み立てる関数であり、メニューが必要とする顧客IDを持たない。

**顧客フィルタ**：`collectTagBackfillTargets_()[].customerId ∈ scope.customerIds`。

**表示形式**：`modal`（表）。表の上に「取り込み直しが必要なファイル: N 件」。列：ファイル名 / 顧客 / 内部状態（付録 A）/ 提出時ハッシュ（あり／なし）/ 遅れている取引数（`stale.length`）/ 例（`stale` の先頭2件を `<br>` で連結）。0件なら「対象はありません（すべて現行の規則どおりです）」。表の下に注記：「取り込み直しは管理者が opsBackfillMemoTags で行います」。

**件数が多い場合**：上限 100 行。

**失敗時**：§8。

### 7.9 診断 ▸ このメニューについて（`menuShowAbout`）

**目的**：「何も表示されない」「他の人には見えるのに自分には見えない」の切り分け。U-1・U-2 の実機確認にも使う。

**呼び出す関数**：`menuViewerScope_()`（既に `runMenuAction_` が呼んでいる結果を使う）、`resolveMasterSpreadsheetId_()`、`masterSpreadsheet_()`、`SpreadsheetApp.getActiveSpreadsheet()`、`VERSIONS.CODE`。

**表示形式**：`alert`。本文：

```
（見出し行）

実行者: a@example.com（オーナー: はい/いいえ）
閲覧できる顧客: テスト顧客(TEST01)
マスタースプレッドシート: {resolveMasterSpreadsheetId_() の値、無ければ '(未設定。アクティブなスプレッドシートを使用)'}
このスプレッドシート: {getActiveSpreadsheet().getId()、無ければ '(なし)'}
両者の関係: 一致 / 不一致
コード版: 3.0.0
このメニューは参照専用です。取込・確定・取消しなどの操作は含みません（認可モジュール実装まで）。
```

**失敗時**：§8。ただしこの項目は `menuViewerScope_` の**拒否理由も見たい**画面なので、`AuthorizationError` のときは §8 の文言に加えて「このスプレッドシート: …」「マスター: …」の2行を付ける。実装は `runMenuAction_` に `{showBindingOnAuthError: true}` のようなオプションを持たせるのではなく、`menuShowAbout` の中で `menuViewerScope_` を自前で `try/catch` して `alert` の本文を組み立てる（この項目だけ骨組みから外れることを関数コメントに書く）。

---

## 8. エラー時の挙動

`runMenuAction_` が捕捉した例外を次の順で分類し、`ui.alert('クレカ自動処理 ― エラー', 本文, OK)` で表示する。本文の先頭は項目名（例：「取込の状況 を表示できませんでした。」）。判定は `classifyMenuError_(error)`（純粋関数、`96_Menu.gs`）が行い、`{title, lines}` を返す。

| 順 | 判定 | 本文（項目名の行に続けて） |
|---|---|---|
| 1 | `error instanceof AuthorizationError` | **`error.detail` をそのまま**2行目に（§4.1・§4.2 により、それが §4.2 の全文である）。`error.message` は使わない（先頭に「処理を実行できません: 」が付く。`06_ErrorCatalog.gs` 81〜82行）。`detail` が空なら `error.message` |
| 2 | `error.code === 'CUSTOMER_MASTER_INVALID'` かつ `message` に `MASTER_SPREADSHEET_ID` を含む | 「マスタースプレッドシートが設定されていません。管理者が Script Properties の MASTER_SPREADSHEET_ID を設定してください。」 |
| 3 | `error.code === 'CUSTOMER_MASTER_INVALID'`（上記以外） | 「顧客マスターの内容に不備があります: {message}。管理者へ連絡してください（対象年度の未設定などは顧客マスターの是正が必要です）。」 |
| 4 | `message` が `/Required sheet not found: (.+)/` に一致 | 「マスタースプレッドシートに必要なシート「{名前}」がありません。管理者へ連絡してください。」 |
| 5 | `error instanceof ReferenceError` かつ `message` に `Sheets is not defined` | 「Sheets API サービスが有効になっていません（appsscript.json の enabledAdvancedServices）。管理者へ連絡してください。」 |
| 6 | `error.code === 429` または `message` が `/Quota exceeded/i` に一致 | 「読取の割当（1分あたりの上限）を超えました。1分ほど待ってから再実行してください。」 |
| 7 | `message` が `/Cannot call SpreadsheetApp.getUi/` に一致 | 表示できない文脈。**再送出する**（§6.1 手順1。分類表に載せるのは判定順を固定するため） |
| 8 | それ以外 | 「エラー: {error.name}: {error.message}」。`error.code` があれば「コード: {code}」を追加。「管理者へ連絡してください。詳細は Apps Script の実行ログにあります。」 |

すべての場合で `Logger.log('[menu] ' + actionName + ' failed: ' + (error.stack || String(error)))` を残す。ダイアログにスタックトレースは出さない（読めないし、長い）。

**設定未投入**（`SETTINGS.EXECUTION_TIMEOUT_SECONDS` 等が null）は参照系の実行を妨げない（`validateSettings` を掛けないため。§6.1）。ただし `HEARTBEAT_TIMEOUT_SECONDS`・`LEASE_FORCE_RELEASE_MIN_SECONDS` は `00_Config.gs` に既定値（300・600）があるので停滞判定は常に動く。

**部分的な失敗**：`collectImportStatus_` の中で処理ログの読取だけが失敗した場合も、全体を失敗として扱う（半分の情報を出すと、欠けた側を「0件」と誤読する。§7.1「行が無い」と「0件」を読み分けさせない、と同じ理由）。

---

## 9. ファイル名・配置・既存コードの改修方針

### 9.1 ファイル名：`src/96_Menu.gs`

設計 §4.2 は `01_Menu.gs` を指定している。`01_Menu.gs` という**ファイル名自体は空いている**（使われているのは `01_` という接頭辞であり、`01_DataAccessCore.gs` と `01_Menu.gs` は共存できる）。それでも `96_Menu.gs` にする。理由：

1. **読込順**。GAS はプロジェクト内のファイルを並び順にグローバルスコープ評価する。clasp push 後の順序は `filePushOrder` 未指定なら名前順とされ（→ U-5）、Node ハーネス（`test/gas-harness.js`）も `localeCompare(a, b, 'en')` で名前順に読み込む。本プロジェクトは既にこの順序に依存している（例：`06_ErrorCatalog.gs` がグローバルスコープで `REVIEW_TYPE`（`00_Config.gs`）を参照）。`01_Menu.gs` に置くと `06_`・`97_` 等より先に評価され、うっかりグローバルスコープでそれらを参照すると**プロジェクト全体が読込時に落ち、定期取込まで止まる**（§3.2）。`96_` なら依存先（`00`〜`95`）がすべて先に評価済みで、この種の事故が構造的に起きない。
2. **配置の意味**。`9x` は運用・試験の入口が並ぶ帯である（`90_Utils` `97_Ops` `98_ReleaseGate` `99_Test`）。メニューは `97_Ops` の薄い層であり、隣に置くのが読み手に自然。
3. 将来、認可付きの完全な `01_Menu.gs`（設計 §4.2）を作る段になったら、ファイルを改名するだけでよい（グローバル関数の名前は位置に依存しない）。

ファイル先頭のコメントに「設計 §4.2 `01_Menu.gs` の参照系部分の暫定実装。`03_Authorization.gs` 実装まで操作系を含めない」と書く。

### 9.2 `96_Menu.gs` の読込時の規律

- **トップレベルには関数宣言と、リテラルだけで作った `var` 定数以外を置かない**。他ファイルのグローバル（`CONFIG` `FILE_STATE` `SETTINGS` `ERROR_CATALOG` …）をトップレベルで参照しない。関数の中でのみ参照する。
- 付録 A のラベル表は `var MENU_FILE_STATE_LABELS_ = {FAILED: '失敗', ...}` のように**文字列キーのリテラル**で書く（`FILE_STATE.FAILED` をキーに使わない）。ラベル表と列挙の対応は §10 のテストで検証する。
- `'use strict';` を先頭に置く（他ファイルと同じ）。

### 9.3 `96_Menu.gs` に置く関数

| 関数 | 公開/非公開 | 責務 |
|---|---|---|
| `onOpen(e)` | 公開 | §5.1 のメニューを組み立てて `addToUi()`。それ以外は何もしない |
| `menuShowImportStatus` `menuShowFileList` `menuOpenReview` `menuOpenLog` `menuShowLeases` `menuCheckSettings` `menuFindTaggedTransactions` `menuShowTagBackfillTargets` `menuShowAbout` | 公開（メニューハンドラ。末尾 `_` なし） | §7 |
| `menuUi_()` | 非公開 | `return SpreadsheetApp.getUi();` の1行 |
| `runMenuAction_(actionName, fn)` | 非公開 | §6.1 |
| `presentMenuResult_(ui, result)` | 非公開 | §6.2 |
| `menuViewerScope_()` | 非公開 | §4.1 |
| `menuHeaderLines_(scope, now)` | 非公開・純粋 | §6.3 |
| `buildImportStatusView_(collected, scope, now, triggerCount, watch)` | 非公開・純粋 | §7.1 の集計と本文。`triggerCount` は呼出側が `ScriptApp` から取って渡す（純粋性のため）。`watch` は v1.2 で追加（省略可。呼出側が `readNotificationWatch_()` で取って渡す）。警告行の判定は `assessImportStatus_`（`97_Ops.gs`）に委ねる |
| `buildFileListRows_(collected, scope, now)` | 非公開・純粋 | §7.2 の `{summaryLine, columns, rows, omitted}` |
| `buildReviewRows_(reviews, scope, now)` | 非公開・純粋 | §7.3 |
| `buildLeaseRows_(leases, scope, now)` | 非公開・純粋 | §7.5 |
| `buildSettingsCheckText_(result, loaded)` | 非公開・純粋 | §7.6 |
| `buildTaggedTransactionRows_(records, scope, tag)` | 非公開・純粋 | §7.7 |
| `buildBackfillRows_(detail, scope)` | 非公開・純粋 | §7.8 |
| `renderMenuTable_(headerLines, columns, rows, footerLines, links)` | 非公開・純粋 | §6.6 |
| `escapeHtml_(s)` `formatMenuTimestamp_(v)` `describeAge_(v, now)` `filterByScope_(items, scope)` `classifyMenuError_(error)` | 非公開・純粋 | 共通。接頭辞の除去は既存 `removableStatePrefixRegex_()` を使い、新設しない（§7.2） |

`filterByScope_(items, scope)`：`items[].customerId` が `scope.customerIds` に含まれるものを返す。空文字は `scope.isOwner` のときだけ通す（§7.1）。

### 9.4 `97_Ops.gs` の改修（既存の戻り値・ログ出力は変えない）

「メニューは既存の参照ロジックを呼ぶ薄い層」であるべきだが、既存 `ops*` の多くは**平たい文字列を返す**（`clasp run` が入れ子を `[Array]` と省略するため。`opsCountFileStates` のコメント）か、**`customerId` を持たない**。顧客単位に絞るには構造化された戻り値が要る。そこで**「集める」部分を関数として抽出し、`ops*` はそれを整形するだけにする**。抽出後も `ops*` の戻り値・`Logger` 出力は一字一句同じでなければならない（`clasp run` の運用と、`opsBackfillMemoTags` のような呼出元を壊さない）。

| 既存関数 | 改修 |
|---|---|
| （新設）`leaseIsStalled_(purpose, ageSeconds, processState)` | §7.1 の停滞判定（純粋関数）。`detectStalledLeases` と同じ式。`detectStalledLeases` 自体は変更しない |
| （新設）`collectImportStatus_(options)` | §7.1 の形を返す。恒久インデックス・処理ログ・リース・要確認を各1回、**計4回ちょうど**読む。`getProcessLogRecord_`・`detectStalledLeases`・`getCustomerById` を呼ばない。`opsShowFileStates` の内部をこれに置き換えてよいが**必須ではない**。置き換える場合、`opsShowFileStates` の戻り値に `customerId`・`customerName` を**追加**（既存キーは維持） |
| （新設・v1.1）`assessImportStatus_(scoped, now, watch)` | §7.1 の警告行の判定（純粋関数）。`collectImportStatus_` の直後に置く。`96_Menu.gs` と `95_Notifications.gs` の両方が呼ぶ。詳細は `work/spec_notifications.md` §9.2 |
| （改修・v1.2）`collectImportStatus_(options)` | `files[]` に `errorDropped` を**追加**（W列先頭の打切りマーカーの `droppedCount`。`lastError` のために既に行っている解析から取る。読取回数は増えない）。既存キーは変えない |
| `opsShowLeases()` | 本体を `collectLeaseStatus_({now})` として抽出（§7.5 の形）。`opsShowLeases` はその結果を既存の1行書式に整形して `Logger.log` し返す。`(リースなし)` の扱いも同じ |
| `opsShowTaggedTransactions(tag)` | 本体を `collectTaggedTransactions_(tag)` として抽出（§7.7 の形）。整形は既存どおり |
| `opsFilesNeedingTagBackfill()` | 本体を `collectTagBackfillTargets_()` として抽出（§7.8 の形。各要素が `customerId` を**普通の列挙可能プロパティ**として持つ）。`opsFilesNeedingTagBackfill` はその結果から `fileId` `fileName` `state` `contentHash` `stale` だけを写した要素で従来どおりの `{files, fileNames, detail}` を組み立て、`Logger.log` し返す。**戻り値・`Logger` 出力は一字も変わらない**（`detail[]` に `customerId` は**含まれない**）。── 当初は「`detail[]` に `customerId` を追加する」としていたが、それは本節冒頭の「戻り値を一字一句変えない」と両立しない（実装者とレビュアーが独立に指摘）。また、その中間案として `Object.defineProperty` で `customerId` を**非列挙**プロパティにして JSON 出力を変えずに済ませる実装があったが撤廃した。非列挙プロパティは `JSON.stringify` や `Object.assign` を挟むと**黙って消え**、消えると顧客フィルタが全件を落として確認担当者に「対象はありません」という**偽の安心表示**を出す。見えない属性に画面の正しさを乗せてはならない |
| `opsCountFileStates()` `opsCountReviewsByType()` `opsShowOpenReviews()` | **変更しない**。メニューはこれらを呼ばず、同じデータ源（`permanentIndexRowsForScan_` `openReviews`）から自分で数える |

`collect*_` は `loadSettingsFromProperties()` を**呼ばない**（呼出側の責務。`ops*` と `runMenuAction_` の両方が既に呼ぶ）。`Logger.log` もしない。

### 9.5 テストスタブの改修（`test/gas-stubs.js`）

§10 参照。

### 9.6 触らないもの

`00_Config.gs`・`01_DataAccessCore.gs`・`02_CustomerMaster.gs`・`05_SettingsValidator.gs`・`appsscript.json` は変更しない。`oauthScopes` は既に必要なものを含む（`spreadsheets` `script.scriptapp` `userinfo.email`）。

---

## 10. テスト方針

### 10.1 現状と方針

- テストは Node 製ハーネス（`test/gas-harness.js`）で `src/*.gs` を `vm` に読み込み、`test/gas-stubs.js` の GAS スタブで動かす。728 件が通っている（2026-09-10 確認）。
- スタブの `SpreadsheetApp` には `getUi` が**無く**、`HtmlService` はコンテキストに**存在しない**。`MemorySpreadsheet` に `getOwner` `setActiveSheet` が無く、`MemorySheet` に `isSheetHidden` が無い。
- 方針：**ロジック（`collect*_`・`build*_`・`classifyMenuError_` 等）は純粋関数として直接テストし、UI は記録型スタブで「何を・どの順で・どの形式で出したか」を検証する。** `SpreadsheetApp` スタブは凍結されていない普通のオブジェクトなので `getUi` を足せる。`HtmlService` はハーネスのコンテキストへ追加する。

### 10.2 スタブに追加するもの

`createGasStubs()` に次を追加し、`control.reset()` で初期化する。

| 追加 | 内容 |
|---|---|
| `SpreadsheetApp.getUi()` | `control.setUiAvailable(false)` のとき `Error('Cannot call SpreadsheetApp.getUi() from this context.')` を投げる。既定は利用可。返す `Ui` は下記 |
| `Ui.createMenu(name)` | `Menu` を返す。`addItem(caption, functionName)` `addSeparator()` `addSubMenu(menu)` `addToUi()`。`addToUi()` で `control.getMenus()` に木構造 `{name, items: [{caption, functionName} \| {separator: true} \| {name, items}]}` を追加 |
| `Ui.alert(...)` | 引数 1〜3 個（`prompt` / `prompt, buttons` / `title, prompt, buttons`）を受け、`control.getUiEvents()` に `{type: 'alert', title, prompt, buttons}` を積む。戻り値は `Button.OK` |
| `Ui.prompt(title, prompt, buttons)` | イベント `{type: 'prompt', ...}` を積み、`control.setPromptResponses([{button: 'OK', text: '海外決済'}, ...])` で与えた応答を順に返す（`getSelectedButton()` `getResponseText()`）。未設定なら `{button: 'CANCEL', text: ''}` |
| `Ui.showModalDialog(output, title)` / `showSidebar(output)` | イベント `{type: 'modal', title, html: output.getContent(), width: output.getWidth(), height: output.getHeight()}` を積む |
| `Ui.ButtonSet` / `Ui.Button` | `{OK, OK_CANCEL, YES_NO, YES_NO_CANCEL}` / `{OK, CANCEL, CLOSE, YES, NO}`（値は同名文字列） |
| `HtmlService.createHtmlOutput(html)` | `{setWidth, setHeight, setTitle, append, getContent, getWidth, getHeight, getTitle}`（set* は連鎖可。幅・高さは内部に保持し、未設定なら `null`）。**追加先は2箇所**：`createGasStubs()` の戻り値（`{Utilities, SpreadsheetApp, …, HtmlService, control}`）と、`gas-harness.js` の `vm.createContext({...})` の列挙。後者を忘れると `src` 側から `HtmlService` が見えず `ReferenceError` になる |
| `MemorySpreadsheet.getOwner()` | `control.setSpreadsheetOwner(id, email)` で設定した `{getEmail: () => email}` を返す。未設定なら `null` |
| `MemorySpreadsheet.setActiveSheet(sheet)` / `getActiveSheet()` | 記録するだけ。`control.getActiveSheetName(id)` |
| `MemorySheet.isSheetHidden()` | `control.hideSheet(id, name)` で真。既定は偽 |
| `control.getUiEvents()` `control.resetUiEvents()` `control.getMenus()` | 検証用 |

`Session.getActiveUser().getEmail()` は既存の `control.setActiveUser(email)` で制御できる（空文字も可）。

### 10.3 テストファイル：`test/phase7-menu-readonly.test.js`

既存の書き方に合わせる（`module.exports = ({test, assert, gas}) => {...}`、`setup()` で `gas.stubs.reset()` → `createSpreadsheet('master')` → `setActiveSpreadsheet('master')` → `setMasterSpreadsheetId('master')` → `provisionMasterSheets` → `registerTestCustomer(...)`。`test/phase6-scheduled-import.test.js` と `test/phase6-setup-helpers.test.js` の `setup()` を雛形にする）。顧客は2社作る（`C001` 担当者 `reviewer@example.com`、`C002` 担当者 `other@example.com`、両方の R列に `admin@example.com`）。**`registerTestCustomer` は転記先スプレッドシートのヘッダー行を読む**（`04_Provisioning.gs` `describeDestinationSheet` 経由）ので、`C001` 用の `dest1` に加えて `C002` 用の `dest2` も `createSpreadsheet` で先に作る。オーナーは `control.setSpreadsheetOwner('master', 'owner@example.com')`。テスト用のスプレッドシートIDは `setActiveSpreadsheet` に渡す前に必ず `createSpreadsheet` しておく（スタブの `openById` は未登録IDで throw する。`gas-stubs.js` `openSpreadsheet`）。

必須ケース（名前は英語でよいが、**理由をコメントに書く**流儀に合わせる）：

**メニュー登録**
1. `onOpen` が §5.1 の木構造（名前・順序・関数名・区切り・サブメニュー）をそのまま登録する。
2. `onOpen` はスプレッドシートを1つも作っていない状態（`reset()` 直後）でも例外を投げず、`apiCallCounts.batchGet === 0` のまま（データを読まない）。
3. §5.1 のすべてのハンドラ名について `typeof {name} === 'function'` で、名前が `_` で終わらない。

**閲覧範囲**
4. `reviewer@example.com` は `C001` のファイル・要確認・リースだけを見る（`C002` のファイル名が `modal` の HTML に**含まれない**ことを検証）。
5. `owner@example.com`（Q/R列に無い）は全顧客を見る。
6. `nobody@example.com` は `AuthorizationError` の文言（§4.2）の `alert` を受け取り、`modal` は出ない。
7. 空メール（`setActiveUser('')`）は「取得できない」文言の `alert`。
8. `customerId` が空の恒久インデックス行は、オーナーには `（顧客不明）` で出て、担当者には出ない。

**取込の状況**
9. `FAILED` 2件・停滞リース1件・`DISCOVERED` 1件かつ最終活動 40 分前、という状況で警告行が §7.1 の**順序どおり**に全部出る。
10. 異常が無いとき「異常は見つかりませんでした」。
11. 9状態すべての行が 0 件でも出る。
12. `collectImportStatus_` の `batchGet` 回数が、**有効リースを 2 件（`PROCESS` 1・`WRITE_ONLY` 1）置いた状態で**、ファイル 3 件のときも 30 件のときも**ちょうど 4**（`test/phase6-round-trips.test.js` と同じ流儀。`gas.stubs.resetApiCallCounts()` → 呼出 → `getApiCallCounts().batchGet`）。リースを置くのは、`detectStalledLeases`／`getProcessLogRecord_` を中で呼ぶ実装がリース数に比例して読取を増やすのを捕まえるため。
13. 明細累計が処理ログ R〜V 列の合計に一致。

**ファイル一覧**
14. 並び順（`FAILED` → … → `EXCLUDED`、同状態内は開始日時降順）。
15. 301 件のとき 300 行に切られ、落ちるのは `COMPLETED` 側で、フッターに「他 1 件」。
16. `lastError` は W列 JSON の末尾要素の `code: detail` で、打切りマーカーは無視される。
17. ファイル名に `<script>alert(1)</script>` を含む行が HTML で `&lt;script&gt;` にエスケープされる。

**要確認**
18. 種別ごとの件数行、担当列（付録 A）、`OPEN`/`IN_PROGRESS` のラベル。
19. リンクに要確認シートの `gid` が含まれる。

**処理ログを開く**
20. コンテナ＝マスターなら `setActiveSheet` が呼ばれ、`modal` は出ない。
21. コンテナ≠マスター（`createSpreadsheet('other')` してから `setActiveSpreadsheet('other')`）ならリンク付き `modal`。
22. シート非表示ならリンク `modal` に「非表示」の注記があり、**`showSheet` 等の書込が呼ばれない**（スタブに `showSheet` が無いので、呼べば `TypeError` で落ちる＝検出できる）。

**診断**
23. `menuCheckSettings` は `validateSettings('IMPORT')` の全項目を id 順に OK/NG で並べる。`runImport` が `SETTINGS_INVALID` で止まる設定では `不合格` と表示される（設定を壊した状態で `runImport` を呼び `stoppedBy` を確認し、同じ状態でメニューが `不合格` を出すことを同一テスト内で確認する）。
24. `menuFindTaggedTransactions` は CANCEL で何も表示せず、空欄 OK で `海外決済` を既定に使い、他顧客の取引を含めない。
25. `menuShowLeases` は `検出可/不可`・`解放可/不可` が `opsShowLeases` の判定と一致する（同じ入力で両方を呼び、件数と可否を突き合わせる）。
26. `menuShowTagBackfillTargets` は `collectTagBackfillTargets_()` と同じファイル集合（顧客で絞った後）を出し、他顧客のファイルを含まない。

**エラー分類**
27. §8 の 1〜6・8 の各分類が対応する文言になる（`classifyMenuError_` を直接呼ぶ）。
28. `setUiAvailable(false)` のとき `menuShowImportStatus` は例外を**そのまま投げる**（`assert.throws`）。
29. 集める途中で例外（例：要確認シートを削除しておく）→ `alert` のエラー表示、`modal` は出ない、`Logger` に `[menu]` 行がある。

**互換**
30. `opsShowLeases()` `opsShowTaggedTransactions('海外決済')` `opsFilesNeedingTagBackfill()` の戻り値と `Logger` 出力が、改修前と同じ形（このテストは改修前に期待値を採取して固定する。`(リースなし)` `(該当なし)` の経路も含む）。
31. `collectTagBackfillTargets_()[i].customerId` が入っており、`Object.keys()` で列挙できる（非列挙プロパティでないことの固定）。同じ状態で `opsFilesNeedingTagBackfill().detail[i]` には `customerId` が**無い**（`hasOwnProperty` が偽。既存の JSON 出力が変わっていないことの固定）。

**ラベル**
32. `FILE_STATE`・`REVIEW_TYPE`・`LEASE_PURPOSE` の全キーにラベルがあり、余分なキーが無い（列挙が増減したらここで落ちる）。

**日時**
33. `formatMenuTimestamp_` が ISO 文字列・`Date`・シリアル値・空を §6.4 どおりに整形し、`describeAge_` の境界（59秒・60秒・59分・48時間）。

**停滞判定・接頭辞・W列**
34. `PROCESS` 孤児（処理ログ行なし）・`PROCESS` で `VALIDATING`・`PROCESS` で `COMPLETED`・`WRITE_ONLY` で `COMPLETED`・心拍が閾値以内、の5通りについて、`collectImportStatus_().leases[].stalled` の集合が `detectStalledLeases()` の `leaseId` 集合と一致する（§7.1 の判定式の同一性を固定）。
35. ファイル一覧の表示名が、恒久インデックス C列に `STATE_TO_PREFIX` の各値（`【処理中】` `【要修正】` `【済】` `【取消済】` `【対象外】`）が付いた名前を入れたとき接頭辞なしになり、**状態接頭辞でない `【経費】明細.csv` はそのまま残る**（`removableStatePrefixRegex_` を使っていることの裏づけ。`^【[^】]*】` を使うとこのケースで落ちる）。
36. W列が不正な JSON（例：`'{broken'`）の行があっても `menuShowImportStatus`・`menuShowFileList` は表示でき、その行の「最後のエラー」は `-`。打切りマーカーが先頭にある配列では、マーカーを飛ばして末尾の `{code, detail}` を出す。

**v1.2 で追加（`assessImportStatus_` 抽出後）**
37. `DISCOVERED` で `errorCount: 2` の `fileA`、`DISCOVERED` で `errorCount: 7` の `fileB`、`COMPLETED` で `errorCount: 5` の `fileC` を置き（いずれも `errorDropped: 0`）、**`lastActivityAt` を `now` の 5 分前**にした `collected`（`emptyCollected()` の `lastActivityAt: null` のままだと「取込待ちが…30分以上動きがありません」が先に `DISCOVERED` を covered にして本テストの件数が成立しない）と、`watch = {fileA: 1, fileB: 7}` を渡した `buildImportStatusView_(collected, scope, now, 0, watch)` の本文に、`取込に繰り返し失敗して取込待ちに戻っているファイルが 1 件`（`fileA`：増えた）が `失敗したファイル` の位置（`FAILED` があれば直後、無ければ警告の先頭）に出て、`エラー記録のあるファイルが 2 件`（`fileB`：据え置きなので該当しない、と `fileC`。`fileA` は covered で数えない）が最後に出る。同じ `collected` を `watch` 無し（4 引数）で呼ぶと追加行は出ず `エラー記録のあるファイルが 3 件`。

### 10.4 走らせ方

`node test/run-tests.js`。既存 728 件が引き続き通り、上記が追加されて全件 PASS であること。

---

## 11. 受入条件

実装完了は次の**すべて**を満たすこと。各項目に検証方法を付けた。

**コード**
1. `src/96_Menu.gs` が存在し、§9.3 の公開関数 10 個（`onOpen` ＋ ハンドラ 9 個）がある。── `Grep '^function (onOpen|menu[A-Z]\w+)\(' src/96_Menu.gs`
2. `src/` 内で `getUi(` `HtmlService` `showModalDialog` を含むファイルが `96_Menu.gs` **だけ**。── `Grep`
3. `96_Menu.gs` と、`97_Ops.gs` に新設した `collect*_` 関数の本体に、§2.4 の書込呼出しが**1つも無い**。── `Grep -n 'setValue\|setValues\|setFormula\|appendRow\|insertSheet\|insertRows\|deleteRow\|deleteSheet\|batchUpdate\|setProperty\|deleteProperty\|newTrigger\|deleteTrigger\|appendAudit\|acquireLease\|releaseLease\|transitionFileState\|updateProcessLog\|updateReviewStatus\|resolveReview\|rewindFileForReimport_\|clearSubmittedContentHash\|validateCustomerAccess\|showSheet\|MailApp\|LockService' src/96_Menu.gs` が 0 件。`collect*_` については関数本体を目視。
4. `96_Menu.gs` のトップレベルに関数宣言と `var X = <リテラル>` 以外が無い。── 目視（コメントに規律を明記）。
5. 設計 §4.4 の関数名（`authorize` `getUserRole` `hasRole` `getAuthorizedCustomerIds` `authorizeOperation` `isCorpusAdmin`）を定義していない。── `Grep`
6. メニューハンドラの名前が `_` で終わらない。── テスト 3。
7. `menuViewerScope_` の関数コメントに「参照専用。書込を伴う操作に流用しない」と書いてある。── 目視。

**テスト**
8. `node test/run-tests.js` が全件 PASS で、§10.3 の 36 ケース（相当）が含まれる。
9. `collectImportStatus_` の読取回数が件数非依存（テスト 12）。
10. 既存 `ops*` の戻り値・`Logger` 出力が不変（テスト 30）。

**実機（コンテナのスプレッドシートを開いて確認）**
11. 開いた直後（数秒以内）に「クレカ自動処理」メニューが出る。項目名と順序が §5.1 どおり。
12. 「診断 ▸ このメニューについて」が、実行者メール・閲覧できる顧客・マスターID・このスプレッドシートのID・両者の関係を表示する。**この結果を §12 の U-1・U-2・U-4 の欄に記録する。**
13. 「取込の状況」が現在の実機の件数（2026-09-10 時点：33 ファイル・636 明細）と矛盾しない数字を出す。`clasp run opsCountFileStates` の結果と状態別件数が一致する。
14. 「ファイル一覧」で Drive 上 `【済】` の付いたファイルが `完了 (COMPLETED)` として並び、ファイル名列に `【` で始まる接頭辞が**1件も無い**（恒久インデックス C列に接頭辞付きで入っていても、表示時に剥がされている。§7.2）。
15. 「要確認を開く」の件数が `clasp run opsCountReviewsByType` の合計と一致し、リンクで要確認シートが開く。
16. 「処理ログを開く」でクレカ処理ログシートへ移動する（コンテナ≠マスターならリンクの `modal` が出る）。
17. Q/R列に無いアカウントで項目を押すと §4.2 の拒否文言が出て、一覧は出ない。（テスト用に一時的なアカウントが無ければ、この項目は「未実施」と記録して残す）
18. `clasp run opsShowLeases` `clasp run opsShowTaggedTransactions` が改修前と同じ出力を返す。
19. 定期取込トリガーが動いている状態で「取込の状況」を開いても、定期取込の実行に影響が無い（実行数画面でエラーが増えていない）。

**運用手順（実装者が `work/` に書く必要はない。受入時に確認する）**
20. 初回に項目を押したときの承認画面（未確認 U-6）の手順を、顧客に渡す手順書に載せる。
21. 顧客本人にコンテナの編集権限を与える場合、§4.4 の限界を承知のうえで与える。

---

## 12. 未確認事項と実機確認手順

| ID | 事項 | 影響 | 確認手順 | 結果（受入時に記入） |
|---|---|---|---|---|
| U-1 | コンテナ＝マスターか | 「処理ログを開く」が移動になるかリンクになるか。§3.1 | 受入 12 の表示「両者の関係」 | |
| U-2 | メニュー実行時に `Session.getActiveUser().getEmail()` が消費者アカウントでも取れるか | 取れなければ全項目が §4.2 の拒否になる | 受入 12 の「実行者」欄。取れなければ `Session.getEffectiveUser()` へ切替を検討（メニュー実行では両者は同一人物） | |
| U-3 | `ui.alert` の本文の上限と、長文時にスクロールするか | 「取込の状況」「設定の検査」の本文長 | 30 行の本文で表示を目視。切れるなら §7.1 の本文を圧縮する | |
| U-4 | `Spreadsheet.getOwner().getEmail()` がオーナー自身の実行で取れるか | オーナー判定。取れなければオーナーは R列に自分を載せる運用で代替（現在の `TEST01` は `registerTestCustomer` の既定で登録者が Q/R 両方に入っている） | 受入 12 の「オーナー: はい/いいえ」 | |
| U-5 | clasp push 後の GAS 内ファイル順が名前順か | §9.1 の読込順の前提。`96_` の後に読み込まれるファイルは無いので、順序が違っても本仕様の実装は壊れない | Apps Script エディタのファイル一覧の並びを目視 | |
| U-6 | 初回承認の画面遷移（未確認アプリ警告の有無） | 顧客の手順書 | 顧客用アカウントで初回に項目を押す | |
| U-7 | 末尾 `_` の関数がメニューハンドラになれないか | 本仕様は付けないので影響なし | 確認不要 | 不要 |
| U-8 | 処理リースの `lastHeartbeat` セルが文字列か日付か | `formatMenuTimestamp_` の経路。両方扱うので表示は壊れないが、`opsShowLeases` の経過秒計算（`new Date(lease.lastHeartbeat)`）が日付セルだとシリアル値で狂う可能性がある | 「リースの状況」で心拍からの経過が妥当な値か、`clasp run opsShowLeases` と一致するか | |

---

## 付録 A. 表示ラベル

### A.1 内部状態（`FILE_STATE`）

| コード | ラベル | 一覧の並び優先度 |
|---|---|---|
| `FAILED` | 失敗 | 0 |
| `CUSTOMER_FIX_REQUIRED` | 要修正（顧客の修正待ち） | 1 |
| `VALIDATING` | 処理中（読取・検証中） | 2 |
| `WRITING` | 処理中（転記中） | 2 |
| `REVIEW_WAIT` | 要確認待ち | 3 |
| `DISCOVERED` | 未処理（取込待ち） | 4 |
| `COMPLETED` | 完了 | 5 |
| `CANCELED` | 取消済 | 6 |
| `EXCLUDED` | 対象外 | 7 |
| （未知） | そのままのコード | 8 |

根拠：仕様 §7.2 の表。

### A.2 要確認種別（`REVIEW_TYPE`）と担当

「担当」は `06_ErrorCatalog.gs` の `handler` 列を種別ごとにまとめたもの。1つの種別に複数の担当がある場合（`DATE`：確認担当者とシステム管理者、`FORMAT_UNKNOWN`：顧客とシステム管理者）は、**最初に連絡すべき人**として広い方（確認担当者・システム管理者）を出す。この列は「解決操作」ではなく「誰に連絡するか」の案内である。

| コード | ラベル | 担当 |
|---|---|---|
| `PARTNER` | 取引先 | 確認担当者 |
| `DATE` | 日付 | 確認担当者 |
| `AMOUNT` | 金額 | 確認担当者 |
| `ZERO_AMOUNT` | 金額0 | 確認担当者 |
| `INTEGRITY` | 整合性 | システム管理者 |
| `PRIOR_YEAR` | 前年利用日 | 確認担当者 |
| `FORMAT_UNKNOWN` | 形式不明 | システム管理者 |
| `FORMAT_AMBIGUOUS` | 形式曖昧 | システム管理者 |
| `MULTI_SHEET` | 複数シート | システム管理者 |
| `DUPLICATE` | 重複 | 確認担当者 |
| `FILE_CHANGED` | ファイル変更 | システム管理者 |
| `COUNT_TOTAL_MISMATCH` | 件数・合計不一致 | 確認担当者 |
| `EMPTY_FILE` | 空ファイル | 確認担当者 |
| `INPUT_LIMIT` | 入力上限 | システム管理者 |
| `DESTINATION_FIX` | 転記先の是正 | システム管理者 |
| `SCAN_TRUNCATED` | 走査打切り | システム管理者 |

要確認の状態：`OPEN` → 未着手、`IN_PROGRESS` → 対応中。

### A.3 リース用途（`LEASE_PURPOSE`）

| コード | ラベル |
|---|---|
| `PROCESS` | 取込 |
| `WRITE_ONLY` | 書込のみ（解決・取消し） |

---

## 付録 B. 既存関数の参照表（メニューが呼ぶもの）

| 関数 | ファイル | 戻り値の要点 |
|---|---|---|
| `activeUserEmail_()` | `01_DataAccessCore.gs` | 実行者メール。取れなければ `''` |
| `masterSpreadsheet_()` / `resolveMasterSpreadsheetId_()` | 同上 | マスター `Spreadsheet` / ID または `null` |
| `readSheetRows_(sheet, columns)` | 同上 | `[{rowNumber, values}]`。Sheets API 1 回 |
| `getActiveCustomers()` / `getAuthorizedCustomers(email)` | `02_CustomerMaster.gs` | `Customer[]`（`customerId` `customerName` `reviewers` `admins` `sourceFolderId` …） |
| `loadSettingsFromProperties()` | `05_SettingsValidator.gs` | `{loaded, ignored}` |
| `validateSettings(scope, context)` / `settingsChecksFor(scope)` / `VALIDATION_SCOPE` | 同上 | `{ok, problems: [{check, name, detail}], scope}` |
| `AuthorizationError` `MasterDataError` `CatalogError` | `06_ErrorCatalog.gs` | `error.code`（`MasterDataError` は `'CUSTOMER_MASTER_INVALID'`） |
| `permanentIndexRowsForScan_()` | `10_DriveScanner.gs` | `[{fileId, customerId, originalFileName, state, …}]`。1 回読取 |
| `activeLeases_()` | `11_FileStateManager.gs` | `[{leaseId, customerId, fileId, owner, lastHeartbeat, purpose, …}]`。1 回読取 |
| `detectStalledLeases()` | 同上 | **メニューからは呼ばない**（§7.1。`activeLeases_` を呼び直し、`PROCESS` リースごとに処理ログを引く）。テスト 34 の比較対象としてのみ使う |
| `STATE_TO_PREFIX` | `00_Config.gs` | 接頭辞の全体集合（INV-12）。テスト 35 に使う |
| `removableStatePrefixRegex_()` | `11_FileStateManager.gs` | `STATE_TO_PREFIX` の値だけを先頭から剥がす正規表現（引数なし）。§7.2 のファイル名表示に使う |
| `processLogSheet_()` / `PROCESS_LOG_WIDTH_` / `PROCESS_FIELD_COLUMNS_` | `60_ProcessLog.gs` | 処理ログの列番号（1 始まり）：`customerId` 6・`fileId` 8・`originalFileName` 9・`formatId` 15・`internalState` 17・`readCount` 18・`autoCount` 19・`reviewCount` 20・`excludedCount` 21・`errorCount` 22・`errors` 23・`lastHeartbeat` 30・`startedAt` 2・`endedAt` 3 |
| `reviewSheet_()` / `openReviews(filter)` | `50_ReviewStore.gs` | `reviewFromRecord_` の形（§7.3） |
| `transactionLogSheet_()` / `TRANSACTION_LOG_WIDTH_`（47） | `61_TransactionLog.gs` | 取引ログ。列の添字は §7.7 |
| `normalizeMerchant(s)` | `32_MerchantNormalizer.gs` | 正規化文字列 |
| `toIso8601(date)` / `excelSerialToDate(n)` / `toBool(v)` | `90_Utils.gs` | 日時・真偽の正準化 |
| `jsonCell_(value, fallback)` | `01_DataAccessCore.gs` | JSON セルの解析 |
| `collectTagBackfillTargets_()` / `SCHEDULED_IMPORT_HANDLER_` | `97_Ops.gs` | §7.8（`customerId` を持つ。`opsFilesNeedingTagBackfill` はこれの整形器であり、メニューは呼ばない） / `'scheduledImportTick'` |
| `VERSIONS.CODE` | `00_Config.gs` | `'3.0.0'` |

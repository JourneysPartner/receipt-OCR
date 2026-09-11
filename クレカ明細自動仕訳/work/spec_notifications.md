# メール通知 仕様書

対象システム：クレジットカード明細 自動仕訳システム（Google Apps Script、リポジトリ `クレカ明細自動仕訳`）
作成日：2026-09-10
版：1.0
読者：本仕様だけを読んで実装する実装者（AI を含む）。この文書に書いていないことは実装者が決めてよいが、**書いてあることは変えない**。判断に迷う箇所は §17「未確認事項」を先に読む。

---

## 0. この文書の読み方

- 「仕様」は `credit_card_import_normalization_system_spec_v2.0.md`、「設計」は `design_document.md`、「メニュー仕様」は `work/spec_menu_readonly.md` を指す。§番号はそれぞれの文書の節番号。
- 各決定には理由を添えた。**理由の方が決定より重要である。** 実装中に決定と衝突する事実が見つかったら、理由に照らして判断し、変えた場合はその旨を本仕様に追記すること。
- 断定できないことは「未確認」と書いた。§17 に集約し、実機での確認手順を付けた。
- 本仕様が満たすべき最上位の条件は1つである。**§1.2 の事故がもう一度起きたとき、この通知は必ず鳴ること。** 他のすべての決定はこの条件に従属する。§1.3 にその根拠を書き、§15 のテスト 1〜3 で固定する。

---

## 1. 背景と目的

### 1.1 現状

通知モジュール（設計 §4.5 `04_Notifications.gs`）は未実装である。`src/` に `MailApp`・`GmailApp` の呼出しは1つも無い（2026-09-10 に grep で確認）。運用者が状況を知る手段は、今日作った参照系メニュー（メニュー仕様）と `clasp run` の `ops*` 関数だけであり、**どちらも人が見に行かなければ何も起きない**。

### 1.2 この機能が必要になった事故（2026-09-09）

取込が **10分ごとに数時間、落ち続けた。誰も気づかなかった。** 開発者が状態を数えて初めて発覚した。正確な挙動は次のとおり。

1. ファイルは `DISCOVERED`（取込待ち）のままだった。
2. 10分間隔の定期取込（`scheduledImportTick`）がそのファイルを拾う。
3. `createOrUpdateProcessLog` が `VALIDATING` にし、抽出後に提出時ハッシュを書こうとする。
4. 提出時ハッシュは以前の値が残っており（パーサー修正後で値が変わっている）、INV-07「提出時ハッシュは不変」で `IntegrityError` になる。
5. **`FAILED` にはならず `DISCOVERED` に戻った。**
6. 次の10分で 2 へ戻る。これが延々と繰り返された。
7. 処理ログ W列（エラー）には**毎回**エラーが記録されていた。

補足：`processDiscoveredFile_`（`71_RunOrchestrator.gs` 520〜536行）の `catch` は `VALIDATING → FAILED` へ遷移させるので、コードを読む限り `FAILED` になるはずである。**なぜ `DISCOVERED` に戻ったのかは、コードからは特定できなかった**（当時の巻戻し経路 `rewindFileForReimport_` がハッシュを消さずに `DISCOVERED` へ戻していた可能性が高い。コミット 536fc15 で是正済み）。→ 未確認 U-N7。**本仕様の設計は、この経路が何であったかに依存しない**（§1.3）。

### 1.3 設計判断の土台：「`FAILED` になったら通知する」では検知できない

素直な設計は「ファイルが `FAILED` に遷移したら通知する」である。**これは上の事故を検知できない。一度も `FAILED` にならなかったからである。** さらに一般化すると、次の3つの理由から、**通知の検知条件を「特定の内部状態への到達」だけに置いてはならない**。

| 理由 | 事故での現れ方 |
|---|---|
| 失敗の結果状態は経路によって異なる | `FAILED` ではなく `DISCOVERED` に戻った。今後も回復処理・巻戻し処理は増える（`opsRecoverStuckFiles`・`opsRetry*` はいずれも `DISCOVERED` へ戻す） |
| 状態は「今」を表し、「繰り返し」を表さない | どの瞬間に状態を見ても「取込待ちが1件」でしかない。異常は**時間軸**（10分ごとに同じ失敗）にある |
| 状態を書けなかった失敗は状態に残らない | 処理ログ自体が書けない障害（`REQUIRED_LOG_WRITE_FAILED`）では、状態は一切動かない |

したがって本仕様の検知は**2つの層**で行う（§4）。

- **実行結果層**：定期取込の各回が返す**実行報告**（`runImport` の戻り値。`files[].outcome === 'FAILED'` 等）を見る。事故では**毎回の報告に `outcome: 'FAILED'` が載っていた**（`processDiscoveredFile_` の `catch`（`71_RunOrchestrator.gs` 520〜523行）は `try` 内のどの例外でも `outcome = 'FAILED'` を積む。その後の状態遷移が成功しても失敗しても変わらない）。**この層がある限り、tick が最後まで走った回は §1.2 の事故が最初の1回で鳴る。**
- **状態層**：処理ログ・恒久インデックス・リースの**状態**を見る。実行報告を持たない文脈（メニュー、監視トリガー）でも同じ判断ができる。事故の署名は状態にも残る：**`DISCOVERED` なのにエラー記録が増え続ける**（取込待ちのファイルにエラーが記録されるのは、取込を試みて失敗し戻された場合だけである）。これを `REPEATED_FAILURE`（§5.1）として要対応にする。

2層にする理由は、片方だけでは穴があるからである。実行結果層は「実行が最後まで走った」ことが前提であり、**6 分の強制終了で tick の末尾が失われた回**（§10.2）や、**定期取込トリガー自体が消えている・止まっている**場合は何も生まない。状態層は「状態が残る」ことが前提であり、**状態に残らない失敗**（処理ログ自体が書けない障害）を捕まえられない。両方持てば、どちらか一方が沈黙しても他方が鳴る。**§1.2 の事故は両方の層で要対応になる**（実行結果層は 1 回目の tick、状態層は 3 回目の tick の先頭。§10.4）。

### 1.4 もう一つの制約：洪水にしない

同じ事故で素朴に「失敗のたびにメールを送る」と、10分ごと×数時間＝**20通以上**になり、GAS の1日あたり送信上限（消費者アカウントは 100 宛先。§3.4）を食い潰す。上限を食い潰すと、**次に起きる別の事故の通知が送れない**。

一方で、抑えすぎて気づけなくなっては本末転倒である。この綱引きは §7 で解く。要点だけ先に書く。

- 同じ事象は**「顧客 × 事象の種類」**で識別し、**内容の指紋**（対象ファイルIDの集合など。件数や時刻は含めない）が同じ間は再送しない。
- 抑えている間も事象が続いていれば、**重大度に応じた間隔で必ず再送する**（要対応 6時間・注意 24時間）。1通目を見逃しても2通目が来る。
- 指紋に**新しい要素が加わったら**（別のファイルも落ち始めた等）、間隔を待たずに送る。新しい情報だからである。
- 1日の送信数に安全側の上限（`SETTINGS.MAX_EMAILS_PER_DAY` = 80 宛先）を設け、Google の上限より手前で止める。

事故に当てはめると、**最初の 30 分で最大 3 通、その後は 6 時間ごとに 1 通**（§10.4 に時系列）になる。

---

## 2. 範囲と非範囲

### 2.1 範囲

**今日この瞬間に実際に発火しうる事象だけ**を通知する。具体的には §5 の事象一覧。それらはすべて、現行コード（`scheduledImportTick`・`runImport`・`collectImportStatus_`・`detectStalledLeases`）が**既に生成している**情報だけから判定できる。

### 2.2 非範囲（なぜ今は書けないか）

仕様書には通知の要求が §21.3 以外にも散らばっている。多くは**まだ実装されていない機能に付随する**ため、存在しない機能の通知は書けない。範囲外にしたものを、理由とともに列挙する。

| 要求の出所 | 事象 | 範囲外にする理由 | 本仕様での代替 |
|---|---|---|---|
| 仕様 §19.2 | 継続トリガー作成失敗（`CONTINUATION_TRIGGER_CREATE_FAILED`） | 継続トリガー（設計 4.35 `64_ContinuationManager`）が未実装。作成に失敗する箇所が存在しない | 定期取込が時間予算で新規開始を止め、残りは `DISCOVERED` のまま次回に回る（`71_RunOrchestrator.gs` 159〜164行）。これは正常動作であり通知しない |
| 仕様 §23.2 | クォータ接近・超過による待機（`QUOTA_WAIT_REQUIRED`） | クォータ管理（設計 4.37 `66_QuotaManager`）が未実装。Drive／Sheets の呼出回数を数える経路が無い | **メール送信自体のクォータ**だけは本仕様 §12 で扱う（本モジュールが自分で数えられる） |
| 仕様 §23.5 | 監視閾値（同一取引ID複数行・転記値不一致・同期再試行上限等） | メトリクス（設計 4.36 `65_Metrics`）が未実装。判定ロジックが存在しない | §5 の状態層は、既存の `collectImportStatus_` が読める範囲（ファイル状態・リース・エラー記録）に限る |
| 仕様 §23.6 | 容量不足による停止 | 停止判定（`checkLogCapacityForRun_`）は存在するが、その通知経路は設計上 `65_Metrics` 経由。ただし停止した事実は `runImport` の `stoppedBy: 'LOG_CAPACITY_EXCEEDED'` に**出る** | **`RUN_STOPPED` として範囲に含める**（§5.2）。容量の警告閾値（`WARN_PERCENT`）による事前警告は範囲外（判定関数が無い） |
| 設計 §4.5 | `notifyProcessComplete`（処理完了の件数通知） | 「一時トリガーで自動継続した処理の完了」（仕様 §21.3）は継続トリガーの完了報告であり未実装。毎回の定期取込で完了通知を送ると、正常時に10分ごとに届く洪水になる | 定期取込が残件なしで自分を止めたときの1通（`SCHEDULE_STOPPED`。§5.2）。次の候補は日次ダイジェスト（§2.3） |
| 設計 §4.5 | `notifyReviewRequired`（要確認の発生） | 仕様 §21.3 の宛先は「処理開始者とシステム管理者」であり、要確認を扱う確認担当者（Q列）ではない。宛先の役割判定（設計 4.4 `03_Authorization`）が未実装のまま確認担当者へ送ると、認可と食い違う。加えて正常運用で毎回発生するので洪水になる | 「取込の状況」画面の「未解決の要確認」行 |
| 設計 §4.5 | `notifyRenameRetryExhausted`・`notifyLeaseForceReleased`・`notifyLogCapacityWarning`・`notifyQuotaWait`・`notifyAlerts` | それぞれ呼出元（4.35・4.36・4.37）が未実装。`forceReleaseLease` は存在するが、定期取込の後始末で毎回自動的に呼ばれるため、個別に通知すると洪水になる | 後始末の**結果**を1通にまとめる `INTERRUPTION_RECOVERED`（§5.2） |
| 設計 §4.36 条件23 | 対象年度の更新漏れ | 判定ロジックが未実装 | なし |
| 一般 | 「解消しました」のメール | 送ると、失敗と解消を10分ごとに往復する状況（例：リース競合の揺れ）で洪水になる。解消は画面で確認できる | 「取込の状況」画面 |
| 一般 | 確認担当者（Q列）への通知 | 上記 `notifyReviewRequired` と同じ理由（役割判定が未実装） | なし |
| 一般 | 通知内容の顧客ごとのカスタマイズ・言語切替・HTML メール | 必要性が確認されていない。プレーンテキストが最も壊れにくい | なし |

### 2.3 次段階の候補（本仕様では作らない）

- 日次ダイジェスト（1日1通：完了ファイル数・未解決の要確認件数・エラー件数）。
- `03_Authorization.gs` 実装後の確認担当者への要確認通知。
- 設定キーの追加（再送間隔・監視トリガー間隔を Script Properties で変える）。§3.6 のとおり、今は `SETTINGS` にキーを足せない。

---

## 3. 実行環境の事実（GAS）

ここを誤ると動かない。断定していない箇所は §17 で実機確認する。

### 3.1 送信スコープ

- `src/appsscript.json` の `oauthScopes` に `https://www.googleapis.com/auth/script.send_mail` が**既にある**（2026-09-10 確認）。`MailApp.sendEmail` に必要なスコープはこれである。
- このスコープはコミット ffcd60e（「Add installation provisioning and complete the manifest」）でマニフェストに入っており、実機での承認（メモリ `gas-environment.md`：2026-08-28 のリリースゲート実機通過、2026-09-02 の初転記）より前である。マニフェストに `oauthScopes` を明示している場合、承認時に**列挙された全スコープが一度に要求される**ので、**送信スコープは既に承認済みのはず**であり、`MailApp` を使い始めても追加の承認画面は出ないはずである。→ **未確認 U-N1**（§17。`opsSendTestNotification` で確認する）。
- 承認が不足していた場合の現れ方：時間主導トリガーは**トリガー作成者の承認内容で動く**ので、`scheduledImportTick` の中で `MailApp.sendEmail` が例外を投げる。本仕様の送信は必ず `try/catch` で包む（§11）ので取込は止まらない。承認し直すには、エディタから `opsSendTestNotification` を1回実行して承認画面を通す。

### 3.2 誰に送るか ── 値の取得元

仕様 §21.3 は「処理開始者とシステム管理者」、設計 §4.5 は「処理開始者（処理ログ D列）とシステム管理者。トリガー実行アカウント（E列）は本文に記載しない」と定める。コードを読んで確定した取得元は次のとおり。

| 概念 | 取得元 | コード上の事実 |
|---|---|---|
| システム管理者 | 顧客マスター **R列**（`admins`） | `customerFromRow_`（`02_CustomerMaster.gs` 27行）が `csvEmails_(values[17])` で読む。カンマ区切り・`trim`・**小文字化済み**。`forceReleaseLease` がこの列で管理者を認可している（`11_FileStateManager.gs` 156行） |
| 確認担当者 | 顧客マスター **Q列**（`reviewers`） | 同 `csvEmails_(values[16])`。**本仕様では宛先にしない**（§2.2） |
| 処理開始者 | 処理ログ **D列**（`startedBy`） | `createOrUpdateProcessLog`（`60_ProcessLog.gs` 105行）が `activeUserEmail_()` ＝ `Session.getActiveUser().getEmail()` を書く |
| トリガー実行アカウント | 処理ログ **E列**（`triggerAccount`） | **現行コードは E列を一度も書かない**（`createOrUpdateProcessLog` は `processRow[4]` に触れない）。常に空 |
| 定期取込を仕掛けた人 | `Session.getEffectiveUser().getEmail()` | 時間主導トリガーの中では**トリガーを作成したアカウント**を返す（Google の公開仕様）。現状 `src/` に `getEffectiveUser` の呼出しは無い |

**定期トリガー実行時に「処理開始者」が誰になるか**：`runImport`（`71_RunOrchestrator.gs` 127〜136行）は `activeUserEmail_()` ＝ `Session.getActiveUser().getEmail()` で顧客を認可し、**空なら毎回 `NO_AUTHORIZED_CUSTOMER` で停止する**。定期取込が実機で動いている（メモリ `gas-environment.md`：2026-09-03〜04 にパイロット 5 ファイルが終着）以上、**時間主導トリガーの中でも `getActiveUser` はトリガー作成者のアドレスを返しており、D列にはその値が入っている**。つまり定期取込では D列 ＝ トリガー作成者である。→ 一致の実測は U-N2 に記録する。

本仕様の決定（§6）：宛先は **R列の管理者 ∪ `Session.getEffectiveUser().getEmail()`（トリガー作成者）** とし、D列は読まない。理由：宛先は**バケット（顧客／システム）単位**で決まるのに対し、D列は**ファイル単位**の値であり、ファイルごとに処理ログ行を引き直す読取（1 ファイル 2 往復）を払ってまで同じ人物を取り出す意味が無い。`SYSTEM` バケットの所見（`RUN_STOPPED` 等）には対応するファイルが無く、D列そのものが存在しない。定期取込では両者が同じ人物を指すので、`getEffectiveUser` で足りる。

### 3.3 時間主導トリガーの実行文脈

- `scheduledImportTick` は `opsStartScheduledImport`（`97_Ops.gs` 1486行）が 10 分間隔で作った時間主導トリガーから、**トリガー作成者の権限**で実行される。UI は無い（`SpreadsheetApp.getUi()` は例外）。
- 6 分の実行上限が適用される。`runImport` は `EXECUTION_TIMEOUT_SECONDS − SAFETY_MARGIN_SECONDS`（実機 300 − 60 = 240 秒）を過ぎたら新しいファイルを始めないが、**始めたファイルは最後まで走る**ので、1 回の tick は 5 分を超え得る（1ファイル 149 往復。メモリ `gas-round-trip-budget.md`）。→ 通知を tick の**どこに置くか**（§10）はこの事実で決まる。
- トリガーの中で**捕捉されない例外**が起きると、Google が「Summary of failures for Google Apps Script」のメールをトリガー作成者へ送る（Google 標準の障害通知）。**事故で誰も気づかなかったのは、例外がすべて捕捉されていたからである**（`processDiscoveredFile_` の `catch`）。つまり Google 標準の通知は「捕捉された失敗」には無力であり、本仕様はその隙間を埋める。→ 標準通知の設定値（即時か日次か）は未確認 U-N6。
- `ScriptApp.getProjectTriggers()` は**現在の実行ユーザーが作成したトリガーだけ**を返す。トリガーの中では実行ユーザー＝トリガー作成者なので、同じ人が作った定期取込トリガーは見える。**本仕様の判定はトリガーの可視性に依存しない**（§5.1 `IMPORT_IDLE` は「動きがない」ことだけを見る）。

### 3.4 メール送信クォータ

Google の公開仕様（Apps Script quotas）：

| 項目 | 消費者アカウント（gmail.com） | Google Workspace |
|---|---|---|
| メール宛先数／日（`MailApp`・`GmailApp` 合算） | **100** | 1,500 |
| 1通あたりの宛先数 | 50 | 50 |
| 本文サイズ | 200 KB | 200 KB |

- **数えるのは「通数」ではなく「宛先数」である。** 3 人宛ての1通は 3 を消費する。本仕様の日次カウンタも宛先数で数える（§7.5）。
- 超えたとき：`MailApp.sendEmail` が例外を投げる（メッセージは "Service invoked too many times for one day: email." の形）。メールは送られない。
- `MailApp.getRemainingDailyQuota()` が残り宛先数を返す。送信前にこれを見れば、例外を踏まずに済む。
- クォータの回復は「24 時間の窓」で行われ、正確な回復時刻は公開されていない。→ §12 では「回復時刻を予測しない」設計にする。
- 本プロジェクトの安全側上限は `SETTINGS.MAX_EMAILS_PER_DAY` = 80（`00_Config.gs` 276行。設計 11章 #23「1日のメール送信安全側上限」）。**この値は既に存在し、設定検証 #7 `quotaCeilings` の検査対象である。** 本仕様はこれを日次上限として使う。80 にしてあるのは、Google の 100 との差分を手動送信・Google 標準の障害通知の分として残すためである。

### 3.5 状態の置き場：Script Properties

GAS は実行をまたいでメモリを持てない（`60_ProcessLog.gs` 35行「GASの実行ごとにグローバルは初期化される」）。再送抑制の状態（§7）は **Script Properties** に置く。

- 上限：合計 500 KB、1 値 9 KB、1 キー名 9 KB（Google の公開仕様）。§7.6 で状態を 1 キー・数 KB に収める規律を書く。
- 既存の使い方：`RUN_TX_COUNT_<runId>`（`60_ProcessLog.gs`）、`SCHEDULED_IMPORT_IDLE`（`97_Ops.gs`）、`MASTER_SPREADSHEET_ID`、`FAULT_INJECTION`、および `SETTINGS` の各キー。
- `loadSettingsFromProperties()` は `SETTINGS` に無いキーを「無視した不明キー」として数える（`05_SettingsValidator.gs` 323行）。本仕様が置く `NOTIFY_STATE_V1` とバケットごとの `NOTIFY_BUCKET_V1|…`（§7.6）もそこに数えられ、「設定の検査」画面の「無視した不明キー: N 件」が 1 ＋ バケット数だけ増える。既存の `SCHEDULED_IMPORT_IDLE`・`MASTER_SPREADSHEET_ID` も同様に数えられているので、新しい種類の問題ではない。
- 同時実行：定期取込（10分間隔）と監視トリガー（§10.3。1時間間隔）が同時に走り得る。状態の読取→判定→送信→書込を `withScriptLock_`（`01_DataAccessCore.gs` 64行）で囲む（§7.7）。

### 3.6 設定キーは追加できない

`SETTINGS`（`00_Config.gs`）のキー集合は設計 11章の 63 キーと一致させる規約であり、`test/phase0.test.js` 27行付近がキー集合を固定している。**本仕様は `SETTINGS` にキーを追加しない。** 再送間隔などの閾値は `95_Notifications.gs` の**トップレベル定数**として持つ（§13.2）。設定化は次段階（§2.3）。

---

## 4. 設計の骨格

```
定期取込 scheduledImportTick（10分ごと）
  ├─ 後始末（既存）：opsReleaseStalledLeases / opsRecoverStuckFiles
  ├─ ★ 状態通知 notifyImportState_()          ── 状態層。collectImportStatus_ → assessImportStatus_（画面と共有）
  ├─ runImport（既存）→ 実行報告
  ├─ 残件判定・自己停止（既存）
  └─ ★ 実行結果通知 notifyRunReport_(report)  ── 実行結果層。報告だけを見る（追加の読取なし）

監視トリガー notificationWatchdogTick（1時間ごと・別トリガー）
  └─ ★ 状態通知 notifyImportState_()          ── 定期取込が止まっていても状態層だけは動く

参照系メニュー「取込の状況」（既存）
  └─ collectImportStatus_ → assessImportStatus_（★ 通知と同じ判断）→ 画面に警告行
                                                  ＋ ★ 通知の最終送信・失敗を1行表示
```

★ が本仕様で作る／変える部分。**判断の出どころは `assessImportStatus_`（状態層）と `runFindingsFromReport_`（実行結果層）の2関数だけ**であり、画面もメールもそこから受け取った「所見（finding）」を整形するだけである（§9）。

用語：

| 用語 | 意味 |
|---|---|
| 所見（finding） | 「何がおかしいか」の1項目。`{kind, severity, bucket, count, elements, line, action}`（§5.3） |
| バケット（bucket） | 所見の宛先単位。顧客ID（その顧客の管理者へ）または `'SYSTEM'`（全管理者へ）。§6 |
| エピソード（episode） | 「バケット × 種類」で識別される、連続して観測されている1つの事象。再送抑制の単位。§7 |
| 指紋（fingerprint） | エピソードの内容を表す要素集合（ファイルID等）。件数・時刻を含めない。§7.3 |

---

## 5. 通知する事象の一覧

### 5.1 状態層（`assessImportStatus_` が返す。画面と共有）

検知条件・文言はメニュー仕様 §7.1（v1.2）の警告行と**一字一句同じ**である。既存の 5 行はそのまま、`REPEATED_FAILURE` を本仕様で**追加**した（追加の理由は表の下）。順序はこの表の順で固定。`N` は件数。`covered` の規則（先に該当した所見のファイルを後の所見から除く）はメニュー仕様どおり。

| kind | 重大度 | 検知条件（メニュー仕様 §7.1 の定義そのまま） | 指紋の要素 | 画面・本文の行（`line`） | 対処（`action`。本文だけに出す） |
|---|---|---|---|---|---|
| `FAILED_FILES` | CRITICAL | `state === 'FAILED'` のファイルが 1 件以上 | 該当 `fileId` | `⚠ 失敗したファイルが N 件あります。「ファイル一覧」で内容を確認し、管理者へ連絡してください（対処: opsRetryFailedFiles）` | `処理ログの W列（エラー）でコードを確認し、原因を直してから opsRetryFailedFiles で発見からやり直させる` |
| `REPEATED_FAILURE` | CRITICAL | `state === 'DISCOVERED'` **かつ** `errorTotal >= 1` **かつ** `watch[fileId] !== undefined && errorTotal > watch[fileId]`（前回の評価で取込待ちだったときより**エラー記録の生涯累計が増えた**）のファイルが 1 件以上（`covered` に加える）。`errorTotal = errorCount + errorDropped`（§7.8。`errorDropped` は `collectImportStatus_` が W列先頭の打切りマーカーから取る）。`watch` は §7.8 | 該当 `fileId` | `⚠ 取込に繰り返し失敗して取込待ちに戻っているファイルが N 件あります。定期取込のたびに同じ失敗を繰り返している可能性があります（対処: 処理ログ W列の最新のエラーを確認し、原因を直してから opsReprocessFile）` | `取込待ち（DISCOVERED）のファイルにエラーが記録されるのは、取込を試みて失敗し戻された場合だけです。原因を直さずに放置すると 10 分ごとに同じ失敗を繰り返します` |
| `STALLED` | CRITICAL | `stuckSuspects`（`VALIDATING`/`WRITING` でリースが無いか停滞）の `fileId` 集合 ∪ 停滞リースの `fileId` 集合 が空でない | 該当 `fileId` | `⚠ 処理が止まったままのファイルが N 件あります（心拍途絶）。管理者へ連絡してください（対処: opsReleaseStalledLeases → opsRecoverStuckFiles）` | `定期取込の後始末で解放・回復できなかったものです。opsShowLeases で理由を確認してください` |
| `CUSTOMER_FIX` | WARNING | `state === 'CUSTOMER_FIX_REQUIRED'` が 1 件以上 | 該当 `fileId` | `⚠ 顧客の修正待ちが N 件あります。元ファイルを直して再提出してください（【要修正】の付いたファイル）` | `顧客に元ファイルの修正を依頼し、修正後に opsRetryCustomerFixFiles を実行する` |
| `IMPORT_IDLE` | CRITICAL | `DISCOVERED` が 1 件以上 かつ `lastActivityAt` が 30 分より前または `null` | 該当 `fileId` | `⚠ 取込待ちが N 件ありますが、30分以上動きがありません。定期取込が止まっている可能性があります（対処: opsStartScheduledImport）` | `Apps Script のトリガー画面で scheduledImportTick が残っているか確認し、無ければ opsStartScheduledImport を実行する` |
| `ERROR_RECORDS` | WARNING | `errorCount > 0` で、上のどれにも該当しないファイルが 1 件以上 | 該当 `fileId` | `△ エラー記録のあるファイルが N 件あります。「ファイル一覧」の「最後のエラー」を確認してください` | `取込待ち（DISCOVERED）のファイルにエラー記録がある場合は、取込のたびに失敗して戻されている可能性があります。処理ログ W列の最新のコードを確認してください` |

`IMPORT_IDLE` の `lastActivityAt` は `collectImportStatus_` が返す**全顧客共通**の値であり、顧客ごとに絞った後も同じ値を使う（メニュー仕様 §7.1 と同じ。担当者の画面もそうしている）。

**`REPEATED_FAILURE` を追加した理由**：事故の状態（`DISCOVERED`・`errorCount` が 10 分ごとに 1 ずつ増える・最終活動は数分前）は、既存の 5 行では `ERROR_RECORDS`（△・注意）にしか該当しない。実行結果層（§5.2）は要対応を出すが、**tick が 6 分の強制終了に当たった回は末尾が走らず**（§10.2）、バックログのある日はそれが続き得る。事故の署名は状態にもある ── **取込待ちのまま、エラー記録が増え続ける**。これを要対応にすれば、実行結果層が沈黙しても 3 回目の tick の先頭で鳴る。

**なぜ「増えた」であって「N 件以上」でないか**：処理ログ V列 `errorCount` は `recordError`（`60_ProcessLog.gs` 239〜255行）が積み、巻戻し（`rewindFileForReimport_`）では消えない。「`errorCount ≧ 2`」にすると、過去に 2 回失敗したファイルを管理者が原因を直して巻き戻した直後、次の tick の先頭で必ず要対応が 1 通出る。事故の当事者 2 ファイルがまさにそれである。**直した直後に鳴る警報は、人に警報を無視させる。** 「増えた」なら、巻き戻して待っている間（据え置き）は鳴らず、**直したはずなのにまた失敗した**ときにだけ鳴る。それが本当に知りたいことである。

**なぜ `errorCount` そのものではなく `errorTotal` か**：V列 `errorCount` は**生涯累計ではない**。`recordError` は W列の配列を `SETTINGS.MAX_ERROR_RECORDS_PER_FILE`（既定 200）で切り詰め、先頭に打切りマーカー `{truncated: true, droppedCount, firstDroppedAt}` を置く（249〜253行）。V列はマーカーを除いた件数なので**打切り後は 199 で頭打ち**になる。10 分ごとの失敗なら約 33 時間で頭打ちに達し、「増えた」が偽になって `REPEATED_FAILURE` は**黙って消える**（本仕様 v1.2 の欠陥。レビューで指摘）。一方 `droppedCount` は打切りのたびに 1 ずつ増え続け、頭打ちが無い。**`errorTotal = errorCount + droppedCount` が本当の生涯累計**であり、これを比べる。`droppedCount` は W列を解析しないと取れないので、`collectImportStatus_` が `files[].errorDropped` として返す（§13.4。W列の解析は既に `lastError` のために行っている）。

それでも取りこぼす範囲（明記しておく）：(1) W列が壊れた JSON のとき `errorDropped` は 0 になり、V列が 199 に達した後は「増えた」が偽になる（`lastError` も `null` になるので、画面の「最後のエラー」が `-` なのに `errorCount` が 199 という形で人には見える）。(2) `recordError` 自体が失敗した回（`processDiscoveredFile_` の `ignored`）は記録が増えず、その回は署名に残らない。いずれも実行結果層 `RUN_FILE_FAILED` が 6 時間窓で拾い続ける。

「増えた」の判定には前回の値の記憶が要る。スナップショットしか持たない画面には決められないので、**記憶（`watch`）は通知側が Script Properties に持ち、画面はそれを読む**（§7.8・§9.2）。通知の評価（tick 先頭・監視トリガー）が一度も走っていない環境では、画面にこの行は出ない（`ERROR_RECORDS`・`IMPORT_IDLE` で気づける。画面の「■ メール通知」行 §14 で通知が動いているかは分かる）。

### 5.2 実行結果層（`runFindingsFromReport_` が返す。定期取込だけが持つ情報）

`scheduledImportTick` の中でだけ判定する。画面には出ない（画面は取込を実行しないため報告を持たない）。

| kind | 重大度 | バケット | 検知条件 | 指紋の要素 | 本文の行（`line`） | 対処（`action`） |
|---|---|---|---|---|---|---|
| `RUN_FILE_FAILED` | CRITICAL | 顧客 | `report.customers[].files[]` に `outcome === 'FAILED'` が 1 件以上 | `fileId + '|' + errorCode`（§5.4） | `⚠ 取込に失敗したファイルが N 件あります（この実行）` | `処理ログの W列（エラー）で詳細を確認してください。同じファイルが毎回失敗している場合、状態が取込待ちに戻っていても取込は前に進んでいません` |
| `RUN_CUSTOMER_SKIPPED` | CRITICAL | 顧客 | `customerReport.skipped` が非 null（`INTEGRITY_STOP`、または例外の `code`／`'CUSTOMER_ERROR'`） | `skipped` の値 | `⚠ この顧客の取込を開始できませんでした（理由: {skipped}）` | `INTEGRITY_STOP なら整合性検査の所見を、それ以外は Apps Script の実行ログを確認してください` |
| `RUN_STOPPED` | CRITICAL | SYSTEM | `report.stoppedBy` が非 null（`NO_AUTHORIZED_CUSTOMER`・`SETTINGS_INVALID`・`LOG_CAPACITY_EXCEEDED`） | `stoppedBy`。`SETTINGS_INVALID` は `'SETTINGS_INVALID#' + 検査ID` を検査ごとに1要素 | `⚠ 定期取込が実行前に停止しました（理由: {stoppedBy}）` | `NO_AUTHORIZED_CUSTOMER: 実行者（定期取込ではトリガー作成者）が顧客マスターの Q/R 列に無い。SETTINGS_INVALID: 「診断 ▸ 設定の検査」で不合格の項目を確認。LOG_CAPACITY_EXCEEDED: 保存先の容量` |
| `HOUSEKEEPING_FAILED` | CRITICAL | SYSTEM | 後始末（`opsReleaseStalledLeases`／`opsRecoverStuckFiles`）が例外を投げた | `error.code`、無ければ `error.name` | `⚠ 定期取込の後始末（リース解放・回復）が失敗しました（{code}）` | `Apps Script の実行ログを確認してください。後始末が失敗し続けると、止まったファイルが永久に拾われません` |
| `INTERRUPTION_RECOVERED` | WARNING。**同じ `fileId` が 2 回目以降なら CRITICAL に昇格**（§7.2 規則 5） | **顧客**（`fileId` → `customerId` は `collectImportStatus_().files` の `customerId` で引く。索引に無い `fileId` は `SYSTEM`） | 後始末が **1 件以上**のリースを解放した、または **1 件以上**のファイルを回復・巻戻した（`released: true` の数 ＋ `rewound: true` の数 ＞ 0） | 解放・回復した `fileId` | WARNING: `△ 前回の実行が途中で止まっていたため、リース解放 N 件・回復 M 件を行いました`。CRITICAL: `⚠ 同じファイルが繰り返し中断しています（N 件）。6 分の実行上限に当たっている可能性があります` | `opsInspectStuckFiles で、どのファイルがどこまで書けているかを確認してください。同じファイルで毎回起きる場合は、そのファイルを opsImportOneFile で単独に取り込むか、分割を検討してください` |
| `AUDIT_CHAIN_BROKEN` | WARNING | SYSTEM | `customerReport.auditChain === 'BROKEN_NOTIFY_ONLY'` が 1 顧客以上 | 固定文字列 `'BROKEN'` | `△ 監査ログの連鎖ハッシュが壊れています（処理は止めていません。設計 INV-29）` | `verifyChain('ALL') で破損位置を特定してください` |
| `STATUS_CHECK_FAILED` | CRITICAL | SYSTEM | 状態層の収集（`collectImportStatus_`）または顧客マスター読取（`getActiveCustomers`）が例外を投げた | `error.code`、無ければ `error.name` | `⚠ 取込の状態を確認できませんでした（{code}）。マスタースプレッドシートを読めていない可能性があります` | `「診断 ▸ 設定の検査」と「このメニューについて」で、マスターと必須シートを確認してください` |
| `SCHEDULE_STOPPED` | INFO | SYSTEM | `scheduledImportTick` が残件なし（2回連続で処理0・残件0）でトリガーを削除した | 発生ごと（抑制なし。§7.4） | `定期取込は残件がなくなったため自動停止しました。新しいファイルを置いたら opsStartScheduledImport を実行してください` | （同上） |

`RUN_FILE_FAILED` の補足：`outcome === 'LEASE_CONFLICT'` は**通知しない**。後始末が先に走る定期取込の中で残るリースは、人が同時に `opsReprocessFile` 等を実行している `WRITE_ONLY` リースであり、一時的である。恒常的に残るなら状態層の `STALLED` が拾う。`outcome === 'DEFERRED_TIME_BUDGET'` も通知しない（時間予算の縮退であり正常）。

`INTERRUPTION_RECOVERED` の補足（検知の穴を塞ぐ）：6 分の実行上限に**毎回**当たるファイルは、tick 先頭の後始末で `VALIDATING → DISCOVERED` に巻き戻され、`errorCount` も増えない（強制終了は `catch` を通らない）。したがって状態層の A は「異常なし」、実行結果層の B は tick が殺されて走らない。**この事故を検知できるのは本所見だけ**である。だから同一 `fileId` の 2 回目で CRITICAL に昇格させ（§7.2 規則 5）、6 時間窓で再送する。バケットを顧客にするのは仕様 §20.1（他顧客の `fileId` を見せない）のため。

`STATUS_CHECK_FAILED` の補足：これは §1.3 の「状態を書けなかった失敗は状態に残らない」に対する備えである。マスターの必須シートが消えた・権限が外れた等の障害は、`runImport` を例外で落とし（Google 標準の障害通知は出るが U-N6）、状態層は何も読めない。読めないこと自体を1通で知らせる。

### 5.3 所見の形

```
{
  kind:      string,          // §5.1・§5.2 の kind
  severity:  'CRITICAL' | 'WARNING' | 'INFO',
  bucket:    string,          // 顧客ID、または 'SYSTEM'
  count:     number,          // 件数（本文表示用。指紋には使わない）
  elements:  string[],        // 指紋の要素（ソート済み・重複なし）。§7.3
  line:      string,          // 画面・本文に出す1行（上表）
  action:    string           // 本文だけに出す対処
}
```

### 5.4 エラーコードの扱い（`71_RunOrchestrator.gs` の小改修）

`processDiscoveredFile_` の `catch`（525行付近）は `outcome.error = String(error.code || error.message || error)` を積む。**`error.message` は本文に出せない**（設計 §4.5「原因文字列に機微情報を含めない」。メッセージには表示IDやセル内容が混じり得る）。事故の `IntegrityError(null, 'Submitted content hash is immutable')` は `code` が `null` なので `outcome.error` はメッセージになり、コードとして使えない。

改修：`catch` の中で `outcome.error` に**加えて**次を積む（既存の `outcome.error` は変えない。`importRunReportLines` は `error` を出力しないので互換の問題は無い）。

```
outcome.errorCode = (error && error.code) || null;          // カタログのコード
outcome.errorName = (error && error.name) || 'Error';        // 例外クラス名（IntegrityError 等）
```

通知が使う「エラーコード」は `errorCode || errorName`。事故では `'IntegrityError'` になる。クラス名は `06_ErrorCatalog.gs` の固定語彙であり機微情報を含まない。

---

## 6. 宛先の決め方

### 6.1 規則

```
notificationRecipients_(bucket, customersById, effectiveUser) → string[]
```

| バケット | 宛先 |
|---|---|
| 顧客ID `C` | `customersById[C].admins`（R列） ∪ `[effectiveUser]` |
| `'SYSTEM'` | 全有効顧客の `admins` の和集合 ∪ `[effectiveUser]` |

- `effectiveUser = Session.getEffectiveUser().getEmail()`。空文字なら加えない。
- すべて小文字化し、重複を除き、`@` を含まないものを捨てる。R列は `csvEmails_` で既に小文字化されている。
- 結果が空なら**送らない**。§7.6 の状態に `lastFailure: {reason: 'NO_RECIPIENT'}` を記録する。
- 顧客マスターが読めない（`getActiveCustomers()` が例外）場合、`customersById` は空として扱い、宛先は `[effectiveUser]` だけになる。本文の末尾に「顧客マスターを読めなかったため、管理者宛てを省略しました」を付ける。

### 6.2 理由

- **顧客ごとに 1 通**にするのは、仕様 §20.1（他顧客の情報を見せない）のためである。顧客 A の管理者が顧客 B の失敗件数を受け取る形にしない。`SYSTEM` バケットの所見は顧客固有の情報（顧客名・ファイルID）を**含まない**ので全管理者へ送ってよい。
- 確認担当者（Q列）に送らないのは §2.2 の理由。
- トリガー作成者を必ず含めるのは、**顧客マスターが壊れていても最低1人には届く**ようにするため（§5.2 `STATUS_CHECK_FAILED`）。R列が空の顧客（テストでは `admins: ''` があり得る）でも同様。
- 宛先の数はクォータ消費に直結する（§3.4）。パイロット（`TEST01`、R列 1 名 ＝ トリガー作成者）では 1 通 = 1 宛先。

---

## 7. 再送抑制の規則

### 7.1 エピソード

同一事象は **`bucket + '|' + kind`** をキーとするエピソードで識別する。例：`'TEST01|RUN_FILE_FAILED'`、`'SYSTEM|RUN_STOPPED'`。

エピソードは §7.6 の状態に保存され、次を持つ。

```
{
  fingerprint: string[],   // 前回送信時点の要素キー（要素ごとの短いハッシュ。最大 NOTIFY_MAX_FINGERPRINT_ELEMENTS_ = 10 個。超える場合は空配列。§7.3）
  fingerprintHash: string, // 常に保存する。ソート済み要素を '\n' で連結した sha256Hex(utf8Bytes(joined)) の先頭 16 桁
  elementCount: number,    // 前回送信時点の要素数（要素キーを保存しないときの「増えた」判定に使う。§7.2 規則 2）
  severity: string,        // 現在の重大度（昇格 §7.2 規則 5 の記録）
  firstSeenAt: ISO,        // このエピソードを最初に観測した時刻
  lastSeenAt: ISO,         // 最後に観測した時刻
  lastSentAt: ISO | null,  // 最後にメールに含めた時刻
  seenCount: number,       // 観測回数（本文の「N回目」に使う）
  sentCount: number        // メールに含めた回数
}
```

### 7.2 判定（純粋関数 `evaluateEpisodes_(buckets, findings, now)`）

観測された各所見について：

1. キーのエピソードが**無い**、または**期限切れ**（`now − lastSeenAt` が重大度の再送窓 §7.4 を超えている）→ **新しいエピソード**を作り、**送る（due）**。
2. エピソードがあり、所見の指紋に**前回の指紋に無い要素**が含まれる → **送る（due）**。指紋を更新する（`firstSeenAt` は保つ）。要素キーが保存されていない場合（要素が 10 個を超えていた、または §7.6 段階 3 の後）は、**`fingerprintHash` が異なり、かつ `elementCount` が増えた**ときだけ「新しい要素がある」とみなす。要素数が同じか減っている場合はハッシュが違っても due にしない（入替りは見逃す。減っただけでは鳴らさない §7.2 末尾の規則を、ハッシュ比較でも保つため）。
3. エピソードがあり、`lastSentAt` が `null`、または `now − lastSentAt ≧ 再送窓` → **送る（due）**。
4. それ以外 → **送らない（continuing）**。ただし本文には「継続中」として載る（§8）。
5. **昇格**（`NOTIFY_ESCALATE_ON_REPEAT_` に載る種類 ── 現在は `INTERRUPTION_RECOVERED` だけ）：エピソードがあり、所見の指紋に**前回の指紋にも含まれる要素**がある（同じ `fileId` がまた中断した）→ エピソードの `severity` を `CRITICAL` にし、**それまでの `severity` が `CRITICAL` でなかったなら送る（due）**。以後は CRITICAL の再送窓（6 時間）で規則 3 を適用する。指紋が 10 個を超えてハッシュ比較になっている場合は、ハッシュが**同一**なら「同じ要素が再び観測された」とみなす。

いずれの場合も `lastSeenAt = now`、`seenCount += 1`。所見の重大度は、エピソードの `severity` の方が重ければそれで上書きする（昇格後の所見は本文でも CRITICAL の行 §5.2 を使う）。

観測されなかったエピソード（所見が消えた）は**そのまま残す**。§7.6 の GC で、`lastSeenAt` が再送窓を超えて古いものだけを消す。→ 消えてから再送窓以内に再発した場合は同じエピソードの継続として扱われ（規則 3 が効き）、再送窓を超えて再発したら新しいエピソードとして即時に鳴る。**これが「失敗→解消→失敗」の揺れで洪水になるのを防ぐ。**

「減った」だけの指紋変化（要素が消えた）は due にしない。理由：改善は緊急ではなく、改善のたびに送ると揺れに弱い。

### 7.3 指紋

- 要素は §5 の表の「指紋の要素」。**件数・時刻・回数を含めない**（含めると毎回変わり、抑制が効かない。事故ではエラー記録が10分ごとに 1 件ずつ増える）。
- 要素はソートし重複を除く。**ハッシュ `sha256Hex(utf8Bytes(elements.join('\n'))).slice(0, 16)`（`90_Utils.gs`。`sha256Hex` はバイト配列を受けるので `utf8Bytes` を必ず挟む）と `elementCount` は常に保存する。**
- 要素そのものは保存しない。**要素キー** `sha256Hex(utf8Bytes(element)).slice(0, 12)`（12 桁）を、要素が `NOTIFY_MAX_FINGERPRINT_ELEMENTS_` = 10 個以下ならソートして保存し、規則 2 の「新しい要素」判定に使う（所見側の要素をその場で同じ式でキー化して比べる）。10 個を超える場合は要素キーを保存せず（空配列）、規則 2 の「ハッシュが異なり要素数が増えた」判定に切り替える。
- 要素キーにする理由（実寸）：`fileId|IntegrityError` は 1 要素 60 バイト前後で、10 個をそのまま保存すると 1 種 850 バイト、13 種で 11 KB になり、9 KB の値上限（§3.5）を**常に**超える（本仕様 v1.2 の見積り「13 種 × 300 B」は誤りだった。レビューで指摘）。12 桁のキーなら 1 要素 15 バイト、1 種 400 バイト前後、13 種で 5.2 KB に収まる（§7.6 に内訳）。キーの衝突は「新しい要素を既存と誤認して鳴らさない」方向にだけ働き、48 ビットで 10 要素なら無視できる。
- 上限を超えたときに**観測中のエピソードを落とす**設計は、次の tick で規則 1 が「エピソード無し」と判定して**10 分ごとに再送する洪水発生器**になる（本仕様 v1.0 の欠陥）。超過時も観測中のエピソードは絶対に落とさない（§7.6）。
- `SCHEDULE_STOPPED`（INFO）は指紋を持たず、発生のたびに due（§7.4）。

### 7.4 再送窓

| 重大度 | 再送窓（`NOTIFY_REPEAT_MINUTES_`） | 理由 |
|---|---|---|
| CRITICAL | **360 分（6 時間）** | 1通目を見逃した管理者に、半日のうちにもう1通届く。継続する事象 1 件あたり最大 4 宛先/日 → 顧客 20 社が同時に落ちても 80 に収まる（§3.4 の安全側上限） |
| WARNING | **1,440 分（24 時間）** | 対処が翌営業日でよい事象。1日1通で十分 |
| INFO | 0（抑制なし） | `SCHEDULE_STOPPED` だけ。1 回のスケジュール（`opsStartScheduledImport` から自動停止まで）で 1 度しか起きない |

「抑えすぎ」への答えがこの表である。**どんなに抑えても、続いている限り CRITICAL は 6 時間ごとに鳴る。** 沈黙は「解消した」か「通知が壊れた」のどちらかであり、後者は画面の「■ メール通知」行（§14）で見分ける。

### 7.5 1日の上限

- 状態に `day`（JST の `yyyy-MM-dd`）と `sentToday`（**宛先数**）を持つ。日付が変わったら 0 に戻す。
- 送信前に `sentToday + 宛先数 > SETTINGS.MAX_EMAILS_PER_DAY` なら送らない（§12）。
- さらに `MailApp.getRemainingDailyQuota() < 宛先数` なら送らない（§12）。Google 側の実測を優先する。

### 7.6 状態の置き場と形

Script Properties に **2 種類のキー**で持つ。1 キーに全部を入れると 9 KB の値上限（§3.5）に顧客数比例で近づき、上限に当たったときの逃げ道が「何かを落とす」しかなくなる（v1.0〜1.1 の欠陥：落とした結果が再送になるか、落とさずに書込を諦めて `lastSentAt` が残らず**毎 tick 全通再送**になるかのどちらかだった）。バケットごとに分ければ、1 キーの大きさは**顧客数に依存しない**。

1 バケットの実寸（最悪）：エピソード 1 件 ＝ 種類名 20 ＋ 要素キー 10 個 × 15 ＝ 150 ＋ `fingerprintHash` 40 ＋ `elementCount` 18 ＋ `severity` 22 ＋ 時刻 3 本 120 ＋ 回数 2 本 30 ＋ 記号 ≒ **400 バイト**。§5 の 13 種すべてが 1 バケットに立っても 5.2 KB。`watch`（§7.8）は 1 件 ≒ 52 バイト（`fileId` 44 桁 ＋ 数値）で上限 `NOTIFY_MAX_WATCH_ENTRIES_` = 40 件 ＝ 2.1 KB。合計 **7.4 KB** が上限であり、`NOTIFY_STATE_MAX_BYTES_` = **8,500** バイト（Google の 9 KB ＝ 9,216 バイトに 700 バイトの余裕）の中に収まる。したがって §7.6 の GC 段階 2 以降は**通常は発動しない**。

総量：Script Properties は合計 500 KB。8.5 KB × 60 ≒ 510 KB なので、**バケットは理論上およそ 60 が上限**（顧客 59 社 ＋ `SYSTEM`）。到達したときの縮退は本仕様の範囲外（顧客数がそこへ近づく前に、キーを別のプロパティストアへ分ける等の設計変更が要る。受入時点の顧客は 1 社）。

**(1) 全体キー `NOTIFY_STATE_V1`**（1 つ。小さく、常に書ける）

```
{
  "version": 1,
  "day": "2026-09-10",
  "sentToday": 3,
  "lastSent": {"at": "2026-09-09T14:10:05+09:00", "subject": "[クレカ自動処理] 要対応 テスト顧客(TEST01): 取込エラー 2件"},
  "lastFailure": {"at": "…", "reason": "MAIL_SEND_FAILED", "detail": "Service invoked too many times…"} | null,
  "quota": {"exhaustedAt": "…", "skipped": 2} | null
}
```

`subject` は 120 文字、`detail` は 200 文字で切って保存する（書込前に必ず。GC ではなく常時の規則）。この形は 1 KB を超えない。

**(2) バケットキー `NOTIFY_BUCKET_V1|{bucket}`**（バケットごとに 1 つ。例 `NOTIFY_BUCKET_V1|TEST01`、`NOTIFY_BUCKET_V1|SYSTEM`）

```
{
  "version": 1,
  "episodes": {
    "RUN_FILE_FAILED": {"fingerprint": ["1a2b3c4d5e6f", "7a8b9c0d1e2f"],   // 要素キー（各要素の sha256Hex 先頭 12 桁）
                        "fingerprintHash": "3f1c0a9e7b2d4c61",            // 連結の sha256Hex 先頭 16 桁
                        "elementCount": 2,
                        "severity": "CRITICAL",
                        "firstSeenAt": "2026-09-09T14:10:03+09:00", "lastSeenAt": "…",
                        "lastSentAt": "…", "seenCount": 36, "sentCount": 2}
  },
  "watch": {"1AbC…": 3, "1DeF…": 3}                             // §7.8
}
```

- エピソードのキーはバケットキーの中では `kind` だけ（バケットはキー名が表す）。§7.1 の `bucket + '|' + kind` はこの 2 つを合わせた論理キーである。
- `fingerprintHash` は `sha256Hex(utf8Bytes(joined))` の**先頭 16 桁**（64 桁は不要。衝突は事象の見落としではなく「変化に気づかない」方向にしか働かず、16 桁で十分小さい）。
- 読取 `readNotificationState_()`：`PropertiesService.getScriptProperties().getProperties()` を **1 回**呼び、全体キーと `NOTIFY_BUCKET_V1|` で始まるキーを拾って `{global, buckets: {bucket: …}, raw: {bucket: 読んだ JSON 文字列}}` に組む。キーが無い・JSON が壊れている・`version !== 1` → そのキーだけ空の初期状態として扱う（**壊れた状態で通知全体を止めない**。壊れていた事実は `Logger.log` に残す）。
- 書込 `writeNotificationState_(state, now)`：各バケットを `garbageCollectNotificationState_(bucketState, now)` に通して `JSON.stringify` し、**読んだときの文字列（`raw`）と異なるバケットだけ**を `setProperty` する（「触った」の定義は**直列化結果の差分**であり、エピソードの変化・`watch` の追加・上書き・**削除だけ**のいずれでも書かれる）。空になったバケット（エピソードも `watch` も無い）は `deleteProperty` で消す。**書込の順序はバケット → 全体キー**の順。理由：途中で実行が切れた場合、この順なら `lastSentAt` は残り `sentToday` だけが過少計上になる（送れる方向の誤り＝日次上限は `MailApp.getRemainingDailyQuota()` が二重に守る §12）。逆順だと `sentToday` は増えたのに `lastSentAt` が無く、再送になる。
- **GC の規則**（バケットごと。この順に適用し、`NOTIFY_STATE_MAX_BYTES_` = 8,500 バイト以下になった時点で止める。**バイト数は `utf8Bytes(json).length` で測る**。JS の `String.length` は UTF-16 単位であり、実バイト数を過小評価する）：
  1. `lastSeenAt` が「その種類の再送窓 × 2」より古いエピソードを削除する（常に行う）。`watch` は `errorTotal` の大きい順に `NOTIFY_MAX_WATCH_ENTRIES_` = 40 件までに切る（常に行う）。
  2. まだ超えていれば、**今回観測されなかった**エピソード（`lastSeenAt < now`）を `lastSeenAt` の古い順に削除する。
  3. まだ超えていれば、全エピソードの `fingerprint` を空配列にする（`fingerprintHash`・`elementCount` は残るので §7.2 規則 2 の判定は続けられる）。
  4. **最終手段**（理論上到達しない：段階 3 の後のエピソードは 1 件 250 バイト前後で、13 種でも 3.3 KB）：`lastSentAt` を持つエピソードだけを `{fingerprintHash, elementCount, severity, lastSentAt, firstSeenAt, lastSeenAt}` の 6 項目に縮め、`lastSentAt` を持たないエピソードと `watch` を落として書く。`Logger.log('[notify] bucket ' + bucket + ' reduced to minimal form')`。
  **今回観測されたエピソードは段階 1〜3 では削除しない。** 削除すると次の評価で規則 1（§7.2）が「新しいエピソード」として即時に送り、10 分ごとの再送になる（§7.3）。**段階 4 でも `lastSentAt` を持つものは必ず残す** ── `lastSentAt` が残る限り規則 3 の再送窓が効き、再送は最大でも窓ごとになる。`lastSentAt` を持たないエピソードは「まだ送っていない」ものであり、落として次回に新規として送られても、それは本来送るべきだった 1 通である。**「書込を諦める」経路は置かない。** 諦めると `lastSentAt` も `sentToday` も残らず、次の評価で全所見が due になって毎 tick 全通再送になる（v1.1 の欠陥。レビューで指摘）。
- 全体キーは GC の対象にしない（常に 1 KB 未満）。`sentToday` は毎回必ず書く。
- 版番号 `version` は将来の形式変更のため。
- **監査ログには書かない。** 監査ログは状態変更と実行者の記録であり（`62_AuditLog.gs`）、通知は状態を変えない。
- **処理ログにも書かない。** 通知失敗を `recordError(fileId, …)` で残す案（設計 §4.5 異常系）は、`SYSTEM` バケットに `fileId` が無く、また事故のような繰返し失敗では W列を通知失敗で埋めて本来のエラーを押し流すので採らない。

### 7.7 排他と保持時間の上限

`dispatchNotifications_`（§13.3）は、状態の読取から書込までを `withScriptLock_` で囲む。取得できなければ（`LEASE_CONFLICT`）**今回は何もしない**で `Logger.log('[notify] skipped: lock')`。次回の tick か監視トリガーで再評価される（状態は変わっていないので due のまま）。ロック保持中に `MailApp.sendEmail` を呼ぶ。理由：送信をロックの外に出すと、2 つの実行が同じ due を同時に送る。

**保持時間の上限**：このロックは `withScriptLock_` が全モジュールで共有する**スクリプトロック**であり、`updateProcessLog`・`acquireLease` 等も同じロックを `LOCK_TIMEOUT_MS`（既定 20,000 ms）だけ待つ（`01_DataAccessCore.gs` 64〜68行）。通知が 20 秒を超えて保持すると、並走中の `runImport`（監視トリガーと tick が重なった場合）の `updateProcessLog` が `LEASE_CONFLICT` で落ち、**通知の仕組みが偽の `RUN_FILE_FAILED` を作る**。そこで：

- 1 回の評価で送るメールは **`NOTIFY_MAX_MAILS_PER_EVALUATION_` = 3 通まで**。due なバケットが 4 つ以上あれば、重大度の重い順（同じなら `firstSeenAt` の古い順）に 3 つだけ送る。**後回しにしたバケットも状態は書く**（エピソードは作られ、`lastSentAt` は `null` のまま）。こうすると次回は規則 3（`lastSentAt` が `null`）で due になり、`firstSeenAt` が今回の時刻で残るので「古い順」の優先が後回し組にも効く（書かないと次回また `firstSeenAt = now` で作り直され、永遠に後回しにされ得る）。
- 保持時間の見積り：状態の読取 1 回（`getProperties`）＋ 送信 3 通 × 1〜2 秒 ＋ 書込 最大 4 キー ≒ **最大 8 秒**。`LOCK_TIMEOUT_MS` の 20 秒に対して十分な余裕がある。
- `getActiveCustomers()`・`collectImportStatus_()`・所見の組立て・本文の組立て（due の判定前にバケットごとに組んでおく。due でなければ捨てる）は**ロックの外**で済ませておく（ロック内で行うのは読取・判定・送信・書込だけ）。

**状態の読取回数（流れ）**：状態層の評価 `notifyImportState_` は状態を**2 回**読む。

1. **ロックの外で 1 回**（`readNotificationState_()`）：`watch` の判定（§7.8）のためのスナップショット。ここで読んだ `buckets` を `stateFindingsFromCollected_` に渡す。並走する別の評価がこの後に `watch` を進めても、起きるのは「次の tick で 1 回だけ鳴るのが遅れる」だけ（§7.8）。
2. **ロックの中で 1 回**（`dispatchNotifications_` の先頭）：エピソードの判定と書込は必ずこの新しい値に対して行う。1 で読んだ値はロック内では使わない（古い値でエピソードを上書きすると、並走した評価の `lastSentAt` を消して再送になる）。

実行結果層 `notifyRunReport_` は `watch` を使わないので 2 だけ（1 回）。

### 7.8 `watch` ── 取込待ちファイルのエラー記録の記憶

`REPEATED_FAILURE`（§5.1）の「増えた」を判定するための記憶。バケットキー（§7.6）の `watch` に `{fileId: errorTotal}` で持つ。

- **`errorTotal`**：`files[].errorCount + files[].errorDropped`。`errorDropped` は W列先頭の打切りマーカーの `droppedCount`（無ければ 0。§5.1「なぜ `errorTotal` か」）。`collectImportStatus_` が返す（§13.4）。
- **意味**：そのファイルを**前回の評価で取込待ち（`DISCOVERED`）として見たとき**の `errorTotal`。
- **更新**（通知側の評価 `notifyImportState_` だけが行う。画面は読むだけ）：`assessImportStatus_` を呼んだ**後**に、その顧客の `files` を走査して
  - `state === 'DISCOVERED'` かつ `errorTotal >= 1` → `watch[fileId] = errorTotal`（上書き）。
  - `state ∈ {VALIDATING, WRITING}` → **据え置く**（取込中。監視トリガーが取込の最中に評価しても比較の基準を失わないため）。
  - それ以外の状態、または `files` に無い → 削除。
- **判定に使う順序**：判定は「前回の値」と比べるので、`assessImportStatus_` には**更新前**の `watch`（ロック外で読んだスナップショット §7.7）を渡す。更新は判定の後。
- 大きさ：対象は `DISCOVERED ∧ errorTotal ≧ 1` のファイルだけで通常 0〜数件。1 件 52 バイト前後。§7.6 段階 1 で `errorTotal` の大きい順に 40 件に切る（41 件以上そういうファイルがある状況は、それ自体が `ERROR_RECORDS` 41 件として鳴っている）。
- 画面の読取 `readNotificationWatch_()`（§13.3）は全バケットの `watch` を 1 つの `{fileId: errorTotal}` に併合して返す（`fileId` は全顧客で一意）。

事故での動き：tick#1 先頭は `errorTotal 0` なので記憶しない。tick#2 先頭で `1` を記憶し（この時点は `ERROR_RECORDS`）、tick#3 先頭で `2 > 1` となり `REPEATED_FAILURE`。以後 tick ごとに 1 ずつ増え、V列が 199 で頭打ちになった後も `droppedCount` が増えるので「増えた」は真のまま続く。管理者が原因を直して巻き戻した場合：巻戻し後の最初の評価で `errorTotal`（例 7）を記憶するだけで鳴らず、次の tick で取り込めれば `DISCOVERED` を離れて記憶が消える。取り込めずに戻れば `8 > 7` で鳴る ── **「直したはずなのにまた失敗した」ときだけ鳴る**。

---

## 8. 本文の制約とテンプレート

### 8.1 制約（仕様 §21.3・§23.5・§23.7、設計 §4.5）

本文・件名に**含めてよいもの**：顧客名と顧客ID、件数、事象の種類と対処、`fileId`（Drive の不透明な ID。`opsReprocessFile(fileId)` に必要）、エラーコード／例外クラス名、実行ID、時刻、マスタースプレッドシートへのリンク。

**含めてはならないもの**：利用店名、金額、利用日、使用用途、明細本文、カード番号・名義、**元ファイル名**（カード名や口座名を含み得る。処理ログ上で `fileId` から辿れる）、エラーの `message`／`detail`（セル内容が混じり得る）、トリガー実行アカウント（設計 §4.5）、他顧客の情報。

`fileId` は 1 種類の所見につき最大 `NOTIFY_MAX_LISTED_IDS_` = 10 個まで列挙し、超えた分は「ほか N 件」。**`SYSTEM` バケットのメールには `fileId` を一切列挙しない**（件数だけ）。`SYSTEM` は全顧客の管理者へ届くので、どの顧客の `fileId` であっても他顧客に見せることになる（仕様 §20.1）。`elements` は指紋のためだけに使う。

### 8.2 件名

```
[クレカ自動処理] {重大度ラベル} {宛先名}: {要約}
```

- 重大度ラベル：due な所見の中で最も重いもの。`CRITICAL → 要対応`、`WARNING → 注意`、`INFO → 情報`。
- 宛先名：顧客バケットは `{顧客名}({顧客ID})`、`SYSTEM` は `システム`。
- 要約：due な所見の**短い要約**（下表）を「、」で連結。3 つを超えたら先頭 3 つ ＋ `ほかN件`。

| kind | 短い要約 |
|---|---|
| `RUN_FILE_FAILED` | `取込エラー N件` |
| `RUN_CUSTOMER_SKIPPED` | `取込開始不可 {skipped}` |
| `RUN_STOPPED` | `定期取込停止 {stoppedBy}` |
| `HOUSEKEEPING_FAILED` | `後始末失敗` |
| `STATUS_CHECK_FAILED` | `状態確認不可` |
| `FAILED_FILES` | `失敗ファイル N件` |
| `REPEATED_FAILURE` | `取込失敗を繰り返すファイル N件` |
| `STALLED` | `停止中ファイル N件` |
| `IMPORT_IDLE` | `取込待ちが止まっています N件` |
| `CUSTOMER_FIX` | `顧客修正待ち N件` |
| `ERROR_RECORDS` | `エラー記録あり N件` |
| `INTERRUPTION_RECOVERED` | WARNING: `中断から回復 N件`。CRITICAL（昇格後）: `繰り返し中断 N件` |
| `AUDIT_CHAIN_BROKEN` | `監査ログ連鎖破損` |
| `SCHEDULE_STOPPED` | `定期取込を自動停止` |

例：`[クレカ自動処理] 要対応 テスト顧客(TEST01): 取込エラー 2件`

### 8.3 本文の構成（プレーンテキスト）

```
クレカ自動処理からの自動通知です。

宛先: {顧客名}({顧客ID})                    ← SYSTEM は「システム全体」
検知: {yyyy-MM-dd HH:mm}（{検知元}）        ← 検知元: 定期取込 RUN_… ／ 監視トリガー
コード版: {VERSIONS.CODE}

■ 新しく検知した異常
{所見ごとに:}
{line}
  状態: 新規 ／ 継続中（最初の検知 {firstSeenAt}、{seenCount} 回目、前回の通知 {lastSentAt}）
  対象: fileId {id1}, {id2}, …（最大10件。ほか N 件）      ← 要素が fileId で、かつ顧客バケットのときだけ（SYSTEM では出さない §8.1）
  エラー: {errorCode ごとの件数。例 IntegrityError 2}       ← RUN_FILE_FAILED だけ
  対処: {action}

■ 継続中の異常（前回通知済み）                              ← 無ければ節ごと省く
{所見ごとに 1 行: line ＋「（最初の検知 {firstSeenAt}）」}

■ リンク
処理ログ: {masterUrl}#gid={処理ログの sheetId}
要確認:   {masterUrl}#gid={要確認の sheetId}
（スプレッドシートを開いて「クレカ自動処理 ▸ 取込の状況」でも確認できます）

■ この通知について
同じ事象は {再送窓} は再送しません（要対応: 6時間、注意: 24時間）。解消しても通知しません。
{quota があれば:} 前回までにクォータ上限で {skipped} 件の通知を送れませんでした。
{顧客マスター読取失敗時:} 顧客マスターを読めなかったため、管理者宛てを省略しました。
```

- 日時は `toIso8601(date).slice(0, 16).replace('T', ' ')`（JST、分まで。メニュー仕様 §6.4 と同じ見た目）。
- `masterUrl = masterSpreadsheet_().getUrl()`。`sheetId` は `processLogSheet_().getSheetId()`・`reviewSheet_().getSheetId()`。マスターが読めないとき（`STATUS_CHECK_FAILED`）は「■ リンク」を `（マスターを開けないため省略）` にする。
- HTML は使わない（`htmlBody` を渡さない）。理由：エスケープの失敗面を増やさない。表示が崩れる要素も無い。

### 8.4 実例 1 ── 事故の 1 通目（定期取込 1 回目の末尾）

```
件名: [クレカ自動処理] 要対応 テスト顧客(TEST01): 取込エラー 2件

クレカ自動処理からの自動通知です。

宛先: テスト顧客(TEST01)
検知: 2026-09-09 14:10（定期取込 RUN_7f3a…）
コード版: 3.0.0

■ 新しく検知した異常
⚠ 取込に失敗したファイルが 2 件あります（この実行）
  状態: 新規
  対象: fileId 1AbCdEf…, 1GhIjKl…
  エラー: IntegrityError 2
  対処: 処理ログの W列（エラー）で詳細を確認してください。同じファイルが毎回失敗している場合、状態が取込待ちに戻っていても取込は前に進んでいません

■ リンク
処理ログ: https://docs.google.com/spreadsheets/d/1xxxx#gid=123
要確認:   https://docs.google.com/spreadsheets/d/1xxxx#gid=456
（スプレッドシートを開いて「クレカ自動処理 ▸ 取込の状況」でも確認できます）

■ この通知について
同じ事象は 6時間 は再送しません（要対応: 6時間、注意: 24時間）。解消しても通知しません。
```

明細内容・ファイル名・エラーメッセージ（"Submitted content hash is immutable"）は**含まれていない**。

### 8.5 実例 2 ── 事故の 2 通目（定期取込 2 回目の先頭。状態層）

```
件名: [クレカ自動処理] 注意 テスト顧客(TEST01): エラー記録あり 2件

…
■ 新しく検知した異常
△ エラー記録のあるファイルが 2 件あります。「ファイル一覧」の「最後のエラー」を確認してください
  状態: 新規
  対象: fileId 1AbCdEf…, 1GhIjKl…
  対処: 取込待ち（DISCOVERED）のファイルにエラー記録がある場合は、取込のたびに失敗して戻されている可能性があります。処理ログ W列の最新のコードを確認してください

■ 継続中の異常（前回通知済み）
⚠ 取込に失敗したファイルが 2 件あります（この実行）（最初の検知 2026-09-09 14:10）
…
```

### 8.6 実例 3 ── 設定不備で取込が始まらない（SYSTEM）

```
件名: [クレカ自動処理] 要対応 システム: 定期取込停止 SETTINGS_INVALID

…
宛先: システム全体
検知: 2026-09-10 09:00（定期取込 RUN_…）

■ 新しく検知した異常
⚠ 定期取込が実行前に停止しました（理由: SETTINGS_INVALID）
  状態: 新規
  対象: 検査 #11 separateSpreadsheets
  対処: NO_AUTHORIZED_CUSTOMER: トリガー作成者が顧客マスターの Q/R 列に無い。SETTINGS_INVALID: 「診断 ▸ 設定の検査」で不合格の項目を確認。LOG_CAPACITY_EXCEEDED: 保存先の容量
…
```

`SETTINGS_INVALID` の「対象」は `report.settingsProblems[].check` と `name` だけを出す。`detail` は出さない（設定値やIDが混じるため）。

---

## 9. 警告判断を画面と共有する方法

### 9.1 問題

現在、画面の警告 5 行の判定は `buildImportStatusView_`（`96_Menu.gs` 362〜447行）の中に埋め込まれ、文言と一体になっている。通知が同じ判定を別に書けば、次に条件を変えたとき片方だけ変わる。**画面とメールで判断がずれてはいけない**（本仕様の前提）。

### 9.2 解決：判定を `assessImportStatus_` へ抽出し、画面とメールの両方がそれを呼ぶ

**新設**：`97_Ops.gs` に `assessImportStatus_(scoped, now, watch)`（純粋関数）。`collectImportStatus_` の隣に置く（「集める」と「判断する」を対にする。表示器は `96_Menu.gs` と `95_Notifications.gs` の 2 つ）。

```
assessImportStatus_(scoped, now, watch) → {
  stateCounts: {DISCOVERED: n, …, FAILED: n},   // 9 状態すべて（0 でもキーを出す）
  stuckFiles: file[],                           // VALIDATING/WRITING かつ（リース無し ∨ 停滞）
  stalledLeases: lease[],                       // scoped.leases のうち stalled
  findings: finding[]                           // §5.1 の 6 種を表の順で。該当しないものは含めない
}
```

- 引数 `scoped` は `{files, leases, lastActivityAt}`。**閲覧範囲・顧客で絞り終えた後の配列**を渡す（絞込は呼出側の責務。画面は `filterByScope_`、通知は `filterCollectedByCustomer_` §9.3）。`reviews` は判定に使わないので受け取らない。
- `now` は `Date`。
- `watch` は `{fileId: errorTotal}`（§7.8）。`undefined`／`null` は空とみなす（`REPEATED_FAILURE` が出ないだけで、他の判定は同じ）。`errorTotal` は `scoped.files[].errorCount + scoped.files[].errorDropped`（`errorDropped` が無い古い形の入力は 0 とみなす）。
- 日時の変換（`lastActivityAt`・`now` の経過分）には **`97_Ops.gs` の `menuStatusDate_`** を使う。`96_Menu.gs` の `menuDateMilliseconds_` を使うと `97 → 96` の依存ができる（メニューが無い文脈＝通知からも呼ばれる関数がメニューのファイルに依存する）。`buildImportStatusView_` 側の他の箇所は従来どおり `menuDateMilliseconds_` でよい。
- 判定式・順序・`line` の文言は `buildImportStatusView_` の現在の実装から**移す**。`covered` の扱い（先に該当した所見のファイルを後の所見から除く）もそのまま。移した後、`FAILED_FILES` の直後に `REPEATED_FAILURE`（§5.1）を**追加**する。既存 5 行の文言と相対順序は変えない。各 `finding` の `elements` は該当ファイルの `fileId` をソートしたもの、`count` は現在の `N`、`bucket` は呼出側が後から埋める（`assessImportStatus_` は `bucket` を `null` で返す）。
- `findings` が空のとき「異常は見つかりませんでした」の行は**含めない**（それは表示器の責務）。

**改修**：`buildImportStatusView_(collected, scope, now, triggerCount, watch)` は、`filterByScope_` の後に `assessImportStatus_({files, leases, lastActivityAt: collected.lastActivityAt}, now, watch)` を呼び、`warnings = assessment.findings.map(f => f.line)`、空なら `['異常は見つかりませんでした']` とする。`stateCounts`・`stuckFiles.length`・`stalledLeases.length` も戻り値から取る。第 5 引数 `watch` は `menuShowImportStatus` が `readNotificationWatch_()`（§13.3）で読んで渡す（読取失敗は `null`）。**既存 5 行の本文は一字一句変わらず**（`test/phase7-menu-readonly.test.js` のテスト 9・10・11・13 は 4 引数のまま呼ぶので `watch` が無く、そのまま通ることで検証）、`REPEATED_FAILURE` の行だけが該当時に加わる（メニュー仕様 §7.1 v1.2・テスト 37）。

**通知側**：`stateFindingsFromCollected_(collected, customersById, now, buckets)`（`95_Notifications.gs`）が、`collected` を顧客ごとに `filterCollectedByCustomer_` で絞り、顧客ごとに `assessImportStatus_(scoped, now, buckets[customerId].watch)` を呼び、返った `findings` に `bucket = customerId` を埋める。`customerId` が空の行は `'SYSTEM'` バケットとして同様に判定する。判定の後に §7.8 の規則で `watch` を更新する。

### 9.3 `filterCollectedByCustomer_(collected, customerId)`（`97_Ops.gs` に新設・純粋）

`collected.files`・`collected.leases` を `String(item.customerId || '') === String(customerId)` で絞る。`customerId` に `'SYSTEM'` を渡したときは `customerId` が空の行だけを返す。`lastActivityAt` はそのまま渡す。`reviews` は返さなくてよい。

画面の `filterByScope_`（`96_Menu.gs`）は変えない（複数顧客・オーナー特例という画面固有の絞込であり、判断ではない）。

### 9.4 呼出関係（確定）

| 呼ぶ側 | 呼ばれる側 | 何を渡すか |
|---|---|---|
| `menuShowImportStatus`（96） | `collectImportStatus_`（97）→ `buildImportStatusView_`（96）→ **`assessImportStatus_`（97）** | 閲覧範囲で絞った `{files, leases, lastActivityAt}` |
| `notifyImportState_`（95） | `collectImportStatus_`（97）→ `stateFindingsFromCollected_`（95）→ **`filterCollectedByCustomer_`（97）→ `assessImportStatus_`（97）** | 顧客ごとに絞った同じ形 |
| `notifyRunReport_`（95） | `runFindingsFromReport_`（95） | `runImport` の報告 |

`95_Notifications.gs` は `96_Menu.gs` の関数を**呼ばない**（通知がメニューに依存する形にしない）。`96_Menu.gs` は `95_Notifications.gs` の `notificationStatusLines_` だけを呼ぶ（§14）。

### 9.5 同一性の固定（テスト）

§15 のテスト 12：同じ `collected` と同じ `watch` に対して、`buildImportStatusView_(...).text` に含まれる警告行の列と、`assessImportStatus_(...).findings.map(f => f.line)` が完全に一致する（6 種すべてが出る入力と、0 種の入力の両方）。テスト 13：通知側の `stateFindingsFromCollected_` が顧客 `C001` について返す `findings` の `line` 列が、`assessImportStatus_(filterCollectedByCustomer_(collected, 'C001'), now, watch).findings` と一致する。

---

## 10. いつ送るか

### 10.1 決定

| 送信点 | 層 | タイミング | 追加の読取 |
|---|---|---|---|
| A | 状態層 | `scheduledImportTick` の**先頭**（後始末の直後、`runImport` の前） | `collectImportStatus_` の 4 回 ＋ `getActiveCustomers` 1 回 |
| B | 実行結果層 | `scheduledImportTick` の**末尾**（残件判定・自己停止の後） | `getActiveCustomers` 1 回（A で読んだ結果を tick の中で持ち回してよい。実行ごとにグローバルは初期化されるので、tick 内の変数で渡す） |
| C | 状態層 | **監視トリガー `notificationWatchdogTick`**（1 時間間隔、別トリガー） | A と同じ |

### 10.2 理由

**A を先頭に置く**：tick は 5 分を超え得る（§3.3）。末尾に 4 回の読取と送信を置くと、6 分の強制終了で通知だけが失われる回が出る。先頭なら必ず走る。先頭で見える状態は「前回までの結果」であり、事故の 2 回目以降はここで `ERROR_RECORDS` が出る。

**B を末尾に置く**：実行報告は `runImport` が返った後にしか無い。追加の読取は顧客マスター 1 回だけ（A の結果を持ち回せば 0 回）で、送信は 1 通 1 秒程度。強制終了に巻き込まれたとしても、失われるのは「この回の報告による通知」だけで、状態層が次の tick の先頭で拾う（`FAILED`・`ERROR_RECORDS`・`STALLED` のいずれかに残る）。**B を A の前に持ってくることはできない**（報告がまだ無い）。

**C を別トリガーにする**：監視対象と同じトリガーに乗った監視は、対象が止まると一緒に止まる。定期取込は残件なしで自分を消す（`scheduledImportTick` 1552行）。消えた後に新しいファイルが置かれると、`DISCOVERED` のまま誰も拾わない。この状態は A・B では検知できない（tick が無い）。C が `IMPORT_IDLE` を鳴らす。1 時間間隔にするのは、`IMPORT_IDLE` の閾値が 30 分であり、それより細かく見ても意味が無く、4 読取/時 = 96 読取/日で済むからである。**C は自分を消さない。** 止めるのは `opsStopNotificationWatchdog` だけ。

**A と C が同じ関数 `notifyImportState_` を呼ぶ**ので、A が動いている間は C は「due 無し」で終わる（§7 の抑制が共有される）。二重送信は §7.7 のロックで防ぐ。

### 10.3 監視トリガーの運用

- `opsStartNotificationWatchdog()`：`NOTIFICATION_WATCHDOG_HANDLER_` = `'notificationWatchdogTick'` の既存トリガーを消してから、`ScriptApp.newTrigger(NOTIFICATION_WATCHDOG_HANDLER_).timeBased().everyHours(1).create()`。戻り値 `{started: true, removedExisting: n, triggerId}`。`opsStartScheduledImport` と同じ書き方。
- `opsStopNotificationWatchdog()`：同ハンドラ名のトリガーだけを消す。`opsStopScheduledImport` は `scheduledImportTick` だけを消す（既存どおり）ので、互いに巻き込まない。
- `notificationWatchdogTick()`：`loadSettingsFromProperties()` → `notifyImportState_({now: new Date(), source: 'WATCHDOG'})`。それ以外は何もしない。
- 導入手順：`opsStartNotificationWatchdog` を**一度だけ**実行し、以後は放置する。定期取込を止めても監視は止めない。

### 10.4 事故に当てはめた時系列

```
14:10 tick#1 先頭A: 状態に異常なし → 送らない
      runImport: 2ファイルが IntegrityError で FAILED（報告）→ 状態は DISCOVERED に戻る（errorCount 1）
      末尾B: RUN_FILE_FAILED 新規 → ★メール1通目（要対応）
14:20 tick#2 先頭A: ERROR_RECORDS 新規（2ファイル、errorCount 1）→ ★メール2通目（注意。RUN_FILE_FAILED を継続中として併記）
      末尾B: RUN_FILE_FAILED 指紋同一・6時間未満 → 送らない                    （errorCount 2）
14:30 tick#3 先頭A: REPEATED_FAILURE 新規（watch の 1 より errorCount 2 が大きい。ERROR_RECORDS は covered で消える）→ ★メール3通目（要対応）
14:40〜20:00 tick#4〜#36: A も B も送らない（指紋同一）
20:10 tick#37 末尾B: RUN_FILE_FAILED の lastSentAt から 6 時間 → ★メール4通目（「37回目」と表示）
20:30 tick#39 先頭A: REPEATED_FAILURE の 6 時間 → メール5通目
```

素朴な設計の「20 通以上／数時間」が、**最初の 30 分で 3 通、その後は 6 時間ごとに 2 通**になる。最初の 1 通は事故発生の 10 分以内に届く。

**tick#1 の末尾 B が 6 分の強制終了で失われた場合**（バックログのある日）：メール1通目が無くなり、14:20 に注意（ERROR_RECORDS）、**14:30 に要対応（REPEATED_FAILURE）** が届く。要対応が出るまで最長 30 分。これが §1.3 の「両方の層で要対応になる」の意味である。

---

## 11. 送信失敗時の扱い

原則：**メールが送れなくても取込を止めない。** 通知は取込の付属物であり、主従を逆にしない。

1. 通知の入口（`notifyImportState_`・`notifyRunReport_`・`notificationWatchdogTick` の本体）は**全体を `try/catch` で包む**。捕捉した例外は `Logger.log('[notify] ' + 関数名 + ' failed: ' + (error.stack || String(error)))` に残し、**再送出しない**。`scheduledImportTick` の他の処理には影響させない。
2. `MailApp.sendEmail` の例外は `sendNotificationMail_` が捕捉し、`{sent: false, reason: 'MAIL_SEND_FAILED', detail: String(error.message).slice(0, 200)}` を返す。呼出側は：
   - そのメールに含めた所見の `lastSentAt` を**更新しない**（次回の評価で再び due になり、再試行される）。
   - `sentToday` を増やさない。
   - 状態の `lastFailure = {at, reason, detail}` を更新する（画面 §14 に出る）。
   - 同じ実行の中で**再試行しない**（`SPREADSHEET`／`Drive` の一時エラーと違い、送信失敗は承認・クォータ・宛先不正のいずれかであり、直後に直らない）。
3. 宛先が空（§6.1）→ 送らず `lastFailure: {reason: 'NO_RECIPIENT'}`。
4. ロックが取れない → §7.7。`lastFailure` は更新しない（状態を書けないため）。`Logger.log` だけ。
5. 状態の書込（`setProperty`）が失敗 → 例外は 1 で捕捉される。この場合、送信済みの所見が次回また due になり得る（重複 1 通）。Script Properties の書込失敗は通常起きないので許容し、対策はしない。
6. **通知の失敗を通知しない**（再帰）。失敗は画面の「■ メール通知」行と `Logger` で見る。

---

## 12. クォータ枯渇時の扱い

1. 送信前に 2 つを見る：`sentToday + 宛先数 > SETTINGS.MAX_EMAILS_PER_DAY`、または `MailApp.getRemainingDailyQuota() < 宛先数`。どちらかが真なら**送らない**。
2. 送らなかった場合：
   - 所見の `lastSentAt` を更新しない（回復後に due のまま送られる）。
   - 状態の `quota = {exhaustedAt: now, skipped: (前回の skipped || 0) + 送らなかったメールの通数}` を更新する。**単位はメールの通数**（バケットごとに組み立てた 1 通を 1 と数える。評価回数でも宛先数でもない）。1 回の評価で 2 バケットが due で両方送れなければ +2。
   - `Logger.log('[notify] skipped: quota (' + 理由 + ')')`。
3. **回復時刻を予測しない**（§3.4。公開されていない）。次の評価（10 分後・1 時間後）で再び 1 を判定するだけである。
4. 回復後の最初の送信の本文に「前回までにクォータ上限で {skipped} 件の通知を送れませんでした」を付け、`quota` を `null` に戻す。
5. `MailApp.getRemainingDailyQuota()` 自体が例外を投げた場合（未承認等）は、残量 0 とみなして 2 に進む。
6. `SETTINGS.MAX_EMAILS_PER_DAY` が未設定（`null`）の場合は設定検証 #7 で取込自体が止まる（`RUN_STOPPED`）ので、通知側は `Number(SETTINGS.MAX_EMAILS_PER_DAY) || 80` として扱う。

---

## 13. ファイル名・配置・関数一覧・既存コードの改修

### 13.1 ファイル名：`src/95_Notifications.gs`

設計 §4.5 は `04_Notifications.gs` を指定している。それでも `95_` にする。理由はメニュー仕様 §9.1 と同じ判断による。

1. **読込順**。GAS と Node ハーネスはファイルを名前順にグローバルスコープ評価する。`04_` に置くと `60_`・`97_` 等より先に評価され、うっかりトップレベルで `PROCESS_FIELD_COLUMNS_` 等を参照すると**プロジェクト全体が読込時に落ち、定期取込まで止まる**（メニュー仕様 §3.2）。`95_` なら依存先（`00`〜`94`）がすべて先に評価済み。`96_Menu.gs`（§14 で本ファイルの関数を呼ぶ）より前、`97_Ops.gs`（本ファイルの関数を `scheduledImportTick` から呼ぶ）より前に置くことで、`95 → 97` の呼出しは実行時、`97 → 95`・`96 → 95` の呼出しも実行時であり、読込順に依存しない。
2. **契約が設計 §4.5 と違う**。設計の `notifyError(runId, errorCode, context)` 等は「事象ごとに 1 通」の押し出し型であり、それをそのまま作ると §1.4 の洪水になる。本仕様は「所見を集めて抑制して 1 通」の型なので、設計の関数名（`notifyProcessComplete` `notifyReviewRequired` `notifyError` `notifyInterruption` `notifyQuotaWait` `notifyLogCapacityWarning` `notifyRenameRetryExhausted` `notifyLeaseForceReleased` `notifyAuditChainBroken` `notifyAlerts`）は**定義しない**。将来 `04_Notifications.gs` を設計どおり作る段になったら、本ファイルの `dispatchNotifications_` をその下請けにできる。
3. **配置の意味**。`9x` は運用の入口が並ぶ帯（`90_Utils` `96_Menu` `97_Ops` `98_ReleaseGate` `99_Test`）。通知は定期取込（`97`）とメニュー（`96`）の付属物であり、隣に置くのが読み手に自然。

ファイル先頭のコメントに「設計 §4.5 `04_Notifications.gs` の暫定実装。継続トリガー（4.35）・メトリクス（4.36）・クォータ管理（4.37）実装まで、定期取込と状態監視の通知だけを扱う。事象ごとの押し出し型ではなく、所見を集めて抑制する型にした理由は 2026-09-09 の事故（10分ごとに数時間落ち続けて誰も気づかず、素朴に送れば20通を超えた）」と書く。

### 13.2 `95_Notifications.gs` の読込時の規律とトップレベル定数

メニュー仕様 §9.2 と同じ：**トップレベルには関数宣言と、リテラルだけで作った `var` 定数以外を置かない**。他ファイルのグローバルはトップレベルで参照しない。

```
var NOTIFY_STATE_PROPERTY_ = 'NOTIFY_STATE_V1';
var NOTIFY_BUCKET_PROPERTY_PREFIX_ = 'NOTIFY_BUCKET_V1|';
var NOTIFY_MAX_MAILS_PER_EVALUATION_ = 3;
var NOTIFY_MAX_WATCH_ENTRIES_ = 40;
var NOTIFY_REPEAT_MINUTES_ = {CRITICAL: 360, WARNING: 1440, INFO: 0};
var NOTIFY_SEVERITY_LABELS_ = {CRITICAL: '要対応', WARNING: '注意', INFO: '情報'};
var NOTIFY_SUBJECT_PREFIX_ = '[クレカ自動処理]';
var NOTIFY_SENDER_NAME_ = 'クレカ自動処理';
var NOTIFY_MAX_LISTED_IDS_ = 10;
var NOTIFY_MAX_FINGERPRINT_ELEMENTS_ = 10;
var NOTIFY_ELEMENT_KEY_LENGTH_ = 12;
var NOTIFY_FINGERPRINT_HASH_LENGTH_ = 16;
var NOTIFY_STATE_MAX_BYTES_ = 8500;
var NOTIFY_ESCALATE_ON_REPEAT_ = {INTERRUPTION_RECOVERED: true};
var NOTIFICATION_WATCHDOG_HANDLER_ = 'notificationWatchdogTick';
```

### 13.3 `95_Notifications.gs` に置く関数

| 関数 | 公開/非公開 | 純粋か | 責務 |
|---|---|---|---|
| `notifyImportState_(options)` | 非公開 | 否 | 状態層の入口。`options = {now: Date, source: 'TICK'\|'WATCHDOG', housekeeping: {released, recovered, fileIds, error} \| null, customers: Customer[] \| null}`。順序：`readNotificationState_()`（ロック外の 1 回目。§7.7）→ `collectImportStatus_` → `stateFindingsFromCollected_`（1 回目の `buckets` で `watch` を判定し、更新後の `watchByBucket` を得る §7.8）→ 後始末の所見（`HOUSEKEEPING_FAILED`・`INTERRUPTION_RECOVERED`）を加える → バケットごとの本文を組む → `dispatchNotifications_`（ロック内で 2 回目の読取）。全体を try/catch（§11）。収集が例外なら `STATUS_CHECK_FAILED` の所見 1 つ**と後始末の所見**（`fileId → customerId` が引けないので `INTERRUPTION_RECOVERED` は `SYSTEM` バケット・件数だけ）で `dispatchNotifications_` を呼ぶ。後始末の所見をその回に捨てない |
| `notifyRunReport_(report, options)` | 非公開 | 否 | 実行結果層の入口。`options = {now, scheduleStopped: boolean, customers}`。`runFindingsFromReport_` → `dispatchNotifications_`。全体を try/catch |
| `runFindingsFromReport_(report, scheduleStopped)` | 非公開 | **純粋** | §5.2 の所見を作る。`report` が `null` でも空配列を返す |
| `stateFindingsFromCollected_(collected, customersById, now, buckets)` | 非公開 | **純粋** | §9.2。顧客ごと＋`SYSTEM` の所見。`buckets` は §7.6 (2) の `{bucket: bucketState}`。戻り値 `{findings, watchByBucket}`（`watchByBucket` は §7.8 で更新した後の `watch`。呼出側が `dispatchNotifications_` に渡して書かせる）。引数を破壊しない |
| `housekeepingFindings_(housekeeping, customerIdByFileId)` | 非公開 | **純粋** | `HOUSEKEEPING_FAILED`（`SYSTEM`）・`INTERRUPTION_RECOVERED`（`fileId` を `customerIdByFileId` で顧客バケットに振り分け、引けないものは `SYSTEM`）。`customerIdByFileId` は `notifyImportState_` が `collectImportStatus_().files` から作る |
| `evaluateEpisodes_(buckets, findings, now)` | 非公開 | **純粋** | §7.2（昇格 規則 5 を含む）。`buckets` は §7.6 (2) の `{bucket: bucketState}`。`{buckets: 更新後, due: finding[], continuing: finding[], touched: bucket[]}` を返す。引数を破壊しない（複製して返す） |
| `composeNotificationMail_(bucket, dueFindings, continuingFindings, context)` | 非公開 | **純粋** | §8。`context = {customerName, now, source, runId, links: {processLog, review} \| null, episodes, quotaSkipped, customerMasterUnavailable, codeVersion}`。`{subject, body}` |
| `notificationRecipients_(bucket, customersById, effectiveUser)` | 非公開 | **純粋** | §6 |
| `dispatchNotifications_(findings, options)` | 非公開 | 否 | `options = {now, source, runId, customersById, effectiveUser, watchByBucket, links}`。ロック（§7.7）→ 状態読取（ロック内の 1 回。ロック外で読んだ値は使わない）→ `evaluateEpisodes_` → due のあるバケットを重い順に最大 3 つ → `composeNotificationMail_` → 上限判定（§12）→ `sendNotificationMail_` → 成功した所見の `lastSentAt`・`sentCount`・`sentToday` 更新 → `watchByBucket` を各バケットに反映 → 差分のあるバケット、次いで全体キーの順に書込（§7.6）。`{sent: n, skipped: n, failed: n, deferred: n}` を返す |
| `sendNotificationMail_(recipients, mail)` | 非公開 | 否 | `MailApp.sendEmail({to: recipients.join(','), subject, body, name: NOTIFY_SENDER_NAME_})`。§11 の形で返す。`noReply` は使わない（消費者アカウントでは使えない） |
| `readNotificationState_()` / `writeNotificationState_(state, now)` | 非公開 | 否 | §7.6。読取は `getProperties()` 1 回。書込は直列化結果が読取時と異なるバケット → 全体キーの順 |
| `readNotificationWatch_()` | 非公開 | 否 | 全バケットの `watch` を併合した `{fileId: errorTotal}`。画面（§14）が使う。読取は `getProperties()` 1 回。読取失敗は `null` |
| `garbageCollectNotificationState_(bucketState, now)` | 非公開 | **純粋** | §7.6 の GC 4 段階と 8,500 バイト規律（`utf8Bytes` で測る）。観測中のエピソードは段階 1〜3 で落とさず、段階 4 でも `lastSentAt` を持つものは残す |
| `effectiveUserEmail_()` | 非公開 | 否 | `Session.getEffectiveUser().getEmail()`。取れなければ `''` |
| `notificationStatusLines_(globalState, now)` | 非公開 | **純粋** | §14 の 2 行（全体キーだけを見る） |
| `notificationWatchdogTick()` | **公開**（トリガーハンドラ） | 否 | §10.3 |
| `opsStartNotificationWatchdog()` / `opsStopNotificationWatchdog()` | 公開 | 否 | §10.3 |
| `opsSendTestNotification()` | 公開 | 否 | `effectiveUserEmail_()` 宛てに件名 `[クレカ自動処理] テスト送信`、本文に時刻とコード版だけの 1 通を送る。**抑制・上限の対象外**（状態を読まない・書かない）。戻り値 `{sent, to, remainingQuota, error}` を `Logger.log`。U-N1 の確認用 |
| `opsShowNotificationState()` | 公開 | 否 | 状態を `JSON.stringify(…, null, 2)` で `Logger.log` し返す |
| `opsResetNotificationState()` | 公開 | 否 | `NOTIFY_STATE_V1` と `NOTIFY_BUCKET_V1|` で始まる全キーを削除する（**書込**）。抑制を解除して即時に送り直させたいときに使う。戻り値 `{deleted: n}` |

### 13.4 `97_Ops.gs` の改修

| 関数 | 改修 |
|---|---|
| （新設）`assessImportStatus_(scoped, now, watch)` | §9.2。`collectImportStatus_` の直後に置く。日時変換は同ファイルの `menuStatusDate_` を使う |
| （新設）`filterCollectedByCustomer_(collected, customerId)` | §9.3 |
| `collectImportStatus_(options)` | `files[]` に **`errorDropped`** を**追加**（数値。W列を `jsonCell_` で解析した配列の先頭要素が `{truncated: true}` ならその `droppedCount`（`Number(...) || 0`）、それ以外・解析失敗・空は 0）。既に `lastError` のために同じ `try/catch` で解析しているので読取は増えない。既存のキーは変えない（メニュー仕様 §7.1 の戻り値の形に 1 キー加わる） |
| `scheduledImportTick()` | 下記 |

`scheduledImportTick` の新しい形（既存の処理・ログ出力・`SCHEDULED_IMPORT_IDLE` の扱いは変えない。追加箇所を ★ で示す）：

```
function scheduledImportTick() {
  loadSettingsFromProperties();
  var now = new Date();
  var housekeeping = {released: 0, recovered: 0, fileIds: [], error: null};   // ★
  try {
    var released = opsReleaseStalledLeases();                                  // 戻り値を受ける ★
    var recovered = opsRecoverStuckFiles();                                     // 戻り値を受ける ★
    // ★ released[].released === true の fileId、recovered[].rewound === true の fileId を housekeeping.fileIds に集め、件数を数える
  } catch (error) {
    Logger.log('housekeeping failed: ' + String(error && error.message));      // 既存
    housekeeping.error = error;                                                 // ★
  }
  var customers = null;
  try { customers = getActiveCustomers(); } catch (ignored) { customers = null; }   // ★ 宛先用。失敗は §6.1
  notifyImportState_({now: new Date(), source: 'TICK', housekeeping: housekeeping, customers: customers});   // ★ A

  var report = runImport({});                                                   // 既存
  …（processed / pending / idleCount の既存処理）…
  var scheduleStopped = false;
  if (idleCount >= 2) { …既存…; scheduleStopped = true; }                       // ★ フラグだけ足す
  notifyRunReport_(report, {now: new Date(), scheduleStopped: scheduleStopped, customers: customers});   // ★ B
}
```

- `opsReleaseStalledLeases`・`opsRecoverStuckFiles` の戻り値の形は既存どおり（`[{leaseId, fileId, released, reason?}]`・`[{fileName, fileId, state, recovered?, stopped?, rewound?, error?, leaseNote?}]`）。変えない。
- `runImport` が例外を投げた場合（顧客マスター不正等）は既存どおり tick 全体が落ちる（Google 標準の障害通知 §3.3）。本仕様では包まない。理由：包むと「取込が例外で落ちている」事実を Google 標準通知からも隠してしまう。次の tick の先頭 A が `STATUS_CHECK_FAILED` または状態の異常で鳴る。

### 13.5 `96_Menu.gs` の改修

- `buildImportStatusView_`：§9.2 のとおり `assessImportStatus_` を呼ぶ形に置き換え、第 5 引数 `watch` を足す（省略可）。既存 5 行の本文は変えない。
- `menuShowImportStatus`：`readNotificationWatch_()` を `try/catch` で読んで `buildImportStatusView_` に渡す（失敗は `null`）。末尾の 2 行は §14。

### 13.6 `71_RunOrchestrator.gs` の改修

§5.4 の `outcome.errorCode`・`outcome.errorName` の追加だけ。

### 13.7 触らないもの

`00_Config.gs`（`SETTINGS` にキーを足さない。§3.6）、`01_DataAccessCore.gs`、`02_CustomerMaster.gs`、`05_SettingsValidator.gs`、`06_ErrorCatalog.gs`、`60_ProcessLog.gs`、`62_AuditLog.gs`、`appsscript.json`（スコープは既にある）。

---

## 14. 画面への表示（「取込の状況」に 2 行追加）

通知が**沈黙している理由**（解消したのか、壊れているのか）を画面で見分けられるようにする。`menuShowImportStatus`（`96_Menu.gs`）は、`view.text` の末尾に次の 2 行を加える。

```
■ メール通知: 最終送信 {yyyy-MM-dd HH:mm}（{件名の要約部分}）／ 監視トリガー: {この操作者が作成した notificationWatchdogTick の件数} 件
  直近の失敗: なし ／ {yyyy-MM-dd HH:mm} {reason}
```

- 行の生成は `notificationStatusLines_(globalState, now)`（`95_Notifications.gs`、純粋）。`globalState` は `readNotificationState_().global`。読取に失敗した場合は `['■ メール通知: (状態を取得できません)']`。
- `lastSent` が無ければ `最終送信 なし`。`quota` があれば 2 行目の末尾に `／ クォータ上限で {skipped} 件を送れていません` を足す。
- 監視トリガーの件数は `ScriptApp.getProjectTriggers()` を `NOTIFICATION_WATCHDOG_HANDLER_` で数える（既存の定期取込トリガー行と同じ書き方・同じ限界「他の人が作成したトリガーはここに出ません」）。
- Script Properties の読取は「書込」ではない（メニュー仕様 §2.4）。`readNotificationState_`・`readNotificationWatch_` は `getProperties` だけを呼ぶ。

メニュー仕様 §7.1 の本文例には載っていない行だが、追加であり既存の行は変えない。メニュー仕様には v1.1 として追記した（§7.1 の注記）。

---

## 15. テスト方針

### 15.1 現状と方針

- Node ハーネス（`test/gas-harness.js`・`test/gas-stubs.js`）で 764 件が通っている（2026-09-10 確認）。
- スタブに `MailApp` は**無い**。`Session` は `getActiveUser` だけで `getEffectiveUser` が無い。`ScriptApp` の時間主導トリガーは `everyMinutes` だけで `everyHours` が無い。
- 方針：**判断と整形は純粋関数として直接テストし、送信は記録型スタブで「何を・誰に・何通・どの順で」を検証する。** 時刻は `options.now` で注入する（`scheduledImportTick` は `new Date()` を渡す。テストで時刻を進める必要がある検証は `notifyRunReport_`／`notifyImportState_` を直接 `now` 付きで呼ぶ）。

### 15.2 スタブに追加するもの（`test/gas-stubs.js`）

| 追加 | 内容 |
|---|---|
| `MailApp.sendEmail(arg)` | `arg` がオブジェクト（`{to, subject, body, name, …}`）の形と `(to, subject, body)` の 3 引数の形を受ける。`control.setMailFailures([msg, …])` で与えた失敗が残っていれば先頭を取り出して `Error(msg)` を投げる。残りクォータが宛先数（`to` をカンマで分割した数）未満なら `Error('Service invoked too many times for one day: email.')` を投げる。成功時は `control.getSentMails()` に `{to: string[], subject, body, name}` を積み、クォータを宛先数だけ減らす |
| `MailApp.getRemainingDailyQuota()` | 現在の残りクォータ。`control.setMailQuota(n)` で設定。既定 100 |
| `Session.getEffectiveUser()` | `{getEmail: () => effectiveUserEmail}`。`control.setEffectiveUser(email)`。既定は `'tester@example.com'` |
| `ScriptApp.newTrigger(h).timeBased().everyHours(n)` | `everyMinutes` と同じ形でトリガーを作る（`hours: n` を持つ） |
| `control.getSentMails()` / `control.resetSentMails()` / `control.setMailQuota(n)` / `control.setMailFailures(list)` / `control.setEffectiveUser(email)` | 検証用。`control.reset()` で初期化（送信記録を空、クォータ 100、失敗なし、effective user 既定） |

**追加先は 2 箇所**：`createGasStubs()` の戻り値（`MailApp` を追加）と、`gas-harness.js` の `vm.createContext({...})` の列挙（`MailApp: stubs.MailApp`）。後者を忘れると `src` 側から `MailApp` が見えず `ReferenceError` になる（メニュー仕様 §10.2 の `HtmlService` と同じ罠）。

### 15.3 テストファイル：`test/phase7-notifications.test.js`

既存の書き方に合わせる（`module.exports = ({test, assert, gas}) => {...}`）。`setup()` は `test/phase6-scheduled-import.test.js` の `setup()` を雛形にする（顧客マスター・カード形式マスター・辞書を直接 `values` で置き、`provisionMasterSheets` → `dest1` → `SETTINGS` → `setActiveUser('admin@example.com')` → フォルダとファイル）。加えて `control.setEffectiveUser('admin@example.com')`、`control.setMailQuota(100)`。顧客 `C001` の R列は `'admin@example.com'`。

以下のケースを必須とする。番号は本仕様の受入条件（§16）から参照する。**理由をコメントに書く**流儀に合わせる。

**事故の再現（最重要）**

1. **最終状態が `DISCOVERED` でも鳴る（巻戻し経路）**：`fileA` を置き `scheduledImportTick` を 1 回実行して正常に取り込ませる（提出時ハッシュ H が処理ログ M列・恒久インデックス F列に入る）。次に事故の状態を作る：処理ログ Q列と恒久インデックス D列を直接 `DISCOVERED` に書き戻し（ハッシュは消さない）、`fileA` の中身を金額だけ変えたものに差し替える（`createFile` で同 ID を上書き。`lastUpdated` は 1 時間前）。`resetSentMails()`。**tick を 1 回**実行 → 恒久インデックス D列が `FAILED` になっている（`71_RunOrchestrator.gs` 529〜531行の遷移が動いたことの確認）。`getSentMails().length === 1`、件名が `/^\[クレカ自動処理\] 要対応 .*取込エラー 1件/`、本文に `IntegrityError` と `fileA` の `fileId` を含み、**`三井住友` `ローソン` `10800` `.csv` `immutable` を含まない**。ここから「状態が `DISCOVERED` に戻る経路」を模す：Q列・D列を `DISCOVERED` に書き戻し（ハッシュは残す）、tick を実行、の組を **5 回**繰り返す。各 tick の直後に D列が `FAILED` であることと、書き戻し後に `DISCOVERED` であることを両方 assert する（**tick は毎回失敗し、最終状態は毎回 `DISCOVERED`** ── 事故の観測と同じ）。6 tick 終了時点で `getSentMails().length === 3`（1 通目 = tick#1 末尾の `RUN_FILE_FAILED`、2 通目 = tick#2 先頭の `ERROR_RECORDS`（本文に「継続中」節があり `取込に失敗したファイルが 1 件` を含む）、3 通目 = tick#3 先頭の `REPEATED_FAILURE`（件名が `要対応`）。**4 通目以降は無い。** 各メールに元ファイル名・店名・金額が無い。
   1b. **`FAILED` 遷移の書込が失敗しても鳴る（`VALIDATING` 残留 → 次回後始末で巻戻し）**：1 と同じ準備の後、`gas.stubs.onValuesBatchUpdate` に「処理ログ Q列（17 列目）へ `FAILED` を書く要求が来たら `Error('injected: FAILED transition write failed')` を投げる」リスナーを付けて tick を 1 回実行 → `catch` 内の遷移が失敗して（`ignored2`）リースだけ解放され、D列は `VALIDATING` のまま、送信 1 通（`RUN_FILE_FAILED`。**遷移が失敗しても報告には `outcome: 'FAILED'` が積まれる**）。リスナーを外して tick をもう 1 回実行 → 後始末が `VALIDATING` を状態だけで拾い（`opsRecoverStuckFiles` 636〜637行。リースは既に無いので心拍は関係ない）、`rewindFileForReimport_` が**提出時ハッシュを消して** `DISCOVERED` に戻し（`97_Ops.gs` 65〜68行）、同じ tick の `runImport` が今度は**正常に取り込む**（ハッシュが消えているので INV-07 に当たらない）。この tick の送信は `C001` 宛て 1 通で、`INTERRUPTION_RECOVERED`（注意、本文に `fileA` の `fileId`）と `ERROR_RECORDS`（`errorCount` 1）を含み、`RUN_FILE_FAILED` は継続中節にだけ載る。最終状態は `COMPLETED` または `REVIEW_WAIT`。2 tick で合計 2 通。昇格（同一 `fileId` の 2 回目）はこの経路では起きない（巻戻しが原因を取り除くため）ので、昇格の担保はテスト 10b に置く。
2. **同じ事故を「状態層だけ」で見ても要対応になる**：`collected` を直接組む（`fileA` が `DISCOVERED`、`errorCount: 3`、`errorDropped: 0`、`lastActivityAt` は 5 分前）。`buckets = {C001: {episodes: {}, watch: {fileA: 2}}}` を渡して `stateFindingsFromCollected_(collected, {C001: …}, now, buckets)` を呼ぶと `REPEATED_FAILURE`（`severity: 'CRITICAL'`、`bucket: 'C001'`、`elements: ['fileA']`）を返し、同じ `fileA` を `ERROR_RECORDS` に**含めない**（covered）。`FAILED_FILES` は返さない（状態が `FAILED` でないため）── これが「`FAILED` 基準では捕まらない」ことの固定。戻り値の `watchByBucket.C001.fileA === 3`（更新後）。
   2b. **巻き戻した直後には鳴らない（誤警報の固定）**：同じ `collected`（`errorCount: 7`）で `watch` が空 → `REPEATED_FAILURE` は出ず `ERROR_RECORDS` が出て、`watchByBucket.C001.fileA === 7`。続けて `errorCount: 7` のまま → 出ない。`errorCount: 8` → 出る。`state` を `VALIDATING` にすると `watch` は据え置き（7 のまま）、`COMPLETED` にすると `watch` から消える。
   2c. **V列が頭打ちになっても検知が続く**：`errorCount: 199, errorDropped: 5`（`errorTotal` 204）を `watch: {fileA: 203}` と比べると鳴る。`errorCount: 199, errorDropped: 5` を `watch: {fileA: 204}` と比べると鳴らない（据え置き）。実物の経路も固定する：`setup()` の処理ログ W列に `[{truncated: true, droppedCount: 5}, {code: 'X', detail: 'a'}]`、V列に `1` を置いて `collectImportStatus_` を呼ぶと `files[0].errorDropped === 5`・`errorCount === 1`。W列が `'{broken'` なら `errorDropped === 0`（`lastError` は `null`）。マーカーの無い配列なら 0。
3. **報告層は最終状態に依存しない**：`runFindingsFromReport_({runId, stoppedBy: null, customers: [{customerId: 'C001', files: [{fileId: 'f1', outcome: 'FAILED', errorCode: null, errorName: 'IntegrityError'}], skipped: null}]}, false)` が `RUN_FILE_FAILED`（`elements: ['f1|IntegrityError']`、`count: 1`）を返す。`outcome: 'LEASE_CONFLICT'`・`'DEFERRED_TIME_BUDGET'`・`'WRITTEN'` の行は所見にならない。

**再送抑制**

4. **6 時間の窓**：同じ報告で `notifyRunReport_(report, {now: t0 + 10分 × k})` を k = 0…35 まで呼ぶ → 送信 1 通。k = 36（t0 + 6 時間）→ 2 通目。2 通目の本文に `37 回目` と `前回の通知` を含む。
5. **新しい要素は待たない**：k = 5 で報告のファイルが 1 → 2 件に増える → その時点で送る（本文に `対象: fileId f1, f2`）。k = 6 で 2 → 1 件に減る → 送らない。
6. **解消→再発**：所見あり（送信）→ 所見なしを 30 分続ける → 再発 → 送らない（同一エピソードの継続。`lastSentAt` から 6 時間未満）。所見なしを 13 時間続けて（GC 後）再発 → 送る（新エピソード）。
7. **WARNING は 24 時間**：`CUSTOMER_FIX` を 23 時間繰り返しても 1 通、24 時間で 2 通目。
8. **INFO は抑制しない**：`notifyRunReport_(report, {scheduleStopped: true})` を 2 回 → `SCHEDULE_STOPPED` が 2 通（件名 `情報 システム: 定期取込を自動停止`）。
9. **顧客ごとに 1 通、SYSTEM は別**：`C001`・`C002` の両方に `RUN_FILE_FAILED`、`report.stoppedBy` は null、`auditChain: 'BROKEN_NOTIFY_ONLY'` → 3 通（`C001` 宛て・`C002` 宛て・`SYSTEM` 宛て）。`C001` 宛ての本文に `C002` の顧客名・fileId が**含まれない**。
10. **指紋 10 個超**：ファイル 12 件が `FAILED` → `fingerprintHash`・`elementCount: 12` が入り `fingerprint` は空配列。13 件目が加わると再送（ハッシュが変わり要素数が増えた）。同じ 12 件なら再送しない。**12 件のうち 1 件が別のファイルに入れ替わった（要素数 12 のまま）**場合も再送しない（ハッシュは変わるが要素数が増えていない。§7.2 規則 2）。11 件に減っても再送しない。10 件以下では `fingerprint` に**要素キー**（各 12 桁の 16 進、要素そのものではない：`fileId` の文字列が状態 JSON に**現れない**ことを assert）が入り、`fingerprintHash` も入っている。
10b. **昇格**：`INTERRUPTION_RECOVERED` を `fileId: 'f1'` で 1 回 → 注意 1 通。同じ `'f1'` で 2 回目（10 分後）→ **要対応 1 通**（件名 `要対応`、本文 `同じファイルが繰り返し中断`）。3 回目 → 送らない（CRITICAL 窓）。別の `'f2'` だけの回 → 注意（新要素）。バケットは `C001`（`customerIdByFileId` で引ける場合）、引けない `'orphan'` は `SYSTEM` で本文に `fileId` を含まない。

**判断の共有**

11. `buildImportStatusView_` の既存 5 行の本文が改修前と同じ（`test/phase7-menu-readonly.test.js` のテスト 9・10・11 が変更なしで通ることで確認。本ファイルでは、6 種すべてが出る `collected` を渡して `assessImportStatus_(...).findings.map(f => f.line)` が本文の警告行と順序ごと一致し、`REPEATED_FAILURE` の行が `失敗したファイル` の直後・`処理が止まったまま` の直前にあることを assert）。
12. §9.5 テスト 12。
13. §9.5 テスト 13。
14. `assessImportStatus_` は `scoped.reviews` を参照しない（`reviews` を渡さなくても同じ結果）。

**宛先**

15. `C001` の R列 `'a@example.com, B@Example.com'`、effective user `'admin@example.com'` → 宛先は `['a@example.com', 'b@example.com', 'admin@example.com']`（小文字化・順序は R列→effective）。effective user が `''` なら R列だけ。両方空なら送らず `lastFailure.reason === 'NO_RECIPIENT'`。
16. `SYSTEM` バケットは全有効顧客の R列の和集合 ∪ effective user。無効顧客（C列 FALSE）の R列は含まない。
17. 顧客マスター読取失敗（`customers: null`）→ effective user だけに送り、本文に `顧客マスターを読めなかった` を含む。

**本文の制約**

18. `composeNotificationMail_` の出力に、所見の `elements` 以外の文字列（テストでは `merchantOriginal: 'ローソン'`・`amount: 10800`・`fileName: '三井住友.csv'`・`detail: 'secret detail'` を持つ余分なプロパティを所見に混ぜて渡す）が**含まれない**。`fileId` は 10 個までで 11 個目以降は `ほか N 件`。
19. `RUN_STOPPED` の `SETTINGS_INVALID` は `対象: 検査 #11 separateSpreadsheets` の形で、`detail` を含まない。

**送信失敗・クォータ**

20. `setMailFailures(['boom'])` → 送信は失敗、`lastFailure.reason === 'MAIL_SEND_FAILED'`、`lastSentAt` は更新されず、次の評価で再び送信され成功する。**`scheduledImportTick` は例外を投げない**（`assert.doesNotThrow`）。
21. `setMailQuota(0)` → 送らず `quota.skipped === 1`、`sentToday` は 0 のまま。`setMailQuota(100)` に戻して次の評価 → 送信され、本文に `クォータ上限で 1 件の通知を送れませんでした` を含み、`quota` が `null` に戻る。
22. `SETTINGS.MAX_EMAILS_PER_DAY = 2`、宛先 2 名の所見を 2 つ（別顧客）→ 1 通目（2 宛先）は送られ、2 通目は `sentToday + 2 > 2` で送られない。日付が変わる（`now` を翌日に）→ 送られる。
23. ロックが取れない（`gas.stubs.getScriptLock().setTryLockResults([false])`）→ 送らず、状態も書かれず、例外も出ない。次回は送る。
23b. **1 回の評価で 3 通まで**：5 顧客が同時に due（うち 2 つが CRITICAL、3 つが WARNING）→ 送信 3 通（CRITICAL 2 つ ＋ `firstSeenAt` の最も古い WARNING 1 つ）。送らなかった 2 バケットのキーも**書かれている**（エピソードあり、`lastSentAt: null`、`firstSeenAt` は今回の時刻）。次の評価（10 分後）→ 残り 2 通が送られ、その `firstSeenAt` は最初の評価の時刻のまま。`getScriptLock().releaseCount` が評価ごとに 1 増える（ロックは 1 回だけ取って中で全部済ませる）。
23c. **読取は 2 回、書込はバケット → 全体の順**：`notifyImportState_` 1 回で Script Properties の `getProperties` が **2 回**（ロック外・ロック内）、`notifyRunReport_` では **1 回**呼ばれる（スタブの `PropertiesService` 呼出回数を数える。無ければ `control` に `getPropertyCallCounts()` を足す）。書込は `setProperty` の呼出順を記録し、`NOTIFY_BUCKET_V1|` のキーがすべて `NOTIFY_STATE_V1` より前に来る。`watch` の**削除だけ**が起きたバケット（前回 `{fileA: 3}`、今回 `fileA` が `COMPLETED`）も書かれる。

**定期取込との結線**

24. `scheduledImportTick` 1 回の中で、`notifyImportState_` が `runImport` より**前**に、`notifyRunReport_` が**後**に呼ばれる（`Logger` の行順、または `onValuesBatchUpdate` で処理ログ書込より前に Script Properties が読まれることで検証。簡便には、状態層が鳴る条件（`FAILED` ファイルを事前に置く）と報告層が鳴る条件（失敗するファイル）を同時に作り、送信記録の順が `失敗ファイル` → `取込エラー` であることを見る）。
25. 後始末が例外（`opsRecoverStuckFiles` が失敗するよう、処理リースシートに `ACTIVE` 以外の行を置いて `activeLeases_` を落とす）→ `HOUSEKEEPING_FAILED` が `SYSTEM` へ 1 通。`runImport` は既存どおり実行される。
26. 停滞リースを解放・回復した tick → `INTERRUPTION_RECOVERED` が **その顧客** `C001` へ 1 通（`△ 前回の実行が途中で止まっていたため`、本文に `fileId` あり）。`SYSTEM` へは送らない。
27. 収集失敗（要確認シートを削除しておく）→ `STATUS_CHECK_FAILED` が effective user へ 1 通。tick は続行し `runImport` が呼ばれる。
28. `report.stoppedBy === 'NO_AUTHORIZED_CUSTOMER'`（effective/active user を Q/R 列に無いアドレスにする）→ `RUN_STOPPED` が `SYSTEM` へ。

**監視トリガー**

29. `opsStartNotificationWatchdog` を 2 回 → トリガーは 1 つ（`handler === 'notificationWatchdogTick'`、`hours === 1`）。`opsStopScheduledImport` はこれを消さず、`opsStopNotificationWatchdog` は `scheduledImportTick` を消さない。
30. 定期取込トリガーが無い状態で `DISCOVERED` 1 件・`lastActivityAt` 40 分前 → `notificationWatchdogTick` が `IMPORT_IDLE` を 1 通送る。続けて呼んでも送らない。

**画面**

31. `menuShowImportStatus` の本文末尾に `■ メール通知: 最終送信 …` と `直近の失敗: なし` の 2 行がある。送信失敗後は `直近の失敗: {時刻} MAIL_SEND_FAILED`。状態が無ければ `最終送信 なし`。
32. `NOTIFY_STATE_V1` が壊れた JSON（`'{broken'`）でも `notifyImportState_` は例外を出さず、初期状態から評価して送る。`NOTIFY_BUCKET_V1|C001` だけが壊れている場合、`C002` のバケットは正常に読まれ（抑制が効く）、`C001` だけ初期状態になる。

**状態の規律**

33. `garbageCollectNotificationState_`：`lastSeenAt` が 13 時間前の CRITICAL エピソードは消え、48 時間前の WARNING は消え、47 時間前の WARNING は残る。
33b. **観測中のエピソードは落とさない**：1 バケットに `lastSeenAt === now` のエピソードを 40 件（種類名は試験用に `K01`…`K40`。各 `fingerprint` 10 要素キー）置いて 8,500 バイトを超えさせる（40 × 400 ≒ 16 KB）→ GC 後も 40 件すべて残り、`fingerprint` が空配列に縮退し `fingerprintHash`・`elementCount` は残る。バイト数は `utf8Bytes(JSON.stringify(bucketState)).length` で 8,500 以下。続けて同じ所見で `evaluateEpisodes_` を呼んでも **due は 0**（縮退が再送を生まない）。加えて、種類名を日本語にした（1 文字 3 バイト）状態で `String.length` が 8,500 未満・`utf8Bytes` で 8,500 超になる入力を作り、縮退が起きることを固定する。
33c. **`lastSentAt` は最終手段でも残る**：段階 3 の後も超える状態（エピソード 60 件、うち 30 件が `lastSentAt` あり・30 件が `null`）→ 書かれた値は `lastSentAt` を持つ 30 件だけで、それぞれ `fingerprintHash`・`elementCount`・`severity`・`lastSentAt`・`firstSeenAt`・`lastSeenAt` を持ち、`watch` は無い。続けて同じ 60 所見で評価 → due は `lastSentAt` が無かった 30 件だけ（残した 30 件は再送されない）。
33d. **実寸で収まる**：`C001` に §5 の 13 種すべてのエピソード（各 `fingerprint` 10 要素キー・`fingerprintHash` 16 桁・時刻 3 本・`severity: 'CRITICAL'`・`seenCount: 9999`・`sentCount: 999`）と `watch` 40 件（`fileId` 44 桁・値 999999）を置いた状態を直列化し、`utf8Bytes(...).length` が **8,500 未満**で、GC が段階 1 以外を発動しない（`fingerprint` が空配列にならない）。`C002` のキーの大きさに影響しない。全体キーは `subject` 120 文字（日本語）・`detail` 200 文字で切られて 1,024 バイト未満。
34. `opsSendTestNotification` は状態を読まず・書かず、effective user へ 1 通送り `{sent: true, to, remainingQuota}` を返す。クォータ 0 なら `{sent: false, error}`。

**互換**

35. `importRunReportLines` の出力形式が変わらない（`outcome.errorCode`・`errorName` の追加は出力に現れない）。
36. `opsShowLeases`・`opsRecoverStuckFiles`・`opsReleaseStalledLeases` の戻り値の形が変わらない（`scheduledImportTick` が戻り値を受けるだけで、関数は変えない）。

### 15.4 走らせ方

`node test/run-tests.js`。既存 764 件が引き続き通り、上記が追加されて全件 PASS であること。

---

## 16. 受入条件

実装完了は次の**すべて**を満たすこと。各項目に検証方法を付けた。

**コード**
1. `src/95_Notifications.gs` が存在し、§13.3 の公開関数 6 個（`notificationWatchdogTick` `opsStartNotificationWatchdog` `opsStopNotificationWatchdog` `opsSendTestNotification` `opsShowNotificationState` `opsResetNotificationState`）がある。── `Grep '^function (notificationWatchdogTick|ops\w+Notification\w*)\(' src/95_Notifications.gs`
2. `src/` 内で `MailApp` を含むファイルが `95_Notifications.gs` **だけ**。── `Grep`
3. `95_Notifications.gs` に設計 §4.5 の関数名（`notifyProcessComplete` `notifyReviewRequired` `notifyError` `notifyInterruption` `notifyQuotaWait` `notifyLogCapacityWarning` `notifyRenameRetryExhausted` `notifyLeaseForceReleased` `notifyAuditChainBroken` `notifyAlerts`）を定義していない。── `Grep`
4. `95_Notifications.gs` のトップレベルに関数宣言と `var X = <リテラル>` 以外が無い。`96_Menu.gs` の関数を呼んでいない。── 目視・`Grep 'menu[A-Z]\w*_\?(' src/95_Notifications.gs` が 0 件。
5. `96_Menu.gs` の `buildImportStatusView_` が `assessImportStatus_` を呼び、警告行の判定式を自前で持っていない（`files.filter(function(file) { return file.state === 'FAILED'` 等が `96_Menu.gs` から消えている）。── `Grep "state === 'FAILED'" src/96_Menu.gs` が 0 件（`MENU_FILE_STATE_PRIORITY_` 等のリテラルは除く）。
6. `SETTINGS`（`00_Config.gs`）にキーが増えていない。`appsscript.json` が変わっていない。── `git diff`。
7. 本文・件名に元ファイル名・`error.message`・`error.detail` を入れる経路が無い。── (a) `Grep -n 'fileName\|originalFileName\|merchant\|amount' src/95_Notifications.gs` が **0 件**。(b) `Grep -n '\.message\|\.detail' src/95_Notifications.gs` の一致行が、行番号で見て `sendNotificationMail_` の本体（`lastFailure.detail` 用の `String(error.message).slice(0, 200)`）と `readNotificationState_`／`writeNotificationState_` の本体（全体キーの `detail` を 200 文字で切る箇所）の中にだけあり、`composeNotificationMail_`・`runFindingsFromReport_`・`housekeepingFindings_` の本体には**無い**。加えて §15.3 テスト 18・19。

**テスト**
8. `node test/run-tests.js` が全件 PASS で、`test/phase7-notifications.test.js` に §15.3 の番号 1・1b・2・2b・2c・3〜10・10b・11〜23・23b・23c・24〜33・33b・33c・33d・34〜36（**45 件**）に対応するケースが**名前の先頭を `notify {番号}:` として**すべて存在する（メニューテストの `menu N:` と同じ流儀）。── `Grep -c "^  test('notify " test/phase7-notifications.test.js` が **45 ちょうど**。番号を増やす場合は本節の数も直す。
9. **テスト 1（事故の再現）が PASS**。これが本仕様の第一条件である。
10. `test/phase7-menu-readonly.test.js` の既存 36 ケースが**変更なし**で通る（既存 5 行の本文が変わっていない）。同ファイルにメニュー仕様 v1.2 のテスト 37（`REPEATED_FAILURE` の行）が `menu 37:` として追加されている。

**実機**
11. `clasp run opsSendTestNotification`（またはエディタから実行）で `{sent: true}` が返り、トリガー作成者にメールが届く。**追加の承認画面が出たかどうかを §17 U-N1 に記録する。**
12. `opsStartNotificationWatchdog` 実行後、Apps Script のトリガー画面に `notificationWatchdogTick`（1 時間）が 1 つある。
13. 意図的に失敗させたファイル（提出時ハッシュを残したまま `DISCOVERED` へ戻す。テスト環境のみ）を置いて定期取込を動かし、**10 分以内に 1 通目（要対応）**、30 分以内に合計 3 通（注意 1・要対応 2）が届き、その後 6 時間以内に 4 通目が来ないこと。届いたメールに元ファイル名・店名・金額が無いこと。
14. 「取込の状況」画面の末尾に「■ メール通知」の 2 行が出て、13 の送信時刻と一致する。
15. `opsShowNotificationState` の出力の `buckets.TEST01.episodes` に `RUN_FILE_FAILED`・`ERROR_RECORDS`・`REPEATED_FAILURE` の 3 つがあり、`RUN_FILE_FAILED` の `seenCount` が tick の回数と一致し、`watch` に対象ファイルの `errorCount` が入っている。
16. 定期取込トリガーを止めた状態で `DISCOVERED` のファイルを置き、1 時間以内に `IMPORT_IDLE` のメールが届く。
17. 13〜16 の間、Apps Script の「実行数」画面で `scheduledImportTick` にエラーが増えていない（通知が取込を壊していない）。

---

## 17. 未確認事項と実機確認手順

| ID | 事項 | 影響 | 確認手順 | 結果（受入時に記入） |
|---|---|---|---|---|
| U-N1 | `script.send_mail` が既に承認済みか（追加の承認画面が出ないか） | 出る場合、承認するまで時間主導トリガーの中で `MailApp` が例外になる（取込は止まらない。§11） | 受入 11。エディタから `opsSendTestNotification` を実行し、承認画面の有無と `{sent: true}` を記録 | |
| U-N2 | 定期取込で取り込まれたファイルの処理ログ D列（`getActiveUser`）が、`Session.getEffectiveUser()`（U-N3）と同じアドレスか | 本仕様は D列を読まない（§3.2）ので設計に影響しない。§3.2 の「定期取込では D列 ＝ トリガー作成者」の実測記録 | 定期取込で取り込まれたファイルの処理ログ D列と、受入 11 の `to` を突き合わせる | |
| U-N3 | 時間主導トリガーの中で `Session.getEffectiveUser().getEmail()` がトリガー作成者を返すか | 空なら宛先が R列だけになる。R列も空なら `NO_RECIPIENT` | 受入 11 の `to` を確認 | |
| U-N4 | `MailApp.getRemainingDailyQuota()` の値と、消費者アカウントの上限が 100 か | §12 の判定。値が想定外でも `SETTINGS.MAX_EMAILS_PER_DAY` = 80 の判定は独立に効く | 受入 11 の `remainingQuota` を記録 | |
| U-N5 | `MailApp.sendEmail` の `name` オプションが消費者アカウントで送信者名に反映されるか | 表示だけの問題 | 受入 11 で届いたメールの差出人名 | |
| U-N6 | `ScriptApp` で作った時間主導トリガーの「障害通知」設定（即時／日次／なし）の既定値 | `runImport` が捕捉されない例外で落ちたとき、Google 標準の通知がいつ届くか（§3.3・§13.4） | Apps Script のトリガー画面で `scheduledImportTick` の「障害通知の設定」列を目視 | |
| U-N7 | 2026-09-09 の事故で、ファイルが `FAILED` ではなく `DISCOVERED` に戻った経路 | 本仕様の設計はこの経路に依存しない（§1.3）。記録として | 当時の処理ログ W列（エラー）と監査ログ、`git log -S rewindFileForReimport_` の履歴を突き合わせる | |
| U-N8 | 時間主導トリガーの中で `masterSpreadsheet_().getUrl()`・`getSheetId()` が取れるか（リンクの生成） | 取れなければ「■ リンク」を省略する経路（§8.3）になる | 受入 13 のメール本文のリンクが開けるか | |

---

## 付録 A. 状態キーの初期値

```
NOTIFY_STATE_V1:            {"version": 1, "day": null, "sentToday": 0, "lastSent": null, "lastFailure": null, "quota": null}
NOTIFY_BUCKET_V1|{bucket}:  {"version": 1, "episodes": {}, "watch": {}}      ← 空のバケットはキー自体を置かない
```

## 付録 B. 既存関数の参照表（本仕様が呼ぶもの）

| 関数 | ファイル | 使い方 |
|---|---|---|
| `collectImportStatus_(options)` | `97_Ops.gs` | 状態層の収集。4 読取 |
| `permanentIndexRowsForScan_` / `activeLeases_` / `openReviews` | 10 / 11 / 50 | `collectImportStatus_` の中でだけ使う（本仕様から直接は呼ばない） |
| `getActiveCustomers()` | `02_CustomerMaster.gs` | 宛先（R列 `admins`）と顧客名。1 読取 |
| `activeUserEmail_()` | `01_DataAccessCore.gs` | 使わない（§3.2）。`effectiveUserEmail_` を新設 |
| `withScriptLock_(fn)` | `01_DataAccessCore.gs` | §7.7。取れなければ `LEASE_CONFLICT` の例外 |
| `masterSpreadsheet_()` / `processLogSheet_()` / `reviewSheet_()` | 01 / 60 / 50 | リンク生成（§8.3） |
| `toIso8601(date)` / `sha256Hex(bytes)` / `utf8Bytes(s)` | `90_Utils.gs` ほか | 日時・指紋ハッシュ |
| `loadSettingsFromProperties()` | `05_SettingsValidator.gs` | トリガーハンドラの先頭で呼ぶ（既存の `ops*` と同じ） |
| `SETTINGS.MAX_EMAILS_PER_DAY` / `SETTINGS.LOCK_TIMEOUT_MS` | `00_Config.gs` | §12 / §7.7 |
| `VERSIONS.CODE` | `00_Config.gs` | 本文の「コード版」 |
| `SCHEDULED_IMPORT_HANDLER_` / `scheduledImportTick` | `97_Ops.gs` | §13.4 |
| `opsReleaseStalledLeases()` / `opsRecoverStuckFiles()` | `97_Ops.gs` | 戻り値を `INTERRUPTION_RECOVERED` の材料にする |
| `runImport(options)` | `71_RunOrchestrator.gs` | 報告の形：`{runId, stoppedBy, settingsProblems?, capacity?, customers: [{customerId, files: [{fileId, fileName, outcome, nextState, error?, errorCode?, errorName?, …}], skipped, error?, integrity?, auditChain?}]}` |

## 付録 C. 所見の種類と重大度（一覧）

| kind | 層 | 重大度 | バケット |
|---|---|---|---|
| `FAILED_FILES` | 状態 | CRITICAL | 顧客 |
| `REPEATED_FAILURE` | 状態 | CRITICAL | 顧客 |
| `STALLED` | 状態 | CRITICAL | 顧客 |
| `IMPORT_IDLE` | 状態 | CRITICAL | 顧客 |
| `CUSTOMER_FIX` | 状態 | WARNING | 顧客 |
| `ERROR_RECORDS` | 状態 | WARNING | 顧客 |
| `RUN_FILE_FAILED` | 実行結果 | CRITICAL | 顧客 |
| `RUN_CUSTOMER_SKIPPED` | 実行結果 | CRITICAL | 顧客 |
| `RUN_STOPPED` | 実行結果 | CRITICAL | SYSTEM |
| `HOUSEKEEPING_FAILED` | 実行結果 | CRITICAL | SYSTEM |
| `STATUS_CHECK_FAILED` | 実行結果 | CRITICAL | SYSTEM |
| `INTERRUPTION_RECOVERED` | 実行結果 | WARNING（同一 `fileId` の 2 回目から CRITICAL） | 顧客（引けなければ SYSTEM） |
| `AUDIT_CHAIN_BROKEN` | 実行結果 | WARNING | SYSTEM |
| `SCHEDULE_STOPPED` | 実行結果 | INFO | SYSTEM |

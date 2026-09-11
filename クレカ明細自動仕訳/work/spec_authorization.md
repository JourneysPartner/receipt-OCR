# 権限管理（認可モジュール `03_Authorization.gs`）仕様書

対象システム：クレジットカード明細 自動仕訳システム（Google Apps Script、リポジトリ `クレカ明細自動仕訳`）
作成日：2026-09-11
版：1.2
読者：本仕様だけを読んで実装する実装者（AI を含む）。この文書に書いていないことは実装者が決めてよいが、**書いてあることは変えない**。判断に迷う箇所は §2.4「残存リスク」と §15「未確認事項」を先に読む。

改訂履歴：
- 1.2（2026-09-11、再レビュー反映。文書のみ）：§14 に「`rg` は `-a` を付ける」注記（`97_Ops.gs` 97 行の NUL 文字で ripgrep が同ファイルを黙って除外する）を追加し、受入 1・6 の手順に `-a` を付けた。§6.1・§6.4 で `OPERATION_ROLES_` の基本値（`CANCEL_FILE`＝`EXCLUDE`＝`'REVIEWER'`、`RESIZE_INPUT`＝`'OWNER_ADMIN'`）を一文で確定し、`RESIZE_INPUT` は「格下げ」と表現を揃えた。§4.3・§7.3 第 2 項の語調を §2.4 の枠組みに揃えた。§1 に「（メニュー経由で）」を補った。
- 1.1（2026-09-11、レビュー反映）：§2.4 に信頼境界（コンテナ編集者＝スクリプト編集者。`authorize` は誤操作防止と検知の層であり防護ではない）を追加し、§1・§5.5 例 2・例 7・§7.3・受入 21・K-4 を整合させた。§6.1 に「`03` のトップレベル定数だけは役割リテラルを書く」例外を明記し、受入 5 とテスト I-40（定数と `ROLE` の一致）を追加。C-17 に `setEffectiveUser` の併用を本文へ明記。部品側 R列チェックのオーナー特例欠如を K-3・§7.5・G-38b・受入 20 に記録。§3 の「テスト 8 ファイル」を 5 ファイルに訂正。付録 A に画面の「担当」表示と認可の食い違いが意図的であることを注記。実装への影響：I-40・G-38b・3b の 3 テストが増えるだけで、`src/` の設計は変わらない。
- 1.0（2026-09-11）：初版。

---

## 0. この文書の読み方

- 本文中の「仕様」は `credit_card_import_normalization_system_spec_v2.0.md`、「仕様 Ver.2.6」は `review_history/round_5_after_claude.md`（`IMPLEMENTATION_BRIEF.md` §0 が「要求の正本」と定めるもの）、「設計」は `design_document.md`、「メニュー仕様」は `work/spec_menu_readonly.md`、「通知仕様」は `work/spec_notifications.md` を指す。§番号はそれぞれの文書の節番号。
- 「既存関数」は `src/` に現在ある関数。行番号は 2026-09-11 時点（コミット `d9f8eb7`）のもの。
- 各決定には理由を添えた。**理由の方が決定より重要である。** 実装中に決定と衝突する事実が見つかったら、理由に照らして判断し、変えた場合はその旨を本仕様書に追記すること。
- 断定できないことは「未確認」と書いた。未確認事項は §15 に集約し、実機での確認手順を付けた。
- 本仕様は**認可を緩める方向の判断を一切含まない**。迷ったら拒否する（フェイルクローズ）。ただし §10 の「既存運用を壊さない」経路は認可の対象外であり、そこへ認可を持ち込むことも本仕様の範囲外である。

---

## 1. 背景と目的

2026-09-10 に本システム初の UI（参照系カスタムメニュー。`src/96_Menu.gs`、メニュー仕様）が入った。しかし仕様 §21.1 が定める 11 項目のうち出せているのは参照系 5 項目（＋設計に無い診断 4 項目）だけで、操作系（取込開始・再検査・再開・要確認の確定・形式登録・freee取込済み化・取消し・復元）は出していない。理由はメニュー仕様 §2.3 に書かれているとおり、**サーバー側認可（設計 §4.4 `03_Authorization.gs`）が未実装**だからである。仕様 §20.1・§20.5・§21.1 は「画面制御だけを認可手段とせず、サーバー側認可を必須とする」と定めており、認可無しに操作系を出すと「画面に出た人は誰でも（メニュー経由で）取消し・確定ができる」状態になる（コンテナ編集者がエディタから直接できることは §2.4 のとおり別の話であり、メニューは誤操作を止める入口である）。

本仕様は `03_Authorization.gs` を作り、既存の参照系メニューをその上に載せ替え、**操作系メニューが次の段階で安全に呼び出せる認可の契約**を固定する。

認可は間違えると取り返しがつかない。緩すぎれば権限のない人が他顧客のデータを消せる。厳しすぎれば正当な担当者が締め出され、運用が止まる。どちらも**静かに**起きる。加えて、本仕様の認可が**何を防がないか**（コンテナ編集者はコードを直接実行できる。§2.4）を先に固定しておかないと、運用者が実態より強い保証を信じることになる。本システムは実機で本番稼働中（2026-09-10 時点で 33 ファイル・636 明細を取込済み。メニュー仕様 §1）であり、**現在動いている定期取込・通知・`clasp run` 運用を 1 経路も壊さない**ことが絶対条件である。そのため本仕様は、(1) 既にある仕組みを再発明しない、(2) 認可を通る経路と通らない経路を表で固定してテストで釘を打つ、(3) 「権限のない人が拒否される」と「権限のある人が通る」の両方を検証する、の 3 点を骨格にする。

---

## 2. 範囲と非範囲

### 2.1 作るもの

| # | 成果物 | 内容 |
|---|---|---|
| 1 | `src/03_Authorization.gs`（新規） | 設計 §4.4 の関数 `authorize` `getUserRole` `hasRole` `getAuthorizedCustomerIds` `authorizeOperation` `isCorpusAdmin` と、役割ラベル `roleLabel`。§6 |
| 2 | `src/00_Config.gs`（1 箇所追加） | 役割の列挙 `ROLE`。§6.1 |
| 3 | `src/96_Menu.gs`（改修） | `menuViewerScope_` を `authorize()` の上に載せ替える。見出し行と「このメニューについて」に役割を表示する。§11 |
| 4 | 拒否の監査記録 | 拒否を監査ログ（操作種別 `PERMISSION`）へ残す。§8.3 |
| 5 | `test/phase7-authorization.test.js`（新規） | §13 のケース。既存 814 件（2026-09-11 に `node test/run-tests.js` で確認）は変更なしで通り続ける（§13.4） |
| 6 | 操作系メニューの呼出し契約 | 次段階の操作系メニューが認可をどう呼ぶか（§7.6）と、操作コード・メニュー項目ごとの必要役割（付録 A・B） |

### 2.2 作らないもの

| 作らないもの | 理由 |
|---|---|
| **操作系メニュー**（仕様 §21.1 の取込開始・再検査・再開・要確認の確定・形式登録・freee取込済み化・取消し・復元、およびプレビュー） | §2.3 |
| `ops*` 関数への認可（§7.3） | 到達経路がスクリプトプロジェクトの編集者に閉じており、掛けても安全性が増えず、トリガー経路を壊す危険だけが増える |
| `runImport` step 1（`71_RunOrchestrator.gs` 126〜137 行）の判定変更（§7.4） | 定期取込の本番経路。オーナー特例を入れると取込対象が静かに広がる。現状維持とし、課題として記録する |
| 既存の内部チェック（`forceReleaseLease` の R列判定、`FILE_OPERATION_ROLES_`、`restoreRow` の `OWNER_ADMIN` 判定 等。§3）の置換え | 多層防御として残す。置き換えると既存テスト 814 件の前提が崩れる |
| 権限マスターシートの新設（仕様 §20.5 は「顧客マスターまたは権限マスター」と言う） | 顧客マスター Q列・R列が既に役割の供給源として実装され運用されている（§3）。新しいシートは `CONFIG.REQUIRED_SHEET_KEYS`・プロビジョニング・幅検査の管理対象を増やす |
| ウェブアプリ化・オーナー権限実行（仕様 Ver.2.6 §20.2 末尾、設計 §4.4.2 残存リスク） | 実行形態の変更であり後続フェーズ |
| 承認申請（`56_ApprovalRequest.gs`）への役割検証（申請者・承認者の役割） | 承認を起動する画面が無い。操作系メニュー（形式登録・新規取引先承認）の仕様で扱う。ただし付録 A・B に必要役割は書いた |
| `google.script.run` によるダイアログからのサーバー呼出し | メニュー仕様 §2.2 と同じ。認可の入口が増える |

### 2.3 判断：操作系メニューは出さず、認可だけ先に作る

理由：

1. **原因の切り分け。** 認可の導入と新しい書込経路の追加を 1 つの変更にすると、実機で何かが起きたとき「認可が間違っていた」のか「操作が間違っていた」のかが区別できない。認可は静かに壊れる種類のものなので、単独で実機に載せ、参照系メニュー（書込ゼロ）で「通るべき人が通り、通らない人が拒否され、拒否が監査ログに残る」ことを確かめてから、書込を伴う操作を載せる。
2. **参照系が既に認可の消費者として存在する。** メニュー仕様 §4.3 は「`03_Authorization.gs` 実装後は `menuViewerScope_` の手順 2〜3 を `authorize('REVIEWER', null)` 相当に置き換える想定」と書いている。この置換えだけで、認可の全経路（実行者取得→役割判定→顧客判定→拒否→監査→画面表示）が実機で動く。
3. **操作系は項目ごとに UI 設計を要する。** 選択ファイルの指定、要確認の解決操作の選択と入力（採用する取引先名、修正日付…）、取消しの選択肢（`REPROCESS`／`CANCELED`）など、項目ごとにダイアログの設計が要る。それは仕様 §21.1 の各項目を 1 つずつ扱う別仕様の仕事であり、認可仕様に混ぜると認可の記述が薄まる。
4. **見える成果はある。** 仕様 §21.1 は「メニューとダイアログは現在の実行者、役割、対象顧客を表示し」と定める。メニュー仕様 §6.3 は役割の表示を「認可未実装のため」見送った。本仕様で役割が表示される（§11）。

代わりに本仕様は、操作系メニューが**どう認可を呼ぶか**（§7.6）と**何を要求するか**（付録 A・B）を確定し、次段階の仕様が認可について新しい判断をしなくて済むようにする。

### 2.4 残存リスク ── 信頼境界（明示的に受容する。設計 §4.4.2 の書き方に倣う）

本仕様の `authorize` が**何を防ぎ、何を防がないか**を最初に固定する。ここを曖昧にすると、運用者が「C001 の確認担当者は C002 のデータを消せない」と信じ、実際にはそうでない配備を続けることになる。

事実（2026-09-11 に確認）：

- このスクリプトは**コンテナバインド**である（`.clasp.json`・メモリ `gas-environment.md`）。カスタムメニューは**コンテナ（スプレッドシート）の編集権限を持つ人にしか出ない**（メニュー仕様 §3.2：閲覧・コメント権限では `onOpen` が動かない）。
- コンテナの編集権限を持つ人は、スプレッドシートの「拡張機能 › Apps Script」からこのスクリプトのコードを**開き、編集し、任意の関数をエディタから実行できる**（バウンドスクリプトの標準の挙動）。
- したがって **メニューを押せる人の集合 ＝ コード（`authorize` を含む）を書き換えられ、エディタから `ops*`・`cancelTransactions`・`restoreRow` 等を直接実行できる人の集合** である。§7.3 が「コードを編集できる人に対して、コードの中の認可は防護にならない」と言う対象は、開発者だけでなく**メニュー利用者の全員**である。

帰結：本仕様の `authorize` は、**正規の入口（メニュー）から入った人が、担当外の顧客や役割外の操作へうっかり進むことを止め、試みを監査ログに残す層**である。**悪意のあるコンテナ編集者に対する防護ではない。** 現行の配備におけるセキュリティ境界は「誰をコンテナの編集者にするか」だけである。§5.5 の境界例と §13 のテストは、いずれも「メニュー経由の操作」についての保証であり、それ以上を主張しない。

| 項目 | 規定 |
|---|---|
| アプリケーション層 | `authorize` が入口で役割と顧客を検査し、拒否を監査ログへ残す（本仕様）。誤操作の防止と、試みの検知 |
| 配備層 | **顧客単位の分離を強制できない。** コンテナ編集者はコードを編集・直接実行できる。仕様 Ver.2.6 §20.2 が「Ver.1.0 の実行形態ではシート保護でも人手の直接編集とメニュー経由の操作を区別できない」と述べたのと同じ制約が、認可にも当てはまる |
| 受容の理由 | 実行形態の変更（オーナー権限で動くウェブアプリ、または Apps Script API 経由に書込を限定する形態）は、仕様 Ver.2.6 §20.2 末尾と設計 §4.4.2 残存リスクが**後続フェーズ**と定めており、本仕様の範囲外である。現在の利用者は開発者 1 名とパイロット顧客 1 社であり、境界は人数で担保できる |
| **運用手順（必須）** | **ウェブアプリ化（オーナー権限実行）まで、コンテナの編集者は「全顧客のデータを預けてよい人」に限る。** Q列・R列の登録は「その人に何を見せ・何をさせるか」の整理であって、「預けてよいか」の判断ではない。預けてよくない人にはコンテナの編集権限を与えない（閲覧権限ではメニューが出ないので、その人は本システムを使えない）。**次段階の操作系メニューもこの前提でしか出せない**（操作系メニューの仕様は本節を前提条件として引き継ぐこと） |
| 検知 | 監査ログ（`PERMISSION` の記録・連鎖ハッシュ。仕様 Ver.2.6 §20.2）、手動変更検出（仕様 §17.2）、整合性チェック（仕様 §17.4）。**防止ではなく検知**（仕様 Ver.2.6 §20.2「Ver.1.0 の受入条件は…検知し、担当者の判断を経ずに上書きしないこと」と同じ立場） |
| 記録 | 課題 K-4 として §15 に記録し、実行形態の変更を後続フェーズで検討する |

---

## 3. 既にあるもの（棚卸し）── 再発明しない

2026-09-11 に `src/` を読んで確定した。**本仕様はこれらを呼ぶ側であり、置き換えない。**

| 既存のもの | 所在 | 内容 | 本仕様での扱い |
|---|---|---|---|
| `activeUserEmail_()` | `01_DataAccessCore.gs` 50〜53 行 | `Session.getActiveUser().getEmail()`。取れなければ `''` | **実行者の取得元として使う**（§4.2）。`getEffectiveUser` へは倒さない |
| `effectiveUserEmail_()` | `95_Notifications.gs` 819〜824 行 | `Session.getEffectiveUser().getEmail()`。通知の宛先用 | 認可には**使わない**（§4.2） |
| `csvEmails_(value)` | `01_DataAccessCore.gs` 279〜281 行 | カンマ区切り→`trim`→**小文字化**→空を除去 | Q列・R列は既にこれで読まれている。実行者側も同じ正規化で比較する（§5.2） |
| 顧客マスター Q列 `reviewers`・R列 `admins` | `02_CustomerMaster.gs` 27 行（`customerFromRow_`）、設計 2.1.1 193〜194 行 | 顧客ごとの確認担当者・システム管理者のメール一覧 | **役割の唯一の供給源**（設計 §4.4.1） |
| `getActiveCustomers()` | `02_CustomerMaster.gs` 149〜157 行 | C列が真の顧客行を全件（1 回の読取）。1 行でも不正なら `MasterDataError` | 顧客一覧の取得に使う。オーナーの許可顧客はこれ |
| `getAuthorizedCustomers(userEmail)` | `02_CustomerMaster.gs` 166〜171 行 | 有効顧客のうち Q列または R列に含まれるもの（`getActiveCustomers().filter(...)`。呼ぶたびに読取 1 回） | 非オーナーの許可顧客の**述語の正本**。**オーナー特例は含まない**。`authorize` は読取を 1 回に抑えるため、自分が読んだ `getActiveCustomers()` の結果へ同じ述語（Q列または R列に含まれる）を適用する。同値であることをテスト A-3b で固定する（§13.3） |
| `getCustomerById(customerId)` | 同 159〜164 行 | 1 顧客。無ければ `MasterDataError` | 認可では使わない（顧客一覧から引く。読取を増やさない） |
| `validateCustomerAccess(customerId)` | 同 173〜190 行 | Drive・転記先への**アクセス権のプローブ**（`file.setName`・`setValue` の書込を伴う） | **認可ではない**（実行者の身元ではなく、実行者の Drive/Sheets 権限を確かめる）。本仕様は呼ばない |
| `CUSTOMER_CATEGORY` | `00_Config.gs` 160 行 | `CORPORATE`／`INDIVIDUAL`（顧客区分。前年利用日判定用） | **役割とは無関係**。混同しないためにここに書く |
| `menuViewerScope_()` | `96_Menu.gs` 331〜359 行 | 参照系の閲覧範囲。オーナー→全顧客、それ以外→Q∪R、空メール・顧客なしは `AuthorizationError` | **`authorize(ROLE.REVIEWER, null)` の上に載せ替える**（§11）。判定結果は同一に保つ |
| `AuthorizationError(detail)` | `06_ErrorCatalog.gs` 89〜91 行 | `CatalogError(null, detail)`。`message` は `'処理を実行できません: ' + detail`、`detail` に原文 | 拒否の例外型として使う。`reason` プロパティを足す（§6.7） |
| `classifyMenuError_` 行 1 | `96_Menu.gs` 666〜668 行 | `AuthorizationError` → `error.detail` を表示 | そのまま |
| `forceReleaseLease(leaseId, reason, actor)` | `11_FileStateManager.gs` 136〜163 行（156 行） | `customer.admins` に `actor` が無ければ `AuthorizationError('System administrator role is required')` | **残す**（多層防御。§7.5） |
| `registerDictionaryPattern(...)` | `34_MerchantDictionary.gs` 45〜65 行（53 行） | 同上の R列判定 | 残す |
| `FILE_OPERATION_ROLES_`／`assertOperationRole_` | `52_FileResolution.gs` 48〜63 行 | `SELECT_TARGET_SHEET` `REGISTER_FORMAT` `APPROVE_SCAN_TRUNCATION` `CONFIRM_DESTINATION_FIXED` は `input.role ∈ {SYSTEM_ADMIN, OWNER_ADMIN}` を要求（`StateTransitionError`） | 残す。**呼出側が渡す `role` の出所を本仕様が定める**（§7.6） |
| `restoreRow(fullTxId, actor, options)` | `54_IntegrityResolution.gs` 141〜146 行 | `options.role === 'OWNER_ADMIN'` を要求（`AuthorizationError`） | 残す |
| `CONFIRM_INTEGRITY_RESOLVED` | 同 259〜265 行 | `input.role ∈ {SYSTEM_ADMIN, OWNER_ADMIN}` を要求 | 残す |
| `updateReviewStatus` の AE列（31 列目） | `50_ReviewStore.gs` 197 行 | `context.role` を要確認シートに記録 | 残す。操作系メニューは `authorize` が返す `role` を渡す（§7.6） |
| `runImport` step 1 | `71_RunOrchestrator.gs` 126〜137 行 | `getAuthorizedCustomers(activeUserEmail_())` で対象顧客を絞る。空なら `NO_AUTHORIZED_CUSTOMER` | **変更しない**（§7.4）。これ自体がサーバー側の顧客単位認可である |
| `appendAudit(entry)`／`makeAuditRow_` | `62_AuditLog.gs` 17〜31・48〜50 行 | 15 列の監査行を連鎖ハッシュ付きで追記。`actor` 未指定なら `activeUserEmail_()` | **拒否の記録に使う**（§8.3）。操作種別 `PERMISSION` は設計 2.1.10 C列の許容値に既にある |
| 役割の文字列 `'REVIEWER'` `'SYSTEM_ADMIN'` `'OWNER_ADMIN'` | `52`・`54`・テスト 5 ファイル（`phase3-importflow`・`phase3-review`・`phase4-file-changed`・`phase4-file-resolution`・`phase4-integrity-resolution`。2026-09-11 に `role: '` で grep） | 既に実装とテストで使われている値 | **同じ値を `ROLE` 列挙にする**（§6.1）。値を変えない |
| `SETTINGS.CORPUS_ADMIN_EMAILS` | `00_Config.gs` 317 行 | カンマ区切り。未設定 `''` | `isCorpusAdmin` の供給源（§5.6） |
| `Spreadsheet.getOwner()` | `96_Menu.gs` 338〜340 行で使用中 | マスターのオーナー。共有ドライブでは `null` | オーナー管理者の判定に使う（§4.3） |

足りないもの（本仕様が足すもの）：役割の列挙と包含関係、顧客ごとの役割判定、オーナー特例を含む許可顧客の取得、操作コードごとの必要役割、拒否の監査記録、そして「これらを 1 つの入口で行う `authorize`」。

---

## 4. 実行環境の事実 ── 実行者の特定

### 4.1 `Session.getActiveUser()` と `getEffectiveUser()` の文脈別の値

Google の公開仕様（Apps Script リファレンス `Session`）と、本リポジトリで実測済みの事実を分けて書く。

| 実行文脈 | `getActiveUser().getEmail()` | `getEffectiveUser().getEmail()` | 本リポジトリでの実測 |
|---|---|---|---|
| カスタムメニューから実行（バウンドスクリプト。押した人の権限で動く） | 押した人。ただし「セキュリティポリシーが許さない場合は空文字」。マニフェストに `userinfo.email` スコープがある（`appsscript.json` 27 行）ので、承認した利用者については取れるはずである | 押した人と同一 | 開発者アカウント（＝マスターのオーナー）で取得できた（2026-09-10、「このメニューについて」の表示。メモリ `gas-environment.md` の運用アカウント）。**別の消費者アカウントは未確認 → U-A1** |
| 時間主導トリガー（`scheduledImportTick`・`notificationWatchdogTick`・`opsRunDeferred` が作るもの） | トリガー作成者（実測。`runImport` が `activeUserEmail_()` で顧客を認可しており、空なら毎回 `NO_AUTHORIZED_CUSTOMER` で止まるはずのところ、定期取込が実機で動いている。通知仕様 §3.2） | トリガー作成者（公開仕様） | 通知が実行者を特定して送れた（2026-09-10。通知仕様 U-N3） |
| `clasp run`（Apps Script API。`appsscript.json` の `executionApi.access: "MYSELF"` により**スクリプトの所有者しか呼べない**） | API を呼んだ人＝所有者 | 同 | 日常運用で `ops*` が `activeUserEmail_()` を `actor` として監査ログに書けている |
| エディタのプルダウン実行 | 実行した人（スクリプトプロジェクトの編集者） | 同 | 同上 |
| 単純トリガー `onOpen` | 空文字（承認無しで動く文脈） | - | 使わない（メニュー仕様 §3.2） |
| ウェブアプリ「自分として実行」（**現在は存在しない**） | 空文字になり得る | **開発者**（押した人ではない） | - |

### 4.2 決定：実行者は `activeUserEmail_()` だけで決め、`getEffectiveUser` へ倒さない

- 認可の実行者は **`activeUserEmail_()`（`Session.getActiveUser().getEmail()`）のみ**とする。`trim` して空なら「特定できない」（§9）。
- **`getEffectiveUser()` へのフォールバックを設けない。** 理由：本仕様が認可を掛ける文脈（メニュー実行）では両者は同一人物であり、フォールバックは何も足さない。一方、将来ウェブアプリ「自分として実行」を作ったとき、フォールバックがあると**押した人が誰でも開発者（＝オーナー管理者）として通ってしまう**。仕様 §20.5「匿名または空文字の実行者で処理しない」の趣旨は「分からなければ拒む」であり、「別の値で埋める」ではない。
- 実行者メールの比較は `csvEmails_` と同じ規則（`trim` → 小文字）で行う。表示には取得した原文を使う。

### 4.3 オーナー管理者の特定

設計 §4.4.1：「(1) マスタースプレッドシートのオーナー → オーナー管理者」。仕様 §20.1 の「オーナー管理者」に当たるのは、**マスタースプレッドシート（`masterSpreadsheet_()`）の `getOwner().getEmail()` と実行者が一致する人**である。コードから引ける（`96_Menu.gs` 337〜340 行が既に行っている）。

- `getOwner()` が `null`（共有ドライブ上のファイル）または `getEmail()` が空のときは、**誰もオーナー管理者にならない**（フェイルクローズ）。代替の設定キー（例：`OWNER_ADMIN_EMAILS`）は**設けない**。理由：§2.4 のとおりコンテナ編集者は既にコードを直接実行できるので、設定キーで「防護の穴」が増えるわけではない。それでも設けないのは、オーナー管理者の根拠を「マスタースプレッドシートの所有者」という **Google 側が管理し、Script Properties の編集や誤設定では変わらない事実 1 つ**に保つためである。設定値という第二の根拠を足すと、誤操作防止の層としての判定が「誰が最後に設定を触ったか」に依存し始める。共有ドライブへ移す運用になったときに改めて決める。
- 実機のマスターは開発者の消費者アカウント（Gmail）のマイドライブにあるはずで、オーナーは開発者である（メモリ `gas-environment.md`）。`getOwner().getEmail()` がオーナー自身の実行で取れるかはメニュー仕様 U-4 のまま未確認 → **U-A2**。取れなければ、オーナーは R列に自分を載せることでシステム管理者として動ける（現在の `TEST01` は `registerTestCustomer` の既定で登録者が Q・R 両方に入っている。`04_Provisioning.gs` 209〜210 行）。本仕様の範囲にはオーナー管理者専用の操作が無い（§7.1）ので、U-A2 が否でも運用は止まらない。

---

## 5. 役割

### 5.1 役割と包含関係

仕様 §20.1（Ver.2.6 でも同一）：

| 役割 | 列挙値（既存コードの文字列をそのまま列挙にする） | 包含 |
|---|---|---|
| 確認担当者 | `ROLE.REVIEWER` | - |
| システム管理者 | `ROLE.SYSTEM_ADMIN` | 確認担当者の権限を持つ |
| オーナー管理者 | `ROLE.OWNER_ADMIN` | システム管理者・確認担当者の権限を持つ |

順序は `REVIEWER < SYSTEM_ADMIN < OWNER_ADMIN`。`hasRole(role, requiredRole)` はこの順序で `role ≥ requiredRole` を返す。

### 5.2 役割の供給源と判定順序 ── 役割は**顧客ごと**に決まる

設計 §4.4.1 の判定順序をそのまま採る。**ただし Q列・R列は顧客ごとの値なので、役割は「実行者 × 顧客」で決まる。** 同じ人が C001 のシステム管理者で C002 の確認担当者であることは普通に起こる。

`getUserRole(userEmail, customerId)`（`customerId` は有効顧客の ID）：

| 順 | 条件 | 役割 |
|---|---|---|
| 1 | 実行者がマスタースプレッドシートのオーナー（§4.3） | `OWNER_ADMIN`（顧客を問わない） |
| 2 | 当該顧客の R列（`admins`）に実行者が含まれる | `SYSTEM_ADMIN` |
| 3 | 当該顧客の Q列（`reviewers`）に実行者が含まれる | `REVIEWER` |
| 4 | いずれでもない | `null`（役割なし＝拒否） |

- 判定対象は**有効な顧客（C列が真）だけ**。無効顧客の Q列・R列は読まない（`getActiveCustomers()` が既にそうしている）。理由：無効化した顧客の担当者が、無効化後もその顧客のデータを触れてはならない。
- Q列にも R列にも載っている人は R列が勝つ（順序 2 → 3）。
- メールの比較は `csvEmails_` の規則（`trim`・小文字）。

### 5.3 顧客横断（`customerId = null`）のときの役割

顧客を特定しない操作（参照系メニューの閲覧範囲、監査ログ連鎖の検証、設定の検査 など）では、`getUserRole(userEmail, null)` は**実行者が持つ役割の最大値**を返す：オーナーなら `OWNER_ADMIN`、どれか 1 顧客でも R列に居れば `SYSTEM_ADMIN`、どれか 1 顧客でも Q列に居れば `REVIEWER`、どこにも居なければ `null`。

理由：設計 §4.4.1 の (2)(3) は「顧客マスター R列に含まれる」と顧客を限定せずに書かれており、顧客横断の操作に対する自然な読みは「どこかの顧客でその役割を持つ」である。ただし**この集約役割で顧客固有の操作を通してはならない**（§5.5 境界例 3）。顧客固有の操作は必ず `customerId` を渡して顧客ごとの役割で判定する。

### 5.4 役割ごとにできること・できないこと

仕様 §20.1（Ver.2.6）と設計 §4.4「操作別必要役割」・§4.2 メニュー表・§4.26 解決操作表から、**本システムに現在コードとして存在する操作**を役割ごとに整理した。操作コード単位の正本は付録 A、メニュー項目単位は付録 B。

| 役割 | できること | できないこと（1 つ上の役割が要る） |
|---|---|---|
| 確認担当者 | 自分が担当する顧客について：状態の閲覧（参照系メニュー全項目）、取込のプレビュー・開始、要修正ファイルの再検査、取引単位の要確認の解決（既存取引先の採用・新規取引先の申請・取引先なし確定・日付金額修正・0円計上・前年利用日の判断・対象外）、ファイル単位の要確認のうち判断系（重複・ファイル変更・件数不一致・空ファイルの各操作、入力上限の顧客分割依頼）、**未 freee 取込取引の取消し確定**（仕様 Ver.2.6 §20.1・§27.1 で確定）、freee 取込済み登録、整合性の手動変更採用・差戻し・削除確定・freee 側修正完了の確認 | 形式登録・対象シート選択・転記先是正確認・整合性是正確認・打切り承認（システム管理者）、freee 取込済み取引の取消し確定（同）、リース強制解放（同）、転記行の復元（オーナー管理者）、担当外の顧客に対する一切の操作と閲覧 |
| システム管理者 | 確認担当者のすべて（当該顧客について）＋ 上記の「システム管理者」列の操作、処理の再開・引継ぎ、処理済みファイルの再走査、監査ログ連鎖の検証、対象年度の変更、辞書パターンの登録、カード形式の下書き・サンプル登録・ゲート実行 | 転記行の復元、スナップショット復元、承認（形式有効化・新規取引先・共通辞書・ロールバック）、入力上限設定の変更、担当外の顧客 |
| オーナー管理者 | すべて（全顧客） | -（ただし自己申請の承認記録は省略しない。仕様 §20.1） |

### 5.5 境界例

| # | 状況 | 結果 | 根拠 |
|---|---|---|---|
| 1 | C001 の確認担当者が C001 の要確認を対象外（`EXCLUDE`）にする | 許可 | 付録 A |
| 2 | C001 の確認担当者が C002 の要確認を対象外にする | **拒否**（`NO_CUSTOMER_ACCESS`） | 仕様 §20.1「許可されていない顧客の明細、候補、ログを閲覧・更新できない」。**メニュー経由の保証である**。同じ人がエディタから部品を直接呼ぶ経路は §2.4 の運用手順（コンテナ編集者の選定）でしか塞げない |
| 3 | C001 のシステム管理者（C002 では確認担当者）が C002 で形式登録（`REGISTER_FORMAT`）をする | **拒否**（`ROLE_INSUFFICIENT`。C002 での役割は確認担当者） | §5.2 役割は顧客ごと |
| 4 | 同じ人が顧客横断の「監査ログ連鎖の検証」（システム管理者）を実行する | 許可（集約役割は `SYSTEM_ADMIN`） | §5.3 |
| 5 | C001 のシステム管理者が C001 の転記行を復元（`RESTORE_ROW`）する | **拒否**（オーナー管理者のみ） | 設計 §4.26 表・`restoreRow` 既存チェック |
| 6 | オーナーが Q列・R列のどこにも載っていない | すべての顧客に対して `OWNER_ADMIN`。参照系メニューは全顧客を表示 | 設計 §4.4.1 (1)。現行 `menuViewerScope_` と同じ |
| 7 | Q列にも R列にも無い人（コンテナの編集権限は持つ。それが無ければメニュー自体が出ない） | **拒否**（`NO_CUSTOMER_ACCESS`）。拒否が監査ログに残る | 仕様 §20.1。**この拒否は誤操作防止と検知であって防護ではない**：この人はエディタからコードを直接実行できる（§2.4）。`PERMISSION` 行が続くなら、登録するか編集権限を外す（受入 21） |
| 8 | 実行者メールが空文字 | **拒否**（`ACTOR_UNKNOWN`）。監査ログには残さない（§8.3） | 仕様 §20.5 |
| 9 | 無効化された顧客（C列 = FALSE）の Q列に載っている人が、その顧客を対象に操作する | **拒否**（`CUSTOMER_NOT_ACTIVE`）。オーナーでも同じ | §5.2。無効顧客への操作はメニューから行わない |
| 10 | 確認担当者が freee 取込済みの取引を含むファイルを取り消す（`CANCEL_FILE` に `allowImported: true`） | **拒否**（システム管理者以上） | 仕様 §17.3・Ver.2.6 813 行 |
| 11 | 確認担当者が入力上限超過のファイルで「顧客に分割を依頼」（`RESIZE_INPUT` に `askCustomerToSplit: true`） | 許可 | 設計 §4.26 表 `RESIZE_INPUT` 行 |
| 12 | 確認担当者が入力上限の**設定変更**で再処理（`RESIZE_INPUT` に `askCustomerToSplit` なし） | **拒否**（オーナー管理者） | 同上 |
| 13 | R列に `Admin@Example.com`、実行者が `admin@example.com` | 一致（システム管理者） | `csvEmails_` が小文字化。実行者側も小文字化して比較 |
| 14 | 未知の操作コード（`'RESTORE_ROWS'` のような誤り） | **`TypeError`**（オーナーでも通さない） | 表に無いコードを既定の役割で通すと、コードを足したときに認可が抜ける |

### 5.6 コーパス管理者（設計 §4.4.2）

「役割ではなく、システム管理者以上に付与される追加の資格」。`isCorpusAdmin(userEmail)`：

- オーナー管理者なら真。
- そうでなければ、集約役割（§5.3）が `SYSTEM_ADMIN` 以上、**かつ** `csvEmails_(SETTINGS.CORPUS_ADMIN_EMAILS)` に実行者が含まれるとき真。
- それ以外は偽。`CORPUS_ADMIN_EMAILS` 未設定（`''`）なら、オーナー管理者だけが真（設計 §4.4.2「未設定は運用上の既定」）。

本仕様の範囲に呼出元は無い（コーパス系メニューは未実装）。設計 §4.4 のインターフェース表を満たすために置き、純粋関数としてテストする。`SETTINGS` は呼出側が `loadSettingsFromProperties()` で読み込んでおく（`collect*_` と同じ規律）。

### 5.7 `CUSTOMER_CATEGORY` との関係

無関係。`CUSTOMER_CATEGORY`（`CORPORATE`／`INDIVIDUAL`）は顧客の区分であり、前年利用日判定（仕様 §9.9）に使う。役割判定に一切使わない。名前が似ているので明記する。

---

## 6. 認可の関数インターフェース（`src/03_Authorization.gs`）

### 6.1 定数

**`00_Config.gs` に追加**（他の列挙と同じ流儀。仕様 §26「列挙は `00_Config.gs` の定数を正本とする」）：

```
const ROLE = createStringEnum_(['REVIEWER', 'SYSTEM_ADMIN', 'OWNER_ADMIN']);
```

値は既存コード（`52_FileResolution.gs` 49〜52 行、`54_IntegrityResolution.gs` 143・261 行）と既存テストが使う文字列と**同一**。`ROLE` という名のグローバルが他に無いことを受入 1 の grep で確かめる。

**`03_Authorization.gs` のトップレベル**に置く定数（**文字列と数値のリテラルだけで作る。他ファイルのグローバルをトップレベルで参照しない**。理由：`03_` は `06_ErrorCatalog.gs` より先に読み込まれる。`AuthorizationError` をトップレベルで触ると読込時に `ReferenceError` になり、メニューだけでなく定期取込まで止まる。メニュー仕様 §3.2・§9.2 と同じ規律）：

| 定数 | 内容 |
|---|---|
| `ROLE_RANK_` | `{REVIEWER: 1, SYSTEM_ADMIN: 2, OWNER_ADMIN: 3}` |
| `ROLE_LABELS_` | `{REVIEWER: '確認担当者', SYSTEM_ADMIN: 'システム管理者', OWNER_ADMIN: 'オーナー管理者'}`（`06_ErrorCatalog.gs` の `handler` 列と同じ語） |
| `AUTH_REASON_` | `{ACTOR_UNKNOWN: 'ACTOR_UNKNOWN', NO_CUSTOMER_ACCESS: 'NO_CUSTOMER_ACCESS', ROLE_INSUFFICIENT: 'ROLE_INSUFFICIENT', CUSTOMER_NOT_ACTIVE: 'CUSTOMER_NOT_ACTIVE'}` |
| `OPERATION_ROLES_` | 付録 A の「基本の必要役割」列を `{操作コード: 役割文字列}` で。役割が入力に依存する 3 コードも**基本値**をここに持つ（`CANCEL_FILE: 'REVIEWER'`、`EXCLUDE: 'REVIEWER'`、`RESIZE_INPUT: 'OWNER_ADMIN'`）。入力による格上げ・格下げは `requiredRoleForOperation_` が行う（§6.4） |

**役割の文字列リテラルについて。** `ROLE_RANK_`・`ROLE_LABELS_` のキーと `OPERATION_ROLES_` の値は、トップレベルの規律上 `ROLE.REVIEWER` と書けないので**文字列リテラル**（`'REVIEWER'` 等）で書く。これは受入 5（役割リテラルの禁止）の**唯一の例外**であり、綴りのずれを検出するためにテスト I-40 で「3 定数のキー／値の集合 ＝ `Object.keys(ROLE)`」を固定する。関数の中（`authorize` `hasRole` `requiredRoleForOperation_` 等の本体）では `ROLE.*` を使い、リテラルを書かない。

### 6.2 `authorize(requiredRole, customerId, options)` ── 認可の唯一の入口

| 項目 | 内容 |
|---|---|
| 引数 | `requiredRole`：`ROLE` の値（文字列）。`customerId`：顧客 ID の文字列、または `null`／`undefined`／`''`（顧客横断）。`options`：省略可。`{operation: string}`（監査ログと `Logger` に残す操作名。例 `'MENU:ファイル一覧'`、`'REGISTER_FORMAT'`。省略時 `''`） |
| 戻り値（**戻ったときは役割条件と顧客条件の両方を満たしている**。設計 §4.4） | `{userEmail, role, isOwner, ownerEmail, customerId, customers, customerIds, rolesByCustomerId}`。`userEmail`：取得した原文（小文字化しない。表示用）。`role`：判定した役割（`customerId` ありならその顧客での役割、無ければ集約役割）。`isOwner`：真偽。`ownerEmail`：手順 4 で読んだマスターのオーナー（小文字化済み。取れなければ `''`。「このメニューについて」の表示用。追加の読取は無い）。`customerId`：引数を正規化したもの（`null` または文字列）。`customers`：`customerId` ありなら当該 1 件の `Customer`（`customerFromRow_` の形）の配列、無ければ許可顧客すべて（オーナー：有効顧客の全件、それ以外：有効顧客のうち Q列または R列に含まれるもの。§3 `getAuthorizedCustomers` の述語と同じ）。`customerIds`：`customers` の ID 配列。`rolesByCustomerId`：`customers` の各 ID → その顧客での役割（手順 7 で計算済みの値。追加の読取は無い） |
| 手順 | (1) `requiredRole` が `ROLE` の値でなければ `TypeError`（監査しない。呼出側のバグ）。(2) `customerId` が文字列・`null`・`undefined` 以外なら `TypeError`。(3) 実行者を `resolveActor_()` で取る。空なら `ACTOR_UNKNOWN` で拒否（§9）。(4) マスターのオーナーを取り `isOwner` を決める（§4.3）。(5) `getActiveCustomers()` を**1 回だけ**呼ぶ（`MasterDataError` はそのまま投げる。§6.7）。**`getAuthorizedCustomers` は呼ばない**（同じシートをもう 1 回読むことになる。§6.8）。(6) `customerId` ありなら有効顧客の中から引く。無ければ `CUSTOMER_NOT_ACTIVE` で拒否（オーナーでも）。(7) 有効顧客の各行について `roleForCustomer_` で役割を出し、`rolesByCustomerId` と許可顧客（役割が `null` でない顧客）を得る。当該操作の役割は §5.2（`customerId` あり）／§5.3（無し）。`null` なら `NO_CUSTOMER_ACCESS` で拒否。(8) `hasRole(role, requiredRole)` が偽なら `ROLE_INSUFFICIENT` で拒否。(9) 顧客横断で許可顧客が 0 件なら `NO_CUSTOMER_ACCESS` で拒否（オーナーで有効顧客が 0 件のときも同じ。表示するものが無い。メニュー仕様 §4.1 手順 4 と同じ）。(10) 戻り値を組み立てて返す |
| 拒否 | `AuthorizationError` を投げる（§6.7）。投げる直前に §8.2 の `Logger` 行と §8.3 の監査行を残す（`ACTOR_UNKNOWN` は監査しない） |
| 副作用 | 許可時：**なし**（読取のみ）。拒否時：監査ログ 1 行（§8.3） |
| 呼ばないもの | `validateSettings`（INV-41：認可は設定の是非と無関係。設定が壊れているときこそ状況を見たい）、`validateCustomerAccess`（書込プローブを伴う。§3）、`loadSettingsFromProperties`（呼出側の責務）、`getCustomerById`（読取が増える。有効顧客一覧から引く） |

### 6.3 `getUserRole(userEmail, customerId)`／`hasRole(role, requiredRole)`／`getAuthorizedCustomerIds(userEmail)`

| 関数 | 引数 | 戻り値 | 内容 |
|---|---|---|---|
| `getUserRole(userEmail, customerId)` | メール、顧客 ID（省略可） | `ROLE` の値または `null` | §5.2（`customerId` あり）／§5.3（無し）。`userEmail` が空なら `null`。無効・存在しない `customerId` なら `null`。**例外を投げない**（`getActiveCustomers` の `MasterDataError` を除く）。監査しない（判定だけ。拒否は `authorize` が記録する） |
| `hasRole(role, requiredRole)` | 役割、必要役割 | 真偽 | `ROLE_RANK_[role] >= ROLE_RANK_[requiredRole]`。`role` が `null`／未知なら偽。**`requiredRole` が未知なら `TypeError`**（必要役割の綴り間違いを黙って「全員拒否」にすると、テストが「拒否されるべき人が拒否された」と誤って緑になる） |
| `getAuthorizedCustomerIds(userEmail)` | メール | 顧客 ID の配列 | オーナーなら全有効顧客、それ以外は有効顧客のうち Q列または R列に含まれるものの ID（`getAuthorizedCustomers(email)` と同じ結果。読取 1 回）。空メールなら `[]`。設計 §4.4「4.4.1 の権限マスターを唯一のデータ源とする」 |
| `roleLabel(role)` | 役割 | 日本語ラベル | `ROLE_LABELS_[role]`。`null`／未知は `'（役割なし）'`。メニューの表示に使う |

3 関数は `authorize` と同じ内部関数（§6.6）を共有し、判定規則を二重に書かない。

### 6.4 `authorizeOperation(operationCode, customerId, options)`

| 項目 | 内容 |
|---|---|
| 引数 | `operationCode`：4.26 の解決操作コード（付録 A）。`customerId`：**必須**（解決操作は必ず顧客に属する。`null`・`undefined`・`''` なら `TypeError`）。`options`：省略可。`{allowImported: boolean, askCustomerToSplit: boolean}`。解決操作の `input` から同名の値をそのまま渡す |
| 手順 | (1) `requiredRoleForOperation_(operationCode, options)` で必要役割を決める。未知のコードは `TypeError`（オーナーでも通さない。§5.5 境界例 14）。(2) `authorize(requiredRole, customerId, {operation: operationCode})` を呼び、その戻り値を返す |
| `requiredRoleForOperation_` | `OPERATION_ROLES_[code]` を基本とし、入力に応じて次の**2 方向の調整**を適用する。**基本値は付録 A の「基本の必要役割」列そのものであり、`OPERATION_ROLES_.CANCEL_FILE = 'REVIEWER'`、`OPERATION_ROLES_.EXCLUDE = 'REVIEWER'`、`OPERATION_ROLES_.RESIZE_INPUT = 'OWNER_ADMIN'` と書く。** (1) **格上げ**：`code ∈ {CANCEL_FILE, EXCLUDE}` かつ `options.allowImported === true` → `SYSTEM_ADMIN`（仕様 §17.3・Ver.2.6 813 行「freee取込済み取引の取消しを確定できるのはシステム管理者またはオーナー管理者」。コードは `cancelTransactions`／`excludeTransaction_` の `input.allowImported` で分岐している：`53_CancelRestoreManager.gs` 51 行、`51_ReviewResolution.gs` 261〜265 行）。(2) **格下げ**：`code === 'RESIZE_INPUT'` かつ `options.askCustomerToSplit === true` → `REVIEWER`（顧客へ分割を依頼するだけで上限設定は変えない。設計 §4.26 表：顧客依頼は確認担当者、上限設定の変更はオーナー管理者。コードは `52_FileResolution.gs` 95〜98 行で分岐）。`askCustomerToSplit` が無ければ基本値 `OWNER_ADMIN` のまま。基本値を厳しい側（`OWNER_ADMIN`）に置くのは、`options` を渡し忘れた呼出しが緩い側へ落ちないようにするためである |

戻り値の `role` と `userEmail` を、呼出側は解決関数の `input.role`・`input.actor` として渡す（§7.6）。

### 6.5 `isCorpusAdmin(userEmail)`

§5.6。真偽を返す。例外を投げない（`getActiveCustomers` の `MasterDataError` を除く）。

### 6.6 内部関数（非公開・末尾 `_`）

| 関数 | 内容 |
|---|---|
| `resolveActor_()` | `activeUserEmail_()` を `try/catch` で呼び、例外・非文字列・空白のみは `''`。戻り値 `{raw, normalized}`（原文と `trim`＋小文字） |
| `masterOwnerEmail_()` | `masterSpreadsheet_().getOwner()` を `try/catch` で呼び、`null`・例外・空なら `''`、あれば小文字化して返す |
| `roleForCustomer_(normalizedEmail, isOwner, customer)` | §5.2 の判定。`customer.admins`／`customer.reviewers`（既に小文字）に対する `indexOf` |
| `aggregateRole_(normalizedEmail, isOwner, customers)` | §5.3 |
| `denyAuthorization_(reason, context)` | `Logger` 行（§8.2）→ 監査行（§8.3。`ACTOR_UNKNOWN` は書かない）→ `AuthorizationError` を組み立てて**返す**（投げるのは呼出側）。監査の失敗を握りつぶす（§8.4） |
| `authorizationDetail_(reason, context)` | 付録 C の文言を組み立てる |
| `requiredRoleForOperation_(operationCode, options)` | §6.4 |

### 6.7 例外と `reason`

| 例外 | いつ | 追加プロパティ |
|---|---|---|
| `AuthorizationError(detail)` | 拒否（4 種の理由） | `error.reason`：`AUTH_REASON_` の値。`error.detail`：付録 C の文言（画面表示用。`classifyMenuError_` 行 1 がそのまま出す）。`error.context`：`{userEmail, requiredRole, actualRole, customerId, operation}`（テストとログ用。画面には出さない） |
| `TypeError` | 呼出側のバグ（未知の役割・未知の操作コード・型違い） | - |
| `MasterDataError`（`CUSTOMER_MASTER_INVALID`） | 有効顧客行のどれかが不正（`getActiveCustomers` の既存挙動） | そのまま伝播。**`AuthorizationError` に変換しない**（顧客マスターの不備は「権限が無い」ではない。メニュー仕様 §8 行 3 が正しい文言で表示する）。結果として処理は始まらないので安全側 |

`AuthorizationError` の `message` は `CatalogError` により `'処理を実行できません: ' + detail` になる（`06_ErrorCatalog.gs` 81〜82 行）。**表示に使うのは `detail`**（メニュー仕様 §4.1）。

### 6.8 読取回数（実測に基づく）

`authorize` 1 回あたり：

- Sheets API `batchGet`：**1 回**。内訳：`getActiveCustomers()` → `customerMasterRows_()` → `readSheetRows_()` → `sheetsReadRanges_()` 1 回（`02_CustomerMaster.gs` 145〜157 行、`01_DataAccessCore.gs` 122〜134・79〜106 行）。顧客数に依存しない（1 範囲 `A2:AP` を 1 回で読む）。`getAuthorizedCustomers` を重ねて呼ぶと 2 回になるので呼ばない（§6.2 手順 5）。現行 `menuViewerScope_` は `getActiveCustomers` または `getAuthorizedCustomers` のどちらか一方だけを呼ぶので現行も 1 回であり、載せ替えで増えない。
- `SpreadsheetApp.openById`：**2 回**（`masterOwnerEmail_` の `masterSpreadsheet_()` と、`customerMasterRows_` 内の `requireSheet_(masterSpreadsheet_(), …)`。`masterSpreadsheet_()` はキャッシュしない：`01_DataAccessCore.gs` 20〜31 行）。実機の往復 1 回はおよそ 0.5〜0.8 秒（メモリ `gas-round-trip-budget.md`）。現行 `menuViewerScope_` も同じ 2 回を払っているので、載せ替えで増えない。
- 拒否時に加えて `appendAudit`：`getLastRow` 1・`getValue` 1・`appendRow` 1（`62_AuditLog.gs` 33〜46 行）と `LockService` の取得。人が押した回数しか起きないので往復予算の対象にしない。

§13.3 のテスト E-29 で「`batchGet` がちょうど 1」を、有効顧客 2 件と 12 件の両方で固定する。

### 6.9 設計 §4.4 からの逸脱（記録）

| 逸脱 | 理由 |
|---|---|
| `getUserRole(userEmail)` に第 2 引数 `customerId` を足した | 役割の供給源（Q列・R列）が顧客ごとなので、顧客を指定しない役割は「集約」としてしか定義できない（§5.3） |
| `authorize` の戻り値に `isOwner` `ownerEmail` `customerId` `customers` `customerIds` `rolesByCustomerId` を足した | メニューが閲覧範囲（許可顧客一覧）・顧客ごとの役割・オーナーの表示を要る。別関数で読み直すと読取が顧客数だけ増え、オーナーの取得（`openById`）も重なる |
| `authorizeOperation` に `options` を足した | 同じ操作コードで入力により必要役割が変わるものが 3 つある（§6.4） |
| 依存先に `01_DataAccessCore`（`activeUserEmail_` `csvEmails_` `masterSpreadsheet_`）を含む | 設計 12 章の依存表は `02_CustomerMaster` と `62_AuditLog` だけを挙げるが、`01_DataAccessCore.gs` は設計のモジュール一覧に無い実装層の基盤であり、`02` 自身も依存している。循環は作らない（`01`・`02`・`62` はいずれも `03` を呼ばない） |
| 拒否の監査の操作種別を `PERMISSION` とした | 設計 §4.4 異常系は「監査ログへ拒否を記録する」とだけ言う。2.1.10 C列の許容値のうち意味が合うのは `PERMISSION`。新しい種別を設けない |

---

## 7. どこに認可を掛けるか

### 7.1 掛ける（本仕様）

| 入口 | 呼ぶもの | 必要役割 | 顧客 | 備考 |
|---|---|---|---|---|
| `menuShowImportStatus` `menuShowFileList` `menuOpenReview` `menuOpenLog` `menuShowLeases` `menuCheckSettings` `menuFindTaggedTransactions` `menuShowTagBackfillTargets`（`runMenuAction_` 経由） | `authorize(ROLE.REVIEWER, null, {operation: 'MENU:' + 項目名})` | 確認担当者 | 横断（許可顧客すべて） | 現行 `menuViewerScope_` と同じ判定。§11 |
| `menuShowAbout` | 同上（自前の `try/catch` の中で） | 同 | 同 | 拒否理由も表示する画面（メニュー仕様 §7.9） |

本仕様の範囲にオーナー管理者専用・システム管理者専用の入口は無い。したがって U-A1・U-A2 が否でも、参照系は R列・Q列の登録で動く。

### 7.2 掛けない（理由つき）

| 入口 | 実行者 | 掛けない理由 | 代わりの防護 |
|---|---|---|---|
| `onOpen`（単純トリガー） | - | 承認無しで動く文脈。`Session` も `openById` も使えない（メニュー仕様 §3.2） | メニューを組み立てるだけで何も読まない（メニューテスト 2） |
| `scheduledImportTick`・`notificationWatchdogTick`（時間主導トリガー） | トリガー作成者 | 人の対話ではない（仕様 §20.5 は「対話操作では」と限定する）。`runImport` step 1 が既にトリガー作成者の許可顧客で絞っている。ここに `authorize` を足すと、`getActiveUser` がトリガー文脈で空になる環境（未確認）で**定期取込が全停止する** | 呼出し木が `03` を通らないことを grep（受入 6）と実行時テスト（G-36）で固定 |
| `ops*`（`97_Ops.gs` に 35 個、`95_Notifications.gs` に 5 個。2026-09-11 に `^function ops[A-Z]` で数えた） | 開発者（`clasp run`＝スクリプト所有者。エディタ＝スクリプト編集者） | §7.3 | ops をメニューから呼ばない（受入 4・テスト F-34） |
| `runImport` `importRunReport` `importRunReportLines` `releaseGateReport` `runAllVectors` `registerTestCustomer` `installCardFormat` `provisionMasterSheets` `setMasterSpreadsheetId` | 同上 | 同上。`runImport` は §7.4 | 同上 |
| 解決・取消し・復元の内部関数（`resolveReview` `resolveFileReview` `resolveIntegrityReview` `cancelTransactions` `restoreRow` `forceReleaseLease` `setCustomerFiscalYear` …） | 呼出側が渡す `actor` | 入口ではなく部品。トリガー・ops・テスト・将来のメニューから呼ばれ、それぞれ実行者の取り方が違う。**認可は入口で 1 回**にし、部品は既存の `role` チェックを多層防御として残す（§7.5） | 既存チェック（§3）＋ §7.6 の呼出し契約 |

### 7.3 `ops*` に認可を掛けない判断と理由

**掛けない。** 理由：

1. **到達経路がコンテナ（＝スクリプト）の編集者に閉じている。** `ops*` を起動できるのは、(a) `clasp run`（`appsscript.json` の `executionApi.access: "MYSELF"` により**スクリプト所有者本人だけ**）、(b) エディタのプルダウン（スクリプトプロジェクトの編集者＝コンテナの編集者。§2.4）、(c) `opsRunDeferred` や `scheduledImportTick` が作る時間主導トリガー（作成者＝(a)(b) の人）の 3 つである。メニューからは 1 つも呼ばれておらず（`96_Menu.gs` に `ops` 関数の呼出しは無い。フッター文字列に名前が出るだけ）、`google.script.run` も無い。**コードを編集できる人に対して、コードの中の認可は防護にならない**（自分で外せる）── そしてこの集合は §2.4 のとおりメニュー利用者の全員である。`ops*` に認可を掛けないことで**新たに**生じる穴は無い：`ops*` を直接実行できる人は、`authorize` の有無にかかわらず部品を直接実行できる。
2. **掛けても安全性が増えない。** (a) の実行者は所有者（`MYSELF`）であり、`authorize` は必ず通る。(b) と (c)（トリガー作成者＝(a) または (b) の人）の実行者は §2.4 の枠組みではコンテナ編集者であり、コードごと外せる人に対して `authorize` は防護にならない。どの経路でも掛ける意味が無く、増えるのは読取 1 回と、トリガー文脈で `getActiveUser` が空になった場合に全 ops が止まる危険だけである。
3. **既存運用を壊す危険がある。** `scheduledImportTick` は `opsReleaseStalledLeases`・`opsRecoverStuckFiles` を毎回呼ぶ（`97_Ops.gs` 1643〜1644 行）。ここに認可が入り、何かの理由で拒否されると、リースの後始末が止まり、ファイルが永久に処理されない（INV-20 の根拠文が予言した状態）。
4. **抜け穴にならない条件を代わりに固定する。** `ops*` が「認可を通らない書込経路」であることは事実なので、それが**人の対話から到達できない**ことをテストで固定する：`96_Menu.gs`（および将来の `01_Menu.gs`）は `ops` 関数を呼ばない（受入 4・テスト F-34）、メニューの木に `ops` 名を登録しない（メニューテスト 1 が木を固定済み）、`google.script.run` を含まない（メニュー仕様受入 2）。操作系メニューは `ops*` ではなく部品（`resolveReview` 等）を `authorize` の後で呼ぶ（§7.6）。

`opsRetryUnknownFormats`（`97_Ops.gs` 344〜345 行）と `opsRetryDestinationFix`（366〜367 行）が `{role: 'SYSTEM_ADMIN'}` を**文字列で自己申告**している箇所は変更しない。実行者はオーナー（`SYSTEM_ADMIN` を包含）であり、申告は事実である。`clasp run` 運用の互換を優先する。

### 7.4 `runImport` step 1 を変えない判断と理由

`runImport`（`71_RunOrchestrator.gs` 126〜137 行）は `getAuthorizedCustomers(activeUserEmail_())` で対象顧客を絞る。**オーナー特例は無い**（Q列・R列に無い顧客はオーナーでも取り込まない）。設計 §4.4.1 とは食い違うが、**変えない**。理由：これは定期取込の本番経路であり、オーナー特例を入れると「トリガー作成者を Q/R に載せていない顧客」が次の tick から静かに取込対象になる。現在の運用（`TEST01` は登録者が Q・R 両方に入っている）では差が出ないが、差が出ないことは「変えてよい」理由にならない。

帰結として**参照系メニュー（オーナーは全顧客を見る）と定期取込（オーナーでも Q/R の顧客だけ）は範囲が一致しない**。これは現状も同じである。運用手順として「顧客を追加するときは、定期取込トリガーの作成者を R列に入れる」を受入 21 に含める。次段階の「選択ファイルを処理」メニューは `authorize(REVIEWER, customerId)` を通してから `runImport({customerIds:[…], fileIds:[…]})` を呼ぶことになり、オーナーが Q/R に無い顧客では `authorize` が通って `runImport` が `NO_AUTHORIZED_CUSTOMER` を返す不整合が起きる。**その仕様で `runImport` にオーナー特例を入れるか、`opts.customerIds` 指定時は step 1 を `authorize` 済みとみなすかを決める**（課題 K-1。§15）。本仕様では G-37 で現状を固定する。

### 7.5 内部関数の既存チェックは残す（多層防御）

§3 に挙げた `forceReleaseLease`（R列）、`registerDictionaryPattern`（R列）、`FILE_OPERATION_ROLES_`（`input.role`）、`restoreRow`（`OWNER_ADMIN`）、`CONFIRM_INTEGRITY_RESOLVED`（`input.role`）は**そのまま残す**。入口の `authorize` が万一素通りしても、部品が最後の砦になる。ただし部品の `input.role` は「呼出側が渡した値」を信じるので、**その値の出所を §7.6 で縛る**。付録 A の表と `FILE_OPERATION_ROLES_` の整合はテスト D-28 で固定する（入口が部品より緩くなることを禁じる）。

**部品側の R列チェック 2 つにはオーナー特例が無い**（`forceReleaseLease` 156 行、`registerDictionaryPattern` 53 行は `customer.admins` だけを見る）。オーナーが R列に載っていない顧客では、`authorize(ROLE.SYSTEM_ADMIN, customerId)` が通った後に部品が `AuthorizationError('System administrator role is required')` を投げる。§7.4 の K-1 と同型の「正当な人が締め出される」方向の食い違いであり、D-28 はこの 2 つを覆わない（`FILE_OPERATION_ROLES_` に無い）。本仕様では部品を変えず（受入 8）、課題 K-3 として §15 に記録し、現状をテスト G-38b で固定し、運用手順（受入 20）でオーナーを**全顧客の** R列に載せる。

### 7.6 操作系メニューの呼出し契約（次段階が従うもの）

操作系メニュー（設計 §4.2 の `menu*`）は次の手順で認可を呼ぶ。**本仕様で実装するものではないが、`authorize` の設計はこの手順を前提にしている。**

| 手順 | 内容 | 理由 |
|---|---|---|
| 1 | `runMenuAction_` の骨組みで `scope = authorize(ROLE.REVIEWER, null, {operation: 'MENU:' + 項目名})` を得て、一覧の表示と選択を `scope.customerIds` に絞る | 一覧に出す範囲は現行と同じ。ここでは書かない |
| 2 | 操作対象（要確認 ID・ファイル ID）を利用者が選ぶ | - |
| 3 | 対象の **`customerId` は対象レコードから取る**（要確認シート G列、恒久ファイルインデックス B列、処理ログ F列）。利用者の入力や画面の状態から取らない | 画面の状態は改竄できる。レコードの顧客 ID が唯一の根拠（INV-18「サーバー側関数の入口で」） |
| 4 | **書込の直前に** `auth = authorizeOperation(操作コード, customerId, {allowImported, askCustomerToSplit})`（解決操作）または `auth = authorize(付録 B の役割, customerId, {operation: 項目名})`（それ以外）を呼ぶ。手順 1 の `scope` を流用しない | 一覧を出してから確定するまでの間に Q/R が変わり得る。判定は書く瞬間の顧客マスターに対して行う。読取 1 回（§6.8）の価値はある |
| 5 | 部品を `{actor: auth.userEmail, role: auth.role, …}` で呼ぶ。**役割の文字列リテラル（`'SYSTEM_ADMIN'` 等）をメニューのコードに書かない**（受入 5） | 部品の `input.role` は `authorize` の戻り値だけが供給する。リテラルを書いた瞬間に自己申告になる |
| 6 | 顧客横断の操作（監査ログ連鎖の検証など）は `authorize(役割, null)` | §5.3 |
| 7 | 1 回のメニュー操作で複数顧客のレコードを扱うときは、**顧客ごとに** `authorize` を呼ぶ | 集約役割で顧客固有の操作を通さない（境界例 3） |

---

## 8. 拒否したときの挙動

### 8.1 画面

`runMenuAction_` の `catch` → `presentMenuError_` → `classifyMenuError_` 行 1（`AuthorizationError` → `error.detail`）。本文は「{項目名} を表示できませんでした。」＋ 付録 C の文言。**この経路は既存のまま**であり、メニューテスト 6・7 が文言を固定している。操作系メニューが加わったときは「{項目名} を実行できませんでした。」になるよう、`presentMenuError_` の先頭行の語は項目側が決められるようにしてよい（本仕様では変更不要）。

ダイアログに `reason` コードやスタックトレースは出さない。出すのは付録 C の文だけ。

### 8.2 `Logger`

拒否 1 件につき 1 行：

```
[auth] DENIED reason={reason} actor={userEmail} required={requiredRole} actual={actualRole|null} customer={customerId|-} op={operation|-}
```

`ACTOR_UNKNOWN` では `actor=` を空にする。許可時は書かない（毎クリックのログを増やさない）。

### 8.3 監査ログ（操作種別 `PERMISSION`）

`ACTOR_UNKNOWN` 以外の拒否を `appendAudit` で 1 行追記する（設計 §4.4 異常系「監査ログへ拒否を記録する」）。列の値（2.1.10）：

| 列 | 値 |
|---|---|
| C 操作種別 | `PERMISSION` |
| D 実行者 | 実行者メール（原文） |
| E 申請者・F 承認者 | 空 |
| G 対象種別 | `customerId` ありなら `CUSTOMER`、無ければ `SETTING`（2.1.10 G列の許容値 `TRANSACTION`/`DICT`/`PARTNER`/`FORMAT`/`SETTING`/`LOG`/`CUSTOMER`/`LEASE`/`CODE`/`AUDIT`/`SNAPSHOT`/`SAMPLE`/`REQUEST` のうち「権限設定に対する照合」として最も近いもの。許容値の外へ出ないための選択であり、検索・テストは C列と K列で行うので、この値に意味を乗せない） |
| H 対象ID | `customerId`、無ければ `SYSTEM` |
| I 顧客ID | `customerId`、無ければ空 |
| J 変更前値 | 空 |
| K 変更後値 | `{"decision":"DENIED","reason":理由コード,"requiredRole":必要役割,"actualRole":判定した役割または null,"operation":操作名}` |
| L 理由 | 理由コード（K列と重複するが、L列は文字列検索で引く列として使う） |
| M 適用日時 | 空 |

`ACTOR_UNKNOWN` を記録しない理由：D列（実行者）は必須のメールアドレスであり、実行者が分からない拒否は誰にも帰属できない。またこの事象はほぼ「承認前・単純トリガー・別環境」といった文脈の問題であり、記録より `Logger` で十分である。

記録の量：人がメニューを押した回数分しか増えない。定期取込・通知は `authorize` を通らない（§10）ので、無人で増えることは無い。

### 8.4 監査の書込に失敗したとき

`appendAudit` は `LockService` の取得（`withScriptLock_`。取れなければ `LEASE_CONFLICT`）と `appendRow` を行う。マスターに書けない人（コンテナ≠マスターで閲覧権限しか無い人。メニュー仕様 U-1）や、監査ログシートが無い環境では例外になる。**監査の失敗で拒否をうやむやにしない**：`denyAuthorization_` は `appendAudit` を `try/catch` で包み、失敗は `Logger.log('[auth] audit write failed: ' + …)` に残して、`AuthorizationError` を**必ず**返す。逆方向（監査は書けたが拒否を投げ損ねる）は構造上起きない（投げるのは `denyAuthorization_` の戻り値を受けた直後）。

---

## 9. 実行者を特定できない場合

- `resolveActor_()` が `''` を返したら、`authorize` は他の判定に進まず `ACTOR_UNKNOWN` で拒否する。**`getEffectiveUser` へ倒さない**（§4.2）。
- 文言はメニュー仕様 §4.2 の 1 文をそのまま使う（付録 C）。既存テスト 7 が固定している。
- 監査ログには書かない（§8.3）。`Logger` には書く。
- 参照であっても拒否する（現行 `menuViewerScope_` と同じ。見せる範囲を実行者で決める以上、実行者が分からなければ範囲が決まらない）。
- `getUserRole` `getAuthorizedCustomerIds` `isCorpusAdmin` は空メールに対して `null`／`[]`／`false` を返す（例外にしない。判定関数だから）。

---

## 10. 既存運用を壊さない保証

### 10.1 経路ごとの対照表

| 経路 | 入口 | 実行者の取り方 | 本仕様後に `authorize` を通るか | 変わること |
|---|---|---|---|---|
| 定期取込（10 分ごと） | `scheduledImportTick` → `opsReleaseStalledLeases` → `opsRecoverStuckFiles` → `notifyImportState_` → `runImport` → `notifyRunReport_` | `activeUserEmail_()`（`runImport` step 1・リースの actor）、`effectiveUserEmail_()`（通知の宛先） | **通らない** | **なし** |
| 通知の監視（1 時間ごと） | `notificationWatchdogTick` → `notifyImportState_` | `effectiveUserEmail_()` | 通らない | なし |
| 遅延実行 | `opsRunDeferred` → トリガー → 任意の `ops*` | 各 ops の `activeUserEmail_()` | 通らない | なし |
| `clasp run`／エディタ | `ops*`・`importRunReport`・`releaseGateReport`・`registerTestCustomer` 等 | 同 | 通らない | なし |
| 参照系メニュー | `menu*` | `activeUserEmail_()` | **通る**（`REVIEWER`, 横断） | 判定結果は同じ。拒否時に監査ログ 1 行が増える。見出しに役割が付く |
| `onOpen` | 単純トリガー | - | 通らない | なし |

### 10.2 判定結果が同じであることの根拠

現行 `menuViewerScope_`（`96_Menu.gs` 331〜359 行）の手順と `authorize(ROLE.REVIEWER, null)` の手順（§6.2）を突き合わせる：

| 現行 | 新 | 一致 |
|---|---|---|
| `email = activeUserEmail_()`。空なら拒否（文言 A） | `resolveActor_()`。空なら `ACTOR_UNKNOWN`（文言 A） | 同じ文言・同じ条件 |
| `isOwner = owner.getEmail().toLowerCase() === email.toLowerCase()`（`null` は偽） | `masterOwnerEmail_()` と正規化メールの比較 | 同じ |
| `customers = isOwner ? getActiveCustomers() : getAuthorizedCustomers(email)` | `getActiveCustomers()` を 1 回読み、オーナーなら全件、それ以外は `getAuthorizedCustomers` と同じ述語（Q列または R列に含まれる）で絞る | 同じ集合（テスト A-3b で同値を固定） |
| `customers` 空なら拒否（文言 B） | 横断で許可顧客 0 件なら `NO_CUSTOMER_ACCESS`（文言 B） | 同じ |
| - | 役割が `REVIEWER` 未満なら `ROLE_INSUFFICIENT` | **起きない**：許可顧客が 1 件以上ある人の集約役割は必ず `REVIEWER` 以上（Q または R に居るから）。オーナーは `OWNER_ADMIN` |

したがって参照系メニューで通る人・拒否される人の集合は変わらない。メニューテスト 4〜8・13・19〜26・29 が変更なしで通ることが証拠になる（§13.4）。

### 10.3 テストによる固定

- G-36：`authorize` を「呼ばれたら必ず投げる」関数に差し替えた状態で `scheduledImportTick`・`notificationWatchdogTick`・主要な `ops*`・`runImport` を実行し、いずれも差し替え前と同じ結果になり、監査ログに `PERMISSION` 行が増えないことを確かめる。**認可を通らない経路が誤って認可を通り始めたら、このテストが落ちる。**
- 受入 6：`authorize(`／`authorizeOperation(` の呼出しが `03_Authorization.gs` と `96_Menu.gs` 以外に無いことを grep で確かめる（テスト F-35 が自動化する）。
- G-37：`runImport` の step 1 が現状のまま（オーナー特例なし）であることを固定する（§7.4）。

### 10.4 読込時の安全

`03_Authorization.gs` のトップレベルは `var` のリテラル定数と関数宣言だけ（§6.1）。読込時に他ファイルのグローバルを触らないので、1 ファイル追加でプロジェクト全体が読込時に落ちる事故（メニュー仕様 §3.2）は構造的に起きない。`00_Config.gs` への `ROLE` 追加は `createStringEnum_` の 1 行で、既存の列挙と同じ形である。

---

## 11. `src/96_Menu.gs` の改修

「既存の参照ロジックを呼ぶ薄い層」という性格は変えない。触る箇所を限定する。

| 箇所 | 改修 | 理由 |
|---|---|---|
| ファイル先頭コメント | 「`03_Authorization.gs` 実装まで操作系を含めない」→「操作系は次段階で追加する。閲覧範囲は `03_Authorization.gs` の `authorize` で決める」 | 事実の更新 |
| `runMenuAction_(actionName, fn)` | `menuViewerScope_(actionName)` に項目名を渡す（監査の `operation` 用） | 拒否の記録に「何を押したか」を残す |
| `menuViewerScope_(actionName)` | 本体を `authorize(ROLE.REVIEWER, null, {operation: 'MENU:' + actionName})` の呼出しに置き換え、戻り値を現行の `scope` の形（`email` `isOwner` `customers` `customerIds` `customerNameById`）に写す。**`role`・`rolesByCustomerId`・`ownerEmail` を足す**。`masterSpreadsheet_().getOwner()` の呼出しは `96_Menu.gs` から無くす（`03` が担う。受入 4b）。関数コメントを「閲覧範囲の取得。操作系メニューは対象顧客ごとに §7.6 の手順で `authorize` を呼び直す」に改める | メニュー仕様 §4.3 が予告した置換え。`filterByScope_`（656〜662 行）と各 `build*_` は `scope` の形に依存しているので、形を保てば変更不要 |
| `menuHeaderLines_(scope, now)` | 1 行目を `'実行者: ' + scope.email + '（' + roleLabel(scope.role) + '）'` にする（オーナーは `（オーナー管理者）`）。**`scope.role` が無い `scope` でも例外にしない**（`roleLabel(undefined)` は `'（役割なし）'`） | 仕様 §21.1「役割を表示」。メニュー仕様 §6.3 の見送りを解除。`test/phase7-notifications.test.js` のテスト 12（407〜416 行）は `role` を持たない手製の `scope` を `buildImportStatusView_` に渡しており、これを壊さない |
| `menuShowAbout` | `menuViewerScope_('このメニューについて')` を呼ぶ（自前 `try/catch` はそのまま）。本文に次を加える：`役割: {集約役割ラベル}`、`顧客ごとの役割: 顧客一(C001)=システム管理者、顧客二(C002)=確認担当者`（`scope.rolesByCustomerId` を `scope.customers` の順に並べる。追加の読取は無い）、`マスターのオーナー: {scope.ownerEmail、空なら '(取得不能)'}`（`authorize` の戻り値 `ownerEmail`。現行 337〜339 行の `getOwner()` 呼出しは `menuViewerScope_` から消え、`03` に一本化される）。末尾の文を「このメニューは参照専用です。取込・確定・取消しなどの操作は次の段階で追加します。」にする | U-A1・U-A2 の確認に使う。オーナーのメールは共有設定から誰でも見えるので秘匿対象ではない |
| `classifyMenuError_` | 変更なし | 行 1 が `detail` を出す |
| 禁止事項（新規） | `96_Menu.gs` に役割の文字列リテラル（`'REVIEWER'` `'SYSTEM_ADMIN'` `'OWNER_ADMIN'`）を書かない（`ROLE.*` を使う）。`ops` 関数を呼ばない | §7.6 手順 5・§7.3 |

`filterByScope_` の「`customerId` が空の行はオーナーだけに見せる」規則は変えない（`scope.isOwner` を `authorize` の `isOwner` から取る）。

---

## 12. ファイル配置・読込規律・依存関係

- ファイル名は設計どおり `src/03_Authorization.gs`。読込順は `00 → 01 → 02 → 03 → 04 → 05 → 06 …`（`test/gas-harness.js` 35〜37 行の名前順。実 GAS も名前順とされる。メニュー仕様 U-5）。`03` は `06_ErrorCatalog.gs`（`AuthorizationError`）と `62_AuditLog.gs`（`appendAudit`）より**先**に読み込まれるが、いずれも関数の中でだけ参照するので問題ない（`02_CustomerMaster.gs` が `MasterDataError` を同じ形で使っている）。
- 依存先：`00_Config`（`ROLE`・`SETTINGS`）、`01_DataAccessCore`（`activeUserEmail_` `csvEmails_` `masterSpreadsheet_`）、`02_CustomerMaster`（`getActiveCustomers`）、`62_AuditLog`（`appendAudit`）、`06_ErrorCatalog`（`AuthorizationError`）。**`03` を呼ぶのは `96_Menu` だけ**（受入 6）。設計 12 章の順序 `02_CustomerMaster → 03_Authorization → …` と矛盾しない。
- `'use strict';` を先頭に置く。関数の署名は設計 §4.4 の名前をそのまま使う（メニュー仕様 §4.3・受入 5 が「衝突を避けるため使わない」としていた名前を、本仕様で正式に定義する）。

---

## 13. テスト方針

### 13.1 現状と方針

- Node ハーネス（`test/gas-harness.js`・`test/gas-stubs.js`）で **814 件**が通っている（2026-09-11 に `node test/run-tests.js` を実行して確認）。`test/phase7-menu-readonly.test.js` は 37 件。
- スタブには本仕様に必要なものが既にある：`control.setActiveUser(email)`（空文字可）、`control.setSpreadsheetOwner(id, email)`（`null` 可）、`MemorySpreadsheet.getOwner()`、`LockService`、`MemorySheet.getDataRange()`／`getRange().getValues()`（監査ログの行を読む）、`control.getApiCallCounts().batchGet`、`control.getLogLines()`。**スタブの追加は不要**。
- 方針：判定（`getUserRole` `hasRole` `requiredRoleForOperation_`）は純粋に近い関数として直接テストし、`authorize` は**効果**（例外の `reason`・`detail`、監査ログの行、`batchGet` 回数、書込の有無）で検証する。**すべての拒否ケースに対応する許可ケースを置く**（片方だけだと「全員拒否」でも「全員許可」でも緑になる）。

### 13.2 テストファイル：`test/phase7-authorization.test.js`

既存の書き方に合わせる（`module.exports = ({test, assert, gas}) => {...}`。`setup()` は `test/phase7-menu-readonly.test.js` 35〜62 行を雛形にする）。**理由をコメントに書く**流儀に合わせる。

`setup()` で作る状態：

| 顧客 | 有効 | Q列（`reviewers`） | R列（`admins`） |
|---|---|---|---|
| `C001`（顧客一） | 真 | `reviewer@example.com, both@example.com` | `admin@example.com` |
| `C002`（顧客二） | 真 | `other@example.com, admin@example.com` | `admin2@example.com` |
| `C003`（顧客三） | **偽**（登録後に顧客マスター C列を直接 `false` にする。`registerTestCustomer` は常に真で書く：`04_Provisioning.gs` 201 行） | `reviewer@example.com` | `admin@example.com` |

マスターのオーナー：`owner@example.com`（Q・R のどこにも無い）。`nobody@example.com` はどこにも無い。`admin@example.com` は **C001 ではシステム管理者、C002 では確認担当者**（境界例 3 の素材）。

監査ログの検証は、`監査ログ` シートの 2 行目以降を読んで C列 `PERMISSION` の行を数える補助関数 `permissionRows()` を用意する。

### 13.3 必須ケース

**A. 役割判定（`getUserRole`／`hasRole`／`getAuthorizedCustomerIds`）**

1. `owner@` は `C001`・`C002`・`null` のいずれでも `OWNER_ADMIN`。`getAuthorizedCustomerIds` は `['C001','C002']`（`C003` を含まない）。
2. `admin@` は `C001` で `SYSTEM_ADMIN`、`C002` で `REVIEWER`、`null` で `SYSTEM_ADMIN`（集約）。
3. `reviewer@` は `C001` で `REVIEWER`、`C002` で `null`、`null` で `REVIEWER`。`getAuthorizedCustomerIds` は `['C001']`。`both@`（Q列の 2 番目）も `C001` で `REVIEWER`（カンマ区切りの 2 件目以降が効くこと）。
   3b. `reviewer@`・`admin@`・`both@`・`nobody@` のそれぞれで、`getAuthorizedCustomerIds(email)` が既存 `getAuthorizedCustomers(email).map(c => c.customerId)` と一致する（`authorize` が述語を写しているので、既存関数との同値をここで固定する。§3）。
4. `nobody@` はすべて `null`、`getAuthorizedCustomerIds` は `[]`。空メールも同じ。
5. `' Admin@Example.com '` は `admin@` と同じ結果（`trim`・小文字）。
6. `C003`（無効）：`reviewer@` も `admin@` も `null`。
7. `hasRole` の 3×3 が期待どおり（`REVIEWER→REVIEWER` 真、`REVIEWER→SYSTEM_ADMIN` 偽、`SYSTEM_ADMIN→REVIEWER` 真、…）。`hasRole(null, REVIEWER)` 偽。`hasRole(REVIEWER, 'ADMIN')` は `TypeError`。
8. `setSpreadsheetOwner('master', null)` のとき `owner@` は `null`（オーナー不明はフェイルクローズ）。

**B. `authorize` の許可（監査行が増えないこと・`batchUpdate`／`rangeWrites` が増えないことも確かめる）**

9. `reviewer@`：`authorize(ROLE.REVIEWER, 'C001')` → `{userEmail:'reviewer@example.com', role:'REVIEWER', isOwner:false, customerId:'C001', customerIds:['C001']}`。`permissionRows()` は 0 件。
10. `admin@`：`authorize(ROLE.SYSTEM_ADMIN, 'C001')` → `role:'SYSTEM_ADMIN'`。
11. `owner@`：`authorize(ROLE.OWNER_ADMIN, 'C002')` → `role:'OWNER_ADMIN'`。`authorize(ROLE.REVIEWER, null)` → `customerIds` が `['C001','C002']`（順序は顧客マスターの行順）。
12. `admin@`：`authorize(ROLE.SYSTEM_ADMIN, null)` → 許可（集約役割）。

**C. `authorize` の拒否（各ケースで：`AuthorizationError` である・`reason` が期待値・`detail` が付録 C の文と一致・`permissionRows()` が 1 件増え、D列＝実行者、H列＝顧客 ID または `SYSTEM`、K列 JSON の `reason`・`requiredRole`・`actualRole`・`operation` が期待値・`Logger` に `[auth] DENIED` 行がある）**

13. `reviewer@`：`authorize(ROLE.REVIEWER, 'C002', {operation:'T'})` → `NO_CUSTOMER_ACCESS`。
14. `admin@`：`authorize(ROLE.SYSTEM_ADMIN, 'C002')` → `ROLE_INSUFFICIENT`（`actualRole:'REVIEWER'`）。**境界例 3 の固定。**
15. `reviewer@`：`authorize(ROLE.SYSTEM_ADMIN, 'C001')` → `ROLE_INSUFFICIENT`。
16. `nobody@`：`authorize(ROLE.REVIEWER, null)` → `NO_CUSTOMER_ACCESS`、`detail` がメニュー仕様 §4.2 の「閲覧を許可された顧客がありません。実行者: nobody@example.com。…」と**完全一致**。
17. 空メール：`setActiveUser('')` と**同時に `setEffectiveUser('owner@example.com')`** を設定した状態で `authorize(ROLE.REVIEWER, null)` → `ACTOR_UNKNOWN`、`detail` が「実行者のメールアドレスを取得できないため表示できません（仕様 §20.5）。…」と完全一致。**監査行は増えない。** `Logger` に `[auth] DENIED reason=ACTOR_UNKNOWN` がある。`setEffectiveUser` を併用するのは、実装が `getEffectiveUser` へ倒すと（有効ユーザーはオーナーなので）通ってしまい、このテストがそれを捕まえるため（§4.2・§13.5）。`authorize(ROLE.REVIEWER, 'C001')` でも同じ。
18. `reviewer@`：`authorize(ROLE.REVIEWER, 'C003')` → `CUSTOMER_NOT_ACTIVE`。`owner@` でも同じ。
19. `owner@`：`authorize(ROLE.REVIEWER, 'NOPE')` → `CUSTOMER_NOT_ACTIVE`。
20. 監査ログシートを削除した状態で `nobody@` が `authorize(ROLE.REVIEWER, null)` → それでも `AuthorizationError`（`NO_CUSTOMER_ACCESS`）が投げられ、`Logger` に `[auth] audit write failed` がある（§8.4）。
21. `authorize('ADMIN', 'C001')` → `TypeError`、監査行は増えない。`authorize(ROLE.REVIEWER, {customerId:'C001'})` → `TypeError`。
21b. 拒否を 3 回続けた後で `verifyChain('FULL').ok === true`（`PERMISSION` 行が連鎖を壊さない）。

**D. `authorizeOperation`**

22. 付録 A の**全コード**について、`reviewer@`・`admin@`・`owner@` が `C001` で呼んだときの許可／拒否が付録 A どおり（表をテスト内に写し、`Object.keys` で全件を回す。コードが増えて表を更新し忘れると D-27 で落ちる）。
23. `CANCEL_FILE`／`EXCLUDE`：`reviewer@` は `{allowImported:true}` で拒否（`ROLE_INSUFFICIENT`）、`{}` で許可。`admin@` は両方許可。
24. `RESIZE_INPUT`：`reviewer@` は `{askCustomerToSplit:true}` で許可、`{}` で拒否。`admin@` も `{}` で拒否。`owner@` は許可。
25. `RESTORE_ROW`：`admin@` 拒否、`owner@` 許可。
26. 未知コード `'RESTORE_ROWS'`：`owner@` でも `TypeError`、監査行は増えない。`customerId` が `null` → `TypeError`。
27. 付録 A のコード集合 ＝ `TX_REVIEW_OPERATIONS_`（`51`）・`FILE_REVIEW_OPERATIONS_`（`52`）・`INTEGRITY_OPERATIONS_`（`54`）の値の和集合（過不足なし）。`gas.evaluate` で 3 つの定数を読んで比較する。
28. `FILE_OPERATION_ROLES_` の各コードについて、`requiredRoleForOperation_(code, {})` が `SYSTEM_ADMIN` 以上（入口が部品より緩くない）。`restoreRow` の要求（`OWNER_ADMIN`）と `RESTORE_ROW` の表の値が一致。

**E. 読取回数**

29. `resetApiCallCounts()` → `authorize(ROLE.REVIEWER, null)` → `batchGet === 1`。`reviewer@`（非オーナー。述語で絞る経路）と `owner@`（全件の経路）の両方で 1。有効顧客を 12 件に増やしても 1（`test/phase7-menu-readonly.test.js` テスト 12 と同じ流儀）。`authorize(ROLE.REVIEWER, 'C001')` も 1。

**F. メニュー統合**

30. `menuShowFileList` の見出し行：`reviewer@` → `実行者: reviewer@example.com（確認担当者）`、`admin@` → `（システム管理者）`、`owner@` → `（オーナー管理者）`（`modal` の HTML で確認）。
31. 既存メニューテスト 4〜8 が**変更なし**で通る（同じファイルを走らせるだけ。ここでは「テスト 6 の拒否で `permissionRows()` が 1 件増え、D列が `nobody@example.com`、K列の `operation` が `MENU:ファイル一覧`」を追加で確かめる）。
32. `reviewer@` が `menuShowFileList` を押しても `permissionRows()` は増えない（許可は記録しない）。
33. `menuShowAbout`（`admin@`）の `alert` 本文に `役割: システム管理者` と `顧客一(C001)=システム管理者、顧客二(C002)=確認担当者` と `マスターのオーナー: owner@example.com` がある。`resetApiCallCounts()` してから押したとき `batchGet` が現行（`menuShowAbout` は `menuViewerScope_` の 1 回だけ読む）より増えていない。
34. **静的検査**：`fs` で `src/96_Menu.gs` を読み、(a) `'REVIEWER'` `'SYSTEM_ADMIN'` `'OWNER_ADMIN'` の文字列リテラルが無い、(b) `src/` の全 `ops[A-Z]\w*` 関数名について `名前 + '('` が無い（`97_Ops.gs`・`95_Notifications.gs` から `^function (ops[A-Z]\w*)\(` で名前を集める）。
35. **静的検査**：`src/*.gs` を読み、`authorize(`／`authorizeOperation(` を含むファイルが `03_Authorization.gs` と `96_Menu.gs` だけ（コメント行は除いてよい）。

**G. 既存運用の不変**

36. `gas.evaluate("var __savedAuthorize = authorize; authorize = function() { throw new Error('authorize must not run here'); };")` の状態で、`test/phase6-scheduled-import.test.js` の `setup({withFile:true})` 相当を作って `scheduledImportTick` を 1 回実行 → 例外なく終わり、`fileA` が取り込まれ（恒久インデックス D列が `DISCOVERED` 以外）、`permissionRows()` は 0 件。同じ状態で `notificationWatchdogTick`・`opsShowFileStates`・`opsCountFileStates`・`opsRetryFailedFiles`・`opsReleaseStalledLeases`・`opsShowLeases`・`runImport({})` を呼んで例外が出ない。**最後に必ず `gas.evaluate("authorize = __savedAuthorize;")` で戻す**（`try/finally`）。
37. `owner@`（Q/R に無い）で `runImport({})` → `stoppedBy === 'NO_AUTHORIZED_CUSTOMER'`（§7.4 の現状固定。コメントに「意図的。課題 K-1」と書く）。`stranger@` も同じ（既存 `phase6-orchestrator` と同値）。
38. `forceReleaseLease` を `reviewer@` の actor で呼ぶと従来どおり `AuthorizationError('System administrator role is required')`（既存チェックが残っていることの固定。既存テストがあればそれで足りる）。
   38b. **K-3 の現状固定**：`C002`（R列は `admin2@` のみ）に心拍が `LEASE_FORCE_RELEASE_MIN_SECONDS` を超えて途絶えた `WRITE_ONLY` リースを置き、`owner@`（R列に無い）で `authorize(ROLE.SYSTEM_ADMIN, 'C002')` は**通る**が、続けて `forceReleaseLease(leaseId, 'TEST', 'owner@example.com')` は `AuthorizationError` になる。同様に `registerDictionaryPattern('C002', 'パターン', '取引先', 'prefix', 'owner@example.com')` も `AuthorizationError`。コメントに「意図的な現状固定。課題 K-3。部品にオーナー特例を入れたらこのテストを反転させる」と書く。

**H. `isCorpusAdmin`**

39. `owner@` 真。`SETTINGS.CORPUS_ADMIN_EMAILS = 'admin@example.com'` で `admin@` 真、`reviewer@` 偽（役割不足）、`admin2@`（載っていない）偽。未設定 `''` なら `admin@` 偽・`owner@` 真。

**I. 定数の整合（§6.1 の文字列リテラルの例外を綴りのずれから守る）**

40. `gas.evaluate` で `Object.keys(ROLE_RANK_)`・`Object.keys(ROLE_LABELS_)`・`OPERATION_ROLES_` の値の集合（重複除去）を取り、いずれもソート後に `Object.keys(ROLE)` と `deepEqual`。`ROLE_RANK_` の値が `1 < 2 < 3` の順で `REVIEWER < SYSTEM_ADMIN < OWNER_ADMIN`。`roleLabel` が `ROLE` の各値に対して空でない文字列を返し、`roleLabel(null)`・`roleLabel('X')` が `'（役割なし）'`。

### 13.4 既存テストへの影響

- `test/phase7-menu-readonly.test.js`：**変更しない**。テスト 6・7 の文言は付録 C と同一。見出し行を検証するテストは無い。テスト 30（`opsShowLeases` 等の互換）も無関係。
- 万一、見出し行の `（オーナー）` を前提にした検証が見つかった場合は `（オーナー管理者）` へ改める（1 箇所の想定。本仕様書に追記すること）。
- `test/phase7-notifications.test.js`：**変更しない**。`96_Menu.gs` を呼ぶ箇所は 2 つ（2026-09-11 に確認）。テスト 12（407〜416 行）は `role` の無い手製 `scope` で `buildImportStatusView_` を直接呼ぶ ── 見出し行は `（役割なし）` になるが検証対象は警告行だけなので通る（§11 の「例外にしない」規則が前提）。テスト 31（691〜706 行）は `menuShowImportStatus` を `admin@example.com` で押す ── `setupImport` の顧客マスターは R列に `admin@example.com` を持ち、マスターのオーナーは未設定（`null`）なので、`authorize(ROLE.REVIEWER, null)` は R列経由で `SYSTEM_ADMIN` として通る。現行 `menuViewerScope_` と同じ結果である。
- それ以外の 728 件（814 − 37 − 49。通知のテストは 49 件）：`src/` の変更は `00_Config.gs`（列挙 1 行追加）と `96_Menu.gs` だけなので影響しない。`96_Menu.gs` の関数を呼ぶテストは上記 2 ファイルだけ（2026-09-11 に `menu[A-Z]|buildImportStatusView_` で grep して確認）。

### 13.5 「認可を外したら落ちる」ように作る

| 認可の壊れ方 | 落ちるテスト |
|---|---|
| 全員許可（`authorize` が常に通る） | C-13〜19、D-22〜25、F-31（監査行が増えない） |
| 全員拒否 | B-9〜12、D-22（許可側）、F-30・32・33 |
| 役割を集約でしか見ない（顧客ごとの判定が無い） | C-14（境界例 3）、D-22 の `admin@` 行 |
| オーナー特例が無い | A-1、B-11 |
| 無効顧客を除外しない | A-6、C-18 |
| 空メールで `getEffectiveUser` へ倒す | C-17（`setEffectiveUser('owner@example.com')` を併用して、それでも拒否されることを確かめる） |
| 監査を書かない | C-13〜16、F-31 |
| 監査の失敗で拒否が消える | C-20 |
| 未知コードを既定役割で通す | D-26 |
| 認可がトリガー経路に紛れ込む | G-36 |
| 入口が部品より緩い | D-28 |
| メニューが役割を自己申告する／ops を呼ぶ | F-34 |
| `03` の定数の綴りが `ROLE` とずれる（例：`'SYSTEM_ADMN'`。全員拒否として静かに現れる） | I-40（と D-22 の許可側） |
| 部品側の R列チェックがオーナーを拒む食い違いが黙って変わる | G-38b（K-3 の現状固定） |

---

## 14. 受入条件

実装完了は次の**すべて**を満たすこと。各項目に検証方法を付けた。

**`rg` を `src/` に対して使うときは必ず `-a` を付ける。** `src/97_Ops.gs` 97 行の文字列リテラルには生の NUL 文字（辞書キーの区切り）が入っており、ripgrep はこのファイルを**バイナリとみなしてディレクトリ走査から黙って除外する**（2026-09-11 に確認：`rg -l SYSTEM_ADMIN src/` は `52`・`54` だけを返し、`rg -a -l SYSTEM_ADMIN src/` は `97` も返す）。`-a` の無い grep 手順は `97_Ops.gs` に盲目であり、「無いことの確認」が嘘になる。Node の `fs` で読むテスト F-34・F-35・G-36 はこの影響を受けない。

**コード**

1. `src/00_Config.gs` に `const ROLE = createStringEnum_(['REVIEWER', 'SYSTEM_ADMIN', 'OWNER_ADMIN']);` があり、`ROLE` という名のグローバルが他に無い。── `rg -a -n "^(const|var|let) ROLE\b" src/` が `00_Config.gs` の 1 件だけ
2. `src/03_Authorization.gs` が存在し、`authorize` `getUserRole` `hasRole` `getAuthorizedCustomerIds` `authorizeOperation` `isCorpusAdmin` `roleLabel` を定義する。── `rg -n "^function (authorize|getUserRole|hasRole|getAuthorizedCustomerIds|authorizeOperation|isCorpusAdmin|roleLabel)\(" src/03_Authorization.gs` が 7 件。
3. `03_Authorization.gs` のトップレベルに関数宣言と `var X = <リテラル>` 以外が無い。特に `AuthorizationError` `appendAudit` `getActiveCustomers` をトップレベルで参照しない。── 目視。
4. `src/96_Menu.gs` に `ops` 関数の呼出しが無い。── テスト F-34。
   4b. `src/96_Menu.gs` に `getOwner(` `getAuthorizedCustomers(` `getActiveCustomers(` が無い（判定と閲覧範囲の取得は `03` に一本化。`96` は `authorize` の戻り値だけを使う）。── `rg -n "getOwner\(|getAuthorizedCustomers\(|getActiveCustomers\(" src/96_Menu.gs` が 0 件。
5. `src/96_Menu.gs` と `src/03_Authorization.gs` に役割の文字列リテラル（`'REVIEWER'` `'SYSTEM_ADMIN'` `'OWNER_ADMIN'`）が無い。**例外は `03` のトップレベル定数 `ROLE_RANK_`・`ROLE_LABELS_` のキーと `OPERATION_ROLES_` の値だけ**（§6.1。関数本体には無い）。── テスト F-34（`96`）、テスト I-40（`03` の 3 定数と `ROLE` の一致）、目視（`03` の関数本体）。
6. `authorize(` `authorizeOperation(` を含むファイルが `03_Authorization.gs` と `96_Menu.gs` だけ。── テスト F-35、`rg -a -l "authorize(Operation)?\(" src/`（`-a` が無いと `97_Ops.gs` が走査から落ち、そこに呼出しが紛れても見えない）
7. `03_Authorization.gs` が `validateSettings` `validateCustomerAccess` `getCustomerById` `loadSettingsFromProperties` `Session.getEffectiveUser` `effectiveUserEmail_` を呼ばない。── `rg -n "validateSettings|validateCustomerAccess|getCustomerById|loadSettingsFromProperties|getEffectiveUser|effectiveUserEmail_" src/03_Authorization.gs` が 0 件。
8. `01_DataAccessCore.gs` `02_CustomerMaster.gs` `05_SettingsValidator.gs` `11_FileStateManager.gs` `34_MerchantDictionary.gs` `50〜56_*.gs` `60〜62_*.gs` `70〜71_*.gs` `95_Notifications.gs` `97_Ops.gs` `98_ReleaseGate.gs` `99_Test.gs` `appsscript.json` `test/gas-stubs.js` `test/gas-harness.js` に差分が無い。── `git diff --stat`

**テスト**

9. `node test/run-tests.js` が全件 PASS。既存 814 件＋ §13.3 の 43 ケース（相当。1〜40 に 3b・21b・38b を加えた数）。
10. `test/phase7-menu-readonly.test.js` に差分が無い（§13.4 の例外を除く）。
11. `authorize` の `batchGet` が顧客数非依存で 1（E-29）。

**実機（コンテナのスプレッドシートを開いて確認。`clasp push` 後は F5 リロード。メモリ `gas-environment.md`）**

12. 「診断 ▸ このメニューについて」が `役割:` `顧客ごとの役割:` `マスターのオーナー:` を表示する。**この結果を §15 の U-A1・U-A2 に記録する。**
13. 「取込の状況」の見出し 1 行目が `実行者: …（オーナー管理者）`（開発者アカウントの場合）。
14. Q/R に無いアカウントで項目を押すと付録 C の文言 B が出て、監査ログの末尾に `PERMISSION` の行（D列＝そのアカウント、K列に `"decision":"DENIED"`）が 1 行増える。（テスト用アカウントが無ければ「未実施」と記録して残す。U-A1）
15. 定期取込トリガーが動いている状態で push し、次の 2 tick で Apps Script の「実行数」画面に新しい失敗が増えていない。`clasp run opsCountFileStates` が push 前と同じ数字を返す。
16. `clasp run opsShowLeases`・`clasp run opsShowOpenReviews` が従来どおり動く（認可は掛かっていない）。
17. `clasp run releaseGateReport` が全通過（`00_Config.gs` を触ったので念のため。メモリ `gas-environment.md`「ハッシュ・直列化…に触ったら再実行」には該当しないが、列挙追加の副作用が無いことの確認）。
18. 拒否を 1 回起こした後、`verifyChain('RECENT')` 相当（`runImport` の step 4 が呼ぶ）が壊れていない：次の tick の報告に `auditChain: 'BROKEN_NOTIFY_ONLY'` が出ない。

**運用手順（受入時に確認する）**

19. 顧客を追加するときは、その顧客の R列に**定期取込トリガーの作成者**を入れる（§7.4）。
20. オーナーが自分を**全顧客の** R列に載せておく（U-A2 が否のときの保険であり、K-3 ── 部品側の R列チェックにオーナー特例が無い ── の回避策でもある。現在の `TEST01` は既にそうなっている。顧客を追加したら受入 19 と併せて確認する）。
21. **コンテナの編集者は「全顧客のデータを預けてよい人」に限る**（§2.4。ウェブアプリ化まで、これが唯一のセキュリティ境界である）。コンテナの編集権限を持つが Q/R に無い人が居ると、その人の操作は毎回 `PERMISSION` 行になる。監査ログに `PERMISSION` が続く場合は、その人を登録するか編集権限を外す。次段階の操作系メニューの受入でも本項を前提条件として引き継ぐ。

---

## 15. 未確認事項と実機確認手順

| ID | 事項 | 影響 | 確認手順 | 結果（受入時に記入） |
|---|---|---|---|---|
| U-A1 | メニュー実行で、開発者以外の消費者アカウントでも `Session.getActiveUser().getEmail()` が取れるか | 取れなければその人は全項目で文言 A の拒否になる（フェイルクローズ。運用は開発者アカウントで続く） | 受入 12・14。Q列に登録した別アカウントで「このメニューについて」を押し、`実行者:` が空でないことを見る。取れない場合の対処は**別途判断**（`getEffectiveUser` へ倒すことは本仕様が禁じている。§4.2） | |
| U-A2 | `masterSpreadsheet_().getOwner().getEmail()` がオーナー自身の実行で取れるか（メニュー仕様 U-4 の継続） | 取れなければ誰もオーナー管理者にならない。参照系は R列で動く | 受入 12 の `マスターのオーナー:` と `役割:` | |
| U-A3 | 時間主導トリガーの中で `getActiveUser` が空になる環境があるか | 本仕様は関係しない（トリガー経路は `authorize` を通らない）。将来トリガー経路に認可を入れる判断の材料 | 受入 15（tick が止まらないこと）。通知仕様 U-N2・U-N3 の記録を流用 | |
| U-A4 | コンテナ≠マスターで、マスターに閲覧権限しか無い人が拒否されたとき、`appendAudit` の失敗が握りつぶされて拒否文言が出るか | 出なければ §8.4 の実装漏れ | そのような人が居れば受入 14 と同時に確認。居なければ「未実施」 | |
| U-A5 | 拒否行（`PERMISSION`）を含む監査ログで `verifyChain('FULL')` が通るか（Node では C-21b で固定） | 通らなければ連鎖の直列化に列の型差がある | 受入 18 | |
| K-1（課題） | `runImport` step 1 のオーナー特例（§7.4） | 操作系「選択ファイルを処理」で `authorize` と `runImport` の判定が食い違う | 操作系メニューの仕様で決める | - |
| K-2（課題） | 承認申請（`submitRequest`／`approveRequest`）の申請者・承認者の役割検証 | 承認画面を作るときに `authorize(ROLE.OWNER_ADMIN, …)` を通す | 同上 | - |
| K-3（課題） | 部品側の R列チェック（`forceReleaseLease` `11_FileStateManager.gs` 156 行、`registerDictionaryPattern` `34_MerchantDictionary.gs` 53 行）にオーナー特例が無い（§7.5） | オーナーが R列に無い顧客で、`authorize(SYSTEM_ADMIN, cid)` が通った後に部品が拒否する。次段階の「リースの強制解放」「取引先判断の適用」でオーナーが締め出される | 操作系メニューの仕様で、部品に `ROLE.OWNER_ADMIN` の特例を入れるか（`input.role` を見る形に揃える）、運用（受入 20）で吸収するかを決める。現状は G-38b で固定 | - |
| K-4（課題） | 信頼境界（§2.4）：コンテナ編集者はコードを直接実行できるため、`authorize` は誤操作防止と検知の層に留まる | 顧客単位の分離を配備で強制できない。コンテナ編集者の選定だけが境界 | 実行形態の変更（オーナー権限で動くウェブアプリ、または Apps Script API 経由に書込を限定）を後続フェーズで検討する（仕様 Ver.2.6 §20.2 末尾・設計 §4.4.2）。それまで受入 21 の運用手順で担保する | - |

---

## 付録 A. 操作コード → 必要役割（`authorizeOperation` の正本）

出典：設計 §4.26 解決操作表（3643〜3670 行）、§4.4 操作別必要役割（1945〜1950 行）、§6.3 手順 3（5432 行）、仕様 Ver.2.6 §17.3（813 行）・§20.1（902 行）・§27.1（1225〜1231 行）。コードの集合は `51_ReviewResolution.gs` 17〜27 行・`52_FileResolution.gs` 16〜27 行・`54_IntegrityResolution.gs` 12〜15 行の和集合（テスト D-27）。

| 操作コード | 種別 | 基本の必要役割 | 入力による格上げ |
|---|---|---|---|
| `ADOPT_EXISTING_PARTNER` | 取引 `PARTNER` | `REVIEWER` | - |
| `REQUEST_NEW_PARTNER` | 取引 `PARTNER` | `REVIEWER`（申請。承認は `OWNER_ADMIN`。K-2） | - |
| `RESOLVE_WITHOUT_PARTNER` | 取引 `PARTNER` | `REVIEWER` | - |
| `FIX_DATE_AMOUNT` | 取引 `DATE`／`AMOUNT` | `REVIEWER` | - |
| `POST_ZERO_AMOUNT` | 取引 `ZERO_AMOUNT` | `REVIEWER` | - |
| `POST_PRIOR_YEAR` | 取引 `PRIOR_YEAR` | `REVIEWER` | - |
| `EXCLUDE_PRIOR_YEAR` | 取引 `PRIOR_YEAR` | `REVIEWER` | - |
| `EXCLUDE` | 取引 全種別 | `REVIEWER` | `allowImported === true` → `SYSTEM_ADMIN` |
| `ACCEPT_MANUAL_CHANGE` | 取引 `INTEGRITY` | `REVIEWER` | - |
| `REVERT_TO_SYSTEM_VALUE` | 取引 `INTEGRITY` | `REVIEWER` | - |
| `RESTORE_ROW` | 取引 `INTEGRITY` | **`OWNER_ADMIN`** | - |
| `ACCEPT_DELETION` | 取引 `INTEGRITY` | `REVIEWER` | - |
| `CONFIRM_FREEE_FIXED` | 取引 `INTEGRITY` | `REVIEWER` | - |
| `CONFIRM_INTEGRITY_RESOLVED` | 取引 `INTEGRITY` | **`SYSTEM_ADMIN`** | - |
| `REGISTER_FORMAT` | ファイル | **`SYSTEM_ADMIN`** | - |
| `SELECT_TARGET_SHEET` | ファイル `MULTI_SHEET` | **`SYSTEM_ADMIN`** | - |
| `CANCEL_FILE` | ファイル 全種別 | `REVIEWER`（仕様 Ver.2.6 §27.1「確認担当者が直接取消しを確定できる」） | `allowImported === true` → `SYSTEM_ADMIN` |
| `IMPORT_AS_NEW_FILE` | ファイル `DUPLICATE` | `REVIEWER` | - |
| `UPDATE_PURPOSE` | ファイル `DUPLICATE` | `REVIEWER` | - |
| `KEEP_ORIGINAL_RESULT` | ファイル `DUPLICATE`／`FILE_CHANGED` | `REVIEWER` | - |
| `APPLY_FILE_DIFF` | ファイル `FILE_CHANGED` | `REVIEWER` | - |
| `ADOPT_AS_NEW_TRANSACTION` | ファイル `FILE_CHANGED` | `REVIEWER` | - |
| `APPROVE_COUNT_MISMATCH` | ファイル `COUNT_TOTAL_MISMATCH` | `REVIEWER` | - |
| `REJECT_COUNT_MISMATCH` | ファイル `COUNT_TOTAL_MISMATCH` | `REVIEWER` | - |
| `CONFIRM_EMPTY_FILE` | ファイル `EMPTY_FILE` | `REVIEWER` | - |
| `RESIZE_INPUT` | ファイル `INPUT_LIMIT` | **`OWNER_ADMIN`**（上限設定の変更） | `askCustomerToSplit === true` → `REVIEWER`（顧客へ分割依頼） |
| `CONFIRM_DESTINATION_FIXED` | ファイル `DESTINATION_FIX` | **`SYSTEM_ADMIN`** | - |
| `APPROVE_SCAN_TRUNCATION` | ファイル `SCAN_TRUNCATED` | **`SYSTEM_ADMIN`** | - |

表に無いコード → `TypeError`。

**画面の「担当」表示との食い違い（意図的）。** `96_Menu.gs` の `MENU_REVIEW_HANDLER_LABELS_`（54〜71 行）は要確認の種別ごとに `FILE_CHANGED`・`INTEGRITY`・`INPUT_LIMIT` を「システム管理者」と表示するが、本表ではそれらの種別の操作の多く（`APPLY_FILE_DIFF` `ADOPT_AS_NEW_TRANSACTION` `KEEP_ORIGINAL_RESULT` `ACCEPT_MANUAL_CHANGE` `REVERT_TO_SYSTEM_VALUE` `ACCEPT_DELETION` `CONFIRM_FREEE_FIXED`、`askCustomerToSplit` 付きの `RESIZE_INPUT`）は `REVIEWER` である。画面の「担当」は**最初に連絡すべき人**（メニュー仕様 付録 A.2：1 種別に複数の担当があるとき広い方を出す。`06_ErrorCatalog.gs` の `handler` 列由来）であり、認可は**操作コードごと**に決まる（INV-18・設計 §4.26 表）。**両者は別のものであり、本仕様で画面の表示を変えない。** 次段階の「要確認を確定」は、種別ではなく選ばれた操作コードで `authorizeOperation` を呼ぶ。

---

## 付録 B. メニュー項目 → 必要役割（次段階の操作系メニューの正本。本仕様では未使用）

出典：設計 §4.2「メニュー項目のフィルタ基準」表（1682〜1697 行）。

| メニュー項目（仕様 §21.1／設計 §4.2） | `authorize` の第 1 引数 | 顧客 |
|---|---|---|
| 選択顧客をプレビュー／未処理ファイルを全件プレビュー | `ROLE.REVIEWER` | 対象顧客ごと |
| 選択ファイルを処理 | `ROLE.REVIEWER` | 対象顧客ごと（K-1） |
| 要修正ファイルを再検査 | `ROLE.REVIEWER` | 対象顧客ごと |
| 形式登録済みファイルを再検査 | `ROLE.SYSTEM_ADMIN` | 対象顧客ごと |
| 処理中ファイルを再開 | `ROLE.SYSTEM_ADMIN` | 対象顧客ごと |
| 処理済みファイルの変更を再走査 | `ROLE.SYSTEM_ADMIN` | 対象顧客ごと |
| 要確認を確定 | `authorizeOperation(操作コード, customerId, options)`（付録 A） | 要確認の G列 |
| 新しいカード形式を登録（入口 A〜F） | `ROLE.SYSTEM_ADMIN`（承認 E-2・E-3・F・段階 8 は `ROLE.OWNER_ADMIN`。E-1〜E-4 は `isCorpusAdmin` も要求） | 採取元顧客 |
| freee取込済みにする | `ROLE.REVIEWER` | 対象顧客ごと |
| 取消し・復元（`cancelTransactions` 経由） | `ROLE.REVIEWER`。freee取込済みを含む（`allowImported`）なら `ROLE.SYSTEM_ADMIN`。転記行の復元（`RESTORE_ROW`）は `ROLE.OWNER_ADMIN` | 対象顧客ごと |
| リースの強制解放 | `ROLE.SYSTEM_ADMIN`（部品 `forceReleaseLease` も R列を検査する。**オーナー特例は部品に無い**。K-3） | リースの B列 |
| 監査ログの連鎖を検証 | `ROLE.SYSTEM_ADMIN` | 横断（`null`） |
| スナップショットから復元 | `ROLE.OWNER_ADMIN` | 横断（`null`） |
| 対象年度を変更 | `ROLE.SYSTEM_ADMIN` | 対象顧客 |
| 処理ログを開く／取込の状況／ファイル一覧／要確認を開く／診断 ▸ 各項目 | `ROLE.REVIEWER` | 横断（本仕様で実装済み） |

---

## 付録 C. 拒否文言の正本

`AuthorizationError.detail` に入れる文。**これ以外の文を作らない。** A・B はメニュー仕様 §4.2 と同一（既存テスト 6・7 が固定）。

| 理由コード | 条件 | 文 |
|---|---|---|
| A `ACTOR_UNKNOWN` | 実行者メールが空 | `実行者のメールアドレスを取得できないため表示できません（仕様 §20.5）。スクリプトの承認が済んでいるか確認してください。` |
| B `NO_CUSTOMER_ACCESS`（横断） | `customerId` 無しで許可顧客が 0 件 | `閲覧を許可された顧客がありません。実行者: {email}。顧客マスターの Q列（確認担当者）または R列（システム管理者）にこのアドレスを登録してください。` |
| C `NO_CUSTOMER_ACCESS`（顧客指定） | 当該顧客の Q列・R列に無い（オーナーでない） | `顧客 {customerId} に対する権限がありません。実行者: {email}。顧客マスターの Q列（確認担当者）または R列（システム管理者）にこのアドレスを登録してください。`（顧客名は出さない。権限の無い人に名前を見せない） |
| D `ROLE_INSUFFICIENT` | 役割が不足 | `この操作には{必要役割ラベル}の権限が必要です。実行者: {email}（{対象}に対する役割: {役割ラベル}）。`。`{対象}` は `customerId` があれば `顧客 {customerId}`、無ければ `全体` |
| E `CUSTOMER_NOT_ACTIVE` | 顧客が無い・無効 | `顧客 {customerId} は顧客マスターに無いか、無効になっています。` |

`{email}` は取得した原文。`{必要役割ラベル}`・`{役割ラベル}` は `roleLabel`。

---

## 付録 D. 既存関数の参照表（本仕様が呼ぶもの）

| 関数 | ファイル・行 | 用途 |
|---|---|---|
| `activeUserEmail_()` | `01_DataAccessCore.gs` 50〜53 | 実行者 |
| `csvEmails_(value)` | 同 279〜281 | メールの正規化規則（実行者側にも同じ規則を適用） |
| `masterSpreadsheet_()` | 同 20〜31 | オーナーの取得 |
| `getActiveCustomers()` | `02_CustomerMaster.gs` 149〜157 | 有効顧客一覧（`reviewers`・`admins` 済み） |
| `getAuthorizedCustomers(email)` | 同 166〜171 | 非オーナーの許可顧客の述語の正本（`03` からは呼ばず、同じ述語を適用する。テスト A-3b で同値を固定） |
| `appendAudit(entry)` | `62_AuditLog.gs` 48〜50 | 拒否の記録 |
| `AuthorizationError` | `06_ErrorCatalog.gs` 89〜91 | 拒否の例外 |
| `createStringEnum_` | `00_Config.gs` 10〜16 | `ROLE` の生成 |
| `SETTINGS.CORPUS_ADMIN_EMAILS` | 同 317 | コーパス管理者 |
| `TX_REVIEW_OPERATIONS_` `FILE_REVIEW_OPERATIONS_` `FILE_OPERATION_ROLES_` `INTEGRITY_OPERATIONS_` | `51`・`52`・`54` | テスト D-27・D-28 の比較対象（`03` からは参照しない。読込順で `03` が先） |
| `runMenuAction_` `menuViewerScope_` `menuHeaderLines_` `menuShowAbout` `filterByScope_` `classifyMenuError_` | `96_Menu.gs` 280〜290・331〜359・361〜367・243〜276・656〜662・664〜704 | 改修対象／不変の対象 |

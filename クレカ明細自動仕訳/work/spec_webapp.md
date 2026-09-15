# クレカ取込・記帳 Web アプリ 仕様書 ── 第1段

対象システム：クレジットカード明細 自動仕訳システム（Google Apps Script、リポジトリ `クレカ明細自動仕訳`）
作成日：2026-09-15
版：0.5（監査 2 巡目の反映。付録C を新設）
読者：本仕様だけを読んで実装する実装者（AI を含む）。この文書に書いていないことは実装者が決めてよいが、**書いてあることは変えない**。判断に迷う箇所は §2.4「線引きの原理」と §14「未確認事項と課題」を先に読む。

改訂履歴：
- 0.5（2026-09-15、**監査 2 巡目の反映**。全体整合監査が高 6・中低 9、主張検証が事実誤認 5 を返し、うち中核の主張は**試作を動かして**確かめられた）：**0.4 の修正が届かなかった節がある。**(1) §10 が `71` を「触らない」に残したままだった ── §7.3.1 が同じ文書で `71` 208 行の変更を要求しており、**列挙のほうを読んだ実装者は §7.3.1 を飛ばし、0.4 で直したはずの「取込が雛形へ書く」欠陥へそのまま戻る。**(2) §12.3 のケース 8・12 が**常に空の取引ログ AC・AD列**を期待したままで、書いたとおりに実装すると必ず赤になる。(3) ケース 5 が旧設計（2行目以降が空）のままで §8.2 と食い違っていた。(4) §7.4.1 の「一致しなければ拒否する」に**拒否する手順が無かった** ── `authorizeOperation` は 2 つの `customerId` を比べないので（`03_Authorization.gs` 189〜195 行）、オーナーは全顧客の役割を持ち**素通りする**。0.3 は「検証の規定が無い」状態で監査に見つかったが、0.4 は「検証がある」と書いてしまったので、次の監査は通過済みとして飛ばす ── **誤った安心を文書に固定する寸前だった。**(5) **試作で 5 つの事実誤認が出た。**最も重いのは `runImport` が**件数非依存ではない**こと（149 ＋ 7×要確認件数。要確認 10 件で 366 秒＝6 分の壁）。既存テストが「件数非依存」を固定できていたのは、材料が辞書登録済みの店名で要確認が1件も立たないからで、**Web アプリの主用途はまさに未解決 `PARTNER` である。**§3.3 に取込の件数上限を足した。(6) **自前ループは `input.learn` を明示しなければならない**（§7.4.2）── `adoptExistingPartner_` 143 行は `if (input.learn !== false)` なので未指定は「学習する」であり、**空店名で学習すると以後その顧客の空店名取引がすべて自動確定される**（ハーネス実測）。さらに取引状態の確認（§7.4.3）が要る。`WEBAPP_ITEM_TRIPS_` は 60 ではなく **64**（`getTransaction` の 4 を含む）。(7) §2.4 原理 1 の「取り消せないと告げてから」に対応する確認手順が §7.4 に無かった。(8) **付録C（当たり先の表）を新設した** ── `spec_menu_operations.md` で「1 つの値の変更に 19 箇所の直し漏れ」を止めた唯一の道具で、本文から機械で作っている。(9) その他：`menuViewerScope_` は 1175 行ではなく 1228 行、`rethrow` の枝は 1599 行ではなく 1595 行、`51`・`52` の第3引数の名前は `options` ではなく `input`、恒等式は `errors.length` ではなく「`reviewId` を持つ `errors` の数」、受入 2 は `git diff --stat` では**新設 2 ファイルを数え落とす**ので `git status --porcelain` で数える、§12.2 にスタブの追加 3 点（スプレッドシートを Drive ファイルとして見せる・`makeCopy`・`getParents`）を明記。
- 0.4（2026-09-15、**監査 1 巡目の反映**。全体整合監査が高 8・中低 6、主張検証が事実誤認 13・未記載の事実 9 を返した）：**土台が事実に反していた。**(1) §2.4 原理 4 は「既存取引の転記先は取引ログ AC列が持つ」と書いていたが、**AC・AD列は受け口があるだけで値を渡す呼出しが `src/` に1つも無く、常に空文字である**（ハーネス実測）。正本は**要確認シート M列・N列**で、`70_ImportFlow.gs` 348〜349 行が書き、`51_ReviewResolution.gs` 229 行が既に使っている。§8.5 のコード例は `SpreadsheetApp.openById('')` で毎回落ちる形だった。**§0 が自ら課した「その値を書いている箇所を確かめてから決める」という規律を、画面の表示項目には適用し、書込先という最も重い値には適用し損ねた。**(2) §8.2 の「2行目以降の値を消す」は、転記先の他列にある**勘定科目の既定値と消費税の数式**を消す。`45_DestinationIndex.gs` 143〜147 行は行を増やすときの複製元を「数式を持つ空き行」から選ぶので、消すと `expandTemplateRows` が `getMaxRows()` へ落ち、`43_SheetWriter.gs` 110〜114 行が明示的に禁じた複製元を使う。しかも `validateDestinationSchema` は「データ行 0 行なら合格」なので**検証を素通りする**。6 列だけ消す形に改めた。(3) **原理 4 を掲げながら、本文の主要2経路がそれを破る手順を書いていた** ── 取込は `runImport` に差し替え口が無いのに §10 が `71` を「触らない」と決め、要確認の確定は `applyResolveDecision_` が自ら `getCustomerById` を呼ぶのに §10 が `96` を「変更しない」と決めていた。前者は `71` 208 行に口を1つ足し、後者は自前のループに改めた。(4) クライアントから来る `destinationSpreadsheetId`・`reviewId` に検証の規定が無く、`executeAs: USER_DEPLOYING` の全権限で任意のスプレッドシートへ書けた。(5) 受入 2（3ファイル差分）が §10（6ファイル変更）と両立せず、受入 1 は既存テスト `auth F-35` が必ず赤になるため達成不能だった ── **赤を消す最短経路が「認可を外す」である**ことが最も危うい。(6) 予算に**ファイル数を掛けていなかった**（`spec_menu_operations.md` v2.0 で一度直した欠陥と同型）。Web アプリは店名でグループ化しないのでメニューより条件が悪く、15 件が 15 ファイルに跨れば後始末の最悪は締切の 5 倍になる。計測段階の上限は 2 ではなく **1**。(7) その他：`CANCEL_FILE` は転記行を触る（触らないと書いていた）、取消しの壊れ方は「別の行を消す」ではなく「1行も消せない」、`buildIndex` の呼出しは 4 箇所ではなく 7 箇所（`97_Ops.gs` の 2 箇所は定期取込から自動実行される）、`classifyMenuError_` は 661 行ではなく 1551 行、`EXCLUDE` は 37 ではなく 36 往復、`candidates` は配列ではなく JSON 文字列、`INTEGRITY` が種別の列挙から漏れ、`runImport` はオーナーを特権化しない、雛形の複製で `取引先一覧` タブも複製される。
- 0.3（2026-09-15）：K-W4・K-W5・K-W6 の調査を反映。方針 B''（書込経路だけ直し、整合性チェックは第2段）。
- 0.2（2026-09-15）：K-W4・K-W6 の調査を反映。
- 0.1（2026-09-15）：初稿。利用者の指定（3カラムのWebアプリ・転記シートは押下ごとに新規作成・クレカ取込記帳のフローのみ）を受けて起こした。

---

## 0. この文書の読み方

**決定そのものより、その理由の方が重要である。**理由が成立しない場面に出会ったら、決定を機械的に適用せず §14 に書き足して報告すること。

数値は §3 の実測か、計算過程を示したものだけを使う。推測値を書かない。

**画面に出す項目は、その値を書いている箇所を確かめてから決める。**既存仕様書（`spec_menu_operations.md` §7.4）で同じ型の欠陥が4度出ている ── 取込側が書かない列を画面に出そうとして、実データで空欄が並んだ。**新しい項目を出したくなったら、まず `runImport` で実データを立てて値が入るか見ること。**

---

## 1. 背景と目的

### 1.1 現状 ── ダイアログ方式の限界

`gas-push-78` で操作系メニュー（要確認の確定・要修正ファイルの再検査）が本番稼働した。スプレッドシートのメニューから `ui.prompt`／`ui.alert` を順に出す方式である。

実機で次が確認された（2026-09-15）：

- **1件の確定に 40 秒**（往復単価 約 0.39 秒 × 102 往復）
- **1回の押下の実行時間は 63〜78 秒**。差はダイアログの操作時間
- **結果ダイアログを開いたままにすると 6 分で強制終了される**（実測 360.8 秒）。`ui.alert` は利用者が OK を押すまでサーバー側の実行を止めるため。帳簿は無事だが、**何件確定したかの要約が見られなくなる**

ダイアログ方式の制約はこうである：

| 制約 | 理由 |
|---|---|
| 1件ずつしか選べない | 番号入力の prompt は1つの値しか受け取れない |
| 一覧は15件まで | prompt の本文に収まる行数 |
| 利用者の操作時間が実行時間を食う | `ui.*` がサーバー実行を止める |
| 複数のカードを横断できない | 顧客の全ファイルが1つの一覧に混ざる |

### 1.2 Web アプリで何が変わるか

`google.script.run` はクライアント（ブラウザ）からサーバー関数を呼ぶ。**1回の呼出しが独立した実行**になるので：

- **利用者の操作時間は実行時間に入らない**。6分の壁は「1回のサーバー呼出し」にだけ掛かる
- 表で複数件を一度に入力し、まとめて送れる
- 顧客・カードフォルダを画面で切り替えられる

### 1.3 前提 ── 認可仕様が先送りした当のもの

`spec_authorization.md` の非範囲表に次がある：

| 項目 | 理由 |
|---|---|
| ウェブアプリ化・オーナー権限実行 | 実行形態の変更であり後続フェーズ |
| `google.script.run` によるダイアログからのサーバー呼出し | 認可の入口が増える |

**本仕様はこの2つを解禁する。**したがって認可の信頼境界を引き直す必要がある（§4）。

---

## 2. 範囲と非範囲

### 2.1 作るもの

モック2枚目（3カラム）の構成で、**クレカ取込・記帳のフローだけ**を作る。

```
┌────────┬──────────────┬──────────┐
│ 顧客一覧│ Drive フォルダ│ 要確認   │
│ 検索   │ フォルダ木    │ 表で入力  │
│ 一覧   │ ファイル一覧  │ 記帳を実行│
│        │              │ Excel DL │
└────────┴──────────────┴──────────┘
```

### 2.2 非範囲（サイドバーの他項目）

取引一覧・レポート・マスタ管理・設定は**今回作らない**。サイドバーには枠だけ置き、押すと「準備中」と出す。

理由：マスタ管理と設定は書込を伴う画面であり、認可・検証・監査をそれぞれ設計し直す必要がある。記帳のフローが動くことを先に確かめる。

### 2.3 既存メニューとの関係

**操作系メニュー（`gas-push-78`）は残す。**Web アプリが安定するまでの退避路であり、片方が壊れてももう片方で確定できる。

**読取専用メニューも残す。**

### 2.4 線引きの原理

1. **帳簿を壊す操作は、その内容を見せ、取り消せないと告げてからしか出さない。**
2. **画面は認可の代わりにならない。**表示を絞ることは補助であり、書込の直前に必ず `authorizeOperation` を通す（既存 §4 と同じ）。
3. **既存の書込経路を作り直さない。**950 テストで固めた `resolveReview`・`43_SheetWriter`・整合性チェックはそのまま使う。Web アプリは**その上の層**である。
4. **転記先は取引ごとに決まる。**顧客マスター F列（`destinationSpreadsheetId`）は「**次に作るシートの雛形**」であって、既存取引の書込先ではない。既存取引の書込先は**要確認シート M列・N列**（`destinationSpreadsheetId`・`destinationSheetName`）が持つ ── `70_ImportFlow.gs` 348〜349 行が取込時の `customer` から書き、`50_ReviewStore.gs` 65・168〜169 行が読み書きし、**`51_ReviewResolution.gs` 229 行が既にそれを正本として使っている**。

   **取引ログ AC・AD列を使ってはならない。**`61_TransactionLog.gs` 25・68 行に受け口はあるが、**値を渡す呼出しが `src/` に1つも無く、取込後は常に空文字である**（レビューでハーネス実測：`runImport` → `getTransaction` で `destinationSpreadsheetId: ""`）。取引ログが埋めるのは AE列（`destinationRow`）だけである（`61` 291 行・`43_SheetWriter.gs` 380 行がいずれも 31 列目のみを書く）。**`tx.destinationSpreadsheetId` を使う実装は `SpreadsheetApp.openById('')` で毎回落ちる。**
   **理由 ── シートを間違えると、別の取引の行を壊す。**書込先は「`customer.destinationSpreadsheetId` の `rowNumber` 行目」で決まり（`43_SheetWriter.gs` 210〜258 行。219 行がシート名、257 行が spreadsheetId を決める。行を空にする経路は 267〜282 行）、`rowNumber` は `tx.destinationRow` ＝ **ただの行番号**である。シートA の15行目に居る取引を確定するとき、誤ってシートB を開けば、**シートB の15行目に居る無関係な取引の取引先名を上書きする**。書き損じではなく破壊である。
   いまは顧客に転記先が1枚しかないのでこの経路は存在せず、**950 テストは1枚前提なので1本も赤にならない**。押下ごとに新規作成にした瞬間に生まれる欠陥である。
5. **1回のサーバー呼出しで 6 分を超えない。**超えそうなら分割して、クライアントが繰り返し呼ぶ。

**本文が「原理 4」と書くときは、必ず上の 4（転記先は取引ごとに決まる）を指す。**6 分の話は原理 5 と呼ぶ。

---

## 3. 実行環境の事実

### 3.1 Web アプリの実行モデル

- `doGet(e)` が `HtmlService.createTemplateFromFile(...).evaluate()` を返す
- クライアントの `google.script.run.withSuccessHandler(fn).serverFunction(args)` が**独立した実行**を起こす
- **各呼出しに 6 分の上限が別々に掛かる**
- 同時に走る呼出しは直列化されない ── `withScriptLock_` が要る箇所は既存のまま

### 3.2 往復回数と時間（実測。`spec_menu_operations.md` §3.2 より）

| 部品 | 往復 | 実測単価 0.39 秒での時間 |
|---|---|---|
| `authorize` | 2 | 0.8 秒 |
| `openReviews({})` | 2 | 0.8 秒 |
| `getTransaction` | 4 | 1.6 秒 |
| `resolveReview` `ADOPT_EXISTING_PARTNER` | 60（学習込み。`input.learn = false` なら 57。2026-09-15 ハーネス実測。差は `learnFromResolution` の 3 往復） | 23 秒 |
| **Web アプリの 1 件**（＝上の 60 ＋ §7.4.3 の `getTransaction` 4） | **64** | **25 秒** |
| `resolveReview` `RESOLVE_WITHOUT_PARTNER` | 29 | 11 秒 |
| `resolveReview` `EXCLUDE` | 36（`spec_menu_operations.md` §3.2 は 37。2026-09-15 にハーネスで 3 通りの材料を測り直していずれも 13/12/11 ＝ 36。安全側なので予算は 37 のままでよい） | 14 秒 |
| 後始末（1ファイルあたり） | 14〜62 | 5〜24 秒 |
| `runImport`（1ファイル） | **149 ＋ 7×要確認件数**（2026-09-15 ハーネス実測：要確認 0／2／22／40 件で 149／163／303／429 往復）。**件数非依存ではない** ── 149 は要確認が1件も立たない場合の値で、`registerPendingReviews` が要確認1件につき7往復を足す。既存テスト `phase6-round-trips.test.js` が「件数非依存」を固定できているのは、材料が**共通取引先辞書に登録済みの店名**で要確認が1件も立たないからである | 58 秒（要確認 0 件のとき） |

**単価 0.39 秒は 2026-09-15 の実機 1 回の測定である**（`spec_menu_operations.md` 受入12 の3回測定は1回で中断した）。本仕様でも**計測段階の安全側 1600 ms を使い**、受入で測り直す（§13）。

### 3.3 1回の呼出しに入れてよい量

締切を **300 秒**（6分から予備60秒）とし、見積は「往復数 × 単価」で作る。計測段階（単価 1.6 秒）では：

| 操作 | 1件の往復 | 後始末（1ファイルあたり） | 300 秒に入る件数 |
|---|---|---|---|
| `ADOPT_EXISTING_PARTNER`（§7.4.3 の `getTransaction` 込み） | 64 | 62 × **触るファイル数** | 1 ファイルなら **1 件**。2 ファイルなら 0 件 |
| `runImport` | 149 ＋ 7×要確認件数／ファイル | 149 に含む | 1 ファイル、**かつ未解決の要確認が 4 件まで** |

**取込は要確認の件数で 6 分の壁に当たる。**単価 1600 ms・複製ぶん 10 往復込みの実測換算：

| 要確認 | 往復 | 時間 | |
|---|---|---|---|
| 0 件 | 159 | 254 秒 | 収まる |
| 4 件 | 187 | 299 秒 | ぎりぎり収まる |
| 5 件 | 194 | **310 秒** | **締切超過** |
| 10 件 | 229 | **366 秒** | **6 分の壁** |
| 15 件 | 264 | **422 秒** | **6 分の壁** |

**Web アプリの主用途はまさに未解決 `PARTNER` を扱う画面である**（§5.4）。未登録店が 10 件あるファイルを 1 本取り込むと強制終了に当たる。

**したがって `webAppRunImport_` は、1回の呼出しにつき 1 ファイルに限るだけでなく、そのファイルが立てる要確認が 4 件を超えると見込まれる場合も次の呼出しへ回す。**見込みは取込の前には分からないので、**実際には `runImport` を呼ぶ前に経過時間を見て、`159 + 7 × WEBAPP_REVIEW_LIST_LIMIT_`（＝264 往復＝422 秒）が残り時間に収まらなければその呼出しでは取り込まない**（最悪を仮定する。§2.4 原理 5）。収まらない場合は `remaining` を返してクライアントに再度呼ばせる。

**後始末の見積に必ずファイル数を掛ける。**`cleanupWorst = WEBAPP_CLEANUP_TRIPS_(62) × 触る予定のファイル数 × WEBAPP_TRIP_WORST_MS_`。**1 に固定してはならない** ── `spec_menu_operations.md` §6.4 が「1 ファイル分の 62 を固定値にすると…予備の 60 秒を食い潰して 6 分の強制終了に至る」と書いた欠陥（同仕様 v2.0 で一度直したもの）へ戻る。実装も `96_Menu.gs` 813 行で `cleanupTrips * fileIds.length * tripWorstMs` としている。

**Web アプリはメニューより条件が悪い。**§5.4 の表は顧客の未解決 `PARTNER` をそのまま並べ、店名でグループ化しないので、15 件が 15 ファイルに跨り得る。そのとき後始末の最悪は 62×15×1.6 ＝ **1,488 秒**で締切の 5 倍である（1 件の実費 64×1.6 ＝ 102 秒を加えるまでもない）。**`decisions` は1回の呼出しにつき1ファイル分に限る**（§7.4.1）。

**計測段階の検算（1 ファイル）：**2 件目を始める条件は `elapsed ≤ 300000 − 64×1600 − 62×1×1600 ＝ 98,400 ms`。書込前の固定費が約 10 秒、1 件目の実費が 64×1.6 ＝ 102 秒で、2 件目の開始は約 112 秒 ── **98.4 秒を超えるので始まらない。**したがって計測段階の `WEBAPP_MAX_PER_CALL_` は **1** とする。受入 12 で単価を測り直した後に引き上げる。

**したがってクライアントは「1回の呼出しで処理した件数」を受け取り、残りがあれば再度呼ぶ。**進捗はクライアント側で表示する。

---

## 4. 認可の掛け方 ── 信頼境界を引き直す

### 4.1 いまの前提と、それが崩れる理由

既存の認可仕様 §2.4 はこう書いている：

> コンテナバインドのスクリプトなので、メニューを使える人＝スクリプトを編集できる人である。`authorize` は**誤操作防止と検知の層であり、防護ではない**。

**Web アプリはこの前提を壊す。**URL を知っていれば、スクリプトを編集できない人も到達し得る。

### 4.2 決定 ── 第1段はオーナーだけが使える形で出す

`appsscript.json` に次を足す：

```json
"webapp": {
  "executeAs": "USER_DEPLOYING",
  "access": "MYSELF"
}
```

理由：

- **`access: MYSELF`** ── デプロイしたオーナーだけが開ける。いまの運用（操作者はオーナー1名）と一致し、信頼境界が変わらない
- **`executeAs: USER_DEPLOYING`** ── オーナーの権限で動くので、Drive・スプレッドシートへのアクセスが既存の `clasp run` と同じになる
- `Session.getActiveUser().getEmail()` は**この組合せで動く**（オーナー自身がアクセスするため）

**`access: ANYONE`／`ANYONE_ANONYMOUS` にしてはならない** ── `getActiveUser()` が空文字を返し、`activeUserEmail_`（`01_DataAccessCore.gs` 50 行）が実行者を特定できなくなる。認可も監査ログも成立しない。

### 4.3 担当者へ開く場合（第2段。本仕様の範囲外）

顧客マスター Q列（確認担当者）・R列（システム管理者）に登録された人に開くには、`access: ANYONE`＋**自前のログイン**か、Workspace ドメインなら `access: DOMAIN` が要る。いまのオーナーは個人 Gmail アカウント（`k.nakagawa662@gmail.com`）なので `DOMAIN` は使えない。**K-W1** として §14 に記録する。

### 4.4 サーバー関数ごとの認可

**すべての `google.script.run` の入口で認可を通す。**クライアントから来た値を信用しない。

| 入口 | 認可 |
|---|---|
| 一覧の取得（顧客・フォルダ・ファイル・要確認） | `authorize(ROLE.REVIEWER, null, {operation: 'WEBAPP:一覧'})` |
| 記帳の実行 | `authorize(ROLE.REVIEWER, customerId, {operation: 'WEBAPP:記帳'})` |
| 要確認の確定 | `authorizeOperation(code, customerId, options)`（既存 §4 と同じ） |
| Excel の書き出し | `authorize(ROLE.REVIEWER, customerId, {operation: 'WEBAPP:Excel'})` |

**顧客 ID はクライアントから来る。**必ずサーバー側で `filterByScope_` に相当する絞込を掛け直すこと ── 画面が出した選択肢だけが送られてくるとは限らない。

---

## 5. 画面

### 5.1 全体（3カラム）

```
┌─ ヘッダ ────────────────────────────────────┐
│ 記帳自動化システム          実行者: {email} │
└──────────────────────────────────────────────┘
┌─ 左 ────┬─ 中央 ──────────┬─ 右 ────────────┐
│ 顧客一覧 │ Drive フォルダ   │ 要確認 {n} 件   │
│          │                  │                 │
│ [検索]   │ {顧客名}         │ 表（§5.4）      │
│          │  ├ カードA       │                 │
│ ● 顧客1  │  ├ カードB ←選択 │ [記帳を実行]    │
│ ○ 顧客2  │  └ カードC       │                 │
│ ○ 顧客3  │                  │ [Excelダウン…] │
│          │ ファイル一覧     │                 │
└──────────┴──────────────────┴─────────────────┘
```

### 5.2 左：顧客一覧

- **`authorize(ROLE.REVIEWER, null, {operation: 'WEBAPP:一覧'})` の戻り値 `customers` をそのまま使う。**`menuViewerScope_`（`96_Menu.gs` 1228〜1245 行）を呼んではならない ── 同関数は `{operation: 'MENU:' + actionName}` と前置するので、監査ログに `MENU:WEBAPP:一覧` と出る。`authorize` の戻り値は既に `{isOwner, customers, rolesByCustomerId}` を持つので、`getActiveCustomers()` ＋ `filterByScope_` より 2 往復安い
- 検索は**クライアント側**の絞込（サーバーを呼ばない）
- 1件選ぶと中央が更新される

出す項目：顧客名・顧客区分（法人／個人事業主）。**顧客 ID は出さない**（画面が狭く、名前で足りる。監査ログには入る）。

### 5.3 中央：Drive フォルダとファイル

顧客の `sourceFolderId` の直下フォルダ（＝カードフォルダ）を並べる。**再帰はしない** ── モックの木は1段である。

フォルダを選ぶと、その中のファイル一覧を出す。出す項目：

| 列 | 出どころ |
|---|---|
| ファイル名 | Drive（**接頭辞【処理中】【済】等を含めたまま**出す。状態が一目で分かる） |
| 更新日 | Drive の `modifiedTime` |
| サイズ | Drive の `size` |
| 状態 | 恒久ファイルインデックスの状態を日本語に（`menuFileStateLabel_`） |

**取り込み済みのファイルもグレーで出す。**隠すと「置いたはずのファイルが見えない」という問い合わせを生む。

### 5.4 右：要確認の表

選択中の顧客の未解決要確認を出す。**種別は `PARTNER` だけを表に出す** ── 表で「取引先を入力する」形に合うのは `PARTNER` だけである。他の種別（`DATE`・`AMOUNT`・`ZERO_AMOUNT`・`PRIOR_YEAR`・**`INTEGRITY`**・ファイル単位）は件数だけを出し、「メニューから確定してください」と案内する（**K-W2**。第2段で表に統合する）。

| 列 | 出どころ | 備考 |
|---|---|---|
| 利用日 | `getTransaction` の `planned.b` | **要確認行は持っていない**（`spec_menu_operations.md` §7.4 の表）。表示のために取引を読む |
| 金額 | 同 `planned.m` | 同上 |
| 摘要（元店名） | 要確認行の `merchantOriginal` | `PARTNER` では取込側が書く |
| 推測候補 | 要確認行の `candidates` の `partnerName` | **`candidates` は配列ではなく JSON 文字列である**（`50_ReviewStore.gs` 67・172 行。実データで `"[]"`、型は string）。そのまま `.map()` すると落ちる。**既存の `menuReviewCandidates_`（`96_Menu.gs` 1133〜1140 行）を使う** ── `jsonCell_` で `try/catch` の中で解析している。空なら `—` |
| 取引先 | **入力欄**（テキスト） | 候補があれば選択肢も出す |
| 元ファイル | 要確認行の `fileId` から引いたファイル名 | **`decisions` は1回の呼出しにつき1ファイル分**（§3.3）なので、利用者がどれを1回で送れるか判るように**必ず出す。**画面が混在させておいて「1ファイルに絞れ」とだけ言うのは、利用者に区別する材料を与えていない |
| （非表示） | `fileId` | 送信の単位。クライアントは同じ `fileId` の行だけをまとめて送る |

**ファイル名は `menuDisplayFileName_`（`96_Menu.gs`）と同じ出どころにする。**`96_Menu.gs` は変更しないので**同じ処理を `80_WebApp.gs` に書く**ことになるが、**取り違えの避け方は写す**：ファイル名が取れないときは `（ファイル名不明）` と出し、空文字のまま出さない。

**識別子は店名だけにしない。**同じ店名の明細が同じファイルに 2 行あるとき、店名だけでは利用者がどちらに何を入れたか判らない。`spec_menu_operations.md` §7.4 の識別規則と同じく、**元店名・ファイル名・元ファイルの行番号（`sourceRow`）**を並べる。`sourceRow` は要確認行が持っている。

**取引を読む往復の扱い**：15 件表示なら 15×4＝60 往復（単価 1.6 秒で 96 秒）。**1回の呼出しで表示できるのは 15 件まで**とし、それを超える分は「他 m 件」と出す（§7.4 の上限と同じ考え方）。

---

## 6. 共通の規律

### 6.1 エラーの見せ方

サーバー関数は例外を投げてよい。クライアントは `withFailureHandler` で受け、**`classifyMenuError_`（`96_Menu.gs` 1551 行）が作る日本語**を出す。

**分類はサーバー側で行う** ── `withFailureHandler` が受け取る例外は `message` しか残らない（`google.script.run` は例外オブジェクトを構造化して渡さない）。`80_WebApp.gs` の各サーバー関数は本体を `try` で囲み、例外を `classifyMenuError_(error)` へ渡し、戻り値 `{title, lines}` の **`lines` を改行で連結した文字列**を `message` に持つ新しい `Error` を投げ直す。クライアントはその `message` をそのまま出す。

`classifyMenuError_` が `rethrow: true` を返す枝（1595〜1597 行、`Cannot call SpreadsheetApp.getUi`）は `lines` が空である。Web アプリでは起き得ないが、**空なら画面が無言になる**ので、空のときは元の例外の `message` の前に `想定していないエラーです: ` を付けて投げ直す。

**リース衝突の文言は `classifyMenuError_` 1557〜1558 行が正本である。**付録B のリース衝突の行はその要約であり、画面へ出すのは `classifyMenuError_` が返した本文のほうである（同じ事象の正本を2つにしない）。

**英文の例外本文をそのまま画面に出してはならない。**

### 6.2 押下を止めない失敗

要確認をまとめて確定するとき、1件の失敗で全体を止めない（既存 §6.6 と同じ）。結果に「エラー: n 件」として並べる。

### 6.3 進捗

`runImport` と一括確定は複数回の呼出しに分かれ得る。クライアントは：

- 呼出し中はボタンを無効化し、「処理中… {done}/{total}」を出す
- 1回の呼出しが返ったら、残りがあれば自動で次を呼ぶ
- **利用者が画面を閉じたら止まる。**途中まで書かれた分は残る（帳簿としては整合している ── 既存の設計どおり、1件ずつ確定して後始末する）

---

## 7. 手順

### 7.1 顧客を選ぶ

サーバー関数 `webAppBootstrap_()` が返すもの：

```
{actor, isOwner, customers: [{customerId, customerName, category}], version}
```

`filterByScope_` を通した顧客だけを返す。往復：認可 2＋顧客一覧 2 ＝ 4。

### 7.2 カードフォルダとファイルを取る

`webAppListFolder_(customerId, folderId)`

- `folderId` が空なら顧客の `sourceFolderId` の直下フォルダを返す
- `folderId` があればその中のファイルを返す

**`customerId` はサーバーで検証する** ── `filterByScope_` に通らない顧客 ID が来たら `AuthorizationError` を投げる。

**`folderId` もサーバーで検証する** ── 顧客の `sourceFolderId` の子孫でなければ投げる。クライアントの値をそのまま Drive へ渡さない。

### 7.3 記帳を実行する

`webAppRunImport_(customerId, folderId, options)`

1. 認可（§4.4）
2. `options.destinationSpreadsheetId` が空なら**転記シートを新規作成する**（§8）。空でなければ §7.3.2 の検証を通してから使う
3. 選ばれたフォルダ直下のファイル ID を自分で集め、`runImport({customerIds, fileIds, maxFilesPerCustomer: 1, destinationSpreadsheetId})` を呼ぶ
4. 戻り値 `{done, total, remaining, destinationSpreadsheetId, fileResults}`
5. `remaining > 0` ならクライアントが再度呼ぶ

#### 7.3.1 `71_RunOrchestrator.gs` に差し替え口を1つ足す

`runImport(options)` は `opts.customerIds`・`opts.fileIds`・`opts.maxFilesPerCustomer`・`opts.now` しか受け取らず（`71` 129・189・194・187 行）、`customer` は `getAuthorizedCustomers(user)` が返したもの（128 行）がそのまま `customers.forEach`（166 行）を通って 208 行の `processDiscoveredFile_(runId, customer, candidate, opts)` へ渡る。**取込の呼出し側は `71` の中にあり、外から差し替える口が無い。**§8.4 の「呼出し側で差し替えるだけでよい」はこの口があって初めて成立する。

`71_RunOrchestrator.gs` **208 行だけ**を次の形にする：

```js
var writeCustomer = opts.destinationSpreadsheetId ?
  Object.assign({}, customer,
    {destinationSpreadsheetId: String(opts.destinationSpreadsheetId)}) : customer;
var fileOutcome = processDiscoveredFile_(runId, writeCustomer, candidate, opts);
```

**差し替えを 208 行に置き、166 行に置かないのは意図的である。**174 行の `buildIndex(customer, {})`（事前整合性チェック）は 166 行と 208 行の間にあり、§8.7 はこれを「雛形の1枚だけを見る」ままにすると決めた。166 行で差し替えると整合性チェックが新品の空シートを見ることになり、その決定が無言で覆る。

`destinationSheetName` は差し替えない ── 新しいシートは雛形の複製なのでシート名は同じである（§8.2）。

**`opts.destinationSpreadsheetId` を渡さない既存の呼出し（定期取込・`ops*`・950 テスト）は `writeCustomer === customer` となり、挙動が1つも変わらない。**

#### 7.3.2 `options.destinationSpreadsheetId` をサーバーで検証する

この値もクライアントから来る。検証せずに使うと `43_SheetWriter.gs` 257・280・304・372 行と `45_DestinationIndex.gs` 37・129 行へそのまま渡り、**オーナーがアクセスできる任意のスプレッドシートへ書き込める**。`executeAs: USER_DEPLOYING` はサーバーにオーナーの全権限を与えるので、`access: MYSELF` はこの誤りを防がない。

次をすべて満たさなければ `AuthorizationError` を投げる：

1. 顧客マスター F列（`customer.destinationSpreadsheetId`）**と一致しない**こと（雛形へ直接書かせない）
2. 親フォルダが雛形の親フォルダと同一であること（§8.3）
3. ファイル名が `{その顧客の customerName}_` で始まり、残りが `YYYYMMDD-HHmm` の形であること（§8.3）
4. `customer.destinationSheetName` のシートが存在すること

**検証は認可（手順 1）の直後、転記シートの決定（手順 2）の前に行う。**書込の直前まで遅らせると、検証を通らない ID でリースを取ってしまう。

#### 7.3.3 取込はフォルダで絞る

`scanUnprocessedFiles(customerId, options)`（`10_DriveScanner.gs` 118 行）は `options` に `{now}` しか受け取らず、`listFilesRecursively_(customer.sourceFolderId)`（129 行）で**顧客のソースフォルダ全体を再帰的に**走査する。`folderId` で絞る口は無い。したがって選ばれたフォルダ直下のファイル ID を自分で集め、`opts.fileIds` に入れて呼ぶ（`71` 189〜193 行がその配列で候補を絞る）。**渡さないと、画面に出していないカードB・カードC のファイルまで同じ新しい転記シートへ混ざる。**

**画面の一覧と取込の候補は同じ集合ではない。**`scanUnprocessedFiles` は 122・135〜136 行で「最終更新から 10 分以上経過」したファイルだけを候補にする。§5.3 の一覧は Drive をそのまま出すので、**置いたばかりのファイルは一覧に見えるのに記帳されない。**§5.3 の「状態」列で、恒久ファイルインデックスに未登録かつ更新から 10 分未満のものは `取込待ち（あと n 分）` と出す。理由を出さずに `fileResults` が空で返ると、利用者には「押しても何も起きない」としか見えない。

#### 7.3.4 オーナーでも記帳できない顧客がある

`runImport` は `getAuthorizedCustomers(user)`（`71` 128 行 → `02_CustomerMaster.gs` 168〜173 行）で顧客を絞る。これは顧客マスター Q列・R列だけを見て、**`authorize` と違いオーナーを特権化しない**（レビューでハーネス実測：オーナーで `authorize` は `isOwner: true` ＋全顧客を返すのに、`runImport` は `stoppedBy: 'NO_AUTHORIZED_CUSTOMER'`）。

§5.2 の左カラムには全顧客が出るのに、**Q/R列にオーナーが居ない顧客は「記帳を実行」が何も起きずに終わる。**画面が出す選択肢を書込側が裏打ちできていない。

**左カラムの顧客のうち `getAuthorizedCustomers` に含まれないものは、選べるが「記帳を実行」を無効表示にし、`この顧客はあなたが担当者として登録されていません（顧客マスター Q列・R列）。` と出す。**隠さないのは、登録漏れに気づけるようにするためである。

### 7.4 要確認を確定する

`webAppResolveReviews_(customerId, decisions, options)`

`decisions` は `[{reviewId, partnerName}]`。空の `partnerName` は `RESOLVE_WITHOUT_PARTNER`、空でなければ `ADOPT_EXISTING_PARTNER` とする。

**押す前に確認を出す（§2.4 原理 1）。**確定は転記先へ書き、辞書へ登録し、取引を `COMMITTED` へ進める ── **画面から取り消す手段は無い**（辞書の取り消しは `rollbackDictionary` で管理者だけ、転記の取り消しは `CANCEL_FILE` でファイル単位）。したがってクライアントは、送る前に**その押下で書く件を1件ずつ並べた確認**を出す：

```
次の 3 件を確定します。取り消せません。

  ローソン / 202601.xlsx 12 行目 → 株式会社ローソン（辞書に登録します）
  同じ店   / 202601.xlsx 15 行目 → 甲社（辞書に登録しません：同じ店名に別の取引先名が入っています）
  （店名なし） / 202601.xlsx 18 行目 → 乙社（辞書に登録しません：店名が空です）
```

**「辞書に登録するかどうか」を1件ずつ出す。**§7.4.2 の判定は利用者からは見えず、しかも**登録すると次の取込から要確認が立たなくなる** ── 帳簿より先に、判断の機会そのものが失われる。件数だけを出す確認（「3 件を確定します」）では原理 1 を満たさない。

**この確認はクライアントで出す。**`ui.alert` は Web アプリでは使えず、使えたとしてもサーバー実行を止めて 6 分を食う（`spec_menu_operations.md` が実機で当てた失敗）。

**確認はサーバーの認可の代わりにならない**（§2.4 原理 2）。画面に出した件と送られてくる `decisions` が同じである保証は無いので、§7.4.1 の検証は確認の有無と無関係に必ず通す。

**`applyResolveDecision_`（`96_Menu.gs` 777 行）を呼んではならない。**理由は2つ。

1. **転記先を差し替えられない。**同関数は 792 行で自ら `var customer = getCustomerById(item.customerId);` を呼び、854 行で作る `input` に `customer` を載せず、879〜880 行で `resolveReview(review.reviewId, code, input)` を呼ぶ。§8.7 で足す差し替え口に値が届かず、**雛形に書き込む** ── §2.4 原理 4 の破壊そのものである。§10 は `96_Menu.gs` を変更しないと決めているので、この経路は直らない。
2. **形が合わない。**`applyResolveDecision_(item, code, inputs, options)` は**1つの `code` と1つの `inputs.partnerName`** を同じ店名のグループ全体へ適用する部品である（855 行）。`decisions` は件ごとに取引先名も操作コードも違う。

代わりに `80_WebApp.gs` に自前のループを置き、次を守る。

- **予算判定は `spec_menu_operations.md` §6.4 の式をそのまま写す。**1件を始める前に `elapsed + WEBAPP_ITEM_TRIPS_ × WEBAPP_TRIP_WORST_MS_ + WEBAPP_CLEANUP_TRIPS_ × ファイル数 × WEBAPP_TRIP_WORST_MS_ <= WEBAPP_DEADLINE_MS_` を確かめ、満たさなければその件を始めない。**ファイル数は `new Set(...)` で数え、1 に固定してはならない**（§3.3）
- 件ごとに §7.4.1 の検証を通す
- 件ごとに §8.5 の `writeCustomer` を作って `resolveReview` へ渡す
- **件ごとに §7.4.2 の `input.learn` を決める**
- **件ごとに §7.4.3 の取引状態を確かめる**
- 1件の失敗で全体を止めず `errors` に積む（§6.2）
- 後始末（`commitSettledTransactions_`・`completeFileIfFullyResolved_`）は「1件でも書込を試みたファイル」だけに行い、予算判定を掛けない

戻り値は `{resolved, committed, unmet, completedFiles, rewoundFiles, deferredCommits, skippedByLease, notAttempted, errors, maxPerCall, remaining}`。前 10 鍵は `applyResolveDecision_` と同じ意味・同じ名前にする（`maxPerAction` だけ `maxPerCall` と呼ぶ）。**`remaining` は `notAttempted` と等しくなければならない** ── 別々に数えると、予算判定が止めた件をクライアントが「処理済み」と見なして飛ばす。恒等式は `decisions.length ＝ resolved ＋（`reviewId` を持つ `errors` の数）＋ skippedByLease ＋ remaining` である。**`errors.length` をそのまま使ってはならない** ── `errors` には件ごとの失敗（`{reviewId, code, message}`）とファイル単位の後始末の失敗（`{fileId, code, message}`）の2種類が混ざる。後者には対応する `decisions` の要素が無いので、後始末が1件失敗しただけで恒等式が破れる。`applyResolveDecision_` は既にこの形で、件ごとは `96_Menu.gs` 895〜896 行、後始末は 908・917・923 行が積む。

#### 7.4.1 `reviewId` はサーバーで検証する

`decisions[].reviewId` はクライアントから来る。`getReviewById(reviewId)` で読み、**`review.customerId` が引数の `customerId` と一致しなければ拒否する。**一致を確かめずに `resolveReview` へ渡すと、認可は「利用者が申告した `customerId`」に対して通り、書込は「その要確認が本当に属する別の顧客」の帳簿に起きる ── 認可を1件ぶん迂回できる。

**手順は2段で、順序を入れ替えても、片方を省いてもならない。**

1. **件ごとに `authorizeOperation(code, review.customerId, {})` を呼ぶ。**自前で `AuthorizationError` を投げてはならない ── `denyAuthorization_`（`03_Authorization.gs` 273〜298 行）を通らないと `PERMISSION` の監査ログが1行も残らない。担当外の顧客に属する `reviewId` はここで落ちる。
2. **そのうえで `String(review.customerId) !== String(customerId)` なら、`resolveReview` を呼ばずにその件を `errors` へ積む**（`{reviewId, code: 'REVIEW_CUSTOMER_MISMATCH', message: 付録B}`）。

**2 を省いてはならない。**`authorizeOperation`（`03_Authorization.gs` 189〜195 行）は `requiredRoleForOperation_` で役割を決めて `authorize(requiredRole, customerId, …)` に委ねるだけで、**2 つの `customerId` が同じかどうかを一度も見ない**。`access: MYSELF` の第1段では実行者は常にオーナーであり、`authorize` は 85〜86・103〜107 行でオーナーに全アクティブ顧客の役割を与えるので、**手順 1 だけでは他顧客の `reviewId` が素通りする。**通すと、認可・監査ログ・1ファイル制限・後始末はすべて申告された `customerId` を基準に動くのに、**書込だけが別の顧客の帳簿に起きる。**

**`decisions` は1回の呼出しにつき1ファイル分に限る**（§3.3）。クライアントがファイルごとに分けて送り、残りは `remaining` で返す。

#### 7.4.2 `input.learn` は必ず明示する

**`input.learn` を渡さないと辞書に登録される。**`adoptExistingPartner_`（`51_ReviewResolution.gs` 143 行）は `if (input.learn !== false)` なので、**未指定は「学習する」である**（2026-09-15 ハーネス実測：`learn` 未指定・`learn: true` はいずれも 60 往復で辞書が1行増え、`learn: false` は 57 往復で増えない）。

**`applyResolveDecision_` を写さないということは、同関数が持っていた 3 つの抑制も一緒に失うということである。**Web アプリは店名でグループ化しないので、条件はメニューより悪い。次の順に判定し、**1つでも当たれば `input.learn = false`**、どれにも当たらなければ `input.learn = true` とする。

1. **`normalizeMerchant(review.merchantOriginal)` が空**なら学習しない。
   **空店名で学習すると、以後その顧客の空店名取引がすべて自動確定される。**ハーネス実測：空店名の辞書行を1つ置くと、店名が空の取引に `matchPartner` が `autoConfirm: true` ＋ `matchedBy: 'STEP1'` を返す ── **要確認が立たず、誰にも見えないまま毎回その取引先名が入る。**`70_ImportFlow.gs` 98 行は `merchantOriginal` に `null` を書き得るので、空店名の要確認は実在する（メニューでも同じ材料が空店名グループの欠陥を生んだ）。
2. **`isCardNamePartnerPurpose(customer, tx.planned.i)` が真**なら学習しない（`02_CustomerMaster.gs` 93 行。顧客マスター AN列）。その用途の取引先はカード名で決まるので、店名→取引先の対応を覚えると次から誤った取引先が入る。`applyResolveDecision_` 871 行と同じ判定である。
3. **同じ押下の中に、同じ `merchantNormalized` を持つ別の `decision` があり、`partnerName` が違う**なら、**その店名のどの件も学習しない**。
   利用者が同じ元店名に 2 つの取引先名を入れたということは、その店名は一意に決まらないという申告である。**片方だけ学習すると、次の取込からその店名が黙って片方の取引先に自動確定され、要確認すら立たない。**両方学習しても辞書が壊れるわけではない（ハーネス実測：`partnerNames.length === 1` でなくなるので `autoConfirm` が落ち、以後この店名は毎回要確認になる ── `33_MerchantMatcher.gs` 229 行）が、**その店名は二度と自動解決されなくなる。**どちらも黙って起きるので、学習しないのが正しい。
   `partnerName` が同じなら 1 件目だけ学習し、2 件目以降は `false` にする（同じ行を2つ書いても上と同じ劣化を招く。`detectDictionaryConflicts` は `src/` のどこからも呼ばれていないので、誰も掃除しない）。

**メニューの「1押下1学習」（`96_Menu.gs` 869〜874 行の `learned` フラグ）は写さない。**あちらは同じ店名のグループに1つの取引先名を当てる部品なので 1 回で足りる。Web アプリの `decisions` は件ごとに店名も取引先名も違うので、**1件目だけ学習すると 2 件目以降の店名が永久に覚えられない。**上の 1〜3 に当たらない件は、すべて学習する。

#### 7.4.3 取引の状態を件ごとに確かめる

**`ADOPT_EXISTING_PARTNER` の前に `getTransaction(review.fullTxId)` を呼び、`transactionStatus` が `REVIEW_REQUIRED` か `COMMITTED` でなければその件を `errors` へ積んで飛ばす。**`96_Menu.gs` 860〜868 行と同じ判定で、同じ理由である ── 取り消し済み・除外済みの取引に取引先名を当てると、**帳簿に居ない取引の行に書き込む（幽霊行）。**メニューはこの欠陥で一度本番に出た（`spec_menu_operations.md` の H-1 と混在グループの修正）。

この `getTransaction` は §7.4.2 の判定 2 が必要とする `tx.planned.i` も供給するので、**1件につき 1 回でよい**（4 往復。`WEBAPP_ITEM_TRIPS_` に算入する）。§5.4 の表を描くときの `getTransaction` は別のサーバー呼出しなので、使い回せない。

### 7.5 Excel をダウンロードする

§9。

---

## 8. 転記シートの新規作成

### 8.1 決定

**「記帳を実行」を押すたびに、転記シートを1枚新しく作る。**

雛形は**顧客マスターの転記先スプレッドシート**（F列 `destinationSpreadsheetId`）である。これを Drive で複製し、`入力用シート` の中身を空にする。

理由：
- `取込用` タブは `入力用シート` を参照する数式を持つ。**複製すれば数式も列の並びもそのまま残る**
- 列構成の定義を新しく書かずに済む（`spec_menu_operations.md` で4度出た「仕様書が実データに無い形を要求する」欠陥を避ける）

### 8.2 手順

1. `DriveApp.getFileById(customer.destinationSpreadsheetId).makeCopy(name, folder)`
2. 複製の **`customer.destinationSheetName` のシート**（`入力用シート` と決め打ちしない ── 顧客マスター H列の設定値である。`02_CustomerMaster.gs` 23 行。`src/*.gs` にこのリテラルは `97_Ops.gs` 260 行のテスト顧客登録にしか無い）について、**システムが所有する 6 列だけを消す** ── `customer.columnMapping` の `B`・`F`・`I`・`K`・`M`・`txId` を、`customer.headerRow`（顧客マスター AD列。`02` 32 行。**1 とは限らない**）の次の行から最終行まで `clearContent()` する。
3. **行全体を消してはならない。値を列ごと全部消してもならない。** ── それ以外の列には**勘定科目の既定値と消費税・残高の数式**が入っている（`43_SheetWriter.gs` 90〜103 行のコメント、`02_CustomerMaster.gs` 37〜39 行の AL列が存在する理由）。消すと 2 つ壊れる：(a) 転記された行に勘定科目も消費税も入らないまま freee へ渡る。(b) `45_DestinationIndex.gs` 143〜147 行は行を増やすときの複製元を「**数式を持つ空き行**」から選ぶので、数式が全滅すると `templateHint` が `null` になり `expandTemplateRows` が `sheet.getMaxRows()` へ落ちる ── そこは `43_SheetWriter.gs` 110〜114 行が「書式も数式も無い空行を複製してしまい、勘定科目の既定値・消費税式が新しい行に入らない ── **この関数が存在する理由そのものが満たされない**」と明示的に禁じた複製元である。
   **`validateDestinationSchema` はこの誤りを検出しない** ── 項目5（必要数式）は「既存データ行が 0 行なら合格」である（`42_SheetSchemaValidator.gs` 111〜117 行）。空にしたシートは検証を素通りする。
   既存の `clearTemplateValueCells`（`43` 82〜89 行）が同じ 6 列を同じ理由で消しているので、**それに揃える**。
4. `取込用` タブには**触らない**（数式が入っている）
5. 作った ID を戻り値で返し、以降の書込に使う

**雛形を複製すると `取引先一覧` タブも複製される。**`knownPartnerNames_`（`97_Ops.gs` 818〜823 行）は `customer.destinationSpreadsheetId` からこのタブを読む。差し替えた `customer` を渡すと**押下ごとの写しを読む**ようになり、会計事務所が元の本に足した取引先が反映されない。

**したがって `partnerListSheetName` の参照元は雛形のまま据え置く** ── 差し替えるのは `destinationSpreadsheetId` だけで、取引先一覧を読むときは `getCustomerById` が返す元の `customer` を使う。§5.4 の推測候補と §7.4 の取引先入力はこちらを見る。

**複製の直後に `validateDestinationSchema(newCustomer, buildIndex(newCustomer, {}))`（`42_SheetSchemaValidator.gs` 43 行）を通し、問題があれば書込を始めずにその内容を返して止める。**取込も同じ検証を `71_RunOrchestrator.gs` 425 行で行うが、そこで落ちるとファイルが `FAILED` になった後である。複製が壊れていることは複製した側で分かる。

### 8.3 名前と置き場所

- 名前：`{顧客名}_{YYYYMMDD-HHmm}`（例 `つばめオフィス株式会社_20261015-1432`）
- 置き場所：顧客マスターの転記先スプレッドシートと**同じフォルダ**

**K-W3**：置き場所を顧客マスターに列で持たせるべきかは未決。いまは雛形と同じ場所に置く。

### 8.4 取込の書込 ── 差し替えた `customer` を渡すだけでよい（調査済み）

`customer` は `processDiscoveredFile_`（`71_RunOrchestrator.gs` 228 行）から末端まで**引数で渡っている**。`70_ImportFlow.gs` の `runWriteBlock` が `input.customer` を受け、`reserveDestinationRows`（248 行）・`applyPlainTextFormat`（283 行）・`writeTransactionRows`（285 行）・`verifyWrittenValues`（290 行）・`clearTransactionRows`（325 行）・`releaseReservedRows`（329 行）のすべてに渡す。

したがって **`43_SheetWriter.gs` も `45_DestinationIndex.gs` も書き換えない。**呼出し側で差し替えるだけでよい：

```js
var writeCustomer = Object.assign({}, customer,
  {destinationSpreadsheetId: newSpreadsheetId});
```

### 8.5 要確認の確定 ── ここは差し替え口が無い。足す（本仕様で最も重い変更）

取込と違い、**要確認を確定する経路は `customer` を引数で受け取らず、自分で `getCustomerById` を呼ぶ**：

| ファイル | 行 | 操作 |
|---|---|---|
| `51_ReviewResolution.gs` | 123 | `ADOPT_EXISTING_PARTNER`（転記先 F列を書く） |
| `51_ReviewResolution.gs` | 162 | `FIX_DATE_AMOUNT`（B列・M列を書く） |
| `51_ReviewResolution.gs` | 266 | `EXCLUDE`／`EXCLUDE_PRIOR_YEAR`（行を空にする） |
| `52_FileResolution.gs` | 209・270・327・398 | ファイル単位の解決 |

`getCustomerById` は顧客マスター F列＝**雛形**を返すので、§2.4 原理 4 の破壊が起きる。

**方針 ── 第3引数の `customer` を見る差し替え口を足す。**`54_IntegrityResolution.gs` 39・85・150 行に**同じ形の前例がある**（あちらは第3引数の名前が `options`）：

```js
var customer = options.customer || getCustomerById(tx.customerId);
```

`51`・`52` の該当箇所を同じ形にする。**ただし `51`・`52` の第3引数の名前は `input` なので、書くのは `input.customer || getCustomerById(...)` である**（`51_ReviewResolution.gs` 42・119・156・251 行、`52_FileResolution.gs` 312 行がいずれも `input` と名付けている）。**`||` の左が空なら右が使われるので、第3引数に `customer` を載せない既存の呼出しは何も変わらない**（950 テストは載せていない）。

**Web アプリ側は、取引ログから正しい転記先を引いて渡す**：

```js
// 転記先は要確認行が持っている（M列・N列）。取引ログ AC・AD列は空なので使わない。
var writeCustomer = Object.assign({}, getCustomerById(review.customerId),
  {destinationSpreadsheetId: review.destinationSpreadsheetId,
   destinationSheetName: review.destinationSheetName});
resolveReview(reviewId, code, Object.assign({}, input, {customer: writeCustomer}));
```

> **`customer` は `resolveReview` の第3引数 `input` に載せる。第4引数を足してはならない。**`resolveReview(reviewId, operation, input)`（`51_ReviewResolution.gs` 42 行）は第4引数を受け取らず、60・67 行以下のディスパッチにも転送しないので、第4引数として渡した `{customer: …}` は**静かに捨てられ、差し替えが一度も効かない**。`51` の 123・162・266 行が読むのも同じ `input` である。署名を変えないので §8.8 の「ロジックは1つも変えない」が成立する。
>
> `54_IntegrityResolution.gs` 39・85・150 行が `options.customer` と書いているのは、あちらの**第3引数の名前が `options`** だからであって、引数の位置は同じ第3引数である。**「`options` という名前」ではなく「第3引数」に揃える。**
>
> **`getTransaction` を呼んではならない。**要確認行の M列・N列で足りる。呼ぶと1件あたり 4 往復増え、その 4 往復は §3.3 の見積にも入っていない。

**ファイル単位の操作（`52`）も同じ扱いにする。**`CANCEL_FILE` は `cancelTransactions`（`53_CancelRestoreManager.gs` 32・75 行）を通って**転記行を実際に消す**ので、口を揃えるのは将来のためではなく必須である。`KEEP_ORIGINAL_RESULT` 等の `moveFile_` 系は転記行を触らないが、同じ形に揃えて正本を2つにしない。

### 8.6 `buildIndex` も同じ問題を持つ（調査済み）

`buildIndex(customer, options)`（`45_DestinationIndex.gs` 35〜37 行）は `customer.destinationSpreadsheetId` を開く。その索引を**整合性チェックと取消しが使う**：

| 呼出し | `customer` の出どころ | 転記先が複数だと |
|---|---|---|
| `71_RunOrchestrator.gs` 174 | 取込の `customers.forEach` | **整合性チェックが1枚しか見ない** |
| `52_FileResolution.gs` 406 | `getCustomerById`（＝雛形） | **取消しが1行も消せない** ── `cancelTransactions` は行番号でなく**取引IDで索引を引く**（`53_CancelRestoreManager.gs` 65 行・`45_DestinationIndex.gs` 68〜72 行）。雛形の索引に無い取引は `matchCount === 0` で `clearTransactionRows` が呼ばれず、**取引だけ `CANCELED` になって転記行がシートA に残る**。読取確認（`53` 92〜105 行）も対象 0 件で素通りする |
| `54_IntegrityResolution.gs` 274 | `getCustomerById` | 同 |
| `45_DestinationIndex.gs` 124・150 | 行予約の内部。取込時の `customer` を引き継ぐ | 安全（差し替えた `customer` が届く） |
| `71_RunOrchestrator.gs` 425 | `processDiscoveredFile_` 内の転記先構成検証 | 安全（`customer` が引数。§7.3.1 の差し替えが届く） |
| `97_Ops.gs` 772 | `opsRecoverStuckFiles`。**定期取込 tick の先頭で自動実行** | **危険。**§8.7 の但し書きのとおり、第1段では定期取込を止める |
| `97_Ops.gs` 1121 | `opsReprocessFile` → `cancelTransactions` | 雛形の索引で取り消すので下の `52` 406 と同型。手動実行なので第1段では運用で避ける |

`52` 406 の `cancelFileFromReview_` は §2.4 原理 4 の破壊そのものである ── シートA の取引を取り消すつもりで、**シートB の同じ行番号を消す**。

### 8.7 決定 ── 書込経路だけ直し、整合性チェックは当面1枚のままにする

**直すもの（帳簿を壊す経路）**：

| ファイル | 変更 | 箇所 |
|---|---|---|
| `51_ReviewResolution.gs` | `input.customer \|\| getCustomerById(...)` | 123・162・266 |
| `52_FileResolution.gs` | 同、および `buildIndex` へ渡す `customer` を揃える | 209・270・327・398・406 |
| `54_IntegrityResolution.gs` | `buildIndex(customer2)` の `customer2` を揃える（`options.customer` は既にある） | 274 |

**直さないもの（見張りの網）**：

`71_RunOrchestrator.gs` 174 の整合性チェックは**雛形の1枚だけを見る**ままにする。

**理由 ── 壊す経路と、壊れていないか見張る経路を分ける。**前者を直さなければ帳簿が壊れる。後者を1枚のままにすると、2回目の押下から**1回目の全取引に `DESTINATION_ROW_MISSING` が立つ**（`44_IntegrityChecker.gs` 35〜46 行。severity は REVIEW なので実行は止まらないが報告は毎回埋まる）。これは受容するが、**「気づけない」ではなく「鳴り続けて信用されなくなる」**である。

**ただし `97_Ops.gs` 770〜773 行の `opsRecoverStuckFiles` は別で、これは受容できない。**定期取込 tick の先頭で自動的に走り、雛形の索引を `recoverPartialFailure` へ渡すので、Step 5（`43_SheetWriter.gs` 582〜605 行）が**新しいシートに転記済みの取引を雛形へ二重に書き、取引ログの行番号を差し替える**。**第1段では定期取込を止めてから Web アプリを使う**（`opsStopScheduledImport`）。`opsRecoverStuckFiles` に差し替え口を足すのは K-W10 として第2段で扱う。

「顧客ごとに1回」から「顧客 × 転記先ごとに1回」へ変えるのは構造の変更であり、950 テストで固めた取込フローに手を入れることになる。**同じ版で両方を変えない。****K-W9** として §14 に記録し、第2段で扱う。

### 8.8 変更後の検証

**ロジックは1つも変えない。**`||` を足し、`buildIndex` に渡す `customer` を揃えるだけである。

**変更後に必ず変異テストを回すこと** ── 次の変異を1つずつ入れて、テストが**赤になる**ことを確かめる。赤にならなければ、その差し替え口は無検証である。

| 変異 | 戻す先 |
|---|---|
| `51` の `input.customer` を無視 | `var customer = getCustomerById(review.customerId);` |
| `52` の `input.customer` を無視 | 209・270・398 は `var customer = getCustomerById(review.customerId);`、**327 だけは `var customer = getCustomerById(tx.customerId);`**（`UPDATE_PURPOSE` は `review` でなく `tx` から引く） |
| `52` 406 の `buildIndex` を雛形で作る | `index: buildIndex(getCustomerById(review.customerId))` |

### 8.9 転記先の正本がどこにあるか（K-W5 の決着の記録）

`61_TransactionLog.gs` は AC・AD・AE列の受け口を持つ（25・68 行）が、**取込経路は AE列（`destinationRow`）しか埋めない**。AC・AD列へ値を渡す呼出しは `src/` に無く（`settleWrittenTransactions` は `61` 291 行、`updateTransactionLocation` は `43` 380 行、どちらも 31 列目のみを書く）、取込後は常に空文字である（ハーネス実測）。

**転記先の正本は要確認シート M列・N列である。**`70_ImportFlow.gs` 348〜349 行が取込時の `customer` から書くので、§8.4 で `customer` を差し替えれば**自動的に新しいシートの ID が入る**。**転記先が複数になってもデータ構造は耐える。**

K-W5 で挙げた4つの決着（2026-09-15 調査済み。これ以上の確認は要らない）：

- `45_DestinationIndex.gs`（行予約）── **安全。**124・150 行の `buildIndex(customer)` は取込時の `customer` を引き継ぐ。
- `53_CancelRestoreManager.gs`（取消し・復元）── **安全。**`cancelTransactions(input)` は `input.customer` と `input.index` を引数で受け取り、`53` に `getCustomerById` の呼出しは1つも無い。§8.7 が `52_FileResolution.gs` 398・406 行を直せば正しい転記先が届く。
- `52_FileResolution.gs` の `CANCEL_FILE` ── **危険。**§8.7 で直す。
- `44_IntegrityChecker.gs`（整合性チェック）── **直さない。**索引を渡されるだけで自分では開かない。K-W9 として第2段へ（§8.7）。

---

## 9. Excel ダウンロード

### 9.1 決定

**転記シートをそのまま xlsx で書き出す。**列の詰め替えをしない。

理由：`入力用シート` → `取込用` の反映は雛形の数式が行う。freee が読むのは `取込用` であり、**そのスプレッドシートを xlsx にすれば両タブが入る**。

### 9.2 実装 ── サーバーは何もしない

`access: MYSELF` なので、**画面を開く人＝スプレッドシートの所有者**である。したがってブラウザが自分の資格で書き出し URL を直接開けばよい：

```js
window.open('https://docs.google.com/spreadsheets/d/' + id + '/export?format=xlsx', '_blank');
// 複数の Google アカウントにログインしていると既定アカウント（/u/0/）で解決され、
// 別アカウントでは権限エラーになる。開けなかったときの案内は付録B。
```

**`UrlFetchApp` も Base64 も `Blob` も要らない。**Apps Script のサンドボックスで `<a download>` が効くかという問題も生じない。

> サーバー関数 `webAppExportXlsx` は**不要**である。クライアントが `webAppRunImport` の戻り値 `destinationSpreadsheetId` をそのまま使う。
>
> ただし **K-W1 で担当者へ開くときは成り立たない** ── 担当者はそのスプレッドシートの閲覧権を持たないので、サーバーが取得して渡す形（元の設計）へ戻す必要がある。第2段で扱う。

### 9.3 何を出すか

**その押下で作った転記シートだけ**を出す。過去の分は出さない（取引一覧の画面が要る。§2.2 の非範囲）。

---

## 10. 既存コードへの変更

| ファイル | 変更 | 理由 |
|---|---|---|
| `appsscript.json` | `webapp` を足す | §4.2 |
| 新設 `80_WebApp.gs` | `doGet` とサーバー関数 | 本仕様の本体 |
| 新設 `81_WebAppUi.html` | 画面 | 同上 |
| `96_Menu.gs` | **変更しない** | 既存メニューは残す（§2.3） |
| `51_ReviewResolution.gs` | `input.customer` の差し替え口（3 箇所） | §8.7 |
| `52_FileResolution.gs` | 同（4 箇所）＋ `buildIndex` へ渡す `customer`（1 箇所） | §8.7 |
| `54_IntegrityResolution.gs` | `buildIndex(customer2)` を揃える（1 箇所） | §8.7 |
| `71_RunOrchestrator.gs` | 208 行に `opts.destinationSpreadsheetId` による `customer` の差し替えを足す（1 箇所）。**174 行には触らない** | §7.3.1 |
| `43`・`44`・`45`・`70` | **変更しない** | §8.4 のとおり `customer` が引数で届く |

**触らない**：`00`〜`06`・`11`・`50`・`53`・`60`・`61`・`70`・`95`・`96`・`97`・`98`・`99`

> **`71_RunOrchestrator.gs` に触れるのは 208 行の1行だけである**（§7.3.1）。`opts.destinationSpreadsheetId` があるときに `customer` を差し替える口を足す。**174 行の `buildIndex(customer, {})`（事前整合性チェック）には触らない** ── 整合性チェックを転記先ごとに回す変更は構造的であり、同じ版で書込経路の変更と混ぜない（§8.7・K-W9）。差し替えを 208 行に置き 166 行に置かない理由は §7.3.1 に書いた。

---

## 11. 実装の形

### 11.1 ファイル

- `src/80_WebApp.gs` ── `doGet` と `google.script.run` から呼ばれるサーバー関数
- `src/81_WebAppUi.html` ── 画面（HTML・CSS・JS を1ファイルに収める）

**`80_WebApp.gs` のトップレベルはリテラルの `var` と関数宣言だけ。**（既存 §11.4 と同じ）

### 11.2 サーバー関数

| 関数 | 公開 | 書込 | 内容 |
|---|---|---|---|
| `doGet(e)` | 公開 | 読取 | `81_WebAppUi.html` を返す |
| `webAppBootstrap_()` | `google.script.run` | 読取 | §7.1 |
| `webAppListFolder_(customerId, folderId)` | 同 | 読取 | §7.2 |
| `webAppListReviews_(customerId, limit)` | 同 | 読取 | §5.4 |
| `webAppRunImport_(customerId, folderId, options)` | 同 | **書込** | §7.3 |
| `webAppResolveReviews_(customerId, decisions, options)` | 同 | **書込** | §7.4 |

**`google.script.run` から呼べる関数は末尾に `_` を付けられない**（Apps Script の制約）。上の `_` は設計上の印であり、**実装では `webAppBootstrap` のように `_` を外すこと**。

> これは本仕様が既存の命名規律（内部関数は末尾 `_`）と衝突する唯一の箇所である。`80_WebApp.gs` の公開関数だけ例外とし、ファイル先頭にその旨をコメントで書く。

### 11.3 定数

```js
var WEBAPP_MAX_PER_CALL_ = 1;          // 1回の呼出しで確定する要確認の上限（計測段階。§3.3 の検算による）
var WEBAPP_ITEM_TRIPS_ = 64;           // 要確認1件の最悪往復（resolveReview 60 ＋ getTransaction 4。§3.2）
var WEBAPP_CLEANUP_TRIPS_ = 62;        // 後始末の最悪往復。1ファイルあたり。ファイル数を掛ける
var WEBAPP_REVIEW_LIST_LIMIT_ = 15;    // 要確認の表に出す件数
var WEBAPP_TRIP_WORST_MS_ = 1600;      // 往復単価の見積（計測段階）
var WEBAPP_DEADLINE_MS_ = 300000;      // 1回の呼出しの締切
```

段階で変わる 2 つ（`WEBAPP_MAX_PER_CALL_`・`WEBAPP_TRIP_WORST_MS_`）は、ファイル先頭のコメントに「受入で置き直す」と書く。

---

## 12. テスト

### 12.1 方針

- **サーバー関数は効果で検証する**：転記先の値、取引ログの状態、要確認の状態、監査ログの行、`batchUpdate` の回数
- **材料は `runImport` で立てる。**手製の要確認行を使わない（`spec_menu_operations.md` §12.3 冒頭と同じ理由 ── 実データでは出ない値を期待するテストになる）
- **HTML は単体テストしない。**サーバー関数の戻り値が画面に必要な値を持つことだけを固定する

### 12.2 ハーネス

既存の `test/gas-harness.js`・`test/gas-stubs.js` を使う。新設は `test/phase8-webapp.test.js`。

**`doGet` のテストには `HtmlService` のスタブが要る**（既存スタブは `createHtmlOutput` を持つ。488 行）。`createTemplateFromFile` を使うなら、スタブに足すこと。

**§8 の複製にはスタブの追加が要る。足りないものは 3 つある**（2026-09-15 に試作で実際に足して動かした）：

1. **`DriveApp.getFileById` がスプレッドシートを見つけられない。**既存スタブ（614〜615 行）は `files` Map だけを見るが、スプレッドシートは別の `spreadsheets` Map に居る。`files` に無ければ `spreadsheets` を見て、ファイル相当のハンドル（`getId`・`getName`・`setName`・`getParents`・`getMimeType`・`makeCopy`）を返す形に足す。
2. **`makeCopy` が無い。**`MemorySpreadsheet` を新しい ID で作り、**各シートの `values` と `formulas` の両方を複写する**。`formulas` を写さないと §8.2 の「6 列だけ消せば数式が残る」を確かめられず、**テストが通っても本番で数式が消える。**`protections`・`formats` も写す。第2引数の `folder` を受けたらその `folders` の `fileIds` に足す。
3. **`getParents` が無い。**`folders` を走査して当該 ID を `fileIds` に含むものを返す反復子にする。§7.3.2 の検証 2（親フォルダの一致）がこれを使う。

**スタブの追加は `src/` の差分ではないので受入 2 に影響しない**（受入 1 の既存テストは全件通ること）。

**`makeCopy` と `clearContent` はスタブの往復計数に入らない。**`resetRoundTrips` で測れるのは `getRange` 系だけなので、§3.3 の「複製ぶん約 10 往復」は**スタブでは確かめられない**。受入 11・12 の実機測定で置き直す（§13）。

### 12.3 ケース（初稿。監査で増やす）

1. `doGet` が HTML を返す
2. `webAppBootstrap` が `filterByScope_` を通った顧客だけを返す（非オーナーで他顧客が混ざらない）
3. `webAppListFolder` が顧客の `sourceFolderId` の子孫でない `folderId` を拒む
4. `webAppListFolder` がクライアント由来の `customerId` を検証する（担当外なら `AuthorizationError`、`permissionRows()` が1増える）
5. `webAppRunImport` が転記シートを**新規作成**し、複製先の `customer.destinationSheetName` のシートで、`customer.headerRow` の次の行から最終行まで **`columnMapping` の `B`・`F`・`I`・`K`・`M`・`txId` の 6 列だけが空**であり、**それ以外の列の値と数式は残っている**（§8.2）。`headerRow` を 1 以外にした顧客でも回す
5b. 同、複製先で `findEmptyRows(customer, 1, buildIndex(customer, {}))` が**1 行以上を返す** ── 6 列だけ消す設計は `customer.rowScanExcludedColumns`（顧客マスター AL列。`02_CustomerMaster.gs` 39 行）が勘定科目・消費税・残高の列を除外していて初めて成立する。`isDestinationRowEmpty`（`43_SheetWriter.gs` 20〜31 行）は `rowScanLastColumn` までの全列を見るので、AL列が未設定だと複製先の全行が「使用中」と判定され `expandTemplateRows` が空き行を増やせないまま繰り返す
5c. 同、**行の値を全部消した場合との対照**：全部消すと `expandTemplateRows` が `templateSourceRow = null` になって `sheet.getMaxRows()` へ落ち、転記行に勘定科目の既定値も数式も入らない。**それでも `validateDestinationSchema` は `ok: true` を返し、取込は `WRITTEN` を返す**（2026-09-15 ハーネス実測）── 誰も止めないので、このテストが唯一の検出点である
6. 同、`取込用` タブの数式が残っている
7. 同、2回目の呼出しは新規作成せず `options.destinationSpreadsheetId` を使う
8. 同、**要確認シート M列・N列**（`getReviewById(reviewId).destinationSpreadsheetId`・`.destinationSheetName`）が**新しいシートの ID とシート名**になっている（`70_ImportFlow.gs` 348〜349 行が取込時の `customer` から書く。2026-09-15 ハーネス実測）。**取引ログ AC・AD列を判定に使ってはならない** ── §2.4・§8.9 のとおり値を渡す呼出しが `src/` に無く常に空文字なので、期待すると必ず赤になる
9. `webAppResolveReviews` が `WEBAPP_MAX_PER_CALL_` 件だけ処理し、`remaining` を返す
10. 同、1件の失敗で全体が止まらず `errors` に載る
11. 同、空の `partnerName` は `RESOLVE_WITHOUT_PARTNER` になる
12. **第3引数の `customer` が効く**：`runImport` でシートA に立てた取引の要確認に対し、`resolveReview(reviewId, 'ADOPT_EXISTING_PARTNER', {partnerName: '甲社', learn: false, customer: シートB を指す customer})` を呼ぶと、**シートB の `tx.destinationRow` 行の F列が変わり、シートA の同じ行は無傷**である。判定はシートの現物を読んで行う ── 取引ログ AC・AD列は常に空なので判定材料にならない
13. **§2.4 原理 4 の破壊を捕まえる**：シートA の15行目に取引1、シートB の15行目に取引9 を置き、`runImport` で両方を立てる。取引1 の要確認を **Web アプリ経由で**確定 → **シートA の15行目の F列だけが変わり、シートB の15行目は無傷**。第3引数に `customer` を載せない実装（＝`getCustomerById` をそのまま使う実装）はここで落ちる
14. 要確認の表が `PARTNER` だけを含み、他種別は件数だけになる
15. **取消しが正しいシートを開く**：シートA の15行目に取引1、シートB の15行目に取引9。取引1 のファイルを `CANCEL_FILE` で取り消す → **シートA の15行目が空になり、シートB の15行目は無傷**。`52` 406 の `buildIndex` を雛形で作る実装はここで落ちる
16. **`51` の3操作すべてで差し替えが効く**：`ADOPT_EXISTING_PARTNER`・`FIX_DATE_AMOUNT`・`EXCLUDE` のそれぞれについて、シートA の取引を確定してシートB が無傷であること（3 レグ）
17. **`input.learn` を渡さないと辞書が増える**（§7.4.2）：`resolveReview(reviewId, 'ADOPT_EXISTING_PARTNER', {partnerName: '甲社'})`（`learn` 未指定）で顧客別取引先辞書が 1 行増えることを固定する。**これは `src/` の挙動を固定するテストであって Web アプリのテストではない** ── 未指定が「学習する」であることを誰かが変えたら、§7.4.2 の 3 条件が全部無意味になる
18. **空店名では学習しない**（§7.4.2 判定 1）：店名が空の `PARTNER` 要確認を Web アプリ経由で確定 → 顧客別取引先辞書が**増えない**。**さらに対照**として、空店名の辞書行を手で置いた世界で `matchPartner({merchantOriginal: ''}, ...)` が `autoConfirm: true` を返すことを固定する（2026-09-15 ハーネス実測）── これが「学習してはならない理由」そのもので、これを固定しないと判定 1 は「なんとなくの安全策」に見えて消される
19. **カード名で取引先を決める用途では学習しない**（§7.4.2 判定 2）：顧客マスター AN列にその用途を入れて確定 → 辞書が増えない
20. **同じ店名に別の取引先名を入れたらどちらも学習しない**（§7.4.2 判定 3）：同じ元店名の要確認 2 件に `甲社`・`乙社` を入れて 1 回で送る → **両方とも転記先には書かれ**、辞書は**1 行も増えない**
21. **取り消された取引には書かない**（§7.4.3）：`CANCEL_FILE` 済みの取引の要確認を送る → `errors` に `STATE_TRANSITION` が載り、転記先の行は**変わらない**（幽霊行が出ない）
22. **担当外の `reviewId` を弾く**（§7.4.1 手順 2）：顧客 C001 を名乗って C002 の `reviewId` を送る → `errors` に `REVIEW_CUSTOMER_MISMATCH` が載り、**C002 の転記先が変わらない**。**この世界の実行者はオーナーにする** ── オーナーは全顧客の役割を持つので `authorizeOperation` は通り、手順 2 が無ければ素通りする。実行者を非オーナーにすると手順 1 だけで落ちてしまい、**テストが通っても手順 2 を検証していない**
23. **恒等式が破れない**（§7.4）：後始末を1件失敗させ、`decisions.length ＝ resolved ＋（`reviewId` を持つ `errors` の数）＋ skippedByLease ＋ remaining` が成り立つことを固定する。`errors.length` を使う実装はここで落ちる
24. 既存 950 テストが全件通る

---

## 13. 受入条件

1. `node test/run-tests.js` が全件 PASS（既存 950 ＋ §12.3）。**ただし既存テスト `auth F-35`（`test/phase7-authorization.test.js` 683〜692 行）の期待値だけは更新する** ── このテストは `src/` の全 `.gs` を走査して認可を呼ぶファイルが 2 つちょうどであることを断定しており、§4.4 が `80_WebApp.gs` に認可を要求する以上**必ず赤になる**。期待値に `80_WebApp.gs` を1つ足し、**それ以外は1文字も変えない**。

   **赤を消すために `80_WebApp.gs` から認可を外してはならない。**このテストが守っているのは「認可を呼ぶファイルを増やさない」ことであり、本仕様は §4.4 でその増加を**意図して**決めた。期待値を1ファイル増やすのが正しい直し方で、認可を外すのは §4.4 の目的そのものを消す誤りである。テストの更新は `src/` の差分ではないので受入 2 に影響しない。
2. `src/` の差分が次の **7 ファイルだけ**である：`appsscript.json`（§4.2）・新設 `80_WebApp.gs`・新設 `81_WebAppUi.html`・`51_ReviewResolution.gs`（3 箇所。123・162・266 行）・`52_FileResolution.gs`（5 箇所。209・270・327・398・406 行）・`54_IntegrityResolution.gs`（1 箇所。274 行）・`71_RunOrchestrator.gs`（1 箇所。208 行。§7.3.1）。**確かめ方は `git status --porcelain` である。`git diff --stat` を使ってはならない** ── 新設の `80_WebApp.gs`・`81_WebAppUi.html` は未追跡なので `git diff` に一切現れず、**7 ファイルのうち 2 つを数え落とす**（しかも「5 行だった、少ないから安全だ」と読めてしまう）。`git status --porcelain -- src/ appsscript.json` の出力が**ちょうど 7 行**で、各行が上の 7 ファイルのいずれかであること。**`96_Menu.gs`・`97_Ops.gs`・`43`・`44`・`45`・`70` に 1 行の差分も無いこと。**
2b. 上の 7 ファイル以外を守るのは「触らない」の列挙ではなく**この差分条件そのもの**である ── §10 の列挙は `10`〜`45`・`56`・`62`・`90` を挙げておらず、列挙だけで守ると `src/` の半分以上が無防備になる（`spec_menu_operations.md` 受入 7 が同じ理由で列挙を退けている）。
3. `doGet` 以外に `access` を広げる設定が無い（`appsscript.json` が `MYSELF`）
4. 新設コードで `Session.getEffectiveUser` を呼んでいない
5. **実機**：Web アプリの URL を開き、顧客一覧が出る
6. **実機**：カードフォルダを選ぶとファイル一覧が出る
7. **実機**：「記帳を実行」で転記シートが**新規作成**され、そこに転記される
8. **実機**：作られた転記シートの `取込用` タブに値が反映されている
9. **実機**：要確認の表に取引先を入力して確定でき、転記先 F列に入る
10. **実機**：Excel をダウンロードでき、Excel で開ける
11. **実機**：1回のサーバー呼出しが 6 分に当たらない（実行数画面で確認）
12. **実機**：往復単価を測り直し、`WEBAPP_TRIP_WORST_MS_`・`WEBAPP_MAX_PER_CALL_` を運用段階の値に置き直す

---

## 14. 未確認事項と課題

| 番号 | 内容 | 影響 | 対処 |
|---|---|---|---|
| K-W1 | `access: MYSELF` なのでオーナー以外は使えない。担当者へ開くには自前ログインか Workspace ドメインが要る（いまのオーナーは個人 Gmail） | 顧客の担当者が使えない | 第2段。使う人が増えるときに設計する |
| K-W2 | 要確認の表は `PARTNER` だけ。他種別はメニューから確定する | 担当者が2つの画面を行き来する | 第2段で表に統合 |
| K-W3 | 新しい転記シートの置き場所を顧客マスターに持たせるか未決 | 雛形と同じフォルダに溜まる | 運用して判断 |
| ~~K-W4~~ | **解決済み**（2026-09-15 調査）。`customer` は末端まで引数で届く。§8.4 | ── | ── |
| ~~K-W6~~ | **解決済み**。ブラウザが自分の資格で書き出し URL を開く。§9.2 | ── | ── |
| ~~K-W5~~ | **解決済み**（2026-09-15 調査）。`buildIndex(customer)` が転記先を開く。書込経路は §8.7 で直し、整合性チェックは K-W9 へ送った | ── | ── |
| K-W9 | **整合性チェックが雛形の1枚しか見ない**（`71_RunOrchestrator.gs` 174 行）。取込のたびに顧客ごと1回 `buildIndex(customer)` を作るので、過去の転記シートは検査対象から外れる | `44_IntegrityChecker` の「転記行が消えた」「手で書き換えられた」の検出が**過去のシートに届かない**。帳簿は壊れないが、壊れていても気づけない | 第2段で「顧客 × 転記先ごとに回す」形へ。取引ログの `destinationSpreadsheetId` を `distinct` して索引を作り分ける。**構造の変更なので、書込経路の変更（本仕様）と同じ版で混ぜない** |
| K-W7 | 転記シートが押下ごとに増える。何枚まで溜めてよいか未決 | Drive が散らかる | 運用して判断。第2段で整理機能を検討 |
| K-W8 | 既存の定期取込（10分ごと）と Web アプリの「記帳を実行」が同じファイルを同時に触り得る | リースで守られるが、利用者には「なぜか取り込まれない」と見える | リース衝突の文言を画面に出す（§6.1）。定期取込を止めるかは運用判断 |

---

## 付録A. モックと本仕様の差

| モックの要素 | 本仕様 | 理由 |
|---|---|---|
| サイドバー（取引一覧・レポート・マスタ管理・設定） | 枠だけ。押すと「準備中」 | §2.2 |
| 「推定カテゴリ」列 | **出さない** | その値を書いている箇所が無い。§0 の規律 |
| 「Excel作成済み 2024/10/20 14:32」 | 出す（その押下で作った分） | §9.3 |
| 上部のステップ表示（1.顧客選定 → 4.ダウンロード） | 出す（現在位置の表示のみ。押して移動はしない） | 3カラムは同時に見える作りなので、ステップは進捗の目安 |
| 「全 12 件」「契約順」 | 件数は出す。並び順は顧客名順 | 契約順を持つ列が無い |

---

## 付録B. 文言

| 場面 | 文言 |
|---|---|
| 顧客未選択 | `左の一覧から顧客を選んでください。` |
| フォルダ未選択 | `カードフォルダを選んでください。` |
| ファイルなし | `このフォルダに取り込めるファイルはありません。` |
| 要確認なし | `確定が必要な要確認はありません。` |
| 処理中 | `処理中… {done} / {total}` |
| リース衝突 | `他の処理と重なりました。10 分ほど待ってからもう一度実行してください。` |
| 準備中の画面 | `この画面は準備中です。` |

---

## 付録C. 当たり先の表 ── ある値を変えたら、どこを直すか

**この表は本文から機械で作った**（2026-09-15。`§` は節番号）。`spec_menu_operations.md` の 付録E と同じ道具である ── あちらでは、この表が無かった版で **1 つの値の変更に 19 箇所の直し漏れ**が出た。数字や決定を 1 つ変えるときは、**まずこの行を読み、列挙された節を全部開く。**

| 値 | 現在 | 本文で当たる節 |
|---|---|---|
| `WEBAPP_ITEM_TRIPS_` | 64 | §3.2・§3.3・§7.4・§7.4.3・§11.3 |
| `WEBAPP_CLEANUP_TRIPS_` | 62 | §3.2・§3.3・§7.4・§11.3・§13 |
| `WEBAPP_MAX_PER_CALL_` | 1 | §3.3・§11.3・§12.3・§13 |
| `WEBAPP_TRIP_WORST_MS_` | 1600 | §3.2・§3.3・§5.4・§7.4・§11.3・§13 |
| `WEBAPP_REVIEW_LIST_LIMIT_` | 15 | §3.3・§5.4・§11.3 |
| `WEBAPP_DEADLINE_MS_` | 300000 | §3.3・§7.4・§11.3 |
| `runImport` | 149 + 7×件数 | §3.2・§3.3 |
| `resolveReview ADOPT` | 60 | §3.2・§3.3・§5.4・§7.4.2・§8.5・§10・§11.3 |
| `getTransaction` | 4 | §2.4・§3.2・§3.3・§5.4・§7.4.3・§8.5・§11.3 |
| `変更するのは 7 ファイルだけ` | ── | §8.2・§10・§12.2・§13 |
| `消す 6 列 B/F/I/K/M/txId` | ── | §8.2・§12.2・§12.3 |
| `転記先の正本＝要確認 M列・N列` | ── | §2.4・§8.5・§8.9・§12.3 |
| `取引ログ AC・AD列は常に空` | ── | §2.4・§8.5・§8.9・§12.3 |
| `71 は 208 行だけ` | ── | §7.3.1・§10・§13 |
| `51 は 123・162・266 行` | ── | §8.5・§8.7・§13 |
| `52 は 209・270・327・398・406 行` | ── | §8.5・§8.6・§8.7・§8.8・§8.9・§12.3・§13 |
| `access: MYSELF` | ── | §4.2・§7.3.2・§7.4.1・§9.2・§13・§14 |
| `executeAs: USER_DEPLOYING` | ── | §4.2・§7.3.2 |

**使い方は 2 つある。**

1. **値を変えるとき**：その行の節を全部開いて直す。1 つでも残ると、本文の中で 2 つの値が食い違ったまま Codex へ渡ることになる。
2. **この表を疑うとき**：上の生成規則（`work/` 外のスクラッチで走らせた正規表現）は「その値としての出現」を拾うよう書いたが、取りこぼしは有り得る。**表を信じる前に、変える値そのもので本文を検索する。**表は検索の代わりではなく、「検索しても気づけない当たり先」（別名で書かれている節）を思い出すための索引である。

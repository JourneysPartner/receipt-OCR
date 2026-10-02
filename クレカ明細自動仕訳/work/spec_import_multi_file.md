# Web アプリの取込を 1 回の呼出しで複数ファイルにする 仕様書（`spec_webapp.md` §15-6 の第一手）

作成日：2026-10-02
版：1.0
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いてあることは変えない。書いていないことは安全側で決め、決めたことは全部報告する。

改訂履歴：
- 1.0（2026-10-02）：初版。ko-ch さんの決定（2026-10-02）：「速くする第一手は複数ファイル化から」。
  **実装（Codex）と監査（Claude）の記録：**Codex は 1309 → 1323/1323、M1〜M21 は全部赤。監査の変異 6 個のうち 4 個がすり抜けた ── (a) 門の `startedAt` を呼出しの頭でなく `runImport` へ渡す時点で取っても緑（テストは準備に時間がかからない）→ **`multi 15` を足した**（準備 50 秒＋1 本目 100 秒で 2 本目を始めない）、(b) 呼出しの固定費が 1 回増えても緑（`multi 14` の上限が測定値からの逆算で恒真だった）→ 実測値 18 を上限に置いた、(c) 引き継いだ窓を 1 件しか戻さなくても緑（均しや途中の固まりでも 2 秒超の待ちは出る）→ **最初の待ち**が 2 秒超であることを見る形にした、(d) 早く戻る呼出しで読取時刻を残さなくても緑 → `multi 13` に足した。§4 の 13 (b) の「最初の数回の読取で待つ」は、この (c) の形で読むこと。実測：1 ファイルの呼出し 43 読取・4 ファイル 118・1 本増やすごと 25・呼出しの固定費 18。

---

## 1. 何を直すか

### 1.1 いまの Web アプリの取込は、1 ファイルごとに呼出しの固定費を払っている

`webAppRunImport`（80）は `runImport` に `maxFilesPerCustomer: 1` を渡し、**1 回の呼出しで 1 ファイルだけ**取り込む（`spec_webapp.md` §3.3 の手順 1）。画面（81）は `remaining > 0` のあいだ呼出しを繰り返す。この規則は計測段階（往復の単価を 1.6 秒と見ていた 2026-09-15）に、6 分の実行上限から逆算して決めたものである。

実機の記録（`clasp logs` の `PHASES`。2026-09-27 に Web アプリで取り込んだ 15 ファイル）では、**1 ファイル約 75〜90 秒、12 ヶ月分で約 16〜17 分**かかっている。内訳：

| 部分 | 1 ファイルあたり |
|---|---|
| ファイル本体の実働（`phases` の合計 − `waits`） | 約 28〜31 秒（重いもので 50 秒） |
| 読取枠の待ち（`waits`） | 13〜35 秒。15 本中 3 本は Google の 429 に当たって 20 秒眠った（`quotaCount: 1`） |
| ファイルの外（前のファイルの PHASES から次のファイルの開始まで ＝ 呼出しの固定費＋画面との往復） | 20〜44 秒 |

**同じ頃、1 回の実行でまとめて取り込んだ 2026-09-21（4 ファイル）は 1 ファイル 39〜47 秒で、ファイルの外は 0 秒だった。**

### 1.2 原因

1. **固定費をファイルごとに払う。**認可・カードフォルダの列挙・`scanUnprocessedFiles`（80 と 71 で 2 回）・リース一覧・設定検証・容量検査・名称変更の再試行・取込前の整合性チェック・実行のあいだ変わらないマスター（カード形式・辞書 2 枚・使用用途補完・共通取引先一覧）の読込み。ハーネスで数えると、**Web アプリの 1 呼出し（1 ファイル）＝読取枠 45 回で、うち約 19 回が呼出しの固定費**である。同じ 4 ファイルを `runImport` 1 回で取り込むと 112 回（固定 12 ＋ 1 ファイル 25）。12 ヶ月では 540 回対 312 回になる。
2. **読取の均しが効かない。**`setReadQuotaSmoothing_` は `runImport` の候補が 2 ファイル以上のときだけ入る（71）。1 呼出し 1 ファイルでは常に切れていて、読取は窓（直前 60 秒に 55 回）に当たるまで全速で走り、当たると長く眠る（実機で 1 回 26 秒）。
3. **前の呼出しの読取が見えない。**窓（`apiReadWindow_`、01）は GAS の実行ごとに空から始まる。前の呼出しが直前 1 分に出した読取を数えられないので、呼出しの頭で Google の上限（60 回/分）を越えて 429 を受け、20 秒の罰を払う。

### 1.3 本仕様がすること

1. Web アプリの取込は、**時間の許す限り 1 回の呼出しで複数のファイルを取り込む。**次のファイルを始めるかは、その呼出しで既に取り込んだファイルの所要時間から決める（§2.1）。
2. **前の呼出しの読取を窓に引き継ぐ**（スクリプトキャッシュ。§2.3）。
3. **呼出し 1 回ごとの計時と読取回数をログに出す**（`IMPORT_CALL`。§2.4）。`PHASES` にもファイルごとの読取回数を足す。次の実機の取込で効果と残りの内訳を測るための計器である。

見込み：12 ヶ月で約 16〜17 分 → 約 9〜10 分。**ファイル 1 本の中の読取（約 26 回）はこの仕様では減らさない**（§15-6 の (b) 先読みは、本仕様の実機の測定の後に設計する）。

### 1.4 代わりに増える危険（K-W11）と、その抑え方

`runImport` は始めたファイルを途中で切れない。要確認の多いファイルは 1 本で数分かかり、6 分の実行上限で殺されると、そのファイルは `WRITING`／`VALIDATING` のまま残る（帳簿は整合している。戻すのは管理者の `opsRecoverStuckFiles`）。**呼出しの後半から始まるファイルは、使える時間がいまより短い。**

- いま：ファイルは呼出しの頭（経過 20〜40 秒）で始まり、約 320 秒使える。
- 本仕様：2 本目以降は経過 180 秒までに始まり（§2.1 の門）、**最低 180 秒**使える。

抑え方は §2.1 の門である：**直前までのファイルが重ければ次を始めない。**同じカードの続きの月は似た重さなので、新しい顧客の初回取込のように毎月要確認が多い場合は、1 本目の所要時間で 2 本目が止まる。残る危険は「軽い月の直後に、桁違いに重い月が来る」場合だけで、これは ko-ch さんが受け入れた（2026-10-02）。

---

## 2. 設計

### 2.1 次のファイルを始める門（`src/71_RunOrchestrator.gs` の `runImport`）

`runImport(options)` に任意の `options.fileStartGate` を足す。**渡されないときの動きは 1 バイトも変えない**（メニュー・定期実行・ops の経路）。

```
fileStartGate: {
  startedAt: <number>,   // 呼出しの開始時刻（ms）。webAppRunImport が importClockNow_() で取った値
  deadlineMs: <number>,  // 300000（WEBAPP_DEADLINE_MS_）
  floorMs: <number>,     // 60000（WEBAPP_IMPORT_FILE_FLOOR_MS_）
  factor: <number>       // 2（WEBAPP_IMPORT_FILE_FACTOR_）
}
```

規則（顧客ループの中、ファイルを 1 本始める直前に評価する）：

1. **その呼出しで最初のファイルは門を通らずに始める**（既存の `deadline` の検査は今までどおり先に効く）。最初のファイルを始めてよいかは、呼出し側（80）の既存の門 `elapsed + WEBAPP_IMPORT_BASE_TRIPS_ × WEBAPP_TRIP_WORST_MS_ <= WEBAPP_DEADLINE_MS_` が決める。
2. 2 本目以降：`predicted = max(floorMs, この呼出しで既に処理したファイルの elapsedMs の最大値)`。**最大値であって、直前の 1 本ではない**（重い月の後に軽い月が来ても、次の予測を軽くしない）。
3. `(importClockNow_() − startedAt) + factor × predicted <= deadlineMs` なら始める。超えるなら**始めず、残りの候補もすべて始めない。**境界（ちょうど等しい）は始める。
4. **直前までのファイルに `FAILED` か `LEASE_CONFLICT` が 1 つでもあれば、次を始めない**（門の時間の判定より先）。
5. 門で始めなかったファイルは `customerReport.files` に**入れない**（触っていない）。代わりに `customerReport.gate` を置く：

```
customerReport.gate = {
  stoppedBy: 'GATE' | 'FAILED' | 'LEASE_CONFLICT' | null,  // 始めなかった理由。全部始めたら null
  filesStarted: <number>,
  filesNotStarted: <number>,
  elapsedMs: <number>,     // 止めたときの (now − startedAt)。止めなかったら null
  predictedMs: <number>    // 止めたときの predicted。止めなかったら null
}
```

   `fileStartGate` が無いときは `gate` を置かない。

**時計。**71 に `function importClockNow_() { return Date.now(); }` を置き、門の判定と、門に渡す各ファイルの `elapsedMs`（`fileOutcome.elapsedMs`）と、80 の `startedAt`・`elapsed` はすべてこれで測る。テストはこれを差し替えて「ファイル 1 本に 100 秒かかった」を作る（実際に眠って測るテストは書かない）。**既存の `deadline`（`SETTINGS.EXECUTION_TIMEOUT_SECONDS` 由来）の判定の時計は変えない**（`Date.now()` のまま）。

**均し。**`setReadQuotaSmoothing_(filesPlanned > 1)` は今までどおり（Web アプリの候補が 2 本以上なら入る）。

### 2.2 呼出し側（`src/80_WebApp.gs` の `webAppRunImport`）

1. 定数を足す：`WEBAPP_MAX_FILES_PER_IMPORT_ = 6`、`WEBAPP_IMPORT_FILE_FLOOR_MS_ = 60000`、`WEBAPP_IMPORT_FILE_FACTOR_ = 2`。ファイル冒頭の定数の説明コメントにも 3 つを書き足す（何を守るための値か）。
2. `runImport` へ渡す `maxFilesPerCustomer` を `1` から `WEBAPP_MAX_FILES_PER_IMPORT_` へ。`fileStartGate` を §2.1 の形で渡す（`startedAt` は `webAppRunImport` の頭で `importClockNow_()` で取った値。既存の `startedAt`／`elapsed` もこの時計に揃える）。
   **上限 6 の意味：**門が壊れていても 1 回の呼出しが触るファイルを有限に保つ安全柵。普段は門のほうが先に効く（1 本 45 秒なら経過 180 秒までに 4 本）。
3. 戻り値の `fileResults` から `outcome` が `DEFERRED_TIME_BUDGET` のものを除く（始めていないファイル。画面の `collectSessionFiles` が「この押下で触ったファイル」に数えないように）。`done`・`total`・`remaining` の数え方は変えない（`done` は `WRITTEN`／`NO_WRITE` の数、`remaining = total − done`）。
4. `stoppedBy` の決め方に 1 つ足す：`fileResults` に `outcome === 'FAILED'` が 1 つでもあれば `stoppedBy = 'FILE_FAILED'`。順序は「顧客の `skipped` → `report.stoppedBy` → `FILE_FAILED` → `LEASE_CONFLICT`」（後のものが上書きする。既存の `LEASE_CONFLICT` の上書きはそのまま最後）。
   **理由：**いまは 1 本目が `FAILED` なら `done === 0` で画面が止まり「処理中のまま止まっています」を出す。複数ファイルで `done > 0` だと画面は次の呼出しへ進み、**失敗したファイルを黙って飛ばす。**押下を止めて知らせる今の動きを保つ。
5. 呼出しの頭で §2.3 の `loadSharedReadWindow_()` を、最後に（すべての戻り道と例外で）`saveSharedReadWindow_()` を呼ぶ。
6. §2.4 の `IMPORT_CALL` を 1 行出す（すべての戻り道と例外で 1 回だけ）。

**`webAppRunImport` の他の部分（認可・転記先の検証・複製・フォルダの照合・リースの除外・監査ログ連鎖を押下ごとに 1 回）は変えない。**

### 2.3 前の呼出しの読取を窓へ引き継ぐ（`src/01_DataAccessCore.gs`）

```
function loadSharedReadWindow_()  // 戻り値：取り込んだ時刻の数
function saveSharedReadWindow_()  // 戻り値：書いた時刻の数
```

- 置き場は `CacheService.getScriptCache()`、鍵 `SHEETS_READ_WINDOW_V1`、値は時刻（ms）の JSON 配列、有効期限 120 秒。**スクリプトキャッシュを使う理由：**Web アプリは `executeAs: USER_DEPLOYING` なので、誰が押しても読取は配備者 1 人の枠を消費する。
- `load`：`apiClockNow_()` で今を取り、`(now − 60000, now]` に入る数値だけを採る。いまの `apiReadWindow_` と合わせて昇順に並べ、重複を除き、新しいほうから最大 `READ_QUOTA_PER_MINUTE_` 個に切る。`apiReadLastAt_` は合わせた中の最大値と今の値の大きいほう。`apiReadBudget_` は変えない。
- `save`：`apiReadWindow_` のうち直前 60 秒に入るものを書く。
- **キャッシュは速さのためだけにある。**`load`／`save` のどんな失敗（`CacheService` が無い・`get`／`put` が投げる・壊れた JSON）も握りつぶし、取込を止めない。失敗の回数は §2.4 のログに出す（`sharedWindow.errors`）。
- **読取枠を消費しない**（Sheets を読まない）。
- Web アプリの取込（`webAppRunImport`）だけが呼ぶ。他の経路（要確認の確定・メニュー・定期実行）には足さない。

### 2.4 計器（`src/01_DataAccessCore.gs`・`src/71_RunOrchestrator.gs`・`src/80_WebApp.gs`）

**01：実行の寿命を持つ数え（`resetApiReadWindow_` が 0 に戻す。本番では実行の頭で 0）**

- `apiReadCount_`：`sheetsBatchGetPaced_` が出した要求の数（再試行の 1 回ごとに 1。読取枠が数えるのと同じ単位）。
- `apiQuotaHitCount_`：読取が 429／`Quota exceeded` で失敗した回数。
- `apiBackoffTotalMs_`：再試行で眠った合計。
- 既存の `apiReadPacedTotalMs_` はそのまま使う。

**71：`runImport` の段階**

`report.stages` に、ファイルループより前の段階を順に記録する：`{name, ms, reads}` の配列。段階名は `settings`（認可・`loadSettingsFromProperties`・`validateSettings`）、`capacity`、`renames`、`scan`、`precheck`、`auditChain`（走らなかったら記録しない）。複数顧客なら顧客ごとの段階は名前の前に顧客の並び順を付けず、そのまま追記してよい（Web アプリは常に 1 顧客）。`ms` は `Date.now()` の差、`reads` は `apiReadCount_` の差。

`processDiscoveredFile_` の `outcome` に `reads`（そのファイルの `apiReadCount_` の差）を足し、`PHASES` の行に `reads` と `runId` を足す。**`PHASES` の既存の鍵と値は変えない。**

`customerReport.integrity` の形は変えない。

**80：`IMPORT_CALL` の 1 行**

`Logger.log('IMPORT_CALL ' + JSON.stringify(record))`。`record`：

```
{
  runId: <report.runId か null>,
  continuation: <転記先が渡された（押下の 2 回目以降）か>,
  stages: [{name, ms, reads}, ...],   // 80 の段階：authorize, destination(検証), folder, scan, leases, clone, runImport
  run: <report.stages か []>,
  precheck: {findings: <件数>, stop: <bool>, indexesBuilt: <数>} か null,
  files: [{ms, reads, waitMs, outcome}, ...],   // waitMs は outcome.waits の合計
  gate: <customerReport.gate か null>,
  sharedWindow: {loaded: <数>, saved: <数>, errors: <数>},
  totalMs, totalReads, pacedMs, backoffMs, quotaHits,   // 呼出し全体（01 の数えの差）
  done, total, stoppedBy
}
```

- **明細の内容を出さない**：ファイル名・ファイル ID・店名・金額・取引 ID・転記先 ID・顧客名は入れない（ファイル名は `PHASES` が既に出している）。
- 早く戻る道（ファイル無し・リース衝突・時間予算・複製の検証失敗・担当者でない）でも出す。そこまでに通った段階だけを持つ。例外のときは `error: <error.code か error.name>`（メッセージは入れない）を足して出し、例外は今までどおり投げる。
- ログを出すこと自体が失敗しても取込の結果を変えない。

**`budget`：計器は読取枠を 1 回も増やさない。**

---

## 3. 変えないこと

- `runImport` に `fileStartGate` が無いときの動き（メニュー・定期実行・`opsImportOneFile`・`opsRunDeferred`）。既存の `deadline` と `DEFERRED_TIME_BUDGET`。
- ファイル 1 本の処理（`processDiscoveredFile_` の中の段階・読取・書込・状態遷移）。`PHASES` の既存の鍵。
- `webAppResolveReviews` ほか、取込以外の Web アプリの関数。要確認の確定は今までどおり 1 回の呼出しで 1 ファイル。
- 取込前の整合性チェック（K-W9）、監査ログ連鎖を押下ごとに 1 回、複製を押下ごとに 1 枚。
- 画面（81）は `stoppedByMessage` の対応表に `FILE_FAILED: TEXT.stuckFile` を足すだけ。呼出しの繰返し・進捗の数え方は変えない（`cumulativeDone += done` は複数ファイルのままで正しい）。
- `WEBAPP_IMPORT_BASE_TRIPS_` とその門、`WEBAPP_DEADLINE_MS_` の値。

---

## 4. テスト（`test/phase8-webapp.test.js` に足す。名前は `multi N: …`）

ハーネスでは時間がほぼ進まないので、門を試すテストは `importClockNow_` を差し替え、`processDiscoveredFile_` を包んで「このファイルに X 秒かかった」を作る（補助を足してよい）。

**ハーネスでは GAS のグローバルが呼出しをまたいで残る**（本番は実行ごとに空）。窓・数え（01）を試すテストは、本番の「実行の頭」を再現するため呼ぶ前に `resetApiReadWindow_()` を呼ぶ。数えは差で見る。

1. **軽いファイルは 1 回の呼出しで続けて取り込む。**4 ファイル・各 45 秒：1 回目の呼出しで 4 本とも `WRITTEN`、`done 4`・`remaining 0`、`gate.stoppedBy null`。
2. **重いファイルの後は始めない。**3 ファイル・1 本目 130 秒：1 回目は 1 本だけ（`gate.stoppedBy 'GATE'`・`filesNotStarted 2`・`predictedMs 130000`）、`remaining 2`、2 本目・3 本目は `DISCOVERED` のまま、`fileResults` は 1 件。続けて呼ぶと残りが取り込まれ、押下全体で複製は 1 枚。
3. **予測は最大値。**1 本目 100 秒・2 本目 10 秒（ファイルの外の時間 0）：2 本目の後の経過 110 秒 ＋ 2×100 ＝ 310 > 300 で 3 本目を始めない。（直前の 1 本で予測すると 110 ＋ 2×60 ＝ 230 で始めてしまう ── この差で変異 M3 を捕まえる。）1 本目の後（経過 100 ＋ 2×100 ＝ 300）は**境界ちょうどなので始める**ことも確かめる。
4. **下限。**各 40 秒のファイル 8 本・ファイルの外 0：予測は下限の 60 秒なので、経過 ＋ 120 ≦ 300 の間だけ始める ── 経過 0・40・80・120・160 秒で 5 本始まり、200 秒で止まる（`gate.stoppedBy 'GATE'`・`predictedMs 60000`）。下限が無いと予測 40 秒で 6 本目も始まり、上限 6 で止まる（この 5 対 6 で M4 を捕まえる。**ファイルを短くしすぎると上限が先に効いて区別できない**）。
5. **上限 6。**各 0 秒のファイル 8 本：1 回目 6 本・2 回目 2 本。
6. **`FAILED` で止める。**3 ファイル・2 本目を `FAILED` にする（例：`processFile` を差し替えて投げる）：1 回目は 2 本で止まり 3 本目は `DISCOVERED`、`done 1`、`stoppedBy 'FILE_FAILED'`、`gate.stoppedBy 'FAILED'`。画面の対応表で `FILE_FAILED` が `TEXT.stuckFile` の文言になる（`clientStoppedByMessage`）。1 本目で `FAILED` のとき（`done 0`）も `stoppedBy 'FILE_FAILED'`。
7. **`LEASE_CONFLICT` で止める。**2 本目のリース取得だけ失敗させる：3 本目を始めない、`stoppedBy 'LEASE_CONFLICT'`、`gate.stoppedBy 'LEASE_CONFLICT'`。
8. **始めていないファイルは結果に出ない。**`fileResults` に `DEFERRED_TIME_BUDGET` も門で止めたファイルも無い。`total`・`remaining` は数えている。
9. **均しが入る。**候補 2 本以上の呼出しでファイル処理中は `apiReadSmoothing_ === true`、呼出しの後は `false`。
10. **監査ログ連鎖は押下ごとに 1 回のまま**（複数ファイルの呼出しを 2 回続けても 1 回、新しい押下で 2 回目）。
11. **`fileStartGate` が無ければ何も変わらない。**`runImport({})` で 3 ファイル・時計で各 200 秒にしても 3 本とも始まる（既存の `deadline` に当たらない設定で）。`gate` の鍵が無い。
12. **`IMPORT_CALL` と `PHASES`。**1 回の呼出しで `IMPORT_CALL` がちょうど 1 行、`stages` に `authorize`・`folder`・`scan`・`leases`・`runImport` がある、`run` に `settings`・`capacity`・`renames`・`scan`・`precheck`、`files` の数が `fileResults` の数と同じ。`totalReads` がハーネスの `batchGet` の回数（`gas.stubs` の数え）と一致し、`stages` の `reads` の合計＋（`runImport` の中は `run` と `files` の合計）と矛盾しない。`PHASES` の各行に `reads` と `runId` があり、`IMPORT_CALL.runId` と同じ。**ログの行にファイル名・ファイル ID・店名・金額・顧客名が入っていない**（`IMPORT_CALL` について。テストで使った値を文字列で探す）。早く戻る道（ファイル無し）でも 1 行出る。
13. **窓の引継ぎ。**(a) 1 回目の呼出しの後、キャッシュに時刻が入っている。(b) 直前 60 秒に 54 回読んだことにした窓をキャッシュに置いて呼ぶと、その呼出しの最初の数回の読取で待つ（`apiClockNow_` を差し替え、`Utilities.sleep` の呼出しを数える）。(c) 60 秒より古い時刻・数値でない値・壊れた JSON は採らない。(d) `CacheService.getScriptCache` が投げても取込は成功し、`sharedWindow.errors` が 1 以上。
14. **読取の予算。**押下の 2 回目以降の呼出し（転記先あり）で、4 ファイルの呼出しの読取 − 1 ファイルの呼出しの読取 ＝ 3 本ぶん。**1 本増やすごとの読取は `budget 1` と同じ上限 25 以下**、呼出しの固定費は実測値そのものを上限に置く（実測した数を報告する）。計器とキャッシュが読取を 1 回も増やしていないこと。
15. **既存の 1 本ずつの前提のテスト。**`webapp 36` のように「1 回の呼出しで 1 ファイル」を前提にしたシナリオは、補助（例：`pinOneFilePerCall()` ＝ 時計で各ファイル 200 秒）で 1 本ずつに固定して、**期待は変えずに**通す。足した補助と、それを使った既存テストの名前を全部報告する。

`test/gas-stubs.js` に `CacheService`（`getScriptCache()` → `get`・`put`・`remove`。`reset()` で空に戻る。失敗を注入できる口）を足してよい。

---

## 5. 変異（自分で入れて、赤になることを確かめる）

| # | 変異 | 赤になるべきテスト |
|---|---|---|
| M1 | 門を外す（常に始める） | multi 2・3・4 |
| M2 | 係数 2 を 1 にする | multi 2・3 |
| M3 | 予測を最大値でなく直前の 1 本にする | multi 3 |
| M4 | 下限 60 秒を外す | multi 4 |
| M5 | 境界を `<` にする（等しいとき始めない） | multi 3 |
| M6 | `FAILED` の後も始める | multi 6 |
| M7 | `LEASE_CONFLICT` の後も始める | multi 7 |
| M8 | `FILE_FAILED` を足さない | multi 6 |
| M9 | 画面の対応表に `FILE_FAILED` を足さない | multi 6 |
| M10 | `DEFERRED_TIME_BUDGET` を `fileResults` から除かない（門で止めたファイルを `files` に入れる形も） | multi 8 |
| M11 | 上限 6 を無視する（`maxFilesPerCustomer` を渡さない） | multi 5 |
| M12 | 均しを入れない | multi 9 |
| M13 | 2 回目以降も監査ログ連鎖を検証する | multi 10（既存 45q も） |
| M14 | `fileStartGate` が無いときにも門を効かせる（既定値で） | multi 11 |
| M15 | `IMPORT_CALL` を早く戻る道で出さない | multi 12 |
| M16 | `apiReadCount_` を再試行で数えない（1 回の `sheetsReadRanges_` で 1 と数える） | multi 12（再試行を注入して） |
| M17 | `load` を呼ばない | multi 13 (b) |
| M18 | `load` が 60 秒より古い時刻も採る | multi 13 (c) |
| M19 | キャッシュの失敗を握りつぶさない | multi 13 (d) |
| M20 | `IMPORT_CALL` にファイル名を入れる | multi 12 |
| M21 | 門の時計を `importClockNow_` でなく `Date.now()` にする | multi 2・3（時計が効かなくなる） |

赤にならない変異があれば、テストを足して赤にするか、理由を報告する。

---

## 6. 受入（本番。実装・監査・push の後、Claude がユーザーの許可を得て行う）

1. 次に Web アプリで数ヶ月分を取り込んだとき、`clasp logs` の `IMPORT_CALL` と `PHASES` を読む：1 回の呼出しで何本取り込んだか・門の判定（`gate`）・呼出しの固定費（`stages` と `run` の `ms`・`reads`）・ファイルごとの読取・429（`quotaHits`）が呼出しの境目で 0 か・`sharedWindow.loaded` が 2 回目以降で 0 でないこと。
2. 12 ヶ月換算の所要時間を出し、§15-6 の (b) 先読みの設計の材料にする。
3. K-W9 の残る受入（前検査の所見に誤報が無い・`indexesBuilt`）も `IMPORT_CALL.precheck` で見る。

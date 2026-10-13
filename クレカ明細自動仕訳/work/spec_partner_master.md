# 取引先名の一覧をマスターへ置く 仕様書（`spec_webapp.md` §15-1）

作成日：2026-10-12
版：1.1
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いてあることは変えない。書いていないことは安全側で決め、決めたことは全部報告する。

改訂履歴：
- 1.0（2026-10-12）：初版。ko-ch さんの依頼（2026-10-12「§15-1 を進めて」）。設計の分かれ目 3 つは ko-ch さんが決めた（§1.2）。
  **実装（Codex、2 回）と監査（Claude）の記録：**1 回目は既存 `batch 19` が赤（20≠18）で正しく止まった（1465/1466）。2 回目で 1.1 を入れて 1472/1472、M1〜M26 は全部赤（M6・M8・M10・M11 は Codex が pm 5b・10b・14b・14c を足して赤に）。読取の実測：取込の固定費 18→**16**（`multi 14` の上限を 16 に下げた）・1 本ごと 20 のまま・`batch 3` 15・`batch 19` 18/18。監査の変異 12 個のうち 8 個がすり抜けた（どれも実装は正しく、テストが見張っていなかった）→ pm 14d・15b・19b・21b・24b・26b・32b・33b を監査で足した（1480/1480）。
- 1.1（2026-10-12）：実装（Codex、1 回目）の途中監査で直した。(1) `batch 19` が赤になったのは、テストの準備が辞書の学習（`learnFromResolution`）を直接呼び、一覧に名前を足していなかったため ── 本番では学習は確定の経路からしか呼ばれず、そこで一覧にも足す。準備を本番の形にそろえる（§4 の末尾）。(2) エラーカタログの 2 コードは普通の（列挙される）項目として足し、`phase0` の設計コードの一覧に 2 つ加える（§2.4・§4 の末尾）。(3) `prefetchMatchingMasters_` は区間の外では束ねずに今の読み手で材料を返す（§2.5）。(4) 運用シートのエラー表示は取引先名の 2 コードだけ `detail` を使う（§2.4）。(5) 画面で止める名前が複数あるときは、お知らせの箇条書きで出す（§2.6 の 7）。(6) 確定の経路で足す行の取引先IDは `customerPartnerId_`（顧客と名前のハッシュ）でよい（§2.1）。

---

## 1. 何を直すか

`spec_webapp.md` §15 の 1：**取引先のマスターが帳簿の中にあり、マスターシートの側は半分しか結線されていない。**2026-10-12 に実機を読むだけで確かめた今の形：

- **顧客は TEST01 の 1 件だけ。`共通取引先一覧` は空**（`findSimilarPartners` が `[]`）。照合（`matchPartner`、`src/33_MerchantMatcher.gs`）は顧客別取引先辞書（有効行 約 3,700）と共通辞書だけで動く。`共通取引先一覧` は取込のたびに読まれ（`commonPartnersForRun_`）、`buildDictionaryIndex` に渡されるが、照合では一度も参照されない。
- **画面の取引先欄の候補は「その店名で辞書に当たった名前」だけ**（`81` の `partnerChoices`）。辞書に無い店（新しいカードで多い）は候補が空で、担当者が手で打つ。**新しい名前を打っても何も言われない。**同じ店「ドコモケータイ払い等」の取引先が au202507 では「ドコモ」、au202501 では「docomo」になった ── 表記の揺れはここで生まれる。2026-09-16 の `amazon`／`Amazon`（1 行の揺れが 30 行の自動採用を止めた）も同じ形である。
- 帳簿（転記先スプレッドシート）の「取引先一覧」タブは、09-02 に `opsImportPartnerListToDictionary` で 1 回辞書へ取り込んだだけで、**いまも読んでいるのは `knownPartnerNames_`（`97`。メニューと運用シートの「取引先一覧に無い名前です」の判定）だけ**。タブへ足した行はシステムに届かず、システムが覚えた分はタブに戻らない。ko-ch さんの回答（10-12）：**タブにはもう手で足していない。**

### 1.1 本仕様がすること

1. マスターに**「顧客別取引先一覧」シート**を足す（§2.1）。顧客ごとの正式な取引先名を並べ、**「使わない名前 → 寄せ先」**の印を持てる。
2. **照合に名前の一致を足す**（§2.3）。辞書（STEP1〜5）に当たらなかった店名が、一覧の有効な取引先名と正規化して一致し、その名前が 1 つだけなら**自動で確定する**。辞書の候補が「使わない名前」なら自動確定しない。
3. **確定の番人**（§2.4）。取引先名で確定するどの経路（Web アプリ・自動採用・メニュー・運用シート）でも、(a)「使わない名前」と (b) 登録済みの名前と全角半角・大小だけ違う名前を拒み、(c) 一覧に無い名前は確定の後で一覧へ足す。
4. **画面**（§2.6）。取引先欄の候補に一覧の名前を全部出す。一覧に無い名前で確定しようとすると、確認のダイアログに「新しい取引先名」と似た名前を出す。(a)・(b) はダイアログを開かずに止める。
5. **帳簿のタブを読まない**（§2.7）。`knownPartnerNames_` は一覧を読む。
6. **運用関数 3 つ**（§2.8）：一覧を辞書と取引ログから作る `opsBuildCustomerPartnerList`、揺れを見る `opsShowPartnerNameVariants`、揺れを寄せる `opsMergeCustomerPartnerNames`。どれも既定は見るだけ。
7. 取込の 8-10 の材料（辞書 2 枚・共通取引先一覧・新しい一覧）を、取込の区間では**1 回の batchGet でまとめて読む**（§2.5）。一覧を足しても取込の固定費を増やさない。

### 1.2 ko-ch さんが決めたこと（2026-10-12）

1. 帳簿の「取引先一覧」タブ：**もう手で足していない → 以後は読まない。**（タブとの最後の突き合わせもしない）
2. 取引先名の正本：**マスターに一覧シートを作る**（「辞書の名前をそのまま使う」案は採らない）。
3. 店名が登録済みの取引先名と一致したら：**自動で確定する**（辞書に当たらなかったときだけ。全角半角・大小の違いは同じとみなす）。

全顧客共通の一覧（`共通取引先一覧`）は、2 件目の顧客を入れるときに結線する（今回は触らない。Claude の既定、ko-ch さんに伝え済み）。

### 1.3 変えないこと

- 辞書の照合（STEP1〜5）の結果と順序。名前の一致は STEP5 の**後**、未承認パターンの候補提示の**前**に入る。`source.partnerList` を渡さない呼出し（リリースゲートの照合ベクトル `99_Test.gs` など）の結果は 1 つも変わらない。
- `共通取引先一覧`・`共通取引先辞書`・`findSimilarPartners`・`REQUEST_NEW_PARTNER`（承認申請）・`opsImportPartnerListToDictionary`・`opsMergePartnerNameVariants`・`validateCustomerAccess`（タブの存在の確認）・顧客マスター I 列。
- 辞書の学習（`learnFromResolution`・`learnFromResolutionBatch`）の中身。
- 転記先にすでに書いた F 列の値（揺れを寄せても、過去の帳簿は書き換えない）。
- `RESOLVE_WITHOUT_PARTNER`・`RESOLVE_PARTNER_UNKNOWN` は一覧を見ない・足さない。
- 画面の `partnerChoices(review)` の戻り値（既存のテストが見ている）。

---

## 2. 設計

### 2.1 シート「顧客別取引先一覧」

`src/00_Config.gs`：`CONFIG.SHEET_NAMES.CUSTOMER_PARTNER_LIST = '顧客別取引先一覧'`。`REQUIRED_SHEET_KEYS` に `'CUSTOMER_PARTNER_LIST'` を足す（`CUSTOMER_PARTNER_DICT` の直後）。**必須にする** ── 無いまま取込を始めると、名前の一致と番人が黙って効かない。始める前に止めるのがこのコードの決まりである（`REQUIRED_SHEET_KEYS` のコメント）。

`src/04_Provisioning.gs`：`MASTER_SHEET_SPECS_` に `{key: 'CUSTOMER_PARTNER_LIST', width: 10, label: '取引先ID'}` を `CUSTOMER_PARTNER_DICT` の直後に足す。`provisionMasterSheets` は 21 枚を作るようになる。

| 列 | 項目 | 値 |
|---|---|---|
| A | 取引先ID | `generateId('PTN')`。確定の経路で足す行は `customerPartnerId_(顧客ID, 名前)`（1.1。単件と一括で監査の対象IDがそろう） |
| B | 顧客ID | |
| C | 取引先名 | **前後の空白を落とした**文字列。空にしない |
| D | 状態 | `ACTIVE`（使う）／`RETIRED`（使わない） |
| E | 寄せ先 | `RETIRED` の行だけ。使う方の取引先名 |
| F | 登録元 | `INITIAL_DICTIONARY`／`INITIAL_TRANSACTION_LOG`／`RESOLUTION`／`MERGE` |
| G | 登録者 | メールアドレス |
| H | 登録日時 | ISO 8601（`nowIso_()`） |
| I | 更新者 | 状態・寄せ先を変えたとき |
| J | 更新日時 | 同上 |

見出し（1 行目）は定数 `CUSTOMER_PARTNER_LIST_HEADER_ = ['取引先ID', '顧客ID', '取引先名', '状態', '寄せ先', '登録元', '登録者', '登録日時', '更新者', '更新日時']`。`provisionMasterSheets` は A1 だけを書くので、`opsBuildCustomerPartnerList(true)` が 1 行目をこれにそろえる（違うときだけ書く）。

**読み方**（人がシートを直接直すことを前提に、安全側へ倒す）：
- A 列が空の行は読まない（`readCommonPartners_` と同じ）。C 列は前後の空白を落として読む。C が空の行は読まない。
- D 列は前後の空白を落として大文字にする。`ACTIVE` なら使う。**それ以外（`RETIRED`・空・打ち間違い）はすべて「使わない」**として扱う。寄せ先は E 列を前後の空白を落として読む（空でよい）。
- 同じ顧客・同じ取引先名の行が複数あり、1 つでも「使わない」なら、その名前は「使わない」（寄せ先は最初の「使わない」行の E 列）。

### 2.2 一覧を読む・書く部品（新しいファイル `src/37_CustomerPartnerList.gs`）

辞書（`34`）と同じ作法にそろえる。

- `customerPartnerListSheet_()`：`requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CUSTOMER_PARTNER_LIST)`。**無ければ投げる**（必須シート）。
- `customerPartnerListWriteSheet_()`：覚えた行を捨ててからシートを返す。**一覧を書く経路は必ずこれを通す**（`dictionaryWriteSheet_` と同じ理由）。
- `readCustomerPartnerRows_()`：全顧客の生の行（`readSheetRows_(…, 10)` の形）を返す。**取込の区間（`runScopedReads_`）だけ覚える**（`customerPartnerListCache_`）。`forgetRunScopedReads_`（`01`）で捨てる。返すときは組み立て直す（呼出側が触っても覚えた行は変わらない）。
- `customerPartnerRecords_(rawRows)`：§2.1 の読み方で `{partnerId, customerId, partnerName, active, canonicalName, source, _rowNumber}` の配列にする（純関数）。
- `buildPartnerNameIndex_(records, customerId)`（純関数）：その顧客の行だけで
  - `activeExact`：有効な名前 → `true`（「使わない」行が 1 つでもある名前は入れない）
  - `activeByKey`：`normalizeMerchant(名前)` → `[{partnerId, partnerName}]`（有効な名前だけ。鍵が空なら入れない。並びは行の順）
  - `retiredExact`：使わない名前 → 寄せ先
  - `retiredByKey`：鍵 → `[{partnerName, canonicalName}]`
- `classifyPartnerName_(index, name)`（純関数）：`name` の前後の空白を落として `n`、鍵 `k = normalizeMerchant(n)`。
  1. `activeExact[n]` → `{kind: 'KNOWN'}`
  2. `activeByKey[k]` がある → `{kind: 'VARIANT', existing: [その名前…]}`
  3. `retiredByKey[k]` がある → `{kind: 'RETIRED', name: n, canonical: 先頭の寄せ先}`
  4. それ以外 → `{kind: 'NEW', name: n}`

  **この順は変えない。**登録済みの名前そのものを打ったら通す。全角半角・大小だけ違う名前は、使う名前を名指しして止める（`amazon`／`Amazon` を二度と作らない）。
- `partnerNameIssueMessage_(name, classification)`：画面・メニュー・運用シートで同じ文言を使う（**正本はここ**。画面の写しは §2.6）。
  - `RETIRED`：`「{name}」は使わない取引先名です。「{canonical}」を使ってください。`（寄せ先が空なら `「{name}」は使わない取引先名です。顧客別取引先一覧を確認してください。`）
  - `VARIANT`：`「{name}」は登録済みの「{existing}」と同じ名前です（全角・半角や大文字・小文字などの違いだけ）。「{existing}」を使ってください。`（既存が 2 つ以上なら `「A」「B」` と並べ、最後の文は `どちらかを使ってください。`）
- `registerCustomerPartnerNames_(customerId, names, actor, source)`：名前（前後の空白を落とす・空と `isPartnerUnknownLabel` と `（不要）`（`NO_PARTNER_MARKER_`）を除く・重複を除く）のうち、**その顧客の一覧に同じ名前の行が 1 つも無いもの**だけを `ACTIVE` で足す。`withScriptLock_` の中で一覧を読み直してから足す（同時の確定で同じ名前を 2 行にしない）。足すのは `appendRowsBatched_(customerPartnerListWriteSheet_(), rows, 10, 'partner-list')`。足した名前ごとに監査を 1 行（`{type: 'DICT_REGISTER', actor, targetType: 'PARTNER', targetId: partnerId, customerId, before: null, after: {C: 名前, D: 'ACTIVE', F: source}}`、`appendAuditRowsUnlocked_`）。戻り値は足した `[{partnerId, partnerName}]`。読み直しで「使わない」になっていた名前は足さない。

### 2.3 照合に名前の一致を足す（`src/33_MerchantMatcher.gs`）

`buildDictionaryIndex(customerId, source)`：`source.partnerList`（`readCustomerPartnerRows_()` の生の行、または `customerPartnerRecords_` の結果のどちらでもよい形にせず、**生の行**に決める）があれば `customerPartnerRecords_` → `buildPartnerNameIndex_(…, customerId)` を作って `index.partnerNames` に置く。無ければ `index.partnerNames = null`。

`matchPartner`：

1. STEP1〜5 は今のまま。
2. **使わない名前の番人：**STEP1〜5 で選ばれた候補（未承認パターンの候補は含まない）のうち、`index.partnerNames.retiredExact` にある名前を集めて `retiredPartnerNames`（重複なし、候補の順）とする。1 つでもあれば `autoConfirm = false`。候補はそのまま返す。
3. **名前の一致：**STEP1〜5 で何も選ばれず、`normalized` が空でなく、`index.partnerNames.activeByKey[normalized]` があれば、その行を候補にする（`{ruleId: partnerId, partnerName, priority: null, matchMethod: 'partner_name'}` を `merchantCandidates_` に通す）。`matchedBy = 'PARTNER_NAME'`。**名前が 1 つだけなら自動確定**（今の `autoConfirm` の式そのまま：候補があり・名前が 1 つ・競合なし・提示だけでない）。2 つ以上なら要確認（候補に全部）。
4. 名前の一致が無いときだけ、未承認パターンの候補提示（今の `suggestionOnly`）へ進む。
5. 戻り値に `retiredPartnerNames`（配列。無ければ `[]`）を足す。他の鍵は今のまま。

`index.partnerNames` が `null` なら 2・3 は何もしない（今と同じ結果）。

照合の材料を渡す呼出しを全部そろえる：取込（`71` の 8-10）・`opsAutoAdoptPartners`・`opsExplainPartnerMatch`（どれも `partnerList: readCustomerPartnerRows_()`）。`opsExplainPartnerMatch` の `blockedBy` は、今の順の `CONFLICT_FLAG` の後に `RETIRED_PARTNER_NAME`（`match.retiredPartnerNames.length > 0`）を挟む。戻り値に `retiredPartnerNames` を足す。

### 2.4 確定の番人（`55`・`51`・`97`）

**判定はサーバーの部品で行う。**画面の判定（§2.6）は案内のためで、古い画面や別の経路から来た名前もここで止める。

**`resolvePartnerReviewsBatch`（55）：**
- `options.partnerListRows`（任意。`readCustomerPartnerRows_()` の生の行）を受ける。渡されたら一覧を読まない。無ければ、`ADOPT_EXISTING_PARTNER` の件があるときだけ 1 回読む。
- 適格の検査（今の `INVALID_PARTNER_NAME`・`LEARN_PRECONDITION` の並び）の `INVALID_PARTNER_NAME` の直後に、`ADOPT_EXISTING_PARTNER` の件を `classifyPartnerName_` で分ける：`RETIRED` → `PARTNER_NAME_RETIRED`、`VARIANT` → `PARTNER_NAME_VARIANT`。**その件はリースの前に失敗にし、何も書かない。**文言は `partnerNameIssueMessage_`。
  - `partnerBatchFail_(result, item, code, message)`：4 つ目の引数（任意）があればそれを `message` に使う。無ければ今と同じ `partnerBatchMessage_(code)`。
  - `partnerBatchMessage_` に `PARTNER_NAME_RETIRED: '使わない取引先名です。'`・`PARTNER_NAME_VARIANT: '登録済みの取引先名と表記だけが違います。'`・`PARTNER_LIST_FAILED: '取引先名の一覧への登録に失敗しました。もう一度確定してください。'` を足す（4 つ目の引数が無い経路のため）。
- **辞書の学習の直後・要確認の確定の前**に、まだ失敗していない `ADOPT_EXISTING_PARTNER` の件の名前のうち `classifyPartnerName_` が `NEW` だったもの（適格の検査のときの判定）を `registerCustomerPartnerNames_(customerId, names, options.actor, 'RESOLUTION')` で足す。**投げたら、その名前の件を全部 `PARTNER_LIST_FAILED` にする**（要確認は開いたまま。`LEARN_FAILED` と同じ扱い ── もう一度呼べば同じ値を書き直して先へ進む）。段の順序（転記先 → 取引ログ → 辞書 → **一覧** → 要確認・監査・確定）を 55 の冒頭のコメントにも書き足す。
- `NEW` の名前が無いまとまりは、一覧を読み直さない（読取を増やさない）。

**`adoptExistingPartner_`（51）：**`assertNotPartnerUnknownLabel_` の直後（リースの前）に一覧を読み、`RETIRED`／`VARIANT` なら `new CatalogError('PARTNER_NAME_RETIRED' | 'PARTNER_NAME_VARIANT', partnerNameIssueMessage_(…))` を投げる。`learnFromResolution` の後・`settle_` の前に、`NEW` なら `registerCustomerPartnerNames_(…, 'RESOLUTION')`（投げたら投げる。要確認は開いたまま）。

`src/06_ErrorCatalog.gs`：`ERROR_CATALOG` に 2 つ足す（`errorCatalogEntry_(メッセージ, false, '確認担当者', null, 案内)`）。**普通の項目として足す**（1.1。列挙されない形で隠さない ── `phase0` の「設計コードと一致」の検査をすり抜けることになる。設計にコードを足したのだから、検査の一覧に足す。§4 の末尾）。
- `PARTNER_NAME_RETIRED`：`'使わない取引先名が指定された'`、案内 `'寄せ先の取引先名で確定する'`
- `PARTNER_NAME_VARIANT`：`'登録済みの取引先名と表記だけが違う名前が指定された'`、案内 `'登録済みの取引先名で確定する'`

メニュー（`96`）は今の分類器で `detail`（＝上の文言）を出す。出ないなら出るように直し、直した箇所を報告する。

**`webAppResolveReviews`（80）：**呼出しの頭で `readCustomerPartnerRows_()` を **1 回だけ**読み、全部の `resolvePartnerReviewsBatch` に `options.partnerListRows` として渡す。55 が返した `PARTNER_NAME_RETIRED`／`PARTNER_NAME_VARIANT` の件は、55 の `message` をそのまま画面へ返す（`webAppResolveErrorMessage_` は `message` があればそれを使うので、今のままで出るはず。確かめてテストに書く）。

**`opsAutoAdoptPartners`（97）：**頭で 1 回読み、照合（§2.3）と 55 の両方に渡す。辞書の名前が「使わない名前」なら照合が自動確定しない（§2.3 の 2）ので、その要確認は採用されずに残る。

**`opsApplyPartnerDecisions`（97、運用シート）：**取引先名の行（`（不要）` でも `取引先不明` でもない）は、辞書のパターン登録・確定より**先に**、その顧客の一覧（呼出しで 1 回読む）で分ける。`RETIRED`／`VARIANT` なら状態欄に `エラー：` ＋ 文言を書いてその行を飛ばす（辞書にも何も登録しない）。**文言に `detail` を使うのはこの 2 コードだけ**（1.1）。他のエラーの状態欄は今のまま（`error.message`）。行の処理が例外なく終わったら、その名前を `registerCustomerPartnerNames_(…, 'RESOLUTION')` で足す（`prefix`／`partial` で確定した件が 0 件でも足す。既にあれば何もしない）。

### 2.5 取込の 8-10 の材料をまとめて読む（`71`）

取込は 8-10 で顧客別辞書・共通辞書・共通取引先一覧を別々に読み（区間の中では最初のファイルで 1 回ずつ）、本仕様で一覧が 1 つ増える。**4 つを 1 回の batchGet で読む。**

- `prefetchMatchingMasters_()`（`71`）：`runScopedReads_` のときだけ動く。4 つの覚えた値（`dictionaryRowsCache_.customer`・`.common`・`runScopedMasters_.commonPartners`・`customerPartnerListCache_`）のうち**空のものだけ**の範囲を、マスターに対する 1 回の `sheetsReadRanges_` で読み、それぞれ今の読み手と同じ形にして覚える。範囲と後処理は今の読み手と同じ（`A2:R`・`A2:R`・`A2:F`・`A2:J`、末尾の空行を落とす・幅で埋める）。**後処理は `readSheetRows_` から純関数を切り出して共有する**（`sheetRowsFromValues_(values, columns)`。`readSheetRows_` はそれを使う形にし、結果は変えない）。`commonPartners` は `readCommonPartners_` と同じ写像（A 列が空の行を落とす）にする ── 写像も関数に切り出して共有する。全部覚えていれば何も読まない。区間の外では何もしない。
- 8-10 の `buildDictionaryIndex` の直前で呼ぶ。`phase('dictionary')` の計時に入る位置は今と同じ。
- **区間の外でも `null` を返さない**（1.1）。束ねずに、今の読み手（`readDictionary_(false)`・`readDictionary_(true)`・`commonPartnersForRun_()`・`readCustomerPartnerRows_()`）で同じ形の材料を返す。今の呼出し元（`processDiscoveredFile_`）は必ず区間の中だが、`null` を `buildDictionaryIndex` に渡すと投げるので、別の経路から呼ばれた日に取込が落ちる。
- `resolvePartnerReviewsBatch` は、新しい名前を足したとき `options.partnerListRows`（渡された配列）に足した行を**その場で書き足す**（同じ呼出しの次のまとまりで読み直さないため。1 回目の実装の判断を採った）。これは呼出し側との約束なので、55 の関数の説明（`options`）と書き足す箇所にコメントで書く。`opsAutoAdoptPartners` はこれを見て照合の索引を作り直す。

**目標：取込の固定費（`multi 14`）を増やさない。**今は 18 回。まとめれば 16 回になる見込み（3 回 → 1 回）。実測を報告し、`multi 14` の上限を**実測値に下げる**（コメントに 10-12 の実測と理由を足す。上げるのは不可 ── 上がったら止めて報告）。1 本増えるごとの読取（`budget 1`・`multi 14` の 20）は変わらないこと。

### 2.6 画面（`80`・`81`）

**`webAppPartnerNames(customerId)`（80、新規・公開）：**`webAppInvoke_` で包み、`webAppAuthorizeCustomer_(customerId, 'WEBAPP:取引先名')`（一覧と同じ認可）。`readCustomerPartnerRows_()` → `customerPartnerRecords_` → その顧客の行だけ。戻り値：

```
{active: [{name, key}], retired: [{name, key, canonical}]}
```

`key` は `normalizeMerchant(name)`。`active` は同じ名前を 1 つにし、`name` の `localeCompare(…, 'ja')` 順。`retired` も同じ（§2.1 の「1 つでも使わないなら使わない」で分ける）。他の顧客の行は返さない。

**`81`：**
1. `gasCall` の許可表（`webAppListReviews` の並び）に `webAppPartnerNames` を足す。
2. `state.partnerNames`（`null` または `{customerId, active, activeExact: Set, activeByKey: Map, retiredByKey: Map}`）。`loadReviews` で一覧の読込と**並べて**呼び、同じ `generation` の照合で古い結果を捨てる（`loadReviews` の今の作法にそろえる）。**失敗しても一覧の表示は止めない**：`state.partnerNames = null` にして、候補と確認は今までどおり（サーバーの番人は効く）。顧客を選び直したら `null` に戻す。
3. 鍵は `partnerNameKey(value)`：既存の `formatNormalizeHeader`（`normalizeMerchant` と同じ処理の写し）を呼ぶだけの関数。コメントに「サーバーの `normalizeMerchant` と同じでなければならない（テスト pm 28 が見る）」と書く。
4. `classifyPartnerNameClient(name)`：§2.2 の `classifyPartnerName_` と同じ 4 分類を `state.partnerNames` で行う。`state.partnerNames` が `null` なら `{kind: 'UNKNOWN'}`（何も言わない）。
5. `similarPartnerNames(name, limit)`：有効な名前のうち、鍵（空白を全部除いた `partnerNameKey`）が (1) 一方が他方を含む（どちらも 2 文字以上）、または (2) 編集距離が 1 以下（短い方が 3 文字以上）・2 以下（短い方が 8 文字以上）のもの。並びは (1) が先、同じ組の中は長さの差の小さい順 → `localeCompare(…, 'ja')`。最大 `limit`（3）個。
6. **候補の datalist は 1 つを共有する。**HTML に `<datalist id="partner-name-options"></datalist>` を 1 つ置き（`el` の表にも足す）、要確認の行の入力欄は `list="partner-name-options"` にする。**行ごとの datalist は作らない**（数百行 × 千件超の名前で数十万の要素になる）。入力欄の `focus` で `fillPartnerOptions(partnerOptionNames(review))` が中身を組み直す。
   - `partnerOptionNames(review)`：`partnerChoices(review)` から「使わない名前」（`classifyPartnerNameClient` が `RETIRED`）を除いたもの → 一覧の有効な名前のうちまだ無いもの（`state.partnerNames.active` の順）。`state.partnerNames` が `null` なら `partnerChoices(review)` そのもの。
   - 一括入力（`renderBulkPartnerOptions`）は今の中身から「使わない名前」を除き、末尾に一覧の有効な名前のうちまだ無いものを足す（`bulk-partner-options` はそのまま使う）。
7. **確定の確認（`openConfirmation`）：**`collectSelectedReviews` の後、取引先名が空でなく `取引先不明` でもない件の名前（重複なし）を `classifyPartnerNameClient` で分ける。
   - `RETIRED`／`VARIANT` が 1 つでもあれば**ダイアログを開かず**、`showNotice('次の取引先名では確定できません。', 'warning', 文言の配列)` で名前ごとの文言（§2.2 と同じ文字列。81 の `TEXT` に写す）を箇条書きにして出し、戻る（1.1。1 つの文字列に `\n` でつなぐと 1 行に詰まって出る）。
   - `NEW` があれば、ダイアログの `confirm-intro` の直後に足す段（`<div id="confirm-new-partners" hidden><p id="confirm-new-partners-intro"></p><ul id="confirm-new-partners-list"></ul></div>`）を出す：前文 `新しい取引先名が {n} 件あります。打ち間違いでないか確かめてください（確定すると取引先名の一覧に足します）。`、各行 `{名前}（似た名前：{A}、{B}）` または `{名前}（似た名前はありません）`。見た目は既存の警告の色（`notice` の warning）にそろえる。
   - `NEW` が無ければその段を `hidden` にする（前の確定で出した段を残さない）。
   - 文字は `textContent` だけで入れる（`innerHTML` を使わない）。
8. 確定が終わった後の再読込（`loadReviews`）で名前も読み直す（新しく足した名前が候補に出る）。

### 2.7 帳簿のタブを読まない（`97`）

`knownPartnerNames_(customer)`：一覧のその顧客の**有効な名前**の集合（`{名前: true}`）を返す。読めなければ今と同じく `null`。**帳簿の「取引先一覧」タブを開かない**（`SpreadsheetApp.openById(customer.destinationSpreadsheetId)` を呼ばない）。関数のコメントを今の形に書き直す。メニュー（`96`）の「※ 取引先一覧に無い名前です」の文言は変えない（既存のテスト）。

`opsImportPartnerListToDictionary` は残す（古い取込口。コメントの冒頭に「2026-10-12 以後、帳簿のタブは読まない運用（spec_partner_master §1.2）。動かしたら `opsBuildCustomerPartnerList(true)` で一覧へ名前をそろえる」と書く）。

### 2.8 運用関数（`97`。どれもエディタのプルダウンから引数なしで動く形にはしない ── 既定は見るだけ）

**`opsBuildCustomerPartnerList(apply)`**
- 有効な顧客ごとに、名前を 2 か所から集める：(a) 顧客別辞書の**有効な行**の D 列（登録元 `INITIAL_DICTIONARY`）、(b) 取引ログの有効な行で取引先解決状態が `RESOLVED_WITH_PARTNER` のものの予定値 F（`txLogFromRecord_(…).planned.f`。(a) に無い名前だけ、登録元 `INITIAL_TRANSACTION_LOG`）。名前は前後の空白を落とし、空・`取引先不明`（`isPartnerUnknownLabel`）・`（不要）` を除く。
- 一覧にその顧客の同じ名前の行が（状態を問わず）既にあれば足さない。
- 戻り値（`Logger.log` にも JSON で出す）：`{apply, sheetExists, customers: [{customerId, dictionaryNames, transactionLogOnlyNames, alreadyListed, toAdd, added, sameKeyGroups, sampleToAdd}]}`。`sameKeyGroups` は足した後の有効な名前で鍵が同じ組の数、`sampleToAdd` は足す名前の先頭 20 個。
- `apply !== true` なら**何も書かない**（シートが無くても `sheetExists: false` で答える）。
- `apply === true`：シートが無ければ投げる（`provisionMasterSheets()` を先に走らせる。§6 の手順）。1 行目を `CUSTOMER_PARTNER_LIST_HEADER_` にそろえ、`withScriptLock_` の中で読み直してから足す（`appendRowsBatched_`）。監査は顧客ごとに 1 行（`{type: 'DICT_REGISTER', targetType: 'PARTNER', targetId: customerId, customerId, after: {added: n}, reason: 'BUILD_PARTNER_LIST'}`）。
- 何度走らせてもよい（2 回目は 0 件）。辞書を手で直した後や `opsImportPartnerListToDictionary` の後に、名前をそろえる道具にもなる。

**`opsShowPartnerNameVariants(customerId)`**（読むだけ）
- その顧客の有効な名前について、辞書の有効行の数（名前ごと）を添えて、3 種類の組を返す：
  - `sameKey`：鍵（`normalizeMerchant`）が同じ名前の組（`amazon`／`Amazon`）。**これがあると名前の一致は自動確定しない**ので先に寄せる。
  - `contains`：鍵の一方が他方を含む組（どちらも 2 文字以上。`sameKey` の組は除く）。例 `ドコモ`／`NTTドコモ`。
  - `close`：鍵の編集距離が 1 以下（短い方が 3 文字以上）・2 以下（短い方が 8 文字以上）の組（上の 2 つは除く）。
- 各種類は辞書の行数の多い順に最大 100 組。`close` は 120 秒で打ち切り、`truncated: true` を返す。
- **カタカナと英字の揺れ（`ドコモ`／`docomo`）はこの機械では見つからない。**戻り値の `note` にそう書く。
- 戻り値：`{customerId, activeNames, retiredNames, sameKey: [{names: [{name, dictionaryRows}]}], contains: [...], close: [...], truncated, note}`。

**`opsMergeCustomerPartnerNames(customerId, fromName, toName, apply)`**
- 引数：前後の空白を落とす。空・同じ名前・印（`取引先不明`・`（不要）`）は `TypeError`。
- `toName` が一覧で「使わない」なら `MasterDataError`（寄せ先を寄せ先にしない）。一覧に無ければ `ACTIVE`（登録元 `MERGE`）で足す。
- `fromName` が一覧にも辞書（その顧客の有効行の D 列を前後の空白を落として比べる）にも無ければ `MasterDataError`。
- 計画：
  1. 顧客別辞書：その顧客の有効な行で D 列（前後の空白を落として）が `fromName` のもの → D を `toName` に。
  2. 1 で変わった行の鍵（`normalizeMerchant(元表記)`）ごとに、その顧客の有効な行の取引先名（変更後）が 1 つだけになった群は、競合フラグ（P 列）が立っている行の P を `false`・Q を空にする。**2 つ以上残る群は触らない。**
  3. 一覧：`fromName` の行を全部 `RETIRED`・寄せ先 `toName`・更新者・更新日時。一覧に無ければ `RETIRED` の行を足す（登録元 `MERGE`）。寄せ先が `fromName` の「使わない」行は寄せ先を `toName` に付け替える。
- `apply !== true`：計画だけ返す（`{apply: false, customerId, from, to, dictionaryRows, conflictRowsCleared, listRowsRetired, listRowsRepointed, toAdded, sample}`。`sample` は変わる辞書行の元表記の先頭 20 個）。何も書かない。
- `apply === true`：`withScriptLock_` の中で辞書と一覧を読み直して計画を作り直し、辞書は `dictionaryWriteSheet_(false)`、一覧は `customerPartnerListWriteSheet_()` を通して書く（範囲ごとの `Sheets.Spreadsheets.Values.batchUpdate` にまとめる。1 セルずつ `setValue` しない）。監査 2 行（辞書：`{type: 'DICT_REGISTER', targetType: 'DICT', reason: 'MERGE_PARTNER_NAMES', before: {D: from, rows: n}, after: {D: to}}`、一覧：`{type: 'DICT_REGISTER', targetType: 'PARTNER', reason: 'MERGE_PARTNER_NAMES', before: {C: from}, after: {D: 'RETIRED', E: to}}`）。
- 共通辞書・転記先の F 列・開いている要確認の候補は変えない（戻り値の `note` に書く）。

---

## 3. 読取と書込の回数

| 場面 | 今 | 後 |
|---|---|---|
| 取込（Web アプリ）の固定費 | 18 | **16 の見込み**（§2.5。上げない） |
| 取込の 1 本増えるごと | 20 | 20（変えない） |
| `webAppResolveReviews` | ── | **＋1**（呼出しの頭で一覧を 1 回）。新しい名前のあるまとまりごとに＋1（ロックの中の読み直し）＋書込 1 |
| `resolvePartnerReviewsBatch`（一覧を渡さない呼出し） | ── | ADOPT の件があれば＋1。新しい名前があれば更に＋1 ＋書込 1 |
| `opsAutoAdoptPartners` | ── | 頭で＋1。新しい名前のあるファイルごとに＋1 |
| `webAppPartnerNames` | ── | 1（＋認可の読取） |

`batch 3`（55 の 2 件と 20 件が同じ回数・上限 20）が上限を超えたら、上げずに止めて報告する。

---

## 4. テスト（`pm N: …`）

置き場所：照合と純関数は `test/phase1b-partner-duplicate.test.js`、確定・運用関数は `test/phase6-partner-decisions.test.js`、取込は `test/phase6-orchestrator.test.js`、Web アプリと画面は `test/phase8-webapp.test.js`。補助は足してよい。一覧の行はテストの中で `顧客別取引先一覧` シートへ直接書いてよい。

**照合（33・37 の純関数）**
1. 辞書に当たらない店名 `ＥＮＥＯＳ`、一覧に `ACTIVE` の `ENEOS` 1 行 → `autoConfirm: true`・`partnerName: 'ENEOS'`・`matchedBy: 'PARTNER_NAME'`・`matchedRuleId` がその取引先ID・`partnerResolutionStatus` が `RESOLVED_WITH_PARTNER`。
2. 一覧に `amazon` と `Amazon`（どちらも `ACTIVE`）・店名 `AMAZON` → 自動確定しない・候補に 2 つ・`matchedBy: 'PARTNER_NAME'`。
3. 辞書が勝つ：辞書 `ENEOS → エネオス株式会社`（STEP1）と一覧 `ENEOS` → 辞書の結果（`STEP1`）。承認済みパターン（STEP5）でも辞書が勝つ。
4. 名前の一致は未承認パターンの提示より先：両方当たる → `PARTNER_NAME` で自動確定。名前が当たらなければ今どおり提示だけ。
5. 使わない名前・他の顧客：一覧に `RETIRED` の `docomo`（寄せ先 `ドコモ`）と他の顧客の `ACTIVE` の `docomo` → 店名 `docomo` は一致しない（候補なし）。
6. 使わない名前の番人：辞書（STEP1）の候補 `docomo` が一覧で `RETIRED` → `autoConfirm: false`・`retiredPartnerNames: ['docomo']`・候補はそのまま。同じ名前に `ACTIVE` と `RETIRED` の行があっても「使わない」。
7. 正規化：一覧 `ドコモ　ケータイ` と店名 `ﾄﾞｺﾓ ｹｰﾀｲ` が一致する。店名が空（正規化して空）なら名前の一致を見ない。
8. 状態の読み方：`' active '` は使う、`''`・`'x'`・`'RETIRED'` は使わない（`retiredExact` に入り、寄せ先は E 列・空可）。A 列が空・C 列が空の行は読まない。
9. `source.partnerList` を渡さない → 戻り値に `retiredPartnerNames: []` があり、他の鍵は今と同じ（既存の照合のテストが緑のまま）。
10. `classifyPartnerName_`：`KNOWN`（`Amazon`）・`VARIANT`（`AMAZON` → `existing: ['Amazon']`。既存が 2 つなら 2 つ）・`RETIRED`（`DOCOMO` → `canonical: 'ドコモ'`）・`NEW`。登録済みの名前そのもの（`ACTIVE`）は、同じ鍵の `RETIRED` があっても `KNOWN`。入力の前後の空白を落とす。
11. `partnerNameIssueMessage_`：§2.2 の 4 つの文言そのもの（寄せ先あり・なし、既存 1 つ・2 つ）。

**確定（55・51・80・97）**
12. 55：`RETIRED` の名前の `ADOPT_EXISTING_PARTNER` → その件だけ `errors` に `PARTNER_NAME_RETIRED`（`message` が文言そのもの）。転記先・取引ログ・辞書・一覧・要確認・監査に何も書かない。同じまとまりの他の件は確定する。
13. 55：`VARIANT` → `PARTNER_NAME_VARIANT`、同じく何も書かない。
14. 55：`NEW` の名前 2 件（同じ名前）で確定 → 確定でき、一覧に `ACTIVE`・登録元 `RESOLUTION`・登録者が actor の行が **1 行**。監査（`targetType: 'PARTNER'`）が 1 行。もう一度別の要確認で同じ名前を確定しても行は増えない。
15. 55：一覧への登録が投げる（スタブ）→ その名前の件は `PARTNER_LIST_FAILED`、要確認は `OPEN` のまま、転記先の F 列は書けている。もう一度同じまとまりを呼ぶと確定し、一覧に 1 行。
16. 55：`options.partnerListRows` を渡すと一覧を読まない（読取が 1 回少ない）。`NEW` の名前が無ければロックの中で読み直さない。
17. 51：`resolveReview(…, 'ADOPT_EXISTING_PARTNER', {partnerName: RETIRED の名前})` → `PARTNER_NAME_RETIRED` を投げ、リースを取らず何も書かない。`VARIANT` も同じ。`NEW` → 確定の後で一覧に 1 行。
18. 80：`webAppResolveReviews` で `RETIRED` の名前 → 戻り値の `errors` に `PARTNER_NAME_RETIRED` と寄せ先入りの文言、勘定の恒等式（既存の検査）が崩れない。2 ファイルにまたがる確定で一覧の読取が 1 回。
19. 80：`webAppPartnerNames` → 担当者でない顧客は認可で落ちる。`active` と `retired` を返し、他の顧客の名前を返さない。`key` が `normalizeMerchant` の値。名前の順が `localeCompare(…, 'ja')`。
20. 97：`opsApplyPartnerDecisions` で `RETIRED` の名前・`prefix` の行 → 状態欄が `エラー：` ＋文言、辞書にパターンが入らない、要確認は `OPEN`。`NEW` の名前・`prefix` の行 → 一覧に 1 行。
21. 97：`knownPartnerNames_` は一覧の有効な名前を返し、**帳簿の「取引先一覧」タブを開かない**（タブを消した転記先でも動く／`openById` が呼ばれない）。
22. 97：`opsAutoAdoptPartners` で辞書の名前が `RETIRED` → 採用されず要確認が残る。他の要確認は採用される。

**取込（71）**
23. 辞書に無い店名・一覧の名前と一致 → 転記先の F 列にその名前、`PARTNER` の要確認が立たない、取引ログが `RESOLVED_WITH_PARTNER`。一覧に鍵の同じ名前が 2 つ → 要確認が立ち、候補に 2 つ。
24. 読取：`multi 14` の固定費を実測値（16 の見込み）に下げて緑。`budget 1`・`multi 14` の 1 本ごと 20 は変えずに緑。`prefetchMatchingMasters_` の後、4 つの材料のどれも区間の中で読み直さない。
25. 区間の外では覚えない：取込の後に一覧を書き換えて `opsExplainPartnerMatch` → 新しい値で答える。一覧を読みの取得口（`customerPartnerListSheet_`）で書いている箇所が無い（`dict 1` と同じ形のソースの検査）。

**運用関数（97）**
26. `opsBuildCustomerPartnerList()` は何も書かない（一覧・監査とも行数が変わらない）。`(true)` で、辞書の有効行の名前（無効行だけにある名前は入れない）と取引ログの F 列の名前が `ACTIVE` で入る。印（`取引先不明`・`（不要）`）と空を入れない。前後の空白を落とす。1 行目が見出し。2 回目は 0 件。シートが無いと `(true)` は投げ、`()` は `sheetExists: false` で答える。
27. `opsShowPartnerNameVariants`：`amazon`／`Amazon` が `sameKey`、`ドコモ`／`NTTドコモ` が `contains`、`セブンイレブン`／`セブンイレプン` が `close`。何も書かない。
28. `opsMergeCustomerPartnerNames`：(a) 既定は何も書かない（計画の数が正しい）。(b) `apply` で、辞書の D が寄せ先に・名前が 1 つになった群の競合フラグが外れ・2 つ残る群は外れない・一覧の from が `RETIRED`・寄せ先 to・from を寄せ先にしていた行が to に付け替わる・to が無ければ `ACTIVE` で足す・他の顧客の行に触れない・監査 2 行。(c) to が `RETIRED`・from＝to・空・印・from がどこにも無い → 投げて何も書かない。

**シートと設定**
29. `provisionMasterSheets` が 21 枚を作る（`phase5-provisioning` の 20 → 21。§5 の許可）。`顧客別取引先一覧` が無いと `validateSettings` の `requiredSheets` が欠けを報告する。

**画面（81）**
30. `partnerOptionNames`：候補 → `取引先不明` → 一覧の残り（重複なし）。`RETIRED` の候補を出さない。`state.partnerNames` が `null` なら `partnerChoices` と同じ。一括入力の候補も同じ規則。
31. `classifyPartnerNameClient`：pm 10 と同じ入力で同じ `kind`。`partnerNameKey` がサーバーの `normalizeMerchant` と同じ値（全角英数・半角カナ・長音・ハイフン類・連続空白・制御文字を含む 10 個以上の入力で比べる）。
32. `similarPartnerNames`：含む・距離 1・距離 2（8 文字以上）・当たらない例、並び順、上限 3。
33. `openConfirmation`：`VARIANT`／`RETIRED` があるとダイアログを開かず、お知らせに文言（§2.2 と同じ文字列）。`NEW` だけならダイアログの段に前文と `名前（似た名前：…）`。`KNOWN` だけなら段が `hidden`。前の確定で出した段が残らない。
34. 結線：`loadReviews` が `webAppPartnerNames` を呼び、失敗しても一覧は出る（`state.partnerNames` が `null`）。`gasCall` の許可表にある。要確認の行の入力欄が `list="partner-name-options"` で、行ごとの `datalist` を作らない。`81` に `innerHTML`・`outerHTML`・`insertAdjacentHTML` が無い。

**既存のテスト**：期待（assert）は 1 つも変えない。**例外は 3 つだけ**：`phase5-provisioning` のシートの枚数（20 → 21）と、`multi 14` の固定費の上限（実測値へ**下げる**）と、`phase0` の `ERROR_CATALOG` の設計コードの一覧に `PARTNER_NAME_RETIRED`・`PARTNER_NAME_VARIANT` を足すこと（1.1。テスト名の「52」も数に合わせる）。

**テストの準備を本番の形にそろえる（1.1）：**`phase8-webapp` の `seedAutoAdoptionFiles` は `learnFromResolution` を直接呼んで辞書に名前を作る。本番では学習は確定の経路（51・55）からしか呼ばれず、そこで一覧にも名前を足すので、準備も `learnFromResolution` の直後に `registerCustomerPartnerNames_(顧客ID, [同じ名前], 'owner@example.com', 'RESOLUTION')` を呼ぶ（コメントで理由を書く）。期待は変えない。これで `batch 19`（2 ファイルの読取が等しい）は、新しい名前の登録（1 回きりの読取）に左右されなくなる。他が赤になったら、変えずに止めて理由を報告する ── 特に `batch 1〜20`・`bulk`・`webapp 49〜54`（取引先不明）・`kf7`・`kw17`・`dict 1`・`budget 1`・`reads 1`・照合のベクトル（`99_Test.gs`、`releaseGateReport`）。

## 5. 変異（M1〜M26）

実装後に 1 つずつ入れて、赤になるテストを記録して戻す。

| # | 場所 | 変異 | 赤になるはずのテスト |
|---|---|---|---|
| M1 | 33 | 名前の一致を STEP1 の前に置く | 3 |
| M2 | 33 | 名前の一致を未承認パターンの提示の後に置く | 4 |
| M3 | 33 | 名前が 2 つでも自動確定する | 2・23 |
| M4 | 33 | `RETIRED` の名前も一致に使う | 5 |
| M5 | 33 | 使わない名前の番人を外す | 6・22 |
| M6 | 33 | 他の顧客の行も使う | 5 |
| M7 | 37 | `ACTIVE` 以外の状態を使う名前にする | 8 |
| M8 | 37 | `classifyPartnerName_` の 2 と 3 の順を入れ替える | 10 |
| M9 | 37 | `VARIANT` を作らない（鍵の比較を外す） | 10・13 |
| M10 | 37 | 登録で同じ名前の判定を外す | 14 |
| M11 | 37 | 登録をロックの外へ出す（読み直さない） | 14（2 回目）またはソースの検査 |
| M12 | 55 | `RETIRED` の判定を外す | 12 |
| M13 | 55 | 番人をリースの後・転記の後へ動かす | 12（何も書かない） |
| M14 | 55 | 一覧への登録を外す | 14 |
| M15 | 55 | 登録の失敗を飲み込む | 15 |
| M16 | 55 | `options.partnerListRows` を無視して読む | 16 |
| M17 | 51 | 番人を外す | 17 |
| M18 | 80 | 一覧をファイルごとに読む | 18 |
| M19 | 80 | `webAppPartnerNames` が他の顧客の行も返す | 19 |
| M20 | 97 | 運用シートで番人を辞書のパターン登録の後へ動かす | 20 |
| M21 | 97 | `knownPartnerNames_` が帳簿のタブを読む | 21 |
| M22 | 71 | `prefetchMatchingMasters_` を呼ばない | 24 |
| M23 | 97 | `opsBuildCustomerPartnerList` が無効行の名前も入れる | 26 |
| M24 | 97 | 寄せたとき、2 つ残る群の競合フラグも外す | 28 |
| M25 | 81 | 確認で `VARIANT` を通す | 33 |
| M26 | 81 | 行ごとの datalist に戻す | 34 |

## 6. 受入（実機）

本番の手順（Claude が行う。書込系は ko-ch さんの許可の後）：
1. push の直後に `provisionMasterSheets()` で `顧客別取引先一覧` を作る（**無いあいだは取込が `requiredSheets` で止まり、確定も投げる** ── push から作るまでの間に Web アプリを使わない）。`validateSettings('ADMIN')` が ok。
2. `opsBuildCustomerPartnerList()`（見るだけ）の数を ko-ch さんに見せる → 許可 → `(true)`。
3. `opsShowPartnerNameVariants('TEST01')` の組を ko-ch さんに見せ、寄せる組と寄せ先を決めてもらう → `opsMergeCustomerPartnerNames(…)` を見るだけ → 許可 → `apply`。
4. 照合を変えたので `releaseGateReport` を走らせる（照合ベクトルは `partnerList` を渡さないので変わらないはず）。

**本番の結果（2026-10-12、gas-push-112＝`81932c9`）：**
- 1：push の前の pull は gas-push-111・HEAD と 55/55 一致、push の後は新 HEAD と 56/56 一致。`provisionMasterSheets()` が作ったのは `顧客別取引先一覧` の 1 枚だけ。`validateSettings('ADMIN')` を run-function で呼ぶと設定（Script Properties）を読まないので #3・6・11・13・14 が出るが、#2（必須シート）は合格。
- 2：見るだけで TEST01 に 1,155 件（辞書 1,154・取引ログだけ 1）・鍵が同じ組 15 → ko-ch さんの許可で `(true)`、1,155 件を書いた。
- 3：揺れの一覧は鍵が同じ（空白を除いて同じを含む）20 組・含む 100 組・近い 24 組。Claude が寄せ先の案（全角半角・長音・空白だけの 20 組と、打ち間違いらしい 8 組）を出し、ko-ch さんが「右に寄せる」＋「umie／umio、COMG!／CONG! も同じ」と決めた → 30 組を見るだけで確かめ（辞書の変わる行数が一覧の行数と全部一致、計 45 行・競合の印が外れる 4 行）、寄せた。寄せた後は使う名前 1,125・使わない名前 30、鍵が同じ組 0、近い組は別の取引先の 8 組だけ。「楽天」と「〇〇楽天市場店」が別々の取引先になっている件は揺れではなく方針の問題として触らなかった。
- 4：`releaseGateReport` 全通過（取引先照合 14 件ほか）。

ko-ch さんに見てもらうこと：
5. Web アプリの取引先欄に一覧の名前が出る（打つと絞り込まれる）。
6. 一覧に無い名前で確定しようとすると、確認のダイアログに「新しい取引先名」と似た名前が出る。寄せた名前（例 `docomo`）を打つとダイアログが開かず、使う名前が案内される。
7. 次の取込で、辞書に無い店名が取引先名と一致した取引が要確認にならない（`IMPORT_CALL` の読取が増えていない）。

## 7. 判断の記録・残したこと

- **一覧は顧客別。**共通取引先一覧は空のまま触らない。2 件目の顧客を入れるとき、共通の名前をどこに置くか（共通取引先一覧を結線するか、顧客別の一覧へ写すか）を決める。
- **名前の一致は「使う名前」だけ。**「使わない名前」を別名として寄せ先へ確定する案（店名 `docomo` → `ドコモ`）は採らなかった ── 寄せた記録が照合の規則を兼ねると、寄せ間違いが黙って帳簿へ流れる。要るなら辞書（顧客別、STEP1/2）に行を足す。
- **全角半角・大小だけ違う名前は止める（`VARIANT`）。**`amazon`／`Amazon` が 2 つとも有効だと名前の一致が自動確定しなくなる（fail-closed）が、その状態を作らないのが先。寄せ先を変えたいときは `opsMergeCustomerPartnerNames` を使う。
- **新しい名前の登録の失敗は、その件を失敗にする**（`LEARN_FAILED` と同じ）。飲み込むと一覧から名前が漏れ、次も「新しい名前」と出るだけで害は小さいが、段の順序と再実行の冪等性を 1 つの規則にそろえた。
- **残したこと（今回は直さない）：**
  1. `validateCustomerAccess` と顧客マスター I 列は今も帳簿のタブを要る。新しい顧客の帳簿にタブが無いと登録で落ちる（2 件目の顧客のときに外す）。
  2. `REQUEST_NEW_PARTNER`（承認申請）は一覧を見ない（Web アプリは使っていない）。
  3. カタカナと英字の揺れ（`ドコモ`／`docomo`）は機械で見つけない。一覧シートを名前で並べて人が見る。
  4. リリースゲートの照合ベクトルに名前の一致の例は足さない。
  5. （監査）一覧の行の取引先IDは 2 種類ある：初期作成と寄せで足す行は `generateId('PTN')`、確定の経路で足す行は `customerPartnerId_`（顧客と名前のハッシュ）。どちらも照合・番人では使わない（名前で引く）ので害は無い。
  6. （監査）照合の「使わない名前」の番人は、仕様の `retiredExact`（同じ名前）ではなく `classifyPartnerName_` の `RETIRED`（正規化して同じ）で判定している。辞書の名前 `DOCOMO` と使わない名前 `docomo` も止まる ── 安全側なので採った。
  7. （監査）画面から `（不要）` と打つと取引先名として F 列に書かれ、一覧には足さない（`registerCustomerPartnerNames_` が印として除く）。Web アプリの印は `取引先不明` だけなので、今までと同じ。

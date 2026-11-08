# 取引先名と店名の辞書を全顧客で共通にする 仕様書

版 1.1（2026-11-08）

1.1 の変更：運用シートからの確定（`opsApplyPartnerDecisions`）は今のまま顧客別にする（§3.3・cp 13）。1.0 で共通へ向けたら、既存テスト pm 20 ほか同じ経路のテスト（`test/phase6-partner-decisions.test.js` に 16 か所）が顧客別の一覧・辞書を前提にしていた。画面ができてから使っていない古い入口なので、決まりを変えない。

前提：`work/spec_partner_master.md`（§15-1、gas-push-112）、`design_document.md` の 2.1.4（共通取引先一覧）・2.1.5（共通取引先辞書）・2.1.6a（顧客別取引先一覧）・5.7（照合の段）。

## 1. 背景

- 2026-11-08 の受入で、マスターの顧客別取引先一覧にある名前でも要確認になった。家電店の店名は、明細では小さい「ィ」が大きい「イ」で書かれていた。名前一致の鍵は `normalizeMerchant`（NFKC・大文字・空白と長音記号）だけで、小さい字と大きい字、ひらがなとカタカナを別の字として見る。
- `共通取引先一覧`・`共通取引先辞書` は空のまま。辞書の取込（`opsImportPartnerListToDictionary`）も確定の学習（`learnFromResolution`・`learnFromResolutionBatch`）も顧客別の辞書にだけ書く。共通へ移す部品（`promoteToCommon`）は 1 行ずつで、運用から呼ぶ入口がない。共通取引先一覧は取込で読む（`commonPartnersForRun_`）が、照合・画面・確定の番人のどこにもつながっていない。このままだと、新しい顧客は TEST01 で集めた名前（有効 1,125）も辞書（有効 約 3,700 行）も使えない。
- 利用者の決定（2026-11-08）：
  1. TEST01 の顧客別取引先一覧・顧客別取引先辞書の中身を、共通取引先一覧・共通取引先辞書へ写す。
  2. 共通取引先一覧をつなぐ。画面の候補・名前一致・確定の番人は、顧客別の一覧と共通の一覧の両方を見る。顧客別の一覧で使わない（`ACTIVE` 以外）にした名前は、共通にあってもその顧客では使わない。各顧客の一覧へ写す形（設計 4.27 の同期）はとらない。
  3. 確定で覚える「店名 → 取引先名」と新しい取引先名は、**原則共通へ入れる**。画面の行の「顧客別に入れる」にチェックしたときだけ顧客別へ入れる。
  4. 名前一致では、小さい字と大きい字、ひらがなとカタカナを同じとみなす。
- 設計書の「共通への書込みはオーナー管理者の承認操作の中だけ」（4.18・4.30・9.1）は、決定 3 で変わる。今の Web アプリは配備者として動き、使えるのはオーナーだけなので、実害はない。スタッフが使うようになるとき（K-W1）に見直す。

## 2. 範囲

変えてよいもの：

- `src/37_CustomerPartnerList.gs`：名前の鍵、名前の索引に共通を足す、共通の一覧へ足す部品
- `src/33_MerchantMatcher.gs`：名前一致の鍵、`buildDictionaryIndex` が索引へ共通の名前を渡す
- `src/34_MerchantDictionary.gs`：共通の辞書へ学ぶ部品
- `src/51_ReviewResolution.gs`・`src/55_PartnerBatchResolution.gs`：確定の行き先、共通の辞書との食い違いの検査
- `src/80_WebApp.gs`：候補の名前、確定の受け渡し
- `src/81_WebAppUi.html`：「顧客別に入れる」のチェック欄、確認の文、名前の鍵
- `src/97_Ops.gs`：写す運用関数、運用シートからの確定の番人（共通の名前を知っている名前として扱うだけ）、`knownPartnerNames_`
- `src/06_ErrorCatalog.gs`：コードを 1 つ足す（§3.3）
- テスト（§5）

変えないもの：

- 取込の流れ（`70`・`71`）。辞書の照合の段（STEP1〜5）と順番。`normalizeMerchant`（`32`）。辞書の C 列（正規化表記）。
- 前方一致・部分一致の登録（`registerDictionaryPattern`）。顧客別のまま。
- 顧客別の一覧そのものを扱う道具（`opsBuildCustomerPartnerList`・`opsShowPartnerNameVariants`・`opsMergeCustomerPartnerNames`）。共通は見ない。
- 取消しのときの学習の無効化（`53`・`invalidateLearnedEntries`）。`tx.learnedDictIds` を書く所がなく、今も動いていない。
- 名前の表記揺れの文（`partnerNameIssueMessage_`・画面の `TEXT.partnerVariant`）。「など」で小さい字も含む。
- 新しい取引先名の確認の文（`newPartnerIntro`）と、その行の文（「<名前>（似た名前：…）」）。

## 3. 決めたこと

### 3.1 名前の鍵（小さい字・ひらがな）

- 新しい関数 `partnerNameKey_(value)`（`37`）：`normalizeMerchant(value)` の結果に、次の 2 つをこの順でかける。
  1. ひらがな（U+3041〜U+3096）をカタカナ（＋0x60）にする。
  2. 小さいカタカナを大きい字にする：ァ→ア、ィ→イ、ゥ→ウ、ェ→エ、ォ→オ、ッ→ツ、ャ→ヤ、ュ→ユ、ョ→ヨ、ヮ→ワ、ヵ→カ、ヶ→ケ。
  （半角の小さい字は NFKC で全角の小さい字になるので、ここで一緒に大きくなる。）
- 使うところ：`buildPartnerNameIndex_` の `activeByKey`・`retiredByKey`、`classifyPartnerName_` の引き方、`matchPartner` の名前一致（今の `activeByKey[normalized]` を `activeByKey[partnerNameKey_(original)]` にする）、`webAppPartnerNames` が返す `key`。
- 画面の `partnerNameKey`（`81`）も同じ結果にする（`formatNormalizeHeader` の後に同じ 2 つの変換）。`similarPartnerNames` もこの鍵を使う（今のまま）。
- 影響：鍵が粗くなる。一覧に、小さい字だけが違う 2 つの有効な名前があると、その店名は名前が 2 つになり、自動確定しなくなる（要確認で止まる＝安全側）。「エデイオン」型の新しい名前は、登録済みの名前の表記揺れ（`VARIANT`）として確定の前に止まる。

### 3.2 共通の一覧をつなぐ

- `buildPartnerNameIndex_(records, customerId, commonPartners)`：第 3 引数は省略できる。`{partnerId, partnerName}` の並び、または名前の文字列の並び（`99_Test.gs` の照合の固定データは文字列）。名前が空の要素は飛ばす。
  - 共通の名前を有効な名前に足す（`activeExact` と `activeByKey`）。
  - **その顧客の一覧に、同じ名前（完全一致）の `ACTIVE` 以外の行があれば、共通にあっても有効にしない**（今の「1 つでも使わない行がある名前は有効にしない」と同じ扱い）。
  - 省略したときは今と同じ。
- 共通の名前を渡すところ：
  - `buildDictionaryIndex`（`33`）：索引を作るのは、今と同じく `source.partnerList` が配列のときだけ。そのとき `source.commonPartners` を渡す（取込はもう共通の一覧を読んでいるので、読取は増えない）。
  - `51` の `adoptExistingPartner_`、`55` の番人、`97` の `knownPartnerNames_`・`opsApplyPartnerDecisions` の番人、`80` の `webAppPartnerNames`。
- `webAppPartnerNames`：`active` は「顧客別の `ACTIVE`」と「共通の名前」を合わせ、顧客別で使わない名前を除いたもの。`retired` は今のまま。並べ方も今のまま（`localeCompare(…, 'ja')`）。顧客別の一覧と共通の一覧は、1 回の `sheetsReadRanges_` でまとめて読む。

### 3.3 確定の行き先（原則共通）

- 決定（decision）に `scope` を足す。値は `'COMMON'` か `'CUSTOMER'`。
  - **画面は必ず送る。**チェックが外れていれば `'COMMON'`、入っていれば `'CUSTOMER'`。
  - 運用シートからの確定（`97` の `opsApplyPartnerDecisions`）は `scope` を渡さない（今のまま顧客別。1.1）。
  - `scope` が無い・それ以外の値なら `'CUSTOMER'`（今と同じ動き）。push の前に開いていた古い画面と、今のテストを壊さないため。利用者が使う入口（画面）は `'COMMON'` が既定になるので、決定 3 を満たす。運用シートは画面ができてから使っていない古い入口で、今のまま顧客別にする（1.1）。
- `ADOPT_EXISTING_PARTNER` で：

  | | `'COMMON'` | `'CUSTOMER'` |
  |---|---|---|
  | 店名 → 取引先名の学習（`learn` が真のとき） | 共通取引先辞書 | 顧客別取引先辞書（今と同じ） |
  | 取引先名の登録 | 共通の一覧に同じ名前（完全一致）が無ければ、共通の一覧へ足す。その顧客の一覧にだけある名前も足す | 番人の結果が `NEW` のときだけ顧客別の一覧へ（今と同じ） |

  - 共通の辞書が店名を引いたとき、その取引先名が別の顧客にとっても「知っている名前」になるよう、共通で学んだ名前は必ず共通の一覧にも置く。
- 共通の辞書に足す行（18 列）：`[dictId, 元表記, 正規化表記, 取引先名, 'exact_normalized', '', ''（顧客ID は空）, '', '', false, actor, actor（承認者）, now, 1, true, false, '', '']`。
  - 同じ行（有効・顧客 ID が空・元表記・正規化表記・取引先名が同じ・`exact_normalized`・期間なし・優先度なし）があれば、足さずにその `dictId` を返す（K-W17 と同じ）。
  - 監査は `APPROVE`、対象 `DICT`、`after` に `{scope: 'COMMON', B, C, D, E: 'exact_normalized', O: true}`。
- 共通の一覧に足す行（6 列）：`[customerPartnerId_('', 名前), 名前, now, actor, actor, 1]`。同じ名前（完全一致）があれば足さない。監査は `APPROVE`、対象 `PARTNER`、`after` に `{B: 名前, scope: 'COMMON', F: 登録元}`。
- 新しい部品：
  - `registerCommonPartnerNames_(names, actor, source)`（`37`）。`registerCustomerPartnerNames_` と同じ形にする：印（取引先不明・取引先なし）と重複を除く、ロックの中で読み直す、まとめて追記、監査もまとめて、実行中の読み覚え（`runScopedMasters_.commonPartners`）を捨てる、足した `{partnerId, partnerName}` の並びを返す。
  - `learnCommonFromResolutionBatch(entries, actor)`（`34`）。`learnFromResolutionBatch` と同じ形で、書く先が共通の辞書（`dictionaryWriteSheet_(true)`）。戻り値の形（`addedDictIds` を非列挙で添える）も同じ。
- **共通の辞書と食い違うときは、書く前に止める。**`scope` が `'COMMON'` で `learn` が真の件について、共通の辞書に「有効で、正規化表記（C 列）が要確認の正規化表記と同じ、または元表記（B 列）が要確認の元表記と同じで、取引先名が選んだ名前と違う」行が 1 つでもあれば、その件は失敗にする。
  - コード `COMMON_DICTIONARY_DIFFERENT_PARTNER`。文は「共通の辞書では「<店名>」は「<共通の辞書の取引先名（2 つ以上なら「、」でつなぐ）>」です。この顧客だけ「<選んだ名前>」にするなら「顧客別に入れる」にチェックしてください。」。
  - 理由：共通の辞書に別の名前を足すと、競合になって全顧客の自動確定が止まる。顧客別の辞書は共通の辞書より先に引かれるので、顧客別に入れればその顧客だけ変えられる。
  - `55`：今の `PARTNER_NAME_RETIRED`・`PARTNER_NAME_VARIANT` と同じ段（リースを取る前）で調べる。転記先・取引ログ・要確認・辞書・一覧のどれにも触れない。
  - `51`：書く前に `CatalogError('COMMON_DICTIONARY_DIFFERENT_PARTNER', 文)` を投げる。`06` にコードを足す（`PARTNER_NAME_VARIANT` と同じ形）。
  - 同じ押下の中で、前のまとまり（別のファイル）が共通の辞書に足した行も見る。押下で 1 回読んだ写しに、足した行をその場で足す（今の `partnerListRows` と同じやり方）。共通の一覧も同じ。
- 同じ押下の中で、同じ名前の件が `'COMMON'` と `'CUSTOMER'` に分かれたら、名前は共通の一覧にだけ足す。
- `learn` が偽の件（店名が空、カード名で決まる用途、同じ店名の 2 件目、同じ店名に別の名前）は、今と同じく辞書に書かない。名前の登録は上の表のとおり。
- `RESOLVE_WITHOUT_PARTNER`・`RESOLVE_PARTNER_UNKNOWN` は `scope` を見ない。
- `51`（1 件ずつ。運用シートの経路が使う）：`input.scope` を同じ規則で見る。
- `97` の `opsApplyPartnerDecisions`（1.1）：確定・学習・前方一致の規則・名前の登録は今のまま顧客別。変えるのは番人だけで、共通の一覧にある名前を知っている名前（`KNOWN`）として扱う（共通だけにある名前は顧客別の一覧に足さない）。
- 読取の回数を増やさない：
  - `webAppResolveReviews` は押下の頭で今 1 回読んでいる顧客別の一覧に、共通の一覧と共通の辞書（`A2:R`）を束ね、1 回の `sheetsReadRanges_` で読む。写しを `resolvePartnerReviewsBatch` の `options`（`commonPartnerRows`・`commonDictionaryRows`）で渡し、ファイルごとに読み直さない。
  - `55` を `options` なしで呼んだときは、要るものだけを、今の顧客別の一覧の読みと同じ 1 回に束ねて読む。
  - 学びは、共通の件だけのまとまりなら共通の辞書を読む（今の顧客別の辞書の 1 回の代わり）。両方が混ざったまとまりだけ 2 回になってよい。
  - 既存の読取回数のテストが落ちたら、止めて報告する。

### 3.4 画面

- 要確認の表の「取引先」の右に、列「顧客別に入れる」を足す。各行にチェック欄（クラス `partner-customer-only`、`aria-label` は「<店名>を顧客別に入れる」、`<label>` で囲まない）。既定は外れ。
- 状態は `state.customerOnlyInputs`（`Map`：reviewId → 真偽）に持ち、表を作り直しても残す（`partnerInputs` と同じ扱い）。処理中は無効にする（ほかの入力と同じ）。
- `collectSelectedReviews` の件に `customerOnly` を持たせ、確定の決定に `scope` を載せる（§3.3）。
- 確認の画面：`dictionaryMessage` が今 `TEXT.learnYes`（「辞書に登録します」）を返すところを、`'COMMON'` なら「共通の辞書に登録します」、`'CUSTOMER'` なら「この顧客の辞書に登録します」にする。ほかの文は変えない。
- 表の「該当なし」の行の `colSpan` を 1 増やす（9 → 10）。
- サーバーが返す `COMMON_DICTIONARY_DIFFERENT_PARTNER` の文は、ほかの件ごとの失敗と同じ出し方で見せる。

### 3.5 写す運用関数 `opsCopyPartnersToCommon(customerId, apply)`（`97`）

`apply === true` のときだけ書く。既定は見るだけ（何も書かない）。

1. **名前：**その顧客の一覧の `ACTIVE` の名前で、`partnerListCandidateName_` を通るもの。同じ名前に `ACTIVE` 以外の行があれば除く。
   - 共通の一覧に同じ名前（完全一致）がある → 写さない（`already`）。
   - 共通の一覧の別の名前と鍵（`partnerNameKey_`）が同じ → 写さない（`variantOfCommon`。組を報告）。
   - 写す候補どうしで鍵が同じ組 → その組は全部写さない（`variantWithinCustomer`。組を報告）。
2. **辞書の行：**その顧客の顧客別辞書の有効な行。次の理由で除く。
   - 競合の印（P 列）がある → `conflictFlag`
   - 一致方法が `exact_original`・`exact_normalized` 以外 → `patternRule`
   - 有効期間（H・I 列）がある → `period`
   - 取引先名が「共通の一覧にある名前」でも「1 で写す名前」でもない（使わない名前・印・写さなかった名前） → `partnerNotCopied`
   - 残りを正規化表記（C 列。空なら `normalizeMerchant(元表記)`）ごとにまとめ、取引先名が 2 つ以上の組 → その組は全部除く（`splitPartner`。組を報告）
   - 共通の辞書に、同じ正規化表記で別の取引先名の有効な行がある → `differentInCommon`
   - 元表記・正規化表記・取引先名・一致方法が同じ行は 1 行にまとめる（`duplicate` に数える）。共通に同じ有効な行があれば写さない（`already`）。
   - 写す行：`[新しい dictId（generateId('DICT')）, 元表記, 正規化表記, 取引先名, 一致方法, 優先度, '', '', '', 承認済み（元の値）, 元の登録者, actor（承認者）, now, 1, true, false, '', '']`。
3. **書く（`apply === true`）：**ロックの中で 4 つ（顧客別の一覧・顧客別の辞書・共通の一覧・共通の辞書）を読み直し、計画を作り直して書く。共通の一覧 → 共通の辞書の順に `appendRowsBatched_` でまとめて追記する。監査は行ごとに 1 件（`APPROVE`、対象 `PARTNER`／`DICT`、理由 `COPY_TO_COMMON`、`after` に `sourceCustomerId` と、辞書なら `sourceDictId`）を、まとめて追記する。書いた後に読み覚えを捨てる。
4. **戻り値：**`{apply, customerId, names: {copy, already, variantOfCommon, variantWithinCustomer}, dictionary: {copy, already, duplicate, conflictFlag, patternRule, period, partnerNotCopied, splitPartner, differentInCommon}, examples: {理由: [最大 20 件]}, written: {names, dictionary}}`。数はすべて件数。`Logger.log(JSON.stringify(戻り値))` もする。
5. 何度実行しても同じ行は 2 回入らない（2 回目の `copy` は 0）。
6. 一覧 1,125・辞書 約 3,700 行で、GAS の 6 分に十分収まること（行ごとの読み書きをしない）。

## 4. 守ること（安全の不変条件）

- **S1：**顧客別の辞書（STEP1・STEP2）で決まる店名の結果は、共通の中身に関係なく変わらない。
- **S2：**確定も写す関数も、共通の辞書に「同じ正規化表記で別の取引先名」の有効な行を作らない。
- **S3：**顧客別の一覧で使わない名前は、共通にあってもその顧客では有効にならない。候補に出ない、名前一致で当たらない、確定で `PARTNER_NAME_RETIRED` として止まる。
- **S4：**写す関数は、`apply === true` でなければ、どのシートにも監査ログにも書かない。
- **S5：**`scope` が `'CUSTOMER'` の件は、共通の一覧にも共通の辞書にも 1 行も書かない。
- **S6：**名前一致は、名前が 2 つ以上なら今と同じく自動確定しない。
- **S7：**辞書の照合の段・`normalizeMerchant`・辞書の C 列は変えない。取込の読取回数を増やさない。
- **S8：**`COMMON_DICTIONARY_DIFFERENT_PARTNER` で失敗にした件は、転記先・取引ログ・要確認・辞書・一覧・リースのどれにも触れない。

## 5. テスト

サーバーは新しいファイル `test/phase6-common-partners.test.js` に cp 1〜17 として書く。画面は `test/phase8-webapp.test.js` の今の道具（`clientEval`・`clientPartnerState`・`fakeClientDocument` など）を使って、cp 18〜20 として末尾に足す。名前・店名はすべて架空にする（実在の店名を書かない）。

1. **cp 1：**`partnerNameKey_` で、`'テストデイオン'` と `'テストディオン'`、`'あおぞらストア'` と `'アオゾラストア'`、半角の `'ﾐﾆﾁｭｱｼｮｯﾌﾟ'` と `'ミニチユアシヨツプ'` がそれぞれ同じ鍵になる。`normalizeMerchant` の結果は変わらない（`'テストデイオン'` と `'テストディオン'` は違う）。
2. **cp 2：**名前一致：一覧に `'テストディオン'`、店名 `'テストデイオン'` → 自動確定（`matchedBy: 'PARTNER_NAME'`）。一覧に小さい字だけが違う 2 つの有効な名前 → 自動確定しない（S6）。
3. **cp 3：**共通の名前で名前一致：顧客の一覧は空、共通に `'テストディオン'` → 自動確定。顧客の一覧で同じ名前を `RETIRED` → 当たらない（S3）。`partnerList` を渡さないときは今と同じく名前一致をしない。`commonPartners` が文字列の並びでも動く。
4. **cp 4：**`classifyPartnerName_`：共通だけにある名前は `KNOWN`。共通の名前と鍵だけが同じ名前は `VARIANT`。顧客で `RETIRED` の名前は、共通にあっても `RETIRED`。
5. **cp 5：**`webAppPartnerNames`：`active` に共通の名前が入り、顧客で使わない名前は入らない。顧客別と共通の一覧を 1 回の読取で読む。
6. **cp 6：**Web の確定（`scope: 'COMMON'`）で新しい名前と店名 → 共通の一覧に 1 行、共通の辞書に 1 行（顧客 ID が空）。顧客別の一覧・辞書は増えない。同じ確定をもう 1 回しても増えない。
7. **cp 7：**`scope: 'CUSTOMER'` → 顧客別の一覧・辞書に入る。共通は 1 行も増えない（S5）。`scope` を送らないときも同じ。
8. **cp 8：**共通にある名前を選ぶ → 一覧は増えない。顧客の一覧にだけある名前を `'COMMON'` で確定 → 共通の一覧に足す。
9. **cp 9：**共通の辞書が店名 X → A のとき、B を `'COMMON'` で確定 → `COMMON_DICTIONARY_DIFFERENT_PARTNER` で失敗。文に A と B が入る。転記先・取引ログ・要確認・辞書・一覧・リースが 1 つも変わらない（S8）。同じ件を `'CUSTOMER'` で → 確定でき、顧客別の辞書に X → B、共通は変わらない。A を `'COMMON'` で → 確定でき、共通の辞書は増えない。
10. **cp 10：**同じ押下で 2 ファイル：1 つ目で共通に X → A を足し、2 つ目で X → B（`'COMMON'`）→ 2 つ目は `COMMON_DICTIONARY_DIFFERENT_PARTNER`。
11. **cp 11：**押下の読取：ファイル 2 本の押下で、共通の一覧と共通の辞書を読むのは押下の頭の 1 回だけ（顧客別の一覧と同じ 1 回）。今の読取回数より増えない。
12. **cp 12：**`51` の 1 件ずつ（`resolveReview`・`ADOPT_EXISTING_PARTNER`）：`scope: 'COMMON'` で共通へ、なし・`'CUSTOMER'` で顧客別へ。食い違いは `CatalogError`（`COMMON_DICTIONARY_DIFFERENT_PARTNER`）で、何も書かない。
13. **cp 13：**`opsApplyPartnerDecisions`（運用シート）は今のまま顧客別の辞書・一覧へ書き、共通には 1 行も書かない。共通の一覧にだけある名前で確定しても、顧客別の一覧に足さない。顧客で使わない名前は、共通にあっても `PARTNER_NAME_RETIRED` で止まる。
14. **cp 14：**`opsCopyPartnersToCommon` を見るだけで呼ぶ → 数と例を返す。シートも監査ログも 1 行も変わらない（S4）。
15. **cp 15：**写す：§3.5 の理由ごとに除かれる（`RETIRED`・競合の印・前方一致・期間・取引先が割れる組・共通との食い違い・鍵が同じ名前の組・印）。写した行の形（顧客 ID が空・承認者・新しい dictId）、監査（`COPY_TO_COMMON`・元の dictId）。2 回目は `copy` が 0。
16. **cp 16：**写した後、一覧・辞書を持たない別の顧客の取引で、写した店名が共通の辞書で自動確定し（STEP3 か STEP4）、写した名前が名前一致で自動確定する。元の顧客の照合結果は写す前と同じ（S1）。
17. **cp 17：**写す関数は、共通の辞書に「同じ正規化表記で別の取引先名」の行を作らない（S2。共通に先に X → A がある状態で、顧客別に X → B がある）。
18. **cp 18：**画面の `partnerNameKey` と、サーバーの `partnerNameKey_` が同じ結果になる（pm 31 の値に、小さい字・ひらがな・半角の小さい字を含む値を足して比べる）。
19. **cp 19：**画面：列「顧客別に入れる」とチェック欄がある。外れた行の決定は `scope: 'COMMON'`、入れた行は `'CUSTOMER'`。表を作り直してもチェックが残る。
20. **cp 20：**確認の画面の文：外れた行は「共通の辞書に登録します」、入れた行は「この顧客の辞書に登録します」。`COMMON_DICTIONARY_DIFFERENT_PARTNER` の文が件の失敗として出る。

**既存のテスト：**直さない。ただし次の 2 つだけは許す。直したテストの名前を全部報告すること。

- `test/phase0.test.js` のコードの一覧に `COMMON_DICTIONARY_DIFFERENT_PARTNER` を足す。
- 画面から送った確定で、顧客別の辞書・一覧を確かめている既存のテストが、画面が `'COMMON'` を送るようになって落ちたときは、そのテストの操作で「顧客別に入れる」にチェックする（または決定に `scope: 'CUSTOMER'` を足す）。期待値は変えない。

ほかの既存のテストが落ちたら、止めて報告する。

## 6. 変異（M1〜M16）

1 つずつ入れて全テストまたは関係するテストを回し、赤になるテストを記録して戻す。

- M1：`partnerNameKey_` のひらがなの変換を外す
- M2：`partnerNameKey_` の小さい字の変換を外す
- M3：`matchPartner` の名前一致を `normalizeMerchant` の鍵に戻す
- M4：`buildPartnerNameIndex_` が共通の名前を足さない
- M5：`buildPartnerNameIndex_` が、顧客で使わない名前を共通から除かない
- M6：`scope` を無視して、すべて共通に入れる
- M7：`scope` を無視して、すべて顧客別に入れる（画面が `'COMMON'` を送っても）
- M8：共通の辞書との食い違いの検査を外す
- M9：押下の写しに、前のまとまりが足した共通の辞書の行を反映しない
- M10：共通の辞書の行の G 列に顧客 ID を入れる
- M11：共通の辞書の同じ行の確認を外す（毎回足す）
- M12：写す関数が見るだけでも書く
- M13：写す関数が取引先の割れる組を除かない
- M14：写す関数が共通との食い違いを除かない
- M15：`webAppResolveReviews` がファイルごとに共通の一覧・辞書を読み直す
- M16：画面が `scope` を送らない

## 7. 本番での手順（Claude が行う。参考）

1. push の後、`releaseGateReport` を通す（照合の名前一致の鍵が変わるため）。
2. `opsCopyPartnersToCommon('TEST01')`（見るだけ）の数と除いた理由を利用者に見せる。
3. 利用者の許可を得て `opsCopyPartnersToCommon('TEST01', true)`。
4. 受入：画面で、共通にある名前が候補に出る。確定の確認が「共通の辞書に登録します」になる。チェックした行は「この顧客の辞書に登録します」になる。

## 8. 実装と監査の記録（2026-11-08）

- Codex 1 回目（21:09）：実装前に正しく停止（運用シートの経路を共通へ向けると pm 20 ほかとぶつかる）→ 1.1。
- Codex 2 回目（21:20）：実装・cp 1〜20 緑。既存 kw2 24（「該当なし」行の `colSpan` 9）で停止 → この 1 か所だけ 9→10 を許して再開。
- 再開後：1930/1930。M1〜M16 すべて赤。Codex が足したテスト：cp 2b（M3 のすり抜け。店名側の小さい字・ひらがな）、cp 9b（古い共通辞書の読み覚えで食い違いを見逃す穴を見つけて直した：学びのロックの中で共通辞書の覚えを捨てて読み直す）、cp 8b・9c・15b。
- 読取回数は前後で同じ（押下 pm 18：34、fc 1a/1b/1c：119/29/66、`webAppPartnerNames` pm 19：2、batch pm 16：10/11、batch 3：16/16）。
- 既存テストの直し：phase0 のコード一覧（57→58）、kw2 24 の `colSpan` 9→10 だけ。
- Codex の判断（仕様に無かったもの）：材料の一括読取 `readPartnerResolutionMasters_`（37）。番人の後に他の確定が先に共通へ別の名前を書いた場合は、学びの部品が `MasterDataError` を投げ、まとめ確定では既存の `LEARN_FAILED` になる（競合を作らない側）。同じ押下で同じ名前が共通・顧客別に分かれたときは `commonNamesForClick` で顧客別の一覧への追加を抑える（共通側の件が失敗すると、その名前はどちらにも足されない＝次の確定でまた「新しい名前」と出るだけ）。
- Claude の監査：差分を全部読んだ。Critical/High なし。`51_ReviewResolution.gs` が作業ツリーで CRLF になっていたので LF に戻した（中身は不変）。
  - Low（記録のみ）：画面の `partnerNameKey` の上のコメントが「`normalizeMerchant` と同じ（pm 28）」のまま（正しくは `partnerNameKey_`・cp 18）。`TEXT.learnYes` が使われなくなり、行き先の 2 つの文が `dictionaryMessage` に直書き。
  - Low（記録のみ）：同時に 2 人が確定する競り合いで、学びの部品が食い違いを見つけた場合、転記は済んで要確認は開いたまま（既存の `LEARN_FAILED` と同じ扱い）。今はオーナー 1 人なので起きない。
- 全テスト（Claude）：1 回目は端末が重く 30 分の上限で止まり、途中で kw26 15（2 本並列の取込。時間の門に左右される）が 1 回落ちた。単独では通り、回し直した全体は 1930/1930。

# 取引先辞書の重複と候補 ID の直し 仕様書（K-W17 第2段）

対象システム：クレジットカード明細 自動仕訳システム（Google Apps Script、リポジトリ `クレカ明細自動仕訳`）
作成日：2026-09-28
版：1.1

改訂履歴：
- 1.1（2026-09-29、1.0 の実装を監査して）：実装（1242/1242 緑、M1〜M17 すべて赤）に、**テストが捕まえない変異が 4 つ**あった ── (1) 書く直前の読み直しで「まだ有効か」を見ない、(2) 学習の番人が E4（C 列）を見ない、(3) `merchantRuleId_` が `null` を「無い」と扱わない、(4) 畳む組の鍵から正規化表記を外す。コードは正しいが、テストが無いと次の変更で黙って壊れる。kw17 14〜18 と M18〜M22 を足した。**加えて仕様の穴を 1 つ直す**：書く直前の読み直しが**残す行**を確かめていなかった。読み直しまでの間に残す行が無効にされると、組の全行が無効になり、その元表記の学習が消える。§5 の書く手順 1 を改めた。
- 1.0（2026-09-28）：初版。
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いていないことは実装者が決めてよいが、**書いてあることは変えない**。判断に迷ったら止めて報告する。

## 1. 何を直すか

### 1.1 K-W17：確定のたびに辞書へ同じ行が積もる

`learnFromResolution`（`src/34_MerchantDictionary.gs`）は、要確認で取引先を採用するたびに顧客別取引先辞書へ `appendRow` する。**既にある行を確かめない。**2026-09-16 の実機で、1 件の要確認に同一の「Amazon」が 30 個並んだ（`matchedBy: STEP1`・`conflict: true`）。

- 帳簿は壊れない（取引先名は同じなので、どの行を採っても結果は同じ）。
- 辞書が肥大し、`readDictionary_` が重くなる。候補の一覧も長くなる（画面は `webAppUniquePartners_` で畳んでいるが、それは表示だけ）。
- `spec_webapp.md` の K-W17 は「第1段は表示側だけ畳む。第2段で学習側に番人を足し、既に積まれた行を畳む後始末を別に用意する」と決めている。**本仕様がその第2段である。**

### 1.2 要確認の候補の `dictId` に文字列 `"undefined"` が入る

`merchantRuleId_`（`src/33_MerchantMatcher.gs`）は `rule.ruleId`、無ければ `rule.id` を見る。ところが辞書の行（`dictionaryRow_` が作る物）が持つのは `dictId` で、どちらも無い。`String(undefined)` で **`"undefined"`** になり、`70_ImportFlow.gs` が候補を `{partnerName, dictId: candidate.dictId || candidate.ruleId || null, matchMethod}` へ写すとき、`dictId` に `"undefined"` が入って要確認シート（Q 列・Z 列）へ保存される。同時に `matchMethod` も、`merchantCandidates_` が候補に載せていないので常に `null` になる（2.1.7 の形は `partnerName / dictId / matchMethod`）。

副作用：`sortMerchantRules_` の同順位の並べ替えが全行 `"undefined"` どうしの比較になり効いていない。`excludedByPeriod` にも `"undefined"` が並ぶ。

## 2. 「同じ行」の定義 ── 照合の結果を変えないこと

**これが本仕様の芯である。**畳む・足さない判断は、照合（`matchPartner`）の結果を 1 つも変えてはならない。

照合の要点（`33_MerchantMatcher.gs` の今の実装）：

- STEP1：顧客辞書の有効行のうち、**元表記（B 列）が明細の元表記と完全一致**する行。
- STEP2：STEP1 が空なら、**正規化表記（C 列）**が一致する行。
- STEP1・STEP2 は一致方法（E 列）を見ない。前方・部分一致（STEP5）は `prefix`／`partial` の行だけ。
- 候補に 1 つでも競合フラグ（P 列）が立っていれば自動採用しない。取引先名が 2 つ以上でも自動採用しない。
- 有効期間（H・I 列）の外の行は候補から外れる。

したがって、**元表記が違う行を「同じ」と見なしてはならない。**正規化表記が同じでも元表記が違えば、STEP1 に当たる行の集合が変わる。例：`AMAZON.CO.JP → Amazon` の行を、正規化表記が同じ `ＡＭＡＺＯＮ．ＣＯ．ＪＰ → Amazon` の行があるからといって足さない（または畳む）と、明細 `AMAZON.CO.JP` は STEP1 に当たらず STEP2 へ落ち、そこに別の取引先名の行があれば要確認に戻る。**学習は「この元表記ならこの取引先」を教える操作なので、元表記の単位で数える。**（`opsImportPartnerListToDictionary` の番人は「正規化表記＋取引先名」で数えているが、これは取込の決定であり、ここでは真似しない。）

**同等行**：顧客別取引先辞書の行 `row`（`readDictionary_(false)` が返す形）が、学習しようとしている `(customerId, original, expected, partnerName)`（`expected = normalizeMerchant(original)`）について、次を**すべて**満たすとき同等とする。

| # | 条件 | 理由 |
|---|---|---|
| E1 | `row.active === true` | 無効の行は照合に使われない |
| E2 | `String(row.customerId \|\| '') === String(customerId)` | 顧客が違えば別の辞書 |
| E3 | `row.original === String(original)`（正規化しない完全一致） | 上のとおり STEP1 の集合を変えない |
| E4 | `row.normalized === expected` | C 列が古い行（INV-42 違反）は同等と見なさない |
| E5 | `row.partnerName === String(partnerName)`（完全一致。大小・全半角も区別） | 別の取引先名なら別の教え |
| E6 | `row.matchMethod === 'exact_normalized'` | 学習が書くのはこの方法だけ。`prefix`・`partial` は STEP5 の型でもあるので別物。`exact_original` も同等にしない（保守側） |
| E7 | `row.validFrom === null && row.validTo === null` | 期間つきの行は期間外で外れるので、期間なしの学習行と同じ働きをしない |
| E8 | `row.priority === null` | 並び順を変えない |

競合フラグ（P 列）と承認（J 列）は条件に入れない ── 同等行が 1 つあれば、そこへ同じ取引先名の行を 1 つ足しても、候補の取引先名の集合も競合の有無も変わらない。

## 3. 変更 1：`learnFromResolution` に番人を足す（`src/34_MerchantDictionary.gs`）

1. いまの INV-42 の検査（`normalized` が `normalizeMerchant(original)` と違えば `MasterDataError`）は**そのまま最初に**行う。
2. `readDictionary_(false)` を読み、§2 の同等行を探す。
3. **同等行があれば**、辞書へ書かず、監査ログも書かず、**同等行のうち行番号がいちばん小さい行の `dictId`** を返す。
4. **無ければ**いまと同じ行を `dictionaryWriteSheet_(false).appendRow(...)` で足し、いまと同じ監査（`DICT_REGISTER`）を書き、新しい `dictId` を返す。書く行の中身は 1 文字も変えない。
5. 読む順と書く順：読むのは `readDictionary_`（実行中の覚えがあれば使ってよい）、書くのは `dictionaryWriteSheet_`（覚えを捨てる）。同じ押下の中で同じ店を 2 回確定しても、2 回目は 1 回目で足した行を見つけること（`dictionaryWriteSheet_` が覚えを捨てるので、次の `readDictionary_` は読み直す）。

同時に 2 つの実行が同じ行を学習すると 2 行になり得る。これは受け入れる（後始末は §5 の運用関数）。ロックは足さない。

**費用**：確定 1 件につき辞書の読取が 1 回増える（`sheetsReadRanges_` を通るので読取クォータを 1 回使う）。`WEBAPP_ITEM_TRIPS_` などの定数は変えない。増えた往復の数を測って報告すること（§7 の kw17 5）。

## 4. 変更 2：候補の ID と一致方法（`src/33_MerchantMatcher.gs`）

1. `merchantRuleId_(rule)`：`rule.ruleId`、無ければ `rule.id`、無ければ `rule.dictId` の順で、**最初に `undefined` でも `null` でもない物**を `String` にして返す。**3 つとも無ければ空文字 `''`** を返す（`"undefined"` や `"null"` を返してはならない）。
   - 優先順は変えない：`ruleId` を持つ既存のテスト用の規則（`test/phase1b-partner-duplicate.test.js` など）は今までどおり `ruleId` で並ぶこと。
2. `merchantCandidates_`：返す各候補に `matchMethod: merchantMethod_(rule) || null` を足す。ほかの鍵（`ruleId`・`partnerName`・`priority`・`conflict`）と順は変えない。
3. `70_ImportFlow.gs` は変えない ── `candidate.dictId || candidate.ruleId || null` と `candidate.matchMethod || null` は、上の 2 つで正しい値を拾う（ID が無ければ `''` → `null`）。

これで、辞書の行から作られた要確認の Q 列・Z 列の候補は `{partnerName, dictId: <辞書の A 列>, matchMethod: <E 列>}` になる。**既に本番にある要確認の `"undefined"` は直さない**（候補の `dictId` を読む処理はいま無い。次に作られる要確認から正しくなる）。

## 5. 変更 3：積もった行を畳む運用関数（`src/97_Ops.gs`）

`opsDedupeDictionaryRows(apply)` を足す。

- **`apply !== true` のときは見るだけ**（書かない・監査も書かない）。エディタのプルダウンから引数なしで実行すると見るだけになる。書くのは `apply === true` のときだけ。
- 対象は**顧客別取引先辞書だけ**。共通辞書は触らない（承認を経て入る物なので、ここから黙って書き換えない ── `opsMergePartnerNameVariants` と同じ理由）。
- 集め方：`readDictionary_(false)` の行のうち、§2 の E1・E6・E7・E8 を満たす行を、`(customerId, original, normalized, partnerName)` の 4 つが完全一致する組に分ける（E2〜E5 を組の鍵にしたのと同じ）。2 行以上の組が畳む対象。
- 残す行：組の中に競合フラグ（`row.conflict === true`）の行が 1 つでもあれば、**フラグの立った行のうち行番号がいちばん小さい行**。無ければ行番号がいちばん小さい行。
  - 理由：フラグの無い行を残してフラグの行を消すと、その元表記の STEP1 で競合が消え、**今まで要確認だった明細が黙って自動採用される。**照合の結果を変えないために、フラグは残す側に寄せる。
- 畳み方：残さない行を**無効化**する ── O 列（有効）を `false`、R 列（無効化日時）を `nowIso_()` にする（`invalidateLearnedEntries` と同じ意味）。**行は消さない。ほかの列は 1 つも書かない。**
- 書く手順（`apply === true`）：
  1. 書く直前に辞書を読み直し（`dictionaryWriteSheet_(false)` で覚えを捨ててから `readDictionary_(false)`）、無効化する行それぞれについて、その行番号の `dictId` が最初に読んだ値と同じで、まだ `active === true` であることを確かめる。**あわせて、無効化する行を持つ組の残す行それぞれについて、その行番号の `dictId` が最初に読んだ値と同じで、まだ `active === true` で、競合フラグ（`conflict`）が最初に読んだ値と同じであることを確かめる**（1.1。残す行が消えていると組の全行が無効になり、フラグが変わっていると残す行の選び方が変わる）。**1 行でも違えば 1 行も書かずに例外で止める**（`IntegrityError` か `MasterDataError`。メッセージに食い違った行番号を入れる）。
  2. 書込は `Sheets.Spreadsheets.Values.batchUpdate`（`valueInputOption: 'RAW'`）でまとめる。1 行につき O 列と R 列の 2 範囲。1 要求に入れる範囲は 500 個まで（超えたら分ける）。シートは `dictionaryWriteSheet_(false)` で取ること（`test/phase6-round-trips.test.js` の `dict 1` が見張っている）。
  3. 無効化した行がある顧客ごとに 1 件、監査を書く：`appendAudit({type: 'DICT_REGISTER', actor: activeUserEmail_(), targetType: 'DICT', customerId: <顧客>, targetId: <無効化した dictId を先頭 20 個まで ',' で連結>, before: {O: true, rows: <その顧客で無効化した行数>}, after: {O: false}, reason: 'DEDUPE_DICTIONARY_ROWS'})`。
- 2 回目以降に実行すると、畳む組は 0 になること（冪等）。
- 最初に `loadSettingsFromProperties()` を呼ぶ（ほかの `ops` 関数と同じ）。
- 返す値（`Logger.log(JSON.stringify(report, null, 2))` もする）：

```
{
  apply: <true|false>,
  customerRows: <顧客別辞書の行数>,
  eligibleRows: <E1・E6・E7・E8 を満たす行数>,
  groups: <2 行以上の組の数>,
  deactivate: <無効化する（した）行数>,
  keptFlagged: <フラグの立った行を残した組の数>,
  byCustomer: [{customerId, groups, deactivate}],   // 顧客 ID の昇順
  largest: [{customerId, original, partnerName, rows: <組の行数>,
             keep: {row, dictId}, drop: <無効化する行数>}]   // 行数の多い順に 20 組まで
}
```

  `largest` は clasp の画面に収まるよう、落とす行の一覧を入れない（数だけ）。

## 6. 変えないこと

- `src/` で変えてよいのは `33_MerchantMatcher.gs`・`34_MerchantDictionary.gs`・`97_Ops.gs` の 3 つと、`80_WebApp.gs` の **`webAppUniquePartners_` の前のコメントだけ**（「辞書そのものは直さない」「22 行」が古くなるので、第2段で学習側を直したこと・表示の畳みは STEP5 のために残すことへ書き換える。コードは変えない）。
- 辞書の列・書く値・監査の形（§3・§5 に書いた以外）。`opsImportPartnerListToDictionary`・`opsMergePartnerNameVariants`・`registerDictionaryPattern`・`promoteToCommon` は変えない。
- `WEBAPP_*` の定数。
- 画面（`81_WebAppUi.html`）。
- **`src/97_Ops.gs` には文字列の中に生の NUL バイトが 2 つある。**消したり別の文字に置き換えたりしないこと（編集前後で `grep -c -a $'\x00'` 相当の数が同じであること）。

## 7. テスト（`test/phase8-webapp.test.js` に足す。名前は `kw17 N: …`）

既存のテストは 1 文字も変えない。足すのはこのファイルだけ。既存の補助（`setupWorld`・`seedDictionaryRow`・`dictionaryRows`・`seedPartnerViaWeb`・`webResolve`・`decision` など）は使ってよいが、書き換えない（要るなら新しい補助を足す）。

- **kw17 1**：同じ `(顧客, 元表記, 取引先名)` を `learnFromResolution` で 2 回学習すると、辞書は 1 行だけ増え、2 回目は 1 回目と同じ `dictId` を返し、監査の `DICT_REGISTER` も 1 件だけ増える。
- **kw17 2**：`resolveReview(..., 'ADOPT_EXISTING_PARTNER', {partnerName})` で、同じ店の要確認 2 件を同じ取引先で確定すると、辞書は 1 行だけ増える。
- **kw17 3**：同等行があっても競合フラグが立っていれば、学習は足さない（行数が変わらない）。
- **kw17 4**：同等でない既存行があるときは、学習は必ず 1 行足す。次の 8 通りをそれぞれ別の世界で確かめる：(a) 無効の行、(b) 取引先名が違う、(c) 元表記が違うが正規化表記は同じ（`AMAZON.CO.JP` と `ＡＭＡＺＯＮ．ＣＯ．ＪＰ`）、(d) 有効期間（終わり）つき、(e) 顧客が違う、(f) 一致方法が `prefix`、(g) 優先度が入っている、(h) 取引先名の大小だけが違う（`Amazon` と `amazon`）。
- **kw17 5**：`webAppResolveReviews` の 1 回の押下で同じ店の要確認 2 件を同じ取引先で確定すると、辞書は 1 行だけ増える。あわせて、採用 1 件の往復数（`gas.stubs.roundTrips()` の `rangeReads + rangeWrites + flushes`）を直す前後で測り、増えた数をテストの中のコメントと報告に書く（増えた数そのものを上限として固定しなくてよい）。
- **kw17 6**：辞書の行（`dictId` だけを持つ形）から `matchPartner` を呼ぶと、候補の `ruleId` が辞書の `dictId` になり、`matchMethod` が E 列の値になる。`ruleId`・`id`・`dictId` のどれも無い規則では `ruleId` が `''` になる（`'undefined'` ではない）。`ruleId` と `dictId` の両方を持つ規則は `ruleId` が勝つ。
- **kw17 7**：取込で作られた取引先の要確認（`webImport` → 要確認の行）の候補（Q 列と Z 列の `detail.candidates` の両方）の `dictId` が、辞書に置いた行の `dictId` と一致し、`matchMethod` が置いた行の値になる。どこにも `"undefined"` が現れない。
- **kw17 8**：`opsDedupeDictionaryRows()`（引数なし）と `opsDedupeDictionaryRows(false)` は、組と数を正しく報告し、辞書シートも監査ログも 1 セルも変えない。
- **kw17 9**：`opsDedupeDictionaryRows(true)` は、各組で行番号のいちばん小さい行を残し、ほかの行の O 列を偽・R 列を空でない値にする。**ほかの列（A〜N・P・Q）は 1 つも変わらない。**行数は変わらない。監査は無効化した行がある顧客ごとに 1 件（`reason: 'DEDUPE_DICTIONARY_ROWS'`）。もう一度 `true` で呼ぶと `groups: 0`・`deactivate: 0` で、何も書かない。
- **kw17 10**：組の中で、行番号のいちばん小さい行にはフラグが無く、2 番目の行にフラグがあるとき、残るのはフラグのある行。
- **kw17 11**：畳まれてはならない行がそのまま残る ── kw17 4 の (a)〜(h) に当たる行と、`exact_original` の行を同じ世界に置き、`apply` の後も全部の O 列が元のまま。
- **kw17 12**：**照合の結果が変わらない。**いろいろな行（同じ組の重複、フラグの有無が混ざった組、元表記違い・取引先名違い・期間つき・`prefix` など）を置いた世界で、いくつかの元表記について `readDictionary_` から作った索引で `matchPartner` を呼び、`autoConfirm`・`partnerName`・`matchedBy`・`conflict`・候補の取引先名の集合（重複を除いた集合）を、畳む前と後で比べて全部一致すること。候補の数は減っていること（少なくとも 1 つの元表記で）。
- **kw17 13**：書く直前の読み直しで、無効化する行の `dictId` が変わっていた（または既に無効になっていた）ら、1 セルも書かずに例外で止まる。作り方は実装者に任せる（たとえば最初の読取のあとで対象の行を書き換える仕掛けを `gas.evaluate` で差し込む）。

- **kw17 14**（1.1）：書く直前の読み直しで、無効化する行の `dictId` は同じだが**既に無効**になっていたら、1 セルも書かずに例外で止まる（kw17 13 は `dictId` の書換えしか見ていない）。
- **kw17 15**（1.1）：書く直前の読み直しで、**残す行**が (a) 既に無効になっていた、(b) 競合フラグが変わっていた、のどちらでも、1 セルも書かずに例外で止まる。(a)・(b) は別の世界で確かめる。
- **kw17 16**（1.1）：元表記・取引先名・顧客などは同じだが、**C 列が `normalizeMerchant(B 列)` と違う**（古い正規化表記の）有効行だけがあるとき、学習は 1 行足す（E4）。
- **kw17 17**（1.1）：顧客・元表記・取引先名が同じで**C 列だけが違う** 2 行（片方が古い正規化表記）は、畳む組にならない（`groups: 0`、どちらの O 列も変わらない）。
- **kw17 18**（1.1）：`ruleId: null`・`id: null`・`dictId: 'D'` の規則の候補の `ruleId` は `'D'`。`ruleId: null`・`id: 'ID'` なら `'ID'`。3 つとも `null` なら `''`。

## 8. 変異（自分で入れて、赤になることを確かめる）

入れて、`node test/run-tests.js` を回し、赤になるテストを記録して、戻す。

| # | 変異 | 赤になるはず |
|---|---|---|
| M1 | 学習の番人を外す（常に足す） | kw17 1・2・5 |
| M2 | 番人が元表記を見ず正規化表記で比べる | kw17 4(c) |
| M3 | 番人が有効フラグを見ない | kw17 4(a) |
| M4 | 番人が顧客を見ない | kw17 4(e) |
| M5 | 番人が有効期間を見ない | kw17 4(d) |
| M6 | 番人が一致方法を見ない | kw17 4(f) |
| M7 | 番人が取引先名を正規化して比べる | kw17 4(h) |
| M8 | 同等行があっても監査を書く | kw17 1 |
| M9 | `merchantRuleId_` が `dictId` を見ない | kw17 6・7 |
| M10 | 3 つとも無いとき `String(undefined)` を返す | kw17 6 |
| M11 | 候補に `matchMethod` を載せない | kw17 6・7 |
| M12 | `apply` が `undefined` でも書く | kw17 8 |
| M13 | 残す行をフラグで選ばない（常に最小の行番号） | kw17 10・12 |
| M14 | 組の鍵から元表記を外す（正規化表記で組む） | kw17 11・12 |
| M15 | 無効化でなく行を消す、または P・Q 列も書き直す | kw17 9 |
| M16 | 書く直前の読み直しを省く | kw17 13 |
| M17 | 組の対象に期間つきの行を含める | kw17 11 |
| M18 | 書く直前の読み直しで、無効化する行の `active` を見ない | kw17 14 |
| M19 | 書く直前の読み直しで、残す行を確かめない | kw17 15 |
| M20 | 学習の番人が E4（C 列）を見ない | kw17 16 |
| M21 | 畳む組の鍵から正規化表記を外す | kw17 17 |
| M22 | `merchantRuleId_` が `undefined` だけを「無い」と扱う（`null` を `'null'` にする） | kw17 18 |

## 9. 受入（本番。実装・監査・push の後、Claude がユーザーの許可を得て行う）

1. `opsDedupeDictionaryRows()`（見るだけ）を clasp で実行し、`groups`・`deactivate`・`largest` をユーザーに見せる。「Amazon」の組が出ることを確かめる。
2. ユーザーの許可を得てから `opsDedupeDictionaryRows(true)`。もう一度見るだけで `groups: 0` を確かめる。
3. 次に確定した取引先の要確認で、辞書が増えないこと（同じ店・同じ取引先）と、新しい要確認の候補に `"undefined"` が無いことを確かめる。

# 雛形の写しの「取引先一覧」タブを、マスターと照らしてから空にする（版 1.0、2026-11-13）

## 1. 背景と利用者の決定

- 2026-11-13、準備用の関数 `opsPrepareCustomerRegistration(…, true)`（`spec_customer_registration.md` §3.13）で、TEST01 の雛形を写した「雛形（個人）」を作った。写しで空にしたのは入力用シートのシステム列だけで、他のタブはそのまま写っている。
- 写しの「取引先一覧」タブには 4,474 行ある（A＝明細上の元表記、B＝freee の取引先名、C＝旧い照合キーの式）。テスト顧客（実際の明細で試した顧客）の店名と取引先名である。新しい顧客の転記シートは最初の記帳のときにこの写しから作られるので、このままだと全顧客の転記シートに写る。
- **利用者の決定（11-13）：「ここに入っているものが、マスターにちゃんと入っているか確かめて、それで問題無ければ消していい」。**
- システムはこのタブを照合に使わない（2026-10-12 から。`spec_partner_master.md` §1.2）。読むのは `validateCustomerAccess`（02）の A1 の読取確認と、もう使っていない `opsImportPartnerListToDictionary`（97）だけ。メニューの「一覧に無い名前」の案内（`knownPartnerNames_`）もマスターの一覧を見る。**1 行目（見出し）を残せば、空にしてもシステムの動きは変わらない。**
- 元の TEST01 の雛形の「取引先一覧」タブは触らない（元のデータはそこに残る）。

## 2. 作るもの

`src/59_CustomerRegistration.gs` に運用関数を 1 つ足す（エディタ・`clasp run-function` から呼ぶ。他の運用関数と同じく認可は呼ばない）。

```
opsCheckTemplatePartnerList(apply, accept)
```

- `apply`：`true` のときだけ書く。それ以外（省略・`false`・文字列の `"true"` など）は見るだけ。
- `accept`：分類のコードの配列（§3.3）。利用者が「それでも消してよい」と言った分類だけを入れる。省略は `[]`。

### 2.1 対象の確かめ（どれか 1 つでも外れたら何も書かない）

1. プロファイル（`CUSTOMER_TEMPLATE_PROFILE_INDIVIDUAL`）が読めて検査に通る（`registrationProfile_()`）。だめなら `stoppedBy: 'PROFILE_INVALID'`。
2. 対象のスプレッドシートは `profile.templateId` だけ。
3. `profile.templateId` が、顧客マスターの `profile.sourceCustomerId`（TEST01）の行の F（元の雛形）と同じなら `stoppedBy: 'CONFLICT'`。元の行が 1 行に決まらないときも `CONFLICT`。
4. 対象のファイル名が `雛形（個人）`（`registrationNameKey_` で比べる）でなければ `stoppedBy: 'CONFLICT'`。
5. タブの名前は `profile.columns.I`（取引先一覧のタブ名）。そのタブが無ければ `stoppedBy: 'TAB_MISSING'`。

### 2.2 タブの読み方

- 1 行目は見出し。2 行目から最後の行まで、A・B 列を読む（`importPartnerListForCustomer_` と同じ読み方。値は前後の空白を外した文字列）。
- A と B の両方がある行を「使える行」とする。片方だけ・両方空の行は `halfRows` に数えるだけ（止めない）。
- `normalizeMerchant(A)` が空の行も `halfRows` に数える。
- 同じ「`normalizeMerchant(A)` ＋ B」の行が 2 回目以降に出たら `duplicateRows` に数え、照らすのは 1 回だけ。

### 2.3 マスターの読み方（読むだけ）

- 共通取引先辞書（`readDictionary_(true)`）・顧客別取引先辞書（`readDictionary_(false)` のうち `customerId` が `profile.sourceCustomerId` の行）。**`active === true` の行だけ使う。**
- 共通取引先一覧（`readCommonPartners_()`）・顧客別取引先一覧（`customerPartnerRecords_(readCustomerPartnerRows_())` のうち `customerId` が `profile.sourceCustomerId` の行）。
- 取引先名は `partnerNameKey_` で比べる。顧客別の一覧で ACTIVE でなく寄せ先（`canonicalName`）のある名前は、寄せ先の名前も「同じ取引先」とみなす（揺れの寄せで辞書の取引先名が寄せ先に変わっているため）。

## 3. 照らし方と分類

### 3.1 店名（辞書）

使える行ごとに、`normalized = normalizeMerchant(A)`、`names = {B, B の寄せ先（あれば）}` として、上から順に最初に当たったもの：

| 結果 | 条件 | 止めるか |
|---|---|---|
| `inCommon` | 共通の辞書に `normalized` が同じで `partnerName` が `names` のどれかと `partnerNameKey_` で同じ行がある | 止めない |
| `DICT_ONLY_SOURCE` | 共通には無いが、TEST01 の辞書に同じ条件の行がある | 止める |
| `DICT_DIFFERENT_PARTNER` | 共通か TEST01 の辞書に `normalized` が同じ行はあるが、取引先名が `names` のどれとも違う | 止める |
| `DICT_MISSING` | どちらの辞書にも `normalized` が同じ行が無い | 止める |

`inCommon` のうち当たった行が競合の印（`conflict`）つきだけなら `inCommonConflicted` にも数える（止めない）。

### 3.2 取引先名（一覧）

使える行の B を、`partnerNameKey_` で重ねずに 1 回ずつ：

| 結果 | 条件 | 止めるか |
|---|---|---|
| `inCommonList` | 共通の一覧にある | 止めない |
| `viaCanonical` | 共通の一覧には無いが、TEST01 の一覧で ACTIVE でなく、寄せ先が共通の一覧にある | 止めない |
| `NAME_ONLY_SOURCE` | 共通の一覧に無く（寄せ先も無く）、TEST01 の一覧に ACTIVE である | 止める |
| `NAME_MISSING` | どちらの一覧にも無い | 止める |

### 3.3 書くかどうか

- 止める分類（`DICT_ONLY_SOURCE`・`DICT_DIFFERENT_PARTNER`・`DICT_MISSING`・`NAME_ONLY_SOURCE`・`NAME_MISSING`）の件数がすべて 0 なら `ok: true`。
- `apply === true` のとき、件数が 0 でない止める分類が **1 つでも `accept` に入っていなければ** `stoppedBy: 'NOT_IN_MASTER'` で何も書かない。
- `accept` に知らないコードがあれば `stoppedBy: 'BAD_ACCEPT'` で何も書かない。

## 4. 空にする手順（`apply === true` で、§2.1 と §3.3 を通ったときだけ）

1. 使える行が 0 で、2 行目から下に値が 1 つも無ければ `stoppedBy: 'ALREADY_EMPTY'` で何も書かない（監査も書かない）。
2. **監査を先に書く**：`appendAudit({type: 'SETTING', actor, targetType: 'TEMPLATE', targetId: profile.templateId, before: '', after: {tab: タブ名, rowsCleared: N, accept: accept}, reason: 'CLEAR_TEMPLATE_PARTNER_LIST'})`。店名・取引先名は監査に書かない。
3. 2 行目から最後の行まで、そのタブの全部の列の**値だけ**を消す（`clearContent`。書式・1 行目・他のタブ・他のスプレッドシートは触らない）。行は消さない。
4. 読み返して、2 行目から下に値が残っていれば `stoppedBy: 'WRITE_VERIFY_FAILED'`。
5. 報告の `cleared` に消した行の数、`applied: true`。

## 5. 返す値（見るだけと apply で同じ形。`Logger.log(JSON.stringify(report))` も同じ）

```
{
  applied, stoppedBy, ok,
  template: {name, tabName, lastRow},
  rows: {dataRows, usableRows, halfRows, duplicateRows},
  dictionary: {inCommon, inCommonConflicted, DICT_ONLY_SOURCE, DICT_DIFFERENT_PARTNER, DICT_MISSING},
  partnerNames: {distinct, inCommonList, viaCanonical, NAME_ONLY_SOURCE, NAME_MISSING},
  samples: {DICT_ONLY_SOURCE: [...], DICT_DIFFERENT_PARTNER: [...], DICT_MISSING: [...],
            NAME_ONLY_SOURCE: [...], NAME_MISSING: [...]},
  cleared
}
```

- `samples` は分類ごとに最大 30 件、`{row, original, partnerName}`（`DICT_DIFFERENT_PARTNER` は `masterPartners`（マスターでの取引先名、最大 3 つ）も）。利用者が判断するために見る（実データなので、テストには架空の値だけを使う）。
- ID（スプレッドシートの ID）は返さない。

## 6. 安全の条件（テストで確かめる）

- S1 見るだけでは何も書かない（シート・Drive・プロパティ・監査の書込が 0）。
- S2 書くのは `profile.templateId` の、取引先一覧のタブの 2 行目から下の値だけ。1 行目・他のタブ・元の TEST01 の雛形・マスターの辞書と一覧は 1 セルも変わらない。
- S3 止める分類が残り、それが `accept` に無ければ書かない。
- S4 監査は消すより先。
- S5 読み返して確かめる。
- S6 2 回目は書かない（`ALREADY_EMPTY`）。

## 7. テスト（`tpl N: …`、新しいファイル `test/phase10-template-partner-list.test.js`。値は全部架空）

1. 見るだけ（`apply` 省略・`false`・`"true"`）：各分類 1 件ずつの表で、数と `samples` が §3 のとおり。書込 0（S1）。
2. 全部 `inCommon`・`inCommonList`・`viaCanonical`（寄せ先で入っている行を含む）の表で `apply`：2 行目から下が空、1 行目は同じ、他のタブ・元の雛形・マスターの辞書と一覧は同じ、監査 1 件が消すより先、`cleared` が行の数（S2・S4）。
3. 止める分類 5 つのそれぞれ 1 つだけがある表で `apply` → `NOT_IN_MASTER`・書込 0。同じ表で `accept` にその分類 → 書く。止める分類が 2 つで `accept` に 1 つだけ → 書かない（S3）。
4. `halfRows`・`duplicateRows` は数えるだけで止めない。
5. `PROFILE_INVALID`（プロファイルが空・壊れている）・`CONFLICT`（`templateId` が TEST01 の F と同じ／元の行が 2 行／名前が「雛形（個人）」でない）・`TAB_MISSING`・`BAD_ACCEPT`：どれも書込 0。
6. 2 回目は `ALREADY_EMPTY`・書込 0・監査 0（S6）。
7. `clearContent` が効かないスタブで `WRITE_VERIFY_FAILED`（S5）。
8. `active: false` の辞書行は数えない（その行だけなら `DICT_MISSING`）。
9. 小さい字・ひらがなの違いは `partnerNameKey_` で同じとみなす（取引先名の比べ方）。

## 8. 変異（入れて回し、赤になるテストを記録して戻す）

| # | 入れる変異 | 赤になるはずのテスト |
|---|---|---|
| T1 | `NOT_IN_MASTER` の判定を外す | tpl 3 |
| T2 | 1 行目も消す | tpl 2 |
| T3 | 監査を消した後に書く | tpl 2 |
| T4 | TEST01 の F との比べを外す | tpl 5 |
| T5 | `active: false` の辞書行も数える | tpl 8 |
| T6 | 読み返しを外す | tpl 7 |
| T7 | 見るだけでも消す | tpl 1 |
| T8 | `accept` を見ずに全部受け入れる | tpl 3 |
| T9 | 寄せ先を見ない | tpl 2 |

## 9. 変えてよいファイル

- `src/59_CustomerRegistration.gs`（関数を足すだけ。既存の関数は変えない）
- 新しいテストファイル `test/phase10-template-partner-list.test.js`
- `test/gas-stubs.js`（足りないスタブを**足すだけ**。既存の振る舞いは変えない）

変えないもの：上に無いファイル全部。特に `97_Ops.gs`（開かない）・`02`・`34`・`37`・`71`・`80`・`81`。既存のテストを消す・弱める・飛ばすことはしない。

## 10. 本番での手順（Claude）

1. 実装・監査・全テスト → main へ取り込み → `clasp push`（`gas-push-N`）。
2. 見るだけ：`opsCheckTemplatePartnerList()`。数と `samples` を利用者に見せる。
3. `ok: true` なら、利用者の決定（11-13「問題無ければ消していい」）のとおり `opsCheckTemplatePartnerList(true)`。もう一度見るだけで `ALREADY_EMPTY` 相当（使える行 0）を確かめる。
4. `ok: false` なら、消さずに利用者に分類と例を見せ、マスターへ足すか・それでも消すか（`accept`）を聞く。

## 11. Claude の判断の記録（利用者の決定ではないもの）

1. 「マスターに入っている」は**共通**の辞書・一覧に入っていることとする（11-08 の決定「原則、共通に入れる」。TEST01 だけに入っている知識は、新しい顧客には効かない）。TEST01 だけの分は止めて利用者に聞く。
2. 店名は正規化した形（`normalizeMerchant`）で比べる。照合がその形で引くため。
3. 同じ店名がマスターでは別の取引先名になっている行（`DICT_DIFFERENT_PARTNER`）は、後の判断で直した跡かもしれないが、自動では決めずに止めて聞く。
4. 行は消さず値だけ消す。タブの形（書式・列の幅）と 1 行目の見出しを残す。

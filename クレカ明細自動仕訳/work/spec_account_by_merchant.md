# 店名で相手科目コード（C 列）を決める（ｍａｊｉｃａチャージ） 仕様書

作成日：2026-11-18
版：1.0
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いてあることは変えない。書いていないことは安全側で決め、決めたことは全部報告する。
前提：`work/spec_account_code.md`（相手科目コード 1.2。用途の言葉で C を決め、決まらない行の C には触らない）。

**この仕様書と、実装・テストには、実在の顧客名・顧客 ID・Drive の ID・明細の中身を書かない。**リポジトリは公開である。テストの値はすべて架空にする（`ｍａｊｉｃａチャージ` は公開されている決済サービスの名前で、規則そのものなので書いてよい。金額・日付・ほかの店名は架空）。

---

## 1. 何を作るか

### 1.1 背景（利用者の依頼と決定、2026-11-18）

- **依頼：**UCS カードの明細で、店名が「ｍａｊｉｃａチャージ」の行は、勘定科目を「事業主貸」にする（法人の顧客は「役員借入金」）。
- 今の C 列は**使用用途の言葉だけ**で決まる（`resolveAccountCode_`、`38`）。手元の明細では、この店名の行の用途は「チャージ」で、用途科目辞書に無いので C は空のまま（【科目コード】の「辞書に無い用途」に数えられる）。
- **利用者の決定（2026-11-18）：**
  1. **店名だけで決める**（どのカードの明細でも）。この店名は UCS カードの明細にしか出ないので結果は同じで、カードの見分け（形式）に頼らないので、形式が増えても漏れない。
  2. **取引先を立てない**（「私用」と同じく取引先なしで確定。取引先の要確認を作らない）。

### 1.2 本仕様がすること

1. 店名で科目を決める規則の表を**コードの定数**として持つ（§2）。今は 1 つ（ｍａｊｉｃａチャージ）。
2. 取込（`71` の 8-10）で、C の列を設定した顧客の取引の店名が規則に当たれば、**用途の言葉より先に**その規則で C を決め、取引先を立てない（§3）。

### 1.3 変えないもの・しないこと

- `resolveAccountCode_`（用途の言葉の当て方）の中身。規則に当たらない取引は今と 1 文字も違わない道を通る。
- 用途科目辞書・勘定科目一覧（シートの形・読み方）。新しいシートは作らない。
- **C の列を設定していない顧客**（AR が空）：今までとバイト単位で同じ（規則を見ない・取引先の扱いも今のまま）。
- 記帳済みの行・開いている取引先の要確認（後から直さない。これから取り込む行だけ）。
- 取引先の確定（1 件・まとめて）、相手税区分（G）、メモタグ（I）、摘要（K）。
- **`97_Ops.gs` は開かない・書かない**（文字列の中に生の NUL バイトがある）。

---

## 2. 規則の表（`39_AccountSeed.gs` に凍結した定数を足す）

```
var MERCHANT_ACCOUNT_RULES_ = Object.freeze([
  Object.freeze({
    merchant: 'ｍａｊｉｃａチャージ',
    codes: Object.freeze({INDIVIDUAL: 294, CORPORATE: 362}),
    withoutPartner: true
  })
]);
```

- `merchant`：店名。当て方は §3.1。
- `codes`：顧客の区分ごとのコード（`INDIVIDUAL` は `customer.customerCategory === CUSTOMER_CATEGORY.INDIVIDUAL`、それ以外は `CORPORATE`。`accountCustomerCategory_` と同じ分け方）。294＝事業主貸（個人だけ）、362＝役員借入金（法人だけ）。
- `withoutPartner`：`true` なら取引先を立てない。
- 表の中で、§3.1 の鍵が同じ規則が 2 つ以上あってはいけない（テスト mca 9 で確かめる）。

## 3. 取込（`38`・`71`）

### 3.1 当て方 `merchantAccountRule_(merchant)`（`38`、純粋な関数）

- `key = usageWordKey_(merchant)`（`partnerNameKey_` に空白の除去。全角・半角、大文字・小文字、ひらがな・カタカナ、小さい字・大きい字、空白の違いを同じとみなす）。空なら `null`。
- `MERCHANT_ACCOUNT_RULES_` のうち `usageWordKey_(rule.merchant) === key` の規則を返す（**店名の全体が同じときだけ**。含む・前方一致では当てない）。無ければ `null`。
- 例：`ｍａｊｉｃａチャージ`・`majica チャージ`・`ＭＡＪＩＣＡ　チャージ` → 当たる。`ｍａｊｉｃａチャージ返金`・`ｍａｊｉｃａ`・`マジカチャージ` → 当たらない。

### 3.2 コードを決める `resolveMerchantAccountCode_(rule, customer, masters, sheetList)`（`38`）

戻り値は `resolveAccountCode_` と同じ形 `{status, code, word, name?}`。

1. `category = customer.customerCategory === CUSTOMER_CATEGORY.INDIVIDUAL ? 'INDIVIDUAL' : 'CORPORATE'`。`code = rule.codes[category]`。整数でなければ `INVALID_ENTRY`。
2. 勘定科目一覧（`masters.accounts`）にそのコードの行が、`valid && active` で、`accountCategoryFitsCustomer_(行の対象, accountCustomerCategory_(customer))` を満たして**ちょうど 1 つ**なければ `INVALID_ENTRY`。
3. `accountListVerdict_(sheetList, code, 行の科目名)`：`NEEDS_LIST_ENTRY` なら `{status: NEEDS_LIST_ENTRY, code, word: rule.merchant, name: 行の科目名}`。`MATCHED` 以外は `NOT_IN_SHEET_LIST`（`code: null`）。
4. 通れば `{status: MATCHED, code, word: rule.merchant}`。

（`resolveAccountCode_` の手順 8〜10 と同じ守り。用途の言葉は見ない。）

### 3.3 取込の 8-10（`71`）

`transactions.map` の中で、**`accountMasters` があるとき（C の列を設定した顧客）だけ**：

```
var merchantRule = accountMasters ? merchantAccountRule_(tx.merchantOriginal) : null;
var cashback = isCashbackMerchant(customer, tx.merchantOriginal);
var exempt = cashback || isPartnerExemptPurpose(customer, tx.purpose) ||
  Boolean(merchantRule && merchantRule.withoutPartner === true);
```

- 規則に当たった取引は、取引先の照合をしない（`match = null`・`planned.f = ''`・`partnerResolutionStatus = RESOLVED_WITHOUT_PARTNER`）。今の `exempt` の道そのまま。取引先の要確認は作られない。
- C：`accountResolution = merchantRule ? resolveMerchantAccountCode_(merchantRule, customer, accountMasters, accountSheetList) : resolveAccountCode_(tx.purpose, customer, accountMasters, accountSheetList)`。後の扱い（`MATCHED` だけ `planned.c`、`NEEDS_LIST_ENTRY` は一覧への書き足し、件数の知らせ）は今のまま。
- **取引先を立てないのは、規則に当たったことだけで決まる**（C が `INVALID_ENTRY`・`NOT_IN_SHEET_LIST` で書けなくても、取引先は立てない。私用の取引であることは店名で決まっているため）。
- 前年分として除外した取引（`excludedTransactions`）は今のまま（C を付けない）。
- 新しい読取・書込は無い（規則はコードの定数。勘定科目一覧は今の読取の中にある）。

## 4. 安全の条件（テストで確かめる）

1. 規則に当たるのは店名の全体が §3.1 の鍵で同じときだけ。含む・前方一致では当たらない。
2. 規則に当たった取引は、用途の言葉（`仕入` など、優先の言葉も）に関係なく規則のコードになる。
3. 個人には 294 だけ、法人には 362 だけ。逆は書かない。
4. 勘定科目一覧に無い・無効・対象の合わないコードは書かない（C は空のまま、知らせの「辞書の誤り」に数える）。
5. 規則に当たらない取引は、C・F・取引先の状態・要確認が今と同じ。
6. C の列を設定していない顧客は、規則に当たる店名でも今と同じ（取引先も今の決め方）。
7. 読取・書込の回数は今と同じ。

## 5. テスト（`mca N: …`、新しいファイル `test/account-by-merchant.test.js`。値は全部架空）

既存の `test/phase6-account-code.test.js` の作り（取込の道を通すもの）に合わせる。

1. **mca 1**：個人の顧客・C の列あり。店名 `ｍａｊｉｃａチャージ`・用途 `チャージ` の行 → C＝294（数）、F は空、`partnerResolutionStatus` は `RESOLVED_WITHOUT_PARTNER`、取引先の要確認なし。同じファイルのほかの行（`仕入` → 712、辞書に無い用途 → C 空）は今どおり。
2. **mca 2**：法人の顧客 → 362。転記シートの一覧に 362 が無く空いた行がある → 一覧へ書き足して C＝362（`listAdded`）。
3. **mca 3**：鍵の揺れ：`majica チャージ`・`ＭＡＪＩＣＡ　チャージ`・`ｍａｊｉｃａ チャージ` は当たる。`ｍａｊｉｃａチャージ返金`・`ｍａｊｉｃａ`・`マジカチャージ`・空 は当たらない（`merchantAccountRule_` の単体と、取込の道の両方）。
4. **mca 4**：用途が `仕入`・`私用 仕入`・`ツール代` でも、店名が当たれば 294（個人）。
5. **mca 5**：勘定科目一覧で 294 が無い／有効が `FALSE`／対象が `法人だけ` → C は書かない（`invalidEntry` に数える）。それでも取引先は立てない。
6. **mca 6**：294 が転記シートの一覧で別の科目名（ぶつかる行）→ C は書かない（`notInSheetList`）。取引先は立てない。
7. **mca 7**：C の列が無い顧客 → 店名が当たっても、取引先の照合・要確認・書込・読取の回数が今と同じ。
8. **mca 8**：回数：規則に当たる行がある取込と無い取込で、`batchGet`・`batchUpdate` の数が同じ（一覧への書き足しが無い場合）。
9. **mca 9**：`MERCHANT_ACCOUNT_RULES_` の鍵が重ならない。各規則の `codes` は 2 つとも整数で、294・362 が `ACCOUNT_SEED_ACCOUNTS_` の対象（個人だけ・法人だけ）と合う。
10. **mca 10**：返金（AO の店名）の行・AM の用途の行・AN の用途の行は今どおり（規則に当たらない店名で）。

既存のテストは直さない。落ちたら止めて報告する。

## 6. 変異（入れて回し、赤になるテストを記録して戻す）

- R1：店名の全体でなく「含む」で当てる
- R2：規則より用途の言葉を先に見る
- R3：区分を見ずにいつも 294
- R4：規則に当たっても取引先を照合する（`exempt` に足さない）
- R5：規則に当たらない行も取引先を立てない
- R6：勘定科目一覧を確かめない（手順 2 を飛ばす）
- R7：`accountListVerdict_` を見ない（いつも `MATCHED`）
- R8：C の列が無い顧客にも規則を当てる
- R9：C が書けないときは取引先を立てる（取引先の扱いを C の結果に結びつける）

## 7. 変えてよいファイル

- `src/38_AccountCode.gs`：`merchantAccountRule_`・`resolveMerchantAccountCode_`
- `src/39_AccountSeed.gs`：`MERCHANT_ACCOUNT_RULES_`
- `src/71_RunOrchestrator.gs`：§3.3 の数行だけ
- `test/account-by-merchant.test.js`（新規）
- ほかのファイルを変えたくなったら止めて報告する。

## 8. 本番での手順と受入

1. Claude：差分を読む → main で全テスト → 利用者に push を聞く → 素の `clasp push`（前後の pull で一致を確かめる・`gas-push-N`）。シートの準備・運用関数は要らない。
2. 受入（利用者）：F5 → UCS カードの明細で［記帳を実行］→「ｍａｊｉｃａチャージ」の行の C が 294（D に「事業主貸」）、F が空、取引先の要確認が出ない。ほかの行は今どおり。

## 9. Claude の判断の記録（利用者の決定ではないもの）

- 規則はシートでなくコードの定数にした。今は 1 つで、増えるのはまれ。シートにすると、読み方・誤りの行・種の運用関数・シートが無い間の扱いが要り、誤りの入る所が増える。増やすときは定数に足して push する（テスト mca 9 が重なりを見る）。
- 店名の全体が同じときだけ当てる（含むで当てると、`ｍａｊｉｃａチャージ返金` のような別の取引まで事業主貸になる）。
- 規則は C の列を設定した顧客だけに効かせる（今の顧客は全員設定済み。設定の無い顧客の動きを変えない、という相手科目コードの約束を守る）。
- 取引先を立てないのは規則に当たったことだけで決める（C が書けない理由は一覧の都合で、取引の性質は変わらない）。

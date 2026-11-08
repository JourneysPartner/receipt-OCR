# 形式登録の「判定の不具合の疑い」を列の並びで見分ける 仕様書

版 1.0（2026-11-08）

前提：`work/spec_format_registration.md`（§6.1 `STATIC_COLLISION`・§6.2 警告）、`work/spec_format_panel_compact.md`（gas-push-137）。

## 1. 背景

利用者がエポスの明細（9 列。B 利用日・C 店名・E 金額・I 使用用途）を画面で登録しようとして、［試し読み］で止まった（2026-11-08）：

- `STATIC_COLLISION`（相手 `smbc_family_x9`「三井住友系Excel（9列・用途I）」）。`smbc_family_x9` の判定キーワードは 1 行目の「様」1 語だけ（`04_Provisioning.gs` の `installSmbcXlsxFormat`）で、エポスの 1 行目にも「様」があり、列数も 9 で重なる。型は 1 列目（日付のはず）・3 列目（金額のはず）とも見本 5 行すべてで外れる。**列の並びが本当に違う**ので、§6.1 が狙う「並びは同じなのに型だけ外れる＝判定の不具合」（§3 のイオン）ではない。今のままではエポスを登録できない。
- 警告 `RULES_NOT_INHERITED`（deposit）・`BILLING_MONTH_UNRESOLVED` の文が利用者に分からなかった。後者は年のない日付が 0 行で、実際には何にも効いていない。

利用者の決定（2026-11-08「はい、それで進めて」）：下の 1〜3 で直す。

## 2. 範囲

- 変えるのは `src/19_FormatRegistration.gs` の登録の検査（試し読み・保存で共通の検査）と、`src/81_WebAppUi.html` の知らせの文だけ。**取込・形式の判定（`13`）・抽出・形式の定義（`04`）は変えない。**
- 止める理由のうち `STATIC_COLLISION` の条件だけを変える。`TARGET_AMBIGUOUS`・`REFERENCE_COLLISION`・`NOT_MATCHING_TARGET` ほかは変えない。

## 3. 決めたこと

1. **`STATIC_COLLISION` は列の並びが同じときだけ止める。**今の条件（有効な形式 X の判定キーワードが対象で成立し、X の列数の範囲と対象の列数が重なり、差の段が `COLUMNS`）に当たった X ごとに：
   - **X の日付の列（`dateColumn`）と金額の列（`amountColumn`）が、回答の日付の列・金額の列とどちらも同じ位置**なら、今と同じく `STATIC_COLLISION`（X の形式 ID）で止める。位置は `detectorColumnIndex_` で比べる。
   - どちらかの位置が違うなら止めず、警告 `SIMILAR_FORMAT_LAYOUT_DIFFERS`（X の形式 ID）を出す。
   - **止める側に倒すとき：**回答の日付・金額の列のどちらかが空、または X が `dateColumn`・`amountColumn` を持たないときは、今と同じく止める。
   - 画面の文（`formatWarningMessage`）：「登録済みの形式「<X の形式名>」と見出し・列数は似ていますが、日付・金額の列の位置が違うので、別の形式として登録します。」（形式名は `STATIC_COLLISION` と同じく `formatNameForId` で引く）
   - **安全の理由：**並びが違えば、X の型の検査が X を外し続ける（取込で X に当たらない）。万一あとで 1 本のファイルが X と新しい形式の両方に当たっても、取込はそのファイルを `AMBIGUOUS` で止める（黙って記帳しない）。このファイル自体が X に当たるときは今と同じ `TARGET_AMBIGUOUS` で止まる。
2. **`RULES_NOT_INHERITED` の文を具体的に。**
   - サーバーの `derived.droppedRules` を、規則の ID の文字列の並びから、`{id, target, column, match, value}`（規則に無い項目は `null`）の並びに変える。`droppedRules` を使っているところ（警告の詳細のほか、あれば保存の記録など）を全部確かめ、形が変わって困るところが無いかを報告する。
   - 画面の文：規則ごとに、`target` が `cell` で `match` が `contains` なら「<column> 列に「<value>」を含む行を除く」、それ以外は「<id> の規則」。全体は「土台の形式の決まり（<規則の文を「、」でつなぐ>）は、列の位置で決めているので、この形式には引き継いでいません。この明細にそういう行があれば、取引として読みます。」
   - 詳細が古い形（文字列の並び）でも、文字列をそのまま「<id> の規則」として同じ文にする（保存済みの記録や古い応答を読んでも壊れない）。
3. **`BILLING_MONTH_UNRESOLVED` は年のない日付があるときだけ。**
   - サーバー：今の条件（`def.billingRule` があり請求年月が `RESOLVED` でない）に、**抽出の年のない日付の数（`extraction.year.yearless`）が 1 以上**を足す。詳細にその数を入れる。
   - 画面の文：「請求年月が読めないので、年の書かれていない利用日（<n> 行）の年を決められません。」
   - 理由：請求年月が要るのは年のない日付の年の補完だけ（`inferYearsForFile`）。日付の範囲の検査（`applyDateTriageChecks`）は請求年月が無いと処理日の月を基準にして続くので、年のある明細では止める理由が無い。試し読みの結果の 1 行（「請求年月 読めません。年のない日付 0 行のうち…」）は今のまま出す。

## 4. 守ること（安全の不変条件）

- **S1：**この変更の前に止まっていた「並びが同じで型だけ外れる」ファイル（fmt 25 の `aeon_x9` の形）は、変更の後も `STATIC_COLLISION` で止まる。
- **S2：**対象ファイルが有効な形式に当たるときは、今と同じく `TARGET_AMBIGUOUS` で止まる。
- **S3：**取込・判定・抽出の動きは 1 つも変わらない（`13`・`24`・`30`・`70`・`71` を変えない）。
- **S4：**回答の日付・金額の列が空なら止める側（`STATIC_COLLISION` を残す）。

## 5. テスト（`test/phase9-format-registration.test.js` に足す。coll 1〜7）

実在の明細の固定データは使わず、テストの中で作った架空の表（9 列。1 行目に「架空 太郎 様」などの文字、2 行目が見出し、3 行目から取引）を使う。有効な形式は今の `setup()`（`installSmbcXlsxFormat` などで `smbc_family_x9` が入る）。

1. **coll 1：**エポス形（A 列は日付でない文字、B 日付・C 店名・E 金額・I 使用用途、見出し行 2）を回答 B・C・E・I で試し読み → `blocking` に `STATIC_COLLISION` が無く、`warnings` に `SIMILAR_FORMAT_LAYOUT_DIFFERS`（`smbc_family_x9`）がある。ほかに止める理由が無ければ保存でき、保存の後、この表の判定は新しい形式 1 つだけで `RESOLVED`（`smbc_family_x9` に当たらない）。
2. **coll 2（S1）：**`smbc_family_x9` と同じ並び（A 日付・B 店名・C 金額・I 用途）で、A の日付を全部 `'abc'` にした表を回答 A・B・C・I で試し読み → `STATIC_COLLISION`（`smbc_family_x9`）で止まる。fmt 25 もそのまま通ること。
3. **coll 3：**日付の列は X と同じで金額の列だけ違う → 警告（止めない）。金額の列は同じで日付の列だけ違う → 警告。
4. **coll 4（S4）：**回答の日付の列を空にして試し読み → `STATIC_COLLISION` が残る（ほかの止める理由が並んでもよい）。
5. **coll 5：**`droppedRules` が `{id: 'deposit', target: 'cell', column: 'B', match: 'contains', value: 'ご入金'}` の形で返り、画面の文に「B 列に「ご入金」を含む行を除く」が入る。詳細が文字列の並び（`['deposit']`）でも「deposit の規則」と出て例外にならない。
6. **coll 6：**年のある日付だけの表でファイル名に年月が無い → `BILLING_MONTH_UNRESOLVED` が出ない。年のない日付（`12/10` の形）を含む表でファイル名に年月が無い → 出て、詳細が年のない日付の数。画面の文に「（<n> 行）」。
7. **coll 7：**`SIMILAR_FORMAT_LAYOUT_DIFFERS` の画面の文が形式名を出す（`formatPreview.formatNames` から引く）。警告の文が無いコードを見る既存のテスト（あれば）に新しいコードが入っている。

既存のテストは直さないこと（`RULES_NOT_INHERITED`・`BILLING_MONTH_UNRESOLVED` の詳細の形を確かめている既存テストがあって落ちたら、止めて報告すること）。

## 6. 変異（C1〜C10）

- C1：並びによらず止める（今の動き）
- C2：並びによらず止めない
- C3：日付の列だけ比べる
- C4：金額の列だけ比べる
- C5：回答の列が空のときに警告にする（S4 を外す）
- C6：並びが違うときに警告を出さない
- C7：`droppedRules` を文字列の並びのままにする
- C8：年のない日付が 0 でも `BILLING_MONTH_UNRESOLVED` を出す
- C9：`BILLING_MONTH_UNRESOLVED` を出さない
- C10：警告の文が形式名でなく形式 ID を出す

## 7. 本番での実行

テスト・監査の後、利用者の許可を得てからコミット → push（前後の pull 比較、タグ `gas-push-138`）。形式の定義・マスターには触らない。

## 8. 受入

利用者が F5 の後、止まっているエポスのファイルで［試し読み］→ `STATIC_COLLISION` が出ず、注意として「見出し・列数は似ていますが…別の形式として登録します」が出る →［保存して有効にする］→ 取込待ちへ戻して［記帳を実行］。そのファイルがショートカットの受入の明細なら、続けて `work/spec_shortcut_import.md` §8 の確かめ（2025 年の行が除外される）。

## 9. 監査の記録（2026-11-08）

- Codex（ログ `tools/codex-logs/*-20261108-195026-*`、session `01a1bac7-edc3-7eb1-9fae-5bba38414f51`、gpt-6.1-sol xhigh）：開始 1892/1892 → 終了 1905/1905。coll は 13 本（1〜7 と 4b・5b・6b・7b など）。作る前に coll 1・3・5・5b・6・6b・7・7b が赤。C1〜C10 はすべて赤。既存テストは無変更（fmt 25 も緑のまま＝S1）。変わったのは `19`・`81`・テスト 1 本だけ。新しいテストは架空の表だけを使う（固定データを使わない）。
- 仕様書の誤り：`smbc_family_x9` を入れるのは `installSmbcXlsxFormat` ではなく `installAnnotatedFormatsBatch1`（Codex の報告）。
- Codex の判断：列記号として読めない値も「列が分からない」として止める側（S4 と同じ）。`droppedRules` は警告の詳細と画面にだけ渡り、保存する形式の定義・登録の回答・監査の記録には入らない。古い形（文字列の並び）も画面で読める。
- 私の確認：差分を読んで S1〜S4 を確かめた（並びが分からないときは `STATIC_COLLISION` のまま、`TARGET_AMBIGUOUS` は無変更、取込・判定は無変更）。私の変異 M1（相手の形式に日付・金額の列が無いときに警告へ倒す）は coll 4b で赤。`???` 0 件、CR 0。

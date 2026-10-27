# 要確認の表に元ファイルのカードフォルダを出す 仕様書

版：1.1（2026-10-27。1.0 は既存の `kw2 1` が「その他」の行の項目名を完全一致で固定しているのを見落としていた ── Codex の指摘。§6 の冒頭に、変えてよい既存の期待 1 か所を足した）
対象：`src/80_WebApp.gs`（`webAppListReviews` と新しい部品 1 つ）・`src/81_WebAppUi.html`。
発端：2026-10-27、利用者「元ファイルに記載のあるファイルが、どのカードフォルダのものかわかりにくい。カードフォルダも表示して」（画面の「その他の要確認」の表。元ファイルは `meisai202504.xlsx` とだけ出ていた）。

## 1. 背景

- 右の列の要確認の表は 2 つある：取引先の表（`renderReviews`）と、いちばん下の「その他の要確認」（`renderOtherReviews`）。どちらも「元ファイル」の列はファイル名（Drive へのリンク）だけで、どのカードのファイルか分からない。月の名前だけのファイル（`202504.xlsx`・`meisai202504.xlsx` など）はカードをまたいで同じ名前になる。
- 一覧（`webAppListReviews`）が返す行は `fileId`・`fileName` を持つが、カードフォルダは持たない。要確認・処理ログ・恒久索引のどこにもカードフォルダは記録されていない。カードフォルダは「顧客のルートフォルダ（顧客マスターの `sourceFolderId`）の直下のフォルダ」で、元ファイルはその中にある（`webAppListFolder`・`webAppDirectChildFolder_`）。

**利用者の依頼（2026-10-27）：**元ファイルの列にカードフォルダも出す。**私の判断：**両方の表に出す（同じ問題なので）。絞り込みの欄でカード名でも絞れるようにする。

## 2. 決めたこと

1. **カードフォルダは Drive から引く。**記録の列は足さない（表の形を変えない）。一覧の呼出しごとに、その一覧に載る要確認の元ファイルだけを引く。
2. **Sheets の読取は増やさない。**引くのは Drive だけ（読取の枠 60 回/分は Sheets の話で、Drive は別）。既存の読取回数のテストの上限は変えない。
3. **引けなくても一覧は出す。**1 つのファイルで Drive が失敗しても、そのファイルのカードフォルダが空になるだけ。カードフォルダの一覧そのものが引けなくても、全部空で一覧は出す。
4. **同じファイルは 1 回だけ引く。**取引先の要確認は 1 ファイルに何十件もあるので、要確認ごとに引かない。

## 3. サーバー（`80_WebApp.gs`）

### 3.1 `webAppCardFolderNamesByFileId_(customer, fileIds)`（新規・非公開）

`webAppDirectChildFolder_` の近くに置く。戻り値は `fileId`（文字列）→ カードフォルダ名（文字列）か `null` の対応（`Object.create(null)`）。

1. `fileIds` を文字列にし、空を除き、重なりを除く。1 つも無ければ、**Drive を 1 回も呼ばずに**空の対応を返す。
2. カードフォルダの一覧：`DriveApp.getFolderById(customer.sourceFolderId).getFolders()` を 1 回なめて、フォルダ ID → 名前の対応を作る。ここで例外なら、すべての `fileId` を `null` にして返す。
3. ファイルごと：`DriveApp.getFileById(fileId).getParents()` をなめ、2 の対応にある最初の親の名前を採る。無ければ `null`。このファイルで例外なら `null`（ほかのファイルは続ける）。
4. 名前は `String(folder.getName() || '')`。空文字なら `null` と同じ扱い（画面に出さない）。

### 3.2 `webAppListReviews`

- 取引先の今のページ（`pageReviews`）と「その他」のページ（`otherPage`）の `fileId` を合わせて、3.1 を 1 回だけ呼ぶ（`customer` は選んだ顧客）。
- 取引先の行（`rows`）と「その他」の行（`otherRows`）の両方に `cardFolderName`（文字列か `null`）を足す。ほかの項目と並び・件数・読取は変えない。

## 4. 画面（`81_WebAppUi.html`）

- 純関数 `appendReviewFileCell(cell, review)`：`review.cardFolderName` が空でない文字列なら、先に `div`（class `review-folder`、`textContent` に名前）を入れ、その後に今の `appendDriveFileName(cell, review.fileId, review.fileName || '（ファイル名不明）')`。無ければ今と同じ（リンクだけ）。
- 取引先の表と「その他の要確認」の表の元ファイルのセルは、どちらもこの関数で作る（今の 2 か所の `appendDriveFileName` の呼出しを置き換える）。
- CSS：`.review-folder` は今の `.fix-reason` と同じ大きさ（11px）で、色は既存の控えめな文字色の変数（無ければ `.fix-reason` 以外の既存の灰色）。折り返しは `.review-file` と同じ（`overflow-wrap: anywhere`）。
- 絞り込み：`reviewMatchesFilter` が `review.cardFolderName` も見る（摘要・ファイル名と同じ正規化）。絞り込みの欄の案内文を「摘要・カード・ファイル名で絞り込み」にする。**既存のテストが今の案内文を期待していたら、変えずに止めて報告すること。**
- 文字はすべて `textContent`。`innerHTML` 等は使わない。

## 5. 変えないこと

- 一覧の行の並び・件数・既存の項目、確定・一括編集・ページ送り、ファイル一覧（中央の列）。
- Sheets の読取（既存の読取回数のテストは上限を変えずに緑のまま）。
- `appendDriveFileName`（中央のファイル一覧も使っている）。

## 6. テスト（`rf N: …`。サーバーは `test/phase8-webapp.test.js` の最後、画面は `test/phase9-format-registration.test.js` の world か `clientEval`）

**既存の期待を変えてよいのは 1 か所だけ（1.1）：**`kw2 1` の「その他」の行の項目名の一覧（`Object.keys(row).sort()` と比べる配列）に `'cardFolderName'` を 1 つ足す。このテストの目的（行に余計な項目を出さない）は保ったまま、今回わざと足す項目だけを認める。ほかの既存の期待は 1 つも変えない。

1. **rf 1（両方の表）**：2 つのカードフォルダにそれぞれ取引先の要確認のあるファイル、さらに形式不明のファイル（「その他」）を置く → 取引先の行・「その他」の行の `cardFolderName` が、それぞれのファイルのあるカードフォルダの名前。
2. **rf 2（1 ファイルだけ失敗）**：1 つの `fileId` で `DriveApp.getFileById` が投げる → その行だけ `null`、ほかの行は名前、一覧は返る。
3. **rf 3（カードフォルダの一覧が失敗）**：`getFolderById(...).getFolders()` が投げる → 全部 `null`、一覧は返る。
4. **rf 4（カードフォルダの外のファイル）**：顧客のルート直下でないフォルダにあるファイルの要確認 → `null`。
5. **rf 5（要確認が無い）**：Drive の `getFolderById`・`getFileById` を 1 回も呼ばない。
6. **rf 6（同じファイルは 1 回）**：同じファイルの取引先の要確認 3 件 → `getFileById` はそのファイルで 1 回。
7. **rf 7（Sheets の読取は増えない）**：`webAppListReviews` の Sheets 読取（`batchGet`）を、作る前と作った後で同じ世界で測り、**同じ値**であること（値を報告）。
8. **rf 8（画面）**：両方の表で、`cardFolderName` があればリンクの上に `review-folder` の行が 1 つ（文字が名前）、`null`・空なら無い。絞り込みにカード名を入れると、そのカードの行だけ残る。案内文が新しい文。
9. **rf 9（安全な描き方）**：`<img onerror=…>` のような名前もそのまま文字として出る。`appendReviewFileCell` に `innerHTML` 等が無い。

## 7. 変異（R1〜R10）── それぞれ赤になるテストを記録する

- R1：「その他」の行に `cardFolderName` を付けない
- R2：取引先の行に `cardFolderName` を付けない
- R3：ファイルごとの例外を拾わない（一覧ごと失敗する）
- R4：カードフォルダの一覧の例外を拾わない
- R5：重なりを除かない（要確認ごとに `getFileById`）
- R6：要確認が無くても Drive を呼ぶ
- R7：カードフォルダでない親も採る（最初の親の名前を無条件に採る）
- R8：絞り込みがカード名を見ない
- R9：画面がカード名を `innerHTML` で入れる
- R10：画面が片方の表でしかカード名を出さない

## 7.1 実装と監査の記録（2026-10-27）

- Codex 1 回目（`tools/codex-logs/*-20261027-161354-*`、gpt-6.1-sol・xhigh）：実装して rf 1〜9 は緑、既存の `kw2 1`（「その他」の行の項目名を完全一致で固定）とぶつかって停止 → 1.1。2 回目（`*-163206-*`）：1688/1688、R1〜R10 はすべて赤。rf 7 の Sheets 読取は 7→7。「その他」の表を描く関数の実名は `renderOtherReviewList`、CSS の色は既存の `--muted`。
- 監査：src の差分は 80（`webAppListReviews` に 3 行・新しい部品 1 つ）と 81（CSS 1 行・案内文・`appendReviewFileCell`・2 か所の置き換え・絞り込み）だけ、LF のまま。既存のテストで変わったのは `kw2 1` の 1 行だけ。`???` 0。全テスト 1688/1688 を私の手元でも確かめた。
- 実機の費用：一覧を読むたびに、載る要確認のファイルの数ぶん Drive を 2 回ずつ（親を引く）＋カードフォルダの一覧 1 回。テスト顧客（形式不明 5 ファイル）なら約 11 回。Sheets の読取の枠には数えない。

## 8. 受入（実機）

push 後、Web アプリを開き直して（F5）テスト顧客を選ぶ → 「その他の要確認」の `meisai202504.xlsx` の上にカードフォルダ名が出る。取引先の要確認があれば、そちらの元ファイルにも出る。絞り込みにカード名を入れると、そのカードの行だけ残る。

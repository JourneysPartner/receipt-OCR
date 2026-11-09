# 「このカードの転記シート（Excel）」を要確認欄の下へ移す 仕様書

- 1.0（2026-11-09）利用者の依頼から起こした。
- 1.1（同日）Codex 1 回目が正しく止まった 2 点を直した：既存の dl 11 が旧配置を 1 行で固定していた（§4 に扱いを足した）／`.other-review-section` に専用の CSS は無く、余白は見出し `.subheading` の上の余白（15px）で付いている（§3 の 3 を直した）。

## 1. 背景

利用者の依頼（2026-11-09）：「この部分（このカードの転記シート（Excel））は右側の『要確認』欄の下に出るようにして。最終確認等をするのは要確認が無しになってからだから、順番的にその方が良い。」

今は真ん中の「Drive フォルダ」欄の中（`#drive-content` の中、ファイル一覧 `#file-list` と取込の進み具合 `#import-progress` の間）にある。作業の順は「真ん中でファイルを選んで記帳 → 右で要確認を片付ける → 最終確認と Excel」なので、最終確認の入口は要確認の後ろに置く。

## 2. 範囲

- 変えるのは `src/81_WebAppUi.html` の置き場所（と、間を空けるための CSS）だけ。
- 一覧の中身・出す条件・文言・ボタン・読み込み（`renderDestinations`・`loadDestinations`・`chooseDestination` ほか）は変えない。
- `src/*.gs` は変えない。

## 3. 決めたこと

1. `<div id="destination-list" hidden></div>` を `#drive-content` から外し、要確認の欄（`<section class="panel reviews">`）の `.panel-body` の**最後の子**として置く。つまり `#review-content`（要確認の表・確定のボタン・`#final-summary`・その他の要確認 `#other-review-section` を含む）の**後ろ**、`#review-content` の外。
   - `#review-content` の中に入れない理由：`#destination-list` の出し入れは今どおり `state.selectedFolderId` だけで決める（`renderDestinations` の `section.hidden = !state.selectedFolderId`）。`#review-content` の出し入れに引きずられないようにする。
2. 見出し「このカードの転記シート（Excel）」と、その下の表・文・ボタンは今のまま。
3. 上の要確認との間は、一覧の見出し（`h3.subheading`）が持つ上の余白（15px）で空く。「その他の要確認」も同じく見出しの余白だけで空いているので、**CSS は足さない・変えない**（1.1）。
4. 真ん中の欄に残るもの（カードフォルダ・ファイル一覧・取込の進み具合・［記帳を実行］）の順は変えない。
5. 幅の狭い画面（`@media` で `.panel.reviews` が横いっぱいになる形）でも、同じく要確認の下に出る（置き場所を変えるだけなので、特別な処理は要らない）。

## 4. テスト（`test/phase9-format-registration.test.js` の dl のテストの近くに）

- **move 1**：`src/81_WebAppUi.html` の本文で、`id="destination-list"` が `<section class="panel reviews"` の開始より後ろ、その `</section>` より前にあり、`id="other-review-section"` の `</section>` よりも後ろにあり、`id="review-content"` の `<div>` の閉じより後ろにある。
- **move 2**：`id="destination-list"` が `<section class="panel drive"` の中（`id="drive-content"` の中）に無い。HTML の本文で `id="destination-list"` はちょうど 1 回だけ出る。
- **move 3**：真ん中の欄の順が今のまま：`id="folder-list"` → `id="file-list"` → `id="import-progress"` → `id="import-button"`。
- 既存の dl のテスト（dl 8 ほか、`destination-list` を見るもの）は直さずに通ること。**例外は dl 11 の 1 行だけ**（1.1）：`assert.match(source, /<div id="file-list"><\/div>\s*<div id="destination-list"[^>]*><\/div>/);` は旧配置を固定しているので、新しい配置（`id="other-review-section"` の `</section>` と `#review-content` の閉じ `</div>` の後ろに `<div id="destination-list" hidden></div>` が続く）を確かめる 1 行に置き換える。dl 11 のほかの行は変えない。

数え方は、HTML の本文の文字列で位置を比べるだけでよい（仮の DOM は HTML から木を作らないため）。`</section>` の対応は、`<section class="panel reviews"` の後ろで最初に出る `<section class="panel` か `</main>`（どちらか先）までを要確認の欄とみなしてよい。

## 5. 変異（入れて赤になることを確かめて戻す）

- **D1**：`#destination-list` を `#drive-content` の元の場所へ戻す → move 1・move 2 が赤。
- **D2**：`#destination-list` を `#review-content` の先頭（`#other-reviews` の前）に入れる → move 1 が赤。
- **D3**：`#destination-list` を要確認の欄の `.panel-header` の中に入れる → move 1 が赤。
- **D4**：`#destination-list` を 2 か所に置く（元の場所にも残す）→ move 2 が赤。
- **D5**：真ん中の欄で `#import-progress` を `#file-list` の前へ動かす → move 3 が赤。

## 6. 受入（利用者）

F5 → 顧客を選ぶ → カードフォルダを選ぶ → 右の要確認欄の下に「このカードの転記シート（Excel）」が出る。真ん中の欄には出ない。［最終確認と Excel］が今どおり動く。

## 7. 実装と確認の記録（2026-11-09）

- Codex 1 回目：開始 1930/1930。既存の dl 11 が旧配置を固定していたので、指示どおり何も変えずに停止 → 1.1。
- Codex 2 回目（同じセッションの再開）：move 1〜3 を足し、dl 11 の 1 行だけ新しい配置に置き換え。終了 1933/1933（再実行なし）。作る前は move 1・2 が赤、move 3 が緑。D1〜D5 すべて赤（D1：move 1・2・dl 11、D2・D3：move 1・dl 11、D4：move 2、D5：move 3）。
- Claude の確認：`src/81_WebAppUi.html` の差分は `#destination-list` の 1 行の移動だけ（CSS・JavaScript・`.gs` は不変）。変わったファイルは 81 とテストの 2 つだけ（md5 の控えと比べた）。LF・UTF-8 のまま。`phase9-format-registration.test.js` を手元で回して 183/183。

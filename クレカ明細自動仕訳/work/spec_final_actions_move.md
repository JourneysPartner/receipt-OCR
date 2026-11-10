# 最終確認の結果とボタンを「このカードの転記シート」の下へ移す 仕様書

版：1.0（2026-11-10）
対象：`src/81_WebAppUi.html` だけ。
発端：2026-11-10、利用者の依頼。右の要確認の欄の並びを、上から「このカードの転記シート（Excel）」→「最終確認：…」の結果の文 →［最終確認を表示］［Excel ダウンロード］のボタン、にしたい（最終確認は要確認が無くなってから、どの転記シートかを見てから行うので、その順に並べる）。

## 1. 今の並び（要確認の欄 `<section class="panel reviews">` の `.panel-body`）

```
#review-empty
#review-content
  … 要確認の表・ページ送り・#resolve-progress
  .action-row：#resolve-button［選択した要確認を確定］・#final-button［最終確認を表示］・#excel-button［Excel ダウンロード］・#excel-status
  #final-summary（最終確認の結果の文）
  #other-review-section（その他の要確認）
#destination-list（このカードの転記シート。#review-content の外。出し入れは state.selectedFolderId だけで決める）
```

## 2. 変えたあとの並び

```
#review-empty
#review-content
  … 要確認の表・ページ送り・#resolve-progress
  .action-row：#resolve-button だけ（［選択した要確認を確定］は要確認の表の下に残す）
  #other-review-section
#destination-list（今のまま）
#final-area（新しい。hidden で始める）
  #final-summary（今と同じ要素・属性。中身は今のまま）
  .action-row：#final-button・#excel-button・#excel-status（今と同じ要素・属性・文字）
```

- 要素の id・class・属性・文字は変えない（動かすだけ）。どの id も本文にちょうど 1 回。
- `#final-area` は `#review-content` と同じ条件で出し入れする：`renderSelection` で `el['final-area'].hidden = !hasCustomer;`（`el` の id の一覧に `'final-area'` を足す）。`#final-summary` 自身の出し入れ（`kind` が無ければ隠す）は今のまま。
- ボタンの押せる・押せないの規則、押したときの動き、`#excel-status` の文は変えない。
- CSS は要るときだけ足す（`#final-area` の上に少し間を空けるなど）。足したら報告する。

## 3. 変えないこと

- `#destination-list` の場所と出し入れ（`renderDestinations`）。
- 要確認の表・確定・その他の要確認・最終確認の欄（`#final-panel`）・形式の欄。
- サーバー（`.gs`）。

## 4. テスト（`fa N: …`。既存の画面のテストの並び＝`test/phase9-format-registration.test.js` に足す）

1. **fa 1（並び）**：本文で、要確認の欄の `.panel-body` の中に、`#review-content` の閉じ → `#destination-list` → `#final-area` の順に並ぶ。`#final-area` の中で `#final-summary` → `#final-button` → `#excel-button` → `#excel-status` の順。`#resolve-button` は `#review-content` の中に残り、`#final-button` と同じ `.action-row` に無い。`final-area`・`final-summary`・`final-button`・`excel-button`・`excel-status`・`resolve-button`・`destination-list` の id がそれぞれちょうど 1 回。
2. **fa 2（出し入れ）**：顧客を選んでいないとき `#final-area` は隠れ、選ぶと出る（`#review-content` と同じ）。顧客を選んでいても、最終確認の結果が無ければ `#final-summary` は隠れたまま。
3. **fa 3（動き）**：［最終確認を表示］［Excel ダウンロード］の押せる・押せない・押したときの呼出しが今と同じ（既存のテストがあればそれが直さずに通ること。無ければ 1 つずつ確かめる）。
- 既存のテストは直さずに通ること。例外：`#final-button` などの**場所**を固定しているテスト・`#destination-list` が「`.panel-body` の最後の子」であることを固定しているテストは、新しい並びを確かめる形に直してよい（直したものはすべて報告）。

## 5. 変異（F1〜F5）── それぞれ赤になるテストを記録して戻す

- F1：`#final-area` を `#destination-list` の前に置く
- F2：`#final-summary` をボタンの下に置く
- F3：`#final-button` を `#resolve-button` の行に残す（2 か所に置く）
- F4：`#final-area` の出し入れをしない（顧客を選んでいなくても出る）
- F5：`#resolve-button` も `#final-area` へ動かす

## 6. 受入（利用者）

F5 → 顧客とカードフォルダを選ぶ → 右の欄で、要確認の表と［選択した要確認を確定］の下に、「このカードの転記シート（Excel）」→ 最終確認の結果の文 →［最終確認を表示］［Excel ダウンロード］の順に並ぶ。

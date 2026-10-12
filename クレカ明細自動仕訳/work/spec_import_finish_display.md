# 取込・確定が終わったことを分かるようにする 仕様書（画面だけ）

版：1.0（2026-10-12）
対象：`src/81_WebAppUi.html` だけ。サーバー（`.gs`）は変えない。
発端：K-W22 の実機受入（2026-10-12、SAISON_2504）。利用者は取込の終わりと【要修正】のお知らせに気付かなかった。

## 1. 何を直すか

3 つとも「取込（確定）が終わったことが分かりにくい」の一部である。

1. **進捗の矢印「→→→」が、取込・確定をしていないときも出たまま。**
   `.progress-arrows { display: inline-flex; ... }`（CSS）が `hidden` 属性を打ち消している。`hidden` はブラウザの既定の CSS（`[hidden] { display: none }`）で消えるだけなので、作者の CSS が `display` を指定すると効かなくなる。JS は `el[...-arrows].hidden = true/false` を正しく切り替えているが、見た目に反映されない。実機のスクリーンショットで、記帳の前から［記帳を実行］の上と［選択 0 件を確定］の上に「→→→」が出ていた。
   テストは DOM の stub で `.hidden` の値しか見ないので、緑のまま通っていた。
2. **終わった後も「処理中 1 / 1（経過 0:51）」の文字が残る。**
   `startProgressTimer` の `stop()` は矢印と案内を隠すだけで、見出しの「処理中 」をそのまま残す。終わったのか止まっているのか分からない。
3. **終わったときのお知らせ（`#notice`）が画面の外に出る。**
   お知らせ欄はページの上端（段階の表示の下、3 カラムの上）にある。［記帳を実行］や［選択した要確認を確定］はカラムの下の方にあり、押した利用者はそのあたりを見ている。お知らせが出ても、ページの上端が画面の外なら見えない。2026-10-12 の受入で、利用者は「【要修正】SAISON_2504.xlsx：使用用途が空：…81 行目」のお知らせを見ていない。

## 2. 直し方

### 2.1 矢印の `hidden` を効かせる（CSS）

`.progress-arrows { ... }` の直後に次の 1 行を足す：

```css
.progress-arrows[hidden] { display: none; }
```

`.progress-arrows` の既存の規則（`display: inline-flex` 等）・アニメーション・`prefers-reduced-motion` の規則は変えない。

### 2.2 止めたら見出しを「終了」にする（`startProgressTimer` の `stop()`）

`stop()` の中、矢印と案内を隠した後で：

- 見出し（`el[progressId + '-label'].textContent`）が `'処理中 '` のときだけ `'終了 '` にする。
- 値（`el[progressId + '-value'].textContent`、例 `1 / 1（経過 0:51）`）は**消さず、そのまま残す**（かかった時間が分かるように）。
- 見出しが `'処理中 '` でなければ（`clearProgressDisplay` で空にされた後など）触らない。

結果、終わった後の表示は `終了 1 / 1（経過 0:51）` になる。取込も確定も同じ `stop()` を通るので両方に効く。

決まりごと：

1. 語は「終了」。失敗・時間切れ・中断でも `stop()` は呼ばれるので、「完了」は使わない（結果の良し悪しはお知らせが言う）。
2. `progressText`・`renderProgress` は変えない（`imp 9` が `'処理中 3 / 12（経過 1:23）'` を固定している）。
3. 止めた後に経過表示を更新しない既存の振る舞い（`imp 10`）は変えない。

### 2.3 お知らせを出したら見える位置へ寄せる（`showNotice`）

`showNotice` の最後（中身を作り終えた後）で：

```js
if (typeof el.notice.scrollIntoView === 'function') el.notice.scrollIntoView({block: 'nearest'});
```

- `block: 'nearest'` にする。お知らせが既に画面に見えていればページは動かない。見えていないときだけ、お知らせが画面の端に入るぶんだけ動く。
- `behavior` は指定しない（既定＝すぐ動く）。動きを減らす設定の人にもそのまま効く。
- `scrollIntoView` が無い環境（テストの stub など）では何もしない。例外を投げない。
- `showNotice` を呼ぶ全部の箇所に効かせる（呼出し側は変えない）。いまの呼出しはどれも、利用者の操作の結果か失敗の知らせなので、見せてよい。`clearNotice` は動かさない。

## 3. 変えないこと

- サーバーの関数・戻り値・読取回数（`.gs` は 1 文字も変えない）。
- お知らせの文言・種類・中身（`customerFixNoticeLines` など）、お知らせ欄の置き場所（HTML の並び）。
- 進捗の文言（`progressText`）、60 秒の案内（`processingHint`・`resolvingHint`）、矢印のアニメーション。

## 4. テスト（`ui N: …`、`test/phase8-webapp.test.js` の `imp 11` の後）

1. **ui 1**：CSS に `.progress-arrows[hidden]` で `display: none` の規則がある（`WEBAPP_UI_SOURCE` を正規表現で見る）。`import-progress-arrows`・`resolve-progress-arrows` の要素が HTML で `hidden` 属性つきで始まる。
2. **ui 2**：`startProgressTimer('import-progress', …)` → `update(1, 1)` → 時計を進めて描く → `stop()`。見出しが `'終了 '`、値は止める直前の値のまま（`'1 / 1（経過 0:51）'` のような形）、矢印 `hidden === true`、案内 `hidden === true`。`resolve-progress` でも同じ。
3. **ui 3**：見出しが `'処理中 '` でないとき（空など）、`stop()` は見出しを変えない。
4. **ui 4**：`showNotice('1 件を取り込みました。', 'success', ['【要修正】a.xlsx：使用用途が空：5 行目'])` → `el.notice.scrollIntoView` がちょうど 1 回、引数 `{block: 'nearest'}` で呼ばれる。お知らせの中身（文と箇条）は今と同じ。
5. **ui 5**：`el.notice` に `scrollIntoView` が無くても `showNotice` が例外を投げず、中身を作る。

`clientEval` の sandbox の `document` に `createElement` が要るなら、そのテストの中で stub を渡す（共通の補助を変えるなら報告）。

## 5. 変異（Q1〜Q8）── それぞれ赤になるテストを記録する

- Q1：2.1 の CSS の行を消す
- Q2：2.1 を `display: inline-flex` のまま `[hidden]` に `visibility: hidden` を当てる形にする
- Q3：`stop()` で見出しを `'完了 '` にする
- Q4：`stop()` で見出しを変えない
- Q5：`stop()` で値も空にする
- Q6：`stop()` が見出しを無条件に `'終了 '` にする（`'処理中 '` の確認を外す）
- Q7：`scrollIntoView` に `{block: 'start'}` を渡す
- Q8：`scrollIntoView` を `kind === 'error'` のときだけ呼ぶ

## 5.1 実装と監査の記録（2026-10-12）

- Codex（`tools/codex-logs/*-20261012-164905-01.txt`）：開始 1427/1427 → 終了 1432/1432（ui 1〜5）。直す前は ui 1・2・4 が赤、ui 3・5 は緑。Q1〜Q8 はすべて赤（Q1・Q2→ui 1、Q3〜Q5→ui 2、Q6→ui 3、Q7・Q8→ui 4）。
- 監査：src の差分は `81_WebAppUi.html` の 5 行の追加だけ（§2.1〜2.3 のとおり）、テストは追加だけ、他の src・test は開始時の md5 と一致。`???` 0、U+FFFD 0、97 の NUL 2 個。
- 私の変異 2 個：「確定の進捗では終了にしない」は ui 2 が赤。**「スクロールを `showNotice` の先頭（visible を付ける前）に置く」はすり抜けた** ── ブラウザは `display: none` の要素へスクロールしないので、実機では黙って効かなくなる。ui 4 の stub が呼ばれた時点の `className` と子の数を記録し、`notice visible success`・2 を確かめるように補強した（テストだけの直し）。補強後は赤。

## 6. 受入（実機）

push 後、Web アプリを開き直して（F5）：

1. 何もしていないとき、［記帳を実行］の上と［選択した要確認を確定］の上に「→→→」が無い。
2. 取込中は「処理中 →→→ n / m（経過 …）」が動き、終わると「終了 n / m（経過 …）」になって矢印が消える。
3. ページを下へ送って［記帳を実行］を押すと、終わったときにお知らせが見える位置までページが動く。

**受入の結果（2026-10-12、gas-push-111）：合格。**セゾンカード（取込待ち 0 本）で確かめた。1：待機中、記帳・確定の上に矢印なし。2：`終了 0 / 0（経過 0:07）`、矢印なし。3：ページの最下部から押すと、終わったときにお知らせ（`このフォルダに取り込めるファイルはありません。`）が GAS の帯のすぐ下に来る位置までページが動いた（1 回目は利用者が自分でスクロールしたか曖昧だったので、触らずに待つ形でやり直した）。GAS の帯「このアプリケーションは…」はスクロールしても画面に残る ── スクロールは iframe の中で起きており、`scrollIntoView` は外側（別オリジン）のページに頼らず効く。

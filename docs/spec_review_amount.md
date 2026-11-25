# レシート OCR: 要確認の行に、読み手の間で合った金額を M 列へ書く 仕様 1.2

対象は直下の `src/`（Python の Cloud Run Job）の本番の流れ（`RUN_MODE=prod`・`validate`）の **両読み（`AI_FLOW=dual`）の要確認の行だけ**。クレカ明細（`クレカ明細自動仕訳/`）には触れない。土台は `docs/spec_read_quality.md`（両読み）・`docs/spec_second_reader.md`（形 B）・`docs/spec_duplicates.md`（重複）。

**高リスク**（会計の帳簿に書く金額が変わる）。実装 → 監査 → 利用者の了解で push の順を守る。

## 1. 目的

利用者の指摘（2026-11-25）: 要確認の行は M 列（支出金額）が空。今の決まり（`write_manual_entry_row` は M を書かない）は、金額が怪しい行に誤った金額を残さないため。

試し（2026-11-25、テスト用の顧客、61 本。`spec_second_reader.md` §14）の答えと照らすと、要確認の行の多くは **金額は読み手の間で合っていて、日付だけが割れた** 行だった（合った金額はすべて正しかった）。金額が食い違った行では、主の画像からの金額が誤りのものがあった（全部の要確認の行に金額を入れると、誤った金額が入る）。

利用者の決定（2026-11-25）: **読み手の間で金額が合っている要確認の行は M 列に金額を入れる。金額が食い違う行は今までどおり M 列を空にする。** 直すのは日付だけで済むようにする。

## 2. 作業範囲

- 変える: `src/processing/reconcile.py`（純粋な関数を 1 つ足す。`reconcile` の中身は変えない）、`src/processing/manager.py`（両読みの要確認の行を書く所だけ）、`src/sheets/client.py`（`write_manual_entry_row` に名前つきの引数を 1 つ足す）、`tests/`、`README.md`。
- 変えない: 今までの流れ（`text_first`）、比較（`RUN_MODE=compare`）、`src/ai/`・`src/drive/`・`src/ocr/`・`src/rules/`・`src/compare/`・`src/config.py`・`src/main.py`、`src/processing/duplicates.py`、`requirements.txt`、`.github/workflows/`、`Dockerfile`、`クレカ明細自動仕訳/`、`docs/`。
- 処理管理・AI 詳細ログの見出しと列は変えない。出納帳の列も変えない（M 列に書く場合が増えるだけ）。
- テストのデータは架空のものだけ。実際のレシートの値・店名・フォルダ ID・鍵の値を書かない。

## 3. 安全の条件（変えない。すべてテストで確かめる）

今までの条件（`spec_read_quality.md` Q1〜Q6、`spec_duplicates.md` D1〜D8、`spec_second_reader.md` N1〜N12）はすべて残す。ただし N1（もう 1 人なしは今のまま）と `spec_second_reader.md` §6 の「K 列の短いラベルは D0 のラベルのまま」は、**§4 の条件で M に金額を書く行だけ** この仕様で変わる（利用者の決定）。足すもの:

- **W1 書くのは金額が合った行だけ**: M に金額を書くのは、両読みの要確認の行のうち、§4 の条件を全部満たす明細だけ。ほかの要確認の行（金額が食い違う・桁の疑い・明細数・読み直し・読みが無い・失敗など）は、`write_manual_entry_row` の引数・書く文・ラベルが今と 1 つも変わらない。
- **W2 書く金額は主の画像から**: M に書くのは主の画像からの金額（`CorrectedItem.amount`。今の自動の行と同じ値）。もう 1 人・文字からの値は書かない（N3 と同じ）。§4 の条件では、合った相手の金額と同じ値になる。
- **W3 桁の検査は必ず掛かる**: Vision の文字が無い（OCR が失敗か空）明細には書かない。書く前に `validate_amount(金額, Vision の文字)` が `digit_inflation` なら書かない（`reconcile` は「日付が食い違う」の判定に桁の検査を掛けないため、ここで必ず掛ける）。
- **W4 読み直しの守りが勝つ**: 前の回の印があるファイル（`_has_numbered_marks`）の明細には書かない（二重の計上を避ける。N5 と同じ）。
- **W5 要確認のまま**: M に書いた行も要確認の行のまま（K 列のラベル・O 列の文・処理管理の `manual_entry`・AI 詳細ログの `needs_review`・`【済】` を付けない）。数える結果（`manual_entry` など）も今と同じ。
- **W6 ほかの道は変わらない**: 今までの流れ（`text_first`）の要確認の行・`_manual_entry`（ダウンロード失敗・抽出失敗）・`_write_amount_invalid_as_manual`・自動の行を書くときの失敗の代わりの行・画像からが空で文字からだけの明細・比較は、今と同じ（M を書かない）。
- **W7 止めない**: §4 の判定は例外を投げない純粋な関数。判定できなければ書かない側（今と同じ）に倒す。
- **W8 検証では書かない**: `RUN_MODE=validate`（dry_run）では今までどおり何も書かない。予定の件数も今と同じ。

## 4. M に金額を書く条件（全部を満たすときだけ）

明細 i（主の画像からの i 番目）について:

1. 両読みで、主の画像からの明細がある（D0 = `reconcile(主の画像から, 主の文字から, Vision の文字)` がある）。
2. D0[i] のラベルが `※明細数要確認`・`※再読取要確認` ではない（明細数の疑いは枚数の見落としを先に見てもらう。読み直しは二重の計上を避ける）。
3. **金額が合った**: D0[i] のラベルが `※日付要確認`（＝主の文字からに同じ金額がある）か、もう 1 人を呼んだファイルで Dx[i]（`reconcile(主の画像から, もう 1 人の画像から, Vision の文字)`）のラベルが `※日付要確認`（＝もう 1 人に同じ金額がある）。
4. 主の画像からの金額が 1 以上の整数（`bool` でない）。
5. Vision の文字がある（空白だけでない）。
6. `validate_amount(金額, Vision の文字).status` が `digit_inflation` でない。
7. 支出の明細（`is_expense` が真。自動の行と同じく、収入の列は無いので書かない）。
8. そのファイルに番号 0 以上の処理済みの印が無い（W4）。

判定は `src/processing/reconcile.py` に足す純粋な関数（例: `review_amount(画像からの明細, D0[i], Dx[i] か None, Vision の文字) -> int | None`）で行う。API もファイルも触らない・例外を投げない・条件を満たさなければ `None`。8 の印の有無は `manager.py` が渡すか、印があれば呼ばない。

## 5. 書くもの（M に金額を書く行だけ。ほかの行は 1 字も変えない）

- **M 列**: §4 の金額（`write_manual_entry_row` の名前つきの引数 `amount: int | None = None`。`None` なら今と同じ要求を送る。1 以上の整数のときだけ、`支出金額` の列が列の対応にあり、守る列でなければ、同じ 1 回の `batchUpdate` に足す。`USER_ENTERED` は今のまま）。
- **K 列のラベル**: `※日付要確認`（金額は合っていて、日付が割れているため。D0 のラベルが `※金額要確認` でも、もう 1 人と金額が合えばこちらにする）。摘要の候補の付け方（`ラベル / 摘要`）は今のまま。
- **O 列と AI 詳細ログのメモ**: 今の文の後ろに `／金額は読み手の間で一致（M 列に記入）` を足す。重複の注記があれば、その後ろに今までどおり `／` でつなぐ。
- B 列（日付）・C・F・G・A は今のまま（日付は主の画像から。読めなければ処理日）。
- 処理管理（`reserve_rows` の L〜P・状態）・`append_process_record`・重複の判断・`_remember_booked` は今のまま。

## 6. テスト（pytest。ネットワークを使わない。API はすべて偽物）

今あるテストは弱めない・消さない。期待が変わるのは §4 の条件を満たす場面のテストだけ（例: `tests/test_manager_second_reader.py` の `test_same_amount_with_a_different_date_is_review` のラベル）。変えたものは報告に名前と理由を書く。足すもの:

- 純粋な関数: D0 が `※日付要確認` → 金額／D0 が `※金額要確認` で Dx が `※日付要確認` → 金額／D0・Dx とも `※金額要確認` → None／D0 が `※明細数要確認` で Dx が `※日付要確認` → None／D0 が `※再読取要確認` → None／桁の疑い（Vision の文字に、先頭の 1 桁を取った金額がある）→ None／Vision の文字が空・空白だけ → None／金額が 0・負・None・`bool`・文字 → None／`is_expense` が偽 → None／D0 が None → None／Dx が None で D0 が `※日付要確認` → 金額。Hypothesis: どんな入力でも例外を投げない／戻りは None か 1 以上の整数で、主の画像からの金額と等しい／戻りが None でなければ D0 か Dx のラベルが `※日付要確認` で、桁の検査は `digit_inflation` でない。
- `write_manual_entry_row`: `amount` なし・None → 送る要求が今と全体一致／1 以上の整数 → M に 1 回だけ書く（範囲の文字列と値を全体一致）／0・負・`bool`・文字 → M を書かない／M が守る列・列の対応に `支出金額` が無い → M を書かない。
- 両読みの流れ（`_process_file_dual`）: もう 1 人なしで D0 が日付だけ食い違う → M に主の画像からの金額・ラベル `※日付要確認`・O 列とメモに §5 の文／もう 1 人ありで D0 が金額の食い違い・Dx が日付だけ → 同じ（ラベルは `※日付要確認` に変わる）／両方とも金額の食い違い → 今と全体一致（M なし）／桁の疑い → M なし・今と同じ文／OCR が空 → M なし／前の回の印あり → M なし・`※再読取要確認`／D0 が明細数 → M なし／画像からが空で文字からだけ → M なし／`is_expense` が偽 → M なし／重複の注記がある行は §5 の文の後ろに注記／書く金額は主の画像からで、もう 1 人の店名・摘要が違っても主の値（W2）／`reserve_rows`・`append_process_record`・`append_ai_log` の `needs_review` と数える結果・`【済】` が付かないこと（W5）／検証（dry_run）で書き込みが 0（W8）。
- W6: `text_first` の要確認の行・`_manual_entry`・`_write_amount_invalid_as_manual`・自動の行の失敗の代わりの行は、`amount` を渡さない（呼び出しの引数を全体一致）。
- 本番と同じ既定の設定でも全部通す。並べる数などテストだけの固定の設定で通して終わりにしない。

変異の確かめ（実装の人が、直した後に 1 つずつ入れてテストが落ちることを確かめ、元に戻して報告する）: 桁の検査を外す／Vision の文字が空でも書く／D0 が明細数でも書く／前の回の印があっても書く／D0・Dx とも金額の食い違いでも書く／もう 1 人の金額を書く（主の金額と違う値になる場面を作る）／ラベルを D0 のまま残す／O 列の文を足さない／`text_first` の要確認の行にも書く／`is_expense` が偽でも書く／`write_manual_entry_row` が `amount=None` でも M を書く。

確かめるコマンド: `python -m pytest -q`、`ruff check src/ tests/`、`ruff format --check src/ tests/`。

## 7. 入れるまでの手順（司令役と利用者）

1. 実装（go-job、worktree）→ 司令役が差分を全部読む・sbx でテスト → Opus xhigh の監査（W1〜W8 と N1〜N12 を 1 つずつ）→ 直し → 直しの差分の確認。
2. 利用者の了解で main へ ff・push。CI と Deploy を見る。
3. 次の記帳で、要確認の行の M 列（金額が合った行だけ入る）・K 列のラベル・O 列の文を見る。

## 8. 見ていくこと（入れた後。直すのは別の仕様）

- 画像の読み手 2 人が同じ金額を読み違えた場合（試しでは同じレシートの手書きの金額）は、合った金額として M に入る。ラベルは `※日付要確認` なので、日付と一緒に金額も目で見てもらう。
- D0 が日付だけ食い違い、桁の検査に掛かった明細は、今までどおり M が空でラベルは `※日付要確認`（金額は手で入れる）。ラベルを `※金額要確認` にするかは別の話（`docs/spec_review_precision.md`）。

## 9. 記録

- 利用者の決定（2026-11-25）: 読み手の間で金額が合っている要確認の行は M 列に金額を入れる。金額が食い違う行は今までどおり空。
- 1.0（2026-11-25）: 初版。Claude が決めた所（利用者に報告する）:
  - 「金額が合った」は、`reconcile` が `※日付要確認`（同じ金額の組がある）と判定したもの。D0 か Dx のどちらかでよい（自動の行が D0 か Dx のどちらかで合えばよいのと同じ）。
  - 桁の検査を必ず掛ける・Vision の文字が無ければ書かない（W3）。
  - 明細数の疑い・読み直しの明細には書かない（§4 の 2）。
  - M に書いた行のラベルは `※日付要確認`、O 列に一言足す（§5）。
- 1.1（2026-11-25）: 実装（ブランチ `go/review-amount` の `f41f203`）の監査（Opus xhigh。重大 0・高 0・中 2・低 7。W1〜W8 は文字どおりには成り立つ）を受けて §10 を足した。
- 1.2（2026-11-25）: §10 の直し（`987f829`）の差分の確認（Opus xhigh。重大 0・高 0・中 2・低 2）を受けて §11 を足した。§10.1 の空きの数え方は §11.1 の枚数の決まりに置き換える。

## 10. 監査の直し（1.1）

コードの動きを変えるのは §10.1〜§10.3。今あるテストは弱めない・消さない（期待が変わるのは §10.1 の 1 本だけ）。

### 10.1 「金額が合った」を 1 対 1 にする（中 1）

**今の穴**: `reconcile` の「日付が食い違う」は、使われていない相手の明細に同じ金額が **1 つでもあれば** 付く（相手の明細を使ったことにしない）。そのため、主の画像からに同じ金額の明細が 2 つ（日付は別）、相手に 1 つだけのとき、2 つとも `※日付要確認` になり、§4 のままだと 2 行とも M に金額が入る（相手が見たのは 1 枚なのに 2 枚分が計上される）。`reconcile` は変えない（両読みの判定はそのまま）。M に書くかどうかの判定だけを 1 対 1 にする。

`src/processing/reconcile.py` に純粋な関数を足す:

```python
def assign_review_amounts(
    image_items,        # 主の画像からの明細（並び＝明細の番号）
    text_items,         # 主の文字からの明細
    second_items,       # もう 1 人の明細（呼んでいなければ空）
    d0,                 # reconcile(image, text, ocr_text) の戻り
    dx,                 # reconcile(image, second, ocr_text) の戻り（呼んでいなければ None）
    ocr_text: str,
    eligible,           # M を考えてよい明細の番号（呼ぶ側が決める。§10.3）
) -> dict[int, int]:    # {明細の番号: M に書く金額}。例外を投げない（例外なら {}）
```

処理の順:

1. `d0` が None なら `{}`。
2. 文字の側の空き: `text_items` のうち、`d0` のどの判定の `text_index` にも使われていない明細の金額（`_amount_of`。1 以上の整数だけ）を数える（`Counter`）。`text_index` は合った組と桁の疑いの組の両方に入っているので、両方とも空きから外れる。
3. もう 1 人の側の空き: `dx` が None なら空。そうでなければ `second_items` のうち、`dx` のどの判定の `text_index` にも使われていない明細の金額を同じく数える。
4. `eligible` を小さい番号から順に見る。番号 i ごとに:
   - `amount = review_amount(image_items[i], d0[i], dx[i] か None, ocr_text)`。None なら書かない（§4 の条件はそのまま全部効く）。
   - `d0[i]` のラベルが `※日付要確認` で、文字の側の空きに `amount` が 1 つ以上あれば、空きを 1 つ減らして i に `amount`。
   - そうでなく、`dx[i]` のラベルが `※日付要確認` で、もう 1 人の側の空きに `amount` が 1 つ以上あれば、空きを 1 つ減らして i に `amount`。
   - どちらも無ければ書かない。
5. 戻す。範囲の外の番号・長さの合わない並び・None は「書かない」側に倒す。

性質（テストで確かめる）: 戻りの鍵は `eligible` の中だけ／値は主の画像からの金額／金額 A を書く行の数は、文字の側の空きの A の数と、もう 1 人の側の空きの A の数の和を超えない／例外を投げない。

`manager.py` の `_process_file_dual` は、行の予約の後・書く繰り返しの前に 1 回だけ呼び、繰り返しの中では `review_amounts.get(idx)` を使う（今の明細ごとの `review_amount` の呼び出しはこれに置き換える）。

期待が変わる今のテスト: `tests/test_manager_review_amount.py` の `test_duplicate_note_follows_the_amount_note`（同じ明細 2 つ・文字から 1 つ → 今は 2 行とも M。直した後は 1 行目だけ M、2 行目は M なし・ラベルと文は今の両読みの要確認のまま・重複の注記は今どおり）。

### 10.2 書いた後の失敗で、同じ明細をもう一度記帳しない（中 2）

**今の穴**: 要確認の行は、`write_manual_entry_row` で行を書いた後に `update_reservation_status(WRITTEN)`・`append_ai_log`・`update_reservation_status(MANUAL_ENTRY)` を呼ぶ。この後ろの 3 つのどれかが例外（Sheets の 429・5xx など）だと、呼ぶ側が状態を `error` にする。`error` は処理済みに数えないので、次の実行でそのファイルが読み直され、同じ明細が別の行にもう一度書かれる（M に金額が入った行なら金額が二重になる）。自動の行は、失敗の代わりの行を同じ行に書いて `manual_entry` にするので、この穴は無い。

`_write_dual_review` を次の形にする（両読みの要確認の行すべて。M のあるなしを問わない）:

```python
cb.copy_formulas_to_row(row)        # ここまでの例外は今どおり呼ぶ側へ（状態 error・errors += 1）
cb.write_manual_entry_row(...)      # 同上
try:
    cb.update_reservation_status(rid, WRITTEN)
    cb.append_ai_log(...)
    cb.update_reservation_status(rid, MANUAL_ENTRY)
except Exception as e:
    logger.error(f"両読み要確認の行の後の処理に失敗: {file.file_name}[{idx}]: {type(e).__name__}",
                 extra={"step": "dual_review_after_write_error", "file_id": file.file_id})
    try:
        cb.update_reservation_status(rid, MANUAL_ENTRY)
    except Exception as e2:
        logger.error(f"両読み要確認の行の状態を manual_entry にできない: {file.file_name}[{idx}]: {type(e2).__name__}",
                     extra={"step": "dual_review_status_error", "file_id": file.file_id})
# 行を書けたら例外を外へ出さない（呼ぶ側は今どおり manual_entry += 1・booked に入れる）
```

- ログには例外の文を出さず、型の名前だけ（鍵などが混ざりうるため。N10 と同じ）。
- 行を書いた後は、状態を `error` にしない（`manual_entry` にできなければ、そのときの状態のまま）。
- 行を書く前（`copy_formulas_to_row`・`write_manual_entry_row`）の例外は今のまま（呼ぶ側が `error`・`errors += 1`。行が無いので次の実行で読み直してよい）。
- `text_first` の流れ・自動の行・ほかの道は変えない（W6）。

### 10.3 二重の守り（低 1）

§10.1 の `eligible` は、呼ぶ側で次の全部を満たす番号だけにする: 記帳する（`bookable`）・最後の判定（`decisions[idx]`）が合っていない・最後の判定のラベルが `※再読取要確認`・`※明細数要確認` でない。さらに今どおり、前の回の印があるファイル（`has_marks`）では呼ばない（`{}`）。

### 10.4 足すテスト

- `assign_review_amounts`（`tests/test_reconcile.py`）: 主の画像から同じ金額 2 つ（日付は別）・文字から 1 つ → 小さい番号だけ／文字からも 2 つ → 両方／文字の明細が合った組に使われている → その分は空きにならない／桁の疑いの組に使われている → 同じ／文字の側が尽きてももう 1 人の側に空きがあれば、もう 1 人の側で書く／`eligible` に無い番号は書かれず、空きも減らさない／`dx` が None・`d0` が None・長さの合わない並び → 例外にならず書かない側／Hypothesis で上の性質 4 つ。
- もう 1 人の側の桁の検査（`review_amount` と `_process_file_dual` の両方）: D0 が `※金額要確認`・Dx が `※日付要確認`・Vision の文字に先頭の 1 桁を取った金額がある → M なし・今の文とラベル。
- D0 が `※読み取り要確認`（OCR はあるが文字からの明細が 0）・Dx が `※日付要確認` → M あり・ラベル `※日付要確認`・§5 の文。
- 中 1 の場面を `_process_file_dual` で（もう 1 人なし・ありの 2 通り）: 2 行のうち 1 行目だけ M。
- 中 2（`_process_file_dual`）: `append_ai_log` が例外 → 状態は `manual_entry`（`error` を呼ばない）・`manual_entry` に数え `errors` は増えない・ログに例外の文（偽の鍵の文字列を入れる）が出ない／`update_reservation_status(WRITTEN)` が例外 → `manual_entry` を試す／`manual_entry` も例外 → 例外は外へ出ず、`error` も呼ばない／`write_manual_entry_row` が例外 → 今どおり `error`・`errors += 1`／後の処理が失敗した後、その印（`manual_entry`）を処理済みに入れてもう一度流すと、同じ明細の行をもう書かない。

変異の確かめ: 1 対 1 をやめる（空きを減らさない）／合った組に使われた文字の明細を空きに数える／`eligible` の外にも書く／後の処理の失敗で `error` にする／後の処理の失敗の例外を外へ出す／ログに例外の文を出す／もう 1 人の側の桁の検査を外す。

## 11. 差分の確認の直し（1.2）

### 11.1 枚数の決まり（中 1。§10.1 の空きの数え方を置き換える）

**残っていた穴**: §10.1 は読み手ごとの空きなので、主の文字からとともう 1 人が同じ金額のレシートをそれぞれ 1 枚ずつ見ているだけでも、主の画像からの同じ金額の 2 行が、片方は文字から・片方はもう 1 人から裏付けを取り、2 行とも M になる道があった（自動になった行が相手の 1 枚を使った後でも、もう一方の読み手の 1 枚で M になる道も同じ）。

**新しい決まり**: 金額 A の明細に M を書くのは、そのファイルで **主の画像から読んだ金額 A の枚数が、裏付けに使う読み手の金額 A の枚数以下** のときだけ。数えるのはファイルの全部の明細（記帳しない重複・自動の行・要確認の行を問わない）。

`assign_review_amounts` の引数と戻りはそのまま。中身を次に置き換える:

```python
image_count  = Counter(_amount_of(x) for x in image_items  if _amount_of(x) is not None)
text_count   = Counter(_amount_of(x) for x in text_items   if _amount_of(x) is not None)
second_count = Counter(_amount_of(x) for x in second_items if _amount_of(x) is not None)  # dx が None なら空
for i in sorted(set(eligible)):            # 範囲の外は飛ばす
    amount = review_amount(image_items[i], d0[i], dx[i] か None, ocr_text)
    if amount is None: continue
    by_text   = d0[i].label == LABEL_DATE and image_count[amount] <= text_count[amount]
    by_second = dx は None でない and dx[i].label == LABEL_DATE and image_count[amount] <= second_count[amount]
    if by_text or by_second: result[i] = amount
# 例外なら {}（今どおり）
```

- 順番に左右されない（空きを減らす処理は無くす）。
- 性質（テストで確かめる）: 戻りの鍵は `eligible` の中だけ／値は主の画像からの金額／戻りの鍵はどれも `review_amount(...)` が None でない（§4 の部分集合）／戻りに金額 A があれば、`image_count[A] <= text_count[A]`（その明細の D0 が `※日付要確認`）か `image_count[A] <= second_count[A]`（その明細の Dx が `※日付要確認`）／例外を投げない。
- これで、主の画像からの金額 A の行（自動と M の合計）は、裏付けた読み手が見た金額 A の枚数を超えない。
- §10.1 の例（同じ明細 2 つ・文字から 1 つ）は、2 行とも M なしになる（どちらが本物か決められないため。1 行目だけ M にするのはやめる）。

### 11.2 足すテスト・直すテスト

- `tests/test_reconcile.py`: 差分の確認の場面 (a) 主の画像から 1200 が 2 つ・文字から 1 つ・もう 1 人 1 つで、1 つ目がもう 1 人で自動 → 2 つ目は M なし／(b) 1 つ目が文字からで自動・2 つ目がもう 1 人の日付だけ → M なし／(c) 2 つとも両方の読み手と日付だけ → 2 つとも M なし／文字から 2 つ・もう 1 人 1 つ → 日付だけの 2 つとも M（文字からが 2 枚見ている）／文字から 1 つ・もう 1 人 2 つ → もう 1 人が `※日付要確認` の明細は M。Hypothesis: 上の性質。うち「裏付けた読み手の枚数を超えない」は、`reconcile` と `merge_second_reader` で作った本物の判定（小さな金額・日付の範囲で同じ値がよく出るように作る）でも確かめる。
- §10.1 の空きの決まりを前提にした今のテスト（このブランチで足したもの。「小さい番号だけ」「空きが尽きたらもう 1 人の側」など）は、§11.1 の期待に直す。直したものは報告に名前と期待の変わり方を書く。
- `tests/test_manager_review_amount.py`:
  - `test_duplicate_note_follows_the_amount_note` は中身に合わせて名前を変え（例: `test_two_identical_items_and_one_text_item_write_no_m`）、期待は §11.1（2 行とも M なし、2 行目の重複の注記は今どおり）。
  - 注記の順: 主の画像から同じ明細 2 つ・文字から同じ金額で別の日付の 2 つ → 2 行とも M、2 行目の O 列で `金額は読み手の間で一致（M 列に記入）` が重複の注記より前。
  - `eligible`: 自動の行・別のファイルとの重複で記帳しない行が `assign_review_amounts` の `eligible` に入らない（呼び出しの引数を捕まえて確かめる）。
  - 書いた後の失敗のあと、もう一度流すテストは、1 回目に `update_reservation_status` へ渡った状態から処理済みの印を作る（`_DONE_STATUSES` に入る状態だけを印にする）。決め打ちの印を使わない。
  - 書いた後の失敗でも、その明細が `_remember_booked` に入る（同じ回の後のファイルが重複として見つける）。

変異の確かめ: 枚数の比べを外す（裏付けの読み手の `※日付要確認` だけで書く）／`<=` を `<` に・`text_count` と `second_count` を取り違える／自動の行を `image_count` に数えない／記帳しない重複を数えない／2 回目のテストで決め打ちの印に戻す。

### 11.3 記録だけ（この仕様では直さない。別の仕様の種）

- **状態が黙って書けなかったとき（中 2。前からある）**: 処理管理の読み込みが失敗すると `update_reservation_status` は例外を出さずに `False` を返す。2 回とも書けないと予約は `reserved` のまま残り、期限（30 分）を過ぎると `cleanup_stale_reservations` が出納帳の行の有無を見ずに `expired` にするので、次の実行で同じ明細がもう一度記帳される（自動の行も同じ。M のある行では金額が二重になる）。直す案: 期限切れの `reserved` でも出納帳の行が埋まっていれば処理済みにする（`recover_stale_written` と同じ見方）・`False` を失敗として 1 回だけやり直す。共通の処理なので別の仕様で。
- 書いた後に `WRITTEN` だけ書けて残りが失敗した行は、期限の後に `recover_stale_written` が `success` にする（記帳し直さないので安全。処理管理の状態の名前だけが違う）。
- `write_manual_entry_row` の送信が相手側では済んだのに時間切れの例外になった場合は、今までどおり `error` になり、次の実行で記帳し直す（前からある。§10.2 で残したもの）。

## 12. 監査と入れた記録

- 監査（Opus xhigh、2026-11-25）: 実装 C0・H0・M2・L7 → §10 → 直しの差分 C0・H0・M2・L2 → §11（残っていた中 1 は枚数の決まりで閉じた。中 2 は §11.3 に記録）→ 枚数の決まりの差分 C0・H0・M0・L7。最後の低は記録だけ（次にこの辺りを直すときに）:
  - `src/processing/manager.py` のコメント 2 か所に「1 対 1」「§10.1」が残っている（動きは §11.1 のとおり）。
  - テストの弱い所: 長さの合わない並びのテストが、範囲の守りを外しても通る（例外でも `{}` になるため。本番では起きない）／書いた後の失敗のあと、もう一度流すテストの印は、最後の状態でなく渡った全部の状態から作っている（状態の並びの全体は別のテストで確かめている）／もう 1 人の側の「書かない」場面が呼び出しの全体一致でなく一部の確かめ／文字からともう 1 人の数の取り違えは `manager` のテストだけで見つかる／記帳しない重複が同じ金額の M を抑える場面の通しのテストが無い。
  - 枚数は収入の明細も数える（`is_expense` を見ない。自動の組の作り方と同じ）。
  - README の言い回し（直した）。
- main へ ff（`fc88338`。M 列 `6f1b306`・直し `8f8fdaf`・枚数の決まり `a105057`・README `fc88338`。既定の切り替えの `f4af331`・`fd06b22` も同じ push）。CI と Deploy の結果・切り替えた後の確かめは `docs/spec_second_reader.md` §12 に書く。

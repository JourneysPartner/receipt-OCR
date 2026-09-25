# 形式不明カードの画面登録 仕様書 ── §15-8（B案）

対象システム：クレジットカード明細 自動仕訳システム（Google Apps Script、リポジトリ `クレカ明細自動仕訳`）
作成日：2026-09-25
版：1.5（5 回目の監査を反映。修正は未実装）
読者：本仕様だけを読んで実装する実装者（AI を含む）。**書いてあることは変えない。**書いていないことは実装者が決めてよいが、決めた箇所は報告する。判断に迷ったら §2.3「線引きの原理」を先に読む。
起点：`work/spec_webapp.md` §15 の 8。前提となる仕組みは `design_document.md` 4.11（形式判定）・4.12（形式登録）・6.6（登録フロー）、および `work/spec_webapp.md`（Web アプリ第1段）。

改訂履歴：
- 1.5（2026-09-25）：**1.4 の修正（1214/1214 緑、M1〜M37 すべて赤）を監査した。**U36〜U40 は直っている。**実装者が仕様に無い判断を 1 つしており、それが P4 に反していた** ── 保存の後の処理（登録の監査・読み戻し・兄弟ファイルの列挙）で例外が出たら `readback: 'UNCERTAIN'` を返すが、**形式は有効のまま残す**（テストもそれを固定していた）。読み戻しの確認を終えていない形式が全顧客の取込に効く。§5.7 手順 7' と U41 を足した。
- 1.4（2026-09-25）：**1.3 の修正（1207/1207 緑、M1〜M32 すべて赤、ソース文字列の検査 14 か所を偽の DOM の振る舞いに置き換え）を監査した。**高はもう無い ── U1・U2・U24 は監査者も偽の DOM で再現して確かめ、監査者の変異（初期化を全部消す・`ok: false` を成功扱い・正規化で空白を消す）もそれぞれ赤になった。サーバーは監査者の変異 24 個中 21 個が赤。画面に中 5（U36〜U40）。**この版で直すのは中の 5 つと、それを捕まえるテストだけにする。**低 10 は §14 K-F6 に記録して後回しにする（どれも帳簿を壊さず、サーバーが `PREVIEW_STALE` などで止める）。**偽の DOM のテストの強さにも限りがある**（フォーカスの仕組みが無い・偽の `google.script.run` が同期で即答するので遅れた応答や処理中の状態を作れない）── 中の 5 つを捕まえる分だけ足す（§10.10）。
- 1.3（2026-09-25）：**1.2 の修正（1195/1195 緑、M1〜M28 すべて赤）を監査した。**サーバーは直っている（監査者の変異 24 個中 21 個が赤、残りは同値か細部）。画面に**高 1**・中 6・低 10。**高：列の選択や金額のラジオを変えるたびに例外が出る** ── U23 の「手で選択」のために足した `state.formatManualColumns` をどこでも初期化しておらず、`undefined` への代入で落ちる。落ちるので、試し読みを古くする処理も保存ボタンを押せなくする処理も走らず、**画面は古い列の結果を今の結果として見せ続ける**（サーバーが `PREVIEW_STALE` で止めるので誤った書込にはならない）。**テストがこれを捕まえなかった理由は、画面のテスト 14 本が「関数のソースにこの文字列が含まれるか」を見ていたことである。**文字列があることと、動くことは別である。§9 に「画面のテストは振る舞いで確かめる」を足し、§7.11 に U24〜U35 を足した。
- 1.2（2026-09-25）：**1.1 の修正（1180/1180 緑、M1〜M25 すべて赤）を監査した。**サーバーは直っており、監査者の変異 24 個のうち 21 個が赤（残る 3 個は同値の変異か、テストを求めない細部）。画面に中 4・低 15。(1) **§7.11 U2 の書き方が誤っていた** ── 「空白除去」と書いたが、サーバーの `normalizeMerchant` は空白・改行を半角空白 1 つにまとめて端を削るだけで、消さない。書いたとおりに実装された結果、「使用 用途」「使用⏎用途」でサーバーは確認を求め、画面はチェック欄を出さず、**U2 が防ごうとした「保存できなくなる」が残った。**(2) 入力を変えるたびにパネル全体を作り直すので、欄を編集したまま［試し読み］を押すと 1 回目のクリックが消える。(3) 除外した行の表に内部コード（`_rowRange`）がそのまま出て、見出しより上の行が毎回並ぶ。(4) 取込待ちへ戻した後、残りを表示するためだけに診断を呼び直していた（読取の無駄。失敗すると結果の通知が消える）。§7.11 に U14〜U23、§6.2・付録 B・§10.8 を足した。
- 1.1（2026-09-25）：**1.0 の実装（Codex、1163/1163 緑、§11 の変異 16 個すべて赤）を監査した。**高 2・中 12。(1) **実機でだけ起きる欠陥**：土台の Y・Z 列（遡り・先読みの月数）は空だと `null` で、`null` のままセルへ書いていた。実機のシートは `null` を持てず空セルになり、読み戻すと `''` が返るので、§5.7 の行の比較が必ず不一致になり、**土台のある登録は保存した直後に自動で無効になる。**スタブは `null` を保って返すので 1163 本は緑のままだった。§5.5・§5.7 を直し、実機の読み方を模すケース fmt 30b を足した。(2) 画面：保存が `{ok: false, code: 'NOT_FORMAT_UNKNOWN'}` を返すと成功扱いになり、描画の途中で落ちて画面全体のボタンが無効のまま固まる。ほか画面 12 件（§7.11）。(3) **仕様どおりに実装されているのにテストが無かった箇所が 5 つ**（監査者の変異が生き残った）：履歴から対象ファイルを除く（§5.2 手順 6）、「2 語以上」（§5.3.2。fmt 14 が提案だけを見て診断の `BLANK` を見ていなかった）、見出し行の同数は下（§5.4.2）、取込待ちへ戻すときの締切、`siblings` をフォルダで絞る。ケースを足した（§10.7）。
- 1.0（2026-09-25）：初稿。止まっている実ファイルを手元で再現し（§1.2）、ko-ch さんに 2 点を決めてもらって起こした（§1.3 の D3・D4）。実装に渡す前に、仕様と実コードの突き合わせ監査を 1 回通した（高 1・中 12・低 11。すべて反映）。最も重かったのは近い形式の選び方で、`smbc_family_x7`〜`x9` の判定キーワードが「様」1 語だけなので、「1 語足りない」だけを条件にすると**どの xlsx にもこの 3 形式が候補に入る**（§5.3.2）。

---

## 0. この文書の読み方

**決定そのものより、その理由の方が重要である。**理由が成立しない場面に出会ったら、決定を機械的に当てはめず、報告に書くこと。

数値は実測か、計算の過程を示したものだけを使う。推測値には「未実測」と書く。

**固定データは実ファイルから作ってある。**`test/fixtures/unknown-formats/` の 14 件は、止まっている実ファイル（`テスト用クレカ明細/`、リポジトリ管理外）を `tools/gen-sample-fixtures.js` と同じ読み方で変換し、氏名・口座・カード番号の末尾を伏字にしたものである（2026-09-25 生成）。**実装者はこのフォルダを変更しない。**判定のテストはこの固定データを正とする ── 手書きの標本は実機と食い違う（2026-09-03 に、手書きの標本で緑のまま実機が `UNKNOWN_CARD_FORMAT` を返した）。

| 固定データ（`<slug>.json`） | 中身 | 使い道 |
|---|---|---|
| `auカード__au202508` | 7 列（顧客が「使用用途」列を足した月）。`aupay_family` に一致 | 参照ファイル |
| `auカード__au202509`・`au202510` | 6 列。「使用用途」列が無い。摘要（F）も空 | 用途列の不備（列が無い） |
| `auカード__AU202511` | 6 列。摘要（F）に「スマホ代」 | 用途列の不備（カード会社の列に記入） |
| `ペイペイカード__PAYPAY_detail202502(0000)` | 12 列。「決済方法」列が無い古い出力。24 取引 | カード会社の出力違い（列がずれる） |
| `ペイペイカード__detail202503(0000)` | 13 列。`paypay_family` に一致 | 参照ファイル |
| `楽天カード__enavi202508(0000)` | 11 列。`rakuten_x11` に一致 | 参照ファイル |
| `楽天カード__enavi202509(0000)` | 11 列。K1 の見出しが「ツール代」 | 用途列の不備（見出しに用途の値） |
| `アプラスカード__aplus_meisai_0000_202503` | 10 列。アプラスの形式は無い。日付は数値 `YYYYMMDD` | 白紙から登録 |
| `アプラスカード__aplus_meisai_0000_202510` | 9 列。「使用用途」列が無い | 白紙の登録後に用途列の不備 |
| `イオンカード__meisai202503` | 9 列。取引 2 件＋「分割・ボーナス払い明細」 | 判定の不具合（§3） |
| `イオンカード__meisai202504` | 8 列。「使用用途」列が無く、備考（H）に「ポイント２倍対象」 | `aeon_x8` の誤読（§1.4 F2） |
| `イオンカード__meisai202506` | 9 列。取引が多く、いまも `aeon_x9` に一致 | 対照 |
| `イオンゴールドカード__meisai202508` | 9 列。取引 1 件＋「分割・ボーナス払い明細」 | 判定の不具合（§3） |

読み込み方は `test/phase6-real-samples.test.js` の `loadFixture` と同じ（`{__date__}` を `Date` へ戻す）。

---

## 1. 背景

### 1.1 いまの登録経路

- **カード形式マスターへ行を入れる経路はコードだけである。**本番の形式はすべて `installCardFormat`（`04_Provisioning.gs` 266 行）を呼ぶ関数（`installAnnotatedFormatsBatch1` など）から入っている。AC 列（有効化ゲートの結果）は全行空である。
- `design_document.md` 4.12 の本格経路（サンプルコーパス・匿名化・13 問・3 ゲート・承認申請）は、部品（`14_ActivationGates`・`15_DraftInference`・`16_Anonymizer`・`17_Rebaseline`・`18_FormatRevision`）が純粋関数として実装・テストされているが、**シートへ書く手続き（`registerSample`・`saveDraftAnswers`・`previewExtraction`・`activateFormat` など）は 1 つも無い。**画面も無い。
- 形式不明で止まったファイルの出口は `REGISTER_FORMAT`（登録済みの形式で再検査する）と `CANCEL_FILE` だけである（`52_FileResolution.gs` 17 行）。

### 1.2 止まっているファイルを手元で再現した（2026-09-25）

`opsExplainFormatMismatch` と同じ関数（`detectFormatWith`・`explainFormatVerdict_`）で、本番と同じ形式の集合（`installSmbcCsvFormat`・`installSmbcXlsxFormat`・`installAnnotatedFormatsBatch1`）に当てた。

| ファイル | いちばん近い形式 | 診断が言う差 | 本当の原因 |
|---|---|---|---|
| `au202509`・`au202510`・`AU202511` | `aupay_family` | 列数が 6（形式は 7〜7） | **顧客が「使用用途」列を足していない。**カード会社の出力は 6 列で、顧客が 7 列目に用途を足した月だけが `aupay_family` に当たる。`AU202511` は用途を摘要（F）に書いた |
| `PAYPAY detail202502` | `paypay_family` | 「決済方法」が無い（4/5） | **カード会社の出力が違う**（2025 年 2 月の出力には「決済方法」列が無い）。**列が 1 つずつ左へずれている**（§1.4 F1） |
| `enavi202509` | `rakuten_x11` | 「使用用途」が無い（4/5） | **K1 の見出しが「ツール代」**── 顧客が見出しのセルに用途の値を書いた |
| `aplus_*` | なし | 形式が 1 つも無い | 新しいカード |
| `meisai202508`（イオンゴールド）ほかイオン 6 件 | `aeon_x9` | 1・3・7 列目の型 | **判定の不具合**（§3）。登録を足しても直らない |

### 1.3 決定（ko-ch さん）

| 番号 | 日付 | 決定 |
|---|---|---|
| D1 | 2026-09-21 | **自動では完結させない。**提案は出してよいが、人が確認して保存する |
| D2 | 2026-09-21 | **保存したらその場で試し読みして結果を見せる。**保存して終わりだと、誤っていても次の取込まで分からない |
| D3 | 2026-09-25 | **カード会社の出力は既存の形式と同じで、違いが「使用用途」列だけのファイル（列が無い・見出しに用途の値・カード会社の列に用途を記入）は、経理がその都度選ぶ。**画面は「顧客に修正を依頼する（【要修正】にする）」と「別の形式として登録する」の両方を出す。**先頭（推奨）は要修正。登録は警告と明示の確認つき** |
| D4 | 2026-09-25 | **イオンは判定を直し、`aeon_x8` を止める**（§3） |
| D5 | 2026-09-21 | **金額列の選び方は経理の判断である。**楽天・PayPay は金額らしい列が 3 つ以上あり、分割払いがあると値が違う。候補が 2 列以上あるときは、人が明示的に選ぶまで保存できない |

**D3 は `spec_webapp.md` §15-8 の一文を改める。**同節は「`ツール代` の件は形式を増やして対応してはならない」と書いていたが、2026-09-25 の回答で「既定は要修正。登録は警告つきで許す」になった。**入力ミスが正常な様式として定着する危険は変わらない**ので、画面はそれを必ず言い、明示の確認を求める（§7.6）。

### 1.4 調査で分かった、決定の前提になる事実

**F1 ── 列記号は引き継げない。**`paypay_family` の列記号（金額 F・用途 M）を 12 列版の `PAYPAY detail202502` にそのまま当てると、F 列は「手数料」なので **24 件すべてが 0 円か空（0 円 23 件・空 1 件）**になり、M 列は存在しないので**用途が全件空**になる（ハーネスで `parseFile` を実行して確認）。「いちばん惜しい形式との差だけを埋める」は、**列記号ではなく見出しで**行う（§5.4.1）。

**F2 ── `aeon_x8` は、カード会社の備考列を使用用途として読む形式である。**基準にしたファイル（`test/fixtures/samples/イオンカード__202512`）は、顧客が備考（H）に「仕入れ」と書いたものだった。ところが備考はカード会社も書く列で、`meisai202504` の備考には「ポイント２倍対象」が入っている。§3 の判定の直しを入れると `meisai202504` が `aeon_x8` に一致し、**「ポイント２倍対象」が使用用途として転記される**（ハーネスで確認）。いまそうならないのは、取引が 2 件しか無く、見本行の過半数を「分割・ボーナス払い明細」の行が占めて型の判定に落ちるから ── **取引が 3 件以上ある月は、いまでも誤読する。**D4 の理由である。

**F3 ── 同じ形は `amex_6_alt`（用途を海外通貨の列 E に記入）にもある。**海外利用があると、カード会社が E 列に書いた値が用途として読まれ得る。本仕様では触らない（§14 K-F1）。

**F4 ── 既存の型の判定は、どちらも「列の役割の提案」には使えない。**
- `15_DraftInference.gs` の `looksLikeDate_`（40 行）は数値の `YYYYMMDD`・`YYMMDD` を日付と見ない。アプラス（`20250213`）・イオン（`250627`）の日付列を見落とし、明細候補行が 0 行になる。
- `24_Parser_Generic.gs` の `parserCellMatchesType_` は逆に、**数値を日付（シリアル）とも文字とも見なす**（`6130` が `date`・`number`・`text` のすべてで真。ハーネスで確認）。判定では「型が合わない」を見るために寛容なのが正しいが、「どの列が日付か」を選ぶ材料にはならない。
- 提案には §5.4.4 の規則を使う。**判定（`13_CardDetector`）の型の規則は変えない。**

**F5 ── 形式は全顧客で共通である。**ある顧客のファイルから登録した形式は、次の取込から全顧客のファイルに当たる。衝突の検査（§6）が要るのはこのためである。

---

## 2. 範囲

### 2.1 作るもの

| 部 | 中身 |
|---|---|
| Part A（§3） | 列構造判定の見本行を「パーサーが読む範囲」に限る（`13`・`97`）。`aeon_x8` を止める運用関数（`97`） |
| Part B（§5〜§6） | 診断・提案・試し読み・保存・取消し・取込待ちへ戻す・顧客に修正を依頼、のサーバー処理（`19` 新設・`80` に入口）。操作 `RETURN_TO_CUSTOMER`（`52`・`03`）。形式の行の組立ての切り出し（`04`） |
| Part C（§7） | Web アプリの画面（`81`） |

### 2.2 作らないもの

| 項目 | 理由 |
|---|---|
| 4.12 の本格経路（コーパス・匿名化・3 ゲート・承認申請） | 本番の 15 形式はすべてゲート未実施で運用している。Web アプリは `access: MYSELF` でオーナーしか使わない（申請者＝承認者）。形式サンプル台帳は空である。**本仕様の検査（§6）が、実ファイルの上でゲート 1（往復）・3（衝突）の縮小版を行う。**AC 列は既存の 15 形式と同じく空のまま。AB 列に残す記録（§5.5）は、4.12 を後で作るときの材料になる |
| 既存形式の改訂（`supersede`） | §2.3 P2 |
| `FORMAT_AMBIGUOUS`・`MULTI_SHEET`・区分 2 の他の種別 | 登録で解ける問題ではない |
| 専用パーサー（`parserKind = custom`） | 4.12.8。明細候補行が 0 行のファイルは本仕様では登録できない（§6 の `NO_TRANSACTIONS`） |
| CSV の文字コード問題 | 別の要因（`ENCODING_DETECTION_FAILED`） |
| カード会社の列に用途を読む既存形式（`amex_6_alt` など）の見直し | §14 K-F1 |

### 2.3 線引きの原理

**P1 ── 判定と抽出の規則を書き直さない。**判定は `detectFormatWith`・`aggregateSheetDetections`（13）、抽出は `parseFile`（24）と取込が使う部品（30・31・35）を呼ぶ。**説明の文も、判定と同じ計算から作る。**規則が 2 つになると「診断は通ると言うのに実際は弾かれる」が起きる（2026-09-21、リースの一覧と解放で実際に起きた。`97_Ops.gs` 758〜770 行のコメント）。§3 が `97` の写しを消すのはこのためである。

**P2 ── 既存の形式を書き換えない。画面が作るのは新しい形式 ID の行（版 1）だけである。**7 列の au（顧客が用途列を足した月）と 6 列の au は、同じ顧客の同じカードで並存する。改訂で 7 列版を無効にすると、足した月のファイルが止まる。4.12.6 の「選択肢 A：別形式として登録する」と同じ判断である。

**P3 ── 列は記号ではなく見出しで引き継ぐ**（F1）。

**P4 ── 保存の前に試し読みし、保存の後に「保存した行から」もう一度読む。**一致しなければ自動で無効にする。形式を組み直して書く経路では、実機に正規表現の `\s` を落とした版が入ったことがある（`04_Provisioning.gs` 902 行）。**書いたつもりの値と、書かれた値が同じだと信じない。**

**P5 ── 判定はサーバーが行う。**画面が送るのは回答（§5.5）だけで、形式の定義はサーバーが回答から導出する。画面の検査は案内であって、守りではない。

**P6 ── 保存は取込を始めない。**取込待ちへ戻す（§5.8）のも、［記帳を実行］を押すのも人である。

---

## 3. Part A ── 判定の直し

### 3.1 何が起きているか

`matchesColumnProfile`（`13_CardDetector.gs` 514〜549 行）は、データ開始行から「日付列か金額列が埋まった行」を最大 `sampleRows`（既定 5）行拾い、過半数が必須列の型に合えば成立とする。

**拾う範囲に終わりが無い。**イオンの明細は取引の下に「分割・ボーナス払い明細」という別の表が続く。`aeon_x8`・`aeon_x9` は `sectionBreakRule` でその見出しを持ち、`parseFile` はそこで読むのを止める（`24_Parser_Generic.gs` 435 行の `parserSectionBreakIndexes_` → `findReadStop`）。**判定は止まらず**、その下の見出し行と分割払いの行を見本に拾う。取引が 1〜2 件の月は見本の過半数がそれらになり、型が合わずに不成立になる。

`97_Ops.gs` の `explainColumnGap_`（855〜900 行）は、同じ見本の拾い方を**写して**持っている（862〜871 行）。

### 3.2 直し方

1. `13_CardDetector.gs` に `detectorProfileSamples_(sheet, formatRow)` を置き、見本行の拾い方をここだけに書く。**拾うのは、`parserSectionBreakIndexes_(rows, formatRow)` が返す最初の添字の手前まで。**セクション見出しを持たない形式では、従来と 1 行も変わらない。
2. `matchesColumnProfile` と `explainColumnGap_` の両方がこれを使う。表の幅（`detectorTableWidth_`）も同じ見本で測る。
3. **合計行では止めない。**`findReadStop` は合計行（`TOTAL_ROW`）でも読むのを止めるが、`saison_x8` は見本に【小計】【合計】行を拾う前提で列の条件を組んである（`04_Provisioning.gs` 646〜648 行のコメント）。止めると `saison_x8` の判定が変わる。**直すのは実例のある方だけにする。**

### 3.3 直した結果（ハーネスで確認済み）

- `test/fixtures/samples/` の 33 件（`index.json` を除く）は、判定結果が 1 件も変わらない（`installAnnotatedFormatsBatch1` の集合で）。
- `unknown-formats` の `meisai202503`・ゴールド `meisai202508` が `aeon_x9` になる（`meisai202506` は元から `aeon_x9`）。手元の同形のイオン 5 件（リポジトリ外）も同じ。
- **`meisai202504` は `aeon_x8` になり、備考の「ポイント２倍対象」を使用用途として読む**（F2）。**だから §3.4 と同時に出す。**

### 3.4 `aeon_x8` を止める

- 汎用の `disableCardFormat_(formatId, reason, actor)` を `19_FormatRegistration.gs` に置く。カード形式マスターの、その形式 ID の**有効な行（D 列＝TRUE）すべて**について：D＝FALSE、W（無効化日時）＝現在時刻、X（無効化理由）＝`reason`、AH（最終更新）＝現在時刻。監査 `FORMAT_DISABLE`（`targetType: 'FORMAT'`、`targetId`＝形式 ID、`after` に版と理由）。**有効な行が無ければ何も書かず、監査も書かない**（冪等）。戻り値 `{formatId, disabledVersions: [...]}`。
- `97_Ops.gs` に `opsDisableAeonX8()`（**引数なし**。本番はエディタのプルダウンで実行するため）。`disableCardFormat_('aeon_x8', 'PURPOSE_READ_FROM_ISSUER_COLUMN', 実行者)` を呼んで結果をログに出す。
- `ANNOTATED_FORMAT_SPECS_` は変えない（投入の履歴である）。`installCardFormat` は（形式 ID, 版）で冪等 ── 無効にした行があれば `ALREADY_EXISTS` で書かないので、投入関数をもう一度実行しても `aeon_x8` は戻らない。
- 効果：`aeon_x8` に一致していた形（8 列・備考に用途）は形式不明で止まり、画面（§7）で経理が判断する（D3）。**取込済みの取引は変わらない。**なお、版の固定の検査 `assertPinnedVersionStillActive`（`13_CardDetector.gs` 697 行）は `src/` のどこからも呼ばれていない ── 止めた時点で `aeon_x8` を固定して処理中のファイルは、そのまま `aeon_x8` で最後まで走る。**だから出す順序が要る**（次の項）。
- **出す順序：push → F5 → `opsDisableAeonX8` → それから記帳**（§12）。§3.2 だけが効いている間に取り込むと `meisai202504` 型を誤読する。定期取込は止まっている（`opsStopScheduledImport`）ので、人が記帳を押さなければ間は空かない。

---

## 4. 全体の流れ

1. 中央のファイル一覧で、形式不明のファイルの行に［形式を確認］が出る（§5.11・§7.1）。
2. 押すと「形式の確認」パネルが開き、サーバーが診断する（§5.2）。結果は 4 つのどれか：

| 判定 | 意味 | 画面が出す操作 |
|---|---|---|
| `MATCHES_ACTIVE` | いまは登録済みの形式で読める（止まった後に形式が足された・判定が直った） | ［登録済みの形式で再検査する］（§5.8） |
| `AMBIGUOUS` | 2 つ以上の形式に一致する | 案内だけ（メニューから扱う） |
| `NEAR` | 近い形式がある | 差の説明。**用途列の不備なら**［顧客に修正を依頼する］（先頭）と［別の形式として登録する…］（D3）。そうでなければ登録の入力欄 |
| `BLANK` | 近い形式が無い | 登録の入力欄（白紙） |

3. 登録の入力欄：見本の表・列の割当て（提案つき）・形式 ID と名前 →［試し読み］（§5.6）。
4. 試し読みの結果に止める理由（§6）が無ければ［保存して有効にする］（確認ダイアログ）。
5. 保存（§5.7）→ 保存した行から読み直した結果と、同じフォルダの形式不明ファイルのうち新しい形式で読めるものを出す →［選んだファイルを取込待ちに戻す］（§5.8）／［この登録を取り消す］（§5.10）。
6. 利用者が［記帳を実行］（既存）。

---

## 5. Part B ── サーバー

### 5.1 置き場所と認可

| ファイル | 置くもの |
|---|---|
| `src/19_FormatRegistration.gs`（新設） | 診断・差の計算・提案・導出・試し読み・検査・保存・無効化の本体。**`authorize`・`authorizeOperation` を呼ばない** ── `test/phase7-authorization.test.js` の `auth F-35`（684〜693 行）が、呼んでよいファイルを `03`・`80`・`96` に固定している |
| `src/80_WebApp.gs` | 入口 6 つ（§5.2・§5.6〜§5.10）。すべて `webAppInvoke_` で包み、最初に認可する。ファイル一覧の変更（§5.11）。定数（§5.12） |
| `src/04_Provisioning.gs` | `installCardFormat` の行の組立てを `cardFormatRowValues_(spec, version, now, actor)` として切り出す。**`installCardFormat` の振る舞い（書く値・冪等性・`supersede`）は変えない。**試し読みと保存が同じ関数で行を作るため（P1・P4）── 試し読みが別の組み立てで検証すると、保存した行と違う定義を試し読みしたことになる |
| `src/52_FileResolution.gs`・`src/03_Authorization.gs` | 操作 `RETURN_TO_CUSTOMER`（§5.9） |

**認可**（入口すべて）：

- `authorize(ROLE.SYSTEM_ADMIN, customerId, {operation: 'WEBAPP:<操作名>'})`。操作名は `形式診断`・`形式試し読み`・`形式保存`・`形式取消し`・`再検査へ戻す`・`要修正へ回す`。**`SYSTEM_ADMIN` にする理由**：形式は全顧客共通のマスターを書き換える（F5）。既存の `REGISTER_FORMAT` も `SYSTEM_ADMIN` である（`03_Authorization.gs` 42 行・`52_FileResolution.gs` 50 行）。オーナーは通る。
- フォルダは `webAppDirectChildFolder_`（`80_WebApp.gs` 496 行）で顧客直下か確かめる。
- ファイルは、そのフォルダの `getFiles()` に在ることを確かめる。**画面から来た ID を信じない**（`spec_webapp.md` §7.3.2 と同じ理由）。
- 対象ファイルには、**この顧客の未解決（`OPEN` または `IN_PROGRESS`）の `FORMAT_UNKNOWN` 要確認**が在ること。`openReviews({fileId: fileId, reviewType: 'FORMAT_UNKNOWN'})` を呼び（`openReviews` が絞れるのは `fileId`・`fullTxId`・`reviewType` だけで、未解決の 2 状態を返す ── `50_ReviewStore.gs` 83〜91 行）、`customerId` を自分で照らす（知らない鍵は黙って無視されるので `customerId` を絞込に書いてはならない。`spec_webapp.md` §5.4）。以下、本仕様の「未解決の `FORMAT_UNKNOWN` 要確認」はこの意味である。**§5.7 手順 8 の `siblings`、§5.11 の `formatReviewId` も同じ意味で数える**（`status === 'OPEN'` だけに絞らない）。無ければ戻り値で `{ok: false, code: 'NOT_FORMAT_UNKNOWN'}`（例外にしない。画面が場合分けする事象は戻り値で返す ── `spec_webapp.md` §6.1）。

### 5.2 診断 `webAppExplainUnknownFile(customerId, folderId, fileId, baseFormatId)`

`baseFormatId` は省略可能（§7.3）。

**何も書かない。**

1. 認可・フォルダ・ファイル・要確認（§5.1）。
2. `defs` ＝ `loadFormatDefinitions({status: 'active', enabled: true})` のうち `valid`。`readFile(fileId, ファイル名, {expectedKeywords: detectionKeywordUnion_(defs)})`（`opsExplainFormatMismatch` と同じ）。
   **ファイル名は Drive の現在の名前を使う**（接頭辞つき）。取込も、使用用途補完と請求年月の抽出に Drive の現在の名前を渡している（`10_DriveScanner.gs` 141 行 → `71_RunOrchestrator.gs` 519・524 行）。rewind は名前を変えないので、取込待ちへ戻した後の取込も同じ名前で読む。**接頭辞を剥がすと、補完の語や請求年月の型が接頭辞にかかる場合に取込と結果が違う。**
3. 全シートで `detectFormatWith(defs, …)` → `aggregateSheetDetections`。文脈は取込と同じ（`origin: 'FILE'`、`targetSheetName` は恒久ファイルインデックス M 列 ── `71_RunOrchestrator.gs` 458〜469 行）。
   - `RESOLVED` → `verdict: 'MATCHES_ACTIVE'`（`formatId`・`formatName` を添える）。**ここで返す。読める形式があるのに登録させない。**
   - `AMBIGUOUS_CARD_FORMAT`・`MULTI_SHEET_AMBIGUOUS` → `verdict: 'AMBIGUOUS'`。ここで返す。
4. 対象シート：1 枚ならそれ。2 枚以上なら、§5.4.2 の白紙の規則で明細候補行がいちばん多いシート（同数なら先のシート）。
5. 各 `def` × 対象シートで `formatGap_`（§5.3）。
6. **フォルダの履歴**：フォルダのファイル（Drive）と処理ログ（**全行を 1 回で読む**。O 列＝形式 ID）を突き合わせ、形式 ID ごとの件数と、形式 ID ごとの最新のファイル（処理ログの開始日時 B 列の降順）を得る。**状態は問わない** ── 処理ログに形式 ID が入るのは判定が `RESOLVED` になったときだけなので、`REVIEW_WAIT` のファイルも「その形式で読めた」証拠である。
   **ただし次のファイルは履歴から除く：対象ファイル自身、および未解決の `FORMAT_UNKNOWN`・`FORMAT_AMBIGUOUS` 要確認を持つファイル。**O 列は `RESOLVED` のときに書かれるだけで消されない（`71_RunOrchestrator.gs` 595 行、`60_ProcessLog.gs` 108 行は既存行を写す）。形式 X で一度読めたファイルが後で形式不明になると O＝X が残り、対象自身が履歴に数えられて参照ファイルにも選ばれる。導出した定義は対象に一致するので `REFERENCE_COLLISION` が必ず立ち、**永久に登録できなくなる。**
7. 近い形式を選ぶ（§5.3.2）。無ければ `verdict: 'BLANK'`、あれば `verdict: 'NEAR'`。
8. `NEAR` なら参照ファイル（§5.4.1）を読んで列の対応を作る。
9. 用途列の不備を分類する（§5.3.3）。
10. 提案（§5.4）を作って返す。

戻り値：

```javascript
{
  ok: true,
  verdict: 'MATCHES_ACTIVE' | 'AMBIGUOUS' | 'NEAR' | 'BLANK',
  reviewId, fileId, fileName, fileType, sheetName, width,
  matched: {formatId, formatName} | null,          // MATCHES_ACTIVE のとき
  nearest: [                                        // NEAR のとき最大 3 件。先頭が既定
    {formatId, formatName, stage, gapText, folderCount,
     reference: {fileId, fileName} | null}
  ],
  purposeGap: {kind: 'PURPOSE_HEADER_VALUE' | 'PURPOSE_COLUMN_ABSENT',
               column, headerText} | null,
  customerSide: boolean,                            // purposeGap !== null
  grid: {rowNumbers: [...], columnLetters: [...], cells: [[...]]},  // §5.4.6
  proposal: {…}                                     // §5.4.7
}
```

`gapText` は `explainFormatVerdict_` が返す 1 行と同じ文である（P1）。

### 5.3 差の計算

#### 5.3.1 `formatGap_(def, sheet, fileType)`

`19` に置き、**`97` の `explainFormatVerdict_`・`explainKeywordGap_`・`explainColumnGap_` はこの戻り値を文にするだけに改める**（説明と診断を 1 つの計算から作る。P1）。**`97` の出力する文は 1 文字も変えない** ── `test/phase6-detector-parser.test.js` の `explain 1`〜`explain 3` がそのまま緑であること。

```javascript
{
  formatId, version,
  stage: 'INVALID' | 'FILE_TYPE' | 'KEYWORDS' | 'COLUMNS' | 'MATCH',
  keywords: {conditions: [{kind: 'allOf'|'anyOf', maxRow, minMatch,
                           found: [...], missing: [...]}], ok},
  width: {actual, min, max},        // max は上限なしなら null
  samplesFound: boolean,
  typeFailures: [{index, type, bad, of}]
}
```

- `stage` は判定の関数（`matchesFileType`・`detectorEvaluateKeywords_`・`matchesColumnProfile`）の結果で決める。**`formatGap_` が自分で「一致」を判定してはならない。**`found`・`missing` は `explainKeywordGap_` の今の計算（正規化した連結文字列への `indexOf`）と同じ。
- `width`・`typeFailures` は §3.2 の `detectorProfileSamples_` の見本で測る。

#### 5.3.2 近い形式の選び方

**候補**：`fileTypes` が合い、次のどちらかを満たす形式。

- `stage` が `COLUMNS`（見出し語は成立し、列数か型で落ちた）
- `stage` が `KEYWORDS` で、`allOf` の条件の不足が**合わせて 1 語**、`anyOf` が無いか成立しており、**かつ一致した見出し語が合わせて 2 語以上**

**「2 語以上」を外してはならない。**`smbc_family_x7`・`x8`・`x9` は xlsx 用で、判定キーワードが「様」1 語（`minMatch` 1）だけである。「1 語足りない」だけを条件にすると、「様」を含まない xlsx ではこの 3 形式が**常に**候補に入り、アプラスが `BLANK` にならない。

**順位**（上ほど優先）：

1. フォルダの履歴にある形式（件数の多い順）
2. `stage` が `COLUMNS` のもの
3. 一致した見出し語の数が多いもの
4. 列数の差が小さいもの（`actual` と `[min, max]` の距離）
5. 形式 ID の昇順

上位 3 件を `nearest` に返す。先頭が既定の土台（`baseFormatId`）で、画面で他の 2 件に切り替えられる。

**履歴を最優先にする理由**：同じフォルダの他の月がその形式で読めていることは、「同じカードである」の最も強い証拠である。見出し語の数だけで順位を付けると、`PAYPAY detail202502` には `paypay_family`・`rakuten_x11`・`aupay_family` の 3 つが同じ 4/5 で並ぶ。

この規則での結果：`PAYPAY detail202502` は履歴があれば `paypay_family`。履歴が無くても、4 語一致の `paypay_family`・`rakuten_x11`・`aupay_family` が 3 語一致の `rakuten_x12`（列数の差 0）より先に来て、列数の差 1 の 2 つのうち形式 ID の順で `paypay_family` が先頭になる。`enavi202509` は 4 語一致の `rakuten_x11`。`au202509` は `COLUMNS` 段の `aupay_family`。`aplus_*` は候補 0 で `BLANK`。**実装したら fmt 12〜14 でこの結果を確かめること。**

#### 5.3.3 用途列の不備（`purposeGap`）

土台（`nearest[0]`）について、次のどちらかに当たれば `customerSide: true`。

| 種別 | 条件 | 例 |
|---|---|---|
| `PURPOSE_HEADER_VALUE` | 見出し語の不足が「使用用途」だけ（正規化後）。列数が土台の範囲内。土台の用途列の見出しセル（対象ファイル、土台の見出し行）が空でなく「使用用途」でもない | `enavi202509`（K1＝「ツール代」）→ `{column: 'K', headerText: 'ツール代'}` |
| `PURPOSE_COLUMN_ABSENT` | 見出し語の不足が無いか「使用用途」だけ。列数が土台の上限 − 1。対象の見出し行に「使用用途」のセルが無い。土台の用途列が土台の最後の列（`purposeColumn` の添字 ＝ `maxColumns − 1`） | `au202509`・`au202510`・`AU202511`（`aupay_family` は 7 列目が用途）、`meisai202504`（`aeon_x9` は 9 列目が用途）→ `{column: null, headerText: null}` |

**`PAYPAY detail202502` は当たらない**（不足が「決済方法」なので）。カード会社の出力違いである。

**`customerSide` は推奨を決めるだけで、登録を禁じない**（D3）。保存には明示の確認が要る（§6 の `ACK_CUSTOMER_SIDE_REQUIRED`）。

### 5.4 提案

**提案は初期値である。**確定させるのは人で、画面はすべてを変えられる（D1）。

#### 5.4.1 参照ファイル（`NEAR` のとき）

- 同じフォルダで、処理ログの形式 ID が土台と同じ最新のファイル（§5.2 手順 6）。無ければ参照なし。
- `readFile` で読み、土台の見出し行（`headerRow`）の、土台の各列（日付・店名・金額・用途・予備金額）のセルを**見出し**として取る。
- 対象シートの見出し行（§5.4.2）で、同じ見出し（`normalizeMerchant` 後の完全一致）を持つ列が**ちょうど 1 つ**なら、それを対応とする（出どころ `REFERENCE`）。0 個・2 個以上なら対応なし。
- **参照ファイルの見出しが空の列は対応なし**（顧客が見出しを付けずに用途の値だけ書いたファイルがあり得る）。
- 読むのは 1 ファイルだけ（`readFile` は 1 回約 3 秒。`spec_webapp.md` 1.5 の(b)）。
- **参照ファイルが読めなければ（例外）、参照なしとして続ける。**参照は提案の材料であって、診断・試し読みの前提ではない。読めなかったことは `nearest[].reference` を `null` にし、警告 `REFERENCE_UNREADABLE`（ファイル名）で知らせる。例外を素通しすると、同じフォルダに壊れたファイルが 1 つあるだけで、その形式を土台にした診断が二度とできなくなる。

確認済みの対応：`PAYPAY detail202502` ← `detail202503`：日付 A「利用日/キャンセル日」→ A、店名 B → B、**金額 F「利用金額」→ E**、**用途 M「使用用途」→ L**。`au202509` ← `au202508`：日付 C・店名 D・金額 E → C・D・E、用途 G「使用用途」→ 対応なし（列が無い）。`enavi202509` ← `enavi202508`：A・B・E → A・B・E、用途 K「使用用途」→ 対応なし（K の見出しは「ツール代」）。

#### 5.4.2 見出し行とデータ開始行

- `NEAR`：土台の `headerRow`・`dataStartRow` を初期値にする。ただし対象シートでその行が見出し候補（下記）でなければ、白紙の規則に落ちる。
- `BLANK`（または上で落ちたとき）：先頭 `SETTINGS.SAMPLE_INFER_SCAN_ROWS`（30）行のうち、非空セルが 2 つ以上あり、非空セルがすべて提案用の型（§5.4.4）で**文字**である行を見出し候補とする。直後 `SETTINGS.SAMPLE_INFER_SAMPLE_ROWS`（20）行に現れる**明細候補行**（提案用の型で日付のセルと数値のセルを 1 つずつ以上持つ行）の数が最も多い候補を見出し行にする。**同数なら下（最初の明細候補行に近いほう）**を採る ── イオンの形では 1 行目（ご利用カード）・5 行目（金融機関・支店…）・6 行目も見出し候補で、直後 20 行に同じ明細が入るので本物の見出し（8 行目）と同数になる。上を採ると 1 行目が選ばれる。データ開始行は、見出し行より後で最初の明細候補行。

#### 5.4.3 列の役割

出どころの優先順：`REFERENCE`（§5.4.1）＞ `HEADER`（下の語彙）＞ なし。

| 役割 | 見出しの語彙（`normalizeMerchant` 後に含む） | 見本での型（明細候補行の過半数） |
|---|---|---|
| 利用日 | 「利用日」「利用年月日」 | 日付 |
| 店名 | 「店名」「利用先」「加盟店」「利用内容」 | 文字 |
| 金額（候補） | 「金額」「総額」「ご利用金」「利用金」 | 見本に数値が 1 つ以上 |
| 使用用途 | 「使用用途」と**完全一致** | 問わない |

- 語彙に当たる列が 2 つ以上あれば、その役割は対応なし（人が選ぶ）。
- **金額は、候補（`amountCandidates`）が 2 列以上なら `HEADER` では初期値を置かない**（D5）。初期値を置くのは `REFERENCE` のとき（その形式で経理が以前に選んだ列と同じ見出しである）と、候補がちょうど 1 列のときだけ。**候補が 2 列以上なら、初期値の有無にかかわらず保存には明示の確認が要る**（§6 `ACK_AMOUNT_CHOICE_REQUIRED`）。
- 確認済み：`aplus_meisai_0000_202503` は日付 B（`20250213` の数値）・店名 C・金額候補 D「ご利用金」と H「お支払金額」（2 列 → 初期値なし）・用途 J。`PAYPAY detail202502` の金額候補は E・G・H・I の 4 列（初期値は `REFERENCE` の E）。

#### 5.4.4 提案用の型（提案にだけ使う）

| 型 | 規則 |
|---|---|
| 日付 | `Date` ／ `interpretDateExpression` が日付を返す文字列 ／ 6 桁または 8 桁の整数で `interpretCompactNumericDate_` が日付を返すもの |
| 数値 | 上の日付に当たらない `number` ／ 数字と `,` `-` `.` だけの文字列 |
| 文字 | 空でない文字列で、上の 2 つに当たらないもの |

**判定（`13`）にも抽出（`24`）にも使わない。**`looksLikeDate_`（15）と `parserCellMatchesType_`（24）を使ってはならない（F4）。

**既知の限界**：6 桁の金額で中の数字が月日に読めるもの（例 `120500`）は日付になる（`interpretCompactNumericDate_`）。`3.14` のような文字列も `interpretDateExpression` では日付になり得る。**だから役割は見出しの語彙を先に見て、型は見出しで決まらないときの補助と見出し行の検出にだけ使う**（§5.4.3）。提案は初期値であり、人が確かめる（D1）。

#### 5.4.5 形式 ID と形式名

- `NEAR`：`<土台の形式 ID>_x<列数>`（例 `paypay_family_x12`）。32 文字を超えるなら土台の側を詰める。既に在れば `_2`・`_3`… を付ける。**「在る」は無効の行も含めて見る**（§5.10）。
- `BLANK`：`new_<yyyyMMdd>_x<列数>`。
- 名前：`NEAR` は `<土台の形式名>（<列数>列版）`、`BLANK` は `<フォルダ名> Excel（<列数>列）`（CSV なら `CSV`）。
- 形式 ID は `/^[a-z0-9_]{1,32}$/`（`13_CardDetector.gs` 328 行と同じ）。

#### 5.4.6 見本の表（`grid`）

対象シートの先頭から、見出し行より上の行と、見出し行、明細 `WEBAPP_FORMAT_GRID_ROWS_`（30）行まで。列は `WEBAPP_FORMAT_GRID_COLUMNS_`（26）まで。セルは表示用の文字列にする（`Date` は `yyyy-MM-dd`、数値はそのまま、空は `''`）。**末尾の空の列は落とす**（矩形読みの幅は表の幅ではない ── `13_CardDetector.gs` 485〜493 行）。

#### 5.4.7 `proposal`

```javascript
{
  baseFormatId,                 // BLANK なら null
  formatId, formatName, sheetName, headerRow, dataStartRow,
  columns: {
    date:     {column: 'C' | null, source: 'REFERENCE'|'HEADER'|null},
    merchant: {…}, amount: {…}, purpose: {…}, amountFallback: {…}
  },
  amountCandidates: [{column, header, numericCount}],
  headers: {A: '…', B: '…', …}  // 見出し行の各列の見出し（表示用）
}
```

### 5.5 回答と導出（試し読み・保存で共通）

画面が送る回答：

```javascript
{
  baseFormatId: 'paypay_family' | null,
  formatId, formatName, sheetName, headerRow, dataStartRow,
  columns: {date: 'A', merchant: 'B', amount: 'E', purpose: 'L', amountFallback: null},
  acknowledgements: {customerSide: false, amountChoice: true}
}
```

**サーバーは回答から形式の定義を導出する**（P5）。導出は決定的で、同じ回答と同じファイルからは常に同じ定義になる。

| 項目 | 導出 |
|---|---|
| A・B 形式 ID・形式名 | 回答 |
| E ファイル種別 | `[対象ファイルの種別]` |
| F 判定キーワード | `{allOf: [{maxRow: headerRow, keywords: K, minMatch: K.length}]}`。K ＝見出し行の非空セルを左から、`normalizeMerchant` 後 2 文字以上・**数字（`0-9`・`０-９`）を含まない**・（正規化後で）重複なし・最大 12 個。**入れるのは元のセルの文字（前後の空白を除いたもの）**で、正規化は判定が行う。**数字を外すのは、「9月支払金額」「10月繰越残高」のように月で変わる見出しがあるため**（楽天）。**「使用用途」も入れる**（顧客が足すべき列が無いファイルを、この形式に当てないため） |
| G・H | 回答 |
| I・J・K・L・AJ | 回答の列記号（`amountFallback` は予備金額列 AJ） |
| N 列構造 | `{minColumns: w, maxColumns: w, sampleRows: 5, columns: [{index: 日付, type: 'date', required: true}, {index: 店名, type: 'text', required: true}, {index: 金額, type: 'number', required: true}]}`。w ＝ `detectorTableWidth_`（見出し行と §3.2 の見本で測る）。**上限も w にする** ── 列数が同一発行元の幅違いを分ける唯一の安定した材料である（`13_CardDetector.gs` 534〜535 行） |
| O 除外条件 | `excludeRowRanges: [{from: 1, to: dataStartRow − 1}]`、`excludeWhenDateAndAmountEmpty: true`。`rules` は土台のうち**列記号を持たない規則（`target: 'row'`）だけ**を引き継ぐ。白紙は `[]` |
| P 照合式 | 土台が `source: 'none'` だけなら引き継ぐ。**列記号を持つ照合（`labeledRow`・`cell`）は引き継がず `none` にする** |
| Q 請求年月 | 土台のうち `kind` が `fileName`・`scanRows` の取得元だけを引き継ぐ（`cell` は位置を持つので外す）。白紙・残りが 0 件なら空欄（請求年月なし） |
| AI カード名 | 土台のうち `folderName`・`sheetName`・`fileName` の取得元を引き継ぐ（位置に依らない。`resolveCardName`、`24_Parser_Generic.gs` 679 行）。`cell` は外す。白紙は `{sources: [{kind: 'folderName'}]}` |
| AK セクション区切り | 土台のものを引き継ぐ（見出しの文字で探すので列に依らない）。白紙は空 |
| Y・Z | 土台のもの。**土台の値が空（`null`）なら `undefined` にして空文字で書かせる。`null` をセルへ書いてはならない** ── 実機のシートは `null` を持てず空セルになり、§5.7 の行の比較が必ず不一致になる（1.1 の(1)）。導出した行（`cardFormatRowValues_` の戻り値）に `null`・`undefined` のセルが 1 つも無いこと（fmt 30b） |
| AE・AF・AG 外貨 | **空**（見出しで対応を取れないので引き継がない。空は不備ではない ── INV-38） |
| R・S・C・D・AD | `generic`・`1`・`active`・`TRUE`・`NEW` |
| AB 登録回答 | `{origin: 'WEBAPP', baseFormatId, customerId, sourceFileId, sourceFileName, referenceFileId, purposeGap, purposeHeader, acknowledgements, amountCandidates: [列…], previewHash}`。**`previewHash` は、AB から `previewHash` の鍵を除いた行で計算し（§5.6 手順 6）、その後で AB に入れる** ── 入れてから計算すると自分自身を含んで循環する |

**列記号を持つ規則を引き継がない理由**：F1 と同じで、列がずれた形式に土台の列記号を持ち込むと、別の列を見る。引き継がなかった規則は警告 `RULES_NOT_INHERITED` で名指しする（§6.2）。

行は `cardFormatRowValues_`（§5.1）で作り、`formatRowFromValues_` で検証する（取込が読むときと同じ検証）。

### 5.6 試し読み `webAppPreviewFormat(customerId, folderId, fileId, answers)`

**何も書かない。**

1. 認可・フォルダ・ファイル・要確認（§5.1）。
2. 対象ファイルを読む。`answers.sheetName` のシート（無ければ `DEFINITION_INVALID`）。
3. 回答から定義を導出する（§5.5）。
4. 検査（§6）。判定の検査には、導出した定義を `formatRowFromValues_` に通した行を使う。
5. **抽出は取込と同じ部品を同じ順で呼ぶ**：`parseFile` → `generateTransactionId`（取込と同じ規則。年補完の行単位の不備が取引 ID で宛先を持つため） → `resolvePurposes(txs, ファイル名, purposeRulesForRun_())`（ファイル名は §5.2 手順 2 の Drive の現在の名前） → `extractBillingYearMonth` → `inferYearsForFile` → `applyDateTriageChecks(txs, billing, 現在時刻)` → 金額が読めない行を 0 円にして `verifyCountsAndTotals(…, 処理ログの行)` → `checkPriorYearUsage` → `validateTransactions`（`35_TransactionChecks.gs`）→ `classifyValidationResult`。**正本は 2 か所に分かれている**：抽出から前年利用までは `71_RunOrchestrator.gs` 486〜545 行、`validateTransactions` と `classifyValidationResult` は `70_ImportFlow.gs` の `runPreValidationBlock`（49〜67 行）。
   `classifyValidationResult` に渡す `validation` の鍵は **`format: {ok: true}`・`scanTruncation`・`effectiveTransactionCount`・`purposeResolution`・`yearInference`・`dateTriage`・`countsTotals`・`priorYear`・`transactionValidation` だけ**。`duplicate`・`purposeRevision`・`destinationSchema`・`inputLimit`・`validationApprovals` は入れない（転記先・取引インデックス・承認は試し読みの材料ではない）。**したがって区分は「見込み」である**（重複や承認で実際の区分は変わり得る。画面もそう言う）。`checkPriorYearUsage` が例外を投げる顧客（個人事業主で年度が無い）では、取込も同じ所で落ちるので、試し読みも例外のままにする。
   - **`detectDisplayIdCollision` は呼ばない**（取引インデックスを読む。試し読みは転記しないので衝突は起き得ない）。
   - **`71_RunOrchestrator.gs` は変えない。**取込の本線に触らない代わりに、試し読みと実際の取込の結果を突き合わせるテストを置く（§10 `fmt 29`）。
6. `previewHash` ＝ `sha256Hex(utf8Bytes(serializeDeterministic(要素)))`（`sha256Hex` はバイト列しか受け取らない ── `90_Utils.gs` 31 行。`62_AuditLog.gs` 12〜15 行と同じ形）。要素は次の順の配列：導出した行の各セルを A 列から 1 要素ずつ（**T・V・AH の 3 列は空文字に置き換え、AB は `previewHash` の鍵を除いた JSON**）、`fileId`、`sha256Hex(読んだファイルのバイト列)`、`acknowledgements.customerSide`、`acknowledgements.amountChoice`。**ファイルが差し替わった・回答が変わった・確認を外した、のどれでも値が変わる。**
7. 返す。

戻り値：

```javascript
{
  ok: true,
  blocking: [{code, detail}],        // §6.1。1 つでもあれば保存できない
  warnings: [{code, detail}],        // §6.2
  definition: {…},                   // 導出した定義の要約（表示用。見出し語・列数・各列）
  detection: {onTarget: 'ONLY_NEW' | 'NONE' | 'ALSO_OTHERS', others: [formatId…]},
  extraction: {
    count, total,                    // 件数と、金額（amountBillingJpy）の総和
    rows: [{sourceRow, date, amount, merchant, purpose, purposeFilled}],  // 先頭 WEBAPP_FORMAT_PREVIEW_ROWS_ 行
    moreRows,                        // 表示しなかった行数
    excluded: [{sourceRow, ruleId, cells}],
    billing: {status, yearMonth},
    year: {yearless, inferred, reviewRows},
    purposeEmptyCount, zeroAmountCount,
    category: {category: 1 | 2 | 3 | null, code}
  },
  amountComparison: [{column, header, total, differsRows}],  // 金額候補ごと
  previewHash
}
```

**`excluded` には、明細の開始行より前の行（`ruleId` が `_rowRange` のもの）を入れない。**`parseFile` は 1 行目から走査して、開始行より前を必ず `_rowRange` で除外する（`24_Parser_Generic.gs` 268 行）ので、入れると見出しと前置きの行が毎回並び、`EXCLUDED_ROWS` も毎回出る。数は `excludedBeforeStart` として別に返す。**読み戻しの比較（§5.7 手順 7(b)）は除外の全部（`_rowRange` を含む）で比べる**（表示を絞っても、比べる材料は絞らない）。`date` は年補完後の導出日（`CommonTransaction.date`）。`purposeFilled` は使用用途補完で埋まった行か。`amountComparison` は、候補の各列を金額として読んだときの合計と、選んだ列と値が違う行数（分割払い・返品の行で違う。D5 の判断材料）。

### 5.7 保存 `webAppSaveFormat(customerId, folderId, fileId, answers, previewHash)`

1. 認可・フォルダ・ファイル・要確認（§5.1）。
2. **§5.6 の 2〜6 をやり直す。画面から来た試し読みの結果を信じない。**計算した `previewHash` が受け取った値と違えば `{saved: false, code: 'PREVIEW_STALE'}` を返し、何も書かない。
3. `blocking` が 1 つでもあれば `{saved: false, blocking}`。
4. `withScriptLock_` の中で、形式 ID が無いこと（**無効の行も含む**）を確かめてから `installCardFormat(spec)`。**ロックの中で行うのはこの 2 つだけ**にする。`withScriptLock_` は入れ子にできず（`01_DataAccessCore.gs` 100〜104 行。スタブも保持中は取れない）、`appendAudit` は自分でロックを取る（`62_AuditLog.gs` 48 行）。監査・`recordError`・`disableCardFormat_` はロックの外で行う。
5. **ロックを出たらすぐ**監査 `FORMAT_REGISTER`（`targetType: 'FORMAT'`、`targetId`＝形式 ID、`customerId`、`after: {formatId, version, baseFormatId, sourceFileId, previewHash}`）。**読み戻しより前に書く** ── 読み戻しが不一致で無効にしたときも「行を足した」事実が監査に残るようにする（後に書くと、不一致の経路では `FORMAT_DISABLE` だけが残り、マスターに行が増えた理由が監査から消える）。
6. **読み戻し**：`loadFormatDefinitions({formatId, version: 1})` がちょうど 1 行・`valid`。`loadFormatDefinitions` の実行単位の覚えは取込の区間でしか効かないので（`13_CardDetector.gs` 414 行）、ここでは必ずシートを読み直す。`installCardFormat` は `SpreadsheetApp` で書き、`loadFormatDefinitions` は Sheets API で読むが、`sheetsReadRanges_` が API 専用でないシートを読む前に自分で `SpreadsheetApp.flush()` する（`01_DataAccessCore.gs` 313 行）ので、呼出し側で flush を足す必要はない。
7. 読み戻した行を 2 通りに比べる。**(a) 行の値**：読み戻した行の各セルが導出した行と一致すること（T・V・AH を除く。JSON の列は解析してから比べる）。**空の比べ方：`null`・`undefined`・`''` は同じとみなす。**実機のシートは `null` を持てず、読取（`UNFORMATTED_VALUE`）は空セルを返さないので `padRowValues_` が `''` で埋める。スタブは書いた `null` をそのまま返すので、この差はテストでは出ない（fmt 30b が実機の読み方を模す）。**(b) 結果**：読み戻した行で §5.6 の 4〜5 をやり直し、要約を保存前と比べる ── 件数・合計・各行の（`sourceRow`・金額・用途・店名・導出日）・除外行・区分。あわせて、対象ファイルを有効な全形式（保存した行を含む）で判定し、`aggregateSheetDetections` が新しい形式で `RESOLVED` になること。**(a) が要る理由**：判定キーワードを 1 語落とすような書き損じは、対象ファイルの抽出も判定も変えないので (b) だけでは見えない。しかし次に来る他のファイルでは効く。**どれか 1 つでも違えば** `disableCardFormat_(formatId, 'READBACK_MISMATCH', 実行者)` し、`{saved: true, readback: 'MISMATCH', disabled: true, diff}` を返す。
7'. **確認を終える前の例外は安全側に倒す**（1.5）。`installCardFormat` の後、手順 7 の確認（行の値・結果・判定）がすべて一致するまでの間に例外が出たら（登録の監査・読み戻しの読取・比較のどこでも）、`disableCardFormat_(formatId, 'READBACK_UNCERTAIN', 実行者)` を試み（これ自体の失敗も例外から守る）、`{saved: true, formatId, version: 1, readback: 'UNCERTAIN', disabled: 無効にできたか}` を返す。**確認を終えていない形式を有効のまま残してはならない** ── 形式は全顧客の取込に効き（F5）、P4 は書いた値を信じないことを求めている。確認がすべて一致した**後**の例外（手順 8 の兄弟ファイルの列挙など）は、形式を無効にせず `readback: 'OK'` で返し、`siblings` を空・`siblingsError: true` とする（兄弟ファイルは画面の便宜であり、形式の正しさとは関係が無い）。
8. **同じフォルダの形式不明ファイル**：この顧客の `OPEN` な `FORMAT_UNKNOWN` 要確認のうち、ファイルがこのフォルダに在り、対象ではないもの。`fileId` の昇順に最大 `WEBAPP_FORMAT_SIBLING_LIMIT_` 件、締切ゲート（§5.12）の範囲で読み、有効な全形式で判定する。
9. 返す：

```javascript
{
  saved: true, formatId, version: 1, readback: 'OK',
  after: {count, total, category},           // 保存した行から読み直した要約
  siblings: [{fileId, fileName, reviewId,
              verdict: 'MATCHES_NEW' | 'MATCHES_OTHER' | 'NO_MATCH' | 'AMBIGUOUS'}],
  siblingsNotRead: [fileId…]                 // 上限・締切で読まなかったもの
}
```

### 5.8 取込待ちへ戻す `webAppRequeueFormatFiles(customerId, folderId, fileIds)`

- `fileIds` は最大 `WEBAPP_FORMAT_REQUEUE_LIMIT_` 件（超えたら先頭から、残りは `remaining`）。
- 各ファイルについて：§5.1 の検査 → 読んで有効な全形式で判定 → `RESOLVED` でなければ `skipped`（`STILL_UNKNOWN`・`AMBIGUOUS`）→ `resolveFileReview(reviewId, 'REGISTER_FORMAT', {role: ROLE.SYSTEM_ADMIN, actor})`（`moveFile_` が監査 `REVIEW_RESOLVE` を 1 行書く ── `52_FileResolution.gs` 444〜448 行）→ `rewindFileForReimport_(fileId)` → 監査 `FORMAT_REQUEUE` を 1 行（`targetType: 'FILE'`、`targetId`＝ファイル ID、`customerId`、`before: {fileState: 'VALIDATING'}`、`after: {fileState: 'DISCOVERED', formatId: 判定した形式 ID}`、`reason: 'WEBAPP'`）。**1 ファイルにつき監査は 2 行**（fmt 40 が固定する）。前 2 手は `opsRetryUnknownFormats`（`97_Ops.gs` 387 行）と同じである。判定の文脈は §5.2 手順 3 と同じ（恒久ファイルインデックス M 列の `targetSheetName`）。
- **判定し直してから戻す。**戻したファイルが形式不明のままなら、次の記帳で同じ要確認がまた立つだけだが、利用者には「戻したのに戻らない」と見える。`opsRetryUnknownFormats` は判定せずに全件戻すが、あれは管理者の一括操作である。
- 各ファイルの前に締切ゲート（§5.12）。満たさなければ残りを `remaining` に入れて返す。
- **戻すだけで取り込まない**（P6）。

戻り値：`{requeued: [{fileId, fileName, formatId}], skipped: [{fileId, code}], remaining: [fileId…]}`。

### 5.9 顧客に修正を依頼する `webAppReturnFileToCustomer(customerId, folderId, fileId, reason, note)`

- `reason` は `PURPOSE_COLUMN_MISSING`・`PURPOSE_HEADER_VALUE`・`PURPOSE_IN_ISSUER_COLUMN`・`OTHER` のどれか。`note` は任意（200 文字まで）。
- `resolveFileReview(reviewId, 'RETURN_TO_CUSTOMER', {role: ROLE.SYSTEM_ADMIN, actor})`。
- `recordError(fileId, {code: 'SOURCE_REQUIRES_CUSTOMER_FIX', detail: reason ＋ note})`。**新しいエラーコードを作らない** ── `test/phase0.test.js` 70〜98 行が `ERROR_CATALOG` のコードの集合を固定しており、区分 1 の既存コードと意味も同じである。
- 戻り値：`{returned: true, fileId, nextState: 'CUSTOMER_FIX_REQUIRED'}`。

**`52_FileResolution.gs` の変更：**

- `FILE_REVIEW_OPERATIONS_.FORMAT_UNKNOWN` の**末尾**に `'RETURN_TO_CUSTOMER'` を足す。
- `FILE_OPERATION_ROLES_` に `RETURN_TO_CUSTOMER: ['SYSTEM_ADMIN', 'OWNER_ADMIN']`。
- `resolveFileReview` で `RETURN_TO_CUSTOMER` は `moveFile_(review, op, actor, input, FILE_STATE.CUSTOMER_FIX_REQUIRED)`（`REJECT_COUNT_MISMATCH` と同じ形。93 行）。`REVIEW_WAIT → CUSTOMER_FIX_REQUIRED` は遷移表に在る（`11_FileStateManager.gs` 9 行）。接頭辞【要修正】は `transitionFileState` が付ける。
- `03_Authorization.gs` の `OPERATION_ROLES_` に `RETURN_TO_CUSTOMER: 'SYSTEM_ADMIN'`。`test/phase7-authorization.test.js` の `OPERATION_ROLE_EXPECTATIONS` に同じ 1 行（`auth D-27` が両者の一致を固定している。§15-2 の `RESOLVE_PARTNER_UNKNOWN` と同じ足し方）。

**メニュー（96）には出さない。**`resolveOptionsFor_`（`96_Menu.gs` 627〜631 行）は `MENU_RESOLVE_OPERATIONS_` に定義のある操作だけを番号つきで出すので、定義を足さなければ出ず、既存の番号も変わらない。`96_Menu.gs` は 1 行も変えない。

### 5.10 登録の取消し `webAppWithdrawFormat(customerId, formatId)`

- 対象は、AB 列の `origin` が `'WEBAPP'` の**有効な**行だけ。それ以外（コードから入れた形式）は `{withdrawn: false, code: 'NOT_WEBAPP_FORMAT'}`。有効な行が無ければ `NOT_ACTIVE`。
- `disableCardFormat_(formatId, 'WITHDRAWN_BY_OPERATOR', 実行者)`。
- 取り込み済みの取引は変わらない。取消しの後、この形式で読めていたファイルは次の取込から形式不明で止まる（確認ダイアログで言う。付録 B）。
- **取り消した形式 ID は再利用できない**（§5.4.5 の「在る」は無効の行も含む）。取引ログ・処理ログが形式 ID と版で定義を指すので、同じ ID に別の定義を入れると過去の記録の意味が変わる。

### 5.11 ファイル一覧の変更（`webAppListFolder`）

- ファイルの行に `formatReviewId`（この顧客の `OPEN` な `FORMAT_UNKNOWN` 要確認の `reviewId`。無ければ `null`）を足す。
- **`openReviews` を読むのは、フォルダのファイルに `REVIEW_WAIT` の行が 1 つ以上あるときだけ**にする。無いフォルダの往復を増やさない。
- `stateLabel`・`importable` は変えない。

### 5.12 定数（`80_WebApp.gs`）

| 定数 | 値 | 根拠 |
|---|---|---|
| `WEBAPP_FORMAT_FILE_WORST_MS_` | 20000 | 1 ファイルを読んで判定し、戻すまでの最悪。`readFile` の実測約 3 秒（`spec_webapp.md` 1.5 の(b)）× 2 ＋ 戻し（`resolveFileReview`＋`rewindFileForReimport_`）約 35 往復 × `WEBAPP_TRIP_WORST_MS_`（400）＝ 20 秒。**35 往復は未実測**（受入 6 で測る） |
| `WEBAPP_FORMAT_SIBLING_LIMIT_` | 6 | 6 × 20 秒 ＝ 120 秒。保存までの固定費（対象と参照の 2 読取・マスターの読み書き）を足しても締切 300 秒に収まる |
| `WEBAPP_FORMAT_REQUEUE_LIMIT_` | 6 | 同上 |
| `WEBAPP_FORMAT_PREVIEW_ROWS_` | 50 | 表示の上限。件数・合計は全行で数える |
| `WEBAPP_FORMAT_GRID_ROWS_` | 30 | 見本の表の明細行 |
| `WEBAPP_FORMAT_GRID_COLUMNS_` | 26 | 見本の表の列 |

**締切ゲート**：ファイルを 1 つ読む前に `経過時間 + WEBAPP_FORMAT_FILE_WORST_MS_ <= WEBAPP_DEADLINE_MS_`。満たさなければ読まずに残す。経過時間は入口に入った時刻から測る。**時刻は `webAppFormatNowMs_()`（`80_WebApp.gs` に置く。中身は `Date.now()`）からだけ取る** ── ハーネスの `Date` は本物なので、テストはこの関数を差し替えて時計を進める（fmt 36）。

---

## 6. 検査（試し読み・保存で共通）

### 6.1 止める理由（`blocking`）

1 つでもあれば保存できない。試し読みでは全部を並べて返す（最初の 1 つで止めない）。

| コード | 条件 | 理由 |
|---|---|---|
| `DEFINITION_INVALID` | `formatRowFromValues_` が不適合（`problems` を添える） | 取込が読めない定義を入れない |
| `FORMAT_ID_INVALID` | `/^[a-z0-9_]{1,32}$/` に合わない | |
| `FORMAT_ID_TAKEN` | その ID の行が在る（**無効の行も含む**） | §5.10 |
| `FORMAT_NAME_REQUIRED` | 形式名が空、60 文字超、または先頭が `=`・`+`・`-`・`@` | 先頭がこれらだと `setValues` が数式として書き、読み戻しが一致しない（数式の注入にもなる） |
| `HEADER_ROW_INVALID`・`DATA_START_INVALID` | 見出し行が 1 未満・シートの行数超、データ開始行が見出し行以下・行数超 | |
| `COLUMN_OUT_OF_RANGE` | 割り当てた列が表の幅の外 | |
| `COLUMN_ROLE_DUPLICATE` | 日付・店名・金額・用途のうち 2 つが同じ列 | |
| `PURPOSE_COLUMN_REQUIRED` | 用途の列が「なし」 | 取り込むと全件が区分 1（要修正）になる。用途の列が無いファイルは顧客に修正を依頼する（§5.9） |
| `TOO_FEW_KEYWORDS` | 判定キーワードが 2 語未満 | 何にでも一致する |
| `NOT_MATCHING_TARGET` | 導出した定義 1 つだけで対象ファイルを判定して `RESOLVED` にならない（差 `formatGap_` を添える） | 保存しても、このファイルは形式不明のまま |
| `TARGET_AMBIGUOUS` | 有効な全形式＋導出した定義で判定して、導出した定義以外にも一致する | 保存すると、このファイルが `AMBIGUOUS` で止まる |
| `STATIC_COLLISION` | 有効な形式 X について、**X の判定キーワードが対象ファイルで成立し**（`detectorEvaluateKeywords_`）、**X の列数の範囲と w が重なる** | X は見出しでも列数でもこのファイルに当たっているのに、型だけで外れている ── **判定の不具合の疑い**（§3 のイオンがこの形だった）。登録しても、この形のファイルが次に来たとき X にも当たり得る |
| `REFERENCE_COLLISION` | 導出した定義が参照ファイル（§5.4.1）に一致する | 同じカードの別の様式を横取りする。保存すると参照ファイルの様式が `AMBIGUOUS` で止まる |
| `NO_TRANSACTIONS` | 抽出が 0 件 | 専用パーサーの領分（4.12.8） |
| `ZERO_AMOUNT_MAJORITY` | 金額が 0 または読めない行が抽出の過半数 | F1 の誤り方（別の列を金額として読んでいる）をここで止める。実在する明細でこうはならない |
| `ACK_CUSTOMER_SIDE_REQUIRED` | 診断の `customerSide` が真、**または**用途に割り当てた列の見出しが「使用用途」でない（空を含む。**用途が「なし」のときは後者を見ない**）のに、`acknowledgements.customerSide` が `true` でない | D3。後者は `aeon_x8` の形（F2）である ── カード会社も書く列の文言が使用用途として転記される |
| `ACK_AMOUNT_CHOICE_REQUIRED` | 金額候補が 2 列以上なのに `acknowledgements.amountChoice` が `true` でない | D5 |
| `PREVIEW_STALE` | （保存のみ）`previewHash` が一致しない | §5.7 |

**`STATIC_COLLISION` の確認済みの例**：§3 を入れる前の `meisai202508` に 9 列の変種を登録しようとすると、`aeon_x9` の見出し語が成立し列数 9 が重なるので止まる。§3 を入れた後は、そもそも `MATCHES_ACTIVE` になる。`au202509`（6 列）は `aupay_family`（7〜7）と列数が重ならないので止まらない。

### 6.2 警告（`warnings`）

止めないが、画面は必ず出す。

| コード | 条件 | 画面が言うこと |
|---|---|---|
| `PURPOSE_EMPTY_ROWS` | 補完の後も用途が空の行がある（件数） | このまま取り込むと【要修正】（区分 1）になる |
| `CATEGORY_2` | `classifyValidationResult` が区分 2（コード） | このまま取り込むと、その理由で止まる |
| `REVIEW_ROWS` | 区分 3 の要確認が立つ行がある（件数 ＝ `classifyValidationResult` の戻り値 `reviewEntries` の数。`transactionValidation.issues` だけを数えない ── 年の補完・日付の判定・前年利用の問題も区分 3 の理由である） | 取込後に要確認になる |
| `BILLING_MONTH_UNRESOLVED` | 請求年月の取得元があるのに `RESOLVED` でない | 年の補完が効かない |
| `EXCLUDED_ROWS` | 明細の開始行より後で除外された行がある（件数。`_rowRange` は数えない） | 除外した行を確かめる |
| `RULES_NOT_INHERITED` | 土台の規則のうち列記号を持つものを引き継がなかった（名指し） | §5.5 |
| `FOREIGN_NOT_INHERITED` | 土台が外貨の列を持っていた | この形式では外貨の補足を取らない |
| `PURPOSE_HEADER_NOT_STANDARD` | 用途の列が選ばれていて、その見出しが「使用用途」でない（見出し）。**用途が「なし」なら出さない**（`PURPOSE_COLUMN_REQUIRED` が止める） | `ACK_CUSTOMER_SIDE_REQUIRED` の説明 |

---

## 7. Part C ── 画面（`81_WebAppUi.html`）

既存の画面の作法（`gasCall`・`showNotice`・`failureMessage`・状態の世代管理・`isMutationBusy`）に合わせる。

### 7.1 ファイル一覧

- `formatReviewId` がある行は、状態の欄に「形式不明」と出し、［形式を確認］ボタンを置く。
- ボタンは、取込・確定・形式の操作のどれかが走っている間は押せない（`isMutationBusy` に形式の操作を加える）。

### 7.2 右カラム

「その他の要確認」の `FORMAT_UNKNOWN` の案内を「中央のファイル一覧の［形式を確認］から扱えます」に変える。

### 7.3 形式の確認パネル

最終確認と同じ全幅のパネル（`final-panel` と同じ作り）。上から：

1. ファイル名・シート名・列数
2. 診断（§5.2 の `verdict` ごと。文言は付録 B）
3. `NEAR` なら近い形式の選択（`nearest` の最大 3 件）。**切り替えたら、サーバーに `baseFormatId` を渡して診断し直す**（提案を画面で作り直さない。P5）
4. 見本の表（§7.4）
5. 列の割当て（§7.5）・形式 ID・形式名
6. ［試し読み］と、その結果（§7.7）
7. ［保存して有効にする］

**用途列の不備（`customerSide`）のとき**は、2 の直後に付録 B の説明と、**先頭に［顧客に修正を依頼する（【要修正】にする）］**、その下に［別の形式として登録する…］を置く。後者を押すまで 4〜7 は出さない（§7.6）。

> 3 のために、`webAppExplainUnknownFile` は省略可能な第 4 引数 `baseFormatId` を受け取る。与えられたら、その形式を土台にして §5.2 の 8〜10 を行う（`nearest` の中の形式に限る。それ以外は無視して既定の選び方に戻る）。

### 7.4 見本の表

列記号の見出し・行番号・見出し行とデータ開始行の強調・割り当てた列の強調（役割名を列の上に出す）。

### 7.5 列の割当て

- 見出し行・データ開始行：数値の入力。
- 利用日・店名・使用用途・予備金額：選択。選択肢は「`C`「利用日」 2025-08-31 …」のように列記号・見出し・先頭の値を並べる。出どころ（参照ファイル／見出し／要選択）を横に出す。
- 金額：候補（`amountCandidates`）が 2 列以上なら、**選択ではなく候補を並べた一覧**にし、各候補の見出し・先頭の値・（試し読みの後は）合計と、選んだ列と値が違う行数を出す。**`REFERENCE` 以外で初期値を置かない。**「金額の列を確認した」のチェックが `acknowledgements.amountChoice`。
- **どれかを変えたら、試し読みの結果を古いものとして消す**（`previewHash` を捨て、保存を押せなくする）。

### 7.6 用途列の不備のとき

- ［顧客に修正を依頼する（【要修正】にする）］→ 確認ダイアログ（付録 B）→ `webAppReturnFileToCustomer`。`reason` は `purposeGap.kind` から（`PURPOSE_HEADER_VALUE` → 同名、`PURPOSE_COLUMN_ABSENT` → `PURPOSE_COLUMN_MISSING`）。
- ［別の形式として登録する…］→ 入力欄を出し、上に警告（付録 B）と、チェック「入力ミスを様式として登録することを理解した」（`acknowledgements.customerSide`）を置く。
- 用途に割り当てた列の見出しが「使用用途」でないときも、同じチェックを出す（文言は付録 B の別の行）。

### 7.7 試し読みの結果

- 止める理由（`blocking`）を先頭に赤で並べる。1 つでもあれば保存を押せない。
- 件数・合計・区分の見込み（区分 1 なら「このまま取り込むと【要修正】になります」）。
- 取引の表（行・利用日・金額・店名・使用用途）。**金額が 0 または空の行、用途が空の行を強調する。**
- 除外した行・請求年月・年の補完・警告。

### 7.8 保存の後

- 確認ダイアログ（付録 B）→ `webAppSaveFormat`。
- `readback: 'OK'` なら「保存しました。保存した行から読み直した結果も一致しました」と、`after` の件数・合計。
- `readback: 'MISMATCH'` なら「保存した行を読み直すと結果が違ったので、この形式を無効にしました」と `diff`。
- `siblings` を一覧にし、`MATCHES_NEW` の行にチェックを入れた状態で［選んだファイルを取込待ちに戻す］。`siblingsNotRead` があれば件数を出す。
- ［この登録を取り消す］→ 確認ダイアログ → `webAppWithdrawFormat`。

### 7.9 `MATCHES_ACTIVE` のとき

「登録済みの形式「{形式名}」で読めます」と［登録済みの形式で再検査する］→ `webAppRequeueFormatFiles([fileId])`。

### 7.10 終わったら

取込待ちへ戻す・要修正へ回す・取り消すの後は、ファイル一覧と要確認を読み直す。取込待ちへ戻した後は「［記帳を実行］で取り込みます」と案内する（P6）。

---

### 7.11 実装の注意（1.1 の監査で出た形）

| # | 守ること | 1.0 の実装で起きたこと |
|---|---|---|
| U1 | **サーバーの戻り値は 3 通りに分けて扱う**：`ok: false`（`NOT_FORMAT_UNKNOWN` など）／`saved: false`／`saved: true`。`saved === true` を明示して成功と判定する | 保存が `{ok: false, code: 'NOT_FORMAT_UNKNOWN'}` を返すと成功扱いになり、`saved.after.count` で例外 → `finally` の再描画が途中で止まり、**画面全体のボタンが無効のまま固まる**。`ok: false` を受けたら付録 B の文を出し、パネルを閉じてファイル一覧と要確認を読み直す（試し読み・要修正へ・診断でも同じ） |
| U2 | **確認のチェック欄を出すかどうかは、サーバーと同じ材料で決める**：用途の列の見出しは、回答の `headerRow` の行（`grid.cells[headerRow − 1]`）から取り、**`normalizeMerchant`（`32_MerchantNormalizer.gs`）と同じ処理**をしてから「使用用途」と比べる ── NFKC・大文字化・**空白と改行（`\u3000\t\r\n\f\v` と半角空白）の連なりを半角空白 1 つにまとめる**・ダッシュ類を `-` に・制御文字を除く・前後を削る。**空白を消してはならない**（1.2 の(1)。1.1 は「空白除去」と誤って書いていた）。この処理は画面に 1 つの関数として置き、比べる両辺にかける。選択肢に出す見出しも同じ行から取る | `proposal.headers`（提案時の見出し行で固定）の生の文字で比べていた。見出し行を変えるとサーバーは `ACK_CUSTOMER_SIDE_REQUIRED` で止めるのにチェック欄が出ず、**保存できなくなる** |
| U3 | **試し読みの応答は、送った回答と今の回答が同じときだけ採用する**（送るときに `JSON.stringify(answers)` を控え、応答時に比べる）。処理中は確認のチェック・近い形式の選択・入力欄をすべて無効にする | 処理中に確認を外すと、古い結果と古い `previewHash` が今の結果として採用された（サーバーが `PREVIEW_STALE` で止めるので書込は起きないが、画面の言うことが事実と違う） |
| U4 | **保存した後は入力欄・試し読み・保存を無効にする。**入力を触っても保存の結果（`siblings`・取込待ちへ戻す・取り消す）を消さない。取り消した後は取込待ちへ戻す・取り消すを消す。`MISMATCH` の後は「形式 ID を変えてやり直してください（同じ ID は使えません）」と出す | 保存後も［保存して有効にする］が押せ（`FORMAT_ID_TAKEN` になる）、入力を 1 つ触ると兄弟ファイルの一覧と取消しのボタンが消えて取り戻せなかった |
| U5 | **取込待ちへ戻す結果の `remaining`・`skipped` を必ず言う。**`remaining` は件数と「もう一度押すと残りを戻します」を出し、残りを選んだままにする（上限 6 件ずつ送る）。`skipped` はファイル名と付録 B の理由で出す。1 件も戻らなければ警告の色 | 保存後の一覧は最大 7 件（対象＋兄弟 6）なのに戻す上限は 6 で、7 件目が黙って残った |
| U6 | **止める理由は赤、警告は琥珀**で見分けられるようにする。行の強調は `tr` 用の背景色だけのクラスを使う（`.tag` は `inline-block` なので `tr` に付けると表が崩れる） | 止める理由が警告と同じ色で、`tr` に `.tag` を付けて列がずれた |
| U7 | **止める理由・警告の `detail` を文にする**（付録 B の「`detail` の読み方」）。生の JSON・英語の役割名・形式 ID のままの形式名を出さない | `FORMAT_ID_TAKEN` が「形式 ID「」は…」、`COLUMN_ROLE_DUPLICATE` が「date/amount に…」、`NOT_MATCHING_TARGET` が長い JSON、警告が `FOREIGN_NOT_INHERITED：null` と出ていた |
| U8 | **試し読みの結果は §7.7 を全部出す**：除外した行の表（行・理由・中身）、表示しなかった行数（`moreRows`）、年の補完を文で、区分に「見込み」 | 除外は件数だけ、年は JSON、`moreRows` は出ていなかった |
| U9 | 用途列の不備の説明（付録 B）は、**選んだ土台**の形式名で出し、§7.3 のとおり近い形式の選択より前に置く。土台を切り替えても登録の入力欄は開いたままにする | 常に `nearest[0]` の名前を出し、切り替えるたびに入力欄が閉じた |
| U10 | 登録の警告は、当てはまるものを**両方**出す（用途列の不備＋見出しが「使用用途」でない）。用途が未選択なら 2 つ目は出さない | 片方しか出ない／「未選択列（見出し「」）」と出た |
| U11 | 取込待ちへ戻す・要修正へ・取り消すの後は、パネルを閉じるか診断し直す。`MATCHES_ACTIVE`・`AMBIGUOUS` ではシート名・列数の欄を出さない | 古い診断が残り、「名前 ／  ／  列」と空欄が出た |
| U12 | 確認は既存の `<dialog id="confirm-dialog">` の作法に合わせる（`window.confirm` を使わない）。兄弟ファイルの判定・見本の表の役割名・`MISMATCH` の差・取消しの失敗は付録 B の日本語で出す。§7.2 の案内に「メニューから確定してください」を重ねない | コードのまま・英語のまま・場違いな文が出ていた |
| U13 | 金額の候補が 2 列以上で、`REFERENCE` の列が候補に無いときは、その列も一覧に加えて選ばれた状態にする。その列の合計は `extraction.total`、相違は 0 と出す | どのラジオにも印が付かず、候補以外の列を選べなかった |
| U14 | **入力の変更でパネル全体を作り直さない。**入力欄の `input`／`change` では回答を更新して試し読みを古いものにし、作り直すのは試し読みの結果の欄と保存ボタン（と、チェック欄の出し入れ）だけにする。**押されたボタンやフォーカスのある欄を DOM から外してはならない** | 欄を編集したまま［試し読み］を押すと、mousedown → blur → change で全体が作り直され、押したボタンが消えて 1 回目のクリックが効かなかった。Tab で移るとフォーカスも外れた |
| U15 | **取込待ちへ戻した後に診断を呼び直さない。**残りの表示は保存の結果（`siblings`）と選択の状態だけで作る。対象ファイル（`formatFileId`）を差し替えない | 残りの先頭を診断し直していた ── 読取 1〜2 回と処理ログの全行読みを表示のためだけに使い（読取クォータの予算に反する）、診断が失敗すると「n 件戻しました」の通知がエラーで上書きされ、一覧も読み直されなかった |
| U16 | 除外した行の表は、見出し（行・理由・中身）を付け、理由を日本語で出す：`_dateAmountEmpty` →「利用日と金額が空」、その他の規則 → 「除外の規則「{id}」」。`_rowRange` はサーバーが返さない（§5.6） | 理由が内部コードのまま、見出しより上の行が毎回並んでいた |
| U17 | `NOT_MATCHING_TARGET` の文は `explainFormatVerdict_` と同じ詳しさにする：列の型が合わないときは「{n}列目が{日付/文字/数値}でない行 {x}/{y}」、見本行が取れないとき（`samplesFound: false`）・ファイル種別が違うとき・定義が不正なときもそれぞれ言う。`gapText` に入る強調記号 `**` は画面で落とす | 「列の型が合いません」「形式の条件に合いません」としか言わず、`**列数が…**` が生で出ていた |
| U18 | `DEFINITION_INVALID` は箇条で出す。利用日・店名・金額のどれかが「なし」なら、試し読みを送る前に画面が「{役割}の列を選んでください」と言う（英語の問題文を見せない） | 「、」で 1 行につなぎ、`I (date column) must be a column letter` と出ていた |
| U19 | 保存した後は、一覧の［形式を確認］と［閉じる］で保存の結果を黙って捨てない（確認を挟む） | 押すと取消しのボタンに戻る手段が無くなった |
| U20 | 保存が `{saved: false, blocking}` を返したら、試し読みを古いものにする（止める理由を画面に反映する） | 試し読みの結果が「止める理由なし」のまま、保存が押せた |
| U21 | 処理中は保存後のチェック欄も無効にする。取込・確定の実行中も形式パネルを描き直し（`renderSelection` から呼ぶ）、`formatUpdateAnswer` は `isMutationBusy()` を見る | チェック欄と入力欄だけが処理中も触れた |
| U22 | 要確認の確定の確認ダイアログを開くとき、保留中の形式の確認（`formatConfirmResolve`）を「いいえ」で解決して消す。取消しに使う形式 ID は `state.formatSaved.formatId` から取る | `showModal` が無い環境で、要確認の［確定する］が形式の操作を実行し得た |
| U23 | 診断の `warnings`（`REFERENCE_UNREADABLE`）を出す。§7.3 の並び（診断の文 → 用途列の不備の説明 → 近い形式の選択）と §7.6 の並び（警告とチェックは入力欄の**上**）に合わせる。列の出どころは、人が列を変えたら「手で選択」にする | 診断の警告を出さず、並びが仕様と逆で、出どころが提案時のまま固定だった |
| U24 | **画面の状態は、使う前に必ず初期値を持たせる。**`state` の初期値に置き、パネルを開くとき・閉じるときに戻す（`formatManualColumns: {}` など）。**欄の変更の処理が例外で落ちてはならない** ── 落ちると、その後の「試し読みを古くする」「保存を押せなくする」が走らない | `state.formatManualColumns` を初期化しておらず、列の選択・金額のラジオを変えるたびに `TypeError`。古い試し読みと `previewHash` が残り、保存が押せるままだった（1.3 の高） |
| U25 | 一覧に足す `REFERENCE` の金額列は、**提案の出どころ**（`proposal.columns.amount.source === 'REFERENCE'` の列）で決める。いま選んでいる列で決めない | 人が候補に切り替えてから試し読みすると、`REFERENCE` の列が一覧から消えて戻せなかった |
| U26 | **パネル全体の作り直しは、パネルを開くとき・処理中の状態が変わるとき・保存の状態が変わるときだけ。**最終確認の読込（`loadFinalReview`）など、形式と関係のない処理の終わりに作り直さない（入力中の欄からフォーカスが外れる） | 最終確認の読込が終わるとパネルが作り直され、入力中の欄のフォーカスが外れた |
| U27 | 見出し行・開始行・列を変えたら、見本の表の役割名と強調、列の選択肢に出す見出しの文言も描き直す。金額候補の合計・相違は、今の試し読みがあるときだけ出す（抽出が無い試し読みでも出さない） | 見本の表と選択肢が古い行のまま、試し読みを古くした後も合計が残り、抽出が無いのに「合計 0」と出た |
| U28 | 取込待ちへ戻した後の残りの表示では、戻し終えたファイル（対象を含む）の行を出さない | 戻し済みの対象ファイルのチェック欄が押せるまま残り、送ると `NOT_FORMAT_UNKNOWN` で飛ばされた |
| U29 | **保存の結果があるうちは、フォルダ・顧客の切り替えでも確認を挟む**（U19 の範囲を広げる） | 切り替えると取消しのボタンが確認なしに消えた |
| U30 | 保存の呼出しが**例外や通信断**で終わったときは、「保存できたか確かめられません」と言い、試し読みを古いものにして**診断し直す**（保存されていれば `MATCHES_ACTIVE` と出るので、そこから取り消せる）。サーバーは、保存後の兄弟ファイルの読取と判定を**1 件ずつ例外から守り**、失敗したものを `siblingsNotRead` に入れる | 保存の確定後に兄弟ファイルの読取で例外が出ると、形式は有効のまま画面は汎用のエラーだけになり、押し直すと `FORMAT_ID_TAKEN`、取消しのボタンにたどり着けなかった |
| U31 | パネルを開いたら画面内へスクロールする（`scrollIntoView`。最終確認と同じ）。**形式に関する文（止める理由・`PREVIEW_STALE`・取込待ちへ戻した結果・「{役割}の列を選んでください」）はパネルの中に出す** | パネルは中央の欄の下に出るのに、文は画面最上部の通知に出ていたので、スクロールしている利用者には「押しても何も起きない」ように見えた |
| U32 | `formatSetBusy` はパネルの描画が例外で落ちても一覧・フォルダ・取込ボタンの状態を戻す（描画を後に回すか、例外から守る）。診断の呼出しが失敗したら、空のパネルを残さず中に失敗の文を出す。［閉じる］も処理中は無効にする | 予防（U1 と同じ固まり方を作らない）／空のパネルが残った／［閉じる］が黙って無視された |
| U33 | `NOT_MATCHING_TARGET` で `stage` が `MATCH`（このシートには当たるがファイル全体では決まらない）のときは、「このシートには当たりますが、ファイル全体では 1 つの形式に決まりません（他のシートにも当たります）」と言う | 「形式の条件に合いません」と出て理由と違った |
| U34 | 予備金額の列は任意なので、選んでいないときの出どころを「要選択」と出さない（「なし」） | 必須に見えた |
| U35 | ［別の形式として登録する…］を押した後も、［顧客に修正を依頼する］は消さない（**ただし保存した後は U39**） | パネルを開き直すまで戻れなかった |
| U36 | **取込・確定の実行中も形式パネルを描き直す**（`startImport`・`startResolve` が処理中の印を立てた直後と `finally` で）。処理中は入力欄・選択・チェック・［試し読み］・［閉じる］・一覧の［形式を確認］を無効にする。**画面に出ている値と、送る値（`state.formatAnswers`）を食い違わせてはならない** ── 処理中に打たれた値を黙って捨てると、画面は打った値を、送る回答は古い値を持つ | `startImport` は `updateActionButtons` だけを呼び、パネルは描き直されなかった。取込中に形式 ID を打つと欄は新しい値、送る回答は古い値のまま、その後の試し読みと保存は古い回答で走った |
| U37 | **保存の結果が不確かなまま診断し直して `MATCHES_ACTIVE` になり、その形式 ID が保存しようとした ID と同じなら、［この登録を取り消す］も出す**（保存しようとした形式 ID を覚えておき、`webAppWithdrawFormat` にその ID を渡す）。サーバーは `installCardFormat` の後の処理（監査・読み戻し・兄弟ファイルの列挙）で例外が出ても、**登録した事実（`formatId`）を戻り値で返す**か、少なくとも画面が取り消せる形にする | 診断し直すと［登録済みの形式で再検査する］しか出ず、`withdrawFormat` は `state.formatSaved` が無いと動かないので、登録した形式を画面から取り消せなかった（U30 の目的が果たされていない） |
| U38 | **確認のチェック欄は、中身（出す警告・チェックが要るか・今の値）が変わったときだけ作り直す。**値が前回と同じ `change` や、関係のない欄の `input` では作り直さない | 形式 ID を打った直後にチェックを押すと、mousedown → blur → change で押そうとしたチェックが作り直されて DOM から外れ、1 回目のクリックが効かなかった（U14 と同じ形が、チェック欄に残っていた） |
| U39 | **保存した後は［顧客に修正を依頼する］を出さない（または無効にする）。**`returnFormatToCustomer` も保存の結果があれば断る | 保存後も押せ、押すと要確認が閉じてパネルが閉じ、保存の結果（取消しのボタン）が確認なしに消えた。登録した形式は有効のまま残る（U19・U29 の抜け道） |
| U41 | `readback: 'UNCERTAIN'` の画面：`disabled: true` なら「保存後の確認を終えられなかったので、安全のため無効にしました。形式 ID を変えてやり直してください（同じ ID は使えません）」と言い、取消しのボタンは出さない。`disabled: false` のときだけ「無効にもできませんでした。この登録を取り消すか、管理者に確認してください」と取消しのボタンを出す。`siblingsError: true` なら「同じフォルダのファイルを確かめられませんでした」と言う | 1.4 の実装は `UNCERTAIN` で形式を有効のまま残し、取消しを人に任せていた |
| U40 | **取込待ちへ戻す呼出しが例外で終わっても、パネルの中に文を出し、ファイル一覧と要確認を読み直す。**サーバーの `webAppRequeueFormatFiles` は 1 件ずつ例外から守り、失敗したものを `skipped`（コード `REQUEUE_FAILED`）に入れる（付録 B に 1 行） | サーバーの繰り返しが守られておらず、途中の 1 件の例外で呼出し全体が例外になった。前の数件は戻し済みなのに、画面は最上部に文を出すだけで一覧を読み直さず、戻したファイルが「形式不明」のまま残った |

## 8. 既存コードへの変更（許す差分）

**`src/` の差分はこの 8 ファイルだけ。**

| ファイル | 変更 |
|---|---|
| `src/13_CardDetector.gs` | `detectorProfileSamples_` を置き、`matchesColumnProfile` が使う（§3.2） |
| `src/97_Ops.gs` | `explainColumnGap_` が `detectorProfileSamples_` を使う。`explainFormatVerdict_`・`explainKeywordGap_`・`explainColumnGap_` を `formatGap_` の文にする（**出力は 1 文字も変えない**）。`opsDisableAeonX8` |
| `src/04_Provisioning.gs` | `cardFormatRowValues_` の切り出し（振る舞いは変えない） |
| `src/52_FileResolution.gs` | `RETURN_TO_CUSTOMER`（§5.9） |
| `src/03_Authorization.gs` | `OPERATION_ROLES_` に 1 行 |
| `src/19_FormatRegistration.gs` | 新設 |
| `src/80_WebApp.gs` | 入口 6 つ・`webAppListFolder` の変更・定数 |
| `src/81_WebAppUi.html` | §7 |

**`70`・`71`・`24`・`30`・`31`・`35`・`43`・`44`・`45`・`51`・`96`・`06`・`00` に 1 行の差分も作らないこと。**`70`・`71` を変えない理由は §5.6、`96` は §5.9、`06` は §5.9。

**テスト**：

- 新設 `test/phase9-format-registration.test.js`。
- `test/phase7-authorization.test.js` の `OPERATION_ROLE_EXPECTATIONS` に `RETURN_TO_CUSTOMER: 'SYSTEM_ADMIN'` の 1 行（§5.9）。**それ以外の既存テストは 1 文字も変えない。**
- `test/gas-stubs.js` は、足りないものがあれば足してよい。足したら報告する。
- `test/fixtures/` は変えない。

---

## 9. 検証の考え方

- **テストを先に赤にしてから実装する。**落ちないテストは何も検証していない。
- **変異を入れて、そのテストが本当に赤になることを確かめる**（§11）。赤にならない変異は、この版の無検証箇所として報告する（黙って直さない）。
- 判定のテストは `test/fixtures/` の実ファイル由来の固定データで行う。
- **画面のテストは振る舞いで確かめる。関数のソースに文字列が含まれるか（`String(fn).includes(…)`）で確かめてはならない**（1.3 の高）。リポジトリに npm の依存は無いので、テストの中に**小さな偽の DOM**（`createElement`・`appendChild`・`removeChild`・`textContent`・`value`・`checked`・`disabled`・`addEventListener`・イベントの発火・`getElementById`・`querySelector` の要る分だけ）を置き、`81_WebAppUi.html` の `<script>` をその上で動かして、**パネルを実際に描き、欄を変え、ボタンを押して**確かめる。`google.script.run` は記録つきの偽物にする（呼ばれた関数と引数を残し、決めた値を返す）。
- 取込までを通すテストは、`test/phase8-webapp.test.js` の `setupWorld`・`addCustomer` と同じ作り（マスター・顧客・カードフォルダ・転記先の雛形）を新しいテストファイルの中に持つ。xlsx は `gas.stubs.createFile(id, {name, bytes, xlsxSheets})` で置けば `Drive.Files.copy` のスタブが変換する（`test/gas-stubs.js` 778 行）。

---

## 10. テストのケース

`fmt NN:` で始める。**「何を固定するか」と「どの実装を落とすか」を守ること。**

### 10.1 Part A

| # | 内容 | 落とす実装 |
|---|---|---|
| fmt 1 | 本番の形式集合（`installSmbcCsvFormat`・`installSmbcXlsxFormat`・`installAnnotatedFormatsBatch1`・`opsDisableAeonX8`）で、`イオンゴールドカード__meisai202508`・`イオンカード__meisai202503` が `aeon_x9` に `RESOLVED` | 見本行をセクション見出しで止めない（M1） |
| fmt 2 | 同じ集合で `test/fixtures/samples/` の 33 件：`イオンカード__202512` だけが `UNKNOWN_CARD_FORMAT` に変わり、残り 32 件は `test/phase6-real-samples.test.js` の `EXPECTED` と同じ | 見本の範囲を広く変える・合計行でも止める |
| fmt 3 | `meisai202504`：`aeon_x8` が有効なら `aeon_x8` に一致し、`parseFile` の用途が「ポイント２倍対象」になる（F2 を固定する）。`opsDisableAeonX8` の後は `UNKNOWN_CARD_FORMAT` | `aeon_x8` を止めない |
| fmt 4 | `explainFormatVerdict_(aeon_x9, meisai202504)` が `× 列の条件に合わない。**列数が 8（この形式は 9〜9）**` になる。**`meisai202508` で「○ 一致」を見る形にしてはならない** ── `explainFormatVerdict_` は一致の可否を 13 の `matchesColumnProfile` から得て、`explainColumnGap_` は不成立のときしか呼ばないので、97 が古い拾い方を持ち続けても「○」になる。古い拾い方だと `meisai202504` は分割払いの見出し行（9 セル）を見本に拾い、`列数 9 は範囲内（9〜9）。型の過半数一致に届かない…` になる（どちらもハーネスで確認済み） | `97` が自前の見本の拾い方を持ち続ける（M2） |
| fmt 5 | `opsDisableAeonX8`：D＝FALSE・W と AH に時刻・X＝`PURPOSE_READ_FROM_ISSUER_COLUMN`、監査 1 行。2 回目は何も書かず監査も増えない | 冪等でない（M3） |
| fmt 6 | `97` の文が変わらない：`au202509` × `aupay_family` が `× 列の条件に合わない。**列数が 6（この形式は 7〜7）**`、`enavi202509` × `rakuten_x11` が `explain 2` と同じ形 | `formatGap_` への置き換えで文が変わる |

### 10.2 診断

材料：カードフォルダに固定データの xlsx を置き、`webAppRunImport` で取り込んで `FORMAT_UNKNOWN` の要確認を立てる。参照ファイルが要るケースは、先に参照ファイル（`au202508` など）を同じフォルダで取り込んでおく（処理ログに形式 ID が入る）。

| # | 内容 | 落とす実装 |
|---|---|---|
| fmt 10 | `au202509`（`au202508` を取込済み）：`NEAR`・`nearest[0]` が `aupay_family`（`folderCount` ≥ 1）・`purposeGap.kind` が `PURPOSE_COLUMN_ABSENT`・`customerSide`・提案は日付 C／店名 D／金額 E（いずれも `REFERENCE`）・用途は対応なし | |
| fmt 11 | `enavi202509`（`enavi202508` を取込済み）：`nearest[0]` が `rakuten_x11`・`purposeGap` が `{kind: 'PURPOSE_HEADER_VALUE', column: 'K', headerText: 'ツール代'}` | |
| fmt 12 | `PAYPAY detail202502`（`detail202503` を取込済み）：`nearest[0]` が `paypay_family`・`customerSide` 偽・**金額 E（`REFERENCE`）**・**用途 L（`REFERENCE`。参照の M「使用用途」から）**・`amountCandidates` が E・G・H・I | 参照を列記号で引き継ぐ（M5） |
| fmt 13 | `PAYPAY detail202502`（参照なし）：`nearest[0]` が `paypay_family`・**金額の初期値が無い**（候補が 2 列以上） | `HEADER` で金額の初期値を置く（M6） |
| fmt 13b | `PAYPAY detail202502` を、処理ログで `rakuten_x11` の履歴を持つフォルダに置く：`nearest[0]` が `rakuten_x11` | 履歴を見ない（M4） |
| fmt 14 | `aplus_meisai_0000_202503`：`BLANK`・見出し行 1・データ開始行 2・日付 B・店名 C・金額の初期値なし（候補 D・H）・用途 J | 提案に `looksLikeDate_`／`parserCellMatchesType_` を使う |
| fmt 15 | `meisai202508`（取込時に `aeon_x9` を無効にして `FORMAT_UNKNOWN` を立て、その後有効に戻す）：`MATCHES_ACTIVE`・`aeon_x9` | |
| fmt 16 | 別の顧客のフォルダ・フォルダに無いファイル・`FORMAT_UNKNOWN` 要確認の無いファイル・`REVIEWER` だけの利用者：それぞれ `AuthorizationError` または `NOT_FORMAT_UNKNOWN` | |
| fmt 17 | 診断はマスター・要確認・処理ログ・恒久ファイルインデックスを変えず、一時変換ファイルを残さない | |

### 10.3 試し読み

| # | 内容 | 落とす実装 |
|---|---|---|
| fmt 20 | `PAYPAY detail202502`・金額 E・用途 L・`amountChoice: true`：`blocking` 空・24 件・合計が E 列の和・用途が全件空でない | |
| fmt 21 | 同じで金額 F（手数料）：`ZERO_AMOUNT_MAJORITY` | 過半数の検査を外す（M7） |
| fmt 22 | 金額候補が 2 列以上で `amountChoice` が偽：`ACK_AMOUNT_CHOICE_REQUIRED`。真なら出ない | |
| fmt 23 | `au202509`・用途 F（摘要）：`customerSide` の確認が無ければ `ACK_CUSTOMER_SIDE_REQUIRED`。あれば止まらず、警告 `PURPOSE_EMPTY_ROWS`・区分 1 | 確認を求めない（M8） |
| fmt 23b | `PAYPAY detail202502` の写しで L1（「使用用途」）を空にしたものを取り込んで形式不明にし、L を用途に選ぶ：`ACK_CUSTOMER_SIDE_REQUIRED` と `PURPOSE_HEADER_NOT_STANDARD` | 見出しを見ない |
| fmt 24 | 用途が「なし」：`PURPOSE_COLUMN_REQUIRED` | |
| fmt 24b | `enavi202509` の導出した判定キーワードが `['利用日', '利用店名・商品名', '利用者', '支払方法', '利用金額', '手数料/利息', '支払総額', '新規サイン', 'ツール代']`（この順・この 9 語）で、`'9月支払金額'`・`'10月繰越残高'` を含まない | 数字を含む見出しを外さない |
| fmt 25 | `meisai202508` の写し（取引行の金額 G を `'abc'` にして `aeon_x9` の型を落としたもの。**数字の文字列や日付の形の文字列では型が落ちない** ── `parserCellMatchesType_` は数字の文字列を数値、`2025-07-31` 形の文字列を日付と見なす）を取り込んで形式不明にし、9 列の変種を試し読み：`blocking` に `STATIC_COLLISION`（相手 `aeon_x9`）が**含まれる**（`NOT_MATCHING_TARGET` などが並んでもよい） | 静的な衝突を見ない（M9） |
| fmt 26 | 同じフォルダで `au202508` を取り込んだ後、その写し（利用日 C を `'abc'` にして `aupay_family` の型を落としたもの）を取り込んで形式不明にし、土台 `aupay_family`（参照ファイル＝元の `au202508`）で試し読み：`blocking` に `REFERENCE_COLLISION` が**含まれる**（`STATIC_COLLISION`・`NOT_MATCHING_TARGET` が並んでもよい） | 参照ファイルの衝突を見ない（M10） |
| fmt 27 | 試し読みはマスター・要確認・処理ログ・転記先を変えず、スプレッドシートを増やさない | |
| fmt 28 | `previewHash`：回答の 1 項目・確認の 1 つ・ファイルの中身のどれを変えても値が変わる。同じなら同じ | |
| fmt 29 | **試し読みと取込の突き合わせ**：`au202509` を用途 F で登録するとき、使用用途補完マスターに元ファイル名で当たる行を置いておく。試し読みの各行と、保存 → 取込待ちへ戻す → `webAppRunImport` の後の取引ログの各行が、`sourceRow` ごとに次で一致する：金額＝`originalAmount`、店名＝`originalMerchant`、用途＝`originalPurpose`（補完の後の値）、導出日（`yyyy-MM-dd`）＝`planned.b`（`planned.b` が空の行 ── 日付の要確認が立つ行、INV-33 ── は比べない。`au202509` は遡りの範囲内なので空にならない）。**用途は補完で埋まった値で一致すること** | 試し読みが `resolvePurposes` を飛ばす（M13） |

### 10.4 保存

| # | 内容 | 落とす実装 |
|---|---|---|
| fmt 30 | `PAYPAY detail202502` を保存：マスターに 1 行（A 形式 ID・C `active`・D TRUE・R `generic`・S 1・AD `NEW`・AB の `origin` が `WEBAPP`）、監査 `FORMAT_REGISTER` 1 行、`readback: 'OK'` | |
| fmt 31 | 試し読みの後に形式名を変えて保存：`PREVIEW_STALE`・何も書かない | `previewHash` を照らさない（M12） |
| fmt 32 | 取り消した形式と同じ ID で保存：`FORMAT_ID_TAKEN` | 無効の行を見ない |
| fmt 33 | 書く途中で値が変わる故障を注入：`installCardFormat` を、受け取った `spec` の判定キーワードから 1 語落としてから元の関数を呼ぶものに差し替える（**故障は `installCardFormat` の側にだけ入れる。`cardFormatRowValues_` に入れると試し読みも同じく変わり、差が出ない**）。結果：`readback: 'MISMATCH'`・その行が D＝FALSE・X＝`READBACK_MISMATCH`・監査は `FORMAT_REGISTER` と `FORMAT_DISABLE` の 2 行 | 読み戻しを省く・行の値を比べない（M11） |
| fmt 34 | **登録しても他の判定は変わらない**：`PAYPAY detail202502`（12 列）・`aplus_meisai_0000_202503`（白紙）・`au202509`（用途 F、確認つき）を順に保存し、そのつど `test/fixtures/samples/` の 33 件と `unknown-formats` の 14 件を判定する。変わってよいのは、保存したファイルと同じ様式のもの（`au202510`・`AU202511` が新しい au の形式に）だけ | |
| fmt 35 | `au202509` の保存の戻り値の `siblings` に `au202510`・`AU202511` が `MATCHES_NEW` で出る | |
| fmt 36 | 同じフォルダの形式不明が 7 件以上：`siblings` は 6 件、残りは `siblingsNotRead`。`webAppFormatNowMs_` を差し替えて時計を進め、締切ゲートを閉じると読まずに残す | |

### 10.5 取込待ちへ戻す・顧客に修正を依頼・取消し・一覧

| # | 内容 | 落とす実装 |
|---|---|---|
| fmt 40 | 新しい au の形式を保存した後で `au202510` を戻す：要確認が `RESOLVED`（`REGISTER_FORMAT`）・内部状態 `DISCOVERED`・提出時点の内容ハッシュが空・監査がこのファイルについて `REVIEW_RESOLVE` と `FORMAT_REQUEUE` の 2 行・次の `webAppRunImport` が新しい形式 ID で取り込む（処理ログ O 列） | |
| fmt 41 | まだどの形式にも一致しないファイルを戻す：`skipped`（`STILL_UNKNOWN`）・要確認は `OPEN` のまま | 判定し直さずに戻す（M14） |
| fmt 42 | 別の顧客・フォルダに無い・要確認が無いファイルを混ぜる：その分だけ `skipped`、他は戻る。7 件以上は 6 件だけ処理して `remaining` | |
| fmt 50 | `enavi202509` を要修正へ：ファイルの状態 `CUSTOMER_FIX_REQUIRED`・要確認が `RESOLVED`（`RETURN_TO_CUSTOMER`）・処理ログのエラーに `SOURCE_REQUIRES_CUSTOMER_FIX`・監査は `moveFile_` の `REVIEW_RESOLVE` 1 行だけ | |
| fmt 51 | メニューの選択肢が変わらない：`FORMAT_UNKNOWN` のファイル要確認に対する `resolveOptionsFor_` の結果（操作と順）が今と同じ | `MENU_RESOLVE_OPERATIONS_` に足す |
| fmt 52 | `RETURN_TO_CUSTOMER` を `FORMAT_UNKNOWN` 以外の種別に使う：`is not offered` で拒む | |
| fmt 55 | Web アプリで登録した形式を取り消す：D＝FALSE・X＝`WITHDRAWN_BY_OPERATOR`・監査。その後 `au202510` を取り込むと `FORMAT_UNKNOWN` | |
| fmt 56 | `aupay_family`（コードから入れた形式）の取消し：`NOT_WEBAPP_FORMAT`・何も書かない | `origin` を見ない（M16） |
| fmt 60 | `webAppListFolder`：形式不明のファイルに `formatReviewId`、他は `null`。`REVIEW_WAIT` の無いフォルダでは要確認を読まない（`openReviews` を例外を投げる関数に差し替えても一覧が返る） | 常に要確認を読む |

### 10.6 画面（クライアントの関数を取り出して呼ぶ。`test/phase8-webapp.test.js` の `clientEval` と同じ手）

| # | 内容 |
|---|---|
| fmt 70 | 保存ボタンの可否：`blocking` がある・試し読みが古い・必要な確認が無い、のどれかなら押せない |
| fmt 71 | 付録 B の対応：§6.1 の各コードに付録 B の文言が返る。知らないコードは汎用の文言 |
| fmt 72 | 入力欄を変えると `previewHash` が捨てられる |
| fmt 73 | 用途列の不備のとき、［顧客に修正を依頼する］が［別の形式として登録する…］より前にある |

### 10.7 1.1 で足すケース

| # | 内容 | 落とす実装 |
|---|---|---|
| fmt 10b | 対象ファイル自身の処理ログ O 列に古い形式 ID（`aupay_family`）が残り、開始日時が参照ファイルより新しい：診断の参照ファイルは `au202508` のまま（対象を参照にしない）、試し読みに `REFERENCE_COLLISION` が出ない | 履歴から対象を除かない（監査者の変異 A） |
| fmt 10c | 同じフォルダの別ファイルが未解決の `FORMAT_UNKNOWN` を持ち、処理ログ O 列に形式 ID が残っている：履歴の件数に数えない | 未解決の形式不明を除かない |
| fmt 14c | **本番の形式集合**（`smbc_family_x7`〜`x9` を含む）で `aplus_meisai_0000_202503` を診断：`verdict: 'BLANK'`、`nearest` が空 | 「2 語以上」を外す（監査者の変異 B） |
| fmt 14d | イオン型の見出し前置き（1 行目「ご利用カード」・5 行目「金融機関…」・8 行目が本物の見出し）で土台なしの提案：`headerRow` が 8 | 同数なら上を採る（監査者の変異 C） |
| fmt 14e | 参照ファイルが読めない（`readFile` が例外）：診断は `NEAR` のまま返り、`reference` が `null`、警告 `REFERENCE_UNREADABLE` | 例外を素通しする |
| fmt 30b | `PAYPAY detail202502` の導出した行（`cardFormatRowValues_` の戻り値）に `null`・`undefined` のセルが 1 つも無い。さらに、読み戻しの読取を実機と同じく `null` を `''` にして返すものに差し替えても `readback: 'OK'` | Y・Z に `null` を書く／比較で空を揃えない（1.1 の(1)） |
| fmt 35b | 別のフォルダのファイルに未解決の `FORMAT_UNKNOWN` がある：保存の `siblings` にも `siblingsNotRead` にも出ない | フォルダで絞らない（監査者の変異 S） |
| fmt 36b | `siblings` に `IN_PROGRESS` の要確認のファイルも入る | `OPEN` だけに絞る |
| fmt 42b | 取込待ちへ戻す：`webAppFormatNowMs_` を差し替えて 2 件目の前で締切ゲートを閉じる。1 件目だけ戻り、2 件目以降は `remaining` | 締切を見ない（監査者の変異 P） |
| fmt 55b | 既に無効の Web アプリ登録の形式を取り消す：`NOT_ACTIVE`・監査が増えない | 有効な行が無くても止める（監査者の変異 O） |
| fmt 32b | 形式名の先頭が `=`：`FORMAT_NAME_REQUIRED` | 先頭の文字を見ない |
| fmt 74 | 画面：保存が `{ok: false, code: 'NOT_FORMAT_UNKNOWN'}` を返したとき、成功扱いにしない（`state.formatSaved` が入らない）。`clientEval` で保存の結果を受ける関数を取り出して確かめる | U1 |
| fmt 75 | 画面：チェック欄を出すかの判定が、回答の `headerRow` の行の見出しを正規化して見る（見出し行を変えたら判定が変わる。全角の「使用用途」も「使用用途」と見る） | U2 |
| fmt 76 | 画面：送った回答と今の回答が違う試し読みの応答は採用しない | U3 |
| fmt 77 | 画面：`detail` の文（U7）── `COLUMN_ROLE_DUPLICATE` の `'date/amount'` が「利用日と金額」になる。`FORMAT_ID_TAKEN` に `detail` が無くても空欄にならない | U7 |
| fmt 78 | 画面：取込待ちへ戻す結果に `remaining` があれば、件数を言う文を返す | U5 |

### 10.8 1.2 で足すケース

| # | 内容 | 落とす実装 |
|---|---|---|
| fmt 79 | 画面：見出しの正規化関数が、`'使用 用途'`・`'使用　用途'`・`'使用\n用途'` を `normalizeMerchant` と同じ値にし、どれも「使用用途」と**等しくない**と判定する（サーバーと同じく確認を求める）。前後だけに空白がある `'　使用用途 '` は等しいと判定する（端を削るため） | 空白を消す（M26） |
| fmt 80 | 試し読みの `extraction.excluded` に `_rowRange` の行が無く、`excludedBeforeStart` が開始行 − 1。`EXCLUDED_ROWS` は開始行より後の除外だけを数える | `_rowRange` を返す |
| fmt 81 | 用途が「なし」の試し読み：`PURPOSE_COLUMN_REQUIRED` は出て、`PURPOSE_HEADER_NOT_STANDARD` と（用途見出しを理由とする）`ACK_CUSTOMER_SIDE_REQUIRED` は出ない | 用途なしでも見出しを見る |
| fmt 82 | 画面：入力の変更を受ける関数が、パネル全体の作り直し（`renderFormatPanel`）を呼ばない | 全体を作り直す（M27） |
| fmt 83 | 画面：取込待ちへ戻した結果を受ける関数が、`webAppExplainUnknownFile` を呼ばない（`gasCall` を記録する偽物で確かめる） | 診断を呼び直す（M28） |
| fmt 84 | 画面：除外の理由の文 ── `_dateAmountEmpty` が「利用日と金額が空」、`smbc_total` が「除外の規則「smbc_total」」 | 内部コードを出す |
| fmt 85 | 画面：`NOT_MATCHING_TARGET` の文が、`typeFailures` を「1列目が日付でない行 2/4」の形で含み、`**` を含まない | 詳しさが足りない |

### 10.9 1.3 で足すケース（画面は偽の DOM の上で振る舞いを確かめる。§9）

| # | 内容 | 落とす実装 |
|---|---|---|
| fmt 94 | 偽の DOM で診断の結果（`PAYPAY detail202502` の形）を描き、試し読みを済ませた状態から**列の選択の `change` を発火**：例外が出ない・`state.formatPreview` と `state.formatHash` が `null`・保存ボタンが `disabled`・その列の出どころが「手で選択」 | `formatManualColumns` を初期化しない（M29） |
| fmt 95 | 同じく**金額のラジオを変える**：例外が出ない・試し読みが古くなる。`REFERENCE` の列は、別の候補に切り替えた後の再描画でも一覧に残る | U25（M30） |
| fmt 96 | 入力欄にフォーカスがある状態で最終確認の読込を終える：パネルの入力欄の要素が作り直されない（同じ要素のまま） | U26 |
| fmt 97 | 保存の呼出しを例外にする：「保存できたか確かめられません」が**パネルの中**に出て、`webAppExplainUnknownFile` が呼び直される | U30（画面） |
| fmt 98 | 保存で、兄弟ファイルの 1 件の `readFile` が例外：保存は `saved: true`・`readback: 'OK'` で返り、そのファイルは `siblingsNotRead` | U30（サーバー。M31） |
| fmt 99 | 保存の結果がある状態でフォルダを切り替える：確認が出て、「いいえ」なら保存の結果が残る | U29 |
| fmt 100 | 取込待ちへ戻した結果に `remaining` があるとき、戻し終えた対象ファイルの行が描かれない | U28 |
| fmt 101 | 日付の問題だけで区分 3 になる試し読み（年の補完の要確認が立つ形を作る）：`REVIEW_ROWS` の件数が 0 でない | `issues` だけを数える（M32） |
| fmt 102 | 既存の画面テストのうち、ソース文字列を見ていたもの（`String(fn).includes`）を振る舞いの確かめ方に置き換えたこと ── **新しいテストファイルに `String(` で関数のソースを調べる箇所が 1 つも無い** | 文字列で確かめる |

### 10.10 1.4 で足すケース

**偽の `google.script.run` に「応答を保留し、テストが後で返す」形を足すこと**（いまは同期で即答するので、処理中の状態や遅れた応答を作れない）。偽の DOM に**フォーカス（`document.activeElement`・`focus()`・`blur()`、フォーカスが外れたら `change` を起こす）**を足すこと。

| # | 内容 | 落とす実装 |
|---|---|---|
| fmt 106 | 取込の応答を保留した状態で、パネルの形式 ID の欄が `disabled`。応答を返した後は有効に戻り、欄の値と `state.formatAnswers.formatId` が等しい | U36（M33） |
| fmt 107 | 保存の呼出しを例外にし、診断し直しの応答を `MATCHES_ACTIVE`（保存しようとした形式 ID）にする：［この登録を取り消す］が描かれ、押すと `webAppWithdrawFormat` がその形式 ID で呼ばれる | U37（M34） |
| fmt 108 | 形式 ID の欄にフォーカスを置いて文字を打ち、確認のチェックへフォーカスを移す（`blur` → `change` が起きる）：押そうとしたチェックの要素が作り直されない（同じ要素のまま）。そのチェックを押すと `acknowledgements` に反映される | U38（M35） |
| fmt 109 | 用途列の不備のファイルで保存した後：［顧客に修正を依頼する］が描かれない（または `disabled`）。`returnFormatToCustomer` を直接呼んでも `webAppReturnFileToCustomer` が呼ばれない | U39（M36） |
| fmt 110 | サーバー：`webAppRequeueFormatFiles` に 3 件渡し、2 件目の `resolveFileReview` を例外にする：1・3 件目は戻り、2 件目は `skipped`（`REQUEUE_FAILED`）。呼出しは例外にならない | U40（M37） |
| fmt 111 | 画面：取込待ちへ戻す呼出しを例外にする：文がパネルの中に出て、`webAppListFolder` と `webAppListReviews` が呼ばれる | U40（画面） |
| fmt 112 | 画面：`saveFormat`・`previewFormat`・`returnFormatToCustomer` を、応答 `{ok: false, code: 'NOT_FORMAT_UNKNOWN'}` で偽の DOM の上に通す：例外が出ず、ファイル一覧の［記帳を実行］が処理中の無効から戻る（固まらない） | U1 の退行を DOM の上で捕まえる |

### 10.11 1.5 で直すケース

| # | 内容 | 落とす実装 |
|---|---|---|
| fmt 113 | 登録の監査（`FORMAT_REGISTER`）で例外を起こす：`readback: 'UNCERTAIN'`・`disabled: true`・その形式の行が D＝FALSE・X＝`READBACK_UNCERTAIN`。**既存のケース（1.4 で足された、`UNCERTAIN` の後も `enabled === true` を確かめているもの）は、この期待に書き換える** | 確認前の例外で有効のまま残す（M38） |
| fmt 114 | 読み戻しの読取（`readRowByNumber_`）で例外を起こす：同じく `UNCERTAIN`・`disabled: true` | 同上 |
| fmt 115 | 確認がすべて一致した後、兄弟ファイルの列挙（`openReviews`）で例外を起こす：`readback: 'OK'`・形式は有効・`siblings` が空・`siblingsError: true` | 確認後の例外で無効にする（M39） |
| fmt 116 | 画面：`UNCERTAIN`＋`disabled: true` の応答で取消しのボタンが描かれず、`disabled: false` なら描かれる | U41 |

---

## 11. 変異（実装者が入れて、赤になることを確かめる）

| 番号 | 変異 | 赤になるはずのテスト |
|---|---|---|
| M1 | `detectorProfileSamples_` でセクション見出しの手前で止めない | fmt 1 |
| M2 | `97` の `explainColumnGap_` が自前の見本の拾い方に戻る | fmt 4 |
| M3 | `disableCardFormat_` が有効な行の無いときも書く | fmt 5 |
| M4 | 近い形式の順位でフォルダの履歴を見ない | fmt 13b |
| M5 | 参照ファイルの対応を見出しでなく列記号で取る | fmt 12 |
| M6 | 金額候補が 2 列以上でも `HEADER` で初期値を置く | fmt 13 |
| M7 | `ZERO_AMOUNT_MAJORITY` を外す | fmt 21 |
| M8 | `ACK_CUSTOMER_SIDE_REQUIRED` を外す | fmt 23 |
| M9 | `STATIC_COLLISION` を外す | fmt 25 |
| M10 | `REFERENCE_COLLISION` を外す | fmt 26 |
| M11 | 保存の読み戻しを省く | fmt 33 |
| M12 | 保存で `previewHash` を照らさない | fmt 31 |
| M13 | 試し読みが `resolvePurposes` を飛ばす | fmt 29 |
| M14 | 取込待ちへ戻す前に判定し直さない | fmt 41 |
| M15 | 判定キーワードに数字を含む見出しを入れる | fmt 24b |
| M16 | 取消しで `origin` を見ない | fmt 56 |
| M17 | 履歴から対象ファイルを除かない | fmt 10b |
| M18 | 近い形式の候補で「2 語以上」を外す | fmt 14c |
| M19 | 白紙の見出し行で同数なら上を採る | fmt 14d |
| M20 | Y・Z に `null` をそのまま書く（`lookbackMonths: base.lookbackMonths`） | fmt 30b |
| M21 | 読み戻しの比較で空（`null`・`''`）を揃えない | fmt 30b |
| M22 | `siblings` をフォルダで絞らない | fmt 35b |
| M23 | 取込待ちへ戻すで締切ゲートを見ない | fmt 42b |
| M24 | 画面：保存の `ok: false` を成功扱いにする | fmt 74 |
| M25 | 画面：チェック欄の判定を `proposal.headers` の生の文字で行う | fmt 75 |
| M26 | 画面：見出しの正規化で空白を消す | fmt 79 |
| M27 | 画面：入力の変更でパネル全体を作り直す | fmt 82 |
| M28 | 画面：取込待ちへ戻した後に診断を呼び直す | fmt 83 |
| M29 | 画面：`state` の初期値から `formatManualColumns` を外す | fmt 94 |
| M30 | 画面：一覧に足す金額列をいま選んでいる列で決める | fmt 95 |
| M31 | サーバー：兄弟ファイルの読取を例外から守らない | fmt 98 |
| M32 | サーバー：`REVIEW_ROWS` を `transactionValidation.issues` だけで数える | fmt 101 |
| M33 | 画面：`startImport` が形式パネルを描き直さない | fmt 106 |
| M34 | 画面：不確かな保存の後の `MATCHES_ACTIVE` で取消しを出さない | fmt 107 |
| M35 | 画面：確認のチェック欄を入力のたびに作り直す | fmt 108 |
| M36 | 画面：保存後も［顧客に修正を依頼する］を出す | fmt 109 |
| M37 | サーバー：取込待ちへ戻すの繰り返しを 1 件ずつ守らない | fmt 110 |
| M38 | サーバー：確認前の例外で形式を無効にしない | fmt 113・fmt 114 |
| M39 | サーバー：確認後の例外（兄弟ファイル）でも無効にする | fmt 115 |


---

## 12. 受入（実機）

**出す順序**：実装 → 監査（変異）→ コミット → push（人が行うか、明示の指示で）→ **F5** → **`opsDisableAeonX8`** → 画面での作業。

| # | 内容 |
|---|---|
| 1 | push の前後に `clasp pull` で実機と git の一致を確かめる（`gas-environment` の手順） |
| 2 | `opsDisableAeonX8` の後、カード形式マスターの `aeon_x8` 行が D＝FALSE・X＝`PURPOSE_READ_FROM_ISSUER_COLUMN` |
| 3 | イオンゴールド `meisai202508`：画面で `MATCHES_ACTIVE` → 再検査 → 記帳 → `aeon_x9` で取り込まれる |
| 4 | `PAYPAY detail202502`：診断 → 金額 E を確認して選ぶ → 試し読み 24 件 → 保存 → 読み戻し一致 → 取込待ち → 記帳 → 取引ログの件数・合計が試し読みと一致 |
| 5 | `enavi202509`：要修正へ → Drive のファイル名が【要修正】で始まる |
| 6 | 診断・試し読み・保存・取込待ちへ戻す（1 件）の所要時間を測る。`WEBAPP_FORMAT_FILE_WORST_MS_` の前提（読取 3 秒・戻し 35 往復）と比べる。保存の読み戻しが実機で `OK` になる |
| 7 | au 3 件：経理が判断する（要修正か、登録か） |
| 8 | アプラス：白紙から登録 → 試し読み → 保存 → 取込 |

---

## 13. 実装者への注意（過去に壊れた形）

- **列記号で引き継いではならない**（F1）。
- **提案に `looksLikeDate_`（15）や `parserCellMatchesType_`（24）を使ってはならない**（F4）。
- **`19_FormatRegistration.gs` から `authorize` を呼んではならない**（`auth F-35`）。
- **判定の結果を `formatGap_` が自分で決めてはならない**（P1）。
- **新しいエラーコードを `ERROR_CATALOG` に足してはならない**（`phase0` が集合を固定している）。
- **`96_Menu.gs` に `RETURN_TO_CUSTOMER` の定義を足してはならない**（メニューの番号が変わる）。
- **保存を取込へつなげてはならない**（P6）。
- **既存の形式の行を書き換えてはならない**（P2）。触ってよいのは `disableCardFormat_` による D・W・X・AH の 4 列だけ。
- 例外にするのは認可の失敗と想定外の事象だけ。画面が場合分けする事象（`NOT_FORMAT_UNKNOWN`・`PREVIEW_STALE`・`blocking`・`skipped`）は戻り値で返す（`google.script.run` は例外のカスタムプロパティを運ばない ── `spec_webapp.md` §6.1）。

---

## 14. 課題

| 番号 | 内容 | 対処 |
|---|---|---|
| K-F1 | **カード会社の列に用途を読む既存形式が他にもある。**`amex_6_alt` は海外通貨の列 E を用途として読む。海外利用があると、カード会社が書いた値が用途として転記され得る（F2 と同じ形） | 別に調べる。`aeon_x8` と同じく止めるかは ko-ch さんの判断 |
| K-F2 | **Web アプリで登録した形式は AC 列（ゲート結果）が空である。**既存の 15 形式と同じ。4.12 の本格経路を作るとき、AB 列の記録（`sourceFileId` など）からサンプルを起こす | 4.12 を作るとき |
| K-F3 | **静的な衝突の検査は、他のカードのファイルを読まない。**`STATIC_COLLISION` は「既存の形式が対象に見出しで当たる」向きしか見ず、「新しい形式が他のカードのファイルに当たる」向きは参照ファイル（同じフォルダ）でしか見ない。判定キーワードに見出し行の全セルを入れる（§5.5）ので当たりにくいが、保証ではない | 4.12.3 のコーパス回帰が要る |
| K-F4 | **形式は全顧客共通なのに、認可は顧客単位である。**第 1 段は `access: MYSELF` でオーナーだけが使うので問題にならない | 利用者を増やすとき（`spec_webapp.md` K-W1） |
| K-F5 | **要修正へ回したファイルの理由が顧客に届く経路は既存のまま**（ファイル名の【要修正】と通知の件数）。理由の文は処理ログのエラーにしか残らない | 顧客への通知を作るとき |
| K-F6 | **1.4 の監査で出た画面の低 10 件を後回しにした**（どれも帳簿を壊さない）：(1) パネル内の文が最上部に出て、最下部のボタンから遠い。(2) `renderSelection` の中の描画が例外から守られていない（予防）。(3) 不確かな保存の後の診断し直しで、人の入力が黙って提案の値に戻る。(4) `ok: false` の後も入力欄と［試し読み］が有効のまま。(5) 金額の候補の見出しが全体の描き直しで提案時の行に戻る。(6) 残りの表示が「いま選んでいるもの」で絞られ、外した兄弟ファイルを選び直せない。(7) `formatUpdateAnswer` が値を入れてから試し読みを古くしている（順が逆）。(8) サーバーが兄弟ファイルごとに `formatActiveDefinitions_()` を 2 回呼ぶ（読取の無駄。1 回の保存で最大 12 回）。(9) `.format-message.success` の色が無い。(10) 読み戻し不一致で取り消すものが無いときも閉じる確認が出る | 実機で使ってみて気になるものから直す |

---

## 付録 B. 文言

### 診断

| 場面 | 文言 |
|---|---|
| `MATCHES_ACTIVE` | このファイルは、登録済みの形式「{形式名}」で読めます（止まった後に形式が足されたか、判定が直りました）。 |
| `AMBIGUOUS` | このファイルは 2 つ以上の形式に当たります。スプレッドシートのメニューから扱ってください。 |
| `NEAR` | いちばん近い形式は「{形式名}」です。違い：{gapText} |
| `BLANK` | 近い形式がありません。列を指定して、新しい形式として登録します。 |
| 用途列の不備・列が無い | 違いは「使用用途」の列だけです。カード会社の出力は「{形式名}」と同じで、顧客が「使用用途」の列を足していません。 |
| 用途列の不備・見出しに値 | 違いは「使用用途」の列だけです。{列}列の見出しが「{見出し}」になっています。顧客が見出しのセルに用途を書いた可能性があります。 |
| 登録の警告（用途列の不備） | この形のファイルを形式として登録すると、顧客の入力ミスが正常な様式として定着します。通常は顧客に修正を依頼してください。 |
| 登録の警告（見出しが「使用用途」でない列を用途にする） | {列}列（見出し「{見出し}」）を使用用途として読みます。この列にカード会社が書いた文言も、使用用途として転記されます。 |
| 確認のチェック | 入力ミスを様式として登録することを理解した |
| 金額のチェック | 金額の列を確認した |

### 止める理由（§6.1）

| コード | 文言 |
|---|---|
| `DEFINITION_INVALID` | 形式の定義として不正です：{詳細} |
| `FORMAT_ID_INVALID` | 形式 ID は英小文字・数字・下線で 32 文字までにしてください。 |
| `FORMAT_ID_TAKEN` | 形式 ID「{ID}」は既に使われています（取り消した形式を含む）。 |
| `FORMAT_NAME_REQUIRED` | 形式名を 60 文字までで入れてください（先頭に = + - @ は使えません）。 |
| `HEADER_ROW_INVALID` | 見出し行がシートの範囲にありません。 |
| `DATA_START_INVALID` | 明細の開始行は、見出し行より後にしてください。 |
| `COLUMN_OUT_OF_RANGE` | {役割}の列がこの表の範囲にありません。 |
| `COLUMN_ROLE_DUPLICATE` | {役割}と{役割}に同じ列が選ばれています。 |
| `PURPOSE_COLUMN_REQUIRED` | 使用用途の列が無い形式は登録できません（取り込むと必ず【要修正】になります）。顧客に修正を依頼してください。 |
| `TOO_FEW_KEYWORDS` | 見出しの語が少なすぎて、この形式を見分けられません。 |
| `NOT_MATCHING_TARGET` | この定義では、このファイル自体が読めません：{差} |
| `TARGET_AMBIGUOUS` | 登録すると、このファイルが「{形式名}」にも当たり、止まります。 |
| `STATIC_COLLISION` | 登録済みの形式「{形式名}」が見出しでも列数でもこのファイルに当たっています。型の違いだけで外れているので、判定の不具合の疑いがあります。登録せずに管理者へ連絡してください。 |
| `REFERENCE_COLLISION` | この定義は、同じフォルダの「{ファイル名}」（{形式名}で読めていたファイル）にも当たります。登録すると、その様式のファイルが止まります。 |
| `NO_TRANSACTIONS` | 明細が 1 件も読めません。見出し行・開始行・列を確かめてください。 |
| `ZERO_AMOUNT_MAJORITY` | 金額が 0 円か空の行が半分を超えています。金額の列が違う可能性があります。 |
| `ACK_CUSTOMER_SIDE_REQUIRED` | 登録するには「入力ミスを様式として登録することを理解した」にチェックしてください。 |
| `ACK_AMOUNT_CHOICE_REQUIRED` | 金額らしい列が複数あります。どれを金額にするか確かめて「金額の列を確認した」にチェックしてください。 |
| `PREVIEW_STALE` | 試し読みの後に入力かファイルが変わりました。もう一度［試し読み］を押してください。 |
| 知らないコード | 登録できない理由があります：{コード} |

### 確認ダイアログ

| 場面 | 文言 |
|---|---|
| 保存 | カード形式マスターに「{形式名}」（{形式 ID}）を追加し、有効にします。形式は全顧客に共通です。次の取込から、この形に合うファイルはすべてこの形式で読まれます。 |
| 取消し | 「{形式名}」を無効にします。取り込み済みの取引は変わりません。次の取込から、この形式で読めていたファイルは形式不明で止まります。 |
| 要修正へ | 「{ファイル名}」を【要修正】にします。顧客が直したファイルを置き直すまで取り込みません。 |
| 取込待ちへ | 選んだ {n} 件を取込待ちに戻します。［記帳を実行］で取り込みます。 |

### `detail` の読み方（U7）

| コード | `detail` | 文での出し方 |
|---|---|---|
| `FORMAT_ID_TAKEN` | 形式 ID（試し読みでも付ける） | 無ければ回答の形式 ID |
| `COLUMN_OUT_OF_RANGE` | 役割のキー | 役割名：`date`→利用日・`merchant`→店名・`amount`→金額・`purpose`→使用用途 |
| `COLUMN_ROLE_DUPLICATE` | `'date/amount'` の形 | `/` で分けて役割名にし「と」でつなぐ |
| `NOT_MATCHING_TARGET` | `formatGap_` の戻り値（または `null`） | `stage` と不足語・列数を文にする（`explainFormatVerdict_` と同じ言い方）。`null` なら「定義が不正です」 |
| `TARGET_AMBIGUOUS`・`STATIC_COLLISION` | 形式 ID（の配列） | `diagnosis.nearest` や有効な形式から形式名を引く。無ければ ID |
| `REFERENCE_COLLISION` | 参照ファイル名 | 付録 B の文に、参照の土台の形式名も入れる |
| `DEFINITION_INVALID` | 問題の配列または文 | 箇条で出す |

### 警告（§6.2 の「画面が言うこと」を文にしたもの）

| コード | 文言 |
|---|---|
| `PURPOSE_EMPTY_ROWS` | 使用用途が空の行が {n} 行あります。このまま取り込むと【要修正】になります。 |
| `CATEGORY_2` | このまま取り込むと「{理由}」で止まる見込みです。 |
| `REVIEW_ROWS` | 取り込んだ後に要確認になる行が {n} 行ある見込みです。 |
| `BILLING_MONTH_UNRESOLVED` | 請求年月が読めません。年の補完が効きません。 |
| `EXCLUDED_ROWS` | 取引ではないとして除いた行が {n} 行あります。下の表で確かめてください。 |
| `RULES_NOT_INHERITED` | 土台の形式の規則のうち、列の位置に依るもの（{規則}）は引き継ぎませんでした。 |
| `FOREIGN_NOT_INHERITED` | この形式では外貨の補足（通貨・現地額・レート）を取りません。 |
| `PURPOSE_HEADER_NOT_STANDARD` | 使用用途として読む列の見出しが「{見出し}」です。 |
| `REFERENCE_UNREADABLE` | 参照ファイル「{ファイル名}」が読めなかったので、列の対応は見出しから推しました。 |

### 兄弟ファイルの判定

| `verdict` | 文言 |
|---|---|
| `MATCHES_NEW` | この形式で読めます |
| `MATCHES_OTHER` | 別の登録済みの形式で読めます |
| `NO_MATCH` | まだどの形式にも当たりません |
| `AMBIGUOUS` | 2 つ以上の形式に当たります |

### 取消しの失敗

| コード | 文言 |
|---|---|
| `NOT_WEBAPP_FORMAT` | この形式は画面から登録したものではないので、ここでは取り消せません。 |
| `NOT_ACTIVE` | この形式は既に無効です。 |

### 取込待ちへ戻せなかった理由

| コード | 文言 |
|---|---|
| `STILL_UNKNOWN` | まだどの形式にも当たりません。 |
| `AMBIGUOUS` | 2 つ以上の形式に当たります。 |
| `NOT_FORMAT_UNKNOWN` | 形式不明の要確認がありません（既に扱われた可能性があります）。 |
| `REQUEUE_FAILED` | 読み直しの途中でエラーになりました。もう一度お試しください。 |

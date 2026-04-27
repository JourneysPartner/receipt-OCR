# レシート OCR・AI 仕訳システム

「現金自動記帳マスター」スプレッドシートを起点に、複数顧客のレシートを一括処理する Cloud Run Job。

## アーキテクチャ

```
現金自動記帳マスター (Google Sheets)
    │  各行 = 1顧客
    │  D列 = レシートフォルダURL
    │  G列 = 出納帳URL（空なら自動作成）
    │  H列 = 種別（個人/法人）
    │
    ▼
Cloud Run Job (Python 3.11)
    ├── マスター読み込み → 対象顧客抽出（記帳区分=当方記帳）
    │
    │  ── 顧客ごと ──
    │  ├── G列空 → テンプレートコピーで出納帳自動作成
    │  ├── Drive API でレシート取得
    │  ├── Cloud Vision OCR → Gemini AI → 業務ルール補正
    │  ├── 出納帳へ書き込み（reservation_id / written 状態管理）
    │  └── マスター F列/I列 更新
    │
    └── Google Sheets (顧客ごとの出納帳)
          ├── 現金出納帳（テンプレートから作成）
          ├── 処理管理（自動作成）
          └── AI詳細ログ（自動作成）
```

## マスターシートの列仕様

| 列 | index | フィールド | 説明 |
|----|-------|-----------|------|
| A  | 0     | 顧客名 | |
| B  | 1     | 担当者 | |
| C  | 2     | 記帳区分 | 「当方記帳」のみ処理対象 |
| D  | 3     | フォルダURL | **必須**: レシート保存先 Drive フォルダ |
| F  | 5     | 状態 | 処理結果（自動更新、下記参照） |
| G  | 6     | シートリンク | **必須**: 既存の現金出納帳URL（空ならスキップ） |
| H  | 7     | 種別 | 個人/法人（参考情報。処理には使わない） |
| I  | 8     | 最終処理日時 | ISO 8601（自動更新） |

> **重要**: 現金出納帳は**事前に手動で作成**してください。
> Cloud Run Job は既存の出納帳への記帳のみを担当し、新規作成は行いません。
> G列が空の顧客は `スキップ / シートURL未設定` として処理されます。

## 処理フロー

1. マスターシートを読み込み
2. 記帳区分=「当方記帳」の行だけ処理
3. G列（シートURL）が未設定なら「スキップ / シートURL未設定」として F列/I列 を更新しスキップ
4. D列のフォルダURLから**配下のレシートファイルを再帰的に取得**（月別/用途別サブフォルダも対象）
5. 各レシートを OCR → AI → 補正 → 出納帳書き込み
6. 顧客ごとの処理結果を集計し、マスター F列/I列 を更新

### マスター F列の状態表示ルール

顧客ごとに成功/低信頼/手入力/エラーを集計し、状態文字列を生成。

| 結果 | F列の値 |
|------|--------|
| 成功のみ | `完了 / 成功3` |
| 成功＋手入力あり | `要確認 / 成功2 / 手入力1` |
| 成功＋低信頼あり | `要確認 / 成功1 / 低信頼2` |
| 全件スキップ / ファイルなし | `完了（対象なし）` |
| 全件エラー | `エラー / 詳細はログ参照` |
| 成功＋エラー混在 | `要確認 / 成功1 / エラー2` |
| G列未設定 | `スキップ / シートURL未設定` |
| D列未設定 | `スキップ / フォルダURL未設定` |
| 例外発生 | `エラー: メッセージ` |

## 現金出納帳の事前作成（手動運用）

Cloud Run Job は新規の出納帳を作成しません。
新規顧客については、以下の手順で**事前に手動で**出納帳を用意してください。

1. テンプレートの現金出納帳スプレッドシートを手動でコピー
2. ファイル名を `【顧客名】現金出納帳` にする（命名は自由だが推奨）
3. **記帳対象タブ（既定: `入力用`）の存在を確認**。rename は不要
4. スプレッドシートをサービスアカウントに「編集者」として共有
5. URL をマスターシートの G列に記入

## 記帳対象タブ名

**記帳対象タブ名は `入力用` で固定**です。ファイル名とは別の概念です。

| 概念 | 例 |
|------|----|
| スプレッドシートのファイル名 | `【テスト】現金出納帳` |
| **記帳対象タブ（シート）名** | **`入力用`**（固定） |
| その他のタブ | `取込用`, `処理管理`, `AI詳細ログ` など |

- 参照するタブ名は `CASHBOOK_SHEET_NAME` 環境変数で変更可能（既定: `入力用`）
- タブの自動 rename や名前解決のフォールバックは行わない
- タブが存在しない場合はエラーになるので、テンプレート側で `入力用` タブを用意しておくこと

## 現金出納帳の列マッピング

| 列 | フィールド | 備考 |
|----|-----------|------|
| A  | ファイルリンク | |
| B  | 日付 | |
| C  | 勘定科目コード | `CASHBOOK_ACCOUNT_CODE_MAP` にコードがあれば書き込み、なければ触らない |
| **D** | **保護+数式コピー** | **既存関数列（例: コードから科目名を引く VLOOKUP）** |
| F  | 取引先 | |
| G  | 税区分 | |
| K  | 摘要 | 通常は AI 抽出結果。失敗時は `※要手入力`（短文固定） |
| M  | 支出金額 | `支払い` 欄。is_expense=False の場合は書かない |
| **N** | **保護+数式コピー** | **既存関数列** |
| O  | エラー詳細 | **要手入力行の場合のみ**、失敗理由の詳細を書き込む |

> **注意**: 上記は実運用シートに合わせた既定値です。`CASHBOOK_COLUMN_MAP` で全面的に変更可能。

### 要手入力行の書き込み先

要手入力行（manual_entry）でも、AI が候補を出している項目は**必ず書き込みます**。
金額（M列）だけは信用できないため書き込まれません。

| 列 | 内容 | 例 |
|----|------|----|
| A | ファイルリンク | `https://drive.google.com/…` |
| B | 日付候補 | `2026-04-23` |
| C | 勘定科目コード（Q:R 解決可能なら） | `524` |
| F | 取引先候補 | `ABC商店` |
| G | 税区分候補 | `課税仕入10%` |
| K | **要確認ラベル + 摘要候補** | `※金額要確認 / 文具購入` |
| M | （金額が信用できないので書かない） | — |
| O | **エラー詳細** | `金額検証NG (digit_inflation): ...` |

### 要確認ラベルの種類

K列冒頭に付くラベルは検証結果に応じて変わります（[`build_review_label`](src/rules/amount_validation.py)）:

| 状況 | ラベル |
|------|------|
| amount_validation = `digit_inflation` / `missing_in_ocr` | `※金額要確認` |
| 低信頼（confidence < 閾値）のみ | `※内容要確認` |
| 金額NG + 追加要素（例: 勘定科目疑い） | `※金額・勘定科目要確認` |
| OCR失敗 / AI抽出失敗等 | `※要手入力` |

`CASHBOOK_ERROR_DETAIL_COLUMN` で O列を変更可能（既定: 14 = O列）。
通常の正常記帳行では O列は触りません。
C列（勘定科目コード）も変換表にエントリが無ければ触らないので、既存数式/値は保護されます。

### レシート取得（再帰探索）

D列に指定されたフォルダ配下のレシートは **再帰的に** 取得します。

- 月別フォルダ / 現金使用分フォルダなどサブフォルダ内のレシートも対象
- 画像（JPG/JPEG/PNG）と PDF のみ取得
- ショートカット（`application/vnd.google-apps.shortcut`）は辿らない
- 同一ファイル ID は重複排除（複数の親に配置されているファイルでも1度だけ処理）
- 循環参照は訪問済みフォルダの記録で検出
- 探索フォルダ数の上限は 100（暴発防止）

### 処理対象外ファイル

ファイル名が `[済]` または `【済】` で始まるファイルは **どのサブフォルダにあっても** 処理対象から除外されます。
除外プレフィックスは `EXCLUDED_FILE_NAME_PREFIXES` 環境変数で変更可能。

### 成功後の自動リネーム（【済】付与）

正常記帳が完了したファイルは、Cloud Run Job が Drive 上で **ファイル名先頭に `【済】` を自動付与** します。

付与条件:
- そのファイルから作った全明細が **success または low_confidence** で記帳完了
- manual_entry / error が1件も発生していない
- dry_run ではない
- 既に `[済]` / `【済】` で始まる場合は二重付与しない

このため、**次回実行時は自動的に処理対象から外れ**、多重記帳を防ぎます。

> リネームには Drive API の `files.update` が必要なため、DriveClient は `https://www.googleapis.com/auth/drive` スコープを使用します（読み書き両方）。サービスアカウントは Drive フォルダとファイルに対し「編集者」で共有されている必要があります。

### 業務ルール補正（勘定科目の自動補正）

`src/rules/corrections.py` に定義されたキーワードルールで、AI が返した勘定科目を上書き補正します。判定対象は `description` と `vendor` を結合したテキスト。

主なルール（一部）:

| キーワード | 勘定科目 |
|-----------|---------|
| ガソリン / 給油 / ENEOS / 出光 など | 車両費 |
| 駐車場 / パーキング / タイムズ | 旅費交通費 |
| 高速 / ETC / NEXCO | 旅費交通費 |
| タクシー / JR / Suica | 旅費交通費 |
| 郵便 / レターパック / 切手 | 通信費 |
| 収入印紙 | 租税公課（税区分=対象外） |
| コピー / 印刷 | 雑費 |
| 文具 / ボールペン / ノート | 消耗品費 |
| 弁当 / お弁当 / 弁当代 / お弁当代 | 会議費 |
| **重量税 / 自賠責 / 車検 / 運輸支局 / 陸運局 / 検査登録 / 継続検査 / 自動車** | **車両費** |

**車関連の印紙代の扱い**: 「車検」「運輸支局」など車関連文脈を含む印紙代は、収入印紙→租税公課ルールの後に車両費へ上書きされます。一般的な印紙（コンビニ・郵便局など車関連文脈なし）は租税公課のままです。

> **補正の優先順位**: `CORRECTION_RULES` のリスト順に適用され、**後のルールが前のルールの結果を上書き**します。たとえば AI が「消耗品費」と判定したレシートでも、摘要に「弁当」が含まれていれば最終的に「会議費」に補正されます（弁当ルールはリスト末尾に配置）。

### OCR フォールバック

primary OCR の結果が弱い場合、自動的に第2 OCR を試して良い方を採用できます。

| 環境変数 | 既定 | 用途 |
|---------|------|------|
| `OCR_ENGINE` | `vision` | 主 OCR エンジン |
| `OCR_FALLBACK_ENGINE` | （無し） | フォールバック先（例: `vision_document`） |
| `OCR_FALLBACK_CONFIDENCE_THRESHOLD` | `0.6` | primary がこの値未満なら fallback を試す |

**現在用意されているエンジン**:
- `vision` — 通常の `text_detection`（速い・コスパ良い）
- `vision_document` — `document_text_detection`（手書き文字にやや強い、PDF と同じ精緻モード）

**判定ロジック**: primary がエラー / 空テキスト / `confidence < threshold` のいずれかなら fallback を実行し、より高 confidence の結果を採用。fallback が逆に劣化していれば primary を維持。

**注意**: amount_validation NG（金額誤読疑い）時の追加再 OCR は将来拡張点として残しています。現状は OCR confidence ベースの自動 fallback のみ。

### 金額バリデーション

AI が返した amount は **OCR 生テキストの金額候補と突合**され、不整合なら confidence が高くても manual_entry に回されます。

検出ロジック:
- OCR テキストから `¥1,600` / `1,600円` / `1600` / `1,234` 等の数値を抽出
- AI amount と一致すれば `status=ok`
- `str(ai_amount)[1:]` が候補にあれば `status=digit_inflation`（先頭1桁誤読疑い、例: OCR`¥` を `4` と誤読）
- そもそも候補に無ければ `status=missing_in_ocr`
- `digit_inflation` / `missing_in_ocr` は自動的に **manual_entry 行**（K列=`※要手入力`、O列=詳細）として書かれ、`【済】` 付与もスキップ

この防御により、例えば実際 1,600 円の手書き領収証が OCR で 41,600 と読まれても、AI の confidence が高くても記帳前に止まります。

### 勘定科目コード変換（シート内 Q:R 参照）

C列の勘定科目コードは、**記帳対象タブ内の Q:R 対応表**から引きます。

| 列 | 役割 |
|----|------|
| Q  | 勘定科目コード |
| R  | 勘定科目名 |

- AI が抽出した勘定科目名を R列の値と照合
- 照合の**前に** `account_alias_map` で表記揺れを正規化（後述）
- 一致した行の Q列コードを C列へ書き込む
- **一致しなければ C列は触らない**（既存値/数式を保護）
- 列位置は `CASHBOOK_ACCOUNT_CODE_COLUMN` / `CASHBOOK_ACCOUNT_NAME_COLUMN`、開始行は `CASHBOOK_ACCOUNT_TABLE_START_ROW` で変更可能

顧客の出納帳スプレッドシート側で Q:R に勘定科目マスタを置いておいてください。

### 勘定科目の別名辞書（表記揺れ吸収）

AI が返す勘定科目名と R列の正規名で表記が違うことがあります。
Q:R を参照する前に `account_alias_map` で正規化します。

| AI出力（key） | R列の正規名（value） |
|--------------|---------------------|
| 接待交際費 | 交際費 |

既定は上記1件のみ。追加したいときは `CASHBOOK_ACCOUNT_ALIAS_MAP` 環境変数に JSON で全上書きします。

```bash
CASHBOOK_ACCOUNT_ALIAS_MAP='{"接待交際費":"交際費","外注費":"業務委託費"}'
```

辞書に無い勘定科目は従来通り**完全一致**で Q:R を引きます。どちらにもマッチしなければ C列は空欄のまま。

## ステータス遷移

```
reserved → written → success / low_confidence / manual_entry
reserved → expired (TTL超過)
reserved → error (書き込み失敗)
written  → success (ジョブ復旧: 出納帳に値あり)
written  → expired (ジョブ復旧: 出納帳に値なし)
```

## 排他制御・重複防止

- 使用済み行: A/B/C列のいずれかに値 + reserved/written 行
- 競合検知: `reservation_id` ベース（同じ行に別UUIDがあれば競合）
- 重複防止: `fileId:receiptIndex` + written も再記入防止対象
- stale 回収: ジョブ開始時に `cleanup_stale_reservations` + `recover_stale_written`

## サービスアカウント

### 実行用: `receipt-ocr@PROJECT.iam.gserviceaccount.com`

必要権限:
- マスタースプレッドシートへの「編集者」共有
- 各顧客の出納帳への「編集者」共有（テンプレートコピー時に自動設定される）
- テンプレートスプレッドシートへの「閲覧者」共有
- `CASHBOOK_OUTPUT_FOLDER_ID` への「編集者」共有
- 各顧客の Drive フォルダへの「閲覧者」共有
- Secret Manager 読み取り

### デプロイ用: `github-actions-deploy@PROJECT.iam.gserviceaccount.com`

- `roles/run.admin`, `roles/artifactregistry.writer`, `roles/iam.serviceAccountUser`

## セットアップ

```bash
gcloud config set project PROJECT_ID
gcloud services enable vision.googleapis.com drive.googleapis.com \
  sheets.googleapis.com generativelanguage.googleapis.com \
  run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

echo -n "KEY" | gcloud secrets create gemini-api-key --data-file=-

# ローカル開発用
mkdir -p credentials
gcloud iam service-accounts keys create credentials/service-account.json \
  --iam-account=receipt-ocr@PROJECT_ID.iam.gserviceaccount.com
```

### ローカル実行

```bash
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements-dev.txt
cp .env.example .env  # 値を設定
pytest -v
DRY_RUN=true python -m src.main
python -m src.main
```

## Cloud Run デプロイ

```bash
gcloud artifacts repositories create receipt-ocr \
  --repository-format=docker --location=asia-northeast1

IMAGE="asia-northeast1-docker.pkg.dev/PROJECT_ID/receipt-ocr/receipt-ocr-job:latest"
docker build -t "${IMAGE}" . && docker push "${IMAGE}"

gcloud run jobs create receipt-ocr-job \
  --image="${IMAGE}" --region=asia-northeast1 \
  --service-account=receipt-ocr@PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars="MASTER_SPREADSHEET_ID=xxx,INDIVIDUAL_TEMPLATE_SPREADSHEET_ID=xxx,CORPORATE_TEMPLATE_SPREADSHEET_ID=xxx,CASHBOOK_OUTPUT_FOLDER_ID=xxx" \
  --set-secrets="GEMINI_API_KEY=gemini-api-key:latest" \
  --max-retries=1 --task-timeout=600s --memory=512Mi

gcloud run jobs execute receipt-ocr-job --region=asia-northeast1
```

## 環境変数

| 変数 | 必須 | 既定 | 説明 |
|------|------|------|------|
| `MASTER_SPREADSHEET_ID` | Yes | | マスターシートID |
| `GEMINI_API_KEY` | Yes | | Gemini API キー |
| `INDIVIDUAL_TEMPLATE_SPREADSHEET_ID` | — | | （将来用、現在は未使用） |
| `CORPORATE_TEMPLATE_SPREADSHEET_ID` | — | | （将来用、現在は未使用） |
| `CASHBOOK_OUTPUT_FOLDER_ID` | — | | （将来用、現在は未使用） |
| `GOOGLE_APPLICATION_CREDENTIALS` | ローカル | | SA キーパス |
| `MASTER_SHEET_NAME` | | シート1 | マスターシート名 |
| `MASTER_DATA_START_ROW` | | 2 | マスターデータ開始行 |
| `MASTER_TARGET_ENTRY_TYPE` | | 当方記帳 | 処理対象の記帳区分 |
| `CASHBOOK_OCCUPIED_CHECK_COLUMNS` | | 0,1,2 | 使用済み判定列 |
| `CASHBOOK_DATA_START_ROW` | | 5 | データ開始行 |
| `CASHBOOK_PROTECTED_COLUMNS` | | 3,13 | 保護列 |
| `CASHBOOK_FORMULA_COPY_COLUMNS` | | 3,13 | 数式コピー列 |
| `CASHBOOK_ERROR_DETAIL_COLUMN` | | 14 | 要手入力行のエラー詳細列（既定: O列） |
| `CASHBOOK_ACCOUNT_CODE_COLUMN` | | 16 | 勘定科目コード参照列（既定: Q列） |
| `CASHBOOK_ACCOUNT_NAME_COLUMN` | | 17 | 勘定科目名参照列（既定: R列） |
| `CASHBOOK_ACCOUNT_TABLE_START_ROW` | | 1 | 参照表の開始行 |
| `CASHBOOK_ACCOUNT_ALIAS_MAP` | | `{"接待交際費":"交際費"}` | 勘定科目の表記揺れ正規化（AI出力→R列名） |
| `EXCLUDED_FILE_NAME_PREFIXES` | | `[済],【済】` | 処理対象外にするファイル名プレフィックス |
| `OCR_ENGINE` | | vision | 主 OCR エンジン |
| `OCR_FALLBACK_ENGINE` | | （無し） | フォールバック OCR（例: `vision_document`） |
| `OCR_FALLBACK_CONFIDENCE_THRESHOLD` | | 0.6 | この conf 未満で fallback 試行 |
| `AI_MODEL` | | gemini-2.5-flash | Gemini モデル |
| `AI_CONFIDENCE_THRESHOLD` | | 0.7 | 信頼度閾値 |
| `RESERVATION_TTL_MINUTES` | | 30 | 予約有効期限(分) |
| `DRY_RUN` | | false | 書き込みスキップ |
| `LOG_LEVEL` | | INFO | ログレベル |

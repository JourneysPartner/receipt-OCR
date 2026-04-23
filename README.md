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
4. D列のフォルダURLからレシートファイルを取得
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

OCR失敗 / AI抽出失敗 / 書き込み失敗などで `※要手入力` 行を作成する場合:

| 列 | 内容 | 例 |
|----|------|----|
| A | ファイルリンク | `https://drive.google.com/…` |
| B | 日付（推定 or 処理日） | `2026-04-23` |
| K | 摘要 | `※要手入力`（短文固定） |
| O | **エラー詳細** | `OCR失敗: Cloud Vision API has not been used...` |

`CASHBOOK_ERROR_DETAIL_COLUMN` で O列を変更可能（既定: 14 = O列）。
通常の正常記帳行では O列は触りません。
C列（勘定科目コード）も変換表にエントリが無ければ触らないので、既存数式/値は保護されます。

### 処理対象外ファイル

ファイル名が `[済]` または `【済】` で始まるファイルは自動的に処理対象から除外されます。
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

- AI が抽出した勘定科目名を R列の値と完全一致で照合
- 一致した行の Q列コードを C列へ書き込む
- **一致しなければ C列は触らない**（既存値/数式を保護）
- 列位置は `CASHBOOK_ACCOUNT_CODE_COLUMN` / `CASHBOOK_ACCOUNT_NAME_COLUMN`、開始行は `CASHBOOK_ACCOUNT_TABLE_START_ROW` で変更可能

顧客の出納帳スプレッドシート側で Q:R に勘定科目マスタを置いておいてください。

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
| `EXCLUDED_FILE_NAME_PREFIXES` | | `[済],【済】` | 処理対象外にするファイル名プレフィックス |
| `AI_MODEL` | | gemini-2.5-flash | Gemini モデル |
| `AI_CONFIDENCE_THRESHOLD` | | 0.7 | 信頼度閾値 |
| `RESERVATION_TTL_MINUTES` | | 30 | 予約有効期限(分) |
| `DRY_RUN` | | false | 書き込みスキップ |
| `LOG_LEVEL` | | INFO | ログレベル |

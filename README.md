# レシート OCR・AI 仕訳システム

Google Drive 上のレシート画像/PDF を OCR + AI で解析し、現金出納帳スプレッドシートに自動記入する Cloud Run Job。

## アーキテクチャ

```
Google Drive (レシート画像/PDF)
    │
    ▼
Cloud Run Job (Python 3.11)
    ├── Drive API でファイル取得
    ├── Cloud Vision API で OCR
    ├── Gemini API で構造化抽出
    ├── 業務ルール補正
    └── Sheets API で書き込み
            │
            ▼
Google Sheets
    ├── 現金出納帳（既存シート、必要列のみ更新）
    │     ├── A列 = レシートファイルリンク
    │     ├── D列/N列 = 既存数式（直前行からコピー）
    │     └── 失敗行 = ※要手入力
    ├── 処理管理（fileId+receiptIndex / reservation_id）
    └── AI詳細ログ
```

## 現金出納帳の列マッピング

| 列 | index | フィールド | 備考 |
|----|-------|-----------|------|
| A  | 0     | ファイルリンク | Google Drive URL |
| B  | 1     | 日付 | YYYY-MM-DD |
| C  | 2     | 摘要 | 失敗時「※要手入力: エラー」 |
| **D** | **3** | **保護+数式コピー** | **既存関数列** |
| E  | 4     | 取引先 | |
| F  | 5     | 勘定科目 | |
| G  | 6     | 税区分 | |
| H  | 7     | 収入金額 | |
| I  | 8     | 支出金額 | |
| **N** | **13** | **保護+数式コピー** | **既存関数列** |

### 使用済み行判定

**A/B/C列のいずれかに値があれば使用済み**と判定。B列だけに依存しないため、A列にリンクだけ書かれてB列が空の行も確実に保護される。設定変更: `CASHBOOK_OCCUPIED_CHECK_COLUMNS`

### 数式コピー

新規行書き込み前に `copyPaste API` (`PASTE_FORMULA`) で直前行の D列/N列を自動コピー。通常行・要手入力行の両方で実行。

## ステータス遷移

```
reserved → written           出納帳書き込み成功
written  → success           後処理完了
written  → low_confidence    後処理完了（信頼度低）
written  → manual_entry      要手入力行
reserved → manual_entry      エラー回復
reserved → error             書き込み失敗
reserved → expired           TTL超過
written  → success           復旧（出納帳に値あり）
written  → expired           復旧（出納帳に値なし）
```

## 行予約の排他制御

### 空き行判定

「使用済み」= 出納帳の A/B/C 列いずれかに値 + 処理管理の reserved/written 行

### 競合検知

`get_active_reservations()` で `cashbookRow → [ActiveReservation]` を取得。予約後に同じ行に自分以外の reservation_id があれば競合 → 自分を expired にして再試行（最大3回）。

### 処理フロー（1明細）

```
1. ジョブ開始: cleanup_stale_reservations() + recover_stale_written()
2. find_available_rows(): 出納帳 + 予約行を除外
3. reserve_rows(): UUID付き予約 + 競合チェック
4. copy_formulas_to_row(): D/N列数式コピー
5. write_cashbook_row(): 出納帳書き込み
6. reserved → written: 出納帳反映済みを即記録
7. append_ai_log(): AIログ
8. written → success: 最終ステータス
```

### reserved の失効

- TTL: デフォルト30分（`RESERVATION_TTL_MINUTES`）
- ジョブ開始時に `cleanup_stale_reservations()` で期限切れ → expired

### written の復旧（クラッシュ対策）

- ジョブ開始時に `recover_stale_written()` を実行
- 出納帳の該当行に値あり → success に回復
- 値なし → expired に回復
- `get_processed_keys()` は written を含むため、復旧前でも再記入は発生しない

## 重複防止

- 主キー: `fileId + receiptIndex`
- 再記入防止対象: success / low_confidence / manual_entry / **written**
- 再処理対象: reserved / expired / error

## サービスアカウント

### 実行用: `receipt-ocr@PROJECT.iam.gserviceaccount.com`

Cloud Run Job が使用。必要権限:
- Drive フォルダへの「閲覧者」共有
- スプレッドシートへの「編集者」共有
- Secret Manager 読み取り (`roles/secretmanager.secretAccessor`)

```bash
gcloud iam service-accounts create receipt-ocr \
  --display-name="Receipt OCR Job Runner"

gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:receipt-ocr@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### デプロイ用: `github-actions-deploy@PROJECT.iam.gserviceaccount.com`

GitHub Actions が使用。必要権限:
- `roles/run.admin`, `roles/artifactregistry.writer`, `roles/iam.serviceAccountUser`

## セットアップ

### 1. GCP 準備

```bash
gcloud config set project PROJECT_ID
gcloud services enable vision.googleapis.com drive.googleapis.com \
  sheets.googleapis.com generativelanguage.googleapis.com \
  run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

# Gemini API キーを Secret Manager に保存
echo -n "YOUR_KEY" | gcloud secrets create gemini-api-key --data-file=-

# ローカル開発用キー
mkdir -p credentials
gcloud iam service-accounts keys create credentials/service-account.json \
  --iam-account=receipt-ocr@PROJECT_ID.iam.gserviceaccount.com
```

### 2. スプレッドシート準備

- 既存の現金出納帳はそのまま使用
- 処理管理 / AI詳細ログシートは**初回実行時に自動作成**
- サービスアカウントを「編集者」として共有

### 3. ローカル開発

```bash
python -m venv .venv
.venv\Scripts\activate      # Windows
pip install -r requirements-dev.txt

cp .env.example .env        # 値を設定

pytest -v                   # テスト
DRY_RUN=true python -m src.main   # ドライラン
python -m src.main                # 本実行
```

### 4. Docker ローカル実行

```bash
docker compose up --build
```

## Cloud Run デプロイ

### 手動

```bash
gcloud artifacts repositories create receipt-ocr \
  --repository-format=docker --location=asia-northeast1

IMAGE="asia-northeast1-docker.pkg.dev/PROJECT_ID/receipt-ocr/receipt-ocr-job:latest"
docker build -t "${IMAGE}" .
docker push "${IMAGE}"

gcloud run jobs create receipt-ocr-job \
  --image="${IMAGE}" --region=asia-northeast1 \
  --service-account=receipt-ocr@PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars="DRIVE_FOLDER_ID=xxx,SPREADSHEET_ID=xxx" \
  --set-secrets="GEMINI_API_KEY=gemini-api-key:latest" \
  --max-retries=1 --task-timeout=600s --memory=512Mi

gcloud run jobs execute receipt-ocr-job --region=asia-northeast1
```

### GitHub Actions

`main` push → lint/test → deploy。Secrets:

| Secret | 説明 |
|--------|------|
| `GCP_PROJECT_ID` | GCP プロジェクト ID |
| `WIF_PROVIDER` | Workload Identity Federation |
| `WIF_SERVICE_ACCOUNT` | デプロイ用 SA |
| `DRIVE_FOLDER_ID` | Drive フォルダ ID |
| `SPREADSHEET_ID` | スプレッドシート ID |

### スケジュール実行

```bash
gcloud scheduler jobs create http receipt-ocr-schedule \
  --location=asia-northeast1 --schedule="0 9 * * 1-5" \
  --uri="https://asia-northeast1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/PROJECT_ID/jobs/receipt-ocr-job:run" \
  --http-method=POST \
  --oauth-service-account-email=receipt-ocr@PROJECT_ID.iam.gserviceaccount.com
```

## 環境変数

| 変数 | 必須 | 既定 | 説明 |
|------|------|------|------|
| `DRIVE_FOLDER_ID` | Yes | | Drive フォルダ ID |
| `SPREADSHEET_ID` | Yes | | スプレッドシート ID |
| `GEMINI_API_KEY` | Yes | | Gemini API キー |
| `GOOGLE_APPLICATION_CREDENTIALS` | ローカル | | SA キーパス |
| `CASHBOOK_OCCUPIED_CHECK_COLUMNS` | | 0,1,2 | 使用済み判定列 |
| `CASHBOOK_DATA_START_ROW` | | 5 | データ開始行 |
| `CASHBOOK_COLUMN_MAP` | | (上表) | 列マッピング JSON |
| `CASHBOOK_PROTECTED_COLUMNS` | | 3,13 | 保護列 |
| `CASHBOOK_FORMULA_COPY_COLUMNS` | | 3,13 | 数式コピー列 |
| `AI_MODEL` | | gemini-2.5-flash | Gemini モデル |
| `AI_CONFIDENCE_THRESHOLD` | | 0.7 | 信頼度閾値 |
| `RESERVATION_TTL_MINUTES` | | 30 | 予約有効期限(分) |
| `DRY_RUN` | | false | 書き込みスキップ |
| `LOG_LEVEL` | | INFO | ログレベル |

## 実レシートでのテスト手順

```bash
# 1. テスト用 Drive フォルダにレシート画像を1枚アップロード
# 2. .env に DRIVE_FOLDER_ID と SPREADSHEET_ID を設定
# 3. ドライラン（Sheets 書き込みなし、ログだけ確認）
DRY_RUN=true python -m src.main

# 4. 出納帳に書き込む本実行
python -m src.main

# 5. 確認ポイント
#   - 現金出納帳: A列リンク, B列日付, C列摘要, D列/N列数式, E列以降の値
#   - 処理管理シート: fileId, receiptIndex, status=success, cashbookRow, reservationId
#   - AI詳細ログ: OCR結果, AI判定, 補正内容

# 6. 冪等性テスト（同じジョブを再実行 → スキップされること）
python -m src.main

# 7. 失敗テスト（壊れた画像をアップ → 要手入力行ができること）
```

## 拡張ポイント

- 複数フォルダ対応
- Slack 通知
- 要確認/要手入力の確認 Web UI
- OCR エンジン追加（Document AI 等）
- AI エンジン追加（GPT-4o 等、抽象層維持済み）
- 業務ルールの外部化（JSON/YAML/スプレッドシート）
- 承認フロー

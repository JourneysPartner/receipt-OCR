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
| C  | 摘要 | 失敗時「※要手入力」 |
| **D** | **保護+数式コピー** | **既存関数列** |
| E  | 取引先 | |
| F  | 勘定科目 | |
| G  | 税区分 | |
| H  | 収入金額 | |
| I  | 支出金額 | |
| **N** | **保護+数式コピー** | **既存関数列** |

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
| `AI_MODEL` | | gemini-2.5-flash | Gemini モデル |
| `AI_CONFIDENCE_THRESHOLD` | | 0.7 | 信頼度閾値 |
| `RESERVATION_TTL_MINUTES` | | 30 | 予約有効期限(分) |
| `DRY_RUN` | | false | 書き込みスキップ |
| `LOG_LEVEL` | | INFO | ログレベル |

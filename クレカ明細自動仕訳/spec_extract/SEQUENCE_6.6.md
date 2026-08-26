## 6.6 カード形式の登録・改訂（独立フロー・Ver.2.2）

**明細取込の処理フローとは独立した運用フローである。** 顧客の転記先スプレッドシートへ1セルも書き込まず、処理リースを取得せず、ファイル内部状態を遷移させない。書込先はマスタースプレッドシート（カード形式マスター・形式サンプル台帳・形式サンプル期待値・監査ログ）とサンプルコーパス用Driveフォルダに限る。

起点は6つある。**いずれも4.2の「新しいカード形式を登録」の入口A〜Fから入る。**

| 入口 | 契機 | 分岐 |
|---|---|---|
| A：新規登録 | 形式不明ファイル（要確認`FORMAT_UNKNOWN`）の解決操作`REGISTER_FORMAT`、または形式が増えることを見越した事前登録 | 下記ステップ1から |
| B：改訂 | 対応済み形式の新しいサンプルを現行定義が扱えない（**判定基準は4.12.6の6条件**） | 下記ステップ1から（形式IDを選ぶ） |
| C：中断した登録の再開 | 段階4以降で中断した下書きが残っている | 下記ステップ6から |
| D：コーパス回帰のみ | リリース前の回帰試験（10.3 手順1）、定期的な健全性確認 | ステップ11だけを実行し、AC列を更新しない |
| E：コーパス保守 | 上限到達、期待値の再ベースライン、匿名化の確認、サンプルの失効 | 4.2のコーパス保守メニュー（E-1〜E-5）。**本フローのステップを通らない** |
| F：ロールバック | 有効化後に問題が判明した | 4.12.9の手順1から |

| # | ステップ | モジュール | 分岐と帰着 |
|---|---|---|---|
| 1 | 認可チェック（システム管理者以上・**コーパス横断操作はコーパス管理者**）・設定検証（`scope = 'FORMAT_REGISTRATION'`） | 03_Authorization / 05_SettingsValidator | **検証項目14（コーパスフォルダの読取・書込と祖先検査）に不合格なら開始しない**（CR-5・A-21）。**取込処理は本検証を通らないため影響を受けない** |
| 2 | 形式の指定（新規は形式IDと形式名の入力、改訂は形式IDの選択）、採取元顧客の選択、サンプルファイルの選択 | 01_Menu | **形式IDが既存と重複（新規登録時）→`CARD_FORMAT_DEFINITION_INVALID`**。採取元顧客への認可がなければ`AuthorizationError`（4.4.2） |
| 3 | 匿名化（`ANONYMIZE_V1`・4.12.7）と台帳への**仮登録**（`状態=PENDING`） | 14_FormatRegistry `registerSample` → `anonymizeSample` → 12_FileReader | `ACTIVE`＋`PENDING`件数が上限→`expirePendingSamples`を自動実行し、なお上限なら`SAMPLE_CORPUS_LIMIT_EXCEEDED`（入口E-2の`RETIRED`承認待ち）。行数超過→`SAMPLE_TOO_LARGE`。XLSXの構造不保存→`SAMPLE_ANONYMIZE_STRUCTURE_CHANGED`。監査ログ`SAMPLE_REGISTER`／`SAMPLE` |
| 4 | **匿名化結果の確認**。匿名化後の全セルを表示し、操作者が残存する識別情報の有無を確認する | 01_Menu → 14_FormatRegistry `confirmAnonymization` | 残存があれば追加マスクを指定してステップ3へ戻る。確認するまで`ACTIVE`になれない（INV-36・CR-1）。監査ログ`SAMPLE_ANONYMIZE_CONFIRM`／`SAMPLE` |
| 5 | 下書き定義の自動生成（4.12.1の10手順） | 14_FormatRegistry `inferDraftFromSample` → 12_FileReader | 文字コード判定不能→`ENCODING_DETECTION_FAILED`で中止。**明細候補行が0行→`requiresCustomParser`を返し4.12.8へ誘導**。シートへ書き込まない |
| 6 | 確認ダイアログ（**13問**）。**改訂では当該形式のAB列を初期値として提示する。AB列が空欄なら`deriveAnswersFromDefinition`で逆導出した値を初期値とする**（B-M13） | 01_Menu | 中断可。**中断してもカード形式マスターの`有効=TRUE`行を変更しない。** 入口Cから本ステップを再開できる |
| 7 | 回答の保存とE〜M・N・O・P・Q・Y・Z・AE〜AG・AH列の導出 | 14_FormatRegistry `saveDraftAnswers` | `ステータス=draft`・`有効=FALSE`・`AC列=空`の行を作る。スキーマ不適合→`CARD_FORMAT_DEFINITION_INVALID` |
| 8 | 抽出プレビュー（往復検証の第1パス。**6項目**を表示） | 14_FormatRegistry `previewExtraction` → 13_CardDetector → 20-24_Parser → 30_TransactionValidator | **取込処理と同じ抽出経路を用いる**（4.12の契約・4.12.12）。**検証は行わない**（A-17） |
| 9 | 操作者が期待値を確定。**`previewHash`（処理日依存の値を含まない。4.12.12）で提示内容と一致することを確認する**（B-M18） | 14_FormatRegistry `confirmExpectedValues` | 2.1.19 L〜P・AC・AD列と2.1.20の全行を保存し、**`状態`を`PENDING → ACTIVE`にする**（CR-4）。匿名化未確認→`SAMPLE_ANONYMIZE_NOT_CONFIRMED`。**確定しない限りステップ10へ進めない** |
| 10 | ゲート1：往復検証（第2パス・4.12.2の合格条件**11項**） | 14_FormatRegistry `runActivationGates` → `verifyDraftAgainstSample` | 不合格→`FORMAT_SAMPLE_ROUNDTRIP_FAILED`。**入口Cからステップ6へ戻る** |
| 11 | ゲート2：コーパス回帰（**回帰対象サンプル全件**・4.12.3）。**実行時間上限へ接近したらサンプル境界で中断し、継続トリガーで再開する**（A-13） | 14_FormatRegistry `runCorpusRegression` → 64_ContinuationManager | 不合格→`FORMAT_CORPUS_REGRESSION_FAILED`。**変更は不採用。`有効=TRUE`行は変更されない**（INV-34）。**コードの正当な修正が原因なら入口E-3の再ベースラインへ**（CR-7） |
| 12 | ゲート3：判定衝突検査（**4検査**・4.12.4。改訂では検査2'を含む） | 14_FormatRegistry `checkDetectionCollisions` → 13_CardDetector `detectFormatWith` | 不合格→`FORMAT_DETECTION_COLLISION`。衝突相手の形式ID・バージョン・サンプルID・成立した判定ステップを提示。**入口Cからステップ6へ戻り質問12・13を調整する**（CR-6） |
| 13 | ゲート結果と`corpusFingerprint`をAC列へ保存し、監査ログ`FORMAT_GATE`／`FORMAT`へ記録 | 14_FormatRegistry `runActivationGates` → 62_AuditLog | `overall ≠ PASS`ならここで終了する |
| 14 | 有効化の承認申請（`payload`にAB列・AC列を含む）。**2.1.21へ`状態=PENDING`の行が作られ`requestId`が返る**（B-M14） | 54_ApprovalManager `submitRequest` | 申請＝システム管理者 |
| 15 | オーナー管理者の承認。スナップショット取得（`FORMAT_ACTIVATE`。**カード形式マスターと形式サンプル台帳の2シートを対象**。B-M7） | 54_ApprovalManager `approve` → 63_BackupManager | 承認画面にAB列・AC列を表示する。`payload`不正→`REQUEST_PAYLOAD_INVALID` |
| 16 | 有効化。**AC列を2.1.2.8の評価規則6条件で再確認**し、旧行を`有効=FALSE`・`SUPERSEDED`で残す | 14_FormatRegistry `activateFormat` | AC列が古い・未実行・`corpusFingerprint`不一致→`FORMAT_CORPUS_REGRESSION_FAILED`でステップ10へ戻る |
| 17 | 2.1.21を`APPROVED`にし、監査ログ`APPROVE`／`FORMAT`へ記録 | 54_ApprovalManager → 62_AuditLog | |
| 18 | 形式登録待ちファイルの再検査指示（**要確認シートを起点に抽出し、操作者が選択する**。4.2・B-M11） | 14_FormatRegistry `requestRecheckAfterRegistration` → 11_FileStateManager | `REVIEW_WAIT → VALIDATING`（4.9の遷移表に存在する遷移） |

**ステップ11・12の失敗が「保留」ではなく「不採用」であることが本フローの要点である**（INV-34）。既存形式を壊す変更、または判定を曖昧にする変更は、**マージされない**。操作者に返るのは「どのサンプルの、どの明細行の、どの項目が、どう変わったか」（回帰。`failures[].sampleId`／`rowNumber`／`item`／`expected`／`actual`）と「どの形式の、どのバージョンが、どのサンプルに、どの判定ステップで成立したか」（衝突。`collidedFormatId`／`collidedFormatVersion`／`matchedStep`）である。

**ただし「不採用」は「行き止まり」ではない。** 4.12の契約末尾の「失敗経路と復旧操作の対応」表が、各失敗に対して4.2のメニューから到達できる復旧操作を1つ以上定めている。

### 本フローが顧客データへ与える影響（確認）

| 項目 | 規定 |
|---|---|
| 顧客の転記先スプレッドシート | **1セルも書き込まない**（4.12の事後条件） |
| 処理リース | **取得しない**（ステップ11の継続トリガーも取得しない。4.12.3） |
| ファイル内部状態 | **ステップ18を除き遷移させない**（ステップ18は`REVIEW_WAIT → VALIDATING`のみ） |
| 顧客の明細フォルダ | **読まない**（サンプルの元ファイルはステップ3で1回読むが、これは操作者が明示的に選んだファイルであり、採取元顧客への認可を要する） |
| 確認担当者の通常処理 | **影響しない。** 本フローの実行中に確認担当者が取込を実行できる。ただし処理中のファイルは`pinFormatVersion`で版を固定しており、ステップ16の有効化が処理中のファイルへ波及しない（INV-39） |

---


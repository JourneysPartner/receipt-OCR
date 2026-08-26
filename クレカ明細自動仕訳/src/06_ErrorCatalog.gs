'use strict';

/**
 * @param {string} message
 * @param {boolean} retryable
 * @param {?string} handler
 * @param {?string} reviewType
 * @param {string} guidance
 * @return {!Object}
 */
function errorCatalogEntry_(message, retryable, handler, reviewType, guidance) {
  return Object.freeze({
    message: message,
    retryable: retryable,
    handler: handler,
    reviewType: reviewType,
    guidance: guidance
  });
}

const ERROR_CATALOG = Object.freeze({
  UNKNOWN_CARD_FORMAT: errorCatalogEntry_('カード形式を判定できない', false, 'システム管理者', REVIEW_TYPE.FORMAT_UNKNOWN, 'サンプルとして新しい明細形式を登録する'),
  AMBIGUOUS_CARD_FORMAT: errorCatalogEntry_('複数形式が候補', false, 'システム管理者', REVIEW_TYPE.FORMAT_AMBIGUOUS, '判定キーワードを見直す'),
  MULTI_SHEET_AMBIGUOUS: errorCatalogEntry_('判定できるシートが複数存在する', false, 'システム管理者', REVIEW_TYPE.MULTI_SHEET, '対象シートを選択して再検査する（`SELECT_TARGET_SHEET`）'),
  CARD_FORMAT_DEFINITION_INVALID: errorCatalogEntry_('カード形式マスターN/O/P/Q列のJSON、またはAB/AC列のJSONが解析不能またはスキーマ不適合', false, 'システム管理者', REVIEW_TYPE.FORMAT_UNKNOWN, '形式定義を修正して再検査する'),
  FORMAT_SAMPLE_ROUNDTRIP_FAILED: errorCatalogEntry_('下書き定義を生成元サンプルへ適用した結果が、操作者が確定した期待値と一致しない（4.12.2の合格条件のいずれかを満たさない）', false, 'システム管理者', null, '不一致の内訳を提示する。回答を修正して段階4からやり直す。有効化を開始しない'),
  FORMAT_CORPUS_REGRESSION_FAILED: errorCatalogEntry_('登録済みサンプルの回帰が不合格、または回帰対象サンプル（2.1.19）の全件を照合していない、またはAC列のゲート結果が古い・未実行・`corpusFingerprint`不一致', false, 'システム管理者', null, '不合格サンプルID・行番号・項目・期待値・実測値を提示する。有効化を却下し、既存の`有効=TRUE`行を変更しない（INV-34・INV-35）。コードの正当な修正が原因なら4.12.10の再ベースラインへ誘導する（CR-7）'),
  FORMAT_DETECTION_COLLISION: errorCatalogEntry_('判定衝突検査が不合格（新定義が他形式のサンプルに成立、既存定義が新サンプルに成立、新サンプルに対して成立定義が1つでない、または改訂版が改訂前サンプルに成立しない）', false, 'システム管理者', null, '衝突した形式ID・バージョン・サンプルID・成立した判定ステップと成立の材料を提示する。段階4の質問12（判定キーワードの編集）・質問13（弁別語の選択）をやり直して弁別材料を調整し、段階7を再実行する（CR-6・4.12.4）'),
  SAMPLE_CORPUS_LIMIT_EXCEEDED: errorCatalogEntry_('`状態`が`ACTIVE`または`PENDING`のサンプル数が`MAX_CORPUS_SAMPLES`に達している', false, 'オーナー管理者', null, '「新しいカード形式を登録」→入口E（コーパスを保守する）から、期限切れの未確定サンプルを失効させるか（E-4）、不要なサンプルの`RETIRED`化を申請・承認する（E-2）。承認前に新しいサンプルを登録しない'),
  SAMPLE_FILE_MISSING: errorCatalogEntry_('台帳が指す匿名化サンプルがDriveに存在しない、またはバイナリハッシュ（2.1.19 G列）が保存値と一致しない', false, 'システム管理者', null, 'サンプルを再登録する。当該サンプルを含む回帰は`FAIL`とし、`PASS`として扱わない'),
  SAMPLE_LAST_OF_FORMAT: errorCatalogEntry_('当該操作の結果、対象形式の回帰対象サンプルが0件になる', false, 'オーナー管理者', null, '失効させる前に、当該形式の別のサンプルを登録する。有効な形式には回帰対象サンプルが常に1件以上必要である（仕様24.2・INV-35）'),
  SAMPLE_TOO_LARGE: errorCatalogEntry_('サンプルの物理行数が`SAMPLE_MAX_ROWS_PER_SAMPLE`を超える', false, 'オーナー管理者', null, '上限の引上げを申請・承認する（2.1.21 `SAMPLE_LIMIT_CHANGE`）。ファイルを切り出して登録しない（照合式と打切り検査が本物のファイルに対する検証でなくなるため。B-M6）'),
  SAMPLE_ANONYMIZE_NOT_CONFIRMED: errorCatalogEntry_('匿名化結果の確認（2.1.19 AA・AB列）が未了のサンプルに対し、期待値の確定またはゲートの実行を試みた', false, 'システム管理者', null, '入口E-5または段階3で匿名化結果を確認して確定する（INV-36・CR-1）'),
  SAMPLE_ANONYMIZE_STRUCTURE_CHANGED: errorCatalogEntry_('XLSXの匿名化前後で抽出結果が一致しない（4.12.7の必須検証）', false, 'システム管理者', null, '匿名化を破棄して登録を中止する。構造が保存されないファイルを「実構造サンプル」として登録しない（A-14）'),
  SAMPLE_CORPUS_FOLDER_MISCONFIGURED: errorCatalogEntry_('コーパスフォルダが読取・書込不能、または顧客の明細フォルダと入れ子になっている（4.6 検証項目14）', false, 'システム管理者', null, '形式登録フローのみを拒否する。取込処理は拒否しない（CR-5）。フォルダの配置と共有権限を是正する'),
  SAMPLE_REBASELINE_DIFF_STALE: errorCatalogEntry_('承認された再ベースラインの差分ハッシュが、実行直前に再計算した差分と一致しない', false, 'システム管理者', null, '差分を再提示して申請からやり直す。承認時に見せた差分と異なる内容で期待値を上書きしない（CR-7）'),
  SAMPLE_EXPECTED_TAMPERED: errorCatalogEntry_('形式サンプル期待値（2.1.20）から算出した`dataHash`が台帳AD列と一致しない（期待値の直接編集）', false, 'オーナー管理者', null, '当該サンプルを含む回帰を`FAIL`とする。監査ログに正規経路（`SAMPLE_REBASELINE`）の記録がないことを確認し、期待値を再ベースラインするかサンプルを再登録する（9.1・A-20）'),
  PRIOR_YEAR_USAGE_DATE: errorCatalogEntry_('個人顧客で、利用日の年が「対象年度 − 1」以下である（仕様9.9・5.12・判断#22）', false, '確認担当者', REVIEW_TYPE.PRIOR_YEAR, '行は確保済みである。担当者が「対象外にする」か「計上する」かを選ぶ。システムは自動で取引を除外しない'),
  CUSTOMER_MASTER_INVALID: errorCatalogEntry_('顧客マスターの必須列が空欄または許容値以外（AJ列の顧客区分、およびAJ列が`INDIVIDUAL`である場合のAK列（対象年度）を含む）', false, 'システム管理者', null, '当該顧客の処理を開始せず、他顧客の処理は継続する。顧客マスターを是正して再実行する。AK列（対象年度）はメニュー「対象年度を変更」（4.2 `menuSetFiscalYear`。設定検証は`scope = \'CUSTOMER_MASTER\'`）から設定する（監査記録を伴う唯一の正規経路。仕様9.9・INV-41）。要確認の解決操作`FIX_DATE_AMOUNT`の実行中に本コードが発生した場合（4.26.3 手順3）は、当該要確認を`RESOLVED`にせず、取引状態・シート値・取引ログのいずれも変更せずに操作全体を中止し、担当者へ「対象年度を変更」への誘導を表示する（Ver.2.5・指摘2）'),
  REQUEST_PAYLOAD_INVALID: errorCatalogEntry_('承認申請（2.1.21 I列）が解析不能、または当該申請種別の必須キーを欠く', false, 'システム管理者', null, '承認せず却下する。申請からやり直す'),
  REQUEST_NOT_FOUND: errorCatalogEntry_('`approve`／`reject`が指す`requestId`が2.1.21に存在しない、または`状態 ≠ PENDING`', false, 'システム管理者', null, '申請一覧から現在の状態を確認する。`EXPIRED`なら再申請する'),
  FORMAT_VERSION_CHANGED_DURING_RUN: errorCatalogEntry_('ファイルの処理中に、当該形式の`有効=TRUE`が別バージョンへ移った（INV-39）', false, 'システム管理者', null, '当該ファイルを`FAILED`とし、リースを解放する。管理者の再開指示（6.2）で最初から再検証する。前半と後半を別バージョンで解析した結果を確定させない'),
  ENCODING_DETECTION_FAILED: errorCatalogEntry_('文字コード判定不能または文字化けの疑い', false, '顧客', REVIEW_TYPE.FORMAT_UNKNOWN, 'UTF-8またはShift_JISで保存し直して再提出する'),
  CSV_PARSE_FAILED: errorCatalogEntry_('RFC 4180に従った解析に失敗（閉じない引用符等）', false, '顧客', REVIEW_TYPE.FORMAT_UNKNOWN, '引用符の対応を修正して再提出する'),
  SCAN_TRUNCATION_SUSPECTED: errorCatalogEntry_('連続空行による打切り位置以降に明細候補行が残存', false, 'システム管理者', REVIEW_TYPE.SCAN_TRUNCATED, '形式定義を修正するか、打切りを承認して再検査する'),
  DUPLICATE_CONTENT: errorCatalogEntry_('同一顧客内で明細内容ハッシュが一致する既取込ファイルが存在する', false, '確認担当者', REVIEW_TYPE.DUPLICATE, '取込を停止する'),
  PURPOSE_REVISION_CANDIDATE: errorCatalogEntry_('使用用途修正版候補（取引同一性ハッシュの並びが一致し明細内容ハッシュが相違）', false, '確認担当者', REVIEW_TYPE.DUPLICATE, '新規取込せず、使用用途更新／別ファイルとして取込／元の結果を維持のいずれかを選ぶ'),
  INPUT_LIMIT_EXCEEDED: errorCatalogEntry_('入力容量上限を超過', false, 'システム管理者', REVIEW_TYPE.INPUT_LIMIT, '途中まで処理せず管理者確認へ送る'),
  COUNT_TOTAL_MISMATCH: errorCatalogEntry_('件数・合計が抽出結果と一致しない', false, '確認担当者', REVIEW_TYPE.COUNT_TOTAL_MISMATCH, '承認して再検証するか顧客へ差戻す'),
  EMPTY_FILE_CONFIRMATION_REQUIRED: errorCatalogEntry_('有効明細が0件', false, '確認担当者', REVIEW_TYPE.EMPTY_FILE, '「0件で正しい」と確認する'),
  BILLING_MONTH_NOT_FOUND: errorCatalogEntry_('請求年月（締め年月）の取得元が1つも一致しない', false, '確認担当者', REVIEW_TYPE.DATE, 'ファイル名またはヘッダーの年月表記を確認する。形式定義Q列の追加はシステム管理者へ依頼する'),
  BILLING_MONTH_CONFLICT: errorCatalogEntry_('請求年月の取得元が矛盾（正規化後の締め年月が不一致）', false, 'システム管理者', REVIEW_TYPE.DATE, '形式定義Q列の`means`・`offsetMonths`を見直す'),
  DATE_NOT_EXISTENT: errorCatalogEntry_('補完後の年月日が実在しない（例：2025-02-29）', false, '確認担当者', REVIEW_TYPE.DATE, '日付を修正する'),
  DATE_OUT_OF_EXPECTED_RANGE: errorCatalogEntry_('日付が許容窓の外、または候補年が2つ以上', false, '確認担当者', REVIEW_TYPE.DATE, '日付を確認して修正する'),
  DESTINATION_SCHEMA_MISMATCH: errorCatalogEntry_('転記先形式不一致', false, 'システム管理者', REVIEW_TYPE.DESTINATION_FIX, '書込前に停止。列構成・シート名・期待値定義を是正して再検査する'),
  DESTINATION_TEMPLATE_ROW_NOT_EMPTY: errorCatalogEntry_('テンプレート行を複製した結果が空き行判定を満たさない', false, 'システム管理者', REVIEW_TYPE.DESTINATION_FIX, 'コピー元行の値・数式を是正する。無限に拡張を繰り返さない'),
  SOURCE_REQUIRES_CUSTOMER_FIX: errorCatalogEntry_('使用用途等の顧客修正が必要', false, '顧客', null, '元ファイルを修正して再提出する'),
  TRANSACTION_ID_COLLISION: errorCatalogEntry_('表示ID衝突、または同一取引IDが転記先の複数行に存在', false, 'システム管理者', REVIEW_TYPE.INTEGRITY, '自動修復せず停止する。リースを解放し内部状態を`REVIEW_WAIT`とする'),
  DESTINATION_VALUE_MISMATCH: errorCatalogEntry_('書込後の読取値が予定値と不一致', false, 'システム管理者', REVIEW_TYPE.INTEGRITY, '`COMMITTED`にせず要確認へ回す'),
  TRANSACTION_LOG_AMBIGUOUS: errorCatalogEntry_('同一取引IDの`有効=TRUE`行が2行以上（INV-03）', false, 'システム管理者', REVIEW_TYPE.INTEGRITY, '自動修復せず停止する'),
  LEASE_CONFLICT: errorCatalogEntry_('有効な別リースが存在、またはスクリプトロック取得不能', false, 'システム管理者', null, '当該ファイルをスキップし所有者を表示する'),
  FILE_RENAME_RETRY_EXHAUSTED: errorCatalogEntry_('ファイル名変更の再試行上限に到達', false, 'システム管理者', null, '内部状態は正しいため再転記しない。接頭辞を手動修正する'),
  FILE_NOT_FOUND: errorCatalogEntry_('対象ファイルがDriveに存在しない', false, 'システム管理者', null, '顧客へ確認し、顧客ループは中断しない'),
  CONTINUATION_TRIGGER_CREATE_FAILED: errorCatalogEntry_('継続トリガー作成失敗', false, 'システム管理者', null, '内部状態を`FAILED`とし管理者の再開指示を待つ'),
  QUOTA_WAIT_REQUIRED: errorCatalogEntry_('クォータ回復待ち', true, 'システム管理者', null, '取引境界で状態を保存し、回復見込み時刻以降に再開する'),
  LOG_CAPACITY_EXCEEDED: errorCatalogEntry_('必須ログを保存できない', false, 'システム管理者', null, 'アーカイブを実施する。ログを伴わない転記は行わない'),
  AUDIT_CHAIN_BROKEN: errorCatalogEntry_('監査ログの連鎖ハッシュが一致しない（INV-21）', false, 'システム管理者', null, '業務を停止しない。管理者へ通知し、破損記録行を追記して以降を新しい連鎖として継続する（INV-29）'),
  SNAPSHOT_RESTORE_VERIFY_FAILED: errorCatalogEntry_('復元後の照合（件数・`dataHash`・主要参照整合）が不一致', false, 'オーナー管理者', null, '復元を確定せず、復元先を復元前の状態へ戻して停止する'),
  FAULT_INJECTION_ENABLED_IN_PRODUCTION: errorCatalogEntry_('本番環境で障害注入設定が有効', false, 'システム管理者', null, 'Script Propertiesの設定を削除して再実行する'),
  TRANSIENT_DRIVE_ERROR: errorCatalogEntry_('一時的なDriveエラー（429・500・503を含む）', true, null, null, '4.38のバックオフ算式で自動再試行する'),
  TRANSIENT_SHEETS_ERROR: errorCatalogEntry_('一時的なSheetsエラー（429・500・503を含む）', true, null, null, '4.38のバックオフ算式で自動再試行する'),
  REQUIRED_LOG_WRITE_FAILED: errorCatalogEntry_('必須ログを書けない', false, 'システム管理者', null, '以降の転記書込を開始しない')
});

/** エラーカタログのコードを正本として保持する基底例外。 */
class CatalogError extends Error {
  constructor(code, detail) {
    if (code !== null && code !== undefined && !ERROR_CATALOG[code]) {
      throw new Error('Unknown error code: ' + code);
    }
    var message = code ? ERROR_CATALOG[code].message : '処理を実行できません';
    super(detail ? message + ': ' + detail : message);
    this.name = this.constructor.name;
    this.code = code || null;
    this.detail = detail || null;
  }
}

class AuthorizationError extends CatalogError {
  constructor(detail) { super(null, detail); }
}
class StateTransitionError extends CatalogError {
  constructor(detail) { super(null, detail); }
}
class IntegrityError extends CatalogError {}
class InputLimitError extends CatalogError {
  constructor(detail) { super('INPUT_LIMIT_EXCEEDED', detail); }
}
class QuotaError extends CatalogError {
  constructor(detail) { super('QUOTA_WAIT_REQUIRED', detail); }
}
class LogCapacityError extends CatalogError {}
class FormatDefinitionError extends CatalogError {
  constructor(detail) { super('CARD_FORMAT_DEFINITION_INVALID', detail); }
}
class FormatGateError extends CatalogError {}
class SampleCorpusError extends CatalogError {}
class ApprovalError extends CatalogError {}
class MasterDataError extends CatalogError {
  constructor(detail) { super('CUSTOMER_MASTER_INVALID', detail); }
}
class ParseError extends CatalogError {}
class ValidationError extends CatalogError {}
class FaultInjectionStop extends CatalogError {
  constructor(detail) { super(null, detail); }
}

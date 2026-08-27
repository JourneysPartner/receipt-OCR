'use strict';

/**
 * システム全体で共有する列挙値を作る。
 * 列挙型は設計書 4.1 の規定どおり、キーと値を同じ文字列にする。
 *
 * @param {!Array<string>} keys
 * @return {!Object<string, string>}
 */
function createStringEnum_(keys) {
  var result = {};
  keys.forEach(function(key) {
    result[key] = key;
  });
  return Object.freeze(result);
}

const CONFIG = Object.freeze({
  // 導入時に設定する。秘密値ではないが、未設定のまま本番実行しない。
  MASTER_SPREADSHEET_ID: '',

  SHEET_NAMES: Object.freeze({
    CUSTOMER_MASTER: '顧客マスター',
    CARD_FORMAT_MASTER: 'カード形式マスター',
    PURPOSE_COMPLEMENT: '使用用途補完マスター',
    COMMON_PARTNER_LIST: '共通取引先一覧',
    COMMON_PARTNER_DICT: '共通取引先辞書',
    CUSTOMER_PARTNER_DICT: '顧客別取引先辞書',
    REVIEW: '要確認',
    PROCESS_LOG: 'クレカ処理ログ',
    TRANSACTION_LOG: 'クレカ取引ログ',
    AUDIT_LOG: '監査ログ',
    SYNC_LOG: '同期ログ',
    FREEE_IMPORT: 'freee取込管理',
    PROCESS_LEASE: '処理リース',
    LOG_ARCHIVE_INDEX: 'ログアーカイブ台帳',
    PERMANENT_FILE_INDEX: '恒久ファイルインデックス',
    CAPACITY_PROBE: '容量プローブ',
    SNAPSHOT_INDEX: '復元用スナップショット台帳',
    FORMAT_SAMPLE_INDEX: '形式サンプル台帳',
    FORMAT_SAMPLE_EXPECTED: '形式サンプル期待値',
    APPROVAL_REQUEST: '承認申請'
  }),

  TX_INDEX_SHEET_PREFIX: 'TXIDX_',
  SNAPSHOT_SHEET_PREFIX: 'SNAP_',

  REVIEW_SUMMARY: Object.freeze({
    DEFAULT_SHEET_NAME: 'システム情報',
    TITLE_CELL: 'A1',
    COUNT_CELL: 'B1',
    UPDATED_AT_CELL: 'B2',
    LINK_TITLE_CELL: 'A3',
    LINK_CELL: 'B3'
  }),

  // 4.6 検査2の対象。マスタースプレッドシートに必ず存在すべきシート。
  // 値はシート名ではなく SHEET_NAMES のキー名である（INV-05・A-22）。
  // 1つでも欠けたまま処理を始めると、書込の途中で「シートがない」と
  // 落ちる ── 半分書けた状態で止まるより、始める前に止めたい。
  REQUIRED_SHEET_KEYS: Object.freeze([
    'CUSTOMER_MASTER', 'COMMON_PARTNER_LIST', 'COMMON_PARTNER_DICT',
    'CUSTOMER_PARTNER_DICT', 'PURPOSE_COMPLEMENT', 'CARD_FORMAT_MASTER',
    'PROCESS_LOG', 'TRANSACTION_LOG', 'AUDIT_LOG', 'REVIEW',
    'PROCESS_LEASE', 'PERMANENT_FILE_INDEX', 'APPROVAL_REQUEST',
    'FORMAT_SAMPLE_INDEX', 'FORMAT_SAMPLE_EXPECTED',
    'SYNC_LOG', 'FREEE_IMPORT', 'LOG_ARCHIVE_INDEX',
    'CAPACITY_PROBE', 'SNAPSHOT_INDEX'
  ]),

  ARCHIVE_EXEMPT_SHEET_KEYS: Object.freeze([
    'PERMANENT_FILE_INDEX',
    'APPROVAL_REQUEST',
    'FORMAT_SAMPLE_INDEX',
    'FORMAT_SAMPLE_EXPECTED'
  ]),
  ARCHIVE_EXEMPT_SPREADSHEETS: Object.freeze(['TX_INDEX_SPREADSHEET_ID']),
  AUDIT_CHAIN_GENESIS: 'GENESIS'
});

const FILE_STATE = createStringEnum_([
  'DISCOVERED', 'VALIDATING', 'WRITING', 'REVIEW_WAIT',
  'CUSTOMER_FIX_REQUIRED', 'COMPLETED', 'CANCELED', 'EXCLUDED', 'FAILED'
]);

// この値集合だけが、元ファイル名から除去してよい接頭辞の全体である（INV-12）。
const STATE_TO_PREFIX = Object.freeze({
  DISCOVERED: '',
  VALIDATING: '【処理中】',
  WRITING: '【処理中】',
  REVIEW_WAIT: '【処理中】',
  FAILED: '【処理中】',
  CUSTOMER_FIX_REQUIRED: '【要修正】',
  COMPLETED: '【済】',
  CANCELED: '【取消済】',
  EXCLUDED: '【対象外】'
});

const TX_STATUS = createStringEnum_([
  'PREPARED', 'WRITING', 'COMMITTED', 'REVIEW_REQUIRED', 'CANCELED',
  'DELETED_ACCEPTED'
]);

const ALLOWED_TX_TRANSITIONS = Object.freeze({
  null: Object.freeze([TX_STATUS.PREPARED]),
  PREPARED: Object.freeze([
    TX_STATUS.WRITING, TX_STATUS.COMMITTED, TX_STATUS.REVIEW_REQUIRED,
    TX_STATUS.CANCELED
  ]),
  WRITING: Object.freeze([
    TX_STATUS.COMMITTED, TX_STATUS.REVIEW_REQUIRED, TX_STATUS.CANCELED
  ]),
  COMMITTED: Object.freeze([TX_STATUS.CANCELED, TX_STATUS.DELETED_ACCEPTED]),
  REVIEW_REQUIRED: Object.freeze([TX_STATUS.COMMITTED, TX_STATUS.CANCELED]),
  CANCELED: Object.freeze([]),
  DELETED_ACCEPTED: Object.freeze([])
});

const PARTNER_STATUS = createStringEnum_([
  'UNRESOLVED', 'RESOLVED_WITH_PARTNER', 'RESOLVED_WITHOUT_PARTNER'
]);

const FREEE_IMPORT_STATUS = createStringEnum_([
  'NOT_IMPORTED', 'IMPORTED', 'NEEDS_FREEE_FIX'
]);

const ALLOWED_FREEE_TRANSITIONS = Object.freeze({
  NOT_IMPORTED: Object.freeze([FREEE_IMPORT_STATUS.IMPORTED]),
  IMPORTED: Object.freeze([FREEE_IMPORT_STATUS.NEEDS_FREEE_FIX]),
  NEEDS_FREEE_FIX: Object.freeze([FREEE_IMPORT_STATUS.IMPORTED])
});

const REVIEW_TYPE = createStringEnum_([
  'PARTNER', 'DATE', 'AMOUNT', 'ZERO_AMOUNT', 'INTEGRITY', 'PRIOR_YEAR',
  'FORMAT_UNKNOWN', 'FORMAT_AMBIGUOUS', 'MULTI_SHEET', 'DUPLICATE',
  'FILE_CHANGED', 'COUNT_TOTAL_MISMATCH', 'EMPTY_FILE', 'INPUT_LIMIT',
  'DESTINATION_FIX', 'SCAN_TRUNCATED'
]);

const TX_SCOPED_REVIEW_TYPES = Object.freeze([
  REVIEW_TYPE.PARTNER,
  REVIEW_TYPE.DATE,
  REVIEW_TYPE.AMOUNT,
  REVIEW_TYPE.ZERO_AMOUNT,
  REVIEW_TYPE.INTEGRITY,
  REVIEW_TYPE.PRIOR_YEAR
]);

const REVIEW_EXCLUDE_REASON = createStringEnum_([
  'REVIEWER_JUDGEMENT', 'CANCELED', 'PRIOR_YEAR_GROUNDS_LOST',
  'FISCAL_YEAR_CHANGED'
]);

// 辞書2.1.5 S列（無効化理由）と取引ログの無効化理由が共有する語彙。
// 要確認の除外理由（REVIEW_EXCLUDE_REASON）とは別のものである。
const DICT_INVALIDATION_REASON = createStringEnum_([
  'SUPERSEDED', 'ROLLBACK', 'CANCEL_REPROCESS', 'MANUAL'
]);

const CUSTOMER_CATEGORY = createStringEnum_(['CORPORATE', 'INDIVIDUAL']);
const LEASE_STATE = createStringEnum_(['ACTIVE']);
const LEASE_PURPOSE = createStringEnum_(['PROCESS', 'WRITE_ONLY']);
const RENAME_STATE = createStringEnum_(['OK', 'PENDING_RETRY', 'FAILED_MAX_RETRY']);
const PARALLEL_STATE = createStringEnum_(['ACTIVE', 'ENDED']);

const DATE_INFERENCE_SOURCE = createStringEnum_([
  'FILENAME', 'BILLING_PERIOD', 'HEADER'
]);
const DATE_INFERENCE_STATUS = createStringEnum_([
  'RESOLVED', 'NOT_FOUND', 'CONFLICT', 'NO_CANDIDATE', 'MULTI_CANDIDATE',
  'NOT_EXISTENT', 'OUT_OF_RANGE', 'FUTURE'
]);

const SAMPLE_STATUS = createStringEnum_([
  'PENDING', 'ACTIVE', 'SUPERSEDED', 'RETIRED'
]);
const SAMPLE_RETIRE_REASON = createStringEnum_([
  'SUPERSEDED_BY_REVISION', 'RETIRED_BY_OWNER', 'RETIRED_BY_EXPIRY'
]);
const SAMPLE_ROW_JUDGEMENT = createStringEnum_(['TRANSACTION', 'EXCLUDED']);
const ACTIVATION_GATE = createStringEnum_([
  'ROUNDTRIP', 'CORPUS_REGRESSION', 'DETECTION_COLLISION'
]);
const GATE_SCOPE = createStringEnum_(['ACTIVATION', 'ROLLBACK']);
const GATE_RESULT = createStringEnum_(['PASS', 'FAIL', 'NOT_RUN', 'NOT_APPLICABLE']);
const FORMAT_REVISION_REASON = createStringEnum_([
  'NEW', 'ISSUER_EXPORT_CHANGED', 'DEFECT_FIX', 'ROLLBACK'
]);

const REQUEST_TYPE = createStringEnum_([
  'FORMAT_ACTIVATE', 'FORMAT_ROLLBACK', 'SAMPLE_RETIRE', 'SAMPLE_REBASELINE',
  'PARTNER_CREATE', 'DICT_PROMOTE', 'PARTNER_RENAME', 'DICT_ROLLBACK',
  'SYNC_ALL', 'ROW_RESTORE', 'SNAPSHOT_RESTORE', 'PARALLEL_END',
  'LOG_ARCHIVE', 'SNAPSHOT_RETENTION_CHANGE', 'INPUT_LIMIT_CHANGE',
  'SAMPLE_LIMIT_CHANGE'
]);
const REQUEST_STATUS = createStringEnum_([
  'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'
]);

// 下書き生成時の候補提示にのみ使用する（抽出時の正本ではない）。
const EXCLUSION_LABEL_SEEDS = Object.freeze([
  'ご入金', '入金', '合計', '小計', '総合計', 'ご請求', 'お支払', '支払',
  'キャッシング', '繰越', 'お繰越', '残高', '前月', '前回', '手数料',
  '年会費'
]);

// 4.12.1 の表順を維持する。pattern はシートへ格納する実値である。
const BILLING_MONTH_PATTERN_SEEDS = Object.freeze([
  Object.freeze({
    id: 'fn_enavi', kind: 'fileName',
    pattern: 'enavi(20\\d{2})(0[1-9]|1[0-2])',
    groups: Object.freeze({year: 1, month: 2}), yearDigits: 4,
    means: 'payment', offsetMonths: 1
  }),
  Object.freeze({
    id: 'fn_ym_closing', kind: 'fileName',
    pattern: '(20\\d{2})[-_年/]?(0?[1-9]|1[0-2])月?締',
    groups: Object.freeze({year: 1, month: 2}), yearDigits: 4,
    means: 'closing', offsetMonths: null
  }),
  Object.freeze({
    id: 'fn_ym', kind: 'fileName',
    pattern: '(20\\d{2})[-_年/]?(0?[1-9]|1[0-2])月?',
    groups: Object.freeze({year: 1, month: 2}), yearDigits: 4,
    means: 'payment', offsetMonths: 1
  }),
  Object.freeze({
    id: 'hdr_period', kind: 'scanRows',
    pattern: 'ご?利用期間[^0-9]{0,8}(20\\d{2})[/年](0?[1-9]|1[0-2])[/月](?:0?[1-9]|[12]\\d|3[01])日?[^0-9]{0,4}[~〜\\-][^0-9]{0,4}(20\\d{2})[/年](0?[1-9]|1[0-2])[/月]',
    groups: Object.freeze({year: 1, month: 2, endYear: 3, endMonth: 4}),
    yearDigits: 4, means: 'periodEnd', offsetMonths: null
  }),
  Object.freeze({
    id: 'hdr_closing', kind: 'scanRows',
    pattern: '(20\\d{2})年\\s*(0?[1-9]|1[0-2])月\\s*締(?:め)?(?:切)?',
    groups: Object.freeze({year: 1, month: 2}), yearDigits: 4,
    means: 'closing', offsetMonths: null
  }),
  Object.freeze({
    id: 'hdr_pay', kind: 'scanRows',
    pattern: '(20\\d{2})年\\s*(0?[1-9]|1[0-2])月\\s*(?:お)?支払(?:い)?分',
    groups: Object.freeze({year: 1, month: 2}), yearDigits: 4,
    means: 'payment', offsetMonths: 1
  })
]);

/**
 * 第11章の初期値候補。空文字列は「未設定」を表す。
 * 導入時には設定検証を通し、変更は監査対象とする。
 * キー集合は第11章の63キーと一致させる。
 */
const SETTINGS = Object.seal({
  LOG_RETENTION_YEARS: null,
  LOG_ARCHIVE_SPREADSHEET_ID: '',
  TX_INDEX_SPREADSHEET_ID: '',
  TX_INDEX_LOOKBACK_MONTHS: 12,
  SNAPSHOT_SPREADSHEET_ID: '',
  MAX_FILE_BYTES: 10 * 1024 * 1024,
  MAX_SHEETS_PER_FILE: 10,
  MAX_ROWS_PER_FILE: 10000,
  MAX_COLUMNS_PER_FILE: 50,
  MAX_TRANSACTIONS_PER_RUN: 10000,
  EXECUTION_TIMEOUT_SECONDS: null,
  SAFETY_MARGIN_SECONDS: 60,
  HEARTBEAT_TIMEOUT_SECONDS: 300,
  PERFORMANCE_DEGRADATION_THRESHOLD: null,
  SNAPSHOT_RETENTION_GENERATIONS: 10,
  DISPLAY_ID_LENGTH: 12,
  MAX_DRIVE_CALLS_PER_RUN: 8000,
  MAX_SHEETS_CALLS_PER_RUN: 8000,
  MAX_DRIVE_CALLS_PER_MINUTE: 60,
  MAX_SHEETS_CALLS_PER_MINUTE: 60,
  RETRY_BASE_BACKOFF_MS: 1000,
  MAX_TRIGGERS: 15,
  MAX_EMAILS_PER_DAY: 80,
  QUOTA_APPROACH_RATIO: 0.8,
  SPREADSHEET_CELL_LIMIT: 10000000,
  LOG_CAPACITY_WARN_PERCENT: 80,
  LOG_CAPACITY_STOP_PERCENT: 95,
  DRIVE_STORAGE_WARN_PERCENT: 80,
  DRIVE_STORAGE_STOP_PERCENT: 95,
  LOCK_TIMEOUT_MS: 20000,
  LEASE_FORCE_RELEASE_MIN_SECONDS: 1800,
  WRITE_BATCH_SIZE: 200,
  DESTINATION_INDEX_MAX_ROWS: 50000,
  SCHEMA_SAMPLE_ROWS: 50,
  RESCAN_TARGET_DAYS: 90,
  RESCAN_MAX_FILES_PER_RUN: 500,
  YEAR_INFERENCE_MAX_LOOKBACK_MONTHS: 3,
  YEAR_INFERENCE_MAX_FORWARD_MONTHS: 1,
  FILE_DIFF_MAX_RATIO: 0.3,
  MAX_RENAME_RETRIES: 3,
  MAX_ERROR_RECORDS_PER_FILE: 200,
  REPLACEMENT_CHAR_RATIO_THRESHOLD: 0.001,
  CONTROL_CHAR_RATIO_THRESHOLD: 0.01,
  CONSECUTIVE_EMPTY_ROWS_TO_STOP: 20,
  AUDIT_CHAIN_VERIFY_ROWS: 500,
  PARALLEL_MIN_DAYS: 30,
  PARALLEL_MIN_TRANSACTIONS: 1000,
  PARALLEL_WORK_FOLDER_ID: '',
  DRIVE_API_VERSION: null,
  SHEETS_API_VERSION: null,
  ADVANCED_SERVICES: null,
  FAULT_INJECTION: null,
  SAMPLE_CORPUS_FOLDER_ID: '',
  MAX_CORPUS_SAMPLES: 50,
  SAMPLE_MAX_ROWS_PER_SAMPLE: 1000,
  SAMPLE_INFER_SCAN_ROWS: 30,
  SAMPLE_INFER_SAMPLE_ROWS: 20,
  DATED_DATE_MAX_LOOKBACK_MONTHS: 24,
  DATED_DATE_MAX_FORWARD_MONTHS: 2,
  SAMPLE_PENDING_EXPIRE_DAYS: 14,
  MAX_SAMPLES_PER_REGRESSION_RUN: 10,
  CORPUS_ADMIN_EMAILS: '',
  REQUEST_EXPIRE_DAYS: 30
});

const VERSIONS = Object.freeze({
  TRANSACTION_ID: '2',
  HASH: '3',
  SHEET_SCHEMA: '1.0',
  CODE: '3.0.0'
});

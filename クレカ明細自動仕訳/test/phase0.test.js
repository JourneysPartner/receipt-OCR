'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

module.exports = function registerPhase0Tests({test, assert, gas}) {
  test('Apps Script manifest uses Asia/Tokyo and V8', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'appsscript.json'),
      'utf8'
    ));
    assert.equal(manifest.timeZone, 'Asia/Tokyo');
    assert.equal(manifest.runtimeVersion, 'V8');
  });

  const settingKeys = [
    'LOG_RETENTION_YEARS', 'LOG_ARCHIVE_SPREADSHEET_ID',
    'TX_INDEX_SPREADSHEET_ID', 'TX_INDEX_LOOKBACK_MONTHS',
    'SNAPSHOT_SPREADSHEET_ID', 'MAX_FILE_BYTES', 'MAX_SHEETS_PER_FILE',
    'MAX_ROWS_PER_FILE', 'MAX_COLUMNS_PER_FILE', 'MAX_TRANSACTIONS_PER_RUN',
    'EXECUTION_TIMEOUT_SECONDS', 'SAFETY_MARGIN_SECONDS',
    'HEARTBEAT_TIMEOUT_SECONDS', 'PERFORMANCE_DEGRADATION_THRESHOLD',
    'SNAPSHOT_RETENTION_GENERATIONS', 'DISPLAY_ID_LENGTH',
    'MAX_DRIVE_CALLS_PER_RUN', 'MAX_SHEETS_CALLS_PER_RUN',
    'MAX_DRIVE_CALLS_PER_MINUTE', 'MAX_SHEETS_CALLS_PER_MINUTE',
    'RETRY_BASE_BACKOFF_MS', 'MAX_TRIGGERS', 'MAX_EMAILS_PER_DAY',
    'QUOTA_APPROACH_RATIO', 'SPREADSHEET_CELL_LIMIT',
    'LOG_CAPACITY_WARN_PERCENT', 'LOG_CAPACITY_STOP_PERCENT',
    'DRIVE_STORAGE_WARN_PERCENT', 'DRIVE_STORAGE_STOP_PERCENT',
    'LOCK_TIMEOUT_MS', 'LEASE_FORCE_RELEASE_MIN_SECONDS', 'WRITE_BATCH_SIZE',
    'DESTINATION_INDEX_MAX_ROWS', 'SCHEMA_SAMPLE_ROWS', 'RESCAN_TARGET_DAYS',
    'RESCAN_MAX_FILES_PER_RUN', 'YEAR_INFERENCE_MAX_LOOKBACK_MONTHS',
    'YEAR_INFERENCE_MAX_FORWARD_MONTHS', 'FILE_DIFF_MAX_RATIO',
    'MAX_RENAME_RETRIES', 'MAX_ERROR_RECORDS_PER_FILE',
    'REPLACEMENT_CHAR_RATIO_THRESHOLD', 'CONTROL_CHAR_RATIO_THRESHOLD',
    'CONSECUTIVE_EMPTY_ROWS_TO_STOP', 'AUDIT_CHAIN_VERIFY_ROWS',
    'PARALLEL_MIN_DAYS', 'PARALLEL_MIN_TRANSACTIONS',
    'PARALLEL_WORK_FOLDER_ID', 'DRIVE_API_VERSION', 'SHEETS_API_VERSION',
    'ADVANCED_SERVICES', 'FAULT_INJECTION', 'SAMPLE_CORPUS_FOLDER_ID',
    'MAX_CORPUS_SAMPLES', 'SAMPLE_MAX_ROWS_PER_SAMPLE',
    'SAMPLE_INFER_SCAN_ROWS', 'SAMPLE_INFER_SAMPLE_ROWS',
    'DATED_DATE_MAX_LOOKBACK_MONTHS', 'DATED_DATE_MAX_FORWARD_MONTHS',
    'SAMPLE_PENDING_EXPIRE_DAYS', 'MAX_SAMPLES_PER_REGRESSION_RUN',
    'CORPUS_ADMIN_EMAILS', 'REQUEST_EXPIRE_DAYS'
  ];

  test('SETTINGS has exactly the 63 keys from chapters 4.1 and 11', () => {
    assert.equal(settingKeys.length, 63);
    const actual = gas.json('Object.keys(SETTINGS).sort()');
    assert.deepEqual(actual, settingKeys.slice().sort());
  });

  test('enumerations use identical keys and values', () => {
    const enumNames = [
      'FILE_STATE', 'TX_STATUS', 'PARTNER_STATUS', 'FREEE_IMPORT_STATUS',
      'REVIEW_TYPE', 'REVIEW_EXCLUDE_REASON', 'CUSTOMER_CATEGORY',
      'LEASE_STATE', 'LEASE_PURPOSE', 'RENAME_STATE', 'PARALLEL_STATE',
      'DATE_INFERENCE_SOURCE', 'DATE_INFERENCE_STATUS', 'SAMPLE_STATUS',
      'SAMPLE_RETIRE_REASON', 'SAMPLE_ROW_JUDGEMENT', 'ACTIVATION_GATE',
      'GATE_SCOPE', 'GATE_RESULT', 'FORMAT_REVISION_REASON', 'REQUEST_TYPE',
      'REQUEST_STATUS'
    ];
    for (const enumName of enumNames) {
      const entries = gas.json(`Object.entries(${enumName})`);
      assert.ok(entries.every(([key, value]) => key === value), enumName);
    }
  });

  test('ERROR_CATALOG contains all 51 design codes with the required shape', () => {
    const errorCodes = [
      'UNKNOWN_CARD_FORMAT', 'AMBIGUOUS_CARD_FORMAT', 'MULTI_SHEET_AMBIGUOUS',
      'CARD_FORMAT_DEFINITION_INVALID', 'FORMAT_SAMPLE_ROUNDTRIP_FAILED',
      'FORMAT_CORPUS_REGRESSION_FAILED', 'FORMAT_DETECTION_COLLISION',
      'SAMPLE_CORPUS_LIMIT_EXCEEDED', 'SAMPLE_FILE_MISSING',
      'SAMPLE_LAST_OF_FORMAT', 'SAMPLE_TOO_LARGE',
      'SAMPLE_ANONYMIZE_NOT_CONFIRMED', 'SAMPLE_ANONYMIZE_STRUCTURE_CHANGED',
      'SAMPLE_CORPUS_FOLDER_MISCONFIGURED', 'SAMPLE_REBASELINE_DIFF_STALE',
      'SAMPLE_EXPECTED_TAMPERED', 'PRIOR_YEAR_USAGE_DATE',
      'CUSTOMER_MASTER_INVALID', 'REQUEST_PAYLOAD_INVALID', 'REQUEST_NOT_FOUND',
      'FORMAT_VERSION_CHANGED_DURING_RUN', 'ENCODING_DETECTION_FAILED',
      'CSV_PARSE_FAILED', 'SCAN_TRUNCATION_SUSPECTED', 'DUPLICATE_CONTENT',
      'PURPOSE_REVISION_CANDIDATE', 'INPUT_LIMIT_EXCEEDED',
      'COUNT_TOTAL_MISMATCH', 'EMPTY_FILE_CONFIRMATION_REQUIRED',
      'BILLING_MONTH_NOT_FOUND', 'BILLING_MONTH_CONFLICT', 'DATE_NOT_EXISTENT',
      'DATE_OUT_OF_EXPECTED_RANGE', 'DESTINATION_SCHEMA_MISMATCH',
      'DESTINATION_TEMPLATE_ROW_NOT_EMPTY', 'SOURCE_REQUIRES_CUSTOMER_FIX',
      'TRANSACTION_ID_COLLISION', 'DESTINATION_VALUE_MISMATCH',
      'TRANSACTION_LOG_AMBIGUOUS', 'LEASE_CONFLICT',
      'FILE_RENAME_RETRY_EXHAUSTED', 'FILE_NOT_FOUND',
      'CONTINUATION_TRIGGER_CREATE_FAILED', 'QUOTA_WAIT_REQUIRED',
      'LOG_CAPACITY_EXCEEDED', 'AUDIT_CHAIN_BROKEN',
      'SNAPSHOT_RESTORE_VERIFY_FAILED', 'FAULT_INJECTION_ENABLED_IN_PRODUCTION',
      'TRANSIENT_DRIVE_ERROR', 'TRANSIENT_SHEETS_ERROR',
      'REQUIRED_LOG_WRITE_FAILED'
    ];
    assert.equal(errorCodes.length, 51);
    assert.deepEqual(gas.json('Object.keys(ERROR_CATALOG).sort()'), errorCodes.sort());
    assert.equal(
      gas.evaluate('Object.values(ERROR_CATALOG).every(function(e) { return typeof e.message === "string" && typeof e.retryable === "boolean" && Object.prototype.hasOwnProperty.call(e, "handler") && Object.prototype.hasOwnProperty.call(e, "reviewType") && typeof e.guidance === "string"; })'),
      true
    );
    assert.equal(gas.evaluate('ERROR_CATALOG.PRIOR_YEAR_USAGE_DATE.reviewType'), 'PRIOR_YEAR');
    assert.equal(gas.evaluate('ERROR_CATALOG.AUDIT_CHAIN_BROKEN.retryable'), false);
  });

  test('version constants match design version 2.9', () => {
    assert.deepEqual(gas.json('VERSIONS'), {
      TRANSACTION_ID: '2', HASH: '3', SHEET_SCHEMA: '1.0', CODE: '2.9.0'
    });
  });

  const vectors = [
    {
      id: 'A', elements: ['A', 'B'], serialized: '1:A1:B', bytes: 6,
      hex: '313a41313a42',
      hash: '73b87d2d8784fa591d799c5e736d805a7c508790e071635815c5c08aca1d4c98'
    },
    {
      id: 'B', elements: ['', null], serialized: '0:-1:', bytes: 5,
      hex: '303a2d313a',
      hash: '6650732948b6ac233c71a46d1676311d975ea87360e86f70a3cf93055e0fe4ef'
    },
    {
      id: 'C', elements: ['あ'], serialized: '3:あ', bytes: 5,
      hex: '333ae38182',
      hash: '776c23fc591a9b1e973b49634a5594406986cbf9287b868025086d8af6f0e141'
    },
    {
      id: 'D', elements: ['𠮷'], serialized: '4:𠮷', bytes: 6,
      hex: '343af0a0aeb7',
      hash: 'dd07de04994d96c957e546220165b3780771c686dd10e681b2d11d9d05ed03a7'
    },
    {
      id: 'E', elements: ['ﾄﾞﾝｷ'], serialized: '12:ﾄﾞﾝｷ', bytes: 15,
      hex: '31323aefbe84efbe9eefbe9defbdb7',
      hash: '3a0b1affcdf25fdb92529eb3521f53169f86d03f76c09c4d3758835267b4a794'
    },
    {
      id: 'F', elements: ['1:A', 'B'], serialized: '3:1:A1:B', bytes: 8,
      hex: '333a313a41313a42',
      hash: 'e3cfda58e00459ff3803bca540249836ff96c772ab9acd59b322d3e06107839b'
    },
    {
      id: 'G',
      elements: [new Date('2026-01-05T00:00:00+09:00'), 5015, true, null, ''],
      serialized: '10:2026-01-054:50154:TRUE-1:0:', bytes: 30,
      hex: '31303a323032362d30312d3035343a35303135343a545255452d313a303a',
      hash: 'ac612ae52264c04e2bc24c3fda3e5996f5d233887ef4eec7be3011aeb11ae927'
    }
  ];

  for (const vector of vectors) {
    test(`serialization vector ${vector.id}`, () => {
      const serialized = gas.call('serializeDeterministic', [vector.elements]);
      const bytes = Buffer.from(serialized, 'utf8');
      assert.equal(serialized, vector.serialized);
      assert.equal(bytes.length, vector.bytes);
      assert.equal(bytes.toString('hex'), vector.hex);
      assert.equal(gas.call('sha256Hex', [Array.from(bytes)]), vector.hash);
      assert.equal(gas.call('sha256', [Array.from(bytes)]), vector.hash);
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), vector.hash);
    });
  }

  test('ambiguity non-regression vector X differs from F', () => {
    const serialized = gas.call('serializeDeterministic', [['1', 'A1', 'B']]);
    assert.equal(serialized, '1:12:A11:B');
    const hash = gas.call('sha256Hex', [Array.from(Buffer.from(serialized, 'utf8'))]);
    assert.equal(hash, 'e467b82d35ec43039137d442192bcdcd3590d44e553c7a579dc778667371961a');
    assert.notEqual(hash, vectors.find((vector) => vector.id === 'F').hash);
  });

  test('toBool accepts only the specified normalized values', () => {
    for (const value of [true, 'TRUE', 'true', 1, '1']) {
      assert.equal(gas.call('toBool', [value]), true);
    }
    for (const value of [false, 'FALSE', 'false', '', null, undefined, 0]) {
      assert.equal(gas.call('toBool', [value]), false);
    }
    assert.throws(() => gas.call('toBool', ['True']));
    assert.throws(() => gas.call('toBool', [2]));
  });

  test('date and amount canonicalization are locale independent', () => {
    assert.equal(gas.call('cellToCanonicalString', [new Date('2026-01-04T15:00:00Z')]), '2026-01-05');
    assert.equal(gas.call('normalizeReadValue', ['B', '2026/01/05']), '2026-01-05');
    assert.equal(gas.call('normalizeReadValue', ['B', 46027]), '2026-01-05');
    assert.equal(gas.call('toIso8601', [new Date('2026-01-05T12:34:56Z')]), '2026-01-05T21:34:56+09:00');
    assert.equal(gas.call('toJpyInteger', ['-5,015']), -5015);
    assert.equal(gas.call('toDecimalString', [1e-7]), '0.0000001');
    assert.equal(gas.call('dateExists', [2024, 2, 29]), true);
    assert.equal(gas.call('dateExists', [2025, 2, 29]), false);
    assert.equal(gas.call('monthOrdinal', [2026, 1]), 24312);
  });

  test('backoff follows the required range for attempts 1 through 3', () => {
    for (const [attempt, minimum, maximum] of [[1, 1000, 1999], [2, 2000, 2999], [3, 4000, 4999]]) {
      const actual = gas.call('computeBackoffMs', [attempt]);
      assert.ok(actual >= minimum && actual <= maximum, `${attempt}: ${actual}`);
    }
  });
};

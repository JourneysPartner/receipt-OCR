'use strict';

module.exports = ({test, assert, gas}) => {
  const names = {
    customer: '顧客マスター', commonList: '共通取引先一覧', commonDict: '共通取引先辞書', customerDict: '顧客別取引先辞書',
    process: 'クレカ処理ログ', transaction: 'クレカ取引ログ', audit: '監査ログ', lease: '処理リース', fileIndex: '恒久ファイルインデックス'
  };
  const blank = (count) => Array(count).fill('');
  const sheetHeader = (count, label) => { const row = blank(count); row[0] = label; return row; };
  const plain = (value) => JSON.parse(JSON.stringify(value));

  function customerRow(overrides = {}) {
    const row = blank(37);
    Object.assign(row, {
      0: 'C001', 1: '顧客A', 2: 'TRUE', 3: 'folder1', 5: 'dest1', 7: '入力用シート', 8: '取引先一覧',
      9: 2, 10: 6, 11: 9, 12: 11, 13: 13, 14: 30, 15: '1.0',
      16: 'reviewer@example.com', 17: 'admin@example.com', 18: 0, 20: 'システム情報', 21: 'ACTIVE',
      23: 0, 24: 0, 29: 1, 30: JSON.stringify({B: '利用日'}), 31: '{}', 32: '{}', 33: 30,
      34: '取引先一覧', 35: 'INDIVIDUAL', 36: 2026
    }, overrides);
    return row;
  }

  function setup(options = {}) {
    gas.stubs.reset();
    const master = gas.stubs.createSpreadsheet('master', {sheets: [
      {name: names.customer, values: [sheetHeader(37, '顧客ID'), customerRow(options.customer || {})]},
      {name: names.commonList, values: [sheetHeader(6, '取引先ID'), ['P1', '株式会社テスト', '2026-01-01', 'admin', 'owner', 1]]},
      {name: names.commonDict, values: [sheetHeader(18, '辞書ID')]}, {name: names.customerDict, values: [sheetHeader(18, '辞書ID')]},
      {name: names.process, values: [sheetHeader(40, '実行ID')]}, {name: names.transaction, values: [sheetHeader(45, '取引ID完全値')]},
      {name: names.audit, values: [sheetHeader(15, '監査ID')]}, {name: names.lease, values: [sheetHeader(10, 'リースID')]},
      {name: names.fileIndex, values: [sheetHeader(13, 'ファイルID')]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    const header = blank(30); header[1] = '利用日'; header[5] = '取引先'; header[8] = '用途'; header[10] = '元店名'; header[12] = '金額'; header[29] = '内部ID';
    const occupied = blank(30); occupied[1] = '2026-01-02'; occupied[5] = '株式会社テスト'; occupied[8] = '仕入れ'; occupied[10] = '店舗'; occupied[12] = 1000; occupied[29] = 'TX_EXISTING';
    const formulas = [blank(30), blank(30), blank(30), blank(30), blank(30)]; formulas[3][4] = '=IF(A4="","",A4)';
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート', values: [header, blank(30), occupied, blank(30), blank(30)], formulas, maxRows: 5, maxColumns: 30},
      {name: '取引先一覧', values: [['取引先']]}
    ]});
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createFile('file1', {name: '明細.csv', data: 'a,b'});
    gas.stubs.createFolder('folder1', {fileIds: ['file1']});
    gas.evaluate("SETTINGS.TX_INDEX_SPREADSHEET_ID='txidx'; SETTINGS.DESTINATION_INDEX_MAX_ROWS=50000; SETTINGS.AUDIT_CHAIN_VERIFY_ROWS=500;");
    return {master, destination: gas.stubs.getSpreadsheet('dest1'), txidx: gas.stubs.getSpreadsheet('txidx')};
  }

  function createProcess(state = 'DISCOVERED') {
    const customer = gas.call('getCustomerById', ['C001']);
    gas.call('createOrUpdateProcessLog', ['RUN_1', customer, {
      id: 'file1', name: '明細.csv', binaryHash: 'b'.repeat(64), contentHash: 'c'.repeat(64), hashVersion: '3', state
    }]);
  }

  function txFixture(id = 'TX_001') {
    return {
      fullTxId: id, displayTxId: id.slice(0, 8), customerId: 'C001', fileId: 'file1', sourceRow: 2,
      formatId: 'dcard', plannedFinalStatus: 'COMMITTED', partnerResolutionStatus: 'RESOLVED_WITH_PARTNER',
      originalDate: '2026-01-02', originalMerchant: '店舗', originalAmount: 1000, originalPurpose: '仕入れ',
      planned: {b: '2026-01-02', f: '株式会社テスト', i: '仕入れ', k: '店舗', m: 1000},
      identityHash: 'd'.repeat(64), contentHash: 'c'.repeat(64), occurrenceIndex: 0,
      transactionIdVersion: '2', hashVersion: '3'
    };
  }

  test('phase2 stub exposes mutable spreadsheet, Drive, lock, session, and Advanced Sheets state', () => {
    const env = setup();
    gas.stubs.setActiveUser('changed@example.com');
    assert.equal(gas.evaluate("Session.getActiveUser().getEmail()"), 'changed@example.com');
    gas.evaluate("Sheets.Spreadsheets.Values.batchUpdate({data:[{range:\"'顧客マスター'!B2:B2\",values:[['変更名']]}]},'master')");
    assert.equal(env.master.getSheetByName(names.customer).getRange(2, 2).getValue(), '変更名');
    assert.equal(gas.evaluate("DriveApp.getFileById('file1').getBlob().getDataAsString()"), 'a,b');
    gas.stubs.getScriptLock().setTryLockResults([false]);
    assert.equal(gas.evaluate("LockService.getScriptLock().tryLock(1)"), false);
  });

  test('INV-02: customer sheet string TRUE is normalized while reading', () => {
    setup();
    const customers = plain(gas.call('getActiveCustomers'));
    assert.equal(customers.length, 1);
    assert.equal(customers[0].isActive, true);
    assert.equal(customers[0].fiscalYear, 2026);
  });

  test('customer fiscal-year validation is value-only and rejects string years', () => {
    setup({customer: {36: '2026'}});
    assert.throws(() => gas.call('getCustomerById', ['C001']), (error) => error.code === 'CUSTOMER_MASTER_INVALID');
  });

  test('customer access validates Drive and destination resources and creates the summary sheet', () => {
    const env = setup();
    gas.call('validateCustomerAccess', ['C001']);
    assert.ok(env.destination.getSheetByName('システム情報'));
  });

  test('setCustomerFiscalYear writes FISCAL_YEAR_CHANGE before changing AK and no-ops on equal value', () => {
    const env = setup();
    const result = plain(gas.call('setCustomerFiscalYear', ['C001', 2027, 'admin@example.com', '年度更新']));
    assert.equal(result.changed, true);
    assert.equal(env.master.getSheetByName(names.customer).getRange(2, 37).getValue(), 2027);
    assert.equal(env.master.getSheetByName(names.audit).getRange(3, 3).getValue(), 'FISCAL_YEAR_CHANGE');
    const beforeRows = env.master.getSheetByName(names.audit).getLastRow();
    assert.equal(plain(gas.call('setCustomerFiscalYear', ['C001', 2027, 'admin@example.com', 'same'])).changed, false);
    assert.equal(env.master.getSheetByName(names.audit).getLastRow(), beforeRows);
  });

  test('INV-05: process log creation and state update keep permanent file index synchronized', () => {
    const env = setup(); createProcess();
    let process = env.master.getSheetByName(names.process).getRange(2, 1, 1, 40).getValues()[0];
    let index = env.master.getSheetByName(names.fileIndex).getRange(2, 1, 1, 13).getValues()[0];
    assert.equal(process[7], 'file1'); assert.equal(index[0], 'file1'); assert.equal(process[16], index[3]);
    gas.call('updateProcessLog', ['file1', {internalState: 'VALIDATING', expectedPrefix: '【処理中】'}]);
    process = env.master.getSheetByName(names.process).getRange(2, 1, 1, 40).getValues()[0];
    index = env.master.getSheetByName(names.fileIndex).getRange(2, 1, 1, 13).getValues()[0];
    assert.equal(process[16], 'VALIDATING'); assert.equal(index[3], 'VALIDATING');
  });

  test('process log keeps submitted content hash immutable and persists run counts', () => {
    setup(); createProcess();
    assert.throws(() => gas.call('updateProcessLog', ['file1', {submittedContentHash: 'x'.repeat(64)}]));
    gas.call('incrementRunTransactionCount', ['RUN_1', 3]); gas.call('incrementRunTransactionCount', ['RUN_1', 2]);
    assert.equal(gas.call('getRunCumulativeTransactionCount', ['RUN_1']), 5);
  });

  test('file transitions apply whitelist and compare-and-set, then rename from immutable original name', () => {
    const env = setup(); createProcess();
    gas.call('transitionFileState', ['file1', 'DISCOVERED', 'VALIDATING', 'RUN_1']);
    assert.equal(gas.stubs.getFile('file1').getName(), '【処理中】明細.csv');
    assert.equal(env.master.getSheetByName(names.process).getRange(2, 17).getValue(), 'VALIDATING');
    assert.throws(() => gas.call('transitionFileState', ['file1', 'DISCOVERED', 'WRITING', 'RUN_1']));
  });

  test('INV-19: tryLock false prevents lease acquisition and no ACTIVE row is written', () => {
    const env = setup(); gas.stubs.getScriptLock().setTryLockResults([false]);
    assert.throws(() => gas.call('acquireLease', ['C001', 'file1', 'RUN_1', 'reviewer@example.com', 'PROCESS']), (error) => error.code === 'LEASE_CONFLICT');
    assert.equal(env.master.getSheetByName(names.lease).getLastRow(), 1);
  });

  test('INV-20: release deletes ACTIVE lease and appends LEASE_RELEASE audit row', () => {
    const env = setup(); createProcess('VALIDATING');
    const leaseId = gas.call('acquireLease', ['C001', 'file1', 'RUN_1', 'reviewer@example.com', 'PROCESS']);
    assert.equal(gas.call('verifyActiveLease', [leaseId, 'RUN_1']), true);
    gas.call('releaseLease', ['file1', 'RUN_1', 'done']);
    assert.equal(env.master.getSheetByName(names.lease).getLastRow(), 1);
    assert.equal(env.master.getSheetByName(names.audit).getRange(3, 3).getValue(), 'LEASE_RELEASE');
  });

  test('lease conflict reports duplicate ownership and write assertion rejects the wrong lease', () => {
    setup(); const leaseId = gas.call('acquireLease', ['C001', 'file1', 'RUN_1', 'reviewer@example.com', 'WRITE_ONLY']);
    assert.throws(() => gas.call('acquireLease', ['C001', 'file1', 'RUN_2', 'other@example.com', 'PROCESS']), (error) => error.code === 'LEASE_CONFLICT');
    assert.doesNotThrow(() => gas.call('assertLeaseHeldForWrite', ['file1', leaseId]));
    assert.throws(() => gas.call('assertLeaseHeldForWrite', ['file1', 'LEASE_WRONG']), (error) => error.code === 'LEASE_CONFLICT');
  });

  test('stalled lease detection and administrator force release honor state, heartbeat, and audit requirements', () => {
    const env = setup(); createProcess('VALIDATING');
    const leaseId = gas.call('acquireLease', ['C001', 'file1', 'RUN_1', 'reviewer@example.com', 'PROCESS']);
    env.master.getSheetByName(names.lease).getRange(2, 8).setValue('2000-01-01T00:00:00+09:00');
    const stalled = plain(gas.call('detectStalledLeases'));
    assert.equal(stalled.length, 1); assert.equal(stalled[0].leaseId, leaseId);
    assert.throws(() => gas.call('forceReleaseLease', [leaseId, 'recovery', 'reviewer@example.com']));
    gas.call('forceReleaseLease', [leaseId, 'recovery', 'admin@example.com']);
    assert.equal(env.master.getSheetByName(names.lease).getLastRow(), 1);
    assert.equal(env.master.getSheetByName(names.audit).getRange(3, 3).getValue(), 'LEASE_FORCE_RELEASE');
  });

  test('INV-42: learned dictionary rows require and store normalizeMerchant(original)', () => {
    const env = setup();
    assert.throws(() => gas.call('learnFromResolution', ['C001', 'ドンキホーテ', 'ドンキホーテ', 'ドン・キホーテ', 'reviewer@example.com']));
    const normalized = gas.call('normalizeMerchant', ['ドンキホーテ']);
    const id = gas.call('learnFromResolution', ['C001', 'ドンキホーテ', normalized, 'ドン・キホーテ', 'reviewer@example.com']);
    const row = env.master.getSheetByName(names.customerDict).getRange(2, 1, 1, 18).getValues()[0];
    assert.equal(row[0], id); assert.equal(row[2], normalized); assert.equal(row[14], true);
  });

  test('INV-02: dictionary conflict detection normalizes string TRUE active flags', () => {
    const env = setup(); const sheet = env.master.getSheetByName(names.customerDict);
    sheet.appendRow(['D1', '店', '店', '取引先A', 'exact_normalized', '', 'C001', '', '', 'FALSE', 'a', '', '2026', 1, 'TRUE', 'FALSE', '', '']);
    sheet.appendRow(['D2', '店', '店', '取引先B', 'exact_normalized', '', 'C001', '', '', 'FALSE', 'a', '', '2026', 1, 'TRUE', 'FALSE', '', '']);
    const groups = plain(gas.call('detectDictionaryConflicts', ['CUSTOMER']));
    assert.ok(groups.length >= 1); assert.equal(sheet.getRange(2, 16).getValue(), true); assert.equal(sheet.getRange(3, 16).getValue(), true);
  });

  test('dictionary promotion writes common scope only through an explicit approver', () => {
    const env = setup(); const normalized = gas.call('normalizeMerchant', ['店舗A']);
    const id = gas.call('learnFromResolution', ['C001', '店舗A', normalized, '取引先A', 'reviewer@example.com']);
    assert.throws(() => gas.call('promoteToCommon', [id, '']));
    gas.call('promoteToCommon', [id, 'owner@example.com']);
    const row = env.master.getSheetByName(names.commonDict).getRange(2, 1, 1, 18).getValues()[0];
    assert.equal(row[0], id); assert.equal(row[2], normalized); assert.equal(row[14], true);
  });

  test('destination index reads the full header range in value and formula modes and indexes complete IDs', () => {
    setup(); const customer = gas.call('getCustomerById', ['C001']); const index = gas.call('buildIndex', [customer, {}]);
    assert.deepEqual(plain(gas.call('getRowByTxId', [index, 'TX_EXISTING'])), {matchCount: 1, rowNumber: 3});
    assert.equal(gas.call('isRowEmpty', [index, 2, customer]), true);
    assert.equal(gas.call('isRowEmpty', [index, 3, customer]), false);
    assert.equal(gas.call('isRowEmpty', [index, 4, customer]), true);
    assert.equal(gas.call('getFormulasByRow', [index, 4])[4], '=IF(A4="","",A4)');
  });

  test('destination index splits large ranges at DESTINATION_INDEX_MAX_ROWS without changing results', () => {
    setup(); gas.evaluate('SETTINGS.DESTINATION_INDEX_MAX_ROWS=2');
    const customer = gas.call('getCustomerById', ['C001']); const index = gas.call('buildIndex', [customer, {}]);
    assert.equal(gas.call('getRowByTxId', [index, 'TX_EXISTING']).rowNumber, 3);
    assert.equal(index.valuesByRow.size, 5);
  });

  test('destination index retries transient 429/500/503 failures at most three times', () => {
    setup(); let customer = gas.call('getCustomerById', ['C001']);
    gas.stubs.setSheetsBatchGetFailures([{code: 429}, {code: 503}]);
    assert.equal(gas.call('getRowByTxId', [gas.call('buildIndex', [customer, {}]), 'TX_EXISTING']).rowNumber, 3);
    setup(); customer = gas.call('getCustomerById', ['C001']);
    gas.stubs.setSheetsBatchGetFailures([{code: 500}, {code: 500}, {code: 500}]);
    assert.throws(() => gas.call('buildIndex', [customer, {}]), (error) => error.code === 'TRANSIENT_SHEETS_ERROR');
  });

  test('INV-06/19: row reservation performs no write when its single lock is not acquired', () => {
    const env = setup(); const customer = gas.call('getCustomerById', ['C001']);
    const leaseId = gas.call('acquireLease', ['C001', 'file1', 'RUN_1', 'reviewer@example.com', 'WRITE_ONLY']);
    gas.stubs.getScriptLock().setTryLockResults([false]);
    assert.throws(() => gas.call('reserveDestinationRows', [customer, ['TX_NEW'], 'file1', leaseId]), (error) => error.code === 'LEASE_CONFLICT');
    assert.equal(env.destination.getSheetByName('入力用シート').getRange(2, 30).getValue(), '');
    const result = plain(gas.call('reserveDestinationRows', [customer, ['TX_NEW'], 'file1', leaseId]));
    // 取引IDと行番号の対応で返る。添字一致に頼らせない（4.25）。
    assert.deepEqual(result.reserved, [{txId: 'TX_NEW', rowNumber: 2}]);
    assert.equal(env.destination.getSheetByName('入力用シート').getRange(2, 30).getValue(), 'TX_NEW');
  });

  test('INV-21: audit rows form a GENESIS-rooted chain and verify successfully', () => {
    const env = setup();
    gas.call('appendAudit', [{type: 'SETTING', actor: 'a@example.com', targetType: 'SETTING', targetId: 'S1', before: {x: 1}, after: {x: 2}}]);
    gas.call('appendAudit', [{type: 'SYNC', actor: 'b@example.com', targetType: 'LOG', targetId: 'S2'}]);
    const sheet = env.master.getSheetByName(names.audit);
    assert.equal(sheet.getRange(2, 14).getValue(), 'GENESIS');
    assert.equal(sheet.getRange(3, 14).getValue(), sheet.getRange(2, 15).getValue());
    assert.equal(sheet.getRange(4, 14).getValue(), sheet.getRange(3, 15).getValue());
    assert.deepEqual(plain(gas.call('verifyChain', ['FULL'])), {ok: true, brokenAt: null, verifiedRows: 3});
  });

  test('INV-21/29: a nested concurrent audit append cannot branch the chain', () => {
    const env = setup(); gas.call('appendAudit', [{type: 'SETTING', actor: 'seed', targetType: 'LOG', targetId: 'seed'}]);
    let nestedError = null;
    env.master.getSheetByName(names.audit).setBeforeAppendHook(() => {
      try { gas.call('appendAudit', [{type: 'SYNC', actor: 'nested', targetType: 'LOG', targetId: 'nested'}]); }
      catch (error) { nestedError = error; }
    });
    gas.call('appendAudit', [{type: 'SYNC', actor: 'outer', targetType: 'LOG', targetId: 'outer'}]);
    assert.equal(nestedError && nestedError.code, 'LEASE_CONFLICT');
    assert.equal(env.master.getSheetByName(names.audit).getLastRow(), 4);
    assert.equal(gas.call('verifyChain', ['FULL']).ok, true);
  });

  test('audit batch appends multiple rows under one lock and links every row in order', () => {
    const env = setup(); const before = gas.stubs.getScriptLock().tryCount;
    const ids = plain(gas.call('appendAuditBatch', [[
      {type: 'SYNC', actor: 'a', targetType: 'LOG', targetId: '1'},
      {type: 'SYNC', actor: 'a', targetType: 'LOG', targetId: '2'}
    ]]));
    assert.equal(ids.length, 2); assert.equal(gas.stubs.getScriptLock().tryCount - before, 1);
    const sheet = env.master.getSheetByName(names.audit);
    assert.equal(sheet.getRange(4, 14).getValue(), sheet.getRange(3, 15).getValue());
    assert.equal(gas.call('verifyChain', ['RECENT']).ok, true);
  });

  test('audit corruption is reported without throwing and CHAIN_BREAK starts a usable new chain', () => {
    const env = setup(); gas.call('appendAudit', [{type: 'SETTING', actor: 'a', targetType: 'LOG', targetId: 'x'}]);
    env.master.getSheetByName(names.audit).getRange(3, 15).setValue('0'.repeat(64));
    const check = plain(gas.call('verifyChain', ['FULL'])); assert.equal(check.ok, false); assert.equal(check.brokenAt.rowNumber, 3);
    gas.call('appendChainBreak', [check.brokenAt, check.brokenAt.expected, check.brokenAt.actual, 'admin@example.com']);
    gas.call('appendAudit', [{type: 'SYNC', actor: 'a', targetType: 'LOG', targetId: 'after'}]);
    assert.equal(gas.call('verifyChain', ['FULL']).ok, true);
  });

  test('INV-03/02: transaction lookup uses complete ID plus normalized active TRUE and rejects ambiguity', () => {
    const env = setup(); gas.call('registerPrepared', [[txFixture()], 'RUN_1']);
    env.master.getSheetByName(names.transaction).getRange(2, 42).setValue('TRUE');
    assert.equal(gas.call('getTransaction', ['TX_001']).fullTxId, 'TX_001');
    const duplicate = env.master.getSheetByName(names.transaction).getRange(2, 1, 1, 45).getValues()[0];
    duplicate[44] = 'later'; env.master.getSheetByName(names.transaction).appendRow(duplicate);
    assert.throws(() => gas.call('getTransaction', ['TX_001']), (error) => error.code === 'TRANSACTION_LOG_AMBIGUOUS');
    env.master.getSheetByName(names.transaction).getRange(3, 42).setValue('FALSE');
    assert.equal(gas.call('getTransaction', ['TX_001'])._rowNumber, 2);
  });

  test('transaction status transition uses whitelist and compare-and-set', () => {
    setup(); gas.call('registerPrepared', [[txFixture()], 'RUN_1']);
    gas.call('updateTransactionStatus', ['TX_001', 'PREPARED', 'WRITING']);
    assert.equal(gas.call('getTransaction', ['TX_001']).transactionStatus, 'WRITING');
    assert.throws(() => gas.call('updateTransactionStatus', ['TX_001', 'PREPARED', 'COMMITTED']));
    assert.throws(() => gas.call('updateTransactionStatus', ['TX_001', 'WRITING', 'DELETED_ACCEPTED']));
  });

  test('INV-01: planned and verified destination values are written together in S through AB', () => {
    const env = setup(); gas.call('registerPrepared', [[txFixture()], 'RUN_1']);
    const planned = {b: '2026-02-01', f: 'P', i: 'I', k: 'K', m: 200}; const verified = {...planned};
    gas.call('updateWrittenValues', ['TX_001', planned, verified]);
    assert.deepEqual(env.master.getSheetByName(names.transaction).getRange(2, 19, 1, 10).getValues()[0],
      ['2026-02-01', 'P', 'I', 'K', 200, '2026-02-01', 'P', 'I', 'K', 200]);
  });

  test('registerPrepared is idempotent for an already active transaction and required fields validate', () => {
    const env = setup(); const fixture = txFixture();
    gas.call('registerPrepared', [[fixture], 'RUN_1']); gas.call('registerPrepared', [[fixture], 'RUN_2']);
    assert.equal(env.master.getSheetByName(names.transaction).getLastRow(), 2);
    assert.deepEqual(plain(gas.call('validateRequiredFields', [gas.call('getTransaction', ['TX_001'])])), {ok: true, missing: []});
    env.master.getSheetByName(names.transaction).getRange(2, 40).setValue('');
    assert.deepEqual(plain(gas.call('validateRequiredFields', [env.master.getSheetByName(names.transaction).getRange(2, 1, 1, 45).getValues()[0]])),
      {ok: false, missing: ['AN']});
  });

  test('process error retention and category-2 approvals follow W and AK schemas', () => {
    const env = setup(); createProcess(); gas.evaluate('SETTINGS.MAX_ERROR_RECORDS_PER_FILE=2');
    gas.call('recordError', ['file1', {code: 'CSV_PARSE_FAILED', stage: '12', runId: 'RUN_1', customerId: 'C001', fileId: 'file1', occurredAt: '2026-01-01', retryCount: 0, retryable: false}]);
    gas.call('recordError', ['file1', {code: 'CSV_PARSE_FAILED', stage: '12', runId: 'RUN_1', customerId: 'C001', fileId: 'file1', occurredAt: '2026-01-02', retryCount: 0, retryable: false}]);
    gas.call('recordError', ['file1', {code: 'CSV_PARSE_FAILED', stage: '12', runId: 'RUN_1', customerId: 'C001', fileId: 'file1', occurredAt: '2026-01-03', retryCount: 0, retryable: false}]);
    const stored = JSON.parse(env.master.getSheetByName(names.process).getRange(2, 23).getValue());
    assert.equal(stored[0].truncated, true); assert.equal(stored.length, 2);
    const approval = {code: 'COUNT_TOTAL_MISMATCH', approvedBy: 'reviewer@example.com', approvedAt: '2026-01-04', contentHash: 'c'.repeat(64), hashVersion: '3'};
    gas.call('appendCategory2Approval', ['file1', approval]);
    assert.equal(gas.call('hasCategory2Approval', ['file1', approval.code, approval.contentHash, approval.hashVersion]), true);
    gas.evaluate('SETTINGS.MAX_ERROR_RECORDS_PER_FILE=200');
  });

  test('INV-05: freee state and active flag stay synchronized with permanent transaction index', () => {
    const env = setup(); gas.call('registerPrepared', [[txFixture()], 'RUN_1']);
    gas.call('updateFreeeStatus', ['TX_001', 'NOT_IMPORTED', 'IMPORTED', 'BATCH_1']);
    let indexSheet = env.txidx.getSheets()[0];
    assert.equal(env.master.getSheetByName(names.transaction).getRange(2, 13).getValue(), 'IMPORTED');
    assert.equal(indexSheet.getRange(2, 8).getValue(), 'IMPORTED');
    gas.call('supersede', ['TX_001', 'CANCEL_REPROCESS', 'reviewer@example.com']);
    assert.equal(env.master.getSheetByName(names.transaction).getRange(2, 42).getValue(), false);
    assert.equal(indexSheet.getRange(2, 9).getValue(), false);
  });

  test('INV-25: permanent transaction index refuses unbounded queries and scans explicit partitions only', () => {
    setup(); gas.call('registerPrepared', [[txFixture()], 'RUN_1']);
    assert.throws(() => gas.call('queryTxIndex', ['C001', {}]), (error) => error.code === 'INPUT_LIMIT_EXCEEDED');
    const year = Number(gas.call('getTransaction', ['TX_001']).registeredAt.slice(0, 4));
    const rows = plain(gas.call('queryTxIndex', ['C001', {years: [year], active: true}]));
    assert.equal(rows.length, 1); assert.equal(rows[0].fullTxId, 'TX_001');
  });

  test('INV-26: planned derived columns do not depend on the active user', () => {
    setup(); gas.stubs.setActiveUser('first@example.com'); gas.call('registerPrepared', [[txFixture()], 'RUN_1']);
    const first = plain(gas.call('getTransaction', ['TX_001']).planned);
    setup(); gas.stubs.setActiveUser('second@example.com'); gas.call('registerPrepared', [[txFixture()], 'RUN_2']);
    const second = plain(gas.call('getTransaction', ['TX_001']).planned);
    assert.deepEqual(second, first);
  });

  test('transaction index capacity is measured independently from the master spreadsheet', () => {
    setup(); gas.call('registerPrepared', [[txFixture()], 'RUN_1']);
    const capacity = plain(gas.call('measureTxIndexCapacity'));
    assert.ok(capacity.cells > 0); assert.equal(capacity.limit, 10000000);
  });
};

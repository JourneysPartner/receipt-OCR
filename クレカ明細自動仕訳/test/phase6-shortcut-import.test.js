'use strict';

const fs = require('node:fs');
const vm = require('node:vm');

module.exports = ({test, assert, gas}) => {
  const SHEET = 'application/vnd.google-apps.spreadsheet';
  const SHORTCUT = 'application/vnd.google-apps.shortcut';
  const EXCEL = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const FOLDER = 'application/vnd.google-apps.folder';
  const call = (name, ...args) => gas.call(name, args);
  const plain = value => JSON.parse(JSON.stringify(value));
  const old = () => new Date(Date.now() - 86400000);
  function mock(target, overrides, fn) {
    const saved = {};
    Object.keys(overrides).forEach(key => { saved[key] = target[key]; target[key] = overrides[key]; });
    try { return fn(); } finally { Object.assign(target, saved); }
  }
  function grid() {
    return [['架空日付', '架空店名', '架空金額', '架空用途'],
      ['2025/12/01', 'FAKE_SHOP', 100, 'FAKE_PURPOSE'],
      ['2025/12/02', 'FAKE_SHOP', 200, 'FAKE_PURPOSE'],
      ['2026/01/01', 'FAKE_SHOP', 300, 'FAKE_PURPOSE'],
      ['2026/01/02', 'FAKE_SHOP', 400, 'FAKE_PURPOSE'],
      ['2026/01/03', 'FAKE_SHOP', 500, 'FAKE_PURPOSE']];
  }
  function formatRow() {
    const row = Array(35).fill('');
    Object.assign(row, {0: 'sc_format_fake', 1: '架空形式', 2: 'active', 3: 'TRUE', 4: '["xlsx"]',
      5: JSON.stringify({allOf: [{maxRow: 1, keywords: grid()[0], minMatch: 4}]}),
      6: 1, 7: 2, 8: 'A', 9: 'B', 10: 'C', 11: 'D',
      14: JSON.stringify({excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []}),
      16: JSON.stringify({sources: [{id: 'fake-billing', kind: 'fileName', pattern: '(20\\d{2})(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}]}),
      17: 'generic', 18: 1, 19: 'sc-operator@example.invalid', 21: '2026-01-01T00:00:00+09:00',
      29: 'NEW', 33: '2026-01-01T00:00:00+09:00'});
    return row;
  }
  const master = () => gas.stubs.getSpreadsheet('sc-master-fake');
  const destination = () => gas.stubs.getSpreadsheet('sc-dest-fake').getSheetByName('架空入力');
  const written = () => plain(destination().getDataRange().getValues().slice(1).filter(row => row[6] !== ''));
  const txs = id => plain(call('getTransactionsForFile_', id || 'sc-shortcut-fake'));
  const reviews = () => plain(call('openReviews', {}));
  const sourceSheet = (id = 'sc-target-fake') => gas.stubs.getSpreadsheet(id).getSheets()[0];
  function world(fiscalYear = 2026, category = 'CORPORATE', row = formatRow()) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('sc-master-fake');
    gas.stubs.setActiveSpreadsheet('sc-master-fake');
    gas.stubs.setActiveUser('sc-operator@example.invalid');
    gas.stubs.setSpreadsheetOwner('sc-master-fake', 'sc-operator@example.invalid');
    call('setMasterSpreadsheetId', 'sc-master-fake'); call('provisionMasterSheets'); call('resetApiReadWindow_');
    master().getSheetByName('カード形式マスター').appendRow(row);
    const dictionary = Array(18).fill('');
    Object.assign(dictionary, {0: 'SC_DICT_FAKE', 1: 'FAKE_SHOP', 2: 'FAKE_SHOP', 3: 'FAKE_PARTNER',
      4: 'exact_original', 5: 1, 9: 'TRUE', 10: 'sc-operator@example.invalid',
      12: '2026-01-01T00:00:00+09:00', 13: 1, 14: 'TRUE', 15: 'FALSE'});
    master().getSheetByName('共通取引先辞書').appendRow(dictionary);
    gas.stubs.createSpreadsheet('sc-dest-fake', {sheets: [
      {name: '架空入力', values: [['', '利用日', '取引先', '用途', '元店名', '金額', '内部ID']], maxRows: 30, maxColumns: 7},
      {name: '取引先一覧', values: [['元表記', '取引先名'], ['FAKE_SHOP', 'FAKE_PARTNER']]}
    ]});
    gas.stubs.createSpreadsheet('sc-index-fake'); gas.stubs.createSpreadsheet('sc-snapshot-fake');
    gas.stubs.createFolder('sc-dest-parent-fake', {fileIds: ['sc-dest-fake']});
    gas.evaluate("SETTINGS.EXECUTION_TIMEOUT_SECONDS=300; SETTINGS.SAFETY_MARGIN_SECONDS=60;" +
      "SETTINGS.TX_INDEX_SPREADSHEET_ID='sc-index-fake'; SETTINGS.SNAPSHOT_SPREADSHEET_ID='sc-snapshot-fake';" +
      "SETTINGS.SAMPLE_CORPUS_FOLDER_ID='sc-corpus-fake'; SETTINGS.PARALLEL_WORK_FOLDER_ID=''; SETTINGS.FAULT_INJECTION=null;");
    call('registerTestCustomer', {customerId: 'SC_FAKE', customerName: '架空顧客', sourceFolderId: 'sc-root-fake',
      destinationSpreadsheetId: 'sc-dest-fake', destinationSheetName: '架空入力',
      columns: {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7}, headerRow: 1, dataStartRow: 2, rowScanLastColumn: 7});
    master().getSheetByName('顧客マスター').getRange(2, 36, 1, 2).setValues([[category, fiscalYear]]);
    gas.stubs.createFolder('sc-root-fake', {name: '架空ルート', subFolderIds: ['sc-card-fake']});
    const folder = gas.stubs.createFolder('sc-card-fake', {name: 'FAKE_CARD'});
    gas.stubs.createFolder('sc-outside-fake', {name: '架空過年度'});
    return folder;
  }
  function addSheet(folder, id = 'sc-target-fake', values = grid()) {
    gas.stubs.createSpreadsheet(id, {sheets: [{name: 'FAKE_SHEET', values, maxRows: values.length, maxColumns: values[0].length}]});
    const file = gas.stubs.createFile(id, {name: 'TARGET_202601', contentType: SHEET, lastUpdated: old()});
    if (folder) folder.fileIds.push(id);
    return file;
  }
  function shortcut(folder, id = 'sc-shortcut-fake', targetId = 'sc-target-fake', targetMimeType = SHEET, name = '【済】FAKE_202601') {
    const file = gas.stubs.createFile(id, {name, contentType: SHORTCUT, targetId, targetMimeType, lastUpdated: old()});
    if (folder) folder.fileIds.push(id);
    return file;
  }
  function setup(values = grid(), fiscalYear = 2026, row = formatRow()) {
    const folder = world(fiscalYear, 'CORPORATE', row);
    const target = addSheet(gas.stubs.createFolder('sc-outside-fake', {name: '架空過年度'}), 'sc-target-fake', values);
    const file = shortcut(folder);
    return {folder, target, file};
  }
  function outcome(report, id = 'sc-shortcut-fake') {
    assert.equal(report.stoppedBy, null, JSON.stringify(report));
    const result = report.customers.flatMap(c => c.files).find(file => file.fileId === id);
    assert.ok(result, JSON.stringify(report)); return plain(result);
  }
  const run = () => plain(call('runImport', {}));
  function direct(file, options = {}) {
    const candidate = {fileId: file.id, name: file.name, modifiedTime: old().toISOString(), revisionId: null, folderName: 'FAKE_CARD'};
    return plain(call('processDiscoveredFile_', 'sc-run-fake', call('getCustomerById', 'SC_FAKE'), candidate, options));
  }
  function noTargetWrites(target, fn) {
    let renames = 0;
    const result = mock(target, {setName() { renames++; throw new Error('Fake forbidden target rename'); },
      getBlob() { assert.fail('target blob must never run'); }}, fn);
    assert.equal(renames, 0, 'target setName must never run, including caught failures');
    return result;
  }
  function reconcile(customer, rows, fileId) {
    const result = plain(call('finalReviewReconcile_', customer,
      rows.map((row, index) => ({rowNumber: index + 2, txId: row[6], amount: row[5]})), [fileId]));
    assert.deepEqual(result.problems, []); assert.equal(result.totals.balanced, true);
    assert.equal(result.files.length, 1); return result.files[0];
  }

  test('sc 1: only Sheets shortcut targets are importable regardless of name', () => {
    world();
    for (const name of ['FAKE', '【済】FAKE', 'FAKE.pdf']) assert.equal(call('isImportableDriveFile', name, SHORTCUT, SHEET), true);
    for (const mime of [EXCEL, 'text/csv', 'application/pdf', FOLDER, 'application/vnd.google-apps.document', SHORTCUT, null, '']) {
      assert.equal(call('isImportableDriveFile', 'FAKE.xlsx', SHORTCUT, mime), false, String(mime));
    }
    for (const [name, mime, expected] of [['FAKE', SHEET, true], ['FAKE.csv', 'text/csv', true],
      ['FAKE.XLSX', EXCEL, true], ['FAKE.csv', FOLDER, false], ['FAKE.csv', 'application/vnd.google-apps.document', false], ['FAKE.pdf', 'application/pdf', false]]) {
      for (const target of [SHEET, null, EXCEL]) assert.equal(call('isImportableDriveFile', name, mime, target), expected);
    }
  });

  test('sc 2: scanner keeps shortcut identity and never descends into folder targets', () => {
    const {folder, target, file} = setup();
    const second = shortcut(folder, 'sc-second-fake', target.id, SHEET, '【翌年分】FAKE_202601');
    const normal = addSheet(folder, 'sc-normal-fake');
    for (const [id, mime] of [['folder', FOLDER], ['pdf', 'application/pdf'], ['excel', EXCEL]]) shortcut(folder, 'sc-' + id + '-fake', 'sc-outside-fake', mime);
    const requests = [], list = gas.context.Drive.Files.list, classify = gas.context.isImportableDriveFile;
    const candidates = mock(gas.context, {isImportableDriveFile(...args) {
      assert.equal(args.length, args[1] === SHORTCUT ? 3 : 2); return classify(...args);
    }}, () => mock(gas.context.Drive.Files, {list(request) { requests.push(request); return list(request); }}, () => plain(call('scanUnprocessedFiles', 'SC_FAKE'))));
    assert.deepEqual(candidates.map(c => c.fileId).sort(), [file.id, second.id, normal.id].sort());
    const found = candidates.find(c => c.fileId === file.id);
    assert.equal(found.name, file.name); assert.equal(found.folderName, 'FAKE_CARD');
    assert.equal(found.targetId, target.id); assert.equal(found.modifiedTime, target.lastUpdated.toISOString()); assert.equal(found.revisionId, null);
    assert.equal(candidates.find(c => c.fileId === normal.id).targetId, null);
    assert.ok(requests.every(r => r.fields.includes('shortcutDetails(targetId,targetMimeType)')));
  });

  test('sc 3: scanner uses target age and skips metadata for completed shortcuts', () => {
    const {target, file} = setup(); const now = new Date(); const api = gas.context.Drive.Files, get = api.get;
    let reads = 0;
    mock(api, {get(...args) { reads++; return get(...args); }}, () => {
      target.lastUpdated = new Date(now - 300000);
      assert.equal(call('scanUnprocessedFiles', 'SC_FAKE', {now}).length, 0);
      target.lastUpdated = old(); file.lastUpdated = new Date(now - 60000);
      assert.equal(call('scanUnprocessedFiles', 'SC_FAKE', {now}).length, 1);
      call('createOrUpdateProcessLog', 'sc-run-fake', call('getCustomerById', 'SC_FAKE'), {id: file.id, state: 'COMPLETED'});
      assert.equal(call('scanUnprocessedFiles', 'SC_FAKE', {now}).length, 0);
    });
    assert.equal(reads, 2);
  });

  test('sc 3: missing target metadata falls back and transient gets are counted and retried', () => {
    const {target, file} = setup(); const api = gas.context.Drive.Files, get = api.get;
    const error = code => Object.assign(new Error('Fake metadata failure'), {code});
    mock(api, {get() { throw error(404); }}, () => {
      const candidates = call('scanUnprocessedFiles', 'SC_FAKE');
      assert.equal(candidates.length, 1); assert.equal(candidates[0].modifiedTime, file.lastUpdated.toISOString());
    });
    for (const code of [429, 500, 503]) {
      let attempts = 0; const requests = [];
      call('resetDriveScannerCallCount');
      const candidates = mock(api, {get(id, request) { requests.push(request); if (++attempts < 3) throw error(code); return get(id, request); }}, () => call('scanUnprocessedFiles', 'SC_FAKE'));
      assert.equal(candidates.length, 1); assert.equal(attempts, 3); assert.equal(call('getDriveScannerCallCount'), 5);
      assert.equal(candidates[0].modifiedTime, target.lastUpdated.toISOString());
      assert.ok(requests.every(r => r.supportsAllDrives && r.fields.includes('modifiedTime') && r.fields.includes('headRevisionId')));
    }
    target.lastUpdated = new Date();
    mock(api, {get() { throw error(403); }}, () => assert.equal(call('scanUnprocessedFiles', 'SC_FAKE').length, 1));
  });

  test('sc 4: reader hashes the target before opening with no shortcut blob or conversion', () => {
    const {target, file} = setup(); const expected = call('readFile', target.id, target.name);
    const order = [], api = gas.context.Sheets.Spreadsheets, get = api.get, app = gas.context.SpreadsheetApp, open = app.openById;
    const beforeReads = gas.evaluate('apiReadCount_'); let paced = 0; const pace = gas.context.paceSheetsRead_;
    const ids = gas.stubs.getSpreadsheetIds().sort();
    const read = noTargetWrites(target, () => mock(file, {getBlob() { assert.fail('shortcut blob'); }}, () =>
      mock(gas.context, {paceSheetsRead_() { paced++; return pace(); }, convertXlsxToTemp() { assert.fail('shortcut conversion'); }}, () =>
        mock(api, {get(id, request) { if (id === target.id) order.push('hash'); return get(id, request); }}, () =>
          mock(app, {openById(id) { assert.notEqual(id, file.id); if (id === target.id) order.push('open'); return open(id); }}, () => call('readFile', file.id, file.name))))));
    assert.deepEqual(order, ['hash', 'open']); assert.equal(paced, 1); assert.equal(gas.evaluate('apiReadCount_') - beforeReads, 1);
    assert.deepEqual(plain(read.sheets), plain(expected.sheets));
    assert.equal(read.fileType, 'xlsx'); assert.equal(read.sourceKind, 'SHORTCUT'); assert.equal(read.targetId, target.id);
    assert.equal(read.bytes, null); assert.equal(read.encoding, null);
    assert.equal(read.binaryHash, call('currentFileBinaryHash', file.id)); assert.equal(read.binaryHash, call('currentFileBinaryHash', target.id));
    assert.deepEqual(gas.stubs.getSpreadsheetIds().sort(), ids);
  });

  test('sc 4: trashed and non-Sheets targets fail before target content access', () => {
    const {target, file} = setup();
    for (const fn of [() => call('readFile', file.id, file.name), () => call('currentFileBinaryHash', file.id)]) {
      target.trashed = true;
      mock(gas.context.Sheets.Spreadsheets, {get() { assert.fail('no Sheets read'); }}, () =>
        mock(gas.context.SpreadsheetApp, {openById() { assert.fail('no open'); }}, () =>
          assert.throws(fn, e => e.code === 'SHORTCUT_TARGET_TRASHED')));
      target.trashed = false; file.targetMimeType = EXCEL;
      mock(gas.context.DriveApp, {getFileById(id) { assert.equal(id, file.id); return file; }}, () =>
        assert.throws(fn, e => e.name === 'TypeError'));
      file.targetMimeType = SHEET;
    }
  });

  test('sc 5: corporate import logs all five and writes only three without touching target', () => {
    const {target, file} = setup(); const name = target.name, values = plain(sourceSheet().values);
    const hash = call('currentFileBinaryHash', target.id); const api = gas.context.Sheets.Spreadsheets, get = api.get; let reads = 0;
    const result = noTargetWrites(target, () => mock(api, {get(id, request) { if (id === target.id && request.includeGridData) reads++; return get(id, request); }}, () => outcome(run())));
    assert.equal(result.outcome, 'WRITTEN'); assert.equal(result.nextState, 'COMPLETED'); assert.equal(result.written, 3);
    assert.deepEqual(result.priorYearExcluded, {count: 2, fiscalYear: 2026}); assert.equal(reads, 2);
    assert.deepEqual(written().map(r => [call('toTokyoDateString_', new Date(r[1])), r[5]]), [['2026-01-01', 300], ['2026-01-02', 400], ['2026-01-03', 500]]);
    const rows = txs(); assert.equal(rows.length, 5);
    assert.equal(rows.filter(t => t.transactionStatus === 'COMMITTED').length, 3);
    const excluded = rows.filter(t => t.transactionStatus === 'CANCELED'); assert.equal(excluded.length, 2);
    for (const tx of excluded) {
      assert.equal(tx.plannedFinalStatus, 'CANCELED'); assert.equal(tx.partnerResolutionStatus, 'RESOLVED_WITHOUT_PARTNER');
      assert.equal(tx.planned.f, ''); assert.equal(tx.planned.m, tx.originalAmount); assert.ok(tx.planned.b.startsWith('2025-'));
      assert.ok(tx.identityHash); assert.deepEqual(tx._values.slice(28, 31), ['', '', '']); assert.equal(tx.active, true);
    }
    const indexes = gas.stubs.getSpreadsheet('sc-index-fake').getSheets().flatMap(s => s.getDataRange().getValues().slice(1));
    assert.equal(indexes.length, 5); assert.ok(indexes.every(r => r[2] === file.id && r[8] === true));
    const process = call('getProcessLogRecord_', file.id), permanent = call('getPermanentFileIndexRecord_', file.id);
    assert.equal(process.values[7], file.id); assert.equal(permanent.values[0], file.id);
    assert.equal(process.values[11], hash); assert.equal(permanent.values[4], hash); assert.equal(process.values[17], 5); assert.equal(process.values[20], 1);
    assert.equal(file.name, '【済】FAKE_202601'); assert.equal(target.name, name); assert.deepEqual(plain(sourceSheet().values), values);
    assert.deepEqual(reviews(), []);
  });

  for (const matching of [true, false]) test('sc 6: reconciliation uses all transactions with printed ' + (matching ? 'full' : 'remaining') + ' totals', () => {
    const row = formatRow(); row[15] = JSON.stringify({count: {source: 'labeledRow', label: 'FAKE_COUNT', labelColumn: 'E', valueColumn: 'F'},
      total: {source: 'labeledRow', label: 'FAKE_TOTAL', labelColumn: 'G', valueColumn: 'H'}, totalScope: 'all'});
    const values = grid(); values[0].push('FAKE_COUNT', matching ? 5 : 3, 'FAKE_TOTAL', matching ? 1500 : 1200);
    setup(values, 2026, row); const result = outcome(run());
    assert.equal(result.code, matching ? null : 'COUNT_TOTAL_MISMATCH'); assert.equal(result.outcome, matching ? 'WRITTEN' : 'NO_WRITE');
    if (!matching) { assert.equal(txs().length, 0); assert.equal(written().length, 0); }
  });

  test('sc 7: all excluded completes with canceled logs and appears balanced in final review', () => {
    const values = grid().slice(0, 3); const {target, file} = setup(values);
    const result = noTargetWrites(target, () => outcome(run()));
    assert.equal(result.nextState, 'COMPLETED'); assert.equal(result.written, 0); assert.equal(written().length, 0);
    assert.deepEqual(result.priorYearExcluded, {count: 2, fiscalYear: 2026}); assert.equal(txs().length, 2);
    assert.ok(txs().every(tx => tx.transactionStatus === 'CANCELED')); assert.deepEqual(reviews(), []); assert.equal(file.name, '【済】FAKE_202601');
    const summary = reconcile(call('getCustomerById', 'SC_FAKE'), [], file.id);
    assert.equal(summary.statement, 300); assert.equal(summary.excluded, 300); assert.equal(summary.written, 0); assert.equal(summary.residual, 0);
  });

  test('sc 5: one registration counts all rows but purpose revision checks only remaining identities', () => {
    setup(); const context = gas.context; const counts = [], increments = [], registrations = [], sequences = [];
    const limit = context.checkRunTransactionLimit, increment = context.incrementRunTransactionCount;
    const register = context.registerPrepared, revision = context.checkPurposeRevisionCandidate;
    const result = mock(context, {
      checkRunTransactionLimit(id, count) { counts.push(count); return limit(id, count); },
      incrementRunTransactionCount(id, count) { increments.push(count); return increment(id, count); },
      registerPrepared(...args) { registrations.push(args); return register(...args); },
      checkPurposeRevisionCandidate(...args) { sequences.push(args[1].length); return revision(...args); }
    }, () => outcome(run()));
    assert.equal(result.nextState, 'COMPLETED'); assert.deepEqual(counts, [5]); assert.deepEqual(increments, [5]);
    assert.equal(registrations.length, 1); assert.equal(registrations[0][0].length, 5);
    assert.equal(registrations[0][3].purposeRevision.identityHashes.length, 3);
    assert.deepEqual(sequences, [3, 3]);
  });

  test('sc 5: zero exclusions still report zero without adding an empty exclusion argument', () => {
    const values = grid(); setup([values[0], ...values.slice(3)]);
    const process = gas.context.processFile; let seen = 0;
    const result = mock(gas.context, {processFile(input) {
      seen++; assert.equal(Object.hasOwn(input, 'excludedTransactions'), false); return process(input);
    }}, () => outcome(run()));
    assert.equal(seen, 1); assert.deepEqual(result.priorYearExcluded, {count: 0, fiscalYear: 2026}); assert.equal(result.written, 3);
  });

  test('sc 8: unresolved year and out-of-range dates remain reviewable instead of excluded', () => {
    const values = grid(); values[1][0] = '07/01'; values[2][0] = '2022/12/02';
    setup(values); const result = outcome(run());
    assert.deepEqual(result.priorYearExcluded, {count: 0, fiscalYear: 2026});
    const rows = txs(); assert.equal(rows.length, 5); assert.equal(rows.filter(t => t.transactionStatus === 'CANCELED').length, 0);
    for (const sourceRow of [2, 3]) {
      const tx = rows.find(t => t.sourceRow === sourceRow); assert.equal(tx.planned.b, ''); assert.equal(tx.transactionStatus, 'REVIEW_REQUIRED');
      assert.ok(reviews().some(r => r.fullTxId === tx.fullTxId && r.reviewType === 'DATE'));
    }
  });

  test('sc 8: future blanked date remains even when its year is below AK', () => {
    const values = grid().slice(0, 2); values[1][0] = '2026/01/02';
    const {file} = setup(values, 2027); const result = direct(file, {now: new Date('2026-01-01T00:00:00Z')});
    assert.deepEqual(result.priorYearExcluded, {count: 0, fiscalYear: 2027}); assert.equal(txs().length, 1);
    assert.equal(txs()[0].planned.b, ''); assert.equal(txs()[0].transactionStatus, 'REVIEW_REQUIRED'); assert.equal(reviews()[0].reviewType, 'DATE');
  });

  test('sc 8: uniquely inferred prior year is excluded and Tokyo year boundary is retained', () => {
    const values = grid(); values[1][0] = '12/01'; values[3][0] = new Date('2025-12-31T15:00:00Z');
    setup(values); const result = outcome(run());
    assert.deepEqual(result.priorYearExcluded, {count: 2, fiscalYear: 2026}); assert.equal(result.written, 3);
    assert.equal(txs().find(t => t.sourceRow === 2).transactionStatus, 'CANCELED');
    assert.equal(call('toTokyoDateString_', new Date(written()[0][1])), '2026-01-01');
  });

  for (const remaining of [false, true]) test('sc 9: missing purpose on ' + (remaining ? 'remaining' : 'excluded') + ' rows only', () => {
    const values = grid(); values[1][3] = ''; if (remaining) values[3][3] = '';
    setup(values); const result = outcome(run());
    assert.equal(result.nextState, remaining ? 'CUSTOMER_FIX_REQUIRED' : 'COMPLETED');
    assert.equal(result.outcome, remaining ? 'NO_WRITE' : 'WRITTEN');
    if (remaining) { assert.deepEqual(result.customerFix.reasons.find(r => r.kind === 'PURPOSE_EMPTY').rows, [4]); assert.equal(txs().length, 0); }
  });

  for (const category of ['CORPORATE', 'INDIVIDUAL']) test('sc 10: ordinary Sheets retain prior year behavior for ' + category, () => {
    const folder = world(2026, category); addSheet(folder); const result = outcome(run(), 'sc-target-fake');
    assert.equal(result.written, 5); assert.equal(Object.hasOwn(result, 'priorYearExcluded'), false);
    const rows = txs('sc-target-fake'); assert.equal(rows.length, 5); assert.equal(rows.filter(t => t.transactionStatus === 'CANCELED').length, 0);
    assert.equal(reviews().filter(r => r.reviewType === 'PRIOR_YEAR').length, category === 'INDIVIDUAL' ? 2 : 0);
  });

  for (const fiscal of [null, '2026', 1999, 3000, 2026.5]) test('sc 11: invalid AK ' + JSON.stringify(fiscal) + ' fails after registration before detection', () => {
    const {folder, file} = setup(grid(), fiscal); const detect = gas.context.detectFormatWith; const originalName = file.name; let shortcutDetected = false;
    addSheet(folder, 'sc-normal-fake');
    const report = mock(gas.context, {detectFormatWith(...args) { if (args[3] === originalName) shortcutDetected = true; return detect(...args); }}, run);
    const result = outcome(report); assert.equal(result.outcome, 'FAILED'); assert.equal(result.nextState, 'FAILED');
    assert.equal(result.errorCode, 'SHORTCUT_FISCAL_YEAR_REQUIRED'); assert.equal(shortcutDetected, false);
    assert.ok(call('getProcessLogRecord_', file.id)); assert.ok(call('getPermanentFileIndexRecord_', file.id));
    assert.equal(txs().length, 0); assert.equal(reviews().filter(r => r.fileId === file.id).length, 0);
    assert.equal(call('activeLeases_').length, 0);
    assert.equal(outcome(report, 'sc-normal-fake').outcome, 'WRITTEN'); assert.equal(written().length, 5);
  });

  for (const when of ['after-values', 'between-hash-and-open', 'trashed', 'hash-failure']) test('sc 12: guardian fails closed for target ' + when, () => {
    const {target} = setup(); const read = gas.context.readFile, api = gas.context.Sheets.Spreadsheets, get = api.get; let reads = 0;
    const result = mock(api, {get(id, request) {
      if (id !== target.id || !request.includeGridData) return get(id, request);
      reads++;
      if (when === 'hash-failure' && reads > 1) throw Object.assign(new Error('Fake denied'), {code: 403});
      const response = get(id, request);
      if (when === 'between-hash-and-open' && reads === 1) sourceSheet().getRange(2, 4).setValue('FAKE_CHANGED');
      return response;
    }}, () => mock(gas.context, {readFile(...args) {
      const value = read(...args);
      if (when === 'after-values') sourceSheet().getRange(2, 4).setValue('FAKE_CHANGED');
      if (when === 'trashed') target.trashed = true;
      return value;
    }}, () => outcome(run())));
    assert.equal(written().length, 0); assert.equal(result.nextState, ['trashed', 'hash-failure'].includes(when) ? 'FAILED' : 'REVIEW_WAIT');
    if (when === 'trashed') assert.equal(result.errorCode, 'SHORTCUT_TARGET_TRASHED');
    if (when === 'after-values' || when === 'between-hash-and-open') assert.equal(result.outcome, 'NO_WRITE');
    assert.equal(call('activeLeases_').length, 0);
  });

  function interrupted() {
    const state = setup();
    const first = mock(gas.context, {runWriteBlock() { throw new Error('Fake interruption before writing'); }}, () => direct(state.file));
    assert.equal(first.outcome, 'FAILED');
    assert.equal(txs().length, 5); assert.equal(txs().filter(t => t.transactionStatus === 'PREPARED').length, 3);
    assert.equal(txs().filter(t => t.transactionStatus === 'CANCELED').length, 2);
    return state;
  }
  test('sc 13: rejoin retains canceled rows and writes each remaining transaction once', () => {
    const {file} = interrupted(); const result = direct(file);
    assert.equal(result.nextState, 'COMPLETED'); assert.equal(result.written, 3); assert.equal(txs().length, 5); assert.equal(written().length, 3);
    assert.equal(new Set(txs().map(t => t.fullTxId)).size, 5);
  });
  for (const direction of ['exclude-prepared', 'retain-canceled']) test('sc 13: exclusion conflict ' + direction + ' fails before registration', () => {
    const {file} = interrupted(); const log = master().getSheetByName('クレカ取引ログ');
    if (direction === 'exclude-prepared') {
      const canceled = txs().find(t => t.transactionStatus === 'CANCELED'); log.getRange(canceled._rowNumber, 10).setValue('PREPARED');
    } else master().getSheetByName('顧客マスター').getRange(2, 37).setValue(2025);
    const before = plain(log.getDataRange().getValues()); let registrations = 0; const register = gas.context.registerPrepared;
    const result = mock(gas.context, {registerPrepared(...args) { registrations++; return register(...args); }}, () => direct(file));
    assert.equal(result.outcome, 'FAILED'); assert.equal(result.errorCode, 'PRIOR_YEAR_EXCLUSION_CONFLICT');
    assert.equal(registrations, 0); assert.deepEqual(plain(log.getDataRange().getValues()), before); assert.equal(written().length, 0);
  });

  for (const kind of ['changed', 'time-only', 'name-only', 'trashed', 'missing']) test('sc 14: rescan uses target metadata for ' + kind, () => {
    const {target, file} = setup(); assert.equal(outcome(run()).nextState, 'COMPLETED');
    const beforeHash = call('currentFileBinaryHash', file.id);
    if (kind === 'changed') sourceSheet().getRange(2, 4).setValue('FAKE_CHANGED');
    if (kind === 'name-only') { file.setName('【済】FAKE_RENAMED'); file.lastUpdated = new Date(); }
    else target.lastUpdated = new Date();
    if (kind === 'trashed') target.trashed = true;
    const api = gas.context.Sheets.Spreadsheets, get = api.get; let reads = 0;
    const drive = gas.context.Drive.Files, metadata = drive.get;
    mock(drive, {get(id, request) { assert.ok(request.fields.includes('trashed')); if (kind === 'missing') throw Object.assign(new Error('Fake missing'), {code: 404}); return metadata(id, request); }}, () =>
      mock(api, {get(id, request) { if (id === target.id && request.includeGridData) reads++; return get(id, request); }}, () => {
        const rescan = call('runProcessedFileRescan', {customerId: 'SC_FAKE', indexRows: call('permanentIndexRowsForScan_'),
          metaById: call('getFileMetadataBatch', [file.id], {folderIds: ['sc-root-fake']}), computeHash: id => call('currentFileBinaryHash', id)});
        assert.equal(rescan.changedCount, kind === 'changed' ? 1 : 0);
        if (['trashed', 'missing'].includes(kind)) assert.equal(rescan.detections[0].reason, 'FILE_NOT_FOUND');
      }));
    assert.equal(reads, ['changed', 'time-only'].includes(kind) ? 1 : 0);
    const changed = reviews().filter(r => r.reviewType === 'FILE_CHANGED'); assert.equal(changed.length, kind === 'changed' ? 1 : 0);
    if (changed.length) { assert.equal(changed[0].fileId, file.id); const detail = JSON.parse(changed[0].detail); assert.equal(detail.oldBinaryHash, beforeHash); assert.equal(detail.newBinaryHash, call('currentFileBinaryHash', target.id)); }
  });

  for (const kind of ['shortcuts', 'normal-first', 'shortcut-first']) test('sc 15: duplicate content blocks second ' + kind + ' before transaction logs', () => {
    const {folder, target, file} = setup();
    if (kind === 'normal-first') { folder.fileIds = [target.id]; target.name = 'NORMAL_202601'; }
    const firstId = kind === 'normal-first' ? target.id : file.id;
    assert.equal(outcome(run(), firstId).nextState, 'COMPLETED'); const before = written(); const count = txs(firstId).length;
    let second;
    if (kind === 'shortcuts') second = shortcut(folder, 'sc-second-fake', target.id, SHEET, 'FAKE_202601');
    else if (kind === 'normal-first') { folder.fileIds.push(file.id); second = file; }
    else second = addSheet(folder, 'sc-second-fake');
    const result = outcome(run(), second.id);
    assert.equal(result.nextState, 'REVIEW_WAIT'); assert.equal(result.code, 'DUPLICATE_CONTENT'); assert.equal(result.outcome, 'NO_WRITE'); assert.equal(result.written, 0);
    assert.deepEqual(written(), before); assert.equal(txs(second.id).length, 0); assert.equal(txs(firstId).length, count);
    assert.equal(reviews().filter(r => r.fileId === second.id && r.reviewType === 'DUPLICATE').length, 1);
  });

  test('sc 16: folder UI follows target age and unsupported targets remain unavailable', () => {
    const {folder, target, file} = setup(); const now = Date.now(); file.lastUpdated = new Date(now - 60000);
    let item = call('webAppFolderFile_', file, {}, now); assert.equal(item.stateLabel, '取込可能'); assert.equal(item.importable, true);
    target.lastUpdated = new Date(now - 300000); file.lastUpdated = old();
    item = call('webAppFolderFile_', file, {}, now); assert.equal(item.stateLabel, '取込待ち（あと 5 分）'); assert.equal(item.importable, false);
    for (const mime of [FOLDER, 'application/pdf', EXCEL]) { const other = shortcut(folder, 'sc-unsupported-fake', target.id, mime); assert.equal(call('webAppFolderFile_', other, {}, now).stateLabel, '対象外'); }
    const get = gas.context.DriveApp.getFileById;
    mock(gas.context.DriveApp, {getFileById(id) { if (id === target.id) throw new Error('Fake denied'); return get(id); }}, () =>
      assert.equal(call('webAppFolderFile_', file, {}, now).importable, true));
    assert.ok(call('webAppListFolder', 'SC_FAKE', folder.id).files.some(f => f.fileId === file.id));
  });

  test('sc 16: web import forwards exclusion counts and final review balances all five', () => {
    const {folder, file, target} = setup(); const result = noTargetWrites(target, () => plain(call('webAppRunImport', 'SC_FAKE', folder.id, {})));
    assert.equal(result.fileResults[0].outcome, 'WRITTEN', JSON.stringify(result));
    assert.deepEqual(result.fileResults[0].priorYearExcluded, {count: 2, fiscalYear: 2026});
    const customer = Object.assign({}, call('getCustomerById', 'SC_FAKE'), {destinationSpreadsheetId: result.destinationSpreadsheetId});
    const rows = gas.stubs.getSpreadsheet(result.destinationSpreadsheetId).getSheetByName('架空入力').getDataRange().getValues().slice(1).filter(r => r[6]);
    const summary = reconcile(customer, rows, file.id);
    assert.equal(summary.statement, 1500); assert.equal(summary.excluded, 300); assert.equal(summary.written, 1200); assert.equal(summary.residual, 0);
  });

  test('sc 17: notice reports only positive exclusions in file order on both import paths', () => {
    const source = fs.readFileSync('src/81_WebAppUi.html', 'utf8'); const script = /<script>([\s\S]*?)<\/script>/.exec(source)[1];
    const files = [{fileName: '架空A', nextState: 'COMPLETED', priorYearExcluded: {count: 2, fiscalYear: 2026}},
      {fileName: '架空B', priorYearExcluded: {count: 0, fiscalYear: 2026}}, {fileName: '架空C'},
      {fileName: '架空D', priorYearExcluded: {count: 1, fiscalYear: 2027}}];
    const needle = "    el['customer-search'].addEventListener"; assert.ok(script.includes(needle));
    const sandbox = {document: {getElementById() { return {}; }}};
    vm.runInNewContext(script.replace(needle, `    globalThis.probe = customerFixNoticeLines(${JSON.stringify(files)}); return;\n` + needle), sandbox);
    assert.deepEqual(plain(sandbox.probe), ['【前年分を除外】架空A：2025 年以前の利用 2 件は転記していません', '【前年分を除外】架空D：2026 年以前の利用 1 件は転記していません']);
    assert.equal(source.match(/warnings = warnings\.concat\(customerFixNoticeLines\(result\.fileResults\)/g).length, 2);
  });

  test('sc 18: unknown shortcut format diagnosis preview and save use target content', () => {
    const values = grid(); values[0] = ['架空取引日', '架空利用先', '架空請求額', '架空目的'];
    const {folder, file} = setup(values); call('registerReview', {reviewType: 'FORMAT_UNKNOWN', customerId: 'SC_FAKE', customerName: '架空顧客', fileId: file.id, fileNameOriginal: file.name});
    const diagnosis = call('webAppExplainUnknownFile', 'SC_FAKE', folder.id, file.id); assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis));
    const p = diagnosis.proposal; assert.ok(p);
    const answers = {baseFormatId: p.baseFormatId, formatId: 'sc_derived_fake', formatName: '架空追加形式', sheetName: p.sheetName,
      headerRow: p.headerRow, dataStartRow: p.dataStartRow, columns: {date: 'A', merchant: 'B', amount: 'C', purpose: 'D', amountFallback: ''}, acknowledgements: {customerSide: true, amountChoice: true}};
    const preview = () => call('webAppPreviewFormat', 'SC_FAKE', folder.id, file.id, answers);
    const first = preview(); assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(preview().previewHash, first.previewHash);
    sourceSheet().getRange(2, 4).setValue('FAKE_CHANGED'); const second = preview(); assert.notEqual(second.previewHash, first.previewHash);
    const result = call('webAppSaveFormat', 'SC_FAKE', folder.id, file.id, answers, second.previewHash);
    assert.equal(result.saved, true, JSON.stringify(result));
  });

  test('sc 18: purpose and card name derive from shortcut name and its card folder', () => {
    const row = formatRow(); row[34] = JSON.stringify({sources: [{kind: 'folderName'}]});
    const values = grid(); values.forEach((r, i) => { if (i) r[3] = ''; });
    const {file, target} = setup(values, 2026, row); target.name = 'UNRELATED_TARGET';
    master().getSheetByName('使用用途補完マスター').appendRow(['sc-purpose-fake', 'FAKE_202601', 'FAKE_FEE', 'TRUE']);
    master().getSheetByName('顧客マスター').getRange(2, 40).setValue(JSON.stringify(['FAKE_FEE']));
    const keys = [], match = gas.context.matchPartner;
    const result = mock(gas.context, {matchPartner(tx, ...args) { keys.push(tx.merchantOriginal); return match(tx, ...args); }}, () => outcome(run()));
    assert.equal(result.written, 3); assert.equal(keys.length, 3); assert.deepEqual(keys, ['FAKE_CARD', 'FAKE_CARD', 'FAKE_CARD']);
    assert.ok(txs().every(tx => tx.originalPurpose === 'FAKE_FEE')); assert.equal(file.name, '【処理中】FAKE_202601');
  });
};

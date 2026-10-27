'use strict';

const {browserWorld} = require('./kw26-ui-helpers');

module.exports = ({test, assert, gas}) => {
  const plain = v => JSON.parse(JSON.stringify(v));
  const call = (name, args = []) => gas.call(name, args);
  const blank = n => Array(n).fill('');
  const master = name => gas.stubs.getSpreadsheet('master').getSheetByName(name);
  const sheet = (id = 'inc-dest') => gas.stubs.getSpreadsheet(id).getSheetByName('入力用シート');
  const cell = (row, column, id) => sheet(id).getRange(row, column).getValue();
  function mock(overrides, fn) {
    const saved = {};
    for (const key of Object.keys(overrides)) { saved[key] = gas.context[key]; gas.context[key] = overrides[key]; }
    try { return fn(); } finally { Object.assign(gas.context, saved); }
  }
  function setup(income = true, known = true) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    call('setMasterSpreadsheetId', ['master']);
    call('provisionMasterSheets');
    gas.stubs.setSpreadsheetOwner('master', 'inc-owner@example.com');
    gas.stubs.setActiveUser('inc-owner@example.com');
    gas.stubs.createSpreadsheet('inc-index', {sheets: []});
    gas.stubs.createSpreadsheet('inc-snap', {sheets: []});
    gas.stubs.createFolder('inc-corpus', {fileIds: []});
    gas.evaluate("SETTINGS.TX_INDEX_SPREADSHEET_ID='inc-index'; SETTINGS.SNAPSHOT_SPREADSHEET_ID='inc-snap';" +
      "SETTINGS.EXECUTION_TIMEOUT_SECONDS=300; SETTINGS.SAFETY_MARGIN_SECONDS=60; SETTINGS.PARALLEL_WORK_FOLDER_ID=''; SETTINGS.SAMPLE_CORPUS_FOLDER_ID='inc-corpus';");
    const header = blank(30);
    Object.assign(header, {1: '利用日', 5: '取引先', 6: '相手税区分', 8: 'メモ',
      10: '摘要', 11: '収入金額', 12: '支出金額', 29: '内部取引ID'});
    gas.stubs.createSpreadsheet('inc-dest', {sheets: [
      {name: '入力用シート', values: [header, blank(30), blank(30), blank(30)], maxRows: 15, maxColumns: 30},
      {name: '取引先一覧', values: [['元店名', '取引先名'], ['架空商店アルファ', '架空取引先アルファ']]}
    ]});
    gas.stubs.createFolder('inc-parent', {fileIds: ['inc-dest']});
    gas.stubs.createFolder('inc-card', {name: '架空カード', fileIds: []});
    gas.stubs.createFolder('inc-root', {subFolderIds: ['inc-card']});
    const config = {customerId: 'INC_FAKE', customerName: '架空顧客アルファ', sourceFolderId: 'inc-root',
      destinationSpreadsheetId: 'inc-dest', destinationSheetName: '入力用シート',
      columns: {B: 2, F: 6, G: 7, I: 9, K: 11, M: 13, txId: 30}, rowScanLastColumn: 30,
      reviewers: 'inc-owner@example.com', admins: 'inc-owner@example.com',
      cashbackMerchants: ['架空返金アルファ']};
    call('registerTestCustomer', [config]);
    // AQを直接準備し、登録関数の試験と読取・転記の試験を独立させる。
    const cm = master('顧客マスター');
    if (cm.getMaxColumns() < 43) cm.insertColumnsAfter(cm.getMaxColumns(), 43 - cm.getMaxColumns());
    cm.getRange(2, 43).setValue(income ? 12 : '');
    const format = blank(37);
    Object.assign(format, {0: 'inc_fake_format', 1: '架空形式アルファ', 2: 'active', 3: true, 4: '["csv"]',
      5: JSON.stringify({allOf: [{maxRow: 1, keywords: ['利用日', '利用店名', '金額', '使用用途'], minMatch: 4}]}),
      6: 1, 7: 2, 8: 'A', 9: 'B', 10: 'C', 11: 'D',
      14: JSON.stringify({excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []}),
      16: JSON.stringify({sources: [{id: 'fn', kind: 'fileName', pattern: '(20\\d{2})(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}]}),
      17: 'generic', 18: 1, 19: 'inc-owner@example.com', 21: '2026-01-01T00:00:00+09:00',
      29: 'NEW', 33: '2026-01-01T00:00:00+09:00'});
    master('カード形式マスター').appendRow(format);
    if (known) {
      const dict = blank(18);
      Object.assign(dict, {0: 'INC_FAKE_DICT', 1: '架空商店アルファ', 2: '架空商店アルファ', 3: '架空取引先アルファ',
        4: 'exact_original', 5: 1, 9: true, 10: 'inc-owner@example.com', 12: '2026-01-01', 13: 1, 14: true, 15: false});
      master('共通取引先辞書').appendRow(dict);
    }
    return {customer: call('getCustomerById', ['INC_FAKE']), config};
  }
  function file(amounts, merchant = '架空商店アルファ') {
    const csv = ['利用日,利用店名,金額,使用用途',
      ...amounts.map((m, i) => `2025/12/${10 + i},${merchant},${m},仕入れ`)].join('\n');
    gas.stubs.createFile('inc-file', {name: '架空明細202601.csv', bytes: Buffer.from(csv, 'utf8'),
      contentType: 'text/csv', lastUpdated: new Date(Date.now() - 3600000), createdTime: '2026-08-01T00:00:00Z'});
    gas.stubs.createFolder('inc-card', {name: '架空カード', fileIds: ['inc-file']});
  }
  const txs = () => call('getTransactionsByStatus', ['inc-file', ['COMMITTED', 'REVIEW_REQUIRED', 'WRITING', 'PREPARED']]);
  function seed(customer, amount, status = 'COMMITTED') {
    gas.stubs.createFile('inc-file', {name: '架空明細.csv', data: 'fake'});
    call('createOrUpdateProcessLog', ['INC_RUN', customer, {id: 'inc-file', name: '架空明細.csv',
      binaryHash: 'b'.repeat(64), contentHash: 'c'.repeat(64), hashVersion: '3', state: 'WRITING'}]);
    const planned = {b: '2026-01-02', f: '架空取引先アルファ', i: '仕入れ', k: '架空商店アルファ', m: amount};
    call('registerPrepared', [[{fullTxId: 'INC_FAKE_TX', customerId: customer.customerId, fileId: 'inc-file',
      sourceRow: 2, formatId: 'inc_fake_format', plannedFinalStatus: 'COMMITTED',
      partnerResolutionStatus: 'RESOLVED_WITH_PARTNER', originalDate: planned.b,
      originalMerchant: planned.k, originalAmount: amount, originalPurpose: planned.i, planned,
      identityHash: 'd'.repeat(64), contentHash: 'c'.repeat(64), occurrenceIndex: 0,
      transactionIdVersion: '2', hashVersion: '3'}], 'INC_RUN']);
    call('updateTransactionLocation', ['INC_FAKE_TX', 2, customer]);
    call('updateWrittenValues', ['INC_FAKE_TX', planned, planned]);
    if (status !== 'PREPARED') call('updateTransactionStatus', ['INC_FAKE_TX', 'PREPARED', status]);
    for (const [column, value] of [[2, planned.b], [6, planned.f], [9, planned.i], [11, planned.k], [30, 'INC_FAKE_TX']])
      sheet().getRange(2, column).setValue(value);
    return call('getTransaction', ['INC_FAKE_TX']);
  }
  function review(type = 'AMOUNT') {
    return call('registerReview', [{reviewType: type, fullTxId: 'INC_FAKE_TX', fileId: 'inc-file',
      customerId: 'INC_FAKE', customerName: '架空顧客アルファ', sourceRow: 2, destinationRow: 2,
      destinationSpreadsheetId: 'inc-dest', destinationSheetName: '入力用シート',
      merchantOriginal: '架空商店アルファ', merchantNormalized: call('normalizeMerchant', ['架空商店アルファ'])}]).reviewId;
  }
  const index = customer => call('buildIndex', [customer]);
  const lease = () => call('acquireLease', ['INC_FAKE', 'inc-file', 'INC_RUN', 'inc-owner@example.com', 'PROCESS']);
  const write = tx => call('buildRowWrite', [2, tx]);
  function importRows(income, amounts, merchant) {
    const world = setup(income); file(amounts, merchant);
    const result = call('runImport', [{}]);
    assert.equal(result.stoppedBy, null, JSON.stringify(result));
    return {...world, result};
  }

  test('inc 1: import splits positive negative and zero and keeps signed logs', () => {
    importRows(true, [3000, -1200, 0]);
    const zeroReviews = call('openReviews', [{fileId: 'inc-file'}]).filter(r => r.reviewType === 'ZERO_AMOUNT');
    assert.equal(zeroReviews.length, 1);
    assert.ok(!call('openReviews', [{fileId: 'inc-file'}]).some(r => r.reviewType === 'DESTINATION_VALUE_MISMATCH'));
    const rows = txs().sort((a, b) => a.sourceRow - b.sourceRow);
    assert.equal(rows.length, 3);
    rows.forEach((tx, i) => {
      assert.equal(tx.transactionStatus, i === 2 ? 'REVIEW_REQUIRED' : 'COMMITTED');
      assert.equal(tx.planned.m, [3000, -1200, 0][i]);
      assert.equal(tx.verified.m, tx.planned.m);
      assert.equal(cell(tx.destinationRow, 12), ['', 1200, ''][i]);
      assert.equal(cell(tx.destinationRow, 13), [3000, '', 0][i]);
    });
    assert.equal(call('getFileState', ['inc-file']), 'REVIEW_WAIT');
  });
  test('inc 1: positive and negative import completes without a zero review', () => {
    importRows(true, [3000, -1200]);
    assert.equal(call('getFileState', ['inc-file']), 'COMPLETED');
    assert.equal(call('openReviews', [{fileId: 'inc-file'}]).length, 0);
    assert.ok(txs().every(tx => tx.transactionStatus === 'COMMITTED' && tx.verified.m === tx.planned.m));
  });
  test('inc 2: no income mapping preserves negative M and every L cell', () => {
    const {customer} = setup(false); file([3000, -1200, 0]);
    sheet().getRange(14, 12).setValue('架空の既存値');
    const before = sheet().getRange(1, 12, 15, 1).getValues();
    const api = gas.context.Sheets.Spreadsheets.Values, real = api.batchUpdate, ranges = [];
    api.batchUpdate = function(req, id) { if (id === customer.destinationSpreadsheetId) ranges.push(...req.data.map(d => d.range)); return real.call(this, req, id); };
    try { call('runImport', [{}]); } finally { api.batchUpdate = real; }
    assert.deepEqual(plain(sheet().getRange(1, 12, 15, 1).getValues()), plain(before));
    assert.ok(!ranges.some(r => /!L\d/.test(r)));
    assert.deepEqual(Array.from(txs().sort((a, b) => a.sourceRow - b.sourceRow), t => cell(t.destinationRow, 13)), [3000, -1200, 0]);
  });
  test('inc 3: cashback writes income with unchanged tax and memo tags', () => {
    importRows(true, [-500], '架空返金アルファ');
    const tx = txs()[0];
    assert.equal(tx.transactionStatus, 'COMMITTED');
    assert.equal(cell(tx.destinationRow, 12), 500); assert.equal(cell(tx.destinationRow, 13), '');
    assert.equal(cell(tx.destinationRow, 7), '対象外');
    assert.match(cell(tx.destinationRow, 9), /キャッシュバック/);
  });
  test('inc 4: historical negative M stays valid in integrity and final review', () => {
    const {customer} = setup(); const tx = seed(customer, -1200);
    sheet().getRange(2, 13).setValue(-1200);
    assert.equal(call('checkManualChanges', [index(customer), [tx]]).length, 0);
    assert.equal(call('finalReviewSheet_', [customer]).rows[0].amount, -1200);
  });
  test('inc 5: both nonempty money cells fail readback and integrity including zero', () => {
    const {customer} = setup(); const tx = seed(customer, 3000);
    sheet().getRange(2, 13).setValue(3000);
    for (const income of [1200, 0]) {
      sheet().getRange(2, 12).setValue(income);
      for (const idx of [undefined, index(customer)]) {
        const verified = call('verifyWrittenValues', [customer, [write(tx)], idx]);
        assert.equal(verified[0].ok, false);
        assert.ok(verified[0].mismatches.some(m => m.column === 'm'));
      }
      assert.ok(call('checkManualChanges', [index(customer), [tx]]).some(f => f.check === 'MANUAL_CHANGE' && f.detail.column === 'm'));
    }
  });
  test('inc 5: conflicting cells after correction stop with DESTINATION_VALUE_MISMATCH', () => {
    const {customer} = setup(); seed(customer, 3000, 'REVIEW_REQUIRED');
    sheet().getRange(2, 13).setValue(3000);
    const id = review();
    const api = gas.context.Sheets.Spreadsheets.Values, real = api.batchUpdate;
    api.batchUpdate = function(req, id) {
      const result = real.call(this, req, id);
      if (id === 'inc-dest' && req.valueInputOption === 'USER_ENTERED') sheet().getRange(2, 12).setValue(500);
      return result;
    };
    try {
      assert.throws(() => call('resolveReview', [id, 'FIX_DATE_AMOUNT', {correctedAmount: 3000}]),
        e => e.code === 'DESTINATION_VALUE_MISMATCH');
    } finally { api.batchUpdate = real; }
    assert.notEqual(txs()[0].transactionStatus, 'COMMITTED');
  });
  test('inc 6: FIX_DATE_AMOUNT switches both directions and clears the other cell', () => {
    const {customer} = setup(); seed(customer, -1200, 'REVIEW_REQUIRED');
    sheet().getRange(2, 12).setValue(1200);
    for (const amount of [3000, -1200]) {
      const id = review();
      call('resolveReview', [id, 'FIX_DATE_AMOUNT', {correctedDate: '2026-01-03', correctedAmount: amount}]);
      assert.equal(cell(2, 12), amount < 0 ? -amount : '');
      assert.equal(cell(2, 13), amount < 0 ? '' : amount);
      const tx = call('getTransaction', ['INC_FAKE_TX']);
      assert.equal(tx.planned.m, amount); assert.equal(tx.verified.m, amount);
    }
  });
  for (const action of ['EXCLUDE', 'CANCEL']) test('inc 7: ' + action + ' clears income', () => {
    const {customer} = setup(); seed(customer, -1200, 'REVIEW_REQUIRED'); sheet().getRange(2, 12).setValue(1200);
    if (action === 'EXCLUDE') call('resolveReview', [review('PARTNER'), 'EXCLUDE', {}]);
    else call('cancelTransactions', [{customer, fileId: 'inc-file', fullTxIds: ['INC_FAKE_TX'],
      leaseId: lease(), index: index(customer), actor: 'inc-owner@example.com', choice: 'CANCELED'}]);
    assert.equal(cell(2, 12), ''); assert.equal(cell(2, 13), '');
  });
  test('inc 7: income occupies a row and blocks using it as expansion source', () => {
    const {customer} = setup(); sheet().getRange(2, 12).setValue(1200);
    const idx = index(customer);
    assert.equal(call('isRowEmpty', [idx, 2, customer]), false);
    assert.equal(call('systemOwnedColumnsAreEmpty_', [customer, sheet().getRange(2, 1, 1, 30).getValues()[0]]), false);
    assert.throws(() => call('expandTemplateRows', [customer, sheet(), 1, 2, {actual: 15, index: idx}]), /INVALID_TEMPLATE_SOURCE/);
  });
  test('inc 7: expansion clears copied income without touching other columns', () => {
    const {customer} = setup(); sheet().getRange(2, 3).setValue('架空の既定値');
    const source = sheet().getRange(2, 1, 1, 30).getValues()[0];
    const realGet = sheet().getRange.bind(sheet());
    sheet().getRange = function(...args) {
      const range = realGet(...args);
      if (args[0] === 2 && args[1] === 1 && args[3] === 30) {
        const copy = range.copyTo.bind(range);
        range.copyTo = target => { const result = copy(target); sheet().getRange(16, 12).setValue(999); return result; };
      }
      return range;
    };
    try {
      mock({getAllValuesByRow: () => source}, () => call('expandTemplateRows', [customer, sheet(), 1, 2, {actual: 15, index: {}}]));
    } finally { sheet().getRange = realGet; }
    assert.equal(cell(16, 12), ''); assert.equal(cell(16, 3), '架空の既定値');
  });
  test('inc 7: clone clears income leftovers and leaves template intact', () => {
    const {customer} = setup(); sheet().getRange(2, 12).setValue(1200);
    const result = call('webAppCloneDestination_', [customer, new Date()]);
    assert.equal(result.schemaValidation.ok, true);
    assert.equal(cell(2, 12, result.destinationSpreadsheetId), ''); assert.equal(cell(2, 12), 1200);
  });
  test('inc 7: tax cleanup never clears an income-only transaction row', () => {
    setup(); sheet().getRange(2, 12).setValue(1200); sheet().getRange(2, 7).setValue('対象外');
    const result = call('opsClearTemplateTaxLeftovers', ['INC_FAKE', true]);
    assert.equal(result.cleared.length, 0); assert.equal(cell(2, 7), '対象外');
  });
  for (const partial of ['L', 'M']) test('inc 8: recovery finishes a negative row with only ' + partial + ' money written', () => {
    const {customer} = setup(); seed(customer, -1200, 'WRITING');
    sheet().getRange(2, partial === 'L' ? 12 : 13).setValue(partial === 'L' ? 1200 : -1200);
    // RAWが未完の状態も含め、回復の書込経路を必ず通す。
    sheet().getRange(2, 9).setValue('');
    const result = call('recoverPartialFailure', ['inc-file', 'INC_RUN', index(customer), lease(), {customer}]);
    assert.equal(result.recovered[0].step, 4);
    assert.equal(cell(2, 12), 1200); assert.equal(cell(2, 13), '');
    const tx = call('getTransaction', ['INC_FAKE_TX']);
    assert.equal(tx.transactionStatus, 'COMMITTED'); assert.equal(tx.verified.m, -1200);
    assert.equal(call('checkManualChanges', [index(customer), [tx]]).length, 0);
  });
  test('inc 9: final review returns signed income reconciles totals and column index', () => {
    const {customer} = setup(); seed(customer, -1200); sheet().getRange(2, 12).setValue(1200);
    const result = mock({webAppValidateDestination_: () => customer.destinationSpreadsheetId},
      () => call('webAppFinalReview', ['INC_FAKE', customer.destinationSpreadsheetId, ['inc-file']]));
    assert.equal(result.rows[0].amount, -1200); assert.equal(result.incomeColumnIndex, 11);
    assert.equal(result.amountColumnIndex, 12);
    assert.equal(result.reconciliation.totals.written, -1200);
    assert.equal(result.reconciliation.problems.length, 0);
  });
  test('inc 9: final review right aligns both income and expense using textContent', () => {
    const {execFileSync} = require('node:child_process');
    const code = `const assert = require('node:assert/strict');
    const {browserWorld} = require('./kw26-ui-helpers');
    (async () => {
    const w = browserWorld({webAppFinalReview: {headers: ['収入', '支出'], incomeColumnIndex: 0, amountColumnIndex: 1,
      rows: [{rowNumber: 2, cells: ['1200', ''], amount: -1200, status: 'COMMITTED'}], reconciliation: {}}});
    w.ui.state.selectedCustomerId = 'INC_FAKE'; w.ui.state.lastCompletedDestinationSpreadsheetId = 'inc-dest';
    await w.ui.loadFinalReview();
    const table = w.ids['final-rows'].children[0];
    assert.ok(table);
    for (const row of table.querySelectorAll('tr')) {
      assert.equal(row.children[2].className, 'num'); assert.equal(row.children[3].className, 'num');
    }
    })().catch(e => { console.error(e); process.exitCode = 1; });`;
    execFileSync(process.execPath, ['-e', code], {cwd: __dirname, encoding: 'utf8', timeout: 30000});
  });
  test('inc 10: master reads AQ validates overlap bounds and excluded income', () => {
    setup(); assert.equal(gas.evaluate('CUSTOMER_MASTER_COLUMNS_'), 43);
    assert.equal(call('getCustomerById', ['INC_FAKE']).columnMapping.L, 12);
    for (const value of [2, 6, 9, 11, 13, 30, 7, 0, -1, 31, 12.5, 'bad']) {
      master('顧客マスター').getRange(2, 43).setValue(value);
      assert.throws(() => call('getCustomerById', ['INC_FAKE']), e => e.code === 'CUSTOMER_MASTER_INVALID', String(value));
    }
    master('顧客マスター').getRange(2, 43).setValue(12);
    master('顧客マスター').getRange(2, 38).setValue('[12]');
    assert.throws(() => call('getCustomerById', ['INC_FAKE']), e => e.code === 'CUSTOMER_MASTER_INVALID');
  });
  test('inc 11: ops defaults to read only and apply writes AQ header and one SETTING audit', () => {
    setup(false); const cm = master('顧客マスター');
    const before = JSON.stringify(master('監査ログ').values), rows = JSON.stringify(cm.values);
    const result = call('opsSetIncomeColumn', ['INC_FAKE', 12]);
    assert.equal(result.header, '収入金額'); assert.equal(result.currentColumn, null); assert.equal(result.applied, false);
    assert.equal(result.masterSheetMaxColumns, cm.getMaxColumns());
    assert.equal(JSON.stringify(cm.values), rows); assert.equal(JSON.stringify(master('監査ログ').values), before);
    call('opsSetIncomeColumn', ['INC_FAKE', 12, 'true']); assert.equal(JSON.stringify(cm.values), rows);
    const applied = call('opsSetIncomeColumn', ['INC_FAKE', 12, true]);
    assert.equal(applied.applied, true); assert.equal(cm.getRange(2, 43).getValue(), 12);
    assert.equal(cm.getRange(1, 43).getValue(), '入金の転記先列');
    assert.equal(master('監査ログ').values.slice(1).filter(r => r[2] === 'SETTING').length, 1);
    cm.getRange(1, 43).setValue('架空の既存見出し');
    call('opsSetIncomeColumn', ['INC_FAKE', 12, true]); assert.equal(cm.getRange(1, 43).getValue(), '架空の既存見出し');
  });
  test('inc 11: a 42 column master stays unchanged on inspect and widens before AQ writes', () => {
    setup(false); const cm = master('顧客マスター');
    cm.maxColumns = 42;
    cm.values = cm.values.map(row => row.slice(0, 42));
    cm.formulas = cm.formulas.map(row => row.slice(0, 42));
    const before = JSON.stringify(cm.values), formulas = JSON.stringify(cm.formulas), events = [];
    const ensure = cm._ensureSize.bind(cm), write = cm._write.bind(cm), insert = cm.insertColumnsAfter.bind(cm);
    // この試験だけ、範囲読取によるスタブの自動拡張を抑え、実際の42列を再現する。
    cm._ensureSize = (rows, columns) => ensure(rows, Math.min(columns, cm.getMaxColumns()));
    cm._write = (row, column, values, isFormula) => {
      assert.ok(column + values[0].length - 1 <= cm.getMaxColumns(), 'widen before writing AQ');
      if (column === 43) events.push(row === 1 ? 'header' : 'AQ');
      return write(row, column, values, isFormula);
    };
    cm.insertColumnsAfter = (after, count) => {
      assert.equal(after, 42); assert.equal(count, 1); events.push('widen');
      return insert(after, count);
    };
    const audit = gas.context.appendAuditUnlocked_;
    mock({appendAuditUnlocked_: entry => {
      assert.equal(cm.getMaxColumns(), 42); events.push('audit'); return audit(entry);
    }}, () => {
      const result = call('opsSetIncomeColumn', ['INC_FAKE', 12]);
      assert.equal(result.masterSheetMaxColumns, 42); assert.equal(result.currentColumn, null);
      assert.equal(result.header, '収入金額'); assert.equal(result.applied, false);
      assert.equal(cm.getMaxColumns(), 42); assert.equal(JSON.stringify(cm.values), before);
      assert.equal(JSON.stringify(cm.formulas), formulas); assert.deepEqual(events, []);
      const applied = call('opsSetIncomeColumn', ['INC_FAKE', 12, true]);
      assert.equal(applied.applied, true); assert.equal(applied.masterSheetMaxColumns, 43);
    });
    assert.equal(cm.getMaxColumns(), 43); assert.deepEqual(events, ['audit', 'widen', 'AQ', 'header']);
    assert.equal(cm.getRange(2, 43).getValue(), 12); assert.equal(cm.getRange(1, 43).getValue(), '入金の転記先列');
    assert.equal(JSON.stringify(cm.values.map(row => row.slice(0, 42))), before);
    assert.equal(JSON.stringify(cm.formulas.map(row => row.slice(0, 42))), formulas);
    assert.equal(master('監査ログ').values.slice(1).filter(row => row[2] === 'SETTING').length, 1);
  });
  test('inc 11: registration round trips columns L and preserves it on reregistration', () => {
    const {config} = setup(false); config.columns.L = 12;
    call('registerTestCustomer', [config]); assert.equal(master('顧客マスター').getRange(2, 43).getValue(), 12);
    delete config.columns.L;
    call('registerTestCustomer', [config]); assert.equal(call('getCustomerById', ['INC_FAKE']).columnMapping.L, 12);
  });
  test('inc 12: one web import and one confirmation keep baseline Sheets read counts', () => {
    const counts = [];
    for (const income of [false, true]) {
      setup(income, false); file([-1200]);
      const customer = call('getCustomerById', ['INC_FAKE']);
      const clone = call('webAppCloneDestination_', [customer, new Date()]);
      gas.stubs.resetApiCallCounts();
      const result = call('webAppRunImport', ['INC_FAKE', 'inc-card', {destinationSpreadsheetId: clone.destinationSpreadsheetId}]);
      const imported = gas.stubs.getApiCallCounts();
      assert.equal(result.done, 1, JSON.stringify(result));
      const pending = call('openReviews', [{fileId: 'inc-file'}]).filter(r => r.reviewType === 'PARTNER');
      assert.equal(pending.length, 1);
      gas.stubs.resetApiCallCounts();
      call('resolveReview', [pending[0].reviewId, 'RESOLVE_WITHOUT_PARTNER', {}]);
      const confirmed = gas.stubs.getApiCallCounts();
      assert.equal(txs()[0].transactionStatus, 'COMMITTED');
      counts.push({income, import: imported.batchGet + imported.get, confirm: confirmed.batchGet + confirmed.get});
    }
    console.log('INC12_READS ' + JSON.stringify(counts));
    assert.equal(counts[0].import, 37); assert.equal(counts[0].confirm, 10);
    assert.equal(counts[0].import, counts[1].import); assert.equal(counts[0].confirm, counts[1].confirm);
  });

  // 監査で足した（私の変異 Y7 がすり抜けた）：設定の運用関数は、書く前に列を確かめる。
  // M と重なる列などを AQ に書くと、その顧客を読むたびに顧客マスターの検査で止まり、
  // 顧客ごと使えなくなる。
  test('inc 14: the setter refuses overlapping, out-of-range or non-integer columns before writing', () => {
    setup(false); const cm = master('顧客マスター');
    const rows = JSON.stringify(cm.values), audits = JSON.stringify(master('監査ログ').values);
    for (const bad of [13, 2, 7, 30, 31, 0, '12', 12.5]) {
      assert.throws(() => call('opsSetIncomeColumn', ['INC_FAKE', bad, true]), /CUSTOMER_MASTER_INVALID|AQ/, String(bad));
      assert.equal(JSON.stringify(cm.values), rows, String(bad));
      assert.equal(JSON.stringify(master('監査ログ').values), audits, String(bad));
    }
  });

  // 監査で足した：取引ログから読み戻した金額が文字列でも、符号で振り分ける。
  // 部分書込（金額を含まない）では L に一切触れない。
  test('inc 13: money split handles numeric strings and leaves partial writes alone', () => {
    const withIncome = {columnMapping: {M: 13, L: 12}};
    const split = (values) => plain(gas.context.sheetMoneyWriteValues_(withIncome, values));
    assert.deepEqual(split({m: '-1200'}), {m: '', l: 1200});
    assert.deepEqual(split({m: ' -500 '}), {m: '', l: 500});
    assert.deepEqual(split({m: '1200'}), {m: '1200', l: ''});
    assert.deepEqual(split({m: -800}), {m: '', l: 800});
    assert.deepEqual(split({m: 0}), {m: 0, l: ''});
    assert.deepEqual(split({m: ''}), {m: '', l: ''});
    assert.deepEqual(split({m: '架空の文字'}), {m: '架空の文字', l: ''});
    assert.deepEqual(split({f: '架空取引先'}), {f: '架空取引先'}, '金額を含まない書込は L を足さない');
    assert.deepEqual(plain(gas.context.sheetMoneyWriteValues_({columnMapping: {M: 13}}, {m: -800})),
      {m: -800}, 'L の無い顧客は今のまま');
  });
};

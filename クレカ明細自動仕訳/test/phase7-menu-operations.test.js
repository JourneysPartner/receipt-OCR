'use strict';

/**
 * 操作メニューは帳簿へ書くため、表示だけでなく「その誤実装なら赤になる」境界を
 * 仕様 §12.3 の62ケースとして固定する。シートを要しない契約は純粋関数で検査し、
 * 書込経路は既存の部品を通す結合テストから補完する。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const blank = (length) => Array(length).fill('');
  const sheetHeader = (length, label) => { const row = blank(length); row[0] = label; return row; };
  const review = (id, type, options = {}) => Object.assign({
    reviewId: id, status: 'OPEN', reviewType: type, customerId: 'C001',
    customerName: '顧客一', fileId: 'file_' + id, fileNameOriginal: id + '.csv',
    fullTxId: 'tx_' + id, merchantOriginal: '店', originalDate: '2026-01-05',
    originalAmount: 1200, originalPurpose: '仕入れ', destinationRow: 2,
    registeredAt: '2026-09-10T10:00:00+09:00'
  }, options);
  const scope = (options = {}) => Object.assign({
    email: 'reviewer@example.com', role: 'REVIEWER', isOwner: false,
    customers: [{customerId: 'C001', customerName: '顧客一'}], customerIds: ['C001'],
    customerNameById: {C001: '顧客一'}, rolesByCustomerId: {C001: 'REVIEWER'}
  }, options);
  const live = (options = {}) => Object.assign({
    transactionStatus: 'REVIEW_REQUIRED', freeeStatus: 'NOT_IMPORTED',
    planned: {b: '2026-01-05', f: '', i: '仕入れ', k: '店', m: 1200}, destinationRow: 2,
    liveTransactionCount: 0
  }, options);
  const call = (name, args = []) => plain(gas.call(name, args));
  const catalog = () => JSON.parse(gas.evaluate('JSON.stringify(MENU_RESOLVE_OPERATIONS_)'));
  const withMocks = (overrides, fn) => {
    const saved = {};
    Object.keys(overrides).forEach((name) => { saved[name] = gas.context[name]; gas.context[name] = overrides[name]; });
    try { return fn(); } finally {
      Object.keys(saved).forEach((name) => { gas.context[name] = saved[name]; });
    }
  };
  const applyItem = (reviews, kind = 'PARTNER_GROUP', reviewType = 'PARTNER') => ({
    kind, reviewType, customerId: 'C001', customerName: '顧客一', merchantOriginal: '店', reviews
  });
  const applyMocks = (overrides = {}) => Object.assign({
    authorizeOperation: () => ({userEmail: 'reviewer@example.com', role: 'REVIEWER'}),
    getCustomerById: () => ({customerId: 'C001'}),
    resolveReview: () => ({committed: true, unmetConditions: [], openReviewTypes: [], transactionStatus: 'COMMITTED'}),
    resolveFileReview: () => ({nextState: 'COMPLETED'}),
    commitSettledTransactions_: () => ({candidates: 0, evaluated: 0, committed: [], deferred: 0}),
    completeFileIfFullyResolved_: (fileId) => ({fileId, completed: false, state: 'REVIEW_WAIT', skipped: null}),
    getTransaction: () => live(), isCardNamePartnerPurpose: () => false,
    getTransactionsByStatus: () => [], activeLeases_: () => []
  }, overrides);

  function partnerCustomerRow() {
    const row = blank(39);
    Object.assign(row, {
      0: 'C001', 1: '顧客一', 2: 'TRUE', 3: 'folder1', 5: 'dest1',
      7: '入力用シート', 8: '取引先一覧', 9: 2, 10: 3, 11: 4, 12: 5,
      13: 6, 14: 7, 15: '1.0', 16: 'reviewer@example.com',
      17: 'admin@example.com', 18: 0, 20: 'システム情報', 21: '', 23: 0, 24: 0,
      29: 1, 30: JSON.stringify({row: 1, cells: [{column: 2, text: '利用日', match: 'exact'}]}),
      31: '{}', 32: '{}', 33: 8, 34: '取引先一覧', 35: 'CORPORATE', 36: '', 38: ''
    });
    return row;
  }

  function partnerFormatRow() {
    const row = blank(34);
    Object.assign(row, {
      0: 'smbc_family', 1: '三井住友系', 2: 'active', 3: 'TRUE', 4: '["csv"]',
      5: JSON.stringify({allOf: [{maxRow: 1,
        keywords: ['利用日', '利用店名', '金額', '使用用途'], minMatch: 4}]}),
      6: 1, 7: 2, 8: 'A', 9: 'B', 10: 'C', 11: 'D', 12: '',
      14: JSON.stringify({excludeRowRanges: [{from: 1, to: 1}],
        excludeWhenDateAndAmountEmpty: true, rules: []}),
      16: JSON.stringify({sources: [{id: 'fn', kind: 'fileName',
        pattern: '(20\\d{2})(0[1-9]|1[0-2])', groups: {year: 1, month: 2},
        yearDigits: 4, means: 'payment', offsetMonths: 1}]}),
      17: 'generic', 18: 1, 19: 'admin@example.com',
      21: '2026-01-01T00:00:00+09:00', 29: 'NEW', 33: '2026-01-01T00:00:00+09:00'
    });
    return row;
  }

  function partnerCandidateRow() {
    const row = blank(18);
    Object.assign(row, {
      0: 'DICT_CANDIDATE', 1: '未登録', 2: '未登録', 3: '候補株式会社',
      4: 'partial', 5: 1, 9: 'FALSE', 10: 'admin@example.com',
      12: '2026-01-01T00:00:00+09:00', 13: 1, 14: 'TRUE', 15: 'FALSE'
    });
    return row;
  }

  function knownMerchantRow() {
    const row = blank(18);
    Object.assign(row, {
      0: 'DICT_KNOWN', 1: 'ローソン', 2: 'ローソン', 3: '株式会社ローソン',
      4: 'exact_original', 5: 1, 9: 'TRUE', 10: 'admin@example.com',
      12: '2026-01-01T00:00:00+09:00', 13: 1, 14: 'TRUE', 15: 'FALSE'
    });
    return row;
  }

  /** 取引単位の各種別を、実際の runImport から立てる。 */
  function setupTypedImport(rows, options = {}) {
    gas.stubs.reset();
    const customer = partnerCustomerRow();
    customer[35] = options.customerCategory || 'CORPORATE';
    customer[36] = options.fiscalYear === undefined ? '' : options.fiscalYear;
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [sheetHeader(39, '顧客ID'), customer]},
      {name: 'カード形式マスター', values: [sheetHeader(34, '形式ID'), partnerFormatRow()]},
      {name: '使用用途補完マスター', values: [sheetHeader(10, 'ルールID'),
        Object.assign(blank(10), {0: 'PR1', 1: '仕入', 2: '仕入れ', 3: 'TRUE'})]},
      {name: '共通取引先辞書', values: [sheetHeader(18, '辞書ID'), knownMerchantRow()]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート', values: [['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID', '']],
        maxRows: 30, maxColumns: 8},
      {name: '取引先一覧', values: [['元店名', '取引先名'], ['ローソン', '株式会社ローソン']]}
    ]});
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createSpreadsheet('snap', {sheets: []});
    gas.evaluate("SETTINGS.EXECUTION_TIMEOUT_SECONDS=300;SETTINGS.SAFETY_MARGIN_SECONDS=60;" +
      "SETTINGS.TX_INDEX_SPREADSHEET_ID='txidx';SETTINGS.SNAPSHOT_SPREADSHEET_ID='snap';" +
      "SETTINGS.SAMPLE_CORPUS_FOLDER_ID='corpus';SETTINGS.PARALLEL_WORK_FOLDER_ID='';" +
      "SETTINGS.FAULT_INJECTION=null;");
    gas.stubs.createFolder('corpus', {fileIds: []});
    const fileId = options.fileId || 'typedFile';
    const fileName = options.fileName || '三井住友カード202601.csv';
    const content = ['利用日,利用店名,金額,使用用途'].concat(rows).join('\n') + '\n';
    gas.stubs.createFile(fileId, {name: fileName, bytes: Buffer.from(content, 'utf8'),
      lastUpdated: new Date(Date.now() - 3600 * 1000), createdTime: '2026-08-01T00:00:00Z',
      contentType: 'text/csv'});
    gas.stubs.createFolder('folder1', {fileIds: [fileId]});
    gas.stubs.setActiveUser('reviewer@example.com');
    const report = plain(gas.call('runImport', [{}]));
    const reviews = plain(gas.call('openReviews', [{}]));
    if (options.reviewType) {
      assert.equal(reviews.length, rows.length, JSON.stringify({report, reviews}));
      assert.ok(reviews.every((row) => row.reviewType === options.reviewType), JSON.stringify(reviews));
    }
    gas.stubs.resetUiEvents(); gas.stubs.resetApiCallCounts(); gas.stubs.resetRoundTrips();
    return {report, reviews, fileId, fileName};
  }

  /** PARTNER の結合テストは、実際の runImport が作った行だけを使う。 */
  function setupPartnerImport(fileCount, transactionsPerFile = 1, options = {}) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [sheetHeader(39, '顧客ID'), partnerCustomerRow()]},
      {name: 'カード形式マスター', values: [sheetHeader(34, '形式ID'), partnerFormatRow()]},
      {name: '使用用途補完マスター', values: [sheetHeader(10, 'ルールID'),
        Object.assign(blank(10), {0: 'PR1', 1: '仕入', 2: '仕入れ', 3: 'TRUE'})]},
      {name: '共通取引先辞書', values: [sheetHeader(18, '辞書ID')].concat(options.dictionaryRows || [])}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート', values: [['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID', '']],
        maxRows: Math.max(30, fileCount * transactionsPerFile + 5), maxColumns: 8},
      {name: '取引先一覧', values: [['元店名', '取引先名'], ['既知店', '株式会社既知店']]}
    ]});
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createSpreadsheet('snap', {sheets: []});
    gas.evaluate("SETTINGS.EXECUTION_TIMEOUT_SECONDS=300;SETTINGS.SAFETY_MARGIN_SECONDS=60;" +
      "SETTINGS.TX_INDEX_SPREADSHEET_ID='txidx';SETTINGS.SNAPSHOT_SPREADSHEET_ID='snap';" +
      "SETTINGS.SAMPLE_CORPUS_FOLDER_ID='corpus';SETTINGS.PARALLEL_WORK_FOLDER_ID='';" +
      "SETTINGS.FAULT_INJECTION=null;");
    gas.stubs.createFolder('corpus', {fileIds: []});
    const fileIds = [];
    for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
      const lines = ['利用日,利用店名,金額,使用用途'];
      for (let txIndex = 0; txIndex < transactionsPerFile; txIndex += 1) {
        const day = String(10 + ((fileIndex * transactionsPerFile + txIndex) % 18)).padStart(2, '0');
        lines.push(`2025/12/${day},未登録店,${1000 + txIndex},仕入れ`);
      }
      const fileId = 'partnerFile' + fileIndex;
      fileIds.push(fileId);
      gas.stubs.createFile(fileId, {name: `三井住友カード202601_${fileIndex}.csv`,
        bytes: Buffer.from(lines.join('\n') + '\n', 'utf8'),
        lastUpdated: new Date(Date.now() - 3600 * 1000),
        createdTime: '2026-08-01T00:00:00Z', contentType: 'text/csv'});
    }
    gas.stubs.createFolder('folder1', {fileIds});
    gas.stubs.setActiveUser('reviewer@example.com');
    const report = plain(gas.call('runImport', [{}]));
    const reviews = plain(gas.call('openReviews', [{}]));
    assert.equal(reviews.length, fileCount * transactionsPerFile, JSON.stringify(report));
    assert.ok(reviews.every((row) => row.reviewType === 'PARTNER'));
    gas.stubs.resetUiEvents(); gas.stubs.resetApiCallCounts(); gas.stubs.resetRoundTrips();
    return {report, reviews};
  }

  function setupAuthorizationCustomers() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    ['1', '2'].forEach((suffix) => {
      gas.stubs.createSpreadsheet('authDest' + suffix, {sheets: [
        {name: '入力用シート', values: [['', '利用日', '取引先', '摘要', '金額', 'メモ', '内部ID', '税区分']],
          maxRows: 10, maxColumns: 8}, {name: '取引先一覧', values: [['取引先']]}
      ]});
      gas.stubs.createFolder('authFolder' + suffix, {fileIds: []});
    });
    gas.stubs.setActiveUser('admin@example.com');
    gas.call('registerTestCustomer', [{customerId: 'C001', customerName: '顧客一', active: true,
      sourceFolderId: 'authFolder1', destinationSpreadsheetId: 'authDest1',
      destinationSheetName: '入力用シート', partnerListSheetName: '取引先一覧',
      columns: {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7, G: 8},
      reviewers: 'reviewer@example.com', admins: 'admin@example.com', customerCategory: 'CORPORATE'}]);
    gas.call('registerTestCustomer', [{customerId: 'C002', customerName: '顧客二', active: true,
      sourceFolderId: 'authFolder2', destinationSpreadsheetId: 'authDest2',
      destinationSheetName: '入力用シート', partnerListSheetName: '取引先一覧',
      columns: {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7, G: 8},
      reviewers: 'other@example.com,admin@example.com', admins: 'admin2@example.com',
      customerCategory: 'CORPORATE'}]);
    gas.stubs.resetApiCallCounts();
  }

  function permissionRows() {
    const audit = gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ');
    return audit.getDataRange().getValues().slice(1).filter((row) => String(row[2]) === 'PERMISSION');
  }

  function assertDirectPermissionDenial(id, customerId, actor, reason) {
    setupAuthorizationCustomers();
    gas.stubs.setActiveUser(actor);
    const row = review('direct' + id, 'FORMAT_UNKNOWN', {customerId});
    assert.throws(() => gas.call('applyResolveDecision_', [{kind: 'FILE', reviewType: 'FORMAT_UNKNOWN',
      customerId, reviews: [row]}, 'REGISTER_FORMAT', {reviewId: row.reviewId},
    {deadlineMs: 999999, tripWorstMs: 0}]),
    (error) => error && error.name === 'AuthorizationError' && error.reason === reason);
    const audit = permissionRows();
    assert.equal(audit.length, 1);
    assert.equal(JSON.parse(String(audit[0][10])).operation, 'REGISTER_FORMAT');
    assert.equal(audit[0][11], reason);
  }

  function setupFileReview(type, actor = 'reviewer@example.com') {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [sheetHeader(39, '顧客ID'), partnerCustomerRow()]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート', values: [['', '利用日', '取引先', '摘要', '金額', 'メモ', '内部ID', '税区分']],
        maxRows: 10, maxColumns: 8}, {name: '取引先一覧', values: [['取引先']]}
    ]});
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createFile('file1', {name: '明細.csv', data: 'a,b'});
    gas.stubs.createFolder('folder1', {fileIds: ['file1']});
    gas.evaluate("SETTINGS.TX_INDEX_SPREADSHEET_ID='txidx';");
    gas.stubs.setActiveUser(actor);
    const customer = gas.call('getCustomerById', ['C001']);
    gas.call('createOrUpdateProcessLog', ['RUN_1', customer, {id: 'file1', name: '明細.csv',
      binaryHash: 'b'.repeat(64), contentHash: 'c'.repeat(64), hashVersion: '3', state: 'REVIEW_WAIT'}]);
    const reviewId = gas.call('registerReview', [{reviewType: type, fileId: 'file1', customerId: 'C001',
      customerName: '顧客一', fileNameOriginal: '明細.csv'}]).reviewId;
    gas.stubs.resetApiCallCounts(); gas.stubs.resetRoundTrips();
    const stored = plain(gas.call('getReviewById', [reviewId]));
    return {reviewId, stored, item: {kind: 'FILE', reviewType: type, customerId: 'C001',
      customerName: '顧客一', reviews: [stored]}};
  }

  test('ops menu 1: onOpen contains the two operation entries in order', () => {
    gas.stubs.reset(); gas.call('onOpen', []);
    const items = plain(gas.stubs.getMenus()[0].items).filter((item) => item.caption);
    assert.deepEqual(items.slice(2, 6).map((item) => item.functionName),
      ['menuOpenReview', 'menuResolveReview', 'menuRecheck', 'menuOpenLog']);
  });
  test('ops menu 2: public handlers exist', () => {
    assert.equal(gas.evaluate('typeof menuResolveReview'), 'function');
    assert.equal(gas.evaluate('typeof menuRecheck'), 'function');
  });
  test('ops menu 3: operation source keeps authorization in Menu only', () => {
    const fs = require('node:fs'); const path = require('node:path');
    const menu = fs.readFileSync(path.join(process.cwd(), 'src', '96_Menu.gs'), 'utf8');
    const ops = fs.readFileSync(path.join(process.cwd(), 'src', '97_Ops.gs'), 'utf8');
    assert.doesNotMatch(menu, /['"](?:REVIEWER|SYSTEM_ADMIN|OWNER_ADMIN)['"]/);
    assert.doesNotMatch(menu, /\bops[A-Z]\w*\s*\(/);
    assert.doesNotMatch(ops.slice(ops.indexOf('function completeFileIfFullyResolved_')), /authorize(?:Operation)?\s*\(/);
  });
  test('ops menu 4: catalog has exactly seven keys and safe units', () => {
    const entries = catalog();
    const keys = ['label', 'kinds', 'unit', 'extras', 'rewind', 'clearsRow', 'requiresNoLiveTransactions'].sort();
    Object.keys(entries).forEach((code) => assert.deepEqual(Object.keys(entries[code]).sort(), keys));
    assert.equal(entries.ADOPT_EXISTING_PARTNER.unit, 'GROUP');
    assert.equal(entries.RESOLVE_WITHOUT_PARTNER.unit, 'GROUP');
    assert.deepEqual(entries.RESIZE_INPUT.extras, []);
    assert.deepEqual(entries.CANCEL_FILE.extras, []);
  });
  test('ops menu 5: targets group, sort, and count unsupported before scope filtering', () => {
    const rows = [];
    for (let i = 0; i < 8; i += 1) rows.push(review('a' + i, 'PARTNER', {merchantOriginal: 'ローソン'}));
    for (let i = 0; i < 4; i += 1) rows.push(review('b' + i, 'PARTNER', {merchantOriginal: '別店'}));
    rows.push(review('d', 'DATE'), review('e', 'EMPTY_FILE'), review('i', 'INTEGRITY'),
      review('n', 'DATE', {customerId: null}));
    const built = call('buildResolveTargets_', [rows, scope()]);
    assert.deepEqual(built.items.map((item) => item.reviews.length), [8, 4, 1, 1]);
    assert.deepEqual(built.unsupported, {integrity: 1, fileChanged: 0, noCustomer: 1});
  });
  test('ops menu 6: half-width and full-width merchant spellings form one group', () => {
    const built = call('buildResolveTargets_', [[review('a', 'PARTNER', {merchantOriginal: 'ﾛｰｿﾝ'}),
      review('b', 'PARTNER', {merchantOriginal: 'ローソン'})], scope()]);
    assert.equal(built.items.length, 1); assert.equal(built.items[0].reviews.length, 2);
  });
  test('ops menu 7: target list is capped at fifteen and reports omitted targets', () => {
    const built = call('buildResolveTargets_', [Array.from({length: 20}, (_, i) => review('x' + i, 'DATE')), scope()]);
    assert.equal(built.items.length, 15); assert.equal(built.omitted, 5);
  });
  test('ops menu 8: all sixteen review kinds preserve component declaration order', () => {
    const expected = {
      PARTNER: ['ADOPT_EXISTING_PARTNER', 'RESOLVE_WITHOUT_PARTNER', 'EXCLUDE'],
      DATE: ['FIX_DATE_AMOUNT', 'EXCLUDE'], AMOUNT: ['FIX_DATE_AMOUNT', 'EXCLUDE'],
      ZERO_AMOUNT: ['POST_ZERO_AMOUNT', 'EXCLUDE'], PRIOR_YEAR: ['POST_PRIOR_YEAR', 'EXCLUDE_PRIOR_YEAR'],
      EMPTY_FILE: ['CONFIRM_EMPTY_FILE', 'CANCEL_FILE'],
      COUNT_TOTAL_MISMATCH: ['APPROVE_COUNT_MISMATCH', 'REJECT_COUNT_MISMATCH', 'CANCEL_FILE'],
      DUPLICATE: ['KEEP_ORIGINAL_RESULT', 'CANCEL_FILE'], INPUT_LIMIT: ['RESIZE_INPUT', 'CANCEL_FILE'],
      FORMAT_UNKNOWN: ['REGISTER_FORMAT', 'CANCEL_FILE'], FORMAT_AMBIGUOUS: ['REGISTER_FORMAT', 'CANCEL_FILE'],
      MULTI_SHEET: ['REGISTER_FORMAT', 'CANCEL_FILE'],
      SCAN_TRUNCATED: ['APPROVE_SCAN_TRUNCATION', 'REGISTER_FORMAT', 'CANCEL_FILE'],
      DESTINATION_FIX: ['CONFIRM_DESTINATION_FIXED', 'CANCEL_FILE'], INTEGRITY: [], FILE_CHANGED: []
    };
    Object.keys(expected).forEach((type) => {
      const kind = ['PARTNER', 'DATE', 'AMOUNT', 'ZERO_AMOUNT', 'PRIOR_YEAR'].includes(type) ?
        (type === 'PARTNER' ? 'PARTNER_GROUP' : 'TRANSACTION') : 'FILE';
      const options = call('resolveOptionsFor_', [{kind, reviewType: type}, 'SYSTEM_ADMIN', live()]);
      assert.deepEqual(options.map((option) => option.code), expected[type], type);
    });
  });
  test('ops menu 9: menu selection accepts full-width digits only within bounds', () => {
    assert.equal(gas.call('parseMenuSelection_', [' ３ ', 15]), 3);
    ['0', '16', 'a', ''].forEach((value) => assert.equal(gas.call('parseMenuSelection_', [value, 15]), null));
  });
  test('ops menu 10: corrected date and amount parsers distinguish blank from invalid', () => {
    assert.equal(gas.call('parseCorrectedDate_', ['2026/1/5']), '2026-01-05');
    assert.equal(gas.call('parseCorrectedDate_', ['20260105']), '2026-01-05');
    assert.equal(gas.call('parseCorrectedDate_', ['2026-02-30']), null);
    assert.equal(gas.call('parseCorrectedDate_', ['']), '');
    assert.equal(gas.call('parseCorrectedAmount_', ['1,200']), 1200);
    assert.equal(gas.call('parseCorrectedAmount_', ['−500']), -500);
    assert.equal(gas.call('parseCorrectedAmount_', ['12.5']), null);
    assert.equal(gas.call('parseCorrectedAmount_', ['']), '');
  });
  test('ops regression: corrected date and amount parsers enforce operational bounds', () => {
    const today = new Date('2026-09-14T00:00:00Z');
    assert.equal(gas.call('parseCorrectedDate_', ['2000-01-01', today]), '2000-01-01');
    assert.equal(gas.call('parseCorrectedDate_', ['1999-12-31', today]), null);
    assert.equal(gas.call('parseCorrectedDate_', ['2027-09-14', today]), '2027-09-14');
    assert.equal(gas.call('parseCorrectedDate_', ['2027-09-15', today]), null);
    assert.equal(gas.call('parseCorrectedAmount_', ['99,999,999']), 99999999);
    assert.equal(gas.call('parseCorrectedAmount_', ['-99,999,999']), -99999999);
    assert.equal(gas.call('parseCorrectedAmount_', ['100,000,000']), null);
    assert.equal(gas.call('parseCorrectedAmount_', ['-100,000,000']), null);
  });
  test('ops regression: normalized blank merchants use the missing-name label', () => {
    const built = call('buildResolveTargets_', [[review('blankMerchant', 'PARTNER', {merchantOriginal: '　'})], scope()]);
    assert.equal(built.items.length, 1);
    assert.equal(built.items[0].merchantOriginal, '（店名なし）');
    assert.equal(gas.call('menuReviewStoredIdentity_', [{merchantOriginal: '　', fileNameOriginal: 'source.csv',
      sourceRow: 9, displayTxId: null}]), '（店名なし） / source.csv 9 行目');
  });
  test('ops regression: review status labels never expose raw enum values', () => {
    const expected = {OPEN: '未対応', IN_PROGRESS: '対応中', RESOLVED: '解決済み',
      EXCLUDED: '対象外', NOT_FOUND: '見つかりません'};
    Object.keys(expected).forEach((status) => {
      assert.equal(gas.call('menuReviewStatusLabel_', [status]), expected[status]);
    });
  });
  test('ops regression: an emptied PARTNER group reports the actual review status', () => {
    gas.stubs.reset();
    const listed = review('changedStatus', 'PARTNER');
    const changed = review('changedStatus', 'PARTNER', {status: 'EXCLUDED'});
    gas.stubs.setPromptResponses([{button: 'OK', text: '1'}]);
    return withMocks({loadSettingsFromProperties: () => {}, menuViewerScope_: () => scope(),
      openReviews: () => [listed], getReviewById: () => changed}, () => {
      gas.call('menuResolveReview', []);
      const alert = gas.stubs.getUiEvents().filter((event) => event.type === 'alert').at(-1);
      assert.match(alert.prompt, /状態が変わっています（現在: 対象外）。/);
      assert.doesNotMatch(alert.prompt, /EXCLUDED|RESOLVED/);
    });
  });
  test('ops regression: recheck confirmation describes the pending operation in present tense', () => {
    const text = gas.call('buildRecheckConfirmationText_', [
      {fileId: 'fix', customerId: 'C001', fileNameOriginal: 'fix.csv'}, scope(), new Date()]);
    assert.match(text, /次の操作を実行します。/);
    assert.doesNotMatch(text, /■ 実行した操作:/);
  });
  test('ops menu 11: option disabling and max-per-action text use supplied values', () => {
    const reviewerFormat = call('resolveOptionsFor_', [
      {kind: 'FILE', reviewType: 'FORMAT_UNKNOWN'}, 'REVIEWER', live()]);
    const adminFormat = call('resolveOptionsFor_', [
      {kind: 'FILE', reviewType: 'FORMAT_UNKNOWN'}, 'SYSTEM_ADMIN', live()]);
    const importedPartner = call('resolveOptionsFor_', [
      {kind: 'PARTNER_GROUP', reviewType: 'PARTNER'}, 'REVIEWER', live({freeeStatus: 'IMPORTED'})]);
    const fileWithLiveTransaction = call('resolveOptionsFor_', [
      {kind: 'FILE', reviewType: 'FORMAT_UNKNOWN'}, 'REVIEWER', {liveTransactionCount: 1}]);
    const reviewerInputLimit = call('resolveOptionsFor_', [
      {kind: 'FILE', reviewType: 'INPUT_LIMIT'}, 'REVIEWER', {liveTransactionCount: 0}]);
    const disabledRegister = reviewerFormat.find((option) => option.code === 'REGISTER_FORMAT');
    assert.equal(disabledRegister.enabled, false);
    assert.match(disabledRegister.disabledReason, /システム管理者のみ/);
    assert.equal(adminFormat.find((option) => option.code === 'REGISTER_FORMAT').enabled, true);
    assert.equal(importedPartner.find((option) => option.code === 'EXCLUDE').enabled, false);
    assert.equal(fileWithLiveTransaction.find((option) => option.code === 'CANCEL_FILE').enabled, false);
    assert.equal(reviewerInputLimit.find((option) => option.code === 'RESIZE_INPUT').enabled, true);

    const item = {kind: 'PARTNER_GROUP', reviewType: 'PARTNER', customerId: 'C001', customerName: '顧客一',
      reviews: Array.from({length: 5}, (_, i) => review('g' + i, 'PARTNER'))};
    const options = call('resolveOptionsFor_', [item, 'REVIEWER', live()]);
    const optionText = gas.call('renderResolveOptionPrompt_', [item, options,
      {maxPerAction: 2, live: live()}, scope(), new Date('2026-09-10T03:00:00Z')]);
    const confirmText = gas.call('buildResolveConfirmationText_', [item, 'ADOPT_EXISTING_PARTNER',
      {reviewId: 'g0', partnerName: '株式会社テスト'}, {maxPerAction: 2, live: live(), partnerKnown: true},
      scope(), new Date('2026-09-10T03:00:00Z')]);
    assert.match(optionText, /5 件のうち 2 件/); assert.match(confirmText, /5 件のうち 2 件/);
  });

  const catalogCases = [
    ['12', 'ADOPT_EXISTING_PARTNER', 'PARTNER', 'GROUP'], ['13', 'ADOPT_EXISTING_PARTNER', 'PARTNER', 'GROUP'],
    ['14', 'RESOLVE_WITHOUT_PARTNER', 'PARTNER', 'GROUP'], ['15', 'ADOPT_EXISTING_PARTNER', 'PARTNER', 'GROUP'],
    ['16', 'EXCLUDE', 'PARTNER', 'SINGLE'], ['16b', 'EXCLUDE', 'PARTNER', 'SINGLE'],
    ['17', 'FIX_DATE_AMOUNT', 'DATE', 'SINGLE'], ['18', 'POST_ZERO_AMOUNT', 'ZERO_AMOUNT', 'SINGLE'],
    ['19', 'CONFIRM_EMPTY_FILE', 'EMPTY_FILE', 'FILE'],
    ['20', 'APPROVE_COUNT_MISMATCH', 'COUNT_TOTAL_MISMATCH', 'FILE'],
    ['20b', 'APPROVE_COUNT_MISMATCH', 'COUNT_TOTAL_MISMATCH', 'FILE'],
    ['21', 'RESIZE_INPUT', 'INPUT_LIMIT', 'FILE'], ['22', 'KEEP_ORIGINAL_RESULT', 'DUPLICATE', 'FILE'],
    ['23', 'REGISTER_FORMAT', 'FORMAT_UNKNOWN', 'FILE'], ['24', 'CANCEL_FILE', 'FORMAT_UNKNOWN', 'FILE'],
    ['24b', 'CANCEL_FILE', 'FORMAT_UNKNOWN', 'FILE'], ['24c', 'CANCEL_FILE', 'FORMAT_UNKNOWN', 'FILE'],
    ['25', 'REGISTER_FORMAT', 'FORMAT_UNKNOWN', 'FILE'], ['26', 'REGISTER_FORMAT', 'FORMAT_UNKNOWN', 'FILE'],
    ['27', 'ADOPT_EXISTING_PARTNER', 'PARTNER', 'GROUP'], ['28', 'REGISTER_FORMAT', 'FORMAT_UNKNOWN', 'FILE'],
    ['29', 'ADOPT_EXISTING_PARTNER', 'PARTNER', 'GROUP'], ['30', 'ADOPT_EXISTING_PARTNER', 'PARTNER', 'GROUP'],
    ['31', 'EXCLUDE', 'PARTNER', 'SINGLE'], ['32', 'CANCEL_FILE', 'FORMAT_UNKNOWN', 'FILE'],
    ['33', 'ADOPT_EXISTING_PARTNER', 'PARTNER', 'GROUP'], ['34', 'ADOPT_EXISTING_PARTNER', 'PARTNER', 'GROUP'],
    ['34b', 'ADOPT_EXISTING_PARTNER', 'PARTNER', 'GROUP'], ['35', 'ADOPT_EXISTING_PARTNER', 'PARTNER', 'GROUP'],
    ['35b', 'CONFIRM_EMPTY_FILE', 'EMPTY_FILE', 'FILE'], ['35c', 'REGISTER_FORMAT', 'FORMAT_UNKNOWN', 'FILE'],
    ['35d', 'ADOPT_EXISTING_PARTNER', 'PARTNER', 'GROUP'],
    ['35e', 'RESOLVE_WITHOUT_PARTNER', 'PARTNER', 'GROUP'],
    ['35f', 'RESOLVE_WITHOUT_PARTNER', 'PARTNER', 'GROUP'],
    ['36', 'RESOLVE_WITHOUT_PARTNER', 'PARTNER', 'GROUP'], ['37', 'ADOPT_EXISTING_PARTNER', 'PARTNER', 'GROUP'],
    ['38', 'ADOPT_EXISTING_PARTNER', 'PARTNER', 'GROUP'], ['39', 'FIX_DATE_AMOUNT', 'DATE', 'SINGLE'],
    ['40', 'ADOPT_EXISTING_PARTNER', 'PARTNER', 'GROUP'],
    ['41', 'REGISTER_FORMAT', 'FORMAT_UNKNOWN', 'FILE'], ['42', 'REGISTER_FORMAT', 'FORMAT_UNKNOWN', 'FILE'],
    ['43', 'RECHECK', 'CUSTOMER_FIX_REQUIRED', 'FILE'], ['44', 'RECHECK', 'CUSTOMER_FIX_REQUIRED', 'FILE'],
    ['45', 'RECHECK', 'CUSTOMER_FIX_REQUIRED', 'FILE'], ['45b', 'RECHECK', 'CUSTOMER_FIX_REQUIRED', 'FILE'],
    ['46', 'RECHECK', 'CUSTOMER_FIX_REQUIRED', 'FILE'], ['47', 'ADOPT_EXISTING_PARTNER', 'PARTNER', 'GROUP'],
    ['48', 'ADOPT_EXISTING_PARTNER', 'PARTNER', 'GROUP'], ['48b', 'ORPHAN_COMMIT', 'PARTNER', 'GROUP'],
    ['49', 'OPS_COMPATIBILITY', 'PARTNER', 'GROUP'], ['50', 'SCHEDULED_IMPORT', 'PARTNER', 'GROUP']
  ];
  catalogCases.forEach(([id, code, type, unit]) => {
    test(`ops menu ${id}: specification contract for ${code}`, () => {
      if (id === '12') {
        const learns = [];
        const rows = Array.from({length: 3}, (_, index) => review('learn' + index, 'PARTNER', {fileId: 'file'}));
        return withMocks(applyMocks({resolveReview: (reviewId, operation, input) => {
          learns.push(input.learn); return {committed: true, unmetConditions: [], openReviewTypes: []};
        }}), () => {
          const outcome = call('applyResolveDecision_', [applyItem(rows), 'ADOPT_EXISTING_PARTNER',
            {reviewId: rows[0].reviewId, partnerName: '株式会社テスト'},
            {maxPerAction: 3, deadlineMs: 999999, tripWorstMs: 0}]);
          assert.deepEqual(learns, [true, false, false]); assert.equal(outcome.resolved, 3);
        });
      }
      if (id === '13') {
        const candidates = call('menuReviewCandidates_', [review('candidate', 'PARTNER', {
          candidates: JSON.stringify([{partnerName: '株式会社候補', matchMethod: 'exact'}])})]);
        assert.equal(candidates[gas.call('parseMenuSelection_', ['1', candidates.length]) - 1].partnerName,
          '株式会社候補');
        return;
      }
      if (id === '14') {
        return withMocks(applyMocks({resolveReview: () => ({committed: false,
          unmetConditions: ['OPEN_REVIEW_REMAINS', 'PLANNED_B_EMPTY'], openReviewTypes: ['DATE'],
          transactionStatus: 'REVIEW_REQUIRED'})}), () => {
          const item = applyItem([review('unmet', 'PARTNER')]);
          const outcome = call('applyResolveDecision_', [item, 'RESOLVE_WITHOUT_PARTNER', {reviewId: 'unmet'},
            {deadlineMs: 999999, tripWorstMs: 0}]);
          assert.deepEqual(outcome.unmet, [{reviewId: 'unmet',
            unmetConditions: ['OPEN_REVIEW_REMAINS', 'PLANNED_B_EMPTY'], openReviewTypes: ['DATE'],
            transactionStatus: 'REVIEW_REQUIRED'}]);
          const text = gas.call('buildResolveResultText_', [item, 'RESOLVE_WITHOUT_PARTNER',
            {reviewId: 'unmet'}, outcome, scope(), new Date()]);
          assert.match(text, /未確定: 1 件.*残る要確認: 日付/); assert.match(text, /利用日が未確定/);
        });
      }
      if (id === '15') {
        const item = applyItem([review('known', 'PARTNER')]);
        const unknown = gas.call('buildResolveConfirmationText_', [item, 'ADOPT_EXISTING_PARTNER',
          {reviewId: 'known', partnerName: '未登録名'},
          {maxPerAction: 1, live: live(), partnerKnown: false}, scope(), new Date()]);
        const known = gas.call('buildResolveConfirmationText_', [item, 'ADOPT_EXISTING_PARTNER',
          {reviewId: 'known', partnerName: '登録済名'},
          {maxPerAction: 1, live: live(), partnerKnown: true}, scope(), new Date()]);
        assert.match(unknown, /取引先一覧に無い名前です/);
        assert.doesNotMatch(known, /取引先一覧に無い名前です/);
        return;
      }
      if (id === '16b') {
        const options = call('resolveOptionsFor_', [applyItem([review('imported', 'PARTNER')]),
          'REVIEWER', live({freeeStatus: 'IMPORTED'})]);
        assert.equal(options.find((option) => option.code === 'EXCLUDE').enabled, false);
        return;
      }
      if (id === '17') {
        const seen = [];
        return withMocks(applyMocks({resolveReview: (reviewId, operation, input) => {
          seen.push(plain(input)); return {committed: true, unmetConditions: [], openReviewTypes: []};
        }}), () => {
          call('applyResolveDecision_', [applyItem([review('date', 'DATE')], 'TRANSACTION', 'DATE'),
            'FIX_DATE_AMOUNT', {reviewId: 'date', correctedDate: '2026-01-05', correctedAmount: ''},
            {deadlineMs: 999999, tripWorstMs: 0}]);
          assert.equal(seen[0].correctedDate, '2026-01-05');
          assert.equal(Object.hasOwn(seen[0], 'correctedAmount'), false,
            '空文字を渡すと部品が M 列を 0 にするため、鍵そのものを落とす');
        });
      }
      if (id === '18') {
        const postZero = catalog().POST_ZERO_AMOUNT;
        const postPrior = catalog().POST_PRIOR_YEAR;
        const excludePrior = catalog().EXCLUDE_PRIOR_YEAR;
        assert.equal(postZero.unit, 'SINGLE'); assert.equal(postZero.clearsRow, false);
        assert.equal(postPrior.unit, 'SINGLE'); assert.equal(postPrior.clearsRow, false);
        assert.equal(excludePrior.unit, 'SINGLE'); assert.equal(excludePrior.clearsRow, true);
        return;
      }
      if (id === '19') {
        const seeded = setupFileReview('EMPTY_FILE');
        const outcome = call('applyResolveDecision_', [seeded.item, 'CONFIRM_EMPTY_FILE',
          {reviewId: seeded.reviewId}, {readLeases: () => [], deadlineMs: 999999, tripWorstMs: 0}]);
        assert.equal(outcome.resolved, 1); assert.equal(gas.call('getFileState', ['file1']), 'COMPLETED');
        assert.equal(gas.call('getReviewById', [seeded.reviewId]).status, 'RESOLVED');
        return;
      }
      if (id === '20') {
        const seeded = setupFileReview('COUNT_TOTAL_MISMATCH');
        const outcome = call('applyResolveDecision_', [seeded.item, 'APPROVE_COUNT_MISMATCH',
          {reviewId: seeded.reviewId}, {readLeases: () => [], deadlineMs: 999999, tripWorstMs: 0}]);
        assert.equal(outcome.resolved, 1); assert.equal(gas.call('getFileState', ['file1']), 'DISCOVERED');
        assert.equal(plain(gas.call('getCategory2Approvals', ['file1'])).length, 1);
        return;
      }
      if (id === '20b') {
        const seeded = setupFileReview('COUNT_TOTAL_MISMATCH');
        call('applyResolveDecision_', [seeded.item, 'APPROVE_COUNT_MISMATCH',
          {reviewId: seeded.reviewId}, {readLeases: () => [], deadlineMs: 999999, tripWorstMs: 0}]);
        assert.equal(gas.call('hasCategory2Approval', ['file1', 'COUNT_TOTAL_MISMATCH',
          'c'.repeat(64), '3']), true);
        return;
      }
      if (id === '21') {
        const seeded = setupFileReview('INPUT_LIMIT');
        const outcome = call('applyResolveDecision_', [seeded.item, 'RESIZE_INPUT',
          {reviewId: seeded.reviewId}, {readLeases: () => [], deadlineMs: 999999, tripWorstMs: 0}]);
        assert.equal(outcome.resolved, 1);
        assert.equal(gas.call('getFileState', ['file1']), 'CUSTOMER_FIX_REQUIRED');
        return;
      }
      if (id === '22') {
        const seeded = setupFileReview('DUPLICATE');
        const outcome = call('applyResolveDecision_', [seeded.item, 'KEEP_ORIGINAL_RESULT',
          {reviewId: seeded.reviewId}, {readLeases: () => [], deadlineMs: 999999, tripWorstMs: 0}]);
        assert.equal(outcome.resolved, 1); assert.equal(gas.call('getFileState', ['file1']), 'EXCLUDED');
        return;
      }
      if (id === '23') {
        const seeded = setupFileReview('FORMAT_UNKNOWN', 'admin@example.com');
        const outcome = call('applyResolveDecision_', [seeded.item, 'REGISTER_FORMAT',
          {reviewId: seeded.reviewId}, {readLeases: () => [], deadlineMs: 999999, tripWorstMs: 0}]);
        assert.equal(outcome.resolved, 1); assert.equal(gas.call('getFileState', ['file1']), 'DISCOVERED');
        return;
      }
      if (id === '24') {
        const item = applyItem([review('cancelWarning', 'FORMAT_UNKNOWN')], 'FILE', 'FORMAT_UNKNOWN');
        const text = gas.call('buildResolveConfirmationText_', [item, 'CANCEL_FILE',
          {reviewId: 'cancelWarning'}, {maxPerAction: 1, live: {liveTransactionCount: 0}}, scope(), new Date()]);
        assert.match(text, /画面から取り消せません/); return;
      }
      if (id === '24b') {
        let transactionReads = 0;
        return withMocks(applyMocks({authorizeOperation: () => { throw new Error('denied'); },
          getTransactionsByStatus: () => { transactionReads += 1; return [{}]; }}), () => {
          assert.throws(() => gas.call('applyResolveDecision_', [
            applyItem([review('file', 'FORMAT_UNKNOWN')], 'FILE', 'FORMAT_UNKNOWN'), 'CANCEL_FILE',
            {reviewId: 'file'}, {deadlineMs: 999999, tripWorstMs: 0}]), /denied/);
          assert.equal(transactionReads, 0, '0件確認より認可が先でなければ拒否監査が残らない');
        });
      }
      if (id === '24c') {
        gas.stubs.reset(); let applied = 0;
        const row = review('cancelNo', 'FORMAT_UNKNOWN');
        gas.stubs.setPromptResponses([{button: 'OK', text: '1'}, {button: 'OK', text: '2'}]);
        gas.stubs.setAlertResponses(['NO']);
        return withMocks({loadSettingsFromProperties: () => {}, menuViewerScope_: () => scope(),
          openReviews: () => [row], getReviewById: () => row, getTransactionsByStatus: () => [],
          applyResolveDecision_: () => { applied += 1; return {}; }}, () => {
          gas.call('menuResolveReview', []);
          assert.equal(applied, 0); assert.equal(gas.stubs.getApiCallCounts().batchUpdate, 0);
        });
      }
      if (id === '25') {
        gas.stubs.reset(); let applied = 0;
        const row = review('disabledFormat', 'FORMAT_UNKNOWN');
        gas.stubs.setPromptResponses([{button: 'OK', text: '1'}, {button: 'OK', text: '1'}]);
        return withMocks({loadSettingsFromProperties: () => {}, menuViewerScope_: () => scope(),
          openReviews: () => [row], getReviewById: () => row, getTransactionsByStatus: () => [],
          applyResolveDecision_: () => { applied += 1; return {}; }}, () => {
          gas.call('menuResolveReview', []);
          assert.equal(applied, 0); assert.equal(gas.stubs.getApiCallCounts().batchUpdate, 0);
          assert.match(gas.stubs.getUiEvents().filter((event) => event.type === 'alert').at(-1).prompt,
            /システム管理者のみ/);
        });
      }
      if (id === '26') {
        assertDirectPermissionDenial(id, 'C001', 'reviewer@example.com', 'ROLE_INSUFFICIENT'); return;
      }
      if (id === '27') {
        assertDirectPermissionDenial(id, 'C002', 'reviewer@example.com', 'NO_CUSTOMER_ACCESS'); return;
      }
      if (id === '28') {
        assertDirectPermissionDenial(id, 'C002', 'admin@example.com', 'ROLE_INSUFFICIENT'); return;
      }
      if (id === '29') {
        assert.equal(typeof gas.stubs.setAlertResponses, 'function');
        assert.equal(gas.evaluate('typeof menuResolveReview'), 'function');
        return;
      }
      if (id === '30') {
        setupAuthorizationCustomers();
        gas.stubs.setActiveUser(''); gas.call('menuResolveReview', []);
        assert.match(gas.stubs.getUiEvents().filter((event) => event.type === 'alert').at(-1).prompt,
          /メールアドレスを取得できない/);
        setupAuthorizationCustomers();
        gas.stubs.setActiveUser('nobody@example.com'); gas.call('menuResolveReview', []);
        assert.match(gas.stubs.getUiEvents().filter((event) => event.type === 'alert').at(-1).prompt,
          /閲覧を許可された顧客がありません/);
        return;
      }
      if (id === '31') {
        let input;
        return withMocks(applyMocks({resolveReview: (reviewId, operation, value) => {
          input = plain(value); return {committed: false, unmetConditions: [], openReviewTypes: []};
        }}), () => {
          call('applyResolveDecision_', [applyItem([review('exclude', 'PARTNER')]), 'EXCLUDE',
            {reviewId: 'exclude'}, {deadlineMs: 999999, tripWorstMs: 0}]);
          assert.equal(Object.hasOwn(input, 'allowImported'), false);
        });
      }
      if (id === '32') {
        let writes = 0;
        return withMocks(applyMocks({getTransactionsByStatus: () => [{fullTxId: 'live'}],
          resolveFileReview: () => { writes += 1; return {}; }}), () => {
          assert.throws(() => gas.call('applyResolveDecision_', [
            applyItem([review('cancel', 'FORMAT_UNKNOWN')], 'FILE', 'FORMAT_UNKNOWN'), 'CANCEL_FILE',
            {reviewId: 'cancel'}, {deadlineMs: 999999, tripWorstMs: 0}]),
          (error) => error && error.name === 'StateTransitionError');
          assert.equal(writes, 0);
        });
      }
      if (id === '33') {
        const rows = Array.from({length: 5}, (_, index) => review('limit' + index, 'PARTNER', {fileId: 'one'}));
        return withMocks(applyMocks(), () => {
          const outcome = call('applyResolveDecision_', [applyItem(rows), 'RESOLVE_WITHOUT_PARTNER',
            {reviewId: rows[0].reviewId}, {maxPerAction: 2, deadlineMs: 999999, tripWorstMs: 0}]);
          assert.deepEqual({resolved: outcome.resolved, notAttempted: outcome.notAttempted,
            maxPerAction: outcome.maxPerAction}, {resolved: 2, notAttempted: 3, maxPerAction: 2});
          const text = gas.call('buildResolveResultText_', [applyItem(rows), 'RESOLVE_WITHOUT_PARTNER',
            {reviewId: rows[0].reviewId}, outcome, scope(), new Date()]);
          assert.match(text, /5 件のうち 2 件（この押下の上限）/);
          assert.match(text, /1 回の上限 2 件/);
        });
      }
      if (id === '34') {
        let writes = 0; let cleanup = 0;
        return withMocks(applyMocks({resolveReview: () => { writes += 1; return {}; },
          commitSettledTransactions_: () => { cleanup += 1; return {deferred: 0}; },
          completeFileIfFullyResolved_: () => { cleanup += 1; return {}; }}), () => {
          const outcome = call('applyResolveDecision_', [applyItem([review('time', 'PARTNER')]),
            'RESOLVE_WITHOUT_PARTNER', {reviewId: 'time'}, {deadlineMs: 0, tripWorstMs: 1}]);
          assert.equal(writes, 0); assert.equal(cleanup, 0); assert.equal(outcome.notAttempted, 1);
        });
      }
      if (id === '34b') {
        let elapsed = 0;
        const rows = Array.from({length: 5}, (_, index) => review('budget' + index, 'PARTNER',
          {fileId: index < 3 ? 'fileA' : 'fileB'}));
        return withMocks(applyMocks({resolveReview: () => {
          elapsed += 50000; return {committed: true, unmetConditions: [], openReviewTypes: []};
        }}), () => {
          const outcome = call('applyResolveDecision_', [applyItem(rows), 'RESOLVE_WITHOUT_PARTNER',
            {reviewId: rows[0].reviewId}, {clock: () => elapsed, deadlineMs: 200000, tripWorstMs: 1000,
              itemTrips: 60, cleanupTrips: 62, maxPerAction: 10}]);
          assert.equal(outcome.resolved, 1, '後始末予算は item ではなく2つの fileId を数える');
          assert.equal(outcome.notAttempted, 4);
        });
      }
      if (id === '35b') {
        let writes = 0;
        return withMocks(applyMocks({resolveFileReview: () => {
          writes += 1; return {nextState: 'COMPLETED'};
        }}), () => {
          const item = applyItem([review('emptyLease', 'EMPTY_FILE', {fileId: 'leased'})], 'FILE', 'EMPTY_FILE');
          assert.throws(() => gas.call('applyResolveDecision_', [item, 'CONFIRM_EMPTY_FILE',
            {reviewId: 'emptyLease'}, {readLeases: () => [{fileId: 'leased', owner: 'worker'}],
              deadlineMs: 999999, tripWorstMs: 0}]),
          (error) => error && error.code === 'LEASE_CONFLICT');
          assert.equal(writes, 0);
          const outcome = call('applyResolveDecision_', [item, 'CONFIRM_EMPTY_FILE',
            {reviewId: 'emptyLease'}, {readLeases: () => [], deadlineMs: 999999, tripWorstMs: 0}]);
          assert.equal(outcome.resolved, 1); assert.equal(writes, 1);
        });
      }
      if (id === '35c') {
        let writes = 0; let rewinds = 0;
        return withMocks(applyMocks({resolveFileReview: () => {
          writes += 1; return {nextState: 'VALIDATING'};
        }, rewindFileForReimportAudited_: () => { rewinds += 1; }}), () => {
          const item = applyItem([review('formatLease', 'FORMAT_UNKNOWN', {fileId: 'leased'})],
            'FILE', 'FORMAT_UNKNOWN');
          assert.throws(() => gas.call('applyResolveDecision_', [item, 'REGISTER_FORMAT',
            {reviewId: 'formatLease'}, {readLeases: () => [{fileId: 'leased', owner: 'worker'}],
              deadlineMs: 999999, tripWorstMs: 0}]),
          (error) => error && error.code === 'LEASE_CONFLICT');
          assert.equal(writes, 0); assert.equal(rewinds, 0);
          const outcome = call('applyResolveDecision_', [item, 'REGISTER_FORMAT',
            {reviewId: 'formatLease'}, {readLeases: () => [], deadlineMs: 999999, tripWorstMs: 0}]);
          assert.equal(outcome.resolved, 1); assert.equal(writes, 1); assert.equal(rewinds, 1);
        });
      }
      if (id === '35d') {
        let stateReads = 0;
        return withMocks({getFileState: () => { stateReads += 1; return 'REVIEW_WAIT'; },
          isFileFullyResolved: () => true, transitionFileState: () => {}}, () => {
          const result = call('completeFileIfFullyResolved_', ['leased',
            {readLeases: () => [{fileId: 'leased'}]}]);
          assert.equal(result.skipped, 'LEASE'); assert.equal(stateReads, 0);
        });
      }
      if (id === '35') {
        let error = new Error('lease'); error.code = 'LEASE_CONFLICT'; error.detail = 'Lease owned by worker';
        return withMocks(applyMocks({resolveReview: () => { throw error; }}), () => {
          const outcome = call('applyResolveDecision_', [applyItem([review('adoptLease', 'PARTNER')]),
            'ADOPT_EXISTING_PARTNER', {reviewId: 'adoptLease', partnerName: '会社'},
            {deadlineMs: 999999, tripWorstMs: 0}]);
          assert.equal(outcome.resolved, 0); assert.equal(outcome.errors[0].code, 'LEASE_CONFLICT');
          assert.match(outcome.errors[0].message, /今回は書き込みませんでした/);
        });
      }
      if (id === '35e') {
        let transitions = 0;
        return withMocks({activeLeases_: () => [{fileId: 'leased'}], getFileState: () => 'REVIEW_WAIT',
          isFileFullyResolved: () => true, transitionFileState: () => { transitions += 1; }}, () => {
          assert.equal(call('completeFileIfFullyResolved_', ['leased']).skipped, 'LEASE');
          assert.equal(call('completeFileIfFullyResolved_', ['leased', {skipLeaseCheck: true}]).completed, true);
          assert.equal(transitions, 1);
        });
      }
      if (id === '35f') {
        let writes = 0;
        return withMocks(applyMocks({activeLeases_: () => [{fileId: 'leaseFile', owner: 'worker', acquiredAt: 'now'}],
          resolveReview: () => { writes += 1; return {}; }}), () => {
          const outcome = call('applyResolveDecision_', [applyItem([
            review('leaseTx', 'PARTNER', {fileId: 'leaseFile'})]), 'RESOLVE_WITHOUT_PARTNER',
            {reviewId: 'leaseTx'}, {deadlineMs: 999999, tripWorstMs: 0}]);
          assert.equal(writes, 0); assert.equal(outcome.errors[0].code, 'LEASE_CONFLICT');
          const inverse = call('applyResolveDecision_', [applyItem([
            review('leaseTx', 'PARTNER', {fileId: 'leaseFile'})]), 'RESOLVE_WITHOUT_PARTNER',
            {reviewId: 'leaseTx'}, {readLeases: () => [], deadlineMs: 999999, tripWorstMs: 0}]);
          assert.equal(inverse.resolved, 1); assert.equal(writes, 1);

          writes = 0;
          const zero = applyItem([review('zeroLease', 'ZERO_AMOUNT', {fileId: 'leaseFile'})],
            'TRANSACTION', 'ZERO_AMOUNT');
          const blockedZero = call('applyResolveDecision_', [zero, 'POST_ZERO_AMOUNT',
            {reviewId: 'zeroLease'}, {deadlineMs: 999999, tripWorstMs: 0}]);
          assert.equal(blockedZero.errors[0].code, 'LEASE_CONFLICT'); assert.equal(writes, 0);
          const allowedZero = call('applyResolveDecision_', [zero, 'POST_ZERO_AMOUNT',
            {reviewId: 'zeroLease'}, {readLeases: () => [], deadlineMs: 999999, tripWorstMs: 0}]);
          assert.equal(allowedZero.resolved, 1); assert.equal(writes, 1);
        });
      }
      if (id === '36') {
        let reads = 0;
        const rows = [review('l1', 'PARTNER', {fileId: 'leased'}),
          review('l2', 'PARTNER', {fileId: 'leased'}), review('ok', 'PARTNER', {fileId: 'free'})];
        return withMocks(applyMocks({completeFileIfFullyResolved_: (fileId, options) => {
          options.readLeases(); return {fileId, completed: false, state: 'REVIEW_WAIT', skipped: null};
        }}), () => {
          const outcome = call('applyResolveDecision_', [applyItem(rows), 'RESOLVE_WITHOUT_PARTNER',
            {reviewId: 'l1'}, {maxPerAction: 3, deadlineMs: 999999, tripWorstMs: 0,
              readLeases: () => { reads += 1; return [{fileId: 'leased', owner: 'worker'}]; }}]);
          assert.deepEqual({resolved: outcome.resolved, errors: outcome.errors.length,
            skipped: outcome.skippedByLease}, {resolved: 1, errors: 1, skipped: 1});
          assert.equal(reads, 3, 'ループ内2ファイルと成功ファイルの完了判定で各1回');
        });
      }
      if (id === '37') {
        const Transition = gas.evaluate('StateTransitionError');
        return withMocks(applyMocks({resolveReview: (reviewId) => {
          if (reviewId === 'stale') throw new Transition('Review is already settled: stale');
          return {committed: true, unmetConditions: [], openReviewTypes: []};
        }}), () => {
          const outcome = call('applyResolveDecision_', [applyItem([
            review('okFirst', 'PARTNER'), review('stale', 'PARTNER')]), 'ADOPT_EXISTING_PARTNER',
            {reviewId: 'okFirst', partnerName: '会社'}, {maxPerAction: 2, deadlineMs: 999999, tripWorstMs: 0}]);
          assert.equal(outcome.resolved, 1); assert.equal(outcome.errors.length, 1);
          assert.match(outcome.errors[0].message, /既に解決済み/);
        });
      }
      if (id === '38') {
        const fault = new Error('Injected fault'); fault.code = 'FAULT_INJECTED'; fault.pointId = 'SHEET_WRITE_RAW_BEFORE';
        return withMocks(applyMocks({resolveReview: () => { throw fault; }}), () => {
          const outcome = call('applyResolveDecision_', [applyItem([review('fault', 'PARTNER')]),
            'ADOPT_EXISTING_PARTNER', {reviewId: 'fault', partnerName: '会社'},
            {deadlineMs: 999999, tripWorstMs: 0}]);
          assert.match(outcome.errors[0].message, /SHEET_WRITE_RAW_BEFORE/);
        });
      }
      if (id === '39') {
        const fault = new Error('Injected fault'); fault.code = 'FAULT_INJECTED';
        fault.pointId = 'SHEET_WRITE_USER_ENTERED_BEFORE';
        return withMocks(applyMocks({resolveReview: () => { throw fault; }}), () => {
          const outcome = call('applyResolveDecision_', [
            applyItem([review('fixFault', 'DATE')], 'TRANSACTION', 'DATE'), 'FIX_DATE_AMOUNT',
            {reviewId: 'fixFault', correctedDate: '2026-01-05'},
            {deadlineMs: 999999, tripWorstMs: 0}]);
          assert.equal(outcome.resolved, 0);
          assert.match(outcome.errors[0].message, /SHEET_WRITE_USER_ENTERED_BEFORE/);
        });
      }
      if (id === '40') {
        let cleanup = 0;
        return withMocks(applyMocks({commitSettledTransactions_: () => {
          cleanup += 1; return {committed: ['orphan'], deferred: 0};
        }}), () => {
          call('applyResolveDecision_', [applyItem([review('triggerCleanup', 'PARTNER')]),
            'RESOLVE_WITHOUT_PARTNER', {reviewId: 'triggerCleanup'}, {deadlineMs: 999999, tripWorstMs: 0}]);
          assert.equal(cleanup, 1);
        });
      }
      if (id === '41') {
        return withMocks(applyMocks({resolveFileReview: () => ({nextState: 'VALIDATING'}),
          rewindFileForReimportAudited_: () => { throw new Error('rewind failed'); }}), () => {
          const outcome = call('applyResolveDecision_', [
            applyItem([review('rewind', 'FORMAT_UNKNOWN')], 'FILE', 'FORMAT_UNKNOWN'), 'REGISTER_FORMAT',
            {reviewId: 'rewind'}, {deadlineMs: 999999, tripWorstMs: 0}]);
          assert.equal(outcome.resolved, 1); assert.equal(outcome.errors[0].fileId, 'file_rewind');
          assert.equal(Object.hasOwn(outcome.errors[0], 'reviewId'), false);
        });
      }
      if (id === '42') {
        let rewound = 0;
        return withMocks({rewindFileForReimport_: () => { rewound += 1; }, appendAudit: () => {
          throw new Error('audit unavailable'); }}, () => {
          gas.call('rewindFileForReimportAudited_', ['file', 'actor',
            {from: 'VALIDATING', operation: 'REGISTER_FORMAT', customerId: 'C001'}]);
          assert.equal(rewound, 1);
          assert.match(gas.stubs.getLogLines().join('\n'), /監査ログの記録に失敗/);
        });
      }
      if (id === '43') {
        let entry;
        return withMocks({rewindFileForReimport_: () => {}, appendAudit: (value) => { entry = plain(value); }}, () => {
          gas.call('rewindFileForReimportAudited_', ['file', 'actor',
            {from: 'CUSTOMER_FIX_REQUIRED', operation: 'RECHECK', customerId: 'C001'}]);
          assert.deepEqual(entry, {type: 'REVIEW_RESOLVE', actor: 'actor', targetType: 'LOG', targetId: 'file',
            customerId: 'C001', before: {fileState: 'CUSTOMER_FIX_REQUIRED'},
            after: {fileState: 'DISCOVERED', operation: 'RECHECK'}, reason: 'MENU'});
        });
      }
      if (id === '44') {
        let rewinds = 0;
        return withMocks({authorize: () => ({userEmail: 'reviewer@example.com'}), activeLeases_: () => [],
          getFileState: () => 'COMPLETED', rewindFileForReimportAudited_: () => { rewinds += 1; }}, () => {
          assert.throws(() => gas.call('applyRecheck_', [{fileId: 'file', customerId: 'C001'}, {}]),
            (error) => error && error.name === 'StateTransitionError');
          assert.equal(rewinds, 0);
        });
      }
      if (id === '45b') {
        let leaseReads = 0;
        return withMocks({authorize: () => { throw new Error('denied'); },
          activeLeases_: () => { leaseReads += 1; return [{fileId: 'file'}]; }}, () => {
          assert.throws(() => gas.call('applyRecheck_', [{fileId: 'file', customerId: 'C001'}, {}]), /denied/);
          assert.equal(leaseReads, 0);
        });
      }
      if (id === '46') {
        return withMocks({authorize: () => ({userEmail: 'reviewer@example.com'}),
          activeLeases_: () => [{fileId: 'file', owner: 'worker', acquiredAt: 'now'}]}, () => {
          assert.throws(() => gas.call('applyRecheck_', [{fileId: 'file', customerId: 'C001'}, {}]),
            (error) => error && error.code === 'LEASE_CONFLICT');
        });
      }
      if (id === '45') {
        setupAuthorizationCustomers();
        gas.stubs.setSpreadsheetOwner('master', 'owner@example.com');
        gas.stubs.setActiveUser('owner@example.com');
        let rewound = 0;
        withMocks({activeLeases_: () => [], getFileState: () => 'CUSTOMER_FIX_REQUIRED',
          rewindFileForReimportAudited_: () => { rewound += 1; }}, () =>
          gas.call('applyRecheck_', [{fileId: 'file', customerId: 'C001'}, {}]));
        assert.equal(rewound, 1);
        gas.stubs.setActiveUser('nobody@example.com');
        assert.throws(() => gas.call('applyRecheck_', [{fileId: 'file', customerId: 'C001'},
          {readLeases: () => []}]), (error) => error && error.name === 'AuthorizationError');
        return;
      }
      if (id === '47') {
        assert.equal(gas.evaluate('typeof menuResolveReview'), 'function');
        assert.equal(typeof gas.stubs.roundTrips, 'function');
        return;
      }
      if (id === '48') {
        let transactionReads = 0; let reviewReads = 0;
        return withMocks({getTransactionsByStatus: () => { transactionReads += 1; return []; },
          openReviews: () => { reviewReads += 1; return []; }, commitIfConditionsMet: () => ({committed: false})}, () => {
          const outcome = call('commitSettledTransactions_', ['file', {maxOrphanCommits: 2}]);
          assert.equal(transactionReads, 1); assert.equal(reviewReads, 1); assert.equal(outcome.candidates, 0);
        });
      }
      if (id === '48b') {
        const evaluated = [];
        return withMocks({getTransactionsByStatus: () => [{fullTxId: 'a'}, {fullTxId: 'b'}, {fullTxId: 'c'}],
          openReviews: () => [], commitIfConditionsMet: (txId) => { evaluated.push(txId); return {committed: txId === 'c'}; }}, () => {
          const outcome = call('commitSettledTransactions_', ['file', {maxOrphanCommits: 2}]);
          assert.deepEqual(evaluated, ['a', 'b']); assert.deepEqual(outcome.committed, []);
          assert.equal(outcome.evaluated, 2); assert.equal(outcome.deferred, 1);
        });
      }
      if (id === '49') {
        setupFileReview('FORMAT_UNKNOWN');
        assert.ok(Array.isArray(plain(gas.call('completeFullyResolvedFiles_', []))));
        return;
      }
      if (id === '50') {
        setupPartnerImport(1, 1);
        return withMocks({authorize: () => { throw new Error('scheduled path called authorize'); },
          authorizeOperation: () => { throw new Error('scheduled path called authorizeOperation'); }}, () => {
          assert.doesNotThrow(() => gas.call('scheduledImportTick', []));
        });
      }
      if (code === 'RECHECK') {
        assert.equal(gas.evaluate('typeof applyRecheck_'), 'function');
        assert.equal(gas.evaluate('typeof rewindFileForReimportAudited_'), 'function');
        return;
      }
      if (code === 'ORPHAN_COMMIT') {
        assert.equal(gas.evaluate('typeof commitSettledTransactions_'), 'function'); return;
      }
      if (code === 'OPS_COMPATIBILITY') {
        assert.equal(gas.evaluate('typeof completeFullyResolvedFiles_'), 'function'); return;
      }
      if (code === 'SCHEDULED_IMPORT') {
        assert.equal(gas.evaluate('typeof scheduledImportTick'), 'function'); return;
      }
      const entries = catalog();
      assert.ok(entries[code], code); assert.equal(entries[code].unit, unit);
      assert.ok(entries[code].kinds.includes(type), `${code} must apply to ${type}`);
    });
  });

  test('ops regression: GROUP budget counts only files in capped work', () => {
    const rows = ['A', 'B', 'C'].map((fileId, index) =>
      review('capped' + index, 'PARTNER', {fileId}));
    return withMocks(applyMocks(), () => {
      const outcome = call('applyResolveDecision_', [applyItem(rows), 'RESOLVE_WITHOUT_PARTNER',
        {reviewId: rows[0].reviewId}, {maxPerAction: 1, deadlineMs: 200000,
          tripWorstMs: 1000, itemTrips: 60, cleanupTrips: 62}]);
      assert.equal(outcome.resolved, 1,
        '上限後に触る1ファイルだけなら 60+62 秒で開始できる');
      assert.equal(outcome.notAttempted, 2);
    });
  });

  test('ops integration: runImport PARTNER group crosses three files and resolves one', () => {
    setupPartnerImport(3, 1);
    gas.stubs.setPromptResponses([
      {button: 'OK', text: '1'}, {button: 'OK', text: '1'},
      {button: 'OK', text: '株式会社テスト'}
    ]);
    gas.stubs.setAlertResponses(['YES']);
    gas.call('menuResolveReview', []);
    const remaining = plain(gas.call('openReviews', [{}]));
    assert.equal(remaining.filter((row) => row.status === 'OPEN').length, 2,
      '出荷時上限1でも、触る予定の1ファイル分の後始末予算で1件進む');
    const transactions = ['partnerFile0', 'partnerFile1', 'partnerFile2']
      .flatMap((fileId) => plain(gas.call('getTransactionsByStatus', [fileId,
        ['REVIEW_REQUIRED', 'COMMITTED']])));
    assert.equal(transactions.filter((tx) => tx.transactionStatus === 'COMMITTED').length, 1);
    const destination = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート')
      .getDataRange().getValues().slice(1);
    assert.equal(destination.filter((row) => row[2] === '株式会社テスト').length, 1);
    const resultAlert = gas.stubs.getUiEvents().filter((event) => event.type === 'alert').at(-1);
    assert.match(resultAlert.prompt, /確定した要確認: 1 件/);
  });

  test('ops identity integration: imported PRIOR_YEAR target list and result fall back to fullTxId', () => {
    const seeded = setupTypedImport([
      '2025/12/16,ローソン,10800,仕入れ',
      '2025/12/17,ローソン,2900,仕入れ'
    ], {customerCategory: 'INDIVIDUAL', fiscalYear: 2027, reviewType: 'PRIOR_YEAR'});
    seeded.reviews.forEach((row) => {
      assert.equal(row.merchantOriginal, null);
      assert.equal(row.sourceRow, null);
      assert.equal(row.displayTxId, null);
      assert.ok(row.fullTxId);
    });
    const identities = seeded.reviews.map((row) => gas.call('menuReviewStoredIdentity_', [row]));
    assert.equal(new Set(identities).size, 2, '店名・行番号なしでも fullTxId で一意になる');
    seeded.reviews.forEach((row, index) => assert.ok(identities[index].includes(row.fullTxId)));
    gas.stubs.setPromptResponses([{button: 'OK', text: '1'}, {button: 'OK', text: '1'}]);
    gas.stubs.setAlertResponses(['YES']);
    gas.call('menuResolveReview', []);
    const events = gas.stubs.getUiEvents();
    const targetPrompt = events.filter((event) => event.type === 'prompt')[0].prompt;
    const targetLines = targetPrompt.split('\n').filter((line) => /^\s+\d+\)/.test(line));
    assert.equal(targetLines.length, 2, targetPrompt);
    assert.equal(new Set(targetLines.map((line) => line.replace(/^\s+\d+\)\s*/, ''))).size, 2,
      '同一ファイルの PRIOR_YEAR 2件は番号を除いた一覧本文でも区別できる');
    seeded.reviews.forEach((row) => assert.ok(targetPrompt.includes(row.fullTxId), targetPrompt));
    const result = events.filter((event) => event.type === 'alert').at(-1).prompt;
    assert.ok(result.includes(seeded.reviews[0].fullTxId), result);
  });

  test('ops identity integration: imported DATE screens use live merchant and result uses stored identity', () => {
    const seeded = setupTypedImport([
      '日付不明,ローソン,10800,仕入れ'
    ], {reviewType: 'DATE'});
    const reviewRow = seeded.reviews[0];
    assert.equal(reviewRow.merchantOriginal, null);
    assert.equal(reviewRow.sourceRow, 2);
    assert.equal(reviewRow.displayTxId, null);
    gas.stubs.setPromptResponses([
      {button: 'OK', text: '1'}, {button: 'OK', text: '1'},
      {button: 'OK', text: '2025-12-16'}, {button: 'OK', text: ''}
    ]);
    gas.stubs.setAlertResponses(['YES']);
    gas.call('menuResolveReview', []);
    const events = gas.stubs.getUiEvents();
    const transaction = plain(gas.call('getTransaction', [reviewRow.fullTxId]));
    assert.equal(transaction.originalMerchant, 'ローソン');
    assert.equal(transaction.planned.k, 'ローソン');
    const optionPrompt = events.filter((event) => event.type === 'prompt')[1].prompt;
    const confirmation = events.filter((event) => event.type === 'alert')[0].prompt;
    assert.ok(optionPrompt.includes('ローソン'), optionPrompt);
    assert.ok(confirmation.includes('ローソン'), confirmation);
    const result = events.filter((event) => event.type === 'alert').at(-1).prompt;
    assert.ok(result.includes('■ 対象: 顧客一(C001) / （店名なし） / ' +
      seeded.fileName + ' 2 行目'), result);
  });

  test('ops menu 12 integration: handler resolves three imported PARTNER rows with real effects', () => {
    const seeded = setupPartnerImport(1, 3);
    const originalMax = gas.evaluate('MENU_RESOLVE_MAX_PER_ACTION_');
    try {
      gas.evaluate('MENU_RESOLVE_MAX_PER_ACTION_ = 3;');
      gas.stubs.setPromptResponses([
        {button: 'OK', text: '1'}, {button: 'OK', text: '1'},
        {button: 'OK', text: '株式会社テスト'}
      ]);
      gas.stubs.setAlertResponses(['YES']);
      gas.call('menuResolveReview', []);
      assert.equal(plain(gas.call('openReviews', [{}])).length, 0);
      const transactions = plain(gas.call('getTransactionsByStatus', ['partnerFile0', ['COMMITTED']]));
      assert.equal(transactions.length, 3);
      const destination = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート')
        .getDataRange().getValues().slice(1);
      assert.equal(destination.filter((row) => row[2] === '株式会社テスト').length, 3);
      seeded.reviews.forEach((row) => {
        const stored = plain(gas.call('getReviewById', [row.reviewId]));
        assert.equal(stored.status, 'RESOLVED'); assert.equal(stored.reviewerEmail, 'reviewer@example.com');
        assert.equal(stored.resolveOperation, 'ADOPT_EXISTING_PARTNER'); assert.equal(stored.resolverRole, null);
      });
      const audits = gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ')
        .getDataRange().getValues().slice(1).filter((row) => row[2] === 'REVIEW_RESOLVE');
      assert.equal(audits.length, 3); assert.equal(permissionRows().length, 0);
      const dictionaryRows = ['共通取引先辞書', '顧客別取引先辞書'].reduce((count, name) => {
        const target = gas.stubs.getSpreadsheet('master').getSheetByName(name);
        return count + (target ? target.getDataRange().getValues().slice(1).filter((row) => row[0]).length : 0);
      }, 0);
      assert.equal(dictionaryRows, 1);
      assert.equal(gas.call('getFileState', ['partnerFile0']), 'COMPLETED');
      assert.match(gas.stubs.getUiEvents().filter((event) => event.type === 'alert').at(-1).prompt,
        /確定した要確認: 3 件/);
    } finally {
      gas.evaluate('MENU_RESOLVE_MAX_PER_ACTION_ = ' + Number(originalMax) + ';');
    }
  });

  test('ops menu 16 integration: imported PARTNER EXCLUDE selection and result use source identities', () => {
    const seeded = setupPartnerImport(1, 3);
    const selected = seeded.reviews[1];
    const liveBefore = seeded.reviews.map((row) => plain(gas.call('getTransaction', [row.fullTxId])));
    gas.stubs.resetUiEvents(); gas.stubs.resetApiCallCounts(); gas.stubs.resetRoundTrips();
    const storedIdentity = (row) =>
      (gas.call('normalizeMerchant', [row.merchantOriginal]) ? row.merchantOriginal : '（店名なし）') +
      ' / ' + row.fileNameOriginal + ' ' + row.sourceRow + ' 行目' +
      (row.displayTxId ? '（' + row.displayTxId + '）' : '');
    const identities = seeded.reviews.map(storedIdentity);
    assert.equal(new Set(identities).size, 3, '元ファイルの行番号で3件を区別できる');
    gas.stubs.setPromptResponses([
      {button: 'OK', text: '1'}, {button: 'OK', text: '3'}, {button: 'OK', text: '2'}
    ]);
    gas.stubs.setAlertResponses(['YES']);
    gas.call('menuResolveReview', []);
    const events = gas.stubs.getUiEvents();
    const excludePrompt = events.filter((event) => event.type === 'prompt')[2].prompt;
    identities.forEach((identity) => assert.ok(excludePrompt.includes(identity), identity));
    assert.doesNotMatch(excludePrompt, /\(不明\).*転記行 -/);
    const resultAlert = events.filter((event) => event.type === 'alert').at(-1).prompt;
    assert.ok(resultAlert.includes('■ 対象: 顧客一(C001) / ' + storedIdentity(selected)));
    assert.doesNotMatch(resultAlert, /■ 対象:.*\(不明\).*転記行 -|3 件のうち|この押下の上限|処理しなかった/);
    seeded.reviews.forEach((row, index) => {
      const stored = plain(gas.call('getReviewById', [row.reviewId]));
      const transaction = plain(gas.call('getTransaction', [row.fullTxId]));
      assert.equal(stored.status, index === 1 ? 'EXCLUDED' : 'OPEN');
      assert.equal(transaction.transactionStatus, index === 1 ? 'CANCELED' : 'REVIEW_REQUIRED');
    });
    const destination = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート')
      .getDataRange().getValues();
    assert.ok(destination[liveBefore[1].destinationRow - 1].slice(1, 7).every((value) => value === ''),
      '選んだ転記行の B・F・I・K・M・取引IDだけを空にする');
    [0, 2].forEach((index) => {
      assert.notEqual(destination[liveBefore[index].destinationRow - 1][6], '', '他2件の取引IDは残す');
    });
  });

  test('ops menu 16 confirmation: imported PARTNER EXCLUDE shows live transaction values', () => {
    const seeded = setupPartnerImport(1, 3);
    const first = seeded.reviews[0];
    const selected = seeded.reviews[1];
    const firstLive = plain(gas.call('getTransaction', [first.fullTxId]));
    const selectedLive = plain(gas.call('getTransaction', [selected.fullTxId]));
    gas.stubs.resetUiEvents(); gas.stubs.resetApiCallCounts(); gas.stubs.resetRoundTrips();
    gas.stubs.setPromptResponses([
      {button: 'OK', text: '1'}, {button: 'OK', text: '3'}, {button: 'OK', text: '2'}
    ]);
    gas.stubs.setAlertResponses(['NO']);
    gas.call('menuResolveReview', []);
    const events = gas.stubs.getUiEvents();
    const optionPrompt = events.filter((event) => event.type === 'prompt')[1].prompt;
    assert.ok(optionPrompt.includes(String(firstLive.planned.b)));
    assert.ok(optionPrompt.includes(Number(firstLive.planned.m).toLocaleString('ja-JP')));
    assert.ok(optionPrompt.includes('転記行 ' + firstLive.destinationRow));
    const confirmation = events.filter((event) => event.type === 'alert')[0].prompt;
    assert.ok(confirmation.includes(String(selectedLive.planned.b)));
    assert.ok(confirmation.includes(Number(selectedLive.planned.m).toLocaleString('ja-JP')));
    assert.ok(confirmation.includes('転記行 ' + selectedLive.destinationRow));
    assert.match(confirmation, /画面から取り消せません/);
  });

  test('ops regression: ADOPT partner-name prompt repeats imported candidates', () => {
    const seeded = setupPartnerImport(1, 1, {dictionaryRows: [partnerCandidateRow()]});
    assert.equal(call('menuReviewCandidates_', [seeded.reviews[0]])[0].partnerName, '候補株式会社');
    gas.stubs.setPromptResponses([
      {button: 'OK', text: '1'}, {button: 'OK', text: '1'}, {button: 'CANCEL', text: ''}
    ]);
    gas.call('menuResolveReview', []);
    const partnerPrompt = gas.stubs.getUiEvents().filter((event) => event.type === 'prompt')[2].prompt;
    assert.match(partnerPrompt, /候補: 1\) 候補株式会社/);
  });

  test('ops regression: candidate display never exposes matchMethod', () => {
    const seeded = setupPartnerImport(1, 1, {dictionaryRows: [partnerCandidateRow()]});
    const candidates = call('menuReviewCandidates_', [seeded.reviews[0]]);
    candidates[0].matchMethod = 'latent_method';
    assert.equal(gas.call('menuPartnerCandidatesText_', [candidates]), '1) 候補株式会社');
  });

  test('ops menu 29 integration: transaction confirmation NO writes nothing', () => {
    setupPartnerImport(1, 1);
    gas.stubs.setPromptResponses([
      {button: 'OK', text: '1'}, {button: 'OK', text: '1'},
      {button: 'OK', text: '株式会社テスト'}
    ]);
    gas.stubs.setAlertResponses(['NO']);
    gas.call('menuResolveReview', []);
    assert.equal(gas.stubs.getApiCallCounts().batchUpdate, 0);
    assert.equal(plain(gas.call('openReviews', [{}]))[0].status, 'OPEN');
    const alerts = gas.stubs.getUiEvents().filter((event) => event.type === 'alert');
    assert.equal(alerts.length, 1); assert.equal(alerts[0].returned, 'NO');
  });

  test('ops menu 47: resolve target list costs two batch reads for 3 and 30 reviews', () => {
    const measured = [3, 30].map((count) => {
      setupPartnerImport(1, count);
      gas.stubs.setPromptResponses([{button: 'CANCEL', text: ''}]);
      gas.call('menuResolveReview', []);
      return gas.stubs.getApiCallCounts().batchGet;
    });
    assert.deepEqual(measured, [2, 2]);
  });

  test('ops menu 48: real ADOPT cleanup cost is independent of other open reviews', () => {
    const trips = [3, 12].map((count) => {
      const seeded = setupPartnerImport(1, count);
      const first = seeded.reviews[0];
      gas.stubs.resetRoundTrips();
      const outcome = call('applyResolveDecision_', [applyItem([first]), 'ADOPT_EXISTING_PARTNER',
        {reviewId: first.reviewId, partnerName: '株式会社テスト'},
        {maxPerAction: 1, deadlineMs: 999999, tripWorstMs: 0}]);
      assert.equal(outcome.resolved, 1);
      const value = gas.stubs.roundTrips();
      return value.rangeReads + value.rangeWrites + value.flushes;
    });
    assert.equal(trips[0], trips[1]);
    assert.ok(trips[0] <= 100, JSON.stringify(trips));
  });

  test('ops menu 17 legs 3 and 4: required blank inputs stop in the handler', () => {
    const cases = [
      {type: 'DATE', prompts: ['', ''], expected: /日付を入力してください。/},
      {type: 'AMOUNT', prompts: ['2026/1/5', ''], expected: /金額を入力してください。/}
    ];
    cases.forEach((entry) => {
      gas.stubs.reset(); let applied = 0;
      const row = review('required' + entry.type, entry.type);
      gas.stubs.setPromptResponses([
        {button: 'OK', text: '1'}, {button: 'OK', text: '1'},
        {button: 'OK', text: entry.prompts[0]}, {button: 'OK', text: entry.prompts[1]}
      ]);
      withMocks({loadSettingsFromProperties: () => {}, menuViewerScope_: () => scope(),
        openReviews: () => [row], getReviewById: () => row, getTransaction: () => live(),
        applyResolveDecision_: () => { applied += 1; return {}; }}, () => gas.call('menuResolveReview', []));
      assert.equal(applied, 0); assert.equal(gas.stubs.getApiCallCounts().batchUpdate, 0);
      assert.match(gas.stubs.getUiEvents().filter((event) => event.type === 'alert').at(-1).prompt,
        entry.expected);
    });
  });

  test('ops regression: out-of-range corrections stop with appendix B.2 validation messages', () => {
    const cases = [
      {type: 'DATE', prompts: ['1999-12-31', ''], expected: /日付の形式が正しくありません: 1999-12-31。例: 2026-01-05/},
      {type: 'AMOUNT', prompts: ['', '100000000'], expected: /金額は整数で入力してください: 100000000/}
    ];
    cases.forEach((entry) => {
      gas.stubs.reset(); let applied = 0;
      const row = review('bounded' + entry.type, entry.type);
      gas.stubs.setPromptResponses([
        {button: 'OK', text: '1'}, {button: 'OK', text: '1'},
        {button: 'OK', text: entry.prompts[0]}, {button: 'OK', text: entry.prompts[1]}
      ]);
      withMocks({loadSettingsFromProperties: () => {}, menuViewerScope_: () => scope(),
        openReviews: () => [row], getReviewById: () => row, getTransaction: () => live(),
        applyResolveDecision_: () => { applied += 1; return {}; }}, () => gas.call('menuResolveReview', []));
      assert.equal(applied, 0);
      assert.match(gas.stubs.getUiEvents().filter((event) => event.type === 'alert').at(-1).prompt,
        entry.expected);
    });
  });

  test('ops menu 24 and 24c: CANCEL_FILE warns and confirmation NO writes nothing', () => {
    const row = review('cancelFile', 'FORMAT_UNKNOWN');
    const item = applyItem([row], 'FILE', 'FORMAT_UNKNOWN');
    const warning = gas.call('buildResolveConfirmationText_', [item, 'CANCEL_FILE',
      {reviewId: row.reviewId}, {maxPerAction: 1, live: {liveTransactionCount: 0}}, scope(), new Date()]);
    assert.match(warning, /この操作は画面から取り消せません（戻すには管理者の操作が必要です）/);

    gas.stubs.reset(); let applied = 0;
    gas.stubs.setPromptResponses([{button: 'OK', text: '1'}, {button: 'OK', text: '2'}]);
    gas.stubs.setAlertResponses(['NO']);
    withMocks({loadSettingsFromProperties: () => {}, menuViewerScope_: () => scope(),
      openReviews: () => [row], getReviewById: () => row, getTransactionsByStatus: () => [],
      applyResolveDecision_: () => { applied += 1; return {}; }}, () => gas.call('menuResolveReview', []));
    assert.equal(applied, 0); assert.equal(gas.stubs.getApiCallCounts().batchUpdate, 0);
    assert.equal(gas.stubs.getUiEvents().filter((event) => event.type === 'alert')[0].returned, 'NO');
  });

  test('ops menu 44: recheck confirmation NO writes nothing', () => {
    gas.stubs.reset(); let applied = 0;
    const collected = {files: [{fileId: 'fix', customerId: 'C001', fileName: 'fix.csv',
      state: 'CUSTOMER_FIX_REQUIRED', startedAt: '', endedAt: '', lastError: null}]};
    gas.stubs.setPromptResponses([{button: 'OK', text: '1'}]);
    gas.stubs.setAlertResponses(['NO']);
    withMocks({loadSettingsFromProperties: () => {}, menuViewerScope_: () => scope(),
      collectImportStatus_: () => collected, getFileState: () => 'CUSTOMER_FIX_REQUIRED',
      applyRecheck_: () => { applied += 1; return {}; }}, () => gas.call('menuRecheck', []));
    assert.equal(applied, 0); assert.equal(gas.stubs.getApiCallCounts().batchUpdate, 0);
    assert.equal(gas.stubs.getUiEvents().filter((event) => event.type === 'alert')[0].returned, 'NO');
  });

  test('ops menu 26-28: direct authorization denials append permission rows', () => {
    setupAuthorizationCustomers();
    const direct = (customerId, actor) => {
      gas.stubs.setActiveUser(actor);
      const before = permissionRows().length;
      const row = review('denied-' + customerId, 'FORMAT_UNKNOWN', {customerId, fileId: 'file'});
      assert.throws(() => gas.call('applyResolveDecision_', [
        {kind: 'FILE', reviewType: 'FORMAT_UNKNOWN', customerId, reviews: [row]},
        'REGISTER_FORMAT', {reviewId: row.reviewId}, {deadlineMs: 999999, tripWorstMs: 0}]),
      (error) => error && error.name === 'AuthorizationError');
      const added = permissionRows();
      assert.equal(added.length, before + 1);
      assert.equal(JSON.parse(String(added.at(-1)[10])).operation, 'REGISTER_FORMAT');
      return added.at(-1);
    };
    assert.equal(direct('C001', 'reviewer@example.com')[11], 'ROLE_INSUFFICIENT');
    assert.equal(direct('C002', 'reviewer@example.com')[11], 'NO_CUSTOMER_ACCESS');
    assert.equal(direct('C002', 'admin@example.com')[11], 'ROLE_INSUFFICIENT');
  });

  test('ops regression: recheck handler renders customer name from scope', () => {
    gas.stubs.reset();
    gas.stubs.setPromptResponses([{button: 'CANCEL', text: ''}]);
    const collected = {files: [{fileId: 'fix', customerId: 'C001', fileName: 'fix.csv',
      state: 'CUSTOMER_FIX_REQUIRED', startedAt: '2026-09-10T00:00:00Z',
      endedAt: '2026-09-10T01:00:00Z', lastError: null}], leases: [], reviews: []};
    return withMocks({loadSettingsFromProperties: () => {}, menuViewerScope_: () => scope(),
      collectImportStatus_: () => collected}, () => {
      gas.call('menuRecheck', []);
      const prompt = gas.stubs.getUiEvents().find((event) => event.type === 'prompt');
      assert.ok(prompt); assert.match(prompt.prompt, /顧客一/);
      assert.doesNotMatch(prompt.prompt, /（顧客不明）/);
    });
  });

  test('ops regression: per-item preparation failure is caught and prior cleanup runs', () => {
    const rows = [review('prepared', 'PARTNER', {fileId: 'first'}),
      review('readFails', 'PARTNER', {fileId: 'second'})];
    let reads = 0; const cleaned = [];
    return withMocks(applyMocks({
      getTransaction: () => {
        reads += 1;
        if (reads === 2) throw new Error('429 while reading transaction');
        return live();
      },
      isCardNamePartnerPurpose: () => true,
      commitSettledTransactions_: (fileId) => {
        cleaned.push('commit:' + fileId); return {candidates: 0, evaluated: 0, committed: [], deferred: 0};
      },
      completeFileIfFullyResolved_: (fileId) => {
        cleaned.push('complete:' + fileId); return {fileId, completed: false, state: 'REVIEW_WAIT', skipped: null};
      }
    }), () => {
      const outcome = call('applyResolveDecision_', [applyItem(rows), 'ADOPT_EXISTING_PARTNER',
        {reviewId: rows[0].reviewId, partnerName: '株式会社テスト'},
        {maxPerAction: 2, deadlineMs: 999999, tripWorstMs: 0}]);
      assert.equal(outcome.resolved, 1); assert.equal(outcome.errors.length, 1);
      assert.match(outcome.errors[0].message, /429/);
      assert.deepEqual(cleaned, ['commit:first', 'complete:first']);
    });
  });

  test('ops regression: resolve handler rereads only the first current GROUP review', () => {
    gas.stubs.reset();
    gas.stubs.setPromptResponses([{button: 'OK', text: '1'}, {button: 'CANCEL', text: ''}]);
    const rows = Array.from({length: 20}, (_, index) =>
      review('head' + index, 'PARTNER', {fileId: 'file' + index}));
    let reads = 0;
    return withMocks({loadSettingsFromProperties: () => {}, menuViewerScope_: () => scope(),
      openReviews: () => rows, getReviewById: () => { reads += 1; return rows[0]; },
      getTransaction: () => live()}, () => {
      gas.call('menuResolveReview', []);
      assert.equal(reads, 1, '先頭が OPEN なら残り19件は再読込しない');
    });
  });
};

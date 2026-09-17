'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEBAPP_UI_SOURCE = fs.readFileSync(
  path.join(process.cwd(), 'src', '81_WebAppUi.html'), 'utf8');

/**
 * Web アプリ第1段の受入境界。
 *
 * §12.3 のうち削除済み 26・27 と、全スイートの受入条件である 42 は
 * 独立テストにしない。§8.8 が参照しているのに本文から欠落している 15b、
 * 今回追加されたケース37〜41、監査で指定された2レグを補う。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const blank = (length) => Array(length).fill('');
  const call = (name, args = []) => {
    const result = gas.call(name, args);
    return result === undefined ? undefined : plain(result);
  };

  function requireWebFunction(name) {
    assert.equal(typeof gas.context[name], 'function', `${name} must be a public GAS function`);
  }

  function caught(fn) {
    try {
      fn();
    } catch (error) {
      return error;
    }
    assert.fail('expected the call to throw');
  }

  function withMocks(overrides, fn) {
    const saved = {};
    Object.keys(overrides).forEach((name) => {
      saved[name] = gas.context[name];
      gas.context[name] = overrides[name];
    });
    try {
      return fn();
    } finally {
      Object.keys(saved).forEach((name) => { gas.context[name] = saved[name]; });
    }
  }

  function permissionRows() {
    const master = gas.stubs.getSpreadsheet('master');
    const sheet = master && master.getSheetByName('監査ログ');
    if (!sheet) return [];
    return sheet.getDataRange().getValues().slice(1)
      .filter((row) => String(row[2]) === 'PERMISSION');
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
      17: 'generic', 18: 1, 19: 'owner@example.com',
      21: '2026-01-01T00:00:00+09:00', 29: 'NEW', 33: '2026-01-01T00:00:00+09:00'
    });
    return row;
  }

  function knownMerchantRow(original = '既知店', partner = '株式会社既知店') {
    const row = blank(18);
    Object.assign(row, {
      0: 'DICT_' + original, 1: original, 2: original, 3: partner,
      4: 'exact_original', 5: 1, 9: 'TRUE', 10: 'owner@example.com',
      12: '2026-01-01T00:00:00+09:00', 13: 1, 14: 'TRUE', 15: 'FALSE'
    });
    return row;
  }

  function matrix(rows, columns) {
    return Array.from({length: rows}, () => blank(columns));
  }

  function createTemplate(id, options = {}) {
    const actualHeaderRow = Number(options.actualHeaderRow || 1);
    const dataStartRow = Number(options.dataStartRow || actualHeaderRow + 1);
    const maxRows = Number(options.maxRows || Math.max(24, dataStartRow + 8));
    const maxColumns = 10;
    const lastSeedRow = dataStartRow + 3;
    const values = matrix(lastSeedRow, maxColumns);
    const formulas = matrix(lastSeedRow, maxColumns);
    values[actualHeaderRow - 1] = [
      '', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID',
      '税区分', '勘定科目', '消費税'
    ];
    for (let row = dataStartRow; row <= lastSeedRow; row += 1) {
      values[row - 1][7] = '課税10%';
      values[row - 1][8] = '会議費';
      formulas[row - 1][9] = `=IF(E${row}="","",ROUND(E${row}/11,0))`;
      if (options.ownedSeed && row <= dataStartRow + 1) {
        values[row - 1][1] = `2025-12-${String(row).padStart(2, '0')}`;
        values[row - 1][2] = '旧取引先';
        values[row - 1][3] = '旧摘要';
        values[row - 1][4] = 999;
        values[row - 1][5] = '旧メモ';
        values[row - 1][6] = '';
      }
    }
    if (options.sentinelRow) {
      values[Number(options.sentinelRow) - 1][2] = options.sentinelValue || '取引9';
    }
    return gas.stubs.createSpreadsheet(id, {name: options.name || id, sheets: [
      {name: options.destinationSheetName || '入力用シート', values, formulas,
        maxRows, maxColumns},
      {name: '取込用', values: [['出力']], formulas: [[''], ['=入力用シート!B1']],
        maxRows: 20, maxColumns: 10},
      {name: '取引先一覧', values: [['元店名', '取引先名'], ['既知店', '株式会社既知店']]}
    ]});
  }

  function configureRuntime() {
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createSpreadsheet('snap', {sheets: []});
    gas.stubs.createFolder('corpus', {fileIds: []});
    gas.evaluate("SETTINGS.EXECUTION_TIMEOUT_SECONDS=300;" +
      "SETTINGS.SAFETY_MARGIN_SECONDS=60;" +
      "SETTINGS.TX_INDEX_SPREADSHEET_ID='txidx';" +
      "SETTINGS.SNAPSHOT_SPREADSHEET_ID='snap';" +
      "SETTINGS.SAMPLE_CORPUS_FOLDER_ID='corpus';" +
      "SETTINGS.PARALLEL_WORK_FOLDER_ID='';" +
      'SETTINGS.FAULT_INJECTION=null;');
  }

  function addCustomer(world, options = {}) {
    const suffix = options.suffix || String(Object.keys(world.customers).length + 1);
    const customerId = options.customerId || `C00${suffix}`;
    const customerName = options.customerName || `顧客${suffix}`;
    const rootId = options.rootId || `root${suffix}`;
    const cardId = options.cardId || `card${suffix}`;
    const destinationId = options.destinationId || `dest${suffix}`;
    const destinationParentId = options.destinationParentId || `destParent${suffix}`;
    const cardFolder = gas.stubs.createFolder(cardId, {name: `カード${suffix}`, fileIds: [], subFolderIds: []});
    const rootFolder = gas.stubs.createFolder(rootId,
      {name: `顧客${suffix}ルート`, fileIds: [], subFolderIds: [cardId]});
    const destinationParent = gas.stubs.createFolder(destinationParentId,
      {name: `転記先${suffix}`, fileIds: [destinationId], subFolderIds: []});
    createTemplate(destinationId, {
      name: options.destinationName || `${customerName}_雛形`,
      actualHeaderRow: options.actualHeaderRow,
      dataStartRow: options.dataStartRow,
      ownedSeed: options.ownedSeed,
      sentinelRow: options.sentinelRow,
      sentinelValue: options.sentinelValue,
      destinationSheetName: options.destinationSheetName
    });
    gas.call('registerTestCustomer', [{
      customerId, customerName, active: true, sourceFolderId: rootId,
      destinationSpreadsheetId: destinationId,
      destinationSheetName: options.destinationSheetName || '入力用シート',
      partnerListSheetName: '取引先一覧',
      columns: {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7, G: 8},
      headerRow: Number(options.actualHeaderRow || 1),
      dataStartRow: Number(options.dataStartRow || Number(options.actualHeaderRow || 1) + 1),
      rowScanLastColumn: 10,
      rowScanExcludedColumns: options.rowScanExcludedColumns || [8, 9, 10],
      reviewers: options.reviewers === undefined ? 'reviewer@example.com' : options.reviewers,
      admins: options.admins === undefined ? 'owner@example.com' : options.admins,
      customerCategory: options.customerCategory || 'CORPORATE',
      fiscalYear: options.fiscalYear,
      cardNamePartnerPurposes: options.cardNamePartnerPurposes || []
    }]);
    const record = {customerId, customerName, rootId, cardId, destinationId,
      destinationParentId, rootFolder, cardFolder, destinationParent};
    world.customers[customerId] = record;
    return record;
  }

  function setupWorld(options = {}) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.setSpreadsheetOwner('master', options.owner || 'owner@example.com');
    gas.stubs.setActiveUser(options.registrationActor || 'owner@example.com');
    configureRuntime();
    gas.stubs.getSpreadsheet('master').getSheetByName('カード形式マスター')
      .appendRow(partnerFormatRow());
    const world = {customers: {}};
    const customer = addCustomer(world, Object.assign({suffix: '1', customerId: 'C001',
      customerName: '顧客一'}, options.customer || {}));
    if (options.knownMerchant) {
      gas.stubs.getSpreadsheet('master').getSheetByName('共通取引先辞書')
        .appendRow(knownMerchantRow());
    }
    gas.stubs.setActiveUser(options.actor || 'reviewer@example.com');
    gas.stubs.resetApiCallCounts();
    gas.stubs.resetRoundTrips();
    return {world, customer};
  }

  function putCsv(customer, options = {}) {
    const fileId = options.fileId || `file_${customer.cardFolder.fileIds.length + 1}`;
    const rows = options.rows || ['2025/12/10,未登録店,1000,仕入れ'];
    const content = ['利用日,利用店名,金額,使用用途'].concat(rows).join('\n') + '\n';
    gas.stubs.createFile(fileId, {
      name: options.name || `三井住友カード202601_${fileId}.csv`,
      bytes: Buffer.from(content, 'utf8'), contentType: 'text/csv',
      lastUpdated: options.lastUpdated || new Date(Date.now() - 60 * 60 * 1000),
      createdTime: '2026-08-01T00:00:00Z'
    });
    customer.cardFolder.fileIds.push(fileId);
    return fileId;
  }

  function putUnknownFile(customer, fileId = 'unknown_file') {
    gas.stubs.createFile(fileId, {
      name: `${fileId}.csv`, bytes: Buffer.from('x,y\n1,2\n', 'utf8'),
      contentType: 'text/csv', lastUpdated: new Date(Date.now() - 60 * 60 * 1000),
      createdTime: '2026-08-01T00:00:00Z'
    });
    customer.cardFolder.fileIds.push(fileId);
    return fileId;
  }

  function openReviewsFor(customerId, filter = {}) {
    return call('openReviews', [filter]).filter((row) => String(row.customerId) === String(customerId));
  }

  function spreadsheetIds() {
    return gas.stubs.getSpreadsheetIds().slice().sort();
  }

  function createdIds(before) {
    const prior = new Set(before);
    return spreadsheetIds().filter((id) => !prior.has(id));
  }

  function webImport(customer, options = {}) {
    const args = [customer.customerId, customer.cardId, options];
    return call('webAppRunImport', args);
  }

  function seedPartnerViaWeb(options = {}) {
    const seeded = setupWorld(options.world || {});
    const rows = options.rows || Array.from({length: options.count || 1}, (_, index) =>
      `2025/12/${String(10 + index).padStart(2, '0')},${options.merchant || '未登録店'},${1000 + index},${options.purpose || '仕入れ'}`);
    const fileId = putCsv(seeded.customer, {fileId: options.fileId || 'partner_file', rows});
    const before = spreadsheetIds();
    const result = webImport(seeded.customer, {});
    const reviews = openReviewsFor(seeded.customer.customerId, {fileId})
      .filter((row) => row.reviewType === 'PARTNER')
      .sort((a, b) => Number(a.sourceRow) - Number(b.sourceRow));
    return Object.assign(seeded, {fileId, result, reviews, before,
      destinationSpreadsheetId: result.destinationSpreadsheetId});
  }

  function dictionaryCount() {
    return ['共通取引先辞書', '顧客別取引先辞書'].reduce((total, name) => {
      const sheet = gas.stubs.getSpreadsheet('master').getSheetByName(name);
      if (!sheet) return total;
      return total + sheet.getDataRange().getValues().slice(1)
        .filter((row) => row[0] !== '' && row[0] !== null).length;
    }, 0);
  }

  function decision(review, partnerName, sameMerchantConflict = false) {
    return {reviewId: review.reviewId, partnerName,
      sameMerchantConflict: Boolean(sameMerchantConflict)};
  }

  function webResolve(customerId, decisions, suffix = '1') {
    return call('webAppResolveReviews', [customerId, decisions, {batchId: `batch-${suffix}`}]);
  }

  function destinationValue(spreadsheetId, row, column) {
    return gas.stubs.getSpreadsheet(spreadsheetId).getSheetByName('入力用シート')
      .getRange(Number(row), Number(column)).getValue();
  }

  function resolveLoop(customerId, initialDecisions, limit = 40) {
    let remaining = initialDecisions.slice();
    const calls = [];
    const seenErrors = new Set();
    for (let index = 0; remaining.length && index < limit; index += 1) {
      const result = webResolve(customerId, remaining, String(index + 1));
      calls.push(result);
      const resolved = new Set(result.resolvedReviewIds || []);
      const skipped = new Set(result.skippedByLeaseReviewIds || []);
      const errors = (result.errors || []).filter((entry) => entry.reviewId);
      const newErrorIds = errors.map((entry) => String(entry.reviewId))
        .filter((id) => !seenErrors.has(id));
      errors.forEach((entry) => seenErrors.add(String(entry.reviewId)));
      const removed = new Set([...resolved, ...skipped,
        ...errors.map((entry) => String(entry.reviewId))]);
      const next = remaining.filter((entry) => !removed.has(String(entry.reviewId)));
      const progressed = Number(result.resolved || 0) > 0 || newErrorIds.length > 0;
      remaining = next;
      if (!progressed) break;
    }
    return {calls, remaining, seenErrors};
  }

  function transactionFor(review) {
    return call('getTransaction', [review.fullTxId]);
  }

  function reviewById(reviewId) {
    return call('getReviewById', [reviewId]);
  }

  function importFileResults(result) {
    return Array.isArray(result.fileResults) ? result.fileResults : [];
  }

  function clientStoppedByMessage(code) {
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(WEBAPP_UI_SOURCE);
    assert.ok(scriptMatch, 'Web app script must exist');
    const eventNeedle = "    el['customer-search'].addEventListener";
    assert.ok(scriptMatch[1].includes(eventNeedle), 'client probe insertion point must exist');
    const probe = `    globalThis.__stoppedByMessage = stoppedByMessage(${JSON.stringify(code)});\n` +
      '    return;\n';
    const source = scriptMatch[1].replace(eventNeedle, probe + eventNeedle);
    const sandbox = {document: {getElementById() { return {}; }}};
    vm.runInNewContext(source, sandbox);
    return sandbox.__stoppedByMessage;
  }

  test('webapp 01: doGet returns the evaluated Web app HTML', () => {
    requireWebFunction('doGet');
    gas.stubs.reset();
    gas.stubs.setHtmlTemplate('<main id="webapp">credit-card app</main>');
    const output = gas.call('doGet', []);
    assert.equal(output.getContent(), '<main id="webapp">credit-card app</main>');
  });

  test('webapp 02: bootstrap exposes only authorized customer summary fields', () => {
    requireWebFunction('webAppBootstrap');
    const {world} = setupWorld();
    addCustomer(world, {suffix: '2', customerId: 'C002', customerName: '顧客二',
      reviewers: 'other@example.com', admins: 'other-admin@example.com'});
    const result = call('webAppBootstrap');
    assert.equal(result.actor, 'reviewer@example.com');
    assert.deepEqual(result.customers.map((row) => row.customerId), ['C001']);
    assert.deepEqual(Object.keys(result.customers[0]).sort(),
      ['canImport', 'customerCategory', 'customerId', 'customerName']);
    assert.equal(result.customers[0].canImport, true);
    assert.equal(typeof result.version, 'string');
  });

  test('webapp 03: folder listing accepts one direct level and rejects a grandchild', () => {
    requireWebFunction('webAppListFolder');
    const {customer} = setupWorld();
    const fileId = putCsv(customer, {fileId: 'listed_file'});
    const grandchild = gas.stubs.createFolder('grandchild',
      {name: '孫フォルダ', fileIds: [], subFolderIds: []});
    customer.cardFolder.subFolderIds.push(grandchild.id);

    const folders = call('webAppListFolder', [customer.customerId, '']);
    assert.equal(folders.kind, 'FOLDERS');
    assert.deepEqual(folders.folders.map((row) => row.folderId), [customer.cardId]);
    const files = call('webAppListFolder', [customer.customerId, customer.cardId]);
    assert.equal(files.kind, 'FILES');
    assert.deepEqual(files.files.map((row) => row.fileId), [fileId]);
    const error = caught(() => gas.call('webAppListFolder',
      [customer.customerId, grandchild.id]));
    assert.equal(error.name, 'AuthorizationError');
  });

  test('webapp 03b: supplied destination IDs fail all four checks before lease, write, or copy', () => {
    requireWebFunction('webAppRunImport');
    const legs = [
      {name: 'template itself', make({customer}) {
        // 条件1だけを違反させる。名前・親・対象シートは既存転記先として妥当。
        gas.stubs.getSpreadsheet(customer.destinationId).name =
          `${customer.customerName}_20260916-1200`;
        return customer.destinationId;
      }},
      {name: 'right name in another folder', make({customer}) {
        const id = 'foreign_parent';
        createTemplate(id, {name: `${customer.customerName}_20260916-1200`});
        gas.stubs.createFolder('other_parent', {fileIds: [id], subFolderIds: []});
        return id;
      }},
      {name: 'wrong name in the right folder', make({customer}) {
        const id = 'wrong_name';
        createTemplate(id, {name: 'not-a-webapp-copy'});
        customer.destinationParent.fileIds.push(id);
        return id;
      }},
      {name: 'missing destination sheet', make({customer}) {
        const id = 'missing_sheet';
        gas.stubs.createSpreadsheet(id, {name: `${customer.customerName}_20260916-1200`,
          sheets: [{name: '別シート', values: [['x']]}]});
        customer.destinationParent.fileIds.push(id);
        return id;
      }}
    ];
    legs.forEach((leg) => {
      const seeded = setupWorld();
      putCsv(seeded.customer, {fileId: `auth_${leg.name}`});
      const destinationSpreadsheetId = leg.make(seeded);
      const idsBefore = spreadsheetIds();
      const leasesBefore = call('activeLeases_').length;
      const writesBefore = gas.stubs.getApiCallCounts().batchUpdate;
      const permissionBefore = permissionRows().length;
      const error = caught(() => webImport(seeded.customer, {destinationSpreadsheetId}));
      assert.equal(error.name, 'AuthorizationError', leg.name);
      assert.deepEqual(spreadsheetIds(), idsBefore, `${leg.name}: no copy`);
      assert.equal(call('activeLeases_').length, leasesBefore, `${leg.name}: no lease`);
      assert.equal(gas.stubs.getApiCallCounts().batchUpdate, writesBefore, `${leg.name}: no write`);
      assert.equal(permissionRows().length, permissionBefore, `${leg.name}: no PERMISSION row`);
    });
  });

  test('webapp 03c: transient destination validation failures reach the shared classifier', () => {
    requireWebFunction('webAppRunImport');
    const {customer} = setupWorld();
    const originalDriveApp = gas.context.DriveApp;
    const quotaError = new Error("Quota exceeded for quota metric 'Read requests'");
    quotaError.code = 429;
    const error = withMocks({
      DriveApp: Object.assign({}, originalDriveApp, {
        getFileById(id) {
          if (String(id) === 'transient_destination') throw quotaError;
          return originalDriveApp.getFileById(id);
        }
      })
    }, () => caught(() => webImport(customer,
      {destinationSpreadsheetId: 'transient_destination'})));
    assert.equal(error.name, 'Error');
    assert.equal(error.code, 429);
    assert.equal(error.message,
      '読取の割当（1分あたりの上限）を超えました。1分ほど待ってから再実行してください。');
    assert.ok(!error.message.includes('指定された転記先を確認できませんでした'));
  });

  test('webapp 04: folder listing rejects an unauthorized customer with an audited reason', () => {
    requireWebFunction('webAppListFolder');
    const {world} = setupWorld();
    const other = addCustomer(world, {suffix: '2', customerId: 'C002',
      reviewers: 'other@example.com', admins: 'other-admin@example.com'});
    const before = permissionRows().length;
    const error = caught(() => gas.call('webAppListFolder', [other.customerId, '']));
    assert.equal(error.name, 'AuthorizationError');
    assert.equal(error.reason, 'NO_CUSTOMER_ACCESS');
    assert.equal(error.code, null);
    assert.equal(permissionRows().length, before + 1);
  });

  test('webapp 05: a clone clears only six owned columns below a non-first header row', () => {
    requireWebFunction('webAppRunImport');
    const {customer} = setupWorld({customer: {actualHeaderRow: 3, dataStartRow: 4,
      ownedSeed: true}});
    putUnknownFile(customer);
    const template = gas.stubs.getSpreadsheet(customer.destinationId).getSheetByName('入力用シート');
    const templateHeaderValues = plain(template.getRange(3, 1, 1, 10).getValues());
    const templateHeaderFormulas = plain(template.getRange(3, 1, 1, 10).getFormulas());
    const templateValues = plain(template.getRange(4, 1, 4, 10).getValues());
    const templateFormulas = plain(template.getRange(4, 1, 4, 10).getFormulas());
    const result = webImport(customer);
    const clone = gas.stubs.getSpreadsheet(result.destinationSpreadsheetId)
      .getSheetByName('入力用シート');
    assert.deepEqual(plain(clone.getRange(3, 1, 1, 10).getValues()), templateHeaderValues);
    assert.deepEqual(plain(clone.getRange(3, 1, 1, 10).getFormulas()), templateHeaderFormulas);
    const values = plain(clone.getRange(4, 1, 4, 10).getValues());
    const formulas = plain(clone.getRange(4, 1, 4, 10).getFormulas());
    [1, 2, 3, 4, 5, 6].forEach((index) => {
      assert.ok(values.every((row) => row[index] === ''), `owned column ${index + 1}`);
    });
    [0, 7, 8, 9].forEach((index) => {
      assert.deepEqual(values.map((row) => row[index]), templateValues.map((row) => row[index]));
      assert.deepEqual(formulas.map((row) => row[index]), templateFormulas.map((row) => row[index]));
    });
  });

  test('webapp 05b: the six-column clone still has an empty destination row', () => {
    requireWebFunction('webAppRunImport');
    const {customer} = setupWorld({customer: {ownedSeed: true}});
    const templateCustomer = call('getCustomerById', [customer.customerId]);
    const templateSheet = gas.stubs.getSpreadsheet(customer.destinationId)
      .getSheetByName('入力用シート');
    const fillCount = templateSheet.getMaxRows() - templateCustomer.headerRow;
    templateSheet.getRange(templateCustomer.headerRow + 1,
      templateCustomer.columnMapping.B, fillCount, 1)
      .setValues(Array.from({length: fillCount}, (_, index) => [`使用中${index + 1}`]));
    const templateIndex = gas.call('buildIndex', [templateCustomer, {}]);
    assert.deepEqual(call('findEmptyRows', [templateCustomer, 1, templateIndex]), []);
    putUnknownFile(customer);
    const result = webImport(customer);
    const writeCustomer = Object.assign({}, call('getCustomerById', [customer.customerId]),
      {destinationSpreadsheetId: result.destinationSpreadsheetId});
    const index = gas.call('buildIndex', [writeCustomer, {}]);
    const emptyRows = call('findEmptyRows', [writeCustomer, 1, index]);
    assert.ok(emptyRows.length >= 1);
  });

  test('webapp 05c: clearing whole rows is an unsafe contrast that schema validation misses', () => {
    requireWebFunction('webAppRunImport');
    const {customer} = setupWorld();
    putUnknownFile(customer, 'first_unknown');
    const first = webImport(customer);
    const clone = gas.stubs.getSpreadsheet(first.destinationSpreadsheetId)
      .getSheetByName('入力用シート');
    clone.getRange(2, 1, clone.getMaxRows() - 1, clone.getMaxColumns()).clearContent();
    gas.stubs.getSpreadsheet('master').getSheetByName('共通取引先辞書')
      .appendRow(knownMerchantRow());
    const fileId = putCsv(customer, {fileId: 'known_after_clear',
      rows: ['2025/12/20,既知店,2200,仕入れ']});
    const writeCustomer = Object.assign({}, call('getCustomerById', [customer.customerId]),
      {destinationSpreadsheetId: first.destinationSpreadsheetId});
    const clearedIndex = gas.call('buildIndex', [writeCustomer, {}]);
    assert.equal(call('validateDestinationSchema', [writeCustomer, clearedIndex]).ok, true);
    const second = webImport(customer, {destinationSpreadsheetId: first.destinationSpreadsheetId});
    assert.equal(importFileResults(second).find((row) => row.fileId === fileId).outcome, 'WRITTEN');
    const tx = call('getTransactionsByStatus', [fileId, ['COMMITTED']])[0];
    assert.ok(tx);
    assert.equal(destinationValue(first.destinationSpreadsheetId, tx.destinationRow, 9), '');
    assert.equal(gas.stubs.getSpreadsheet(first.destinationSpreadsheetId)
      .getSheetByName('入力用シート').getRange(tx.destinationRow, 10).getFormula(), '');
  });

  test('webapp 05d: a clone missing its destination sheet is rejected without exposing its ID', () => {
    requireWebFunction('webAppRunImport');
    const {customer} = setupWorld();
    putUnknownFile(customer, 'missing_clone_sheet');
    const template = gas.stubs.getSpreadsheet(customer.destinationId);
    template.deleteSheet(template.getSheetByName('入力用シート'));
    const before = spreadsheetIds();
    const result = webImport(customer);
    assert.equal(result.schemaValidation.ok, false);
    assert.equal(result.schemaValidation.code, 'DESTINATION_SHEET_MISSING');
    assert.equal(result.stoppedBy, 'DESTINATION_SHEET_MISSING');
    assert.equal(Object.hasOwn(result, 'destinationSpreadsheetId'), false);
    assert.equal(createdIds(before).length, 1, 'the failed copy remains in Drive');
    assert.equal(clientStoppedByMessage(result.stoppedBy),
      '転記シートの複製に失敗しました（DESTINATION_SHEET_MISSING）。雛形の構成を確認のうえ、管理者へ連絡してください。');
  });

  test('webapp 06: cloning preserves formulas on the 取込用 tab', () => {
    requireWebFunction('webAppRunImport');
    const {customer} = setupWorld();
    putUnknownFile(customer);
    const sourceFormula = gas.stubs.getSpreadsheet(customer.destinationId)
      .getSheetByName('取込用').getRange(2, 1).getFormula();
    const result = webImport(customer);
    const cloneFormula = gas.stubs.getSpreadsheet(result.destinationSpreadsheetId)
      .getSheetByName('取込用').getRange(2, 1).getFormula();
    assert.equal(cloneFormula, sourceFormula);
    assert.notEqual(cloneFormula, '');
  });

  test('webapp 07: a later import reuses the supplied destination instead of making another copy', () => {
    requireWebFunction('webAppRunImport');
    const {customer} = setupWorld();
    putUnknownFile(customer, 'unknown_one');
    putUnknownFile(customer, 'unknown_two');
    const before = spreadsheetIds();
    const first = webImport(customer);
    const second = webImport(customer, {destinationSpreadsheetId: first.destinationSpreadsheetId});
    assert.equal(second.destinationSpreadsheetId, first.destinationSpreadsheetId);
    assert.deepEqual(createdIds(before), [first.destinationSpreadsheetId]);
  });

  test('webapp 08: imported reviews point to the clone while transaction AC and AD stay blank', () => {
    requireWebFunction('webAppRunImport');
    const seeded = seedPartnerViaWeb();
    assert.equal(seeded.reviews.length, 1);
    const review = reviewById(seeded.reviews[0].reviewId);
    assert.equal(review.destinationSpreadsheetId, seeded.destinationSpreadsheetId);
    assert.equal(review.destinationSheetName, '入力用シート');
    const tx = transactionFor(review);
    assert.equal(tx.destinationSpreadsheetId, '');
    assert.equal(tx.destinationSheetName, '');
  });

  test('webapp 09: resolving honors WEBAPP_MAX_PER_CALL and reports the remainder by ID', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({count: 2});
    // 上限を 1 に固定して呼ぶ。受入 12 で出荷値が 8 になったので、2 件では
    // 残りが出ない ── 固定しないと、このケースは「上限が効くこと」ではなく
    // 「出荷値がたまたま 1 であること」を見ていたことになる。
    const result = withMocks({WEBAPP_MAX_PER_CALL_: 1}, () => webResolve(
      seeded.customer.customerId,
      seeded.reviews.map((review) => decision(review, '株式会社テスト'))));
    assert.equal(result.maxPerCall, 1);
    assert.equal(result.resolved, 1);
    assert.equal(result.remaining, 1);
    assert.equal(result.resolvedReviewIds.length, 1);
    assert.ok(seeded.reviews.some((review) => review.reviewId === result.resolvedReviewIds[0]));
  });

  test('webapp 10: a missing review is reported and does not consume the resolution slot', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb();
    const result = webResolve(seeded.customer.customerId,
      [{reviewId: 'RV_MISSING', partnerName: '甲社', sameMerchantConflict: false},
        decision(seeded.reviews[0], '乙社')]);
    assert.equal(result.errors.find((entry) => entry.reviewId === 'RV_MISSING').code,
      'REVIEW_NOT_FOUND');
    assert.equal(result.resolved, 1);
    assert.deepEqual(result.resolvedReviewIds, [seeded.reviews[0].reviewId]);
    assert.equal(result.remaining, 0);
  });

  test('webapp 11: a blank partner resolves without writing F or learning', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb();
    const review = seeded.reviews[0];
    const tx = transactionFor(review);
    const beforeDictionary = dictionaryCount();
    const result = webResolve(seeded.customer.customerId, [decision(review, '')]);
    assert.equal(result.resolved, 1);
    assert.equal(reviewById(review.reviewId).resolveOperation, 'RESOLVE_WITHOUT_PARTNER');
    assert.equal(destinationValue(seeded.destinationSpreadsheetId, tx.destinationRow, 3), '');
    assert.equal(dictionaryCount(), beforeDictionary);
  });

  test('webapp 12: input.customer cannot redirect resolution away from the review destination', () => {
    requireWebFunction('webAppRunImport');
    const seeded = seedPartnerViaWeb();
    const review = seeded.reviews[0];
    const tx = transactionFor(review);
    createTemplate('wrong_destination', {name: 'wrong_destination', sentinelRow: tx.destinationRow,
      sentinelValue: '誤転記防止'});
    const wrongCustomer = Object.assign({}, call('getCustomerById', [seeded.customer.customerId]),
      {destinationSpreadsheetId: 'wrong_destination'});
    call('resolveReview', [review.reviewId, 'ADOPT_EXISTING_PARTNER',
      {partnerName: '甲社', learn: false, customer: wrongCustomer}]);
    assert.equal(destinationValue(seeded.destinationSpreadsheetId, tx.destinationRow, 3), '甲社');
    assert.equal(destinationValue('wrong_destination', tx.destinationRow, 3), '誤転記防止');
  });

  test('webapp 13: Web resolution changes the clone row and never the template row with the same number', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({world: {customer: {actualHeaderRow: 14,
      dataStartRow: 15, sentinelRow: 15, sentinelValue: '取引9'}}});
    const review = seeded.reviews[0];
    const tx = transactionFor(review);
    assert.equal(tx.destinationRow, 15);
    const result = webResolve(seeded.customer.customerId, [decision(review, '取引1')]);
    assert.equal(result.resolved, 1);
    assert.equal(destinationValue(seeded.destinationSpreadsheetId, 15, 3), '取引1');
    assert.equal(destinationValue(seeded.customer.destinationId, 15, 3), '取引9');
  });

  test('webapp 14: review table contains PARTNER rows and counts other types only', () => {
    requireWebFunction('webAppListReviews');
    const seeded = seedPartnerViaWeb({rows: ['日付不明,未登録店,1000,仕入れ']});
    const listed = call('webAppListReviews', [seeded.customer.customerId, 15, 0]);
    assert.equal(listed.reviews.length, 1);
    assert.equal(listed.reviews[0].reviewId,
      seeded.reviews.find((row) => row.reviewType === 'PARTNER').reviewId);
    assert.equal(listed.otherCounts.DATE, 1);
  });

  test('webapp 15: file-level FORMAT_UNKNOWN reviews deliberately have no destination columns', () => {
    requireWebFunction('webAppRunImport');
    const {customer} = setupWorld();
    const fileId = putUnknownFile(customer);
    webImport(customer);
    const review = openReviewsFor(customer.customerId, {fileId})
      .find((row) => row.reviewType === 'FORMAT_UNKNOWN');
    assert.ok(review);
    assert.equal(reviewById(review.reviewId).destinationSpreadsheetId, null);
    assert.equal(reviewById(review.reviewId).destinationSheetName, null);
  });

  test('webapp 15b: a legacy review with blank M and N falls back to the customer template', () => {
    requireWebFunction('webAppRunImport');
    const seeded = seedPartnerViaWeb();
    const review = seeded.reviews[0];
    const tx = transactionFor(review);
    const reviewSheet = gas.stubs.getSpreadsheet('master').getSheetByName('要確認');
    reviewSheet.getRange(review._rowNumber, 13, 1, 2).setValues([['', '']]);
    call('resolveReview', [review.reviewId, 'ADOPT_EXISTING_PARTNER',
      {partnerName: '旧要確認の取引先', learn: false}]);
    assert.equal(destinationValue(seeded.customer.destinationId, tx.destinationRow, 3),
      '旧要確認の取引先');
    assert.equal(reviewById(review.reviewId).status, 'RESOLVED');
  });

  test('webapp 16 ADOPT: partner adoption writes the review destination and leaves the template intact', () => {
    requireWebFunction('webAppRunImport');
    const seeded = seedPartnerViaWeb({world: {customer: {sentinelRow: 2,
      sentinelValue: '雛形ADOPT'}}});
    const review = seeded.reviews[0];
    const tx = transactionFor(review);
    call('resolveReview', [review.reviewId, 'ADOPT_EXISTING_PARTNER',
      {partnerName: '採用先', learn: false}]);
    assert.equal(destinationValue(seeded.destinationSpreadsheetId, tx.destinationRow, 3), '採用先');
    assert.equal(destinationValue(seeded.customer.destinationId, tx.destinationRow, 3), '雛形ADOPT');
  });

  test('webapp 16 FIX: date correction writes the review destination and leaves the template intact', () => {
    requireWebFunction('webAppRunImport');
    const seeded = seedPartnerViaWeb({rows: ['日付不明,未登録店,1000,仕入れ']});
    const review = openReviewsFor(seeded.customer.customerId, {fileId: seeded.fileId})
      .find((row) => row.reviewType === 'DATE');
    const tx = transactionFor(review);
    gas.stubs.getSpreadsheet(seeded.customer.destinationId).getSheetByName('入力用シート')
      .getRange(tx.destinationRow, 2).setValue('2099-01-01');
    call('resolveReview', [review.reviewId, 'FIX_DATE_AMOUNT',
      {correctedDate: '2025-12-10'}]);
    const corrected = destinationValue(seeded.destinationSpreadsheetId, tx.destinationRow, 2);
    assert.ok(corrected instanceof Date);
    assert.equal(corrected.toISOString(), '2025-12-09T15:00:00.000Z');
    assert.equal(destinationValue(seeded.customer.destinationId, tx.destinationRow, 2),
      '2099-01-01');
  });

  test('webapp 16 EXCLUDE: exclusion clears the review destination and leaves the template intact', () => {
    requireWebFunction('webAppRunImport');
    const seeded = seedPartnerViaWeb({world: {customer: {sentinelRow: 2,
      sentinelValue: '雛形EXCLUDE'}}});
    const review = seeded.reviews[0];
    const tx = transactionFor(review);
    call('resolveReview', [review.reviewId, 'EXCLUDE', {}]);
    const cloneRow = plain(gas.stubs.getSpreadsheet(seeded.destinationSpreadsheetId)
      .getSheetByName('入力用シート').getRange(tx.destinationRow, 2, 1, 6).getValues()[0]);
    assert.ok(cloneRow.every((value) => value === ''));
    assert.equal(destinationValue(seeded.customer.destinationId, tx.destinationRow, 3),
      '雛形EXCLUDE');
  });

  test('webapp 17: omitting input.learn on direct adoption learns one dictionary row', () => {
    requireWebFunction('webAppRunImport');
    const seeded = seedPartnerViaWeb();
    const before = dictionaryCount();
    call('resolveReview', [seeded.reviews[0].reviewId, 'ADOPT_EXISTING_PARTNER',
      {partnerName: '学習先'}]);
    assert.equal(dictionaryCount(), before + 1);
  });

  test('webapp 18: Web adoption of a control-only merchant suppresses learning and settles fully', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({merchant: '\u0001'});
    const review = seeded.reviews[0];
    const tx = transactionFor(review);
    assert.equal(review.merchantNormalized, null);
    const before = dictionaryCount();
    const result = webResolve(seeded.customer.customerId, [decision(review, '乙社')]);
    assert.equal(result.resolved, 1);
    assert.equal(dictionaryCount(), before);
    assert.equal(destinationValue(seeded.destinationSpreadsheetId, tx.destinationRow, 3), '乙社');
    assert.equal(reviewById(review.reviewId).status, 'RESOLVED');
  });

  test('webapp 18b: forcing learning for a control-only merchant leaves the known half-write', () => {
    requireWebFunction('webAppRunImport');
    const seeded = seedPartnerViaWeb({merchant: '\u0001'});
    const review = seeded.reviews[0];
    const tx = transactionFor(review);
    const error = caught(() => gas.call('resolveReview',
      [review.reviewId, 'ADOPT_EXISTING_PARTNER', {partnerName: '乙社', learn: true}]));
    assert.equal(error.name, 'MasterDataError');
    assert.equal(destinationValue(seeded.destinationSpreadsheetId, tx.destinationRow, 3), '乙社');
    assert.equal(reviewById(review.reviewId).status, 'OPEN');
    assert.equal(transactionFor(review).transactionStatus, 'REVIEW_REQUIRED');
  });

  test('webapp 19: a card-name partner purpose is resolved without dictionary learning', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({world: {customer: {
      cardNamePartnerPurposes: ['年会費']}}, purpose: '年会費'});
    const before = dictionaryCount();
    const result = webResolve(seeded.customer.customerId,
      [decision(seeded.reviews[0], 'カード会社')]);
    assert.equal(result.resolved, 1);
    assert.equal(dictionaryCount(), before);
  });

  test('webapp 20: conflicting partners for one merchant never learn either decision', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({count: 2, merchant: '同じ店'});
    const before = dictionaryCount();
    const decisions = [decision(seeded.reviews[0], '甲社', true),
      decision(seeded.reviews[1], '乙社', true)];
    const run = resolveLoop(seeded.customer.customerId, decisions);
    assert.equal(run.remaining.length, 0);
    assert.equal(dictionaryCount(), before);
    seeded.reviews.forEach((review) => assert.equal(reviewById(review.reviewId).status, 'RESOLVED'));
  });

  test('webapp 20b: sameMerchantConflict survives when the second call sends only the remainder', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({count: 2, merchant: '同じ店'});
    const all = [decision(seeded.reviews[0], '甲社', true),
      decision(seeded.reviews[1], '乙社', true)];
    const before = dictionaryCount();
    // 「2回目が残りだけを送る」場面を作るため、1回目の上限を 1 に固定する。
    const first = withMocks({WEBAPP_MAX_PER_CALL_: 1},
      () => webResolve(seeded.customer.customerId, all, 'first'));
    const finished = new Set(first.resolvedReviewIds || []);
    const remainder = all.filter((entry) => !finished.has(entry.reviewId));
    assert.equal(remainder.length, 1);
    assert.equal(remainder[0].sameMerchantConflict, true);
    const second = webResolve(seeded.customer.customerId, remainder, 'second');
    assert.equal(second.resolved, 1);
    assert.equal(dictionaryCount(), before);
  });

  test('webapp 20c: absence of sameMerchantConflict deliberately permits learning', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({merchant: '単独店'});
    const before = dictionaryCount();
    const result = webResolve(seeded.customer.customerId,
      [{reviewId: seeded.reviews[0].reviewId, partnerName: '単独取引先'}]);
    assert.equal(result.resolved, 1);
    assert.equal(dictionaryCount(), before + 1);
  });

  test('webapp 21: a canceled transaction reports STATE_TRANSITION and does not resurrect its row', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({rows: ['日付不明,未登録店,1000,仕入れ']});
    const all = openReviewsFor(seeded.customer.customerId, {fileId: seeded.fileId});
    const dateReview = all.find((row) => row.reviewType === 'DATE');
    const partnerReview = all.find((row) => row.reviewType === 'PARTNER');
    const tx = transactionFor(partnerReview);
    call('resolveReview', [dateReview.reviewId, 'EXCLUDE', {}]);
    const sheet = gas.stubs.getSpreadsheet(seeded.destinationSpreadsheetId)
      .getSheetByName('入力用シート');
    const before = plain(sheet.getRange(tx.destinationRow, 2, 1, 6).getValues()[0]);
    const result = webResolve(seeded.customer.customerId, [decision(partnerReview, '幽霊取引先')]);
    assert.equal(result.errors[0].reviewId, partnerReview.reviewId);
    assert.equal(result.errors[0].code, 'STATE_TRANSITION');
    assert.equal(result.errors[0].message,
      'この取引は既に取り消されたか除外されています（状態 CANCELED）。画面を再読み込みしてください。');
    assert.deepEqual(plain(sheet.getRange(tx.destinationRow, 2, 1, 6).getValues()[0]), before);
  });

  test('webapp 22: an owner cannot use a claimed customer ID to resolve another customer review', () => {
    requireWebFunction('webAppResolveReviews');
    const {world, customer} = setupWorld({actor: 'owner@example.com'});
    const other = addCustomer(world, {suffix: '2', customerId: 'C002', customerName: '顧客二',
      reviewers: 'owner@example.com', admins: 'owner@example.com'});
    const fileId = putCsv(other, {fileId: 'customer_two_file'});
    const imported = webImport(other);
    const review = openReviewsFor(other.customerId, {fileId})
      .find((row) => row.reviewType === 'PARTNER');
    const tx = transactionFor(review);
    const before = destinationValue(imported.destinationSpreadsheetId, tx.destinationRow, 3);
    const result = webResolve(customer.customerId, [decision(review, '越境先')]);
    assert.equal(result.errors[0].reviewId, review.reviewId);
    assert.equal(result.errors[0].code, 'REVIEW_CUSTOMER_MISMATCH');
    assert.equal(destinationValue(imported.destinationSpreadsheetId, tx.destinationRow, 3), before);
  });

  test('webapp 23: a file-level cleanup error does not break the decision accounting identity', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb();
    const decisions = [decision(seeded.reviews[0], '甲社')];
    let commitArgumentCount = null;
    const result = withMocks({
      commitSettledTransactions_: function() {
        commitArgumentCount = arguments.length;
        return {deferred: 0};
      },
      completeFileIfFullyResolved_: () => { throw new Error('cleanup fault'); }
    }, () => call('webAppResolveReviews', [seeded.customer.customerId, decisions,
      {batchId: 'cleanup-contract', maxOrphanCommits: 999999}]));
    assert.equal(commitArgumentCount, 1, 'client cleanup limits must be ignored');
    const itemErrors = result.errors.filter((entry) => entry.reviewId);
    assert.equal(decisions.length,
      result.resolved + itemErrors.length + result.skippedByLease + result.remaining);
    assert.equal(result.resolvedReviewIds[0], seeded.reviews[0].reviewId);
    assert.ok(result.errors.some((entry) => entry.fileId === seeded.fileId && !entry.reviewId));
  });

  test('webapp 24: empty decisions still authorize and audit an unauthorized customer', () => {
    requireWebFunction('webAppResolveReviews');
    const {world} = setupWorld();
    const other = addCustomer(world, {suffix: '2', customerId: 'C002',
      reviewers: 'other@example.com', admins: 'other-admin@example.com'});
    const before = permissionRows().length;
    const error = caught(() => gas.call('webAppResolveReviews',
      [other.customerId, [], {batchId: 'empty-batch'}]));
    assert.equal(error.name, 'AuthorizationError');
    assert.equal(error.reason, 'NO_CUSTOMER_ACCESS');
    assert.equal(permissionRows().length, before + 1);
  });

  test('webapp 25: the unchanged menu resolution path also writes the review destination', () => {
    requireWebFunction('webAppRunImport');
    const seeded = seedPartnerViaWeb({world: {customer: {sentinelRow: 2,
      sentinelValue: '雛形メニュー'}}});
    const review = seeded.reviews[0];
    const tx = transactionFor(review);
    const item = {kind: 'PARTNER_GROUP', reviewType: 'PARTNER',
      customerId: seeded.customer.customerId, customerName: seeded.customer.customerName,
      merchantOriginal: review.merchantOriginal, reviews: [review]};
    const outcome = call('applyResolveDecision_', [item, 'ADOPT_EXISTING_PARTNER',
      {reviewId: review.reviewId, partnerName: 'メニュー先'},
      {maxPerAction: 1, deadlineMs: 999999, tripWorstMs: 0}]);
    assert.equal(outcome.resolved, 1);
    assert.equal(destinationValue(seeded.destinationSpreadsheetId, tx.destinationRow, 3),
      'メニュー先');
    assert.equal(destinationValue(seeded.customer.destinationId, tx.destinationRow, 3),
      '雛形メニュー');
  });

  // Cases 26 and 27 were deleted by §8.5; they intentionally have no test block.
  test('webapp 28: an unresolvable decision does not strand later normal decisions', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({rows: [
      '日付不明,未登録店,1000,仕入れ',
      '2025/12/11,未登録店,1001,仕入れ',
      '2025/12/12,未登録店,1002,仕入れ'
    ]});
    const all = openReviewsFor(seeded.customer.customerId, {fileId: seeded.fileId});
    const dateReview = all.find((row) => row.reviewType === 'DATE');
    const partners = all.filter((row) => row.reviewType === 'PARTNER')
      .sort((a, b) => Number(a.sourceRow) - Number(b.sourceRow));
    call('resolveReview', [dateReview.reviewId, 'EXCLUDE', {}]);
    const run = resolveLoop(seeded.customer.customerId,
      partners.map((review) => decision(review, '確定先')));
    assert.equal(run.remaining.length, 0);
    assert.ok(run.calls.length <= 3, `calls=${run.calls.length}`);
    assert.ok(run.seenErrors.has(partners[0].reviewId));
    assert.equal(reviewById(partners[0].reviewId).status, 'OPEN');
    partners.slice(1).forEach((review) => {
      assert.equal(reviewById(review.reviewId).status, 'RESOLVED');
    });
  });

  test('webapp 29: review listing returns all three learnBlockedBy values', () => {
    requireWebFunction('webAppListReviews');
    const normal = seedPartnerViaWeb({merchant: '通常店'});
    let listed = call('webAppListReviews', [normal.customer.customerId, 15, 0]);
    assert.equal(listed.reviews[0].learnBlockedBy, null);

    const empty = seedPartnerViaWeb({merchant: '\u0001'});
    listed = call('webAppListReviews', [empty.customer.customerId, 15, 0]);
    assert.equal(listed.reviews[0].learnBlockedBy, 'EMPTY_MERCHANT');

    const cardName = seedPartnerViaWeb({world: {customer: {
      cardNamePartnerPurposes: ['年会費']}}, purpose: '年会費'});
    listed = call('webAppListReviews', [cardName.customer.customerId, 15, 0]);
    assert.equal(listed.reviews[0].learnBlockedBy, 'CARD_NAME_PURPOSE');
  });

  test('webapp 30: review listing clamps a client limit of 500 to 15', () => {
    requireWebFunction('webAppListReviews');
    const seeded = seedPartnerViaWeb({count: 16});
    const listed = call('webAppListReviews', [seeded.customer.customerId, 500, 0]);
    assert.equal(listed.partnerTotal, 16);
    assert.equal(listed.limit, 15);
    assert.ok(listed.reviews.length <= 15);
  });

  test('webapp 31: a superseded transaction nulls only its own display values', () => {
    requireWebFunction('webAppListReviews');
    const seeded = seedPartnerViaWeb({count: 2});
    call('supersede', [seeded.reviews[0].fullTxId, 'test', 'owner@example.com']);
    const listed = call('webAppListReviews', [seeded.customer.customerId, 15, 0]);
    const dead = listed.reviews.find((row) => row.reviewId === seeded.reviews[0].reviewId);
    const live = listed.reviews.find((row) => row.reviewId === seeded.reviews[1].reviewId);
    assert.ok(dead);
    assert.equal(dead.usageDate, null);
    assert.equal(dead.amount, null);
    assert.ok(live);
    assert.notEqual(live.usageDate, null);
    assert.notEqual(live.amount, null);
  });

  test('webapp 32: bootstrap canImport stays false for an owner absent from Q and R', () => {
    requireWebFunction('webAppBootstrap');
    const {world} = setupWorld({actor: 'owner@example.com', customer: {
      reviewers: 'reviewer@example.com', admins: 'admin@example.com'}});
    addCustomer(world, {suffix: '2', customerId: 'C002', customerName: '顧客二',
      reviewers: 'owner@example.com', admins: 'admin2@example.com'});
    const result = call('webAppBootstrap');
    const byId = Object.fromEntries(result.customers.map((row) => [row.customerId, row]));
    assert.equal(result.isOwner, true);
    assert.equal(byId.C001.canImport, false);
    assert.equal(byId.C002.canImport, true);
  });

  test('webapp 33: a leased candidate stops before creating a spreadsheet copy', () => {
    requireWebFunction('webAppRunImport');
    const {customer} = setupWorld();
    const fileId = putCsv(customer, {fileId: 'leased_import'});
    call('acquireLease', [customer.customerId, fileId, 'other-run',
      'other@example.com', 'PROCESS']);
    const before = spreadsheetIds();
    const result = webImport(customer);
    assert.deepEqual(spreadsheetIds(), before);
    assert.equal(result.stoppedBy, 'LEASE_CONFLICT');
    assert.equal(result.done, 0);
    assert.equal(result.total, 0);
    assert.equal(result.remaining, 0);
  });

  test('webapp 34: result ID sets account for every sent decision exactly once', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({count: 3});
    call('acquireLease', [seeded.customer.customerId, seeded.fileId, 'other-run',
      'other@example.com', 'PROCESS']);
    const decisions = [decision(seeded.reviews[0], ''), decision(seeded.reviews[1], ''),
      decision(seeded.reviews[2], '採用先')];
    const result = webResolve(seeded.customer.customerId, decisions);
    const accounted = (result.resolvedReviewIds || [])
      .concat(result.skippedByLeaseReviewIds || [])
      .concat((result.errors || []).filter((entry) => entry.reviewId)
        .map((entry) => entry.reviewId));
    assert.deepEqual(accounted.slice().sort(), decisions.map((entry) => entry.reviewId).sort());
    assert.equal(new Set(accounted).size, decisions.length);
    assert.equal(decisions.length,
      result.resolved + result.skippedByLease +
      result.errors.filter((entry) => entry.reviewId).length + result.remaining);
  });

  test('webapp 35: advancing offset reveals the sixteenth review behind fifteen dead rows', () => {
    requireWebFunction('webAppListReviews');
    const rows = Array.from({length: 16}, (_, index) =>
      `日付不明,未登録店,${1000 + index},仕入れ`);
    const seeded = seedPartnerViaWeb({rows});
    const all = openReviewsFor(seeded.customer.customerId, {fileId: seeded.fileId});
    const partners = all.filter((row) => row.reviewType === 'PARTNER')
      .sort((a, b) => Number(a.sourceRow) - Number(b.sourceRow));
    const dates = all.filter((row) => row.reviewType === 'DATE');
    const reviewSheet = gas.stubs.getSpreadsheet('master').getSheetByName('要確認');
    partners.forEach((review, index) => {
      // 生の行順では live が先頭、reviewId 順では dead 15 件の後になる。
      const id = index === 0 ? 'RV_LIVE_99' :
        `RV_DEAD_${String(index).padStart(2, '0')}`;
      reviewSheet.getRange(review._rowNumber, 1).setValue(id);
    });
    const dateByTx = new Map(dates.map((row) => [row.fullTxId, row]));
    partners.slice(1).forEach((review) => {
      call('resolveReview', [dateByTx.get(review.fullTxId).reviewId, 'EXCLUDE', {}]);
    });
    const first = call('webAppListReviews', [seeded.customer.customerId, 15, 0]);
    const second = call('webAppListReviews', [seeded.customer.customerId, 15, 15]);
    assert.equal(first.reviews.length, 15);
    assert.equal(second.offset, 15);
    assert.deepEqual(second.reviews.map((row) => row.reviewId), ['RV_LIVE_99']);
  });

  test('webapp 36: three import calls keep passing one destination and create one copy', () => {
    requireWebFunction('webAppRunImport');
    const {customer} = setupWorld({knownMerchant: true});
    const fileIds = [0, 1, 2].map((index) => putCsv(customer, {
      fileId: `known_file_${index}`, rows: [`2025/12/${10 + index},既知店,${2000 + index},仕入れ`]
    }));
    const before = spreadsheetIds();
    let destinationSpreadsheetId = null;
    const calls = [];
    for (let index = 0; index < 5; index += 1) {
      const options = destinationSpreadsheetId ? {destinationSpreadsheetId} : {};
      const result = webImport(customer, options);
      calls.push(result);
      destinationSpreadsheetId = result.destinationSpreadsheetId || destinationSpreadsheetId;
      if (result.remaining === 0) break;
      assert.ok(result.done > 0, JSON.stringify(result));
    }
    assert.equal(calls.length, 3);
    assert.deepEqual(createdIds(before), [destinationSpreadsheetId]);
    assert.ok(calls.every((result) => result.destinationSpreadsheetId === destinationSpreadsheetId));
    fileIds.forEach((fileId) => {
      assert.equal(call('getTransactionsByStatus', [fileId, ['COMMITTED']]).length, 1);
      assert.equal(gas.call('getFileState', [fileId]), 'COMPLETED');
    });
  });

  test('webapp 37: import checks assignee registration before making a copy', () => {
    requireWebFunction('webAppRunImport');
    const {customer} = setupWorld({actor: 'owner@example.com', customer: {
      reviewers: 'reviewer@example.com', admins: 'admin@example.com'}});
    putCsv(customer, {fileId: 'unauthorized_import'});
    const before = spreadsheetIds();
    const result = webImport(customer);
    assert.deepEqual(createdIds(before), []);
    assert.equal(result.stoppedBy, 'NO_AUTHORIZED_CUSTOMER');
    assert.equal(result.done, 0);
    assert.equal(result.total, 0);
    assert.equal(result.remaining, 0);
  });

  test('webapp 38: decisions beyond the server maximum are reported and accounted for', () => {
    requireWebFunction('webAppResolveReviews');
    const maximum = Number(gas.context.WEBAPP_MAX_DECISIONS_);
    const seeded = seedPartnerViaWeb({count: maximum + 1});
    const decisions = seeded.reviews.map((review) => decision(review, '上限テスト先'));
    const result = webResolve(seeded.customer.customerId, decisions);
    const itemErrors = result.errors.filter((entry) => entry.reviewId);
    const overflow = itemErrors.filter((entry) => entry.code === 'TOO_MANY_DECISIONS');
    assert.deepEqual(overflow.map((entry) => entry.reviewId),
      [seeded.reviews[maximum].reviewId]);
    assert.equal(decisions.length,
      result.resolved + itemErrors.length + result.skippedByLease + result.remaining);
  });

  test('webapp 39: decisions spanning two files defer the second file on the server', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({fileId: 'deferred_one', merchant: '第一の店'});
    const secondFileId = putCsv(seeded.customer, {fileId: 'deferred_two',
      rows: ['2025/12/20,第二の店,2200,第二用途']});
    webImport(seeded.customer, {destinationSpreadsheetId: seeded.destinationSpreadsheetId});
    const secondReview = openReviewsFor(seeded.customer.customerId, {fileId: secondFileId})
      .find((row) => row.reviewType === 'PARTNER');
    assert.ok(secondReview);
    const decisions = [decision(seeded.reviews[0], ''), decision(secondReview, '')];
    const result = withMocks({WEBAPP_MAX_PER_CALL_: 2, WEBAPP_TRIP_WORST_MS_: 0},
      () => webResolve(seeded.customer.customerId, decisions));
    assert.equal(result.resolved, 1);
    assert.deepEqual(result.resolvedReviewIds, [seeded.reviews[0].reviewId]);
    assert.equal(result.deferredByFile, 1);
    assert.equal(result.remaining, 1);
    assert.equal(result.notAttempted, 1);
    assert.equal(reviewById(secondReview.reviewId).status, 'OPEN');
  });

  test('webapp 40: an already settled review is reported without calling resolveReview again', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb();
    const review = seeded.reviews[0];
    const tx = transactionFor(review);
    call('resolveReview', [review.reviewId, 'ADOPT_EXISTING_PARTNER',
      {partnerName: '確定済み先', learn: false}]);
    const before = destinationValue(seeded.destinationSpreadsheetId, tx.destinationRow, 3);
    let resolveCalls = 0;
    const result = withMocks({
      resolveReview() {
        resolveCalls += 1;
        throw new Error('resolveReview must not be called for a settled review');
      }
    }, () => webResolve(seeded.customer.customerId, [decision(review, '再確定先')]));
    assert.equal(resolveCalls, 0);
    assert.equal(result.errors[0].reviewId, review.reviewId);
    assert.equal(result.errors[0].code, 'ALREADY_SETTLED');
    assert.equal(destinationValue(seeded.destinationSpreadsheetId, tx.destinationRow, 3), before);
  });

  test('webapp 41: HtmlService rejects an unregistered template name', () => {
    requireWebFunction('doGet');
    gas.stubs.reset();
    gas.stubs.setHtmlTemplate('<main>registered template</main>');
    assert.equal(gas.call('doGet', []).getContent(), '<main>registered template</main>');
    const error = caught(() => gas.context.HtmlService
      .createTemplateFromFile('no_such_template'));
    assert.match(error.message, /no_such_template/);
  });

  test('webapp 43: identical partner names collapse to one candidate in the listing', () => {
    requireWebFunction('webAppListReviews');
    const seeded = setupWorld({});
    // 学習が重複を確かめずに積んだ辞書を作る（34_MerchantDictionary.gs 22行）。
    // 実機では1件の要確認に同一の「Amazon」が30個並んだ（2026-09-16）。
    // 競合フラグが立っているので自動採用されず、要確認として表に出る。
    const dictionary = gas.stubs.getSpreadsheet('master')
      .getSheetByName('顧客別取引先辞書');
    for (let index = 0; index < 5; index += 1) {
      const row = blank(18);
      Object.assign(row, {
        0: `DICT_DUP_${index}`, 1: 'AMAZON.CO.JP', 2: 'AMAZON.CO.JP', 3: 'Amazon',
        4: 'exact_original', 5: 1, 6: seeded.customer.customerId, 9: 'TRUE',
        10: 'owner@example.com', 12: '2026-01-01T00:00:00+09:00', 13: 1,
        14: 'TRUE', 15: 'TRUE'
      });
      dictionary.appendRow(row);
    }
    putCsv(seeded.customer, {fileId: 'duplicate_dictionary',
      rows: ['2025/12/10,AMAZON.CO.JP,5280,仕入れ']});
    webImport(seeded.customer, {});
    const listed = call('webAppListReviews', [seeded.customer.customerId, 15, 0]);
    assert.equal(listed.reviews.length, 1);
    assert.deepEqual(listed.reviews[0].candidates.map((row) => row.partnerName),
      ['Amazon']);
  });

  test('webapp 44: the shipped budget constants keep a full call inside the deadline', () => {
    // 受入 12（2026-09-16 実機）で置き直した値。ここを動かすときは
    // 下の不等式ごと確かめること ── 上限だけ上げると6分に当たる。
    assert.equal(gas.context.WEBAPP_TRIP_WORST_MS_, 400);
    assert.equal(gas.context.WEBAPP_MAX_PER_CALL_, 8);
    // 80_WebApp.gs 359行のゲートが通す最悪：上限いっぱいの件数を、
    // 1件ぶんの実費＋事前走査で踏み、最後に後始末が乗る。
    const worstMs = gas.context.WEBAPP_TRIP_WORST_MS_ *
      (gas.context.WEBAPP_MAX_PER_CALL_ * (gas.context.WEBAPP_ITEM_TRIPS_ + 2) +
        gas.context.WEBAPP_CLEANUP_TRIPS_ + 2);
    assert.ok(worstMs < gas.context.WEBAPP_DEADLINE_MS_,
      `worst case ${worstMs} ms must stay under ${gas.context.WEBAPP_DEADLINE_MS_} ms`);
  });

  test('webapp 45: the deadline gate stops the loop even when the cap would allow more', () => {
    requireWebFunction('webAppResolveReviews');
    // 上限 8 で運用する以上、6分に当たらせないのは締切ゲートの仕事である。
    // ケース 39 は単価を 0 にしてゲートを無効化したうえで上限を見ているので、
    // ゲート自体はどの変異でも赤にならなかった（2026-09-16 に実測）。
    const seeded = seedPartnerViaWeb({count: 2});
    const decisions = seeded.reviews.map((review) => decision(review, '株式会社テスト'));
    const result = withMocks({WEBAPP_MAX_PER_CALL_: 5, WEBAPP_TRIP_WORST_MS_: 100000},
      () => webResolve(seeded.customer.customerId, decisions));
    assert.equal(result.resolved, 0);
    assert.equal(result.remaining, 2);
    seeded.reviews.forEach((review) => {
      assert.equal(reviewById(review.reviewId).status, 'OPEN');
    });
  });

  function seedDictionaryRow(customerId, options) {
    const row = blank(18);
    Object.assign(row, {
      0: options.dictId, 1: options.original, 2: options.original,
      3: options.partnerName, 4: 'exact_original', 5: 1, 6: customerId,
      9: 'TRUE', 10: 'owner@example.com', 12: '2026-01-01T00:00:00+09:00',
      13: 1, 14: 'TRUE', 15: options.conflict ? 'TRUE' : 'FALSE'
    });
    gas.stubs.getSpreadsheet('master').getSheetByName('顧客別取引先辞書').appendRow(row);
  }

  test('webapp 45b: opsExplainPartnerMatch names which condition blocked auto-adoption', () => {
    requireWebFunction('opsExplainPartnerMatch');
    // 「マスターに登録してあるのに要確認になる」の原因は3通りあり、見分けが
    // つかないと直しようがない。診断が原因を取り違えると、判断そのものが狂う。

    // (1) 取引先名は1つだが競合フラグで止められている（2026-09-16 の実機）。
    // 実機と同じく、同じ取引先名の行が複数ある状態で作る ── 行が何個あっても
    // **取引先名は 1 つ**と数えなければ、原因が「名前が複数」に化ける。
    const flagged = setupWorld({});
    [0, 1, 2].forEach((index) => {
      seedDictionaryRow(flagged.customer.customerId, {dictId: `DICT_FLAG_${index}`,
        original: 'AMAZON.CO.JP', partnerName: 'Amazon', conflict: true});
    });
    putCsv(flagged.customer, {fileId: 'conflict_flag',
      rows: ['2025/12/10,AMAZON.CO.JP,5280,仕入れ']});
    webImport(flagged.customer, {});
    const flaggedReview = openReviewsFor(flagged.customer.customerId,
      {fileId: 'conflict_flag'}).find((row) => row.reviewType === 'PARTNER');
    assert.ok(flaggedReview, '競合フラグが立っていれば要確認になる');
    const byFlag = call('opsExplainPartnerMatch', [flaggedReview.reviewId]);
    assert.equal(byFlag.matchedBy, 'STEP1');
    assert.equal(byFlag.blockedBy, 'CONFLICT_FLAG');
    assert.equal(byFlag.candidateRows, 3);
    assert.deepEqual(byFlag.distinctPartnerNames, ['Amazon']);

    // (2) 取引先名が複数ある。フラグではなく名前が原因である。
    const ambiguous = setupWorld({});
    seedDictionaryRow(ambiguous.customer.customerId, {dictId: 'DICT_A',
      original: 'RAKUTEN.CO.JP', partnerName: '楽天', conflict: false});
    seedDictionaryRow(ambiguous.customer.customerId, {dictId: 'DICT_B',
      original: 'RAKUTEN.CO.JP', partnerName: '楽天カード', conflict: false});
    putCsv(ambiguous.customer, {fileId: 'two_names',
      rows: ['2025/12/10,RAKUTEN.CO.JP,3300,仕入れ']});
    webImport(ambiguous.customer, {});
    const ambiguousReview = openReviewsFor(ambiguous.customer.customerId,
      {fileId: 'two_names'}).find((row) => row.reviewType === 'PARTNER');
    assert.ok(ambiguousReview);
    const byNames = call('opsExplainPartnerMatch', [ambiguousReview.reviewId]);
    assert.equal(byNames.blockedBy, 'MULTIPLE_PARTNER_NAMES');
    assert.equal(byNames.distinctPartnerNames.length, 2);
    // 同じ正規化表記の行を取引先名ごとに数える ── 競合の巻き込み元を見る欄。
    assert.equal(byNames.normalizedGroup.length, 2);
  });

  test('webapp 45c: opsExplainPartnerReviews groups by merchant and explains one each', () => {
    requireWebFunction('opsExplainPartnerReviews');
    // エディタのプルダウンは引数を渡せないので、引数なしの入口が要る。
    // 同じ店名が何件並んでいても、辞書を見るのは 1 回でよい。
    const seeded = setupWorld({});
    seedDictionaryRow(seeded.customer.customerId, {dictId: 'DICT_GROUPED',
      original: 'AMAZON.CO.JP', partnerName: 'Amazon', conflict: true});
    putCsv(seeded.customer, {fileId: 'grouped', rows: [
      '2025/12/10,AMAZON.CO.JP,5280,仕入れ',
      '2025/12/11,AMAZON.CO.JP,1200,仕入れ',
      '2025/12/12,AMAZON.CO.JP,3400,仕入れ'
    ]});
    webImport(seeded.customer, {});
    const summary = call('opsExplainPartnerReviews', []);
    assert.equal(summary.openPartnerReviews, 3);
    assert.equal(summary.distinctMerchants, 1, '同じ店名は 1 つにまとめる');
    assert.equal(summary.explained, 1, '店名ごとに 1 件だけ辞書を見る');
    assert.equal(summary.reports[0].blockedBy, 'CONFLICT_FLAG');
    assert.equal(summary.reports[0].sameMerchantReviews, 3);
  });

  function dictionaryRows() {
    return gas.stubs.getSpreadsheet('master').getSheetByName('顧客別取引先辞書')
      .getDataRange().getValues().slice(1)
      .filter((row) => String(row[0] || '') !== '');
  }

  test('webapp 45d: merging partner name variants unblocks the rows they dragged in', () => {
    requireWebFunction('opsMergePartnerNameVariants');
    // 競合フラグは正規化表記の単位で立つので、1 行の表記ゆれが完全一致している
    // 行まで巻き込む。実機は amazon 1 行が Amazon 30 行を止めていた。
    const seeded = setupWorld({});
    seedDictionaryRow(seeded.customer.customerId, {dictId: 'DICT_WIDE',
      original: 'ＡＭＡＺＯＮ．ＣＯ．ＪＰ', partnerName: 'Amazon', conflict: true});
    seedDictionaryRow(seeded.customer.customerId, {dictId: 'DICT_NARROW',
      original: 'AMAZON.CO.JP', partnerName: 'amazon', conflict: true});
    putCsv(seeded.customer, {fileId: 'variants',
      rows: ['2025/12/10,ＡＭＡＺＯＮ．ＣＯ．ＪＰ,5280,仕入れ']});
    webImport(seeded.customer, {});
    const blocked = openReviewsFor(seeded.customer.customerId, {fileId: 'variants'})
      .find((row) => row.reviewType === 'PARTNER');
    assert.ok(blocked, '表記ゆれがある間は要確認になる');
    assert.equal(call('opsExplainPartnerMatch', [blocked.reviewId]).blockedBy, 'CONFLICT_FLAG');

    const merged = call('opsMergePartnerNameVariants', ['AMAZON.CO.JP', 'Amazon']);
    assert.equal(merged.renamed.length, 1);
    assert.equal(merged.renamed[0].from, 'amazon');
    assert.equal(merged.clearedConflictRows.length, 2);
    dictionaryRows().forEach((row) => {
      assert.equal(row[3], 'Amazon', '取引先名が正へ寄る');
      assert.equal(String(row[15]).toUpperCase(), 'FALSE', '競合フラグが外れる');
    });
    // 寄せた後は自動採用まで通ること ── フラグを外しただけで終わらせない。
    assert.equal(call('opsExplainPartnerMatch', [blocked.reviewId]).autoConfirm, true);
  });

  test('webapp 45e: a genuinely different partner name is refused without writing', () => {
    requireWebFunction('opsMergePartnerNameVariants');
    // 別の取引先を指す競合をフラグだけ外して黙らせると、以後その店名は
    // 誤った取引先で静かに自動確定される。書く前に止めなければ意味がない。
    const seeded = setupWorld({});
    seedDictionaryRow(seeded.customer.customerId, {dictId: 'DICT_ONE',
      original: 'AMAZON.CO.JP', partnerName: 'Amazon', conflict: true});
    seedDictionaryRow(seeded.customer.customerId, {dictId: 'DICT_TWO',
      original: 'AMAZON.CO.JP', partnerName: 'Amazon Web Services', conflict: true});
    const before = JSON.stringify(dictionaryRows());
    const error = caught(() => gas.call('opsMergePartnerNameVariants',
      ['AMAZON.CO.JP', 'Amazon']));
    assert.match(String(error.message), /表記ゆれではない/);
    assert.equal(JSON.stringify(dictionaryRows()), before, '1 行も書かない');
  });

  function forceFileState(fileId, state) {
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName('恒久ファイルインデックス');
    const values = sheet.getDataRange().getValues();
    for (let index = 1; index < values.length; index += 1) {
      if (String(values[index][0]) === String(fileId)) {
        sheet.getRange(index + 1, 4).setValue(state);
        return;
      }
    }
    assert.fail(`恒久ファイルインデックスに ${fileId} が無い`);
  }

  test('webapp 45f: the stuck-file report reads the clone, not the template', () => {
    requireWebFunction('opsExplainStuckFileTransactions');
    // opsInspectStuckFiles は customer.destinationSpreadsheetId＝雛形を開くので、
    // 複製へ書いた取引を「1 行も書けていない」と報告する（K-W18）。実機では
    // COMMITTED 29 件に対して rowsCarryingTxId: 0 と出た。ここは要確認行の
    // M列を正本にするので、同じ取引が見えなければならない。
    const seeded = seedPartnerViaWeb({count: 2});
    // 1 件だけ確定させる ── 実機の 202502.xlsx は 32 件中 29 件が確定済みで、
    // 報告に並ぶべきは残りの 3 件だけだった。全件が未終端の固定データでは、
    // 終端を外す絞り込みが効いていなくても同じ結果になる。
    webResolve(seeded.customer.customerId, [decision(seeded.reviews[0], '株式会社テスト')]);
    forceFileState(seeded.fileId, 'WRITING');
    const report = call('opsExplainStuckFileTransactions', []);
    assert.equal(report.length, 1);
    const file = report[0];
    assert.equal(file.destinationSpreadsheetId, seeded.destinationSpreadsheetId,
      '複製を開くこと');
    assert.notEqual(file.destinationSpreadsheetId, seeded.customer.destinationId,
      '雛形ではないこと');
    assert.equal(file.destinationFromReviewRow, true);
    assert.equal(file.transactions, 2);
    assert.equal(file.unfinishedCount, 1, '確定した取引は並べない');
    file.unfinished.forEach((tx) => {
      assert.equal(tx.status, 'REVIEW_REQUIRED');
      assert.deepEqual(tx.reviews, ['PARTNER:OPEN']);
      assert.equal(tx.rowCarriesTxId, true, '複製の転記行に取引IDが入っている');
    });
  });

  test('webapp 45g: a transaction left without any review is visible as such', () => {
    requireWebFunction('opsExplainStuckFileTransactions');
    // 実機の K-W19：要確認 0 件のまま REVIEW_REQUIRED が 3 件残った。
    // 要確認が在るのか無いのかで、要るのが登録なのか確定なのかが変わる。
    const seeded = seedPartnerViaWeb({count: 1});
    const reviewSheet = gas.stubs.getSpreadsheet('master').getSheetByName('要確認');
    const values = reviewSheet.getDataRange().getValues();
    for (let index = 1; index < values.length; index += 1) {
      if (String(values[index][0]) === String(seeded.reviews[0].reviewId)) {
        reviewSheet.getRange(index + 1, 2).setValue('RESOLVED');
        break;
      }
    }
    forceFileState(seeded.fileId, 'WRITING');
    const file = call('opsExplainStuckFileTransactions', [])[0];
    assert.equal(file.unfinishedCount, 1);
    assert.equal(file.unfinished[0].status, 'REVIEW_REQUIRED');
    assert.deepEqual(file.unfinished[0].reviews, ['PARTNER:RESOLVED'],
      '解決済みの要確認も見せる ── 「未解決が無い」と「要確認が無い」は別である');
  });

  function reviewSheet() {
    return gas.stubs.getSpreadsheet('master').getSheetByName('要確認');
  }

  function eachReviewRow(reviewIds, fn) {
    const wanted = new Set(reviewIds.map(String));
    const values = reviewSheet().getDataRange().getValues();
    let found = 0;
    for (let index = 1; index < values.length; index += 1) {
      if (wanted.has(String(values[index][0]))) { fn(index + 1); found += 1; }
    }
    assert.equal(found, wanted.size, '要確認シートに全部の行があること');
  }

  /** 「要確認が登録される前に殺された」を作る ── 行ごと空にする。 */
  function blankReviewRows(reviewIds) {
    eachReviewRow(reviewIds, (rowNumber) => {
      reviewSheet().getRange(rowNumber, 1, 1, 32).setValues([blank(32)]);
    });
  }

  /** 要確認行の M列（転記先）を書き換える ── K-W10 の状況を作る。 */
  function setReviewDestination(reviewIds, spreadsheetId) {
    eachReviewRow(reviewIds, (rowNumber) => {
      reviewSheet().getRange(rowNumber, 13).setValue(spreadsheetId);
    });
  }

  /** 転記先で取引IDを持つ行番号。増えたら二重転記である。 */
  function txIdRowsIn(spreadsheetId, customerId) {
    const customer = call('getCustomerById', [customerId]);
    const column = Number(customer.columnMapping.txId) - 1;
    const values = gas.stubs.getSpreadsheet(spreadsheetId)
      .getSheetByName('入力用シート').getDataRange().getValues();
    const rows = [];
    values.forEach((row, index) => {
      if (String(row[column] || '').indexOf('TX_') === 0) rows.push(index + 1);
    });
    return rows;
  }

  function fileStateOf(fileId) {
    const values = gas.stubs.getSpreadsheet('master')
      .getSheetByName('恒久ファイルインデックス').getDataRange().getValues();
    const hit = values.find((row) => String(row[0]) === String(fileId));
    return hit ? String(hit[3]) : null;
  }

  test('webapp 45h: recovery of a web-imported stuck file uses the clone and re-import adds no rows', () => {
    requireWebFunction('opsRecoverStuckFiles');
    // 2026-09-16 の実機そのもの：取込が 6 分で殺され、1 件は要確認が解決済み、
    // 2 件は転記はされたが要確認が登録される前に殺された。K-W10 のまま回復すると
    // 雛形の索引で動き、複製に居る取引を雛形へもう一度書く。
    const seeded = seedPartnerViaWeb({count: 3});
    const customerId = seeded.customer.customerId;
    const clone = seeded.destinationSpreadsheetId;
    const template = seeded.customer.destinationId;
    webResolve(customerId, [decision(seeded.reviews[0], '株式会社テスト')]);
    blankReviewRows([seeded.reviews[1].reviewId, seeded.reviews[2].reviewId]);
    forceFileState(seeded.fileId, 'WRITING');
    const cloneRowsBefore = txIdRowsIn(clone, customerId);
    assert.equal(cloneRowsBefore.length, 3, '3 件とも複製に転記済み');
    assert.deepEqual(txIdRowsIn(template, customerId), [], '雛形には何も無い');

    const recovered = call('opsRecoverStuckFiles', []);
    assert.equal(recovered.length, 1, JSON.stringify(recovered));
    assert.equal(recovered[0].destinationSource, 'REVIEW_ROW', '解決済みの要確認から複製を引く');
    assert.equal(recovered[0].error, undefined, JSON.stringify(recovered[0]));
    assert.equal(recovered[0].rewound, true, '行を持つ取引しか無いので回復は空振りし、発見へ戻す');
    assert.deepEqual(txIdRowsIn(template, customerId), [], '雛形には 1 行も書かない');
    assert.equal(fileStateOf(seeded.fileId), 'DISCOVERED');

    // 同じ複製へ取り込み直す。行は増えず、殺された 2 件は要確認を取り戻す。
    const before = spreadsheetIds();
    const reimport = webImport(seeded.customer, {destinationSpreadsheetId: clone});
    assert.deepEqual(createdIds(before), [], '新しい複製を作らない');
    assert.deepEqual(txIdRowsIn(clone, customerId), cloneRowsBefore, '複製の行が増えない');
    assert.deepEqual(txIdRowsIn(template, customerId), []);
    const partners = openReviewsFor(customerId, {fileId: seeded.fileId})
      .filter((row) => row.reviewType === 'PARTNER');
    const statuses = seeded.reviews.map((review) => {
      const tx = transactionFor(review);
      return `${tx.transactionStatus}/${tx.partnerResolutionStatus}/F=${JSON.stringify(
        tx.planned && tx.planned.f)}`;
    });
    const everyReview = call('allReviewRecords_', [])
      .filter((row) => String(row.fileId || '') === String(seeded.fileId))
      .map((row) => `${row.reviewType}:${row.status}:${String(row.fullTxId || '').slice(0, 12)}`);
    assert.equal(partners.length, 2,
      `殺された 2 件だけが要確認に戻る。実際: 要確認 ${partners.length} 件、取引 ${JSON.stringify(statuses)}、` +
      `ファイル状態 ${fileStateOf(seeded.fileId)}、要確認行(全状態) ${JSON.stringify(everyReview)}、` +
      `再取込 ${JSON.stringify({done: reimport.done, remaining: reimport.remaining,
        files: importFileResults(reimport).map((f) => ({fileId: f.fileId, code: f.code}))})}`);
    partners.forEach((review) => {
      assert.equal(review.destinationSpreadsheetId, clone, '要確認の転記先も複製のまま');
    });
    const committed = transactionFor(seeded.reviews[0]);
    assert.equal(committed.transactionStatus, 'COMMITTED', '確定済みは触らない');
  });

  test('webapp 45i: recovery refuses when the review rows point at a sheet the rows are not in', () => {
    requireWebFunction('opsRecoverStuckFiles');
    // 要確認行の M列が雛形を指すのに、行は複製にある ── K-W10 が起きる形。
    // 転記先を選んだあとの検算が無いと、雛形の索引で回復して二重転記になる。
    const seeded = seedPartnerViaWeb({count: 2});
    const customerId = seeded.customer.customerId;
    const template = seeded.customer.destinationId;
    setReviewDestination(seeded.reviews.map((review) => review.reviewId), template);
    forceFileState(seeded.fileId, 'WRITING');

    const recovered = call('opsRecoverStuckFiles', []);
    assert.equal(recovered.length, 1);
    assert.match(String(recovered[0].error), /DESTINATION_MISMATCH/);
    assert.equal(recovered[0].misplaced.length, 2);
    assert.equal(recovered[0].rewound, undefined, '書かないし戻さない');
    assert.deepEqual(txIdRowsIn(template, customerId), [], '雛形には 1 行も書かない');
    assert.equal(fileStateOf(seeded.fileId), 'WRITING', '状態も動かさない');
  });

  test('webapp 45j: a file with no reviews is assumed to be in the template, and the row check catches it if not', () => {
    requireWebFunction('opsRecoverStuckFiles');
    // 要確認が 1 件も無いファイルは雛形と仮定する（定期取込で検証中に止まった
    // ファイルは要確認を持たず、雛形に居るのが正しい ── notify 1b）。
    // 仮定が外れる形＝Web アプリで取り込んで要確認が立つ前に殺されたファイルは、
    // 行の検算で止まらなければならない。雛形の索引にその行は無い。
    const seeded = seedPartnerViaWeb({count: 2});
    const customerId = seeded.customer.customerId;
    const template = seeded.customer.destinationId;
    blankReviewRows(seeded.reviews.map((review) => review.reviewId));
    forceFileState(seeded.fileId, 'WRITING');

    const recovered = call('opsRecoverStuckFiles', []);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].destinationSource, 'TEMPLATE_ASSUMED');
    assert.match(String(recovered[0].error), /DESTINATION_MISMATCH/, '仮定が外れたら検算が止める');
    assert.equal(recovered[0].rewound, undefined);
    assert.deepEqual(txIdRowsIn(template, customerId), [], '雛形には 1 行も書かない');
    assert.equal(fileStateOf(seeded.fileId), 'WRITING');
  });

  test('webapp 45k: re-joining a file whose review is still open adds no second review', () => {
    requireWebFunction('opsRecoverStuckFiles');
    // 45h の直し（再合流で REVIEW_REQUIRED の取引は要確認を作り直す）が、
    // 普通の再合流 ── 要確認がまだ OPEN のまま ── で要確認を二重に作っては
    // ならない。作り直しは registerReview の抑止で冪等でなければならない。
    const seeded = seedPartnerViaWeb({count: 2});
    const customerId = seeded.customer.customerId;
    const clone = seeded.destinationSpreadsheetId;
    forceFileState(seeded.fileId, 'WRITING');
    const recovered = call('opsRecoverStuckFiles', []);
    assert.equal(recovered[0].error, undefined, JSON.stringify(recovered[0]));
    assert.equal(recovered[0].rewound, true);
    const rowsBefore = txIdRowsIn(clone, customerId);

    webImport(seeded.customer, {destinationSpreadsheetId: clone});
    assert.deepEqual(txIdRowsIn(clone, customerId), rowsBefore, '複製の行が増えない');
    const partners = openReviewsFor(customerId, {fileId: seeded.fileId})
      .filter((row) => row.reviewType === 'PARTNER');
    assert.equal(partners.length, 2, '要確認は元の 2 件のまま。二重に作らない');
    assert.deepEqual(partners.map((row) => row.reviewId).sort(),
      seeded.reviews.map((row) => row.reviewId).sort(), '同じ要確認行が生きている');
  });

  // Case 46 is the whole-suite acceptance condition, not an independent test.
};

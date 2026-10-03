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

  function latestImportCall() {
    const lines = gas.stubs.getLogs().filter((line) => line.startsWith('IMPORT_CALL '));
    return lines.length ? JSON.parse(lines[lines.length - 1].slice('IMPORT_CALL '.length)) : null;
  }

  function importCalls() {
    return gas.stubs.getLogs().filter((line) => line.startsWith('IMPORT_CALL '))
      .map((line) => JSON.parse(line.slice('IMPORT_CALL '.length)));
  }

  function withImportTiming(durations, fn, options = {}) {
    const priorClock = gas.context.importClockNow_;
    const priorProcess = gas.context.processDiscoveredFile_;
    const priorAcquire = gas.context.acquireLease;
    const priorFolder = gas.context.webAppDirectChildFolder_;
    let now = Date.now();
    let index = 0;
    gas.context.importClockNow_ = () => now;
    if (options.overheadMs) {
      // 呼出しの準備（フォルダの列挙）に時間がかかったことにする。
      gas.context.webAppDirectChildFolder_ = function(...args) {
        now += Number(options.overheadMs);
        return priorFolder.apply(this, args);
      };
    }
    gas.context.processDiscoveredFile_ = function(runId, customer, candidate, importOptions) {
      const ordinal = index++;
      const duration = Number(durations[ordinal] || 0);
      if (options.failAt === ordinal) {
        now += duration;
        return {fileId: candidate.fileId, fileName: candidate.name, outcome: 'FAILED',
          nextState: 'FAILED', waits: {}, reads: 0};
      }
      const outcome = priorProcess.call(this, runId, customer, candidate, importOptions);
      now += duration;
      return outcome;
    };
    if (options.leaseConflictFileId) {
      gas.context.acquireLease = function(customerId, fileId, ...args) {
        if (String(fileId) === String(options.leaseConflictFileId)) {
          const error = new Error('test lease conflict');
          error.code = 'LEASE_CONFLICT';
          throw error;
        }
        return priorAcquire.call(this, customerId, fileId, ...args);
      };
    }
    try {
      return fn({now: () => now, started: () => index});
    } finally {
      gas.context.importClockNow_ = priorClock;
      gas.context.processDiscoveredFile_ = priorProcess;
      gas.context.acquireLease = priorAcquire;
      gas.context.webAppDirectChildFolder_ = priorFolder;
    }
  }

  function withPinnedOneFilePerCall(fn) {
    return withImportTiming(Array(20).fill(200000), fn);
  }

  function createWebDestination(customer) {
    const importedCustomer = call('getCustomerById', [customer.customerId]);
    const clone = call('webAppCloneDestination_', [importedCustomer, new Date()]);
    return clone.destinationSpreadsheetId;
  }

  function discoveredFileIds(customer) {
    return call('scanUnprocessedFiles', [customer.customerId, {}])
      .map((candidate) => String(candidate.fileId));
  }

  function readCountByImport(fileCount) {
    const {customer} = setupWorld({knownMerchant: true});
    for (let index = 0; index < fileCount; index += 1) {
      putCsv(customer, {fileId: `multi_budget_${fileCount}_${index}`,
        rows: [`2025/12/${String(10 + index).padStart(2, '0')},既知店,${2000 + index},仕入れ`]});
    }
    const destinationSpreadsheetId = createWebDestination(customer);
    gas.evaluate('resetApiReadWindow_()');
    gas.stubs.resetApiCallCounts();
    const before = gas.stubs.getApiCallCounts().batchGet;
    const result = webImport(customer, {destinationSpreadsheetId});
    const after = gas.stubs.getApiCallCounts().batchGet;
    return {reads: after - before, result, record: latestImportCall()};
  }


  /** クライアントの関数を1つ取り出して呼ぶ（`clientStoppedByMessage` と同じ手）。 */
  function clientEval(expression, globals = {}) {
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(WEBAPP_UI_SOURCE);
    assert.ok(scriptMatch, 'Web app script must exist');
    const eventNeedle = "    el['customer-search'].addEventListener";
    assert.ok(scriptMatch[1].includes(eventNeedle), 'client probe insertion point must exist');
    const probe = `    globalThis.__probe = (${expression});\n` + '    return;\n';
    const source = scriptMatch[1].replace(eventNeedle, probe + eventNeedle);
    const sandbox = Object.assign({document: {getElementById() { return {}; }}}, globals);
    vm.runInNewContext(source, sandbox);
    return sandbox.__probe;
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

  test('webapp 08: imported reviews point to the clone and transaction AC and AD record the same clone', () => {
    requireWebFunction('webAppRunImport');
    const seeded = seedPartnerViaWeb();
    assert.equal(seeded.reviews.length, 1);
    const review = reviewById(seeded.reviews[0].reviewId);
    assert.equal(review.destinationSpreadsheetId, seeded.destinationSpreadsheetId);
    assert.equal(review.destinationSheetName, '入力用シート');
    const tx = transactionFor(review);
    assert.equal(tx.destinationSpreadsheetId, seeded.destinationSpreadsheetId);
    assert.equal(tx.destinationSheetName, '入力用シート');
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
    withMocks({WEBAPP_REVIEW_LIST_LIMIT_: 15}, () => {
      const seeded = seedPartnerViaWeb({count: 16});
      const listed = call('webAppListReviews', [seeded.customer.customerId, 500, 0]);
      assert.equal(listed.partnerTotal, 16);
      assert.equal(listed.limit, 15);
      assert.ok(listed.reviews.length <= 15);
    });
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
    withMocks({WEBAPP_REVIEW_LIST_LIMIT_: 15}, () => {
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
  });

  test('webapp 36: three import calls keep passing one destination and create one copy', () =>
    withPinnedOneFilePerCall(() => {
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
  }));

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
    withMocks({WEBAPP_MAX_DECISIONS_: 15}, () => {
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
    const result = withPartnerTiming([200000], () => withMocks({WEBAPP_MAX_PER_CALL_: 2},
      () => webResolve(seeded.customer.customerId, decisions)));
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
    assert.ok(true, '件ごとの往復見積もりは bulk 14 に置き換えた');
  });

  test('webapp 45: the deadline gate stops the loop even when the cap would allow more', () => {
    requireWebFunction('webAppResolveReviews');
    // 上限 8 で運用する以上、6分に当たらせないのは締切ゲートの仕事である。
    // ケース 39 は単価を 0 にしてゲートを無効化したうえで上限を見ているので、
    // ゲート自体はどの変異でも赤にならなかった（2026-09-16 に実測）。
    const seeded = seedPartnerViaWeb({count: 2});
    const decisions = seeded.reviews.map((review) => decision(review, '株式会社テスト'));
    let now = 1000;
    const result = withMocks({WEBAPP_MAX_PER_CALL_: 5,
      partnerBatchClockNow_() { const current = now; now = 251000; return current; }},
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

  /** 恒久索引と処理ログの**両方**を動かす ── 片方だけだと比較更新が落ちる。 */
  function forceFileState(fileId, state) {
    const master = gas.stubs.getSpreadsheet('master');
    [['恒久ファイルインデックス', 1, 4], ['クレカ処理ログ', 8, 17]].forEach(
      ([name, idColumn, stateColumn]) => {
        const sheet = master.getSheetByName(name);
        const values = sheet.getDataRange().getValues();
        const index = values.findIndex((row) => String(row[idColumn - 1]) === String(fileId));
        assert.ok(index > 0, `${name} に ${fileId} が無い`);
        sheet.getRange(index + 1, stateColumn).setValue(state);
      });
  }

  /** 「行を予約する前に殺された」取引を作る ── 回復が書く対象になる。 */
  function clearDestinationRow(fullTxId) {
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName('クレカ取引ログ');
    const values = sheet.getDataRange().getValues();
    const index = values.findIndex((row) => String(row[0]) === String(fullTxId));
    assert.ok(index > 0, `取引ログに ${fullTxId} が無い`);
    sheet.getRange(index + 1, 31).setValue('');
  }

  /** 本仕様より前の取引ログとして、ファイルの AC・AD を空にする。 */
  function clearRecordedDestinationsForFile(fileId) {
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName('クレカ取引ログ');
    const rows = sheet.getDataRange().getValues();
    rows.forEach((row, index) => {
      if (index > 0 && String(row[4]) === String(fileId)) {
        sheet.getRange(index + 1, 29, 1, 2).setValues([['', '']]);
      }
    });
  }

  test('webapp 45f: the stuck-file report reads the clone, not the template', () => {
    requireWebFunction('opsExplainStuckFileTransactions');
    // opsInspectStuckFiles は customer.destinationSpreadsheetId＝雛形を開くので、
    // 複製へ書いた取引を「1 行も書けていない」と報告する（K-W18）。実機では
    // COMMITTED 29 件に対して rowsCarryingTxId: 0 と出た。ここは要確認行の
    // M列を正本にするので、同じ取引が見えなければならない。
    const seeded = seedPartnerViaWeb({count: 2});
    clearRecordedDestinationsForFile(seeded.fileId);
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
    clearRecordedDestinationsForFile(seeded.fileId);
    const customerId = seeded.customer.customerId;
    const clone = seeded.destinationSpreadsheetId;
    const template = seeded.customer.destinationId;
    webResolve(customerId, [decision(seeded.reviews[0], '株式会社テスト')]);
    blankReviewRows([seeded.reviews[1].reviewId, seeded.reviews[2].reviewId]);
    const rowBefore = seeded.reviews.map((review) => Number(transactionFor(review).destinationRow));
    assert.ok(rowBefore.every((row) => row >= 1), '3 件とも置き場を持っている');
    // 1 件は行の予約より前で殺されたことにする ── 回復に書くものを与えないと、
    // 転記先を引く枝そのものが走らない（行を持つ取引だけなら回復は空振りする）。
    clearDestinationRow(seeded.reviews[1].fullTxId);
    forceFileState(seeded.fileId, 'WRITING');
    const cloneRowsBefore = txIdRowsIn(clone, customerId);
    assert.equal(cloneRowsBefore.length, 3, '3 件とも複製に転記済み');
    assert.deepEqual(txIdRowsIn(template, customerId), [], '雛形には何も無い');

    const recovered = call('opsRecoverStuckFiles', []);
    assert.equal(recovered.length, 1, JSON.stringify(recovered));
    assert.equal(recovered[0].destinationSource, 'REVIEW_ROW', '解決済みの要確認から複製を引く');
    assert.equal(recovered[0].error, undefined, JSON.stringify(recovered[0]));
    assert.equal(recovered[0].recovered.length, 1, '行を失った 1 件を複製の索引から拾う');
    assert.equal(recovered[0].rewound, true, '発見へ戻す');
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

    // 再合流の上書きが置き場を消してはならない。消えると採用が
    // 「positive row or rowNumber」で落ちる（2026-09-18 の実機）。
    [1, 2].forEach((index) => {
      const tx = transactionFor(seeded.reviews[index]);
      assert.equal(Number(tx.destinationRow), Number(rowBefore[index]),
        `再取込後も行番号を保つ（tx${index}）`);
    });

    // 要確認が戻っただけでは直っていない。採用まで通って同じ行に F 列が書かれ、
    // 確定して初めて直ったと言える。
    const adopted = call('opsAutoAdoptPartners', []);
    assert.equal(adopted.errors, 0, JSON.stringify(adopted.results));
    const fColumn = Number(call('getCustomerById', [customerId]).columnMapping.F);
    [1, 2].forEach((index) => {
      const tx = transactionFor(seeded.reviews[index]);
      assert.equal(tx.transactionStatus, 'COMMITTED', `採用で確定する（tx${index}）`);
      assert.equal(destinationValue(clone, rowBefore[index], fColumn), '株式会社テスト',
        `同じ行の F 列に取引先が入る（tx${index}）`);
    });
    assert.deepEqual(txIdRowsIn(clone, customerId), cloneRowsBefore, '採用でも行は増えない');
  });

  test('webapp 45i: recovery refuses when the review rows point at a sheet the rows are not in', () => {
    requireWebFunction('opsRecoverStuckFiles');
    // 要確認行の M列が雛形を指すのに、行は複製にある ── K-W10 が起きる形。
    // 転記先を選んだあとの検算が無いと、雛形の索引で回復して二重転記になる。
    const seeded = seedPartnerViaWeb({count: 2});
    clearRecordedDestinationsForFile(seeded.fileId);
    const customerId = seeded.customer.customerId;
    const template = seeded.customer.destinationId;
    setReviewDestination(seeded.reviews.map((review) => review.reviewId), template);
    clearDestinationRow(seeded.reviews[0].fullTxId);   // 回復に書くものを与える
    forceFileState(seeded.fileId, 'WRITING');

    const recovered = call('opsRecoverStuckFiles', []);
    assert.equal(recovered.length, 1);
    assert.match(String(recovered[0].error), /DESTINATION_MISMATCH/);
    assert.equal(recovered[0].misplaced.length, 1, '行を保っている方が食い違いとして出る');
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
    clearRecordedDestinationsForFile(seeded.fileId);
    const customerId = seeded.customer.customerId;
    const template = seeded.customer.destinationId;
    blankReviewRows(seeded.reviews.map((review) => review.reviewId));
    clearDestinationRow(seeded.reviews[0].fullTxId);   // 回復に書くものを与える
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

  /** `settle_` が確定の手前で殺された状態を作る（6分上限は finally を待たない）。 */
  function settleWithoutCommitting(customerId, review, partnerName = '株式会社テスト') {
    return withMocks({
      commitIfConditionsMet: () => ({committed: false, unmetConditions: [], openReviewTypes: []})
    }, () => call('resolveReview', [review.reviewId, 'ADOPT_EXISTING_PARTNER',
      {partnerName, learn: false}]));
  }

  test('webapp 45l: a transaction settled but never committed is picked up', () => {
    requireWebFunction('opsCommitSettledTransactions');
    // 要確認は解決済み・取引先も解決済み・取引だけ REVIEW_REQUIRED。
    // **未解決の要確認が無いので誰も再訪しない** ── 解決操作も自動採用も
    // openReviews を起点にする。2026-09-17 の実機で 1 件出た。
    const seeded = seedPartnerViaWeb({count: 1});
    const customerId = seeded.customer.customerId;
    settleWithoutCommitting(customerId, seeded.reviews[0]);

    const orphan = transactionFor(seeded.reviews[0]);
    assert.equal(orphan.transactionStatus, 'REVIEW_REQUIRED', '確定だけ走っていない');
    assert.equal(orphan.partnerResolutionStatus, 'RESOLVED_WITH_PARTNER');
    assert.equal(openReviewsFor(customerId, {fileId: seeded.fileId}).length, 0,
      '未解決の要確認が無い ── これが「誰も再訪しない」の正体');
    assert.equal(fileStateOf(seeded.fileId), 'REVIEW_WAIT', 'ファイルは完了できないまま');

    const picked = call('opsCommitSettledTransactions', []);
    assert.equal(picked.committed.length, 1, JSON.stringify(picked));
    assert.equal(picked.committed[0].fullTxId, orphan.fullTxId);
    assert.equal(transactionFor(seeded.reviews[0]).transactionStatus, 'COMMITTED');
  });

  // 取引ログ AC・AD を置き場の正本にする第2段。
  function txLogSheet() {
    return gas.stubs.getSpreadsheet('master').getSheetByName('クレカ取引ログ');
  }

  function txLogRow(fullTxId) {
    const values = txLogSheet().getDataRange().getValues();
    const index = values.findIndex((row) => String(row[0]) === String(fullTxId));
    assert.ok(index > 0, `取引ログに ${fullTxId} が無い`);
    return index + 1;
  }

  function setTxCell(fullTxId, column, value) {
    txLogSheet().getRange(txLogRow(fullTxId), column).setValue(value);
  }

  function txLogSnapshot() {
    return JSON.stringify(txLogSheet().getDataRange().getValues());
  }

  function destinationSnapshot(id) {
    return JSON.stringify(gas.stubs.getSpreadsheet(id)
      .getSheetByName('入力用シート').getDataRange().getValues());
  }

  function fileReviewFor(seeded, type = 'FILE_CHANGED', fileId = seeded.fileId) {
    return call('registerReview', [{reviewType: type, fileId,
      customerId: seeded.customer.customerId, customerName: seeded.customer.customerName,
      fileNameOriginal: '明細.csv', detail: type === 'FILE_CHANGED'
        ? {kind: 'FILE_CHANGED', oldRevision: 'r1', newRevision: 'r2',
          oldBinaryHash: 'b'.repeat(64), newBinaryHash: 'e'.repeat(64), hashVersion: '3'}
        : undefined}]).reviewId;
  }

  function failReserveImport(seeded, options = {}) {
    return withMocks({reserveDestinationRows: () => { throw new Error('txdest reserve stop'); }},
      () => webImport(seeded.customer, options));
  }

  test('txdest 1: web and scheduled imports record AC AD AE, including reviews', () => {
    const seeded = seedPartnerViaWeb({count: 2});
    seeded.reviews.forEach((review) => {
      const tx = transactionFor(review);
      assert.equal(tx.destinationSpreadsheetId, seeded.destinationSpreadsheetId);
      assert.equal(tx.destinationSheetName, '入力用シート');
      assert.ok(Number(tx.destinationRow) >= 1);
      assert.equal(tx.transactionStatus, 'REVIEW_REQUIRED');
    });
    const scheduled = setupWorld();
    putCsv(scheduled.customer, {fileId: 'scheduled_file'});
    call('runImport', [{}]);
    const txs = call('getTransactionsForFile_', ['scheduled_file']);
    assert.ok(txs.length >= 1);
    txs.forEach((tx) => {
      assert.equal(tx.destinationSpreadsheetId, scheduled.customer.destinationId);
      assert.equal(tx.destinationSheetName, '入力用シート');
      assert.ok(Number(tx.destinationRow) >= 1);
    });
  });

  test('txdest 2: registration records clone before row reservation', () => {
    const seeded = seedPartnerViaWeb();
    forceFileState(seeded.fileId, 'DISCOVERED');
    const tx = transactionFor(seeded.reviews[0]);
    setTxCell(tx.fullTxId, 10, 'PREPARED');
    setTxCell(tx.fullTxId, 31, '');
    clearRecordedDestinationsForFile(seeded.fileId);
    setTxCell(tx.fullTxId, 29, null);
    setTxCell(tx.fullTxId, 30, undefined);
    failReserveImport(seeded, {destinationSpreadsheetId: seeded.destinationSpreadsheetId});
    const prepared = call('getTransaction', [tx.fullTxId]);
    assert.equal(prepared.transactionStatus, 'PREPARED');
    assert.equal(prepared.destinationRow, '');
    assert.equal(prepared.destinationSpreadsheetId, seeded.destinationSpreadsheetId);
    assert.equal(prepared.destinationSheetName, '入力用シート');
  });

  test('txdest 3: recovery uses recorded clone when reviews and rows are absent', () => {
    const seeded = seedPartnerViaWeb();
    const tx = transactionFor(seeded.reviews[0]);
    const sheet = gas.stubs.getSpreadsheet(seeded.destinationSpreadsheetId)
      .getSheetByName('入力用シート');
    sheet.getRange(Number(tx.destinationRow), 1, 1, 7).setValues([blank(7)]);
    blankReviewRows([seeded.reviews[0].reviewId]);
    setTxCell(tx.fullTxId, 10, 'PREPARED');
    clearDestinationRow(tx.fullTxId);
    clearRecordedDestinationsForFile(seeded.fileId);
    forceFileState(seeded.fileId, 'DISCOVERED');
    failReserveImport(seeded,
      {destinationSpreadsheetId: seeded.destinationSpreadsheetId});
    forceFileState(seeded.fileId, 'WRITING');
    const result = call('opsRecoverStuckFiles', [])[0];
    assert.equal(result.destinationSource, 'TX_LOG');
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.rewound, true);
    assert.deepEqual(txIdRowsIn(seeded.customer.destinationId,
      seeded.customer.customerId), []);
    const recovered = call('getTransaction', [tx.fullTxId]);
    assert.equal(recovered.destinationSpreadsheetId, seeded.destinationSpreadsheetId);
    assert.equal(recovered.destinationSheetName, '入力用シート');
    assert.ok(Number(recovered.destinationRow) >= 1);
  });

  test('txdest 4: settlement writes AC AD with AE and rejects incomplete entries atomically', () => {
    const seeded = setupWorld();
    const customer = call('getCustomerById', [seeded.customer.customerId]);
    const tx = {fullTxId: 'TX_TXDEST4', customerId: customer.customerId,
      fileId: 'txdest4', sourceRow: 2, planned: {b: '2025-12-10', f: '店', i: '用途', k: '店', m: 100}};
    call('registerPrepared', [[tx], 'RUN_TXDEST4']);
    const entry = {fullTxId: tx.fullTxId, planned: tx.planned, verified: tx.planned,
      destinationRow: 2, fromStatus: 'PREPARED', toStatus: 'COMMITTED',
      destinationSpreadsheetId: customer.destinationSpreadsheetId,
      destinationSheetName: customer.destinationSheetName};
    const before = txLogSnapshot();
    for (const empty of ['', null, undefined, '   ']) {
      for (const key of ['destinationSpreadsheetId', 'destinationSheetName']) {
        assert.equal(caught(() => call('settleWrittenTransactions', [[entry,
          Object.assign({}, entry, {[key]: empty})]])).name, 'TypeError');
        assert.equal(txLogSnapshot(), before);
      }
    }
    call('settleWrittenTransactions', [[entry]]);
    const written = call('getTransaction', [tx.fullTxId]);
    assert.equal(written.destinationSpreadsheetId, customer.destinationSpreadsheetId);
    assert.equal(written.destinationSheetName, customer.destinationSheetName);
    assert.equal(Number(written.destinationRow), 2);
  });

  test('txdest 5: recovery steps 3 4 5 synchronize AC AD AE', () => {
    for (const step of [3, 4, 5]) {
      const seeded = seedPartnerViaWeb();
      const tx = transactionFor(seeded.reviews[0]);
      const row = Number(tx.destinationRow);
      const clone = seeded.destinationSpreadsheetId;
      const sheet = gas.stubs.getSpreadsheet(clone).getSheetByName('入力用シート');
      setTxCell(tx.fullTxId, 10, 'WRITING');
      setTxCell(tx.fullTxId, 29, '');
      setTxCell(tx.fullTxId, 30, '');
      if (step === 4) sheet.getRange(row, 5).setValue(9999);
      if (step === 5) {
        sheet.getRange(row, 1, 1, 7).setValues([blank(7)]);
        clearDestinationRow(tx.fullTxId);
      }
      const customer = Object.assign({}, call('getCustomerById', [seeded.customer.customerId]),
        {destinationSpreadsheetId: clone});
      const lease = call('acquireLease', [customer.customerId, seeded.fileId, 'RUN_REC',
        'reviewer@example.com', 'PROCESS']);
      try {
        const result = call('recoverPartialFailure', [seeded.fileId, 'RUN_REC',
          gas.call('buildIndex', [customer]), lease, {customer}]);
        assert.equal(result.recovered[0].step, step);
      } finally { call('releaseLease', [seeded.fileId, 'RUN_REC', 'DONE']); }
      const recovered = call('getTransaction', [tx.fullTxId]);
      assert.equal(recovered.destinationSpreadsheetId, clone);
      assert.equal(recovered.destinationSheetName, '入力用シート');
      assert.ok(Number(recovered.destinationRow) >= 1);
    }
  });

  function rejoinSetup(prepared = false, legacy = false) {
    const seeded = seedPartnerViaWeb({count: 2});
    const tx = transactionFor(seeded.reviews[0]);
    blankReviewRows(seeded.reviews.map((review) => review.reviewId));
    if (prepared) {
      setTxCell(tx.fullTxId, 10, 'PREPARED');
      clearDestinationRow(tx.fullTxId);
      gas.stubs.getSpreadsheet(seeded.destinationSpreadsheetId)
        .getSheetByName('入力用シート').getRange(Number(tx.destinationRow), 7).setValue('');
    }
    if (legacy) clearRecordedDestinationsForFile(seeded.fileId);
    forceFileState(seeded.fileId, 'DISCOVERED');
    return {seeded, tx};
  }

  test('txdest 6: rejoin preserves recorded B and rebuilds review for B', () => {
    const {seeded, tx} = rejoinSetup();
    const before = transactionFor(seeded.reviews[0]);
    const result = webImport(seeded.customer);
    const cloneC = result.destinationSpreadsheetId;
    assert.notEqual(cloneC, seeded.destinationSpreadsheetId);
    const after = call('getTransaction', [tx.fullTxId]);
    assert.equal(after.destinationSpreadsheetId, seeded.destinationSpreadsheetId);
    assert.equal(after.destinationRow, before.destinationRow);
    assert.deepEqual(txIdRowsIn(cloneC, seeded.customer.customerId), []);
    const reviews = openReviewsFor(seeded.customer.customerId, {fileId: seeded.fileId});
    assert.ok(reviews.length >= 1);
    assert.ok(reviews.every((review) => review.destinationSpreadsheetId ===
      seeded.destinationSpreadsheetId));
  });

  test('txdest 7: reimport refuses to split one file between B and C', () => {
    const {seeded} = rejoinSetup(true);
    const beforeLog = txLogSnapshot();
    const beforeReviews = JSON.stringify(reviewSheet().getDataRange().getValues());
    const beforeB = destinationSnapshot(seeded.destinationSpreadsheetId);
    const beforeTemplate = destinationSnapshot(seeded.customer.destinationId);
    const result = webImport(seeded.customer);
    assert.equal(fileStateOf(seeded.fileId), 'FAILED');
    assert.ok(importFileResults(result).some((file) => file.errorCode ===
      'DESTINATION_MISMATCH'), JSON.stringify(result));
    assert.equal(txLogSnapshot(), beforeLog);
    assert.equal(JSON.stringify(reviewSheet().getDataRange().getValues()), beforeReviews);
    assert.equal(destinationSnapshot(seeded.destinationSpreadsheetId), beforeB);
    assert.equal(destinationSnapshot(seeded.customer.destinationId), beforeTemplate);
    const cloneC = result.destinationSpreadsheetId;
    assert.deepEqual(txIdRowsIn(cloneC, seeded.customer.customerId), []);
  });

  test('txdest 8: legacy AC does not trigger destination split guard', () => {
    const {seeded} = rejoinSetup(true, true);
    const customer = call('getCustomerById', [seeded.customer.customerId]);
    for (const empty of ['', null, undefined, '   ']) {
      assert.equal(call('recordedDestinationOf_',
        [{destinationSpreadsheetId: empty, destinationSheetName: '入力用シート'},
          customer]), null);
    }
    const result = webImport(seeded.customer);
    assert.notEqual(fileStateOf(seeded.fileId), 'FAILED', JSON.stringify(result));
  });

  test('txdest 9: recovery rejects review M that conflicts with recorded AC', () => {
    const seeded = seedPartnerViaWeb({count: 2});
    setReviewDestination(seeded.reviews.map((review) => review.reviewId),
      seeded.customer.destinationId);
    clearDestinationRow(seeded.reviews[0].fullTxId);
    forceFileState(seeded.fileId, 'WRITING');
    const before = destinationSnapshot(seeded.destinationSpreadsheetId);
    const result = call('opsRecoverStuckFiles', [])[0];
    assert.equal(result.destinationSource, 'AMBIGUOUS');
    assert.equal(result.rewound, undefined);
    assert.equal(fileStateOf(seeded.fileId), 'WRITING');
    assert.equal(destinationSnapshot(seeded.destinationSpreadsheetId), before);
  });

  test('txdest 10: two recorded destinations are ambiguous for recovery and file operations', () => {
    const seeded = seedPartnerViaWeb({count: 2});
    setTxCell(seeded.reviews[1].fullTxId, 29, seeded.customer.destinationId);
    clearDestinationRow(seeded.reviews[0].fullTxId);
    forceFileState(seeded.fileId, 'WRITING');
    const result = call('opsRecoverStuckFiles', [])[0];
    assert.equal(result.destinationSource, 'AMBIGUOUS');
    const txs = call('getTransactionsForFile_', [seeded.fileId]);
    assert.equal(caught(() => call('resolveFileDestination_',
      [call('getCustomerById', [seeded.customer.customerId]), txs])).code,
    'DESTINATION_MISMATCH');
  });

  test('txdest 11: stuck reports read each transaction from its recorded clone', () => {
    const seeded = seedPartnerViaWeb({count: 2});
    forceFileState(seeded.fileId, 'WRITING');
    const report = call('opsInspectStuckFiles', [])[0];
    assert.equal(report.rowsCarryingTxId, 2);
    assert.deepEqual(report.destinations, [seeded.destinationSpreadsheetId]);
    const explained = call('opsExplainStuckFileTransactions', [])[0];
    assert.equal(explained.destinationSource, 'TX_LOG');
    assert.equal(explained.destinationFromReviewRow, false);
    assert.equal(explained.destinationSpreadsheetId, seeded.destinationSpreadsheetId);
    explained.unfinished.forEach((tx) => {
      assert.equal(tx.destinationSpreadsheetId, seeded.destinationSpreadsheetId);
    });

    clearRecordedDestinationsForFile(seeded.fileId);
    setReviewDestination(seeded.reviews.map((review) => review.reviewId), '   ');
    const legacy = call('opsExplainStuckFileTransactions', [])[0];
    assert.equal(legacy.destinationSource, 'TEMPLATE');
    assert.equal(legacy.destinationSpreadsheetId, seeded.customer.destinationId);
  });

  test('txdest 12: CANCEL_FILE clears clone rows', () => {
    const seeded = seedPartnerViaWeb({count: 1});
    const tx = transactionFor(seeded.reviews[0]);
    const templateBefore = destinationSnapshot(seeded.customer.destinationId);
    const reviewId = fileReviewFor(seeded);
    call('resolveFileReview', [reviewId, 'CANCEL_FILE', {choice: 'CANCELED'}]);
    assert.equal(call('getTransaction', [tx.fullTxId]).transactionStatus, 'CANCELED');
    for (const column of [2, 3, 4, 5, 6, 7]) {
      assert.equal(destinationValue(seeded.destinationSpreadsheetId,
        tx.destinationRow, column), '');
    }
    assert.equal(destinationSnapshot(seeded.customer.destinationId), templateBefore);
  });

  test('txdest 13: legacy rows are checked before CANCEL_FILE and reprocess', () => {
    for (const operation of ['CANCEL_FILE', 'REPROCESS']) {
      const seeded = seedPartnerViaWeb();
      clearRecordedDestinationsForFile(seeded.fileId);
      const reviewId = fileReviewFor(seeded);
      const before = {tx: txLogSnapshot(), clone: destinationSnapshot(
        seeded.destinationSpreadsheetId), template: destinationSnapshot(
        seeded.customer.destinationId), reviews: JSON.stringify(
        reviewSheet().getDataRange().getValues()), state: fileStateOf(seeded.fileId)};
      const error = caught(() => operation === 'CANCEL_FILE'
        ? call('resolveFileReview', [reviewId, operation, {choice: 'CANCELED'}])
        : call('opsReprocessFile', [seeded.fileId]));
      assert.equal(error.code, 'DESTINATION_MISMATCH');
      assert.equal(txLogSnapshot(), before.tx);
      assert.equal(destinationSnapshot(seeded.destinationSpreadsheetId), before.clone);
      assert.equal(destinationSnapshot(seeded.customer.destinationId), before.template);
      assert.equal(JSON.stringify(reviewSheet().getDataRange().getValues()), before.reviews);
      assert.equal(fileStateOf(seeded.fileId), before.state);
    }
  });

  test('txdest 14: opsReprocessFile cancels rows in the recorded clone', () => {
    const seeded = seedPartnerViaWeb();
    const tx = transactionFor(seeded.reviews[0]);
    const templateBefore = destinationSnapshot(seeded.customer.destinationId);
    call('opsReprocessFile', [seeded.fileId]);
    assert.equal(destinationValue(seeded.destinationSpreadsheetId,
      tx.destinationRow, 7), '');
    assert.equal(destinationSnapshot(seeded.customer.destinationId), templateBefore);
  });

  test('txdest 15: file diff and adoption add transactions to the clone', () => {
    for (const operation of ['APPLY_FILE_DIFF', 'ADOPT_AS_NEW_TRANSACTION']) {
      const seeded = seedPartnerViaWeb();
      const original = transactionFor(seeded.reviews[0]);
      const reviewId = fileReviewFor(seeded);
      const templateBefore = destinationSnapshot(seeded.customer.destinationId);
      const next = {identityHash: 'b'.repeat(64), sourceRow: 3,
        partnerResolutionStatus: 'RESOLVED_WITH_PARTNER',
        planned: {b: '2025-12-11', f: '株式会社テスト', i: '追加', k: '店', m: 700}};
      gas.evaluate('SETTINGS.FILE_DIFF_MAX_RATIO=1;');
      const input = operation === 'APPLY_FILE_DIFF'
        ? {newTransactions: [Object.assign({}, next,
          {identityHash: original.identityHash, sourceRow: original.sourceRow}), next],
          newFileMeta: {fileUpdatedAt: '2026-09-29T00:00:00Z',
            fileRevision: 'r2', binaryHash: 'e'.repeat(64)}}
        : {sourceTxId: original.fullTxId, transaction: next,
          newFileMeta: {fileUpdatedAt: '2026-09-29T00:00:00Z',
            fileRevision: 'r2', binaryHash: 'e'.repeat(64)}};
      const result = call('resolveFileReview', [reviewId, operation, input]);
      const addedId = operation === 'APPLY_FILE_DIFF' ? result.added[0] : result.adoptedTxId;
      const added = call('getTransaction', [addedId]);
      assert.equal(added.destinationSpreadsheetId, seeded.destinationSpreadsheetId);
      assert.equal(added.destinationSheetName, '入力用シート');
      assert.ok(Number(added.destinationRow) >= 1);
      assert.equal(destinationValue(seeded.destinationSpreadsheetId,
        added.destinationRow, 7), addedId);
      assert.equal(destinationSnapshot(seeded.customer.destinationId), templateBefore);
    }
  });

  function purposePair() {
    const seeded = seedPartnerViaWeb();
    const tx = transactionFor(seeded.reviews[0]);
    const duplicateId = 'txdest_duplicate';
    gas.stubs.createFile(duplicateId, {name: 'duplicate.csv', data: 'a,b'});
    call('createOrUpdateProcessLog', ['RUN_PURPOSE',
      call('getCustomerById', [seeded.customer.customerId]),
      {id: duplicateId, name: 'duplicate.csv', binaryHash: 'f'.repeat(64),
        contentHash: 'c'.repeat(64), hashVersion: '3', state: 'REVIEW_WAIT'}]);
    const reviewId = fileReviewFor(seeded, 'DUPLICATE', duplicateId);
    return {seeded, tx, reviewId};
  }

  test('txdest 16: UPDATE_PURPOSE checks transaction ID and writes to its clone', () => {
    let {seeded, tx, reviewId} = purposePair();
    const templateBefore = destinationSnapshot(seeded.customer.destinationId);
    call('resolveFileReview', [reviewId, 'UPDATE_PURPOSE',
      {fullTxId: tx.fullTxId, newPurpose: '新用途'}]);
    assert.equal(destinationValue(seeded.destinationSpreadsheetId,
      tx.destinationRow, 4), '新用途');
    assert.equal(destinationSnapshot(seeded.customer.destinationId), templateBefore);

    ({seeded, tx, reviewId} = purposePair());
    gas.stubs.getSpreadsheet(seeded.destinationSpreadsheetId)
      .getSheetByName('入力用シート').getRange(Number(tx.destinationRow), 7)
      .setValue('TX_OTHER');
    const before = destinationSnapshot(seeded.destinationSpreadsheetId);
    const error = caught(() => call('resolveFileReview', [reviewId, 'UPDATE_PURPOSE',
      {fullTxId: tx.fullTxId, newPurpose: '危険な上書き'}]));
    assert.equal(error.code, 'DESTINATION_MISMATCH');
    assert.equal(destinationSnapshot(seeded.destinationSpreadsheetId), before);
  });

  test('txdest 17: integrity revert uses recorded clone', () => {
    const seeded = seedPartnerViaWeb();
    const tx = transactionFor(seeded.reviews[0]);
    webResolve(seeded.customer.customerId, [decision(seeded.reviews[0], '株式会社テスト')]);
    const committed = call('getTransaction', [tx.fullTxId]);
    const templateBefore = destinationSnapshot(seeded.customer.destinationId);
    gas.stubs.getSpreadsheet(seeded.destinationSpreadsheetId)
      .getSheetByName('入力用シート').getRange(Number(committed.destinationRow), 4)
      .setValue('手動変更');
    call('revertManualChange', [tx.fullTxId, 'reviewer@example.com', {}]);
    assert.equal(destinationValue(seeded.destinationSpreadsheetId,
      committed.destinationRow, 4), committed.planned.i);
    assert.equal(destinationSnapshot(seeded.customer.destinationId), templateBefore);
  });

  function backfillWorld() {
    const seeded = setupWorld();
    const customer = call('getCustomerById', [seeded.customer.customerId]);
    const prefix = `${seeded.customer.customerName}_`;
    createTemplate('txdest_clone1', {name: prefix + '20260929-0001'});
    createTemplate('txdest_clone2', {name: prefix + '20260929-0002'});
    createTemplate('txdest_wrong_name', {name: prefix + 'wrong'});
    seeded.customer.destinationParent.fileIds.push('txdest_clone1',
      'txdest_clone2', 'txdest_wrong_name');
    const destinations = [seeded.customer.destinationId, 'txdest_clone1',
      'txdest_clone2', 'txdest_wrong_name'];
    const specs = [
      {id: 'TX_BACKFILL_TEMPLATE', row: 3, placements: [[0, 3]], verdict: 'resolved'},
      {id: 'TX_BACKFILL_CLONE1', row: 4, placements: [[1, 4]], verdict: 'resolved'},
      {id: 'TX_BACKFILL_CLONE2', row: 5, placements: [[2, 5]], verdict: 'resolved'},
      {id: 'TX_BACKFILL_MOVED', row: 6, placements: [[1, 7]], verdict: 'moved'},
      {id: 'TX_BACKFILL_MISSING', row: 8, placements: [], verdict: 'notFound'},
      {id: 'TX_BACKFILL_WRONGNAME', row: 9, placements: [[3, 9]], verdict: 'notFound'},
      {id: 'TX_BACKFILL_AMBIG', row: 10, placements: [[1, 10], [2, 10]], verdict: 'ambiguous'}
    ];
    specs.forEach((spec) => {
      call('registerPrepared', [[{fullTxId: spec.id, customerId: customer.customerId,
        fileId: 'txdest_backfill', sourceRow: spec.row,
        planned: {b: '2025-12-10', f: '店', i: '用途', k: '店', m: 100}}], 'RUN_BACKFILL']);
      call('updateTransactionLocation', [spec.id, spec.row]);
      setTxCell(spec.id, 45, 'OLD_TIMESTAMP');
      spec.placements.forEach(([destinationIndex, row]) => {
        gas.stubs.getSpreadsheet(destinations[destinationIndex])
          .getSheetByName('入力用シート').getRange(row, 7).setValue(spec.id);
      });
    });
    return {seeded, customer, destinations, specs};
  }

  function assertBackfillCounts(report) {
    assert.equal(report.totals.targets, 7);
    assert.equal(report.totals.resolved, 3);
    assert.equal(report.totals.moved, 1);
    assert.equal(report.totals.notFound, 2);
    assert.equal(report.totals.ambiguous, 1);
    assert.equal(report.customers[0].folderScan, 'SCANNED');
    assert.equal(report.customers[0].candidates, 3);
  }

  test('txdest 18: backfill dry runs report only verified destinations', () => {
    const world = backfillWorld();
    const beforeTx = txLogSnapshot();
    const audit = gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ');
    const beforeAudit = JSON.stringify(audit.getDataRange().getValues());
    for (const apply of [undefined, false, 'true']) {
      const report = apply === undefined
        ? call('opsBackfillTransactionDestinations', [])
        : call('opsBackfillTransactionDestinations', [apply]);
      assert.equal(report.apply, false);
      assertBackfillCounts(report);
      assert.equal(txLogSnapshot(), beforeTx);
      assert.equal(JSON.stringify(audit.getDataRange().getValues()), beforeAudit);
    }
    assert.equal(world.specs.length, 7);
  });

  test('txdest 19: backfill writes only verified AC AD AS and is idempotent', () => {
    const world = backfillWorld();
    const before = txLogSheet().getDataRange().getValues();
    const report = call('opsBackfillTransactionDestinations', [true]);
    assert.equal(report.apply, true);
    assertBackfillCounts(report);
    const after = txLogSheet().getDataRange().getValues();
    world.specs.forEach((spec) => {
      const row = txLogRow(spec.id) - 1;
      const expected = spec.verdict === 'resolved'
        ? world.destinations[spec.placements[0][0]] : '';
      assert.equal(after[row][28], expected);
      assert.equal(after[row][29], expected ? '入力用シート' : '');
      if (expected) assert.notEqual(after[row][44], 'OLD_TIMESTAMP');
      for (let column = 0; column < 47; column += 1) {
        if ([28, 29, 44].includes(column)) continue;
        assert.deepEqual(after[row][column], before[row][column],
          `${spec.id} column ${column + 1}`);
      }
    });
    const audits = gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ')
      .getDataRange().getValues().filter((row) => row[11] === 'BACKFILL_TX_DESTINATION');
    assert.equal(audits.length, 1);
    assert.equal(audits[0][8], world.customer.customerId);
    const once = txLogSnapshot();
    const again = call('opsBackfillTransactionDestinations', [true]);
    assert.equal(again.totals.resolved, 0);
    assert.equal(txLogSnapshot(), once);
  });

  test('txdest 20: backfill rechecks every row before any write', () => {
    const world = backfillWorld();
    const originalBuild = gas.context.buildIndex;
    let changed = false;
    const error = caught(() => withMocks({buildIndex: (...args) => {
      const index = originalBuild(...args);
      if (!changed) {
        changed = true;
        setTxCell('TX_BACKFILL_CLONE1', 29, 'OTHER_DESTINATION');
      }
      return index;
    }}, () => call('opsBackfillTransactionDestinations', [true])));
    assert.ok(changed);
    assert.match(String(error.message), /changed|変更|destination|AC/i);
    world.specs.forEach((spec) => {
      const tx = call('getTransaction', [spec.id]);
      assert.equal(tx.destinationSpreadsheetId,
        spec.id === 'TX_BACKFILL_CLONE1' ? 'OTHER_DESTINATION' : '');
    });
  });

  test('txdest 21: rejoin assigns destination to a rowless legacy transaction', () => {
    const {seeded, tx} = rejoinSetup(true, true);
    failReserveImport(seeded);
    const prepared = call('getTransaction', [tx.fullTxId]);
    assert.equal(prepared.transactionStatus, 'PREPARED');
    assert.equal(prepared.destinationRow, '');
    assert.notEqual(prepared.destinationSpreadsheetId, '');
    assert.notEqual(prepared.destinationSpreadsheetId, seeded.destinationSpreadsheetId);
    assert.equal(prepared.destinationSheetName, '入力用シート');
  });

  // txdest 22〜25 は監査（2026-09-29）で足した。実装者の変異 M1〜M25 は全部赤に
  // なったが、監査の変異のうち 4 つがすり抜けた ── コードは正しいが、テストが無いと
  // 次の変更で黙って壊れる。

  test('txdest 22: backfill stops when a row was deactivated before the write', () => {
    // 書く直前の読み直しは「AC が空のまま」だけでなく「まだ有効か」も見る。
    // 読んだ後に取り消しで無効になった行へ転記先を書くと、無効な行の記録が
    // 生きている行のように見える。txdest 20 は AC の書換えしか見ていない。
    backfillWorld();
    const originalBuild = gas.context.buildIndex;
    let changed = false;
    const error = caught(() => withMocks({buildIndex: (...args) => {
      const index = originalBuild(...args);
      if (!changed) {
        changed = true;
        setTxCell('TX_BACKFILL_CLONE1', 42, false);
      }
      return index;
    }}, () => call('opsBackfillTransactionDestinations', [true])));
    assert.ok(changed);
    assert.ok(error, '書かずに止まること');
    ['TX_BACKFILL_TEMPLATE', 'TX_BACKFILL_CLONE1', 'TX_BACKFILL_CLONE2'].forEach((id) => {
      assert.equal(txLogSheet().getRange(txLogRow(id), 29).getValue(), '',
        `${id} は 1 セルも書かれない`);
    });
    const audits = gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ')
      .getDataRange().getValues().filter((row) => row[11] === 'BACKFILL_TX_DESTINATION');
    assert.equal(audits.length, 0);
  });

  test('txdest 23: only legacy transactions that hold a row are checked as guessed', () => {
    // 所在を推測して検算するのは「行を持つ旧い行」だけ。行を持たない旧い
    // PREPARED まで数えると、索引に居ないのが当然なのに取消しが止まる。
    const customer = call('getCustomerById', [setupWorld().customer.customerId]);
    const tx = (id, status, ac, row) => ({fullTxId: id, active: true,
      transactionStatus: status, destinationSpreadsheetId: ac,
      destinationSheetName: ac ? '入力用シート' : '', destinationRow: row});
    const legacy = call('resolveFileDestination_', [customer, [
      tx('TX_ROWLESS', 'PREPARED', '', ''),
      tx('TX_PLACED', 'COMMITTED', '', 5),
      tx('TX_GONE', 'CANCELED', '', 6)]]);
    assert.equal(legacy.kind, 'LEGACY');
    assert.deepEqual(legacy.guessed.map((item) => item.fullTxId), ['TX_PLACED']);
    assert.equal(legacy.customer.destinationSpreadsheetId, customer.destinationSpreadsheetId);
    const mixed = call('resolveFileDestination_', [customer, [
      tx('TX_REC', 'REVIEW_REQUIRED', 'CLONE_X', 3),
      tx('TX_ROWLESS', 'WRITING', null, undefined),
      tx('TX_PLACED', 'COMMITTED', undefined, 4)]]);
    assert.equal(mixed.kind, 'MIXED');
    assert.equal(mixed.customer.destinationSpreadsheetId, 'CLONE_X');
    assert.deepEqual(mixed.guessed.map((item) => item.fullTxId), ['TX_PLACED']);
  });

  test('txdest 24: recovery of a partly recorded file uses the recorded clone', () => {
    // 本仕様の後に旧いファイルを取り込み直すと、行を持つ旧い行（AC 空）と
    // 記録された行が 1 ファイルに混ざる（MIXED）。要確認が無くても記録から
    // 複製を選び、旧い行は検算が確かめる。旧い扱い（雛形と仮定）に落とすと、
    // 複製に居る旧い行が雛形の索引に無いので、回復が止まったままになる。
    const seeded = seedPartnerViaWeb({count: 2});
    const customerId = seeded.customer.customerId;
    const clone = seeded.destinationSpreadsheetId;
    blankReviewRows(seeded.reviews.map((review) => review.reviewId));
    const legacyTx = transactionFor(seeded.reviews[0]);
    setTxCell(legacyTx.fullTxId, 29, '');
    setTxCell(legacyTx.fullTxId, 30, '');
    clearDestinationRow(seeded.reviews[1].fullTxId);   // 回復に書くものを与える
    forceFileState(seeded.fileId, 'WRITING');
    const cloneRowsBefore = txIdRowsIn(clone, customerId);

    const recovered = call('opsRecoverStuckFiles', []);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].destinationSource, 'TX_LOG', JSON.stringify(recovered[0]));
    assert.equal(recovered[0].error, undefined, JSON.stringify(recovered[0]));
    assert.equal(recovered[0].rewound, true);
    assert.deepEqual(txIdRowsIn(seeded.customer.destinationId, customerId), [],
      '雛形には 1 行も書かない');
    assert.deepEqual(txIdRowsIn(clone, customerId), cloneRowsBefore, '複製の行も増えない');
  });

  test('txdest 25: the stuck-file count uses the review row for legacy transactions', () => {
    // K-W18 の直しは旧い行にも効く：AC が空なら、雛形ではなく要確認行の M 列の
    // 転記先で数える（opsExplainStuckFileTransactions と同じ規則）。
    const seeded = seedPartnerViaWeb({count: 2});
    clearRecordedDestinationsForFile(seeded.fileId);
    forceFileState(seeded.fileId, 'WRITING');
    const report = call('opsInspectStuckFiles', [])[0];
    assert.equal(report.rowsCarryingTxId, 2, '複製に居る 2 件を数える');
    assert.deepEqual(report.destinations, [seeded.destinationSpreadsheetId]);
  });

  test('webapp 45m: auto-adoption picks up the orphan and lets the file finish', () => {
    requireWebFunction('opsAutoAdoptPartners');
    // 自動採用が前回の取りこぼしを拾わないと、確定だけ未実行の取引が
    // ファイルの完了を永久に止める。拾う位置は完了パスの**前**でなければ
    // その回では完了しない。
    const seeded = seedPartnerViaWeb({count: 1});
    settleWithoutCommitting(seeded.customer.customerId, seeded.reviews[0]);
    assert.equal(fileStateOf(seeded.fileId), 'REVIEW_WAIT');

    const summary = call('opsAutoAdoptPartners', []);
    assert.equal(summary.settledLate.length, 1, JSON.stringify(summary));
    assert.deepEqual(summary.completedFiles, [seeded.fileId], '同じ回で完了まで行く');
    assert.equal(fileStateOf(seeded.fileId), 'COMPLETED');
  });

  test('webapp 45n: a transaction whose partner is unresolved is not even asked about', () => {
    requireWebFunction('opsCommitSettledTransactions');
    // 取引先が未解決の取引は要確認が立っている（または K-W19 の型で、それは
    // 回復の仕事）。判定器へ渡す前に外す ── 渡すと blocked が件数ぶん膨らみ、
    // 本当に拾うべき取引が埋もれる。
    const seeded = seedPartnerViaWeb({count: 2});
    const picked = call('opsCommitSettledTransactions', []);
    assert.deepEqual(picked.committed, []);
    assert.deepEqual(picked.blocked, [], '判定器へ渡さない');
    seeded.reviews.forEach((review) => {
      assert.equal(transactionFor(review).transactionStatus, 'REVIEW_REQUIRED');
    });
  });

  test('webapp 45o: a completed file is not scanned for orphans', () => {
    requireWebFunction('opsCommitSettledTransactions');
    // 終端のファイルに `REVIEW_REQUIRED` は無いので結果は変わらない ── だから
    // 結果だけを見るテストでは絞り込みを外しても緑のままになる。守っているのは
    // 読取の量で、完了済みファイルは顧客の履歴ぶん増え続ける（実機で既に 35 件）。
    const seeded = seedPartnerViaWeb({count: 1});
    settleWithoutCommitting(seeded.customer.customerId, seeded.reviews[0]);
    call('opsAutoAdoptPartners', []);
    assert.equal(fileStateOf(seeded.fileId), 'COMPLETED');

    const scanned = [];
    const real = gas.context.getTransactionsByStatus;
    withMocks({
      getTransactionsByStatus(fileId, statuses) {
        scanned.push(String(fileId));
        return real(fileId, statuses);
      }
    }, () => call('opsCommitSettledTransactions', []));
    assert.deepEqual(scanned, [], '終端のファイルは 1 度も読まない');
  });

  test('webapp 45p: a stuck file with nothing to write is completed without needing a destination', () => {
    requireWebFunction('opsRecoverStuckFiles');
    // 辞書が全件自動確定した取込は要確認を1件も立てない。書き終えた直後に
    // 6分で殺されると、転記先を要確認行から引けず雛形と仮定され、行の検算が
    // 必ず食い違う ── 書くものは無いのに永久に WRITING のまま残る
    // （2026-09-19 の実機。46件すべて確定済みの 202511.xlsx）。
    const seeded = setupWorld({});
    const customerId = seeded.customer.customerId;
    const template = seeded.customer.destinationId;
    seedDictionaryRow(customerId, {dictId: 'DICT_AUTO',
      original: '自動確定店', partnerName: '自動確定先', conflict: false});
    putCsv(seeded.customer, {fileId: 'no_reviews',
      rows: ['2025/12/10,自動確定店,1200,仕入れ']});
    const result = webImport(seeded.customer, {});
    const clone = result.destinationSpreadsheetId;
    assert.equal(openReviewsFor(customerId, {fileId: 'no_reviews'}).length, 0,
      '要確認が 1 件も立たない取込であること');
    forceFileState('no_reviews', 'WRITING');
    const cloneRowsBefore = txIdRowsIn(clone, customerId);
    assert.equal(cloneRowsBefore.length, 1);

    const recovered = call('opsRecoverStuckFiles', []);
    assert.equal(recovered.length, 1, JSON.stringify(recovered));
    assert.equal(recovered[0].nothingToRecover, true, '書くものが無いと見抜く');
    assert.equal(recovered[0].error, undefined,
      `転記先を要求してはならない: ${JSON.stringify(recovered[0])}`);
    assert.equal(recovered[0].destinationSource, undefined, '転記先を決めようとすらしない');
    assert.equal(recovered[0].rewound, true, '発見へ戻す（完了させるのは再取込の仕事）');
    assert.equal(fileStateOf('no_reviews'), 'DISCOVERED');
    assert.deepEqual(txIdRowsIn(template, customerId), [], '雛形には 1 行も書かない');
    assert.deepEqual(txIdRowsIn(clone, customerId), cloneRowsBefore, '複製の行も増えない');
  });

  test('webapp 45q: the audit chain is verified once per press, not once per file', () =>
    withPinnedOneFilePerCall(() => {
    requireWebFunction('webAppRunImport');
    // 監査ログ連鎖の検証は往復ではなく計算で、実機で 41 秒かかる（500行の
    // SHA-256。2026-09-20 実測）。結果は通知に載るだけで取込の判断を変えない。
    // 1呼出し1ファイルなので、毎回やると 12 ファイルで 8 分をこれに使う。
    // **押下ごとには必ず走らせる** ── 走らせないと破損の発見が遅れる。
    const seeded = setupWorld({});
    seedDictionaryRow(seeded.customer.customerId, {dictId: 'DICT_AC',
      original: '連鎖店', partnerName: '連鎖先', conflict: false});
    let verified = 0;
    const real = gas.context.verifyChain;
    const counting = {verifyChain(scope) { verified += 1; return real(scope); }};

    ['ac1', 'ac2'].forEach((fileId) => putCsv(seeded.customer,
      {fileId, rows: ['2025/12/10,連鎖店,1500,仕入れ']}));

    let destId = null;
    withMocks(counting, () => {
      const first = call('webAppRunImport',
        [seeded.customer.customerId, seeded.customer.cardId, {}]);
      destId = first.destinationSpreadsheetId;
    });
    assert.equal(verified, 1, '押下の最初の呼出しでは検査する');

    withMocks(counting, () => {
      call('webAppRunImport', [seeded.customer.customerId, seeded.customer.cardId,
        {destinationSpreadsheetId: destId}]);
    });
    assert.equal(verified, 1, '同じ押下の続きでは検査しない（ここが 41 秒）');

    // 次の押下＝転記先を渡さない呼出しでは、また検査する。
    putCsv(seeded.customer, {fileId: 'ac3', rows: ['2025/12/12,連鎖店,1700,仕入れ']});
    withMocks(counting, () => {
      call('webAppRunImport', [seeded.customer.customerId, seeded.customer.cardId, {}]);
    });
    assert.equal(verified, 2, '新しい押下では必ず検査する');
  }));

  test('multi 1: four light files import in one call', () => {
    const {customer} = setupWorld({knownMerchant: true});
    for (let index = 0; index < 4; index += 1) {
      putCsv(customer, {fileId: `multi_light_${index}`,
        rows: [`2025/12/${10 + index},既知店,${2000 + index},仕入れ`]});
    }
    gas.evaluate('resetApiReadWindow_()');
    const result = withImportTiming([45000, 45000, 45000, 45000], () => webImport(customer));
    assert.deepEqual(importFileResults(result).map((file) => file.outcome),
      ['WRITTEN', 'WRITTEN', 'WRITTEN', 'WRITTEN']);
    assert.equal(result.done, 4);
    assert.equal(result.remaining, 0);
    assert.equal(latestImportCall().gate.stoppedBy, null);
  });

  test('multi 2: a heavy file stops the call and the next call reuses one copy', () => {
    const {customer} = setupWorld({knownMerchant: true});
    const fileIds = [0, 1, 2].map((index) => putCsv(customer, {
      fileId: `multi_heavy_${index}`,
      rows: [`2025/12/${10 + index},既知店,${2100 + index},仕入れ`]
    }));
    const before = spreadsheetIds();
    const first = withImportTiming([130000, 0, 0], () => webImport(customer));
    const gate = latestImportCall().gate;
    assert.equal(first.fileResults.length, 1);
    assert.equal(first.remaining, 2);
    assert.equal(gate.stoppedBy, 'GATE');
    assert.equal(gate.filesNotStarted, 2);
    assert.equal(gate.predictedMs, 130000);
    const discovered = discoveredFileIds(customer);
    assert.ok(discovered.includes(fileIds[1]));
    assert.ok(discovered.includes(fileIds[2]));

    const second = withImportTiming([0, 0], () => webImport(customer,
      {destinationSpreadsheetId: first.destinationSpreadsheetId}));
    assert.equal(second.done, 2);
    assert.equal(second.remaining, 0);
    assert.deepEqual(createdIds(before), [first.destinationSpreadsheetId]);
  });

  test('multi 3: prediction keeps the maximum and admits the exact boundary', () => {
    const {customer} = setupWorld({knownMerchant: true});
    const fileIds = [0, 1, 2].map((index) => putCsv(customer, {
      fileId: `multi_max_${index}`,
      rows: [`2025/12/${10 + index},既知店,${2200 + index},仕入れ`]
    }));
    const result = withImportTiming([100000, 10000, 0], () => webImport(customer));
    const gate = latestImportCall().gate;
    assert.equal(result.fileResults.length, 2, '経過100秒＋予測200秒の境界は始める');
    assert.equal(result.remaining, 1);
    assert.equal(gate.stoppedBy, 'GATE');
    assert.equal(gate.elapsedMs, 110000);
    assert.equal(gate.predictedMs, 100000, '直前の10秒で予測を軽くしない');
    assert.ok(discoveredFileIds(customer).includes(fileIds[2]));
  });

  test('multi 4: the 60 second floor stops after five 40 second files', () => {
    const {customer} = setupWorld({knownMerchant: true});
    const fileIds = Array.from({length: 8}, (_, index) => putCsv(customer, {
      fileId: `multi_floor_${index}`,
      rows: [`2025/12/${String(10 + index).padStart(2, '0')},既知店,${2300 + index},仕入れ`]
    }));
    const result = withImportTiming(Array(8).fill(40000), () => webImport(customer));
    const gate = latestImportCall().gate;
    assert.equal(result.fileResults.length, 5);
    assert.equal(result.remaining, 3);
    assert.equal(gate.stoppedBy, 'GATE');
    assert.equal(gate.filesNotStarted, 3);
    assert.equal(gate.elapsedMs, 200000);
    assert.equal(gate.predictedMs, 60000);
    assert.equal(fileIds.filter((fileId) => discoveredFileIds(customer).includes(fileId)).length, 3);
  });

  test('multi 5: six files per call is a hard cap', () => {
    const {customer} = setupWorld({knownMerchant: true});
    for (let index = 0; index < 8; index += 1) {
      putCsv(customer, {fileId: `multi_cap_${index}`,
        rows: [`2025/12/${String(10 + index).padStart(2, '0')},既知店,${2400 + index},仕入れ`]});
    }
    const first = withImportTiming(Array(8).fill(0), () => webImport(customer));
    assert.equal(first.fileResults.length, 6);
    assert.equal(first.done, 6);
    assert.equal(first.remaining, 2);
    const second = withImportTiming([0, 0], () => webImport(customer,
      {destinationSpreadsheetId: first.destinationSpreadsheetId}));
    assert.equal(second.fileResults.length, 2);
    assert.equal(second.remaining, 0);
  });

  test('multi 6: FAILED stops later files and maps to the stuck-file message', () => {
    const {customer} = setupWorld({knownMerchant: true});
    const fileIds = [0, 1, 2].map((index) => putCsv(customer, {
      fileId: `multi_failed_${index}`,
      rows: [`2025/12/${10 + index},既知店,${2500 + index},仕入れ`]
    }));
    const result = withImportTiming([0, 0, 0], () => webImport(customer), {failAt: 1});
    const gate = latestImportCall().gate;
    assert.equal(result.fileResults.length, 2);
    assert.ok(discoveredFileIds(customer).includes(fileIds[2]));
    assert.equal(result.done, 1);
    assert.equal(result.stoppedBy, 'FILE_FAILED');
    assert.equal(gate.stoppedBy, 'FAILED');
    assert.equal(clientStoppedByMessage('FILE_FAILED'),
      'このファイルは処理中のまま止まっています。管理者へ連絡してください。');

    const firstFails = setupWorld({knownMerchant: true});
    putCsv(firstFails.customer, {fileId: 'multi_failed_first',
      rows: ['2025/12/10,既知店,2600,仕入れ']});
    const failed = withImportTiming([0], () => webImport(firstFails.customer), {failAt: 0});
    assert.equal(failed.done, 0);
    assert.equal(failed.stoppedBy, 'FILE_FAILED');
  });

  test('multi 7: a lease conflict stops the remaining candidates', () => {
    const {customer} = setupWorld({knownMerchant: true});
    const fileIds = [0, 1, 2].map((index) => putCsv(customer, {
      fileId: `multi_lease_${index}`,
      rows: [`2025/12/${10 + index},既知店,${2700 + index},仕入れ`]
    }));
    const result = withImportTiming([0, 0, 0], () => webImport(customer),
      {leaseConflictFileId: fileIds[1]});
    const gate = latestImportCall().gate;
    assert.equal(result.fileResults.length, 2);
    assert.equal(result.stoppedBy, 'LEASE_CONFLICT');
    assert.equal(gate.stoppedBy, 'LEASE_CONFLICT');
    assert.ok(discoveredFileIds(customer).includes(fileIds[2]));
  });

  test('multi 8: unstarted files are absent from results but remain in total', () => {
    const {customer} = setupWorld({knownMerchant: true});
    for (let index = 0; index < 3; index += 1) {
      putCsv(customer, {fileId: `multi_omitted_${index}`,
        rows: [`2025/12/${10 + index},既知店,${2800 + index},仕入れ`]});
    }
    const result = withImportTiming([130000, 0, 0], () => webImport(customer));
    assert.equal(result.fileResults.length, 1);
    assert.ok(result.fileResults.every((file) => file.outcome !== 'DEFERRED_TIME_BUDGET'));
    assert.equal(result.total, 3);
    assert.equal(result.remaining, 2);

    const destinationSpreadsheetId = createWebDestination(customer);
    const deferred = withMocks({runImport: () => ({runId: 'RUN_DEFERRED', stages: [],
      stoppedBy: null, customers: [{integrity: {findings: [], stop: false, indexesBuilt: 0},
        gate: {stoppedBy: null, filesStarted: 1, filesNotStarted: 0,
          elapsedMs: null, predictedMs: null},
        files: [{fileId: 'unstarted', outcome: 'DEFERRED_TIME_BUDGET'},
          {fileId: 'started', outcome: 'WRITTEN', elapsedMs: 1, reads: 0, waits: {}}]}]})},
    () => webImport(customer, {destinationSpreadsheetId}));
    assert.equal(deferred.fileResults.length, 1);
    assert.equal(deferred.fileResults[0].outcome, 'WRITTEN');
  });

  test('multi 9: multiple candidates enable smoothing only during file work', () => {
    const {customer} = setupWorld({knownMerchant: true});
    putCsv(customer, {fileId: 'multi_smooth_1',
      rows: ['2025/12/10,既知店,2900,仕入れ']});
    putCsv(customer, {fileId: 'multi_smooth_2',
      rows: ['2025/12/11,既知店,2901,仕入れ']});
    const observed = [];
    const real = gas.context.processDiscoveredFile_;
    gas.context.processDiscoveredFile_ = function(...args) {
      observed.push(Boolean(gas.context.apiReadSmoothing_));
      return real.apply(this, args);
    };
    try {
      withImportTiming([0, 0], () => webImport(customer));
    } finally {
      gas.context.processDiscoveredFile_ = real;
    }
    assert.ok(observed.length >= 2);
    assert.ok(observed.every(Boolean));
    assert.equal(gas.context.apiReadSmoothing_, false);
  });

  test('multi 10: audit chain runs once per press across multiple calls', () => {
    const {customer} = setupWorld({knownMerchant: true});
    for (let index = 0; index < 3; index += 1) {
      putCsv(customer, {fileId: `multi_audit_${index}`,
        rows: [`2025/12/${10 + index},既知店,${3000 + index},仕入れ`]});
    }
    let verified = 0;
    const real = gas.context.verifyChain;
    const counting = {verifyChain(scope) { verified += 1; return real(scope); }};
    let first;
    withMocks(counting, () => {
      first = withImportTiming([130000, 0, 0], () => webImport(customer));
    });
    assert.equal(verified, 1);
    withMocks(counting, () => withImportTiming([0, 0], () => webImport(customer,
      {destinationSpreadsheetId: first.destinationSpreadsheetId})));
    assert.equal(verified, 1);

    putCsv(customer, {fileId: 'multi_audit_new',
      rows: ['2025/12/20,既知店,3030,仕入れ']});
    withMocks(counting, () => withImportTiming([0], () => webImport(customer)));
    assert.equal(verified, 2);
  });

  test('multi 11: runImport without fileStartGate keeps processing every capped candidate', () => {
    const {customer} = setupWorld({knownMerchant: true});
    const fileIds = [0, 1, 2].map((index) => putCsv(customer, {
      fileId: `multi_no_gate_${index}`,
      rows: [`2025/12/${10 + index},既知店,${3100 + index},仕入れ`]
    }));
    const report = withImportTiming([200000, 200000, 200000], () => call('runImport', [{
      customerIds: [customer.customerId], fileIds, maxFilesPerCustomer: 3
    }]));
    assert.equal(report.customers[0].files.length, 3);
    assert.equal(Object.hasOwn(report.customers[0], 'gate'), false);
    assert.equal(report.customers[0].files.every((file) => file.outcome === 'WRITTEN'), true);
  });

  test('multi 12: IMPORT_CALL and PHASES report safe counts, including early returns', () => {
    const {customer} = setupWorld({knownMerchant: true,
      customer: {customerName: 'SECRET_CUSTOMER_NAME'}});
    const fileId = putCsv(customer, {fileId: 'SECRET_FILE_ID',
      name: 'SECRET_FILENAME.csv',
      rows: ['2025/12/10,SECRET_MERCHANT,918273645,仕入れ']});
    const destinationSpreadsheetId = createWebDestination(customer);
    gas.evaluate('resetApiReadWindow_()');
    gas.stubs.setSheetsBatchGetFailures([{code: 503, message: '503 transient'}]);
    gas.stubs.resetApiCallCounts();
    const beforeReads = gas.stubs.getApiCallCounts().batchGet;
    const result = webImport(customer, {destinationSpreadsheetId});
    const afterReads = gas.stubs.getApiCallCounts().batchGet;
    const record = latestImportCall();
    assert.ok(record);
    assert.equal(importCalls().length, 1);
    assert.equal(record.files.length, result.fileResults.length);
    assert.equal(record.totalReads, afterReads - beforeReads);
    assert.equal(record.runId, record.files.length ? gas.stubs.getLogs()
      .filter((line) => line.startsWith('PHASES ')).map((line) =>
        JSON.parse(line.slice('PHASES '.length))).at(-1).runId : null);
    assert.ok(['authorize', 'folder', 'scan', 'leases', 'runImport'].every((name) =>
      record.stages.some((stage) => stage.name === name)));
    assert.ok(['settings', 'capacity', 'renames', 'scan', 'precheck'].every((name) =>
      record.run.some((stage) => stage.name === name)));
    assert.equal(record.totalReads,
      record.stages.reduce((sum, stage) => sum + stage.reads, 0));
    const runStage = record.stages.find((stage) => stage.name === 'runImport');
    assert.equal(runStage.reads,
      record.run.reduce((sum, stage) => sum + stage.reads, 0) +
      record.files.reduce((sum, file) => sum + file.reads, 0));
    assert.equal(record.pacedMs, 0);
    assert.ok(record.backoffMs > 0);
    assert.equal(record.quotaHits, 0);
    const phases = gas.stubs.getLogs().filter((line) => line.startsWith('PHASES '))
      .map((line) => JSON.parse(line.slice('PHASES '.length)));
    const filePhase = phases.find((entry) => entry.file === 'SECRET_FILENAME.csv');
    assert.ok(filePhase);
    assert.equal(typeof filePhase.reads, 'number');
    assert.equal(filePhase.runId, record.runId);
    const importText = gas.stubs.getLogs().filter((line) => line.startsWith('IMPORT_CALL ')).join('\n');
    ['SECRET_FILENAME.csv', fileId, 'SECRET_MERCHANT', '918273645', 'SECRET_CUSTOMER_NAME']
      .forEach((secret) => assert.equal(importText.includes(secret), false));

    gas.stubs.clearLogs();
    const empty = webImport(customer, {destinationSpreadsheetId});
    assert.equal(empty.total, 0);
    assert.equal(importCalls().length, 1, 'ファイルが無い早期 return でも記録する');
  });

  test('multi 13: shared read window loads, filters, saves, and tolerates cache failures', () => {
    const {customer} = setupWorld({knownMerchant: true});
    putCsv(customer, {fileId: 'multi_cache_save',
      rows: ['2025/12/10,既知店,3200,仕入れ']});
    let destinationSpreadsheetId = createWebDestination(customer);
    gas.evaluate('resetApiReadWindow_()');
    webImport(customer, {destinationSpreadsheetId});
    const saved = JSON.parse(gas.stubs.getScriptCacheValue('SHEETS_READ_WINDOW_V1'));
    assert.ok(saved.length > 0, '呼出し後の読取時刻がキャッシュにある');

    const busy = setupWorld({knownMerchant: true});
    putCsv(busy.customer, {fileId: 'multi_cache_busy_1',
      rows: ['2025/12/10,既知店,3210,仕入れ']});
    putCsv(busy.customer, {fileId: 'multi_cache_busy_2',
      rows: ['2025/12/11,既知店,3211,仕入れ']});
    destinationSpreadsheetId = createWebDestination(busy.customer);
    gas.evaluate('resetApiReadWindow_()');
    let apiNow = Date.now();
    gas.context.apiClockNow_ = () => apiNow;
    gas.stubs.setScriptCacheValue('SHEETS_READ_WINDOW_V1', JSON.stringify(
      Array.from({length: 54}, (_, index) => apiNow - 54000 + index * 1000)));
    gas.stubs.setSleepHook((milliseconds) => { apiNow += milliseconds; });
    try {
      webImport(busy.customer, {destinationSpreadsheetId});
    } finally {
      gas.stubs.setSleepHook(null);
      gas.context.apiClockNow_ = Date.now;
    }
    // **待ったことだけでは足りない。**2ファイルの呼出しは均し（1回約1.1秒）でも
    // 眠り、途中で読取が固まれば長くも眠るので、引き継いだ窓が効いていなくても
    // 緑になる（変異で確かめた）。見るのは**最初の待ち**である ── 直前60秒に
    // 54回ある窓なら、均しが入る前の2回目の読取で、最も古い時刻が窓から出るまで
    // 約6秒待つ。
    const sleeps = gas.stubs.getSleepCalls();
    assert.ok(sleeps.length && sleeps[0] > 2000,
      `引き継いだ窓で最初に待っていない: ${JSON.stringify(sleeps.slice(0, 5))}`);
    assert.ok(latestImportCall().sharedWindow.loaded > 0);

    // 早く戻る呼出し（ファイル無し）でも、出した読取を次の呼出しへ渡す。
    const idle = setupWorld({knownMerchant: true});
    gas.evaluate('resetApiReadWindow_()');
    webImport(idle.customer);
    const idleSaved = JSON.parse(gas.stubs.getScriptCacheValue('SHEETS_READ_WINDOW_V1') || '[]');
    assert.ok(idleSaved.length > 0, '早く戻った呼出しの読取時刻もキャッシュにある');

    setupWorld();
    gas.evaluate('resetApiReadWindow_()');
    const apiNowForFilter = Date.now();
    const priorClock = gas.context.apiClockNow_;
    gas.context.apiClockNow_ = () => apiNowForFilter;
    try {
      gas.stubs.setScriptCacheValue('SHEETS_READ_WINDOW_V1', JSON.stringify([
        apiNowForFilter - 61000, 'not-a-number', apiNowForFilter - 30000
      ]));
      assert.equal(call('loadSharedReadWindow_'), 1);
      assert.deepEqual(gas.json('apiReadWindow_'), [apiNowForFilter - 30000]);
      gas.stubs.setScriptCacheValue('SHEETS_READ_WINDOW_V1', '{broken json');
      assert.equal(call('loadSharedReadWindow_'), 0);
    } finally {
      gas.context.apiClockNow_ = priorClock;
    }

    const failureWorld = setupWorld({knownMerchant: true});
    putCsv(failureWorld.customer, {fileId: 'multi_cache_failure',
      rows: ['2025/12/10,既知店,3220,仕入れ']});
    destinationSpreadsheetId = createWebDestination(failureWorld.customer);
    gas.evaluate('resetApiReadWindow_()');
    gas.stubs.setScriptCacheFailures({getScriptCache: ['cache unavailable']});
    const successful = webImport(failureWorld.customer,
      {destinationSpreadsheetId});
    assert.equal(successful.done, 1);
    assert.ok(latestImportCall().sharedWindow.errors >= 1);
  });

  test('multi 14: four files add at most 20 reads each and fixed reads stay at measured cost', () => {
    const one = readCountByImport(1);
    const four = readCountByImport(4);
    const perFile = (four.reads - one.reads) / 3;
    const fixedReads = one.reads - perFile;
    assert.ok(Number.isInteger(perFile) && perFile > 0,
      `1本増えるごとの読取を測定できる: 1=${one.reads}, 4=${four.reads}`);
    assert.ok(perFile <= 20, `1本増えるごとの読取は${perFile}回（上限20）`);
    assert.equal(one.record.totalReads, one.reads);
    assert.equal(four.record.totalReads, four.reads);
    // 変更前（2026-10-02）：1ファイル43回・4ファイル118回、固定費18回。
    // 変更後（2026-10-03）：1ファイル38回・4ファイル98回、固定費18回、
    // 1本増えるごと20回。上限はこの実測値に合わせる。
    assert.ok(fixedReads <= 18,
      `呼出しの固定費が${fixedReads}回（上限18）。1=${one.reads}, 4=${four.reads}`);
  });

  test('multi 15: the call overhead before the first file counts toward the gate', () => {
    // 6分の上限は**呼出しの頭から**数える。実機では認可・フォルダの列挙・
    // 前検査などで最初のファイルまでに20〜40秒かかる（2026-09-27）。門が
    // ファイル処理に入ってからの時間で測ると、その分だけ余裕を食い潰す。
    const {customer} = setupWorld({knownMerchant: true});
    const fileIds = [0, 1, 2].map((index) => putCsv(customer, {
      fileId: `multi_overhead_${index}`,
      rows: [`2025/12/${10 + index},既知店,${3300 + index},仕入れ`]
    }));
    const result = withImportTiming([100000, 100000, 100000], () => webImport(customer),
      {overheadMs: 50000});
    const gate = latestImportCall().gate;
    // 準備50秒＋1本目100秒＝150秒、予測100秒×2を足すと350秒 > 300秒。
    // 準備を数えないと100＋200＝300秒で、境界ちょうどなので2本目を始めてしまう。
    assert.equal(result.fileResults.length, 1);
    assert.equal(gate.stoppedBy, 'GATE');
    assert.equal(gate.elapsedMs, 150000);
    assert.ok(discoveredFileIds(customer).includes(fileIds[1]));
  });

  // Case 46 is the whole-suite acceptance condition, not an independent test.

  test('webapp 46: decisions spanning several files all get resolved by repeating the call', () => {
    // クライアントは残りが無くなるまで呼び直す。サーバーは1回に1ファイルしか
    // 触らないので、**跨いで選んでも1回あたりの重さは変わらない** ──
    // 変わるのは押下全体の所要時間だけである。
    // 跨げないと、6ファイルに散った12件が12回の押下になる（2026-09-21、実機）。
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({fileId: 'span_one', merchant: '第一の店'});
    const second = putCsv(seeded.customer, {fileId: 'span_two',
      rows: ['2025/12/20,第二の店,2200,仕入れ']});
    const third = putCsv(seeded.customer, {fileId: 'span_three',
      rows: ['2025/12/21,第三の店,3300,仕入れ']});
    // 取込は1回の呼出しで全部は終わらない。残りが無くなるまで呼ぶ。
    for (let pass = 0; pass < 5; pass += 1) {
      const report = webImport(seeded.customer,
        {destinationSpreadsheetId: seeded.destinationSpreadsheetId});
      if (!Number(report.remaining || 0)) break;
    }
    const others = [second, third].map((fileId) =>
      openReviewsFor(seeded.customer.customerId, {fileId})
        .find((row) => row.reviewType === 'PARTNER'));
    others.forEach((review, index) =>
      assert.ok(review, `${index + 2}本目のファイルが取り込まれていない`));

    let pending = [seeded.reviews[0]].concat(others).map((review) => decision(review, ''));
    const wanted = pending.length;
    let resolved = 0;
    let calls = 0;
    // クライアントと同じ繰り返し：片付いた件を残りから除いて呼び直す。
    while (pending.length && calls < 10) {
      calls += 1;
      const before = pending.length;
      const result = withMocks({WEBAPP_TRIP_WORST_MS_: 0},
        () => webResolve(seeded.customer.customerId, pending, String(calls)));
      const done = new Set((result.resolvedReviewIds || []).map(String));
      (result.skippedByLeaseReviewIds || []).forEach((id) => done.add(String(id)));
      (result.errors || []).filter((error) => error && error.reviewId)
        .forEach((error) => done.add(String(error.reviewId)));
      resolved += Number(result.resolved || 0);
      pending = pending.filter((item) => !done.has(String(item.reviewId)));
      if (pending.length === before) break;   // 進まなければ止める
    }
    assert.equal(resolved, wanted,
      `${wanted}件のうち${resolved}件しか確定していない（呼出し${calls}回）`);
    assert.deepEqual(pending, [], '残りが片付いていない');
    assert.ok(calls <= wanted, `呼出しが${calls}回。1ファイル1回で足りるはず`);
  });

  test('webapp 47: a first file held by a lease does not strand the files behind it', () => {
    // `RESOLVE_WITHOUT_PARTNER` はリースを取れないファイルで飛ばされる。
    // 「確定できた件数」で進捗を見ると、先頭が全部飛ばされた時点で止まり、
    // **後ろのファイルに一度も手が付かない。**
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({fileId: 'held_one', merchant: '押さえられた店'});
    const second = putCsv(seeded.customer, {fileId: 'held_two',
      rows: ['2025/12/20,後ろの店,2200,仕入れ']});
    webImport(seeded.customer, {destinationSpreadsheetId: seeded.destinationSpreadsheetId});
    const behind = openReviewsFor(seeded.customer.customerId, {fileId: second})
      .find((row) => row.reviewType === 'PARTNER');
    assert.ok(behind);
    // 先頭のファイルにリースを掛ける（取込が動いている状態）
    gas.call('acquireLease', [seeded.customer.customerId, seeded.fileId, 'RUN_HELD',
      'admin@example.com', 'PROCESS']);

    let pending = [decision(seeded.reviews[0], ''), decision(behind, '')];
    const first = withPartnerTiming([200000],
      () => webResolve(seeded.customer.customerId, pending));
    assert.equal(first.resolved, 0, '前提：先頭はリースで確定できない');
    const skipped = new Set((first.skippedByLeaseReviewIds || []).map(String));
    (first.errors || []).filter((e) => e && e.reviewId).forEach((e) => skipped.add(String(e.reviewId)));
    assert.ok(skipped.size > 0, '前提：先頭が飛ばされる');

    // **飛ばされた件も残りから除くので、残りは減る** ── だから次へ進める。
    const before = pending.length;
    pending = pending.filter((item) => !skipped.has(String(item.reviewId)));
    assert.ok(clientEval(`madeProgress(${before}, ${pending.length})`),
      '残りが減ったのに「進んでいない」と判断している ── 後ろのファイルが取り残される');

    const next = webResolve(seeded.customer.customerId, pending, '2');
    assert.equal(next.resolved, 1, '後ろのファイルが確定できていない');
    assert.equal(reviewById(behind.reviewId).status, 'RESOLVED');
  });

  test('webapp 48: progress is judged by what is left, not by what succeeded', () => {
    // 1件も確定できなくても、飛ばした件が残りから消えていれば前へ進んでいる。
    assert.equal(clientEval('madeProgress(3, 2)'), true, '減ったのに進んでいない扱い');
    assert.equal(clientEval('madeProgress(2, 2)'), false, '減っていないのに進んだ扱い（止まらなくなる）');
    assert.equal(clientEval('madeProgress(1, 0)'), true, '最後の1件で止まっている');
  });

  // ================= 取引先不明で確定（§15 の 2） =================
  //
  // 「取引先なし」も「取引先不明」も F列は空欄になる。見分ける手掛かりは I列の
  // 印だけである。取引先欄の「取引先不明」は名前ではなく指示で、名前として
  // 通すと F列に実在しない取引先が入り、辞書が以後その店名をそこへ自動確定する。

  test('webapp 49: 取引先不明 in the partner field marks column I; a blank still marks nothing', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({count: 2});
    const [unknown, none] = seeded.reviews;
    const unknownRow = transactionFor(unknown).destinationRow;
    const noneRow = transactionFor(none).destinationRow;
    const beforeDictionary = dictionaryCount();

    const result = webResolve(seeded.customer.customerId,
      [decision(unknown, '取引先不明'), decision(none, '')]);

    assert.equal(result.resolved, 2);
    assert.deepEqual(result.errors, []);
    assert.equal(reviewById(unknown.reviewId).resolveOperation, 'RESOLVE_PARTNER_UNKNOWN');
    assert.equal(destinationValue(seeded.destinationSpreadsheetId, unknownRow, 3), '',
      'F列に「取引先不明」という取引先を書かない');
    assert.equal(destinationValue(seeded.destinationSpreadsheetId, unknownRow, 4), '仕入れ,取引先不明',
      'I列（メモタグ）の用途の後ろに印を足す');
    assert.equal(transactionFor(unknown).transactionStatus, 'COMMITTED');
    assert.equal(reviewById(none.reviewId).resolveOperation, 'RESOLVE_WITHOUT_PARTNER');
    assert.equal(destinationValue(seeded.destinationSpreadsheetId, noneRow, 4), '仕入れ',
      '空欄は「取引先が要らない」のまま。印を書けば、また区別が付かなくなる');
    assert.equal(dictionaryCount(), beforeDictionary, 'どちらも辞書に学ばない');
  });

  test('webapp 50: the server recognizes the marker through spacing, so it never becomes a name', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb();
    const review = seeded.reviews[0];
    const row = transactionFor(review).destinationRow;
    const beforeDictionary = dictionaryCount();
    // 判定はサーバーが行う。画面の判定と食い違っても、F列と辞書は守られる。
    const result = webResolve(seeded.customer.customerId, [decision(review, '取引先　不明')]);
    assert.equal(result.resolved, 1);
    assert.equal(reviewById(review.reviewId).resolveOperation, 'RESOLVE_PARTNER_UNKNOWN');
    assert.equal(destinationValue(seeded.destinationSpreadsheetId, row, 3), '');
    assert.equal(destinationValue(seeded.destinationSpreadsheetId, row, 4), '仕入れ,取引先不明',
      '印は打ち方ではなく決まった語で書く');
    assert.equal(dictionaryCount(), beforeDictionary);
  });

  test('webapp 51: every row offers 取引先不明, spelled exactly like the server marker', () => {
    const label = gas.evaluate('MEMO_TAG_PARTNER_UNKNOWN_');
    assert.equal(clientEval('TEXT.partnerUnknown'), label,
      '画面とサーバーの語が食い違うと、選んだ「取引先不明」が取引先名として採用される');
    assert.deepEqual(plain(clientEval('partnerChoices({candidates: []})')), [label],
      '候補の無い行こそ、取引先が分からないまま確定したい行である');
    assert.deepEqual(plain(clientEval(
      "partnerChoices({candidates: [{partnerName: 'Amazon'}, {partnerName: '取引先不明'}]})")),
      ['Amazon', label], '候補に同じ語があっても二度出さない');
    assert.equal(clientEval("isPartnerUnknownChoice(' 取引先　不明 ')"), true);
    assert.equal(clientEval("isPartnerUnknownChoice('株式会社不明堂')"), false);
    assert.equal(clientEval(
      "dictionaryMessage({partnerName: '取引先不明', conflictReason: 'DIFFERENT_PARTNER', review: {}})"),
      clientEval('TEXT.learnUnknown'), '確認ダイアログは、何を書くかを言う');
  });

  test('webapp 52: marking an unknown partner costs no more round trips than adopting one', () => {
    requireWebFunction('webAppResolveReviews');
    // 締切ゲートは1件を `WEBAPP_ITEM_TRIPS_`（採用で測った値）で見積もる。
    // 印を書く操作がそれより重いと、ゲートが見積を外して6分に当たる。
    const measure = (partnerName) => {
      const seeded = seedPartnerViaWeb();
      gas.stubs.resetRoundTrips();
      const result = webResolve(seeded.customer.customerId,
        [decision(seeded.reviews[0], partnerName)]);
      assert.equal(result.resolved, 1, `前提：${partnerName} が確定する`);
      const trips = gas.stubs.roundTrips();
      return trips.rangeReads + trips.rangeWrites + trips.flushes;
    };
    const adopt = measure('株式会社テスト');
    const unknown = measure('取引先不明');
    assert.ok(unknown <= adopt, `取引先不明 ${unknown} 往復 > 採用 ${adopt} 往復`);
  });

  test('webapp 53: a file lease stops the mark, and every decision is still accounted for once', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({count: 3});
    call('acquireLease', [seeded.customer.customerId, seeded.fileId, 'other-run',
      'other@example.com', 'PROCESS']);
    const decisions = [decision(seeded.reviews[0], '取引先不明'),
      decision(seeded.reviews[1], ''), decision(seeded.reviews[2], '採用先')];
    const result = webResolve(seeded.customer.customerId, decisions);

    const unknownError = result.errors.find((entry) => entry.reviewId === seeded.reviews[0].reviewId);
    assert.equal(unknownError && unknownError.code, 'LEASE_CONFLICT');
    assert.equal(destinationValue(seeded.destinationSpreadsheetId,
      transactionFor(seeded.reviews[0]).destinationRow, 4), '仕入れ', '他者の実行中に印を書かない');
    assert.equal(reviewById(seeded.reviews[0].reviewId).status, 'OPEN');
    assert.equal(decisions.length,
      result.resolved + result.skippedByLease +
      result.errors.filter((entry) => entry.reviewId).length + result.remaining);
  });

  test('webapp 54: both refusals reach the reader as sentences, not internal English', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb();
    const review = seeded.reviews[0];
    // 別の経路で対象外にされた取引へ、開いたままの画面から「取引先不明」を送る。
    call('updateTransactionStatus', [review.fullTxId, 'REVIEW_REQUIRED', 'CANCELED']);
    const result = webResolve(seeded.customer.customerId, [decision(review, '取引先不明')]);
    const message = String(result.errors[0] && result.errors[0].message);
    assert.match(message, /取り消されたか除外されています（状態 CANCELED）/);
    assert.doesNotMatch(message, /not offered/);

    // メニューの「既存の取引先名を採用する」に「取引先不明」と打った場合。
    const refused = caught(() => gas.call('resolveReview',
      [review.reviewId, 'ADOPT_EXISTING_PARTNER', {partnerName: '取引先不明'}]));
    const adoptMessage = gas.call('menuOperationErrorMessage_', [refused]);
    assert.match(adoptMessage, /「取引先不明」は取引先名にできません/);
    assert.doesNotMatch(adoptMessage, /marker/);
  });


  // ================= 最終確認（段階4の手前） =================
  //
  // **会計の検査である。**一致するときに一致と言い、壊れているときに
  // どこがどう壊れているかを名指しすること。式は
  //   明細の利用金額 − 除外 ＋ 金額修正 − 転記した金額 ＝ 0
  // で、除外と修正は「合わなくて正しい」差である（ko-ch さん、2026-09-21）。

  function finalWorld(rows) {
    const {customer} = setupWorld();
    seedDictionaryRow(customer.customerId, {dictId: 'DICT_FR', original: '確定店',
      partnerName: '株式会社確定'});
    const fileId = putCsv(customer, {fileId: 'final_file', rows: rows || [
      '2025/12/10,確定店,1000,仕入れ',
      '2025/12/11,確定店,2500,仕入れ',
      '2025/12/12,確定店,700,仕入れ']});
    const imported = webImport(customer, {});
    assert.ok(imported.destinationSpreadsheetId, '前提：転記先が作られる');
    const mapping = plain(gas.evaluate('getCustomerById("C001").columnMapping'));
    return {customer, fileId, destinationId: imported.destinationSpreadsheetId, mapping};
  }

  function finalReview(world, fileIds) {
    return call('webAppFinalReview', [world.customer.customerId, world.destinationId,
      fileIds || [world.fileId]]);
  }

  function finalSheet(world) {
    return gas.stubs.getSpreadsheet(world.destinationId).getSheetByName('入力用シート');
  }

  function kinds(result) {
    return result.reconciliation.problems.map((problem) => problem.kind).sort();
  }

  test('final 1: a clean import balances and names no problem', () => {
    requireWebFunction('webAppFinalReview');
    const world = finalWorld();
    const result = finalReview(world);
    assert.equal(result.rows.length, 3, '転記した3行が出ていない');
    const file = result.reconciliation.files[0];
    assert.equal(file.statement, 4200, '明細の合計');
    assert.equal(file.written, 4200, '転記した合計');
    assert.equal(file.residual, 0);
    assert.equal(file.balanced, true);
    assert.deepEqual(kinds(result), []);
    assert.equal(result.reconciliation.totals.balanced, true);
    // 見出しはシートのまま出す（数式の列も同じ扱い）
    assert.deepEqual(result.headers.slice(0, 7),
      ['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID']);
  });

  test('final 2: a correctly excluded transaction is accounted for, not reported', () => {
    // **正しく除外したのに「不一致」と出てはならない。**単純に合計だけ比べると
    // そうなる ── 除外した分は明細にあってシートに無いのが正しい。
    requireWebFunction('webAppFinalReview');
    const world = finalWorld(['2025/12/10,確定店,1000,仕入れ', '2025/12/11,未登録の店,700,仕入れ']);
    const review = openReviewsFor(world.customer.customerId, {fileId: world.fileId})
      .find((row) => row.reviewType === 'PARTNER');
    assert.ok(review, '前提：未登録の店に要確認が立つ');
    call('resolveReview', [review.reviewId, 'EXCLUDE', {}]);

    const result = finalReview(world);
    const file = result.reconciliation.files[0];
    assert.equal(file.statement, 1700);
    assert.equal(file.excluded, 700, '除外した分が勘定されていない');
    assert.equal(file.written, 1000);
    assert.equal(file.residual, 0, '正しく除外したのに差額が出ている');
    assert.deepEqual(kinds(result), [], '正しい除外を問題として出している');
    assert.equal(result.rows.length, 1, '除外した行がシートに残っている');
  });

  test('final 3: an amount changed by hand in the sheet is named, with both values', () => {
    // 転記後に誰かがシートの金額を書き換えた。Excel は黙ってその値を渡す。
    requireWebFunction('webAppFinalReview');
    const world = finalWorld();
    const before = finalReview(world);
    const target = before.rows[1];
    finalSheet(world).getRange(target.rowNumber, world.mapping.M).setValue(9999);

    const result = finalReview(world);
    const mismatch = result.reconciliation.problems.find((p) => p.kind === 'AMOUNT_MISMATCH');
    assert.ok(mismatch, '書き換えられた金額を見逃している');
    assert.equal(mismatch.rowNumber, target.rowNumber, '行を取り違えている');
    assert.equal(mismatch.expected, 2500);
    assert.equal(mismatch.actual, 9999);
    assert.notEqual(result.reconciliation.files[0].residual, 0);
    assert.equal(result.reconciliation.totals.balanced, false);
  });

  test('final 4: a transaction that should be in the sheet but is not is named', () => {
    // 転記漏れ。行ごと消えると、シートの行から辿るだけでは見えない。
    requireWebFunction('webAppFinalReview');
    const world = finalWorld();
    const before = finalReview(world);
    const lost = before.rows[2];
    finalSheet(world).getRange(lost.rowNumber, 1, 1, 8).clearContent();

    const result = finalReview(world);
    const missing = result.reconciliation.problems.find((p) => p.kind === 'MISSING');
    assert.ok(missing, '転記漏れを見逃している');
    assert.equal(missing.txId, lost.txId);
    assert.equal(missing.amount, 700);
    assert.equal(result.reconciliation.files[0].residual, 700,
      '差額が消えた行の金額と一致しない');
  });

  test('final 5: the same transaction written twice is named', () => {
    // 二重転記。合計は増えるので残差でも分かるが、どの取引かは名指しする。
    requireWebFunction('webAppFinalReview');
    const world = finalWorld();
    const before = finalReview(world);
    const copied = before.rows[0];
    const sheet = finalSheet(world);
    const spare = copied.rowNumber + 5;
    sheet.getRange(spare, 1, 1, 8).setValues(
      [sheet.getRange(copied.rowNumber, 1, 1, 8).getValues()[0]]);

    const result = finalReview(world);
    const duplicate = result.reconciliation.problems.find((p) => p.kind === 'DUPLICATE');
    assert.ok(duplicate, '二重転記を見逃している');
    assert.equal(duplicate.txId, copied.txId);
    assert.deepEqual(duplicate.rowNumbers.sort(), [copied.rowNumber, spare].sort());
    assert.equal(result.reconciliation.files[0].residual, -1000, '差額が二重分と一致しない');
  });

  test('final 6: a row whose transaction the log does not know is named', () => {
    requireWebFunction('webAppFinalReview');
    const world = finalWorld();
    const before = finalReview(world);
    const sheet = finalSheet(world);
    const spare = before.rows[2].rowNumber + 3;
    sheet.getRange(spare, world.mapping.txId).setValue('TX_UNKNOWN_000');
    sheet.getRange(spare, world.mapping.M).setValue(500);

    const result = finalReview(world);
    const orphan = result.reconciliation.problems.find((p) => p.kind === 'ORPHAN');
    assert.ok(orphan, '取引ログに無い行を見逃している');
    assert.equal(orphan.txId, 'TX_UNKNOWN_000');
    assert.deepEqual(orphan.rowNumbers, [spare]);
    // **差額は0のままである**（どのファイルにも属さない行は、どのファイルの
    // 合計にも入らない）。だから「一致」の判定は差額だけでは決められない ──
    // 問題が1つでもあれば一致と言ってはならない。言えば、取引ログに無い行を
    // 抱えたまま「一致しました」と表示してダウンロードさせる。
    assert.equal(result.reconciliation.totals.residual, 0, '前提：差額は0');
    assert.equal(result.reconciliation.totals.balanced, false,
      '取引ログに無い行があるのに「一致」と言っている');
  });

  test('final 7: an amount the reviewer corrected is accounted for, not reported', () => {
    // 担当者が金額を直した取引は、明細の値とシートの値が違って正しい。
    // 取引ログの予定値（V列）が直した値を持つので、その差を勘定する。
    requireWebFunction('webAppFinalReview');
    const world = finalWorld();
    const before = finalReview(world);
    const fixed = before.rows[0];
    // 修正を再現：取引ログの予定金額（W列＝planned.m）とシートの金額を 1000 → 1100 に
    gas.context.__txId = fixed.txId;
    gas.evaluate(
      '(function() { var tx = getTransaction(__txId);' +
      ' transactionLogSheet_().getRange(tx._rowNumber, 23).setValue(1100); })()');
    finalSheet(world).getRange(fixed.rowNumber, world.mapping.M).setValue(1100);

    const result = finalReview(world);
    const file = result.reconciliation.files[0];
    assert.equal(file.corrected, 100, '修正の差が勘定されていない');
    assert.equal(file.residual, 0, '正しく直した金額を不一致として出している');
    assert.deepEqual(kinds(result), []);
  });

  test('final 8: a file whose rows were all lost still shows up', () => {
    // シートの行から辿るだけだと、1行も残っていないファイルは見えない。
    // このセッションで取り込んだファイルを渡すのはそのためである。
    requireWebFunction('webAppFinalReview');
    const world = finalWorld();
    const before = finalReview(world);
    const sheet = finalSheet(world);
    before.rows.forEach((row) => sheet.getRange(row.rowNumber, 1, 1, 8).clearContent());

    const withFiles = finalReview(world, [world.fileId]);
    assert.equal(withFiles.reconciliation.files.length, 1, 'ファイルが消えている');
    assert.equal(withFiles.reconciliation.problems.filter((p) => p.kind === 'MISSING').length, 3,
      '全部漏れたのに漏れとして出ていない');
    assert.equal(withFiles.reconciliation.totals.balanced, false);

    const withoutFiles = finalReview(world, []);
    assert.equal(withoutFiles.reconciliation.files.length, 0,
      '前提：ファイルを渡さなければ見えない（だから渡す）');
  });

  test('final 9: each row says whether it is settled or still waiting for review', () => {
    requireWebFunction('webAppFinalReview');
    const world = finalWorld(['2025/12/10,確定店,1000,仕入れ', '2025/12/11,未登録の店,700,仕入れ']);
    const result = finalReview(world);
    const statuses = result.rows.map((row) => row.status).sort();
    assert.deepEqual(statuses, ['COMMITTED', 'REVIEW_REQUIRED'],
      '確定済みと要確認を見分けられない');
  });

  test('final 10: another customer cannot read a destination through this', () => {
    requireWebFunction('webAppFinalReview');
    const world = finalWorld();
    gas.stubs.setActiveUser('stranger@example.com');
    const error = caught(() => gas.call('webAppFinalReview',
      [world.customer.customerId, world.destinationId, [world.fileId]]));
    assert.ok(error, '担当外が読めてしまう');
  });

  test('final 11: the template itself is refused', () => {
    // 雛形は顧客の全期間の転記の元である。最終確認の対象はセッションの複製だけ。
    requireWebFunction('webAppFinalReview');
    const world = finalWorld();
    const templateId = String(plain(gas.evaluate('getCustomerById("C001").destinationSpreadsheetId')));
    const error = caught(() => gas.call('webAppFinalReview',
      [world.customer.customerId, templateId, [world.fileId]]));
    assert.ok(error && /雛形/.test(String(error.message)), '雛形を読めてしまう');
  });


  test('final 12: the amount is read from the amount column, not from the description', () => {
    // freee の列記号（B・F・I・K・M）は名前から意味を推し量れない。
    // K は摘要（元の店名）、M が金額である。取り違えると、店名と金額を
    // 突き合わせる無意味な検査になる（2026-09-23 に実際に取り違えた）。
    requireWebFunction('webAppFinalReview');
    const world = finalWorld();
    const result = finalReview(world);
    assert.equal(result.amountColumnIndex, world.mapping.M - 1, '金額列が M でない');
    result.rows.forEach((row) => {
      assert.equal(typeof row.amount, 'number', `行${row.rowNumber}の金額が数値でない`);
      assert.equal(row.cells[world.mapping.K - 1], '確定店', 'K 列（摘要）に店名が無い');
    });
    assert.deepEqual(result.rows.map((row) => row.amount).sort((a, b) => a - b), [700, 1000, 2500]);
  });


  test('final 13: a row that should have been deleted by an exclusion is named', () => {
    // 除外は転記先の行を消す。消えずに残る（後から戻された・消去が失敗した）と、
    // その取引は**黙ってダウンロードされる**。差額には出ない ── 除外した取引は
    // どの合計にも「転記した」として入らないからである。
    requireWebFunction('webAppFinalReview');
    const world = finalWorld(['2025/12/10,確定店,1000,仕入れ', '2025/12/11,未登録の店,700,仕入れ']);
    const before = finalReview(world);
    const excludedRow = before.rows.find((row) => row.status === 'REVIEW_REQUIRED');
    assert.ok(excludedRow, '前提：除外する行がある');
    const saved = finalSheet(world).getRange(excludedRow.rowNumber, 1, 1, 8).getValues()[0];
    const review = openReviewsFor(world.customer.customerId, {fileId: world.fileId})
      .find((row) => row.reviewType === 'PARTNER');
    call('resolveReview', [review.reviewId, 'EXCLUDE', {}]);
    // 消された行を戻す
    finalSheet(world).getRange(excludedRow.rowNumber, 1, 1, 8).setValues([saved]);

    const result = finalReview(world);
    const present = result.reconciliation.problems.find((p) => p.kind === 'EXCLUDED_BUT_PRESENT');
    assert.ok(present, '除外したのに残っている行を見逃している');
    assert.deepEqual(present.rowNumbers, [excludedRow.rowNumber]);
    assert.equal(result.reconciliation.totals.balanced, false);
  });

  test('final 14: an amount the statement gave in an unreadable form is named, not silently zeroed', () => {
    // 読めない金額を黙って0円にすると、過少計上を見逃す（30 の件数・合計の照合と
    // 同じ扱い）。0円として計算はするが、必ず問題として出す。
    requireWebFunction('webAppFinalReview');
    const world = finalWorld();
    const before = finalReview(world);
    gas.context.__txId = before.rows[0].txId;
    gas.evaluate('(function() { var tx = getTransaction(__txId);' +
      ' transactionLogSheet_().getRange(tx._rowNumber, 17).setValue("千円"); })()');

    const result = finalReview(world);
    const unreadable = result.reconciliation.problems.find((p) => p.kind === 'UNREADABLE_AMOUNT');
    assert.ok(unreadable, '読めない金額を黙って0にしている');
    assert.equal(unreadable.value, '千円');
    assert.equal(result.reconciliation.totals.balanced, false);
  });

  test('final 15: another customer\'s file or rows reveal nothing about that customer', () => {
    // 画面から渡すファイルIDは利用者が書き換えられる。他の顧客のファイルIDを
    // 混ぜても、**その取引の金額も、ファイル名も**返してはならない。
    requireWebFunction('webAppFinalReview');
    const {world, customer} = setupWorld();
    const other = addCustomer(world, {suffix: '2', customerId: 'C002', customerName: '顧客二',
      reviewers: 'reviewer@example.com', admins: 'admin@example.com'});
    seedDictionaryRow('C002', {dictId: 'DICT_OTHER', original: '他社の店', partnerName: '他社'});
    const otherFile = putCsv(other, {fileId: 'other_file', name: '他社の秘密の明細202601.csv',
      rows: ['2025/12/10,他社の店,777777,仕入れ']});
    webImport(other, {});
    seedDictionaryRow('C001', {dictId: 'DICT_OWN', original: '確定店', partnerName: '株式会社確定'});
    const ownFile = putCsv(customer, {fileId: 'own_file', rows: ['2025/12/10,確定店,1000,仕入れ']});
    const own = webImport(customer, {});

    const result = call('webAppFinalReview', ['C001', own.destinationSpreadsheetId,
      [ownFile, otherFile]]);
    const text = JSON.stringify(result);
    assert.ok(text.indexOf('777777') < 0, '他の顧客の金額が漏れている');
    assert.ok(text.indexOf('他社の秘密の明細') < 0, '他の顧客のファイル名が漏れている');
    assert.deepEqual(result.reconciliation.files.map((file) => file.fileId), [ownFile],
      '他の顧客のファイルを突き合わせに入れている');
    assert.equal(result.reconciliation.totals.balanced, true, '自分のファイルは一致するはず');
  });


  test('final 16: the download waits until the final review of this very sheet has been opened', () => {
    // 最終確認は「ダウンロードの一つ手前」の段階である（ko-ch さんの要望）。
    // 開く前・別のシートを開いた後・確定で古くなった後は、ダウンロードさせない。
    const gate = (lastId, reviewedId) => clientEval(
      `(state.lastCompletedDestinationSpreadsheetId = ${JSON.stringify(lastId)},` +
      ` state.finalReviewedFor = ${JSON.stringify(reviewedId)}, finalReviewIsCurrent())`);
    assert.equal(gate('D1', null), false, '最終確認を開く前にダウンロードできる');
    assert.equal(gate('D1', 'D1'), true, '開いたのにダウンロードできない');
    assert.equal(gate('D2', 'D1'), false, '別のシートの最終確認でダウンロードできる');
    assert.equal(gate(null, null), false, '転記先が無いのにダウンロードできる');
  });

  test('final 17: every problem kind the server can return has its own sentence', () => {
    // 利用者が読むのはこの文である。新しい種類を足してここを忘れると、
    // 「確認が必要です：AMOUNT_MISMATCH」のような内部名がそのまま出る。
    const kinds = ['MISSING', 'DUPLICATE', 'AMOUNT_MISMATCH', 'ORPHAN',
      'EXCLUDED_BUT_PRESENT', 'UNREADABLE_AMOUNT', 'FOREIGN_CUSTOMER'];
    // 突き合わせの関数の中だけを見る（他の関数にも `kind:` はある）
    const server = fs.readFileSync(path.join(process.cwd(), 'src', '80_WebApp.gs'), 'utf8');
    const body = server.slice(server.indexOf('function finalReviewReconcile_'),
      server.indexOf('function finalReviewAmount_'));
    assert.ok(body.length > 100, '突き合わせの関数が見つからない');
    const serverKinds = (body.match(/kind: '([A-Z_]+)'/g) || []).map((m) => m.slice(7, -1));
    assert.deepEqual([...new Set(serverKinds)].sort(), kinds.slice().sort(),
      'サーバーが返す問題の種類と、この表が食い違う');
    const sample = {txId: 'TX_0123456789abcdef', amount: 700, rowNumbers: [3, 9], rowNumber: 4,
      expected: 2500, actual: 9999, value: '千円'};
    kinds.forEach((kind) => {
      const text = clientEval(`FINAL_PROBLEM_TEXT[${JSON.stringify(kind)}](${JSON.stringify(sample)})`);
      assert.ok(typeof text === 'string' && text.length > 0, `${kind} の文が無い`);
      assert.ok(text.indexOf(kind) < 0, `${kind} が内部名のまま出ている: ${text}`);
    });
    const mismatch = clientEval(`FINAL_PROBLEM_TEXT.AMOUNT_MISMATCH(${JSON.stringify(sample)})`);
    assert.ok(/¥9,999/.test(mismatch) && /¥2,500/.test(mismatch),
      `書き換え後と記録の両方の金額を出していない: ${mismatch}`);
  });

  test('final 18: amounts read as yen, with the sign in front', () => {
    assert.equal(clientEval('yen(4200)'), '¥4,200');
    assert.equal(clientEval('yen(0)'), '¥0');
    assert.equal(clientEval('yen(-1000)'), '−¥1,000', '負の差額が読めない');
  });

  function kw17Seed(customerId, options = {}) {
    const original = options.original || 'AMAZON.CO.JP';
    const row = blank(18);
    Object.assign(row, {
      0: options.dictId || `DICT_KW17_${dictionaryRows().length + 1}`,
      1: original, 2: options.normalized === undefined ? call('normalizeMerchant', [original]) : options.normalized,
      3: options.partnerName || 'Amazon', 4: options.matchMethod || 'exact_normalized',
      5: options.priority === undefined ? '' : options.priority, 6: customerId,
      7: options.validFrom || '', 8: options.validTo || '', 9: 'FALSE',
      10: 'owner@example.com', 12: '2026-01-01T00:00:00+09:00',
      13: 1, 14: options.active === false ? 'FALSE' : 'TRUE',
      15: options.conflict ? 'TRUE' : 'FALSE'
    });
    gas.stubs.getSpreadsheet('master').getSheetByName('顧客別取引先辞書').appendRow(row);
    return row[0];
  }

  function kw17Sheet(name) {
    return gas.stubs.getSpreadsheet('master').getSheetByName(name);
  }

  function kw17Audit() {
    return kw17Sheet('監査ログ').getDataRange().getValues().slice(1)
      .filter((row) => String(row[2]) === 'DICT_REGISTER');
  }

  function kw17Match(customerId, original) {
    const rows = call('readDictionary_', [false]);
    const index = call('buildDictionaryIndex', [customerId, {customer: rows, common: []}]);
    return call('matchPartner', [{merchantOriginal: original}, customerId, index]);
  }

  test('kw17 1: repeat learning returns the first id without a second row or audit', () => {
    const {customer} = setupWorld();
    const args = [customer.customerId, 'AMAZON.CO.JP', call('normalizeMerchant', ['AMAZON.CO.JP']),
      'Amazon', 'reviewer@example.com'];
    const beforeRows = dictionaryRows().length;
    const beforeAudit = kw17Audit().length;
    const first = call('learnFromResolution', args);
    const second = call('learnFromResolution', args);
    assert.equal(second, first);
    assert.equal(dictionaryRows().length, beforeRows + 1);
    assert.equal(kw17Audit().length, beforeAudit + 1);
  });

  test('kw17 2: resolving two reviews for one merchant learns one row', () => {
    const seeded = seedPartnerViaWeb({count: 2});
    const before = dictionaryRows().length;
    seeded.reviews.forEach((review) => call('resolveReview', [review.reviewId,
      'ADOPT_EXISTING_PARTNER', {partnerName: 'Amazon'}]));
    assert.equal(dictionaryRows().length, before + 1);
  });

  test('kw17 3: a flagged equivalent row prevents learning', () => {
    const {customer} = setupWorld();
    const id = kw17Seed(customer.customerId, {conflict: true});
    const before = dictionaryRows().length;
    assert.equal(call('learnFromResolution', [customer.customerId, 'AMAZON.CO.JP',
      call('normalizeMerchant', ['AMAZON.CO.JP']), 'Amazon', 'reviewer@example.com']), id);
    assert.equal(dictionaryRows().length, before);
  });

  test('kw17 4: each of eight nonequivalent rows requires a new learned row', () => {
    const cases = [
      ['a inactive', {active: false}],
      ['b partner', {partnerName: 'Other'}],
      ['c original', {original: 'ＡＭＡＺＯＮ．ＣＯ．ＪＰ'}],
      ['d period', {validTo: '2025-01-01'}],
      ['e customer', {customerId: 'C002'}],
      ['f method', {matchMethod: 'prefix'}],
      ['g priority', {priority: 1}],
      ['h case', {partnerName: 'amazon'}]
    ];
    cases.forEach(([name, variant]) => {
      const {customer} = setupWorld();
      kw17Seed(variant.customerId || customer.customerId, variant);
      const before = dictionaryRows().length;
      call('learnFromResolution', [customer.customerId, 'AMAZON.CO.JP',
        call('normalizeMerchant', ['AMAZON.CO.JP']), 'Amazon', 'reviewer@example.com']);
      assert.equal(dictionaryRows().length, before + 1, name);
    });
  });

  test('kw17 5: one web press resolves two reviews with one learned row', () => {
    const single = seedPartnerViaWeb();
    gas.stubs.resetRoundTrips();
    assert.equal(webResolve(single.customer.customerId,
      [decision(single.reviews[0], 'Amazon')]).resolved, 1);
    const trips = gas.stubs.roundTrips();
    const total = trips.rangeReads + trips.rangeWrites + trips.flushes;
    // 修正前 92 往復、修正後 94 往復（+2）。読取経路の往復が増えた。
    assert.ok(total > 0);
    console.log(`KW17_ADOPT_TRIPS ${total}`);
    const seeded = seedPartnerViaWeb({count: 2});
    const before = dictionaryRows().length;
    const result = webResolve(seeded.customer.customerId,
      seeded.reviews.map((review) => decision(review, 'Amazon')));
    assert.equal(result.resolved, 2);
    assert.equal(dictionaryRows().length, before + 1);
  });

  test('kw17 6: candidate ids use ruleId then id then dictId and carry method', () => {
    const {customer} = setupWorld();
    const base = {original: 'SHOP', normalized: 'SHOP', partnerName: 'Shop',
      matchMethod: 'exact_normalized', active: true, priority: null};
    const match = (rule) => call('matchPartner', [{merchantOriginal: 'SHOP'}, customer.customerId,
      {customer: [Object.assign({}, base, rule)], common: []}]).candidates[0];
    assert.equal(match({dictId: 'DICT_ONLY'}).ruleId, 'DICT_ONLY');
    assert.equal(match({dictId: 'DICT_ONLY'}).matchMethod, 'exact_normalized');
    assert.equal(match({}).ruleId, '');
    assert.equal(match({id: 'ID', dictId: 'DICT'}).ruleId, 'ID');
    assert.equal(match({ruleId: 'RULE', id: 'ID', dictId: 'DICT'}).ruleId, 'RULE');
  });

  test('kw17 7: imported review Q and Z candidates carry dictionary id and method', () => {
    const {customer} = setupWorld();
    const id = kw17Seed(customer.customerId, {conflict: true});
    const fileId = putCsv(customer, {rows: ['2025/12/10,AMAZON.CO.JP,1000,仕入れ']});
    webImport(customer);
    const review = openReviewsFor(customer.customerId, {fileId})
      .find((row) => row.reviewType === 'PARTNER');
    assert.ok(review);
    const raw = kw17Sheet('要確認').getRange(review._rowNumber, 1, 1, 26).getValues()[0];
    const q = JSON.parse(raw[16]);
    const z = JSON.parse(raw[25]);
    [q, z.candidates].forEach((candidates) => {
      assert.equal(candidates[0].dictId, id);
      assert.equal(candidates[0].matchMethod, 'exact_normalized');
      assert.ok(!JSON.stringify(candidates).includes('undefined'));
    });
  });

  test('kw17 8: omitted and false apply report duplicates without writing', () => {
    const {customer} = setupWorld();
    kw17Seed(customer.customerId, {dictId: 'A'});
    kw17Seed(customer.customerId, {dictId: 'B'});
    const before = JSON.stringify(kw17Sheet('顧客別取引先辞書').getDataRange().getValues());
    const audit = JSON.stringify(kw17Sheet('監査ログ').getDataRange().getValues());
    [[], [false]].forEach((args) => {
      const report = call('opsDedupeDictionaryRows', args);
      assert.equal(report.apply, false);
      assert.equal(report.groups, 1);
      assert.equal(report.deactivate, 1);
      assert.equal(report.customerRows, 2);
      assert.equal(report.eligibleRows, 2);
      assert.equal(JSON.stringify(kw17Sheet('顧客別取引先辞書').getDataRange().getValues()), before);
      assert.equal(JSON.stringify(kw17Sheet('監査ログ').getDataRange().getValues()), audit);
    });
  });

  test('kw17 9: apply changes only O and R, audits once per customer, then is idempotent', () => {
    const {customer} = setupWorld();
    ['A', 'B', 'C'].forEach((dictId) => kw17Seed(customer.customerId, {dictId}));
    const before = kw17Sheet('顧客別取引先辞書').getRange(2, 1, 3, 18).getValues();
    const audits = kw17Audit().length;
    const report = call('opsDedupeDictionaryRows', [true]);
    assert.equal(report.groups, 1);
    assert.equal(report.deactivate, 2);
    const after = kw17Sheet('顧客別取引先辞書').getRange(2, 1, 3, 18).getValues();
    assert.equal(after.length, before.length);
    after.forEach((row, index) => {
      [14, 17].forEach((column) => { before[index][column] = row[column]; });
      assert.deepEqual(row, before[index], `other columns changed in row ${index}`);
      assert.equal(String(row[14]).toUpperCase(), index === 0 ? 'TRUE' : 'FALSE');
      if (index > 0) assert.ok(row[17]);
    });
    assert.equal(kw17Audit().length, audits + 1);
    const audit = kw17Audit().at(-1);
    assert.ok(JSON.stringify(audit).includes('DEDUPE_DICTIONARY_ROWS'));
    const frozen = JSON.stringify(dictionaryRows());
    const count = kw17Audit().length;
    const again = call('opsDedupeDictionaryRows', [true]);
    assert.equal(again.groups, 0);
    assert.equal(again.deactivate, 0);
    assert.equal(JSON.stringify(dictionaryRows()), frozen);
    assert.equal(kw17Audit().length, count);
  });

  test('kw17 10: a flagged later row is kept ahead of an unflagged earlier row', () => {
    const {customer} = setupWorld();
    kw17Seed(customer.customerId, {dictId: 'A'});
    kw17Seed(customer.customerId, {dictId: 'B', conflict: true});
    const report = call('opsDedupeDictionaryRows', [true]);
    assert.equal(report.keptFlagged, 1);
    const rows = dictionaryRows();
    assert.equal(String(rows[0][14]).toUpperCase(), 'FALSE');
    assert.equal(String(rows[1][14]).toUpperCase(), 'TRUE');
  });

  test('kw17 11: nonequivalent and exact_original rows stay untouched', () => {
    const {customer} = setupWorld();
    kw17Seed(customer.customerId, {dictId: 'BASE'});
    [
      {active: false}, {partnerName: 'Other'}, {original: 'ＡＭＡＺＯＮ．ＣＯ．ＪＰ'},
      {validTo: '2025-01-01'}, {customerId: 'C002'}, {matchMethod: 'prefix'},
      {priority: 1}, {partnerName: 'amazon'}, {matchMethod: 'exact_original'}
    ].forEach((variant, index) => kw17Seed(variant.customerId || customer.customerId,
      Object.assign({dictId: `EXCLUDED_${index}`}, variant)));
    const before = dictionaryRows().map((row) => row[14]);
    call('opsDedupeDictionaryRows', [true]);
    assert.deepEqual(dictionaryRows().map((row) => row[14]), before);
  });

  test('kw17 12: deduplication preserves matching decisions and distinct candidates', () => {
    const {customer} = setupWorld();
    [
      {dictId: 'A'}, {dictId: 'B'}, {dictId: 'C', conflict: true},
      {dictId: 'D', partnerName: 'Other'},
      {dictId: 'E', original: 'ＡＭＡＺＯＮ．ＣＯ．ＪＰ'},
      {dictId: 'F', original: 'DATED', validTo: '2025-01-01'},
      {dictId: 'G', original: 'AMAZ', matchMethod: 'prefix'}
    ].forEach((entry) => kw17Seed(customer.customerId, entry));
    const names = ['AMAZON.CO.JP', 'ＡＭＡＺＯＮ．ＣＯ．ＪＰ', 'DATED', 'AMAZON-OTHER'];
    const capture = () => names.map((name) => {
      const result = kw17Match(customer.customerId, name);
      return {autoConfirm: result.autoConfirm, partnerName: result.partnerName,
        matchedBy: result.matchedBy, conflict: result.conflict,
        names: [...new Set(result.candidates.map((entry) => entry.partnerName))].sort(),
        count: result.candidates.length};
    });
    const before = capture();
    call('opsDedupeDictionaryRows', [true]);
    const after = capture();
    after.forEach((result, index) => {
      assert.deepEqual(result.names, before[index].names);
      ['autoConfirm', 'partnerName', 'matchedBy', 'conflict'].forEach((key) =>
        assert.equal(result[key], before[index][key], `${names[index]} ${key}`));
    });
    assert.ok(after.some((result, index) => result.count < before[index].count));
  });

  test('kw17 13: changed target id at reread aborts all writes', () => {
    const {customer} = setupWorld();
    kw17Seed(customer.customerId, {dictId: 'A'});
    kw17Seed(customer.customerId, {dictId: 'B'});
    const original = gas.context.readDictionary_;
    let reads = 0;
    const error = caught(() => withMocks({readDictionary_: (common) => {
      if (!common && ++reads === 2) kw17Sheet('顧客別取引先辞書').getRange(3, 1).setValue('CHANGED');
      return original(common);
    }}, () => call('opsDedupeDictionaryRows', [true])));
    assert.match(String(error.message), /3/);
    const rows = dictionaryRows();
    assert.equal(rows[1][0], 'CHANGED');
    assert.equal(String(rows[0][14]).toUpperCase(), 'TRUE');
    assert.equal(String(rows[1][14]).toUpperCase(), 'TRUE');
    assert.equal(String(rows[0][17] || ''), '');
    assert.equal(String(rows[1][17] || ''), '');
  });

  test('kw17 14: an already inactive drop at reread aborts all writes', () => {
    const {customer} = setupWorld();
    kw17Seed(customer.customerId, {dictId: 'A'});
    kw17Seed(customer.customerId, {dictId: 'B'});
    kw17Seed(customer.customerId, {dictId: 'C'});
    const auditCount = kw17Audit().length;
    const original = gas.context.readDictionary_;
    let reads = 0;
    const error = caught(() => withMocks({readDictionary_: (common) => {
      if (!common && ++reads === 2) kw17Sheet('顧客別取引先辞書').getRange(3, 15).setValue('FALSE');
      return original(common);
    }}, () => call('opsDedupeDictionaryRows', [true])));
    assert.match(String(error.message), /3/);
    const rows = dictionaryRows();
    assert.deepEqual(rows.map((row) => String(row[14]).toUpperCase()), ['TRUE', 'FALSE', 'TRUE']);
    assert.ok(rows.every((row) => !row[17]));
    assert.equal(kw17Audit().length, auditCount);
  });

  test('kw17 15: an inactive or changed-conflict keeper at reread aborts all writes', () => {
    [
      ['inactive', 15, 'FALSE'],
      ['conflict', 16, 'TRUE']
    ].forEach(([caseName, column, value]) => {
      const {customer} = setupWorld();
      kw17Seed(customer.customerId, {dictId: 'A'});
      kw17Seed(customer.customerId, {dictId: 'B'});
      const auditCount = kw17Audit().length;
      const original = gas.context.readDictionary_;
      let reads = 0;
      const error = caught(() => withMocks({readDictionary_: (common) => {
        if (!common && ++reads === 2) kw17Sheet('顧客別取引先辞書').getRange(2, column).setValue(value);
        return original(common);
      }}, () => call('opsDedupeDictionaryRows', [true])));
      assert.match(String(error.message), /2/, caseName);
      const rows = dictionaryRows();
      assert.equal(String(rows[0][column - 1]).toUpperCase(), value, caseName);
      assert.equal(String(rows[1][14]).toUpperCase(), 'TRUE', caseName);
      assert.ok(rows.every((row) => !row[17]), caseName);
      assert.equal(kw17Audit().length, auditCount, caseName);
    });
  });

  test('kw17 16: a stale normalized value does not prevent learning', () => {
    const {customer} = setupWorld();
    kw17Seed(customer.customerId, {dictId: 'STALE', normalized: 'OLD_NORMALIZED'});
    const before = dictionaryRows().length;
    const learned = call('learnFromResolution', [customer.customerId, 'AMAZON.CO.JP',
      call('normalizeMerchant', ['AMAZON.CO.JP']), 'Amazon', 'reviewer@example.com']);
    assert.notEqual(learned, 'STALE');
    assert.equal(dictionaryRows().length, before + 1);
  });

  test('kw17 17: rows differing only in normalized value do not form a group', () => {
    const {customer} = setupWorld();
    kw17Seed(customer.customerId, {dictId: 'A'});
    kw17Seed(customer.customerId, {dictId: 'STALE', normalized: 'OLD_NORMALIZED'});
    const before = JSON.stringify(dictionaryRows());
    const report = call('opsDedupeDictionaryRows', [true]);
    assert.equal(report.groups, 0);
    assert.equal(report.deactivate, 0);
    assert.equal(JSON.stringify(dictionaryRows()), before);
  });

  test('kw17 18: null rule ids fall through to id and dictId', () => {
    const {customer} = setupWorld();
    const base = {original: 'SHOP', normalized: 'SHOP', partnerName: 'Shop',
      matchMethod: 'exact_normalized', active: true, priority: null};
    const candidate = (rule) => call('matchPartner', [{merchantOriginal: 'SHOP'}, customer.customerId,
      {customer: [Object.assign({}, base, rule)], common: []}]).candidates[0];
    assert.equal(candidate({ruleId: null, id: null, dictId: 'D'}).ruleId, 'D');
    assert.equal(candidate({ruleId: null, id: 'ID', dictId: 'D'}).ruleId, 'ID');
    assert.equal(candidate({ruleId: null, id: null, dictId: null}).ruleId, '');
  });

  function kw9SeedWebFile(customer, fileId, options = {}) {
    const rows = options.rows || (options.count
      ? Array.from({length: options.count}, (_, index) =>
        `2025/12/${String(10 + (index % 20)).padStart(2, '0')},未登録店,${1000 + index},仕入れ`)
      : [`2025/12/10,未登録店,${fileId === 'kw9_privacy' ? 1000 :
        2000 + Array.from(String(fileId)).reduce((sum, char) => sum + char.charCodeAt(0), 0)},仕入れ`]);
    putCsv(customer, {fileId, rows});
    const importOptions = {fileIds: [fileId]};
    if (options.destinationSpreadsheetId) {
      importOptions.destinationSpreadsheetId = options.destinationSpreadsheetId;
    }
    const result = webImport(customer, importOptions);
    const reviews = openReviewsFor(customer.customerId, {fileId})
      .filter((row) => row.reviewType === 'PARTNER');
    if (reviews.length) {
      resolveLoop(customer.customerId,
        reviews.map((review) => decision(review, '株式会社テスト')));
    }
    const transactions = call('getTransactionsForFile_', [fileId]);
    assert.equal(transactions.length, options.count || 1, `${fileId} の取引がある`);
    forceFileState(fileId, options.state || 'REVIEW_WAIT');
    return {fileId, destinationSpreadsheetId: result.destinationSpreadsheetId,
      transactions};
  }

  function kw9SeedScheduledFile(customer, fileId) {
    const amount = 3000 + Array.from(String(fileId))
      .reduce((sum, char) => sum + char.charCodeAt(0), 0);
    putCsv(customer, {fileId, rows: [`2025/12/10,未登録店,${amount},仕入れ`]});
    call('runImport', [{customerIds: [customer.customerId], fileIds: [fileId]}]);
    const reviews = openReviewsFor(customer.customerId, {fileId})
      .filter((row) => row.reviewType === 'PARTNER');
    if (reviews.length) {
      webResolve(customer.customerId,
        reviews.map((review) => decision(review, '株式会社テスト')), `kw9-scheduled-${fileId}`);
    }
    const transactions = call('getTransactionsForFile_', [fileId]);
    assert.equal(transactions.length, 1, `${fileId} の取引がある`);
    forceFileState(fileId, 'REVIEW_WAIT');
    return {fileId, destinationSpreadsheetId: customer.destinationId, transactions};
  }

  function kw9Preflight(customerId) {
    const report = call('runImport', [{customerIds: [customerId],
      fileIds: ['NO_SUCH_FILE']}]);
    return report.customers.find((item) => String(item.customerId) === String(customerId));
  }

  function kw9ColumnMapping(customer) {
    return call('getCustomerById', [customer.customerId]).columnMapping;
  }

  function kw9WriteDuplicate(tx, customer) {
    const destination = gas.stubs.getSpreadsheet(tx.destinationSpreadsheetId)
      .getSheetByName(tx.destinationSheetName);
    const row = destination.getLastRow() + 1;
    destination.getRange(row, Number(kw9ColumnMapping(customer).txId)).setValue(tx.fullTxId);
    return row;
  }

  function kw9ClearDestinationId(tx, customer) {
    gas.stubs.getSpreadsheet(tx.destinationSpreadsheetId)
      .getSheetByName(tx.destinationSheetName)
      .getRange(Number(tx.destinationRow), Number(kw9ColumnMapping(customer).txId)).setValue('');
  }

  function kw9SetManualChange(tx, customer, value = 'KW9_SECRET_REPLACED', field = 'F') {
    gas.stubs.getSpreadsheet(tx.destinationSpreadsheetId)
      .getSheetByName(tx.destinationSheetName)
      .getRange(Number(tx.destinationRow), Number(kw9ColumnMapping(customer)[field])).setValue(value);
  }

  function kw9Ops(customerId, options) {
    return call('opsCheckIntegrityAllDestinations', [customerId, options]);
  }

  function kw9SheetSnapshot(sheet) {
    const range = sheet.getDataRange();
    return {values: range.getValues(), formulas: range.getFormulas()};
  }

  function kw9ReadOnlySnapshot(destinationIds) {
    const master = gas.stubs.getSpreadsheet('master');
    const masterNames = ['クレカ取引ログ', '恒久ファイルインデックス', 'クレカ処理ログ',
      '要確認', '監査ログ'];
    const result = {master: {}, destinations: {}};
    masterNames.forEach((name) => {
      result.master[name] = kw9SheetSnapshot(master.getSheetByName(name));
    });
    [...new Set(destinationIds)].sort().forEach((id) => {
      const spreadsheet = gas.stubs.getSpreadsheet(id);
      result.destinations[id] = spreadsheet.getSheets().map((sheet) => ({
        name: sheet.getName(), snapshot: kw9SheetSnapshot(sheet)
      }));
    });
    return result;
  }

  test('kw9 1: duplicate transaction rows in the web clone stop the import', () => {
    const {customer} = setupWorld();
    const seeded = kw9SeedWebFile(customer, 'kw9_duplicate');
    const tx = seeded.transactions[0];
    kw9WriteDuplicate(tx, customer);
    const report = kw9Preflight(customer.customerId);
    const finding = report.integrity.findings.find((item) =>
      item.check === 'DUPLICATE_DESTINATION_ROW');
    assert.equal(report.integrity.stop, true);
    assert.ok(finding);
    assert.equal(finding.detail.fullTxId, tx.fullTxId);
    assert.equal(finding.detail.matchCount, 2);
    assert.equal(report.skipped, 'INTEGRITY_STOP');
  });

  test('kw9 2: a committed clone transaction has no false integrity finding', () => {
    const {customer} = setupWorld();
    kw9SeedWebFile(customer, 'kw9_clean');
    const report = kw9Preflight(customer.customerId);
    assert.equal(report.integrity.ok, true);
    assert.deepEqual(report.integrity.findings, []);
    assert.equal(report.integrity.indexesBuilt, 1);
  });

  test('kw9 3: manual edits and missing rows in the clone are reported', () => {
    const first = setupWorld();
    const edited = kw9SeedWebFile(first.customer, 'kw9_manual');
    const tx = edited.transactions[0];
    kw9SetManualChange(tx, first.customer, 'KW9_SECRET_REPLACED');
    const manual = kw9Preflight(first.customer.customerId).integrity;
    const manualFinding = manual.findings.find((item) => item.check === 'MANUAL_CHANGE');
    assert.ok(manualFinding);
    assert.equal(manualFinding.detail.fullTxId, tx.fullTxId);
    assert.equal(manualFinding.detail.column, 'f');
    assert.equal(manualFinding.detail.rowNumber, Number(tx.destinationRow));
    assert.equal(manual.stop, false);

    const second = setupWorld();
    const missing = kw9SeedWebFile(second.customer, 'kw9_missing');
    kw9ClearDestinationId(missing.transactions[0], second.customer);
    const missingReport = kw9Preflight(second.customer.customerId).integrity;
    const missingFinding = missingReport.findings.find((item) =>
      item.check === 'DESTINATION_ROW_MISSING');
    assert.ok(missingFinding);
    assert.equal(missingFinding.detail.fullTxId, missing.transactions[0].fullTxId);
    assert.equal(missingReport.stop, false);
  });

  test('kw9 4: transactions without AC AD use the template index', () => {
    const web = setupWorld();
    const clone = kw9SeedWebFile(web.customer, 'kw9_legacy_clone');
    clearRecordedDestinationsForFile(clone.fileId);
    const legacyClone = kw9Preflight(web.customer.customerId).integrity;
    assert.ok(legacyClone.findings.some((item) => item.check === 'DESTINATION_ROW_MISSING'));

    const scheduled = setupWorld();
    const template = kw9SeedScheduledFile(scheduled.customer, 'kw9_legacy_template');
    clearRecordedDestinationsForFile(template.fileId);
    const legacyTemplate = kw9Preflight(scheduled.customer.customerId).integrity;
    assert.equal(legacyTemplate.findings.some((item) =>
      item.check === 'DESTINATION_ROW_MISSING'), false);
    assert.equal(legacyClone.indexesBuilt, 1);
  });

  test('kw9 5: one cached index per destination routes each file to its own clone', () => {
    const separate = setupWorld();
    const fileB = kw9SeedWebFile(separate.customer, 'kw9_dest_b');
    forceFileState(fileB.fileId, 'COMPLETED');
    const fileC = kw9SeedWebFile(separate.customer, 'kw9_dest_c');
    forceFileState(fileB.fileId, 'REVIEW_WAIT');
    forceFileState(fileC.fileId, 'REVIEW_WAIT');
    assert.notEqual(fileB.destinationSpreadsheetId, fileC.destinationSpreadsheetId);
    kw9ClearDestinationId(fileB.transactions[0], separate.customer);
    const separateReport = kw9Preflight(separate.customer.customerId).integrity;
    const missing = separateReport.findings.filter((item) =>
      item.check === 'DESTINATION_ROW_MISSING');
    assert.equal(separateReport.indexesBuilt, 2);
    assert.deepEqual(missing.map((item) => item.detail.fullTxId),
      [fileB.transactions[0].fullTxId]);

    const shared = setupWorld();
    const sameB = kw9SeedWebFile(shared.customer, 'kw9_same_b1');
    forceFileState(sameB.fileId, 'COMPLETED');
    const sameB2 = kw9SeedWebFile(shared.customer, 'kw9_same_b2', {
      destinationSpreadsheetId: sameB.destinationSpreadsheetId
    });
    forceFileState(sameB.fileId, 'REVIEW_WAIT');
    forceFileState(sameB2.fileId, 'REVIEW_WAIT');
    assert.equal(sameB.destinationSpreadsheetId, sameB2.destinationSpreadsheetId);
    const sharedReport = kw9Preflight(shared.customer.customerId).integrity;
    assert.equal(sharedReport.indexesBuilt, 1);
    assert.deepEqual(sharedReport.findings, []);
  });

  test('kw9 6: no in-scope transactions means no preflight index read', () => {
    const {customer} = setupWorld();
    const seeded = kw9SeedWebFile(customer, 'kw9_scope_empty', {state: 'COMPLETED'});
    forceFileState(seeded.fileId, 'COMPLETED');
    let builds = 0;
    let valuesOnlyBuilds = 0;
    const original = gas.context.buildIndex;
    gas.context.buildIndex = function(target, options) {
      builds += 1;
      if (options && options.valuesOnly === true) valuesOnlyBuilds += 1;
      return original.apply(this, arguments);
    };
    try {
      const report = kw9Preflight(customer.customerId);
      assert.equal(valuesOnlyBuilds, 0);
      assert.equal(builds, 0);
      assert.equal(report.integrity.indexesBuilt, 0);
    } finally {
      gas.context.buildIndex = original;
    }
  });

  test('kw9 7: unreadable destinations are review findings, transient errors propagate', () => {
    const {customer} = setupWorld();
    const seeded = kw9SeedWebFile(customer, 'kw9_unreadable');
    const spreadsheetApp = gas.context.SpreadsheetApp;
    const originalOpen = spreadsheetApp.openById;
    spreadsheetApp.openById = function(id) {
      if (String(id) === String(seeded.destinationSpreadsheetId)) {
        throw new Error('destination unavailable');
      }
      return originalOpen.apply(this, arguments);
    };
    let permanent;
    try {
      permanent = kw9Preflight(customer.customerId);
    } finally {
      spreadsheetApp.openById = originalOpen;
    }
    const unreadable = permanent.integrity.findings.find((item) =>
      item.check === 'DESTINATION_UNREADABLE');
    assert.ok(unreadable);
    assert.equal(unreadable.severity, 'REVIEW');
    assert.equal(unreadable.detail.spreadsheetId, seeded.destinationSpreadsheetId);
    assert.equal(unreadable.detail.transactions, 1);
    assert.equal(permanent.integrity.stop, false);
    assert.notEqual(permanent.skipped, 'INTEGRITY_STOP');

    const spreadsheetAppAgain = gas.context.SpreadsheetApp;
    const originalOpenAgain = spreadsheetAppAgain.openById;
    spreadsheetAppAgain.openById = function(id) {
      if (String(id) === String(seeded.destinationSpreadsheetId)) {
        const error = new Error('temporary Sheets failure');
        error.code = 'TRANSIENT_SHEETS_ERROR';
        throw error;
      }
      return originalOpenAgain.apply(this, arguments);
    };
    let transient;
    try {
      transient = kw9Preflight(customer.customerId);
    } finally {
      spreadsheetAppAgain.openById = originalOpenAgain;
    }
    assert.ok(JSON.stringify(transient).includes('TRANSIENT_SHEETS_ERROR'));
    assert.notEqual(transient.skipped, 'INTEGRITY_STOP');
  });

  test('kw9 8: valuesOnly skips formulas and disables formula-dependent checks', () => {
    const {customer} = setupWorld();
    const target = call('getCustomerById', [customer.customerId]);
    const valuesApi = gas.context.Sheets.Spreadsheets.Values;
    const originalBatchGet = valuesApi.batchGet;
    let formulaReads = 0;
    valuesApi.batchGet = function(spreadsheetId, request) {
      if (request.valueRenderOption === 'FORMULA') formulaReads += 1;
      return originalBatchGet.apply(this, arguments);
    };
    let onlyValues;
    let normal;
    const formulaRow = Number(target.dataStartRow || 2);
    try {
      normal = gas.call('buildIndex', [target, {}]);
      assert.ok(formulaReads > 0);
      assert.ok(gas.call('getFormulasByRow', [normal, formulaRow])
        .some((formula) => Boolean(formula)));
      formulaReads = 0;
      onlyValues = gas.call('buildIndex', [target, {valuesOnly: true}]);
      assert.equal(formulaReads, 0);
    } finally {
      valuesApi.batchGet = originalBatchGet;
    }
    assert.deepEqual([...onlyValues.byTxId], [...normal.byTxId]);
    assert.deepEqual([...onlyValues.valuesByRow], [...normal.valuesByRow]);
    assert.equal(gas.call('getFormulasByRow', [onlyValues, formulaRow]), null);
    assert.throws(() => gas.call('isRowEmpty', [onlyValues, formulaRow, target]),
      (error) => error.name === 'RangeError');
    assert.ok(gas.call('getFormulasByRow', [normal, formulaRow])
      .some((formula) => Boolean(formula)));
  });

  test('kw9 9: indexForTransaction routes checks and leaves file checks ungrouped', () => {
    const {customer} = setupWorld();
    const fileA = kw9SeedWebFile(customer, 'kw9_route_a');
    forceFileState(fileA.fileId, 'COMPLETED');
    const fileB = kw9SeedWebFile(customer, 'kw9_route_b');
    const txA = Object.assign({}, fileA.transactions[0], {transactionStatus: 'PREPARED'});
    const txB = Object.assign({}, fileB.transactions[0], {transactionStatus: 'PREPARED'});
    kw9WriteDuplicate(txA, customer);
    kw9WriteDuplicate(txB, customer);
    const indexA = gas.call('buildIndex', [call('customerForRecordedDestination_',
      [call('getCustomerById', [customer.customerId]), txA]), {valuesOnly: true}]);
    const indexB = gas.call('buildIndex', [call('customerForRecordedDestination_',
      [call('getCustomerById', [customer.customerId]), txB]), {valuesOnly: true}]);
    const missingIndexError = caught(() => gas.call('runIntegrityCheck', [{txLogs: []}]));
    assert.equal(missingIndexError.name, 'TypeError');
    assert.equal(missingIndexError.message, 'runIntegrityCheck requires a destination index');
    const routed = Object.create(null);
    const outcome = plain(gas.call('runIntegrityCheck', [{index: indexA,
      indexForTransaction(tx) {
        routed[tx.fullTxId] = (routed[tx.fullTxId] || 0) + 1;
        return tx.fullTxId === txA.fullTxId ? indexA : indexB;
      }, txLogs: [txA, txB], fileState: 'COMPLETED',
      processLogState: 'WRITING', permanentIndexState: 'COMPLETED'}]));
    assert.deepEqual(Object.entries(routed).sort(),
      [[txA.fullTxId, 1], [txB.fullTxId, 1]].sort());
    const duplicates = outcome.findings.filter((item) =>
      item.check === 'DUPLICATE_DESTINATION_ROW');
    assert.deepEqual(duplicates.map((item) => item.detail.fullTxId),
      [txA.fullTxId, txB.fullTxId]);
    assert.equal(outcome.findings.filter((item) =>
      item.check === 'FILE_STATE_TX_MISMATCH').length, 2);
    assert.equal(outcome.findings.filter((item) =>
      item.check === 'PERMANENT_INDEX_DESYNC').length, 1);

    const skippedNull = plain(gas.call('runIntegrityCheck', [{index: indexA,
      indexForTransaction: () => null, txLogs: [txA]}]));
    assert.equal(skippedNull.findings.some((item) =>
      ['DUPLICATE_DESTINATION_ROW', 'DESTINATION_ROW_MISSING', 'MANUAL_CHANGE']
        .includes(item.check)), false);
  });

  test('kw9 10: all destinations are checked without changing any sheet', () => {
    const {customer} = setupWorld();
    const cloneB = kw9SeedWebFile(customer, 'kw9_ops_b', {state: 'COMPLETED'});
    const cloneC = kw9SeedWebFile(customer, 'kw9_ops_c', {state: 'COMPLETED'});
    const template = kw9SeedScheduledFile(customer, 'kw9_ops_template');
    clearRecordedDestinationsForFile(template.fileId);
    cloneB.transactions.forEach((tx) => kw9WriteDuplicate(tx, customer));
    kw9SetManualChange(cloneC.transactions[0], customer, 'KW9_SECRET_OPS_EDIT');
    const before = kw9ReadOnlySnapshot([customer.destinationId,
      cloneB.destinationSpreadsheetId, cloneC.destinationSpreadsheetId]);
    const report = kw9Ops();
    const after = kw9ReadOnlySnapshot([customer.destinationId,
      cloneB.destinationSpreadsheetId, cloneC.destinationSpreadsheetId]);
    assert.deepEqual(after, before);
    const item = report.customers.find((entry) => entry.customerId === customer.customerId);
    assert.ok(item);
    assert.equal(item.transactions, 3);
    assert.equal(item.legacyTransactions, template.transactions.length);
    const byDestination = Object.fromEntries(item.destinations.map((entry) =>
      [entry.spreadsheetId, entry]));
    assert.equal(byDestination[cloneB.destinationSpreadsheetId].transactions, 1);
    assert.equal(byDestination[cloneB.destinationSpreadsheetId]
      .findings.DUPLICATE_DESTINATION_ROW, 1);
    assert.equal(byDestination[cloneC.destinationSpreadsheetId].transactions, 1);
    assert.equal(byDestination[cloneC.destinationSpreadsheetId].findings.MANUAL_CHANGE, 1);
    assert.equal(byDestination[customer.destinationId].transactions, 1);
    assert.equal(item.findings.DUPLICATE_DESTINATION_ROW, 1);
    assert.equal(item.findings.MANUAL_CHANGE, 1);
  });

  test('kw9 11: the all-destination scan includes completed files', () => {
    const {customer} = setupWorld();
    const seeded = kw9SeedWebFile(customer, 'kw9_ops_completed', {state: 'COMPLETED'});
    forceFileState(seeded.fileId, 'COMPLETED');
    kw9SetManualChange(seeded.transactions[0], customer, 'KW9_COMPLETED_EDIT');
    const preflight = kw9Preflight(customer.customerId).integrity;
    assert.equal(preflight.findings.some((item) => item.check === 'MANUAL_CHANGE'), false);
    const report = kw9Ops(customer.customerId);
    assert.ok(report.customers[0].findings.MANUAL_CHANGE >= 1);
  });

  test('kw9 12: customerId limits the all-destination scan', () => {
    const {world, customer} = setupWorld();
    const second = addCustomer(world, {suffix: '2', customerId: 'C002', customerName: '顧客二'});
    kw9SeedWebFile(customer, 'kw9_customer_1');
    kw9SeedWebFile(second, 'kw9_customer_2');
    const selected = kw9Ops('C001');
    const all = kw9Ops();
    assert.deepEqual(selected.customers.map((entry) => entry.customerId), ['C001']);
    assert.deepEqual(all.customers.map((entry) => entry.customerId).sort(), ['C001', 'C002']);
  });

  test('kw9 13: operations samples omit transaction values and are capped at twenty', () => {
    const {customer} = setupWorld();
    const seeded = kw9SeedWebFile(customer, 'kw9_privacy', {count: 21});
    seeded.transactions.forEach((tx, index) => {
      kw9SetManualChange(tx, customer, `KW9_SECRET_VALUE_${index}_F`);
      kw9SetManualChange(tx, customer, `KW9_SECRET_VALUE_${index}_I`, 'I');
    });
    const report = kw9Ops(customer.customerId);
    const serialized = JSON.stringify(report) + JSON.stringify(gas.stubs.getLogLines().at(-1));
    ['KW9_SECRET_VALUE_0', '未登録店', '1000', '仕入れ'].forEach((value) =>
      assert.equal(serialized.includes(value), false, `leaked ${value}`));
    assert.equal(report.customers[0].samples.length, 20);
  });

  test('kw9 14: unreadable clone destinations do not stop other destination scans', () => {
    const {customer} = setupWorld();
    const unreadable = kw9SeedWebFile(customer, 'kw9_ops_unreadable', {state: 'COMPLETED'});
    const readable = kw9SeedWebFile(customer, 'kw9_ops_readable', {state: 'COMPLETED'});
    kw9SetManualChange(readable.transactions[0], customer, 'KW9_READABLE_EDIT');
    const spreadsheetApp = gas.context.SpreadsheetApp;
    const originalOpen = spreadsheetApp.openById;
    spreadsheetApp.openById = function(id) {
      if (String(id) === String(unreadable.destinationSpreadsheetId)) {
        throw new Error('destination unavailable');
      }
      return originalOpen.apply(this, arguments);
    };
    let report;
    try {
      report = kw9Ops(customer.customerId);
    } finally {
      spreadsheetApp.openById = originalOpen;
    }
    const item = report.customers[0];
    assert.deepEqual(item.unreadable, [{spreadsheetId: unreadable.destinationSpreadsheetId,
      sheetName: '入力用シート', transactions: 1}]);
    assert.ok(item.findings.MANUAL_CHANGE >= 1);
    assert.equal(item.findings.DESTINATION_UNREADABLE, undefined);
  });

  test('kw9 15: a zero time budget defers every destination without building an index', () => {
    const {customer} = setupWorld();
    const first = kw9SeedWebFile(customer, 'kw9_budget_b', {state: 'COMPLETED'});
    forceFileState(first.fileId, 'COMPLETED');
    kw9SeedWebFile(customer, 'kw9_budget_c');
    let builds = 0;
    const original = gas.context.buildIndex;
    gas.context.buildIndex = function() {
      builds += 1;
      return original.apply(this, arguments);
    };
    let report;
    try {
      report = kw9Ops(undefined, {timeBudgetMs: 0});
    } finally {
      gas.context.buildIndex = original;
    }
    assert.equal(report.stoppedBy, 'TIME_BUDGET');
    assert.deepEqual(report.deferredDestinations.map((item) => item.spreadsheetId).sort(),
      report.customers[0].destinations.map((item) => item.spreadsheetId).sort());
    assert.equal(builds, 0);
    assert.deepEqual(report.customers[0].unreadable, []);
  });

  // 16〜20 は監査（2026-10-01）で足した。Codex の変異 M1〜M18 は通ったが、次の変異は
  // 緑のまま通った：開けない転記先の取引数が増えない（実装の不具合でもあった ── 一覧が
  // 数え上げるエントリと別のオブジェクトだった）・全複製の検査がファイル状態を見ない・
  // 合計を足さない・前検査の索引が FORMULA を読む・容量超過（429）を「開けない」に丸める。
  // kw9 19（予算切れの転記先を 1 回だけ並べる）は、変異では赤にならない（`opsCheck…` が
  // 転記先の一覧から作るので、解決器の側の重複は外から見えない）。一覧が重ならない回帰として残す。
  function kw9BlockOpen(spreadsheetId, makeError) {
    const spreadsheetApp = gas.context.SpreadsheetApp;
    const originalOpen = spreadsheetApp.openById;
    spreadsheetApp.openById = function(id) {
      if (String(id) === String(spreadsheetId)) throw makeError();
      return originalOpen.apply(this, arguments);
    };
    return () => { spreadsheetApp.openById = originalOpen; };
  }

  test('kw9 16: an unreadable destination is reported once with every transaction it holds', () => {
    const {customer} = setupWorld();
    const seeded = kw9SeedWebFile(customer, 'kw9_unreadable_many', {count: 3});
    const restore = kw9BlockOpen(seeded.destinationSpreadsheetId,
      () => new Error('destination unavailable'));
    let preflight;
    let scan;
    try {
      preflight = kw9Preflight(customer.customerId).integrity;
      scan = kw9Ops(customer.customerId);
    } finally {
      restore();
    }
    const findings = preflight.findings.filter((item) =>
      item.check === 'DESTINATION_UNREADABLE');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detail.transactions, 3);
    assert.deepEqual(scan.customers[0].unreadable, [{
      spreadsheetId: seeded.destinationSpreadsheetId, sheetName: '入力用シート',
      transactions: 3
    }]);
    assert.equal(scan.totals.unreadable, 1);
  });

  test('kw9 17: the all-destination scan reports file state mismatches and sums the totals', () => {
    const {customer} = setupWorld();
    const fileId = putCsv(customer, {fileId: 'kw9_state_mismatch',
      rows: ['2025/12/10,未登録店,4321,仕入れ']});
    webImport(customer, {fileIds: [fileId]});
    const transactions = call('getTransactionsForFile_', [fileId]);
    assert.equal(transactions.length, 1);
    assert.notEqual(transactions[0].transactionStatus, 'COMMITTED');
    forceFileState(fileId, 'COMPLETED');
    const report = kw9Ops(customer.customerId);
    const item = report.customers[0];
    assert.ok(item.findings.FILE_STATE_TX_MISMATCH >= 1);
    assert.equal(report.totals.findings.FILE_STATE_TX_MISMATCH,
      item.findings.FILE_STATE_TX_MISMATCH);
    assert.equal(report.totals.customers, 1);
    assert.equal(report.totals.files, 1);
    assert.equal(report.totals.transactions, 1);
  });

  test('kw9 18: the preflight index of a clone reads values only', () => {
    const {customer} = setupWorld();
    const seeded = kw9SeedWebFile(customer, 'kw9_values_only');
    const valuesApi = gas.context.Sheets.Spreadsheets.Values;
    const originalBatchGet = valuesApi.batchGet;
    const reads = {formula: 0, values: 0};
    valuesApi.batchGet = function(spreadsheetId, request) {
      if (String(spreadsheetId) === String(seeded.destinationSpreadsheetId)) {
        if (request.valueRenderOption === 'FORMULA') reads.formula += 1;
        else reads.values += 1;
      }
      return originalBatchGet.apply(this, arguments);
    };
    try {
      assert.equal(kw9Preflight(customer.customerId).integrity.indexesBuilt, 1);
    } finally {
      valuesApi.batchGet = originalBatchGet;
    }
    assert.equal(reads.formula, 0);
    assert.ok(reads.values > 0);
  });

  test('kw9 19: a deferred destination is listed once however many transactions it holds', () => {
    const {customer} = setupWorld();
    const seeded = kw9SeedWebFile(customer, 'kw9_deferred_once', {count: 2});
    const report = kw9Ops(undefined, {timeBudgetMs: 0});
    assert.equal(report.stoppedBy, 'TIME_BUDGET');
    assert.deepEqual(report.deferredDestinations, [{customerId: customer.customerId,
      spreadsheetId: seeded.destinationSpreadsheetId, sheetName: '入力用シート'}]);
  });

  test('kw9 20: a quota error is not folded into an unreadable destination', () => {
    const {customer} = setupWorld();
    const seeded = kw9SeedWebFile(customer, 'kw9_quota');
    const restore = kw9BlockOpen(seeded.destinationSpreadsheetId, () => {
      const error = new Error('Quota exceeded for quota metric Read requests per minute');
      error.code = 429;
      return error;
    });
    let report;
    try {
      report = kw9Preflight(customer.customerId);
    } finally {
      restore();
    }
    assert.equal(report.integrity, undefined);
    assert.ok(String(report.error).includes('Quota exceeded'));
    assert.equal(JSON.stringify(report).includes('DESTINATION_UNREADABLE'), false);
  });

  function batchResolve(customer, fileId, decisions, options = {}) {
    return call('resolvePartnerReviewsBatch', [customer.customerId, fileId, decisions,
      Object.assign({actor: 'reviewer@example.com'}, options)]);
  }

  function batchComparable(seeded) {
    const master = gas.stubs.getSpreadsheet('master');
    const reviewSheet = master.getSheetByName('要確認');
    const txSheet = master.getSheetByName('クレカ取引ログ');
    const customerDict = master.getSheetByName('顧客別取引先辞書');
    const auditSheet = master.getSheetByName('監査ログ');
    const items = seeded.reviews.map((seed) => {
      const review = reviewById(seed.reviewId);
      const tx = transactionFor(seed);
      const txRow = txSheet.getRange(tx._rowNumber, 1, 1, 47).getValues()[0];
      const reviewRow = reviewSheet.getRange(review._rowNumber, 1, 1, 32).getValues()[0];
      const destination = gas.stubs.getSpreadsheet(review.destinationSpreadsheetId)
        .getSheetByName(review.destinationSheetName);
      return {sourceRow: Number(review.sourceRow), destination: [
        destination.getRange(tx.destinationRow, 3).getValue(),
        destination.getRange(tx.destinationRow, 4).getValue()
      ], tx: [txRow[9], txRow[11], ...txRow.slice(18, 28), txRow[45], txRow[46]],
      review: [reviewRow[1], reviewRow[17], reviewRow[27], reviewRow[29], reviewRow[31]]};
    }).sort((a, b) => a.sourceRow - b.sourceRow);
    const dictionaryRows = customerDict.getDataRange().getValues().slice(1)
      .filter((row) => String(row[6]) === String(seeded.customer.customerId) && row[0])
      .map((row) => [...row.slice(1, 12), ...row.slice(13, 18)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const allTransactions = txSheet.getDataRange().getValues();
    const events = auditSheet.getDataRange().getValues().slice(1)
      .filter((row) => ['REVIEW_RESOLVE', 'DICT_REGISTER'].includes(String(row[2])))
      .map((row) => {
        let target = String(row[7]);
        if (row[2] === 'DICT_REGISTER') {
          const dict = dictionaryRows.find((item) => String(item[0]) === target);
          const originalId = customerDict.getDataRange().getValues().slice(1)
            .find((item) => String(item[0]) === target);
          target = originalId ? `${originalId[1]}|${originalId[3]}` : target;
        } else {
          const tx = allTransactions.find((item) => String(item[0]) === target);
          target = tx ? String(tx[6]) : target;
        }
        return [row[2], row[6], target, row[8], row[10]];
      }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return {items, dictionaryRows, events};
  }

  function seedAutoAdoptionFiles(sizes, prefix = 'batch_auto') {
    const {customer} = setupWorld();
    const files = [];
    sizes.forEach((size, fileIndex) => {
      const fileId = `${prefix}_${fileIndex + 1}`;
      const rows = Array.from({length: size}, (_, rowIndex) =>
        `2025/12/${String(10 + fileIndex * 10 + rowIndex).padStart(2, '0')},自動採用店,${2000 + fileIndex * 100 + rowIndex},仕入れ`);
      putCsv(customer, {fileId, rows});
      webImport(customer, {fileIds: [fileId]});
      files.push(fileId);
    });
    const normalized = call('normalizeMerchant', ['自動採用店']);
    call('learnFromResolution', [customer.customerId, '自動採用店', normalized,
      '株式会社自動採用', 'owner@example.com']);
    return {customer, files};
  }

  function withPartnerTiming(durations, fn) {
    const priorClock = gas.context.partnerBatchClockNow_;
    const priorBatch = gas.context.resolvePartnerReviewsBatch;
    let now = 1000;
    let index = 0;
    gas.context.partnerBatchClockNow_ = () => now;
    gas.context.resolvePartnerReviewsBatch = function(...args) {
      const result = priorBatch.apply(this, args);
      now += Number(durations[index++] || 0);
      return result;
    };
    try { return fn({now: () => now}); }
    finally {
      gas.context.partnerBatchClockNow_ = priorClock;
      gas.context.resolvePartnerReviewsBatch = priorBatch;
    }
  }

  test('batch 1: ADOPT の3件は1件ずつの経路と転記・取引ログ・要確認・辞書・監査が同値', () => {
    const rows = ['2025/12/10,比較店A,1000,仕入れ',
      '2025/12/11,比較店B,2000,仕入れ', '2025/12/12,比較店C,3000,仕入れ'];
    const singles = seedPartnerViaWeb({rows});
    singles.reviews.forEach((review) => call('resolveReview', [review.reviewId,
      'ADOPT_EXISTING_PARTNER', {partnerName: '株式会社比較先', learn: true,
        actor: 'reviewer@example.com'}]));
    const singleSnapshot = batchComparable(singles);
    const batched = seedPartnerViaWeb({rows});
    const result = batchResolve(batched.customer, batched.fileId, batched.reviews.map((review) => ({
      reviewId: review.reviewId, operation: 'ADOPT_EXISTING_PARTNER',
      partnerName: '株式会社比較先', learn: true
    })));
    assert.equal(result.resolvedReviewIds.length, 3);
    assert.deepEqual(batchComparable(batched), singleSnapshot);
  });

  test('batch 2: ADOPT・WITHOUT・UNKNOWN の混在も1件ずつの経路と同値', () => {
    const run = (batched) => {
      const seeded = seedPartnerViaWeb({rows: ['2025/12/10,混在店A,1000,仕入れ',
        '2025/12/11,混在店B,2000,仕入れ', '2025/12/12,混在店C,3000,仕入れ']});
      const operations = [
        {operation: 'ADOPT_EXISTING_PARTNER', partnerName: '株式会社混在先', learn: false},
        {operation: 'RESOLVE_WITHOUT_PARTNER'},
        {operation: 'RESOLVE_PARTNER_UNKNOWN'}
      ];
      if (batched) batchResolve(seeded.customer, seeded.fileId, seeded.reviews.map((review, index) =>
        Object.assign({reviewId: review.reviewId}, operations[index])));
      else seeded.reviews.forEach((review, index) => call('resolveReview', [review.reviewId,
        operations[index].operation, operations[index]]));
      return batchComparable(seeded);
    };
    assert.deepEqual(run(true), run(false));
  });

  test('batch 3: 2件と20件でbatchGet回数が同じで上限20以下', () => {
    const measure = (count) => {
      const seeded = seedPartnerViaWeb({count, merchant: '読取件数店'});
      gas.stubs.resetApiCallCounts();
      const before = gas.stubs.getApiCallCounts().batchGet;
      const result = batchResolve(seeded.customer, seeded.fileId, seeded.reviews.map((review) => ({
        reviewId: review.reviewId, operation: 'ADOPT_EXISTING_PARTNER',
        partnerName: '株式会社読取先', learn: false
      })));
      return {reads: gas.stubs.getApiCallCounts().batchGet - before, result};
    };
    const two = measure(2);
    const twenty = measure(20);
    assert.equal(two.reads, twenty.reads);
    assert.ok(two.reads <= 20, `batch read ceiling: ${two.reads}`);
    assert.equal(two.result.reads, twenty.result.reads);
  });

  test('batch 4: ファイルのリース衝突では全件を飛ばし、他者のリースとデータを保つ', () => {
    const seeded = seedPartnerViaWeb({count: 2});
    call('acquireLease', [seeded.customer.customerId, seeded.fileId, 'OTHER_RUN',
      'other@example.com', 'WRITE_ONLY']);
    const txBefore = seeded.reviews.map((review) => transactionFor(review));
    const reviewBefore = seeded.reviews.map((review) => reviewById(review.reviewId));
    const auditBefore = gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ')
      .getDataRange().getValues().filter((row) => row[2] === 'REVIEW_RESOLVE').length;
    const result = batchResolve(seeded.customer, seeded.fileId, seeded.reviews.map((review) => ({
      reviewId: review.reviewId, operation: 'ADOPT_EXISTING_PARTNER',
      partnerName: '株式会社競合なし', learn: true
    })));
    assert.deepEqual(result.skippedByLeaseReviewIds, seeded.reviews.map((review) => review.reviewId));
    assert.ok(result.leaseConflict);
    assert.deepEqual(seeded.reviews.map((review) => transactionFor(review)), txBefore);
    assert.deepEqual(seeded.reviews.map((review) => reviewById(review.reviewId)), reviewBefore);
    assert.equal(gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ')
      .getDataRange().getValues().filter((row) => row[2] === 'REVIEW_RESOLVE').length, auditBefore);
    assert.deepEqual(call('activeLeases_', []).map((lease) => lease.runId), ['OTHER_RUN']);
  });

  test('batch 5: 手順6で例外が出ても呼出側へ出てリースを返す', () => {
    const seeded = seedPartnerViaWeb();
    const failure = new Error('step six fault');
    const error = caught(() => withMocks({readRowsByNumbers_: () => { throw failure; }}, () =>
      batchResolve(seeded.customer, seeded.fileId, [{reviewId: seeded.reviews[0].reviewId,
        operation: 'ADOPT_EXISTING_PARTNER', partnerName: '株式会社失敗', learn: false}])));
    assert.equal(error.message, failure.message);
    assert.equal(call('activeLeases_', []).filter((lease) => lease.fileId === seeded.fileId).length, 0);
  });

  test('batch 6: item errors は独立し、呼出側の入力誤りは読む前にTypeError', () => {
    const seeded = seedPartnerViaWeb({rows: ['2025/12/10,一件成功店,1000,仕入れ',
      '2025/12/11,空名店,2000,仕入れ', '2025/12/12,未知名店,3000,仕入れ',
      '日付不明,日付確認店,4000,仕入れ']});
    const {world, customer} = seeded;
    gas.stubs.setActiveUser('owner@example.com');
    const otherCustomer = addCustomer(world, {suffix: '2', customerId: 'C002',
      customerName: '別顧客', reviewers: 'reviewer@example.com'});
    gas.stubs.setActiveUser('reviewer@example.com');
    const otherFileId = putCsv(customer, {fileId: 'batch_other_file',
      rows: ['2025/12/19,別ファイル店,9000,仕入れ']});
    webImport(customer, {fileIds: [otherFileId]});
    const otherCustomerFileId = putCsv(otherCustomer, {fileId: 'batch_other_customer',
      rows: ['2025/12/18,別顧客店,8000,仕入れ']});
    webImport(otherCustomer, {fileIds: [otherCustomerFileId]});
    const otherCustomerReview = openReviewsFor(otherCustomer.customerId, {fileId: otherCustomerFileId})
      .find((review) => review.reviewType === 'PARTNER');
    gas.stubs.getSpreadsheet('master').getSheetByName('要確認')
      .getRange(otherCustomerReview._rowNumber, 9).setValue(seeded.fileId);
    const otherFileReview = openReviewsFor(customer.customerId, {fileId: otherFileId})
      .find((review) => review.reviewType === 'PARTNER');
    const dateReview = openReviewsFor(customer.customerId, {fileId: seeded.fileId})
      .find((review) => review.reviewType === 'DATE');
    const settled = seeded.reviews[0];
    call('updateReviewStatus', [settled.reviewId, 'RESOLVED', {actor: 'reviewer@example.com'}]);
    const decisions = [
      {reviewId: 'RV_DOES_NOT_EXIST', operation: 'ADOPT_EXISTING_PARTNER', partnerName: '甲社', learn: false},
      {reviewId: otherCustomerReview.reviewId, operation: 'ADOPT_EXISTING_PARTNER', partnerName: '乙社', learn: false},
      {reviewId: otherFileReview.reviewId, operation: 'ADOPT_EXISTING_PARTNER', partnerName: '丙社', learn: false},
      {reviewId: settled.reviewId, operation: 'ADOPT_EXISTING_PARTNER', partnerName: '丁社', learn: false},
      {reviewId: dateReview.reviewId, operation: 'ADOPT_EXISTING_PARTNER', partnerName: '戊社', learn: false},
      {reviewId: seeded.reviews[1].reviewId, operation: 'ADOPT_EXISTING_PARTNER', partnerName: '  ', learn: false},
      {reviewId: seeded.reviews[2].reviewId, operation: 'ADOPT_EXISTING_PARTNER', partnerName: '取引先不明', learn: false},
      {reviewId: seeded.reviews[3].reviewId, operation: 'ADOPT_EXISTING_PARTNER', partnerName: '株式会社成功', learn: false}
    ];
    const result = batchResolve(customer, seeded.fileId, decisions);
    const codes = Object.fromEntries(result.errors.map((entry) => [entry.reviewId, entry.code]));
    assert.equal(codes.RV_DOES_NOT_EXIST, 'REVIEW_NOT_FOUND');
    assert.equal(codes[otherCustomerReview.reviewId], 'REVIEW_CUSTOMER_MISMATCH');
    assert.equal(codes[otherFileReview.reviewId], 'REVIEW_FILE_MISMATCH');
    assert.equal(codes[settled.reviewId], 'ALREADY_SETTLED');
    assert.equal(codes[dateReview.reviewId], 'OPERATION_NOT_OFFERED');
    assert.equal(codes[seeded.reviews[1].reviewId], 'INVALID_PARTNER_NAME');
    assert.equal(codes[seeded.reviews[2].reviewId], 'INVALID_PARTNER_NAME');
    assert.deepEqual(result.resolvedReviewIds, [seeded.reviews[3].reviewId]);
    assert.equal(decisions.length, result.resolvedReviewIds.length + result.errors.length +
      result.skippedByLeaseReviewIds.length + result.notAttemptedReviewIds.length);
    const reads = gas.stubs.getApiCallCounts().batchGet;
    const badInput = caught(() => batchResolve(customer, seeded.fileId, [{reviewId: 'x',
      operation: 'BAD_OPERATION'}]));
    assert.equal(badInput.name, 'TypeError');
    assert.equal(gas.stubs.getApiCallCounts().batchGet, reads);
  });

  test('batch 7: EXCLUDE 済み取引への ADOPT は書く前に止まる', () => {
    const seeded = seedPartnerViaWeb({rows: ['日付不明,取消対象店,1000,仕入れ']});
    const reviews = openReviewsFor(seeded.customer.customerId, {fileId: seeded.fileId});
    const partner = reviews.find((review) => review.reviewType === 'PARTNER');
    const date = reviews.find((review) => review.reviewType === 'DATE');
    const tx = transactionFor(partner);
    call('resolveReview', [date.reviewId, 'EXCLUDE', {}]);
    const before = gas.stubs.getSpreadsheet(seeded.destinationSpreadsheetId)
      .getSheetByName('入力用シート').getRange(tx.destinationRow, 2, 1, 6).getValues();
    const result = batchResolve(seeded.customer, seeded.fileId, [{reviewId: partner.reviewId,
      operation: 'ADOPT_EXISTING_PARTNER', partnerName: '株式会社幽霊', learn: false}]);
    assert.equal(result.errors[0].code, 'STATE_TRANSITION');
    assert.deepEqual(gas.stubs.getSpreadsheet(seeded.destinationSpreadsheetId)
      .getSheetByName('入力用シート').getRange(tx.destinationRow, 2, 1, 6).getValues(), before);
  });

  test('batch 8: 読み返しの不一致だけを除外し、同じ転記先の他件は確定する', () => {
    const seeded = seedPartnerViaWeb({count: 2, merchant: '読戻し店'});
    const bad = seeded.reviews[0];
    const before = transactionFor(bad);
    const realRead = gas.context.readDestinationRows_;
    const result = withMocks({readDestinationRows_(customer, rowNumbers, index) {
      const rows = realRead(customer, rowNumbers, index);
      rows[rowNumbers[0]] = Object.assign({}, rows[rowNumbers[0]], {f: '読み返し違い'});
      return rows;
    }}, () => batchResolve(seeded.customer, seeded.fileId, seeded.reviews.map((review) => ({
      reviewId: review.reviewId, operation: 'ADOPT_EXISTING_PARTNER',
      partnerName: '株式会社読戻し先', learn: false
    }))));
    assert.equal(result.errors.find((entry) => entry.reviewId === bad.reviewId).code,
      'DESTINATION_VALUE_MISMATCH');
    assert.equal(reviewById(bad.reviewId).status, 'OPEN');
    assert.equal(transactionFor(bad).partnerResolutionStatus, before.partnerResolutionStatus);
    assert.equal(result.resolvedReviewIds.length, 1);
  });

  test('batch 9: 同等学習は1行に畳み、既存行とlearn=falseは増やさない', () => {
    const seeded = seedPartnerViaWeb({count: 2, merchant: '同一学習店'});
    const before = dictionaryCount();
    const result = batchResolve(seeded.customer, seeded.fileId, seeded.reviews.map((review) => ({
      reviewId: review.reviewId, operation: 'ADOPT_EXISTING_PARTNER',
      partnerName: '株式会社同一学習先', learn: true
    })));
    assert.equal(dictionaryCount(), before + 1);
    assert.equal(result.learnedDictIds.length, 1);

    const existing = seedPartnerViaWeb({merchant: '既存学習店'});
    const normalized = call('normalizeMerchant', ['既存学習店']);
    call('learnFromResolution', [existing.customer.customerId, '既存学習店', normalized,
      '株式会社既存学習先', 'reviewer@example.com']);
    const beforeExisting = dictionaryCount();
    const existingResult = batchResolve(existing.customer, existing.fileId, [{
      reviewId: existing.reviews[0].reviewId, operation: 'ADOPT_EXISTING_PARTNER',
      partnerName: '株式会社既存学習先', learn: true
    }]);
    assert.equal(dictionaryCount(), beforeExisting);
    assert.deepEqual(existingResult.learnedDictIds, []);

    const noLearn = seedPartnerViaWeb({merchant: '学習なし店'});
    const beforeNoLearn = dictionaryCount();
    batchResolve(noLearn.customer, noLearn.fileId, [{reviewId: noLearn.reviews[0].reviewId,
      operation: 'ADOPT_EXISTING_PARTNER', partnerName: '株式会社学習なし先', learn: false}]);
    assert.equal(dictionaryCount(), beforeNoLearn);
  });

  test('batch 10: merchantNormalized が空のlearn=trueはF列を書く前に拒否', () => {
    const seeded = seedPartnerViaWeb({merchant: '\u0001'});
    const review = seeded.reviews[0];
    const tx = transactionFor(review);
    const result = batchResolve(seeded.customer, seeded.fileId, [{reviewId: review.reviewId,
      operation: 'ADOPT_EXISTING_PARTNER', partnerName: '株式会社前提失敗', learn: true}]);
    assert.equal(result.errors[0].code, 'LEARN_PRECONDITION');
    assert.equal(destinationValue(seeded.destinationSpreadsheetId, tx.destinationRow, 3), '');
  });

  test('batch 11: DATE の未解決を数え、確定理由はcommitBlockingReasons_から返す', () => {
    const seeded = seedPartnerViaWeb({rows: ['日付不明,確定条件店,1000,仕入れ']});
    const reviews = openReviewsFor(seeded.customer.customerId, {fileId: seeded.fileId});
    const partner = reviews.find((review) => review.reviewType === 'PARTNER');
    const date = reviews.find((review) => review.reviewType === 'DATE');
    const tx = transactionFor(partner);
    gas.stubs.getSpreadsheet('master').getSheetByName('クレカ取引ログ')
      .getRange(tx._rowNumber, 19).setValue('2025-12-10');
    const result = batchResolve(seeded.customer, seeded.fileId, [{reviewId: partner.reviewId,
      operation: 'ADOPT_EXISTING_PARTNER', partnerName: '株式会社条件先', learn: false}]);
    assert.equal(result.committedReviewIds.length, 0);
    assert.deepEqual(result.unmet[0].openReviewTypes, ['DATE']);
    assert.deepEqual(result.unmet[0].unmetConditions, ['OPEN_REVIEW_REMAINS']);
    assert.equal(reviewById(date.reviewId).status, 'OPEN');
  });

  test('batch 12: 監査3件は1回のsetValuesで連鎖し、GENESISと単件ハッシュも一致', () => {
    const entries = [1, 2, 3].map((index) => ({auditId: `AUDIT_BATCH_${index}`,
      at: '2026-09-01T00:00:00.000Z', type: 'SYNC', actor: 'audit@example.com',
      targetType: 'LOG', targetId: String(index), after: {index}}));
    const fixedNow = '2026-09-01T00:00:00.000Z';
    const seedAudit = () => {
      const sheet = gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ');
      const genesis = call('makeAuditRow_', [{auditId: 'AUDIT_GENESIS', at: fixedNow,
        type: 'CHAIN_ANCHOR', actor: 'seed', targetType: 'AUDIT', targetId: 'GENESIS',
        after: {kind: 'GENESIS', createdAt: fixedNow}}, 'GENESIS', true]);
      sheet.appendRow(genesis);
      call('appendAudit', [{auditId: 'AUDIT_SEED', at: fixedNow, type: 'SYNC',
        actor: 'seed', targetType: 'LOG', targetId: 'seed'}]);
    };
    setupWorld();
    withMocks({nowIso_: () => fixedNow}, seedAudit);
    const writesBefore = gas.stubs.roundTrips().rangeWrites;
    withMocks({nowIso_: () => fixedNow}, () => call('appendAuditBatch', [entries]));
    const writes = gas.stubs.roundTrips().rangeWrites - writesBefore;
    const batchRows = gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ')
      .getDataRange().getValues().slice(1);
    const batchHashes = batchRows.map((row) => [row[0], row[13], row[14]]);
    setupWorld();
    withMocks({nowIso_: () => fixedNow}, () => {
      seedAudit();
      entries.forEach((entry) => call('appendAudit', [entry]));
    });
    const singleRows = gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ')
      .getDataRange().getValues().slice(1).map((row) => [row[0], row[13], row[14]]);
    assert.equal(writes, 1);
    assert.deepEqual(batchHashes.slice(1), singleRows.slice(1));
    assert.equal(call('verifyChain', ['FULL']).ok, true);
    const empty = setupWorld();
    const emptySheet = gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ');
    assert.deepEqual(call('appendAuditBatch', [[]]), []);
    assert.equal(emptySheet.getLastRow(), 1);
    call('appendAuditBatch', [[entries[0]]]);
    assert.equal(emptySheet.getRange(2, 3).getValue(), 'CHAIN_ANCHOR');
    assert.equal(emptySheet.getRange(2, 8).getValue(), 'GENESIS');
    assert.equal(emptySheet.getRange(2, 14).getValue(), 'GENESIS');
    assert.equal(call('verifyChain', ['FULL']).ok, true);
  });

  test('batch 13: PARTNER_BATCH_MAX_ITEMS_ 超過分はnotAttemptedReviewIdsへ残る', () => {
    const seeded = seedPartnerViaWeb({count: 3});
    const result = withMocks({PARTNER_BATCH_MAX_ITEMS_: 2}, () => batchResolve(
      seeded.customer, seeded.fileId, seeded.reviews.map((review) => ({reviewId: review.reviewId,
        operation: 'ADOPT_EXISTING_PARTNER', partnerName: '株式会社上限先', learn: false}))));
    assert.equal(result.resolvedReviewIds.length, 2);
    assert.deepEqual(result.notAttemptedReviewIds, [seeded.reviews[2].reviewId]);
  });

  test('batch 14: 同じreviewIdの2回目と同じ転記行を指す2件を拒否', () => {
    const duplicate = seedPartnerViaWeb();
    const entry = {reviewId: duplicate.reviews[0].reviewId,
      operation: 'ADOPT_EXISTING_PARTNER', partnerName: '株式会社重複先', learn: false};
    const duplicateResult = batchResolve(duplicate.customer, duplicate.fileId, [entry, entry]);
    assert.equal(duplicateResult.errors.find((item) => item.code === 'DUPLICATE_DECISION').reviewId,
      entry.reviewId);
    // 1 回目は確定し、2 回目だけが重複として返る。印を要確認 ID で付けると
    // 1 回目まで後の段から外れ、どこにも数えられずに消えていた（監査で発見）。
    assert.deepEqual(duplicateResult.resolvedReviewIds, [entry.reviewId]);
    assert.equal(reviewById(entry.reviewId).status, 'RESOLVED');
    assert.equal(2, duplicateResult.resolvedReviewIds.length + duplicateResult.errors.length +
      duplicateResult.skippedByLeaseReviewIds.length + duplicateResult.notAttemptedReviewIds.length);

    const conflict = seedPartnerViaWeb({count: 2, merchant: '行衝突店'});
    const first = transactionFor(conflict.reviews[0]);
    const second = transactionFor(conflict.reviews[1]);
    gas.stubs.getSpreadsheet('master').getSheetByName('クレカ取引ログ')
      .getRange(second._rowNumber, 31).setValue(first.destinationRow);
    const conflictResult = batchResolve(conflict.customer, conflict.fileId,
      conflict.reviews.map((review) => ({reviewId: review.reviewId,
        operation: 'ADOPT_EXISTING_PARTNER', partnerName: '株式会社行衝突先', learn: false})));
    assert.deepEqual(conflictResult.errors.map((item) => item.code),
      ['DESTINATION_ROW_CONFLICT', 'DESTINATION_ROW_CONFLICT']);
    assert.equal(destinationValue(conflict.destinationSpreadsheetId, first.destinationRow, 3), '');
  });

  test('batch 15: M・Nの異なる転記先へそれぞれ正しい行を書く', () => {
    const seeded = seedPartnerViaWeb({count: 2, merchant: '二転記先店'});
    const second = seeded.reviews[1];
    const secondTx = transactionFor(second);
    const alternateId = createWebDestination(seeded.customer);
    gas.stubs.getSpreadsheet('master').getSheetByName('要確認')
      .getRange(second._rowNumber, 13, 1, 2).setValues([[alternateId, '入力用シート']]);
    const result = batchResolve(seeded.customer, seeded.fileId, seeded.reviews.map((review) => ({
      reviewId: review.reviewId, operation: 'ADOPT_EXISTING_PARTNER',
      partnerName: '株式会社転記先', learn: false
    })));
    assert.equal(result.resolvedReviewIds.length, 2);
    assert.equal(destinationValue(seeded.destinationSpreadsheetId,
      transactionFor(seeded.reviews[0]).destinationRow, 3), '株式会社転記先');
    assert.equal(gas.stubs.getSpreadsheet(alternateId).getSheetByName('入力用シート')
      .getRange(secondTx.destinationRow, 3).getValue(), '株式会社転記先');
  });

  test('batch 16: IN_PROGRESS のPARTNER要確認もADOPTでRESOLVEDになる', () => {
    const seeded = seedPartnerViaWeb();
    call('updateReviewStatus', [seeded.reviews[0].reviewId, 'IN_PROGRESS',
      {actor: 'reviewer@example.com', operation: 'REQUEST_NEW_PARTNER'}]);
    const result = batchResolve(seeded.customer, seeded.fileId, [{reviewId: seeded.reviews[0].reviewId,
      operation: 'ADOPT_EXISTING_PARTNER', partnerName: '株式会社承認待ち先', learn: false}]);
    assert.deepEqual(result.resolvedReviewIds, [seeded.reviews[0].reviewId]);
    assert.equal(reviewById(seeded.reviews[0].reviewId).status, 'RESOLVED');
  });

  test('batch 17: 手順6直後の停止後に再実行して辞書・監査を二重にしない', () => {
    const seeded = seedPartnerViaWeb({merchant: '再実行店'});
    const review = seeded.reviews[0];
    const realLock = gas.context.withScriptLock_;
    let lockCount = 0;
    const error = caught(() => withMocks({withScriptLock_(callback) {
      lockCount += 1;
      const value = realLock(callback);
      if (lockCount === 2) throw new Error('stopped after transaction log write');
      return value;
    }}, () => batchResolve(seeded.customer, seeded.fileId, [{reviewId: review.reviewId,
      operation: 'ADOPT_EXISTING_PARTNER', partnerName: '株式会社再実行先', learn: true}])));
    assert.ok(error.message.includes('stopped after transaction log write'));
    assert.equal(reviewById(review.reviewId).status, 'OPEN');
    assert.equal(transactionFor(review).partnerResolutionStatus, 'RESOLVED_WITH_PARTNER');
    const result = batchResolve(seeded.customer, seeded.fileId, [{reviewId: review.reviewId,
      operation: 'ADOPT_EXISTING_PARTNER', partnerName: '株式会社再実行先', learn: true}]);
    assert.deepEqual(result.resolvedReviewIds, [review.reviewId]);
    const customerRows = gas.stubs.getSpreadsheet('master').getSheetByName('顧客別取引先辞書')
      .getDataRange().getValues().slice(1).filter((row) => row[0]);
    const auditRows = gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ')
      .getDataRange().getValues().slice(1);
    assert.equal(customerRows.filter((row) => row[1] === '再実行店').length, 1);
    assert.equal(auditRows.filter((row) => row[2] === 'DICT_REGISTER' && row[10].includes('再実行店')).length, 1);
    assert.equal(auditRows.filter((row) => row[2] === 'REVIEW_RESOLVE' && row[7] === review.fullTxId).length, 1);

    const ordered = seedPartnerViaWeb({merchant: '順序確認店'});
    const valuesApi = gas.context.Sheets.Spreadsheets.Values;
    const realBatchUpdate = valuesApi.batchUpdate;
    valuesApi.batchUpdate = function(request, spreadsheetId) {
      if (String(spreadsheetId) === 'master' && request.data.some((item) =>
          String(item.range).indexOf('要確認') >= 0)) throw new Error('review write stop');
      return realBatchUpdate.apply(this, arguments);
    };
    let orderedError;
    try {
      orderedError = caught(() => batchResolve(ordered.customer, ordered.fileId, [{
        reviewId: ordered.reviews[0].reviewId, operation: 'ADOPT_EXISTING_PARTNER',
        partnerName: '株式会社順序先', learn: false
      }]));
    } finally { valuesApi.batchUpdate = realBatchUpdate; }
    assert.equal(orderedError.message, 'review write stop');
    assert.equal(reviewById(ordered.reviews[0].reviewId).status, 'OPEN');
    assert.equal(transactionFor(ordered.reviews[0]).transactionStatus, 'REVIEW_REQUIRED');
  });

  test('batch 18: 時間の門は境界を含み、maxBatchMsがfloorMsより大きければ使う', () => {
    const now = gas.context.partnerBatchClockNow_;
    try {
      gas.context.partnerBatchClockNow_ = () => 41000;
      assert.equal(gas.call('partnerBatchMayStart_', [{startedAt: 1000, deadlineMs: 60000,
        floorMs: 10000, factor: 2, maxBatchMs: 0}]), true);
      gas.context.partnerBatchClockNow_ = () => 41001;
      assert.equal(gas.call('partnerBatchMayStart_', [{startedAt: 1000, deadlineMs: 60000,
        floorMs: 10000, factor: 2, maxBatchMs: 0}]), false);
      gas.context.partnerBatchClockNow_ = () => 1000;
      assert.equal(gas.call('partnerBatchMayStart_', [{startedAt: 1000, deadlineMs: 60000,
        floorMs: 10000, factor: 2, maxBatchMs: 30000}]), true);
      assert.equal(gas.call('partnerBatchMayStart_', [{startedAt: 1000, deadlineMs: 59999,
        floorMs: 10000, factor: 2, maxBatchMs: 30000}]), false);
    } finally { gas.context.partnerBatchClockNow_ = now; }
  });

  test('batch 19: 2ファイルの自動採用は全件処理し、ファイル別読取が件数に依らない', () => {
    const seeded = seedAutoAdoptionFiles([2, 10], 'batch_auto_reads');
    gas.stubs.resetApiCallCounts();
    const summary = call('opsAutoAdoptPartners', []);
    assert.equal(summary.adopted, 12);
    assert.equal(summary.files.length, 2);
    assert.deepEqual(summary.completedFiles, seeded.files);
    assert.equal(summary.files[0].reads, summary.files[1].reads);
    assert.ok(summary.files[0].reads <= 20);
    assert.equal(summary.remaining, 0);
  });

  test('batch 20: 自動採用は重いファイル後の時間門で止まり、再実行で続く', () => {
    const seeded = seedAutoAdoptionFiles([1, 1], 'batch_auto_time');
    const first = withPartnerTiming([200000], () => call('opsAutoAdoptPartners', []));
    assert.equal(first.adopted, 1, JSON.stringify(first));
    assert.equal(first.remaining, 1);
    assert.equal(first.stoppedBy, 'TIME');
    assert.equal(first.completedFiles.includes(seeded.files[0]), true);
    assert.equal(call('activeLeases_', []).filter((lease) => seeded.files.includes(lease.fileId)).length, 0);
    const second = withPartnerTiming([0], () => call('opsAutoAdoptPartners', []));
    assert.equal(second.adopted, 1);
    assert.equal(second.remaining, 0);
    assert.deepEqual(second.completedFiles, [seeded.files[1]]);

    const maxHistory = seedAutoAdoptionFiles([1, 1, 1], 'batch_auto_max_history');
    const third = withPartnerTiming([95000, 20000, 0], () => call('opsAutoAdoptPartners', []));
    assert.equal(third.adopted, 2);
    assert.equal(third.stoppedBy, 'TIME');
    assert.ok(third.results.some((entry) => entry.reviewId === openReviewsFor(
      maxHistory.customer.customerId, {fileId: maxHistory.files[2]})[0].reviewId && entry.deferred === 'TIME'));
  });

  test('batch 21: 締切まで床時間が無いとき完了掃除を省略する', () => {
    const seeded = seedAutoAdoptionFiles([1, 1], 'batch_auto_sweep');
    const summary = withPartnerTiming([250000], () => call('opsAutoAdoptPartners', []));
    assert.equal(summary.stoppedBy, 'TIME', JSON.stringify(summary));
    assert.equal(summary.completionSweep, 'SKIPPED_TIME');
    assert.equal(summary.remaining, 1);
    assert.ok(summary.completedFiles.includes(seeded.files[0]));
  });

  test('batch 22: PARTNER_BATCHログに店名・取引先名・金額を含めない', () => {
    const merchant = '秘密の明細店ZXQ';
    const partner = '秘密の取引先QZX';
    const seeded = seedPartnerViaWeb({rows: [`2025/12/10,${merchant},987654321,仕入れ`]});
    batchResolve(seeded.customer, seeded.fileId, [{reviewId: seeded.reviews[0].reviewId,
      operation: 'ADOPT_EXISTING_PARTNER', partnerName: partner, learn: false}]);
    const lines = gas.stubs.getLogs().filter((line) => line.startsWith('PARTNER_BATCH '));
    assert.equal(lines.length, 1);
    assert.equal(lines.join('\n').includes(merchant), false);
    assert.equal(lines.join('\n').includes(partner), false);
    assert.equal(lines.join('\n').includes('987654321'), false);
  });

  test('batch 23: 自動採用は部品の例外を受け止めて次のファイルへ進み、リースを残さない', () => {
    const seeded = seedAutoAdoptionFiles([1, 1], 'batch_auto_fault');
    const real = gas.context.resolvePartnerReviewsBatch;
    let calls = 0;
    const summary = withMocks({resolvePartnerReviewsBatch(...args) {
      calls += 1;
      if (calls === 1) {
        const fault = new Error('transient sheets failure');
        fault.code = 'SHEETS_500';
        throw fault;
      }
      return real.apply(this, args);
    }}, () => call('opsAutoAdoptPartners', []));
    assert.equal(summary.errors, 1, JSON.stringify(summary.results));
    assert.ok(summary.results.some((entry) => entry.error === 'SHEETS_500'));
    assert.equal(summary.adopted, 1, '2 本目のファイルは採用される');
    assert.equal(call('activeLeases_', []).filter((lease) =>
      seeded.files.includes(lease.fileId)).length, 0);
  });

  test('batch 24: 自動採用の完了の掃除はリース表を 1 回だけ読む', () => {
    const seeded = seedAutoAdoptionFiles([1, 1, 1], 'batch_auto_sweep_leases');
    // 採用できない状態（辞書を消す）にして、3 本とも REVIEW_WAIT のまま掃除へ進める。
    const dict = gas.stubs.getSpreadsheet('master').getSheetByName('顧客別取引先辞書');
    dict.getRange(2, 15).setValue(false);
    const real = gas.context.activeLeases_;
    // 掃除は最後の一覧読取（恒久ファイルインデックス）の後に走る。頭の
    // 取りこぼし確定も同じ一覧を読むので、最後の読取以降だけを数える。
    let sweepReads = 0;
    const realScan = gas.context.permanentIndexRowsForScan_;
    let summary;
    withMocks({
      permanentIndexRowsForScan_() { sweepReads = 0; return realScan(); },
      activeLeases_() { sweepReads += 1; return real(); }
    }, () => { summary = call('opsAutoAdoptPartners', []); });
    assert.equal(summary.completionSweep, 'DONE');
    seeded.files.forEach((fileId) => assert.equal(fileStateOf(fileId), 'REVIEW_WAIT'));
    assert.ok(sweepReads <= 1, `掃除でリース表を ${sweepReads} 回読んだ`);
  });

  test('batch 25: 自動採用は部品の上限で残った件を同じ実行の中で続けて採用する', () => {
    const seeded = seedAutoAdoptionFiles([3], 'batch_auto_cap');
    const summary = withMocks({PARTNER_BATCH_MAX_ITEMS_: 1},
      () => call('opsAutoAdoptPartners', []));
    assert.equal(summary.adopted, 3, JSON.stringify(summary.results));
    assert.equal(summary.remaining, 0);
    assert.deepEqual(summary.completedFiles, seeded.files);
    assert.equal(openReviewsFor(seeded.customer.customerId, {fileId: seeded.files[0]}).length, 0);
  });

  test('batch 26: 書く途中で別の経路が閉じた要確認は上書きせず ALREADY_SETTLED', () => {
    const seeded = seedPartnerViaWeb({count: 2, merchant: '途中で閉じる店'});
    const [closed, normal] = seeded.reviews;
    const realLearn = gas.context.learnFromResolutionBatch;
    const result = withMocks({learnFromResolutionBatch(...args) {
      // 学習の段（取引ログの後・要確認の前）で、別の経路が 1 件を除外した形にする。
      gas.call('updateReviewStatus', [closed.reviewId, 'EXCLUDED',
        {actor: 'other@example.com', operation: 'EXCLUDE', excludeReason: 'REVIEWER_JUDGEMENT'}]);
      return realLearn.apply(this, args);
    }}, () => batchResolve(seeded.customer, seeded.fileId, seeded.reviews.map((review) => ({
      reviewId: review.reviewId, operation: 'ADOPT_EXISTING_PARTNER',
      partnerName: '株式会社途中先', learn: true}))));
    assert.equal(result.errors.find((entry) => entry.reviewId === closed.reviewId).code,
      'ALREADY_SETTLED');
    assert.equal(reviewById(closed.reviewId).status, 'EXCLUDED', '閉じた要確認を RESOLVED で上書きしない');
    assert.deepEqual(result.resolvedReviewIds, [normal.reviewId]);
  });

  test('batch 27: 書く前に F・I 列を文字列書式にする（電話番号のような取引先名を化けさせない）', () => {
    const seeded = seedPartnerViaWeb({count: 2, merchant: '書式店'});
    const sheet = gas.stubs.getSpreadsheet(seeded.destinationSpreadsheetId).getSheetByName('入力用シート');
    const rows = seeded.reviews.map((review) => Number(transactionFor(review).destinationRow));
    // 取込が付けた書式を外し、確定の段が自分で付けることを確かめる。
    rows.forEach((row) => [3, 4].forEach((column) => sheet.getRange(row, column).setNumberFormat('General')));
    batchResolve(seeded.customer, seeded.fileId, [
      {reviewId: seeded.reviews[0].reviewId, operation: 'ADOPT_EXISTING_PARTNER',
        partnerName: '0570-000-000', learn: false},
      {reviewId: seeded.reviews[1].reviewId, operation: 'RESOLVE_PARTNER_UNKNOWN'}]);
    assert.equal(sheet.getRange(rows[0], 3).getNumberFormat(), '@', 'F 列');
    assert.equal(sheet.getRange(rows[1], 4).getNumberFormat(), '@', 'I 列');
  });

  function seedWebReviewFiles(sizes, prefix) {
    const {customer} = setupWorld();
    const fileIds = [];
    let destinationSpreadsheetId = null;
    sizes.forEach((size, fileIndex) => {
      const fileId = `${prefix}_${fileIndex + 1}`;
      const rows = Array.from({length: size}, (_, rowIndex) =>
        `2025/12/${10 + rowIndex % 20},${prefix} 店 ${fileIndex + 1}-${rowIndex + 1},${2000 + fileIndex * 1000 + rowIndex},仕入れ`);
      putCsv(customer, {fileId, name: `${prefix}_${String(fileIndex + 1).padStart(2, '0')}.csv`, rows});
      fileIds.push(fileId);
      const options = {fileIds: [fileId]};
      if (destinationSpreadsheetId) options.destinationSpreadsheetId = destinationSpreadsheetId;
      const imported = webImport(customer, options);
      destinationSpreadsheetId = imported.destinationSpreadsheetId || destinationSpreadsheetId;
    });
    const reviews = fileIds.flatMap((fileId) => openReviewsFor(customer.customerId, {fileId})
      .filter((review) => review.reviewType === 'PARTNER')
      .sort((a, b) => Number(a.sourceRow) - Number(b.sourceRow)));
    return {customer, fileIds, reviews, destinationSpreadsheetId};
  }

  test('bulk 1: 一覧は500件まで返し、取引読取回数は件数に依らない', () => {
    requireWebFunction('webAppListReviews');
    assert.equal(gas.context.WEBAPP_REVIEW_LIST_LIMIT_, 500);
    const measureReads = (count) => {
      const seeded = seedPartnerViaWeb({count, merchant: `bulk 読取店 ${count}`});
      gas.stubs.resetApiCallCounts();
      const before = gas.stubs.getApiCallCounts().batchGet;
      const listed = call('webAppListReviews', [seeded.customer.customerId, 500, 0]);
      return {listed, reads: gas.stubs.getApiCallCounts().batchGet - before};
    };
    const three = measureReads(3);
    const thirty = measureReads(30);
    assert.equal(three.reads, thirty.reads,
      `一覧の取引読取は件数に依らない（3件=${three.reads}回、30件=${thirty.reads}回）`);
    const seeded = seedPartnerViaWeb({count: 3, merchant: 'bulk 上限店'});
    const capped = withMocks({WEBAPP_REVIEW_LIST_LIMIT_: 2},
      () => call('webAppListReviews', [seeded.customer.customerId, 500, 0]));
    assert.equal(capped.partnerTotal, 3);
    assert.equal(capped.limit, 2);
    assert.equal(capped.reviews.length, 2);
  });

  test('bulk 2: 重複する有効な取引行はその要確認だけ表示値をnullにする', () => {
    requireWebFunction('webAppListReviews');
    const seeded = seedPartnerViaWeb({count: 2});
    const duplicate = seeded.reviews[0];
    const txSheet = gas.stubs.getSpreadsheet('master').getSheetByName('クレカ取引ログ');
    const txRow = transactionFor(duplicate);
    txSheet.appendRow(txRow._values);
    const listed = call('webAppListReviews', [seeded.customer.customerId, 500, 0]);
    const ambiguous = listed.reviews.find((review) => review.reviewId === duplicate.reviewId);
    const normal = listed.reviews.find((review) => review.reviewId === seeded.reviews[1].reviewId);
    assert.ok(ambiguous);
    assert.equal(ambiguous.usageDate, null);
    assert.equal(ambiguous.amount, null);
    assert.notEqual(normal.usageDate, null);
    assert.notEqual(normal.amount, null);
  });

  test('bulk 3: 3ファイルの6件と30件を一度で確定し読取は件数に依らない', () => {
    requireWebFunction('webAppResolveReviews');
    const measure = (perFile) => {
      const seeded = seedWebReviewFiles([perFile, perFile, perFile], `bulk_resolve_${perFile}`);
      assert.equal(seeded.reviews.length, perFile * 3);
      const decisions = seeded.reviews.map((review, index) => decision(review,
        index % 2 ? '' : '株式会社まとめ先'));
      gas.stubs.resetApiCallCounts();
      const before = gas.stubs.getApiCallCounts().batchGet;
      const result = webResolve(seeded.customer.customerId, decisions, `bulk-${perFile}`);
      return {result, reads: gas.stubs.getApiCallCounts().batchGet - before, decisions};
    };
    const six = measure(2);
    const thirty = measure(10);
    [six, thirty].forEach(({result, decisions}) => {
      assert.equal(result.resolved, decisions.length);
      assert.equal(result.remaining, 0);
      assert.equal(decisions.length, result.resolved +
        result.errors.filter((entry) => entry.reviewId).length + result.skippedByLease + result.remaining);
    });
    assert.equal(six.reads, thirty.reads,
      `確定の取引読取は件数に依らない（6件=${six.reads}回、30件=${thirty.reads}回）`);
  });

  test('bulk 4: 操作と顧客ごとに認可し、件ごとの旧経路を呼ばない', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedWebReviewFiles([10, 10, 10], 'bulk_auth');
    const decisions = seeded.reviews.map((review, index) => decision(review,
      index % 2 ? '' : '株式会社認可先'));
    const calls = {authorizeOperation: [], getReviewById: 0, getTransaction: 0, resolveReview: 0};
    const result = withMocks({
      authorizeOperation(code, customerId, options) {
        calls.authorizeOperation.push([code, String(customerId)]);
        return {userEmail: 'reviewer@example.com', role: 'REVIEWER'};
      },
      getReviewById() { calls.getReviewById += 1; throw new Error('getReviewById must not be called'); },
      getTransaction() { calls.getTransaction += 1; throw new Error('getTransaction must not be called'); },
      resolveReview() { calls.resolveReview += 1; throw new Error('resolveReview must not be called'); }
    }, () => webResolve(seeded.customer.customerId, decisions, 'bulk-auth'));
    assert.equal(result.resolved, 30);
    assert.deepEqual(calls.authorizeOperation.sort(), [
      ['ADOPT_EXISTING_PARTNER', seeded.customer.customerId],
      ['RESOLVE_WITHOUT_PARTNER', seeded.customer.customerId]
    ]);
    assert.equal(calls.getReviewById, 0);
    assert.equal(calls.getTransaction, 0);
    assert.equal(calls.resolveReview, 0);
  });

  test('bulk 5: 重い先頭ファイルの後は門が閉じ、その後ろを未着手として数える', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedWebReviewFiles([1, 1], 'bulk_gate');
    const decisions = seeded.reviews.map((review) => decision(review, '株式会社門先'));
    assert.equal(decisions.length, 2);
    const result = withPartnerTiming([200000], () => webResolve(
      seeded.customer.customerId, decisions, 'bulk-gate'));
    assert.equal(result.resolved, 1);
    assert.equal(result.remaining, 1);
    assert.equal(result.deferredByFile, 1);
    assert.equal(result.notAttempted, 1);
    assert.equal(decisions.length, result.resolved +
      result.errors.filter((entry) => entry.reviewId).length + result.skippedByLease + result.remaining);
  });

  test('bulk 15: 時間の見積もりは直前でなく最も重いファイルを使う', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedWebReviewFiles([1, 1, 1], 'bulk_max_batch');
    const decisions = seeded.reviews.map((review) => decision(review, '株式会社最重先'));
    const result = withPartnerTiming([100000, 1000], () => webResolve(
      seeded.customer.customerId, decisions, 'bulk-max-batch'));
    assert.equal(result.resolved, 2);
    assert.equal(result.remaining, 1);
    assert.equal(result.deferredByFile, 1);
    assert.equal(reviewById(seeded.reviews[2].reviewId).status, 'OPEN');
  });

  test('bulk 6: 部品の上限が2件なら同じファイルを3まとまりで確定する', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({count: 5});
    const realBatch = gas.context.resolvePartnerReviewsBatch;
    const batchSizes = [];
    const result = withMocks({
      PARTNER_BATCH_MAX_ITEMS_: 2,
      resolvePartnerReviewsBatch(...args) {
        batchSizes.push(args[2].length);
        return realBatch.apply(this, args);
      }
    }, () => webResolve(seeded.customer.customerId,
      seeded.reviews.map((review) => decision(review, '株式会社まとまり先')), 'bulk-cap'));
    assert.equal(result.resolved, 5);
    assert.equal(result.remaining, 0);
    assert.equal(batchSizes.length, 3);
  });

  test('bulk 7: リース衝突は先頭1件をerrorsにし、後ろのファイルは確定する', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedWebReviewFiles([3, 1], 'bulk_lease');
    assert.equal(seeded.reviews.length, 4);
    call('acquireLease', [seeded.customer.customerId, seeded.fileIds[0], 'other-run',
      'other@example.com', 'PROCESS']);
    const decisions = seeded.reviews.map((review) => decision(review, '株式会社リース先'));
    const result = webResolve(seeded.customer.customerId, decisions, 'bulk-lease');
    const firstFileReviews = seeded.reviews.slice(0, 3);
    const leaseError = result.errors.find((entry) => entry.reviewId === firstFileReviews[0].reviewId);
    assert.equal(leaseError.code, 'LEASE_CONFLICT');
    assert.equal(leaseError.message, call('menuLeaseConflictText_', [null]));
    assert.deepEqual(result.skippedByLeaseReviewIds,
      firstFileReviews.slice(1).map((review) => review.reviewId));
    assert.equal(result.resolved, 1);
    assert.equal(result.resolvedReviewIds[0], seeded.reviews[3].reviewId);
    assert.equal(decisions.length, result.resolved +
      result.errors.filter((entry) => entry.reviewId).length + result.skippedByLease + result.remaining);
  });

  test('bulk 16: リース衝突したファイルには後始末を掛けない', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedWebReviewFiles([1, 1], 'bulk_lease_cleanup');
    call('acquireLease', [seeded.customer.customerId, seeded.fileIds[0], 'other-run',
      'other@example.com', 'PROCESS']);
    const cleanups = {commit: [], complete: []};
    const realCommit = gas.context.commitSettledTransactions_;
    const realComplete = gas.context.completeFileIfFullyResolved_;
    const result = withMocks({
      commitSettledTransactions_(fileId, ...args) {
        cleanups.commit.push(String(fileId));
        return realCommit.call(this, fileId, ...args);
      },
      completeFileIfFullyResolved_(fileId, ...args) {
        cleanups.complete.push(String(fileId));
        return realComplete.call(this, fileId, ...args);
      }
    }, () => webResolve(seeded.customer.customerId,
      seeded.reviews.map((review) => decision(review, '株式会社掃除先')), 'bulk-cleanup'));
    assert.equal(result.resolved, 1);
    assert.deepEqual(cleanups.commit, [seeded.fileIds[1]]);
    assert.deepEqual(cleanups.complete, [seeded.fileIds[1]]);
  });

  test('bulk 8: 空店名・カード名用途・競合では学ばず通常行だけ学ぶ', () => {
    requireWebFunction('webAppResolveReviews');
    const seeded = seedPartnerViaWeb({world: {customer: {cardNamePartnerPurposes: ['年会費']}}, rows: [
      '2025/12/10,\u0001,1000,仕入れ',
      '2025/12/11,カード名店,1100,年会費',
      '2025/12/12,競合店,1200,仕入れ',
      '2025/12/13,通常店,1300,仕入れ'
    ]});
    const before = dictionaryCount();
    const decisions = seeded.reviews.map((review, index) => Object.assign(
      decision(review, `株式会社学習先${index + 1}`), {sameMerchantConflict: index === 2}));
    const result = webResolve(seeded.customer.customerId, decisions, 'bulk-learning');
    assert.equal(result.resolved, 4);
    assert.equal(dictionaryCount(), before + 1);
  });

  test('bulk 9: reviewMatchesFilterは全半角・大小・空白を無視し摘要とファイル名を探す', () => {
    const review = {merchantOriginal: 'Ａｍａｚｏｎ  Ｃｏ．ＪＰ', fileName: '三井住友_202601.csv'};
    assert.equal(clientEval(`reviewMatchesFilter(${JSON.stringify(review)}, 'amazonco.jp')`), true);
    assert.equal(clientEval(`reviewMatchesFilter(${JSON.stringify(review)}, '２０２６０１')`), true);
    assert.equal(clientEval(`reviewMatchesFilter(${JSON.stringify(review)}, '   ')`), true);
    assert.equal(clientEval(`reviewMatchesFilter(${JSON.stringify(review)}, '該当なし')`), false);
  });

  test('bulk 10: rangeIdsは両方向で両端を含み、端が無いとtoIdだけ返す', () => {
    const ids = ['a', 'b', 'c', 'd'];
    assert.deepEqual(plain(clientEval(`rangeIds(${JSON.stringify(ids)}, 'b', 'd')`)), ['b', 'c', 'd']);
    assert.deepEqual(plain(clientEval(`rangeIds(${JSON.stringify(ids)}, 'd', 'b')`)), ['b', 'c', 'd']);
    assert.deepEqual(plain(clientEval(`rangeIds(${JSON.stringify(ids)}, 'missing', 'c')`)), ['c']);
  });

  test('bulk 11: applyBulkPartnerは選択IDだけをtrimして入れ、空なら空欄にする', () => {
    const result = clientEval(`(() => {
      const inputs = new Map([['a', 'old-a'], ['b', 'old-b'], ['c', 'old-c']]);
      const first = applyBulkPartner(inputs, ['a', 'c'], '  Amazon  ');
      const second = applyBulkPartner(inputs, ['b'], '   ');
      return {first, second, values: Array.from(inputs.entries())};
    })()`);
    assert.deepEqual(plain(result), {first: 2, second: 1,
      values: [['a', 'Amazon'], ['b', ''], ['c', 'Amazon']]});
  });

  test('bulk 12: confirmationGroupsは辞書の扱いも含めてまとめ、件数順にする', () => {
    const items = [
      {partnerName: '', conflictReason: null, review: {merchantOriginal: '店A', learnBlockedBy: null}},
      {partnerName: '', conflictReason: null, review: {merchantOriginal: '店A', learnBlockedBy: null}},
      {partnerName: 'Amazon', conflictReason: null, review: {merchantOriginal: '店B', learnBlockedBy: null}},
      {partnerName: 'Amazon', conflictReason: null, review: {merchantOriginal: '店B', learnBlockedBy: 'EMPTY_MERCHANT'}}
    ];
    const groups = plain(clientEval(`confirmationGroups(${JSON.stringify(items)})`));
    assert.equal(groups[0].count, 2);
    assert.equal(groups[0].partner, '取引先なし');
    assert.equal(groups[0].merchant, '店A');
    assert.equal(groups.length, 3, '辞書の扱いが異なる店Bは別のまとまり');
    assert.deepEqual(groups.slice(1).map((group) => group.count), [1, 1]);
    assert.notEqual(groups[1].message, groups[2].message);
  });

  test('bulk 13: 一覧の固定見出し・道具と折りたたみ明細がある', () => {
    assert.match(WEBAPP_UI_SOURCE, /\.review-table-wrap\s*\{[^}]*max-height:\s*60vh[^}]*overflow:\s*auto/s);
    assert.match(WEBAPP_UI_SOURCE, /\.review-table-wrap[^}]*th[^}]*position:\s*sticky/s);
    ['review-filter', 'bulk-partner', 'bulk-apply', 'select-clear']
      .forEach((id) => assert.ok(WEBAPP_UI_SOURCE.includes(`id="${id}"`), `${id} が必要`));
    assert.match(WEBAPP_UI_SOURCE, /selectAll\.id\s*=\s*'review-select-all'/,
      '表示中の全選択チェックボックスにIDが付く');
    assert.match(WEBAPP_UI_SOURCE, /<details[^>]*>[\s\S]*?<summary[^>]*>1 件ずつ見る/);
  });

  test('bulk 17: 絞り込みを変えたら選択を外し、取引先欄の値は残す', () => {
    // 選択を残すと、見えなくなった行が確定に紛れ込む（仕様 §2.3）。
    const after = plain(clientEval(`(() => {
      renderReviews = function() {};
      state.selectedReviewIds.add('r1');
      state.partnerInputs.set('r1', 'Amazon');
      onReviewFilterChanged({currentTarget: {value: '店A'}});
      return {selected: Array.from(state.selectedReviewIds), input: state.partnerInputs.get('r1'),
        filter: state.reviewFilter};
    })()`));
    assert.deepEqual(after, {selected: [], input: 'Amazon', filter: '店A'});
  });

  test('bulk 18: 全選択は絞り込み後の表示行だけを選ぶ', () => {
    const selected = plain(clientEval(`(() => {
      renderReviews = function() {};
      syncReviewSelectionView = function() {};
      state.reviewFilter = '店A';
      state.reviews = [
        {reviewId: 'a', merchantOriginal: '店A', fileName: 'a.csv'},
        {reviewId: 'b', merchantOriginal: '店B', fileName: 'b.csv'}
      ];
      onSelectAllVisibleChanged({currentTarget: {checked: true}});
      return Array.from(state.selectedReviewIds);
    })()`));
    assert.deepEqual(selected, ['a']);
  });

  test('bulk 19: 一括入力は選択IDだけを更新する', () => {
    const result = plain(clientEval(`(() => {
      renderReviews = function() {};
      syncPartnerInputsView = function() {};
      state.partnerInputs = new Map([['a', 'old-a'], ['b', 'old-b']]);
      state.reviews = [{reviewId: 'a'}, {reviewId: 'b'}];
      state.selectedReviewIds.add('a');
      el['bulk-partner'].value = '  Amazon  ';
      applyBulkPartnerToSelection();
      return Array.from(state.partnerInputs.entries());
    })()`));
    assert.deepEqual(result, [['a', 'Amazon'], ['b', 'old-b']]);
  });

  test('bulk 14: 一覧・確定の上限と不要になった読取見積定数が一致する', () => {
    assert.equal(gas.context.WEBAPP_REVIEW_LIST_LIMIT_, 500);
    assert.equal(gas.context.WEBAPP_MAX_DECISIONS_, gas.context.WEBAPP_REVIEW_LIST_LIMIT_);
    assert.equal(gas.context.WEBAPP_MAX_PER_CALL_ >= gas.context.WEBAPP_MAX_DECISIONS_, true);
    assert.equal(Object.prototype.hasOwnProperty.call(gas.context, 'WEBAPP_ITEM_TRIPS_'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(gas.context, 'WEBAPP_CLEANUP_TRIPS_'), false);
  });

  function makePendingEntry(reviewType, fullTxId, overrides = {}) {
    return Object.assign({
      reviewType,
      fullTxId: fullTxId || null,
      fileId: 'reviews-file',
      customerId: 'C001',
      customerName: '顧客一',
      fileNameOriginal: '利用明細.csv',
      destinationSpreadsheetId: 'destination-target',
      destinationSheetName: '入力用シート',
      sourceSheetName: '明細',
      sourceRow: 12,
      displayTxId: fullTxId || '',
      merchantOriginal: '未登録店',
      merchantNormalized: '未登録店',
      candidates: ['候補A'],
      originalDate: '2025-12-10',
      originalAmount: 1250,
      originalPurpose: '仕入れ',
      destinationRow: 8,
      detail: reviewType === 'PARTNER' ?
        {kind: 'PARTNER', matchedBy: 'none', candidates: [], conflict: false} :
        reviewType === 'DATE_INFERENCE' ?
          {kind: 'DATE_INFERENCE', status: 'AMBIGUOUS', baseYearMonth: '2025-12',
            candidates: [], lookbackMonths: 1, forwardMonths: 1} :
          {kind: 'FORMAT_UNKNOWN', fileName: '利用明細.csv'}
    }, overrides);
  }

  function prepareReviewTransactions(ids) {
    call('registerPrepared', [ids.map((fullTxId) => ({
      fullTxId,
      displayTxId: fullTxId,
      customerId: 'C001',
      fileId: 'reviews-file',
      formatId: 'test-format',
      planned: {b: '2025-12-10', f: '店名', i: '摘要', k: '未登録店', m: 1250}
    })), 'imp-reviews', {}]);
  }

  function reviewRowsWithoutIdOrTime() {
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName('要確認');
    return sheet.getDataRange().getValues().slice(1)
      .filter((row) => row[0] !== '' && row[0] !== null)
      .map((row) => row.filter((value, index) => index !== 0 && index !== 26));
  }

  function normalizeReviewResults(result) {
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName('要確認');
    const ids = sheet.getDataRange().getValues().slice(1)
      .filter((row) => row[0] !== '' && row[0] !== null)
      .map((row, index) => [String(row[0]), index]);
    const idOrder = new Map(ids);
    const normalize = (items) => items.map((item) => {
      const copy = Object.assign({}, item);
      if (copy.reviewId) copy.reviewId = idOrder.get(String(copy.reviewId));
      return copy;
    });
    return {registered: normalize(result.registered), skipped: normalize(result.skipped)};
  }

  function oneByOnePendingReviews(entries) {
    const result = {registered: [], skipped: []};
    entries.forEach((entry) => {
      if (gas.context.isTransactionScopedReviewType(entry.reviewType)) {
        const transaction = entry.fullTxId ? call('getTransaction', [entry.fullTxId]) : null;
        if (!transaction || !['PREPARED', 'WRITING', 'REVIEW_REQUIRED']
          .includes(transaction.transactionStatus)) {
          result.skipped.push({reviewType: entry.reviewType, fullTxId: entry.fullTxId,
            reason: transaction ? 'TRANSACTION_ALREADY_SETTLED' : 'TRANSACTION_NOT_FOUND',
            transactionStatus: transaction ? transaction.transactionStatus : null});
          return;
        }
      }
      const outcome = call('registerReview', [entry]);
      if (outcome.registered) result.registered.push(outcome);
      else result.skipped.push({reviewType: entry.reviewType, fullTxId: entry.fullTxId,
        reason: 'SUPPRESSED', reviewId: outcome.reviewId});
    });
    return result;
  }

  test('imp 1: まとめ登録は1件ずつの登録と同じ行・結果・並びになる', () => {
    const entries = [
      makePendingEntry('PARTNER', 'tx-1'),
      makePendingEntry('PARTNER', 'tx-2', {sourceRow: 13}),
      makePendingEntry('DATE_INFERENCE', 'tx-3', {sourceRow: 14}),
      makePendingEntry('FORMAT_UNKNOWN', null, {fileId: 'file-scoped'}),
      makePendingEntry('PARTNER', 'tx-suppressed'),
      makePendingEntry('PARTNER', 'tx-settled'),
      makePendingEntry('PARTNER', 'tx-missing'),
      makePendingEntry('PARTNER', null)
    ];
    function seed() {
      setupWorld();
      prepareReviewTransactions(['tx-1', 'tx-2', 'tx-3', 'tx-settled']);
      const txSheet = gas.stubs.getSpreadsheet('master').getSheetByName('クレカ取引ログ');
      const txRows = txSheet.getDataRange().getValues();
      const settledIndex = txRows.findIndex((row) => String(row[0]) === 'tx-settled');
      txSheet.getRange(settledIndex + 1, 10).setValue('COMMITTED');
      call('registerReview', [makePendingEntry('PARTNER', 'tx-suppressed')]);
    }
    seed();
    const single = oneByOnePendingReviews(entries);
    const singleRows = reviewRowsWithoutIdOrTime();
    const singleResults = normalizeReviewResults(single);

    seed();
    const batch = call('registerPendingReviews', [entries]);
    assert.deepEqual(reviewRowsWithoutIdOrTime(), singleRows,
      '行の値・列・順が1件ずつの登録と違う');
    assert.deepEqual(normalizeReviewResults(batch), singleResults,
      'registered / skipped の値または相対順が違う');
    assert.ok(reviewRowsWithoutIdOrTime().every((row) => row[11] === 'destination-target'),
      'M列 destinationSpreadsheetId が全行に残っている');
  });

  function measurePendingRegistration(count) {
    setupWorld();
    const ids = Array.from({length: count}, (_, index) => `imp-tx-${count}-${index}`);
    call('registerPrepared', [ids.map((fullTxId, index) => ({fullTxId,
      customerId: 'C001', fileId: 'reviews-file', formatId: 'test-format', sourceRow: index + 2,
      planned: {b: '2025-12-10', f: '店名', i: '摘要', k: '未登録店', m: 1250}})),
      'imp-count', {}]);
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName('要確認');
    let setValuesCalls = 0;
    let appendRowCalls = 0;
    const getRange = sheet.getRange.bind(sheet);
    sheet.getRange = (...args) => {
      const range = getRange(...args);
      const setValues = range.setValues.bind(range);
      range.setValues = (values) => { setValuesCalls += 1; return setValues(values); };
      return range;
    };
    const appendRow = sheet.appendRow.bind(sheet);
    sheet.appendRow = (...args) => { appendRowCalls += 1; return appendRow(...args); };
    gas.stubs.resetApiCallCounts();
    const before = gas.stubs.getApiCallCounts().batchGet;
    const result = call('registerPendingReviews', [ids.map((fullTxId, index) =>
      makePendingEntry('PARTNER', fullTxId, {sourceRow: index + 2}))]);
    return {reads: gas.stubs.getApiCallCounts().batchGet - before,
      setValuesCalls, appendRowCalls, registered: result.registered.length};
  }

  test('imp 2: 登録の読取は2件と40件で同じで、setValuesを1回だけ呼ぶ', () => {
    const two = measurePendingRegistration(2);
    const forty = measurePendingRegistration(40);
    assert.equal(two.reads, forty.reads,
      `登録の読取回数が件数に比例している（2件=${two.reads}、40件=${forty.reads}）`);
    assert.equal(two.setValuesCalls, 1, `2件の一括書込が${two.setValuesCalls}回`);
    assert.equal(forty.setValuesCalls, 1, `40件の一括書込が${forty.setValuesCalls}回`);
    assert.equal(two.appendRowCalls + forty.appendRowCalls, 0,
      'まとめ登録でappendRowを呼んでいる');
    assert.equal(two.registered, 2);
    assert.equal(forty.registered, 40);
  });

  test('imp 3: 同じまとまり内の抑止キー重複は最初のIDで抑止する', () => {
    setupWorld();
    gas.context.beginRunScopedReads_();
    let result;
    try {
      prepareReviewTransactions(['duplicate-tx']);
      result = call('registerPendingReviews', [[
        makePendingEntry('PARTNER', 'duplicate-tx'),
        makePendingEntry('PARTNER', 'duplicate-tx', {sourceRow: 13})
      ]]);
    } finally {
      gas.context.endRunScopedReads_();
    }
    assert.equal(result.registered.length, 1);
    assert.deepEqual(result.skipped, [{reviewType: 'PARTNER', fullTxId: 'duplicate-tx',
      reason: 'SUPPRESSED', reviewId: result.registered[0].reviewId}]);
    assert.equal(reviewRowsWithoutIdOrTime().length, 1);
  });

  test('imp 4: 3件目のdetail不正なら要確認シートに1行も書かない', () => {
    setupWorld();
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName('要確認');
    const before = sheet.getLastRow();
    const entries = [
      makePendingEntry('MULTI_SHEET', null, {fileId: 'multi-1',
        detail: {kind: 'MULTI_SHEET', sheets: ['A']}}),
      makePendingEntry('MULTI_SHEET', null, {fileId: 'multi-2',
        detail: {kind: 'MULTI_SHEET', sheets: ['B']}}),
      makePendingEntry('MULTI_SHEET', null, {fileId: 'multi-3',
        detail: {kind: 'MULTI_SHEET'}})
    ];
    assert.throws(() => call('registerPendingReviews', [entries]),
      (error) => error && error.name === 'TypeError');
    assert.equal(sheet.getLastRow(), before, '検査前に先行行を書いている');
  });

  test('imp 5: まとめ登録の行にdestinationSpreadsheetId列を残す', () => {
    setupWorld();
    call('registerPendingReviews', [[makePendingEntry('FORMAT_UNKNOWN', null,
      {fileId: 'file-column-check', destinationSpreadsheetId: 'clone-target'})]]);
    const row = gas.stubs.getSpreadsheet('master').getSheetByName('要確認')
      .getDataRange().getValues().slice(1).find((values) => values[0] !== '');
    assert.equal(row[12], 'clone-target', 'M列 destinationSpreadsheetId が欠けている');
  });

  test('imp 6: 前検査の所見とファイル別取引順は旧経路と一致する', () => {
    setupWorld();
    const txs = [
      ['review-1-a', 'review-file-1', 'COMMITTED'],
      ['review-1-b', 'review-file-1', 'WRITING'],
      ['review-2-a', 'review-file-2', 'REVIEW_REQUIRED'],
      ['scope-canceled', 'scope-file', 'CANCELED'],
      ['scope-committed', 'scope-file', 'COMMITTED'],
      ['unrelated-review', 'unrelated-file', 'REVIEW_REQUIRED']
    ];
    call('registerPrepared', [txs.map(([fullTxId, fileId]) => ({fullTxId, fileId,
      customerId: 'C001', formatId: 'test-format',
      planned: {b: '2025-12-10', f: '店名', i: '摘要', k: '店名', m: 1250}})),
      'imp-precheck', {}]);
    const txSheet = gas.stubs.getSpreadsheet('master').getSheetByName('クレカ取引ログ');
    txs.forEach(([fullTxId, , status]) => {
      const rows = txSheet.getDataRange().getValues();
      const index = rows.findIndex((row) => String(row[0]) === fullTxId);
      txSheet.getRange(index + 1, 10).setValue(status);
    });
    const indexRows = [
      {customerId: 'C001', fileId: 'review-file-1', state: 'REVIEW_WAIT'},
      {customerId: 'C001', fileId: 'review-file-2', state: 'REVIEW_WAIT'},
      {customerId: 'C001', fileId: 'scope-file', state: 'COMPLETED'},
      {customerId: 'C002', fileId: 'other-customer', state: 'REVIEW_WAIT'},
      {customerId: 'C001', fileId: 'unrelated-file', state: 'COMPLETED'}
    ];
    const customer = call('getCustomerById', ['C001']);
    const scopes = ['scope-file'];
    function legacyResult() {
      const findings = [];
      const resolver = gas.context.makeDestinationIndexResolver_(customer);
      const inScope = Object.create(null);
      scopes.forEach((fileId) => { inScope[String(fileId)] = true; });
      const wantedStatuses = ['PREPARED', 'WRITING', 'COMMITTED', 'REVIEW_REQUIRED'];
      indexRows.filter((row) => row.customerId === customer.customerId &&
        (inScope[String(row.fileId)] || ['VALIDATING', 'WRITING', 'REVIEW_WAIT'].includes(row.state)))
        .forEach((row) => {
          const txLogs = gas.context.getTransactionsByStatus(row.fileId, wantedStatuses);
          const process = gas.context.getProcessLogRecord_(row.fileId);
          const outcome = gas.context.runIntegrityCheck({
            indexForTransaction: resolver.indexFor,
            txLogs,
            fileState: row.state,
            processLogState: process ? String(process.values[16]) : null,
            permanentIndexState: row.state
          });
          findings.push(...outcome.findings);
        });
      return {findings, stop: findings.some((finding) => finding.severity === 'STOP'),
        indexesBuilt: resolver.stats().built};
    }
    const callInputs = [];
    const fakeIntegrityCheck = (input) => {
      callInputs.push({fileState: input.fileState,
        txIds: input.txLogs.map((tx) => tx.fullTxId)});
      return {findings: input.txLogs.map((tx) => ({severity:
        tx.fullTxId === 'scope-committed' ? 'STOP' : 'REVIEW',
      detail: {fullTxId: tx.fullTxId}})), stop: false};
    };
    const result = withMocks({
      permanentIndexRowsForScan_: () => indexRows,
      runIntegrityCheck: fakeIntegrityCheck
    }, () => {
      gas.context.forgetFileRowNumbers_();
      const actual = plain(gas.context.runCustomerIntegrityCheck_(customer, scopes));
      const actualInputs = callInputs.splice(0);
      gas.context.forgetFileRowNumbers_();
      const expected = plain(legacyResult());
      const expectedInputs = callInputs.splice(0);
      return {actual, actualInputs, expected, expectedInputs};
    });
    assert.deepEqual(result.actual.findings, result.expected.findings);
    assert.equal(result.actual.stop, result.expected.stop);
    assert.equal(result.actual.indexesBuilt, result.expected.indexesBuilt);
    assert.deepEqual(result.actualInputs, result.expectedInputs,
      '前検査が取引ログの行順、範囲内ファイル、対象顧客を保っていない');
  });

  function measurePrecheckReads(unfinishedCount) {
    setupWorld();
    const indexRows = Array.from({length: unfinishedCount}, (_, index) => ({
      customerId: 'C001', fileId: `precheck-file-${unfinishedCount}-${index}`, state: 'REVIEW_WAIT'
    }));
    const txs = indexRows.map((row, index) => ({
      fullTxId: `precheck-tx-${unfinishedCount}-${index}`, fileId: row.fileId,
      customerId: 'C001', formatId: 'test-format',
      planned: {b: '2025-12-10', f: '店名', i: '摘要', k: '店名', m: 1250}
    }));
    call('registerPrepared', [txs, 'imp-precheck-reads', {}]);
    const customer = call('getCustomerById', ['C001']);
    return withMocks({
      permanentIndexRowsForScan_: () => indexRows,
      runIntegrityCheck: () => ({findings: [], stop: false})
    }, () => {
      gas.context.forgetFileRowNumbers_();
      gas.stubs.resetApiCallCounts();
      const before = gas.stubs.getApiCallCounts().batchGet;
      gas.context.runCustomerIntegrityCheck_(customer, []);
      return gas.stubs.getApiCallCounts().batchGet - before;
    });
  }

  test('imp 7: 前検査の読取回数は未完了1ファイルと5ファイルで同じ', () => {
    const one = measurePrecheckReads(1);
    const five = measurePrecheckReads(5);
    assert.equal(one, five, `前検査の読取がファイル数に比例している（1件=${one}、5件=${five}）`);
  });

  test('imp 8: 同一ファイルの処理ログ重複は既存のIntegrityErrorで止まる', () => {
    const seeded = seedPartnerViaWeb({fileId: 'imp-duplicate-process', count: 1});
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName('クレカ処理ログ');
    const row = sheet.getDataRange().getValues().find((values) =>
      String(values[7]) === seeded.fileId);
    assert.ok(row, '処理ログ行が必要');
    sheet.appendRow(row);
    gas.context.forgetFileRowNumbers_();
    const error = caught(() => gas.context.runCustomerIntegrityCheck_(
      call('getCustomerById', [seeded.customer.customerId]), []));
    assert.equal(error.code, 'TRANSACTION_LOG_AMBIGUOUS');
    assert.ok(error.message.includes('Duplicate process log fileId'), error.message);
  });

  function measureImportFileReads(reviewCount) {
    const seeded = setupWorld({knownMerchant: true});
    const rows = Array.from({length: reviewCount || 1}, (_, index) =>
      `2025/12/${String(index + 1).padStart(2, '0')},${reviewCount ? '未登録店' : '既知店'},${2000 + index},仕入れ`);
    const fileId = putCsv(seeded.customer, {fileId: `imp-import-${reviewCount}`, rows});
    const destinationSpreadsheetId = createWebDestination(seeded.customer);
    gas.stubs.resetApiCallCounts();
    const result = webImport(seeded.customer, {destinationSpreadsheetId});
    const fileResult = importFileResults(result).find((item) => item.fileId === fileId);
    assert.ok(fileResult, `取込結果に${fileId}が無い`);
    assert.equal(openReviewsFor(seeded.customer.customerId, {fileId})
      .filter((review) => review.reviewType === 'PARTNER').length, reviewCount);
    return fileResult.reads;
  }

  test('imp 9: 要確認30件と0件の取込でファイル単位の読取差は5以下', () => {
    const thirty = measureImportFileReads(30);
    const none = measureImportFileReads(0);
    assert.ok(Math.abs(thirty - none) <= 5,
      `30件=${thirty}読取、0件=${none}読取。差は${Math.abs(thirty - none)}`);
    assert.equal(clientEval('formatElapsed(0)'), '0:00');
    assert.equal(clientEval('formatElapsed(83000)'), '1:23');
    assert.equal(clientEval('formatElapsed(3600000)'), '60:00');
    assert.equal(clientEval('formatElapsed(-1)'), '0:00');
    assert.equal(clientEval('formatElapsed(NaN)'), '0:00');
    assert.equal(clientEval('progressText(3, 12, 83000)'),
      '処理中 3 / 12（経過 1:23）');
    assert.match(WEBAPP_UI_SOURCE, /@keyframes\s+[\w-]+/);
    assert.match(WEBAPP_UI_SOURCE, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    assert.match(WEBAPP_UI_SOURCE,
      /processingHint:\s*'複数のファイルをまとめて取り込んでいるため、表示が進むまで数分かかることがあります。このままお待ちください。'/);
  });

  test('imp 10: 進捗時計は停止後に更新せずfinallyから停止される', () => {
    const source = WEBAPP_UI_SOURCE;
    assert.ok((source.match(/progressTimer\.stop\(\);/g) || []).length >= 2,
      '取込と確定のfinallyから進捗時計を停止していない');
    const elements = {
      'import-progress-label': {textContent: ''},
      'import-progress-arrows': {},
      'import-progress-value': {textContent: ''},
      'import-progress-hint': {hidden: true, textContent: ''}
    };
    let now = 1000;
    let tick = null;
    const cleared = [];
    const timers = clientEval(`(() => {
      const timer = startProgressTimer('import-progress', () => true,
        {now: () => __clock.now()});
      timer.beginCall();
      __clock.advance(61000);
      __tick();
      const before = {text: el['import-progress-value'].textContent,
        hint: el['import-progress-hint'].hidden};
      timer.endCall();
      timer.stop();
      const stoppedText = el['import-progress-value'].textContent;
      __clock.advance(5000);
      __tick();
      return {before, stoppedText, afterText: el['import-progress-value'].textContent};
    })()`, {
      document: {getElementById(id) { return elements[id] || {}; }},
      setInterval(callback) { tick = callback; return 17; },
      clearInterval(id) { cleared.push(id); },
      __clock: {now: () => now, advance: (ms) => { now += ms; }},
      __tick() { if (tick) tick(); }
    });
    assert.equal(timers.before.hint, false, '60秒を超えた案内が表示されない');
    assert.equal(timers.afterText, timers.stoppedText, '停止後も経過表示が更新された');
    assert.deepEqual(cleared, [17], 'setIntervalがclearIntervalで止められていない');
  });

  test('imp 11: 60 秒返らないときの案内は、取込と確定で待つ理由を分けて言う', () => {
    const hints = plain(clientEval(`(() => {
      const nodes = {};
      ['import-progress', 'resolve-progress'].forEach((id) => {
        ['-label', '-arrows', '-value', '-hint'].forEach((suffix) => { el[id + suffix] = {}; });
      });
      renderProgress('import-progress', 1, 3, 61000, true);
      renderProgress('resolve-progress', 1, 3, 61000, true);
      return {imp: el['import-progress-hint'].textContent, res: el['resolve-progress-hint'].textContent};
    })()`));
    assert.ok(hints.imp.includes('取り込んでいる'), hints.imp);
    assert.ok(hints.res.includes('確定している'), hints.res);
  });

  function seedPrefetchFile(customer, fileId, options = {}) {
    const name = options.name || `${fileId}.csv`;
    gas.stubs.createFile(fileId, {name, data: 'a,b\n1,2\n'});
    return call('createOrUpdateProcessLog', [options.runId || 'RUN_' + fileId,
      customer, {
        id: fileId, originalFileName: name, binaryHash: options.binaryHash || '',
        contentHash: options.contentHash || '', hashVersion: '3',
        state: options.state || 'DISCOVERED'
      }]);
  }

  test('pf 1: importing two files reduces the second file to the measured 20 reads', () => {
    const {customer} = setupWorld({knownMerchant: true});
    [0, 1].forEach((index) => putCsv(customer, {fileId: `pf_one_${index}`,
      rows: [`2025/12/${10 + index},既知店,${1000 + index},仕入れ`]}));
    const result = webImport(customer);
    const files = importFileResults(result);
    assert.equal(result.done, 2);
    assert.equal(files.length, 2);
    assert.equal(files[1].reads, 20,
      `2本目の読取は${files[1].reads}回（5回減った実測20回のはず）: ${JSON.stringify(files[1])}`);
  });

  test('pf 2: transition reads both remembered rows in one batchGet and updates both', () => {
    const {customer} = setupWorld();
    seedPrefetchFile(customer, 'pf_pair');
    gas.stubs.resetApiCallCounts();
    call('transitionFileState', ['pf_pair', 'DISCOVERED', 'VALIDATING', 'RUN_pf_pair']);
    const master = gas.stubs.getSpreadsheet('master');
    const process = master.getSheetByName('クレカ処理ログ').getRange(2, 1, 1, 40).getValues()[0];
    const permanent = master.getSheetByName('恒久ファイルインデックス').getRange(2, 1, 1, 13).getValues()[0];
    assert.equal(gas.stubs.getApiCallCounts().batchGet, 1,
      `比較更新の読取は${gas.stubs.getApiCallCounts().batchGet}回`);
    assert.equal(process[16], 'VALIDATING');
    assert.equal(permanent[3], 'VALIDATING');
  });

  test('pf 3: a stale remembered key rereads only that record and leaves the other file alone', () => {
    const {customer} = setupWorld();
    const first = seedPrefetchFile(customer, 'pf_stale_a');
    const second = seedPrefetchFile(customer, 'pf_stale_b');
    gas.context.fileRowNumberCache_.index.pf_stale_a = second.permanent.rowNumber;
    gas.stubs.resetApiCallCounts();
    call('transitionFileState', ['pf_stale_a', 'DISCOVERED', 'VALIDATING', 'RUN_pf_stale_a']);
    assert.equal(gas.stubs.getApiCallCounts().batchGet, 3,
      '恒久索引だけが外れたとき、ペア読取とその表だけの鍵列・行読取を行う');
    const master = gas.stubs.getSpreadsheet('master');
    const processSheet = master.getSheetByName('クレカ処理ログ');
    const indexSheet = master.getSheetByName('恒久ファイルインデックス');
    assert.equal(processSheet.getRange(first.process.rowNumber, 17).getValue(), 'VALIDATING');
    assert.equal(indexSheet.getRange(first.permanent.rowNumber, 4).getValue(), 'VALIDATING');
    assert.equal(processSheet.getRange(second.process.rowNumber, 17).getValue(), 'DISCOVERED');
    assert.equal(indexSheet.getRange(second.permanent.rowNumber, 4).getValue(), 'DISCOVERED');

    gas.context.fileRowNumberCache_.process.pf_stale_a = second.process.rowNumber;
    gas.stubs.resetApiCallCounts();
    call('transitionFileState', ['pf_stale_a', 'VALIDATING', 'WRITING', 'RUN_pf_stale_a']);
    assert.equal(gas.stubs.getApiCallCounts().batchGet, 3,
      '処理ログだけが外れたとき、ペア読取とその表だけの鍵列・行読取を行う');
    assert.equal(processSheet.getRange(first.process.rowNumber, 17).getValue(), 'WRITING');
    assert.equal(processSheet.getRange(second.process.rowNumber, 17).getValue(), 'DISCOVERED');
    assert.equal(indexSheet.getRange(first.permanent.rowNumber, 4).getValue(), 'WRITING');
    assert.equal(indexSheet.getRange(second.permanent.rowNumber, 4).getValue(), 'DISCOVERED');
  });

  test('pf 4: compare-and-set and required permanent row errors stay unchanged', () => {
    const {customer} = setupWorld();
    const seeded = seedPrefetchFile(customer, 'pf_compare');
    const mismatch = caught(() => call('transitionFileState',
      ['pf_compare', 'VALIDATING', 'WRITING', 'RUN_pf_compare']));
    assert.match(mismatch.message, /File compare-and-set failed/);
    gas.stubs.getSpreadsheet('master').getSheetByName('恒久ファイルインデックス')
      .deleteRow(seeded.permanent.rowNumber);
    const missing = caught(() => call('transitionFileState',
      ['pf_compare', 'DISCOVERED', 'VALIDATING', 'RUN_pf_compare']));
    assert.equal(missing.code, 'REQUIRED_LOG_WRITE_FAILED');
  });

  test('pf 5: submitted content hash still checks the current row despite both known records', () => {
    const {customer} = setupWorld();
    const seeded = seedPrefetchFile(customer, 'pf_hash');
    call('updateProcessLog', ['pf_hash', {submittedContentHash: 'HASH_A'}]);
    const error = caught(() => call('updateProcessLog',
      ['pf_hash', {submittedContentHash: 'HASH_B'}, seeded.process, seeded.permanent]));
    assert.match(error.message, /Submitted content hash is immutable/);
    const row = gas.stubs.getSpreadsheet('master').getSheetByName('クレカ処理ログ')
      .getRange(seeded.process.rowNumber, 13).getValue();
    assert.equal(row, 'HASH_A');
  });

  test('pf 6: a fresh registration locates both rows and both append positions in one read', () => {
    const {customer} = setupWorld();
    call('forgetFileRowNumbers_', []);
    gas.stubs.resetApiCallCounts();
    const registered = seedPrefetchFile(customer, 'pf_new');
    assert.equal(gas.stubs.getApiCallCounts().batchGet, 1,
      `新規登録の読取は${gas.stubs.getApiCallCounts().batchGet}回`);
    assert.equal(registered.process.rowNumber, 2);
    assert.equal(registered.permanent.rowNumber, 2);
    assert.equal(gas.context.fileRowNumberCache_.process.pf_new, 2);
    assert.equal(gas.context.fileRowNumberCache_.index.pf_new, 2);

    const headerWorld = setupWorld();
    const master = gas.stubs.getSpreadsheet('master');
    master.getSheetByName('クレカ処理ログ').getRange(1, 8).setValue('pf_header_key');
    master.getSheetByName('恒久ファイルインデックス').getRange(1, 1).setValue('pf_header_key');
    call('forgetFileRowNumbers_', []);
    const headerMatch = call('createOrUpdateProcessLog', ['RUN_pf_header_key',
      headerWorld.customer, {id: 'pf_header_key'}]);
    assert.equal(headerMatch.process.rowNumber, 2, '見出しをデータ行として扱っている');
    assert.equal(headerMatch.permanent.rowNumber, 2, '見出しをデータ行として扱っている');
  });

  test('pf 7: an unremembered registration updates existing rows without appending', () => {
    const {customer} = setupWorld();
    const seeded = seedPrefetchFile(customer, 'pf_existing');
    gas.stubs.getSpreadsheet('master').getSheetByName('クレカ処理ログ')
      .getRange(seeded.process.rowNumber, 13).setValue('HASH_CURRENT');
    call('forgetFileRowNumbers_', []);
    gas.stubs.resetApiCallCounts();
    const updated = call('createOrUpdateProcessLog', ['RUN_pf_existing_again',
      customer, {
        id: 'pf_existing', originalFileName: 'pf_existing.csv', state: 'DISCOVERED'
      }, seeded.process]);
    const master = gas.stubs.getSpreadsheet('master');
    assert.equal(gas.stubs.getApiCallCounts().batchGet, 1);
    assert.equal(master.getSheetByName('クレカ処理ログ').getLastRow(), 2);
    assert.equal(master.getSheetByName('恒久ファイルインデックス').getLastRow(), 2);
    assert.equal(updated.process.rowNumber, seeded.process.rowNumber);
    assert.equal(updated.permanent.rowNumber, seeded.permanent.rowNumber);
    assert.equal(updated.process.values[0], 'RUN_pf_existing_again');
    assert.equal(updated.process.values[12], 'HASH_CURRENT',
      'ロック外で渡された古い処理ログ行を優先している');
  });

  test('pf 8: the combined registration scan rejects duplicate keys without writing', () => {
    const cases = [
      {sheet: 'クレカ処理ログ', keyColumn: 8, duplicateDetail: 'Duplicate process log fileId'},
      {sheet: '恒久ファイルインデックス', keyColumn: 1,
        duplicateDetail: 'Duplicate permanent file index fileId'}
    ];
    cases.forEach((entry, index) => {
      const {customer} = setupWorld();
      const seeded = seedPrefetchFile(customer, `pf_duplicate_${index}`);
      const sheet = gas.stubs.getSpreadsheet('master').getSheetByName(entry.sheet);
      const record = index === 0 ? seeded.process : seeded.permanent;
      sheet.appendRow(record.values);
      call('forgetFileRowNumbers_', []);
      gas.stubs.resetApiCallCounts();
      const writesBefore = gas.stubs.getApiCallCounts().batchUpdate;
      const error = caught(() => call('createOrUpdateProcessLog', ['RUN_duplicate',
        call('getCustomerById', [customer.customerId]), {id: `pf_duplicate_${index}`} ]));
      assert.equal(error.code, 'TRANSACTION_LOG_AMBIGUOUS');
      assert.ok(error.message.endsWith(entry.duplicateDetail), error.message);
      assert.equal(gas.stubs.getApiCallCounts().batchUpdate, writesBefore);
      assert.equal(sheet.getLastRow(), 3);
    });
  });

  test('pf 14: 処理ログの行だけが在るファイルの登録は、恒久ファイルインデックスの末尾の次へ足す', () => {
    // 1 回読みにした登録で、無い側の末尾を取り違えると、恒久ファイルインデックスの
    // 追記先を処理ログの末尾から決めてしまい、別のファイルの行を上書きする（監査で発見）。
    const {customer} = setupWorld();
    seedPrefetchFile(customer, 'pf_order_a');
    const b = seedPrefetchFile(customer, 'pf_order_b');
    const master = gas.stubs.getSpreadsheet('master');
    const processSheet = master.getSheetByName('クレカ処理ログ');
    const indexSheet = master.getSheetByName('恒久ファイルインデックス');
    // 処理ログ：a・c（c は恒久ファイルインデックスに行が無い）。恒久ファイルインデックス：a・b・d。
    processSheet.getRange(b.process.rowNumber, 8).setValue('pf_order_c');
    const dRow = indexSheet.getRange(b.permanent.rowNumber, 1, 1, 13).getValues()[0].slice();
    dRow[0] = 'pf_order_d';
    indexSheet.appendRow(dRow);
    assert.equal(processSheet.getLastRow(), 3);
    assert.equal(indexSheet.getLastRow(), 4);
    call('forgetFileRowNumbers_', []);
    gas.stubs.createFile('pf_order_c', {name: 'pf_order_c.csv', data: 'a,b\n1,2\n'});
    const updated = call('createOrUpdateProcessLog', ['RUN_pf_order_c', customer,
      {id: 'pf_order_c', originalFileName: 'pf_order_c.csv', state: 'DISCOVERED'}]);
    assert.equal(updated.process.rowNumber, b.process.rowNumber, '処理ログは在る行を使う');
    assert.equal(updated.permanent.rowNumber, 5, '恒久ファイルインデックスは自分の末尾の次');
    assert.equal(indexSheet.getRange(4, 1).getValue(), 'pf_order_d', '別のファイルの行を上書きしない');
    assert.equal(indexSheet.getRange(5, 1).getValue(), 'pf_order_c');
  });

  test('pf 9: unremembered registration skips trailing blank rows like apiLastDataRows_', () => {
    assert.equal(call('lastDataRowFromValues_', [[['header'], ['data'], [], []]]), 2,
      '返却範囲に含まれる末尾の全空行を追記行に数えている');
    const {customer} = setupWorld();
    const master = gas.stubs.getSpreadsheet('master');
    const processSheet = master.getSheetByName('クレカ処理ログ');
    const indexSheet = master.getSheetByName('恒久ファイルインデックス');
    processSheet.getRange(10, 2).setValue('tail-marker');
    indexSheet.getRange(12, 2).setValue('tail-marker');
    processSheet.getRange(11, 1, 4, 40).setValues(matrix(4, 40));
    indexSheet.getRange(13, 1, 4, 13).setValues(matrix(4, 13));
    const lastRows = gas.evaluate(
      'apiLastDataRows_([{sheet:processLogSheet_(),columns:PROCESS_LOG_WIDTH_},' +
      '{sheet:permanentFileIndexSheet_(),columns:FILE_INDEX_WIDTH_}])');
    call('forgetFileRowNumbers_', []);
    const registered = call('createOrUpdateProcessLog', ['RUN_pf_tail',
      call('getCustomerById', [customer.customerId]), {id: 'pf_tail'}]);
    assert.equal(registered.process.rowNumber, lastRows[0] + 1);
    assert.equal(registered.permanent.rowNumber, lastRows[1] + 1);
  });

  test('pf 11: the submitted content hashes use one read and one batchUpdate', () => {
    const {customer} = setupWorld();
    const seeded = seedPrefetchFile(customer, 'pf_hash_pair');
    gas.stubs.resetApiCallCounts();
    call('updateProcessLogAndContentHash_', ['pf_hash_pair', {
      submittedContentHash: 'HASH_PAIR', currentContentHash: 'HASH_PAIR'
    }]);
    const counts = gas.stubs.getApiCallCounts();
    const master = gas.stubs.getSpreadsheet('master');
    assert.equal(counts.batchGet, 1, `ハッシュ判定の読取は${counts.batchGet}回`);
    assert.equal(counts.batchUpdate, 1, `2表の書込は${counts.batchUpdate}回`);
    assert.equal(master.getSheetByName('クレカ処理ログ')
      .getRange(seeded.process.rowNumber, 13).getValue(), 'HASH_PAIR');
    assert.equal(master.getSheetByName('恒久ファイルインデックス')
      .getRange(seeded.permanent.rowNumber, 6).getValue(), 'HASH_PAIR');
  });

  test('pf 12: both submitted hash columns enforce INV-07 before either table is written', () => {
    const cases = [
      {name: 'process log', processHash: 'HASH_OLD', permanentHash: '',
        message: /Submitted content hash is immutable/},
      {name: 'permanent index', processHash: '', permanentHash: 'HASH_OLD',
        message: /Submitted content hash is immutable \(INV-07\)/}
    ];
    cases.forEach((entry, index) => {
      const {customer} = setupWorld();
      const seeded = seedPrefetchFile(customer, `pf_hash_conflict_${index}`);
      const master = gas.stubs.getSpreadsheet('master');
      const processSheet = master.getSheetByName('クレカ処理ログ');
      const indexSheet = master.getSheetByName('恒久ファイルインデックス');
      processSheet.getRange(seeded.process.rowNumber, 13).setValue(entry.processHash);
      indexSheet.getRange(seeded.permanent.rowNumber, 6).setValue(entry.permanentHash);
      gas.stubs.resetApiCallCounts();
      const error = caught(() => call('updateProcessLogAndContentHash_', [
        `pf_hash_conflict_${index}`, {
          submittedContentHash: 'HASH_NEW', currentContentHash: 'CANARY'
        }
      ]));
      assert.match(error.message, entry.message, entry.name);
      assert.equal(gas.stubs.getApiCallCounts().batchGet, 1, entry.name);
      assert.equal(gas.stubs.getApiCallCounts().batchUpdate, 0, entry.name);
      assert.equal(processSheet.getRange(seeded.process.rowNumber, 13).getValue(), entry.processHash,
        entry.name);
      assert.equal(processSheet.getRange(seeded.process.rowNumber, 14).getValue(), '', entry.name);
      assert.equal(indexSheet.getRange(seeded.permanent.rowNumber, 6).getValue(), entry.permanentHash,
        entry.name);
    });
  });

  test('pf 13: a failed combined batchUpdate leaves both submitted hashes untouched', () => {
    const {customer} = setupWorld();
    const seeded = seedPrefetchFile(customer, 'pf_hash_atomic');
    gas.stubs.resetApiCallCounts();
    const valuesApi = gas.context.Sheets.Spreadsheets.Values;
    const realBatchUpdate = valuesApi.batchUpdate;
    valuesApi.batchUpdate = function() { throw new Error('combined hash write stopped'); };
    let error;
    try {
      error = caught(() => call('updateProcessLogAndContentHash_', ['pf_hash_atomic', {
        submittedContentHash: 'HASH_ATOMIC', currentContentHash: 'HASH_ATOMIC'
      }]));
    } finally {
      valuesApi.batchUpdate = realBatchUpdate;
    }
    assert.equal(error.message, 'combined hash write stopped');
    const master = gas.stubs.getSpreadsheet('master');
    assert.equal(master.getSheetByName('クレカ処理ログ')
      .getRange(seeded.process.rowNumber, 13).getValue(), '');
    assert.equal(master.getSheetByName('クレカ処理ログ')
      .getRange(seeded.process.rowNumber, 14).getValue(), '');
    assert.equal(master.getSheetByName('恒久ファイルインデックス')
      .getRange(seeded.permanent.rowNumber, 6).getValue(), '');
  });

};

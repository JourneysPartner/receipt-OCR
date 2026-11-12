'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * 1 件ずつの対象外が行を取引 ID で確かめることと、対象外で空いた行を上へ
 * 詰めること（`work/spec_exclude_row_compaction.md` §5）。
 *
 * 材料は架空の表だけ。`test/fixtures/` は読まない。
 */
module.exports = ({test, assert, gas}) => {
  const UI_SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'src', '81_WebAppUi.html'), 'utf8');
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const blank = (length) => Array(length).fill('');
  const call = (name, args = []) => {
    const result = gas.call(name, args);
    return result === undefined ? undefined : plain(result);
  };

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

  function caught(fn) {
    try {
      fn();
    } catch (error) {
      return error;
    }
    assert.fail('expected the call to throw');
  }

  function clientEval(expression) {
    const match = /<script>([\s\S]*?)<\/script>/.exec(UI_SOURCE);
    assert.ok(match, 'Web app script must exist');
    const needle = "    el['customer-search'].addEventListener";
    assert.ok(match[1].includes(needle), 'client probe insertion point must exist');
    const probe = `    globalThis.__probe = (${expression});\n` + '    return;\n';
    const source = match[1].replace(needle, probe + needle);
    const sandbox = {document: {getElementById() { return {}; }}};
    vm.runInNewContext(source, sandbox);
    return sandbox.__probe;
  }

  function clientPlain(expression) {
    return plain(clientEval(expression));
  }

  function matrix(rows, columns) {
    return Array.from({length: rows}, () => blank(columns));
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

  /**
   * 詰めるテスト用の転記先。**どのデータ行にも比べる列の既定値と数式を置く**
   * （下の行だけ空だと、雛形の形と違って `MANUAL_EDIT` になる）。
   * 行 5〜は `=N(前の行)+L(行)-M(行)` の形の残高式と、勘定科目の既定値を持つ。
   */
  function createCompactionTemplate(id, options = {}) {
    const headerRow = Number(options.headerRow || 4);
    const dataStartRow = Number(options.dataStartRow || headerRow + 1);
    const maxRows = Number(options.maxRows || 40);
    const maxColumns = 10;
    const values = matrix(maxRows, maxColumns);
    const formulas = matrix(maxRows, maxColumns);
    values[headerRow - 1] = [
      '', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID', '税区分',
      '勘定科目', '消費税'
    ];
    for (let row = dataStartRow; row <= maxRows; row += 1) {
      values[row - 1][7] = '課税10%';
      if (options.accountList && row >= 5 && row <= 20) {
        values[row - 1][8] = 'A' + String(row - 4).padStart(3, '0');
        values[row - 1][9] = '架空科目' + String(row - 4);
      } else {
        values[row - 1][8] = '会議費';
        formulas[row - 1][9] = `=N${row - 1}+L${row}-M${row}`;
      }
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
    const cardFolder = gas.stubs.createFolder(cardId, {name: `カード${suffix}`,
      fileIds: [], subFolderIds: []});
    const rootFolder = gas.stubs.createFolder(rootId,
      {name: `顧客${suffix}ルート`, fileIds: [], subFolderIds: [cardId]});
    const destinationParent = gas.stubs.createFolder(destinationParentId,
      {name: `転記先${suffix}`, fileIds: [destinationId], subFolderIds: []});
    const headerRow = Number(options.headerRow || 4);
    const dataStartRow = Number(options.dataStartRow || headerRow + 1);
    createCompactionTemplate(destinationId, {
      name: options.destinationName || `${customerName}_雛形`,
      headerRow, dataStartRow,
      maxRows: options.maxRows,
      accountList: options.accountList,
      destinationSheetName: options.destinationSheetName
    });
    const columns = {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7, G: 8};
    if (options.accountList) columns.C = 1;
    gas.call('registerTestCustomer', [{
      customerId, customerName, active: true, sourceFolderId: rootId,
      destinationSpreadsheetId: destinationId,
      destinationSheetName: options.destinationSheetName || '入力用シート',
      partnerListSheetName: '取引先一覧',
      columns,
      headerRow,
      dataStartRow,
      rowScanLastColumn: 10,
      rowScanExcludedColumns: options.rowScanExcludedColumns || [8, 9, 10],
      accountListRange: options.accountList ? 'I5:J20' : undefined,
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
      customerName: '顧客一'}, options, options.customer || {}));
    gas.stubs.getSpreadsheet('master').getSheetByName('共通取引先辞書')
      .appendRow(knownMerchantRow());
    gas.stubs.setActiveUser(options.actor || 'reviewer@example.com');
    gas.stubs.resetApiCallCounts();
    gas.stubs.resetRoundTrips();
    return {world, customer};
  }

  function putCsv(customer, options = {}) {
    const fileId = options.fileId || `file_${customer.cardFolder.fileIds.length + 1}`;
    const rows = options.rows || ['2025/12/10,既知店,1000,仕入れ'];
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

  function openReviewsFor(customerId) {
    return call('openReviews', [{}]).filter((row) =>
      String(row.customerId) === String(customerId));
  }

  function webImport(customer) {
    return call('webAppRunImport', [customer.customerId, customer.cardId, {}]);
  }

  function priorYearRows(count) {
    return Array.from({length: count}, (_, index) => {
      const month = 1 + Math.floor(index / 28);
      const day = 1 + (index % 28);
      return `2025/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')},` +
        `既知店,${1000 + index},仕入れ`;
    });
  }

  function compactionWorld(options = {}) {
    const rows = options.rows || priorYearRows(options.count || 5);
    const seeded = setupWorld(Object.assign({knownMerchant: true}, options, {
      customer: Object.assign({customerCategory: 'INDIVIDUAL', fiscalYear: 2026},
        options.customer || {})
    }));
    const fileId = putCsv(seeded.customer, {fileId: options.fileId || 'compact_file',
      rows, name: options.name || '架空詰め明細.csv'});
    const result = webImport(seeded.customer);
    const reviews = openReviewsFor(seeded.customer.customerId)
      .sort((a, b) => reviewSourceRow(a) - reviewSourceRow(b));
    return Object.assign(seeded, {fileId, rows, result, reviews,
      destinationSpreadsheetId: result.destinationSpreadsheetId,
      headerRow: Number(options.headerRow || 4),
      dataStartRow: Number(options.dataStartRow || Number(options.headerRow || 4) + 1)});
  }

  function destinationSheet(world) {
    return gas.stubs.getSpreadsheet(world.destinationSpreadsheetId)
      .getSheetByName('入力用シート');
  }

  function sheetValues(world) {
    const sheet = destinationSheet(world);
    return plain(sheet.getRange(1, 1, sheet.getMaxRows(), 10).getValues());
  }

  function sheetFormulas(world) {
    const sheet = destinationSheet(world);
    return plain(sheet.getRange(1, 1, sheet.getMaxRows(), 10).getFormulas());
  }

  function sheetFormats(world) {
    const sheet = destinationSheet(world);
    return plain(sheet.getRange(1, 1, sheet.getMaxRows(), 10).getNumberFormats());
  }

  function destinationSnapshot(world) {
    return {values: sheetValues(world), formulas: sheetFormulas(world),
      formats: sheetFormats(world)};
  }

  function rowAt(world, rowNumber) {
    return sheetValues(world)[Number(rowNumber) - 1] || [];
  }

  /** 要確認そのものは行番号を持たないことがある。取引ログの行を正本にする。 */
  function reviewDestinationRow(review) {
    if (review.destinationRow !== null && review.destinationRow !== undefined) {
      return Number(review.destinationRow);
    }
    const tx = transactionFor(review.fullTxId);
    return tx ? Number(tx.destinationRow) : null;
  }

  function reviewSourceRow(review) {
    if (review.sourceRow !== null && review.sourceRow !== undefined) {
      return Number(review.sourceRow);
    }
    const tx = transactionFor(review.fullTxId);
    return tx ? Number(tx.sourceRow) : null;
  }

  function reviewAt(world, destinationRow, reviewType = 'PRIOR_YEAR') {
    const found = world.reviews.find((review) =>
      reviewDestinationRow(review) === Number(destinationRow) &&
      String(review.reviewType) === String(reviewType));
    assert.ok(found, 'review for destination row ' + destinationRow);
    return found;
  }

  function reviewForSource(world, sourceRow, reviewType = 'PRIOR_YEAR') {
    const found = world.reviews.find((review) =>
      reviewSourceRow(review) === Number(sourceRow) &&
      String(review.reviewType) === String(reviewType));
    assert.ok(found, 'review for source row ' + sourceRow);
    return found;
  }

  function excludeOne(world, review, code = 'EXCLUDE_PRIOR_YEAR') {
    return call('webAppResolveOtherReview', [world.customer.customerId,
      review.reviewId, code, {}]);
  }

  function excludeBatch(world, reviews, code = 'EXCLUDE_PRIOR_YEAR') {
    return call('webAppResolveOtherReviewsBatch', [world.customer.customerId,
      reviews.map((review) => review.reviewId), code]);
  }

  function reviewRow(reviewId) {
    const review = call('getReviewById', [reviewId]);
    return plain(gas.stubs.getSpreadsheet('master').getSheetByName('要確認')
      .getRange(review._rowNumber, 1, 1, 32).getValues()[0]);
  }

  function reviewRowsFor(world) {
    return world.reviews.map((review) => ({
      sourceRow: reviewSourceRow(review),
      row: reviewRow(review.reviewId)
    })).sort((a, b) => a.sourceRow - b.sourceRow);
  }

  function transactionFor(fullTxId) {
    return call('getTransaction', [fullTxId]);
  }

  function txLogSheet() {
    return gas.stubs.getSpreadsheet('master').getSheetByName('クレカ取引ログ');
  }

  function txRow(fullTxId) {
    const tx = transactionFor(fullTxId);
    return tx ? plain(txLogSheet().getRange(tx._rowNumber, 1, 1, 49).getValues()[0]) : null;
  }

  function txRowsFor(world) {
    return world.reviews.map((review) => ({
      sourceRow: reviewSourceRow(review), row: txRow(review.fullTxId)
    })).sort((a, b) => a.sourceRow - b.sourceRow);
  }

  function setTxCell(fullTxId, column, value) {
    const tx = transactionFor(fullTxId);
    assert.ok(tx, 'transaction ' + fullTxId);
    txLogSheet().getRange(tx._rowNumber, column).setValue(value);
  }

  function auditRows(type) {
    return gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ')
      .getDataRange().getValues().slice(1).filter((row) => String(row[2]) === type);
  }

  function reviewResolveAudit() {
    return auditRows('REVIEW_RESOLVE');
  }

  function txIdAt(world, rowNumber) {
    return String(rowAt(world, rowNumber)[6] || '');
  }

  function clearRow(world, rowNumber) {
    const sheet = destinationSheet(world);
    [2, 3, 4, 5, 6, 7].forEach((column) => {
      sheet.getRange(Number(rowNumber), column).setValue('');
    });
  }

  /**
   * 行 5 の取引を一番下（行 10）へ移し、行 5 を「取引 ID の無い繰越の行」に
   * する。取引ログの AE も新しい行へ直す（cmp 15・16 の材料）。
   */
  function makeAboveRow(world) {
    const sheet = destinationSheet(world);
    const txId = txIdAt(world, 5);
    const tx = transactionFor(txId);
    sheet.getRange(10, 2, 1, 6).setValues(sheet.getRange(5, 2, 1, 6).getValues());
    clearRow(world, 5);
    sheet.getRange(5, 3).setValue('繰越');
    sheet.getRange(5, 6).setValue(500);
    setTxCell(txId, 31, 10);
    return {txId, tx};
  }

  function moveColumnIndexes(world) {
    const customer = call('getCustomerById', [world.customer.customerId]);
    const keys = ['txId', 'b', 'f', 'i', 'k', 'm', 'g'];
    return keys.map((key) => call('writeColumnNumber_', [customer, key]) - 1)
      .filter((value, index, list) => list.indexOf(value) === index)
      .sort((a, b) => a - b);
  }

  function maxColumn(world) {
    const customer = call('getCustomerById', [world.customer.customerId]);
    return Number(customer.rowScanLastColumn);
  }

  function changedCells(before, after) {
    const diffs = [];
    const rows = Math.max(before.values.length, after.values.length);
    for (let row = 0; row < rows; row += 1) {
      const left = before.values[row] || [];
      const right = after.values[row] || [];
      for (let column = 0; column < Math.max(left.length, right.length); column += 1) {
        if (JSON.stringify(left[column]) !== JSON.stringify(right[column])) {
          diffs.push({row: row + 1, column: column + 1});
        }
      }
    }
    return diffs;
  }

  function normalizeTxRows(rows) {
    return rows.map((entry) => {
      const row = entry.row ? entry.row.slice() : null;
      if (row) [2, 43, 44].forEach((index) => { row[index] = ''; });
      return {sourceRow: entry.sourceRow, row};
    });
  }

  function normalizeReviewRows(rows) {
    return rows.map((entry) => ({
      sourceRow: entry.sourceRow,
      // B・R・V・W・Z・AB・AD・AE・AF・Y
      values: [1, 17, 21, 22, 25, 27, 29, 30, 31, 24].map((index) => entry.row[index])
    }));
  }

  function normalizedAuditEvents() {
    const allTx = txLogSheet().getDataRange().getValues();
    return reviewResolveAudit().map((row) => {
      const tx = allTx.find((item) => String(item[0]) === String(row[7]));
      return [row[3], row[6], tx ? Number(tx[6]) : String(row[7]), row[8] || '', row[10] || ''];
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }

  function comparableState(world) {
    return {
      destination: destinationSnapshot(world),
      txRows: normalizeTxRows(txRowsFor(world)),
      reviewRows: normalizeReviewRows(reviewRowsFor(world)),
      events: normalizedAuditEvents(),
      state: call('getFileState', [world.fileId])
    };
  }

  function customerWithDestination(world) {
    const customer = call('getCustomerById', [world.customer.customerId]);
    return Object.assign({}, customer, {
      destinationSpreadsheetId: world.destinationSpreadsheetId,
      destinationSheetName: '入力用シート'
    });
  }

  function acquireWriteLease(world, fileId, runId) {
    return call('acquireLease', [world.customer.customerId, fileId, runId || 'AFTER_RUN',
      'reviewer@example.com', 'WRITE_ONLY']);
  }

  // ---- S1〜S4：1 件ずつの対象外 ----

  test('sx 1: 行を取引 ID で確かめ、合わなければ 1 セルも書かない', () => {
    const cases = [
      ['別の取引の ID', (world, target, other) => {
        destinationSheet(world).getRange(reviewDestinationRow(target), 7)
          .setValue(other.fullTxId);
      }],
      ['行が動いた', (world, target) => {
        const sheet = destinationSheet(world);
        const row = reviewDestinationRow(target);
        const moved = sheet.getRange(row, 2, 1, 6).getValues();
        sheet.getRange(10, 2, 1, 6).setValues(moved);
        sheet.getRange(row, 2, 1, 6).setValues([['', '', '', '', '', '']]);
      }],
      ['取引ログの転記先が違う', (world, target) => {
        setTxCell(target.fullTxId, 29, 'dest_other');
      }],
      ['取引 ID が 2 行', (world, target) => {
        const sheet = destinationSheet(world);
        sheet.getRange(10, 7).setValue(target.fullTxId);
      }],
      ['転記先の記録が無く行も空', (world, target) => {
        setTxCell(target.fullTxId, 29, '');
        setTxCell(target.fullTxId, 30, '');
        const sheet = destinationSheet(world);
        sheet.getRange(reviewDestinationRow(target), 2, 1, 6)
          .setValues([['', '', '', '', '', '']]);
      }]
    ];
    for (const [name, tamper] of cases) {
      const world = compactionWorld({count: 3});
      const target = reviewAt(world, 6);
      const other = reviewAt(world, 7);
      tamper(world, target, other);
      const destinationBefore = destinationSnapshot(world);
      const txBefore = txRowsFor(world);
      const reviewBefore = reviewRowsFor(world);
      const auditBefore = reviewResolveAudit().length;
      const result = excludeOne(world, target);
      assert.equal(result.resolved, 0, name);
      assert.equal(result.errors.length, 1, name);
      assert.equal(result.errors[0].code, 'DESTINATION_ROW_MISMATCH', name);
      assert.equal(result.errors[0].message,
        call('excludeBatchMessage_', ['DESTINATION_ROW_MISMATCH']), name);
      assert.deepEqual(destinationSnapshot(world), destinationBefore, name);
      assert.deepEqual(txRowsFor(world), txBefore, name);
      assert.deepEqual(reviewRowsFor(world), reviewBefore, name);
      assert.equal(reviewResolveAudit().length, auditBefore, name);
    }
  });

  test('sx 2: 読み返しで値が残ったら取引を CANCELED にしない', () => {
    const world = compactionWorld({count: 3});
    const target = reviewAt(world, 6);
    const targetRow = reviewDestinationRow(target);
    const sheet = destinationSheet(world);
    const realClear = gas.context.clearTransactionRows;
    let dirtied = false;
    const result = withMocks({clearTransactionRows(customer, rowNumbers, ...args) {
      const value = realClear.call(this, customer, rowNumbers, ...args);
      if (!dirtied && rowNumbers.map(Number).indexOf(targetRow) >= 0) {
        dirtied = true;
        sheet.getRange(targetRow, 3).setValue('残った値');
      }
      return value;
    }}, () => excludeOne(world, target));
    assert.equal(dirtied, true);
    assert.equal(result.resolved, 0);
    assert.equal(result.errors[0].code, 'DESTINATION_VALUE_MISMATCH');
    assert.equal(result.errors[0].message,
      call('excludeBatchMessage_', ['DESTINATION_VALUE_MISMATCH']));
    assert.equal(result.compaction, null);
    assert.equal(transactionFor(target.fullTxId).transactionStatus, 'REVIEW_REQUIRED');
    assert.equal(call('getReviewById', [target.reviewId]).status, 'OPEN');
    assert.equal(reviewResolveAudit().length, 0);
    assert.equal(sheet.getRange(targetRow, 3).getValue(), '残った値');
  });

  test('sx 3: リースを取ってから取引の状態と freee の状態を見直す', () => {
    for (const kind of ['CANCELED', 'IMPORTED']) {
      const world = compactionWorld({count: 2});
      const target = reviewAt(world, 5);
      const before = destinationSnapshot(world);
      const realRead = gas.context.getTransaction;
      let seen = 0;
      let tampered = false;
      const result = withMocks({getTransaction(fullTxId) {
        if (String(fullTxId) === String(target.fullTxId) && ++seen === 2 && !tampered) {
          tampered = true;
          if (kind === 'CANCELED') {
            call('updateTransactionStatus', [target.fullTxId, 'REVIEW_REQUIRED', 'CANCELED']);
          } else {
            setTxCell(target.fullTxId, 13, 'IMPORTED');
          }
        }
        return realRead.call(this, fullTxId);
      }}, () => excludeOne(world, target));
      assert.equal(tampered, true, kind);
      assert.equal(result.resolved, 0, kind);
      assert.equal(result.errors.length, 1, kind);
      assert.match(result.errors[0].message, kind === 'CANCELED' ?
        /取引の状態 CANCELED では対象外にできません/ :
        /freee 取込済みの取引のため、画面からは変更できません/, kind);
      assert.deepEqual(destinationSnapshot(world), before, kind);
      assert.equal(call('getReviewById', [target.reviewId]).status, 'OPEN', kind);
    }
  });

  test('sx 4: 既に空の行と行の無い取引は書かずに対象外にする', () => {
    // (a) 取引ログに記録があり、行が既に空 → ALREADY_CLEARED。
    const already = compactionWorld({count: 1});
    const alreadyTarget = reviewAt(already, 5);
    clearRow(already, 5);
    let cleared = 0;
    const realClear = gas.context.clearTransactionRows;
    const alreadyResult = withMocks({clearTransactionRows(...args) {
      cleared += 1;
      return realClear.apply(this, args);
    }}, () => excludeOne(already, alreadyTarget));
    assert.equal(cleared, 0);
    assert.equal(alreadyResult.resolved, 1);
    assert.equal(transactionFor(alreadyTarget.fullTxId).transactionStatus, 'CANCELED');
    assert.equal(call('getReviewById', [alreadyTarget.reviewId]).status, 'EXCLUDED');
    assert.equal(alreadyResult.compaction.reason, null);

    // (b) 行の無い取引 → NO_ROW。compaction は null。
    const noRow = compactionWorld({count: 1});
    const noRowTarget = reviewAt(noRow, 5);
    setTxCell(noRowTarget.fullTxId, 31, '');
    clearRow(noRow, 5);
    cleared = 0;
    const noRowResult = withMocks({clearTransactionRows(...args) {
      cleared += 1;
      return realClear.apply(this, args);
    }}, () => excludeOne(noRow, noRowTarget));
    assert.equal(cleared, 0);
    assert.equal(noRowResult.resolved, 1);
    assert.equal(noRowResult.compaction, null);
    assert.equal(transactionFor(noRowTarget.fullTxId).transactionStatus, 'CANCELED');
    assert.equal(call('getReviewById', [noRowTarget.reviewId]).status, 'EXCLUDED');
  });

  test('sx 5: 真ん中の 1 件は 1 件ずつとまとめてで同じ終わりの状態になる', () => {
    const singles = compactionWorld({count: 3});
    const singleTarget = reviewAt(singles, 6);
    assert.equal(excludeOne(singles, singleTarget).resolved, 1);
    const singleState = comparableState(singles);

    const batched = compactionWorld({count: 3});
    const batchTarget = reviewAt(batched, 6);
    const result = excludeBatch(batched, [batchTarget]);
    assert.equal(result.resolved, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(result.compactions.length, 1);
    assert.equal(result.compactions[0].compacted, true);
    assert.deepEqual(comparableState(batched), singleState);
  });

  // ---- 詰める ----

  test('cmp 1: 真ん中の行を対象外にすると下の行が上へ詰まる', () => {
    const world = compactionWorld({count: 5});
    const sheet = destinationSheet(world);
    sheet.getRange(8, 2).setNumberFormat('0.00');
    sheet.getRange(9, 5).setNumberFormat('#,##0');
    const before = destinationSnapshot(world);
    const beforeRows = before.values;
    const target = reviewAt(world, 7);
    const lowerTx = [8, 9].map((row) => transactionFor(txIdAt(world, row)));
    const lowerBefore = lowerTx.map((tx) => txRow(tx.fullTxId));
    const targetRowBefore = txRow(target.fullTxId);
    const result = excludeOne(world, target);
    assert.equal(result.resolved, 1);
    assert.equal(result.compaction.compacted, true);
    assert.equal(result.compaction.gapsClosed, 1);
    assert.equal(result.compaction.rowsMoved, 2);
    assert.equal(result.compaction.reason, null);

    const after = destinationSnapshot(world);
    const moveColumns = moveColumnIndexes(world);
    // 上 2 行は 1 セルも変わらない。
    [5, 6].forEach((row) => {
      assert.deepEqual(after.values[row - 1], beforeRows[row - 1], 'row ' + row);
    });
    // 行 7・8 の動かす列は元の行 8・9 の値と書式、行 9 は雛形の行 10 と同じ。
    moveColumns.forEach((index) => {
      assert.deepEqual(after.values[6][index], beforeRows[7][index], 'row7 col' + (index + 1));
      assert.deepEqual(after.values[7][index], beforeRows[8][index], 'row8 col' + (index + 1));
      assert.deepEqual(after.values[8][index], beforeRows[9][index], 'row9 col' + (index + 1));
    });
    assert.equal(after.formats[6][1], '0.00');
    assert.equal(after.formats[7][4], '#,##0');
    assert.equal(after.formats[8][1], before.formats[9][1]);
    // 比べる列は全行で前と同じ。
    const compare = [];
    for (let column = 1; column <= maxColumn(world); column += 1) {
      if (moveColumns.indexOf(column - 1) < 0) compare.push(column - 1);
    }
    compare.forEach((index) => {
      for (let row = 5; row <= 9; row += 1) {
        assert.deepEqual(after.values[row - 1][index], beforeRows[row - 1][index],
          'compare row ' + row + ' col ' + (index + 1));
        assert.deepEqual(after.formulas[row - 1][index], before.formulas[row - 1][index]);
      }
    });
    // 変わるのは F〜L の行の動かす列だけ。
    changedCells(before, after).forEach((diff) => {
      assert.ok(diff.row >= 7 && diff.row <= 9, 'changed row ' + diff.row);
      assert.ok(moveColumns.indexOf(diff.column - 1) >= 0, 'changed col ' + diff.column);
    });
    // 取引ログ：AE が 7・8、AS が更新、他は同じ。
    lowerTx.forEach((tx, index) => {
      const afterTx = txRow(tx.fullTxId);
      const beforeTx = lowerBefore[index];
      assert.equal(Number(afterTx[30]), 7 + index);
      // AE（31）と AS（45）以外は変えない。
      afterTx.forEach((value, column) => {
        if (column === 30 || column === 44) return;
        assert.equal(String(value), String(beforeTx[column]),
          'tx column ' + (column + 1));
      });
    });
    // 要確認の Y が 7・8（CSV のデータ行は 2 行目から）。
    assert.equal(Number(reviewRow(reviewForSource(world, 5).reviewId)[24]), 7);
    assert.equal(Number(reviewRow(reviewForSource(world, 6).reviewId)[24]), 8);
    // 対象外そのもの（CANCELED の AE）は変えない。
    assert.equal(Number(txRow(target.fullTxId)[30]), Number(targetRowBefore[30]));
    assert.equal(auditRows('DESTINATION_COMPACT').length, 1);
    // 画面の文。
    const notice = clientPlain('otherResultNotice(' + JSON.stringify(result) + ')');
    assert.match(notice.message, /転記行を消して下の行を上へ詰め、取引を対象外にしました。/);
    assert.deepEqual(notice.details, []);
  });

  test('cmp 2: 前からの空き行も含めて詰める', () => {
    const world = compactionWorld({count: 5});
    const before = destinationSnapshot(world);
    const clearedTxId = txIdAt(world, 6);
    clearRow(world, 6);
    // 行 6 は前の呼出しで対象外にした行（取引は CANCELED）。生きた取引の AE が
    // 空き行を指していると §2.2.6 で詰めないので、ここは対象外済みにする。
    setTxCell(clearedTxId, 10, 'CANCELED');
    const target = reviewAt(world, 8);
    const result = excludeOne(world, target);
    assert.equal(result.compaction.compacted, true);
    assert.equal(result.compaction.gapsClosed, 2);
    assert.equal(result.compaction.rowsMoved, 2);
    const after = sheetValues(world);
    const moveColumns = moveColumnIndexes(world);
    const beforeRows = before.values;
    // 行 5・7・9 の取引が 5・6・7 へ。
    moveColumns.forEach((index) => {
      assert.deepEqual(after[5][index], beforeRows[6][index], 'row6 col' + (index + 1));
      assert.deepEqual(after[6][index], beforeRows[8][index], 'row7 col' + (index + 1));
    });
    // 行 8・9 は空く行（G を除く動かす列が空）。
    [8, 9].forEach((row) => {
      moveColumns.forEach((index) => {
        if (index === 7) return;
        assert.equal(after[row - 1][index], '', 'vacated row ' + row + ' col ' + (index + 1));
      });
    });
    assert.equal(String(after[4][6]), String(beforeRows[4][6]), 'row5 tx');
  });

  test('cmp 3: いちばん下の行は詰めない', () => {
    const world = compactionWorld({count: 5});
    const target = reviewAt(world, 9);
    const before = destinationSnapshot(world);
    const result = excludeOne(world, target);
    assert.equal(result.resolved, 1);
    assert.equal(result.compaction.compacted, false);
    assert.equal(result.compaction.reason, null);
    const after = destinationSnapshot(world);
    for (let row = 5; row <= 8; row += 1) {
      assert.deepEqual(after.values[row - 1], before.values[row - 1], 'row ' + row);
    }
    assert.ok(moveColumnIndexes(world).every((index) =>
      index === 7 || after.values[8][index] === ''), 'bottom row cleared');
    assert.equal(auditRows('DESTINATION_COMPACT').length, 0);
  });

  test('cmp 4: 詰めない条件では行を空けたまま対象外だけ済ませる', () => {
    const scenarios = [
      ['UNKNOWN_ROW_CONTENT', (world) => {
        clearRow(world, 8);
        destinationSheet(world).getRange(8, 3).setValue('手入力');
      }],
      ['NO_TEMPLATE_ROW_BELOW', () => {}, {maxRows: 9}],
      ['MANUAL_EDIT', (world) => {
        destinationSheet(world).getRange(9, 10).setValue(123);
      }],
      ['MANUAL_EDIT', (world) => {
        destinationSheet(world).getRange(8, 9).setValue('別科目');
      }],
      ['ROW_LOG_MISMATCH', (world) => {
        setTxCell(txIdAt(world, 9), 31, 12);
      }],
      ['LEGACY_LOCATION', (world) => {
        const txId = txIdAt(world, 9);
        setTxCell(txId, 29, '');
        setTxCell(txId, 30, '');
      }],
      ['TX_STATE', (world) => {
        setTxCell(txIdAt(world, 9), 10, 'PREPARED');
      }],
      ['FREEE_IMPORTED', (world) => {
        setTxCell(txIdAt(world, 9), 13, 'IMPORTED');
      }],
      ['OTHER_LEASE', (world) => {
        call('acquireLease', ['C001', 'other_file', 'OTHER_RUN',
          'other@example.com', 'WRITE_ONLY']);
      }]
    ];
    scenarios.forEach(([reason, tamper, options]) => {
      const world = compactionWorld(Object.assign({count: 5}, options || {}));
      const target = reviewAt(world, 7);
      const targetTxId = target.fullTxId;
      tamper(world);
      const destinationBefore = destinationSnapshot(world);
      const txBefore = txRowsFor(world);
      const reviewBefore = reviewRowsFor(world);
      const result = excludeOne(world, target);
      assert.equal(result.resolved, 1, reason);
      assert.equal(result.compaction.compacted, false, reason);
      assert.equal(result.compaction.reason, reason, reason);
      assert.equal(result.compaction.reasonText,
        call('destinationCompactionReasonText_', [reason]), reason);
      // 対象外そのものは済んでいる。
      assert.equal(transactionFor(targetTxId).transactionStatus, 'CANCELED', reason);
      assert.equal(call('getReviewById', [target.reviewId]).status, 'EXCLUDED', reason);
      assert.ok(moveColumnIndexes(world).every((index) =>
        index === 7 || destinationSnapshot(world).values[6][index] === ''),
      'row 7 is empty (' + reason + ')');
      // 他の行・他の取引・他の要確認は 1 セルも変わらない。
      const after = destinationSnapshot(world);
      destinationBefore.values.forEach((row, index) => {
        if (index === 6) return;
        assert.deepEqual(after.values[index], row, reason + ' row ' + (index + 1));
      });
      txBefore.forEach((entry) => {
        if (String(entry.row && entry.row[0]) === String(targetTxId)) return;
        assert.deepEqual(txRow(entry.row[0]), entry.row, reason + ' tx');
      });
      reviewBefore.forEach((entry) => {
        if (String(entry.row[0]) === String(target.reviewId)) return;
        assert.deepEqual(reviewRow(entry.row[0]), entry.row, reason + ' review');
      });
      // 画面の詳細。
      const notice = clientPlain('otherResultNotice(' + JSON.stringify(result) + ')');
      assert.ok(notice.details.indexOf('空いた行は詰めずに残しました（' +
        call('destinationCompactionReasonText_', [reason]) + '）。') >= 0, reason);
    });
  });

  test('cmp 5: 科目一覧のセルは詰めても変わらない', () => {
    const world = compactionWorld({count: 5, accountList: true});
    const sheet = destinationSheet(world);
    const beforeAccountList = plain(sheet.getRange(5, 9, 16, 2).getValues());
    const target = reviewAt(world, 7);
    const result = excludeOne(world, target);
    assert.equal(result.compaction.compacted, true);
    assert.deepEqual(plain(sheet.getRange(5, 9, 16, 2).getValues()), beforeAccountList);
  });

  test('cmp 6: G 列（キャッシュバックの対象外）も一緒に動く', () => {
    const world = compactionWorld({count: 5});
    const sheet = destinationSheet(world);
    sheet.getRange(9, 8).setValue('対象外');
    const target = reviewAt(world, 7);
    const result = excludeOne(world, target);
    assert.equal(result.compaction.compacted, true);
    assert.equal(sheet.getRange(8, 8).getValue(), '対象外');
    assert.equal(sheet.getRange(9, 8).getValue(), sheet.getRange(10, 8).getValue());
  });

  function failSettleOnce() {
    const advanced = gas.context.Sheets.Spreadsheets;
    const realUpdate = advanced.batchUpdate;
    const values = gas.context.Sheets.Spreadsheets.Values;
    const realValuesUpdate = values.batchUpdate;
    let moved = false;
    let failed = false;
    advanced.batchUpdate = function(request) {
      const value = realUpdate.apply(this, arguments);
      if ((request.requests || []).some((item) => item.copyPaste)) moved = true;
      return value;
    };
    values.batchUpdate = function(request) {
      const data = (request && request.data) || [];
      if (moved && !failed &&
          data.some((entry) => String(entry.range).indexOf('クレカ取引ログ') >= 0)) {
        failed = true;
        throw Object.assign(new Error('取引ログの書込に失敗'), {code: 'TEST_SETTLE_FAILURE'});
      }
      return realValuesUpdate.apply(this, arguments);
    };
    return {
      restore() {
        advanced.batchUpdate = realUpdate;
        values.batchUpdate = realValuesUpdate;
      },
      failed() { return failed; }
    };
  }

  test('cmp 7: 印を書いた後に止まったら、その顧客の書込を全部止めて次の呼出しで直す', () => {
    const world = compactionWorld({count: 5});
    const target = reviewAt(world, 7);
    const before = destinationSnapshot(world);
    const fault = failSettleOnce();
    let result;
    try {
      result = excludeOne(world, target);
    } finally {
      fault.restore();
    }
    assert.equal(fault.failed(), true);
    assert.equal(result.resolved, 1);
    assert.equal(result.compaction.compacted, false);
    assert.equal(result.compaction.reason, 'COMPACTION_PENDING');
    assert.ok(call('readDestinationCompactionMarker_'), 'marker remains');

    const leaseId = acquireWriteLease(world, world.fileId, 'BLOCKED_RUN');
    const customer = customerWithDestination(world);
    const blockedBefore = destinationSnapshot(world);
    const attempts = [
      ['writeTransactionRows', [customer, [{rowNumber: 9, fullTxId: 'TEST',
        values: {b: '2025-01-01'}}], leaseId, world.fileId]],
      ['clearTransactionRows', [customer, [9], leaseId, world.fileId]],
      ['reserveDestinationRows', [customer, ['TEST_RESERVE'], world.fileId, leaseId]]
    ];
    attempts.forEach(([name, args]) => {
      const error = caught(() => call(name, args));
      assert.equal(error.code, 'DESTINATION_COMPACTION_PENDING', name);
    });
    assert.deepEqual(destinationSnapshot(world), blockedBefore, '門は 1 セルも書かない');

    // 別の顧客の書込は通る。
    const otherCustomer = addCustomer(world.world, {suffix: '2', customerId: 'C002',
      customerName: '顧客二'});
    const otherLease = call('acquireLease', ['C002', 'other_file', 'OTHER_RUN',
      'reviewer@example.com', 'WRITE_ONLY']);
    const otherDestination = Object.assign({}, call('getCustomerById', ['C002']), {
      destinationSpreadsheetId: otherCustomer.destinationId,
      destinationSheetName: '入力用シート'
    });
    assert.doesNotThrow(() => call('clearTransactionRows',
      [otherDestination, [5], otherLease, 'other_file']));

    // 次の Web アプリの呼出しで AE・Y を直し、印を消す。
    call('webAppListReviews', ['C001', 15, 0]);
    assert.equal(call('readDestinationCompactionMarker_'), null);
    assert.equal(Number(txRow(txIdAt(world, 7))[30]), 7);
    assert.equal(Number(txRow(txIdAt(world, 8))[30]), 8);
    assert.equal(Number(reviewRow(reviewForSource(world, 5).reviewId)[24]), 7);
    assert.equal(Number(reviewRow(reviewForSource(world, 6).reviewId)[24]), 8);

    // その後は書ける。
    assert.doesNotThrow(() => call('clearTransactionRows',
      [customer, [9], leaseId, world.fileId]));
    assert.equal(auditRows('DESTINATION_COMPACT').length, 1);
  });

  test('cmp 8: 直せない印は残り、書込は止まったまま', () => {
    const world = compactionWorld({count: 5});
    const target = reviewAt(world, 7);
    const fault = failSettleOnce();
    let result;
    try {
      result = excludeOne(world, target);
    } finally {
      fault.restore();
    }
    assert.equal(result.compaction.reason, 'COMPACTION_PENDING');
    // F〜L に同じ取引 ID を 2 行入れる。
    const txId = txIdAt(world, 7);
    destinationSheet(world).getRange(9, 7).setValue(txId);
    call('webAppListReviews', ['C001', 15, 0]);
    assert.ok(call('readDestinationCompactionMarker_'), 'marker remains');
    const leaseId = acquireWriteLease(world, world.fileId, 'BLOCKED_RUN_2');
    const error = caught(() => call('clearTransactionRows',
      [customerWithDestination(world), [9], leaseId, world.fileId]));
    assert.equal(error.code, 'DESTINATION_COMPACTION_PENDING');
  });

  test('cmp 9: 動かす要求が適用されなければ AE を変えずに印を消して失敗を返す', () => {
    const world = compactionWorld({count: 5});
    const target = reviewAt(world, 7);
    const before = destinationSnapshot(world);
    const lower = [8, 9].map((row) => transactionFor(txIdAt(world, row)));
    const advanced = gas.context.Sheets.Spreadsheets;
    const realUpdate = advanced.batchUpdate;
    let attempted = false;
    advanced.batchUpdate = function(request) {
      if ((request.requests || []).some((item) => item.copyPaste)) {
        attempted = true;
        throw Object.assign(new Error('動かせません'), {code: 'TEST_MOVE_FAILURE'});
      }
      return realUpdate.apply(this, arguments);
    };
    let result;
    try {
      result = excludeOne(world, target);
    } finally {
      advanced.batchUpdate = realUpdate;
    }
    assert.equal(attempted, true);
    assert.equal(result.resolved, 1);
    assert.equal(result.compaction.compacted, false);
    assert.equal(result.compaction.reason, 'COMPACTION_FAILED');
    assert.equal(call('readDestinationCompactionMarker_'), null);
    assert.equal(Number(txRow(lower[0].fullTxId)[30]), 8);
    assert.equal(Number(txRow(lower[1].fullTxId)[30]), 9);
    const after = destinationSnapshot(world);
    assert.deepEqual(after.values[7], before.values[7]);
    assert.deepEqual(after.values[8], before.values[8]);
    assert.ok(moveColumnIndexes(world).every((index) =>
      index === 7 || after.values[6][index] === ''), 'row 7 remains empty');
  });

  test('cmp 10: 行は 1 回の batchUpdate で動かす', () => {
    const world = compactionWorld({count: 5});
    const target = reviewAt(world, 7);
    const advanced = gas.context.Sheets.Spreadsheets;
    const realUpdate = advanced.batchUpdate;
    let calls = 0;
    advanced.batchUpdate = function(request) {
      if ((request.requests || []).some((item) => item.copyPaste)) calls += 1;
      return realUpdate.apply(this, arguments);
    };
    let result;
    try {
      result = excludeOne(world, target);
    } finally {
      advanced.batchUpdate = realUpdate;
    }
    assert.equal(result.compaction.compacted, true);
    assert.equal(calls, 1);
  });

  test('cmp 11: まとめて対象外は転記先ごとに 1 回だけ詰める', () => {
    const world = compactionWorld({count: 5});
    const targets = [reviewAt(world, 6), reviewAt(world, 8)];
    const before = destinationSnapshot(world);
    const result = excludeBatch(world, targets);
    assert.equal(result.ok, true);
    assert.equal(result.resolved, 2);
    assert.deepEqual(result.errors, []);
    assert.equal(result.compactions.length, 1);
    assert.equal(result.compactions[0].compacted, true);
    assert.equal(result.compactions[0].gapsClosed, 2);
    assert.equal(result.compactions[0].rowsMoved, 2);
    // 行 5・7・9 の取引が 5・6・7 へ。
    const after = sheetValues(world);
    assert.equal(String(after[5][6]), String(before.values[6][6]));
    assert.equal(String(after[6][6]), String(before.values[8][6]));
    // 詰める処理の結果は件ごとの結果に影響しない。
    const plainWorld = compactionWorld({count: 5});
    const plainTargets = [reviewAt(plainWorld, 6), reviewAt(plainWorld, 8)];
    const realCompact = gas.context.compactDestinationAfterExclusion_;
    const plainResult = withMocks({compactDestinationAfterExclusion_() {
      return {compacted: false, reason: null, reasonText: null,
        gapsClosed: 0, rowsMoved: 0, ms: 0, reads: 0};
    }}, () => excludeBatch(plainWorld, plainTargets));
    const sourceRows = (source, ids) => ids.map((id) =>
      reviewSourceRow(source.reviews.find((review) => review.reviewId === id)))
      .sort((a, b) => a - b);
    assert.deepEqual(sourceRows(world, result.resolvedReviewIds),
      sourceRows(plainWorld, plainResult.resolvedReviewIds));
    assert.deepEqual(result.errors, plainResult.errors);
    assert.deepEqual(result.skippedByLeaseReviewIds, plainResult.skippedByLeaseReviewIds);
    assert.deepEqual(result.notAttemptedReviewIds, plainResult.notAttemptedReviewIds);
    // 画面の文。
    assert.equal(clientEval('otherCompactionLeadText(' + JSON.stringify(result.compactions) + ')'),
      '転記先の空いた行を詰めました。');
    assert.deepEqual(clientPlain('otherCompactionDetails(' +
      JSON.stringify(result.compactions) + ')'), []);
  });

  test('cmp 12: ログに明細の値・店名・ファイル名・取引先名・ID を出さない', () => {
    const merchant = '架空詰店';
    const fileName = '架空詰ログ.csv';
    const amount = 987641;
    const world = compactionWorld({count: 3, name: fileName,
      rows: [
        `2025/01/05,${merchant},${amount},仕入れ`,
        '2025/01/06,既知店,1200,仕入れ',
        '2025/01/07,既知店,1300,仕入れ'
      ]});
    const target = reviewAt(world, 6);
    const destinationId = String(world.destinationSpreadsheetId);
    const result = excludeBatch(world, [target]);
    assert.equal(result.resolved, 1);
    assert.equal(result.compactions[0].compacted, true);
    const logs = gas.stubs.getLogs().filter((line) =>
      line.startsWith('DESTINATION_COMPACT ') || line.startsWith('EXCLUDE_BATCH '));
    assert.ok(logs.some((line) => line.startsWith('DESTINATION_COMPACT ')));
    assert.ok(logs.some((line) => line.startsWith('EXCLUDE_BATCH ')));
    const txIds = world.reviews.map((review) => String(review.fullTxId));
    logs.forEach((line) => {
      assert.equal(line.includes(destinationId), false, '転記先の ID');
      assert.equal(line.includes(merchant), false, '店名');
      assert.equal(line.includes(fileName), false, 'ファイル名');
      assert.equal(line.includes(String(amount)), false, '金額');
      txIds.forEach((txId) => assert.equal(line.includes(txId), false, '取引 ID'));
    });
  });

  test('cmp 13: 詰める処理の読取は取引の数に依らない', () => {
    const measure = (world, target) => {
      const realCompact = gas.context.compactDestinationAfterExclusion_;
      let compactionReads = 0;
      let totalReads = 0;
      gas.stubs.resetApiCallCounts();
      const result = withMocks({compactDestinationAfterExclusion_(...args) {
        const before = gas.stubs.getApiCallCounts().batchGet;
        const value = realCompact.apply(this, args);
        compactionReads = gas.stubs.getApiCallCounts().batchGet - before;
        return value;
      }}, () => {
        const before = gas.stubs.getApiCallCounts().batchGet;
        const value = excludeOne(world, target);
        totalReads = gas.stubs.getApiCallCounts().batchGet - before;
        return value;
      });
      return {result, compactionReads, totalReads, exclusionReads: totalReads - compactionReads};
    };
    const five = compactionWorld({count: 5});
    const fiveResult = measure(five, reviewAt(five, 7));
    const fifty = compactionWorld({count: 50, maxRows: 60});
    const fiftyResult = measure(fifty, reviewAt(fifty, 30));
    console.log('CMP13_READS ' + JSON.stringify({
      five: fiveResult.compactionReads, fifty: fiftyResult.compactionReads,
      fiveTotal: fiveResult.totalReads, fiftyTotal: fiftyResult.totalReads,
      fiveExclusion: fiveResult.exclusionReads, fiftyExclusion: fiftyResult.exclusionReads
    }));
    assert.equal(fiveResult.result.compaction.compacted, true);
    assert.equal(fiftyResult.result.compaction.compacted, true);
    assert.equal(fiveResult.compactionReads, fiftyResult.compactionReads);
    assert.equal(fiveResult.exclusionReads, fiftyResult.exclusionReads);
  });

  test('cmp 14: 数式の形は行をまたいで同じ、値とは別', () => {
    assert.equal(call('relativeFormula_', ['=N5+L6-M6', 6]),
      call('relativeFormula_', ['=N6+L7-M7', 7]));
    assert.equal(call('relativeFormula_', ['=$N$4+L6', 6]),
      call('relativeFormula_', ['=$N$4+L7', 7]));
    assert.notEqual(call('relativeFormula_', ['=N5+L6-M6', 6]),
      call('relativeFormula_', ['=N4+L6-M6', 6]));
    assert.equal(call('relativeFormula_', ['=$N$4+L6', 6]), '=$N$4+L0');
    assert.equal(call('destinationCellShape_', ['=N5', null, 6]), 'F:=N-1');
    assert.equal(call('destinationCellShape_', [null, '=N5', 6]), 'V:"=N5"');
    assert.notEqual(call('destinationCellShape_', ['=N5', null, 6]),
      call('destinationCellShape_', [null, '=N5', 6]));
  });

  test('cmp 15: F より上の行は触らない', () => {
    const world = compactionWorld({count: 5});
    makeAboveRow(world);
    const upperBefore = rowAt(world, 5);
    const target = reviewAt(world, 8);
    const result = excludeOne(world, target);
    assert.equal(result.compaction.compacted, true);
    assert.deepEqual(rowAt(world, 5), upperBefore);
  });

  // ---- 画面 ----

  function noticeResult(compaction, code = 'EXCLUDE_PRIOR_YEAR') {
    return {
      ok: true, reviewId: 'r1', code, label: code === 'EXCLUDE_PRIOR_YEAR' ?
        '前年の利用分として対象外にする（転記行を空にします）' :
        '対象外にする（転記行を空にします）',
      reviewType: 'PRIOR_YEAR', typeLabel: '前年利用日', scope: 'TRANSACTION',
      fileId: 'f1', fileName: '架空明細.csv', resolved: 1, committed: 0,
      unmetTexts: [], completedFiles: [], rewound: false, errors: [],
      notAttempted: 0, skippedByLease: 0, compaction
    };
  }

  test('cmpu 1: 1 件ずつのお知らせは詰めた・詰めなかった・無しで変わる', () => {
    const compacted = clientPlain('otherResultNotice(' + JSON.stringify(noticeResult({
      compacted: true, reason: null, reasonText: null, gapsClosed: 1,
      rowsMoved: 2, ms: 1, reads: 3
    })) + ')');
    assert.equal(compacted.message,
      '「前年利用日」の要確認を確定しました（前年の利用分として対象外にする（転記行を空にします））。' +
      '転記行を消して下の行を上へ詰め、取引を対象外にしました。');
    assert.equal(compacted.kind, 'success');
    assert.deepEqual(compacted.details, []);

    const notCompacted = clientPlain('otherResultNotice(' + JSON.stringify(noticeResult({
      compacted: false, reason: 'OTHER_LEASE',
      reasonText: 'この顧客のほかの処理（取込や確定）が動いています',
      gapsClosed: 0, rowsMoved: 0, ms: 1, reads: 3
    })) + ')');
    assert.equal(notCompacted.message,
      '「前年利用日」の要確認を確定しました（前年の利用分として対象外にする（転記行を空にします））。' +
      '転記行を空にし、取引を対象外にしました。');
    assert.equal(notCompacted.kind, 'success');
    assert.deepEqual(notCompacted.details,
      ['空いた行は詰めずに残しました（この顧客のほかの処理（取込や確定）が動いています）。']);

    const none = clientPlain('otherResultNotice(' + JSON.stringify(noticeResult(null)) + ')');
    assert.match(none.message, /転記行を空にし、取引を対象外にしました。/);
    assert.deepEqual(none.details, []);
  });

  test('cmpu 2: まとめてのお知らせは詰めた・詰めなかったを出す', () => {
    const compactions = [
      {compacted: true, reason: null, reasonText: null},
      {compacted: false, reason: 'OTHER_LEASE',
        reasonText: 'この顧客のほかの処理（取込や確定）が動いています'},
      {compacted: false, reason: 'OTHER_LEASE',
        reasonText: 'この顧客のほかの処理（取込や確定）が動いています'},
      {compacted: false, reason: 'MANUAL_EDIT',
        reasonText: '手で直した跡のある行があります（数式・既定値の列）'}
    ];
    assert.equal(clientEval('otherCompactionLeadText(' + JSON.stringify(compactions) + ')'),
      '転記先の空いた行を詰めました。');
    const details = clientPlain('otherCompactionDetails(' +
      JSON.stringify(compactions) + ')');
    assert.deepEqual(details, [
      '空いた行は詰めずに残しました（この顧客のほかの処理（取込や確定）が動いています）。',
      '空いた行は詰めずに残しました（手で直した跡のある行があります（数式・既定値の列））。'
    ]);
    assert.equal(clientEval('otherCompactionLeadText([])'), '');
    assert.deepEqual(clientPlain('otherCompactionDetails([])'), []);
  });

  test('cmpu 3: 対象外の確認の文は詰めることを説明する', () => {
    const expected = '転記行を消し、下の行を上へ詰めて、取引を対象外にします' +
      '（安全に詰められないときは行を空けたままにします）。' +
      '取り消せません（戻すには管理者による再取込が必要です）。';
    assert.equal(clientEval("TEXT.otherEffect('EXCLUDE_PRIOR_YEAR', {})"), expected);
    assert.equal(clientEval("TEXT.otherEffect('EXCLUDE', {})"), expected);
  });

  // ---- 変異で赤にならなかった条件のための追加 ----

  test('cmp 16: 手で直した跡が上の行にあっても F より上なら詰める', () => {
    const world = compactionWorld({count: 5});
    makeAboveRow(world);
    destinationSheet(world).getRange(5, 9).setValue('手で直した科目');
    const target = reviewAt(world, 8);
    const result = excludeOne(world, target);
    assert.equal(result.compaction.compacted, true);
  });

  /**
   * 取引ログに、転記先の行を指すだけの取引を 1 行足す（§2.2.6 の材料）。
   * 要確認は作らない（AE が指す先だけを見る検査なので足りる）。
   */
  function addStrayTransaction(options) {
    const values = blank(49);
    values[0] = options.fullTxId;
    values[1] = options.fullTxId;
    values[3] = 'C001';
    values[4] = 'stray_file';
    values[9] = options.status;
    values[12] = 'NOT_IMPORTED';
    values[28] = options.spreadsheetId || '';
    values[29] = options.sheetName || '';
    values[30] = options.rowNumber;
    values[41] = 'TRUE';
    const sheet = txLogSheet();
    sheet.appendRow(values);
    const rowNumber = sheet.getLastRow();
    return {rowNumber, values: plain(sheet.getRange(rowNumber, 1, 1, 49).getValues()[0])};
  }

  /**
   * 詰めなかったことを、転記先・取引ログ・要確認の 3 つで確かめる。
   * 転記先は対象外にした行が空になっただけで、他の行は 1 セルも変わらない。
   */
  function assertNotCompacted(world, target, before, strayRowNumber) {
    const after = destinationSnapshot(world);
    const moveColumns = moveColumnIndexes(world);
    const targetRow = 7;
    after.values.forEach((row, index) => {
      if (index === targetRow - 1) return;
      assert.deepEqual(row, before.destination.values[index], 'row ' + (index + 1));
    });
    moveColumns.forEach((index) => {
      if (index === 7) return; // G は空にしない（§2.2.2）
      assert.equal(after.values[targetRow - 1][index], '', 'row 7 col ' + (index + 1));
    });
    // 比べる列は変わらない（数式・既定値・残高）。
    for (let column = 1; column <= maxColumn(world); column += 1) {
      if (moveColumns.indexOf(column - 1) >= 0) continue;
      assert.deepEqual(after.values[targetRow - 1][column - 1],
        before.destination.values[targetRow - 1][column - 1], 'compare col ' + column);
    }
    // 動くはずだった取引の AE は動いていない（要確認の Y は下の一覧の比較で見る）。
    [8, 9].forEach((row) => {
      assert.equal(Number(txRow(txIdAt(world, row))[30]), row, 'tx AE row ' + row);
    });
    // 取引ログは足した 1 行も含めて変わらない（対象の取引は除く）。
    before.txRows.forEach((entry) => {
      if (String(entry.fullTxId) === String(target.fullTxId)) return;
      assert.deepEqual(txRow(entry.fullTxId), entry.row, 'tx ' + entry.fullTxId);
    });
    const strayAfter = plain(txLogSheet().getRange(strayRowNumber, 1, 1, 49).getValues()[0]);
    assert.deepEqual(strayAfter, before.stray, 'stray transaction');
    // 要確認も対象の 1 件以外は変わらない。
    before.reviews.forEach((entry) => {
      if (String(entry.reviewId) === String(target.reviewId)) return;
      assert.deepEqual(reviewRow(entry.reviewId), entry.row, 'review ' + entry.reviewId);
    });
  }

  function captureBefore(world, strayRowNumber) {
    return {
      destination: destinationSnapshot(world),
      txRows: world.reviews.map((review) => ({fullTxId: review.fullTxId,
        row: txRow(review.fullTxId)})),
      reviews: world.reviews.map((review) => ({reviewId: review.reviewId,
        row: reviewRow(review.reviewId)})),
      stray: plain(txLogSheet().getRange(strayRowNumber, 1, 1, 49).getValues()[0])
    };
  }

  test('cmp 17: F〜L の行を AE で指す生きた取引があれば詰めない', () => {
    // (a) 転記先の記録があり、AE が空き行（7）を指す REVIEW_REQUIRED の取引。
    const a = compactionWorld({count: 5});
    const strayA = addStrayTransaction({fullTxId: 'STRAY_A', status: 'REVIEW_REQUIRED',
      spreadsheetId: a.destinationSpreadsheetId, sheetName: '入力用シート', rowNumber: 7});
    const targetA = reviewAt(a, 7);
    const beforeA = captureBefore(a, strayA.rowNumber);
    const resultA = excludeOne(a, targetA);
    assert.equal(resultA.resolved, 1);
    assert.equal(resultA.compaction.compacted, false);
    assert.equal(resultA.compaction.reason, 'ROW_LOG_MISMATCH');
    assert.equal(call('readDestinationCompactionMarker_'), null);
    assertNotCompacted(a, targetA, beforeA, strayA.rowNumber);

    // (b) 転記先の記録（AC）が空で、転記先そのものが顧客マスターの雛形。
    // Web の取込は雛形へ直接書けない（`webAppValidateDestination_`）ので、
    // 顧客マスターの転記先がこの転記先と同じ世界を部品へ直接渡す。
    const b = compactionWorld({count: 5});
    const masterB = call('getCustomerById', [b.customer.customerId]);
    const contextCustomer = Object.assign({}, masterB, {
      destinationSpreadsheetId: b.destinationSpreadsheetId,
      destinationSheetName: '入力用シート'
    });
    const destB = Object.assign({}, customerWithDestination(b));
    setTxCell(txIdAt(b, 7), 10, 'CANCELED');
    clearRow(b, 7);
    const strayB = addStrayTransaction({fullTxId: 'STRAY_B', status: 'REVIEW_REQUIRED',
      rowNumber: 7});
    const beforeB = destinationSnapshot(b);
    const txBeforeB = [8, 9].map((row) => txRow(txIdAt(b, row)));
    const leaseB = acquireWriteLease(b, b.fileId, 'CMP17_B');
    const resultB = call('compactDestinationAfterExclusion_', [destB, {
      leaseId: leaseB, fileId: b.fileId, actor: 'reviewer@example.com',
      customer: contextCustomer}]);
    assert.equal(resultB.compacted, false);
    assert.equal(resultB.reason, 'ROW_LOG_MISMATCH');
    assert.deepEqual(destinationSnapshot(b), beforeB, 'b: 1 セルも書かない');
    [8, 9].forEach((row, index) => {
      assert.deepEqual(txRow(txIdAt(b, row)), txBeforeB[index], 'b: tx row ' + row);
    });
    const strayAfterB = plain(txLogSheet().getRange(strayB.rowNumber, 1, 1, 49).getValues()[0]);
    assert.deepEqual(strayAfterB, strayB.values, 'b: stray transaction');

    // (d) 転記先の記録（AC）が空で、要確認の M 列がこの転記先（複製）を指す。
    // 解決操作は要確認の M・N 列の転記先へも書くので、詰めてはいけない。
    const d = compactionWorld({count: 5});
    const strayD = addStrayTransaction({fullTxId: 'STRAY_D', status: 'REVIEW_REQUIRED',
      rowNumber: 7});
    const strayReviewD = call('registerReview', [{
      reviewType: 'PRIOR_YEAR', fullTxId: 'STRAY_D', fileId: 'stray_file',
      customerId: d.customer.customerId,
      destinationSpreadsheetId: d.destinationSpreadsheetId,
      destinationSheetName: '入力用シート'}]);
    assert.equal(strayReviewD.registered, true);
    const strayReviewBeforeD = reviewRow(strayReviewD.reviewId);
    const targetD = reviewAt(d, 7);
    const beforeD = captureBefore(d, strayD.rowNumber);
    const resultD = excludeOne(d, targetD);
    assert.equal(resultD.resolved, 1);
    assert.equal(resultD.compaction.compacted, false);
    assert.equal(resultD.compaction.reason, 'ROW_LOG_MISMATCH');
    assert.equal(call('readDestinationCompactionMarker_'), null);
    assertNotCompacted(d, targetD, beforeD, strayD.rowNumber);
    assert.deepEqual(reviewRow(strayReviewD.reviewId), strayReviewBeforeD,
      'd: 要確認は 1 セルも変えない');

    // (c) AE が F〜L を指す取引が CANCELED だけなら詰める（書く経路が無い）。
    const c = compactionWorld({count: 5});
    addStrayTransaction({fullTxId: 'STRAY_C', status: 'CANCELED',
      spreadsheetId: c.destinationSpreadsheetId, sheetName: '入力用シート', rowNumber: 7});
    const targetC = reviewAt(c, 7);
    const movingIdsC = [8, 9].map((row) => txIdAt(c, row));
    const resultC = excludeOne(c, targetC);
    assert.equal(resultC.compaction.compacted, true);
    assert.equal(resultC.compaction.rowsMoved, 2);
    assert.equal(txIdAt(c, 7), movingIdsC[0]);
    assert.equal(txIdAt(c, 8), movingIdsC[1]);
  });

  test('cmp 18: Script Properties が読めなくても Web アプリの関数は呼ぶ', () => {
    const world = compactionWorld({count: 3});
    const properties = gas.context.PropertiesService.getScriptProperties();
    let markerReads = 0;
    const result = withMocks({PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) {
            if (String(key) === 'DESTINATION_COMPACTION_PENDING') {
              markerReads += 1;
              throw new Error('Script Properties を読めません');
            }
            return properties.getProperty(key);
          },
          setProperty(key, value) { return properties.setProperty(key, value); },
          deleteProperty(key) { return properties.deleteProperty(key); }
        };
      }
    }}, () => call('webAppListReviews', [world.customer.customerId, 15, 0]));
    assert.equal(markerReads, 1);
    assert.ok(Array.isArray(result.otherReviews));
    assert.ok(result.otherReviews.length > 0);
  });
};

'use strict';

/**
 * freee 取込用 Excel のサーバー側（仕様 `work/spec_freee_export.md` 版 1.0）。
 *
 * 値はすべて架空である。顧客 K9001・架空 太郎・テストカード。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const blank = (length) => Array(length).fill('');
  const call = (name, args = []) => {
    const result = gas.call(name, args);
    return result === undefined ? undefined : plain(result);
  };
  const caught = (fn) => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    assert.fail('expected the call to throw');
  };

  const CUSTOMER_ID = 'K9001';
  const CUSTOMER_NAME = '架空 太郎';
  const TEMPLATE_ID = 'template';
  const DESTINATION_ID = 'destination';
  const DESTINATION_NAME = CUSTOMER_NAME + '_20261115-1000';
  const INPUT_SHEET = '入力用シート';
  const IMPORT_SHEET = '取込用';
  const HEADER_ROW = 4;
  const WORK_FOLDER = 'work-folder';
  const FILE_ID = 'fake-file-1';

  const HEADERS = [
    '日付', '伝票番号', '決算整理仕訳',
    '借方勘定科目', '借方科目コード', '借方補助科目', '借方取引先',
    '借方取引先コード', '借方部門', '借方品目', '借方メモタグ',
    '借方セグメント1', '借方セグメント2', '借方セグメント3',
    '借方金額', '借方税区分', '借方税額',
    '貸方勘定科目', '貸方科目コード', '貸方補助科目', '貸方取引先',
    '貸方取引先コード', '貸方部門', '貸方品目', '貸方メモタグ',
    '貸方セグメント1', '貸方セグメント2', '貸方セグメント3',
    '貸方金額', '貸方税区分', '貸方税額', '摘要'
  ];

  const TAX_10 = '課対仕入10%';
  const TAX_LIGHT = '課対仕入8%（軽）';

  function serial(iso) {
    const parts = String(iso).split('-').map(Number);
    return Math.round((Date.UTC(parts[0], parts[1] - 1, parts[2]) -
      Date.UTC(1899, 11, 30)) / 86400000);
  }

  function isEmpty(value) {
    if (value === undefined || value === null || value === '') return true;
    if (typeof value === 'number' && value === 0) return true;
    return typeof value === 'string' && value.trim() === '';
  }

  function normalizeRow(row, width) {
    const out = [];
    for (let index = 0; index < width; index += 1) {
      const value = row && row[index];
      out.push(value === undefined || value === null ? '' : value);
    }
    return out;
  }

  function inputHeader() {
    const header = blank(12);
    header[1] = '利用日';
    header[2] = '取引先';
    header[3] = '摘要';
    header[4] = 'メモ';
    header[5] = '支出金額';
    header[6] = '相手税区分';
    header[7] = '勘定科目';
    header[8] = '収入金額';
    header[9] = '内部取引ID';
    header[10] = 'freee取引先名';
    header[11] = '備考';
    return header;
  }

  function inputRow(spec) {
    const row = blank(12);
    row[1] = spec.date === undefined ? serial('2026-11-01') : spec.date;
    row[2] = '架空取引先';
    row[3] = spec.description === undefined ? '架空の摘要' : spec.description;
    row[4] = 'メモ';
    row[5] = spec.expense === undefined ? '' : spec.expense;
    row[6] = spec.tax === undefined ? '' : spec.tax;
    row[7] = '架空経費';
    row[8] = spec.income === undefined ? '' : spec.income;
    row[9] = spec.txId === undefined ? '' : spec.txId;
    row[10] = '架空店';
    row[11] = '';
    return row;
  }

  function importRow(spec) {
    const row = blank(32);
    row[0] = spec.date === undefined ? serial('2026-11-01') : spec.date;
    row[1] = spec.slip === undefined ? '1' : spec.slip;
    row[2] = spec.closing === undefined ? '' : spec.closing;
    row[3] = spec.debitAccount === undefined ? '架空経費' : spec.debitAccount;
    row[9] = spec.item === undefined ? '架空品目' : spec.item;
    row[10] = spec.memoTag === undefined ? '' : spec.memoTag;
    row[14] = spec.amount === undefined ? '' : spec.amount;
    row[15] = spec.debitTax === undefined ? '' : spec.debitTax;
    row[16] = spec.debitTaxAmount === undefined ? '' : spec.debitTaxAmount;
    row[17] = spec.creditAccount === undefined ? 'テストカード' : spec.creditAccount;
    row[28] = spec.amount === undefined ? '' : spec.amount;
    row[29] = spec.creditTax === undefined ? '' : spec.creditTax;
    row[30] = spec.creditTaxAmount === undefined ? '' : spec.creditTaxAmount;
    row[31] = spec.note === undefined ? '架空の摘要' : spec.note;
    return row;
  }

  function buildWorld(options = {}) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    call('setMasterSpreadsheetId', ['master']);
    call('provisionMasterSheets');
    gas.stubs.setSpreadsheetOwner('master', 'owner@example.com');
    gas.stubs.setActiveUser('reviewer@example.com');
    gas.evaluate(
      "SETTINGS.TX_INDEX_SPREADSHEET_ID='txidx';" +
      "SETTINGS.SNAPSHOT_SPREADSHEET_ID='snap';" +
      "SETTINGS.EXECUTION_TIMEOUT_SECONDS=300;" +
      "SETTINGS.SAFETY_MARGIN_SECONDS=60;" +
      "SETTINGS.PARALLEL_WORK_FOLDER_ID='" + WORK_FOLDER + "';" +
      "SETTINGS.SAMPLE_CORPUS_FOLDER_ID='corpus';");
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createSpreadsheet('snap', {sheets: []});
    gas.stubs.createFolder('corpus', {fileIds: []});
    const work = gas.stubs.createFolder(WORK_FOLDER, {fileIds: []});
    gas.stubs.createFolder('dest-parent', {fileIds: [TEMPLATE_ID, DESTINATION_ID]});
    gas.stubs.createFolder('card-folder', {fileIds: []});
    gas.stubs.createFolder('root-folder', {subFolderIds: ['card-folder']});

    const inputSpecs = options.inputRows || [];
    const importSpecs = options.importRows || [];
    const inputValues = Array.from({length: HEADER_ROW + inputSpecs.length}, () => blank(12));
    inputValues[0][1] = options.cardName === undefined ? 'テストカード' : options.cardName;
    inputValues[HEADER_ROW - 1] = inputHeader();
    inputSpecs.forEach((spec, index) => {
      inputValues[HEADER_ROW + index] = inputRow(spec);
    });
    const importValues = [HEADERS.slice()];
    importSpecs.forEach((spec) => importValues.push(importRow(spec)));
    (options.extraImportRows || []).forEach((row) => importValues.push(row));

    const templateValues = Array.from({length: HEADER_ROW}, () => blank(12));
    templateValues[HEADER_ROW - 1] = inputHeader();
    gas.stubs.createSpreadsheet(TEMPLATE_ID, {
      name: CUSTOMER_NAME + '_雛形',
      sheets: [{name: INPUT_SHEET, values: templateValues, maxRows: 20, maxColumns: 12}]
    });
    gas.stubs.createSpreadsheet(DESTINATION_ID, {
      name: DESTINATION_NAME,
      sheets: [
        {name: INPUT_SHEET, values: inputValues, maxRows: 50, maxColumns: 12},
        {name: IMPORT_SHEET, values: importValues, maxRows: 50, maxColumns: 40}
      ]
    });
    call('registerTestCustomer', [{
      customerId: CUSTOMER_ID,
      customerName: CUSTOMER_NAME,
      active: true,
      sourceFolderId: 'root-folder',
      destinationSpreadsheetId: TEMPLATE_ID,
      destinationSheetName: INPUT_SHEET,
      columns: {B: 2, F: 3, I: 4, K: 11, M: 6, txId: 10, G: 7, L: 9},
      headerRow: HEADER_ROW,
      dataStartRow: HEADER_ROW + 1,
      rowScanLastColumn: 12,
      reviewers: 'reviewer@example.com',
      admins: 'owner@example.com'
    }]);
    (options.txs || []).forEach((spec) => seedTransaction(spec));
    return {
      work,
      destinationId: DESTINATION_ID,
      fileIds: options.fileIds || [FILE_ID],
      inputSpecs,
      importSpecs
    };
  }

  function seedTransaction(spec) {
    const row = gas.call('makeTransactionRow_', [{
      fullTxId: spec.txId,
      customerId: spec.customerId || CUSTOMER_ID,
      fileId: spec.fileId || FILE_ID,
      sourceRow: 1,
      originalAmount: spec.amount,
      originalMerchant: '架空店',
      planned: {m: spec.amount}
    }, 'RUN_TEST', '2026-11-15T00:00:00+09:00']);
    row[9] = spec.status || 'COMMITTED';
    gas.stubs.getSpreadsheet('master').getSheetByName('クレカ取引ログ').appendRow(row);
  }

  function simpleWorld(overrides = {}) {
    return buildWorld(Object.assign({
      inputRows: [{txId: 'TX-001', expense: 1000}],
      importRows: [{amount: 1000, debitTax: TAX_10, creditTax: '対象外'}],
      txs: [{txId: 'TX-001', amount: 1000}]
    }, overrides));
  }

  function createExport(world, options = {}) {
    return call('webAppCreateFreeeExport', [
      CUSTOMER_ID,
      world.destinationId,
      options.fileIds === undefined ? world.fileIds : options.fileIds,
      options.options === undefined ? {} : options.options
    ]);
  }

  function snapshotSpreadsheet(spreadsheetId) {
    const spreadsheet = gas.stubs.getSpreadsheet(spreadsheetId);
    const result = {};
    spreadsheet.getSheets().forEach((sheet) => {
      result[sheet.getName()] = plain(sheet.values);
    });
    return result;
  }

  function destinationSheet(world) {
    return gas.stubs.getSpreadsheet(world.destinationId).getSheetByName(INPUT_SHEET);
  }

  function importSheet(world) {
    return gas.stubs.getSpreadsheet(world.destinationId).getSheetByName(IMPORT_SHEET);
  }

  function exportedSheet(world) {
    const sheet = gas.stubs.getSpreadsheet(world.work.fileIds[world.work.fileIds.length - 1])
      .getSheetByName(IMPORT_SHEET);
    assert.ok(sheet, '一時ファイルに取込用シートが無い');
    return sheet;
  }

  function auditRows() {
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ');
    return sheet.getDataRange().getValues().slice(1)
      .filter((row) => String(row[2]) === 'FREEE_EXPORT');
  }

  function withDestinationReads(world, fn) {
    const real = gas.context.Sheets.Spreadsheets.Values.batchGet;
    const reads = [];
    gas.context.Sheets.Spreadsheets.Values.batchGet = function(spreadsheetId, request) {
      reads.push({spreadsheetId: String(spreadsheetId), request: request});
      return real.call(this, spreadsheetId, request);
    };
    try {
      return {
        result: fn(),
        reads: reads.filter((item) => item.spreadsheetId === String(world.destinationId))
      };
    } finally {
      gas.context.Sheets.Spreadsheets.Values.batchGet = real;
    }
  }

  function expectStop(result, code, stage) {
    assert.equal(result.ok, false, '止まるはずが通っている');
    assert.equal(result.created, false);
    assert.equal(result.code, code);
    if (stage) assert.equal(result.stage, stage);
    assert.ok(Array.isArray(result.stops) && result.stops.length, 'stops が空');
    assert.equal(result.stops[0].code, code);
  }

  function rowProblemsOf(result, kind) {
    return (result.rowProblems || []).filter((problem) => problem.kind === kind);
  }

  // ================= fx 1: 正常 =================
  test('fx 1: 正常な取込用から、作業用フォルダに 1 枚だけ作って読み返す', () => {
    const spec = {
      inputRows: [
        {txId: 'TX-101', expense: 1000, date: serial('2026-11-01')},
        {txId: 'TX-102', expense: 2000, date: serial('2026-11-02')},
        {txId: 'TX-103', income: 3000, date: serial('2026-11-03')}
      ],
      importRows: [
        {amount: 1000, date: serial('2026-11-01'), debitTax: TAX_10, creditTax: '対象外'},
        {amount: 2000, date: serial('2026-11-02'), debitTax: '', creditTax: '対象外'},
        {amount: 3000, date: serial('2026-11-03'), debitTax: '対象外', creditTax: TAX_10}
      ],
      txs: [
        {txId: 'TX-101', amount: 1000},
        {txId: 'TX-102', amount: 2000},
        {txId: 'TX-103', amount: -3000}
      ],
      extraImportRows: [blank(32), Array(32).fill(0)]
    };
    const world = buildWorld(spec);
    const before = snapshotSpreadsheet(world.destinationId);
    const result = createExport(world);

    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.rows, 3);
    assert.equal(result.total, 6000);
    assert.equal(result.emptyTaxRows, 1, '税区分が空の行の数が違う');
    assert.equal(result.unbalancedAccepted, false);
    assert.equal(result.problemCount, 0);
    assert.equal(result.destinationSpreadsheetId, world.destinationId);
    assert.equal(world.work.fileIds.length, 1, '作業用フォルダに 1 つだけ作られていない');
    assert.equal(result.exportSpreadsheetId, world.work.fileIds[0]);
    assert.equal(result.fileName, DESTINATION_NAME + '_freee取込.xlsx');

    const exportFile = gas.stubs.getSpreadsheet(result.exportSpreadsheetId);
    assert.equal(exportFile.getName(), DESTINATION_NAME + '_freee取込');
    assert.equal(exportFile.getSheets().length, 1, 'シートが 1 枚でない');
    const sheet = exportFile.getSheetByName(IMPORT_SHEET);
    assert.ok(sheet, 'シート名が取込用でない');
    assert.equal(sheet.getMaxRows(), 4);
    assert.equal(sheet.getMaxColumns(), 32);

    const expectedRows = [HEADERS.slice()].concat(spec.importRows.map(importRow));
    const actualRows = sheet.values.slice(0, 4).map((row) => normalizeRow(row, 32));
    assert.deepEqual(actualRows, expectedRows, '見出しとデータ行の値・順が違う');

    const formats = sheet.getRange(2, 1, 3, 1).getNumberFormats()
      .map((row) => row[0]);
    assert.deepEqual(formats, ['yyyy/mm/dd', 'yyyy/mm/dd', 'yyyy/mm/dd'],
      'A2:A に日付の形式が無い');

    const requests = gas.stubs.getSheetsBatchUpdateRequests();
    assert.equal(requests.length, 1, '一時ファイルへの書込が 1 回でない');
    const batch = requests[0].requests;
    assert.ok(batch[0].updateSheetProperties, '最初が updateSheetProperties でない');
    assert.ok(batch[1].updateCells, '2 番目が updateCells でない');
    assert.ok(batch[2].repeatCell, '3 番目が repeatCell でない');
    assert.deepEqual(batch[2].repeatCell.range, {
      sheetId: batch[0].updateSheetProperties.properties.sheetId,
      startRowIndex: 1, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 1
    });
    assert.equal(batch[1].updateCells.fields, 'userEnteredValue');

    assert.equal(auditRows().length, 1, '監査が 1 件でない');
    const after = JSON.parse(String(auditRows()[0][10]));
    assert.equal(after.exportFileId, result.exportSpreadsheetId);
    assert.equal(after.rows, 3);
    assert.equal(after.total, 6000);
    assert.equal(after.emptyTaxRows, 1);
    assert.equal(after.unbalancedAccepted, false);
    assert.equal(after.problemCount, 0);

    assert.deepEqual(snapshotSpreadsheet(world.destinationId), before,
      '転記シートが変わっている（S2）');
  });

  // ================= fx 2: 文字列のまま =================
  test('fx 2: =1+1・2026/01/02・001・1/2 を、式・日付・数にしない', () => {
    const world = buildWorld({
      inputRows: [
        {txId: 'TX-201', expense: 100},
        {txId: 'TX-202', expense: 100},
        {txId: 'TX-203', expense: 100}
      ],
      importRows: [
        {amount: 100, note: '=1+1'},
        {amount: 100, note: '2026/01/02'},
        {amount: 100, note: '001', item: '1/2'}
      ],
      txs: [
        {txId: 'TX-201', amount: 100},
        {txId: 'TX-202', amount: 100},
        {txId: 'TX-203', amount: 100}
      ]
    });
    const result = createExport(world);
    assert.equal(result.ok, true);
    const sheet = exportedSheet(world);
    assert.equal(sheet.getRange(2, 32).getValue(), '=1+1');
    assert.equal(sheet.getRange(3, 32).getValue(), '2026/01/02');
    assert.equal(sheet.getRange(4, 32).getValue(), '001');
    assert.equal(sheet.getRange(4, 10).getValue(), '1/2');
    assert.equal(typeof sheet.getRange(2, 32).getValue(), 'string');
    assert.equal(typeof sheet.getRange(3, 32).getValue(), 'string');
    assert.equal(typeof sheet.getRange(4, 32).getValue(), 'string');
    assert.equal(sheet.getRange(2, 32).getFormula(), '', '式になっている');
  });

  // ================= fx 3: 0 と空白 =================
  test('fx 3: 文字の列の 0 と全角空白は空にし、0 だけ・空白だけの行は飛ばす', () => {
    const world = buildWorld({
      inputRows: [{txId: 'TX-301', expense: 1000}],
      importRows: [{amount: 1000, item: 0, memoTag: '　'}],
      extraImportRows: [Array(32).fill(0), Array(32).fill('　')],
      txs: [{txId: 'TX-301', amount: 1000}]
    });
    const result = createExport(world);
    assert.equal(result.ok, true);
    assert.equal(result.rows, 1, '空の行をデータ行として数えている');
    const sheet = exportedSheet(world);
    assert.equal(sheet.getMaxRows(), 2);
    assert.equal(sheet.getRange(2, 10).getValue(), '', '品目の 0 が空になっていない');
    assert.equal(sheet.getRange(2, 11).getValue(), '', 'メモタグの空白が空になっていない');
  });

  // ================= fx 4: 前提の止め =================
  test('fx 4: 前提が外れたら、読む前・作る前に止める', () => {
    // (a) 作業用フォルダが無い
    let world = buildWorld({inputRows: [], importRows: [], txs: []});
    gas.evaluate("SETTINGS.PARALLEL_WORK_FOLDER_ID='   ';");
    let before = gas.stubs.getSpreadsheetIds().slice().sort();
    let watched = withDestinationReads(world, () => createExport(world));
    expectStop(watched.result, 'WORK_FOLDER_MISSING', 'PRECONDITION');
    assert.equal(watched.reads.length, 0, '転記シートを読んでいる');
    assert.equal(gas.stubs.getDriveCreateCount(), 0);
    assert.equal(auditRows().length, 0, '監査を書いている');
    assert.deepEqual(gas.stubs.getSpreadsheetIds().slice().sort(), before);

    // (b) 入金の列が無い顧客
    world = buildWorld({inputRows: [], importRows: [], txs: []});
    gas.stubs.getSpreadsheet('master').getSheetByName('顧客マスター').getRange(2, 43).setValue('');
    before = gas.stubs.getSpreadsheetIds().slice().sort();
    watched = withDestinationReads(world, () => createExport(world));
    expectStop(watched.result, 'TEMPLATE_UNSUPPORTED', 'PRECONDITION');
    assert.equal(watched.reads.length, 0);
    assert.equal(gas.stubs.getDriveCreateCount(), 0);
    assert.deepEqual(gas.stubs.getSpreadsheetIds().slice().sort(), before);

    // (c) 取込用のタブが無い
    world = buildWorld({inputRows: [], importRows: [], txs: []});
    const destination = gas.stubs.getSpreadsheet(world.destinationId);
    destination.deleteSheet(destination.getSheetByName(IMPORT_SHEET));
    before = gas.stubs.getSpreadsheetIds().slice().sort();
    watched = withDestinationReads(world, () => createExport(world));
    expectStop(watched.result, 'IMPORT_SHEET_MISSING', 'PRECONDITION');
    assert.equal(watched.reads.length, 0);
    assert.equal(gas.stubs.getDriveCreateCount(), 0);
    assert.deepEqual(gas.stubs.getSpreadsheetIds().slice().sort(), before);

    // (d) 見出しが違う
    world = simpleWorld();
    importSheet(world).getRange(1, 3).setValue('違う見出し');
    const snapshot = snapshotSpreadsheet(world.destinationId);
    watched = withDestinationReads(world, () => createExport(world));
    expectStop(watched.result, 'HEADER_MISMATCH', 'PRECONDITION');
    assert.equal(watched.reads.length, 1, '取込用を読んでいない');
    assert.equal(watched.reads[0].request.ranges.length, 3);
    const mismatch = watched.result.stops[0];
    assert.equal(mismatch.column, 'C');
    assert.equal(mismatch.expected, '決算整理仕訳');
    assert.equal(mismatch.actual, '違う見出し');
    assert.equal(gas.stubs.getDriveCreateCount(), 0);
    assert.equal(auditRows().length, 0);
    assert.deepEqual(snapshotSpreadsheet(world.destinationId), snapshot);
  });

  // ================= fx 5: B1 のカード名 =================
  test('fx 5: B1 が ○○カード・〇〇カード・空なら止め、テストカードは通す', () => {
    ['○○カード', '〇〇カード', ''].forEach((cardName) => {
      const world = simpleWorld({cardName: cardName});
      const result = createExport(world);
      expectStop(result, 'CARD_NAME_PLACEHOLDER', 'CONTENT');
      assert.equal(gas.stubs.getDriveCreateCount(), 0, '作ってしまっている');
    });
    const world = simpleWorld({cardName: 'テストカード'});
    const result = createExport(world);
    assert.equal(result.ok, true, '正しいカード名で止まっている');
  });

  // ================= fx 6: 行の問題 =================
  test('fx 6: 行の問題を種類ごとに、取込用の行・列で返す', () => {
    const world = simpleWorld();
    const good = {amount: 1000, debitTax: TAX_10, creditTax: '対象外'};
    let result;
    const sheet = importSheet(world);

    function resetGood(changes) {
      const row = importRow(Object.assign({}, good, changes || {}));
      sheet.getRange(2, 1, 1, 32).setValues([row]);
    }

    resetGood({debitAccount: '#N/A'});
    result = createExport(world);
    expectStop(result, 'ROW_PROBLEMS', 'CONTENT');
    let problem = rowProblemsOf(result, 'FORMULA_ERROR')[0];
    assert.ok(problem, '数式のエラーを見逃している');
    assert.equal(problem.importRow, 2);
    assert.equal(problem.column, 'D');
    assert.equal(problem.value, '#N/A');

    [['2026/11/03', '文字列'], [46329.5, '小数'], [100, '範囲外']].forEach((pair) => {
      resetGood({date: pair[0]});
      result = createExport(world);
      expectStop(result, 'ROW_PROBLEMS', 'CONTENT');
      problem = rowProblemsOf(result, 'DATE_INVALID')[0];
      assert.ok(problem, pair[1] + 'の日付を見逃している');
      assert.equal(problem.importRow, 2);
      assert.equal(problem.column, 'A');
      assert.equal(problem.value, null);
    });

    [0, 1.5, '1,200', 1e13].forEach((amount) => {
      resetGood({amount: amount});
      result = createExport(world);
      expectStop(result, 'ROW_PROBLEMS', 'CONTENT');
      const problems = rowProblemsOf(result, 'AMOUNT_INVALID');
      assert.deepEqual(problems.map((item) => item.column).sort(), ['AC', 'O'],
        String(amount) + ' の金額を見逃している');
      assert.equal(problems[0].importRow, 2);
    });

    resetGood({});
    sheet.getRange(2, 15).setValue(100);
    sheet.getRange(2, 29).setValue(200);
    result = createExport(world);
    expectStop(result, 'ROW_PROBLEMS', 'CONTENT');
    problem = rowProblemsOf(result, 'DEBIT_CREDIT_MISMATCH')[0];
    assert.ok(problem, '借方と貸方の違いを見逃している');
    assert.equal(problem.importRow, 2);

    resetGood({debitAccount: ''});
    result = createExport(world);
    expectStop(result, 'ROW_PROBLEMS', 'CONTENT');
    problem = rowProblemsOf(result, 'ACCOUNT_EMPTY')[0];
    assert.equal(problem.column, 'D');

    resetGood({});
    sheet.getRange(2, 17).setValue('abc');
    result = createExport(world);
    expectStop(result, 'ROW_PROBLEMS', 'CONTENT');
    problem = rowProblemsOf(result, 'TAX_AMOUNT_INVALID')[0];
    assert.equal(problem.column, 'Q');

    assert.equal(gas.stubs.getDriveCreateCount(), 0);
    assert.equal(auditRows().length, 0);
  });

  // ================= fx 7: 税区分の名前 =================
  test('fx 7: 税区分の 30 の名前を通し、一覧に無い名前は案内を付けて止める', () => {
    const cases = [
      {name: '対象外'}, {name: '対外仕入'}, {name: '対外売上'}, {name: '非課仕入'},
      {name: '非課売上'}, {name: TAX_10}, {name: TAX_LIGHT},
      {name: '非対仕入10%'}, {name: '非対仕入8%（軽）'},
      {name: '共対仕入10%'}, {name: '共対仕入8%（軽）'},
      {name: '課対仕返10%'}, {name: '課対仕返8%（軽）'},
      {name: '課税売上10%'}, {name: '課税売上8%（軽）'},
      {name: '課税売返10%'}, {name: '課税売返8%（軽）'},
      {name: '課対輸本'}, {name: '課対輸税10%'}, {name: '課対輸税8%（軽）'},
      {name: '地消貨割10%'}, {name: '地消貨割8%（軽）'},
      {name: '課対仕入（控80）10%', date: '2024-06-01'},
      {name: '課対仕入（控80）8%（軽）', date: '2024-06-01'},
      {name: '課対仕入（控70）10%', date: '2027-06-01'},
      {name: '課対仕入（控70）8%（軽）', date: '2027-06-01'},
      {name: '課対仕入（控50）10%', date: '2029-06-01'},
      {name: '課対仕入（控50）8%（軽）', date: '2029-06-01'},
      {name: '課対仕入（控30）10%', date: '2031-06-01'},
      {name: '課対仕入（控30）8%（軽）', date: '2031-06-01'}
    ];
    assert.equal(cases.length, 30, '前提：30 の名前');
    const world = buildWorld({
      inputRows: cases.map((item, index) => ({
        txId: 'TX-7-' + index, expense: 100, date: serial(item.date || '2026-11-01')
      })),
      importRows: cases.map((item) => ({
        amount: 100, date: serial(item.date || '2026-11-01'),
        debitTax: item.name, creditTax: '対象外'
      })),
      txs: cases.map((item, index) => ({txId: 'TX-7-' + index, amount: 100}))
    });
    const result = createExport(world);
    assert.equal(result.ok, true, '一覧の名前で止まっている');
    assert.equal(result.rows, 30);
    const sheet = exportedSheet(world);
    cases.forEach((item, index) => {
      assert.equal(sheet.getRange(index + 2, 16).getValue(), item.name,
        item.name + ' が変わっている');
    });

    const badWorld = simpleWorld();
    const badSheet = importSheet(badWorld);
    const bad = [
      {value: '不課税', hint: {code: 'ALIAS', suggestion: '対象外'}},
      {value: '課対売上10%', hint: {code: 'ALIAS', suggestion: '課税売上10%'}},
      {value: '課対仕入', hint: {code: 'RATE_MISSING',
        suggestions: [TAX_10, TAX_LIGHT]}},
      {value: '課対仕入(控80)10%', hint: {code: 'WIDTH',
        suggestion: '課対仕入（控80）10%'}},
      {value: ' ' + TAX_10, hint: {code: 'SPACE', suggestion: TAX_10}},
      {value: '課対仕入8%', hint: null},
      {value: 10, hint: null}
    ];
    bad.forEach((item) => {
      const row = importRow({amount: 1000, debitTax: item.value, creditTax: ''});
      badSheet.getRange(2, 1, 1, 32).setValues([row]);
      const stopped = createExport(badWorld);
      expectStop(stopped, 'ROW_PROBLEMS', 'CONTENT');
      const unknown = rowProblemsOf(stopped, 'TAX_NAME_UNKNOWN')
        .filter((problem) => problem.column === 'P')[0];
      assert.ok(unknown, String(item.value) + ' を止めていない');
      assert.deepEqual(unknown.hint, item.hint, String(item.value) + ' の案内が違う');
    });
  });

  // ================= fx 8: 税区分が空 =================
  test('fx 8: 税区分が空の行は通す（freee が勘定科目の税区分を使う）', () => {
    const world = buildWorld({
      inputRows: [{txId: 'TX-801', expense: 1000}],
      importRows: [{amount: 1000, debitTax: '', creditTax: ''}],
      txs: [{txId: 'TX-801', amount: 1000}]
    });
    const result = createExport(world);
    assert.equal(result.ok, true, '空の税区分を止めている（S7）');
    assert.equal(result.emptyTaxRows, 1);
  });

  // ================= fx 9: 期間の境目 =================
  test('fx 9: 控xx の期間の両端を含み、外は止める', () => {
    const world = simpleWorld();
    const sheet = importSheet(world);
    const input = destinationSheet(world);
    const boundaries = [
      {tax: '課対仕入（控80）10%', value: 45199, ok: false},
      {tax: '課対仕入（控80）10%', value: 45200, ok: true},
      {tax: '課対仕入（控80）10%', value: 46295, ok: true},
      {tax: '課対仕入（控80）10%', value: 46296, ok: false},
      {tax: '課対仕入（控70）10%', value: 46295, ok: false},
      {tax: '課対仕入（控70）10%', value: 46296, ok: true},
      {tax: '課対仕入（控70）10%', value: 47026, ok: true},
      {tax: '課対仕入（控70）10%', value: 47027, ok: false},
      {tax: '課対仕入（控50）10%', value: 47027, ok: true},
      {tax: '課対仕入（控50）10%', value: 47756, ok: true},
      {tax: '課対仕入（控50）10%', value: 47757, ok: false},
      {tax: '課対仕入（控30）10%', value: 47757, ok: true},
      {tax: '課対仕入（控30）10%', value: 48121, ok: true},
      {tax: '課対仕入（控30）10%', value: 48122, ok: false}
    ];
    boundaries.forEach((boundary) => {
      input.getRange(5, 2).setValue(boundary.value);
      sheet.getRange(2, 1).setValue(boundary.value);
      sheet.getRange(2, 16).setValue(boundary.tax);
      sheet.getRange(2, 30).setValue('対象外');
      const result = createExport(world);
      if (boundary.ok) {
        assert.equal(result.ok, true, boundary.value + ' で止まっている');
      } else {
        expectStop(result, 'ROW_PROBLEMS', 'CONTENT');
        const problem = rowProblemsOf(result, 'TAX_DATE_MISMATCH')[0];
        assert.ok(problem, boundary.value + ' の期間外を見逃している');
        assert.equal(problem.column, 'P');
      }
    });
  });

  // ================= fx 10: 行数の不一致 =================
  test('fx 10: 入力用の行と取込用の行の数が合わなければ止める', () => {
    const world = buildWorld({
      inputRows: [
        {txId: 'TX-1001', expense: 1000},
        {txId: 'TX-1002', expense: 2000}
      ],
      importRows: [{amount: 1000}],
      txs: [
        {txId: 'TX-1001', amount: 1000},
        {txId: 'TX-1002', amount: 2000}
      ]
    });
    const result = createExport(world);
    expectStop(result, 'ROW_COUNT_MISMATCH', 'CONTENT');
    const stop = result.stops.filter((item) => item.code === 'ROW_COUNT_MISMATCH')[0];
    assert.ok(stop, '行数の不一致が無い');
    assert.equal(stop.inputRows, 2);
    assert.equal(stop.importRows, 1);
    assert.equal(gas.stubs.getDriveCreateCount(), 0);
  });

  // ================= fx 11: 合計の不一致 =================
  test('fx 11: 行の数が同じでも、金額の合計が違えば止める', () => {
    const world = buildWorld({
      inputRows: [{txId: 'TX-1101', expense: 1000}],
      importRows: [{amount: 900}],
      txs: [{txId: 'TX-1101', amount: 1000}]
    });
    const result = createExport(world);
    expectStop(result, 'AMOUNT_TOTAL_MISMATCH', 'CONTENT');
    const stop = result.stops.filter((item) => item.code === 'AMOUNT_TOTAL_MISMATCH')[0];
    assert.ok(stop, '合計の不一致が無い');
    assert.equal(stop.inputTotal, 1000);
    assert.equal(stop.importTotal, 900);
  });

  // ================= fx 12: 入力の金額が読めない =================
  test('fx 12: 入力用の金額が数として読めなければ、行と列を返す', () => {
    const world = buildWorld({
      inputRows: [{txId: 'TX-1201', expense: 'abc'}],
      importRows: [{amount: 1000}],
      txs: [{txId: 'TX-1201', amount: 1000}]
    });
    const result = createExport(world);
    expectStop(result, 'INPUT_AMOUNT_INVALID', 'CONTENT');
    const stop = result.stops.filter((item) => item.code === 'INPUT_AMOUNT_INVALID')[0];
    assert.ok(stop, '読めない入力金額が無い');
    assert.equal(stop.count, 1);
    assert.equal(stop.rows[0].inputRow, HEADER_ROW + 1);
    assert.equal(stop.rows[0].column, 'F', '入力用の金額列が違う');
  });

  // ================= fx 13: 取り込む行が無い =================
  test('fx 13: 取込用が全部空で入力用にも金額が無ければ止める', () => {
    const world = buildWorld({
      inputRows: [],
      importRows: [],
      extraImportRows: [blank(32), Array(32).fill('　')],
      txs: []
    });
    const result = createExport(world);
    expectStop(result, 'NO_DATA_ROWS', 'CONTENT');
    assert.equal(result.rowProblemCount, 0);
  });

  // ================= fx 14: 要確認 =================
  test('fx 14: 要確認が 1 行でも残っていれば作らず、COMMITTED なら作る', () => {
    const waiting = buildWorld({
      inputRows: [{txId: 'TX-1401', expense: 1000}],
      importRows: [{amount: 1000}],
      txs: [{txId: 'TX-1401', amount: 1000, status: 'REVIEW_REQUIRED'}]
    });
    const stopped = createExport(waiting);
    expectStop(stopped, 'REVIEW_REMAINING', 'CONTENT');
    const stop = stopped.stops.filter((item) => item.code === 'REVIEW_REMAINING')[0];
    assert.equal(stop.count, 1);
    assert.deepEqual(stop.rowNumbers, [HEADER_ROW + 1]);
    assert.equal(gas.stubs.getDriveCreateCount(), 0, '要確認が残るのに作っている（S5）');

    const committed = buildWorld({
      inputRows: [{txId: 'TX-1402', expense: 1000}],
      importRows: [{amount: 1000}],
      txs: [{txId: 'TX-1402', amount: 1000, status: 'COMMITTED'}]
    });
    assert.equal(createExport(committed).ok, true, '確定済みなのに止まっている');
  });

  // ================= fx 15: 書き込み途中 =================
  test('fx 15: PREPARED・WRITING が残っていれば作らない', () => {
    ['PREPARED', 'WRITING'].forEach((status) => {
      const world = buildWorld({
        inputRows: [{txId: 'TX-1501', expense: 1000}],
        importRows: [{amount: 1000}],
        txs: [{txId: 'TX-1501', amount: 1000, status: status}]
      });
      const result = createExport(world);
      expectStop(result, 'WRITE_IN_PROGRESS', 'CONTENT');
      const stop = result.stops.filter((item) => item.code === 'WRITE_IN_PROGRESS')[0];
      assert.equal(stop.count, 1, status);
      assert.deepEqual(stop.rowNumbers, [HEADER_ROW + 1]);
      assert.equal(gas.stubs.getDriveCreateCount(), 0);
    });
  });

  // ================= fx 16: 別の顧客 =================
  test('fx 16: 別の顧客の取引は、不一致を承知しても作らない', () => {
    const world = buildWorld({
      inputRows: [{txId: 'TX-1601', expense: 1000}],
      importRows: [{amount: 1000}],
      txs: [{txId: 'TX-1601', amount: 1000, customerId: 'K9002'}]
    });
    const result = createExport(world, {options: {acceptUnbalanced: true}});
    expectStop(result, 'FOREIGN_CUSTOMER', 'CONTENT');
    const stop = result.stops.filter((item) => item.code === 'FOREIGN_CUSTOMER')[0];
    assert.equal(stop.count, 1);
    assert.deepEqual(stop.rowNumbers, [HEADER_ROW + 1]);
    assert.equal(gas.stubs.getDriveCreateCount(), 0, '別の顧客の取引で作っている（S5）');
  });

  // ================= fx 17: 不一致 =================
  test('fx 17: 不一致は acceptUnbalanced === true のときだけ作る', () => {
    const world = buildWorld({
      inputRows: [{txId: 'TX-1701', expense: 1000}],
      importRows: [{amount: 1000}],
      txs: [
        {txId: 'TX-1701', amount: 1000},
        {txId: 'TX-1702', amount: 500}
      ]
    });
    const stopped = createExport(world);
    expectStop(stopped, 'UNBALANCED', 'CONFIRM');
    const stop = stopped.stops[0];
    assert.equal(stop.problemCount, 1);
    assert.deepEqual(stop.problemKinds, {MISSING: 1});
    assert.equal(stop.residual, 500);
    assert.equal(gas.stubs.getDriveCreateCount(), 0);

    ['true', 1].forEach((value) => {
      const refused = createExport(world, {options: {acceptUnbalanced: value}});
      expectStop(refused, 'UNBALANCED', 'CONFIRM');
      assert.equal(gas.stubs.getDriveCreateCount(), 0, String(value) + ' で作っている（S6）');
    });

    const accepted = createExport(world, {options: {acceptUnbalanced: true}});
    assert.equal(accepted.ok, true, '承知しても作れない');
    assert.equal(accepted.unbalancedAccepted, true);
    assert.equal(auditRows().length, 1);
    const after = JSON.parse(String(auditRows()[0][10]));
    assert.equal(after.unbalancedAccepted, true);
    assert.equal(after.problemCount, 1);
  });

  // ================= fx 18: 止めをまとめて返す =================
  test('fx 18: 直す所が全部分かるよう、CONTENT の止めをまとめて返す', () => {
    const world = buildWorld({
      cardName: '○○カード',
      inputRows: [{txId: 'TX-1801', expense: 1000}],
      importRows: [{amount: 1000, debitTax: '不課税', creditTax: '対象外'}],
      txs: [{txId: 'TX-1801', amount: 1000, status: 'REVIEW_REQUIRED'}]
    });
    const result = createExport(world);
    expectStop(result, 'CARD_NAME_PLACEHOLDER', 'CONTENT');
    assert.deepEqual(result.stops.map((item) => item.code),
      ['CARD_NAME_PLACEHOLDER', 'ROW_PROBLEMS', 'REVIEW_REMAINING']);
  });

  // ================= fx 19: 行の問題は 30 件まで =================
  test('fx 19: rowProblems は 30 件までで、総数は別に返す', () => {
    const inputRows = [];
    const importRows = [];
    const txs = [];
    for (let index = 0; index < 35; index += 1) {
      inputRows.push({txId: 'TX-19-' + index, expense: 100});
      importRows.push({amount: 100, debitAccount: ''});
      txs.push({txId: 'TX-19-' + index, amount: 100});
    }
    const world = buildWorld({inputRows: inputRows, importRows: importRows, txs: txs});
    const result = createExport(world);
    expectStop(result, 'ROW_PROBLEMS', 'CONTENT');
    assert.equal(result.rowProblems.length, 30, '30 件に絞っていない');
    assert.equal(result.rowProblemCount, 35, '総数を返していない');
    assert.equal(result.stops[0].count, 35);
  });

  // ================= fx 20: 読み返しの食い違い =================
  test('fx 20: 読み返しが違えば作った一時ファイルを消して WRITE_VERIFY_FAILED', () => {
    const world = simpleWorld();
    const before = gas.stubs.getSpreadsheetIds().slice().sort();
    gas.stubs.setFreeeExportCorruptCell({row: 2, column: 4, value: '食い違い'});
    const result = createExport(world);
    expectStop(result, 'WRITE_VERIFY_FAILED', 'CONTENT');
    assert.equal(result.stops[0].row, 2);
    assert.equal(result.stops[0].column, 'D');
    assert.equal(gas.stubs.getDriveCreateCount(), 1);
    assert.equal(gas.stubs.getDriveRemovedIds().length, 1, '一時ファイルを消していない（S8）');
    assert.deepEqual(gas.stubs.getSpreadsheetIds().slice().sort(), before,
      '一時ファイルが残っている');
    assert.equal(auditRows().length, 0, '監査を書いている（S10）');
  });

  // ================= fx 21: 監査が投げる =================
  test('fx 21: 監査に失敗したら、一時ファイルを消して例外を投げる', () => {
    const world = simpleWorld();
    const before = gas.stubs.getSpreadsheetIds().slice().sort();
    const realAudit = gas.context.appendAudit;
    gas.context.appendAudit = function() { throw new Error('audit failed'); };
    try {
      const error = caught(() => gas.call('webAppCreateFreeeExport', [
        CUSTOMER_ID, world.destinationId, world.fileIds, {}
      ]));
      assert.match(String(error.message), /audit failed/);
    } finally {
      gas.context.appendAudit = realAudit;
    }
    assert.equal(gas.stubs.getDriveRemovedIds().length, 1, '一時ファイルを消していない（S10）');
    assert.deepEqual(gas.stubs.getSpreadsheetIds().slice().sort(), before);
  });

  // ================= fx 22: 作った後の batchUpdate が投げる =================
  test('fx 22: 一時ファイルへの書込が投げたら、消して例外を投げる', () => {
    const world = simpleWorld();
    const before = gas.stubs.getSpreadsheetIds().slice().sort();
    const realBatchUpdate = gas.context.Sheets.Spreadsheets.batchUpdate;
    gas.context.Sheets.Spreadsheets.batchUpdate = function() { throw new Error('write failed'); };
    try {
      const error = caught(() => gas.call('webAppCreateFreeeExport', [
        CUSTOMER_ID, world.destinationId, world.fileIds, {}
      ]));
      assert.match(String(error.message), /write failed/);
    } finally {
      gas.context.Sheets.Spreadsheets.batchUpdate = realBatchUpdate;
    }
    assert.equal(gas.stubs.getDriveRemovedIds().length, 1, '一時ファイルを消していない（S8）');
    assert.deepEqual(gas.stubs.getSpreadsheetIds().slice().sort(), before);
  });

  // ================= fx 23: 後片付け =================
  test('fx 23: 60 分以上前の freee 取込用スプレッドシートだけを消し、失敗しても作る', () => {
    const world = simpleWorld();
    const now = Date.now();
    const drive = gas.context.Drive.Files;
    const created = {};
    gas.stubs.setClock(now - 61 * 60000);
    created.oldExport = drive.create({name: 'old_export', mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [WORK_FOLDER], appProperties: {ccExportKind: 'FREEE_EXPORT'}}).id;
    created.oldNoProperties = drive.create({name: 'old_plain',
      mimeType: 'application/vnd.google-apps.spreadsheet', parents: [WORK_FOLDER]}).id;
    created.oldTmp = drive.create({name: 'tmp_import_x',
      mimeType: 'application/vnd.google-apps.spreadsheet', parents: [WORK_FOLDER]}).id;
    created.oldOtherKind = drive.create({name: 'old_other',
      mimeType: 'application/vnd.google-apps.spreadsheet', parents: [WORK_FOLDER],
      appProperties: {ccExportKind: 'OTHER'}}).id;
    gas.stubs.setClock(now - 59 * 60000);
    created.recentExport = drive.create({name: 'recent_export',
      mimeType: 'application/vnd.google-apps.spreadsheet', parents: [WORK_FOLDER],
      appProperties: {ccExportKind: 'FREEE_EXPORT'}}).id;
    gas.stubs.setClock(null);
    gas.stubs.createFile('old_not_spreadsheet', {
      name: 'old_not_spreadsheet', contentType: 'text/plain',
      createdTime: new Date(now - 61 * 60000),
      appProperties: {ccExportKind: 'FREEE_EXPORT'}
    });
    world.work.fileIds.push('old_not_spreadsheet');

    const result = createExport(world);
    assert.equal(result.ok, true);
    const removed = gas.stubs.getDriveRemovedIds();
    assert.deepEqual(removed, [created.oldExport], '消すものだけを消していない（S9）');
    assert.ok(gas.stubs.getSpreadsheetIds().indexOf(created.recentExport) >= 0);
    assert.ok(gas.stubs.getSpreadsheetIds().indexOf(created.oldNoProperties) >= 0);
    assert.ok(gas.stubs.getSpreadsheetIds().indexOf(created.oldTmp) >= 0);
    assert.ok(gas.stubs.getSpreadsheetIds().indexOf(created.oldOtherKind) >= 0);

    // 一覧が投げても作る
    gas.stubs.setDriveListFailures([500]);
    const listFailed = createExport(world);
    assert.equal(listFailed.ok, true, '一覧の失敗で作るのを止めている');

    // 削除が投げても作る
    gas.stubs.setDriveRemoveFailures([500]);
    const removeFailed = createExport(world);
    assert.equal(removeFailed.ok, true, '削除の失敗で作るのを止めている');
  });

  // ================= fx 24: 認可・転記先 =================
  test('fx 24: 認可と転記先の確かめが通らなければ、読まない・作らない', () => {
    let world = simpleWorld();
    let before = gas.stubs.getSpreadsheetIds().slice().sort();
    let watched = withDestinationReads(world, () => caught(() => gas.call(
      'webAppCreateFreeeExport', ['K9999', world.destinationId, world.fileIds, {}])));
    assert.ok(watched.result, '認可されない顧客で例外が出ていない');
    assert.equal(watched.reads.length, 0, '認可の前に転記シートを読んでいる（S11）');
    assert.equal(gas.stubs.getDriveCreateCount(), 0);

    world = simpleWorld();
    before = gas.stubs.getSpreadsheetIds().slice().sort();
    watched = withDestinationReads(world, () => caught(() => gas.call(
      'webAppCreateFreeeExport', [CUSTOMER_ID, TEMPLATE_ID, world.fileIds, {}])));
    assert.ok(watched.result, '雛形を転記先として受け付けている');
    assert.equal(watched.reads.length, 0);
    assert.equal(gas.stubs.getDriveCreateCount(), 0);
    assert.deepEqual(gas.stubs.getSpreadsheetIds().slice().sort(), before);
  });

  // ================= fx 25: 読取の回数 =================
  test('fx 25: 成功のとき、転記シートの読取は 1 回・書込は 0 回', () => {
    const world = simpleWorld();
    const before = snapshotSpreadsheet(world.destinationId);
    const watched = withDestinationReads(world, () => createExport(world));
    assert.equal(watched.result.ok, true);
    assert.equal(watched.reads.length, 1, '転記シートを 2 回以上読んでいる（S2）');
    assert.equal(watched.reads[0].request.ranges.length, 3, '範囲が 3 つでない');
    assert.deepEqual(snapshotSpreadsheet(world.destinationId), before,
      '転記シートに書いている（S2）');
  });

  // ================= fx 26: 置き場 =================
  test('fx 26: 一時ファイルの親は作業用フォルダだけ', () => {
    const world = simpleWorld();
    const result = createExport(world);
    assert.equal(result.ok, true);
    const file = gas.context.DriveApp.getFileById(result.exportSpreadsheetId);
    const parents = [];
    const iterator = file.getParents();
    while (iterator.hasNext()) parents.push(String(iterator.next().getId()));
    assert.deepEqual(parents, [WORK_FOLDER], '作業用フォルダ以外にも置いている（S8）');

    const listing = gas.context.Drive.Files.list({q: "'" + WORK_FOLDER + "' in parents"});
    const listed = listing.files.filter((item) => item.id === result.exportSpreadsheetId)[0];
    assert.ok(listed, '作業用フォルダの一覧に出ていない');
    assert.deepEqual(listed.parents, [WORK_FOLDER]);
  });

  // ================= fx 27: 本体の acceptUnbalanced の厳しさ =================
  test('fx 27: 本体（46）も、acceptUnbalanced が真偽値の true のときだけ承知する', () => {
    const world = buildWorld({
      inputRows: [{txId: 'TX-2701', expense: 1000}],
      importRows: [{amount: 1000}],
      txs: [
        {txId: 'TX-2701', amount: 1000},
        {txId: 'TX-2702', amount: 500}
      ]
    });
    const base = call('getCustomerById', [CUSTOMER_ID]);
    const customer = Object.assign({}, base, {destinationSpreadsheetId: world.destinationId});
    ['true', 1, '1', {}, []].forEach((value) => {
      const refused = call('freeeExportCreate_',
        [customer, world.destinationId, world.fileIds, value]);
      expectStop(refused, 'UNBALANCED', 'CONFIRM');
      assert.equal(gas.stubs.getDriveCreateCount(), 0,
        JSON.stringify(value) + ' のような真偽値でない値で作っている（S6）');
    });
    const accepted = call('freeeExportCreate_',
      [customer, world.destinationId, world.fileIds, true]);
    assert.equal(accepted.ok, true, '真偽値の true でも作れない');
  });
};

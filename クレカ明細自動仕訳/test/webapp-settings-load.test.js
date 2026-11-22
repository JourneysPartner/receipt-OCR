'use strict';

/**
 * 画面の入口でスクリプトのプロパティの設定を読む
 * （仕様 `work/spec_webapp_settings_load.md` 版 1.0）。
 *
 * 値はすべて架空である。顧客 K9101・架空 次郎・テストカード。
 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const blank = (length) => Array(length).fill('');
  const call = (name, args = []) => {
    const result = gas.call(name, args);
    return result === undefined ? undefined : plain(result);
  };
  const props = () => gas.context.PropertiesService.getScriptProperties();

  const CUSTOMER_ID = 'K9101';
  const CUSTOMER_NAME = '架空 次郎';
  const TEMPLATE_ID = 'wsl-template';
  const DESTINATION_ID = 'wsl-destination';
  const DESTINATION_NAME = CUSTOMER_NAME + '_20261115-1000';
  const INPUT_SHEET = '入力用シート';
  const IMPORT_SHEET = '取込用';
  const HEADER_ROW = 4;
  const WORK_FOLDER = 'wsl-work-folder';
  const FILE_ID = 'wsl-file-1';

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

  function serial(iso) {
    const parts = String(iso).split('-').map(Number);
    return Math.round((Date.UTC(parts[0], parts[1] - 1, parts[2]) -
      Date.UTC(1899, 11, 30)) / 86400000);
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
    row[3] = '架空の摘要';
    row[4] = 'メモ';
    row[5] = spec.expense === undefined ? '' : spec.expense;
    row[6] = '';
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
    row[1] = '1';
    row[2] = '';
    row[3] = '架空経費';
    row[9] = '架空品目';
    row[10] = '';
    row[14] = spec.amount === undefined ? '' : spec.amount;
    row[15] = spec.debitTax === undefined ? '' : spec.debitTax;
    row[16] = '';
    row[17] = 'テストカード';
    row[28] = spec.amount === undefined ? '' : spec.amount;
    row[29] = '対象外';
    row[30] = '';
    row[31] = '架空の摘要';
    return row;
  }

  /** freee 取込用を 1 行だけ作れる世界。作業用フォルダはプロパティだけに入れる。 */
  function buildFreeeWorld(workPropertyValue) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    call('setMasterSpreadsheetId', ['master']);
    call('provisionMasterSheets');
    gas.stubs.setSpreadsheetOwner('master', 'owner@example.com');
    gas.stubs.setActiveUser('reviewer@example.com');
    gas.evaluate(
      "SETTINGS.TX_INDEX_SPREADSHEET_ID='wsl-txidx';" +
      "SETTINGS.SNAPSHOT_SPREADSHEET_ID='wsl-snap';" +
      "SETTINGS.EXECUTION_TIMEOUT_SECONDS=300;" +
      "SETTINGS.SAFETY_MARGIN_SECONDS=60;" +
      "SETTINGS.SAMPLE_CORPUS_FOLDER_ID='wsl-corpus';");
    gas.stubs.createSpreadsheet('wsl-txidx', {sheets: []});
    gas.stubs.createSpreadsheet('wsl-snap', {sheets: []});
    gas.stubs.createFolder('wsl-corpus', {fileIds: []});
    const work = gas.stubs.createFolder(WORK_FOLDER, {fileIds: []});
    gas.stubs.createFolder('wsl-dest-parent', {fileIds: [TEMPLATE_ID, DESTINATION_ID]});
    gas.stubs.createFolder('wsl-card', {fileIds: []});
    gas.stubs.createFolder('wsl-root', {subFolderIds: ['wsl-card']});

    const inputValues = Array.from({length: HEADER_ROW + 1}, () => blank(12));
    inputValues[0][1] = 'テストカード';
    inputValues[HEADER_ROW - 1] = inputHeader();
    inputValues[HEADER_ROW] = inputRow({txId: 'TX-901', expense: 1000});
    const importValues = [HEADERS.slice(), importRow({amount: 1000, debitTax: TAX_10})];

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
      sourceFolderId: 'wsl-root',
      destinationSpreadsheetId: TEMPLATE_ID,
      destinationSheetName: INPUT_SHEET,
      columns: {B: 2, F: 3, I: 4, K: 11, M: 6, txId: 10, G: 7, L: 9},
      headerRow: HEADER_ROW,
      dataStartRow: HEADER_ROW + 1,
      rowScanLastColumn: 12,
      reviewers: 'reviewer@example.com',
      admins: 'owner@example.com'
    }]);
    const row = gas.call('makeTransactionRow_', [{
      fullTxId: 'TX-901',
      customerId: CUSTOMER_ID,
      fileId: FILE_ID,
      sourceRow: 1,
      originalAmount: 1000,
      originalMerchant: '架空店',
      planned: {m: 1000}
    }, 'RUN_TEST', '2026-11-15T00:00:00+09:00']);
    row[9] = 'COMMITTED';
    gas.stubs.getSpreadsheet('master').getSheetByName('クレカ取引ログ').appendRow(row);

    if (workPropertyValue !== null) {
      props().setProperty('PARALLEL_WORK_FOLDER_ID', workPropertyValue);
    }
    return {work};
  }

  function createExport() {
    return call('webAppCreateFreeeExport', [CUSTOMER_ID, DESTINATION_ID, [FILE_ID], {}]);
  }

  // ================= wsl 1: S2 =================
  test('wsl 1: プロパティの作業用フォルダで freee 取込用を作り、親を作業用フォルダにする', () => {
    buildFreeeWorld(WORK_FOLDER);
    assert.equal(gas.evaluate('SETTINGS.PARALLEL_WORK_FOLDER_ID'), '',
      'SETTINGS の既定を直に入れている');
    const result = createExport();
    assert.equal(result.ok, true, 'WORK_FOLDER_MISSING で止まった: ' + JSON.stringify(result));
    assert.equal(result.created, true);
    assert.notEqual(result.code, 'WORK_FOLDER_MISSING');
    const created = gas.stubs.getDriveOps().filter((item) =>
      item.op === 'createFile' && item.id === result.exportSpreadsheetId);
    assert.equal(created.length, 1, '作業用フォルダに作られていない');
    assert.deepEqual(Array.from(created[0].parents), [WORK_FOLDER], '親が作業用フォルダでない');
  });

  // ================= wsl 2: S3 =================
  test('wsl 2: プロパティが無い・空白だけなら WORK_FOLDER_MISSING で止まり、何も作らない', () => {
    [null, '   '].forEach((value) => {
      buildFreeeWorld(value);
      const before = gas.stubs.getDriveCreateCount();
      const result = createExport();
      assert.equal(result.ok, false, String(value));
      assert.equal(result.created, false, String(value));
      assert.equal(result.code, 'WORK_FOLDER_MISSING', String(value));
      assert.equal(gas.stubs.getDriveCreateCount(), before,
        '止まるはずが Drive に作っている: ' + String(value));
      assert.equal(gas.stubs.getDriveOps().filter((item) => item.op === 'createFile').length, 0,
        String(value));
    });
  });

  // ================= wsl 3: S4 =================
  function buildFormatWorld(workPropertyValue) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    call('setMasterSpreadsheetId', ['master']);
    call('provisionMasterSheets');
    gas.stubs.setSpreadsheetOwner('master', 'owner@example.com');
    gas.stubs.setActiveUser('owner@example.com');
    gas.stubs.createSpreadsheet('wsl-format-dest', {sheets: [{name: INPUT_SHEET,
      values: [inputHeader()], maxRows: 30, maxColumns: 12}]});
    const card = gas.stubs.createFolder('wsl-format-card', {name: '架空カード', fileIds: []});
    gas.stubs.createFolder('wsl-format-root', {name: '架空顧客', fileIds: [], subFolderIds: ['wsl-format-card']});
    call('registerTestCustomer', [{customerId: CUSTOMER_ID, customerName: CUSTOMER_NAME,
      sourceFolderId: 'wsl-format-root', destinationSpreadsheetId: 'wsl-format-dest',
      destinationSheetName: INPUT_SHEET,
      columns: {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7},
      rowScanLastColumn: 12, rowScanExcludedColumns: [8, 9, 10],
      reviewers: 'owner@example.com', admins: 'owner@example.com'}]);
    gas.stubs.createFile('wsl-unknown', {
      name: '架空明細_202611.xlsx',
      bytes: Buffer.from('wsl-fictional-bytes'),
      xlsxSheets: [{name: '明細', values: [
        ['利用日', '利用先', '利用金額'],
        [serial('2026-11-01'), '架空店', 1000]
      ]}],
      lastUpdated: new Date(Date.now() - 3600000)
    });
    card.fileIds.push('wsl-unknown');
    call('registerReview', [{reviewType: 'FORMAT_UNKNOWN', customerId: CUSTOMER_ID,
      customerName: CUSTOMER_NAME, fileId: 'wsl-unknown',
      fileNameOriginal: '架空明細_202611.xlsx'}]);
    if (workPropertyValue !== null) {
      props().setProperty('PARALLEL_WORK_FOLDER_ID', workPropertyValue);
    }
  }

  function explainAndRecordCopies() {
    const drive = gas.context.Drive.Files;
    const realCopy = drive.copy;
    const copies = [];
    drive.copy = function(resource, fileId) {
      copies.push({fileId: String(fileId),
        parents: resource && resource.parents ? Array.from(resource.parents, String) : null});
      return realCopy.apply(this, arguments);
    };
    let result;
    try {
      result = call('webAppExplainUnknownFile', [CUSTOMER_ID, 'wsl-format-card', 'wsl-unknown']);
    } finally {
      drive.copy = realCopy;
    }
    assert.equal(result.ok, true, JSON.stringify(result));
    return copies;
  }

  test('wsl 3: 形式登録の Excel 読取は一時コピーを作業用フォルダにだけ作る', () => {
    buildFormatWorld(WORK_FOLDER);
    assert.equal(gas.evaluate('SETTINGS.PARALLEL_WORK_FOLDER_ID'), '');
    const copies = explainAndRecordCopies();
    assert.equal(copies.length, 1, '一時コピーが 1 回でない');
    assert.deepEqual(copies[0].parents, [WORK_FOLDER], '親が作業用フォルダだけになっていない');

    buildFormatWorld(null);
    const fallback = explainAndRecordCopies();
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].parents, null, '空のときに parents を付けている');
  });

  // ================= wsl 4: S1 の順序 =================
  test('wsl 4: webAppInvoke_ は fn と repair より前にプロパティの値を SETTINGS へ入れる', () => {
    gas.stubs.reset();
    props().setProperty('PARALLEL_WORK_FOLDER_ID', WORK_FOLDER);
    const order = [];
    const realRepair = gas.context.repairPendingDestinationCompaction_;
    gas.context.repairPendingDestinationCompaction_ = function() {
      order.push('repair:' + gas.evaluate('SETTINGS.PARALLEL_WORK_FOLDER_ID'));
    };
    let returned;
    try {
      returned = gas.context.webAppInvoke_(function() {
        order.push('fn:' + gas.evaluate('SETTINGS.PARALLEL_WORK_FOLDER_ID'));
        return 1;
      });
    } finally {
      gas.context.repairPendingDestinationCompaction_ = realRepair;
    }
    assert.equal(returned, 1);
    assert.deepEqual(order, ['repair:' + WORK_FOLDER, 'fn:' + WORK_FOLDER],
      '読み込みの順序が違う');
  });

  // ================= wsl 5: S1 の網羅 =================
  function firstStatement(lines, headerIndex) {
    let index = headerIndex;
    while (index < lines.length && lines[index].indexOf('{') < 0) index += 1;
    index += 1;
    let inBlock = false;
    for (; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      if (inBlock) {
        if (line.indexOf('*/') >= 0) inBlock = false;
        continue;
      }
      if (line.indexOf('/*') >= 0) {
        if (line.indexOf('*/') < 0) inBlock = true;
        continue;
      }
      if (line.indexOf('//') === 0) continue;
      return line;
    }
    return '';
  }

  function entryFunctions() {
    const srcDir = path.join(__dirname, '..', 'src');
    const entries = [];
    fs.readdirSync(srcDir).filter((name) => name.endsWith('.gs')).sort().forEach((file) => {
      const source = fs.readFileSync(path.join(srcDir, file), 'utf8');
      const lines = source.split(/\r?\n/);
      lines.forEach((line, index) => {
        const match = /^function (doGet|webApp[A-Za-z0-9]+)\(/.exec(line);
        if (!match) return;
        entries.push({file, lines, name: match[1], first: firstStatement(lines, index)});
      });
    });
    return entries;
  }

  test('wsl 5: 画面の入口 27 個はすべて webAppInvoke_ を通る', () => {
    const entries = entryFunctions();
    assert.equal(entries.length, 27, '入口の数が変わった: ' +
      entries.map((entry) => entry.name).join(', '));
    const exceptions = ['webAppRunImport', 'webAppPrepareImport'];
    const direct = entries.filter((entry) => entry.first.indexOf('return webAppInvoke_(') === 0)
      .map((entry) => entry.name).sort();
    const indirect = entries.filter((entry) => exceptions.indexOf(entry.name) >= 0);
    assert.equal(indirect.length, 2, '例外の入口が 2 つでない');
    indirect.forEach((entry) => {
      assert.equal(entry.first.indexOf('return webAppImportCall_('), 0,
        entry.name + ' が webAppImportCall_ を通っていない');
    });
    assert.equal(direct.length, 25, 'webAppInvoke_ を直に呼ばない入口がある: ' +
      entries.filter((entry) => direct.indexOf(entry.name) < 0 &&
        exceptions.indexOf(entry.name) < 0).map((entry) => entry.name).join(', '));

    const webAppFile = path.join(__dirname, '..', 'src', '80_WebApp.gs');
    const source = fs.readFileSync(webAppFile, 'utf8');
    assert.ok(source.indexOf('function webAppImportCall_(') >= 0);
    const body = source.slice(source.indexOf('function webAppImportCall_('));
    assert.ok(body.indexOf('webAppInvoke_(') >= 0,
      'webAppImportCall_ が webAppInvoke_ を通っていない');
  });

  // ================= wsl 6: S5 =================
  test('wsl 6: 設定の読み込みは Sheets の読取を増やさない', () => {
    gas.stubs.reset();
    props().setProperty('PARALLEL_WORK_FOLDER_ID', WORK_FOLDER);
    const before = gas.evaluate('apiReadCount_');
    const returned = gas.context.webAppInvoke_(function() { return 1; });
    const after = gas.evaluate('apiReadCount_');
    assert.equal(returned, 1);
    assert.equal(after, before, 'Sheets の読取が増えている');
  });
};

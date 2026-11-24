'use strict';

/**
 * 作業用フォルダ（`SETTINGS.PARALLEL_WORK_FOLDER_ID`）が空のときは
 * Excel の一時コピーを作らない（仕様 `work/spec_work_folder_guard.md` 版 1.0）。
 *
 * 値はすべて架空である。顧客 WFG1・架空 太郎・テストカード。
 * `test/fixtures/` は読まない。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const blank = (length) => Array(length).fill('');
  const hourAgo = () => new Date(Date.now() - 3600 * 1000);

  const CUSTOMER_ID = 'WFG1';
  const CUSTOMER_NAME = '架空 太郎';
  const WORK_FOLDER = 'wfg-work-folder';
  const XLSX_ID = 'wfg-xlsx-1';
  const CSV_ID = 'wfg-csv-1';
  const DEST_ID = 'wfg-dest';
  const INPUT_SHEET = '入力用シート';
  const HEADER_ROW = 1;

  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
  const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

  const AE = JSON.stringify({row: 1, cells: [{column: 2, text: '利用日', match: 'exact'}]});

  /** `Drive.Files.copy` の呼出しを記録する。 */
  function withCopySpy(fn) {
    const drive = gas.context.Drive.Files;
    const realCopy = drive.copy;
    const calls = [];
    drive.copy = function(resource, fileId, options) {
      calls.push({
        resource: JSON.parse(JSON.stringify(resource || {})),
        fileId: String(fileId),
        options: options === undefined ? null : JSON.parse(JSON.stringify(options))
      });
      return realCopy.apply(this, arguments);
    };
    try {
      return {value: fn(), calls: calls};
    } finally {
      drive.copy = realCopy;
    }
  }

  /** 作業用フォルダを 1 つ作る（中身は空）。 */
  function createWorkFolder() {
    return gas.stubs.createFolder(WORK_FOLDER, {fileIds: []});
  }

  function createXlsx(id, sheets) {
    return gas.stubs.createFile(id, {
      name: '架空明細202601.xlsx',
      bytes: Buffer.from('wfg-fictional-xlsx-bytes'),
      contentType: XLSX_MIME,
      xlsxSheets: sheets || [{name: '明細', values: [
        ['利用日', '利用店名', '金額', '使用用途'],
        ['2025/12/16', '架空店', 1000, '仕入れ']
      ], maxRows: 2, maxColumns: 4}],
      lastUpdated: hourAgo(),
      createdTime: '2026-08-01T00:00:00Z'
    });
  }

  function driveCreateFileCount() {
    return gas.stubs.getDriveOps().filter((item) => item.op === 'createFile').length;
  }

  function customerRow() {
    const row = blank(37);
    Object.assign(row, {
      0: CUSTOMER_ID, 1: CUSTOMER_NAME, 2: 'TRUE', 3: 'folder1', 5: DEST_ID, 7: INPUT_SHEET, 8: '取引先一覧',
      9: 2, 10: 3, 11: 4, 12: 5, 13: 6, 14: 7, 15: '1.0',
      16: 'reviewer@example.com', 17: 'admin@example.com', 18: 0, 20: 'システム情報', 21: '',
      23: 0, 24: 0, 29: 1, 30: AE, 31: '{}', 32: '{}', 33: 8,
      34: '取引先一覧', 35: 'CORPORATE', 36: ''
    });
    return row;
  }

  function formatRow() {
    const row = blank(34);
    Object.assign(row, {
      0: 'wfg_format', 1: '架空形式', 2: 'active', 3: 'TRUE', 4: '["csv"]',
      5: JSON.stringify({allOf: [{maxRow: 1, keywords: ['利用日', '利用店名', '金額', '使用用途'], minMatch: 4}]}),
      6: 1, 7: 2, 8: 'A', 9: 'B', 10: 'C', 11: 'D', 12: '',
      14: JSON.stringify({excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []}),
      16: JSON.stringify({sources: [{id: 'fn', kind: 'fileName', pattern: '(20\\d{2})(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}]}),
      17: 'generic', 18: 1, 19: 'admin@example.com', 21: '2026-01-01T00:00:00+09:00',
      29: 'NEW', 33: '2026-01-01T00:00:00+09:00'
    });
    return row;
  }

  function dictRow() {
    const row = blank(18);
    Object.assign(row, {
      0: 'DICT_WFG', 1: '架空店', 2: '架空店', 3: '株式会社架空店',
      4: 'exact_original', 5: 1, 6: '', 7: '', 8: '', 9: 'TRUE',
      10: 'admin@example.com', 12: '2026-01-01T00:00:00+09:00', 13: 1,
      14: 'TRUE', 15: 'FALSE'
    });
    return row;
  }

  /** 取込の回を 1 つ作る世界（61 の結線）。作業用フォルダは空。 */
  function importWorld() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [blank(37), customerRow()]},
      {name: 'カード形式マスター', values: [blank(34), formatRow()]},
      {name: '使用用途補完マスター', values: [blank(10),
        Object.assign(blank(10), {0: 'PR1', 1: '仕入', 2: '仕入れ', 3: 'TRUE'})]},
      {name: '共通取引先辞書', values: [blank(18), dictRow()]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.createSpreadsheet(DEST_ID, {sheets: [
      {name: INPUT_SHEET,
       values: [['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID', '']],
       maxRows: 12, maxColumns: 8},
      {name: '取引先一覧', values: [['取引先']]}
    ]});
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createSpreadsheet('snap', {sheets: []});
    gas.evaluate(`
      SETTINGS.EXECUTION_TIMEOUT_SECONDS = 300;
      SETTINGS.SAFETY_MARGIN_SECONDS = 60;
      SETTINGS.TX_INDEX_SPREADSHEET_ID = 'txidx';
      SETTINGS.SNAPSHOT_SPREADSHEET_ID = 'snap';
      SETTINGS.SAMPLE_CORPUS_FOLDER_ID = 'corpus';
      SETTINGS.PARALLEL_WORK_FOLDER_ID = '';
      SETTINGS.FAULT_INJECTION = null;
    `);
    gas.stubs.setActiveUser('admin@example.com');
    return gas.stubs.createFolder('folder1', {fileIds: []});
  }

  function csvBytes() {
    return Buffer.from('利用日,利用店名,金額,使用用途\n2025/12/16,架空店,10800,仕入れ\n', 'utf8');
  }

  function putCsv(id) {
    gas.stubs.createFile(id, {
      name: '架空カード202601.csv', bytes: csvBytes(), lastUpdated: hourAgo(),
      createdTime: '2026-08-01T00:00:00Z', contentType: 'text/csv'
    });
  }

  const destSheet = () => gas.stubs.getSpreadsheet(DEST_ID).getSheetByName(INPUT_SHEET);

  function processLogRowCount() {
    return gas.stubs.getSpreadsheet('master').getSheetByName('クレカ処理ログ').getLastRow();
  }

  function activeLeaseFor(fileId) {
    return plain(gas.call('activeLeases_', [])).filter((lease) => String(lease.fileId) === String(fileId));
  }

  // ================= wfg 1: G1 =================
  test('wfg 1: 作業用フォルダが空なら WORK_FOLDER_MISSING で止まり、Drive.Files.copy を呼ばない', () => {
    const values = [
      {label: "''", source: "SETTINGS.PARALLEL_WORK_FOLDER_ID = ''", expected: ''},
      {label: "'   '", source: "SETTINGS.PARALLEL_WORK_FOLDER_ID = '   '", expected: '   '},
      {label: 'null', source: 'SETTINGS.PARALLEL_WORK_FOLDER_ID = null', expected: null},
      {label: 'undefined', source: 'SETTINGS.PARALLEL_WORK_FOLDER_ID = undefined', expected: undefined}
    ];
    values.forEach((value) => {
      gas.stubs.reset();
      createXlsx(XLSX_ID);
      gas.evaluate(value.source);
      assert.equal(gas.evaluate('SETTINGS.PARALLEL_WORK_FOLDER_ID'), value.expected, value.label);
      const spreadsheetsBefore = gas.stubs.getSpreadsheetIds().length;
      const createdBefore = gas.stubs.getDriveCreateCount();
      let thrown = null;
      const copy = withCopySpy(() => {
        try {
          return gas.call('convertXlsxToTemp', [XLSX_ID]);
        } catch (error) {
          thrown = error;
          return null;
        }
      });
      assert.ok(thrown, '例外にならなかった: ' + value.label);
      assert.equal(thrown.code, 'WORK_FOLDER_MISSING',
        'code が WORK_FOLDER_MISSING でない: ' + value.label);
      assert.equal(copy.value, null, value.label);
      assert.equal(copy.calls.length, 0, '空なのに Drive.Files.copy を呼んでいる: ' + value.label);
      assert.equal(gas.stubs.getSpreadsheetIds().length, spreadsheetsBefore,
        '空なのに Drive にファイルができている: ' + value.label);
      assert.equal(gas.stubs.getDriveCreateCount(), createdBefore, value.label);
      assert.equal(driveCreateFileCount(), 0, value.label);
    });
  });

  // ================= wfg 2: G2 =================
  test('wfg 2: 作業用フォルダがあれば copy の引数は今のままで、一時コピーは正常・例外の道で消える', () => {
    gas.stubs.reset();
    createWorkFolder();
    createXlsx(XLSX_ID);
    gas.evaluate("SETTINGS.PARALLEL_WORK_FOLDER_ID = '" + WORK_FOLDER + "';");
    const before = gas.stubs.getSpreadsheetIds().length;
    const copy = withCopySpy(() => plain(gas.call('readFile', [XLSX_ID, '架空明細202601.xlsx', {}])));
    assert.equal(copy.calls.length, 1, '一時コピーが 1 回でない');
    assert.equal(copy.calls[0].fileId, XLSX_ID);
    assert.deepEqual(copy.calls[0].resource, {
      mimeType: SHEET_MIME,
      name: 'tmp_import_' + XLSX_ID,
      parents: [WORK_FOLDER]
    }, 'copy の resource が今と違う');
    assert.deepEqual(copy.calls[0].options, {supportsAllDrives: true}, 'copy の引数が今と違う');
    assert.equal(copy.value.sheets.length, 1);
    assert.equal(gas.stubs.getSpreadsheetIds().length, before,
      '正常の道で一時コピーが残っている');

    // 例外の道：読取の途中（シート数上限）で止まっても一時コピーは消える。
    gas.stubs.reset();
    createWorkFolder();
    createXlsx(XLSX_ID, [
      {name: 'S1', values: [['a']]}, {name: 'S2', values: [['a']]}, {name: 'S3', values: [['a']]}
    ]);
    gas.evaluate("SETTINGS.PARALLEL_WORK_FOLDER_ID = '" + WORK_FOLDER + "';");
    gas.evaluate('SETTINGS.MAX_SHEETS_PER_FILE = 2');
    const beforeException = gas.stubs.getSpreadsheetIds().length;
    let exceptionThrown = null;
    const exceptional = withCopySpy(() => {
      try {
        return gas.call('readFile', [XLSX_ID, '架空明細202601.xlsx', {}]);
      } catch (error) {
        exceptionThrown = error;
        return null;
      }
    });
    assert.ok(exceptionThrown, '例外にならなかった');
    assert.equal(exceptionThrown.code, 'INPUT_LIMIT_EXCEEDED');
    assert.equal(exceptional.calls.length, 1);
    assert.equal(gas.stubs.getSpreadsheetIds().length, beforeException,
      '例外の道で一時コピーが残っている');
    assert.equal(gas.stubs.getDriveRemovedIds().length, 1, '一時コピーを消していない');
  });

  // ================= wfg 3: G3 =================
  test('wfg 3: 取込で作業用フォルダが空の .xlsx は FAILED/WORK_FOLDER_MISSING で、状態・名前・転記先を変えない', () => {
    const folder = importWorld();
    createXlsx(XLSX_ID);
    folder.fileIds.push(XLSX_ID);
    const nameBefore = gas.stubs.getFile(XLSX_ID).getName();
    // 取込前の状態を 1 行だけ置き、止まっても状態が動かないことを見られるようにする。
    const customer = plain(gas.call('getCustomerById', [CUSTOMER_ID]));
    gas.call('createOrUpdateProcessLog', ['RUN_WFG', customer, {
      id: XLSX_ID,
      originalFileName: nameBefore,
      state: gas.evaluate('FILE_STATE.DISCOVERED')
    }, undefined]);
    const stateBefore = gas.call('getFileState', [XLSX_ID]);
    const processRowsBefore = processLogRowCount();
    const spreadsheetsBefore = gas.stubs.getSpreadsheetIds().length;
    const writesBefore = gas.stubs.getWriteLog().filter((item) => item.spreadsheetId === DEST_ID).length;

    const copy = withCopySpy(() => plain(gas.call('runImport', [{}])));
    const report = copy.value;
    const fileReport = report.customers[0].files.filter((item) => item.fileId === XLSX_ID)[0];
    assert.ok(fileReport, JSON.stringify(report));
    assert.equal(fileReport.outcome, 'FAILED', JSON.stringify(fileReport));
    assert.equal(fileReport.errorCode, 'WORK_FOLDER_MISSING', JSON.stringify(fileReport));
    assert.equal(gas.stubs.getFile(XLSX_ID).getName(), nameBefore,
      'ファイル名の頭を変えている');
    assert.equal(gas.call('getFileState', [XLSX_ID]), stateBefore,
      'ファイルの状態が動いている');
    assert.equal(processLogRowCount(), processRowsBefore,
      '処理ログへ登録している（状態が動く道に入っている）');
    assert.deepEqual(activeLeaseFor(XLSX_ID), [], 'リースが残っている');
    assert.equal(gas.stubs.getWriteLog().filter((item) => item.spreadsheetId === DEST_ID).length,
      writesBefore, '転記先へ書いている');
    assert.equal(destSheet().getLastRow(), HEADER_ROW, '転記先へ書いている');
    assert.equal(copy.calls.length, 0, 'Drive.Files.copy を呼んでいる');
    assert.equal(gas.stubs.getSpreadsheetIds().length, spreadsheetsBefore,
      'Drive にファイルができている');
    assert.equal(driveCreateFileCount(), 0, 'Drive にファイルができている');
  });

  // ================= wfg 4: G4 =================
  test('wfg 4: 同じ回の CSV は作業用フォルダが空でも今どおり取り込まれる', () => {
    const folder = importWorld();
    putCsv(CSV_ID);
    createXlsx(XLSX_ID);
    folder.fileIds.push(CSV_ID, XLSX_ID);

    const copy = withCopySpy(() => plain(gas.call('runImport', [{}])));
    const report = copy.value;
    const files = report.customers[0].files;
    const csvReport = files.filter((item) => item.fileId === CSV_ID)[0];
    const xlsxReport = files.filter((item) => item.fileId === XLSX_ID)[0];
    assert.ok(csvReport, JSON.stringify(report));
    assert.equal(csvReport.outcome, 'WRITTEN', JSON.stringify(csvReport));
    assert.equal(csvReport.nextState, 'COMPLETED');
    assert.ok(xlsxReport, JSON.stringify(report));
    assert.equal(xlsxReport.outcome, 'FAILED', JSON.stringify(xlsxReport));
    assert.equal(xlsxReport.errorCode, 'WORK_FOLDER_MISSING');

    assert.equal(destSheet().getRange(2, 3).getValue(), '株式会社架空店');
    assert.equal(destSheet().getRange(2, 6).getValue(), 10800);
    assert.equal(copy.calls.length, 0, 'Drive.Files.copy を呼んでいる');
  });

  // ================= wfg 5: G5 =================
  test('wfg 5: 作業用フォルダが空でも CSV・Google スプレッドシート・ショートカットは読める', () => {
    gas.stubs.reset();
    gas.evaluate("SETTINGS.PARALLEL_WORK_FOLDER_ID = '';");

    gas.stubs.createFile(CSV_ID, {name: '架空.csv', bytes: csvBytes()});
    const csv = plain(gas.call('readFile', [CSV_ID, '架空.csv', {}]));
    assert.equal(csv.fileType, 'csv');
    assert.deepEqual(csv.sheets[0].rows[0], ['利用日', '利用店名', '金額', '使用用途']);

    gas.stubs.createSpreadsheet('wfg-gsheet', {sheets: [{name: '明細', values: [
      ['利用日', '利用店名', '金額', '使用用途'], ['2025/12/16', '架空店', 1000, '仕入れ']
    ]}]});
    const sheet = plain(gas.call('readFile', ['wfg-gsheet', '架空シート', {}]));
    assert.equal(sheet.fileType, 'xlsx');
    assert.equal(sheet.sourceKind, 'GOOGLE_SHEET');
    assert.equal(sheet.sheets.length, 1);

    gas.stubs.createSpreadsheet('wfg-target', {sheets: [{name: '明細', values: [
      ['利用日', '利用店名', '金額', '使用用途'], ['2025/12/16', '架空店', 2000, '仕入れ']
    ]}]});
    gas.stubs.createFile('wfg-shortcut', {name: '架空ショートカット', contentType: SHORTCUT_MIME,
      targetId: 'wfg-target', targetMimeType: SHEET_MIME});
    const shortcut = plain(gas.call('readFile', ['wfg-shortcut', '架空ショートカット', {}]));
    assert.equal(shortcut.fileType, 'xlsx');
    assert.equal(shortcut.sourceKind, 'SHORTCUT');
    assert.equal(shortcut.targetId, 'wfg-target');
    assert.equal(shortcut.sheets[0].rows[1][2], 2000);
  });

  // ================= wfg 6: G6 =================
  test('wfg 6: 画面の再検査で作業用フォルダが空の .xlsx は REQUEUE_FAILED で飛ばし、要確認も状態も変えない', () => {
    formatWorld();
    const reviewBefore = plain(gas.call('openReviews', [{}]))
      .filter((item) => item.fileId === XLSX_ID && item.reviewType === 'FORMAT_UNKNOWN').length;
    assert.equal(reviewBefore, 1, '前提の要確認が無い');
    const stateBefore = gas.call('getFileState', [XLSX_ID]);
    const nameBefore = gas.stubs.getFile(XLSX_ID).getName();
    const spreadsheetsBefore = gas.stubs.getSpreadsheetIds().length;

    const copy = withCopySpy(() => plain(gas.call('webAppRequeueFormatFiles',
      [CUSTOMER_ID, 'wfg-format-card', [XLSX_ID]])));
    const result = copy.value;
    assert.deepEqual(result.requeued, [], JSON.stringify(result));
    assert.equal(result.skipped.length, 1, JSON.stringify(result));
    assert.equal(result.skipped[0].fileId, XLSX_ID);
    assert.equal(result.skipped[0].code, 'REQUEUE_FAILED');
    assert.equal(gas.call('getFileState', [XLSX_ID]), stateBefore, 'ファイルの状態が動いている');
    assert.equal(gas.stubs.getFile(XLSX_ID).getName(), nameBefore, 'ファイル名が動いている');
    assert.equal(plain(gas.call('openReviews', [{}]))
      .filter((item) => item.fileId === XLSX_ID && item.reviewType === 'FORMAT_UNKNOWN').length,
      1, '要確認を解決している');
    assert.equal(copy.calls.length, 0, 'Drive.Files.copy を呼んでいる');
    assert.equal(gas.stubs.getSpreadsheetIds().length, spreadsheetsBefore,
      'Drive にファイルができている');
    assert.equal(driveCreateFileCount(), 0, 'Drive にファイルができている');
  });

  // ================= wfg 7: G7 =================
  test('wfg 7: 形式登録の読取で作業用フォルダが空の .xlsx は例外になり、形式の表へ書かない', () => {
    formatWorld();
    const spreadsheetsBefore = gas.stubs.getSpreadsheetIds().length;
    const formatWritesBefore = formatSheetWrites();
    const writesBefore = gas.stubs.getWriteLog().length;
    let thrown = null;
    try {
      gas.call('webAppExplainUnknownFile', [CUSTOMER_ID, 'wfg-format-card', XLSX_ID]);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, '例外にならなかった');
    assert.equal(thrown.code, 'WORK_FOLDER_MISSING', String(thrown && thrown.message));
    assert.equal(gas.stubs.getSpreadsheetIds().length, spreadsheetsBefore,
      'Drive にファイルができている');
    assert.equal(formatSheetWrites(), formatWritesBefore, '形式の表へ書いている');
    assert.equal(gas.stubs.getWriteLog().length, writesBefore, 'どこかのシートへ書いている');
    assert.equal(driveCreateFileCount(), 0, 'Drive にファイルができている');
  });

  // ================= 形式登録の世界 =================
  function formatSheetWrites() {
    return gas.stubs.getWriteLog().filter((item) =>
      item.spreadsheetId === 'master' &&
      (item.sheetName === 'カード形式マスター' || item.sheetName === '形式サンプル')).length;
  }

  function formatWorld() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets');
    gas.stubs.setSpreadsheetOwner('master', 'owner@example.com');
    gas.stubs.setActiveUser('owner@example.com');
    gas.stubs.createSpreadsheet('wfg-format-dest', {sheets: [{name: INPUT_SHEET,
      values: [['利用日', '利用店名', '金額']], maxRows: 30, maxColumns: 12}]});
    const card = gas.stubs.createFolder('wfg-format-card', {name: '架空カード', fileIds: []});
    gas.stubs.createFolder('wfg-format-root', {name: '架空顧客', fileIds: [],
      subFolderIds: ['wfg-format-card']});
    gas.call('registerTestCustomer', [{customerId: CUSTOMER_ID, customerName: CUSTOMER_NAME,
      sourceFolderId: 'wfg-format-root', destinationSpreadsheetId: 'wfg-format-dest',
      destinationSheetName: INPUT_SHEET,
      columns: {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7},
      rowScanLastColumn: 12, rowScanExcludedColumns: [8, 9, 10],
      reviewers: 'owner@example.com', admins: 'owner@example.com'}]);
    createXlsx(XLSX_ID, [{name: '明細', values: [
      ['利用日', '利用先', '利用金額'],
      [46027, '架空店', 1000]
    ]}]);
    card.fileIds.push(XLSX_ID);
    gas.call('registerReview', [{reviewType: 'FORMAT_UNKNOWN', customerId: CUSTOMER_ID,
      customerName: CUSTOMER_NAME, fileId: XLSX_ID,
      fileNameOriginal: '架空明細202601.xlsx'}]);
    gas.evaluate(`
      SETTINGS.EXECUTION_TIMEOUT_SECONDS = 300;
      SETTINGS.SAFETY_MARGIN_SECONDS = 60;
      SETTINGS.PARALLEL_WORK_FOLDER_ID = '';
    `);
    // G6 は「状態が変わらない」を見るため、取込前の状態を 1 行だけ置く。
    const customer = plain(gas.call('getCustomerById', [CUSTOMER_ID]));
    gas.call('createOrUpdateProcessLog', ['RUN_WFG', customer, {
      id: XLSX_ID,
      originalFileName: '架空明細202601.xlsx',
      state: gas.evaluate('FILE_STATE.DISCOVERED')
    }, undefined]);
  }
};

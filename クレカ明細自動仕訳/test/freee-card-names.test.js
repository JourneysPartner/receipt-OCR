'use strict';

const crypto = require('node:crypto');

/**
 * 入力用シートの B1（freee のカード名）のサーバー側 前半
 * （`work/spec_freee_card_names.md` 版 1.0 の fcn 1〜17）。
 *
 * 値はすべて架空である。顧客 K9001・架空 太郎・テストカード・架空カードA。
 * Shift_JIS のバイト列は、このファイルの中で `TextDecoder('shift_jis')` から
 * 作った逆引きの表で組み立てる（外部のパッケージは足さない）。
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
  const withMocks = (overrides, fn) => {
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
  };

  const OWNER = 'owner@example.com';
  const MASTER = 'fcn-master';
  const CUSTOMER_ID = 'K9001';
  const CUSTOMER_NAME = '架空 太郎';
  const TEMPLATE_ID = 'fcn-template';
  const INPUT_SHEET = '入力用シート';
  const HEADER_ROW = 4;
  const SOURCE = 'fcn-source';
  const TABLE = 'freeeカード科目';

  const TABLE_HEADERS = ['顧客ID', '勘定科目', 'カード候補', '対応', 'CSVファイル名',
    'CSVのSHA-256', 'CSV登録日時', 'CSV登録者', '対応更新日時', '対応更新者', '版'];

  const CSV_HEADERS_12 = ['勘定科目', '表示名（決算書）', '小分類', '中分類', '大分類',
    '収入取引相手方勘定科目', '支出取引相手方勘定科目', '税区分', 'ショートカット1',
    'ショートカット2', '入力候補', '補助科目優先タグ'];
  const CSV_HEADERS_13 = ['勘定科目', '表示名(決算書)', '小分類', '中分類', '大分類',
    '収入取引相手方勘定科目', '支出取引相手方勘定科目', '税区分', 'ショートカット1',
    'ショートカット2', '検索での表示', '補助科目優先タグ', '勘定科目コード'];

  const ACCOUNTS = ['架空カードA', 'テストカード', 'visaカード', '架空経費', '架空売上'];
  const CANDIDATES = ['架空カードA', 'テストカード', 'visaカード'];

  function master() { return gas.stubs.getSpreadsheet(MASTER); }
  function customerMaster() { return master().getSheetByName('顧客マスター'); }
  function tableSheet() { return master().getSheetByName(TABLE); }
  function auditRows() {
    const sheet = master().getSheetByName('監査ログ');
    return sheet.getDataRange().getValues().slice(1)
      .filter((row) => row[0] !== '' && row[0] !== null && row[0] !== undefined);
  }
  function auditOf(type) { return auditRows().filter((row) => String(row[2]) === type); }
  function tableRowValues(rowNumber = 2) {
    return plain(tableSheet().getRange(rowNumber, 1, 1, 11).getValues()[0]);
  }
  function tableRowObject(rowNumber = 2) {
    const values = tableRowValues(rowNumber);
    return {
      customerId: values[0],
      accountNames: JSON.parse(String(values[1])),
      candidates: JSON.parse(String(values[2])),
      mappings: JSON.parse(String(values[3])),
      fileName: values[4],
      sha256: values[5],
      uploadedAt: values[6],
      uploadedBy: values[7],
      mappingUpdatedAt: values[8],
      mappingUpdatedBy: values[9],
      version: values[10]
    };
  }

  function buildWorld(options = {}) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet(MASTER, {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet(MASTER);
    call('setMasterSpreadsheetId', [MASTER]);
    call('provisionMasterSheets');
    gas.stubs.setSpreadsheetOwner(MASTER, OWNER);
    gas.stubs.setActiveUser(OWNER);
    gas.evaluate(
      "SETTINGS.EXECUTION_TIMEOUT_SECONDS=300;" +
      "SETTINGS.SAFETY_MARGIN_SECONDS=60;" +
      "SETTINGS.TX_INDEX_SPREADSHEET_ID='fcn-txidx';" +
      "SETTINGS.SNAPSHOT_SPREADSHEET_ID='fcn-snap';" +
      "SETTINGS.SAMPLE_CORPUS_FOLDER_ID='fcn-corpus';" +
      "SETTINGS.PARALLEL_WORK_FOLDER_ID='';" +
      'SETTINGS.FAULT_INJECTION=null;');
    gas.stubs.createSpreadsheet('fcn-txidx', {sheets: []});
    gas.stubs.createSpreadsheet('fcn-snap', {sheets: []});
    gas.stubs.createFolder('fcn-corpus', {fileIds: []});

    const customerHeaderRow = options.headerRow === undefined ? HEADER_ROW : Number(options.headerRow);
    const templateHeaderRow = options.templateHeaderRow === undefined ?
      HEADER_ROW : Number(options.templateHeaderRow);
    const templateValues = Array.from({length: Math.max(templateHeaderRow, 1)}, () => blank(10));
    if (templateHeaderRow >= 2) templateValues[0][1] = '○○カード';
    templateValues[templateHeaderRow - 1] = ['', '利用日', 'freee取引先名', '摘要', '金額',
      'メモ', '内部ID', '税区分', '勘定科目', '消費税'];
    gas.stubs.createSpreadsheet(TEMPLATE_ID, {
      name: CUSTOMER_NAME + '_雛形',
      sheets: [
        {name: INPUT_SHEET, values: templateValues, maxRows: 20, maxColumns: 10},
        {name: '取引先一覧', values: [['元店名', '取引先名'], ['既知店', '株式会社既知店']]}
      ]
    });
    gas.stubs.createFolder('fcn-dest-parent', {fileIds: [TEMPLATE_ID]});
    call('registerTestCustomer', [{
      customerId: CUSTOMER_ID,
      customerName: CUSTOMER_NAME,
      active: true,
      sourceFolderId: SOURCE,
      destinationSpreadsheetId: TEMPLATE_ID,
      destinationSheetName: INPUT_SHEET,
      partnerListSheetName: '取引先一覧',
      columns: {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7, G: 8},
      headerRow: customerHeaderRow,
      dataStartRow: customerHeaderRow + 1,
      rowScanLastColumn: 10,
      rowScanExcludedColumns: [8, 9, 10],
      reviewers: OWNER,
      admins: OWNER
    }]);

    const folderSpecs = [
      ['fcn-card-test', 'テストカード'],
      ['fcn-card-a', '架空カードA'],
      ['fcn-card-b', '架空カード B ']
    ].concat(options.extraFolders || []);
    gas.stubs.createFolder(SOURCE, {name: '架空明細', subFolderIds: []});
    const createdFolders = [];
    folderSpecs.forEach(([id, name]) => {
      createdFolders.push(gas.stubs.createFolder(id, {name: name, parentId: SOURCE}));
    });
    gas.stubs.resetApiCallCounts();
    gas.stubs.resetRoundTrips();
    gas.stubs.resetWriteLog();
    return {folders: folderSpecs, folderObjects: createdFolders};
  }

  /** fcn 27 用：もう 1 人の架空の顧客を、同じ雛形・同じ明細フォルダで登録する。 */
  function registerOtherCustomer(customerId) {
    call('registerTestCustomer', [{
      customerId: customerId,
      customerName: '架空 次郎',
      active: true,
      sourceFolderId: SOURCE,
      destinationSpreadsheetId: TEMPLATE_ID,
      destinationSheetName: INPUT_SHEET,
      partnerListSheetName: '取引先一覧',
      columns: {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7, G: 8},
      headerRow: HEADER_ROW,
      dataStartRow: HEADER_ROW + 1,
      rowScanLastColumn: 10,
      rowScanExcludedColumns: [8, 9, 10],
      reviewers: OWNER,
      admins: OWNER
    }]);
  }

  function seedTable(rows, options = {}) {
    const sheet = master().insertSheet(TABLE, {maxRows: 50, maxColumns: 11});
    sheet.getRange(1, 1, 1, 11).setValues([options.headers || TABLE_HEADERS.slice()]);
    if (rows && rows.length) {
      sheet.getRange(2, 1, rows.length, 11).setValues(rows.map((row) => {
        const padded = blank(11);
        row.forEach((value, index) => { padded[index] = value; });
        return padded;
      }));
    }
    return sheet;
  }

  function tableRow(overrides = {}) {
    const row = blank(11);
    row[0] = overrides.customerId === undefined ? CUSTOMER_ID : overrides.customerId;
    row[1] = typeof overrides.accountNames === 'string' ? overrides.accountNames :
      JSON.stringify(overrides.accountNames || ACCOUNTS);
    row[2] = typeof overrides.candidates === 'string' ? overrides.candidates :
      JSON.stringify(overrides.candidates || CANDIDATES);
    row[3] = typeof overrides.mappings === 'string' ? overrides.mappings :
      JSON.stringify(overrides.mappings || {});
    row[4] = overrides.fileName === undefined ? '勘定科目.csv' : overrides.fileName;
    row[5] = overrides.sha256 === undefined ? 'a'.repeat(64) : overrides.sha256;
    row[6] = overrides.uploadedAt === undefined ? '2026-01-01T00:00:00+09:00' : overrides.uploadedAt;
    row[7] = overrides.uploadedBy === undefined ? 'old@example.com' : overrides.uploadedBy;
    row[8] = overrides.mappingUpdatedAt === undefined ? '' : overrides.mappingUpdatedAt;
    row[9] = overrides.mappingUpdatedBy === undefined ? '' : overrides.mappingUpdatedBy;
    row[10] = overrides.version === undefined ? 1 : overrides.version;
    return row;
  }

  let shiftJisEncode = null;
  function getShiftJisEncoder() {
    if (shiftJisEncode) return shiftJisEncode;
    const decoder = new TextDecoder('shift_jis');
    const table = new Map();
    const register = (bytes) => {
      let text;
      try { text = decoder.decode(Uint8Array.from(bytes)); } catch (ignored) { return; }
      if (text.length === 1 && !table.has(text)) table.set(text, bytes);
    };
    for (let first = 0x81; first <= 0x9F; first += 1) {
      for (let second = 0x40; second <= 0xFC; second += 1) register([first, second]);
    }
    for (let first = 0xE0; first <= 0xFC; first += 1) {
      for (let second = 0x40; second <= 0xFC; second += 1) register([first, second]);
    }
    for (let first = 0x00; first <= 0x7F; first += 1) register([first]);
    for (let first = 0xA1; first <= 0xDF; first += 1) register([first]);
    shiftJisEncode = (text) => {
      const bytes = [];
      for (const character of String(text)) {
        const mapped = table.get(character);
        if (!mapped) throw new Error('Shift_JIS に無い文字: ' + character);
        bytes.push.apply(bytes, mapped);
      }
      return bytes;
    };
    return shiftJisEncode;
  }

  function csvText(rows, options = {}) {
    const escape = (value) => {
      const text = String(value);
      return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    const eol = options.crlf ? '\r\n' : '\n';
    return rows.map((row) => row.map(escape).join(',')).join(eol) + eol;
  }

  function accountRow(name, displayName) {
    const row = blank(12);
    row[0] = name;
    row[1] = displayName;
    return row;
  }

  function defaultCsvRows() {
    return [
      CSV_HEADERS_12.slice(),
      accountRow('架空カードA', '未払金'),
      accountRow('テストカード', '未払金'),
      accountRow('visaカード', '未払金'),
      accountRow('架空経費', '経費'),
      accountRow('架空売上', '売上'),
      blank(12)
    ];
  }

  function uploadBase64(base64, options = {}) {
    return call('webAppFreeeCardNamesUploadCsv', [CUSTOMER_ID,
      options.fileName === undefined ? '勘定科目.csv' : options.fileName,
      base64,
      options.expectedVersion === undefined ? 0 : options.expectedVersion]);
  }

  function uploadBytes(bytes, options = {}) {
    return uploadBase64(Buffer.from(bytes).toString('base64'), options);
  }

  function start() { return call('webAppFreeeCardNamesStart', [CUSTOMER_ID]); }
  function save(changes, expectedVersion) {
    return call('webAppFreeeCardNamesSave', [CUSTOMER_ID, changes, expectedVersion]);
  }

  function writeIndex(log, sheetName) {
    for (let index = 0; index < log.length; index += 1) {
      if (log[index].sheetName === sheetName) return index;
    }
    return -1;
  }

  function withBatchGetRecorder(fn) {
    const real = gas.context.Sheets.Spreadsheets.Values.batchGet;
    const ranges = [];
    gas.context.Sheets.Spreadsheets.Values.batchGet = function(spreadsheetId, request) {
      (request && request.ranges || []).forEach((range) => ranges.push(String(range)));
      return real.call(this, spreadsheetId, request);
    };
    try {
      return {result: fn(), ranges: ranges};
    } finally {
      gas.context.Sheets.Spreadsheets.Values.batchGet = real;
    }
  }

  // ================= fcn 1 =================
  test('fcn 1: Shift_JIS・BOM なし・LF・12 列の CSV を読む', () => {
    const bytes = getShiftJisEncoder()(csvText(defaultCsvRows()));
    const result = call('freeeCardNamesParseCsv_', [bytes]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.accountNames, ACCOUNTS);
    assert.deepEqual(result.candidates, CANDIDATES);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    assert.equal(result.rowCount, 5);
    const expectedSha = crypto.createHash('sha256')
      .update(Buffer.from(bytes.map((byte) => (Number(byte) + 256) & 0xff))).digest('hex');
    assert.equal(result.sha256, expectedSha, 'SHA-256 がバイト列と合わない');
  });

  // ================= fcn 2 =================
  test('fcn 2: UTF-8・BOM 付き・CRLF・13 列の CSV も同じに読む', () => {
    const rows = [
      CSV_HEADERS_13.slice(),
      accountRow('架空カードA', '未払金'),
      accountRow('テストカード', '未払金'),
      accountRow('visaカード', '未払金'),
      accountRow('架空経費', '経費'),
      accountRow('架空売上', '売上')
    ];
    const bytes = Array.from(Buffer.from('\uFEFF' + csvText(rows, {crlf: true}), 'utf8'));
    const result = call('freeeCardNamesParseCsv_', [bytes]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.accountNames, ACCOUNTS);
    assert.deepEqual(result.candidates, CANDIDATES);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
  });

  // ================= fcn 3 =================
  test('fcn 3: 見出しが足りない・2 つあると CSV_HEADER', () => {
    const missingDisplay = CSV_HEADERS_12.slice();
    missingDisplay[1] = '表示名ではない';
    const missing = call('freeeCardNamesParseCsv_', [getShiftJisEncoder()(csvText([
      missingDisplay, accountRow('架空カードA', '未払金')
    ]))]);
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'CSV_HEADER');
    assert.ok(missing.detail.missing.indexOf('表示名（決算書）') >= 0, 'missing に表示名が無い');

    const duplicatedAccount = CSV_HEADERS_12.slice();
    duplicatedAccount[2] = '勘定科目';
    const duplicated = call('freeeCardNamesParseCsv_', [getShiftJisEncoder()(csvText([
      duplicatedAccount, accountRow('架空カードA', '未払金')
    ]))]);
    assert.equal(duplicated.ok, false);
    assert.equal(duplicated.code, 'CSV_HEADER');
    assert.ok(duplicated.detail.duplicated.indexOf('勘定科目') >= 0, 'duplicated に勘定科目が無い');
  });

  // ================= fcn 4 =================
  test('fcn 4: 空の勘定科目・改行を含む名前・同じ名前 2 行を止める', () => {
    const emptyName = call('freeeCardNamesParseCsv_', [getShiftJisEncoder()(csvText([
      CSV_HEADERS_12.slice(),
      accountRow('架空カードA', '未払金'),
      accountRow('', '未払金')
    ]))]);
    assert.equal(emptyName.ok, false);
    assert.equal(emptyName.code, 'CSV_ROW_INVALID');
    assert.equal(emptyName.detail.row, 3, '物理の行番号が違う');

    const newline = call('freeeCardNamesParseCsv_', [getShiftJisEncoder()(csvText([
      CSV_HEADERS_12.slice(),
      accountRow('架空カードA', '未払金'),
      accountRow('架空\nカード', '未払金')
    ]))]);
    assert.equal(newline.ok, false);
    assert.equal(newline.code, 'CSV_ROW_INVALID');
    assert.equal(newline.detail.row, 3);

    const duplicate = call('freeeCardNamesParseCsv_', [getShiftJisEncoder()(csvText([
      CSV_HEADERS_12.slice(),
      accountRow('同名カード', '未払金'),
      accountRow('同名カード', '経費')
    ]))]);
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.code, 'CSV_DUPLICATE');
    assert.equal(duplicate.detail.name, '同名カード');
    assert.deepEqual(duplicate.detail.rows, [2, 3]);
  });

  // ================= fcn 5 =================
  test('fcn 5: 大きさ・base64・空・多すぎるを止める', () => {
    assert.equal(call('freeeCardNamesParseCsv_', [[]]).code, 'CSV_SIZE');
    assert.equal(call('freeeCardNamesParseCsv_', [Array(1048577).fill(0x41)]).code, 'CSV_SIZE');

    buildWorld();
    assert.equal(uploadBase64('!!!not-base64!!!', {expectedVersion: 0}).code, 'CSV_DECODE');
    gas.stubs.resetWriteLog();
    const emptyUpload = uploadBytes(
      Array.from(Buffer.from(csvText([CSV_HEADERS_12.slice()]), 'utf8')),
      {expectedVersion: 0});
    assert.equal(emptyUpload.code, 'CSV_EMPTY');
    assert.equal(tableSheet(), null, 'CSV_EMPTY なのにタブを作っている');
    assert.equal(gas.stubs.getWriteLog().length, 0, 'CSV_EMPTY なのに書いている（S3）');

    const headerOnly = call('freeeCardNamesParseCsv_',
      [Array.from(Buffer.from(csvText([CSV_HEADERS_12.slice()]), 'utf8'))]);
    assert.equal(headerOnly.ok, false);
    assert.equal(headerOnly.code, 'CSV_EMPTY');

    const many = [CSV_HEADERS_12.slice()];
    for (let index = 1; index <= 3001; index += 1) {
      many.push(accountRow('A' + index, '経費'));
    }
    const tooMany = call('freeeCardNamesParseCsv_',
      [Array.from(Buffer.from(csvText(many), 'utf8'))]);
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.code, 'CSV_TOO_MANY');
  });

  // ================= fcn 6 =================
  test('fcn 6: 初めての登録は、監査→タブ→1 行を RAW で書き、読み返す', () => {
    buildWorld();
    const auditBefore = auditOf('FREEE_CARD_CSV').length;
    gas.stubs.resetWriteLog();
    const result = uploadBytes(getShiftJisEncoder()(csvText(defaultCsvRows())),
      {fileName: '=1+1.csv', expectedVersion: 0});
    assert.equal(result.ok, true);
    assert.equal(result.version, 1);
    assert.equal(result.csv.fileName, '=1+1.csv');
    assert.equal(result.csv.accountCount, 5);
    assert.equal(result.csv.candidateCount, 3);
    assert.deepEqual(result.invalidMappings, []);

    const sheet = tableSheet();
    assert.ok(sheet, 'タブができていない');
    assert.deepEqual(plain(sheet.getRange(1, 1, 1, 11).getValues()[0]), TABLE_HEADERS);
    const row = tableRowObject(2);
    assert.equal(row.customerId, CUSTOMER_ID);
    assert.deepEqual(row.accountNames, ACCOUNTS);
    assert.deepEqual(row.candidates, CANDIDATES);
    assert.deepEqual(row.mappings, {});
    assert.equal(row.fileName, '=1+1.csv');
    assert.match(row.sha256, /^[0-9a-f]{64}$/);
    assert.ok(String(row.uploadedAt).length > 0);
    assert.equal(row.uploadedBy, OWNER);
    assert.equal(row.mappingUpdatedAt, '');
    assert.equal(row.mappingUpdatedBy, '');
    assert.equal(row.version, 1);
    assert.equal(sheet.getRange(2, 5).getValue(), '=1+1.csv', 'ファイル名が文字列でない');
    assert.equal(sheet.getRange(2, 5).getFormula(), '', 'ファイル名が式になっている');
    assert.equal(typeof sheet.getRange(2, 11).getValue(), 'number');

    const audits = auditOf('FREEE_CARD_CSV');
    assert.equal(audits.length, auditBefore + 1, '監査が 1 件でない');
    const audit = audits[audits.length - 1];
    assert.equal(audit[3], OWNER);
    assert.equal(String(audit[11]), 'WEBAPP');
    const after = String(audit[10]);
    ACCOUNTS.concat(CANDIDATES).forEach((name) => {
      assert.ok(after.indexOf(name) < 0, '監査に勘定科目名が入っている');
    });
    assert.ok(after.indexOf('"invalidMappingCount":0') >= 0);

    const log = gas.stubs.getWriteLog();
    const auditIndex = writeIndex(log, '監査ログ');
    const tableIndex = writeIndex(log, TABLE);
    assert.ok(auditIndex >= 0, '監査を書いていない');
    assert.ok(tableIndex > auditIndex, '監査より先にタブ・表を書いている（S4）');
    const updates = log.filter((entry) => entry.kind === 'values.update' && entry.sheetName === TABLE);
    assert.ok(updates.length >= 2, '表への Values.update が足りない');
    updates.forEach((entry) => assert.equal(entry.valueInputOption, 'RAW'));
  });

  // ================= fcn 7 =================
  test('fcn 7: 差し替えても対応は残し、候補から外れたものを invalidMappings で知らせる', () => {
    buildWorld();
    seedTable([tableRow({
      mappings: {'テストカード': 'テストカード', '架空カードA': '架空カードA'},
      fileName: 'old.csv',
      sha256: 'b'.repeat(64),
      uploadedAt: '2026-02-01T00:00:00+09:00',
      uploadedBy: 'old@example.com',
      mappingUpdatedAt: '2026-02-02T00:00:00+09:00',
      mappingUpdatedBy: 'map@example.com',
      version: 1
    })]);
    const rows = [
      CSV_HEADERS_12.slice(),
      accountRow('テストカード', '未払金'),
      accountRow('visaカード', '未払金'),
      accountRow('架空経費', '経費')
    ];
    const bytes = getShiftJisEncoder()(csvText(rows));
    const newSha = crypto.createHash('sha256')
      .update(Buffer.from(bytes.map((byte) => (Number(byte) + 256) & 0xff))).digest('hex');
    const result = uploadBytes(bytes,
      {fileName: 'new.csv', expectedVersion: 1});
    assert.equal(result.ok, true);
    assert.equal(result.version, 2);
    assert.deepEqual(result.invalidMappings,
      [{folderName: '架空カードA', accountName: '架空カードA'}]);

    const row = tableRowObject(2);
    assert.deepEqual(row.mappings,
      {'テストカード': 'テストカード', '架空カードA': '架空カードA'}, '保存済みの対応が消えた');
    assert.equal(row.version, 2);
    assert.equal(row.fileName, 'new.csv');
    assert.equal(row.sha256, newSha, 'F（SHA-256）が新しい値になっていない');
    assert.notEqual(row.sha256, 'b'.repeat(64));
    assert.deepEqual(row.accountNames, ['テストカード', 'visaカード', '架空経費']);
    assert.deepEqual(row.candidates, ['テストカード', 'visaカード']);
    assert.notEqual(row.uploadedAt, '2026-02-01T00:00:00+09:00');
    assert.equal(row.uploadedBy, OWNER);
    assert.equal(row.mappingUpdatedAt, '2026-02-02T00:00:00+09:00', 'I が変わった');
    assert.equal(row.mappingUpdatedBy, 'map@example.com', 'J が変わった');

    // L2 差し替えの監査の before・after に勘定科目名を書かない。
    const audits = auditOf('FREEE_CARD_CSV');
    const audit = audits[audits.length - 1];
    const before = String(audit[9]);
    const after = String(audit[10]);
    ['テストカード', 'visaカード', '架空経費', '架空カードA'].forEach((name) => {
      assert.ok(before.indexOf(name) < 0, '監査の before に勘定科目名がある');
      assert.ok(after.indexOf(name) < 0, '監査の after に勘定科目名がある');
    });
    assert.ok(after.indexOf(newSha) >= 0, '監査の after に新しい SHA-256 が無い');
  });

  // ================= fcn 8 =================
  test('fcn 8: 古い版を送ると、登録も保存もしない（STALE）', () => {
    buildWorld();
    seedTable([tableRow({version: 2})]);
    const before = tableRowValues(2);
    const auditBefore = auditRows().length;
    gas.stubs.resetWriteLog();

    assert.equal(uploadBytes(getShiftJisEncoder()(csvText(defaultCsvRows())),
      {expectedVersion: 0}).code, 'STALE');
    assert.equal(save([{folderName: 'テストカード', accountName: 'テストカード'}], 1).code, 'STALE');
    assert.equal(save([{folderName: 'テストカード', accountName: 'テストカード'}], 0).code, 'STALE');

    assert.deepEqual(tableRowValues(2), before, '表が変わっている');
    assert.equal(gas.stubs.getWriteLog().length, 0, '何かを書いている');
    assert.equal(auditRows().length, auditBefore, '監査を書いている');
  });

  // ================= fcn 9 =================
  test('fcn 9: オーナーでなければ 3 つとも拒み、顧客のフォルダも表も読まない', () => {
    buildWorld();
    seedTable([tableRow()]);
    gas.stubs.setActiveUser('stranger@example.com');
    gas.stubs.resetApiCallCounts();
    gas.stubs.resetWriteLog();
    const realGetFolder = gas.context.DriveApp.getFolderById;
    let driveCalls = 0;
    gas.context.DriveApp.getFolderById = function(id) {
      driveCalls += 1;
      return realGetFolder.call(this, id);
    };
    const watched = withBatchGetRecorder(() => {
      const errors = [
        caught(() => start()),
        caught(() => uploadBase64('AAAA', {expectedVersion: 0})),
        caught(() => save([], 1))
      ];
      return errors;
    });
    gas.context.DriveApp.getFolderById = realGetFolder;

    assert.equal(watched.result.length, 3);
    watched.result.forEach((error) => {
      assert.ok(error, '拒まなかった');
      assert.equal(error.name, 'AuthorizationError');
    });
    assert.equal(driveCalls, 0, '顧客のフォルダを読んでいる');
    assert.ok(watched.ranges.every((range) => range.indexOf(TABLE) < 0), '表を読んでいる');
    assert.ok(gas.stubs.getWriteLog()
      .every((entry) => entry.sheetName !== TABLE), '表に書いている');
  });

  // ================= fcn 10 =================
  test('fcn 10: 有効でない顧客には 3 つとも CUSTOMER_INACTIVE で何も書かない', () => {
    buildWorld();
    seedTable([tableRow()]);
    customerMaster().getRange(2, 3).setValue(false);
    const before = tableRowValues(2);
    const auditBefore = auditRows().length;
    gas.stubs.resetApiCallCounts();
    gas.stubs.resetWriteLog();
    const realGetFolder = gas.context.DriveApp.getFolderById;
    let driveCalls = 0;
    gas.context.DriveApp.getFolderById = function(id) {
      driveCalls += 1;
      return realGetFolder.call(this, id);
    };
    const watched = withBatchGetRecorder(() => [
      start(),
      uploadBase64('AAAA', {expectedVersion: 0}),
      save([{folderName: 'テストカード', accountName: 'テストカード'}], 1)
    ]);
    gas.context.DriveApp.getFolderById = realGetFolder;

    watched.result.forEach((result) => {
      assert.equal(result.ok, false);
      assert.equal(result.code, 'CUSTOMER_INACTIVE');
    });
    assert.equal(driveCalls, 0, '顧客のフォルダを読んでいる');
    assert.ok(watched.ranges.every((range) => range.indexOf(TABLE) < 0), '表を読んでいる');
    assert.deepEqual(tableRowValues(2), before);
    assert.equal(auditRows().length, auditBefore, '監査を書いている');
  });

  // ================= fcn 11 =================
  test('fcn 11: 開くと、フォルダの順・保存済み・提案・orphans を返し、何も書かない', () => {
    buildWorld({extraFolders: [['fcn-card-visa', 'ＶＩＳＡカード'], ['fcn-card-over', '重なりカード']]});
    const names = ['架空カードA', 'テストカード', 'visaカード', '重なりカード', '重なり カード',
      '架空経費', '架空売上'];
    const candidates = ['架空カードA', 'テストカード', 'visaカード', '重なりカード', '重なり カード'];
    seedTable([tableRow({
      accountNames: names,
      candidates: candidates,
      mappings: {
        'テストカード': 'テストカード',
        '架空カードA': '架空経費',
        '昔のカード': 'テストカード',
        '昔のカード2': '架空経費',
        '架空カード B': 'テストカード'
      },
      version: 1
    })]);
    const auditBefore = auditRows().length;
    gas.stubs.resetWriteLog();
    const result = start();
    assert.equal(result.ok, true);
    assert.equal(result.customerId, CUSTOMER_ID);
    assert.equal(result.customerName, CUSTOMER_NAME);
    assert.equal(result.version, 1);
    assert.deepEqual(result.candidates, candidates);
    assert.deepEqual(result.csv, {
      fileName: '勘定科目.csv', uploadedAt: '2026-01-01T00:00:00+09:00',
      uploadedBy: 'old@example.com', accountCount: 7, candidateCount: 5
    });
    assert.deepEqual(result.folders.map((folder) => folder.folderName),
      ['テストカード', '架空カード B ', '架空カードA', '重なりカード', 'ＶＩＳＡカード']);
    const byName = {};
    result.folders.forEach((folder) => { byName[folder.folderName] = folder; });
    assert.equal(byName['テストカード'].savedAccountName, 'テストカード');
    assert.equal(byName['テストカード'].savedValid, true);
    assert.equal(byName['テストカード'].suggestion, null);
    assert.equal(byName['架空カード B '].savedAccountName, 'テストカード');
    assert.equal(byName['架空カード B '].savedValid, true);
    assert.equal(byName['架空カードA'].savedAccountName, '架空経費');
    assert.equal(byName['架空カードA'].savedValid, false);
    assert.equal(byName['架空カードA'].suggestion, null);
    assert.equal(byName['重なりカード'].savedAccountName, null);
    assert.equal(byName['重なりカード'].suggestion, null, '2 つ当たるのに提案している');
    assert.equal(byName['ＶＩＳＡカード'].savedAccountName, null);
    assert.equal(byName['ＶＩＳＡカード'].suggestion, 'visaカード');
    assert.deepEqual(result.orphans, [
      {folderName: '昔のカード', accountName: 'テストカード', valid: true},
      {folderName: '昔のカード2', accountName: '架空経費', valid: false}
    ]);
    assert.equal(gas.stubs.getWriteLog().length, 0, '開いただけで書いている');
    assert.equal(auditRows().length, auditBefore);

    // 行が無ければ csv: null・version: 0。
    buildWorld();
    const empty = start();
    assert.equal(empty.ok, true);
    assert.equal(empty.csv, null);
    assert.equal(empty.version, 0);
    assert.deepEqual(empty.candidates, []);
    empty.folders.forEach((folder) => {
      assert.equal(folder.savedAccountName, null);
      assert.equal(folder.savedValid, false);
      assert.equal(folder.suggestion, null);
    });
  });

  // ================= fcn 12 =================
  test('fcn 12: 対応を足す・変える・外すと、D・I・J・K と監査が変わる', () => {
    buildWorld({extraFolders: [['fcn-card-visa', 'ＶＩＳＡカード']]});
    seedTable([tableRow({
      mappings: {
        'テストカード': 'テストカード',
        '架空カードA': '架空カードA',
        '昔のカード': 'テストカード',
        '変えないカード': '架空カードA'
      },
      mappingUpdatedAt: '2026-03-01T00:00:00+09:00',
      mappingUpdatedBy: 'old@example.com',
      version: 1
    })]);
    const auditBefore = auditOf('FREEE_CARD_MAPPING').length;
    gas.stubs.resetWriteLog();
    const changes = [
      {folderName: 'テストカード', accountName: 'visaカード'},
      {folderName: '架空カードA', accountName: null},
      {folderName: '昔のカード', accountName: null},
      {folderName: 'ＶＩＳＡカード', accountName: 'visaカード'}
    ];
    const result = save(changes, 1);
    assert.equal(result.ok, true);
    assert.equal(result.version, 2);
    assert.equal(result.changed, 4);

    const row = tableRowObject(2);
    assert.deepEqual(row.mappings, {'テストカード': 'visaカード', '変えないカード': '架空カードA',
      'ＶＩＳＡカード': 'visaカード'}, '今回変えない鍵が消えた');
    assert.equal(row.version, 2);
    assert.notEqual(row.mappingUpdatedAt, '2026-03-01T00:00:00+09:00');
    assert.equal(row.mappingUpdatedBy, OWNER);
    assert.equal(row.fileName, '勘定科目.csv', 'CSV の列が変わった');

    const audits = auditOf('FREEE_CARD_MAPPING');
    assert.equal(audits.length, auditBefore + 1);
    const audit = audits[audits.length - 1];
    assert.equal(audit[3], OWNER);
    assert.equal(String(audit[11]), 'WEBAPP');
    const before = JSON.parse(String(audit[9]));
    const after = JSON.parse(String(audit[10]));
    assert.equal(before.version, 1);
    assert.equal(after.version, 2);
    assert.deepEqual(before.mappings, {
      'テストカード': 'テストカード',
      '架空カードA': '架空カードA',
      '昔のカード': 'テストカード',
      'ＶＩＳＡカード': null
    });
    assert.deepEqual(after.mappings, {
      'テストカード': 'visaカード',
      '架空カードA': null,
      '昔のカード': null,
      'ＶＩＳＡカード': 'visaカード'
    });
    // L1 保存済みで今回変えない鍵は、監査の before・after に書かない。
    assert.equal(Object.prototype.hasOwnProperty.call(before.mappings, '変えないカード'), false,
      '監査の before に変えない鍵がある');
    assert.equal(Object.prototype.hasOwnProperty.call(after.mappings, '変えないカード'), false,
      '監査の after に変えない鍵がある');

    const log = gas.stubs.getWriteLog();
    const auditIndex = writeIndex(log, '監査ログ');
    const tableIndex = writeIndex(log, TABLE);
    assert.ok(auditIndex >= 0 && tableIndex > auditIndex, '監査が先でない（S4）');
  });

  // ================= fcn 13 =================
  test('fcn 13: 対応の保存を拒む条件では、1 つでも外れたら何も書かない', () => {
    function expectMappingInvalid(world, changes, expectedReason) {
      seedTable([tableRow({
        mappings: {'テストカード': 'テストカード'},
        mappingUpdatedAt: '2026-04-01T00:00:00+09:00',
        mappingUpdatedBy: 'old@example.com',
        version: 1
      })]);
      const before = tableRowValues(2);
      const auditBefore = auditRows().length;
      gas.stubs.resetWriteLog();
      const result = save(changes, 1);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'MAPPING_INVALID');
      if (expectedReason) assert.equal(result.detail.reason, expectedReason);
      assert.deepEqual(tableRowValues(2), before, '表が変わっている');
      assert.equal(gas.stubs.getWriteLog().length, 0, '何かを書いている');
      assert.equal(auditRows().length, auditBefore, '監査を書いている');
    }

    buildWorld();
    expectMappingInvalid(null, [{folderName: 'テストカード', accountName: '無い科目'}],
      'NOT_CANDIDATE');
    buildWorld();
    expectMappingInvalid(null, [{folderName: '無いフォルダ', accountName: 'テストカード'}],
      'FOLDER_NOT_FOUND');
    buildWorld();
    expectMappingInvalid(null, [
      {folderName: 'テストカード', accountName: 'visaカード'},
      {folderName: 'テストカード', accountName: 'テストカード'}
    ], 'DUPLICATE_FOLDER');
    buildWorld();
    const tooMany = Array.from({length: 201}, (_, index) => ({
      folderName: 'f' + index, accountName: null
    }));
    expectMappingInvalid(null, tooMany, 'CHANGES_INVALID');
    buildWorld();
    expectMappingInvalid(null, [
      {folderName: 'テストカード', accountName: 'visaカード'},
      {folderName: '架空カードA', accountName: '無い科目'}
    ], 'NOT_CANDIDATE');

    // CSV が無い。
    buildWorld();
    const noCsv = save([{folderName: 'テストカード', accountName: 'テストカード'}], 1);
    assert.equal(noCsv.ok, false);
    assert.equal(noCsv.code, 'NO_CSV');
    assert.equal(tableSheet(), null);
    assert.equal(gas.stubs.getWriteLog().length, 0);
  });

  // ================= fcn 14 =================
  test('fcn 14: 変わらない保存は changed: 0 で、書かない・監査も書かない', () => {
    buildWorld();
    seedTable([tableRow({mappings: {'テストカード': 'テストカード'}, version: 1})]);
    const before = tableRowValues(2);
    const auditBefore = auditRows().length;
    gas.stubs.resetWriteLog();
    const result = save([{folderName: 'テストカード', accountName: 'テストカード'}], 1);
    assert.equal(result.ok, true);
    assert.equal(result.version, 1);
    assert.equal(result.changed, 0);
    assert.deepEqual(tableRowValues(2), before);
    assert.equal(gas.stubs.getWriteLog().length, 0, '何かを書いている');
    assert.equal(auditRows().length, auditBefore, '監査を書いている');
  });

  // ================= fcn 15 =================
  test('fcn 15: 監査が書けなければ、表に 1 セルも書かずタブも作らない', () => {
    buildWorld();
    const before = auditRows().length;
    gas.stubs.resetWriteLog();
    const error = withMocks({
      appendAuditRowsUnlocked_: function() { throw new Error('fcn-audit-failure'); }
    }, () => caught(() => uploadBytes(getShiftJisEncoder()(csvText(defaultCsvRows())),
      {expectedVersion: 0})));
    assert.ok(error, '例外になっていない');
    assert.equal(error.code, 'REQUIRED_LOG_WRITE_FAILED');
    assert.equal(tableSheet(), null, 'タブを作っている');
    assert.ok(gas.stubs.getWriteLog()
      .every((entry) => entry.sheetName !== TABLE), '表に書いている');
    assert.equal(auditRows().length, before, '監査を書いている');
  });

  // ================= fcn 16 =================
  test('fcn 16: 読み返しが違えば WRITE_VERIFY_FAILED と失敗の監査を返す', () => {
    buildWorld();
    const auditBefore = auditOf('FREEE_CARD_CSV').length;
    const real = gas.context.Sheets.Spreadsheets.Values.batchGet;
    gas.context.Sheets.Spreadsheets.Values.batchGet = function(spreadsheetId, request) {
      const response = real.call(this, spreadsheetId, request);
      const ranges = request && request.ranges || [];
      if (response && response.valueRanges && response.valueRanges[1] &&
          response.valueRanges[1].values && response.valueRanges[1].values[0] &&
          ranges.some((range) => String(range).indexOf('!A2:K2') >= 0)) {
        response.valueRanges[1].values[0][4] = 'WRONG';
      }
      return response;
    };
    let result;
    try {
      result = uploadBytes(getShiftJisEncoder()(csvText(defaultCsvRows())),
        {expectedVersion: 0});
    } finally {
      gas.context.Sheets.Spreadsheets.Values.batchGet = real;
    }
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WRITE_VERIFY_FAILED');
    assert.equal(result.rowNumber, 2);

    const audits = auditOf('FREEE_CARD_CSV');
    assert.equal(audits.length, auditBefore + 2, '監査が 2 件（本来と失敗）でない');
    const failed = audits.filter((row) => String(row[11]) === 'WEBAPP_FAILED');
    assert.equal(failed.length, 1);
    const after = JSON.parse(String(failed[0][10]));
    assert.equal(after.failed, 'WRITE_VERIFY_FAILED');
    assert.equal(after.row, 2);
  });

  // ================= fcn 17 =================
  test('fcn 17: 表が壊れていれば、開く・登録・保存とも TABLE_INVALID で書かない', () => {
    function expectInvalid(world) {
      const sheet = tableSheet();
      const before = sheet ? plain(sheet.getDataRange().getValues()) : null;
      const auditBefore = auditRows().length;
      gas.stubs.resetWriteLog();
      const opened = start();
      assert.equal(opened.ok, false);
      assert.equal(opened.code, 'TABLE_INVALID');
      const uploaded = uploadBytes(getShiftJisEncoder()(csvText(defaultCsvRows())),
        {expectedVersion: 0});
      assert.equal(uploaded.ok, false);
      assert.equal(uploaded.code, 'TABLE_INVALID');
      const saved = save([{folderName: 'テストカード', accountName: 'テストカード'}], 1);
      assert.equal(saved.ok, false);
      assert.equal(saved.code, 'TABLE_INVALID');
      if (sheet) assert.deepEqual(plain(sheet.getDataRange().getValues()), before, '表が変わった');
      assert.equal(gas.stubs.getWriteLog().length, 0, '何かを書いている');
      assert.equal(auditRows().length, auditBefore, '監査を書いている');
    }

    buildWorld();
    seedTable([tableRow({accountNames: 'not json'})]);
    expectInvalid();

    buildWorld();
    seedTable([tableRow({version: 1}), tableRow({version: 2})]);
    expectInvalid();

    buildWorld();
    const wrongHeaders = TABLE_HEADERS.slice();
    wrongHeaders[0] = '違う見出し';
    seedTable([tableRow()], {headers: wrongHeaders});
    expectInvalid();
  });

  // ================= 記帳・freee 取込用の組み立て（fcn 18〜26） =================

  /** 取込がファイルを見つけられるようにする、カード形式マスターの 1 行。 */
  function cardFormatRow() {
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
      17: 'generic', 18: 1, 19: OWNER,
      21: '2026-01-01T00:00:00+09:00', 29: 'NEW', 33: '2026-01-01T00:00:00+09:00'
    });
    return row;
  }

  function buildImportWorld(options = {}) {
    const built = buildWorld(options);
    master().getSheetByName('カード形式マスター').appendRow(cardFormatRow());
    gas.stubs.resetApiCallCounts();
    gas.stubs.resetRoundTrips();
    gas.stubs.resetWriteLog();
    return built;
  }

  function folderNamed(world, name) {
    return world.folderObjects.find((folder) => folder.name === name);
  }

  function addCardFile(world, folderName, fileId, options = {}) {
    const folder = folderNamed(world, folderName);
    assert.ok(folder, 'カードフォルダが無い: ' + folderName);
    gas.stubs.createFile(fileId, {
      name: options.name || ('三井住友カード202601_' + fileId + '.csv'),
      bytes: Buffer.from(options.content ||
        '利用日,利用店名,金額,使用用途\n2025/12/10,未登録店,1000,仕入れ\n', 'utf8'),
      contentType: 'text/csv',
      lastUpdated: new Date(Date.now() - 60 * 60 * 1000),
      createdTime: '2026-08-01T00:00:00Z'
    });
    folder.fileIds.push(fileId);
    return fileId;
  }

  function importFolder(folderName, options = {}) {
    const folder = [['テストカード', 'fcn-card-test'],
      ['架空カードA', 'fcn-card-a'], ['架空カード B ', 'fcn-card-b']]
      .find((pair) => pair[0] === folderName);
    return call('webAppRunImport', [CUSTOMER_ID, folder[1], options]);
  }

  function snapshotSheets(spreadsheetId) {
    const spreadsheet = gas.stubs.getSpreadsheet(spreadsheetId);
    const result = {};
    spreadsheet.getSheets().forEach((sheet) => {
      const range = sheet.getDataRange();
      result[sheet.getName()] = {
        values: plain(range.getValues()),
        formulas: plain(range.getFormulas())
      };
    });
    return result;
  }

  /** B1 だけを空にして、転記シートのほかのセル・タブを比べられるようにする。 */
  function cloneSnapshot(spreadsheetId) {
    const snapshot = snapshotSheets(spreadsheetId);
    if (snapshot[INPUT_SHEET] && snapshot[INPUT_SHEET].values[0]) {
      snapshot[INPUT_SHEET].values[0][1] = '';
    }
    return snapshot;
  }

  /**
   * 記帳の直後、次の世界（`buildImportWorld()`）を作る前に写し取る（M1）。
   * 世界を作り直すと複製の ID が同じに戻るので、後から読むと自分自身と比べてしまう。
   */
  function captureImport(result) {
    return {
      cloneId: result.destinationSpreadsheetId,
      snapshot: cloneSnapshot(result.destinationSpreadsheetId),
      done: result.done,
      total: result.total,
      stoppedBy: result.stoppedBy
    };
  }

  function destinationB1(spreadsheetId) {
    return gas.stubs.getSpreadsheet(spreadsheetId).getSheetByName(INPUT_SHEET).getRange(1, 2);
  }

  function withBatchGetLog(fn) {
    const real = gas.context.Sheets.Spreadsheets.Values.batchGet;
    const calls = [];
    gas.context.Sheets.Spreadsheets.Values.batchGet = function(spreadsheetId, request) {
      calls.push({spreadsheetId: String(spreadsheetId),
        ranges: ((request && request.ranges) || []).map(String)});
      return real.call(this, spreadsheetId, request);
    };
    try {
      return {result: fn(), calls: calls};
    } finally {
      gas.context.Sheets.Spreadsheets.Values.batchGet = real;
    }
  }

  function tableReadsIn(calls) {
    return calls.filter((call) => call.spreadsheetId === MASTER &&
      call.ranges.some((range) => range.indexOf(TABLE) >= 0)).length;
  }

  // ================= fcn 18 =================
  test('fcn 18: 記帳の 1 本の道で、複製の B1 だけにカード名を RAW で書く', () => {
    const mapped = buildImportWorld();
    seedTable([tableRow({mappings: {'テストカード': '架空カードA'}})]);
    addCardFile(mapped, 'テストカード', 'fcn-import-file-1');
    gas.stubs.resetWriteLog();
    const written = importFolder('テストカード');
    assert.equal(written.schemaValidation.ok, true);
    const cloneId = written.destinationSpreadsheetId;
    assert.notEqual(cloneId, TEMPLATE_ID);
    assert.deepEqual(written.cardName,
      {status: 'WRITTEN', folderName: 'テストカード', accountName: '架空カードA'});
    assert.equal(destinationB1(cloneId).getValue(), '架空カードA');
    assert.equal(destinationB1(TEMPLATE_ID).getValue(), '○○カード', '雛形の B1 を変えている');
    const writtenImport = captureImport(written);

    const b1Writes = gas.stubs.getWriteLog().filter((entry) =>
      entry.kind === 'values.update' && entry.spreadsheetId === cloneId &&
      String(entry.a1).indexOf('!B1') >= 0);
    assert.equal(b1Writes.length, 1, 'B1 の書込が 1 回でない');
    assert.equal(b1Writes[0].valueInputOption, 'RAW');
    assert.equal(b1Writes[0].numRows, 1);
    assert.equal(b1Writes[0].numColumns, 1);

    // 対応の無い同じ記帳と比べる（B1 以外は同じ）。
    const unmapped = buildImportWorld();
    addCardFile(unmapped, 'テストカード', 'fcn-import-file-1');
    const untouched = importFolder('テストカード');
    assert.equal(untouched.schemaValidation.ok, true);
    assert.equal(untouched.cardName.status, 'NO_CSV');
    const untouchedImport = captureImport(untouched);
    assert.deepEqual(writtenImport.snapshot, untouchedImport.snapshot,
      'B1 以外のセル・タブが対応の無い記帳と違う');
    assert.equal(writtenImport.done, untouchedImport.done, '書いた取引の数が違う');
    assert.equal(writtenImport.total, untouchedImport.total);
    assert.equal(writtenImport.stoppedBy, untouchedImport.stoppedBy);

    // `=1+1` も文字列のまま（式にしない）。
    const formulaWorld = buildImportWorld();
    seedTable([tableRow({
      accountNames: ['=1+1', '架空経費'],
      candidates: ['=1+1'],
      mappings: {'テストカード': '=1+1'}
    })]);
    addCardFile(formulaWorld, 'テストカード', 'fcn-import-file-2');
    const formulaResult = importFolder('テストカード');
    assert.equal(formulaResult.cardName.status, 'WRITTEN');
    const cell = destinationB1(formulaResult.destinationSpreadsheetId);
    assert.equal(cell.getValue(), '=1+1', '文字列になっていない');
    assert.equal(cell.getFormula(), '', '式になっている');
  });

  // ================= fcn 19 =================
  test('fcn 19: 表が無い・対応が無い・候補に無いときも、記帳は止めず B1 を書かない', () => {
    const baselineWorld = buildImportWorld();
    seedTable([tableRow({mappings: {'テストカード': '架空カードA'}})]);
    addCardFile(baselineWorld, 'テストカード', 'fcn-import-file-3');
    const baseline = importFolder('テストカード');
    const baselineImport = captureImport(baseline);

    const noCsvWorld = buildImportWorld();
    addCardFile(noCsvWorld, 'テストカード', 'fcn-import-file-3');
    const noCsv = importFolder('テストカード');
    assert.equal(noCsv.schemaValidation.ok, true);
    assert.equal(noCsv.cardName.status, 'NO_CSV');
    assert.equal(destinationB1(noCsv.destinationSpreadsheetId).getValue(), '○○カード');
    const noCsvImport = captureImport(noCsv);
    assert.equal(noCsvImport.done, baselineImport.done, '記帳が止まっている');
    assert.equal(noCsvImport.total, baselineImport.total);
    assert.equal(noCsvImport.stoppedBy, baselineImport.stoppedBy);
    assert.deepEqual(noCsvImport.snapshot, baselineImport.snapshot);

    const notSetWorld = buildImportWorld();
    seedTable([tableRow({mappings: {}})]);
    addCardFile(notSetWorld, 'テストカード', 'fcn-import-file-3');
    const notSet = importFolder('テストカード');
    assert.equal(notSet.cardName.status, 'NOT_SET');
    assert.equal(destinationB1(notSet.destinationSpreadsheetId).getValue(), '○○カード');
    const notSetImport = captureImport(notSet);
    assert.equal(notSetImport.done, baselineImport.done, '記帳が止まっている');
    assert.equal(notSetImport.total, baselineImport.total);
    assert.equal(notSetImport.stoppedBy, baselineImport.stoppedBy);
    assert.deepEqual(notSetImport.snapshot, baselineImport.snapshot);

    const notInCsvWorld = buildImportWorld();
    seedTable([tableRow({candidates: ['架空カードA'],
      mappings: {'テストカード': '架空経費'}})]);
    addCardFile(notInCsvWorld, 'テストカード', 'fcn-import-file-3');
    const notInCsv = importFolder('テストカード');
    assert.deepEqual(notInCsv.cardName,
      {status: 'NOT_IN_CSV', folderName: 'テストカード', accountName: '架空経費'});
    assert.equal(destinationB1(notInCsv.destinationSpreadsheetId).getValue(), '○○カード');
    const notInCsvImport = captureImport(notInCsv);
    assert.equal(notInCsvImport.done, baselineImport.done);
    assert.equal(notInCsvImport.total, baselineImport.total);
    assert.equal(notInCsvImport.stoppedBy, baselineImport.stoppedBy);
    assert.deepEqual(notInCsvImport.snapshot, baselineImport.snapshot);
  });

  // ================= fcn 20 =================
  test('fcn 20: 転記先を渡された呼出し・並列の道では、B1 を書かず cardName も付けない', () => {
    const world = buildImportWorld();
    seedTable([tableRow({mappings: {'テストカード': '架空カードA'}})]);
    addCardFile(world, 'テストカード', 'fcn-import-file-6');
    const first = importFolder('テストカード');
    assert.equal(first.cardName.status, 'WRITTEN');

    addCardFile(world, 'テストカード', 'fcn-import-file-7');
    destinationB1(first.destinationSpreadsheetId).setValue('そのまま');
    gas.stubs.resetWriteLog();
    const second = importFolder('テストカード',
      {destinationSpreadsheetId: first.destinationSpreadsheetId});
    assert.equal(second.destinationSpreadsheetId, first.destinationSpreadsheetId);
    assert.equal(Object.prototype.hasOwnProperty.call(second, 'cardName'), false);
    assert.equal(destinationB1(first.destinationSpreadsheetId).getValue(), 'そのまま',
      '転記先を渡された呼出しで B1 を書いている');
    assert.equal(gas.stubs.getWriteLog().filter((entry) =>
      entry.kind === 'values.update' && String(entry.a1).indexOf('!B1') >= 0).length, 0);

    // 並列の道（isLane）。
    const laneFile = addCardFile(world, 'テストカード', 'fcn-import-file-8');
    const priorLanes = gas.evaluate('WEBAPP_IMPORT_LANES_');
    gas.evaluate('WEBAPP_IMPORT_LANES_=2;');
    let lane;
    try {
      lane = call('webAppRunImport', [CUSTOMER_ID, 'fcn-card-test', {
        lane: 0,
        destinationSpreadsheetId: first.destinationSpreadsheetId,
        fileIds: [laneFile]
      }]);
    } finally {
      gas.evaluate('WEBAPP_IMPORT_LANES_=' + priorLanes + ';');
    }
    assert.equal(Object.prototype.hasOwnProperty.call(lane, 'cardName'), false);
    // 並列の道の呼出しが成功していることを先に確かめる（止まった呼出しで空振りしない）。
    assert.equal(lane.done, 1, '並列の道で 1 件を取り込めていない');
    assert.equal(lane.total, 1);
    assert.equal(lane.stoppedBy, null, '並列の道が止まっている');
    assert.equal(destinationB1(first.destinationSpreadsheetId).getValue(), 'そのまま');
  });

  // ================= fcn 21 =================
  test('fcn 21: 準備の道でも複製の B1 を書き、preparationResult に cardName を返す', () => {
    const world = buildImportWorld();
    seedTable([tableRow({mappings: {'テストカード': '架空カードA'}})]);
    addCardFile(world, 'テストカード', 'fcn-import-file-9');
    const priorLanes = gas.evaluate('WEBAPP_IMPORT_LANES_');
    gas.evaluate('WEBAPP_IMPORT_LANES_=2;');
    let prepared;
    try {
      prepared = call('webAppPrepareImport', [CUSTOMER_ID, 'fcn-card-test']);
    } finally {
      gas.evaluate('WEBAPP_IMPORT_LANES_=' + priorLanes + ';');
    }
    assert.equal(prepared.schemaValidation.ok, true);
    assert.deepEqual(prepared.cardName,
      {status: 'WRITTEN', folderName: 'テストカード', accountName: '架空カードA'});
    assert.equal(destinationB1(prepared.destinationSpreadsheetId).getValue(), '架空カードA');
  });

  // ================= fcn 22 =================
  test('fcn 22: B1 の書込の例外・読み返しの違いは FAILED で、記帳は止めずログに名前を出さない', () => {
    function runWithBrokenWrite(mode) {
      const world = buildImportWorld();
      seedTable([tableRow({mappings: {'テストカード': '架空カードA'}})]);
      addCardFile(world, 'テストカード', 'fcn-import-file-10');
      const realUpdate = gas.context.Sheets.Spreadsheets.Values.update;
      const realBatchGet = gas.context.Sheets.Spreadsheets.Values.batchGet;
      let thrown = false;
      if (mode === 'throw') {
        gas.context.Sheets.Spreadsheets.Values.update = function(body, spreadsheetId, a1, options) {
          if (!thrown && String(a1).indexOf('!B1') >= 0 && String(spreadsheetId) !== TEMPLATE_ID) {
            thrown = true;
            const error = new Error('fcn B1 write failure');
            error.code = 503;
            throw error;
          }
          return realUpdate.call(this, body, spreadsheetId, a1, options);
        };
      } else {
        gas.context.Sheets.Spreadsheets.Values.batchGet = function(spreadsheetId, request) {
          const response = realBatchGet.call(this, spreadsheetId, request);
          const ranges = (request && request.ranges) || [];
          if (String(spreadsheetId) !== TEMPLATE_ID && response &&
              response.valueRanges && response.valueRanges[0] &&
              ranges.some((range) => String(range).indexOf('!B1') >= 0)) {
            response.valueRanges[0].values = [['違う値']];
          }
          return response;
        };
      }
      try {
        return {result: importFolder('テストカード'), logs: gas.stubs.getLogLines().slice()};
      } finally {
        gas.context.Sheets.Spreadsheets.Values.update = realUpdate;
        gas.context.Sheets.Spreadsheets.Values.batchGet = realBatchGet;
      }
    }

    const failedWrite = runWithBrokenWrite('throw');
    assert.equal(failedWrite.result.schemaValidation.ok, true);
    assert.equal(failedWrite.result.cardName.status, 'FAILED');
    assert.equal(destinationB1(failedWrite.result.destinationSpreadsheetId).getValue(), '○○カード');
    assert.equal(failedWrite.result.done, 1, '記帳が止まっている');
    assert.equal(failedWrite.result.total, 1);
    const writeLines = failedWrite.logs
      .filter((line) => line.indexOf('FREEE_CARD_NAME_WRITE_FAILED') === 0);
    assert.equal(writeLines.length, 1, '書込の例外のログが 1 件でない');

    const failedRead = runWithBrokenWrite('read');
    assert.equal(failedRead.result.cardName.status, 'FAILED');
    assert.equal(failedRead.result.done, 1);
    // 名前が無いことは、FREEE_CARD_NAME_WRITE_FAILED で始まる行だけでなく全部の行で見る（M1・L6）。
    const allLogs = failedWrite.logs.concat(failedRead.logs);
    assert.ok(allLogs.length > 0, 'ログが 1 行も無い');
    allLogs.forEach((line) => {
      assert.ok(line.indexOf('架空カードA') < 0, 'ログにカード名がある');
      assert.ok(line.indexOf('テストカード') < 0, 'ログにフォルダ名がある');
    });
  });

  // ================= fcn 23 =================
  test('fcn 23: headerRow が 2 より小さい顧客は TEMPLATE_UNSUPPORTED で書かない', () => {
    const world = buildImportWorld({headerRow: 1});
    seedTable([tableRow({mappings: {'テストカード': '架空カードA'}})]);
    addCardFile(world, 'テストカード', 'fcn-import-file-11');
    gas.stubs.resetWriteLog();
    const result = importFolder('テストカード');
    assert.equal(result.cardName.status, 'TEMPLATE_UNSUPPORTED');
    assert.equal(result.done, 1, '記帳が止まっている');
    assert.equal(gas.stubs.getWriteLog().filter((entry) =>
      entry.kind === 'values.update' && String(entry.a1).indexOf('!B1') >= 0).length, 0);
  });

  // ================= fcn 24 =================
  test('fcn 24: フォルダ名の前後の空白を外した鍵で対応を引く', () => {
    const world = buildImportWorld();
    seedTable([tableRow({mappings: {'架空カード B': '架空カードA'}})]);
    addCardFile(world, '架空カード B ', 'fcn-import-file-12');
    const result = importFolder('架空カード B ');
    assert.deepEqual(result.cardName,
      {status: 'WRITTEN', folderName: '架空カード B', accountName: '架空カードA'});
    assert.equal(destinationB1(result.destinationSpreadsheetId).getValue(), '架空カードA');
  });

  // ================= freee 取込用（fcn 25 の組み立て） =================
  const EXPORT_TEMPLATE = 'fcn-export-template';
  const EXPORT_DESTINATION = 'fcn-export-destination';
  const EXPORT_WORK = 'fcn-export-work';
  const EXPORT_INPUT_HEADER = (() => {
    const header = blank(12);
    header[1] = '利用日'; header[2] = '取引先'; header[3] = '摘要';
    header[4] = 'メモ'; header[5] = '支出金額'; header[6] = '相手税区分';
    header[7] = '勘定科目'; header[8] = '収入金額'; header[9] = '内部取引ID';
    header[10] = 'freee取引先名'; header[11] = '備考';
    return header;
  })();
  const EXPORT_IMPORT_HEADERS = [
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

  function exportSerial(iso) {
    const parts = String(iso).split('-').map(Number);
    return Math.round((Date.UTC(parts[0], parts[1] - 1, parts[2]) -
      Date.UTC(1899, 11, 30)) / 86400000);
  }

  function exportInputRow(spec) {
    const row = blank(12);
    row[1] = exportSerial('2026-11-01');
    row[2] = '架空取引先';
    row[3] = '架空の摘要';
    row[4] = 'メモ';
    row[5] = spec.expense === undefined ? '' : spec.expense;
    row[6] = '';
    row[7] = '架空経費';
    row[8] = '';
    row[9] = spec.txId === undefined ? '' : spec.txId;
    row[10] = '架空店';
    row[11] = '';
    return row;
  }

  function exportImportRow(spec) {
    const row = blank(32);
    row[0] = exportSerial('2026-11-01');
    row[1] = '1';
    row[3] = '架空経費';
    row[9] = '架空品目';
    row[14] = spec.amount;
    row[15] = '課対仕入10%';
    row[17] = 'テストカード';
    row[28] = spec.amount;
    row[29] = '対象外';
    row[31] = '架空の摘要';
    return row;
  }

  function buildExportWorld(options = {}) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet(MASTER, {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet(MASTER);
    call('setMasterSpreadsheetId', [MASTER]);
    call('provisionMasterSheets');
    gas.stubs.setSpreadsheetOwner(MASTER, OWNER);
    gas.stubs.setActiveUser(OWNER);
    gas.evaluate(
      "SETTINGS.TX_INDEX_SPREADSHEET_ID='fcn-txidx';" +
      "SETTINGS.SNAPSHOT_SPREADSHEET_ID='fcn-snap';" +
      "SETTINGS.EXECUTION_TIMEOUT_SECONDS=300;" +
      "SETTINGS.SAFETY_MARGIN_SECONDS=60;" +
      "SETTINGS.PARALLEL_WORK_FOLDER_ID='" + EXPORT_WORK + "';" +
      "SETTINGS.SAMPLE_CORPUS_FOLDER_ID='fcn-corpus';");
    gas.stubs.createSpreadsheet('fcn-txidx', {sheets: []});
    gas.stubs.createSpreadsheet('fcn-snap', {sheets: []});
    gas.stubs.createFolder('fcn-corpus', {fileIds: []});
    gas.stubs.createFolder(EXPORT_WORK, {fileIds: []});
    gas.stubs.createFolder('fcn-export-parent', {fileIds: [EXPORT_TEMPLATE, EXPORT_DESTINATION]});
    gas.stubs.createFolder('fcn-export-card', {fileIds: []});
    gas.stubs.createFolder(SOURCE, {subFolderIds: ['fcn-export-card']});

    const inputValues = Array.from({length: HEADER_ROW + 1}, () => blank(12));
    inputValues[0][1] = options.cardName === undefined ? 'テストカード' : options.cardName;
    inputValues[HEADER_ROW - 1] = EXPORT_INPUT_HEADER.slice();
    inputValues[HEADER_ROW] = exportInputRow({txId: 'TX-001', expense: 1000});
    const importValues = [EXPORT_IMPORT_HEADERS.slice(), exportImportRow({amount: 1000})];

    const templateValues = Array.from({length: HEADER_ROW}, () => blank(12));
    templateValues[HEADER_ROW - 1] = EXPORT_INPUT_HEADER.slice();
    gas.stubs.createSpreadsheet(EXPORT_TEMPLATE, {
      name: CUSTOMER_NAME + '_雛形',
      sheets: [{name: INPUT_SHEET, values: templateValues, maxRows: 20, maxColumns: 12}]
    });
    gas.stubs.createSpreadsheet(EXPORT_DESTINATION, {
      name: CUSTOMER_NAME + '_20261115-1000',
      sheets: [
        {name: INPUT_SHEET, values: inputValues, maxRows: 50, maxColumns: 12},
        {name: '取込用', values: importValues, maxRows: 50, maxColumns: 40}
      ]
    });
    call('registerTestCustomer', [{
      customerId: CUSTOMER_ID,
      customerName: CUSTOMER_NAME,
      active: true,
      sourceFolderId: SOURCE,
      destinationSpreadsheetId: EXPORT_TEMPLATE,
      destinationSheetName: INPUT_SHEET,
      columns: {B: 2, F: 3, I: 4, K: 11, M: 6, txId: 10, G: 7, L: 9},
      headerRow: HEADER_ROW,
      dataStartRow: HEADER_ROW + 1,
      rowScanLastColumn: 12,
      reviewers: OWNER,
      admins: OWNER
    }]);
    const txRow = gas.call('makeTransactionRow_', [{
      fullTxId: 'TX-001', customerId: CUSTOMER_ID, fileId: 'fcn-export-file',
      sourceRow: 1, originalAmount: 1000, originalMerchant: '架空店',
      planned: {m: 1000}
    }, 'RUN_TEST', '2026-11-15T00:00:00+09:00']);
    txRow[9] = 'COMMITTED';
    gas.stubs.getSpreadsheet(MASTER).getSheetByName('クレカ取引ログ').appendRow(txRow);
    gas.stubs.resetApiCallCounts();
    gas.stubs.resetRoundTrips();
    gas.stubs.resetWriteLog();
  }

  function createExport() {
    return call('webAppCreateFreeeExport',
      [CUSTOMER_ID, EXPORT_DESTINATION, ['fcn-export-file'], {}]);
  }

  function expectExportStop(result, code) {
    assert.equal(result.ok, false, '止まるはずが通っている');
    assert.equal(result.created, false);
    assert.equal(result.code, code);
    assert.equal(result.stops[0].code, code);
  }

  // ================= fcn 25 =================
  test('fcn 25: freee 取込用は、CSV に無い B1 だけを止め、○○カードなら表を読まない', () => {
    // CSV にあり（表あり）→ 新しい止めなし。
    buildExportWorld();
    seedTable([tableRow()]);
    assert.equal(createExport().ok, true, 'CSV にある名前で止まっている');

    // CSV に無い（後ろに空白 1 つでも）→ CARD_NAME_NOT_IN_FREEE・何も作らない。
    buildExportWorld({cardName: 'テストカード '});
    seedTable([tableRow()]);
    const missing = createExport();
    expectExportStop(missing, 'CARD_NAME_NOT_IN_FREEE');
    assert.equal(missing.stops[0].cardName, 'テストカード ');
    assert.equal(gas.stubs.getDriveCreateCount(), 0, '作ってしまっている');

    // B1 が ○○カード のまま → 今の止めだけ。表は読まない。
    buildExportWorld({cardName: '○○カード'});
    seedTable([tableRow()]);
    const watched = withBatchGetLog(() => createExport());
    expectExportStop(watched.result, 'CARD_NAME_PLACEHOLDER');
    assert.equal(tableReadsIn(watched.calls), 0, 'B1 が ○○カード なのに表を読んでいる');

    // CSV を登録していない顧客 → 今のまま。
    buildExportWorld();
    assert.equal(createExport().ok, true, 'CSV なしで止まっている');

    // 表が壊れている → 失敗で返り、何も作らない。
    buildExportWorld();
    const broken = seedTable([tableRow({accountNames: 'not json'})]);
    assert.ok(broken);
    const error = caught(() => createExport());
    assert.ok(error, '例外になっていない');
    assert.equal(error.code, 'FREEE_CARD_TABLE_INVALID');
    assert.equal(gas.stubs.getDriveCreateCount(), 0, '壊れた表で作っている');
  });

  // ================= fcn 26 =================
  test('fcn 26: 表の読取は開く・複製とも 1 回で、往復の見積りは 167', () => {
    assert.equal(gas.evaluate('WEBAPP_IMPORT_BASE_TRIPS_'), 167);

    buildImportWorld();
    seedTable([tableRow()]);
    const opened = withBatchGetLog(() => start());
    assert.equal(opened.result.ok, true);
    assert.equal(tableReadsIn(opened.calls), 1, '開くで表を 1 回読んでいない');

    const world = buildImportWorld();
    seedTable([tableRow({mappings: {'テストカード': '架空カードA'}})]);
    addCardFile(world, 'テストカード', 'fcn-import-file-13');
    const imported = withBatchGetLog(() => importFolder('テストカード'));
    const result = imported.result;
    assert.equal(result.cardName.status, 'WRITTEN');
    assert.equal(tableReadsIn(imported.calls), 1, '複製で表を 1 回読んでいない');
    const b1Reads = imported.calls.filter((item) =>
      item.spreadsheetId === result.destinationSpreadsheetId &&
      item.ranges.some((range) => /!B1$/.test(range))).length;
    assert.equal(b1Reads, 1, 'B1 の読み返しが 1 回でない');
  });

  // ================= fcn 27 =================
  test('fcn 27: ほかの顧客の行があっても、新しい行は末尾に足し、ほかの行は変えない', () => {
    buildWorld();
    const other2 = tableRow({customerId: 'K9002'});
    const other4 = tableRow({customerId: 'K9003'});
    seedTable([other2, blank(11), other4]);
    registerOtherCustomer('K9002');
    const before = plain(tableSheet().getRange(2, 1, 3, 11).getValues());

    const uploaded = uploadBytes(getShiftJisEncoder()(csvText(defaultCsvRows())),
      {expectedVersion: 0});
    assert.equal(uploaded.ok, true);
    assert.equal(uploaded.version, 1);
    assert.equal(tableRowValues(5)[0], CUSTOMER_ID, 'K9001 が 5 行目に入っていない');
    assert.deepEqual(plain(tableSheet().getRange(2, 1, 3, 11).getValues()), before,
      'ほかの顧客の行・空の行が変わった');

    const row2 = tableRowValues(2);
    const row3 = plain(tableSheet().getRange(3, 1, 1, 11).getValues()[0]);
    const row4 = tableRowValues(4);
    const row5 = tableRowValues(5);
    const saved = call('webAppFreeeCardNamesSave', ['K9002',
      [{folderName: 'テストカード', accountName: 'テストカード'}], 1]);
    assert.equal(saved.ok, true);
    assert.equal(saved.version, 2);
    assert.deepEqual(tableRowValues(2).slice(0, 3), row2.slice(0, 3));
    assert.equal(tableRowObject(2).mappings['テストカード'], 'テストカード');
    assert.deepEqual(plain(tableSheet().getRange(3, 1, 1, 11).getValues()[0]), row3);
    assert.deepEqual(tableRowValues(4), row4);
    assert.deepEqual(tableRowValues(5), row5);
    assert.equal(tableRowValues(5)[0], 'K9001');
  });

  // ================= fcn 28 =================
  test('fcn 28: 見出しの書込が 1 回失敗しても、もう一度で表は見出しと 1 行になる', () => {
    buildWorld();
    let failed = false;
    const realUpdate = gas.context.Sheets.Spreadsheets.Values.update;
    gas.context.Sheets.Spreadsheets.Values.update = function(body, spreadsheetId, a1, options) {
      if (!failed && String(spreadsheetId) === MASTER &&
          String(a1).indexOf('!A1:K1') >= 0) {
        failed = true;
        const error = new Error('Sheets failure 503');
        error.code = 503;
        throw error;
      }
      return realUpdate.call(this, body, spreadsheetId, a1, options);
    };
    let first;
    try {
      first = uploadBytes(getShiftJisEncoder()(csvText(defaultCsvRows())),
        {expectedVersion: 0});
    } finally {
      gas.context.Sheets.Spreadsheets.Values.update = realUpdate;
    }
    assert.equal(first.ok, false);
    assert.equal(first.code, 'WRITE_VERIFY_FAILED');
    assert.ok(tableSheet(), 'タブが残っていない');

    const second = uploadBytes(getShiftJisEncoder()(csvText(defaultCsvRows())),
      {expectedVersion: 0});
    assert.equal(second.ok, true);
    const values = plain(tableSheet().getDataRange().getValues());
    assert.equal(values.length, 2, '見出しと 1 行になっていない');
    assert.deepEqual(values[0].slice(0, 11), TABLE_HEADERS);
    assert.equal(values[1][0], CUSTOMER_ID);

    const opened = start();
    assert.equal(opened.ok, true, '見出しの無いタブが TABLE_INVALID になっている');
    assert.equal(opened.version, 1);
  });

  // ================= fcn 29 =================
  test('fcn 29: 読み返しの A 列に同じ顧客が 2 行あれば WRITE_VERIFY_FAILED', () => {
    buildWorld();
    const real = gas.context.Sheets.Spreadsheets.Values.batchGet;
    gas.context.Sheets.Spreadsheets.Values.batchGet = function(spreadsheetId, request) {
      const response = real.call(this, spreadsheetId, request);
      const ranges = (request && request.ranges) || [];
      if (String(spreadsheetId) === MASTER &&
          ranges.some((range) => String(range).indexOf('!A:A') >= 0) &&
          response && response.valueRanges && response.valueRanges[0] &&
          response.valueRanges[0].values) {
        response.valueRanges[0].values.push([CUSTOMER_ID]);
      }
      return response;
    };
    let result;
    try {
      result = uploadBytes(getShiftJisEncoder()(csvText(defaultCsvRows())),
        {expectedVersion: 0});
    } finally {
      gas.context.Sheets.Spreadsheets.Values.batchGet = real;
    }
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WRITE_VERIFY_FAILED');
    const failed = auditOf('FREEE_CARD_CSV').filter((row) => String(row[11]) === 'WEBAPP_FAILED');
    assert.equal(failed.length, 1);
  });

  // ================= fcn 30 =================
  test('fcn 30: 行の条件（C・D・K・B）を 1 つでも外せば TABLE_INVALID', () => {
    const cases = [
      {label: 'C に B に無い名前', row: {candidates: ['無い候補']}},
      {label: 'D が配列', row: {mappings: '[]'}},
      {label: 'K が 0', row: {version: 0}},
      {label: 'K が 1.5', row: {version: 1.5}},
      {label: 'B に重なり', row: {accountNames: ['架空カードA', '架空カードA']}},
      {label: 'B に改行', row: {accountNames: ['架空\nカード']}}
    ];
    cases.forEach((item) => {
      buildWorld();
      seedTable([tableRow(item.row)]);
      const opened = start();
      assert.equal(opened.ok, false, item.label + ' を通している');
      assert.equal(opened.code, 'TABLE_INVALID', item.label + ' のコードが違う');
    });
  });

  // ================= fcn 31 =================
  test('fcn 31: 複製のフォルダ名が読めなくても記帳を止めず、表を読まず FAILED', () => {
    function runWithFolderNameFailure(mode) {
      const world = buildImportWorld();
      seedTable([tableRow({mappings: {'テストカード': '架空カードA'}})]);
      addCardFile(world, 'テストカード', 'fcn-import-file-13');
      const realGetFolderById = gas.context.DriveApp.getFolderById;
      let thrown = false;
      let logs = [];
      gas.context.DriveApp.getFolderById = function(id) {
        const handle = realGetFolderById.call(this, id);
        if (String(id) !== SOURCE) return handle;
        const originalGetFolders = handle.getFolders;
        handle.getFolders = function() {
          const iterator = originalGetFolders.call(handle);
          return {
            hasNext() { return iterator.hasNext(); },
            next() {
              const folder = iterator.next();
              if (String(folder.getId()) !== 'fcn-card-test' || thrown) return folder;
              thrown = true;
              const copy = Object.assign({}, folder);
              copy.getName = function() {
                const error = new Error('fcn folder name failure');
                error.code = 503;
                throw error;
              };
              return copy;
            }
          };
        };
        return handle;
      };
      try {
        const logged = withBatchGetLog(function() {
          if (mode === 'prepare') {
            const priorLanes = gas.evaluate('WEBAPP_IMPORT_LANES_');
            gas.evaluate('WEBAPP_IMPORT_LANES_=2;');
            try {
              return call('webAppPrepareImport', [CUSTOMER_ID, 'fcn-card-test']);
            } finally {
              gas.evaluate('WEBAPP_IMPORT_LANES_=' + priorLanes + ';');
            }
          }
          return importFolder('テストカード');
        });
        logs = gas.stubs.getLogLines().slice();
        return {result: logged.result, calls: logged.calls, logs: logs};
      } finally {
        gas.context.DriveApp.getFolderById = realGetFolderById;
      }
    }

    // 例外の無い同じ記帳。
    const baselineWorld = buildImportWorld();
    seedTable([tableRow({mappings: {'テストカード': '架空カードA'}})]);
    addCardFile(baselineWorld, 'テストカード', 'fcn-import-file-13');
    const baseline = importFolder('テストカード');
    assert.equal(baseline.cardName.status, 'WRITTEN');
    const baselineImport = captureImport(baseline);

    const failed = runWithFolderNameFailure('run');
    assert.equal(failed.result.schemaValidation.ok, true);
    assert.equal(failed.result.done, baselineImport.done, '記帳が止まっている');
    assert.equal(failed.result.total, baselineImport.total);
    assert.equal(failed.result.stoppedBy, baselineImport.stoppedBy);
    assert.deepEqual(failed.result.cardName, {status: 'FAILED', folderName: ''});
    const cloneId = failed.result.destinationSpreadsheetId;
    assert.equal(destinationB1(cloneId).getValue(), '○○カード');
    const failedImport = captureImport(failed.result);
    assert.deepEqual(failedImport.snapshot, baselineImport.snapshot,
      'B1 以外が同じ記帳と違う');
    assert.equal(tableReadsIn(failed.calls), 0, 'フォルダ名が読めないのに表を読んでいる');
    assert.ok(failed.logs.some((line) => line.indexOf('FOLDER_NAME_UNREADABLE') >= 0),
      'FOLDER_NAME_UNREADABLE のログが無い');
    failed.logs.forEach((line) => {
      assert.ok(line.indexOf('テストカード') < 0, 'ログにフォルダ名がある');
      assert.ok(line.indexOf('架空カードA') < 0, 'ログにカード名がある');
    });

    // 準備の道でも同じ（記帳は止まらない・B1 は ○○カード・表を読まない）。
    // 比べる相手は、フォルダ名が読める同じ準備の道の複製（準備は取引を書かない）。
    const prepareBaselineWorld = buildImportWorld();
    seedTable([tableRow({mappings: {'テストカード': '架空カードA'}})]);
    addCardFile(prepareBaselineWorld, 'テストカード', 'fcn-import-file-13');
    const priorPrepareLanes = gas.evaluate('WEBAPP_IMPORT_LANES_');
    let prepareBaseline;
    gas.evaluate('WEBAPP_IMPORT_LANES_=2;');
    try {
      prepareBaseline = call('webAppPrepareImport', [CUSTOMER_ID, 'fcn-card-test']);
    } finally {
      gas.evaluate('WEBAPP_IMPORT_LANES_=' + priorPrepareLanes + ';');
    }
    const prepareBaselineImport = captureImport(prepareBaseline);

    const prepared = runWithFolderNameFailure('prepare');
    assert.equal(prepared.result.schemaValidation.ok, true);
    assert.equal(prepared.result.total, 1);
    assert.deepEqual(prepared.result.cardName, {status: 'FAILED', folderName: ''});
    assert.equal(destinationB1(prepared.result.destinationSpreadsheetId).getValue(), '○○カード');
    const preparedImport = captureImport(prepared.result);
    assert.deepEqual(preparedImport.snapshot, prepareBaselineImport.snapshot,
      'B1 以外が同じ準備の道と違う');
    assert.equal(preparedImport.total, prepareBaselineImport.total);
    assert.equal(preparedImport.stoppedBy, prepareBaselineImport.stoppedBy);
    assert.equal(tableReadsIn(prepared.calls), 0, '準備の道で表を読んでいる');
    prepared.logs.forEach((line) => {
      assert.ok(line.indexOf('テストカード') < 0, 'ログにフォルダ名がある');
      assert.ok(line.indexOf('架空カードA') < 0, 'ログにカード名がある');
    });
  });
};

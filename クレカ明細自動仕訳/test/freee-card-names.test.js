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

    const templateValues = Array.from({length: HEADER_ROW}, () => blank(10));
    templateValues[0][1] = '○○カード';
    templateValues[HEADER_ROW - 1] = ['', '利用日', 'freee取引先名', '摘要', '金額',
      'メモ', '内部ID', '税区分', '勘定科目', '消費税'];
    gas.stubs.createSpreadsheet(TEMPLATE_ID, {
      name: CUSTOMER_NAME + '_雛形',
      sheets: [
        {name: INPUT_SHEET, values: templateValues, maxRows: 20, maxColumns: 10},
        {name: '取引先一覧', values: [['元店名', '取引先名'], ['既知店', '株式会社既知店']]}
      ]
    });
    call('registerTestCustomer', [{
      customerId: CUSTOMER_ID,
      customerName: CUSTOMER_NAME,
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

    const folderSpecs = [
      ['fcn-card-test', 'テストカード'],
      ['fcn-card-a', '架空カードA'],
      ['fcn-card-b', '架空カード B ']
    ].concat(options.extraFolders || []);
    gas.stubs.createFolder(SOURCE, {name: '架空明細', subFolderIds: []});
    folderSpecs.forEach(([id, name]) => {
      gas.stubs.createFolder(id, {name: name, parentId: SOURCE});
    });
    gas.stubs.resetApiCallCounts();
    gas.stubs.resetRoundTrips();
    gas.stubs.resetWriteLog();
    return {folders: folderSpecs};
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
    const result = uploadBytes(getShiftJisEncoder()(csvText(rows)),
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
    assert.deepEqual(row.accountNames, ['テストカード', 'visaカード', '架空経費']);
    assert.deepEqual(row.candidates, ['テストカード', 'visaカード']);
    assert.notEqual(row.uploadedAt, '2026-02-01T00:00:00+09:00');
    assert.equal(row.uploadedBy, OWNER);
    assert.equal(row.mappingUpdatedAt, '2026-02-02T00:00:00+09:00', 'I が変わった');
    assert.equal(row.mappingUpdatedBy, 'map@example.com', 'J が変わった');
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
        '昔のカード': 'テストカード'
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
    assert.deepEqual(row.mappings, {'テストカード': 'visaカード', 'ＶＩＳＡカード': 'visaカード'});
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
};

'use strict';

module.exports = ({test, assert, gas}) => {
  const SHEET = 'application/vnd.google-apps.spreadsheet';
  const SHORTCUT = 'application/vnd.google-apps.shortcut';
  const DOC = 'application/vnd.google-apps.document';
  const FOLDER = 'application/vnd.google-apps.folder';
  const call = (name, ...args) => gas.call(name, args);
  const plain = value => JSON.parse(JSON.stringify(value));
  const old = () => new Date(Date.now() - 3600000);
  function mock(target, overrides, fn) {
    const saved = {};
    Object.keys(overrides).forEach(key => { saved[key] = target[key]; target[key] = overrides[key]; });
    try { return fn(); } finally { Object.assign(target, saved); }
  }
  function grid() {
    return [['架空日付', '架空店名', '架空金額', '架空用途'],
      [new Date('2025-11-30T00:00:00Z'), 'FAKE_SHOP', 1700, 'FAKE_PURPOSE'],
      [new Date('2025-11-29T00:00:00Z'), 'FAKE_SHOP', -50, 'FAKE_REFUND']];
  }
  function formatRow() {
    const row = Array(34).fill('');
    Object.assign(row, {0: 'gs_format_fake', 1: '架空形式', 2: 'active', 3: 'TRUE', 4: '["xlsx"]',
      5: JSON.stringify({allOf: [{maxRow: 1, keywords: grid()[0], minMatch: 4}]}),
      6: 1, 7: 2, 8: 'A', 9: 'B', 10: 'C', 11: 'D',
      14: JSON.stringify({excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []}),
      16: JSON.stringify({sources: [{id: 'fake-billing', kind: 'fileName', pattern: '(20\\d{2})(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}]}),
      17: 'generic', 18: 1, 19: 'gs-operator@example.invalid', 21: '2026-01-01T00:00:00+09:00',
      29: 'NEW', 33: '2026-01-01T00:00:00+09:00'});
    return row;
  }
  function world() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('gs-master-fake');
    gas.stubs.setActiveSpreadsheet('gs-master-fake');
    gas.stubs.setActiveUser('gs-operator@example.invalid');
    gas.stubs.setSpreadsheetOwner('gs-master-fake', 'gs-operator@example.invalid');
    call('setMasterSpreadsheetId', 'gs-master-fake');
    call('provisionMasterSheets');
    call('resetApiReadWindow_');
    master().getSheetByName('カード形式マスター').appendRow(formatRow());
    const dictionary = Array(18).fill('');
    Object.assign(dictionary, {0: 'GS_DICT_FAKE', 1: 'FAKE_SHOP', 2: 'FAKE_SHOP', 3: 'FAKE_PARTNER',
      4: 'exact_original', 5: 1, 9: 'TRUE', 10: 'gs-operator@example.invalid',
      12: '2026-01-01T00:00:00+09:00', 13: 1, 14: 'TRUE', 15: 'FALSE'});
    master().getSheetByName('共通取引先辞書').appendRow(dictionary);
    gas.stubs.createSpreadsheet('gs-dest-fake', {sheets: [
      {name: '架空入力', values: [['', '利用日', '取引先', '用途', '元店名', '金額', '内部ID']], maxRows: 30, maxColumns: 7},
      {name: '取引先一覧', values: [['元表記', '取引先名'], ['FAKE_SHOP', 'FAKE_PARTNER']]}
    ]});
    gas.stubs.createSpreadsheet('gs-index-fake');
    gas.stubs.createSpreadsheet('gs-snapshot-fake');
    gas.stubs.createFolder('gs-dest-parent-fake', {fileIds: ['gs-dest-fake']});
    gas.evaluate("SETTINGS.EXECUTION_TIMEOUT_SECONDS=300; SETTINGS.SAFETY_MARGIN_SECONDS=60;" +
      "SETTINGS.TX_INDEX_SPREADSHEET_ID='gs-index-fake'; SETTINGS.SNAPSHOT_SPREADSHEET_ID='gs-snapshot-fake';" +
      "SETTINGS.SAMPLE_CORPUS_FOLDER_ID='gs-corpus-fake'; SETTINGS.PARALLEL_WORK_FOLDER_ID=''; SETTINGS.FAULT_INJECTION=null;");
    call('registerTestCustomer', {customerId: 'GS_FAKE', customerName: '架空顧客',
      sourceFolderId: 'gs-root-fake', destinationSpreadsheetId: 'gs-dest-fake', destinationSheetName: '架空入力',
      columns: {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7}, headerRow: 1, dataStartRow: 2, rowScanLastColumn: 7});
    gas.stubs.createFolder('gs-root-fake', {name: '架空ルート', subFolderIds: ['gs-card-fake']});
    return gas.stubs.createFolder('gs-card-fake', {name: '架空カード'});
  }
  const master = () => gas.stubs.getSpreadsheet('gs-master-fake');
  const destination = () => gas.stubs.getSpreadsheet('gs-dest-fake').getSheetByName('架空入力');
  const written = () => destination().getDataRange().getValues().slice(1).filter(row => row[6] !== '');
  function addFile(folder, kind, id = 'gs-source-fake', values = grid()) {
    const specs = [{name: 'FAKE_SHEET', values, maxRows: values.length, maxColumns: values[0].length}];
    if (kind === 'gsheet') gas.stubs.createSpreadsheet(id, {sheets: specs});
    const bytes = kind === 'csv' ? Buffer.from(values.map(row => row.map(cell => cell instanceof Date ?
      call('toTokyoDateString_', cell).replace(/-/g, '/') : cell).join(',')).join('\n'), 'utf8') : Buffer.from('FAKE_XLSX_BYTES');
    const file = gas.stubs.createFile(id, {name: 'FAKE_202512' + (kind === 'gsheet' ? '' : '.' + kind),
      contentType: kind === 'gsheet' ? SHEET : kind === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes, xlsxSheets: kind === 'xlsx' ? specs : null, lastUpdated: old(), createdTime: '2026-01-01T00:00:00Z'});
    if (folder) folder.fileIds.push(id);
    return file;
  }
  const sourceSheet = (id = 'gs-source-fake') => gas.stubs.getSpreadsheet(id).getSheets()[0];
  const run = () => plain(call('runImport', {}));
  function outcome(report, id = 'gs-source-fake') {
    assert.equal(report.stoppedBy, null, JSON.stringify(report));
    assert.equal(report.customers.length, 1);
    const result = report.customers[0].files.find(file => file.fileId === id);
    assert.ok(result, JSON.stringify(report));
    return result;
  }
  function withoutBlob(file, fn) {
    return mock(file, {getBlob() { assert.fail('Google Sheets must never export a blob'); }}, fn);
  }
  function changedRun(fn) {
    const guard = gas.context.guardFileUnchanged, verdicts = [];
    const result = mock(gas.context, {guardFileUnchanged(...args) {
      const verdict = guard(...args); verdicts.push(plain(verdict)); return verdict;
    }}, fn);
    assert.equal(verdicts.length, 1); assert.equal(verdicts[0].ok, false);
    assert.equal(verdicts[0].reason, 'FILE_CHANGED');
    assert.equal(result.nextState, 'REVIEW_WAIT');
    return result;
  }
  function unknown(kind) {
    const folder = world(), values = grid();
    values[0] = ['架空取引日', '架空利用先', '架空請求額', '架空目的'];
    const file = addFile(folder, kind, 'gs-unknown-fake', values);
    call('registerReview', {reviewType: 'FORMAT_UNKNOWN', customerId: 'GS_FAKE', customerName: '架空顧客',
      fileId: file.getId(), fileNameOriginal: file.getName()});
    const diagnosis = call('webAppExplainUnknownFile', 'GS_FAKE', folder.id, file.id);
    assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis));
    const p = diagnosis.proposal;
    assert.ok(p, JSON.stringify(diagnosis));
    const answers = {baseFormatId: p.baseFormatId, formatId: 'gs_derived_fake', formatName: '架空追加形式',
      sheetName: p.sheetName, headerRow: p.headerRow, dataStartRow: p.dataStartRow,
      columns: {date: 'A', merchant: 'B', amount: 'C', purpose: 'D', amountFallback: ''},
      acknowledgements: {customerSide: true, amountChoice: true}};
    const preview = () => call('webAppPreviewFormat', 'GS_FAKE', folder.id, file.id, answers);
    return {folder, file, diagnosis, answers, preview};
  }

  test('gs 1: MIME classification includes native Sheets and excludes shortcuts and other Google types', () => {
    const cases = [['fake.csv', 'text/csv', true], ['fake.xlsx', 'application/octet-stream', true],
      ['fake.XLSX', 'application/octet-stream', true], ['FAKE', SHEET, true], ['fake.xlsx', SHEET, true],
      ['fake.xlsx', SHORTCUT, false], ['FAKE', SHORTCUT, false], ['FAKE', DOC, false],
      ['fake.pdf', 'application/pdf', false], ['fake.csv', FOLDER, false], ['fake.csv', DOC, false]];
    for (const [name, mime, expected] of cases) assert.equal(call('isImportableDriveFile', name, mime), expected, mime + ':' + name);
  });

  test('gs 2: scan includes three containers with MIME, stable age and existing sort order', () => {
    const folder = world();
    const sheet = addFile(folder, 'gsheet', 'gs-scan-b-fake');
    const excel = addFile(folder, 'xlsx', 'gs-scan-a-fake');
    const csv = addFile(folder, 'csv', 'gs-scan-c-fake');
    sheet.setName('A'); excel.setName('B.XLSX'); csv.setName('C.csv');
    csv.createdTime = new Date('2025-12-31T00:00:00Z');
    for (const [id, name, contentType] of [['shortcut', 'A.xlsx', SHORTCUT], ['doc', 'A.csv', DOC], ['pdf', 'A.pdf', 'application/pdf']]) {
      gas.stubs.createFile('gs-' + id + '-fake', {name, contentType, lastUpdated: old()}); folder.fileIds.push('gs-' + id + '-fake');
    }
    const hot = addFile(folder, 'gsheet', 'gs-hot-fake'); hot.lastUpdated = new Date(Date.now() - 60000);
    let candidates = plain(call('scanUnprocessedFiles', 'GS_FAKE'));
    assert.deepEqual(candidates.map(f => [f.fileId, f.mimeType]), [[csv.id, 'text/csv'], [sheet.id, SHEET], [excel.id, excel.contentType]]);
    excel.setName('A.xlsx'); sheet.setName('A.xlsx');
    candidates = plain(call('scanUnprocessedFiles', 'GS_FAKE'));
    assert.deepEqual(candidates.map(f => f.fileId), [csv.id, excel.id, sheet.id]);
  });

  test('gs 3: read hashes before opening and returns the Excel values without conversion or bytes', () => {
    const folder = world(), file = addFile(folder, 'gsheet');
    const excel = addFile(null, 'xlsx', 'gs-excel-fake');
    const expected = call('readFile', excel.id, excel.name).sheets;
    const ids = gas.stubs.getSpreadsheetIds().slice().sort(), order = [];
    const api = gas.context.Sheets.Spreadsheets, get = api.get;
    const app = gas.context.SpreadsheetApp, open = app.openById;
    const drive = gas.context.DriveApp, getFile = drive.getFileById;
    let lookups = 0;
    const result = withoutBlob(file, () => mock(gas.context.Drive.Files, {copy() { assert.fail('no copy'); }}, () =>
      mock(gas.context, {convertXlsxToTemp() { assert.fail('no conversion'); }}, () =>
        mock(api, {get(id, request) { if (id === file.id) order.push('hash'); return get(id, request); }}, () =>
          mock(app, {openById(id) { if (id === file.id) order.push('open'); return open(id); }}, () =>
            mock(drive, {getFileById(id) { if (id === file.id) lookups++; return getFile(id); }}, () => call('readFile', file.id, file.name)))))));
    assert.deepEqual(order, ['hash', 'open']); assert.equal(lookups, 1);
    assert.deepEqual(plain(result.sheets), plain(expected));
    assert.equal(result.fileType, 'xlsx'); assert.equal(result.sourceKind, 'GOOGLE_SHEET');
    assert.equal(result.bytes, null); assert.equal(result.encoding, null); assert.equal(result.bomRemoved, false);
    assert.equal(result.binaryHash, withoutBlob(file, () => call('currentFileBinaryHash', file.id)));
    assert.deepEqual(gas.stubs.getSpreadsheetIds().slice().sort(), ids);
    gas.evaluate('SETTINGS.MAX_FILE_BYTES=0');
    assert.equal(withoutBlob(file, () => call('readFile', file.id, 'FAKE.xlsx')).sourceKind, 'GOOGLE_SHEET');
    assert.ok(Object.hasOwn(gas.evaluate('stepTimes_'), 'read:hash'));
    assert.ok(Object.hasOwn(gas.evaluate('stepTimes_'), 'read:sheets'));
  });

  for (const limit of ['sheets', 'rows']) test('gs 3: native Sheets enforce the ' + limit + ' limit', () => {
    const folder = world(), file = addFile(folder, 'gsheet');
    if (limit === 'sheets') {
      gas.stubs.getSpreadsheet(file.id).insertSheet('FAKE_EXTRA', {values: [['x']], maxRows: 1, maxColumns: 1});
      gas.evaluate('SETTINGS.MAX_SHEETS_PER_FILE=1');
    } else gas.evaluate('SETTINGS.MAX_ROWS_PER_FILE=3');
    assert.throws(() => call('readFile', file.id, file.name), e => e.code === 'INPUT_LIMIT_EXCEEDED');
  });

  test('gs 4: CSV and Excel keep fixed byte hashes and shortcuts never read blobs', () => {
    world();
    const cases = [['csv', Buffer.from([0xef, 0xbb, 0xbf, 65, 44, 66, 10]), '6fe67f6c6da52c184df48bb04a5476c55cc3d0b3d3d8f63335e8dc3edccaac63'],
      ['xlsx', Buffer.from('FAKE_XLSX_BYTES'), 'b12c490d342c372355e2ea69fd2da40a1d5ce557f263465a1b44e70c6ee99b40']];
    for (const [kind, bytes, expected] of cases) {
      const file = addFile(null, kind, 'gs-bytes-' + kind + '-fake'); file.bytes = bytes;
      const read = call('readFile', file.id, file.name);
      assert.equal(read.sourceKind, 'FILE'); assert.equal(read.binaryHash, expected);
      assert.equal(read.binaryHash, call('sha256Hex', read.bytes));
      assert.deepEqual(Buffer.from(read.bytes.map(b => (b + 256) & 255)), bytes);
      assert.equal(call('currentFileBinaryHash', file.id), expected);
    }
    const shortcut = gas.stubs.createFile('gs-shortcut-fake', {name: 'FAKE.xlsx', contentType: SHORTCUT});
    withoutBlob(shortcut, () => assert.throws(() => call('readFile', shortcut.id, shortcut.name), e => e.name === 'TypeError'));
  });

  const changes = {
    text: sheet => sheet.getRange(2, 2).setValue('FAKE_SHOP_B'),
    type: sheet => sheet.getRange(2, 3).setValue('1700'),
    'date time': sheet => sheet.getRange(2, 1).setValue(new Date('2025-11-30T01:00:00Z')),
    'number format': sheet => sheet.getRange(2, 3).setNumberFormat('yyyy/mm/dd'),
    boolean: sheet => sheet.getRange(2, 2).setValue(false),
    whitespace: sheet => sheet.getRange(4, 1).setValue(' '),
    'sheet name': sheet => sheet.setName('FAKE_RENAMED'),
    'middle empty row': sheet => sheet.insertRowsAfter(1, 1),
    'middle empty column': sheet => { sheet.values.forEach(row => row.splice(1, 0, '')); sheet.formulas.forEach(row => row.splice(1, 0, '')); sheet.maxColumns++; }
  };
  for (const [name, change] of Object.entries(changes)) test('gs 5: content hash changes for ' + name, () => {
    const folder = world(), file = addFile(folder, 'gsheet'), sheet = sourceSheet();
    const before = call('currentFileBinaryHash', file.id);
    assert.equal(call('currentFileBinaryHash', file.id), before);
    change(sheet);
    assert.notEqual(call('currentFileBinaryHash', file.id), before);
  });

  test('gs 5: sheet index order wins over name and API response order', () => {
    const folder = world(), file = addFile(folder, 'gsheet'), spreadsheet = gas.stubs.getSpreadsheet(file.id);
    spreadsheet.insertSheet('AAA_FAKE', {values: [['other']], maxRows: 1, maxColumns: 1});
    const before = call('currentFileBinaryHash', file.id);
    const api = gas.context.Sheets.Spreadsheets, get = api.get;
    mock(api, {get(id, request) { const r = get(id, request); if (id === file.id) r.sheets.reverse(); return r; }}, () =>
      assert.equal(call('currentFileBinaryHash', file.id), before));
    spreadsheet.sheets.reverse();
    assert.notEqual(call('currentFileBinaryHash', file.id), before);
  });

  test('gs 5: hash trims only trailing blanks and ignores file rename with a versioned typed encoding', () => {
    const folder = world(), file = addFile(folder, 'gsheet'), sheet = sourceSheet();
    const before = call('currentFileBinaryHash', file.id);
    sheet.insertRowsAfter(sheet.maxRows, 2); sheet._ensureSize(sheet.maxRows, sheet.maxColumns + 2);
    file.setName('【処理中】FAKE_202512');
    assert.equal(call('currentFileBinaryHash', file.id), before);
    // 材料を独立に組み立て、版の印・型・行とセルの境界を固定する。
    const values = ['GOOGLE_SHEET_CONTENT_V1', 1, 'FAKE_SHEET', 3, 4,
      'S', '架空日付', 'S', '架空店名', 'S', '架空金額', 'S', '架空用途',
      4, 'N', 45991.375, 'DATE', 'S', 'FAKE_SHOP', 'N', 1700, 'NUMBER', 'S', 'FAKE_PURPOSE',
      4, 'N', 45990.375, 'DATE', 'S', 'FAKE_SHOP', 'N', -50, 'NUMBER', 'S', 'FAKE_REFUND'];
    assert.equal(before, call('sha256Hex', call('utf8Bytes', call('serializeDeterministic', values))));
    assert.notEqual(before, call('sha256Hex', call('utf8Bytes', call('serializeDeterministic', values.slice(1)))));
  });

  test('gs 5: effective values include false, error type and interior empty cells without SpreadsheetApp', () => {
    world(); const file = addFile(null, 'gsheet');
    const api = gas.context.Sheets.Spreadsheets, cells = [{effectiveValue: {numberValue: 1}}, {},
      {effectiveValue: {boolValue: false}}, {effectiveValue: {errorValue: {type: 'REF', message: 'fake'}}}];
    mock(gas.context.SpreadsheetApp, {openById() { assert.fail('hash cannot use SpreadsheetApp'); }}, () =>
      mock(api, {get() { return {sheets: [{properties: {title: 'FAKE', index: 0}, data: [{rowData: [{values: cells}]}]}]}; }}, () => {
        const before = call('currentFileBinaryHash', file.id);
        cells[0].effectiveValue = {stringValue: '1'};
        assert.notEqual(call('currentFileBinaryHash', file.id), before);
        cells[0].effectiveValue = {numberValue: 1}; cells[2].effectiveValue.boolValue = true;
        assert.notEqual(call('currentFileBinaryHash', file.id), before);
        cells[2].effectiveValue.boolValue = false; cells[3].effectiveValue.errorValue.message = 'other fake message';
        assert.equal(call('currentFileBinaryHash', file.id), before);
        cells[3].effectiveValue.errorValue.type = 'DIVIDE_BY_ZERO';
        assert.notEqual(call('currentFileBinaryHash', file.id), before);
      }));
  });

  test('gs 6: native import writes Excel-equivalent rows and stores content hashes with two fresh reads', () => {
    let folder = world(); addFile(folder, 'xlsx');
    assert.equal(outcome(run()).outcome, 'WRITTEN');
    const expected = plain(written());
    folder = world(); const file = addFile(folder, 'gsheet'), originalName = file.name;
    const expectedHash = call('currentFileBinaryHash', file.id), ids = gas.stubs.getSpreadsheetIds().slice().sort();
    const api = gas.context.Sheets.Spreadsheets, get = api.get, app = gas.context.SpreadsheetApp, open = app.openById;
    let reads = 0, opens = 0;
    const result = withoutBlob(file, () => mock(api, {get(id, request) {
      if (id === file.id && request.includeGridData) reads++; return get(id, request);
    }}, () => mock(app, {openById(id) { if (id === file.id) opens++; return open(id); }}, () => outcome(run()))));
    assert.equal(result.outcome, 'WRITTEN'); assert.equal(result.written, 2); assert.equal(result.nextState, 'COMPLETED');
    assert.deepEqual(plain(written()), expected);
    assert.equal(opens, 1); assert.equal(reads, 2);
    const process = call('getProcessLogRecord_', file.id), index = call('getPermanentFileIndexRecord_', file.id);
    assert.equal(process.values[11], expectedHash); assert.equal(process.values[10], '');
    assert.equal(index.values[4], expectedHash); assert.equal(index.values[7], '');
    assert.equal(file.name, '【済】' + originalName);
    assert.deepEqual(gas.stubs.getSpreadsheetIds().slice().sort(), ids);
  });

  test('gs 7: guardian detects an edit after values even if SpreadsheetApp keeps a stale view', () => {
    const folder = world(), file = addFile(folder, 'gsheet');
    const read = gas.context.readFile, app = gas.context.SpreadsheetApp, open = app.openById;
    let opened = false;
    const result = changedRun(() => withoutBlob(file, () => mock(app, {openById(id) {
      if (id === file.id) { assert.equal(opened, false, 'guardian must not reopen SpreadsheetApp'); opened = true; }
      return open(id);
    }}, () => mock(gas.context, {readFile(...args) {
      const value = read(...args); if (args[0] === file.id) sourceSheet().getRange(2, 4).setValue('FAKE_CHANGED'); return value;
    }}, () => outcome(run())))));
    assert.equal(result.outcome, 'NO_WRITE');
    assert.equal(written().length, 0);
  });

  test('gs 8: edit between content hash and open fails closed before writing', () => {
    const folder = world(), file = addFile(folder, 'gsheet'), api = gas.context.Sheets.Spreadsheets, get = api.get;
    let reads = 0;
    const result = changedRun(() => withoutBlob(file, () => mock(api, {get(id, request) {
      const response = get(id, request);
      if (id === file.id && request.includeGridData && ++reads === 1) sourceSheet().getRange(2, 4).setValue('FAKE_CHANGED');
      return response;
    }}, () => outcome(run()))));
    assert.equal(result.outcome, 'NO_WRITE');
    assert.equal(written().length, 0); assert.equal(reads, 2);
  });

  test('gs 9: rescan uses content hashes and creates one review only when content changed', () => {
    for (const change of [false, true]) {
      const folder = world(), file = addFile(folder, 'gsheet');
      assert.equal(outcome(run()).outcome, 'WRITTEN');
      const oldHash = call('currentFileBinaryHash', file.id);
      if (change) sourceSheet().getRange(2, 4).setValue('FAKE_CHANGED');
      file.lastUpdated = new Date();
      const newHash = call('currentFileBinaryHash', file.id);
      withoutBlob(file, () => {
        const scan = call('scanProcessedFilesForChange', 'GS_FAKE');
        assert.equal(scan.probes.length, 1); assert.equal(scan.probes[0].hashComputed, true);
        assert.equal(scan.probes[0].changed, change);
        assert.equal(scan.probes[0].before.binaryHash, oldHash); assert.equal(scan.probes[0].after.binaryHash, newHash);
        const rescan = call('runProcessedFileRescan', {customerId: 'GS_FAKE',
          indexRows: call('permanentIndexRowsForScan_'),
          metaById: call('getFileMetadataBatch', [file.id], {folderIds: ['gs-root-fake']}),
          computeHash: id => call('currentFileBinaryHash', id)});
        assert.equal(rescan.changedCount, change ? 1 : 0);
      });
      const reviews = plain(call('openReviews', {})).filter(r => r.reviewType === 'FILE_CHANGED');
      assert.equal(reviews.length, change ? 1 : 0);
      if (change) {
        const detail = JSON.parse(reviews[0].detail);
        assert.equal(detail.oldBinaryHash, oldHash); assert.equal(detail.newBinaryHash, newHash);
      }
    }
  });

  test('gs 10: Excel and Sheets in either order hold the second for purpose revision without writes', () => {
    for (const order of [['xlsx', 'gsheet'], ['gsheet', 'xlsx']]) {
      const folder = world(); addFile(folder, order[0], 'gs-first-fake');
      assert.equal(outcome(run(), 'gs-first-fake').outcome, 'WRITTEN');
      const before = plain(written()), revised = grid(); revised[1][3] = 'FAKE_REVISED_PURPOSE';
      addFile(folder, order[1], 'gs-second-fake', revised);
      const result = outcome(run(), 'gs-second-fake');
      assert.equal(result.nextState, 'REVIEW_WAIT'); assert.equal(result.code, 'PURPOSE_REVISION_CANDIDATE');
      assert.equal(result.outcome, 'NO_WRITE'); assert.equal(result.written, 0);
      assert.deepEqual(plain(written()), before);
      const reviews = plain(call('openReviews', {})).filter(r => r.fileId === 'gs-second-fake');
      assert.equal(reviews.length, 1); assert.equal(reviews[0].reviewType, 'DUPLICATE');
    }
  });

  // Excel を変換して両方残すと、シート名まで同じで内容ハッシュが一致する。
  test('gs 10: identical Excel and Sheets in either order hold the second as a duplicate without writes', () => {
    for (const order of [['xlsx', 'gsheet'], ['gsheet', 'xlsx']]) {
      const folder = world(); addFile(folder, order[0], 'gs-first-fake');
      assert.equal(outcome(run(), 'gs-first-fake').outcome, 'WRITTEN');
      const before = plain(written());
      addFile(folder, order[1], 'gs-second-fake');
      const result = outcome(run(), 'gs-second-fake');
      assert.equal(result.nextState, 'REVIEW_WAIT'); assert.equal(result.code, 'DUPLICATE_CONTENT');
      assert.equal(result.outcome, 'NO_WRITE'); assert.equal(result.written, 0);
      assert.deepEqual(plain(written()), before);
      const reviews = plain(call('openReviews', {})).filter(r => r.fileId === 'gs-second-fake');
      assert.equal(reviews.length, 1); assert.equal(reviews[0].reviewType, 'DUPLICATE');
    }
  });

  test('gs 11: folder UI classifies native Sheets and excludes shortcut and document names', () => {
    const folder = world(), file = addFile(folder, 'gsheet'), now = Date.now();
    let item = call('webAppFolderFile_', file, {}, now);
    assert.equal(item.stateLabel, '取込可能'); assert.equal(item.importable, true);
    file.lastUpdated = new Date(now - 60000);
    item = call('webAppFolderFile_', file, {}, now);
    assert.equal(item.stateLabel, '取込待ち（あと 9 分）'); assert.equal(item.importable, false);
    for (const mime of [SHORTCUT, DOC]) {
      file.contentType = mime; file.setName('FAKE.xlsx');
      item = call('webAppFolderFile_', file, {}, now);
      assert.equal(item.stateLabel, '対象外'); assert.equal(item.importable, false);
    }
  });

  test('gs 11: webAppRunImport writes native Sheets from the selected folder', () => {
    const folder = world(); addFile(folder, 'gsheet');
    const result = plain(call('webAppRunImport', 'GS_FAKE', folder.id, {}));
    assert.equal(result.stoppedBy, null, JSON.stringify(result));
    assert.equal(result.fileResults[0].outcome, 'WRITTEN');
    const copied = gas.stubs.getSpreadsheet(result.destinationSpreadsheetId).getSheetByName('架空入力');
    assert.equal(copied.getDataRange().getValues().slice(1).filter(row => row[6] !== '').length, 2);
  });

  test('gs 12: native format diagnosis preview and save use a stable content hash and XLSX metadata', () => {
    const {folder, file, diagnosis, answers, preview} = unknown('gsheet');
    assert.equal(diagnosis.fileType, 'xlsx');
    const first = preview(), second = preview();
    assert.equal(first.ok, true); assert.deepEqual(plain(first.blocking), []);
    assert.equal(first.previewHash, second.previewHash);
    sourceSheet(file.id).getRange(2, 4).setValue('FAKE_CHANGED');
    const changed = preview(); assert.notEqual(changed.previewHash, first.previewHash);
    const saved = call('webAppSaveFormat', 'GS_FAKE', folder.id, file.id, answers, changed.previewHash);
    assert.equal(saved.saved, true, JSON.stringify(saved));
    const rows = master().getSheetByName('カード形式マスター').getDataRange().getValues();
    assert.equal(rows.find(row => row[0] === answers.formatId)[4], '["xlsx"]');
  });
  for (const [kind, expected] of [['csv', '8edc13445eb7979fb4d09b23ce66a0e83c08368ccf71079d1c312e47fde77bdd'],
    ['xlsx', '980aba6897f34aaabb93b67b7b4e2d70ee1d15189b820db45f18c7fff6009b19']])
    test('gs 12: ' + kind + ' preview hash equals the value from unchanged code', () => {
      const {preview} = unknown(kind), result = preview();
      assert.equal(result.ok, true); assert.deepEqual(plain(result.blocking), []);
      assert.equal(result.previewHash, expected);
    });

  test('gs 13: diagnostic Sheets use readFile with unchanged type detection count and no temporary copy', () => {
    const folder = world(), file = addFile(folder, 'gsheet');
    const usable = call('loadFormatDefinitions', {status: 'active', enabled: true});
    const read = gas.context.readFile, ids = gas.stubs.getSpreadsheetIds().slice().sort(); let reads = 0;
    const report = withoutBlob(file, () => mock(gas.context, {
      readFile(...args) { reads++; return read(...args); },
      convertXlsxToTemp() { assert.fail('diagnostic Sheets need no conversion'); }
    }, () => call('diagExamineFile_', file, usable)));
    assert.equal(reads, 1); assert.equal(report.fileType, 'gsheet');
    assert.equal(report.status, 'RESOLVED'); assert.equal(report.formatId, 'gs_format_fake'); assert.equal(report.txCount, 2);
    assert.deepEqual(gas.stubs.getSpreadsheetIds().slice().sort(), ids);
    assert.equal(gas.evaluate('typeof diagReadGoogleSheet_'), 'undefined');
  });

  test('gs 14: guardian API failure exhausts paced retries, fails without writes and releases the lease', () => {
    const folder = world(), file = addFile(folder, 'gsheet'), api = gas.context.Sheets.Spreadsheets, get = api.get;
    let reads = 0;
    const result = withoutBlob(file, () => mock(api, {get(id, request) {
      if (id === file.id && request.includeGridData && ++reads > 1) {
        const error = new Error('Fake content read unavailable'); error.code = 429; throw error;
      }
      return get(id, request);
    }}, () => outcome(run())));
    assert.equal(result.outcome, 'FAILED'); assert.equal(result.nextState, 'FAILED');
    assert.equal(written().length, 0); assert.equal(reads, 6);
    assert.equal(master().getSheetByName('処理リース').getLastRow(), 1);
  });

  test('gs 14: content API requests always pace and count every retry with the exact field mask', () => {
    const folder = world(), file = addFile(folder, 'gsheet'), api = gas.context.Sheets.Spreadsheets, get = api.get;
    gas.stubs.setSheetsGetFailures([503]);
    const count = gas.evaluate('apiReadCount_'); let paced = 0, requested = 0;
    const pace = gas.context.paceSheetsRead_;
    mock(gas.context, {paceSheetsRead_() { paced++; return pace(); }}, () =>
      mock(api, {get(id, request) {
        assert.equal(paced, ++requested); assert.equal(gas.evaluate('apiReadCount_'), count + requested);
        assert.equal(id, file.id); assert.equal(request.includeGridData, true);
        assert.equal(request.fields, 'sheets(properties(title,index),data(rowData(values(effectiveValue,effectiveFormat/numberFormat/type))))');
        return get(id, request);
      }}, () => assert.match(call('currentFileBinaryHash', file.id), /^[a-f0-9]{64}$/)));
    assert.equal(requested, 2); assert.equal(paced, 2); assert.equal(gas.evaluate('apiReadCount_'), count + 2);
  });
};

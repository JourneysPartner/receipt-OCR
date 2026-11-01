'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {isDeepStrictEqual} = require('node:util');

module.exports = ({test, assert, gas}) => {
  const plain = value => JSON.parse(JSON.stringify(value));
  const call = (name, ...args) => gas.call(name, args);
  function mock(overrides, fn, target = gas.context) {
    const saved = {};
    Object.keys(overrides).forEach(key => { saved[key] = target[key]; target[key] = overrides[key]; });
    try { return fn(); } finally { Object.assign(target, saved); }
  }
  function setup(csv = false) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('csvx-master-fake');
    gas.stubs.setActiveSpreadsheet('csvx-master-fake');
    call('setMasterSpreadsheetId', 'csvx-master-fake');
    call('provisionMasterSheets');
    call('installSmbcXlsxFormat');
    call('installAnnotatedFormatsBatch1');
    if (csv) call('installSmbcCsvFormat');
    return call('loadFormatDefinitions', {status: 'active', enabled: true}).filter(d => d.valid === true);
  }
  const definitions = () => call('loadFormatDefinitions', {status: 'active', enabled: true}).filter(d => d.valid === true);
  function detect(defs, sheets, fileType, fileName = '架空202512.' + fileType) {
    const detections = sheets.map(sheet => ({sheetName: sheet.name,
      candidates: call('detectFormatWith', defs, sheet, fileType, fileName)}));
    return plain(call('aggregateSheetDetections', detections,
      {origin: 'DISCOVERY', fileName, fileType, sourceId: 'csvx-file-fake'}));
  }
  function rows(width = 7) {
    const header = Array(width).fill('');
    header[0] = 'FAKE 様'; header[2] = 'FAKE_CARD'; header[width - 1] = '使用用途';
    const body = ['2025/11/30', 'FAKE_SHOP', 1462, 1, 1, 1462];
    while (body.length < width - 1) body.push('FAKE_NOTE');
    body.push('FAKE_PURPOSE');
    return [header, body, ['2025/11/29', 'FAKE_SHOP', -62, 1, 1, -62,
      ...Array(width - 7).fill(''), 'FAKE_REFUND']];
  }
  const csvRows = grid => grid.map(row => {
    const out = row.map(cell => cell instanceof Date
      ? call('toTokyoDateString_', cell).replace(/-/g, '/') : String(cell == null ? '' : cell));
    while (out.length && out.at(-1) === '') out.pop();
    return out;
  });
  const toCsv = grid => csvRows(grid).map(row => row.map(cell =>
    /[",\r\n]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell).join(',')).join('\n');
  const parsed = (sheet, format) => plain(call('parseFile', sheet, format,
    {customerId: 'CSVX_FAKE', fileId: 'csvx-file-fake', fileNameOriginal: '架空202512.csv'}));
  const master = () => gas.stubs.getSpreadsheet('csvx-master-fake');
  const snapshot = () => plain(master().getSheets().map(s => [s.getName(), s.getDataRange().getValues()]));

  test('csvx 1: file type is a readable container independent of E', () => {
    for (const fileTypes of [['xlsx'], ['csv'], ['csv', 'xlsx']]) {
      for (const type of ['csv', 'xlsx', 'CSV', 'XLSX']) assert.equal(call('matchesFileType', {fileTypes}, type), true);
      for (const type of ['pdf', '', null]) assert.equal(call('matchesFileType', {fileTypes}, type), false);
    }
  });

  test('csvx 2: definitions accept the other container and ragged string rows', () => {
    const defs = setup();
    const x7 = defs.find(d => d.formatId === 'smbc_family_x7');
    const grid = rows();
    grid[1][0] = new Date('2025-11-30T00:00:00Z');
    grid[0][6] = '';
    assert.equal(detect([x7], [{name: null, rows: csvRows(grid)}], 'csv').formatId, x7.formatId);
    const csvDef = {...x7, fileTypes: ['csv']};
    assert.equal(detect([csvDef], [{name: '架空シート', rows: grid}], 'xlsx').formatId, x7.formatId);
    assert.ok(csvRows(grid).every(row => row.every(cell => typeof cell === 'string')));
    assert.ok(new Set(csvRows(grid).map(row => row.length)).size > 1);
  });

  test('csvx 3: six digit text retains leading zero and rejects invalid fields', () => {
    assert.deepEqual(plain(call('interpretDateExpression', '251130')), plain(call('interpretDateExpression', 251130)));
    const full = plain(call('interpretDateExpression', '２５１１３０'));
    assert.equal(full.ok, true); assert.equal(full.rawText, '２５１１３０');
    const zero = plain(call('interpretDateExpression', '050101'));
    assert.deepEqual([zero.ok, zero.yearDigits, zero.year, zero.month, zero.day], [true, 2, 5, 1, 1]);
    for (const text of ['251330', '250032', '202512', '000000']) assert.equal(call('interpretDateExpression', text).ok, false);
  });

  test('csvx 4: serial text has inclusive bounds and preserves raw full width text', () => {
    assert.deepEqual(plain(call('interpretDateExpression', '45992')), plain(call('interpretDateExpression', 45992)));
    for (const [value, expected] of [['36526', [2000, 1, 1]], ['73050', [2099, 12, 31]]]) {
      const date = call('interpretDateExpression', value);
      assert.equal(date.ok, true); assert.deepEqual([date.year, date.month, date.day], expected);
    }
    for (const value of ['36525', '73051', '12345', '99999', '1234', '1234567']) {
      assert.equal(call('interpretDateExpression', value).ok, false, value);
    }
    const full = call('interpretDateExpression', '４５９９２');
    assert.equal(full.ok, true); assert.equal(full.rawText, '４５９９２');
  });

  test('csvx 5: existing date representations retain their meaning', () => {
    const cases = [
      ['2025/12/1', [4, 2025, 12, 1]], ['20251201', [4, 2025, 12, 1]],
      ['25/12/01', [2, 25, 12, 1]], ['12/1', [0, null, 12, 1]], ['12月1日', [0, null, 12, 1]],
      [new Date('2025-12-01T00:00:00Z'), [4, 2025, 12, 1]], [45992, [4, 2025, 12, 1]],
      [251130, [2, 25, 11, 30]]
    ];
    for (const [value, wanted] of cases) {
      const result = call('interpretDateExpression', value);
      assert.equal(result.ok, true);
      assert.deepEqual([result.yearDigits, result.year, result.month, result.day], wanted);
    }
  });

  const billingFormat = pattern => ({billingRule: {sources: [{id: 'fake-payment', kind: 'scanRows',
    scanMaxRows: 2, pattern, groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}]}});
  test('csvx 6: payment date representations yield the same billing month', () => {
    const format = billingFormat('今回のお支払日\\s+(20\\d{2})-(\\d{1,2})-\\d{1,2}');
    for (const value of [new Date('2025-12-27T00:00:00Z'), '2025/12/27', '2025-12-27', '2025年12月27日', '２０２５／１２／２７']) {
      const b = call('extractBillingYearMonth', {rows: [['今回のお支払日', value]]}, '', format);
      assert.deepEqual([b.status, b.year, b.month], ['RESOLVED', 2025, 11]);
    }
  });

  test('csvx 7: original pattern wins and invalid dates stay unchanged', () => {
    const format = billingFormat('(?:今回のお支払日\\s+|別日\\s+)(20\\d{2})/(\\d{1,2})/\\d{1,2}|unused');
    const sheet = {rows: [['今回のお支払日', '2025/12/27'], ['別日', '2025/11/27']]};
    assert.equal(call('extractBillingYearMonth', sheet, '', format).month, 11);
    // 正準形を先に試すと先頭の日付が別の値に化ける規則で、順序の差を観測する。
    const either = billingFormat('(20\\d{2})-(\\d{1,2})-\\d{1,2}|(20\\d{2})/(\\d{1,2})/\\d{1,2}');
    either.billingRule.sources[0].groups = {year: 3, month: 4};
    assert.equal(call('extractBillingYearMonth', {rows: [['2025/12/27']]}, '', either).month, 11);
    for (const text of ['1234-56-78', '2025/02/30']) assert.equal(call('billingDateTextsCanonical_', text), text);
  });

  test('csvx 8: active legacy CSV collides and retirement selects G or H', () => {
    setup(true);
    for (const width of [7, 8]) {
      const sheet = {name: null, rows: csvRows(rows(width))};
      assert.equal(detect(definitions(), [sheet], 'csv').status, 'AMBIGUOUS_CARD_FORMAT');
    }
    call('disableCardFormat_', 'smbc_family_csv', 'FAKE_TEST', 'fake@example.invalid');
    for (const width of [7, 8]) {
      const sheet = {name: null, rows: csvRows(rows(width))};
      const result = detect(definitions(), [sheet], 'csv');
      assert.equal(result.status, 'RESOLVED'); assert.equal(result.formatId, 'smbc_family_x' + width);
      const format = call('pinFormatVersion', result.formatId, result.formatVersion);
      assert.equal(format.purposeColumn, width === 7 ? 'G' : 'H');
      assert.equal(parsed(sheet, format).txs[0].purpose, 'FAKE_PURPOSE');
    }
  });

  test('csvx 9: every private fixture is equivalent without disclosing values', () => {
    const defs = setup();
    const source = fs.readFileSync(path.join(__dirname, 'phase6-real-samples.test.js'), 'utf8');
    const expected = vm.runInNewContext('(' + source.match(/const EXPECTED = (\{[\s\S]*?\n  \});/)[1] + ')');
    const fixtureDir = path.join(__dirname, 'fixtures', 'samples');
    const index = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'index.json'), 'utf8'));
    assert.ok(isDeepStrictEqual(Object.keys(expected).sort(), index.slice().sort()), 'fixture coverage');
    const fields = ['dateHashKey', 'dateYearDigits', 'dateUnreadable', 'amountBillingJpy', 'merchantOriginal',
      'purpose', 'currencyOriginal', 'amountOriginal', 'exchangeRate', 'sourceRow'];
    for (const slug of Object.keys(expected)) {
      let field = 'load';
      try {
        const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, slug + '.json'), 'utf8'));
        const sheets = fixture.sheets.map(sheet => ({name: sheet.name, rows: sheet.rows.map(row =>
          row.map(cell => cell && cell.__date__ ? new Date(cell.__date__) : cell))}));
        const csv = sheets.map(sheet => ({name: null, rows: csvRows(sheet.rows)}));
        field = 'detection';
        const x = detect(defs, sheets, 'xlsx', fixture.fileName), c = detect(defs, csv, 'csv', fixture.fileName);
        const outcome = r => [r.status, r.formatId, r.formatVersion];
        assert.ok(isDeepStrictEqual(outcome(x), outcome(c)), slug + ': ' + field);
        assert.ok(x.status === 'RESOLVED' && x.formatId === expected[slug], slug + ': expected format');
        const format = call('pinFormatVersion', x.formatId, x.formatVersion);
        const xs = sheets.find(s => s.name === x.sheetName), cs = csv[sheets.indexOf(xs)];
        field = 'parse';
        const px = parsed(xs, format), pc = parsed(cs, format);
        assert.ok(px.txs.length === pc.txs.length, slug + ': txCount');
        for (const key of fields) {
          field = key;
          assert.ok(isDeepStrictEqual(px.txs.map(t => t[key]), pc.txs.map(t => t[key])), slug + ': ' + key);
        }
        field = 'excludedRows';
        assert.ok(px.excludedRows.length === pc.excludedRows.length, slug + ': ' + field);
        field = 'stop.reason'; assert.ok(px.stop.reason === pc.stop.reason, slug + ': ' + field);
        field = 'billing';
        assert.ok(isDeepStrictEqual(plain(call('extractBillingYearMonth', xs, fixture.fileName, format)),
          plain(call('extractBillingYearMonth', cs, fixture.fileName, format))), slug + ': ' + field);
        field = 'cardName';
        const context = {folderName: '架空カード', fileName: fixture.fileName};
        assert.ok(call('resolveCardName', xs, format, context) === call('resolveCardName', cs, format, context), slug + ': ' + field);
        field = 'verifyCountsAndTotals';
        assert.ok(isDeepStrictEqual(plain(call('verifyCountsAndTotals', px.txs, format, xs, {})),
          plain(call('verifyCountsAndTotals', pc.txs, format, cs, {}))), slug + ': ' + field);
      } catch (_) {
        // assert の実値・例外本文は取引を含み得るので、項目と本の名前だけを残す。
        throw new Error(slug + ': ' + field);
      }
    }
  });

  function importWorld() {
    setup();
    const header = Array(30).fill(''); header[1] = '利用日';
    gas.stubs.createSpreadsheet('csvx-dest-fake', {sheets: [
      {name: '架空入力', values: [header, Array(30).fill(''), Array(30).fill(''), Array(30).fill('')], maxRows: 20, maxColumns: 30},
      {name: '取引先一覧', values: [['元表記', '取引先名'], ['FAKE_SHOP', 'FAKE_PARTNER']]}
    ]});
    gas.stubs.createSpreadsheet('csvx-index-fake');
    gas.stubs.createSpreadsheet('csvx-snapshot-fake');
    gas.evaluate("SETTINGS.EXECUTION_TIMEOUT_SECONDS=300; SETTINGS.SAFETY_MARGIN_SECONDS=60; SETTINGS.TX_INDEX_SPREADSHEET_ID='csvx-index-fake'; SETTINGS.SNAPSHOT_SPREADSHEET_ID='csvx-snapshot-fake'; SETTINGS.SAMPLE_CORPUS_FOLDER_ID='csvx-corpus-fake'; SETTINGS.FAULT_INJECTION=null;");
    gas.stubs.setActiveUser('csvx-operator@example.invalid');
    call('registerTestCustomer', {customerId: 'CSVX_FAKE', customerName: '架空顧客',
      sourceFolderId: 'csvx-source-fake', destinationSpreadsheetId: 'csvx-dest-fake', destinationSheetName: '架空入力',
      columns: {B: 2, F: 6, I: 9, K: 11, M: 13, txId: 30}, headerRow: 1, dataStartRow: 2, rowScanLastColumn: 30});
    return gas.stubs.createFolder('csvx-source-fake', {name: '架空カード'});
  }
  function importFile(folder, kind, id) {
    const grid = rows();
    // 日本語は「様」だけを含め、実際の Shift_JIS バイトを UTF-8 と取り違えないことも見る。
    grid[0][6] = '';
    const text = toCsv(grid);
    const bytes = Buffer.concat(text.split('様').flatMap((part, i) =>
      i ? [Buffer.from([0x97, 0x6c]), Buffer.from(part, 'ascii')] : [Buffer.from(part, 'ascii')]));
    const file = gas.stubs.createFile(id, {name: 'FAKE_202512.' + kind,
      bytes: kind === 'csv' ? bytes : Buffer.from('FAKE_XLSX_' + id),
      lastUpdated: new Date(Date.now() - 3600000), createdTime: '2026-01-01T00:00:00Z',
      xlsxSheets: kind === 'xlsx' ? [{name: 'FAKE_SHEET', values: grid.map(row => row.map((v, i) =>
        i === 0 && /^\d{4}\//.test(v) ? new Date(v.replace(/\//g, '-') + 'T00:00:00Z') : v)),
        maxRows: grid.length, maxColumns: 7}] : null});
    folder.fileIds.push(id); return file;
  }
  const destinationRows = () => {
    const sheet = gas.stubs.getSpreadsheet('csvx-dest-fake').getSheetByName('架空入力');
    return sheet.getDataRange().getValues().slice(1).filter(row => row[29] !== '');
  };
  test('csvx 10: Shift_JIS CSV reaches import with the Excel date and amount', () => {
    let folder = importWorld(); importFile(folder, 'csv', 'csvx-import-csv-fake');
    const read = call('readFile', 'csvx-import-csv-fake', 'FAKE_202512.csv', {expectedKeywords: ['様']});
    assert.equal(read.encoding, 'Shift_JIS');
    const csvRun = plain(call('runImport', {}));
    assert.equal(csvRun.stoppedBy, null);
    assert.equal(csvRun.customers[0].files[0].outcome, 'WRITTEN');
    const values = destinationRows().map(row => [call('toTokyoDateString_', row[1]), row[12]]);
    assert.equal(values.length, 2);
    folder = importWorld(); importFile(folder, 'xlsx', 'csvx-import-xlsx-fake');
    const xlsxRun = plain(call('runImport', {}));
    assert.equal(xlsxRun.customers[0].files[0].outcome, 'WRITTEN');
    assert.deepEqual(destinationRows().map(row => [call('toTokyoDateString_', row[1]), row[12]]), values);
  });

  test('csvx 11: both import orders hold the second file for purpose revision', () => {
    for (const order of [['xlsx', 'csv'], ['csv', 'xlsx']]) {
      const folder = importWorld();
      importFile(folder, order[0], 'csvx-first-fake');
      const first = plain(call('runImport', {}));
      assert.equal(first.customers[0].files[0].outcome, 'WRITTEN');
      const before = plain(destinationRows());
      importFile(folder, order[1], 'csvx-second-fake');
      const second = plain(call('runImport', {}));
      const item = second.customers[0].files.find(f => f.fileId === 'csvx-second-fake');
      assert.equal(item.nextState, 'REVIEW_WAIT');
      assert.equal(item.code, 'PURPOSE_REVISION_CANDIDATE');
      assert.equal(item.outcome, 'NO_WRITE');
      assert.equal(item.written, 0);
      assert.deepEqual(plain(destinationRows()), before);
      const reviews = plain(call('openReviews', {})).filter(r => r.fileId === 'csvx-second-fake');
      assert.equal(reviews.length, 1);
      // 候補の判定コードは PURPOSE_REVISION_CANDIDATE、既存の要確認種別は DUPLICATE。
      assert.equal(reviews[0].reviewType, 'DUPLICATE');
    }
  });

  test('csvx 12: retirement is strict guarded audited and idempotent', () => {
    setup(true);
    call('appendAudit', {type: 'SETTING', targetId: 'csvx-seed-fake'});
    const before = snapshot();
    const dry = plain(call('opsRetireSmbcCsvFormat'));
    assert.deepEqual(dry, {applied: false, stoppedBy: null, activeVersions: [1], disabledVersions: []});
    assert.deepEqual(snapshot(), before);
    for (const apply of ['true', 1, {}]) {
      assert.equal(call('opsRetireSmbcCsvFormat', apply).applied, false);
      assert.deepEqual(snapshot(), before);
    }
    const audit = master().getSheetByName('監査ログ'), auditRows = audit.getLastRow();
    const applied = plain(call('opsRetireSmbcCsvFormat', true));
    assert.deepEqual(applied, {applied: true, stoppedBy: null, activeVersions: [1], disabledVersions: [1]});
    assert.equal(audit.getLastRow(), auditRows + 1);
    assert.equal(definitions().some(d => d.formatId === 'smbc_family_csv'), false);
    assert.equal(definitions().some(d => d.formatId === 'smbc_family_x7'), true);
    assert.deepEqual(plain(call('opsRetireSmbcCsvFormat', true)).disabledVersions, []);
    setup(true);
    call('disableCardFormat_', 'smbc_family_x7', 'FAKE_TEST', 'fake@example.invalid');
    const inactive = snapshot();
    assert.equal(call('opsRetireSmbcCsvFormat', true).stoppedBy, 'X7_NOT_ACTIVE');
    assert.deepEqual(snapshot(), inactive);
    assert.equal(gas.stubs.getLogs().at(-1), JSON.stringify(call('opsRetireSmbcCsvFormat')));
    const original = gas.context.loadFormatDefinitions;
    mock({loadFormatDefinitions(query) {
      return original(query).map(d => query.formatId === 'smbc_family_x7' ? {...d, valid: false} : d);
    }}, () => {
      assert.equal(call('opsRetireSmbcCsvFormat', true).stoppedBy, 'X7_NOT_ACTIVE');
      assert.deepEqual(snapshot(), inactive);
    });
  });

  const rootId = 'diag-root-fake';
  function world(sharedName) {
    setup(true);
    gas.evaluate("SETTINGS.PARALLEL_WORK_FOLDER_ID=''");
    gas.context.PropertiesService.getScriptProperties().setProperty('CUSTOMER_ROOT_FOLDER_ID', '  ' + rootId + '  ');
    const root = gas.stubs.createFolder(rootId, {name: '架空共通'});
    const category = gas.stubs.createFolder('diag-corp-fake', {name: '法人', parentId: root.id});
    const customer = gas.stubs.createFolder('diag-customer-fake', {name: '架空 Ａ 顧客', parentId: category.id});
    const shared = sharedName ? gas.stubs.createFolder('diag-shared-fake', {name: sharedName, parentId: customer.id}) : null;
    const year = gas.stubs.createFolder('diag-year-fake', {name: '2026年度', parentId: (shared || customer).id});
    const accounting = gas.stubs.createFolder('diag-accounting-fake', {name: '経費', parentId: year.id});
    const statement = gas.stubs.createFolder('diag-statement-fake', {name: 'クレカ明細', parentId: accounting.id});
    return {root, category, customer, shared, year, accounting, statement};
  }
  const diagnose = (fragment = '架空A顧客', options) => plain(call('opsDiagnoseCustomerFolder', fragment,
    {yearFolderId: 'diag-year-fake', ...options}));
  function addFile(folder, name, grid = rows(), id = 'diag-file-fake-' + folder.id + '-' + folder.fileIds.length) {
    gas.stubs.createFile(id, {name, bytes: Buffer.from(toCsv(grid), 'utf8')});
    folder.fileIds.push(id); return id;
  }
  const allFiles = report => report.folders.flatMap(f => f.files);
  test('diag 1: missing name or root reads no Drive', () => {
    world();
    const properties = gas.context.PropertiesService.getScriptProperties();
    mock({getFolderById() { assert.fail('Drive must not be read'); }, getFileById() { assert.fail('Drive must not be read'); }},
      () => {
        assert.equal(diagnose(' 　').stoppedBy, 'NAME_REQUIRED');
        properties.deleteProperty('CUSTOMER_ROOT_FOLDER_ID');
        assert.equal(diagnose().stoppedBy, 'ROOT_NOT_CONFIGURED');
      }, gas.context.DriveApp);
  });

  test('diag 2: normalized search fails closed on ambiguity and verifies folder selection', () => {
    const {root, customer, statement} = world();
    addFile(statement, '架空.csv');
    assert.equal(diagnose('存在しない架空名').stoppedBy, 'CUSTOMER_FOLDER_NOT_FOUND');
    const single = diagnose('架空　A 顧客');
    assert.equal(single.customerFolder.id, customer.id);
    assert.deepEqual(single.customerFolder.path, ['法人', customer.name]);
    const personal = gas.stubs.createFolder('diag-personal-fake', {name: '個人', parentId: root.id});
    gas.stubs.createFolder('diag-other-customer-fake', {name: '架空A顧客', parentId: personal.id});
    mock({readFile() { assert.fail('ambiguous customers must not read files'); }}, () => {
      const result = diagnose();
      assert.equal(result.stoppedBy, 'CUSTOMER_FOLDER_AMBIGUOUS');
      assert.equal(result.candidates.length, 2); assert.deepEqual(result.folders, []);
    });
    assert.equal(diagnose(undefined, {folderId: customer.id}).counts.examined, 1);
    assert.equal(diagnose(undefined, {folderId: 'diag-outside-fake'}).stoppedBy, 'CUSTOMER_FOLDER_NOT_FOUND');
  });

  test('diag 3: walks sorted folders and files through depth eight only', () => {
    const {category, statement} = world();
    const other = gas.stubs.createFolder('diag-unrelated-fake', {name: '架空別顧客', parentId: category.id});
    addFile(other, '漏らしてはいけない.csv');
    let parent = statement;
    const names = ['2026年度', '経費', 'クレカ明細', '0架空カード', '架空二段', '架空三段',
      '架空四段', '架空五段', '架空六段', '架空七段', '架空八段', '架空九段'];
    const chain = [];
    names.slice(3).forEach((name, i) => { parent = gas.stubs.createFolder('diag-depth-fake-' + i, {name, parentId: parent.id}); chain.push(parent); });
    addFile(chain[0], 'B.CSV'); addFile(chain[0], 'A.csv');
    addFile(chain[0], '架空.PDF'); addFile(chain[0], '架空メモ');
    addFile(chain[7], '八段.csv'); addFile(chain[8], '九段.csv');
    const z = gas.stubs.createFolder('diag-sort-z-fake', {name: 'Z', parentId: statement.id});
    const a = gas.stubs.createFolder('diag-sort-a-fake', {name: 'A', parentId: statement.id});
    addFile(z, 'Z.csv'); addFile(a, 'A.csv');
    const result = diagnose();
    assert.deepEqual(allFiles(result).map(f => f.name), ['B.CSV', 'A.csv'].sort().concat(['八段.csv', 'A.csv', 'Z.csv']));
    assert.equal(result.counts.examined, 5); assert.equal(result.counts.ignoredFiles, 2);
    assert.equal(result.counts.folders, 4);
    assert.deepEqual(result.folders[0].path, names.slice(0, 4));
    assert.deepEqual(result.folders[0].ignored, {pdf: 1, '(なし)': 1});
  });

  function installDiagnosticFormat() {
    return call('installCardFormat', {formatId: 'diag_format_fake', formatName: '架空診断形式',
      fileTypes: ['xlsx'], keywordRule: {allOf: [{maxRow: 1, keywords: ['架空日付', '架空店名'], minMatch: 2}]},
      headerRow: 1, dataStartRow: 2, dateColumn: 'A', merchantColumn: 'B', amountColumn: 'C', purposeColumn: 'D',
      exclusionRule: {excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true},
      countTotalRule: {count: {source: 'none'}, total: {source: 'none'}},
      billingRule: {sources: []}, parserKind: 'generic', version: 1, revisionReason: 'FAKE_TEST'});
  }
  test('diag 4: resolved reports count blanks unreadable fields and exclusions', () => {
    const {statement: customer} = world(); installDiagnosticFormat();
    const grid = [['架空日付', '架空店名', '架空金額', '架空用途'],
      ['2025/11/30', 'FAKE_SECRET_SHOP', 1457, 'FAKE_SECRET_PURPOSE'],
      ['2025/11/29', 'FAKE_SECRET_SHOP', 1463, ''],
      ['架空読めない日付', 'FAKE_SECRET_SHOP', 1467, 'FAKE_SECRET_PURPOSE'],
      ['2025/11/28', ' 　', '架空金額不明', 'FAKE_SECRET_PURPOSE']];
    addFile(customer, '架空202512.csv', grid);
    const result = diagnose(), item = allFiles(result)[0];
    assert.equal(result.counts.byStatus.RESOLVED, 1); assert.equal(result.counts.byFormat.diag_format_fake, 1);
    assert.equal(item.status, 'RESOLVED'); assert.equal(item.formatVersion, 1);
    assert.equal(item.txCount, 4); assert.equal(item.purposeBlank, 1); assert.equal(item.dateUnreadable, 1);
    assert.equal(item.amountUnreadable, 1); assert.equal(item.merchantBlank, 1); assert.equal(item.excluded, 1);
    assert.equal(item.stopReason, 'END_OF_LOADED_ROWS'); assert.equal(item.billing, 'NOT_FOUND');
    assert.ok(item.rows === grid.length); assert.ok(item.size > 0); assert.equal(item.encoding, 'UTF-8');
    assert.deepEqual(item.candidates, ['diag_format_fake']);
    assert.deepEqual(result.csvOnlyFormats, ['smbc_family_csv']);
    for (const secret of ['FAKE_SECRET_SHOP', 'FAKE_SECRET_PURPOSE', '1457', '1463', '1467', '2025/11/30']) {
      assert.equal(JSON.stringify(result).includes(secret), false, 'resolved report discloses no transaction values');
    }
    assert.equal(gas.stubs.getLogs().at(-1), JSON.stringify(result));
  });

  test('diag 5: unknown shape and nearest expose headers but never transaction or name cells', () => {
    const {statement: customer} = world();
    const grid = [['架空見出し１２３', 'ABCDEFGHIJKLMNOPQRST'],
      ['架空氏名 様', 'FAKE_PRIVATE_NAME'],
      ['2025/11/30', 'FAKE_PRIVATE_SHOP', 876543, 'FAKE_PRIVATE_PURPOSE'],
      ['0000111122223333'], ['', '架空空欄混在'],
      ['251130', 'FAKE_PRIVATE_SHOP', '876543']];
    while (grid.length < 14) grid.push(['架空追加見出し']);
    addFile(customer, '架空不明.csv', grid);
    const result = diagnose(), item = allFiles(result)[0];
    assert.equal(item.status, 'UNKNOWN_CARD_FORMAT');
    assert.ok(Array.isArray(item.nearest)); assert.ok(item.nearest.length <= 3);
    assert.deepEqual(item.shape[0], {row: 1, cells: ['架空見出し999', 'ABCDEFGHIJKLMNOP']});
    assert.deepEqual(item.shape[1], {row: 2, kinds: 'T|T'});
    assert.deepEqual(item.shape[2], {row: 3, kinds: 'D|T|N|T'});
    assert.deepEqual(item.shape[3], {row: 4, kinds: 'N'});
    assert.deepEqual(item.shape[4], {row: 5, kinds: '|T'});
    assert.equal(item.shape.length, 12);
    for (const secret of ['FAKE_PRIVATE_NAME', 'FAKE_PRIVATE_SHOP', 'FAKE_PRIVATE_PURPOSE', '876543', '0000111122223333']) {
      assert.equal(JSON.stringify(result).includes(secret), false, 'unknown report discloses no private cells');
    }
    const near = rows(); near[1][0] = '架空日付不明'; near[2][0] = '架空日付不明';
    addFile(customer, '架空近似.csv', near, 'diag-nearest-fake');
    const nearest = allFiles(diagnose()).find(f => f.name === '架空近似.csv').nearest;
    assert.ok(nearest.length > 0);
    nearest.forEach(n => assert.deepEqual(Object.keys(n).sort(), ['formatId', 'stage', 'width']));
  });

  test('diag 6: a failed read records only code and continues', () => {
    const {statement: customer} = world();
    addFile(customer, 'A.csv', rows(), 'diag-broken-fake'); addFile(customer, 'B.csv', rows(), 'diag-good-fake');
    const original = gas.context.readFile;
    const report = mock({readFile(id, ...args) {
      if (id === 'diag-broken-fake') { const e = new Error('FAKE_PRIVATE_ERROR'); e.code = 'FAKE_READ_FAILURE'; throw e; }
      return original(id, ...args);
    }}, () => diagnose());
    assert.deepEqual(allFiles(report).map(f => f.status), ['READ_FAILED', 'AMBIGUOUS_CARD_FORMAT']);
    assert.equal(allFiles(report)[0].code, 'FAKE_READ_FAILURE'); assert.equal(report.counts.examined, 2);
    assert.equal(JSON.stringify(report).includes('FAKE_PRIVATE_ERROR'), false);
    assert.equal(report.counts.byStatus.READ_FAILED, 1);
  });

  test('diag 7: budget and skip resume at the exact next sorted target', () => {
    const {statement: customer} = world();
    for (const name of ['C.csv', 'A.csv', 'B.csv']) addFile(customer, name);
    const realDateNow = gas.context.Date.now, original = gas.context.readFile;
    let now = 1000;
    try {
      gas.context.Date.now = () => now;
      const first = mock({readFile(...args) { const r = original(...args); now += 10; return r; }},
        () => diagnose(undefined, {timeBudgetMs: 20}));
      assert.equal(first.stoppedBy, 'TIME_BUDGET'); assert.equal(first.nextSkip, 2);
      assert.deepEqual(allFiles(first).map(f => f.name), ['A.csv', 'B.csv']);
      const second = diagnose(undefined, {skip: first.nextSkip, timeBudgetMs: 20});
      assert.equal(second.stoppedBy, null); assert.equal(second.nextSkip, null);
      assert.deepEqual(allFiles(first).concat(allFiles(second)).map(f => f.name), ['A.csv', 'B.csv', 'C.csv']);
      const zero = diagnose(undefined, {skip: 1, timeBudgetMs: -1});
      assert.equal(zero.stoppedBy, 'TIME_BUDGET'); assert.equal(zero.nextSkip, 1); assert.equal(zero.counts.examined, 0);
      assert.equal(diagnose(undefined, {timeBudgetMs: 'non-number'}).counts.examined, 3);
    } finally { gas.context.Date.now = realDateNow; }
  });

  test('diag 8: diagnosis leaves all master sheets audit cells and Drive files unchanged', () => {
    const {statement: customer} = world(); addFile(customer, '架空.csv');
    const before = snapshot(), beforeFile = plain(gas.stubs.getFile(customer.fileIds[0]));
    const properties = gas.stubs.getPropertyWrites().length;
    gas.stubs.resetRoundTrips(); gas.stubs.resetApiCallCounts();
    const report = diagnose();
    assert.equal(report.counts.examined, 1);
    assert.equal(gas.stubs.roundTrips().rangeWrites, 0);
    assert.equal(gas.stubs.getApiCallCounts().cellsWritten, 0);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(plain(gas.stubs.getFile(customer.fileIds[0])), beforeFile);
    assert.equal(gas.stubs.getPropertyWrites().length, properties);
  });
  test('csvx 7b: canonicalization preserves text when the parser leaves the year unresolved', () => {
    // 現行の実入力では年4桁の照合と解釈が揃う。解釈器が年を確定しない場合の
    // 防御は実入力で通らないので、代役でその契約を確かめる（R12）。
    mock({interpretDateExpression() {
      return {ok: true, yearDigits: 2, year: 25, month: 12, day: 27};
    }}, () => assert.equal(call('billingDateTextsCanonical_', '2025/12/27'), '2025/12/27'));
  });

  test('csvx 12b: retirement touches enabled legacy versions only', () => {
    setup(true);
    const spec = plain(call('loadFormatDefinitions', {formatId: 'smbc_family_csv'}))[0];
    call('installCardFormat', {...spec, version: 2, enabled: false});
    call('installCardFormat', {...spec, version: 3, enabled: true});
    call('appendAudit', {type: 'SETTING', targetId: 'csvx-seed-fake'});
    const sheet = master().getSheetByName('カード形式マスター');
    const inactiveRow = call('loadFormatDefinitions', {formatId: 'smbc_family_csv', version: 2})[0]._rowNumber;
    const inactiveBefore = plain(sheet.getRange(inactiveRow, 1, 1, sheet.getLastColumn()).getValues());
    const before = master().getSheetByName('監査ログ').getLastRow();
    const report = plain(call('opsRetireSmbcCsvFormat', true));
    assert.deepEqual(report.activeVersions, [1, 3]); assert.deepEqual(report.disabledVersions, [1, 3]);
    assert.deepEqual(plain(sheet.getRange(inactiveRow, 1, 1, sheet.getLastColumn()).getValues()), inactiveBefore);
    const audits = master().getSheetByName('監査ログ').getDataRange().getValues().slice(before);
    assert.equal(audits.length, 2);
    assert.ok(audits.every(row => row[2] === 'FORMAT_DISABLE' && row[7] === 'smbc_family_csv' &&
      JSON.parse(row[10]).reason === 'UNIFIED_WITH_SMBC_X7'));
    assert.equal(definitions().some(d => d.formatId === 'smbc_family_x7'), true);
  });

  test('diag 9: Excel resolves its matching sheet using one definition load and leaves only temporary work', () => {
    const {statement: customer} = world(); installDiagnosticFormat();
    gas.evaluate("SETTINGS.PARALLEL_WORK_FOLDER_ID='diag-work-fake'");
    const id = 'diag-excel-fake';
    gas.stubs.createFile(id, {name: '架空.XLSX', bytes: Buffer.from('FAKE_XLSX'),
      xlsxSheets: [{name: 'FAKE_UNRELATED_SHEET', values: [['架空無関係']], maxRows: 1, maxColumns: 1},
        {name: 'FAKE_MATCHED_SHEET', values: [['架空日付', '架空店名', '架空金額', '架空用途'],
          [new Date('2025-11-30T00:00:00Z'), 'FAKE_PRIVATE_SHOP', 1763, 'FAKE_PRIVATE_PURPOSE']],
        maxRows: 2, maxColumns: 4}]});
    customer.fileIds.push(id);
    const before = snapshot(), ids = gas.stubs.getSpreadsheetIds().slice().sort();
    const load = gas.context.loadFormatDefinitions, read = gas.context.readFile, parse = gas.context.parseFile;
    const masterSheets = master().getSheets();
    function noMasterWrites(index, fn) {
      if (index === masterSheets.length) return fn();
      return mock({_write() { assert.fail('master must not be written'); }},
        () => noMasterWrites(index + 1, fn), masterSheets[index]);
    }
    let loads = 0, reads = 0, parses = 0;
    const keywords = plain(call('detectionKeywordUnion_', definitions()));
    gas.stubs.resetRoundTrips(); gas.stubs.resetApiCallCounts();
    const report = mock({
      loadFormatDefinitions(query) { loads++; assert.deepEqual(plain(query), {status: 'active', enabled: true}); return load(query); },
      readFile(fileId, name, options) {
        reads++; assert.equal(fileId, id); assert.equal(name, '架空.XLSX');
        assert.deepEqual(plain(options.expectedKeywords), keywords); return read(fileId, name, options);
      },
      parseFile(sheet, format, context) {
        parses++; assert.equal(sheet.name, 'FAKE_MATCHED_SHEET');
        assert.deepEqual(plain(context), {customerId: 'DIAG', fileId: id, fileNameOriginal: '架空.XLSX'});
        return parse(sheet, format, context);
      }
    }, () => noMasterWrites(0, () => diagnose()));
    const item = allFiles(report)[0];
    assert.deepEqual([loads, reads, parses], [1, 1, 1]);
    assert.deepEqual([item.fileType, item.status, item.formatId, item.rows, item.txCount],
      ['xlsx', 'RESOLVED', 'diag_format_fake', 2, 1]);
    // 一時シートの作成は readFile の責務。顧客ファイルとマスターへの書込は許さない。
    assert.equal(gas.stubs.getApiCallCounts().cellsWritten, 0);
    assert.deepEqual(snapshot(), before); assert.deepEqual(gas.stubs.getSpreadsheetIds().sort(), ids);
    assert.deepEqual(customer.fileIds, [id]);
    for (const secret of ['FAKE_PRIVATE_SHOP', 'FAKE_PRIVATE_PURPOSE', '1763']) assert.equal(JSON.stringify(report).includes(secret), false);
  });

  test('diag 10: multiple matching sheets keep ambiguity and use the largest shape with distinct candidates', () => {
    const {statement: customer} = world();
    gas.evaluate("SETTINGS.PARALLEL_WORK_FOLDER_ID='diag-work-fake'");
    const largest = rows(8).concat([['架空最後見出し']]);
    gas.stubs.createFile('diag-multisheet-fake', {name: '架空複数.xlsx', bytes: Buffer.from('FAKE_XLSX'),
      xlsxSheets: [{name: 'FAKE_SMALL_SHEET', values: rows(), maxRows: 3, maxColumns: 7},
        {name: 'FAKE_LARGE_SHEET', values: largest, maxRows: 4, maxColumns: 8}]});
    customer.fileIds.push('diag-multisheet-fake');
    const item = allFiles(diagnose())[0];
    assert.equal(item.status, 'MULTI_SHEET_AMBIGUOUS'); assert.equal(item.rows, 4);
    assert.deepEqual(item.candidates.slice().sort(), ['smbc_family_csv', 'smbc_family_x7', 'smbc_family_x8']);
    assert.deepEqual(item.shape[3], {row: 4, cells: ['架空最後見出し']});
    assert.equal(item.txCount, undefined);
  });

  test('diag 11: malformed CSV and parse exceptions stay private and do not stop the next file', () => {
    const {statement: customer} = world(); installDiagnosticFormat();
    gas.stubs.createFile('diag-real-broken-fake', {name: 'A.csv', bytes: Buffer.from('"FAKE_PRIVATE_ERROR', 'utf8')});
    customer.fileIds.push('diag-real-broken-fake');
    const grid = [['架空日付', '架空店名', '架空金額', '架空用途'],
      ['2025/11/30', 'FAKE_PRIVATE_SHOP', 1347, 'FAKE_PRIVATE_PURPOSE']];
    addFile(customer, 'B.csv', grid, 'diag-parse-failed-fake');
    addFile(customer, 'C.csv', grid, 'diag-after-failed-fake');
    const parse = gas.context.parseFile;
    const report = mock({parseFile(sheet, format, context) {
      if (context.fileId === 'diag-parse-failed-fake') throw new TypeError('FAKE_PRIVATE_ERROR');
      return parse(sheet, format, context);
    }}, () => diagnose());
    const files = allFiles(report);
    assert.deepEqual(files.map(f => f.status), ['READ_FAILED', 'PARSE_FAILED', 'RESOLVED']);
    assert.equal(files[0].code, 'CSV_PARSE_FAILED'); assert.equal(files[1].code, 'TypeError');
    assert.equal(report.counts.examined, 3);
    assert.deepEqual(report.counts.byStatus, {READ_FAILED: 1, PARSE_FAILED: 1, RESOLVED: 1});
    for (const secret of ['FAKE_PRIVATE_ERROR', 'FAKE_PRIVATE_SHOP', 'FAKE_PRIVATE_PURPOSE', '1347']) {
      assert.equal(JSON.stringify(report).includes(secret), false);
      assert.equal(gas.stubs.getLogs().at(-1).includes(secret), false);
    }
  });

  test('diag 12: every ignored extension is a count including object property names', () => {
    const {statement: customer} = world();
    addFile(customer, 'FAKE.__proto__'); addFile(customer, 'FAKE.constructor');
    const report = diagnose();
    assert.equal(report.counts.examined, 0); assert.equal(report.counts.ignoredFiles, 2);
    assert.equal(report.folders.length, 1);
    assert.equal(Object.hasOwn(report.folders[0].ignored, '__proto__'), true);
    assert.equal(report.folders[0].ignored.__proto__, 1); assert.equal(report.folders[0].ignored.constructor, 1);
  });

  test('diag 13: trailing blanks do not hide a header and never reveal a private row', () => {
    const {statement: customer} = world();
    // 行末のカンマを残す。`addFile` の変換は行末の空を落とすので生の文字で作る。
    const text = ['架空見出し１２３,架空見出し二,,', '架空氏名 様,FAKE_PRIVATE_NAME,,',
      '2025/11/30,FAKE_PRIVATE_SHOP,876543,', ',架空空欄混在,,', ',,,'].join('\r\n');
    gas.stubs.createFile('diag-trailing-fake', {name: '架空不明.csv', bytes: Buffer.from(text, 'utf8')});
    customer.fileIds.push('diag-trailing-fake');
    const report = diagnose(), item = allFiles(report)[0];
    assert.equal(item.status, 'UNKNOWN_CARD_FORMAT');
    assert.deepEqual(item.shape[0], {row: 1, cells: ['架空見出し999', '架空見出し二']});
    assert.deepEqual(item.shape[1], {row: 2, kinds: 'T|T||'});
    assert.deepEqual(item.shape[2], {row: 3, kinds: 'D|T|N|'});
    assert.deepEqual(item.shape[3], {row: 4, kinds: '|T||'});
    assert.deepEqual(item.shape[4], {row: 5, kinds: '|||'});
    for (const secret of ['FAKE_PRIVATE_NAME', 'FAKE_PRIVATE_SHOP', '876543']) {
      assert.equal(JSON.stringify(report).includes(secret), false);
    }
  });

  test('diag 14: the report is plain data and sorting asks each entry for its name once', () => {
    const {statement: customer} = world();
    addFile(customer, 'A.csv');
    const raw = call('opsDiagnoseCustomerFolder', '架空A顧客', {yearFolderId: 'diag-year-fake'});
    assert.notEqual(Object.getPrototypeOf(raw.counts.byStatus), null);
    assert.notEqual(Object.getPrototypeOf(raw.folders[0].ignored), null);
    let asked = 0;
    const entry = (name, id) => ({getName() { asked += 1; return name; }, getId: () => id});
    const list = [entry('B', '2'), entry('A', '9'), entry('A', '1')];
    let next = 0;
    const sorted = gas.context.diagSortedEntries_({hasNext: () => next < list.length, next: () => list[next++]});
    assert.deepEqual(Array.from(sorted).map((e) => e.getId()), ['1', '9', '2']);
    assert.equal(asked, 3);
  });

  test('diag 15: a name in any column stays hidden, zero is a readable amount, shared formats are not csv-only', () => {
    const {statement: customer} = world(); installDiagnosticFormat();
    addFile(customer, '架空不明.csv', [['架空見出し', '架空氏名 様', 'FAKE_PRIVATE_NAME']]);
    addFile(customer, '架空202512.csv', [['架空日付', '架空店名', '架空金額', '架空用途'],
      ['2025/11/27', 'FAKE_SECRET_SHOP', 0, 'FAKE_SECRET_PURPOSE']]);
    const original = gas.context.loadFormatDefinitions;
    const report = mock({loadFormatDefinitions(query) {
      return original(query).map((d) => d.formatId === 'smbc_family_x8' ? {...d, fileTypes: ['csv', 'xlsx']} : d);
    }}, () => diagnose());
    const files = allFiles(report);
    assert.deepEqual(files.find((f) => f.name === '架空不明.csv').shape[0], {row: 1, kinds: 'T|T|T'});
    assert.equal(JSON.stringify(report).includes('FAKE_PRIVATE_NAME'), false);
    const resolved = files.find((f) => f.name === '架空202512.csv');
    assert.equal(resolved.txCount, 1); assert.equal(resolved.amountUnreadable, 0);
    assert.deepEqual(report.csvOnlyFormats, ['smbc_family_csv']);
  });

  function observeDiagDrive(fn) {
    const access = {files: [], folders: [], ids: []};
    const getFolder = gas.context.DriveApp.getFolderById;
    function wrap(folder) {
      const id = folder.getId();
      return {...folder,
        getFiles() { access.files.push(id); return folder.getFiles(); },
        getFolders() {
          access.folders.push(id);
          const iterator = folder.getFolders();
          return {hasNext: () => iterator.hasNext(), next: () => wrap(iterator.next())};
        }};
    }
    return mock({getFolderById(id) { access.ids.push(id); return wrap(getFolder(id)); }},
      () => fn(access), gas.context.DriveApp);
  }
  function assertDiagStopped(options, stoppedBy, level, choices, folderIds) {
    return observeDiagDrive(access => mock({
      readFile() { assert.fail('folder selection must stop before file reads'); },
      loadFormatDefinitions() { assert.fail('folder selection must stop before master reads'); }
    }, () => {
      const report = diagnose(undefined, options);
      assert.equal(report.stoppedBy, stoppedBy);
      assert.deepEqual(report.folderChoices, {level, choices});
      assert.equal(report.customerFolder.id, 'diag-customer-fake');
      assert.equal(report.statementFolder, null);
      assert.deepEqual(report.counts, {folders: 0, examined: 0, ignoredFiles: 0, byStatus: {}, byFormat: {}});
      assert.deepEqual(report.folders, []); assert.deepEqual(report.csvOnlyFormats, []);
      assert.equal(report.nextSkip, null);
      assert.deepEqual(access.files, []);
      assert.deepEqual(access.folders, [rootId, 'diag-corp-fake', 'diag-customer-fake', 'diag-customer-fake', ...folderIds]);
      assert.deepEqual(access.ids, [rootId]);
      assert.equal(gas.stubs.getLogs().at(-1), JSON.stringify(report));
      return report;
    }));
  }

  test('diag 16: reads only the selected statement subtree and lists no out-of-scope files', () => {
    const {customer, year, accounting, statement} = world();
    const past = gas.stubs.createFolder('diag-past-fake', {name: '架空過年度', parentId: customer.id});
    const unrelated = gas.stubs.createFolder('diag-non-accounting-fake', {name: '架空資料', parentId: year.id});
    const nonStatement = gas.stubs.createFolder('diag-non-statement-fake', {name: '架空帳票', parentId: accounting.id});
    const outside = [customer, past, unrelated, nonStatement];
    outside.forEach((folder, i) => addFile(folder, 'FAKE_OUTSIDE_FILE_' + i + '.csv', [['FAKE_OUTSIDE_CONTENT_' + i]]));
    const cardB = gas.stubs.createFolder('diag-card-b-fake', {name: '架空カードB', parentId: statement.id});
    const cardA = gas.stubs.createFolder('diag-card-a-fake', {name: '架空カードA', parentId: statement.id});
    const a = addFile(cardA, 'A.csv'), b = addFile(cardB, 'B.csv');
    const read = gas.context.readFile, reads = [];
    observeDiagDrive(access => mock({readFile(id, ...args) { reads.push(id); return read(id, ...args); }}, () => {
      const report = diagnose();
      assert.equal(report.stoppedBy, null); assert.equal(report.folderChoices, null);
      assert.deepEqual(report.statementFolder, {id: statement.id, path: [year.name, accounting.name, statement.name]});
      assert.deepEqual(reads, [a, b]); assert.deepEqual(allFiles(report).map(f => f.name), ['A.csv', 'B.csv']);
      assert.deepEqual(access.files, [statement.id, cardA.id, cardB.id]);
      for (const folder of outside.slice(1)) assert.equal(access.folders.includes(folder.id), false);
      assert.deepEqual(report.folders.map(f => f.path), [cardA, cardB].map(card =>
        [year.name, accounting.name, statement.name, card.name]));
      assert.equal(report.counts.examined, 2);
      for (const secret of ['FAKE_OUTSIDE_FILE_', 'FAKE_OUTSIDE_CONTENT_', past.name, unrelated.name, nonStatement.name]) {
        assert.equal(JSON.stringify(report).includes(secret), false);
        assert.equal(gas.stubs.getLogs().at(-1).includes(secret), false);
      }
    }));
  });

  test('diag 17: year selection requires a direct child ID and returns names without reading descendants', () => {
    const {customer, year, statement} = world();
    const other = gas.stubs.createFolder('diag-year-other-fake', {name: '1025架空年度', parentId: customer.id});
    const external = gas.stubs.createFolder('diag-year-outside-fake', {name: '架空外部年度'});
    const externalAccounting = gas.stubs.createFolder('diag-year-outside-accounting-fake', {name: '経理', parentId: external.id});
    const externalStatement = gas.stubs.createFolder('diag-year-outside-statement-fake', {name: 'クレカ', parentId: externalAccounting.id});
    addFile(year, 'FAKE_PRIVATE_YEAR_FILE.csv'); addFile(statement, 'FAKE_PRIVATE_STATEMENT_FILE.csv');
    addFile(other, 'FAKE_PRIVATE_OTHER_YEAR_FILE.csv'); addFile(externalStatement, 'FAKE_PRIVATE_EXTERNAL_FILE.csv');
    const choices = [other, year].map(({id, name}) => ({id, name}));
    for (const yearFolderId of [undefined, null, '', external.id, statement.id]) {
      assertDiagStopped({yearFolderId}, 'YEAR_FOLDER_REQUIRED', 'year', choices, []);
    }
  });

  test('diag 18: accounting and statement name variants normalize before matching', () => {
    for (const [accountingName, statementName] of [
      ['経費', 'クレカ明細'], ['経理部', 'クレジット明細'], ['架空経理', 'クレジットカード明細'],
      ['経費資料', 'カード明細'], ['　経　費　', '　ｸﾚｶ　明細　']
    ]) {
      const {year, accounting, statement} = world();
      accounting.name = accountingName; statement.name = statementName;
      addFile(statement, '架空.csv');
      const report = diagnose();
      assert.equal(report.stoppedBy, null); assert.equal(report.counts.examined, 1);
      assert.deepEqual(report.statementFolder, {id: statement.id, path: [year.name, accountingName, statementName]});
    }
  });

  test('diag 19: unclear accounting or statement choices stop and explicit IDs stay within direct children', () => {
    for (const level of ['accounting', 'statement']) {
      for (const count of [0, 2]) {
        const {year, accounting, statement} = world();
        const parent = level === 'accounting' ? year : accounting;
        const selected = level === 'accounting' ? accounting : statement;
        if (count === 0) selected.name = '架空資料';
        if (count === 2) gas.stubs.createFolder('diag-second-' + level + '-fake',
          {name: level === 'accounting' ? '経理部' : 'カード明細', parentId: parent.id});
        addFile(statement, 'FAKE_PRIVATE_CHOICE_FILE.csv');
        const children = parent.subFolderIds.map(id => gas.context.DriveApp.getFolderById(id));
        const choices = children.map(folder => ({id: folder.getId(), name: folder.getName()}))
          .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.id.localeCompare(b.id));
        const folderIds = level === 'accounting' ? [year.id] : [year.id, accounting.id];
        assertDiagStopped({}, 'FOLDER_UNCLEAR', level, choices, folderIds);
        const option = level === 'accounting' ? 'accountingFolderId' : 'statementFolderId';
        const invalid = gas.stubs.createFolder('diag-external-choice-fake', {name: '架空外部'});
        addFile(invalid, 'FAKE_PRIVATE_EXTERNAL_FILE.csv');
        assertDiagStopped({[option]: invalid.id}, 'FOLDER_UNCLEAR', level, choices, folderIds);
        const report = diagnose(undefined, {[option]: selected.id});
        assert.equal(report.stoppedBy, null); assert.equal(report.statementFolder.id, statement.id);
        assert.equal(report.counts.examined, 1);
      }
      const {year, accounting, statement} = world();
      addFile(statement, '架空.csv');
      const selected = level === 'accounting' ? accounting : statement;
      const option = level === 'accounting' ? 'accountingFolderId' : 'statementFolderId';
      const folderIds = level === 'accounting' ? [year.id] : [year.id, accounting.id];
      // 自動なら一意でも、範囲外の明示 ID を無視して進むと選択の誤りを隠してしまう。
      for (const explicit of [year.id, '']) {
        assertDiagStopped({[option]: explicit}, 'FOLDER_UNCLEAR', level,
          [{id: selected.id, name: selected.name}], folderIds);
      }
    }
  });

  test('diag 20: scoped traversal preserves sorted skip and nextSkip across cards', () => {
    const {customer, statement} = world();
    addFile(customer, 'FAKE_OUTSIDE_FILE.csv');
    const cardB = gas.stubs.createFolder('diag-resume-b-fake', {name: 'B', parentId: statement.id});
    const cardA = gas.stubs.createFolder('diag-resume-a-fake', {name: 'A', parentId: statement.id});
    addFile(cardA, 'B.csv'); addFile(cardA, 'A.csv'); addFile(cardB, 'D.csv'); addFile(cardB, 'C.csv');
    addFile(cardA, '架空.pdf');
    const realDateNow = gas.context.Date.now, read = gas.context.readFile;
    let now = 1000;
    try {
      gas.context.Date.now = () => now;
      const first = mock({readFile(...args) { const result = read(...args); now += 10; return result; }},
        () => diagnose(undefined, {timeBudgetMs: 20}));
      assert.equal(first.stoppedBy, 'TIME_BUDGET'); assert.equal(first.nextSkip, 2);
      assert.deepEqual(allFiles(first).map(f => f.name), ['A.csv', 'B.csv']);
      const second = diagnose(undefined, {skip: first.nextSkip, timeBudgetMs: 20});
      assert.equal(second.stoppedBy, null); assert.equal(second.nextSkip, null);
      assert.deepEqual(allFiles(first).concat(allFiles(second)).map(f => f.name), ['A.csv', 'B.csv', 'C.csv', 'D.csv']);
      assert.deepEqual(second.statementFolder, first.statementFolder);
      const zero = diagnose(undefined, {skip: 3, timeBudgetMs: 0});
      assert.equal(zero.stoppedBy, 'TIME_BUDGET'); assert.equal(zero.nextSkip, 3);
      assert.equal(zero.counts.examined, 0);
    } finally { gas.context.Date.now = realDateNow; }
  });

  test('diag 21: one shared folder adds a level and files beside the year stay unread', () => {
    const {customer, shared, year, accounting, statement} = world('☆架空 資料共有フォルダ');
    const past = gas.stubs.createFolder('diag-shared-past-fake', {name: '架空過年度分', parentId: shared.id});
    [customer, shared, past].forEach((folder, i) => addFile(folder, 'FAKE_OUTSIDE_FILE_' + i + '.csv'));
    const inside = addFile(statement, 'A.csv');
    const read = gas.context.readFile, reads = [];
    mock({readFile(id, ...args) { reads.push(id); return read(id, ...args); }}, () => {
      const stopped = diagnose(undefined, {yearFolderId: null});
      assert.equal(stopped.stoppedBy, 'YEAR_FOLDER_REQUIRED');
      assert.deepEqual(stopped.folderChoices, {level: 'year', choices: [
        {id: year.id, name: year.name}, {id: past.id, name: past.name}]});
      assert.deepEqual(reads, []);
      const report = diagnose();
      assert.equal(report.stoppedBy, null);
      const path = [shared.name, year.name, accounting.name, statement.name];
      assert.deepEqual(report.statementFolder, {id: statement.id, path});
      assert.deepEqual(reads, [inside]);
      assert.deepEqual(report.folders.map(f => f.path), [path]);
    });
  });

  test('diag 22: two shared folders stop at the year and read nothing', () => {
    const {customer, shared, statement} = world('架空資料共有A');
    const other = gas.stubs.createFolder('diag-shared-other-fake', {name: '架空資料共有B', parentId: customer.id});
    addFile(shared, 'FAKE_OUTSIDE_FILE.csv'); addFile(statement, 'A.csv');
    const report = diagnose();
    assert.equal(report.stoppedBy, 'YEAR_FOLDER_REQUIRED');
    assert.deepEqual(report.folderChoices, {level: 'year', choices: [
      {id: shared.id, name: shared.name}, {id: other.id, name: other.name}]});
    assert.equal(report.counts.examined, 0); assert.equal(report.statementFolder, null);
  });

  test('diag 23: Excel is listed but not read until a work folder is set', () => {
    const {statement} = world();
    gas.stubs.createFile('diag-excel-fake', {name: 'A.xlsx', bytes: Buffer.from('FAKE_XLSX'),
      xlsxSheets: [{name: 'FAKE_SHEET', values: rows(), maxRows: 3, maxColumns: 7}]});
    statement.fileIds.push('diag-excel-fake');
    const csv = addFile(statement, 'B.csv');
    const read = gas.context.readFile, reads = [];
    mock({readFile(id, ...args) { reads.push(id); return read(id, ...args); }}, () => {
      const report = diagnose();
      assert.equal(allFiles(report)[0].status, 'EXCEL_NOT_READ');
      assert.equal(allFiles(report)[0].size, Buffer.byteLength('FAKE_XLSX'));
      assert.notEqual(allFiles(report)[1].status, 'EXCEL_NOT_READ');
      assert.deepEqual(reads, [csv]);
      assert.equal(report.counts.byStatus.EXCEL_NOT_READ, 1); assert.equal(report.counts.examined, 2);
      gas.evaluate("SETTINGS.PARALLEL_WORK_FOLDER_ID='diag-work-fake'");
      const withFolder = diagnose();
      assert.notEqual(allFiles(withFolder)[0].status, 'EXCEL_NOT_READ');
      assert.deepEqual(reads, [csv, 'diag-excel-fake', csv]);
    });
  });

  test('diag 24: unread files report only their type counts and one sample name', () => {
    const {statement} = world();
    const sheet = 'application/vnd.google-apps.spreadsheet';
    [['架空二月', sheet], ['架空一月', sheet], ['架空領収書.pdf', 'application/pdf'], ['constructor', '__proto__']]
      .forEach(([name, contentType], i) => {
        gas.stubs.createFile('diag-type-fake-' + i, {name, contentType, bytes: Buffer.from('FAKE_PRIVATE_CONTENT')});
        statement.fileIds.push('diag-type-fake-' + i);
      });
    const report = mock({readFile() { assert.fail('unread types must not be read'); }}, () => diagnose());
    assert.deepEqual(Object.keys(report.ignoredTypes).sort(), ['__proto__', 'application/pdf', sheet].sort());
    assert.deepEqual(report.ignoredTypes[sheet], {count: 2, sampleName: '架空一月'});
    assert.deepEqual(report.ignoredTypes['application/pdf'], {count: 1, sampleName: '架空領収書.pdf'});
    assert.equal(report.counts.ignoredFiles, 4);
    assert.equal(JSON.stringify(report).includes('FAKE_PRIVATE_CONTENT'), false);
  });

};

'use strict';

/**
 * 10.4 実機セットアップ用ヘルパー。
 *
 * 実機で操作者が実行するのはここの3関数（describeDestinationSheet →
 * registerTestCustomer → installSmbcCsvFormat）＋ importRunReport なので、
 * その並びをそのままNodeで通しておく。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const blank = (n) => Array(n).fill('');

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート',
       values: [['', '利用日', 'freee取引先名', '摘要', '元の店名', '金額', '内部取引ID', '']],
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
    gas.stubs.setActiveUser('operator@example.com');
  }

  const CUSTOMER = {
    customerId: 'C001', customerName: 'テスト顧客',
    sourceFolderId: 'folder1', destinationSpreadsheetId: 'dest1',
    destinationSheetName: '入力用シート',
    columns: {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7}
  };

  test('describeDestinationSheet reports the live header without writing', () => {
    setup();
    const report = plain(gas.call('describeDestinationSheet', ['dest1', '入力用シート', 1]));
    assert.equal(report.headers.length, 6);
    assert.deepEqual(report.headers[0], {column: 2, letter: 'B', text: '利用日'});
  });

  test('registerTestCustomer builds a valid customer row from the live header', () => {
    setup();
    const result = plain(gas.call('registerTestCustomer', [CUSTOMER]));
    assert.equal(result.updated, false);
    assert.ok(result.headerExpectation.cells.every((cell) => cell.column !== 7),
      'the tx-id column must never enter the AE expectation (item 4)');

    const customer = plain(gas.call('getCustomerById', ['C001']));
    assert.equal(customer.customerName, 'テスト顧客');
    assert.equal(customer.columnMapping.txId, 7);
    assert.equal(customer.schemaVersion, '1.0');

    // 生成したAE期待値で4.22が通ること（登録した瞬間に書ける状態であること）
    const index = gas.call('buildIndex', [customer, {}]);
    const schema = plain(gas.call('validateDestinationSchema', [customer, index]));
    assert.equal(schema.ok, true, JSON.stringify(schema.problems));

    // 冪等：同じIDでの再実行は上書き
    const again = plain(gas.call('registerTestCustomer', [CUSTOMER]));
    assert.equal(again.updated, true);
    assert.equal(again.rowNumber, result.rowNumber);
  });

  test('installCardFormat validates the definition and refuses duplicates', () => {
    setup();
    const first = plain(gas.call('installSmbcCsvFormat', []));
    assert.equal(first.installed, true);
    const second = plain(gas.call('installSmbcCsvFormat', []));
    assert.equal(second.installed, false);
    assert.equal(second.reason, 'ALREADY_EXISTS');

    const rows = plain(gas.call('loadFormatDefinitions', [{formatId: 'smbc_family_csv'}]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].valid, true);

    assert.throws(() => gas.call('installCardFormat', [{
      formatId: 'broken', keywordRule: {allOf: []}, headerRow: 0, dataStartRow: 0
    }]), (error) => error && error.code === 'CARD_FORMAT_DEFINITION_INVALID',
      'an invalid definition must be refused at the door, not stored');
  });

  test('the real setup sequence carries a SMBC-family CSV end to end', () => {
    setup();
    gas.call('registerTestCustomer', [CUSTOMER]);
    gas.call('installSmbcCsvFormat', []);

    // samplesのLINEPAYカードCSVと同じ形（氏名行＋7列明細＋合計行）
    const csv = '〇〇　〇〇　様,4980-00**-****-****,三井住友ゴールドＶＩＳＡ（ＮＬ）,,,,\n' +
      '2025/12/16,ローソン,10800,1,1,10800,仕入れ\n' +
      '2026/1/12,ローソン,10900,1,1,10900,仕入れ\n' +
      ',,,,,58100,\n';
    gas.stubs.createFile('csv1', {name: '三井住友カード202602.csv',
      bytes: Buffer.from(csv, 'utf8'), lastUpdated: new Date(Date.now() - 3600 * 1000),
      createdTime: '2026-08-01T00:00:00Z'});
    gas.stubs.createFolder('folder1', {fileIds: ['csv1']});

    const report = plain(gas.call('importRunReport', [{}]));
    assert.equal(report.stoppedBy, null, JSON.stringify(report));
    const fileReport = report.customers[0].files[0];
    assert.equal(fileReport.outcome, 'WRITTEN', JSON.stringify(fileReport));
    assert.equal(fileReport.written, 2);
    // 辞書が空なので取引先は全件UNRESOLVED＝REVIEW_WAITで人の確認待ち
    assert.equal(fileReport.nextState, 'REVIEW_WAIT');

    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    const b2 = sheet.getRange(2, 2).getValue();
    const dateText = b2 instanceof Date ?
      b2.toLocaleDateString('sv-SE', {timeZone: 'Asia/Tokyo'}) : b2;
    assert.equal(dateText, '2025-12-16');
    assert.equal(sheet.getRange(2, 6).getValue(), 10800);
    assert.equal(sheet.getRange(2, 3).getValue(), '', 'no dictionary, so F stays blank');
    assert.equal(sheet.getRange(4, 2).getValue(), '', 'the total row is not written');

    const reviews = plain(gas.call('openReviews', [{}]));
    assert.equal(reviews.filter((r) => r.reviewType === 'PARTNER').length, 2);
  });
};

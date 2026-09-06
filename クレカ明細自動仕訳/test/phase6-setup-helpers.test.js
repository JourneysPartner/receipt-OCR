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

  test('the amount fallback column survives a round trip through the format master', () => {
    // 形式定義に足した項目は、マスターへ書いて読み直しても残らなければ
    // 実機では効かない（列を増やし忘れると黙って消える）。
    setup();
    gas.call('installCardFormat', [{
      formatId: 'fallback_probe', formatName: '予備列の確認', fileTypes: ['xlsx'],
      keywordRule: {allOf: [{maxRow: 1, keywords: ['利用日'], minMatch: 1}]},
      headerRow: 1, dataStartRow: 2,
      dateColumn: 'A', merchantColumn: 'B', amountColumn: 'C', purposeColumn: 'H',
      amountFallbackColumn: 'F',
      parserKind: 'generic', version: 1, revisionReason: 'NEW'
    }]);
    const loaded = plain(gas.call('loadFormatDefinitions',
      [{formatId: 'fallback_probe', enabled: true}]))[0];
    assert.equal(loaded.valid, true, JSON.stringify(loaded.problems));
    assert.equal(loaded.amountFallbackColumn, 'F');

    // セクション見出しの規則も同じ経路で往復すること。
    gas.call('installCardFormat', [{
      formatId: 'section_probe', formatName: 'セクション見出しの確認', fileTypes: ['xlsx'],
      keywordRule: {allOf: [{maxRow: 1, keywords: ['利用日'], minMatch: 1}]},
      headerRow: 1, dataStartRow: 2,
      dateColumn: 'A', merchantColumn: 'B', amountColumn: 'C', purposeColumn: 'H',
      sectionBreakRule: {patterns: ['分割・ボーナス払い明細']},
      parserKind: 'generic', version: 1, revisionReason: 'NEW'
    }]);
    const withSection = plain(gas.call('loadFormatDefinitions',
      [{formatId: 'section_probe', enabled: true}]))[0];
    assert.equal(withSection.valid, true, JSON.stringify(withSection.problems));
    assert.deepEqual(withSection.sectionBreakRule, {patterns: ['分割・ボーナス払い明細']});

    // 宣言しない形式では null のままで、既定の挙動を変えない。
    gas.call('installCardFormat', [{
      formatId: 'no_fallback_probe', formatName: '予備列なし', fileTypes: ['xlsx'],
      keywordRule: {allOf: [{maxRow: 1, keywords: ['利用日'], minMatch: 1}]},
      headerRow: 1, dataStartRow: 2,
      dateColumn: 'A', merchantColumn: 'B', amountColumn: 'C', purposeColumn: 'H',
      parserKind: 'generic', version: 1, revisionReason: 'NEW'
    }]);
    const plainFormat = plain(gas.call('loadFormatDefinitions',
      [{formatId: 'no_fallback_probe', enabled: true}]))[0];
    assert.equal(plainFormat.amountFallbackColumn, null);
  });

  test('runImport reloads Script Properties itself (a fresh GAS execution has default SETTINGS)', () => {
    setup();
    gas.call('registerTestCustomer', [CUSTOMER]);
    // GASの実行はグローバルを保持しない。保存済みプロパティだけがある状態を作る。
    gas.call('saveInstallationProperties', [{
      EXECUTION_TIMEOUT_SECONDS: '300',
      TX_INDEX_SPREADSHEET_ID: 'txidx',
      SNAPSHOT_SPREADSHEET_ID: 'snap',
      SAMPLE_CORPUS_FOLDER_ID: 'corpus'
    }]);
    gas.evaluate(`
      SETTINGS.EXECUTION_TIMEOUT_SECONDS = null;
      SETTINGS.TX_INDEX_SPREADSHEET_ID = '';
      SETTINGS.SNAPSHOT_SPREADSHEET_ID = '';
      SETTINGS.SAMPLE_CORPUS_FOLDER_ID = '';
    `);
    gas.stubs.createFolder('folder1', {fileIds: []});
    const report = plain(gas.call('runImport', [{}]));
    assert.notEqual(report.stoppedBy, 'SETTINGS_INVALID',
      'the run must reload stored properties before validating settings');
  });

  test('4.38: a per-minute read-quota hit retries instead of failing the operation', () => {
    setup();
    gas.call('registerTestCustomer', [CUSTOMER]);
    gas.stubs.setSheetsBatchGetFailures([{code: 429, message: "Quota exceeded for quota metric 'Read requests'"}]);
    const customer = plain(gas.call('getCustomerById', ['C001']));
    assert.equal(customer.customerId, 'C001',
      'a quota hit must wait for the minute window, not abort a multi-step operation');
  });

  test('A-30: a process-log field update writes only the named cells', () => {
    setup();
    gas.call('registerTestCustomer', [CUSTOMER]);
    const customer = gas.call('getCustomerById', ['C001']);
    gas.call('createOrUpdateProcessLog', ['RUN_X', customer, {
      id: 'fileX', name: 'x.csv', binaryHash: 'b'.repeat(64), state: 'VALIDATING'
    }]);
    gas.stubs.resetApiCallCounts();
    gas.call('updateProcessLog', ['fileX', {endedAt: '2026-09-02T00:00:00+09:00'}]);
    assert.equal(gas.stubs.getApiCallCounts().cellsWritten, 1,
      'a whole-row write-back would restore stale values into unrelated columns ' +
      '(the SpreadsheetApp read cache lags Sheets API writes on the real machine)');

    // 状態遷移は処理ログ1セル＋恒久インデックスの状態・更新日時の計3セル
    gas.stubs.resetApiCallCounts();
    gas.call('updateProcessLog', ['fileX', {internalState: 'REVIEW_WAIT'}]);
    assert.equal(gas.stubs.getApiCallCounts().cellsWritten, 3);
  });

  test('opsRetryDestinationFix resolves the review and rewinds the file to DISCOVERED', () => {
    setup();
    gas.call('registerTestCustomer', [CUSTOMER]);
    const customer = gas.call('getCustomerById', ['C001']);
    gas.call('createOrUpdateProcessLog', ['RUN_Y', customer, {
      id: 'fileY', name: 'y.csv', binaryHash: 'b'.repeat(64), state: 'REVIEW_WAIT'
    }]);
    gas.call('registerReview', [{
      reviewType: 'DESTINATION_FIX', fileId: 'fileY',
      customerId: 'C001', customerName: 'テスト顧客', fileNameOriginal: 'y.csv'
    }]);

    const results = plain(gas.call('opsRetryDestinationFix', []));
    assert.equal(results.length, 1);
    const reviews = plain(gas.call('openReviews', [{}]));
    assert.equal(reviews.filter((r) => r.reviewType === 'DESTINATION_FIX').length, 0,
      'the review must be settled, not left open');
    const record = gas.call('getProcessLogRecord_', ['fileY']);
    assert.equal(String(record.values[16]), 'DISCOVERED',
      'the file must be rediscoverable by the next run');
  });

  test('opsRetryFailedFiles rewinds only FAILED files to DISCOVERED', () => {
    setup();
    gas.call('registerTestCustomer', [CUSTOMER]);
    const customer = gas.call('getCustomerById', ['C001']);
    gas.call('createOrUpdateProcessLog', ['RUN_Z', customer, {
      id: 'fileZ1', name: 'z1.csv', binaryHash: 'b'.repeat(64), state: 'FAILED'
    }]);
    gas.call('createOrUpdateProcessLog', ['RUN_Z', customer, {
      id: 'fileZ2', name: 'z2.csv', binaryHash: 'b'.repeat(64), state: 'COMPLETED'
    }]);
    const retried = plain(gas.call('opsRetryFailedFiles', []));
    assert.deepEqual(retried, ['fileZ1']);
    assert.equal(String(gas.call('getProcessLogRecord_', ['fileZ2']).values[16]), 'COMPLETED',
      'a completed file must never be rewound');
  });

  test('opsRetryCustomerFixFiles rewinds only CUSTOMER_FIX_REQUIRED files', () => {
    // 区分1の差し戻しは、元ファイルの直しだけでなく**こちら側の形式定義の
    // 欠陥**でも起きる（イオン系の第2セクションを取引行として読んでいた）。
    // 直したあと、そのファイルを取込へ戻す手段が要る。
    setup();
    gas.call('registerTestCustomer', [CUSTOMER]);
    const customer = gas.call('getCustomerById', ['C001']);
    gas.call('createOrUpdateProcessLog', ['RUN_C', customer, {
      id: 'fixMe', name: 'aeon.xlsx', binaryHash: 'b'.repeat(64),
      state: 'CUSTOMER_FIX_REQUIRED'
    }]);
    gas.call('createOrUpdateProcessLog', ['RUN_C', customer, {
      id: 'doneAlready', name: 'done.xlsx', binaryHash: 'b'.repeat(64), state: 'COMPLETED'
    }]);
    gas.call('createOrUpdateProcessLog', ['RUN_C', customer, {
      id: 'waiting', name: 'wait.xlsx', binaryHash: 'b'.repeat(64), state: 'REVIEW_WAIT'
    }]);

    const retried = plain(gas.call('opsRetryCustomerFixFiles', []));
    assert.deepEqual(retried, ['fixMe']);
    assert.equal(String(gas.call('getProcessLogRecord_', ['fixMe']).values[16]), 'DISCOVERED');
    assert.equal(String(gas.call('getProcessLogRecord_', ['doneAlready']).values[16]),
      'COMPLETED', '完了したファイルを巻き戻さない');
    assert.equal(String(gas.call('getProcessLogRecord_', ['waiting']).values[16]),
      'REVIEW_WAIT', '人が判断中のファイルを巻き戻さない');
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

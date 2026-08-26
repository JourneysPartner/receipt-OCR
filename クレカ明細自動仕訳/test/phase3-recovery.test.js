'use strict';

/**
 * フェーズ3：仕様11.3の部分失敗からの回復（4.23 Step0〜6）と、
 * 4.24の整合性チェック。
 *
 * 期待値は設計書の Step 表から取っている。実装の出力から作っていない。
 */
module.exports = ({test, assert, gas}) => {
  const names = {
    customer: '顧客マスター', commonList: '共通取引先一覧', commonDict: '共通取引先辞書',
    customerDict: '顧客別取引先辞書', process: 'クレカ処理ログ', transaction: 'クレカ取引ログ',
    audit: '監査ログ', lease: '処理リース', fileIndex: '恒久ファイルインデックス'
  };
  const blank = (n) => Array(n).fill('');
  const sheetHeader = (n, label) => { const r = blank(n); r[0] = label; return r; };

  function customerRow() {
    const row = blank(37);
    Object.assign(row, {
      0: 'C001', 1: '顧客A', 2: 'TRUE', 3: 'folder1', 5: 'dest1', 7: '入力用シート', 8: '取引先一覧',
      9: 2, 10: 6, 11: 9, 12: 11, 13: 13, 14: 30, 15: '1.0',
      16: 'reviewer@example.com', 17: 'admin@example.com', 18: 0, 20: 'システム情報', 21: 'ACTIVE',
      23: 0, 24: 0, 29: 1, 30: JSON.stringify({B: '利用日'}), 31: '{}', 32: '{}', 33: 30,
      34: '取引先一覧', 35: 'CORPORATE', 36: ''
    });
    return row;
  }

  /** 転記先の1行を作る。txId のみ入れると「行予約だけ済んだ」状態になる。 */
  function destRow(overrides = {}) {
    const row = blank(30);
    if (overrides.b !== undefined) row[1] = overrides.b;
    if (overrides.f !== undefined) row[5] = overrides.f;
    if (overrides.i !== undefined) row[8] = overrides.i;
    if (overrides.k !== undefined) row[10] = overrides.k;
    if (overrides.m !== undefined) row[12] = overrides.m;
    if (overrides.txId !== undefined) row[29] = overrides.txId;
    return row;
  }

  function setup(destRows) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: names.customer, values: [sheetHeader(37, '顧客ID'), customerRow()]},
      {name: names.commonList, values: [sheetHeader(6, '取引先ID')]},
      {name: names.commonDict, values: [sheetHeader(18, '辞書ID')]},
      {name: names.customerDict, values: [sheetHeader(18, '辞書ID')]},
      {name: names.process, values: [sheetHeader(40, '実行ID')]},
      {name: names.transaction, values: [sheetHeader(45, '取引ID完全値')]},
      {name: names.audit, values: [sheetHeader(15, '監査ID')]},
      {name: names.lease, values: [sheetHeader(10, 'リースID')]},
      {name: names.fileIndex, values: [sheetHeader(13, 'ファイルID')]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');

    const header = blank(30);
    header[1] = '利用日'; header[5] = '取引先'; header[8] = '用途';
    header[10] = '元店名'; header[12] = '金額'; header[29] = '内部ID';
    const rows = [header].concat(destRows);
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート', values: rows, formulas: rows.map(() => blank(30)),
       maxRows: rows.length, maxColumns: 30},
      {name: '取引先一覧', values: [['取引先']]}
    ]});
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createFile('file1', {name: '明細.csv', data: 'a,b'});
    gas.stubs.createFolder('folder1', {fileIds: ['file1']});
    gas.evaluate("SETTINGS.TX_INDEX_SPREADSHEET_ID='txidx'; SETTINGS.DESTINATION_INDEX_MAX_ROWS=50000;");

    const customer = gas.call('getCustomerById', ['C001']);
    gas.call('createOrUpdateProcessLog', ['RUN_1', customer, {
      id: 'file1', name: '明細.csv', binaryHash: 'b'.repeat(64),
      contentHash: 'c'.repeat(64), hashVersion: '3', state: 'WRITING'
    }]);
    return customer;
  }

  function registerTx(id, status) {
    gas.call('registerPrepared', [[{
      fullTxId: id, displayTxId: id.slice(0, 8), customerId: 'C001', fileId: 'file1',
      sourceRow: 2, formatId: 'dcard', plannedFinalStatus: 'COMMITTED',
      partnerResolutionStatus: 'RESOLVED_WITH_PARTNER',
      originalDate: '2026-01-02', originalMerchant: '店舗', originalAmount: 1000,
      originalPurpose: '仕入れ',
      planned: {b: '2026-01-02', f: '株式会社テスト', i: '仕入れ', k: '店舗', m: 1000},
      identityHash: 'd'.repeat(64), contentHash: 'c'.repeat(64), occurrenceIndex: 0,
      transactionIdVersion: '2', hashVersion: '3'
    }], 'RUN_1']);
    if (status && status !== 'PREPARED') {
      gas.call('updateTransactionStatus', [id, 'PREPARED', status]);
    }
  }

  const PLANNED = {b: '2026-01-02', f: '株式会社テスト', i: '仕入れ', k: '店舗', m: 1000};

  // ---- Step 3：行が1行、値が予定値と一致 → 追記せずK列の状態へ補正 ----
  test('11.3 Step3: a matching reserved row is confirmed without appending a new row', () => {
    const customer = setup([destRow(Object.assign({txId: 'TX_A'}, PLANNED))]);
    registerTx('TX_A', 'WRITING');
    const leaseId = gas.call('acquireLease', ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);
    const index = gas.call('buildIndex', [customer]);
    const before = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート').getMaxRows();

    const result = gas.call('recoverPartialFailure',
      ['file1', 'RUN_1', index, leaseId, {customer}]);

    assert.equal(result.recovered.length, 1);
    assert.equal(result.recovered[0].step, 3);
    assert.equal(gas.call('getTransaction', ['TX_A']).transactionStatus, 'COMMITTED');
    assert.equal(gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート').getMaxRows(), before,
      'Step3 must not append a row');

    // INV-01：回復した取引は読取確認値を持たなければならない。
    // 空のまま COMMITTED にすると、次回の 4.24 検査3 が「予定値あり・
    // 読取確認値なし」を手動変更と誤検知し、処理開始前に全件停止する。
    const recovered = gas.call('getTransaction', ['TX_A']);
    assert.equal(recovered.verified.b, PLANNED.b,
      'Step3 must record the read-back values, or the next integrity check halts everything');
    assert.equal(recovered.verified.m, PLANNED.m);
  });

  // ---- 回復した取引が、次回の整合性チェックを通ること ----
  test('11.3 Step3: a recovered transaction does not look like a manual change afterwards', () => {
    const customer = setup([destRow(Object.assign({txId: 'TX_A'}, PLANNED))]);
    registerTx('TX_A', 'WRITING');
    const leaseId = gas.call('acquireLease', ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);
    gas.call('recoverPartialFailure',
      ['file1', 'RUN_1', gas.call('buildIndex', [customer]), leaseId, {customer}]);

    const txLogs = gas.call('getTransactionsByStatus', ['file1', ['COMMITTED']]);
    assert.equal(txLogs.length, 1, 'the recovered transaction must be COMMITTED');
    const report = gas.call('runIntegrityCheck', [{
      index: gas.call('buildIndex', [customer]), txLogs, fileState: 'WRITING'
    }]);

    const manual = report.findings.filter((f) => f.check === 'MANUAL_CHANGE');
    assert.equal(manual.length, 0,
      'the recovered row must not be reported as manually edited');
  });

  // ---- Step 4：行が1行、値が不一致（行予約のみ）→ 同じ行へ書き直す ----
  test('11.3 Step4: a reserved-but-unwritten row is filled in place, not appended', () => {
    const customer = setup([destRow({txId: 'TX_B'})]);   // 取引ID列だけ入っている
    registerTx('TX_B', 'WRITING');
    const leaseId = gas.call('acquireLease', ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);
    const index = gas.call('buildIndex', [customer]);
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    const before = sheet.getMaxRows();

    const result = gas.call('recoverPartialFailure',
      ['file1', 'RUN_1', index, leaseId, {customer}]);

    assert.equal(result.recovered[0].step, 4);
    assert.equal(result.recovered[0].rowNumber, 2, 'must reuse the reserved row');
    assert.equal(sheet.getMaxRows(), before, 'Step4 must not append a row');
    assert.equal(sheet.getRange(2, 2).getValue(), '2026-01-02');
    assert.equal(sheet.getRange(2, 13).getValue(), 1000);
    assert.equal(gas.call('getTransaction', ['TX_B']).transactionStatus, 'COMMITTED');
  });

  // ---- Step 5：行が存在しない → リースを確認して確保し、行番号を記録 ----
  test('11.3 Step5: a missing row is reserved, written, verified, and its location recorded', () => {
    const customer = setup([destRow(), destRow()]);   // 空き行のみ
    registerTx('TX_C', 'PREPARED');
    const leaseId = gas.call('acquireLease', ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);
    const index = gas.call('buildIndex', [customer]);

    const result = gas.call('recoverPartialFailure',
      ['file1', 'RUN_1', index, leaseId, {customer}]);

    assert.equal(result.recovered[0].step, 5);
    const tx = gas.call('getTransaction', ['TX_C']);
    assert.equal(tx.transactionStatus, 'COMMITTED');
    assert.equal(Number(tx.destinationRow), result.recovered[0].rowNumber,
      'destination row number must be recorded');
  });

  // ---- Step 6：同一取引IDが2行以上 → 自動修復せず停止 ----
  test('11.3 Step6: two rows holding the same transaction id stop instead of self-repairing', () => {
    const customer = setup([
      destRow(Object.assign({txId: 'TX_D'}, PLANNED)),
      destRow(Object.assign({txId: 'TX_D'}, PLANNED))
    ]);
    registerTx('TX_D', 'WRITING');
    const leaseId = gas.call('acquireLease', ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);
    const index = gas.call('buildIndex', [customer]);

    assert.throws(() => gas.call('recoverPartialFailure',
      ['file1', 'RUN_1', index, leaseId, {customer}]),
      (error) => error && error.code === 'TRANSACTION_ID_COLLISION',
      'the duplicate-row collision must be what stops it');
    assert.equal(gas.call('getTransaction', ['TX_D']).transactionStatus, 'WRITING',
      'status must not advance when the collision is detected');
  });

  // ---- Step 0：ファイルが変わっていたら回復しない（M17） ----
  test('11.3 Step0: a changed source file blocks recovery instead of writing stale values', () => {
    const customer = setup([destRow({txId: 'TX_E'})]);
    registerTx('TX_E', 'WRITING');
    const leaseId = gas.call('acquireLease', ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);
    const index = gas.call('buildIndex', [customer]);
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');

    const result = gas.call('recoverPartialFailure',
      ['file1', 'RUN_1', index, leaseId, {customer, fileGuard: {unchanged: false}}]);

    assert.equal(result.fileChanged, true);
    assert.equal(result.stopped.code, 'FILE_CHANGED');
    assert.equal(result.recovered.length, 0);
    assert.equal(sheet.getRange(2, 2).getValue(), '', 'no value may be written when the file changed');
    assert.equal(gas.call('getTransaction', ['TX_E']).transactionStatus, 'WRITING');
  });

  // ---- Step 1：COMMITTED は回復の対象外（4.24 検査3が扱う） ----
  test('11.3 Step1: COMMITTED transactions are not touched by recovery', () => {
    const customer = setup([destRow(Object.assign({txId: 'TX_F'}, PLANNED))]);
    registerTx('TX_F', 'WRITING');
    gas.call('updateTransactionStatus', ['TX_F', 'WRITING', 'COMMITTED']);
    const leaseId = gas.call('acquireLease', ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);
    const index = gas.call('buildIndex', [customer]);

    const result = gas.call('recoverPartialFailure',
      ['file1', 'RUN_1', index, leaseId, {customer}]);

    assert.equal(result.recovered.length, 0,
      'recovery targets only PREPARED and WRITING (INV-03)');
  });

  // ---- 4.24 検査3：COMMITTED の値ずれを手動変更として検出する ----
  test('4.24: a COMMITTED row whose value drifted is reported as a manual change', () => {
    const customer = setup([destRow(Object.assign({txId: 'TX_G'}, PLANNED))]);
    registerTx('TX_G', 'WRITING');
    const leaseId = gas.call('acquireLease', ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);
    gas.call('updateWrittenValues', ['TX_G', PLANNED, PLANNED]);
    gas.call('updateTransactionStatus', ['TX_G', 'WRITING', 'COMMITTED']);

    // 人がF列を書き換えた状況を作る
    gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート')
      .getRange(2, 6).setValue('別の取引先');

    const index = gas.call('buildIndex', [customer]);
    const txLogs = gas.call('getTransactionsByStatus', ['file1', ['COMMITTED']]);
    const report = gas.call('runIntegrityCheck', [{index, txLogs, fileState: 'WRITING'}]);

    assert.equal(report.ok, false);
    const manual = report.findings.filter((f) => f.check === 'MANUAL_CHANGE');
    assert.equal(manual.length, 1);
    assert.equal(manual[0].detail.column, 'f');
  });

  // ---- 4.24 検査5：INV-05 の食い違いを検出する ----
  test('4.24: a process-log / permanent-index state mismatch is a stopping finding (INV-05)', () => {
    const customer = setup([destRow()]);
    const index = gas.call('buildIndex', [customer]);
    const report = gas.call('runIntegrityCheck', [{
      index, txLogs: [], fileState: 'WRITING',
      processLogState: 'COMPLETED', permanentIndexState: 'WRITING'
    }]);
    assert.equal(report.stop, true);
    assert.equal(report.findings[0].check, 'PERMANENT_INDEX_DESYNC');
  });
};

'use strict';

/**
 * フェーズ3：6.1 の再合流規律。
 *
 *   step 8-13「再合流時の取引再登録」（A-28）
 *   step 9-8「再合流時の要確認再登録」（Ver.2.5・指摘4）
 *
 * どちらも「まだ確定していない取引だけを更新し、確定済みの取引には触れない」
 * という同じ規律である。破ると、再合流のたびに決着済みの取引が覆されるか、
 * 決着済みの取引へ要確認が立て直されて取込が止まる。
 */
module.exports = ({test, assert, gas}) => {
  const names = {
    customer: '顧客マスター', commonList: '共通取引先一覧', commonDict: '共通取引先辞書',
    customerDict: '顧客別取引先辞書', process: 'クレカ処理ログ', transaction: 'クレカ取引ログ',
    audit: '監査ログ', lease: '処理リース', fileIndex: '恒久ファイルインデックス', review: '要確認'
  };
  const blank = (n) => Array(n).fill('');
  const sheetHeader = (n, label) => { const r = blank(n); r[0] = label; return r; };
  const plain = (v) => JSON.parse(JSON.stringify(v));

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

  function setup() {
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
      {name: names.fileIndex, values: [sheetHeader(13, 'ファイルID')]},
      {name: names.review, values: [sheetHeader(31, '要確認ID')]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート', values: [blank(30), blank(30)], formulas: [blank(30), blank(30)],
       maxRows: 2, maxColumns: 30},
      {name: '取引先一覧', values: [['取引先']]}
    ]});
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createFile('file1', {name: '明細.csv', data: 'a,b'});
    gas.evaluate("SETTINGS.TX_INDEX_SPREADSHEET_ID='txidx';");
    const customer = gas.call('getCustomerById', ['C001']);
    gas.call('createOrUpdateProcessLog', ['RUN_1', customer, {
      id: 'file1', name: '明細.csv', binaryHash: 'b'.repeat(64),
      contentHash: 'c'.repeat(64), hashVersion: '3', state: 'VALIDATING'
    }]);
    return customer;
  }

  /** merchant を変えて「今回の解析結果」を作れるようにする。 */
  function tx(id, merchant, runId) {
    return {
      fullTxId: id, displayTxId: id.slice(0, 8), customerId: 'C001', fileId: 'file1',
      sourceRow: 2, formatId: 'dcard', plannedFinalStatus: 'COMMITTED',
      partnerResolutionStatus: 'RESOLVED_WITH_PARTNER',
      originalDate: '2026-01-02', originalMerchant: merchant, originalAmount: 1000,
      originalPurpose: '仕入れ',
      planned: {b: '2026-01-02', f: '株式会社テスト', i: '仕入れ', k: merchant, m: 1000},
      identityHash: 'd'.repeat(64), contentHash: 'c'.repeat(64), occurrenceIndex: 0,
      transactionIdVersion: '2', hashVersion: '3'
    };
  }

  function txRowCount() {
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName(names.transaction);
    return sheet.getLastRow() - 1;   // ヘッダーを除く
  }

  // ---- 行が存在しない → 新規登録 ----
  test('8-13: a transaction with no existing row is registered as PREPARED', () => {
    setup();
    gas.call('registerPrepared', [[tx('TX_A', '店舗')], 'RUN_1']);
    assert.equal(txRowCount(), 1);
    assert.equal(gas.call('getTransaction', ['TX_A']).transactionStatus, 'PREPARED');
  });

  // ---- PREPARED / WRITING → 既存行を更新（行を増やさない・状態は据え置き） ----
  ['PREPARED', 'WRITING'].forEach((status) => {
    test(`8-13: a ${status} row is updated in place, keeping its status`, () => {
      setup();
      gas.call('registerPrepared', [[tx('TX_B', '旧店舗')], 'RUN_1']);
      if (status !== 'PREPARED') {
        gas.call('updateTransactionStatus', ['TX_B', 'PREPARED', status]);
      }

      gas.call('registerPrepared', [[tx('TX_B', '新店舗')], 'RUN_2']);

      assert.equal(txRowCount(), 1, 'a re-entry must not add a row');
      const after = gas.call('getTransaction', ['TX_B']);
      assert.equal(after.transactionStatus, status, 'the status is left as it was');
      assert.equal(after.originalMerchant, '新店舗',
        'original and planned values are overwritten by this run');
    });
  });

  // ---- REVIEW_REQUIRED → 更新するが、開いている要確認は維持する ----
  test('8-13: a REVIEW_REQUIRED row is updated while its open reviews survive', () => {
    setup();
    gas.call('registerPrepared', [[tx('TX_C', '旧店舗')], 'RUN_1']);
    gas.call('updateTransactionStatus', ['TX_C', 'PREPARED', 'REVIEW_REQUIRED']);
    gas.call('registerReview',
      [{reviewType: 'PARTNER', fullTxId: 'TX_C', fileId: 'file1', customerId: 'C001'}]);

    gas.call('registerPrepared', [[tx('TX_C', '新店舗')], 'RUN_2']);

    assert.equal(txRowCount(), 1);
    assert.equal(gas.call('getTransaction', ['TX_C']).transactionStatus, 'REVIEW_REQUIRED');
    assert.equal(gas.call('getTransaction', ['TX_C']).originalMerchant, '新店舗');
    assert.equal(gas.call('openReviews', [{fullTxId: 'TX_C'}]).length, 1,
      'the open review must survive the re-entry');
  });

  // ---- COMMITTED → 更新も再登録もしない ----
  test('8-13: a COMMITTED row is neither updated nor re-registered', () => {
    setup();
    gas.call('registerPrepared', [[tx('TX_D', '旧店舗')], 'RUN_1']);
    gas.call('updateTransactionStatus', ['TX_D', 'PREPARED', 'COMMITTED']);

    gas.call('registerPrepared', [[tx('TX_D', '新店舗')], 'RUN_2']);

    assert.equal(txRowCount(), 1, 'no duplicate row');
    const after = gas.call('getTransaction', ['TX_D']);
    assert.equal(after.transactionStatus, 'COMMITTED');
    assert.equal(after.originalMerchant, '旧店舗',
      'a settled transaction must not be overwritten by re-analysis');
  });

  // ---- CANCELED / DELETED_ACCEPTED → 復活させない ----
  ['CANCELED', 'DELETED_ACCEPTED'].forEach((status) => {
    test(`8-13: a ${status} row is not revived by a re-entry`, () => {
      setup();
      gas.call('registerPrepared', [[tx('TX_E', '旧店舗')], 'RUN_1']);
      gas.call('updateTransactionStatus', ['TX_E', 'PREPARED', 'COMMITTED']);
      gas.call('updateTransactionStatus', ['TX_E', 'COMMITTED', status]);

      gas.call('registerPrepared', [[tx('TX_E', '新店舗')], 'RUN_2']);

      assert.equal(txRowCount(), 1);
      assert.equal(gas.call('getTransaction', ['TX_E']).transactionStatus, status,
        'a terminal state is not revived');
    });
  });

  // ---- 9-8：決着済みの取引へ要確認を立て直さない ----
  test('9-8: transaction-scoped reviews are not re-registered onto settled transactions', () => {
    setup();
    gas.call('registerPrepared', [[tx('TX_F', '店舗'), tx('TX_G', '店舗')], 'RUN_1']);
    gas.call('updateTransactionStatus', ['TX_F', 'PREPARED', 'COMMITTED']);
    gas.call('updateTransactionStatus', ['TX_G', 'PREPARED', 'REVIEW_REQUIRED']);

    const result = gas.call('registerPendingReviews', [[
      {reviewType: 'PARTNER', fullTxId: 'TX_F', fileId: 'file1', customerId: 'C001'},
      {reviewType: 'PARTNER', fullTxId: 'TX_G', fileId: 'file1', customerId: 'C001'}
    ]]);

    const registered = plain(result.registered);
    const skipped = plain(result.skipped);
    assert.equal(registered.length, 1, 'only the unsettled transaction gets a review');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].fullTxId, 'TX_F');
    assert.equal(skipped[0].reason, 'TRANSACTION_ALREADY_SETTLED');
    assert.equal(gas.call('openReviews', [{fullTxId: 'TX_F'}]).length, 0);
    assert.equal(gas.call('openReviews', [{fullTxId: 'TX_G'}]).length, 1);
  });

  // ---- 9-8：ファイル単位の種別は取引状態で絞らない ----
  test('9-8: file-scoped reviews are registered regardless of transaction states', () => {
    setup();
    const result = gas.call('registerPendingReviews', [[
      {reviewType: 'COUNT_TOTAL_MISMATCH', fileId: 'file1', customerId: 'C001'}
    ]]);
    assert.equal(plain(result.registered).length, 1);
  });
};

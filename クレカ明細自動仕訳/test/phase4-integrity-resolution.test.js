'use strict';

/**
 * 4.29 手動変更・削除・freee側修正への対処（仕様16.3・17.1・17.2）。
 *
 * 転記先は顧客のfreee出納帳であり、担当者が手で直すことがある。それ自体は
 * 正当な運用で、システムが勝手に上書きしてはならない。採用するか戻すかは
 * 人が決め、決めた結果は次回の検査に反映されなければならない。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const names = {
    customer: '顧客マスター', commonList: '共通取引先一覧', commonDict: '共通取引先辞書',
    customerDict: '顧客別取引先辞書', process: 'クレカ処理ログ', transaction: 'クレカ取引ログ',
    audit: '監査ログ', lease: '処理リース', fileIndex: '恒久ファイルインデックス', review: '要確認'
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

  const PLANNED = {b: '2026-01-02', f: '株式会社テスト', i: '仕入れ', k: '店舗', m: 1000};

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
      {name: names.review, values: [sheetHeader(32, '要確認ID')]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');

    const header = blank(30);
    header[1] = '利用日'; header[5] = '取引先'; header[8] = '用途';
    header[10] = '元店名'; header[12] = '金額'; header[29] = '内部ID';
    const rows = [header, blank(30), blank(30), blank(30)];
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート', values: rows, formulas: rows.map(() => blank(30)),
       maxRows: 4, maxColumns: 30},
      {name: '取引先一覧', values: [['取引先']]}
    ]});
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createFile('file1', {name: '明細.csv', data: 'a,b'});
    gas.evaluate("SETTINGS.TX_INDEX_SPREADSHEET_ID='txidx';");
    gas.stubs.setActiveUser('reviewer@example.com');

    const customer = gas.call('getCustomerById', ['C001']);
    gas.call('createOrUpdateProcessLog', ['RUN_1', customer, {
      id: 'file1', name: '明細.csv', binaryHash: 'b'.repeat(64),
      contentHash: 'c'.repeat(64), hashVersion: '3', state: 'WRITING'
    }]);
    return customer;
  }

  /** 転記済み・確定済みの取引を行2に作る。 */
  function committed(id) {
    gas.call('registerPrepared', [[{
      fullTxId: id, displayTxId: id.slice(0, 8), customerId: 'C001', fileId: 'file1',
      sourceRow: 2, formatId: 'dcard', plannedFinalStatus: 'COMMITTED',
      partnerResolutionStatus: 'RESOLVED_WITH_PARTNER',
      originalDate: '2026-01-02', originalMerchant: '店舗', originalAmount: 1000,
      originalPurpose: '仕入れ', planned: PLANNED,
      identityHash: 'd'.repeat(64), contentHash: 'c'.repeat(64), occurrenceIndex: 0,
      transactionIdVersion: '2', hashVersion: '3'
    }], 'RUN_1']);
    gas.call('updateTransactionLocation', [id, 2]);
    gas.call('updateWrittenValues', [id, PLANNED, PLANNED]);
    gas.call('updateTransactionStatus', [id, 'PREPARED', 'COMMITTED']);

    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    sheet.getRange(2, 30).setValue(id);
    sheet.getRange(2, 2).setValue(PLANNED.b);
    sheet.getRange(2, 6).setValue(PLANNED.f);
    sheet.getRange(2, 9).setValue(PLANNED.i);
    sheet.getRange(2, 11).setValue(PLANNED.k);
    sheet.getRange(2, 13).setValue(PLANNED.m);
    return sheet;
  }

  const integrityReview = (txId) => gas.call('registerReview', [{
    reviewType: 'INTEGRITY', fullTxId: txId, displayTxId: txId.slice(0, 8),
    fileId: 'file1', customerId: 'C001', customerName: '顧客A',
    destinationRow: 2, destinationSpreadsheetId: 'dest1', destinationSheetName: '入力用シート'
  }]).reviewId;

  /** 4.24 検査3を走らせて手動変更が残っているかを見る。 */
  function manualChangeFindings(customer) {
    const txLogs = gas.call('getTransactionsByStatus', ['file1', ['COMMITTED']]);
    const report = gas.call('runIntegrityCheck', [{
      index: gas.call('buildIndex', [customer]), txLogs, fileState: 'WRITING'
    }]);
    return report.findings.filter((f) => f.check === 'MANUAL_CHANGE');
  }

  // ================= 提示する操作 =================

  test('4.26: an INTEGRITY review has a terminal escape like every other type', () => {
    setup();
    const ops = plain(gas.call('availableIntegrityOperations', []));
    assert.ok(ops.indexOf('EXCLUDE') >= 0, 'INV-31 applies to INTEGRITY too');
    assert.ok(ops.indexOf('ACCEPT_MANUAL_CHANGE') >= 0);
    assert.ok(ops.indexOf('REVERT_TO_SYSTEM_VALUE') >= 0);
  });

  // ================= 手動変更の採用 =================

  test('17.2: accepting a manual change stops it being reported again', () => {
    const customer = setup();
    const sheet = committed('TX_1');
    sheet.getRange(2, 6).setValue('別の取引先');      // 担当者が手で直した

    assert.equal(manualChangeFindings(customer).length, 1, 'the drift must be detected first');

    gas.call('acceptManualChange', ['TX_1', 'reviewer@example.com', {customer}]);

    assert.equal(manualChangeFindings(customer).length, 0,
      'accepting must update both planned and verified, or it is detected forever');
    const tx = gas.call('getTransaction', ['TX_1']);
    assert.equal(tx.planned.f, '別の取引先');
    assert.equal(tx.verified.f, '別の取引先');
  });

  test('17.2: accepting does not write back to the destination', () => {
    const customer = setup();
    const sheet = committed('TX_1');
    sheet.getRange(2, 6).setValue('別の取引先');
    gas.call('acceptManualChange', ['TX_1', 'reviewer@example.com', {customer}]);
    assert.equal(sheet.getRange(2, 6).getValue(), '別の取引先',
      'the reviewer value was accepted as correct - overwriting it would undo their work');
  });

  // ---- 仕様16.3：freee取込済みの取引を変えたら、freee側を直す必要が残る ----
  test('16.3: accepting a change on an imported transaction flags freee for fixing', () => {
    const customer = setup();
    const sheet = committed('TX_1');
    gas.call('updateFreeeStatus', ['TX_1', 'NOT_IMPORTED', 'IMPORTED', 'BATCH_1']);
    sheet.getRange(2, 13).setValue(2500);

    const result = plain(gas.call('acceptManualChange',
      ['TX_1', 'reviewer@example.com', {customer}]));

    assert.equal(result.freeeWarning, 'NEEDS_FREEE_FIX');
    assert.equal(gas.call('getTransaction', ['TX_1']).freeeStatus, 'NEEDS_FREEE_FIX',
      'freee still holds the old amount and the system cannot change it');
  });

  test('16.3: a transaction not yet imported needs no freee warning', () => {
    const customer = setup();
    const sheet = committed('TX_1');
    sheet.getRange(2, 13).setValue(2500);
    const result = plain(gas.call('acceptManualChange',
      ['TX_1', 'reviewer@example.com', {customer}]));
    assert.equal(result.freeeWarning, null);
  });

  test('17.2: only a committed transaction can have a manual change accepted', () => {
    setup();
    gas.call('registerPrepared', [[{
      fullTxId: 'TX_P', displayTxId: 'TX_P', customerId: 'C001', fileId: 'file1',
      sourceRow: 2, formatId: 'dcard', plannedFinalStatus: 'COMMITTED',
      partnerResolutionStatus: 'RESOLVED_WITH_PARTNER',
      originalDate: '2026-01-02', originalMerchant: '店舗', originalAmount: 1000,
      originalPurpose: '仕入れ', planned: PLANNED,
      identityHash: 'd'.repeat(64), contentHash: 'c'.repeat(64), occurrenceIndex: 0,
      transactionIdVersion: '2', hashVersion: '3'
    }], 'RUN_1']);
    assert.throws(() => gas.call('acceptManualChange', ['TX_P', 'reviewer@example.com', {}]),
      (error) => error && /committed/.test(String(error.message)));
  });

  // ================= システム値へ戻す =================

  test('17.2: reverting writes the stored values back and verifies them', () => {
    const customer = setup();
    const sheet = committed('TX_1');
    sheet.getRange(2, 6).setValue('別の取引先');

    gas.call('revertManualChange', ['TX_1', 'reviewer@example.com', {customer, runId: 'RUN_1'}]);

    assert.equal(sheet.getRange(2, 6).getValue(), '株式会社テスト');
    assert.equal(manualChangeFindings(customer).length, 0,
      'reverting must also refresh the verified values, or the drift persists in the log');
  });

  test('17.2: reverting touches only the transaction it is asked about', () => {
    const customer = setup();
    const sheet = committed('TX_1');
    sheet.getRange(3, 6).setValue('無関係な行');
    sheet.getRange(2, 6).setValue('別の取引先');

    gas.call('revertManualChange', ['TX_1', 'reviewer@example.com', {customer, runId: 'RUN_1'}]);
    assert.equal(sheet.getRange(3, 6).getValue(), '無関係な行');
  });

  // ================= 削除の受入 =================

  test('17.1: accepting a deletion moves the transaction to a terminal state', () => {
    setup();
    committed('TX_1');
    const result = plain(gas.call('acceptDeletion', ['TX_1', 'reviewer@example.com', {}]));
    assert.equal(result.transactionStatus, 'DELETED_ACCEPTED');
    assert.equal(gas.call('getTransaction', ['TX_1']).transactionStatus, 'DELETED_ACCEPTED');
  });

  test('17.1: a deleted-accepted transaction does not block the file from completing', () => {
    setup();
    committed('TX_1');
    gas.call('acceptDeletion', ['TX_1', 'reviewer@example.com', {}]);
    assert.equal(gas.call('isFileFullyResolved', ['file1']), true);
  });

  // ================= 行の復元（オーナー管理者のみ） =================

  test('17.1: restoring a row requires the owner administrator role', () => {
    const customer = setup();
    committed('TX_1');
    assert.throws(() => gas.call('restoreRow',
      ['TX_1', 'reviewer@example.com', {customer, role: 'REVIEWER'}]),
      (error) => error && /owner administrator/.test(String(error.message)),
      'a restore makes a deleted row reappear in the customer ledger');
  });

  test('17.1: an owner can restore the row from the stored values', () => {
    const customer = setup();
    const sheet = committed('TX_1');
    // 担当者が行を消した状況
    sheet.getRange(2, 1, 1, 30).clearContent();

    const result = plain(gas.call('restoreRow', ['TX_1', 'admin@example.com',
      {customer, role: 'OWNER_ADMIN', runId: 'RUN_1'}]));

    const restored = Number(result.rowNumber);
    assert.equal(sheet.getRange(restored, 6).getValue(), '株式会社テスト');
    assert.equal(sheet.getRange(restored, 13).getValue(), 1000);
    assert.equal(gas.call('getTransaction', ['TX_1']).destinationRow, restored);
  });

  // ================= freee側の修正確認 =================

  test('4.26: confirming a freee fix returns the transaction to IMPORTED', () => {
    setup();
    committed('TX_1');
    gas.call('updateFreeeStatus', ['TX_1', 'NOT_IMPORTED', 'IMPORTED', 'BATCH_1']);
    gas.call('updateFreeeStatus', ['TX_1', 'IMPORTED', 'NEEDS_FREEE_FIX', 'BATCH_1']);

    const result = plain(gas.call('confirmFreeeFixed', ['TX_1', 'reviewer@example.com', {}]));
    assert.equal(result.freeeStatus, 'IMPORTED');
    assert.equal(gas.call('getTransaction', ['TX_1']).freeeStatus, 'IMPORTED');
  });

  test('4.26: confirming a freee fix on a transaction that never needed one is refused', () => {
    setup();
    committed('TX_1');
    gas.call('updateFreeeStatus', ['TX_1', 'NOT_IMPORTED', 'IMPORTED', 'BATCH_1']);
    assert.throws(() => gas.call('confirmFreeeFixed', ['TX_1', 'reviewer@example.com', {}]),
      (error) => error && /NEEDS_FREEE_FIX/.test(String(error.message)));
  });

  // ================= 要確認としての解決 =================

  test('4.26: resolving an INTEGRITY review by accepting re-evaluates the commit rule', () => {
    const customer = setup();
    const sheet = committed('TX_1');
    sheet.getRange(2, 6).setValue('別の取引先');
    const id = integrityReview('TX_1');

    const result = plain(gas.call('resolveIntegrityReview',
      [id, 'ACCEPT_MANUAL_CHANGE', {customer, actor: 'reviewer@example.com'}]));

    assert.equal(plain(gas.call('getReviewById', [id])).status, 'RESOLVED');
    assert.equal(result.outcome.accepted.f, '別の取引先');
    // 既に COMMITTED なので確定は起きない
    assert.equal(result.committed, false);
    assert.deepEqual(result.unmetConditions, ['NOT_REVIEW_REQUIRED']);
  });

  test('4.26: accepting a deletion through the review does not evaluate the commit rule', () => {
    setup();
    committed('TX_1');
    const id = integrityReview('TX_1');
    const result = plain(gas.call('resolveIntegrityReview',
      [id, 'ACCEPT_DELETION', {actor: 'reviewer@example.com'}]));
    assert.equal(result.committed, false);
    assert.deepEqual(result.openReviewTypes, [],
      'DELETED_ACCEPTED is terminal - there is nothing left to commit');
  });

  test('4.26: an unresolved integrity finding cannot be confirmed as resolved', () => {
    setup();
    committed('TX_1');
    const id = integrityReview('TX_1');
    assert.throws(() => gas.call('resolveIntegrityReview',
      [id, 'CONFIRM_INTEGRITY_RESOLVED', {recheck: {ok: false}}]),
      (error) => error && /still present/.test(String(error.message)),
      'closing it while the mismatch stands would hide the problem, not fix it');
  });

  test('4.26: a non-INTEGRITY review is not handled here', () => {
    setup();
    committed('TX_1');
    const id = gas.call('registerReview', [{
      reviewType: 'PARTNER', fullTxId: 'TX_1', fileId: 'file1', customerId: 'C001'
    }]).reviewId;
    assert.throws(() => gas.call('resolveIntegrityReview', [id, 'ACCEPT_MANUAL_CHANGE', {}]),
      (error) => error && /INTEGRITY/.test(String(error.message)));
  });
};

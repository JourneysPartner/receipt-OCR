'use strict';

/**
 * 4.26 解決操作（取引単位）。
 *
 * 確認担当者が要確認を片付ける経路そのものである。ここが無いと、
 * 転記はできても誰も要確認を解決できない。
 *
 * 固定する規律：
 *   INV-37  どの操作も無条件に COMMITTED にしない（CR-2 過剰確定）
 *   INV-40  日付が確定した時点で前年利用日を再判定する
 *   INV-31  どの種別にも終端へ至る経路が必ず1つある
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

  function customerRow(category, fiscalYear) {
    const row = blank(37);
    Object.assign(row, {
      0: 'C001', 1: '顧客A', 2: 'TRUE', 3: 'folder1', 5: 'dest1', 7: '入力用シート', 8: '取引先一覧',
      9: 2, 10: 6, 11: 9, 12: 11, 13: 13, 14: 30, 15: '1.0',
      16: 'reviewer@example.com', 17: 'admin@example.com', 18: 0, 20: 'システム情報', 21: 'ACTIVE',
      23: 0, 24: 0, 29: 1, 30: JSON.stringify({B: '利用日'}), 31: '{}', 32: '{}', 33: 30,
      34: '取引先一覧', 35: category || 'CORPORATE', 36: fiscalYear || ''
    });
    return row;
  }

  function setup(options = {}) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: names.customer, values: [sheetHeader(37, '顧客ID'),
        customerRow(options.customerCategory, options.fiscalYear)]},
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
    const rows = [header, blank(30), blank(30)];
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート', values: rows, formulas: rows.map(() => blank(30)),
       maxRows: 3, maxColumns: 30},
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

  /** 転記済みの取引を1件作り、行2へ書いた状態にする。 */
  function committedTx(id, options = {}) {
    const planned = {
      b: options.plannedB === undefined ? '2026-01-02' : options.plannedB,
      f: options.plannedF === undefined ? '' : options.plannedF,
      i: '仕入れ', k: '店舗', m: options.amount === undefined ? 1000 : options.amount
    };
    gas.call('registerPrepared', [[{
      fullTxId: id, displayTxId: id.slice(0, 8), customerId: 'C001', fileId: 'file1',
      sourceRow: 2, formatId: 'dcard', plannedFinalStatus: 'REVIEW_REQUIRED',
      partnerResolutionStatus: options.partnerStatus || 'UNRESOLVED',
      originalDate: '2026-01-02', originalMerchant: '店舗', originalAmount: planned.m,
      originalPurpose: '仕入れ', planned,
      identityHash: 'd'.repeat(64), contentHash: 'c'.repeat(64), occurrenceIndex: 0,
      transactionIdVersion: '2', hashVersion: '3'
    }], 'RUN_1']);
    gas.call('updateTransactionStatus', [id, 'PREPARED', 'REVIEW_REQUIRED']);
    gas.call('updateTransactionLocation', [id, 2]);
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    sheet.getRange(2, 30).setValue(id);
    if (planned.b) sheet.getRange(2, 2).setValue(planned.b);
    sheet.getRange(2, 6).setValue(planned.f);
    sheet.getRange(2, 9).setValue(planned.i);
    sheet.getRange(2, 11).setValue(planned.k);
    sheet.getRange(2, 13).setValue(planned.m);
    gas.call('updateWrittenValues', [id, planned, planned]);
    return planned;
  }

  const review = (type, txId, extra = {}) => gas.call('registerReview', [Object.assign({
    reviewType: type, fullTxId: txId, displayTxId: txId.slice(0, 8),
    fileId: 'file1', customerId: 'C001', customerName: '顧客A',
    fileNameOriginal: '明細.csv', sourceRow: 2, destinationRow: 2,
    destinationSpreadsheetId: 'dest1', destinationSheetName: '入力用シート',
    // 正規化値は4.16の規則で導く。作り物を入れると辞書学習の検査に弾かれる。
    merchantOriginal: '店舗', merchantNormalized: gas.call('normalizeMerchant', ['店舗'])
  }, extra)]).reviewId;

  // ================= 提示する操作 =================

  test('4.26: only the operations listed for the review type are offered', () => {
    setup();
    assert.deepEqual(plain(gas.call('availableResolveOperations', ['PARTNER'])),
      ['ADOPT_EXISTING_PARTNER', 'RESOLVE_WITHOUT_PARTNER', 'EXCLUDE']);
    // INV-31：どの種別にも終端へ至る経路が必ずある
    ['PARTNER', 'DATE', 'AMOUNT', 'ZERO_AMOUNT', 'PRIOR_YEAR'].forEach((type) => {
      const ops = plain(gas.call('availableResolveOperations', [type]));
      assert.ok(ops.length > 0, `${type} must have at least one way out`);
      assert.ok(ops.some((op) => /^EXCLUDE/.test(op)),
        `${type} must offer a terminal escape, or reviews pile up unresolvable`);
    });
  });

  test('4.26: an operation not offered for the type is refused', () => {
    setup();
    committedTx('TX_1');
    const id = review('ZERO_AMOUNT', 'TX_1');
    assert.throws(() => gas.call('resolveReview', [id, 'FIX_DATE_AMOUNT', {}]),
      (error) => error && /is not offered/.test(String(error.message)));
  });

  test('4.26: an already settled review cannot be resolved twice', () => {
    setup();
    committedTx('TX_1', {plannedF: '株式会社テスト', partnerStatus: 'RESOLVED_WITH_PARTNER'});
    const id = review('ZERO_AMOUNT', 'TX_1');
    gas.call('resolveReview', [id, 'POST_ZERO_AMOUNT', {}]);
    assert.throws(() => gas.call('resolveReview', [id, 'POST_ZERO_AMOUNT', {}]),
      (error) => error && /already settled/.test(String(error.message)));
  });

  // ================= INV-37：過剰確定しない =================

  test('INV-37: resolving one review does not commit while another remains open', () => {
    setup();
    committedTx('TX_1');
    review('DATE', 'TX_1');
    const partnerId = review('PARTNER', 'TX_1');

    const result = plain(gas.call('resolveReview',
      [partnerId, 'RESOLVE_WITHOUT_PARTNER', {}]));

    assert.equal(result.committed, false,
      'the open DATE review must still hold the transaction back');
    assert.deepEqual(result.openReviewTypes, ['DATE']);
    assert.equal(gas.call('getTransaction', ['TX_1']).transactionStatus, 'REVIEW_REQUIRED');
  });

  test('INV-37: the transaction commits once the last review is resolved', () => {
    setup();
    committedTx('TX_1');
    const partnerId = review('PARTNER', 'TX_1');

    const result = plain(gas.call('resolveReview',
      [partnerId, 'RESOLVE_WITHOUT_PARTNER', {}]));
    assert.equal(result.committed, true);
    assert.equal(gas.call('getTransaction', ['TX_1']).partnerResolutionStatus,
      'RESOLVED_WITHOUT_PARTNER');
    assert.equal(gas.call('getTransaction', ['TX_1']).transactionStatus, 'COMMITTED');
  });

  // ================= 取引先の採用 =================

  test('4.26: adopting a partner writes column F, verifies it, and learns the mapping', () => {
    setup();
    committedTx('TX_1');
    const id = review('PARTNER', 'TX_1');

    const result = plain(gas.call('resolveReview',
      [id, 'ADOPT_EXISTING_PARTNER', {partnerName: '株式会社テスト'}]));

    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    assert.equal(sheet.getRange(2, 6).getValue(), '株式会社テスト');
    // 他の列は触らない。全列を書き直すと、担当者が手で直した値が消える。
    assert.equal(sheet.getRange(2, 13).getValue(), 1000);

    const tx = gas.call('getTransaction', ['TX_1']);
    assert.equal(tx.planned.f, '株式会社テスト');
    assert.equal(tx.verified.f, '株式会社テスト',
      'planned and verified must be written together (INV-01)');
    assert.equal(result.committed, true);
  });

  test('4.26: adopting a partner without a name is refused before any write', () => {
    setup();
    committedTx('TX_1');
    const id = review('PARTNER', 'TX_1');
    assert.throws(() => gas.call('resolveReview', [id, 'ADOPT_EXISTING_PARTNER', {}]),
      (error) => error && /partner name/.test(String(error.message)));
    assert.equal(gas.stubs.getSpreadsheet('dest1')
      .getSheetByName('入力用シート').getRange(2, 6).getValue(), '');
  });

  // ================= 日付・金額の修正 =================

  test('4.26: FIX_DATE_AMOUNT on a DATE review requires the corrected date', () => {
    setup();
    committedTx('TX_1', {plannedB: ''});
    const id = review('DATE', 'TX_1');
    assert.throws(() => gas.call('resolveReview', [id, 'FIX_DATE_AMOUNT', {}]),
      (error) => error && /corrected date/.test(String(error.message)));
  });

  test('4.26: the corrected date is the first value ever written to column B', () => {
    setup();
    // INV-33 により初回転記でB列は空欄
    committedTx('TX_1', {plannedB: '', plannedF: '株式会社テスト',
                         partnerStatus: 'RESOLVED_WITH_PARTNER'});
    const id = review('DATE', 'TX_1');

    const result = plain(gas.call('resolveReview',
      [id, 'FIX_DATE_AMOUNT', {correctedDate: '2026-01-15'}]));

    assert.equal(gas.stubs.getSpreadsheet('dest1')
      .getSheetByName('入力用シート').getRange(2, 2).getValue(), '2026-01-15');
    assert.equal(gas.call('getTransaction', ['TX_1']).planned.b, '2026-01-15');
    assert.equal(result.committed, true,
      'with B filled and the partner resolved, all three conditions now hold');
  });

  // ================= INV-40：日付確定後の前年再判定 =================

  test('INV-40: settling a date raises PRIOR_YEAR when the date turns out to be last year', () => {
    setup({customerCategory: 'INDIVIDUAL', fiscalYear: 2026});
    committedTx('TX_1', {plannedB: '', plannedF: '株式会社テスト',
                         partnerStatus: 'RESOLVED_WITH_PARTNER'});
    const id = review('DATE', 'TX_1');

    // B列が空欄の間は前年かどうか判断できないので PRIOR_YEAR は立っていない
    assert.equal(gas.call('openReviews', [{fullTxId: 'TX_1', reviewType: 'PRIOR_YEAR'}]).length, 0);

    const result = plain(gas.call('resolveReview',
      [id, 'FIX_DATE_AMOUNT', {correctedDate: '2025-12-28'}]));

    const prior = plain(gas.call('openReviews', [{fullTxId: 'TX_1', reviewType: 'PRIOR_YEAR'}]));
    assert.equal(prior.length, 1,
      'the date is only judgeable once it exists - this is the moment to judge it');
    assert.equal(result.committed, false,
      'the newly raised PRIOR_YEAR must hold the commit back');
  });

  test('INV-40: a corrected date inside the fiscal year raises nothing', () => {
    setup({customerCategory: 'INDIVIDUAL', fiscalYear: 2026});
    committedTx('TX_1', {plannedB: '', plannedF: '株式会社テスト',
                         partnerStatus: 'RESOLVED_WITH_PARTNER'});
    const id = review('DATE', 'TX_1');

    const result = plain(gas.call('resolveReview',
      [id, 'FIX_DATE_AMOUNT', {correctedDate: '2026-03-01'}]));
    assert.equal(gas.call('openReviews', [{fullTxId: 'TX_1', reviewType: 'PRIOR_YEAR'}]).length, 0);
    assert.equal(result.committed, true);
  });

  test('INV-40: correcting only the amount does not trigger a re-judgement', () => {
    setup({customerCategory: 'INDIVIDUAL', fiscalYear: 2026});
    committedTx('TX_1', {plannedB: '2025-12-28', plannedF: '株式会社テスト',
                         partnerStatus: 'RESOLVED_WITH_PARTNER'});
    const id = review('AMOUNT', 'TX_1');

    gas.call('resolveReview', [id, 'FIX_DATE_AMOUNT', {correctedAmount: 2500}]);
    assert.equal(gas.call('openReviews', [{fullTxId: 'TX_1', reviewType: 'PRIOR_YEAR'}]).length, 0,
      'the date did not change, so 5.12 must not be re-evaluated');
    assert.equal(gas.stubs.getSpreadsheet('dest1')
      .getSheetByName('入力用シート').getRange(2, 13).getValue(), 2500);
  });

  // ================= 前年利用分の扱い =================

  test('4.26: posting a prior-year transaction changes no written value', () => {
    setup({customerCategory: 'INDIVIDUAL', fiscalYear: 2026});
    committedTx('TX_1', {plannedB: '2025-12-28', plannedF: '株式会社テスト',
                         partnerStatus: 'RESOLVED_WITH_PARTNER'});
    const id = review('PRIOR_YEAR', 'TX_1');

    const result = plain(gas.call('resolveReview', [id, 'POST_PRIOR_YEAR', {}]));
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    assert.equal(sheet.getRange(2, 2).getValue(), '2025-12-28',
      'the value was trustworthy all along - only the booking decision was open');
    assert.equal(result.committed, true);
  });

  test('4.26: excluding a prior-year transaction cancels it and frees its row', () => {
    setup({customerCategory: 'INDIVIDUAL', fiscalYear: 2026});
    committedTx('TX_1', {plannedB: '2025-12-28', plannedF: '株式会社テスト',
                         partnerStatus: 'RESOLVED_WITH_PARTNER'});
    const id = review('PRIOR_YEAR', 'TX_1');

    const result = plain(gas.call('resolveReview', [id, 'EXCLUDE_PRIOR_YEAR', {}]));
    assert.equal(result.committed, false, 'CANCELED is terminal - there is nothing to commit');
    assert.equal(gas.call('getTransaction', ['TX_1']).transactionStatus, 'CANCELED');

    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    assert.equal(sheet.getRange(2, 2).getValue(), '', 'the destination row must be cleared');
    assert.equal(sheet.getRange(2, 30).getValue(), '', 'and released for reuse');
  });

  // ---- CR-I：対象外にした取引がファイルを開いたままにしない ----
  test('CR-I: an excluded transaction lets the file complete even while UNRESOLVED', () => {
    setup();
    committedTx('TX_1', {plannedF: '株式会社テスト', partnerStatus: 'RESOLVED_WITH_PARTNER'});
    gas.call('updateTransactionStatus', ['TX_1', 'REVIEW_REQUIRED', 'COMMITTED']);
    committedTx('TX_2');                       // 取引先不明のまま
    const id = review('PARTNER', 'TX_2');

    gas.call('resolveReview', [id, 'EXCLUDE', {}]);

    assert.equal(gas.call('getTransaction', ['TX_2']).partnerResolutionStatus, 'UNRESOLVED',
      'EXCLUDE does not resolve the partner - that is the point of CR-I');
    assert.equal(gas.call('isFileFullyResolved', ['file1']), true,
      'the file must still be able to complete');
  });

  // ================= 除外理由（AF列） =================

  test('2.1.7: an excluded review records why it was excluded', () => {
    setup();
    committedTx('TX_1');
    const id = review('PARTNER', 'TX_1');
    gas.call('resolveReview', [id, 'EXCLUDE', {}]);

    const stored = plain(gas.call('getReviewById', [id]));
    assert.equal(stored.status, 'EXCLUDED');
    assert.equal(stored.excludeReason, 'REVIEWER_JUDGEMENT',
      'without a reason, a reviewer decision and an automatic withdrawal look identical');
  });

  test('2.1.7: an EXCLUDED status without a reason is refused', () => {
    setup();
    committedTx('TX_1');
    const id = review('PARTNER', 'TX_1');
    assert.throws(() => gas.call('updateReviewStatus', [id, 'EXCLUDED', {}]),
      (error) => error && /exclude reason/.test(String(error.message)));
  });

  test('2.1.7: resolving normally leaves the exclude reason empty', () => {
    setup();
    committedTx('TX_1', {plannedF: '株式会社テスト', partnerStatus: 'RESOLVED_WITH_PARTNER'});
    const id = review('ZERO_AMOUNT', 'TX_1');
    gas.call('resolveReview', [id, 'POST_ZERO_AMOUNT', {}]);
    assert.equal(plain(gas.call('getReviewById', [id])).excludeReason, null);
  });
};

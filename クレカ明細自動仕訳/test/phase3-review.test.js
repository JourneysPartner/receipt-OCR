'use strict';

/**
 * フェーズ3：要確認の登録・抑止（INV-16）と、取引の確定条件（4.26.2・INV-37）。
 *
 * 設計レビューでCR-2として検出された2つの失敗を、テストとして固定する。
 *   過剰確定：B列が空欄のまま`COMMITTED`になり、要確認が`OPEN`のまま【済】になる
 *   過小確定：解決しても`REVIEW_REQUIRED`のまま残りファイルが完了しない
 */
module.exports = ({test, assert, gas}) => {
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
      contentHash: 'c'.repeat(64), hashVersion: '3', state: 'WRITING'
    }]);
    return customer;
  }

  /** 予定B列値と取引先解決状態を指定して取引を1件作る。 */
  function registerTx(id, options = {}) {
    gas.call('registerPrepared', [[{
      fullTxId: id, displayTxId: id.slice(0, 8), customerId: 'C001', fileId: 'file1',
      sourceRow: 2, formatId: 'dcard', plannedFinalStatus: 'REVIEW_REQUIRED',
      partnerResolutionStatus: options.partnerStatus || 'UNRESOLVED',
      originalDate: '2026-01-02', originalMerchant: '店舗', originalAmount: 1000,
      originalPurpose: '仕入れ',
      planned: {
        b: options.plannedB === undefined ? '2026-01-02' : options.plannedB,
        f: options.plannedF === undefined ? '' : options.plannedF,
        i: '仕入れ', k: '店舗', m: 1000
      },
      identityHash: 'd'.repeat(64), contentHash: 'c'.repeat(64), occurrenceIndex: 0,
      transactionIdVersion: '2', hashVersion: '3'
    }], 'RUN_1']);
    gas.call('updateTransactionStatus', [id, 'PREPARED', 'REVIEW_REQUIRED']);
  }

  // ---- INV-16：取引単位種別は取引IDごとに登録される ----
  test('INV-16: transaction-scoped reviews are keyed per transaction, not per file', () => {
    setup();
    const results = ['TX_1', 'TX_2', 'TX_3'].map((id) =>
      gas.call('registerReview', [{
        reviewType: 'PARTNER', fullTxId: id, fileId: 'file1', customerId: 'C001'
      }]));
    assert.equal(results.every((r) => r.registered), true,
      'each transaction must get its own PARTNER review');
    assert.equal(gas.call('openReviews', [{fileId: 'file1'}]).length, 3);
    assert.equal(results[0].suppressionKey, 'PARTNER:TX_1');
  });

  // ---- INV-16：ファイル単位種別は1件だけに抑止される ----
  test('INV-16: file-scoped reviews are suppressed to a single row per file', () => {
    setup();
    const first = gas.call('registerReview',
      [{reviewType: 'FORMAT_UNKNOWN', fileId: 'file1', customerId: 'C001'}]);
    const second = gas.call('registerReview',
      [{reviewType: 'FORMAT_UNKNOWN', fileId: 'file1', customerId: 'C001'}]);
    assert.equal(first.registered, true);
    assert.equal(second.registered, false, 'the second file-scoped review must be suppressed');
    assert.equal(second.reviewId, first.reviewId);
    assert.equal(first.suppressionKey, 'FORMAT_UNKNOWN:file1');
  });

  test('INV-16: a transaction-scoped review without a transaction id is rejected', () => {
    setup();
    assert.throws(() => gas.call('registerReview',
      [{reviewType: 'PARTNER', fileId: 'file1', customerId: 'C001'}]),
      (error) => error && /transaction id/.test(String(error.message)));
  });

  // ---- 宛先を位置引数で渡す余地を残さない ----
  //
  // 以前は `(reviewType, fullTxId, fileId)` の位置引数で、契約書は
  // `(reviewType, fileId, fullTxId)` と逆順に定義されていた。契約どおりに
  // 書いた呼出側は取引単位種別にファイルIDを渡してしまい、例外も出ないまま
  // 1ファイル30件の未解決が1件に潰れる。
  test('INV-16: the suppression key takes a named target, so ids cannot be swapped', () => {
    setup();
    assert.throws(() => gas.call('buildSuppressionKey', ['PARTNER', 'file1']),
      (error) => error && /target object/.test(String(error.message)),
      'passing a bare id must be rejected rather than silently keyed by file');

    assert.equal(gas.call('buildSuppressionKey',
      ['PARTNER', {fileId: 'file1', fullTxId: 'TX_1'}]), 'PARTNER:TX_1',
      'a transaction-scoped type must key on the transaction even when a file id is present');
    assert.equal(gas.call('buildSuppressionKey',
      ['FORMAT_UNKNOWN', {fileId: 'file1', fullTxId: 'TX_1'}]), 'FORMAT_UNKNOWN:file1');
  });

  // ---- 4.24 検査8：ファイル全体を対象とする起票 ----
  test('INV-16: a file-wide integrity finding can be keyed by file (check 8)', () => {
    setup();
    assert.equal(gas.call('buildSuppressionKey',
      ['INTEGRITY', {fileId: 'file1', scope: 'FILE'}]), 'INTEGRITY:file1',
      'check 8 is file-scoped and must be registrable without a transaction id');
  });

  // ---- 2.1.7.1：検出詳細の必須キーを登録の入口で守る ----
  //
  // 解決操作はZ列から判断材料を読む。キー名が違ってもJSONなので例外は出ず、
  // `undefined` のまま処理が進む。`APPLY_FILE_DIFF` が旧リビジョンを読めないと
  // 差分計算が全件差分へ落ち、二重転記になる。
  test('2.1.7.1: a detection detail missing required keys is rejected at registration', () => {
    setup();
    assert.throws(() => gas.call('registerReview', [{
      reviewType: 'FILE_CHANGED', fileId: 'file1', customerId: 'C001',
      // 旧実装のキー名（beforeRevision / afterRevision …）
      detail: {kind: 'FILE_CHANGED', beforeRevision: 'r1', afterRevision: 'r2'}
    }]), (error) => error && /missing required keys/.test(String(error.message)),
      'the old key names must be caught here, not discovered as a double transfer');

    const ok = gas.call('registerReview', [{
      reviewType: 'FILE_CHANGED', fileId: 'file1', customerId: 'C001',
      detail: {kind: 'FILE_CHANGED', oldRevision: 'r1', newRevision: 'r2',
               oldBinaryHash: 'a'.repeat(64), newBinaryHash: 'b'.repeat(64), hashVersion: '3'}
    }]);
    assert.equal(ok.registered, true);
  });

  // ================= INV-17：ファイルが完了したかの判定 =================
  //
  // 判定に要確認の件数を使ってはならない。件数で見ると、取引と無関係な
  // ファイル単位の要確認が残っているだけでファイルが完了できなくなる。

  test('INV-17: a file is complete when every transaction reached a terminal state', () => {
    setup();
    registerTx('TX_1', {plannedB: '2026-01-02', partnerStatus: 'RESOLVED_WITH_PARTNER'});
    gas.call('updateTransactionStatus', ['TX_1', 'REVIEW_REQUIRED', 'COMMITTED']);
    assert.equal(gas.call('isFileFullyResolved', ['file1']), true);
  });

  test('INV-17: a transaction still awaiting review keeps the file open', () => {
    setup();
    registerTx('TX_1', {plannedB: '2026-01-02', partnerStatus: 'RESOLVED_WITH_PARTNER'});
    gas.call('updateTransactionStatus', ['TX_1', 'REVIEW_REQUIRED', 'COMMITTED']);
    registerTx('TX_2', {plannedB: '', partnerStatus: 'UNRESOLVED'});   // REVIEW_REQUIRED のまま
    assert.equal(gas.call('isFileFullyResolved', ['file1']), false);
  });

  // ---- CR-I：対象外で解決した取引がファイルを永久に開いたままにしない ----
  //
  // 解決操作 EXCLUDE / ACCEPT_DELETION は取引先解決状態を変えない。
  // 取引先不明の1件を「対象外」で解決すると CANCELED かつ UNRESOLVED になる。
  // 条件2を全取引に課すと、この1件のせいでファイルが永久に REVIEW_WAIT から
  // 抜けられず、担当者に回復手段がなくなる。
  test('CR-I: a CANCELED transaction with an unresolved partner does not block the file', () => {
    setup();
    registerTx('TX_1', {plannedB: '2026-01-02', partnerStatus: 'RESOLVED_WITH_PARTNER'});
    gas.call('updateTransactionStatus', ['TX_1', 'REVIEW_REQUIRED', 'COMMITTED']);
    registerTx('TX_2', {plannedB: '', partnerStatus: 'UNRESOLVED'});
    gas.call('updateTransactionStatus', ['TX_2', 'REVIEW_REQUIRED', 'CANCELED']);

    assert.equal(gas.call('isFileFullyResolved', ['file1']), true,
      'excluding an unidentifiable transaction must not strand the whole file');
  });

  test('INV-17: a COMMITTED transaction with an unresolved partner does block the file', () => {
    setup();
    registerTx('TX_1', {plannedB: '2026-01-02', partnerStatus: 'UNRESOLVED'});
    gas.call('updateTransactionStatus', ['TX_1', 'REVIEW_REQUIRED', 'COMMITTED']);
    assert.equal(gas.call('isFileFullyResolved', ['file1']), false,
      'a committed row must not go to freee with an unresolved partner');
  });

  // ---- M20：1行も転記していないファイルが【済】にならない ----
  test('M20: a file with no transactions is complete only after the empty-file check', () => {
    setup();
    assert.equal(gas.call('isFileFullyResolved', ['file1']), false,
      'a category-2 file registers no transactions - the terminal conditions hold vacuously');

    gas.call('updateProcessLog', ['file1', {emptyFileConfirmed: true}]);
    assert.equal(gas.call('isFileFullyResolved', ['file1']), true,
      'once someone confirmed the file genuinely has no detail rows, it may complete');
  });

  // ---- CR-2 過剰確定：取引先だけ解決してもB列が空欄なら確定しない ----
  test('INV-37: resolving the partner does not commit while planned B is empty (CR-2)', () => {
    setup();
    registerTx('TX_A', {plannedB: '', partnerStatus: 'UNRESOLVED'});
    const dateReview = gas.call('registerReview',
      [{reviewType: 'DATE', fullTxId: 'TX_A', fileId: 'file1', customerId: 'C001'}]);
    gas.call('registerReview',
      [{reviewType: 'PARTNER', fullTxId: 'TX_A', fileId: 'file1', customerId: 'C001'}]);

    // 担当者が取引先だけを確定した状況を作る
    gas.call('openReviews', [{fullTxId: 'TX_A', reviewType: 'PARTNER'}]).forEach((r) => {
      gas.call('updateReviewStatus', [r.reviewId, 'RESOLVED', {operation: 'ADOPT_EXISTING_PARTNER'}]);
    });

    const result = gas.call('commitIfConditionsMet', ['TX_A']);
    assert.equal(result.committed, false, 'must not commit with an open DATE review and empty B');
    assert.ok(result.unmetConditions.includes('OPEN_REVIEW_REMAINS'));
    assert.ok(result.unmetConditions.includes('PLANNED_B_EMPTY'));
    assert.equal(gas.call('getTransaction', ['TX_A']).transactionStatus, 'REVIEW_REQUIRED');
    assert.equal(dateReview.registered, true);

    // 担当者の画面が「あと何を解決すれば確定するか」を出せなければ、
    // 確定できない取引が理由の分からないまま滞留する。
    assert.deepEqual(JSON.parse(JSON.stringify(result.openReviewTypes)), ['DATE'],
      'the remaining review types must be reported back to the reviewer');
  });

  // ---- 3条件がすべて揃ったときだけ確定する ----
  test('INV-37: a transaction commits only once all three conditions hold', () => {
    setup();
    registerTx('TX_B', {plannedB: '2026-01-02', plannedF: '株式会社テスト',
                        partnerStatus: 'RESOLVED_WITH_PARTNER'});
    const review = gas.call('registerReview',
      [{reviewType: 'PARTNER', fullTxId: 'TX_B', fileId: 'file1', customerId: 'C001'}]);

    assert.equal(gas.call('commitIfConditionsMet', ['TX_B']).committed, false,
      'an open review still blocks the commit');

    gas.call('updateReviewStatus', [review.reviewId, 'RESOLVED', {operation: 'ADOPT_EXISTING_PARTNER'}]);
    const after = gas.call('commitIfConditionsMet', ['TX_B']);

    assert.equal(after.committed, true);
    assert.equal(gas.call('getTransaction', ['TX_B']).transactionStatus, 'COMMITTED');
  });

  // ---- 取引先が未解決のままなら確定しない ----
  test('INV-37: an UNRESOLVED partner blocks the commit even with no open reviews', () => {
    setup();
    registerTx('TX_C', {plannedB: '2026-01-02', partnerStatus: 'UNRESOLVED'});
    const result = gas.call('commitIfConditionsMet', ['TX_C']);
    assert.equal(result.committed, false);
    // VM境界をまたぐ配列は参照同一性を持たないため、素のJSONへ写してから比較する
    assert.deepEqual(JSON.parse(JSON.stringify(result.unmetConditions)), ['PARTNER_UNRESOLVED']);
  });

  // ---- 「取引先なしで確定」は確定を妨げない ----
  test('INV-37: RESOLVED_WITHOUT_PARTNER is a resolved state and does not block the commit', () => {
    setup();
    registerTx('TX_D', {plannedB: '2026-01-02', partnerStatus: 'RESOLVED_WITHOUT_PARTNER'});
    assert.equal(gas.call('commitIfConditionsMet', ['TX_D']).committed, true);
  });

  // ---- 別取引の未解決は当該取引の確定を妨げない ----
  test('INV-37: an open review on another transaction does not block this one', () => {
    setup();
    registerTx('TX_E', {plannedB: '2026-01-02', partnerStatus: 'RESOLVED_WITH_PARTNER'});
    registerTx('TX_F', {plannedB: '2026-01-02', partnerStatus: 'RESOLVED_WITH_PARTNER'});
    gas.call('registerReview',
      [{reviewType: 'PARTNER', fullTxId: 'TX_F', fileId: 'file1', customerId: 'C001'}]);

    assert.equal(gas.call('commitIfConditionsMet', ['TX_E']).committed, true);
    assert.equal(gas.call('commitIfConditionsMet', ['TX_F']).committed, false);
  });

  // ---- 解決記録が残る ----
  test('a resolved review records the reviewer, timestamp, operation, and role', () => {
    setup();
    const review = gas.call('registerReview',
      [{reviewType: 'PARTNER', fullTxId: 'TX_G', fileId: 'file1', customerId: 'C001'}]);
    gas.call('updateReviewStatus', [review.reviewId, 'RESOLVED', {
      actor: 'reviewer@example.com', operation: 'ADOPT_EXISTING_PARTNER',
      role: 'REVIEWER', adoptedPartner: '株式会社テスト'
    }]);
    const stored = gas.call('openReviews', [{fullTxId: 'TX_G'}]);
    assert.equal(stored.length, 0, 'the review is no longer open');
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName(names.review);
    assert.equal(sheet.getRange(2, 2).getValue(), 'RESOLVED');
    assert.equal(sheet.getRange(2, 18).getValue(), '株式会社テスト');
    assert.equal(sheet.getRange(2, 28).getValue(), 'reviewer@example.com');
    assert.equal(sheet.getRange(2, 30).getValue(), 'ADOPT_EXISTING_PARTNER');
    assert.equal(sheet.getRange(2, 31).getValue(), 'REVIEWER');
  });
};

'use strict';

/**
 * 4.26 `FILE_CHANGED`・`DUPLICATE` の固有解決操作と、役割・freeeガード。
 *
 * 第2回レビューが検出した欠陥を固定する。
 *   #6  UPDATE_PURPOSE / APPLY_FILE_DIFF / ADOPT_AS_NEW_TRANSACTION が
 *       汎用「再検査へ戻す」経路へ黙って落ちていた。UPDATE_PURPOSE で
 *       再検証へ戻すと、重複停止したファイルが再取込され二重転記になる。
 *       FILE_CHANGED は COMPLETED のファイルに立つのが典型だが、
 *       COMPLETED→VALIDATING は遷移表に無く必ず例外死していた
 *   #7  役割要件が全面的に未検査だった
 *   #8  CONFIRM_INTEGRITY_RESOLVED が再検査材料なしで素通りだった
 *   #9  EXCLUDE が freee 取込済みガードを迂回していた
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
    const rows = [header, blank(30), blank(30), blank(30), blank(30)];
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート', values: rows, formulas: rows.map(() => blank(30)),
       maxRows: 5, maxColumns: 30},
      {name: '取引先一覧', values: [['取引先']]}
    ]});
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createFile('file1', {name: '明細.csv', data: 'a,b'});
    gas.evaluate("SETTINGS.TX_INDEX_SPREADSHEET_ID='txidx';");
    gas.stubs.setActiveUser('reviewer@example.com');

    const customer = gas.call('getCustomerById', ['C001']);
    gas.call('createOrUpdateProcessLog', ['RUN_1', customer, {
      id: 'file1', name: '明細.csv', binaryHash: 'b'.repeat(64),
      contentHash: 'c'.repeat(64), hashVersion: '3', state: 'COMPLETED'
    }]);
    return customer;
  }

  /** 転記済み・確定済みの取引を行2に作る。 */
  function committed(id, options = {}) {
    const planned = {b: '2026-01-02', f: '株式会社テスト', i: '仕入れ', k: '店舗',
                     m: options.amount === undefined ? 1000 : options.amount};
    gas.call('registerPrepared', [[{
      fullTxId: id, displayTxId: id.slice(0, 12), customerId: 'C001', fileId: 'file1',
      sourceRow: 2, sourceSheetName: '', formatId: 'dcard',
      plannedFinalStatus: 'COMMITTED', partnerResolutionStatus: 'RESOLVED_WITH_PARTNER',
      originalDate: '2026-01-02', originalMerchant: '店舗', originalAmount: planned.m,
      originalPurpose: '仕入れ', planned,
      identityHash: options.identityHash || 'd'.repeat(64),
      contentHash: 'c'.repeat(64), occurrenceIndex: 0,
      generation: 0, transactionIdVersion: '2', hashVersion: '3'
    }], 'RUN_1']);
    gas.call('updateTransactionLocation', [id, 2]);
    gas.call('updateWrittenValues', [id, planned, planned]);
    gas.call('updateTransactionStatus', [id, 'PREPARED', 'COMMITTED']);
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    sheet.getRange(2, 30).setValue(id);
    sheet.getRange(2, 2).setValue(planned.b);
    sheet.getRange(2, 6).setValue(planned.f);
    sheet.getRange(2, 9).setValue(planned.i);
    sheet.getRange(2, 11).setValue(planned.k);
    sheet.getRange(2, 13).setValue(planned.m);
    return planned;
  }

  const fileReview = (type) => gas.call('registerReview', [{
    reviewType: type, fileId: 'file1', customerId: 'C001', customerName: '顧客A',
    fileNameOriginal: '明細.csv',
    detail: type === 'FILE_CHANGED'
      ? {kind: 'FILE_CHANGED', oldRevision: 'r1', newRevision: 'r2',
         oldBinaryHash: 'b'.repeat(64), newBinaryHash: 'e'.repeat(64), hashVersion: '3'}
      : undefined
  }]).reviewId;

  const NEW_META = {fileUpdatedAt: '2026-02-01T00:00:00+09:00',
                    fileRevision: 'r2', binaryHash: 'e'.repeat(64)};

  // ================= ADOPT_AS_NEW_TRANSACTION =================

  test('4.26: adopting a changed row derives the id from the next generation (INV-23)', () => {
    setup();
    committed('TX_ORIG');
    const id = fileReview('FILE_CHANGED');

    const result = plain(gas.call('resolveFileReview', [id, 'ADOPT_AS_NEW_TRANSACTION', {
      runId: 'RUN_1', sourceTxId: 'TX_ORIG',
      transaction: {
        originalDate: '2026-01-02', originalMerchant: '店舗', originalAmount: 1500,
        originalPurpose: '仕入れ', partnerResolutionStatus: 'RESOLVED_WITH_PARTNER',
        planned: {b: '2026-01-02', f: '株式会社テスト', i: '仕入れ', k: '店舗', m: 1500}
      },
      newFileMeta: NEW_META
    }]));

    // 取引IDは世代+1から決定的に導出される。恣意的な新IDを作らない。
    const expected = plain(gas.call('generateTransactionId', [{
      customerId: 'C001', fileId: 'file1', sourceSheetName: '', sourceRow: 2, generation: 1
    }]));
    assert.equal(result.adoptedTxId, expected.full,
      'the id must be re-derivable, or recovery cannot find this transaction');

    // 元取引は維持される
    assert.equal(gas.call('getTransaction', ['TX_ORIG']).transactionStatus, 'COMMITTED');
    // 新取引は書込・読取確認まで済んでいる
    const adopted = gas.call('getTransaction', [expected.full]);
    assert.equal(adopted.transactionStatus, 'COMMITTED');
    assert.equal(adopted.generation, 1);
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    assert.equal(sheet.getRange(Number(adopted.destinationRow), 13).getValue(), 1500);
  });

  test('4.26: adopting updates the process log file metadata (6.5)', () => {
    setup();
    committed('TX_ORIG');
    const id = fileReview('FILE_CHANGED');
    gas.call('resolveFileReview', [id, 'ADOPT_AS_NEW_TRANSACTION', {
      runId: 'RUN_1', sourceTxId: 'TX_ORIG',
      transaction: {partnerResolutionStatus: 'RESOLVED_WITH_PARTNER',
        planned: {b: '2026-01-02', f: '株式会社テスト', i: '仕入れ', k: '店舗', m: 1500}},
      newFileMeta: NEW_META
    }]);
    const record = plain(gas.evaluate("getProcessLogRecord_('file1')"));
    assert.equal(record.values[11], 'e'.repeat(64),
      'J/K/L update on reprocessing, so the next rescan does not re-detect the same change');
  });

  test('4.26: adopting on a COMPLETED file does not touch the file state', () => {
    setup();
    committed('TX_ORIG');
    const id = fileReview('FILE_CHANGED');
    // 以前は VALIDATING へ遷移しようとして COMPLETED→VALIDATING が
    // 遷移表に無く、必ず StateTransitionError で死んでいた。
    const result = plain(gas.call('resolveFileReview', [id, 'ADOPT_AS_NEW_TRANSACTION', {
      runId: 'RUN_1', sourceTxId: 'TX_ORIG',
      transaction: {partnerResolutionStatus: 'RESOLVED_WITH_PARTNER',
        planned: {b: '2026-01-02', f: '株式会社テスト', i: '仕入れ', k: '店舗', m: 1500}},
      newFileMeta: NEW_META
    }]));
    assert.equal(result.nextState, 'COMPLETED');
    assert.equal(gas.call('getFileState', ['file1']), 'COMPLETED');
  });

  // ================= APPLY_FILE_DIFF =================

  test('4.26: applying a file diff books only the added transactions', () => {
    setup();
    committed('TX_ORIG', {identityHash: 'a1'.repeat(32)});
    const id = fileReview('FILE_CHANGED');
    gas.evaluate('SETTINGS.FILE_DIFF_MAX_RATIO = 0.6;');   // 1/2 = 0.5 は枠内

    const result = plain(gas.call('resolveFileReview', [id, 'APPLY_FILE_DIFF', {
      runId: 'RUN_1', newFileMeta: NEW_META,
      newTransactions: [
        // 既存と同じ同一性ハッシュ → 差分ではない
        {identityHash: 'a1'.repeat(32), sourceRow: 2,
         partnerResolutionStatus: 'RESOLVED_WITH_PARTNER',
         planned: {b: '2026-01-02', f: '株式会社テスト', i: '仕入れ', k: '店舗', m: 1000}},
        // 新しい行 → 差分として起票する
        {identityHash: 'b2'.repeat(32), sourceRow: 3,
         partnerResolutionStatus: 'RESOLVED_WITH_PARTNER',
         planned: {b: '2026-01-03', f: '株式会社テスト', i: '仕入れ', k: '店舗', m: 700}}
      ]
    }]));

    assert.equal(result.added.length, 1,
      'the multiset diff must book the new row and only the new row');
    const added = gas.call('getTransaction', [result.added[0]]);
    assert.equal(added.transactionStatus, 'COMMITTED');
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    assert.equal(sheet.getRange(Number(added.destinationRow), 13).getValue(), 700);
    // 既存の取引と転記行は触らない
    assert.equal(sheet.getRange(2, 13).getValue(), 1000);
  });

  test('INV-23: a diff beyond FILE_DIFF_MAX_RATIO is refused toward CANCEL_FILE', () => {
    setup();
    committed('TX_ORIG', {identityHash: 'a1'.repeat(32)});
    const id = fileReview('FILE_CHANGED');
    gas.evaluate('SETTINGS.FILE_DIFF_MAX_RATIO = 0.3;');

    assert.throws(() => gas.call('resolveFileReview', [id, 'APPLY_FILE_DIFF', {
      runId: 'RUN_1', newFileMeta: NEW_META,
      newTransactions: [
        {identityHash: 'b2'.repeat(32), sourceRow: 3,
         planned: {b: '2026-01-03', f: 'X', i: 'Y', k: 'Z', m: 1}},
        {identityHash: 'c3'.repeat(32), sourceRow: 4,
         planned: {b: '2026-01-04', f: 'X', i: 'Y', k: 'Z', m: 2}}
      ]
    }]), (error) => error && /FILE_DIFF_MAX_RATIO|CANCEL_FILE/.test(String(error.message)),
      'a mostly-different file is a different file - the diff path must not swallow it');
  });

  // ================= UPDATE_PURPOSE =================

  function setupDuplicatePair() {
    const customer = setup();
    committed('TX_ORIG');
    // 重複として止まった新ファイル
    gas.stubs.createFile('file2', {name: '明細v2.csv', data: 'a,b'});
    gas.call('createOrUpdateProcessLog', ['RUN_1', customer, {
      id: 'file2', name: '明細v2.csv', binaryHash: 'f'.repeat(64),
      contentHash: 'c'.repeat(64), hashVersion: '3', state: 'REVIEW_WAIT'
    }]);
    const reviewId = gas.call('registerReview', [{
      reviewType: 'DUPLICATE', fileId: 'file2', customerId: 'C001',
      customerName: '顧客A', fileNameOriginal: '明細v2.csv'
    }]).reviewId;
    return {customer, reviewId};
  }

  test('4.26: UPDATE_PURPOSE rewrites column I of the existing transaction, not the file', () => {
    const {reviewId} = setupDuplicatePair();

    const result = plain(gas.call('resolveFileReview', [reviewId, 'UPDATE_PURPOSE', {
      runId: 'RUN_1', fullTxId: 'TX_ORIG', newPurpose: '消耗品'
    }]));

    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    assert.equal(sheet.getRange(2, 9).getValue(), '消耗品');
    const tx = gas.call('getTransaction', ['TX_ORIG']);
    assert.equal(tx.planned.i, '消耗品');
    assert.equal(tx.verified.i, '消耗品', 'INV-01: planned and verified move together');

    // 新ファイルは取り込まない。再検証へ戻すと重複が再取込され二重転記になる。
    assert.equal(result.nextState, 'EXCLUDED');
    assert.equal(gas.call('getFileState', ['file2']), 'EXCLUDED');
  });

  test('12.3: an imported transaction is not auto-updated - warn only', () => {
    const {reviewId} = setupDuplicatePair();
    gas.call('updateFreeeStatus', ['TX_ORIG', 'NOT_IMPORTED', 'IMPORTED', 'B1']);

    const result = plain(gas.call('resolveFileReview', [reviewId, 'UPDATE_PURPOSE', {
      runId: 'RUN_1', fullTxId: 'TX_ORIG', newPurpose: '消耗品'
    }]));

    assert.equal(result.warned, 'FREEE_IMPORTED');
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    assert.equal(sheet.getRange(2, 9).getValue(), '仕入れ',
      'freee already holds this booking - a silent edit would desynchronise them');
  });

  // ================= #7：役割の検査 =================

  test('4.26: system-administrator operations refuse other roles', () => {
    setup();
    ['SELECT_TARGET_SHEET', 'REGISTER_FORMAT'].forEach((operation) => {
      const id = fileReview(operation === 'SELECT_TARGET_SHEET' ? 'MULTI_SHEET' : 'FORMAT_UNKNOWN');
      assert.throws(() => gas.call('resolveFileReview',
        [id, operation, {runId: 'RUN_1', role: 'REVIEWER', sheetName: 'X'}]),
        (error) => error && /role/.test(String(error.message)),
        `${operation} must not be executable by a reviewer`);
    });
  });

  test('4.26: the role check also guards CONFIRM_INTEGRITY_RESOLVED', () => {
    setup();
    committed('TX_1');
    const id = gas.call('registerReview', [{
      reviewType: 'INTEGRITY', fullTxId: 'TX_1', fileId: 'file1', customerId: 'C001',
      detail: {kind: 'INTEGRITY', check: 3, expected: 'a', actual: 'b', rowNumber: 2}
    }]).reviewId;
    assert.throws(() => gas.call('resolveIntegrityReview',
      [id, 'CONFIRM_INTEGRITY_RESOLVED', {role: 'REVIEWER', recheck: {ok: true}}]),
      (error) => error && /role/.test(String(error.message)));
  });

  // ================= #8：CONFIRM_INTEGRITY_RESOLVED の素通り =================

  test('4.26: confirming integrity without材料 runs the check itself, never passes blind', () => {
    setup();
    committed('TX_1');
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    // 実際にずれた状態を作る（検査3が MANUAL_CHANGE を出す）
    sheet.getRange(2, 6).setValue('勝手に変えた');
    const id = gas.call('registerReview', [{
      reviewType: 'INTEGRITY', fullTxId: 'TX_1', fileId: 'file1', customerId: 'C001',
      detail: {kind: 'INTEGRITY', check: 3, expected: '株式会社テスト',
               actual: '勝手に変えた', rowNumber: 2}
    }]).reviewId;

    // recheck を渡さない ── 以前はこれで素通りに RESOLVED された
    assert.throws(() => gas.call('resolveIntegrityReview',
      [id, 'CONFIRM_INTEGRITY_RESOLVED', {role: 'SYSTEM_ADMIN'}]),
      (error) => error && /still present/.test(String(error.message)),
      'closing it while the mismatch stands hides the problem');
  });

  test('4.26: once the mismatch is gone, confirming succeeds on its own re-check', () => {
    setup();
    committed('TX_1');   // ずれなし
    const id = gas.call('registerReview', [{
      reviewType: 'INTEGRITY', fullTxId: 'TX_1', fileId: 'file1', customerId: 'C001',
      detail: {kind: 'INTEGRITY', check: 3, expected: 'a', actual: 'b', rowNumber: 2}
    }]).reviewId;
    const result = plain(gas.call('resolveIntegrityReview',
      [id, 'CONFIRM_INTEGRITY_RESOLVED', {role: 'SYSTEM_ADMIN'}]));
    assert.equal(plain(gas.call('getReviewById', [id])).status, 'RESOLVED');
  });

  // ================= #9：EXCLUDE の freee ガード =================

  test('17.3: excluding a freee-imported transaction is refused like a cancellation', () => {
    setup();
    committed('TX_1');
    gas.call('updateFreeeStatus', ['TX_1', 'NOT_IMPORTED', 'IMPORTED', 'B1']);
    const id = gas.call('registerReview', [{
      reviewType: 'PARTNER', fullTxId: 'TX_1', fileId: 'file1', customerId: 'C001'
    }]).reviewId;

    assert.throws(() => gas.call('resolveReview', [id, 'EXCLUDE', {runId: 'RUN_1'}]),
      (error) => error && /freee/i.test(String(error.message)),
      'freee still holds the booking; clearing the sheet alone desynchronises them forever');
    assert.equal(gas.call('getTransaction', ['TX_1']).transactionStatus, 'COMMITTED');
  });
};

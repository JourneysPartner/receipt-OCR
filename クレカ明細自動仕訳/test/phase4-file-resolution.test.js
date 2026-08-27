'use strict';

/**
 * 4.26 解決操作（ファイル単位）。
 *
 * ファイルが `REVIEW_WAIT` から出る唯一の経路である。
 *
 * 固定する規律：
 *   INV-31  どのファイル単位種別にも終端へ至る道が必ず1つある
 *   INV-28  承認して再合流させる操作は、その事実を永続化する
 *   M19     選んだ対象シートを保存し、再検査のたびに選び直させない
 *   M20     1行も転記していないファイルを勝手に【済】にしない
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

  function setup(fileState) {
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
      contentHash: 'c'.repeat(64), hashVersion: '3',
      state: fileState || 'REVIEW_WAIT'
    }]);
    return customer;
  }

  const fileReview = (type) => gas.call('registerReview', [{
    reviewType: type, fileId: 'file1', customerId: 'C001', customerName: '顧客A',
    fileNameOriginal: '明細.csv'
  }]).reviewId;

  const FILE_TYPES = ['FORMAT_UNKNOWN', 'FORMAT_AMBIGUOUS', 'MULTI_SHEET', 'DUPLICATE',
    'FILE_CHANGED', 'COUNT_TOTAL_MISMATCH', 'EMPTY_FILE', 'INPUT_LIMIT',
    'DESTINATION_FIX', 'SCAN_TRUNCATED'];

  // ================= INV-31：どの種別にも出口がある =================

  test('INV-31: every file-scoped review type offers a way to a terminal state', () => {
    setup();
    FILE_TYPES.forEach((type) => {
      const ops = plain(gas.call('availableFileResolveOperations', [type]));
      assert.ok(ops.length > 0, `${type} has no resolution at all`);
      assert.ok(ops.indexOf('CANCEL_FILE') >= 0,
        `${type} must always be cancellable, or a file landing there is stuck forever`);
    });
  });

  test('4.26: an operation not offered for the type is refused', () => {
    setup();
    const id = fileReview('EMPTY_FILE');
    assert.throws(() => gas.call('resolveFileReview', [id, 'APPROVE_COUNT_MISMATCH', {}]),
      (error) => error && /is not offered/.test(String(error.message)));
  });

  // ================= INV-28：承認は永続化する =================

  test('INV-28: approving a count mismatch persists the approval before re-validating', () => {
    setup();
    const id = fileReview('COUNT_TOTAL_MISMATCH');

    const result = plain(gas.call('resolveFileReview',
      [id, 'APPROVE_COUNT_MISMATCH', {runId: 'RUN_1', reason: '手数料行を含むため'}]));

    assert.equal(result.nextState, 'VALIDATING');
    assert.equal(result.approvalPersisted, 'COUNT_TOTAL_MISMATCH');

    // 永続化した承認が、再検証の判定を実際に通ること
    assert.equal(gas.call('hasCategory2Approval',
      ['file1', 'COUNT_TOTAL_MISMATCH', 'c'.repeat(64), '3']), true,
      'without this the reviewer approves forever and nothing moves');

    const stored = plain(gas.call('getCategory2Approvals', ['file1']));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].approvedBy, 'reviewer@example.com');
    assert.equal(stored[0].reason, '手数料行を含むため');
  });

  const approvalOps = [
    ['COUNT_TOTAL_MISMATCH', 'APPROVE_COUNT_MISMATCH', 'COUNT_TOTAL_MISMATCH'],
    ['DUPLICATE', 'IMPORT_AS_NEW_FILE', 'PURPOSE_REVISION_CANDIDATE'],
    ['SCAN_TRUNCATED', 'APPROVE_SCAN_TRUNCATION', 'SCAN_TRUNCATION_SUSPECTED'],
    ['INPUT_LIMIT', 'RESIZE_INPUT', 'INPUT_LIMIT_EXCEEDED']
  ];
  approvalOps.forEach(([type, operation, code]) => {
    test(`INV-28: ${operation} persists ${code} and returns to validation`, () => {
      setup();
      const result = plain(gas.call('resolveFileReview',
        [fileReview(type), operation, {runId: 'RUN_1', role: 'SYSTEM_ADMIN'}]));
      assert.equal(result.approvalPersisted, code);
      assert.equal(result.nextState, 'VALIDATING');
      assert.equal(gas.call('hasCategory2Approval',
        ['file1', code, 'c'.repeat(64), '3']), true);
    });
  });

  test('INV-28: an approval cannot be recorded without the submitted content hash', () => {
    setup();
    // ハッシュが記録されていない処理ログでは、後から差し替えられたファイルへ
    // 承認が流用され得る。承認そのものを拒否する。
    // （提出時点ハッシュは不変列なので、シートを直接壊して状況を作る。）
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName(names.process);
    sheet.getRange(2, 13).setValue('');   // submittedContentHash
    sheet.getRange(2, 14).setValue('');   // currentContentHash（フォールバック先）
    sheet.getRange(2, 27).setValue('');   // hashVersion

    assert.throws(() => gas.call('resolveFileReview',
      [fileReview('COUNT_TOTAL_MISMATCH'), 'APPROVE_COUNT_MISMATCH', {runId: 'RUN_1', role: 'SYSTEM_ADMIN'}]),
      (error) => error && /content hash/.test(String(error.message)));
    assert.equal(plain(gas.call('getCategory2Approvals', ['file1'])).length, 0,
      'nothing may be persisted when the approval is refused');
  });

  // ================= 差し戻し =================

  test('4.26: rejecting a count mismatch sends the file back to the customer', () => {
    setup();
    const result = plain(gas.call('resolveFileReview',
      [fileReview('COUNT_TOTAL_MISMATCH'), 'REJECT_COUNT_MISMATCH', {runId: 'RUN_1'}]));
    assert.equal(result.nextState, 'CUSTOMER_FIX_REQUIRED');
    assert.equal(plain(gas.call('getCategory2Approvals', ['file1'])).length, 0,
      'a rejection is not an approval');
  });

  test('4.26: asking the customer to split an oversized file is a rejection, not an approval', () => {
    setup();
    const result = plain(gas.call('resolveFileReview',
      [fileReview('INPUT_LIMIT'), 'RESIZE_INPUT',
       {runId: 'RUN_1', askCustomerToSplit: true}]));
    assert.equal(result.nextState, 'CUSTOMER_FIX_REQUIRED');
    assert.equal(result.approvalPersisted, null);
    assert.equal(plain(gas.call('getCategory2Approvals', ['file1'])).length, 0);
  });

  // ================= M20：0件確認 =================

  test('M20: confirming an empty file sets the flag before completing it', () => {
    setup();
    const result = plain(gas.call('resolveFileReview',
      [fileReview('EMPTY_FILE'), 'CONFIRM_EMPTY_FILE', {runId: 'RUN_1'}]));

    assert.equal(result.nextState, 'COMPLETED');
    assert.equal(gas.call('isFileFullyResolved', ['file1']), true,
      'the completion check must agree, or the file bounces back');
  });

  // ================= M19：対象シートの保存 =================

  test('M19: the chosen target sheet is stored so it is not asked again', () => {
    setup();
    const result = plain(gas.call('resolveFileReview',
      [fileReview('MULTI_SHEET'), 'SELECT_TARGET_SHEET',
       {runId: 'RUN_1', role: 'SYSTEM_ADMIN', sheetName: '利用明細'}]));

    assert.equal(result.nextState, 'VALIDATING');
    const record = plain(gas.evaluate("getPermanentFileIndexRecord_('file1')"));
    assert.equal(record.values[12], '利用明細',
      'without storing it, every re-check asks the administrator to choose again');
  });

  test('M19: selecting a target sheet without naming one is refused', () => {
    setup();
    assert.throws(() => gas.call('resolveFileReview',
      [fileReview('MULTI_SHEET'), 'SELECT_TARGET_SHEET', {runId: 'RUN_1', role: 'SYSTEM_ADMIN'}]),
      (error) => error && /sheet name/.test(String(error.message)));
  });

  // ================= INV-41：復旧経路を無関係な検証で塞がない =================
  //
  // 形式不明から復旧する経路が、形式が不明であること自体を理由に拒否されると
  // 復旧できない。同じ失敗が過去3回別の形で再発している。
  test('INV-41: registering a format returns an unknown-format file to validation', () => {
    setup();
    const result = plain(gas.call('resolveFileReview',
      [fileReview('FORMAT_UNKNOWN'), 'REGISTER_FORMAT', {runId: 'RUN_1', role: 'SYSTEM_ADMIN'}]));
    assert.equal(result.nextState, 'VALIDATING',
      'the recovery path must not be blocked by the very defect it recovers from');
  });

  test('INV-41: confirming a fixed destination returns the file to validation', () => {
    setup();
    const result = plain(gas.call('resolveFileReview',
      [fileReview('DESTINATION_FIX'), 'CONFIRM_DESTINATION_FIXED', {runId: 'RUN_1', role: 'SYSTEM_ADMIN'}]));
    assert.equal(result.nextState, 'VALIDATING');
  });

  // ================= 元の結果を維持 =================

  test('4.26: keeping the original result excludes a duplicate file', () => {
    setup();
    const result = plain(gas.call('resolveFileReview',
      [fileReview('DUPLICATE'), 'KEEP_ORIGINAL_RESULT', {runId: 'RUN_1'}]));
    assert.equal(result.nextState, 'EXCLUDED');
  });

  test('4.26: keeping the original result on a changed file leaves its state alone', () => {
    setup();
    const result = plain(gas.call('resolveFileReview',
      [fileReview('FILE_CHANGED'), 'KEEP_ORIGINAL_RESULT', {runId: 'RUN_1'}]));
    assert.equal(result.nextState, 'REVIEW_WAIT',
      'the transactions already written stay as they are');
    assert.equal(plain(gas.call('getReviewById', [gas.call('openReviews', [{fileId: 'file1'}])
      .length ? 'x' : 'y'])), null);
  });

  // ================= 取消し =================

  test('4.26: cancelling a file closes the reviews that lost their grounds', () => {
    setup();
    const id = fileReview('FORMAT_UNKNOWN');

    const result = plain(gas.call('resolveFileReview',
      [id, 'CANCEL_FILE', {runId: 'RUN_1', choice: 'CANCELED'}]));

    assert.equal(result.nextState, 'CANCELED');
    const stored = plain(gas.call('getReviewById', [id]));
    assert.equal(stored.status, 'EXCLUDED');
    assert.equal(stored.excludeReason, 'CANCELED',
      'leaving it open would strand a review nobody can act on');
  });

  test('4.26: a settled file review cannot be resolved twice', () => {
    setup();
    const id = fileReview('EMPTY_FILE');
    gas.call('resolveFileReview', [id, 'CONFIRM_EMPTY_FILE', {runId: 'RUN_1'}]);
    assert.throws(() => gas.call('resolveFileReview', [id, 'CANCEL_FILE', {runId: 'RUN_1'}]),
      (error) => error && /already settled/.test(String(error.message)));
  });
};

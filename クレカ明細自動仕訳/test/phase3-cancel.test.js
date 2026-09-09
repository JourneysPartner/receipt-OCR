'use strict';

/**
 * フェーズ3：6.4 取消し。
 *
 * 要点は3つ。
 *   1. 取消しは常に`CANCELED`を経由する2段階である（INV-10）。1段階だと必ず失敗する
 *   2. 選択肢Aはsupersedeする。しないと再処理が重複停止で妨げられる（仕様17.3）
 *   3. 孤児の要確認を残さない。残すと再処理時に抑止キーが効いて新しい要確認が
 *      登録されない（A-6）
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

  function destRow(txId) {
    const row = blank(30);
    if (txId) {
      row[1] = '2026-01-02'; row[5] = '株式会社テスト'; row[8] = '仕入れ';
      row[10] = '店舗'; row[12] = 1000; row[29] = txId;
    }
    return row;
  }

  function setup(destRows, fileState) {
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
    gas.evaluate("SETTINGS.TX_INDEX_SPREADSHEET_ID='txidx';");
    const customer = gas.call('getCustomerById', ['C001']);
    gas.call('createOrUpdateProcessLog', ['RUN_1', customer, {
      id: 'file1', name: '明細.csv', binaryHash: 'b'.repeat(64),
      contentHash: 'c'.repeat(64), hashVersion: '3', state: fileState || 'COMPLETED'
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

  function lease(customer) {
    return gas.call('acquireLease', ['C001', 'file1', 'RUN_1', 'admin@example.com', 'WRITE_ONLY']);
  }

  // ---- 転記行がクリアされ、空き行として解放される ----
  test('6.4: cancelling clears B/F/I/K/M and the transaction id column', () => {
    const customer = setup([destRow('TX_A')]);
    registerTx('TX_A', 'COMMITTED');
    const leaseId = lease(customer);
    const index = gas.call('buildIndex', [customer]);

    const result = gas.call('cancelTransactions', [{
      customer, fileId: 'file1', runId: 'RUN_1', choice: 'CANCELED',
      leaseId, index, actor: 'admin@example.com'
    }]);

    assert.equal(plain(result.canceled).length, 1);
    assert.equal(gas.call('getTransaction', ['TX_A']).transactionStatus, 'CANCELED');
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    [2, 6, 9, 11, 13, 30].forEach((column) => {
      assert.equal(sheet.getRange(2, column).getValue(), '',
        `column ${column} must be cleared`);
    });
  });

  // ---- 取消し前の行内容と数式状態を保存する（手順5） ----
  test('6.4: the row contents and formulas are captured before clearing', () => {
    const customer = setup([destRow('TX_B')]);
    registerTx('TX_B', 'COMMITTED');
    const leaseId = lease(customer);
    const index = gas.call('buildIndex', [customer]);

    const result = gas.call('cancelTransactions', [{
      customer, fileId: 'file1', runId: 'RUN_1', choice: 'CANCELED', leaseId, index
    }]);

    const snapshots = plain(result.snapshots);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].values[1], '2026-01-02', 'the pre-cancel value must be captured');
    assert.ok(Array.isArray(snapshots[0].formulas), 'formula state must be captured too');
  });

  // ---- 選択肢A：手順14で止まった取消しを、次の呼び出しが引き継ぐ ----
  test('6.4 choice A: a cancel that stopped before superseding finishes on a later call', () => {
    // 手順14のsupersedeが落ちると、CANCELEDのまま有効な行が残る（INV-03で
    // 実際に起きた）。その行は再取込で読み飛ばされ（登録は確定・取消済みに
    // 触れない）、取消しの対象状態にもCANCELEDが無いので、以後どの操作も
    // 届かなくなる。取消しは何度呼んでも同じ状態へ収束すること。
    const customer = setup([destRow('TX_F')]);
    registerTx('TX_F', 'CANCELED');
    const leaseId = lease(customer);
    const index = gas.call('buildIndex', [customer]);

    const result = gas.call('cancelTransactions', [{
      customer, fileId: 'file1', runId: 'RUN_1', choice: 'REPROCESS', leaseId, index
    }]);

    assert.deepEqual(plain(result.superseded), ['TX_F']);
    assert.equal(gas.call('getTransaction', ['TX_F']), null,
      'the stranded row must be superseded so re-import can build a new generation');
  });

  // ---- 選択肢A：supersede される ----
  test('6.4 choice A: REPROCESS supersedes the transaction log so re-import is not blocked', () => {
    const customer = setup([destRow('TX_C')]);
    registerTx('TX_C', 'COMMITTED');
    const leaseId = lease(customer);
    const index = gas.call('buildIndex', [customer]);

    gas.call('cancelTransactions', [{
      customer, fileId: 'file1', runId: 'RUN_1', choice: 'REPROCESS', leaseId, index
    }]);

    // supersede 済みなので、有効=TRUE の取引としては引けない（INV-03）
    assert.equal(gas.call('getTransaction', ['TX_C']), null,
      'a superseded row must not be returned as the active transaction');
  });

  // ---- 選択肢B：supersede しない ----
  test('6.4 choice B: CANCELED keeps the row active so it stays out of reprocessing', () => {
    const customer = setup([destRow('TX_D')]);
    registerTx('TX_D', 'COMMITTED');
    const leaseId = lease(customer);
    const index = gas.call('buildIndex', [customer]);

    gas.call('cancelTransactions', [{
      customer, fileId: 'file1', runId: 'RUN_1', choice: 'CANCELED', leaseId, index
    }]);

    const tx = gas.call('getTransaction', ['TX_D']);
    assert.ok(tx, 'choice B does not supersede');
    assert.equal(tx.transactionStatus, 'CANCELED');
  });

  // ---- 孤児の要確認を残さない（A-6）ため、影響IDを返す ----
  test('6.4: open reviews on cancelled transactions are reported so none are orphaned', () => {
    const customer = setup([destRow('TX_E')]);
    registerTx('TX_E', 'REVIEW_REQUIRED');
    gas.call('registerReview',
      [{reviewType: 'PARTNER', fullTxId: 'TX_E', fileId: 'file1', customerId: 'C001'}]);
    const leaseId = lease(customer);
    const index = gas.call('buildIndex', [customer]);

    const result = gas.call('cancelTransactions', [{
      customer, fileId: 'file1', runId: 'RUN_1', choice: 'REPROCESS', leaseId, index
    }]);

    assert.equal(plain(result.affectedReviewIds).length, 1,
      'the caller must be told which reviews to exclude');
  });

  // ---- ファイル状態は必ず CANCELED を経由する2段階（INV-10） ----
  test('6.4: COMPLETED reaches DISCOVERED only through CANCELED, never directly', () => {
    setup([destRow()], 'COMPLETED');
    // 1段階での遷移は遷移表に存在しないため必ず失敗する
    assert.throws(() => gas.call('transitionFileState',
      ['file1', 'COMPLETED', 'DISCOVERED', 'RUN_1']),
      (error) => error && /transition is not allowed/.test(String(error.message)),
      'it must fail as a disallowed transition, not for some unrelated reason');

    const finalState = gas.call('applyCancelFileState', ['file1', 'COMPLETED', 'REPROCESS']);
    assert.equal(finalState, 'DISCOVERED');
  });

  test('6.4 choice B: the file stops at CANCELED', () => {
    setup([destRow()], 'REVIEW_WAIT');
    const finalState = gas.call('applyCancelFileState', ['file1', 'REVIEW_WAIT', 'CANCELED']);
    assert.equal(finalState, 'CANCELED');
  });

  // ---- freee取込済みは本経路で自動削除しない ----
  test('6.4: freee-imported transactions are refused without an administrator decision', () => {
    const customer = setup([destRow('TX_F')]);
    registerTx('TX_F', 'COMMITTED');
    gas.call('updateFreeeStatus', ['TX_F', 'NOT_IMPORTED', 'IMPORTED', 'BATCH_1']);
    const leaseId = lease(customer);
    const index = gas.call('buildIndex', [customer]);

    assert.throws(() => gas.call('cancelTransactions', [{
      customer, fileId: 'file1', runId: 'RUN_1', choice: 'CANCELED', leaseId, index
    }]),
      (error) => error && /freee/i.test(String(error.message)),
      'the freee-imported guard must be what fires, not a signature mismatch');
    assert.equal(gas.call('getTransaction', ['TX_F']).transactionStatus, 'COMMITTED',
      'the transaction must not be cancelled when the guard fires');
  });
};

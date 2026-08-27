'use strict';

/**
 * INV-20：残留リースの検出と強制解放 ── `WRITE_ONLY` 用途を含めて。
 *
 * 解決操作・取消し・復元は `REVIEW_WAIT`/`COMPLETED` のファイルに
 * `WRITE_ONLY` リースを取る。GAS の実行が6分上限で強制終了されると
 * `finally` は走らず ACTIVE 行が残る。強制解放の事前条件を
 * 「内部状態が VALIDATING/WRITING」に限ると、このリースは**検出も解放も
 * できず、以後そのファイルの全解決操作が LEASE_CONFLICT になる** ──
 * 10.6 はシート直接編集を禁じているので、回復手段が存在しない。
 * INV-20 の根拠文が予言した状態そのものである（第2回レビュー #15）。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
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
      {name: '顧客マスター', values: [sheetHeader(37, '顧客ID'), customerRow()]},
      {name: 'クレカ処理ログ', values: [sheetHeader(40, '実行ID')]},
      {name: '処理リース', values: [sheetHeader(10, 'リースID')]},
      {name: '監査ログ', values: [sheetHeader(15, '監査ID')]},
      {name: '恒久ファイルインデックス', values: [sheetHeader(13, 'ファイルID')]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.stubs.createFile('file1', {name: '明細.csv', data: 'a'});
    const customer = gas.call('getCustomerById', ['C001']);
    gas.call('createOrUpdateProcessLog', ['RUN_1', customer, {
      id: 'file1', name: '明細.csv', binaryHash: 'b'.repeat(64),
      contentHash: 'c'.repeat(64), hashVersion: '3',
      state: fileState || 'REVIEW_WAIT'
    }]);
    return customer;
  }

  /** 心拍が閾値を超えて古いリースを作る（強制終了で残った状況）。 */
  function strandLease(purpose) {
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'reviewer@example.com', purpose]);
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName('処理リース');
    const stale = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    sheet.getRange(2, 8).setValue(stale);   // lastHeartbeat
    return leaseId;
  }

  test('INV-20: a stranded WRITE_ONLY lease on a REVIEW_WAIT file is detected', () => {
    setup('REVIEW_WAIT');
    strandLease('WRITE_ONLY');
    const stalled = plain(gas.call('detectStalledLeases', []));
    assert.equal(stalled.length, 1,
      'undetected means the file is locked forever with nothing reporting why');
    assert.equal(stalled[0].purpose, 'WRITE_ONLY');
  });

  test('INV-20: a stranded WRITE_ONLY lease on a COMPLETED file can be force-released', () => {
    setup('COMPLETED');
    const leaseId = strandLease('WRITE_ONLY');

    gas.call('forceReleaseLease', [leaseId, 'stranded by timeout', 'admin@example.com']);

    // 解放後、解決操作が再びリースを取れる
    const again = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'reviewer@example.com', 'WRITE_ONLY']);
    assert.ok(again, 'the whole point of the release is that work can resume');
  });

  test('INV-20: a PROCESS lease still requires the file to be mid-import', () => {
    setup('COMPLETED');
    const leaseId = strandLease('PROCESS');
    // PROCESS リースが COMPLETED のファイルに残っている＝状態の食い違いであり、
    // 強制解放で黙って消すのではなく調査対象にする（従来どおりの拒否）。
    assert.throws(() => gas.call('forceReleaseLease',
      [leaseId, 'x', 'admin@example.com']),
      (error) => error && /not force-releasable/.test(String(error.message)));
  });

  test('INV-20: a fresh WRITE_ONLY lease is not releasable early', () => {
    setup('REVIEW_WAIT');
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'reviewer@example.com', 'WRITE_ONLY']);
    assert.throws(() => gas.call('forceReleaseLease',
      [leaseId, 'x', 'admin@example.com']),
      (error) => error && /threshold/.test(String(error.message)),
      'releasing a live lease would let two writers into the same file');
  });

  test('INV-20: force release still requires the administrator role', () => {
    setup('REVIEW_WAIT');
    const leaseId = strandLease('WRITE_ONLY');
    assert.throws(() => gas.call('forceReleaseLease',
      [leaseId, 'x', 'reviewer@example.com']),
      (error) => error && /administrator/i.test(String(error.message)));
  });
};

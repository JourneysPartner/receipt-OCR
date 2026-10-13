'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

  function leaseSheet() {
    return gas.stubs.getSpreadsheet('master').getSheetByName('処理リース');
  }

  function auditSheet() {
    return gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ');
  }

  function appendLeaseRow(leaseId, runId, owner, fileId, purpose, heartbeat) {
    const now = heartbeat || new Date().toISOString();
    leaseSheet().appendRow([
      leaseId, 'C001', fileId || 'file1', runId, owner, '', now, now, 'ACTIVE',
      purpose || 'WRITE_ONLY'
    ]);
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

  test('INV-20: an orphan PROCESS lease with no process log row can be recovered', () => {
    // 実機で28時間動かないファイルがあった（2026-09-06）。原因は処理ログ行を
    // 持たないPROCESSリース ── `acquireLease`は`createOrUpdateProcessLog`より
    // 先に走るので、その間に実行が落ちるとこの形で残る。
    //
    // 従来はこれが**検出も解放もできなかった**：検出は状態が
    // VALIDATING/WRITINGであることを求め、行が無いと状態は空文字になる。
    // 強制解放は`!process`を「調査対象」として拒む。結果、そのファイルは
    // 永久に取り込めず、しかも一覧にも出ないので誰も原因に辿り着けない。
    //
    // 守るべきものは「動いている取込のリースを奪わない」ことだが、生きた
    // 実行は6分で必ず終わるので、心拍が閾値(10分)途絶えた時点で持ち主は
    // 居ない。行が無いなら守る取込そのものが無い。
    setup('REVIEW_WAIT');
    const ghost = gas.call('acquireLease',
      ['C001', 'ghostFile', 'RUN_1', 'reviewer@example.com', 'PROCESS']);
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName('処理リース');
    const rows = sheet.getDataRange().getValues();
    const rowNumber = rows.findIndex((r) => String(r[0]) === ghost) + 1;
    assert.ok(rowNumber > 1, 'リース行があること');
    sheet.getRange(rowNumber, 8).setValue(new Date(Date.now() - 3 * 3600 * 1000).toISOString());

    const stalled = plain(gas.call('detectStalledLeases', []));
    assert.ok(stalled.some((lease) => lease.leaseId === ghost),
      '検出できなければ、運用者はこのファイルが止まっている理由に辿り着けない');

    gas.call('forceReleaseLease', [ghost, 'orphan', 'admin@example.com']);
    assert.ok(gas.call('acquireLease',
      ['C001', 'ghostFile', 'RUN_1', 'reviewer@example.com', 'PROCESS']),
      '解放の目的は、そのファイルの取込が再び動けること');
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

  test('INV-20: the force-release threshold outlives a GAS execution but not by much', () => {
    // 閾値の根拠を数で残す。Apps Scriptの実行は6分で強制終了されるので、
    // 心拍がそれ＋心拍間隔ぶん途絶えたリースは**確実に死んでいる**。
    // 30分にしていた頃は、切れるたびに30分ファイルが動かせず、しかも
    // 再試行で心拍が更新されて時計が振り出しに戻った（2026-09-06）。
    const threshold = gas.evaluate('SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS');
    const detection = gas.evaluate('SETTINGS.HEARTBEAT_TIMEOUT_SECONDS');
    const maxExecution = 6 * 60;

    // 実行がリースを取った直後に心拍が止まっても、その実行は6分後には
    // 必ず終わっている。閾値が実行上限を余裕をもって超えていれば、
    // 閾値を過ぎたリースの持ち主は**死んでいると断定できる**。
    assert.ok(threshold >= maxExecution * 1.5,
      '実行上限(' + maxExecution + 's)の1.5倍以上あること。余裕が無いと、' +
      '生きている実行のリースを奪って同じファイルに書き手が2人入る');
    // 検出（心拍超過）が先、解放が後。逆転すると解放できるのに気づけない。
    assert.ok(threshold > detection,
      '検出閾値(' + detection + 's)より後であること');
    assert.ok(threshold <= 15 * 60,
      '長すぎると、切れた実行のたびにその時間だけファイルが動かせない');
  });

  test('INV-20: a lease stranded just past the threshold is releasable', () => {
    setup('REVIEW_WAIT');
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'reviewer@example.com', 'WRITE_ONLY']);
    const threshold = gas.evaluate('SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS');
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName('処理リース');

    // 閾値ちょうど手前では拒む。
    sheet.getRange(2, 8).setValue(
      new Date(Date.now() - (threshold - 30) * 1000).toISOString());
    assert.throws(() => gas.call('forceReleaseLease',
      [leaseId, 'x', 'admin@example.com']),
      (error) => error && /threshold/.test(String(error.message)));

    // 閾値を超えたら解放できる。
    sheet.getRange(2, 8).setValue(
      new Date(Date.now() - (threshold + 30) * 1000).toISOString());
    gas.call('forceReleaseLease', [leaseId, 'stranded', 'admin@example.com']);
    assert.ok(gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'reviewer@example.com', 'WRITE_ONLY']));
  });

  test('INV-20: a detected but not-yet-releasable lease says how long to wait', () => {
    // 検出は HEARTBEAT_TIMEOUT_SECONDS（300）、強制解放は
    // LEASE_FORCE_RELEASE_MIN_SECONDS（600）。**その 5 分間に呼ぶと必ず拒まれる。**
    // それは失敗ではなく「まだ早い」である。英文の例外をそのまま返すと
    // 運用者は壊れたと読んで別の手を探しに行く ── 2026-09-16 の実機で、
    // 実際に3回空振りし、そのぶん取込の再開が遅れた。
    setup('COMPLETED');
    gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'reviewer@example.com', 'WRITE_ONLY']);
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName('処理リース');
    sheet.getRange(2, 8).setValue(new Date(Date.now() - 400 * 1000).toISOString());
    gas.stubs.setActiveUser('admin@example.com');

    const results = plain(gas.call('opsReleaseStalledLeases', []));
    assert.equal(results.length, 1, '300秒を超えているので検出はされる');
    assert.equal(results[0].released, false);
    assert.equal(results[0].notYet, true);
    assert.ok(results[0].secondsUntilReleasable > 0 &&
      results[0].secondsUntilReleasable <= 200,
      `残り秒数が妥当であること: ${results[0].secondsUntilReleasable}`);
    assert.match(results[0].reason, /まだ解放できません/);
    assert.doesNotMatch(results[0].reason, /threshold/,
      '英文の例外をそのまま通さないこと');
  });

  test('INV-20: a lease past the force-release threshold still reports released', () => {
    // 上の「まだ早い」分岐を足したせいで、本来解放できるものまで
    // notYet に落ちてはならない。
    setup('COMPLETED');
    strandLease('WRITE_ONLY');
    gas.stubs.setActiveUser('admin@example.com');
    const results = plain(gas.call('opsReleaseStalledLeases', []));
    assert.equal(results.length, 1);
    assert.equal(results[0].released, true);
    assert.equal(results[0].notYet, undefined);
  });

  test('INV-20: force release still requires the administrator role', () => {
    setup('REVIEW_WAIT');
    const leaseId = strandLease('WRITE_ONLY');
    assert.throws(() => gas.call('forceReleaseLease',
      [leaseId, 'x', 'reviewer@example.com']),
      (error) => error && /administrator/i.test(String(error.message)));
  });

  test('INV-20: what the list calls releasable is what the release path releases', () => {
    // **同じ判定を2箇所に書くと、いつか食い違う。**実際に食い違っていた ──
    // 一覧は経過時間だけで「解放可」と出し、解放側は状態も見ていたので、
    // `COMPLETED` のファイルに残ったリースが「解放可」と表示され続け、
    // 何度解放しても消えなかった（2026-09-21に実機で確認）。運用者は
    // 壊れたと読み、別の種を探しに行くことになる。
    setup('COMPLETED');
    strandLease('PROCESS');
    const status = plain(gas.evaluate('collectLeaseStatus_({now: Date.now()})'));
    const detected = plain(gas.call('detectStalledLeases', []))
      .map((lease) => lease.leaseId).sort();
    const shown = status.filter((lease) => lease.detectable)
      .map((lease) => lease.leaseId).sort();
    assert.deepEqual(shown, detected,
      '一覧が「検出可」と言うリースと、解放側が拾うリースが食い違っている。\n' +
      '一覧: ' + JSON.stringify(shown) + '\n解放側: ' + JSON.stringify(detected));
    assert.deepEqual(status.filter((lease) => lease.releasable)
      .map((lease) => lease.leaseId), [],
      'COMPLETED のファイルのリースを「解放可」と表示している');
  });

  test('INV-20: a lease that is not mid-import says why, and what to do next', () => {
    // 「解放できない」とだけ言われても、次に何をすればよいのか分からない。
    setup('COMPLETED');
    strandLease('PROCESS');
    const status = plain(gas.evaluate('collectLeaseStatus_({now: Date.now()})'));
    const stuck = status.filter((lease) => !lease.detectable && lease.blockedReason);
    assert.equal(stuck.length, 1, '理由つきで残るリースが1件のはず');
    assert.ok(/opsReleaseInvestigatedLease/.test(stuck[0].blockedReason),
      `理由に次の手が書かれていない: ${stuck[0].blockedReason}`);
    assert.ok(/COMPLETED/.test(stuck[0].blockedReason),
      `理由にファイルの状態が書かれていない: ${stuck[0].blockedReason}`);
  });

  test('INV-20: a lease that should not exist can be released after investigating', () => {
    // `forceReleaseLease` はこの形を**わざと拒む**（状態の食い違いを黙って
    // 消さないため）。その判断は正しいが、拒むだけだと調べ終えた運用者に
    // 打つ手が無く、そのファイルは二度と取り込めない。
    setup('COMPLETED');
    const leaseId = strandLease('PROCESS');
    const out = plain(gas.call('releaseInvestigatedLease',
      [leaseId, '転記先を確認済み', 'admin@example.com']));
    assert.equal(out.released, true, JSON.stringify(out));
    assert.equal(out.fileState, 'COMPLETED');
    assert.ok(gas.call('acquireLease',
      ['C001', 'file1', 'RUN_2', 'reviewer@example.com', 'PROCESS']),
      '解放の目的は、そのファイルが再び動けること');
  });

  test('INV-20: the deliberate release is no weaker than the sweep', () => {
    // 名指しの解放口が一括より弱ければ、そちらが抜け道になる。
    setup('COMPLETED');
    const leaseId = strandLease('PROCESS');
    assert.throws(() => gas.call('releaseInvestigatedLease',
      [leaseId, '確認済み', 'reviewer@example.com']),
      (error) => error && /administrator/.test(String(error.message)),
      '管理者でなくても解放できてしまう');
    assert.throws(() => gas.call('releaseInvestigatedLease',
      [leaseId, '', 'admin@example.com']),
      (error) => error && /reason/.test(String(error.message)),
      '理由なしで解放できてしまう');
    assert.throws(() => gas.call('releaseInvestigatedLease',
      ['NO_SUCH_LEASE', '確認済み', 'admin@example.com']),
      (error) => error && /Lease not found/.test(String(error.message)),
      '存在しないリースが通る');
  });

  test('INV-20: a fresh lease on a completed file is not released either', () => {
    // 心拍が新しいなら持ち主が居る。状態が食い違っていても奪ってはならない。
    setup('COMPLETED');
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'reviewer@example.com', 'PROCESS']);
    assert.throws(() => gas.call('releaseInvestigatedLease',
      [leaseId, '確認済み', 'admin@example.com']),
      (error) => error && /threshold/.test(String(error.message)),
      '心拍が新しいのに解放できてしまう');
  });

  test('INV-20: a lease that is still mid-import belongs to the other release path', () => {
    // 2つは排他でなければならない ── 両方が受けると、どちらの前提も守られない。
    setup('WRITING');
    const leaseId = strandLease('PROCESS');
    assert.throws(() => gas.call('releaseInvestigatedLease',
      [leaseId, '確認済み', 'admin@example.com']),
      (error) => error && /still in progress/.test(String(error.message)),
      '取込中のリースまで受けてしまう');
    gas.call('forceReleaseLease', [leaseId, 'stalled', 'admin@example.com']);
    assert.equal(plain(gas.call('detectStalledLeases', [])).length, 0,
      'forceReleaseLease 側が受け持てていない');
  });

  test('kw21 1: value writes check the lease and write under one lock', () => {
    const customer = setup('REVIEW_WAIT');
    gas.stubs.createSpreadsheet('dest1', {sheets: [{
      name: '入力用シート', values: [blank(30), blank(30), blank(30)]
    }]});
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'reviewer@example.com', 'WRITE_ONLY']);
    const lock = gas.stubs.getScriptLock();
    const savedActiveLeases = gas.context.activeLeases_;
    const values = gas.context.Sheets.Spreadsheets.Values;
    const savedBatchUpdate = values.batchUpdate;

    function runAndCheck(label, invoke, expectedWrites) {
      const observed = [];
      lock.reset();
      gas.context.activeLeases_ = function() {
        observed.push({kind: 'lease-read', locked: lock.locked,
          tryCount: lock.tryCount, releaseCount: lock.releaseCount});
        return savedActiveLeases();
      };
      values.batchUpdate = function(request, spreadsheetId) {
        observed.push({kind: 'batch-update', locked: lock.locked,
          tryCount: lock.tryCount, releaseCount: lock.releaseCount,
          option: request.valueInputOption});
        return savedBatchUpdate.call(this, request, spreadsheetId);
      };
      try {
        invoke(customer, leaseId);
      } finally {
        gas.context.activeLeases_ = savedActiveLeases;
        values.batchUpdate = savedBatchUpdate;
      }
      const reads = observed.filter((item) => item.kind === 'lease-read');
      const writes = observed.filter((item) => item.kind === 'batch-update');
      assert.equal(reads.length, 1, label + ': one lease read');
      assert.equal(writes.length, expectedWrites, label + ': all expected writes');
      assert.ok(observed.every((item) => item.locked),
        label + ': every lease read and batchUpdate runs while locked');
      assert.ok(observed.every((item) => item.tryCount === 1 && item.releaseCount === 0),
        label + ': all observed calls belong to the same lock acquisition');
      assert.equal(lock.tryCount, 1, label + ': one tryLock');
      assert.equal(lock.releaseCount, 1, label + ': one releaseLock');
      assert.equal(lock.locked, false, label + ': the lock is released');
      if (label === 'writeTransactionRows') {
        assert.deepEqual(writes.map((item) => item.option), ['RAW', 'USER_ENTERED']);
      }
    }

    try {
      runAndCheck('writeTransactionRows', (target, id) =>
        gas.call('writeTransactionRows', [target, [{
          rowNumber: 2, fullTxId: 'TX_KW21',
          values: {b: '2026-10-13', f: 'F', i: 'I', k: 'K', m: 1200}
        }], id, 'file1']), 2);
      runAndCheck('clearTransactionRows', (target, id) =>
        gas.call('clearTransactionRows', [target, [2], id, 'file1']), 1);
      runAndCheck('releaseReservedRows', (target, id) =>
        gas.call('releaseReservedRows', [target, [2], id, 'file1']), 1);
    } finally {
      gas.context.activeLeases_ = savedActiveLeases;
      values.batchUpdate = savedBatchUpdate;
    }
  });

  test('kw21 2: lock contention prevents all three writes before reading leases', () => {
    const customer = setup('REVIEW_WAIT');
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'reviewer@example.com', 'WRITE_ONLY']);
    const lock = gas.stubs.getScriptLock();
    const savedActiveLeases = gas.context.activeLeases_;
    const values = gas.context.Sheets.Spreadsheets.Values;
    const savedBatchUpdate = values.batchUpdate;
    let reads = 0;
    let writes = 0;
    gas.context.activeLeases_ = function() { reads += 1; return savedActiveLeases(); };
    values.batchUpdate = function() { writes += 1; return null; };
    const calls = [
      () => gas.call('writeTransactionRows', [customer, [{
        rowNumber: 2, fullTxId: 'TX_KW21',
        values: {b: '2026-10-13', f: 'F', i: 'I', k: 'K', m: 1200}
      }], leaseId, 'file1']),
      () => gas.call('clearTransactionRows', [customer, [2], leaseId, 'file1']),
      () => gas.call('releaseReservedRows', [customer, [2], leaseId, 'file1'])
    ];
    try {
      calls.forEach((invoke) => {
        lock.setTryLockResults([false]);
        assert.throws(invoke, (error) => error && error.code === 'LEASE_CONFLICT');
      });
    } finally {
      gas.context.activeLeases_ = savedActiveLeases;
      values.batchUpdate = savedBatchUpdate;
    }
    assert.equal(reads, 0, 'a failed tryLock does not read the lease table');
    assert.equal(writes, 0, 'a failed tryLock writes no destination cells');
  });

  test('kw21 3: a missing lease stops all three writes', () => {
    const customer = setup('REVIEW_WAIT');
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'reviewer@example.com', 'WRITE_ONLY']);
    leaseSheet().deleteRow(2);
    const values = gas.context.Sheets.Spreadsheets.Values;
    const savedBatchUpdate = values.batchUpdate;
    let writes = 0;
    values.batchUpdate = function() { writes += 1; return null; };
    const calls = [
      () => gas.call('writeTransactionRows', [customer, [{
        rowNumber: 2, fullTxId: 'TX_KW21',
        values: {b: '2026-10-13', f: 'F', i: 'I', k: 'K', m: 1200}
      }], leaseId, 'file1']),
      () => gas.call('clearTransactionRows', [customer, [2], leaseId, 'file1']),
      () => gas.call('releaseReservedRows', [customer, [2], leaseId, 'file1'])
    ];
    try {
      calls.forEach((invoke) => {
        assert.throws(invoke, (error) => error && error.code === 'LEASE_CONFLICT');
      });
    } finally {
      values.batchUpdate = savedBatchUpdate;
    }
    assert.equal(writes, 0, 'a lost lease writes no destination cells');
  });

  test('kw21 4: releaseLeaseById removes and audits only its lease row', () => {
    setup('REVIEW_WAIT');
    appendLeaseRow('LEASE_A', 'RUN_A', 'owner-a@example.com');
    appendLeaseRow('LEASE_B', 'RUN_B', 'owner-b@example.com');
    const result = gas.call('releaseLeaseById', ['LEASE_A', 'TEST_RELEASE']);
    assert.equal(result, true);
    assert.deepEqual(leaseSheet().getDataRange().getValues().slice(1)
      .filter((row) => row[0]).map((row) => row[0]), ['LEASE_B']);

    const auditRowsForA = () => auditSheet().getDataRange().getValues().slice(1)
      .filter((row) => JSON.stringify(row).includes('LEASE_RELEASE') &&
        JSON.stringify(row).includes('LEASE_A'));
    assert.equal(auditRowsForA().length, 1, 'one audit row names the released lease ID');
    const auditCount = auditSheet().getLastRow();
    assert.equal(gas.call('releaseLeaseById', ['LEASE_MISSING', 'TEST_RELEASE']), false);
    assert.equal(leaseSheet().getLastRow(), 2, 'the other lease remains');
    assert.equal(auditSheet().getLastRow(), auditCount, 'a missing lease adds no audit row');
    [null, undefined, ''].forEach((id) => {
      assert.throws(() => gas.call('releaseLeaseById', [id, 'TEST_RELEASE']),
        (error) => error && error.name === 'TypeError');
    });
  });

  test('kw21 5: releaseLease requires a runId and removes only its matching row', () => {
    setup('REVIEW_WAIT');
    appendLeaseRow('LEASE_A', 'RUN_A', 'owner-a@example.com');
    appendLeaseRow('LEASE_B', 'RUN_B', 'owner-b@example.com');
    [null, undefined, ''].forEach((runId) => {
      assert.throws(() => gas.call('releaseLease', ['file1', runId, 'TEST_RELEASE']),
        (error) => error && error.name === 'TypeError');
      assert.equal(leaseSheet().getLastRow(), 3, 'invalid runId removes no lease');
    });
    gas.call('releaseLease', ['file1', 'RUN_A', 'TEST_RELEASE']);
    assert.deepEqual(leaseSheet().getDataRange().getValues().slice(1)
      .filter((row) => row[0]).map((row) => row[0]), ['LEASE_B']);
  });

  test('kw21 6: terminal transitions without a runId keep their lease', () => {
    setup('REVIEW_WAIT');
    appendLeaseRow('LEASE_COMPLETION', 'RUN_1', 'worker@example.com');
    gas.call('transitionFileState',
      ['file1', 'REVIEW_WAIT', 'COMPLETED', null]);
    assert.equal(gas.call('getFileState', ['file1']), 'COMPLETED');
    assert.deepEqual(leaseSheet().getDataRange().getValues().slice(1)
      .filter((row) => row[0]).map((row) => row[0]), ['LEASE_COMPLETION']);

    setup('REVIEW_WAIT');
    appendLeaseRow('LEASE_CANCEL', 'RUN_1', 'worker@example.com');
    gas.call('applyCancelFileState', ['file1', 'REVIEW_WAIT', 'REPROCESS']);
    assert.equal(gas.call('getFileState', ['file1']), 'DISCOVERED');
    assert.deepEqual(leaseSheet().getDataRange().getValues().slice(1)
      .filter((row) => row[0]).map((row) => row[0]), ['LEASE_CANCEL']);
  });

  test('kw21 7: terminal transition with a runId releases only that run', () => {
    setup('REVIEW_WAIT');
    appendLeaseRow('LEASE_RUN_A', 'RUN_1', 'owner-a@example.com');
    appendLeaseRow('LEASE_RUN_B', 'RUN_B', 'owner-b@example.com');
    gas.call('transitionFileState',
      ['file1', 'REVIEW_WAIT', 'FAILED', 'RUN_1']);
    assert.deepEqual(leaseSheet().getDataRange().getValues().slice(1)
      .filter((row) => row[0]).map((row) => row[0]), ['LEASE_RUN_B']);
  });

  test('kw21 9: source releases use lease IDs at the specified call sites', () => {
    const srcDir = path.resolve(__dirname, '..', 'src');
    const sourceFiles = fs.readdirSync(srcDir).filter((name) => name.endsWith('.gs'));
    const releaseLines = [];
    const releaseByIdCounts = Object.create(null);
    sourceFiles.forEach((name) => {
      const source = fs.readFileSync(path.join(srcDir, name)).toString('utf8');
      source.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (line.includes('releaseLease(')) releaseLines.push(name + ':' + line.trim());
        if (line.includes('releaseLeaseById(') &&
            !line.includes('function releaseLeaseById(')) {
          releaseByIdCounts[name] = (releaseByIdCounts[name] || 0) + 1;
        }
      });
    });
    assert.equal(releaseLines.length, 2, releaseLines.join('\n'));
    assert.ok(releaseLines.some((line) => line.startsWith('11_FileStateManager.gs:function releaseLease(')));
    assert.ok(releaseLines.some((line) =>
      line.startsWith('11_FileStateManager.gs:') &&
      line.includes("releaseLease(fileId, runId, 'STATE_TRANSITION:")));
    const expected = {
      '51_ReviewResolution.gs': 4, '52_FileResolution.gs': 4,
      '54_IntegrityResolution.gs': 2, '55_PartnerBatchResolution.gs': 1,
      '71_RunOrchestrator.gs': 1, '97_Ops.gs': 2
    };
    Object.keys(expected).forEach((name) => {
      assert.equal(releaseByIdCounts[name] || 0, expected[name], name);
    });
  });

  test('kw21 10: the completion sweep skips leases and reads them once on demand', () => {
    let customer = setup('REVIEW_WAIT');
    const savedScan = gas.context.permanentIndexRowsForScan_;
    const savedResolved = gas.context.isFileFullyResolved;
    const savedActiveLeases = gas.context.activeLeases_;
    let reads = 0;
    gas.context.permanentIndexRowsForScan_ = () =>
      [{fileId: 'file1', state: 'REVIEW_WAIT'}];
    gas.context.isFileFullyResolved = () => false;
    gas.context.activeLeases_ = function() { reads += 1; return savedActiveLeases(); };
    try {
      assert.deepEqual(plain(gas.call('completeFullyResolvedFiles_', [])), []);
      assert.equal(reads, 0, 'no resolved candidate means no lease-table read');

      gas.stubs.createFile('file2', {name: '明細2.csv', data: 'a'});
      gas.call('createOrUpdateProcessLog', ['RUN_2', customer, {
        id: 'file2', name: '明細2.csv', binaryHash: 'd'.repeat(64),
        contentHash: 'e'.repeat(64), hashVersion: '3', state: 'REVIEW_WAIT'
      }]);
      appendLeaseRow('LEASE_FILE2', 'RUN_2', 'worker@example.com', 'file2');
      gas.context.permanentIndexRowsForScan_ = () => [
        {fileId: 'file1', state: 'REVIEW_WAIT'},
        {fileId: 'file2', state: 'REVIEW_WAIT'}
      ];
      gas.context.isFileFullyResolved = () => true;
      reads = 0;
      assert.deepEqual(plain(gas.call('completeFullyResolvedFiles_', [])), ['file1']);
      assert.equal(reads, 1, 'multiple resolved candidates share one lease read');
      assert.equal(gas.call('getFileState', ['file1']), 'COMPLETED');
      assert.equal(gas.call('getFileState', ['file2']), 'REVIEW_WAIT');
      assert.deepEqual(leaseSheet().getDataRange().getValues().slice(1)
        .filter((row) => row[0]).map((row) => row[0]), ['LEASE_FILE2']);
    } finally {
      gas.context.permanentIndexRowsForScan_ = savedScan;
      gas.context.isFileFullyResolved = savedResolved;
      gas.context.activeLeases_ = savedActiveLeases;
    }
  });

  test('kw21 11: lock settings reject values below 420, but accept 420 and 600', () => {
    setup('REVIEW_WAIT');
    const original = gas.evaluate('SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS');
    const lockProblem = () => plain(gas.call('validateSettings', ['IMPORT']))
      .problems.filter((problem) => problem.check === 8)[0] || null;
    try {
      gas.evaluate('SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS = 419;');
      const tooLow = lockProblem();
      assert.ok(tooLow);
      assert.match(tooLow.detail, /420/);
      [420, 600].forEach((value) => {
        gas.evaluate('SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS = ' + value + ';');
        assert.equal(lockProblem(), null, value + ' remains valid');
      });
      gas.evaluate('SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS = null;');
      const missing = lockProblem();
      assert.ok(missing);
      assert.match(missing.detail, /must be configured/);
    } finally {
      gas.evaluate('SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS = ' +
        (original === null ? 'null' : String(original)) + ';');
    }
  });

  test('kw21 12: force release paths refuse a threshold below the floor', () => {
    setup('REVIEW_WAIT');
    gas.stubs.setActiveUser('admin@example.com');
    const forceLeaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_FORCE', 'admin@example.com', 'WRITE_ONLY']);
    const stale = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    leaseSheet().getRange(2, 8).setValue(stale);
    appendLeaseRow('LEASE_INVESTIGATED', 'RUN_INVESTIGATED',
      'admin@example.com', 'file1', 'PROCESS', stale);
    const originalSetting = gas.evaluate('SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS');
    const auditCount = auditSheet().getLastRow();
    const savedActiveLeases = gas.context.activeLeases_;
    let leaseReads = 0;
    gas.context.activeLeases_ = function() {
      leaseReads += 1;
      return savedActiveLeases();
    };
    try {
      gas.evaluate('SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS = 300;');
      assert.throws(() => gas.call('forceReleaseLease',
        [forceLeaseId, 'TEST_FORCE', 'admin@example.com']),
        (error) => error && /LEASE_FORCE_RELEASE_MIN_SECONDS/.test(String(error.message)) &&
          /420/.test(String(error.message)));
      assert.equal(leaseReads, 0, 'invalid threshold is rejected before reading leases');
      assert.throws(() => gas.call('releaseInvestigatedLease',
        ['LEASE_INVESTIGATED', 'TEST_INVESTIGATED', 'admin@example.com']),
        (error) => error && /LEASE_FORCE_RELEASE_MIN_SECONDS/.test(String(error.message)) &&
          /420/.test(String(error.message)));
      assert.equal(leaseReads, 0, 'both release paths reject before reading leases');
      assert.equal(leaseSheet().getLastRow(), 3, 'both leases remain');
      assert.equal(auditSheet().getLastRow(), auditCount, 'no failed release is audited');

      const stalled = plain(gas.call('opsReleaseStalledLeases', []));
      assert.equal(stalled.length, 1);
      assert.equal(stalled[0].released, false);

      gas.evaluate('SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS = 600;');
      gas.call('forceReleaseLease', [forceLeaseId, 'TEST_FORCE', 'admin@example.com']);
      const investigated = plain(gas.call('releaseInvestigatedLease',
        ['LEASE_INVESTIGATED', 'TEST_INVESTIGATED', 'admin@example.com']));
      assert.equal(investigated.released, true);
    } finally {
      gas.context.activeLeases_ = savedActiveLeases;
      gas.evaluate('SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS = ' +
        (originalSetting === null ? 'null' : String(originalSetting)) + ';');
    }
  });

  test('kw21 13: writeTransactionRows reads the lease table once', () => {
    const customer = setup('REVIEW_WAIT');
    gas.stubs.createSpreadsheet('dest1', {sheets: [{
      name: '入力用シート', values: [blank(30), blank(30), blank(30)]
    }]});
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'reviewer@example.com', 'WRITE_ONLY']);
    gas.stubs.resetApiCallCounts();
    gas.call('writeTransactionRows', [customer, [{
      rowNumber: 2, fullTxId: 'TX_KW21_READS',
      values: {b: '2026-10-13', f: 'F', i: 'I', k: 'K', m: 1200}
    }], leaseId, 'file1']);
    const reads = gas.stubs.getApiCallCounts().batchGet;
    console.log('kw21 13: writeTransactionRows lease-table batchGet=' + reads);
    assert.equal(reads, 1, 'the lock moves the existing read but does not add one');
  });

  // 監査で足した（変異 X8 がすり抜けた）。書くものが無い呼出しは、ロックも
  // リース表の読取も払わない（仕様 §2.1-3）。確定の経路は空の配列で呼ぶことがある。
  test('kw21 13b: empty writes take no lock and read no lease', () => {
    const customer = setup('REVIEW_WAIT');
    const lock = gas.stubs.getScriptLock();
    const savedActiveLeases = gas.context.activeLeases_;
    let reads = 0;
    gas.context.activeLeases_ = function() { reads += 1; return savedActiveLeases(); };
    lock.reset();
    try {
      assert.deepEqual(plain(gas.call('writeTransactionRows', [customer, [], 'LEASE_X', 'file1'])), []);
      assert.deepEqual(plain(gas.call('clearTransactionRows', [customer, [], 'LEASE_X', 'file1'])), []);
      gas.call('releaseReservedRows', [customer, [], 'LEASE_X', 'file1']);
    } finally {
      gas.context.activeLeases_ = savedActiveLeases;
    }
    assert.equal(lock.tryCount, 0, 'no lock for an empty write');
    assert.equal(reads, 0, 'no lease-table read for an empty write');
  });

  // 監査で足した（変異 X2 がすり抜けた）。下限は 420 ちょうどを許す
  // ── 設定の検査（kw21 11）と強制解放の補助が同じ境界でなければならない。
  test('kw21 12b: a threshold of exactly 420 still allows force release', () => {
    setup('REVIEW_WAIT');
    gas.stubs.setActiveUser('admin@example.com');
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_FORCE', 'admin@example.com', 'WRITE_ONLY']);
    leaseSheet().getRange(2, 8).setValue(new Date(Date.now() - 2 * 3600 * 1000).toISOString());
    const original = gas.evaluate('SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS');
    try {
      gas.evaluate('SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS = 420;');
      gas.call('forceReleaseLease', [leaseId, 'TEST_FORCE', 'admin@example.com']);
      assert.equal(leaseSheet().getLastRow(), 1, 'the stale lease is released at the floor');
    } finally {
      gas.evaluate('SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS = ' +
        (original === null ? 'null' : String(original)) + ';');
    }
  });

};

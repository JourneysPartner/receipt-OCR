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

};

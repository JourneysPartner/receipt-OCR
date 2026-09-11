'use strict';

/**
 * 2026-09-09 の事故は「FAILED を数える」だけでは再現できない。実行報告と
 * 状態の時間差を別々に固定し、抑制を壊したときも必ず赤になるようにする。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const blank = (length) => Array(length).fill('');
  const t0 = new Date('2026-09-09T05:10:00.000Z'); // 14:10 JST
  const customers = [
    {customerId: 'C001', customerName: '顧客一', admins: ['admin@example.com']},
    {customerId: 'C002', customerName: '顧客二', admins: ['other@example.com']}
  ];

  function at(minutes) { return new Date(t0.getTime() + minutes * 60000); }
  function resetNotify() {
    gas.stubs.reset();
    gas.stubs.setActiveUser('admin@example.com');
    gas.stubs.setEffectiveUser('admin@example.com');
    gas.stubs.setMailQuota(100);
  }
  function finding(kind, bucket, severity, elements, count, line) {
    return {kind, bucket, severity, elements: elements || [], count: count === undefined ? (elements || []).length : count,
      line: line || kind + ' ' + (count === undefined ? (elements || []).length : count), action: '対処してください'};
  }
  function dispatch(findings, now, extra = {}) {
    return plain(gas.call('dispatchNotifications_', [findings, Object.assign({
      now, source: 'TICK', runId: 'RUN_TEST',
      customersById: {C001: customers[0], C002: customers[1]},
      effectiveUser: 'admin@example.com', watchByBucket: {},
      links: {processLog: 'https://example.test/master#gid=1', review: 'https://example.test/master#gid=2'}
    }, extra)]));
  }
  function runReport(files, overrides = {}) {
    return Object.assign({runId: 'RUN_TEST', stoppedBy: null, customers: [{
      customerId: 'C001', files: files || [], skipped: null
    }]}, overrides);
  }
  function notifyReport(report, now, extra = {}) {
    return gas.call('notifyRunReport_', [report, Object.assign({now, scheduleStopped: false, customers}, extra)]);
  }
  function getStoredState() { return plain(gas.call('readNotificationState_', [])); }
  function setProperty(key, value) {
    gas.context.__notifyKey = key;
    gas.context.__notifyValue = typeof value === 'string' ? value : JSON.stringify(value);
    try { gas.evaluate('PropertiesService.getScriptProperties().setProperty(__notifyKey, __notifyValue)'); }
    finally { delete gas.context.__notifyKey; delete gas.context.__notifyValue; }
  }
  function getProperty(key) {
    gas.context.__notifyKey = key;
    try { return gas.evaluate('PropertiesService.getScriptProperties().getProperty(__notifyKey)'); }
    finally { delete gas.context.__notifyKey; }
  }

  const sheetHeader = (n, label) => { const row = blank(n); row[0] = label; return row; };
  const AE = JSON.stringify({row: 1, cells: [{column: 2, text: '利用日', match: 'exact'}]});
  function customerRow() {
    const row = blank(40);
    Object.assign(row, {0: 'C001', 1: 'テスト顧客', 2: 'TRUE', 3: 'folder1', 5: 'dest1',
      7: '入力用シート', 8: '取引先一覧', 9: 2, 10: 3, 11: 4, 12: 5, 13: 6,
      14: 7, 15: '1.0', 16: 'reviewer@example.com', 17: 'admin@example.com',
      18: 0, 20: 'システム情報', 21: '', 23: 0, 24: 0, 29: 1, 30: AE,
      31: '{}', 32: '{}', 33: 8, 34: '取引先一覧', 35: 'CORPORATE', 36: ''});
    return row;
  }
  function formatRow() {
    const row = blank(35);
    Object.assign(row, {0: 'smbc_family', 1: '三井住友系', 2: 'active', 3: 'TRUE', 4: '["csv"]',
      5: JSON.stringify({allOf: [{maxRow: 1, keywords: ['利用日', '利用店名', '金額', '使用用途'], minMatch: 4}]}),
      6: 1, 7: 2, 8: 'A', 9: 'B', 10: 'C', 11: 'D', 12: '',
      14: JSON.stringify({excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []}),
      16: JSON.stringify({sources: [{id: 'fn', kind: 'fileName', pattern: '(20\\d{2})(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}]}),
      17: 'generic', 18: 1, 19: 'admin@example.com', 21: '2026-01-01T00:00:00+09:00',
      29: 'NEW', 33: '2026-01-01T00:00:00+09:00'});
    return row;
  }
  function setupImport(withFile = false) {
    resetNotify();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [sheetHeader(40, '顧客ID'), customerRow()]},
      {name: 'カード形式マスター', values: [sheetHeader(35, '形式ID'), formatRow()]},
      {name: '使用用途補完マスター', values: [sheetHeader(10, 'ルールID')]},
      {name: '共通取引先辞書', values: [sheetHeader(18, '辞書ID'), Object.assign(blank(18), {
        0: 'DICT_1', 1: 'ローソン', 2: 'ローソン', 3: '株式会社ローソン', 4: 'exact_original',
        5: 1, 9: 'TRUE', 10: 'admin@example.com', 12: '2026-01-01T00:00:00+09:00',
        13: 1, 14: 'TRUE', 15: 'FALSE'})]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート', values: [['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID', '']], maxRows: 20, maxColumns: 8},
      {name: '取引先一覧', values: [['元店名', '取引先名'], ['ローソン', '株式会社ローソン']]}
    ]});
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createSpreadsheet('snap', {sheets: []});
    gas.stubs.createFolder('corpus', {fileIds: []});
    gas.evaluate("SETTINGS.EXECUTION_TIMEOUT_SECONDS=300; SETTINGS.SAFETY_MARGIN_SECONDS=60;" +
      " SETTINGS.TX_INDEX_SPREADSHEET_ID='txidx'; SETTINGS.SNAPSHOT_SPREADSHEET_ID='snap';" +
      " SETTINGS.SAMPLE_CORPUS_FOLDER_ID='corpus'; SETTINGS.PARALLEL_WORK_FOLDER_ID='';" +
      " SETTINGS.FAULT_INJECTION=null;");
    if (withFile) {
      gas.stubs.createFile('fileA', {name: '三井住友カード202601.csv',
        bytes: Buffer.from('利用日,利用店名,金額,使用用途\n2025/12/16,ローソン,10800,仕入れ\n', 'utf8'),
        lastUpdated: new Date(Date.now() - 3600000), createdTime: '2026-08-01T00:00:00Z', contentType: 'text/csv'});
      gas.stubs.createFolder('folder1', {fileIds: ['fileA']});
    } else gas.stubs.createFolder('folder1', {fileIds: []});
  }
  function masterSheet(name) { return gas.stubs.getSpreadsheet('master').getSheetByName(name); }
  function fileState() { return String(masterSheet('恒久ファイルインデックス').getRange(2, 4).getValue()); }
  function rewindStateOnly() {
    masterSheet('恒久ファイルインデックス').getRange(2, 4).setValue('DISCOVERED');
    masterSheet('クレカ処理ログ').getRange(2, 17).setValue('DISCOVERED');
  }
  function replaceAccidentFile() {
    gas.stubs.createFile('fileA', {name: '三井住友カード202601.csv',
      bytes: Buffer.from('利用日,利用店名,金額,使用用途\n2025/12/16,ローソン,10999,仕入れ\n', 'utf8'),
      lastUpdated: new Date(Date.now() - 3600000), createdTime: '2026-08-01T00:00:00Z', contentType: 'text/csv'});
  }

  test('notify 1: a repeatedly rewound DISCOVERED import rings three times without flooding', () => {
    setupImport(true);
    gas.call('scheduledImportTick', []);
    assert.match(fileState(), /COMPLETED|REVIEW_WAIT/);
    rewindStateOnly();
    replaceAccidentFile();
    gas.stubs.resetSentMails();
    for (let tick = 0; tick < 6; tick += 1) {
      gas.call('scheduledImportTick', []);
      assert.equal(fileState(), 'FAILED', '各回の実行自体は失敗へ帰着する');
      if (tick < 5) {
        rewindStateOnly();
        assert.equal(fileState(), 'DISCOVERED', '事故と同じ最終観測状態へ戻す');
      }
    }
    const mails = gas.stubs.getSentMails();
    assert.equal(mails.length, 3, '最初の30分相当だけで3通、その後は抑制される');
    assert.match(mails[0].subject, /^\[クレカ自動処理\] 要対応 .*取込エラー 1件/);
    assert.match(mails[0].body, /IntegrityError/);
    assert.match(mails[0].body, /fileA/);
    assert.match(mails[1].body, /継続中/);
    assert.match(mails[1].body, /取込に失敗したファイルが 1 件/);
    assert.match(mails[2].subject, /要対応/);
    assert.match(mails[2].body, /取込に繰り返し失敗/);
    mails.forEach((mail) => ['三井住友', 'ローソン', '10800', '10999', '.csv', 'immutable']
      .forEach((secret) => assert.doesNotMatch(mail.subject + mail.body, new RegExp(secret))));
  });

  test('notify 1b: a failed FAILED-state write still rings and the next housekeeping recovery is reported', () => {
    setupImport(true);
    gas.call('scheduledImportTick', []);
    rewindStateOnly();
    replaceAccidentFile();
    gas.stubs.resetSentMails();
    gas.stubs.onValuesBatchUpdate((request) => {
      if ((request.data || []).some((item) => /Q\d+/.test(item.range) &&
          (item.values || []).some((row) => row.includes('FAILED')))) {
        throw new Error('injected: FAILED transition write failed');
      }
    });
    gas.call('scheduledImportTick', []);
    assert.equal(fileState(), 'VALIDATING');
    assert.equal(gas.stubs.getSentMails().length, 1);
    assert.match(gas.stubs.getSentMails()[0].body, /取込に失敗したファイル/);
    gas.stubs.onValuesBatchUpdate(null);
    gas.call('scheduledImportTick', []);
    assert.match(fileState(), /COMPLETED|REVIEW_WAIT/);
    const mails = gas.stubs.getSentMails();
    assert.equal(mails.length, 2);
    assert.match(mails[1].body, /前回の実行が途中で止まっていた/);
    assert.match(mails[1].body, /エラー記録のあるファイル/);
    assert.match(mails[1].body, /fileA/);
  });

  test('notify 2: state-only detection catches increasing errors while the file is DISCOVERED', () => {
    const collected = {files: [{fileId: 'fileA', customerId: 'C001', state: 'DISCOVERED', errorCount: 3, errorDropped: 0}], leases: [], lastActivityAt: at(-5).toISOString()};
    const result = plain(gas.call('stateFindingsFromCollected_', [collected, {C001: customers[0]}, t0,
      {C001: {version: 1, episodes: {}, watch: {fileA: 2}}}]));
    const repeated = result.findings.find((item) => item.kind === 'REPEATED_FAILURE');
    assert.deepEqual(repeated && {severity: repeated.severity, bucket: repeated.bucket, elements: repeated.elements},
      {severity: 'CRITICAL', bucket: 'C001', elements: ['fileA']});
    assert.equal(result.findings.some((item) => item.kind === 'FAILED_FILES'), false);
    assert.equal(result.findings.some((item) => item.kind === 'ERROR_RECORDS'), false);
    assert.equal(result.watchByBucket.C001.fileA, 3);
  });

  test('notify 2b: a rewind establishes a baseline and rings only after another failure', () => {
    const make = (count, state = 'DISCOVERED') => ({files: [{fileId: 'fileA', customerId: 'C001', state,
      errorCount: count, errorDropped: 0}], leases: [], lastActivityAt: at(-5).toISOString()});
    const first = plain(gas.call('stateFindingsFromCollected_', [make(7), {C001: customers[0]}, t0, {}]));
    assert.equal(first.findings.some((item) => item.kind === 'REPEATED_FAILURE'), false);
    assert.equal(first.findings.some((item) => item.kind === 'ERROR_RECORDS'), true);
    assert.equal(first.watchByBucket.C001.fileA, 7);
    const same = plain(gas.call('stateFindingsFromCollected_', [make(7), {C001: customers[0]}, t0,
      {C001: {episodes: {}, watch: first.watchByBucket.C001}}]));
    assert.equal(same.findings.some((item) => item.kind === 'REPEATED_FAILURE'), false);
    const more = plain(gas.call('stateFindingsFromCollected_', [make(8), {C001: customers[0]}, t0,
      {C001: {episodes: {}, watch: {fileA: 7}}}]));
    assert.equal(more.findings.some((item) => item.kind === 'REPEATED_FAILURE'), true);
    const busy = plain(gas.call('stateFindingsFromCollected_', [make(8, 'VALIDATING'), {C001: customers[0]}, t0,
      {C001: {episodes: {}, watch: {fileA: 7}}}]));
    assert.equal(busy.watchByBucket.C001.fileA, 7);
    const done = plain(gas.call('stateFindingsFromCollected_', [make(8, 'COMPLETED'), {C001: customers[0]}, t0,
      {C001: {episodes: {}, watch: {fileA: 7}}}]));
    assert.equal(Object.hasOwn(done.watchByBucket.C001, 'fileA'), false);
  });

  test('notify 2c: errorTotal keeps increasing after V reaches its retained-record ceiling', () => {
    const scoped = {files: [{fileId: 'fileA', state: 'DISCOVERED', errorCount: 199, errorDropped: 5}], leases: [], lastActivityAt: at(-5).toISOString()};
    assert.equal(plain(gas.call('assessImportStatus_', [scoped, t0, {fileA: 203}])).findings[0].kind, 'REPEATED_FAILURE');
    assert.equal(plain(gas.call('assessImportStatus_', [scoped, t0, {fileA: 204}])).findings.some((item) => item.kind === 'REPEATED_FAILURE'), false);
    setupImport(false);
    const index = blank(13); Object.assign(index, {0: 'fileA', 1: 'C001', 2: 'a.csv', 3: 'DISCOVERED'});
    const process = blank(40); Object.assign(process, {5: 'C001', 7: 'fileA', 16: 'DISCOVERED', 21: 1,
      22: JSON.stringify([{truncated: true, droppedCount: 5}, {code: 'X', detail: 'a'}])});
    masterSheet('恒久ファイルインデックス').getRange(2, 1, 1, 13).setValues([index]);
    masterSheet('クレカ処理ログ').getRange(2, 1, 1, 40).setValues([process]);
    let collected = plain(gas.call('collectImportStatus_', [{now: t0}]));
    assert.equal(collected.files[0].errorDropped, 5);
    assert.equal(collected.files[0].errorCount, 1);
    masterSheet('クレカ処理ログ').getRange(2, 23).setValue('{broken');
    collected = plain(gas.call('collectImportStatus_', [{now: t0}]));
    assert.equal(collected.files[0].errorDropped, 0);
    assert.equal(collected.files[0].lastError, null);
    masterSheet('クレカ処理ログ').getRange(2, 23).setValue(JSON.stringify([{code: 'X'}]));
    assert.equal(plain(gas.call('collectImportStatus_', [{now: t0}])).files[0].errorDropped, 0);
  });

  test('notify 2d: the shared errorTotal establishes a 204 baseline and does not ring again unchanged', () => {
    const collected = {files: [{fileId: 'fileA', customerId: 'C001', state: 'DISCOVERED',
      errorCount: 199, errorDropped: 5}], leases: [], lastActivityAt: at(-5).toISOString()};
    const first = plain(gas.call('stateFindingsFromCollected_', [collected, {C001: customers[0]}, t0, {}]));
    assert.equal(first.watchByBucket.C001.fileA, 204);
    const same = plain(gas.call('stateFindingsFromCollected_', [collected, {C001: customers[0]}, at(10),
      {C001: {version: 1, episodes: {}, watch: first.watchByBucket.C001}}]));
    assert.equal(same.findings.some((item) => item.kind === 'REPEATED_FAILURE'), false);
  });

  test('notify 3: run findings use the report outcome rather than the persisted final state', () => {
    const report = runReport([{fileId: 'f1', outcome: 'FAILED', errorCode: null, errorName: 'IntegrityError'},
      {fileId: 'f2', outcome: 'LEASE_CONFLICT'}, {fileId: 'f3', outcome: 'DEFERRED_TIME_BUDGET'},
      {fileId: 'f4', outcome: 'WRITTEN'}]);
    const result = plain(gas.call('runFindingsFromReport_', [report, false]));
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, 'RUN_FILE_FAILED');
    assert.equal(result[0].count, 1);
    assert.deepEqual(result[0].elements, ['f1|IntegrityError']);
    const emptySkip = runReport([]);
    emptySkip.customers[0].skipped = '';
    assert.equal(plain(gas.call('runFindingsFromReport_', [emptySkip, false]))[0].kind,
      'RUN_CUSTOMER_SKIPPED', 'skipped は値の真偽ではなく non-null 契約で判定する');
  });

  test('notify 4: identical CRITICAL findings repeat at six hours, not every tick', () => {
    resetNotify();
    const report = runReport([{fileId: 'f1', outcome: 'FAILED', errorName: 'IntegrityError'}]);
    for (let k = 0; k <= 35; k += 1) notifyReport(report, at(k * 10));
    assert.equal(gas.stubs.getSentMails().length, 1);
    notifyReport(report, at(360));
    assert.equal(gas.stubs.getSentMails().length, 2);
    assert.match(gas.stubs.getSentMails()[1].body, /37 回目/);
    assert.match(gas.stubs.getSentMails()[1].body, /前回の通知/);
  });

  test('notify 5: adding a fingerprint element sends immediately while removing one does not', () => {
    resetNotify();
    notifyReport(runReport([{fileId: 'f1', outcome: 'FAILED', errorName: 'Error'}]), t0);
    notifyReport(runReport([{fileId: 'f1', outcome: 'FAILED', errorName: 'Error'},
      {fileId: 'f2', outcome: 'FAILED', errorName: 'Error'}]), at(50));
    assert.equal(gas.stubs.getSentMails().length, 2);
    assert.match(gas.stubs.getSentMails()[1].body, /fileId f1, f2/);
    notifyReport(runReport([{fileId: 'f1', outcome: 'FAILED', errorName: 'Error'}]), at(60));
    assert.equal(gas.stubs.getSentMails().length, 2);

    resetNotify();
    const currentWarning = finding('CUSTOMER_FIX', 'C001', 'WARNING', ['w1'], 1);
    dispatch([finding('FAILED_FILES', 'C001', 'CRITICAL', ['f1'], 1), currentWarning], t0);
    dispatch([finding('FAILED_FILES', 'C001', 'CRITICAL', ['f1', 'f2'], 2), currentWarning], at(10));
    const body = gas.stubs.getSentMails()[1].body;
    assert.equal((body.match(/CUSTOMER_FIX/g) || []).length, 1,
      '現在も観測中の継続所見を保存済み所見として二重掲載しない');
  });

  test('notify 6: a short resolution flap stays suppressed but a post-GC recurrence is new', () => {
    resetNotify();
    const due = finding('FAILED_FILES', 'C001', 'CRITICAL', ['f1'], 1);
    dispatch([due], t0);
    dispatch([], at(30));
    dispatch([due], at(40));
    assert.equal(gas.stubs.getSentMails().length, 1);
    dispatch([], at(13 * 60));
    dispatch([due], at(13 * 60 + 10));
    assert.equal(gas.stubs.getSentMails().length, 2);
  });

  test('notify 6b: an expired stored episode is treated as new even before garbage collection', () => {
    const item = finding('FAILED_FILES', 'C001', 'CRITICAL', ['f1'], 1);
    const initial = plain(gas.call('evaluateEpisodes_', [{}, [item], t0]));
    const old = initial.buckets.C001.episodes.FAILED_FILES;
    old.lastSentAt = t0.toISOString();
    old.seenCount = 4;
    const now = at(13 * 60);
    const evaluated = plain(gas.call('evaluateEpisodes_', [initial.buckets, [item], now]));
    const current = evaluated.buckets.C001.episodes.FAILED_FILES;
    assert.equal(evaluated.due.length, 1);
    assert.equal(new Date(current.firstSeenAt).getTime(), now.getTime());
    assert.equal(current.seenCount, 1);
  });

  test('notify 7: WARNING repeats only after twenty-four hours', () => {
    resetNotify();
    const item = finding('CUSTOMER_FIX', 'C001', 'WARNING', ['f1'], 1);
    dispatch([item], t0);
    assert.match(gas.stubs.getSentMails()[0].body, /同じ事象は 24時間 は再送しません/);
    dispatch([item], at(23 * 60));
    assert.equal(gas.stubs.getSentMails().length, 1);
    dispatch([item], at(24 * 60));
    assert.equal(gas.stubs.getSentMails().length, 2);
  });

  test('notify 8: schedule-stop INFO is emitted on every occurrence', () => {
    resetNotify();
    notifyReport(runReport([]), t0, {scheduleStopped: true});
    notifyReport(runReport([]), at(10), {scheduleStopped: true});
    assert.equal(gas.stubs.getSentMails().length, 2);
    assert.match(gas.stubs.getSentMails()[1].subject, /情報 システム: 定期取込を自動停止/);
  });

  test('notify 9: customer buckets are isolated and SYSTEM is a separate mail', () => {
    resetNotify();
    const report = {runId: 'RUN', stoppedBy: null, customers: [
      {customerId: 'C001', files: [{fileId: 'f1', outcome: 'FAILED', errorName: 'Error'}], auditChain: 'BROKEN_NOTIFY_ONLY'},
      {customerId: 'C002', files: [{fileId: 'f2', outcome: 'FAILED', errorName: 'Error'}]}
    ]};
    notifyReport(report, t0);
    const mails = gas.stubs.getSentMails();
    assert.equal(mails.length, 3);
    assert.equal(mails.some((mail) => /顧客一\(C001\)/.test(mail.subject)), true);
    assert.equal(mails.some((mail) => /顧客二\(C002\)/.test(mail.subject)), true);
    assert.equal(mails.some((mail) => /システム/.test(mail.subject)), true);
    const c1 = mails.find((mail) => /C001/.test(mail.subject));
    assert.doesNotMatch(c1.body, /顧客二|f2/);
  });

  test('notify 10: large fingerprints shrink to hashes without turning replacements into new elements', () => {
    const elements = Array.from({length: 12}, (_, index) => 'f' + index);
    let evaluated = plain(gas.call('evaluateEpisodes_', [{}, [finding('FAILED_FILES', 'C001', 'CRITICAL', elements, 12)], t0]));
    const episode = evaluated.buckets.C001.episodes.FAILED_FILES;
    assert.equal(episode.fingerprint.length, 0);
    assert.equal(episode.elementCount, 12);
    assert.equal(episode.fingerprintHash.length, 16);
    episode.lastSentAt = t0.toISOString();
    evaluated = plain(gas.call('evaluateEpisodes_', [evaluated.buckets,
      [finding('FAILED_FILES', 'C001', 'CRITICAL', elements, 12)], at(10)]));
    assert.equal(evaluated.due.length, 0);
    evaluated = plain(gas.call('evaluateEpisodes_', [evaluated.buckets,
      [finding('FAILED_FILES', 'C001', 'CRITICAL', elements.concat('f12'), 13)], at(20)]));
    assert.equal(evaluated.due.length, 1);
    let current = evaluated.buckets;
    current.C001.episodes.FAILED_FILES.lastSentAt = at(20).toISOString();
    const replaced = elements.slice(); replaced[0] = 'other';
    assert.equal(plain(gas.call('evaluateEpisodes_', [current,
      [finding('FAILED_FILES', 'C001', 'CRITICAL', replaced, 12)], at(30)])).due.length, 0);
    const small = plain(gas.call('evaluateEpisodes_', [{},
      [finding('FAILED_FILES', 'C001', 'CRITICAL', ['secret-file-id'], 1)], t0]));
    const json = JSON.stringify(small.buckets);
    assert.match(json, /[a-f0-9]{12}/);
    assert.doesNotMatch(json, /secret-file-id/);
  });

  test('notify 10b: a repeated interruption escalates while a different file starts a warning episode', () => {
    resetNotify();
    const one = plain(gas.call('housekeepingFindings_', [{released: 1, recovered: 0, fileIds: ['f1']}, {f1: 'C001'}]));
    dispatch(one, t0);
    dispatch(one, at(10));
    assert.equal(gas.stubs.getSentMails().length, 2);
    assert.match(gas.stubs.getSentMails()[0].subject, /注意/);
    assert.match(gas.stubs.getSentMails()[1].subject, /要対応/);
    assert.match(gas.stubs.getSentMails()[1].body, /同じファイルが繰り返し中断/);
    dispatch(one, at(20));
    assert.equal(gas.stubs.getSentMails().length, 2);
    const two = plain(gas.call('housekeepingFindings_', [{released: 1, recovered: 0, fileIds: ['f2']}, {f2: 'C001'}]));
    dispatch(two, at(30));
    assert.equal(gas.stubs.getSentMails().length, 3);
    const orphan = plain(gas.call('housekeepingFindings_', [{released: 1, recovered: 0, fileIds: ['orphan']}, {}]));
    dispatch(orphan, at(40));
    const last = gas.stubs.getSentMails().at(-1);
    assert.match(last.subject, /システム/);
    assert.doesNotMatch(last.body, /orphan/);
  });

  test('notify 11: the six shared status warnings keep the specified order and wording', () => {
    const scoped = {files: [
      {fileId: 'failed', state: 'FAILED', errorCount: 0},
      {fileId: 'repeat', state: 'DISCOVERED', errorCount: 2, errorDropped: 0},
      {fileId: 'stuck', state: 'VALIDATING', errorCount: 0, lease: null},
      {fileId: 'fix', state: 'CUSTOMER_FIX_REQUIRED', errorCount: 0},
      {fileId: 'idle', state: 'DISCOVERED', errorCount: 0},
      {fileId: 'error', state: 'COMPLETED', errorCount: 1}],
      leases: [], lastActivityAt: at(-40).toISOString()};
    const kinds = plain(gas.call('assessImportStatus_', [scoped, t0, {repeat: 1}])).findings.map((item) => item.kind);
    assert.deepEqual(kinds, ['FAILED_FILES', 'REPEATED_FAILURE', 'STALLED', 'CUSTOMER_FIX', 'IMPORT_IDLE', 'ERROR_RECORDS']);
  });

  test('notify 12: menu warning lines are exactly the assessment lines for anomaly and healthy inputs', () => {
    const collected = {files: [{fileId: 'f', customerId: 'C001', state: 'FAILED', errorCount: 1}], leases: [], reviews: [], lastActivityAt: t0.toISOString()};
    const scope = {email: 'x', isOwner: false, customers: [customers[0]], customerIds: ['C001'], customerNameById: {C001: '顧客一'}};
    const assessment = plain(gas.call('assessImportStatus_', [{files: collected.files, leases: [], lastActivityAt: collected.lastActivityAt}, t0, {}]));
    const text = plain(gas.call('buildImportStatusView_', [collected, scope, t0, 0, {}])).text;
    assessment.findings.forEach((item) => assert.match(text, new RegExp(item.line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))));
    const healthy = {files: [], leases: [], reviews: [], lastActivityAt: null};
    assert.equal(plain(gas.call('assessImportStatus_', [healthy, t0, {}])).findings.length, 0);
    assert.match(plain(gas.call('buildImportStatusView_', [healthy, scope, t0, 0, {}])).text, /異常は見つかりませんでした/);
  });

  test('notify 13: notification state findings are the same assessment after customer filtering', () => {
    const collected = {files: [{fileId: 'f1', customerId: 'C001', state: 'FAILED', errorCount: 0},
      {fileId: 'f2', customerId: 'C002', state: 'DISCOVERED', errorCount: 0}], leases: [], lastActivityAt: t0.toISOString()};
    const state = plain(gas.call('stateFindingsFromCollected_', [collected, {C001: customers[0], C002: customers[1]}, t0, {}]));
    const scoped = plain(gas.call('filterCollectedByCustomer_', [collected, 'C001']));
    const assessed = plain(gas.call('assessImportStatus_', [scoped, t0, {}]));
    assert.deepEqual(state.findings.filter((item) => item.bucket === 'C001').map((item) => item.line),
      assessed.findings.map((item) => item.line));
  });

  test('notify 14: assessment does not require or inspect review rows', () => {
    const scoped = {files: [], leases: [], lastActivityAt: null};
    const without = plain(gas.call('assessImportStatus_', [scoped, t0, {}]));
    const withReviews = plain(gas.call('assessImportStatus_', [Object.assign({reviews: [{state: 'FAILED'}]}, scoped), t0, {}]));
    assert.deepEqual(withReviews, without);
  });

  test('notify 15: customer recipients are normalized deduplicated and may fall back to admins only', () => {
    assert.deepEqual(plain(gas.call('notificationRecipients_', ['C001', {C001: {
      admins: 'a@example.com, B@Example.com'}, C002: {admins: ['other@example.com']}}, 'ADMIN@example.com'])),
      ['a@example.com', 'b@example.com', 'admin@example.com']);
    assert.deepEqual(plain(gas.call('notificationRecipients_', ['C001', {C001: {admins: ['a@example.com']}}, ''])), ['a@example.com']);
    resetNotify();
    dispatch([finding('FAILED_FILES', 'C001', 'CRITICAL', ['f1'], 1)], t0,
      {customersById: {C001: {customerId: 'C001', customerName: '顧客一', admins: []}}, effectiveUser: ''});
    assert.equal(gas.stubs.getSentMails().length, 0);
    assert.equal(getStoredState().global.lastFailure.reason, 'NO_RECIPIENT');
  });

  test('notify 16: SYSTEM recipients are the union of active-customer admins and the effective user', () => {
    const map = {C001: {admins: ['a@example.com']}, C002: {admins: ['A@example.com', 'b@example.com']}};
    assert.deepEqual(plain(gas.call('notificationRecipients_', ['SYSTEM', map, 'admin@example.com'])),
      ['a@example.com', 'b@example.com', 'admin@example.com']);
    assert.equal(JSON.stringify(map).includes('disabled@example.com'), false);
  });

  test('notify 17: customer-master failure still sends to the effective user and says admins were omitted', () => {
    resetNotify();
    dispatch([finding('STATUS_CHECK_FAILED', 'SYSTEM', 'CRITICAL', ['Error'], 1)], t0,
      {customersById: null, customerMasterUnavailable: true});
    const mail = gas.stubs.getSentMails()[0];
    assert.deepEqual(mail.to, ['admin@example.com']);
    assert.match(mail.body, /顧客マスターを読めなかった/);
  });

  test('notify 18: mail composition ignores arbitrary detail fields and limits listed file ids', () => {
    const item = Object.assign(finding('FAILED_FILES', 'C001', 'CRITICAL',
      Array.from({length: 11}, (_, index) => 'f' + index), 11,
      '⚠ 失敗したファイルが 11 件あります。'),
      {merchantOriginal: 'ローソン', amount: 10800, fileName: '三井住友.csv', detail: 'secret detail'});
    const mail = plain(gas.call('composeNotificationMail_', ['C001', [item], [], {
      customerName: '顧客一', now: t0, source: 'TICK', runId: 'RUN', links: null,
      episodes: {FAILED_FILES: {firstSeenAt: t0.toISOString(), lastSentAt: null, seenCount: 1}},
      quotaSkipped: 0, customerMasterUnavailable: false, codeVersion: '3.0.0'}]));
    assert.doesNotMatch(mail.subject + mail.body, /ローソン|10800|三井住友|secret detail/);
    assert.match(mail.body, /ほか 1 件/);
    assert.doesNotMatch(mail.body, /fileId f10(?:,|\n)/);
  });

  test('notify 19: SETTINGS_INVALID lists only check ids and names, never details', () => {
    const report = {runId: 'RUN', stoppedBy: 'SETTINGS_INVALID', settingsProblems: [
      {check: 11, name: 'separateSpreadsheets', detail: 'secret spreadsheet id'}], customers: []};
    const item = plain(gas.call('runFindingsFromReport_', [report, false]))[0];
    const mail = plain(gas.call('composeNotificationMail_', ['SYSTEM', [item], [], {
      customerName: '', now: t0, source: 'TICK', runId: 'RUN', links: null,
      episodes: {RUN_STOPPED: {firstSeenAt: t0.toISOString(), lastSentAt: null, seenCount: 1}},
      quotaSkipped: 0, customerMasterUnavailable: false, codeVersion: '3.0.0'}]));
    assert.match(mail.body, /対象: 検査 #11 separateSpreadsheets/);
    assert.doesNotMatch(mail.body, /secret spreadsheet id/);
  });

  test('notify 20: send failure preserves due state and never escapes scheduledImportTick', () => {
    resetNotify();
    gas.stubs.setMailFailures(['boom']);
    const report = runReport([{fileId: 'f1', outcome: 'FAILED', errorName: 'Error'}]);
    assert.doesNotThrow(() => notifyReport(report, t0));
    let state = getStoredState();
    assert.equal(state.global.lastFailure.reason, 'MAIL_SEND_FAILED');
    assert.equal(state.buckets.C001.episodes.RUN_FILE_FAILED.lastSentAt, null);
    notifyReport(report, at(10));
    assert.equal(gas.stubs.getSentMails().length, 1);

    resetNotify();
    notifyReport(report, t0);
    gas.stubs.setMailFailures(['new element failed']);
    const expanded = runReport([{fileId: 'f1', outcome: 'FAILED', errorName: 'Error'},
      {fileId: 'f2', outcome: 'FAILED', errorName: 'Error'}]);
    notifyReport(expanded, at(10));
    notifyReport(expanded, at(20));
    assert.equal(gas.stubs.getSentMails().length, 2,
      '新要素の送信失敗も指紋を確定せず、次回に再試行する');
    setupImport(false);
    gas.stubs.setMailFailures(['boom']);
    assert.doesNotThrow(() => gas.call('scheduledImportTick', []));
  });

  test('notify 21: quota exhaustion records skipped mails and the recovery mail reports them', () => {
    resetNotify();
    gas.stubs.setMailQuota(0);
    dispatch([finding('FAILED_FILES', 'C001', 'CRITICAL', ['f1'], 1)], t0);
    let state = getStoredState();
    assert.equal(state.global.quota.skipped, 1);
    assert.equal(state.global.sentToday, 0);
    gas.stubs.setMailQuota(100);
    dispatch([finding('FAILED_FILES', 'C001', 'CRITICAL', ['f1'], 1)], at(10));
    assert.match(gas.stubs.getSentMails()[0].body, /クォータ上限で 1 件の通知を送れませんでした/);
    state = getStoredState();
    assert.equal(state.global.quota, null);
  });

  test('notify 22: the local daily ceiling counts recipients and resets on the JST day boundary', () => {
    resetNotify();
    gas.evaluate('SETTINGS.MAX_EMAILS_PER_DAY = 2');
    const opts = {customersById: {C001: {customerId: 'C001', customerName: '一', admins: ['a@example.com']},
      C002: {customerId: 'C002', customerName: '二', admins: ['b@example.com']}}, effectiveUser: 'admin@example.com'};
    dispatch([finding('FAILED_FILES', 'C001', 'CRITICAL', ['f1'], 1),
      finding('FAILED_FILES', 'C002', 'CRITICAL', ['f2'], 1)], t0, opts);
    assert.equal(gas.stubs.getSentMails().length, 1);
    assert.equal(getStoredState().global.sentToday, 2);
    dispatch([finding('FAILED_FILES', 'C002', 'CRITICAL', ['f2'], 1)], new Date(t0.getTime() + 86400000), opts);
    assert.equal(gas.stubs.getSentMails().length, 2);
  });

  test('notify 23: lock conflict sends and writes nothing and leaves the next evaluation due', () => {
    resetNotify();
    gas.stubs.getScriptLock().setTryLockResults([false]);
    assert.doesNotThrow(() => dispatch([finding('FAILED_FILES', 'C001', 'CRITICAL', ['f1'], 1)], t0));
    assert.equal(gas.stubs.getSentMails().length, 0);
    assert.equal(getProperty('NOTIFY_STATE_V1'), null);
    dispatch([finding('FAILED_FILES', 'C001', 'CRITICAL', ['f1'], 1)], at(10));
    assert.equal(gas.stubs.getSentMails().length, 1);
  });

  test('notify 23b: one evaluation sends three priority buckets and persists every deferred episode', () => {
    resetNotify();
    const items = [
      finding('FAILED_FILES', 'C001', 'CRITICAL', ['c1'], 1),
      finding('FAILED_FILES', 'C002', 'CRITICAL', ['c2'], 1),
      finding('CUSTOMER_FIX', 'C003', 'WARNING', ['w3'], 1),
      finding('CUSTOMER_FIX', 'C004', 'WARNING', ['w4'], 1),
      finding('CUSTOMER_FIX', 'C005', 'WARNING', ['w5'], 1)
    ];
    const map = {};
    for (let i = 1; i <= 5; i += 1) map['C00' + i] = {customerId: 'C00' + i, customerName: '顧客' + i, admins: ['admin@example.com']};
    const first = dispatch(items, t0, {customersById: map});
    assert.equal(first.sent, 3);
    let state = getStoredState();
    assert.equal(Object.keys(state.buckets).length, 5);
    assert.equal(Object.values(state.buckets).filter((bucket) => Object.values(bucket.episodes)[0].lastSentAt === null).length, 2);
    assert.equal(gas.stubs.getScriptLock().releaseCount, 1);
    const second = dispatch(items, at(10), {customersById: map});
    assert.equal(second.sent, 2);
    state = getStoredState();
    assert.equal(Object.values(state.buckets).every((bucket) => Object.values(bucket.episodes)[0].firstSeenAt === plain(state.buckets.C001.episodes.FAILED_FILES).firstSeenAt), true);
    assert.equal(gas.stubs.getScriptLock().releaseCount, 2);
  });

  test('notify 23c: state notification reads twice and writes changed buckets before the global key', () => {
    setupImport(false);
    const bucket = {version: 1, episodes: {}, watch: {fileA: 3}};
    setProperty('NOTIFY_BUCKET_V1|C001', bucket);
    const index = blank(13); Object.assign(index, {0: 'fileA', 1: 'C001', 2: 'a.csv', 3: 'COMPLETED'});
    masterSheet('恒久ファイルインデックス').getRange(2, 1, 1, 13).setValues([index]);
    gas.stubs.resetPropertyCallCounts();
    gas.call('notifyImportState_', [{now: t0, source: 'TICK', customers: [customers[0]]}]);
    assert.equal(gas.stubs.getPropertyCallCounts().getProperties, 2);
    const writes = gas.stubs.getPropertyWrites();
    assert.equal(writes.some((item) => item.key === 'NOTIFY_BUCKET_V1|C001'), true, 'watch削除だけでも書く');
    const globalAt = writes.findIndex((item) => item.key === 'NOTIFY_STATE_V1');
    assert.equal(writes.slice(0, globalAt).every((item) => item.key.startsWith('NOTIFY_BUCKET_V1|')), true);
    gas.stubs.resetPropertyCallCounts();
    notifyReport(runReport([]), at(10));
    assert.equal(gas.stubs.getPropertyCallCounts().getProperties, 1);
  });

  test('notify 24: scheduled wiring evaluates state before runImport and the report after it', () => {
    setupImport(false);
    gas.evaluate("var __nA=notifyImportState_,__nB=notifyRunReport_,__nR=runImport,__nP=permanentIndexRowsForScan_," +
      "__nL=opsReleaseStalledLeases,__nH=opsRecoverStuckFiles;" +
      "notifyImportState_=function(){Logger.log('NOTIFY_A');};" +
      "runImport=function(){Logger.log('RUN_IMPORT');return {runId:'RUN',customers:[],stoppedBy:null};};" +
      "notifyRunReport_=function(){Logger.log('NOTIFY_B');}; permanentIndexRowsForScan_=function(){return [];};" +
      "opsReleaseStalledLeases=function(){return [];}; opsRecoverStuckFiles=function(){return [];};");
    try { gas.call('scheduledImportTick', []); }
    finally { gas.evaluate('notifyImportState_=__nA;notifyRunReport_=__nB;runImport=__nR;permanentIndexRowsForScan_=__nP;opsReleaseStalledLeases=__nL;opsRecoverStuckFiles=__nH;'); }
    const logs = gas.stubs.getLogLines();
    assert.ok(logs.indexOf('NOTIFY_A') < logs.indexOf('RUN_IMPORT'));
    assert.ok(logs.indexOf('RUN_IMPORT') < logs.indexOf('NOTIFY_B'));
  });

  test('notify 25: housekeeping failure is handed to notification and runImport still executes', () => {
    setupImport(false);
    gas.evaluate("var __hR=opsReleaseStalledLeases,__hH=opsRecoverStuckFiles,__hA=notifyImportState_,__hB=notifyRunReport_,__hRun=runImport,__hP=permanentIndexRowsForScan_;" +
      "opsReleaseStalledLeases=function(){return [];};opsRecoverStuckFiles=function(){throw new Error('house boom');};" +
      "notifyImportState_=function(o){Logger.log('HOUSE_ERROR=' + Boolean(o.housekeeping.error));};notifyRunReport_=function(){};" +
      "runImport=function(){Logger.log('RUN_AFTER_HOUSE');return {runId:'R',customers:[],stoppedBy:null};};permanentIndexRowsForScan_=function(){return [];};");
    try { gas.call('scheduledImportTick', []); }
    finally { gas.evaluate('opsReleaseStalledLeases=__hR;opsRecoverStuckFiles=__hH;notifyImportState_=__hA;notifyRunReport_=__hB;runImport=__hRun;permanentIndexRowsForScan_=__hP;'); }
    assert.equal(gas.stubs.getLogLines().includes('HOUSE_ERROR=true'), true);
    assert.equal(gas.stubs.getLogLines().includes('RUN_AFTER_HOUSE'), true);
  });

  test('notify 25b: a Script Properties failure inside notification never stops scheduled import', () => {
    setupImport(false);
    gas.evaluate("var __pR=opsReleaseStalledLeases,__pH=opsRecoverStuckFiles,__pC=getActiveCustomers," +
      "__pB=notifyRunReport_,__pRun=runImport,__pP=permanentIndexRowsForScan_;" +
      "opsReleaseStalledLeases=function(){return [];};opsRecoverStuckFiles=function(){return [];};" +
      "getActiveCustomers=function(){return [];};notifyRunReport_=function(){};" +
      "runImport=function(){Logger.log('RUN_AFTER_PROPERTIES_FAILURE');return {runId:'R',customers:[],stoppedBy:null};};" +
      "permanentIndexRowsForScan_=function(){return [];};");
    gas.stubs.setGetScriptPropertiesFailures([null, 'properties boom']);
    try { assert.doesNotThrow(() => gas.call('scheduledImportTick', [])); }
    finally {
      gas.stubs.setGetScriptPropertiesFailures([]);
      gas.evaluate('opsReleaseStalledLeases=__pR;opsRecoverStuckFiles=__pH;getActiveCustomers=__pC;' +
        'notifyRunReport_=__pB;runImport=__pRun;permanentIndexRowsForScan_=__pP;');
    }
    assert.equal(gas.stubs.getLogLines().includes('RUN_AFTER_PROPERTIES_FAILURE'), true);
  });

  test('notify 26: released and rewound file ids stay in their customer bucket', () => {
    const result = plain(gas.call('housekeepingFindings_', [{released: 1, recovered: 1,
      releasedFileIds: ['f1'], recoveredFileIds: ['f1'], fileIds: ['f1']}, {f1: 'C001'}]));
    assert.equal(result.length, 1);
    assert.equal(result[0].bucket, 'C001');
    assert.equal(result[0].kind, 'INTERRUPTION_RECOVERED');
    assert.match(result[0].line, /リース解放 1 件・回復 1 件/);
  });

  test('notify 27: collection failure becomes STATUS_CHECK_FAILED without escaping', () => {
    resetNotify();
    gas.evaluate('var __sCollect=collectImportStatus_; collectImportStatus_=function(){throw new Error("collect boom");};');
    try { assert.doesNotThrow(() => gas.call('notifyImportState_', [{now: t0, source: 'TICK', customers}])); }
    finally { gas.evaluate('collectImportStatus_=__sCollect;'); }
    assert.equal(gas.stubs.getSentMails().length, 1);
    assert.match(gas.stubs.getSentMails()[0].body, /取込の状態を確認できませんでした/);
  });

  test('notify 28: an unauthorized run report creates a SYSTEM stop finding', () => {
    resetNotify();
    notifyReport({runId: 'RUN', stoppedBy: 'NO_AUTHORIZED_CUSTOMER', customers: []}, t0);
    const mail = gas.stubs.getSentMails()[0];
    assert.match(mail.subject, /システム: 定期取込停止 NO_AUTHORIZED_CUSTOMER/);
    assert.match(mail.body, /定期取込が実行前に停止/);
  });

  test('notify 29: watchdog trigger start is idempotent and stop functions do not cross-delete', () => {
    resetNotify();
    gas.call('opsStartScheduledImport', []);
    gas.call('opsStartNotificationWatchdog', []);
    const second = plain(gas.call('opsStartNotificationWatchdog', []));
    assert.equal(second.removedExisting, 1);
    assert.equal(gas.stubs.getTriggers().filter((item) => item.handler === 'notificationWatchdogTick').length, 1);
    assert.equal(gas.stubs.getTriggers().find((item) => item.handler === 'notificationWatchdogTick').hours, 1);
    gas.call('opsStopScheduledImport', []);
    assert.equal(gas.stubs.getTriggers().some((item) => item.handler === 'notificationWatchdogTick'), true);
    gas.call('opsStartScheduledImport', []);
    gas.call('opsStopNotificationWatchdog', []);
    assert.equal(gas.stubs.getTriggers().some((item) => item.handler === 'scheduledImportTick'), true);
  });

  test('notify 30: watchdog detects a stale DISCOVERED backlog once without a schedule trigger', () => {
    setupImport(false);
    const index = blank(13); Object.assign(index, {0: 'fileA', 1: 'C001', 2: 'a.csv', 3: 'DISCOVERED'});
    const process = blank(40); Object.assign(process, {5: 'C001', 7: 'fileA', 16: 'DISCOVERED', 1: at(-40).toISOString()});
    masterSheet('恒久ファイルインデックス').getRange(2, 1, 1, 13).setValues([index]);
    masterSheet('クレカ処理ログ').getRange(2, 1, 1, 40).setValues([process]);
    gas.call('notificationWatchdogTick', []);
    gas.call('notificationWatchdogTick', []);
    assert.equal(gas.stubs.getSentMails().length, 1);
    assert.match(gas.stubs.getSentMails()[0].subject, /取込待ちが止まっています 1件/);
  });

  test('notify 31: import-status screen ends with notification send and failure status lines', () => {
    setupImport(false);
    setProperty('NOTIFY_STATE_V1', {version: 1, day: '2026-09-09', sentToday: 1,
      lastSent: {at: t0.toISOString(), subject: '[クレカ自動処理] 要対応 顧客一(C001): 取込エラー 1件'},
      lastFailure: null, quota: null});
    gas.call('menuShowImportStatus', []);
    let text = gas.stubs.getUiEvents().at(-1).prompt;
    assert.match(text, /■ メール通知: 最終送信/);
    assert.match(text, /直近の失敗: なし/);
    setProperty('NOTIFY_STATE_V1', {version: 1, day: '2026-09-09', sentToday: 1, lastSent: null,
      lastFailure: {at: t0.toISOString(), reason: 'MAIL_SEND_FAILED', detail: 'secret'}, quota: null});
    gas.stubs.resetUiEvents();
    gas.call('menuShowImportStatus', []);
    text = gas.stubs.getUiEvents().at(-1).prompt;
    assert.match(text, /直近の失敗: .*MAIL_SEND_FAILED/);
  });

  test('notify 32: corrupt global or one corrupt bucket is isolated instead of stopping all notification', () => {
    resetNotify();
    setProperty('NOTIFY_STATE_V1', '{broken');
    assert.doesNotThrow(() => dispatch([finding('FAILED_FILES', 'C001', 'CRITICAL', ['f1'], 1)], t0));
    assert.equal(gas.stubs.getSentMails().length, 1);
    resetNotify();
    setProperty('NOTIFY_BUCKET_V1|C001', '{broken');
    const stable = {version: 1, episodes: {FAILED_FILES: {fingerprint: [], fingerprintHash: 'same',
      elementCount: 1, severity: 'CRITICAL', firstSeenAt: t0.toISOString(), lastSeenAt: t0.toISOString(),
      lastSentAt: t0.toISOString(), seenCount: 1, sentCount: 1}}, watch: {}};
    setProperty('NOTIFY_BUCKET_V1|C002', stable);
    dispatch([finding('FAILED_FILES', 'C001', 'CRITICAL', ['f1'], 1),
      finding('FAILED_FILES', 'C002', 'CRITICAL', ['f2'], 1)], at(10));
    assert.equal(gas.stubs.getSentMails().filter((mail) => /C001/.test(mail.subject)).length, 1);
    assert.equal(gas.stubs.getSentMails().filter((mail) => /C002/.test(mail.subject)).length, 0);
  });

  test('notify 33: garbage collection expires CRITICAL and WARNING episodes at twice their windows', () => {
    const state = {version: 1, episodes: {
      oldCritical: {severity: 'CRITICAL', lastSeenAt: at(-13 * 60).toISOString()},
      oldWarning: {severity: 'WARNING', lastSeenAt: at(-48 * 60 - 1).toISOString()},
      liveWarning: {severity: 'WARNING', lastSeenAt: at(-47 * 60).toISOString()}
    }, watch: {}};
    const gc = plain(gas.call('garbageCollectNotificationState_', [state, t0]));
    assert.equal(Object.hasOwn(gc.episodes, 'oldCritical'), false);
    assert.equal(Object.hasOwn(gc.episodes, 'oldWarning'), false);
    assert.equal(Object.hasOwn(gc.episodes, 'liveWarning'), true);
  });

  test('notify 33b: observed oversized episodes keep suppression while fingerprints shrink by UTF-8 bytes', () => {
    const episodes = {};
    for (let i = 1; i <= 40; i += 1) episodes['K' + String(i).padStart(2, '0')] = {
      fingerprint: Array.from({length: 10}, (_, j) => String(i).padStart(2, '0') + String(j).repeat(10)),
      fingerprintHash: String(i).padStart(16, '0'), elementCount: 10, severity: 'CRITICAL',
      firstSeenAt: t0.toISOString(), lastSeenAt: t0.toISOString(), lastSentAt: t0.toISOString(), seenCount: 1, sentCount: 1};
    const gc = plain(gas.call('garbageCollectNotificationState_', [{version: 1, episodes, watch: {}}, t0]));
    assert.equal(Object.keys(gc.episodes).length, 40);
    assert.equal(Object.values(gc.episodes).every((episode) => !episode.fingerprint || episode.fingerprint.length === 0), true);
    assert.ok(Buffer.byteLength(JSON.stringify(gc), 'utf8') <= 8500);
    const findings = Object.keys(gc.episodes).map((kind) => finding(kind, 'C001', 'CRITICAL', [], 10));
    assert.equal(plain(gas.call('evaluateEpisodes_', [{C001: gc}, findings, at(10)])).due.length, 0);
    const japanese = {};
    for (let i = 0; i < 20; i += 1) japanese['日'.repeat(10) + i] = Object.assign({}, episodes.K01);
    const source = {version: 1, episodes: japanese, watch: {}};
    assert.ok(JSON.stringify(source).length < 8500);
    assert.ok(Buffer.byteLength(JSON.stringify(source), 'utf8') > 8500);
    const japaneseGc = plain(gas.call('garbageCollectNotificationState_', [source, t0]));
    assert.equal(Object.values(japaneseGc.episodes).some((episode) => episode.fingerprint.length === 0), true);
  });

  test('notify 33c: minimal-state fallback retains every sent timestamp and drops only unsent episodes', () => {
    const episodes = {};
    for (let i = 0; i < 60; i += 1) episodes['LONG_KIND_' + i + '_' + 'x'.repeat(70)] = {
      fingerprint: Array(10).fill('123456789abc'), fingerprintHash: '1234567890abcdef', elementCount: 10,
      severity: 'CRITICAL', firstSeenAt: t0.toISOString(), lastSeenAt: t0.toISOString(),
      lastSentAt: i < 30 ? t0.toISOString() : null, seenCount: 9999, sentCount: 999};
    const gc = plain(gas.call('garbageCollectNotificationState_', [{version: 1, episodes, watch: {f: 1}}, t0]));
    assert.equal(Object.keys(gc.episodes).length, 30);
    assert.equal(Object.values(gc.episodes).every((episode) => episode.lastSentAt &&
      Object.keys(episode).sort().join(',') === ['elementCount', 'fingerprintHash', 'firstSeenAt', 'lastSeenAt', 'lastSentAt', 'severity'].sort().join(',')), true);
    assert.equal(Object.hasOwn(gc, 'watch'), false);
    const allFindings = Object.keys(episodes).map((kind) => finding(kind, 'C001', 'CRITICAL', [], 10));
    assert.equal(plain(gas.call('evaluateEpisodes_', [{C001: gc}, allFindings, at(10)])).due.length, 30);
  });

  test('notify 33d: the specified thirteen episodes and forty watch entries fit one bucket', () => {
    const kinds = ['FAILED_FILES', 'REPEATED_FAILURE', 'STALLED', 'IMPORT_IDLE', 'CUSTOMER_FIX',
      'ERROR_RECORDS', 'RUN_FILE_FAILED', 'RUN_CUSTOMER_SKIPPED', 'RUN_STOPPED', 'HOUSEKEEPING_FAILED',
      'STATUS_CHECK_FAILED', 'INTERRUPTION_RECOVERED', 'AUDIT_CHAIN_BROKEN'];
    const episodes = {};
    kinds.forEach((kind) => { episodes[kind] = {fingerprint: Array(10).fill('123456789abc'),
      fingerprintHash: '1234567890abcdef', elementCount: 10, severity: 'CRITICAL',
      firstSeenAt: t0.toISOString(), lastSeenAt: t0.toISOString(), lastSentAt: t0.toISOString(),
      seenCount: 9999, sentCount: 999}; });
    const watch = {};
    for (let i = 0; i < 40; i += 1) watch[('file' + i).padEnd(44, 'x')] = 999999;
    const source = {version: 1, episodes, watch};
    assert.ok(Buffer.byteLength(JSON.stringify(source), 'utf8') < 8500);
    const gc = plain(gas.call('garbageCollectNotificationState_', [source, t0]));
    assert.equal(Object.values(gc.episodes).every((episode) => episode.fingerprint.length === 10), true);
    const longGlobal = {version: 1, day: null, sentToday: 0,
      lastSent: {at: t0.toISOString(), subject: '日'.repeat(200)},
      lastFailure: {at: t0.toISOString(), reason: 'X', detail: '秘'.repeat(300)}, quota: null};
    resetNotify();
    setProperty('NOTIFY_STATE_V1', longGlobal);
    gas.call('writeNotificationState_', [getStoredState(), t0]);
    assert.ok(Buffer.byteLength(getProperty('NOTIFY_STATE_V1'), 'utf8') < 1024);
  });

  test('notify 34: test mail bypasses state and returns recipient and remaining quota', () => {
    resetNotify();
    gas.stubs.resetPropertyCallCounts();
    const result = plain(gas.call('opsSendTestNotification', []));
    assert.equal(result.sent, true);
    assert.equal(result.to, 'admin@example.com');
    assert.equal(result.remainingQuota, 99);
    assert.equal(gas.stubs.getPropertyCallCounts().getProperties, 0);
    gas.stubs.setMailQuota(0);
    assert.equal(plain(gas.call('opsSendTestNotification', [])).sent, false);
  });

  test('notify 35: importRunReportLines does not expose added error metadata', () => {
    resetNotify();
    gas.evaluate("var __lineRun=runImport;runImport=function(){return {runId:'R',stoppedBy:null,customers:[{customerId:'C001',skipped:null,files:[{fileName:'a.csv',outcome:'FAILED',nextState:'FAILED',category:null,code:null,written:0,reviews:0,elapsedMs:1,errorCode:'SECRET_CODE',errorName:'SECRET_NAME'}]}]};};");
    let lines;
    try { lines = plain(gas.call('importRunReportLines', [])); }
    finally { gas.evaluate('runImport=__lineRun;'); }
    assert.doesNotMatch(lines.join('\n'), /SECRET_CODE|SECRET_NAME/);
  });

  test('notify 36: existing lease and recovery ops keep their established return shapes', () => {
    setupImport(false);
    assert.deepEqual(plain(gas.call('opsShowLeases', [])), ['(リースなし)']);
    assert.deepEqual(plain(gas.call('opsReleaseStalledLeases', [])), []);
    assert.deepEqual(plain(gas.call('opsRecoverStuckFiles', [])), []);
  });
};

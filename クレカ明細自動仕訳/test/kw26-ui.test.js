'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {browserWorld} = require('./kw26-ui-helpers');
const plain = x => JSON.parse(JSON.stringify(x));
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

module.exports = ({test, assert}) => {
  function asyncTest(name, fn) {
    if (process.argv[2] === '--case') { if (process.argv[3] === name) test(name, fn); }
    else test(name, () => assert.match(execFileSync(process.execPath, [__filename, '--case', name],
      {encoding: 'utf8', timeout: 30000}), /^CASE_DONE$/m));
  }
  function world(ids = ['f1', 'f2', 'f3', 'f4', 'f5'], prep = {}, lanes = 2) {
    const w = browserWorld({webAppPrepareImport: Object.assign({fileIds: ids,
      destinationSpreadsheetId: 'copy', lanes: 2, maxFilesPerCall: 6}, prep),
      webAppRunImport: {defer: true}, webAppListFolder: {kind: 'FILES', files: []},
      webAppListReviews: {reviews: [], total: 0, otherCounts: {}}});
    Object.assign(w.ui.state, {importLanes: lanes, maxFilesPerImport: 6,
      customers: [{customerId: 'C001', customerName: 'customer', canImport: true}],
      selectedCustomerId: 'C001', selectedFolderId: 'card'});
    w.start = () => { w.finished = w.ui.startImport(); return tick(); };
    w.runs = () => w.pending.filter(p => p.name === 'webAppRunImport');
    w.notice = () => w.ids.notice.textContent;
    return w;
  }
  const success = (pending, overrides = {}) => Object.assign({done: pending.args[2].fileIds.length,
    fileResults: pending.args[2].fileIds.map(fileId => ({fileId, outcome: 'WRITTEN'})),
    notStarted: [], skipped: [], stoppedBy: null}, overrides);

  function waitingResponse(now, overrides = {}) {
    return Object.assign({done: 0, total: 0, remaining: 0, fileResults: [], stoppedBy: null,
      waitingFiles: {count: 1, readyAt: new Date(now + 7 * 60000).toISOString(),
        serverNow: new Date(now).toISOString()}}, overrides);
  }

  function waitWorld(response, now) {
    const w = browserWorld({
      webAppRunImport: response,
      webAppListFolder: {kind: 'FILES', files: []},
      webAppListReviews: {reviews: [], total: 0, otherCounts: {}}
    }, {clock: true, now});
    Object.assign(w.ui.state, {importLanes: 1, maxFilesPerImport: 6,
      customers: [{customerId: 'C001', customerName: 'customer', canImport: true}],
      selectedCustomerId: 'C001', selectedFolderId: 'card'});
    w.start = () => { w.finished = w.ui.startImport(); return tick(); };
    w.notice = () => w.ids.notice.textContent;
    w.listFolderCalls = () => w.calls.filter(c => c.name === 'webAppListFolder').length;
    return w;
  }
  asyncTest('kw26 18: two pending lane calls split five files three and two', async () => {
    const w = world(); await w.start(); const runs = w.runs(); assert.equal(runs.length, 2);
    assert.deepEqual(plain(runs.map(r => r.args[2])), [
      {destinationSpreadsheetId: 'copy', fileIds: ['f1', 'f2', 'f3'], lane: 0},
      {destinationSpreadsheetId: 'copy', fileIds: ['f4', 'f5'], lane: 1}]);
    runs.forEach(r => r.reply(success(r))); await w.finished;
  });
  asyncTest('kw26 19: notStarted returns to front skipped shrinks total and no other file repeats', async () => {
    const w = world(['f1', 'f2', 'f3', 'f4']); await w.start(); const [a, b] = w.runs();
    assert.ok(a && b);
    a.reply(success(a, {done: 1, fileResults: [{fileId: 'f1', outcome: 'WRITTEN'}], notStarted: ['f2']}));
    await tick(); const c = w.runs()[2]; assert.deepEqual(plain(c.args[2].fileIds), ['f2']);
    b.reply(success(b, {done: 1, fileResults: [{fileId: 'f3', outcome: 'WRITTEN'}], skipped: ['f4']}));
    await tick(); assert.match(w.ids['import-progress-value'].textContent, /^2 \/ 3/);
    c.reply(success(c)); await w.finished;
    assert.match(w.notice(), /3 件/);
    const sent = w.runs().flatMap(r => r.args[2].fileIds);
    assert.deepEqual(plain(sent), ['f1', 'f2', 'f3', 'f4', 'f2']);
  });
  asyncTest('kw26 20: empty queue waits for a peer and processes its returned work', async () => {
    const w = world(['f1', 'f2', 'f3']); await w.start(); const [a, b] = w.runs();
    assert.ok(a && b); b.reply(success(b)); await tick();
    assert.equal(w.ui.state.importBusy, true);
    assert.deepEqual(plain(w.promiseGroups[0]), [false, false], 'both workers wait while a peer may return work');
    a.reply(success(a, {done: 1, fileResults: [{fileId: 'f1', outcome: 'WRITTEN'}], notStarted: ['f2']}));
    await tick(); const c = w.runs()[2]; assert.deepEqual(plain(c.args[2].fileIds), ['f2']);
    c.reply(success(c)); await w.finished; assert.match(w.notice(), /3 件/);
  });
  asyncTest('kw26 21: first failure stops dispatch while peer completes for stop and exception', async () => {
    for (const reason of ['FILE_FAILED', 'INTEGRITY_STOP', 'exception']) {
      const w = world(Array.from({length: 16}, (_, i) => 'f' + i)); await w.start();
      const [a, b] = w.runs(); assert.ok(a && b);
      if (reason === 'exception') a.reject(new Error('lane exception'));
      else a.reply(success(a, {stoppedBy: reason}));
      await tick(); assert.equal(w.ui.state.importBusy, true); assert.equal(w.runs().length, 2);
      b.reply(success(b)); await w.finished; assert.equal(w.runs().length, 2);
      assert.equal(w.notice(), reason === 'exception' ? 'lane exception' :
        reason === 'FILE_FAILED' ? w.ui.TEXT.stuckFile : w.ui.TEXT.integrityStop);
    }
  });
  // 1 本も始めずに全部を返した呼出しの後は止める。止めないと同じファイルを
  // 送り直し続ける（私の監査の変異 X18 がすり抜けた）。
  asyncTest('kw26 21b: a lane call that starts nothing stops the press without resending', async () => {
    const w = world(['f1', 'f2', 'f3', 'f4']); await w.start(); const [a, b] = w.runs();
    assert.ok(a && b);
    a.reply(success(a, {done: 0, fileResults: [], notStarted: a.args[2].fileIds}));
    await tick(); assert.equal(w.runs().length, 2, 'the same files must not be sent again');
    b.reply(success(b)); await w.finished;
    assert.equal(w.runs().length, 2);
    assert.equal(w.notice(), w.ui.TEXT.timeBudget);
  });
  asyncTest('kw26 22: stopped or empty preparation never dispatches lanes', async () => {
    for (const code of ['IMPORT_IN_PROGRESS', 'PARALLEL_DISABLED', 'INTEGRITY_STOP', null]) {
      const w = world([], {stoppedBy: code}); await w.start(); await w.finished;
      assert.equal(w.runs().length, 0);
      const key = {IMPORT_IN_PROGRESS: 'importInProgress', PARALLEL_DISABLED: 'parallelDisabled',
        INTEGRITY_STOP: 'integrityStop'}[code] || 'noFiles';
      assert.equal(w.notice(), w.ui.TEXT[key]);
    }
  });
  asyncTest('kw26 23: stale selection cannot dispatch mutate state or show notices', async () => {
    const w = world(); await w.start(); assert.equal(w.runs().length, 2);
    w.ui.state.viewGeneration++; w.ui.state.selectedCustomerId = 'C002';
    w.ui.state.lastCompletedDestinationSpreadsheetId = 'new';
    w.ids.notice.textContent = 'new notice';
    w.runs().forEach(r => r.reply(success(r, {notStarted: r.args[2].fileIds, done: 0, fileResults: []})));
    await w.finished; assert.equal(w.runs().length, 2); assert.equal(w.notice(), 'new notice');
    assert.equal(w.ui.state.lastCompletedDestinationSpreadsheetId, 'new');
    assert.deepEqual(plain(w.ui.state.sessionFileIds), []);
  });
  asyncTest('kw26 24: one lane preserves legacy empty options then destination continuation', async () => {
    const w = world([], {}, 1); await w.start();
    assert.equal(w.calls.filter(c => c.name === 'webAppPrepareImport').length, 0);
    const a = w.runs()[0]; assert.deepEqual(plain(a.args[2]), {});
    a.reply({done: 1, remaining: 1, destinationSpreadsheetId: 'copy', fileResults: []}); await tick();
    const b = w.runs()[1]; assert.deepEqual(plain(b.args[2]), {destinationSpreadsheetId: 'copy'});
    b.reply({done: 1, remaining: 0, fileResults: []}); await w.finished;
  });
  asyncTest('kw26 25: progress hint follows oldest call tokens and supports tokenless resolve', async () => {
    const w = world(); let now = 100000;
    const timer = w.ui.startProgressTimer('import-progress', () => true, {now: () => now});
    const a = timer.beginCall(); now += 40000; const b = timer.beginCall(); now += 20001;
    timer.update(1, 4); assert.equal(w.ids['import-progress-hint'].hidden, false);
    assert.notEqual(a, b); timer.endCall(a); assert.equal(w.ids['import-progress-hint'].hidden, true);
    now += 40000; timer.update(2, 3); assert.equal(w.ids['import-progress-hint'].hidden, false);
    timer.endCall(b); assert.equal(w.ids['import-progress-hint'].hidden, true); timer.stop();
    const resolve = w.ui.startProgressTimer('resolve-progress', () => true, {now: () => now});
    resolve.beginCall(); now += 60001; resolve.update(0, 1);
    assert.equal(w.ids['resolve-progress-hint'].hidden, false);
    resolve.endCall(); assert.equal(w.ids['resolve-progress-hint'].hidden, true); resolve.stop();
  });
  asyncTest('kw26 26: both lanes contribute session files and final cleanup refreshes once', async () => {
    const w = world(); await w.start(); assert.equal(w.runs().length, 2);
    w.runs().forEach(r => r.reply(success(r))); await w.finished;
    assert.equal(w.ui.state.lastCompletedDestinationSpreadsheetId, 'copy');
    assert.deepEqual(plain(w.ui.state.sessionFileIds).sort(), ['f1', 'f2', 'f3', 'f4', 'f5']);
    for (const name of ['webAppListFolder', 'webAppListReviews'])
      assert.equal(w.calls.filter(c => c.name === name).length, 1);
    assert.equal(w.ui.state.importBusy, false);
  });

  asyncTest('waitu 1: 1本も取り込めないとき、お知らせと前面のダイアログに待ち時間を出す', async () => {
    const now = Date.UTC(2026, 0, 15, 3, 0, 0);
    const w = waitWorld(waitingResponse(now, {waitingFiles: {
      count: 2, readyAt: new Date(now + 7 * 60000).toISOString(),
      serverNow: new Date(now).toISOString()}}), now);
    await w.start(); await w.finished;
    assert.equal(w.notice(),
      'まだ取り込めないファイルが 2 本あります。あと 7 分たってから、もう一度［記帳を実行］を押してください。');
    assert.equal(w.ids['wait-dialog'].open, true);
    assert.equal(w.ids['wait-title'].textContent, 'まだ取り込めないファイルがあります');
    assert.equal(w.ids['wait-big'].textContent, 'あと 7 分 お待ちください');
    assert.match(w.ids['wait-desc2'].textContent, /^\d{2}:\d{2} ごろに、もう一度［記帳を実行］を押してください。$/);
    assert.equal(w.ids['wait-desc2'].hidden, false);
    assert.equal(w.ids['wait-run'].hidden, true);
    assert.equal(w.ids['wait-close'].hidden, false);
    assert.equal(w.ids['wait-desc1'].textContent,
      '置いたばかりのファイルが 2 本あります。ファイルを置いてから 10 分たつと取り込めます。');
  });

  asyncTest('waitu 2: 一部だけ取り込めたときも件数と残りの待ちを出す', async () => {
    const now = Date.UTC(2026, 0, 15, 3, 10, 0);
    const w = waitWorld(waitingResponse(now, {done: 1, total: 1, remaining: 0,
      fileResults: [{fileId: 'f1', outcome: 'WRITTEN'}],
      waitingFiles: {count: 1, readyAt: new Date(now + 7 * 60000).toISOString(),
        serverNow: new Date(now).toISOString()}}), now);
    await w.start(); await w.finished;
    assert.equal(w.notice(),
      '1 件を取り込みました。まだ取り込めないファイルが 1 本あります。あと 7 分たってから、もう一度［記帳を実行］を押してください。');
    assert.equal(w.ids['wait-dialog'].open, true);
    assert.equal(w.ids['wait-desc3'].hidden, false);
    assert.equal(w.ids['wait-desc3'].textContent, '（ほかの 1 件は取り込みました）');
    assert.equal(w.ids['wait-big'].textContent, 'あと 7 分 お待ちください');
  });

  asyncTest('waitu 3: stoppedBy・時間切れ・待ち0本ではダイアログを出さない', async () => {
    const now = Date.UTC(2026, 0, 15, 3, 20, 0);
    const cases = [
      waitingResponse(now, {stoppedBy: 'LEASE_CONFLICT', waitingFiles: {
        count: 1, readyAt: new Date(now + 7 * 60000).toISOString(),
        serverNow: new Date(now).toISOString()}}),
      waitingResponse(now, {done: 0, total: 1, remaining: 1}),
      {done: 0, total: 0, remaining: 0, fileResults: [], stoppedBy: null, waitingFiles: null}
    ];
    for (const response of cases) {
      const w = waitWorld(response, now);
      await w.start(); await w.finished;
      assert.equal(w.ids['wait-dialog'].open, false);
      assert.equal(w.ids['wait-run'].hidden, true);
    }
  });

  asyncTest('waitu 4: 1分ごとに減り、時刻を過ぎると表示が変わり一覧を1回読み直す', async () => {
    const now = Date.UTC(2026, 0, 15, 3, 30, 0);
    const w = waitWorld(waitingResponse(now, {waitingFiles: {
      count: 1, readyAt: new Date(now + 3 * 60000).toISOString(),
      serverNow: new Date(now).toISOString()}}), now);
    await w.start(); await w.finished;
    assert.equal(w.ids['wait-big'].textContent, 'あと 3 分 お待ちください');
    const listCalls = w.listFolderCalls();
    w.advance(60000); await tick();
    assert.equal(w.ids['wait-big'].textContent, 'あと 2 分 お待ちください');
    w.advance(60000); await tick();
    assert.equal(w.ids['wait-big'].textContent, 'あと 1 分 お待ちください');
    w.advance(60000); await tick();
    assert.equal(w.ids['wait-title'].textContent, '取り込めるようになりました');
    assert.equal(w.ids['wait-big'].textContent, '［記帳を実行］を押してください');
    assert.equal(w.ids['wait-desc2'].hidden, true);
    assert.equal(w.ids['wait-run'].hidden, false);
    assert.equal(w.listFolderCalls(), listCalls + 1, '時刻が来たときに1回だけ読み直す');

    // サーバーの時計が3分進んでいても、ずれを引いた残りを出す。
    const ahead = Date.UTC(2026, 0, 15, 3, 40, 0);
    const w2 = waitWorld(waitingResponse(ahead, {waitingFiles: {
      count: 1, readyAt: new Date(ahead + 4 * 60000).toISOString(),
      serverNow: new Date(ahead + 3 * 60000).toISOString()}}), ahead);
    await w2.start(); await w2.finished;
    assert.equal(w2.ids['wait-big'].textContent, 'あと 1 分 お待ちください');
    w2.advance(60000); await tick();
    assert.equal(w2.ids['wait-title'].textContent, '取り込めるようになりました');
  });

  asyncTest('waitu 5: 時刻が来ても自動で始めず、押したときだけ1回始める', async () => {
    const now = Date.UTC(2026, 0, 15, 3, 50, 0);
    let runs = 0;
    const w = waitWorld(() => {
      runs += 1;
      if (runs === 1) return waitingResponse(now, {waitingFiles: {
        count: 1, readyAt: new Date(now + 60000).toISOString(),
        serverNow: new Date(now).toISOString()}});
      return {done: 1, total: 1, remaining: 0, stoppedBy: null,
        fileResults: [{fileId: 'f1', outcome: 'WRITTEN'}], waitingFiles: null};
    }, now);
    await w.start(); await w.finished;
    assert.equal(w.ids['wait-run'].hidden, true);
    assert.equal(runs, 1);
    w.advance(60000); await tick();
    assert.equal(w.ids['wait-run'].hidden, false);
    assert.equal(runs, 1, '時刻が来ただけでは取込を始めない');
    w.ids['wait-run'].fire('click');
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(w.ids['wait-dialog'].open, false);
    assert.equal(runs, 2, '押したときだけ、ちょうど1回始める');

    // 閉じたらタイマーを止める。時計を進めても表示も一覧の読み直しも起きない。
    const w2 = waitWorld(waitingResponse(now, {waitingFiles: {
      count: 1, readyAt: new Date(now + 60000).toISOString(),
      serverNow: new Date(now).toISOString()}}), now);
    await w2.start(); await w2.finished;
    const listCalls = w2.listFolderCalls();
    w2.ids['wait-close'].fire('click');
    assert.equal(w2.ids['wait-dialog'].open, false);
    assert.equal(w2.intervals.size, 0, '閉じたらタイマーを止める');
    w2.advance(180000); await tick();
    assert.equal(w2.ids['wait-big'].textContent, 'あと 1 分 お待ちください');
    assert.equal(w2.listFolderCalls(), listCalls);
  });

  asyncTest('waitu 6: 顧客かフォルダを選び直すとダイアログを閉じる', async () => {
    const now = Date.UTC(2026, 0, 15, 4, 0, 0);
    const byCustomer = waitWorld(waitingResponse(now), now);
    await byCustomer.start(); await byCustomer.finished;
    assert.equal(byCustomer.ids['wait-dialog'].open, true);
    byCustomer.ui.chooseCustomer('C002'); await tick();
    assert.equal(byCustomer.ids['wait-dialog'].open, false);

    const byFolder = waitWorld(waitingResponse(now), now);
    await byFolder.start(); await byFolder.finished;
    assert.equal(byFolder.ids['wait-dialog'].open, true);
    byFolder.ui.chooseFolder('card2'); await tick();
    assert.equal(byFolder.ids['wait-dialog'].open, false);
  });

  asyncTest('waitu 7: 大きな行だけが1.2秒で点滅し、reduceでは止め、文字はtextContentで入れる', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', '81_WebAppUi.html'), 'utf8');
    assert.match(source, /\.wait-big\.blink \{ animation: wait-notice-blink 1\.2s ease-in-out infinite; \}/);
    assert.match(source, /@media \(prefers-reduced-motion: reduce\) \{\s*\.wait-big\.blink \{ animation: none; opacity: 1; \}/);
    assert.equal(source.includes('innerHTML'), false);
    const now = Date.UTC(2026, 0, 15, 4, 10, 0);
    const w = waitWorld(waitingResponse(now), now);
    await w.start(); await w.finished;
    assert.equal(w.ids['wait-big'].className, 'wait-big waiting blink');
    assert.equal(w.ids['wait-big'].children[0].tagName, '#TEXT');
    assert.equal(w.ids['wait-big'].children[0].textContent, 'あと 7 分 お待ちください');
  });
};

if (require.main === module) {
  const tests = []; module.exports({assert: require('node:assert/strict'), test: (name, fn) => tests.push(fn)});
  Promise.resolve().then(() => tests[0]()).then(() => console.log('CASE_DONE'))
    .catch(e => { console.error(e.stack); process.exitCode = 1; });
}

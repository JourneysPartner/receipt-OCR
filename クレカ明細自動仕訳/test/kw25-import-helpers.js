'use strict';

// 取込の準備は phase8 の実表・CSV の補助を使い、判定そのものは差し替えない。
module.exports = ({test, assert, gas, setupWorld, putCsv, createWebDestination,
  webImport, importFileResults, openReviewsFor, withMocks, call, plain}) => {
  const master = name => gas.stubs.getSpreadsheet('master').getSheetByName(name);
  const snapshot = s => plain({values: s.values, formulas: s.formulas});
  function scenario(kind, approved = false) {
    const {customer} = setupWorld({knownMerchant: kind !== 'purpose'});
    const fileId = putCsv(customer, {fileId: 'kw25_B', rows: [
      '2025/12/10,' + (kind === 'purpose' ? '未登録店' : '既知店') + ',1000,仕入れ']});
    const destinationSpreadsheetId = createWebDestination(customer);
    const dest = gas.stubs.getSpreadsheet(destinationSpreadsheetId).getSheetByName('入力用シート');
    const before = snapshot(dest); let fired = 0; let target = null; let hash = null;
    let increments = 0; let pre; let scans = 0; let processing = false; const fullReads = [];
    const real = Object.fromEntries(['withScriptLock_', 'updateProcessLogAndContentHash_', 'registerPrepared',
      'incrementRunTransactionCount', 'runPreValidationBlock', 'permanentIndexRowsForScan_',
      'processDiscoveredFile_', 'sheetsReadRanges_', 'getCategory2Approvals'].map(k => [k, gas.context[k]]));
    const year = Number(call('nowIso_').slice(0, 4));
    gas.call('getTxIndexSheet', [customer.customerId, year, true]);
    const originalIndex = gas.stubs.getSpreadsheet('txidx').getSheets()[0];
    const indexReads = [];
    const result = withMocks({
      processDiscoveredFile_: (...args) => { processing = true; try { return real.processDiscoveredFile_(...args); } finally { processing = false; } },
      permanentIndexRowsForScan_: (...args) => { if (processing) scans++; return real.permanentIndexRowsForScan_(...args); },
      sheetsReadRanges_: (s, ranges) => {
        if (processing && ranges.some(r => /恒久ファイルインデックス.*!A2:M$/.test(r))) {
          fullReads.push({locked: gas.stubs.getScriptLock().locked, target: target?.name});
        }
        if (target?.name === 'registerPrepared' && s.getParent().getId() === 'txidx') indexReads.push(plain(ranges));
        return real.sheetsReadRanges_(s, ranges);
      },
      updateProcessLogAndContentHash_: (...args) => {
        hash = args[1].submittedContentHash; target = {name: 'updateProcessLogAndContentHash_', args};
        try { return real.updateProcessLogAndContentHash_(...args); } finally { target = null; }
      },
      registerPrepared: (...args) => {
        target = {name: 'registerPrepared', args};
        try { return real.registerPrepared(...args); } finally { target = null; }
      },
      withScriptLock_: callback => real.withScriptLock_(() => {
        if (!fired && target && target.name === (kind === 'purpose' ? 'registerPrepared' : 'updateProcessLogAndContentHash_')) {
          assert.equal(gas.stubs.getScriptLock().locked, true); fired++;
          if (kind === 'purpose') {
            const rows = target.args[0].map((tx, i) => ['kw25_A_' + i, customer.customerId, 'kw25_A',
              tx.occurrenceIndex, tx.identityHash, 'OTHER_HASH', gas.evaluate('VERSIONS.HASH'),
              'NOT_IMPORTED', true, '2026-01-01', '2026-01-01']);
            originalIndex._write(2, 1, rows, false);
          } else if (kind === 'duplicate') {
            master('恒久ファイルインデックス')._write(3, 1, [['kw25_A', customer.customerId, '', '', '', hash,
              gas.evaluate('VERSIONS.HASH')]], false);
          }
        }
        return callback();
      }),
      getCategory2Approvals: (...args) => approved ? [{code: 'PURPOSE_REVISION_CANDIDATE', contentHash: hash,
        hashVersion: gas.evaluate('VERSIONS.HASH')}] : real.getCategory2Approvals(...args),
      incrementRunTransactionCount: (...args) => { increments++; return real.incrementRunTransactionCount(...args); },
      runPreValidationBlock: (...args) => { pre = real.runPreValidationBlock(...args); return pre; }
    }, () => webImport(customer, {destinationSpreadsheetId}));
    assert.equal(fired, 1);
    const file = importFileResults(result).find(f => f.fileId === fileId);
    assert.ok(file, JSON.stringify(result));
    return {customer, fileId, file, before, after: snapshot(dest), pre, increments, fullReads, scans, indexReads,
      reviews: openReviewsFor(customer.customerId, {fileId}), index: originalIndex};
  }
  function assertStopped(s, code) {
    assert.equal(s.file.category, 2, JSON.stringify(s.file)); assert.equal(s.file.code, code);
    assert.equal(s.file.nextState, 'REVIEW_WAIT');
    assert.equal(s.reviews.length, 1); assert.equal(s.reviews[0].reviewType, 'DUPLICATE');
    assert.equal(s.reviews[0].fullTxId || null, null);
    assert.equal(master('クレカ取引ログ').values.filter(r => r[4] === s.fileId).length, 0);
    assert.equal(s.index.values.filter(r => r[2] === s.fileId).length, 0);
    assert.deepEqual(s.after, s.before);
    assert.equal(s.increments, 0);
    assert.deepEqual(plain(s.pre.transactions), []);
    assert.equal(s.pre.pendingReviews.length, 1);
    assert.equal(s.pre.pendingReviews[0].reviewType, 'DUPLICATE');
  }
  test('kw25 1: concurrent content hash winner stops B before transactions or destination writes', () => {
    const s = scenario('duplicate'); assertStopped(s, 'DUPLICATE_CONTENT');
    assert.ok(master('恒久ファイルインデックス').values.find(r => r[0] === s.fileId)[5]);
  });
  test('kw25 2: sequential same-content import keeps A and stops B', () => {
    const {customer} = setupWorld({knownMerchant: true});
    const rows = ['2025/12/10,既知店,1000,仕入れ'];
    putCsv(customer, {fileId: 'kw25_A', rows});
    const a = webImport(customer); assert.equal(importFileResults(a)[0].outcome, 'WRITTEN');
    const before = plain(master('クレカ取引ログ').values.filter(r => r[4] === 'kw25_A'));
    putCsv(customer, {fileId: 'kw25_B', rows});
    const b = webImport(customer, {destinationSpreadsheetId: a.destinationSpreadsheetId});
    assert.equal(importFileResults(b).find(f => f.fileId === 'kw25_B').code, 'DUPLICATE_CONTENT');
    assert.deepEqual(plain(master('クレカ取引ログ').values.filter(r => r[4] === 'kw25_A')), before);
  });
  test('kw25 5: file processing reads the full permanent index only inside the hash lock', () => {
    const s = scenario('normal'); assert.equal(s.file.outcome, 'WRITTEN');
    assert.equal(s.scans, 0);
    assert.deepEqual(s.fullReads, [{locked: true, target: 'updateProcessLogAndContentHash_'}]);
  });
  test('kw25 6: concurrent purpose revision stops before writes counts and partner reviews', () => {
    const s = scenario('purpose'); assertStopped(s, 'PURPOSE_REVISION_CANDIDATE');
    assert.equal(s.pre.detail.purposeRevisionInLock, true);
    const logs = gas.stubs.getLogs().filter(l => l.startsWith('PURPOSE_REVISION_IN_LOCK '));
    assert.equal(logs.length, 1);
    assert.deepEqual(JSON.parse(logs[0].slice('PURPOSE_REVISION_IN_LOCK '.length)), {fileId: 'kw25_B', matchedFileId: 'kw25_A'});
  });
  test('kw25 8: approved purpose revision still registers and writes with one index read', () => {
    const s = scenario('purpose', true);
    assert.equal(s.file.outcome, 'WRITTEN', JSON.stringify(s.file)); assert.equal(s.increments, 1);
    assert.equal(s.indexReads.length, 1); assert.equal(s.indexReads[0].length, 1);
    assert.equal(s.index.values.filter(r => r[2] === s.fileId).length, 1);
    assert.ok(!s.reviews.some(r => r.reviewType === 'DUPLICATE'));
  });
};

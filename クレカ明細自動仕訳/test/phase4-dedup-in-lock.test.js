'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = ({test, assert, gas}) => {
  const plain = x => JSON.parse(JSON.stringify(x));
  const call = (name, args = []) => gas.call(name, args);
  const sheet = name => gas.stubs.getSpreadsheet('master').getSheetByName(name);
  const snapshot = target => plain(target.values);
  const counts = () => plain(gas.stubs.getApiCallCounts());
  const year = () => Number(call('nowIso_').slice(0, 4));
  const version = () => gas.evaluate('VERSIONS.HASH');
  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: 'seed', values: [['header']]}]});
    call('setMasterSpreadsheetId', ['master']); call('provisionMasterSheets');
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.evaluate("SETTINGS.TX_INDEX_SPREADSHEET_ID='txidx'; resetApiReadWindow_();");
  }
  function tx(id = 'B1', identity = 'I1') {
    return {fullTxId: id, customerId: 'C001', fileId: 'B', identityHash: identity,
      occurrenceIndex: id === 'B1' ? 1 : 2, contentHash: 'NEW', hashVersion: version(),
      originalMerchant: 'merchant', originalAmount: 100, purpose: 'new',
      planned: {b: '2026-01-01', f: 'partner', i: 'new', k: 'merchant', m: 100}};
  }
  function options(txs = [tx()]) {
    return {purposeRevision: {customerId: 'C001', identityHashes: txs.map(t => t.identityHash),
      contentHash: 'NEW', hashVersion: version()}};
  }
  function index(y = year(), create = true) { return call('getTxIndexSheet', ['C001', y, create]); }
  function oldRows(txs = [tx()]) {
    return txs.map((t, i) => ['A' + i, 'C001', 'A', i + 1, t.identityHash, 'OLD',
      version(), 'NOT_IMPORTED', true, '2026-01-01', '2026-01-01']);
  }
  function withMocks(mocks, fn) {
    const saved = {};
    Object.keys(mocks).forEach(k => { saved[k] = gas.context[k]; gas.context[k] = mocks[k]; });
    try { return fn(); } finally { Object.assign(gas.context, saved); }
  }
  function atLock(inject, fn) {
    const original = gas.context.withScriptLock_; let fired = false;
    const result = withMocks({withScriptLock_: callback => original(() => {
      assert.equal(gas.stubs.getScriptLock().locked, true);
      if (!fired) { fired = true; inject(); }
      return callback();
    })}, fn);
    assert.equal(fired, true); return result;
  }
  function watch(fn) {
    const requests = []; const lastReads = []; const read = gas.context.sheetsReadRanges_;
    const last = gas.context.apiLastDataRow_;
    gas.stubs.resetApiCallCounts();
    const result = withMocks({sheetsReadRanges_: (s, ranges) => {
      requests.push({id: s.getParent().getId(), ranges: plain(ranges), locked: gas.stubs.getScriptLock().locked});
      return read(s, ranges);
    }, apiLastDataRow_: (s, w) => { lastReads.push(s.getName()); return last(s, w); }}, fn);
    return {result, requests, lastReads, counts: counts()};
  }
  function seedFile(id = 'B') {
    return call('createOrUpdateProcessLog', ['RUN', {customerId: 'C001'},
      {id, originalFileName: id + '.csv', hashVersion: version(), state: 'VALIDATING'}]);
  }
  function hash() {
    return call('updateProcessLogAndContentHash_', ['B', {submittedContentHash: 'NEW'},
      {customerId: 'C001', hashVersion: version()}]);
  }
  ['self', 'customer', 'version'].forEach(kind => test('kw25 3: duplicate excludes ' + kind, () => {
    setup(); seedFile();
    const row = ['A', 'C001', '', '', '', 'NEW', version()];
    if (kind === 'self') sheet('恒久ファイルインデックス').values[1][5] = 'NEW';
    else { row[kind === 'customer' ? 1 : 6] = 'OTHER'; sheet('恒久ファイルインデックス')._write(3, 1, [row], false); }
    assert.equal(hash().duplicate?.duplicate, false);
  }));
  ['known', 'missing', 'stale'].forEach(kind => test('kw25 4: one hash read with ' + kind + ' index position', () => {
    setup(); const b = seedFile(); seedFile('A');
    if (kind === 'missing') delete gas.context.fileRowNumberCache_.index.B;
    if (kind === 'stale') gas.context.fileRowNumberCache_.index.B = 3;
    const other = plain(sheet('恒久ファイルインデックス').values[2]);
    const measured = watch(hash);
    assert.equal(measured.counts.batchGet, 1);
    assert.equal(measured.counts.batchUpdate, 1);
    assert.equal(sheet('恒久ファイルインデックス').values[b.permanent.rowNumber - 1][5], 'NEW');
    assert.deepEqual(sheet('恒久ファイルインデックス').values[2], other);
    assert.equal(gas.context.fileRowNumberCache_.index.B, b.permanent.rowNumber);
    assert.ok(measured.requests[0].ranges.some(r => /!A2:M$/.test(r)));
  }));
  test('kw25 4b: a stale process-log position is rechecked and the other file keeps its row', () => {
    // 覚えた行番号が別のファイルの行を指していたら、H列の照合で外して引き直す。
    // 外さないと、ハッシュと版の列を別のファイルの処理ログ行へ書いてしまう。
    setup(); const b = seedFile(); const a = seedFile('A');
    gas.context.fileRowNumberCache_.process.B = a.process.rowNumber;
    const log = sheet('クレカ処理ログ');
    const other = plain(log.values[a.process.rowNumber - 1]);
    hash();
    assert.equal(log.values[b.process.rowNumber - 1][12], 'NEW');
    assert.deepEqual(plain(log.values[a.process.rowNumber - 1]), other);
    assert.equal(gas.context.fileRowNumberCache_.process.B, b.process.rowNumber);
  });
  test('kw25 4: duplicate own keys reject before either table is written', () => {
    setup(); seedFile(); const target = sheet('恒久ファイルインデックス');
    target._write(3, 1, [target.values[1].slice()], false);
    const before = snapshot(target); const log = snapshot(sheet('クレカ処理ログ'));
    assert.throws(hash, e => e.code === 'TRANSACTION_LOG_AMBIGUOUS' && /Duplicate permanent file index fileId/.test(e.message));
    assert.deepEqual(snapshot(target), before); assert.deepEqual(snapshot(sheet('クレカ処理ログ')), log);
  });
  test('kw25 7: a mixed rejoin candidate writes no existing or new transaction cells', () => {
    setup(); const txs = [tx(), tx('B2', 'I2')];
    call('registerPrepared', [[txs[0]], 'OLD_RUN']);
    const target = index(); const before = snapshot(sheet('クレカ取引ログ'));
    const changed = txs.map(t => ({...t, originalMerchant: 'changed', planned: {...t.planned, i: 'changed'}}));
    const result = atLock(() => target._write(3, 1, oldRows(txs), false), () =>
      call('registerPrepared', [changed, 'NEW_RUN', undefined, options(txs)]));
    assert.deepEqual(snapshot(sheet('クレカ取引ログ')), before);
    assert.equal(result.registered, false); assert.equal(result.purposeRevision.candidate, true);
    assert.equal(target.values.filter(r => r[2] === 'B').length, 1);
  });
  [false, true].forEach(enabled => test('kw25 9: registration reads and true tail with check=' + enabled, () => {
    setup(); const previous = index(year() - 1); const current = index();
    previous._write(12, 1, [['PREVIOUS_TAIL']], false);
    current._write(5, 1, [['CURRENT_TAIL']], false);
    const before = snapshot(previous);
    gas.stubs.setStaleSpreadsheetAppView('txidx', current.getName(), {lastRow: 2});
    const measured = watch(() => call('registerPrepared', [[tx()], 'RUN', {}, enabled ? options() : undefined]));
    assert.equal(measured.counts.batchGet, 2);
    assert.equal(measured.counts.batchUpdate, 2);
    assert.equal(current.values[5][0], 'B1'); assert.equal(current.values[4][0], 'CURRENT_TAIL');
    assert.deepEqual(snapshot(previous), before);
    const req = measured.requests.filter(r => r.id === 'txidx'); assert.equal(req.length, 1);
    assert.equal(req[0].locked, true);
    if (enabled) {
      assert.deepEqual(req[0].ranges, ["'" + previous.getName() + "'!A1:K", "'" + current.getName() + "'!A1:K"]);
      assert.ok(!measured.lastReads.includes(current.getName()));
    } else assert.ok(measured.lastReads.includes(current.getName()));
  }));
  test('kw25 10: all-existing rejoin skips index reads and still updates prepared rows', () => {
    setup(); const t = tx(); call('registerPrepared', [[t], 'OLD']);
    index()._write(3, 1, oldRows(), false);
    const existing = call('activeTransactionRecordsByIds_', [['B1']]);
    const measured = watch(() => call('registerPrepared', [[{...t, originalMerchant: 'changed'}], 'NEW', existing, options()]));
    assert.equal(measured.counts.batchGet, 0);
    assert.equal(sheet('クレカ取引ログ').values[1][15], 'changed');
  });
  ['inactive', 'imported', 'customer', 'version', 'sequence', 'previous'].forEach(kind => {
    test('kw25 11: outer and locked filters agree for ' + kind, () => {
      setup(); const txs = [tx(), tx('B2', 'I2')]; const rows = oldRows(txs);
      if (kind === 'inactive') rows.forEach(r => { r[8] = false; });
      if (kind === 'imported') rows.forEach(r => { r[7] = gas.evaluate('FREEE_IMPORT_STATUS.IMPORTED'); });
      if (kind === 'customer') rows.forEach(r => { r[1] = 'OTHER'; });
      if (kind === 'version') rows.forEach(r => { r[6] = 'OTHER'; });
      if (kind === 'sequence') { rows[0][3] = 2; rows[1][3] = 1; }
      index(kind === 'previous' ? year() - 1 : year())._write(2, 1, rows, false);
      const material = options(txs).purposeRevision;
      const outer = call('checkPurposeRevisionCandidate', ['C001', material.identityHashes, 'NEW', version(),
        call('queryTxIndex', ['C001', {purpose: 'FREEE_PENDING'}]), {}]);
      const result = call('registerPrepared', [txs, 'RUN', {}, options(txs)]);
      assert.equal(outer.candidate, kind === 'previous');
      assert.equal(result?.registered, !outer.candidate);
      if (outer.candidate) assert.deepEqual(plain(result.purposeRevision), plain(outer));
      else assert.equal(sheet('クレカ取引ログ').values.filter(r => r[4] === 'B').length, 2);
    });
  });
  [false, true].forEach(candidate => test('kw25 12: absent current sheet with candidate=' + candidate, () => {
    setup(); const rows = oldRows(); if (!candidate) rows[0][4] = 'DIFFERENT';
    index(year() - 1)._write(2, 1, rows, false);
    const measured = watch(() => call('registerPrepared', [[tx()], 'RUN', {}, options()]));
    assert.equal(Boolean(index(year(), false)), !candidate);
    assert.equal(measured.result?.registered, !candidate);
    if (!candidate) { assert.equal(index().values[1][0], 'B1'); assert.equal(measured.counts.batchGet, 3); }
    else { assert.equal(measured.counts.batchUpdate, 0); assert.equal(sheet('クレカ取引ログ').values.filter(r => r[4] === 'B').length, 0); }
  }));
  test('kw25 13: options-free caller keeps baseline reads and writes without checking', () => {
    setup(); index()._write(2, 1, oldRows(), false);
    const measured = watch(() => withMocks({checkPurposeRevisionCandidate: () => assert.fail('unexpected check')},
      () => call('registerPrepared', [[tx()], 'RUN'])));
    assert.equal(measured.counts.batchGet, 3); assert.equal(measured.counts.batchUpdate, 2);
    assert.equal(index().values[2][0], 'B1');
  });
  test('kw25 14: duplicate calls and shared index mapping stay at their required sites', () => {
    const source = name => fs.readFileSync(path.join(gas.srcDir, name)).toString('utf8');
    const callers = fs.readdirSync(gas.srcDir).filter(n => n.endsWith('.gs') && n !== '41_DuplicateChecker.gs')
      .filter(n => /\bcheckDuplicateFile\s*\(/.test(source(n)));
    assert.deepEqual(callers, ['60_ProcessLog.gs']);
    const process = source('60_ProcessLog.gs').split('function updateProcessLogAndContentHash_(')[1].split('\nfunction ')[0];
    assert.match(process, /checkDuplicateFile\(/);
    assert.doesNotMatch(source('71_RunOrchestrator.gs').split('function processDiscoveredFile_(')[1].split('\nfunction ')[0], /permanentIndexRowsForScan_\(/);
    const src = source('61_TransactionLog.gs');
    const register = src.split('function registerPrepared(')[1].split('\nfunction ')[0];
    const query = src.split('function queryTxIndex(')[1].split('\nfunction ')[0];
    assert.match(register, /checkPurposeRevisionCandidate\(/);
    assert.match(register, /txIndexItemsFromRows_\(/); assert.match(query, /txIndexItemsFromRows_\(/);
  });
};

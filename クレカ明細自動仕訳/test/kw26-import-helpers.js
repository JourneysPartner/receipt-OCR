'use strict';

module.exports = ({test: register, assert, gas, setupWorld, putCsv, createWebDestination,
  webImport, withMocks, call, plain, latestImportCall, withImportTiming, seedPrefetchFile}) => {
  // 本番の既定は 1 本に戻した（2026-10-17 の受入）。2 本の道は残してあるので、
  // ここのテストは 2 本にして試し続ける（戻したときに壊れていないように）。
  const test = (name, fn) => register(name, () => withMocks({WEBAPP_IMPORT_LANES_: 2}, fn));
  function world(count = 1) {
    const {customer} = setupWorld({knownMerchant: true});
    const ids = Array.from({length: count}, (_, i) => putCsv(customer, {fileId: 'kw26_f' + (i + 1),
      rows: [`2025/12/${10 + i},既知店,${1000 + i},仕入れ`]}));
    return {customer, ids};
  }
  const sheet = name => gas.stubs.getSpreadsheet('master').getSheetByName(name);
  const prepare = c => call('webAppPrepareImport', [c.customerId, c.cardId]);
  const lane = (c, dest, ids, number = 0) => webImport(c,
    {destinationSpreadsheetId: dest, fileIds: ids, lane: number});
  function lease(c, fileId, minutes = 1, purpose = 'PROCESS', customerId = c.customerId) {
    const at = new Date(Date.now() - minutes * 60000).toISOString();
    sheet('処理リース').appendRow(['L_' + fileId, customerId, fileId, 'OTHER', 'other@example.com',
      '', at, at, 'ACTIVE', purpose]);
  }
  function broken(c, id = 'X') {
    const records = seedPrefetchFile(c, id, {state: 'VALIDATING'});
    sheet('クレカ処理ログ').getRange(records.process.rowNumber, 17).setValue('WRITING');
    return records;
  }
  function virtual(fn) {
    call('resetApiReadWindow_'); let now = Date.now();
    gas.stubs.setSleepHook(ms => { now += ms; });
    try { return withMocks({apiClockNow_: () => now}, fn); }
    finally { gas.stubs.setSleepHook(null); }
  }
  function partition(result, ids) {
    const all = result.fileResults.map(f => f.fileId).concat(result.notStarted, result.skipped);
    assert.deepEqual(all.slice().sort(), ids.slice().sort());
    assert.equal(new Set(all).size, ids.length);
  }
  test('kw26 1: preparation checks and renames once without importing or leasing', () => {
    const {customer, ids} = world(3);
    ids.forEach(id => {
      const file = gas.context.DriveApp.getFileById(id), name = file.getName();
      seedPrefetchFile(customer, id, {name});
      putCsv(customer, {fileId: id, name});
    });
    const record = call('getProcessLogRecord_', [ids[0]]);
    sheet('クレカ処理ログ').getRange(record.rowNumber, 32).setValue('PENDING_RETRY');
    const before = gas.stubs.getSpreadsheetIds(); let audits = 0, renames = 0, imports = 0;
    const real = {...gas.context};
    const result = virtual(() => withMocks({verifyChain: (...a) => { audits++; return real.verifyChain(...a); },
      updateFilePrefix: (...a) => { renames++; return real.updateFilePrefix(...a); },
      processDiscoveredFile_: (...a) => { imports++; return real.processDiscoveredFile_(...a); }
    }, () => prepare(customer)));
    assert.deepEqual(result.fileIds, ids); assert.equal(result.done, 0);
    assert.equal(audits, 1); assert.equal(renames, 1); assert.equal(imports, 0);
    assert.deepEqual(gas.stubs.getSpreadsheetIds().filter(id => !before.includes(id)), [result.destinationSpreadsheetId]);
    ids.forEach(id => assert.equal(call('getFileState', [id]), 'DISCOVERED'));
    assert.equal(call('activeLeases_').length, 0);
    assert.equal(sheet('クレカ取引ログ').values.filter(r => r[4] && ids.includes(r[4])).length, 0);
    const dest = gas.stubs.getSpreadsheet(result.destinationSpreadsheetId).getSheetByName('入力用シート');
    assert.ok(dest.values.slice(1).every(r => !r[6]));
    assert.equal(latestImportCall().prepare, true); assert.deepEqual(latestImportCall().files, []);
  });
  test('kw26 2: stopped or empty preparation never clones', () => {
    for (const corrupt of [true, false]) {
      const {customer} = world(corrupt ? 1 : 0); if (corrupt) broken(customer);
      const before = gas.stubs.getSpreadsheetIds(); const result = prepare(customer);
      assert.deepEqual(result.fileIds, []);
      assert.equal(result.stoppedBy, corrupt ? 'INTEGRITY_STOP' : null);
      assert.deepEqual(gas.stubs.getSpreadsheetIds(), before);
    }
  });
  test('kw26 3: preparation guards only live same-customer PROCESS leases', () => {
    for (const [minutes, purpose, cid, stops] of [[1, 'PROCESS', 'C001', true],
      [8, 'PROCESS', 'C001', false], [1, 'WRITE_ONLY', 'C001', false], [1, 'PROCESS', 'C002', false]]) {
      const {customer} = world(); lease(customer, 'other', minutes, purpose, cid);
      const before = gas.stubs.getSpreadsheetIds(), writes = gas.stubs.getApiCallCounts().batchUpdate;
      let renames = 0; const real = gas.context.retryPendingRenames;
      const result = withMocks({retryPendingRenames: (...a) => { renames++; return real(...a); }}, () => prepare(customer));
      assert.equal(result.stoppedBy, stops ? 'IMPORT_IN_PROGRESS' : null);
      if (stops) {
        assert.equal(renames, 0); assert.deepEqual(gas.stubs.getSpreadsheetIds(), before);
        assert.equal(gas.stubs.getApiCallCounts().batchUpdate, writes);
      }
    }
  });
  test('kw26 4: disabled parallel preparation and lane fail without writes', () => {
    const {customer, ids} = world(); const before = gas.stubs.getSpreadsheetIds();
    const writes = gas.stubs.getApiCallCounts().batchUpdate;
    withMocks({WEBAPP_IMPORT_LANES_: 1}, () => {
      assert.equal(prepare(customer).stoppedBy, 'PARALLEL_DISABLED');
      assert.throws(() => lane(customer, 'dest', ids), e => e.name === 'AuthorizationError');
    });
    assert.deepEqual(gas.stubs.getSpreadsheetIds(), before);
    assert.equal(gas.stubs.getApiCallCounts().batchUpdate, writes);
  });
  test('kw26 5: invalid lane inputs have zero reads leases writes copies and cache access', () => {
    const {customer} = world();
    const invalid = [-1, 2, '0', 1.5, NaN, {}, false].map(lane => ({lane})).concat(
      [{destinationSpreadsheetId: ''}, {fileIds: []}, {fileIds: Array.from({length: 7}, (_, i) => 'f' + i)},
        {fileIds: ['x', 'x']}, {fileIds: ['']}, {fileIds: [1]}, {fileIds: 'f'}]);
    for (const change of invalid) {
      const before = plain(gas.stubs.getApiCallCounts()), copies = gas.stubs.getSpreadsheetIds();
      let caches = 0, leases = 0;
      withMocks({loadSharedReadWindow_: () => { caches++; }, saveSharedReadWindow_: () => { caches++; },
        acquireLease: () => { leases++; }}, () => {
        assert.throws(() => webImport(customer, Object.assign({lane: 0,
          destinationSpreadsheetId: 'dest', fileIds: ['f']}, change)), e => e.name === 'AuthorizationError' &&
            e.message.includes('取込の割り振りが正しくありません。画面を開き直してから（F5）もう一度押してください。'));
      });
      assert.equal(caches, 0); assert.equal(leases, 0);
      assert.deepEqual(plain(gas.stubs.getApiCallCounts()), before);
      assert.deepEqual(gas.stubs.getSpreadsheetIds(), copies);
    }
  });
  test('kw26 6: lane partitions only assigned files in scan order including deferred and early returns', () => {
    const {customer, ids} = world(4); const dest = createWebDestination(customer);
    const result = virtual(() => lane(customer, dest, [ids[2], ids[0]]));
    assert.deepEqual(result.fileResults.map(f => f.fileId), [ids[0], ids[2]]);
    partition(result, [ids[2], ids[0]]);
    assert.deepEqual(call('scanUnprocessedFiles', [customer.customerId, {}]).map(f => f.fileId), [ids[1], ids[3]]);
    const next = virtual(() => lane(customer, dest, [ids[0], 'unknown', ids[1]]));
    assert.deepEqual(next.skipped, [ids[0], 'unknown']); partition(next, [ids[0], 'unknown', ids[1]]);
    const heavy = world(3); const hd = createWebDestination(heavy.customer);
    const stopped = virtual(() => withImportTiming([130000, 0, 0], () => lane(heavy.customer, hd, heavy.ids)));
    assert.deepEqual(stopped.notStarted, heavy.ids.slice(1)); partition(stopped, heavy.ids);
    const early = virtual(() => withImportTiming([], () => lane(heavy.customer, hd, [heavy.ids[1], 'unknown']),
      {overheadMs: 300000}));
    assert.equal(early.stoppedBy, 'TIME_BUDGET'); assert.deepEqual(early.notStarted, [heavy.ids[1]]);
    partition(early, [heavy.ids[1], 'unknown']);
    const empty = lane(heavy.customer, hd, ['unknown']); partition(empty, ['unknown']);
  });
  test('kw26 7: lane never retries names verifies audit or clones', () => {
    const {customer, ids} = world(); const dest = createWebDestination(customer);
    const retry = seedPrefetchFile(customer, 'retry', {state: 'COMPLETED'});
    sheet('クレカ処理ログ').getRange(retry.process.rowNumber, 32).setValue('PENDING_RETRY');
    let renames = 0, audit = 0, clones = 0;
    const result = virtual(() => withMocks({retryPendingRenames: () => { renames++; },
      verifyChain: () => { audit++; return {ok: true}; }, webAppCloneDestination_: () => { clones++; }
    }, () => lane(customer, dest, ids)));
    assert.equal(result.done, 1); assert.equal(renames, 0); assert.equal(audit, 0); assert.equal(clones, 0);
    assert.equal(call('getProcessLogRecord_', ['retry']).values[31], 'PENDING_RETRY');
    assert.ok(!latestImportCall().run.some(s => s.name === 'renames'));
  });
  test('kw26 8: lane uses budget 27 its own cache smoothing and clears on success or exception', () => {
    const {customer, ids} = world(); const dest = createWebDestination(customer);
    const keys = [], cache = gas.context.CacheService.getScriptCache();
    let budget, smoothing; const real = gas.context.processDiscoveredFile_;
    const result = virtual(() => withMocks({CacheService: {getScriptCache: () => ({
      get: k => { keys.push('get:' + k); return cache.get(k); },
      put: (k, ...a) => { keys.push('put:' + k); return cache.put(k, ...a); }
    })}, processDiscoveredFile_: (...a) => {
      budget = gas.context.apiReadBudget_; smoothing = gas.context.apiReadSmoothing_; return real(...a);
    }}, () => lane(customer, dest, ids, 1)));
    assert.equal(result.done, 1); assert.equal(budget, 27); assert.equal(smoothing, true);
    assert.deepEqual(keys, ['get:SHEETS_READ_WINDOW_V1_LANE_1', 'put:SHEETS_READ_WINDOW_V1_LANE_1']);
    assert.ok(latestImportCall().pacedMs > 0); assert.equal(latestImportCall().budget, 27);
    assert.equal(call('readLaneActive_'), false); assert.equal(gas.context.apiReadBudget_, 55);
    withMocks({webAppAuthorizeCustomer_: () => { throw Error('test'); }}, () =>
      assert.throws(() => lane(customer, dest, ids)));
    assert.equal(call('readLaneActive_'), false); assert.equal(gas.context.apiReadBudget_, 55);
    call('setReadLane_', [0, 2]); call('resetApiReadWindow_'); assert.equal(call('readLaneActive_'), false);
  });
  test('kw26 9: preparation merges all windows and splits recent timestamps even with cache failures', () => {
    const {customer} = world(0); const base = 'SHEETS_READ_WINDOW_V1';
    virtual(() => {
      const now = gas.context.apiClockNow_();
      gas.stubs.setScriptCacheValue(base, JSON.stringify([now - 500, now - 400]));
      gas.stubs.setScriptCacheValue(base + '_LANE_0', JSON.stringify([now - 400, now - 300]));
      gas.stubs.setScriptCacheValue(base + '_LANE_1', JSON.stringify([now - 200]));
      prepare(customer);
      const read = key => JSON.parse(gas.stubs.getScriptCacheValue(key));
      const all = read(base); assert.ok([500, 400, 300, 200].every(n => all.includes(now - n)));
      assert.deepEqual(read(base + '_LANE_0'), all.filter((_, i) => i % 2 === 0));
      assert.deepEqual(read(base + '_LANE_1'), all.filter((_, i) => i % 2 === 1));
      call('resetApiReadWindow_');
      const writes = []; let getCount = 0;
      const prior = gas.context.apiSharedReadWindowErrors_;
      withMocks({CacheService: {getScriptCache: () => ({get: () => {
        if (++getCount === 2) throw Error('cache'); return JSON.stringify([now - getCount]);
      }, put: k => { writes.push(k); if (k === base) throw Error('cache'); }})}}, () => {
        assert.equal(call('loadSharedReadWindowAll_', [2]), 2);
        assert.equal(call('saveSharedReadWindowSplit_', [2]), 2);
      });
      assert.equal(writes.length, 3); assert.equal(gas.context.apiSharedReadWindowErrors_ - prior, 2);
    });
  });
  test('kw26 8: preparation and lane read counts and locked read distribution are measured', () => {
    for (const count of [1, 2]) {
      const {customer, ids} = world(count);
      let prep; virtual(() => { prep = prepare(customer); });
      const prepRecord = latestImportCall();
      const locks = []; let processing = false; const real = {...gas.context};
      const result = virtual(() => withMocks({processDiscoveredFile_: (...a) => {
        processing = true; try { return real.processDiscoveredFile_(...a); } finally { processing = false; }
      }, withScriptLock_: callback => {
        const inFile = processing; let label;
        const stack = new Error().stack;
        const returned = real.withScriptLock_(() => {
          const before = gas.context.apiReadCount_;
          try { return callback(); }
          finally { if (inFile) { label = stack; locks.push({reads: gas.context.apiReadCount_ - before, stack: label}); } }
        });
        return returned;
      }}, () => lane(customer, prep.destinationSpreadsheetId, ids)));
      assert.equal(result.done, count);
      const laneRecord = latestImportCall(), distribution = {};
      locks.forEach(lock => { distribution[lock.reads] = (distribution[lock.reads] || 0) + 1; });
      const measured = {count, prepare: prepRecord.totalReads, lane: laneRecord.totalReads,
        files: laneRecord.files.map(f => f.reads), distribution,
        overReserve: locks.filter(l => l.reads > 5)};
      console.log('KW26_MEASURE ' + JSON.stringify(measured));
      assert.equal(laneRecord.precheck.excluded, 0);
      assert.equal(prepRecord.totalReads, 16);
      assert.equal(laneRecord.totalReads, count === 1 ? 36 : 55);
      assert.equal(laneRecord.totalReads, laneRecord.stages.reduce((n, s) => n + s.reads, 0));
      assert.equal(laneRecord.lock.count, locks.length);
    }
  });
  test('kw26 12: precheck excludes only live same-customer leases and leaves legacy reads unchanged', () => {
    for (const [minutes, cid, exclude, stops] of [[1, 'C001', true, false], [8, 'C001', true, true],
      [1, 'C002', true, true], [1, 'C001', false, true]]) {
      const {customer} = world(0); broken(customer); lease(customer, 'X', minutes, 'WRITE_ONLY', cid);
      let reads = 0, txReads = 0; const real = {...gas.context};
      const result = withMocks({activeLeases_: (...a) => { reads++; return real.activeLeases_(...a); },
        findRowsByColumnValues_: (s, col, ids, ...a) => {
          if (s.getName() === 'クレカ取引ログ' && ids.includes('X')) txReads++;
          return real.findRowsByColumnValues_(s, col, ids, ...a);
        }}, () => call('runCustomerIntegrityCheck_', [call('getCustomerById', [customer.customerId]), [],
          {excludeLeasedFiles: exclude}]));
      assert.equal(result.stop, stops); assert.equal(reads, exclude ? 2 : 0);
      if (exclude) assert.equal(result.excludedLeasedFiles, stops ? 0 : 1);
      if (!stops) assert.equal(txReads, 0);
    }
  });
  test('kw26 13: lease acquired after s1 discards findings at s2 and costs exactly two reads', () => {
    const {customer} = world(0); const records = seedPrefetchFile(customer, 'X', {state: 'VALIDATING'});
    const c = call('getCustomerById', [customer.customerId]);
    call('resetApiReadWindow_'); const before = gas.context.apiReadCount_;
    call('runCustomerIntegrityCheck_', [c, []]); const oldReads = gas.context.apiReadCount_ - before;
    let injected = false; const real = gas.context.permanentIndexRowsForScan_;
    const start = gas.context.apiReadCount_;
    const result = withMocks({permanentIndexRowsForScan_: (...a) => {
      const rows = real(...a);
      if (!injected) {
        injected = true; lease(customer, 'X');
        sheet('クレカ処理ログ').getRange(records.process.rowNumber, 17).setValue('WRITING');
      }
      return rows;
    }}, () => call('runCustomerIntegrityCheck_', [c, [], {excludeLeasedFiles: true}]));
    assert.equal(result.stop, false); assert.equal(result.excludedLeasedFiles, 1);
    assert.equal(gas.context.apiReadCount_ - start, oldReads + 2);
    console.log('KW26_PRECHECK ' + JSON.stringify({legacy: oldReads, excluding: gas.context.apiReadCount_ - start}));
  });
  test('kw26 14: legacy reads result log renames and window remain unchanged', () => {
    const {customer} = world();
    const destinationSpreadsheetId = createWebDestination(customer);
    call('resetApiReadWindow_'); gas.stubs.resetApiCallCounts();
    let renames = 0, budget;
    const real = gas.context.retryPendingRenames;
    const result = withMocks({retryPendingRenames: (...args) => {
      renames++; budget = gas.context.apiReadBudget_; return real(...args);
    }}, () => webImport(customer, {destinationSpreadsheetId}));
    const record = latestImportCall();
    console.log('KW26_LEGACY ' + JSON.stringify({reads: record.totalReads,
      api: gas.stubs.getApiCallCounts(), resultKeys: Object.keys(result).sort(),
      logKeys: Object.keys(record).sort(), renames, budget}));
    assert.equal(result.done, 1); assert.equal(record.totalReads, 35);
    assert.equal(renames, 1); assert.equal(budget, 55);
    assert.deepEqual(Object.keys(result).sort(), ['destinationSpreadsheetId', 'done', 'fileResults', 'remaining', 'stoppedBy', 'total']);
    assert.deepEqual(Object.keys(record).sort(), ['backoffMs', 'continuation', 'done', 'files', 'gate', 'pacedMs', 'precheck',
      'quotaHits', 'run', 'runId', 'sharedWindow', 'stages', 'stoppedBy', 'total', 'totalMs', 'totalReads']);
    assert.ok(gas.stubs.getScriptCacheValue('SHEETS_READ_WINDOW_V1'));
  });
  test('kw26 15: two lanes write one copy with unique IDs matching audit and final review', () => {
    const {customer, ids} = world(4); const prep = virtual(() => prepare(customer));
    assert.deepEqual(prep.fileIds, ids);
    const before = gas.stubs.getSpreadsheetIds();
    for (let i = 0; i < 2; i++) {
      const result = virtual(() => lane(customer, prep.destinationSpreadsheetId, ids.slice(i * 2, i * 2 + 2), i));
      assert.equal(result.done, 2); partition(result, ids.slice(i * 2, i * 2 + 2));
    }
    assert.deepEqual(gas.stubs.getSpreadsheetIds(), before); assert.equal(call('activeLeases_').length, 0);
    const txs = sheet('クレカ取引ログ').values.filter(r => ids.includes(r[4]));
    assert.equal(txs.length, 4); assert.equal(new Set(txs.map(r => r[0])).size, 4);
    txs.forEach(r => { assert.equal(r[28], prep.destinationSpreadsheetId); assert.equal(r[29], '入力用シート'); });
    const rows = gas.stubs.getSpreadsheet(prep.destinationSpreadsheetId).getSheetByName('入力用シート').values;
    const column = call('getCustomerById', [customer.customerId]).columnMapping.txId - 1;
    const written = rows.map(r => r[column]).filter(id => txs.some(r => r[0] === id));
    assert.equal(written.length, 4); assert.equal(new Set(written).size, 4);
    assert.equal(call('verifyChain', ['RECENT']).ok, true);
    const final = call('webAppFinalReview', [customer.customerId, prep.destinationSpreadsheetId, ids]);
    assert.equal(final.reconciliation.totals.balanced, true);
    assert.deepEqual(final.reconciliation.problems, []);
  });
  test('kw26 17: bootstrap advertises two lanes and six files', () => {
    world(0); const result = call('webAppBootstrap');
    assert.equal(result.importLanes, 2); assert.equal(result.maxFilesPerImport, 6);
  });
  register('kw26 28: the shipped default is one lane and the screen keeps the one-at-a-time path', () => {
    world(0);
    assert.equal(gas.context.WEBAPP_IMPORT_LANES_, 1, '2026-10-17 の受入で 1 本に戻した');
    assert.equal(call('webAppBootstrap').importLanes, 1);
    const {customer} = world(1);
    assert.equal(prepare(customer).stoppedBy, 'PARALLEL_DISABLED');
  });
};

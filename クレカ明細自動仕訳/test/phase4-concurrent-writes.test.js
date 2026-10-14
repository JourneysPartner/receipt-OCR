'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = ({test, assert, gas}) => {
  const blank = n => Array(n).fill('');
  const plain = value => JSON.parse(JSON.stringify(value));
  const sheet = name => gas.stubs.getSpreadsheet('master').getSheetByName(name);
  const snapshot = (target, start, end) => plain(target.values.slice(start - 1, end));
  const stale = (id, name, view) => gas.stubs.setStaleSpreadsheetAppView(id, name, view);
  const reads = () => {
    const counts = gas.stubs.getApiCallCounts();
    return counts.batchGet + counts.get;
  };
  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '処理リース', values: [['リースID']]},
      {name: '監査ログ', values: [['監査ID']]},
      {name: '要確認', values: [['要確認ID']], maxColumns: 33}
    ]});
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.evaluate('resetApiReadWindow_(); resetApiBackoff_();');
  }
  function withMocks(mocks, fn) {
    const saved = {};
    Object.keys(mocks).forEach(key => { saved[key] = gas.context[key]; gas.context[key] = mocks[key]; });
    try { return fn(); }
    finally { Object.keys(saved).forEach(key => { gas.context[key] = saved[key]; }); }
  }
  function seedAudit(count) {
    let previous = gas.evaluate('CONFIG.AUDIT_CHAIN_GENESIS');
    for (let i = 0; i < count; i++) {
      const row = gas.call('makeAuditRow_', [{auditId: 'AUDIT_' + i,
        type: i ? 'SETTING' : 'CHAIN_ANCHOR', targetId: i ? 'other_' + i : 'GENESIS',
        after: i ? {index: i} : {kind: 'GENESIS', createdAt: '2026-10-14T00:00:00Z'}}, previous, i === 0]);
      sheet('監査ログ')._write(i + 2, 1, [row], false);
      previous = row[14];
    }
  }
  function lease(id, run = 'RUN', purpose = 'WRITE_ONLY', file = 'file1') {
    const at = new Date(Date.now() - 3 * 3600000).toISOString();
    return [id, 'C001', file, run, 'admin@example.com', '', at, at, 'ACTIVE', purpose];
  }
  function seedLeases(rows) { sheet('処理リース')._write(2, 1, rows, false); }
  const leaseIds = () => sheet('処理リース').values.slice(1).filter(row => row[0]).map(row => row[0]);
  const reviewEntry = id => ({reviewType: 'COUNT_TOTAL_MISMATCH', customerId: 'C001', fileId: id});
  function seedReviews(count) {
    for (let i = 0; i < count; i++) {
      const entry = reviewEntry('old_' + i);
      const key = gas.call('buildSuppressionKey', [entry.reviewType, {fileId: entry.fileId}]);
      const built = gas.call('makeReviewRow_', [entry, key]);
      sheet('要確認')._write(i + 2, 1, [built.row], false);
    }
  }
  function destination(maxRows = 4) {
    setup();
    gas.stubs.createSpreadsheet('dest1', {sheets: [{name: '入力用シート',
      values: [blank(30)], maxRows, maxColumns: 30}]});
    seedLeases([lease('LEASE')]);
    return {customerId: 'C001', destinationSpreadsheetId: 'dest1', destinationSheetName: '入力用シート',
      headerRow: 1, rowScanLastColumn: 30, rowScanExcludedColumns: [],
      columnMapping: {B: 2, F: 6, I: 9, K: 11, M: 13, txId: 30}};
  }
  const destSheet = () => gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
  function reserve(customer, count) {
    return plain(gas.call('reserveDestinationRows', [customer,
      Array.from({length: count}, (_, i) => 'TX_' + i), 'file1', 'LEASE']));
  }
  // API の内部で同じメモリを触る操作を、SpreadsheetApp の呼出しに数えない。
  function watchSpreadsheetApp(target, fn) {
    let inApi = 0;
    const calls = {getValues: 0, getFormulas: 0, setValues: 0, deleteRow: 0};
    const deletedRows = [];
    const originals = [];
    const wrapApi = (owner, key) => {
      const original = owner[key]; originals.push(() => { owner[key] = original; });
      owner[key] = function(...args) { inApi++; try { return original.apply(this, args); } finally { inApi--; } };
    };
    wrapApi(gas.context.Sheets.Spreadsheets.Values, 'batchGet');
    wrapApi(gas.context.Sheets.Spreadsheets.Values, 'batchUpdate');
    wrapApi(gas.context.Sheets.Spreadsheets, 'batchUpdate');
    const originalRange = target.getRange;
    target.getRange = function(...args) {
      const range = originalRange.apply(this, args);
      ['getValues', 'getFormulas', 'setValues'].forEach(key => {
        const original = range[key];
        range[key] = function(...values) { if (!inApi) calls[key]++; return original.apply(this, values); };
      });
      return range;
    };
    const originalDelete = target.deleteRow;
    target.deleteRow = function(...args) {
      if (!inApi) { calls.deleteRow++; deletedRows.push(args[0]); }
      return originalDelete.apply(this, args);
    };
    try { return {result: fn(), calls, deletedRows}; }
    finally { target.getRange = originalRange; target.deleteRow = originalDelete; originals.reverse().forEach(restore => restore()); }
  }

  test('kw24 1: successful callbacks flush while locked, then return their value', () => {
    setup(); const lock = gas.stubs.getScriptLock(); const events = [];
    const result = withMocks({SpreadsheetApp: {...gas.context.SpreadsheetApp,
      flush: () => { events.push('flush'); assert.equal(lock.locked, true); }}}, () => {
      return gas.call('withScriptLock_', [() => { events.push('callback'); return 42; }]);
    });
    assert.equal(result, 42); assert.deepEqual(events, ['callback', 'flush']);
    assert.equal(lock.locked, false); assert.equal(lock.releaseCount, 1);
  });
  [false, true].forEach(flushFails => {
    test('kw24 1: callback errors survive a ' + (flushFails ? 'failing' : 'successful') + ' locked flush', () => {
      setup(); const lock = gas.stubs.getScriptLock(); const original = new Error('callback'); let flushes = 0;
      withMocks({SpreadsheetApp: {...gas.context.SpreadsheetApp, flush: () => {
        flushes++; assert.equal(lock.locked, true); if (flushFails) throw new Error('flush');
      }}}, () => assert.throws(() => gas.call('withScriptLock_', [() => { throw original; }]), error => error === original));
      assert.equal(flushes, 1); assert.equal(lock.locked, false); assert.equal(lock.releaseCount, 1);
    });
  });
  test('kw24 1: a flush error releases the lock and is rethrown unchanged', () => {
    setup(); const lock = gas.stubs.getScriptLock(); const failure = new Error('flush');
    withMocks({SpreadsheetApp: {...gas.context.SpreadsheetApp, flush: () => {
      assert.equal(lock.locked, true); throw failure;
    }}}, () => assert.throws(() => gas.call('withScriptLock_', [() => 42]), error => error === failure));
    assert.equal(lock.locked, false); assert.equal(lock.releaseCount, 1);
  });
  test('kw24 1: lock contention neither flushes nor invokes the callback', () => {
    setup(); gas.stubs.getScriptLock().setTryLockResults([false]); let callbacks = 0;
    gas.stubs.resetRoundTrips();
    assert.throws(() => gas.call('withScriptLock_', [() => { callbacks++; }]), /Script lock was not acquired/);
    assert.equal(callbacks, 0); assert.equal(gas.stubs.roundTrips().flushes, 0);
    assert.equal(gas.stubs.getScriptLock().releaseCount, 0);
  });
  test('kw24 2: sufficient visible capacity needs no API read or insertion', () => {
    setup(); const target = sheet('要確認'); const before = target.maxRows;
    gas.stubs.resetApiCallCounts(); gas.call('ensureRowExists_', [target, 900]);
    assert.equal(reads(), 0); assert.equal(target.maxRows, before);
  });
  [900, 1010].forEach(required => {
    test('kw24 3: stale capacity preserves every existing row when requesting ' + required, () => {
      setup(); const target = sheet('要確認');
      for (let row = 5; row <= 1000; row++) target.values[row - 1][0] = 'OTHER_' + row;
      const before = snapshot(target, 1, 1000);
      stale('master', '要確認', {maxRows: 800}); gas.stubs.resetApiCallCounts();
      gas.call('ensureRowExists_', [target, required]);
      assert.equal(reads(), 1); assert.equal(gas.stubs.getApiCallCounts().get, 1);
      assert.equal(target.maxRows, required <= 1000 ? 1000 : 1510);
      assert.deepEqual(snapshot(target, 1, 1000), before);
    });
  });
  // 境目：求める行がちょうど本当の末尾なら、足りている。余白 500 行を足さない。
  test('kw24 3b: a request for exactly the actual last row inserts nothing', () => {
    setup(); const target = sheet('要確認');
    stale('master', '要確認', {maxRows: 800}); gas.stubs.resetApiCallCounts();
    gas.call('ensureRowExists_', [target, 1000]);
    assert.equal(reads(), 1); assert.equal(target.maxRows, 1000);
  });
  test('kw24 4: row counts use pacing and count a metadata read', () => {
    setup(); let now = 100000; const target = sheet('要確認');
    gas.stubs.setSleepHook(ms => { now += ms; });
    withMocks({apiClockNow_: () => now}, () => {
      gas.evaluate('apiReadBudget_ = 1; apiReadWindow_ = [100000];');
      assert.equal(gas.call('apiSheetRowCount_', [target]), 1000);
    });
    assert.equal(gas.evaluate('apiReadCount_'), 1);
    assert.equal(gas.stubs.getApiCallCounts().get, 1);
    assert.equal(gas.stubs.roundTrips().rangeReads, 1);
    assert.equal(gas.evaluate('apiBackoff_.paceCount'), 1);
    assert.equal(gas.evaluate('apiBackoff_.paceMs'), 60250);
  });
  [429, 500, 503].forEach(code => {
    test('kw24 4: row counts retry and account for transient status ' + code, () => {
      setup(); gas.stubs.setSheetsGetFailures([{code}]);
      assert.equal(gas.call('apiSheetRowCount_', [sheet('要確認')]), 1000);
      assert.equal(gas.evaluate('apiReadCount_'), 2); assert.equal(gas.stubs.getApiCallCounts().get, 2);
      assert.equal(gas.evaluate('apiBackoff_.count'), 1);
      assert.equal(gas.evaluate('apiBackoff_.quotaCount'), code === 429 ? 1 : 0);
      assert.ok(gas.evaluate('apiBackoff_.ms') > 0);
      assert.equal(gas.evaluate('apiBackoffTotalMs_'), gas.evaluate('apiBackoff_.ms'));
    });
  });
  test('kw24 4: row counts select the matching title and reject missing metadata', () => {
    setup(); const api = gas.context.Sheets.Spreadsheets; const original = api.get;
    let request;
    try {
      api.get = (id, value) => { request = value; assert.equal(id, 'master'); return {sheets: [
        {properties: {title: '別のシート', gridProperties: {rowCount: 7}}},
        {properties: {title: '要確認', gridProperties: {rowCount: 1000}}}
      ]}; };
      assert.equal(gas.call('apiSheetRowCount_', [sheet('要確認')]), 1000);
      assert.deepEqual(plain(request.ranges), ["'要確認'"]);
      assert.equal(request.fields, 'sheets(properties(title,gridProperties(rowCount)))');
      api.get = () => ({sheets: []});
      assert.throws(() => gas.call('apiSheetRowCount_', [sheet('要確認')]));
    } finally { api.get = original; }
  });
  [1, 3].forEach(count => {
    test('kw24 ' + (count === 1 ? '5' : '6') + ': stale audit tails append after the other execution and keep the chain', () => {
      setup(); seedAudit(13); const target = sheet('監査ログ'); const before = snapshot(target, 2, 14);
      stale('master', '監査ログ', {lastRow: 11});
      const entries = Array.from({length: count}, (_, i) => ({type: 'SETTING', targetId: 'new_' + i}));
      const ids = count === 1 ? [gas.call('appendAudit', [entries[0]])] : plain(gas.call('appendAuditBatch', [entries]));
      assert.deepEqual(snapshot(target, 2, 14), before);
      assert.deepEqual(target.values.slice(14, 14 + count).map(row => row[0]), ids);
      assert.equal(target.values[14][13], before.at(-1)[14]);
      gas.stubs.clearStaleSpreadsheetAppView();
      assert.equal(gas.call('verifyChain', ['FULL']).ok, true);
    });
  });
  test('kw24 7: audit windows continue past a full last window row', () => {
    setup(); seedAudit(449); const target = sheet('監査ログ'); const before = snapshot(target, 2, 450);
    stale('master', '監査ログ', {lastRow: 10}); gas.stubs.resetApiCallCounts();
    const id = gas.call('appendAudit', [{type: 'SETTING'}]);
    assert.equal(target.values[450][0], id); assert.equal(reads(), 3);
    assert.deepEqual(snapshot(target, 2, 450), before);
    gas.stubs.clearStaleSpreadsheetAppView(); assert.equal(gas.call('verifyChain', ['FULL']).ok, true);
  });
  // 監査行は消さないので、SpreadsheetApp の末尾が本当より大きいのは前提の外。
  // 窓が空でも「監査行が無い」と決めて起点を書いてはならない（連鎖が途中から
  // 始まり直す）。A 列と O 列を読み直して本当の末尾の次へ書く。
  test('kw24 7b: an audit tail that looks too far down is re-read instead of restarting the chain', () => {
    setup(); seedAudit(5); const target = sheet('監査ログ'); const before = snapshot(target, 2, 6);
    stale('master', '監査ログ', {lastRow: 50}); gas.stubs.resetApiCallCounts();
    const id = gas.call('appendAudit', [{type: 'SETTING', targetId: 'after_stale_high'}]);
    assert.deepEqual(snapshot(target, 2, 6), before);
    assert.equal(target.values[6][0], id);
    assert.equal(target.values[6][13], before.at(-1)[14]);
    assert.equal(target.values.slice(7, 60).filter(row => row[0]).length, 0);
    assert.equal(reads(), 2);
    gas.stubs.clearStaleSpreadsheetAppView(); assert.equal(gas.call('verifyChain', ['FULL']).ok, true);
  });
  // 窓は 2 行目より上から始めない（1 行目は見出し。0 行目は範囲として成り立たない）。
  test('kw24 7c: an audit tail hint of zero still starts the window at row 2', () => {
    setup(); seedAudit(3); const target = sheet('監査ログ'); const before = snapshot(target, 2, 4);
    stale('master', '監査ログ', {lastRow: 0});
    const ranges = []; const api = gas.context.Sheets.Spreadsheets.Values; const original = api.batchGet;
    api.batchGet = function(id, request) { ranges.push(...plain(request.ranges)); return original.call(this, id, request); };
    let id;
    try { id = gas.call('appendAudit', [{type: 'SETTING', targetId: 'after_zero_hint'}]); }
    finally { api.batchGet = original; }
    assert.ok(ranges.some(range => /!A2:O201$/.test(range)), JSON.stringify(ranges));
    assert.deepEqual(snapshot(target, 2, 4), before);
    assert.equal(target.values[4][0], id); assert.equal(target.values[4][13], before.at(-1)[14]);
    gas.stubs.clearStaleSpreadsheetAppView(); assert.equal(gas.call('verifyChain', ['FULL']).ok, true);
  });
  test('kw24 8: an empty audit sheet gets the unchanged genesis and entry shape', () => {
    setup(); const id = gas.call('appendAudit', [{type: 'SETTING', targetId: 'new'}]);
    const rows = sheet('監査ログ').values;
    assert.equal(rows[1][2], 'CHAIN_ANCHOR'); assert.equal(rows[1][7], 'GENESIS');
    assert.equal(JSON.parse(rows[1][10]).kind, 'GENESIS'); assert.equal(rows[2][0], id);
    assert.equal(rows[2][13], rows[1][14]); assert.equal(gas.call('verifyChain', ['FULL']).ok, true);
  });
  test('kw24 9: all four release paths share one read and delete only API-selected rows', () => {
    const outcomes = [];
    ['releaseLeaseById', 'releaseLease', 'forceReleaseLease', 'releaseInvestigatedLease'].forEach(name => {
      setup(); seedAudit(13); stale('master', '監査ログ', {lastRow: 11});
      seedLeases([lease('A', 'RUN', name === 'releaseInvestigatedLease' ? 'PROCESS' : 'WRITE_ONLY'),
        lease('B', 'OTHER'), lease('C', 'RUN')]);
      const dimensionRequests = []; const api = gas.context.Sheets.Spreadsheets; const original = api.batchUpdate;
      api.batchUpdate = function(request, id) { dimensionRequests.push(plain(request)); return original.call(this, request, id); };
      gas.stubs.resetApiCallCounts();
      let watched;
      try {
        // このテストはリース表と監査の読取を測る。認可・処理状態は既存の
        // kw21 と INV-20 が実表で検査しており、ここでは読取を分離する。
        watched = withMocks({getCustomerById: () => ({admins: ['admin@example.com']}),
          getProcessLogRecord_: () => ({values: Object.assign(blank(40), {16: 'REVIEW_WAIT'})})}, () => {
          return watchSpreadsheetApp(sheet('処理リース'), () => gas.call(name,
            name === 'releaseLease' ? ['file1', 'RUN', 'test'] : ['A', 'test', 'admin@example.com']));
        });
      } finally { api.batchUpdate = original; }
      const measured = reads();
      const linked = sheet('監査ログ').values[14][13] === sheet('監査ログ').values[13][14];
      gas.stubs.clearStaleSpreadsheetAppView(); const chainOk = gas.call('verifyChain', ['FULL']).ok;
      outcomes.push({name, measured, watched, dimensionRequests, remaining: leaseIds(), linked, chainOk});
    });
    outcomes.forEach(({name, measured, watched, dimensionRequests, remaining, linked, chainOk}) => {
      assert.equal(measured, 1, name);
      assert.equal(watched.calls.deleteRow, name === 'releaseLease' ? 2 : 1, name);
      assert.deepEqual(remaining, name === 'releaseLease' ? ['B'] : ['B', 'C'], name);
      assert.equal(dimensionRequests.length, 0, name);
      assert.deepEqual(watched.deletedRows, name === 'releaseLease' ? [4, 2] : [2], name);
      assert.equal(linked, true, name); assert.equal(chainOk, true, name);
    });
  });
  test('kw24 10: a release uses the moved API row and preserves the other lease', () => {
    setup(); seedLeases([lease('A'), lease('B'), lease('C')]);
    sheet('処理リース').deleteRow(2); stale('master', '処理リース', {lastRow: 4, maxRows: 1000});
    gas.call('releaseLeaseById', ['C', 'test']); assert.deepEqual(leaseIds(), ['B']);
  });
  test('kw24 11: bulk and single review registration preserve another execution rows', () => {
    setup(); seedReviews(8); const target = sheet('要確認'); const before = snapshot(target, 2, 9);
    stale('master', '要確認', {lastRow: 6});
    const result = plain(gas.call('registerPendingReviews', [[reviewEntry('new1'), reviewEntry('new2')]]));
    assert.deepEqual(snapshot(target, 2, 9), before);
    assert.deepEqual(target.values.slice(9, 11).map(row => row[0]), result.registered.map(row => row.reviewId));
    const prior = snapshot(target, 2, 11);
    const single = gas.call('registerReview', [reviewEntry('new3')]);
    assert.equal(target.values[11][0], single.reviewId); assert.deepEqual(snapshot(target, 2, 11), prior);
  });
  test('kw24 12: pending review registration retains its measured one-read budget', () => {
    setup(); gas.stubs.resetApiCallCounts();
    gas.call('registerPendingReviews', [[reviewEntry('new1'), reviewEntry('new2')]]);
    const measured = reads(); assert.equal(measured, 1);
  });
  test('kw24 13: reservations use index values and one RAW API write', () => {
    const customer = destination(6); const target = destSheet(); const writes = [];
    target.values[2][0] = 'occupied';
    gas.stubs.onValuesBatchUpdate((request, id) => { if (id === 'dest1') writes.push(plain(request)); });
    let watched;
    try { watched = watchSpreadsheetApp(target, () => reserve(customer, 3)); }
    finally { gas.stubs.onValuesBatchUpdate(null); }
    assert.deepEqual(watched.result.reserved, [{txId: 'TX_0', rowNumber: 2},
      {txId: 'TX_1', rowNumber: 4}, {txId: 'TX_2', rowNumber: 5}]);
    assert.deepEqual(watched.calls, {getValues: 0, getFormulas: 0, setValues: 0, deleteRow: 0});
    assert.equal(writes.length, 1); assert.equal(writes[0].valueInputOption, 'RAW');
    assert.equal(writes[0].data.length, 2);
    assert.deepEqual([target.values[1][29], target.values[3][29], target.values[4][29]], ['TX_0', 'TX_1', 'TX_2']);
  });
  function staleDestination(hiddenEmpty) {
    const customer = destination(30); const target = destSheet();
    for (let row = 2; row <= 30; row++) {
      if (row > 3 && (row < 20 || !hiddenEmpty)) {
        target.values[row - 1][29] = 'OTHER_TX_' + row;
        target.values[row - 1][12] = row * 100;
      } else { target.formulas[row - 1][20] = '=M' + row + '*0.1'; }
    }
    stale('dest1', '入力用シート', {maxRows: 19});
    return {customer, target};
  }
  test('kw24 14: expansion appends after actual capacity without moving another file rows', () => {
    const {customer, target} = staleDestination(false); const before = snapshot(target, 20, 30);
    const result = reserve(customer, 5);
    assert.deepEqual(snapshot(target, 20, 30), before); assert.deepEqual(result.expanded, [31, 32, 33]);
    assert.deepEqual(result.reserved.map(row => row.rowNumber), [2, 3, 31, 32, 33]);
    assert.equal(target.maxRows, 33);
  });
  test('kw24 14b: a rebuilt index finds hidden empty rows without expanding', () => {
    const {customer, target} = staleDestination(true); const result = reserve(customer, 5);
    assert.deepEqual(result.expanded, []); assert.equal(target.maxRows, 30);
    assert.deepEqual(result.reserved.map(row => row.rowNumber), [2, 3, 20, 21, 22]);
  });
  [false, true].forEach(expand => {
    test('kw24 15: reservation read budget ' + (expand ? 'with expansion is baseline five plus one' : 'without expansion remains three'), () => {
      const customer = destination(4); gas.stubs.resetApiCallCounts(); reserve(customer, expand ? 4 : 2);
      const measured = reads(); const metadata = gas.stubs.getApiCallCounts().get;
      assert.equal(measured, expand ? 6 : 3); assert.equal(metadata, expand ? 1 : 0);
    });
  });
  test('kw24 16: stale capacity copies a formula-bearing template row', () => {
    const customer = destination(4); const target = destSheet(); target.formulas[1][20] = '=M2*0.1';
    stale('dest1', '入力用シート', {maxRows: 3}); const result = reserve(customer, 5);
    assert.deepEqual(result.expanded, [5, 6]);
    result.expanded.forEach(row => assert.equal(target.formulas[row - 1][20], '=M2*0.1'));
  });
  test('kw24 16: stale capacity preserves the static-total expansion stop', () => {
    const customer = destination(4); const target = destSheet(); target.values[3][19] = '合計';
    stale('dest1', '入力用シート', {maxRows: 3});
    assert.throws(() => reserve(customer, 4), /DESTINATION_TEMPLATE_ROW_NOT_EMPTY/);
  });
  test('kw24 17: source write sites obey the sheet and API boundaries', () => {
    const src = gas.srcDir;
    const source = name => fs.readFileSync(path.join(src, name)).toString('utf8');
    for (const name of fs.readdirSync(src).filter(name => name.endsWith('.gs'))) {
      assert.doesNotMatch(source(name), /ensureRowExists_\(\s*leaseSheet_\(/, name);
    }
    ['62_AuditLog.gs', '50_ReviewStore.gs'].forEach(name => {
      assert.doesNotMatch(source(name), /getLastRow\(\)\s*\+\s*1|appendRow\(/, name);
    });
    assert.doesNotMatch(source('11_FileStateManager.gs'), /Sheets\.Spreadsheets\.batchUpdate/);
    const reservation = source('45_DestinationIndex.gs').split('function reserveDestinationRows(')[1].split('// Keep the mapping')[0];
    assert.doesNotMatch(reservation, /getValues\(\)|getFormulas\(\)|setValues\(/);
  });
};

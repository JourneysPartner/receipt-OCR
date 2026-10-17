'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = ({test, assert, gas}) => {
  function clock(fn) {
    gas.stubs.reset(); gas.call('resetApiReadWindow_'); gas.call('resetApiBackoff_');
    let now = 1000000; const prior = gas.context.apiClockNow_;
    gas.context.apiClockNow_ = () => now;
    gas.stubs.setSleepHook(ms => { now += ms; });
    try { return fn(ms => { now += ms; }); }
    finally { gas.context.apiClockNow_ = prior; gas.stubs.setSleepHook(null); gas.call('resetApiReadWindow_'); }
  }
  test('kw26 10: lane skips locked smoothing but always enforces the window limit', () => clock(() => {
    gas.call('setReadLane_', [0, 2]); gas.call('setReadQuotaSmoothing_', [true]);
    assert.equal(gas.call('paceSheetsRead_'), 0);
    assert.equal(gas.call('paceSheetsRead_'), 2223);
    gas.call('withScriptLock_', [() => {
      assert.equal(gas.context.scriptLockHeld_, true);
      assert.equal(gas.call('paceSheetsRead_'), 0);
      assert.equal(gas.call('paceSheetsRead_'), 0);
      gas.context.apiReadWindow_ = Array(27).fill(gas.context.apiClockNow_());
      assert.equal(gas.call('paceSheetsRead_'), 60250);
    }]);
    assert.equal(gas.context.scriptLockHeld_, false);
    gas.call('clearReadLane_'); gas.call('withScriptLock_', [() => {
      assert.equal(gas.call('paceSheetsRead_'), 1091);
    }]);
    assert.throws(() => gas.call('withScriptLock_', [() => { throw Error('callback'); }]));
    assert.equal(gas.context.scriptLockHeld_, false);
  }));
  test('kw26 11: reserve sleeps before tryLock and lock wait excludes pacing', () => clock(advance => {
    const lock = gas.stubs.getScriptLock(), real = lock.tryLock;
    const events = [];
    gas.stubs.setSleepHook(ms => { assert.equal(lock.locked, false); events.push(['sleep', ms]); advance(ms); });
    lock.tryLock = function(ms) { events.push(['try', ms]); advance(17); return real.call(this, ms); };
    try {
      gas.call('setReadLane_', [0, 2]);
      gas.context.apiReadWindow_ = Array.from({length: 25}, (_, i) => 990000 + i * 100);
      gas.call('withScriptLock_', [() => 42]);
      assert.deepEqual(events, [['sleep', 50450], ['try', 60000]]);
      assert.equal(gas.context.apiBackoff_.paceMs, 50450);
      assert.equal(gas.context.apiReadPacedTotalMs_, 50450);
      assert.deepEqual(gas.json('apiScriptLockWaits_'), {count: 1, ms: 17, worstMs: 17});
      events.length = 0;
      gas.context.apiReadWindow_ = Array(22).fill(gas.context.apiClockNow_());
      gas.call('withScriptLock_', [() => {}]); assert.equal(events.length, 1);
      gas.call('clearReadLane_'); events.length = 0;
      gas.context.apiReadWindow_ = Array(55).fill(gas.context.apiClockNow_());
      gas.call('withScriptLock_', [() => {}]); assert.equal(events.length, 1);
    } finally { lock.tryLock = real; }
  }));
  test('kw26 10: a split window larger than the lane budget clears enough entries before reading', () => clock(() => {
    gas.call('setReadLane_', [0, 2]);
    // 準備が60回を残すと各本は30回を受け取る。最古の1回だけでは枠27へ戻れない。
    gas.context.apiReadWindow_ = Array.from({length: 30}, (_, i) => 995000 + i * 100);
    assert.equal(gas.call('paceSheetsRead_'), 55550);
    assert.ok(gas.context.apiReadWindow_.length <= 27);
  }));
  test('kw26 16: default lock timeout is 60000 and passed to tryLock', () => clock(() => {
    assert.equal(gas.defaultSettings.LOCK_TIMEOUT_MS, 60000);
    const lock = gas.stubs.getScriptLock(), real = lock.tryLock; let timeout;
    lock.tryLock = function(ms) { timeout = ms; return real.call(this, ms); };
    try { gas.call('withScriptLock_', [() => {}]); assert.equal(timeout, 60000); }
    finally { lock.tryLock = real; }
  }));
  test('kw26 27: preparation authorization lane dispatch and live lease constant stay scoped', () => {
    const root = path.resolve(__dirname, '../src');
    const web = fs.readFileSync(path.join(root, '80_WebApp.gs')).toString('utf8');
    assert.match(web, /function webAppPrepareImport\(/);
    // The public entry must reach the existing authorization operation, including through a shared body.
    assert.match(web, /webAppAuthorizeCustomer_\(customerId, 'WEBAPP:記帳'\)/);
    const users = fs.readdirSync(root).filter(f => f.endsWith('.gs') &&
      fs.readFileSync(path.join(root, f)).toString('utf8').includes('LIVE_LEASE_MAX_AGE_SECONDS_'));
    assert.deepEqual(users.sort(), ['71_RunOrchestrator.gs', '80_WebApp.gs']);
    const ui = fs.readFileSync(path.join(root, '81_WebAppUi.html'), 'utf8');
    assert.match(ui, /gasCall\('webAppRunImport',[\s\S]{0,300}lane:/);
  });
};

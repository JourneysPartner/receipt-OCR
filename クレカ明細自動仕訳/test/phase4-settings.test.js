'use strict';

/**
 * 4.6 設定検証（CR-5・INV-41）。
 *
 * ある操作に無関係な設定の不備で、その操作を拒否してはならない。
 * Ver.2.2 はコーパスフォルダへのアクセス可否を全処理の必須検証にしており、
 * 共有権限がシステム管理者以上に限定されている以上、**確認担当者は明細を
 * 1件も取り込めなかった**。CR-G と同型の欠陥が別の場所で再発したものである。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));

  /** 検証を通る設定一式にする。 */
  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: []});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.evaluate(`
      SETTINGS.EXECUTION_TIMEOUT_SECONDS = 300;
      SETTINGS.SAFETY_MARGIN_SECONDS = 60;
      SETTINGS.TX_INDEX_SPREADSHEET_ID = 'txidx';
      SETTINGS.SNAPSHOT_SPREADSHEET_ID = 'snap';
      SETTINGS.SAMPLE_CORPUS_FOLDER_ID = 'corpus';
      SETTINGS.PARALLEL_WORK_FOLDER_ID = '';
      SETTINGS.FAULT_INJECTION = null;
    `);
  }

  /** 検査2（シート存在）を通す文脈。 */
  const context = (overrides = {}) => Object.assign({
    sheetNames: gas.evaluate(
      'CONFIG.REQUIRED_SHEET_KEYS.map(function(k){return CONFIG.SHEET_NAMES[k];})'),
    customerFolderIds: ['folder1', 'folder2'],
    corpusFolderAccessible: true,
    corpusFolderAncestors: ['root']
  }, overrides);

  const validate = (scope, ctx) =>
    plain(gas.call('validateSettings', [scope, ctx || context()]));

  // ================= scope ごとの検査範囲 =================

  test('4.6: every scope runs its own set of checks', () => {
    setup();
    const ids = (scope) => plain(gas.call('settingsChecksFor', [scope])).map((c) => c.id);
    assert.ok(ids('IMPORT').indexOf(13) >= 0, 'import checks the id comparison');
    assert.ok(ids('IMPORT').indexOf(14) < 0, 'import must not open the corpus folder');
    assert.ok(ids('FORMAT_REGISTRATION').indexOf(14) >= 0);
    assert.ok(ids('ADMIN').indexOf(15) >= 0);
  });

  test('4.6: an unknown scope is rejected rather than silently passing everything', () => {
    setup();
    assert.throws(() => gas.call('settingsChecksFor', ['ANYTHING']),
      (error) => error && /validation scope/.test(String(error.message)));
  });

  // ---- CR-5：取込はコーパスフォルダを開かない ----
  //
  // 9.3 によりコーパスフォルダの共有はシステム管理者以上に限定されている。
  // 取込の必須検証にフォルダアクセスを含めると、確認担当者は必ず不合格になる。
  test('CR-5: a reviewer with no corpus access can still import', () => {
    setup();
    const result = validate('IMPORT', context({corpusFolderAccessible: false}));
    assert.equal(result.ok, true,
      'requiring corpus access here stops the reviewer processing any file at all');
  });

  test('CR-5: format registration does check the corpus folder access', () => {
    setup();
    const result = validate('FORMAT_REGISTRATION', context({corpusFolderAccessible: false}));
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].check, 14,
      'the path that uses the folder is where the access check belongs');
  });

  // ---- 対象年度の是正はコーパス設定に依存しない（INV-41） ----
  test('INV-41: fixing the fiscal year does not require corpus settings at all', () => {
    setup();
    gas.evaluate("SETTINGS.SAMPLE_CORPUS_FOLDER_ID = ''; SETTINGS.MAX_CORPUS_SAMPLES = 0;");
    const result = validate('CUSTOMER_MASTER', context({corpusFolderAccessible: false}));
    assert.equal(result.ok, true,
      'a recovery path must not be blocked by settings unrelated to the defect');
  });

  test('INV-41: the same unrelated defect does stop format registration', () => {
    setup();
    gas.evaluate("SETTINGS.SAMPLE_CORPUS_FOLDER_ID = '';");
    assert.equal(validate('FORMAT_REGISTRATION').ok, false,
      'the check still exists - it is scoped, not removed');
  });

  // ================= 個々の検査 =================

  test('4.6: a healthy configuration passes every scope', () => {
    setup();
    ['IMPORT', 'FORMAT_REGISTRATION', 'CUSTOMER_MASTER', 'ADMIN'].forEach((scope) => {
      const result = validate(scope);
      assert.equal(result.ok, true,
        `${scope}: ${result.problems.map((p) => p.detail).join('; ')}`);
    });
  });

  test('check 6: the safety margin must sit below the execution timeout', () => {
    setup();
    gas.evaluate('SETTINGS.SAFETY_MARGIN_SECONDS = 400;');
    const result = validate('IMPORT');
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].check, 6);
  });

  test('check 9: the warn threshold must sit below the stop threshold', () => {
    setup();
    gas.evaluate('SETTINGS.LOG_CAPACITY_WARN_PERCENT = 99; SETTINGS.LOG_CAPACITY_STOP_PERCENT = 95;');
    assert.equal(validate('IMPORT').ok, false,
      'a warning that fires after the stop is useless');
  });

  // 同じシートを3つの用途で使うと、容量上限を食い合って全体が止まる。
  test('check 11: the index and snapshot must not be the master spreadsheet', () => {
    setup();
    gas.evaluate("SETTINGS.TX_INDEX_SPREADSHEET_ID = 'master';");
    const result = validate('IMPORT');
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].check, 11);
  });

  // 窓が12か月以上あると、年なし日付の候補年が常に2つ以上になる。
  test('check 12: the year inference window must span less than twelve months', () => {
    setup();
    gas.evaluate(`
      SETTINGS.YEAR_INFERENCE_MAX_LOOKBACK_MONTHS = 11;
      SETTINGS.YEAR_INFERENCE_MAX_FORWARD_MONTHS = 1;
    `);
    const result = validate('IMPORT');
    assert.equal(result.ok, false);
    assert.ok(/less than 12 months/.test(result.problems[0].detail),
      'no file could ever resolve a yearless date under this setting');
  });

  test('check 13: the corpus folder must not be a customer statement folder', () => {
    setup();
    gas.evaluate("SETTINGS.SAMPLE_CORPUS_FOLDER_ID = 'folder1';");
    const result = validate('IMPORT');
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].check, 13);
  });

  // 顧客フォルダの配下に置くと、顧客が匿名化前のサンプルを見得る。
  test('check 14: the corpus folder must not sit under a customer folder', () => {
    setup();
    const result = validate('FORMAT_REGISTRATION',
      context({corpusFolderAncestors: ['folder1', 'root']}));
    assert.equal(result.ok, false);
    assert.ok(/under a customer/.test(result.problems[0].detail));
  });

  test('check 3: an unset log retention is tolerated, an unset timeout is not', () => {
    setup();
    gas.evaluate('SETTINGS.LOG_RETENTION_YEARS = null;');
    assert.equal(validate('IMPORT').ok, true,
      'not deleting anything is the safe side of that setting');

    gas.evaluate('SETTINGS.EXECUTION_TIMEOUT_SECONDS = null;');
    assert.equal(validate('IMPORT').ok, false);
  });

  test('check 2: a missing required sheet is named', () => {
    setup();
    const names = context().sheetNames.slice(1);
    const result = validate('IMPORT', context({sheetNames: names}));
    assert.equal(result.ok, false);
    assert.ok(/missing sheets/.test(result.problems[0].detail));
  });

  // ================= 本番での障害注入 =================

  test('check 10: fault injection enabled against production blocks startup', () => {
    setup();
    gas.evaluate(`
      PropertiesService.getScriptProperties()
        .setProperty('PRODUCTION_MASTER_SPREADSHEET_ID', 'master');
      SETTINGS.FAULT_INJECTION = {WRITE_HALF: true};
    `);
    const result = validate('IMPORT');
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].check, 10,
      'silently ignoring it would leave the operator believing it is active');
    gas.evaluate('SETTINGS.FAULT_INJECTION = null;');
  });

  test('4.6: production is identified by the stored production master id', () => {
    setup();
    assert.equal(gas.call('isProductionEnvironment', []), false);
    gas.evaluate(`PropertiesService.getScriptProperties()
      .setProperty('PRODUCTION_MASTER_SPREADSHEET_ID', 'master');`);
    assert.equal(gas.call('isProductionEnvironment', []), true);
  });

  // ================= 書込前の関門 =================

  test('4.6: assertSafeToWrite throws before anything is written', () => {
    setup();
    gas.evaluate('SETTINGS.SAFETY_MARGIN_SECONDS = 400;');
    assert.throws(() => gas.call('assertSafeToWrite', ['IMPORT', context()]),
      (error) => error && /#6/.test(String(error.message)),
      'the failing check must be identifiable from the message');
  });

  test('4.6: assertSafeToWrite returns the result when everything is valid', () => {
    setup();
    assert.equal(plain(gas.call('assertSafeToWrite', ['IMPORT', context()])).ok, true);
  });

  // ================= Script Properties からの読込 =================

  test('11: settings are loaded from script properties with their types kept', () => {
    setup();
    gas.evaluate(`
      var props = PropertiesService.getScriptProperties();
      props.setProperty('MAX_CORPUS_SAMPLES', '25');
      props.setProperty('SAMPLE_CORPUS_FOLDER_ID', 'corpus-2');
      props.setProperty('SOMETHING_ELSE', 'x');
    `);
    const result = plain(gas.call('loadSettingsFromProperties', []));

    assert.equal(gas.evaluate('SETTINGS.MAX_CORPUS_SAMPLES'), 25);
    assert.equal(typeof gas.evaluate('SETTINGS.MAX_CORPUS_SAMPLES'), 'number',
      'a numeric setting read as a string would compare wrongly everywhere');
    assert.equal(gas.evaluate('SETTINGS.SAMPLE_CORPUS_FOLDER_ID'), 'corpus-2');
    assert.ok(result.ignored.indexOf('SOMETHING_ELSE') >= 0,
      'an unknown key must be reported, not silently added to SETTINGS');
  });

  test('11: an unparseable numeric setting is ignored rather than becoming NaN', () => {
    setup();
    const before = gas.evaluate('SETTINGS.MAX_CORPUS_SAMPLES');
    gas.evaluate(`PropertiesService.getScriptProperties()
      .setProperty('MAX_CORPUS_SAMPLES', 'many');`);
    const result = plain(gas.call('loadSettingsFromProperties', []));

    assert.equal(gas.evaluate('SETTINGS.MAX_CORPUS_SAMPLES'), before,
      'NaN would silently disable every comparison against this limit');
    assert.ok(result.ignored.indexOf('MAX_CORPUS_SAMPLES') >= 0);
  });

  // ================= 障害注入設定のキャッシュ =================

  test('4.39: the fault injection config is read once per execution', () => {
    setup();
    gas.evaluate(`
      resetFaultInjectionCache_();
      PropertiesService.getScriptProperties()
        .setProperty('FAULT_INJECTION', JSON.stringify({WRITE_HALF: true}));
    `);
    const first = plain(gas.call('getCachedFaultInjectionConfig', []));
    assert.deepEqual(first, {WRITE_HALF: true});

    gas.evaluate(`PropertiesService.getScriptProperties()
      .setProperty('FAULT_INJECTION', JSON.stringify({OTHER: true}));`);
    assert.deepEqual(plain(gas.call('getCachedFaultInjectionConfig', [])), {WRITE_HALF: true},
      're-reading mid-run would enable only some stop points and never reproduce');

    gas.evaluate('resetFaultInjectionCache_();');
  });
};

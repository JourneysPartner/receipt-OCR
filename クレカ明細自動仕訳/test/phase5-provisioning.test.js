'use strict';

/**
 * 10.4 導入時の初期化。
 *
 * 要点は2つ：検査2が要求する全シートが揃うこと、そして**冪等であること**。
 * 初期化のやり直しが既存データを消せる作りは、導入手順の事故が本番データの
 * 消失になる。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
  }

  test('10.4: provisioning creates every sheet that check 2 requires', () => {
    setup();
    const result = plain(gas.call('provisionMasterSheets', []));
    assert.equal(result.created.length, 20);

    const context = {
      sheetNames: gas.evaluate(
        "masterSpreadsheet_().getSheets().map(function(s){return s.getName();})"),
      customerFolderIds: [], corpusFolderAccessible: true, corpusFolderAncestors: []
    };
    const checks = plain(gas.call('validateSettings', ['ADMIN', context]));
    assert.ok(!checks.problems.some((p) => p.check === 2),
      'check 2 must be satisfied by what provisioning built: ' +
      JSON.stringify(checks.problems.filter((p) => p.check === 2)));
  });

  test('10.4: provisioning widens every sheet to the width its reader expects', () => {
    // 幅が2か所（初期化の一覧と読み手の定数）にあり、片方だけ増やすと
    // 実機でだけ範囲外になる ── 列を足しても`widened`が空のままで、
    // 新しい列が永久に読めない（顧客マスターAO列で起きた。2026-09-08）。
    setup();
    gas.call('provisionMasterSheets', []);
    const widthOf = (name) => gas.evaluate(
      "masterSpreadsheet_().getSheetByName('" + name + "').getMaxColumns()");
    const readers = [
      ['CUSTOMER_MASTER', 'CUSTOMER_MASTER_COLUMNS_'],
      ['CARD_FORMAT_MASTER', 'CARD_FORMAT_COLUMNS_'],
      ['PROCESS_LOG', 'PROCESS_LOG_WIDTH_'],
      ['TRANSACTION_LOG', 'TRANSACTION_LOG_WIDTH_'],
      ['PERMANENT_FILE_INDEX', 'FILE_INDEX_WIDTH_']
    ];
    const narrow = [];
    readers.forEach(([key, constant]) => {
      const name = gas.evaluate("CONFIG.SHEET_NAMES." + key);
      const expected = gas.evaluate(constant);
      const actual = widthOf(name);
      if (actual < expected) {
        narrow.push(`${name}: 初期化は${actual}列だが${constant}は${expected}列を読む`);
      }
    });
    assert.deepEqual(narrow, []);
  });

  test('10.4: provisioning is idempotent and never touches an existing sheet', () => {
    setup();
    gas.call('provisionMasterSheets', []);
    // 既存シートへデータを入れた状態でやり直す
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName('クレカ取引ログ');
    sheet.getRange(2, 1).setValue('TX_EXISTING');

    const second = plain(gas.call('provisionMasterSheets', []));
    assert.equal(second.created.length, 0);
    assert.equal(second.existing.length, 20);
    assert.equal(sheet.getRange(2, 1).getValue(), 'TX_EXISTING',
      're-running the installer must never be able to destroy data');
  });

  test('10.4: narrow grids are widened to the spec width without touching values', () => {
    setup();
    // 実機のinsertSheetは既定26列。45列の取引ログへ書けるようになること。
    const first = plain(gas.call('provisionMasterSheets', []));
    const txLog = gas.stubs.getSpreadsheet('master').getSheetByName('クレカ取引ログ');
    assert.ok(txLog.getMaxColumns() >= 45,
      'a default 26-column grid would reject the 45-column transaction log write');
    assert.ok(first.widened.indexOf('クレカ取引ログ') >= 0);

    // 既存の狭いシート＋既存データも、値を変えずに広がる
    txLog.getRange(2, 1).setValue('TX_KEEP');
    const again = plain(gas.call('provisionMasterSheets', []));
    assert.equal(again.created.length, 0);
    assert.equal(txLog.getRange(2, 1).getValue(), 'TX_KEEP');
  });

  test('check 11: the auxiliary spreadsheet gains its capacity probe', () => {
    setup();
    gas.stubs.createSpreadsheet('txidx', {sheets: [{name: '仮', values: [['x']]}]});
    const result = plain(gas.call('provisionAuxiliarySpreadsheet', ['txidx']));
    assert.deepEqual(result.created, ['容量プローブ']);
  });

  test('check 11: the auxiliary spreadsheet must not be the master itself', () => {
    setup();
    gas.call('setMasterSpreadsheetId', ['master']);
    assert.throws(() => gas.call('provisionAuxiliarySpreadsheet', ['master']),
      (error) => error && /differ from the master/.test(String(error.message)),
      'one file serving three uses competes for a single cell limit');
  });

  test('10.4: installation properties round-trip into the settings loader', () => {
    setup();
    gas.call('saveInstallationProperties', [{
      MASTER_SPREADSHEET_ID: 'master',
      TX_INDEX_SPREADSHEET_ID: 'txidx',
      SNAPSHOT_SPREADSHEET_ID: 'snap',
      SAMPLE_CORPUS_FOLDER_ID: 'corpus',
      EXECUTION_TIMEOUT_SECONDS: '300'
    }]);
    const loaded = plain(gas.call('loadSettingsFromProperties', []));
    assert.ok(loaded.loaded.indexOf('TX_INDEX_SPREADSHEET_ID') >= 0);
    assert.equal(gas.evaluate('SETTINGS.EXECUTION_TIMEOUT_SECONDS'), 300,
      'numeric settings must arrive as numbers');
    assert.equal(gas.evaluate('resolveMasterSpreadsheetId_()'), 'master');
  });
};

'use strict';

/**
 * INV-25：走査・照合の対象には必ず絞込と件数上限を置く。
 *
 * スタブ上では全面走査も一瞬で終わるので、速度では検出できない。読んだ
 * セル数とレンジ数で見る。実 GAS では取引ログが45列×数万行、監査ログが
 * 年5万行に達する設計であり、全面走査は実行時間上限とAPIクォータの
 * 両方に当たる。
 */
module.exports = ({test, assert, gas}) => {
  const blank = (n) => Array(n).fill('');
  const sheetHeader = (n, label) => { const r = blank(n); r[0] = label; return r; };

  /** 取引ログを模した幅45列のシートを rows 行ぶん作る。 */
  function setupWideSheet(rows) {
    gas.stubs.reset();
    const values = [sheetHeader(45, '取引ID完全値')];
    for (let i = 0; i < rows; i += 1) {
      const row = blank(45);
      row[0] = 'TX_' + String(i).padStart(4, '0');
      row[4] = 'file1';
      values.push(row);
    }
    gas.stubs.createSpreadsheet('master', {sheets: [{name: 'ワイド', values}]});
    gas.stubs.setActiveSpreadsheet('master');
    return gas.stubs.getSpreadsheet('master');
  }

  test('INV-25: looking a row up by id reads the key column, not the whole sheet', () => {
    const spreadsheet = setupWideSheet(200);
    spreadsheet.counters.rangeReads = 0;
    spreadsheet.counters.cellsRead = 0;

    const found = JSON.parse(JSON.stringify(gas.evaluate(
      "findRowsByColumnValue_(SpreadsheetApp.openById('master').getSheetByName('ワイド'), 1, 'TX_0150', 45)")));

    assert.equal(found.length, 1);
    assert.equal(found[0].rowNumber, 152);
    assert.equal(found[0].values[0], 'TX_0150');

    // 200行×45列 = 9,000セル。鍵列200セル + 一致した1行45セル で足りる。
    assert.ok(spreadsheet.counters.cellsRead < 400,
      `a keyed lookup must not read the whole sheet; read ${spreadsheet.counters.cellsRead} cells`);
  });

  test('INV-25: a lookup that matches nothing still reads only the key column', () => {
    const spreadsheet = setupWideSheet(200);
    spreadsheet.counters.rangeReads = 0;
    spreadsheet.counters.cellsRead = 0;

    const found = gas.evaluate(
      "findRowsByColumnValue_(SpreadsheetApp.openById('master').getSheetByName('ワイド'), 1, 'TX_NONE', 45)");
    assert.equal(found.length, 0);
    assert.ok(spreadsheet.counters.cellsRead <= 200,
      `read ${spreadsheet.counters.cellsRead} cells for a miss`);
  });

  test('INV-25: several matching rows are fetched in few requests, not one per row', () => {
    gas.stubs.reset();
    const values = [sheetHeader(45, '取引ID完全値')];
    for (let i = 0; i < 100; i += 1) {
      const row = blank(45);
      row[0] = 'TX_' + i;
      row[4] = i < 30 ? 'file1' : 'file2';   // 先頭30行が連続して一致する
      values.push(row);
    }
    gas.stubs.createSpreadsheet('master', {sheets: [{name: 'ワイド', values}]});
    gas.stubs.setActiveSpreadsheet('master');
    const spreadsheet = gas.stubs.getSpreadsheet('master');
    spreadsheet.counters.rangeReads = 0;

    const found = gas.evaluate(
      "findRowsByColumnValue_(SpreadsheetApp.openById('master').getSheetByName('ワイド'), 5, 'file1', 45)");
    assert.equal(found.length, 30);
    assert.ok(spreadsheet.counters.rangeReads <= 3,
      `30 consecutive rows must not cost 30 reads; used ${spreadsheet.counters.rangeReads}`);
  });

  // ---- 書込は列ごとに連続行をまとめる ----
  test('4.23: writing a batch groups consecutive rows instead of one range per cell', () => {
    gas.stubs.reset();
    const customerValues = blank(37);
    Object.assign(customerValues, {
      0: 'C001', 1: '顧客A', 2: 'TRUE', 3: 'folder1', 5: 'dest1', 7: '入力用シート',
      8: '取引先一覧', 9: 2, 10: 6, 11: 9, 12: 11, 13: 13, 14: 30, 15: '1.0',
      16: 'r@example.com', 17: 'a@example.com', 18: 0, 20: 'システム情報', 21: 'ACTIVE',
      23: 0, 24: 0, 29: 1, 30: '{}', 31: '{}', 32: '{}', 33: 30,
      34: '取引先一覧', 35: 'CORPORATE', 36: ''
    });
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [sheetHeader(37, '顧客ID'), customerValues]},
      {name: 'クレカ処理ログ', values: [sheetHeader(40, '実行ID')]},
      {name: 'クレカ取引ログ', values: [sheetHeader(45, '取引ID完全値')]},
      {name: '監査ログ', values: [sheetHeader(15, '監査ID')]},
      {name: '処理リース', values: [sheetHeader(10, 'リースID')]},
      {name: '恒久ファイルインデックス', values: [sheetHeader(13, 'ファイルID')]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    const header = blank(30);
    header[1] = '利用日'; header[12] = '金額'; header[29] = '内部ID';
    const destRows = [header].concat(Array.from({length: 20}, () => blank(30)));
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート', values: destRows, formulas: destRows.map(() => blank(30)),
       maxRows: 21, maxColumns: 30}
    ]});
    gas.stubs.createFile('file1', {name: '明細.csv', data: 'a'});

    const customer = gas.call('getCustomerById', ['C001']);
    gas.call('createOrUpdateProcessLog', ['RUN_1', customer, {
      id: 'file1', name: '明細.csv', binaryHash: 'b'.repeat(64),
      contentHash: 'c'.repeat(64), hashVersion: '3', state: 'WRITING'
    }]);
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'a@example.com', 'PROCESS']);

    // 連続する20行へ5列ずつ書く
    const rowWrites = Array.from({length: 20}, (_, i) => gas.call('buildRowWrite', [i + 2, {
      fullTxId: 'TX_' + i,
      planned: {b: '2026-01-02', f: '取引先', i: '仕入れ', k: '店舗', m: 1000}
    }]));

    gas.stubs.resetApiCallCounts();
    gas.call('writeTransactionRows', [customer, rowWrites, leaseId, 'file1']);
    const counts = gas.stubs.getApiCallCounts();

    // 1セル1レンジなら 20行 × 6列 = 120 レンジ。列ごとにまとめれば6レンジ。
    assert.ok(counts.rangesWritten <= 12,
      `20 consecutive rows must not cost one range per cell; used ${counts.rangesWritten}`);
    // valueInputOption は要求単位なので RAW と USER_ENTERED で2回に分かれる
    assert.equal(counts.batchUpdate, 2);

    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    assert.equal(sheet.getRange(2, 2).getValue(), '2026-01-02');
    assert.equal(sheet.getRange(21, 13).getValue(), 1000);
    assert.equal(sheet.getRange(21, 30).getValue(), 'TX_19');
  });

  // ---- トリガー実行にはアクティブなスプレッドシートが無い ----
  test('4.6: a trigger run without a configured master spreadsheet fails clearly', () => {
    gas.stubs.reset();
    // トリガー実行を模す：アクティブなスプレッドシートが存在しない
    assert.throws(() => gas.call('masterSpreadsheet_', []),
      (error) => error && /MASTER_SPREADSHEET_ID/.test(String(error.message)),
      'it must name the missing setting, not fail deep inside a data access');
  });

  test('4.6: the master spreadsheet id can come from script properties', () => {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: 'X', values: [['a']]}]});
    // アクティブなスプレッドシートは設定しない（トリガー実行と同じ状況）
    gas.call('setMasterSpreadsheetId', ['master']);
    assert.equal(gas.evaluate('masterSpreadsheet_().getId()'), 'master',
      'a scheduled run must be able to find the master sheet on its own');
  });

  // ---- 監査ログのアンカー探索 ----
  test('INV-25: finding the chain anchor reads one column, not one cell per row', () => {
    gas.stubs.reset();
    const values = [sheetHeader(15, '監査ID')];
    for (let i = 0; i < 300; i += 1) {
      const row = blank(15);
      row[0] = 'AU_' + i;
      row[13] = i === 0 ? 'GENESIS' : 'h'.repeat(64);   // 起点は先頭だけ
      values.push(row);
    }
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '監査ログ', values}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    const spreadsheet = gas.stubs.getSpreadsheet('master');
    gas.evaluate("CONFIG.AUDIT_CHAIN_GENESIS = 'GENESIS';");
    spreadsheet.counters.rangeReads = 0;
    spreadsheet.counters.cellsRead = 0;

    const anchor = JSON.parse(JSON.stringify(gas.call('getLastAnchorRow', [])));
    assert.equal(anchor.rowNumber, 2, 'the genesis row must be found');

    // 起点が最古の行にある＝最悪の場合。1セルずつ遡ると300回になる。
    assert.ok(spreadsheet.counters.rangeReads <= 3,
      `anchor search used ${spreadsheet.counters.rangeReads} reads for 300 rows`);
    assert.ok(spreadsheet.counters.cellsRead < 400,
      `anchor search read ${spreadsheet.counters.cellsRead} cells`);
  });
};

'use strict';

/**
 * 6.1 実行結線の端から端まで：Driveのファイル → 入力用シート。
 *
 * ここまでの各テストは材料単体を検証した。本ファイルは**結線そのもの**を
 * 検証する ── 発見・読取・判定・抽出・補完・検証・転記・確定・改名が
 * `runImport`1回で起きること、そして落ちるべきファイルが正しい状態へ
 * 落ちることを、シートの中身で確認する。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const blank = (n) => Array(n).fill('');
  const sheetHeader = (n, label) => { const r = blank(n); r[0] = label; return r; };
  const hourAgo = () => new Date(Date.now() - 3600 * 1000);

  const AE = JSON.stringify({row: 1, cells: [{column: 2, text: '利用日', match: 'exact'}]});

  function customerRow() {
    const row = blank(37);
    Object.assign(row, {
      0: 'C001', 1: '顧客A', 2: 'TRUE', 3: 'folder1', 5: 'dest1', 7: '入力用シート', 8: '取引先一覧',
      9: 2, 10: 3, 11: 4, 12: 5, 13: 6, 14: 7, 15: '1.0',
      16: 'reviewer@example.com', 17: 'admin@example.com', 18: 0, 20: 'システム情報', 21: '',
      23: 0, 24: 0, 29: 1, 30: AE, 31: '{}', 32: '{}', 33: 8,
      34: '取引先一覧', 35: 'CORPORATE', 36: ''
    });
    return row;
  }

  function formatRow() {
    const row = blank(34);
    Object.assign(row, {
      0: 'smbc_family', 1: '三井住友系', 2: 'active', 3: 'TRUE', 4: '["csv"]',
      5: JSON.stringify({allOf: [{maxRow: 1, keywords: ['利用日', '利用店名', '金額', '使用用途'], minMatch: 4}]}),
      6: 1, 7: 2, 8: 'A', 9: 'B', 10: 'C', 11: 'D', 12: '',
      14: JSON.stringify({excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []}),
      16: JSON.stringify({sources: [{id: 'fn', kind: 'fileName', pattern: '(20\\d{2})(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}]}),
      17: 'generic', 18: 1, 19: 'admin@example.com', 21: '2026-01-01T00:00:00+09:00',
      29: 'NEW', 33: '2026-01-01T00:00:00+09:00'
    });
    return row;
  }

  function dictRow() {
    const row = blank(18);
    Object.assign(row, {
      0: 'DICT_1', 1: 'ローソン', 2: 'ローソン', 3: '株式会社ローソン',
      4: 'exact_original', 5: 1, 6: '', 7: '', 8: '', 9: 'TRUE',
      10: 'admin@example.com', 12: '2026-01-01T00:00:00+09:00', 13: 1,
      14: 'TRUE', 15: 'FALSE'
    });
    return row;
  }

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [sheetHeader(37, '顧客ID'), customerRow()]},
      {name: 'カード形式マスター', values: [sheetHeader(34, '形式ID'), formatRow()]},
      {name: '使用用途補完マスター', values: [sheetHeader(10, 'ルールID'),
        Object.assign(blank(10), {0: 'PR1', 1: '仕入', 2: '仕入れ', 3: 'TRUE'})]},
      {name: '共通取引先辞書', values: [sheetHeader(18, '辞書ID'), dictRow()]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);   // 残りの必須シートを冪等に作る
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート',
       values: [['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID', '']],
       maxRows: 12, maxColumns: 8},
      {name: '取引先一覧', values: [['取引先']]}
    ]});
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createSpreadsheet('snap', {sheets: []});
    gas.evaluate(`
      SETTINGS.EXECUTION_TIMEOUT_SECONDS = 300;
      SETTINGS.SAFETY_MARGIN_SECONDS = 60;
      SETTINGS.TX_INDEX_SPREADSHEET_ID = 'txidx';
      SETTINGS.SNAPSHOT_SPREADSHEET_ID = 'snap';
      SETTINGS.SAMPLE_CORPUS_FOLDER_ID = 'corpus';
      SETTINGS.PARALLEL_WORK_FOLDER_ID = '';
      SETTINGS.FAULT_INJECTION = null;
    `);
    gas.stubs.setActiveUser('admin@example.com');
  }

  function putCsv(fileId, name, content) {
    gas.stubs.createFile(fileId, {
      name, bytes: Buffer.from(content, 'utf8'), lastUpdated: hourAgo(),
      createdTime: '2026-08-01T00:00:00Z', contentType: 'text/csv'
    });
  }

  const destSheet = () => gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
  const cellDate = (row, col) => {
    const value = destSheet().getRange(row, col).getValue();
    return value instanceof Date ?
      value.toLocaleDateString('sv-SE', {timeZone: 'Asia/Tokyo'}) : value;
  };

  test('6.1 end to end: a Drive CSV lands in the customer sheet as committed rows', () => {
    setup();
    putCsv('fileA', '三井住友カード202601.csv',
      '利用日,利用店名,金額,使用用途\n2025/12/16,ローソン,10800,仕入れ\n12/28,ローソン,2900,仕入れ\n');
    gas.stubs.createFolder('folder1', {fileIds: ['fileA']});

    const report = plain(gas.call('runImport', [{}]));
    assert.equal(report.stoppedBy, null, JSON.stringify(report));
    const fileReport = report.customers[0].files[0];
    assert.equal(fileReport.outcome, 'WRITTEN', JSON.stringify(fileReport));
    assert.equal(fileReport.nextState, 'COMPLETED');
    assert.equal(fileReport.written, 2);

    // 転記先の中身：日付・取引先・用途・元店名・金額・取引ID。
    assert.equal(cellDate(2, 2), '2025-12-16');
    assert.equal(destSheet().getRange(2, 3).getValue(), '株式会社ローソン');
    assert.equal(destSheet().getRange(2, 4).getValue(), '仕入れ');
    assert.equal(destSheet().getRange(2, 5).getValue(), 'ローソン');
    assert.equal(destSheet().getRange(2, 6).getValue(), 10800);
    assert.ok(String(destSheet().getRange(2, 7).getValue()).indexOf('TX_') === 0);
    // 年なし12/28は締め2025-12（支払2026-01−1）から2025-12-28へ補完される。
    assert.equal(cellDate(3, 2), '2025-12-28');

    // 取引ログ・ファイル状態・Drive名・リース。
    const row2Tx = String(destSheet().getRange(2, 7).getValue());
    assert.equal(gas.call('getTransaction', [row2Tx]).transactionStatus, 'COMMITTED');
    const indexState = gas.stubs.getSpreadsheet('master')
      .getSheetByName('恒久ファイルインデックス').getRange(2, 4).getValue();
    assert.equal(indexState, 'COMPLETED');
    assert.equal(gas.stubs.getFile('fileA').getName(), '【済】三井住友カード202601.csv');
    const leaseRows = gas.stubs.getSpreadsheet('master').getSheetByName('処理リース').getLastRow();
    assert.equal(leaseRows, 1, 'the lease must be released on completion');
  });

  test('6.1: an unresolved partner leaves F blank, registers PARTNER, and holds the file', () => {
    setup();
    putCsv('fileB', '三井住友カード202601.csv',
      '利用日,利用店名,金額,使用用途\n2025/12/16,ファミリーマート,2900,仕入れ\n');
    gas.stubs.createFolder('folder1', {fileIds: ['fileB']});

    const report = plain(gas.call('runImport', [{}]));
    const fileReport = report.customers[0].files[0];
    assert.equal(fileReport.outcome, 'WRITTEN');
    assert.equal(fileReport.nextState, 'REVIEW_WAIT');

    assert.equal(destSheet().getRange(2, 3).getValue(), '',
      'F must stay blank until a person resolves the partner (INV-01)');
    const txId = String(destSheet().getRange(2, 7).getValue());
    assert.equal(gas.call('getTransaction', [txId]).transactionStatus, 'REVIEW_REQUIRED');

    const reviews = plain(gas.call('openReviews', [{}]));
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].reviewType, 'PARTNER');
    assert.equal(String(reviews[0].fullTxId || reviews[0].targetTxId), txId);
  });

  test('6.1: an unknown format goes to REVIEW_WAIT with a review and no writes', () => {
    setup();
    putCsv('fileC', '謎の明細.csv', 'ぜんぜん違うヘッダー,こっち\n1,2\n');
    gas.stubs.createFolder('folder1', {fileIds: ['fileC']});

    const report = plain(gas.call('runImport', [{}]));
    const fileReport = report.customers[0].files[0];
    assert.equal(fileReport.outcome, 'NO_WRITE');
    assert.equal(fileReport.category, 2);
    assert.equal(fileReport.nextState, 'REVIEW_WAIT');
    assert.equal(destSheet().getLastRow(), 1, 'not a single cell may be written');
    const reviews = plain(gas.call('openReviews', [{}]));
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].reviewType, 'FORMAT_UNKNOWN');
    assert.equal(gas.stubs.getFile('fileC').getName(), '【処理中】謎の明細.csv');
  });

  test('6.1: an uncomplementable blank purpose bounces the file to the customer', () => {
    setup();
    putCsv('fileD', '明細202601.csv',
      '利用日,利用店名,金額,使用用途\n2025/12/16,ローソン,10800,\n');
    gas.stubs.createFolder('folder1', {fileIds: ['fileD']});

    const report = plain(gas.call('runImport', [{}]));
    const fileReport = report.customers[0].files[0];
    assert.equal(fileReport.category, 1);
    assert.equal(fileReport.nextState, 'CUSTOMER_FIX_REQUIRED');
    assert.equal(destSheet().getLastRow(), 1);
    assert.equal(gas.stubs.getFile('fileD').getName(), '【要修正】明細202601.csv');
  });

  test('5.4: a purpose-keyword file name complements the blank instead of bouncing', () => {
    setup();
    putCsv('fileE', '仕入_明細202601.csv',
      '利用日,利用店名,金額,使用用途\n2025/12/16,ローソン,10800,\n');
    gas.stubs.createFolder('folder1', {fileIds: ['fileE']});

    const report = plain(gas.call('runImport', [{}]));
    assert.equal(report.customers[0].files[0].nextState, 'COMPLETED');
    assert.equal(destSheet().getRange(2, 4).getValue(), '仕入れ',
      'the blank purpose is filled from the file-name rule');
  });

  test('12.2: the same statement under a new file id is stopped as a duplicate', () => {
    setup();
    const content = '利用日,利用店名,金額,使用用途\n2025/12/16,ローソン,10800,仕入れ\n';
    putCsv('fileF', '三井住友カード202601.csv', content);
    gas.stubs.createFolder('folder1', {fileIds: ['fileF']});
    plain(gas.call('runImport', [{}]));

    putCsv('fileG', '再提出202601.csv', content);
    gas.stubs.createFolder('folder1', {fileIds: ['fileF', 'fileG']});
    const second = plain(gas.call('runImport', [{}]));
    const fileReport = second.customers[0].files[0];
    assert.equal(fileReport.fileId, 'fileG');
    assert.equal(fileReport.category, 2);
    assert.equal(fileReport.nextState, 'REVIEW_WAIT');
    const reviews = plain(gas.call('openReviews', [{}]))
      .filter((r) => r.reviewType === 'DUPLICATE');
    assert.equal(reviews.length, 1);
  });

  test('runImport refuses to run for a user with no authorized customer', () => {
    setup();
    gas.stubs.setActiveUser('stranger@example.com');
    const report = plain(gas.call('runImport', [{}]));
    assert.equal(report.stoppedBy, 'NO_AUTHORIZED_CUSTOMER');
  });
};

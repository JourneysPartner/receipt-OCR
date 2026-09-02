'use strict';

/**
 * 実物のfreeeクレカ出納帳テンプレートへの適合（Ver.3.0・実装差戻し#16）。
 *
 * 実物は、未入力行にも J列（税計算区分＝税込）の既定値と N列（残高）の
 * 数式（0を表示）が**あらかじめ入っている**。5.11の空き行判定を素直に
 * 適用すると全行が使用中になり、書ける行が1行も存在しない。
 * 顧客マスターAL列（空き行判定除外列）がこれを吸収する。
 * 除外できるのは**システムが書かない列だけ**である。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const blank = (n) => Array(n).fill('');

  // 実物：1行目タイトル、3行目ヘッダー、4行目は入力禁止の仕切り行（残高0）、
  // 5行目以降が入力行（J=税込の既定値、N=残高数式が0を表示）。
  function freeeRows() {
    const title = blank(16); title[1] = '〇〇カード　出納帳';
    const header = blank(16);
    Object.assign(header, {1: '日付', 2: '相手科目', 3: '相手勘定科目', 5: '相手取引先',
      6: '相手税区分', 7: '品目', 8: 'メモタグ', 9: '税計算区分', 10: '摘要',
      11: '借方', 12: '貸方', 13: '残高'});
    const divider = blank(16); divider[13] = 0;
    const rows = [title, blank(16), header, divider];
    for (let i = 0; i < 6; i += 1) {
      const row = blank(16);
      row[9] = '税込';   // 既定値（値として入っている）
      row[13] = 0;       // 残高数式の表示値
      rows.push(row);
    }
    return rows;
  }

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート', values: freeeRows(), maxRows: 10, maxColumns: 16},
      {name: '取引先一覧', values: [['取引先']]}
    ]});
    // 残高列（N）には数式が入っている。表示値0とともに保持する。
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    for (let row = 5; row <= 10; row += 1) {
      sheet.formulas[row - 1][13] = '=N' + (row - 1) + '+L' + row + '-M' + row;
    }
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
    gas.stubs.setActiveUser('operator@example.com');
  }

  // 実物の列：B=日付(2) F=相手取引先(6) I=メモタグ(9) K=摘要(11) M=貸方(13)。
  // 取引ID列は利用者列の右の P(16)。J(10)と N(14) は既定値・数式列なので
  // 空き行判定から除外する。
  const CUSTOMER = {
    customerId: 'C001', customerName: 'テスト顧客',
    sourceFolderId: 'folder1', destinationSpreadsheetId: 'dest1',
    destinationSheetName: '入力用シート',
    columns: {B: 2, F: 6, I: 9, K: 11, M: 13, txId: 16},
    headerRow: 3, dataStartRow: 5,
    rowScanExcludedColumns: [10, 14],
    rowScanLastColumn: 16
  };

  test('the real freee template yields empty rows once J and N are excluded', () => {
    setup();
    gas.call('registerTestCustomer', [CUSTOMER]);
    const customer = gas.call('getCustomerById', ['C001']);
    assert.deepEqual(plain(customer.rowScanExcludedColumns), [10, 14]);

    const index = gas.call('buildIndex', [customer, {}]);
    const empty = plain(gas.call('findEmptyRows', [customer, 10, index]));
    assert.deepEqual(empty, [5, 6, 7, 8, 9, 10],
      'rows with only the J default and the N balance formula are free; row 4 stays protected');

    const schema = plain(gas.call('validateDestinationSchema', [customer, index]));
    assert.equal(schema.ok, true, JSON.stringify(schema.problems));
  });

  test('excluding a system-owned column is refused as CUSTOMER_MASTER_INVALID', () => {
    setup();
    assert.throws(() => gas.call('registerTestCustomer', [
      Object.assign({}, CUSTOMER, {rowScanExcludedColumns: [10, 13]})  // 13 = M(貸方)
    ]), (error) => error && /CUSTOMER_MASTER_INVALID|excluded/i.test(String(error.message || error.code)),
      'excluding a column the system writes would let a used row look empty');
  });

  test('the pilot loop closes: dictionary import, bulk adoption, file completion', () => {
    setup();
    gas.call('registerTestCustomer', [CUSTOMER]);
    gas.call('installSmbcCsvFormat', []);
    // 顧客側の取引先一覧タブ（A=元表記・B=freee取引先名。1行目は見出し）
    const partnerRows = [
      ['元表記', '取引先名'],
      ['ローソン', '株式会社ローソン'],
      ['ソフトバンクＭ（１２月分）', 'ソフトバンクM'],
      ['アイマイ商店', '取引先A'],
      ['ｱｲﾏｲ商店', '取引先A'],           // 正規化（NFKC）で同一・同一取引先 → 1件に畳む
      ['マギラワシ屋', '取引先B'],
      ['ﾏｷﾞﾗﾜｼ屋', '取引先C']            // 正規化が衝突し取引先が違う → 競合
    ];
    gas.stubs.getSpreadsheet('dest1').getSheetByName('取引先一覧')
      .getRange(1, 1, partnerRows.length, 2).setValues(partnerRows);

    const csv = '〇〇　〇〇　様,4980-00**-****-****,三井住友ゴールドＶＩＳＡ（ＮＬ）,,,,\n' +
      '2025/12/16,ローソン,10800,1,1,10800,仕入れ\n' +
      '2025/12/17,マギラワシ屋,500,1,1,500,仕入れ\n';
    gas.stubs.createFile('csv1', {name: '三井住友カード202601.csv',
      bytes: Buffer.from(csv, 'utf8'), lastUpdated: new Date(Date.now() - 3600 * 1000),
      createdTime: '2026-08-01T00:00:00Z'});
    gas.stubs.createFolder('folder1', {fileIds: ['csv1']});

    const run = plain(gas.call('runImport', [{}]));
    assert.equal(run.customers[0].files[0].nextState, 'REVIEW_WAIT');

    // 辞書取込：正規化重複の同名は畳まれ、競合はフラグ付きで入る。冪等。
    const imported = plain(gas.call('opsImportPartnerListToDictionary', []))[0];
    assert.equal(imported.imported, 5, JSON.stringify(imported));
    assert.equal(imported.conflictedEntries, 2);
    const again = plain(gas.call('opsImportPartnerListToDictionary', []))[0];
    assert.equal(again.imported, 0, 'the import must be idempotent');

    // 一括採用：一意に確定するローソンだけ採用。競合の店は人に残す。
    const adopted = plain(gas.call('opsAutoAdoptPartners', []));
    assert.equal(adopted.adopted, 1, JSON.stringify(adopted.results));
    assert.equal(adopted.skipped, 1);
    assert.equal(adopted.errors, 0);
    assert.deepEqual(adopted.completedFiles, [],
      'a file with an unresolved review must not complete');

    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    assert.equal(sheet.getRange(5, 6).getValue(), '株式会社ローソン',
      'the adopted partner lands in F');
    const lawsonTxId = String(sheet.getRange(5, 16).getValue());
    assert.equal(gas.call('getTransaction', [lawsonTxId]).transactionStatus, 'COMMITTED');

    // 残りを人が解決したらファイルは完了する：競合の1件を取引先なしで確定
    const remaining = plain(gas.call('openReviews', [{}]))
      .filter((r) => r.reviewType === 'PARTNER');
    assert.equal(remaining.length, 1);
    gas.call('resolveReview', [remaining[0].reviewId, 'RESOLVE_WITHOUT_PARTNER', {}]);
    const second = plain(gas.call('opsAutoAdoptPartners', []));
    assert.deepEqual(second.completedFiles, ['csv1'],
      'once every review is settled the file completes (INV-17)');
    assert.equal(gas.stubs.getFile('csv1').getName(), '【済】三井住友カード202601.csv');
  });

  test('an import lands on row 5 and leaves the template J/N cells intact', () => {
    setup();
    gas.call('registerTestCustomer', [CUSTOMER]);
    gas.call('installSmbcCsvFormat', []);
    const csv = '〇〇　〇〇　様,4980-00**-****-****,三井住友ゴールドＶＩＳＡ（ＮＬ）,,,,\n' +
      '2025/12/16,ローソン,10800,1,1,10800,仕入れ\n' +
      ',,,,,10800,\n';
    gas.stubs.createFile('csv1', {name: '三井住友カード202601.csv',
      bytes: Buffer.from(csv, 'utf8'), lastUpdated: new Date(Date.now() - 3600 * 1000),
      createdTime: '2026-08-01T00:00:00Z'});
    gas.stubs.createFolder('folder1', {fileIds: ['csv1']});

    const report = plain(gas.call('runImport', [{}]));
    const fileReport = report.customers[0].files[0];
    assert.equal(fileReport.outcome, 'WRITTEN', JSON.stringify(fileReport));

    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    const b5 = sheet.getRange(5, 2).getValue();
    const dateText = b5 instanceof Date ?
      b5.toLocaleDateString('sv-SE', {timeZone: 'Asia/Tokyo'}) : b5;
    assert.equal(dateText, '2025-12-16', 'the first data row is row 5, not the divider row 4');
    assert.equal(sheet.getRange(5, 13).getValue(), 10800, 'the amount goes to M (貸方)');
    assert.equal(sheet.getRange(4, 2).getValue(), '', 'the divider row is untouched');
    assert.equal(sheet.getRange(5, 10).getValue(), '税込', 'the J default survives the write');
    assert.equal(sheet.formulas[4][13].charAt(0), '=', 'the N balance formula survives');
  });
};

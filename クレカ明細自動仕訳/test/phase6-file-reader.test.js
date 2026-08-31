'use strict';

/**
 * 4.10 readFile / checkInputLimits / convertXlsxToTemp / disposeTemp。
 *
 * 要点は2つ：一時変換ファイルが**例外経路を含め**必ず消えること、
 * そして物理行番号の対応（CSV=recordStarts、XLSX=インデックス+1）が
 * 崩れないこと（INV-12）。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const utf8 = (text) => Array.from(Buffer.from(text, 'utf8'));

  test('4.10: a UTF-8 CSV with BOM reads with the BOM removed and rows intact', () => {
    gas.stubs.reset();
    const csv = '﻿利用日,利用店名,金額\n2025/12/16,ローソン,10800\n';
    gas.stubs.createFile('f1', {name: '202512.csv', bytes: Buffer.from(csv, 'utf8')});
    const result = plain(gas.call('readFile', ['f1', '202512.csv', {}]));
    assert.equal(result.fileType, 'csv');
    assert.equal(result.encoding, 'UTF-8');
    assert.equal(result.bomRemoved, true, 'BOM must be stripped before decoding (INV in 4.10)');
    assert.equal(result.sheets.length, 1);
    assert.deepEqual(result.sheets[0].rows[0], ['利用日', '利用店名', '金額'],
      'the first cell must not carry a BOM');
    assert.deepEqual(result.sheets[0].recordStarts, [1, 2]);
  });

  test('INV-12: quoted newlines keep physical row numbers through readFile', () => {
    gas.stubs.reset();
    const csv = 'A,B\n"複数行の\n備考",100\n次の行,200\n';
    gas.stubs.createFile('f2', {name: 'a.csv', bytes: Buffer.from(csv, 'utf8')});
    const result = plain(gas.call('readFile', ['f2', 'a.csv', {}]));
    assert.deepEqual(result.sheets[0].recordStarts, [1, 2, 4],
      'the record after a quoted newline starts at physical row 4');
  });

  test('4.10: an XLSX reads every sheet and always removes its temp conversion', () => {
    gas.stubs.reset();
    gas.stubs.createFile('x1', {name: '202512.xlsx', bytes: Buffer.from('xlsxbytes'), xlsxSheets: [
      {name: '明細', values: [['利用日', '金額'], ['2025/12/16', 10800]], maxRows: 2, maxColumns: 2},
      {name: '注記', values: [['メモ']], maxRows: 1, maxColumns: 1}
    ]});
    const before = gas.stubs.getSpreadsheetIds().length;
    const result = plain(gas.call('readFile', ['x1', '202512.xlsx', {}]));
    assert.equal(result.fileType, 'xlsx');
    assert.equal(result.sheets.length, 2);
    assert.equal(result.sheets[0].name, '明細');
    assert.deepEqual(result.sheets[0].rows[1], ['2025/12/16', 10800]);
    assert.equal(result.sheets[0].recordStarts, null, 'XLSX rows map to physical rows 1:1');
    assert.equal(gas.stubs.getSpreadsheetIds().length, before,
      'the temp spreadsheet must be deleted after reading');
  });

  test('4.10: the temp conversion is deleted even when a limit check throws', () => {
    gas.stubs.reset();
    gas.stubs.createFile('x2', {name: 'big.xlsx', bytes: Buffer.from('x'), xlsxSheets: [
      {name: 'S1', values: [['a']]}, {name: 'S2', values: [['a']]}, {name: 'S3', values: [['a']]}
    ]});
    gas.evaluate('SETTINGS.MAX_SHEETS_PER_FILE = 2');
    const before = gas.stubs.getSpreadsheetIds().length;
    assert.throws(() => gas.call('readFile', ['x2', 'big.xlsx', {}]),
      (error) => error && error.code === 'INPUT_LIMIT_EXCEEDED');
    assert.equal(gas.stubs.getSpreadsheetIds().length, before,
      'the exception path must still dispose the temp file');
  });

  test('23.3: limits fire on byte size, and on reaching the row cap', () => {
    gas.stubs.reset();
    gas.evaluate('SETTINGS.MAX_FILE_BYTES = 4');
    gas.stubs.createFile('f3', {name: 'a.csv', bytes: Buffer.from('12345', 'utf8')});
    assert.throws(() => gas.call('readFile', ['f3', 'a.csv', {}]),
      (error) => error && error.code === 'INPUT_LIMIT_EXCEEDED');

    gas.stubs.reset();
    gas.evaluate('SETTINGS.MAX_ROWS_PER_FILE = 3');
    gas.stubs.createFile('f4', {name: 'b.csv', bytes: Buffer.from('a\nb\nc\n', 'utf8')});
    assert.throws(() => gas.call('readFile', ['f4', 'b.csv', {}]),
      (error) => error && error.code === 'INPUT_LIMIT_EXCEEDED',
      'reaching MAX_ROWS_PER_FILE means later rows may be unread (5.3 condition 3)');
  });

  test('4.10: unsupported extensions are refused up front', () => {
    gas.stubs.reset();
    gas.stubs.createFile('f5', {name: 'a.pdf', bytes: Buffer.from('x')});
    assert.throws(() => gas.call('readFile', ['f5', 'a.pdf', {}]),
      (error) => error && error.name === 'TypeError' && /csv/.test(String(error.message)));
  });

  test('readFile returns the original bytes for hashing (BOM included)', () => {
    gas.stubs.reset();
    const csv = '﻿A,B\n1,2\n';
    const raw = Buffer.from(csv, 'utf8');
    gas.stubs.createFile('f6', {name: 'a.csv', bytes: raw});
    const result = plain(gas.call('readFile', ['f6', 'a.csv', {}]));
    assert.equal(result.bytes.length, raw.length,
      'the binary hash input is the Drive byte stream itself, BOM included');
  });
};

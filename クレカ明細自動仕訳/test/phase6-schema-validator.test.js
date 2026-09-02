'use strict';

/**
 * 4.22 転記先構成検証。
 *
 * 要点：不合格＝書込全面停止なので、停止条件は具体的に限定される。
 * 保護の**不在**は警告止まり、停止するのは「実行者を除外する保護」だけ
 * （INV-22）。AF列の必要数式が未定義の顧客は止めない（仕様3原則6）。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const blank = (n) => Array(n).fill('');
  const sheetHeader = (n, label) => { const r = blank(n); r[0] = label; return r; };

  const AE = JSON.stringify({row: 1, cells: [
    {column: 2, text: '利用日', match: 'exact'},
    {column: 3, text: '取引先', match: 'contains'}
  ]});

  function customerRow(overrides) {
    const row = blank(37);
    Object.assign(row, {
      0: 'C001', 1: '顧客A', 2: 'TRUE', 3: 'folder1', 5: 'dest1', 7: '入力用シート', 8: '取引先一覧',
      9: 2, 10: 3, 11: 4, 12: 5, 13: 6, 14: 7, 15: '1.0',
      16: 'reviewer@example.com', 17: 'admin@example.com', 18: 0, 20: 'システム情報', 21: '',
      23: 0, 24: 0, 29: 1, 30: AE, 31: '{}', 32: '{}', 33: 8,
      34: '取引先一覧', 35: 'CORPORATE', 36: ''
    }, overrides || {});
    return row;
  }

  function setup(customerOverrides, destRows) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [sheetHeader(37, '顧客ID'), customerRow(customerOverrides)]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    const header = ['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID', ''];
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート', values: [header].concat(destRows || []), maxRows: 20, maxColumns: 8}
    ]});
    const customer = gas.call('getCustomerById', ['C001']);
    const index = gas.call('buildIndex', [customer, {}]);
    return {customer, index};
  }

  test('4.22: a conforming destination passes all eight items', () => {
    const {customer, index} = setup();
    const result = plain(gas.call('validateDestinationSchema', [customer, index]));
    assert.deepEqual(result.problems, [], JSON.stringify(result.problems));
    assert.equal(result.ok, true);
  });

  test('4.22.1(1): a header cell mismatch stops the write', () => {
    const {customer, index} = setup();
    gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート').getRange(1, 2).setValue('日付');
    const rebuilt = gas.call('buildIndex', [customer, {}]);
    const result = plain(gas.call('validateDestinationSchema', [customer, rebuilt]));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DESTINATION_SCHEMA_MISMATCH');
    assert.ok(result.problems.some((p) => p.code === 'HEADER_CELL_MISMATCH'));
  });

  test('4.22.1(1): a destination without stored header expectations is refused', () => {
    const {customer, index} = setup({30: '{}'});
    const result = plain(gas.call('validateDestinationSchema', [customer, index]));
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.code === 'HEADER_EXPECTATION_MISSING'),
      'writing to a destination with no saved expectation must not proceed');
  });

  test('4.22.1(2): required formulas check sampled data rows, and empty sheets pass', () => {
    const AF = JSON.stringify({formulas: [{column: 5, requiredPrefix: '=', minPresentRatio: 1}]});
    // データ行が1行あり、必要数式が無い → 不合格
    const withData = setup({31: AF}, [['', '2025/12/01', '店', '', 100, '', 'TX1', '']]);
    const bad = plain(gas.call('validateDestinationSchema', [withData.customer, withData.index]));
    assert.ok(bad.problems.some((p) => p.code === 'REQUIRED_FORMULA_MISSING'));

    // 数式があれば合格
    gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート').getRange(2, 5).setFormula('=B2*1');
    const rebuilt = gas.call('buildIndex', [withData.customer, {}]);
    const good = plain(gas.call('validateDestinationSchema', [withData.customer, rebuilt]));
    assert.equal(good.ok, true, JSON.stringify(good.problems));

    // データ行が無ければ、定義があっても合格（新規の空シートを止めない）
    const emptySheet = setup({31: AF});
    const empty = plain(gas.call('validateDestinationSchema', [emptySheet.customer, emptySheet.index]));
    assert.equal(empty.ok, true);
  });

  test('INV-22: absent protection warns; executor-excluding protection stops', () => {
    const AG = JSON.stringify({ranges: [{columns: [7], mustExist: true, mustBeWarningOnly: true}]});

    const absent = setup({32: AG});
    const warned = plain(gas.call('validateDestinationSchema', [absent.customer, absent.index]));
    assert.equal(warned.ok, true, 'missing protection must not stop the customer');
    assert.ok(warned.warnings.some((w) => w.code === 'PROTECTION_MISSING'));

    const excluded = setup({32: AG});
    gas.stubs.addProtection('dest1', '入力用シート', {startColumn: 7, warningOnly: false, canEdit: false});
    const stopped = plain(gas.call('validateDestinationSchema', [excluded.customer, excluded.index]));
    assert.equal(stopped.ok, false);
    assert.ok(stopped.problems.some((p) => p.code === 'PROTECTION_EXCLUDES_EXECUTOR'));

    const warningOnly = setup({32: AG});
    gas.stubs.addProtection('dest1', '入力用シート', {startColumn: 7, warningOnly: true, canEdit: false});
    const passed = plain(gas.call('validateDestinationSchema', [warningOnly.customer, warningOnly.index]));
    assert.equal(passed.ok, true, 'warning-only protection is the expected steady state');
  });

  test('INV-27: a header extending beyond the row-scan last column fails item 8', () => {
    // 顧客マスター検証は AH < 取引ID列 を既に拒否するため、項目8が実際に
    // 捕まえるのは「AHより右に実ヘッダーが伸びている」構成である。
    const {customer} = setup();
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    sheet.getRange(1, 9).setValue('AHの右の実ヘッダー列');
    const index = gas.call('buildIndex', [customer, {}]);
    const result = plain(gas.call('validateDestinationSchema', [customer, index]));
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.code === 'ROW_SCAN_LAST_COLUMN_TOO_SMALL'),
      'a header column the empty-row scan cannot see leads to overwriting used rows');
  });

  test('7: a schema version mismatch fails item 7', () => {
    const {customer, index} = setup({15: '0.9'});
    const result = plain(gas.call('validateDestinationSchema', [customer, index]));
    assert.ok(result.problems.some((p) => p.code === 'SCHEMA_VERSION_MISMATCH'));
  });

  test('7: sheet numeric coercion of the version cell is not a mismatch', () => {
    // 実機のセルは「1.0」を数値1として保存する。読み返しは「1」になるが、
    // これは構成の不一致ではない。
    const {customer, index} = setup({15: 1});
    const result = plain(gas.call('validateDestinationSchema', [customer, index]));
    assert.equal(result.problems.some((p) => p.code === 'SCHEMA_VERSION_MISMATCH'), false,
      JSON.stringify(result.problems));
  });

  test('M30: a non-empty template source row is refused before expansion', () => {
    const {customer, index} = setup(null, [['', '2025/12/01', '店', '', 100, '', 'TX1', '']]);
    const bad = plain(gas.call('validateTemplateSourceRow', [customer, 2, index]));
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'DESTINATION_TEMPLATE_ROW_NOT_EMPTY');

    const good = plain(gas.call('validateTemplateSourceRow', [customer, 3, index]));
    assert.equal(good.ok, true);
  });
};

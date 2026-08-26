'use strict';

/**
 * 4.20 取引ID（INV-11・INV-13・INV-23・INV-26）。
 *
 * 取引IDが決定的でないと、再合流や回復のたびに同じ明細が別取引になり、
 * 顧客のfreee出納帳へ二重に転記される。ここが崩れると下流の
 * 重複検査・回復・再走査がすべて意味を失う。
 */
module.exports = ({test, assert, gas}) => {
  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: []});
    gas.stubs.setActiveSpreadsheet('master');
  }

  const base = (overrides = {}) => Object.assign({
    customerId: 'C001', fileId: 'file1', sourceSheetName: '', sourceRow: 12, generation: 0
  }, overrides);

  // ---- INV-26：同一の生成要素からは常に同一の完全値 ----
  test('INV-26: the same generating elements always produce the same id', () => {
    setup();
    const first = gas.call('generateTransactionId', [base()]);
    const second = gas.call('generateTransactionId', [base()]);
    assert.equal(first.full, second.full);
    assert.ok(/^TX_[0-9a-f]{64}$/.test(first.full),
      `expected a TX_-prefixed lowercase sha256, got ${first.full}`);
  });

  // ---- 5要素それぞれが値に効く ----
  const elements = [
    ['顧客ID', {customerId: 'C002'}],
    ['ファイルID', {fileId: 'file2'}],
    ['シート名', {sourceSheetName: 'Sheet1'}],
    ['行番号', {sourceRow: 13}],
    ['再取込世代番号', {generation: 1}]
  ];
  elements.forEach(([label, override]) => {
    test(`4.20: changing ${label} changes the transaction id`, () => {
      setup();
      assert.notEqual(
        gas.call('generateTransactionId', [base()]).full,
        gas.call('generateTransactionId', [base(override)]).full,
        `${label} must take part in the id`);
    });
  });

  // ---- 空文字列と null を区別する（5.6.1 ケースB） ----
  //
  // CSVはシート名が空文字列である。未指定の `null` と同じ扱いにすると、
  // CSVとXLSXの同じ行が同じIDになる。
  test('4.20: an omitted sheet name is treated as the empty string, as CSV requires', () => {
    setup();
    assert.equal(
      gas.call('generateTransactionId', [base({sourceSheetName: null})]).full,
      gas.call('generateTransactionId', [base({sourceSheetName: ''})]).full);
  });

  // ---- INV-23：別取引としての採用は世代番号で導出する ----
  test('INV-23: adopting a row as a new transaction is derived, never invented', () => {
    setup();
    const original = gas.call('generateTransactionId', [base({generation: 0})]);
    const adopted = gas.call('generateTransactionId', [base({generation: 1})]);
    assert.notEqual(original.full, adopted.full);

    // 決定的であること。同じ世代を再導出すれば同じ値に戻る。
    assert.equal(gas.call('generateTransactionId', [base({generation: 1})]).full, adopted.full,
      'the adopted id must be re-derivable, or recovery cannot find its row');
  });

  // ---- INV-11：表示IDは表示専用 ----
  test('INV-11: the display id is a prefix of the full value and is display-only', () => {
    setup();
    const id = gas.call('generateTransactionId', [base()]);
    assert.equal(id.display.length, 12);
    assert.equal(id.full.slice(0, 12), id.display);
    assert.equal(id.version, '2');
  });

  test('4.20: display id collisions are reported, not silently accepted', () => {
    setup();
    const pairs = [
      {full: 'TX_aaaa1111', display: 'TX_aaaa'},
      {full: 'TX_aaaa2222', display: 'TX_aaaa'},   // 表示は同じ、完全値は違う
      {full: 'TX_bbbb3333', display: 'TX_bbbb'}
    ];
    const collisions = JSON.parse(JSON.stringify(
      gas.call('detectDisplayIdCollision', [{customerId: 'C001'}, pairs])));
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].display, 'TX_aaaa');

    // 同じ完全値が2回現れるのは衝突ではない
    assert.equal(gas.call('detectDisplayIdCollision', [{customerId: 'C001'}, [
      {full: 'TX_aaaa1111', display: 'TX_aaaa'},
      {full: 'TX_aaaa1111', display: 'TX_aaaa'}
    ]]).length, 0);
  });

  // ---- 入力の不備を黙って受け入れない ----
  test('4.20: an unusable source row is rejected rather than hashed as-is', () => {
    setup();
    [{sourceRow: 0}, {sourceRow: -1}, {sourceRow: 1.5}, {sourceRow: undefined}]
      .forEach((override) => {
        assert.throws(() => gas.call('generateTransactionId', [base(override)]),
          (error) => error && /source row/.test(String(error.message)),
          `sourceRow=${override.sourceRow} must be rejected`);
      });
    assert.throws(() => gas.call('generateTransactionId', [base({generation: -1})]),
      (error) => error && /generation/.test(String(error.message)));
  });
};

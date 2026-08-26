'use strict';

/**
 * 4.12.7 匿名化 `ANONYMIZE_V1`（仕様20.4・INV-36）。
 *
 * 2つの失敗を同時に防がなければならない。
 *   除去し損ね：顧客を識別し得る情報がコーパスへ入る。共有された後では
 *               気づいても遅い（CR-1 が指摘した状態）
 *   除去しすぎ：抽出・除外・年補完の挙動が実ファイルと変わり、そのサンプルで
 *               回帰を取る意味が失われる（規則3）
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: []});
    gas.stubs.setActiveSpreadsheet('master');
  }

  const cell = (value, context) => gas.call('anonymizeCell', [value, context || {}]);

  // ================= 規則1：カード番号 =================

  test('rule 1: a 16-digit card number is replaced digit for digit', () => {
    setup();
    assert.equal(cell('1234567890123456'), '0000000000000000');
    assert.equal(cell('1234-5678-9012-3456'), '0000-0000-0000-0000',
      'separators are kept so the column width does not change');
  });

  test('rule 1: shorter digit runs are left alone outside member-id columns', () => {
    setup();
    assert.equal(cell('12345'), '12345', 'an amount or a code must survive');
    assert.equal(cell('2026/01/05'), '2026/01/05', 'a date must survive intact');
    assert.equal(cell('1200'), '1200');
  });

  // ================= CR-1：規則1bが捕捉する短い会員番号 =================

  test('CR-1 rule 1b: a short member number is masked in a member-id column', () => {
    setup();
    const context = {column: 2, memberIdColumns: {2: true}};
    assert.equal(cell('12345678', context), '00000000',
      'an 8-digit member number is not caught by rule 1 - it would reach the corpus');
    assert.equal(cell('12345678', {column: 3, memberIdColumns: {2: true}}), '12345678',
      'the same digits in an ordinary column are not a member number');
  });

  test('CR-1 rule 1b: the member-id columns come from the header words', () => {
    setup();
    const columns = plain(gas.call('classifyAnonymizeColumns',
      [['利用日', '会員番号', '利用店名', 'お客様ID', '利用金額']]));
    assert.deepEqual(Object.keys(columns.memberIdColumns).sort(), ['2', '4']);
  });

  // ================= CR-1：規則1c・1d =================

  test('CR-1 rule 1c: an email address is masked while keeping its shape', () => {
    setup();
    // `@` と `.` は残す。形が保たれていれば、その列をメールの列と判定する
    // 形式定義があっても挙動が変わらない。
    assert.equal(cell('taro.yamada@example.co.jp'), 'xxxx.xxxxxx@xxxxxxx.xx.xx');
    assert.equal(cell('お問合せ info@shop.jp まで'), 'お問合せ xxxx@xxxx.xx まで',
      'an address inside a longer cell must still be caught');
  });

  test('CR-1 rule 1d: a phone number is masked in any column', () => {
    setup();
    assert.equal(cell('03-1234-5678'), '00-0000-0000');
    assert.equal(cell('090-1234-5678'), '000-0000-0000');
    assert.equal(cell('0570-000-123'), '0000-000-000',
      'a merchant name column can hold a phone number too');
  });

  test('CR-1 rule 1d: a number that is not a phone number is left alone', () => {
    setup();
    assert.equal(cell('01-234'), '01-234', 'too short to be a phone number');
  });

  // ================= 規則2：氏名列 =================

  test('rule 2: a name column is blanked rather than digit-masked', () => {
    setup();
    assert.equal(cell('山田 太郎', {column: 2, nameColumns: {2: true}}), '');
  });

  test('rule 2: the name words are matched by containment, not equality', () => {
    setup();
    const columns = plain(gas.call('classifyAnonymizeColumns',
      [['利用日', 'カード会員氏名', '利用店名', 'ご契約者名義', '利用金額']]));
    assert.deepEqual(Object.keys(columns.nameColumns).sort(), ['2', '4']);
  });

  test('rule 2: a column matching both name and member words is blanked', () => {
    setup();
    // 「カード会員氏名」は会員も氏名も含む。空欄化のほうが強い除去である。
    const columns = plain(gas.call('classifyAnonymizeColumns', [['カード会員氏名']]));
    assert.equal(columns.nameColumns[1], true);
    assert.equal(columns.memberIdColumns[1], undefined);
  });

  // ================= 規則2b：操作者の追加指定 =================

  test('rule 2b: an operator mask overrides the machine rules', () => {
    setup();
    assert.equal(cell('何らかの値', {column: 5, extraMasks: {5: 'BLANK'}}), '');
    assert.equal(cell('987654', {column: 5, extraMasks: {5: 'ZERO'}}), '000000');
  });

  // ================= 規則3：それ以外を変えない =================

  test('rule 3: dates, amounts, merchants and headers pass through untouched', () => {
    setup();
    const rows = [
      ['利用日', '利用店名', '利用金額', '使用用途'],
      ['2026/01/05', 'コンビニA', '1,200', '消耗品'],
      ['2026/01/08', 'ガソリンB', '5400', '車両費'],
      ['', 'お繰越残高', '48000', '']
    ];
    const result = plain(gas.call('anonymizeRows', [rows, {headerRows: [1]}]));

    assert.deepEqual(result.rows, rows,
      'nothing here identifies a customer - changing any of it breaks the regression');
    assert.equal(result.maskedCells, 0);
  });

  test('rule 3: numeric cells keep their type', () => {
    setup();
    assert.equal(cell(1200), 1200);
    assert.equal(typeof cell(1200), 'number',
      'stringifying a number would turn a numeric column into a text column');
  });

  test('rule 3: header rows are never modified', () => {
    setup();
    const rows = [
      ['利用日', '会員番号', '利用店名'],
      ['2026/01/05', '12345678', 'コンビニA']
    ];
    const result = plain(gas.call('anonymizeRows', [rows, {headerRows: [1]}]));
    assert.deepEqual(result.rows[0], rows[0],
      'the header is detection material - changing it changes format matching');
    assert.equal(result.rows[1][1], '00000000');
  });

  // ================= 表全体 =================

  test('4.12.7: a realistic statement is anonymised without losing its shape', () => {
    setup();
    const rows = [
      ['カード番号', '1234-5678-9012-3456'],
      ['カード会員氏名', '山田 太郎'],
      ['ご連絡先', '03-1234-5678'],
      ['利用日', '利用店名', '利用金額', '会員番号'],
      ['2026/01/05', 'コンビニA', '1200', '87654321'],
      ['2026/01/08', 'ガソリンB 0570-000-123', '5400', '87654321']
    ];
    const result = plain(gas.call('anonymizeRows', [rows, {headerRows: [4]}]));

    assert.equal(result.rows[0][1], '0000-0000-0000-0000');
    assert.equal(result.rows[2][1], '00-0000-0000');
    assert.equal(result.rows[4][3], '00000000', 'the member number column is masked');
    assert.equal(result.rows[5][1], 'ガソリンB 0000-000-000',
      'the merchant name is kept but the phone number inside it is not');

    // 明細の値そのものは変わらない
    assert.equal(result.rows[4][0], '2026/01/05');
    assert.equal(result.rows[4][2], '1200');
    assert.equal(result.version, '1');
  });

  // ================= 規則4：ファイル名 =================

  test('rule 4: the anonymised file keeps the original name as a suffix', () => {
    setup();
    assert.equal(gas.call('anonymizedFileName', ['SM_001', '明細_2026年1月締.csv']),
      'SM_001__明細_2026年1月締.csv');
  });

  test('rule 4: the detection file name gets the same masking as the cells', () => {
    setup();
    assert.equal(gas.call('detectionFileName', ['meisai_03-1234-5678.csv']),
      'meisai_00-0000-0000.csv',
      'the detection name is stored in the ledger in the clear');
    assert.equal(gas.call('detectionFileName', ['明細_2026年1月締.csv']),
      '明細_2026年1月締.csv',
      'an ordinary name must not be altered, or billing-month inference changes');
  });

  // ================= A-14：XLSXの構造検証 =================

  const extraction = (overrides = {}) => Object.assign({
    transactions: [
      {sourceRow: 5, occurrenceIndex: 0, dateHashKey: '2026-01-05',
       amountBillingJpy: 1200, purpose: '消耗品', merchant: 'コンビニA'},
      {sourceRow: 6, occurrenceIndex: 0, dateHashKey: '2026-01-08',
       amountBillingJpy: 5400, purpose: '車両費', merchant: 'ガソリンB'}
    ],
    excludedRows: [{rowNumber: 7, reason: '__EMPTY__'}],
    billingMonth: {status: 'RESOLVED', yearMonth: '2026-01'}
  }, overrides);

  test('A-14: an anonymisation that preserves the structure passes', () => {
    setup();
    const after = extraction();
    after.transactions = after.transactions.map((tx) =>
      Object.assign({}, tx, {merchant: ''}));   // 店名は規則2で空になり得る
    const result = plain(gas.call('verifyAnonymizedStructure', [extraction(), after]));
    assert.equal(result.ok, true,
      'the merchant name is deliberately excluded from the comparison');
  });

  test('A-14: a changed date is caught and the anonymisation is rejected', () => {
    setup();
    const after = extraction();
    after.transactions[0].dateHashKey = '2026-01-06';
    const result = plain(gas.call('verifyAnonymizedStructure', [extraction(), after]));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SAMPLE_ANONYMIZE_STRUCTURE_CHANGED');
    assert.equal(result.differences[0].item, 'dateHashKey');
  });

  test('A-14: a lost transaction is caught', () => {
    setup();
    const after = extraction();
    after.transactions.pop();
    const result = plain(gas.call('verifyAnonymizedStructure', [extraction(), after]));
    assert.equal(result.ok, false);
    assert.equal(result.differences[0].item, 'transactionCount');
  });

  test('A-14: a changed exclusion outcome is caught', () => {
    setup();
    const after = extraction({excludedRows: [{rowNumber: 7, reason: '__ROW_RANGE__'}]});
    assert.equal(plain(gas.call('verifyAnonymizedStructure', [extraction(), after])).ok, false);
  });

  test('A-14: a changed billing month is caught', () => {
    setup();
    const after = extraction({billingMonth: {status: 'NOT_FOUND', yearMonth: null}});
    assert.equal(plain(gas.call('verifyAnonymizedStructure', [extraction(), after])).ok, false);
  });
};

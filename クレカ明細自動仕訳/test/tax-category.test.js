'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * 相手税区分（G 列）の第 1 段（`work/spec_tax_category.md` §13 の gt 1・
 * gt 2・gt 3・gt 14）。
 *
 * 値はすべて架空である（顧客 `K9001`・`K9002`、取引先 `架空フリマ` など）。
 * freee の税区分名・一般の言葉は規則そのものなので使う。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const call = (name, args = []) => gas.call(name, args);
  const evaluate = (expression) => gas.evaluate(expression);

  const MARK_HEADERS = ['取引先名', '印', '顧客ID', '有効', '登録日時', '登録者', 'メモ'];
  const FLAG_HEADERS = ['顧客ID', '少額特例を使えない', '更新日時', '更新者', 'メモ'];

  const CUSTOMER = {customerId: 'K9001'};
  const UNUSABLE_CUSTOMER = {customerId: 'K9002'};

  function markRow(name, mark, customerId, active) {
    return [name, mark, customerId === undefined ? '' : customerId,
      active === undefined ? '' : active, '', '', ''];
  }

  function flagRow(customerId, unusable) {
    return [customerId, unusable === undefined ? '' : unusable, '', '', ''];
  }

  function tableValues(headers, rows) {
    return [headers.slice()].concat(rows);
  }

  function defaultMarkRows() {
    return [
      markRow('架空フリマ', 'フリマ'),
      markRow('架空海外ストア', '海外の物'),
      markRow('架空サービス', '海外のサービス')
    ];
  }

  function defaultFlagRows() {
    return [flagRow('K9002', true)];
  }

  function tables(markRows, flagRows) {
    return call('taxTablesFromValues_', [
      tableValues(MARK_HEADERS, markRows === undefined ? defaultMarkRows() : markRows),
      tableValues(FLAG_HEADERS, flagRows === undefined ? defaultFlagRows() : flagRows)
    ]);
  }

  function input(overrides) {
    return Object.assign({
      customer: CUSTOMER, accountCode: 712, purpose: '仕入', date: '2026-11-01',
      amount: 3000, partnerName: '架空店舗', cashback: false
    }, overrides || {});
  }

  function resolve(overrides, table) {
    // 引数を省いたときだけ既定の表を使う（`undefined` を渡したときは
    // そのまま渡す ── 表が無いときの確かめのため）。
    const target = arguments.length < 2 ? tables() : table;
    return plain(call('resolveTaxCategory_', [input(overrides), target]));
  }

  function decided(name) {
    return {status: 'DECIDED', name: name, reason: null};
  }

  function undecided(reason) {
    return {status: 'UNDECIDED', name: null, reason: reason};
  }

  // ---------------- gt 1: 表の形 ----------------

  test('gt 1: 科目の表（37 行・コードは重ならず種にあり・例外は課対仕入だけ）', () => {
    const rules = plain(evaluate('TAX_ACCOUNT_RULES_'));
    const seeds = plain(evaluate('ACCOUNT_SEED_ACCOUNTS_'));
    assert.equal(rules.length, 37);
    const codes = rules.map((rule) => rule.code);
    assert.equal(new Set(codes).size, codes.length, 'コードが重ならない');
    assert.equal(codes.indexOf(612), -1, '売上高は表に入れない');
    assert.equal(codes.indexOf(914), -1, '雑収入は表に入れない');
    for (const rule of rules) {
      assert.equal(Number.isInteger(rule.code), true, 'コードは整数');
      assert.ok(['課対仕入', '非課仕入', '対象外'].includes(rule.kind),
        '種類 ' + rule.code);
      assert.equal(typeof rule.exceptions, 'boolean', '例外は真偽 ' + rule.code);
      assert.equal(rule.exceptions, rule.kind === '課対仕入',
        '例外を当てるのは課対仕入だけ ' + rule.code);
      const seed = seeds.filter((row) => row.code === rule.code);
      assert.equal(seed.length, 1, '種にある ' + rule.code);
    }
    const frozenRules = evaluate('TAX_ACCOUNT_RULES_');
    assert.equal(Object.isFrozen(frozenRules), true);
    Array.prototype.forEach.call(frozenRules, (rule) => {
      assert.equal(Object.isFrozen(rule), true, '行も凍結');
    });
  });

  test('gt 1: 率の期間は重ならず、率を組んだ名前はすべて freee の一覧にある', () => {
    const periods = plain(evaluate('TAX_RATE_PERIODS_'));
    const names = plain(evaluate('FREEE_TAX_CATEGORIES_')).map((category) => category.name);
    assert.equal(periods.length, 2);
    const standard = periods.filter((period) => period.rate === 'STANDARD');
    const reduced = periods.filter((period) => period.rate === 'REDUCED');
    assert.equal(standard.length, 1);
    assert.equal(reduced.length, 1);
    assert.deepEqual(standard[0],
      {rate: 'STANDARD', suffix: '10%', from: '2019-10-01', to: null});
    assert.deepEqual(reduced[0],
      {rate: 'REDUCED', suffix: '8%（軽）', from: '2019-10-01', to: '2027-03-31'});
    for (const rate of ['STANDARD', 'REDUCED']) {
      const rows = periods.filter((period) => period.rate === rate)
        .slice().sort((a, b) => a.from.localeCompare(b.from));
      for (let index = 1; index < rows.length; index += 1) {
        const previousEnd = rows[index - 1].to || '9999-12-31';
        assert.ok(previousEnd < rows[index].from, '同じ率の期間が重ならない ' + rate);
      }
    }
    for (const period of periods) {
      assert.ok(names.includes('課対仕入' + period.suffix), '課対仕入' + period.suffix);
      for (const control of ['80', '70', '50', '30']) {
        const name = '課対仕入（控' + control + '）' + period.suffix;
        assert.ok(names.includes(name), name);
      }
    }
    assert.ok(names.includes('対象外'));
    assert.ok(names.includes('非課仕入'));
    assert.ok(names.includes('課対輸本'));
  });

  test('gt 1: 言葉の表と少額特例・印の 4 つの値・見出し', () => {
    assert.deepEqual(plain(evaluate('TAX_REDUCED_WORDS_')),
      ['食品', '食材', '食料品', '食料', 'サプリ']);
    assert.deepEqual(plain(evaluate('TAX_REDUCED_EXCLUDE_WORDS_')),
      ['酒', 'アルコール', 'ビール', 'ワイン', '外食', 'イートイン']);
    assert.deepEqual(plain(evaluate('TAX_UNDECIDED_WORDS_')), ['消費税', 'リボ', '分割']);
    assert.deepEqual(plain(evaluate('TAX_SMALL_AMOUNT_')),
      {from: '2023-10-01', to: '2029-09-30', limit: 10000});
    assert.deepEqual(plain(evaluate('TAX_MARK_VALUES_')),
      ['フリマ', '海外の物', '海外のサービス', 'なし']);
    assert.deepEqual(plain(evaluate('TAX_PARTNER_MARKS_HEADERS_')), MARK_HEADERS);
    assert.deepEqual(plain(evaluate('TAX_CUSTOMER_FLAGS_HEADERS_')), FLAG_HEADERS);
    ['TAX_RATE_PERIODS_', 'TAX_REDUCED_WORDS_', 'TAX_REDUCED_EXCLUDE_WORDS_',
      'TAX_UNDECIDED_WORDS_', 'TAX_SMALL_AMOUNT_', 'TAX_MARK_VALUES_',
      'TAX_PARTNER_MARKS_HEADERS_', 'TAX_CUSTOMER_FLAGS_HEADERS_'
    ].forEach((name) => {
      assert.equal(Object.isFrozen(evaluate(name)), true, name + ' は凍結');
    });
    const periods = evaluate('TAX_RATE_PERIODS_');
    Array.prototype.forEach.call(periods, (period) => {
      assert.equal(Object.isFrozen(period), true, '率の行も凍結');
    });
  });

  // ---------------- gt 2: 決め方 ----------------

  test('gt 2: §5.1 の例（21 行）', () => {
    const rows = [
      {label: '852 消耗品 なし', input: {accountCode: 852, purpose: '消耗品', amount: 3000},
        name: '課対仕入10%'},
      {label: '712 仕入 食品 なし', input: {accountCode: 712, purpose: '仕入 食品', amount: 3000},
        name: '課対仕入8%（軽）'},
      {label: '712 フリマ 9,999', input: {partnerName: '架空フリマ', amount: 9999},
        name: '課対仕入10%'},
      {label: '712 フリマ 10,000', input: {partnerName: '架空フリマ', amount: 10000},
        name: '課対仕入（控70）10%'},
      {label: '712 フリマ 3,000 使えない',
        input: {partnerName: '架空フリマ', amount: 3000, customer: UNUSABLE_CUSTOMER},
        name: '課対仕入（控70）10%'},
      {label: '712 フリマ 12,000 2026-09-30',
        input: {partnerName: '架空フリマ', amount: 12000, date: '2026-09-30'},
        name: '課対仕入（控80）10%'},
      {label: '712 仕入 食材 フリマ 12,000',
        input: {purpose: '仕入 食材', partnerName: '架空フリマ', amount: 12000},
        name: '課対仕入（控70）8%（軽）'},
      {label: '712 フリマ 3,000 2029-10-01',
        input: {partnerName: '架空フリマ', amount: 3000, date: '2029-10-01'},
        name: '課対仕入（控50）10%'},
      {label: '712 海外の物',
        input: {partnerName: '架空海外ストア', amount: 3000},
        name: '課対輸本'},
      {label: '843 海外のサービス 3,000',
        input: {accountCode: 843, purpose: 'ツール代', partnerName: '架空サービス', amount: 3000},
        name: '課対仕入10%'},
      {label: '843 海外のサービス 15,000',
        input: {accountCode: 843, purpose: 'ツール代', partnerName: '架空サービス', amount: 15000},
        name: '対象外'},
      {label: '294 私用 フリマ',
        input: {accountCode: 294, purpose: '私用', partnerName: '架空フリマ', amount: 3000},
        name: '対象外'},
      {label: '847 保険',
        input: {accountCode: 847, purpose: '保険', amount: 3000},
        name: '非課仕入'},
      {label: '712 フリマ 返品 -3,000',
        input: {partnerName: '架空フリマ', amount: -3000},
        name: '課対仕入10%'},
      {label: '859 年会費消費税',
        input: {accountCode: 859, purpose: '年会費消費税', amount: 110},
        reason: 'UNDECIDED_WORD'},
      {label: '866 家賃 フリマ',
        input: {accountCode: 866, purpose: '家賃', partnerName: '架空フリマ', amount: 50000},
        name: '課対仕入（控70）10%'},
      {label: '832 給料', input: {accountCode: 832, purpose: '給料', amount: 50000},
        name: '対象外'},
      {label: '836 社会保険', input: {accountCode: 836, purpose: '社会保険', amount: 50000},
        name: '非課仕入'},
      {label: '612 売上', input: {accountCode: 612, purpose: '売上', amount: 50000},
        reason: 'ACCOUNT_NOT_IN_TABLE'},
      {label: '科目なし', input: {accountCode: '', purpose: '謎語', amount: 3000},
        reason: 'NO_ACCOUNT'},
      {label: '利用日なし', input: {accountCode: 852, purpose: '消耗品', amount: 3000, date: ''},
        reason: 'DATE_INVALID'}
    ];
    rows.forEach((row) => {
      const result = resolve(row.input);
      if (row.name) {
        assert.deepEqual(result, decided(row.name), row.label);
      } else {
        assert.deepEqual(result, undecided(row.reason), row.label);
      }
    });
  });

  test('gt 2: §5.1 の括弧（2027-03-31 の軽減と、2027-04-01 の決めない）', () => {
    assert.deepEqual(resolve({purpose: '仕入 食品', date: '2027-03-31'}),
      decided('課対仕入8%（軽）'));
    assert.deepEqual(resolve({purpose: '仕入 食品', date: '2027-04-01'}),
      undecided('RATE_PERIOD_MISSING'));
  });

  test('gt 2: 顧客別の印が共通の印に勝つ（ほかの顧客は共通のまま）', () => {
    const marks = [
      markRow('架空フリマ', 'フリマ'),
      markRow('架空フリマ', '海外のサービス', 'K9001')
    ];
    const table = tables(marks, []);
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {partnerName: '架空フリマ', amount: 15000, customer: CUSTOMER}), table])),
    decided('対象外'));
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {partnerName: '架空フリマ', amount: 15000, customer: {customerId: 'K9002'}}), table])),
    decided('課対仕入（控70）10%'));
  });

  test('gt 2: 顧客別の「なし」で共通の「フリマ」を消せる', () => {
    const table = tables([
      markRow('架空フリマ', 'フリマ'),
      markRow('架空フリマ', 'なし', 'K9001')
    ], []);
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {partnerName: '架空フリマ', amount: 12000}), table])), decided('課対仕入10%'));
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {partnerName: '架空フリマ', amount: 12000, customer: {customerId: 'K9002'}}), table])),
    decided('課対仕入（控70）10%'));
  });

  test('gt 2: 有効 FALSE の印の行は当たらない', () => {
    const table = tables([markRow('架空フリマ', 'フリマ', '', false)], []);
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {partnerName: '架空フリマ', amount: 12000}), table])), decided('課対仕入10%'));
  });

  test('gt 2: 印の値が不正な行が候補にあれば、正しい行があっても MARK_INVALID', () => {
    const table = tables([
      markRow('架空フリマ', 'フリマ'),
      markRow('架空フリマ', '○')
    ], []);
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {partnerName: '架空フリマ', amount: 3000}), table])), undecided('MARK_INVALID'));
  });

  test('gt 2: 有効が読めない印の行が候補にあれば MARK_INVALID', () => {
    const table = tables([
      markRow('架空フリマ', 'フリマ'),
      markRow('架空フリマ', 'フリマ', '', '○')
    ], []);
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {partnerName: '架空フリマ', amount: 3000}), table])), undecided('MARK_INVALID'));
  });

  test('gt 2: 同じ鍵で印が 2 種類なら MARK_INVALID', () => {
    const table = tables([
      markRow('架空フリマ', 'フリマ'),
      markRow('架空フリマ', 'なし')
    ], []);
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {partnerName: '架空フリマ', amount: 3000}), table])), undecided('MARK_INVALID'));
  });

  test('gt 2: 顧客の設定が 2 行なら、フリマの行だけ CUSTOMER_FLAG_INVALID', () => {
    const table = tables(undefined, [flagRow('K9001', true), flagRow('K9001', false)]);
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {accountCode: 712, partnerName: '架空フリマ', amount: 3000}), table])),
    undecided('CUSTOMER_FLAG_INVALID'));
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {accountCode: 852, purpose: '消耗品', partnerName: '架空店舗', amount: 3000}), table])),
    decided('課対仕入10%'));
  });

  test('gt 2: 顧客の設定の値が不正なら、フリマの行だけ CUSTOMER_FLAG_INVALID', () => {
    const table = tables(undefined, [flagRow('K9001', '○')]);
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {accountCode: 712, partnerName: '架空フリマ', amount: 3000}), table])),
    undecided('CUSTOMER_FLAG_INVALID'));
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {accountCode: 852, purpose: '消耗品', partnerName: '架空店舗', amount: 3000}), table])),
    decided('課対仕入10%'));
  });

  test('gt 2: 顧客 ID が無いと、顧客の設定は CUSTOMER_FLAG_INVALID', () => {
    assert.deepEqual(resolve(
      {partnerName: '架空フリマ', amount: 3000, customer: null}),
    undecided('CUSTOMER_FLAG_INVALID'));
    assert.deepEqual(resolve(
      {partnerName: '架空フリマ', amount: 3000, customer: {customerId: '  '}}),
    undecided('CUSTOMER_FLAG_INVALID'));
    // 顧客 ID が無くても、印の無い行・海外の物は今までどおり決まる。
    assert.deepEqual(resolve(
      {accountCode: 852, purpose: '消耗品', amount: 3000, customer: null}),
    decided('課対仕入10%'));
    assert.deepEqual(resolve(
      {partnerName: '架空海外ストア', amount: 3000, customer: null}), decided('課対輸本'));
  });

  test('gt 2: 取引先名の鍵の揺れ（全角・半角・小さい字）で印が当たる', () => {
    const fullWidth = tables([markRow('ＡＢＣストア', 'フリマ')], []);
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {partnerName: 'ABCストア', amount: 12000}), fullWidth])),
    decided('課対仕入（控70）10%'));
    const smallKana = tables([markRow('きゃんぷ', 'フリマ')], []);
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {partnerName: 'キャンプ', amount: 12000}), smallKana])),
    decided('課対仕入（控70）10%'));
  });

  test('gt 2: 経過措置の境目（2026-09-30 ほか）', () => {
    const cases = [
      ['2026-09-30', '課対仕入（控80）10%'],
      ['2026-10-01', '課対仕入（控70）10%'],
      ['2028-09-30', '課対仕入（控70）10%'],
      ['2028-10-01', '課対仕入（控50）10%'],
      ['2031-09-30', '課対仕入（控30）10%']
    ];
    cases.forEach(([date, name]) => {
      assert.deepEqual(resolve(
        {partnerName: '架空フリマ', amount: 12000, date: date}), decided(name), date);
    });
    assert.deepEqual(resolve(
      {partnerName: '架空フリマ', amount: 12000, date: '2031-10-01'}),
    undecided('TRANSITION_PERIOD_MISSING'));
  });

  test('gt 2: 少額特例の境目（9,999・10,000・2029-09-30・2029-10-01）', () => {
    assert.deepEqual(resolve({partnerName: '架空フリマ', amount: 9999}),
      decided('課対仕入10%'));
    assert.deepEqual(resolve({partnerName: '架空フリマ', amount: 10000}),
      decided('課対仕入（控70）10%'));
    assert.deepEqual(resolve(
      {partnerName: '架空フリマ', amount: 9999, date: '2029-09-30'}),
    decided('課対仕入10%'));
    assert.deepEqual(resolve(
      {partnerName: '架空フリマ', amount: 9999, date: '2029-10-01'}),
    decided('課対仕入（控50）10%'));
    assert.deepEqual(resolve(
      {partnerName: '架空フリマ', amount: 9999, date: '2023-09-30'}),
    undecided('TRANSITION_PERIOD_MISSING'));
  });

  test('gt 2: 返品（マイナス）は絶対値で少額特例を見る', () => {
    assert.deepEqual(resolve({partnerName: '架空フリマ', amount: -3000}),
      decided('課対仕入10%'));
    assert.deepEqual(resolve({partnerName: '架空フリマ', amount: -15000}),
      decided('課対仕入（控70）10%'));
    assert.deepEqual(resolve(
      {partnerName: '架空サービス', accountCode: 843, amount: -15000}),
    decided('対象外'));
  });

  test('gt 2: 軽減と軽減にしない言葉の両方なら FOOD_AMBIGUOUS', () => {
    assert.deepEqual(resolve({purpose: '食品 ビール'}), undecided('FOOD_AMBIGUOUS'));
    assert.deepEqual(resolve({purpose: '食材 外食'}), undecided('FOOD_AMBIGUOUS'));
    // 軽減の言葉が無ければ、軽減にしない言葉だけでは決め方を変えない。
    assert.deepEqual(resolve({purpose: 'ビール'}), decided('課対仕入10%'));
  });

  test('gt 2: 表が無いと TABLES_MISSING、返金は表が無くても対象外', () => {
    assert.deepEqual(resolve({}, null), undecided('TABLES_MISSING'));
    assert.deepEqual(resolve({}, undefined), undecided('TABLES_MISSING'));
    assert.deepEqual(resolve({}, {present: false, marks: [], flags: []}),
      undecided('TABLES_MISSING'));
    assert.deepEqual(resolve({cashback: true}, null), decided('対象外'));
    assert.deepEqual(resolve({cashback: true, accountCode: '', amount: 'x'}, null),
      decided('対象外'));
  });

  test('gt 2: 利用日の読み方（文字・Date・暦に無い日・数）', () => {
    const ok = {accountCode: 852, purpose: '消耗品', amount: 3000};
    assert.deepEqual(resolve(Object.assign({}, ok, {date: '2026/11/01'})),
      decided('課対仕入10%'));
    assert.deepEqual(resolve(Object.assign({}, ok, {date: ' 2026-11-01 '})),
      decided('課対仕入10%'));
    assert.deepEqual(resolve(Object.assign({}, ok,
      {date: new Date('2026-11-01T12:00:00+09:00')})), decided('課対仕入10%'));
    ['2026-2-01', '2026-02-30', '2026-11-1', '2026-11/01', '2026年11月01日', '']
      .forEach((date) => {
        assert.deepEqual(resolve(Object.assign({}, ok, {date: date})),
          undecided('DATE_INVALID'), String(date));
      });
    assert.deepEqual(resolve(Object.assign({}, ok, {date: 45000})),
      undecided('DATE_INVALID'));
    assert.deepEqual(resolve(Object.assign({}, ok, {date: new Date('x')})),
      undecided('DATE_INVALID'));
    assert.deepEqual(resolve(Object.assign({}, ok, {date: true})),
      undecided('DATE_INVALID'));
    assert.deepEqual(resolve(Object.assign({}, ok, {date: null})),
      undecided('DATE_INVALID'));
  });

  test('gt 2: 金額は有限の数だけ（数字の文字は読まない）', () => {
    [['3000', 'AMOUNT_INVALID'], [NaN, 'AMOUNT_INVALID'],
      [Infinity, 'AMOUNT_INVALID'], [true, 'AMOUNT_INVALID'],
      [null, 'AMOUNT_INVALID'], [undefined, 'AMOUNT_INVALID']]
      .forEach(([amount, reason]) => {
        assert.deepEqual(resolve({partnerName: '架空フリマ', amount: amount}),
          undecided(reason), String(amount));
      });
    // 金額を見るのは印がフリマ・海外のサービスのときだけ。
    assert.deepEqual(resolve({accountCode: 852, purpose: '消耗品', amount: 'x'}),
      decided('課対仕入10%'));
    assert.deepEqual(resolve({accountCode: 294, partnerName: '架空フリマ', amount: 'x'}),
      decided('対象外'));
  });

  test('gt 2: §5.7 の最後の確かめ（NAME_UNKNOWN の守り）', () => {
    assert.equal(call('taxFinalName_', ['課対仕入（控70）10%', '2026-10-01']),
      '課対仕入（控70）10%');
    assert.equal(call('taxFinalName_', ['課対仕入（控70）10%', '2028-09-30']),
      '課対仕入（控70）10%');
    assert.equal(call('taxFinalName_', ['課対仕入（控70）10%', '2026-09-30']), null);
    assert.equal(call('taxFinalName_', ['課対仕入（控70）10%', '2028-10-01']), null);
    assert.equal(call('taxFinalName_', ['課対仕入（控70）10%', '']), null);
    assert.equal(call('taxFinalName_', ['課対仕入10%', '2026-11-01']), '課対仕入10%');
    assert.equal(call('taxFinalName_', ['課対輸本', '2026-11-01']), '課対輸本');
    assert.equal(call('taxFinalName_', ['対象外', '']), '対象外');
    assert.equal(call('taxFinalName_', ['架空の税区分', '2026-11-01']), null);
  });

  test('gt 2: §10.3 対象外・非課仕入には印・少額特例・言葉を当てない', () => {
    const cases = [
      {accountCode: 294, partnerName: '架空フリマ', amount: 3000, purpose: '食品',
        name: '対象外'},
      {accountCode: 362, partnerName: '架空海外ストア', amount: 3000, purpose: '食品',
        name: '対象外'},
      {accountCode: 847, partnerName: '架空フリマ', amount: 3000, purpose: '食品',
        name: '非課仕入'},
      {accountCode: 921, partnerName: '架空サービス', amount: 3000, purpose: '食品',
        name: '非課仕入'},
      {accountCode: 294, partnerName: '架空フリマ', amount: 'x', purpose: '',
        date: '', name: '対象外'},
      {accountCode: 836, partnerName: '架空フリマ', amount: 3000, purpose: '食品',
        name: '非課仕入'}
    ];
    cases.forEach((item) => {
      assert.deepEqual(resolve(item), decided(item.name), String(item.accountCode));
    });
  });

  test('gt 2: §10.1 決まった名前は一覧にあり、期間のある名前は利用日の中', () => {
    const categories = plain(evaluate('FREEE_TAX_CATEGORIES_'));
    const byName = {};
    categories.forEach((category) => { byName[category.name] = category; });
    const probes = [
      {accountCode: 852, purpose: '消耗品', amount: 3000, date: '2026-11-01'},
      {accountCode: 712, purpose: '仕入 食品', amount: 3000, date: '2026-11-01'},
      {accountCode: 712, purpose: '仕入 食品', amount: 3000, date: '2027-03-31'},
      {accountCode: 712, partnerName: '架空フリマ', amount: 9999, date: '2026-11-01'},
      {accountCode: 712, partnerName: '架空フリマ', amount: 12000, date: '2026-09-30'},
      {accountCode: 712, partnerName: '架空フリマ', amount: 12000, date: '2026-10-01'},
      {accountCode: 712, partnerName: '架空フリマ', amount: 12000, date: '2028-09-30'},
      {accountCode: 712, partnerName: '架空フリマ', amount: 12000, date: '2028-10-01'},
      {accountCode: 712, partnerName: '架空フリマ', amount: 12000, date: '2031-09-30'},
      {accountCode: 712, purpose: '仕入 食材', partnerName: '架空フリマ', amount: 12000,
        date: '2026-11-01'},
      {accountCode: 712, partnerName: '架空海外ストア', amount: 3000, date: '2026-11-01'},
      {accountCode: 843, partnerName: '架空サービス', amount: 3000, date: '2026-11-01'},
      {accountCode: 843, partnerName: '架空サービス', amount: 15000, date: '2026-11-01'},
      {accountCode: 294, partnerName: '架空フリマ', amount: 3000, date: '2026-11-01'},
      {accountCode: 847, amount: 3000, date: '2026-11-01'}
    ];
    probes.forEach((probe) => {
      const result = plain(call('resolveTaxCategory_', [input(probe), tables()]));
      if (result.status !== 'DECIDED') return;
      const category = byName[result.name];
      assert.ok(category, '一覧にある ' + result.name);
      assert.notEqual(result.name, '課対仕入', '率の無い課対仕入は出さない');
      if (result.name.indexOf('課対仕入') === 0) {
        assert.ok(/10%$|8%（軽）$/.test(result.name), '率が付いている ' + result.name);
      }
      if (category.from || category.to) {
        const date = call('taxDateValue_', [probe.date]);
        assert.ok(category.from && date >= category.from,
          '期間の始めの中 ' + result.name);
        assert.ok(!category.to || date <= category.to,
          '期間の終わりの中 ' + result.name);
      }
    });
  });

  // ---------------- gt 3: 表の読み方 ----------------

  test('gt 3: 見出しが違う・タブが無い・中身が空のタブは present: false', () => {
    const flagValues = tableValues(FLAG_HEADERS, defaultFlagRows());
    const present = (markValues, flag) => plain(call('taxTablesFromValues_', [markValues, flag]));
    assert.equal(present(null, flagValues).present, false);
    assert.equal(present(tableValues(MARK_HEADERS, defaultMarkRows()), null).present, false);
    assert.equal(present(undefined, undefined).present, false);
    assert.equal(present([], flagValues).present, false);
    assert.equal(present([[]], flagValues).present, false);
    assert.equal(present([MARK_HEADERS.slice(0, 6)], flagValues).present, false,
      '見出しが短い');
    assert.equal(present([[].concat(MARK_HEADERS.slice(0, 6), ['余計'])], flagValues).present,
      false, '7 列目が違う');
    assert.equal(present([MARK_HEADERS.map((header) => header + ' ')], flagValues).present,
      false, '空白は外さない');
    assert.equal(present([MARK_HEADERS.slice().reverse()], flagValues).present,
      false, '順が違う');
    assert.equal(present([MARK_HEADERS.concat(['余計'])], flagValues).present, true,
      '見出しより右の列は見ない');
    assert.deepEqual(present(null, flagValues), {present: false, marks: [], flags: []});
  });

  test('gt 3: 2 行目から読み、空の行は飛ばす（行番号も合う）', () => {
    const markValues = [
      MARK_HEADERS.concat(['余計']),
      markRow('架空フリマ', 'フリマ'),
      ['', '', '', '', '', '', ''],
      ['  ', '\t', '', '', '', '', ''],
      markRow('架空店舗', 'なし')
    ];
    const result = plain(call('taxTablesFromValues_', [
      markValues, tableValues(FLAG_HEADERS, defaultFlagRows())]));
    assert.equal(result.present, true);
    assert.deepEqual(result.marks.map((row) => row.rowNumber), [2, 5]);
    assert.deepEqual(result.marks[0].values,
      ['架空フリマ', 'フリマ', '', '', '', '', '']);
    assert.deepEqual(result.marks[1].values,
      ['架空店舗', 'なし', '', '', '', '', '']);
  });

  test('gt 3: 誤りの行の各種（鍵が空・印が不正・有効が読めない・有効 FALSE）', () => {
    const emptyKey = tables([markRow('', 'フリマ')], []);
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {partnerName: '架空フリマ', amount: 12000}), emptyKey])), decided('課対仕入10%'));

    const invalidMark = tables([markRow('架空フリマ', '')], []);
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {partnerName: '架空フリマ', amount: 12000}), invalidMark])), undecided('MARK_INVALID'));

    const invalidActive = tables([markRow('架空フリマ', 'フリマ', '', '真')], []);
    assert.deepEqual(plain(call('resolveTaxCategory_', [input(
      {partnerName: '架空フリマ', amount: 12000}), invalidActive])), undecided('MARK_INVALID'));

    assert.equal(call('taxPartnerMark_', ['架空フリマ', '', invalidActive.marks]),
      'MARK_INVALID');
    assert.equal(call('taxPartnerMark_', ['架空フリマ', '', tables(
      [markRow('架空フリマ', 'フリマ', '', false)], []).marks]), 'なし');
    assert.equal(call('taxPartnerMark_', ['架空フリマ', '', emptyKey.marks]), 'なし');
    assert.equal(call('taxPartnerMark_', ['', '', invalidMark.marks]), 'なし');
  });

  test('gt 3: 顧客の設定の読み方（A が空・行が無い・2 行・値が不正）', () => {
    const read = (rows, customerId) =>
      call('taxCustomerFlag_', [customerId, tables(undefined, rows).flags]);
    assert.equal(read([flagRow('', true)], 'K9001'), 'USABLE');
    assert.equal(read([], 'K9001'), 'USABLE');
    assert.equal(read([flagRow('K9001', true)], 'K9001'), 'UNUSABLE');
    assert.equal(read([flagRow('K9001', false)], 'K9001'), 'USABLE');
    assert.equal(read([flagRow('K9001', '')], 'K9001'), 'USABLE');
    assert.equal(read([flagRow('K9001', true), flagRow('K9001', true)], 'K9001'),
      'CUSTOMER_FLAG_INVALID');
    assert.equal(read([flagRow('K9001', '○')], 'K9001'), 'CUSTOMER_FLAG_INVALID');
    assert.equal(read([flagRow(' K9001 ', true)], 'K9001'), 'UNUSABLE',
      '前後の空白は外して比べる');
    assert.equal(read([flagRow('K9001', true)], ''), 'CUSTOMER_FLAG_INVALID');
  });

  // ---------------- gt 14: 書く値の守り ----------------

  test('gt 14: planned.g が文字列でなければ buildRowWrite は TypeError', () => {
    const isTypeError = (error) => error && error.name === 'TypeError';
    [null, 0, 3, 1.5, true, false, {}, []].forEach((value) => {
      assert.throws(() => call('buildRowWrite', [2, {planned: {g: value}}]),
        isTypeError, 'g=' + JSON.stringify(value));
    });
    assert.throws(() => call('buildRowWrite', [2, {planned: {g: null}, columns: ['g']}]),
      isTypeError);
  });

  test('gt 14: planned.g が文字列と undefined なら通る', () => {
    const text = call('buildRowWrite', [2, {planned: {g: '対象外'}}]);
    assert.equal(text.values.g, '対象外');
    const empty = call('buildRowWrite', [2, {planned: {g: ''}}]);
    assert.equal(empty.values.g, '');
    const none = call('buildRowWrite', [2, {planned: {}}]);
    assert.equal(Object.prototype.hasOwnProperty.call(none.values, 'g'), true);
    assert.equal(none.values.g, undefined);
    const narrowed = call('buildRowWrite', [2, {planned: {g: '対象外'}, columns: ['g']}]);
    assert.deepEqual(plain(narrowed.values), {g: '対象外'});
  });

  // ================================================================
  // 2 回目：取込（gt 4・5）・行を空ける（gt 9）・知らせ（gt 10）・
  // 値を出さない（gt 11）・回数（gt 13）。材料の組み立ては mca（店名で C）・
  // ac（用途で C）と同じ形にした。値はすべて架空である。
  // ================================================================

  const blank = (n) => Array(n).fill('');
  const master = (name) => gas.stubs.getSpreadsheet('master').getSheetByName(name);
  const destSheet = (id = 'dest1') => gas.stubs.getSpreadsheet(id).getSheetByName('入力用シート');
  const cell = (row, column, id = 'dest1') => destSheet(id).getRange(row, column).getValue();

  const GT_ACCOUNTS = [
    [712, '仕入高', '共通'], [852, '消耗品費', '共通'], [843, '通信費', '共通']
  ];

  function priorityCell(word) {
    if (word.priority === undefined) return '';
    return word.priority === true ? true : (word.priority === false ? '' : word.priority);
  }

  function activeCell(word) {
    return word.active === undefined ? true : word.active;
  }

  function setupMaster() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    call('setMasterSpreadsheetId', ['master']);
    call('provisionMasterSheets', []);
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
    gas.stubs.setActiveUser('tester@example.com');
  }

  function addAccounts(accounts) {
    const sheet = master('勘定科目一覧');
    accounts.forEach((account) => {
      const active = account.length > 3 ? account[3] : true;
      sheet.appendRow([account[0], account[1], account[2], active, '']);
    });
  }

  function addWords(words) {
    const sheet = master('用途科目辞書');
    words.forEach((word) => sheet.appendRow([word.word, word.code, word.category || '共通',
      word.customerId || '', priorityCell(word), activeCell(word), '', '', '']));
  }

  function formatRow() {
    const row = blank(37);
    Object.assign(row, {
      0: 'gt_fake_format', 1: '架空形式', 2: 'active', 3: true, 4: '["csv"]',
      5: JSON.stringify({allOf: [{maxRow: 1, keywords: ['利用日', '利用店名', '金額', '使用用途'], minMatch: 4}]}),
      6: 1, 7: 2, 8: 'A', 9: 'B', 10: 'C', 11: 'D',
      14: JSON.stringify({excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []}),
      16: JSON.stringify({sources: [{id: 'fn', kind: 'fileName', pattern: '(20\\d{2})(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}]}),
      17: 'generic', 18: 1, 19: 'tester@example.com', 21: '2026-01-01T00:00:00+09:00',
      29: 'NEW', 33: '2026-01-01T00:00:00+09:00'
    });
    return row;
  }

  /** [店名, 取引先名] か店名だけ。店名だけのときは架空取引先に当てる。 */
  function addDictionary(entries) {
    const sheet = master('共通取引先辞書');
    entries.forEach((entry, index) => {
      const merchant = Array.isArray(entry) ? entry[0] : entry;
      const partner = Array.isArray(entry) ? entry[1] : '架空取引先';
      const row = blank(18);
      Object.assign(row, {
        0: 'GT_DICT_' + index, 1: merchant, 2: call('normalizeMerchant', [merchant]),
        3: partner, 4: 'exact_original', 5: 1, 9: true, 10: 'tester@example.com',
        12: '2026-01-01', 13: 1, 14: true, 15: false
      });
      sheet.appendRow(row);
    });
  }

  /** 税の 2 つのタブ（§4.1・§4.2）。`only` で片方だけ作れる。 */
  function addTaxTabs(option) {
    if (!option) return;
    const spreadsheet = gas.stubs.getSpreadsheet('master');
    const headers = option.headers || {};
    if (option.only !== 'flags') {
      spreadsheet.insertSheet('取引先の税の印', {values: [
        (headers.marks || MARK_HEADERS).slice()].concat(option.marks || [])});
    }
    if (option.only !== 'marks') {
      spreadsheet.insertSheet('顧客の税の設定', {values: [
        (headers.flags || FLAG_HEADERS).slice()].concat(option.flags || [])});
    }
  }

  function setupWorld(options = {}) {
    setupMaster();
    const destinationId = 'dest1';
    const header = blank(15);
    Object.assign(header, {1: '利用日', 2: '相手科目コード', 3: '相手勘定科目',
      5: '取引先', 6: '相手税区分', 8: 'メモ', 10: '摘要', 11: '借方', 12: '貸方', 14: '取引ID'});
    const values = [blank(15), blank(15), header, Object.assign(blank(15), {0: '区切り'}), blank(15)];
    const list = options.sheetEntries || [];
    list.forEach((entry, index) => {
      values[4 + index] = values[4 + index] || blank(15);
      const row = values[4 + index];
      row[16] = entry[0];
      row[17] = entry[1];
    });
    gas.stubs.createSpreadsheet(destinationId, {sheets: [
      {name: '入力用シート', values: values, maxRows: 30, maxColumns: 30},
      {name: '取引先一覧', values: [['元店名', '取引先名']]}
    ]});
    gas.stubs.createFolder('parent', {fileIds: [destinationId]});
    gas.stubs.createFolder('folder1', {fileIds: []});
    master('カード形式マスター').appendRow(formatRow());
    if (options.accounts !== false) addAccounts(options.accounts || GT_ACCOUNTS);
    if (options.words) addWords(options.words);
    if (options.dictionary) addDictionary(options.dictionary);
    const columns = {B: 2, F: 6, I: 9, K: 11, L: 12, M: 13, txId: 15};
    if (options.gColumn !== false) columns.G = 7;
    if (options.accountColumn !== false) columns.C = 3;
    const config = {
      customerId: options.customerId || 'C001', customerName: '架空顧客',
      sourceFolderId: 'folder1', destinationSpreadsheetId: destinationId,
      destinationSheetName: '入力用シート', partnerListSheetName: '取引先一覧',
      headerRow: 3, dataStartRow: 5, rowScanLastColumn: 15,
      customerCategory: options.category || 'CORPORATE',
      columns: columns,
      reviewers: 'tester@example.com', admins: 'tester@example.com'
    };
    if (options.accountColumn !== false) config.accountListRange = options.listRange || 'Q5:R12';
    if (options.excludedColumns) config.rowScanExcludedColumns = options.excludedColumns;
    if (options.cashbackMerchants) config.cashbackMerchants = options.cashbackMerchants;
    call('registerTestCustomer', [config]);
    const registered = call('getCustomerById', [config.customerId]);
    addTaxTabs(options.taxTabs);
    const fileIds = [];
    function addFile(fileId, rows, name = '架空カード202610.csv') {
      const csv = ['利用日,利用店名,金額,使用用途'].concat(rows).join('\n');
      gas.stubs.createFile(fileId, {name: name, bytes: Buffer.from(csv, 'utf8'),
        contentType: 'text/csv', lastUpdated: new Date(Date.now() - 3600000),
        createdTime: '2026-08-01T00:00:00Z'});
      fileIds.push(fileId);
      gas.stubs.createFolder('folder1', {fileIds: fileIds.slice()});
    }
    function lease(fileId = 'lease-file') {
      gas.stubs.createFile(fileId, {name: '架空.csv', data: 'fake'});
      call('createOrUpdateProcessLog', ['RUN_LEASE', registered, {id: fileId, name: '架空.csv',
        binaryHash: 'b'.repeat(64), contentHash: 'c'.repeat(64), hashVersion: '3', state: 'WRITING'}]);
      return call('acquireLease', [registered.customerId, fileId, 'RUN_LEASE',
        'tester@example.com', 'PROCESS']);
    }
    return {customer: registered, destinationId: destinationId, addFile: addFile, lease: lease};
  }

  function importReport(world) {
    const report = plain(call('runImport', [{}]));
    assert.equal(report.stoppedBy, null, JSON.stringify(report));
    return report;
  }

  function transactionsFor(fileId) {
    return call('getTransactionsForFile_', [fileId])
      .sort((a, b) => a.sourceRow - b.sourceRow);
  }

  /** G への書込レンジ（行番号）を集める。 */
  function captureTaxWrites(fn) {
    const rows = [];
    gas.stubs.onValuesBatchUpdate((request) => {
      (request.data || []).forEach((data) => {
        const match = /!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(String(data.range));
        if (!match || match[1] !== 'G') return;
        for (let row = Number(match[2]); row <= Number(match[4]); row += 1) rows.push(row);
      });
    });
    try { return {result: fn(), rows: rows.sort((a, b) => a - b)}; }
    finally { gas.stubs.onValuesBatchUpdate(null); }
  }

  /** 取引ログへ渡す直前の `planned.g`（決まらない行が `undefined` か）を見る。 */
  function capturePlannedTax(fn) {
    const seen = [];
    const real = gas.context.registerPrepared;
    gas.context.registerPrepared = function(txs) {
      (txs || []).forEach((tx) => {
        seen.push(tx && tx.planned ? tx.planned.g : undefined);
      });
      return real.apply(this, arguments);
    };
    try { return {result: fn(), g: seen}; }
    finally { gas.context.registerPrepared = real; }
  }

  /** 税の 2 つのタブを、こちらのコードが `getSheetByName` で見た回数を数える。 */
  function countTaxSheetLookups(fn) {
    const spreadsheet = gas.stubs.getSpreadsheet('master');
    const real = spreadsheet.getSheetByName.bind(spreadsheet);
    let count = 0;
    spreadsheet.getSheetByName = function(name) {
      // スタブが範囲を解くときにも `getSheetByName` を通る。数えるのは
      // こちらの `taxTableSheetsForRun_` から見た分だけにする。
      if ((name === '取引先の税の印' || name === '顧客の税の設定') &&
          String(new Error().stack).indexOf('taxTableSheetsForRun_') >= 0) {
        count += 1;
      }
      return real(name);
    };
    try { return {result: fn(), count: count}; }
    finally { spreadsheet.getSheetByName = real; }
  }

  /** `81` の `customerFixNoticeLines` を、既存の【科目コード】のテストと同じ形で呼ぶ。 */
  function noticeLines(files) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', '81_WebAppUi.html'), 'utf8');
    const script = /<script>([\s\S]*?)<\/script>/.exec(source)[1];
    const needle = "    el['customer-search'].addEventListener";
    assert.ok(script.includes(needle));
    const sandbox = {document: {getElementById() { return {}; }}};
    vm.runInNewContext(script.replace(needle,
      `    globalThis.probe = customerFixNoticeLines(${JSON.stringify(files)}); return;\n` + needle),
    sandbox);
    return plain(sandbox.probe);
  }

  // ---------------- gt 4: 取込で書く ----------------

  test('gt 4: 取込で決まる行だけ G に書き、決まらない行は書かず、返金は対象外（足した C でも決まる）', () => {
    const world = setupWorld({
      accounts: GT_ACCOUNTS,
      sheetEntries: [[712, '仕入高']],
      dictionary: [['架空店舗', '架空店舗取引先'], ['架空フリマ', '架空フリマ取引先']],
      words: [{word: '仕入', code: 712}, {word: '消耗品', code: 852}, {word: '通信費', code: 843}],
      cashbackMerchants: ['架空返金店'],
      taxTabs: {marks: [markRow('架空フリマ取引先', 'フリマ')]}
    });
    world.addFile('fileA', [
      '2026/10/10,架空店舗,1000,消耗品',
      '2026/10/11,架空フリマ,12000,仕入',
      '2026/10/12,架空店舗,3000,謎用途',
      '2026/10/13,架空返金店,1000,仕入',
      '2026/10/14,架空未登録店,2000,消耗品',
      '2026/10/15,架空店舗,4000,通信費'
    ]);
    const captured = captureTaxWrites(() => capturePlannedTax(() => importReport(world)));
    const file = captured.result.result.customers[0].files[0];
    assert.equal(file.outcome, 'WRITTEN', JSON.stringify(file));

    // 決まらない行の planned.g は `undefined`（`''`・`null` にしない。§10.2）。
    assert.deepEqual(Array.from(captured.result.g, (value) => value),
      ['課対仕入10%', '課対仕入（控70）10%', undefined, '対象外',
        '課対仕入10%', '課対仕入10%']);

    // 決まる行だけ G に名前が入る。決まらない行（3 行目）の G は空のまま。
    assert.equal(cell(5, 7), '課対仕入10%', '消耗品は 10%');
    assert.equal(cell(6, 7), '課対仕入（控70）10%', 'フリマの 1 万円以上');
    assert.equal(cell(7, 7), '', 'C が決まらない行の G には触らない');
    assert.equal(cell(8, 7), '対象外', '返金の行');
    assert.equal(cell(9, 7), '課対仕入10%', '要確認の行も印なしで入る');
    assert.equal(cell(10, 7), '課対仕入10%', '一覧に足して C が決まった行');

    // 決まらない行には G の書込要求そのものが無い（空を書かない）。
    assert.deepEqual(captured.rows, [5, 6, 8, 9, 10]);
    assert.equal(captured.rows.indexOf(7), -1);

    const txs = transactionsFor('fileA');
    assert.equal(txs.length, 6);
    assert.deepEqual(Array.from(txs, (tx) => tx.planned.g),
      ['課対仕入10%', '課対仕入（控70）10%', undefined, '対象外',
        '課対仕入10%', '課対仕入10%']);
    assert.equal(txs[2].verified.g, undefined);
    assert.equal(txs[1].verified.g, '課対仕入（控70）10%');
    assert.equal(txs[5].planned.c, 843, '一覧に足した C で G を決める');
    assert.equal(txs[4].partnerResolutionStatus, 'UNRESOLVED');
    assert.equal(txs[2].taxResolution, undefined, 'taxResolution は取引ログに出さない');
  });

  // ---------------- gt 5: 効かない顧客 ----------------

  test('gt 5: §2.3 でない顧客・表が無いときの取込は今と同じ', () => {
    function taxCase(options) {
      const world = setupWorld(Object.assign({
        accounts: GT_ACCOUNTS,
        sheetEntries: [[712, '仕入高']],
        dictionary: [['架空店舗', '架空店舗取引先']],
        words: [{word: '仕入', code: 712}],
        cashbackMerchants: ['架空返金店']
      }, options));
      world.addFile('fileA', [
        '2026/10/10,架空返金店,1000,仕入',
        '2026/10/11,架空店舗,2000,仕入'
      ]);
      gas.stubs.resetApiCallCounts();
      const counted = countTaxSheetLookups(() => captureTaxWrites(() => importReport(world)));
      return {
        file: counted.result.result.customers[0].files[0],
        rows: counted.result.rows,
        counts: gas.stubs.getApiCallCounts(),
        lookups: counted.count,
        refund: cell(5, 7),
        other: cell(6, 7)
      };
    }

    const noG = taxCase({gColumn: false});
    const inExcluded = taxCase({excludedColumns: [7]});
    const noC = taxCase({accountColumn: false});
    const noTables = taxCase({});
    const wrongHeaders = taxCase({taxTabs: {headers: {
      marks: ['取引先名', '印', '顧客ID', '有効', '登録日時', '登録者', 'メモ ']}}});
    const oneTab = taxCase({taxTabs: {only: 'marks',
      marks: [markRow('架空店舗取引先', 'フリマ')]}});

    // G の列が無ければ G を書かない。G があっても §2.3 でなければ今の作り
    // （返金の行だけ「対象外」）のまま。
    assert.deepEqual(noG.rows, []);
    assert.equal(noG.refund, '');
    assert.equal(noG.other, '');
    [inExcluded, noC, noTables, wrongHeaders, oneTab].forEach((result) => {
      assert.deepEqual(result.rows, [5], '返金の行だけ');
      assert.equal(result.refund, '対象外');
      assert.equal(result.other, '');
      assert.equal(result.file.outcome, 'WRITTEN');
      assert.equal(result.file.taxCategory, undefined, '表が無い・効かない顧客は知らせを出さない');
    });

    // 書込・読取の回数は今と同じ（同じ C の有無どうしで比べる）。
    [noTables, wrongHeaders, oneTab].forEach((result) => {
      assert.equal(result.counts.batchGet, inExcluded.counts.batchGet,
        JSON.stringify([inExcluded, result]));
      assert.equal(result.counts.batchUpdate, inExcluded.counts.batchUpdate);
      assert.equal(result.file.reads, inExcluded.file.reads);
    });
    assert.equal(noTables.counts.batchGet, noG.counts.batchGet);
    assert.equal(noTables.counts.batchUpdate, noG.counts.batchUpdate);

    // タブを見るのは §2.3 の顧客だけ（表の有無を決めるため）。効かない顧客は見ない。
    assert.equal(noG.lookups, 0);
    assert.equal(inExcluded.lookups, 0);
    assert.equal(noC.lookups, 0);
    assert.equal(noTables.lookups, 2, '無いタブを範囲に入れないため、先に 2 つ見る');
    assert.equal(wrongHeaders.lookups, 2);
    assert.equal(oneTab.lookups, 2);
  });

  // ---------------- gt 9: 行を空ける ----------------

  test('gt 9: 対象外のまとめ（57）で G も空にし、G が AL にある顧客では触らない', () => {
    function run(excludedColumns) {
      const world = setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [[712, '仕入高']],
        dictionary: [['架空零円店', '架空零円取引先']], words: [{word: '仕入', code: 712}],
        taxTabs: {marks: GT_MARKS}, excludedColumns: excludedColumns});
      world.addFile('fileA', ['2026/10/10,架空零円店,0,仕入']);
      importReport(world);
      const review = typedReviews('fileA', 'ZERO_AMOUNT')[0];
      assert.ok(review, JSON.stringify(plain(call('openReviews', [{}]))));
      const tx = call('getTransaction', [review.fullTxId]);
      destSheet().getRange(tx.destinationRow, 7).setValue('課対仕入10%');
      const captured = captureTaxWrites(() => call('excludeOtherReviewsBatch',
        ['C001', 'fileA', [{reviewId: review.reviewId, operation: 'EXCLUDE'}],
          {actor: 'tester@example.com'}]));
      const customer = call('getCustomerById', ['C001']);
      return {result: plain(captured.result), rows: captured.rows,
        row: tx.destinationRow, value: cell(tx.destinationRow, 7),
        keys: call('excludeBatchClearColumns_', [customer]).map((entry) => entry.key),
        empty: call('excludeBatchEmptyValues_', [customer])};
    }
    // G が AL に無い顧客: 対象外のまとめで G も空にし、読み返しでも G を見る
    // （空にできなければ DESTINATION_VALUE_MISMATCH で止まる）。
    const clearable = run(undefined);
    assert.deepEqual(clearable.result.errors, []);
    assert.equal(clearable.result.resolvedReviewIds.length, 1);
    assert.ok(clearable.keys.indexOf('g') >= 0, '空にする列に G がある');
    assert.equal(Object.prototype.hasOwnProperty.call(clearable.empty, 'g'), true,
      '読み返しでも G を見る');
    assert.equal(clearable.value, '');
    assert.ok(clearable.rows.indexOf(clearable.row) >= 0, 'G を空にする書込がある');

    // G が AL にある顧客: G に触らない（今の作りのまま）。
    const inAl = run([7]);
    assert.deepEqual(inAl.result.errors, []);
    assert.equal(inAl.keys.indexOf('g'), -1);
    assert.equal(Object.prototype.hasOwnProperty.call(inAl.empty, 'g'), false);
    assert.equal(inAl.value, '課対仕入10%');
    assert.deepEqual(inAl.rows, []);
  });

  test('gt 9: 行を空ける 3 か所で G も空にし、G が AL にある顧客では触らない', () => {
    const world = setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [[712, '仕入高']]});
    const lease = world.lease();
    const sheet = destSheet();

    // 1. clearTransactionRows。取消の後に決まらない取引が入っても前の G は残らない。
    sheet.getRange(5, 7).setValue('対象外');
    sheet.getRange(5, 15).setValue('GT_TX_9');
    call('clearTransactionRows', [world.customer, [5], lease, 'lease-file']);
    assert.equal(cell(5, 7), '');
    const afterClear = call('buildRowWrite', [5, {fullTxId: 'GT_TX_9B',
      planned: {b: '2026-10-11', f: '', i: '謎用途', k: '架空店舗', m: 1200}}]);
    call('writeTransactionRows', [world.customer, [afterClear], lease, 'lease-file']);
    assert.equal(cell(5, 7), '');
    assert.equal(afterClear.values.g, undefined);

    // 2. 複製元の判定。G に値があれば使用中と見なす。
    const values = sheet.getRange(4, 1, 1, 15).getValues()[0];
    values[6] = '対象外';
    assert.equal(call('systemOwnedColumnsAreEmpty_', [world.customer, values]), false);
    values[6] = '';
    assert.equal(call('systemOwnedColumnsAreEmpty_', [world.customer, values]), true);

    // 3. 行の追加。複製した行の G を空にする。
    const realGet = sheet.getRange.bind(sheet);
    sheet.getRange = function(...args) {
      const range = realGet(...args);
      if (args[0] === 4 && args[1] === 1 && args[3] === 15) {
        const copy = range.copyTo.bind(range);
        range.copyTo = (target) => {
          const result = copy(target);
          sheet.getRange(target.getRow(), 7).setValue('対象外');
          return result;
        };
      }
      return range;
    };
    let added;
    try {
      const index = call('buildIndex', [world.customer]);
      added = call('expandTemplateRows', [world.customer, sheet, 1, 4,
        {actual: sheet.getMaxRows(), index: index}]);
    } finally { sheet.getRange = realGet; }
    assert.equal(added.length, 1);
    assert.equal(cell(added[0], 7), '');
    assert.equal(cell(added[0], 1), '区切り');

    // G が AL にある顧客では、3 か所とも G に触らない。
    const al = setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [[712, '仕入高']],
      excludedColumns: [7]});
    const alLease = al.lease('lease-al');
    const alSheet = destSheet();
    alSheet.getRange(5, 7).setValue('対象外');
    alSheet.getRange(5, 15).setValue('GT_TX_9C');
    call('clearTransactionRows', [al.customer, [5], alLease, 'lease-al']);
    assert.equal(cell(5, 7), '対象外');
    const alValues = alSheet.getRange(4, 1, 1, 15).getValues()[0];
    alValues[6] = '対象外';
    assert.equal(call('systemOwnedColumnsAreEmpty_', [al.customer, alValues]), true);

    const realAlGet = alSheet.getRange.bind(alSheet);
    alSheet.getRange = function(...args) {
      const range = realAlGet(...args);
      if (args[0] === 4 && args[1] === 1 && args[3] === 15) {
        const copy = range.copyTo.bind(range);
        range.copyTo = (target) => {
          const result = copy(target);
          alSheet.getRange(target.getRow(), 7).setValue('対象外');
          return result;
        };
      }
      return range;
    };
    let alAdded;
    try {
      alAdded = call('expandTemplateRows', [al.customer, alSheet, 1, 4,
        {actual: alSheet.getMaxRows(), index: call('buildIndex', [al.customer])}]);
    } finally { alSheet.getRange = realAlGet; }
    assert.equal(alAdded.length, 1);
    assert.equal(cell(alAdded[0], 7), '対象外');
  });

  /** 対象外のまとめで使う、0 円の要確認を 1 件だけ作る。 */
  function zeroAmountWorld() {
    const world = setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [[712, '仕入高']],
      dictionary: [['架空零円店', '架空零円取引先']], words: [{word: '仕入', code: 712}],
      taxTabs: {marks: GT_MARKS}});
    world.addFile('fileA', ['2026/10/10,架空零円店,0,仕入']);
    importReport(world);
    const review = typedReviews('fileA', 'ZERO_AMOUNT')[0];
    assert.ok(review, JSON.stringify(plain(call('openReviews', [{}]))));
    return {world: world, review: review,
      tx: call('getTransaction', [review.fullTxId])};
  }

  test('gt 9: 57 の読み返しで G に値が戻れば DESTINATION_VALUE_MISMATCH にし、取引を CANCELED にしない', () => {
    const {review, tx} = zeroAmountWorld();
    const row = Number(tx.destinationRow);
    destSheet().getRange(row, 7).setValue('課対仕入10%');
    // 空にした後に G だけ値が戻る（別の担当者が入れた等）。G への書込だけ、
    // 書いた後に値を書き戻す ── スタブの `batchUpdate` の G の 1 セルが
    // 空にならずに残るのと同じ状態になる。
    const sheet = destSheet();
    const realGet = sheet.getRange.bind(sheet);
    sheet.getRange = function(...args) {
      const range = realGet(...args);
      if (Number(args[0]) === row && Number(args[1]) === 7 &&
          (args.length < 3 || Number(args[2]) === 1)) {
        const realSet = range.setValues.bind(range);
        range.setValues = (values) => {
          const result = realSet(values);
          realSet([['課対仕入10%']]);
          return result;
        };
      }
      return range;
    };
    let result;
    try {
      result = plain(call('excludeOtherReviewsBatch', ['C001', 'fileA',
        [{reviewId: review.reviewId, operation: 'EXCLUDE'}],
        {actor: 'tester@example.com'}]));
    } finally { sheet.getRange = realGet; }
    assert.deepEqual(result.resolvedReviewIds, []);
    assert.deepEqual(result.errors.map((entry) => entry.code), ['DESTINATION_VALUE_MISMATCH']);
    assert.equal(result.errors[0].reviewId, review.reviewId);
    assert.equal(call('getTransaction', [review.fullTxId]).transactionStatus, 'REVIEW_REQUIRED');
    assert.equal(call('getReviewById', [review.reviewId]).status, 'OPEN');
    assert.equal(cell(row, 7), '課対仕入10%');
  });

  test('gt 9: 57 の「もう空」の判定は G が残る行を ALREADY_CLEARED にせず DESTINATION_ROW_MISMATCH にする', () => {
    const {review, tx} = zeroAmountWorld();
    const row = Number(tx.destinationRow);
    // 取引ログにこの行の記録はあるが、取引 ID の列は空で G だけ値が残る行
    // （前の対象外で G を消し損ねた行）。
    assert.equal(tx.destinationSpreadsheetId, 'dest1');
    const sheet = destSheet();
    [2, 3, 6, 9, 11, 12, 13, 15].forEach((column) => sheet.getRange(row, column).setValue(''));
    sheet.getRange(row, 7).setValue('課対仕入10%');
    const result = plain(call('excludeOtherReviewsBatch', ['C001', 'fileA',
      [{reviewId: review.reviewId, operation: 'EXCLUDE'}],
      {actor: 'tester@example.com'}]));
    assert.deepEqual(result.resolvedReviewIds, []);
    assert.deepEqual(result.errors.map((entry) => entry.code), ['DESTINATION_ROW_MISMATCH']);
    assert.equal(result.errors[0].reviewId, review.reviewId);
    assert.equal(call('getTransaction', [review.fullTxId]).transactionStatus, 'REVIEW_REQUIRED');
    assert.equal(call('getReviewById', [review.reviewId]).status, 'OPEN');
    assert.equal(cell(row, 7), '課対仕入10%');
  });

  // ---------------- gt 10: 知らせ ----------------

  test('gt 10: 取込の知らせの件数と 1 行（0 の分は出さず、表が無ければ出さない）', () => {
    const world = setupWorld({
      accounts: GT_ACCOUNTS.concat([[9999, '架空科目', '共通']]),
      sheetEntries: [[712, '仕入高'], [9999, '架空科目']],
      dictionary: [['架空店舗', '架空店舗取引先'], ['架空フリマ', '架空フリマ取引先']],
      words: [{word: '仕入', code: 712}, {word: '消耗品', code: 852},
        {word: '謎語', code: 9999}, {word: '消費税', code: 712}],
      taxTabs: {marks: [markRow('架空フリマ取引先', '○')]}
    });
    world.addFile('fileA', [
      '2026/10/10,架空店舗,1000,まったく謎',
      '2026/10/11,架空フリマ,2000,仕入',
      '2026/10/12,架空店舗,3000,消費税',
      '2026/10/13,架空店舗,4000,謎語'
    ]);
    const report = importReport(world);
    const file = report.customers[0].files[0];
    assert.equal(file.outcome, 'WRITTEN', JSON.stringify(file));
    assert.deepEqual(file.taxCategory, {missing: 4, noAccount: 1, notInTable: 1,
      words: 1, dateAmount: 0, marks: 1, other: 0});

    assert.deepEqual(noticeLines([{fileName: '架空.csv', taxCategory: file.taxCategory}]),
      ['【税区分】架空.csv：4 行は相手税区分を入れていません（科目が決まっていない 1 行・' +
        '表に無い科目 1 行・決めない用途 1 行・取引先の印の誤り 1 行）。' +
        'G 列は空のままでも freee 取込用は作れます（freee が勘定科目の税区分を使います）']);

    // 【科目コード】のすぐ後ろに出る。0 の分は出さない。
    assert.deepEqual(noticeLines([{fileName: '架空.csv',
      accountCode: {missing: 1, noMatch: 1, ambiguous: 0, invalidEntry: 0, notInSheetList: 0},
      taxCategory: {missing: 6, noAccount: 1, notInTable: 1, words: 1,
        dateAmount: 1, marks: 1, other: 1}}]), [
      '【科目コード】架空.csv：1 行は相手科目コードを入れていません（辞書に無い用途 1 行）。C 列に手で入れてください',
      '【税区分】架空.csv：6 行は相手税区分を入れていません（科目が決まっていない 1 行・' +
        '表に無い科目 1 行・決めない用途 1 行・日付か金額 1 行・取引先の印の誤り 1 行・' +
        'その他 1 行）。G 列は空のままでも freee 取込用は作れます（freee が勘定科目の税区分を使います）'
    ]);

    // 0 件・項目が無いときは行を出さない。
    assert.deepEqual(noticeLines([{fileName: '架空.csv',
      taxCategory: {missing: 0, noAccount: 0, notInTable: 0, words: 0,
        dateAmount: 0, marks: 0, other: 0}}]), []);
    assert.deepEqual(noticeLines([{fileName: '架空.csv'}]), []);

    // 表が無いときは outcome に taxCategory を入れない（知らせも出ない）。
    const noTables = setupWorld({
      accounts: GT_ACCOUNTS, sheetEntries: [[712, '仕入高']],
      dictionary: [['架空店舗', '架空店舗取引先']], words: [{word: '仕入', code: 712}]
    });
    noTables.addFile('fileA', ['2026/10/10,架空店舗,1000,謎用途']);
    const noTablesFile = importReport(noTables).customers[0].files[0];
    assert.equal(noTablesFile.outcome, 'WRITTEN');
    assert.equal(noTablesFile.taxCategory, undefined);
  });

  // ---------------- gt 11: 値を出さない ----------------

  test('gt 11: 用途・店名・金額・取引先名を outcome にもログにも出さない', () => {
    const world = setupWorld({
      accounts: GT_ACCOUNTS,
      sheetEntries: [[712, '仕入高']],
      dictionary: [['架空秘密店', '架空秘密取引先']],
      words: [{word: '架空秘密用途', code: 712}],
      taxTabs: {marks: [markRow('架空秘密取引先', '○')]}
    });
    world.addFile('fileA', ['2026/10/10,架空秘密店,9876543,架空秘密用途']);
    const report = importReport(world);
    const file = report.customers[0].files[0];
    assert.equal(file.outcome, 'WRITTEN', JSON.stringify(file));
    assert.equal(file.taxCategory.missing, 1, '印の誤りで決まらない');
    const serialized = JSON.stringify(report);
    for (const secret of ['架空秘密用途', '架空秘密店', '架空秘密取引先', '9876543']) {
      assert.ok(serialized.indexOf(secret) < 0, secret + ' must not appear in outcome');
      assert.ok(gas.stubs.getLogLines().every((line) => line.indexOf(secret) < 0),
        secret + ' must not appear in logs');
    }
  });

  // ---------------- gt 13: 回数 ----------------

  test('gt 13: 取込の往復を増やさず、税のタブは実行で 1 回だけ見る', () => {
    function run(taxTabs) {
      const world = setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [[712, '仕入高']],
        dictionary: [['架空店舗', '架空店舗取引先']], words: [{word: '仕入', code: 712}],
        taxTabs: taxTabs});
      world.addFile('fileA', ['2026/10/10,架空店舗,1000,仕入']);
      gas.stubs.resetApiCallCounts();
      const counted = countTaxSheetLookups(() => importReport(world));
      return {file: counted.result.customers[0].files[0],
        counts: gas.stubs.getApiCallCounts(), lookups: counted.count};
    }
    const withTables = run({marks: [], flags: []});
    const withoutTables = run(undefined);
    assert.equal(withTables.file.outcome, 'WRITTEN');
    assert.equal(withoutTables.file.outcome, 'WRITTEN');
    assert.equal(withTables.file.taxCategory, undefined, '決まる行だけなら知らせは出ない');

    // 表の 2 つの範囲は今の 1 回の `batchGet` に足すだけ（往復を増やさない）。
    assert.equal(withTables.counts.batchGet, withoutTables.counts.batchGet,
      JSON.stringify([withTables, withoutTables]));
    assert.equal(withTables.counts.batchUpdate, withoutTables.counts.batchUpdate);
    assert.equal(withTables.file.reads, withoutTables.file.reads);
    assert.equal(withTables.lookups, 2);
    assert.equal(withoutTables.lookups, 2);

    // 2 ファイル目は覚えた表を使う（タブを見直さない）。
    const two = setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [[712, '仕入高']],
      dictionary: [['架空店舗', '架空店舗取引先']], words: [{word: '仕入', code: 712}],
      taxTabs: {marks: [], flags: []}});
    two.addFile('fileA', ['2026/10/10,架空店舗,1000,仕入']);
    two.addFile('fileB', ['2026/10/11,架空店舗,2000,仕入']);
    const counted = countTaxSheetLookups(() => importReport(two));
    assert.equal(counted.result.customers[0].files.length, 2);
    assert.equal(counted.count, 2, '実行の中で 1 回だけ見る');
  });

  // ================================================================
  // 3 回目：確定（gt 6・7）・日付金額の修正（gt 8）・回数（gt 13）。
  // 材料の組み立ては 2 回目の gt 4・5 と同じ形にした。値はすべて架空である。
  // ================================================================

  function partnerReviews(fileId) {
    return plain(call('openReviews', [{}]))
      .filter((review) => review.reviewType === 'PARTNER' && review.fileId === fileId)
      .sort((a, b) => Number(a.sourceRow) - Number(b.sourceRow));
  }

  function typedReviews(fileId, type) {
    return plain(call('openReviews', [{}]))
      .filter((review) => review.reviewType === type && review.fileId === fileId)
      .sort((a, b) => Number(a.sourceRow) - Number(b.sourceRow));
  }

  /** 1 回の呼出しの `batchGet` と `apiReadCount_` の差を測る。 */
  function measured(fn) {
    gas.stubs.resetApiCallCounts();
    const before = Number(gas.evaluate('apiReadCount_')) || 0;
    const result = fn();
    return {result: result, batchGet: gas.stubs.getApiCallCounts().batchGet,
      reads: (Number(gas.evaluate('apiReadCount_')) || 0) - before};
  }

  /** 2 つ目の転記先（複数の転記先を見るためだけ）。 */
  function addDestination(id) {
    const header = blank(15);
    Object.assign(header, {1: '利用日', 2: '相手科目コード', 3: '相手勘定科目',
      5: '取引先', 6: '相手税区分', 8: 'メモ', 10: '摘要', 11: '借方', 12: '貸方', 14: '取引ID'});
    const values = [blank(15), blank(15), header,
      Object.assign(blank(15), {0: '区切り'}), blank(15)];
    gas.stubs.createSpreadsheet(id, {sheets: [
      {name: '入力用シート', values: values, maxRows: 30, maxColumns: 30},
      {name: '取引先一覧', values: [['元店名', '取引先名']]}
    ]});
  }

  const GT_MARKS = [markRow('架空フリマ取引先', 'フリマ'), markRow('架空印誤り取引先', '○')];

  const GT_CONFIRM_ROWS = [
    '2026/10/11,架空未登録A,12000,仕入',
    '2026/10/12,架空未登録B,3000,仕入',
    '2026/10/13,架空未登録C,5000,仕入',
    '2026/10/14,架空未登録D,15000,仕入'
  ];

  function confirmationWorld(options = {}) {
    const world = setupWorld(Object.assign({
      accounts: GT_ACCOUNTS,
      sheetEntries: [[712, '仕入高']],
      dictionary: [['架空フリマ', '架空フリマ取引先']],
      words: [{word: '仕入', code: 712}],
      taxTabs: {marks: GT_MARKS}
    }, options));
    // 確定で使う名前を先に一覧へ置く（新規名の登録監査に取引先名を出さない
    // ため。§10.12 の確かめ）。
    (options.knownPartners || ['架空フリマ取引先', '架空店舗取引先', '架空印誤り取引先'])
      .forEach((name) => {
        master('顧客別取引先一覧').appendRow([
          call('customerPartnerId_', ['C001', name]), 'C001', name, 'ACTIVE',
          '', '', 'tester@example.com', '', '', ''
        ]);
      });
    world.addFile('fileA', options.rows || GT_CONFIRM_ROWS.slice());
    importReport(world);
    return world;
  }

  /** §10.12: 用途・店名・金額・取引先名・税区分名をログと監査に出さない。 */
  function assertNoTaxValues(values) {
    const logs = gas.stubs.getLogLines().join('\n');
    const audits = JSON.stringify(master('監査ログ').getDataRange().getValues());
    values.forEach((secret) => {
      assert.ok(logs.indexOf(secret) < 0, secret + ' must not appear in logs');
      assert.ok(audits.indexOf(secret) < 0, secret + ' must not appear in audits');
    });
  }

  function adoptionDecision(review, partnerName) {
    return {reviewId: review.reviewId, operation: 'ADOPT_EXISTING_PARTNER',
      partnerName: partnerName, learn: false};
  }

  // ---------------- gt 6: 取引先の確定（1 件） ----------------

  test('gt 6: 取引先の確定（1 件）で G を決め直し、変わるときだけ書き、印が誤りなら空にする', () => {
    const world = confirmationWorld({rows: GT_CONFIRM_ROWS.slice(0, 3)});
    const reviews = partnerReviews('fileA');
    assert.equal(reviews.length, 3);
    // 取込の時点では取引先が空なので印が無く、すべて 10%。
    [5, 6, 7].forEach((row) => assert.equal(cell(row, 7), '課対仕入10%'));

    // フリマの印: 1 万円以上なので経過措置（控70）に変わる。
    const changed = captureTaxWrites(() => call('resolveReview',
      [reviews[0].reviewId, 'ADOPT_EXISTING_PARTNER',
        {partnerName: '架空フリマ取引先', learn: false}]));
    assert.deepEqual(changed.rows, [5]);
    assert.equal(cell(5, 7), '課対仕入（控70）10%');

    // 印なし: 決め直した値が今と同じなので G に触らない。
    const unchanged = captureTaxWrites(() => call('resolveReview',
      [reviews[1].reviewId, 'ADOPT_EXISTING_PARTNER',
        {partnerName: '架空店舗取引先', learn: false}]));
    assert.deepEqual(unchanged.rows, []);
    assert.equal(cell(6, 7), '課対仕入10%');

    // 印が誤り: 決まらなくなったので G を空にする。
    const invalid = captureTaxWrites(() => call('resolveReview',
      [reviews[2].reviewId, 'ADOPT_EXISTING_PARTNER',
        {partnerName: '架空印誤り取引先', learn: false}]));
    assert.deepEqual(invalid.rows, [7]);
    assert.equal(cell(7, 7), '');

    // 読取確認と取引ログ 46・47 も新しい値（空にした行は undefined に戻る）。
    const first = call('getTransaction', [reviews[0].fullTxId]);
    assert.equal(first.planned.g, '課対仕入（控70）10%');
    assert.equal(first.verified.g, '課対仕入（控70）10%');
    const second = call('getTransaction', [reviews[1].fullTxId]);
    assert.equal(second.planned.g, '課対仕入10%');
    assert.equal(second.verified.g, '課対仕入10%');
    const third = call('getTransaction', [reviews[2].fullTxId]);
    assert.equal(third.planned.g, undefined);
    assert.equal(third.verified.g, undefined);
    // §10.12: 用途・店名・金額・取引先名・税区分名をログと監査に出さない。
    assertNoTaxValues(['仕入', '架空未登録A', '12000', '架空フリマ取引先',
      '課対仕入（控70）10%']);
  });

  // ---------------- gt 6: 表が無いときの確定 ----------------

  test('gt 6: 表が無い・見出しが違うときの確定は G を変えない（TABLES_MISSING）', () => {
    function run(taxTabs) {
      const world = confirmationWorld({rows: GT_CONFIRM_ROWS.slice(0, 1), taxTabs: taxTabs});
      const review = partnerReviews('fileA')[0];
      const tx = call('getTransaction', [review.fullTxId]);
      // 取込では表が無いので G に入らない。手で入れた値（転記先と取引ログ
      // 46 列の予定値）が確定で消えないことを見る。
      master('クレカ取引ログ').getRange(tx._rowNumber, 46).setValue('課対仕入10%');
      destSheet().getRange(5, 7).setValue('課対仕入10%');
      const captured = captureTaxWrites(() => call('resolveReview',
        [review.reviewId, 'ADOPT_EXISTING_PARTNER',
          {partnerName: '架空フリマ取引先', learn: false}]));
      return {rows: captured.rows, value: cell(5, 7)};
    }
    const noTab = run(undefined);
    const wrongHeader = run({headers: {
      marks: ['取引先名', '印', '顧客ID', '有効', '登録日時', '登録者', 'メモ ']}});
    assert.deepEqual(noTab, {rows: [], value: '課対仕入10%'});
    assert.deepEqual(wrongHeader, {rows: [], value: '課対仕入10%'});
  });

  // ---------------- gt 7: まとめて確定 ----------------

  test('gt 7: まとめて確定で複数件・複数の転記先の G を決め直し、変わる件だけ書く', () => {
    const world = confirmationWorld();
    addDestination('dest2');
    const reviews = partnerReviews('fileA');
    assert.equal(reviews.length, 4);
    // 3・4 件目だけ別の転記先へ向ける（M・N 列）。
    const reviewSheet = master('要確認');
    [reviews[2], reviews[3]].forEach((review) => {
      reviewSheet.getRange(review._rowNumber, 13, 1, 2)
        .setValues([['dest2', '入力用シート']]);
    });
    // 転記先を移した行の今の G（取込で入っていた 10%）。変わらない件が
    // 触られないことを見るため、同じ値を置いておく。
    [7, 8].forEach((row) => destSheet('dest2').getRange(row, 7)
      .setValue('課対仕入10%'));

    const captured = captureTaxWrites(() => call('resolvePartnerReviewsBatch',
      ['C001', 'fileA', [
        adoptionDecision(reviews[0], '架空フリマ取引先'),
        adoptionDecision(reviews[1], '架空店舗取引先'),
        adoptionDecision(reviews[2], '架空フリマ取引先'),
        adoptionDecision(reviews[3], '架空フリマ取引先')
      ], {actor: 'tester@example.com'}]));
    assert.deepEqual(plain(captured.result.errors), []);
    assert.equal(captured.result.resolvedReviewIds.length, 4);

    // 1 つ目の転記先: 変わる件（1 万円以上）だけ書き、印なしは触らない。
    assert.equal(cell(5, 7, 'dest1'), '課対仕入（控70）10%');
    assert.equal(cell(6, 7, 'dest1'), '課対仕入10%');
    // 2 つ目の転記先: 1 万円未満は少額特例で今と同じ（触らない）、
    // 1 万円以上は経過措置に変わる。
    assert.equal(cell(7, 7, 'dest2'), '課対仕入10%');
    assert.equal(cell(8, 7, 'dest2'), '課対仕入（控70）10%');

    // G の書込要求は、変わった 2 件の行だけ（印なし・少額の行には無い）。
    assert.deepEqual(captured.rows, [5, 8]);

    const first = call('getTransaction', [reviews[0].fullTxId]);
    assert.equal(first.planned.g, '課対仕入（控70）10%');
    assert.equal(first.verified.g, '課対仕入（控70）10%');
    const second = call('getTransaction', [reviews[1].fullTxId]);
    assert.equal(second.planned.g, '課対仕入10%');
    const third = call('getTransaction', [reviews[2].fullTxId]);
    assert.equal(third.planned.g, '課対仕入10%');
    const fourth = call('getTransaction', [reviews[3].fullTxId]);
    assert.equal(fourth.planned.g, '課対仕入（控70）10%');
    assert.equal(fourth.verified.g, '課対仕入（控70）10%');
    // §10.12: まとめて確定でも値をログと監査に出さない。
    assertNoTaxValues(['仕入', '架空未登録D', '15000', '架空フリマ取引先',
      '課対仕入（控70）10%']);
  });

  test('gt 7: 55 は options.taxTables を渡しても G が AL にある顧客の G を書かず、F は書く', () => {
    const world = confirmationWorld({rows: GT_CONFIRM_ROWS.slice(0, 1),
      excludedColumns: [7]});
    const review = partnerReviews('fileA')[0];
    // `options.taxTables` を渡すと、表を読むかの判定を通らずに件ごとの
    // 決め直しへ進む。G が AL にある顧客なので、G には触らない。
    const captured = captureTaxWrites(() => call('resolvePartnerReviewsBatch',
      ['C001', 'fileA', [adoptionDecision(review, '架空フリマ取引先')],
        {actor: 'tester@example.com', taxTables: tables(GT_MARKS)}]));
    const result = plain(captured.result);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.resolvedReviewIds, [review.reviewId]);
    assert.deepEqual(captured.rows, [], 'G の書込の要求が無い');
    assert.equal(cell(5, 6), '架空フリマ取引先');
    assert.equal(cell(5, 7), '');
  });

  // ---------------- gt 4: 55 の表を読むかの判定 ----------------

  test('gt 4: 55 は最初の ADOPT の要確認が無くても、ほかの件の G を決め直す', () => {
    const world = confirmationWorld({rows: GT_CONFIRM_ROWS.slice(0, 1)});
    const review = partnerReviews('fileA')[0];
    // 1 件目は取引先の表を読むかの判定にだけ使われ、要確認が無い。まとめの
    // 顧客で判定するので、2 件目の正しい件は決め直される。
    const captured = captureTaxWrites(() => call('resolvePartnerReviewsBatch',
      ['C001', 'fileA', [
        {reviewId: 'RV_GT_MISSING', operation: 'ADOPT_EXISTING_PARTNER',
          partnerName: '架空フリマ取引先', learn: false},
        adoptionDecision(review, '架空フリマ取引先')],
        {actor: 'tester@example.com'}]));
    const result = plain(captured.result);
    assert.deepEqual(result.errors.map((entry) => [entry.reviewId, entry.code]),
      [['RV_GT_MISSING', 'REVIEW_NOT_FOUND']]);
    assert.deepEqual(result.resolvedReviewIds, [review.reviewId]);
    assert.deepEqual(captured.rows, [5]);
    assert.equal(cell(5, 7), '課対仕入（控70）10%');
  });

  // ---------------- gt 8: 日付・金額の修正 ----------------

  test('gt 8: 日付・金額の修正で G を決め直す（G が入る・控70 から 10% へ）', () => {
    // 日付: 読めない利用日で G が決まらなかった行に、日付を入れる。
    const dateWorld = setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [[712, '仕入高']],
      dictionary: [['架空店舗', '架空店舗取引先']], words: [{word: '仕入', code: 712}],
      taxTabs: {marks: GT_MARKS}});
    dateWorld.addFile('fileA', ['日付不明,架空店舗,3000,仕入']);
    importReport(dateWorld);
    const dateReview = typedReviews('fileA', 'DATE')[0];
    assert.ok(dateReview, JSON.stringify(plain(call('openReviews', [{}]))));
    assert.equal(cell(5, 7), '', '日付が読めない間は G を決めない');
    const dateFixed = captureTaxWrites(() => call('resolveReview',
      [dateReview.reviewId, 'FIX_DATE_AMOUNT', {correctedDate: '2026/10/15'}]));
    assert.deepEqual(dateFixed.rows, [5]);
    assert.equal(cell(5, 7), '課対仕入10%');
    const dateTx = call('getTransaction', [dateReview.fullTxId]);
    assert.equal(dateTx.planned.g, '課対仕入10%');
    assert.equal(dateTx.verified.g, '課対仕入10%');

    // 金額: フリマの印で 12,000 円（控70）だった行を 8,000 円に直す。
    // 金額が読めない取引だけが AMOUNT 要確認になるので、取込の後で
    // 「直す前は 12,000 円で G は控70」という状態を取引ログに置く。
    const amountWorld = setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [[712, '仕入高']],
      dictionary: [['架空フリマ', '架空フリマ取引先']], words: [{word: '仕入', code: 712}],
      taxTabs: {marks: GT_MARKS}});
    amountWorld.addFile('fileA', ['2026/10/11,架空フリマ,金額不明,仕入']);
    importReport(amountWorld);
    const amountReview = typedReviews('fileA', 'AMOUNT')[0];
    assert.ok(amountReview, JSON.stringify(plain(call('openReviews', [{}]))));
    const amountTx = call('getTransaction', [amountReview.fullTxId]);
    const log = master('クレカ取引ログ');
    log.getRange(amountTx._rowNumber, 23).setValue(12000);
    log.getRange(amountTx._rowNumber, 46).setValue('課対仕入（控70）10%');

    const amountFixed = captureTaxWrites(() => call('resolveReview',
      [amountReview.reviewId, 'FIX_DATE_AMOUNT', {correctedAmount: 8000}]));
    assert.deepEqual(amountFixed.rows, [amountTx.destinationRow]);
    assert.equal(cell(amountTx.destinationRow, 7), '課対仕入10%');
    const after = call('getTransaction', [amountReview.fullTxId]);
    assert.equal(after.planned.m, 8000);
    assert.equal(after.planned.g, '課対仕入10%');
    assert.equal(after.verified.g, '課対仕入10%');
    // §10.12: 日付・金額の修正でも値をログと監査に出さない。
    assertNoTaxValues(['仕入', '日付不明', '架空店舗', '金額不明', '架空フリマ', '3000',
      '12000', '課対仕入10%']);
  });

  // ---------------- gt 15: 利用日がシリアル値（確定の道） ----------------

  const SERIAL_2026_10_11 = 46306;

  /** 取引ログの S 列（19。B 列予定値）に、本番の `setValues` が作る数（シリアル値）を置く。 */
  function putPlannedDateSerial(fullTxId, serial) {
    const tx = call('getTransaction', [fullTxId]);
    master('クレカ取引ログ').getRange(tx._rowNumber, 19).setValue(serial);
    return tx;
  }

  test('gt 15: 1 件の確定で S がシリアル値でも G を決め直す（46306 は 2026-10-11）', () => {
    const world = confirmationWorld({rows: GT_CONFIRM_ROWS.slice(0, 1)});
    const review = partnerReviews('fileA')[0];
    putPlannedDateSerial(review.fullTxId, SERIAL_2026_10_11);
    const captured = captureTaxWrites(() => call('resolveReview',
      [review.reviewId, 'ADOPT_EXISTING_PARTNER',
        {partnerName: '架空フリマ取引先', learn: false}]));
    assert.deepEqual(captured.rows, [5]);
    assert.equal(cell(5, 7), '課対仕入（控70）10%');
    const after = call('getTransaction', [review.fullTxId]);
    assert.equal(after.planned.g, '課対仕入（控70）10%');
    assert.equal(after.verified.g, '課対仕入（控70）10%');
  });

  test('gt 15: まとめて確定で S がシリアル値でも G を決め直す', () => {
    const world = confirmationWorld({rows: GT_CONFIRM_ROWS.slice(0, 2)});
    const reviews = partnerReviews('fileA');
    reviews.forEach((review) => putPlannedDateSerial(review.fullTxId, SERIAL_2026_10_11));
    const captured = captureTaxWrites(() => call('resolvePartnerReviewsBatch',
      ['C001', 'fileA', reviews.map((review) =>
        adoptionDecision(review, '架空フリマ取引先')),
        {actor: 'tester@example.com'}]));
    assert.deepEqual(plain(captured.result.errors), []);
    assert.equal(captured.result.resolvedReviewIds.length, 2);
    // 1 万円以上は控70 に変わり、1 万円未満は今と同じで書かない。
    assert.deepEqual(captured.rows, [5]);
    assert.equal(cell(5, 7), '課対仕入（控70）10%');
    assert.equal(cell(6, 7), '課対仕入10%');
  });

  test('gt 15: 画面のまとめて確定（80）でも S がシリアル値で G を決め直す', () => {
    const world = confirmationWorld({rows: GT_CONFIRM_ROWS.slice(0, 1)});
    const reviews = partnerReviews('fileA');
    putPlannedDateSerial(reviews[0].fullTxId, SERIAL_2026_10_11);
    const captured = captureTaxWrites(() => call('webAppResolveReviews',
      ['C001', [{reviewId: reviews[0].reviewId, partnerName: '架空フリマ取引先'}],
        {batchId: 'gt15'}]));
    assert.deepEqual(plain(captured.result.errors), []);
    assert.equal(captured.result.resolved, 1, '確定を空振りしない');
    assert.deepEqual(captured.rows, [5]);
    assert.equal(cell(5, 7), '課対仕入（控70）10%');
  });

  test('gt 15: 金額だけの修正で S がシリアル値でも G を消さない', () => {
    const world = setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [[712, '仕入高']],
      dictionary: [['架空フリマ', '架空フリマ取引先']], words: [{word: '仕入', code: 712}],
      taxTabs: {marks: GT_MARKS}});
    world.addFile('fileA', ['2026/10/11,架空フリマ,金額不明,仕入']);
    importReport(world);
    const review = typedReviews('fileA', 'AMOUNT')[0];
    assert.ok(review, JSON.stringify(plain(call('openReviews', [{}]))));
    const tx = call('getTransaction', [review.fullTxId]);
    // 金額だけを直す前の状態（12,000 円のフリマ → 控70）を取引ログと行に置く。
    const log = master('クレカ取引ログ');
    log.getRange(tx._rowNumber, 19).setValue(SERIAL_2026_10_11);
    log.getRange(tx._rowNumber, 23).setValue(12000);
    log.getRange(tx._rowNumber, 46).setValue('課対仕入（控70）10%');
    destSheet().getRange(tx.destinationRow, 7).setValue('課対仕入（控70）10%');
    const captured = captureTaxWrites(() => call('resolveReview',
      [review.reviewId, 'FIX_DATE_AMOUNT', {correctedAmount: 12000}]));
    assert.deepEqual(captured.rows, [], '変わらないので G の書込は無い');
    assert.equal(cell(tx.destinationRow, 7), '課対仕入（控70）10%');
    const after = call('getTransaction', [review.fullTxId]);
    assert.equal(after.planned.g, '課対仕入（控70）10%');
  });

  // ---------------- gt 16: 画面のまとめて確定（80）の G の値 ----------------

  test('gt 16: 80 の道で G の値（控70・変わらない件・印の誤り）と取引ログ 46・47 を確かめる', () => {
    const world = confirmationWorld({rows: GT_CONFIRM_ROWS.slice(0, 3)});
    const reviews = partnerReviews('fileA');
    assert.equal(reviews.length, 3);
    const captured = captureTaxWrites(() => call('webAppResolveReviews',
      ['C001', [
        {reviewId: reviews[0].reviewId, partnerName: '架空フリマ取引先'},
        {reviewId: reviews[1].reviewId, partnerName: '架空店舗取引先'},
        {reviewId: reviews[2].reviewId, partnerName: '架空印誤り取引先'}
      ], {batchId: 'gt16'}]));
    const outcome = plain(captured.result);
    assert.deepEqual(outcome.errors, []);
    assert.equal(outcome.resolved, 3, '確定を空振りしない');
    assert.equal(outcome.resolvedReviewIds.length, 3);

    // G の値: フリマの 1 万円以上は控70、印なしは 10% のまま、
    // 印が誤りの件は空。書き換える 2 件の行だけ G を書く。
    assert.equal(cell(5, 7), '課対仕入（控70）10%');
    assert.equal(cell(6, 7), '課対仕入10%');
    assert.equal(cell(7, 7), '');
    assert.deepEqual(captured.rows, [5, 7]);

    // 取引ログ 46・47 列（予定値・読取確認値）も新しい値。
    const log = master('クレカ取引ログ');
    const gCells = reviews.map((review) => {
      const tx = call('getTransaction', [review.fullTxId]);
      return [log.getRange(tx._rowNumber, 46).getValue(),
        log.getRange(tx._rowNumber, 47).getValue()];
    });
    assert.deepEqual(gCells, [
      ['課対仕入（控70）10%', '課対仕入（控70）10%'],
      ['課対仕入10%', '課対仕入10%'],
      ['', '']
    ]);
  });

  // ---------------- gt 13: 回数（確定・日付金額の修正） ----------------

  test('gt 13: 1 件の確定の読取は今と同じ（§2.3 の顧客でも往復を増やさない）', () => {
    function run(configured) {
      const world = confirmationWorld({
        rows: GT_CONFIRM_ROWS.slice(0, 1),
        gColumn: configured,
        taxTabs: configured ? {marks: GT_MARKS} : undefined
      });
      const review = partnerReviews('fileA')[0];
      return measured(() => call('resolveReview',
        [review.reviewId, 'ADOPT_EXISTING_PARTNER',
          {partnerName: '架空フリマ取引先', learn: false}]));
    }
    const withTax = run(true);
    const withoutTax = run(false);
    assert.equal(withTax.batchGet, withoutTax.batchGet, JSON.stringify([withTax, withoutTax]));
    assert.equal(withTax.reads, withoutTax.reads);
  });

  test('gt 13: まとめて確定の読取は今と同じ（部品 55 と 80 の道の両方）', () => {
    function direct(configured) {
      const world = confirmationWorld({
        rows: GT_CONFIRM_ROWS.slice(0, 2),
        gColumn: configured,
        taxTabs: configured ? {marks: GT_MARKS} : undefined
      });
      const reviews = partnerReviews('fileA');
      return measured(() => call('resolvePartnerReviewsBatch',
        ['C001', 'fileA', reviews.map((review) => adoptionDecision(review, '架空フリマ取引先')),
          {actor: 'tester@example.com'}]));
    }
    function web(configured) {
      const world = confirmationWorld({
        rows: GT_CONFIRM_ROWS.slice(0, 2),
        gColumn: configured,
        taxTabs: configured ? {marks: GT_MARKS} : undefined
      });
      const reviews = partnerReviews('fileA');
      return measured(() => call('webAppResolveReviews',
        ['C001', reviews.map((review) => ({reviewId: review.reviewId,
          partnerName: '架空フリマ取引先'})), {batchId: 'gt13'}]));
    }
    const directWith = direct(true);
    const directWithout = direct(false);
    assert.equal(directWith.batchGet, directWithout.batchGet,
      JSON.stringify([directWith, directWithout]));
    assert.equal(directWith.reads, directWithout.reads);
    const webWith = web(true);
    const webWithout = web(false);
    assert.equal(webWith.batchGet, webWithout.batchGet,
      JSON.stringify([webWith, webWithout]));
    assert.equal(webWith.reads, webWithout.reads);

    // 部品 55 に取引先の表を全部渡し、税の表だけ渡さない道は、税の表を
    // 直接 1 回読む（+1。§6.2）。値はその 1 回で決まる。
    function directWithOptions(configured) {
      const world = confirmationWorld({
        rows: GT_CONFIRM_ROWS.slice(0, 1),
        gColumn: configured,
        taxTabs: configured ? {marks: GT_MARKS} : undefined
      });
      const review = partnerReviews('fileA')[0];
      return measured(() => call('resolvePartnerReviewsBatch',
        ['C001', 'fileA', [adoptionDecision(review, '架空フリマ取引先')],
          {actor: 'tester@example.com', partnerListRows: [], commonPartnerRows: [],
            commonDictionaryRows: []}]));
    }
    const optionsWith = directWithOptions(true);
    assert.equal(cell(5, 7), '課対仕入（控70）10%', '直接読んだ表で G を決める');
    const optionsWithout = directWithOptions(false);
    assert.equal(optionsWith.batchGet, optionsWithout.batchGet + 1,
      JSON.stringify([optionsWith, optionsWithout]));
    assert.equal(optionsWith.reads, optionsWithout.reads + 1);
  });

  test('gt 13: 日付・金額の修正の読取は §2.3 の顧客だけ +1、§2.3 でない顧客は今と同じ', () => {
    function dateFix(options) {
      const world = setupWorld(Object.assign({accounts: GT_ACCOUNTS,
        sheetEntries: [[712, '仕入高']], dictionary: [['架空店舗', '架空店舗取引先']],
        words: [{word: '仕入', code: 712}]}, options));
      world.addFile('fileA', ['日付不明,架空店舗,3000,仕入']);
      importReport(world);
      const review = typedReviews('fileA', 'DATE')[0];
      return measured(() => call('resolveReview',
        [review.reviewId, 'FIX_DATE_AMOUNT', {correctedDate: '2026/10/15'}]));
    }
    const withTables = dateFix({taxTabs: {marks: GT_MARKS}});
    const withoutTables = dateFix({taxTabs: undefined});
    const notConfigured = dateFix({gColumn: false, taxTabs: undefined});
    // §2.3 でない顧客は、タブがあっても表を見ない・読まない（今と同じ）。
    const notConfiguredWithTables = dateFix({gColumn: false, taxTabs: {marks: GT_MARKS}});
    assert.equal(withTables.batchGet, notConfigured.batchGet + 1,
      JSON.stringify([withTables, notConfigured]));
    assert.equal(withTables.reads, notConfigured.reads + 1);
    // タブが無ければ読まない（今と同じ）。
    assert.equal(withoutTables.batchGet, notConfigured.batchGet,
      JSON.stringify([withoutTables, notConfigured]));
    assert.equal(withoutTables.reads, notConfigured.reads);
    assert.equal(notConfiguredWithTables.batchGet, notConfigured.batchGet,
      JSON.stringify([notConfiguredWithTables, notConfigured]));
    assert.equal(notConfiguredWithTables.reads, notConfigured.reads);

    function amountFix(options) {
      const world = setupWorld(Object.assign({accounts: GT_ACCOUNTS,
        sheetEntries: [[712, '仕入高']], dictionary: [['架空フリマ', '架空フリマ取引先']],
        words: [{word: '仕入', code: 712}]}, options));
      world.addFile('fileA', ['2026/10/11,架空フリマ,金額不明,仕入']);
      importReport(world);
      const review = typedReviews('fileA', 'AMOUNT')[0];
      return measured(() => call('resolveReview',
        [review.reviewId, 'FIX_DATE_AMOUNT', {correctedAmount: 8000}]));
    }
    const amountWith = amountFix({taxTabs: {marks: GT_MARKS}});
    const amountWithout = amountFix({gColumn: false, taxTabs: undefined});
    const amountNotConfiguredWithTables = amountFix({gColumn: false, taxTabs: {marks: GT_MARKS}});
    assert.equal(amountWith.batchGet, amountWithout.batchGet + 1,
      JSON.stringify([amountWith, amountWithout]));
    assert.equal(amountWith.reads, amountWithout.reads + 1);
    assert.equal(amountNotConfiguredWithTables.batchGet, amountWithout.batchGet,
      JSON.stringify([amountNotConfiguredWithTables, amountWithout]));
    assert.equal(amountNotConfiguredWithTables.reads, amountWithout.reads);
  });

  // ================================================================
  // 4 回目：運用関数（gt 12・§9.1〜9.5）。値はすべて架空である。
  // ================================================================

  const TAX_MARK_SHEET = '取引先の税の印';
  const TAX_FLAG_SHEET = '顧客の税の設定';

  function auditLastRow() { return master('監査ログ').getLastRow(); }

  function auditLast() {
    const row = auditLastRow();
    return {
      type: master('監査ログ').getRange(row, 3).getValue(),
      targetType: master('監査ログ').getRange(row, 7).getValue(),
      targetId: master('監査ログ').getRange(row, 8).getValue(),
      before: master('監査ログ').getRange(row, 10).getValue(),
      after: master('監査ログ').getRange(row, 11).getValue(),
      reason: master('監査ログ').getRange(row, 12).getValue()
    };
  }

  function sheetValues(name) {
    const sheet = master(name);
    if (!sheet) return [];
    const last = sheet.getLastRow();
    if (!last) return [];
    const width = Math.max(sheet.getLastColumn(), 7);
    return sheet.getRange(1, 1, last, width).getValues();
  }

  function buildValidation(values, allowInvalid) {
    return evaluate('SpreadsheetApp.newDataValidation()')
      .requireValueInList(values, true)
      .setAllowInvalid(Boolean(allowInvalid))
      .build();
  }

  function writeLogIndex(sheetName, from = 0) {
    return gas.stubs.getWriteLog().findIndex((item, index) =>
      index >= from && item.sheetName === sheetName);
  }

  /** 税の 2 つの表がある世界（印・設定の中身は呼ぶ側が決める）。 */
  function taxOpsWorld(marks, flags) {
    const world = setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [],
      taxTabs: {marks: marks || [], flags: flags || []}});
    master('共通取引先一覧').appendRow(['PTN_9101', '架空フリマ共通', '', '', '', 1]);
    return world;
  }

  // ---------------- gt 12: §9.1 ----------------

  test('gt 12: §9.1 見るだけは何も作らず、apply は監査→見出しの順で 2 つのタブを作る', () => {
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: []});
    const beforeAudit = auditLastRow();
    gas.stubs.resetWriteLog();

    const seen = plain(call('opsSetupTaxCategoryTables', []));
    assert.equal(seen.applied, false);
    assert.equal(seen.stoppedBy, null);
    assert.equal(seen.action, 'CREATE');
    assert.equal(seen.tables.marks.status, 'MISSING');
    assert.equal(seen.tables.flags.status, 'MISSING');
    assert.equal(master(TAX_MARK_SHEET), null, '見るだけはタブを作らない');
    assert.equal(master(TAX_FLAG_SHEET), null);
    assert.deepEqual(gas.stubs.getWriteLog(), []);
    assert.equal(auditLastRow(), beforeAudit);

    gas.stubs.resetWriteLog();
    const applied = plain(call('opsSetupTaxCategoryTables', [true]));
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.equal(applied.stoppedBy, null);
    assert.equal(applied.verified, true);
    assert.deepEqual(applied.written, {marks: true, flags: true});
    assert.equal(applied.tables.marks.status, 'OK');
    assert.equal(applied.tables.flags.status, 'OK');

    assert.deepEqual(sheetValues(TAX_MARK_SHEET)[0].slice(0, 7), MARK_HEADERS);
    assert.deepEqual(sheetValues(TAX_FLAG_SHEET)[0].slice(0, 5), FLAG_HEADERS);
    assert.equal(master(TAX_MARK_SHEET).getLastRow(), 1, '中身の行は書かない');
    assert.equal(master(TAX_FLAG_SHEET).getLastRow(), 1);

    // 監査が先。タブの見出しはその後。
    const log = gas.stubs.getWriteLog();
    const auditIndex = log.findIndex((item) => item.sheetName === '監査ログ');
    const marksIndex = log.findIndex((item) => item.sheetName === TAX_MARK_SHEET);
    const flagsIndex = log.findIndex((item) => item.sheetName === TAX_FLAG_SHEET);
    assert.ok(auditIndex >= 0 && marksIndex > auditIndex && flagsIndex > auditIndex,
      JSON.stringify(log));
    const audit = auditLast();
    assert.equal(audit.type, 'SETTING');
    assert.equal(audit.targetType, 'SETTING');
    assert.equal(audit.targetId, 'TAX_TABLES');
    assert.equal(audit.reason, 'TAX_TABLES_SETUP');

    // 2 回目は何も書かない。
    const auditCount = auditLastRow();
    gas.stubs.resetWriteLog();
    const again = plain(call('opsSetupTaxCategoryTables', [true]));
    assert.equal(again.action, 'ALREADY_SET');
    assert.equal(again.applied, false);
    assert.equal(again.stoppedBy, null);
    assert.deepEqual(gas.stubs.getWriteLog(), []);
    assert.equal(auditLastRow(), auditCount);
  });

  test('gt 12: §9.1 あるタブは触らず、見出しが違えば止めて何もしない', () => {
    // 正しい見出しのタブは、中身ごとそのまま残す。
    setupMaster();
    const spreadsheet = gas.stubs.getSpreadsheet('master');
    spreadsheet.insertSheet(TAX_MARK_SHEET, {values: [
      MARK_HEADERS.slice(), markRow('架空既存取引先', 'フリマ')]});
    const seen = plain(call('opsSetupTaxCategoryTables', []));
    assert.equal(seen.tables.marks.status, 'OK');
    assert.equal(seen.tables.marks.dataRows, 1);
    assert.equal(seen.tables.flags.status, 'MISSING');

    const applied = plain(call('opsSetupTaxCategoryTables', [true]));
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.deepEqual(applied.willWrite, {marks: false, flags: true});
    assert.equal(master(TAX_MARK_SHEET).getLastRow(), 2, 'あるタブの中身は触らない');
    assert.deepEqual(sheetValues(TAX_MARK_SHEET)[1].slice(0, 2), ['架空既存取引先', 'フリマ']);

    // 中身があるのに見出しが違えば、監査も書かず、ほかのタブも作らない。
    setupMaster();
    const spreadsheet2 = gas.stubs.getSpreadsheet('master');
    spreadsheet2.insertSheet(TAX_MARK_SHEET, {values: [
      ['取引先名', '印', '顧客ID', '有効', '登録日時', '登録者', 'メモ '],
      markRow('架空既存取引先', 'フリマ')]});
    const beforeAudit = auditLastRow();
    const mismatch = plain(call('opsSetupTaxCategoryTables', []));
    assert.equal(mismatch.tables.marks.status, 'HEADER_MISMATCH');
    assert.equal(mismatch.stoppedBy, 'HEADER_MISMATCH');
    gas.stubs.resetWriteLog();
    const stopped = plain(call('opsSetupTaxCategoryTables', [true]));
    assert.equal(stopped.applied, false);
    assert.equal(stopped.stoppedBy, 'HEADER_MISMATCH');
    assert.equal(master(TAX_FLAG_SHEET), null, '止めるときは何もしない');
    assert.equal(auditLastRow(), beforeAudit);
    assert.deepEqual(gas.stubs.getWriteLog(), []);
  });

  test('gt 12: §9.1 中身が全部空のタブは見出しを書き（HEADER_MISMATCH にしない）', () => {
    setupMaster();
    const spreadsheet = gas.stubs.getSpreadsheet('master');
    spreadsheet.insertSheet(TAX_MARK_SHEET);
    spreadsheet.insertSheet(TAX_FLAG_SHEET);
    const seen = plain(call('opsSetupTaxCategoryTables', []));
    assert.equal(seen.tables.marks.status, 'EMPTY');
    assert.equal(seen.tables.flags.status, 'EMPTY');
    assert.equal(seen.stoppedBy, null);

    const applied = plain(call('opsSetupTaxCategoryTables', [true]));
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.deepEqual(applied.written, {marks: true, flags: true});
    assert.deepEqual(sheetValues(TAX_MARK_SHEET)[0].slice(0, 7), MARK_HEADERS);
    assert.deepEqual(sheetValues(TAX_FLAG_SHEET)[0].slice(0, 5), FLAG_HEADERS);
    assert.equal(master(TAX_MARK_SHEET).getLastRow(), 1);
  });

  test('gt 12: §9.1 見るだけは誤りの行を行番号と理由で返す', () => {
    setupMaster();
    const spreadsheet = gas.stubs.getSpreadsheet('master');
    spreadsheet.insertSheet(TAX_MARK_SHEET, {values: [
      MARK_HEADERS.slice(),
      markRow('', 'フリマ'),
      markRow('架空印誤り', '○'),
      markRow('架空有効誤り', 'なし', '', '○'),
      markRow('架空正常', '海外の物')
    ]});
    spreadsheet.insertSheet(TAX_FLAG_SHEET, {values: [
      FLAG_HEADERS.slice(),
      flagRow('C9001', '○'),
      flagRow('', true)
    ]});
    const report = plain(call('opsSetupTaxCategoryTables', []));
    assert.equal(report.tables.marks.dataRows, 4);
    assert.deepEqual(report.tables.marks.problems, [
      {row: 2, reasons: ['PARTNER_NAME_EMPTY']},
      {row: 3, reasons: ['MARK_INVALID']},
      {row: 4, reasons: ['ACTIVE_INVALID']}
    ]);
    assert.deepEqual(report.tables.flags.problems, [
      {row: 2, reasons: ['FLAG_INVALID']},
      {row: 3, reasons: ['CUSTOMER_ID_EMPTY']}
    ]);
  });

  // ---------------- gt 12: §9.2 ----------------

  test('gt 12: §9.2 鍵を含む取引先名を一覧の順で返し、書かない（最大 50）', () => {
    setupMaster();
    const common = master('共通取引先一覧');
    common.appendRow(['PTN_9001', '架空フリマ共通', '', '', '', 1]);
    common.appendRow(['PTN_9002', '架空一般ストア', '', '', '', 1]);
    const list = master('顧客別取引先一覧');
    list.appendRow(['PTN_9003', 'K9001', '架空フリマ東京', 'ACTIVE', '', '', '', '', '', '']);
    list.appendRow(['PTN_9004', 'K9002', '架空フリマ大阪', 'RETIRED', '架空フリマ大阪2',
      '', '', '', '', '']);
    gas.stubs.resetWriteLog();
    const beforeAudit = auditLastRow();

    const report = plain(call('opsFindPartnerNames', ['フリマ']));
    assert.equal(report.applied, false);
    assert.equal(report.stoppedBy, null);
    assert.equal(report.truncated, false);
    assert.deepEqual(report.matches, [
      {name: '架空フリマ共通', scope: 'COMMON', status: 'ACTIVE'},
      {name: '架空フリマ東京', scope: 'K9001', status: 'ACTIVE'},
      {name: '架空フリマ大阪', scope: 'K9002', status: 'RETIRED'}
    ]);
    assert.deepEqual(gas.stubs.getWriteLog(), [], '見るだけは書かない');
    assert.equal(auditLastRow(), beforeAudit);

    assert.equal(plain(call('opsFindPartnerNames', ['  '])).stoppedBy, 'WORD_REQUIRED');

    // 名前の鍵の揺れ（全角・半角）でも当たる。
    common.appendRow(['PTN_9005', 'ABCストア', '', '', '', 1]);
    const shifted = plain(call('opsFindPartnerNames', ['ＡＢＣ']));
    assert.deepEqual(shifted.matches.map((match) => match.name), ['ABCストア']);
  });

  test('gt 12: §9.2 50 を超えたら 50 件と truncated を返す', () => {
    setupMaster();
    const common = master('共通取引先一覧');
    for (let index = 1; index <= 60; index += 1) {
      common.appendRow(['PTN_95' + String(index).padStart(2, '0'),
        '架空大量ストア' + String(index).padStart(2, '0'), '', '', '', 1]);
    }
    const report = plain(call('opsFindPartnerNames', ['架空大量']));
    assert.equal(report.matches.length, 50);
    assert.equal(report.truncated, true);
    assert.equal(report.matches[0].name, '架空大量ストア01');
    assert.equal(report.matches[49].name, '架空大量ストア50');
  });

  // ---------------- gt 12: §9.3 ----------------

  test('gt 12: §9.3 見るだけは書かず、apply は監査→行の順で足し、読み返して確かめる', () => {
    taxOpsWorld([], []);
    const beforeAudit = auditLastRow();
    gas.stubs.resetWriteLog();

    const seen = plain(call('opsSetPartnerTaxMark', ['架空フリマ共通', 'フリマ', '']));
    assert.equal(seen.applied, false);
    assert.equal(seen.stoppedBy, null);
    assert.equal(seen.classification.kind, 'KNOWN');
    assert.equal(seen.scope, 'COMMON');
    assert.equal(seen.action, 'CREATE');
    assert.equal(seen.candidates, 0);
    assert.deepEqual(gas.stubs.getWriteLog(), [], '見るだけは書かない');
    assert.equal(auditLastRow(), beforeAudit);

    gas.stubs.resetWriteLog();
    const applied = plain(call('opsSetPartnerTaxMark', ['架空フリマ共通', 'フリマ', '', true]));
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.equal(applied.verified, true);
    assert.equal(applied.stoppedBy, null);
    const rows = sheetValues(TAX_MARK_SHEET);
    assert.equal(rows.length, 2);
    assert.equal(rows[1][0], '架空フリマ共通');
    assert.equal(rows[1][1], 'フリマ');
    assert.equal(rows[1][2], '');
    assert.equal(rows[1][3], true);
    assert.ok(rows[1][4], '登録日時');
    assert.equal(rows[1][5], 'tester@example.com');
    assert.equal(rows[1][6], '');

    let log = gas.stubs.getWriteLog();
    let auditIndex = log.findIndex((item) => item.sheetName === '監査ログ');
    let markIndex = log.findIndex((item) => item.sheetName === TAX_MARK_SHEET);
    assert.ok(auditIndex >= 0 && markIndex > auditIndex, JSON.stringify(log));
    const added = auditLast();
    assert.equal(added.type, 'SETTING');
    assert.equal(added.targetType, 'PARTNER');
    assert.equal(added.targetId, '架空フリマ共通');
    assert.equal(added.reason, 'TAX_PARTNER_MARK');

    // 同じ鍵・同じ顧客の行があるので、B・E・F だけ書き直す（C・D はそのまま）。
    master(TAX_MARK_SHEET).getRange(2, 7).setValue('架空メモ');
    gas.stubs.resetWriteLog();
    const updated = plain(call('opsSetPartnerTaxMark', ['架空フリマ共通', 'なし', '', true]));
    assert.equal(updated.action, 'UPDATE');
    assert.equal(updated.applied, true, JSON.stringify(updated));
    assert.equal(updated.before.mark, 'フリマ');
    const after = sheetValues(TAX_MARK_SHEET);
    assert.equal(after.length, 2, '行を増やさない');
    assert.equal(after[1][1], 'なし');
    assert.equal(after[1][2], '');
    assert.equal(after[1][3], true);
    assert.equal(after[1][6], '架空メモ', 'メモは触らない');
    log = gas.stubs.getWriteLog();
    auditIndex = log.findIndex((item) => item.sheetName === '監査ログ');
    markIndex = log.findIndex((item) => item.sheetName === TAX_MARK_SHEET);
    assert.ok(auditIndex >= 0 && markIndex > auditIndex, JSON.stringify(log));
    const change = auditLast();
    assert.ok(String(change.before).indexOf('架空メモ') < 0, '監査にメモを出さない');
    assert.ok(String(change.after).indexOf('架空メモ') < 0);
  });

  test('gt 12: §9.3 顧客別の名前・共通の印から顧客別の名前を KNOWN にする', () => {
    taxOpsWorld([], []);
    const list = master('顧客別取引先一覧');
    list.appendRow(['PTN_9201', 'C001', '架空フリマ東京', 'ACTIVE', '', '', '', '', '', '']);
    list.appendRow(['PTN_9202', 'C002', '架空フリマ大阪', 'RETIRED', '架空フリマ大阪2',
      '', '', '', '', '']);
    const common = master('共通取引先一覧');
    common.appendRow(['PTN_9203', 'ABCストア', '', '', '', 1]);

    // 顧客 ID があるとき：その顧客の一覧と共通一覧で分類する。
    const own = plain(call('opsSetPartnerTaxMark', ['架空フリマ東京', 'フリマ', 'C001']));
    assert.equal(own.classification.kind, 'KNOWN');
    assert.equal(own.stoppedBy, null);
    assert.equal(own.action, 'CREATE');

    // 顧客 ID が空：共通一覧に無ければ、顧客別の有効な同じ名前を KNOWN にする。
    const viaCustomer = plain(call('opsSetPartnerTaxMark', ['架空フリマ東京', 'フリマ', '']));
    assert.equal(viaCustomer.classification.kind, 'KNOWN');
    assert.equal(viaCustomer.knownCustomerId, 'C001');
    assert.equal(viaCustomer.stoppedBy, null);

    // 表記だけ違う名前（VARIANT）は書かない。
    const variant = plain(call('opsSetPartnerTaxMark', ['ＡＢＣストア', 'フリマ', '', true]));
    assert.equal(variant.classification.kind, 'VARIANT');
    assert.equal(variant.stoppedBy, 'PARTNER_NAME_NOT_KNOWN');
    assert.equal(master(TAX_MARK_SHEET).getLastRow(), 1);

    // 知らない名前は書かない。
    const unknown = plain(call('opsSetPartnerTaxMark', ['架空未登録', 'フリマ', '', true]));
    assert.equal(unknown.classification.kind, 'NEW');
    assert.equal(unknown.stoppedBy, 'PARTNER_NAME_NOT_KNOWN');
    assert.equal(master(TAX_MARK_SHEET).getLastRow(), 1);
    assert.equal(auditLastRow(), 1, '監査ログは GENESIS だけ');

    // 顧客別の印は顧客 ID を C に入れて足す。
    const applied = plain(call('opsSetPartnerTaxMark', ['架空フリマ東京', 'フリマ', 'C001', true]));
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.equal(sheetValues(TAX_MARK_SHEET)[1][2], 'C001');
  });

  test('gt 12: §9.3 2 行なら DUPLICATE_ROWS、D が読めない 1 行は ROW_INVALID、FALSE は候補にしない', () => {
    taxOpsWorld([markRow('架空フリマ共通', 'フリマ'), markRow('架空フリマ共通', 'なし')], []);
    const duplicate = plain(call('opsSetPartnerTaxMark', ['架空フリマ共通', 'フリマ', '']));
    assert.equal(duplicate.candidates, 2);
    assert.equal(duplicate.stoppedBy, 'DUPLICATE_ROWS');
    const beforeDuplicate = auditLastRow();
    const stopped = plain(call('opsSetPartnerTaxMark', ['架空フリマ共通', 'フリマ', '', true]));
    assert.equal(stopped.stoppedBy, 'DUPLICATE_ROWS');
    assert.equal(stopped.applied, false);
    assert.equal(auditLastRow(), beforeDuplicate);
    assert.equal(master(TAX_MARK_SHEET).getLastRow(), 3);

    taxOpsWorld([markRow('架空フリマ共通', 'フリマ', '', '○')], []);
    const invalid = plain(call('opsSetPartnerTaxMark', ['架空フリマ共通', 'なし', '', true]));
    assert.equal(invalid.candidates, 1);
    assert.equal(invalid.stoppedBy, 'ROW_INVALID');
    assert.equal(invalid.applied, false);
    assert.equal(master(TAX_MARK_SHEET).getRange(2, 2).getValue(), 'フリマ');

    taxOpsWorld([markRow('架空フリマ共通', 'フリマ', '', false)], []);
    const created = plain(call('opsSetPartnerTaxMark', ['架空フリマ共通', 'なし', '', true]));
    assert.equal(created.action, 'CREATE');
    assert.equal(created.applied, true, JSON.stringify(created));
    assert.equal(master(TAX_MARK_SHEET).getLastRow(), 3);
    assert.equal(master(TAX_MARK_SHEET).getRange(2, 4).getValue(), false);
    assert.equal(master(TAX_MARK_SHEET).getRange(3, 4).getValue(), true);
  });

  test('gt 12: §9.3 引数の誤り・表が無いときは書かない', () => {
    taxOpsWorld([], []);
    const before = auditLastRow();
    assert.equal(plain(call('opsSetPartnerTaxMark', ['', 'フリマ', '', true]))
      .stoppedBy, 'PARTNER_NAME_REQUIRED');
    assert.equal(plain(call('opsSetPartnerTaxMark', ['架空フリマ共通', '購入', '', true]))
      .stoppedBy, 'MARK_INVALID');
    assert.equal(plain(call('opsSetPartnerTaxMark', ['架空フリマ共通', 'フリマ', 'K9999', true]))
      .stoppedBy, 'CUSTOMER_NOT_FOUND');
    assert.equal(auditLastRow(), before);
    assert.equal(master(TAX_MARK_SHEET).getLastRow(), 1);

    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: []});
    master('共通取引先一覧').appendRow(['PTN_9101', '架空フリマ共通', '', '', '', 1]);
    const noTablesAudit = auditLastRow();
    const mark = plain(call('opsSetPartnerTaxMark', ['架空フリマ共通', 'フリマ', '', true]));
    assert.equal(mark.stoppedBy, 'TABLES_MISSING');
    assert.equal(mark.applied, false);
    const flag = plain(call('opsSetCustomerTaxFlag', ['C001', true, true]));
    assert.equal(flag.stoppedBy, 'TABLES_MISSING');
    assert.equal(auditLastRow(), noTablesAudit);
  });

  test('gt 12: §9.3 監査が書けなければ表に書かない（読み返しの失敗も戻さない）', () => {
    taxOpsWorld([], []);
    const realAudit = gas.context.appendAuditUnlocked_;
    gas.context.appendAuditUnlocked_ = function() { throw new Error('audit down'); };
    try {
      const before = auditLastRow();
      const stopped = plain(call('opsSetPartnerTaxMark', ['架空フリマ共通', 'フリマ', '', true]));
      assert.equal(stopped.stoppedBy, 'AUDIT_WRITE_FAILED');
      assert.equal(stopped.applied, false);
      assert.equal(auditLastRow(), before);
      assert.equal(master(TAX_MARK_SHEET).getLastRow(), 1);
    } finally {
      gas.context.appendAuditUnlocked_ = realAudit;
    }

    // 読み返しが違えば WRITE_VERIFY_FAILED。書いた値は戻さない。
    taxOpsWorld([markRow('架空フリマ共通', 'フリマ')], []);
    const realBatchUpdate = gas.context.Sheets.Spreadsheets.Values.batchUpdate;
    let corrupted = false;
    gas.context.Sheets.Spreadsheets.Values.batchUpdate = function(request, id) {
      const result = realBatchUpdate.call(this, request, id);
      if (!corrupted) {
        corrupted = true;
        master(TAX_MARK_SHEET).getRange(2, 2).setValue('海外の物');
      }
      return result;
    };
    try {
      const failed = plain(call('opsSetPartnerTaxMark', ['架空フリマ共通', 'なし', '', true]));
      assert.equal(failed.stoppedBy, 'WRITE_VERIFY_FAILED');
      assert.equal(failed.applied, false);
      assert.equal(master(TAX_MARK_SHEET).getRange(2, 2).getValue(), '海外の物',
        '書いた値は戻さない');
    } finally {
      gas.context.Sheets.Spreadsheets.Values.batchUpdate = realBatchUpdate;
    }
  });

  // ---------------- gt 12: §9.4 ----------------

  test('gt 12: §9.4 見るだけは書かず、apply は監査→行の順で足し、書き直し、2 行なら止める', () => {
    taxOpsWorld([], []);
    const beforeAudit = auditLastRow();
    gas.stubs.resetWriteLog();
    const seen = plain(call('opsSetCustomerTaxFlag', ['C001', true]));
    assert.equal(seen.applied, false);
    assert.equal(seen.stoppedBy, null);
    assert.equal(seen.action, 'CREATE');
    assert.equal(seen.before, null);
    assert.deepEqual(gas.stubs.getWriteLog(), []);
    assert.equal(auditLastRow(), beforeAudit);

    gas.stubs.resetWriteLog();
    const applied = plain(call('opsSetCustomerTaxFlag', ['C001', true, true]));
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.equal(applied.verified, true);
    const rows = sheetValues(TAX_FLAG_SHEET);
    assert.equal(rows.length, 2);
    assert.equal(rows[1][0], 'C001');
    assert.equal(rows[1][1], true);
    assert.ok(rows[1][2], '更新日時');
    assert.equal(rows[1][3], 'tester@example.com');
    assert.equal(rows[1][4], '');
    let log = gas.stubs.getWriteLog();
    let auditIndex = log.findIndex((item) => item.sheetName === '監査ログ');
    let flagIndex = log.findIndex((item) => item.sheetName === TAX_FLAG_SHEET);
    assert.ok(auditIndex >= 0 && flagIndex > auditIndex, JSON.stringify(log));
    const audit = auditLast();
    assert.equal(audit.type, 'SETTING');
    assert.equal(audit.targetType, 'CUSTOMER');
    assert.equal(audit.targetId, 'C001');
    assert.equal(audit.reason, 'TAX_CUSTOMER_FLAG');

    gas.stubs.resetWriteLog();
    const updated = plain(call('opsSetCustomerTaxFlag', ['C001', false, true]));
    assert.equal(updated.action, 'UPDATE');
    assert.equal(updated.applied, true, JSON.stringify(updated));
    assert.equal(updated.before.smallAmountUnavailable, true);
    assert.equal(master(TAX_FLAG_SHEET).getLastRow(), 2);
    assert.equal(master(TAX_FLAG_SHEET).getRange(2, 2).getValue(), false);
    log = gas.stubs.getWriteLog();
    auditIndex = log.findIndex((item) => item.sheetName === '監査ログ');
    flagIndex = log.findIndex((item) => item.sheetName === TAX_FLAG_SHEET);
    assert.ok(auditIndex >= 0 && flagIndex > auditIndex, JSON.stringify(log));

    taxOpsWorld([], [flagRow('C001', true), flagRow('C001', false)]);
    const duplicate = plain(call('opsSetCustomerTaxFlag', ['C001', false, true]));
    assert.equal(duplicate.candidates, 2);
    assert.equal(duplicate.stoppedBy, 'DUPLICATE_ROWS');
    assert.equal(duplicate.applied, false);
    assert.equal(master(TAX_FLAG_SHEET).getLastRow(), 3);
  });

  test('gt 12: §9.4 引数の誤りと監査・読み返しの失敗', () => {
    taxOpsWorld([], []);
    const before = auditLastRow();
    assert.equal(plain(call('opsSetCustomerTaxFlag', ['', true, true]))
      .stoppedBy, 'CUSTOMER_REQUIRED');
    assert.equal(plain(call('opsSetCustomerTaxFlag', ['C001', 'true', true]))
      .stoppedBy, 'ARGUMENT_INVALID');
    assert.equal(plain(call('opsSetCustomerTaxFlag', ['C001', 1, true]))
      .stoppedBy, 'ARGUMENT_INVALID');
    assert.equal(plain(call('opsSetCustomerTaxFlag', ['C001', null, true]))
      .stoppedBy, 'ARGUMENT_INVALID');
    assert.equal(plain(call('opsSetCustomerTaxFlag', ['K9999', true, true]))
      .stoppedBy, 'CUSTOMER_NOT_FOUND');
    assert.equal(auditLastRow(), before);
    assert.equal(master(TAX_FLAG_SHEET).getLastRow(), 1);

    const realAudit = gas.context.appendAuditUnlocked_;
    gas.context.appendAuditUnlocked_ = function() { throw new Error('audit down'); };
    try {
      const stopped = plain(call('opsSetCustomerTaxFlag', ['C001', true, true]));
      assert.equal(stopped.stoppedBy, 'AUDIT_WRITE_FAILED');
      assert.equal(master(TAX_FLAG_SHEET).getLastRow(), 1);
    } finally {
      gas.context.appendAuditUnlocked_ = realAudit;
    }

    // 先に 1 行作り、書き直しの読み返しだけを壊す。
    const seeded = plain(call('opsSetCustomerTaxFlag', ['C001', true, true]));
    assert.equal(seeded.applied, true);
    const realBatchUpdate = gas.context.Sheets.Spreadsheets.Values.batchUpdate;
    let corrupted = false;
    gas.context.Sheets.Spreadsheets.Values.batchUpdate = function(request, id) {
      const result = realBatchUpdate.call(this, request, id);
      if (!corrupted) {
        corrupted = true;
        master(TAX_FLAG_SHEET).getRange(2, 2).setValue(true);
      }
      return result;
    };
    try {
      const failed = plain(call('opsSetCustomerTaxFlag', ['C001', false, true]));
      assert.equal(failed.stoppedBy, 'WRITE_VERIFY_FAILED');
      assert.equal(failed.applied, false);
      assert.equal(master(TAX_FLAG_SHEET).getRange(2, 2).getValue(), true,
        '書いた値は戻さない');
    } finally {
      gas.context.Sheets.Spreadsheets.Values.batchUpdate = realBatchUpdate;
    }
  });

  // ---------------- gt 12: §9.5 ----------------

  test('gt 12: §9.5 見るだけは入力規則も値を変えず、要約を返す', () => {
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    const sheet = destSheet();
    sheet.getRange(5, 7).setValue('架空値');
    sheet.getRange(6, 7).setValue('課対仕入10%');
    const ruleA = buildValidation(['対象外', '架空旧名'], false);
    const ruleB = buildValidation(['対象外', '架空旧名'], true);
    sheet.getRange(4, 7, 7, 1).setDataValidation(ruleA);
    sheet.getRange(11, 7, 10, 1).setDataValidation(ruleB);
    gas.stubs.resetWriteLog();
    const beforeAudit = auditLastRow();

    const report = plain(call('opsSetTaxCategoryValidation', ['C001']));
    assert.equal(report.applied, false);
    assert.equal(report.stoppedBy, null);
    assert.equal(report.customerId, 'C001');
    assert.equal(report.templateId, 'dest1');
    assert.equal(report.sheetName, '入力用シート');
    assert.equal(report.column, 7);
    assert.equal(report.firstRow, 5);
    assert.equal(report.lastRow, 30);
    assert.equal(report.rows, 26);
    assert.equal(report.groups.length, 3);
    assert.deepEqual(report.groups[0].values, ['対象外', '架空旧名']);
    assert.equal(report.groups[0].from, 5);
    assert.equal(report.groups[0].to, 10);
    assert.equal(report.groups[0].allowInvalid, false);
    assert.equal(report.groups[1].from, 11);
    assert.equal(report.groups[1].to, 20);
    assert.equal(report.groups[1].allowInvalid, true);
    assert.equal(report.groups[2].type, null);
    assert.equal(report.groups[2].from, 21);
    assert.equal(report.groups[2].to, 30);
    assert.equal(report.valueRows, 2);
    assert.deepEqual(report.otherValues, ['架空値']);
    assert.equal(report.allowInvalid, true, 'ばらばらなら true');
    assert.deepEqual(gas.stubs.getWriteLog(), [], '見るだけは書かない');
    assert.equal(auditLastRow(), beforeAudit);

    const still = sheet.getRange(4, 7, 7, 1).getDataValidations();
    assert.deepEqual(still[0][0].getCriteriaValues()[0], ['対象外', '架空旧名']);
    assert.equal(still[0][0].getAllowInvalid(), false);
    assert.equal(sheet.getRange(5, 7).getValue(), '架空値', '値を変えない');
  });

  test('gt 12: §9.5 apply は雛形の G だけに付け、値を変えず、複製とほかの顧客に触らない', () => {
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    const sheet = destSheet();
    sheet.getRange(5, 7).setValue('架空値');
    const uniform = buildValidation(['架空旧名'], false);
    sheet.getRange(5, 7, 26, 1).setDataValidation(uniform);
    const hRule = buildValidation(['H1', 'H2'], false);
    sheet.getRange(5, 8, 26, 1).setDataValidation(hRule);

    // 転記シート（複製）と、もう 1 人の顧客の雛形。
    gas.stubs.createSpreadsheet('copy1', {sheets: [
      {name: '入力用シート', maxRows: 30, maxColumns: 26}]});
    const copySheet = gas.stubs.getSpreadsheet('copy1').getSheetByName('入力用シート');
    copySheet.getRange(5, 7, 26, 1).setDataValidation(buildValidation(['複製の値'], true));
    const otherHeader = blank(15);
    Object.assign(otherHeader, {1: '利用日', 2: '相手科目コード', 3: '相手勘定科目',
      5: '取引先', 6: '相手税区分', 8: 'メモ', 10: '摘要', 11: '借方', 12: '貸方', 14: '取引ID'});
    gas.stubs.createSpreadsheet('dest2', {sheets: [
      {name: '入力用シート', values: [blank(15), blank(15), otherHeader, blank(15),
        blank(15)], maxRows: 30, maxColumns: 26},
      {name: '取引先一覧', values: [['元店名', '取引先名']]}]});
    gas.stubs.createFolder('folder2', {fileIds: []});
    call('registerTestCustomer', [{customerId: 'C002', customerName: '架空顧客2',
      sourceFolderId: 'folder2', destinationSpreadsheetId: 'dest2',
      destinationSheetName: '入力用シート', partnerListSheetName: '取引先一覧',
      headerRow: 3, dataStartRow: 5, rowScanLastColumn: 15,
      columns: {B: 2, F: 6, I: 9, K: 11, M: 13, txId: 15, G: 7, C: 3},
      accountListRange: 'Q5:R12', reviewers: 'tester@example.com',
      admins: 'tester@example.com'}]);
    const other = gas.stubs.getSpreadsheet('dest2').getSheetByName('入力用シート');
    other.getRange(5, 7, 26, 1).setDataValidation(buildValidation(['ほかの顧客'], true));

    gas.stubs.resetWriteLog();
    const applied = plain(call('opsSetTaxCategoryValidation', ['C001', true]));
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.equal(applied.stoppedBy, null);
    assert.equal(applied.verified, true);
    assert.equal(applied.allowInvalid, false, '今の規則が全部同じ値ならその値');

    const names = plain(evaluate('FREEE_TAX_CATEGORIES_')).map((category) => category.name);
    assert.equal(names.length, 30);
    const validations = sheet.getRange(5, 7, 26, 1).getDataValidations();
    assert.equal(validations.length, 26);
    validations.forEach((row) => {
      assert.ok(row[0], '全部の行に規則');
      assert.equal(row[0].getCriteriaType(), 'VALUE_IN_LIST');
      assert.deepEqual(Array.from(row[0].getCriteriaValues()[0]), names);
      assert.equal(row[0].getAllowInvalid(), false);
    });
    assert.equal(sheet.getRange(3, 7).getDataValidations()[0][0], null, '見出し行は触らない');
    assert.equal(sheet.getRange(5, 7).getValue(), '架空値', '値を変えない');
    assert.deepEqual(sheet.getRange(5, 8, 26, 1).getDataValidations()[0][0]
      .getCriteriaValues()[0], ['H1', 'H2'], 'G 以外は触らない');

    assert.deepEqual(copySheet.getRange(5, 7, 26, 1).getDataValidations()[0][0]
      .getCriteriaValues()[0], ['複製の値'], '複製に触らない');
    assert.deepEqual(other.getRange(5, 7, 26, 1).getDataValidations()[0][0]
      .getCriteriaValues()[0], ['ほかの顧客'], 'ほかの顧客の雛形に触らない');

    const log = gas.stubs.getWriteLog();
    const auditIndex = log.findIndex((item) => item.sheetName === '監査ログ');
    const dataIndex = log.findIndex((item) => item.sheetName === '入力用シート');
    assert.ok(auditIndex >= 0 && dataIndex > auditIndex, JSON.stringify(log));
    assert.equal(log.filter((item) => item.sheetName === '入力用シート').length, 1,
      '入力規則は 1 回で付ける');
    const audit = auditLast();
    assert.equal(audit.type, 'SETTING');
    assert.equal(audit.targetType, 'TEMPLATE');
    assert.equal(audit.targetId, 'dest1');
    assert.equal(audit.reason, 'TAX_VALIDATION');
  });

  test('gt 12: §9.5 税の列が無い・行が無い・顧客が無いときは書かない', () => {
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], gColumn: false,
      taxTabs: {marks: [], flags: []}});
    const beforeAudit = auditLastRow();
    assert.equal(plain(call('opsSetTaxCategoryValidation', ['C001'])).stoppedBy,
      'NO_TAX_COLUMN');
    assert.equal(plain(call('opsSetTaxCategoryValidation', ['C001', true])).stoppedBy,
      'NO_TAX_COLUMN');
    assert.equal(plain(call('opsSetTaxCategoryValidation', [''])).stoppedBy,
      'CUSTOMER_REQUIRED');
    assert.equal(plain(call('opsSetTaxCategoryValidation', ['K9999'])).stoppedBy,
      'CUSTOMER_NOT_FOUND');
    assert.equal(auditLastRow(), beforeAudit);

    setupMaster();
    const header = blank(15);
    header[5] = '相手税区分';
    gas.stubs.createSpreadsheet('destR', {sheets: [{name: '入力用シート',
      values: [blank(15), blank(15), blank(15), header], maxRows: 4, maxColumns: 26}]});
    gas.stubs.createFolder('folderR', {fileIds: []});
    call('registerTestCustomer', [{customerId: 'K9101', customerName: '架空顧客R',
      sourceFolderId: 'folderR', destinationSpreadsheetId: 'destR',
      destinationSheetName: '入力用シート', partnerListSheetName: '取引先一覧',
      headerRow: 4, dataStartRow: 5, rowScanLastColumn: 15,
      columns: {B: 2, F: 6, I: 9, K: 11, M: 13, txId: 15, G: 7, C: 3},
      accountListRange: 'Q5:R12', reviewers: 'tester@example.com',
      admins: 'tester@example.com'}]);
    gas.stubs.resetWriteLog();
    const noRows = plain(call('opsSetTaxCategoryValidation', ['K9101', true]));
    assert.equal(noRows.stoppedBy, 'NO_ROWS');
    assert.equal(noRows.applied, false);
    assert.deepEqual(gas.stubs.getWriteLog(), []);
  });

  test('gt 12: §9.1 監査が書けなければタブも見出しも書かない', () => {
    setupMaster();
    const realAudit = gas.context.appendAuditUnlocked_;
    gas.context.appendAuditUnlocked_ = function() { throw new Error('audit down'); };
    try {
      const before = auditLastRow();
      gas.stubs.resetWriteLog();
      const stopped = plain(call('opsSetupTaxCategoryTables', [true]));
      assert.equal(stopped.stoppedBy, 'AUDIT_WRITE_FAILED');
      assert.equal(stopped.applied, false);
      assert.equal(master(TAX_MARK_SHEET), null);
      assert.equal(master(TAX_FLAG_SHEET), null);
      assert.equal(auditLastRow(), before);
      assert.deepEqual(gas.stubs.getWriteLog(), []);
    } finally {
      gas.context.appendAuditUnlocked_ = realAudit;
    }
  });

  // ---------------- gt 17: §9.5 壊れた入力規則 ----------------

  /** 消えた範囲（`#REF!`）を指す偽の規則。値はすべて架空である。 */
  function brokenRule(type, allowInvalid, allowInvalidThrows) {
    return {
      getCriteriaType() { return type; },
      getCriteriaValues() { throw new Error('Range not found'); },
      getAllowInvalid() {
        if (allowInvalidThrows) throw new Error('Range not found');
        return allowInvalid;
      }
    };
  }

  test('gt 17: §9.5 見るだけは壊れた規則で止まらず、組と行数を返す', () => {
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    const sheet = destSheet();
    sheet.getRange(5, 7).setValue('架空値');
    sheet.getRange(5, 7, 6, 1).setDataValidation(buildValidation(['対象外', '架空旧名'], false));
    sheet.getRange(11, 7, 10, 1).setDataValidation(brokenRule('VALUE_IN_RANGE', false, false));
    gas.stubs.resetWriteLog();
    const beforeAudit = auditLastRow();

    const report = plain(call('opsSetTaxCategoryValidation', ['C001']));
    assert.equal(report.stoppedBy, null);
    assert.equal(report.applied, false);
    assert.equal(report.groups.length, 3);
    assert.equal(report.groups[0].broken, false);
    assert.equal(report.groups[0].from, 5);
    assert.equal(report.groups[0].to, 10);
    assert.equal(report.groups[1].broken, true);
    assert.equal(report.groups[1].type, 'VALUE_IN_RANGE');
    assert.equal(report.groups[1].values, null);
    assert.equal(report.groups[1].rangeA1, null);
    assert.equal(report.groups[1].allowInvalid, false);
    assert.equal(report.groups[1].from, 11);
    assert.equal(report.groups[1].to, 20);
    assert.equal(report.groups[2].type, null);
    assert.equal(report.groups[2].broken, false);
    assert.equal(report.groups[2].from, 21);
    assert.equal(report.groups[2].to, 30);
    assert.equal(report.brokenRows, 10);
    assert.equal(report.allowInvalid, false);
    assert.deepEqual(gas.stubs.getWriteLog(), [], '見るだけは書かない');
    assert.equal(auditLastRow(), beforeAudit);
  });

  test('gt 17: §9.5 apply は壊れた規則の行も一覧で上書きし、値を変えない', () => {
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    const sheet = destSheet();
    sheet.getRange(5, 7).setValue('架空値');
    sheet.getRange(5, 7, 6, 1).setDataValidation(buildValidation(['対象外', '架空旧名'], false));
    sheet.getRange(11, 7, 10, 1).setDataValidation(brokenRule('VALUE_IN_RANGE', false, false));
    gas.stubs.resetWriteLog();
    const beforeAudit = auditLastRow();

    const applied = plain(call('opsSetTaxCategoryValidation', ['C001', true]));
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.equal(applied.verified, true);
    assert.equal(applied.stoppedBy, null);
    assert.equal(applied.brokenRows, 10);
    assert.equal(applied.allowInvalid, false);

    const names = plain(evaluate('FREEE_TAX_CATEGORIES_')).map((category) => category.name);
    assert.equal(names.length, 30);
    const validations = sheet.getRange(5, 7, 26, 1).getDataValidations();
    assert.equal(validations.length, 26);
    validations.forEach((row) => {
      assert.ok(row[0], '全部の行に規則');
      assert.equal(row[0].getCriteriaType(), 'VALUE_IN_LIST');
      assert.deepEqual(Array.from(row[0].getCriteriaValues()[0]), names);
      assert.equal(row[0].getAllowInvalid(), false);
    });
    assert.equal(sheet.getRange(5, 7).getValue(), '架空値', '値を変えない');

    const log = gas.stubs.getWriteLog();
    const auditIndex = log.findIndex((item) => item.sheetName === '監査ログ');
    const dataIndex = log.findIndex((item) => item.sheetName === '入力用シート');
    assert.ok(auditIndex >= 0 && dataIndex > auditIndex, JSON.stringify(log));
    assert.equal(log.filter((item) => item.sheetName === '入力用シート').length, 1,
      '入力規則は 1 回で付ける');
    assert.ok(auditLastRow() > beforeAudit, '監査を書く');
    const audit = auditLast();
    assert.equal(audit.type, 'SETTING');
    assert.equal(audit.targetType, 'TEMPLATE');
    assert.equal(audit.targetId, 'dest1');
    assert.equal(audit.reason, 'TAX_VALIDATION');
  });

  test('gt 17: §9.5 getAllowInvalid も読めない規則は allowInvalid を true にする', () => {
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    const sheet = destSheet();
    sheet.getRange(5, 7, 6, 1).setDataValidation(buildValidation(['対象外'], false));
    sheet.getRange(11, 7, 10, 1).setDataValidation(brokenRule('VALUE_IN_RANGE', null, true));
    sheet.getRange(21, 7, 10, 1).setDataValidation(buildValidation(['対象外'], false));

    const report = plain(call('opsSetTaxCategoryValidation', ['C001']));
    assert.equal(report.stoppedBy, null);
    assert.equal(report.brokenRows, 10);
    assert.equal(report.groups[1].broken, true);
    assert.equal(report.groups[1].allowInvalid, null);
    assert.equal(report.allowInvalid, true);

    const applied = plain(call('opsSetTaxCategoryValidation', ['C001', true]));
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.equal(applied.verified, true);
    assert.equal(applied.allowInvalid, true);
    const validations = sheet.getRange(5, 7, 26, 1).getDataValidations();
    validations.forEach((row) => assert.equal(row[0].getAllowInvalid(), true));
  });

  test('gt 17: §9.5 全部の行が読めない規則でも allowInvalid は真偽で、行数を数える', () => {
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    const sheet = destSheet();
    sheet.getRange(5, 7, 26, 1).setDataValidation(brokenRule('VALUE_IN_RANGE', null, true));

    const report = plain(call('opsSetTaxCategoryValidation', ['C001']));
    assert.equal(report.stoppedBy, null);
    assert.equal(report.allowInvalid, true, 'null にしない');
    assert.equal(report.brokenRows, 26);
    assert.equal(report.groups.length, 1);
    assert.equal(report.groups[0].broken, true);
    assert.equal(report.groups[0].from, 5);
    assert.equal(report.groups[0].to, 30);
  });

  test('gt 17: §9.5 読み返しで壊れた規則が残れば WRITE_VERIFY_FAILED（例外にしない）', () => {
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    const sheet = destSheet();
    sheet.getRange(5, 7, 6, 1).setDataValidation(buildValidation(['対象外'], false));
    sheet.getRange(11, 7, 10, 1).setDataValidation(brokenRule('VALUE_IN_RANGE', false, false));
    const proto = Object.getPrototypeOf(sheet.getRange(5, 7));
    const real = proto.setDataValidation;
    proto.setDataValidation = function() { return this; };
    try {
      const report = plain(call('opsSetTaxCategoryValidation', ['C001', true]));
      assert.equal(report.stoppedBy, 'WRITE_VERIFY_FAILED');
      assert.equal(report.applied, false);
      assert.equal(report.verified, false);
    } finally {
      proto.setDataValidation = real;
    }
  });

  test('gt 17: §9.5 壊れた規則は同じ型の値の無い規則と組を分ける', () => {
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    const sheet = destSheet();
    sheet.getRange(5, 7, 6, 1).setDataValidation(buildValidation(['対象外'], false));
    const emptyRange = evaluate('SpreadsheetApp.newDataValidation()')
      .requireValueInRange(null, true).setAllowInvalid(false).build();
    sheet.getRange(11, 7, 5, 1).setDataValidation(emptyRange);
    sheet.getRange(16, 7, 5, 1).setDataValidation(brokenRule('VALUE_IN_RANGE', false, false));

    const report = plain(call('opsSetTaxCategoryValidation', ['C001']));
    assert.equal(report.stoppedBy, null);
    assert.equal(report.groups.length, 4);
    assert.equal(report.groups[1].type, 'VALUE_IN_RANGE');
    assert.equal(report.groups[1].broken, false);
    assert.equal(report.groups[1].values, null);
    assert.equal(report.groups[1].rangeA1, null);
    assert.equal(report.groups[1].from, 11);
    assert.equal(report.groups[1].to, 15);
    assert.equal(report.groups[2].broken, true);
    assert.equal(report.groups[2].from, 16);
    assert.equal(report.groups[2].to, 20);
    assert.equal(report.brokenRows, 5);
  });

  // ================================================================
  // 5 回目：§9.6 今ある転記シートの入力規則（gt 18）。値はすべて架空である。
  // ================================================================

  const COPY_PREFIX_18 = '架空顧客_';
  const TX_LOG_18 = 'クレカ取引ログ';

  function names18() {
    return plain(evaluate('FREEE_TAX_CATEGORIES_')).map((category) => category.name);
  }

  function copy18Header(overrides) {
    const header = blank(15);
    Object.assign(header, {1: '利用日', 2: '相手科目コード', 3: '相手勘定科目',
      5: '取引先', 6: '相手税区分', 8: 'メモ', 10: '摘要', 11: '借方', 12: '貸方', 14: '取引ID'});
    if (overrides) Object.assign(header, overrides);
    return header;
  }

  function copy18Values(options = {}) {
    const values = [blank(15), blank(15), copy18Header(options.header),
      Object.assign(blank(15), {0: '区切り'}), blank(15)];
    Object.keys(options.gValues || {}).forEach((rowText) => {
      const row = Number(rowText);
      while (values.length < row) values.push(blank(15));
      values[row - 1][6] = options.gValues[rowText];
    });
    return values;
  }

  /** 架空の転記シート（複製）。見出しは雛形と同じ、G は 5〜30 行目。 */
  function createCopy18(id, name, options = {}) {
    const sheetName = options.sheetName || '入力用シート';
    gas.stubs.createSpreadsheet(id, {
      name: name,
      trashed: options.trashed === true,
      sheets: [{name: sheetName, values: copy18Values(options),
        maxRows: options.maxRows || 30, maxColumns: 30}]
    });
    const sheet = gas.stubs.getSpreadsheet(id).getSheetByName(sheetName);
    (options.groups || []).forEach((group) => {
      sheet.getRange(group.from, 7, group.rows, 1).setDataValidation(group.rule);
    });
    if (options.headerRule) sheet.getRange(3, 7).setDataValidation(options.headerRule);
    if (options.otherRule) sheet.getRange(5, 8, 26, 1).setDataValidation(options.otherRule);
    return sheet;
  }

  function place18(folderId, ids) {
    gas.stubs.createFolder(folderId, {fileIds: ids});
  }

  /** 取引ログに 1 行置く（D＝顧客 ID、AC・AD＝転記シート、AP＝有効）。 */
  function tx18(spec) {
    const row = blank(49);
    row[0] = spec.id;
    row[1] = spec.id;
    row[2] = 'GT18';
    row[3] = spec.customerId === undefined ? 'C001' : spec.customerId;
    row[4] = 'gt18-file';
    row[5] = '入力用シート';
    row[9] = spec.status || 'PREPARED';
    row[15] = spec.merchant || '架空店';
    row[16] = spec.amount === undefined ? 1000 : spec.amount;
    row[17] = spec.purpose || '仕入';
    if (spec.destinationId !== undefined) row[28] = spec.destinationId;
    if (spec.destinationSheet !== undefined) row[29] = spec.destinationSheet;
    row[41] = spec.active === undefined ? true : spec.active;
    master(TX_LOG_18).appendRow(row);
  }

  function oldRule18(values, allowInvalid) {
    return buildValidation(values, allowInvalid);
  }

  /** 3 枚（旧い一覧＋壊れた規則・別の旧い一覧・もう 30 個）と、対象外の転記シート。 */
  function threeCopies18World() {
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    const template = destSheet();
    template.getRange(5, 7).setValue('雛形値');
    template.getRange(5, 7, 26, 1).setDataValidation(oldRule18(['雛形の旧い一覧'], false));
    template.getRange(5, 8, 26, 1).setDataValidation(oldRule18(['雛形H'], false));

    const copyA = createCopy18('copyA', COPY_PREFIX_18 + '20261001-1200', {
      gValues: {5: '不課税', 6: '課対仕入10%', 7: '旧い名前'},
      groups: [
        {from: 5, rows: 6, rule: oldRule18(['対象外', '不課税', '旧い名前'], false)},
        {from: 11, rows: 10, rule: brokenRule('VALUE_IN_RANGE', false, false)}
      ],
      headerRule: oldRule18(['見出し'], false),
      otherRule: oldRule18(['H1', 'H2'], false)
    });
    const copyB = createCopy18('copyB', COPY_PREFIX_18 + '20261002-1300', {
      gValues: {5: '非課仕入'},
      groups: [{from: 5, rows: 26, rule: oldRule18(['対象外', '不課税'], true)}]
    });
    const copyC = createCopy18('copyC', COPY_PREFIX_18 + '20261003-1400', {
      gValues: {5: '対象外'},
      groups: [{from: 5, rows: 26, rule: oldRule18(names18(), true)}]
    });
    const inactive = createCopy18('copyInactive', COPY_PREFIX_18 + '20261004-1500', {
      groups: [{from: 5, rows: 26, rule: oldRule18(['旧い一覧'], false)}]
    });
    const canceled = createCopy18('copyCanceled', COPY_PREFIX_18 + '20261005-1600', {
      groups: [{from: 5, rows: 26, rule: oldRule18(['旧い一覧'], false)}]
    });
    const other = createCopy18('copyOther', '架空別顧客_20261006-1700', {
      groups: [{from: 5, rows: 26, rule: oldRule18(['別の顧客'], false)}]
    });
    place18('parent', ['dest1', 'copyA', 'copyB', 'copyC', 'copyInactive',
      'copyCanceled', 'copyOther']);

    tx18({id: 'GT18_A1', destinationId: 'copyA'});
    tx18({id: 'GT18_A2', destinationId: 'copyA', status: 'COMMITTED'});
    tx18({id: 'GT18_B1', destinationId: 'copyB', status: 'REVIEW_REQUIRED'});
    tx18({id: 'GT18_C1', destinationId: 'copyC', status: 'WRITING'});
    tx18({id: 'GT18_LEGACY'});
    tx18({id: 'GT18_TEMPLATE', destinationId: 'dest1'});
    tx18({id: 'GT18_OFF', destinationId: 'copyInactive', active: false});
    tx18({id: 'GT18_CANCELED', destinationId: 'copyCanceled', status: 'CANCELED'});
    tx18({id: 'GT18_OTHER', customerId: 'K9002', destinationId: 'copyOther'});
    return {template: template, copyA: copyA, copyB: copyB, copyC: copyC,
      inactive: inactive, canceled: canceled, other: other};
  }

  /** 2 枚だけの世界（書く組が 2 つある）。 */
  function twoCopies18World() {
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    const template = destSheet();
    const copyA = createCopy18('copyA', COPY_PREFIX_18 + '20261001-1200', {
      gValues: {5: '架空の値A'},
      groups: [{from: 5, rows: 26, rule: oldRule18(['旧い一覧'], false)}]
    });
    const copyB = createCopy18('copyB', COPY_PREFIX_18 + '20261002-1300', {
      gValues: {5: '架空の値B'},
      groups: [{from: 5, rows: 26, rule: oldRule18(['別の旧い一覧'], true)}]
    });
    place18('parent', ['dest1', 'copyA', 'copyB']);
    tx18({id: 'GT18_A1', destinationId: 'copyA'});
    tx18({id: 'GT18_B1', destinationId: 'copyB'});
    return {template: template, copyA: copyA, copyB: copyB};
  }

  function copyRules18(sheet, allowInvalid) {
    const names = names18();
    const rows = sheet.getRange(5, 7, 26, 1).getDataValidations();
    assert.equal(rows.length, 26);
    rows.forEach((row) => {
      assert.ok(row[0], '全部の行に規則');
      assert.equal(row[0].getCriteriaType(), 'VALUE_IN_LIST');
      assert.deepEqual(Array.from(row[0].getCriteriaValues()[0]), names);
      assert.equal(row[0].getAllowInvalid(), allowInvalid);
    });
  }

  function dataRuleWrites18(spreadsheetId) {
    return gas.stubs.getWriteLog().filter((item) =>
      item.kind === 'range.setDataValidation' && item.spreadsheetId === spreadsheetId);
  }

  function auditWrites18() {
    return gas.stubs.getWriteLog().findIndex((item) => item.sheetName === '監査ログ');
  }

  test('gt 18: §9.6 見るだけは 3 枚だけを返し、書込 0・監査 0 で値も規則も変えない', () => {
    const world = threeCopies18World();
    gas.stubs.resetWriteLog();
    const beforeAudit = auditLastRow();

    const report = plain(call('opsSetCopiesTaxCategoryValidation', ['C001']));
    assert.equal(report.stoppedBy, null);
    assert.equal(report.applied, false);
    assert.equal(report.customerId, 'C001');
    assert.equal(report.templateId, 'dest1');
    assert.equal(report.column, 7);
    assert.equal(report.headerRow, 4);
    assert.equal(report.transactions, 6);
    assert.equal(report.legacyTransactions, 2);
    assert.equal(report.unreadableTransactions, 0);
    assert.equal(report.copies.length, 3);
    assert.deepEqual(report.copies.map((copy) => copy.spreadsheetId),
      ['copyA', 'copyB', 'copyC']);
    assert.deepEqual(report.copies.map((copy) => copy.stamp),
      ['20261001-1200', '20261002-1300', '20261003-1400']);
    assert.deepEqual(report.counts,
      {alreadySet: 1, needsUpdate: 2, skipped: 0, applied: 0, notReached: 0, beforeStart: 0});

    const first = report.copies[0];
    assert.equal(first.status, 'NEEDS_UPDATE');
    assert.equal(first.sheetName, '入力用シート');
    assert.equal(first.transactionCount, 2);
    assert.equal(first.firstRow, 5);
    assert.equal(first.lastRow, 30);
    assert.equal(first.rows, 26);
    assert.equal(first.brokenRows, 10);
    assert.equal(first.allowInvalid, false);
    assert.equal(first.groups.length, 3);
    assert.deepEqual(first.otherValues, ['不課税', '旧い名前']);
    assert.deepEqual(first.otherValueRows, [5, 7]);
    assert.equal(first.otherValueRowCount, 2);
    assert.equal(report.copies[1].status, 'NEEDS_UPDATE');
    assert.equal(report.copies[1].allowInvalid, true);
    assert.equal(report.copies[2].status, 'ALREADY_SET');

    assert.deepEqual(gas.stubs.getWriteLog(), [], '見るだけは書かない');
    assert.equal(auditLastRow(), beforeAudit);
    const still = world.copyA.getRange(5, 7, 6, 1).getDataValidations()[0][0];
    assert.deepEqual(Array.from(still.getCriteriaValues()[0]),
      ['対象外', '不課税', '旧い名前']);
    assert.equal(world.copyA.getRange(5, 7).getValue(), '不課税', '値を変えない');
    assert.equal(world.template.getRange(5, 7).getValue(), '雛形値');
  });

  test('gt 18: §9.6 apply は NEEDS_UPDATE の 2 枚だけに 30 個の一覧を付け、監査が先・2 回目は書かない', () => {
    const world = threeCopies18World();
    gas.stubs.resetWriteLog();
    const beforeAudit = auditLastRow();

    const applied = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
    assert.equal(applied.stoppedBy, null);
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.deepEqual(applied.counts,
      {alreadySet: 1, needsUpdate: 0, skipped: 0, applied: 2, notReached: 0, beforeStart: 0});
    assert.equal(applied.auditIds.length, 2);
    assert.equal(applied.copies[0].status, 'APPLIED');
    assert.equal(applied.copies[0].verified, true);
    assert.equal(applied.copies[1].status, 'APPLIED');
    assert.equal(applied.copies[2].status, 'ALREADY_SET');

    copyRules18(world.copyA, false);
    copyRules18(world.copyB, true);
    assert.equal(world.copyA.getRange(5, 7).getValue(), '不課税', '値を変えない');
    assert.equal(world.copyA.getRange(6, 7).getValue(), '課対仕入10%');
    assert.equal(world.copyA.getRange(7, 7).getValue(), '旧い名前');
    assert.deepEqual(Array.from(world.copyA.getRange(3, 7).getDataValidations()[0][0]
      .getCriteriaValues()[0]), ['見出し'], '見出し行は触らない');
    assert.deepEqual(Array.from(world.copyA.getRange(5, 8, 26, 1).getDataValidations()[0][0]
      .getCriteriaValues()[0]), ['H1', 'H2'], 'G 以外は触らない');

    assert.deepEqual(Array.from(world.template.getRange(5, 7, 26, 1)
      .getDataValidations()[0][0].getCriteriaValues()[0]), ['雛形の旧い一覧'],
    '雛形に触らない');
    assert.equal(world.template.getRange(5, 7).getValue(), '雛形値');
    ['inactive', 'canceled', 'other'].forEach((key) => {
      assert.equal(world[key].getRange(5, 7, 26, 1).getDataValidations()[0][0]
        .getAllowInvalid(), false, key + ' に触らない');
      assert.deepEqual(Array.from(world[key].getRange(5, 7, 26, 1)
        .getDataValidations()[0][0].getCriteriaValues()[0]),
      [key === 'other' ? '別の顧客' : '旧い一覧'], key + ' の規則を変えない');
    });

    assert.equal(dataRuleWrites18('copyA').length, 1, '規則は 1 回で付ける');
    assert.equal(dataRuleWrites18('copyB').length, 1);
    assert.equal(dataRuleWrites18('copyC').length, 0, 'ALREADY_SET には書かない');
    assert.equal(dataRuleWrites18('copyInactive').length, 0);
    assert.equal(dataRuleWrites18('copyCanceled').length, 0);
    assert.equal(dataRuleWrites18('copyOther').length, 0);

    const log = gas.stubs.getWriteLog();
    const audits = log.map((item, index) => item.sheetName === '監査ログ' ? index : -1)
      .filter((index) => index >= 0);
    const writeA = log.findIndex((item) => item.kind === 'range.setDataValidation' &&
      item.spreadsheetId === 'copyA');
    const writeB = log.findIndex((item) => item.kind === 'range.setDataValidation' &&
      item.spreadsheetId === 'copyB');
    assert.equal(audits.length, 2, '監査は 2 行');
    assert.ok(audits[0] < writeA && writeA < audits[1] && audits[1] < writeB,
      JSON.stringify(log));

    const auditSheet = master('監査ログ');
    const auditRows = auditSheet.getDataRange().getValues()
      .filter((row) => row[6] === 'DESTINATION');
    assert.equal(auditRows.length, 2);
    assert.deepEqual(auditRows.map((row) => row[7]), ['copyA', 'copyB']);
    assert.deepEqual(auditRows.map((row) => row[11]),
      ['TAX_VALIDATION_COPY', 'TAX_VALIDATION_COPY']);
    assert.deepEqual(auditRows.map((row) => row[2]), ['SETTING', 'SETTING']);

    // もう一度回すと、全部 ALREADY_SET で書込も監査も増えない。
    const auditCount = auditLastRow();
    gas.stubs.resetWriteLog();
    const again = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
    assert.equal(again.stoppedBy, null);
    assert.equal(again.applied, false);
    assert.deepEqual(again.counts,
      {alreadySet: 3, needsUpdate: 0, skipped: 0, applied: 0, notReached: 0, beforeStart: 0});
    assert.deepEqual(gas.stubs.getWriteLog(), []);
    assert.equal(auditLastRow(), auditCount);
  });

  test('gt 18: §9.6 ロックの中で ALREADY_SET になった転記シートには書かず、監査も足さない', () => {
    twoCopies18World();
    const realCheck = gas.context.taxOpsCopyCheck_;
    const seen = {};
    gas.context.taxOpsCopyCheck_ = function(copy) {
      seen[copy.spreadsheetId] = (seen[copy.spreadsheetId] || 0) + 1;
      if (copy.spreadsheetId === 'copyA' && seen[copy.spreadsheetId] === 2) {
        destSheet('copyA').getRange(5, 7, 26, 1)
          .setDataValidation(buildValidation(names18(), false));
        gas.stubs.resetWriteLog();
      }
      return realCheck.apply(this, arguments);
    };
    try {
      gas.stubs.resetWriteLog();
      const beforeAudit = auditLastRow();
      const report = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
      assert.equal(report.stoppedBy, null);
      assert.equal(report.applied, true, JSON.stringify(report));
      const byId = {};
      report.copies.forEach((copy) => { byId[copy.spreadsheetId] = copy; });
      assert.equal(byId.copyA.status, 'ALREADY_SET');
      assert.equal(byId.copyB.status, 'APPLIED');
      assert.deepEqual(report.counts,
        {alreadySet: 1, needsUpdate: 0, skipped: 0, applied: 1, notReached: 0, beforeStart: 0});
      assert.equal(dataRuleWrites18('copyA').length, 0, 'ALREADY_SET には書かない');
      assert.equal(dataRuleWrites18('copyB').length, 1);
      const audits = master('監査ログ').getDataRange().getValues()
        .filter((row) => row[11] === 'TAX_VALIDATION_COPY');
      assert.equal(audits.length, 1, '監査も足さない');
      assert.equal(audits[0][7], 'copyB');
      assert.ok(auditLastRow() > beforeAudit);
    } finally {
      gas.context.taxOpsCopyCheck_ = realCheck;
    }
  });

  test('gt 18: §9.6 組ごとの確かめで外れた転記シートは SKIPPED と理由にし、ほかには付ける', () => {
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    const good = createCopy18('copyGood', COPY_PREFIX_18 + '20261010-1000', {
      groups: [{from: 5, rows: 26, rule: oldRule18(['旧い一覧'], false)}]
    });
    const badName = createCopy18('copyBadName', '架空別の名前_20261010-1000', {
      groups: [{from: 5, rows: 26, rule: oldRule18(['旧い一覧'], false)}]
    });
    const otherParent = createCopy18('copyOtherParent', COPY_PREFIX_18 + '20261011-1100', {
      groups: [{from: 5, rows: 26, rule: oldRule18(['旧い一覧'], false)}]
    });
    const trashed = createCopy18('copyTrashed', COPY_PREFIX_18 + '20261012-1200', {
      trashed: true,
      groups: [{from: 5, rows: 26, rule: oldRule18(['旧い一覧'], false)}]
    });
    const noSheet = createCopy18('copyNoSheet', COPY_PREFIX_18 + '20261013-1300', {
      sheetName: '別のシート',
      groups: []
    });
    const badHeader = createCopy18('copyBadHeader', COPY_PREFIX_18 + '20261014-1400', {
      header: {5: '別の見出し'},
      groups: [{from: 5, rows: 26, rule: oldRule18(['旧い一覧'], false)}]
    });
    place18('parent', ['dest1', 'copyGood', 'copyBadName', 'copyTrashed',
      'copyNoSheet', 'copyBadHeader']);
    place18('elsewhere', ['copyOtherParent']);

    tx18({id: 'GT18_GOOD', destinationId: 'copyGood'});
    tx18({id: 'GT18_BADNAME', destinationId: 'copyBadName'});
    tx18({id: 'GT18_PARENT', destinationId: 'copyOtherParent'});
    tx18({id: 'GT18_TRASHED', destinationId: 'copyTrashed'});
    tx18({id: 'GT18_NOSHEET', destinationId: 'copyNoSheet'});
    tx18({id: 'GT18_BADHEADER', destinationId: 'copyBadHeader'});
    tx18({id: 'GT18_MISSING', destinationId: 'copyMissing'});

    gas.stubs.resetWriteLog();
    const beforeAudit = auditLastRow();
    const report = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
    assert.equal(report.stoppedBy, null);
    assert.equal(report.applied, true, JSON.stringify(report));
    const byId = {};
    report.copies.forEach((copy) => { byId[copy.spreadsheetId] = copy; });
    assert.equal(report.copies.length, 7);
    assert.equal(byId.copyGood.status, 'APPLIED');
    assert.equal(byId.copyBadName.status, 'SKIPPED');
    assert.equal(byId.copyBadName.problem, 'NAME_MISMATCH');
    assert.equal(byId.copyOtherParent.status, 'SKIPPED');
    assert.equal(byId.copyOtherParent.problem, 'PARENT_MISMATCH');
    assert.equal(byId.copyTrashed.status, 'SKIPPED');
    assert.equal(byId.copyTrashed.problem, 'TRASHED');
    assert.equal(byId.copyNoSheet.status, 'SKIPPED');
    assert.equal(byId.copyNoSheet.problem, 'SHEET_MISSING');
    assert.equal(byId.copyBadHeader.status, 'SKIPPED');
    assert.equal(byId.copyBadHeader.problem, 'HEADER_MISMATCH');
    assert.equal(byId.copyMissing.status, 'SKIPPED');
    assert.equal(byId.copyMissing.problem, 'OPEN_FAILED');

    copyRules18(good, false);
    assert.equal(dataRuleWrites18('copyGood').length, 1);
    ['copyBadName', 'copyOtherParent', 'copyTrashed', 'copyNoSheet', 'copyBadHeader']
      .forEach((id) => {
        assert.equal(dataRuleWrites18(id).length, 0, id + ' には書かない');
      });
    assert.deepEqual(Array.from(badHeader.getRange(5, 7, 26, 1).getDataValidations()[0][0]
      .getCriteriaValues()[0]), ['旧い一覧']);
    assert.equal(master('監査ログ').getDataRange().getValues()
      .filter((row) => row[6] === 'DESTINATION').length, 1);
  });

  test('gt 18: §9.6 監査が書けない・読み返しが合わないときは後の転記シートに書かない', () => {
    // 監査が書けない → その枚にも後の枚にも書かない。
    twoCopies18World();
    gas.stubs.resetWriteLog();
    const beforeAudit = auditLastRow();
    const realAudit = gas.context.appendAuditUnlocked_;
    let auditAttempts = 0;
    gas.context.appendAuditUnlocked_ = function() {
      auditAttempts += 1;
      throw new Error('audit down');
    };
    try {
      const stopped = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
      assert.equal(stopped.stoppedBy, 'AUDIT_WRITE_FAILED');
      assert.equal(stopped.applied, false);
      assert.deepEqual(gas.stubs.getWriteLog().filter((item) =>
        item.kind === 'range.setDataValidation'), []);
      assert.equal(auditLastRow(), beforeAudit);
      assert.equal(stopped.counts.applied, 0);
      assert.equal(stopped.copies[0].status, 'NEEDS_UPDATE');
      assert.equal(stopped.copies[1].status, 'NOT_REACHED');
      assert.equal(auditAttempts, 1, '監査は 1 回しか試みない');
      assert.deepEqual(stopped.auditIds, []);
    } finally {
      gas.context.appendAuditUnlocked_ = realAudit;
    }

    // 規則を付けても変わらない（1 枚目の範囲だけ読み返しが合わない）→ 後の枚に書かない。
    twoCopies18World();
    const sheet = destSheet('copyA');
    const proto = Object.getPrototypeOf(sheet.getRange(5, 7));
    const realValidation = proto.setDataValidation;
    proto.setDataValidation = function(validation) {
      if (this.sheet.getParent().getId() === 'copyA' && this.getRow() === 5 &&
          this.getColumn() === 7 && this.getNumRows() === 26) {
        return this;
      }
      return realValidation.call(this, validation);
    };
    try {
      gas.stubs.resetWriteLog();
      const report = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
      assert.equal(report.stoppedBy, 'WRITE_VERIFY_FAILED');
      assert.equal(report.applied, false);
      assert.equal(report.copies[0].status, 'NEEDS_UPDATE');
      assert.equal(report.copies[0].verified, false);
      assert.equal(report.copies[1].status, 'NOT_REACHED');
      assert.equal(dataRuleWrites18('copyB').length, 0, '後の枚に書かない');
      assert.equal(master('監査ログ').getDataRange().getValues()
        .filter((row) => row[11] === 'TAX_VALIDATION_COPY').length, 1, '監査は書く');
    } finally {
      proto.setDataValidation = realValidation;
    }
  });

  test('gt 18: §9.6 ロックが取れないときは LOCK_UNAVAILABLE で書かない', () => {
    twoCopies18World();
    gas.stubs.resetWriteLog();
    const beforeAudit = auditLastRow();
    const lock = gas.stubs.getScriptLock();
    lock.setTryLockResults([false]);
    try {
      const report = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
      assert.equal(report.stoppedBy, 'LOCK_UNAVAILABLE');
      assert.equal(report.applied, false);
      assert.equal(report.counts.notReached, 2);
      assert.deepEqual(gas.stubs.getWriteLog(), []);
      assert.equal(auditLastRow(), beforeAudit);
    } finally {
      lock.reset();
    }
  });

  test('gt 18: §9.6 timeBudgetMs: 0 は 1 枚も書かず TIME_BUDGET、既定で回すと全部直る', () => {
    twoCopies18World();
    gas.stubs.resetWriteLog();
    const beforeAudit = auditLastRow();
    const stopped = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true,
      {timeBudgetMs: 0}]));
    assert.equal(stopped.stoppedBy, 'TIME_BUDGET');
    assert.equal(stopped.applied, false);
    assert.deepEqual(stopped.counts,
      {alreadySet: 0, needsUpdate: 0, skipped: 0, applied: 0, notReached: 2, beforeStart: 0});
    assert.equal(stopped.copies[0].status, 'NOT_REACHED');
    assert.equal(stopped.copies[1].status, 'NOT_REACHED');
    assert.deepEqual(gas.stubs.getWriteLog(), []);
    assert.equal(auditLastRow(), beforeAudit);

    const applied = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
    assert.equal(applied.stoppedBy, null);
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.deepEqual(applied.counts,
      {alreadySet: 0, needsUpdate: 0, skipped: 0, applied: 2, notReached: 0, beforeStart: 0});
    copyRules18(destSheet('copyA'), false);
    copyRules18(destSheet('copyB'), true);
  });

  test('gt 18: §9.6 引数の誤りは止めるか見るだけにし、どれも書かない', () => {
    function stoppedBy(world, args) {
      gas.stubs.resetWriteLog();
      const beforeAudit = auditLastRow();
      const report = plain(call('opsSetCopiesTaxCategoryValidation', args));
      assert.deepEqual(gas.stubs.getWriteLog(), [], JSON.stringify(report));
      assert.equal(auditLastRow(), beforeAudit);
      return report;
    }

    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    assert.equal(stoppedBy(null, ['', true]).stoppedBy, 'CUSTOMER_REQUIRED');
    assert.equal(stoppedBy(null, ['K9999', true]).stoppedBy, 'CUSTOMER_NOT_FOUND');

    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], gColumn: false,
      taxTabs: {marks: [], flags: []}});
    assert.equal(stoppedBy(null, ['C001', true]).stoppedBy, 'NO_TAX_COLUMN');

    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], excludedColumns: [7],
      taxTabs: {marks: [], flags: []}});
    assert.equal(stoppedBy(null, ['C001', true]).stoppedBy, 'NO_TAX_COLUMN');

    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    const customerSheet = master('顧客マスター');
    const customerRows = customerSheet.getDataRange().getValues();
    const customerRow = customerRows.findIndex((row) => String(row[0]) === 'C001') + 1;
    customerSheet.getRange(customerRow, 31).setValue('{}');
    assert.equal(stoppedBy(null, ['C001', true]).stoppedBy, 'HEADER_EXPECTATION_MISSING');

    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    gas.stubs.createFolder('parent2', {fileIds: ['dest1']});
    assert.equal(stoppedBy(null, ['C001', true]).stoppedBy, 'TEMPLATE_MISSING');

    twoCopies18World();
    gas.stubs.resetWriteLog();
    const beforeAudit = auditLastRow();
    const asText = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', 'true']));
    assert.equal(asText.stoppedBy, null);
    assert.equal(asText.applied, false);
    assert.deepEqual(asText.counts,
      {alreadySet: 0, needsUpdate: 2, skipped: 0, applied: 0, notReached: 0, beforeStart: 0});
    const asOne = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', 1]));
    assert.equal(asOne.stoppedBy, null);
    assert.equal(asOne.applied, false);
    assert.deepEqual(gas.stubs.getWriteLog(), [], 'apply は真偽の true だけ');
    assert.equal(auditLastRow(), beforeAudit);
    assert.deepEqual(Array.from(destSheet('copyA').getRange(5, 7, 26, 1)
      .getDataValidations()[0][0].getCriteriaValues()[0]), ['旧い一覧']);
  });

  test('gt 18: §9.6 報告・ログ・監査に顧客名・転記シートの名前・取引の値を出さない', () => {
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    createCopy18('copyA', COPY_PREFIX_18 + '20261001-1200', {
      groups: [{from: 5, rows: 26, rule: oldRule18(['旧い一覧'], false)}]
    });
    place18('parent', ['dest1', 'copyA']);
    tx18({id: 'GT18_SECRET', destinationId: 'copyA', merchant: '架空秘密店',
      purpose: '架空秘密用途', amount: 987654});
    // 取引先名は取引ログの予定値の列（T、v[19]）に置く（店名 P を上書きしない）。
    gas.evaluate('transactionLogSheet_().getRange(2, 20).setValue("架空秘密取引先")');

    gas.stubs.resetWriteLog();
    const report = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
    assert.equal(report.applied, true, JSON.stringify(report));
    const serialized = JSON.stringify(report);
    const logs = gas.stubs.getLogLines().join('\n');
    const audits = JSON.stringify(master('監査ログ').getDataRange().getValues());
    ['架空秘密用途', '架空秘密店', '架空秘密取引先', '987654', '架空顧客',
      COPY_PREFIX_18 + '20261001-1200'].forEach((secret) => {
      assert.ok(serialized.indexOf(secret) < 0, secret + ' must not appear in report');
      assert.ok(logs.indexOf(secret) < 0, secret + ' must not appear in logs');
      assert.ok(audits.indexOf(secret) < 0, secret + ' must not appear in audits');
    });
    assert.equal(gas.evaluate('transactionLogSheet_().getRange(2, 16).getValue()'), '架空秘密店',
      '(n) 店名を上書きしない');
  });

  test('gt 18: §9.6 規則を付けた後に値が変われば VALUES_CHANGED で止め、後の転記シートに書かない', () => {
    twoCopies18World();
    const sheet = destSheet('copyA');
    const proto = Object.getPrototypeOf(sheet.getRange(5, 7));
    const realValidation = proto.setDataValidation;
    proto.setDataValidation = function(validation) {
      const applied = realValidation.call(this, validation);
      if (this.sheet.getParent().getId() === 'copyA' && this.getRow() === 5 &&
          this.getColumn() === 7 && this.getNumRows() === 26) {
        this.sheet.getRange(6, 7).setValue('規則の後に変わった値');
      }
      return applied;
    };
    try {
      gas.stubs.resetWriteLog();
      const beforeAudit = auditLastRow();
      const report = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
      assert.equal(report.stoppedBy, 'VALUES_CHANGED');
      assert.equal(report.applied, false);
      assert.deepEqual(report.counts,
        {alreadySet: 0, needsUpdate: 1, skipped: 0, applied: 0, notReached: 1, beforeStart: 0});
      assert.equal(report.copies[0].spreadsheetId, 'copyA');
      assert.equal(report.copies[0].status, 'NEEDS_UPDATE');
      assert.equal(report.copies[0].problem, 'VALUES_CHANGED');
      assert.equal(report.copies[0].verified, false);
      assert.equal(report.copies[1].status, 'NOT_REACHED');
      assert.equal(dataRuleWrites18('copyB').length, 0, '後の枚に書かない');
      const auditRows = master('監査ログ').getDataRange().getValues()
        .filter((row) => row[11] === 'TAX_VALIDATION_COPY');
      assert.equal(auditRows.length, 1, '監査は書く');
      assert.deepEqual(report.auditIds, [auditRows[0][0]], '止まった組の監査 ID も残す');
      const before = JSON.parse(String(auditRows[0][9]));
      assert.ok(before.groups.length > 0);
      before.groups.forEach((group) => {
        assert.equal(Object.prototype.hasOwnProperty.call(group, 'key'), false,
          '監査の before に key を出さない');
      });
      assert.ok(auditLastRow() > beforeAudit);
    } finally {
      proto.setDataValidation = realValidation;
    }
  });

  test('gt 18: §9.6 規則の書込が失敗したら WRITE_FAILED で止め、後の転記シートに書かない', () => {
    twoCopies18World();
    const sheet = destSheet('copyA');
    const proto = Object.getPrototypeOf(sheet.getRange(5, 7));
    const realValidation = proto.setDataValidation;
    proto.setDataValidation = function(validation) {
      if (this.sheet.getParent().getId() === 'copyA' && this.getRow() === 5 &&
          this.getColumn() === 7 && this.getNumRows() === 26) {
        throw new Error('write down');
      }
      return realValidation.call(this, validation);
    };
    try {
      gas.stubs.resetWriteLog();
      const beforeAudit = auditLastRow();
      const report = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
      assert.equal(report.stoppedBy, 'WRITE_FAILED');
      assert.equal(report.applied, false);
      assert.deepEqual(report.counts,
        {alreadySet: 0, needsUpdate: 1, skipped: 0, applied: 0, notReached: 1, beforeStart: 0});
      assert.equal(report.copies[0].spreadsheetId, 'copyA');
      assert.equal(report.copies[0].status, 'NEEDS_UPDATE');
      assert.equal(report.copies[0].problem, 'WRITE_FAILED');
      assert.equal(report.copies[1].status, 'NOT_REACHED');
      assert.equal(dataRuleWrites18('copyB').length, 0, '後の枚に書かない');
      const auditRows = master('監査ログ').getDataRange().getValues()
        .filter((row) => row[11] === 'TAX_VALIDATION_COPY');
      assert.equal(auditRows.length, 1, '監査は先に書く');
      assert.deepEqual(report.auditIds, [auditRows[0][0]], '書けなかった組の監査 ID も残す');
      assert.ok(auditLastRow() > beforeAudit);
      assert.deepEqual(Array.from(destSheet('copyA').getRange(5, 7, 26, 1)
        .getDataValidations()[0][0].getCriteriaValues()[0]), ['旧い一覧'], '規則は変わらない');
    } finally {
      proto.setDataValidation = realValidation;
    }
  });

  test('gt 18: §9.6 見るだけでも時間の予算を見て残りを開かず、resumeAfter から続きを回す', () => {
    threeCopies18World();
    const realNow = gas.context.Date.now;
    const realCheck = gas.context.taxOpsCopyCheck_;
    let now = 5000000;
    let advanced = false;
    gas.context.Date.now = () => now;
    gas.context.taxOpsCopyCheck_ = function(copy) {
      const result = realCheck.apply(this, arguments);
      if (!advanced && copy.spreadsheetId === 'copyA') {
        advanced = true;
        // 既定の 180000 を超え、1.3 の 240000 では超えない大きさ。
        now += 200000;
      }
      return result;
    };
    try {
      gas.stubs.resetWriteLog();
      gas.stubs.resetDriveOps();
      const first = plain(call('opsSetCopiesTaxCategoryValidation', ['C001']));
      assert.equal(first.stoppedBy, 'TIME_BUDGET');
      assert.equal(first.applied, false);
      assert.deepEqual(first.counts,
        {alreadySet: 0, needsUpdate: 1, skipped: 0, applied: 0, notReached: 2, beforeStart: 0});
      assert.equal(first.resumeAfter, 'copyA');
      assert.equal(first.startAfter, null);
      assert.deepEqual(first.copies.map((copy) => copy.spreadsheetId),
        ['copyA', 'copyB', 'copyC']);
      assert.equal(first.copies[1].status, 'NOT_REACHED');
      assert.equal(first.copies[2].status, 'NOT_REACHED');
      assert.equal(gas.stubs.getOpenedSpreadsheetIds().indexOf('copyB'), -1,
        '予算の後の組は開かない');
      assert.equal(gas.stubs.getOpenedSpreadsheetIds().indexOf('copyC'), -1,
        '予算の後の組は開かない');
      const filesOpened = gas.stubs.getDriveOps()
        .filter((item) => item.op === 'getFileById').map((item) => item.id);
      assert.equal(filesOpened.indexOf('copyB'), -1, '予算の後の組は開かない');
      assert.equal(filesOpened.indexOf('copyC'), -1, '予算の後の組は開かない');
      assert.deepEqual(gas.stubs.getWriteLog(), [], '見るだけは書かない');
    } finally {
      gas.context.Date.now = realNow;
      gas.context.taxOpsCopyCheck_ = realCheck;
    }

    // 前の回の resumeAfter から続きを回す（扱い終えた組は開かない）。
    gas.stubs.resetDriveOps();
    const rest = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', false,
      {startAfter: 'copyA'}]));
    assert.equal(rest.stoppedBy, null);
    assert.equal(rest.startAfter, 'copyA');
    assert.equal(rest.resumeAfter, null);
    assert.equal(rest.counts.beforeStart, 1);
    assert.deepEqual(rest.copies.map((copy) => copy.spreadsheetId), ['copyB', 'copyC']);
    assert.equal(rest.copies[0].status, 'NEEDS_UPDATE');
    assert.equal(rest.copies[1].status, 'ALREADY_SET');
    assert.equal(gas.stubs.getOpenedSpreadsheetIds().indexOf('copyA'), -1,
      'startAfter の組は開かない');
    assert.equal(gas.stubs.getDriveOps().filter((item) => item.op === 'getFileById')
      .map((item) => item.id).indexOf('copyA'), -1, 'startAfter の組は開かない');
  });

  test('gt 18: §9.6 apply は書いた後に予算で止まり、resumeAfter から残りだけを書く', () => {
    twoCopies18World();
    const realNow = gas.context.Date.now;
    const realCheck = gas.context.taxOpsCopyCheck_;
    let now = 6000000;
    let advanced = false;
    gas.context.Date.now = () => now;
    gas.context.taxOpsCopyCheck_ = function(copy) {
      const result = realCheck.apply(this, arguments);
      if (!advanced && copy.spreadsheetId === 'copyA') {
        advanced = true;
        now += 200000;
      }
      return result;
    };
    try {
      gas.stubs.resetWriteLog();
      const first = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
      assert.equal(first.stoppedBy, 'TIME_BUDGET');
      assert.equal(first.applied, false, '止まった回は applied にしない');
      assert.deepEqual(first.counts,
        {alreadySet: 0, needsUpdate: 0, skipped: 0, applied: 1, notReached: 1, beforeStart: 0});
      assert.equal(first.copies[0].status, 'APPLIED');
      assert.equal(first.copies[0].verified, true);
      assert.equal(first.copies[1].status, 'NOT_REACHED');
      assert.equal(first.auditIds.length, 1);
      assert.equal(first.resumeAfter, 'copyA');
      assert.equal(dataRuleWrites18('copyB').length, 0, '残りは書かない');
      copyRules18(destSheet('copyA'), false);
      assert.deepEqual(Array.from(destSheet('copyB').getRange(5, 7, 26, 1)
        .getDataValidations()[0][0].getCriteriaValues()[0]), ['別の旧い一覧']);
    } finally {
      gas.context.Date.now = realNow;
      gas.context.taxOpsCopyCheck_ = realCheck;
    }

    const auditBefore = master('監査ログ').getDataRange().getValues()
      .filter((row) => row[11] === 'TAX_VALIDATION_COPY').length;
    gas.stubs.resetWriteLog();
    gas.stubs.resetDriveOps();
    const rest = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true,
      {startAfter: 'copyA'}]));
    assert.equal(rest.stoppedBy, null);
    assert.equal(rest.applied, true, JSON.stringify(rest));
    assert.deepEqual(rest.counts,
      {alreadySet: 0, needsUpdate: 0, skipped: 0, applied: 1, notReached: 0, beforeStart: 1});
    assert.deepEqual(rest.copies.map((copy) => copy.spreadsheetId), ['copyB']);
    assert.equal(rest.auditIds.length, 1);
    copyRules18(destSheet('copyB'), true);
    assert.equal(gas.stubs.getOpenedSpreadsheetIds().indexOf('copyA'), -1,
      'startAfter の組は開かない');
    assert.equal(gas.stubs.getDriveOps().filter((item) => item.op === 'getFileById')
      .map((item) => item.id).indexOf('copyA'), -1, 'startAfter の組は開かない');
    assert.equal(master('監査ログ').getDataRange().getValues()
      .filter((row) => row[11] === 'TAX_VALIDATION_COPY').length, auditBefore + 1);
  });

  /** 同じ ID でシート名だけ違う 2 組（§9.6.2）。 */
  function createTwoSheetCopy18(id, name, sheetNames) {
    gas.stubs.createSpreadsheet(id, {name: name, sheets: sheetNames.map((sheetName) => ({
      name: sheetName, values: copy18Values(), maxRows: 30, maxColumns: 30}))});
    sheetNames.forEach((sheetName) => {
      gas.stubs.getSpreadsheet(id).getSheetByName(sheetName)
        .getRange(5, 7, 26, 1).setDataValidation(oldRule18(['旧い一覧'], false));
    });
  }

  test('gt 18: §9.6 同じ ID でシート名が 2 つの組は時間の境目でも分けずに扱う', () => {
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    createTwoSheetCopy18('copyPair', COPY_PREFIX_18 + '20261007-1800', ['A', 'B']);
    place18('parent', ['dest1', 'copyPair']);
    tx18({id: 'GT18_PAIR_A', destinationId: 'copyPair', destinationSheet: 'A', status: 'PREPARED'});
    tx18({id: 'GT18_PAIR_B', destinationId: 'copyPair', destinationSheet: 'B', status: 'COMMITTED'});

    const realNow = gas.context.Date.now;
    const realCheck = gas.context.taxOpsCopyCheck_;
    let now = 7000000;
    let advanced = false;
    gas.context.Date.now = () => now;
    gas.context.taxOpsCopyCheck_ = function(copy) {
      const result = realCheck.apply(this, arguments);
      if (!advanced) {
        advanced = true;
        now += 200000;
      }
      return result;
    };
    try {
      gas.stubs.resetDriveOps();
      const report = plain(call('opsSetCopiesTaxCategoryValidation', ['C001']));
      assert.equal(report.stoppedBy, null, JSON.stringify(report));
      assert.deepEqual(report.copies.map((copy) => copy.spreadsheetId),
        ['copyPair', 'copyPair']);
      assert.deepEqual(report.copies.map((copy) => copy.sheetName), ['A', 'B']);
      assert.equal(report.copies[0].status, 'NEEDS_UPDATE');
      assert.equal(report.copies[1].status, 'NEEDS_UPDATE', '同じ ID は時間を見ずに続ける');
      assert.equal(report.counts.needsUpdate, 2);
      assert.equal(report.counts.notReached, 0);
      assert.equal(report.resumeAfter, null);
      assert.equal(gas.stubs.getOpenedSpreadsheetIds()
        .filter((id) => id === 'copyPair').length, 2);
    } finally {
      gas.context.Date.now = realNow;
      gas.context.taxOpsCopyCheck_ = realCheck;
    }
  });

  test('gt 18: §9.6 timeBudgetMs の読み方（省略・数でない → 180000、負 → 0）', () => {
    assert.equal(call('taxOpsCopyBudget_', [undefined]), 180000);
    assert.equal(call('taxOpsCopyBudget_', [{}]), 180000);
    assert.equal(call('taxOpsCopyBudget_', [{timeBudgetMs: '180000'}]), 180000);
    assert.equal(call('taxOpsCopyBudget_', [{timeBudgetMs: NaN}]), 180000);
    assert.equal(call('taxOpsCopyBudget_', [{timeBudgetMs: Infinity}]), 180000);
    assert.equal(call('taxOpsCopyBudget_', [{timeBudgetMs: -1}]), 0);
    assert.equal(call('taxOpsCopyBudget_', [{timeBudgetMs: 0}]), 0);
    assert.equal(call('taxOpsCopyBudget_', [{timeBudgetMs: 1234}]), 1234);
  });

  test('gt 18: §9.6 ALREADY_SET の組ではロックを取らず、NEEDS_UPDATE だけ 1 組 1 回', () => {
    threeCopies18World();
    const lock = gas.stubs.getScriptLock();
    lock.reset();
    const report = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
    assert.equal(report.stoppedBy, null);
    assert.equal(report.applied, true, JSON.stringify(report));
    assert.equal(lock.tryCount, 2, 'NEEDS_UPDATE の 2 枚だけロックを取る');

    lock.reset();
    const again = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
    assert.deepEqual(again.counts,
      {alreadySet: 3, needsUpdate: 0, skipped: 0, applied: 0, notReached: 0, beforeStart: 0});
    assert.equal(lock.tryCount, 0, 'ALREADY_SET ではロックを取らない');
  });

  test('gt 18: §9.6 ALREADY_SET はその組の allowInvalid で見て、並び・欠け・読めない値は NEEDS_UPDATE', () => {
    function oneCopyWithRule(rule) {
      setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
      createCopy18('copyA', COPY_PREFIX_18 + '20261008-1900', {
        gValues: {5: '架空の値'},
        groups: [{from: 5, rows: 26, rule: rule}]
      });
      place18('parent', ['dest1', 'copyA']);
      tx18({id: 'GT18_ALREADY', destinationId: 'copyA'});
      return plain(call('opsSetCopiesTaxCategoryValidation', ['C001']));
    }

    const reversed = oneCopyWithRule(oldRule18(names18().slice().reverse(), false));
    assert.equal(reversed.copies[0].status, 'NEEDS_UPDATE', '並びが違う');
    assert.equal(reversed.copies[0].allowInvalid, false);

    const missing = oneCopyWithRule(oldRule18(names18().slice(0, 29), false));
    assert.equal(missing.copies[0].status, 'NEEDS_UPDATE', '1 つ足りない');

    const unreadable = {
      getCriteriaType() { return 'VALUE_IN_LIST'; },
      getCriteriaValues() { return [names18().slice()]; },
      getAllowInvalid() { throw new Error('Range not found'); }
    };
    const seen = oneCopyWithRule(unreadable);
    assert.equal(seen.copies[0].status, 'NEEDS_UPDATE', '組の allowInvalid が読めない');
    assert.equal(seen.copies[0].allowInvalid, true, '付けるのは警告のみ');

    const applied = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
    assert.equal(applied.applied, true, JSON.stringify(applied));
    copyRules18(destSheet('copyA'), true);
    assert.equal(destSheet('copyA').getRange(5, 7).getValue(), '架空の値', '値を変えない');
  });

  test('gt 18: §9.6 想定外の例外は報告をログに出してから投げ直す', () => {
    twoCopies18World();
    const realApply = gas.context.taxOpsCopyApply_;
    gas.context.taxOpsCopyApply_ = function(copy) {
      if (copy.spreadsheetId === 'copyB') throw new Error('unexpected');
      return realApply.apply(this, arguments);
    };
    try {
      gas.stubs.resetWriteLog();
      gas.stubs.clearLogs();
      let thrown = null;
      try {
        call('opsSetCopiesTaxCategoryValidation', ['C001', true]);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, '例外を投げ直す');
      assert.equal(String(thrown.message), 'unexpected');

      const logged = gas.stubs.getLogLines()
        .filter((line) => String(line).indexOf('{"applied"') === 0);
      assert.equal(logged.length, 1, '報告をログに 1 回出す');
      const report = JSON.parse(logged[0]);
      assert.equal(report.stoppedBy, 'UNEXPECTED_ERROR');
      assert.equal(report.copies[0].status, 'APPLIED');
      assert.equal(report.copies[1].status, 'NOT_REACHED');
      assert.equal(report.auditIds.length, 1);
      const audits = master('監査ログ').getDataRange().getValues()
        .filter((row) => row[11] === 'TAX_VALIDATION_COPY');
      assert.equal(audits.length, 1, 'APPLIED の監査は残る');
      assert.equal(report.auditIds[0], audits[0][0]);
      assert.equal(dataRuleWrites18('copyB').length, 0, '残りは書かない');
    } finally {
      gas.context.taxOpsCopyApply_ = realApply;
    }
  });

  test('gt 18: §9.6 取引ログが読めない・顧客の設定が不正なら止める', () => {
    twoCopies18World();
    const realFind = gas.context.findRowsByColumnValues_;
    gas.context.findRowsByColumnValues_ = function() { throw new Error('tx log down'); };
    try {
      gas.stubs.resetWriteLog();
      const report = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
      assert.equal(report.stoppedBy, 'TRANSACTION_LOG_UNREADABLE');
      assert.equal(report.copies.length, 0);
      assert.deepEqual(gas.stubs.getWriteLog(), []);
    } finally {
      gas.context.findRowsByColumnValues_ = realFind;
    }

    twoCopies18World();
    const realOpsCustomer = gas.context.taxOpsCustomer_;
    gas.context.taxOpsCustomer_ = function(customerId) {
      const found = realOpsCustomer.apply(this, arguments);
      return found ? Object.assign({}, found, {headerRow: 0}) : found;
    };
    try {
      gas.stubs.resetWriteLog();
      const invalid = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
      assert.equal(invalid.stoppedBy, 'TEMPLATE_INVALID');
      assert.deepEqual(gas.stubs.getWriteLog(), []);
    } finally {
      gas.context.taxOpsCustomer_ = realOpsCustomer;
    }
  });

  test('gt 18: §9.6 組の NO_ROWS・READ_FAILED は SKIPPED にしてほかを続け、読めない取引は数える', () => {
    // NO_ROWS（行が headerRow + 1 より少ない）→ SKIPPED、次の組は書く。
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    const noRows = createCopy18('copyA', COPY_PREFIX_18 + '20261009-1000', {
      groups: [{from: 5, rows: 26, rule: oldRule18(['旧い一覧'], false)}]
    });
    noRows.maxRows = 4;
    createCopy18('copyB', COPY_PREFIX_18 + '20261009-1100', {
      groups: [{from: 5, rows: 26, rule: oldRule18(['別の旧い一覧'], false)}]
    });
    place18('parent', ['dest1', 'copyA', 'copyB']);
    tx18({id: 'GT18_NOROWS', destinationId: 'copyA'});
    tx18({id: 'GT18_GOOD_ROWS', destinationId: 'copyB'});
    gas.stubs.resetWriteLog();
    const report = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
    assert.equal(report.applied, true, JSON.stringify(report));
    assert.equal(report.copies[0].status, 'SKIPPED');
    assert.equal(report.copies[0].problem, 'NO_ROWS');
    assert.equal(report.copies[1].status, 'APPLIED');
    assert.equal(dataRuleWrites18('copyA').length, 0);

    // READ_FAILED（組の G の読み取りが投げる）→ SKIPPED、次の組は書く。
    twoCopies18World();
    const sheet = destSheet('copyA');
    const proto = Object.getPrototypeOf(sheet.getRange(5, 7));
    const realValidations = proto.getDataValidations;
    proto.getDataValidations = function() {
      if (this.sheet.getParent().getId() === 'copyA') throw new Error('read down');
      return realValidations.call(this);
    };
    try {
      gas.stubs.resetWriteLog();
      const readFailed = plain(call('opsSetCopiesTaxCategoryValidation', ['C001', true]));
      assert.equal(readFailed.applied, true, JSON.stringify(readFailed));
      assert.equal(readFailed.copies[0].status, 'SKIPPED');
      assert.equal(readFailed.copies[0].problem, 'READ_FAILED');
      assert.equal(readFailed.copies[1].status, 'APPLIED');
      assert.equal(dataRuleWrites18('copyA').length, 0);
    } finally {
      proto.getDataValidations = realValidations;
    }

    // 取引ログの 1 行が読めない → unreadableTransactions に数え、ほかは続ける。
    twoCopies18World();
    const realTx = gas.context.txLogFromRecord_;
    gas.context.txLogFromRecord_ = function(record) {
      if (record && record.values && String(record.values[0]) === 'GT18_UNREADABLE') {
        throw new Error('record down');
      }
      return realTx.apply(this, arguments);
    };
    tx18({id: 'GT18_UNREADABLE', destinationId: 'copyA'});
    try {
      const unreadable = plain(call('opsSetCopiesTaxCategoryValidation', ['C001']));
      assert.equal(unreadable.stoppedBy, null);
      assert.equal(unreadable.unreadableTransactions, 1);
      assert.equal(unreadable.transactions, 2);
      assert.equal(unreadable.counts.needsUpdate, 2);
    } finally {
      gas.context.txLogFromRecord_ = realTx;
    }
  });

  test('gt 18: §9.6 otherValueRowCount は総数で、otherValueRows は 20 まで', () => {
    setupWorld({accounts: GT_ACCOUNTS, sheetEntries: [], taxTabs: {marks: [], flags: []}});
    const gValues = {};
    for (let row = 5; row <= 26; row += 1) gValues[row] = '架空不明値' + row;
    createCopy18('copyA', COPY_PREFIX_18 + '20261009-1200', {
      gValues: gValues,
      groups: [{from: 5, rows: 26, rule: oldRule18(['旧い一覧'], false)}]
    });
    place18('parent', ['dest1', 'copyA']);
    tx18({id: 'GT18_OTHER_ROWS', destinationId: 'copyA'});

    const report = plain(call('opsSetCopiesTaxCategoryValidation', ['C001']));
    const copy = report.copies[0];
    assert.equal(copy.valueRows, 22);
    assert.equal(copy.otherValueRowCount, 22);
    assert.equal(copy.otherValueRows.length, 20);
    assert.equal(copy.otherValueRows[0], 5);
    assert.equal(copy.otherValueRows[19], 24);
    assert.equal(copy.otherValues.length, 10);
  });
};

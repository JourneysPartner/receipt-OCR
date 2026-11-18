'use strict';

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
      ['食品', '食材', '食料品', '食料']);
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
};

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 家族カードの名義人ごとの小計行（2026-10-03、ドコモカード 11 列の実明細）。
 *
 * 末尾に「＜甲野 太郎 様」のような行がある：日付・店名・用途は空で、利用金額の
 * 列に名義人の名前、支払い金額の列に小計が入る。除外の規則が「日付と金額が
 * 両方空」だけだと、金額の列の名前の文字で除外されず、店名も用途も無い取引に
 * なってファイルごと要修正（区分1）に落ちた（本番で 11 本）。
 */
module.exports = ({test, assert, gas}) => {
  const revive = (value) => value && typeof value === 'object' && value.__date__ ?
    new Date(value.__date__) : value;
  function fixture() {
    const file = path.join(__dirname, 'fixtures', 'family-subtotal',
      'ドコモカード__ご利用内訳明細_キャッシングご返済明細_20251010.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {name: raw.sheets[0].name, rows: raw.sheets[0].rows.map((row) => row.map(revive))};
  }
  // 本番の `docomo_family_x11`（2026-10-03 16:04 に画面から登録）と同じ定義。
  const DOCOMO_X11 = {
    formatId: 'docomo_family_x11', version: 1, parserKind: 'generic', status: 'active',
    enabled: true, valid: true, fileTypes: ['xlsx'], headerRow: 2, dataStartRow: 3,
    dateColumn: 'D', merchantColumn: 'E', amountColumn: 'F', purposeColumn: 'K',
    amountFallbackColumn: null, dateAltColumn: null, foreignCurrencyColumn: null,
    foreignAmountColumn: null, exchangeRateColumn: null,
    sectionBreakRule: {patterns: ['キャッシングご返済明細']},
    exclusionRule: {excludeWhenDateAndAmountEmpty: true, rules: [],
      excludeRowRanges: [{from: 1, to: 2}]},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    billingRule: {sources: [{id: 'fn_ymd', kind: 'fileName',
      pattern: '_(20\\d{2})(1[0-2]|0[1-9])[0-3]\\d', groups: {year: 1, month: 2},
      yearDigits: 4, means: 'payment', offsetMonths: 1}]},
    cardNameRule: {sources: [{kind: 'folderName'}]}
  };
  const plain = (value) => JSON.parse(JSON.stringify(value));
  function parse(format) {
    return plain(gas.call('parseFile', [fixture(), format || DOCOMO_X11,
      {customerId: 'C001', fileId: 'family_subtotal', fileNameOriginal:
        'ご利用内訳明細_キャッシングご返済明細_20251010.xlsx', fileRevision: '', regeneration: 0}]));
  }
  function exclusion(row, format) {
    return plain(gas.call('applyExclusionRules', [row, 30, format || DOCOMO_X11]));
  }
  // D 日付・E 店名・F 利用金額・G 支払い金額・K 使用用途（0 起算で 3・4・5・6・10）。
  function row(cells) {
    const out = Array(11).fill('');
    Object.keys(cells).forEach((index) => { out[Number(index)] = cells[index]; });
    return out;
  }

  test('subtotal 1: 名義人ごとの小計行は取引にならず、全部の明細行が取引になる', () => {
    const parsed = parse();
    const rows = fixture().rows;
    // 読取は「キャッシングご返済明細」の見出しで止まる（その下の 0 は日付ではない）。
    const sectionBreak = rows.findIndex((cells) => String(cells[0]).trim() === 'キャッシングご返済明細');
    const detailRows = rows.filter((cells, index) => index >= 2 && index < sectionBreak &&
      gas.call('interpretDateExpression', [cells[3]]).ok);
    assert.equal(detailRows.length, 24, '前提：この明細の明細行は 24 行');
    assert.equal(parsed.txs.length, detailRows.length, '日付のある明細行の数だけ取引ができる');
    assert.deepEqual(parsed.txs.filter((tx) => String(tx.merchantOriginal).trim() === ''), [],
      '店名の無い取引ができていない');
    assert.deepEqual(parsed.txs.filter((tx) => String(tx.purpose).trim() === ''), [],
      '用途の無い取引ができていない（この明細は全行に用途がある）');
    const holderRows = parsed.excludedRows.filter((entry) => entry.ruleId === '_noTransactionValue');
    assert.equal(holderRows.length, 2, JSON.stringify(parsed.excludedRows));
  });

  test('subtotal 2: 小計行が消えれば、用途の空欄も店名の空欄も無く、区分1にならない', () => {
    const parsed = parse();
    const issues = plain(gas.call('validateTransactions', [parsed.txs, {cardFormat: DOCOMO_X11}]));
    const customerFix = (issues.issues || []).filter((issue) =>
      issue.customerFix === true || issue.kind === 'MERCHANT_REQUIRED');
    assert.deepEqual(customerFix, []);
  });

  test('subtotal 3: 除くのは「日付・店名・用途が空で、金額の列が数でない」行だけ', () => {
    const holder = row({5: '＜甲野　太郎　様', 6: 270135});
    assert.deepEqual(exclusion(holder), {excluded: true, ruleId: '_noTransactionValue'});
    // 金額の列が数として読めるなら、日付・店名・用途が空でも黙って落とさない
    // （本物の取引を落とすと過少計上になり、どこにも出ない）。
    assert.equal(exclusion(row({5: 270135})).excluded, false);
    assert.equal(exclusion(row({5: '1,200'})).excluded, false);
    // 店名がある（会員値引のように日付の無い本物の取引）なら落とさない。
    assert.equal(exclusion(row({4: '会員値引（１回払い ￥５，４５６分）', 5: '＜甲野　太郎　様'})).excluded, false);
    // 用途が書いてあるなら落とさない（顧客が取引のつもりで書いた行）。
    assert.equal(exclusion(row({5: '＜甲野　太郎　様', 10: '仕入れ'})).excluded, false);
    // 日付があるなら落とさない。
    assert.equal(exclusion(row({3: '2025/09/01', 5: '＜甲野　太郎　様'})).excluded, false);
  });

  test('subtotal 4: 形式ごとに止められ、用途の列が無い形式でも同じ規則で判定する', () => {
    const off = Object.assign({}, DOCOMO_X11, {exclusionRule: Object.assign({},
      DOCOMO_X11.exclusionRule, {excludeWhenNoTransactionValue: false})});
    assert.equal(exclusion(row({5: '＜甲野　太郎　様'}), off).excluded, false);
    const noPurpose = Object.assign({}, DOCOMO_X11, {purposeColumn: null});
    assert.deepEqual(exclusion(row({5: '＜甲野　太郎　様', 10: '仕入れ'}), noPurpose),
      {excluded: true, ruleId: '_noTransactionValue'});
  });

  test('subtotal 5: 形式の登録画面は、この除外の理由を日本語で言う', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', '81_WebAppUi.html'), 'utf8');
    const script = /<script>([\s\S]*?)<\/script>/.exec(source)[1];
    const needle = "    el['customer-search'].addEventListener";
    const probe = "    globalThis.__reason = formatExcludedReason('_noTransactionValue');\n    return;\n";
    const sandbox = {document: {getElementById() { return {}; }}};
    require('node:vm').runInNewContext(script.replace(needle, probe + needle), sandbox);
    assert.match(sandbox.__reason, /名義人ごとの小計/);
  });
};

'use strict';

/**
 * メモタグ（転記先I列）の合成。
 *
 * I列の見出しは「メモタグ（複数指定可、カンマ区切り）」であり、これまでは
 * 使用用途だけを転記していた。運用上、明細の性質を後から絞り込める印が要る：
 *   - **海外決済**：換算レートを伴う取引。税務上の扱いが国内と異なる。
 *   - **キャッシュバック**：カード会社からの返金。相手税区分も「対象外」。
 *
 * 要点は**使用用途を消さないこと**。タグで上書きすると、何に使った支出かが
 * 帳簿から失われる。カンマ区切りで足す。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const blank = (n) => Array(n).fill('');
  const sheetHeader = (n, label) => { const r = blank(n); r[0] = label; return r; };
  const AE = JSON.stringify({row: 1, cells: [{column: 2, text: '利用日', match: 'exact'}]});

  function customerRow(options) {
    const row = blank(42);
    Object.assign(row, {
      0: 'C001', 1: '顧客A', 2: 'TRUE', 3: 'folder1', 5: 'dest1', 7: '入力用シート', 8: '取引先一覧',
      9: 2, 10: 3, 11: 4, 12: 5, 13: 6, 14: 7, 15: '1.0',
      16: 'reviewer@example.com', 17: 'admin@example.com', 18: 0, 20: 'システム情報', 21: '',
      23: 0, 24: 0, 29: 1, 30: AE, 31: '{}', 32: '{}', 33: 8,
      34: '取引先一覧', 35: 'CORPORATE', 36: '',
      40: options && options.cashbackMerchants
        ? JSON.stringify(options.cashbackMerchants) : '',
      41: options && options.taxColumn ? options.taxColumn : ''
    });
    return row;
  }

  /** 換算レートを摘要に埋める形式（オリコ系）と、通貨列を持つ形式の両方。 */
  function formatRow(options) {
    const row = blank(37);
    Object.assign(row, {
      0: 'probe', 1: '検査用', 2: 'active', 3: 'TRUE', 4: '["csv"]',
      5: JSON.stringify({allOf: [{maxRow: 1, keywords: ['利用日', '利用店名', '金額', '使用用途'], minMatch: 4}]}),
      6: 1, 7: 2, 8: 'A', 9: 'B', 10: 'C', 11: 'D', 12: '',
      14: JSON.stringify({excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []}),
      16: JSON.stringify({sources: [{id: 'fn', kind: 'fileName', pattern: '(20\\d{2})(1[0-2]|0[1-9])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}]}),
      17: 'generic', 18: 1, 19: 'admin@example.com', 21: '2026-01-01T00:00:00+09:00',
      29: 'NEW', 33: '2026-01-01T00:00:00+09:00'
    });
    if (options && options.currencyColumns) {
      row[30] = 'E';   // AE：通貨コード列
      row[31] = 'F';   // AF：現地金額列
      row[32] = 'G';   // AG：換算レート列
    }
    return row;
  }

  function setup(options) {
    options = options || {};
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [sheetHeader(42, '顧客ID'), customerRow(options)]},
      {name: 'カード形式マスター', values: [sheetHeader(37, '形式ID'), formatRow(options)]},
      {name: '使用用途補完マスター', values: [sheetHeader(10, 'ルールID')]},
      {name: '共通取引先辞書', values: [sheetHeader(18, '辞書ID'),
        Object.assign(blank(18), {0: 'DICT_1', 1: 'ローソン', 2: 'ローソン', 3: '株式会社ローソン',
          4: 'exact_original', 5: 1, 9: 'TRUE', 10: 'admin@example.com',
          12: '2026-01-01T00:00:00+09:00', 13: 1, 14: 'TRUE', 15: 'FALSE'})]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート',
       values: [['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID', '税区分']],
       maxRows: 40, maxColumns: 8},
      {name: '取引先一覧', values: [['元店名', '取引先名'], ['ローソン', '株式会社ローソン']]}
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

    gas.stubs.createFile('fileA', {
      name: '明細202601.csv', bytes: Buffer.from(options.csv, 'utf8'),
      lastUpdated: new Date(Date.now() - 3600 * 1000),
      createdTime: '2026-08-01T00:00:00Z', contentType: 'text/csv'
    });
    gas.stubs.createFolder('folder1', {fileIds: ['fileA']});
    return plain(gas.call('runImport', [{}]));
  }

  /** 転記先の行を、内部ID列（G＝7列目）が埋まっている行だけ拾う。 */
  function writtenRows() {
    return gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート')
      .getDataRange().getValues().slice(1)
      .filter((r) => String(r[6] || '').indexOf('TX_') === 0);
  }

  test('a normal transaction still carries only its purpose', () => {
    // 既定の挙動を変えない。タグ合成を入れた副作用で全行に何かが付いたら、
    // 帳簿のメモタグが使い物にならなくなる。
    setup({csv: '利用日,利用店名,金額,使用用途\n2025/12/16,ローソン,10800,仕入れ\n'});
    const rows = writtenRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0][3], '仕入れ', 'タグを足す理由がなければ用途だけ');
  });

  test('a settlement showing an exchange rate is tagged 海外決済', () => {
    // オリコ系は換算レートを摘要そのものへ埋める（通貨列を持たない）。
    setup({csv: '利用日,利用店名,金額,使用用途\n' +
      '2025/12/16,ＯＰＥＮＡＩ　＊ＣＨＡＴＧＰＴ　２２．００　換算レート／　１６２．６８１９円,3579,ツール代\n'});
    const rows = writtenRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0][3], 'ツール代,海外決済',
      '用途を残したままタグを足すこと（上書きすると使途が帳簿から消える）');
  });

  test('a settlement with a currency column is tagged too', () => {
    // 通貨列を持つ形式（JCB系など）でも同じ印が付くこと。判定を摘要の
    // 文字列だけに頼ると、列で持つ形式が取りこぼされる。
    setup({currencyColumns: true,
      csv: '利用日,利用店名,金額,使用用途,通貨,現地金額,レート\n' +
        '2025/12/16,ＡＰＰＬＥ．ＣＯＭ,3200,ツール代,USD,22.00,145.45\n'});
    const rows = writtenRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0][3], 'ツール代,海外決済');
  });

  test('a merchant on the cashback list is tagged and needs no partner', () => {
    // カード会社からの返金には相手取引先が無い。毎回「取引先なしで解決」を
    // 押させるのは判断ではなく作業である。
    const report = setup({
      cashbackMerchants: ['利用キャンペーンキャッシュバック', 'ポイント充当分'],
      csv: '利用日,利用店名,金額,使用用途\n' +
        '2025/12/16,利用キャンペ−ンキャッシュバック,-500,返品\n' +
        '2025/12/17,ローソン,10800,仕入れ\n'});
    assert.equal(report.customers[0].files[0].written, 2);

    const rows = writtenRows();
    const cashback = rows.filter((r) => String(r[3]).indexOf('キャッシュバック') >= 0);
    assert.equal(cashback.length, 1);
    assert.equal(cashback[0][3], '返品,キャッシュバック');
    assert.equal(cashback[0][2], '', '取引先は空欄のまま');

    // 要確認は立たない（普通の未登録店舗の分だけ残る）。
    const open = plain(gas.call('openReviews', [{}]));
    assert.ok(open.every((review) => review.merchantOriginal !== '利用キャンペ−ンキャッシュバック'),
      'キャッシュバックで取引先の要確認を立てない');
  });

  test('the cashback list matches through width differences', () => {
    // マスターへ貼り直すと全角半角が揺れる。字面で比べると担当者の設定が
    // 黙って効かなくなる（辞書の照合と同じ正規化で比べる）。
    setup({
      cashbackMerchants: ['ｷｬｯｼｭﾊﾞｯｸ（ﾎﾟｲﾝﾄ交換）'],
      csv: '利用日,利用店名,金額,使用用途\n' +
        '2025/12/16,キャッシュバック（ポイント交換）,-21029,雑収益\n'});
    const rows = writtenRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0][3], '雑収益,キャッシュバック');
  });

  test('composeMemoTags leaves no empty tag when a piece is missing', () => {
    // 用途が空の明細は区分1で顧客へ差し戻されるので取込経路には現れないが、
    // 先頭のカンマはfreeeが空のタグとして読む。合成そのものを検査する。
    assert.equal(gas.call('composeMemoTags', ['', ['キャッシュバック']]),
      'キャッシュバック');
    assert.equal(gas.call('composeMemoTags', [null, ['海外決済']]), '海外決済');
    assert.equal(gas.call('composeMemoTags', ['仕入れ', []]), '仕入れ');
    assert.equal(gas.call('composeMemoTags', ['仕入れ', ['', null]]), '仕入れ');
    assert.equal(gas.call('composeMemoTags', ['', []]), '');
    // 用途そのものがタグ名と同じときに二度書かない。
    assert.equal(gas.call('composeMemoTags', ['キャッシュバック', ['キャッシュバック']]),
      'キャッシュバック');
  });

  test('a cashback row gets 対象外 in the tax category column', () => {
    // カード会社からの返金は課税取引ではない。相手税区分（G列）は、これまで
    // システムが一切書いていなかった列である。
    setup({
      taxColumn: 8,   // 転記先の8列目を相手税区分に割り当てる
      cashbackMerchants: ['ポイント充当分'],
      csv: '利用日,利用店名,金額,使用用途\n' +
        '2025/12/16,ポイント充当分,-1200,雑収益\n' +
        '2025/12/17,ローソン,10800,仕入れ\n'});
    const rows = writtenRows();
    assert.equal(rows.length, 2);
    const cashback = rows.filter((r) => String(r[3]).indexOf('キャッシュバック') >= 0)[0];
    const normal = rows.filter((r) => String(r[3]) === '仕入れ')[0];
    assert.ok(cashback && normal);
    assert.equal(cashback[7], '対象外', 'キャッシュバック行の税区分');
    assert.equal(normal[7], '', '通常行には税区分を書かない');
  });

  test('a row without a tax category never has that column written', () => {
    // 空文字を書くことと**書かないこと**は違う。転記先テンプレートの既定値や
    // 数式が入った列へ空を書けば、それを消す。取込が実際に発行した書込を見て、
    // 税区分列が対象に入っていないことを確かめる。
    const ranges = [];
    gas.stubs.onValuesBatchUpdate((request) => {
      (request.data || []).forEach((entry) => ranges.push(entry.range));
    });
    setup({
      taxColumn: 8,
      cashbackMerchants: ['ポイント充当分'],
      csv: '利用日,利用店名,金額,使用用途\n2025/12/17,ローソン,10800,仕入れ\n'});
    gas.stubs.onValuesBatchUpdate(null);

    const dest = ranges.filter((r) => String(r).indexOf('入力用シート') >= 0);
    assert.ok(dest.length, '転記先への書込があること');
    const touchedTax = dest.filter((r) => /!H\d/.test(String(r)));
    assert.deepEqual(touchedTax, [],
      '税区分を持たない行では、その列のレンジを1つも発行しないこと');
  });

  test('buildRowWrite omits the tax category when the row has none', () => {
    // 空文字を書くことと**書かないこと**は違う。転記先テンプレートの
    // 既定値や数式が入った列へ空を書けば、それを消してしまう。
    const withTax = plain(gas.call('buildRowWrite', [5, {
      fullTxId: 'TX_1',
      planned: {b: '2025-12-16', f: '', i: '雑収益,キャッシュバック',
        k: 'ポイント充当分', m: -1200, g: '対象外'}
    }]));
    assert.equal(withTax.values.g, '対象外');

    const withoutTax = plain(gas.call('buildRowWrite', [6, {
      fullTxId: 'TX_2',
      planned: {b: '2025-12-17', f: '株式会社ローソン', i: '仕入れ',
        k: 'ローソン', m: 10800}
    }]));
    assert.ok(!('g' in withoutTax.values) || withoutTax.values.g === undefined,
      '税区分を持たない行では、その列を書込対象に含めない');
  });

  test('both tags appear when a cashback is also a foreign settlement', () => {
    setup({
      cashbackMerchants: ['海外キャッシュバック　換算レート／　１５０．０円'],
      csv: '利用日,利用店名,金額,使用用途\n' +
        '2025/12/16,海外キャッシュバック　換算レート／　１５０．０円,-500,雑収益\n'});
    const rows = writtenRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0][3], '雑収益,キャッシュバック,海外決済',
      'タグの順序は定めておく（毎回変わると差分が読めない）');
  });
};

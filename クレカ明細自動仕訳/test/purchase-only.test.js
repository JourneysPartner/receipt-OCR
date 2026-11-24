'use strict';

/**
 * 「仕入れ専用」の明細を用途の列なしで読む（サーバー側。spec_purchase_only.md §8）。
 * 値はすべて架空。実在の顧客・カード・明細は使わない。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const blank = (n) => Array(n).fill('');
  const sheetHeader = (n, label) => { const row = blank(n); row[0] = label; return row; };
  const hourAgo = () => new Date(Date.now() - 3600 * 1000);
  const NOW = '2026-01-01T00:00:00+09:00';
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  // 架空の UCS 形（11列・用途K／10列・用途なし）。判定キーワードは
  // `ucs_family` のもの（支払方法コード・支払方法・利用日・加盟店名称・利用金額）。
  const UCS_KEYWORDS = ['支払方法コード', '支払方法', '利用日', '加盟店名称', '利用金額'];
  const UCS_HEADER_10 = UCS_KEYWORDS.concat(['今回請求額', '備考', '区分', '摘要', 'メモ']);
  const UCS_HEADER_11 = UCS_HEADER_10.concat(['使用用途']);

  function ucsRows(withPurpose) {
    const header = (withPurpose ? UCS_HEADER_11 : UCS_HEADER_10).slice();
    const rows = [header];
    for (let index = 0; index < 5; index += 1) {
      const row = ['01', '1回', 20251201 + index, '架空ストア', 1000 + index * 100,
        1000 + index * 100, '', '', '', ''];
      if (withPurpose) row.push(index === 0 ? '返品' : '');
      rows.push(row);
    }
    // 明細のあとの、日付も金額も無い行。K に当たる位置（11列目）に値を置いても
    // 転記に出ないこと（用途の列を読まないこと）を見る。標本の5行より後ろなので
    // 表の幅は 10 のまま。
    const extra = ['', '', '', '', '架空金額メモ', '', '', '', '', ''];
    extra.push('架空の外側');
    rows.push(extra);
    return rows;
  }

  function ucsRowsBadDate() {
    return [UCS_HEADER_10.slice(),
      ['01', '1回', '架空日付', '架空ストア', 1200, 1200, '', '', '', ''],
      ['01', '1回', '架空日付2', '架空ストア', 2400, 2400, '', '', '', '']];
  }

  // 用途の列が無い10列で、`ucs_family` の日付の列（C）が日付でない形。
  // 予備の形は型で外れるが、J を日付の列に選べば新しい形式は登録できる。
  function ucsRowsShiftedDate() {
    const rows = [UCS_HEADER_10.slice()];
    for (let index = 0; index < 5; index += 1) {
      rows.push(['01', '1回', '架空日付', '架空ストア', 1000 + index * 100,
        1000 + index * 100, '', '', '', 20251201 + index]);
    }
    return rows;
  }

  // 同じ形で 11 列（末尾 K が `使用用途` の見出し・値は空）。F1 の見出しの
  // 確認に使う。
  function ucsRowsShiftedDateWithPurpose() {
    const rows = [UCS_HEADER_11.slice()];
    for (let index = 0; index < 5; index += 1) {
      rows.push(['01', '1回', '架空日付', '架空ストア', 1000 + index * 100,
        1000 + index * 100, '', '', '', 20251201 + index, '']);
    }
    return rows;
  }

  // 三井住友系の 6 列（A 日付・B 文字・C 数）。1 行目に `様` があるので、
  // `smbc_family_x7` の用途の列（G）を外した予備の幅 6 に当たってしまう形。
  function smbcRows6() {
    const rows = [['ご利用日', '架空 太郎 様', 'ご利用金額', '当月支払額', '備考', 'メモ']];
    for (let index = 0; index < 5; index += 1) {
      rows.push([20251201 + index, '架空ストア', 1000 + index * 100,
        1000 + index * 100, '', '']);
    }
    return rows;
  }

  function annotated(id) {
    const list = plain(gas.evaluate('ANNOTATED_FORMAT_SPECS_'));
    return list.filter((spec) => spec.formatId === id)[0];
  }

  function fullSpec(spec) {
    return Object.assign({parserKind: 'generic', version: 1, revisionReason: 'NEW'}, spec);
  }

  function defFromSpec(spec) {
    const values = gas.call('cardFormatRowValues_', [fullSpec(spec), 1, NOW, 'tester@example.com']);
    const def = gas.call('formatRowFromValues_', [values, 1]);
    assert.equal(def.valid, true, JSON.stringify(plain(def.problems)));
    return def;
  }

  function ucsDef() { return defFromSpec(annotated('ucs_family')); }
  function jcbDef() { return defFromSpec(annotated('jcb_family')); }

  function syntheticSpec(id, overrides) {
    return Object.assign({
      formatId: id, formatName: '架空形式' + id, fileTypes: ['xlsx'],
      keywordRule: {allOf: [{maxRow: 1, keywords: UCS_KEYWORDS.slice(), minMatch: 5}]},
      headerRow: 1, dataStartRow: 2,
      dateColumn: 'C', merchantColumn: 'D', amountColumn: 'E', purposeColumn: 'K',
      columnProfile: {minColumns: 11, maxColumns: 11, sampleRows: 5, columns: [
        {index: 2, type: 'date', required: true},
        {index: 3, type: 'text', required: true},
        {index: 4, type: 'number', required: true}]},
      exclusionRule: {excludeRowRanges: [{from: 1, to: 1}],
        excludeWhenDateAndAmountEmpty: true, rules: []},
      countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
      cardNameRule: {sources: [{kind: 'folderName'}]},
      billingRule: null
    }, overrides || {});
  }

  function detect(sheets, fileName, definitions, targetSheetName) {
    const context = {origin: 'FILE', fileName: fileName, fileType: 'xlsx',
      targetSheetName: targetSheetName || null, sourceId: 'fictional_file'};
    return plain(gas.call('detectFileFormat_', [definitions,
      sheets.map((rows) => ({name: rows.name, rows: rows.rows})), 'xlsx', fileName, context]));
  }

  // ---- pso 1 ------------------------------------------------------------

  test('pso 1: ファイル名の「仕入れ専用」を全角・半角の空白と状態の印を含めて見分ける', () => {
    for (const name of ['4月引き落とし分仕入れ専用', '【処理中】仕入専用 明細', '仕入れ 専用',
      '仕入れ　専用', '仕入れ専用', '仕入れ専用_202601.xlsx']) {
      assert.equal(gas.call('isPurchaseOnlyFileName_', [name]), true, name);
    }
    for (const name of ['仕入_明細', '専用カード', '仕入れ用', '仕入れ明細（専用口座）', '', null]) {
      assert.equal(gas.call('isPurchaseOnlyFileName_', [name]), false, String(name));
    }
  });

  // ---- pso 2 ------------------------------------------------------------

  test('pso 2: 「仕入れ専用」のファイルは書いてある用途も含めて全行を仕入れにする', () => {
    const input = [
      {transactionId: 'tx_empty', purpose: ''},
      {transactionId: 'tx_refund', purpose: '返品'},
      {transactionId: 'tx_private', purpose: '私的利用'}
    ];
    const before = plain(input);
    const rules = [{id: 'R1', keyword: '経費', purpose: '経費', enabled: true}];
    const result = gas.call('resolvePurposes',
      [input, '経費まとめ仕入れ専用_202601.csv', rules]);
    assert.deepEqual(plain(result).txs.map((tx) => tx.purpose), ['仕入れ', '仕入れ', '仕入れ']);
    for (const tx of plain(result).txs) {
      assert.equal(tx.purposeInferred, true);
      assert.equal(tx.purposeInferenceRuleId, 'PURCHASE_ONLY_FILE');
    }
    assert.equal(result.unresolvedCount, 0);
    assert.deepEqual(plain(input), before, '入ってきた取引の物を書き換えない');
    assert.deepEqual(Object.keys(plain(result)).sort(), ['txs', 'unresolvedCount']);
  });

  // ---- pso 3 ------------------------------------------------------------

  test('pso 3a: ucs_family の予備の形は幅を1つ狭め、用途の列を外す', () => {
    const original = ucsDef();
    const before = plain(original);
    const variant = plain(gas.call('purposeAbsentVariant_', [original]));
    assert.ok(variant);
    assert.equal(variant.columnProfile.minColumns, 10);
    assert.equal(variant.columnProfile.maxColumns, 10);
    assert.equal(variant.purposeColumn, null);
    assert.equal(variant.purposeAbsentOf, 'ucs_family');
    assert.equal(variant.formatId, original.formatId);
    assert.equal(variant.version, original.version);
    assert.equal(variant.dateColumn, original.dateColumn);
    assert.equal(variant.merchantColumn, original.merchantColumn);
    assert.equal(variant.amountColumn, original.amountColumn);
    assert.deepEqual(variant.keywordRule, plain(original.keywordRule));
    assert.deepEqual(plain(original), before, '元の定義を書き換えない');
  });

  test('pso 3b: jcb_family の予備の形は使用用途をキーワードから外して minMatch を下げる', () => {
    const variant = plain(gas.call('purposeAbsentVariant_', [jcbDef()]));
    assert.ok(variant);
    const condition = variant.keywordRule.allOf[0];
    assert.deepEqual(condition.keywords,
      ['ご利用者', 'カテゴリ', 'ご利用日', 'ご利用先など']);
    assert.equal(condition.minMatch, 4);
    assert.equal(condition.maxRow, 6);
    assert.equal(variant.columnProfile.minColumns, 12);
    assert.equal(variant.purposeAbsentOf, 'jcb_family');
  });

  test('pso 3c: 予備の形を作らない条件', () => {
    const ucs = ucsDef();
    const cases = {
      '用途が右端でない': defFromSpec(annotated('amex_6_alt')),
      '用途の列なし': Object.assign({}, ucs, {purposeColumn: null}),
      '列構造なし': Object.assign({}, ucs, {columnProfile: null}),
      '上限なし': Object.assign({}, ucs, {columnProfile: {
        minColumns: 11, sampleRows: 5, columns: ucs.columnProfile.columns}}),
      '最小と最大が違う': Object.assign({}, ucs, {columnProfile: Object.assign(
        {}, ucs.columnProfile, {minColumns: 10, maxColumns: 11})}),
      'allOf が使用用途だけ': Object.assign({}, ucs, {keywordRule: {allOf: [
        {maxRow: 1, keywords: ['使用用途'], minMatch: 1}]}}),
      '除外のセル規則が用途の列': Object.assign({}, ucs, {exclusionRule: {
        excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true,
        rules: [{id: 'r', target: 'cell', column: 'K', match: 'empty'}]}}),
      '予備金額が用途の列': Object.assign({}, ucs, {amountFallbackColumn: 'K'}),
      '区切りの規則あり': Object.assign({}, ucs, {sectionBreakRule: {patterns: ['架空']}}),
      '列構造の index が用途の列': Object.assign({}, ucs, {columnProfile: Object.assign(
        {}, ucs.columnProfile, {columns: ucs.columnProfile.columns.concat([
          {index: 10, type: 'text', required: false}])})}),
      'カード名のセルが用途の列': Object.assign({}, ucs, {cardNameRule: {sources: [
        {kind: 'folderName'}, {kind: 'cell', row: 1, column: 11}]}}),
      '件数のセルが用途の列': Object.assign({}, ucs, {countTotalRule: {
        count: {source: 'cell', cell: 'K1'}, total: {source: 'none'}, totalScope: 'all'}}),
      '合計の見出し行の値が用途の列': Object.assign({}, ucs, {countTotalRule: {
        count: {source: 'labeledRow', label: '件数', labelColumn: 'A', valueColumn: 'K'},
        total: {source: 'none'}, totalScope: 'all'}}),
      '海外通貨の列が用途の列': Object.assign({}, ucs, {foreignCurrencyColumn: 'K'}),
      '予備の日付が用途の列': Object.assign({}, ucs, {dateAltColumn: 'K'}),
      '定義が不正': Object.assign({}, ucs, {valid: false})
    };
    for (const label of Object.keys(cases)) {
      assert.equal(gas.call('purposeAbsentVariant_', [cases[label]]), null, label);
    }
  });

  test('pso 3d: 判定の語が少ない形式（smbc_family_x7 の 様 だけ）は予備を作らない', () => {
    assert.equal(gas.call('purposeAbsentVariant_', [defFromSpec(annotated('smbc_family_x7'))]),
      null, '語が 1 つだけの形式は予備を作らない');
    assert.ok(gas.call('purposeAbsentVariant_', [jcbDef()]),
      'jcb_family（除いた後 4 語）の予備は今どおり作る');
  });

  test('pso 3e: 語を除いていない条件の minMatch は元のまま写す', () => {
    const spec = syntheticSpec('fake_minmatch', {keywordRule: {allOf: [
      {maxRow: 1, keywords: ['使用用途', '架空甲', '架空乙'], minMatch: 2},
      {maxRow: 1, keywords: ['架空丙', '架空丁'], minMatch: 3}]}});
    const variant = plain(gas.call('purposeAbsentVariant_', [defFromSpec(spec)]));
    assert.ok(variant);
    assert.deepEqual(variant.keywordRule.allOf[0].keywords, ['架空甲', '架空乙']);
    assert.equal(variant.keywordRule.allOf[0].minMatch, 2, '語を除いた条件は下げる');
    assert.deepEqual(variant.keywordRule.allOf[1].keywords, ['架空丙', '架空丁']);
    assert.equal(variant.keywordRule.allOf[1].minMatch, 3,
      '語を除いていない条件の minMatch は元のまま（語の数に切り下げない）');
  });

  // ---- pso 4 ------------------------------------------------------------

  test('pso 4a: 「仕入れ専用」の10列は ucs_family の予備で決まる', () => {
    const result = detect([{name: '明細', rows: ucsRows(false)}], '架空カード仕入れ専用_202601.xlsx',
      [ucsDef()]);
    assert.equal(result.status, 'RESOLVED');
    assert.equal(result.formatId, 'ucs_family');
    assert.equal(result.formatVersion, 1);
    assert.equal(result.purposeColumnAbsent, true);
    assert.equal(result.sheetName, '明細');
  });

  test('pso 4b: 「仕入れ専用」でない同じ10列は形式不明のまま', () => {
    const result = detect([{name: '明細', rows: ucsRows(false)}], '架空カード_202601.xlsx',
      [ucsDef()]);
    assert.equal(result.status, 'UNKNOWN_CARD_FORMAT');
    assert.equal('purposeColumnAbsent' in result, false);
  });

  test('pso 4c: 「仕入れ専用」でも11列（用途の列あり）は普通の判定で決まる', () => {
    const result = detect([{name: '明細', rows: ucsRows(true)}], '架空カード仕入れ専用_202601.xlsx',
      [ucsDef()]);
    assert.equal(result.status, 'RESOLVED');
    assert.equal(result.formatId, 'ucs_family');
    assert.equal('purposeColumnAbsent' in result, false);
  });

  test('pso 4d: 10列でも見出しに使用用途があれば予備は使わない', () => {
    const rows = ucsRows(false);
    rows[0][9] = '使用用途';
    const result = detect([{name: '明細', rows}], '架空カード仕入れ専用_202601.xlsx', [ucsDef()]);
    assert.equal(result.status, 'UNKNOWN_CARD_FORMAT');
  });

  test('pso 4e: 予備の形が2つ当たるときは形式不明のまま（AMBIGUOUS にしない）', () => {
    const first = defFromSpec(syntheticSpec('fake_ucs_a'));
    const second = defFromSpec(syntheticSpec('fake_ucs_b'));
    const result = detect([{name: '明細', rows: ucsRows(false)}], '架空カード仕入れ専用_202601.xlsx',
      [first, second]);
    assert.equal(result.status, 'UNKNOWN_CARD_FORMAT');
  });

  test('pso 4f: 9列（2つ少ない）は予備でも決まらない', () => {
    const rows = ucsRows(false).map((row) => row.slice(0, 9));
    const result = detect([{name: '明細', rows}], '架空カード仕入れ専用_202601.xlsx', [ucsDef()]);
    assert.equal(result.status, 'UNKNOWN_CARD_FORMAT');
  });

  test('pso 4g: 普通の判定が AMBIGUOUS のときは予備で RESOLVED にしない', () => {
    const first = defFromSpec(syntheticSpec('fake_ucs_amb_a'));
    const second = defFromSpec(syntheticSpec('fake_ucs_amb_b', {keywordRule: {allOf: [
      {maxRow: 1, keywords: UCS_KEYWORDS.concat(['架空Ｂ印']), minMatch: 6}]}}));
    const eleven = ucsRows(true);
    eleven[0][9] = '架空Ｂ印';
    const result = detect([
      {name: '曖昧な明細', rows: eleven},
      {name: '予備なら決まる明細', rows: ucsRows(false)}
    ], '架空カード仕入れ専用_202601.xlsx', [first, second]);
    assert.equal(result.status, 'AMBIGUOUS_CARD_FORMAT');
    assert.equal('purposeColumnAbsent' in result, false);
  });

  test('pso 4h: 日付の列が日付でない10列は予備の型で外れる', () => {
    const result = detect([{name: '明細', rows: ucsRowsBadDate()}],
      '架空カード仕入れ専用_202601.xlsx', [ucsDef()]);
    assert.equal(result.status, 'UNKNOWN_CARD_FORMAT');
  });

  test('pso 4i: 2シートのうち片方だけが予備に当たるとそのシートで決まる', () => {
    const result = detect([
      {name: '別の明細', rows: [['架空の見出し'], ['架空の値']]},
      {name: '予備の明細', rows: ucsRows(false)}
    ], '架空カード仕入れ専用_202601.xlsx', [ucsDef()]);
    assert.equal(result.status, 'RESOLVED');
    assert.equal(result.sheetName, '予備の明細');
    assert.equal(result.formatId, 'ucs_family');
    assert.equal(result.purposeColumnAbsent, true);
  });

  test('pso 4j: jcb_family の12列（用途の列なし）も予備で決まる', () => {
    const jcb = annotated('jcb_family');
    const rows = [blank(12), blank(12), blank(12), blank(12), blank(12),
      ['ご利用者', 'カテゴリ', 'ご利用日', 'ご利用先など', 'ご利用金額', '今回請求額',
        '支払方法', '支払区分', '備考', '摘要', 'メモ', '区分'],
      ['架空太郎', '架空', 20251201, '架空ストア', 1200, 1200, '1回', '', '', '', '', ''],
      ['架空太郎', '架空', 20251202, '架空ストア', 2400, 2400, '1回', '', '', '', '', '']];
    const result = detect([{name: '明細', rows}], '架空カード仕入れ専用_202601.xlsx',
      [defFromSpec(jcb)]);
    assert.equal(result.status, 'RESOLVED');
    assert.equal(result.formatId, 'jcb_family');
    assert.equal(result.purposeColumnAbsent, true);
  });

  test('pso 4k: 判定の語が 様 だけの形式は予備を作らないので形式不明のまま', () => {
    const result = detect([{name: '明細', rows: smbcRows6()}],
      '架空カード仕入れ専用_202601.xlsx', [defFromSpec(annotated('smbc_family_x7'))]);
    assert.equal(result.status, 'UNKNOWN_CARD_FORMAT');
    assert.equal('purposeColumnAbsent' in result, false);
  });

  test('pso 4l: 普通の判定が MULTI_SHEET_AMBIGUOUS ならそのまま返す', () => {
    const eleven = [{name: '明細A', rows: ucsRows(true)}, {name: '明細B', rows: ucsRows(true)}];
    const result = detect(eleven, '架空カード仕入れ専用_202601.xlsx', [ucsDef()]);
    assert.equal(result.status, 'MULTI_SHEET_AMBIGUOUS');
    assert.equal('purposeColumnAbsent' in result, false);
  });

  test('pso 4m: 予備が2シートに当たるときは形式不明のまま', () => {
    const ten = [{name: '明細A', rows: ucsRows(false)}, {name: '明細B', rows: ucsRows(false)}];
    const result = detect(ten, '架空カード仕入れ専用_202601.xlsx', [ucsDef()]);
    assert.equal(result.status, 'UNKNOWN_CARD_FORMAT');
    assert.equal('purposeColumnAbsent' in result, false);
  });

  test('pso 4n: 対象シートがあれば予備でもそのシートで決まる', () => {
    const ten = [{name: '明細A', rows: ucsRows(false)}, {name: '明細B', rows: ucsRows(false)}];
    const result = detect(ten, '架空カード仕入れ専用_202601.xlsx', [ucsDef()], '明細B');
    assert.equal(result.status, 'RESOLVED');
    assert.equal(result.sheetName, '明細B');
    assert.equal(result.formatId, 'ucs_family');
    assert.equal(result.purposeColumnAbsent, true);
  });

  // ---- 取込の往復（pso 5・pso 9）---------------------------------------

  function customerRow() {
    const row = blank(37);
    Object.assign(row, {
      0: 'C001', 1: '架空顧客', 2: 'TRUE', 3: 'folder1', 5: 'dest1', 7: '入力用シート',
      8: '取引先一覧', 9: 2, 10: 3, 11: 4, 12: 5, 13: 6, 14: 7, 15: '1.0',
      16: 'reviewer@example.com', 17: 'admin@example.com', 18: 0, 20: 'システム情報', 21: '',
      23: 0, 24: 0, 29: 1,
      30: JSON.stringify({row: 1, cells: [{column: 2, text: '利用日', match: 'exact'}]}),
      31: '{}', 32: '{}', 33: 8, 34: '取引先一覧', 35: 'CORPORATE', 36: ''
    });
    return row;
  }

  function dictRow() {
    const row = blank(18);
    Object.assign(row, {
      0: 'DICT_1', 1: '架空ストア', 2: '架空ストア', 3: '株式会社架空ストア',
      4: 'exact_original', 5: 1, 6: '', 7: '', 8: '', 9: 'TRUE',
      10: 'admin@example.com', 12: '2026-01-01T00:00:00+09:00', 13: 1,
      14: 'TRUE', 15: 'FALSE'
    });
    return row;
  }

  function importSetup(formatValues) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [sheetHeader(37, '顧客ID'), customerRow()]},
      {name: 'カード形式マスター', values: [sheetHeader(37, '形式ID'), formatValues]},
      {name: '使用用途補完マスター', values: [sheetHeader(10, 'ルールID'),
        Object.assign(blank(10), {0: 'PR1', 1: '架空', 2: '仕入れ', 3: 'TRUE'})]},
      {name: '共通取引先辞書', values: [sheetHeader(18, '辞書ID'), dictRow()]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート',
        values: [['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID', '']],
        maxRows: 30, maxColumns: 8},
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
      SETTINGS.PARALLEL_WORK_FOLDER_ID = 'purchase-only-work-folder';
      SETTINGS.FAULT_INJECTION = null;
    `);
    gas.stubs.setActiveUser('admin@example.com');
    const fileId = 'fictional_source';
    gas.stubs.createFile(fileId, {
      name: '架空カード_202601.xlsx', bytes: Buffer.from('FICTIONAL_XLSX_BYTES'),
      contentType: XLSX, lastUpdated: hourAgo(),
      createdTime: '2026-08-01T00:00:00Z',
      xlsxSheets: [{name: '明細', values: ucsRows(false), maxRows: 8, maxColumns: 11}]
    });
    gas.stubs.createFolder('folder1', {fileIds: [fileId]});
    return fileId;
  }

  function renameSource(fileId, name) {
    gas.stubs.getFile(fileId).name = name;
  }

  // `parseFile` に渡った `cardFormat` と、そのときの取引・除外を控える。
  // 取込（`71`）が予備で読むときに用途の列を外しているか（R12）を、
  // 転記の見た目ではなく呼出しの引数と取引の数で直接確かめる。
  function watchParseFile() {
    gas.evaluate(`
      if (typeof __psoParseFile !== 'function') {
        __psoParseFile = parseFile;
        __psoParseSeen = [];
        parseFile = function(sheet, format, context) {
          var parsed = __psoParseFile(sheet, format, context);
          __psoParseSeen.push(JSON.stringify({
            purposeColumn: format && format.purposeColumn !== undefined ?
              format.purposeColumn : 'MISSING',
            txCount: parsed.txs.length,
            ruleIds: parsed.excludedRows.map(function(item) { return item.ruleId; })
          }));
          return parsed;
        };
      }
      __psoParseSeen.length = 0;
    `);
  }

  function seenParses() {
    return JSON.parse(gas.evaluate('JSON.stringify(__psoParseSeen)'))
      .map((text) => JSON.parse(text));
  }

  const destSheet = () => gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
  const writtenRows = () => destSheet().getDataRange().getValues().slice(1)
    .filter((row) => row[6] !== '');

  test('pso 5: 「仕入れ専用」の10列は転記され、用途の列 K を読まない', () => {
    const fileId = importSetup(gas.call('cardFormatRowValues_',
      [fullSpec(annotated('ucs_family')), 1, NOW, 'admin@example.com']));
    renameSource(fileId, '架空カード仕入れ専用_202601.xlsx');
    const report = plain(gas.call('runImport', [{}]));
    assert.equal(report.stoppedBy, null, JSON.stringify(report));
    const fileReport = report.customers[0].files[0];
    assert.equal(fileReport.outcome, 'WRITTEN', JSON.stringify(fileReport));
    assert.equal(fileReport.written, 5);
    assert.equal(plain(gas.call('openReviews', [{reviewType: 'FORMAT_UNKNOWN'}])).length, 0,
      '形式不明の要確認を立てない');
    const rows = writtenRows();
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map((row) => row[3]), ['仕入れ', '仕入れ', '仕入れ', '仕入れ', '仕入れ']);
    assert.equal(gas.call('getProcessLogRecord_', [fileId]).values[14], 'ucs_family');
    assert.equal(plain(gas.call('openReviews', [{}])).length, 0,
      'K の位置の文字がある行で要確認を立てない');
  });

  test('pso 5c: 予備で読むときは parseFile に渡す用途の列を外す（K の文字で取引にしない）', () => {
    const fileId = importSetup(gas.call('cardFormatRowValues_',
      [fullSpec(annotated('ucs_family')), 1, NOW, 'admin@example.com']));
    renameSource(fileId, '架空カード仕入れ専用_202601.xlsx');
    watchParseFile();
    const report = plain(gas.call('runImport', [{}]));
    assert.equal(report.stoppedBy, null, JSON.stringify(report));
    const seen = seenParses();
    assert.equal(seen.length, 1, '取込 1 本で parseFile は 1 回');
    assert.equal(seen[0].purposeColumn, null,
      '用途の列を読まない（purposeColumn: null を渡す）');
    assert.equal(seen[0].txCount, 5, 'K の位置に文字がある行を取引にしない');
    assert.ok(seen[0].ruleIds.indexOf('_noTransactionValue') >= 0, JSON.stringify(seen[0]));
    assert.equal(report.customers[0].files[0].outcome, 'WRITTEN');
    assert.equal(report.customers[0].files[0].written, 5);
  });

  test('pso 5b: 名前に「仕入れ専用」が無ければ今どおり形式不明になる', () => {
    const fileId = importSetup(gas.call('cardFormatRowValues_',
      [fullSpec(annotated('ucs_family')), 1, NOW, 'admin@example.com']));
    renameSource(fileId, '架空カード_202601.xlsx');
    const report = plain(gas.call('runImport', [{}]));
    assert.equal(report.stoppedBy, null, JSON.stringify(report));
    const fileReport = report.customers[0].files[0];
    assert.notEqual(fileReport.outcome, 'WRITTEN');
    const reviews = plain(gas.call('openReviews', [{reviewType: 'FORMAT_UNKNOWN'}]));
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].fileId, fileId);
    assert.equal(writtenRows().length, 0);
  });

  function tripsOfRun() {
    gas.stubs.resetRoundTrips();
    gas.stubs.resetDriveOps();
    const report = plain(gas.call('runImport', [{}]));
    const trips = gas.stubs.roundTrips();
    return {
      report: report,
      count: trips.rangeReads + trips.rangeWrites + trips.flushes +
        gas.stubs.getDriveOps().length
    };
  }

  test('pso 9: 予備で決まる取込の往復は普通の形式で読むときと同じ', () => {
    // 予備で決まる「仕入れ専用」の10列。
    const variantFile = importSetup(gas.call('cardFormatRowValues_',
      [fullSpec(annotated('ucs_family')), 1, NOW, 'admin@example.com']));
    renameSource(variantFile, '架空カード仕入れ専用_202601.xlsx');
    const variant = tripsOfRun();
    assert.equal(variant.report.customers[0].files[0].outcome, 'WRITTEN');

    // 同じ明細を、用途の列を持たない普通の10列の形式で読む。
    const tenSpec = annotated('ucs_family');
    tenSpec.formatId = 'fake_ucs_ten';
    tenSpec.formatName = '架空UCS系（10列・用途なし）';
    tenSpec.purposeColumn = '';
    tenSpec.columnProfile = Object.assign({}, tenSpec.columnProfile, {
      minColumns: 10, maxColumns: 10});
    const normalFile = importSetup(gas.call('cardFormatRowValues_',
      [fullSpec(tenSpec), 1, NOW, 'admin@example.com']));
    renameSource(normalFile, '架空カード_202601.xlsx');
    const normal = tripsOfRun();
    assert.equal(normal.report.customers[0].files[0].outcome, 'WRITTEN');
    assert.equal(normal.report.customers[0].files[0].written, 5);
    assert.equal(variant.count, normal.count,
      `予備で${variant.count}往復、普通の形式で${normal.count}往復`);
  });

  // ---- 画面の入口（pso 6〜8）-------------------------------------------

  function webSetup() {
    gas.stubs.reset();
    gas.evaluate("SETTINGS.PARALLEL_WORK_FOLDER_ID = 'purchase-only-work-folder';");
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.stubs.setSpreadsheetOwner('master', 'owner@example.com');
    gas.stubs.setActiveUser('owner@example.com');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.call('installAnnotatedFormatsBatch1', []);
    gas.stubs.createSpreadsheet('dest', {sheets: [{name: '入力用シート',
      values: [['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID',
        '税区分', '勘定科目', '消費税']],
      maxRows: 30, maxColumns: 10}]});
    const card = gas.stubs.createFolder('card', {name: '架空カード', fileIds: [], subFolderIds: []});
    gas.stubs.createFolder('root', {name: '架空顧客ルート', fileIds: [], subFolderIds: ['card']});
    gas.call('registerTestCustomer', [{customerId: 'C001', customerName: '架空顧客',
      sourceFolderId: 'root', destinationSpreadsheetId: 'dest',
      destinationSheetName: '入力用シート',
      columns: {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7},
      rowScanLastColumn: 10, rowScanExcludedColumns: [8, 9, 10],
      reviewers: 'owner@example.com', admins: 'owner@example.com'}]);
    return {card};
  }

  function putUnknown(card, fileId, fileName, rows) {
    gas.stubs.createFile(fileId, {name: fileName, bytes: Buffer.from('fictional-' + fileId),
      contentType: XLSX,
      xlsxSheets: [{name: '明細', values: rows, maxRows: rows.length, maxColumns: 11}],
      lastUpdated: hourAgo()});
    card.fileIds.push(fileId);
    gas.call('registerReview', [{reviewType: 'FORMAT_UNKNOWN', customerId: 'C001',
      customerName: '架空顧客', fileId: fileId, fileNameOriginal: fileName}]);
  }

  function seedWaiting(fileId, fileName) {
    const customer = gas.call('getCustomerById', ['C001']);
    gas.call('createOrUpdateProcessLog', ['R1', customer,
      {fileId: fileId, name: fileName, state: 'REVIEW_WAIT', contentHash: 'submitted-old'}]);
  }

  test('pso 6: 形式不明の「仕入れ専用」は再検査へ戻せ、そうでない同じ形は戻せない', () => {
    const purchase = webSetup();
    putUnknown(purchase.card, 'target', '架空カード仕入れ専用_202601.xlsx', ucsRows(false));
    seedWaiting('target', '架空カード仕入れ専用_202601.xlsx');
    const result = plain(gas.call('webAppRequeueFormatFiles', ['C001', 'card', ['target']]));
    assert.equal(result.requeued.length, 1);
    assert.equal(result.requeued[0].fileId, 'target');
    assert.equal(result.requeued[0].formatId, 'ucs_family');

    const normal = webSetup();
    putUnknown(normal.card, 'target', '架空カード_202601.xlsx', ucsRows(false));
    const skipped = plain(gas.call('webAppRequeueFormatFiles', ['C001', 'card', ['target']]));
    assert.deepEqual(skipped.requeued, []);
    assert.deepEqual(skipped.skipped, [{fileId: 'target', code: 'STILL_UNKNOWN'}]);
  });

  test('pso 7a: 予備で読める「仕入れ専用」は MATCHES_ACTIVE と purposeColumnAbsent を返す', () => {
    const {card} = webSetup();
    putUnknown(card, 'target', '架空カード仕入れ専用_202601.xlsx', ucsRows(false));
    const d = plain(gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']));
    assert.equal(d.verdict, 'MATCHES_ACTIVE');
    assert.equal(d.matched.formatId, 'ucs_family');
    assert.equal(d.purposeColumnAbsent, true);
    assert.equal(d.purchaseOnly, true);
  });

  test('pso 7b: 「仕入れ専用」で型で外れるときは purposeGap を出さない', () => {
    const {card} = webSetup();
    putUnknown(card, 'target', '架空カード仕入れ専用_202601.xlsx', ucsRowsBadDate());
    const d = plain(gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']));
    assert.equal(d.verdict, 'NEAR');
    assert.equal(d.nearest[0].formatId, 'ucs_family');
    assert.equal(d.purchaseOnly, true);
    assert.equal(d.purposeGap, null);
    assert.equal(d.customerSide, false);
  });

  test('pso 7c: 名前に「仕入れ専用」が無ければ今どおり用途の列の不足を返す', () => {
    const {card} = webSetup();
    putUnknown(card, 'target', '架空カード_202601.xlsx', ucsRowsBadDate());
    const d = plain(gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']));
    assert.equal(d.verdict, 'NEAR');
    assert.equal(d.purchaseOnly, false);
    assert.equal(d.purposeGap.kind, 'PURPOSE_COLUMN_ABSENT');
    assert.equal(d.customerSide, true);
  });

  function previewAnswers(d, dateColumn) {
    const p = d.proposal;
    return {baseFormatId: p.baseFormatId, formatId: p.formatId, formatName: p.formatName,
      sheetName: p.sheetName, headerRow: p.headerRow, dataStartRow: p.dataStartRow,
      columns: {date: dateColumn || p.columns.date.column,
        merchant: p.columns.merchant.column,
        amount: 'E', purpose: null, amountFallback: null},
      acknowledgements: {customerSide: false, amountChoice: true}};
  }

  test('pso 8a: 「仕入れ専用」は用途の列を選ばずに試し読み・保存できる', () => {
    const {card} = webSetup();
    putUnknown(card, 'target', '架空カード仕入れ専用_202601.xlsx', ucsRowsShiftedDate());
    const d = plain(gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']));
    assert.equal(d.purposeGap, null, '「仕入れ専用」では用途の列の不足を出さない');
    assert.equal(d.customerSide, false);
    const answers = previewAnswers(d, 'J');
    const preview = plain(gas.call('webAppPreviewFormat',
      ['C001', 'card', 'target', answers]));
    const codes = preview.blocking.map((item) => item.code);
    assert.equal(codes.indexOf('PURPOSE_COLUMN_REQUIRED'), -1);
    assert.equal(codes.indexOf('ACK_CUSTOMER_SIDE_REQUIRED'), -1);
    assert.equal(preview.warnings.some((item) => item.code === 'PURPOSE_EMPTY_ROWS'), false);
    assert.ok(preview.extraction.rows.length > 0);
    assert.deepEqual(preview.extraction.rows.map((row) => row.purpose),
      preview.extraction.rows.map(() => '仕入れ'));

    const saved = plain(gas.call('webAppSaveFormat',
      ['C001', 'card', 'target', answers, preview.previewHash]));
    assert.equal(saved.saved, true);
    assert.equal(saved.readback, 'OK', JSON.stringify(saved));
    const loaded = gas.call('loadFormatDefinitions', [{formatId: answers.formatId}])[0];
    assert.equal(loaded.purposeColumn, null);
    const master = gas.stubs.getSpreadsheet('master')
      .getSheetByName('カード形式マスター');
    assert.equal(master.getRange(loaded._rowNumber, 12).getValue(), '',
      'カード形式マスターの L 列（用途の列）は空');

    const defs = gas.call('formatActiveDefinitions_', []);
    const read = gas.call('readFile', ['target', '架空カード仕入れ専用_202601.xlsx', {}]);
    const verdict = plain(gas.call('formatDetectRead_',
      [defs, read, '架空カード仕入れ専用_202601.xlsx', 'target']));
    assert.equal(verdict.status, 'RESOLVED');
    assert.equal(verdict.formatId, answers.formatId);
    assert.equal('purposeColumnAbsent' in verdict, false,
      '保存後は普通の判定で決まる');
  });

  test('pso 8b: 名前に「仕入れ専用」が無ければ今どおり用途の列が要る', () => {
    const {card} = webSetup();
    putUnknown(card, 'target', '架空カード_202601.xlsx', ucsRowsShiftedDate());
    const d = plain(gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']));
    const answers = previewAnswers(d, 'J');
    answers.acknowledgements.customerSide = true;
    const preview = plain(gas.call('webAppPreviewFormat',
      ['C001', 'card', 'target', answers]));
    assert.ok(preview.blocking.some((item) => item.code === 'PURPOSE_COLUMN_REQUIRED'));
  });

  test('pso 8c: 「仕入れ専用」でも用途の列の見出しが標準でなければ今どおり止める', () => {
    const {card} = webSetup();
    putUnknown(card, 'target', '架空カード仕入れ専用_202601.xlsx', ucsRowsShiftedDate());
    const d = plain(gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']));
    const answers = previewAnswers(d, 'J');
    answers.columns.purpose = 'I';
    const preview = plain(gas.call('webAppPreviewFormat',
      ['C001', 'card', 'target', answers]));
    assert.ok(preview.blocking.some((item) => item.code === 'ACK_CUSTOMER_SIDE_REQUIRED'));
    assert.ok(preview.warnings.some((item) => item.code === 'PURPOSE_HEADER_NOT_STANDARD'));
  });

  test('pso 8d: 見出しに使用用途がある「仕入れ専用」は用途の列を選ばないと登録できない', () => {
    const {card} = webSetup();
    putUnknown(card, 'target', '架空カード仕入れ専用_202601.xlsx',
      ucsRowsShiftedDateWithPurpose());
    const d = plain(gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']));
    const answers = previewAnswers(d, 'J');
    const preview = plain(gas.call('webAppPreviewFormat',
      ['C001', 'card', 'target', answers]));
    assert.ok(preview.blocking.some((item) => item.code === 'PURPOSE_COLUMN_REQUIRED'),
      JSON.stringify(preview.blocking.map((item) => item.code)));

    const withPurpose = previewAnswers(d, 'J');
    withPurpose.columns.purpose = 'K';
    const ok = plain(gas.call('webAppPreviewFormat',
      ['C001', 'card', 'target', withPurpose]));
    assert.equal(ok.blocking.some((item) => item.code === 'PURPOSE_COLUMN_REQUIRED'), false,
      JSON.stringify(ok.blocking.map((item) => item.code)));
  });
};

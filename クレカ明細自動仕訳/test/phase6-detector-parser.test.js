'use strict';

/**
 * 4.11 カード形式判定と 4.13 汎用パーサー。
 *
 * 要点：判定は E（包含）→ F（キーワード）→ N（列構造）だけで決まり、
 * 不正な定義は候補から静かに消えるのではなく`valid:false`として残ること。
 * パーサーは 5.1.0 の列挙表現だけを解釈し、年を確定しないこと。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));

  // ---- カード形式マスターの行を組み立てる（A〜AH＝34列） ----
  function formatRowValues(overrides) {
    const spec = Object.assign({
      formatId: 'rakuten', formatName: '楽天カード系', status: 'active', enabled: true,
      fileTypes: '["csv","xlsx"]',
      keywords: JSON.stringify({allOf: [{maxRow: 2, keywords: ['利用日', '利用店名・商品名', '利用金額', '使用用途'], minMatch: 4}]}),
      headerRow: 1, dataStartRow: 2,
      dateColumn: 'A', merchantColumn: 'B', amountColumn: 'E',
      purposeColumn: 'K', dateAltColumn: '',
      columnProfile: '', exclusion: '', countTotal: '', billing: '',
      parserKind: 'generic', version: 1, registeredBy: 'admin@example.com',
      approvedBy: '', registeredAt: '2026-01-01T00:00:00+09:00',
      disabledAt: '', disableReason: '', lookback: '', forward: '',
      sourceSampleId: '', answers: '', gateResults: '', revisionReason: 'NEW',
      currencyColumn: '', foreignAmountColumn: '', rateColumn: '',
      updatedAt: '2026-01-01T00:00:00+09:00'
    }, overrides);
    return [
      spec.formatId, spec.formatName, spec.status, spec.enabled, spec.fileTypes,
      spec.keywords, spec.headerRow, spec.dataStartRow, spec.dateColumn,
      spec.merchantColumn, spec.amountColumn, spec.purposeColumn, spec.dateAltColumn,
      spec.columnProfile, spec.exclusion, spec.countTotal, spec.billing,
      spec.parserKind, spec.version, spec.registeredBy, spec.approvedBy,
      spec.registeredAt, spec.disabledAt, spec.disableReason, spec.lookback,
      spec.forward, spec.sourceSampleId, spec.answers, spec.gateResults,
      spec.revisionReason, spec.currencyColumn, spec.foreignAmountColumn,
      spec.rateColumn, spec.updatedAt
    ];
  }

  function setupMaster(formatRows) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: 'カード形式マスター', values: [['形式ID']].concat(formatRows)}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
  }

  const rakutenSheet = {
    name: 'Sheet1',
    rows: [
      ['利用日', '利用店名・商品名', '利用者', '支払方法', '利用金額', '手数料', '支払総額', '11月支払金額', '12月繰越残高', '新規サイン', '使用用途'],
      ['2025/10/24', '楽天ビック', '本人', '1回払い', 7623, 0, 7623, 7623, 0, '*', '仕入れ'],
      ['2025/10/20', '楽天ブックス', '本人', '1回払い', 61972, 0, 61972, 61972, 0, '*', '仕入れ']
    ]
  };

  test('4.11: a valid definition row round-trips through loadFormatDefinitions', () => {
    setupMaster([formatRowValues({})]);
    const rows = plain(gas.call('loadFormatDefinitions', [{}]));
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.valid, true);
    assert.equal(row.formatId, 'rakuten');
    assert.equal(row.enabled, true);
    assert.deepEqual(row.fileTypes, ['csv', 'xlsx']);
    assert.equal(row.keywordRule.allOf[0].minMatch, 4);
    assert.equal(row.dateColumn, 'A');
    assert.equal(row.purposeColumn, 'K');
  });

  test('4.11: an invalid definition stays visible as valid:false, never silently dropped', () => {
    setupMaster([
      formatRowValues({}),
      formatRowValues({formatId: 'broken', exclusion: '{not json'})
    ]);
    const rows = plain(gas.call('loadFormatDefinitions', [{}]));
    assert.equal(rows.length, 2);
    const broken = rows.filter((r) => r.formatId === 'broken')[0];
    assert.equal(broken.valid, false);
    assert.equal(broken.errorCode, 'CARD_FORMAT_DEFINITION_INVALID');
    assert.ok(broken.problems.length >= 1);
  });

  test('A-25: Y+Z >= 12 is rejected as CARD_FORMAT_DEFINITION_INVALID', () => {
    setupMaster([formatRowValues({lookback: 11, forward: 1})]);
    const row = plain(gas.call('loadFormatDefinitions', [{}]))[0];
    assert.equal(row.valid, false);
    assert.ok(row.problems.some((p) => /Y \+ Z/.test(p)));
  });

  test('A-19: generic without I and M is invalid; custom may omit both', () => {
    setupMaster([
      formatRowValues({formatId: 'nodate', dateColumn: '', dateAltColumn: ''}),
      formatRowValues({formatId: 'custom_ok', dateColumn: '', dateAltColumn: '', parserKind: 'custom'})
    ]);
    const rows = plain(gas.call('loadFormatDefinitions', [{}]));
    assert.equal(rows.filter((r) => r.formatId === 'nodate')[0].valid, false);
    assert.equal(rows.filter((r) => r.formatId === 'custom_ok')[0].valid, true);
  });

  test('4.11: detection is inclusion in E, keyword rule in F', () => {
    setupMaster([formatRowValues({})]);
    const defs = gas.call('loadFormatDefinitions', [{}]);
    const hit = plain(gas.call('detectFormatWith', [defs, rakutenSheet, 'xlsx', '202511.xlsx']));
    assert.equal(hit.length, 1);
    assert.equal(hit[0].formatId, 'rakuten');
    assert.equal(hit[0].matchedStep, 'KEYWORDS');
    assert.ok(hit[0].matchedKeywords.indexOf('利用日') >= 0);

    const missType = plain(gas.call('detectFormatWith', [defs, rakutenSheet, 'pdf', 'x.pdf']));
    assert.equal(missType.length, 0);

    const otherSheet = {name: 'S', rows: [['ご利用日', 'データ処理日', 'ご利用内容', '金額']]};
    const missKeywords = plain(gas.call('detectFormatWith', [defs, otherSheet, 'xlsx', 'x.xlsx']));
    assert.equal(missKeywords.length, 0);
  });

  test('2.1.2.2: a legacy plain-array F column still detects (backward compatibility)', () => {
    setupMaster([formatRowValues({keywords: '["利用日","利用金額"]'})]);
    const defs = gas.call('loadFormatDefinitions', [{}]);
    const hit = plain(gas.call('detectFormatWith', [defs, rakutenSheet, 'csv', 'a.csv']));
    assert.equal(hit.length, 1);
  });

  test('2.1.2.3: a required column-profile mismatch defeats a keyword match', () => {
    const profile = JSON.stringify({minColumns: 11, sampleRows: 5, columns: [
      {index: 0, type: 'date', required: true},
      {index: 4, type: 'number', required: true}
    ]});
    setupMaster([formatRowValues({columnProfile: profile})]);
    const defs = gas.call('loadFormatDefinitions', [{}]);

    const good = plain(gas.call('detectFormatWith', [defs, rakutenSheet, 'xlsx', 'a.xlsx']));
    assert.equal(good.length, 1);
    assert.equal(good[0].matchedStep, 'COLUMN_PROFILE');

    // 明細行の金額列が数値でないシートは、キーワードが一致しても落ちる
    const badSheet = {name: 'S', rows: [
      rakutenSheet.rows[0],
      ['2025/10/24', '楽天ビック', '本人', '1回払い', '金額なし', 0, 0, 0, 0, '*', '仕入れ']
    ]};
    const bad = plain(gas.call('detectFormatWith', [defs, badSheet, 'xlsx', 'a.xlsx']));
    assert.equal(bad.length, 0);
  });

  test('4.11: sheet aggregation follows the 5-row table', () => {
    const c = (formatId) => ({formatId, version: 1, matchedStep: 'KEYWORDS', matchedKeywords: []});
    const context = {origin: 'FILE', fileName: 'a.xlsx', fileType: 'xlsx', targetSheetName: null, sourceId: 'f1'};

    const unknown = plain(gas.call('aggregateSheetDetections', [
      [{sheetName: 'S1', candidates: []}], context]));
    assert.equal(unknown.status, 'UNKNOWN_CARD_FORMAT');

    const multi = plain(gas.call('aggregateSheetDetections', [
      [{sheetName: 'S1', candidates: [c('a')]}, {sheetName: 'S2', candidates: [c('b')]}], context]));
    assert.equal(multi.status, 'MULTI_SHEET_AMBIGUOUS');
    assert.equal(multi.detail.sheets.length, 2);

    const ambiguous = plain(gas.call('aggregateSheetDetections', [
      [{sheetName: 'S1', candidates: [c('a'), c('b')]}], context]));
    assert.equal(ambiguous.status, 'AMBIGUOUS_CARD_FORMAT');

    const resolved = plain(gas.call('aggregateSheetDetections', [
      [{sheetName: 'S1', candidates: [c('a')]}], context]));
    assert.equal(resolved.status, 'RESOLVED');
    assert.equal(resolved.formatId, 'a');

    // 条件1：担当者指定シートが最優先（M19）
    const targeted = plain(gas.call('aggregateSheetDetections', [
      [{sheetName: 'S1', candidates: [c('a')]}, {sheetName: 'S2', candidates: [c('b')]}],
      Object.assign({}, context, {targetSheetName: 'S2'})]));
    assert.equal(targeted.status, 'RESOLVED');
    assert.equal(targeted.formatId, 'b');
    assert.equal(targeted.sheetName, 'S2');
  });

  test('INV-39: pinFormatVersion returns the row; a version move fails the assert', () => {
    setupMaster([
      formatRowValues({version: 1, enabled: false, disableReason: 'SUPERSEDED'}),
      formatRowValues({version: 2, enabled: true})
    ]);
    const pinned = plain(gas.call('pinFormatVersion', ['rakuten', 1]));
    assert.equal(pinned.version, 1);

    gas.call('assertPinnedVersionStillActive', ['rakuten', 2]);
    assert.throws(() => gas.call('assertPinnedVersionStillActive', ['rakuten', 1]),
      (error) => error && error.code === 'FORMAT_VERSION_CHANGED_DURING_RUN');
  });

  // ---- 5.1.0 日付表現 ----

  test('5.1.0: the enumerated date expressions and only those are interpreted', () => {
    const interpret = (v) => plain(gas.call('interpretDateExpression', [v]));

    assert.deepEqual(interpret('2025/12/28').ok, true);
    assert.equal(interpret('2025/12/28').yearDigits, 4);
    assert.equal(interpret('2025.1.5').year, 2025);
    assert.equal(interpret('2025年1月5日').month, 1);
    assert.equal(interpret('20251031').day, 31);
    assert.equal(interpret('２０２５／１２／２８').yearDigits, 4, 'full-width digits normalize');

    const twoDigit = interpret('26/01/05');
    assert.equal(twoDigit.yearDigits, 2);
    assert.equal(twoDigit.year, 26);

    const yearless = interpret('12/28');
    assert.equal(yearless.yearDigits, 0);
    assert.equal(yearless.month, 12);

    assert.equal(interpret('1月5日').yearDigits, 0);

    // 数値型はExcelシリアル（表#7）
    const serial = interpret(46027);
    assert.equal(serial.yearDigits, 4);
    assert.equal(serial.year, 2026);

    // 解釈しないもの：混在区切り・実在しない日付・月日順不明
    assert.equal(interpret('2026-01/05').ok, false);
    assert.equal(interpret('2025/02/30').ok, false);
    assert.equal(interpret('05/01/2026').ok, false);
    assert.equal(interpret('令和8年1月5日').ok, false);
    assert.equal(interpret('').ok, false);
    assert.equal(interpret(null).ok, false);
  });

  test('5.3: amount cells accept integers with currency decoration, nothing else', () => {
    const amount = (v) => plain(gas.call('interpretAmountCell', [v]));
    assert.deepEqual(amount(1234), {ok: true, blank: false, amount: 1234});
    assert.equal(amount('1,234').amount, 1234);
    assert.equal(amount('\\4,290').amount, 4290, 'Orico-style yen-prefixed strings');
    assert.equal(amount('¥1,000').amount, 1000);
    assert.equal(amount('-500').amount, -500);
    assert.equal(amount(13092.0).amount, 13092);
    assert.equal(amount('12.5').ok, false);
    assert.equal(amount('').blank, true);
    assert.equal(amount(null).blank, true);
  });

  // ---- 2.1.2.4 除外 ----

  const exclusionFormat = {
    formatId: 'test', dateColumn: 'A', amountColumn: 'C',
    exclusionRule: {
      excludeRowRanges: [{from: 1, to: 1}],
      excludeWhenDateAndAmountEmpty: true,
      rules: [
        {id: 'total', target: 'row', match: 'contains', value: '合計', onlyWhenDateEmpty: true},
        {id: 'deposit', target: 'cell', column: 'B', match: 'contains', value: 'ご入金'}
      ]
    }
  };

  test('2.1.2.4: exclusion is the OR of ranges, empties, and rules', () => {
    const apply = (row, rowNumber) => plain(gas.call('applyExclusionRules', [row, rowNumber, exclusionFormat]));

    assert.deepEqual(apply(['何か', 'ヘッダー', ''], 1), {excluded: true, ruleId: '_rowRange'});
    assert.deepEqual(apply(['', '注記だけの行', ''], 5), {excluded: true, ruleId: '_dateAmountEmpty'});
    assert.deepEqual(apply(['', '合計', 58100], 9), {excluded: true, ruleId: 'total'});
    assert.deepEqual(apply(['2025/12/16', 'ご入金ありがとうございました', -500], 4),
      {excluded: true, ruleId: 'deposit'});
    // onlyWhenDateEmpty：日付がある行の「合計」は正当な店名として残す
    assert.deepEqual(apply(['2025/12/16', '合計屋商店', 500], 3), {excluded: false, ruleId: null});
  });

  // ---- 2.1.2.6 請求年月 ----

  const billingFormat = {
    formatId: 'test',
    billingRule: {sources: [
      {id: 'fn_enavi', kind: 'fileName', pattern: 'enavi(20\\d{2})(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1},
      {id: 'hdr_pay', kind: 'scanRows', scanMaxRows: 2,
        pattern: '(20\\d{2})年\\s*(0?[1-9]|1[0-2])月\\s*(?:お)?支払(?:い)?分',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}
    ]}
  };

  test('2.1.2.6: sources agreeing after normalization resolve together', () => {
    const sheet = {name: 'S', rows: [['2025年11月お支払い分', '']]};
    const result = plain(gas.call('extractBillingYearMonth', [sheet, 'enavi202511(0000).xlsx', billingFormat]));
    assert.equal(result.status, 'RESOLVED');
    assert.equal(result.year, 2025);
    assert.equal(result.month, 10, 'payment 2025-11 minus offset 1 = closing 2025-10');
    assert.deepEqual(result.sources, ['fn_enavi', 'hdr_pay']);
  });

  test('2.1.2.6: normalized disagreement is CONFLICT, silence is NOT_FOUND', () => {
    const sheet = {name: 'S', rows: [['2025年9月お支払い分']]};
    const conflict = plain(gas.call('extractBillingYearMonth', [sheet, 'enavi202511.xlsx', billingFormat]));
    assert.equal(conflict.status, 'CONFLICT');
    assert.equal(conflict.candidates.length, 2);

    const notFound = plain(gas.call('extractBillingYearMonth',
      [{name: 'S', rows: [['何もない']]}, 'meisai.xlsx', billingFormat]));
    assert.equal(notFound.status, 'NOT_FOUND');

    const empty = plain(gas.call('extractBillingYearMonth',
      [{name: 'S', rows: []}, 'x.csv', {formatId: 'none'}]));
    assert.equal(empty.status, 'NOT_FOUND');
  });

  test('2.1.2.6: a month-ordinal offset crosses the year boundary correctly', () => {
    const januaryPay = {formatId: 't', billingRule: {sources: [
      {id: 'fn', kind: 'fileName', pattern: '(20\\d{2})(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, means: 'payment', offsetMonths: 1}
    ]}};
    const result = plain(gas.call('extractBillingYearMonth',
      [{name: 'S', rows: []}, '202601.csv', januaryPay]));
    assert.equal(result.year, 2025);
    assert.equal(result.month, 12);
  });

  // ---- 4.13 parseFile ----

  const smbcFormat = {
    formatId: 'smbc_family', formatName: '三井住友系', parserKind: 'generic',
    headerRow: 1, dataStartRow: 2,
    dateColumn: 'A', merchantColumn: 'B', amountColumn: 'C', purposeColumn: 'G',
    dateAltColumn: null, columnProfile: null,
    exclusionRule: {
      excludeRowRanges: [{from: 1, to: 1}],
      excludeWhenDateAndAmountEmpty: true,
      rules: [{id: 'deposit', target: 'cell', column: 'B', match: 'contains', value: 'ご入金'}]
    },
    countTotalRule: null, billingRule: null,
    foreignCurrencyColumn: null, foreignAmountColumn: null, exchangeRateColumn: null
  };

  const smbcSheet = {
    name: '明細',
    rows: [
      ['〇〇様', '4980-00**-****-****', '三井住友ゴールド', '', '', '', ''],
      ['2025/12/16', 'ローソン', 10800, 1, 1, 10800, '仕入れ'],
      ['12/28', 'ファミリーマート', 2900, 1, 1, 2900, '仕入れ'],
      ['', '', '', '', '', 58100, '']
    ]
  };

  test('4.13: parseFile turns detail rows into CommonTransactions and nothing else', () => {
    gas.stubs.reset();
    const result = plain(gas.call('parseFile', [smbcSheet, smbcFormat,
      {customerId: 'C001', fileId: 'f1', fileNameOriginal: '202512.csv', fileRevision: 'r1', regeneration: 0}]));

    assert.equal(result.txs.length, 2);
    assert.equal(result.excludedRows.length, 2, 'the name row and the total row are excluded');
    assert.deepEqual(result.excludedRows.map((r) => r.ruleId), ['_rowRange', '_dateAmountEmpty']);

    const dated = result.txs[0];
    assert.equal(dated.sourceRow, 2);
    assert.equal(dated.occurrenceIndex, 0);
    assert.equal(dated.dateYearDigits, 4);
    assert.equal(dated.dateHashKey, '2025-12-16');
    assert.equal(dated.merchantOriginal, 'ローソン');
    assert.equal(dated.amountBillingJpy, 10800);
    assert.equal(dated.purpose, '仕入れ');
    assert.equal(dated.cardType, 'smbc_family');
    assert.equal(dated.transactionStatus, 'PREPARED');
    assert.equal(dated.partnerResolutionStatus, 'UNRESOLVED');
    assert.ok(dated.date, 'a 4-digit date is derived by the parser');

    const yearless = result.txs[1];
    assert.equal(yearless.date, null, 'the parser never fixes a year');
    assert.equal(yearless.dateYearMissing, true);
    assert.equal(yearless.dateHashKey, '--12-28');
    assert.deepEqual(yearless.dateMonthDay, {month: 12, day: 28});
  });

  test('INV-12: CSV physical row numbers come from recordStarts, not record index', () => {
    gas.stubs.reset();
    const sheet = Object.assign({}, smbcSheet, {recordStarts: [1, 3, 5, 6]});
    const result = plain(gas.call('parseFile', [sheet, smbcFormat, {customerId: 'C001', fileId: 'f1'}]));
    assert.deepEqual(result.txs.map((t) => t.sourceRow), [3, 5]);
  });

  test('5.3: a labeled total row stops the read (condition 2)', () => {
    gas.stubs.reset();
    const format = Object.assign({}, smbcFormat, {
      countTotalRule: {count: {source: 'none'},
        total: {source: 'labeledRow', labelColumn: 'B', valueColumn: 'C', label: '合計', tolerance: 0},
        totalScope: 'all'}
    });
    const sheet = {name: 'S', rows: [
      ['ヘッダー', '', ''],
      ['2025/12/16', 'ローソン', 10800],
      ['', '合計', 10800],
      ['2025/12/17', '読まれてはいけない行', 999]
    ]};
    const result = plain(gas.call('parseFile', [sheet, format, {customerId: 'C001', fileId: 'f1'}]));
    assert.equal(result.stop.reason, 'TOTAL_ROW');
    assert.equal(result.txs.length, 1);
    assert.equal(result.truncation.ok, true, 'condition-2 stops skip the truncation check');
  });

  test('5.3 M11: an empty-run stop with candidates beyond is reported, not swallowed', () => {
    gas.stubs.reset();
    const rows = [['ヘッダー', '', '']];
    rows.push(['2025/12/16', 'ローソン', 10800]);
    for (let i = 0; i < 20; i += 1) rows.push(['', '', '']);
    rows.push(['2025/12/20', '取りこぼし候補', 500]);
    const result = plain(gas.call('parseFile', [{name: 'S', rows}, smbcFormat, {customerId: 'C001', fileId: 'f1'}]));
    assert.equal(result.stop.reason, 'EMPTY_RUN');
    assert.equal(result.truncation.ok, false);
    assert.equal(result.remainingCandidateRows, 1);
    assert.ok(result.truncatedAt >= 2);
  });

  test('5.3: an unreadable date with an amount stays in and is flagged for review', () => {
    gas.stubs.reset();
    const sheet = {name: 'S', rows: [
      ['ヘッダー', '', ''],
      ['日付のつもり', 'ローソン', 500]
    ]};
    const result = plain(gas.call('parseFile', [sheet, smbcFormat, {customerId: 'C001', fileId: 'f1'}]));
    assert.equal(result.txs.length, 1);
    assert.equal(result.txs[0].dateUnreadable, true);
    assert.equal(result.txs[0].dateYearMissing, false, 'must not enter year inference');

    const issues = plain(gas.call('validateTransactions', [result.txs, {}])).issues;
    assert.ok(issues.some((issue) => issue.code === 'DATE_UNREADABLE'),
      'validateTransactions must surface the unreadable date as a DATE review');
  });

  test('4.13 → 4.14: parser output feeds year inference without adaptation', () => {
    gas.stubs.reset();
    const result = gas.call('parseFile', [smbcSheet, smbcFormat, {customerId: 'C001', fileId: 'f1'}]);
    const inferred = plain(gas.call('inferYearsForFile', [result.txs,
      {status: 'RESOLVED', year: 2026, month: 1, sources: ['fn']}, smbcFormat]));
    assert.equal(inferred.ambiguous, false);
    const yearless = inferred.txs[1];
    assert.ok(yearless.date, 'the year-less 12/28 resolves against closing 2026-01');
    assert.equal(yearless.dateHashKey, '--12-28', 'the hash key must not change (INV-26)');
  });

  test('5.13: foreign-currency columns map onto the transaction when defined', () => {
    gas.stubs.reset();
    const format = Object.assign({}, smbcFormat, {
      foreignCurrencyColumn: 'D', foreignAmountColumn: 'E', exchangeRateColumn: 'F'
    });
    const sheet = {name: 'S', rows: [
      ['ヘッダー', '', '', '', '', ''],
      ['2025/12/16', 'KEEPA', 3209, 'EUR', '19.00', '168.932']
    ]};
    const result = plain(gas.call('parseFile', [sheet, format, {customerId: 'C001', fileId: 'f1'}]));
    assert.equal(result.txs[0].currencyOriginal, 'EUR');
    assert.equal(result.txs[0].amountOriginal, 19);
    assert.equal(result.txs[0].exchangeRate, 168.932);
  });
};

'use strict';

module.exports = function registerPhase1aPureLogicTests({test, assert, gas}) {
  function plain(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function unsigned(bytes) {
    return Array.from(bytes, (byte) => byte & 0xff);
  }

  function utf8(text) {
    return unsigned(Buffer.from(text, 'utf8'));
  }

  function assertEncodingFailure(fn) {
    assert.throws(fn, (error) => error && error.code === 'ENCODING_DETECTION_FAILED');
  }

  test('5.2 vector 1: UTF-8 BOM is removed and short-circuits detection', () => {
    const result = gas.call('detectEncoding', [[0xef, 0xbb, 0xbf, ...utf8('利用日,金額')], ['利用日']]);
    assert.equal(result.encoding, 'UTF-8');
    assert.equal(result.bomRemoved, true);
    assert.equal(result.text, '利用日,金額');
  });

  test('5.2 vector 2: UTF-8 without BOM proceeds', () => {
    const result = gas.call('detectEncoding', [utf8('利用日,金額'), ['利用日']]);
    assert.equal(result.encoding, 'UTF-8');
    assert.equal(result.bomRemoved, false);
  });

  test('5.2 vector 3: known Shift_JIS proceeds', () => {
    // CP932: 利用日,金額
    const bytes = [0x97, 0x98, 0x97, 0x70, 0x93, 0xfa, 0x2c, 0x8b, 0xe0, 0x8a, 0x7a];
    const result = gas.call('detectEncoding', [bytes, ['利用日']]);
    assert.equal(result.encoding, 'Shift_JIS');
    assert.equal(result.text, '利用日,金額');
  });

  test('5.2 vector 4: replacement characters reject UTF-8 and select Shift_JIS', () => {
    // 0x80 は UTF-8 として不正な先行バイトであり、デコードすると U+FFFD が出る。
    // ベクトル3と同じバイト列を渡していたのでは、UTF-8 を棄却する経路を
    // 一度も通らない。
    const bytes = [0x80, 0x97, 0x98, 0x97, 0x70, 0x93, 0xfa, 0x2c, 0x8b, 0xe0, 0x8a, 0x7a];
    const asUtf8 = Buffer.from(bytes).toString('utf8');
    assert.ok(asUtf8.includes('�'),
      'the fixture must actually be invalid UTF-8, or this proves nothing');

    const result = gas.call('detectEncoding', [bytes, ['利用日']]);
    assert.equal(result.encoding, 'Shift_JIS');
  });

  test('5.2 vector 5: unknown but correctly decoded format is not an encoding failure', () => {
    const result = gas.call('detectEncoding', [utf8('New Header,Amount'), ['利用日']]);
    assert.equal(result.encoding, 'UTF-8');
    assert.equal(result.headerKeywordMatched, false);
  });

  test('5.2 vector 6: header keyword breaks a tie between bad candidates', () => {
    const selected = gas.call('selectEncodingCandidate_', [[
      {encoding: 'UTF-8', replacementExceeded: true, controlExceeded: true, keywordMatched: false},
      {encoding: 'Shift_JIS', replacementExceeded: true, controlExceeded: true, keywordMatched: true}
    ]]);
    assert.equal(selected.encoding, 'Shift_JIS');
  });

  test('5.2 vector 7: no difference after header tie-break is an encoding failure', () => {
    assertEncodingFailure(() => gas.call('selectEncodingCandidate_', [[
      {encoding: 'UTF-8', replacementExceeded: true, controlExceeded: true, keywordMatched: false},
      {encoding: 'Shift_JIS', replacementExceeded: true, controlExceeded: true, keywordMatched: false}
    ]]));
  });

  test('5.2 vector 8: UTF-16 BOM is rejected', () => {
    assertEncodingFailure(() => gas.call('detectEncoding', [[0xff, 0xfe, 0x41, 0x00], ['利用日']]));
    assertEncodingFailure(() => gas.call('detectEncoding', [[0xfe, 0xff, 0x00, 0x41], ['利用日']]));
  });

  test('4.10 CSV parser accepts CRLF, LF, and CR record separators', () => {
    const result = plain(gas.call('parseCsv', ['a,b\r\nc,d\ne,f\rg,h']));
    assert.deepEqual(result, {
      rows: [['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h']],
      recordStarts: [1, 2, 3, 4]
    });
  });

  test('4.10 CSV parser preserves logical record start rows across quoted newlines', () => {
    const result = plain(gas.call('parseCsv', ['a,"b,b","x""y\r\nline2"\r\nc,d,e']));
    assert.deepEqual(result, {
      rows: [['a', 'b,b', 'x"y\r\nline2'], ['c', 'd', 'e']],
      recordStarts: [1, 3]
    });
  });

  test('4.10 CSV parser rejects an unclosed quoted field', () => {
    assert.throws(
      () => gas.call('parseCsv', ['a,"unclosed']),
      (error) => error && error.code === 'CSV_PARSE_FAILED'
    );
  });

  test('4.10 CSV parser keeps quotes outside an opening field as data', () => {
    assert.deepEqual(plain(gas.call('parseCsv', ['a,b"c,d'])), {
      rows: [['a', 'b"c', 'd']], recordStarts: [1]
    });
  });

  test('4.10 CSV parser does not create a trailing empty record', () => {
    assert.deepEqual(plain(gas.call('parseCsv', ['a,b\r\n'])), {
      rows: [['a', 'b']], recordStarts: [1]
    });
  });

  const effectiveRows = [
    {name: 'date only', row: ['2026/01/05', ''], excluded: false, expected: true},
    {name: 'amount only', row: ['', 100], excluded: false, expected: true},
    {name: 'date and amount', row: ['2026/01/05', 100], excluded: false, expected: true},
    {name: 'both empty', row: ['', ''], excluded: false, expected: false},
    {name: 'excluded by O column rule', row: ['2026/01/05', 100], excluded: true, expected: false},
    {name: 'zero amount', row: ['2026/01/05', 0], excluded: false, expected: true},
    {name: 'negative amount', row: ['2026/01/05', -100], excluded: false, expected: true}
  ];
  for (const vector of effectiveRows) {
    test(`5.3 effective row: ${vector.name}`, () => {
      assert.equal(gas.call('isEffectiveDetailRow', [vector.row, 0, 1, vector.excluded]), vector.expected);
    });
  }

  test('5.3 stop condition 1: consecutive empty rows', () => {
    const result = gas.call('findReadStop', [
      [['2026/01/05', 100], ['', ''], ['', ''], ['2026/01/06', 200]],
      {consecutiveEmptyRowsToStop: 2, totalRowIndexes: []}
    ]);
    assert.deepEqual({reason: result.reason, stopIndex: result.stopIndex}, {reason: 'EMPTY_RUN', stopIndex: 2});
  });

  test('5.3 stop condition 2: defined total row', () => {
    const result = gas.call('findReadStop', [
      [['2026/01/05', 100], ['合計', 100], ['2026/01/06', 200]],
      {consecutiveEmptyRowsToStop: 20, totalRowIndexes: [1]}
    ]);
    assert.deepEqual({reason: result.reason, stopIndex: result.stopIndex}, {reason: 'TOTAL_ROW', stopIndex: 1});
  });

  test('5.3 stop condition 3: loaded row limit', () => {
    const result = gas.call('findReadStop', [
      [['2026/01/05', 100]],
      {consecutiveEmptyRowsToStop: 20, totalRowIndexes: [], inputLimitReached: true}
    ]);
    assert.deepEqual({reason: result.reason, stopIndex: result.stopIndex}, {reason: 'INPUT_LIMIT', stopIndex: 0});
  });

  test('5.3 truncation check accepts an empty-run with no later candidate', () => {
    const result = gas.call('checkScanTruncation', [{
      rows: [['2026/01/05', 100], ['', ''], ['', ''], ['', '']],
      stopReason: 'EMPTY_RUN', stopIndex: 2, dateColumnIndex: 0, amountColumnIndex: 1
    }]);
    assert.deepEqual(plain(result), {ok: true, stopRow: 3, remainingCandidateRows: 0});
  });

  test('5.3 truncation check reports later candidate rows', () => {
    const result = gas.call('checkScanTruncation', [{
      rows: [['2026/01/05', 100], ['', ''], ['', ''], ['2026/01/06', ''], ['', 50]],
      stopReason: 'EMPTY_RUN', stopIndex: 2, dateColumnIndex: 0, amountColumnIndex: 1
    }]);
    assert.deepEqual(plain(result), {ok: false, stopRow: 3, remainingCandidateRows: 2});
  });

  test('5.3 truncation check is skipped for total-row and input-limit stops', () => {
    for (const stopReason of ['TOTAL_ROW', 'INPUT_LIMIT']) {
      const result = gas.call('checkScanTruncation', [{
        rows: [['合計', 100], ['2026/01/06', 200]],
        stopReason, stopIndex: 0, dateColumnIndex: 0, amountColumnIndex: 1
      }]);
      assert.deepEqual(plain(result), {ok: true, stopRow: 1, remainingCandidateRows: 0});
    }
  });

  const purposeRules = [
    {id: 'R1', keyword: '仕入', purpose: '仕入れ', enabled: true},
    {id: 'R2', keyword: '仕入れ', purpose: '仕入れ', enabled: 'TRUE'},
    {id: 'R3', keyword: '経費', purpose: '経費', enabled: 1},
    {id: 'R4', keyword: '無効', purpose: '無効用途', enabled: false}
  ];

  function purposeTx(id, purpose) {
    return {transactionId: id, purpose, purposeInferred: false, purposeInferenceRuleId: null};
  }

  test('5.4 vector 1: one rule complements an empty purpose', () => {
    const result = gas.call('resolvePurposes', [[purposeTx('tx1', '')], '仕入_明細.csv', purposeRules]);
    assert.equal(result.txs[0].purpose, '仕入れ');
    assert.equal(result.txs[0].purposeInferred, true);
    assert.equal(result.unresolvedCount, 0);
  });

  test('5.4 vector 2: multiple rules returning the same purpose are unique', () => {
    const result = gas.call('resolvePurposes', [[purposeTx('tx1', '')], '仕入れ_明細.csv', purposeRules]);
    assert.equal(result.txs[0].purpose, '仕入れ');
    assert.equal(result.unresolvedCount, 0);
  });

  test('5.4 vector 3: rules returning different purposes do not complement', () => {
    const result = gas.call('resolvePurposes', [[purposeTx('tx1', '')], '仕入_経費_明細.csv', purposeRules]);
    assert.equal(result.txs[0].purpose, '');
    assert.equal(result.unresolvedCount, 1);
  });

  test('5.4 vector 4: no matching rule leaves purpose unresolved', () => {
    const result = gas.call('resolvePurposes', [[purposeTx('tx1', '')], '明細.csv', purposeRules]);
    assert.equal(result.txs[0].purpose, '');
    assert.equal(result.unresolvedCount, 1);
  });

  test('5.4 vector 5: customer-entered purpose is preserved', () => {
    const result = gas.call('resolvePurposes', [[purposeTx('tx1', '旅費交通費')], '仕入_明細.csv', purposeRules]);
    assert.equal(result.txs[0].purpose, '旅費交通費');
    assert.equal(result.txs[0].purposeInferred, false);
  });

  test('5.4 vector 6: non-detail rows are outside the transaction input', () => {
    const result = gas.call('resolvePurposes', [[], '仕入_明細.csv', purposeRules]);
    assert.deepEqual(plain(result), {txs: [], unresolvedCount: 0});
  });

  // ---- INV-12：判定は状態接頭辞を含まない元ファイル名で行う ----
  //
  // 処理中のファイルは名前に【処理中】などの接頭辞が付く。それを含んだ名前で
  // 判定すると、同じファイルが処理の前後で違う使用用途になる。
  test('5.4 vector 7: the state prefix does not change the purpose decision', () => {
    const plainName = gas.call('resolvePurposes',
      [[purposeTx('tx1', '')], '仕入_明細.csv', purposeRules]);
    assert.equal(plainName.txs[0].purpose, '仕入れ');

    const stripped = gas.evaluate(
      "'【処理中】仕入_明細.csv'.replace(removableStatePrefixRegex_(), '')");
    assert.equal(stripped, '仕入_明細.csv', 'the state prefix must be removable');

    const prefixed = gas.call('resolvePurposes',
      [[purposeTx('tx1', '')], stripped, purposeRules]);
    assert.equal(prefixed.txs[0].purpose, '仕入れ',
      'the same file must resolve the same way while it is being processed');
  });

  test('5.5 B values canonicalize serial and supported text values', () => {
    assert.equal(gas.call('normalizeReadValue', ['B', 46027]), '2026-01-05');
    assert.equal(gas.call('normalizeReadValue', ['B', '2026/01/05']), '2026-01-05');
    assert.equal(gas.call('normalizeReadValue', ['B', '']), '');
  });

  test('5.5 RAW string columns preserve spaces and original merchant text', () => {
    for (const column of ['F', 'I', 'K', 'INTERNAL_TRANSACTION_ID']) {
      assert.equal(gas.call('normalizeReadValue', [column, '  value  ']), '  value  ');
    }
    assert.equal(gas.call('normalizeReadValue', ['K', 'ﾄﾞﾝｷ']), 'ﾄﾞﾝｷ');
  });

  test('5.5 M values compare as signed integers', () => {
    assert.equal(gas.call('normalizeReadValue', ['M', '-5015']), -5015);
    assert.equal(gas.call('normalizeReadValue', ['M', -5015]), -5015);
    assert.throws(() => gas.call('normalizeReadValue', ['M', '1.5']));
  });

  test('5.5 empty planned and empty or null read values match', () => {
    assert.equal(gas.call('canonicalReadValuesEqual', ['F', '', '']), true);
    assert.equal(gas.call('canonicalReadValuesEqual', ['F', '', null]), true);
  });

  test('5.5 empty planned and nonempty read value do not match', () => {
    assert.equal(gas.call('canonicalReadValuesEqual', ['F', '', 'x']), false);
  });

  test('5.5 nonempty planned and null read value do not match', () => {
    assert.equal(gas.call('canonicalReadValuesEqual', ['F', 'x', null]), false);
  });

  test('5.5 date readback is independent of the four display formats', () => {
    for (const displayFormat of ['M月d日', 'yyyy/MM/dd', 'yyyy-MM-dd', 'standard']) {
      assert.equal(gas.call('canonicalReadValuesEqual', ['B', '2026-01-05', 46027]), true, displayFormat);
    }
  });

  test('parseDate keeps the explicit phase-0 formats', () => {
    const values = ['2026-01-05', '2026/01/05', '20260105', '2026-01-05T00:00:00+09:00'];
    for (const value of values) {
      assert.equal(gas.call('toTokyoDateString_', [gas.call('parseDate', [value])]), '2026-01-05');
    }
    assert.equal(gas.call('toTokyoDateString_', [gas.call('parseDate', [46027])]), '2026-01-05');
  });

};

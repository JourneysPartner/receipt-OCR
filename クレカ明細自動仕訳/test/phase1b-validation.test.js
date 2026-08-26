'use strict';

module.exports = function registerPhase1bValidationTests({test, assert, gas}) {
  function plain(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function tx(amount) {
    return {amountBillingJpy: amount};
  }

  function rule(count, total, totalScope = 'all') {
    return {count, total, totalScope};
  }

  function format(reconciliation) {
    return {countTotalRule: reconciliation};
  }

  test('5.9 case 1: count and total source none is not applicable', () => {
    const result = plain(gas.call('verifyCountsAndTotals', [
      [tx(100)], format(rule({source: 'none'}, {source: 'none'})), {}, {}
    ]));
    assert.deepEqual(result, {ok: true, expected: {}, actual: {}, kind: 'NOT_APPLICABLE'});
  });

  test('5.9 case 2: a missing labeled row makes that item not applicable', () => {
    const result = gas.call('verifyCountsAndTotals', [[tx(100)], format(rule(
      {source: 'labeledRow', label: '件数', labelColumn: 'A', valueColumn: 'B'},
      {source: 'none'}
    )), {rows: [{A: '合計', B: 1}]}, {}]);
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'NOT_APPLICABLE');
  });

  test('5.9 case 3: count and total inside tolerance pass', () => {
    const result = plain(gas.call('verifyCountsAndTotals', [
      [tx(100), tx(200)],
      format(rule(
        {source: 'cell', cell: 'A1', tolerance: 0},
        {source: 'cell', cell: 'B1', tolerance: 1}
      )),
      {cells: {A1: '2', B1: '301'}},
      {}
    ]));
    assert.deepEqual(result, {
      ok: true,
      expected: {count: 2, total: 301},
      actual: {count: 2, total: 300},
      kind: 'MATCH'
    });
  });

  test('5.9 case 4: count mismatch is category 2 material', () => {
    const result = gas.call('verifyCountsAndTotals', [
      [tx(100)], format(rule({source: 'cell', cell: 'A1'}, {source: 'none'})), {cells: {A1: 2}}, {}
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'COUNT');
    assert.equal(result.code, 'COUNT_TOTAL_MISMATCH');
  });

  test('5.9 case 5: total mismatch is category 2 material', () => {
    const result = gas.call('verifyCountsAndTotals', [
      [tx(100)], format(rule({source: 'none'}, {source: 'cell', cell: 'B1'})), {cells: {B1: 101}}, {}
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'TOTAL');
    assert.equal(result.code, 'COUNT_TOTAL_MISMATCH');
  });

  test('5.9 case 6: allowed expression handles fees, balances, and returns', () => {
    const result = gas.call('verifyCountsAndTotals', [
      [tx(1000), tx(-200), tx(500)],
      format(rule(
        {source: 'none'},
        {source: 'cell', cell: 'B1', expression: 'SUM_POSITIVE + SUM_NEGATIVE + 100'}
      )),
      {cells: {B1: 1400}},
      {}
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.actual.total, 1400);
  });

  test('5.9 case 7: a forbidden expression token is a format-definition error', () => {
    const result = gas.call('verifyCountsAndTotals', [
      [tx(100)],
      format(rule({source: 'none'}, {source: 'cell', cell: 'B1', expression: 'Math.max(SUM, 0)'})),
      {cells: {B1: 100}},
      {}
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CARD_FORMAT_DEFINITION_INVALID');
    assert.equal(result.kind, 'DEFINITION');
  });

  test('5.9 case 7 integration: invalid expression is classified as category 2', () => {
    const input = validInput();
    input.countsTotals = {ok: false, code: 'CARD_FORMAT_DEFINITION_INVALID', kind: 'DEFINITION'};
    const result = gas.call('classifyValidationResult', [input]);
    assert.equal(result.category, 2);
    assert.equal(result.code, 'CARD_FORMAT_DEFINITION_INVALID');
    assert.equal(result.reviewEntries[0].reviewType, 'FORMAT_UNKNOWN');
  });

  test('5.9 case 8: zero effective transactions require confirmation', () => {
    const result = gas.call('verifyCountsAndTotals', [
      [], format(rule({source: 'none'}, {source: 'none'})), {}, {}
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EMPTY_FILE_CONFIRMATION_REQUIRED');
    assert.equal(result.kind, 'EMPTY');
  });

  // ---- INV-28：承認したものが再検証で読めなければ無限ループになる ----
  //
  // 以前は生成側・保存側・判定側でスキーマが3通りに分かれており、
  // **生成した承認を保存しても判定側が永遠に偽を返した**。担当者が承認しても
  // 再検証で同じ区分2が再検出され、REVIEW_WAIT へ戻り続ける。
  // ここで確認するのは往復である。作った承認がそのまま判定を通ること。
  test('INV-28: an approval that was created is recognised on re-validation', () => {
    const approval = gas.call('createValidationApproval',
      ['COUNT_TOTAL_MISMATCH', 'HASH1', '3', 'reviewer@example.com']);
    assert.equal(approval.code, 'COUNT_TOTAL_MISMATCH');
    assert.equal(approval.approvedBy, 'reviewer@example.com');
    assert.ok(approval.approvedAt, 'the approval must carry when it happened');

    const asStored = {validationApprovals: [approval], contentHash: 'HASH1', hashVersion: '3'};
    assert.equal(gas.call('validationCauseApproved_', [asStored, 'COUNT_TOTAL_MISMATCH']), true,
      'the created approval must satisfy the very check that gates re-validation');
  });

  // ---- 承認後に中身が差し替えられたら、古い承認を流用しない ----
  test('INV-28: an approval does not carry over to different file contents', () => {
    const approval = gas.call('createValidationApproval',
      ['COUNT_TOTAL_MISMATCH', 'HASH1', '3', 'reviewer@example.com']);

    assert.equal(gas.call('validationCauseApproved_',
      [{validationApprovals: [approval], contentHash: 'HASH2', hashVersion: '3'},
       'COUNT_TOTAL_MISMATCH']), false,
      'replacing the file under the same id must invalidate the approval');

    assert.equal(gas.call('validationCauseApproved_',
      [{validationApprovals: [approval], contentHash: 'HASH1', hashVersion: '4'},
       'COUNT_TOTAL_MISMATCH']), false,
      'an approval made under a different hash rule must not be reused');

    assert.equal(gas.call('validationCauseApproved_',
      [{validationApprovals: [approval], contentHash: 'HASH1', hashVersion: '3'},
       'INPUT_LIMIT_EXCEEDED']), false,
      'approving one cause must not approve a different one');
  });

  test('2.1.8.2: an approval missing a required key is rejected at creation', () => {
    [['COUNT_TOTAL_MISMATCH', 'HASH1', '3', ''],
     ['COUNT_TOTAL_MISMATCH', 'HASH1', '', 'reviewer@example.com'],
     ['COUNT_TOTAL_MISMATCH', '', '3', 'reviewer@example.com'],
     ['', 'HASH1', '3', 'reviewer@example.com']].forEach((args) => {
      assert.throws(() => gas.call('createValidationApproval', args),
        (error) => error && /createValidationApproval requires/.test(String(error.message)),
        `incomplete approval ${JSON.stringify(args)} must be rejected`);
    });
  });

  test('5.9 case 10: matching persisted approval lets revalidation proceed', () => {
    const result = gas.call('verifyCountsAndTotals', [
      [tx(100)],
      format(rule({source: 'cell', cell: 'A1'}, {source: 'none'})),
      {cells: {A1: 2}},
      {
        contentHash: 'HASH1', hashVersion: '3',
        validationApprovals: [gas.call('createValidationApproval',
          ['COUNT_TOTAL_MISMATCH', 'HASH1', '3', 'reviewer@example.com'])]
      }
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.approved, true);
  });

  // ---- 必須キーの欠落を「一致」として扱わない ----
  test('2.1.8.2: an approval without a hash version does not silently match', () => {
    const call = (processLogRow) => gas.call('verifyCountsAndTotals', [
      [tx(100)],
      format(rule({source: 'cell', cell: 'A1'}, {source: 'none'})),
      {cells: {A1: 2}},
      processLogRow
    ]);

    // 双方が hashVersion を欠くと undefined 同士が一致してしまっていた
    assert.equal(call({
      contentHash: 'HASH1',
      validationApprovals: [{code: 'COUNT_TOTAL_MISMATCH', contentHash: 'HASH1'}]
    }).ok, false, 'a malformed approval must not pass the gate');
  });

  test('5.9 case 11: approval cannot be reused after content changes', () => {
    const result = gas.call('verifyCountsAndTotals', [
      [tx(100)],
      format(rule({source: 'cell', cell: 'A1'}, {source: 'none'})),
      {cells: {A1: 2}},
      {
        contentHash: 'HASH2',
        validationApprovals: [{approved: true, code: 'COUNT_TOTAL_MISMATCH', contentHash: 'HASH1'}]
      }
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'COUNT_TOTAL_MISMATCH');
  });

  function validInput() {
    return {
      transactionValidation: {issues: []},
      yearInference: {ambiguous: false, rowIssues: []},
      dateTriage: {issues: [], blankDateTxIds: []},
      priorYear: {issues: []},
      foreignCurrency: {diagnostics: []},
      purposeResolution: {unresolvedCount: 0},
      destinationSchema: {ok: true},
      duplicate: {duplicate: false},
      purposeRevision: {candidate: false},
      encoding: {ok: true},
      format: {ok: true},
      countsTotals: {ok: true},
      scanTruncation: {ok: true},
      inputLimit: {ok: true},
      effectiveTransactionCount: 1,
      contentHash: 'HASH1',
      validationApprovals: []
    };
  }

  const category2Cases = [
    [1, 'format', {ok: false, code: 'UNKNOWN_CARD_FORMAT'}, 'FORMAT_UNKNOWN'],
    [2, 'format', {ok: false, code: 'AMBIGUOUS_CARD_FORMAT'}, 'FORMAT_AMBIGUOUS'],
    [3, 'format', {ok: false, code: 'MULTI_SHEET_AMBIGUOUS'}, 'MULTI_SHEET'],
    [4, 'format', {ok: false, code: 'CARD_FORMAT_DEFINITION_INVALID'}, 'FORMAT_UNKNOWN'],
    [5, 'destinationSchema', {ok: false, code: 'DESTINATION_SCHEMA_MISMATCH'}, 'DESTINATION_FIX'],
    [6, 'destinationSchema', {ok: false, code: 'DESTINATION_TEMPLATE_ROW_NOT_EMPTY'}, 'DESTINATION_FIX'],
    [7, 'encoding', {ok: false, code: 'ENCODING_DETECTION_FAILED'}, 'FORMAT_UNKNOWN'],
    [8, 'encoding', {ok: false, code: 'CSV_PARSE_FAILED'}, 'FORMAT_UNKNOWN'],
    [9, 'duplicate', {duplicate: true, code: 'DUPLICATE_CONTENT'}, 'DUPLICATE'],
    [10, 'purposeRevision', {candidate: true, code: 'PURPOSE_REVISION_CANDIDATE'}, 'DUPLICATE'],
    [11, 'countsTotals', {ok: false, code: 'COUNT_TOTAL_MISMATCH'}, 'COUNT_TOTAL_MISMATCH'],
    [12, 'scanTruncation', {ok: false, code: 'SCAN_TRUNCATION_SUSPECTED'}, 'SCAN_TRUNCATED'],
    [13, 'effectiveTransactionCount', 0, 'EMPTY_FILE'],
    [14, 'inputLimit', {ok: false, code: 'INPUT_LIMIT_EXCEEDED'}, 'INPUT_LIMIT']
  ];

  for (const [number, key, value, reviewType] of category2Cases) {
    test(`5.10 category-2 condition ${number}`, () => {
      const input = validInput();
      input[key] = value;
      const result = plain(gas.call('classifyValidationResult', [input]));
      assert.equal(result.category, 2);
      assert.equal(result.reviewEntries[0].reviewType, reviewType);
    });
  }

  test('5.10 evaluation order: category 2 outranks categories 1 and 3', () => {
    const input = validInput();
    input.duplicate = {duplicate: true, code: 'DUPLICATE_CONTENT'};
    input.purposeResolution = {unresolvedCount: 1};
    input.priorYear = {issues: [{reviewType: 'PRIOR_YEAR', code: 'PRIOR_YEAR_USAGE_DATE'}]};
    assert.equal(gas.call('classifyValidationResult', [input]).category, 2);
  });

  test('5.10 category 1: unresolved required purpose causes customer return', () => {
    const input = validInput();
    input.purposeResolution = {unresolvedCount: 1};
    const result = gas.call('classifyValidationResult', [input]);
    assert.equal(result.category, 1);
    assert.equal(result.code, 'SOURCE_REQUIRES_CUSTOMER_FIX');
  });

  test('5.10 category 1: required merchant absence causes customer return', () => {
    const input = validInput();
    input.transactionValidation = {issues: [{kind: 'MERCHANT_REQUIRED', customerFix: true}]};
    assert.equal(gas.call('classifyValidationResult', [input]).category, 1);
  });

  test('5.10 category 3: date, amount, zero, and prior-year issues reserve rows', () => {
    const input = validInput();
    input.transactionValidation = {issues: [
      {transactionId: 'A', reviewType: 'AMOUNT'},
      {transactionId: 'Z', reviewType: 'ZERO_AMOUNT'}
    ]};
    input.dateTriage = {issues: [{transactionId: 'D', reviewType: 'DATE'}], blankDateTxIds: ['D']};
    input.priorYear = {issues: [{transactionId: 'P', reviewType: 'PRIOR_YEAR'}]};
    const result = plain(gas.call('classifyValidationResult', [input]));
    assert.equal(result.category, 3);
    assert.deepEqual(result.blankDateTxIds, ['D']);
    assert.deepEqual(result.reviewEntries.map((entry) => entry.reviewType).sort(), ['AMOUNT', 'DATE', 'PRIOR_YEAR', 'ZERO_AMOUNT']);
  });

  test('5.10 category 3: prior-year alone does not blank planned B', () => {
    const input = validInput();
    input.priorYear = {issues: [{transactionId: 'P', reviewType: 'PRIOR_YEAR'}]};
    const result = gas.call('classifyValidationResult', [input]);
    assert.equal(result.category, 3);
    assert.deepEqual(plain(result.blankDateTxIds), []);
  });

  test('4.14 contract: no applicable validation category returns category null', () => {
    const result = plain(gas.call('classifyValidationResult', [validInput()]));
    assert.equal(result.category, null);
    assert.equal(result.code, null);
    assert.deepEqual(result.reviewEntries, []);
  });

  test('5.10 valid approval removes its category-2 cause', () => {
    const input = validInput();
    input.countsTotals = {ok: false, code: 'COUNT_TOTAL_MISMATCH'};
    input.contentHash = 'HASH1';
    input.hashVersion = '3';
    input.validationApprovals = [gas.call('createValidationApproval',
      ['COUNT_TOTAL_MISMATCH', 'HASH1', '3', 'reviewer@example.com'])];
    const result = gas.call('classifyValidationResult', [input]);
    assert.equal(result.category, null,
      'an approved cause must stop being a category-2 cause');
  });

  // ---- 承認が別要因・別内容へ流用されない ----
  test('5.10 an approval for one cause does not clear a different cause', () => {
    const input = validInput();
    input.countsTotals = {ok: false, code: 'COUNT_TOTAL_MISMATCH'};
    input.contentHash = 'HASH1';
    input.hashVersion = '3';
    input.validationApprovals = [gas.call('createValidationApproval',
      ['INPUT_LIMIT_EXCEEDED', 'HASH1', '3', 'reviewer@example.com'])];
    assert.equal(gas.call('classifyValidationResult', [input]).category, 2);
  });

  test('5.10 foreign-currency absence never creates a category', () => {
    const input = validInput();
    input.foreignCurrency = {currencyCode: null, localAmount: null, exchangeRate: null, diagnostics: []};
    assert.equal(gas.call('classifyValidationResult', [input]).category, null);
  });
};

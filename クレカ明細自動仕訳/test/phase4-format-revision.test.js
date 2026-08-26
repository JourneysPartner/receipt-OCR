'use strict';

/**
 * 4.12.6 形式の改訂（カード会社の出力変更・仕様18.5）。
 *
 * 改訂の要否を操作者の印象で決めない。要らないのに改訂すると定義が増えて
 * 判定衝突の危険が上がり、要るのに改訂しないと顧客のファイルが本番で止まる。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: []});
    gas.stubs.setActiveSpreadsheet('master');
  }

  /** 現在の定義で問題なく読めている状態。 */
  const healthy = (overrides = {}) => Object.assign({
    detection: {matched: true},
    extraction: {
      transactions: [
        {sourceRow: 5, date: '2026-01-05', amountBillingJpy: 1200,
         merchant: 'コンビニA', purpose: '消耗品'},
        {sourceRow: 6, date: '2026-01-08', amountBillingJpy: 5400,
         merchant: 'ガソリンB', purpose: '車両費'}
      ],
      excludedRows: [{rowNumber: 7, reason: '__EMPTY__'}],
      reconciliation: {ok: true},
      billingMonth: {status: 'RESOLVED', yearMonth: '2026-01'}
    },
    operator: {}
  }, overrides);

  const assess = (input) => plain(gas.call('assessRevisionNeed', [input]));

  // ================= 改訂が不要な場合 =================

  test('4.12.6: a sample the current definition handles needs no revision', () => {
    setup();
    const result = assess(healthy());
    assert.equal(result.required, false);
    assert.deepEqual(result.conditions, []);
  });

  test('4.12.6: agreeing with the operator on every row still needs no revision', () => {
    setup();
    const result = assess(healthy({operator: {
      detailRowCount: 2,
      rowsThatAreNotTransactions: [7],
      rowValues: [{sourceRow: 5, date: '2026-01-05', amountBillingJpy: 1200,
                   merchant: 'コンビニA', purpose: '消耗品'}]
    }}));
    assert.equal(result.required, false);
  });

  // ================= 6条件 =================

  test('condition a: the current definition no longer matches the file', () => {
    setup();
    const result = assess(healthy({detection: {matched: false}}));
    assert.equal(result.required, true);
    assert.equal(result.conditions[0].code, 'a');
  });

  test('condition b: the extracted count differs from what the operator counted', () => {
    setup();
    const result = assess(healthy({operator: {detailRowCount: 3}}));
    assert.equal(result.conditions[0].code, 'b');
    assert.equal(result.conditions[0].expected, 3);
    assert.equal(result.conditions[0].actual, 2);
  });

  test('condition c: a real transaction was excluded', () => {
    setup();
    const result = assess(healthy({operator: {rowsThatAreTransactions: [7]}}));
    assert.equal(result.conditions[0].code, 'c');
    assert.equal(result.conditions[0].rowNumber, 7);
  });

  test('condition d: a total line was booked as a transaction', () => {
    setup();
    const result = assess(healthy({operator: {rowsThatAreNotTransactions: [6]}}));
    assert.equal(result.conditions[0].code, 'd');
    assert.equal(result.conditions[0].rowNumber, 6);
  });

  test('condition e: the check expression or the billing month failed', () => {
    setup();
    assert.equal(assess(healthy({extraction: Object.assign(healthy().extraction,
      {reconciliation: {ok: false}})})).conditions[0].code, 'e');

    const noBilling = healthy();
    noBilling.extraction.billingMonth = {status: 'NOT_FOUND'};
    assert.equal(assess(noBilling).conditions[0].code, 'e');
  });

  // 請求年月を持たない形式は正常である。持たないことを不備として扱わない。
  test('condition e: a format without a billing month source is not deficient', () => {
    setup();
    const noBilling = healthy({formatHasReconciliation: false});
    noBilling.extraction.billingMonth = {status: 'NOT_FOUND'};
    assert.equal(assess(noBilling).required, false,
      'a format whose Q column is empty legitimately has no billing month');
  });

  test('condition f: a value differs from what the operator read in the file', () => {
    setup();
    const result = assess(healthy({operator: {
      rowValues: [{sourceRow: 5, amountBillingJpy: 1250}]
    }}));
    assert.equal(result.conditions[0].code, 'f');
    assert.equal(result.conditions[0].item, 'amountBillingJpy');
    assert.equal(result.conditions[0].expected, 1250);
    assert.equal(result.conditions[0].actual, 1200);
  });

  test('4.12.6: every failing condition is reported, not just the first', () => {
    setup();
    const result = assess(healthy({
      detection: {matched: false},
      operator: {detailRowCount: 5, rowsThatAreTransactions: [7]}
    }));
    const codes = result.conditions.map((c) => c.code);
    assert.ok(codes.indexOf('a') >= 0);
    assert.ok(codes.indexOf('b') >= 0);
    assert.ok(codes.indexOf('c') >= 0);
  });

  // ================= B-M13：差分だけを答え直す =================

  test('B-M13: the revision dialog starts from the previous answers', () => {
    setup();
    const previous = {headerRows: [5], dataStartRow: 7, keywords: ['ご利用日', 'ご利用先']};
    const result = plain(gas.call('buildRevisionAnswers', [previous, {}]));
    assert.deepEqual(result.answers, previous,
      'answering all thirteen questions again invites typos into an unchanged definition');
    assert.equal(result.source, 'PREVIOUS_ANSWERS');
  });

  test('B-M13: a format with no stored answers derives them from its definition', () => {
    setup();
    const definition = {
      fileTypes: ['csv'], headerRows: [5], dataStartRow: 7,
      dateColumn: 1, amountColumn: 3, merchantColumn: 2,
      keywords: ['ご利用日'], keywordMinMatch: 1,
      excludeRowRanges: [{from: 1, to: 6}]
    };
    const result = plain(gas.call('buildRevisionAnswers', [null, definition]));
    assert.equal(result.source, 'DERIVED_FROM_DEFINITION');
    assert.deepEqual(result.answers.headerRows, [5]);
    assert.deepEqual(result.answers.excludeRowRanges, [{from: 1, to: 6}]);
    assert.equal(result.answers.dateColumn, 1,
      'the initial four formats have no stored answers - they must not start blank');
  });

  test('B-M13: the derived answers do not alias the definition', () => {
    setup();
    const definition = {headerRows: [5], keywords: ['ご利用日']};
    const result = gas.call('buildRevisionAnswers', [null, definition]);
    result.answers.headerRows.push(99);
    assert.deepEqual(plain(definition).headerRows, [5],
      'editing the draft must not mutate the active definition');
  });

  // ================= 手順4：改訂版の下書き =================

  test('4.12.6: a revision draft takes the next version and stays disabled', () => {
    setup();
    const draft = plain(gas.call('buildRevisionDraft', [{
      formatId: 'saison', existingVersions: [1, 2], answers: {headerRows: [5]},
      actor: 'admin@example.com'
    }]));
    assert.equal(draft.version, 3);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.enabled, false,
      'activation happens only after the three gates pass (INV-34)');
    assert.equal(draft.revisionReason, 'ISSUER_EXPORT_CHANGED');
  });

  test('4.12.6: an unsupported revision reason is refused', () => {
    setup();
    assert.throws(() => gas.call('buildRevisionDraft',
      [{formatId: 'saison', existingVersions: [1], reason: 'BECAUSE'}]),
      (error) => error && /revision reason/.test(String(error.message)));
  });

  // ================= 旧様式と新様式を分けられない場合 =================

  test('4.12.6: when the revision cannot detect the old sample, two options are offered', () => {
    setup();
    const options = plain(gas.call('revisionFallbackOptions', [{
      result: 'FAIL',
      failures: [{reason: 'REVISED_DEF_MISSES_PRIOR_SAMPLE', sampleId: 'S_OLD'}]
    }]));
    assert.equal(options.applicable, true);
    assert.equal(options.options.length, 2);
  });

  // 旧様式のファイルが今後も提出され得る限り、旧サンプルは残すべきである。
  test('4.12.6: registering a separate format is the recommended option, not retiring', () => {
    setup();
    const options = plain(gas.call('revisionFallbackOptions', [{
      failures: [{reason: 'REVISED_DEF_MISSES_PRIOR_SAMPLE'}]
    }]));
    assert.equal(options.options[0].code, 'REGISTER_AS_NEW_FORMAT');
    assert.equal(options.options[0].recommended, true);
    assert.equal(options.options[1].code, 'RETIRE_PRIOR_SAMPLE');
    assert.equal(options.options[1].recommended, false,
      'retiring the old sample abandons the customers still sending the old layout');
    assert.ok(options.options[1].warning,
      'the loss of regression coverage must be stated where the decision is made');
  });

  test('4.12.6: no options are offered when the revision handles the old sample', () => {
    setup();
    const options = plain(gas.call('revisionFallbackOptions', [{result: 'PASS', failures: []}]));
    assert.equal(options.applicable, false);
  });

  // ---- SAMPLE_LAST_OF_FORMAT ----
  test('4.12.6: retiring the last regression sample of a format is refused', () => {
    setup();
    const result = plain(gas.call('canRetireSample', ['S_OLD', [
      {sampleId: 'S_OLD', status: 'ACTIVE'}
    ]]));
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'SAMPLE_LAST_OF_FORMAT',
      'a format with no regression sample has nothing holding later revisions to account');
  });

  test('4.12.6: retiring is allowed once another active sample remains', () => {
    setup();
    const result = plain(gas.call('canRetireSample', ['S_OLD', [
      {sampleId: 'S_OLD', status: 'ACTIVE'},
      {sampleId: 'S_NEW', status: 'ACTIVE'}
    ]]));
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 1);
  });

  test('4.12.6: a pending sample does not count as remaining coverage', () => {
    setup();
    const result = plain(gas.call('canRetireSample', ['S_OLD', [
      {sampleId: 'S_OLD', status: 'ACTIVE'},
      {sampleId: 'S_NEW', status: 'PENDING'}
    ]]));
    assert.equal(result.allowed, false,
      'a pending sample has no expected values, so it regresses nothing yet');
  });
};

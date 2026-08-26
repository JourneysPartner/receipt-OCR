'use strict';

module.exports = function registerPhase1bSheetPriorForeignTests({test, assert, gas}) {
  function plain(value) {
    return JSON.parse(JSON.stringify(value));
  }

  const cellCases = [
    [1, '', '', true],
    [2, '', '=IF(A1="","",A1)', true],
    [3, 'value', '', false],
    [4, 'value', '=A1', false]
  ];
  for (const [number, value, formula, expected] of cellCases) {
    test(`5.11 empty-cell case ${number}`, () => {
      assert.equal(gas.call('isDestinationCellEmpty', [value, formula]), expected);
    });
  }

  test('5.11 row rule: every header-range cell empty means empty row', () => {
    assert.equal(gas.call('isDestinationRowEmpty', [
      ['', '', null, ''], ['', '=IF(A1="","",A1)', '', ''], 4
    ]), true);
  });

  test('5.11 row rule: any used header-range cell protects the row', () => {
    assert.equal(gas.call('isDestinationRowEmpty', [
      ['', '', '', '', '勘定科目'], ['', '', '', '', ''], 5
    ]), false);
  });

  test('5.11 findEmptyRows evaluates the full configured header range', () => {
    // 実際の `buildIndex` が返す形（Map を持つ）で渡す。架空の形で試験すると、
    // 実物では動かない実装が緑のまま残る。Map は VM 内で作る。
    const result = plain(gas.evaluate(`
      findEmptyRows({rowScanLastColumn: 5, headerRow: 9}, 2, {
        rangeStart: 10, rangeEnd: 12, lastColumn: 5,
        valuesByRow: new Map([
          [10, ['', '', '', '', '勘定科目']],           // 静的な値 → 使用中
          [11, ['', '', '', '', '']],
          [12, ['', '', '', '', '']]
        ]),
        formulasByRow: new Map([
          [10, ['', '', '', '', '']],
          [11, ['', '=IF(A11="","",A11)', '', '', '']], // 数式ありで結果が空 → 空き
          [12, ['', '', '', '', '']]
        ])
      })
    `));
    assert.deepEqual(result, [11, 12]);
  });

  test('5.11 template case 1: enough rows means no expansion', () => {
    assert.deepEqual(plain(gas.call('planTemplateExpansion', [{requiredCount: 2, emptyRowCount: 2, templateSourceValid: true}])), {
      action: 'NONE', rowsToAdd: 0, code: null
    });
  });

  test('5.11 template case 2: shortage plans exactly the missing rows', () => {
    assert.deepEqual(plain(gas.call('planTemplateExpansion', [{requiredCount: 5, emptyRowCount: 2, templateSourceValid: true}])), {
      action: 'EXPAND', rowsToAdd: 3, code: null
    });
  });

  test('5.11 template case 3: invalid template source stops without guessing', () => {
    const result = gas.call('planTemplateExpansion', [{requiredCount: 5, emptyRowCount: 2, templateSourceValid: false}]);
    assert.equal(result.action, 'STOP');
    assert.equal(result.code, 'INVALID_TEMPLATE_SOURCE');
  });

  test('5.11 template case 4: copied value columns are cleared', () => {
    const result = plain(gas.call('clearTemplateValueCells', [{
      A: 'keep formula result', B: 'date', F: 'partner', I: 'purpose', K: 'merchant', M: 100,
      INTERNAL_TRANSACTION_ID: 'TX1'
    }]));
    assert.deepEqual(result, {
      A: 'keep formula result', B: '', F: '', I: '', K: '', M: '', INTERNAL_TRANSACTION_ID: ''
    });
  });

  test('5.11 template case 5: expanded rows failing emptiness validation stop once', () => {
    const result = gas.call('planTemplateExpansion', [{
      requiredCount: 5, emptyRowCount: 2, templateSourceValid: true, expandedRowsValid: false
    }]);
    assert.equal(result.action, 'STOP');
    assert.equal(result.code, 'DESTINATION_TEMPLATE_ROW_NOT_EMPTY');
    assert.equal(result.retry, false);
  });

  function priorTx(id, date) {
    return {
      transactionId: id,
      date: date === null ? null : new Date(`${date}T00:00:00+09:00`)
    };
  }

  function priorIssues(customerCategory, fiscalYear, usageDate, blankIds = []) {
    return plain(gas.call('checkPriorYearUsage', [[priorTx('TX1', usageDate)], {
      customerId: 'CFIX', customerCategory, fiscalYear
    }, blankIds])).issues;
  }

  const priorCases = [
    [1, 'INDIVIDUAL', 2026, '2025-12-28', [], true],
    [2, 'INDIVIDUAL', 2026, '2026-01-05', [], false],
    [3, 'INDIVIDUAL', 2026, '2024-08-15', [], true],
    [4, 'CORPORATE', null, '2025-12-28', [], false],
    [5, 'INDIVIDUAL', 2026, null, ['TX1'], false],
    [6, 'INDIVIDUAL', 2025, '2025-12-28', [], false],
    [7, 'INDIVIDUAL', 2026, '2023-05-10', ['TX1'], false],
    [9, 'INDIVIDUAL', 2024, '2024-08-15', [], false]
  ];

  for (const [number, category, fiscalYear, usageDate, blankIds, expected] of priorCases) {
    test(`5.12 case ${number}: prior-year judgement`, () => {
      const issues = priorIssues(category, fiscalYear, usageDate, blankIds);
      assert.equal(issues.length > 0, expected);
      if (expected) {
        assert.equal(issues[0].reviewType, 'PRIOR_YEAR');
        assert.equal(issues[0].code, 'PRIOR_YEAR_USAGE_DATE');
        assert.equal(issues[0].detail.fiscalYear, fiscalYear);
        assert.equal(issues[0].detail.thresholdYear, fiscalYear - 1);
        assert.equal(issues[0].detail.usageDate, usageDate);
      }
    });
  }

  test('5.12 case 8: EXCLUDE_PRIOR_YEAR cancels and clears but retains the log record', () => {
    const result = plain(gas.call('resolvePriorYearUsage', [{
      transactionId: 'TX1', transactionStatus: 'REVIEW_REQUIRED', rowNumber: 10
    }, 'EXCLUDE_PRIOR_YEAR']));
    assert.deepEqual(result, {
      transactionId: 'TX1', transactionStatus: 'CANCELED', rowNumber: 10,
      clearDestinationRow: true, retainTransactionLog: true
    });
  });

  test('5.12 case 9: stale fiscal year notifies but does not stop processing', () => {
    const result = gas.call('evaluatePriorYearVector', [[priorTx('TX1', '2024-08-15')], {
      customerId: 'CFIX_I24', customerCategory: 'INDIVIDUAL', fiscalYear: 2024
    }, [], new Date('2026-01-20T00:00:00+09:00')]);
    assert.equal(result.issues.length, 0);
    assert.equal(result.staleFiscalYearNotification, true);
    assert.equal(result.stopProcessing, false);
  });

  // ---- 5.12：前年判定の基準は対象年度であって暦年ではない ----
  //
  // 「前年」の基準を対象年度とする判断は文書所有者のものである。同じ取引が
  // 対象年度によって前年扱いになったりならなかったりし、**処理日をいつに
  // しても結果は変わらない**ことがその内容である。
  test('5.12: the prior-year judgement follows the fiscal year, not the calendar year', () => {
    // 判定関数が処理日を引数に取らないこと自体が、暦年非依存の担保である。
    assert.equal(gas.evaluate('checkPriorYearUsage.length'), 3,
      'checkPriorYearUsage must not accept a processing date at all');

    const judge = (customer, processingDate) => plain(gas.call('evaluatePriorYearVector',
      [[priorTx('TX1', '2025-12-28')], customer, [], new Date(processingDate)]));
    const fy2026 = {customerId: 'CFIX_I26', customerCategory: 'INDIVIDUAL', fiscalYear: 2026};
    const fy2025 = {customerId: 'CFIX_I25', customerCategory: 'INDIVIDUAL', fiscalYear: 2025};

    // 対象年度が違えば、同じ取引の扱いが変わる。これが判定の実質である。
    assert.equal(judge(fy2026, '2026-01-20T00:00:00+09:00').issues.length, 1,
      '2025-12-28 is prior-year usage for a 2026 fiscal year');
    assert.equal(judge(fy2025, '2026-01-20T00:00:00+09:00').issues.length, 0,
      'the same transaction is current-year usage for a 2025 fiscal year');

    // 処理日を暦年をまたいで動かしても、判定は動かない。
    for (const customer of [fy2026, fy2025]) {
      assert.deepEqual(
        judge(customer, '2026-01-20T00:00:00+09:00').issues,
        judge(customer, '2025-12-15T00:00:00+09:00').issues);
    }
  });

  // ---- 対象年度が古いままの通知だけは処理日に依存する ----
  test('5.12: a stale fiscal year is notified based on the processing date', () => {
    const customer = {customerId: 'CFIX_OLD', customerCategory: 'INDIVIDUAL', fiscalYear: 2024};
    const judge = (processingDate) => plain(gas.call('evaluatePriorYearVector',
      [[priorTx('TX1', '2025-12-28')], customer, [], new Date(processingDate)]));

    assert.equal(judge('2026-01-20T00:00:00+09:00').staleFiscalYearNotification, true,
      'a 2024 fiscal year is stale when processing in 2026');
    assert.equal(judge('2025-06-01T00:00:00+09:00').staleFiscalYearNotification, false,
      'the same setting is not stale when processing in 2025');
  });

  function review(id, type, status, usageDate) {
    return {
      reviewId: id,
      reviewType: type,
      status,
      suppressionKey: `${type}:TX1`,
      registeredAt: '2026-01-20T00:00:00+09:00',
      detail: usageDate ? {usageDate, fiscalYear: 2026} : {}
    };
  }

  function rejudgeState(sourceType, plannedDate, priorReview) {
    const reviews = [review('SRC', sourceType, 'OPEN')];
    if (priorReview) reviews.push(priorReview);
    return {
      customer: {customerId: 'CFIX_I26', customerCategory: 'INDIVIDUAL', fiscalYear: 2026},
      transaction: {
        transactionId: 'TX1',
        plannedDate,
        transactionStatus: 'REVIEW_REQUIRED',
        partnerResolutionStatus: 'RESOLVED_WITH_PARTNER'
      },
      sourceReviewId: 'SRC',
      reviews
    };
  }

  const rejudgementVectors = [
    ['R1', rejudgeState('DATE', '', null), '2025-12-28', 'REGISTER', 'REVIEW_REQUIRED', '2025-12-28'],
    ['R2', rejudgeState('DATE', '', null), '2026-01-05', 'KEEP', 'COMMITTED', null],
    ['R3', rejudgeState('AMOUNT', '2026-01-05', null), '2025-12-20', 'REGISTER', 'REVIEW_REQUIRED', '2025-12-20'],
    ['R4', rejudgeState('AMOUNT', '2025-12-28', review('PY', 'PRIOR_YEAR', 'OPEN', '2025-12-28')), '2026-01-05', 'EXCLUDE', 'COMMITTED', '2026-01-05'],
    ['R5', rejudgeState('AMOUNT', '2025-12-28', review('PY', 'PRIOR_YEAR', 'OPEN', '2025-12-28')), '2024-08-15', 'UPDATE', 'REVIEW_REQUIRED', '2024-08-15']
  ];

  for (const [id, state, correctedDate, branch, transactionStatus, usageDate] of rejudgementVectors) {
    test(`5.15 ${id}: FIX_DATE_AMOUNT prior-year rejudgement`, () => {
      const result = plain(gas.call('rejudgePriorYearUsage', [state, correctedDate]));
      assert.equal(result.branch, branch);
      assert.equal(result.transaction.transactionStatus, transactionStatus);
      assert.equal(result.transaction.plannedDate, correctedDate);
      const prior = result.reviews.find((item) => item.reviewType === 'PRIOR_YEAR');
      if (branch === 'KEEP') {
        assert.equal(prior, undefined);
      } else {
        assert.equal(prior.detail.usageDate, usageDate);
      }
      if (branch === 'EXCLUDE') {
        assert.equal(prior.status, 'EXCLUDED');
        assert.equal(prior.excludeReason, 'PRIOR_YEAR_GROUNDS_LOST');
        assert.deepEqual(result.audit.before, {'Z.usageDate': '2025-12-28'});
        assert.deepEqual(result.audit.after, {'Z.usageDate': '2026-01-05'});
      }
    });
  }

  test('5.15 branch coverage includes register, exclude, update, and keep', () => {
    const branches = rejudgementVectors.map(([, state, correctedDate]) => gas.call('rejudgePriorYearUsage', [state, correctedDate]).branch);
    assert.deepEqual([...new Set(branches)].sort(), ['EXCLUDE', 'KEEP', 'REGISTER', 'UPDATE']);
  });

  test('5.12 invalid individual fiscal year is rejected before judgement', () => {
    assert.throws(
      () => gas.call('checkPriorYearUsage', [[priorTx('TX1', '2025-12-28')], {
        customerId: 'BAD', customerCategory: 'INDIVIDUAL', fiscalYear: null
      }, []]),
      (error) => error && error.code === 'CUSTOMER_MASTER_INVALID'
    );
  });

  test('5.15 invalid fiscal year aborts rejudgement without mutating input', () => {
    const state = rejudgeState('DATE', '', null);
    state.customer.fiscalYear = null;
    const before = JSON.stringify(state);
    assert.throws(
      () => gas.call('rejudgePriorYearUsage', [state, '2025-12-28']),
      (error) => error && error.code === 'CUSTOMER_MASTER_INVALID'
    );
    assert.equal(JSON.stringify(state), before);
  });

  function foreign(rowValues, columns, gridWidth = 10) {
    return plain(gas.call('extractForeignCurrency', [rowValues, {
      foreignCurrencyColumn: columns.currency || null,
      foreignAmountColumn: columns.amount || null,
      exchangeRateColumn: columns.rate || null
    }, gridWidth]));
  }

  const foreignVectors = [
    [1, {}, {}, {currencyCode: null, localAmount: null, exchangeRate: null, diagnostics: []}],
    [2, {H: 'USD'}, {currency: 'H'}, {currencyCode: 'USD', localAmount: null, exchangeRate: null, diagnostics: []}],
    [3, {H: 'USD', I: '35.00', J: '143.28'}, {currency: 'H', amount: 'I', rate: 'J'}, {currencyCode: 'USD', localAmount: 35, exchangeRate: 143.28, diagnostics: []}],
    [4, {H: '', I: '', J: ''}, {currency: 'H', amount: 'I', rate: 'J'}, {currencyCode: null, localAmount: null, exchangeRate: null, diagnostics: []}],
    [5, {H: 'USD', I: '35.00', J: ''}, {currency: 'H', amount: 'I', rate: 'J'}, {currencyCode: 'USD', localAmount: 35, exchangeRate: null, diagnostics: []}],
    [6, {}, {currency: 'H'}, {currencyCode: null, localAmount: null, exchangeRate: null, diagnostics: [{code: 'FOREIGN_CURRENCY_COLUMN_OUT_OF_GRID', column: 'H', retryable: false}]}],
    [7, {I: '35.00 USD'}, {amount: 'I'}, {currencyCode: null, localAmount: null, exchangeRate: null, diagnostics: []}],
    [8, {K: 'STORE USD 35.00'}, {}, {currencyCode: null, localAmount: null, exchangeRate: null, diagnostics: []}]
  ];

  for (const [number, values, columns, expected] of foreignVectors) {
    test(`5.13 case ${number}: optional foreign-currency extraction`, () => {
      const width = number === 6 ? 7 : 10;
      assert.deepEqual(foreign(values, columns, width), expected);
    });
  }
};

'use strict';

/**
 * フェーズ4：有効化ゲート（4.12.2〜4.12.5）。
 *
 * 設計レビューが検出した欠陥を固定する。
 *   CR-4  登録を中断すると形式を持たないサンプルが残り、以後すべての形式追加がブロックされる
 *   CR-6  判定衝突の解決手段が存在しない
 *   A-3   ロールバックに往復検証を課すと復元が構造的に不能になる
 *   A-6   改訂版が旧サンプルを判定できなくなっても、どの検査にも掛からない
 *   A-13  分割実行の中間結果が永続化されず、サンプルが増えると誰も有効化できなくなる
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: []});
    gas.stubs.setActiveSpreadsheet('master');
    gas.evaluate("SETTINGS.MAX_SAMPLES_PER_REGRESSION_RUN=10;");
  }

  // 1件のサンプル。期待値は台帳へ保存済みの値を表す。
  // 抽出結果は `extract` が返す。両者が一致すれば合格。
  const EXPECTED = {
    transactionCount: 2, totalAmount: 3000,
    excludedRows: [{rowNumber: 5, reason: '__EMPTY__'}], excludedCount: 1,
    billingMonthStatus: 'RESOLVED', billingYearMonth: '2026-01',
    yearSummary: {yearlessRows: 2, billingMonthStatus: 'RESOLVED'},
    rows: [
      {sourceRow: 2, merchant: '店舗A', amountBillingJpy: 1000, purpose: '仕入れ',
       occurrenceIndex: 0, derivedDate: '2026-01-05'},
      {sourceRow: 3, merchant: '店舗B', amountBillingJpy: 2000, purpose: '消耗品',
       occurrenceIndex: 0, derivedDate: '2026-01-06'}
    ]
  };

  /** 期待値どおりに抽出できた場合の結果。 */
  function faithfulExtraction() {
    return {
      transactions: EXPECTED.rows.map((row) => ({
        sourceRow: row.sourceRow, merchant: row.merchant,
        amountBillingJpy: row.amountBillingJpy, purpose: row.purpose,
        occurrenceIndex: row.occurrenceIndex, date: row.derivedDate
      })),
      excludedRows: [{rowNumber: 5, reason: '__EMPTY__'}],
      reconciliation: {ok: true, kind: 'NOT_APPLICABLE'},
      billingMonth: {status: 'RESOLVED', yearMonth: '2026-01'},
      truncation: {ok: true},
      yearSummary: {yearlessRows: 2, billingMonthStatus: 'RESOLVED'}
    };
  }

  const okSample = (id, formatId) => ({
    sampleId: id, formatId: formatId || 'dcard',
    storedBinaryHash: 'a'.repeat(64), currentBinaryHash: 'a'.repeat(64),
    storedDataHash: 'b'.repeat(64), currentDataHash: 'b'.repeat(64),
    detection: {matched: true}, definitionValidity: {valid: true},
    expected: EXPECTED
  });

  /** 抽出が期待値どおりに動く既定の注入。`mutate` で1点だけ壊せる。 */
  function extractor(mutate) {
    return (definition, sample) => {
      const result = faithfulExtraction();
      return mutate ? (mutate(result, sample) || result) : result;
    };
  }

  const regression = (overrides) => Object.assign(
    {runId: 'RUN_1', extract: extractor()}, overrides);

  // ================= コーパス回帰 =================

  test('4.12.3: samples whose extraction reproduces the stored expectations pass', () => {
    setup();
    const result = plain(gas.call('runCorpusRegression', [regression({
      samples: [okSample('S1'), okSample('S2'), okSample('S3')]
    })]));
    assert.equal(result.result, 'PASS');
    assert.equal(result.checkedSampleIds.length, 3);
    assert.equal(result.interrupted, false);
  });

  // ---- 合格条件を1点ずつ壊す。恒真なら、これらは全部緑のままになる ----
  const breakages = [
    ['C3  件数がずれる', 3, (r) => { r.transactions.pop(); }],
    ['C4  合計がずれる', 4, (r) => { r.transactions[0].amountBillingJpy = 1500; }],
    ['C5  除外根拠が変わる', 5, (r) => { r.excludedRows[0].reason = '__ROW_RANGE__'; }],
    ['C6  照合式が不成立', 6, (r) => { r.reconciliation = {ok: false}; }],
    ['C7  請求年月が衝突', 7, (r) => { r.billingMonth = {status: 'CONFLICT'}; }],
    ['C8  読取が打ち切られた', 8, (r) => { r.truncation = {ok: false}; }],
    ['C9  店名が入れ替わる', 9, (r) => { r.transactions[0].merchant = '別の店'; }],
    ['C10 年補完集計がずれる', 10, (r) => { r.yearSummary.yearlessRows = 0; }],
    ['C11 導出日が1年ずれる', 11, (r) => { r.transactions[0].date = '2025-01-05'; }]
  ];

  breakages.forEach(([label, condition, mutate]) => {
    test(`4.12.3 ${label} -> ROUNDTRIP_C${condition}`, () => {
      setup();
      const result = plain(gas.call('runCorpusRegression', [regression({
        samples: [okSample('S1')], extract: extractor(mutate)
      })]));
      assert.equal(result.result, 'FAIL', `${label} must fail the gate`);
      assert.ok(result.failures.some((f) => f.reason === `ROUNDTRIP_C${condition}`),
        `expected ROUNDTRIP_C${condition}, got ${result.failures.map((f) => f.reason)}`);
      assert.equal(result.failures[0].sampleId, 'S1');
    });
  });

  // ---- B-M16：請求年月を持たない形式は ABSENT_BY_ANSWER へ読み替える ----
  //
  // `extractBillingYearMonth`は RESOLVED / NOT_FOUND / CONFLICT の3値しか
  // 返さない。読み替えが無いと、`billingMonthAbsent`が真の形式は期待値
  // `ABSENT_BY_ANSWER`と実測`NOT_FOUND`が**永久に一致せず**、往復検証が
  // 必ず不合格になる ── 請求年月の表記がない明細を出すカード会社は実在し、
  // その形式は登録手順を最後まで通れない。
  test('B-M16: a format declared to have no billing month passes with NOT_FOUND', () => {
    setup();
    const expected = Object.assign({}, EXPECTED, {
      billingMonthStatus: 'ABSENT_BY_ANSWER', billingYearMonth: null,
      yearSummary: {yearlessRows: 2, billingMonthStatus: 'ABSENT_BY_ANSWER'}
    });
    const sample = Object.assign({}, okSample('S1'), {expected});
    const result = plain(gas.call('runCorpusRegression', [regression({
      samples: [sample],
      extract: extractor((r) => {
        r.billingMonth = {status: 'NOT_FOUND', yearMonth: null};
        r.yearSummary = {yearlessRows: 2, billingMonthStatus: 'NOT_FOUND'};
      }),
      format: {billingMonthAbsent: true, hasBillingSources: false}
    })]));
    assert.equal(result.result, 'PASS',
      JSON.stringify(result.failures));
  });

  test('B-M16: the same NOT_FOUND without the declaration is still a failure', () => {
    setup();
    const result = plain(gas.call('runCorpusRegression', [regression({
      samples: [okSample('S1')],
      extract: extractor((r) => { r.billingMonth = {status: 'NOT_FOUND', yearMonth: null}; }),
      format: {billingMonthAbsent: false, hasBillingSources: true}
    })]));
    assert.equal(result.result, 'FAIL',
      'without the operator declaration, NOT_FOUND is a real mismatch');
  });

  // ---- C5 は件数「も」照合する（除外行数の 2.1.19 N列） ----
  test('C5: a wrong excluded-row count fails even when the row pairs match', () => {
    setup();
    const expected = Object.assign({}, EXPECTED, {excludedCount: 2});
    const result = plain(gas.call('runCorpusRegression', [regression({
      samples: [Object.assign({}, okSample('S1'), {expected})]
    })]));
    assert.equal(result.result, 'FAIL');
    assert.ok(result.failures.some((f) => f.reason === 'ROUNDTRIP_C5' &&
      f.item === 'excludedCount'));
  });

  // ---- C9 は導出のハッシュキー（G列）も保存値と照合する ----
  test('C9: a drifted dateHashKey fails even when the display values match', () => {
    setup();
    const expected = Object.assign({}, EXPECTED);
    expected.rows = EXPECTED.rows.map((row, i) =>
      Object.assign({}, row, {dateHashKey: row.derivedDate}));
    const result = plain(gas.call('runCorpusRegression', [regression({
      samples: [Object.assign({}, okSample('S1'), {expected})],
      extract: extractor((r) => {
        r.transactions.forEach((tx) => { tx.dateHashKey = tx.date; });
        r.transactions[0].dateHashKey = '2025-01-05';   // 表示値は同じままキーだけ壊れた
      })
    })]));
    assert.equal(result.result, 'FAIL',
      'the hash key feeds the identity hash - drift here means silent duplicate bookings');
    assert.ok(result.failures.some((f) => f.item === 'dateHashKey'));
  });

  // ---- C8 の材料が無ければ「評価なしで合格」にしない ----
  test('C8: an extraction that never ran the truncation check is a failure', () => {
    setup();
    const result = plain(gas.call('runCorpusRegression', [regression({
      samples: [okSample('S1')],
      extract: extractor((r) => { delete r.truncation; })
    })]));
    assert.equal(result.result, 'FAIL',
      'skipping the check silently is how a truncated read reaches the ledger');
    assert.ok(result.failures.some((f) => f.reason === 'ROUNDTRIP_C8'));
  });

  // ---- C11 が A-5 の是正である。処理日に依存しないので保存値と比べられる ----
  test('A-5: a broken year-inference rule is caught by the stored derived date', () => {
    setup();
    // 年補完の規則を壊し、全行が1年ずれた状況。件数も合計も一致したまま。
    const result = plain(gas.call('runCorpusRegression', [regression({
      samples: [okSample('S1')],
      extract: extractor((r) => {
        r.transactions.forEach((tx) => { tx.date = tx.date.replace('2026', '2025'); });
      })
    })]));
    assert.equal(result.result, 'FAIL',
      'counts and totals still match - only the stored derived date can catch this');
    assert.equal(result.failures.length, 2, 'both rows must be reported');
    assert.equal(result.failures[0].reason, 'ROUNDTRIP_C11');
    assert.equal(result.failures[0].expected, '2026-01-05');
    assert.equal(result.failures[0].actual, '2025-01-05');
  });

  // ---- 2件の取り違えが相殺しても、行ごとの照合が捕まえる ----
  test('4.12.3: two swapped rows are caught even though count and total match', () => {
    setup();
    const result = plain(gas.call('runCorpusRegression', [regression({
      samples: [okSample('S1')],
      extract: extractor((r) => {
        const a = r.transactions[0].merchant;
        r.transactions[0].merchant = r.transactions[1].merchant;
        r.transactions[1].merchant = a;
      })
    })]));
    assert.equal(result.result, 'FAIL',
      'a compensating swap passes count and total checks - row-level comparison is required');
  });

  test('4.12.3: a missing sample file is a failure, not a skipped sample', () => {
    setup();
    const missing = okSample('S2');
    missing.fileMissing = true;
    const result = plain(gas.call('runCorpusRegression', [regression({
      samples: [okSample('S1'), missing]
    })]));
    assert.equal(result.result, 'FAIL');
    assert.equal(result.failures[0].reason, 'SAMPLE_FILE_MISSING');
  });

  test('4.12.3: tampered expected values are detected (A-20)', () => {
    setup();
    const tampered = okSample('S1');
    tampered.currentDataHash = 'c'.repeat(64);
    const result = plain(gas.call('runCorpusRegression', [regression({samples: [tampered]})]));
    assert.equal(result.failures[0].reason, 'SAMPLE_EXPECTED_TAMPERED');
  });

  // ---- 抽出手段がなければ「照合なしで合格」にしない ----
  test('4.12.3: without an extract function the gate refuses to run, never passes', () => {
    setup();
    assert.throws(() => gas.call('runCorpusRegression',
      [{runId: 'RUN_1', samples: [okSample('S1')]}]),
      (error) => error && /extract function/.test(String(error.message)));
  });

  // ---- A-13：分割実行。部分結果をPASSにしない ----
  test('A-13/INV-35: an interrupted run is NOT_RUN, never PASS, and records its progress', () => {
    setup();
    const samples = ['S1', 'S2', 'S3', 'S4', 'S5'].map((id) => okSample(id));
    const first = plain(gas.call('runCorpusRegression', [{
      runId: 'RUN_1', extract: extractor(), samples, maxPerRun: 2
    }]));

    assert.equal(first.result, 'NOT_RUN',
      'a partial run must never be PASS even when every checked sample passed');
    assert.equal(first.interrupted, true);
    assert.equal(first.checkedSampleIds.length, 2);
    assert.equal(first.progress.runId, 'RUN_1', 'progress must be carried forward');
  });

  test('A-13: a resumed run continues from where it stopped', () => {
    setup();
    const samples = ['S1', 'S2', 'S3', 'S4'].map((id) => okSample(id));
    const first = plain(gas.call('runCorpusRegression', [{
      runId: 'RUN_1', extract: extractor(), samples, maxPerRun: 2
    }]));
    const second = plain(gas.call('runCorpusRegression', [{
      runId: 'RUN_1', extract: extractor(), samples, maxPerRun: 10, progress: first.progress
    }]));

    assert.equal(second.result, 'PASS');
    assert.equal(second.checkedSampleIds.length, 4, 'all four are recorded after resuming');
  });

  test('A-13: if the target set changed, the run restarts instead of resuming', () => {
    setup();
    const first = plain(gas.call('runCorpusRegression', [{
      runId: 'RUN_1', extract: extractor(), samples: ['S1','S2','S3'].map((id) => okSample(id)), maxPerRun: 2
    }]));
    // サンプルが1件増えた状態で再開しようとする
    const second = plain(gas.call('runCorpusRegression', [{
      runId: 'RUN_1', extract: extractor(),
      samples: ['S1', 'S2', 'S3', 'S4'].map((id) => okSample(id)),
      maxPerRun: 10, progress: first.progress
    }]));
    assert.equal(second.checkedSampleIds.length, 4,
      'a changed target set must be re-checked from the beginning');
  });

  // ================= 判定衝突検査 =================

  const def = (formatId, version) => ({formatId, version: version || 1});

  test('4.12.4 check 1: a new definition matching another format\'s sample collides', () => {
    setup();
    const result = plain(gas.call('runDetectionCollisionCheck', [{
      formatId: 'newcard', newDefinition: def('newcard'), newSampleId: 'S_NEW',
      activeDefinitions: [def('dcard')],
      samples: [{sampleId: 'S_D', formatId: 'dcard'}],
      // 新定義がdカードのサンプルにも成立してしまう
      detect: (d, sampleId) => d.formatId === 'newcard'
    }]));
    assert.equal(result.result, 'FAIL');
    assert.ok(result.failures.some((f) => f.reason === 'NEW_DEF_MATCHES_OTHER_SAMPLE'));
  });

  test('4.12.4 check 2: an existing definition matching the new sample collides', () => {
    setup();
    const result = plain(gas.call('runDetectionCollisionCheck', [{
      formatId: 'newcard', newDefinition: def('newcard'), newSampleId: 'S_NEW',
      activeDefinitions: [def('dcard')], samples: [],
      // 既存のdカード定義が新サンプルにも成立してしまう
      detect: (d, sampleId) => sampleId === 'S_NEW'
    }]));
    assert.ok(result.failures.some((f) => f.reason === 'EXISTING_DEF_MATCHES_NEW_SAMPLE'));
    assert.ok(result.failures.some((f) => f.reason === 'NOT_UNIQUE_ON_NEW_SAMPLE'));
  });

  test('4.12.4 check 3: the new sample must be matched by exactly one definition', () => {
    setup();
    const result = plain(gas.call('runDetectionCollisionCheck', [{
      formatId: 'newcard', newDefinition: def('newcard'), newSampleId: 'S_NEW',
      activeDefinitions: [], samples: [],
      detect: () => false          // 新定義が自分のサンプルすら判定できない
    }]));
    const notUnique = result.failures.filter((f) => f.reason === 'NOT_UNIQUE_ON_NEW_SAMPLE')[0];
    assert.ok(notUnique);
    assert.equal(notUnique.newDefinitionMatches, false);
  });

  // ---- A-6：改訂版が旧サンプルを判定できなくなったら落とす ----
  test('A-6 check 2\': a revision that can no longer detect its own prior sample fails', () => {
    setup();
    const result = plain(gas.call('runDetectionCollisionCheck', [{
      formatId: 'saison', isRevision: true,
      newDefinition: def('saison', 2), newSampleId: 'S_NEW',
      activeDefinitions: [], samples: [
        {sampleId: 'S_OLD', formatId: 'saison'},
        {sampleId: 'S_NEW', formatId: 'saison'}
      ],
      // 改訂版は新サンプルしか判定できない
      detect: (d, sampleId) => sampleId === 'S_NEW'
    }]));
    assert.equal(result.result, 'FAIL');
    const miss = result.failures.filter((f) => f.reason === 'REVISED_DEF_MISSES_PRIOR_SAMPLE')[0];
    assert.ok(miss, 'the old sample must be reported');
    assert.equal(miss.sampleId, 'S_OLD');
  });

  test('A-6: a revision detecting both old and new samples passes', () => {
    setup();
    const result = plain(gas.call('runDetectionCollisionCheck', [{
      formatId: 'saison', isRevision: true,
      newDefinition: def('saison', 2), newSampleId: 'S_NEW',
      activeDefinitions: [def('dcard')],
      samples: [
        {sampleId: 'S_OLD', formatId: 'saison'},
        {sampleId: 'S_NEW', formatId: 'saison'},
        {sampleId: 'S_D', formatId: 'dcard'}
      ],
      detect: (d, sampleId) => d.formatId === 'saison' && sampleId !== 'S_D'
    }]));
    assert.equal(result.result, 'PASS');
  });

  // ================= 有効化の可否 =================

  test('INV-34: activation is refused unless every required gate passed', () => {
    setup();
    const failed = {scope: 'ACTIVATION', overall: 'FAIL', gates: {}};
    assert.equal(plain(gas.call('canActivateFormat', [failed, null])).allowed, false);

    const notRun = {scope: 'ACTIVATION', overall: 'NOT_RUN', gates: {}};
    assert.equal(plain(gas.call('canActivateFormat', [notRun, null])).reason, 'GATES_NOT_RUN');

    const passed = {scope: 'ACTIVATION', overall: 'PASS', gates: {}};
    assert.equal(plain(gas.call('canActivateFormat', [passed, null])).allowed, true);
  });

  // ---- A-3：ロールバックは往復検証を要求しない ----
  test('A-3: rollback requires only two gates, so a prior version stays restorable', () => {
    setup();
    const result = plain(gas.call('runActivationGates', [{
      scope: 'ROLLBACK',
      corpus: {runId: 'RUN_1', extract: extractor(), samples: [okSample('S1')]},
      collision: {
        formatId: 'saison', newDefinition: def('saison', 1), newSampleId: 'S1',
        activeDefinitions: [], samples: [], detect: (d, s) => s === 'S1'
      }
    }]));
    assert.equal(result.overall, 'PASS');
    assert.equal(result.gates.ROUNDTRIP, undefined,
      'rollback must not require the round-trip gate');
  });

  test('A-3: a failing rollback can still proceed on an explicit owner override', () => {
    setup();
    const failed = {scope: 'ROLLBACK', overall: 'FAIL', gates: {}};
    assert.equal(plain(gas.call('canActivateFormat', [failed, null])).allowed, false);

    const overridden = plain(gas.call('canActivateFormat',
      [failed, {ownerApproved: true, reason: '旧様式の顧客ファイルが処理できないため'}]));
    assert.equal(overridden.allowed, true);
    assert.equal(overridden.override, true);
  });

  test('A-3: an activation cannot be overridden the way a rollback can', () => {
    setup();
    const failed = {scope: 'ACTIVATION', overall: 'FAIL', gates: {}};
    const attempt = plain(gas.call('canActivateFormat',
      [failed, {ownerApproved: true, reason: 'どうしても有効化したい'}]));
    assert.equal(attempt.allowed, false,
      'only rollback may be overridden; activation may not');
  });
};

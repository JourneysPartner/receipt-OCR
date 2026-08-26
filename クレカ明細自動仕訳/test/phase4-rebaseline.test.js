'use strict';

/**
 * 4.12.10 期待値の再ベースライン（仕様24.2・CR-7）。
 *
 * この経路が無いと、除外ルールや年補完のバグを**正しく直した瞬間に**
 * 全サンプルが不一致になり、以後いかなる形式も有効化できなくなる。
 *
 * 同時にこれは「現在のコードの出力を正解とする」上書きでもある。差分の
 * 全件提示とオーナー承認なしに実行できてはならない。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '監査ログ', values: [Object.assign(Array(15).fill(''), {0: '監査ID'})]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.stubs.setActiveUser('owner@example.com');
  }

  const expectedValues = (overrides = {}) => Object.assign({
    transactionCount: 2, totalAmount: 3000, excludedCount: 1,
    billingYearMonth: '2026-01',
    yearSummary: {yearlessRows: 2, billingMonthStatus: 'RESOLVED'},
    rows: [
      {sourceRow: 2, merchant: '店舗A', amountBillingJpy: 1000,
       purpose: '仕入れ', occurrenceIndex: 0, derivedDate: '2026-01-05'},
      {sourceRow: 3, merchant: '店舗B', amountBillingJpy: 2000,
       purpose: '消耗品', occurrenceIndex: 0, derivedDate: '2026-01-06'}
    ]
  }, overrides);

  const sample = (id, expected, current, status) => ({
    sampleId: id, status: status || 'ACTIVE',
    expected: expected, current: current || expected,
    expectedDataHash: 'old'.repeat(21) + 'x', expectedCodeVersion: '2.5.0'
  });

  // ================= 差分の算出 =================

  test('4.12.10: a sample whose output is unchanged produces no diff', () => {
    setup();
    const result = plain(gas.call('computeRebaselineDiff',
      [[sample('S1', expectedValues())]]));
    assert.deepEqual(result.diffs, []);
    assert.deepEqual(result.sampleIds, ['S1']);
  });

  // 年補完のバグを直すと、全サンプルの導出日が動く。これが再ベースラインの
  // 典型的な契機である。
  test('4.12.10: a corrected year-inference rule shows up as a per-row diff', () => {
    setup();
    const before = expectedValues();
    const after = expectedValues();
    after.rows[0].derivedDate = '2025-01-05';   // 修正後の正しい値

    const result = plain(gas.call('computeRebaselineDiff', [[sample('S1', before, after)]]));
    assert.equal(result.diffs.length, 1);
    assert.equal(result.diffs[0].item, 'derivedDate');
    assert.equal(result.diffs[0].rowNumber, 2);
    assert.equal(result.diffs[0].oldValue, '2026-01-05');
    assert.equal(result.diffs[0].newValue, '2025-01-05');
  });

  test('4.12.10: file-level changes are reported with no row number', () => {
    setup();
    const after = expectedValues({excludedCount: 2});
    const result = plain(gas.call('computeRebaselineDiff',
      [[sample('S1', expectedValues(), after)]]));
    assert.equal(result.diffs.length, 1);
    assert.equal(result.diffs[0].item, 'excludedCount');
    assert.equal(result.diffs[0].rowNumber, null);
  });

  test('4.12.10: an added or removed row is reported in full', () => {
    setup();
    const after = expectedValues();
    after.rows.push({sourceRow: 4, merchant: '店舗C', amountBillingJpy: 500,
      purpose: '雑費', occurrenceIndex: 0, derivedDate: '2026-01-07'});

    const result = plain(gas.call('computeRebaselineDiff',
      [[sample('S1', expectedValues(), after)]]));
    const added = result.diffs.filter((d) => d.item === 'row')[0];
    assert.ok(added, 'a newly extracted row must be shown, not silently accepted');
    assert.equal(added.oldValue, null);
    assert.equal(added.newValue.sourceRow, 4);
  });

  test('4.12.10: every差分 is listed, not summarised', () => {
    setup();
    const after = expectedValues();
    after.rows[0].derivedDate = '2025-01-05';
    after.rows[0].amountBillingJpy = 1100;
    after.rows[1].purpose = '雑費';
    after.totalAmount = 3100;

    const result = plain(gas.call('computeRebaselineDiff',
      [[sample('S1', expectedValues(), after)]]));
    assert.equal(result.diffs.length, 4,
      'the approver reviews the diff itself - omitting any of it defeats the review');
  });

  // ---- 対象は ACTIVE のみ ----
  test('4.12.10: PENDING, SUPERSEDED and RETIRED samples are not rebaselined', () => {
    setup();
    const changed = expectedValues({totalAmount: 9999});
    const result = plain(gas.call('computeRebaselineDiff', [[
      sample('S1', expectedValues(), changed, 'PENDING'),
      sample('S2', expectedValues(), changed, 'SUPERSEDED'),
      sample('S3', expectedValues(), changed, 'RETIRED'),
      sample('S4', expectedValues(), changed, 'ACTIVE')
    ]]));
    assert.deepEqual(result.sampleIds, ['S4']);
    assert.equal(result.skipped.length, 3);
    assert.ok(result.diffs.every((d) => d.sampleId === 'S4'));
  });

  // ================= diffHash =================

  test('4.12.10: the diff hash covers the whole target set, so one approval suffices', () => {
    setup();
    const changed = expectedValues({totalAmount: 3100});
    const both = plain(gas.call('computeRebaselineDiff', [[
      sample('S1', expectedValues(), changed),
      sample('S2', expectedValues(), changed)
    ]]));
    const onlyOne = plain(gas.call('computeRebaselineDiff', [[
      sample('S1', expectedValues(), changed)
    ]]));
    assert.notEqual(both.diffHash, onlyOne.diffHash,
      'changing the target set by one sample must require a new request');
  });

  test('4.12.10: the same diff yields the same hash', () => {
    setup();
    const changed = expectedValues({totalAmount: 3100});
    assert.equal(
      gas.call('computeRebaselineDiff', [[sample('S1', expectedValues(), changed)]]).diffHash,
      gas.call('computeRebaselineDiff', [[sample('S1', expectedValues(), changed)]]).diffHash);
  });

  // ================= 実行（CR-7の要点） =================

  const approvedRequest = (samples, reason) => {
    const diff = plain(gas.call('computeRebaselineDiff', [samples]));
    return {
      sampleIds: diff.sampleIds, reason: reason || '年補完の規則5bを修正したため',
      diffHash: diff.diffHash, approvedBy: 'owner@example.com', applicant: 'admin@example.com'
    };
  };

  test('4.12.10: an approved rebaseline replaces the expected values', () => {
    setup();
    const after = expectedValues();
    after.rows[0].derivedDate = '2025-01-05';
    const samples = [sample('S1', expectedValues(), after)];

    const written = [];
    const result = plain(gas.call('rebaselineSample', [{
      samples, request: approvedRequest(samples), approver: 'owner@example.com',
      persist: (sampleId, value) => { written.push({sampleId, value}); }
    }]));

    assert.equal(result.updated.length, 1);
    assert.equal(written.length, 1);
    assert.equal(written[0].value.expected.rows[0].derivedDate, '2025-01-05');
    assert.equal(written[0].value.codeVersion, gas.evaluate('VERSIONS.CODE'),
      'without this the "expected values are stale" filter stops working');
    assert.equal(written[0].value.lastVerification, 'NOT_RUN',
      'the previous pass cannot be trusted once the expectations changed');
  });

  // ---- CR-7：承認後に差分が変わったら実行しない ----
  test('CR-7: a diff that changed after approval is refused', () => {
    setup();
    const after = expectedValues();
    after.rows[0].derivedDate = '2025-01-05';
    const samples = [sample('S1', expectedValues(), after)];
    const request = approvedRequest(samples);

    // 申請から承認までの間に、さらにコードがリリースされた状況
    after.rows[1].purpose = '雑費';

    assert.throws(() => gas.call('rebaselineSample',
      [{samples, request, approver: 'owner@example.com'}]),
      (error) => error && error.code === 'SAMPLE_REBASELINE_DIFF_STALE',
      'writing a diff the owner never saw defeats the approval entirely');
  });

  test('CR-7: changing the target set after approval is refused', () => {
    setup();
    const changed = expectedValues({totalAmount: 3100});
    const samples = [sample('S1', expectedValues(), changed)];
    const request = approvedRequest(samples);

    samples.push(sample('S2', expectedValues(), changed));
    assert.throws(() => gas.call('rebaselineSample',
      [{samples, request, approver: 'owner@example.com'}]),
      (error) => error && error.code === 'SAMPLE_REBASELINE_DIFF_STALE');
  });

  test('CR-7: a rebaseline without owner approval is refused', () => {
    setup();
    const changed = expectedValues({totalAmount: 3100});
    const samples = [sample('S1', expectedValues(), changed)];
    const request = approvedRequest(samples);
    delete request.approvedBy;

    assert.throws(() => gas.call('rebaselineSample', [{samples, request}]),
      (error) => error && /owner approval/.test(String(error.message)),
      'a system administrator alone must not be able to declare the current output correct');
  });

  test('CR-7: a rebaseline without a stated reason is refused', () => {
    setup();
    const changed = expectedValues({totalAmount: 3100});
    const samples = [sample('S1', expectedValues(), changed)];
    const request = approvedRequest(samples);
    request.reason = '';

    assert.throws(() => gas.call('rebaselineSample',
      [{samples, request, approver: 'owner@example.com'}]),
      (error) => error && /reason/.test(String(error.message)),
      'the reason is what lets a later reader tell a fix from a regression');
  });

  test('4.12.10: the rebaseline is recorded with its before and after hashes', () => {
    setup();
    const changed = expectedValues({totalAmount: 3100});
    const samples = [sample('S1', expectedValues(), changed)];
    gas.call('rebaselineSample', [{
      samples, request: approvedRequest(samples), approver: 'owner@example.com'
    }]);

    const audit = gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ');
    const rows = audit.getRange(2, 1, audit.getLastRow() - 1, 15).getValues()
      .filter((row) => String(row[2]) === 'SAMPLE_REBASELINE');
    assert.equal(rows.length, 1);
    assert.equal(rows[0][7], 'S1', 'the sample must be identified');
    assert.equal(rows[0][4], 'admin@example.com', 'the applicant must be on record');
    assert.equal(rows[0][5], 'owner@example.com', 'and so must the approver');
    assert.ok(String(rows[0][11]).indexOf('年補完') >= 0,
      'the reason distinguishes a deliberate fix from an accepted regression');
    // 変更前後のハッシュが両方残る
    assert.ok(String(rows[0][9]).indexOf('dataHash') >= 0);
    assert.ok(String(rows[0][10]).indexOf('diffHash') >= 0);
  });

  // ================= 期待値ハッシュ =================

  test('4.12.10: the expected-value hash changes when any expectation changes', () => {
    setup();
    const base = gas.call('computeSampleDataHash', [expectedValues()]);
    assert.equal(gas.call('computeSampleDataHash', [expectedValues()]), base);

    const changed = expectedValues();
    changed.rows[0].derivedDate = '2025-01-05';
    assert.notEqual(gas.call('computeSampleDataHash', [changed]), base,
      'this hash is what detects tampering with the stored expectations');
  });
};

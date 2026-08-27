'use strict';

/**
 * 4.39 固定値テストベクトル（10.3 リリース手順の必須ゲート）。
 *
 * これらは実 GAS 上で走らせるためのものである。ここで確かめるのは
 * **ベクトル実行そのものが機能すること** ── 空の集合を回して「合格」に
 * ならないこと、壊れた実装を実際に落とすこと。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: []});
    gas.stubs.setActiveSpreadsheet('master');
  }

  // ================= 直列化ベクトル =================

  test('4.39: the serialization vectors pass against the current implementation', () => {
    setup();
    const result = plain(gas.call('runSerializationVectors', []));
    assert.equal(result.ok, true,
      result.results.filter((r) => !r.ok).map((r) => r.id).join(', '));
  });

  test('4.39: the serialization run actually checks all seven vectors plus X', () => {
    setup();
    const result = plain(gas.call('runSerializationVectors', []));
    // 設計5.6.5のA〜G 7件 + 非回帰X = 8件のハッシュ照合、加えてF!=Xの非衝突検査。
    // 以前この数を8で固定しており、**Gの欠落を正解として保護していた**。
    // Gは`Utilities.formatDate`によるDate正準化を実機で検証する唯一のケース。
    assert.equal(result.results.length, 9,
      'the design mandates seven vectors - a shorter set passes vacuously');
    assert.ok(result.results.some((r) => r.id === 'G.hash'),
    'vector G exercises the Date canonicalisation path');
    assert.ok(result.results.some((r) => r.id === 'F!=X'));
  });

  // ================= 取引先照合ベクトル =================

  test('5.14: the partner-matching vectors run all fourteen cases and pass', () => {
    setup();
    const result = plain(gas.call('runPartnerMatchingVectors', []));
    assert.equal(result.ok, true,
      result.results.filter((r) => !r.ok).map((r) => `${r.id}:${JSON.stringify(r.actual)}`).join('; '));
    assert.equal(result.results.length, 14,
      'the design mandates fourteen vectors (V1-V14)');
  });

  test('5.14: an empty vector set is refused, never passed', () => {
    setup();
    // 以前この関数はベクトル0件で常に合格しており、第1回レビューが指摘した
    // 「何も照合しないゲート」を別の場所で再現していた。
    assert.throws(() => gas.call('runPartnerMatchingVectors', [null, []]),
      (error) => error && /non-empty vector set/.test(String(error.message)));
  });

  test('5.14: a broken matching rule fails the vectors', () => {
    setup();
    // 有効期間の除外規則を壊す：期限切れの行も候補に含める
    const result = plain(gas.evaluate(`
      (function() {
        var original = matchPartner;
        matchPartner = function(tx, customerId, dictIndex) {
          var patched = {
            customer: dictIndex.customer.map(function(r) {
              return Object.assign({}, r, {validTo: null});
            }),
            common: dictIndex.common, commonPartners: dictIndex.commonPartners
          };
          return original(tx, customerId, patched);
        };
        try { return runPartnerMatchingVectors(); }
        finally { matchPartner = original; }
      })()
    `));
    assert.equal(result.ok, false,
      'V5 exists precisely to catch an expiry rule that stopped working');
    assert.ok(result.results.some((r) => r.id === 'V5' && !r.ok));
  });

  // 期待値は設計書の表から取った外部の値である。実装が変われば落ちる。
  test('CR-M: a change to the serialization is caught by the fixed vectors', () => {
    setup();
    const result = plain(gas.evaluate(`
      (function() {
        var original = serializeDeterministic;
        serializeDeterministic = function(elements) {
          // 長さ接頭辞を落とす（区切り文字を含む要素が別の列と衝突する）
          return elements.map(function(e) {
            return e === null || e === undefined ? '-1:' : String(e);
          }).join('');
        };
        try { return runSerializationVectors(); }
        finally { serializeDeterministic = original; }
      })()
    `));
    assert.equal(result.ok, false,
      'the transaction id and every hash rest on this - it must not drift unnoticed');
  });

  // ================= 年補完ベクトル =================

  test('4.39: the date-inference vectors pass and are not empty', () => {
    setup();
    const result = plain(gas.call('runDateInferenceVectors', []));
    assert.equal(result.ok, true,
      result.results.filter((r) => !r.ok).map((r) => r.id).join(', '));
    assert.ok(result.results.length >= 3);
  });

  test('4.39: a broken year-inference rule fails the vectors', () => {
    setup();
    // 締め年月を無視して常に処理日の年を使う実装に差し替える
    const result = plain(gas.call('runDateInferenceVectors', [[{
      id: 'broken', base: {status: 'RESOLVED', year: 2026, month: 1, sources: ['HEADER']},
      processingDate: '2026-01-20',
      txs: [{transactionId: 'tx1', sourceRow: 2, dateYearMissing: true,
             dateMonthDay: {month: 12, day: 28}}],
      expectedDerived: ['2026-12-28'],       // 誤った期待値
      expectedPlanned: ['2026-12-28']
    }]]));
    assert.equal(result.ok, false,
      'the vectors must be able to disagree with the implementation');
    assert.equal(result.results[0].actual.derived[0], '2025-12-28');
  });

  test('4.39: a vector that throws is reported as a failure, not skipped', () => {
    setup();
    const result = plain(gas.call('runDateInferenceVectors', [[{
      id: 'malformed', base: null, processingDate: '2026-01-20', txs: []
    }]]));
    assert.equal(result.ok, false);
    assert.ok(result.results[0].detail, 'the error must be reported, not swallowed');
  });

  // ================= 前年判定ベクトル =================

  test('4.39: the prior-year vectors run all twelve cases (fourteen comparisons)', () => {
    setup();
    const result = plain(gas.call('runPriorYearVectors', []));
    assert.equal(result.ok, true,
      result.results.filter((r) => !r.ok).map((r) => r.id).join(', '));
    // 12ケース + ケース1・6の暦年またぎ再実行2件 = 14照合（5.15）。
    // 以前は5件で、件数を「5以上」と主張して不足を保護していた。
    assert.equal(result.results.length, 14,
      'the design mandates twelve cases with fourteen comparisons');
  });

  // ================= 再判定ベクトル R1〜R5 =================

  test('5.15: the rejudgement vectors pass and cover all four branches', () => {
    setup();
    const result = plain(gas.call('runPriorYearRejudgementVectors', []));
    assert.equal(result.ok, true,
      result.results.filter((r) => !r.ok)
        .map((r) => `${r.id}:${r.problems.join(',')}`).join('; '));
    assert.equal(result.results.length, 5);
    assert.deepEqual(result.coveredBranches.slice().sort(),
      ['EXCLUDE', 'KEEP', 'REGISTER', 'UPDATE'],
      'the four 4.26.3 branches must each run at least once');
  });

  test('5.15: an implementation that always registers fails the branch coverage', () => {
    setup();
    // 再判定契機の割当てが壊れて常に「登録」になった実装を模す
    const result = plain(gas.evaluate(`
      (function() {
        var original = rejudgePriorYearUsage;
        rejudgePriorYearUsage = function(state, correctedDate) {
          var out = original(state, correctedDate);
          out.branch = 'REGISTER';
          return out;
        };
        try { return runPriorYearRejudgementVectors(); }
        finally { rejudgePriorYearUsage = original; }
      })()
    `));
    assert.equal(result.ok, false,
      'branch coverage is the production gate, not a test-side tally');
    assert.ok(result.missingBranches.length > 0);
  });

  // R3 が Ver.2.5 指摘1 の Critical を直接検出する：
  // 再判定契機を「空欄→非空」に限る実装では、S列が非空から別の非空へ
  // 変わるケースで登録が起きない。
  test('5.15 R3: a rejudgement trigger limited to blank-to-filled fails', () => {
    setup();
    const result = plain(gas.evaluate(`
      (function() {
        var original = rejudgePriorYearUsage;
        rejudgePriorYearUsage = function(state, correctedDate) {
          if (state.transaction.plannedDate !== '') {
            // 「空欄からの変化」でなければ再判定しない誤実装
            var untouched = cloneReviewState_(state);
            untouched.transaction.plannedDate = correctedDate;
            var source = untouched.reviews.filter(function(r) {
              return r.reviewId === untouched.sourceReviewId;
            })[0];
            source.status = 'RESOLVED';
            untouched.branch = 'KEEP';
            untouched.audit = null;
            if (canCommitReviewedTransaction_(untouched.transaction, untouched.reviews)) {
              untouched.transaction.transactionStatus = TX_STATUS.COMMITTED;
            }
            return untouched;
          }
          return original(state, correctedDate);
        };
        try { return runPriorYearRejudgementVectors(); }
        finally { rejudgePriorYearUsage = original; }
      })()
    `));
    assert.equal(result.ok, false);
    assert.ok(result.results.some((r) => r.id === 'R3' && !r.ok),
      'R3 exists precisely to catch this: the transaction would commit without its review');
  });

  // 「前年」の基準が対象年度であって暦年でないことが、ここに表れる。
  test('4.39: the prior-year vectors re-check across a calendar year boundary', () => {
    setup();
    const result = plain(gas.call('runPriorYearVectors', []));
    const rechecks = result.results.filter((r) => /processingDateIndependent/.test(r.id));
    assert.ok(rechecks.length >= 2,
      'the fiscal-year basis is only demonstrated by varying the processing date');
    assert.ok(rechecks.every((r) => r.ok));
  });

  test('4.39: the prior-year vectors touch no customer master', () => {
    setup();
    const before = gas.stubs.getSpreadsheet('master').getSheets().length;
    gas.call('runPriorYearVectors', []);
    assert.equal(gas.stubs.getSpreadsheet('master').getSheets().length, before,
      'running the release gate must not alter production data');
  });

  test('4.39: a wrong prior-year expectation fails', () => {
    setup();
    const result = plain(gas.call('runPriorYearVectors', [[{
      id: 'wrong', customerCategory: 'INDIVIDUAL', fiscalYear: 2026,
      txs: [{transactionId: 'TX1', date: '2025-12-28'}],
      expectedIssueCount: 0        // 誤り：2026年度から見て2025年は前年
    }]]));
    assert.equal(result.ok, false);
  });

  // ================= まとめ実行 =================

  test('10.3: all four vector groups run together and report which failed', () => {
    setup();
    const result = plain(gas.call('runAllVectors', []));
    assert.equal(result.ok, true, result.failedGroups.join(', '));
    assert.deepEqual(Object.keys(result.groups).sort(),
      ['dateInference', 'partnerMatching', 'priorYear', 'serialization']);
    assert.equal(result.codeVersion, gas.evaluate('VERSIONS.CODE'));
  });

  // ================= 障害注入のシーム =================

  test('4.39: fault injection is inert when unconfigured', () => {
    setup();
    gas.evaluate('SETTINGS.FAULT_INJECTION = null; resetFaultInjectionCache_();');
    assert.doesNotThrow(() => gas.call('faultInjectionPoint', ['WRITE_HALF', {}]));
  });

  test('4.39: a configured fault point throws where it is placed', () => {
    setup();
    // 設定は実行開始時のキャッシュを参照する。変更後はリセットが要る ──
    // それ自体が「途中で読み直さない」仕様の現れである。
    gas.evaluate("SETTINGS.FAULT_INJECTION = {WRITE_HALF: true}; resetFaultInjectionCache_();");
    assert.throws(() => gas.call('faultInjectionPoint', ['WRITE_HALF', {fileId: 'file1'}]),
      (error) => error && error.code === 'FAULT_INJECTED');
    assert.doesNotThrow(() => gas.call('faultInjectionPoint', ['OTHER_POINT', {}]),
      'only the configured point fires');
    gas.evaluate('SETTINGS.FAULT_INJECTION = null; resetFaultInjectionCache_();');
  });

  // ---- 本番では設定が何であっても素通りする ----
  test('4.39: fault injection never fires against the production master', () => {
    setup();
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.evaluate(`
      PropertiesService.getScriptProperties()
        .setProperty('PRODUCTION_MASTER_SPREADSHEET_ID', 'master');
      SETTINGS.FAULT_INJECTION = {WRITE_HALF: true};
      resetFaultInjectionCache_();
    `);
    assert.doesNotThrow(() => gas.call('faultInjectionPoint', ['WRITE_HALF', {}]),
      'a misconfigured setting must not be able to halt production data processing');
    gas.evaluate('SETTINGS.FAULT_INJECTION = null; resetFaultInjectionCache_();');
  });

  // ================= 期待値の読取経路 =================

  test('A-29: expected values are read through one function, in row order', () => {
    gas.stubs.reset();
    const blank = (n) => Array(n).fill('');
    const row = (sampleId, sourceRow, merchant) => {
      const r = blank(12);
      r[0] = sampleId; r[1] = sourceRow; r[2] = merchant;
      return r;
    };
    gas.stubs.createSpreadsheet('master', {sheets: [{
      name: '形式サンプル期待値',
      values: [blank(12).map((_, i) => i === 0 ? 'サンプルID' : ''),
        row('S1', 7, 'C'), row('S2', 2, 'X'), row('S1', 3, 'A'), row('S1', 5, 'B')]
    }]});
    gas.stubs.setActiveSpreadsheet('master');

    const rows = plain(gas.call('loadExpectedValues', ['S1']));
    assert.deepEqual(rows.map((r) => r[1]), [3, 5, 7],
      'row order matters - the comparison is positional');
    assert.equal(rows.length, 3, 'another sample must not leak in');
  });
};

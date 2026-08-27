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
    // 6件 + 非回帰X = 7件のハッシュ照合、加えて F!=X の非衝突検査
    assert.equal(result.results.length, 8,
      'an empty or truncated vector set would pass vacuously');
    assert.ok(result.results.some((r) => r.id === 'F!=X'));
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

  test('4.39: the prior-year vectors pass and cover both customer categories', () => {
    setup();
    const result = plain(gas.call('runPriorYearVectors', []));
    assert.equal(result.ok, true,
      result.results.filter((r) => !r.ok).map((r) => r.id).join(', '));
    assert.ok(result.results.length >= 5);
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
    gas.evaluate('SETTINGS.FAULT_INJECTION = null;');
    assert.doesNotThrow(() => gas.call('faultInjectionPoint', ['WRITE_HALF', {}]));
  });

  test('4.39: a configured fault point throws where it is placed', () => {
    setup();
    gas.evaluate("SETTINGS.FAULT_INJECTION = {WRITE_HALF: true};");
    assert.throws(() => gas.call('faultInjectionPoint', ['WRITE_HALF', {fileId: 'file1'}]),
      (error) => error && error.code === 'FAULT_INJECTED');
    assert.doesNotThrow(() => gas.call('faultInjectionPoint', ['OTHER_POINT', {}]),
      'only the configured point fires');
    gas.evaluate('SETTINGS.FAULT_INJECTION = null;');
  });

  // ---- 本番では設定が何であっても素通りする ----
  test('4.39: fault injection never fires against the production master', () => {
    setup();
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.evaluate(`
      PropertiesService.getScriptProperties()
        .setProperty('PRODUCTION_MASTER_SPREADSHEET_ID', 'master');
      SETTINGS.FAULT_INJECTION = {WRITE_HALF: true};
    `);
    assert.doesNotThrow(() => gas.call('faultInjectionPoint', ['WRITE_HALF', {}]),
      'a misconfigured setting must not be able to halt production data processing');
    gas.evaluate('SETTINGS.FAULT_INJECTION = null;');
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

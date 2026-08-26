'use strict';

module.exports = function registerDateInferenceTests({test, assert, gas}) {
  const DEFAULT_FORMAT = Object.freeze({
    lookbackMonths: 3,
    forwardMonths: 1
  });

  function base(status, year, month, sources = []) {
    return {status, year: year || null, month: month || null, sources};
  }

  function yearless(id, month, day) {
    return {
      transactionId: id,
      sourceRow: Number(id.replace(/\D/g, '')) || 1,
      date: null,
      dateYearMissing: true,
      dateMonthDay: {month, day},
      dateRawText: `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`,
      dateHashKey: `--${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    };
  }

  function dated(id, value) {
    return {
      transactionId: id,
      sourceRow: Number(id.replace(/\D/g, '')) || 1,
      date: gas.call('parseDate', [value, 'Asia/Tokyo']),
      dateYearMissing: false,
      dateRawText: value,
      dateHashKey: value.replace(/\//g, '-')
    };
  }

  function twoDigit(id, yy, month, day) {
    return {
      transactionId: id,
      sourceRow: Number(id.replace(/\D/g, '')) || 1,
      date: null,
      dateYearMissing: false,
      dateYearDigits: 2,
      dateYear: yy,
      dateMonthDay: {month, day},
      dateRawText: `${String(yy).padStart(2, '0')}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`,
      dateHashKey: null
    };
  }

  function tokyoString(value) {
    return value === null ? null : gas.call('toTokyoDateString_', [value]);
  }

  function evaluateVector(vector) {
    const inferred = gas.call('inferYearsForFile', [
      vector.txs,
      vector.base,
      vector.cardFormat || DEFAULT_FORMAT
    ]);
    const triage = gas.call('applyDateTriageChecks', [
      inferred.txs,
      vector.base,
      gas.call('parseDate', [vector.processingDate || '2026-01-20', 'Asia/Tokyo'])
    ]);
    const issueByTx = new Map();
    [...inferred.rowIssues, ...triage.issues].forEach((issue) => {
      if (!issueByTx.has(issue.transactionId)) issueByTx.set(issue.transactionId, issue.code);
    });
    // 空欄化の規則はテストで再実装しない。本番の判定器に問う（INV-33）。
    // ここを自前で計算すると、`expectedPlanned` は `expectedDerived` と
    // `expectedIssueCodes` が通れば必ず通り、独立に失敗できなくなる。
    const blankIds = new Set(gas.call('blankedDateTransactionIds', [inferred, triage]));
    const derived = inferred.txs.map((tx) => tx.date ? tokyoString(tx.date) : null);
    return {
      inferred,
      derived,
      planned: inferred.txs.map((tx, index) => blankIds.has(tx.transactionId) ? '' : (derived[index] || '')),
      issueCodes: inferred.txs.map((tx) => issueByTx.get(tx.transactionId) || null),
      aj: Boolean(inferred.ambiguous || triage.fileDateInferenceAmbiguous)
    };
  }

  // ---- INV-33：空欄化の対象は2つの由来から求める ----
  //
  // 年が一意に確定しなかった行こそ最も信用できない。日付選別の結果だけを
  // 見ていると、その行の推定日付がそのまま顧客のfreee出納帳へ出る。
  test('INV-33: rows whose year could not be settled are blanked, not just out-of-range rows', () => {
    const yearIssueOnly = gas.call('blankedDateTransactionIds', [
      {rowIssues: [{transactionId: 'TX_YEAR'}]},
      {blankDateTxIds: []}
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(yearIssueOnly)), ['TX_YEAR'],
      'a year-inference failure must blank the planned B value');

    const both = JSON.parse(JSON.stringify(gas.call('blankedDateTransactionIds', [
      {rowIssues: [{transactionId: 'TX_YEAR'}]},
      {blankDateTxIds: ['TX_RANGE', 'TX_YEAR']}
    ])));
    assert.deepEqual(both.slice().sort(), ['TX_RANGE', 'TX_YEAR'],
      'both sources contribute and duplicates collapse');
  });

  function assertVector(vector) {
    const actual = evaluateVector(vector);
    assert.deepEqual(actual.derived, vector.expectedDerived);
    assert.deepEqual(actual.planned, vector.expectedPlanned);
    assert.deepEqual(actual.issueCodes, vector.expectedIssueCodes);
    assert.equal(actual.aj, vector.expectedAj);
    if (vector.assertExtra) vector.assertExtra(actual);
  }

  const vectors = [
    {
      id: 1,
      name: '締め2026-01・明細が11月と12月のみ',
      base: base('RESOLVED', 2026, 1, ['HEADER']),
      txs: [yearless('tx1', 11, 16), yearless('tx2', 11, 28), yearless('tx3', 12, 3), yearless('tx4', 12, 15)],
      expectedDerived: ['2025-11-16', '2025-11-28', '2025-12-03', '2025-12-15'],
      expectedPlanned: ['2025-11-16', '2025-11-28', '2025-12-03', '2025-12-15'],
      expectedIssueCodes: [null, null, null, null], expectedAj: false
    },
    {
      id: 2,
      name: '明細が12月と1月にまたがる',
      base: base('RESOLVED', 2026, 1, ['HEADER']),
      txs: [yearless('tx1', 12, 28), yearless('tx2', 12, 30), yearless('tx3', 1, 4), yearless('tx4', 1, 5)],
      expectedDerived: ['2025-12-28', '2025-12-30', '2026-01-04', '2026-01-05'],
      expectedPlanned: ['2025-12-28', '2025-12-30', '2026-01-04', '2026-01-05'],
      expectedIssueCodes: [null, null, null, null], expectedAj: false
    },
    {
      id: 3,
      name: '明細が降順に並ぶ',
      base: base('RESOLVED', 2026, 1, ['HEADER']),
      txs: [yearless('tx1', 1, 5), yearless('tx2', 1, 4), yearless('tx3', 12, 30), yearless('tx4', 12, 28)],
      expectedDerived: ['2026-01-05', '2026-01-04', '2025-12-30', '2025-12-28'],
      expectedPlanned: ['2026-01-05', '2026-01-04', '2025-12-30', '2025-12-28'],
      expectedIssueCodes: [null, null, null, null], expectedAj: false
    },
    {
      id: 4,
      name: '月の逆転が2回以上',
      base: base('RESOLVED', 2026, 1, ['HEADER']),
      txs: [yearless('tx1', 12, 28), yearless('tx2', 1, 4), yearless('tx3', 12, 30), yearless('tx4', 1, 5)],
      expectedDerived: ['2025-12-28', '2026-01-04', '2025-12-30', '2026-01-05'],
      expectedPlanned: ['2025-12-28', '2026-01-04', '2025-12-30', '2026-01-05'],
      expectedIssueCodes: [null, null, null, null], expectedAj: false
    },
    {
      id: 5,
      name: '締め年月が取得できない・すべて年なし',
      base: base('NOT_FOUND'),
      txs: [yearless('tx1', 12, 28), yearless('tx2', 1, 5)],
      expectedDerived: [null, null], expectedPlanned: ['', ''],
      expectedIssueCodes: ['BILLING_MONTH_NOT_FOUND', 'BILLING_MONTH_NOT_FOUND'], expectedAj: true
    },
    {
      id: 6,
      name: '締め年月が処理日より未来',
      base: base('RESOLVED', 2026, 3, ['HEADER']),
      txs: [yearless('tx1', 2, 10), yearless('tx2', 3, 25)],
      expectedDerived: ['2026-02-10', '2026-03-25'], expectedPlanned: ['', ''],
      expectedIssueCodes: ['DATE_OUT_OF_EXPECTED_RANGE', 'DATE_OUT_OF_EXPECTED_RANGE'], expectedAj: true
    },
    {
      id: 7,
      name: '取得元が矛盾',
      base: base('CONFLICT', null, null, ['FILENAME', 'HEADER']),
      txs: [yearless('tx1', 12, 28)],
      expectedDerived: [null], expectedPlanned: [''],
      expectedIssueCodes: ['BILLING_MONTH_CONFLICT'], expectedAj: true
    },
    {
      id: 8,
      name: '取得元が複数一致',
      base: base('RESOLVED', 2026, 1, ['FILENAME', 'HEADER']),
      txs: [yearless('tx1', 12, 28)],
      expectedDerived: ['2025-12-28'], expectedPlanned: ['2025-12-28'],
      expectedIssueCodes: [null], expectedAj: false,
      assertExtra(actual) {
        assert.equal(actual.inferred.txs[0].dateInferenceSource, 'FILENAME,HEADER');
        assert.equal(actual.inferred.txs[0].dateInferenceBase, '2026-01');
      }
    },
    {
      id: 9,
      name: '年なし日付で推定窓に候補が1つも入らない',
      base: base('RESOLVED', 2026, 1, ['HEADER']),
      txs: [yearless('tx1', 12, 28), yearless('tx2', 8, 15)],
      expectedDerived: ['2025-12-28', null], expectedPlanned: ['2025-12-28', ''],
      expectedIssueCodes: [null, 'DATE_OUT_OF_EXPECTED_RANGE'], expectedAj: false
    },
    {
      id: 10,
      name: '年を含む日付が混在',
      base: base('RESOLVED', 2026, 1, ['HEADER']),
      txs: [dated('tx1', '2025/12/28'), yearless('tx2', 1, 5)],
      expectedDerived: ['2025-12-28', '2026-01-05'], expectedPlanned: ['2025-12-28', '2026-01-05'],
      expectedIssueCodes: [null, null], expectedAj: false
    },
    {
      id: 11,
      name: '締め月が12月・明細が12月と1月',
      base: base('RESOLVED', 2025, 12, ['HEADER']),
      txs: [yearless('tx1', 12, 5), yearless('tx2', 1, 10)],
      expectedDerived: ['2025-12-05', '2026-01-10'], expectedPlanned: ['2025-12-05', '2026-01-10'],
      expectedIssueCodes: [null, null], expectedAj: false
    },
    {
      id: 12,
      name: 'LOOKBACKを13へ拡大した場合',
      base: base('RESOLVED', 2026, 1, ['HEADER']),
      cardFormat: {lookbackMonths: 13, forwardMonths: 1},
      txs: [yearless('tx1', 1, 5)],
      expectedDerived: [null], expectedPlanned: [''],
      expectedIssueCodes: ['DATE_OUT_OF_EXPECTED_RANGE'], expectedAj: false
    },
    {
      id: 13,
      name: '実在しない日付',
      base: base('RESOLVED', 2025, 3, ['HEADER']),
      txs: [yearless('tx1', 2, 29)],
      expectedDerived: [null], expectedPlanned: [''],
      expectedIssueCodes: ['DATE_NOT_EXISTENT'], expectedAj: false
    },
    {
      id: 14,
      name: '年を含む日付が健全性窓の外',
      base: base('RESOLVED', 2026, 1, ['HEADER']),
      txs: [dated('tx1', '2035/01/05')],
      expectedDerived: ['2035-01-05'], expectedPlanned: [''],
      expectedIssueCodes: ['DATE_OUT_OF_EXPECTED_RANGE'], expectedAj: false
    },
    {
      id: 15,
      name: '2桁年',
      base: base('RESOLVED', 2026, 1, ['HEADER']),
      txs: [twoDigit('tx1', 25, 12, 28)],
      expectedDerived: ['2025-12-28'], expectedPlanned: ['2025-12-28'],
      expectedIssueCodes: [null], expectedAj: false
    },
    {
      id: 16,
      name: '500行中1行だけが処理日より後',
      base: base('RESOLVED', 2026, 1, ['HEADER']),
      txs: [...Array.from({length: 499}, (_, index) => yearless(`tx${index + 1}`, 1, 5)), yearless('tx500', 1, 25)],
      expectedDerived: [...Array(499).fill('2026-01-05'), '2026-01-25'],
      expectedPlanned: [...Array(499).fill('2026-01-05'), ''],
      expectedIssueCodes: [...Array(499).fill(null), 'DATE_OUT_OF_EXPECTED_RANGE'], expectedAj: false
    },
    {
      id: 17,
      name: 'ケース16と同一ファイルを2026-02-05に処理',
      processingDate: '2026-02-05',
      base: base('RESOLVED', 2026, 1, ['HEADER']),
      txs: [...Array.from({length: 499}, (_, index) => yearless(`tx${index + 1}`, 1, 5)), yearless('tx500', 1, 25)],
      expectedDerived: [...Array(499).fill('2026-01-05'), '2026-01-25'],
      expectedPlanned: [...Array(499).fill('2026-01-05'), '2026-01-25'],
      expectedIssueCodes: Array(500).fill(null), expectedAj: false
    },
    {
      id: 18,
      name: '年を含む日付が5か月前',
      base: base('RESOLVED', 2026, 1, ['HEADER']),
      txs: [dated('tx1', '2025/08/15'), dated('tx2', '2025/12/28')],
      expectedDerived: ['2025-08-15', '2025-12-28'], expectedPlanned: ['2025-08-15', '2025-12-28'],
      expectedIssueCodes: [null, null], expectedAj: false
    },
    {
      id: 19,
      name: '締め年月が取得できず年あり日付が数年前',
      base: base('NOT_FOUND'),
      txs: [dated('tx1', '2019/01/05'), yearless('tx2', 12, 28)],
      expectedDerived: ['2019-01-05', null], expectedPlanned: ['', ''],
      expectedIssueCodes: ['DATE_OUT_OF_EXPECTED_RANGE', 'BILLING_MONTH_NOT_FOUND'], expectedAj: true
    },
    {
      id: 20,
      name: '締め年月が取得できないが年あり日付は健全性窓内',
      base: base('NOT_FOUND'),
      txs: [dated('tx1', '2025/11/10'), dated('tx2', '2025/12/28')],
      expectedDerived: ['2025-11-10', '2025-12-28'], expectedPlanned: ['2025-11-10', '2025-12-28'],
      expectedIssueCodes: [null, null], expectedAj: false
    }
  ];

  for (const vector of vectors) {
    test(`5.1 vector ${vector.id}: ${vector.name}`, () => assertVector(vector));
  }

  // ---- INV-26：導出日は処理日に依存しない。B列予定値だけが依存する ----
  //
  // 以前このテストは `inferYearsForFile` を第4引数付きで2回呼んで結果を
  // 比べていた。同関数は3引数で第4引数を捨てるため、**同一の呼出を2回**
  // していただけで、何も検証していなかった。処理日を実際に受け取る
  // `applyDateTriageChecks` を通して、依存する側としない側を分けて見る。
  test('INV-26: the derived date does not depend on the processing date', () => {
    const input = [yearless('tx1', 12, 28), yearless('tx2', 1, 5)];
    const billingBase = base('RESOLVED', 2026, 1, ['HEADER']);
    const inferred = gas.call('inferYearsForFile', [input, billingBase, DEFAULT_FORMAT]);

    const project = (result) => result.txs.map((tx) => ({
      date: tx.date ? tokyoString(tx.date) : null,
      source: tx.dateInferenceSource,
      inferenceBase: tx.dateInferenceBase
    }));
    assert.deepEqual(project(inferred).map((item) => item.date), ['2025-12-28', '2026-01-05']);

    // 処理日が違えば選別結果は変わり得るが、導出日そのものは動かない。
    const triageOn = (processingDate) => gas.call('applyDateTriageChecks',
      [inferred.txs, billingBase, gas.call('parseDate', [processingDate, 'Asia/Tokyo'])]);
    const early = triageOn('2025-12-15');
    const later = triageOn('2026-02-05');

    assert.deepEqual(project(inferred).map((i) => i.date), ['2025-12-28', '2026-01-05'],
      'the triage pass must not mutate the derived dates');

    // 2025-12-15 に処理すると、締め年月2026-01がまだ未来である。年を補完した
    // 行はいずれも信用できないので両方とも空欄化される（規則6d）。
    // 2026-02-05 に処理すればどちらも過去であり、空欄化されない。
    // **この差が出ることが、処理日を実際に見ている証拠である。**
    assert.deepEqual(JSON.parse(JSON.stringify(early.blankDateTxIds)).sort(), ['tx1', 'tx2']);
    assert.deepEqual(JSON.parse(JSON.stringify(later.blankDateTxIds)), []);
  });

  test('5.1 rule 7: a two-digit year is not resolved without a billing month', () => {
    const result = gas.call('inferYearsForFile', [
      [twoDigit('tx1', 25, 12, 28)], base('NOT_FOUND'), DEFAULT_FORMAT
    ]);
    assert.equal(result.txs[0].date, null);
    assert.equal(result.rowIssues.length, 1);
    assert.equal(result.rowIssues[0].reviewType, 'DATE');
  });
};

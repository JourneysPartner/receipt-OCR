'use strict';

/**
 * 4.14 取引単位の妥当性判定と入力上限検査（5.10 の区分表）。
 *
 * ここでの分かれ目は顧客の手間に直結する。区分1はファイル全体を無書込で
 * 突き返す判断であり、区分3は行を確保して当該項目だけを要確認にする。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: []});
    gas.stubs.setActiveSpreadsheet('master');
  }

  const tx = (overrides = {}) => Object.assign({
    transactionId: 'TX_1', sourceRow: 2,
    merchantOriginal: '店舗A', amountBillingJpy: 1000
  }, overrides);

  const issuesOf = (txs, context) =>
    plain(gas.call('validateTransactions', [txs, context || {}])).issues;

  // ---- 利用店名 ----

  test('5.10: a missing merchant is a customer fix by default', () => {
    setup();
    const issues = issuesOf([tx({merchantOriginal: ''})]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].customerFix, true,
      'without a merchant the row cannot be booked at all - the source must be fixed');
    assert.equal(issues[0].kind, 'MERCHANT_REQUIRED');
  });

  test('5.10: a format that legitimately leaves the merchant blank stays category 3', () => {
    setup();
    // 年会費行など、形式固有ルール上は空欄が正当な場合
    const issues = issuesOf([tx({merchantOriginal: ''})], {cardFormat: {merchantOptional: 'TRUE'}});
    assert.equal(issues.length, 1);
    assert.notEqual(issues[0].customerFix, true,
      'bouncing the whole file back to the customer would be wrong here');
    assert.equal(issues[0].reviewType, 'PARTNER');
  });

  test('5.10: whitespace is not a merchant name', () => {
    setup();
    assert.equal(issuesOf([tx({merchantOriginal: '　 '})])[0].customerFix, true);
  });

  // ---- 金額 ----

  test('5.10: an unreadable amount raises AMOUNT, not a customer fix', () => {
    setup();
    ['', null, undefined, 'なし'].forEach((amount) => {
      const issues = issuesOf([tx({amountBillingJpy: amount})]);
      assert.equal(issues.length, 1, `amount=${String(amount)} must raise exactly one issue`);
      assert.equal(issues[0].reviewType, 'AMOUNT');
      assert.notEqual(issues[0].customerFix, true);
    });
  });

  // 0円は不正ではない。全額値引きや無料キャンペーンで実際に起きる。
  test('5.10: a zero amount is kept as a transaction and flagged, never dropped', () => {
    setup();
    const issues = issuesOf([tx({amountBillingJpy: 0})]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].reviewType, 'ZERO_AMOUNT');
    assert.notEqual(issues[0].customerFix, true,
      'a zero-yen line is a business decision, not a broken source file');
  });

  test('5.10: an ordinary transaction raises nothing', () => {
    setup();
    assert.deepEqual(issuesOf([tx()]), []);
    assert.deepEqual(issuesOf([tx({amountBillingJpy: -500})]), [],
      'a refund is a normal negative amount');
  });

  test('5.10: each transaction is judged on its own', () => {
    setup();
    const issues = issuesOf([
      tx({transactionId: 'TX_1'}),
      tx({transactionId: 'TX_2', amountBillingJpy: 0}),
      tx({transactionId: 'TX_3', merchantOriginal: ''})
    ]);
    assert.equal(issues.length, 2);
    assert.deepEqual(issues.map((i) => i.transactionId), ['TX_2', 'TX_3']);
  });

  // ---- 区分判定へ渡ったときの帰結 ----

  test('5.10: a missing merchant makes the whole file category 1', () => {
    setup();
    const result = plain(gas.call('classifyValidationResult',
      [{transactionValidation: issuesOf([tx({merchantOriginal: ''})]).length
          ? {issues: issuesOf([tx({merchantOriginal: ''})])} : {issues: []}}]));
    assert.equal(result.category, 1);
    assert.equal(result.code, 'SOURCE_REQUIRES_CUSTOMER_FIX');
  });

  test('5.10: a zero amount leaves the file at category 3, so the row is still written', () => {
    setup();
    const result = plain(gas.call('classifyValidationResult',
      [{transactionValidation: {issues: issuesOf([tx({amountBillingJpy: 0})])}}]));
    assert.equal(result.category, 3);
  });

  // ---- 入力上限（4.14・4.31） ----

  test('4.14: the run limit is checked against the persisted cumulative count', () => {
    setup();
    gas.evaluate('SETTINGS.MAX_TRANSACTIONS_PER_RUN = 100;');

    assert.equal(plain(gas.call('checkRunTransactionLimit', ['RUN_1', 40])).ok, true);
    gas.call('incrementRunTransactionCount', ['RUN_1', 40]);

    // 継続トリガーで再開した体で、もう一度検査する。
    // メモリ上の数だけを見ていると0から数え直し、上限がいくらでも超えられる。
    const second = plain(gas.call('checkRunTransactionLimit', ['RUN_1', 40]));
    assert.equal(second.cumulative, 80, 'the earlier 40 must still count');
    assert.equal(second.ok, true);

    gas.call('incrementRunTransactionCount', ['RUN_1', 40]);
    const third = plain(gas.call('checkRunTransactionLimit', ['RUN_1', 40]));
    assert.equal(third.cumulative, 120);
    assert.equal(third.ok, false, 'exceeding the limit must be reported, not silently truncated');
  });

  test('4.14: the limit is per run, so a different run starts fresh', () => {
    setup();
    gas.evaluate('SETTINGS.MAX_TRANSACTIONS_PER_RUN = 100;');
    gas.call('incrementRunTransactionCount', ['RUN_1', 90]);
    assert.equal(plain(gas.call('checkRunTransactionLimit', ['RUN_2', 40])).cumulative, 40);
  });

  // ---- 実行カウンタを片付ける ----
  //
  // Script Properties にはキー数と合計サイズの上限がある。実行ごとに1件作って
  // 消さないと、日次実行を続けるうちに溜まり、ある日プロパティ書込が失敗して
  // 実行そのものが止まる。
  test('4.31: the per-run counter is removed when the run ends', () => {
    setup();
    gas.call('incrementRunTransactionCount', ['RUN_1', 40]);
    assert.equal(gas.call('getRunCumulativeTransactionCount', ['RUN_1']), 40);

    gas.call('clearRunTransactionCount', ['RUN_1']);
    assert.equal(gas.call('getRunCumulativeTransactionCount', ['RUN_1']), 0);
    assert.equal(
      gas.evaluate("PropertiesService.getScriptProperties().getProperty('RUN_TX_COUNT_RUN_1')"),
      null, 'the property itself must be gone, not merely zero');
  });

  test('4.14: a negative or non-integer count is rejected', () => {
    setup();
    [-1, 1.5, 'ten'].forEach((count) => {
      assert.throws(() => gas.call('checkRunTransactionLimit', ['RUN_1', count]),
        (error) => error && /non-negative count/.test(String(error.message)));
    });
  });
};

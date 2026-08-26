'use strict';

module.exports = function registerPhase1bPartnerDuplicateTests({test, assert, gas}) {
  function plain(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function row(id, scope, original, normalized, partner, method, priority, options = {}) {
    return {
      id,
      scope,
      original,
      normalized,
      partnerName: partner,
      matchMethod: method,
      priority,
      customerId: scope === 'customer' ? 'CFIX' : '',
      validFrom: options.validFrom || null,
      validTo: options.validTo || null,
      approved: options.approved === undefined ? false : options.approved,
      active: options.active === undefined ? true : options.active,
      conflict: options.conflict === undefined ? false : options.conflict
    };
  }

  const fixtureRows = [
    row('F1', 'customer', 'ﾄﾞﾝｷﾎｰﾃ ﾅｶﾞｵｶ', 'ドンキホ-テ ナガオカ', '株式会社ドン・キホーテ', 'exact_original', 1, {active: 'TRUE'}),
    row('F2', 'customer', 'ｱﾏｿﾞﾝ ｼﾞｬﾊﾟﾝ', 'アマゾン ジャパン', 'アマゾンジャパン合同会社', 'exact_normalized', 1),
    row('F3', 'common', 'ｾﾌﾞﾝｲﾚﾌﾞﾝ', 'セブンイレブン', '株式会社セブン-イレブン・ジャパン', 'exact_normalized', 1),
    row('F4', 'common', 'ﾄﾞﾝｷﾎｰﾃ ﾅｶﾞｵｶ', 'ドンキホ-テ ナガオカ', 'ドンキホーテ長岡店', 'exact_normalized', 5),
    row('F5', 'customer', 'ｽﾀｰﾊﾞｯｸｽ', 'スタ-バックス', 'スターバックスコーヒージャパン株式会社', 'exact_normalized', 1, {validTo: '2025-12-31'}),
    row('F6', 'customer', 'ﾏﾂﾓﾄｷﾖｼ', 'マツモトキヨシ', '株式会社マツモトキヨシ', 'exact_normalized', 1, {conflict: 'TRUE'}),
    row('F7', 'customer', 'ﾏﾂﾓﾄｷﾖｼ', 'マツモトキヨシ', 'マツキヨココカラ&カンパニー', 'exact_normalized', 2, {conflict: true}),
    row('F8', 'customer', 'ﾖﾄﾞﾊﾞｼ', 'ヨドバシ', '株式会社ヨドバシカメラ', 'prefix', 1, {approved: 'FALSE'}),
    row('F9', 'customer', 'ﾋﾞｯｸｶﾒﾗ', 'ビックカメラ', '株式会社ビックカメラ', 'prefix', 1, {approved: 'TRUE'}),
    row('F10', 'customer', 'ﾛｰｿﾝ', 'ロ-ソン', '株式会社ローソン', 'exact_normalized', 1, {active: 'FALSE'}),
    row('F11', 'customer', 'ｶﾙﾃﾞｨ', 'カルディ', '株式会社キャメル珈琲', 'exact_normalized', 3),
    row('F12', 'customer', 'KALDI', 'KALDI', '株式会社キャメル珈琲', 'exact_normalized', 7),
    row('F13', 'customer', 'カルディ', 'カルディ', '株式会社キャメル珈琲', 'exact_normalized', 2),
    row('F14', 'customer', 'ﾔﾏﾀﾞﾃﾞﾝｷ', 'ヤマダデンキ', '株式会社ヤマダデンキ', 'exact_normalized', 1),
    row('F15', 'customer', 'ヤマダデンキ', 'ヤマダデンキ', 'ヤマダホールディングス', 'exact_normalized', 5)
  ];

  test('INV-42: every 5.14 fixture C value equals normalizeMerchant(B)', () => {
    const mismatches = fixtureRows
      .filter((item) => item.normalized !== gas.call('normalizeMerchant', [item.original]))
      .map((item) => ({
        id: item.id,
        original: item.original,
        normalized: item.normalized,
        expected: gas.call('normalizeMerchant', [item.original])
      }));
    assert.deepEqual(mismatches, []);
  });

  const dictIndex = {
    customer: fixtureRows.filter((item) => item.scope === 'customer'),
    common: fixtureRows.filter((item) => item.scope === 'common'),
    commonPartners: [
      '株式会社ドン・キホーテ', 'アマゾンジャパン合同会社',
      '株式会社セブン-イレブン・ジャパン', 'ドンキホーテ長岡店',
      'スターバックスコーヒージャパン株式会社', '株式会社マツモトキヨシ',
      'マツキヨココカラ&カンパニー', '株式会社ヨドバシカメラ',
      '株式会社ビックカメラ', '株式会社ローソン', '株式会社キャメル珈琲'
    ]
  };

  function match(original, usageDate) {
    return plain(gas.call('matchPartner', [{
      transactionId: 'TX1',
      merchantOriginal: original,
      date: usageDate === null ? null : new Date(`${usageDate}T00:00:00+09:00`)
    }, 'CFIX', dictIndex]));
  }

  const vectors = [
    ['V1', 'ﾄﾞﾝｷﾎｰﾃ ﾅｶﾞｵｶ', '2026-01-05', true, '株式会社ドン・キホーテ', 'STEP1', ['F1']],
    ['V2', 'ドンキホーテ　ナガオカ', '2026-01-05', true, '株式会社ドン・キホーテ', 'STEP2', ['F1']],
    ['V3', 'ｱﾏｿﾞﾝ ｼﾞｬﾊﾟﾝ', '2026-01-05', true, 'アマゾンジャパン合同会社', 'STEP1', ['F2']],
    ['V4', 'ｾﾌﾞﾝｲﾚﾌﾞﾝ', '2026-01-05', true, '株式会社セブン-イレブン・ジャパン', 'STEP3', ['F3']],
    ['V5', 'ｽﾀｰﾊﾞｯｸｽ', '2026-01-05', false, null, null, []],
    ['V6', 'ｽﾀｰﾊﾞｯｸｽ', '2025-11-20', true, 'スターバックスコーヒージャパン株式会社', 'STEP1', ['F5']],
    ['V7', 'ｽﾀｰﾊﾞｯｸｽ', null, true, 'スターバックスコーヒージャパン株式会社', 'STEP1', ['F5']],
    ['V8', 'ﾏﾂﾓﾄｷﾖｼ', '2026-01-05', false, null, 'STEP1', ['F6', 'F7']],
    ['V9', 'ﾖﾄﾞﾊﾞｼｶﾒﾗ ｼﾝｼﾞｭｸ', '2026-01-05', false, null, null, ['F8']],
    ['V10', 'ﾋﾞｯｸｶﾒﾗ ｲｹﾌﾞｸﾛ', '2026-01-05', true, '株式会社ビックカメラ', 'STEP5', ['F9']],
    ['V11', 'ﾛｰｿﾝ', '2026-01-05', false, null, null, []],
    ['V12', 'ｶﾙﾃﾞｨ', '2026-01-05', true, '株式会社キャメル珈琲', 'STEP1', ['F11']],
    ['V13', 'ｶﾙﾃﾞｨ　', '2026-01-05', true, '株式会社キャメル珈琲', 'STEP2', ['F13', 'F11']],
    ['V14', 'ﾔﾏﾀﾞﾃﾞﾝｷ　', '2026-01-05', false, null, 'STEP2', ['F14', 'F15']]
  ];

  for (const [id, original, usageDate, autoConfirm, partnerName, matchedBy, candidateIds] of vectors) {
    test(`5.14 ${id}: fixed partner-matching vector`, () => {
      const result = match(original, usageDate);
      assert.equal(result.autoConfirm, autoConfirm);
      assert.equal(result.partnerName, partnerName);
      assert.equal(result.matchedBy, matchedBy);
      assert.deepEqual(result.candidates.map((candidate) => candidate.ruleId), candidateIds);
      assert.equal(
        result.partnerResolutionStatus,
        autoConfirm ? 'RESOLVED_WITH_PARTNER' : 'UNRESOLVED'
      );
      if (id === 'V14') {
        assert.equal(result.conflict, false);
        assert.deepEqual(
          result.candidates.map((candidate) => candidate.partnerName),
          ['株式会社ヤマダデンキ', 'ヤマダホールディングス']
        );
        assert.deepEqual(result.candidates.map((candidate) => candidate.priority), [1, 5]);
      }
    });
  }

  test('5.7 case 1: migrated exact_normalized row does not require approval', () => {
    const result = match('アマゾン　ジャパン', '2026-01-05');
    assert.equal(result.matchedBy, 'STEP2');
    assert.equal(result.autoConfirm, true);
    assert.equal(result.partnerName, 'アマゾンジャパン合同会社');
  });

  test('5.7 case 2: learned unapproved exact row auto-confirms at step 2', () => {
    const index = {customer: [
      row('LEARNED', 'customer', 'ﾃｽﾄｼｮｯﾌﾟ', 'テストショップ', 'テスト取引先', 'exact_normalized', 1, {approved: false})
    ], common: []};
    const result = gas.call('matchPartner', [{merchantOriginal: 'テストショップ　', date: null}, 'CFIX', index]);
    assert.equal(result.matchedBy, 'STEP2');
    assert.equal(result.autoConfirm, true);
  });

  test('5.7 case 3: unapproved prefix is suggestion-only', () => {
    const result = match('ﾖﾄﾞﾊﾞｼｶﾒﾗ ｼﾝｼﾞｭｸ', '2026-01-05');
    assert.equal(result.autoConfirm, false);
    assert.deepEqual(result.candidates.map((candidate) => candidate.ruleId), ['F8']);
  });

  test('5.7 case 4: approved unique prefix auto-confirms at step 5', () => {
    const result = match('ﾋﾞｯｸｶﾒﾗ ｲｹﾌﾞｸﾛ', '2026-01-05');
    assert.equal(result.matchedBy, 'STEP5');
    assert.equal(result.autoConfirm, true);
  });

  test('5.7 case 5: one conflicted exact row still cannot auto-confirm', () => {
    const index = {customer: [row('C1', 'customer', 'ABC', 'ABC', 'Partner A', 'exact_original', 1, {conflict: 'TRUE'})], common: []};
    const result = gas.call('matchPartner', [{merchantOriginal: 'ABC', date: null}, 'CFIX', index]);
    assert.equal(result.autoConfirm, false);
    assert.equal(result.conflict, true);
  });

  test('5.7 case 6: sheet string TRUE is normalized before active judgement', () => {
    const result = match('ﾄﾞﾝｷﾎｰﾃ ﾅｶﾞｵｶ', '2026-01-05');
    assert.equal(result.autoConfirm, true);
    assert.equal(result.matchedRuleId, 'F1');
  });

  test('5.7 case 7: an expired rule is excluded by usage date', () => {
    const result = match('ｽﾀｰﾊﾞｯｸｽ', '2026-01-05');
    assert.equal(result.autoConfirm, false);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.excludedByPeriod, ['F5']);
  });

  test('5.7 case 8: a rule inside its period remains eligible', () => {
    assert.equal(match('ｽﾀｰﾊﾞｯｸｽ', '2025-11-20').autoConfirm, true);
  });

  test('5.7 case 9: null usage date does not apply period exclusion', () => {
    assert.equal(match('ｽﾀｰﾊﾞｯｸｽ', null).autoConfirm, true);
  });

  test('5.7 case 11: duplicate rows returning one partner are unique', () => {
    const result = match('ｶﾙﾃﾞｨ　', '2026-01-05');
    assert.equal(result.autoConfirm, true);
    assert.equal(result.partnerName, '株式会社キャメル珈琲');
  });

  test('5.7 case 12: blank planned B does not replace the derived usage-date basis', () => {
    const result = plain(gas.call('matchPartner', [{
      merchantOriginal: 'ｽﾀｰﾊﾞｯｸｽ',
      date: new Date('2025-11-20T00:00:00+09:00'),
      plannedDate: ''
    }, 'CFIX', dictIndex]));
    assert.equal(result.autoConfirm, true);
    assert.equal(result.matchedRuleId, 'F5');
  });

  function fileRow(fileId, customerId, contentHash, hashVersion = '3', active = true) {
    return {fileId, customerId, contentHash, hashVersion, active};
  }

  test('5.8 duplicate case 1: same-customer content hash stops import', () => {
    const result = plain(gas.call('checkDuplicateFile', ['C1', 'H1', '3', [fileRow('OLD', 'C1', 'H1')]]));
    assert.deepEqual(result, {duplicate: true, matchedFileId: 'OLD', code: 'DUPLICATE_CONTENT'});
  });

  test('5.8 duplicate case 2: another customer is not a duplicate', () => {
    const result = gas.call('checkDuplicateFile', ['C1', 'H1', '3', [fileRow('OLD', 'C2', 'H1')]]);
    assert.equal(result.duplicate, false);
  });

  function txIndex(fileId, occurrenceIndex, identityHash, options = {}) {
    return {
      transactionId: `${fileId}-${occurrenceIndex}`,
      customerId: options.customerId || 'C1',
      fileId,
      occurrenceIndex,
      identityHash,
      contentHash: options.contentHash || 'OLD_CONTENT',
      hashVersion: options.hashVersion || '3',
      freeeImportStatus: options.freeeImportStatus || 'NOT_IMPORTED',
      active: options.active === undefined ? true : options.active,
      registeredAt: options.registeredAt || '2026-01-01T00:00:00+09:00'
    };
  }

  test('5.8 duplicate case 3: matching identity sequence with changed content is a category-2 revision candidate', () => {
    const rows = [txIndex('OLD', 0, 'I1'), txIndex('OLD', 1, 'I2')];
    const result = plain(gas.call('checkPurposeRevisionCandidate', [
      'C1', ['I1', 'I2'], 'NEW_CONTENT', '3', rows, {asOfDate: '2026-01-20'}
    ]));
    assert.equal(result.candidate, true);
    assert.equal(result.fileId, 'OLD');
    assert.equal(result.matchedCount, 2);
    assert.equal(result.code, 'PURPOSE_REVISION_CANDIDATE');
  });

  test('5.8 duplicate case 4: imported revision candidates are warning-only and never auto-updated', () => {
    const rows = [
      txIndex('OLD', 0, 'I1', {freeeImportStatus: 'IMPORTED'}),
      txIndex('OLD', 1, 'I2')
    ];
    const result = gas.call('checkPurposeRevisionCandidate', [
      'C1', ['I1', 'I2'], 'NEW_CONTENT', '3', rows, {asOfDate: '2026-01-20'}
    ]);
    assert.equal(result.hasImportedTransactions, true);
    assert.equal(result.autoUpdate, false);
  });

  test('5.8 duplicate case 5: partial identity matches only produce a warning count', () => {
    const rows = [txIndex('OLD', 0, 'I1'), txIndex('OLD', 1, 'OTHER')];
    const candidate = gas.call('checkPurposeRevisionCandidate', [
      'C1', ['I1', 'I2'], 'NEW_CONTENT', '3', rows, {asOfDate: '2026-01-20'}
    ]);
    assert.equal(candidate.candidate, false);
    assert.equal(gas.call('countPartialMatches', ['C1', ['I1', 'I2'], rows, '3', {asOfDate: '2026-01-20'}]), 1);
  });

  test('5.8 duplicate case 6: legitimate same-day same-amount transactions remain separate inputs', () => {
    const txs = [
      {customerId: 'C1', dateHashKey: '2026-01-05', amountBillingJpy: 100, merchantOriginal: 'STORE'},
      {customerId: 'C1', dateHashKey: '2026-01-05', amountBillingJpy: 100, merchantOriginal: 'STORE'}
    ];
    const hashes = txs.map((tx) => gas.call('generateIdentityHash', [tx]));
    assert.equal(hashes[0], hashes[1],
      'the two are genuinely indistinguishable by content');

    // 同一ハッシュでも別取引として扱う。同じ店で同じ日に同じ額を2回使うのは
    // 正当な取引であり、片方を落とすと顧客の帳簿から1件消える。
    // 区別するのは出現順（occurrenceIndex）である。
    const ids = txs.map((tx, i) => gas.call('generateTransactionId',
      [Object.assign({}, tx, {
        fileId: 'file1', sourceSheetName: 'Sheet1', sourceRow: 2 + i,
        occurrenceIndex: i, generation: 0
      })]));
    assert.notEqual(ids[0], ids[1],
      'both must survive as separate transactions, distinguished by occurrence');
  });

  test('5.8 duplicate case 7: different hash versions are incomparable', () => {
    const result = gas.call('checkDuplicateFile', ['C1', 'H1', '3', [fileRow('OLD', 'C1', 'H1', '2')]]);
    assert.equal(result.duplicate, false);
    assert.equal(result.comparable, false);
  });

  test('5.8 duplicate case 8: superseded records are ignored', () => {
    const result = gas.call('checkDuplicateFile', ['C1', 'H1', '3', [fileRow('OLD', 'C1', 'H1', '3', 'FALSE')]]);
    assert.equal(result.duplicate, false);
  });

  test('5.8 duplicate case 9: permanent file index records remain sufficient', () => {
    const permanentOnly = [fileRow('ARCHIVED_LOG_FILE', 'C1', 'H1')];
    assert.equal(gas.call('checkDuplicateFile', ['C1', 'H1', '3', permanentOnly]).duplicate, true);
  });

  test('5.8 duplicate case 10: processing-date-dependent planned B does not affect content hash', () => {
    const submitted = [{
      occurrenceIndex: 0,
      dateHashKey: '--01-25',
      amountBillingJpy: 500,
      merchantOriginal: 'STORE',
      purpose: '経費',
      plannedDate: ''
    }];
    const later = [Object.assign({}, submitted[0], {plannedDate: '2026-01-25', date: new Date('2026-01-25T00:00:00+09:00')})];
    assert.equal(gas.call('generateContentHash', [submitted, 'Sheet1']), gas.call('generateContentHash', [later, 'Sheet1']));
  });

  test('5.8 duplicate case 11: records outside the lookback window are excluded', () => {
    const rows = [
      txIndex('OLD', 0, 'I1', {registeredAt: '2024-12-31T00:00:00+09:00'}),
      txIndex('OLD', 1, 'I2', {registeredAt: '2024-12-31T00:00:00+09:00'})
    ];
    const result = gas.call('checkPurposeRevisionCandidate', [
      'C1', ['I1', 'I2'], 'NEW_CONTENT', '3', rows, {asOfDate: '2026-01-20', lookbackMonths: 12}
    ]);
    assert.equal(result.candidate, false);
  });

  test('5.8 change case 1: unchanged metadata skips hash and is unchanged', () => {
    const result = plain(gas.call('detectProcessedFileChange', [
      'F1', 'R1', null, {revisionId: 'R1', binaryHash: 'B1'}
    ]));
    assert.deepEqual(result, {changed: false, reason: null});
  });

  test('5.8 change case 2: changed metadata with identical binary is unchanged', () => {
    assert.equal(gas.call('detectProcessedFileChange', [
      'F1', 'R2', 'B1', {revisionId: 'R1', binaryHash: 'B1'}
    ]).changed, false);
  });

  test('5.8 change case 3: changed binary raises FILE_CHANGED', () => {
    const result = gas.call('detectProcessedFileChange', [
      'F1', 'R2', 'B2', {revisionId: 'R1', binaryHash: 'B1'}
    ]);
    assert.equal(result.changed, true);
    assert.equal(result.reason, 'FILE_CHANGED');
  });

  test('5.8 change case 4: deleted files report FILE_NOT_FOUND without throwing', () => {
    const result = gas.call('detectProcessedFileChange', [
      'F1', null, null, {revisionId: 'R1', binaryHash: 'B1', notFound: true}
    ]);
    assert.deepEqual(plain(result), {changed: false, reason: 'FILE_NOT_FOUND'});
  });

  test('5.8 change case 5: guard blocks writes and requests reservation release', () => {
    const result = gas.call('guardFileUnchanged', [
      'F1', 'R1', 'B1', {revisionId: 'R2', binaryHash: 'B2'}
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'FILE_CHANGED');
    assert.equal(result.releaseReservedRows, true);
  });
};

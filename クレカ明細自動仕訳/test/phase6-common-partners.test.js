'use strict';

module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const call = (name, args = []) => plain(gas.call(name, args));
  const sheet = (name) => gas.stubs.getSpreadsheet('master').getSheetByName(name);
  const rows = (name) => sheet(name).getDataRange().getValues().slice(1).filter((row) => row[0]);
  const actor = 'cp-owner@example.com';
  let serial = 0;

  function setup() {
    gas.stubs.reset(); serial = 0;
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets');
    gas.stubs.setSpreadsheetOwner('master', actor);
    gas.stubs.setActiveUser(actor);
    gas.stubs.createSpreadsheet('cp-dest', {sheets: [{name: '入力',
      values: [['日付', '取引先', '摘要', '金額', 'メモ', '内部ID']], maxRows: 100, maxColumns: 6}]});
    gas.stubs.createSpreadsheet('cp-index', {sheets: []});
    gas.evaluate("SETTINGS.TX_INDEX_SPREADSHEET_ID='cp-index'; SETTINGS.FAULT_INJECTION=null;");
    gas.call('registerTestCustomer', [{customerId: 'CP001', customerName: '架空顧客アルファ',
      sourceFolderId: 'cp-folder', destinationSpreadsheetId: 'cp-dest', destinationSheetName: '入力',
      columns: {B: 1, F: 2, I: 3, K: 4, M: 5, txId: 6}, reviewers: actor, admins: actor}]);
  }

  function review(merchant = '架空店アルファ', fileId = 'cp-file') {
    serial += 1;
    const fullTxId = 'CP_TX_' + serial;
    const tx = {fullTxId, customerId: 'CP001', fileId, sourceRow: serial + 1,
      formatId: 'cp-format', merchantOriginal: merchant, originalAmount: 123,
      destinationSpreadsheetId: 'cp-dest', destinationSheetName: '入力', destinationRow: serial + 1,
      planned: {b: '2026-01-05', f: '', i: '架空用途', k: merchant, m: 123}};
    const row = call('makeTransactionRow_', [tx, 'CP_RUN', '2026-01-06T00:00:00Z']);
    row[9] = 'REVIEW_REQUIRED'; row[10] = 'COMMITTED';
    row.splice(23, 5, ...row.slice(18, 23));
    sheet('クレカ取引ログ').appendRow(row);
    gas.stubs.getSpreadsheet('cp-dest').getSheetByName('入力').getRange(serial + 1, 1, 1, 6)
      .setValues([[tx.planned.b, '', tx.planned.i, 123, '', fullTxId]]);
    const registered = call('registerReview', [{reviewType: 'PARTNER', fullTxId, fileId,
      customerId: 'CP001', customerName: '架空顧客アルファ', sourceRow: serial + 1,
      merchantOriginal: merchant, merchantNormalized: call('normalizeMerchant', [merchant])}]);
    return call('getReviewById', [registered.reviewId]);
  }

  function partner(name, state = 'ACTIVE') {
    sheet('顧客別取引先一覧').appendRow(['CP_P_' + rows('顧客別取引先一覧').length,
      'CP001', name, state, '', 'RESOLUTION', actor, '', '', '']);
  }
  function common(name) {
    sheet('共通取引先一覧').appendRow(['CP_COMMON_' + rows('共通取引先一覧').length, name, '', actor, actor, 1]);
  }
  function dictionary(original, name, options = {}) {
    const row = ['CP_DICT_' + (rows('共通取引先辞書').length + rows('顧客別取引先辞書').length),
      original, call('normalizeMerchant', [original]), name, 'exact_normalized', '',
      options.common ? '' : 'CP001', '', '', false, 'cp-source@example.com', '', '', 1, true, false, '', ''];
    Object.entries(options.cells || {}).forEach(([column, value]) => { row[Number(column)] = value; });
    sheet(options.common ? '共通取引先辞書' : '顧客別取引先辞書').appendRow(row);
    return row;
  }
  function snapshot() {
    return gas.stubs.getSpreadsheetIds().sort().map((id) => [id,
      gas.stubs.getSpreadsheet(id).getSheets().map((item) => [item.getName(), item.getDataRange().getValues()])]);
  }
  function batch(reviews, names, scope = 'COMMON', options = {}) {
    return call('resolvePartnerReviewsBatch', ['CP001', reviews[0].fileId, reviews.map((item, index) => ({
      reviewId: item.reviewId, operation: 'ADOPT_EXISTING_PARTNER', partnerName: names[index],
      learn: true, scope: Array.isArray(scope) ? scope[index] : scope
    })), Object.assign({actor}, options)]);
  }
  function web(reviews, names, scope) {
    if (arguments.length < 3) scope = 'COMMON';
    return call('webAppResolveReviews', ['CP001', reviews.map((item, index) => ({
      reviewId: item.reviewId, partnerName: names[index], scope
    })), {}]);
  }
  function match(original, partnerList, commonPartners, customer = [], commonRules = []) {
    const source = {customer, common: commonRules, commonPartners};
    if (partnerList !== undefined) source.partnerList = partnerList;
    const index = call('buildDictionaryIndex', ['CP001', source]);
    return call('matchPartner', [{merchantOriginal: original}, 'CP001', index]);
  }
  const rawPartners = (names, state = 'ACTIVE') => names.map((name, index) => ({rowNumber: index + 2,
    values: ['CP_P' + index, 'CP001', name, state, '', '', '', '', '', '']}));

  test('cp 1: 名前の鍵はひらがなと小さい字をまとめ元の正規化を変えない', () => {
    for (const [left, right] of [['テストデイオン', 'テストディオン'],
      ['あおぞらストア', 'アオゾラストア'], ['ﾐﾆﾁｭｱｼｮｯﾌﾟ', 'ミニチユアシヨツプ']]) {
      assert.equal(call('partnerNameKey_', [left]), call('partnerNameKey_', [right]));
    }
    assert.notEqual(call('normalizeMerchant', ['テストデイオン']), call('normalizeMerchant', ['テストディオン']));
  });
  test('cp 2: 名前一致は小さい字をまとめ複数の名前なら自動確定しない', () => {
    const one = match('テストデイオン', rawPartners(['テストディオン']), []);
    assert.equal(one.matchedBy, 'PARTNER_NAME'); assert.equal(one.autoConfirm, true);
    const two = match('テストデイオン', rawPartners(['テストディオン', 'テストデイオン']), []);
    assert.equal(two.autoConfirm, false); assert.equal(two.candidates.length, 2);
  });
  test('cp 2b: 店名側の小さい字とひらがなも顧客別と共通の名前に一致する', () => {
    for (const [merchant, name] of [['テストディオン', 'テストデイオン'],
      ['あおぞらストア', 'アオゾラストア'], ['ﾐﾆﾁｭｱｼｮｯﾌﾟ', 'ミニチユアシヨツプ']]) {
      for (const useCommon of [false, true]) {
        const result = match(merchant, useCommon ? [] : rawPartners([name]), useCommon ? [name] : []);
        assert.equal(result.autoConfirm, true); assert.equal(result.matchedBy, 'PARTNER_NAME');
        assert.equal(result.partnerName, name);
      }
    }
  });
  test('cp 3: 共通の名前は文字列でも照合し顧客の廃止と一覧省略を守る', () => {
    for (const commonPartners of [['テストディオン'], [{partnerId: 'CP_COMMON', partnerName: 'テストディオン'}]]) {
      const result = match('テストデイオン', [], commonPartners);
      assert.equal(result.autoConfirm, true); assert.equal(result.matchedBy, 'PARTNER_NAME');
      assert.equal(match('テストデイオン', rawPartners(['テストディオン'], 'RETIRED'), commonPartners).autoConfirm, false);
      assert.equal(match('テストデイオン', undefined, commonPartners).autoConfirm, false);
    }
  });
  test('cp 4: 共通だけの名前をKNOWNとし鍵の違いと顧客の廃止を分類する', () => {
    const index = call('buildPartnerNameIndex_', [call('customerPartnerRecords_', [rawPartners(['架空廃止'], 'RETIRED')]),
      'CP001', ['テストディオン', '架空廃止', '', {partnerId: 'CP_EMPTY', partnerName: ''}]]);
    assert.equal(call('classifyPartnerName_', [index, 'テストディオン']).kind, 'KNOWN');
    assert.equal(call('classifyPartnerName_', [index, 'テストデイオン']).kind, 'VARIANT');
    assert.equal(call('classifyPartnerName_', [index, '架空廃止']).kind, 'RETIRED');
  });
  test('cp 5: 候補は共通と顧客別を一回で読み廃止名を除く', () => {
    setup(); common('テストディオン'); common('架空廃止'); partner('架空廃止', 'RETIRED'); partner('架空顧客先');
    const reads = []; const real = gas.context.sheetsReadRanges_;
    gas.context.sheetsReadRanges_ = function(item, ranges) { reads.push([...ranges]); return real(item, ranges); };
    let result; try { result = call('webAppPartnerNames', ['CP001']); } finally { gas.context.sheetsReadRanges_ = real; }
    assert.deepEqual(result.active.map((item) => item.name).sort(), ['テストディオン', '架空顧客先'].sort());
    assert.equal(result.active.find((item) => item.name === 'テストディオン').key, call('partnerNameKey_', ['テストディオン']));
    const masters = reads.filter((ranges) => ranges.some((range) => range.includes('顧客別取引先一覧')));
    assert.equal(masters.length, 1); assert.ok(masters[0].some((range) => range.includes('共通取引先一覧')));
  });
  test('cp 6: Web共通確定は共通一覧と辞書だけへ書き重複を足さない', () => {
    setup(); const item = review();
    assert.equal(web([item], ['架空共通先']).resolved, 1);
    assert.equal(rows('共通取引先一覧').length, 1); assert.equal(rows('共通取引先辞書').length, 1);
    assert.equal(rows('共通取引先辞書')[0][6], ''); assert.equal(rows('共通取引先辞書')[0][11], actor);
    assert.equal(rows('顧客別取引先一覧').length, 0); assert.equal(rows('顧客別取引先辞書').length, 0);
    web([item], ['架空共通先']);
    assert.equal(web([review()], ['架空共通先']).resolved, 1);
    assert.equal(rows('共通取引先辞書').length, 1); assert.equal(rows('共通取引先一覧').length, 1);
    const audits = rows('監査ログ').filter((row) => ['DICT', 'PARTNER'].includes(row[6]) && row[2] === 'APPROVE');
    assert.equal(audits.length, 2); assert.ok(audits.every((row) => JSON.parse(row[10]).scope === 'COMMON'));
  });
  test('cp 7: CUSTOMERと省略と不正なscopeは共通へ書かない', () => {
    for (const scope of ['CUSTOMER', undefined, 'invalid']) {
      setup(); const item = review(); const before = [rows('共通取引先一覧'), rows('共通取引先辞書')];
      assert.equal(web([item], ['架空顧客先'], scope).resolved, 1);
      assert.equal(rows('顧客別取引先一覧').length, 1); assert.equal(rows('顧客別取引先辞書').length, 1);
      assert.deepEqual([rows('共通取引先一覧'), rows('共通取引先辞書')], before);
      assert.equal(rows('監査ログ').filter((row) => JSON.parse(row[10] || '{}').scope === 'COMMON').length, 0);
    }
  });
  test('cp 8: 共通既存名は重ねず顧客だけの名と混在scopeの名は共通へ登録する', () => {
    setup(); common('架空既存先'); partner('架空顧客先');
    const items = [review('架空店甲'), review('架空店乙'), review('架空店丙')];
    const result = batch(items, ['架空既存先', '架空顧客先', '架空顧客先'], ['COMMON', 'CUSTOMER', 'COMMON']);
    assert.deepEqual(result.errors, []); assert.equal(rows('共通取引先一覧').length, 2);
    assert.equal(rows('顧客別取引先一覧').length, 1);
    setup();
    assert.deepEqual(batch([review('架空店丁'), review('架空店戊')], ['架空混在先', '架空混在先'],
      ['CUSTOMER', 'COMMON']).errors, []);
    assert.equal(rows('顧客別取引先一覧').length, 0); assert.equal(rows('共通取引先一覧').length, 1);
  });
  test('cp 8b: 共通でも学ばない件は名前だけ登録し別ファイルの混在scopeでも顧客一覧を増やさない', () => {
    setup();
    assert.equal(web([review('')], ['架空空店先']).resolved, 1);
    assert.equal(rows('共通取引先一覧').length, 1); assert.equal(rows('共通取引先辞書').length, 0);
    setup();
    const first = review('架空同店', 'cp-file-a'); const second = review('架空同店', 'cp-file-b');
    const result = call('webAppResolveReviews', ['CP001', [
      {reviewId: first.reviewId, partnerName: '架空先甲', scope: 'COMMON', sameMerchantConflict: true},
      {reviewId: second.reviewId, partnerName: '架空先乙', scope: 'COMMON', sameMerchantConflict: true}
    ], {}]);
    assert.equal(result.resolved, 2); assert.equal(rows('共通取引先一覧').length, 2);
    assert.equal(rows('共通取引先辞書').length, 0);
    setup();
    const customerItem = review('架空店甲', 'cp-file-a'); const commonItem = review('架空店乙', 'cp-file-b');
    assert.equal(call('webAppResolveReviews', ['CP001', [
      {reviewId: customerItem.reviewId, partnerName: '架空混在先', scope: 'CUSTOMER'},
      {reviewId: commonItem.reviewId, partnerName: '架空混在先', scope: 'COMMON'}
    ], {}]).resolved, 2);
    assert.equal(rows('共通取引先一覧').length, 1); assert.equal(rows('顧客別取引先一覧').length, 0);
    assert.equal(rows('共通取引先辞書').length, 1); assert.equal(rows('顧客別取引先辞書').length, 1);
  });
  test('cp 9: 共通の食い違いはリース前に無書込で失敗し顧客別なら確定できる', () => {
    setup(); const item = review(); dictionary(item.merchantOriginal, '架空先甲', {common: true}); common('架空先甲');
    const before = snapshot(); const failed = batch([item], ['架空先乙']);
    assert.equal(failed.errors[0].code, 'COMMON_DICTIONARY_DIFFERENT_PARTNER');
    assert.ok(failed.errors[0].message.includes('架空先甲')); assert.ok(failed.errors[0].message.includes('架空先乙'));
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(batch([item], ['架空先乙'], 'CUSTOMER').errors, []);
    assert.equal(rows('顧客別取引先辞書')[0][3], '架空先乙'); assert.equal(rows('共通取引先辞書').length, 1);
    assert.deepEqual(batch([review()], ['架空先甲']).errors, []); assert.equal(rows('共通取引先辞書').length, 1);
  });
  test('cp 9b: 共通学習はロック内で古い読み覚えを使わず後着の食い違いに書かない', () => {
    setup();
    gas.call('beginRunScopedReads_');
    try {
      assert.deepEqual(call('readDictionary_', [true]), []);
      // 他の確定が先に書いた状態を作り、実行中の写しは空のまま残す。
      dictionary('架空後着店', '架空先甲', {common: true});
      const before = snapshot();
      assert.throws(() => gas.call('learnCommonFromResolutionBatch', [[{
        original: '架空後着店', normalized: call('normalizeMerchant', ['架空後着店']), partnerName: '架空先乙'
      }], actor]));
      assert.deepEqual(snapshot(), before);
    } finally {
      gas.call('endRunScopedReads_');
    }
  });
  test('cp 9c: 食い違いは元表記だけでも正規化表記だけでも止まり無効行は妨げない', () => {
    for (const originalOnly of [true, false]) {
      setup(); const item = review('架空食違店');
      dictionary(originalOnly ? item.merchantOriginal : '架空別表記店', '架空先甲',
        {common: true, cells: {2: originalOnly ? '架空別正規化店' : item.merchantNormalized}});
      const before = snapshot(); const result = batch([item], ['架空先乙']);
      assert.equal(result.errors[0].code, 'COMMON_DICTIONARY_DIFFERENT_PARTNER');
      assert.deepEqual(snapshot(), before);
    }
    setup(); const item = review('架空食違店');
    dictionary(item.merchantOriginal, '架空先甲', {common: true, cells: {14: false}});
    assert.deepEqual(batch([item], ['架空先乙']).errors, []);
    assert.equal(rows('共通取引先辞書').filter((row) => row[14] === true).length, 1);
  });
  test('cp 10: 同じ押下の別ファイルが学んだ共通の食い違いを止める', () => {
    setup(); const items = [review('架空同店', 'cp-file-a'), review('架空同店', 'cp-file-b')];
    const result = web(items, ['架空先甲', '架空先乙']);
    assert.equal(result.resolved, 1);
    assert.equal(result.errors.find((error) => error.reviewId === items[1].reviewId).code, 'COMMON_DICTIONARY_DIFFERENT_PARTNER');
    assert.equal(rows('共通取引先辞書').length, 1);
  });
  test('cp 11: 二ファイルの押下は共通の材料を冒頭の一回に束ねる', () => {
    setup(); common('架空既存先'); dictionary('架空同店', '架空既存先', {common: true});
    const items = [review('架空同店', 'cp-file-a'), review('架空同店', 'cp-file-b')];
    const reads = []; const real = gas.context.sheetsReadRanges_;
    gas.context.sheetsReadRanges_ = function(item, ranges) { reads.push([...ranges]); return real(item, ranges); };
    let result; try { result = web(items, ['架空既存先', '架空既存先']); } finally { gas.context.sheetsReadRanges_ = real; }
    assert.equal(result.resolved, 2);
    const list = reads.filter((ranges) => ranges.some((range) => range.includes('共通取引先一覧')));
    assert.equal(list.length, 1); assert.ok(list[0].some((range) => range.includes('顧客別取引先一覧')));
    assert.ok(list[0].some((range) => range.includes('共通取引先辞書')));
    // 学習時のロック内読取を除き、各ファイルの番人は冒頭の写しを使う。
    assert.equal(reads.filter((ranges) => ranges.some((range) => range.includes('共通取引先辞書'))).length, 3);
  });
  test('cp 12: 単件もscopeを守り共通との食い違いはCatalogErrorで無書込', () => {
    for (const scope of ['COMMON', 'CUSTOMER', undefined]) {
      setup(); const item = review();
      gas.call('resolveReview', [item.reviewId, 'ADOPT_EXISTING_PARTNER', {partnerName: '架空単件先', learn: true, scope}]);
      assert.equal(rows(scope === 'COMMON' ? '共通取引先辞書' : '顧客別取引先辞書').length, 1);
      assert.equal(rows(scope === 'COMMON' ? '共通取引先一覧' : '顧客別取引先一覧').length, 1);
    }
    setup(); const item = review(); dictionary(item.merchantOriginal, '架空先甲', {common: true});
    const before = snapshot();
    assert.throws(() => gas.call('resolveReview', [item.reviewId, 'ADOPT_EXISTING_PARTNER',
      {partnerName: '架空先乙', scope: 'COMMON'}]), (error) => error.name === 'CatalogError' && error.code === 'COMMON_DICTIONARY_DIFFERENT_PARTNER');
    assert.deepEqual(snapshot(), before);
  });
  test('cp 13: 運用シートは顧客別のままで共通名をKNOWNとし廃止を止める', () => {
    setup(); const items = [review('架空運用店甲'), review('架空運用店乙'), review('架空運用店丙')];
    common('架空共通先'); common('架空廃止先'); partner('架空廃止先', 'RETIRED');
    gas.call('opsListPartnerReviews');
    const decisions = sheet('取引先判断（運用）');
    const names = ['架空新規先', '架空共通先', '架空廃止先'];
    items.forEach((item, index) => {
      const row = decisions.getDataRange().getValues().findIndex((values) => values[1] === item.merchantOriginal);
      decisions.getRange(row + 1, 6).setValue(names[index]);
    });
    const commonBefore = [rows('共通取引先一覧'), rows('共通取引先辞書')];
    const result = call('opsApplyPartnerDecisions');
    assert.equal(result.resolvedReviews, 2); assert.equal(result.errors, 1);
    assert.deepEqual([rows('共通取引先一覧'), rows('共通取引先辞書')], commonBefore);
    assert.deepEqual(rows('顧客別取引先一覧').filter((row) => row[3] === 'ACTIVE').map((row) => row[2]), ['架空新規先']);
    assert.equal(rows('顧客別取引先辞書').length, 2);
    assert.equal(call('getReviewById', [items[2].reviewId]).status, 'OPEN');
    assert.ok(result.results.find((item) => item.partner === '架空廃止先').error.includes('使わない取引先名'));
    assert.equal(call('knownPartnerNames_', [call('getCustomerById', ['CP001'])])['架空共通先'], true);
  });

  function copySeed() {
    setup();
    for (const name of ['架空写す先', '架空別先', '架空共通先', 'テストデイオン', '架空ディ店', '架空デイ店',
      '架空廃止先', '取引先不明', '（不要）']) partner(name);
    partner('架空廃止先', 'RETIRED'); common('架空共通先'); common('テストディオン');
    dictionary('架空写す店', '架空写す先'); dictionary('架空写す店', '架空写す先');
    dictionary('架空無効店', '架空写す先', {cells: {14: false}});
    dictionary('架空競合店', '架空写す先', {cells: {15: true}});
    dictionary('架空前方店', '架空写す先', {cells: {4: 'prefix'}});
    dictionary('架空期間店', '架空写す先', {cells: {7: '2026-01-01'}});
    dictionary('架空廃止店', '架空廃止先'); dictionary('架空未登録店', '架空未登録先');
    dictionary('架空割れる店', '架空写す先'); dictionary('架空割れる店', '架空別先');
    dictionary('架空食違店', '架空別先'); dictionary('架空食違店', '架空共通先', {common: true});
    dictionary('架空既存店', '架空共通先'); dictionary('架空既存店', '架空共通先', {common: true});
  }
  test('cp 14: 写す関数は既定とtrue以外で数と例だけを返し監査にも書かない', () => {
    copySeed();
    for (const apply of [undefined, false, 'true', 1]) {
      const before = snapshot(); const result = call('opsCopyPartnersToCommon', ['CP001', apply]);
      assert.equal(result.apply, false); assert.equal(result.names.copy, 2); assert.equal(result.dictionary.copy, 1);
      assert.deepEqual(result.written, {names: 0, dictionary: 0}); assert.deepEqual(snapshot(), before);
      assert.ok(Object.values(result.examples).every((items) => items.length <= 20));
    }
  });
  test('cp 15: 写す関数は全除外理由と行の形と元IDの監査を守り二回目はゼロ', () => {
    copySeed(); const source = rows('顧客別取引先辞書').find((row) => row[1] === '架空写す店');
    const result = call('opsCopyPartnersToCommon', ['CP001', true]);
    assert.deepEqual(result.names, {copy: 2, already: 1, variantOfCommon: 1, variantWithinCustomer: 2});
    assert.deepEqual(result.dictionary, {copy: 1, already: 1, duplicate: 1, conflictFlag: 1,
      patternRule: 1, period: 1, partnerNotCopied: 2, splitPartner: 2, differentInCommon: 1});
    assert.deepEqual(result.written, {names: 2, dictionary: 1});
    const copied = rows('共通取引先辞書').find((row) => row[1] === '架空写す店');
    assert.notEqual(copied[0], source[0]); assert.equal(copied[6], ''); assert.equal(copied[11], actor);
    assert.equal(copied[10], source[10]); assert.equal(copied[9], source[9]);
    const copiedRow = sheet('共通取引先辞書').getDataRange().getValues().findIndex((row) => row[0] === copied[0]) + 1;
    assert.equal(sheet('共通取引先辞書').getRange(copiedRow, 1, 1, 18).getValues()[0].length, 18);
    const audits = rows('監査ログ').filter((row) => row[11] === 'COPY_TO_COMMON');
    assert.equal(audits.length, 3); assert.ok(audits.every((row) => row[2] === 'APPROVE'));
    const copiedAudit = JSON.parse(audits.find((row) => row[6] === 'DICT')[10]);
    assert.equal(copiedAudit.sourceCustomerId, 'CP001'); assert.equal(copiedAudit.sourceDictId, source[0]);
    const again = call('opsCopyPartnersToCommon', ['CP001', true]);
    assert.equal(again.names.copy, 0); assert.equal(again.dictionary.copy, 0);
  });
  test('cp 15b: 架空1125名と3700辞書行をまとめてコピーし元データと読取回数を守る', () => {
    setup();
    const names = Array.from({length: 1125}, (_, i) => '架空取引先' + String(i).padStart(4, '0'));
    const nameRows = names.map((name, i) => ['CP_BULK_P_' + i, 'CP001', name, 'ACTIVE', '', '', actor, '', '', '']);
    const dictionaryRows = Array.from({length: 3700}, (_, i) => {
      const merchant = '架空店舗' + String(i).padStart(4, '0');
      return ['CP_BULK_D_' + i, merchant, merchant, names[i % names.length],
        i % 2 ? 'exact_original' : 'exact_normalized', i % 2 ? 0 : '', 'CP001', '', '',
        i % 2 === 0, actor, '', '', 1, true, false, '', ''];
    });
    for (const [name, values, width] of [['顧客別取引先一覧', nameRows, 10], ['顧客別取引先辞書', dictionaryRows, 18]]) {
      const target = sheet(name);
      if (target.getMaxRows() < values.length + 1) target.insertRowsAfter(target.getMaxRows(), values.length + 1 - target.getMaxRows());
      target.getRange(2, 1, values.length, width).setValues(values);
    }
    gas.stubs.resetApiCallCounts();
    const started = Date.now(); const result = call('opsCopyPartnersToCommon', ['CP001', true]);
    const counts = gas.stubs.getApiCallCounts();
    console.log('CP15_BULK ' + JSON.stringify({ms: Date.now() - started, reads: counts.batchGet, writes: counts.batchUpdate}));
    assert.deepEqual(result.written, {names: 1125, dictionary: 3700});
    assert.ok(counts.batchGet <= 8, 'コピーの読取は行数に依らない');
    assert.ok(counts.batchUpdate < 100, 'コピーの書込は行ごとに行わない');
    assert.deepEqual(sheet('顧客別取引先一覧').getRange(2, 1, 1125, 10).getValues(), nameRows);
    assert.deepEqual(sheet('顧客別取引先辞書').getRange(2, 1, 3700, 18).getValues(), dictionaryRows);
    assert.equal(rows('監査ログ').filter((row) => row[11] === 'COPY_TO_COMMON').length, 4825);
  });
  test('cp 16: コピーは別顧客の辞書一致と名前一致を可能にし元顧客のSTEP1を変えない', () => {
    setup(); partner('テストディオン'); dictionary('架空写す店', 'テストディオン');
    const customerRules = call('readDictionary_', [false]);
    const before = match('架空写す店', call('readCustomerPartnerRows_'), [], customerRules);
    call('opsCopyPartnersToCommon', ['CP001', true]);
    const commonRules = call('readDictionary_', [true]); const commonNames = call('readCommonPartners_');
    const index = call('buildDictionaryIndex', ['CP002', {customer: [], common: commonRules, commonPartners: commonNames, partnerList: []}]);
    const dictionaryMatch = call('matchPartner', [{merchantOriginal: '架空写す店'}, 'CP002', index]);
    assert.equal(dictionaryMatch.autoConfirm, true); assert.ok(['STEP3', 'STEP4'].includes(dictionaryMatch.matchedBy));
    assert.equal(call('matchPartner', [{merchantOriginal: 'テストデイオン'}, 'CP002', index]).autoConfirm, true);
    assert.deepEqual(match('架空写す店', call('readCustomerPartnerRows_'), commonNames, customerRules, commonRules), before);
  });
  test('cp 17: コピーは共通に同じ正規化で異なる取引先を作らない', () => {
    setup(); partner('架空先乙'); common('架空先甲'); dictionary('架空同店', '架空先甲', {common: true});
    dictionary('架空同店', '架空先乙'); const before = rows('共通取引先辞書');
    const result = call('opsCopyPartnersToCommon', ['CP001', true]);
    assert.equal(result.dictionary.differentInCommon, 1); assert.equal(result.dictionary.copy, 0);
    assert.deepEqual(rows('共通取引先辞書'), before);
  });
};

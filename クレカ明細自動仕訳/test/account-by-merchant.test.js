'use strict';

/**
 * 店名で相手科目コード（C 列）を決める（`work/spec_account_by_merchant.md`
 * §5 の mca 1〜10）。
 *
 * 値はすべて架空である。実在の明細の店名・金額は使わない
 * （`ｍａｊｉｃａチャージ` は規則そのものなので使う）。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const blank = (n) => Array(n).fill('');
  const call = (name, args = []) => gas.call(name, args);
  const master = (name) => gas.stubs.getSpreadsheet('master').getSheetByName(name);
  const destSheet = (id = 'dest1') => gas.stubs.getSpreadsheet(id).getSheetByName('入力用シート');

  const RULE_MERCHANT = 'ｍａｊｉｃａチャージ';

  function priorityCell(word) {
    if (word.priority === undefined) return '';
    return word.priority === true ? true : (word.priority === false ? '' : word.priority);
  }

  function activeCell(word) {
    return word.active === undefined ? true : word.active;
  }

  function setupMaster() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    call('setMasterSpreadsheetId', ['master']);
    call('provisionMasterSheets', []);
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createSpreadsheet('snap', {sheets: []});
    gas.evaluate(`
      SETTINGS.EXECUTION_TIMEOUT_SECONDS = 300;
      SETTINGS.SAFETY_MARGIN_SECONDS = 60;
      SETTINGS.TX_INDEX_SPREADSHEET_ID = 'txidx';
      SETTINGS.SNAPSHOT_SPREADSHEET_ID = 'snap';
      SETTINGS.SAMPLE_CORPUS_FOLDER_ID = 'corpus';
      SETTINGS.PARALLEL_WORK_FOLDER_ID = '';
      SETTINGS.FAULT_INJECTION = null;
    `);
    gas.stubs.setActiveUser('tester@example.com');
  }

  function addAccounts(accounts) {
    const sheet = master('勘定科目一覧');
    accounts.forEach((account) => {
      const active = account.length > 3 ? account[3] : true;
      sheet.appendRow([account[0], account[1], account[2], active, '']);
    });
  }

  function addWords(words) {
    const sheet = master('用途科目辞書');
    words.forEach((word) => sheet.appendRow([word.word, word.code, word.category || '共通',
      word.customerId || '', priorityCell(word), activeCell(word),
      '', '', '']));
  }

  function formatRow(cardNameRule) {
    const row = blank(37);
    Object.assign(row, {
      0: 'mca_fake_format', 1: '架空形式', 2: 'active', 3: true, 4: '["csv"]',
      5: JSON.stringify({allOf: [{maxRow: 1, keywords: ['利用日', '利用店名', '金額', '使用用途'], minMatch: 4}]}),
      6: 1, 7: 2, 8: 'A', 9: 'B', 10: 'C', 11: 'D',
      14: JSON.stringify({excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []}),
      16: JSON.stringify({sources: [{id: 'fn', kind: 'fileName', pattern: '(20\\d{2})(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}]}),
      17: 'generic', 18: 1, 19: 'tester@example.com', 21: '2026-01-01T00:00:00+09:00',
      29: 'NEW', 33: '2026-01-01T00:00:00+09:00'
    });
    if (cardNameRule) row[34] = JSON.stringify(cardNameRule);
    return row;
  }

  function addDictionary(merchants) {
    const sheet = master('共通取引先辞書');
    merchants.forEach((merchant, index) => {
      const row = blank(18);
      Object.assign(row, {
        0: 'MCA_DICT_' + index, 1: merchant, 2: call('normalizeMerchant', [merchant]),
        3: '架空取引先', 4: 'exact_original', 5: 1, 9: true, 10: 'tester@example.com',
        12: '2026-01-01', 13: 1, 14: true, 15: false
      });
      sheet.appendRow(row);
    });
  }

  function setupWorld(options = {}) {
    setupMaster();
    const destinationId = options.destinationId || 'dest1';
    const header = blank(15);
    Object.assign(header, {1: '利用日', 2: '相手科目コード', 3: '相手勘定科目',
      5: '取引先', 6: '相手税区分', 8: 'メモ', 10: '摘要', 11: '借方', 12: '貸方', 14: '取引ID'});
    const values = [blank(15), blank(15), header, Object.assign(blank(15), {0: '区切り'}), blank(15)];
    const list = options.sheetEntries || [];
    list.forEach((entry, index) => {
      values[4 + index] = values[4 + index] || blank(15);
      const row = values[4 + index];
      row[16] = entry[0];
      row[17] = entry[1];
    });
    gas.stubs.createSpreadsheet(destinationId, {sheets: [
      {name: '入力用シート', values: values, maxRows: 30, maxColumns: 30},
      {name: '取引先一覧', values: [['元店名', '取引先名']]}
    ]});
    gas.stubs.createFolder('parent', {fileIds: [destinationId]});
    gas.stubs.createFolder('folder1', {fileIds: []});
    master('カード形式マスター').appendRow(formatRow(options.cardNameRule));
    if (options.accounts !== false) addAccounts(options.accounts || []);
    if (options.words) addWords(options.words);
    if (options.dictionary) addDictionary(options.dictionary);
    const config = {
      customerId: options.customerId || 'C001', customerName: '架空顧客',
      sourceFolderId: 'folder1', destinationSpreadsheetId: destinationId,
      destinationSheetName: '入力用シート', partnerListSheetName: '取引先一覧',
      headerRow: 3, dataStartRow: 5, rowScanLastColumn: 15,
      customerCategory: options.category || 'CORPORATE',
      columns: Object.assign({B: 2, F: 6, G: 7, I: 9, K: 11, L: 12, M: 13, txId: 15},
        options.accountColumn === false ? {} : {C: 3}),
      reviewers: 'tester@example.com', admins: 'tester@example.com'
    };
    if (options.category === 'INDIVIDUAL') config.fiscalYear = 2026;
    if (options.accountColumn !== false) config.accountListRange = options.listRange || 'Q5:R12';
    if (options.partnerExemptPurposes) config.partnerExemptPurposes = options.partnerExemptPurposes;
    if (options.cardNamePartnerPurposes) config.cardNamePartnerPurposes = options.cardNamePartnerPurposes;
    if (options.cashbackMerchants) config.cashbackMerchants = options.cashbackMerchants;
    call('registerTestCustomer', [config]);
    const registered = call('getCustomerById', [config.customerId]);
    const fileIds = [];
    function addFile(fileId, rows, name = '架空カード202601.csv') {
      const csv = ['利用日,利用店名,金額,使用用途'].concat(rows).join('\n');
      gas.stubs.createFile(fileId, {name: name, bytes: Buffer.from(csv, 'utf8'),
        contentType: 'text/csv', lastUpdated: new Date(Date.now() - 3600000),
        createdTime: '2026-08-01T00:00:00Z'});
      fileIds.push(fileId);
      gas.stubs.createFolder('folder1', {fileIds: fileIds.slice()});
    }
    return {customer: registered, destinationId: destinationId, addFile: addFile};
  }

  function importReport(world) {
    const report = plain(call('runImport', [{}]));
    assert.equal(report.stoppedBy, null, JSON.stringify(report));
    return report;
  }

  function transactionsFor(fileId) {
    return call('getTransactionsForFile_', [fileId])
      .sort((a, b) => a.sourceRow - b.sourceRow);
  }

  function cell(row, column, id = 'dest1') {
    return destSheet(id).getRange(row, column).getValue();
  }

  function partnerReviews(tx) {
    return call('openReviews', [{fullTxId: tx.fullTxId}])
      .filter((review) => review.reviewType === 'PARTNER');
  }

  // ---------------- mca 1: 個人の店名の規則 ----------------
  test('mca 1: 個人は店名で 294、取引先を立てず、ほかの行は今どおり', () => {
    const world = setupWorld({category: 'INDIVIDUAL',
      accounts: [[712, '仕入高', '共通'], [294, '事業主貸', '個人だけ']],
      sheetEntries: [[712, '仕入高'], [294, '事業主貸']],
      dictionary: ['架空店舗A'], words: [{word: '仕入', code: 712}]});
    world.addFile('fileA', [
      '2026/01/10,' + RULE_MERCHANT + ',1000,チャージ',
      '2026/01/11,架空店舗A,2000,仕入れ',
      '2026/01/12,架空店舗B,3000,謎用途'
    ]);
    const report = importReport(world);
    const file = report.customers[0].files[0];
    assert.equal(file.outcome, 'WRITTEN', JSON.stringify(file));
    assert.deepEqual(file.accountCode, {missing: 1, noMatch: 1, ambiguous: 0,
      invalidEntry: 0, notInSheetList: 0});

    assert.equal(cell(5, 3), 294);
    assert.equal(cell(6, 3), 712);
    assert.equal(cell(7, 3), '');
    assert.equal(cell(5, 6), '');
    assert.equal(cell(6, 6), '架空取引先');

    const txs = transactionsFor('fileA');
    assert.equal(txs.length, 3);
    assert.equal(txs[0].partnerResolutionStatus, 'RESOLVED_WITHOUT_PARTNER');
    assert.equal(txs[1].partnerResolutionStatus, 'RESOLVED_WITH_PARTNER');
    assert.equal(txs[2].partnerResolutionStatus, 'UNRESOLVED');
    assert.equal(txs[0].planned.c, 294);
    assert.equal(txs[0].verified.c, 294);
    assert.equal(partnerReviews(txs[0]).length, 0);
    assert.equal(partnerReviews(txs[2]).length, 1);
  });

  // ---------------- mca 2: 法人の店名の規則と一覧への書き足し ----------------
  test('mca 2: 法人は 362。一覧に無ければ空いた行へ足して C を書く', () => {
    const world = setupWorld({category: 'CORPORATE',
      accounts: [[712, '仕入高', '共通'], [294, '事業主貸', '個人だけ'],
        [362, '役員借入金', '法人だけ']],
      sheetEntries: [[712, '仕入高']], listRange: 'Q5:R12'});
    world.addFile('fileA', ['2026/01/10,' + RULE_MERCHANT + ',1000,チャージ']);
    const listWrites = [];
    gas.stubs.onValuesBatchUpdate((request, spreadsheetId) => {
      (request.data || []).forEach((data) => {
        if (String(spreadsheetId) === 'dest1' && String(data.range).indexOf("'入力用シート'!Q") === 0) {
          listWrites.push({range: data.range, values: plain(data.values)});
        }
      });
    });
    let report;
    try { report = importReport(world); }
    finally { gas.stubs.onValuesBatchUpdate(null); }

    const file = report.customers[0].files[0];
    assert.equal(file.outcome, 'WRITTEN', JSON.stringify(file));
    assert.deepEqual(file.accountCode, {missing: 0, noMatch: 0, ambiguous: 0,
      invalidEntry: 0, notInSheetList: 0, listAdded: [{code: 362, name: '役員借入金'}]});
    assert.deepEqual(listWrites, [{
      range: "'入力用シート'!Q6:R6", values: [[362, '役員借入金']]}]);
    assert.equal(cell(5, 3), 362);
    assert.equal(cell(5, 6), '');

    const txs = transactionsFor('fileA');
    assert.equal(txs.length, 1);
    assert.equal(txs[0].partnerResolutionStatus, 'RESOLVED_WITHOUT_PARTNER');
    assert.equal(txs[0].planned.c, 362);
    assert.equal(txs[0].verified.c, 362);
    assert.equal(partnerReviews(txs[0]).length, 0);
  });

  // ---------------- mca 3: 鍵の揺れと、当たらない店名 ----------------
  test('mca 3: 店名の全体が同じときだけ当たり、含む・前方一致では当たらない', () => {
    const rule = call('merchantAccountRule_', [RULE_MERCHANT]);
    assert.equal(rule.merchant, RULE_MERCHANT);
    for (const name of ['ｍａｊｉｃａチャージ', 'majica チャージ', 'ＭＡＪＩＣＡ　チャージ',
      'ｍａｊｉｃａ チャージ', 'ＭＡＪＩＣＡチャージ']) {
      assert.equal(call('merchantAccountRule_', [name]), rule, name);
    }
    for (const name of ['ｍａｊｉｃａチャージ返金', 'ｍａｊｉｃａ', 'マジカチャージ', '']) {
      assert.equal(call('merchantAccountRule_', [name]), null, name);
    }

    const world = setupWorld({category: 'INDIVIDUAL',
      accounts: [[712, '仕入高', '共通'], [294, '事業主貸', '個人だけ']],
      sheetEntries: [[712, '仕入高'], [294, '事業主貸']]});
    world.addFile('fileA', [
      '2026/01/10,ｍａｊｉｃａチャージ,1000,チャージ',
      '2026/01/11,majica チャージ,1100,チャージ',
      '2026/01/12,ＭＡＪＩＣＡ　チャージ,1200,チャージ',
      '2026/01/13,ｍａｊｉｃａ チャージ,1300,チャージ',
      '2026/01/14,ｍａｊｉｃａチャージ返金,1400,チャージ',
      '2026/01/15,ｍａｊｉｃａ,1500,チャージ',
      '2026/01/16,マジカチャージ,1600,チャージ'
    ]);
    const report = importReport(world);
    assert.equal(report.customers[0].files[0].outcome, 'WRITTEN',
      JSON.stringify(report.customers[0].files[0]));
    for (const row of [5, 6, 7, 8]) assert.equal(cell(row, 3), 294, 'row ' + row);
    for (const row of [9, 10, 11]) assert.equal(cell(row, 3), '', 'row ' + row);
  });

  // ---------------- mca 4: 用途の言葉より規則が先 ----------------
  test('mca 4: 用途が仕入・私用 仕入・ツール代でも、店名が当たれば 294', () => {
    const world = setupWorld({category: 'INDIVIDUAL',
      accounts: [[712, '仕入高', '共通'], [843, '通信費', '共通'], [294, '事業主貸', '個人だけ']],
      sheetEntries: [[712, '仕入高'], [843, '通信費'], [294, '事業主貸']],
      words: [{word: '仕入', code: 712}, {word: 'ツール代', code: 843},
        {word: '私用', code: 294, category: '個人だけ', priority: true}]});
    world.addFile('fileA', [
      '2026/01/10,' + RULE_MERCHANT + ',1000,仕入',
      '2026/01/11,' + RULE_MERCHANT + ',2000,私用 仕入',
      '2026/01/12,' + RULE_MERCHANT + ',3000,ツール代'
    ]);
    const report = importReport(world);
    assert.equal(report.customers[0].files[0].outcome, 'WRITTEN',
      JSON.stringify(report.customers[0].files[0]));
    for (const row of [5, 6, 7]) assert.equal(cell(row, 3), 294, 'row ' + row);
    for (const tx of transactionsFor('fileA')) {
      assert.equal(tx.planned.c, 294);
      assert.equal(tx.partnerResolutionStatus, 'RESOLVED_WITHOUT_PARTNER');
    }
  });

  // ---------------- mca 5: 科目一覧に書けない 294 ----------------
  test('mca 5: 294 が無い・無効・対象が違うときは C を書かず、それでも取引先を立てない', () => {
    const cases = [
      {label: '294 が無い', accounts: [[712, '仕入高', '共通']]},
      {label: '有効が FALSE', accounts: [[712, '仕入高', '共通'], [294, '事業主貸', '個人だけ', false]]},
      {label: '対象が法人だけ', accounts: [[712, '仕入高', '共通'], [294, '事業主貸', '法人だけ']]}
    ];
    for (const item of cases) {
      const world = setupWorld({category: 'INDIVIDUAL', accounts: item.accounts,
        sheetEntries: [[712, '仕入高'], [294, '事業主貸']]});
      world.addFile('fileA', ['2026/01/10,' + RULE_MERCHANT + ',1000,チャージ']);
      const report = importReport(world);
      const file = report.customers[0].files[0];
      assert.equal(file.outcome, 'WRITTEN', item.label + ' ' + JSON.stringify(file));
      assert.deepEqual(file.accountCode, {missing: 1, noMatch: 0, ambiguous: 0,
        invalidEntry: 1, notInSheetList: 0}, item.label);
      assert.equal(cell(5, 3), '', item.label);
      assert.equal(cell(5, 6), '', item.label);
      const txs = transactionsFor('fileA');
      assert.equal(txs.length, 1, item.label);
      assert.equal(txs[0].partnerResolutionStatus, 'RESOLVED_WITHOUT_PARTNER', item.label);
      assert.equal(txs[0].planned.c, undefined, item.label);
      assert.equal(partnerReviews(txs[0]).length, 0, item.label);
    }
  });

  // ---------------- mca 6: 一覧のぶつかる行 ----------------
  test('mca 6: 一覧で 294 が別の科目名なら C を書かず、取引先も立てない', () => {
    const world = setupWorld({category: 'INDIVIDUAL',
      accounts: [[712, '仕入高', '共通'], [294, '事業主貸', '個人だけ']],
      sheetEntries: [[294, '架空の別科目'], [712, '仕入高']]});
    world.addFile('fileA', ['2026/01/10,' + RULE_MERCHANT + ',1000,チャージ']);
    const report = importReport(world);
    const file = report.customers[0].files[0];
    assert.equal(file.outcome, 'WRITTEN', JSON.stringify(file));
    assert.deepEqual(file.accountCode, {missing: 1, noMatch: 0, ambiguous: 0,
      invalidEntry: 0, notInSheetList: 1});
    assert.equal(cell(5, 3), '');
    assert.equal(cell(5, 6), '');
    const txs = transactionsFor('fileA');
    assert.equal(txs.length, 1);
    assert.equal(txs[0].partnerResolutionStatus, 'RESOLVED_WITHOUT_PARTNER');
    assert.equal(partnerReviews(txs[0]).length, 0);
  });

  // ---------------- mca 7: C の列が無い顧客 ----------------
  test('mca 7: C の列が無い顧客は、規則に当たる店名でも今と同じ', () => {
    const results = [];
    for (const merchant of [RULE_MERCHANT, '架空店舗Z']) {
      const world = setupWorld({accountColumn: false,
        accounts: [[712, '仕入高', '共通'], [294, '事業主貸', '個人だけ']]});
      world.addFile('fileA', ['2026/01/10,' + merchant + ',1000,チャージ']);
      const accountCodeRanges = [];
      gas.stubs.onValuesBatchUpdate((request, spreadsheetId) => {
        if (String(spreadsheetId) !== 'dest1') return;
        (request.data || []).forEach((data) => {
          if (!/![A-Z]*C[0-9]+:[A-Z]*C[0-9]+$/.test(String(data.range))) return;
          accountCodeRanges.push(data.range);
        });
      });
      gas.stubs.resetApiCallCounts();
      let report;
      try { report = importReport(world); }
      finally { gas.stubs.onValuesBatchUpdate(null); }
      const counts = gas.stubs.getApiCallCounts();
      const txs = transactionsFor('fileA');
      results.push({merchant: merchant, batchGet: counts.batchGet,
        batchUpdate: counts.batchUpdate, accountCodeRanges: accountCodeRanges,
        accountCode: report.customers[0].files[0].accountCode,
        destination: plain(destSheet().getRange(5, 1, 1, 15).getValues()[0]),
        status: txs[0].partnerResolutionStatus, reviews: partnerReviews(txs[0]).length});
    }
    assert.equal(results[0].batchGet, results[1].batchGet);
    assert.equal(results[0].batchUpdate, results[1].batchUpdate);
    assert.deepEqual(results[0].accountCodeRanges, []);
    assert.deepEqual(results[1].accountCodeRanges, []);
    assert.equal(results[0].accountCode, undefined);
    assert.equal(results[1].accountCode, undefined);
    assert.equal(results[0].destination[2], '');
    assert.equal(results[1].destination[2], '');
    assert.equal(results[0].status, 'UNRESOLVED');
    assert.equal(results[1].status, 'UNRESOLVED');
    assert.equal(results[0].reviews, 1);
    assert.equal(results[1].reviews, 1);
  });

  // ---------------- mca 8: 読取・書込の回数 ----------------
  test('mca 8: 規則に当たる行があっても、読取・書込の回数は今と同じ', () => {
    const results = [];
    for (const merchant of [RULE_MERCHANT, '架空店舗B']) {
      const world = setupWorld({category: 'INDIVIDUAL',
        accounts: [[294, '事業主貸', '個人だけ'], [712, '仕入高', '共通']],
        sheetEntries: [[294, '事業主貸'], [712, '仕入高']],
        dictionary: [RULE_MERCHANT, '架空店舗B']});
      world.addFile('fileA', ['2026/01/10,' + merchant + ',1000,チャージ']);
      gas.stubs.resetApiCallCounts();
      const report = importReport(world);
      results.push({merchant: merchant, counts: gas.stubs.getApiCallCounts(),
        outcome: report.customers[0].files[0].outcome, c: cell(5, 3)});
    }
    assert.equal(results[0].outcome, 'WRITTEN');
    assert.equal(results[1].outcome, 'WRITTEN');
    assert.equal(results[0].c, 294);
    assert.equal(results[1].c, '');
    assert.equal(results[0].counts.batchGet, results[1].counts.batchGet,
      JSON.stringify(results));
    assert.equal(results[0].counts.batchUpdate, results[1].counts.batchUpdate,
      JSON.stringify(results));
  });

  // ---------------- mca 9: 規則の表 ----------------
  test('mca 9: 規則の鍵は重ならず、区分のコードは種の対象と合う', () => {
    const rules = plain(gas.evaluate('MERCHANT_ACCOUNT_RULES_'));
    const seeds = plain(gas.evaluate('ACCOUNT_SEED_ACCOUNTS_'));
    assert.ok(rules.length > 0);
    const seed294 = seeds.filter((seed) => seed.code === 294);
    const seed362 = seeds.filter((seed) => seed.code === 362);
    assert.equal(seed294.length, 1);
    assert.equal(seed362.length, 1);
    assert.equal(seed294[0].category, '個人だけ');
    assert.equal(seed362[0].category, '法人だけ');
    const keys = rules.map((rule) => call('usageWordKey_', [rule.merchant]));
    assert.equal(new Set(keys).size, keys.length, '鍵が重ならない');
    for (const rule of rules) {
      assert.ok(rule.merchant, 'merchant がある');
      assert.equal(rule.withoutPartner, true);
      assert.equal(Number.isInteger(rule.codes.INDIVIDUAL), true);
      assert.equal(Number.isInteger(rule.codes.CORPORATE), true);
      const individual = seeds.filter((seed) => seed.code === rule.codes.INDIVIDUAL);
      const corporate = seeds.filter((seed) => seed.code === rule.codes.CORPORATE);
      assert.equal(individual.length, 1);
      assert.equal(corporate.length, 1);
      assert.equal(individual[0].category, '個人だけ');
      assert.equal(corporate[0].category, '法人だけ');
    }
  });

  // ---------------- mca 10: 返金・AM・AN は今どおり ----------------
  test('mca 10: 返金（AO）・AM の用途・AN の用途は、規則に当たらない店名で今どおり', () => {
    const world = setupWorld({category: 'CORPORATE',
      accounts: [[712, '仕入高', '共通'], [859, '諸会費', '共通']],
      sheetEntries: [[712, '仕入高'], [859, '諸会費']],
      dictionary: ['架空カード'],
      words: [{word: '仕入', code: 712}, {word: '年会費', code: 859}],
      cashbackMerchants: ['架空返金店'],
      partnerExemptPurposes: ['仕入'],
      cardNamePartnerPurposes: ['年会費'],
      cardNameRule: {sources: [{kind: 'fileName', pattern: '^(架空カード)', group: 1}]}});
    world.addFile('fileA', [
      '2026/01/10,架空返金店,1000,仕入',
      '2026/01/11,架空店舗M,2000,仕入',
      '2026/01/12,架空店舗N,3000,年会費'
    ]);
    const report = importReport(world);
    assert.equal(report.customers[0].files[0].outcome, 'WRITTEN',
      JSON.stringify(report.customers[0].files[0]));

    assert.equal(cell(5, 3), 712);
    assert.equal(cell(6, 3), 712);
    assert.equal(cell(7, 3), 859);
    assert.equal(cell(5, 6), '');
    assert.equal(cell(6, 6), '');
    assert.equal(cell(7, 6), '架空取引先');
    assert.equal(cell(5, 7), '対象外');
    assert.equal(cell(6, 7), '');

    const txs = transactionsFor('fileA');
    assert.equal(txs.length, 3);
    assert.equal(txs[0].partnerResolutionStatus, 'RESOLVED_WITHOUT_PARTNER');
    assert.equal(txs[1].partnerResolutionStatus, 'RESOLVED_WITHOUT_PARTNER');
    assert.equal(txs[2].partnerResolutionStatus, 'RESOLVED_WITH_PARTNER');
    for (const tx of txs) assert.equal(partnerReviews(tx).length, 0);
  });
};

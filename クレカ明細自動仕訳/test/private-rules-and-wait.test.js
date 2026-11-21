'use strict';

/**
 * 私用と同じ扱いの言葉・店名と、優先の言葉で科目が決まる行の取引先、
 * 取込の待ち（`work/spec_private_rules_and_wait.md` §10 の pvr 1〜15）。
 *
 * 値はすべて架空である。仕様に出る言葉・店名は規則そのものなので使う。
 * 実在の明細の店名・金額・顧客 ID は使わない。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const blank = (n) => Array(n).fill('');
  const call = (name, args = []) => gas.call(name, args);
  const evaluate = (expression) => gas.evaluate(expression);
  const master = (name) => gas.stubs.getSpreadsheet('master').getSheetByName(name);
  const destSheet = (id = 'dest1') => gas.stubs.getSpreadsheet(id).getSheetByName('入力用シート');

  const MARK_HEADERS = ['取引先名', '印', '顧客ID', '有効', '登録日時', '登録者', 'メモ'];
  const FLAG_HEADERS = ['顧客ID', '少額特例を使えない', '更新日時', '更新者', 'メモ'];

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

  function addSeedAccounts() {
    addAccounts(plain(evaluate('ACCOUNT_SEED_ACCOUNTS_')).map((account) => [
      account.code, account.name, account.category, true, '']));
  }

  function addWords(words) {
    const sheet = master('用途科目辞書');
    words.forEach((word) => sheet.appendRow([word.word, word.code, word.category || '共通',
      word.customerId || '', priorityCell(word), activeCell(word), '', '', '']));
  }

  function addSeedWords(extraWords) {
    addWords(plain(evaluate('ACCOUNT_SEED_WORDS_')).concat(extraWords || []));
  }

  function formatRow(cardNameRule) {
    const row = blank(37);
    Object.assign(row, {
      0: 'pvr_fake_format', 1: '架空形式', 2: 'active', 3: true, 4: '["csv"]',
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

  function addDictionary(entries) {
    const sheet = master('共通取引先辞書');
    entries.forEach((entry, index) => {
      const merchant = Array.isArray(entry) ? entry[0] : entry;
      const partner = Array.isArray(entry) ? entry[1] : '架空取引先';
      const row = blank(18);
      Object.assign(row, {
        0: 'PVR_DICT_' + index, 1: merchant, 2: call('normalizeMerchant', [merchant]),
        3: partner, 4: 'exact_original', 5: 1, 9: true, 10: 'tester@example.com',
        12: '2026-01-01', 13: 1, 14: true, 15: false
      });
      sheet.appendRow(row);
    });
  }

  function addTaxTabs(taxTabs) {
    if (!taxTabs) return;
    const spreadsheet = gas.stubs.getSpreadsheet('master');
    spreadsheet.insertSheet('取引先の税の印', {values: [
      MARK_HEADERS.slice()].concat(taxTabs.marks || [])});
    spreadsheet.insertSheet('顧客の税の設定', {values: [
      FLAG_HEADERS.slice()].concat(taxTabs.flags || [])});
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
    if (options.seedAccounts) addSeedAccounts();
    else if (options.accounts !== false) addAccounts(options.accounts || []);
    if (options.seedWords) addSeedWords(options.extraWords);
    else if (options.words) addWords(options.words);
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
    call('registerTestCustomer', [config]);
    const registered = call('getCustomerById', [config.customerId]);
    addTaxTabs(options.taxTabs);
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

  /** 種の 2 つの表から、`resolveAccountCode_` に渡す材料を作る（純粋な関数）。 */
  function seedMasters(extraWords) {
    const accounts = plain(evaluate('ACCOUNT_SEED_ACCOUNTS_')).map((account) => [
      account.code, account.name, account.category, true, '']);
    const words = plain(evaluate('ACCOUNT_SEED_WORDS_')).map((word) => [
      word.word, word.code, word.category, '', priorityCell(word), true, '', '', '']);
    (extraWords || []).forEach((word) => {
      words.push([word.word, word.code, word.category || '共通', word.customerId || '',
        priorityCell(word), activeCell(word), '', '', '']);
    });
    return call('accountMastersFromValues_', [accounts, words]);
  }

  function withoutAccount(masters, code) {
    return {accounts: masters.accounts.filter((row) => row.code !== code), words: masters.words};
  }

  function sheetList(rows) {
    return call('accountSheetListFromValues_', [rows, 'Q5:R12']);
  }

  const ACCOUNT_HEADERS = [[294, '事業主貸'], [712, '仕入高']];

  // ---------------- pvr 1: 私的利用 ----------------
  test('pvr 1: 個人の私的利用は 294・取引先なし・税は対象外', () => {
    const world = setupWorld({category: 'INDIVIDUAL', seedAccounts: true, seedWords: true,
      sheetEntries: [[712, '仕入高'], [294, '事業主貸']],
      taxTabs: {marks: [], flags: []}});
    world.addFile('fileA', ['2026/01/10,架空店舗A,1500,私的利用']);
    const report = importReport(world);
    assert.equal(report.customers[0].files[0].outcome, 'WRITTEN',
      JSON.stringify(report.customers[0].files[0]));
    assert.equal(cell(5, 3), 294);
    assert.equal(cell(5, 6), '');
    assert.equal(cell(5, 7), '対象外');
    const txs = transactionsFor('fileA');
    assert.equal(txs.length, 1);
    assert.equal(txs[0].partnerResolutionStatus, 'RESOLVED_WITHOUT_PARTNER');
    assert.equal(txs[0].planned.c, 294);
    assert.equal(txs[0].verified.c, 294);
    assert.equal(partnerReviews(txs[0]).length, 0);
  });

  // ---------------- pvr 2: 投資信託・金券系の言葉 ----------------
  test('pvr 2: 投資信託・金券系は個人 294・法人 362 で取引先なし、ギフトだけは当たらない', () => {
    const matching = ['投資信託', '投資信託購入', '金券', 'Amazonギフトカード', 'ギフト券',
      '商品券', 'ＱＵＯカード', 'quoカード', 'クオカード'];
    const notMatching = ['ギフト', '贈答用ギフト'];
    for (const category of ['INDIVIDUAL', 'CORPORATE']) {
      const expected = category === 'INDIVIDUAL' ? 294 : 362;
      const world = setupWorld({category: category, seedAccounts: true, seedWords: true,
        sheetEntries: [[294, '事業主貸'], [362, '役員借入金'], [712, '仕入高']],
        dictionary: [['架空店舗B', '架空取引先B']]});
      world.addFile('fileA', matching.map((purpose, index) =>
        '2026/01/' + String(10 + index).padStart(2, '0') + ',架空店舗B,' + (1000 + index) + ',' + purpose)
        .concat(notMatching.map((purpose, index) =>
          '2026/01/' + String(25 + index).padStart(2, '0') + ',架空店舗B,' + (2000 + index) + ',' + purpose)));
      const report = importReport(world);
      assert.equal(report.customers[0].files[0].outcome, 'WRITTEN',
        category + ' ' + JSON.stringify(report.customers[0].files[0]));
      const txs = transactionsFor('fileA');
      assert.equal(txs.length, matching.length + notMatching.length);
      matching.forEach((purpose, index) => {
        const row = 5 + index;
        assert.equal(cell(row, 3), expected, category + ' ' + purpose);
        assert.equal(cell(row, 6), '', category + ' ' + purpose);
        assert.equal(txs[index].partnerResolutionStatus, 'RESOLVED_WITHOUT_PARTNER',
          category + ' ' + purpose);
        assert.equal(partnerReviews(txs[index]).length, 0, category + ' ' + purpose);
      });
      notMatching.forEach((purpose, index) => {
        const row = 5 + matching.length + index;
        assert.equal(cell(row, 3), '', category + ' ' + purpose);
        assert.equal(cell(row, 6), '架空取引先B', category + ' ' + purpose);
        assert.equal(txs[matching.length + index].partnerResolutionStatus,
          'RESOLVED_WITH_PARTNER', category + ' ' + purpose);
      });
    }
  });

  // ---------------- pvr 3: 梱包は取引先を照合する ----------------
  test('pvr 3: 発送用梱包材は 852 で、優先でないので取引先を照合し G は今の決まりどおり', () => {
    const world = setupWorld({category: 'CORPORATE', seedAccounts: true, seedWords: true,
      sheetEntries: [[712, '仕入高'], [852, '消耗品費']],
      dictionary: [['架空フリマ店', '架空フリマ取引先']],
      taxTabs: {marks: [['架空フリマ取引先', 'フリマ', '', '', '', '', '']], flags: []}});
    world.addFile('fileA', ['2026/11/05,架空フリマ店,12000,発送用梱包材'], '架空カード202611.csv');
    const report = importReport(world);
    assert.equal(report.customers[0].files[0].outcome, 'WRITTEN',
      JSON.stringify(report.customers[0].files[0]));
    assert.equal(cell(5, 3), 852);
    assert.equal(cell(5, 6), '架空フリマ取引先');
    assert.equal(cell(5, 7), '課対仕入（控70）10%');
    const txs = transactionsFor('fileA');
    assert.equal(txs.length, 1);
    assert.equal(txs[0].partnerResolutionStatus, 'RESOLVED_WITH_PARTNER');
    assert.equal(partnerReviews(txs[0]).length, 0);
  });

  // ---------------- pvr 4: 金券系は仕入れに譲る ----------------
  test('pvr 4: 金券系と仕入れは 712 で取引先を照合し、金券だけなら 294・362 で取引先なし', () => {
    const yielded = ['金券ショップで仕入', '商品券 仕入代', 'クオカード 商品代', 'ＱＵＯカード 材料費'];
    const kept = ['金券 送料', '金券 消耗品', '金券', '私用 金券 仕入', '私用 仕入', '投資信託 仕入'];
    for (const category of ['INDIVIDUAL', 'CORPORATE']) {
      const expected = category === 'INDIVIDUAL' ? 294 : 362;
      const world = setupWorld({category: category, seedAccounts: true, seedWords: true,
        sheetEntries: [[294, '事業主貸'], [362, '役員借入金'], [712, '仕入高'],
          [854, '荷造運賃'], [852, '消耗品費']],
        dictionary: [['架空店舗C', '架空取引先C']]});
      world.addFile('fileA', yielded.map((purpose, index) =>
        '2026/01/' + String(10 + index).padStart(2, '0') + ',架空店舗C,' + (1000 + index) + ',' + purpose)
        .concat(kept.map((purpose, index) =>
          '2026/01/' + String(20 + index).padStart(2, '0') + ',架空店舗C,' + (2000 + index) + ',' + purpose)));
      const report = importReport(world);
      assert.equal(report.customers[0].files[0].outcome, 'WRITTEN',
        category + ' ' + JSON.stringify(report.customers[0].files[0]));
      const txs = transactionsFor('fileA');
      yielded.forEach((purpose, index) => {
        const row = 5 + index;
        assert.equal(cell(row, 3), 712, category + ' ' + purpose);
        assert.equal(cell(row, 6), '架空取引先C', category + ' ' + purpose);
        assert.equal(txs[index].partnerResolutionStatus, 'RESOLVED_WITH_PARTNER',
          category + ' ' + purpose);
      });
      kept.forEach((purpose, index) => {
        const row = 5 + yielded.length + index;
        assert.equal(cell(row, 3), expected, category + ' ' + purpose);
        assert.equal(cell(row, 6), '', category + ' ' + purpose);
        assert.equal(txs[yielded.length + index].partnerResolutionStatus,
          'RESOLVED_WITHOUT_PARTNER', category + ' ' + purpose);
      });
    }

    // 顧客別の同じ鍵の行が 2 つ（別のコード）なら AMBIGUOUS。取引先は照合する。
    const ambiguous = setupWorld({category: 'INDIVIDUAL', customerId: 'C777', seedAccounts: true,
      seedWords: true, extraWords: [
        {word: '金券', code: 294, category: '個人だけ', customerId: 'C777', priority: true},
        {word: '金券', code: 712, category: '共通', customerId: 'C777', priority: true}],
      sheetEntries: [[294, '事業主貸'], [712, '仕入高']],
      dictionary: [['架空店舗D', '架空取引先D']]});
    ambiguous.addFile('fileA', ['2026/01/10,架空店舗D,1000,金券']);
    const report = importReport(ambiguous);
    assert.equal(report.customers[0].files[0].outcome, 'WRITTEN',
      JSON.stringify(report.customers[0].files[0]));
    assert.deepEqual(plain(report.customers[0].files[0].accountCode),
      {missing: 1, noMatch: 0, ambiguous: 1, invalidEntry: 0, notInSheetList: 0});
    assert.equal(cell(5, 3), '');
    assert.equal(cell(5, 6), '架空取引先D');
    const txs = transactionsFor('fileA');
    assert.equal(txs[0].partnerResolutionStatus, 'RESOLVED_WITH_PARTNER');
    assert.equal(cell(5, 6), '架空取引先D');
  });

  // ---------------- pvr 5: resolveAccountCode_ の priority ----------------
  test('pvr 5: priority は優先の言葉で 1 つに決まったときだけ付き、今ある欄は変えない', () => {
    const individual = {customerId: 'C9001', customerCategory: 'INDIVIDUAL'};
    const masters = seedMasters();
    const resolve = (purpose, customer, list, table) =>
      call('resolveAccountCode_', [purpose, customer || individual, table || masters,
        list === undefined ? sheetList(ACCOUNT_HEADERS) : list]);
    const hasPriority = (result) => Object.prototype.hasOwnProperty.call(result, 'priority');

    const matched = resolve('私用');
    assert.deepEqual(plain(matched),
      {status: 'MATCHED', code: 294, word: '私用', priority: true});

    const ordinary = resolve('仕入');
    assert.deepEqual(plain(ordinary), {status: 'MATCHED', code: 712, word: '仕入'});
    assert.equal(hasPriority(ordinary), false);

    const noMatch = resolve('謎用途');
    assert.deepEqual(plain(noMatch), {status: 'NO_MATCH', code: null, word: null});
    assert.equal(hasPriority(noMatch), false);

    const brokenScoped = seedMasters([{word: '私用', code: 294, category: '個人だけ',
      customerId: 'C9001', priority: 'maybe'}]);
    const invalid = resolve('私用', individual, undefined, brokenScoped);
    assert.deepEqual(plain(invalid), {status: 'INVALID_ENTRY', code: null, word: null});
    assert.equal(hasPriority(invalid), false);

    const ambiguousRows = seedMasters([
      {word: '金券', code: 294, category: '個人だけ', customerId: 'C9001', priority: true},
      {word: '金券', code: 712, category: '共通', customerId: 'C9001', priority: true}]);
    const ambiguous = resolve('金券', individual, undefined, ambiguousRows);
    assert.deepEqual(plain(ambiguous), {status: 'AMBIGUOUS', code: null, word: null});
    assert.equal(hasPriority(ambiguous), false);

    const noCost = resolve('私用', individual, undefined, withoutAccount(masters, 294));
    assert.equal(noCost.status, 'INVALID_ENTRY');
    assert.equal(noCost.code, null);
    assert.equal(noCost.priority, true);

    const needsEntry = resolve('私用', individual, sheetList([[712, '仕入高']]));
    assert.deepEqual(plain(needsEntry), {status: 'NEEDS_LIST_ENTRY', code: 294,
      word: '私用', name: '事業主貸', priority: true});

    const notInList = resolve('私用', individual,
      sheetList([[294, '架空の別科目'], [712, '仕入高']]));
    assert.deepEqual(plain(notInList), {status: 'NOT_IN_SHEET_LIST', code: null,
      word: null, priority: true});

    const yielded = resolve('金券ショップで仕入');
    assert.deepEqual(plain(yielded), {status: 'MATCHED', code: 712, word: '仕入'});
    assert.equal(hasPriority(yielded), false);

    const kept = resolve('金券 消耗品');
    assert.deepEqual(plain(kept),
      {status: 'MATCHED', code: 294, word: '金券', priority: true});

    const privateWins = resolve('私用 金券 仕入');
    assert.deepEqual(plain(privateWins),
      {status: 'MATCHED', code: 294, word: '私用', priority: true});
  });

  // ---------------- pvr 6: C が書けなくても取引先を立てない ----------------
  test('pvr 6: NOT_IN_SHEET_LIST と書き足しでも取引先を立てず、用途の当たりは 1 取引 1 回', () => {
    // 一覧で 294 が別の科目名（C は書けない）。
    const conflict = setupWorld({category: 'INDIVIDUAL', seedAccounts: true, seedWords: true,
      sheetEntries: [[294, '架空の別科目'], [712, '仕入高']],
      dictionary: [['架空店舗E', '架空取引先E']]});
    conflict.addFile('fileA', [
      '2026/01/10,架空店舗E,1000,私用',
      '2026/01/11,楽天キャッシュ　チャージ,2000,仕入',
      '2026/01/12,架空店舗E,3000,仕入'
    ]);
    const realResolve = gas.context.resolveAccountCode_;
    let calls = 0;
    gas.context.resolveAccountCode_ = function() {
      calls += 1;
      return realResolve.apply(null, arguments);
    };
    let report;
    try { report = importReport(conflict); }
    finally { gas.context.resolveAccountCode_ = realResolve; }
    assert.equal(report.customers[0].files[0].outcome, 'WRITTEN',
      JSON.stringify(report.customers[0].files[0]));
    assert.deepEqual(plain(report.customers[0].files[0].accountCode),
      {missing: 2, noMatch: 0, ambiguous: 0, invalidEntry: 0, notInSheetList: 2});
    assert.equal(calls, 2, '店名の規則の行は用途の言葉を引かない（1 取引 1 回まで）');
    assert.equal(cell(5, 3), '');
    assert.equal(cell(5, 6), '');
    const txs = transactionsFor('fileA');
    assert.equal(txs[0].partnerResolutionStatus, 'RESOLVED_WITHOUT_PARTNER');
    assert.equal(partnerReviews(txs[0]).length, 0);
    assert.equal(cell(6, 6), '', '店名の規則の行も取引先なし');

    // 一覧に 294 の行が無い（書き足して C を書く）。
    const adding = setupWorld({category: 'INDIVIDUAL', seedAccounts: true, seedWords: true,
      sheetEntries: [[712, '仕入高']],
      dictionary: [['架空店舗F', '架空取引先F']]});
    adding.addFile('fileA', ['2026/01/10,架空店舗F,1000,私用']);
    const listWrites = [];
    gas.stubs.onValuesBatchUpdate((request, spreadsheetId) => {
      (request.data || []).forEach((data) => {
        if (String(spreadsheetId) === 'dest1' &&
            String(data.range).indexOf("'入力用シート'!Q") === 0) {
          listWrites.push({range: data.range, values: plain(data.values)});
        }
      });
    });
    let added;
    try { added = importReport(adding); }
    finally { gas.stubs.onValuesBatchUpdate(null); }
    assert.deepEqual(plain(added.customers[0].files[0].accountCode).listAdded,
      [{code: 294, name: '事業主貸'}]);
    assert.deepEqual(listWrites, [{range: "'入力用シート'!Q6:R6",
      values: [[294, '事業主貸']]}]);
    assert.equal(cell(5, 3), 294);
    assert.equal(cell(5, 6), '');
    const addedTx = transactionsFor('fileA');
    assert.equal(addedTx[0].partnerResolutionStatus, 'RESOLVED_WITHOUT_PARTNER');
    assert.equal(partnerReviews(addedTx[0]).length, 0);
  });

  // ---------------- pvr 7: 楽天キャッシュ チャージ ----------------
  test('pvr 7: 楽天キャッシュ　チャージは 294・362 で取引先なし、揺れは当たり、部分一致は当たらない', () => {
    const RULE = '楽天キャッシュ　チャージ';
    const hits = [RULE, '楽天キャッシュチャージ', '楽天キャッシュ チャージ',
      '楽天ｷｬｯｼｭ　ﾁｬｰｼﾞ'];
    const misses = ['楽天キャッシュ', '楽天キャッシュ　チャージ返金', '楽天ペイ'];
    const rule = call('merchantAccountRule_', [RULE]);
    assert.equal(rule.merchant, RULE);
    assert.equal(rule.withoutPartner, true);
    for (const name of hits) assert.equal(call('merchantAccountRule_', [name]), rule, name);
    for (const name of misses) assert.equal(call('merchantAccountRule_', [name]), null, name);

    const rules = plain(evaluate('MERCHANT_ACCOUNT_RULES_'));
    const keys = rules.map((item) => call('usageWordKey_', [item.merchant]));
    assert.equal(new Set(keys).size, keys.length, '規則の鍵が重ならない');
    const seeds = plain(evaluate('ACCOUNT_SEED_ACCOUNTS_'));
    for (const item of rules) {
      assert.equal(item.withoutPartner, true);
      for (const [category, code] of [['INDIVIDUAL', item.codes.INDIVIDUAL],
        ['CORPORATE', item.codes.CORPORATE]]) {
        const seed = seeds.filter((row) => row.code === code);
        assert.equal(seed.length, 1, category + ' ' + code);
        assert.equal(seed[0].category,
          category === 'INDIVIDUAL' ? '個人だけ' : '法人だけ');
      }
    }

    for (const category of ['INDIVIDUAL', 'CORPORATE']) {
      const expected = category === 'INDIVIDUAL' ? 294 : 362;
      const world = setupWorld({category: category, seedAccounts: true, seedWords: true,
        sheetEntries: [[294, '事業主貸'], [362, '役員借入金']],
        dictionary: hits.concat(misses)});
      world.addFile('fileA', hits.map((name, index) =>
        '2026/01/' + String(10 + index).padStart(2, '0') + ',' + name + ',' + (1000 + index) + ',仕入')
        .concat(misses.map((name, index) =>
          '2026/01/' + String(20 + index).padStart(2, '0') + ',' + name + ',' + (2000 + index) + ',チャージ')));
      const report = importReport(world);
      assert.equal(report.customers[0].files[0].outcome, 'WRITTEN',
        category + ' ' + JSON.stringify(report.customers[0].files[0]));
      const txs = transactionsFor('fileA');
      hits.forEach((name, index) => {
        assert.equal(cell(5 + index, 3), expected, category + ' ' + name);
        assert.equal(cell(5 + index, 6), '', category + ' ' + name);
        assert.equal(txs[index].partnerResolutionStatus, 'RESOLVED_WITHOUT_PARTNER',
          category + ' ' + name);
      });
      misses.forEach((name, index) => {
        const row = 5 + hits.length + index;
        assert.equal(cell(row, 3), '', category + ' ' + name);
        assert.equal(cell(row, 6), '架空取引先', category + ' ' + name);
        assert.equal(txs[hits.length + index].partnerResolutionStatus,
          'RESOLVED_WITH_PARTNER', category + ' ' + name);
      });
    }
  });

  // ---------------- pvr 8: C の列が無い顧客 ----------------
  test('pvr 8: C の列が無い顧客は、pvr 1・2・7 の入力でも今と同じ', () => {
    const pairs = [
      ['私的利用', '謎用途'],
      ['金券', '謎用途'],
      ['楽天キャッシュ　チャージ', '架空店舗Z']
    ];
    for (const pair of pairs) {
      const results = [];
      for (const purpose of pair) {
        const merchant = purpose === '楽天キャッシュ　チャージ' ? purpose : '架空店舗Z';
        const world = setupWorld({accountColumn: false, seedAccounts: true, seedWords: true});
        world.addFile('fileA', ['2026/01/10,' + merchant + ',1000,' + purpose]);
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
        results.push({input: purpose, batchGet: counts.batchGet,
          batchUpdate: counts.batchUpdate, accountCodeRanges: accountCodeRanges,
          accountCode: report.customers[0].files[0].accountCode,
          destination: plain(destSheet().getRange(5, 1, 1, 15).getValues()[0]),
          status: txs[0].partnerResolutionStatus, reviews: partnerReviews(txs[0]).length});
      }
      assert.equal(results[0].batchGet, results[1].batchGet, JSON.stringify(results));
      assert.equal(results[0].batchUpdate, results[1].batchUpdate, JSON.stringify(results));
      for (const result of results) {
        assert.deepEqual(result.accountCodeRanges, [], result.input);
        assert.equal(result.accountCode, undefined, result.input);
        assert.equal(result.destination[2], '', result.input);
        assert.equal(result.status, 'UNRESOLVED', result.input);
        assert.equal(result.reviews, 1, result.input);
      }
    }
  });

  // ---------------- pvr 9: サプリ ----------------
  test('pvr 9: サプリは用途だけ・課対仕入だけに効き、酒と一緒なら決めない', () => {
    const world = setupWorld({category: 'INDIVIDUAL', seedAccounts: true, seedWords: true,
      sheetEntries: [[294, '事業主貸'], [852, '消耗品費']],
      taxTabs: {marks: [], flags: []}});
    world.addFile('fileA', [
      '2026/11/10,架空店舗G,3000,サプリ 消耗品',
      '2026/11/11,架空店舗G,3000,サプリメント 消耗品',
      '2026/11/12,架空店舗G,3000,サプリ 酒 消耗品',
      '2026/11/13,サプリ,3000,消耗品',
      '2026/11/14,架空店舗G,3000,私用 サプリ'
    ], '架空カード202611.csv');
    const report = importReport(world);
    assert.equal(report.customers[0].files[0].outcome, 'WRITTEN',
      JSON.stringify(report.customers[0].files[0]));
    assert.equal(cell(5, 3), 852);
    assert.equal(cell(5, 7), '課対仕入8%（軽）');
    assert.equal(cell(6, 3), 852);
    assert.equal(cell(6, 7), '課対仕入8%（軽）');
    assert.equal(cell(7, 3), 852);
    assert.equal(cell(7, 7), '', '酒と一緒なら決めない');
    assert.equal(cell(8, 3), 852);
    assert.equal(cell(8, 7), '課対仕入10%', '店名のサプリは見ない');
    assert.equal(cell(9, 3), 294);
    assert.equal(cell(9, 7), '対象外', '課対仕入でない科目には効かない');
  });

  // ---------------- pvr 10: 種 ----------------
  test('pvr 10: 種に足した 15 行があり、鍵と対象は重ならず、コードの対象も合う', () => {
    const seed = plain(evaluate('ACCOUNT_SEED_WORDS_'));
    assert.equal(seed.length, 99);
    const added = [{word: '梱包', code: 852, category: '共通', priority: false}];
    ['投資信託', '金券', 'ギフトカード', 'ギフト券', '商品券', 'QUOカード', 'クオカード']
      .forEach((word) => {
        added.push({word: word, code: 294, category: '個人だけ', priority: true});
        added.push({word: word, code: 362, category: '法人だけ', priority: true});
      });
    for (const row of added) {
      const found = seed.filter((item) => item.word === row.word && item.code === row.code &&
        item.category === row.category && item.priority === row.priority);
      assert.equal(found.length, 1, row.word + ' ' + row.category);
    }
    const keys = new Set();
    seed.forEach((row) => {
      const key = call('usageWordKey_', [row.word]) + '|' + row.category;
      assert.equal(keys.has(key), false, '鍵と対象が重ならない ' + row.word + ' ' + row.category);
      keys.add(key);
    });
    const accounts = plain(evaluate('ACCOUNT_SEED_ACCOUNTS_'));
    seed.forEach((row) => {
      const account = accounts.filter((item) => item.code === row.code);
      assert.equal(account.length, 1, '科目がある ' + row.word);
      assert.ok(account[0].category === '共通' || account[0].category === row.category,
        'コードの対象が合う ' + row.word);
    });
    assert.deepEqual(plain(evaluate('ACCOUNT_YIELD_TO_PURCHASE_WORDS_')),
      ['金券', 'ギフトカード', 'ギフト券', '商品券', 'QUOカード', 'クオカード']);
    assert.equal(evaluate('ACCOUNT_PURCHASE_CODE_'), 712);
  });

  // ---------------- 待ち（§6・pvr 11〜15） ----------------

  const SCAN_NOW_MS = Date.parse('2026-11-21T12:00:00+09:00');
  const minutesBefore = (minutes) => new Date(SCAN_NOW_MS - minutes * 60 * 1000);
  const spreadsheetMime = 'application/vnd.google-apps.spreadsheet';
  const shortcutMime = 'application/vnd.google-apps.shortcut';

  /** 走査の材料だけを作る（顧客とフォルダは pvr の世界のものを使う）。 */
  function scanWorld(files, indexStates, folderIds) {
    setupWorld({accounts: false});
    const ids = Object.keys(files);
    ids.forEach((fileId) => {
      gas.stubs.createFile(fileId, Object.assign({bytes: Buffer.from('a'),
        createdTime: '2026-08-01T00:00:00Z'}, files[fileId]));
    });
    gas.stubs.createFolder('folder1', {fileIds: folderIds || ids});
    const indexSheet = master('恒久ファイルインデックス');
    Object.keys(indexStates || {}).forEach((fileId) => {
      const row = blank(13);
      row[0] = fileId;
      row[1] = 'C001';
      row[2] = String(files[fileId].name || '');
      row[3] = indexStates[fileId];
      indexSheet.appendRow(row);
    });
  }

  function scannerCandidates() {
    const waiting = [];
    const candidates = plain(call('scanUnprocessedFiles',
      ['C001', {now: SCAN_NOW_MS, waiting: waiting}]));
    return {candidates: candidates, waiting: waiting};
  }

  function readyAtOf(file) {
    return file.lastUpdated.getTime() + 10 * 60 * 1000;
  }

  function iteratorOf(items) {
    let index = 0;
    return {hasNext: () => index < items.length, next: () => items[index++]};
  }

  function withMocks(overrides, fn) {
    const saved = {};
    Object.keys(overrides).forEach((name) => {
      saved[name] = gas.context[name];
      gas.context[name] = overrides[name];
    });
    try {
      return fn();
    } finally {
      Object.keys(saved).forEach((name) => { gas.context[name] = saved[name]; });
    }
  }

  // ---------------- pvr 11: 走査の待ち ----------------
  test('pvr 11: me が true のときだけ待ちを外し、ほかは今と同じく待つ', () => {
    const files = {
      mineRecent: {name: '架空_me.csv', lastUpdated: minutesBefore(2),
        lastModifyingUser: {me: true}},
      otherRecent: {name: '架空_other.csv', lastUpdated: minutesBefore(2),
        lastModifyingUser: {me: false}},
      missingRecent: {name: '架空_missing.csv', lastUpdated: minutesBefore(2)},
      emptyRecent: {name: '架空_empty.csv', lastUpdated: minutesBefore(2),
        lastModifyingUser: {}},
      nullRecent: {name: '架空_null.csv', lastUpdated: minutesBefore(2),
        lastModifyingUser: null},
      discRecent: {name: '架空_disc.csv', lastUpdated: minutesBefore(2),
        lastModifyingUser: {me: false}},
      oldMine: {name: '架空_old_me.csv', lastUpdated: minutesBefore(30),
        lastModifyingUser: {me: true}},
      oldOther: {name: '架空_old_other.csv', lastUpdated: minutesBefore(30),
        lastModifyingUser: {me: false}}
    };
    scanWorld(files, {discRecent: 'DISCOVERED'});
    const result = scannerCandidates();
    assert.deepEqual(result.candidates.map((item) => item.fileId).sort(),
      ['mineRecent', 'oldMine', 'oldOther'],
      'me が true の 10 分以内と、10 分より前は候補');
    assert.deepEqual(result.waiting.map((item) => item.fileId).sort(),
      ['discRecent', 'emptyRecent', 'missingRecent', 'nullRecent', 'otherRecent'],
      'me が true でない・欄が無い・null・{} は今と同じく待つ');
    const waitingById = {};
    result.waiting.forEach((item) => { waitingById[item.fileId] = item; });
    Object.keys(waitingById).forEach((fileId) => {
      assert.equal(Date.parse(waitingById[fileId].readyAt), readyAtOf(files[fileId]),
        fileId + ' の readyAt は今と同じ');
    });
    assert.equal(Object.prototype.hasOwnProperty.call(waitingById, 'mineRecent'), false,
      '待ちを外したファイルは waiting に入れない');
  });

  // ---------------- pvr 12: ショートカットは指す先で見る ----------------
  test('pvr 12: ショートカットは指す先の最後の更新者で決め、読めなければ待つ', () => {
    const files = {
      targetMine: {name: '架空の指す先A', contentType: spreadsheetMime,
        lastUpdated: minutesBefore(2), lastModifyingUser: {me: true}},
      targetOther: {name: '架空の指す先B', contentType: spreadsheetMime,
        lastUpdated: minutesBefore(2), lastModifyingUser: {me: false}},
      targetOld: {name: '架空の指す先C', contentType: spreadsheetMime,
        lastUpdated: minutesBefore(30), lastModifyingUser: {me: false}},
      shortcutMine: {name: '架空ショートカット1', contentType: shortcutMime,
        targetId: 'targetMine', targetMimeType: spreadsheetMime,
        lastUpdated: minutesBefore(30), lastModifyingUser: {me: false}},
      shortcutOwnOnly: {name: '架空ショートカット2', contentType: shortcutMime,
        targetId: 'targetOther', targetMimeType: spreadsheetMime,
        lastUpdated: minutesBefore(2), lastModifyingUser: {me: true}},
      shortcutUnreadable: {name: '架空ショートカット3', contentType: shortcutMime,
        targetId: 'missingTarget', targetMimeType: spreadsheetMime,
        lastUpdated: minutesBefore(2), lastModifyingUser: {me: true}},
      shortcutOld: {name: '架空ショートカット4', contentType: shortcutMime,
        targetId: 'targetOld', targetMimeType: spreadsheetMime,
        lastUpdated: minutesBefore(2), lastModifyingUser: {me: false}}
    };
    scanWorld(files, {}, ['shortcutMine', 'shortcutOwnOnly', 'shortcutUnreadable', 'shortcutOld']);
    const result = scannerCandidates();
    assert.deepEqual(result.candidates.map((item) => item.fileId).sort(),
      ['shortcutMine', 'shortcutOld'],
      '指す先が 10 分より前、または指す先の me が true なら候補');
    assert.deepEqual(result.waiting.map((item) => item.fileId).sort(),
      ['shortcutOwnOnly', 'shortcutUnreadable'],
      'ショートカット自身の me では外さず、指す先が読めないときも待つ');
    const waitingById = {};
    result.waiting.forEach((item) => { waitingById[item.fileId] = item; });
    assert.equal(Date.parse(waitingById.shortcutOwnOnly.readyAt),
      readyAtOf(files.targetOther), '待ちは指す先の日時で今と同じ');
    assert.equal(Date.parse(waitingById.shortcutUnreadable.readyAt),
      readyAtOf(files.shortcutUnreadable), '読めないときは自身の日時で今と同じ');
  });

  // ---------------- pvr 13: 走査の Drive の呼出し ----------------
  test('pvr 13: 走査の Drive の呼出しは増えず、fields に lastModifyingUser(me) が入る', () => {
    const files = {
      plainFile: {name: '架空_plain.csv', lastUpdated: minutesBefore(30),
        lastModifyingUser: {me: false}},
      targetMine: {name: '架空の指す先', contentType: spreadsheetMime,
        lastUpdated: minutesBefore(2), lastModifyingUser: {me: true}},
      shortcutMine: {name: '架空ショートカット', contentType: shortcutMime,
        targetId: 'targetMine', targetMimeType: spreadsheetMime,
        lastUpdated: minutesBefore(30), lastModifyingUser: {me: false}}
    };
    scanWorld(files, {}, ['plainFile', 'shortcutMine']);
    call('resetDriveScannerCallCount', []);
    const listRequests = [];
    const getRequests = [];
    const driveFiles = gas.context.Drive.Files;
    const originalList = driveFiles.list;
    const originalGet = driveFiles.get;
    driveFiles.list = function(request) {
      listRequests.push(request);
      return originalList.call(driveFiles, request);
    };
    driveFiles.get = function(fileId, request) {
      getRequests.push({fileId: String(fileId), request: request});
      return originalGet.call(driveFiles, fileId, request);
    };
    let candidates;
    try {
      candidates = plain(call('scanUnprocessedFiles', ['C001', {now: SCAN_NOW_MS}]));
    } finally {
      driveFiles.list = originalList;
      driveFiles.get = originalGet;
    }
    assert.deepEqual(candidates.map((item) => item.fileId).sort(),
      ['plainFile', 'shortcutMine']);
    assert.equal(listRequests.length, 1, 'フォルダ 1 つにつき 1 回（今と同じ）');
    assert.equal(getRequests.length, 1, 'ショートカット 1 本につき 1 回（今と同じ）');
    assert.equal(call('getDriveScannerCallCount', []), 2, 'Drive の呼出しは増えない');
    listRequests.forEach((request) => {
      assert.ok(String(request.fields).indexOf('lastModifyingUser(me)') >= 0, request.fields);
    });
    getRequests.forEach((request) => {
      assert.equal(request.fileId, 'targetMine');
      assert.ok(String(request.request.fields).indexOf('lastModifyingUser(me)') >= 0,
        request.request.fields);
    });
  });

  // ---------------- pvr 14: 画面の一覧 ----------------
  test('pvr 14: 画面の一覧は 10 分以内だけを 1 回ずつ見て、読めなければ待つ', () => {
    gas.stubs.reset();
    const nowMs = Date.now();
    const at = (minutes) => new Date(nowMs - minutes * 60 * 1000);
    const put = (fileId, options) => {
      gas.stubs.createFile(fileId, Object.assign({name: '架空_' + fileId + '.csv',
        bytes: Buffer.from('a'), createdTime: '2026-08-01T00:00:00Z'}, options));
      return gas.stubs.getFile(fileId);
    };
    const mine = put('f14_mine', {lastUpdated: at(2), lastModifyingUser: {me: true}});
    const other = put('f14_other', {lastUpdated: at(2), lastModifyingUser: {me: false}});
    const disc = put('f14_disc', {lastUpdated: at(2), lastModifyingUser: {me: true}});
    const old = put('f14_old', {lastUpdated: at(20), lastModifyingUser: {me: true}});
    const failing = put('f14_failing', {lastUpdated: at(2), lastModifyingUser: {me: true}});
    put('f14_target', {lastUpdated: at(2), lastModifyingUser: {me: true}});
    const shortcutMine = put('f14_shortcut_mine', {contentType: shortcutMime,
      targetId: 'f14_target', targetMimeType: spreadsheetMime,
      lastUpdated: at(30), lastModifyingUser: {me: false}});
    const shortcutUnreadable = put('f14_shortcut_unreadable', {contentType: shortcutMime,
      targetId: 'f14_missing_target', targetMimeType: spreadsheetMime,
      lastUpdated: at(2), lastModifyingUser: {me: true}});
    const calls = [];
    const driveFiles = gas.context.Drive.Files;
    const originalGet = driveFiles.get;
    driveFiles.get = function(fileId, request) {
      calls.push({fileId: String(fileId), request: request});
      if (String(fileId) === 'f14_failing') throw new Error('架空の Drive 障害');
      return originalGet.call(driveFiles, fileId, request);
    };
    let rows;
    try {
      rows = {
        mine: plain(call('webAppFolderFile_', [mine, {}, nowMs])),
        other: plain(call('webAppFolderFile_', [other, {}, nowMs])),
        disc: plain(call('webAppFolderFile_', [disc, {f14_disc: 'DISCOVERED'}, nowMs])),
        old: plain(call('webAppFolderFile_', [old, {}, nowMs])),
        shortcutMine: plain(call('webAppFolderFile_', [shortcutMine, {}, nowMs])),
        shortcutUnreadable: plain(call('webAppFolderFile_',
          [shortcutUnreadable, {}, nowMs]))
      };
      rows.failing = plain(call('webAppFolderFile_', [failing, {}, nowMs]));
    } finally {
      driveFiles.get = originalGet;
    }
    assert.equal(rows.mine.stateLabel, '取込可能');
    assert.equal(rows.mine.importable, true);
    assert.equal(rows.other.stateLabel, '取込待ち（あと 8 分）');
    assert.equal(rows.other.importable, false);
    assert.equal(rows.disc.stateLabel, '未処理（取込待ち） (DISCOVERED)');
    assert.equal(rows.disc.importable, true);
    assert.equal(rows.old.stateLabel, '取込可能');
    assert.equal(rows.shortcutMine.stateLabel, '取込可能',
      'ショートカットは指す先の me で待ちを外す');
    assert.equal(rows.shortcutUnreadable.stateLabel, '取込待ち（あと 8 分）',
      '指す先の日時が読めないときは Drive を呼ばずに待つ');
    assert.equal(rows.failing.stateLabel, '取込待ち（あと 8 分）',
      'Drive が読めないときは今のまま待つ');
    assert.deepEqual(calls.map((item) => item.fileId),
      ['f14_mine', 'f14_other', 'f14_disc', 'f14_target', 'f14_failing'],
      '10 分以内のファイルだけを 1 回ずつ（ショートカットは指す先）');
    calls.forEach((item) => {
      assert.equal(item.request.fields, 'lastModifyingUser(me)');
      assert.equal(item.request.supportsAllDrives, true);
    });
  });

  // ---------------- pvr 15: 再検査と復帰の待ち ----------------
  test('pvr 15: 再検査と復帰の waitMinutes も me が true なら 0、そうでなければ今の値', () => {
    gas.stubs.reset();
    const at = (minutes) => new Date(Date.now() - minutes * 60 * 1000);
    const put = (fileId, lastModifyingUser) => {
      gas.stubs.createFile(fileId, {name: '架空_' + fileId + '.csv', bytes: Buffer.from('a'),
        contentType: 'text/csv', lastUpdated: at(3.5), lastModifyingUser: lastModifyingUser,
        createdTime: '2026-08-01T00:00:00Z'});
      return gas.stubs.getFile(fileId);
    };
    const mine = put('f15_mine', {me: true});
    const other = put('f15_other', {me: false});

    function recheck(file) {
      return plain(withMocks({
        webAppAuthorizeCustomer_: () => ({scope: {userEmail: 'tester@example.com'},
          customer: {sourceFolderId: 'folder1'}}),
        webAppDirectChildFolder_: () => ({getFiles: () => iteratorOf([file])}),
        menuAssertNoLease_: () => {},
        getFileState: () => 'CUSTOMER_FIX_REQUIRED',
        rewindFileForReimportAudited_: () => {}
      }, () => call('webAppRecheckCustomerFixFile',
        ['C001', 'card14', String(file.getId())])));
    }

    function recover(file) {
      return plain(withMocks({
        authorize: () => ({userEmail: 'tester@example.com',
          customers: [{sourceFolderId: 'folder1'}]}),
        webAppDirectChildFolder_: () => ({getFiles: () => iteratorOf([file])}),
        permanentIndexRowsForScan_: () => [{fileId: String(file.getId()),
          customerId: 'C001', originalFileName: String(file.getName())}],
        getFileState: () => 'FAILED',
        activeLeases_: () => [],
        recoverStuckFile_: () => ({rewound: true, recovered: []})
      }, () => call('webAppRecoverStuckFile',
        ['C001', 'card14', String(file.getId())])));
    }

    const mineRecheck = recheck(mine);
    const otherRecheck = recheck(other);
    const mineRecover = recover(mine);
    const otherRecover = recover(other);
    assert.equal(mineRecheck.ok, true, JSON.stringify(mineRecheck));
    assert.equal(mineRecheck.waitMinutes, 0);
    assert.equal(otherRecheck.waitMinutes,
      call('webAppStableWaitMinutes_', [other.getLastUpdated().getTime(), Date.now()]));
    assert.ok(otherRecheck.waitMinutes > 0);
    assert.equal(mineRecover.ok, true, JSON.stringify(mineRecover));
    assert.equal(mineRecover.waitMinutes, 0);
    assert.equal(otherRecover.waitMinutes,
      call('webAppStableWaitMinutes_', [other.getLastUpdated().getTime(), Date.now()]));
    assert.ok(otherRecover.waitMinutes > 0);
  });
};

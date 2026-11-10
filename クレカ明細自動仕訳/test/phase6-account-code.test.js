'use strict';

/**
 * 相手科目コード（C 列）第 1 段（仕様 §17 の ac 1〜19）。
 *
 * 値はすべて架空である。実在の明細の店名・金額は使わない。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const blank = (n) => Array(n).fill('');
  const call = (name, args = []) => gas.call(name, args);
  const master = (name) => gas.stubs.getSpreadsheet('master').getSheetByName(name);
  const destSheet = (id = 'dest1') => gas.stubs.getSpreadsheet(id).getSheetByName('入力用シート');

  function mock(overrides, fn) {
    const saved = {};
    for (const key of Object.keys(overrides)) {
      saved[key] = gas.context[key];
      gas.context[key] = overrides[key];
    }
    try { return fn(); } finally { Object.assign(gas.context, saved); }
  }

  const ACCOUNTS = [
    [712, '仕入高', '共通'],
    [843, '通信費', '共通'],
    [842, '旅費交通費', '共通'],
    [294, '事業主貸', '個人だけ'],
    [362, '役員借入金', '法人だけ'],
    [858, '支払手数料', '共通'],
    [859, '諸会費', '共通'],
    [866, '地代家賃', '共通']
  ];

  function priorityCell(word) {
    if (word.priority === undefined) return '';
    return word.priority === true ? true : (word.priority === false ? '' : word.priority);
  }

  function activeCell(word) {
    return word.active === undefined ? true : word.active;
  }

  function mastersFrom(accounts, words) {
    return call('accountMastersFromValues_', [
      accounts.map((account) => [account[0], account[1], account[2], true, '']),
      words.map((word) => [word.word, word.code, word.category || '共通',
        word.customerId || '', priorityCell(word), activeCell(word), '', '', ''])
    ]);
  }

  function customer(overrides = {}) {
    return Object.assign({customerId: 'C001', customerName: '架空顧客',
      customerCategory: 'CORPORATE'}, overrides);
  }

  function sheetList(accounts) {
    const map = new Map();
    accounts.forEach((account) => map.set(account[0], account[1]));
    return map;
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
    accounts.forEach((account) => sheet.appendRow([account[0], account[1], account[2], true, '']));
  }

  function addWords(words) {
    const sheet = master('用途科目辞書');
    words.forEach((word) => sheet.appendRow([word.word, word.code, word.category || '共通',
      word.customerId || '', priorityCell(word), activeCell(word),
      '', '', '']));
  }

  function formatRow() {
    const row = blank(37);
    Object.assign(row, {
      0: 'ac_fake_format', 1: '架空形式', 2: 'active', 3: true, 4: '["csv"]',
      5: JSON.stringify({allOf: [{maxRow: 1, keywords: ['利用日', '利用店名', '金額', '使用用途'], minMatch: 4}]}),
      6: 1, 7: 2, 8: 'A', 9: 'B', 10: 'C', 11: 'D',
      14: JSON.stringify({excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []}),
      16: JSON.stringify({sources: [{id: 'fn', kind: 'fileName', pattern: '(20\\d{2})(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}]}),
      17: 'generic', 18: 1, 19: 'tester@example.com', 21: '2026-01-01T00:00:00+09:00',
      29: 'NEW', 33: '2026-01-01T00:00:00+09:00'
    });
    return row;
  }

  function addDictionary(merchants, known = true) {
    if (!known) return;
    const sheet = master('共通取引先辞書');
    merchants.forEach((merchant, index) => {
      const row = blank(18);
      Object.assign(row, {
        0: 'AC_DICT_' + index, 1: merchant, 2: call('normalizeMerchant', [merchant]),
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
      values[4 + index] = Object.assign(values[4 + index] || blank(15), {});
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
    master('カード形式マスター').appendRow(formatRow());
    if (options.accounts !== false) addAccounts(options.accounts === true || options.accounts === undefined ? ACCOUNTS : options.accounts);
    if (options.words) addWords(options.words);
    if (options.dictionary) addDictionary(options.dictionary, options.knownPartners !== false);
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
    if (options.accountColumn !== false) config.accountListRange = options.listRange || 'Q5:R12';
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
    function lease(fileId = 'lease-file') {
      gas.stubs.createFile(fileId, {name: '架空.csv', data: 'fake'});
      call('createOrUpdateProcessLog', ['RUN_LEASE', registered, {id: fileId, name: '架空.csv',
        binaryHash: 'b'.repeat(64), contentHash: 'c'.repeat(64), hashVersion: '3', state: 'WRITING'}]);
      return call('acquireLease', [registered.customerId, fileId, 'RUN_LEASE',
        'tester@example.com', 'PROCESS']);
    }
    return {customer: registered, destinationId: destinationId, addFile: addFile, lease: lease};
  }

  function importReport(world) {
    const report = plain(call('runImport', [{}]));
    assert.equal(report.stoppedBy, null, JSON.stringify(report));
    return report;
  }

  function transactionsFor(fileId, statuses) {
    return call('getTransactionsByStatus', [fileId, statuses]);
  }

  function cell(row, column, id = 'dest1') {
    return destSheet(id).getRange(row, column).getValue();
  }

  // ---------------- ac 1: 当て方 ----------------
  test('ac 1: 用途の当て方（位置・長さ・優先・顧客別・誤り）', () => {
    const words = [
      {word: '仕入', code: 712}, {word: 'スマホ', code: 843},
      {word: '高速', code: 842}, {word: '私用', code: 294, category: '個人だけ', priority: true},
      {word: '私用', code: 362, category: '法人だけ', priority: true},
      {word: '月額利用料', code: 866, priority: false},
      {word: '手数料', code: 858}, {word: '手数料', code: 859},
      {word: '専用語', code: 362, category: '法人だけ'},
      {word: '無効語', code: 712, active: false},
      {word: '高速', code: 842}, {word: '高速道路', code: 9999},
      {word: '謎語', code: 842, category: '謎'}
    ];
    const accounts = ACCOUNTS;
    const masters = mastersFrom(accounts, words);
    const list = sheetList(ACCOUNTS);
    const resolve = (purpose, c = customer()) => call('resolveAccountCode_', [purpose, c, masters, list]);

    assert.deepEqual(plain(resolve('仕入れ　フィルム')), {status: 'MATCHED', code: 712, word: '仕入'});
    assert.deepEqual(plain(resolve('仕入れ スマホケース')), {status: 'MATCHED', code: 712, word: '仕入'});
    assert.deepEqual(plain(resolve('スマホ代')), {status: 'MATCHED', code: 843, word: 'スマホ'});
    assert.deepEqual(plain(resolve('高速代')), {status: 'MATCHED', code: 842, word: '高速'});
    assert.deepEqual(plain(resolve('私用 仕入', customer({customerCategory: 'INDIVIDUAL'}))),
      {status: 'MATCHED', code: 294, word: '私用'});
    assert.deepEqual(plain(resolve('私用 仕入')), {status: 'MATCHED', code: 362, word: '私用'});
    assert.deepEqual(plain(resolve('仕入 私用分', customer({customerCategory: 'INDIVIDUAL'}))),
      {status: 'MATCHED', code: 294, word: '私用'});

    const commonOnly = mastersFrom(ACCOUNTS, [{word: '仕入', code: 712}]);
    assert.equal(call('resolveAccountCode_', ['月額利用料', customer(), commonOnly, list]).status, 'NO_MATCH');
    const scoped = mastersFrom(ACCOUNTS, [
      {word: '月額利用料', code: 866}, {word: '月額利用料', code: 843, customerId: 'C001'}
    ]);
    assert.equal(call('resolveAccountCode_', ['月額利用料', customer(), scoped, list]).code, 843);
    assert.equal(call('resolveAccountCode_', ['月額利用料', customer({customerId: 'C002'}), scoped, list]).code, 866);

    // 顧客別の行が同じ鍵の共通の行に勝つ。ほかの顧客は共通のまま。
    const override = mastersFrom(ACCOUNTS, [
      {word: '手数料', code: 858}, {word: '手数料', code: 859, customerId: 'C001'}
    ]);
    assert.equal(call('resolveAccountCode_', ['手数料', customer(), override, list]).code, 859);
    assert.equal(call('resolveAccountCode_', ['手数料', customer({customerId: 'C002'}), override, list]).code, 858);

    // 同じ鍵で違うコードの共通の行 2 つ → AMBIGUOUS。
    assert.equal(resolve('手数料').status, 'AMBIGUOUS');
    // 法人だけの行は個人の顧客に当たらない。
    assert.equal(resolve('専用語', customer({customerCategory: 'INDIVIDUAL'})).status, 'NO_MATCH');
    // 有効 FALSE の行は当たらない。
    assert.equal(resolve('無効語').status, 'NO_MATCH');
    // 決勝の行が科目一覧に無いコードなら、短い言葉の当たりがあっても落ちない。
    assert.equal(resolve('高速道路').status, 'INVALID_ENTRY');
    // 対象の値が不正な行が決勝なら INVALID_ENTRY。
    assert.equal(resolve('謎語').status, 'INVALID_ENTRY');

    // 1.1 で足した例（§4.2）。当たりに誤りの行が 1 つでもあれば、優先の
    // 絞り込みより前に決めない。
    const brokenPriority = mastersFrom(ACCOUNTS, [
      {word: '仕入', code: 712},
      {word: '私用', code: 362, category: '法人だけ', priority: 'はい'}
    ]);
    assert.equal(call('resolveAccountCode_', ['仕入 私用', customer(), brokenPriority, list]).status,
      'INVALID_ENTRY', '優先の欄が読めない私用の行を外すと先頭の仕入が勝ってしまう');

    const brokenActive = mastersFrom(ACCOUNTS, [
      {word: 'ツール代', code: 843},
      {word: 'ツール代', code: 858, customerId: 'C001', active: '○'}
    ]);
    assert.equal(call('resolveAccountCode_', ['ツール代', customer(), brokenActive, list]).status,
      'INVALID_ENTRY', '有効の欄が読めない顧客別の行を外すと共通のコードが入ってしまう');

    const brokenShorter = mastersFrom(ACCOUNTS, [
      {word: '仕入', code: 712}, {word: 'フイルム', code: 9999}
    ]);
    assert.equal(call('resolveAccountCode_', ['仕入れ フィルム', customer(), brokenShorter, list]).status,
      'INVALID_ENTRY', '短い言葉が先頭でも、当たりに科目一覧に無いコードがあれば決めない');
  });

  // ---------------- ac 2: 鍵 ----------------
  test('ac 2: 半角カナ・全角英数・空白・ひらがな・小さい字・長音の違いを同じ鍵にする', () => {
    const keys = (values) => values.map((value) => call('usageWordKey_', [value]));
    assert.deepEqual(keys(['ｽﾏﾎ代', 'スマホ代', 'スマホ 代', 'スマホ　代']),
      ['スマホ代', 'スマホ代', 'スマホ代', 'スマホ代']);
    assert.deepEqual(keys(['ネット 代', 'ﾈｯﾄ代', 'ネツト代', 'ネット代']),
      ['ネツト代', 'ネツト代', 'ネツト代', 'ネツト代']);
    assert.deepEqual(keys(['WI-FI', 'Wi-Fi', 'ＷＩ－ＦＩ', 'ｗｉ－ｆｉ']),
      ['WI-FI', 'WI-FI', 'WI-FI', 'WI-FI']);
    assert.equal(call('usageWordKey_', ['仕入れ　フィルム']), '仕入レフイルム');
    const masters = mastersFrom(ACCOUNTS, [{word: 'WI-FI', code: 843}]);
    assert.equal(call('resolveAccountCode_', ['ＷＩ－ＦＩ', customer(), masters, sheetList(ACCOUNTS)]).code, 843);
  });

  // ---------------- ac 3: マスターの読み方 ----------------
  test('ac 3: マスターの誤りの行を返し、正しい行は正しく返す', () => {
    const accounts = call('accountListRowsFromValues_', [[
      [712, '仕入高', '共通', true, ''],
      ['843', '通信費', '共通', '', ''],
      [0, '複合', '共通', true, ''],
      ['文字', 'だめ', '共通', true, ''],
      [900, '', '共通', true, ''],
      [901, '区分なし', '謎', true, ''],
      [902, '重複A', '共通', true, ''],
      [902, '重複B', '共通', true, ''],
      [903, '停止中', '共通', false, '']
    ]]);
    assert.equal(accounts[0].valid, true);
    assert.equal(accounts[1].code, 843);
    assert.equal(accounts[1].valid, true);
    assert.equal(accounts[2].valid, false);
    assert.equal(accounts[3].valid, false);
    assert.equal(accounts[4].valid, false);
    assert.equal(accounts[5].valid, false);
    assert.equal(accounts[6].valid, false);
    assert.equal(accounts[7].valid, false);
    assert.equal(accounts[8].valid, true);
    assert.equal(accounts[8].active, false);

    const words = call('accountWordRowsFromValues_', [[
      ['仕入', 712, '共通', '', '', true, '', '', ''],
      ['', 712, '共通', '', '', true, '', '', ''],
      ['消えた科目', 999, '共通', '', '', true, '', '', ''],
      ['個人の科目', 294, '共通', '', '', true, '', '', ''],
      ['法人の科目', 362, '個人だけ', '', '', true, '', '', ''],
      ['区分不正', 712, '謎', '', '', true, '', '', ''],
      ['停止', 843, '共通', '', '', false, '', '', '']
    ], accounts]);
    assert.equal(words[0].valid, true);
    assert.equal(words[1].valid, false);
    assert.deepEqual(plain(words[1].problems), ['KEY_EMPTY']);
    assert.equal(words[2].valid, false);
    assert.equal(words[3].valid, false);
    assert.equal(words[4].valid, false);
    assert.equal(words[5].valid, false);
    assert.equal(words[6].valid, true);
    assert.equal(words[6].active, false);
  });

  // ---------------- ac 4: 顧客マスター ----------------
  test('ac 4: AR・AS の読取と検査 1〜4、空の顧客は今のまま通る', () => {
    const world = setupWorld({accounts: true,
      sheetEntries: [[712, '仕入高'], [843, '通信費']]});
    assert.equal(world.customer.columnMapping.C, 3);
    assert.equal(world.customer.accountListRange, 'Q5:R12');
    const empty = setupWorld({accountColumn: false});
    assert.equal(empty.customer.columnMapping.C, null);
    assert.equal(empty.customer.accountListRange, null);

    const base = plain(world.customer);
    const bad = (patch) => {
      const value = plain(base);
      patch(value);
      assert.throws(() => call('validateCustomerValues_', [value]),
        (error) => error && error.code === 'CUSTOMER_MASTER_INVALID' &&
          /CUSTOMER_MASTER_INVALID/.test(String(error.message)));
    };
    bad((value) => { value.accountListRange = null; });
    bad((value) => { value.columnMapping.C = null; });
    bad((value) => { value.columnMapping.C = 100; });
    bad((value) => { value.columnMapping.C = 6; });
    bad((value) => { value.rowScanExcludedColumns = [3]; });
    bad((value) => { value.accountListRange = 'Q5:S9'; });
    bad((value) => { value.accountListRange = 'Q0:R9'; });
    bad((value) => { value.accountListRange = 'R9:Q5'; });
    bad((value) => { value.accountListRange = 'Q5:R205'; });
  });

  // ---------------- ac 5: 取込で書く ----------------
  test('ac 5: 当たる行だけ C に数を書き、ほかの行の C には触らない', () => {
    const world = setupWorld({accounts: true,
      sheetEntries: [[712, '仕入高'], [858, '支払手数料'], [859, '諸会費']],
      dictionary: ['架空店舗A', '架空店舗B', '架空店舗C', '架空店舗D'],
      words: [
        {word: '仕入', code: 712}, {word: '手数料', code: 858},
        {word: '手数料', code: 859}, {word: '謎語', code: 9999}
      ]});
    world.addFile('fileA', [
      '2026/01/10,架空店舗A,1000,仕入れ',
      '2026/01/11,架空店舗B,2000,月額利用料',
      '2026/01/12,架空店舗C,3000,手数料',
      '2026/01/13,架空店舗D,4000,謎語'
    ]);
    const accountCodeRanges = [];
    gas.stubs.onValuesBatchUpdate((request, spreadsheetId) => {
      if (String(spreadsheetId) !== 'dest1') return;
      (request.data || []).forEach((data) => {
        if (/![A-Z]*C[0-9]+:[A-Z]*C[0-9]+$/.test(String(data.range))) accountCodeRanges.push(data.range);
      });
    });
    let report;
    try { report = importReport(world); }
    finally { gas.stubs.onValuesBatchUpdate(null); }
    const file = report.customers[0].files[0];
    assert.equal(file.outcome, 'WRITTEN', JSON.stringify(file));
    assert.deepEqual(file.accountCode, {missing: 3, noMatch: 1, ambiguous: 1,
      invalidEntry: 1, notInSheetList: 0});

    assert.equal(cell(5, 3), 712);
    for (const row of [6, 7, 8]) assert.equal(cell(row, 3), '');
    assert.equal(accountCodeRanges.length, 1);
    assert.ok(/!C5:C5$/.test(String(accountCodeRanges[0])), JSON.stringify(accountCodeRanges));
    // B・F・G・I・K・L・M・取引ID は今と同じ。
    assert.equal(cell(5, 2) instanceof Date, true);
    assert.equal(cell(5, 6), '架空取引先');
    for (const row of [5, 6, 7, 8]) {
      assert.ok(String(cell(row, 15)).indexOf('TX_') === 0);
      assert.ok(cell(row, 11));
      assert.equal(cell(row, 12), '');
      assert.ok(cell(row, 13) > 0);
    }
    const txs = transactionsFor('fileA', ['COMMITTED']).sort((a, b) => a.sourceRow - b.sourceRow);
    assert.equal(txs.length, 4);
    assert.equal(txs[0].planned.c, 712);
    assert.equal(txs[0].verified.c, 712);
    for (const tx of txs.slice(1)) {
      assert.equal(tx.planned.c, undefined);
      assert.equal(tx.verified.c, undefined);
    }
    const log = master('クレカ取引ログ');
    const logRow = log.getRange(txs[0]._rowNumber, 1, 1, 49).getValues()[0];
    assert.equal(logRow[47], 712);
    assert.equal(logRow[48], 712);
  });

  // ---------------- ac 6: C の列が無い顧客 ----------------
  test('ac 6: C の列が無い顧客は新しいシートが無くても書込・読取・ログ 1〜47 が変わらない', () => {
    const results = [];
    for (const withAccountSheets of [false, true]) {
      const world = setupWorld({accountColumn: false, accounts: withAccountSheets,
        sheetEntries: [[712, '仕入高']],
        dictionary: ['架空店舗A'], words: [{word: '仕入', code: 712}]});
      if (!withAccountSheets) {
        const ss = gas.stubs.getSpreadsheet('master');
        ss.deleteSheet(ss.getSheetByName('勘定科目一覧'));
        ss.deleteSheet(ss.getSheetByName('用途科目辞書'));
      }
      world.addFile('fileA', ['2026/01/10,架空店舗A,1000,仕入れ']);
      gas.stubs.resetApiCallCounts();
      const report = importReport(world);
      const counts = gas.stubs.getApiCallCounts();
      const txs = transactionsFor('fileA', ['COMMITTED']);
      assert.equal(txs.length, 1);
      const logRow = master('クレカ取引ログ')
        .getRange(txs[0]._rowNumber, 1, 1, 47).getValues()[0];
      results.push({
        batchGet: counts.batchGet, batchUpdate: counts.batchUpdate,
        destination: plain(destSheet().getRange(5, 1, 1, 15).getValues()[0]),
        log: plain([0, 1].concat(Array.from({length: 41}, (_, index) => index + 3),
          [45, 46]).map((index) => logRow[index])),
        accountCode: report.customers[0].files[0].accountCode
      });
    }
    assert.equal(results[0].batchGet, results[1].batchGet);
    assert.equal(results[0].batchUpdate, results[1].batchUpdate);
    assert.deepEqual(results[0].destination, results[1].destination);
    assert.deepEqual(results[0].log, results[1].log);
    assert.equal(results[0].accountCode, undefined);
  });

  // ---------------- ac 7: 転記シートの一覧（ぶつかる行） ----------------
  test('ac 7: 名前違い・文字コード・重複コードは足さず notInSheetList、ぶつからないコードだけ足す', () => {
    const world = setupWorld({accounts: true,
      sheetEntries: [[712, '仕入れ高'], ['858', '支払手数料'], [842, '旅費交通費'],
        [842, '旅費交通費'], [999, '別科目']],
      dictionary: ['架空店舗A', '架空店舗B', '架空店舗C', '架空店舗D'],
      words: [
        {word: '仕入', code: 712}, {word: 'スマホ', code: 843},
        {word: '手数料', code: 858}, {word: '高速', code: 842}
      ]});
    world.addFile('fileA', [
      '2026/01/10,架空店舗A,1000,仕入れ',
      '2026/01/11,架空店舗B,2000,スマホ代',
      '2026/01/12,架空店舗C,3000,手数料',
      '2026/01/13,架空店舗D,4000,高速代'
    ]);
    const report = importReport(world);
    const file = report.customers[0].files[0];
    // 712 は同じコードで名前が違う、858 はコードの欄が文字の同じ数字、842 は
    // 同じコードが 2 行 ── どれも足さない。843 はコードの行も同じ科目名の
    // 行も無いので、一覧の空いた行（最後のコード 999 の次の 10 行目）へ
    // 足して C を書く。
    assert.deepEqual(file.accountCode, {missing: 3, noMatch: 0, ambiguous: 0,
      invalidEntry: 0, notInSheetList: 3, listAdded: [{code: 843, name: '通信費'}]});
    for (const row of [5, 7, 8]) assert.equal(cell(row, 3), '');
    assert.equal(cell(6, 3), 843);
    assert.equal(cell(10, 17), 843);
    assert.equal(cell(10, 18), '通信費');
    const txs = transactionsFor('fileA', ['COMMITTED']);
    assert.equal(txs.length, 4);
    const byRow = txs.slice().sort((a, b) => a.sourceRow - b.sourceRow);
    assert.equal(byRow[0].planned.c, undefined);
    assert.equal(byRow[1].planned.c, 843);
    assert.equal(byRow[2].planned.c, undefined);
    assert.equal(byRow[3].planned.c, undefined);
  });

  // ---------------- ac 8: 読取確認 ----------------
  test('ac 8: C が文字・違う数・空なら読取確認に失敗し、行は C も含めて空き行へ戻る', () => {
    const world = setupWorld({accounts: true, sheetEntries: [[712, '仕入高']]});
    const lease = world.lease();
    const rowWrite = call('buildRowWrite', [5, {fullTxId: 'AC_TX_8', planned: {
      b: '2026-01-10', f: '架空取引先', i: '仕入れ', k: '架空店舗', m: 1000, c: 712}}]);
    call('writeTransactionRows', [world.customer, [rowWrite], lease, 'lease-file']);
    assert.equal(cell(5, 3), 712);
    call('applyPlainTextFormat', [world.customer, [5]]);

    const ok = call('verifyWrittenValues', [world.customer, [rowWrite]]);
    assert.equal(ok[0].ok, true);
    destSheet().getRange(5, 3).setValue('712');
    const asText = call('verifyWrittenValues', [world.customer, [rowWrite]]);
    assert.equal(asText[0].ok, false);
    assert.equal(asText[0].mismatches[0].column, 'c');
    destSheet().getRange(5, 3).setValue(999);
    assert.equal(call('verifyWrittenValues', [world.customer, [rowWrite]])[0].ok, false);
    destSheet().getRange(5, 3).setValue('');
    assert.equal(call('verifyWrittenValues', [world.customer, [rowWrite]])[0].ok, false);

    call('clearTransactionRows', [world.customer, [5], lease, 'lease-file']);
    assert.equal(cell(5, 3), '');
  });

  // ---------------- ac 9: C を消す ----------------
  test('ac 9: 取消・複製・行の追加・Web 複製で C を空にし、C の列が無ければ触らない', () => {
    const world = setupWorld({accounts: true, sheetEntries: [[712, '仕入高']]});
    const lease = world.lease();
    const sheet = destSheet();
    sheet.getRange(5, 3).setValue(712);
    sheet.getRange(5, 15).setValue('AC_TX_9');
    call('clearTransactionRows', [world.customer, [5], lease, 'lease-file']);
    assert.equal(cell(5, 3), '');

    const values = sheet.getRange(4, 1, 1, 15).getValues()[0];
    values[2] = 712;
    assert.equal(call('systemOwnedColumnsAreEmpty_', [world.customer, values]), false);
    values[2] = '';
    assert.equal(call('systemOwnedColumnsAreEmpty_', [world.customer, values]), true);

    sheet.getRange(4, 3).setValue('');
    const realGet = sheet.getRange.bind(sheet);
    sheet.getRange = function(...args) {
      const range = realGet(...args);
      if (args[0] === 4 && args[1] === 1 && args[3] === 15) {
        const copy = range.copyTo.bind(range);
        range.copyTo = (target) => {
          const result = copy(target);
          sheet.getRange(target.getRow(), 3).setValue(712);
          return result;
        };
      }
      return range;
    };
    let added;
    try {
      const index = call('buildIndex', [world.customer]);
      added = call('expandTemplateRows', [world.customer, sheet, 1, 4,
        {actual: sheet.getMaxRows(), index: index}]);
    } finally { sheet.getRange = realGet; }
    assert.equal(added.length, 1);
    assert.equal(cell(added[0], 3), '');
    assert.equal(cell(added[0], 1), '区切り');

    sheet.getRange(5, 3).setValue(712);
    const clone = call('webAppCloneDestination_', [world.customer, new Date()]);
    assert.equal(clone.schemaValidation.ok, true, JSON.stringify(clone));
    assert.equal(cell(5, 3, clone.destinationSpreadsheetId), '');
    assert.equal(cell(5, 3), 712);

    const noC = setupWorld({accountColumn: false, sheetEntries: [[712, '仕入高']]});
    destSheet().getRange(5, 3).setValue(777);
    const noLease = noC.lease('lease-no-c');
    call('clearTransactionRows', [noC.customer, [5], noLease, 'lease-no-c']);
    assert.equal(cell(5, 3), 777);
  });

  // ---------------- ac 10: 取消の後 ----------------
  test('ac 10: C のある行を取り消した後、当たらない取引が入っても前の C は残らない', () => {
    const world = setupWorld({accounts: true, sheetEntries: [[712, '仕入高']]});
    const lease = world.lease();
    destSheet().getRange(5, 3).setValue(712);
    destSheet().getRange(5, 15).setValue('AC_TX_10');
    call('clearTransactionRows', [world.customer, [5], lease, 'lease-file']);
    const rowWrite = call('buildRowWrite', [5, {fullTxId: 'AC_TX_10B', planned: {
      b: '2026-01-11', f: '', i: '当たらない用途', k: '架空店舗', m: 1200}}]);
    call('writeTransactionRows', [world.customer, [rowWrite], lease, 'lease-file']);
    assert.equal(cell(5, 3), '');
    assert.equal(rowWrite.values.c, undefined);
  });

  // ---------------- ac 11: 知らせ ----------------
  test('ac 11: outcome の件数と 1 行の知らせ（0 の分は出さない・全部 0 なら行が無い）', () => {
    const world = setupWorld({accounts: true,
      sheetEntries: [[712, '仕入高'], [858, '支払手数料'], [859, '諸会費']],
      dictionary: ['架空店舗A', '架空店舗B', '架空店舗C', '架空店舗D'],
      words: [
        {word: '仕入', code: 712}, {word: '手数料', code: 858},
        {word: '手数料', code: 859}, {word: '謎語', code: 9999}
      ]});
    world.addFile('fileA', [
      '2026/01/10,架空店舗A,1000,仕入れ',
      '2026/01/11,架空店舗B,2000,月額利用料',
      '2026/01/12,架空店舗C,3000,手数料',
      '2026/01/13,架空店舗D,4000,謎語'
    ]);
    const report = importReport(world);
    assert.deepEqual(report.customers[0].files[0].accountCode,
      {missing: 3, noMatch: 1, ambiguous: 1, invalidEntry: 1, notInSheetList: 0});

    const source = fs.readFileSync(path.join(__dirname, '..', 'src', '81_WebAppUi.html'), 'utf8');
    const script = /<script>([\s\S]*?)<\/script>/.exec(source)[1];
    const needle = "    el['customer-search'].addEventListener";
    assert.ok(script.includes(needle));
    function noticeLines(files) {
      const sandbox = {document: {getElementById() { return {}; }}};
      vm.runInNewContext(script.replace(needle,
        `    globalThis.probe = customerFixNoticeLines(${JSON.stringify(files)}); return;\n` + needle),
      sandbox);
      return plain(sandbox.probe);
    }
    assert.deepEqual(noticeLines([{fileName: '架空.csv',
      accountCode: {missing: 3, noMatch: 1, ambiguous: 1, invalidEntry: 0, notInSheetList: 1}}]),
    ['【科目コード】架空.csv：3 行は相手科目コードを入れていません（辞書に無い用途 1 行・候補が割れた 1 行・転記シートの一覧に足せない 1 行）。C 列に手で入れてください']);
    assert.deepEqual(noticeLines([{fileName: '架空.csv',
      accountCode: {missing: 1, noMatch: 0, ambiguous: 0, invalidEntry: 1, notInSheetList: 0}}]),
    ['【科目コード】架空.csv：1 行は相手科目コードを入れていません（辞書の誤り 1 行）。C 列に手で入れてください']);
    assert.deepEqual(noticeLines([{fileName: '架空.csv',
      accountCode: {missing: 0, noMatch: 0, ambiguous: 0, invalidEntry: 0, notInSheetList: 0}}]), []);
    // 一覧へ足した行の知らせ（§23.5）。C を書かなかった行が 0 でも出す。
    assert.deepEqual(noticeLines([{fileName: '架空.csv',
      accountCode: {missing: 0, noMatch: 0, ambiguous: 0, invalidEntry: 0,
        notInSheetList: 0, listAdded: [{code: 362, name: '役員借入金'}]}}]),
    ['【科目一覧】架空.csv：転記シートの科目一覧に「362 役員借入金」を足しました']);
    assert.deepEqual(noticeLines([{fileName: '架空.csv',
      accountCode: {missing: 1, noMatch: 0, ambiguous: 0, invalidEntry: 0, notInSheetList: 1,
        listAdded: [{code: 843, name: '通信費'}, {code: 362, name: '役員借入金'}]}}]),
    ['【科目コード】架空.csv：1 行は相手科目コードを入れていません（転記シートの一覧に足せない 1 行）。C 列に手で入れてください',
      '【科目一覧】架空.csv：転記シートの科目一覧に「843 通信費・362 役員借入金」を足しました']);
  });

  // ---------------- ac 12: 回数 ----------------
  test('ac 12: マスターの読取は差 0、一覧は転記先ごとに 1 回、書込の要求も差 0', () => {
    const withC = setupWorld({accounts: true, sheetEntries: [[712, '仕入高']],
      dictionary: ['架空店舗A'], words: [{word: '仕入', code: 712}]});
    withC.addFile('fileA', ['2026/01/10,架空店舗A,1000,仕入れ']);
    gas.stubs.resetApiCallCounts();
    importReport(withC);
    const cCounts = gas.stubs.getApiCallCounts();

    const withoutC = setupWorld({accountColumn: false, accounts: true,
      sheetEntries: [[712, '仕入高']], dictionary: ['架空店舗A']});
    withoutC.addFile('fileA', ['2026/01/10,架空店舗A,1000,仕入れ']);
    gas.stubs.resetApiCallCounts();
    importReport(withoutC);
    const noCounts = gas.stubs.getApiCallCounts();

    assert.equal(cCounts.batchGet - noCounts.batchGet, 1, JSON.stringify({cCounts, noCounts}));
    assert.equal(cCounts.batchUpdate, noCounts.batchUpdate);

    const c = withC.customer;
    const no = withoutC.customer;
    gas.call('beginRunScopedReads_');
    const beforeC = gas.stubs.getApiCallCounts().batchGet;
    call('prefetchMatchingMasters_', [c]);
    const afterC = gas.stubs.getApiCallCounts().batchGet;
    gas.call('endRunScopedReads_');
    gas.call('beginRunScopedReads_');
    call('prefetchMatchingMasters_', [no]);
    const afterNo = gas.stubs.getApiCallCounts().batchGet;
    gas.call('endRunScopedReads_');
    assert.equal(afterC - beforeC, 1);
    assert.equal(afterNo - afterC, 1, 'C の有無でマスターの往復は増えない');

    gas.call('beginRunScopedReads_');
    const first = gas.stubs.getApiCallCounts().batchGet;
    const listOne = call('destinationAccountListForRun_', [c]);
    const second = gas.stubs.getApiCallCounts().batchGet;
    const listTwo = call('destinationAccountListForRun_', [c]);
    const third = gas.stubs.getApiCallCounts().batchGet;
    gas.call('endRunScopedReads_');
    assert.equal(second - first, 1);
    assert.equal(third, second);
    assert.deepEqual(Array.from(listOne.entries()), Array.from(listTwo.entries()));

    // 1.1：runImport 1 回で同じ転記先の 2 ファイルを取り込み、C の列が無い
    // 場合（同じ 2 ファイル）との batchGet の差がちょうど 1 であること。
    const twoWithC = setupWorld({accounts: true, sheetEntries: [[712, '仕入高']],
      dictionary: ['架空店舗A'], words: [{word: '仕入', code: 712}]});
    twoWithC.addFile('twoA', ['2026/01/11,架空店舗A,1000,仕入れ'], '架空カード202602.csv');
    twoWithC.addFile('twoB', ['2026/01/12,架空店舗A,1200,仕入れ'], '架空カード202603.csv');
    gas.stubs.resetApiCallCounts();
    const twoCReport = importReport(twoWithC);
    const twoCCounts = gas.stubs.getApiCallCounts();

    const twoWithoutC = setupWorld({accountColumn: false, accounts: true,
      sheetEntries: [[712, '仕入高']], dictionary: ['架空店舗A']});
    twoWithoutC.addFile('twoA', ['2026/01/11,架空店舗A,1000,仕入れ'], '架空カード202602.csv');
    twoWithoutC.addFile('twoB', ['2026/01/12,架空店舗A,1200,仕入れ'], '架空カード202603.csv');
    gas.stubs.resetApiCallCounts();
    const twoNoReport = importReport(twoWithoutC);
    const twoNoCounts = gas.stubs.getApiCallCounts();

    assert.deepEqual(twoCReport.customers[0].files.map((file) => file.outcome),
      ['WRITTEN', 'WRITTEN'], JSON.stringify(twoCReport));
    assert.deepEqual(twoNoReport.customers[0].files.map((file) => file.outcome),
      ['WRITTEN', 'WRITTEN'], JSON.stringify(twoNoReport));
    assert.equal(twoCCounts.batchGet - twoNoCounts.batchGet, 1,
      JSON.stringify({twoCCounts, twoNoCounts}));
    assert.equal(twoCCounts.batchUpdate, twoNoCounts.batchUpdate,
      JSON.stringify({twoCCounts, twoNoCounts}));

    // 1.1：一覧の読取は一時的な誤り（503）を 1 回だけ読み直し、一時的でない
    // 誤りは読み直さずに投げる。
    gas.stubs.setSheetsBatchGetFailures([{code: 503, message: '503 transient'}]);
    const beforeRetry = gas.stubs.getApiCallCounts().batchGet;
    const retried = call('readDestinationAccountList_', ['dest1', '入力用シート', 'Q5:R12']);
    const afterRetry = gas.stubs.getApiCallCounts().batchGet;
    assert.equal(retried.get(712), '仕入高');
    assert.equal(afterRetry - beforeRetry, 2, '503 の 1 回は読み直す');

    gas.stubs.setSheetsBatchGetFailures([{code: 403, message: 'forbidden'}]);
    const beforeFatal = gas.stubs.getApiCallCounts().batchGet;
    assert.throws(() => call('readDestinationAccountList_', ['dest1', '入力用シート', 'Q5:R12']),
      (error) => error.code === 403);
    assert.equal(gas.stubs.getApiCallCounts().batchGet - beforeFatal, 1,
      '一時的でない誤りは読み直さずに止まる');
  });

  // ---------------- ac 13: 種 ----------------
  test('ac 13: 種は toAdd だけを足し、既存を変えず、ロック内で読み直す', () => {
    setupMaster();
    const accounts = master('勘定科目一覧');
    const words = master('用途科目辞書');
    const dry = plain(call('opsSeedAccountMasters', []));
    assert.equal(dry.applied, false);
    assert.equal(dry.accounts.toAdd.length, 39);
    assert.equal(dry.words.toAdd.length, 84);
    assert.equal(accounts.getLastRow(), 1);
    assert.equal(words.getLastRow(), 1);

    const applied = plain(call('opsSeedAccountMasters', [true]));
    assert.equal(applied.applied, true);
    assert.equal(accounts.getLastRow(), 40);
    assert.equal(words.getLastRow(), 85);
    assert.notEqual(accounts.getRange(1, 2).getValue(), '');
    assert.notEqual(words.getRange(1, 2).getValue(), '');
    assert.equal(words.getRange(2, 6).getValue(), true);
    assert.equal(plain(call('opsSeedAccountMasters', [])).accounts.toAdd.length, 0);
    assert.equal(plain(call('opsSeedAccountMasters', [])).words.toAdd.length, 0);

    // differs の行は書き換えない。
    accounts.getRange(2, 2).setValue('架空の違う名前');
    const before = accounts.getRange(2, 1, 1, 5).getValues()[0];
    const differs = plain(call('opsSeedAccountMasters', []));
    assert.equal(differs.accounts.differs.length, 1);
    call('opsSeedAccountMasters', [true]);
    assert.deepEqual(plain(accounts.getRange(2, 1, 1, 5).getValues()[0]), plain(before));

    // 監査が書けなければ足さない。
    const fresh = setupMaster();
    const freshAccounts = master('勘定科目一覧');
    const rowsBefore = freshAccounts.getLastRow();
    assert.throws(() => mock({appendAuditUnlocked_() { throw new Error('audit down'); }},
      () => call('opsSeedAccountMasters', [true])), /audit down/);
    assert.equal(freshAccounts.getLastRow(), rowsBefore);

    // 見るだけの後に人が足した行を、ロック内の読み直しで二重に足さない。
    setupMaster();
    call('opsSeedAccountMasters', []);
    master('勘定科目一覧').appendRow([712, '仕入高', '共通', true, '']);
    const reread = plain(call('opsSeedAccountMasters', [true]));
    assert.equal(reread.accounts.toAdd.length, 38);
    assert.equal(master('勘定科目一覧').getRange(2, 1, 1, 1).getValues()[0][0], 712);

    // ロックを取る直前に人が足した行も、ロックの中の読み直しで二重に足さない。
    setupMaster();
    const realLock = gas.context.withScriptLock_;
    let injected = false;
    mock({withScriptLock_(fn) {
      if (!injected) {
        injected = true;
        master('勘定科目一覧').appendRow([712, '仕入高', '共通', true, '']);
      }
      return realLock(fn);
    }}, () => call('opsSeedAccountMasters', [true]));
    const rows = master('勘定科目一覧').getDataRange().getValues()
      .filter((row) => row[0] === 712);
    assert.equal(rows.length, 1);
  });

  // ---------------- ac 14: 列の設定 ----------------
  test('ac 14: 列の設定は見るだけで変えず、apply で AR・AS と見出しを書き、不正なら書かない', () => {
    const world = setupWorld({accountColumn: false,
      sheetEntries: [[712, '仕入高'], [843, '通信費']]});
    const dry = plain(call('opsSetAccountCodeColumn', ['C001', 3, 'Q5:R12', false]));
    assert.equal(dry.applied, false);
    assert.equal(dry.header, '相手科目コード');
    assert.equal(dry.sheetCodes, 2);
    assert.equal(dry.inBoth, 2);
    assert.equal(dry.onlyInMaster, ACCOUNTS.length - 2);
    assert.equal(dry.nameDiffers, 0);
    assert.equal(master('顧客マスター').getRange(2, 44).getValue(), '');
    assert.equal(master('顧客マスター').getRange(2, 45).getValue(), '');

    const applied = plain(call('opsSetAccountCodeColumn', ['C001', 3, 'Q5:R12', true]));
    assert.equal(applied.applied, true);
    assert.equal(master('顧客マスター').getRange(2, 44).getValue(), 3);
    assert.equal(master('顧客マスター').getRange(2, 45).getValue(), 'Q5:R12');
    assert.equal(master('顧客マスター').getRange(1, 44).getValue(), '相手科目コードの転記先列');
    assert.equal(master('顧客マスター').getRange(1, 45).getValue(), '科目一覧の範囲');
    assert.equal(call('getCustomerById', ['C001']).columnMapping.C, 3);
    assert.equal(call('getCustomerById', ['C001']).accountListRange, 'Q5:R12');
    const audits = master('監査ログ').getDataRange().getValues()
      .filter((row) => row[11] === 'ACCOUNT_CODE_COLUMN');
    assert.equal(audits.length, 1);

    assert.throws(() => call('opsSetAccountCodeColumn', ['C001', 6, 'Q5:R12', true]),
      (error) => error && error.code === 'CUSTOMER_MASTER_INVALID');
    assert.equal(master('顧客マスター').getRange(2, 44).getValue(), 3);
  });

  // ---------------- ac 15: 幅 ----------------
  test('ac 15: 初期化で取引ログ 49・顧客マスター 45 に広がり、新しい 2 枚ができる', () => {
    setupMaster();
    const tx = master('クレカ取引ログ');
    const cm = master('顧客マスター');
    assert.ok(tx.getMaxColumns() >= 49);
    assert.ok(cm.getMaxColumns() >= 45);
    assert.ok(master('勘定科目一覧'));
    assert.ok(master('用途科目辞書'));
    tx.getRange(2, 1).setValue('TX_KEEP');
    master('勘定科目一覧').getRange(2, 1).setValue(712);
    const again = plain(call('provisionMasterSheets', []));
    assert.equal(again.created.length, 0);
    assert.equal(tx.getRange(2, 1).getValue(), 'TX_KEEP');
    assert.equal(master('勘定科目一覧').getRange(2, 1).getValue(), 712);
  });

  // ---------------- ac 16: 値を出さない ----------------
  test('ac 16: 用途・店名・金額を outcome にもログにも出さない', () => {
    const world = setupWorld({accounts: true, sheetEntries: [[712, '仕入高']],
      dictionary: ['架空店舗QQQ'], words: [{word: '仕入', code: 712}]});
    world.addFile('fileA', ['2026/01/10,架空店舗QQQ,4321,架空用途ZZZ']);
    const report = importReport(world);
    const serialized = JSON.stringify(report);
    for (const secret of ['架空用途ZZZ', '架空店舗QQQ', '4321']) {
      assert.ok(serialized.indexOf(secret) < 0, secret + ' must not appear in outcome');
      assert.ok(gas.stubs.getLogLines().every((line) => line.indexOf(secret) < 0),
        secret + ' must not appear in logs');
    }
  });

  // ---------------- ac 17: 確定は C を持ち越す ----------------
  test('ac 17: 取引先の確定（1 件・まとめて）の後も予定値と転記先の C は変わらない', () => {
    const world = setupWorld({accounts: true, sheetEntries: [[712, '仕入高']],
      dictionary: ['架空未知店A', '架空未知店B'], knownPartners: false,
      words: [{word: '仕入', code: 712}]});
    world.addFile('fileA', [
      '2026/01/10,架空未知店A,1000,仕入れ',
      '2026/01/11,架空未知店B,2000,仕入れ'
    ]);
    importReport(world);
    assert.equal(cell(5, 3), 712);
    assert.equal(cell(6, 3), 712);
    const reviews = plain(call('openReviews', [{}])).filter((review) =>
      review.reviewType === 'PARTNER' && review.fileId === 'fileA');
    assert.equal(reviews.length, 2);

    call('resolveReview', [reviews[0].reviewId, 'ADOPT_EXISTING_PARTNER',
      {partnerName: '株式会社架空解決先'}]);
    call('resolvePartnerReviewsBatch', ['C001', 'fileA', [{
      reviewId: reviews[1].reviewId, operation: 'ADOPT_EXISTING_PARTNER',
      partnerName: '株式会社架空解決先', learn: false, scope: 'COMMON'
    }], {actor: 'tester@example.com'}]);

    assert.equal(cell(5, 3), 712);
    assert.equal(cell(6, 3), 712);
    for (const txId of [cell(5, 15), cell(6, 15)]) {
      const tx = call('getTransaction', [txId]);
      assert.equal(tx.planned.c, 712);
      assert.equal(tx.verified.c, 712);
    }
  });

  // ---------------- ac 18: 書き直す経路 ----------------
  test('ac 18: 予定値を書き直す回復の経路でも C が書き直される', () => {
    const world = setupWorld({accounts: true, sheetEntries: [[712, '仕入高']]});
    const customer = world.customer;
    const planned = {b: '2026-01-10', f: '架空取引先', i: '仕入れ',
      k: '架空店舗', m: 1000, c: 712};
    gas.stubs.createFile('seed-file', {name: '架空.csv', data: 'fake'});
    call('createOrUpdateProcessLog', ['SEED_RUN', customer, {id: 'seed-file', name: '架空.csv',
      binaryHash: 'b'.repeat(64), contentHash: 'c'.repeat(64), hashVersion: '3', state: 'WRITING'}]);
    call('registerPrepared', [[{fullTxId: 'AC_TX_18', customerId: 'C001', fileId: 'seed-file',
      sourceRow: 2, formatId: 'ac_fake_format', plannedFinalStatus: 'COMMITTED',
      partnerResolutionStatus: 'RESOLVED_WITH_PARTNER', originalDate: planned.b,
      originalMerchant: planned.k, originalAmount: 1000, originalPurpose: planned.i,
      planned: planned, identityHash: 'd'.repeat(64), contentHash: 'c'.repeat(64),
      occurrenceIndex: 0, transactionIdVersion: '2', hashVersion: '3'}], 'SEED_RUN']);
    destSheet().getRange(5, 15).setValue('AC_TX_18');
    destSheet().getRange(5, 11).setValue('違う摘要');
    const lease = call('acquireLease', ['C001', 'seed-file', 'SEED_RUN',
      'tester@example.com', 'PROCESS']);
    const index = call('buildIndex', [customer]);
    const result = plain(call('recoverPartialFailure',
      ['seed-file', 'SEED_RUN', index, lease, {customer: customer}]));
    assert.equal(result.recovered[0].step, 4, JSON.stringify(result));
    assert.equal(cell(5, 3), 712);
    const tx = call('getTransaction', ['AC_TX_18']);
    assert.equal(tx.planned.c, 712);
    assert.equal(tx.verified.c, 712);
  });

  // ---------------- ac 19: シートが無い ----------------
  test('ac 19: C の列がある顧客で新しいシートが無ければ、転記先に書かずに止まる', () => {
    const world = setupWorld({accounts: true, sheetEntries: [[712, '仕入高']],
      dictionary: ['架空店舗A'], words: [{word: '仕入', code: 712}]});
    const ss = gas.stubs.getSpreadsheet('master');
    ss.deleteSheet(ss.getSheetByName('勘定科目一覧'));
    ss.deleteSheet(ss.getSheetByName('用途科目辞書'));
    world.addFile('fileA', ['2026/01/10,架空店舗A,1000,仕入れ']);
    const report = plain(call('runImport', [{}]));
    const file = report.customers[0].files[0];
    assert.equal(file.outcome, 'FAILED', JSON.stringify(file));
    assert.equal(file.errorCode, 'CUSTOMER_MASTER_INVALID');
    assert.deepEqual(plain(destSheet().getRange(5, 1, 1, 15).getValues()[0]),
      plain(blank(15)));
    assert.equal(transactionsFor('fileA',
      ['PREPARED', 'WRITING', 'COMMITTED', 'REVIEW_REQUIRED']).length, 0);
  });

  // ---------------- ac 20: 一覧へ書き足す ----------------
  test('ac 20: 一覧に無いコードを空いた行へ足して C を書き、2 本目のファイルでは足さず読まない', () => {
    const world = setupWorld({accounts: true,
      // 5 行目は空（コードの行より上）。足すのは 7 行目（最後のコード）の下。
      sheetEntries: [['', ''], [712, '仕入高'], [858, '支払手数料']],
      listRange: 'Q5:R12',
      dictionary: ['架空店舗A'],
      words: [{word: '仕入', code: 712}, {word: 'スマホ', code: 843}]});
    world.addFile('fileA', ['2026/01/10,架空店舗A,1000,スマホ代'], '架空カード202601.csv');
    world.addFile('fileB', ['2026/01/11,架空店舗A,1200,スマホ代'], '架空カード202602.csv');
    const listWrites = [];
    gas.stubs.onValuesBatchUpdate((request, spreadsheetId) => {
      (request.data || []).forEach((data) => {
        if (String(spreadsheetId) === 'dest1' && String(data.range).indexOf("'入力用シート'!Q") === 0) {
          listWrites.push({spreadsheetId: spreadsheetId, range: data.range,
            values: plain(data.values)});
        }
      });
    });
    // 一覧の読取（最初の 1 回・ロックの中の読み直し・読み戻し）を数える。
    const realReadValues = gas.context.destinationRangeValues_;
    const listReadRanges = [];
    let report;
    try {
      report = mock({destinationRangeValues_(spreadsheetId, range, option) {
        if (String(spreadsheetId) === 'dest1' &&
            String(range).indexOf("'入力用シート'!Q") === 0) {
          listReadRanges.push(String(range));
        }
        return realReadValues(spreadsheetId, range, option);
      }}, () => importReport(world));
    } finally { gas.stubs.onValuesBatchUpdate(null); }

    // 最後のコードの行（858 の 7 行目）の次の、空いた 8 行目に入る。
    // コードの行より上にある空の 5 行目には足さない。
    assert.equal(listWrites.length, 1, JSON.stringify(listWrites));
    assert.equal(listWrites[0].spreadsheetId, 'dest1');
    assert.equal(listWrites[0].range, "'入力用シート'!Q8:R8");
    assert.deepEqual(listWrites[0].values, [[843, '通信費']]);
    assert.equal(cell(5, 17), '');
    assert.equal(cell(8, 17), 843);
    assert.equal(cell(8, 18), '通信費');
    // 足したコードの C は両方のファイルの行に入る。
    assert.equal(cell(5, 3), 843);
    assert.equal(cell(6, 3), 843);
    // 2 本目は覚えている一覧で当たるので、読み直さない・足し直さない。
    assert.deepEqual(listReadRanges, ["'入力用シート'!Q5:R12",
      "'入力用シート'!Q5:R12", "'入力用シート'!Q8:R8"],
    '最初の 1 回・ロックの中の読み直し・読み戻しだけ');
    const files = report.customers[0].files;
    assert.deepEqual(files.map((file) => file.outcome), ['WRITTEN', 'WRITTEN']);
    assert.deepEqual(files[0].accountCode, {missing: 0, noMatch: 0, ambiguous: 0,
      invalidEntry: 0, notInSheetList: 0, listAdded: [{code: 843, name: '通信費'}]});
    assert.equal(files[1].accountCode, undefined);
    // 監査は 1 行だけ（足した行があるときだけ）。
    const audits = master('監査ログ').getDataRange().getValues()
      .filter((row) => row[11] === 'ACCOUNT_LIST_APPEND');
    assert.equal(audits.length, 1);
    assert.equal(audits[0][6], 'DESTINATION');
    assert.equal(audits[0][7], 'dest1');
    assert.equal(audits[0][8], 'C001');
    assert.deepEqual(JSON.parse(audits[0][10]),
      {rows: [{row: 8, code: 843, name: '通信費'}]});
  });

  // ---------------- ac 21: 空いた行が無い ----------------
  test('ac 21: 空いた行が無ければ足さず、C も書かず notInSheetList に数える', () => {
    // (a) 範囲の最後までコードの行が続く（Q5:R6）。
    const full = setupWorld({accounts: true,
      sheetEntries: [[712, '仕入高'], [858, '支払手数料']], listRange: 'Q5:R6',
      dictionary: ['架空店舗A'], words: [{word: 'スマホ', code: 843}]});
    full.addFile('fileA', ['2026/01/10,架空店舗A,1000,スマホ代']);
    const listWrites = [];
    gas.stubs.onValuesBatchUpdate((request) => {
      (request.data || []).forEach((data) => {
        if (String(data.range).indexOf("'入力用シート'!Q") === 0) listWrites.push(data.range);
      });
    });
    let report;
    try { report = importReport(full); } finally { gas.stubs.onValuesBatchUpdate(null); }
    assert.deepEqual(listWrites, []);
    assert.deepEqual(report.customers[0].files[0].accountCode,
      {missing: 1, noMatch: 0, ambiguous: 0, invalidEntry: 0, notInSheetList: 1});
    assert.equal(cell(5, 3), '');
    assert.equal(cell(5, 17), 712);

    // (b) 合計の行の手前まで埋まっている。
    const total = setupWorld({accounts: true,
      sheetEntries: [[712, '仕入高'], [858, '支払手数料']], listRange: 'Q5:R10',
      dictionary: ['架空店舗A'], words: [{word: 'スマホ', code: 843}]});
    destSheet().getRange(7, 18).setValue('合計');
    total.addFile('fileA', ['2026/01/10,架空店舗A,1000,スマホ代']);
    gas.stubs.onValuesBatchUpdate((request) => {
      (request.data || []).forEach((data) => {
        if (String(data.range).indexOf("'入力用シート'!Q") === 0) listWrites.push(data.range);
      });
    });
    try { report = importReport(total); } finally { gas.stubs.onValuesBatchUpdate(null); }
    assert.deepEqual(listWrites, []);
    assert.deepEqual(report.customers[0].files[0].accountCode,
      {missing: 1, noMatch: 0, ambiguous: 0, invalidEntry: 0, notInSheetList: 1});
    assert.equal(cell(5, 3), '');
    assert.equal(cell(7, 18), '合計');
  });

  // ---------------- ac 22: ぶつかる行 ----------------
  test('ac 22: 名前違い・同じ名前で違うコード・文字コード・2 行のコードは足さない', () => {
    const world = setupWorld({accounts: true,
      sheetEntries: [[712, '違う名前'], ['843', '通信費'], [842, '旅費交通費'],
        [842, '旅費交通費'], [999, '地代家賃']],
      listRange: 'Q5:R20',
      dictionary: ['架空店舗A', '架空店舗B', '架空店舗C', '架空店舗D'],
      words: [{word: '仕入', code: 712}, {word: 'スマホ', code: 843},
        {word: '高速', code: 842}, {word: '家賃', code: 866}]});
    world.addFile('fileA', [
      '2026/01/10,架空店舗A,1000,仕入れ',
      '2026/01/11,架空店舗B,2000,スマホ代',
      '2026/01/12,架空店舗C,3000,高速代',
      '2026/01/13,架空店舗D,4000,家賃'
    ]);
    const before = plain(destSheet().getRange(1, 17, 20, 2).getValues());
    const listWrites = [];
    gas.stubs.onValuesBatchUpdate((request) => {
      (request.data || []).forEach((data) => {
        if (String(data.range).indexOf("'入力用シート'!Q") === 0) listWrites.push(data.range);
      });
    });
    let report;
    try { report = importReport(world); } finally { gas.stubs.onValuesBatchUpdate(null); }
    assert.deepEqual(listWrites, []);
    assert.deepEqual(report.customers[0].files[0].accountCode,
      {missing: 4, noMatch: 0, ambiguous: 0, invalidEntry: 0, notInSheetList: 4});
    for (const row of [5, 6, 7, 8]) assert.equal(cell(row, 3), '');
    assert.deepEqual(plain(destSheet().getRange(1, 17, 20, 2).getValues()), before);
    // 一覧の Map には、文字のコードの行（"843"）を入れない（§6。VLOOKUP が
    // 当たらないので「一覧に無い」と同じ扱い）。
    const list = call('readDestinationAccountList_', ['dest1', '入力用シート', 'Q5:R20']);
    assert.equal(list.has(843), false);
    assert.equal(list.get(712), '違う名前');
    assert.equal(list.has(842), false, '同じコードが 2 行なら入れない');
    assert.equal(list.get(999), '地代家賃');
  });

  // ---------------- ac 23: 同時の書き足し ----------------
  test('ac 23: ロックの中の読み直しで次の空いた行に入れ、先に足されたコードは足さない', () => {
    const world = setupWorld({accounts: true, sheetEntries: [[712, '仕入高']],
      listRange: 'Q5:R12'});
    const lease = world.lease('lease-ac23');
    gas.call('beginRunScopedReads_');
    let first;
    let second;
    try {
      // 最初の読取（5 行目だけがコードの行。空いた行は 6〜12 行目）。
      first = call('destinationAccountListForRun_', [world.customer]);
      assert.equal(first.get(712), '仕入高');
      // ロックの前に、別の取込が空いた行の 1 つ目へ入れた。
      destSheet().getRange(6, 17).setValue(888);
      destSheet().getRange(6, 18).setValue('別科目');
      const result = plain(call('appendAccountListEntries_',
        [world.customer, 'lease-ac23', lease, [{code: 843, name: '通信費'}]]));
      assert.deepEqual(result, {added: [{row: 7, code: 843, name: '通信費'}],
        matched: [], failed: []});
      // 同時に入った値を上書きしない。
      assert.equal(cell(6, 17), 888);
      assert.equal(cell(6, 18), '別科目');
      assert.equal(cell(7, 17), 843);
      assert.equal(cell(7, 18), '通信費');
      // 実行の中で覚えている一覧も、足した後の内容になる。
      assert.equal(call('destinationAccountListForRun_', [world.customer]).get(843), '通信費');
      // 先に同じコードが足されていれば、足さずに MATCHED として返す。
      second = call('appendAccountListEntries_',
        [world.customer, 'lease-ac23', lease, [{code: 843, name: '通信費'}]]);
      assert.deepEqual(plain(second), {added: [], matched: [843], failed: []});
    } finally { gas.call('endRunScopedReads_'); }
    assert.equal(cell(7, 17), 843);
  });

  // ---------------- ac 24: リースが無い ----------------
  test('ac 24: リースを持たない実行は書き足さない（転記先は変わらない）', () => {
    const world = setupWorld({accounts: true, sheetEntries: [[712, '仕入高']],
      listRange: 'Q5:R12'});
    world.lease('lease-ac24');
    const before = plain(destSheet().getRange(1, 1, 12, 20).getValues());
    const result = plain(call('appendAccountListEntries_',
      [world.customer, 'lease-ac24', 'no-such-lease', [{code: 843, name: '通信費'}]]));
    assert.deepEqual(result, {added: [], matched: [], failed: [843]});
    assert.deepEqual(plain(destSheet().getRange(1, 1, 12, 20).getValues()), before);
  });

  // ---------------- ac 25: 雛形には触らない ----------------
  test('ac 25: 足すのは取込の転記先（Web アプリでは複製）だけで、雛形の一覧は変えない', () => {
    const world = setupWorld({accounts: true, sheetEntries: [[712, '仕入高']],
      listRange: 'Q5:R12'});
    const lease = world.lease('lease-ac25');
    const clone = call('webAppCloneDestination_', [world.customer, new Date()]);
    const cloneId = clone.destinationSpreadsheetId;
    const cloneCustomer = Object.assign({}, plain(world.customer),
      {destinationSpreadsheetId: cloneId});
    const cloneBefore = plain(destSheet(cloneId).getRange(1, 1, 12, 20).getValues());
    const templateBefore = plain(destSheet('dest1').getRange(1, 1, 12, 20).getValues());
    gas.call('beginRunScopedReads_');
    let result;
    try {
      result = plain(call('appendAccountListEntries_',
        [cloneCustomer, 'lease-ac25', lease, [{code: 843, name: '通信費'}]]));
    } finally { gas.call('endRunScopedReads_'); }
    assert.deepEqual(result.added, [{row: 6, code: 843, name: '通信費'}]);
    assert.equal(cell(6, 17, cloneId), 843);
    assert.equal(cell(6, 18, cloneId), '通信費');
    const cloneAfter = plain(destSheet(cloneId).getRange(1, 1, 12, 20).getValues());
    cloneAfter.forEach((row, index) => {
      if (index === 5) return;
      assert.deepEqual(row, cloneBefore[index], (index + 1) + ' 行目は変えない');
    });
    assert.deepEqual(plain(destSheet('dest1').getRange(1, 1, 12, 20).getValues()),
      templateBefore);
  });

  // ---------------- ac 26: 読み戻しが違う ----------------
  test('ac 26: 読み戻しが違うコードは足せなかった扱いにして C を書かない（書いた値は戻さない）', () => {
    const world = setupWorld({accounts: true, sheetEntries: [[712, '仕入高']],
      listRange: 'Q5:R12', dictionary: ['架空店舗A'],
      words: [{word: 'スマホ', code: 843}]});
    world.addFile('fileA', ['2026/01/10,架空店舗A,1000,スマホ代']);
    const realRange = gas.context.destinationRangeValues_;
    let readBacks = 0;
    let report;
    report = mock({destinationRangeValues_(spreadsheetId, range, option) {
      const values = realRange(spreadsheetId, range, option);
      const match = /^'入力用シート'!Q(\d+):R(\d+)$/.exec(String(range));
      if (String(spreadsheetId) === 'dest1' && match && match[1] === match[2]) {
        readBacks += 1;
        return values.map((row) => [row[0], '違う科目名']);
      }
      return values;
    }}, () => importReport(world));
    assert.equal(readBacks, 1);
    const file = report.customers[0].files[0];
    assert.equal(file.outcome, 'WRITTEN', JSON.stringify(file));
    assert.deepEqual(file.accountCode, {missing: 1, noMatch: 0, ambiguous: 0,
      invalidEntry: 0, notInSheetList: 1});
    assert.equal(cell(5, 3), '');
    // 足せなかったものとして扱うが、書いた値は戻さない。
    assert.equal(cell(6, 17), 843);
    assert.equal(cell(6, 18), '通信費');
    const txs = transactionsFor('fileA', ['COMMITTED']);
    assert.equal(txs[0].planned.c, undefined);
  });

  // ---------------- ac 27: 顧客の区分 ----------------
  test('ac 27: 顧客の区分は見るだけで変えず、apply で AJ と監査を書き、検査に通らなければ書かない', () => {
    const world = setupWorld({accounts: true, sheetEntries: [[712, '仕入高']]});
    const aj = () => master('顧客マスター').getRange(2, 36).getValue();
    assert.equal(aj(), 'CORPORATE');
    // 個人にするには AK の年度が要る。無ければ見るだけでも止まる。
    assert.throws(() => call('opsSetCustomerCategory', ['C001', 'INDIVIDUAL', false]),
      (error) => error && error.code === 'CUSTOMER_MASTER_INVALID');
    call('setCustomerFiscalYear', ['C001', 2026, 'tester@example.com', 'TEST']);
    const dry = plain(call('opsSetCustomerCategory', ['C001', 'INDIVIDUAL', false]));
    assert.deepEqual(dry, {customerId: 'C001', currentCategory: 'CORPORATE',
      category: 'INDIVIDUAL', fiscalYear: 2026, applied: false});
    assert.equal(aj(), 'CORPORATE');

    const applied = plain(call('opsSetCustomerCategory', ['C001', 'INDIVIDUAL', true]));
    assert.equal(applied.applied, true);
    assert.equal(aj(), 'INDIVIDUAL');
    assert.equal(call('getCustomerById', ['C001']).customerCategory, 'INDIVIDUAL');
    const audits = master('監査ログ').getDataRange().getValues()
      .filter((row) => row[11] === 'CUSTOMER_CATEGORY');
    assert.equal(audits.length, 1);
    assert.equal(audits[0][2], 'SETTING');
    assert.equal(audits[0][8], 'C001');
    assert.deepEqual(JSON.parse(audits[0][9]), {AJ: 'CORPORATE'});
    assert.deepEqual(JSON.parse(audits[0][10]), {AJ: 'INDIVIDUAL'});

    // 不正な値は書かない。
    assert.throws(() => call('opsSetCustomerCategory', ['C001', '謎', true]),
      (error) => error && error.code === 'CUSTOMER_MASTER_INVALID');
    assert.equal(aj(), 'INDIVIDUAL');

    // 監査が書けなければ書かない。
    assert.throws(() => mock({appendAuditUnlocked_() { throw new Error('audit down'); }},
      () => call('opsSetCustomerCategory', ['C001', 'CORPORATE', true])), /audit down/);
    assert.equal(aj(), 'INDIVIDUAL');
  });

  // ---------------- ac 28: 回数 ----------------
  test('ac 28: 一覧へ足すときの読取・書込の回数を固定する（足さないときは 1.1 と同じ）', () => {
    function countsFor(sheetEntries) {
      const world = setupWorld({accounts: true, sheetEntries: sheetEntries,
        listRange: 'Q5:R12', dictionary: ['架空店舗A'],
        words: [{word: 'スマホ', code: 843}]});
      world.addFile('fileA', ['2026/01/10,架空店舗A,1000,スマホ代']);
      gas.stubs.resetApiCallCounts();
      const report = importReport(world);
      assert.equal(report.customers[0].files[0].outcome, 'WRITTEN');
      return gas.stubs.getApiCallCounts();
    }
    // 足す場合（測った値）：リースの確認 1・ロックの中の読み直し 1・読み戻し 1・
    // 監査の末尾 1 で batchGet +4、一覧の書込 1 で batchUpdate +1。
    // 足すものが無い場合は、1.1 と同じく差 0（ac 12 の C なしとの比較も同じ）。
    const appended = countsFor([[712, '仕入高']]);
    const already = countsFor([[712, '仕入高'], [843, '通信費']]);
    assert.deepEqual({batchGet: appended.batchGet - already.batchGet,
      batchUpdate: appended.batchUpdate - already.batchUpdate},
    {batchGet: 4, batchUpdate: 1},
    JSON.stringify({appended, already}));
  });
};

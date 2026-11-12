'use strict';

/**
 * 顧客一覧への登録（サーバー側）の受入。仕様 §6.1 の reg 1〜22。
 * 値はすべて架空。本番の ID・名前・Drive の ID は書かない。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const OWNER = 'owner@example.invalid';
  const REVIEWER = 'reviewer@example.invalid';
  const ADMIN = 'admin@example.invalid';
  const MASTER = 'rr-master-fake';
  const ROOT = 'rr-root-fake';
  const PERSONAL = 'rr-personal-fake';
  const CORPORATE_FOLDER = 'rr-corporate-fake';
  const WORK = 'rr-work-fake';
  const CORPUS = 'rr-corpus-fake';
  const OPS_PARENT = 'rr-ops-parent-fake';
  const TEMPLATE = 'rr-template-fake';
  const TEMPLATE_PARENT = 'rr-template-parent-fake';
  const TEMPLATE_SHEET = '架空入力';
  const CONTRACT = 'rr-contract-fake';
  const TX_INDEX = 'rr-txidx-fake';
  const SNAPSHOT = 'rr-snapshot-fake';
  const SOURCE_ID = 'K9001';
  const PROFILE_KEY = 'CUSTOMER_TEMPLATE_PROFILE_INDIVIDUAL';
  const PROFILE_CORPORATE_KEY = 'CUSTOMER_TEMPLATE_PROFILE_CORPORATE';

  function master() { return gas.stubs.getSpreadsheet(MASTER).getSheetByName('顧客マスター'); }
  function audit() { return gas.stubs.getSpreadsheet(MASTER).getSheetByName('監査ログ'); }
  function contractSheet() { return gas.stubs.getSpreadsheet(CONTRACT).getSheetByName('R8.契約内容'); }
  function snapshot() { return plain(master().getDataRange().getValues()); }
  function auditRows() {
    return audit().getDataRange().getValues().slice(1)
      .filter((row) => row[0] !== '' && row[0] !== null && row[0] !== undefined);
  }
  function auditOf(type) { return auditRows().filter((row) => String(row[2]) === type); }
  function props() { return gas.context.PropertiesService.getScriptProperties(); }
  function plainCall(name, args) {
    const result = gas.call(name, args || []);
    return result === undefined ? undefined : plain(result);
  }
  function withMocks(overrides, fn) {
    const saved = {};
    Object.keys(overrides).forEach((key) => { saved[key] = gas.context[key]; gas.context[key] = overrides[key]; });
    try { return fn(); } finally {
      Object.keys(saved).forEach((key) => { gas.context[key] = saved[key]; });
    }
  }
  function blank(length) { return Array(length).fill(''); }

  function syntheticSourceRow() {
    const row = blank(45);
    row[7] = TEMPLATE_SHEET;       // H
    row[8] = '架空取引先一覧';      // I
    row[9] = 2; row[10] = 3; row[11] = 4; row[12] = 5; row[13] = 6; row[14] = 7; // J〜O
    row[15] = '1.0';               // P
    row[20] = 'システム情報';       // U
    row[29] = 1;                   // AD
    row[30] = JSON.stringify({row: 1, allowExtraColumns: true,
      cells: [{column: 2, text: '利用日', match: 'exact'}]}); // AE
    row[31] = '{}';                // AF
    row[32] = '{}';                // AG
    row[33] = 20;                  // AH
    row[34] = '架空取引先一覧';      // AI
    row[37] = '[16]';              // AL（16 列目は空にしない）
    row[41] = 8;                   // AP（G 列）
    row[42] = 10;                  // AQ（L 列）
    row[43] = 17;                  // AR（C 列）
    row[44] = 'Q5:R6';             // AS（科目一覧）
    return row;
  }

  function createTemplate() {
    const header = ['', '利用日', '取引先', '摘要', '金額', 'メモ', '内部ID', '税区分',
      '勘定科目', '消費税', 'K列', 'L列', 'M列', 'N列', 'O列', '除外列', '科目A', '科目B',
      'その他', '数式列'];
    const row2 = ['', '2025-01-01', '架空店', '摘要1', 1000, 'メモ1', 'TX1', '課税10%',
      '旅費', '消費税1', 'K値1', 'L値1', 'M値1', 'N値1', 'O値1', '除外値1', '科目A1',
      '科目B1', 'その他1', ''];
    const row3 = ['', '2025-01-02', '架空店2', '摘要2', 2000, 'メモ2', 'TX2', '課税10%',
      '会議費', '消費税2', 'K値2', 'L値2', 'M値2', 'N値2', 'O値2', '除外値2', '科目A2',
      '科目B2', 'その他2', ''];
    const spreadsheet = gas.stubs.createSpreadsheet(TEMPLATE, {name: '架空雛形', sheets: [
      {name: TEMPLATE_SHEET, values: [header, row2, row3], maxRows: 24, maxColumns: 24},
      {name: '架空取引先一覧', values: [['架空取引先']]}
    ]});
    spreadsheet.getSheetByName(TEMPLATE_SHEET).getRange(2, 19).setFormula('=E2*2');
    return spreadsheet;
  }

  function createContract() {
    const rows = [
      ['', '備考', '備考'],
      ['', '', ''],
      ['', '取引先コード', '顧客名'],
      ['', 'K9002', '架空 太郎'],
      ['', 12, '架空 花子'],
      ['', 'BAD!', '架空 形式'],
      ['', 'K9003', '架空 重複A'],
      ['', 'K9003', '架空 重複B'],
      ['', 'K9001', '架空 元顧客'],
      ['', 'K9005', '架空 三郎'],
      ['', 'K9007', '架空 四郎'],
      ['', 'K9010', '架空 予備'],
      ['', 'K9011', '架空 選択']
    ];
    const spreadsheet = gas.stubs.createSpreadsheet(CONTRACT, {name: '架空別表', sheets: [
      {name: 'R8.契約内容', values: rows, maxRows: 40, maxColumns: 5}
    ]});
    const sheet = spreadsheet.getSheetByName('R8.契約内容');
    sheet.getRange(5, 2).setNumberFormat('0000');
    return spreadsheet;
  }

  function addCustomer(world, spec) {
    const folder = gas.stubs.createFolder(spec.id,
      {name: spec.name, parentId: spec.parentId || PERSONAL});
    const record = {key: spec.key, id: spec.id, name: spec.name, folder: folder, cards: []};
    let base = folder.id;
    if (spec.shared !== undefined) {
      record.shared = gas.stubs.createFolder(spec.id + '-shared', {name: spec.shared, parentId: base});
      base = record.shared.id;
    }
    if (spec.year !== undefined) {
      record.year = gas.stubs.createFolder(spec.id + '-year', {name: spec.year, parentId: base});
      base = record.year.id;
    }
    if (spec.accounting !== undefined) {
      record.accounting = gas.stubs.createFolder(spec.id + '-acc', {name: spec.accounting, parentId: base});
      base = record.accounting.id;
    }
    if (spec.statement !== undefined) {
      record.statement = gas.stubs.createFolder(spec.id + '-stmt', {name: spec.statement, parentId: base});
      base = record.statement.id;
    }
    (spec.cards || []).forEach((name, index) => {
      record.cards.push(gas.stubs.createFolder(spec.id + '-card' + index, {name: name, parentId: base}));
    });
    world.customers[spec.key] = record;
    return record;
  }

  function setup(options) {
    const opts = options || {};
    gas.stubs.reset();
    gas.stubs.createSpreadsheet(MASTER, {sheets: [{name: 'seed', values: [['seed']]}]});
    gas.stubs.setActiveSpreadsheet(MASTER);
    gas.call('setMasterSpreadsheetId', [MASTER]);
    gas.call('provisionMasterSheets');
    gas.stubs.setSpreadsheetOwner(MASTER, OWNER);
    gas.stubs.setActiveUser(OWNER);
    gas.stubs.createSpreadsheet(TX_INDEX, {sheets: []});
    gas.stubs.createSpreadsheet(SNAPSHOT, {sheets: []});
    gas.evaluate("SETTINGS.EXECUTION_TIMEOUT_SECONDS=300;" +
      "SETTINGS.SAFETY_MARGIN_SECONDS=60;" +
      "SETTINGS.TX_INDEX_SPREADSHEET_ID='" + TX_INDEX + "';" +
      "SETTINGS.SNAPSHOT_SPREADSHEET_ID='" + SNAPSHOT + "';" +
      "SETTINGS.SAMPLE_CORPUS_FOLDER_ID='" + CORPUS + "';" +
      "SETTINGS.PARALLEL_WORK_FOLDER_ID='';" +
      'SETTINGS.FAULT_INJECTION=null;');
    const root = gas.stubs.createFolder(ROOT, {name: '架空共通'});
    const personal = gas.stubs.createFolder(PERSONAL, {name: '個人', parentId: ROOT});
    const corporate = gas.stubs.createFolder(CORPORATE_FOLDER, {name: '法人', parentId: ROOT});
    const work = gas.stubs.createFolder(WORK, {name: '架空作業用'});
    const corpus = gas.stubs.createFolder(CORPUS, {name: '架空コーパス'});
    const opsParent = gas.stubs.createFolder(OPS_PARENT, {name: '架空作業親'});
    createTemplate();
    const templateParent = gas.stubs.createFolder(TEMPLATE_PARENT,
      {name: '架空雛形置場', fileIds: [TEMPLATE]});
    createContract();
    const world = {root: root, personal: personal, corporate: corporate, work: work,
      corpus: corpus, opsParent: opsParent, templateParent: templateParent, customers: {}};

    props().setProperty('CUSTOMER_ROOT_FOLDER_ID', ROOT);
    if (!opts.parallelEmpty) props().setProperty('PARALLEL_WORK_FOLDER_ID', WORK);
    if (!opts.contractEmpty) props().setProperty('CUSTOMER_ID_SOURCE_SPREADSHEET_ID', CONTRACT);

    addCustomer(world, {key: 'taro', id: 'rr-cust-taro',
      name: '【代※現金シート】架空 太郎', shared: '☆資料共有フォルダ', year: '令和8年分',
      accounting: '経費', statement: 'クレジットカード支払い分※カード毎にフォルダを作成してください。',
      cards: ['JCB', 'AUPAY']});
    addCustomer(world, {key: 'jiro', id: 'rr-cust-jiro', name: '【架空】架空 次郎',
      year: '令和8年分', accounting: '経理', statement: 'クレカ明細'});
    addCustomer(world, {key: 'saburo', id: 'rr-cust-saburo', name: '架空 三郎',
      year: '令和8年分', accounting: '費用', statement: 'カード利用明細', cards: ['VISA']});
    addCustomer(world, {key: 'shiro', id: 'rr-cust-shiro', name: '【A】【B】架空 四郎',
      year: '令和8年分', accounting: '経費', statement: 'クレジット明細'});
    addCustomer(world, {key: 'goro', id: 'rr-cust-goro', name: '架空 五郎',
      year: '令和8年分', accounting: '経費', statement: 'カード明細'});
    addCustomer(world, {key: 'otsu', id: 'rr-cust-otsu', name: '架空 別',
      year: '令和8年分', accounting: '経費', statement: 'カード明細2'});
    addCustomer(world, {key: 'source', id: 'rr-cust-source', name: '【元】架空 元顧客',
      shared: '☆資料共有', year: '令和8年分', accounting: '経費',
      statement: 'クレジットカード支払い分'});
    addCustomer(world, {key: 'choice', id: 'rr-cust-choice', name: '架空 選択',
      shared: '資料共有A', year: '令和8年分', accounting: '経費A', statement: 'カードA'});
    const choice = world.customers.choice;
    gas.stubs.createFolder('rr-choice-shared2', {name: '資料共有B', parentId: choice.folder.id});
    gas.stubs.createFolder('rr-choice-year2', {name: '令和9年分', parentId: choice.shared.id});
    gas.stubs.createFolder('rr-choice-yearpick', {name: 'その他年', parentId: choice.shared.id});
    gas.stubs.createFolder('rr-choice-acc2', {name: '経理B', parentId: choice.year.id});
    gas.stubs.createFolder('rr-choice-stmt2', {name: 'クレカB', parentId: choice.accounting.id});
    const nonExpense = gas.stubs.createFolder('rr-choice-nonexpense',
      {name: '雑費', parentId: 'rr-choice-year2'});
    gas.stubs.createFolder('rr-choice-other', {name: 'その他', parentId: nonExpense.id});
    addCustomer(world, {key: 'year9', id: 'rr-cust-year9', name: '架空 年9',
      year: '令和9年分', accounting: '経費', statement: 'カード明細'});
    addCustomer(world, {key: 'form', id: 'rr-cust-form', name: '架空 形式',
      year: '令和8年分', accounting: '経費', statement: 'カード明細'});
    addCustomer(world, {key: 'corp', id: 'rr-cust-corp', name: '架空 法人',
      parentId: CORPORATE_FOLDER, year: '令和8年分', accounting: '経費', statement: 'カード明細'});
    addCustomer(world, {key: 'yearWrong', id: 'rr-cust-yearwrong', name: '架空 年違い',
      year: '2026年分', accounting: '経費', statement: 'カード明細'});

    let profile = null;
    if (opts.seedSource !== false) {
      gas.call('registerTestCustomer', [{
        customerId: SOURCE_ID, customerName: '架空　元　顧客',
        sourceFolderId: world.customers.source.statement.id,
        destinationSpreadsheetId: TEMPLATE, destinationSheetName: TEMPLATE_SHEET,
        partnerListSheetName: '架空取引先一覧',
        columns: {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7, G: 8, L: 10, C: 17},
        headerRow: 1, rowScanLastColumn: 20, rowScanExcludedColumns: [16],
        accountListRange: 'Q5:R6', customerCategory: 'INDIVIDUAL', fiscalYear: 2026
      }]);
      const rows = gas.call('registrationMasterRows_');
      const source = rows.filter((row) => String(row.values[0]) === SOURCE_ID)[0];
      profile = plain(gas.call('registrationProfileFromRow_',
        [source.values, TEMPLATE, SOURCE_ID]));
      world.sourceRowNumber = source.rowNumber;
    } else {
      profile = plain(gas.call('registrationProfileFromRow_',
        [syntheticSourceRow(), TEMPLATE, SOURCE_ID]));
    }
    world.profile = profile;
    if (opts.profile !== undefined) {
      props().setProperty(PROFILE_KEY,
        typeof opts.profile === 'string' ? opts.profile : JSON.stringify(opts.profile));
    } else if (!opts.profileEmpty) {
      props().setProperty(PROFILE_KEY, JSON.stringify(profile));
    }
    if (opts.profileCorporate !== undefined) {
      props().setProperty(PROFILE_CORPORATE_KEY, opts.profileCorporate);
    }
    gas.stubs.resetApiCallCounts();
    gas.stubs.resetRoundTrips();
    gas.stubs.resetDriveOps();
    gas.stubs.resetPropertyCallCounts();
    gas.stubs.clearLogs();
    return world;
  }

  function registerRequest(world, overrides) {
    const customer = world.customers.taro;
    return Object.assign({
      category: 'INDIVIDUAL',
      customerFolderId: customer.id,
      statementFolderId: customer.statement.id,
      customerId: '0012',
      customerName: '架空 花子'
    }, overrides || {});
  }

  function findRow(customerId) {
    const rows = master().getDataRange().getValues();
    for (let index = 1; index < rows.length; index += 1) {
      if (String(rows[index][0]) === String(customerId)) return {values: rows[index], rowNumber: index + 1};
    }
    return null;
  }

  function assertNoWrites(before, auditBefore, driveBefore) {
    assert.deepEqual(snapshot(), before, '顧客マスターが変わっている');
    assert.equal(auditRows().length, auditBefore, '監査が増えている');
    assert.equal(gas.stubs.getDriveWrites().length, driveBefore === undefined ? 0 : driveBefore,
      'Drive に書いている');
  }

  // reg 1: 認可（S1）
  test('reg 1: the three entries reject everyone but the owner and keep PERMISSION audit', () => {
    const world = setup();
    const source = findRow(SOURCE_ID);
    master().getRange(source.rowNumber, 17).setValue(REVIEWER);
    master().getRange(source.rowNumber, 18).setValue(ADMIN);
    const entries = [
      ['webAppRegistrationStart', []],
      ['webAppRegistrationInspect', [world.customers.taro.id, {}]],
      ['webAppRegisterCustomer', [registerRequest(world)]]
    ];
    let permissionCount = auditOf('PERMISSION').length;
    [REVIEWER, ADMIN].forEach((email) => {
      gas.stubs.setActiveUser(email);
      entries.forEach(([name, args]) => {
        assert.throws(() => gas.call(name, args), (error) => error && error.name === 'AuthorizationError',
          name + ' must reject ' + email);
        permissionCount += 1;
        assert.equal(auditOf('PERMISSION').length, permissionCount, name + ' PERMISSION row');
      });
    });
    // オーナーは有効な顧客が 0 件でも通る。
    const empty = setup({seedSource: false});
    gas.stubs.setActiveUser(OWNER);
    const result = plainCall('webAppRegistrationStart');
    assert.equal(result.ready, true);
    assert.ok(result.customerFolders.length > 0);
    assert.equal(empty.profile.version, 1);
    assert.equal(gas.stubs.getDriveWrites().length, 0);
  });

  // reg 2: 準備の不足（S6）
  test('reg 2: every readiness code stops before any write', () => {
    const cases = [
      ['CUSTOMER_ROOT_FOLDER_ID', (world) => props().setProperty('CUSTOMER_ROOT_FOLDER_ID', '')],
      ['CATEGORY_FOLDER', (world) => { world.personal.name = '個人2'; }],
      ['PARALLEL_WORK_FOLDER_ID', () => props().setProperty('PARALLEL_WORK_FOLDER_ID', '')],
      ['PARALLEL_WORK_FOLDER_ID', () => props().setProperty('PARALLEL_WORK_FOLDER_ID', CORPUS)],
      ['CUSTOMER_TEMPLATE_PROFILE_INDIVIDUAL', () => props().setProperty(PROFILE_KEY, '')],
      ['PROFILE_INVALID', () => props().setProperty(PROFILE_KEY,
        JSON.stringify({version: 1, category: 'INDIVIDUAL', templateId: TEMPLATE, columns: {}}))],
      ['CUSTOMER_ID_SOURCE_SPREADSHEET_ID', () => props().setProperty('CUSTOMER_ID_SOURCE_SPREADSHEET_ID', '')]
    ];
    cases.forEach(([code, mutate]) => {
      const world = setup();
      mutate(world);
      const start = plainCall('webAppRegistrationStart');
      assert.equal(start.ready, false, code);
      assert.ok(start.missing.indexOf(code) >= 0, code + ' missing');
      assert.deepEqual(start.customerFolders, [], code + ' folders');
      const before = snapshot();
      const auditBefore = auditRows().length;
      const result = plainCall('webAppRegisterCustomer', [registerRequest(world)]);
      assert.equal(result.ok, false, code);
      assert.ok(['NOT_READY', 'PROFILE_INVALID'].indexOf(result.code) >= 0, code + ' -> ' + result.code);
      assertNoWrites(before, auditBefore, 0);
    });
  });

  // reg 3: 顧客フォルダの一覧
  test('reg 3: lists only personal children with display names and registered keys', () => {
    const world = setup();
    const result = plainCall('webAppRegistrationStart');
    const names = result.customerFolders.map((item) => item.folderName);
    assert.equal(names.indexOf('架空 法人'), -1);
    const byName = {};
    result.customerFolders.forEach((item) => { byName[item.folderName] = item; });
    assert.equal(byName['【代※現金シート】架空 太郎'].displayName, '架空 太郎');
    assert.equal(byName['【A】【B】架空 四郎'].displayName, '架空 四郎');
    assert.equal(byName['【元】架空 元顧客'].displayName, '架空 元顧客');
    assert.equal(byName['【元】架空 元顧客'].registered, true);
    assert.equal(byName['【代※現金シート】架空 太郎'].registered, false);
    const sorted = names.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(names, sorted);
    assert.equal(world.customers.taro.cards.length, 2);
  });

  // reg 4: 自動で決まる
  test('reg 4: resolves the documented path automatically with or without the shared stage', () => {
    const world = setup();
    const taro = plainCall('webAppRegistrationInspect', [world.customers.taro.id, {}]);
    assert.equal(taro.status, 'READY');
    assert.deepEqual(taro.path, ['☆資料共有フォルダ', '令和8年分', '経費',
      'クレジットカード支払い分※カード毎にフォルダを作成してください。']);
    assert.equal(taro.reiwaYear, 8);
    assert.equal(taro.fiscalYear, 2026);
    assert.deepEqual(taro.cardFolders, ['AUPAY', 'JCB']);
    assert.equal(taro.contract.status, 'MATCHED');
    assert.equal(taro.contract.matchedCustomerId, 'K9002');
    const jiro = plainCall('webAppRegistrationInspect', [world.customers.jiro.id, {}]);
    assert.equal(jiro.status, 'READY');
    assert.deepEqual(jiro.path, ['令和8年分', '経理', 'クレカ明細']);
    assert.equal(jiro.cardFolderWarning, 'NO_CARD_FOLDERS');
    assert.equal(jiro.folderProblem, null);
  });

  // reg 5: 選ばせる段
  test('reg 5: asks only the allowed children at each ambiguous stage and rejects bad picks', () => {
    const world = setup();
    const id = world.customers.choice.id;
    const sharedId = world.customers.choice.shared.id;
    const yearId = world.customers.choice.year.id;
    const shared = plainCall('webAppRegistrationInspect', [id, {}]);
    assert.equal(shared.status, 'NEED_CHOICE');
    assert.equal(shared.stage, 'shared');
    assert.deepEqual(shared.choices.map((item) => item.name), ['資料共有A', '資料共有B']);
    const year = plainCall('webAppRegistrationInspect', [id, {shared: sharedId}]);
    assert.equal(year.status, 'NEED_CHOICE');
    assert.equal(year.stage, 'year');
    assert.deepEqual(year.choices.map((item) => item.name), ['令和8年分', '令和9年分']);
    const accounting = plainCall('webAppRegistrationInspect',
      [id, {shared: sharedId, year: yearId}]);
    assert.equal(accounting.status, 'NEED_CHOICE');
    assert.equal(accounting.stage, 'accounting');
    assert.deepEqual(accounting.choices.map((item) => item.name), ['経理B', '経費A']);
    const statement = plainCall('webAppRegistrationInspect',
      [id, {shared: sharedId, year: yearId, accounting: 'rr-cust-choice-acc'}]);
    assert.equal(statement.status, 'NEED_CHOICE');
    assert.equal(statement.stage, 'statement');
    assert.deepEqual(statement.choices.map((item) => item.name), ['カードA', 'クレカB']);
    const ready = plainCall('webAppRegistrationInspect',
      [id, {shared: sharedId, year: yearId,
        accounting: 'rr-cust-choice-acc', statement: 'rr-cust-choice-stmt'}]);
    assert.equal(ready.status, 'READY');
    assert.equal(ready.reiwaYear, 8);
    // 型に当たる子が 0 の段は全部の子を見せる（令和9年分の下）。
    const noExpense = plainCall('webAppRegistrationInspect',
      [id, {shared: sharedId, year: 'rr-choice-year2'}]);
    assert.equal(noExpense.status, 'NEED_CHOICE');
    assert.equal(noExpense.stage, 'accounting');
    assert.deepEqual(noExpense.choices.map((item) => item.name), ['雑費']);
    const noStatement = plainCall('webAppRegistrationInspect',
      [id, {shared: sharedId, year: 'rr-choice-year2', accounting: 'rr-choice-nonexpense'}]);
    assert.equal(noStatement.status, 'NEED_CHOICE');
    assert.equal(noStatement.stage, 'statement');
    assert.deepEqual(noStatement.choices.map((item) => item.name), ['その他']);
    const year9Ready = plainCall('webAppRegistrationInspect',
      [id, {shared: sharedId, year: 'rr-choice-year2',
        accounting: 'rr-choice-nonexpense', statement: 'rr-choice-other'}]);
    assert.equal(year9Ready.status, 'READY');
    assert.equal(year9Ready.reiwaYear, 9);
    // 直下に無い ID・年の型に当たらない子を年として選ぶ。
    const outside = plainCall('webAppRegistrationInspect', [id, {shared: 'rr-choice-stmt2'}]);
    assert.equal(outside.status, 'STOPPED');
    assert.equal(outside.code, 'FOLDER_STRUCTURE');
    const wrongYear = plainCall('webAppRegistrationInspect', [id, {shared: sharedId,
      year: 'rr-choice-yearpick'}]);
    assert.equal(wrongYear.status, 'STOPPED');
    assert.equal(wrongYear.code, 'FOLDER_STRUCTURE');
  });

  // reg 6: 年の段が無い
  test('reg 6: reports YEAR_FOLDER_NOT_FOUND with child names', () => {
    const world = setup();
    const result = plainCall('webAppRegistrationInspect', [world.customers.yearWrong.id, {}]);
    assert.equal(result.status, 'STOPPED');
    assert.equal(result.code, 'YEAR_FOLDER_NOT_FOUND');
    assert.deepEqual(result.childNames, ['2026年分']);
  });

  // reg 7: 別表
  test('reg 7: reads the contract tab with FORMATTED_VALUE and marks unusable rows', () => {
    const world = setup();
    const taro = plainCall('webAppRegistrationInspect', [world.customers.taro.id, {}]);
    assert.equal(taro.contract.status, 'MATCHED');
    assert.equal(taro.contract.tabName, 'R8.契約内容');
    const byId = {};
    taro.contract.entries.forEach((entry) => { byId[entry.customerId] = entry; });
    assert.equal(byId['0012'].usable, true, 'formatted 0012');
    assert.equal(byId['BAD!'].problem, 'ID_FORMAT');
    assert.equal(byId['K9003'].problem, 'ID_REPEATED_IN_CONTRACT');
    assert.equal(byId['K9001'].problem, 'ID_DUPLICATE');
    const none = plainCall('webAppRegistrationInspect', [world.customers.goro.id, {}]);
    assert.equal(none.contract.status, 'NONE');
    // 2 件当たるタブ
    gas.stubs.getSpreadsheet(CONTRACT).insertSheet('Ｒ８.契約内容');
    const tabs = plainCall('webAppRegistrationInspect', [world.customers.taro.id, {}]);
    assert.equal(tabs.contract.status, 'CONTRACT_TAB_NOT_FOUND');
    gas.stubs.getSpreadsheet(CONTRACT).deleteSheet(
      gas.stubs.getSpreadsheet(CONTRACT).getSheetByName('Ｒ８.契約内容'));
    // 見出しが無い
    props().setProperty('CUSTOMER_ID_SOURCE_SPREADSHEET_ID', 'rr-contract-noheader');
    gas.stubs.createSpreadsheet('rr-contract-noheader', {sheets: [
      {name: 'R8.契約内容', values: [['', '名前', '値'], ['', 'K9002', '架空 太郎']]}]});
    const noHeader = plainCall('webAppRegistrationInspect', [world.customers.taro.id, {}]);
    assert.equal(noHeader.contract.status, 'CONTRACT_HEADER_NOT_FOUND');
    // 開けない
    props().setProperty('CUSTOMER_ID_SOURCE_SPREADSHEET_ID', 'rr-contract-missing');
    const unreadable = plainCall('webAppRegistrationInspect', [world.customers.taro.id, {}]);
    assert.equal(unreadable.contract.status, 'CONTRACT_UNREADABLE');
    // 年 9 のタブが無い
    props().setProperty('CUSTOMER_ID_SOURCE_SPREADSHEET_ID', CONTRACT);
    const year9 = plainCall('webAppRegistrationInspect', [world.customers.year9.id, {}]);
    assert.equal(year9.contract.status, 'CONTRACT_TAB_NOT_FOUND');
  });

  // reg 8: 登録の成功
  test('reg 8: writes the 45 columns with audit first and RAW values', () => {
    const world = setup();
    const before = snapshot();
    const auditBefore = auditRows().length;
    const events = [];
    const rowWrites = [];
    const realAudit = gas.context.appendAuditRowsUnlocked_;
    const realFlush = gas.context.SpreadsheetApp.flush;
    gas.context.appendAuditRowsUnlocked_ = function(entries) {
      events.push('audit'); return realAudit(entries);
    };
    gas.context.SpreadsheetApp.flush = function() {
      events.push('flush'); return realFlush.call(this);
    };
    gas.stubs.onValuesUpdate((body, id, range, options) => {
      events.push(/!C\d+$/.test(range) ? 'C' : 'row');
      if (!/!C\d+$/.test(range)) rowWrites.push({body: plain(body), options: plain(options)});
    });
    let result;
    try {
      result = plainCall('webAppRegisterCustomer', [registerRequest(world)]);
    } finally {
      gas.context.appendAuditRowsUnlocked_ = realAudit;
      gas.context.SpreadsheetApp.flush = realFlush;
      gas.stubs.onValuesUpdate(null);
    }
    assert.equal(result.ok, true);
    assert.equal(result.alreadyRegistered, false);
    assert.equal(result.rowNumber, 3);
    const auditIndex = events.indexOf('audit');
    const rowIndex = events.indexOf('row');
    assert.ok(auditIndex >= 0 && rowIndex > auditIndex, 'audit must precede the row write');
    assert.ok(events.slice(auditIndex, rowIndex).indexOf('flush') >= 0, 'flush between audit and row');
    assert.equal(rowWrites.length, 1);
    assert.equal(rowWrites[0].options.valueInputOption, 'RAW');
    assert.equal(rowWrites[0].body.values[0][2], false, 'C starts false');
    assert.equal(auditOf('CUSTOMER_REGISTER').length, 1);
    const registered = findRow('0012');
    assert.ok(registered);
    const row = registered.values;
    assert.strictEqual(row[0], '0012');
    assert.strictEqual(row[1], '架空 花子');
    assert.strictEqual(row[2], true);
    assert.strictEqual(row[3], world.customers.taro.statement.id);
    assert.strictEqual(row[5], TEMPLATE);
    assert.strictEqual(row[16], OWNER);
    assert.strictEqual(row[17], OWNER);
    assert.strictEqual(row[35], 'INDIVIDUAL');
    assert.strictEqual(row[36], 2026);
    const profileIndex = {H: 7, I: 8, J: 9, K: 10, L: 11, M: 12, N: 13, O: 14, P: 15,
      U: 20, AD: 29, AE: 30, AF: 31, AG: 32, AH: 33, AI: 34,
      AL: 37, AM: 38, AN: 39, AO: 40, AP: 41, AQ: 42, AR: 43, AS: 44};
    Object.keys(profileIndex).forEach((key) => {
      assert.deepEqual(row[profileIndex[key]], world.profile.columns[key], key);
    });
    const customer = plainCall('getCustomerById', ['0012']);
    assert.equal(customer.customerName, '架空 花子');
    assert.equal(customer.fiscalYear, 2026);
    const bootstrap = plainCall('webAppBootstrap');
    assert.ok(bootstrap.customers.some((item) => item.customerId === '0012'));
    assert.deepEqual(snapshot().slice(0, before.length), before,
      'existing rows are unchanged');
  });

  // reg 9: 書き順
  test('reg 9: writes C false, reads back, then writes C true', () => {
    const world = setup();
    const events = [];
    gas.stubs.onValuesUpdate((body, id, range, options) => {
      events.push({kind: /!C\d+$/.test(range) ? 'C' : 'row', values: plain(body.values),
        option: options.valueInputOption, reads: gas.stubs.getApiCallCounts().batchGet});
    });
    try {
      const result = plainCall('webAppRegisterCustomer', [registerRequest(world)]);
      assert.equal(result.ok, true);
    } finally {
      gas.stubs.onValuesUpdate(null);
    }
    assert.deepEqual(events.map((event) => event.kind), ['row', 'C']);
    assert.equal(events[0].values[0][2], false);
    assert.equal(events[1].values[0][0], true);
    assert.ok(events[1].reads > events[0].reads, 'a read sits between the two writes');
    assert.deepEqual(events.map((event) => event.option), ['RAW', 'RAW']);
  });

  function assertFolderStructure(world, overrides) {
    const before = snapshot();
    const auditBefore = auditRows().length;
    const result = plainCall('webAppRegisterCustomer', [registerRequest(world, overrides)]);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FOLDER_STRUCTURE', JSON.stringify(overrides));
    assertNoWrites(before, auditBefore, 0);
  }

  // reg 10: 改ざんした要求（S9）
  test('reg 10: rejects every statement folder outside the two documented paths', () => {
    let world = setup();
    gas.stubs.createFolder('rr-unrelated-folder', {name: '架空無関係'});
    assertFolderStructure(world, {statementFolderId: 'rr-unrelated-folder'});
    assertFolderStructure(world, {statementFolderId: world.customers.jiro.statement.id});
    assertFolderStructure(world, {statementFolderId: world.customers.taro.year.id});
    assertFolderStructure(world, {statementFolderId: world.customers.taro.accounting.id});
    assertFolderStructure(world, {statementFolderId: world.customers.taro.cards[1].id});

    world = setup();
    assertFolderStructure(world, {
      customerFolderId: world.customers.yearWrong.id,
      statementFolderId: world.customers.yearWrong.statement.id});

    world = setup();
    gas.stubs.createFolder('rr-extra-parent', {name: '架空別親',
      subFolderIds: [world.customers.taro.statement.id]});
    assertFolderStructure(world, {});

    world = setup();
    assertFolderStructure(world, {customerFolderId: world.customers.corp.id,
      statementFolderId: world.customers.corp.statement.id});

    world = setup();
    gas.stubs.createFolder('rr-other-root', {name: '架空別共通'});
    gas.stubs.createFolder('rr-other-personal', {name: '個人', parentId: 'rr-other-root'});
    gas.stubs.createFolder('rr-other-customer', {name: '架空 別所', parentId: 'rr-other-personal'});
    assertFolderStructure(world, {customerFolderId: 'rr-other-customer'});

    world = setup();
    assertFolderStructure(world, {statementFolderId: CORPUS});
    assertFolderStructure(world, {statementFolderId: WORK});
  });

  // reg 11: ID
  test('reg 11: accepts only usable IDs that exist in the contract', () => {
    const cases = [['K9999', 'ID_NOT_IN_CONTRACT'], ['BAD!', 'ID_FORMAT'],
      ['K9003', 'ID_REPEATED_IN_CONTRACT'], ['K9001', 'ID_DUPLICATE'],
      ['k9001', 'ID_DUPLICATE'], ['Ｋ９００１', 'ID_DUPLICATE']];
    cases.forEach(([customerId, code]) => {
      const world = setup();
      const before = snapshot();
      const auditBefore = auditRows().length;
      const result = plainCall('webAppRegisterCustomer',
        [registerRequest(world, {customerId: customerId, customerName: '架空 名前'})]);
      assert.equal(result.ok, false, customerId);
      assert.equal(result.code, code, customerId);
      assertNoWrites(before, auditBefore, 0);
    });
  });

  // reg 12: 名前
  test('reg 12: rejects the five name problems including duplicates on inactive rows', () => {
    const world = setup();
    const inactive = blank(45);
    inactive[0] = 'K9099'; inactive[1] = '架空 重複名'; inactive[2] = false;
    master().appendRow(inactive);
    const cases = [['', 'NAME_EMPTY'], ['あ'.repeat(51), 'NAME_TOO_LONG'],
      ['架空\u0001名', 'NAME_INVALID_CHAR'], ['架空_20261112-1200', 'NAME_RESERVED_SUFFIX'],
      ['架空　重複 名', 'NAME_DUPLICATE']];
    cases.forEach(([customerName, code]) => {
      const before = snapshot();
      const auditBefore = auditRows().length;
      const result = plainCall('webAppRegisterCustomer',
        [registerRequest(world, {customerName: customerName})]);
      assert.equal(result.ok, false, code);
      assert.equal(result.code, code);
      assertNoWrites(before, auditBefore, 0);
    });
  });

  // reg 13: D
  test('reg 13: rejects a registered D and a D inside a registered folder', () => {
    const world = setup();
    const first = plainCall('webAppRegisterCustomer', [registerRequest(world)]);
    assert.equal(first.ok, true);
    const before = snapshot();
    const auditBefore = auditRows().length;
    const duplicate = plainCall('webAppRegisterCustomer',
      [registerRequest(world, {customerId: 'K9010', customerName: '架空 予備'})]);
    assert.equal(duplicate.code, 'FOLDER_ALREADY_REGISTERED');
    assertNoWrites(before, auditBefore, 0);

    const overlap = setup();
    const row = blank(45);
    row[0] = 'K9098'; row[1] = '架空 重なられ'; row[2] = false;
    row[3] = overlap.customers.taro.year.id;
    master().appendRow(row);
    const overlapBefore = snapshot();
    const overlapAudit = auditRows().length;
    const blocked = plainCall('webAppRegisterCustomer', [registerRequest(overlap)]);
    assert.equal(blocked.code, 'FOLDER_OVERLAPS');
    assertNoWrites(overlapBefore, overlapAudit, 0);
  });

  // reg 14: 2 回目
  test('reg 14: a repeated request is a success without a second row or audit', () => {
    const world = setup();
    const first = plainCall('webAppRegisterCustomer', [registerRequest(world)]);
    assert.equal(first.ok, true);
    const rowsAfterFirst = snapshot().length;
    const auditsAfterFirst = auditRows().length;
    const second = plainCall('webAppRegisterCustomer', [registerRequest(world)]);
    assert.equal(second.ok, true);
    assert.equal(second.alreadyRegistered, true);
    assert.equal(second.rowNumber, first.rowNumber);
    assert.equal(snapshot().length, rowsAfterFirst);
    assert.equal(auditRows().length, auditsAfterFirst);
    // 同じ ID で D が違えば ID_DUPLICATE。
    const other = plainCall('webAppRegisterCustomer',
      [registerRequest(world, {customerFolderId: world.customers.otsu.id,
        statementFolderId: world.customers.otsu.statement.id, customerName: '架空 花子2'})]);
    assert.equal(other.ok, false);
    assert.equal(other.code, 'ID_DUPLICATE');
    assert.equal(snapshot().length, rowsAfterFirst);
    assert.equal(auditRows().length, auditsAfterFirst);
  });

  // reg 15: 途中の失敗（S3・S5）
  test('reg 15: audit and write failures never leave an active invalid row', () => {
    let world = setup();
    const auditReal = gas.context.appendAuditRowsUnlocked_;
    gas.context.appendAuditRowsUnlocked_ = function() { throw new Error('rr-audit-failure'); };
    try {
      assert.throws(() => gas.call('webAppRegisterCustomer', [registerRequest(world)]),
        (error) => error && error.code === 'REQUIRED_LOG_WRITE_FAILED');
    } finally {
      gas.context.appendAuditRowsUnlocked_ = auditReal;
    }
    assert.equal(findRow('0012'), null);
    assert.equal(auditOf('CUSTOMER_REGISTER').length, 0);

    // 行の書込が失敗する
    world = setup();
    let fired = false;
    gas.stubs.onValuesUpdate((body, id, range) => {
      if (!fired && /!A\d+:AS\d+$/.test(range)) { fired = true; throw new Error('rr-write-failure'); }
    });
    let result;
    try {
      result = plainCall('webAppRegisterCustomer', [registerRequest(world)]);
    } finally {
      gas.stubs.onValuesUpdate(null);
    }
    assert.equal(result.code, 'WRITE_VERIFY_FAILED');
    assert.equal(findRow('0012'), null);
    assert.equal(auditOf('CUSTOMER_REGISTER').filter((row) => row[11] === 'WEBAPP_FAILED').length, 1);

    // 読み返した 1 セルが違う（B を変える）
    world = setup();
    gas.stubs.onValuesUpdate((body, id, range) => {
      if (/!A\d+:AS\d+$/.test(range)) {
        const copy = body.values[0].slice();
        copy[1] = '改ざんされた名前';
        body.values = [copy];
      }
    });
    try {
      result = plainCall('webAppRegisterCustomer', [registerRequest(world)]);
    } finally {
      gas.stubs.onValuesUpdate(null);
    }
    assert.equal(result.code, 'WRITE_VERIFY_FAILED');
    assert.equal(findRow('0012').values[2], false);
    assert.equal(plainCall('getActiveCustomers').length, 1);

    // C の書込は通ったが、読み返しが false
    world = setup();
    let rowWritten = false;
    gas.stubs.onValuesUpdate((body, id, range) => {
      if (/!A\d+:AS\d+$/.test(range)) rowWritten = true;
      if (rowWritten && /!C\d+$/.test(range)) body.values = [[false]];
    });
    try {
      result = plainCall('webAppRegisterCustomer', [registerRequest(world)]);
    } finally {
      gas.stubs.onValuesUpdate(null);
    }
    assert.equal(result.code, 'WRITE_VERIFY_FAILED');
    assert.equal(findRow('0012').values[2], false);
    assert.equal(plainCall('getActiveCustomers').length, 1);
  });

  function withLockInjection(change, fn) {
    const real = gas.context.withScriptLock_;
    let injected = false;
    gas.context.withScriptLock_ = function(callback) {
      if (!injected) { injected = true; change(); }
      return real(callback);
    };
    try { return fn(); } finally { gas.context.withScriptLock_ = real; }
  }

  function appendMasterRow(customerId, name, statementFolderId) {
    const row = blank(45);
    row[0] = customerId;
    row[1] = name;
    row[2] = false;
    row[3] = statementFolderId || '';
    master().appendRow(row);
  }

  // reg 16: ロックの中の確かめ直し（S4）
  test('reg 16: rechecks the current rows inside the lock', () => {
    let world = setup();
    let result = withLockInjection(() => appendMasterRow('0012', '架空 割込み', ''), () =>
      plainCall('webAppRegisterCustomer', [registerRequest(world)]));
    assert.equal(result.code, 'ID_DUPLICATE');
    assert.equal(findRow('0012').values[2], false);
    assert.equal(auditOf('CUSTOMER_REGISTER').length, 0);

    world = setup();
    result = withLockInjection(() => appendMasterRow('K9097', '架空 花子', ''), () =>
      plainCall('webAppRegisterCustomer', [registerRequest(world)]));
    assert.equal(result.code, 'NAME_DUPLICATE');

    world = setup();
    result = withLockInjection(() =>
      appendMasterRow('K9096', '架空 別名', world.customers.taro.statement.id), () =>
      plainCall('webAppRegisterCustomer', [registerRequest(world)]));
    assert.equal(result.code, 'FOLDER_ALREADY_REGISTERED');
  });

  // reg 17: プロファイル
  test('reg 17: malformed profiles are PROFILE_INVALID without any write', () => {
    const world = setup();
    const variants = [];
    const short = plain(world.profile);
    delete short.columns.H;
    variants.push(short);
    const long = plain(world.profile);
    long.columns.AT = 'x';
    variants.push(long);
    const badJson = plain(world.profile);
    badJson.columns.AE = '{not json';
    variants.push(badJson);
    const emptyTemplate = plain(world.profile);
    emptyTemplate.templateId = '';
    variants.push(emptyTemplate);
    variants.forEach((profile) => {
      props().setProperty(PROFILE_KEY, JSON.stringify(profile));
      const before = snapshot();
      const auditBefore = auditRows().length;
      const result = plainCall('webAppRegisterCustomer', [registerRequest(world)]);
      assert.equal(result.code, 'PROFILE_INVALID');
      assertNoWrites(before, auditBefore, 0);
    });
  });

  // reg 18: Drive に書かない（S2）
  test('reg 18: no entry writes Drive or opens a statement file', () => {
    const world = setup();
    const driveBefore = gas.stubs.getDriveWrites().length;
    plainCall('webAppRegistrationStart');
    plainCall('webAppRegistrationInspect', [world.customers.taro.id, {}]);
    const success = plainCall('webAppRegisterCustomer', [registerRequest(world)]);
    assert.equal(success.ok, true);
    plainCall('webAppRegisterCustomer', [registerRequest(world, {customerId: 'BAD!'})]);
    plainCall('webAppRegisterCustomer', [registerRequest(world, {statementFolderId: CORPUS})]);
    plainCall('webAppRegistrationInspect', [world.customers.corp.id, {}]);
    assert.equal(gas.stubs.getDriveWrites().length, driveBefore, 'no Drive writes');
    const listFiles = gas.stubs.getDriveOps().filter((item) => item.op === 'listFiles');
    assert.deepEqual(listFiles, [], 'no getFiles on a customer folder');
    const opened = gas.stubs.getOpenedSpreadsheetIds();
    assert.equal(opened.indexOf(TEMPLATE), -1);
    assert.equal(opened.indexOf(world.customers.taro.statement.id), -1);
  });

  // reg 19: 名簿を出さない（S10）
  test('reg 19: logs audits and errors never reveal other contract rows', () => {
    const world = setup();
    plainCall('webAppRegistrationStart');
    plainCall('webAppRegistrationInspect', [world.customers.taro.id, {}]);
    plainCall('webAppRegisterCustomer', [registerRequest(world)]);
    props().setProperty('CUSTOMER_ID_SOURCE_SPREADSHEET_ID', 'rr-contract-missing');
    let thrown = null;
    try { gas.call('webAppRegistrationInspect', [world.customers.taro.id, {}]); }
    catch (error) { thrown = error; }
    const text = JSON.stringify({logs: gas.stubs.getLogs(), audit: auditRows(),
      error: thrown ? String(thrown.message) + String(thrown.stack) : ''});
    ['K9002', 'K9003', 'K9010', 'BAD!', '架空 太郎', '架空 重複A', '架空 形式', '架空 予備']
      .forEach((secret) => assert.equal(text.indexOf(secret), -1, secret));
    assert.ok(plainCall('webAppRegistrationStart').ready);
  });

  // reg 20: 取込のガード（S7）
  test('reg 20: runImport skips only the customer that shares the template', () => {
    let world = setup();
    let report = plainCall('runImport', [{}]);
    assert.equal(report.customers.length, 1);
    assert.equal(report.customers[0].skipped, 'TEMPLATE_DIRECT_WRITE');
    assert.equal(report.customers[0].files.length, 0);
    assert.equal(gas.stubs.getDriveWrites().length, 0);

    world = setup();
    report = plainCall('runImport', [{destinationSpreadsheetId: 'rr-destination-fake'}]);
    assert.notEqual(report.customers[0].skipped, 'TEMPLATE_DIRECT_WRITE');

    world = setup();
    report = plainCall('runImport', [{prepareOnly: true}]);
    assert.notEqual(report.customers[0].skipped, 'TEMPLATE_DIRECT_WRITE');

    world = setup();
    master().getRange(world.sourceRowNumber, 6).setValue('rr-other-template');
    report = plainCall('runImport', [{}]);
    assert.notEqual(report.customers[0].skipped, 'TEMPLATE_DIRECT_WRITE');

    world = setup();
    props().setProperty(PROFILE_KEY, '{not json');
    report = plainCall('runImport', [{}]);
    assert.equal(report.customers[0].skipped, 'TEMPLATE_PROFILE_UNREADABLE');

    world = setup();
    props().deleteProperty(PROFILE_KEY);
    props().deleteProperty(PROFILE_CORPORATE_KEY);
    report = plainCall('runImport', [{}]);
    assert.notEqual(report.customers[0].skipped, 'TEMPLATE_DIRECT_WRITE');
  });

  function opsOptions(world) {
    return {workParentFolderId: world.opsParent.id, templateFolderId: TEMPLATE_PARENT,
      contractSpreadsheetId: CONTRACT, sourceCustomerId: SOURCE_ID};
  }

  function opsWorld() {
    return setup({profileEmpty: true, parallelEmpty: true, contractEmpty: true});
  }

  // reg 21: 準備用の関数・見るだけ
  test('reg 21: opsPrepare dry run writes nothing and reports only counts', () => {
    const world = opsWorld();
    const before = snapshot();
    const auditBefore = auditRows().length;
    const report = plainCall('opsPrepareCustomerRegistration', [opsOptions(world), false]);
    assert.equal(report.applied, false);
    assert.equal(report.stoppedBy, null);
    assert.deepEqual(report.plan, {workFolder: 'CREATE', template: 'CREATE', profile: 'CREATE',
      contract: 'CREATE', productionMaster: 'CREATE'});
    assert.equal(gas.stubs.getPropertyWrites().length, 0);
    assert.equal(gas.stubs.getDriveWrites().length, 0);
    assert.equal(auditRows().length, auditBefore);
    assert.deepEqual(snapshot(), before);
    assert.equal(report.profile.ok, true);
    assert.ok(report.profile.bytes > 0);
    assert.equal(report.contract.length, 1);
    assert.deepEqual(report.contract[0],
      {tabName: 'R8.契約内容', headerRow: 3, dataRows: 10, idFormat: 1,
        repeatedIds: 1, emptyNames: 0});
    const column16 = report.template.inputSheet.columns.filter((item) => item.column === 16)[0];
    assert.equal(column16.tag, 'excluded');
    assert.equal(column16.nonEmpty, 2);
    const column18 = report.template.inputSheet.columns.filter((item) => item.column === 18)[0];
    assert.equal(column18.tag, 'accountList');
    const text = JSON.stringify(report);
    ['K9002', 'K9003', '架空 太郎', '架空 花子', '架空店', '秘密のセル値'].forEach((secret) => {
      assert.equal(text.indexOf(secret), -1, secret);
    });
  });

  // reg 22: 準備用の関数・apply（S11・S12）
  test('reg 22: apply creates settings, clears only system columns, and reruns cleanly', () => {
    const world = opsWorld();
    const before = snapshot();
    const order = [];
    const realAudit = gas.context.appendAudit;
    gas.context.appendAudit = function(entry) { order.push('audit'); return realAudit(entry); };
    const scriptProperties = props();
    const realSet = scriptProperties.setProperty;
    scriptProperties.setProperty = function(key, value) {
      assert.ok(order.indexOf('audit') >= 0, 'audit before property ' + key);
      order.push('property:' + key);
      return realSet.call(this, key, value);
    };
    let report;
    try {
      report = plainCall('opsPrepareCustomerRegistration', [opsOptions(world), true]);
    } finally {
      gas.context.appendAudit = realAudit;
      scriptProperties.setProperty = realSet;
    }
    assert.equal(report.stoppedBy, null);
    assert.equal(report.applied, true);
    assert.equal(auditOf('SETTING').filter((row) => row[11] === 'PREPARE_CUSTOMER_REGISTRATION').length, 5);
    const workWrites = gas.stubs.getDriveWrites().filter((item) =>
      ['createFolder', 'copyFile'].indexOf(item.op) >= 0);
    assert.equal(workWrites.length, 2);
    assert.ok(order.indexOf('property:PARALLEL_WORK_FOLDER_ID') >= 0);
    assert.ok(order.indexOf('property:' + PROFILE_KEY) >= 0);
    assert.ok(order.indexOf('property:CUSTOMER_ID_SOURCE_SPREADSHEET_ID') >= 0);
    assert.ok(order.indexOf('property:PRODUCTION_MASTER_SPREADSHEET_ID') >= 0);
    assert.equal(gas.stubs.getPropertyWrites().length, 4);
    const profile = JSON.parse(props().getProperty(PROFILE_KEY));
    const copy = gas.stubs.getSpreadsheet(profile.templateId);
    assert.ok(copy);
    const input = copy.getSheetByName(TEMPLATE_SHEET);
    const cleared = [2, 3, 4, 5, 6, 7, 8, 10, 17];
    for (let row = 2; row <= 3; row += 1) {
      cleared.forEach((column) => assert.equal(input.getRange(row, column).getValue(), '',
        'cleared ' + row + ':' + column));
    }
    assert.equal(input.getRange(2, 16).getValue(), '除外値1');
    assert.equal(input.getRange(2, 18).getValue(), '科目B1');
    assert.equal(input.getRange(2, 19).getValue(), 'その他1');
    assert.equal(input.getRange(2, 19).getFormula(), '=E2*2');
    assert.equal(input.getRange(2, 11).getValue(), 'K値1');
    assert.deepEqual(copy.getSheetByName('架空取引先一覧').getDataRange().getValues(),
      [['架空取引先']]);
    assert.deepEqual(snapshot().slice(0, before.length), before);

    // 2 回目は全部 ALREADY_SET で何も書かない。
    const writesBefore = gas.stubs.getPropertyWrites().length;
    const driveBefore = gas.stubs.getDriveWrites().length;
    const auditsBefore = auditOf('SETTING').length;
    const second = plainCall('opsPrepareCustomerRegistration', [opsOptions(world), true]);
    assert.deepEqual(second.plan, {workFolder: 'ALREADY_SET', template: 'ALREADY_SET',
      profile: 'ALREADY_SET', contract: 'ALREADY_SET', productionMaster: 'ALREADY_SET'});
    assert.equal(gas.stubs.getPropertyWrites().length, writesBefore);
    assert.equal(gas.stubs.getDriveWrites().length, driveBefore);
    assert.equal(auditOf('SETTING').length, auditsBefore);
  });

  test('reg 22b: apply stops on every conflict without writing', () => {
    const cases = [
      (world) => props().setProperty('PARALLEL_WORK_FOLDER_ID', WORK),
      (world) => { world.opsParent.subFolderIds.push(CORPUS); world.corpus.name = '作業用'; },
      (world) => {
        gas.stubs.createSpreadsheet('rr-existing-copy', {name: '雛形（個人）'});
        world.templateParent.fileIds.push('rr-existing-copy');
      },
      // 作業用の親が親を 2 つ持つ（場所が分からない → CONFLICT・何も書かない）。
      (world) => {
        ['rr-ops-parent-extra1', 'rr-ops-parent-extra2'].forEach((id) => {
          gas.stubs.createFolder(id, {name: '架空別作業親'}).subFolderIds.push(world.opsParent.id);
        });
      }
    ];
    cases.forEach((mutate, caseIndex) => {
      const world = opsWorld();
      mutate(world);
      gas.stubs.resetPropertyCallCounts();
      const before = snapshot();
      const auditBefore = auditRows().length;
      const report = plainCall('opsPrepareCustomerRegistration', [opsOptions(world), true]);
      assert.equal(report.stoppedBy, 'CONFLICT', 'case ' + caseIndex);
      assert.equal(report.applied, false, 'case ' + caseIndex);
      assert.equal(gas.stubs.getPropertyWrites().length, 0, 'property case ' + caseIndex);
      assert.equal(gas.stubs.getDriveWrites().length, 0, 'drive case ' + caseIndex);
      assert.equal(auditRows().length, auditBefore, 'audit case ' + caseIndex);
      assert.deepEqual(snapshot(), before, 'master case ' + caseIndex);
      if (caseIndex === 3) {
        assert.equal(report.workFolder.parentLocationUnknown, true, 'unknown parent location');
      }
    });
    // 親が顧客フォルダの中
    const world = opsWorld();
    const before = snapshot();
    const auditBefore = auditRows().length;
    const report = plainCall('opsPrepareCustomerRegistration',
      [{workParentFolderId: world.customers.taro.folder.id, templateFolderId: TEMPLATE_PARENT,
        contractSpreadsheetId: CONTRACT, sourceCustomerId: SOURCE_ID}, true]);
    assert.equal(report.stoppedBy, 'CONFLICT');
    assert.equal(gas.stubs.getPropertyWrites().length, 0);
    assert.equal(gas.stubs.getDriveWrites().length, 0);
    assert.equal(auditRows().length, auditBefore);
    assert.deepEqual(snapshot(), before);
  });

  // reg 23: 59 の関数名が他の .gs と重ならない（F1）
  test('reg 23: no top-level function in 59 shares a name with another .gs file', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const topLevelFunctions = (source) => {
      const names = [];
      const pattern = /^function\s+([A-Za-z0-9_$]+)\s*\(/gm;
      let match;
      while ((match = pattern.exec(source)) !== null) names.push(match[1]);
      return names;
    };
    const srcDir = path.join(__dirname, '..', 'src');
    const own = topLevelFunctions(fs.readFileSync(
      path.join(srcDir, '59_CustomerRegistration.gs'), 'utf8'));
    assert.ok(own.length > 0);
    const collisions = [];
    fs.readdirSync(srcDir)
      .filter((file) => file.endsWith('.gs') && file !== '59_CustomerRegistration.gs')
      .forEach((file) => {
        const source = fs.readFileSync(path.join(srcDir, file), 'utf8');
        topLevelFunctions(source).forEach((name) => {
          if (own.indexOf(name) >= 0) collisions.push(file + ':' + name);
        });
      });
    assert.deepEqual(collisions, []);
    // 97 と同じ名前の互換名は戻っていない。
    ['diagSortedEntries_', 'diagChooseChildFolder_'].forEach((name) => {
      assert.equal(own.indexOf(name), -1, name);
    });
  });

  // reg 24: 下調べと登録で同じ道の確かめをする（F2）
  test('reg 24: inspect reports the path problem that registration would stop on', () => {
    const world = setup();
    const flat = addCustomer(world, {key: 'flat', id: 'rr-cust-flat', name: '架空 平',
      shared: '☆資料共有', year: '令和8年分', accounting: 'クレカ', statement: 'AUPAY'});
    const inspect = plainCall('webAppRegistrationInspect', [flat.id,
      {accounting: flat.accounting.id, statement: flat.statement.id}]);
    assert.equal(inspect.status, 'READY');
    assert.equal(inspect.folderProblem, 'FOLDER_STRUCTURE');
    const before = snapshot();
    const auditBefore = auditRows().length;
    const result = plainCall('webAppRegisterCustomer', [{
      category: 'INDIVIDUAL',
      customerFolderId: flat.id,
      statementFolderId: flat.statement.id,
      customerId: 'K9002',
      customerName: '架空 花子'
    }]);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FOLDER_STRUCTURE');
    assertNoWrites(before, auditBefore, 0);
    // §2.1 の形の顧客は null のまま。
    const taro = plainCall('webAppRegistrationInspect', [world.customers.taro.id, {}]);
    assert.equal(taro.status, 'READY');
    assert.equal(taro.folderProblem, null);
  });
};

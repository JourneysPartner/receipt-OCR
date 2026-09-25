'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 認可は「拒否側だけ」「許可側だけ」では全員許可・全員拒否を見逃すため、
 * 役割・顧客・入口ごとに両側を固定する。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const blank = (length) => Array(length).fill('');

  const OPERATION_ROLE_EXPECTATIONS = {
    ADOPT_EXISTING_PARTNER: 'REVIEWER',
    REQUEST_NEW_PARTNER: 'REVIEWER',
    RESOLVE_WITHOUT_PARTNER: 'REVIEWER',
    RESOLVE_PARTNER_UNKNOWN: 'REVIEWER',
    FIX_DATE_AMOUNT: 'REVIEWER',
    POST_ZERO_AMOUNT: 'REVIEWER',
    POST_PRIOR_YEAR: 'REVIEWER',
    EXCLUDE_PRIOR_YEAR: 'REVIEWER',
    EXCLUDE: 'REVIEWER',
    ACCEPT_MANUAL_CHANGE: 'REVIEWER',
    REVERT_TO_SYSTEM_VALUE: 'REVIEWER',
    RESTORE_ROW: 'OWNER_ADMIN',
    ACCEPT_DELETION: 'REVIEWER',
    CONFIRM_FREEE_FIXED: 'REVIEWER',
    CONFIRM_INTEGRITY_RESOLVED: 'SYSTEM_ADMIN',
    REGISTER_FORMAT: 'SYSTEM_ADMIN',
    RETURN_TO_CUSTOMER: 'SYSTEM_ADMIN',
    SELECT_TARGET_SHEET: 'SYSTEM_ADMIN',
    CANCEL_FILE: 'REVIEWER',
    IMPORT_AS_NEW_FILE: 'REVIEWER',
    UPDATE_PURPOSE: 'REVIEWER',
    KEEP_ORIGINAL_RESULT: 'REVIEWER',
    APPLY_FILE_DIFF: 'REVIEWER',
    ADOPT_AS_NEW_TRANSACTION: 'REVIEWER',
    APPROVE_COUNT_MISMATCH: 'REVIEWER',
    REJECT_COUNT_MISMATCH: 'REVIEWER',
    CONFIRM_EMPTY_FILE: 'REVIEWER',
    RESIZE_INPUT: 'OWNER_ADMIN',
    CONFIRM_DESTINATION_FIXED: 'SYSTEM_ADMIN',
    APPROVE_SCAN_TRUNCATION: 'SYSTEM_ADMIN'
  };

  function destination(id) {
    gas.stubs.createSpreadsheet(id, {sheets: [
      {name: '入力用シート', values: [[
        '', '利用日', '取引先', '摘要', '金額', 'メモ', '内部ID', '税区分'
      ]], maxRows: 20, maxColumns: 8},
      {name: '取引先一覧', values: [['取引先']]}
    ]});
  }

  function registerCustomer(config) {
    destination(config.destinationSpreadsheetId);
    gas.stubs.createFolder('folder_' + config.customerId, {fileIds: []});
    gas.call('registerTestCustomer', [Object.assign({
      sourceFolderId: 'folder_' + config.customerId,
      destinationSheetName: '入力用シート',
      columns: {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7, G: 8},
      partnerListSheetName: '取引先一覧',
      customerCategory: 'CORPORATE'
    }, config)]);
  }

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.setActiveUser('admin@example.com');
    registerCustomer({
      customerId: 'C001', customerName: '顧客一', destinationSpreadsheetId: 'dest1',
      reviewers: 'reviewer@example.com, both@example.com', admins: 'admin@example.com'
    });
    registerCustomer({
      customerId: 'C002', customerName: '顧客二', destinationSpreadsheetId: 'dest2',
      reviewers: 'other@example.com, admin@example.com', admins: 'admin2@example.com'
    });
    registerCustomer({
      customerId: 'C003', customerName: '顧客三', destinationSpreadsheetId: 'dest3',
      reviewers: 'reviewer@example.com', admins: 'admin@example.com'
    });
    // 無効化後の Q/R が権限を残さないことを、登録経路とは独立に再現する。
    const customerSheet = masterSheet('顧客マスター');
    const values = customerSheet.getDataRange().getValues();
    const c003Row = values.findIndex((row) => String(row[0]) === 'C003') + 1;
    customerSheet.getRange(c003Row, 3).setValue(false);
    gas.stubs.setSpreadsheetOwner('master', 'owner@example.com');
    gas.stubs.resetUiEvents();
    gas.stubs.resetApiCallCounts();
  }

  function masterSheet(name) {
    return gas.stubs.getSpreadsheet('master').getSheetByName(name);
  }

  function permissionRows() {
    const target = masterSheet('監査ログ');
    if (!target) return [];
    return target.getDataRange().getValues().slice(1)
      .filter((row) => String(row[2]) === 'PERMISSION');
  }

  function caught(fn) {
    try {
      fn();
    } catch (error) {
      return error;
    }
    assert.fail('AuthorizationError が必要な経路を許可してはならない');
  }

  function assertAuthorizationError(error, reason, detail) {
    assert.equal(error && error.name, 'AuthorizationError');
    assert.equal(error.reason, reason);
    if (detail !== undefined) assert.equal(error.detail, detail);
  }

  function expectDenied(call, expected) {
    const before = permissionRows().length;
    const error = caught(call);
    assertAuthorizationError(error, expected.reason, expected.detail);
    assert.deepEqual(plain(error.context), {
      userEmail: expected.actor,
      requiredRole: expected.requiredRole,
      actualRole: expected.actualRole,
      customerId: expected.customerId,
      operation: expected.operation || ''
    });
    const rows = permissionRows();
    assert.equal(rows.length, before + 1, '拒否は監査で検知できなければならない');
    const row = rows[rows.length - 1];
    assert.equal(row[3], expected.actor);
    assert.equal(row[6], expected.customerId ? 'CUSTOMER' : 'SETTING');
    assert.equal(row[7], expected.customerId || 'SYSTEM');
    assert.equal(row[8], expected.customerId || '');
    const after = JSON.parse(String(row[10]));
    assert.deepEqual(after, {
      decision: 'DENIED', reason: expected.reason,
      requiredRole: expected.requiredRole, actualRole: expected.actualRole,
      operation: expected.operation || ''
    });
    assert.equal(row[11], expected.reason);
    assert.ok(gas.stubs.getLogLines().some((line) =>
      line.indexOf('[auth] DENIED reason=' + expected.reason) >= 0));
    return error;
  }

  function assertReadOnlyAuthorization(call) {
    gas.stubs.resetApiCallCounts();
    const result = call();
    const counts = gas.stubs.getApiCallCounts();
    assert.equal(counts.batchUpdate, 0, '許可しただけでセルを書いてはならない');
    assert.equal(counts.rangesWritten, 0, '許可しただけで範囲を書いてはならない');
    return result;
  }

  function roleValue(name) {
    return gas.evaluate('ROLE.' + name);
  }

  function canAuthorizeOperation(email, code, options = {}) {
    gas.stubs.setActiveUser(email);
    try {
      gas.call('authorizeOperation', [code, 'C001', options]);
      return true;
    } catch (error) {
      if (error && error.name === 'AuthorizationError') return false;
      throw error;
    }
  }

  function staleLease(customerId, actor) {
    const leaseId = gas.call('acquireLease', [
      customerId, 'file_' + customerId, 'RUN_AUTH', actor, 'WRITE_ONLY'
    ]);
    const leaseSheet = masterSheet('処理リース');
    const values = leaseSheet.getDataRange().getValues();
    const rowNumber = values.findIndex((row) => String(row[0]) === String(leaseId)) + 1;
    const threshold = Number(gas.evaluate('SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS'));
    leaseSheet.getRange(rowNumber, 8).setValue(
      new Date(Date.now() - (threshold + 60) * 1000).toISOString());
    return leaseId;
  }

  function scheduleCustomerRow() {
    const row = blank(42);
    Object.assign(row, {
      0: 'C001', 1: '顧客一', 2: 'TRUE', 3: 'folder1', 5: 'dest1',
      7: '入力用シート', 8: '取引先一覧', 9: 2, 10: 3, 11: 4, 12: 5,
      13: 6, 14: 7, 15: '1.0', 16: 'reviewer@example.com',
      17: 'admin@example.com', 18: 0, 20: 'システム情報', 21: '', 23: 0, 24: 0,
      29: 1, 30: JSON.stringify({row: 1, cells: [{column: 2, text: '利用日', match: 'exact'}]}),
      31: '{}', 32: '{}', 33: 8, 34: '取引先一覧', 35: 'CORPORATE', 36: ''
    });
    return row;
  }

  function scheduleFormatRow() {
    const row = blank(35);
    Object.assign(row, {
      0: 'smbc_family', 1: '三井住友系', 2: 'active', 3: 'TRUE', 4: '["csv"]',
      5: JSON.stringify({allOf: [{maxRow: 1,
        keywords: ['利用日', '利用店名', '金額', '使用用途'], minMatch: 4}]}),
      6: 1, 7: 2, 8: 'A', 9: 'B', 10: 'C', 11: 'D', 12: '',
      14: JSON.stringify({excludeRowRanges: [{from: 1, to: 1}],
        excludeWhenDateAndAmountEmpty: true, rules: []}),
      16: JSON.stringify({sources: [{id: 'fn', kind: 'fileName',
        pattern: '(20\\d{2})(0[1-9]|1[0-2])', groups: {year: 1, month: 2},
        yearDigits: 4, means: 'payment', offsetMonths: 1}]}),
      17: 'generic', 18: 1, 19: 'admin@example.com',
      21: '2026-01-01T00:00:00+09:00', 29: 'NEW', 33: '2026-01-01T00:00:00+09:00'
    });
    return row;
  }

  function setupScheduledImport() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [blank(42), scheduleCustomerRow()]},
      {name: 'カード形式マスター', values: [blank(35), scheduleFormatRow()]},
      {name: '使用用途補完マスター', values: [blank(10)]},
      {name: '共通取引先辞書', values: [blank(18), Object.assign(blank(18), {
        0: 'DICT_1', 1: 'ローソン', 2: 'ローソン', 3: '株式会社ローソン',
        4: 'exact_original', 5: 1, 9: 'TRUE', 10: 'admin@example.com',
        12: '2026-01-01T00:00:00+09:00', 13: 1, 14: 'TRUE', 15: 'FALSE'
      })]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート', values: [[
        '', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID', ''
      ]], maxRows: 20, maxColumns: 8},
      {name: '取引先一覧', values: [['元店名', '取引先名'], ['ローソン', '株式会社ローソン']]}
    ]});
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createSpreadsheet('snap', {sheets: []});
    gas.stubs.createFile('fileA', {
      name: '三井住友カード202601.csv',
      bytes: Buffer.from('利用日,利用店名,金額,使用用途\n2025/12/16,ローソン,10800,仕入れ\n', 'utf8'),
      lastUpdated: new Date(Date.now() - 3600 * 1000),
      createdTime: '2026-08-01T00:00:00Z', contentType: 'text/csv'
    });
    gas.stubs.createFolder('folder1', {fileIds: ['fileA']});
    gas.evaluate("SETTINGS.EXECUTION_TIMEOUT_SECONDS = 300;" +
      " SETTINGS.SAFETY_MARGIN_SECONDS = 60;" +
      " SETTINGS.TX_INDEX_SPREADSHEET_ID = 'txidx';" +
      " SETTINGS.SNAPSHOT_SPREADSHEET_ID = 'snap';" +
      " SETTINGS.SAMPLE_CORPUS_FOLDER_ID = 'corpus';" +
      " SETTINGS.PARALLEL_WORK_FOLDER_ID = '';" +
      " SETTINGS.FAULT_INJECTION = null;");
    gas.stubs.setActiveUser('admin@example.com');
  }

  test('auth A-1: owner has OWNER_ADMIN for every active customer and all active ids', () => {
    setup();
    ['C001', 'C002', null].forEach((customerId) => {
      assert.equal(gas.call('getUserRole', ['owner@example.com', customerId]), 'OWNER_ADMIN');
    });
    assert.deepEqual(plain(gas.call('getAuthorizedCustomerIds', ['owner@example.com'])), ['C001', 'C002']);
  });

  test('auth A-2: roles remain customer-specific while the cross-customer role is the maximum', () => {
    setup();
    assert.equal(gas.call('getUserRole', ['admin@example.com', 'C001']), 'SYSTEM_ADMIN');
    assert.equal(gas.call('getUserRole', ['admin@example.com', 'C002']), 'REVIEWER');
    assert.equal(gas.call('getUserRole', ['admin@example.com', null]), 'SYSTEM_ADMIN');
  });

  test('auth A-2b: a person on both Q and R of one customer is the administrator', () => {
    // 仕様 §5.2「Q列にもR列にも載っている人はR列が勝つ」。両方に載る人がテスト
    // データに居ないと、roleForCustomer_ の2つの if を入れ替えても全件通る。
    // 実機の TEST01 は登録者（開発者）がQ・R両方に入っており、この順序が静かに
    // 変わると開発者が確認担当者へ格下げされ、管理者操作から締め出される。
    setup();
    registerCustomer({
      customerId: 'C004', customerName: '顧客四', destinationSpreadsheetId: 'dest4',
      reviewers: 'dual@example.com', admins: 'dual@example.com'
    });
    assert.equal(gas.call('getUserRole', ['dual@example.com', 'C004']), 'SYSTEM_ADMIN');
    gas.stubs.setActiveUser('dual@example.com');
    const decision = plain(gas.call('authorize', [gas.evaluate('ROLE.SYSTEM_ADMIN'), 'C004']));
    assert.equal(decision.role, 'SYSTEM_ADMIN', 'R列が勝つので管理者操作が通ること');
  });

  test('auth A-3: reviewers see only listed customers including later CSV entries', () => {
    setup();
    assert.equal(gas.call('getUserRole', ['reviewer@example.com', 'C001']), 'REVIEWER');
    assert.equal(gas.call('getUserRole', ['reviewer@example.com', 'C002']), null);
    assert.equal(gas.call('getUserRole', ['reviewer@example.com', null]), 'REVIEWER');
    assert.deepEqual(plain(gas.call('getAuthorizedCustomerIds', ['reviewer@example.com'])), ['C001']);
    assert.equal(gas.call('getUserRole', ['both@example.com', 'C001']), 'REVIEWER');
  });

  test('auth A-3b: copied authorization predicate stays equivalent to the existing function', () => {
    setup();
    ['reviewer@example.com', 'admin@example.com', 'both@example.com', 'nobody@example.com']
      .forEach((email) => {
        const ids = plain(gas.call('getAuthorizedCustomerIds', [email]));
        const existing = plain(gas.call('getAuthorizedCustomers', [email])).map((c) => c.customerId);
        assert.deepEqual(ids, existing, email);
      });
  });

  test('auth A-4: unknown and empty users have no role and no customer ids', () => {
    setup();
    ['nobody@example.com', ''].forEach((email) => {
      assert.equal(gas.call('getUserRole', [email, 'C001']), null);
      assert.equal(gas.call('getUserRole', [email, null]), null);
      assert.deepEqual(plain(gas.call('getAuthorizedCustomerIds', [email])), []);
    });
  });

  test('auth A-5: user email comparison trims and folds case', () => {
    setup();
    assert.equal(gas.call('getUserRole', [' Admin@Example.com ', 'C001']), 'SYSTEM_ADMIN');
    assert.equal(gas.call('getUserRole', [' Admin@Example.com ', 'C002']), 'REVIEWER');
  });

  test('auth A-6: disabled customers grant no role even when Q or R still names the user', () => {
    setup();
    assert.equal(gas.call('getUserRole', ['reviewer@example.com', 'C003']), null);
    assert.equal(gas.call('getUserRole', ['admin@example.com', 'C003']), null);
  });

  test('auth A-7: role ordering is complete and unknown required roles fail loudly', () => {
    setup();
    const roles = ['REVIEWER', 'SYSTEM_ADMIN', 'OWNER_ADMIN'];
    roles.forEach((actual, actualIndex) => roles.forEach((required, requiredIndex) => {
      assert.equal(gas.call('hasRole', [roleValue(actual), roleValue(required)]),
        actualIndex >= requiredIndex, actual + ' -> ' + required);
    }));
    assert.equal(gas.call('hasRole', [null, roleValue('REVIEWER')]), false);
    assert.throws(() => gas.call('hasRole', [roleValue('REVIEWER'), 'ADMIN']),
      (error) => error && error.name === 'TypeError');
  });

  test('auth A-8: an unavailable spreadsheet owner never creates an owner role', () => {
    setup();
    gas.stubs.setSpreadsheetOwner('master', null);
    assert.equal(gas.call('getUserRole', ['owner@example.com', 'C001']), null);
  });

  test('auth B-9: a reviewer is authorized only for the named customer without writes', () => {
    setup();
    gas.stubs.setActiveUser('reviewer@example.com');
    const result = plain(assertReadOnlyAuthorization(() =>
      gas.call('authorize', [roleValue('REVIEWER'), 'C001'])));
    assert.deepEqual({userEmail: result.userEmail, role: result.role, isOwner: result.isOwner,
      customerId: result.customerId, customerIds: result.customerIds}, {
      userEmail: 'reviewer@example.com', role: 'REVIEWER', isOwner: false,
      customerId: 'C001', customerIds: ['C001']
    });
    assert.equal(permissionRows().length, 0);
  });

  test('auth B-10: a system administrator is allowed for their admin customer', () => {
    setup();
    gas.stubs.setActiveUser('admin@example.com');
    const result = plain(assertReadOnlyAuthorization(() =>
      gas.call('authorize', [roleValue('SYSTEM_ADMIN'), 'C001'])));
    assert.equal(result.role, 'SYSTEM_ADMIN');
    assert.equal(permissionRows().length, 0);
  });

  test('auth B-11: the owner can use owner operations and view every active customer', () => {
    setup();
    gas.stubs.setActiveUser('owner@example.com');
    assert.equal(plain(gas.call('authorize', [roleValue('OWNER_ADMIN'), 'C002'])).role, 'OWNER_ADMIN');
    assert.deepEqual(plain(gas.call('authorize', [roleValue('REVIEWER'), null])).customerIds,
      ['C001', 'C002']);
    assert.equal(permissionRows().length, 0);
  });

  test('auth B-12: an aggregate system administrator may use cross-customer admin operations', () => {
    setup();
    gas.stubs.setActiveUser('admin@example.com');
    assert.equal(plain(gas.call('authorize', [roleValue('SYSTEM_ADMIN'), null])).role,
      'SYSTEM_ADMIN');
    assert.equal(permissionRows().length, 0);
  });

  test('auth C-13: access to a different customer is denied and audited', () => {
    setup();
    gas.stubs.setActiveUser('reviewer@example.com');
    expectDenied(() => gas.call('authorize', [roleValue('REVIEWER'), 'C002', {operation: 'T'}]), {
      reason: 'NO_CUSTOMER_ACCESS', actor: 'reviewer@example.com', requiredRole: 'REVIEWER',
      actualRole: null, customerId: 'C002', operation: 'T',
      detail: '顧客 C002 に対する権限がありません。実行者: reviewer@example.com。' +
        '顧客マスターの Q列（確認担当者）または R列（システム管理者）にこのアドレスを登録してください。'
    });
  });

  test('auth C-14: a role held for one customer cannot authorize another customer', () => {
    setup();
    gas.stubs.setActiveUser('admin@example.com');
    expectDenied(() => gas.call('authorize', [roleValue('SYSTEM_ADMIN'), 'C002']), {
      reason: 'ROLE_INSUFFICIENT', actor: 'admin@example.com', requiredRole: 'SYSTEM_ADMIN',
      actualRole: 'REVIEWER', customerId: 'C002',
      detail: 'この操作にはシステム管理者の権限が必要です。実行者: admin@example.com' +
        '（顧客 C002に対する役割: 確認担当者）。'
    });
  });

  test('auth C-15: reviewer cannot perform a system administrator operation', () => {
    setup();
    gas.stubs.setActiveUser('reviewer@example.com');
    expectDenied(() => gas.call('authorize', [roleValue('SYSTEM_ADMIN'), 'C001']), {
      reason: 'ROLE_INSUFFICIENT', actor: 'reviewer@example.com', requiredRole: 'SYSTEM_ADMIN',
      actualRole: 'REVIEWER', customerId: 'C001',
      detail: 'この操作にはシステム管理者の権限が必要です。実行者: reviewer@example.com' +
        '（顧客 C001に対する役割: 確認担当者）。'
    });
  });

  test('auth C-16: a user with no customer gets the exact cross-customer refusal', () => {
    setup();
    gas.stubs.setActiveUser('nobody@example.com');
    expectDenied(() => gas.call('authorize', [roleValue('REVIEWER'), null]), {
      reason: 'NO_CUSTOMER_ACCESS', actor: 'nobody@example.com', requiredRole: 'REVIEWER',
      actualRole: null, customerId: null,
      detail: '閲覧を許可された顧客がありません。実行者: nobody@example.com。' +
        '顧客マスターの Q列（確認担当者）または R列（システム管理者）にこのアドレスを登録してください。'
    });
  });

  test('auth C-17: empty active user never falls back to the effective owner', () => {
    setup();
    gas.stubs.setActiveUser('');
    gas.stubs.setEffectiveUser('owner@example.com');
    const detail = '実行者のメールアドレスを取得できないため表示できません（仕様 §20.5）。' +
      'スクリプトの承認が済んでいるか確認してください。';
    [null, 'C001'].forEach((customerId) => {
      const error = caught(() => gas.call('authorize', [roleValue('REVIEWER'), customerId]));
      assertAuthorizationError(error, 'ACTOR_UNKNOWN', detail);
    });
    assert.equal(permissionRows().length, 0, '帰属できない拒否を監査行にしてはならない');
    assert.ok(gas.stubs.getLogLines().some((line) =>
      line.indexOf('[auth] DENIED reason=ACTOR_UNKNOWN') >= 0));
  });

  test('auth C-18: disabled customers are rejected even for the spreadsheet owner', () => {
    setup();
    const detail = '顧客 C003 は顧客マスターに無いか、無効になっています。';
    ['reviewer@example.com', 'owner@example.com'].forEach((email) => {
      gas.stubs.setActiveUser(email);
      expectDenied(() => gas.call('authorize', [roleValue('REVIEWER'), 'C003']), {
        reason: 'CUSTOMER_NOT_ACTIVE', actor: email, requiredRole: 'REVIEWER',
        actualRole: null, customerId: 'C003', detail
      });
    });
  });

  test('auth C-19: an unknown customer is rejected even for the spreadsheet owner', () => {
    setup();
    gas.stubs.setActiveUser('owner@example.com');
    expectDenied(() => gas.call('authorize', [roleValue('REVIEWER'), 'NOPE']), {
      reason: 'CUSTOMER_NOT_ACTIVE', actor: 'owner@example.com', requiredRole: 'REVIEWER',
      actualRole: null, customerId: 'NOPE',
      detail: '顧客 NOPE は顧客マスターに無いか、無効になっています。'
    });
  });

  test('auth C-20: audit failure cannot turn a denial into permission', () => {
    setup();
    const master = gas.stubs.getSpreadsheet('master');
    master.deleteSheet(master.getSheetByName('監査ログ'));
    gas.stubs.setActiveUser('nobody@example.com');
    const error = caught(() => gas.call('authorize', [roleValue('REVIEWER'), null]));
    assertAuthorizationError(error, 'NO_CUSTOMER_ACCESS');
    assert.ok(gas.stubs.getLogLines().some((line) =>
      line.indexOf('[auth] audit write failed') >= 0));
  });

  test('auth C-21: programmer mistakes throw TypeError without audit records', () => {
    setup();
    gas.stubs.setActiveUser('owner@example.com');
    assert.throws(() => gas.call('authorize', ['ADMIN', 'C001']),
      (error) => error && error.name === 'TypeError');
    assert.throws(() => gas.call('authorize', [roleValue('REVIEWER'), {customerId: 'C001'}]),
      (error) => error && error.name === 'TypeError');
    assert.equal(permissionRows().length, 0);
  });

  test('auth C-21b: repeated permission denials preserve the audit hash chain', () => {
    setup();
    gas.stubs.setActiveUser('nobody@example.com');
    caught(() => gas.call('authorize', [roleValue('REVIEWER'), null]));
    gas.stubs.setActiveUser('reviewer@example.com');
    caught(() => gas.call('authorize', [roleValue('REVIEWER'), 'C002']));
    caught(() => gas.call('authorize', [roleValue('SYSTEM_ADMIN'), 'C001']));
    assert.equal(permissionRows().length, 3);
    assert.equal(plain(gas.call('verifyChain', ['FULL'])).ok, true);
  });

  test('auth D-22: every operation code enforces the appendix role matrix', () => {
    setup();
    const ranks = {REVIEWER: 1, SYSTEM_ADMIN: 2, OWNER_ADMIN: 3};
    const actors = {
      REVIEWER: 'reviewer@example.com',
      SYSTEM_ADMIN: 'admin@example.com',
      OWNER_ADMIN: 'owner@example.com'
    };
    Object.entries(OPERATION_ROLE_EXPECTATIONS).forEach(([code, required]) => {
      Object.entries(actors).forEach(([role, email]) => {
        assert.equal(canAuthorizeOperation(email, code), ranks[role] >= ranks[required],
          code + ' for ' + role);
      });
    });
    // C001 だけでは admin@ の顧客別役割と集約役割が同じになるため、
    // C002 でも全コードを回して「集約役割でしか見ない」破損を捕まえる。
    Object.entries(OPERATION_ROLE_EXPECTATIONS).forEach(([code, required]) => {
      gas.stubs.setActiveUser('admin@example.com');
      let allowed;
      try {
        gas.call('authorizeOperation', [code, 'C002', {}]);
        allowed = true;
      } catch (error) {
        if (!error || error.name !== 'AuthorizationError') throw error;
        allowed = false;
      }
      assert.equal(allowed, ranks.REVIEWER >= ranks[required], code + ' for admin@ on C002');
    });
  });

  test('auth D-23: imported cancellations and exclusions require system administration', () => {
    setup();
    ['CANCEL_FILE', 'EXCLUDE'].forEach((code) => {
      assert.equal(canAuthorizeOperation('reviewer@example.com', code, {allowImported: true}), false);
      assert.equal(canAuthorizeOperation('reviewer@example.com', code, {}), true);
      assert.equal(canAuthorizeOperation('admin@example.com', code, {allowImported: true}), true);
      assert.equal(canAuthorizeOperation('admin@example.com', code, {}), true);
    });
  });

  test('auth D-24: customer split is reviewer work but changing the input limit is owner-only', () => {
    setup();
    assert.equal(canAuthorizeOperation('reviewer@example.com', 'RESIZE_INPUT',
      {askCustomerToSplit: true}), true);
    assert.equal(canAuthorizeOperation('reviewer@example.com', 'RESIZE_INPUT', {}), false);
    assert.equal(canAuthorizeOperation('admin@example.com', 'RESIZE_INPUT', {}), false);
    assert.equal(canAuthorizeOperation('owner@example.com', 'RESIZE_INPUT', {}), true);
  });

  test('auth D-25: restoring a destination row remains owner-only', () => {
    setup();
    assert.equal(canAuthorizeOperation('admin@example.com', 'RESTORE_ROW'), false);
    assert.equal(canAuthorizeOperation('owner@example.com', 'RESTORE_ROW'), true);
  });

  test('auth D-26: unknown operations and missing customer ids fail closed without audit', () => {
    setup();
    gas.stubs.setActiveUser('owner@example.com');
    assert.throws(() => gas.call('authorizeOperation', ['RESTORE_ROWS', 'C001', {}]),
      (error) => error && error.name === 'TypeError');
    assert.throws(() => gas.call('authorizeOperation', ['RESTORE_ROW', null, {}]),
      (error) => error && error.name === 'TypeError');
    assert.equal(permissionRows().length, 0);
  });

  test('auth D-27: authorization table covers exactly every implemented resolution operation', () => {
    setup();
    const implemented = plain(gas.evaluate(
      "Array.from(new Set(Object.keys(TX_REVIEW_OPERATIONS_).reduce(function(all, key) {" +
      " return all.concat(TX_REVIEW_OPERATIONS_[key]); }, [])" +
      ".concat(Object.keys(FILE_REVIEW_OPERATIONS_).reduce(function(all, key) {" +
      " return all.concat(FILE_REVIEW_OPERATIONS_[key]); }, []))" +
      ".concat(INTEGRITY_OPERATIONS_))).sort()"));
    assert.deepEqual(implemented, Object.keys(OPERATION_ROLE_EXPECTATIONS).sort());
    const authorized = plain(gas.evaluate('Object.keys(OPERATION_ROLES_).sort()'));
    assert.deepEqual(authorized, Object.keys(OPERATION_ROLE_EXPECTATIONS).sort());
  });

  test('auth D-28: authorization entry is never weaker than component role checks', () => {
    setup();
    const codes = plain(gas.evaluate('Object.keys(FILE_OPERATION_ROLES_)'));
    codes.forEach((code) => {
      const required = gas.call('requiredRoleForOperation_', [code, {}]);
      assert.equal(gas.call('hasRole', [required, roleValue('SYSTEM_ADMIN')]), true, code);
    });
    assert.equal(gas.call('requiredRoleForOperation_', ['RESTORE_ROW', {}]), 'OWNER_ADMIN');
  });

  test('auth E-29: authorization reads the customer master once regardless of customer count', () => {
    setup();
    const cases = [
      ['reviewer@example.com', null],
      ['owner@example.com', null],
      ['reviewer@example.com', 'C001']
    ];
    cases.forEach(([email, customerId]) => {
      gas.stubs.setActiveUser(email);
      gas.stubs.resetApiCallCounts();
      gas.call('authorize', [roleValue('REVIEWER'), customerId]);
      assert.equal(gas.stubs.getApiCallCounts().batchGet, 1, email + ':' + customerId);
    });

    // 顧客ごとの再読込が紛れると、少数件では気づけないため 12 社でも固定する。
    for (let index = 4; index <= 13; index += 1) {
      registerCustomer({
        customerId: 'C' + String(index).padStart(3, '0'),
        customerName: '顧客' + index,
        destinationSpreadsheetId: 'dest' + index,
        reviewers: 'reviewer@example.com', admins: 'admin@example.com'
      });
    }
    gas.stubs.setActiveUser('owner@example.com');
    gas.stubs.resetApiCallCounts();
    const result = plain(gas.call('authorize', [roleValue('REVIEWER'), null]));
    assert.equal(result.customerIds.length, 12);
    assert.equal(gas.stubs.getApiCallCounts().batchGet, 1);
  });

  test('auth F-30: menu headers display the aggregate role for reviewer admin and owner', () => {
    setup();
    const expected = {
      'reviewer@example.com': '確認担当者',
      'admin@example.com': 'システム管理者',
      'owner@example.com': 'オーナー管理者'
    };
    Object.entries(expected).forEach(([email, label]) => {
      gas.stubs.resetUiEvents();
      gas.stubs.setActiveUser(email);
      gas.call('menuShowFileList', []);
      const modal = gas.stubs.getUiEvents().filter((event) => event.type === 'modal').slice(-1)[0];
      assert.match(modal.html, new RegExp('実行者: ' + email.replace('.', '\\.') + '（' + label + '）'));
    });
  });

  test('auth F-31: existing unauthorized menu behavior now also records the selected action', () => {
    setup();
    gas.stubs.setActiveUser('nobody@example.com');
    gas.call('menuShowFileList', []);
    const rows = permissionRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0][3], 'nobody@example.com');
    assert.equal(JSON.parse(String(rows[0][10])).operation, 'MENU:ファイル一覧');
  });

  test('auth F-32: an authorized menu read never writes a permission audit row', () => {
    setup();
    gas.stubs.setActiveUser('reviewer@example.com');
    gas.call('menuShowFileList', []);
    assert.equal(gas.stubs.getUiEvents().filter((event) => event.type === 'modal').length, 1,
      '全員拒否でも監査行は増えないため、表示成功そのものを確認する');
    assert.equal(gas.stubs.getUiEvents().filter((event) => event.type === 'alert').length, 0);
    assert.equal(permissionRows().length, 0);
  });

  test('auth F-33: about screen shows aggregate per-customer and owner roles with one read', () => {
    setup();
    gas.stubs.setActiveUser('admin@example.com');
    gas.stubs.resetApiCallCounts();
    gas.call('menuShowAbout', []);
    const alert = gas.stubs.getUiEvents().filter((event) => event.type === 'alert').slice(-1)[0];
    assert.match(alert.prompt, /役割: システム管理者/);
    assert.match(alert.prompt,
      /顧客ごとの役割: 顧客一\(C001\)=システム管理者、顧客二\(C002\)=確認担当者/);
    assert.match(alert.prompt, /マスターのオーナー: owner@example\.com/);
    assert.equal(gas.stubs.getApiCallCounts().batchGet, 1);
  });

  test('auth F-34: menu cannot self-assert roles or call any ops entry point', () => {
    const srcDir = path.resolve(__dirname, '..', 'src');
    const menu = fs.readFileSync(path.join(srcDir, '96_Menu.gs'), 'utf8');
    ['REVIEWER', 'SYSTEM_ADMIN', 'OWNER_ADMIN'].forEach((role) => {
      assert.doesNotMatch(menu, new RegExp("['\\\"]" + role + "['\\\"]"));
    });
    const opsNames = [];
    ['95_Notifications.gs', '97_Ops.gs'].forEach((name) => {
      const source = fs.readFileSync(path.join(srcDir, name), 'utf8');
      for (const match of source.matchAll(/^function (ops[A-Z]\w*)\(/gm)) opsNames.push(match[1]);
    });
    opsNames.forEach((name) => {
      assert.doesNotMatch(menu, new RegExp('\\b' + name + '\\s*\\('), name);
    });
  });

  test('auth F-35: only authorization and menu modules may call authorization', () => {
    const srcDir = path.resolve(__dirname, '..', 'src');
    const files = fs.readdirSync(srcDir).filter((name) => name.endsWith('.gs'));
    const callers = files.filter((name) => {
      const source = fs.readFileSync(path.join(srcDir, name), 'utf8')
        .replace(/^\s*\/\/.*$/gm, '');
      return /\bauthorize(?:Operation)?\s*\(/.test(source);
    }).sort();
    assert.deepEqual(callers, ['03_Authorization.gs', '80_WebApp.gs', '96_Menu.gs']);
  });

  test('auth G-36: schedules notifications ops and runImport never traverse authorization', () => {
    setupScheduledImport();
    gas.evaluate("var __savedAuthorize = authorize; authorize = function() {" +
      " throw new Error('authorize must not run here'); };");
    try {
      assert.doesNotThrow(() => gas.call('scheduledImportTick', []));
      const indexRows = masterSheet('恒久ファイルインデックス').getDataRange().getValues();
      const imported = indexRows.find((row) => String(row[0]) === 'fileA');
      assert.ok(imported);
      assert.notEqual(String(imported[3]), 'DISCOVERED');
      assert.doesNotThrow(() => gas.call('notificationWatchdogTick', []));
      ['opsShowFileStates', 'opsCountFileStates', 'opsRetryFailedFiles',
        'opsReleaseStalledLeases', 'opsShowLeases'].forEach((name) => {
        assert.doesNotThrow(() => gas.call(name, []), name);
      });
      assert.doesNotThrow(() => gas.call('runImport', [{}]));
      assert.equal(permissionRows().length, 0);
    } finally {
      gas.evaluate('authorize = __savedAuthorize;');
    }
  });

  test('auth G-37: runImport intentionally keeps its existing Q/R-only owner behavior', () => {
    setup();
    ['owner@example.com', 'stranger@example.com'].forEach((email) => {
      gas.stubs.setActiveUser(email);
      assert.equal(plain(gas.call('runImport', [{}])).stoppedBy, 'NO_AUTHORIZED_CUSTOMER',
        '課題 K-1 を解くまではオーナー特例で取込対象を静かに広げない');
    });
  });

  test('auth G-38: component force release keeps its existing administrator check', () => {
    setup();
    const leaseId = staleLease('C001', 'reviewer@example.com');
    assert.throws(() => gas.call('forceReleaseLease', [
      leaseId, 'TEST', 'reviewer@example.com'
    ]), (error) => error && error.name === 'AuthorizationError' &&
      /System administrator role is required/.test(String(error.detail)));
  });

  test('auth G-38b: owner/component mismatch stays visible until K-3 is resolved', () => {
    setup();
    gas.stubs.setActiveUser('owner@example.com');
    assert.equal(plain(gas.call('authorize', [roleValue('SYSTEM_ADMIN'), 'C002'])).role,
      'OWNER_ADMIN');
    const leaseId = staleLease('C002', 'owner@example.com');
    assert.throws(() => gas.call('forceReleaseLease', [
      leaseId, 'TEST', 'owner@example.com'
    ]), (error) => error && error.name === 'AuthorizationError');
    assert.throws(() => gas.call('registerDictionaryPattern', [
      'C002', 'パターン', '取引先', 'prefix', 'owner@example.com'
    ]), (error) => error && error.name === 'AuthorizationError');
  });

  test('auth H-39: corpus administration requires both aggregate admin role and allow-list', () => {
    setup();
    assert.equal(gas.call('isCorpusAdmin', ['owner@example.com']), true);
    gas.evaluate("SETTINGS.CORPUS_ADMIN_EMAILS = 'admin@example.com';");
    assert.equal(gas.call('isCorpusAdmin', ['admin@example.com']), true);
    assert.equal(gas.call('isCorpusAdmin', ['reviewer@example.com']), false);
    assert.equal(gas.call('isCorpusAdmin', ['admin2@example.com']), false);
    gas.evaluate("SETTINGS.CORPUS_ADMIN_EMAILS = '';");
    assert.equal(gas.call('isCorpusAdmin', ['admin@example.com']), false);
    assert.equal(gas.call('isCorpusAdmin', ['owner@example.com']), true);
  });

  test('auth I-40: literal authorization tables stay exactly aligned with ROLE', () => {
    setup();
    const roleKeys = plain(gas.evaluate('Object.keys(ROLE).sort()'));
    assert.deepEqual(plain(gas.evaluate('Object.keys(ROLE_RANK_).sort()')), roleKeys);
    assert.deepEqual(plain(gas.evaluate('Object.keys(ROLE_LABELS_).sort()')), roleKeys);
    assert.deepEqual(plain(gas.evaluate(
      'Array.from(new Set(Object.keys(OPERATION_ROLES_).map(function(key) {' +
      ' return OPERATION_ROLES_[key]; }))).sort()')), roleKeys);
    assert.deepEqual(plain(gas.evaluate('[ROLE_RANK_[ROLE.REVIEWER],' +
      ' ROLE_RANK_[ROLE.SYSTEM_ADMIN], ROLE_RANK_[ROLE.OWNER_ADMIN]]')), [1, 2, 3]);
    roleKeys.forEach((role) => {
      const label = gas.call('roleLabel', [role]);
      assert.equal(typeof label, 'string');
      assert.ok(label.length > 0);
    });
    assert.equal(gas.call('roleLabel', [null]), '（役割なし）');
    assert.equal(gas.call('roleLabel', ['X']), '（役割なし）');
  });
};

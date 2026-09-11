'use strict';

/**
 * 参照系メニューは、表示のために既存の運用経路を壊さず、顧客境界も越えない
 * 必要がある。UIの見た目だけでは事故を検出できないため、収集・整形・表示を
 * それぞれ固定して検査する。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const blank = (length) => Array(length).fill('');
  const now = new Date('2026-09-10T03:00:00.000Z'); // 2026-09-10 12:00 JST

  function destination(id) {
    gas.stubs.createSpreadsheet(id, {sheets: [
      {name: '入力用シート', values: [[
        '', '利用日', '取引先', '摘要', '元店名', '金額', '内部ID', '税区分'
      ]], maxRows: 20, maxColumns: 8},
      {name: '取引先一覧', values: [['取引先']]}
    ]});
  }

  function registerCustomer(config) {
    return gas.call('registerTestCustomer', [Object.assign({
      sourceFolderId: 'folder_' + config.customerId,
      destinationSpreadsheetId: config.destinationSpreadsheetId,
      destinationSheetName: '入力用シート',
      columns: {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7, G: 8},
      partnerListSheetName: '取引先一覧',
      reviewers: '',
      admins: 'admin@example.com',
      cashbackMerchants: ['キャッシュバック店']
    }, config)]);
  }

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    destination('dest1');
    destination('dest2');
    gas.stubs.createSpreadsheet('txidx', {sheets: [{name: '容量プローブ', values: [['x']]}]});
    gas.stubs.createSpreadsheet('snap', {sheets: [{name: '容量プローブ', values: [['x']]}]});
    gas.stubs.createFolder('folder_C001', {fileIds: []});
    gas.stubs.createFolder('folder_C002', {fileIds: []});
    gas.stubs.createFolder('corpus', {fileIds: []});
    gas.evaluate("SETTINGS.EXECUTION_TIMEOUT_SECONDS = 300;" +
      " SETTINGS.SAFETY_MARGIN_SECONDS = 60;" +
      " SETTINGS.TX_INDEX_SPREADSHEET_ID = 'txidx';" +
      " SETTINGS.SNAPSHOT_SPREADSHEET_ID = 'snap';" +
      " SETTINGS.SAMPLE_CORPUS_FOLDER_ID = 'corpus';" +
      " SETTINGS.PARALLEL_WORK_FOLDER_ID = '';");
    gas.stubs.setActiveUser('admin@example.com');
    registerCustomer({customerId: 'C001', customerName: '顧客一',
      destinationSpreadsheetId: 'dest1', reviewers: 'reviewer@example.com'});
    registerCustomer({customerId: 'C002', customerName: '顧客二',
      destinationSpreadsheetId: 'dest2', reviewers: 'other@example.com'});
    gas.stubs.setSpreadsheetOwner('master', 'owner@example.com');
    gas.stubs.resetUiEvents();
    gas.stubs.resetApiCallCounts();
  }

  function sheet(name) {
    return gas.stubs.getSpreadsheet('master').getSheetByName(name);
  }

  function putRows(name, width, rows) {
    if (!rows.length) return;
    sheet(name).getRange(2, 1, rows.length, width).setValues(rows);
  }

  function indexRow(fileId, customerId, fileName, state) {
    const row = blank(13);
    row[0] = fileId;
    row[1] = customerId;
    row[2] = fileName;
    row[3] = state;
    return row;
  }

  function processRow(fileId, customerId, state, options = {}) {
    const row = blank(40);
    row[0] = options.runId || 'RUN';
    row[1] = options.startedAt || '';
    row[2] = options.endedAt || '';
    row[5] = customerId;
    row[6] = customerId === 'C001' ? '顧客一' : customerId === 'C002' ? '顧客二' : '';
    row[7] = fileId;
    row[8] = options.fileName || (fileId + '.csv');
    row[14] = options.formatId || '';
    row[16] = state;
    row[17] = options.read || 0;
    row[18] = options.auto || 0;
    row[19] = options.review || 0;
    row[20] = options.excluded || 0;
    row[21] = options.error || 0;
    row[22] = options.errors === undefined ? '' : options.errors;
    row[29] = options.lastHeartbeat || '';
    row[12] = options.contentHash || '';
    return row;
  }

  function leaseRow(leaseId, customerId, fileId, purpose, heartbeat, owner = 'worker@example.com') {
    const row = blank(10);
    row[0] = leaseId;
    row[1] = customerId;
    row[2] = fileId;
    row[3] = 'RUN';
    row[4] = owner;
    row[6] = heartbeat;
    row[7] = heartbeat;
    row[8] = 'ACTIVE';
    row[9] = purpose;
    return row;
  }

  function reviewRow(id, customerId, type, status = 'OPEN', options = {}) {
    const row = blank(32);
    row[0] = id;
    row[1] = status;
    row[2] = type;
    row[3] = type + ':' + id;
    row[4] = options.fullTxId || '';
    row[6] = customerId;
    row[7] = options.customerName || (customerId === 'C001' ? '顧客一' : '顧客二');
    row[8] = options.fileId || ('file_' + id);
    row[9] = options.fileName || ('review_' + id + '.csv');
    row[14] = options.merchant || '';
    row[18] = options.originalDate || '';
    row[19] = options.originalAmount === undefined ? '' : options.originalAmount;
    row[26] = options.registeredAt || '2026-09-10T10:00:00+09:00';
    return row;
  }

  function txRow(id, customerId, fileId, options = {}) {
    const row = blank(47);
    row[0] = id;
    row[3] = customerId;
    row[4] = fileId;
    row[15] = options.merchant || '店';
    row[17] = options.purpose || '仕入れ';
    row[20] = options.memo || '';
    row[30] = options.destinationRow || 2;
    row[31] = options.currency || '';
    row[33] = options.exchangeRate || '';
    row[41] = options.active === false ? false : true;
    row[45] = options.taxPlanned || '';
    row[46] = options.taxVerified || '';
    return row;
  }

  function lastEvent(type) {
    const events = gas.stubs.getUiEvents().filter((event) => !type || event.type === type);
    return events[events.length - 1];
  }

  function baseScope(overrides = {}) {
    return Object.assign({
      email: 'reviewer@example.com', isOwner: false,
      customers: [{customerId: 'C001', customerName: '顧客一'}],
      customerIds: ['C001'], customerNameById: {C001: '顧客一'}
    }, overrides);
  }

  function emptyCollected() {
    return {files: [], leases: [], reviews: [], lastActivityAt: null};
  }

  test('menu 1: onOpen registers the exact read-only menu tree', () => {
    setup();
    gas.call('onOpen', []);
    assert.deepEqual(plain(gas.stubs.getMenus()), [{name: 'クレカ自動処理', items: [
      {caption: '取込の状況', functionName: 'menuShowImportStatus'},
      {caption: 'ファイル一覧', functionName: 'menuShowFileList'},
      {caption: '要確認を開く', functionName: 'menuOpenReview'},
      {caption: '処理ログを開く', functionName: 'menuOpenLog'},
      {separator: true},
      {name: '診断', items: [
        {caption: 'リースの状況', functionName: 'menuShowLeases'},
        {caption: '設定の検査', functionName: 'menuCheckSettings'},
        {caption: 'タグ付き取引を検索', functionName: 'menuFindTaggedTransactions'},
        {caption: 'タグ遡及の対象ファイル', functionName: 'menuShowTagBackfillTargets'},
        {caption: 'このメニューについて', functionName: 'menuShowAbout'}
      ]}
    ]}]);
  });

  test('menu 2: onOpen reads no data even before a spreadsheet exists', () => {
    gas.stubs.reset();
    assert.doesNotThrow(() => gas.call('onOpen', []));
    assert.equal(gas.stubs.getApiCallCounts().batchGet, 0,
      '単純トリガーでマスターを読むと、メニューだけでなく定期取込まで巻き込む');
  });

  test('menu 3: every menu handler is global and has no trailing underscore', () => {
    const names = ['menuShowImportStatus', 'menuShowFileList', 'menuOpenReview', 'menuOpenLog',
      'menuShowLeases', 'menuCheckSettings', 'menuFindTaggedTransactions',
      'menuShowTagBackfillTargets', 'menuShowAbout'];
    names.forEach((name) => {
      assert.equal(gas.evaluate('typeof ' + name), 'function');
      assert.equal(name.endsWith('_'), false);
    });
  });

  test('menu 4: a reviewer never sees another customer file review or lease', () => {
    setup();
    putRows('恒久ファイルインデックス', 13, [
      indexRow('f1', 'C001', 'c1.csv', 'FAILED'), indexRow('f2', 'C002', 'c2.csv', 'FAILED')]);
    putRows('クレカ処理ログ', 40, [
      processRow('f1', 'C001', 'FAILED'), processRow('f2', 'C002', 'FAILED')]);
    putRows('要確認', 32, [reviewRow('r1', 'C001', 'PARTNER', 'OPEN', {fileName: 'c1-review.csv'}),
      reviewRow('r2', 'C002', 'PARTNER', 'OPEN', {fileName: 'c2-review.csv'})]);
    putRows('処理リース', 10, [leaseRow('l1', 'C001', 'f1', 'PROCESS', now),
      leaseRow('l2', 'C002', 'f2', 'PROCESS', now)]);
    gas.stubs.setActiveUser('reviewer@example.com');
    ['menuShowFileList', 'menuOpenReview', 'menuShowLeases'].forEach((name) => gas.call(name, []));
    const html = gas.stubs.getUiEvents().filter((event) => event.type === 'modal')
      .map((event) => event.html).join('\n');
    assert.match(html, /c1\.csv/);
    assert.match(html, /c1-review\.csv/);
    assert.doesNotMatch(html, /c2\.csv|c2-review\.csv/);
    assert.doesNotMatch(html, /f2\.csv/);
  });

  test('menu 5: the spreadsheet owner sees every active customer', () => {
    setup();
    putRows('恒久ファイルインデックス', 13, [
      indexRow('f1', 'C001', 'c1.csv', 'COMPLETED'), indexRow('f2', 'C002', 'c2.csv', 'COMPLETED')]);
    gas.stubs.setActiveUser('owner@example.com');
    gas.call('menuShowFileList', []);
    assert.match(lastEvent('modal').html, /c1\.csv/);
    assert.match(lastEvent('modal').html, /c2\.csv/);
  });

  test('menu 6: an unauthorized user gets the exact refusal and no modal', () => {
    setup();
    gas.stubs.setActiveUser('nobody@example.com');
    gas.call('menuShowFileList', []);
    const events = gas.stubs.getUiEvents();
    assert.equal(events.filter((event) => event.type === 'modal').length, 0);
    assert.match(lastEvent('alert').prompt,
      /閲覧を許可された顧客がありません。実行者: nobody@example\.com。顧客マスターの Q列（確認担当者）または R列（システム管理者）にこのアドレスを登録してください。/);
  });

  test('menu 7: an empty active-user email is refused with the exact reason', () => {
    setup();
    gas.stubs.setActiveUser('');
    gas.call('menuShowImportStatus', []);
    assert.match(lastEvent('alert').prompt,
      /実行者のメールアドレスを取得できないため表示できません（仕様 §20\.5）。スクリプトの承認が済んでいるか確認してください。/);
  });

  test('menu 8: only the owner sees customerless index rows', () => {
    setup();
    putRows('恒久ファイルインデックス', 13, [indexRow('orphan', '', 'orphan.csv', 'FAILED')]);
    gas.stubs.setActiveUser('reviewer@example.com');
    gas.call('menuShowFileList', []);
    assert.doesNotMatch(lastEvent('modal').html, /orphan\.csv/);
    gas.stubs.resetUiEvents();
    gas.stubs.setActiveUser('owner@example.com');
    gas.call('menuShowFileList', []);
    assert.match(lastEvent('modal').html, /orphan\.csv/);
    assert.match(lastEvent('modal').html, /（顧客不明）/);
  });

  test('menu 9: import-status warnings are complete and ordered', () => {
    const collected = emptyCollected();
    collected.lastActivityAt = '2026-09-10T11:20:00+09:00';
    collected.files = [
      {fileId: 'failed1', customerId: 'C001', state: 'FAILED', errorCount: 1},
      {fileId: 'failed2', customerId: 'C001', state: 'FAILED', errorCount: 0},
      {fileId: 'stuck1', customerId: 'C001', state: 'VALIDATING', errorCount: 0, lease: null},
      {fileId: 'fix1', customerId: 'C001', state: 'CUSTOMER_FIX_REQUIRED', errorCount: 0},
      {fileId: 'new1', customerId: 'C001', state: 'DISCOVERED', errorCount: 0},
      {fileId: 'oldError', customerId: 'C001', state: 'COMPLETED', errorCount: 1}
    ];
    collected.leases = [{leaseId: 'lease1', customerId: 'C001', fileId: 'stuck1', stalled: true}];
    const text = plain(gas.call('buildImportStatusView_', [collected, baseScope(), now, 0])).text;
    const warnings = ['失敗したファイルが 2 件', '処理が止まったままのファイルが 1 件',
      '顧客の修正待ちが 1 件', '取込待ちが 1 件', 'エラー記録のあるファイルが 1 件'];
    let at = -1;
    warnings.forEach((warning) => {
      const next = text.indexOf(warning);
      assert.ok(next > at, warning + ' の順序が仕様どおりであること');
      at = next;
    });
  });

  test('menu 10: a healthy status explicitly says no anomaly was found', () => {
    const collected = emptyCollected();
    collected.files = [{fileId: 'waiting', customerId: 'C001', state: 'DISCOVERED', errorCount: 0}];
    collected.lastActivityAt = '2026-09-10T11:50:00+09:00';
    const text = plain(gas.call('buildImportStatusView_', [collected, baseScope(), now, 1])).text;
    assert.match(text, /異常は見つかりませんでした/);
    assert.doesNotMatch(text, /30分以上動きがありません/);
  });

  test('menu 11: all nine file states remain visible at zero', () => {
    const text = plain(gas.call('buildImportStatusView_', [emptyCollected(), baseScope(), now, 0])).text;
    ['DISCOVERED', 'VALIDATING', 'WRITING', 'REVIEW_WAIT', 'CUSTOMER_FIX_REQUIRED',
      'COMPLETED', 'CANCELED', 'EXCLUDED', 'FAILED'].forEach((state) => assert.match(text, new RegExp(state)));
  });

  test('menu 12: import collection always costs exactly four batch reads', () => {
    setup();
    const heartbeat = '2026-09-10T11:59:00+09:00';
    putRows('処理リース', 10, [leaseRow('lp', 'C001', 'f1', 'PROCESS', heartbeat),
      leaseRow('lw', 'C001', 'f2', 'WRITE_ONLY', heartbeat)]);
    [3, 30].forEach((count) => {
      const indexes = [];
      const processes = [];
      for (let i = 0; i < count; i += 1) {
        indexes.push(indexRow('f' + (i + 1), 'C001', 'file' + i + '.csv', 'COMPLETED'));
        processes.push(processRow('f' + (i + 1), 'C001', 'COMPLETED'));
      }
      putRows('恒久ファイルインデックス', 13, indexes);
      putRows('クレカ処理ログ', 40, processes);
      gas.stubs.resetApiCallCounts();
      gas.call('collectImportStatus_', [{now}]);
      assert.equal(gas.stubs.getApiCallCounts().batchGet, 4,
        'リースごとの処理ログ再読込は対話画面を件数比例で遅くする');
    });
  });

  test('menu 13: transaction totals equal process-log columns R through V', () => {
    setup();
    putRows('恒久ファイルインデックス', 13, [
      indexRow('own', 'C001', 'own.csv', 'COMPLETED'),
      indexRow('other', 'C002', 'other.csv', 'COMPLETED')]);
    putRows('クレカ処理ログ', 40, [
      processRow('own', 'C001', 'COMPLETED', {read: 10, auto: 7, review: 2, excluded: 1}),
      processRow('other', 'C002', 'COMPLETED', {read: 90, auto: 80, review: 5, excluded: 3, error: 2})]);
    const heartbeat = new Date().toISOString();
    putRows('処理リース', 10, [
      leaseRow('own-lease', 'C001', 'own', 'PROCESS', heartbeat),
      leaseRow('other-lease', 'C002', 'other', 'PROCESS', heartbeat)]);
    putRows('要確認', 32, [
      reviewRow('own-review', 'C001', 'PARTNER'),
      reviewRow('other-review', 'C002', 'PARTNER')]);
    gas.stubs.setActiveUser('reviewer@example.com');
    gas.call('menuShowImportStatus', []);
    const text = lastEvent('alert').prompt;
    assert.match(text, /ファイル（合計 1）/);
    assert.match(text, /読取 10 \/ 自動確定 7 \/ 要確認 2 \/ 除外 1 \/ エラー 0/);
    assert.match(text, /未解決の要確認: 1/);
    assert.match(text, /リース: 有効 1 \/ 停滞 0/);
  });

  test('menu 14: file rows use state priority then newest start time', () => {
    const collected = emptyCollected();
    collected.files = [
      {fileId: 'excluded', customerId: 'C001', fileName: 'excluded.csv', state: 'EXCLUDED'},
      {fileId: 'old', customerId: 'C001', fileName: 'old.csv', state: 'FAILED', startedAt: '2026-09-01T00:00:00+09:00'},
      {fileId: 'new', customerId: 'C001', fileName: 'new.csv', state: 'FAILED', startedAt: '2026-09-02T00:00:00+09:00'},
      {fileId: 'writing', customerId: 'C001', fileName: 'writing.csv', state: 'WRITING'}
    ];
    const rows = plain(gas.call('buildFileListRows_', [collected, baseScope(), now])).rows;
    assert.deepEqual(rows.map((row) => row[1]), ['new.csv', 'old.csv', 'writing.csv', 'excluded.csv']);
  });

  test('menu 15: file rows stop at 300 and omit completed rows last', () => {
    const collected = emptyCollected();
    collected.files.push({fileId: 'urgent', customerId: 'C001', fileName: 'urgent.csv', state: 'FAILED'});
    for (let i = 0; i < 300; i += 1) {
      collected.files.push({fileId: 'done' + i, customerId: 'C001',
        fileName: String(i).padStart(3, '0') + '.csv', state: 'COMPLETED'});
    }
    const result = plain(gas.call('buildFileListRows_', [collected, baseScope(), now]));
    assert.equal(result.rows.length, 300);
    assert.equal(result.omitted, 1);
    assert.equal(result.rows[0][1], 'urgent.csv');
    assert.equal(result.rows.some((row) => row[1] === '299.csv'), false);
  });

  test('menu 16: lastError uses the last real error after the truncation marker', () => {
    setup();
    putRows('恒久ファイルインデックス', 13, [indexRow('f1', 'C001', 'f1.csv', 'FAILED')]);
    putRows('クレカ処理ログ', 40, [processRow('f1', 'C001', 'FAILED', {errors: JSON.stringify([
      {truncated: true, droppedCount: 4}, {code: 'OLD', detail: 'old'}, {code: 'NEW', detail: 'latest'}
    ])})]);
    const result = plain(gas.call('collectImportStatus_', [{now}]));
    assert.equal(result.files[0].lastError, 'NEW: latest');
  });

  test('menu 17: file names are escaped before entering modal HTML', () => {
    const collected = emptyCollected();
    collected.files = [{fileId: 'x', customerId: 'C001',
      fileName: '<script>alert(1)</script>.csv', state: 'FAILED'}];
    const built = plain(gas.call('buildFileListRows_', [collected, baseScope(), now]));
    const html = gas.call('renderMenuTable_', [[], built.columns, built.rows, [], []]);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
  });

  test('menu 18: review rows show type counts owners and open-state labels', () => {
    const reviews = [
      {reviewId: 'r1', customerId: 'C001', customerName: '顧客一', reviewType: 'PARTNER', status: 'OPEN', registeredAt: '2026-09-01T00:00:00+09:00'},
      {reviewId: 'r2', customerId: 'C001', customerName: '顧客一', reviewType: 'PARTNER', status: 'IN_PROGRESS', registeredAt: '2026-09-02T00:00:00+09:00'},
      {reviewId: 'r3', customerId: 'C001', customerName: '顧客一', reviewType: 'INTEGRITY', status: 'OPEN', registeredAt: '2026-09-03T00:00:00+09:00'}
    ];
    const result = plain(gas.call('buildReviewRows_', [reviews, baseScope(), now]));
    assert.match(result.summaryLine, /未解決 3 件（取引先 2、整合性 1）/);
    assert.deepEqual(result.rows.map((row) => [row[1], row[2]]), [
      ['確認担当者', '未着手'], ['確認担当者', '対応中'], ['システム管理者', '未着手']]);
  });

  test('menu 19: review modal links to the review sheet gid', () => {
    setup();
    gas.stubs.setActiveUser('reviewer@example.com');
    gas.call('menuOpenReview', []);
    const gid = sheet('要確認').getSheetId();
    assert.match(lastEvent('modal').html, new RegExp('#gid=' + gid));
  });

  test('menu 20: log navigation activates the local master sheet without a modal', () => {
    setup();
    gas.stubs.setActiveUser('reviewer@example.com');
    gas.call('menuOpenLog', []);
    assert.equal(gas.stubs.getActiveSheetName('master'), 'クレカ処理ログ');
    assert.equal(gas.stubs.getUiEvents().filter((event) => event.type === 'modal').length, 0);
  });

  test('menu 21: a different container gets a process-log link modal', () => {
    setup();
    gas.stubs.createSpreadsheet('other', {sheets: [{name: '別', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('other');
    gas.stubs.setActiveUser('reviewer@example.com');
    gas.call('menuOpenLog', []);
    assert.match(lastEvent('modal').html, /master#gid=/);
  });

  test('menu 22: a hidden log sheet stays hidden and gets an explanatory link', () => {
    setup();
    gas.stubs.hideSheet('master', 'クレカ処理ログ');
    gas.stubs.setActiveUser('reviewer@example.com');
    gas.call('menuOpenLog', []);
    assert.match(lastEvent('modal').html, /非表示/);
    assert.equal(gas.stubs.getActiveSheetName('master'), null);
  });

  test('menu 23: settings diagnostics mirror an IMPORT validation stop in id order', () => {
    setup();
    gas.stubs.setActiveUser('reviewer@example.com');
    gas.evaluate("SETTINGS.TX_INDEX_SPREADSHEET_ID = '';");
    const run = plain(gas.call('runImport', [{}]));
    assert.equal(run.stoppedBy, 'SETTINGS_INVALID');
    gas.stubs.resetUiEvents();
    gas.call('menuCheckSettings', []);
    const prompt = lastEvent('alert').prompt;
    assert.match(prompt, /設定検査（scope = IMPORT）: 不合格/);
    const checks = plain(gas.call('settingsChecksFor', ['IMPORT']));
    let position = -1;
    checks.forEach((check, index) => {
      const next = prompt.indexOf('#' + check.id + ' ' + check.name + ':');
      assert.ok(next > position, check.name + ' が宣言順に表示されること');
      position = next;
    });
  });

  test('menu 24: tagged search cancels quietly and defaults blanks without cross-customer rows', () => {
    setup();
    putRows('クレカ取引ログ', 47, [
      txRow('tx1', 'C001', 'f1', {merchant: '一号店', memo: '海外決済'}),
      txRow('tx2', 'C002', 'f2', {merchant: '二号店', memo: '海外決済'})]);
    gas.stubs.setActiveUser('reviewer@example.com');
    gas.stubs.setPromptResponses([{button: 'CANCEL', text: ''}]);
    gas.call('menuFindTaggedTransactions', []);
    assert.equal(gas.stubs.getUiEvents().filter((event) => event.type === 'modal').length, 0);
    gas.stubs.resetUiEvents();
    gas.stubs.setPromptResponses([{button: 'OK', text: '   '}]);
    gas.call('menuFindTaggedTransactions', []);
    assert.match(lastEvent('modal').html, /タグ「海外決済」: 1 件/);
    assert.match(lastEvent('modal').html, /一号店/);
    assert.doesNotMatch(lastEvent('modal').html, /二号店/);
  });

  test('menu 25: lease diagnostic uses the same detectable and releasable thresholds as ops', () => {
    setup();
    const old = new Date(Date.now() - 400000).toISOString();
    const recent = new Date(Date.now() - 100000).toISOString();
    putRows('処理リース', 10, [leaseRow('old', 'C001', 'f1', 'PROCESS', old),
      leaseRow('new', 'C001', 'f2', 'PROCESS', recent)]);
    putRows('クレカ処理ログ', 40, [processRow('f1', 'C001', 'VALIDATING', {fileName: 'old.csv'}),
      processRow('f2', 'C001', 'VALIDATING', {fileName: 'new.csv'})]);
    const ops = plain(gas.call('opsShowLeases', []));
    gas.stubs.setActiveUser('reviewer@example.com');
    gas.call('menuShowLeases', []);
    const html = lastEvent('modal').html;
    const menuRows = [...html.matchAll(/<tr>(.*?)<\/tr>/gs)].slice(1).map((match) =>
      [...match[1].matchAll(/<td>(.*?)<\/td>/gs)].map((cell) => cell[1]));
    assert.equal(menuRows.length, ops.length);
    ops.forEach((line) => {
      const expected = /\| 検出(可|不可) \| 解放(可|不可) \| ([^|]+)$/.exec(line);
      assert.ok(expected, 'opsShowLeases の行形式を解析できること');
      const row = menuRows.find((item) => item[8] === expected[3]);
      assert.ok(row, expected[3] + ' がメニューにも表示されること');
      assert.deepEqual([row[6], row[7]], [expected[1], expected[2]]);
    });
  });

  test('menu 26: backfill modal shows the same scoped file set as the ops detail', () => {
    setup();
    putRows('クレカ処理ログ', 40, [processRow('f1', 'C001', 'COMPLETED', {fileName: 'one.csv'}),
      processRow('f2', 'C002', 'COMPLETED', {fileName: 'two.csv'})]);
    putRows('クレカ取引ログ', 47, [
      txRow('tx1', 'C001', 'f1', {merchant: 'キャッシュバック店'}),
      txRow('tx2', 'C002', 'f2', {merchant: 'キャッシュバック店'})]);
    const expected = gas.call('collectTagBackfillTargets_', [])
      .filter((item) => item.customerId === 'C001').map((item) => item.fileName);
    gas.stubs.resetUiEvents();
    gas.stubs.setActiveUser('reviewer@example.com');
    gas.call('menuShowTagBackfillTargets', []);
    const html = lastEvent('modal').html;
    expected.forEach((name) => assert.match(html, new RegExp(name)));
    assert.doesNotMatch(html, /two\.csv/);
  });

  test('menu 27: error classification covers specification rows 1 through 6 and 8', () => {
    const cases = [
      ["new AuthorizationError('拒否理由')", /拒否理由/],
      ["Object.assign(new Error('MASTER_SPREADSHEET_ID missing'), {code:'CUSTOMER_MASTER_INVALID'})", /マスタースプレッドシートが設定されていません/],
      ["Object.assign(new Error('bad row'), {code:'CUSTOMER_MASTER_INVALID'})", /顧客マスターの内容に不備があります/],
      ["new Error('Required sheet not found: 要確認')", /必要なシート「要確認」がありません/],
      ["new ReferenceError('Sheets is not defined')", /Sheets API サービスが有効になっていません/],
      ["Object.assign(new Error('rate'), {code:429})", /1分ほど待ってから再実行/],
      ["Object.assign(new Error('boom'), {name:'RangeError', code:'X'})", /エラー: RangeError: boom.*コード: X.*管理者へ連絡/s]
    ];
    cases.forEach(([source, expected]) => {
      const result = plain(gas.evaluate('classifyMenuError_(' + source + ')'));
      assert.match(result.lines.join('\n'), expected);
    });
  });

  test('menu 28: a UI-less invocation rethrows the original getUi error', () => {
    setup();
    gas.stubs.setUiAvailable(false);
    assert.throws(() => gas.call('menuShowImportStatus', []), /Cannot call SpreadsheetApp\.getUi/);
  });

  test('menu 29: collection failure shows one alert and logs the menu stack', () => {
    setup();
    gas.stubs.setActiveUser('reviewer@example.com');
    const master = gas.stubs.getSpreadsheet('master');
    master.deleteSheet(master.getSheetByName('要確認'));
    gas.call('menuShowImportStatus', []);
    assert.equal(gas.stubs.getUiEvents().filter((event) => event.type === 'alert').length, 1);
    assert.equal(gas.stubs.getUiEvents().filter((event) => event.type === 'modal').length, 0);
    assert.ok(gas.stubs.getLogLines().some((line) => line.startsWith('[menu] 取込の状況 failed:')));
  });

  test('menu 30: refactored ops keep their legacy return and Logger formats', () => {
    setup();
    assert.deepEqual(plain(gas.call('opsShowLeases', [])), ['(リースなし)']);
    assert.equal(gas.stubs.getLogLines().slice(-1)[0], '');
    assert.deepEqual(plain(gas.call('opsShowTaggedTransactions', ['海外決済'])), ['(該当なし)']);
    assert.equal(gas.stubs.getLogLines().slice(-1)[0], '');
    const emptyBackfill = plain(gas.call('opsFilesNeedingTagBackfill', []));
    assert.deepEqual(emptyBackfill, {files: 0, fileNames: [], detail: []});
    assert.equal(gas.stubs.getLogLines().slice(-1)[0], JSON.stringify(emptyBackfill, null, 2));

    const heartbeat = new Date(Date.now() - 100000).toISOString();
    putRows('処理リース', 10, [leaseRow('lease1', 'C001', 'f1', 'PROCESS', heartbeat)]);
    putRows('クレカ処理ログ', 40, [
      processRow('f1', 'C001', 'VALIDATING', {fileName: 'lease.csv'})]);
    const leaseLines = plain(gas.call('opsShowLeases', []));
    assert.equal(leaseLines.length, 1);
    assert.match(leaseLines[0],
      /^lease\.csv \| VALIDATING \| PROCESS \| owner=worker@example\.com \| 心拍から\d+秒 \| 検出不可 \| 解放不可 \| f1$/);
    assert.equal(gas.stubs.getLogLines().slice(-1)[0], leaseLines[0]);

    putRows('クレカ取引ログ', 47, [txRow('tx1', 'C001', 'f1', {
      merchant: 'ABC', memo: '海外決済', taxPlanned: '課税', taxVerified: '確認済', destinationRow: 9
    })]);
    const expected = 'ABC | メモタグ=海外決済 | 税区分 予定=課税 確認=確認済 | 行=9';
    assert.deepEqual(plain(gas.call('opsShowTaggedTransactions', ['海外決済'])), [expected]);
    assert.equal(gas.stubs.getLogLines().slice(-1)[0], expected);

    const backfill = plain(gas.call('opsFilesNeedingTagBackfill', []));
    const expectedBackfill = {
      files: 1,
      fileNames: ['lease.csv (VALIDATING, ハッシュなし, 1件)'],
      detail: [{
        fileId: 'f1', fileName: 'lease.csv', state: 'VALIDATING', contentHash: 'なし',
        stale: ['ABC | メモ 海外決済→仕入れ | 税 課税→(空)']
      }]
    };
    assert.deepEqual(backfill, expectedBackfill);
    assert.equal(gas.stubs.getLogLines().slice(-1)[0], JSON.stringify(expectedBackfill, null, 2));
  });

  test('menu 31: collected backfill targets expose enumerable customerIds without changing ops JSON', () => {
    setup();
    putRows('クレカ処理ログ', 40, [processRow('f1', 'C001', 'COMPLETED', {fileName: 'one.csv'})]);
    putRows('クレカ取引ログ', 47, [txRow('tx1', 'C001', 'f1', {merchant: 'キャッシュバック店'})]);
    const collected = gas.call('collectTagBackfillTargets_', []);
    assert.equal(collected[0].customerId, 'C001');
    assert.equal(Object.keys(collected[0]).includes('customerId'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(
      gas.call('opsFilesNeedingTagBackfill', []).detail[0], 'customerId'), false);
  });

  test('menu 32: label tables match every enum exactly', () => {
    const maps = plain(gas.evaluate('({file:MENU_FILE_STATE_LABELS_, review:MENU_REVIEW_TYPE_LABELS_,' +
      ' owner:MENU_REVIEW_HANDLER_LABELS_, lease:MENU_LEASE_PURPOSE_LABELS_})'));
    const enums = plain(gas.evaluate('({file:FILE_STATE, review:REVIEW_TYPE, lease:LEASE_PURPOSE})'));
    assert.deepEqual(Object.keys(maps.file).sort(), Object.keys(enums.file).sort());
    assert.deepEqual(Object.keys(maps.review).sort(), Object.keys(enums.review).sort());
    assert.deepEqual(Object.keys(maps.owner).sort(), Object.keys(enums.review).sort());
    assert.deepEqual(Object.keys(maps.lease).sort(), Object.keys(enums.lease).sort());
  });

  test('menu 33: menu timestamps and age boundaries follow the JST rules', () => {
    assert.equal(gas.call('formatMenuTimestamp_', ['2026-09-10T12:34:56+09:00']), '2026-09-10 12:34');
    assert.equal(gas.call('formatMenuTimestamp_', [new Date('2026-09-10T03:34:56Z')]), '2026-09-10 12:34');
    assert.equal(gas.call('formatMenuTimestamp_', [46275]), '2026-09-10 00:00');
    assert.equal(gas.call('formatMenuTimestamp_', ['']), '-');
    assert.equal(gas.call('describeAge_', [new Date(now.getTime() - 59000), now]), 'たった今');
    assert.equal(gas.call('describeAge_', [new Date(now.getTime() - 60000), now]), '1分前');
    assert.equal(gas.call('describeAge_', [new Date(now.getTime() - 59 * 60000), now]), '59分前');
    assert.equal(gas.call('describeAge_', [new Date(now.getTime() - 48 * 3600000), now]), '2日前');
  });

  test('menu 34: collected stalled leases match the established detector on five branches', () => {
    setup();
    gas.evaluate('SETTINGS.HEARTBEAT_TIMEOUT_SECONDS = 300;');
    const old = new Date(Date.now() - 600000).toISOString();
    const recent = new Date(Date.now() - 60000).toISOString();
    putRows('恒久ファイルインデックス', 13, [
      indexRow('orphan', 'C001', 'orphan.csv', 'VALIDATING'),
      indexRow('validating', 'C001', 'validating.csv', 'VALIDATING'),
      indexRow('completed', 'C001', 'completed.csv', 'COMPLETED'),
      indexRow('writeonly', 'C001', 'writeonly.csv', 'COMPLETED'),
      indexRow('recent', 'C001', 'recent.csv', 'VALIDATING')]);
    putRows('クレカ処理ログ', 40, [
      processRow('validating', 'C001', 'VALIDATING'),
      processRow('completed', 'C001', 'COMPLETED'),
      processRow('writeonly', 'C001', 'COMPLETED'),
      processRow('recent', 'C001', 'VALIDATING')]);
    putRows('処理リース', 10, [
      leaseRow('l-orphan', 'C001', 'orphan', 'PROCESS', old),
      leaseRow('l-validating', 'C001', 'validating', 'PROCESS', old),
      leaseRow('l-completed', 'C001', 'completed', 'PROCESS', old),
      leaseRow('l-writeonly', 'C001', 'writeonly', 'WRITE_ONLY', old),
      leaseRow('l-recent', 'C001', 'recent', 'PROCESS', recent)]);
    const expected = plain(gas.call('detectStalledLeases', [])).map((lease) => lease.leaseId).sort();
    const actual = plain(gas.call('collectImportStatus_', [{now: new Date()}])).leases
      .filter((lease) => lease.stalled).map((lease) => lease.leaseId).sort();
    assert.deepEqual(actual, expected);
  });

  test('menu 35: only configured state prefixes are removed from file names', () => {
    const prefixes = plain(gas.evaluate('Object.keys(STATE_TO_PREFIX).map(function(k){return STATE_TO_PREFIX[k];})'))
      .filter((value, index, all) => value && all.indexOf(value) === index);
    const collected = emptyCollected();
    collected.files = prefixes.map((prefix, index) => ({fileId: 'p' + index, customerId: 'C001',
      fileName: prefix + '明細' + index + '.csv', state: 'COMPLETED'}));
    collected.files.push({fileId: 'own', customerId: 'C001', fileName: '【経費】明細.csv', state: 'COMPLETED'});
    const names = plain(gas.call('buildFileListRows_', [collected, baseScope(), now])).rows.map((row) => row[1]);
    prefixes.forEach((prefix) => assert.equal(names.some((name) => name.startsWith(prefix)), false));
    assert.equal(names.includes('【経費】明細.csv'), true);
  });

  test('menu 36: malformed process-error JSON never hides status or file list', () => {
    setup();
    putRows('恒久ファイルインデックス', 13, [
      indexRow('broken', 'C001', 'broken.csv', 'FAILED'),
      indexRow('marked', 'C001', 'marked.csv', 'FAILED')]);
    putRows('クレカ処理ログ', 40, [
      processRow('broken', 'C001', 'FAILED', {errors: '{broken'}),
      processRow('marked', 'C001', 'FAILED', {errors: JSON.stringify([
        {truncated: true, droppedCount: 1}, {code: 'LATEST', detail: '残す'}
      ])})]);
    gas.stubs.setActiveUser('reviewer@example.com');
    gas.call('menuShowImportStatus', []);
    assert.equal(lastEvent('alert').type, 'alert');
    gas.stubs.resetUiEvents();
    gas.call('menuShowFileList', []);
    const html = lastEvent('modal').html;
    assert.match(html, /broken\.csv/);
    assert.match(html, />-</);
    assert.match(html, /LATEST: 残す/);
  });

  test('menu 37: repeated discovered failures use the notification watch without changing legacy calls', () => {
    const collected = emptyCollected();
    collected.lastActivityAt = '2026-09-10T11:55:00+09:00';
    collected.files = [
      {fileId: 'fileA', customerId: 'C001', state: 'DISCOVERED', errorCount: 2, errorDropped: 0},
      {fileId: 'fileB', customerId: 'C001', state: 'DISCOVERED', errorCount: 7, errorDropped: 0},
      {fileId: 'fileC', customerId: 'C001', state: 'COMPLETED', errorCount: 5, errorDropped: 0}
    ];
    const watched = plain(gas.call('buildImportStatusView_',
      [collected, baseScope(), now, 0, {fileA: 1, fileB: 7}])).text;
    assert.match(watched, /取込に繰り返し失敗して取込待ちに戻っているファイルが 1 件/);
    assert.match(watched, /エラー記録のあるファイルが 2 件/);
    assert.ok(watched.indexOf('取込に繰り返し失敗') < watched.indexOf('エラー記録のあるファイル'));

    const legacy = plain(gas.call('buildImportStatusView_', [collected, baseScope(), now, 0])).text;
    assert.doesNotMatch(legacy, /取込に繰り返し失敗/);
    assert.match(legacy, /エラー記録のあるファイルが 3 件/);
  });
};

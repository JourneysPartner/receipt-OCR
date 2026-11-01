'use strict';

module.exports = ({test, assert, gas}) => {
  const plain = value => JSON.parse(JSON.stringify(value));
  const invoke = (id, apply, options) => gas.call('opsSetCustomerNamesFromFolders', [id, apply, options]);
  const rootId = 'cn-root-fake';
  const masterId = 'cn-master-fake';
  const sheet = name => gas.stubs.getSpreadsheet(masterId).getSheetByName(name);
  const master = () => sheet('顧客マスター');
  const audit = () => sheet('監査ログ');
  const snapshot = () => plain(master().getDataRange().getValues());
  const audits = () => audit().getDataRange().getValues().filter(row => row[11] === 'CUSTOMER_NAME_FROM_FOLDER');
  function mock(overrides, fn, target = gas.context) {
    const saved = {};
    for (const key of Object.keys(overrides)) { saved[key] = target[key]; target[key] = overrides[key]; }
    try { return fn(); } finally { Object.assign(target, saved); }
  }
  function world(specs = [{}]) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet(masterId);
    gas.stubs.setActiveSpreadsheet(masterId);
    gas.call('setMasterSpreadsheetId', [masterId]);
    gas.call('provisionMasterSheets');
    gas.stubs.setActiveUser('cn-operator@example.invalid');
    gas.context.PropertiesService.getScriptProperties().setProperty('CUSTOMER_ROOT_FOLDER_ID', '  ' + rootId + '  ');
    const root = gas.stubs.createFolder(rootId, {name: '架空共通'});
    const category = gas.stubs.createFolder('cn-category-fake', {name: '法人', parentId: rootId});
    const rows = specs.map((spec, i) => {
      const id = 'CN_FAKE_' + i;
      const folderId = 'cn-customer-fake-' + i;
      const folderName = spec.name === undefined ? '架空顧客' + i : spec.name;
      const folder = gas.stubs.createFolder(folderId, {name: folderName, parentId: category.id});
      let sourceId = folderId;
      const names = spec.depth === undefined ? ['架空年度', '架空経費', '架空明細'] :
        Array.from({length: spec.depth}, (_, j) => '架空階層' + j);
      const chain = [folder];
      names.forEach((name, j) => {
        const next = gas.stubs.createFolder('cn-child-fake-' + i + '-' + j, {name, parentId: sourceId});
        chain.push(next); sourceId = next.id;
      });
      const templateId = 'cn-template-fake-' + i;
      gas.stubs.createSpreadsheet(templateId, {name: '架空雛形' + i,
        sheets: [{name: '架空入力', values: [['架空見出し']], maxColumns: 30}]});
      const parent = gas.stubs.createFolder('cn-output-fake-' + i, {name: '架空出力' + i, fileIds: [templateId]});
      const currentName = spec.current === undefined ? '架空仮名' + i : spec.current;
      gas.call('registerTestCustomer', [{customerId: id, customerName: '架空登録名' + i,
        sourceFolderId: sourceId, destinationSpreadsheetId: templateId,
        destinationSheetName: '架空入力', headerRow: 1, rowScanLastColumn: 30,
        columns: {B: 2, F: 6, I: 9, K: 11, M: 13, txId: 30}}]);
      master().getRange(i + 2, 2).setValue(currentName);
      master().getRange(i + 2, 3).setValue(spec.active !== false);
      return {id, row: i + 2, folder, chain, parent, templateId, sourceId, currentName,
        path: [category.name, folderName, ...names]};
    });
    gas.call('appendAudit', [{type: 'SETTING', targetId: 'CN_SEED_FAKE'}]);
    gas.stubs.clearLogs();
    gas.stubs.resetApiCallCounts();
    return {rows, root, category};
  }
  function addFile(row, name) {
    const id = 'cn-destination-fake-' + row.parent.fileIds.length;
    gas.stubs.createFile(id, {name}); row.parent.fileIds.push(id);
  }
  function onLock(change, fn) {
    const lock = gas.stubs.getScriptLock(), real = lock.tryLock;
    let changed = false;
    return mock({tryLock(...args) {
      if (!changed) { changed = true; change(); }
      return real.apply(this, args);
    }}, fn, lock);
  }
  function assertNoWrites(before) {
    assert.deepEqual(snapshot(), before);
    assert.equal(audits().length, 0);
    assert.equal(gas.stubs.getApiCallCounts().batchUpdate, 0);
  }

  test('cn 1: finds the customer folder and path without any writes', () => {
    const {rows: [row]} = world();
    const before = snapshot(), auditBefore = plain(audit().getDataRange().getValues());
    const result = plain(invoke());
    assert.deepEqual(result, {applied: false, stoppedBy: null, nextStartRow: null,
      counts: {CHANGE: 1}, customers: [{customerId: row.id, rowNumber: 2, active: true,
        currentName: row.currentName, folderName: row.folder.name, path: row.path,
        status: 'CHANGE', reason: null, destinationCount: 0}]});
    assertNoWrites(before);
    assert.deepEqual(plain(audit().getDataRange().getValues()), auditBefore);
    assert.equal(gas.stubs.getLogs().at(-1), JSON.stringify(result));
  });

  test('cn 2: variable depth and the personal category resolve the same level', () => {
    const {rows, category} = world([{depth: 0}, {depth: 1}, {depth: 7}, {depth: 2, name: '  架空個人顧客  '}]);
    const personal = gas.stubs.createFolder('cn-personal-fake', {name: '個人', parentId: rootId});
    category.subFolderIds = category.subFolderIds.filter(id => id !== rows[3].folder.id);
    personal.subFolderIds.push(rows[3].folder.id);
    const result = invoke();
    assert.deepEqual(Array.from(result.customers, r => r.folderName),
      ['架空顧客0', '架空顧客1', '架空顧客2', '架空個人顧客']);
    assert.ok(result.customers.every(r => r.status === 'CHANGE'));
    assert.equal(result.customers[3].path[0], '個人');
  });

  test('cn 3: unresolved rows stay unchanged while another row is written', () => {
    const cases = ['NO_SOURCE_FOLDER', 'FOLDER_UNREADABLE', 'OUTSIDE', 'HIDDEN',
      'ROOT', 'CATEGORY', 'MULTIPLE_PARENTS', 'EMPTY_NAME', 'DEPTH_LIMIT', 'PARENT_ERROR'];
    for (const reason of cases) {
      const {rows: [bad, good], category} = world([{}, {}]);
      const expected = {OUTSIDE: 'ROOT_NOT_REACHED', HIDDEN: 'ROOT_NOT_REACHED', ROOT: 'TOO_SHALLOW',
        CATEGORY: 'TOO_SHALLOW', DEPTH_LIMIT: 'ROOT_NOT_REACHED', PARENT_ERROR: 'ROOT_NOT_REACHED'}[reason] || reason;
      if (reason === 'NO_SOURCE_FOLDER') master().getRange(2, 4).setValue('');
      if (reason === 'FOLDER_UNREADABLE') bad.chain.at(-1).readAllowed = false;
      if (reason === 'OUTSIDE') category.subFolderIds = [good.folder.id];
      if (reason === 'HIDDEN') bad.chain[1].readAllowed = false;
      if (reason === 'ROOT') master().getRange(2, 4).setValue(rootId);
      if (reason === 'CATEGORY') master().getRange(2, 4).setValue(category.id);
      if (reason === 'MULTIPLE_PARENTS') gas.stubs.createFolder('cn-extra-parent-fake',
        {name: '架空別親', subFolderIds: [bad.sourceId]});
      if (reason === 'EMPTY_NAME') bad.folder.name = ' 　';
      if (reason === 'DEPTH_LIMIT') {
        let parent = bad.sourceId;
        for (let i = 0; i < 21; i++) {
          const next = gas.stubs.createFolder('cn-deep-fake-' + i, {name: '架空深部' + i, parentId: parent});
          parent = next.id;
        }
        master().getRange(2, 4).setValue(parent);
      }
      const before = snapshot(), getFolder = gas.context.DriveApp.getFolderById;
      const run = () => invoke('', true);
      const result = reason === 'PARENT_ERROR' ? mock({getFolderById(id) {
        const handle = getFolder(id);
        if (id === bad.sourceId) handle.getParents = () => { throw new Error('cn-private-folder-fake'); };
        return handle;
      }}, run, gas.context.DriveApp) : run();
      assert.equal(result.customers[0].status, 'UNRESOLVED', reason);
      assert.equal(result.customers[0].reason, expected, reason);
      assert.equal(result.customers[1].status, 'WRITTEN', reason);
      before[good.row - 1][1] = good.folder.name;
      assert.deepEqual(snapshot(), before, reason);
      assert.equal(audits().length, 1, reason);
    }
  });

  test('cn 4: writes only B with one locked audit batch and repeat is SAME', () => {
    const {rows: [row]} = world([{}, {active: false}]);
    const before = snapshot(), entries = [], writes = [];
    const append = gas.context.appendAuditRowsUnlocked_;
    gas.stubs.onValuesBatchUpdate((request, id) => {
      assert.equal(id, masterId); assert.equal(gas.stubs.getScriptLock().locked, true);
      assert.equal(audits().length, 1, 'audit must precede B'); writes.push(plain(request));
    });
    try {
      const result = mock({appendAuditRowsUnlocked_(batch) {
        assert.equal(gas.stubs.getScriptLock().locked, true);
        entries.push(plain(batch)); return append(batch);
      }}, () => invoke(row.id, true));
      assert.equal(result.applied, true); assert.equal(result.customers[0].status, 'WRITTEN');
      before[row.row - 1][1] = row.folder.name;
      assert.deepEqual(snapshot(), before);
      assert.deepEqual(entries, [[{type: 'SETTING', actor: 'cn-operator@example.invalid', targetType: 'CUSTOMER',
        targetId: row.id, customerId: row.id, before: {B: row.currentName}, after: {B: row.folder.name},
        reason: 'CUSTOMER_NAME_FROM_FOLDER'}]]);
      assert.deepEqual(writes, [{valueInputOption: 'RAW', data: [
        {range: "'顧客マスター'!B2:B2", values: [[row.folder.name]]}]}]);
      assert.equal(gas.call('getCustomerById', [row.id]).customerName, row.folder.name);
      assert.equal(gas.call('verifyChain', ['RECENT']).ok, true);
      // SAME は雛形が読めなくても終われるので、繰返しで Drive を余分に読まない。
      mock({getFileById() { throw new Error('cn-template-private-fake'); }}, () => {
        const again = invoke(row.id, true);
        assert.equal(again.customers[0].status, 'SAME');
      }, gas.context.DriveApp);
      assert.equal(audits().length, 1); assert.equal(writes.length, 1);
    } finally { gas.stubs.onValuesBatchUpdate(null); }
  });

  test('cn 5: counts only exact destination suffixes and treats regex symbols literally', () => {
    for (const current of ['架空旧顧客', '架空[仮].+(値)$']) {
      for (const exists of [false, true]) {
        const {rows: [row]} = world([{current}]);
        ['_メモ', '_20261001-1200_写し'].forEach(suffix => addFile(row, current + suffix));
        addFile(row, '架空別顧客_20261001-1200');
        addFile(row, current + '_2026101-1200');
        if (exists) addFile(row, current + '_20261001-1200');
        const before = snapshot();
        for (const apply of [undefined, true]) {
          const result = invoke('', apply).customers[0];
          assert.equal(result.status, exists ? 'HAS_DESTINATIONS' : apply === true ? 'WRITTEN' : 'CHANGE');
          assert.equal(result.destinationCount, exists ? 1 : 0);
          if (exists) assertNoWrites(before);
        }
      }
    }
  });

  test('cn 5b: missing unreadable or ambiguous templates never write', () => {
    for (const reason of ['NO_TEMPLATE', 'TEMPLATE_LOCATION_UNKNOWN', 'TEMPLATE_UNREADABLE', 'NO_PARENT']) {
      const {rows: [row]} = world();
      if (reason === 'NO_TEMPLATE') master().getRange(2, 6).setValue('');
      if (reason === 'TEMPLATE_LOCATION_UNKNOWN') gas.stubs.createFolder('cn-other-output-fake',
        {name: '架空別出力', fileIds: [row.templateId]});
      if (reason === 'NO_PARENT') row.parent.fileIds.length = 0;
      if (reason === 'TEMPLATE_UNREADABLE') master().getRange(2, 6).setValue('cn-unreadable-template-fake');
      const before = snapshot(), result = invoke('', true).customers[0];
      assert.equal(result.status, 'UNRESOLVED');
      assert.equal(result.reason, reason === 'NO_PARENT' ? 'TEMPLATE_LOCATION_UNKNOWN' : reason);
      assertNoWrites(before);
    }
  });

  test('cn 6: rejects existing and proposed duplicate names including unselected rows', () => {
    for (const selected of [false, true]) {
      const {rows: [row]} = world([{name: '架空重複名'}, {current: '架空重複名', active: false}]);
      // 読むだけの報告も、ロック内の確かめに頼らず同名を示す。
      assert.equal(invoke(selected ? row.id : '').customers[0].status, 'DUPLICATE_NAME');
      const before = snapshot(), result = invoke(selected ? row.id : '', true);
      assert.equal(result.customers[0].status, 'DUPLICATE_NAME');
      if (selected) assertNoWrites(before);
      else assert.equal(master().getRange(2, 2).getValue(), row.currentName);
    }
    world([{name: '架空同時名'}, {name: '架空同時名'}]);
    const before = snapshot(), result = invoke('', true);
    assert.deepEqual(Array.from(result.customers, r => r.status), ['DUPLICATE_NAME', 'DUPLICATE_NAME']);
    assert.deepEqual(plain(result.counts), {DUPLICATE_NAME: 2}); assertNoWrites(before);
  });

  test('cn 7: lock rechecks A B D F destinations and other rows before writing', () => {
    for (const change of ['A', 'B', 'D', 'F', 'DESTINATION', 'DUPLICATE', 'UNREADABLE']) {
      const {rows: [row]} = world([{}, {}]);
      let before;
      const realFile = gas.context.DriveApp.getFileById;
      const result = mock({getFileById(id) {
        if (change === 'UNREADABLE' && gas.stubs.getScriptLock().locked) throw new Error('cn-private-template-fake');
        return realFile(id);
      }}, () => onLock(() => {
        const col = {A: 1, B: 2, D: 4, F: 6}[change];
        if (col) master().getRange(2, col).setValue('架空変更値');
        if (change === 'DESTINATION') addFile(row, row.currentName + '_20261001-1200');
        if (change === 'DUPLICATE') master().getRange(3, 2).setValue(row.folder.name);
        before = snapshot();
      }, () => invoke(row.id, true)), gas.context.DriveApp);
      assert.equal(result.customers[0].status, {DESTINATION: 'HAS_DESTINATIONS',
        DUPLICATE: 'DUPLICATE_NAME', UNREADABLE: 'UNRESOLVED'}[change] || 'STALE', change);
      assertNoWrites(before);
    }
  });

  test('cn 8: RAW preserves numeric date and formula shaped names', () => {
    const names = ['1001', '2026/10', '=1+1'];
    const {rows} = world(names.map(name => ({name})));
    const writes = [];
    gas.stubs.onValuesBatchUpdate((request, id) => { if (id === masterId) writes.push(plain(request)); });
    try {
      const result = invoke('', true);
      assert.ok(result.customers.every(r => r.status === 'WRITTEN'));
      assert.equal(writes.length, 1); assert.equal(writes[0].valueInputOption, 'RAW');
      rows.forEach((row, i) => {
        assert.equal(master().getRange(row.row, 2).getValue(), names[i]);
        assert.equal(gas.call('getCustomerById', [row.id]).customerName, names[i]);
      });
    } finally { gas.stubs.onValuesBatchUpdate(null); }
  });

  test('cn 9: audit failure propagates unchanged before any B write', () => {
    world(); const before = snapshot(), failure = new Error('cn-audit-failure-fake');
    mock({appendAuditRowsUnlocked_() { throw failure; }}, () => {
      assert.throws(() => invoke('', true), error => error === failure);
    });
    assertNoWrites(before);
  });

  test('cn 10: absent or blank root configuration never reads Drive', () => {
    for (const value of [null, ' 　']) {
      world(); const props = gas.context.PropertiesService.getScriptProperties();
      if (value === null) props.deleteProperty('CUSTOMER_ROOT_FOLDER_ID');
      else props.setProperty('CUSTOMER_ROOT_FOLDER_ID', value);
      const before = snapshot(); let driveReads = 0;
      const unexpected = () => { driveReads++; throw new Error('cn-unexpected-drive-fake'); };
      const result = mock({getFolderById: unexpected, getFileById: unexpected},
        () => invoke('', true), gas.context.DriveApp);
      assert.deepEqual(plain(result), {applied: false, stoppedBy: 'ROOT_NOT_CONFIGURED',
        nextStartRow: null, counts: {}, customers: []});
      assert.equal(driveReads, 0); assertNoWrites(before);
    }
  });

  test('cn 11: budget boundary writes completed rows and startRow resumes remaining rows', () => {
    const {rows} = world([{}, {}, {}]);
    const readFolder = gas.context.DriveApp.getFolderById;
    const realDate = gas.context.Date;
    let now = 0;
    class Clock extends realDate { static now() { return now; } }
    const result = mock({Date: Clock}, () => mock({getFolderById(id) {
      const handle = readFolder(id);
      if (id === rows[0].sourceId) now = 10;
      return handle;
    }}, () => invoke('', true, {timeBudgetMs: 10}), gas.context.DriveApp));
    assert.equal(result.stoppedBy, 'TIME_BUDGET'); assert.equal(result.nextStartRow, 3);
    assert.deepEqual(Array.from(result.customers, r => r.status), ['WRITTEN']);
    assert.equal(master().getRange(3, 2).getValue(), rows[1].currentName);
    const continuation = invoke('', true, {startRow: result.nextStartRow});
    assert.deepEqual(Array.from(continuation.customers, r => r.rowNumber), [3, 4]);
    assert.ok(continuation.customers.every(r => r.status === 'WRITTEN'));
    assert.equal(continuation.stoppedBy, null); assert.equal(continuation.nextStartRow, null);
    for (const budget of [0, -1]) {
      const stopped = invoke('', true, {timeBudgetMs: budget});
      assert.equal(stopped.stoppedBy, 'TIME_BUDGET'); assert.equal(stopped.nextStartRow, 2);
      assert.equal(stopped.customers.length, 0);
    }
    // 非有限値は既存の運用関数と同じ既定予算になる。
    for (const budget of [NaN, Infinity, 'invalid']) assert.equal(invoke('', false, {timeBudgetMs: budget}).customers.length, 3);
  });

  test('cn 12: entry selection blank ids and strict boolean apply', () => {
    const {rows} = world([{}, {active: false}]);
    const blankRow = Array(43).fill(''); blankRow[1] = '架空識別子なし'; master().appendRow(blankRow);
    const before = snapshot();
    for (const id of [undefined, null, '']) {
      const result = invoke(id); assert.equal(result.customers.length, 2);
      assert.equal(result.customers[1].active, false); assert.equal(result.applied, false);
    }
    const selected = invoke(rows[1].id);
    assert.deepEqual(Array.from(selected.customers, r => r.customerId), [rows[1].id]);
    for (const apply of ['true', 1]) { assert.equal(invoke('', apply).applied, false); assertNoWrites(before); }
    assert.throws(() => invoke('CN_MISSING_FAKE'), error => error.name === 'MasterDataError' &&
      error.detail === 'Customer not found: CN_MISSING_FAKE');
    master().getRange(3, 1).setValue(rows[0].id);
    assert.throws(() => invoke(rows[0].id), error => error.name === 'MasterDataError' && error.detail === 'Duplicate customerId');
  });

  test('cn 13: repairs a blank active name without validated customer readers', () => {
    const {rows: [row]} = world([{current: ''}]);
    // B が空なら転記シートの名前の規則が成り立たないので、`_日時` のファイルは数えない。
    addFile(row, '_20261001-1200');
    assert.throws(() => gas.call('getActiveCustomers'));
    const unexpected = () => { throw new Error('cn-validated-reader-fake'); };
    const result = mock({getActiveCustomers: unexpected, getCustomerById: unexpected}, () => invoke('', true));
    assert.equal(result.customers[0].status, 'WRITTEN');
    assert.equal(gas.call('getActiveCustomers')[0].customerName, row.folder.name);
  });

  test('cn 14: reports and logs never reveal folder or spreadsheet ids or exception text', () => {
    for (const apply of [undefined, true]) {
      const {rows: [row], category} = world([{}, {}]);
      master().getRange(3, 4).setValue('cn-private-missing-folder-fake');
      const result = invoke('', apply), logs = gas.stubs.getLogs();
      assert.equal(logs.at(-1), JSON.stringify(result));
      const output = JSON.stringify({result, logs});
      [rootId, masterId, category.id, row.templateId, row.parent.id, ...row.chain.map(f => f.id),
        'cn-private-missing-folder-fake', 'Folder not found'].forEach(id => assert.equal(output.includes(id), false, id));
    }
  });

  test('cn 15: measures exact Sheets read and write limits for dry run and apply', () => {
    const counts = {};
    for (const [mode, apply] of [['dry', undefined], ['apply', true]]) {
      world([{}, {}]);
      const result = invoke('', apply);
      const actual = gas.stubs.getApiCallCounts();
      counts[mode] = {batchGet: actual.batchGet, get: actual.get, batchUpdate: actual.batchUpdate,
        rangesWritten: actual.rangesWritten, cellsWritten: actual.cellsWritten};
      assert.equal(result.customers.length, 2);
    }
    console.log('CN_COUNTS ' + JSON.stringify(counts));
    // マスターと監査の読取も含め、初回の実測値を余裕なしで上限にする。
    assert.deepEqual(counts, {
      dry: {batchGet: 1, get: 0, batchUpdate: 0, rangesWritten: 0, cellsWritten: 0},
      apply: {batchGet: 3, get: 0, batchUpdate: 1, rangesWritten: 2, cellsWritten: 2}
    });
  });

  test('cn 16: the audit is flushed before B is written through the Sheets API', () => {
    world();
    const events = [], realFlush = gas.context.SpreadsheetApp.flush;
    const append = gas.context.appendAuditRowsUnlocked_;
    gas.stubs.onValuesBatchUpdate((request, id) => { if (id === masterId) events.push('B'); });
    try {
      // 監査の末尾を読むときにも flush が走るので、書き終えた後に記録する。
      mock({appendAuditRowsUnlocked_(batch) { const ids = append(batch); events.push('audit'); return ids; }}, () => {
        mock({flush() { events.push('flush'); return realFlush.call(this); }}, () => invoke('', true),
          gas.context.SpreadsheetApp);
      });
    } finally { gas.stubs.onValuesBatchUpdate(null); }
    // 読取の前にも flush が入るので、監査より後の並びだけを見る。
    assert.deepEqual(events.slice(events.indexOf('audit'), events.indexOf('audit') + 3), ['audit', 'flush', 'B']);
  });

  test('cn 17: apply stops at half the default budget and a dry run at the whole budget', () => {
    for (const [apply, limit] of [[true, 135000], [undefined, 270000]]) {
      for (const [elapsed, stopped] of [[limit - 1, false], [limit, true]]) {
        const {rows} = world([{}, {}]);
        const readFolder = gas.context.DriveApp.getFolderById;
        let now = 0;
        class Clock extends gas.context.Date { static now() { return now; } }
        const result = mock({Date: Clock}, () => mock({getFolderById(id) {
          const handle = readFolder(id);
          if (id === rows[0].sourceId) now = elapsed;
          return handle;
        }}, () => invoke('', apply), gas.context.DriveApp));
        assert.equal(result.stoppedBy, stopped ? 'TIME_BUDGET' : null);
        assert.equal(result.customers.length, stopped ? 1 : 2);
      }
    }
  });
};

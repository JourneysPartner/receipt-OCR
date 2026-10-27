'use strict';

module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const customerId = 'TL_CUSTOMER_FAKE';
  const templateId = 'tl-template-fake';
  const sheetName = "雛形'架空";
  const mapping = {B: 2, F: 6, G: 7, I: 9, K: 11, M: 13, txId: 15};
  const candidates = [{row: 3, value: '対象外'}, {row: 6, value: ' \t対象外　'}];
  const others = [{row: 9, value: '架空税区分'}, {row: 14, value: ' 　'}];
  const call = (apply) => plain(gas.call('opsClearTemplateTaxLeftovers', [customerId, apply]));

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

  function world(columns = mapping) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('tl-master-fake', {sheets: [{name: '仮', values: [['仮']]}]});
    gas.stubs.setActiveSpreadsheet('tl-master-fake');
    gas.call('setMasterSpreadsheetId', ['tl-master-fake']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.setActiveUser('tl-operator@example.invalid');
    const values = Array.from({length: 15}, () => Array(16).fill(''));
    const formulas = Array.from({length: 15}, () => Array(16).fill(''));
    // 見出しも候補と同じ値にして、データ行の下限だけで除外できることを見る。
    values[0][(columns.G || 7) - 1] = '対象外';
    values[1][(columns.G || 7) - 1] = '対象外';
    candidates.forEach(({row, value}) => { values[row - 1][(columns.G || 7) - 1] = value; });
    values[2][0] = '架空保持値A';
    formulas[2][3] = '=1+2';
    values[5][15] = '架空保持値P';
    values[3][columns.txId - 1] = 'TL_TX_FAKE';
    values[3][(columns.G || 7) - 1] = '対象外';
    ['B', 'F', 'I', 'K', 'M'].forEach((key, index) => {
      const row = [5, 7, 8, 10, 11][index];
      values[row - 1][columns[key] - 1] = index === 4 ? 0 : '架空取引値_' + key;
      values[row - 1][(columns.G || 7) - 1] = '対象外';
    });
    values[8][(columns.G || 7) - 1] = '架空税区分';
    values[11][columns.B - 1] = false;
    values[11][(columns.G || 7) - 1] = '対象外';
    values[12][columns.txId - 1] = 0;
    values[12][(columns.G || 7) - 1] = '対象外';
    values[13][(columns.G || 7) - 1] = ' 　';
    const spreadsheet = gas.stubs.createSpreadsheet(templateId, {sheets: [
      {name: sheetName, values, formulas, maxRows: 30, maxColumns: 16},
      {name: '架空別シート', values: [['対象外']]}
    ]});
    gas.call('registerTestCustomer', [{customerId, customerName: '架空顧客',
      sourceFolderId: 'tl-source-fake', destinationSpreadsheetId: templateId,
      destinationSheetName: sheetName, headerRow: 2, rowScanLastColumn: 16,
      columns}]);
    const audit = gas.stubs.getSpreadsheet('tl-master-fake').getSheetByName('監査ログ');
    gas.call('appendAudit', [{type: 'SETTING', targetId: 'TL_SEED_FAKE'}]);
    gas.stubs.clearLogs();
    gas.stubs.resetApiCallCounts();
    return {spreadsheet, sheet: spreadsheet.getSheetByName(sheetName), audit};
  }

  function snapshot(spreadsheet) {
    return spreadsheet.getSheets().map((sheet) => ({name: sheet.getName(),
      values: sheet.getDataRange().getValues(), formulas: sheet.getDataRange().getFormulas()}));
  }

  function auditRows(audit) {
    return audit.getDataRange().getValues().filter((row) => row[11] === 'TEMPLATE_TAX_LEFTOVER');
  }

  test('tl 1: finds only template data rows with tax leftovers without writing', () => {
    const {spreadsheet, audit} = world();
    const before = snapshot(spreadsheet);
    const auditBefore = audit.getDataRange().getValues();
    const open = gas.context.SpreadsheetApp.openById;
    const batchGet = gas.context.Sheets.Spreadsheets.Values.batchGet;
    const reads = [];
    gas.context.SpreadsheetApp.openById = (id) => {
      assert.notEqual(id, templateId, 'dry run must not open the template');
      return open(id);
    };
    gas.context.Sheets.Spreadsheets.Values.batchGet = (id, request) => {
      if (id === templateId) reads.push(plain(request));
      return batchGet.call(gas.context.Sheets.Spreadsheets.Values, id, request);
    };
    try {
      [undefined, false, 'true', 1].forEach((apply) => {
        const result = call(apply);
        assert.deepEqual(result, {customerId, spreadsheetId: templateId, sheetName,
          candidates, others, cleared: [], applied: false});
        assert.deepEqual(snapshot(spreadsheet), before);
        assert.deepEqual(audit.getDataRange().getValues(), auditBefore);
      });
      assert.equal(reads.length, 4);
      reads.forEach((request) => {
        assert.deepEqual(request.ranges, ["'雛形''架空'!A3:P"]);
        assert.equal(request.valueRenderOption, 'UNFORMATTED_VALUE');
      });
      assert.equal(gas.stubs.getApiCallCounts().batchUpdate, 0);
    } finally {
      gas.context.SpreadsheetApp.openById = open;
      gas.context.Sheets.Spreadsheets.Values.batchGet = batchGet;
    }
  });

  test('tl 2: clears only candidate G cells and appends one audit outside the lock', () => {
    const {spreadsheet, audit} = world();
    const before = snapshot(spreadsheet);
    const auditBefore = audit.getLastRow();
    const append = gas.context.appendAudit;
    const entries = [];
    const writes = [];
    gas.stubs.onValuesBatchUpdate((request, id) => {
      if (id !== templateId) return;
      assert.equal(gas.stubs.getScriptLock().locked, true);
      writes.push(plain(request));
    });
    try {
      const result = withMocks({appendAudit: (entry) => {
        assert.equal(gas.stubs.getScriptLock().locked, false);
        entries.push(plain(entry));
        return append(entry);
      }}, () => call(true));
      assert.deepEqual(result, {customerId, spreadsheetId: templateId, sheetName,
        candidates, others, cleared: [3, 6], skippedRows: [], applied: true});
      const expected = plain(before);
      expected[0].values[2][6] = '';
      expected[0].values[5][6] = '';
      assert.deepEqual(snapshot(spreadsheet), expected);
      assert.deepEqual(writes, [{valueInputOption: 'RAW', data: [
        {range: "'雛形''架空'!G3:G3", values: [['']]},
        {range: "'雛形''架空'!G6:G6", values: [['']]}
      ]}]);
      assert.deepEqual(entries, [{type: 'TEMPLATE_CLEANUP', actor: 'tl-operator@example.invalid',
        targetType: 'DESTINATION', targetId: templateId, customerId,
        before: {rows: candidates}, after: {g: ''}, reason: 'TEMPLATE_TAX_LEFTOVER'}]);
      assert.equal(audit.getLastRow(), auditBefore + 1);
      const rows = auditRows(audit);
      assert.equal(rows.length, 1);
      assert.equal(rows[0][2], 'TEMPLATE_CLEANUP');
      assert.equal(rows[0][3], 'tl-operator@example.invalid');
      assert.equal(rows[0][6], 'DESTINATION');
      assert.equal(rows[0][7], templateId);
      assert.equal(rows[0][8], customerId);
      assert.deepEqual(JSON.parse(rows[0][9]), {rows: candidates});
      assert.deepEqual(JSON.parse(rows[0][10]), {g: ''});
      assert.equal(gas.call('verifyChain', ['RECENT']).ok, true);
      assert.deepEqual(call().candidates, []);
      assert.deepEqual(call(true).cleared, []);
      assert.equal(audit.getLastRow(), auditBefore + 1);
      assert.equal(writes.length, 1);
    } finally {
      gas.stubs.onValuesBatchUpdate(null);
    }
  });

  test('tl 3: rechecks candidates under lock and skips rows changed after the first read', () => {
    for (const key of ['B', 'F', 'I', 'K', 'M', 'txId', 'G']) {
      const {sheet, audit} = world();
      assert.deepEqual(call().candidates, candidates);
      const lock = gas.stubs.getScriptLock();
      const tryLock = lock.tryLock;
      const read = gas.context.destinationRangeValues_;
      const reads = [];
      let changed = false;
      lock.tryLock = function(...args) {
        if (!changed) {
          changed = true;
          sheet.getRange(3, mapping[key]).setValue(key === 'G' ? '架空変更税区分' : '架空後続書込');
        }
        return tryLock.apply(this, args);
      };
      try {
        const result = withMocks({destinationRangeValues_: (...args) => {
          reads.push({range: args[1], locked: lock.locked});
          return read(...args);
        }}, () => call(true));
        assert.equal(changed, true);
        assert.deepEqual(reads, [{range: "'雛形''架空'!A3:P", locked: false},
          {range: "'雛形''架空'!A3:P6", locked: true}]);
        assert.deepEqual(result.cleared, [6]);
        assert.deepEqual(result.skippedRows, [3]);
        assert.equal(sheet.getRange(3, 7).getValue(), key === 'G' ? '架空変更税区分' : '対象外');
        assert.equal(sheet.getRange(6, 7).getValue(), '');
        assert.deepEqual(JSON.parse(auditRows(audit)[0][9]), {rows: [candidates[1]]});
      } finally {
        lock.tryLock = tryLock;
      }
    }
    const {sheet, audit} = world();
    const lock = gas.stubs.getScriptLock();
    const tryLock = lock.tryLock;
    lock.tryLock = function(...args) {
      candidates.forEach(({row}) => sheet.getRange(row, mapping.B).setValue('架空後続書込'));
      return tryLock.apply(this, args);
    };
    try {
      const result = call(true);
      assert.deepEqual(result.cleared, []);
      assert.deepEqual(result.skippedRows, [3, 6]);
      assert.equal(gas.stubs.getApiCallCounts().batchUpdate, 0);
      assert.equal(auditRows(audit).length, 0);
    } finally {
      lock.tryLock = tryLock;
    }
  });

  test('tl 4: missing tax mapping returns NO_TAX_COLUMN without reading the template', () => {
    const columns = {...mapping};
    delete columns.G;
    const {spreadsheet, audit} = world(columns);
    const before = snapshot(spreadsheet);
    const auditBefore = audit.getDataRange().getValues();
    const open = gas.context.SpreadsheetApp.openById;
    gas.context.SpreadsheetApp.openById = (id) => {
      assert.notEqual(id, templateId);
      return open(id);
    };
    try {
      withMocks({destinationRangeValues_: () => assert.fail('no template read')}, () => {
        [undefined, true].forEach((apply) => {
          assert.deepEqual(call(apply), {customerId, spreadsheetId: null,
            candidates: [], others: [], cleared: [], skipped: 'NO_TAX_COLUMN'});
        });
      });
      assert.equal(gas.stubs.getApiCallCounts().batchUpdate, 0);
      assert.deepEqual(snapshot(spreadsheet), before);
      assert.deepEqual(audit.getDataRange().getValues(), auditBefore);
    } finally {
      gas.context.SpreadsheetApp.openById = open;
    }
  });

  test('tl 5: touches only the master template and respects mapped tax columns', () => {
    const {sheet} = world();
    const clone = gas.stubs.createSpreadsheet('tl-clone-fake', {sheets: [
      {name: sheetName, values: sheet.getDataRange().getValues(), maxRows: 30, maxColumns: 16}
    ]});
    const before = snapshot(clone);
    const read = gas.context.destinationRangeValues_;
    withMocks({destinationRangeValues_: (id, ...args) => {
      assert.equal(id, templateId);
      return read(id, ...args);
    }}, () => {
      assert.deepEqual(call(true).cleared, [3, 6]);
    });
    assert.deepEqual(snapshot(clone), before);
    const moved = world({...mapping, G: 8});
    moved.sheet.getRange(3, 7).setValue('架空保持税区分');
    const movedBefore = snapshot(moved.spreadsheet);
    assert.deepEqual(call(true).cleared, [3, 6]);
    movedBefore[0].values[2][7] = '';
    movedBefore[0].values[5][7] = '';
    assert.deepEqual(snapshot(moved.spreadsheet), movedBefore);
    for (const key of ['B', 'F', 'I', 'K', 'M', 'txId', 'G']) {
      world();
      const customer = plain(gas.call('getCustomerById', [customerId]));
      customer.columnMapping[key] = 17;
      withMocks({getCustomerById: () => customer,
        destinationRangeValues_: () => assert.fail('invalid mapping must fail before reading')}, () => {
        assert.throws(() => call(true), /exceeds rowScanLastColumn/);
      });
      assert.equal(gas.stubs.getApiCallCounts().batchUpdate, 0);
    }
  });

  test('tl 6: measures Sheets read and write counts for dry run and apply', () => {
    const counts = {};
    for (const [mode, apply] of [['dry', undefined], ['apply', true]]) {
      world();
      const batchGet = gas.context.Sheets.Spreadsheets.Values.batchGet;
      let templateReads = 0;
      gas.context.Sheets.Spreadsheets.Values.batchGet = (id, request) => {
        if (id === templateId) templateReads++;
        return batchGet.call(gas.context.Sheets.Spreadsheets.Values, id, request);
      };
      let result;
      try {
        result = call(apply);
      } finally {
        gas.context.Sheets.Spreadsheets.Values.batchGet = batchGet;
      }
      const actual = gas.stubs.getApiCallCounts();
      counts[mode] = {batchGet: actual.batchGet, batchUpdate: actual.batchUpdate,
        rangesWritten: actual.rangesWritten, cellsWritten: actual.cellsWritten};
      console.log('TL_TEMPLATE_READS ' + mode + ' ' + templateReads);
      assert.equal(templateReads, mode === 'dry' ? 1 : 2);
      assert.equal(result.applied, apply === true);
      assert.ok(actual.batchGet > 0);
    }
    console.log('TL_COUNTS ' + JSON.stringify(counts));
    // 初回の実測値をそのまま固定する。マスターと監査の読取も含めた上限である。
    assert.deepEqual(counts, {
      dry: {batchGet: 3, batchUpdate: 0, rangesWritten: 0, cellsWritten: 0},
      apply: {batchGet: 5, batchUpdate: 1, rangesWritten: 2, cellsWritten: 2}
    });
  });

  test('tl 7: return values and logs contain no transaction values from other columns', () => {
    world();
    const secrets = ['架空保持値A', '架空保持値P', 'TL_TX_FAKE', '架空取引値_B',
      '架空取引値_F', '架空取引値_I', '架空取引値_K'];
    for (const apply of [undefined, true]) {
      gas.stubs.clearLogs();
      const result = call(apply);
      const logs = gas.stubs.getLogs();
      assert.equal(logs.at(-1), JSON.stringify(result));
      const output = JSON.stringify({result, logs});
      secrets.forEach((value) => assert.equal(output.includes(value), false, value));
      assert.ok(output.includes('対象外'));
      assert.ok(output.includes('架空税区分'));
    }
  });
};

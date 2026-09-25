'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');

module.exports = ({test, assert, gas}) => {
  function browserAsyncTest(name, fn) {
    if (process.argv[2] === '--browser-case') {
      if (process.argv[3] === name) test(name, fn);
    } else {
      test(name, () => {
        const output = execFileSync(process.execPath,
          [__filename, '--browser-case', name], {encoding: 'utf8', timeout: 30000});
        assert.match(output, /^CASE_DONE$/m);
      });
    }
  }
  const fixtureRoot = path.join(__dirname, 'fixtures');
  const revive = (value) => value && typeof value === 'object' && value.__date__
    ? new Date(value.__date__) : value;
  function fixture(group, slug) {
    const raw = JSON.parse(fs.readFileSync(path.join(fixtureRoot, group, slug + '.json'), 'utf8'));
    raw.sheets = raw.sheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows.map((row) => row.map(revive))
    }));
    return raw;
  }
  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets');
    gas.call('installSmbcCsvFormat');
    gas.call('installSmbcXlsxFormat');
    gas.call('installAnnotatedFormatsBatch1');
  }
  function defs() {
    return gas.call('loadFormatDefinitions', [{status: 'active', enabled: true}]);
  }
  function detect(item) {
    const detections = item.sheets.map((sheet) => ({
      sheetName: sheet.name,
      candidates: gas.call('detectFormatWith', [defs(), sheet, item.fileType, item.fileName])
    }));
    return gas.call('aggregateSheetDetections', [detections,
      {origin: 'DISCOVERY', fileName: item.fileName, fileType: item.fileType,
        targetSheetName: null, sourceId: 'f1'}]);
  }
  function unknown(slug) { return fixture('unknown-formats', slug); }
  function clientEval(expression) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', '81_WebAppUi.html'), 'utf8');
    const match = /<script>([\s\S]*?)<\/script>/.exec(source);
    assert.ok(match);
    const needle = "    el['customer-search'].addEventListener";
    const probe = `    globalThis.__probe = (${expression});\n    return;\n`;
    const sandbox = {document: {getElementById() { return {}; }}};
    vm.runInNewContext(match[1].replace(needle, probe + needle), sandbox);
    return JSON.parse(JSON.stringify(sandbox.__probe));
  }
  function browserWorld(responses = {}) {
    class Node {
      constructor(tag = 'div') {
        this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
        this.listeners = {}; this._text = ''; this.value = ''; this.checked = false;
        this.disabled = false; this.hidden = false; this.className = '';
        this.dataset = {}; this.attributes = {};
      }
      set textContent(value) {
        this.children.forEach((child) => { child.parentNode = null; });
        this.children = []; this._text = '';
        if (this.tagName === '#TEXT') this._text = String(value);
        else if (String(value)) {
          const child = new Node('#text'); child._text = String(value);
          child.parentNode = this; this.children.push(child);
        }
      }
      get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) { this.children.splice(index, 1); child.parentNode = null; }
        return child;
      }
      get firstChild() { return this.children[0] || null; }
      addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
      fire(name) {
        if (this.disabled) return [];
        return (this.listeners[name] || []).map((listener) => listener({target: this, preventDefault() {}}));
      }
      focus() {
        if (this.disabled || document.activeElement === this) return;
        if (document.activeElement) document.activeElement.blur();
        document.activeElement = this;
        this._focusedValue = this.value;
        this._focusedChecked = this.checked;
      }
      blur() {
        if (document.activeElement !== this) return;
        document.activeElement = null;
        if (this.value !== this._focusedValue || this.checked !== this._focusedChecked)
          this.fire('change');
      }
      setAttribute(name, value) { this.attributes[name] = String(value); }
      getAttribute(name) { return this.attributes[name] || null; }
      scrollIntoView() { this.scrolled = true; }
      showModal() { this.open = true; }
      close() { this.open = false; }
      querySelector(selector) { return find(this, selector)[0] || null; }
      querySelectorAll(selector) { return find(this, selector); }
      closest(tag) {
        let node = this;
        while (node && node.tagName.toLowerCase() !== tag.toLowerCase()) node = node.parentNode;
        return node;
      }
    }
    function find(root, selector) {
      const parts = selector.split(',').map((part) => part.trim());
      const matches = (node, part) => {
        if (part[0] === '.') {
          const [name, pseudo] = part.slice(1).split(':');
          return node.className.split(/\s+/).includes(name) && (!pseudo || pseudo !== 'checked' || node.checked);
        }
        if (part[0] === '#') return node.id === part.slice(1);
        if (part[0] === '[') return Object.hasOwn(node.attributes, part.slice(1, -1));
        return node.tagName.toLowerCase() === part.toLowerCase();
      };
      const result = [];
      function visit(node) {
        node.children.forEach((child) => {
          if (parts.some((part) => matches(child, part))) result.push(child);
          visit(child);
        });
      }
      visit(root); return result;
    }
    const root = new Node('body');
    const ids = {};
    const document = {
      activeElement: null,
      createElement(tag) { return new Node(tag); },
      getElementById(id) {
        if (!ids[id]) { ids[id] = new Node(); ids[id].id = id; root.appendChild(ids[id]); }
        return ids[id];
      },
      querySelector(selector) { return root.querySelector(selector); },
      querySelectorAll(selector) { return root.querySelectorAll(selector); }
    };
    const calls = [];
    const pending = [];
    const runner = {
      withSuccessHandler(success) { this.success = success; return this; },
      withFailureHandler(failure) { this.failure = failure; return this; }
    };
    for (const name of ['webAppBootstrap', 'webAppListFolder', 'webAppListReviews',
      'webAppFinalReview', 'webAppExplainUnknownFile', 'webAppPreviewFormat',
      'webAppSaveFormat', 'webAppRequeueFormatFiles', 'webAppReturnFileToCustomer',
      'webAppWithdrawFormat', 'webAppRunImport', 'webAppResolveReviews']) {
      runner[name] = (...args) => {
        calls.push({name, args});
        const success = runner.success, failure = runner.failure;
        try {
          const reply = typeof responses[name] === 'function' ? responses[name](...args) : responses[name];
          if (reply && reply.defer === true) {
            pending.push({name, args, reply(value) { success(value); },
              reject(error) { failure(error); }});
          } else if (reply instanceof Error) failure(reply);
          else success(reply);
        } catch (error) { failure(error); }
      };
    }
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', '81_WebAppUi.html'), 'utf8');
    const script = /<script>([\s\S]*?)<\/script>/.exec(source)[1].replace(
      '    bootstrap();',
      '    globalThis.__ui = {state, el, renderSelection, renderFormatPanel, previewFormat, saveFormat, returnFormatToCustomer, openFormat, chooseFolder, chooseCustomer, loadFinalReview, formatSetBusy};');
    const sandbox = {document, google: {script: {run: runner}}, window: {open() { return {}; }},
      setTimeout, clearTimeout, console};
    vm.runInNewContext(script, sandbox);
    return {ui: sandbox.__ui, document, calls, pending, ids, root, Node};
  }
  function formatBrowserDiagnosis() {
    const columns = Object.fromEntries(['date', 'merchant', 'amount', 'purpose', 'amountFallback']
      .map((role, index) => [role, {column: ['A', 'B', 'C', 'D', null][index], source: 'HEADER'}]));
    return {ok: true, verdict: 'NEW', fileId: 'target', fileName: 'PAYPAY detail202502',
      sheetName: '明細', width: 5, warnings: [], customerSide: false,
      grid: {columnLetters: ['A', 'B', 'C', 'D', 'E'], rowNumbers: [1, 2, 3],
        cells: [['日付', '店名', '金額', '使用用途', '予備'],
          ['2025/2/1', '店A', '100', '食費', '200'], ['2025/2/2', '店B', '300', '雑費', '400']]},
      proposal: {baseFormatId: null, formatId: 'paypay_new', formatName: 'PayPay 新',
        sheetName: '明細', headerRow: 1, dataStartRow: 2, columns,
        amountCandidates: [{column: 'C', header: '金額'}, {column: 'E', header: '予備'}]}};
  }
  function mountedFormatWorld(responses = {}) {
    const world = browserWorld(responses);
    const {state, renderFormatPanel} = world.ui;
    state.selectedCustomerId = 'C001'; state.selectedFolderId = 'card';
    state.formatFileId = 'target'; state.formatDiagnosis = formatBrowserDiagnosis();
    const p = state.formatDiagnosis.proposal;
    state.formatAnswers = {baseFormatId: p.baseFormatId, formatId: p.formatId,
      formatName: p.formatName, sheetName: p.sheetName, headerRow: p.headerRow,
      dataStartRow: p.dataStartRow,
      columns: Object.fromEntries(Object.entries(p.columns).map(([k, v]) => [k, v.column])),
      acknowledgements: {customerSide: true, amountChoice: true}};
    state.formatPreview = {previewHash: 'hash', blocking: [],
      extraction: {count: 2, total: 400, category: {category: 2}, rows: [], excluded: [],
        billing: {}, year: {yearless: 0, inferred: 0, reviewRows: 0}}, amountComparison: []};
    state.formatHash = 'hash';
    renderFormatPanel();
    return world;
  }
  function control(world, tag, label) {
    return world.ids['format-body'].querySelectorAll(tag).find((node) =>
      node.textContent.includes(label));
  }
  function change(world, label, tag, value) {
    const field = control(world, 'label', label).querySelector(tag);
    assert.ok(field, label);
    if (tag === 'input' && field.type === 'checkbox') field.checked = value;
    else field.value = value;
    field.fire('change');
    return field;
  }
  function webWorld() {
    setup();
    gas.stubs.setSpreadsheetOwner('master', 'owner@example.com');
    gas.stubs.setActiveUser('owner@example.com');
    gas.stubs.createSpreadsheet('dest', {sheets: [{name: '入力用シート',
      values: [['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID',
        '税区分', '勘定科目', '消費税']],
      maxRows: 30, maxColumns: 10}]});
    const card = gas.stubs.createFolder('card', {name: 'カード', fileIds: [], subFolderIds: []});
    gas.stubs.createFolder('root', {name: '顧客ルート', fileIds: [], subFolderIds: ['card']});
    gas.call('registerTestCustomer', [{customerId: 'C001', customerName: '顧客一',
      sourceFolderId: 'root', destinationSpreadsheetId: 'dest',
      destinationSheetName: '入力用シート',
      columns: {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7},
      rowScanLastColumn: 10, rowScanExcludedColumns: [8, 9, 10],
      reviewers: 'owner@example.com', admins: 'owner@example.com'}]);
    return {card};
  }
  function putUnknown(card, slug, fileId, review = true) {
    const item = unknown(slug);
    gas.stubs.createFile(fileId, {name: item.fileName, bytes: Buffer.from('fixture-' + fileId),
      xlsxSheets: item.sheets.map((sheet) => ({name: sheet.name, values: sheet.rows})),
      lastUpdated: new Date(Date.now() - 3600000)});
    card.fileIds.push(fileId);
    if (review) gas.call('registerReview', [{reviewType: 'FORMAT_UNKNOWN', customerId: 'C001',
      customerName: '顧客一', fileId, fileNameOriginal: item.fileName}]);
    return item;
  }
  function replaceFixtureFile(slug, fileId, change) {
    const item = unknown(slug);
    change(item.sheets[0].rows);
    gas.stubs.createFile(fileId, {name: item.fileName, bytes: Buffer.from('modified-' + fileId),
      xlsxSheets: item.sheets.map((sheet) => ({name: sheet.name, values: sheet.rows})),
      lastUpdated: new Date(Date.now() - 3600000)});
  }
  function seedWaiting(fileId, fileName) {
    const customer = gas.call('getCustomerById', ['C001']);
    gas.call('createOrUpdateProcessLog', ['R1', customer,
      {fileId, name: fileName, state: 'REVIEW_WAIT', contentHash: 'submitted-old'}]);
  }
  function prepareImportRuntime() {
    const values = Array.from({length: 8}, () => Array(10).fill(''));
    const formulas = Array.from({length: 8}, () => Array(10).fill(''));
    values[0] = ['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ',
      '内部ID', '税区分', '勘定科目', '消費税'];
    for (let row = 2; row <= 8; row += 1) {
      values[row - 1][7] = '課税10%'; values[row - 1][8] = '会議費';
      formulas[row - 1][9] = `=IF(E${row}="","",ROUND(E${row}/11,0))`;
    }
    gas.stubs.createSpreadsheet('dest', {name: '顧客一_雛形', sheets: [
      {name: '入力用シート', values, formulas, maxRows: 50, maxColumns: 10},
      {name: '取込用', values: [['出力']], formulas: [[''], ['=入力用シート!B1']],
        maxRows: 20, maxColumns: 10},
      {name: '取引先一覧', values: [['元店名', '取引先名']]}
    ]});
    gas.stubs.createFolder('destParent', {fileIds: ['dest'], subFolderIds: []});
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createSpreadsheet('snap', {sheets: []});
    gas.stubs.createFolder('corpus', {fileIds: []});
    gas.evaluate("SETTINGS.EXECUTION_TIMEOUT_SECONDS=300;" +
      "SETTINGS.SAFETY_MARGIN_SECONDS=60;" +
      "SETTINGS.TX_INDEX_SPREADSHEET_ID='txidx';" +
      "SETTINGS.SNAPSHOT_SPREADSHEET_ID='snap';" +
      "SETTINGS.SAMPLE_CORPUS_FOLDER_ID='corpus';" +
      "SETTINGS.PARALLEL_WORK_FOLDER_ID='';" +
      'SETTINGS.FAULT_INJECTION=null;');
  }

  test('fmt 1: Aeon short transactions stop before the installment section', () => {
    setup();
    gas.call('opsDisableAeonX8');
    for (const slug of ['イオンゴールドカード__meisai202508', 'イオンカード__meisai202503']) {
      const result = detect(unknown(slug));
      assert.equal(result.status, 'RESOLVED', slug);
      assert.equal(result.formatId, 'aeon_x9', slug);
    }
  });

  test('fmt 2: stopping aeon_x8 changes only its one legacy sample', () => {
    setup();
    const slugs = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'samples', 'index.json'), 'utf8'));
    const before = Object.fromEntries(slugs.map((slug) => [slug, detect(fixture('samples', slug)).formatId]));
    gas.call('opsDisableAeonX8');
    for (const slug of slugs) {
      const result = detect(fixture('samples', slug));
      if (slug === 'イオンカード__202512') assert.equal(result.status, 'UNKNOWN_CARD_FORMAT');
      else assert.equal(result.formatId, before[slug], slug);
    }
  });

  test('fmt 3: disabling aeon_x8 prevents the issuer note from becoming purpose', () => {
    setup();
    const item = unknown('イオンカード__meisai202504');
    assert.equal(detect(item).formatId, 'aeon_x8');
    const def = gas.call('pinFormatVersion', ['aeon_x8', 1]);
    const parsed = gas.call('parseFile', [item.sheets[0], def,
      {customerId: 'C001', fileId: 'f1', fileNameOriginal: item.fileName}]);
    assert.ok(parsed.txs.some((tx) => String(tx.purpose).includes('ポイント２倍対象')));
    gas.call('opsDisableAeonX8');
    assert.equal(detect(item).status, 'UNKNOWN_CARD_FORMAT');
  });

  test('fmt 4: explanation measures the same samples as the detector', () => {
    setup();
    const item = unknown('イオンカード__meisai202504');
    const def = gas.call('pinFormatVersion', ['aeon_x9', 1]);
    assert.equal(gas.call('explainFormatVerdict_', [def, item.sheets[0], item.fileType]),
      '× 列の条件に合わない。**列数が 8（この形式は 9〜9）**');
  });

  test('fmt 5: disabling a format is idempotent and records its reason', () => {
    setup();
    const first = gas.call('opsDisableAeonX8');
    assert.deepEqual(JSON.parse(JSON.stringify(first.disabledVersions)), [1]);
    const rows = gas.call('loadFormatDefinitions', [{formatId: 'aeon_x8'}]);
    assert.equal(rows[0].enabled, false);
    const master = gas.stubs.getSpreadsheet('master');
    const sheet = master.getSheetByName('カード形式マスター');
    const row = sheet.getDataRange().getValues()[rows[0]._rowNumber - 1];
    assert.equal(row[3], false);
    assert.equal(row[23], 'PURPOSE_READ_FROM_ISSUER_COLUMN');
    assert.ok(row[22]);
    assert.ok(row[33]);
    const audit = master.getSheetByName('監査ログ');
    const before = audit.getLastRow();
    const originalGetRange = sheet.getRange.bind(sheet);
    let writes = 0;
    sheet.getRange = (...args) => {
      const range = originalGetRange(...args);
      const originalSetValue = range.setValue.bind(range);
      range.setValue = (value) => { writes += 1; return originalSetValue(value); };
      return range;
    };
    try {
      assert.deepEqual(JSON.parse(JSON.stringify(gas.call('opsDisableAeonX8').disabledVersions)), []);
    } finally { sheet.getRange = originalGetRange; }
    assert.equal(writes, 0, 'a disabled format must not be written again');
    assert.equal(audit.getLastRow(), before);
  });

  test('fmt 6: gap wording stays stable', () => {
    setup();
    const def = gas.call('pinFormatVersion', ['aupay_family', 1]);
    const item = unknown('auカード__au202509');
    assert.equal(gas.call('explainFormatVerdict_', [def, item.sheets[0], item.fileType]),
      '× 列の条件に合わない。**列数が 6（この形式は 7〜7）**');
  });

  test('fmt 12: reference headers map PayPay amount and purpose across widths', () => {
    setup();
    const target = unknown('ペイペイカード__PAYPAY_detail202502(0000)');
    const reference = unknown('ペイペイカード__detail202503(0000)');
    const base = gas.call('pinFormatVersion', ['paypay_family', 1]);
    const proposal = gas.call('formatProposal_', [target.sheets[0], 'xlsx', 'ペイペイカード',
      base, reference.sheets[0], defs()]);
    assert.equal(proposal.columns.amount.column, 'E');
    assert.equal(proposal.columns.amount.source, 'REFERENCE');
    assert.equal(proposal.columns.purpose.column, 'L');
    assert.equal(proposal.columns.purpose.source, 'REFERENCE');
    assert.deepEqual(JSON.parse(JSON.stringify(proposal.amountCandidates.map((v) => v.column))),
      ['E', 'G', 'H', 'I']);
  });

  test('fmt 13: multiple PayPay amount candidates have no default without reference', () => {
    setup();
    const target = unknown('ペイペイカード__PAYPAY_detail202502(0000)');
    const base = gas.call('pinFormatVersion', ['paypay_family', 1]);
    const proposal = gas.call('formatProposal_', [target.sheets[0], 'xlsx', 'ペイペイカード',
      base, null, defs()]);
    assert.equal(proposal.columns.amount.column, null);
    assert.ok(proposal.amountCandidates.length >= 2);
  });

  test('fmt 14: blank Aplus proposal recognizes numeric compact dates', () => {
    setup();
    const target = unknown('アプラスカード__aplus_meisai_0000_202503');
    const proposal = gas.call('formatProposal_', [target.sheets[0], 'xlsx', 'アプラスカード',
      null, null, defs()]);
    assert.equal(proposal.headerRow, 1);
    assert.equal(proposal.dataStartRow, 2);
    assert.equal(proposal.columns.date.column, 'B');
    assert.equal(proposal.columns.merchant.column, 'C');
    assert.equal(proposal.columns.amount.column, null);
    assert.deepEqual(JSON.parse(JSON.stringify(proposal.amountCandidates.map((v) => v.column))),
      ['D', 'H']);
    assert.equal(proposal.columns.purpose.column, 'J');
  });

  test('fmt 14b: header roles require a majority of matching sample types', () => {
    setup();
    const sheet = {name: '明細', rows: [
      ['利用日', '利用先', '利用金額', '使用用途', '補助'],
      [12345, 777, 100, '用途', new Date('2025-03-01T00:00:00Z')],
      [12346, 778, 200, '用途', new Date('2025-03-02T00:00:00Z')],
      [12347, 779, 300, '用途', new Date('2025-03-03T00:00:00Z')]
    ]};
    const proposal = gas.call('formatProposal_', [sheet, 'xlsx', 'カード', null, null, defs()]);
    assert.equal(proposal.columns.date.column, null);
    assert.equal(proposal.columns.merchant.column, null);
    assert.equal(proposal.columns.amount.column, 'C');
  });

  test('fmt 14c: Aplus diagnosis stays blank with all production formats', () => {
    const {card} = webWorld();
    putUnknown(card, 'アプラスカード__aplus_meisai_0000_202503', 'target');
    const d = gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']);
    assert.equal(d.verdict, 'BLANK');
    assert.deepEqual(JSON.parse(JSON.stringify(d.nearest)), []);
    const base = gas.call('pinFormatVersion', ['aupay_family', 1]);
    const oneWord = Object.assign({}, base, {keywordRule: {
      allOf: [{maxRow: 1, keywords: ['利用日', '利用金額'], minMatch: 2}]}});
    const near = gas.call('formatNearest_', [[oneWord], {
      name: '明細', rows: [['利用日', '金額以外'], ['2025/09/01', 100]]
    }, 'xlsx', {}]);
    assert.equal(near.length, 0, '1 語だけ一致した形式は候補にしない');
  });

  test('fmt 14d: tied header candidates select the lower real header', () => {
    setup();
    const rows = Array.from({length: 9}, () => []);
    rows[0] = ['ご利用カード', 'カード番号'];
    rows[4] = ['金融機関', '支店'];
    rows[7] = ['利用日', '利用先', '利用金額', '使用用途'];
    rows[8] = ['2025/09/01', '店名', 100, '用途'];
    assert.equal(gas.call('formatProposalHeaderRow_', [{name: '明細', rows}, null]), 8);
  });

  test('fmt 14e: unreadable reference leaves diagnosis available with warning', () => {
    const {card} = webWorld();
    putUnknown(card, 'auカード__au202509', 'target');
    putUnknown(card, 'auカード__au202508', 'reference', false);
    const process = gas.stubs.getSpreadsheet('master').getSheetByName(
      gas.evaluate('CONFIG.SHEET_NAMES.PROCESS_LOG'));
    const row = Array(40).fill(''); row[1] = '2026-09-01'; row[7] = 'reference';
    row[14] = 'aupay_family'; process.appendRow(row);
    const original = gas.context.readFile;
    gas.context.readFile = function(id, ...rest) {
      if (id === 'reference') throw new Error('unreadable');
      return original(id, ...rest);
    };
    try {
      const d = gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']);
      assert.equal(d.verdict, 'NEAR');
      assert.equal(d.nearest[0].reference, null);
      assert.ok(d.warnings.some((w) => w.code === 'REFERENCE_UNREADABLE'));
      const p = d.proposal;
      const answers = {baseFormatId: p.baseFormatId, formatId: p.formatId,
        formatName: p.formatName, sheetName: p.sheetName, headerRow: p.headerRow,
        dataStartRow: p.dataStartRow,
        columns: {date: 'C', merchant: 'D', amount: 'E', purpose: 'F',
          amountFallback: null},
        acknowledgements: {customerSide: true, amountChoice: true}};
      const preview = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
      assert.ok(preview.warnings.some((w) => w.code === 'REFERENCE_UNREADABLE'));
    } finally { gas.context.readFile = original; }
  });

  test('fmt 10: diagnosis ranks au history and identifies the missing purpose column', () => {
    const {card} = webWorld();
    putUnknown(card, 'auカード__au202509', 'target');
    putUnknown(card, 'auカード__au202508', 'reference', false);
    const process = gas.stubs.getSpreadsheet('master').getSheetByName(
      gas.evaluate('CONFIG.SHEET_NAMES.PROCESS_LOG'));
    const row = Array(40).fill(''); row[1] = '2026-09-01'; row[7] = 'reference';
    row[14] = 'aupay_family'; process.appendRow(row);
    const result = gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']);
    assert.equal(result.verdict, 'NEAR');
    assert.equal(result.nearest[0].formatId, 'aupay_family');
    assert.ok(result.nearest[0].folderCount >= 1);
    assert.equal(result.purposeGap.kind, 'PURPOSE_COLUMN_ABSENT');
    assert.equal(result.customerSide, true);
    assert.equal(result.proposal.columns.date.column, 'C');
    assert.equal(result.proposal.columns.merchant.column, 'D');
    assert.equal(result.proposal.columns.amount.column, 'E');
    assert.equal(result.proposal.columns.purpose.column, null);
  });

  test('fmt 10b: target process-log format is excluded from reference history', () => {
    const {card} = webWorld();
    putUnknown(card, 'auカード__au202509', 'target');
    putUnknown(card, 'auカード__au202508', 'reference', false);
    const process = gas.stubs.getSpreadsheet('master').getSheetByName(
      gas.evaluate('CONFIG.SHEET_NAMES.PROCESS_LOG'));
    for (const [id, date] of [['reference', '2026-09-01'], ['target', '2026-09-02']]) {
      const row = Array(40).fill(''); row[1] = date; row[7] = id;
      row[14] = 'aupay_family'; process.appendRow(row);
    }
    const d = gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']);
    assert.equal(d.nearest[0].reference.fileId, 'reference');
    assert.equal(d.nearest[0].folderCount, 1);
    const targetReview = gas.call('openReviews', [{fileId: 'target'}])[0];
    gas.call('updateReviewStatus', [targetReview.reviewId, 'RESOLVED', {}]);
    const history = gas.call('formatFolderHistory_',
      [gas.context.DriveApp.getFolderById('card'), 'target', 'C001']);
    assert.equal(history.aupay_family.count, 1,
      '対象を要確認の除外とは独立に履歴から外す');
  });

  test('fmt 10c: unresolved unknown siblings are excluded from reference history', () => {
    const {card} = webWorld();
    putUnknown(card, 'auカード__au202509', 'target');
    putUnknown(card, 'auカード__au202508', 'reference');
    const process = gas.stubs.getSpreadsheet('master').getSheetByName(
      gas.evaluate('CONFIG.SHEET_NAMES.PROCESS_LOG'));
    const row = Array(40).fill(''); row[1] = '2026-09-01'; row[7] = 'reference';
    row[14] = 'aupay_family'; process.appendRow(row);
    const d = gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']);
    assert.equal(d.nearest[0].folderCount, 0);
    assert.equal(d.nearest[0].reference, null);
  });

  test('fmt 11: diagnosis recognizes a purpose value in the Rakuten header', () => {
    const {card} = webWorld();
    putUnknown(card, '楽天カード__enavi202509(0000)', 'target');
    const result = gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']);
    assert.equal(result.verdict, 'NEAR');
    assert.equal(result.nearest[0].formatId, 'rakuten_x11');
    assert.deepEqual(JSON.parse(JSON.stringify(result.purposeGap)),
      {kind: 'PURPOSE_HEADER_VALUE', column: 'K', headerText: 'ツール代'});
  });

  test('fmt 13b: folder history outranks keyword ties for PayPay', () => {
    const {card} = webWorld();
    putUnknown(card, 'ペイペイカード__PAYPAY_detail202502(0000)', 'target');
    putUnknown(card, '楽天カード__enavi202508(0000)', 'reference', false);
    const process = gas.stubs.getSpreadsheet('master').getSheetByName(
      gas.evaluate('CONFIG.SHEET_NAMES.PROCESS_LOG'));
    const row = Array(40).fill(''); row[1] = '2026-09-01'; row[7] = 'reference';
    row[14] = 'rakuten_x11'; process.appendRow(row);
    const result = gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']);
    assert.equal(result.nearest[0].formatId, 'rakuten_x11');
  });

  test('fmt 16: unknown review is returned as a value', () => {
    const {card} = webWorld();
    putUnknown(card, 'アプラスカード__aplus_meisai_0000_202503', 'target', false);
    const result = gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']);
    assert.deepEqual(JSON.parse(JSON.stringify(result)),
      {ok: false, code: 'NOT_FORMAT_UNKNOWN'});
  });

  test('fmt 15: a formerly unknown Aeon file now matches an active format', () => {
    const {card} = webWorld();
    putUnknown(card, 'イオンゴールドカード__meisai202508', 'target');
    const result = gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']);
    assert.equal(result.verdict, 'MATCHES_ACTIVE');
    assert.equal(result.matched.formatId, 'aeon_x9');
  });

  test('fmt 16b: folder, file, and role are checked at the Web app boundary', () => {
    const {card} = webWorld();
    putUnknown(card, 'アプラスカード__aplus_meisai_0000_202503', 'target');
    const other = gas.stubs.createFolder('other',
      {name: '別カード', fileIds: [], subFolderIds: []});
    function errorFor(args) {
      try { gas.call('webAppExplainUnknownFile', args); }
      catch (error) { return error; }
      assert.fail('expected AuthorizationError');
    }
    assert.equal(errorFor(['C001', other.id, 'target']).name, 'AuthorizationError');
    assert.equal(errorFor(['C001', 'card', 'absent']).name, 'AuthorizationError');
    gas.stubs.setActiveUser('reviewer@example.com');
    assert.equal(errorFor(['C001', 'card', 'target']).name, 'AuthorizationError');
  });

  test('fmt 16c: preview rejects a supplied base outside the nearest candidates', () => {
    const {answers} = answersFor('アプラスカード__aplus_meisai_0000_202503');
    answers.baseFormatId = 'saison_x8';
    answers.columns.amount = 'D';
    const result = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.ok(result.blocking.some((item) => item.code === 'DEFINITION_INVALID'));
  });

  test('fmt 16d: a returned NOT_FORMAT_UNKNOWN is shown without a client exception', () => {
    const view = clientEval('formatPreviewView({ok: false, code: "NOT_FORMAT_UNKNOWN"}, null)');
    assert.equal(view.preview, null);
    assert.equal(view.hash, null);
    assert.match(view.notice, /形式不明の要確認がありません/);
  });

  test('fmt 17: diagnosis leaves all master rows and converted files unchanged', () => {
    const {card} = webWorld();
    putUnknown(card, 'アプラスカード__aplus_meisai_0000_202503', 'target');
    const master = gas.stubs.getSpreadsheet('master');
    const names = [gas.evaluate('CONFIG.SHEET_NAMES.CARD_FORMAT_MASTER'),
      gas.evaluate('CONFIG.SHEET_NAMES.REVIEW'),
      gas.evaluate('CONFIG.SHEET_NAMES.PROCESS_LOG'),
      gas.evaluate('CONFIG.SHEET_NAMES.PERMANENT_FILE_INDEX')];
    const before = names.map((name) => JSON.stringify(master.getSheetByName(name).getDataRange().getValues()));
    const ids = gas.stubs.getSpreadsheetIds().slice().sort();
    gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']);
    assert.deepEqual(names.map((name) => JSON.stringify(master.getSheetByName(name).getDataRange().getValues())), before);
    assert.deepEqual(gas.stubs.getSpreadsheetIds().slice().sort(), ids);
  });

  function answersFor(slug, overrides = {}) {
    const {card} = webWorld();
    putUnknown(card, slug, 'target');
    const diagnosis = gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']);
    const p = diagnosis.proposal;
    const answers = {
      baseFormatId: p.baseFormatId, formatId: p.formatId, formatName: p.formatName,
      sheetName: p.sheetName, headerRow: p.headerRow, dataStartRow: p.dataStartRow,
      columns: {date: p.columns.date.column, merchant: p.columns.merchant.column,
        amount: p.columns.amount.column, purpose: p.columns.purpose.column,
        amountFallback: p.columns.amountFallback.column},
      acknowledgements: {customerSide: false, amountChoice: true}
    };
    Object.assign(answers, overrides);
    return {answers, diagnosis, card};
  }

  test('fmt 20: PayPay preview reads 24 transactions from the selected amount column', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    const result = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.deepEqual(JSON.parse(JSON.stringify(result.blocking)), []);
    assert.equal(result.extraction.count, 24);
    assert.ok(result.extraction.total > 0);
    assert.equal(result.extraction.purposeEmptyCount, 0);
    if (result.extraction.billing.status === 'RESOLVED')
      assert.match(result.extraction.billing.yearMonth, /^\d{4}-\d{2}$/);
    assert.ok(result.previewHash);
  });

  test('fmt 20b: resolved billing month is returned as a year-month string', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    const original = gas.context.extractBillingYearMonth;
    gas.context.extractBillingYearMonth = () =>
      ({status: 'RESOLVED', year: 2025, month: 2, sources: ['test'], candidates: []});
    try {
      const result = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
      assert.equal(result.extraction.billing.yearMonth, '2025-02');
    } finally { gas.context.extractBillingYearMonth = original; }
  });

  test('fmt 21: selecting the PayPay fee column blocks zero amount majority', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'F'; answers.columns.purpose = 'L';
    const result = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.ok(result.blocking.some((item) => item.code === 'ZERO_AMOUNT_MAJORITY'));
  });

  test('fmt 22: multiple amount candidates require explicit acknowledgement', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    answers.acknowledgements.amountChoice = false;
    let result = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.ok(result.blocking.some((item) => item.code === 'ACK_AMOUNT_CHOICE_REQUIRED'));
    answers.acknowledgements.amountChoice = true;
    result = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.ok(!result.blocking.some((item) => item.code === 'ACK_AMOUNT_CHOICE_REQUIRED'));
  });

  test('fmt 23: customer side purpose column requires acknowledgement', () => {
    const {answers} = answersFor('auカード__au202509');
    answers.columns.purpose = 'F';
    let result = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.ok(result.blocking.some((item) => item.code === 'ACK_CUSTOMER_SIDE_REQUIRED'));
    answers.acknowledgements.customerSide = true;
    result = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.ok(!result.blocking.some((item) => item.code === 'ACK_CUSTOMER_SIDE_REQUIRED'));
  });

  test('fmt 24: purpose column is required', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = null;
    const result = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.ok(result.blocking.some((item) => item.code === 'PURPOSE_COLUMN_REQUIRED'));
  });

  test('fmt 24b: month digits are excluded from Rakuten detection keywords', () => {
    const {answers} = answersFor('楽天カード__enavi202509(0000)');
    answers.columns.purpose = 'K'; answers.acknowledgements.customerSide = true;
    const result = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.deepEqual(JSON.parse(JSON.stringify(result.definition.keywords)),
      ['利用日', '利用店名・商品名', '利用者', '支払方法', '利用金額',
        '手数料/利息', '支払総額', '新規サイン', 'ツール代']);
  });

  test('fmt 24c: a positional-only billing source is left blank in a derived format', () => {
    setup();
    const item = unknown('auカード__au202509');
    const sheet = item.sheets[0];
    const base = defs().find((def) => def.formatId === 'aupay_family');
    base.billingRule = {sources: [{kind: 'cell', row: 1, column: 1}]};
    const proposal = gas.call('formatProposal_', [sheet, item.fileType, 'カード', base, null, defs()]);
    const answers = {baseFormatId: base.formatId, formatId: proposal.formatId,
      formatName: proposal.formatName, headerRow: proposal.headerRow,
      dataStartRow: proposal.dataStartRow,
      columns: {date: 'C', merchant: 'D', amount: 'E', purpose: 'F', amountFallback: null},
      acknowledgements: {customerSide: true, amountChoice: true}};
    const derived = gas.call('formatDerivedSpec_', [
      {customerId: 'C001', fileId: 'target', fileName: item.fileName}, item, sheet,
      answers, base, proposal, null]);
    assert.equal(derived.spec.billingRule, null);
  });

  test('fmt 23b: a nonstandard purpose header requires acknowledgement even without a diagnosed purpose gap', () => {
    const {card} = webWorld();
    putUnknown(card, 'ペイペイカード__PAYPAY_detail202502(0000)', 'target');
    replaceFixtureFile('ペイペイカード__PAYPAY_detail202502(0000)', 'target',
      (rows) => { rows[0][11] = ''; });
    const d = gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']);
    const p = d.proposal;
    const answers = {baseFormatId: p.baseFormatId, formatId: p.formatId,
      formatName: p.formatName, sheetName: p.sheetName, headerRow: p.headerRow,
      dataStartRow: p.dataStartRow,
      columns: {date: 'A', merchant: 'B', amount: 'E', purpose: 'L', amountFallback: null},
      acknowledgements: {customerSide: false, amountChoice: true}};
    const result = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.ok(result.blocking.some((item) => item.code === 'ACK_CUSTOMER_SIDE_REQUIRED'));
    assert.ok(result.warnings.some((item) => item.code === 'PURPOSE_HEADER_NOT_STANDARD'));
  });

  test('fmt 25: active Aeon header and width collision is blocked despite type failure', () => {
    const {card} = webWorld();
    putUnknown(card, 'イオンゴールドカード__meisai202508', 'target');
    replaceFixtureFile('イオンゴールドカード__meisai202508', 'target',
      (rows) => { rows[8][6] = 'abc'; });
    const d = gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']);
    const p = d.proposal;
    const answers = {baseFormatId: 'aeon_x9', formatId: p.formatId,
      formatName: p.formatName, sheetName: p.sheetName, headerRow: 8, dataStartRow: 9,
      columns: {date: 'A', merchant: 'C', amount: 'G', purpose: 'I', amountFallback: null},
      acknowledgements: {customerSide: false, amountChoice: true}};
    const result = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.ok(result.blocking.some((item) => item.code === 'STATIC_COLLISION'));
  });

  test('fmt 26: proposed format must not capture a valid reference file', () => {
    const {card} = webWorld();
    putUnknown(card, 'auカード__au202508', 'reference', false);
    putUnknown(card, 'auカード__au202508', 'target');
    replaceFixtureFile('auカード__au202508', 'target',
      (rows) => { rows[1][2] = 'abc'; });
    const process = gas.stubs.getSpreadsheet('master').getSheetByName(
      gas.evaluate('CONFIG.SHEET_NAMES.PROCESS_LOG'));
    const row = Array(40).fill(''); row[1] = '2026-09-01'; row[7] = 'reference';
    row[14] = 'aupay_family'; process.appendRow(row);
    const d = gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']);
    const p = d.proposal;
    const answers = {baseFormatId: 'aupay_family', formatId: p.formatId,
      formatName: p.formatName, sheetName: p.sheetName, headerRow: 1, dataStartRow: 2,
      columns: {date: 'C', merchant: 'D', amount: 'E', purpose: 'G', amountFallback: null},
      acknowledgements: {customerSide: false, amountChoice: true}};
    const result = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.ok(result.blocking.some((item) => item.code === 'REFERENCE_COLLISION'));
  });

  test('fmt 28: preview hash changes with answers and is stable for equal inputs', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    const first = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    const same = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.equal(first.previewHash, same.previewHash);
    answers.formatName += '改';
    const changed = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.notEqual(first.previewHash, changed.previewHash);
    answers.formatName = answers.formatName.slice(0, -1);
    answers.acknowledgements.customerSide = true;
    const acknowledged = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.notEqual(first.previewHash, acknowledged.previewHash);
    answers.acknowledgements.customerSide = false;
    replaceFixtureFile('ペイペイカード__PAYPAY_detail202502(0000)', 'target', () => {});
    const replaced = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.notEqual(first.previewHash, replaced.previewHash);
  });

  test('fmt 27: preview has no master or spreadsheet side effects', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    const master = gas.stubs.getSpreadsheet('master');
    const names = [gas.evaluate('CONFIG.SHEET_NAMES.CARD_FORMAT_MASTER'),
      gas.evaluate('CONFIG.SHEET_NAMES.REVIEW'),
      gas.evaluate('CONFIG.SHEET_NAMES.PROCESS_LOG')];
    const before = names.map((name) => JSON.stringify(master.getSheetByName(name).getDataRange().getValues()));
    const ids = gas.stubs.getSpreadsheetIds().slice().sort();
    gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.deepEqual(names.map((name) => JSON.stringify(master.getSheetByName(name).getDataRange().getValues())), before);
    assert.deepEqual(gas.stubs.getSpreadsheetIds().slice().sort(), ids);
  });

  test('fmt 29: au preview and import agree on complemented purpose and each source row', () => {
    const {card} = webWorld();
    putUnknown(card, 'auカード__au202509', 'target');
    const purposeSheet = gas.stubs.getSpreadsheet('master').getSheetByName(
      gas.evaluate('CONFIG.SHEET_NAMES.PURPOSE_COMPLEMENT'));
    purposeSheet.appendRow(['PR1', 'au202509', '補完された用途', true]);
    const d = gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']);
    const p = d.proposal;
    const answers = {baseFormatId: p.baseFormatId, formatId: p.formatId,
      formatName: p.formatName, sheetName: p.sheetName, headerRow: p.headerRow,
      dataStartRow: p.dataStartRow,
      columns: {date: 'C', merchant: 'D', amount: 'E', purpose: 'F', amountFallback: null},
      acknowledgements: {customerSide: true, amountChoice: true}};
    const preview = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.equal(preview.extraction.count, 1);
    assert.equal(preview.extraction.purposeEmptyCount, 0);
    assert.ok(preview.extraction.rows.every((row) =>
      row.purpose === '補完された用途' && row.purposeFilled === true));
    seedWaiting('target', d.fileName);
    assert.equal(gas.call('webAppSaveFormat',
      ['C001', 'card', 'target', answers, preview.previewHash]).readback, 'OK');
    assert.equal(gas.call('webAppRequeueFormatFiles',
      ['C001', 'card', ['target']]).requeued.length, 1);
    prepareImportRuntime();
    const imported = gas.call('webAppRunImport', ['C001', 'card', {}]);
    assert.equal(imported.done, 1, JSON.stringify(imported));
    const actual = gas.call('getTransactionsForFile_', ['target']);
    assert.equal(actual.length, preview.extraction.count);
    const byRow = new Map(actual.map((tx) => [tx.sourceRow, tx]));
    for (const row of preview.extraction.rows) {
      const tx = byRow.get(row.sourceRow);
      assert.ok(tx, 'sourceRow ' + row.sourceRow);
      assert.equal(tx.originalAmount, row.amount);
      assert.equal(tx.originalMerchant, row.merchant);
      assert.equal(tx.originalPurpose, row.purpose);
      if (tx.planned.b) assert.equal(String(tx.planned.b).slice(0, 10), row.date);
    }
  });

  test('fmt 30: saving a preview writes and reads back a Web app format', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    const preview = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    const result = gas.call('webAppSaveFormat', ['C001', 'card', 'target', answers, preview.previewHash]);
    assert.equal(result.saved, true);
    assert.equal(result.readback, 'OK');
    const rows = gas.call('loadFormatDefinitions', [{formatId: answers.formatId}]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].enabled, true);
    assert.equal(rows[0].answers.origin, 'WEBAPP');
  });

  test('fmt 30b: derived cells are concrete and Sheets-style empty readback matches', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    const preview = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    const install = gas.context.installCardFormat;
    const readRow = gas.context.readRowByNumber_;
    let written;
    gas.context.installCardFormat = function(spec) {
      written = gas.call('cardFormatRowValues_', [spec, 1, '2026-09-25', 'owner@example.com']);
      return install(spec);
    };
    gas.context.readRowByNumber_ = function(...args) {
      return readRow(...args).map((cell) => cell == null ? '' : cell);
    };
    try {
      const saved = gas.call('webAppSaveFormat',
        ['C001', 'card', 'target', answers, preview.previewHash]);
      assert.equal(saved.readback, 'OK', JSON.stringify(saved.diff));
      assert.ok(written.every((cell) => cell !== null && cell !== undefined));
    } finally {
      gas.context.installCardFormat = install;
      gas.context.readRowByNumber_ = readRow;
    }
    assert.equal(gas.call('formatReadbackCellsEqual_', [
      Array.from({length: 38}, (_, i) => i === 24 ? null : ''),
      Array(38).fill('')]), true);
  });

  test('fmt 32b: a formula-like format name is blocked', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    for (const prefix of ['=', '+', '-', '@']) {
      answers.formatName = prefix + '危険';
      const preview = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
      assert.ok(preview.blocking.some((item) => item.code === 'FORMAT_NAME_REQUIRED'), prefix);
    }
  });

  test('fmt 31: changed format name makes a preview stale without writing', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    const preview = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    answers.formatName += '改';
    const result = gas.call('webAppSaveFormat', ['C001', 'card', 'target', answers, preview.previewHash]);
    assert.equal(result.saved, false);
    assert.equal(result.code, 'PREVIEW_STALE');
    assert.equal(gas.call('loadFormatDefinitions', [{formatId: answers.formatId}]).length, 0);
  });

  test('fmt 33: a lost keyword on write disables the row after readback', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    const preview = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    const original = gas.context.installCardFormat;
    gas.context.installCardFormat = function(spec) {
      const broken = JSON.parse(JSON.stringify(spec));
      broken.keywordRule.allOf[0].keywords.pop();
      broken.keywordRule.allOf[0].minMatch -= 1;
      return original(broken);
    };
    let result;
    try {
      result = gas.call('webAppSaveFormat', ['C001', 'card', 'target', answers, preview.previewHash]);
    } finally {
      gas.context.installCardFormat = original;
    }
    const written = gas.call('loadFormatDefinitions', [{formatId: answers.formatId}])[0];
    assert.equal(result.readback, 'MISMATCH', JSON.stringify({
      keywords: written.keywordRule, expected: preview.definition.keywords, diff: result.diff
    }));
    assert.equal(result.disabled, true);
    const row = gas.call('loadFormatDefinitions', [{formatId: answers.formatId}])[0];
    assert.equal(row.enabled, false);
    const audit = gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ')
      .getDataRange().getValues().map((r) => r[2]);
    assert.ok(audit.includes('FORMAT_REGISTER'));
    assert.ok(audit.includes('FORMAT_DISABLE'));
  });

  test('fmt 34: three newly saved formats do not capture other real samples', () => {
    const {card} = webWorld();
    const cases = [
      {slug: 'ペイペイカード__PAYPAY_detail202502(0000)', id: 'pay',
        columns: {date: 'A', merchant: 'B', amount: 'E', purpose: 'L', amountFallback: null},
        ack: {customerSide: false, amountChoice: true}},
      {slug: 'アプラスカード__aplus_meisai_0000_202503', id: 'ap',
        columns: {date: 'B', merchant: 'C', amount: 'D', purpose: 'J', amountFallback: null},
        ack: {customerSide: false, amountChoice: true}},
      {slug: 'auカード__au202509', id: 'au',
        columns: {date: 'C', merchant: 'D', amount: 'E', purpose: 'F', amountFallback: null},
        ack: {customerSide: true, amountChoice: true}}
    ];
    cases.forEach((item) => putUnknown(card, item.slug, item.id));
    const sampleSlugs = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'samples', 'index.json'), 'utf8'));
    const unknownSlugs = fs.readdirSync(path.join(fixtureRoot, 'unknown-formats'))
      .filter((name) => name.endsWith('.json') && name !== 'index.json')
      .map((name) => name.slice(0, -5));
    const all = sampleSlugs.map((slug) => ['samples', slug])
      .concat(unknownSlugs.map((slug) => ['unknown-formats', slug]));
    const baseline = all.map(([group, slug]) => {
      const result = detect(fixture(group, slug));
      return result.status === 'RESOLVED' ? result.formatId : result.status;
    });
    const savedSlugs = new Set();
    cases.forEach((item) => {
      const d = gas.call('webAppExplainUnknownFile', ['C001', 'card', item.id]);
      const p = d.proposal;
      const answers = {baseFormatId: p.baseFormatId, formatId: p.formatId,
        formatName: p.formatName, sheetName: p.sheetName, headerRow: p.headerRow,
        dataStartRow: p.dataStartRow, columns: item.columns, acknowledgements: item.ack};
      const preview = gas.call('webAppPreviewFormat', ['C001', 'card', item.id, answers]);
      assert.deepEqual(JSON.parse(JSON.stringify(preview.blocking)), [], item.id);
      assert.equal(gas.call('webAppSaveFormat',
        ['C001', 'card', item.id, answers, preview.previewHash]).readback, 'OK', item.id);
      savedSlugs.add(item.slug);
      if (item.id === 'au') {
        savedSlugs.add('auカード__au202510');
        savedSlugs.add('auカード__AU202511');
      }
      all.forEach(([group, slug], index) => {
        const result = detect(fixture(group, slug));
        const actual = result.status === 'RESOLVED' ? result.formatId : result.status;
        const allowed = savedSlugs.has(slug);
        if (!allowed) assert.equal(actual, baseline[index], item.id + ': ' + slug);
      });
    });
  });

  function auVariantWithSiblings(siblingSlugs) {
    const {card} = webWorld();
    putUnknown(card, 'auカード__au202509', 'target');
    siblingSlugs.forEach((slug, index) => putUnknown(card, slug, 's' + index));
    const d = gas.call('webAppExplainUnknownFile', ['C001', 'card', 'target']);
    const p = d.proposal;
    const answers = {baseFormatId: p.baseFormatId, formatId: p.formatId,
      formatName: p.formatName, sheetName: p.sheetName, headerRow: p.headerRow,
      dataStartRow: p.dataStartRow,
      columns: {date: 'C', merchant: 'D', amount: 'E', purpose: 'F', amountFallback: null},
      acknowledgements: {customerSide: true, amountChoice: true}};
    const preview = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.deepEqual(JSON.parse(JSON.stringify(preview.blocking)), []);
    return {answers, preview};
  }

  test('fmt 35: saving the au variant diagnoses both sibling months', () => {
    const {answers, preview} = auVariantWithSiblings([
      'auカード__au202510', 'auカード__AU202511']);
    const saved = gas.call('webAppSaveFormat',
      ['C001', 'card', 'target', answers, preview.previewHash]);
    assert.equal(saved.readback, 'OK');
    assert.deepEqual(JSON.parse(JSON.stringify(saved.siblings.map((s) => s.verdict))),
      ['MATCHES_NEW', 'MATCHES_NEW']);
  });

  test('fmt 35b: siblings in another folder are excluded', () => {
    const {answers, preview} = auVariantWithSiblings([]);
    const other = gas.stubs.createFolder('other', {name: '別フォルダ', fileIds: [], subFolderIds: []});
    putUnknown(other, 'auカード__au202510', 'outside');
    const saved = gas.call('webAppSaveFormat',
      ['C001', 'card', 'target', answers, preview.previewHash]);
    assert.ok(!saved.siblings.some((s) => s.fileId === 'outside'));
    assert.ok(!saved.siblingsNotRead.includes('outside'));
  });

  test('fmt 36b: in-progress review is an unresolved sibling', () => {
    const {answers, preview} = auVariantWithSiblings(['auカード__au202510']);
    const review = gas.call('openReviews', [{fileId: 's0'}])[0];
    gas.call('updateReviewStatus', [review.reviewId, 'IN_PROGRESS', {}]);
    const saved = gas.call('webAppSaveFormat',
      ['C001', 'card', 'target', answers, preview.previewHash]);
    assert.ok(saved.siblings.some((s) => s.fileId === 's0'));
    seedWaiting('s0', 'au202510');
    const listed = gas.call('webAppListFolder', ['C001', 'card']);
    assert.ok(listed.files.some((file) => file.fileId === 's0' && file.formatReviewId));
  });

  test('fmt 36: sibling reading respects the six file limit and the deadline gate', () => {
    const slugs = Array(7).fill('auカード__au202510');
    let scenario = auVariantWithSiblings(slugs);
    let saved = gas.call('webAppSaveFormat',
      ['C001', 'card', 'target', scenario.answers, scenario.preview.previewHash]);
    assert.equal(saved.siblings.length, 6);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.siblingsNotRead)), ['s6']);
    scenario = auVariantWithSiblings(slugs);
    const original = gas.context.webAppFormatNowMs_;
    let calls = 0;
    gas.context.webAppFormatNowMs_ = () => (++calls === 1 ? 0 : 300000);
    try {
      saved = gas.call('webAppSaveFormat',
        ['C001', 'card', 'target', scenario.answers, scenario.preview.previewHash]);
    } finally { gas.context.webAppFormatNowMs_ = original; }
    assert.equal(saved.siblings.length, 0);
    assert.equal(saved.siblingsNotRead.length, 7);
  });

  test('fmt 41: a still unknown file stays open when requeue is requested', () => {
    const {card} = webWorld();
    putUnknown(card, 'アプラスカード__aplus_meisai_0000_202503', 'target');
    const result = gas.call('webAppRequeueFormatFiles', ['C001', 'card', ['target']]);
    assert.deepEqual(JSON.parse(JSON.stringify(result.requeued)), []);
    assert.deepEqual(JSON.parse(JSON.stringify(result.skipped)),
      [{fileId: 'target', code: 'STILL_UNKNOWN'}]);
    assert.equal(gas.call('openReviews', [{fileId: 'target'}])[0].status, 'OPEN');
  });

  test('fmt 40: requeue closes the review and clears the submitted hash', () => {
    const {answers, diagnosis} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    seedWaiting('target', diagnosis.fileName);
    const preview = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.equal(gas.call('webAppSaveFormat',
      ['C001', 'card', 'target', answers, preview.previewHash]).readback, 'OK');
    const auditSheet = gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ');
    const before = auditSheet.getDataRange().getValues().length;
    const result = gas.call('webAppRequeueFormatFiles', ['C001', 'card', ['target']]);
    assert.equal(result.requeued[0].formatId, answers.formatId);
    const review = gas.call('getReviewById', [diagnosis.reviewId]);
    assert.equal(review.status, 'RESOLVED');
    assert.equal(review.resolveOperation, 'REGISTER_FORMAT');
    assert.equal(gas.call('getFileState', ['target']), 'DISCOVERED');
    assert.equal(gas.call('getPermanentFileIndexRecord_', ['target']).values[5], '');
    const added = auditSheet.getDataRange().getValues().slice(before).map((row) => row[2]);
    assert.deepEqual(added, ['REVIEW_RESOLVE', 'FORMAT_REQUEUE']);
    prepareImportRuntime();
    const imported = gas.call('webAppRunImport', ['C001', 'card', {}]);
    assert.equal(imported.done, 1, JSON.stringify(imported));
    assert.equal(gas.call('getProcessLogRecord_', ['target']).values[14], answers.formatId);
  });

  test('fmt 42: requeue limits work and skips IDs outside the folder', () => {
    const {card} = webWorld();
    for (let i = 0; i < 8; i += 1)
      putUnknown(card, 'アプラスカード__aplus_meisai_0000_202503', 'f' + i);
    const result = gas.call('webAppRequeueFormatFiles', ['C001', 'card',
      ['missing', 'f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6']]);
    assert.equal(result.skipped.length, 6);
    assert.equal(result.skipped[0].code, 'NOT_FORMAT_UNKNOWN');
    assert.deepEqual(JSON.parse(JSON.stringify(result.remaining)), ['f5', 'f6']);
  });

  test('fmt 42b: requeue stops before the deadline and returns remaining IDs', () => {
    const {card} = webWorld();
    putUnknown(card, 'アプラスカード__aplus_meisai_0000_202503', 'f0');
    putUnknown(card, 'アプラスカード__aplus_meisai_0000_202503', 'f1');
    const original = gas.context.webAppFormatNowMs_;
    let calls = 0;
    gas.context.webAppFormatNowMs_ = () => (++calls < 3 ? 0 : 300000);
    try {
      const result = gas.call('webAppRequeueFormatFiles', ['C001', 'card', ['f0', 'f1']]);
      assert.deepEqual(JSON.parse(JSON.stringify(result.remaining)), ['f1']);
    } finally { gas.context.webAppFormatNowMs_ = original; }
  });

  test('fmt 55: a Web app format can be withdrawn', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    const preview = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    const saved = gas.call('webAppSaveFormat', ['C001', 'card', 'target', answers, preview.previewHash]);
    assert.equal(saved.readback, 'OK');
    const result = gas.call('webAppWithdrawFormat', ['C001', answers.formatId]);
    assert.equal(result.withdrawn, true);
    const row = gas.call('loadFormatDefinitions', [{formatId: answers.formatId}])[0];
    assert.equal(row.enabled, false);
    const source = unknown('ペイペイカード__PAYPAY_detail202502(0000)');
    assert.equal(detect(source).status, 'UNKNOWN_CARD_FORMAT');
  });

  test('fmt 55b: withdrawing an already disabled Web app format does not audit again', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    const preview = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.equal(gas.call('webAppSaveFormat',
      ['C001', 'card', 'target', answers, preview.previewHash]).readback, 'OK');
    gas.call('webAppWithdrawFormat', ['C001', answers.formatId]);
    const audit = gas.stubs.getSpreadsheet('master').getSheetByName('監査ログ');
    const before = audit.getDataRange().getValues().length;
    const result = gas.call('webAppWithdrawFormat', ['C001', answers.formatId]);
    assert.equal(result.code, 'NOT_ACTIVE');
    assert.equal(audit.getDataRange().getValues().length, before);
  });

  test('fmt 32: a withdrawn format ID cannot be reused', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    const preview = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.equal(gas.call('webAppSaveFormat',
      ['C001', 'card', 'target', answers, preview.previewHash]).readback, 'OK');
    gas.call('webAppWithdrawFormat', ['C001', answers.formatId]);
    const again = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.ok(again.blocking.some((item) => item.code === 'FORMAT_ID_TAKEN'));
  });

  test('fmt 52: RETURN_TO_CUSTOMER is not offered for other review types', () => {
    webWorld();
    const review = gas.call('registerReview', [{reviewType: 'EMPTY_FILE',
      customerId: 'C001', fileId: 'other'}]);
    assert.throws(() => gas.call('resolveFileReview', [review.reviewId,
      'RETURN_TO_CUSTOMER', {role: 'SYSTEM_ADMIN'}]), /is not offered/);
  });

  test('fmt 50: customer correction resolves the file into CUSTOMER_FIX_REQUIRED', () => {
    const {card} = webWorld();
    const item = putUnknown(card, '楽天カード__enavi202509(0000)', 'target');
    seedWaiting('target', item.fileName);
    const review = gas.call('openReviews', [{fileId: 'target'}])[0];
    const result = gas.call('webAppReturnFileToCustomer',
      ['C001', 'card', 'target', 'PURPOSE_HEADER_VALUE', 'K列の見出しを修正']);
    assert.equal(result.returned, true);
    assert.equal(gas.call('getFileState', ['target']), 'CUSTOMER_FIX_REQUIRED');
    const settled = gas.call('getReviewById', [review.reviewId]);
    assert.equal(settled.status, 'RESOLVED');
    assert.equal(settled.resolveOperation, 'RETURN_TO_CUSTOMER');
    const process = gas.call('getProcessLogRecord_', ['target']);
    assert.ok(String(process.values[22]).includes('SOURCE_REQUIRES_CUSTOMER_FIX'));
  });

  test('fmt 56: code installed formats cannot be withdrawn', () => {
    webWorld();
    const result = gas.call('webAppWithdrawFormat', ['C001', 'aupay_family']);
    assert.deepEqual(JSON.parse(JSON.stringify(result)),
      {withdrawn: false, code: 'NOT_WEBAPP_FORMAT'});
    assert.equal(gas.call('loadFormatDefinitions', [{formatId: 'aupay_family'}])[0].enabled, true);
  });

  test('fmt 60: folder list reads unknown reviews only for review waiting files', () => {
    const {card} = webWorld();
    putUnknown(card, 'アプラスカード__aplus_meisai_0000_202503', 'target');
    const original = gas.context.openReviews;
    gas.context.openReviews = () => { throw new Error('should not read reviews'); };
    try {
      const listed = gas.call('webAppListFolder', ['C001', 'card']);
      assert.equal(listed.files[0].formatReviewId, null);
    } finally { gas.context.openReviews = original; }
    const row = Array(13).fill(''); row[0] = 'target'; row[1] = 'C001';
    row[3] = 'REVIEW_WAIT';
    gas.stubs.getSpreadsheet('master').getSheetByName(
      gas.evaluate('CONFIG.SHEET_NAMES.PERMANENT_FILE_INDEX')).appendRow(row);
    const listed = gas.call('webAppListFolder', ['C001', 'card']);
    assert.ok(listed.files[0].formatReviewId);
  });

  test('fmt 70: save remains disabled for blocking, stale input, or missing acknowledgements', () => {
    assert.equal(clientEval("formatCanSave({blocking: [{code:'NO_TRANSACTIONS'}], previewHash:'h'}, 'h', {customerSide:true,amountChoice:true})"), false);
    assert.equal(clientEval("formatCanSave({blocking: [], previewHash:'h'}, null, {customerSide:true,amountChoice:true})"), false);
    assert.equal(clientEval("formatCanSave({blocking: [], previewHash:'h', requiresCustomerSide:true}, 'h', {customerSide:false,amountChoice:true})"), false);
    assert.equal(clientEval("formatCanSave({blocking: [], previewHash:'h', requiresAmountChoice:true}, 'h', {customerSide:true,amountChoice:false})"), false);
    assert.equal(clientEval("formatCanSave({blocking: [], previewHash:'h'}, 'h', {customerSide:true,amountChoice:true})"), true);
  });

  test('fmt 71: every blocking code has its specified Japanese message', () => {
    for (const code of ['DEFINITION_INVALID', 'FORMAT_ID_INVALID', 'FORMAT_ID_TAKEN',
      'FORMAT_NAME_REQUIRED', 'HEADER_ROW_INVALID', 'DATA_START_INVALID',
      'COLUMN_OUT_OF_RANGE', 'COLUMN_ROLE_DUPLICATE', 'PURPOSE_COLUMN_REQUIRED',
      'TOO_FEW_KEYWORDS', 'NOT_MATCHING_TARGET', 'TARGET_AMBIGUOUS',
      'STATIC_COLLISION', 'REFERENCE_COLLISION', 'NO_TRANSACTIONS',
      'ZERO_AMOUNT_MAJORITY', 'ACK_CUSTOMER_SIDE_REQUIRED',
      'ACK_AMOUNT_CHOICE_REQUIRED', 'PREVIEW_STALE']) {
      const message = clientEval(`formatBlockingMessage(${JSON.stringify(code)}, '詳細')`);
      assert.equal(typeof message, 'string', code);
      assert.ok(message.length > 10, code);
      assert.ok(!message.includes('undefined'), code);
    }
    assert.ok(clientEval("formatBlockingMessage('FUTURE_CODE')").includes('FUTURE_CODE'));
    assert.ok(clientEval("formatBlockingMessage('COLUMN_ROLE_DUPLICATE','date/amount')").includes('利用日と金額'));
    assert.ok(!clientEval("formatBlockingMessage('FORMAT_ID_TAKEN',null,'new_x6')").includes('「」'));
    assert.ok(!clientEval("formatBlockingMessage('NOT_MATCHING_TARGET',{stage:'COLUMNS',width:{actual:6,min:7,max:7}})").includes('{'));
    assert.ok(!clientEval("(state.formatDiagnosis={nearest:[{formatId:'aupay_family',formatName:'auカード'}]},formatBlockingMessage('TARGET_AMBIGUOUS',['aupay_family']))").includes('aupay_family'));
    assert.ok(clientEval("(state.formatPreview={formatNames:[{formatId:'active_x',formatName:'登録済み形式'}]},formatBlockingMessage('STATIC_COLLISION','active_x'))").includes('登録済み形式'));
  });

  test('fmt 74: failed save response never becomes saved state', () => {
    const result = clientEval("formatSaveResult({ok:false,code:'NOT_FORMAT_UNKNOWN'})");
    assert.equal(result.saved, null);
    assert.equal(result.close, true);
    assert.ok(result.notice.includes('要確認'));
  });

  test('fmt 75: purpose acknowledgement uses the selected grid header', () => {
    const d = {customerSide: false, grid: {columnLetters: ['A','B'],
      rowNumbers: [1,2], cells: [['使用用途','店名'],['別の見出し','店名']]},
      proposal: {headers: {A:'使用用途'}}};
    const a = {headerRow: 2, columns: {purpose: 'A'}};
    assert.equal(clientEval(`formatPurposeAcknowledgement(${JSON.stringify(d)},${JSON.stringify(a)}).required`), true);
    a.headerRow = 1; d.grid.cells[0][0] = '　使用用途 ';
    assert.equal(clientEval(`formatPurposeAcknowledgement(${JSON.stringify(d)},${JSON.stringify(a)}).required`), false);
  });

  test('fmt 76: stale preview responses are ignored', () => {
    assert.equal(clientEval("formatPreviewIsCurrent('{\"formatId\":\"a\"}',{formatId:'b'})"), false);
    assert.equal(clientEval("formatPreviewIsCurrent('{\"formatId\":\"a\"}',{formatId:'a'})"), true);
  });

  test('fmt 77: blocking detail is translated for role and ID', () => {
    assert.ok(clientEval("formatBlockingMessage('COLUMN_ROLE_DUPLICATE','date/amount')").includes('利用日と金額'));
    assert.ok(clientEval("formatBlockingMessage('FORMAT_ID_TAKEN',null,'new_x6')").includes('new_x6'));
  });

  test('fmt 78: requeue result reports remaining count', () => {
    assert.ok(clientEval("formatRequeueMessage({requeued:[{fileId:'a'}],remaining:['b'],skipped:[]})")
      .includes('残り 1 件'));
  });

  test('fmt 78b: reference amount remains a selectable choice', () => {
    const result = clientEval("formatAmountChoices({columns:{amount:{column:'A',source:'REFERENCE'}},amountCandidates:[{column:'B',header:'利用金額'},{column:'C',header:'支払金額'}]}," +
      "{headerRow:1,columns:{amount:'B'}},{rowNumbers:[1],columnLetters:['A','B','C'],cells:[['参照額','利用金額','支払金額']]})");
    assert.equal(result[0].column, 'A');
    assert.equal(result[0].header, '参照額');
  });

  test('fmt 79: purpose header normalization preserves internal whitespace', () => {
    for (const header of ['使用 用途', '使用　用途', '使用\n用途']) {
      assert.equal(clientEval(`formatNormalizeHeader(${JSON.stringify(header)})`),
        gas.call('normalizeMerchant', [header]));
      assert.equal(clientEval(`formatPurposeAcknowledgement({customerSide:false,grid:{rowNumbers:[1],columnLetters:['A'],cells:[[${JSON.stringify(header)}]]}},{headerRow:1,columns:{purpose:'A'}}).required`), true);
    }
    assert.equal(clientEval("formatPurposeAcknowledgement({customerSide:false,grid:{rowNumbers:[1],columnLetters:['A'],cells:[['　使用用途 ']]}},{headerRow:1,columns:{purpose:'A'}}).required"), false);
  });

  test('fmt 80: preview separates rows before the data start from excluded details', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    const result = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.equal(result.extraction.excludedBeforeStart, answers.dataStartRow - 1);
    assert.ok(result.extraction.excluded.every((item) => item.ruleId !== '_rowRange'));
    const warning = result.warnings.find((item) => item.code === 'EXCLUDED_ROWS');
    assert.equal(warning ? warning.detail : 0, result.extraction.excluded.length);
  });

  test('fmt 81: no purpose column does not create header warnings or header acknowledgement', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = null;
    const result = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    assert.ok(result.blocking.some((item) => item.code === 'PURPOSE_COLUMN_REQUIRED'));
    assert.ok(!result.warnings.some((item) => item.code === 'PURPOSE_HEADER_NOT_STANDARD'));
    assert.ok(!result.blocking.some((item) => item.code === 'ACK_CUSTOMER_SIDE_REQUIRED'));
  });

  test('fmt 82: editing an answer preserves the panel and current control', () => {
    assert.equal(clientEval("(state.formatAnswers={formatId:'old'},state.formatPreview={previewHash:'h'},state.formatHash='h',renderFormatPanel=function(){throw Error('panel replaced')},formatUpdateAnswer(function(){state.formatAnswers.formatId='new'}),state.formatAnswers.formatId+'|'+state.formatHash)"), 'new|null');
  });

  browserAsyncTest('fmt 83: requeue keeps the diagnosis without rediagnosing', async () => {
    const world = mountedFormatWorld({webAppRequeueFormatFiles: {
      ok: true, requeued: [{fileId: 'target'}], remaining: ['remaining'], skipped: []},
      webAppListFolder: {kind: 'FILES', files: []},
      webAppListReviews: {reviews: [], total: 0, limit: 20}});
    world.ui.state.formatSaved = {saved: true, formatId: 'paypay_new',
      readback: 'OK', after: {count: 1, total: 100}, siblings: [
        {fileId: 'remaining', fileName: 'remaining', verdict: 'MATCHES_NEW'}]};
    world.ui.state.formatSelectedIds = ['target', 'remaining'];
    world.ui.renderFormatPanel();
    const pending = control(world, 'button', '取込待ちに戻す').fire('click')[0];
    world.ids['confirm-submit'].fire('click');
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(world.ui.state.formatFileId, 'target');
    assert.equal(JSON.stringify(world.ui.state.formatSelectedIds), '["remaining"]');
    assert.ok(!world.calls.some((call) => call.name === 'webAppExplainUnknownFile'));
  });

  test('fmt 84: excluded reasons are human readable', () => {
    assert.equal(clientEval("formatExcludedReason('_dateAmountEmpty')"), '利用日と金額が空');
    assert.equal(clientEval("formatExcludedReason('smbc_total')"), '除外の規則「smbc_total」');
  });

  test('fmt 85: target mismatch names the failed type and strips emphasis', () => {
    const gap = {stage:'COLUMNS', width:{actual:6,min:6,max:6}, samplesFound:true,
      typeFailures:[{index:0,type:'date',bad:2,of:4}]};
    assert.ok(clientEval(`formatGapMessage(${JSON.stringify(gap)})`).includes('1列目が日付でない行 2/4'));
    assert.ok(!clientEval("formatGapText('**列数が違います**')").includes('**'));
  });

  test('fmt 86: readback signature still compares rows excluded before start', () => {
    const extraction = {count:0,total:0,excluded:[],category:{category:1}};
    const one = gas.call('formatExtractionSignature_', [extraction, [],
      [{sourceRow:1,ruleId:'_rowRange',cells:['A']}]]);
    const two = gas.call('formatExtractionSignature_', [extraction, [],
      [{sourceRow:1,ruleId:'_rowRange',cells:['B']}]]);
    assert.notEqual(one, two);
  });

  test('fmt 87: target mismatch covers missing samples, wrong file type, and invalid definition', () => {
    assert.ok(clientEval("formatGapMessage({stage:'COLUMNS',width:{actual:5,min:6,max:6},samplesFound:false})").includes('見本行'));
    assert.ok(clientEval("formatGapMessage({stage:'FILE_TYPE'})").includes('ファイル種別'));
    assert.ok(clientEval("formatGapMessage({stage:'INVALID'})").includes('定義'));
  });

  test('fmt 88: definition problems are listed and required columns are named before preview', () => {
    assert.ok(clientEval("formatBlockingMessage('DEFINITION_INVALID',['問題A','問題B'])").includes('\n・問題B'));
    assert.equal(clientEval("formatRequiredColumnMessage({columns:{date:null,merchant:'B',amount:'C'}})"),
      '利用日の列を選んでください');
    const world = mountedFormatWorld();
    world.ui.state.formatAnswers.columns.date = null;
    world.ui.renderFormatPanel();
    control(world, 'button', '試し読み').fire('click');
    assert.ok(world.ids['format-body'].textContent.includes('利用日の列を選んでください'));
    assert.ok(!world.calls.some((call) => call.name === 'webAppPreviewFormat'));
  });

  browserAsyncTest('fmt 89: opening another format or closing asks before losing save', async () => {
    const world = mountedFormatWorld();
    world.ui.state.formatSaved = {saved: true, formatId: 'paypay_new',
      readback: 'OK', after: {count: 1, total: 100}, siblings: []};
    let pending = world.ui.openFormat('another');
    assert.equal(world.ids['confirm-dialog'].open, true);
    world.ids['confirm-cancel'].fire('click'); await pending;
    assert.equal(world.ui.state.formatFileId, 'target');
    pending = world.ids['format-close'].fire('click')[0];
    assert.equal(world.ids['confirm-dialog'].open, true);
    world.ids['confirm-cancel'].fire('click'); await pending;
    assert.equal(world.ui.state.formatSaved.formatId, 'paypay_new');
  });

  test('fmt 90: rejected save makes its old preview unsavable and shows blocking', () => {
    const result = clientEval("(state.formatPreview={blocking:[],previewHash:'h'},state.formatHash='h',formatApplySaveFailure({saved:false,blocking:[{code:'NO_TRANSACTIONS'}]}),[state.formatHash,state.formatPreview.blocking[0].code,formatCanSave(state.formatPreview,state.formatHash,{})])");
    assert.deepEqual(result, [null, 'NO_TRANSACTIONS', false]);
  });

  test('fmt 91: import busy prevents answer changes and saved checks are disabled', () => {
    const world = mountedFormatWorld();
    world.ui.state.formatSaved = {saved: true, formatId: 'paypay_new',
      readback: 'OK', after: {count: 1, total: 100}, siblings: []};
    world.ui.renderFormatPanel();
    world.ui.state.importBusy = true;
    world.ui.renderSelection();
    assert.equal(control(world, 'label', '登録した形式に一致').querySelector('input').disabled, true);
    const previous = world.ui.state.formatAnswers.formatId;
    change(world, '形式 ID', 'input', 'changed');
    assert.equal(world.ui.state.formatAnswers.formatId, previous);
  });

  browserAsyncTest('fmt 92: review confirmation cancels format action and withdrawal uses saved ID', async () => {
    const world = mountedFormatWorld({webAppWithdrawFormat: {withdrawn: true},
      webAppListFolder: {kind: 'FILES', files: []},
      webAppListReviews: {reviews: [], total: 0, limit: 20}});
    world.ui.state.formatSaved = {saved: true, formatId: 'saved_id',
      readback: 'OK', after: {count: 1, total: 100}, siblings: []};
    world.ui.renderFormatPanel();
    const pending = control(world, 'button', 'この登録を取り消す').fire('click')[0];
    const row = world.document.createElement('tr'); row.dataset.reviewId = 'r1';
    const box = world.document.createElement('input'); box.className = 'review-select'; box.checked = true;
    const partner = world.document.createElement('input'); partner.className = 'partner-input';
    partner.value = '店A'; row.appendChild(box); row.appendChild(partner); world.root.appendChild(row);
    world.ui.state.reviews = [{reviewId: 'r1', fileId: 'target', merchantOriginal: '店A',
      merchantNormalized: '店A', fileName: 'target', sourceRow: 2}];
    world.ids['resolve-button'].disabled = false;
    world.ids['resolve-button'].fire('click');
    await pending;
    assert.ok(!world.calls.some((call) => call.name === 'webAppWithdrawFormat'));
    const retry = control(world, 'button', 'この登録を取り消す').fire('click')[0];
    world.ids['confirm-submit'].fire('click'); await retry;
    assert.equal(world.calls.find((call) => call.name === 'webAppWithdrawFormat').args[1], 'saved_id');
  });

  test('fmt 93: diagnosis warnings and selected-column provenance appear before inputs', () => {
    const world = mountedFormatWorld();
    world.ui.state.formatDiagnosis.warnings = [{code: 'REFERENCE_UNREADABLE'}];
    world.ui.state.formatDiagnosis.customerSide = true;
    world.ui.state.formatDiagnosis.nearest = [{formatId: 'base', formatName: '土台'}];
    world.ui.state.formatDiagnosis.purposeGap = {kind: 'PURPOSE_COLUMN_ABSENT'};
    world.ui.state.formatDiagnosis.proposal.columns.amountFallback.source = null;
    world.ui.state.formatRegistrationOpen = true;
    world.ui.renderFormatPanel();
    const body = world.ids['format-body'].textContent;
    assert.ok(body.includes('参照ファイル'));
    assert.ok(body.indexOf('入力ミスを様式として登録') < body.indexOf('列と形式の指定'));
    change(world, '利用日', 'select', 'E');
    assert.ok(world.ids['format-body'].textContent.includes('利用日（手で選択）'));
  });

  test('fmt 94: changing a column invalidates the preview without an exception', () => {
    const world = mountedFormatWorld();
    const selects = world.ids['format-body'].querySelectorAll('select');
    assert.ok(selects.length >= 1);
    assert.equal(JSON.stringify(world.ui.state.formatColumnSelects.map((select) => select.children.length)),
      '[6,6,6,6]');
    selects[0].value = 'E';
    selects[0].fire('change');
    assert.equal(world.ui.state.formatPreview, null);
    assert.equal(world.ui.state.formatHash, null);
    assert.equal(world.ui.state.formatSaveButton.disabled, true);
    assert.ok(world.ids['format-body'].textContent.includes('手で選択'));
  });

  test('fmt 95: amount choice preserves the reference option after redraw', () => {
    const world = mountedFormatWorld();
    const {state, renderFormatPanel} = world.ui;
    state.formatDiagnosis.proposal.columns.amount = {column: 'C', source: 'REFERENCE'};
    state.formatDiagnosis.proposal.amountCandidates = [
      {column: 'D', header: '使用用途'}, {column: 'E', header: '予備'}];
    renderFormatPanel();
    const radios = world.ids['format-body'].querySelectorAll('input')
      .filter((input) => input.type === 'radio');
    assert.equal(JSON.stringify(radios.map((radio) => radio.value)), '["C","D","E"]');
    radios[2].checked = true; radios[2].fire('change');
    assert.equal(state.formatHash, null);
    assert.equal(state.formatPreview, null);
    renderFormatPanel();
    assert.equal(JSON.stringify(world.ids['format-body'].querySelectorAll('input')
      .filter((input) => input.type === 'radio').map((radio) => radio.value)), '["C","D","E"]');
  });

  browserAsyncTest('fmt 96: final review keeps the focused format input node', async () => {
    const world = mountedFormatWorld({webAppFinalReview: {destinationSpreadsheetId: 'dest',
      reconciliation: {files: [], totals: {balanced: true}, problems: []}, rows: [], headers: []}});
    world.ui.state.lastCompletedDestinationSpreadsheetId = 'dest';
    const field = control(world, 'label', '形式 ID').querySelector('input');
    field.focused = true;
    await world.ui.loadFinalReview();
    assert.equal(control(world, 'label', '形式 ID').querySelector('input'), field);
    assert.equal(field.focused, true);
  });

  browserAsyncTest('fmt 97: uncertain save is shown inside the panel and rediagnosed', async () => {
    const world = mountedFormatWorld({webAppSaveFormat: new Error('connection lost'),
      webAppExplainUnknownFile: formatBrowserDiagnosis()});
    const button = control(world, 'button', '保存して有効にする');
    assert.equal(button.disabled, false);
    const pending = button.fire('click')[0];
    world.ids['confirm-submit'].fire('click');
    await pending;
    assert.ok(world.ids['format-body'].textContent.includes('保存できたか確かめられません'));
    assert.ok(world.calls.some((call) => call.name === 'webAppExplainUnknownFile'));
    assert.equal(world.ui.state.formatHash, null);
  });

  test('fmt 98: unreadable sibling is reported after the format is saved', () => {
    const {answers, preview} = auVariantWithSiblings(['auカード__au202510']);
    const original = gas.context.readFile;
    gas.context.readFile = (...args) => {
      if (args[0] === 's0') throw new Error('sibling read failed');
      return original(...args);
    };
    let saved;
    try { saved = gas.call('webAppSaveFormat',
      ['C001', 'card', 'target', answers, preview.previewHash]); }
    finally { gas.context.readFile = original; }
    assert.equal(saved.saved, true);
    assert.equal(saved.readback, 'OK');
    assert.equal(JSON.stringify(saved.siblingsNotRead), '["s0"]');
  });

  browserAsyncTest('fmt 99: changing folders asks before losing a saved result', async () => {
    const world = mountedFormatWorld();
    world.ui.state.formatSaved = {saved: true, formatId: 'paypay_new',
      readback: 'OK', after: {count: 1, total: 100}, siblings: []};
    const pending = world.ui.chooseFolder('other');
    assert.equal(world.ids['confirm-dialog'].open, true);
    world.ids['confirm-cancel'].fire('click');
    await pending;
    assert.equal(world.ui.state.selectedFolderId, 'card');
    assert.equal(world.ui.state.formatSaved.formatId, 'paypay_new');
  });

  test('fmt 100: completed target is absent from the remaining list', () => {
    const world = mountedFormatWorld();
    world.ui.state.formatSaved = {saved: true, formatId: 'paypay_new',
      readback: 'OK', after: {count: 1, total: 100},
      siblings: [{fileId: 's0', fileName: 'sibling', verdict: 'MATCHES_NEW'}]};
    world.ui.state.formatRequeueRemaining = true;
    world.ui.state.formatSelectedIds = ['s0'];
    world.ui.renderFormatPanel();
    assert.ok(!world.ids['format-body'].textContent.includes('PAYPAY detail202502：登録した形式に一致'));
    assert.ok(world.ids['format-body'].textContent.includes('sibling'));
  });

  test('fmt 101: date review entries determine REVIEW_ROWS count', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    const original = gas.context.inferYearsForFile;
    gas.context.inferYearsForFile = (...args) => {
      const result = original(...args);
      result.rowIssues = [{code: 'YEAR_INFERENCE_REVIEW', sourceRow: 2}];
      return result;
    };
    let result;
    try { result = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]); }
    finally { gas.context.inferYearsForFile = original; }
    assert.equal(result.extraction.category.category, 3);
    assert.ok(result.warnings.some((item) => item.code === 'REVIEW_ROWS' && item.detail > 0));
  });

  test('fmt 102: UI checks do not inspect function source text', () => {
    const source = fs.readFileSync(__filename, 'utf8');
    assert.doesNotMatch(source, /clientEval\(['"`]String\(/);
    assert.doesNotMatch(source, /source\.includes\(/);
  });

  test('fmt 103: row and column edits refresh the grid and headings in place', () => {
    const world = mountedFormatWorld();
    const table = world.ids['format-body'].querySelector('table');
    const select = control(world, 'label', '利用日').querySelector('select');
    change(world, '見出し行', 'input', '2');
    assert.equal(world.ids['format-body'].querySelector('table'), table);
    assert.equal(control(world, 'label', '利用日').querySelector('select'), select);
    assert.equal(table.children[2].className, 'format-header');
    assert.ok(select.children[1].textContent.includes('2025/2/1'));
    change(world, '明細の開始行', 'input', '3');
    assert.equal(table.children[3].className, 'format-start');
    assert.ok(select.children[1].textContent.includes('2025/2/2'));
    change(world, '利用日', 'select', 'E');
    assert.ok(table.children[0].textContent.includes('E 利用日'));
    assert.ok(!world.ids['format-body'].textContent.includes('合計 ¥'));
  });

  browserAsyncTest('fmt 104: diagnosis error appears in the scrolled panel', async () => {
    const world = mountedFormatWorld({webAppExplainUnknownFile: new Error('診断失敗')});
    await world.ui.openFormat('target');
    assert.equal(world.ids['format-panel'].scrolled, true);
    assert.ok(world.ids['format-body'].textContent.includes('診断失敗'));
    assert.equal(world.ids.notice.textContent.includes('診断失敗'), false);
    assert.equal(world.ids['format-close'].disabled, false);
  });

  test('fmt 105: optional amount source and customer correction remain available', () => {
    const world = mountedFormatWorld();
    world.ui.state.formatDiagnosis.customerSide = true;
    world.ui.state.formatDiagnosis.nearest = [{formatId: 'base', formatName: '土台'}];
    world.ui.state.formatDiagnosis.purposeGap = {kind: 'PURPOSE_COLUMN_ABSENT'};
    world.ui.state.formatDiagnosis.proposal.columns.amountFallback.source = null;
    world.ui.state.formatRegistrationOpen = true;
    world.ui.renderFormatPanel();
    assert.ok(world.ids['format-body'].textContent.includes('予備金額（なし）'));
    assert.ok(control(world, 'button', '顧客に修正を依頼する'));
    assert.ok(clientEval("formatBlockingMessage('NOT_MATCHING_TARGET',{stage:'MATCH'})")
      .includes('このシートには当たります'));
  });

  browserAsyncTest('fmt 106: import locks the format controls until its reply', async () => {
    const world = mountedFormatWorld({webAppRunImport: {defer: true},
      webAppListFolder: {kind: 'FILES', files: []},
      webAppListReviews: {reviews: [], total: 0, limit: 20}});
    world.ui.state.customers = [{customerId: 'C001', customerName: '顧客一', canImport: true}];
    world.ui.renderSelection();
    const pending = world.ids['import-button'].fire('click')[0];
    assert.equal(world.pending.length, 1);
    assert.equal(control(world, 'label', '形式 ID').querySelector('input').disabled, true);
    assert.equal(world.ids['format-close'].disabled, true);
    world.pending.shift().reply({done: 0, remaining: 0, fileResults: []});
    await pending;
    const field = control(world, 'label', '形式 ID').querySelector('input');
    assert.equal(field.disabled, false);
    assert.equal(field.value, world.ui.state.formatAnswers.formatId);
  });

  browserAsyncTest('fmt 107: uncertain save can withdraw the matching active format', async () => {
    const diagnosis = formatBrowserDiagnosis();
    diagnosis.verdict = 'MATCHES_ACTIVE';
    diagnosis.matched = {formatId: 'paypay_new', formatName: 'PayPay 新'};
    const world = mountedFormatWorld({webAppSaveFormat: new Error('connection lost'),
      webAppExplainUnknownFile: diagnosis, webAppWithdrawFormat: {withdrawn: true},
      webAppListFolder: {kind: 'FILES', files: []},
      webAppListReviews: {reviews: [], total: 0, limit: 20}});
    const pending = control(world, 'button', '保存して有効にする').fire('click')[0];
    world.ids['confirm-submit'].fire('click');
    await pending;
    const withdraw = control(world, 'button', 'この登録を取り消す');
    assert.ok(withdraw);
    const withdrawing = withdraw.fire('click')[0];
    world.ids['confirm-submit'].fire('click');
    await withdrawing;
    assert.equal(world.calls.find((call) => call.name === 'webAppWithdrawFormat').args[1],
      'paypay_new');
  });

  test('fmt 113: an audit exception disables the unverified format', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    const preview = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    const original = gas.context.appendAudit;
    gas.context.appendAudit = (entry) => {
      if (entry.type === 'FORMAT_REGISTER') throw new Error('audit failed after install');
      return original(entry);
    };
    let saved;
    try { saved = gas.call('webAppSaveFormat',
      ['C001', 'card', 'target', answers, preview.previewHash]); }
    finally { gas.context.appendAudit = original; }
    assert.equal(saved.saved, true);
    assert.equal(saved.readback, 'UNCERTAIN');
    assert.equal(saved.formatId, answers.formatId);
    assert.equal(saved.disabled, true);
    const def = gas.call('loadFormatDefinitions', [{formatId: answers.formatId}])[0];
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName(
      gas.evaluate('CONFIG.SHEET_NAMES.CARD_FORMAT_MASTER'));
    assert.equal(sheet.getRange(def._rowNumber, 4).getValue(), false);
    assert.equal(sheet.getRange(def._rowNumber, 24).getValue(), 'READBACK_UNCERTAIN');

    const retry = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    retry.answers.columns.amount = 'E'; retry.answers.columns.purpose = 'L';
    const retryPreview = gas.call('webAppPreviewFormat',
      ['C001', 'card', 'target', retry.answers]);
    const disable = gas.context.disableCardFormat_;
    gas.context.appendAudit = (entry) => {
      if (entry.type === 'FORMAT_REGISTER') throw new Error('audit failed after install');
      return original(entry);
    };
    gas.context.disableCardFormat_ = () => { throw new Error('disable failed'); };
    let failedDisable;
    try { failedDisable = gas.call('webAppSaveFormat',
      ['C001', 'card', 'target', retry.answers, retryPreview.previewHash]); }
    finally { gas.context.appendAudit = original; gas.context.disableCardFormat_ = disable; }
    assert.equal(failedDisable.readback, 'UNCERTAIN');
    assert.equal(failedDisable.disabled, false);
  });

  test('fmt 114: a readback read exception disables the unverified format', () => {
    const {answers} = answersFor('ペイペイカード__PAYPAY_detail202502(0000)');
    answers.columns.amount = 'E'; answers.columns.purpose = 'L';
    const preview = gas.call('webAppPreviewFormat', ['C001', 'card', 'target', answers]);
    const original = gas.context.readRowByNumber_;
    gas.context.readRowByNumber_ = () => { throw new Error('readback failed'); };
    let saved;
    try { saved = gas.call('webAppSaveFormat',
      ['C001', 'card', 'target', answers, preview.previewHash]); }
    finally { gas.context.readRowByNumber_ = original; }
    assert.equal(saved.readback, 'UNCERTAIN');
    assert.equal(saved.disabled, true);
    assert.equal(gas.call('loadFormatDefinitions', [{formatId: answers.formatId}])[0].enabled, false);
  });

  test('fmt 115: a sibling listing exception keeps the verified format active', () => {
    const {answers, preview} = auVariantWithSiblings(['auカード__au202510']);
    const install = gas.context.installCardFormat;
    const open = gas.context.openReviews;
    let installed = false;
    gas.context.installCardFormat = function(...args) {
      const result = install(...args);
      installed = true;
      return result;
    };
    gas.context.openReviews = function(...args) {
      if (installed) throw new Error('siblings unavailable');
      return open(...args);
    };
    let saved;
    try { saved = gas.call('webAppSaveFormat',
      ['C001', 'card', 'target', answers, preview.previewHash]); }
    finally { gas.context.installCardFormat = install; gas.context.openReviews = open; }
    assert.equal(saved.readback, 'OK');
    assert.equal(saved.siblingsError, true);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.siblings)), []);
    assert.equal(gas.call('loadFormatDefinitions', [{formatId: answers.formatId}])[0].enabled, true);
  });

  test('fmt 116: saved uncertainty actions and sibling warning follow the result', () => {
    const world = mountedFormatWorld();
    const saved = {saved: true, formatId: 'paypay_new', version: 1,
      readback: 'UNCERTAIN', disabled: true};
    world.ui.state.formatSaved = saved;
    world.ui.renderFormatPanel();
    assert.match(world.ids['format-body'].textContent, /安全のため無効にしました/);
    assert.equal(control(world, 'button', 'この登録を取り消す'), undefined);
    saved.disabled = false;
    world.ui.renderFormatPanel();
    assert.match(world.ids['format-body'].textContent, /無効にもできませんでした/);
    assert.ok(control(world, 'button', 'この登録を取り消す'));
    world.ui.state.formatSaved = {saved: true, formatId: 'paypay_new', readback: 'OK',
      after: {count: 1, total: 100}, siblings: [], siblingsError: true};
    world.ui.renderFormatPanel();
    assert.match(world.ids['format-body'].textContent,
      /同じフォルダのファイルを確かめられませんでした/);
  });

  test('fmt 108: blur does not replace an unchanged acknowledgement control', () => {
    const world = mountedFormatWorld();
    world.ui.state.formatAnswers.acknowledgements.amountChoice = false;
    world.ui.renderFormatPanel();
    const field = control(world, 'label', '形式 ID').querySelector('input');
    const currentCheck = control(world, 'label', '金額の列を確認した').querySelector('input');
    field.focus(); field.value = 'paypay_new_2'; field.fire('input');
    currentCheck.focus();
    assert.equal(world.document.activeElement, currentCheck);
    assert.ok(control(world, 'label', '金額の列を確認した').querySelector('input') === currentCheck);
    currentCheck.checked = true; currentCheck.fire('change');
    assert.equal(world.ui.state.formatAnswers.acknowledgements.amountChoice, true);
  });

  test('fmt 109: saved purpose correction cannot discard the withdrawal action', () => {
    const world = mountedFormatWorld();
    const state = world.ui.state;
    state.formatDiagnosis.customerSide = true;
    state.formatDiagnosis.nearest = [{formatId: 'base', formatName: '土台'}];
    state.formatDiagnosis.purposeGap = {kind: 'PURPOSE_COLUMN_ABSENT'};
    state.formatRegistrationOpen = true;
    state.formatSaved = {saved: true, formatId: 'paypay_new', readback: 'OK',
      after: {count: 1, total: 100}, siblings: []};
    world.ui.renderFormatPanel();
    const button = control(world, 'button', '顧客に修正を依頼する');
    assert.ok(!button || button.disabled);
    world.ui.returnFormatToCustomer();
    assert.ok(!world.calls.some((call) => call.name === 'webAppReturnFileToCustomer'));
    assert.ok(control(world, 'button', 'この登録を取り消す'));
  });

  test('fmt 110: a failed middle requeue leaves later files actionable', () => {
    const {answers, preview} = auVariantWithSiblings([
      'auカード__au202510', 'auカード__au202510']);
    assert.equal(gas.call('webAppSaveFormat',
      ['C001', 'card', 'target', answers, preview.previewHash]).readback, 'OK');
    for (const id of ['target', 's0', 's1']) seedWaiting(id, id);
    const original = gas.context.resolveFileReview;
    gas.context.resolveFileReview = (...args) => {
      if (args[0] === gas.call('openReviews', [{fileId: 's0'}])[0].reviewId)
        throw new Error('middle file failed');
      return original(...args);
    };
    let result;
    try { result = gas.call('webAppRequeueFormatFiles',
      ['C001', 'card', ['target', 's0', 's1']]); }
    finally { gas.context.resolveFileReview = original; }
    assert.deepEqual(JSON.parse(JSON.stringify(result.requeued.map((item) => item.fileId))),
      ['target', 's1']);
    assert.deepEqual(JSON.parse(JSON.stringify(result.skipped)),
      [{fileId: 's0', code: 'REQUEUE_FAILED'}]);
  });

  browserAsyncTest('fmt 111: requeue exception appears in panel and refreshes lists', async () => {
    const world = mountedFormatWorld({webAppRequeueFormatFiles: new Error('requeue failed'),
      webAppListFolder: {kind: 'FILES', files: []},
      webAppListReviews: {reviews: [], total: 0, limit: 20}});
    world.ui.state.formatSaved = {saved: true, formatId: 'paypay_new',
      readback: 'OK', after: {count: 1, total: 100}, siblings: []};
    world.ui.state.formatSelectedIds = ['target'];
    world.ui.renderFormatPanel();
    const pending = control(world, 'button', '取込待ちに戻す').fire('click')[0];
    world.ids['confirm-submit'].fire('click');
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(world.ids['format-body'].textContent.includes('requeue failed'),
      world.ids['format-body'].textContent);
    assert.ok(world.calls.some((call) => call.name === 'webAppListFolder'));
    assert.ok(world.calls.some((call) => call.name === 'webAppListReviews'));
  });

  browserAsyncTest('fmt 112: rejected format calls restore the import action', async () => {
    const rejected = {ok: false, code: 'NOT_FORMAT_UNKNOWN'};
    const replies = {webAppPreviewFormat: rejected, webAppSaveFormat: rejected,
      webAppReturnFileToCustomer: rejected, webAppListFolder: {kind: 'FILES', files: []},
      webAppListReviews: {reviews: [], total: 0, limit: 20}};
    for (const operation of ['previewFormat', 'saveFormat', 'returnFormatToCustomer']) {
      const world = mountedFormatWorld(replies);
      world.ui.state.customers = [{customerId: 'C001', customerName: '顧客一', canImport: true}];
      if (operation === 'returnFormatToCustomer') {
        world.ui.state.formatDiagnosis.purposeGap = {kind: 'PURPOSE_COLUMN_ABSENT'};
      }
      const pending = world.ui[operation]();
      if (operation !== 'previewFormat') world.ids['confirm-submit'].fire('click');
      await pending;
      assert.equal(world.ids['import-button'].disabled, false, operation);
      assert.equal(world.ui.state.formatBusy, false, operation);
    }
  });

  test('fmt 72: editing an answer clears the preview hash', () => {
    assert.equal(clientEval("(state.formatPreview={previewHash:'old'},state.formatHash='old',invalidateFormatPreview(),state.formatHash)"), null);
  });

  test('fmt 73: customer correction precedes registration for purpose gaps', () => {
    assert.deepEqual(clientEval('formatActionOrder(true)'),
      ['RETURN_TO_CUSTOMER', 'REGISTER_FORMAT']);
  });

  test('fmt 51: menu choices remain unchanged', () => {
    setup();
    assert.deepEqual(JSON.parse(JSON.stringify(gas.call('availableFileResolveOperations',
      ['FORMAT_UNKNOWN']))), ['REGISTER_FORMAT', 'CANCEL_FILE', 'RETURN_TO_CUSTOMER']);
    assert.equal(gas.evaluate("MENU_RESOLVE_OPERATIONS_.RETURN_TO_CUSTOMER"), undefined);
  });
};

if (require.main === module && process.argv[2] === '--browser-case') {
  const {GasHarness} = require('./gas-harness');
  const assert = require('node:assert/strict');
  const gas = new GasHarness(); gas.loadProject();
  const cases = [];
  module.exports({test: (name, fn) => {
    if (name === process.argv[3]) cases.push({name, fn});
  }, assert, gas});
  Promise.resolve().then(() => cases[0].fn()).then(() => {
    console.log('CASE_DONE');
  }).catch((error) => {
    console.error(error && error.stack || error); process.exitCode = 1;
  });
}

'use strict';

/**
 * 雛形の写しの「取引先一覧」タブを、マスターと照らしてから空にする
 * （`work/spec_template_partner_list.md` 版 1.0）。仕様 §7 の tpl 1〜9。
 * 値はすべて架空。本番の ID・店名・人名は書かない。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const OWNER = 'owner@example.invalid';
  const MASTER = 'rr-tpl-master-fake';
  const ORIGINAL = 'rr-tpl-original-fake';
  const TEMPLATE = 'rr-tpl-template-fake';
  const INPUT = '架空入力';
  const PARTNER = '取引先一覧';
  const OTHER = '架空別タブ';
  const PROFILE_KEY = 'CUSTOMER_TEMPLATE_PROFILE_INDIVIDUAL';
  const REASON = 'CLEAR_TEMPLATE_PARTNER_LIST';
  const SOURCE_ID = 'TEST01';

  function masterSheet(name) {
    return gas.stubs.getSpreadsheet(MASTER).getSheetByName(name);
  }
  function audit() { return masterSheet('監査ログ'); }
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
  function blank(length) { return Array(length).fill(''); }

  function templateSheet() { return gas.stubs.getSpreadsheet(TEMPLATE).getSheetByName(PARTNER); }
  function originalSheet() { return gas.stubs.getSpreadsheet(ORIGINAL).getSheetByName(PARTNER); }
  function otherSheet() { return gas.stubs.getSpreadsheet(TEMPLATE).getSheetByName(OTHER); }

  function headerValues(sheet) {
    return plain(sheet.getRange(1, 1, 1, sheet.getMaxColumns()).getValues());
  }
  function rangeEmpty(sheet, fromRow, toRow, columns) {
    if (toRow < fromRow) return true;
    return sheet.getRange(fromRow, 1, toRow - fromRow + 1, columns).getValues()
      .every((row) => row.every((value) => value === '' || value === null));
  }

  const MASTER_TABS = ['顧客マスター', '共通取引先一覧', '共通取引先辞書',
    '顧客別取引先辞書', '顧客別取引先一覧'];

  function masterSnapshot() {
    return MASTER_TABS.map((name) => [name,
      plain(masterSheet(name).getDataRange().getValues())]);
  }

  function createBook(id, name, partnerRows, otherValues) {
    return gas.stubs.createSpreadsheet(id, {name: name, sheets: [
      {name: INPUT, values: [['', '利用日', '取引先', '摘要', '金額', 'メモ', '内部ID', '税区分']]},
      {name: PARTNER, values: [['元表記', '取引先名', '照合キー']].concat(partnerRows || [])},
      {name: OTHER, values: otherValues || [['別タブの値']]}
    ]});
  }

  function addDictionary(common, spec) {
    const row = blank(18);
    row[0] = spec.dictId || ('rr-tpl-dict-' + (spec.sequence || 1));
    row[1] = spec.original || spec.normalized || '';
    row[2] = spec.normalized || '';
    row[3] = spec.partnerName || '';
    row[4] = 'EXACT';
    row[5] = 1;
    row[6] = spec.customerId || '';
    row[9] = true;
    row[10] = OWNER;
    row[12] = '2026-01-01T00:00:00+09:00';
    row[13] = 1;
    row[14] = spec.active !== false;
    row[15] = spec.conflict === true;
    masterSheet(common ? '共通取引先辞書' : '顧客別取引先辞書').appendRow(row);
  }

  let listSequence = 0;
  function addCommonPartner(name) {
    listSequence += 1;
    masterSheet('共通取引先一覧').appendRow(['rr-tpl-common-' + listSequence, name, 'ACTIVE', '', '', '']);
  }
  function addCustomerPartner(name, state, canonical, customerId) {
    listSequence += 1;
    masterSheet('顧客別取引先一覧').appendRow(['rr-tpl-name-' + listSequence,
      customerId || SOURCE_ID, name, state || 'ACTIVE', canonical || '', '', OWNER,
      '2026-01-01T00:00:00+09:00', OWNER, '2026-01-01T00:00:00+09:00']);
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
    gas.evaluate("SETTINGS.SAMPLE_CORPUS_FOLDER_ID='';SETTINGS.FAULT_INJECTION=null;");
    createBook(ORIGINAL, '架空元雛形', opts.originalRows || [['元の店', '元の取引先']],
      [['元の別タブ']]);
    createBook(TEMPLATE, opts.templateName || '雛形（個人）', opts.rows || [],
      opts.otherValues || [['別タブの値']]);
    gas.call('registerTestCustomer', [{
      customerId: SOURCE_ID, customerName: '架空　元　顧客',
      sourceFolderId: 'rr-tpl-source-folder-fake',
      destinationSpreadsheetId: ORIGINAL, destinationSheetName: INPUT,
      partnerListSheetName: PARTNER,
      columns: {B: 2, F: 3, I: 4, K: 5, M: 6, txId: 7},
      headerRow: 1, rowScanLastColumn: 8, customerCategory: 'INDIVIDUAL', fiscalYear: 2026
    }]);
    const rows = gas.call('registrationMasterRows_');
    const source = rows.filter((row) => String(row.values[0]) === SOURCE_ID)[0];
    const profile = plain(gas.call('registrationProfileFromRow_',
      [source.values, TEMPLATE, SOURCE_ID]));
    if (opts.profileMutate) opts.profileMutate(profile);
    if (opts.profileMode === 'empty') {
      props().deleteProperty(PROFILE_KEY);
    } else if (opts.profileMode === 'raw') {
      props().setProperty(PROFILE_KEY, opts.profileRaw);
    } else {
      props().setProperty(PROFILE_KEY, JSON.stringify(profile));
    }
    (opts.commonDict || []).forEach((spec) => addDictionary(true, spec));
    (opts.sourceDict || []).forEach((spec) => addDictionary(false, spec));
    (opts.commonList || []).forEach((name) => addCommonPartner(name));
    (opts.sourceList || []).forEach((spec) => addCustomerPartner(spec.name, spec.state,
      spec.canonical, spec.customerId));
    const world = {sourceRowNumber: source.rowNumber, profile: profile};
    world.beforeTab = plain(templateSheet().getDataRange().getValues());
    world.beforeHeader = headerValues(templateSheet());
    world.beforeOther = plain(otherSheet().getDataRange().getValues());
    world.beforeOriginal = plain(originalSheet().getDataRange().getValues());
    world.beforeMaster = masterSnapshot();
    world.auditBefore = auditRows().length;
    gas.stubs.resetApiCallCounts();
    gas.stubs.resetPropertyCallCounts();
    gas.stubs.resetDriveOps();
    gas.stubs.clearLogs();
    return world;
  }

  function check(apply, accept) {
    if (arguments.length >= 2) return plainCall('opsCheckTemplatePartnerList', [apply, accept]);
    if (arguments.length === 1) return plainCall('opsCheckTemplatePartnerList', [apply]);
    return plainCall('opsCheckTemplatePartnerList');
  }

  function assertNoWrites(world, label) {
    assert.deepEqual(plain(templateSheet().getDataRange().getValues()), world.beforeTab,
      '取引先一覧タブが変わっている: ' + label);
    assert.deepEqual(headerValues(templateSheet()), world.beforeHeader,
      '見出しが変わっている: ' + label);
    assert.deepEqual(plain(otherSheet().getDataRange().getValues()), world.beforeOther,
      '他のタブが変わっている: ' + label);
    assert.deepEqual(plain(originalSheet().getDataRange().getValues()), world.beforeOriginal,
      '元の雛形が変わっている: ' + label);
    assert.deepEqual(masterSnapshot(), world.beforeMaster,
      'マスターが変わっている: ' + label);
    assert.equal(auditRows().length, world.auditBefore, '監査が増えている: ' + label);
    assert.equal(gas.stubs.getDriveWrites().length, 0, 'Drive に書いている: ' + label);
    assert.equal(gas.stubs.getPropertyWrites().length, 0, 'プロパティに書いている: ' + label);
  }

  function goodWorld(rows) {
    return setup({
      rows: rows || [['架空店A', '取引先A']],
      commonDict: [{normalized: '架空店A', partnerName: '取引先A'}],
      commonList: ['取引先A']
    });
  }

  // tpl 1: 見るだけ（S1）
  test('tpl 1: dry runs write nothing and report every category with samples', () => {
    const world = setup({
      rows: [
        ['架空店A', '取引先A'],
        ['架空店B', '取引先B'],
        ['架空店C', '取引先C'],
        ['架空店D', '取引先D'],
        ['架空店E', '取引先E'],
        ['架空店F', '旧名F'],
        ['架空店G', '取引先G'],
        ['架空店H', '取引先H']
      ],
      commonDict: [
        {normalized: '架空店A', partnerName: '取引先A'},
        {normalized: '架空店B', partnerName: '取引先B', conflict: true},
        {normalized: '架空店D', partnerName: '架空別取引先'},
        {normalized: '架空店F', partnerName: '新名F'},
        {normalized: '架空店G', partnerName: '取引先G'},
        {normalized: '架空店H', partnerName: '取引先H'}
      ],
      sourceDict: [{normalized: '架空店C', partnerName: '取引先C', customerId: SOURCE_ID}],
      commonList: ['取引先A', '取引先B', '取引先C', '取引先D', '新名F', '取引先H'],
      sourceList: [
        {name: '旧名F', state: 'RETIRED', canonical: '新名F'},
        {name: '取引先E', state: 'ACTIVE'},
        {name: '取引先Z', state: 'ACTIVE', customerId: 'K9002'}
      ]
    });
    [() => check(), () => check(false, []), () => check('true', [])].forEach((run, index) => {
      const report = run();
      assert.equal(report.applied, false, 'applied ' + index);
      assert.equal(report.stoppedBy, null, 'stoppedBy ' + index);
      assert.equal(report.ok, false, 'ok ' + index);
      assert.equal(report.cleared, 0, 'cleared ' + index);
      assert.equal(report.template.name, '雛形（個人）');
      assert.equal(report.template.tabName, PARTNER);
      assert.equal(report.template.lastRow, 9);
      assert.deepEqual(report.rows, {dataRows: 8, usableRows: 8, halfRows: 0, duplicateRows: 0});
      assert.deepEqual(report.dictionary, {inCommon: 5, inCommonConflicted: 1,
        DICT_ONLY_SOURCE: 1, DICT_DIFFERENT_PARTNER: 1, DICT_MISSING: 1});
      assert.deepEqual(report.partnerNames, {distinct: 8, inCommonList: 5, viaCanonical: 1,
        NAME_ONLY_SOURCE: 1, NAME_MISSING: 1});
      assert.deepEqual(report.samples.DICT_ONLY_SOURCE,
        [{row: 4, original: '架空店C', partnerName: '取引先C'}]);
      assert.deepEqual(report.samples.DICT_DIFFERENT_PARTNER,
        [{row: 5, original: '架空店D', partnerName: '取引先D', masterPartners: ['架空別取引先']}]);
      assert.deepEqual(report.samples.DICT_MISSING,
        [{row: 6, original: '架空店E', partnerName: '取引先E'}]);
      assert.deepEqual(report.samples.NAME_ONLY_SOURCE,
        [{row: 6, original: '架空店E', partnerName: '取引先E'}]);
      assert.deepEqual(report.samples.NAME_MISSING,
        [{row: 8, original: '架空店G', partnerName: '取引先G'}]);
      const text = JSON.stringify(report);
      [MASTER, ORIGINAL, TEMPLATE].forEach((id) => assert.equal(text.indexOf(id), -1, id));
      assertNoWrites(world, 'dry ' + index);
    });
  });

  // tpl 2: apply（S2・S4）
  test('tpl 2: apply clears only the partner tab values after the audit', () => {
    const world = setup({
      rows: [
        ['架空店A', '取引先A'],
        ['架空店B', '取引先B'],
        ['架空店C', '旧名C']
      ],
      commonDict: [
        {normalized: '架空店A', partnerName: '取引先A'},
        {normalized: '架空店B', partnerName: '取引先B'},
        {normalized: '架空店C', partnerName: '新名C'}
      ],
      commonList: ['取引先A', '取引先B', '新名C'],
      sourceList: [{name: '旧名C', state: 'RETIRED', canonical: '新名C'}]
    });
    let valuesAtAudit = null;
    const realAudit = gas.context.appendAudit;
    gas.context.appendAudit = function(entry) {
      valuesAtAudit = plain(templateSheet().getRange(2, 1, 3, 3).getValues());
      return realAudit(entry);
    };
    let report;
    try {
      report = check(true);
    } finally {
      gas.context.appendAudit = realAudit;
    }
    assert.equal(report.applied, true);
    assert.equal(report.stoppedBy, null);
    assert.equal(report.ok, true);
    assert.equal(report.cleared, 3);
    assert.deepEqual(report.dictionary, {inCommon: 3, inCommonConflicted: 0,
      DICT_ONLY_SOURCE: 0, DICT_DIFFERENT_PARTNER: 0, DICT_MISSING: 0});
    assert.deepEqual(report.partnerNames, {distinct: 3, inCommonList: 2, viaCanonical: 1,
      NAME_ONLY_SOURCE: 0, NAME_MISSING: 0});
    assert.deepEqual(valuesAtAudit, [['架空店A', '取引先A', ''], ['架空店B', '取引先B', ''],
      ['架空店C', '旧名C', '']], '監査は消すより先');
    const sheet = templateSheet();
    assert.deepEqual(headerValues(sheet), world.beforeHeader, '1 行目は同じ');
    assert.equal(rangeEmpty(sheet, 2, 4, sheet.getMaxColumns()), true, '2 行目から下が空');
    assert.deepEqual(plain(otherSheet().getDataRange().getValues()), world.beforeOther);
    assert.deepEqual(plain(originalSheet().getDataRange().getValues()), world.beforeOriginal);
    assert.deepEqual(masterSnapshot(), world.beforeMaster);
    const setting = auditOf('SETTING').filter((row) => String(row[11]) === REASON);
    assert.equal(setting.length, 1);
    assert.equal(String(setting[0][6]), 'TEMPLATE');
    assert.equal(String(setting[0][7]), TEMPLATE);
    assert.equal(setting[0][9], '');
    assert.deepEqual(JSON.parse(String(setting[0][10])),
      {tab: PARTNER, rowsCleared: 3, accept: []});
    const text = JSON.stringify(setting);
    ['架空店A', '取引先A', '架空店B', '取引先B', '旧名C', '新名C'].forEach((name) => {
      assert.equal(text.indexOf(name), -1, '監査に名前を書いている: ' + name);
    });
    assert.equal(gas.stubs.getDriveWrites().length, 0);
    assert.equal(gas.stubs.getPropertyWrites().length, 0);
  });

  function stopCase(code) {
    if (code === 'DICT_ONLY_SOURCE') {
      return {rows: [['架空店C', '取引先C']],
        sourceDict: [{normalized: '架空店C', partnerName: '取引先C', customerId: SOURCE_ID}],
        commonList: ['取引先C']};
    }
    if (code === 'DICT_DIFFERENT_PARTNER') {
      return {rows: [['架空店D', '取引先D']],
        commonDict: [{normalized: '架空店D', partnerName: '架空別取引先'}],
        commonList: ['取引先D']};
    }
    if (code === 'DICT_MISSING') {
      return {rows: [['架空店E', '取引先E']], commonList: ['取引先E']};
    }
    if (code === 'NAME_ONLY_SOURCE') {
      return {rows: [['架空店A', '取引先A']],
        commonDict: [{normalized: '架空店A', partnerName: '取引先A'}],
        sourceList: [{name: '取引先A', state: 'ACTIVE'}]};
    }
    return {rows: [['架空店A', '取引先A']],
      commonDict: [{normalized: '架空店A', partnerName: '取引先A'}]};
  }

  function counterOf(report, code) {
    if (Object.prototype.hasOwnProperty.call(report.dictionary, code)) return report.dictionary[code];
    return report.partnerNames[code];
  }

  // tpl 3: 止める分類と accept（S3）
  test('tpl 3: every stopping category needs accept before anything is cleared', () => {
    ['DICT_ONLY_SOURCE', 'DICT_DIFFERENT_PARTNER', 'DICT_MISSING',
      'NAME_ONLY_SOURCE', 'NAME_MISSING'].forEach((code) => {
      let world = setup(stopCase(code));
      let report = check(true);
      assert.equal(report.stoppedBy, 'NOT_IN_MASTER', code);
      assert.equal(report.applied, false, code);
      assert.equal(report.cleared, 0, code);
      assert.equal(report.ok, false, code);
      assert.equal(counterOf(report, code), 1, code);
      assertNoWrites(world, code);

      world = setup(stopCase(code));
      report = check(true, [code]);
      assert.equal(report.stoppedBy, null, code + ' accepted');
      assert.equal(report.applied, true, code + ' accepted');
      assert.equal(report.cleared, 1, code + ' accepted');
      assert.equal(rangeEmpty(templateSheet(), 2, 2, templateSheet().getMaxColumns()), true);
      assert.equal(gas.stubs.getDriveWrites().length, 0);
    });

    const twoStops = {
      rows: [['架空店E', '取引先E'], ['架空店A', '取引先A']],
      commonDict: [{normalized: '架空店A', partnerName: '取引先A'}],
      commonList: ['取引先A']
    };
    const world = setup(twoStops);
    const report = check(true, ['DICT_MISSING']);
    assert.equal(report.stoppedBy, 'NOT_IN_MASTER');
    assert.equal(report.dictionary.DICT_MISSING, 1);
    assert.equal(report.partnerNames.NAME_MISSING, 1);
    assertNoWrites(world, 'two stops');
  });

  // tpl 4: halfRows・duplicateRows
  test('tpl 4: half and duplicate rows are counted but never stop', () => {
    const world = setup({
      rows: [
        ['架空店A', '取引先A'],
        ['片方だけ', ''],
        ['', '取引先だけ'],
        ['', ''],
        ['\u0001', '取引先X'],
        ['架空店A', '取引先A'],
        ['架空店A', '取引先A']
      ],
      commonDict: [{normalized: '架空店A', partnerName: '取引先A'}],
      commonList: ['取引先A']
    });
    const report = check(true);
    assert.equal(report.stoppedBy, null);
    assert.equal(report.applied, true);
    assert.deepEqual(report.rows, {dataRows: 7, usableRows: 3, halfRows: 4, duplicateRows: 2});
    assert.equal(report.dictionary.inCommon, 1);
    assert.equal(report.partnerNames.distinct, 1);
    assert.equal(report.cleared, 7);
    assert.equal(rangeEmpty(templateSheet(), 2, 8, templateSheet().getMaxColumns()), true);
  });

  // tpl 5: 対象の確かめ（PROFILE_INVALID・CONFLICT・TAB_MISSING・BAD_ACCEPT）
  test('tpl 5: invalid targets and unknown accept codes write nothing', () => {
    let world = setup({profileMode: 'empty'});
    assert.equal(check(true).stoppedBy, 'PROFILE_INVALID');
    assertNoWrites(world, 'profile empty');

    world = setup({profileMode: 'raw', profileRaw: '{not json'});
    assert.equal(check(true).stoppedBy, 'PROFILE_INVALID');
    assertNoWrites(world, 'profile broken');

    world = goodWorld();
    gas.stubs.getSpreadsheet(ORIGINAL).name = '雛形（個人）';
    const sameAsSource = plain(world.profile);
    sameAsSource.templateId = ORIGINAL;
    props().setProperty(PROFILE_KEY, JSON.stringify(sameAsSource));
    gas.stubs.resetPropertyCallCounts();
    assert.equal(check(true).stoppedBy, 'CONFLICT');
    assertNoWrites(world, 'same as TEST01 F');

    world = goodWorld();
    const extra = blank(45);
    extra[0] = SOURCE_ID;
    masterSheet('顧客マスター').appendRow(extra);
    world.beforeMaster = masterSnapshot();
    assert.equal(check(true).stoppedBy, 'CONFLICT');
    assertNoWrites(world, 'two source rows');

    world = goodWorld();
    createBook('rr-tpl-alternate-fake', '架空別名', [['架空店A', '取引先A']], [['別']]);
    const alternate = plain(world.profile);
    alternate.templateId = 'rr-tpl-alternate-fake';
    props().setProperty(PROFILE_KEY, JSON.stringify(alternate));
    gas.stubs.resetPropertyCallCounts();
    world.beforeTab = plain(templateSheet().getDataRange().getValues());
    world.beforeHeader = headerValues(templateSheet());
    assert.equal(check(true).stoppedBy, 'CONFLICT');
    assertNoWrites(world, 'different name');

    world = setup({profileMutate: (profile) => { profile.columns.I = '無いタブ'; }});
    assert.equal(check(true).stoppedBy, 'TAB_MISSING');
    assertNoWrites(world, 'tab missing');

    world = goodWorld();
    assert.equal(check(true, ['UNKNOWN']).stoppedBy, 'BAD_ACCEPT');
    assertNoWrites(world, 'bad accept');
    assert.equal(check(true, 'DICT_MISSING').stoppedBy, 'BAD_ACCEPT');
    assertNoWrites(world, 'bad accept type');
  });

  // tpl 6: 2 回目（S6）
  test('tpl 6: a second apply is ALREADY_EMPTY without audit or write', () => {
    const world = setup({
      rows: [['架空店A', '取引先A'], ['架空店B', '取引先B']],
      commonDict: [{normalized: '架空店A', partnerName: '取引先A'},
        {normalized: '架空店B', partnerName: '取引先B'}],
      commonList: ['取引先A', '取引先B']
    });
    const first = check(true);
    assert.equal(first.applied, true);
    assert.equal(first.cleared, 2);
    const auditsAfterFirst = auditOf('SETTING').filter((row) => String(row[11]) === REASON).length;
    const beforeSecond = plain(templateSheet().getDataRange().getValues());
    const headerBefore = headerValues(templateSheet());
    const second = check(true);
    assert.equal(second.stoppedBy, 'ALREADY_EMPTY');
    assert.equal(second.applied, false);
    assert.equal(second.cleared, 0);
    assert.equal(second.rows.dataRows, 0);
    assert.equal(auditOf('SETTING').filter((row) => String(row[11]) === REASON).length,
      auditsAfterFirst);
    assert.deepEqual(plain(templateSheet().getDataRange().getValues()), beforeSecond);
    assert.deepEqual(headerValues(templateSheet()), headerBefore);
    assert.equal(gas.stubs.getDriveWrites().length, 0);
    assert.equal(gas.stubs.getPropertyWrites().length, 0);
  });

  // tpl 7: 読み返し（S5）
  test('tpl 7: a clearContent that does nothing is WRITE_VERIFY_FAILED', () => {
    const world = goodWorld();
    gas.stubs.setClearContentIgnored(true);
    let report;
    try {
      report = check(true);
    } finally {
      gas.stubs.setClearContentIgnored(false);
    }
    assert.equal(report.stoppedBy, 'WRITE_VERIFY_FAILED');
    assert.equal(report.applied, false);
    assert.equal(report.cleared, 0);
    assert.deepEqual(plain(templateSheet().getDataRange().getValues()), world.beforeTab);
    assert.equal(auditOf('SETTING').filter((row) => String(row[11]) === REASON).length, 1);
  });

  // tpl 8: active: false の辞書行（§2.3）
  test('tpl 8: inactive dictionary rows are ignored', () => {
    const world = setup({
      rows: [['架空店A', '取引先A']],
      commonDict: [{normalized: '架空店A', partnerName: '取引先A', active: false}],
      commonList: ['取引先A']
    });
    const report = check(true);
    assert.equal(report.dictionary.inCommon, 0);
    assert.equal(report.dictionary.DICT_MISSING, 1);
    assert.equal(report.stoppedBy, 'NOT_IN_MASTER');
    assertNoWrites(world, 'inactive dictionary');
  });

  // tpl 9: 名前の比べ方（partnerNameKey_）
  test('tpl 9: hiragana and small kana compare equal for partner names', () => {
    const world = setup({
      rows: [['架空店A', 'かふぇ']],
      commonDict: [{normalized: '架空店A', partnerName: 'カフェ'}],
      commonList: ['カフェ']
    });
    const report = check(true);
    assert.equal(report.dictionary.inCommon, 1);
    assert.equal(report.partnerNames.inCommonList, 1);
    assert.equal(report.ok, true);
    assert.equal(report.applied, true);
    assert.equal(report.cleared, 1);
    assert.equal(rangeEmpty(templateSheet(), 2, 2, templateSheet().getMaxColumns()), true);
  });
};

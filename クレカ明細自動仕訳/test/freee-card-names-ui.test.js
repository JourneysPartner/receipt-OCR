'use strict';

/**
 * 「設定」の「freee のカード名」の画面（仕様 §4.1〜§4.9・§6.2 の fcnu 1〜14）。
 * 値はすべて架空。本番の ID・名前は書かない。
 */
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {browserWorld} = require('./kw26-ui-helpers');
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 24; i += 1) await Promise.resolve(); };

module.exports = ({test, assert}) => {
  function asyncTest(name, fn) {
    if (process.argv[2] === '--case') { if (process.argv[3] === name) test(name, fn); }
    else test(name, () => assert.match(execFileSync(process.execPath, [__filename, '--case', name],
      {encoding: 'utf8', timeout: 30000}), /^CASE_DONE$/m));
  }

  const BOOTSTRAP = {
    actor: 'owner@example.invalid',
    isOwner: true,
    customers: [
      {customerId: 'K9001', customerName: '架空 太郎', canImport: true},
      {customerId: 'K9002', customerName: '架空 花子', canImport: true}
    ],
    importLanes: 1,
    maxFilesPerImport: 6,
    version: 'v-fake'
  };

  const REG_START = {
    ready: true,
    missing: [],
    categories: [{key: 'INDIVIDUAL', label: '個人', enabled: true},
      {key: 'CORPORATE', label: '法人', enabled: false}],
    customerFolders: [
      {folderId: 'reg-folder-1', folderName: '【代※現金シート】架空 太郎',
        displayName: '架空 太郎', registered: false}
    ]
  };

  const REG_READY = {
    status: 'READY',
    path: ['☆資料共有フォルダ', '令和8年分', '経費', 'クレジットカード支払い分'],
    statementFolderId: 'stmt-1',
    yearFolderId: 'year-1',
    reiwaYear: 8,
    fiscalYear: 2026,
    cardFolders: ['テストカード'],
    proposedName: '架空 太郎',
    nameProblem: null,
    folderProblem: null,
    contract: {
      status: 'MATCHED',
      tabName: 'R8.契約内容',
      matchedCustomerId: 'K9001',
      entries: [{customerId: 'K9001', name: '架空 太郎', usable: true, problem: null}]
    }
  };

  const REG_SUCCESS = {
    ok: true, customerId: 'K9001', customerName: '架空 太郎',
    rowNumber: 3, alreadyRegistered: false
  };

  function startReply(overrides) {
    return Object.assign({
      ok: true,
      customerId: 'K9001',
      customerName: '架空 太郎',
      csv: {
        fileName: '勘定科目.csv',
        uploadedAt: '2026-11-15T10:00:00+09:00',
        uploadedBy: 'owner@example.invalid',
        accountCount: 5,
        candidateCount: 3
      },
      candidates: ['架空カードA', 'テストカード', 'visaカード'],
      folders: [
        {folderId: 'f-test', folderName: 'テストカード',
          savedAccountName: '架空カードA', savedValid: true, suggestion: null},
        {folderId: 'f-a', folderName: '架空カードA',
          savedAccountName: null, savedValid: false, suggestion: '架空カードA'},
        {folderId: 'f-b', folderName: '架空カードB',
          savedAccountName: '架空経費', savedValid: false, suggestion: null}
      ],
      orphans: [{folderName: '架空カードZ', accountName: 'テストカード', valid: true}],
      version: 3
    }, overrides || {});
  }

  function cleanReply(overrides) {
    return startReply(Object.assign({
      folders: [
        {folderId: 'f-test', folderName: 'テストカード',
          savedAccountName: '架空カードA', savedValid: true, suggestion: null},
        {folderId: 'f-a', folderName: '架空カードA',
          savedAccountName: 'テストカード', savedValid: true, suggestion: null}
      ],
      orphans: []
    }, overrides || {}));
  }

  const UPLOAD_OK = {
    ok: true,
    version: 4,
    csv: {fileName: '勘定科目.csv', uploadedAt: '2026-11-15T10:05:00+09:00',
      uploadedBy: 'owner@example.invalid', accountCount: 5, candidateCount: 3},
    invalidMappings: [{folderName: '架空カードB', accountName: '架空経費'}]
  };

  function world(extra) {
    const responses = Object.assign({
      webAppBootstrap: plain(BOOTSTRAP),
      webAppRegistrationStart: plain(REG_START),
      webAppRegistrationInspect: plain(REG_READY),
      webAppRegisterCustomer: plain(REG_SUCCESS),
      webAppFreeeCardNamesStart: plain(startReply()),
      webAppFreeeCardNamesUploadCsv: plain(UPLOAD_OK),
      webAppFreeeCardNamesSave: plain({ok: true, changed: 1, version: 4}),
      webAppListFolder: {kind: 'FILES', files: []},
      webAppListDestinations: {destinations: []},
      webAppListReviews: {reviews: [], partnerTotal: 0, otherReviews: [], otherTotal: 0},
      webAppPartnerNames: {active: [], retired: []}
    }, extra || {});
    const w = browserWorld(responses);
    const steps = new w.Node('div');
    steps.className = 'steps';
    w.root.appendChild(steps);
    const workspace = new w.Node('main');
    workspace.className = 'workspace';
    w.root.appendChild(workspace);
    w.ui.el['settings-panel'].hidden = true;
    w.ui.state.isOwner = true;
    w.ui.state.customers = plain(BOOTSTRAP.customers);
    w.stepsNode = steps;
    w.workspaceNode = workspace;
    w.namedCalls = (name) => w.calls.filter((call) => call.name === name);
    w.freeeStartCalls = () => w.namedCalls('webAppFreeeCardNamesStart');
    w.uploadCalls = () => w.namedCalls('webAppFreeeCardNamesUploadCsv');
    w.saveCalls = () => w.namedCalls('webAppFreeeCardNamesSave');
    w.notice = () => w.ids.notice.textContent;
    w.noticeItems = () => w.ids.notice.children
      .filter((child) => child.tagName === 'UL')
      .reduce((items, list) => items.concat(list.children.map((item) => item.textContent)), []);
    w.buttons = (id) => w.ids[id].children.filter((child) => child.tagName === 'BUTTON');
    w.button = (id, text) => w.buttons(id).filter((button) =>
      button.textContent.indexOf(text) >= 0)[0] || null;
    w.open = async () => { w.ids['nav-settings'].fire('click'); await tick(); };
    w.freee = async () => {
      await w.open();
      w.ids['settings-view-freee-card'].fire('click');
      await tick();
    };
    w.choose = async (customerId) => {
      w.ids['freee-card-customer'].value = customerId;
      w.ids['freee-card-customer'].fire('change');
      await tick();
    };
    w.mapSelects = () => w.ui.el['freee-card-map'].querySelectorAll('select');
    w.mapRows = () => w.ui.el['freee-card-map'].querySelectorAll('tr').slice(1);
    w.selectFor = (folderName) => {
      const rows = w.mapRows();
      for (const row of rows) {
        if (row.children[0].textContent.indexOf(folderName) >= 0) {
          return row.querySelectorAll('select')[0] || null;
        }
      }
      return null;
    };
    w.setFile = (name, size, content) => {
      w.ids['freee-card-csv-file'].files = [{name, size, content: content || ''}];
      w.ids['freee-card-csv-file'].fire('change');
    };
    w.upload = async () => {
      w.ids['freee-card-csv-upload'].fire('click');
      await tick();
      assert.equal(w.ids['confirm-dialog'].open, true, '確認の窓が出ていない');
      w.ids['confirm-submit'].fire('click');
      await tick();
      await tick();
      await tick();
    };
    w.save = async () => {
      w.ids['freee-card-save'].fire('click');
      await tick();
      await tick();
    };
    w.startImportWith = async (customerId, folderId) => {
      w.ui.state.selectedCustomerId = customerId;
      w.ui.state.selectedFolderId = folderId;
      await w.ui.startImport();
      await tick();
      await tick();
    };
    return w;
  }

  function allTags(node, out) {
    node.children.forEach((child) => { out.push(child.tagName); allTags(child, out); });
    return out;
  }

  // fcnu 1
  asyncTest('fcnu 1: 設定を開くと登録の側で、切り替えると見出しと側が変わる', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', '81_WebAppUi.html'), 'utf8');
    const w = world();
    await w.open();
    assert.equal(w.ids['settings-heading'].textContent, '顧客一覧への登録');
    assert.equal(w.ids['settings-view-registration'].getAttribute('aria-pressed'), 'true');
    assert.equal(w.ids['settings-view-freee-card'].getAttribute('aria-pressed'), 'false');
    assert.equal(w.ui.el['registration-view'].hidden, false);
    assert.equal(w.ui.el['freee-card-view'].hidden, true);
    assert.ok(source.indexOf('<div id="registration-view">') >= 0);
    ['registration-category-heading', 'registration-folder-search', 'registration-folder-list',
      'registration-statement-section', 'registration-contract-section',
      'registration-name-section', 'registration-submit'].forEach((id) => {
      assert.ok(source.indexOf('id="' + id + '"') >= 0, id);
    });

    w.ids['settings-view-freee-card'].fire('click');
    await tick();
    assert.equal(w.ui.state.settingsView, 'freee-card');
    assert.equal(w.ids['settings-heading'].textContent, 'freee のカード名');
    assert.equal(w.ids['settings-view-registration'].getAttribute('aria-pressed'), 'false');
    assert.equal(w.ids['settings-view-freee-card'].getAttribute('aria-pressed'), 'true');
    assert.equal(w.ui.el['registration-view'].hidden, true);
    assert.equal(w.ui.el['freee-card-view'].hidden, false);
    assert.equal(w.freeeStartCalls().length, 0);
  });

  // fcnu 2
  asyncTest('fcnu 2: 顧客を選ぶと 1 つの引数で読み、CSV・候補・保存済み・提案・orphans を出す', async () => {
    const w = world();
    await w.freee();
    await w.choose('K9001');
    const calls = w.freeeStartCalls();
    assert.equal(calls.length, 1);
    assert.deepEqual(plain(calls[0].args), ['K9001']);
    const status = w.ids['freee-card-csv-status'].textContent;
    ['勘定科目.csv', 'owner@example.invalid', '勘定科目 5 件', 'カードの候補 3 件'].forEach((part) => {
      assert.ok(status.indexOf(part) >= 0, part);
    });
    const selects = w.mapSelects();
    assert.equal(selects.length, 3);
    assert.equal(w.selectFor('テストカード').value, '架空カードA');
    assert.equal(w.selectFor('架空カードA').value, '架空カードA');
    assert.ok(w.selectFor('架空カードA').parentNode.parentNode.children[2].textContent
      .indexOf('同じ名前の候補（まだ保存していません）') >= 0);
    assert.equal(w.mapSelects()[0].options[0].value, '');
    assert.equal(w.mapSelects()[0].options[0].textContent, '（未設定）');
    assert.deepEqual(plain(w.mapSelects()[0].options.slice(1).map((option) => option.value)),
      ['架空カードA', 'テストカード', 'visaカード']);
    assert.equal(w.ids['freee-card-orphans'].hidden, false);
    assert.ok(w.ids['freee-card-orphans-list'].textContent.indexOf('架空カードZ') >= 0);
    assert.ok(w.ids['freee-card-orphans-list'].textContent.indexOf('テストカード') >= 0);
  });

  // fcnu 3
  asyncTest('fcnu 3: 前の顧客の遅い返事は捨て、待っている間も選び直せる', async () => {
    const hana = startReply({customerId: 'K9002', customerName: '架空 花子', version: 7});
    const w = world({
      webAppFreeeCardNamesStart: (customerId) => customerId === 'K9001' ?
        {defer: true} : plain(hana)
    });
    await w.freee();
    w.ids['freee-card-customer'].value = 'K9001';
    w.ids['freee-card-customer'].fire('change');
    await tick();
    assert.equal(w.pending.length, 1);
    assert.equal(w.ui.state.freeeCardBusy, 1);
    assert.equal(w.ids['freee-card-customer'].disabled, false, '開く返事を待つ間に選べない');
    assert.equal(w.ids['freee-card-csv-status'].textContent, '読み込んでいます…');

    await w.choose('K9002');
    assert.equal(w.ui.state.freeeCardCustomerId, 'K9002');
    assert.equal(w.ui.state.freeeCard.version, 7);
    assert.ok(w.ids['freee-card-csv-status'].textContent.indexOf('勘定科目.csv') >= 0);

    w.pending[0].reply(plain(startReply()));
    await tick();
    assert.equal(w.ui.state.freeeCardCustomerId, 'K9002');
    assert.equal(w.ui.state.freeeCard.version, 7);
    assert.equal(w.ui.state.freeeCardBusy, 0);
  });

  // fcnu 4
  asyncTest('fcnu 4: 1 MB を超える CSV はサーバーを呼ばず、正しい CSV は 4 つの引数で登録する', async () => {
    const big = world();
    await big.freee();
    await big.choose('K9001');
    big.setFile('大きい.csv', 1048577, 'x');
    big.ids['freee-card-csv-upload'].fire('click');
    await tick();
    assert.equal(big.uploadCalls().length, 0);
    assert.equal(big.notice(), big.ui.TEXT.freeeCard.codes.CSV_SIZE);

    const w = world();
    await w.freee();
    await w.choose('K9001');
    w.setFile('勘定科目.csv', 8, 'a,b\nx,y\n');
    await w.upload();
    const calls = w.uploadCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.length, 4);
    assert.deepEqual(plain(calls[0].args.slice(0, 2)), ['K9001', '勘定科目.csv']);
    assert.equal(calls[0].args[2], Buffer.from('a,b\nx,y\n', 'utf8').toString('base64'));
    assert.equal(calls[0].args[3], 3);
    assert.ok(w.notice().indexOf('勘定科目 CSV を登録しました（勘定科目 5 件・カードの候補 3 件）。') >= 0);
    assert.ok(w.noticeItems().some((item) =>
      item.indexOf('「架空カードB」に当てていた「架空経費」') >= 0));
    assert.equal(w.ids['freee-card-csv-file'].files.length, 0);
    assert.equal(w.freeeStartCalls().length, 2, '登録の後に読み直していない');

    const back = world();
    await back.freee();
    await back.choose('K9001');
    back.setFile('勘定科目.csv', 8, 'a,b\nx,y\n');
    back.ids['freee-card-csv-upload'].fire('click');
    await tick();
    back.ids['confirm-cancel'].fire('click');
    await tick();
    assert.equal(back.uploadCalls().length, 0);
    assert.equal(back.ui.state.freeeCardBusy, 0);

    const unreadable = world();
    await unreadable.freee();
    await unreadable.choose('K9001');
    unreadable.setFile('勘定科目.csv', 8, 'a,b\nx,y\n');
    unreadable.setFileReaderFailure(true);
    unreadable.ids['freee-card-csv-upload'].fire('click');
    await tick();
    unreadable.ids['confirm-submit'].fire('click');
    await tick();
    await tick();
    assert.equal(unreadable.uploadCalls().length, 0, '読めない CSV でサーバーを呼んでいる');
    assert.equal(unreadable.notice(), unreadable.ui.TEXT.freeeCard.codes.CSV_DECODE);
  });

  // fcnu 5
  asyncTest('fcnu 5: 保存は変わった所だけを 3 つの引数で送る', async () => {
    const clean = world({webAppFreeeCardNamesStart: plain(cleanReply())});
    await clean.freee();
    await clean.choose('K9001');
    assert.equal(clean.ids['freee-card-save'].disabled, true);

    const suggested = world();
    await suggested.freee();
    await suggested.choose('K9001');
    assert.equal(suggested.ids['freee-card-save'].disabled, false);
    await suggested.save();
    assert.equal(suggested.saveCalls().length, 1);
    const first = suggested.saveCalls()[0].args;
    assert.equal(first.length, 3);
    const names = plain(first[1]).map((change) => change.folderName).sort();
    assert.deepEqual(names, ['架空カードA', '架空カードB']);
    assert.deepEqual(plain(first[1]).filter((change) => change.folderName === '架空カードA'),
      [{folderName: '架空カードA', accountName: '架空カードA'}]);
    assert.deepEqual(plain(first[1]).filter((change) => change.folderName === '架空カードB'),
      [{folderName: '架空カードB', accountName: null}]);
    assert.deepEqual(plain(first[1]).filter((change) => change.folderName === '架空カードZ'),
      []);

    const changed = world({webAppFreeeCardNamesStart: plain(cleanReply())});
    await changed.freee();
    await changed.choose('K9001');
    const select = changed.selectFor('テストカード');
    select.value = 'visaカード';
    select.fire('change');
    await tick();
    assert.equal(changed.ids['freee-card-save'].disabled, false);
    await changed.save();
    assert.deepEqual(plain(changed.saveCalls()[0].args[1]),
      [{folderName: 'テストカード', accountName: 'visaカード'}]);

    const removed = world({webAppFreeeCardNamesStart: plain(cleanReply({
      orphans: [{folderName: '架空カードZ', accountName: 'テストカード', valid: true}]
    }))});
    await removed.freee();
    await removed.choose('K9001');
    removed.ids['freee-card-orphans-list'].querySelectorAll('input')[0].checked = true;
    removed.ids['freee-card-orphans-list'].querySelectorAll('input')[0].fire('change');
    await tick();
    await removed.save();
    assert.deepEqual(plain(removed.saveCalls()[0].args[1]),
      [{folderName: '架空カードZ', accountName: null}]);
  });

  // fcnu 6
  asyncTest('fcnu 6: コードを §4.6 の本文にする', async () => {
    const w = world();
    const codes = w.ui.TEXT.freeeCard.codes;
    assert.equal(codes.CUSTOMER_INACTIVE, 'この顧客は有効ではありません。');
    assert.equal(codes.TABLE_INVALID, 'freee のカード名の表を読めません。管理者に連絡してください。');
    assert.equal(codes.CSV_SIZE, 'CSV が空か、大きすぎます（1 MB まで）。');
    assert.equal(codes.STALE, 'ほかの画面で先に変わりました。顧客を選び直してから、もう一度してください。');

    const failed = world({webAppFreeeCardNamesStart: {ok: false, code: 'TABLE_INVALID'}});
    await failed.freee();
    await failed.choose('K9001');
    assert.equal(failed.notice(), codes.TABLE_INVALID);

    const saveFailed = world({webAppFreeeCardNamesSave: {ok: false, code: 'CSV_HEADER'}});
    await saveFailed.freee();
    await saveFailed.choose('K9001');
    await saveFailed.save();
    assert.equal(saveFailed.notice(), codes.CSV_HEADER);
  });

  // fcnu 7
  asyncTest('fcnu 7: 作業中は設定を閉じず・切り替えず・保存も送るも押せない', async () => {
    const w = world({webAppFreeeCardNamesStart: () => ({defer: true})});
    await w.freee();
    w.ids['freee-card-customer'].value = 'K9001';
    w.ids['freee-card-customer'].fire('change');
    await tick();
    assert.equal(w.ui.state.freeeCardBusy, 1);
    w.ids['settings-back'].fire('click');
    await tick();
    assert.equal(w.ui.state.settingsOpen, true);
    w.ids['settings-view-registration'].fire('click');
    await tick();
    assert.equal(w.ui.state.settingsView, 'freee-card');
    assert.equal(w.ids['freee-card-csv-upload'].disabled, true);
    assert.equal(w.ids['freee-card-save'].disabled, true);

    w.pending[0].reply(plain(startReply()));
    await tick();
    assert.equal(w.ui.state.freeeCardBusy, 0);
    assert.equal(w.ids['freee-card-csv-upload'].disabled, true, 'ファイルを選ぶ前');

    const saving = world({
      webAppFreeeCardNamesStart: plain(cleanReply()),
      webAppFreeeCardNamesSave: () => ({defer: true})
    });
    await saving.freee();
    await saving.choose('K9001');
    const select = saving.selectFor('テストカード');
    select.value = 'visaカード';
    select.fire('change');
    await tick();
    saving.ids['freee-card-save'].fire('click');
    await tick();
    assert.equal(saving.saveCalls().length, 1);
    assert.equal(saving.ui.state.freeeCardBusy, 1);
    assert.equal(saving.ids['freee-card-customer'].disabled, true, '保存中に顧客を選べる');
    saving.ids['settings-back'].fire('click');
    await tick();
    assert.equal(saving.ui.state.settingsOpen, true);
    saving.ids['settings-view-registration'].fire('click');
    await tick();
    assert.equal(saving.ui.state.settingsView, 'freee-card');
    saving.pending[0].reply({ok: true, changed: 1, version: 4});
    await tick();
    assert.equal(saving.ui.state.freeeCardBusy, 0);
  });

  // fcnu 8
  asyncTest('fcnu 8: フォルダ名・科目名・ファイル名を字のまま出し HTML にしない', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', '81_WebAppUi.html'), 'utf8');
    assert.equal(source.includes('innerHTML'), false);
    const reply = startReply({
      csv: {fileName: evil + '.csv', uploadedAt: '2026-11-15T10:00:00+09:00',
        uploadedBy: evil, accountCount: 1, candidateCount: 1},
      candidates: [evil + 'カード'],
      folders: [{folderId: 'f-evil', folderName: evil + 'カード',
        savedAccountName: evil + 'カード', savedValid: true, suggestion: null}],
      orphans: [{folderName: evil + '外', accountName: evil + 'カード', valid: true}]
    });
    const w = world({webAppFreeeCardNamesStart: plain(reply)});
    await w.freee();
    await w.choose('K9001');
    assert.ok(w.ids['freee-card-csv-status'].textContent.indexOf(evil) >= 0);
    assert.ok(w.ids['freee-card-map'].textContent.indexOf(evil + 'カード') >= 0);
    assert.ok(w.ids['freee-card-orphans-list'].textContent.indexOf(evil + '外') >= 0);
    assert.equal(allTags(w.root, []).indexOf('IMG'), -1);
    assert.equal(allTags(w.root, []).indexOf('SCRIPT'), -1);
  });

  // fcnu 9
  asyncTest('fcnu 9: 登録の成功の後に freee のカード名へ移るボタンを出し、選び直すと隠す', async () => {
    const w = world();
    await w.open();
    w.button('registration-folder-list', '架空 太郎').fire('click');
    await tick();
    w.ids['registration-submit'].fire('click');
    await tick();
    w.ids['confirm-submit'].fire('click');
    await tick();
    await tick();
    await tick();
    assert.equal(w.ui.state.registrationNextCustomerId, 'K9001');
    assert.equal(w.ids['registration-next'].hidden, false);
    const next = w.ids['registration-next-freee-card'];
    assert.equal(next.disabled, false);
    next.fire('click');
    await tick();
    assert.equal(w.ui.state.settingsView, 'freee-card');
    assert.equal(w.ids['freee-card-customer'].value, 'K9001');
    assert.equal(w.freeeStartCalls().length, 1);
    assert.deepEqual(plain(w.freeeStartCalls()[0].args), ['K9001']);

    const hidden = world();
    await hidden.open();
    hidden.button('registration-folder-list', '架空 太郎').fire('click');
    await tick();
    hidden.ids['registration-submit'].fire('click');
    await tick();
    hidden.ids['confirm-submit'].fire('click');
    await tick();
    await tick();
    await tick();
    assert.equal(hidden.ids['registration-next'].hidden, false);
    hidden.button('registration-folder-list', '架空 太郎').fire('click');
    await tick();
    assert.equal(hidden.ids['registration-next'].hidden, true);
  });

  // fcnu 10
  asyncTest('fcnu 10: 記帳の終わりにカード名の知らせを出し、WRITTEN では出さない', async () => {
    const notSet = {
      done: 1, total: 1, remaining: 0, destinationSpreadsheetId: 'dest-1',
      fileResults: [], cardName: {status: 'NOT_SET', folderName: 'テストカード'}
    };
    const w = world({webAppRunImport: plain(notSet)});
    await w.startImportWith('K9001', 'folder-1');
    assert.ok(w.noticeItems().some((item) =>
      item.indexOf('「テストカード」に freee のカード名が対応づけられていないため') >= 0),
      w.noticeItems().join(' / '));

    const written = world({webAppRunImport: plain(Object.assign({}, notSet,
      {cardName: {status: 'WRITTEN', folderName: 'テストカード', accountName: '架空カードA'}}))});
    await written.startImportWith('K9001', 'folder-1');
    assert.equal(written.noticeItems().some((item) => item.indexOf('B1') >= 0), false);

    const prepared = world({
      webAppPrepareImport: {fileIds: [], cardName: {status: 'NO_CSV', folderName: 'テストカード'}}
    });
    prepared.ui.state.importLanes = 2;
    await prepared.startImportWith('K9001', 'folder-1');
    assert.ok(prepared.noticeItems().some((item) =>
      item.indexOf('「テストカード」の freee のカード名がまだ設定されていないため') >= 0),
      prepared.noticeItems().join(' / '));
  });

  // fcnu 11
  asyncTest('fcnu 11: freee 取込用の止めにカード名を入れる', async () => {
    const w = world();
    const text = w.ui.freeeStopText({code: 'CARD_NAME_NOT_IN_FREEE', cardName: '架空カードZ'});
    assert.equal(text,
      '入力用シートの B1（カード名）「架空カードZ」は、登録した勘定科目 CSV にありません。' +
      'freee の勘定科目名と同じにしてください（前後の空白・全角半角も同じに）。');
  });

  // fcnu 12
  asyncTest('fcnu 12: 同じ鍵のフォルダは 1 行にまとめ、送る変更も 1 つにする', async () => {
    const reply = startReply({
      folders: [
        {folderId: 'f-b1', folderName: '架空カードB',
          savedAccountName: null, savedValid: false, suggestion: '架空カードA'},
        {folderId: 'f-b2', folderName: '架空カードB ',
          savedAccountName: 'テストカード', savedValid: true, suggestion: null}
      ],
      orphans: []
    });
    const w = world({webAppFreeeCardNamesStart: plain(reply)});
    await w.freee();
    await w.choose('K9001');
    assert.equal(w.mapRows().length, 1);
    assert.ok(w.mapRows()[0].children[0].textContent
      .indexOf('架空カードB（同じ名前のフォルダが 2 個あります）') >= 0);
    assert.equal(w.mapSelects().length, 1);
    assert.equal(w.mapSelects()[0].value, '架空カードA');

    const select = w.mapSelects()[0];
    select.value = 'テストカード';
    select.fire('change');
    await tick();
    await w.save();
    const changes = w.saveCalls()[0].args[1];
    assert.equal(changes.length, 1);
    assert.deepEqual(plain(changes[0]), {folderName: '架空カードB', accountName: 'テストカード'});
  });

  // fcnu 13
  asyncTest('fcnu 13: CSV・対応・未知のコードの文言に値を差し込む', async () => {
    const w = world();
    const codeText = w.ui.TEXT.freeeCard.codeText;
    assert.equal(codeText('CSV_ROW_INVALID', {row: null}),
      'CSV の形が壊れています（引用符が閉じていないなど）。freee から書き出したファイルを、そのまま選んでください。');
    assert.equal(codeText('CSV_ROW_INVALID', {row: 7}),
      '7 行目の勘定科目が空か、使えない文字（改行・タブなど）を含んでいます。');
    assert.equal(codeText('CSV_DUPLICATE', {name: 'テストカード', rows: [3, 9]}),
      '勘定科目「テストカード」が 2 回以上あります（3 行目・9 行目）。');
    assert.equal(codeText('MAPPING_INVALID', {index: 0, reason: 'DUPLICATE_FOLDER'},
      [{folderName: '架空カードB', accountName: 'テストカード'}]),
    '「架空カードB」の対応を保存できません（候補に無い名前か、今の明細フォルダに無いカードフォルダです）。顧客を選び直してください。');
    assert.equal(codeText('SOMETHING_NEW'),
      'freee のカード名の操作ができませんでした（コード：SOMETHING_NEW）。');

    const rejected = world({
      webAppFreeeCardNamesStart: Object.assign(new Error('x'),
        {code: 'REQUIRED_LOG_WRITE_FAILED'})
    });
    await rejected.freee();
    await rejected.choose('K9001');
    assert.equal(rejected.notice(), rejected.ui.TEXT.freeeCard.codes.REQUIRED_LOG_WRITE_FAILED);

    const mapping = world({
      webAppFreeeCardNamesStart: plain(cleanReply({
        folders: [{folderId: 'f-a', folderName: '架空カードA',
          savedAccountName: null, savedValid: false, suggestion: '架空カードA'}]
      })),
      webAppFreeeCardNamesSave: {ok: false, code: 'MAPPING_INVALID',
        detail: {index: 0, reason: 'DUPLICATE_FOLDER'}}
    });
    await mapping.freee();
    await mapping.choose('K9001');
    await mapping.save();
    assert.ok(mapping.notice().indexOf('「架空カードA」の対応を保存できません') >= 0, mapping.notice());

    const unknown = world({webAppFreeeCardNamesStart: {ok: false, code: 'SOMETHING_NEW'}});
    await unknown.freee();
    await unknown.choose('K9001');
    assert.ok(unknown.notice().indexOf('コード：SOMETHING_NEW') >= 0);
  });

  // fcnu 14
  asyncTest('fcnu 14: 送る版は数値のまま、changes は配列にする', async () => {
    const w = world();
    await w.freee();
    await w.choose('K9001');
    w.setFile('勘定科目.csv', 8, 'a,b\nx,y\n');
    await w.upload();
    const upload = w.uploadCalls()[0].args;
    assert.equal(upload.length, 4);
    assert.equal(typeof upload[3], 'number');
    assert.equal(upload[3], 3);

    await w.save();
    const save = w.saveCalls()[0].args;
    assert.equal(save.length, 3);
    assert.equal(Array.isArray(save[1]), true);
    assert.equal(typeof save[2], 'number');
    assert.equal(save[2], 3);
  });
};

if (require.main === module) {
  const tests = [];
  module.exports({assert: require('node:assert/strict'), test: (name, fn) => tests.push(fn)});
  Promise.resolve().then(() => tests[0]()).then(() => console.log('CASE_DONE'))
    .catch((error) => { console.error(error.stack); process.exitCode = 1; });
}

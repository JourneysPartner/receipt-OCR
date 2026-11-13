'use strict';

/**
 * 「設定」タブの「顧客一覧への登録」の画面（仕様 §3.11・§6.2 の regu 1〜12）。
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

  const START = {
    ready: true,
    missing: [],
    categories: [{key: 'INDIVIDUAL', label: '個人', enabled: true},
      {key: 'CORPORATE', label: '法人', enabled: false}],
    customerFolders: [
      {folderId: 'f-taro', folderName: '【代※現金シート】架空 太郎', displayName: '架空 太郎',
        registered: false},
      {folderId: 'f-hana', folderName: '架空　花子', displayName: '架空　花子', registered: false},
      {folderId: 'f-done', folderName: '【済】架空 済', displayName: '架空 済', registered: true}
    ]
  };

  const READY = {
    status: 'READY',
    path: ['☆資料共有フォルダ', '令和8年分', '経費', 'クレジットカード支払い分'],
    statementFolderId: 'stmt-1',
    yearFolderId: 'year-1',
    reiwaYear: 8,
    fiscalYear: 2026,
    cardFolders: ['AUPAY', 'JCB'],
    proposedName: '架空 太郎',
    nameProblem: null,
    folderProblem: null,
    contract: {
      status: 'MATCHED',
      tabName: 'R8.契約内容',
      matchedCustomerId: 'K9002',
      entries: [
        {customerId: 'K9002', name: '架空 太郎', usable: true, problem: null},
        {customerId: 'BAD!', name: '架空 形式', usable: false, problem: 'ID_FORMAT'},
        {customerId: 'K9010', name: '架空 予備', usable: true, problem: null}
      ]
    }
  };

  const SUCCESS = {ok: true, customerId: 'K9002', customerName: '架空 太郎',
    rowNumber: 3, alreadyRegistered: false};

  function world(start, inspect, extra) {
    const responses = Object.assign({
      webAppBootstrap: {actor: 'owner@example.invalid', isOwner: true, customers: [],
        importLanes: 1, maxFilesPerImport: 6, version: 'v-fake'},
      webAppRegistrationStart: start === undefined ? plain(START) : start,
      webAppRegistrationInspect: inspect === undefined ? plain(READY) : inspect,
      webAppRegisterCustomer: plain(SUCCESS)
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
    w.stepsNode = steps;
    w.workspaceNode = workspace;
    w.startCalls = () => w.calls.filter((call) => call.name === 'webAppRegistrationStart');
    w.inspectCalls = () => w.calls.filter((call) => call.name === 'webAppRegistrationInspect');
    w.registerCalls = () => w.calls.filter((call) => call.name === 'webAppRegisterCustomer');
    w.bootstrapCalls = () => w.calls.filter((call) => call.name === 'webAppBootstrap');
    w.notice = () => w.ids.notice.textContent;
    w.buttons = (id) => w.ids[id].children.filter((child) => child.tagName === 'BUTTON');
    w.button = (id, text) => w.buttons(id).filter((button) =>
      button.textContent.indexOf(text) >= 0)[0] || null;
    w.open = async () => { w.ids['nav-settings'].fire('click'); await tick(); };
    w.pickFolder = async (name) => {
      const button = w.button('registration-folder-list', name);
      assert.ok(button, 'folder button ' + name);
      button.fire('click');
      await tick();
    };
    w.ready = async () => { await w.open(); await w.pickFolder('架空 太郎'); };
    w.typeName = async (value) => {
      w.ids['registration-name'].value = value;
      w.ids['registration-name'].fire('input');
      await tick();
    };
    w.submit = async () => {
      w.ids['registration-submit'].fire('click');
      await tick();
      w.ids['confirm-submit'].fire('click');
      await tick();
    };
    return w;
  }

  function allTags(node, out) {
    node.children.forEach((child) => { out.push(child.tagName); allTags(child, out); });
    return out;
  }

  // regu 1: オーナーでなければ文言だけ
  asyncTest('regu 1: オーナーでなければ設定は文言だけでサーバーを呼ばない', async () => {
    const w = world();
    w.ui.state.isOwner = false;
    await w.open();
    assert.equal(w.notice(), w.ui.TEXT.registration.ownerOnly);
    assert.equal(w.startCalls().length, 0);
    assert.equal(w.stepsNode.hidden, false);
    assert.equal(w.workspaceNode.hidden, false);
    assert.equal(w.ui.el['settings-panel'].hidden, true);
    assert.equal(w.ui.state.settingsOpen, false);
  });

  // regu 2: オーナーの開閉
  asyncTest('regu 2: オーナーは設定を開くと一覧を 1 回読み、戻すと元へ戻る', async () => {
    const w = world();
    await w.open();
    assert.equal(w.startCalls().length, 1);
    assert.equal(w.ui.el['settings-panel'].hidden, false);
    assert.equal(w.stepsNode.hidden, true);
    assert.equal(w.workspaceNode.hidden, true);
    assert.equal(w.ids['nav-settings'].className, 'active');
    assert.equal(w.ids['nav-import'].className, '');
    w.ids['settings-back'].fire('click');
    await tick();
    assert.equal(w.ui.el['settings-panel'].hidden, true);
    assert.equal(w.stepsNode.hidden, false);
    assert.equal(w.workspaceNode.hidden, false);
    assert.equal(w.ids['nav-import'].className, 'active');
    assert.equal(w.ids['nav-settings'].className, '');
    // 開くたびに 1 回。
    await w.open();
    assert.equal(w.startCalls().length, 2);
    w.ids['settings-back'].fire('click');
    await tick();
    // 取込の最中は開かない。
    w.ui.state.importBusy = true;
    w.ids['nav-settings'].fire('click');
    await tick();
    assert.equal(w.startCalls().length, 2);
    assert.equal(w.ui.state.settingsOpen, false);
    assert.equal(w.ui.el['settings-panel'].hidden, true);
    w.ui.state.importBusy = false;
  });

  // regu 3: 準備の不足
  asyncTest('regu 3: 準備が足りなければ文言を並べ一覧を出さない', async () => {
    const w = world({ready: false, missing: ['CUSTOMER_ROOT_FOLDER_ID', 'PARALLEL_WORK_FOLDER_ID'],
      categories: [], customerFolders: []});
    await w.open();
    const text = w.ids['registration-missing'].textContent;
    assert.ok(text.indexOf(w.ui.TEXT.registrationCodes.CUSTOMER_ROOT_FOLDER_ID) >= 0);
    assert.ok(text.indexOf(w.ui.TEXT.registrationCodes.PARALLEL_WORK_FOLDER_ID) >= 0);
    assert.equal(w.ids['registration-missing'].hidden, false);
    assert.equal(w.ids['registration-folders-section'].hidden, true);
    assert.equal(w.ids['registration-folder-list'].children.length, 0);
    assert.equal(w.ids['registration-submit'].disabled, true);
  });

  // regu 4: 一覧の検索と登録済み
  asyncTest('regu 4: 一覧は表示名・元の名前で絞れ、登録済みは押せない', async () => {
    const w = world();
    await w.open();
    assert.equal(w.ids['registration-folder-count'].textContent, '3 / 3 件');
    w.ids['registration-folder-search'].value = '花子';
    w.ids['registration-folder-search'].fire('input');
    await tick();
    assert.equal(w.ids['registration-folder-count'].textContent, '1 / 3 件');
    assert.ok(w.button('registration-folder-list', '架空　花子'));
    // 元の名前（【…】つき）でも当たる。
    w.ids['registration-folder-search'].value = '【代※現金シート】';
    w.ids['registration-folder-search'].fire('input');
    await tick();
    assert.ok(w.button('registration-folder-list', '架空 太郎'));
    // 全角・半角の空白の違いだけでも当たる（照合の鍵）。
    w.ids['registration-folder-search'].value = '架空 太郎';
    w.ids['registration-folder-search'].fire('input');
    await tick();
    assert.ok(w.button('registration-folder-list', '架空 太郎'));
    w.ids['registration-folder-search'].value = '';
    w.ids['registration-folder-search'].fire('input');
    await tick();
    const registered = w.button('registration-folder-list', '架空 済');
    assert.ok(registered);
    assert.equal(registered.disabled, true);
    assert.ok(registered.textContent.indexOf(w.ui.TEXT.registration.registered) >= 0);
    registered.fire('click');
    await tick();
    assert.equal(w.inspectCalls().length, 0);
  });

  // regu 5: 明細フォルダ
  asyncTest('regu 5: 選ばせる段・止まる段・決まった段を順に出す', async () => {
    const seen = [];
    let count = 0;
    const inspect = (folderId, picks) => {
      seen.push(plain(picks));
      count += 1;
      if (count === 1) {
        return plain({status: 'NEED_CHOICE', stage: 'accounting', stageLabel: '経費',
          path: ['☆資料共有フォルダ', '令和8年分'],
          choices: [{id: 'acc-1', name: '経費A'}, {id: 'acc-2', name: '経費B'}]});
      }
      return plain(READY);
    };
    const w = world(START, inspect);
    await w.ready();
    assert.deepEqual(plain(w.inspectCalls()[0].args), ['f-taro', {}]);
    assert.equal(w.ui.el['registration-statement-section'].hidden, false);
    assert.equal(w.button('registration-statement-choices', '経費B').disabled, false);
    assert.ok(w.ids['registration-statement-message'].textContent.indexOf('経費を選んでください') >= 0);
    w.button('registration-statement-choices', '経費B').fire('click');
    await tick();
    assert.deepEqual(seen[1], {accounting: 'acc-2'});
    assert.equal(w.ids['registration-statement-path'].textContent,
      '☆資料共有フォルダ › 令和8年分 › 経費 › クレジットカード支払い分');
    assert.equal(w.ids['registration-statement-year'].textContent,
      w.ui.TEXT.registration.yearLabel(8, 2026));
    assert.ok(w.ids['registration-statement-cards'].textContent.indexOf('AUPAY') >= 0);
    assert.ok(w.ids['registration-statement-cards'].textContent.indexOf('JCB') >= 0);

    const stopped = world(START, plain({status: 'STOPPED', code: 'YEAR_FOLDER_NOT_FOUND',
      path: [], childNames: ['2026年分']}));
    await stopped.ready();
    assert.equal(stopped.ids['registration-statement-message'].textContent,
      'この顧客フォルダの中に「令和N年分」のフォルダがありません。');
    assert.equal(stopped.ids['registration-statement-message'].className, 'settings-warning');
    assert.ok(stopped.ids['registration-statement-choices'].textContent
      .indexOf('直下にあるフォルダ：2026年分') >= 0);
    assert.equal(stopped.ids['registration-submit'].disabled, true);
  });

  // regu 6: 顧客 ID
  asyncTest('regu 6: 別表の 1 件を出し、選び直しと使えない行の停止を扱う', async () => {
    const w = world();
    await w.ready();
    assert.equal(w.ids['registration-contract-summary'].textContent,
      '別表の R8.契約内容 から：K9002　架空 太郎');
    assert.equal(w.ids['registration-contract-reselect'].hidden, false);
    w.ids['registration-contract-reselect'].fire('click');
    await tick();
    const bad = w.button('registration-contract-list', 'BAD!');
    assert.ok(bad);
    assert.equal(bad.disabled, true);
    assert.ok(bad.textContent.indexOf(w.ui.TEXT.registrationCodes.ID_FORMAT) >= 0);
    const other = w.button('registration-contract-list', 'K9010');
    assert.equal(other.disabled, false);
    other.fire('click');
    await tick();
    assert.equal(w.ids['registration-contract-summary'].textContent,
      '別表の R8.契約内容 から：K9010　架空 予備');

    // 1 つに決まらないときは一覧を開き、選ぶまで登録できない。
    const none = plain(READY);
    none.contract = {status: 'NONE', tabName: 'R8.契約内容', entries: [
      {customerId: 'K9002', name: '架空 太郎', usable: true, problem: null},
      {customerId: 'BAD!', name: '架空 形式', usable: false, problem: 'ID_FORMAT'}]};
    const chooser = world(START, none);
    await chooser.ready();
    assert.equal(chooser.ids['registration-contract-message'].textContent,
      chooser.ui.TEXT.registration.contractChoose);
    assert.equal(chooser.button('registration-contract-list', 'BAD!').disabled, true);
    assert.equal(chooser.ids['registration-submit'].disabled, true);
    chooser.button('registration-contract-list', 'K9002').fire('click');
    await tick();
    assert.equal(chooser.ids['registration-submit'].disabled, false);
  });

  // regu 7: 顧客名の画面の検査
  asyncTest('regu 7: 名前の 4 つの問題で登録できず、直すと押せる', async () => {
    const w = world();
    await w.ready();
    assert.equal(w.ids['registration-submit'].disabled, false);
    const cases = [['', 'NAME_EMPTY'], ['あ'.repeat(51), 'NAME_TOO_LONG'],
      ['架空\u0001名', 'NAME_INVALID_CHAR'], ['架空_20261112-1200', 'NAME_RESERVED_SUFFIX']];
    for (const [value, code] of cases) {
      await w.typeName(value);
      assert.equal(w.ids['registration-submit'].disabled, true, code);
      assert.equal(w.ids['registration-name-problem'].textContent,
        w.ui.TEXT.registrationCodes[code], code);
    }
    await w.typeName('架空 花子');
    assert.equal(w.ids['registration-submit'].disabled, false);
    assert.equal(w.ids['registration-name-problem'].textContent, '');
  });

  // regu 8: 確認と二度押し、呼出し中
  asyncTest('regu 8: 確認して 5 つの値だけを 1 回送り、呼出し中は戻れない', async () => {
    let pendingCall = null;
    const w = world(START, READY, {
      webAppRegisterCustomer: () => { pendingCall = true; return {defer: true}; }
    });
    await w.ready();
    w.ids['registration-submit'].fire('click');
    await tick();
    assert.equal(w.ids['confirm-dialog'].open, true);
    assert.equal(w.ids['confirm-title'].textContent, '顧客を登録する');
    const intro = w.ids['confirm-intro'].textContent;
    ['架空 太郎', 'K9002', '個人', '令和 8 年分（2026 年）',
      '☆資料共有フォルダ › 令和8年分 › 経費 › クレジットカード支払い分',
      '登録した後は顧客名を変えられません。'].forEach((part) => {
      assert.ok(intro.indexOf(part) >= 0, part);
    });
    // 二度押しでも確認は 1 つ、呼出しも 1 回。
    w.ids['registration-submit'].fire('click');
    await tick();
    w.ids['confirm-submit'].fire('click');
    await tick();
    assert.equal(w.registerCalls().length, 1);
    const request = w.registerCalls()[0].args[0];
    assert.deepEqual(plain(request), {
      category: 'INDIVIDUAL',
      customerFolderId: 'f-taro',
      statementFolderId: 'stmt-1',
      customerId: 'K9002',
      customerName: '架空 太郎'
    });
    assert.equal(pendingCall, true);
    assert.equal(w.ui.state.registrationBusy, true);
    assert.equal(w.ids['settings-back'].disabled, true);
    assert.equal(w.ids['nav-import'].disabled, true);
    assert.equal(w.ids['registration-submit'].disabled, true);
    assert.equal(w.ids['registration-name'].disabled, true);
    w.ids['settings-back'].fire('click');
    await tick();
    assert.equal(w.ui.state.settingsOpen, true);
    assert.equal(w.ui.el['settings-panel'].hidden, false);
    w.pending[0].reply(plain(SUCCESS));
    await tick();
    assert.equal(w.ui.state.registrationBusy, false);
  });

  // regu 9: 成功
  asyncTest('regu 9: 成功で一覧と設定を読み直し、済みの文言を足す', async () => {
    const w = world(START, READY, {
      webAppRegisterCustomer: Object.assign(plain(SUCCESS), {alreadyRegistered: false})
    });
    await w.ready();
    await w.submit();
    assert.equal(w.registerCalls().length, 1);
    assert.equal(w.bootstrapCalls().length, 1);
    assert.equal(w.startCalls().length, 2);
    assert.equal(w.notice(), '「架空 太郎」を顧客一覧に登録しました（顧客 ID K9002）。');
    // パネルは顧客フォルダの段に戻る。
    assert.equal(w.ui.state.registrationFolderId, null);
    assert.equal(w.ui.el['registration-statement-section'].hidden, true);
    assert.equal(w.ui.el['registration-folders-section'].hidden, false);

    const again = world(START, READY, {
      webAppRegisterCustomer: Object.assign(plain(SUCCESS), {alreadyRegistered: true})
    });
    await again.ready();
    await again.submit();
    assert.ok(again.notice().indexOf('既に登録されていました。') >= 0);
  });

  // regu 10: ok:false の文言
  asyncTest('regu 10: 失敗のコードを文言にし、書込の失敗には行番号を足す', async () => {
    const cases = [
      ['FOLDER_ALREADY_REGISTERED', null],
      ['NAME_DUPLICATE', null],
      ['ID_NOT_IN_CONTRACT', null],
      ['PROFILE_INVALID', null],
      ['WRITE_VERIFY_FAILED', 7]
    ];
    for (const [code, rowNumber] of cases) {
      const response = rowNumber === null ? {ok: false, code} : {ok: false, code, rowNumber};
      const w = world(START, READY, {webAppRegisterCustomer: plain(response)});
      await w.ready();
      await w.submit();
      const expected = rowNumber === null ? w.ui.TEXT.registrationCodes[code] :
        w.ui.TEXT.registrationCodes.WRITE_VERIFY_FAILED({rowNumber: rowNumber});
      assert.equal(w.notice(), expected, code);
    }
    // 表に無いコードは汎用の文言にコードを添える。
    const unknown = world(START, READY, {
      webAppRegisterCustomer: {ok: false, code: 'SOMETHING_NEW'}});
    await unknown.ready();
    await unknown.submit();
    assert.ok(unknown.notice().indexOf('SOMETHING_NEW') >= 0);
    assert.ok(unknown.notice().indexOf('この操作はできませんでした') >= 0);
  });

  // regu 11: 古い返事
  asyncTest('regu 11: 前の顧客フォルダの下調べの返事は画面を変えない', async () => {
    const hanaReady = plain(READY);
    hanaReady.proposedName = '架空 花子';
    hanaReady.path = ['令和8年分', '経理', 'クレカ明細'];
    const inspect = (folderId) => folderId === 'f-taro' ? {defer: true} : hanaReady;
    const w = world(START, inspect);
    await w.open();
    w.button('registration-folder-list', '架空 太郎').fire('click');
    await tick();
    assert.equal(w.pending.length, 1);
    // 下調べの最中でも選び直せる（読むだけの呼出し）。
    w.button('registration-folder-list', '花子').fire('click');
    await tick();
    assert.equal(w.ui.state.registrationFolderId, 'f-hana');
    assert.equal(w.ui.state.registrationName, '架空 花子');
    // A の遅れた返事。
    w.pending[0].reply(plain(READY));
    await tick();
    assert.equal(w.ui.state.registrationFolderId, 'f-hana');
    assert.equal(w.ui.state.registrationName, '架空 花子');
    assert.equal(w.ids['registration-statement-path'].textContent,
      '令和8年分 › 経理 › クレカ明細');
  });

  // regu 12: 表示は textContent
  asyncTest('regu 12: フォルダ名や別表の名前を字のまま出し HTML にしない', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', '81_WebAppUi.html'), 'utf8');
    assert.equal(source.includes('innerHTML'), false);
    const evil = '<img src=x onerror=alert(1)>';
    const start = plain(START);
    start.customerFolders = [{folderId: 'f-evil', folderName: '【' + evil + '】架空 悪',
      displayName: evil + '架空 悪', registered: false}];
    const ready = plain(READY);
    ready.proposedName = evil + '架空 悪';
    ready.contract = {status: 'MATCHED', tabName: 'R8.契約内容', matchedCustomerId: 'K9002',
      entries: [{customerId: 'K9002', name: evil + '架空 太郎', usable: true, problem: null}]};
    const w = world(start, ready);
    await w.open();
    const folder = w.button('registration-folder-list', evil);
    assert.ok(folder);
    assert.ok(folder.textContent.indexOf(evil) >= 0);
    folder.fire('click');
    await tick();
    assert.ok(w.ids['registration-name'].value.indexOf(evil) >= 0);
    assert.ok(w.ids['registration-contract-summary'].textContent.indexOf(evil) >= 0);
    assert.equal(allTags(w.root, []).indexOf('IMG'), -1);
    assert.equal(allTags(w.root, []).indexOf('SCRIPT'), -1);
  });

  // regu 13: 確認の窓の改行
  asyncTest('regu 13: 確認の窓は改行をそのまま出す（white-space: pre-line）', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', '81_WebAppUi.html'), 'utf8');
    const style = source.slice(source.indexOf('<style>') + '<style>'.length,
      source.indexOf('</style>'));
    const rules = style.match(/[^{}]*\{[^{}]*\}/g) || [];
    const rule = rules.filter((text) =>
      /(^|[\s,>])#confirm-intro(?![-\w])/.test(text.slice(0, text.indexOf('{'))))[0];
    assert.ok(rule, '#confirm-intro を選ぶ規則がある');
    assert.ok(/white-space\s*:\s*pre-line\s*;/.test(rule.slice(rule.indexOf('{') + 1)),
      'white-space: pre-line がある');

    const w = world(START, READY);
    await w.ready();
    w.ids['registration-submit'].fire('click');
    await tick();
    assert.equal(w.ids['confirm-dialog'].open, true);
    const intro = w.ids['confirm-intro'].textContent;
    assert.ok(intro.indexOf('\n') >= 0, '改行を含む');
    assert.ok(intro.indexOf('顧客名: 架空 太郎\n顧客 ID: K9002') >= 0, intro);
  });

  // regu 14: 設定を開いたときに CSS でも隠れる
  asyncTest('regu 14: 設定を開くと進み具合の帯と 3 つの欄が CSS でも隠れる（[hidden] は display: none）', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', '81_WebAppUi.html'), 'utf8');
    const style = source.slice(source.indexOf('<style>') + '<style>'.length,
      source.indexOf('</style>'));
    const rules = style.match(/[^{}]*\{[^{}]*\}/g) || [];
    const hides = (selector) => rules.some((text) => {
      const selectorText = text.slice(0, text.indexOf('{'));
      const body = text.slice(text.indexOf('{') + 1);
      const selects = selectorText.split(',').some((part) => part.trim() === selector);
      return selects && /display\s*:\s*none\s*(?:;|$)/.test(body);
    });
    assert.ok(hides('.steps[hidden]'), '.steps[hidden] を選ぶ規則に display: none がある');
    assert.ok(hides('.workspace[hidden]'), '.workspace[hidden] を選ぶ規則に display: none がある');

    const w = world();
    await w.open();
    assert.equal(w.stepsNode.hidden, true);
    assert.equal(w.workspaceNode.hidden, true);
    w.ids['settings-back'].fire('click');
    await tick();
    assert.equal(w.stepsNode.hidden, false);
    assert.equal(w.workspaceNode.hidden, false);
  });

  // regu 15: 開くときの「調べています…」
  asyncTest('regu 15: 一覧の返事を待つ間は「調べています…」だけを出し、前の一覧も出さない', async () => {
    const w = world(START, READY, {webAppRegistrationStart: () => ({defer: true})});
    w.ids['nav-settings'].fire('click');
    await tick();
    assert.equal(w.startCalls().length, 1);
    assert.equal(w.ids['registration-missing'].hidden, false);
    assert.equal(w.ids['registration-missing'].textContent, w.ui.TEXT.registration.checking);
    ['registration-folders-section', 'registration-statement-section',
      'registration-contract-section', 'registration-name-section'].forEach((id) => {
      assert.equal(w.ids[id].hidden, true, id);
    });
    assert.equal(w.ids['registration-folder-list'].children.length, 0);
    assert.equal(w.ids['registration-folder-count'].textContent, '');
    assert.equal(w.ids['registration-submit'].disabled, true);
    // 返事で今までどおりになる。
    w.pending[0].reply(plain(START));
    await tick();
    assert.equal(w.ids['registration-missing'].hidden, true);
    assert.equal(w.ids['registration-missing'].textContent, '');
    assert.equal(w.ids['registration-folder-list'].children.length, 3);
    assert.equal(w.ids['registration-submit'].disabled, true);

    // 一度開いて一覧が出た後に閉じ、開き直して待たせても、前の一覧は出さない。
    w.ids['settings-back'].fire('click');
    await tick();
    assert.equal(w.ui.el['settings-panel'].hidden, true);
    assert.equal(w.ui.state.registrationReady, true);
    w.ids['nav-settings'].fire('click');
    await tick();
    assert.equal(w.startCalls().length, 2);
    assert.equal(w.ui.state.registrationReady, true);
    assert.equal(w.ids['registration-missing'].hidden, false);
    assert.equal(w.ids['registration-missing'].textContent, w.ui.TEXT.registration.checking);
    assert.equal(w.ids['registration-folders-section'].hidden, true);
    assert.equal(w.ids['registration-folder-list'].children.length, 0);
    assert.equal(w.ids['registration-submit'].disabled, true);
    w.pending[1].reply(plain(START));
    await tick();
    assert.equal(w.ids['registration-missing'].hidden, true);
    assert.equal(w.ids['registration-folder-list'].children.length, 3);

    // 例外でも「調べています…」は残らない。
    const failed = world(START, READY, {webAppRegistrationStart: () => ({defer: true})});
    failed.ids['nav-settings'].fire('click');
    await tick();
    assert.equal(failed.ids['registration-missing'].textContent,
      failed.ui.TEXT.registration.checking);
    failed.pending[0].reject(new Error('x'));
    await tick();
    assert.equal(failed.ids['registration-missing'].textContent, '');
    assert.equal(failed.ids['registration-folder-list'].children.length, 0);
    assert.equal(failed.ids['registration-folders-section'].hidden, true);
    assert.equal(failed.ids['registration-submit'].disabled, true);
  });

  // regu 16: 下調べの「調べています…」
  asyncTest('regu 16: 下調べの返事を待つ間は「調べています…」を出し、古い返事で消さない', async () => {
    const w = world(START, () => ({defer: true}));
    await w.open();
    assert.equal(w.inspectCalls().length, 0);
    w.button('registration-folder-list', '架空 太郎').fire('click');
    await tick();
    assert.equal(w.inspectCalls().length, 1);
    assert.equal(w.ids['registration-statement-section'].hidden, false);
    assert.equal(w.ids['registration-statement-message'].textContent,
      w.ui.TEXT.registration.checking);
    assert.equal(w.ids['registration-statement-message'].className, 'muted');
    ['registration-statement-path', 'registration-statement-year',
      'registration-statement-cards', 'registration-statement-choices'].forEach((id) => {
      assert.equal(w.ids[id].textContent, '', id);
    });
    assert.equal(w.ids['registration-contract-section'].hidden, true);
    assert.equal(w.ids['registration-name-section'].hidden, true);
    assert.equal(w.ids['registration-submit'].disabled, true);

    // 待っている間に別の顧客フォルダを選び直す（これも待たせる）。
    w.button('registration-folder-list', '花子').fire('click');
    await tick();
    assert.equal(w.inspectCalls().length, 2);
    assert.equal(w.ui.state.registrationFolderId, 'f-hana');
    // 前の返事（f-taro）を先に返しても「調べています…」は消えない。
    w.pending[0].reply(plain(READY));
    await tick();
    assert.equal(w.ids['registration-statement-section'].hidden, false);
    assert.equal(w.ids['registration-statement-message'].textContent,
      w.ui.TEXT.registration.checking);
    // 後の返事（READY）で消えて道が出る。
    const hana = plain(READY);
    hana.path = ['令和8年分', '経理', 'クレカ明細'];
    w.pending[1].reply(hana);
    await tick();
    assert.equal(w.ids['registration-statement-message'].textContent, '');
    assert.equal(w.ids['registration-statement-path'].textContent, '令和8年分 › 経理 › クレカ明細');
    assert.equal(w.ids['registration-statement-message'].className, 'muted');

    // NEED_CHOICE で段を選んだ後の呼び直しを待たせても「調べています…」が出る。
    const again = world(START, () => ({defer: true}));
    await again.open();
    again.button('registration-folder-list', '架空 太郎').fire('click');
    await tick();
    again.pending[0].reply(plain({status: 'NEED_CHOICE', stage: 'accounting', stageLabel: '経費',
      path: ['☆資料共有フォルダ', '令和8年分'],
      choices: [{id: 'acc-1', name: '経費A'}, {id: 'acc-2', name: '経費B'}]}));
    await tick();
    assert.ok(again.button('registration-statement-choices', '経費B'));
    again.button('registration-statement-choices', '経費B').fire('click');
    await tick();
    assert.equal(again.inspectCalls().length, 2);
    assert.equal(again.ids['registration-statement-message'].textContent,
      again.ui.TEXT.registration.checking);
    assert.equal(again.ids['registration-statement-path'].textContent, '');
    assert.equal(again.ids['registration-statement-choices'].textContent, '');
    assert.equal(again.ids['registration-submit'].disabled, true);
    again.pending[1].reply(plain(READY));
    await tick();
    assert.equal(again.ids['registration-statement-message'].textContent, '');
    assert.equal(again.ids['registration-statement-path'].textContent,
      '☆資料共有フォルダ › 令和8年分 › 経費 › クレジットカード支払い分');

    // 下調べが例外のときは「調べています…」を残さない。
    const failed = world(START, () => ({defer: true}));
    await failed.open();
    failed.button('registration-folder-list', '架空 太郎').fire('click');
    await tick();
    assert.equal(failed.ids['registration-statement-message'].textContent,
      failed.ui.TEXT.registration.checking);
    failed.pending[0].reject(new Error('x'));
    await tick();
    assert.equal(failed.ids['registration-statement-message'].textContent, '');
    assert.equal(failed.ids['registration-statement-section'].hidden, true);
    assert.equal(failed.ids['registration-submit'].disabled, true);
  });

  // regu 17: 止まったときの文言
  asyncTest('regu 17: 止まったときに足りない段・直下のフォルダ・探し方を出す', async () => {
    const HINT = '明細フォルダは、顧客フォルダの中を「（☆資料共有フォルダ ›）令和N年分 › 経費 › ' +
      'クレジットカード…」の順にたどって探します。この形になっていないフォルダは登録できません。';
    const lines = (w) => w.ids['registration-statement-choices'].children
      .map((child) => child.textContent);

    // 年の段が無い（道が空）。
    const year = world(START, plain({status: 'STOPPED', code: 'YEAR_FOLDER_NOT_FOUND',
      path: [], childNames: ['架空 第一', '架空 第二']}));
    await year.ready();
    assert.equal(year.ids['registration-statement-message'].textContent,
      'この顧客フォルダの中に「令和N年分」のフォルダがありません。');
    assert.equal(year.ids['registration-statement-message'].className, 'settings-warning');
    assert.deepEqual(lines(year), ['直下にあるフォルダ：架空 第一、架空 第二', HINT]);
    assert.equal(year.ids['registration-statement-choices'].children[1].className, 'muted');
    assert.equal(year.ids['registration-submit'].disabled, true);

    // 年の段が無い（道がある）。
    const inShared = world(START, plain({status: 'STOPPED', code: 'YEAR_FOLDER_NOT_FOUND',
      path: ['☆資料共有フォルダ'], childNames: ['架空 第一']}));
    await inShared.ready();
    assert.equal(inShared.ids['registration-statement-message'].textContent,
      '「☆資料共有フォルダ」の中に「令和N年分」のフォルダがありません。');
    assert.equal(inShared.ids['registration-statement-message'].className, 'settings-warning');
    assert.deepEqual(lines(inShared), ['直下にあるフォルダ：架空 第一', HINT]);
    assert.equal(inShared.ids['registration-submit'].disabled, true);

    // 子が 1 つも無い（道が空・道が 2 つ）。子が空なら「直下にあるフォルダ：」の行は無い。
    const noChild = world(START, plain({status: 'STOPPED', code: 'NO_CHILD_FOLDERS',
      path: [], childNames: []}));
    await noChild.ready();
    assert.equal(noChild.ids['registration-statement-message'].textContent,
      'この顧客フォルダの中にフォルダがありません。');
    assert.equal(noChild.ids['registration-statement-message'].className, 'settings-warning');
    assert.deepEqual(lines(noChild), [HINT]);
    assert.equal(noChild.ids['registration-submit'].disabled, true);

    const noChildDeep = world(START, plain({status: 'STOPPED', code: 'NO_CHILD_FOLDERS',
      path: ['☆資料共有フォルダ', '令和8年分'], childNames: ['架空 下']}));
    await noChildDeep.ready();
    assert.equal(noChildDeep.ids['registration-statement-message'].textContent,
      '「令和8年分」の中にフォルダがありません。');
    assert.deepEqual(lines(noChildDeep), ['直下にあるフォルダ：架空 下', HINT]);
    assert.equal(noChildDeep.ids['registration-submit'].disabled, true);

    // ほかのコードは今の表の文言で、3 行目は無い。
    const other = world(START, plain({status: 'STOPPED', code: 'FOLDER_STRUCTURE',
      path: [], childNames: []}));
    await other.ready();
    assert.equal(other.ids['registration-statement-message'].textContent,
      other.ui.TEXT.registrationCodes.FOLDER_STRUCTURE);
    assert.equal(other.ids['registration-statement-message'].className, 'settings-warning');
    assert.deepEqual(lines(other), []);
    assert.equal(other.ids['registration-submit'].disabled, true);

    // missing（NOT_READY）は 1 つずつ文言を並べる。
    const notReady = world(START, plain({status: 'STOPPED', code: 'NOT_READY', path: [],
      missing: ['CUSTOMER_ROOT_FOLDER_ID', 'PARALLEL_WORK_FOLDER_ID'], childNames: []}));
    await notReady.ready();
    assert.equal(notReady.ids['registration-statement-message'].textContent,
      notReady.ui.TEXT.registrationCodes.NOT_READY);
    assert.deepEqual(lines(notReady),
      [notReady.ui.TEXT.registrationCodes.CUSTOMER_ROOT_FOLDER_ID,
        notReady.ui.TEXT.registrationCodes.PARALLEL_WORK_FOLDER_ID]);
    assert.equal(notReady.ids['registration-submit'].disabled, true);

    // 子の名前が HTML でも字のまま出る。
    const evil = '<img src=x onerror=alert(1)>';
    const evilWorld = world(START, plain({status: 'STOPPED', code: 'YEAR_FOLDER_NOT_FOUND',
      path: [], childNames: [evil]}));
    await evilWorld.ready();
    assert.equal(evilWorld.ids['registration-statement-message'].textContent,
      'この顧客フォルダの中に「令和N年分」のフォルダがありません。');
    assert.ok(evilWorld.ids['registration-statement-choices'].textContent
      .indexOf('直下にあるフォルダ：' + evil) >= 0);
    assert.equal(allTags(evilWorld.root, []).indexOf('IMG'), -1);
    assert.equal(allTags(evilWorld.root, []).indexOf('SCRIPT'), -1);
    assert.equal(evilWorld.ids['registration-submit'].disabled, true);

    // 止まった後に READY を返すと 1 行目の class は muted に戻る。
    let count = 0;
    const flip = world(START, () => {
      count += 1;
      return count === 1 ? plain({status: 'STOPPED', code: 'YEAR_FOLDER_NOT_FOUND',
        path: [], childNames: ['架空 第一']}) : plain(READY);
    });
    await flip.ready();
    assert.equal(flip.ids['registration-statement-message'].className, 'settings-warning');
    flip.button('registration-folder-list', '架空 太郎').fire('click');
    await tick();
    assert.equal(flip.ids['registration-statement-message'].className, 'muted');
    assert.equal(flip.ids['registration-statement-message'].textContent, '');
    assert.equal(flip.ids['registration-statement-path'].textContent,
      '☆資料共有フォルダ › 令和8年分 › 経費 › クレジットカード支払い分');
    assert.equal(flip.ids['registration-submit'].disabled, false);
  });
};

if (require.main === module) {
  const tests = [];
  module.exports({assert: require('node:assert/strict'), test: (name, fn) => tests.push(fn)});
  Promise.resolve().then(() => tests[0]()).then(() => console.log('CASE_DONE'))
    .catch((error) => { console.error(error.stack); process.exitCode = 1; });
}

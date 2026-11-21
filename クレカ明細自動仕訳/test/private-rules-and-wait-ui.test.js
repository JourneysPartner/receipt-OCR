'use strict';

/**
 * freee の止めの理由をボタンの横に出す（仕様 §7）と、
 * 取引先の要確認の表の「使用用途」（仕様 §8）。pvru 1〜3。
 *
 * 値はすべて架空。実在の顧客名・ID・明細は書かない。
 */
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

  const CUSTOMER = {customerId: 'K9002', customerName: '架空 花子', canImport: true};
  const DEST = 'dest-pvru-1';
  const NEXT = 'dest-pvru-2';
  const FILE_IDS = ['file-a', 'file-b'];
  const NOW = Date.UTC(2026, 10, 20, 10, 0, 0);

  const FINAL = {
    destinationSpreadsheetId: DEST,
    headers: ['利用日', '金額'],
    amountColumnIndex: 1,
    incomeColumnIndex: null,
    rows: [{rowNumber: 5, status: 'COMMITTED', cells: ['2026/11/01', 1100]}],
    reconciliation: {files: [], totals: {statement: 1100, excluded: 0, corrected: 0,
      written: 1100, residual: 0, balanced: true}, problems: []}
  };

  const CREATED = {
    ok: true, created: true, exportSpreadsheetId: 'export-pvru-1',
    fileName: '架空 花子_20261120-1000_freee取込.xlsx',
    rows: 3, total: 1100, emptyTaxRows: 0, unbalancedAccepted: false,
    problemCount: 0, createdAt: '2026-11-20T10:05:00.000Z', destinationSpreadsheetId: DEST
  };

  function world(extra) {
    const responses = Object.assign({
      webAppFinalReview: plain(FINAL),
      webAppCreateFreeeExport: plain(CREATED)
    }, extra || {});
    const w = browserWorld(responses, {clock: true, now: NOW});
    const {state} = w.ui;
    state.customers = [plain(CUSTOMER)];
    state.selectedCustomerId = CUSTOMER.customerId;
    state.selectedFolderId = 'folder-1';
    state.lastCompletedDestinationSpreadsheetId = DEST;
    state.sessionFileIds = FILE_IDS.slice();
    w.freeeCalls = () => w.calls.filter((call) => call.name === 'webAppCreateFreeeExport');
    w.notice = () => w.ids.notice.textContent;
    w.openFinal = async (destinationId) => {
      if (destinationId) state.lastCompletedDestinationSpreadsheetId = destinationId;
      await w.ui.loadFinalReview();
      await tick();
    };
    w.pressFreee = async () => {
      w.ids['freee-button'].fire('click');
      await tick();
      await tick();
    };
    return w;
  }

  // pvru 1
  asyncTest('pvru 1: 止めの理由をボタンの横に出し、2 つ以上は件数を添え、例外も出す', async () => {
    // 止め 1 つ。ページの上の知らせも今のまま出る。
    const single = world({webAppCreateFreeeExport: plain({
      ok: false, created: false, stage: 'CONTENT', code: 'NO_DATA_ROWS',
      stops: [{code: 'NO_DATA_ROWS'}], rowProblems: [], rowProblemCount: 0,
      destinationSpreadsheetId: DEST})});
    single.ui.renderSelection();
    await single.openFinal();
    await single.pressFreee();
    assert.equal(single.ids['freee-status'].textContent, '作れませんでした：取り込む行がありません。');
    assert.equal(single.ids.notice.children[0].textContent, '取り込む行がありません。');
    assert.equal(single.ids.notice.className.indexOf('error') >= 0, true);
    assert.equal(single.ids['freee-status'].children[0].tagName, '#TEXT',
      '止めの文は文字として入れる');

    // 止め 2 つ。最初の文だけを出し、残りは件数で添える。
    const two = world({webAppCreateFreeeExport: plain({
      ok: false, created: false, stage: 'CONTENT', code: 'NO_DATA_ROWS',
      stops: [{code: 'NO_DATA_ROWS'}, {code: 'WORK_FOLDER_MISSING'}],
      rowProblems: [], rowProblemCount: 0, destinationSpreadsheetId: DEST})});
    two.ui.renderSelection();
    await two.openFinal();
    await two.pressFreee();
    assert.equal(two.ids['freee-status'].textContent,
      '作れませんでした：取り込む行がありません。（ほか 1 件。詳しくはページの一番上）');
    assert.equal(two.ids.notice.children[0].textContent,
      '取り込む行がありません。\n作業用フォルダが設定されていないため、freee 取込用を作れません。');

    // 例外。知らせと同じ文をボタンの横にも出す。
    const failed = world({webAppCreateFreeeExport: () => new Error('架空の通信失敗')});
    failed.ui.renderSelection();
    await failed.openFinal();
    await failed.pressFreee();
    assert.equal(failed.ids['freee-status'].textContent, '作れませんでした：架空の通信失敗');
    assert.equal(failed.notice(), '架空の通信失敗');

    // HTML として解釈されない（`<b>` は文字のまま）。
    const literal = world({webAppCreateFreeeExport: plain({
      ok: false, created: false, stage: 'CONTENT', code: '<b>架空の停止</b>',
      stops: [{code: '<b>架空の停止</b>'}], rowProblems: [], rowProblemCount: 0,
      destinationSpreadsheetId: DEST})});
    literal.ui.renderSelection();
    await literal.openFinal();
    await literal.pressFreee();
    assert.ok(literal.ids['freee-status'].textContent.indexOf('<b>架空の停止</b>') >= 0,
      literal.ids['freee-status'].textContent);
    assert.equal(literal.root.querySelectorAll('b').length, 0);
    assert.equal(literal.ui.state.freeeBusy, false);
  });

  // pvru 2
  asyncTest('pvru 2: 戻る・作り直し・返事を捨てるときは今のまま', async () => {
    // 確かめの画面で「戻る」：ボタンの横は空のまま。
    const confirmReply = {
      ok: false, created: false, stage: 'CONFIRM', code: 'UNBALANCED',
      stops: [{code: 'UNBALANCED', problemCount: 1}],
      rowProblems: [], rowProblemCount: 0, destinationSpreadsheetId: DEST
    };
    const back = world({webAppCreateFreeeExport: () => plain(confirmReply)});
    back.ui.renderSelection();
    await back.openFinal();
    back.ids['freee-button'].fire('click');
    await tick();
    assert.equal(back.ids['confirm-dialog'].open, true);
    back.ids['confirm-cancel'].fire('click');
    await tick();
    assert.equal(back.ids['freee-status'].textContent, '');
    assert.equal(back.ui.state.freeeBusy, false);

    // 作れたときは今のまま。作り直し（resetFreeeExport）で消える。
    const created = world();
    created.ui.renderSelection();
    await created.openFinal();
    await created.pressFreee();
    assert.ok(created.ids['freee-status'].textContent.indexOf('freee 取込用ができました（3 行）') >= 0,
      created.ids['freee-status'].textContent);
    created.ui.resetFreeeExport();
    assert.equal(created.ids['freee-status'].textContent, '');

    // 返事を捨てる場面（転記先を選び直した）は何も書かない。
    const stale = world({webAppCreateFreeeExport: () => ({defer: true})});
    stale.ui.renderSelection();
    await stale.openFinal();
    stale.ids['freee-button'].fire('click');
    await tick();
    await stale.ui.chooseDestination({destinationSpreadsheetId: NEXT, fileIds: ['file-c']});
    await tick();
    stale.pending[0].reply(plain({
      ok: false, created: false, stage: 'CONTENT', code: 'NO_DATA_ROWS',
      stops: [{code: 'NO_DATA_ROWS'}], destinationSpreadsheetId: DEST}));
    await tick();
    assert.equal(stale.ids['freee-status'].textContent, '');

    // フォルダを選び直すと、できた後の表示も消える（今のまま）。
    const chosen = world();
    chosen.ui.renderSelection();
    await chosen.openFinal();
    await chosen.pressFreee();
    assert.notEqual(chosen.ids['freee-status'].textContent, '');
    await chosen.ui.chooseDestination({destinationSpreadsheetId: NEXT, fileIds: []});
    await tick();
    assert.equal(chosen.ids['freee-status'].textContent, '');
  });

  // pvru 3
  asyncTest('pvru 3: 要確認の表の「使用用途」が摘要のすぐ後に出て、値は文字のまま', async () => {
    const w = browserWorld({});
    const {state, renderSelection} = w.ui;
    const reviews = [
      {reviewId: 'r1', fileId: 'f1', fileName: '架空明細.csv', sourceRow: 2,
        usageDate: '2026-01-05', amount: 100, merchantOriginal: '架空店A',
        purpose: '<b>架空用途</b>', candidates: [], exclude: {enabled: true}},
      {reviewId: 'r2', fileId: 'f1', fileName: '架空明細.csv', sourceRow: 3,
        usageDate: '2026-01-06', amount: 200, merchantOriginal: '架空店B',
        purpose: null, candidates: [], exclude: {enabled: true}},
      {reviewId: 'r3', fileId: 'f1', fileName: '架空明細.csv', sourceRow: 4,
        usageDate: '2026-01-07', amount: 300, merchantOriginal: '架空店C',
        purpose: '', candidates: [], exclude: {enabled: true}}
    ];
    Object.assign(state, {reviews: reviews, partnerTotal: reviews.length,
      customers: [plain(CUSTOMER)], selectedCustomerId: CUSTOMER.customerId});
    renderSelection();
    const table = w.ids['review-table'];
    const headers = table.querySelector('tr').children.map((cell) => cell.textContent);
    const summary = headers.indexOf('摘要（元店名）');
    assert.ok(summary >= 0, JSON.stringify(headers));
    assert.equal(headers[summary + 1], '使用用途', JSON.stringify(headers));

    const rows = table.querySelectorAll('tr').slice(1);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].children[4].textContent, '<b>架空用途</b>');
    assert.equal(rows[1].children[4].textContent, '');
    assert.equal(rows[2].children[4].textContent, '');
    assert.ok(table.textContent.indexOf('<b>架空用途</b>') >= 0, table.textContent);
    assert.equal(w.root.querySelectorAll('b').length, 0, 'HTML として解釈しない');

    // 絞り込みは今のまま（摘要・ファイル名・フォルダ名で見る）。
    state.reviewFilter = '架空店A';
    renderSelection();
    const filtered = table.querySelectorAll('tr').slice(1);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].children[4].textContent, '<b>架空用途</b>');
  });
};

if (require.main === module) {
  const tests = [];
  module.exports({assert: require('node:assert/strict'), test: (name, fn) => tests.push(fn)});
  Promise.resolve().then(() => tests[0]()).then(() => console.log('CASE_DONE'))
    .catch((error) => { console.error(error.stack); process.exitCode = 1; });
}

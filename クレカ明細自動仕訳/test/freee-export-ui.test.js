'use strict';

/**
 * 最終確認の「freee 取込用 Excel」（仕様 §4・§6.2 の fxu 1〜9）。
 * 値はすべて架空。本番の ID・名前は書かない。
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

  const CUSTOMER = {customerId: 'K9001', customerName: '架空 太郎', canImport: true};
  const DEST = 'dest-freee-1';
  const NEXT = 'dest-freee-2';
  const FILE_IDS = ['file-a', 'file-b'];
  const NOW = Date.UTC(2026, 10, 15, 10, 0, 0);

  // 最終確認が今のもの（balanced: true）である返事。
  const FINAL = {
    destinationSpreadsheetId: DEST,
    headers: ['利用日', '金額'],
    amountColumnIndex: 1,
    incomeColumnIndex: null,
    rows: [{rowNumber: 5, status: 'COMMITTED', cells: ['2026/11/01', 1100]}],
    reconciliation: {files: [], totals: {statement: 1100, excluded: 0, corrected: 0,
      written: 1100, residual: 0, balanced: true}, problems: []}
  };

  // できたときの返事（§3.13）。
  const CREATED = {
    ok: true, created: true, exportSpreadsheetId: 'export-freee-1',
    fileName: '架空 太郎_20261115-1000_freee取込.xlsx',
    rows: 3, total: 1100, emptyTaxRows: 1, unbalancedAccepted: false,
    problemCount: 0, createdAt: '2026-11-15T10:05:00.000Z', destinationSpreadsheetId: DEST
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
    w.finalCalls = () => w.calls.filter((call) => call.name === 'webAppFinalReview');
    w.notice = () => w.ids.notice.textContent;
    w.noticeItems = () => w.ids.notice.children
      .filter((child) => child.tagName === 'UL')
      .reduce((items, list) => items.concat(list.children.map((item) => item.textContent)), []);
    // 最終確認を開いた状態にする（freee-button の条件もここで更新される）。
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

  // fxu 1
  asyncTest('fxu 1: 最終確認を開くまで押せず、開くと押せ、作っている間は押せない', async () => {
    const w = world();
    w.ui.renderSelection();
    assert.equal(w.ui.state.finalReviewedFor, null);
    assert.equal(w.ids['freee-button'].disabled, true);
    w.ids['freee-button'].fire('click');
    await tick();
    assert.equal(w.freeeCalls().length, 0);

    await w.openFinal();
    assert.equal(w.ids['final-panel'].hidden, false);
    assert.equal(w.ids['freee-button'].disabled, false);

    // 作っている間（返事を待つ間）は押せない。
    const busy = world({webAppCreateFreeeExport: () => ({defer: true})});
    busy.ui.renderSelection();
    await busy.openFinal();
    assert.equal(busy.ids['freee-button'].disabled, false);
    busy.ids['freee-button'].fire('click');
    await tick();
    assert.equal(busy.freeeCalls().length, 1);
    assert.equal(busy.ui.state.freeeBusy, true);
    assert.equal(busy.ids['freee-button'].disabled, true);
    busy.ids['freee-button'].fire('click');
    await tick();
    assert.equal(busy.freeeCalls().length, 1);
    busy.pending[0].reply(plain(CREATED));
    await tick();
    assert.equal(busy.ui.state.freeeBusy, false);
    assert.equal(busy.ids['freee-button'].disabled, false);
  });

  // fxu 2
  asyncTest('fxu 2: 押すと 4 つの引数で呼び、できた後にダウンロードを開く', async () => {
    const w = world();
    w.ui.renderSelection();
    await w.openFinal();
    await w.pressFreee();

    const calls = w.freeeCalls();
    assert.equal(calls.length, 1);
    assert.deepEqual(plain(calls[0].args),
      [CUSTOMER.customerId, DEST, FILE_IDS, {acceptUnbalanced: false}]);
    assert.deepEqual(plain(w.ui.state.freeeExport),
      {exportSpreadsheetId: 'export-freee-1', destinationId: DEST,
        createdAtMs: NOW, rows: 3});
    const status = w.ids['freee-status'].textContent;
    assert.ok(status.indexOf('freee 取込用ができました（3 行）。［ダウンロード］を押してください。') >= 0, status);
    assert.ok(status.indexOf('税区分が空の行が 1 行あります（freee が勘定科目の税区分を使います）。') >= 0, status);
    assert.equal(status.indexOf('明細と一致しないまま作りました。'), -1);
    assert.equal(w.ids['freee-download'].hidden, false);

    w.ids['freee-download'].fire('click');
    assert.deepEqual(w.openedWindows, [[
      'https://docs.google.com/spreadsheets/d/export-freee-1/export?format=xlsx', '_blank']]);
    assert.match(w.ids['freee-status'].textContent, /^freee 取込用 ダウンロード \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/,
      w.ids['freee-status'].textContent);
    assert.equal(w.openedWindows.length, 1);
  });

  // fxu 3
  asyncTest('fxu 3: 不一致は確かめてから、承知したときだけ acceptUnbalanced: true で呼ぶ', async () => {
    const confirmReply = {
      ok: false, created: false, stage: 'CONFIRM', code: 'UNBALANCED',
      stops: [{code: 'UNBALANCED', problemCount: 2,
        problemKinds: {MISSING: 1, DUPLICATE: 1}, residual: 1100}],
      rowProblems: [], rowProblemCount: 0, destinationSpreadsheetId: DEST
    };

    // 「戻る」：2 回目を呼ばない。
    let backReplies = [plain(confirmReply), plain(CREATED)];
    const back = world({webAppCreateFreeeExport: () => backReplies.shift()});
    back.ui.renderSelection();
    await back.openFinal();
    back.ids['freee-button'].fire('click');
    await tick();
    assert.equal(back.freeeCalls().length, 1);
    assert.equal(back.ids['confirm-dialog'].open, true);
    assert.equal(back.ids['confirm-title'].textContent, 'freee 取込用 Excel');
    const intro = back.ids['confirm-intro'].textContent;
    assert.ok(intro.indexOf('問題 2 件') >= 0, intro);
    assert.ok(intro.indexOf('それでも作りますか？') >= 0, intro);
    back.ids['confirm-cancel'].fire('click');
    await tick();
    assert.equal(back.freeeCalls().length, 1);
    assert.equal(back.ids['freee-download'].hidden, true);
    assert.equal(back.ids['freee-status'].textContent, '');
    assert.equal(back.ui.state.freeeBusy, false);

    // 「実行する」：同じ引数で acceptUnbalanced: true。
    let acceptReplies = [plain(confirmReply), Object.assign(plain(CREATED), {unbalancedAccepted: true})];
    const accept = world({webAppCreateFreeeExport: () => acceptReplies.shift()});
    accept.ui.renderSelection();
    await accept.openFinal();
    accept.ids['freee-button'].fire('click');
    await tick();
    assert.equal(accept.freeeCalls().length, 1);
    accept.ids['confirm-submit'].fire('click');
    await tick();
    await tick();
    await tick();
    assert.equal(accept.freeeCalls().length, 2);
    assert.deepEqual(plain(accept.freeeCalls()[1].args),
      [CUSTOMER.customerId, DEST, FILE_IDS, {acceptUnbalanced: true}]);
    assert.deepEqual(plain(accept.freeeCalls()[0].args),
      [CUSTOMER.customerId, DEST, FILE_IDS, {acceptUnbalanced: false}]);
    assert.equal(accept.ids['freee-download'].hidden, false);
    assert.ok(accept.ids['freee-status'].textContent.indexOf('明細と一致しないまま作りました。') >= 0,
      accept.ids['freee-status'].textContent);
    assert.equal(accept.ui.state.freeeBusy, false);
  });

  // fxu 4
  asyncTest('fxu 4: 止めた本文と行の明細（hint を含む）を出し、ダウンロードは出さない', async () => {
    const stopReply = {
      ok: false, created: false, stage: 'CONTENT', code: 'ROW_PROBLEMS',
      stops: [{code: 'ROW_PROBLEMS', count: 2}],
      rowProblems: [
        {importRow: 2, kind: 'TAX_NAME_UNKNOWN', column: 'P', value: '課対仕入',
          hint: {code: 'RATE_MISSING', suggestions: ['課対仕入10%', '課対仕入8%（軽）']},
          date: '2026/11/01', amount: 1200, description: '架空の店'},
        {importRow: 3, kind: 'ACCOUNT_EMPTY', column: 'D', value: null, hint: null,
          date: '2026/11/02', amount: 300, description: ''}
      ],
      rowProblemCount: 35, destinationSpreadsheetId: DEST
    };
    const w = world({webAppCreateFreeeExport: plain(stopReply)});
    w.ui.renderSelection();
    await w.openFinal();
    await w.pressFreee();

    assert.equal(w.freeeCalls().length, 1);
    assert.equal(w.ids.notice.children[0].textContent, '直す必要のある行が 2 件あります（下の一覧）。');
    assert.equal(w.ids.notice.className.indexOf('error') >= 0, true);
    const items = w.noticeItems();
    assert.equal(items.length, 3);
    assert.ok(items[0].indexOf('取込用 2 行目') >= 0, items[0]);
    assert.ok(items[0].indexOf('2026/11/01') >= 0, items[0]);
    assert.ok(items[0].indexOf('¥1,200') >= 0, items[0]);
    assert.ok(items[0].indexOf('架空の店') >= 0, items[0]);
    assert.ok(items[0].indexOf('税区分「課対仕入」は freee にありません。') >= 0, items[0]);
    assert.ok(items[0].indexOf('率がありません') >= 0, items[0]);
    assert.ok(items[0].indexOf('課対仕入10%') >= 0, items[0]);
    assert.ok(items[1].indexOf('取込用 3 行目') >= 0, items[1]);
    assert.ok(items[1].indexOf('D 列の勘定科目が空です') >= 0, items[1]);
    assert.ok(items[1].indexOf('摘要なし') >= 0, items[1]);
    assert.equal(items[2], 'ほか 33 件');
    assert.equal(w.ids['freee-download'].hidden, true);
    assert.equal(w.ids['freee-status'].textContent,
      '作れませんでした：直す必要のある行が 2 件あります。（詳しくはページの一番上）');
    assert.equal(w.ui.state.freeeBusy, false);
  });

  // fxu 5
  asyncTest('fxu 5: 返事の前に転記先を選び直したら、その返事を捨てる', async () => {
    const w = world({webAppCreateFreeeExport: () => ({defer: true})});
    w.ui.renderSelection();
    await w.openFinal();
    w.ids['freee-button'].fire('click');
    await tick();
    assert.equal(w.freeeCalls().length, 1);
    assert.equal(w.ui.state.freeeBusy, true);

    await w.ui.chooseDestination({destinationSpreadsheetId: NEXT, fileIds: ['file-c']});
    await tick();
    assert.equal(w.ui.state.selectedCustomerId, CUSTOMER.customerId);
    assert.equal(w.ui.state.lastCompletedDestinationSpreadsheetId, NEXT);
    assert.equal(w.ui.state.freeeBusy, false);

    w.pending[0].reply(plain(CREATED));
    await tick();
    await tick();
    assert.equal(w.ids['freee-download'].hidden, true);
    assert.equal(w.ui.state.freeeExport, null);
    assert.equal(w.ids['freee-status'].textContent, '');
  });

  // fxu 6
  asyncTest('fxu 6: 最終確認が古くなる・転記先を選び直すと、ダウンロードを消す', async () => {
    const stale = world();
    stale.ui.renderSelection();
    await stale.openFinal();
    await stale.pressFreee();
    assert.equal(stale.ids['freee-download'].hidden, false);
    stale.ui.markFinalReviewStale();
    assert.equal(stale.ui.state.finalReviewedFor, null);
    assert.equal(stale.ids['freee-download'].hidden, true);
    assert.equal(stale.ids['freee-status'].textContent, '');
    assert.equal(stale.ui.state.freeeExport, null);
    stale.ids['freee-download'].fire('click');
    assert.equal(stale.openedWindows.length, 0);

    const chosen = world();
    chosen.ui.renderSelection();
    await chosen.openFinal();
    await chosen.pressFreee();
    assert.equal(chosen.ids['freee-download'].hidden, false);
    await chosen.ui.chooseDestination({destinationSpreadsheetId: NEXT, fileIds: []});
    await tick();
    assert.equal(chosen.ids['freee-download'].hidden, true);
    assert.equal(chosen.ids['freee-status'].textContent, '');
    assert.equal(chosen.ui.state.freeeExport, null);
    chosen.ids['freee-download'].fire('click');
    assert.equal(chosen.openedWindows.length, 0);
  });

  // fxu 7
  asyncTest('fxu 7: 30 分を過ぎたダウンロードは開かず、作り直しを促す', async () => {
    const w = world();
    w.ui.renderSelection();
    await w.openFinal();
    await w.pressFreee();
    assert.equal(w.ids['freee-download'].hidden, false);

    w.advance(30 * 60 * 1000);
    w.ids['freee-download'].fire('click');
    assert.equal(w.openedWindows.length, 1, 'ちょうど 30 分はまだ開ける');

    w.advance(60 * 1000);
    w.ids['freee-download'].fire('click');
    assert.equal(w.openedWindows.length, 1, '30 分を過ぎたら開かない');
    assert.equal(w.notice(),
      '作ってから 30 分たちました。もう一度［freee 取込用 Excel を作る］を押してください。');
    assert.equal(w.ids['freee-download'].hidden, true);
    assert.equal(w.ui.state.freeeExport, null);
  });

  // fxu 8
  asyncTest('fxu 8: window.open が null なら exportBlocked のお知らせを出す', async () => {
    const w = world();
    w.ui.renderSelection();
    await w.openFinal();
    await w.pressFreee();
    w.setWindowOpenResult(null);
    w.ids['freee-download'].fire('click');
    assert.equal(w.openedWindows.length, 1);
    assert.equal(w.notice(), w.ui.TEXT.exportBlocked);
    assert.equal(w.ids.notice.className.indexOf('warning') >= 0, true);
    // 開けなかっただけで、作り直しは求めない（もう一度押せる）。
    assert.equal(w.ids['freee-download'].hidden, false);
    assert.notEqual(w.ui.state.freeeExport, null);
  });

  // fxu 9
  asyncTest('fxu 9: 今の Excel ダウンロードは転記シートの export を開く', async () => {
    const w = world();
    w.ui.renderSelection();
    await w.openFinal();
    assert.equal(w.ids['excel-button'].disabled, false);
    w.ids['excel-button'].fire('click');
    assert.deepEqual(w.openedWindows, [[
      'https://docs.google.com/spreadsheets/d/' + DEST + '/export?format=xlsx', '_blank']]);
    assert.match(w.ids['excel-status'].textContent, /^Excel作成済み /);
    assert.equal(w.ids['freee-status'].textContent, '');
    assert.equal(w.freeeCalls().length, 0);
  });

  // fxu 10
  asyncTest('fxu 10: 入力用の金額が読めない止めは、行と列を出す', async () => {
    const stopReply = {
      ok: false, created: false, stage: 'CONTENT', code: 'INPUT_AMOUNT_INVALID',
      stops: [{code: 'INPUT_AMOUNT_INVALID', count: 3,
        rows: [{inputRow: 12, column: 'M'}, {inputRow: 15, column: 'L'}]}],
      rowProblems: [], rowProblemCount: 0, destinationSpreadsheetId: DEST
    };
    const w = world({webAppCreateFreeeExport: plain(stopReply)});
    w.ui.renderSelection();
    await w.openFinal();
    await w.pressFreee();

    assert.equal(w.freeeCalls().length, 1);
    assert.equal(w.ids.notice.className.indexOf('error') >= 0, true);
    const message = w.ids.notice.children[0].textContent;
    assert.ok(message.indexOf('12 行目（M 列）') >= 0, message);
    assert.ok(message.indexOf('15 行目（L 列）') >= 0, message);
    assert.ok(message.indexOf('ほか 1 件') >= 0, message);
    assert.equal(message.indexOf('行は不明'), -1);
    assert.equal(w.noticeItems().length, 0);
    assert.equal(w.ids['freee-download'].hidden, true);
    assert.equal(w.ids['freee-status'].textContent,
      '作れませんでした：入力用シートの借方・貸方に数として読めない値があります' +
      '（12 行目（M 列）・15 行目（L 列）・ほか 1 件）。');
    assert.equal(w.ui.state.freeeBusy, false);
  });
};

if (require.main === module) {
  const tests = [];
  module.exports({assert: require('node:assert/strict'), test: (name, fn) => tests.push(fn)});
  Promise.resolve().then(() => tests[0]()).then(() => console.log('CASE_DONE'))
    .catch((error) => { console.error(error.stack); process.exitCode = 1; });
}

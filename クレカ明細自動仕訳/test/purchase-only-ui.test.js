'use strict';

/**
 * 形式の確認パネルの「仕入れ専用」の 1 行（spec_purchase_only.md §5.2・§9.2 の psou 1〜3）。
 * 値はすべて架空。実在の顧客・カード・明細は使わない。
 */
const fs = require('node:fs');
const path = require('node:path');
const {browserWorld} = require('./kw26-ui-helpers');

module.exports = ({test, assert}) => {
  const PURCHASE_LINE = '「仕入れ専用」のファイルです。使用用途の列は選ばなくても登録できます。' +
    '取り込むと全行の使用用途が「仕入れ」になります。';
  const ABSENT_LINE = '「仕入れ専用」のファイルなので、使用用途の列が無くても読めます。' +
    '取り込むと全行の使用用途が「仕入れ」になります。';

  function diagnosis(overrides) {
    const columns = Object.fromEntries(['date', 'merchant', 'amount', 'purpose', 'amountFallback']
      .map((role, index) => [role, {column: ['A', 'B', 'C', 'D', null][index], source: 'HEADER'}]));
    return Object.assign({ok: true, verdict: 'NEW', fileId: 'fictional_target',
      fileName: '架空カード明細202602', sheetName: '明細', width: 5, warnings: [],
      customerSide: false, purchaseOnly: false,
      grid: {columnLetters: ['A', 'B', 'C', 'D', 'E'], rowNumbers: [1, 2, 3],
        cells: [['日付', '店名', '金額', '使用用途', '予備'],
          ['2026/2/1', '架空ストア', '100', '食費', '200'],
          ['2026/2/2', '架空ストア', '300', '雑費', '400']]},
      proposal: {baseFormatId: null, formatId: 'fictional_new', formatName: '架空の新形式',
        sheetName: '明細', headerRow: 1, dataStartRow: 2, columns,
        amountCandidates: [{column: 'C', header: '金額'}, {column: 'E', header: '予備'}]}},
    overrides || {});
  }

  function mounted(overrides) {
    const world = browserWorld();
    const state = world.ui.state;
    state.selectedCustomerId = 'C9001'; state.selectedFolderId = 'card_fictional';
    state.formatFileId = 'fictional_target';
    state.formatDiagnosis = diagnosis(overrides);
    const proposal = state.formatDiagnosis.proposal;
    state.formatAnswers = {baseFormatId: proposal.baseFormatId, formatId: proposal.formatId,
      formatName: proposal.formatName, sheetName: proposal.sheetName, headerRow: proposal.headerRow,
      dataStartRow: proposal.dataStartRow,
      columns: Object.fromEntries(Object.entries(proposal.columns).map(([key, value]) => [key, value.column])),
      acknowledgements: {customerSide: true, amountChoice: true}};
    state.formatPreview = {previewHash: 'hash', blocking: [],
      extraction: {count: 2, total: 400, category: {category: 2}, rows: [], excluded: [],
        billing: {}, year: {yearless: 0, inferred: 0, reviewRows: 0}}, amountComparison: []};
    state.formatHash = 'hash';
    world.ui.renderFormatPanel();
    return world;
  }

  function lines(world) {
    return world.ids['format-body'].querySelectorAll('p')
      .filter((node) => node.textContent.includes('仕入れ専用'));
  }

  test('psou 1: the purchase-only line appears only when the diagnosis is purchase only', () => {
    const yes = mounted({purchaseOnly: true});
    assert.ok(yes.ids['format-body'].textContent.includes(PURCHASE_LINE));
    assert.equal(lines(yes).filter((node) => node.textContent === PURCHASE_LINE).length, 1);
    const no = mounted({purchaseOnly: false});
    assert.equal(no.ids['format-body'].textContent.includes('仕入れ専用'), false);
  });

  test('psou 2: the absent purpose column line follows the matched format line only when flagged', () => {
    const matched = {formatId: 'fictional_active', formatName: '架空の登録済み形式', sheetName: '明細'};
    const yes = mounted({verdict: 'MATCHES_ACTIVE', purchaseOnly: true,
      purposeColumnAbsent: true, matched});
    const body = yes.ids['format-body'];
    assert.ok(body.textContent.includes(ABSENT_LINE));
    assert.ok(body.textContent.indexOf('このファイルは、登録済みの形式「架空の登録済み形式」で読めます') <
      body.textContent.indexOf(ABSENT_LINE));
    assert.ok(body.querySelectorAll('button').some((node) => node.textContent === '登録済みの形式で再検査する'));
    const no = mounted({verdict: 'MATCHES_ACTIVE', purchaseOnly: true, matched});
    assert.equal(no.ids['format-body'].textContent.includes('使用用途の列が無くても読めます'), false);
    assert.ok(no.ids['format-body'].querySelectorAll('button')
      .some((node) => node.textContent === '登録済みの形式で再検査する'));
  });

  test('psou 3: the purchase-only lines go through textContent and render as plain text', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', '81_WebAppUi.html'), 'utf8');
    const panel = /function renderFormatPanel\(\) \{[\s\S]*?(?=\n    function )/.exec(source);
    assert.ok(panel, 'renderFormatPanel が必要');
    assert.doesNotMatch(panel[0], /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    const world = mounted({verdict: 'MATCHES_ACTIVE', purchaseOnly: true, purposeColumnAbsent: true,
      matched: {formatId: 'fictional_active', formatName: '架空の登録済み形式', sheetName: '明細'}});
    for (const property of ['innerHTML', 'outerHTML', 'innerText'])
      Object.defineProperty(world.Node.prototype, property,
        {set() { assert.fail('文字の代入は textContent を使う'); }});
    world.ui.renderFormatPanel();
    const rendered = lines(world);
    assert.equal(rendered.length, 2);
    rendered.forEach((node) => {
      assert.equal(node.children.length, 1);
      assert.equal(node.firstChild.tagName, '#TEXT');
      assert.equal(node.querySelectorAll('img').length, 0);
    });
  });
};

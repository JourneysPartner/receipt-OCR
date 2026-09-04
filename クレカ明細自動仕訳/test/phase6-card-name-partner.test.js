'use strict';

/**
 * 年会費の取引先をカード名で決める（実装差戻し#31）。
 *
 * カード年会費はカード会社が相手だが、**明細の店名にカード会社は現れない**
 * （「基本カード年会費」「消費税」等）。しかもその文字列はどのカードでも
 * 同じなので、店名で辞書を作ると**全カードの年会費が1つの取引先へ潰れる**。
 * カード単位で決まることを検査する。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const blank = (n) => Array(n).fill('');
  const sheetHeader = (n, label) => { const r = blank(n); r[0] = label; return r; };
  const AE = JSON.stringify({row: 1, cells: [{column: 2, text: '利用日', match: 'exact'}]});

  // フォルダ名が最優先、無ければ1行目のカード名セル。実運用では顧客が
  // カードごとにフォルダを作るので、前者がほぼ常に効く。
  const CARD_NAME_RULE = {sources: [{kind: 'folderName'}, {kind: 'cell', row: 1, column: 3}]};

  function customerRow(options) {
    const row = blank(40);
    Object.assign(row, {
      0: 'C001', 1: '顧客A', 2: 'TRUE', 3: 'folder1', 5: 'dest1', 7: '入力用シート', 8: '取引先一覧',
      9: 2, 10: 3, 11: 4, 12: 5, 13: 6, 14: 7, 15: '1.0',
      16: 'reviewer@example.com', 17: 'admin@example.com', 18: 0, 20: 'システム情報', 21: '',
      23: 0, 24: 0, 29: 1, 30: AE, 31: '{}', 32: '{}', 33: 8,
      34: '取引先一覧', 35: 'CORPORATE', 36: '', 38: '',
      39: options && options.cardNamePartnerPurposes
        ? JSON.stringify(options.cardNamePartnerPurposes) : ''
    });
    return row;
  }

  /** 三井住友系と同じ形：1行目に名義・カード番号・カード名。 */
  function formatRow(options) {
    const row = blank(35);
    Object.assign(row, {
      0: 'smbc_family', 1: '三井住友系', 2: 'active', 3: 'TRUE', 4: '["csv"]',
      5: JSON.stringify({allOf: [{maxRow: 1, keywords: ['様'], minMatch: 1}]}),
      6: 1, 7: 2, 8: 'A', 9: 'B', 10: 'C', 11: 'D', 12: '',
      14: JSON.stringify({excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []}),
      16: JSON.stringify({sources: [{id: 'fn', kind: 'fileName', pattern: '(20\\d{2})(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}]}),
      17: 'generic', 18: 1, 19: 'admin@example.com', 21: '2026-01-01T00:00:00+09:00',
      29: 'NEW', 33: '2026-01-01T00:00:00+09:00',
      34: options && options.withCardNameRule === false ? '' : JSON.stringify(CARD_NAME_RULE)
    });
    return row;
  }

  // 金額をカードごとに変える ── 内容が同一だと取引同一性ハッシュが一致し、
  // 2件目が重複として弾かれる（ここで見たいのはそこではない）。
  const statement = (cardName, amount) =>
    `〇〇　〇〇　様,4980-00**-****-****,${cardName},\n` +
    `2025/12/16,基本カード年会費,${amount},年会費\n` +
    `2025/12/17,ローソン,${amount / 100},仕入れ\n`;

  function setup(options) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [sheetHeader(40, '顧客ID'), customerRow(options)]},
      {name: 'カード形式マスター', values: [sheetHeader(35, '形式ID'), formatRow(options)]},
      {name: '使用用途補完マスター', values: [sheetHeader(10, 'ルールID')]},
      {name: '共通取引先辞書', values: [sheetHeader(18, '辞書ID')]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート',
       values: [['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID', '']],
       maxRows: 40, maxColumns: 8},
      {name: '取引先一覧', values: [['元店名', '取引先名'], ['ローソン', '株式会社ローソン']]}
    ]});
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createSpreadsheet('snap', {sheets: []});
    gas.evaluate(`
      SETTINGS.EXECUTION_TIMEOUT_SECONDS = 300;
      SETTINGS.SAFETY_MARGIN_SECONDS = 60;
      SETTINGS.TX_INDEX_SPREADSHEET_ID = 'txidx';
      SETTINGS.SNAPSHOT_SPREADSHEET_ID = 'snap';
      SETTINGS.SAMPLE_CORPUS_FOLDER_ID = 'corpus';
      SETTINGS.PARALLEL_WORK_FOLDER_ID = '';
      SETTINGS.FAULT_INJECTION = null;
    `);
    gas.stubs.setActiveUser('admin@example.com');

    [['fileA', 'ＡＭＥＸゴールド', 75000], ['fileB', 'ＪＣＢカードＷ', 11000]]
      .forEach(([id, cardName, amount]) => {
      gas.stubs.createFile(id, {
        name: `明細202601_${id}.csv`, bytes: Buffer.from(statement(cardName, amount), 'utf8'),
        lastUpdated: new Date(Date.now() - 3600 * 1000),
        createdTime: '2026-08-01T00:00:00Z', contentType: 'text/csv'
      });
    });
    if (options && options.useCardFolders) {
      gas.stubs.createFolder('cardA', {name: 'ＡＭＥＸ・ビジネス・ゴールド', fileIds: ['fileA']});
      gas.stubs.createFolder('cardB', {name: 'ＪＣＢカードＷ（家族）', fileIds: ['fileB']});
      gas.stubs.createFolder('folder1', {subFolderIds: ['cardA', 'cardB']});
    } else {
      gas.stubs.createFolder('folder1', {fileIds: ['fileA', 'fileB']});
    }
    return plain(gas.call('runImport', [{}]));
  }

  const normalizeMerchantFor = (v) => String(v === null || v === undefined ? '' : v);
  const destSheet = () => gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
  const decisionSheet = () =>
    gas.stubs.getSpreadsheet('master').getSheetByName('取引先判断（運用）');

  function decisionRowFor(merchant) {
    const values = decisionSheet().getDataRange().getValues();
    for (let i = 1; i < values.length; i += 1) {
      if (String(values[i][1]) === merchant) return i + 1;
    }
    throw new Error('決定行が見つからない: ' + merchant);
  }

  test('resolveCardName reads the card name from where the format says it is', () => {
    const sheet = {name: 'アメックス202512', rows: [
      ['〇〇　様', '4980-00**', 'ＡＭＥＸゴールド', ''],
      ['2025/12/16', '基本カード年会費', 75000, '年会費']
    ]};
    const ctx = {fileName: '202512.xlsx', folderName: null};
    assert.equal(gas.call('resolveCardName', [sheet, {cardNameRule: CARD_NAME_RULE}, ctx]),
      'ＡＭＥＸゴールド');

    // シート名からも取れる（「カード名＋4桁以上の数字」に限る）。
    const byName = {sources: [{kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]};
    assert.equal(gas.call('resolveCardName', [sheet, {cardNameRule: byName}, ctx]), 'アメックス');
    // 汎用のシート名は取らない ── 別カードの明細に同じ名前が付くため。
    assert.equal(gas.call('resolveCardName',
      [{name: '25年12月請求分', rows: []}, {cardNameRule: byName}, ctx]), null);
    // 取得元が無い形式は null。呼出側は通常どおり要確認へ回す。
    assert.equal(gas.call('resolveCardName', [sheet, {}, ctx]), null);

    // フォルダ名が最も確実 ── 汎用のシート名しか無いファイルでもカードが
    // 分かる。順序どおり、フォルダ名があればそれを採る。
    const withFolder = {sources: [{kind: 'folderName'},
      {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]};
    assert.equal(gas.call('resolveCardName', [{name: '25年12月請求分', rows: []},
      {cardNameRule: withFolder}, {fileName: 'x.xlsx', folderName: 'ＡＭＥＸゴールド'}]),
      'ＡＭＥＸゴールド');
    // ルート直下（フォルダ名なし）では次の取得元へ落ちる。顧客フォルダの
    // 名前をカード名にしてはならない。
    assert.equal(gas.call('resolveCardName', [sheet,
      {cardNameRule: withFolder}, {fileName: 'x.xlsx', folderName: null}]), 'アメックス');
  });

  test('the annual fee review asks about the card, not the generic merchant', () => {
    setup({cardNamePartnerPurposes: ['年会費']});
    const merchants = plain(gas.call('openReviews', [{}]))
      .map((review) => review.merchantOriginal).sort();
    // 年会費2件はカード名で立ち、通常の明細（ローソン）は店名のまま。
    assert.deepEqual(merchants,
      ['ローソン', 'ローソン', 'ＡＭＥＸゴールド', 'ＪＣＢカードＷ'].sort(),
      JSON.stringify(merchants));

    // K列（元店名）へ書く値は変えない。判断材料と記録は別物である。
    const memos = destSheet().getDataRange().getValues().slice(1)
      .filter((r) => String(r[6] || '').indexOf('TX_') === 0).map((r) => r[4]);
    assert.equal(memos.filter((m) => m === '基本カード年会費').length, 2);
  });

  test('each card gets its own partner for the same annual-fee merchant', () => {
    setup({cardNamePartnerPurposes: ['年会費']});
    gas.call('opsListPartnerReviews', []);
    decisionSheet().getRange(decisionRowFor('ＡＭＥＸゴールド'), 6).setValue('AMEX');
    decisionSheet().getRange(decisionRowFor('ＪＣＢカードＷ'), 6).setValue('JCB');

    const summary = plain(gas.call('opsApplyPartnerDecisions', []));
    assert.equal(summary.errors, 0, JSON.stringify(summary.results));
    assert.equal(summary.resolvedReviews, 2);

    // 同じ「基本カード年会費」がカードごとに違う取引先へ解決される。
    const rows = destSheet().getDataRange().getValues().slice(1)
      .filter((r) => r[4] === '基本カード年会費');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r[2]).sort(), ['AMEX', 'JCB']);
  });

  test('a card folder names the card, even when the file itself does not', () => {
    // 顧客はカードごとにフォルダを作って明細を入れる。ファイルの中身に
    // カード名が無い形式（AMEX系・JAL系・楽天系）でも、これでカードが分かる。
    setup({cardNamePartnerPurposes: ['年会費'], useCardFolders: true});
    const merchants = plain(gas.call('openReviews', [{}]))
      .map((review) => review.merchantOriginal).sort();
    assert.deepEqual(merchants,
      ['ローソン', 'ローソン', 'ＡＭＥＸ・ビジネス・ゴールド', 'ＪＣＢカードＷ（家族）'].sort(),
      JSON.stringify(merchants));
  });

  test('without the purpose list the merchant is used, as before', () => {
    setup();
    const merchants = plain(gas.call('openReviews', [{}]))
      .map((review) => review.merchantOriginal);
    assert.deepEqual(merchants.filter((m) => m === '基本カード年会費').length, 2,
      'AN列が空なら従来どおり店名で照合する');
  });

  test('a generic annual-fee merchant is never learned as an exact rule', () => {
    // カード名が取れない形式では店名のまま要確認になる。そこで採用した
    // 取引先を学習すると、**他カードの年会費まで同じ取引先へ自動採用**
    // される ── この機能が避けようとしているものそのもの。
    setup({cardNamePartnerPurposes: ['年会費'], withCardNameRule: false});
    gas.call('opsListPartnerReviews', []);
    decisionSheet().getRange(decisionRowFor('基本カード年会費'), 6).setValue('AMEX');

    const summary = plain(gas.call('opsApplyPartnerDecisions', []));
    assert.equal(summary.errors, 0, JSON.stringify(summary.results));
    assert.ok(summary.results[0].notLearned, '学習しなかったことを報告すること');
    const learned = plain(gas.call('readDictionary_', [false]))
      .filter((rule) => normalizeMerchantFor(rule.original) === '基本カード年会費');
    assert.deepEqual(learned, []);
  });

  test('a format with no card-name rule falls back to the merchant', () => {
    setup({cardNamePartnerPurposes: ['年会費'], withCardNameRule: false});
    const merchants = plain(gas.call('openReviews', [{}]))
      .map((review) => review.merchantOriginal);
    assert.equal(merchants.filter((m) => m === '基本カード年会費').length, 2,
      'カード名が取れない形式では、黙って取り違えず店名のまま要確認にする');
  });
};

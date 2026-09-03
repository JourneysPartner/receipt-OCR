'use strict';

/**
 * 取引先の判断をシート経由で受け取り、要確認をまとめて解決する運用経路。
 *
 * プルダウン実行は引数を取れないので、「どの店名をどの取引先にするか」は
 * マスターの判断シートで受け取る。核心は**番号付きの明細**の扱い ── 楽天の
 * ふるさと納税は寄付ごとに番号が変わり同じ文字列が二度と現れないため、
 * 完全一致で1件ずつ覚えても次の明細では当たらない（実機の要確認8件のうち
 * 5件がこれだった。2026-09-03）。パターン規則で受けられることを検査する。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const blank = (n) => Array(n).fill('');
  const sheetHeader = (n, label) => { const r = blank(n); r[0] = label; return r; };
  const AE = JSON.stringify({row: 1, cells: [{column: 2, text: '利用日', match: 'exact'}]});

  function customerRow() {
    const row = blank(37);
    Object.assign(row, {
      0: 'C001', 1: '顧客A', 2: 'TRUE', 3: 'folder1', 5: 'dest1', 7: '入力用シート', 8: '取引先一覧',
      9: 2, 10: 3, 11: 4, 12: 5, 13: 6, 14: 7, 15: '1.0',
      16: 'reviewer@example.com', 17: 'admin@example.com', 18: 0, 20: 'システム情報', 21: '',
      23: 0, 24: 0, 29: 1, 30: AE, 31: '{}', 32: '{}', 33: 8,
      34: '取引先一覧', 35: 'CORPORATE', 36: ''
    });
    return row;
  }

  function formatRow() {
    const row = blank(34);
    Object.assign(row, {
      0: 'smbc_family', 1: '三井住友系', 2: 'active', 3: 'TRUE', 4: '["csv"]',
      5: JSON.stringify({allOf: [{maxRow: 1, keywords: ['利用日', '利用店名', '金額', '使用用途'], minMatch: 4}]}),
      6: 1, 7: 2, 8: 'A', 9: 'B', 10: 'C', 11: 'D', 12: '',
      14: JSON.stringify({excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []}),
      16: JSON.stringify({sources: [{id: 'fn', kind: 'fileName', pattern: '(20\\d{2})(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}]}),
      17: 'generic', 18: 1, 19: 'admin@example.com', 21: '2026-01-01T00:00:00+09:00',
      29: 'NEW', 33: '2026-01-01T00:00:00+09:00'
    });
    return row;
  }

  /** 未解決の取引先を3種類含む明細を1本取り込み、PARTNER要確認を立てる。 */
  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [sheetHeader(37, '顧客ID'), customerRow()]},
      {name: 'カード形式マスター', values: [sheetHeader(34, '形式ID'), formatRow()]},
      {name: '使用用途補完マスター', values: [sheetHeader(10, 'ルールID'),
        Object.assign(blank(10), {0: 'PR1', 1: '仕入', 2: '仕入れ', 3: 'TRUE'})]},
      {name: '共通取引先辞書', values: [sheetHeader(18, '辞書ID')]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート',
       values: [['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID', '']],
       maxRows: 30, maxColumns: 8},
      // 取引先一覧は「原文→取引先名」の対応表。取引先名の実在確認にも使う。
      {name: '取引先一覧', values: [
        ['元店名', '取引先名'],
        ['ローソン', '株式会社ローソン'],
        ['楽天市場', '楽天市場'],
        ['キュウテン', '株式会社キュウテン']
      ]}
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

    // 番号付き2件（同じ文字列は二度と現れない）＋普通の未登録店舗1件。
    const csv = '利用日,利用店名,金額,使用用途\n' +
      '2025/12/16,熊本県荒尾市 ﾗｸﾃﾝｲﾁﾊﾞ911963,12500,ふるさと納税\n' +
      '2025/12/17,山梨県富士吉田市 ﾗｸﾃﾝｲﾁﾊﾞ949365,10000,ふるさと納税\n' +
      '2025/12/18,キュウテン,3000,仕入れ\n';
    gas.stubs.createFile('fileA', {
      name: '三井住友カード202601.csv', bytes: Buffer.from(csv, 'utf8'),
      lastUpdated: new Date(Date.now() - 3600 * 1000),
      createdTime: '2026-08-01T00:00:00Z', contentType: 'text/csv'
    });
    gas.stubs.createFolder('folder1', {fileIds: ['fileA']});
    const report = plain(gas.call('runImport', [{}]));
    assert.equal(report.customers[0].files[0].nextState, 'REVIEW_WAIT',
      JSON.stringify(report.customers[0].files[0]));
    return report;
  }

  const decisionSheet = () =>
    gas.stubs.getSpreadsheet('master').getSheetByName('取引先判断（運用）');
  const destSheet = () => gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');

  /** 判断シートの行を元店名で引く。 */
  function decisionRowFor(merchant) {
    const values = decisionSheet().getDataRange().getValues();
    for (let i = 1; i < values.length; i += 1) {
      if (String(values[i][1]) === merchant) return i + 1;
    }
    throw new Error('決定行が見つからない: ' + merchant);
  }

  test('the decision sheet lists each unresolved merchant once, with its count', () => {
    setup();
    const first = plain(gas.call('opsListPartnerReviews', []));
    assert.equal(first.openReviews, 3);
    assert.equal(first.addedRows, 3);

    // 二度目は増やさない（担当者の記入を消さないため）。
    const again = plain(gas.call('opsListPartnerReviews', []));
    assert.equal(again.addedRows, 0);
    assert.equal(decisionSheet().getLastRow(), 4, 'ヘッダー＋3行のまま');
  });

  test('a partial rule resolves every numbered variant at once and is stored approved', () => {
    setup();
    gas.call('opsListPartnerReviews', []);
    const row = decisionRowFor('熊本県荒尾市 ﾗｸﾃﾝｲﾁﾊﾞ911963');
    decisionSheet().getRange(row, 4, 1, 3)
      .setValues([['partial', 'ﾗｸﾃﾝｲﾁﾊﾞ', '楽天市場']]);

    const summary = plain(gas.call('opsApplyPartnerDecisions', []));
    assert.equal(summary.errors, 0, JSON.stringify(summary.results));
    assert.equal(summary.resolvedReviews, 2,
      '番号違いの2件が1つのパターンで解決されること');

    // 辞書には承認済のパターン規則が1本だけ入る。未承認では自動採用されない。
    const rules = plain(gas.call('readDictionary_', [false]))
      .filter((rule) => rule.matchMethod === 'partial');
    assert.equal(rules.length, 1);
    assert.equal(rules[0].partnerName, '楽天市場');
    assert.equal(rules[0].approved, true);

    // 転記先のF列（取引先）が両方とも書き換わっている。
    const values = destSheet().getDataRange().getValues();
    const partners = values.slice(1).map((r) => r[2]).filter(Boolean);
    assert.equal(partners.filter((name) => name === '楽天市場').length, 2);
  });

  test('an exact decision resolves only its own merchant and completes the file', () => {
    setup();
    gas.call('opsListPartnerReviews', []);
    decisionSheet().getRange(decisionRowFor('キュウテン'), 6).setValue('株式会社キュウテン');
    const partial = decisionRowFor('熊本県荒尾市 ﾗｸﾃﾝｲﾁﾊﾞ911963');
    decisionSheet().getRange(partial, 4, 1, 3).setValues([['partial', 'ﾗｸﾃﾝｲﾁﾊﾞ', '楽天市場']]);

    const summary = plain(gas.call('opsApplyPartnerDecisions', []));
    assert.equal(summary.resolvedReviews, 3);
    assert.deepEqual(summary.completedFiles, ['fileA'],
      '全取引が決着したファイルは完了へ進む（INV-17）');
    assert.equal(gas.stubs.getFile('fileA').getName(), '【済】三井住友カード202601.csv');
  });

  test('a partner name absent from the partner list is refused, not written', () => {
    setup();
    gas.call('opsListPartnerReviews', []);
    const row = decisionRowFor('キュウテン');
    decisionSheet().getRange(row, 6).setValue('実在しない取引先');

    const summary = plain(gas.call('opsApplyPartnerDecisions', []));
    assert.equal(summary.errors, 1);
    assert.equal(summary.resolvedReviews, 0);
    assert.ok(String(decisionSheet().getRange(row, 7).getValue()).indexOf('エラー') === 0);
    // 要確認は開いたまま。取り違えた名前でF列を書いてしまわないこと。
    const open = plain(gas.call('openReviews', [{}]))
      .filter((review) => review.merchantOriginal === 'キュウテン');
    assert.equal(open.length, 1);
  });

  test('applying twice does not re-resolve or duplicate the dictionary rule', () => {
    setup();
    gas.call('opsListPartnerReviews', []);
    const row = decisionRowFor('熊本県荒尾市 ﾗｸﾃﾝｲﾁﾊﾞ911963');
    decisionSheet().getRange(row, 4, 1, 3).setValues([['partial', 'ﾗｸﾃﾝｲﾁﾊﾞ', '楽天市場']]);
    gas.call('opsApplyPartnerDecisions', []);

    const second = plain(gas.call('opsApplyPartnerDecisions', []));
    assert.equal(second.resolvedReviews, 0, '適用済の行は二度と処理しない');
    const rules = plain(gas.call('readDictionary_', [false]))
      .filter((rule) => rule.matchMethod === 'partial');
    assert.equal(rules.length, 1, 'パターン規則が重複登録されないこと');
  });
};

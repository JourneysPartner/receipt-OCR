'use strict';

/**
 * 1ファイルの取込にかかる**サーバー往復回数**を固定する。
 *
 * 実行が6分の上限に当たるかどうかを決めるのは計算量ではなく往復回数である
 * （実機で往復1回はおよそ0.5〜0.8秒）。2026-09-03、取引1件あたり25往復
 * かかっており、7〜8件の明細で6分を使い切って強制終了された。原因は
 * 取引ログ・処理ログ・行予約を**取引ごとに**読み書きしていたこと。
 *
 * ここで固定するのは「**往復回数が明細の件数に比例して増えないこと**」で
 * ある。総量の上限も置くが、主眼は比例しないこと ── 比例していれば、
 * 大きなファイルはいつか必ず上限に当たる。
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

  function dictRow() {
    const row = blank(18);
    Object.assign(row, {
      0: 'DICT_1', 1: 'ローソン', 2: 'ローソン', 3: '株式会社ローソン',
      4: 'exact_original', 5: 1, 6: '', 7: '', 8: '', 9: 'TRUE',
      10: 'admin@example.com', 12: '2026-01-01T00:00:00+09:00', 13: 1,
      14: 'TRUE', 15: 'FALSE'
    });
    return row;
  }

  /** 明細`txCount`件のCSV1本を取り込み、その実行で使った往復回数を返す。 */
  function measure(txCount) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [sheetHeader(37, '顧客ID'), customerRow()]},
      {name: 'カード形式マスター', values: [sheetHeader(34, '形式ID'), formatRow()]},
      {name: '使用用途補完マスター', values: [sheetHeader(10, 'ルールID'),
        Object.assign(blank(10), {0: 'PR1', 1: '仕入', 2: '仕入れ', 3: 'TRUE'})]},
      {name: '共通取引先辞書', values: [sheetHeader(18, '辞書ID'), dictRow()]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート',
       values: [['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID', '']],
       maxRows: 4 + txCount * 3, maxColumns: 8},
      {name: '取引先一覧', values: [['取引先']]}
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

    let csv = '利用日,利用店名,金額,使用用途\n';
    for (let i = 0; i < txCount; i += 1) {
      csv += `2025/12/${String((i % 28) + 1).padStart(2, '0')},ローソン,${1000 + i},仕入れ\n`;
    }
    gas.stubs.createFile('fileA', {
      name: '三井住友カード202601.csv', bytes: Buffer.from(csv, 'utf8'),
      lastUpdated: new Date(Date.now() - 3600 * 1000),
      createdTime: '2026-08-01T00:00:00Z', contentType: 'text/csv'
    });
    gas.stubs.createFolder('folder1', {fileIds: ['fileA']});

    gas.stubs.resetRoundTrips();
    const report = plain(gas.call('runImport', [{}]));
    const trips = gas.stubs.roundTrips();
    const file = report.customers[0].files[0];
    assert.equal(file.outcome, 'WRITTEN', JSON.stringify(file));
    assert.equal(file.written, txCount);
    return trips.rangeReads + trips.rangeWrites + trips.flushes;
  }

  test('a file costs the same number of server round trips whatever its size', () => {
    const few = measure(2);
    const many = measure(22);
    assert.equal(many, few,
      `2件で${few}往復、22件で${many}往復。件数に比例して増えている ── ` +
      '大きなファイルは必ず6分の実行上限に当たる。取引ごとの読み書きを' +
      'まとめる経路（settleWrittenTransactions・registerPrepared・行予約）を見よ。');
  });

  test('the fixed cost of one file stays within budget', () => {
    // 実機の往復1回はおよそ0.5〜0.8秒。200往復＝2分強で、6分の上限に対して
    // 1実行で複数ファイルを扱う余地が要る。上限を上げる前に、増えた理由を疑うこと。
    const trips = measure(3);
    assert.ok(trips <= 200, `1ファイルの固定往復が${trips}回。予算200回を超えた`);
  });
};

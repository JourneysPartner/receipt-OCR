'use strict';

/**
 * 取込の定期実行（継続トリガー4.35が結線されるまでの当座の手段）。
 *
 * 遠隔から`clasp run`を繰り返す運用は、Apps Script APIの接続断・Sheetsの
 * 毎分読取クォータ・実行の打切りと同時に戦うことになり、実機で繰り返し
 * 失敗した（2026-09-05）。スクリプト側で回せばその3つとも起きない。
 *
 * ここで守るのは3点：**自分が作ったトリガーだけを消すこと**、**前回の
 * 中断を毎回片付けること**、**終わったら自分で止まること**。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const blank = (n) => Array(n).fill('');
  const sheetHeader = (n, label) => { const r = blank(n); r[0] = label; return r; };
  const AE = JSON.stringify({row: 1, cells: [{column: 2, text: '利用日', match: 'exact'}]});

  function customerRow() {
    const row = blank(40);
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
    const row = blank(35);
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

  function setup(options) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [sheetHeader(40, '顧客ID'), customerRow()]},
      {name: 'カード形式マスター', values: [sheetHeader(35, '形式ID'), formatRow()]},
      {name: '使用用途補完マスター', values: [sheetHeader(10, 'ルールID')]},
      {name: '共通取引先辞書', values: [sheetHeader(18, '辞書ID'),
        Object.assign(blank(18), {0: 'DICT_1', 1: 'ローソン', 2: 'ローソン', 3: '株式会社ローソン',
          4: 'exact_original', 5: 1, 9: 'TRUE', 10: 'admin@example.com',
          12: '2026-01-01T00:00:00+09:00', 13: 1, 14: 'TRUE', 15: 'FALSE'})]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート',
       values: [['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID', '']],
       maxRows: 20, maxColumns: 8},
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

    if (options && options.withFile) {
      gas.stubs.createFile('fileA', {
        name: '三井住友カード202601.csv',
        bytes: Buffer.from('利用日,利用店名,金額,使用用途\n2025/12/16,ローソン,10800,仕入れ\n', 'utf8'),
        lastUpdated: new Date(Date.now() - 3600 * 1000),
        createdTime: '2026-08-01T00:00:00Z', contentType: 'text/csv'
      });
      gas.stubs.createFolder('folder1', {fileIds: ['fileA']});
    } else {
      gas.stubs.createFolder('folder1', {fileIds: []});
    }
  }

  const triggers = () => gas.stubs.getTriggers();

  test('starting the schedule leaves exactly one trigger, however often it is run', () => {
    setup();
    const first = plain(gas.call('opsStartScheduledImport', []));
    assert.equal(first.started, true);
    assert.equal(triggers().length, 1);
    assert.equal(triggers()[0].handler, 'scheduledImportTick');

    const second = plain(gas.call('opsStartScheduledImport', []));
    assert.equal(second.removedExisting, 1, '前のものを消してから作る');
    assert.equal(triggers().length, 1, '重ねて仕掛けない');

    const stopped = plain(gas.call('opsStopScheduledImport', []));
    assert.equal(stopped.removed, 1);
    assert.equal(triggers().length, 0);
  });

  test('only the schedule’s own triggers are removed', () => {
    setup();
    gas.evaluate("ScriptApp.newTrigger('someOtherJob').timeBased().everyMinutes(5).create();");
    gas.call('opsStartScheduledImport', []);
    assert.equal(triggers().length, 2);

    gas.call('opsStopScheduledImport', []);
    const left = triggers();
    assert.equal(left.length, 1, '他の用途のトリガーを巻き込まない');
    assert.equal(left[0].handler, 'someOtherJob');
  });

  test('a tick that still has work keeps the schedule running', () => {
    setup({withFile: true});
    gas.call('opsStartScheduledImport', []);
    gas.call('scheduledImportTick', []);
    assert.equal(triggers().length, 1, '仕事があるうちは止めない');
    // 取り込めていること（空振りで止まらないことの裏づけ）。
    const dest = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    assert.equal(dest.getRange(2, 3).getValue(), '株式会社ローソン');
  });

  test('the schedule stops itself once two ticks find nothing to do', () => {
    setup();
    gas.call('opsStartScheduledImport', []);

    gas.call('scheduledImportTick', []);
    assert.equal(triggers().length, 1,
      '1回の空振りでは止めない ── Driveへ後から置かれる分がある');

    gas.call('scheduledImportTick', []);
    assert.equal(triggers().length, 0, '2回続けて空振りなら自分で止まる');
    // 数え上げの跡を残さない（次に仕掛けたとき即座に止まってしまう）。
    assert.equal(gas.evaluate(
      "PropertiesService.getScriptProperties().getProperty('SCHEDULED_IMPORT_IDLE')"), null);
  });

  test('work after an idle tick resets the countdown', () => {
    setup();
    gas.call('opsStartScheduledImport', []);
    gas.call('scheduledImportTick', []);          // 空振り1回目

    // ここでファイルが置かれる。
    gas.stubs.createFile('fileA', {
      name: '三井住友カード202601.csv',
      bytes: Buffer.from('利用日,利用店名,金額,使用用途\n2025/12/16,ローソン,10800,仕入れ\n', 'utf8'),
      lastUpdated: new Date(Date.now() - 3600 * 1000),
      createdTime: '2026-08-01T00:00:00Z', contentType: 'text/csv'
    });
    gas.stubs.createFolder('folder1', {fileIds: ['fileA']});

    gas.call('scheduledImportTick', []);
    assert.equal(triggers().length, 1);
    gas.call('scheduledImportTick', []);
    assert.equal(triggers().length, 1, '仕事をした直後の空振り1回では止めない');
  });
};

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

  function customerRow(options) {
    const row = blank(39);
    Object.assign(row, {
      0: 'C001', 1: '顧客A', 2: 'TRUE', 3: 'folder1', 5: 'dest1', 7: '入力用シート', 8: '取引先一覧',
      9: 2, 10: 3, 11: 4, 12: 5, 13: 6, 14: 7, 15: '1.0',
      16: 'reviewer@example.com', 17: 'admin@example.com', 18: 0, 20: 'システム情報', 21: '',
      23: 0, 24: 0, 29: 1, 30: AE, 31: '{}', 32: '{}', 33: 8,
      34: '取引先一覧', 35: 'CORPORATE', 36: '',
      38: options && options.partnerExemptPurposes
        ? JSON.stringify(options.partnerExemptPurposes) : ''
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
  function setup(options) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [sheetHeader(39, '顧客ID'), customerRow(options)]},
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
    return plain(gas.call('runImport', [{}]));
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

  test('re-entry restores reviews even when there is nothing left to write', () => {
    // 実機で起きた状態（2026-09-03）：取引は`REVIEW_REQUIRED`なのに要確認が
    // 1件も無く、転記行も無い。担当者は解決操作を起動できず、ファイルは
    // 永久に完了しない。再取込しても、書込対象が0件だと要確認登録まで
    // 到達しないなら、この状態からは二度と抜け出せない。
    setup();
    assert.equal(plain(gas.call('openReviews', [{}])).length, 3);

    // 要確認だけが失われた状態を作る（取引は REVIEW_REQUIRED のまま）。
    const reviewSheet = gas.stubs.getSpreadsheet('master').getSheetByName('要確認');
    const lastRow = reviewSheet.getLastRow();
    reviewSheet.getRange(2, 1, lastRow - 1, reviewSheet.getLastColumn())
      .setValues(Array.from({length: lastRow - 1},
        () => Array(reviewSheet.getLastColumn()).fill('')));
    assert.equal(plain(gas.call('openReviews', [{}])).length, 0);

    // 動かす手段の無いファイルだけを再検査へ戻す運用手段。
    const rewound = plain(gas.call('opsRetryStalledReviewWait', []));
    assert.equal(rewound.retried, 1);
    gas.call('runImport', [{}]);

    const restored = plain(gas.call('openReviews', [{}]));
    assert.equal(restored.length, 3,
      '書くものが無くても要確認は登録される（9-8へ到達すること）');
    assert.ok(restored.every((review) => review.reviewType === 'PARTNER'));
  });

  test('a review transaction that never reached the sheet is written by recovery', () => {
    // 実機の状態（2026-09-03）：要確認は立っているのに転記行が無い取引。
    // 解決操作は「既に行があってF列を書き換える」前提なので、行番号0で
    // 書こうとして落ちる。行を確保して書くのは11.3の回復の仕事である。
    setup();
    const txLog = gas.stubs.getSpreadsheet('master').getSheetByName('クレカ取引ログ');
    const values = txLog.getDataRange().getValues();
    const target = values.findIndex((r, i) => i > 0 && String(r[0]).indexOf('TX_') === 0 &&
      String(r[9]) === 'REVIEW_REQUIRED');
    assert.ok(target > 0, '要確認つきの取引があること');
    const destinationRow = Number(values[target][30]);
    assert.ok(destinationRow >= 1);
    // 取引ログの転記行と、転記先の行そのものを消す（一度も書かれていない状態）。
    txLog.getRange(target + 1, 31).setValue('');
    destSheet().getRange(destinationRow, 1, 1, 8)
      .setValues([Array(8).fill('')]);

    gas.call('opsListPartnerReviews', []);
    const merchant = String(values[target][15]);
    decisionSheet().getRange(decisionRowFor(merchant), 6).setValue('株式会社テスト');
    const failed = plain(gas.call('opsApplyPartnerDecisions', []));
    assert.equal(failed.errors, 1, '行が無いままでは解決できない');

    // 回復が行を確保して書き直す。状態は REVIEW_REQUIRED のまま（人の判断待ち）。
    const recovered = plain(gas.call('opsRecoverStuckFiles', []));
    assert.equal(recovered.length, 1, JSON.stringify(recovered));
    assert.equal(recovered[0].stopped, null, JSON.stringify(recovered[0]));
    assert.equal(recovered[0].recovered.length, 1);
    assert.ok(!recovered[0].rewound, 'REVIEW_WAIT は発見へ戻さない');

    // これで解決操作が通る。
    decisionSheet().getRange(decisionRowFor(merchant), 7).setValue('');
    const applied = plain(gas.call('opsApplyPartnerDecisions', []));
    assert.equal(applied.errors, 0, JSON.stringify(applied.results));
    assert.equal(applied.resolvedReviews, 1);
  });

  test('a file whose reviews are still open is left alone', () => {
    // 人が判断している最中のファイルを勝手に再検査へ戻さないこと。
    setup();
    const summary = plain(gas.call('opsRetryStalledReviewWait', []));
    assert.equal(summary.retried, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.waitingOnPeople[0].openReviews, 3);
  });

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

  test('a partner absent from the list is accepted and flagged as new', () => {
    // freeeは取込時に未登録の取引先を自動で作る。一覧に無いことを理由に
    // 拒むと、正当な新規取引先のたびに一覧の手入力を強いることになる。
    // 打ち間違いに気づく手がかりとして状態欄に書き添えるだけにする。
    setup();
    gas.call('opsListPartnerReviews', []);
    const row = decisionRowFor('キュウテン');
    decisionSheet().getRange(row, 6).setValue('まだ一覧に無い取引先');

    const summary = plain(gas.call('opsApplyPartnerDecisions', []));
    assert.equal(summary.errors, 0, JSON.stringify(summary.results));
    assert.equal(summary.resolvedReviews, 1);
    assert.ok(String(decisionSheet().getRange(row, 7).getValue()).indexOf('新規取引先') >= 0,
      '一覧に無いことは通知する（止めはしない）');
    assert.equal(destSheet().getRange(4, 3).getValue(), 'まだ一覧に無い取引先');
  });

  test('an exact decision matches through width and spacing differences', () => {
    // 担当者がシート上で店名を打ち直す・貼り直すと、全角半角や空白が
    // 揺れる。字面の一致に頼ると、下した判断が黙って無効になる。
    setup();
    gas.call('opsListPartnerReviews', []);
    const row = decisionRowFor('キュウテン');
    decisionSheet().getRange(row, 2).setValue('  ｷｭｳﾃﾝ ');
    decisionSheet().getRange(row, 6).setValue('株式会社キュウテン');

    const summary = plain(gas.call('opsApplyPartnerDecisions', []));
    assert.equal(summary.errors, 0, JSON.stringify(summary.results));
    assert.equal(summary.resolvedReviews, 1);
  });

  test('a decision whose reviews are already closed says so instead of failing', () => {
    setup();
    gas.call('opsListPartnerReviews', []);
    decisionSheet().getRange(decisionRowFor('キュウテン'), 6).setValue('株式会社キュウテン');
    gas.call('opsApplyPartnerDecisions', []);

    // 同じ店名をもう一度依頼する（別経路で閉じた後の再実行に相当）。
    const row = decisionRowFor('キュウテン');
    decisionSheet().getRange(row, 7).setValue('');
    const summary = plain(gas.call('opsApplyPartnerDecisions', []));
    assert.equal(summary.errors, 0);
    assert.equal(summary.results[0].resolved, 0);
    assert.ok(String(decisionSheet().getRange(row, 7).getValue()).indexOf('既に解決済み') >= 0,
      '0件だった理由が状態欄に残ること');
  });

  test('a purpose on the exempt list needs no partner and raises no review', () => {
    // 「私用」「ふるさと納税」「振替」のように相手取引先を立てない仕訳がある。
    // 毎回「取引先なしで解決」を押させるのは作業であって判断ではない。
    const report = setup({partnerExemptPurposes: ['ふるさと納税', '私用']});
    const file = report.customers[0].files[0];
    assert.equal(file.written, 3);
    // ふるさと納税2件は要確認にならず、F列は空欄のまま確定する。
    const rows = destSheet().getDataRange().getValues().slice(1)
      .filter((r) => String(r[6] || '').indexOf('TX_') === 0);
    const furusato = rows.filter((r) => r[3] === 'ふるさと納税');
    assert.equal(furusato.length, 2);
    assert.deepEqual(furusato.map((r) => r[2]), ['', ''], 'F列は空欄');
    // 残る要確認は「キュウテン」の1種類だけ。
    const open = plain(gas.call('openReviews', [{}]));
    assert.equal(open.length, 1);
    assert.equal(open[0].merchantOriginal, 'キュウテン');
  });

  test('the exempt list can be applied to reviews that are already open', () => {
    // AM列を後から設定した場合、既に立っている要確認は残る。取込を
    // やり直さずに片付けられること。
    setup();
    assert.equal(plain(gas.call('openReviews', [{}])).length, 3);
    const master = gas.stubs.getSpreadsheet('master').getSheetByName('顧客マスター');
    master.getRange(2, 39).setValue(JSON.stringify(['ふるさと納税']));

    const summary = plain(gas.call('opsResolvePartnerExemptReviews', []));
    assert.equal(summary.errors, 0, JSON.stringify(summary.results));
    assert.equal(summary.resolved, 2, 'ふるさと納税の2件だけが閉じる');
    const open = plain(gas.call('openReviews', [{}]));
    assert.equal(open.length, 1);
    assert.equal(open[0].merchantOriginal, 'キュウテン');
  });

  test('（不要）in F column resolves reviews without a partner and learns nothing', () => {
    setup();
    gas.call('opsListPartnerReviews', []);
    const row = decisionRowFor('キュウテン');
    decisionSheet().getRange(row, 6).setValue('（不要）');

    const summary = plain(gas.call('opsApplyPartnerDecisions', []));
    assert.equal(summary.errors, 0, JSON.stringify(summary.results));
    assert.equal(summary.resolvedReviews, 1);
    const result = summary.results.find((r) => r.merchant === 'キュウテン');
    assert.equal(result.noPartner, true);
    assert.equal(result.resolved, 1);
    assert.ok(String(decisionSheet().getRange(row, 7).getValue()).indexOf('取引先不要') >= 0,
      '状態欄に「取引先不要」と出ること');

    const rules = plain(gas.call('readDictionary_', [false]))
      .filter((rule) => rule.original === 'キュウテン');
    assert.equal(rules.length, 0, '辞書学習なし');

    assert.equal(destSheet().getRange(4, 3).getValue(), '', '転記先の取引先は空欄');
  });

  test('取引先不明 in F column marks column I and registers no rule, even under partial', () => {
    // 仕様 webapp §15 の 2。名前として扱うと、partial では確定より先に
    // 「取引先不明」へ当てるパターンが辞書に入り、以後の取込が F列にそれを書く。
    setup();
    gas.call('opsListPartnerReviews', []);
    const row = decisionRowFor('キュウテン');
    decisionSheet().getRange(row, 4, 1, 3).setValues([['partial', 'キュウ', '取引先不明']]);

    const summary = plain(gas.call('opsApplyPartnerDecisions', []));
    assert.equal(summary.errors, 0, JSON.stringify(summary.results));
    const result = summary.results.find((r) => r.merchant === 'キュウテン');
    assert.equal(result.resolved, 1);
    assert.ok(String(decisionSheet().getRange(row, 7).getValue()).indexOf('取引先不明') >= 0,
      '状態欄に「取引先不明」と出ること');
    const rules = plain(gas.call('readDictionary_', [false]))
      .filter((rule) => rule.partnerName === '取引先不明' || rule.original === 'キュウテン');
    assert.equal(rules.length, 0, '辞書に何も登録しない');
    assert.equal(destSheet().getRange(4, 3).getValue(), '', 'F列は空欄');
    assert.equal(destSheet().getRange(4, 4).getValue(), '仕入れ,取引先不明', 'I列に印を足す');
  });

  test('opsReprocessFile takes a review-blocked file back for a fresh import', () => {
    // 形式定義の欠陥で立った要確認は、人が判断すべきものではない ── 定義を
    // 直したら取り込み直すのが正しい。実機ではコメリの請求年月規則の誤りで
    // DATE要確認が8件立ち、ファイルが REVIEW_WAIT から動けなくなった
    // （2026-09-06）。ファイル単位の要確認が無いので既存の取消経路に乗らない。
    setup();
    assert.equal(plain(gas.call('openReviews', [{}])).length, 3);
    assert.equal(gas.call('getFileState', ['fileA']), 'REVIEW_WAIT');

    const result = plain(gas.call('opsReprocessFile', ['fileA']));
    assert.equal(result.fileState, 'DISCOVERED');
    assert.ok(result.canceled.length >= 1, JSON.stringify(result));

    // 孤児の要確認を残さない（残すと抑止キーが効いて再登録されない。A-6）。
    assert.equal(plain(gas.call('openReviews', [{}])).length, 0);
    // 転記行は空く。
    const occupied = destSheet().getDataRange().getValues().slice(1)
      .filter((r) => String(r[6] || '').indexOf('TX_') === 0);
    assert.equal(occupied.length, 0, '転記行が解放されていること');

    // 取り込み直せる（supersedeされているので重複で止まらない）。
    const report = plain(gas.call('runImport', [{}]));
    const file = report.customers[0].files[0];
    assert.equal(file.written, 3, JSON.stringify(file));
    assert.equal(plain(gas.call('openReviews', [{}])).length, 3, '要確認は登録し直される');
  });

  test('reprocessing clears the submitted content hash so a parser fix can land', () => {
    // 内容ハッシュは金額・日付・店名・用途から作る（4.16）。つまり**パーサーを
    // 直すと、元ファイルが1バイトも変わっていなくてもハッシュが変わる**。
    // INV-07は「提出後に元ファイルが差し替わる」ことを捕まえるための不変条件
    // だが、取り込み直しはこちらが再導出を意図した操作である。消さないと
    // 「Submitted content hash is immutable」で二度と取り込めない
    // （実機で予備金額列の修正が入らなかった。2026-09-06）。
    setup();
    const processLog = gas.stubs.getSpreadsheet('master').getSheetByName('クレカ処理ログ');
    const fileIndex = gas.stubs.getSpreadsheet('master')
      .getSheetByName('恒久ファイルインデックス');
    const hashBefore = processLog.getRange(2, 13).getValue();
    assert.ok(hashBefore, '取込でハッシュが入っていること');
    assert.ok(fileIndex.getRange(2, 6).getValue(), '恒久インデックスにも入っていること');

    gas.call('opsReprocessFile', ['fileA']);

    assert.equal(processLog.getRange(2, 13).getValue(), '',
      '処理ログの提出時ハッシュが空くこと');
    assert.equal(fileIndex.getRange(2, 6).getValue(), '',
      '恒久インデックスの内容ハッシュも空くこと');

    // 空いていれば、違うハッシュでも不変条件に弾かれない。
    gas.call('syncPermanentContentHash', ['fileA', 'f'.repeat(64)]);
    assert.equal(fileIndex.getRange(2, 6).getValue(), 'f'.repeat(64));
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

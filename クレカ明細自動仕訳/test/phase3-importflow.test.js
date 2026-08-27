'use strict';

/**
 * フェーズ3：6.1 のブロック境界（INV-14）。
 *
 * 「事前検証がすべて完了するまで転記先へ1セルも書き込まない」を、
 * 転記先シートの中身で直接確認する。区分判定の結果を信じるのではなく、
 * **シートが実際に空のままであること**を見る。
 */
module.exports = ({test, assert, gas}) => {
  const names = {
    customer: '顧客マスター', commonList: '共通取引先一覧', commonDict: '共通取引先辞書',
    customerDict: '顧客別取引先辞書', process: 'クレカ処理ログ', transaction: 'クレカ取引ログ',
    audit: '監査ログ', lease: '処理リース', fileIndex: '恒久ファイルインデックス', review: '要確認'
  };
  const blank = (n) => Array(n).fill('');
  const sheetHeader = (n, label) => { const r = blank(n); r[0] = label; return r; };
  const plain = (v) => JSON.parse(JSON.stringify(v));

  function customerRow() {
    const row = blank(37);
    Object.assign(row, {
      0: 'C001', 1: '顧客A', 2: 'TRUE', 3: 'folder1', 5: 'dest1', 7: '入力用シート', 8: '取引先一覧',
      9: 2, 10: 6, 11: 9, 12: 11, 13: 13, 14: 30, 15: '1.0',
      16: 'reviewer@example.com', 17: 'admin@example.com', 18: 0, 20: 'システム情報', 21: 'ACTIVE',
      23: 0, 24: 0, 29: 1, 30: JSON.stringify({B: '利用日'}), 31: '{}', 32: '{}', 33: 30,
      34: '取引先一覧', 35: 'CORPORATE', 36: ''
    });
    return row;
  }

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: names.customer, values: [sheetHeader(37, '顧客ID'), customerRow()]},
      {name: names.commonList, values: [sheetHeader(6, '取引先ID')]},
      {name: names.commonDict, values: [sheetHeader(18, '辞書ID')]},
      {name: names.customerDict, values: [sheetHeader(18, '辞書ID')]},
      {name: names.process, values: [sheetHeader(40, '実行ID')]},
      {name: names.transaction, values: [sheetHeader(45, '取引ID完全値')]},
      {name: names.audit, values: [sheetHeader(15, '監査ID')]},
      {name: names.lease, values: [sheetHeader(10, 'リースID')]},
      {name: names.fileIndex, values: [sheetHeader(13, 'ファイルID')]},
      {name: names.review, values: [sheetHeader(31, '要確認ID')]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    const header = blank(30);
    header[1] = '利用日'; header[5] = '取引先'; header[8] = '用途';
    header[10] = '元店名'; header[12] = '金額'; header[29] = '内部ID';
    const rows = [header, blank(30), blank(30), blank(30)];
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート', values: rows, formulas: rows.map(() => blank(30)),
       maxRows: 4, maxColumns: 30},
      {name: '取引先一覧', values: [['取引先']]}
    ]});
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createFile('file1', {name: '明細.csv', data: 'a,b'});
    gas.evaluate("SETTINGS.TX_INDEX_SPREADSHEET_ID='txidx'; SETTINGS.WRITE_BATCH_SIZE=200;");
    const customer = gas.call('getCustomerById', ['C001']);
    gas.call('createOrUpdateProcessLog', ['RUN_1', customer, {
      id: 'file1', name: '明細.csv', binaryHash: 'b'.repeat(64),
      contentHash: 'c'.repeat(64), hashVersion: '3', state: 'VALIDATING'
    }]);
    return customer;
  }

  function tx(id) {
    return {
      fullTxId: id, displayTxId: id.slice(0, 8), customerId: 'C001', fileId: 'file1',
      sourceRow: 2, formatId: 'dcard', plannedFinalStatus: 'COMMITTED',
      partnerResolutionStatus: 'RESOLVED_WITH_PARTNER',
      originalDate: '2026-01-02', originalMerchant: '店舗', originalAmount: 1000,
      originalPurpose: '仕入れ',
      planned: {b: '2026-01-02', f: '株式会社テスト', i: '仕入れ', k: '店舗', m: 1000},
      identityHash: 'd'.repeat(64), contentHash: 'c'.repeat(64), occurrenceIndex: 0,
      transactionIdVersion: '2', hashVersion: '3'
    };
  }

  // 9-2 のガードへ渡す現在のDriveメタ情報。処理ログに記録した値と一致する。
  const UNCHANGED = {revisionId: '', binaryHash: 'b'.repeat(64)};

  /** 転記先が完全に空か。ヘッダー行を除く全セルを見る。 */
  function destinationIsUntouched() {
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    for (let row = 2; row <= sheet.getMaxRows(); row += 1) {
      for (let col = 1; col <= 30; col += 1) {
        if (sheet.getRange(row, col).getValue() !== '') return false;
      }
    }
    return true;
  }

  function txLogRowCount() {
    const sheet = gas.stubs.getSpreadsheet('master').getSheetByName(names.transaction);
    return sheet.getLastRow() - 1;
  }

  // ---- 区分1：顧客が元ファイルを直すべき不備。1セルも書かない ----
  test('INV-14: category 1 writes nothing to the destination and registers no transactions', () => {
    const customer = setup();
    const result = gas.call('processFile', [{
      customer, file: {id: 'file1'}, runId: 'RUN_1', leaseId: null, currentFileRecord: UNCHANGED,
      transactions: [tx('TX_A'), tx('TX_B')],
      // 補完不能な使用用途が残る＝顧客が元ファイルを直すべき不備（区分1）
      validation: {purposeResolution: {unresolvedCount: 1}}
    }]);

    assert.equal(plain(result).preValidation.category, 1);
    assert.equal(plain(result).wroteToDestination, false);
    assert.equal(destinationIsUntouched(), true,
      'not a single cell may be written for a category-1 file');
    assert.equal(txLogRowCount(), 0,
      'no transaction log rows either - they would be orphaned');
    assert.equal(plain(result).nextState, 'CUSTOMER_FIX_REQUIRED');
  });

  // ---- 区分2：管理者確認。同じく1セルも書かない ----
  test('INV-14: category 2 writes nothing to the destination', () => {
    const customer = setup();
    const result = gas.call('processFile', [{
      customer, file: {id: 'file1'}, runId: 'RUN_1', leaseId: null, currentFileRecord: UNCHANGED,
      transactions: [tx('TX_C')],
      validation: {format: {ok: false, code: 'UNKNOWN_CARD_FORMAT'}}
    }]);

    assert.equal(plain(result).preValidation.category, 2);
    assert.equal(destinationIsUntouched(), true);
    assert.equal(txLogRowCount(), 0);
    assert.equal(plain(result).nextState, 'REVIEW_WAIT');
  });

  // ---- 書込ブロックを区分1・2で直接呼んでも拒否する（二重の歯止め） ----
  [1, 2].forEach((category) => {
    test(`INV-14: the write block refuses to run for category ${category} even if called directly`, () => {
      const customer = setup();
      assert.throws(() => gas.call('runWriteBlock', [{
        customer, file: {id: 'file1'}, leaseId: null,
        preValidation: {category, transactions: [], pendingReviews: []}
      }]), (error) => error && /INV-14/.test(String(error.message)),
        'it must be refused for being category 1/2, not for a missing argument');
      assert.equal(destinationIsUntouched(), true);
    });
  });

  // ---- 区分3：事前検証を通ったら転記される ----
  test('6.1: a file that clears pre-validation is written, verified, and committed', () => {
    const customer = setup();
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);

    const result = gas.call('processFile', [{
      customer, file: {id: 'file1'}, runId: 'RUN_1', leaseId, currentFileRecord: UNCHANGED,
      transactions: [tx('TX_D'), tx('TX_E')],
      validation: {}
    }]);

    const plainResult = plain(result);
    assert.equal(plainResult.wroteToDestination, true);
    assert.equal(plainResult.write.written.length, 2);
    assert.equal(plainResult.write.failed.length, 0);
    assert.equal(gas.call('getTransaction', ['TX_D']).transactionStatus, 'COMMITTED');
    assert.equal(gas.call('getTransaction', ['TX_E']).transactionStatus, 'COMMITTED');

    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    assert.equal(sheet.getRange(2, 2).getValue(), '2026-01-02');
    assert.equal(sheet.getRange(2, 13).getValue(), 1000);

    // 9-12：全取引が確定したファイルは完了へ進む（INV-17）。
    assert.equal(plainResult.nextState, 'COMPLETED');
  });

  // ---- 要確認が残るファイルは完了しない ----
  test('INV-17: a file with an unresolved transaction goes to review, not to completed', () => {
    const customer = setup();
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);

    const result = gas.call('processFile', [{
      customer, file: {id: 'file1'}, runId: 'RUN_1', leaseId, currentFileRecord: UNCHANGED,
      transactions: [tx('TX_S')], validation: dateTriageValidation('TX_S')
    }]);
    assert.equal(plain(result).nextState, 'REVIEW_WAIT');
  });

  // ---- 9-2：ファイル変更ガードは行予約より前。予約行を残さない ----
  test('6.1 step 9-2: a changed file stops before reserving any row', () => {
    const customer = setup();
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);

    // 処理ログに記録した後で、顧客がファイルを差し替えた状況を作る
    const result = gas.call('processFile', [{
      customer, file: {id: 'file1'}, runId: 'RUN_1', leaseId,
      currentFileRecord: {revisionId: '', binaryHash: 'f'.repeat(64)},
      transactions: [tx('TX_F')], validation: {}
    }]);

    assert.equal(plain(result).write.fileChanged, true);
    assert.equal(plain(result).write.guardReason, 'FILE_CHANGED');
    assert.equal(plain(result).wroteToDestination, false);
    assert.equal(destinationIsUntouched(), true,
      'the guard must fire before any row is reserved (M17)');
    // 取引ログには登録済みだが、転記先には一切触れていない
    assert.equal(gas.call('getTransaction', ['TX_F']).transactionStatus, 'PREPARED');
  });

  // ---- ガードの材料がなければ、通過ではなく呼出の誤りとして止まる ----
  test('6.1 step 9-2: without a way to check the file, the write block refuses to run', () => {
    const customer = setup();
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);

    assert.throws(() => gas.call('processFile', [{
      customer, file: {id: 'file1'}, runId: 'RUN_1', leaseId,
      transactions: [tx('TX_L')], validation: {}
    }]), (error) => error && /fetchFileRecord/.test(String(error.message)),
      'silently skipping the guard would write a changed file into reserved rows');
    assert.equal(destinationIsUntouched(), true);
  });

  /** 区分3を起こす。日付が確定しなかった取引1件に DATE の要確認を立てる。 */
  function dateTriageValidation(txId) {
    return {
      dateTriage: {
        issues: [{
          transactionId: txId, sourceRow: 2, reviewType: 'DATE',
          code: 'DATE_INFERENCE_AMBIGUOUS',
          // Z列の必須キーは2.1.7.1のとおり。欠けたまま登録できてしまうと、
          // 解決操作が判断材料を読めない。
          detail: {
            kind: 'DATE_INFERENCE', status: 'MULTI_CANDIDATE', baseYearMonth: '2026-01',
            candidates: [{year: 2025, month: 1, day: 5, inWindow: true, exists: true},
                         {year: 2026, month: 1, day: 5, inWindow: true, exists: true}],
            lookbackMonths: 3, forwardMonths: 1
          }
        }],
        blankDateTxIds: [txId]
      }
    };
  }

  // ---- 9-8：区分3で転記した取引に、要確認が実際に残る ----
  //
  // 以前このテストは区分2で0件を確認していた。区分2では取引ログにも
  // 登録されないので、実装が何をしても0件だった。区分3を通す。
  test('6.1 step 9-8: a transaction that could not be resolved keeps its review after writing', () => {
    const customer = setup();
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);

    const result = gas.call('processFile', [{
      customer, file: {id: 'file1'}, runId: 'RUN_1', leaseId, currentFileRecord: UNCHANGED,
      transactions: [tx('TX_H')], validation: dateTriageValidation('TX_H')
    }]);

    assert.equal(plain(result).preValidation.category, 3);

    const reviews = plain(gas.call('openReviews', [{fullTxId: 'TX_H'}]));
    assert.equal(reviews.length, 1,
      'the DATE review must survive the write block - otherwise nobody ever learns this row was unresolved');
    assert.equal(reviews[0].reviewType, 'DATE');
  });

  // ---- INV-37：要確認が残る取引を確定させない ----
  test('INV-37: a transaction with an unresolved review is not committed by the write block', () => {
    const customer = setup();
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);

    gas.call('processFile', [{
      customer, file: {id: 'file1'}, runId: 'RUN_1', leaseId, currentFileRecord: UNCHANGED,
      transactions: [tx('TX_I')], validation: dateTriageValidation('TX_I')
    }]);

    assert.equal(gas.call('getTransaction', ['TX_I']).transactionStatus, 'REVIEW_REQUIRED',
      'committing here would push an unverified value into the customer freee ledger');
  });

  // ---- INV-33：信頼していない日付を転記先へ出さない ----
  test('INV-33: a date the system could not settle is written as an empty B column', () => {
    const customer = setup();
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);

    const result = gas.call('processFile', [{
      customer, file: {id: 'file1'}, runId: 'RUN_1', leaseId, currentFileRecord: UNCHANGED,
      transactions: [tx('TX_J')], validation: dateTriageValidation('TX_J')
    }]);

    assert.equal(gas.call('getTransaction', ['TX_J']).planned.b, '',
      'the planned B value must be blanked, not the inferred guess');

    const rowNumber = plain(result).write.verified[0];
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    assert.equal(sheet.getRange(rowNumber, 2).getValue(), '',
      'and the destination cell must be empty too');
    // 転記自体は行われている（空欄化は「書かない」ことではない）
    assert.equal(sheet.getRange(rowNumber, 13).getValue(), 1000);
  });

  // ---- M17：確定に至らなかった予約行を空き行へ戻す ----
  //
  // 読取確認に失敗した行を解放しないと、取引ID列だけが残る。空き行判定は
  // それを使用中と見るため、その行は**永久に使えなくなる**。失敗のたびに
  // 顧客の出納帳が1行ずつ死ぬ。
  test('M17: a row that failed read-back verification is released, not left occupied', () => {
    const customer = setup();
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);

    // 書込直後・読取確認前に、誰かがM列を書き換えた状況を作る
    gas.evaluate(`
      var ORIGINAL_WRITE_ = writeTransactionRows;
      writeTransactionRows = function(customer, rowWrites, leaseId, fileId) {
        var out = ORIGINAL_WRITE_(customer, rowWrites, leaseId, fileId);
        SpreadsheetApp.openById(customer.destinationSpreadsheetId)
          .getSheetByName(customer.destinationSheetName)
          .getRange(rowWrites[0].rowNumber, 13).setValue(99999);
        return out;
      };
    `);
    let result;
    try {
      result = gas.call('processFile', [{
        customer, file: {id: 'file1'}, runId: 'RUN_1', leaseId, currentFileRecord: UNCHANGED,
        transactions: [tx('TX_K')], validation: {}
      }]);
    } finally {
      gas.evaluate('writeTransactionRows = ORIGINAL_WRITE_;');
    }

    const plainResult = plain(result);
    assert.equal(plainResult.write.failed.length, 1, 'read-back must have failed');

    const rowNumber = plainResult.write.failed[0].rowNumber;
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    assert.equal(sheet.getRange(rowNumber, 30).getValue(), '',
      'the transaction id must be cleared so the row can be reused');

    // 取引ID列だけを消すのでは足りない。値は書込済みなので、B〜M列が
    // 残ったままだと空き行判定は「使用中」を返し続け、しかも取引IDが
    // 無いのでどの検査からも引けない ── **無名の不正値行が顧客の出納帳に
    // 恒久的に残る**。行が本当に空き行へ戻ったことを、空き行判定そのもので
    // 確かめる。
    [2, 6, 9, 11, 13].forEach((column) => {
      assert.equal(sheet.getRange(rowNumber, column).getValue(), '',
        `column ${column} still holds a written value - the row is dead, not released`);
    });
    const index = gas.call('buildIndex', [customer]);
    assert.equal(gas.call('isRowEmpty', [index, rowNumber, customer]), true,
      'the emptiness judgement itself must accept the row again');
  });

  // ---- 11.3 Step4 を障害注入で実機どおりに再現する ----
  //
  // RAW（取引ID・F/I/K列）だけ成功し USER_ENTERED（B/M列）が失敗する部分
  // 失敗は、**2リクエストの分割点で止められなければ再現できない**。これが
  // 障害注入シームの存在理由であり、以前は呼出箇所が0だった。
  //
  // 書込途中の例外では行を**消さない**。11.3 Step4 は「同じ行へ書き直す」
  // 設計であり、取引ID列が残っていることが回復の前提である。
  test('11.3 Step4: a mid-write failure leaves the row for recovery, which completes it', () => {
    const customer = setup();
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);
    gas.evaluate(`
      SETTINGS.FAULT_INJECTION = {SHEET_WRITE_USER_ENTERED_BEFORE: true};
      resetFaultInjectionCache_();
    `);

    let thrown = null;
    try {
      gas.call('processFile', [{
        customer, file: {id: 'file1', name: '明細.csv'}, runId: 'RUN_1', leaseId,
        currentFileRecord: UNCHANGED, transactions: [tx('TX_F4')], validation: {}
      }]);
    } catch (error) {
      thrown = error;
    } finally {
      gas.evaluate('SETTINGS.FAULT_INJECTION = null; resetFaultInjectionCache_();');
    }
    assert.ok(thrown && (thrown.code === 'FAULT_INJECTED' ||
      /Injected fault/.test(String(thrown.message || thrown))),
      `the injected fault must surface, not be swallowed; got ${String(thrown)}`);

    // 部分状態：RAW群は書けている。B/M列はまだ。行は回復のために残る。
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    assert.equal(sheet.getRange(2, 30).getValue(), 'TX_F4',
      'the transaction id must survive - Step 4 rewrites this row in place');
    assert.equal(sheet.getRange(2, 6).getValue(), '株式会社テスト', 'RAW columns were written');
    assert.equal(sheet.getRange(2, 2).getValue(), '', 'USER_ENTERED columns were not');
    assert.equal(sheet.getRange(2, 13).getValue(), '');

    // 回復処理（11.3 Step4）が同じ行を書き直して完了させる
    const result = gas.call('recoverPartialFailure',
      ['file1', 'RUN_1', gas.call('buildIndex', [customer]), leaseId, {customer}]);
    assert.equal(result.recovered[0].step, 4);
    assert.equal(result.recovered[0].rowNumber, 2, 'the same row, not a new one');
    assert.equal(sheet.getRange(2, 2).getValue(), '2026-01-02');
    assert.equal(sheet.getRange(2, 13).getValue(), 1000);
    assert.equal(gas.call('getTransaction', ['TX_F4']).transactionStatus, 'COMMITTED');
  });

  // ---- 空き行判定は、実物の顧客・インデックスで動かなければならない ----
  //
  // 空き行判定最終列は顧客マスターAH列＝`rowScanLastColumn`である（INV-27）。
  // 同じ概念に2つの名前があると、テスト用の作り物では通り、実物では落ちる。
  test('5.11: findEmptyRows works with the real customer object and real index', () => {
    const customer = setup();
    const index = gas.call('buildIndex', [customer]);
    const rows = plain(gas.call('findEmptyRows', [customer, 2, index]));
    assert.deepEqual(rows.map(Number), [2, 3]);
  });

  // ---- INV-08：転記先シートの読取を取引ごとに行わない ----
  //
  // スタブ上では全シート読取も一瞬で終わるので、速度では検出できない。
  // 読んだセル数で見る。実 GAS では5,000行のシートで実行時間上限と
  // APIクォータの両方に当たる。
  test('INV-08: read-back does not re-read the whole sheet for every transaction', () => {
    const customer = setup();
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);
    const rowWrites = [2, 3].map((rowNumber, i) =>
      gas.call('buildRowWrite', [rowNumber, tx(`TX_R${i}`)]));

    gas.stubs.resetApiCallCounts();
    gas.call('verifyWrittenValues', [customer, rowWrites]);
    const counts = gas.stubs.getApiCallCounts();

    assert.equal(counts.batchGet, 1, 'both rows must be read in a single request');
    assert.ok(counts.cellsRead <= 2 * 30,
      `read-back must touch only the target rows, read ${counts.cellsRead} cells`);
  });

  // ---- 仕様20.3：F/I/K列をプレーンテキストにする ----
  //
  // これをしないと `0570-...` のような店名が電話番号や数式として解釈され、
  // 読取確認が不一致になるか、値が静かに変わる。
  test('20.3: the merchant and purpose columns are forced to plain text', () => {
    const customer = setup();
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);

    gas.call('processFile', [{
      customer, file: {id: 'file1'}, runId: 'RUN_1', leaseId, currentFileRecord: UNCHANGED,
      transactions: [tx('TX_P')], validation: {}
    }]);

    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    [6, 9, 11].forEach((column) => {
      assert.equal(sheet.getRange(2, column).getNumberFormat(), '@',
        `column ${column} must be plain text`);
    });
    // 金額列は数値のままでなければならない
    assert.notEqual(sheet.getRange(2, 13).getNumberFormat(), '@');
  });

  // ---- M30：テンプレート行の拡張 ----
  //
  // 転記先は顧客のfreee出納帳であり、B/F/I/K/M以外の列には数式や既定値が
  // 入っている。拡張した行がそれを失うと、顧客の帳簿が静かに壊れる。
  test('M30: expanding template rows keeps the formulas the system does not own', () => {
    const customer = setup();
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    // 最終行に、システムが書かない列の数式を用意する。
    // 5.11の定義では「数式あり・評価結果が空」は空き行のままである。
    sheet.getRange(4, 21).setFormula('=M4*0.1');       // 消費税の計算式

    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);
    // 空き行3つに対し4件 → 1行の拡張が必要になる
    const result = plain(gas.call('reserveDestinationRows',
      [customer, ['TX_M1', 'TX_M2', 'TX_M3', 'TX_M4'], 'file1', leaseId]));

    assert.equal(result.expanded.length, 1, 'exactly one row had to be added');
    const expanded = Math.max(...result.reserved.map((r) => Number(r.rowNumber)));
    // 実 Sheets は copyTo で相対参照を移動先へずらす。スタブはずらさないので、
    // ここで確認するのは「数式が失われていないこと」である。
    assert.ok(sheet.getRange(expanded, 21).getFormula(),
      'the tax formula must survive the expansion');
  });

  // ---- M30 手順6：拡張しても空き行が増えないなら、繰り返さずに止まる ----
  test('M30: a last row holding a static total stops expansion instead of looping', () => {
    const customer = setup();
    const sheet = gas.stubs.getSpreadsheet('dest1').getSheetByName('入力用シート');
    // 顧客が最下行に合計を入れている状況。複製しても使える行にならない。
    sheet.getRange(4, 20).setValue('合計');

    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);

    assert.throws(() => gas.call('reserveDestinationRows',
      [customer, ['TX_N1', 'TX_N2', 'TX_N3', 'TX_N4'], 'file1', leaseId]),
      (error) => error && /DESTINATION_TEMPLATE_ROW_NOT_EMPTY/.test(String(error.message)),
      'expanding must stop, not repeat forever while no empty row appears');
  });

  // ---- INV-28：承認したら、次の処理で同じ区分2に戻らない ----
  //
  // 承認が再検証へ届かないと、担当者が承認するたびに同じ要因が再検出され、
  // REVIEW_WAIT へ戻り続ける。操作が状態を1歩も進めない。
  test('INV-28: approving a category-2 cause lets the next run get past it', () => {
    const customer = setup();
    const countMismatch = {countsTotals: {ok: false, code: 'COUNT_TOTAL_MISMATCH'},
                           contentHash: 'c'.repeat(64), hashVersion: '3'};

    const before = gas.call('processFile', [{
      customer, file: {id: 'file1'}, runId: 'RUN_1', leaseId: null,
      currentFileRecord: UNCHANGED, transactions: [tx('TX_T')], validation: countMismatch
    }]);
    assert.equal(plain(before).preValidation.category, 2, 'it starts as a category-2 file');

    // 担当者が承認し、シートへ永続化する
    gas.call('appendCategory2Approval', ['file1', gas.call('createValidationApproval',
      ['COUNT_TOTAL_MISMATCH', 'c'.repeat(64), '3', 'reviewer@example.com'])]);

    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);
    const after = gas.call('processFile', [{
      customer, file: {id: 'file1'}, runId: 'RUN_1', leaseId,
      currentFileRecord: UNCHANGED, transactions: [tx('TX_T')], validation: countMismatch
    }]);

    assert.notEqual(plain(after).preValidation.category, 2,
      'the approval must be picked up from the process log, or this loops forever');
    assert.equal(plain(after).wroteToDestination, true);
  });

  // ---- 8-8・8-9：取引検証と入力上限が本番経路で実際に評価される ----
  //
  // 以前は `validateTransactions` と `checkRunTransactionLimit` の呼出元が
  // 無く、テストだけが手で材料を渡していた。**結線されていない検査は
  // 存在しないのと同じ**で、上限はいくらでも超えられた。
  test('8-8: a missing merchant is caught by the flow itself, not by test-supplied material', () => {
    const customer = setup();
    const broken = tx('TX_NM');
    broken.merchantOriginal = '';
    broken.originalMerchant = '';

    const result = gas.call('processFile', [{
      customer, file: {id: 'file1', name: '明細.csv'}, runId: 'RUN_1', leaseId: null,
      currentFileRecord: UNCHANGED, transactions: [broken], validation: {}
    }]);

    assert.equal(plain(result).preValidation.category, 1,
      'the flow must judge the transactions on its own');
    assert.equal(destinationIsUntouched(), true);
  });

  test('8-9: the run limit is enforced against the persisted cumulative count', () => {
    const customer = setup();
    gas.evaluate('SETTINGS.MAX_TRANSACTIONS_PER_RUN = 3;');
    gas.call('incrementRunTransactionCount', ['RUN_1', 3]);   // 前のファイルで既に3件

    const result = gas.call('processFile', [{
      customer, file: {id: 'file1', name: '明細.csv'}, runId: 'RUN_1', leaseId: null,
      currentFileRecord: UNCHANGED, transactions: [tx('TX_L1')], validation: {}
    }]);

    assert.equal(plain(result).preValidation.category, 2,
      'exceeding the limit is INPUT_LIMIT_EXCEEDED, not a silent overflow');
    assert.equal(txLogRowCount(), 0, 'the file must not be half-processed');
  });

  test('8-13: a successful registration adds to the persisted run count', () => {
    const customer = setup();
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);
    gas.call('processFile', [{
      customer, file: {id: 'file1', name: '明細.csv'}, runId: 'RUN_1', leaseId,
      currentFileRecord: UNCHANGED, transactions: [tx('TX_C1'), tx('TX_C2')], validation: {}
    }]);
    assert.equal(gas.call('getRunCumulativeTransactionCount', ['RUN_1']), 2,
      'without this, a continuation trigger restarts the tally at zero');
  });

  // ---- 8-10 → 9-8：取引先が判定できなかった取引に PARTNER 要確認が立つ ----
  //
  // 以前はこの経路が存在しなかった。取引は REVIEW_REQUIRED かつ UNRESOLVED に
  // なるのに解決すべき要確認行が作られず、ADOPT_EXISTING_PARTNER も
  // RESOLVE_WITHOUT_PARTNER も起動できない ── **取引先不明の明細は永久に
  // 確定不能**だった。テストが registerReview を手で呼んで行を作っていた
  // ため、本番経路がこの行を作れないことが見えなかった。
  test('9-8: an unmatched partner becomes a PARTNER review through the real path', () => {
    const customer = setup();
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);

    const unmatched = tx('TX_PM');
    unmatched.partnerResolutionStatus = 'UNRESOLVED';
    unmatched.planned.f = '';
    unmatched.partnerMatch = {
      matchedBy: null, autoConfirm: false, conflict: false,
      candidates: [{ruleId: 'D1', partnerName: '株式会社ドン・キホーテ', priority: 1, conflict: false}]
    };
    unmatched.merchantNormalized = gas.call('normalizeMerchant', ['店舗']);

    gas.call('processFile', [{
      customer, file: {id: 'file1', name: '明細.csv'}, runId: 'RUN_1', leaseId,
      currentFileRecord: UNCHANGED, transactions: [unmatched], validation: {}
    }]);

    const reviews = plain(gas.call('openReviews', [{fullTxId: 'TX_PM'}]));
    assert.equal(reviews.length, 1,
      'without this review the transaction can never be committed');
    assert.equal(reviews[0].reviewType, 'PARTNER');
    assert.equal(reviews[0].merchantOriginal, '店舗',
      'the resolution operations read this - blank means learnFromResolution fails');
    assert.ok(reviews[0].candidates,
      'the reviewer needs the candidates to pick from');
    assert.equal(gas.call('getTransaction', ['TX_PM']).transactionStatus, 'REVIEW_REQUIRED');
  });

  // ---- その要確認が ADOPT_EXISTING_PARTNER まで実際に届く ----
  test('9-8 -> 4.26: the generated PARTNER review resolves end to end', () => {
    const customer = setup();
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);
    const unmatched = tx('TX_PM2');
    unmatched.partnerResolutionStatus = 'UNRESOLVED';
    unmatched.planned.f = '';
    unmatched.partnerMatch = {matchedBy: null, autoConfirm: false, conflict: false, candidates: []};
    unmatched.merchantNormalized = gas.call('normalizeMerchant', ['店舗']);

    gas.call('processFile', [{
      customer, file: {id: 'file1', name: '明細.csv'}, runId: 'RUN_1', leaseId,
      currentFileRecord: UNCHANGED, transactions: [unmatched], validation: {}
    }]);

    // 担当者の解決は、取込実行のリースが解放された後に行われる
    gas.call('releaseLease', ['file1', 'RUN_1', 'RUN_DONE']);

    const review = plain(gas.call('openReviews', [{fullTxId: 'TX_PM2'}]))[0];
    const result = plain(gas.call('resolveReview',
      [review.reviewId, 'ADOPT_EXISTING_PARTNER',
       {partnerName: '株式会社テスト', runId: 'RUN_1'}]));

    assert.equal(result.committed, true,
      'the whole loop - flag, review, resolve, commit - must close through real paths');
    assert.equal(gas.call('getTransaction', ['TX_PM2']).partnerResolutionStatus,
      'RESOLVED_WITH_PARTNER');
  });

  // ---- 自動確定した取引には PARTNER 要確認を立てない ----
  test('9-8: an auto-confirmed partner raises no review', () => {
    const customer = setup();
    const leaseId = gas.call('acquireLease',
      ['C001', 'file1', 'RUN_1', 'admin@example.com', 'PROCESS']);
    gas.call('processFile', [{
      customer, file: {id: 'file1', name: '明細.csv'}, runId: 'RUN_1', leaseId,
      currentFileRecord: UNCHANGED, transactions: [tx('TX_OK')], validation: {}
    }]);
    assert.equal(gas.call('openReviews', [{fullTxId: 'TX_OK'}]).length, 0,
      'a settled match needs no human decision');
    assert.equal(gas.call('getTransaction', ['TX_OK']).transactionStatus, 'COMMITTED');
  });

  // ---- 区分2：取引ログには何も残さないが、ファイル単位の要確認は登録する ----
  //
  // 以前このテストは「要確認も0件」を正解として固定していた。それは誤りで
  // ある。A-23 が禁じるのは**取引単位**の孤児要確認であって、区分2の
  // ファイル単位要確認は 6.1 step 8-11 が登録を要求するものだった。
  // 登録しないと、REVIEW_WAIT に落ちたファイルに要確認行が無く、
  // `resolveFileReview` は reviewId を必須とするので**誰も動かせない**。
  test('6.1 step 8-11: a category-2 file registers its file-scoped review', () => {
    const customer = setup();
    const result = gas.call('processFile', [{
      customer, file: {id: 'file1'}, runId: 'RUN_1', leaseId: null, currentFileRecord: UNCHANGED,
      transactions: [tx('TX_G')],
      validation: {format: {ok: false, code: 'UNKNOWN_CARD_FORMAT'}}
    }]);

    assert.equal(txLogRowCount(), 0,
      'no transaction rows - they would be orphaned');

    const reviews = plain(gas.call('openReviews', [{fileId: 'file1'}]));
    assert.equal(reviews.length, 1,
      'without this row, nobody can ever act on the file');
    assert.equal(reviews[0].reviewType, 'FORMAT_UNKNOWN');
    assert.equal(reviews[0].customerId, 'C001');
    assert.equal(reviews[0].customerName, '顧客A',
      'the review list must show whose file this is');
    assert.equal(plain(result).nextState, 'REVIEW_WAIT');
  });

  // ---- 登録された要確認が、実際に解決操作の入口まで届く（INV-31の往復） ----
  test('INV-31: the registered category-2 review can actually be resolved', () => {
    const customer = setup();
    gas.call('processFile', [{
      customer, file: {id: 'file1'}, runId: 'RUN_1', leaseId: null, currentFileRecord: UNCHANGED,
      transactions: [tx('TX_G')],
      validation: {format: {ok: false, code: 'UNKNOWN_CARD_FORMAT'}}
    }]);
    gas.call('transitionFileState', ['file1', 'VALIDATING', 'REVIEW_WAIT', 'RUN_1']);

    const review = plain(gas.call('openReviews', [{fileId: 'file1'}]))[0];
    const resolved = plain(gas.call('resolveFileReview',
      [review.reviewId, 'REGISTER_FORMAT', {runId: 'RUN_1', role: 'SYSTEM_ADMIN'}]));

    assert.equal(resolved.nextState, 'VALIDATING',
      'the escape route exists only if the review row was actually created');
  });

  // ---- 区分2でも取引単位の要確認は登録しない（A-23はこちらに適用される） ----
  test('A-23: a category-2 file registers no transaction-scoped reviews', () => {
    const customer = setup();
    gas.call('processFile', [{
      customer, file: {id: 'file1'}, runId: 'RUN_1', leaseId: null, currentFileRecord: UNCHANGED,
      transactions: [tx('TX_G')],
      // 区分2の要因と、取引単位の DATE 材料が同時に存在する状況
      validation: Object.assign({format: {ok: false, code: 'UNKNOWN_CARD_FORMAT'}},
        dateTriageValidation('TX_G'))
    }]);

    const reviews = plain(gas.call('openReviews', [{fileId: 'file1'}]));
    assert.equal(reviews.filter((r) => r.fullTxId === 'TX_G').length, 0,
      'a transaction-scoped review without a transaction log row is an orphan');
    assert.equal(reviews.filter((r) => r.reviewType === 'FORMAT_UNKNOWN').length, 1,
      'the file-scoped review is still registered');
  });
};

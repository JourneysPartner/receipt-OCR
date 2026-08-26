'use strict';

/**
 * フェーズ3：6.5 処理済みファイル変更の再走査。
 *
 * 設計レビューでCR-8として検出された欠陥を固定する。
 *   「メタ情報が未変化ならハッシュを計算せず`null`を返すのに、受け側が
 *    保存済みハッシュと`null`を比較していたため、登録済み全ファイルに
 *    毎回`FILE_CHANGED`が起票される」
 * `null`は「未取得」であって「不一致」ではない（INV-24）。
 *
 * あわせてINV-25（絞込と件数上限）も固定する。絞込がないと運用2年後に
 * 1回20,000回のDrive API呼出になる。
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

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: names.customer, values: [sheetHeader(37, '顧客ID')]},
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
    gas.evaluate("SETTINGS.RESCAN_TARGET_DAYS=90; SETTINGS.RESCAN_MAX_FILES_PER_RUN=200;");
  }

  const NOW = '2026-08-26T00:00:00+09:00';

  function indexRow(fileId, overrides = {}) {
    return Object.assign({
      fileId,
      state: 'COMPLETED',
      fileModifiedTime: '2026-08-20T00:00:00+09:00',
      fileRevision: 'r1',
      binaryHash: 'a'.repeat(64)
    }, overrides);
  }

  // ---- CR-8：メタ情報が未変化なら「変更なし」。全件起票しない ----
  test('CR-8/INV-24: unchanged files are not reported as changed when no hash was computed', () => {
    setup();
    const rows = ['f1', 'f2', 'f3'].map((id) => indexRow(id));
    const meta = {
      f1: {modifiedTime: '2026-08-20T00:00:00+09:00', revisionId: 'r1'},
      f2: {modifiedTime: '2026-08-20T00:00:00+09:00', revisionId: 'r1'},
      f3: {modifiedTime: '2026-08-20T00:00:00+09:00', revisionId: 'r1'}
    };
    // メタが未変化なので computeHash は呼ばれないはず
    let hashCalls = 0;
    const result = gas.call('runProcessedFileRescan', [{
      customerId: 'C001', indexRows: rows, metaById: meta,
      computeHash: () => { hashCalls += 1; return 'b'.repeat(64); },
      options: {now: NOW}, now: NOW
    }]);

    assert.equal(plain(result).changedCount, 0,
      'unchanged files must not raise FILE_CHANGED');
    assert.equal(hashCalls, 0, 'the hash must not be computed for unchanged metadata');
    assert.equal(plain(result).registeredReviewIds.length, 0);
  });

  // ---- メタが変わり、ハッシュも違えば「変更あり」 ----
  test('6.5: a file whose metadata and hash both changed raises FILE_CHANGED once', () => {
    setup();
    const rows = [indexRow('f1')];
    const meta = {f1: {modifiedTime: '2026-08-25T00:00:00+09:00', revisionId: 'r2'}};
    const result = gas.call('runProcessedFileRescan', [{
      customerId: 'C001', indexRows: rows, metaById: meta,
      computeHash: () => 'b'.repeat(64),
      options: {now: NOW}, now: NOW
    }]);

    assert.equal(plain(result).changedCount, 1);
    assert.equal(plain(result).registeredReviewIds.length, 1);
    assert.equal(gas.call('openReviews', [{fileId: 'f1'}]).length, 1);
  });

  // ---- メタは変わったが中身は同じ → 変更なし（保存し直しただけ） ----
  test('6.5: a re-saved file with identical bytes is not a change', () => {
    setup();
    const rows = [indexRow('f1')];
    const meta = {f1: {modifiedTime: '2026-08-25T00:00:00+09:00', revisionId: 'r2'}};
    const result = gas.call('runProcessedFileRescan', [{
      customerId: 'C001', indexRows: rows, metaById: meta,
      computeHash: () => 'a'.repeat(64),   // 保存済みと同じ
      options: {now: NOW}, now: NOW
    }]);
    assert.equal(plain(result).changedCount, 0);
  });

  // ---- ファイル単位の抑止：2回走らせても要確認は1件 ----
  test('6.5: rescanning twice does not stack duplicate FILE_CHANGED reviews', () => {
    setup();
    const rows = [indexRow('f1')];
    const meta = {f1: {modifiedTime: '2026-08-25T00:00:00+09:00', revisionId: 'r2'}};
    const args = {
      customerId: 'C001', indexRows: rows, metaById: meta,
      computeHash: () => 'b'.repeat(64), options: {now: NOW}, now: NOW
    };
    gas.call('runProcessedFileRescan', [args]);
    const second = gas.call('runProcessedFileRescan', [args]);

    assert.equal(plain(second).registeredReviewIds.length, 0, 'suppressed on the second run');
    assert.equal(gas.call('openReviews', [{fileId: 'f1'}]).length, 1);
  });

  // ---- INV-25：対象状態で絞る ----
  test('INV-25: only states that can hold reserved rows are rescanned', () => {
    setup();
    const rows = [
      indexRow('f1', {state: 'COMPLETED'}),
      indexRow('f2', {state: 'REVIEW_WAIT'}),
      indexRow('f3', {state: 'WRITING'}),
      indexRow('f4', {state: 'FAILED'}),
      indexRow('f5', {state: 'DISCOVERED'}),      // 対象外
      indexRow('f6', {state: 'CANCELED'})         // 対象外
    ];
    const selection = plain(gas.call('selectRescanTargets', [rows, {now: NOW}]));
    assert.equal(selection.targets.length, 4);
    assert.deepEqual(selection.targets.map((t) => t.fileId), ['f1', 'f2', 'f3', 'f4']);
  });

  // ---- INV-25：古いファイルは、freee未取込があるときだけ対象 ----
  test('INV-25: an old file is rescanned only when it still has un-imported transactions', () => {
    setup();
    const rows = [
      indexRow('old1', {fileModifiedTime: '2025-01-01T00:00:00+09:00'}),
      indexRow('old2', {fileModifiedTime: '2025-01-01T00:00:00+09:00'})
    ];
    const selection = plain(gas.call('selectRescanTargets', [rows, {
      now: NOW, hasUnimported: (fileId) => fileId === 'old2'
    }]));
    assert.equal(selection.targets.length, 1);
    assert.equal(selection.targets[0].fileId, 'old2');
  });

  // ---- INV-25：件数上限。打ち切った件数を黙って隠さない ----
  test('INV-25: the run is capped and reports how many files it deferred', () => {
    setup();
    const rows = [];
    for (let i = 0; i < 10; i += 1) rows.push(indexRow('f' + i));
    const selection = plain(gas.call('selectRescanTargets', [rows, {now: NOW, maxFiles: 4}]));

    assert.equal(selection.targets.length, 4);
    assert.equal(selection.deferred, 6, 'the deferred count must be reported, not silently dropped');
    assert.equal(selection.consideredCount, 10);
  });

  // ---- 見つからないファイルは変更扱いにしない ----
  test('6.5: a file missing from Drive is reported as not-found, not as changed', () => {
    setup();
    const result = plain(gas.call('runProcessedFileRescan', [{
      customerId: 'C001', indexRows: [indexRow('gone')], metaById: {},
      computeHash: () => 'b'.repeat(64), options: {now: NOW}, now: NOW
    }]));
    assert.equal(result.changedCount, 0);
    assert.equal(result.detections[0].reason, 'FILE_NOT_FOUND');
  });
};

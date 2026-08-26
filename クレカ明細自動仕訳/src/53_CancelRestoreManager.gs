'use strict';

/**
 * 4.29 取消し・復元。
 *
 * 取消しは常に`CANCELED`を経由する2段階である（6.4）。`COMPLETED`や`WRITING`から
 * `DISCOVERED`への直接遷移は遷移表に存在せず、1段階で実装すると必ず
 * `StateTransitionError`になる（INV-10）。
 *
 * 仕様17.3の3つの対象（転記行・要確認・辞書候補）のうち、本モジュールが直接
 * 扱うのは転記行と取引ログだけである。要確認と辞書は、影響を受けたIDを返して
 * 呼出元が処理する。12章の依存関係に循環を作らないため（4.29）。
 */

/** 取消し前の行内容と数式状態を監査用に取る（6.4 手順5）。 */
function snapshotRowForCancel_(index, rowNumber) {
  return {
    rowNumber: rowNumber,
    values: getAllValuesByRow(index, rowNumber),
    formulas: getFormulasByRow(index, rowNumber)
  };
}

/**
 * 取消し。
 *
 * @param {!Object} input
 *   customer, fileId, runId, fullTxIds, choice（'REPROCESS'|'CANCELED'）,
 *   leaseId, index, actor, reason
 * @return {!Object} affectedReviewIds / affectedDictIds を含む結果
 */
function cancelTransactions(input) {
  if (!input || !input.customer || !input.fileId) {
    throw new TypeError('cancelTransactions requires customer and fileId');
  }
  var choice = String(input.choice || 'CANCELED');
  if (choice !== 'REPROCESS' && choice !== 'CANCELED') {
    throw new TypeError('choice must be REPROCESS or CANCELED');
  }

  var targets = (input.fullTxIds && input.fullTxIds.length)
    ? input.fullTxIds.map(function(id) { return getTransaction(id); }).filter(Boolean)
    : getTransactionsByStatus(input.fileId,
        [TX_STATUS.PREPARED, TX_STATUS.WRITING, TX_STATUS.COMMITTED, TX_STATUS.REVIEW_REQUIRED]);

  // 手順1・2：freee取込済みの取引は本経路で自動削除しない（仕様17.3）。
  var imported = targets.filter(function(tx) {
    return tx.freeeStatus === FREEE_IMPORT_STATUS.IMPORTED ||
           tx.freeeStatus === FREEE_IMPORT_STATUS.NEEDS_FREEE_FIX;
  });
  if (imported.length && !input.allowImported) {
    throw new StateTransitionError(
      'freee-imported transactions require an administrator decision: ' +
      imported.map(function(tx) { return tx.fullTxId; }).join(','));
  }

  var result = {
    canceled: [], clearedRows: [], affectedReviewIds: [], affectedDictIds: [],
    snapshots: [], choice: choice
  };

  targets.forEach(function(tx) {
    // 手順5：取消し前の行内容・数式状態を保存する。
    var hit = input.index ? getRowByTxId(input.index, tx.fullTxId) : null;
    var rowNumber = hit && hit.matchCount === 1 ? hit.rowNumber : null;
    if (rowNumber) result.snapshots.push(snapshotRowForCancel_(input.index, rowNumber));

    // 手順6：取引状態を CANCELED へ比較更新する。
    // PREPARED / WRITING / COMMITTED / REVIEW_REQUIRED のいずれからも可（4.32）。
    updateTransactionStatus(tx.fullTxId, tx.transactionStatus, TX_STATUS.CANCELED);
    result.canceled.push(tx.fullTxId);

    // 手順7：転記行のクリア。未freee取込のみ。
    if (rowNumber) {
      clearTransactionRows(input.customer, [rowNumber], input.leaseId, input.fileId);
      result.clearedRows.push(rowNumber);
    }

    // 手順12・13の材料。本モジュールは呼ばず、IDを返すだけにする（循環回避）。
    openReviews({fullTxId: tx.fullTxId}).forEach(function(review) {
      if (result.affectedReviewIds.indexOf(review.reviewId) < 0) {
        result.affectedReviewIds.push(review.reviewId);
      }
    });
    if (tx.learnedDictIds) {
      [].concat(tx.learnedDictIds).forEach(function(id) {
        if (result.affectedDictIds.indexOf(id) < 0) result.affectedDictIds.push(id);
      });
    }
  });

  // 手順9：読取確認。空でない値が残っていれば空き行として解放しない。
  if (result.clearedRows.length) {
    var verifyWrites = result.clearedRows.map(function(rowNumber) {
      return {rowNumber: rowNumber, fullTxId: null,
              values: {b: '', f: '', i: '', k: '', m: ''}};
    });
    var verified = verifyWrittenValues(input.customer, verifyWrites);
    var dirty = verified.filter(function(v) { return !v.ok; });
    if (dirty.length) {
      throw new IntegrityError('DESTINATION_VALUE_MISMATCH',
        'Cleared rows still hold values: ' +
        dirty.map(function(v) { return v.rowNumber; }).join(','));
    }
  }

  // 手順14：選択肢Aは取引ログをsupersedeする。
  // これをしないと、内容が変わっていないファイルの再処理が
  // 明細内容ハッシュ一致による重複停止で妨げられる（INV-03・仕様17.3）。
  if (choice === 'REPROCESS') {
    // 無効化理由は2.1.5 S列の許容値と同じ語彙を使う（`CANCEL_REPROCESS`）。
    // 要確認の除外理由（REVIEW_EXCLUDE_REASON）とは別の語彙である。
    result.canceled.forEach(function(fullTxId) {
      supersede(fullTxId, DICT_INVALIDATION_REASON.CANCEL_REPROCESS, input.actor || null);
    });
    result.superseded = result.canceled.slice();
  }

  return result;
}

/**
 * ファイル状態の2段階遷移（6.4 手順11・15）。
 *
 * 選択肢Aでも、`COMPLETED`や`WRITING`から`DISCOVERED`へ直接は行けない。
 * 必ず`CANCELED`を経由する（INV-10）。
 */
function applyCancelFileState(fileId, fromState, choice) {
  transitionFileState(fileId, fromState, FILE_STATE.CANCELED, null);
  if (String(choice) === 'REPROCESS') {
    transitionFileState(fileId, FILE_STATE.CANCELED, FILE_STATE.DISCOVERED, null);
    return FILE_STATE.DISCOVERED;
  }
  return FILE_STATE.CANCELED;
}

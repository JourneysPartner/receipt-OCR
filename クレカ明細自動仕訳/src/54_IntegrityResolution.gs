'use strict';

/**
 * 4.29 手動変更・削除・freee側修正への対処（仕様16.3・17.1・17.2）。
 *
 * 転記先は顧客のfreee出納帳であり、担当者が手で直すことがある。それ自体は
 * 正当な運用であって、システムが勝手に上書きしてはならない。整合性チェックが
 * 検出した差分について、**採用するか戻すかは人が決める**。
 */

/** `INTEGRITY`種別に提示する操作（4.26 解決操作の表）。 */
var INTEGRITY_OPERATIONS_ = Object.freeze([
  'ACCEPT_MANUAL_CHANGE', 'REVERT_TO_SYSTEM_VALUE', 'RESTORE_ROW',
  'ACCEPT_DELETION', 'CONFIRM_FREEE_FIXED', 'CONFIRM_INTEGRITY_RESOLVED', 'EXCLUDE'
]);

function availableIntegrityOperations() {
  return INTEGRITY_OPERATIONS_.slice();
}

/**
 * 手動変更を採用する（仕様17.2）。
 *
 * 現在のシート値を予定値・読取確認値の**両方へ**反映する（INV-01）。
 * 片方だけ書くと、次回の整合性チェックが同じ行をまた手動変更として
 * 検出し、担当者が何度採用しても検出され続ける。
 *
 * **転記先には書き込まない。** 担当者が入れた値が正しいと認めるのだから、
 * 書き戻す必要がない。
 */
function acceptManualChange(fullTxId, actor, options) {
  options = options || {};
  var tx = getTransaction(fullTxId);
  if (!tx) throw new IntegrityError(null, 'Transaction not found: ' + fullTxId);
  if (tx.transactionStatus !== TX_STATUS.COMMITTED) {
    throw new StateTransitionError(
      'Manual changes are only accepted on committed transactions, not ' + tx.transactionStatus);
  }
  var customer = options.customer || getCustomerById(tx.customerId);
  // 1行のために全シートを読まない（INV-08）。対象行だけを1リクエストで読む。
  var current = options.index
    ? getValuesByRow(options.index, Number(tx.destinationRow))
    : readDestinationRows_(customer, [Number(tx.destinationRow)])[Number(tx.destinationRow)];
  if (!current) {
    throw new IntegrityError(null, 'Destination row not found for ' + fullTxId);
  }

  updateWrittenValues(fullTxId, current, current);

  // freee取込済みの取引を後から変えた場合、freee側は古い値のままである。
  // システムはfreeeを直せないので、直す必要があることを状態として残す。
  var freeeWarning = null;
  if (tx.freeeStatus === FREEE_IMPORT_STATUS.IMPORTED) {
    updateFreeeStatus(fullTxId, FREEE_IMPORT_STATUS.IMPORTED,
      FREEE_IMPORT_STATUS.NEEDS_FREEE_FIX, tx.batchId || null);
    freeeWarning = 'NEEDS_FREEE_FIX';
  }

  appendAudit({
    type: 'MANUAL_CHANGE', actor: actor, targetType: 'TRANSACTION', targetId: fullTxId,
    customerId: tx.customerId,
    before: {planned: tx.planned, verified: tx.verified},
    after: {planned: current, verified: current, freeeStatus: freeeWarning},
    reason: options.reason || ''
  });
  return {fullTxId: fullTxId, accepted: current, freeeWarning: freeeWarning};
}

/**
 * システム保存値へ戻す（仕様17.2）。
 *
 * 保存してある予定値を書き戻し、読取確認して、予定値・読取確認値を
 * 同時に更新する（INV-01）。**読取確認を省かない** ── 書き戻した値が
 * 実際に入ったことを確かめないまま「戻した」と記録すると、次回また
 * 同じ差分が出る。
 */
function revertManualChange(fullTxId, actor, options) {
  options = options || {};
  var tx = getTransaction(fullTxId);
  if (!tx) throw new IntegrityError(null, 'Transaction not found: ' + fullTxId);
  if (tx.transactionStatus !== TX_STATUS.COMMITTED) {
    throw new StateTransitionError(
      'Only a committed transaction can be reverted, not ' + tx.transactionStatus);
  }
  var customer = options.customer || getCustomerById(tx.customerId);
  var leaseId = acquireLease(tx.customerId, tx.fileId, options.runId || null,
    actor, LEASE_PURPOSE.WRITE_ONLY);
  try {
    var rowWrite = buildRowWrite(Number(tx.destinationRow),
      {fullTxId: fullTxId, planned: tx.planned});
    applyPlainTextFormat(customer, [rowWrite.rowNumber]);
    writeTransactionRows(customer, [rowWrite], leaseId, tx.fileId);

    var verified = verifyWrittenValues(customer, [rowWrite]);
    if (!verified[0] || !verified[0].ok) {
      throw new IntegrityError('DESTINATION_VALUE_MISMATCH',
        'The stored values could not be written back for ' + fullTxId);
    }
    updateWrittenValues(fullTxId, tx.planned, verified[0].values);

    appendAudit({
      type: 'MANUAL_CHANGE', actor: actor, targetType: 'TRANSACTION', targetId: fullTxId,
      customerId: tx.customerId,
      before: {verified: tx.verified}, after: {verified: verified[0].values},
      reason: options.reason || 'REVERT_TO_SYSTEM_VALUE'
    });
    return {fullTxId: fullTxId, restored: verified[0].values};
  } finally {
    releaseLease(tx.fileId, options.runId || null, 'REVERT_DONE');
  }
}

/**
 * 削除を受け入れる（仕様17.1）。
 *
 * 担当者が転記行ごと消した場合の受入である。`DELETED_ACCEPTED`は終端で
 * あり、これ以上の追跡をやめることを意味する。**転記先へ書き戻さない。**
 */
function acceptDeletion(fullTxId, actor, options) {
  options = options || {};
  var tx = getTransaction(fullTxId);
  if (!tx) throw new IntegrityError(null, 'Transaction not found: ' + fullTxId);

  updateTransactionStatus(fullTxId, TX_STATUS.COMMITTED, TX_STATUS.DELETED_ACCEPTED);
  appendAudit({
    type: 'ROW_DELETE', actor: actor, targetType: 'TRANSACTION', targetId: fullTxId,
    customerId: tx.customerId,
    before: {transactionStatus: TX_STATUS.COMMITTED},
    after: {transactionStatus: TX_STATUS.DELETED_ACCEPTED},
    reason: options.reason || ''
  });
  return {fullTxId: fullTxId, transactionStatus: TX_STATUS.DELETED_ACCEPTED};
}

/**
 * 転記済み行を復元する（仕様17.1）。**オーナー管理者のみ。**
 *
 * 削除された行を、取引ログの保存値から未使用行へ書き直す。役割を限るのは、
 * 復元が「消えたはずの行が顧客の帳簿へ再び現れる」操作だからである。
 */
function restoreRow(fullTxId, actor, options) {
  options = options || {};
  if (String(options.role) !== 'OWNER_ADMIN') {
    throw new AuthorizationError(
      'RESTORE_ROW requires the owner administrator role');
  }
  var tx = getTransaction(fullTxId);
  if (!tx) throw new IntegrityError(null, 'Transaction not found: ' + fullTxId);

  var customer = options.customer || getCustomerById(tx.customerId);
  var leaseId = acquireLease(tx.customerId, tx.fileId, options.runId || null,
    actor, LEASE_PURPOSE.WRITE_ONLY);
  try {
    var reservation = reserveDestinationRows(customer, [fullTxId], tx.fileId, leaseId);
    var entry = (reservation.reserved || [])[0];
    if (!entry) {
      throw new IntegrityError('DESTINATION_SCHEMA_MISMATCH',
        'No empty row could be reserved to restore ' + fullTxId);
    }
    var rowWrite = buildRowWrite(Number(entry.rowNumber),
      {fullTxId: fullTxId, planned: tx.planned});
    applyPlainTextFormat(customer, [rowWrite.rowNumber]);
    writeTransactionRows(customer, [rowWrite], leaseId, tx.fileId);

    var verified = verifyWrittenValues(customer, [rowWrite]);
    if (!verified[0] || !verified[0].ok) {
      // 値は書込済みなので全列をクリアする。取引ID列だけ消すと、値が
      // 残ったまま誰からも引けない行になる（70の解放と同じ規律）。
      clearTransactionRows(customer, [entry.rowNumber], leaseId, tx.fileId);
      throw new IntegrityError('DESTINATION_VALUE_MISMATCH',
        'The row could not be restored for ' + fullTxId);
    }
    updateWrittenValues(fullTxId, tx.planned, verified[0].values);
    updateTransactionLocation(fullTxId, entry.rowNumber);

    appendAudit({
      type: 'ROW_RESTORE', actor: actor, approver: actor,
      targetType: 'TRANSACTION', targetId: fullTxId, customerId: tx.customerId,
      before: {destinationRow: tx.destinationRow},
      after: {destinationRow: entry.rowNumber},
      reason: options.reason || ''
    });
    return {fullTxId: fullTxId, rowNumber: entry.rowNumber};
  } finally {
    releaseLease(tx.fileId, options.runId || null, 'RESTORE_DONE');
  }
}

/**
 * freee側の修正完了を確認する（4.26）。
 *
 * `NEEDS_FREEE_FIX → IMPORTED`へ戻し、取込時点ハッシュを現在値で更新する。
 *
 * **この経路が無いと復帰できない。** 整合性チェックの検査4は`IMPORTED`
 * だけを対象とするので、`NEEDS_FREEE_FIX`のまま放置しても検出はされない
 * が、freee側が直っていることを記録する手段が他にない。
 */
function confirmFreeeFixed(fullTxId, actor, options) {
  options = options || {};
  var tx = getTransaction(fullTxId);
  if (!tx) throw new IntegrityError(null, 'Transaction not found: ' + fullTxId);
  if (tx.freeeStatus !== FREEE_IMPORT_STATUS.NEEDS_FREEE_FIX) {
    throw new StateTransitionError(
      'CONFIRM_FREEE_FIXED applies only to NEEDS_FREEE_FIX, not ' + tx.freeeStatus);
  }
  updateFreeeStatus(fullTxId, FREEE_IMPORT_STATUS.NEEDS_FREEE_FIX,
    FREEE_IMPORT_STATUS.IMPORTED, tx.batchId || null);

  appendAudit({
    type: 'FREEE_STATUS', actor: actor, targetType: 'TRANSACTION', targetId: fullTxId,
    customerId: tx.customerId,
    before: {freeeStatus: FREEE_IMPORT_STATUS.NEEDS_FREEE_FIX},
    after: {freeeStatus: FREEE_IMPORT_STATUS.IMPORTED},
    reason: options.reason || ''
  });
  return {fullTxId: fullTxId, freeeStatus: FREEE_IMPORT_STATUS.IMPORTED};
}

/**
 * `INTEGRITY`の要確認を解決する。
 *
 * 取引単位の他の種別と同じく、自らの要確認を解決したうえで4.26.2を
 * 再評価する（INV-37）。ただし`ACCEPT_DELETION`は終端へ送るので
 * 確定条件を評価しない。
 */
function resolveIntegrityReview(reviewId, operation, input) {
  input = input || {};
  var review = getReviewById(reviewId);
  if (!review) throw new IntegrityError(null, 'Review not found: ' + reviewId);
  if (review.reviewType !== REVIEW_TYPE.INTEGRITY) {
    throw new StateTransitionError(
      'resolveIntegrityReview handles INTEGRITY reviews, not ' + review.reviewType);
  }
  if (review.status !== 'OPEN' && review.status !== 'IN_PROGRESS') {
    throw new StateTransitionError('Review is already settled: ' + reviewId);
  }
  var op = String(operation);
  if (INTEGRITY_OPERATIONS_.indexOf(op) < 0) {
    throw new StateTransitionError('Operation ' + op + ' is not offered for INTEGRITY');
  }
  var actor = input.actor || activeUserEmail_();
  var outcome = null;

  switch (op) {
    case 'ACCEPT_MANUAL_CHANGE':
      outcome = acceptManualChange(review.fullTxId, actor, input); break;
    case 'REVERT_TO_SYSTEM_VALUE':
      outcome = revertManualChange(review.fullTxId, actor, input); break;
    case 'RESTORE_ROW':
      outcome = restoreRow(review.fullTxId, actor, input); break;
    case 'CONFIRM_FREEE_FIXED':
      outcome = confirmFreeeFixed(review.fullTxId, actor, input); break;
    case 'ACCEPT_DELETION':
      outcome = acceptDeletion(review.fullTxId, actor, input);
      updateReviewStatus(reviewId, 'RESOLVED', {actor: actor, operation: op});
      // `DELETED_ACCEPTED`は終端である。確定条件を評価しない。
      return {reviewId: reviewId, operation: op, committed: false,
        unmetConditions: [], openReviewTypes: [], outcome: outcome};
    case 'CONFIRM_INTEGRITY_RESOLVED': {
      // システム管理者の操作である（4.26の表）。
      if (['SYSTEM_ADMIN', 'OWNER_ADMIN'].indexOf(String(input.role)) < 0) {
        throw new StateTransitionError(
          'CONFIRM_INTEGRITY_RESOLVED requires the system administrator role, not ' +
          (input.role || '(none)'));
      }
      // 是正が済んだことの確認である。**材料が無ければ素通りせず、自分で
      // 整合性チェックを再実行する。** 呼出側が渡し忘れただけで確認なしに
      // RESOLVED になるなら、この操作は「閉じるボタン」でしかない ──
      // 不整合が残ったまま閉じると、問題は直らず見えなくなるだけである。
      var recheck = input.recheck;
      if (!recheck) {
        var customer2 = getCustomerById(review.customerId);
        recheck = runIntegrityCheck({
          index: buildIndex(customer2),
          txLogs: getTransactionsByStatus(review.fileId, [TX_STATUS.COMMITTED]),
          fileState: getFileState(review.fileId)
        });
      }
      if (recheck.ok === false) {
        throw new StateTransitionError(
          'The integrity finding is still present; it cannot be confirmed as resolved');
      }
      // M18：ファイルが REVIEW_WAIT なら検証へ戻す。
      var currentState = getFileState(review.fileId);
      if (currentState === FILE_STATE.REVIEW_WAIT) {
        transitionFileState(review.fileId, currentState, FILE_STATE.VALIDATING,
          input.runId || null);
      }
      break;
    }
    case 'EXCLUDE':
      return resolveReview(reviewId, 'EXCLUDE', input);
    default:
      throw new StateTransitionError('Unsupported operation: ' + op);
  }

  updateReviewStatus(reviewId, 'RESOLVED',
    {actor: actor, operation: op, role: input.role || null});
  appendAudit({
    type: 'REVIEW_RESOLVE', actor: actor, targetType: 'TRANSACTION',
    targetId: review.fullTxId, after: {operation: op}
  });
  var commit = commitIfConditionsMet(review.fullTxId);
  return Object.assign({reviewId: reviewId, operation: op, outcome: outcome}, commit);
}

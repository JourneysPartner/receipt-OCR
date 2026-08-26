'use strict';

/**
 * 4.26 解決操作（ファイル単位）。
 *
 * **ファイルが`REVIEW_WAIT`から出る唯一の経路である。** どのファイル単位
 * 種別にも終端へ至る道が必ず1つある状態を保つ（INV-31）。道がない種別が
 * 1つでもあると、そこへ落ちたファイルは誰にも動かせなくなる。
 *
 * 承認して再合流させる操作は、**その事実を必ずシートへ永続化する**
 * （INV-28）。永続化しないと再検証で同じ要因が再検出され、担当者が何度
 * 承認しても`REVIEW_WAIT`へ戻る無限ループになる。
 */

/** 種別ごとに提示する操作（4.26 解決操作の表）。 */
var FILE_REVIEW_OPERATIONS_ = Object.freeze({
  FORMAT_UNKNOWN: ['REGISTER_FORMAT', 'CANCEL_FILE'],
  FORMAT_AMBIGUOUS: ['REGISTER_FORMAT', 'CANCEL_FILE'],
  MULTI_SHEET: ['SELECT_TARGET_SHEET', 'REGISTER_FORMAT', 'CANCEL_FILE'],
  DUPLICATE: ['IMPORT_AS_NEW_FILE', 'UPDATE_PURPOSE', 'KEEP_ORIGINAL_RESULT', 'CANCEL_FILE'],
  FILE_CHANGED: ['APPLY_FILE_DIFF', 'ADOPT_AS_NEW_TRANSACTION', 'KEEP_ORIGINAL_RESULT', 'CANCEL_FILE'],
  COUNT_TOTAL_MISMATCH: ['APPROVE_COUNT_MISMATCH', 'REJECT_COUNT_MISMATCH', 'CANCEL_FILE'],
  EMPTY_FILE: ['CONFIRM_EMPTY_FILE', 'CANCEL_FILE'],
  INPUT_LIMIT: ['RESIZE_INPUT', 'CANCEL_FILE'],
  DESTINATION_FIX: ['CONFIRM_DESTINATION_FIXED', 'CANCEL_FILE'],
  SCAN_TRUNCATED: ['APPROVE_SCAN_TRUNCATION', 'REGISTER_FORMAT', 'CANCEL_FILE']
});

/** 承認を永続化して再合流する操作と、その要因コード（INV-28）。 */
var APPROVAL_BACKED_OPERATIONS_ = Object.freeze({
  APPROVE_COUNT_MISMATCH: 'COUNT_TOTAL_MISMATCH',
  IMPORT_AS_NEW_FILE: 'PURPOSE_REVISION_CANDIDATE',
  APPROVE_SCAN_TRUNCATION: 'SCAN_TRUNCATION_SUSPECTED',
  RESIZE_INPUT: 'INPUT_LIMIT_EXCEEDED'
});

function availableFileResolveOperations(reviewType) {
  return (FILE_REVIEW_OPERATIONS_[String(reviewType)] || []).slice();
}

/**
 * ファイル単位の要確認を解決する。
 *
 * @param {string} reviewId
 * @param {string} operation
 * @param {!Object} input runId, actor, および操作ごとの入力
 * @return {{reviewId, operation, nextState, approvalPersisted}}
 */
function resolveFileReview(reviewId, operation, input) {
  input = input || {};
  var review = getReviewById(reviewId);
  if (!review) throw new IntegrityError(null, 'Review not found: ' + reviewId);
  if (review.status !== 'OPEN' && review.status !== 'IN_PROGRESS') {
    throw new StateTransitionError(
      'Review is already settled: ' + reviewId + ' (' + review.status + ')');
  }
  var allowed = availableFileResolveOperations(review.reviewType);
  if (allowed.indexOf(String(operation)) < 0) {
    throw new StateTransitionError(
      'Operation ' + operation + ' is not offered for ' + review.reviewType);
  }
  var actor = input.actor || activeUserEmail_();
  var op = String(operation);

  if (op === 'CANCEL_FILE') return cancelFileFromReview_(review, actor, input);
  if (op === 'CONFIRM_EMPTY_FILE') return confirmEmptyFile_(review, actor, input);
  if (op === 'REJECT_COUNT_MISMATCH') {
    return moveFile_(review, op, actor, input, FILE_STATE.CUSTOMER_FIX_REQUIRED);
  }
  if (op === 'RESIZE_INPUT' && input.askCustomerToSplit === true) {
    // 顧客にファイル分割を依頼する場合は承認ではない。差し戻す。
    return moveFile_(review, op, actor, input, FILE_STATE.CUSTOMER_FIX_REQUIRED);
  }
  if (APPROVAL_BACKED_OPERATIONS_[op]) {
    return approveAndRevalidate_(review, op, actor, input);
  }
  if (op === 'KEEP_ORIGINAL_RESULT') return keepOriginalResult_(review, actor, input);
  if (op === 'SELECT_TARGET_SHEET') return selectTargetSheet_(review, actor, input);

  // 再検査へ戻すだけの操作（REGISTER_FORMAT / CONFIRM_DESTINATION_FIXED /
  // UPDATE_PURPOSE / APPLY_FILE_DIFF / ADOPT_AS_NEW_TRANSACTION）。
  //
  // 是正が済んだかどうかの確認は各操作の呼出前に行う。ここで無関係な
  // 検証を課さない（INV-41）── ある不備からの復旧経路が、その不備と
  // 無関係な検証で拒否されると、復旧そのものが不能になる。
  return moveFile_(review, op, actor, input, FILE_STATE.VALIDATING);
}

/** 承認を永続化してから再検証へ戻す（INV-28）。 */
function approveAndRevalidate_(review, operation, actor, input) {
  var code = APPROVAL_BACKED_OPERATIONS_[operation];
  var record = getProcessLogRecord_(review.fileId);
  if (!record) throw new IntegrityError(null, 'Process log not found: ' + review.fileId);
  // 承認は**提出時点**のハッシュに結び付ける。現在値ハッシュに結び付けると、
  // 担当者が日付を修正した瞬間にハッシュが変わり、承認が無効化されて
  // 同じ区分2へ戻る。
  var contentHash = record.values[PROCESS_FIELD_COLUMNS_.submittedContentHash - 1];
  var hashVersion = record.values[PROCESS_FIELD_COLUMNS_.hashVersion - 1];
  if (!contentHash || !hashVersion) {
    throw new IntegrityError(null,
      'Cannot approve without the submitted content hash for ' + review.fileId);
  }

  // **承認を書いてから状態を動かす。** 逆順だと、承認の書込に失敗した場合に
  // 再検証へ進んで同じ要因で戻り、ループになる。
  appendCategory2Approval(review.fileId, createValidationApproval(
    code, contentHash, hashVersion, actor,
    {reason: input.reason, evidence: input.evidence}));

  var result = moveFile_(review, operation, actor, input, FILE_STATE.VALIDATING);
  result.approvalPersisted = code;
  return result;
}

function confirmEmptyFile_(review, actor, input) {
  // 処理ログAN列を立ててから完了させる。立てずに完了させると、
  // 1行も転記していないファイルが【済】になる（M20）。
  setEmptyFileConfirmed(review.fileId, actor);
  return moveFile_(review, 'CONFIRM_EMPTY_FILE', actor, input, FILE_STATE.COMPLETED);
}

function selectTargetSheet_(review, actor, input) {
  if (!input.sheetName) {
    throw new TypeError('SELECT_TARGET_SHEET requires a sheet name');
  }
  setPermanentIndexTargetSheet(review.fileId, String(input.sheetName));
  return moveFile_(review, 'SELECT_TARGET_SHEET', actor, input, FILE_STATE.VALIDATING);
}

function keepOriginalResult_(review, actor, input) {
  // `DUPLICATE`は新ファイルを取り込まない。`FILE_CHANGED`は取引に触れず
  // 要確認だけを閉じる。
  var next = review.reviewType === REVIEW_TYPE.DUPLICATE
    ? FILE_STATE.EXCLUDED : null;
  return moveFile_(review, 'KEEP_ORIGINAL_RESULT', actor, input, next);
}

function cancelFileFromReview_(review, actor, input) {
  var customer = getCustomerById(review.customerId);
  var leaseId = acquireLease(review.customerId, review.fileId, input.runId || null,
    actor, LEASE_PURPOSE.WRITE_ONLY);
  var outcome;
  try {
    outcome = cancelTransactions({
      customer: customer, fileId: review.fileId, runId: input.runId || null,
      choice: input.choice || 'CANCELED', leaseId: leaseId,
      index: buildIndex(customer)
    });
  } finally {
    releaseLease(review.fileId, input.runId || null, 'CANCEL_DONE');
  }

  // 取消しで根拠が消えた要確認をまとめて閉じる。開いたまま残すと、
  // 判断のしようがない要確認が一覧に滞留する。
  (outcome.affectedReviewIds || []).concat([review.reviewId]).forEach(function(id) {
    var target = getReviewById(id);
    if (!target || (target.status !== 'OPEN' && target.status !== 'IN_PROGRESS')) return;
    updateReviewStatus(id, 'EXCLUDED', {
      actor: actor, operation: 'CANCEL_FILE',
      excludeReason: REVIEW_EXCLUDE_REASON.CANCELED
    });
  });

  var current = getFileState(review.fileId);
  var nextState = applyCancelFileState(review.fileId, current, input.choice || 'CANCELED');
  appendAudit({
    type: 'REVIEW_RESOLVE', actor: actor, targetType: 'FILE',
    targetId: review.fileId, before: {fileState: current},
    after: {fileState: nextState, operation: 'CANCEL_FILE'}
  });
  return {
    reviewId: review.reviewId, operation: 'CANCEL_FILE',
    nextState: nextState, canceled: outcome.canceled, approvalPersisted: null
  };
}

/** 要確認を閉じ、必要ならファイル状態を遷移させる。 */
function moveFile_(review, operation, actor, input, nextState) {
  updateReviewStatus(review.reviewId, 'RESOLVED',
    {actor: actor, operation: operation, role: input.role || null});
  var current = getFileState(review.fileId);
  if (nextState && nextState !== current) {
    transitionFileState(review.fileId, current, nextState, input.runId || null);
  }
  appendAudit({
    type: 'REVIEW_RESOLVE', actor: actor, targetType: 'FILE',
    targetId: review.fileId, before: {fileState: current},
    after: {fileState: nextState || current, operation: operation}
  });
  return {
    reviewId: review.reviewId, operation: operation,
    nextState: nextState || current, approvalPersisted: null
  };
}

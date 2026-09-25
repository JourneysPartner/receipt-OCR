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
  FORMAT_UNKNOWN: ['REGISTER_FORMAT', 'CANCEL_FILE', 'RETURN_TO_CUSTOMER'],
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
 * 操作ごとの必要役割（4.26の表）。
 *
 * **記録するだけでは検査にならない。** 役割を要求する操作は入口で拒否する。
 * 形式登録や打切り承認は、明細の構造を理解するシステム管理者の判断として
 * 設計されている ── 確認担当者が実行できてしまうと、その前提が崩れる。
 */
var FILE_OPERATION_ROLES_ = Object.freeze({
  SELECT_TARGET_SHEET: ['SYSTEM_ADMIN', 'OWNER_ADMIN'],
  REGISTER_FORMAT: ['SYSTEM_ADMIN', 'OWNER_ADMIN'],
  RETURN_TO_CUSTOMER: ['SYSTEM_ADMIN', 'OWNER_ADMIN'],
  APPROVE_SCAN_TRUNCATION: ['SYSTEM_ADMIN', 'OWNER_ADMIN'],
  CONFIRM_DESTINATION_FIXED: ['SYSTEM_ADMIN', 'OWNER_ADMIN']
});

function assertOperationRole_(operation, role, allowedByOperation) {
  var allowed = allowedByOperation[String(operation)];
  if (!allowed) return;
  if (allowed.indexOf(String(role)) < 0) {
    throw new StateTransitionError(
      'Operation ' + operation + ' requires role ' + allowed.join('/') +
      ', not ' + (role || '(none)'));
  }
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
  assertOperationRole_(op, input.role, FILE_OPERATION_ROLES_);

  if (op === 'CANCEL_FILE') return cancelFileFromReview_(review, actor, input);
  if (op === 'CONFIRM_EMPTY_FILE') return confirmEmptyFile_(review, actor, input);
  if (op === 'REJECT_COUNT_MISMATCH') {
    return moveFile_(review, op, actor, input, FILE_STATE.CUSTOMER_FIX_REQUIRED);
  }
  if (op === 'RETURN_TO_CUSTOMER') {
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

  // FILE_CHANGED・DUPLICATE の固有操作。**汎用の「再検査へ戻す」へ流さない。**
  // UPDATE_PURPOSE を再検証へ戻すと重複ファイルが再取込され二重転記になる。
  // FILE_CHANGED は COMPLETED のファイルに立つのが典型で、
  // COMPLETED→VALIDATING は遷移表に無く必ず例外死する。
  if (op === 'UPDATE_PURPOSE') return updatePurpose_(review, actor, input);
  if (op === 'APPLY_FILE_DIFF') return applyFileDiff_(review, actor, input);
  if (op === 'ADOPT_AS_NEW_TRANSACTION') return adoptAsNewTransaction_(review, actor, input);

  // 再検査へ戻すだけの操作（REGISTER_FORMAT / CONFIRM_DESTINATION_FIXED）。
  //
  // 是正が済んだかどうかの確認は各操作の呼出前に行う。ここで無関係な
  // 検証を課さない（INV-41）── ある不備からの復旧経路が、その不備と
  // 無関係な検証で拒否されると、復旧そのものが不能になる。
  return moveFile_(review, op, actor, input, FILE_STATE.VALIDATING);
}

/**
 * 取引1件を登録し、転記先へ書いて確定まで進める共通経路。
 *
 * `ADOPT_AS_NEW_TRANSACTION`と`APPLY_FILE_DIFF`が共有する。通常の書込
 * ブロックと同じ部品（予約→書込→読取確認→INV-01→状態）を使う ──
 * ここに独自の書込を書くと、規則が二重になり片方だけ直す事故が起きる。
 */
function writeAdoptedTransaction_(customer, fileId, tx, leaseId, runId) {
  registerPrepared([tx], runId);
  var reservation = reserveDestinationRows(customer, [tx.fullTxId], fileId, leaseId);
  var entry = (reservation.reserved || [])[0];
  if (!entry) {
    throw new IntegrityError('DESTINATION_SCHEMA_MISMATCH',
      'No empty row could be reserved for ' + tx.fullTxId);
  }
  var rowWrite = buildRowWrite(Number(entry.rowNumber), tx);
  applyPlainTextFormat(customer, [rowWrite.rowNumber]);
  writeTransactionRows(customer, [rowWrite], leaseId, fileId);
  var verified = verifyWrittenValues(customer, [rowWrite]);
  if (!verified[0] || !verified[0].ok) {
    clearTransactionRows(customer, [entry.rowNumber], leaseId, fileId);
    throw new IntegrityError('DESTINATION_VALUE_MISMATCH',
      'Read-back verification failed for ' + tx.fullTxId);
  }
  updateWrittenValues(tx.fullTxId, tx.planned, verified[0].values);
  updateTransactionLocation(tx.fullTxId, entry.rowNumber);
  var finalStatus = derivePlannedFinalStatus({
    hasOpenReview: false,
    plannedB: tx.planned && tx.planned.b,
    partnerResolutionStatus: tx.partnerResolutionStatus
  });
  updateTransactionStatus(tx.fullTxId, TX_STATUS.PREPARED, finalStatus);
  return {fullTxId: tx.fullTxId, rowNumber: entry.rowNumber, status: finalStatus};
}

/** 処理ログJ・K・L列を再処理時点で更新する（6.5）。検出だけでは更新しない。 */
function applyNewFileMeta_(fileId, newFileMeta) {
  if (!newFileMeta) {
    throw new TypeError('The new file metadata is required, or the next rescan ' +
      're-detects the same change forever');
  }
  updateProcessLog(fileId, {
    fileUpdatedAt: newFileMeta.fileUpdatedAt || '',
    fileRevision: newFileMeta.fileRevision || '',
    binaryHash: newFileMeta.binaryHash || ''
  });
}

/**
 * `ADOPT_AS_NEW_TRANSACTION`：変更候補を別取引として採用する（INV-23）。
 *
 * **取引IDは再取込世代番号+1から決定的に導出する。恣意的な新IDを作らない。**
 * 乱数や時刻で作ると、回復や再走査が同じ明細を再導出できず、二重転記の
 * 検査がすべて素通りになる。元取引は維持する。
 *
 * ファイル状態は変えない。`FILE_CHANGED`は`COMPLETED`のファイルに立つのが
 * 典型であり、`COMPLETED→VALIDATING`は遷移表に存在しない。書込は
 * 解決操作と同じ`WRITE_ONLY`リースの経路で行う。
 */
function adoptAsNewTransaction_(review, actor, input) {
  if (!input.sourceTxId) {
    throw new TypeError('ADOPT_AS_NEW_TRANSACTION requires the source transaction id');
  }
  var original = getTransaction(input.sourceTxId);
  if (!original) throw new IntegrityError(null, 'Transaction not found: ' + input.sourceTxId);

  var generation = Number(original.generation || 0) + 1;
  var id = generateTransactionId({
    customerId: original.customerId, fileId: original.fileId,
    sourceSheetName: original.sourceSheetName || '',
    sourceRow: original.sourceRow, generation: generation
  });

  var supplied = input.transaction || {};
  var adopted = Object.assign({}, {
    customerId: original.customerId, fileId: original.fileId,
    sourceSheetName: original.sourceSheetName || '', sourceRow: original.sourceRow,
    formatId: original.formatId,
    originalDate: original.originalDate, originalMerchant: original.originalMerchant,
    originalAmount: original.originalAmount, originalPurpose: original.originalPurpose,
    identityHash: original.identityHash, contentHash: original.contentHash,
    occurrenceIndex: original.occurrenceIndex,
    partnerResolutionStatus: PARTNER_STATUS.UNRESOLVED,
    transactionIdVersion: id.version, hashVersion: original.hashVersion
  }, supplied, {
    fullTxId: id.full, displayTxId: id.display, generation: generation
  });

  var customer = getCustomerById(review.customerId);
  var leaseId = acquireLease(review.customerId, original.fileId, input.runId || null,
    actor, LEASE_PURPOSE.WRITE_ONLY);
  var written;
  try {
    written = writeAdoptedTransaction_(customer, original.fileId, adopted, leaseId,
      input.runId || null);
  } finally {
    releaseLease(original.fileId, input.runId || null, 'ADOPT_DONE');
  }
  applyNewFileMeta_(review.fileId, input.newFileMeta);

  var result = moveFile_(review, 'ADOPT_AS_NEW_TRANSACTION', actor, input, null);
  result.adoptedTxId = id.full;
  result.rowNumber = written.rowNumber;
  return result;
}

/**
 * `APPLY_FILE_DIFF`：取引同一性ハッシュの**多重集合差分**で差分取引を求め、
 * 追加分だけを起票する（INV-23）。
 *
 * 差分比率が`FILE_DIFF_MAX_RATIO`を超える場合は本操作を拒否して
 * `CANCEL_FILE`へ誘導する ── 大半が違うファイルは「変更された同じ
 * ファイル」ではなく別のファイルであり、差分の枠で飲み込むと既存取引との
 * 対応が取れなくなる。
 */
function applyFileDiff_(review, actor, input) {
  var newTransactions = input.newTransactions;
  if (!Array.isArray(newTransactions) || !newTransactions.length) {
    throw new TypeError('APPLY_FILE_DIFF requires the transactions extracted from the changed file');
  }

  // 多重集合として数える。同一ハッシュの正当な2件（同日同額同店）を
  // 単純な集合差分にすると、2件目が常に「追加」扱いになる。
  var existingCounts = Object.create(null);
  getTransactionsByStatus(review.fileId,
    [TX_STATUS.PREPARED, TX_STATUS.WRITING, TX_STATUS.COMMITTED, TX_STATUS.REVIEW_REQUIRED])
    .forEach(function(tx) {
      var key = String(tx.identityHash);
      existingCounts[key] = (existingCounts[key] || 0) + 1;
    });

  var added = [];
  newTransactions.forEach(function(tx) {
    var key = String(tx.identityHash);
    if (existingCounts[key] > 0) {
      existingCounts[key] -= 1;
      return;
    }
    added.push(tx);
  });

  var ratio = added.length / newTransactions.length;
  var maxRatio = Number(SETTINGS.FILE_DIFF_MAX_RATIO);
  if (Number.isFinite(maxRatio) && ratio > maxRatio) {
    throw new StateTransitionError(
      'The diff ratio ' + ratio.toFixed(2) + ' exceeds FILE_DIFF_MAX_RATIO (' + maxRatio +
      '); a mostly-different file is a different file - use CANCEL_FILE');
  }

  var customer = getCustomerById(review.customerId);
  var leaseId = acquireLease(review.customerId, review.fileId, input.runId || null,
    actor, LEASE_PURPOSE.WRITE_ONLY);
  var addedIds = [];
  try {
    added.forEach(function(tx) {
      var id = generateTransactionId({
        customerId: review.customerId, fileId: review.fileId,
        sourceSheetName: tx.sourceSheetName || '', sourceRow: tx.sourceRow,
        generation: Number(tx.generation || 0)
      });
      var prepared = Object.assign({
        customerId: review.customerId, fileId: review.fileId,
        sourceSheetName: tx.sourceSheetName || '',
        partnerResolutionStatus: PARTNER_STATUS.UNRESOLVED,
        transactionIdVersion: id.version, hashVersion: tx.hashVersion || VERSIONS.HASH
      }, tx, {fullTxId: id.full, displayTxId: id.display});
      writeAdoptedTransaction_(customer, review.fileId, prepared, leaseId,
        input.runId || null);
      addedIds.push(id.full);
    });
  } finally {
    releaseLease(review.fileId, input.runId || null, 'DIFF_DONE');
  }
  applyNewFileMeta_(review.fileId, input.newFileMeta);

  var result = moveFile_(review, 'APPLY_FILE_DIFF', actor, input, null);
  result.added = addedIds;
  result.diffRatio = ratio;
  return result;
}

/**
 * `UPDATE_PURPOSE`：既存取引のI列を更新し、重複ファイルは取り込まない。
 *
 * **再検証へ戻さない。** 戻すと重複として止まったファイルが再取込され、
 * 全明細が二重転記になる。更新対象は既存ファイル側の取引であり、
 * 新ファイルは`EXCLUDED`で閉じる。
 *
 * `freee取込状態 = IMPORTED`の取引は自動更新しない（仕様12.3）。freeeには
 * 既に旧値で仕訳が入っており、シートだけ変えると両者が食い違う。
 */
function updatePurpose_(review, actor, input) {
  if (!input.fullTxId || input.newPurpose === undefined || input.newPurpose === null) {
    throw new TypeError('UPDATE_PURPOSE requires the existing transaction id and the new purpose');
  }
  var tx = getTransaction(input.fullTxId);
  if (!tx) throw new IntegrityError(null, 'Transaction not found: ' + input.fullTxId);

  if (tx.freeeStatus === FREEE_IMPORT_STATUS.IMPORTED ||
      tx.freeeStatus === FREEE_IMPORT_STATUS.NEEDS_FREEE_FIX) {
    // 警告のみ。何も書き換えず、新ファイルだけ閉じる。
    var warnedResult = moveFile_(review, 'UPDATE_PURPOSE', actor, input, FILE_STATE.EXCLUDED);
    warnedResult.warned = 'FREEE_IMPORTED';
    return warnedResult;
  }

  var customer = getCustomerById(tx.customerId);
  var leaseId = acquireLease(tx.customerId, tx.fileId, input.runId || null,
    actor, LEASE_PURPOSE.WRITE_ONLY);
  try {
    var planned = Object.assign({}, tx.planned, {i: String(input.newPurpose)});
    var rowWrite = buildRowWrite(Number(tx.destinationRow),
      {fullTxId: tx.fullTxId, planned: planned, columns: ['i']});
    applyPlainTextFormat(customer, [rowWrite.rowNumber]);
    writeTransactionRows(customer, [rowWrite], leaseId, tx.fileId);
    var verified = verifyWrittenValues(customer, [rowWrite]);
    if (!verified[0] || !verified[0].ok) {
      throw new IntegrityError('DESTINATION_VALUE_MISMATCH',
        'The purpose could not be written for ' + tx.fullTxId);
    }
    updateWrittenValues(tx.fullTxId, planned, verified[0].values);
  } finally {
    releaseLease(tx.fileId, input.runId || null, 'PURPOSE_DONE');
  }
  return moveFile_(review, 'UPDATE_PURPOSE', actor, input, FILE_STATE.EXCLUDED);
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

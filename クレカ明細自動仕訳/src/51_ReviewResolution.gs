'use strict';

/**
 * 4.26 解決操作（取引単位）。
 *
 * **どの操作も無条件に`COMMITTED`にしない。** 自らの要確認を`RESOLVED`に
 * したうえで4.26.2を再評価し、3条件を満たすときにだけ確定を起動する
 * （INV-37）。個別の操作が独自に確定判断を持つと、他の未解決を無視した
 * 過剰確定が起きる ── レビューがCR-2として検出した失敗である。
 *
 * すべての取引単位種別には終端へ至る経路が必ず1つある（INV-31）。
 * 解決できない場合の逃げ道が`EXCLUDE`であり、これがないと担当者は
 * 未解決の要確認を抱えたままファイルを完了できない。
 */

/** 種別ごとに許される操作（4.26 解決操作の表）。 */
var TX_REVIEW_OPERATIONS_ = Object.freeze({
  PARTNER: ['ADOPT_EXISTING_PARTNER', 'RESOLVE_WITHOUT_PARTNER', 'EXCLUDE'],
  DATE: ['FIX_DATE_AMOUNT', 'EXCLUDE'],
  AMOUNT: ['FIX_DATE_AMOUNT', 'EXCLUDE'],
  ZERO_AMOUNT: ['POST_ZERO_AMOUNT', 'EXCLUDE'],
  PRIOR_YEAR: ['POST_PRIOR_YEAR', 'EXCLUDE_PRIOR_YEAR', 'EXCLUDE'],
  // `INTEGRITY`固有の操作は4.29（54_IntegrityResolution）が扱う。
  // ここには終端への逃げ道だけを置く（INV-31）。
  INTEGRITY: ['EXCLUDE']
});

/** 当該要確認に提示してよい操作を返す。画面はこの一覧だけを出す。 */
function availableResolveOperations(reviewType) {
  return (TX_REVIEW_OPERATIONS_[String(reviewType)] || []).slice();
}

/**
 * 取引単位の要確認を解決する。
 *
 * @param {string} reviewId
 * @param {string} operation 4.26の操作コード
 * @param {!Object} input 操作ごとの入力（採用する取引先、修正日付など）
 * @return {{reviewId, operation, committed, unmetConditions[], openReviewTypes[]}}
 */
function resolveReview(reviewId, operation, input) {
  input = input || {};
  var review = getReviewById(reviewId);
  if (!review) throw new IntegrityError(null, 'Review not found: ' + reviewId);
  if (review.status !== 'OPEN' && review.status !== 'IN_PROGRESS') {
    throw new StateTransitionError(
      'Review is already settled: ' + reviewId + ' (' + review.status + ')');
  }
  var allowed = availableResolveOperations(review.reviewType);
  if (allowed.indexOf(String(operation)) < 0) {
    throw new StateTransitionError(
      'Operation ' + operation + ' is not offered for ' + review.reviewType);
  }
  var actor = input.actor || activeUserEmail_();
  var fullTxId = review.fullTxId;

  switch (String(operation)) {
    case 'ADOPT_EXISTING_PARTNER':
      return adoptExistingPartner_(review, input, actor);
    case 'RESOLVE_WITHOUT_PARTNER':
      updatePartnerResolution(fullTxId, PARTNER_STATUS.RESOLVED_WITHOUT_PARTNER);
      return settle_(review, operation, actor);
    case 'FIX_DATE_AMOUNT':
      return fixDateAmount_(review, input, actor);
    case 'POST_ZERO_AMOUNT':
    case 'POST_PRIOR_YEAR':
      // 値は初回転記で正しく入っている。計上するという判断だけが結論であり、
      // 転記行・B列予定値・金額を変更しない。
      return settle_(review, operation, actor);
    case 'EXCLUDE_PRIOR_YEAR':
    case 'EXCLUDE':
      return excludeTransaction_(review, operation, actor, input);
    default:
      throw new StateTransitionError('Unsupported operation: ' + operation);
  }
}

function adoptExistingPartner_(review, input, actor) {
  if (!input.partnerName) {
    throw new TypeError('ADOPT_EXISTING_PARTNER requires a partner name');
  }
  var customer = getCustomerById(review.customerId);
  var leaseId = acquireLease(review.customerId, review.fileId, input.runId || null,
    actor, LEASE_PURPOSE.WRITE_ONLY);
  try {
    var tx = getTransaction(review.fullTxId);
    var planned = Object.assign({}, tx.planned, {f: String(input.partnerName)});
    var rowWrite = buildRowWrite(Number(tx.destinationRow), {
      fullTxId: tx.fullTxId, planned: planned, columns: ['f']
    });
    applyPlainTextFormat(customer, [rowWrite.rowNumber]);
    writeTransactionRows(customer, [rowWrite], leaseId, review.fileId);

    var verified = verifyWrittenValues(customer, [rowWrite]);
    if (!verified[0] || !verified[0].ok) {
      throw new IntegrityError('DESTINATION_VALUE_MISMATCH',
        'Read-back verification failed for ' + tx.fullTxId);
    }
    // 予定値と読取確認値を同時に更新する（INV-01）。片方だけ書くと、
    // 次回の整合性チェックが手動変更として誤検知する。
    updateWrittenValues(tx.fullTxId, planned, verified[0].values);
    updatePartnerResolution(tx.fullTxId, PARTNER_STATUS.RESOLVED_WITH_PARTNER);

    if (input.learn !== false) {
      learnFromResolution(review.customerId, review.merchantOriginal,
        review.merchantNormalized, String(input.partnerName), actor);
    }
    return settle_(review, 'ADOPT_EXISTING_PARTNER', actor,
      {adoptedPartner: String(input.partnerName)});
  } finally {
    releaseLease(review.fileId, input.runId || null, 'RESOLVE_DONE');
  }
}

function fixDateAmount_(review, input, actor) {
  // `DATE`種別は修正日付なしに確定できない。担当者が入力した日付が、
  // B列へ初めて書かれる値である（初回転記ではINV-33により空欄）。
  if (review.reviewType === REVIEW_TYPE.DATE && !input.correctedDate) {
    throw new TypeError('FIX_DATE_AMOUNT on a DATE review requires a corrected date');
  }
  var customer = getCustomerById(review.customerId);
  var leaseId = acquireLease(review.customerId, review.fileId, input.runId || null,
    actor, LEASE_PURPOSE.WRITE_ONLY);
  try {
    var tx = getTransaction(review.fullTxId);
    var previousB = tx.planned && tx.planned.b;
    var planned = Object.assign({}, tx.planned);
    var columns = [];
    if (input.correctedDate !== undefined && input.correctedDate !== null) {
      planned.b = String(input.correctedDate);
      columns.push('b');
    }
    if (input.correctedAmount !== undefined && input.correctedAmount !== null) {
      planned.m = Number(input.correctedAmount);
      columns.push('m');
    }
    if (!columns.length) throw new TypeError('FIX_DATE_AMOUNT requires a date or an amount');

    var rowWrite = buildRowWrite(Number(tx.destinationRow),
      {fullTxId: tx.fullTxId, planned: planned, columns: columns});
    writeTransactionRows(customer, [rowWrite], leaseId, review.fileId);
    var verified = verifyWrittenValues(customer, [rowWrite]);
    if (!verified[0] || !verified[0].ok) {
      throw new IntegrityError('DESTINATION_VALUE_MISMATCH',
        'Read-back verification failed for ' + tx.fullTxId);
    }
    updateWrittenValues(tx.fullTxId, planned, verified[0].values);

    // S列（B列予定値）が変わったら、確定を評価する**前に**前年利用日を
    // 再判定する（INV-40）。初回転記でB列が空欄だった行には`PRIOR_YEAR`が
    // 立っていない。日付が入って初めて前年かどうかが判断できる。
    // 金額だけを直した場合は再判定しない。
    if (columns.indexOf('b') >= 0 && String(planned.b) !== String(previousB)) {
      reevaluatePriorYearForTransaction_(review, customer, planned.b, actor);
    }
    return settle_(review, 'FIX_DATE_AMOUNT', actor, {
      correctedDate: input.correctedDate, correctedAmount: input.correctedAmount
    });
  } finally {
    releaseLease(review.fileId, input.runId || null, 'RESOLVE_DONE');
  }
}

/** 4.26.3 の再判定を、シート上の要確認へ反映する。 */
function reevaluatePriorYearForTransaction_(review, customer, plannedB, actor) {
  var judgement = checkPriorYearUsage(
    [{transactionId: review.fullTxId, date: parseDate(plannedB, SYSTEM_TIMEZONE)}],
    customer, []);
  var existing = openReviews({fullTxId: review.fullTxId, reviewType: REVIEW_TYPE.PRIOR_YEAR})[0];

  // 4.26.3 手順4の分岐 (c)：既存の`PRIOR_YEAR`があり、新しい日付でも
  // 前年に該当する場合は**Z列のusageDateを更新する**。行を作り直さない。
  // この分岐が無いと、日付を2025-12-28→2024-08-15へ再訂正したときに
  // Z列が古い日付のまま残り、担当者は違う日付を根拠に判断させられる。
  if (judgement.issues.length && existing) {
    updateReviewStatus(existing.reviewId, existing.status, {
      actor: actor, operation: 'AUTO_REJUDGE',
      detail: judgement.issues[0].detail
    });
    return;
  }
  if (judgement.issues.length && !existing) {
    registerReview({
      reviewType: REVIEW_TYPE.PRIOR_YEAR, fullTxId: review.fullTxId,
      displayTxId: review.displayTxId, fileId: review.fileId,
      customerId: review.customerId, customerName: review.customerName,
      fileNameOriginal: review.fileNameOriginal, sourceRow: review.sourceRow,
      destinationSpreadsheetId: review.destinationSpreadsheetId,
      destinationSheetName: review.destinationSheetName,
      destinationRow: review.destinationRow,
      detail: judgement.issues[0].detail
    });
    return;
  }
  // 前年に該当しなくなったのに要確認を残すと、担当者が判断のしようがない
  // 要確認を抱え続ける。根拠が消えたので閉じる。
  if (!judgement.issues.length && existing) {
    updateReviewStatus(existing.reviewId, 'EXCLUDED',
      {actor: actor, operation: 'AUTO_WITHDRAW',
       excludeReason: REVIEW_EXCLUDE_REASON.PRIOR_YEAR_GROUNDS_LOST});
  }
}

/**
 * 取引を対象外にする。
 *
 * 比較更新の遷移元は現在の状態とし、`REVIEW_REQUIRED`と`COMMITTED`の双方を
 * 許す。既に転記済みの取引を後から対象外にする場面が実際にあるためである。
 */
function excludeTransaction_(review, operation, actor, input) {
  var tx = getTransaction(review.fullTxId);
  var from = tx.transactionStatus;
  if (from !== TX_STATUS.REVIEW_REQUIRED && from !== TX_STATUS.COMMITTED) {
    throw new StateTransitionError(
      'Exclusion is not offered while the transaction is ' + from);
  }
  // freee取込済みの取引は、取消し（4.29）と同じ管理者判断を要する（仕様17.3）。
  // シートの行だけ消すと、freee側に仕訳が残ったまま突合が永久に合わなくなる。
  // このガードを迂回できる経路を1つでも残すと、53のガードは飾りになる。
  if ((tx.freeeStatus === FREEE_IMPORT_STATUS.IMPORTED ||
       tx.freeeStatus === FREEE_IMPORT_STATUS.NEEDS_FREEE_FIX) && !input.allowImported) {
    throw new StateTransitionError(
      'freee-imported transactions require an administrator decision: ' + review.fullTxId);
  }
  var customer = getCustomerById(review.customerId);
  var leaseId = acquireLease(review.customerId, review.fileId, input.runId || null,
    actor, LEASE_PURPOSE.WRITE_ONLY);
  try {
    if (tx.destinationRow) {
      clearTransactionRows(customer, [Number(tx.destinationRow)], leaseId, review.fileId);
    }
    updateTransactionStatus(review.fullTxId, from, TX_STATUS.CANCELED);
  } finally {
    releaseLease(review.fileId, input.runId || null, 'RESOLVE_DONE');
  }

  var reason = REVIEW_EXCLUDE_REASON.REVIEWER_JUDGEMENT;
  // Z列（検出詳細）は**上書きせず追記マージ**する。元の検出詳細を消すと、
  // なぜ要確認が立ったのかを後から追えない。
  var mergedDetail = Object.assign({}, review.detail ? jsonCell_(review.detail, {}) : {},
    {previousStatus: from});
  updateReviewStatus(review.reviewId, 'EXCLUDED', {
    actor: actor, operation: operation, role: input.role || null,
    excludeReason: reason, detail: mergedDetail
  });
  appendAudit({
    type: 'REVIEW_RESOLVE', actor: actor, targetType: 'TRANSACTION',
    targetId: review.fullTxId, before: {transactionStatus: from},
    after: {transactionStatus: TX_STATUS.CANCELED, excludeReason: reason}
  });
  // `CANCELED`は終端である。確定条件を評価しない。
  return {
    reviewId: review.reviewId, operation: operation, committed: false,
    unmetConditions: [], openReviewTypes: [], transactionStatus: TX_STATUS.CANCELED
  };
}

/**
 * 要確認を`RESOLVED`にし、確定条件を**必ず**再評価する（INV-37）。
 *
 * 解決操作が自前で`COMMITTED`を起動してはならない。他の未解決が残っていても
 * 確定してしまう。
 */
function settle_(review, operation, actor, context) {
  updateReviewStatus(review.reviewId, 'RESOLVED',
    Object.assign({actor: actor, operation: operation}, context || {}));
  appendAudit({
    type: 'REVIEW_RESOLVE', actor: actor, targetType: 'TRANSACTION',
    targetId: review.fullTxId, after: {operation: operation}
  });
  var outcome = commitIfConditionsMet(review.fullTxId);
  return Object.assign({reviewId: review.reviewId, operation: operation}, outcome);
}

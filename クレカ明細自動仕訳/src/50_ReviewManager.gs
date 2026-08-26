'use strict';

/** @param {*} value @return {*} */
function cloneReviewState_(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 4.26.2のうちR1〜R5で必要な3条件を評価する。 */
function canCommitReviewedTransaction_(transaction, reviews) {
  var unresolved = reviews.some(function(review) {
    return review.status === 'OPEN' || review.status === 'IN_PROGRESS';
  });
  return !unresolved && transaction.plannedDate !== null && transaction.plannedDate !== '' &&
    transaction.partnerResolutionStatus !== PARTNER_STATUS.UNRESOLVED;
}

/**
 * §4.26.3 / §5.15。FIX_DATE_AMOUNT後のPRIOR_YEAR再判定を純粋状態変換する。
 * @param {!Object} state
 * @param {string} correctedDate
 * @return {!Object}
 */
function rejudgePriorYearUsage(state, correctedDate) {
  if (!state || !state.customer || !state.transaction || !Array.isArray(state.reviews)) {
    throw new TypeError('rejudgePriorYearUsage requires an in-memory review state');
  }
  // 呼出元の検証をフェーズ1bの純粋関数でも再現する。失敗時は入力を変更しない。
  var parsedDate = parseDate(correctedDate, SYSTEM_TIMEZONE);
  var probe = {
    transactionId: state.transaction.transactionId,
    date: parsedDate
  };
  var judgement = checkPriorYearUsage([probe], state.customer, []);

  var result = cloneReviewState_(state);
  result.transaction.plannedDate = toTokyoDateString_(parsedDate);
  var sourceReview = result.reviews.filter(function(review) {
    return review.reviewId === result.sourceReviewId;
  })[0];
  if (!sourceReview) throw new IntegrityError('Source review row was not found');
  sourceReview.status = 'RESOLVED';

  var prior = result.reviews.filter(function(review) {
    return review.reviewType === REVIEW_TYPE.PRIOR_YEAR &&
      (review.status === 'OPEN' || review.status === 'IN_PROGRESS');
  })[0];
  var applies = judgement.issues.length > 0;
  var newUsageDate = result.transaction.plannedDate;
  result.audit = null;

  if (applies && !prior) {
    var detail = judgement.issues[0].detail;
    result.reviews.push({
      reviewId: 'PRIOR_YEAR:' + result.transaction.transactionId,
      reviewType: REVIEW_TYPE.PRIOR_YEAR,
      status: 'OPEN',
      suppressionKey: REVIEW_TYPE.PRIOR_YEAR + ':' + result.transaction.transactionId,
      registeredAt: null,
      detail: detail
    });
    result.branch = 'REGISTER';
  } else if (!applies && prior) {
    var oldUsageDate = prior.detail && prior.detail.usageDate || null;
    prior.detail = Object.assign({}, prior.detail || {}, {
      usageDate: newUsageDate,
      fiscalYear: result.customer.fiscalYear
    });
    prior.status = 'EXCLUDED';
    prior.excludeReason = REVIEW_EXCLUDE_REASON.PRIOR_YEAR_GROUNDS_LOST;
    result.audit = {
      event: 'REVIEW_RESOLVE',
      before: {'Z.usageDate': oldUsageDate},
      after: {'Z.usageDate': newUsageDate}
    };
    result.branch = 'EXCLUDE';
  } else if (applies && prior) {
    prior.detail = Object.assign({}, prior.detail || {}, judgement.issues[0].detail);
    result.branch = 'UPDATE';
  } else {
    result.branch = 'KEEP';
  }

  if (canCommitReviewedTransaction_(result.transaction, result.reviews)) {
    result.transaction.transactionStatus = TX_STATUS.COMMITTED;
  }
  return result;
}

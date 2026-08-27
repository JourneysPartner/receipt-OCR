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

/**
 * 5.15 再判定ベクトル R1〜R5（`runPriorYearRejudgementVectors`）。
 *
 * `runPriorYearVectors`は5.12の判定を単独で呼ぶだけで、**4.26.3を1度も
 * 通らない**。「日付を確定した後に登録されること」は判定関数の性質ではなく
 * **呼ぶ契機と結果の割当てが正しいこと**の性質であり、判定関数だけを呼ぶ
 * ベクトルでは決して検証できない。だからこの5件が別に存在する。
 *
 * 本モジュールに置くのは12章の依存順序による（`99_Test`へ置くと循環）。
 * 10.3のリリース手順では`runPriorYearVectors`と並列の必須ゲートである。
 *
 * **本番の要確認シート・取引ログ・転記先を1セルも変更しない** ──
 * 状態はすべてメモリ上に構築する。
 */
var PRIOR_YEAR_REJUDGEMENT_VECTORS_ = Object.freeze([
  {
    id: 'R1', correctedDate: '2025-12-28',
    state: {source: 'DATE', plannedDate: '', priorYear: null},
    expected: {branch: 'REGISTER', priorYearStatus: 'OPEN',
               transactionStatus: 'REVIEW_REQUIRED'}
  },
  {
    id: 'R2', correctedDate: '2026-01-05',
    state: {source: 'DATE', plannedDate: '', priorYear: null},
    expected: {branch: 'KEEP', priorYearStatus: null,
               transactionStatus: 'COMMITTED'}
  },
  {
    // 再判定契機を「空欄→非空」に限る実装を直接検出する（Ver.2.5・指摘1）。
    // S列は非空から別の非空へ変わる。
    id: 'R3', correctedDate: '2025-12-20',
    state: {source: 'AMOUNT', plannedDate: '2026-01-05', priorYear: null},
    expected: {branch: 'REGISTER', priorYearStatus: 'OPEN',
               transactionStatus: 'REVIEW_REQUIRED'}
  },
  {
    id: 'R4', correctedDate: '2026-01-05',
    state: {source: 'AMOUNT', plannedDate: '2025-12-28',
            priorYear: {usageDate: '2025-12-28'}},
    expected: {branch: 'EXCLUDE', priorYearStatus: 'EXCLUDED',
               excludeReason: 'PRIOR_YEAR_GROUNDS_LOST',
               transactionStatus: 'COMMITTED',
               auditBefore: '2025-12-28', auditAfter: '2026-01-05'}
  },
  {
    id: 'R5', correctedDate: '2024-08-15',
    state: {source: 'AMOUNT', plannedDate: '2025-12-28',
            priorYear: {usageDate: '2024-08-15前の値', usageDateBefore: '2025-12-28'}},
    expected: {branch: 'UPDATE', priorYearStatus: 'OPEN',
               updatedUsageDate: '2024-08-15',
               transactionStatus: 'REVIEW_REQUIRED', sameReviewRow: true}
  }
]);

function rejudgementState_(spec) {
  var reviews = [{
    reviewId: 'RV_SOURCE', reviewType: REVIEW_TYPE[spec.source],
    status: 'OPEN',
    suppressionKey: REVIEW_TYPE[spec.source] + ':TX_R'
  }];
  if (spec.priorYear) {
    reviews.push({
      reviewId: 'RV_PRIOR', reviewType: REVIEW_TYPE.PRIOR_YEAR,
      status: 'OPEN',
      suppressionKey: REVIEW_TYPE.PRIOR_YEAR + ':TX_R',
      registeredAt: '2026-01-10T00:00:00+09:00',
      detail: {kind: 'PRIOR_YEAR', customerCategory: 'INDIVIDUAL',
        fiscalYear: 2026, thresholdYear: 2025,
        usageDate: spec.priorYear.usageDateBefore || spec.priorYear.usageDate}
    });
  }
  return {
    customer: {customerId: 'CFIX_I26', customerCategory: CUSTOMER_CATEGORY.INDIVIDUAL,
               fiscalYear: 2026},
    transaction: {transactionId: 'TX_R', plannedDate: spec.plannedDate,
      transactionStatus: TX_STATUS.REVIEW_REQUIRED,
      partnerResolutionStatus: PARTNER_STATUS.RESOLVED_WITH_PARTNER},
    reviews: reviews,
    sourceReviewId: 'RV_SOURCE'
  };
}

function runPriorYearRejudgementVectors() {
  var results = [];
  var coveredBranches = [];

  PRIOR_YEAR_REJUDGEMENT_VECTORS_.forEach(function(vector) {
    try {
      var outcome = rejudgePriorYearUsage(rejudgementState_(vector.state),
        vector.correctedDate);
      if (coveredBranches.indexOf(outcome.branch) < 0) coveredBranches.push(outcome.branch);

      var prior = outcome.reviews.filter(function(review) {
        return review.reviewType === REVIEW_TYPE.PRIOR_YEAR;
      })[0] || null;
      var expected = vector.expected;
      var problems = [];

      if (outcome.branch !== expected.branch) {
        problems.push('branch=' + outcome.branch);
      }
      var priorStatus = prior ? prior.status : null;
      if (priorStatus !== expected.priorYearStatus) {
        problems.push('priorYearStatus=' + priorStatus);
      }
      // 登録・取下げ・更新の別だけでなく、その後の取引状態も照合する
      // （5.15 受入条件5）。
      if (outcome.transaction.transactionStatus !== expected.transactionStatus) {
        problems.push('transactionStatus=' + outcome.transaction.transactionStatus);
      }
      if (expected.excludeReason &&
          (!prior || prior.excludeReason !== expected.excludeReason)) {
        problems.push('excludeReason=' + (prior && prior.excludeReason));
      }
      if (expected.auditBefore && (!outcome.audit ||
          outcome.audit.before['Z.usageDate'] !== expected.auditBefore ||
          outcome.audit.after['Z.usageDate'] !== expected.auditAfter)) {
        problems.push('audit=' + JSON.stringify(outcome.audit));
      }
      if (expected.updatedUsageDate &&
          (!prior || !prior.detail || prior.detail.usageDate !== expected.updatedUsageDate)) {
        problems.push('usageDate=' + (prior && prior.detail && prior.detail.usageDate));
      }
      // R5：行を作り直さない。要確認ID・抑止キー・登録日時が保たれること。
      if (expected.sameReviewRow && (!prior || prior.reviewId !== 'RV_PRIOR' ||
          prior.registeredAt !== '2026-01-10T00:00:00+09:00')) {
        problems.push('reviewRowReplaced');
      }

      results.push({id: vector.id, ok: problems.length === 0,
        branch: outcome.branch, problems: problems});
    } catch (error) {
      results.push({id: vector.id, ok: false, branch: null,
        problems: [String(error && error.message)]});
    }
  });

  // 4.26.3 手順4の4分岐がすべて1回以上実行されること（受入条件6）。
  // **分岐の網羅は本番関数の責務であり、テスト側で集計しない** ──
  // テスト側で数えても、本番にその関門は存在しないことになる。
  var allBranches = ['REGISTER', 'EXCLUDE', 'UPDATE', 'KEEP'];
  var missing = allBranches.filter(function(branch) {
    return coveredBranches.indexOf(branch) < 0;
  });

  return {
    ok: results.every(function(r) { return r.ok; }) && missing.length === 0,
    results: results,
    coveredBranches: coveredBranches,
    missingBranches: missing
  };
}

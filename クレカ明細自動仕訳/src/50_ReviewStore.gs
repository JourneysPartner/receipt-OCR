'use strict';

/**
 * 要確認シート（2.1.7）のアクセス層。
 *
 * 抑止キーの決め方（INV-16）がこの層の要点である。取引単位種別を
 * ファイル単位のキーで抑止すると、1ファイル内の2件目以降が登録されず、
 * 未解決のままfreee取込へ進む。
 */

var REVIEW_SHEET_WIDTH_ = 31;   // A〜AE

function reviewSheet_() {
  return requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.REVIEW);
}

/** 取引単位種別か。抑止キーの形を決める（INV-16・2.1.7）。 */
function isTransactionScopedReviewType(reviewType) {
  return TX_SCOPED_REVIEW_TYPES.indexOf(String(reviewType)) >= 0;
}

/**
 * 抑止キーを作る（INV-16）。
 * 取引単位は「種別＋取引ID完全値」、ファイル単位は「種別＋ファイルID」。
 *
 * 宛先はキー付きで受け取る。位置引数だと`fileId`と`fullTxId`を取り違えても
 * 例外が出ず、**取引単位のキーがファイルIDになって静かに壊れる** ── 1ファイル
 * 30件の取引先未解決が1件しか登録されず、残り29件が未解決のまま
 * freee取込へ進む。順序を間違えようのない形にしてその余地を消す。
 *
 * @param {string} reviewType
 * @param {{fileId: (string|null), fullTxId: (string|null), scope: (string|undefined)}} target
 *   `scope`に`'FILE'`を与えると、取引単位種別でもファイル単位のキーを作る
 *   （4.24 検査8のようにファイル全体を対象とする起票のため）。
 */
function buildSuppressionKey(reviewType, target) {
  var type = String(reviewType);
  if (!target || typeof target !== 'object') {
    throw new TypeError('buildSuppressionKey requires a target object, not positional ids');
  }
  var fileScoped = String(target.scope || '') === 'FILE' || !isTransactionScopedReviewType(type);
  if (fileScoped) {
    if (!target.fileId) {
      throw new TypeError('file-scoped review requires a file id: ' + type);
    }
    return type + ':' + String(target.fileId);
  }
  if (!target.fullTxId) {
    throw new TypeError('transaction-scoped review requires a full transaction id: ' + type);
  }
  return type + ':' + String(target.fullTxId);
}

function reviewFromRecord_(record) {
  var v = record.values;
  return {
    reviewId: String(v[0]), status: String(v[1]), reviewType: String(v[2]),
    suppressionKey: String(v[3]), fullTxId: v[4] || null, displayTxId: v[5] || null,
    customerId: v[6] || null, customerName: v[7] || null,
    fileId: v[8] || null, fileNameOriginal: v[9] || null,
    sourceSheetName: v[10] || null, sourceRow: v[11] || null,
    destinationSpreadsheetId: v[12] || null, destinationSheetName: v[13] || null,
    merchantOriginal: v[14] || null, merchantNormalized: v[15] || null,
    candidates: v[16] || null, adoptedPartner: v[17] || null,
    originalDate: v[18] || null, originalAmount: v[19] || null, originalPurpose: v[20] || null,
    correctedDate: v[21] || null, correctedAmount: v[22] || null, correctedPurpose: v[23] || null,
    destinationRow: v[24] || null, detail: v[25] || null,
    registeredAt: v[26] || null, reviewerEmail: v[27] || null, reviewedAt: v[28] || null,
    resolveOperation: v[29] || null, resolverRole: v[30] || null,
    _rowNumber: record.rowNumber
  };
}

function allReviewRecords_() {
  return readSheetRows_(reviewSheet_(), REVIEW_SHEET_WIDTH_).map(reviewFromRecord_);
}

/** 未解決（OPEN／IN_PROGRESS）の要確認だけを返す。 */
function openReviews(filter) {
  filter = filter || {};
  return allReviewRecords_().filter(function(review) {
    if (review.status !== 'OPEN' && review.status !== 'IN_PROGRESS') return false;
    if (filter.fileId && review.fileId !== String(filter.fileId)) return false;
    if (filter.fullTxId && review.fullTxId !== String(filter.fullTxId)) return false;
    if (filter.reviewType && review.reviewType !== String(filter.reviewType)) return false;
    return true;
  });
}

/** 当該取引に未解決の要確認が残っているか（4.26.2 条件1）。 */
function hasOpenTransactionReview(fullTxId) {
  return openReviews({fullTxId: fullTxId}).length > 0;
}

/**
 * 要確認を登録する。
 *
 * 同じ抑止キーの`OPEN`／`IN_PROGRESS`が既にある場合だけ登録を抑止する。
 * 取引単位種別は取引IDを含むキーなので、同一ファイル内の別取引は
 * それぞれ登録される（INV-16）。
 */
/**
 * Z列（検出詳細）の`kind`ごとの必須キー（2.1.7.1）。
 *
 * 解決操作はここから判断材料を読む。キー名が違っても JSON なので例外は
 * 出ず、`undefined`のまま処理が進む。登録の入口で弾くのが、黙って壊れるのを
 * 防ぐ唯一の手段である。
 */
var REVIEW_DETAIL_REQUIRED_KEYS_ = Object.freeze({
  FILE_CHANGED: ['oldRevision', 'newRevision', 'oldBinaryHash', 'newBinaryHash', 'hashVersion'],
  DATE_INFERENCE: ['status', 'baseYearMonth', 'candidates', 'lookbackMonths', 'forwardMonths'],
  PRIOR_YEAR: ['customerCategory', 'fiscalYear', 'thresholdYear', 'usageDate']
});

function assertReviewDetailShape_(detail) {
  if (!detail || !detail.kind) return;
  var required = REVIEW_DETAIL_REQUIRED_KEYS_[String(detail.kind)];
  if (!required) return;
  var missing = required.filter(function(key) { return detail[key] === undefined; });
  if (missing.length) {
    throw new TypeError('Review detail of kind ' + detail.kind +
      ' is missing required keys: ' + missing.join(', '));
  }
}

function registerReview(entry) {
  if (!entry || !entry.reviewType) throw new TypeError('registerReview requires a reviewType');
  assertReviewDetailShape_(entry.detail);
  var key = buildSuppressionKey(entry.reviewType, {
    fileId: entry.fileId, fullTxId: entry.fullTxId, scope: entry.suppressionScope
  });
  return withScriptLock_(function() {
    var duplicate = allReviewRecords_().filter(function(review) {
      return review.suppressionKey === key &&
        (review.status === 'OPEN' || review.status === 'IN_PROGRESS');
    })[0];
    if (duplicate) return {registered: false, reviewId: duplicate.reviewId, suppressionKey: key};

    var reviewId = generateId('RV');
    var row = new Array(REVIEW_SHEET_WIDTH_).fill('');
    row[0] = reviewId;
    row[1] = 'OPEN';
    row[2] = String(entry.reviewType);
    row[3] = key;
    row[4] = entry.fullTxId || '';
    row[5] = entry.displayTxId || '';
    row[6] = entry.customerId || '';
    row[7] = entry.customerName || '';
    row[8] = entry.fileId || '';
    row[9] = entry.fileNameOriginal || '';
    row[10] = entry.sourceSheetName || '';
    row[11] = entry.sourceRow === undefined || entry.sourceRow === null ? '' : entry.sourceRow;
    row[12] = entry.destinationSpreadsheetId || '';
    row[13] = entry.destinationSheetName || '';
    row[14] = entry.merchantOriginal || '';
    row[15] = entry.merchantNormalized || '';
    row[16] = entry.candidates === undefined || entry.candidates === null ? '' : JSON.stringify(entry.candidates);
    row[18] = entry.originalDate || '';
    row[19] = entry.originalAmount === undefined || entry.originalAmount === null ? '' : entry.originalAmount;
    row[20] = entry.originalPurpose || '';
    row[24] = entry.destinationRow === undefined || entry.destinationRow === null ? '' : entry.destinationRow;
    row[25] = entry.detail === undefined || entry.detail === null ? '' : JSON.stringify(entry.detail);
    row[26] = nowIso_();
    reviewSheet_().appendRow(row);
    return {registered: true, reviewId: reviewId, suppressionKey: key};
  });
}

/** 要確認のステータスを更新する。解決者・操作・役割を必ず記録する。 */
function updateReviewStatus(reviewId, status, context) {
  context = context || {};
  return withScriptLock_(function() {
    var review = allReviewRecords_().filter(function(item) {
      return item.reviewId === String(reviewId);
    })[0];
    if (!review) throw new IntegrityError(null, 'Review not found: ' + reviewId);
    var sheet = reviewSheet_();
    sheet.getRange(review._rowNumber, 2).setValue(String(status));
    sheet.getRange(review._rowNumber, 28).setValue(context.actor || activeUserEmail_());
    sheet.getRange(review._rowNumber, 29).setValue(nowIso_());
    if (context.operation) sheet.getRange(review._rowNumber, 30).setValue(String(context.operation));
    if (context.role) sheet.getRange(review._rowNumber, 31).setValue(String(context.role));
    if (context.adoptedPartner !== undefined) {
      sheet.getRange(review._rowNumber, 18).setValue(context.adoptedPartner);
    }
    if (context.correctedDate !== undefined) {
      sheet.getRange(review._rowNumber, 22).setValue(context.correctedDate);
    }
    if (context.correctedAmount !== undefined) {
      sheet.getRange(review._rowNumber, 23).setValue(context.correctedAmount);
    }
    if (context.detail !== undefined) {
      sheet.getRange(review._rowNumber, 26).setValue(context.detail === null ? '' : JSON.stringify(context.detail));
    }
    return {reviewId: String(reviewId), status: String(status)};
  });
}

/**
 * 6.1 step 9-8：判定結果をまとめて要確認へ登録する。
 *
 * **登録はこのステップだけで行う**（A-23）。事前検証ブロック（8-10等）で登録すると、
 * 区分1・区分2で落ちたファイルに、取引ログを持たない孤児の要確認が残る。
 *
 * 取引単位の種別は、当該取引の`transactionStatus`が`PREPARED`／`WRITING`／
 * `REVIEW_REQUIRED`のいずれかである場合に限って登録する（Ver.2.5・指摘4）。
 * `COMMITTED`／`CANCELED`／`DELETED_ACCEPTED`へ登録すると、再合流のたびに
 * 決着済みの取引へ要確認が立て直され、4.28の停止条件で取込が止まる。
 *
 * ファイル単位の種別は取引状態による絞込を行わない。
 */
function registerPendingReviews(entries) {
  if (!Array.isArray(entries)) throw new TypeError('registerPendingReviews requires an array');
  var registerable = [TX_STATUS.PREPARED, TX_STATUS.WRITING, TX_STATUS.REVIEW_REQUIRED];
  var results = {registered: [], skipped: []};

  entries.forEach(function(entry) {
    if (isTransactionScopedReviewType(entry.reviewType)) {
      var tx = entry.fullTxId ? getTransaction(entry.fullTxId) : null;
      if (!tx || registerable.indexOf(tx.transactionStatus) < 0) {
        results.skipped.push({
          reviewType: entry.reviewType, fullTxId: entry.fullTxId,
          reason: tx ? 'TRANSACTION_ALREADY_SETTLED' : 'TRANSACTION_NOT_FOUND',
          transactionStatus: tx ? tx.transactionStatus : null
        });
        return;
      }
    }
    var outcome = registerReview(entry);
    if (outcome.registered) results.registered.push(outcome);
    else results.skipped.push({
      reviewType: entry.reviewType, fullTxId: entry.fullTxId,
      reason: 'SUPPRESSED', reviewId: outcome.reviewId
    });
  });

  return results;
}

/**
 * 4.26.2 取引の確定条件（INV-37）。
 *
 * `REVIEW_REQUIRED → COMMITTED` を起動できるのは3条件をすべて満たすときに限る。
 * 個々の解決操作が無条件に`COMMITTED`にしてはならない。解決操作は自らの
 * 要確認を解決したうえで**必ず本規則を再評価**する。
 */
/**
 * 4.26.2 の3条件を評価する**唯一の**判定器。
 *
 * 初回転記（6.1 step 9-7）と要確認の解決（4.26.2）は同じ規則で判定される。
 * それぞれが自前で条件を書くと、片方だけ直す事故が必ず起きる。呼出側は
 * 「未解決の要確認が残っているか」の求め方だけが異なる ── 転記前は
 * これから登録する予定の要確認、転記後は要確認シートの`OPEN`行である。
 */
function commitBlockingReasons_(context) {
  var reasons = [];
  if (context.hasOpenReview) reasons.push('OPEN_REVIEW_REMAINS');
  var plannedB = context.plannedB;
  if (plannedB === null || plannedB === undefined || plannedB === '') reasons.push('PLANNED_B_EMPTY');
  if (context.partnerResolutionStatus === PARTNER_STATUS.UNRESOLVED) reasons.push('PARTNER_UNRESOLVED');
  return reasons;
}

/**
 * 転記前の取引に対する予定最終状態（K列）を決める（6.1 step 9-7）。
 *
 * 既定を`COMMITTED`にしてはならない。日付が確定しなかった取引も、
 * 取引先が判定できなかった取引も、要確認を残したまま確定してしまう。
 */
function derivePlannedFinalStatus(context) {
  return commitBlockingReasons_(context).length
    ? TX_STATUS.REVIEW_REQUIRED : TX_STATUS.COMMITTED;
}

/**
 * 取引を確定できるか（4.26.2・INV-37）。
 *
 * 偽のときは**残っている要確認の種別**も返す。担当者の画面が
 * 「あと何を解決すれば確定するか」を出せなければ、確定できない取引が
 * 理由の分からないまま滞留する。
 *
 * @return {{ok: boolean, unmetConditions: !Array<string>,
 *           openReviewTypes: !Array<string>, transactionStatus: string}}
 */
function isTransactionCommittable(fullTxId) {
  var tx = getTransaction(fullTxId);
  if (!tx) throw new IntegrityError(null, 'Transaction not found: ' + fullTxId);
  var openTypes = openReviews({fullTxId: fullTxId}).map(function(review) {
    return review.reviewType;
  });
  var reasons = commitBlockingReasons_({
    hasOpenReview: openTypes.length > 0,
    plannedB: tx.planned && tx.planned.b,
    partnerResolutionStatus: tx.partnerResolutionStatus
  });
  return {
    ok: reasons.length === 0,
    unmetConditions: reasons,
    openReviewTypes: openTypes,
    transactionStatus: tx.transactionStatus
  };
}

/**
 * 確定条件を評価し、満たす場合にだけ`REVIEW_REQUIRED → COMMITTED`を起動する。
 * 満たさない場合は状態を変えずに理由を返す。
 */
/**
 * ファイルが完了したか（INV-17・CR-I・M20）。
 *
 * **要確認の件数で判定しない。** 件数で見ると、取引と無関係なファイル単位の
 * 要確認が1件残っているだけでファイルが完了できなくなる。判定するのは
 * 取引の状態である。
 *
 * 条件2を`COMMITTED`に限定するのがCR-Iの修正である。解決操作`EXCLUDE`と
 * `ACCEPT_DELETION`は取引先解決状態を変えないため、取引先不明の1件を
 * 「対象外」で解決すると`CANCELED`かつ`UNRESOLVED`になる。全取引に条件2を
 * 課すと、その1件のせいでファイルが永久に`REVIEW_WAIT`から抜けられず、
 * 担当者に回復手段がなくなる。
 *
 * 条件3がM20の修正である。区分2で停止したファイルは取引ログに1行も
 * 登録されない。条件1・2は空集合に対して真になるので、**1行も転記して
 * いないファイルが【済】になる。**
 */
function isFileFullyResolved(fileId) {
  var terminal = [TX_STATUS.COMMITTED, TX_STATUS.CANCELED, TX_STATUS.DELETED_ACCEPTED];
  var settled = getTransactionsByStatus(fileId, terminal);
  var outstanding = getTransactionsByStatus(fileId,
    [TX_STATUS.PREPARED, TX_STATUS.WRITING, TX_STATUS.REVIEW_REQUIRED]);

  // 条件1：終端に至っていない取引が1件でもあれば偽。
  if (outstanding.length) return false;

  // 条件3：取引が0件なら、0件であることを人が確認した場合に限り真。
  if (!settled.length) {
    var record = getProcessLogRecord_(fileId);
    if (!record) return false;
    return toBool(record.values[PROCESS_FIELD_COLUMNS_.emptyFileConfirmed - 1]);
  }

  // 条件2：`COMMITTED`の取引に限り、取引先が未解決であってはならない。
  return settled.every(function(tx) {
    return tx.transactionStatus !== TX_STATUS.COMMITTED ||
      tx.partnerResolutionStatus !== PARTNER_STATUS.UNRESOLVED;
  });
}

function commitIfConditionsMet(fullTxId) {
  var evaluation = isTransactionCommittable(fullTxId);
  if (!evaluation.ok) return Object.assign({committed: false}, evaluation);
  if (evaluation.transactionStatus !== TX_STATUS.REVIEW_REQUIRED) {
    return Object.assign({}, evaluation,
      {committed: false, unmetConditions: ['NOT_REVIEW_REQUIRED']});
  }
  updateTransactionStatus(fullTxId, TX_STATUS.REVIEW_REQUIRED, TX_STATUS.COMMITTED);
  return {committed: true, unmetConditions: [], openReviewTypes: [],
          transactionStatus: TX_STATUS.COMMITTED};
}

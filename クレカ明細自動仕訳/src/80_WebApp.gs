/**
 * Web アプリから呼ぶ関数だけは Apps Script の制約により末尾に `_` を付けない。
 *
 * 次の 2 値は 2026-09-16 の実機受入 12 で測り直した（§13）。
 * `webAppResolveReviews` を 1 件で呼び、13.787 秒 ÷ 108 往復 ＝ **128 ms**。
 * 一覧側の最悪も 223 ms（15.136 秒 ÷ 68 往復）で、worst に 400 ms を採ると
 * 実測の約 3 倍の余裕がある。上限 8 件は 8×74＋36＝628 往復で、worst を
 * 踏んでも 251 秒 ── 締切ゲート（245.6 秒で停止）のほうが先に効く。
 * - WEBAPP_MAX_PER_CALL_  1 → 8
 * - WEBAPP_TRIP_WORST_MS_ 1600 → 400
 *
 * 次の 1 値はまだ実機で測れていない（受入 11。取込が 6 分に当たって
 * 完走しなかった ── K-W11）。
 * - WEBAPP_IMPORT_BASE_TRIPS_
 */
var WEBAPP_MAX_DECISIONS_ = 15;
var WEBAPP_MAX_PER_CALL_ = 8;
var WEBAPP_ITEM_TRIPS_ = 74;
var WEBAPP_CLEANUP_TRIPS_ = 62;
var WEBAPP_REVIEW_LIST_LIMIT_ = 15;
var WEBAPP_IMPORT_BASE_TRIPS_ = 164;
var WEBAPP_IMPORT_TRIPS_PER_REVIEW_ = 7;
var WEBAPP_CLONE_TRIPS_ = 3;
var WEBAPP_TRIP_WORST_MS_ = 400;
var WEBAPP_DEADLINE_MS_ = 300000;
var WEBAPP_FORMAT_FILE_WORST_MS_ = 20000;
var WEBAPP_FORMAT_SIBLING_LIMIT_ = 6;
var WEBAPP_FORMAT_REQUEUE_LIMIT_ = 6;
var WEBAPP_FORMAT_PREVIEW_ROWS_ = 50;
var WEBAPP_FORMAT_GRID_ROWS_ = 30;
var WEBAPP_FORMAT_GRID_COLUMNS_ = 26;
function webAppFormatNowMs_() { return Date.now(); }

function webAppFormatContext_(customerId, folderId, fileId, operation) {
  var scope = authorize(ROLE.SYSTEM_ADMIN, customerId, {operation: 'WEBAPP:' + operation});
  var customer = scope.customers[0];
  var folder = webAppDirectChildFolder_(customer, folderId);
  var files = webAppIteratorToArray_(folder.getFiles());
  var file = files.filter(function(item) {
    return String(item.getId()) === String(fileId);
  })[0];
  if (!file) throw new AuthorizationError('選択されたファイルはこのフォルダにありません。');
  var review = openReviews({fileId: String(fileId), reviewType: 'FORMAT_UNKNOWN'})
    .filter(function(item) { return String(item.customerId) === String(customerId); })[0];
  if (!review) return {ok: false, code: 'NOT_FORMAT_UNKNOWN'};
  return {ok: true, customer: customer, customerId: String(customerId), folder: folder,
    file: file, fileId: String(fileId), fileName: String(file.getName()),
    review: review, actor: scope.userEmail};
}

function webAppExplainUnknownFile(customerId, folderId, fileId, baseFormatId) {
  return webAppInvoke_(function() {
    var context = webAppFormatContext_(customerId, folderId, fileId, '形式診断');
    return context.ok ? formatExplainUnknown_(context, baseFormatId) : context;
  });
}

function webAppPreviewFormat(customerId, folderId, fileId, answers) {
  return webAppInvoke_(function() {
    var context = webAppFormatContext_(customerId, folderId, fileId, '形式試し読み');
    return context.ok ? formatPreview_(context, answers || {}).response : context;
  });
}

function webAppSaveFormat(customerId, folderId, fileId, answers, previewHash) {
  return webAppInvoke_(function() {
    var startedAt = webAppFormatNowMs_();
    var context = webAppFormatContext_(customerId, folderId, fileId, '形式保存');
    return context.ok ? formatSave_(context, answers || {}, previewHash, startedAt) : context;
  });
}

function webAppRequeueFormatFiles(customerId, folderId, fileIds) {
  return webAppInvoke_(function() {
    var startedAt = webAppFormatNowMs_();
    var scope = authorize(ROLE.SYSTEM_ADMIN, customerId, {operation: 'WEBAPP:再検査へ戻す'});
    var folder = webAppDirectChildFolder_(scope.customers[0], folderId);
    var files = webAppIteratorToArray_(folder.getFiles());
    var byId = Object.create(null);
    files.forEach(function(file) { byId[String(file.getId())] = file; });
    var ids = Array.isArray(fileIds) ? fileIds.map(String) : [];
    var selected = ids.slice(0, WEBAPP_FORMAT_REQUEUE_LIMIT_);
    var requeued = [], skipped = [], remaining = ids.slice(WEBAPP_FORMAT_REQUEUE_LIMIT_);
    var defs = formatActiveDefinitions_();
    for (var index = 0; index < selected.length; index += 1) {
      var id = selected[index];
      if (webAppFormatNowMs_() - startedAt + WEBAPP_FORMAT_FILE_WORST_MS_ >
          WEBAPP_DEADLINE_MS_) {
        remaining = selected.slice(index).concat(remaining); break;
      }
      var file = byId[id];
      try {
      var review = openReviews({fileId: id, reviewType: 'FORMAT_UNKNOWN'})
        .filter(function(item) { return String(item.customerId) === String(customerId); })[0];
      if (!file || !review) {
        skipped.push({fileId: id, code: 'NOT_FORMAT_UNKNOWN'}); continue;
      }
      var fileName = String(file.getName());
      var read = readFile(id, fileName,
        {expectedKeywords: detectionKeywordUnion_(defs)});
      var verdict = formatDetectRead_(defs, read, fileName, id);
      if (verdict.status !== 'RESOLVED') {
        skipped.push({fileId: id, code: verdict.status === 'UNKNOWN_CARD_FORMAT' ?
          'STILL_UNKNOWN' : 'AMBIGUOUS'}); continue;
      }
      resolveFileReview(review.reviewId, 'REGISTER_FORMAT',
        {role: ROLE.SYSTEM_ADMIN, actor: scope.userEmail});
      rewindFileForReimport_(id);
      appendAudit({type: 'FORMAT_REQUEUE', actor: scope.userEmail,
        targetType: 'FILE', targetId: id, customerId: String(customerId),
        before: {fileState: 'VALIDATING'},
        after: {fileState: 'DISCOVERED', formatId: verdict.formatId}, reason: 'WEBAPP'});
      requeued.push({fileId: id, fileName: fileName, formatId: verdict.formatId});
      } catch (error) {
        skipped.push({fileId: id, code: 'REQUEUE_FAILED'});
      }
    }
    return {requeued: requeued, skipped: skipped, remaining: remaining};
  });
}

function webAppReturnFileToCustomer(customerId, folderId, fileId, reason, note) {
  return webAppInvoke_(function() {
    var context = webAppFormatContext_(customerId, folderId, fileId, '要修正へ回す');
    if (!context.ok) return context;
    var allowed = ['PURPOSE_COLUMN_MISSING', 'PURPOSE_HEADER_VALUE',
      'PURPOSE_IN_ISSUER_COLUMN', 'OTHER'];
    if (allowed.indexOf(String(reason)) < 0) throw new TypeError('Invalid reason');
    var detail = String(note || '');
    if (detail.length > 200) throw new TypeError('Note exceeds 200 characters');
    resolveFileReview(context.review.reviewId, 'RETURN_TO_CUSTOMER',
      {role: ROLE.SYSTEM_ADMIN, actor: context.actor});
    recordError(context.fileId, {code: 'SOURCE_REQUIRES_CUSTOMER_FIX',
      detail: String(reason) + (detail ? ': ' + detail : '')});
    return {returned: true, fileId: context.fileId,
      nextState: 'CUSTOMER_FIX_REQUIRED'};
  });
}

function webAppWithdrawFormat(customerId, formatId) {
  return webAppInvoke_(function() {
    var scope = authorize(ROLE.SYSTEM_ADMIN, customerId, {operation: 'WEBAPP:形式取消し'});
    var rows = loadFormatDefinitions({formatId: String(formatId)});
    if (rows.length && !rows.some(function(row) {
      return row.answers && row.answers.origin === 'WEBAPP';
    })) return {withdrawn: false, code: 'NOT_WEBAPP_FORMAT'};
    if (!rows.some(function(row) { return row.enabled; }))
      return {withdrawn: false, code: 'NOT_ACTIVE'};
    disableCardFormat_(String(formatId), 'WITHDRAWN_BY_OPERATOR', scope.userEmail);
    return {withdrawn: true, formatId: String(formatId)};
  });
}

/** Web アプリの HTML を返す。 */
function doGet(e) {
  return webAppInvoke_(function() {
    return HtmlService.createTemplateFromFile('81_WebAppUi').evaluate();
  });
}

/** 顧客一覧と実行者を返す。 */
function webAppBootstrap() {
  return webAppInvoke_(function() {
    var scope = authorize(ROLE.REVIEWER, null, {operation: 'WEBAPP:一覧'});
    var importableById = Object.create(null);
    getAuthorizedCustomers(scope.userEmail).forEach(function(customer) {
      importableById[String(customer.customerId)] = true;
    });
    var customers = scope.customers.map(function(customer) {
      return {
        customerId: customer.customerId,
        customerName: customer.customerName,
        customerCategory: customer.customerCategory,
        canImport: Boolean(importableById[String(customer.customerId)])
      };
    });
    customers.sort(function(a, b) {
      if (a.customerName !== b.customerName) return a.customerName < b.customerName ? -1 : 1;
      return a.customerId < b.customerId ? -1 : (a.customerId > b.customerId ? 1 : 0);
    });
    return {
      actor: scope.userEmail,
      isOwner: scope.isOwner,
      customers: customers,
      version: VERSIONS.CODE
    };
  });
}

/** 顧客直下のカードフォルダ、または選択したカードフォルダのファイルを返す。 */
function webAppListFolder(customerId, folderId) {
  return webAppInvoke_(function() {
    var selected = webAppAuthorizeCustomer_(customerId, 'WEBAPP:一覧');
    var customer = selected.customer;
    if (folderId === null || folderId === undefined || String(folderId) === '') {
      var folders = webAppIteratorToArray_(
        DriveApp.getFolderById(customer.sourceFolderId).getFolders()
      ).map(function(folder) {
        return {folderId: String(folder.getId()), folderName: String(folder.getName() || '')};
      });
      folders.sort(function(a, b) {
        if (a.folderName !== b.folderName) return a.folderName < b.folderName ? -1 : 1;
        return a.folderId < b.folderId ? -1 : (a.folderId > b.folderId ? 1 : 0);
      });
      return {kind: 'FOLDERS', folders: folders, files: []};
    }

    var folder = webAppDirectChildFolder_(customer, folderId);
    var stateByFileId = Object.create(null);
    permanentIndexRowsForScan_().forEach(function(row) {
      stateByFileId[String(row.fileId)] = row.state;
    });
    var nowMs = Date.now();
    var files = webAppIteratorToArray_(folder.getFiles()).map(function(file) {
      return webAppFolderFile_(file, stateByFileId, nowMs);
    });
    var reviewsByFile = Object.create(null);
    if (files.some(function(file) { return file.state === FILE_STATE.REVIEW_WAIT; })) {
      openReviews({reviewType: 'FORMAT_UNKNOWN'}).forEach(function(review) {
        if (String(review.customerId) === String(customerId) &&
            (review.status === 'OPEN' || review.status === 'IN_PROGRESS')) {
          reviewsByFile[String(review.fileId)] = review.reviewId;
        }
      });
    }
    files.forEach(function(file) {
      file.formatReviewId = reviewsByFile[file.fileId] || null;
    });
    files.sort(function(a, b) {
      if (a.fileName !== b.fileName) return a.fileName < b.fileName ? -1 : 1;
      return a.fileId < b.fileId ? -1 : (a.fileId > b.fileId ? 1 : 0);
    });
    return {kind: 'FILES', folders: [], files: files};
  });
}

/** 選択顧客の未解決 PARTNER 要確認と、その他種別の件数を返す。 */
function webAppListReviews(customerId, limit, offset) {
  return webAppInvoke_(function() {
    webAppAuthorizeCustomer_(customerId, 'WEBAPP:一覧');
    var wantedCustomerId = String(customerId);
    var customer = getCustomerById(wantedCustomerId);
    var otherCounts = {};
    var partnerReviews = [];

    openReviews({}).forEach(function(review) {
      if (String(review.customerId) !== wantedCustomerId) return;
      if (review.reviewType === REVIEW_TYPE.PARTNER) {
        partnerReviews.push(review);
        return;
      }
      var type = String(review.reviewType || 'UNKNOWN');
      otherCounts[type] = Number(otherCounts[type] || 0) + 1;
    });
    partnerReviews.sort(function(a, b) {
      var left = String(a.reviewId);
      var right = String(b.reviewId);
      return left < right ? -1 : (left > right ? 1 : 0);
    });

    var actualLimit = Math.floor(Number(limit) || WEBAPP_REVIEW_LIST_LIMIT_);
    if (actualLimit < 1) actualLimit = WEBAPP_REVIEW_LIST_LIMIT_;
    actualLimit = Math.min(actualLimit, WEBAPP_REVIEW_LIST_LIMIT_);
    var actualOffset = Math.max(0, Math.floor(Number(offset) || 0));
    if (partnerReviews.length && actualOffset >= partnerReviews.length) actualOffset = 0;
    if (!partnerReviews.length) actualOffset = 0;

    var rows = partnerReviews.slice(actualOffset, actualOffset + actualLimit).map(function(review) {
      var tx = getTransaction(review.fullTxId);
      var planned = tx && tx.planned ? tx.planned : null;
      var learnBlockedBy = null;
      if (!review.merchantNormalized) {
        learnBlockedBy = 'EMPTY_MERCHANT';
      } else if (isCardNamePartnerPurpose(customer, planned ? planned.i : '')) {
        learnBlockedBy = 'CARD_NAME_PURPOSE';
      }
      return {
        reviewId: review.reviewId,
        fileId: review.fileId,
        fileName: menuDisplayFileName_(review) || '（ファイル名不明）',
        sourceRow: review.sourceRow,
        merchantOriginal: webAppDisplayMerchant_(review.merchantOriginal),
        merchantNormalized: review.merchantNormalized,
        candidates: webAppUniquePartners_(menuReviewCandidates_(review)),
        usageDate: planned ? planned.b : null,
        amount: planned ? planned.m : null,
        learnBlockedBy: learnBlockedBy
      };
    });
    return {
      reviews: rows,
      partnerTotal: partnerReviews.length,
      otherCounts: otherCounts,
      offset: actualOffset,
      limit: actualLimit
    };
  });
}

/** 選択したカードフォルダから最大 1 ファイルを取り込む。 */
function webAppRunImport(customerId, folderId, options) {
  return webAppInvoke_(function() {
    var opts = options || {};
    var startedAt = Date.now();
    var now = new Date(startedAt);
    var selected = webAppAuthorizeCustomer_(customerId, 'WEBAPP:記帳');
    var customer = selected.customer;
    var suppliedDestinationId = opts.destinationSpreadsheetId === null ||
      opts.destinationSpreadsheetId === undefined || opts.destinationSpreadsheetId === '' ?
      null : String(opts.destinationSpreadsheetId);

    if (suppliedDestinationId) {
      webAppValidateDestination_(customer, suppliedDestinationId);
    }

    var importAuthorized = getAuthorizedCustomers(selected.scope.userEmail).some(function(candidate) {
      return String(candidate.customerId) === String(customer.customerId);
    });
    if (!importAuthorized) {
      return webAppImportResult_(0, 0, suppliedDestinationId, [],
        'NO_AUTHORIZED_CUSTOMER', null);
    }

    var folder = webAppDirectChildFolder_(customer, folderId);
    var directFileIds = Object.create(null);
    webAppIteratorToArray_(folder.getFiles()).forEach(function(file) {
      directFileIds[String(file.getId())] = true;
    });
    if (!Object.keys(directFileIds).length) {
      return webAppImportResult_(0, 0, suppliedDestinationId, [], null, null);
    }
    var candidatesBeforeLease = scanUnprocessedFiles(customer.customerId, {now: now})
      .filter(function(candidate) {
        return Boolean(directFileIds[String(candidate.fileId)]);
      });

    var leaseByFileId = Object.create(null);
    activeLeases_().forEach(function(lease) {
      leaseByFileId[String(lease.fileId)] = lease;
    });
    var candidates = candidatesBeforeLease.filter(function(candidate) {
      return !leaseByFileId[String(candidate.fileId)];
    });
    if (!candidates.length) {
      return webAppImportResult_(0, 0, suppliedDestinationId, [],
        candidatesBeforeLease.length ? 'LEASE_CONFLICT' : null, null);
    }

    var total = candidates.length;
    var elapsed = Date.now() - startedAt;
    if (elapsed + WEBAPP_IMPORT_BASE_TRIPS_ * WEBAPP_TRIP_WORST_MS_ >
        WEBAPP_DEADLINE_MS_) {
      return webAppImportResult_(0, total, suppliedDestinationId, [],
        'TIME_BUDGET', null);
    }

    var destinationSpreadsheetId = suppliedDestinationId;
    var schemaValidation = null;
    if (!destinationSpreadsheetId) {
      var clone = webAppCloneDestination_(customer, now);
      schemaValidation = clone.schemaValidation;
      if (!schemaValidation.ok) {
        return webAppImportResult_(0, total, undefined, [],
          schemaValidation.code || 'DESTINATION_SCHEMA_MISMATCH', schemaValidation);
      }
      destinationSpreadsheetId = clone.destinationSpreadsheetId;
    }

    var report = runImport({
      customerIds: [String(customer.customerId)],
      fileIds: candidates.map(function(candidate) { return String(candidate.fileId); }),
      maxFilesPerCustomer: 1,
      destinationSpreadsheetId: destinationSpreadsheetId,
      // 監査ログ連鎖の検証は**1押下につき1回**にする。1呼出し1ファイルなので、
      // 毎回やると 41 秒（500行のSHA-256。2026-09-20 実測）をファイルの数だけ
      // 払う ── 12ファイルで 8 分がこれだけに消える。押下の2回目以降は
      // クライアントが前回の転記先を渡してくるので、それを「同じ押下の続き」の
      // 印として使う（§7.3.1）。**押下ごとには必ず走る。**
      verifyAuditChain: !suppliedDestinationId,
      now: now
    });
    var fileResults = [];
    (report.customers || []).forEach(function(customerReport) {
      (customerReport.files || []).forEach(function(fileResult) {
        fileResults.push(fileResult);
      });
    });
    var done = fileResults.filter(function(fileResult) {
      return fileResult.outcome === 'WRITTEN' || fileResult.outcome === 'NO_WRITE';
    }).length;

    var stoppedBy = null;
    (report.customers || []).some(function(customerReport) {
      if (!customerReport.skipped) return false;
      stoppedBy = String(customerReport.skipped);
      return true;
    });
    if (report.stoppedBy) stoppedBy = String(report.stoppedBy);
    if (fileResults.some(function(fileResult) {
      return fileResult.outcome === 'LEASE_CONFLICT';
    })) {
      stoppedBy = 'LEASE_CONFLICT';
    }
    return webAppImportResult_(done, total, destinationSpreadsheetId,
      fileResults, stoppedBy, schemaValidation);
  });
}

/** 選択された PARTNER 要確認を、時間予算内で最大件数まで確定する。 */
function webAppResolveReviews(customerId, decisions, options) {
  return webAppInvoke_(function() {
    var startedAt = Date.now();
    var opts = options || {};
    var batchId = opts.batchId === null || opts.batchId === undefined ? '' :
      String(opts.batchId);
    var operation = 'WEBAPP:要確認を確定' + (batchId ? ':' + batchId : '');
    authorize(ROLE.REVIEWER, String(customerId), {operation: operation});
    var customer = getCustomerById(String(customerId));
    var source = Array.isArray(decisions) ? decisions : [];
    var outcome = webAppResolveOutcome_();
    var prepared = [];

    for (var overflow = WEBAPP_MAX_DECISIONS_; overflow < source.length; overflow += 1) {
      var overflowDecision = source[overflow] || {};
      webAppDecisionError_(outcome, overflowDecision.reviewId,
        'TOO_MANY_DECISIONS', '一度に確定できるのは ' +
        WEBAPP_MAX_DECISIONS_ + ' 件までです。');
    }

    var acceptedCount = Math.min(source.length, WEBAPP_MAX_DECISIONS_);
    for (var index = 0; index < acceptedCount; index += 1) {
      var decision = source[index] || {};
      var reviewId = decision.reviewId === null || decision.reviewId === undefined ? '' :
        String(decision.reviewId);
      var review = getReviewById(reviewId);
      if (!review) {
        webAppDecisionError_(outcome, reviewId, 'REVIEW_NOT_FOUND',
          'この要確認は見つかりませんでした。他の担当者が確定したか、取り消された可能性があります。画面を再読み込みしてください。');
        continue;
      }

      var partnerName = decision.partnerName === null || decision.partnerName === undefined ? '' :
        String(decision.partnerName).trim();
      // 取引先欄の「取引先不明」は名前ではなく、I列へ印を残して確定する指示である
      // （§15 の 2）。判定はサーバーで行う ── 古い画面が名前として送ってきても、
      // F列と辞書に実在しない取引先を入れない。
      var code = isPartnerUnknownLabel(partnerName) ? 'RESOLVE_PARTNER_UNKNOWN' :
        (partnerName ? 'ADOPT_EXISTING_PARTNER' : 'RESOLVE_WITHOUT_PARTNER');
      var itemAuth;
      try {
        itemAuth = authorizeOperation(code, String(review.customerId), {});
      } catch (authorizationError) {
        webAppDecisionError_(outcome, reviewId,
          authorizationError && authorizationError.code || 'RESOLVE_FAILED',
          menuOperationErrorMessage_(authorizationError));
        continue;
      }
      if (String(review.customerId) !== String(customerId)) {
        webAppDecisionError_(outcome, reviewId, 'REVIEW_CUSTOMER_MISMATCH',
          'この要確認は選択中の顧客のものではありません。画面を再読み込みしてからやり直してください。');
        continue;
      }
      if (review.status !== 'OPEN' && review.status !== 'IN_PROGRESS') {
        webAppDecisionError_(outcome, reviewId, 'ALREADY_SETTLED',
          'この要確認はすでに確定済みです。画面を再読み込みしてください。');
        continue;
      }
      prepared.push({
        decision: decision,
        review: review,
        reviewId: reviewId,
        partnerName: partnerName,
        code: code,
        auth: itemAuth
      });
    }

    var firstFileId = prepared.length ? String(prepared[0].review.fileId) : null;
    var work = [];
    prepared.forEach(function(item) {
      if (String(item.review.fileId) === firstFileId) {
        work.push(item);
      } else {
        outcome.deferredByFile += 1;
        outcome.notAttempted += 1;
      }
    });

    var cleanupFileIds = new Set(work.map(function(item) {
      return String(item.review.fileId);
    }));
    var cleanupWorstMs = WEBAPP_CLEANUP_TRIPS_ * cleanupFileIds.size *
      WEBAPP_TRIP_WORST_MS_;
    var touched = Object.create(null);
    var withoutPartnerLeaseBlocked = Object.create(null);
    var leaseByFileId = Object.create(null);
    var leaseRead = false;
    var resolveCalls = 0;

    for (var workIndex = 0; workIndex < work.length; workIndex += 1) {
      var item = work[workIndex];
      var fileId = String(item.review.fileId);

      if (item.code === 'RESOLVE_WITHOUT_PARTNER' &&
          withoutPartnerLeaseBlocked[fileId]) {
        outcome.skippedByLease += 1;
        outcome.skippedByLeaseReviewIds.push(item.reviewId);
        continue;
      }
      if (resolveCalls >= WEBAPP_MAX_PER_CALL_) {
        outcome.notAttempted += work.length - workIndex;
        break;
      }
      var elapsed = Date.now() - startedAt;
      if (elapsed + WEBAPP_ITEM_TRIPS_ * WEBAPP_TRIP_WORST_MS_ + cleanupWorstMs >
          WEBAPP_DEADLINE_MS_) {
        outcome.notAttempted += work.length - workIndex;
        break;
      }

      if (item.code === 'RESOLVE_WITHOUT_PARTNER') {
        if (!leaseRead) {
          activeLeases_().forEach(function(lease) {
            if (!leaseByFileId[String(lease.fileId)]) {
              leaseByFileId[String(lease.fileId)] = lease;
            }
          });
          leaseRead = true;
        }
        if (leaseByFileId[fileId]) {
          withoutPartnerLeaseBlocked[fileId] = true;
          webAppDecisionError_(outcome, item.reviewId, 'LEASE_CONFLICT',
            menuLeaseConflictText_(leaseByFileId[fileId]));
          continue;
        }
      }

      var tx = null;
      var learn = false;
      if (item.code === 'ADOPT_EXISTING_PARTNER') {
        tx = getTransaction(item.review.fullTxId);
        var transactionStatus = tx && tx.transactionStatus;
        if ([TX_STATUS.REVIEW_REQUIRED, TX_STATUS.COMMITTED].indexOf(transactionStatus) < 0) {
          webAppDecisionError_(outcome, item.reviewId, 'STATE_TRANSITION',
            'この取引は既に取り消されたか除外されています（状態 ' +
            (transactionStatus || '不明') + '）。画面を再読み込みしてください。');
          continue;
        }
        learn = Boolean(item.review.merchantNormalized) &&
          !isCardNamePartnerPurpose(customer, tx && tx.planned ? tx.planned.i : '') &&
          !Boolean(item.decision.sameMerchantConflict);
      }

      var input = {
        actor: item.auth.userEmail,
        role: item.auth.role,
        runId: null,
        partnerName: item.partnerName,
        learn: learn
      };
      touched[fileId] = true;
      resolveCalls += 1;
      try {
        var result = resolveReview(item.reviewId, item.code, input);
        outcome.resolved += 1;
        outcome.resolvedReviewIds.push(item.reviewId);
        if (result.committed) outcome.committed += 1;
        if (result.unmetConditions && result.unmetConditions.length) {
          outcome.unmet.push({
            reviewId: item.reviewId,
            unmetConditions: result.unmetConditions.slice(),
            openReviewTypes: (result.openReviewTypes || []).slice(),
            transactionStatus: result.transactionStatus || TX_STATUS.REVIEW_REQUIRED
          });
        }
      } catch (resolveError) {
        webAppDecisionError_(outcome, item.reviewId,
          resolveError && resolveError.code || 'RESOLVE_FAILED',
          menuOperationErrorMessage_(resolveError));
      }
    }

    Object.keys(touched).forEach(function(fileId) {
      try {
        var committed = commitSettledTransactions_(fileId);
        outcome.deferredCommits += Number(committed.deferred || 0);
      } catch (commitError) {
        webAppFileError_(outcome, fileId, commitError);
      }
      try {
        outcome.completedFiles.push(completeFileIfFullyResolved_(fileId,
          {readLeases: activeLeases_}));
      } catch (completeError) {
        webAppFileError_(outcome, fileId, completeError);
      }
    });
    outcome.remaining = outcome.notAttempted;
    return outcome;
  });
}

/** 公開関数の例外を、既存メニューと同じ日本語へ変換する。 */
function webAppInvoke_(fn) {
  try {
    return fn();
  } catch (error) {
    var classified = classifyMenuError_(error);
    var lines = classified && Array.isArray(classified.lines) ? classified.lines : [];
    var originalMessage = String(error && error.message || error || '');
    var message = lines.length ? lines.join('\n') :
      '想定していないエラーです: ' + originalMessage;
    var wrapped = new Error(message);
    wrapped.name = error && error.name;
    wrapped.code = error && error.code;
    wrapped.reason = error && error.reason;
    throw wrapped;
  }
}

/** 顧客 ID を認可へ渡し、認可済みの顧客レコードを返す。 */
function webAppAuthorizeCustomer_(customerId, operation) {
  var wanted = String(customerId);
  var scope = authorize(ROLE.REVIEWER, wanted, {operation: operation});
  return {scope: scope, customer: scope.customers[0]};
}

/** Apps Script の反復子を配列へ移す。 */
function webAppIteratorToArray_(iterator) {
  var values = [];
  while (iterator.hasNext()) values.push(iterator.next());
  return values;
}

/** 顧客ルート直下にちょうど 1 段だけあるフォルダを引く。 */
function webAppDirectChildFolder_(customer, folderId) {
  var wanted = String(folderId === null || folderId === undefined ? '' : folderId);
  var folders = DriveApp.getFolderById(customer.sourceFolderId).getFolders();
  while (folders.hasNext()) {
    var folder = folders.next();
    if (String(folder.getId()) === wanted) return folder;
  }
  throw new AuthorizationError('選択されたフォルダはこの顧客の直下にありません。');
}

/** ファイル一覧 1 行を作る。 */
function webAppFolderFile_(file, stateByFileId, nowMs) {
  var fileId = String(file.getId());
  var fileName = String(file.getName() || '');
  var updated = file.getLastUpdated();
  var updatedMs = updated instanceof Date ? updated.getTime() : new Date(updated).getTime();
  var supported = /\.(csv|xlsx)$/i.test(fileName);
  var stable = updatedMs <= nowMs - 10 * 60 * 1000;
  var registered = Object.prototype.hasOwnProperty.call(stateByFileId, fileId);
  var state = registered ? stateByFileId[fileId] : null;
  var stateLabel;
  if (registered) {
    stateLabel = menuFileStateLabel_(state);
  } else if (!supported) {
    stateLabel = '対象外';
  } else if (stable) {
    stateLabel = '取込可能';
  } else {
    var minutes = Math.max(1,
      Math.ceil((10 * 60 * 1000 - (nowMs - updatedMs)) / (60 * 1000)));
    stateLabel = '取込待ち（あと ' + minutes + ' 分）';
  }
  return {
    fileId: fileId,
    fileName: fileName,
    lastUpdated: toIso8601(updated),
    size: Number(file.getSize()),
    state: state,
    stateLabel: stateLabel,
    importable: supported && stable && (!registered || state === FILE_STATE.DISCOVERED)
  };
}

/** 制御文字だけの店名を表へ生で出さない。 */
function webAppDisplayMerchant_(merchant) {
  var raw = String(merchant === null || merchant === undefined ? '' : merchant);
  var visible = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return visible ? raw : '（店名を表示できません）';
}

/**
 * 候補を取引先名で一意にする。**表示のためだけの重複排除である。**
 *
 * `merchantCandidates_`（33_MerchantMatcher.gs 98行）は一致した辞書の行を
 * 1行1候補にして返す。同じ取引先名の行が辞書に何行あっても、担当者に
 * 見せるべき選択肢は1つである ── 2026-09-16 の実機で、1件の要確認に
 * 同一の「Amazon」が30個並んだ。
 *
 * 根は `learnFromResolution`（34_MerchantDictionary.gs 22行）が重複を
 * 確かめずに `appendRow` することで、確定のたびに同じ行が積まれる。
 * **ここはその症状を画面から隠すだけで、辞書そのものは直さない**（K-W17）。
 * 推測（STEP5）で同名の規則が複数当たる場合にも同じ形になるので、
 * 辞書を直した後もこの重複排除は要る。
 *
 * 先頭を残す ── `sortMerchantRules_` が優先度順に並べた後なので、
 * 残るのは最も優先される行である。
 */
function webAppUniquePartners_(candidates) {
  var seen = Object.create(null);
  return (candidates || []).filter(function(candidate) {
    var name = String(candidate && candidate.partnerName);
    if (seen[name]) return false;
    seen[name] = true;
    return true;
  });
}

/** クライアントが渡した既存転記先を 4 条件で検証する。 */
function webAppValidateDestination_(customer, destinationSpreadsheetId) {
  var destinationId = String(destinationSpreadsheetId);
  if (destinationId === String(customer.destinationSpreadsheetId)) {
    throw new AuthorizationError('雛形スプレッドシートへ直接書き込むことはできません。');
  }
  var templateFile = DriveApp.getFileById(customer.destinationSpreadsheetId);
  var destinationFile = DriveApp.getFileById(destinationId);
  var templateParents = webAppIteratorToArray_(templateFile.getParents());
  var destinationParents = webAppIteratorToArray_(destinationFile.getParents());
  if (templateParents.length !== 1 || destinationParents.length !== 1 ||
      String(templateParents[0].getId()) !== String(destinationParents[0].getId())) {
    throw new AuthorizationError('指定された転記先の保存場所が正しくありません。');
  }
  var prefix = String(customer.customerName) + '_';
  var fileName = String(destinationFile.getName() || '');
  if (fileName.indexOf(prefix) !== 0 ||
      !/^\d{8}-\d{4}$/.test(fileName.slice(prefix.length))) {
    throw new AuthorizationError('指定された転記先の名前が規則に合いません。');
  }
  var spreadsheet = SpreadsheetApp.openById(destinationId);
  if (!spreadsheet.getSheetByName(customer.destinationSheetName)) {
    throw new AuthorizationError('指定された転記先に必要なシートがありません。');
  }
  return destinationId;
}

/** 雛形を同じフォルダへ複製し、システム所有 6 列だけを空にする。 */
function webAppCloneDestination_(customer, now) {
  var templateFile = DriveApp.getFileById(customer.destinationSpreadsheetId);
  var parents = webAppIteratorToArray_(templateFile.getParents());
  if (parents.length !== 1) {
    throw new AuthorizationError('雛形スプレッドシートの保存場所を一意に決められません。');
  }
  var name = String(customer.customerName) + '_' +
    Utilities.formatDate(now, SYSTEM_TIMEZONE, 'yyyyMMdd-HHmm');
  var copy = templateFile.makeCopy(name, parents[0]);
  var destinationSpreadsheetId = String(copy.getId());
  var spreadsheet = SpreadsheetApp.openById(destinationSpreadsheetId);
  var sheet = spreadsheet.getSheetByName(customer.destinationSheetName);
  if (!sheet) {
    return {
      schemaValidation: {
        ok: false,
        code: 'DESTINATION_SHEET_MISSING',
        problems: [schemaProblem_(1, 'SHEET_NOT_FOUND', customer.destinationSheetName)],
        warnings: []
      }
    };
  }
  var firstDataRow = Number(customer.headerRow) + 1;
  var lastRow = Number(sheet.getLastRow());
  if (lastRow >= firstDataRow) {
    ['B', 'F', 'I', 'K', 'M', 'txId'].forEach(function(key) {
      sheet.getRange(firstDataRow, Number(customer.columnMapping[key]),
        lastRow - firstDataRow + 1, 1).clearContent();
    });
  }
  var newCustomer = Object.assign({}, customer,
    {destinationSpreadsheetId: destinationSpreadsheetId});
  var schemaValidation = validateDestinationSchema(newCustomer,
    buildIndex(newCustomer, {}));
  if (!schemaValidation.ok) {
    return {schemaValidation: schemaValidation};
  }
  return {
    destinationSpreadsheetId: destinationSpreadsheetId,
    schemaValidation: schemaValidation
  };
}

/**
 * **最終確認**（段階4 ダウンロードの手前）。
 *
 * このセッションの転記先シートに**実際に入っている行**と、明細との突き合わせを
 * 返す。ダウンロードはこのシートをそのまま xlsx にして渡すので、ここに出る行が
 * ダウンロードされる行そのものである ── Excel を開くまで何が書かれたか
 * 確かめられない、という状態をなくす（ko-ch さんの要望、2026-09-21）。
 *
 * **単位は転記先シートである。**取込も要確認の確定も同じシートへ書く
 * （確定は要確認行 M列が指すシートへ書く）。だから取込と確定の両方を含む。
 *
 * **全列を、計算後の値で出す。**システムが書くのは日付・取引先・摘要・金額・
 * メモの5列だけで、勘定科目・消費税・残高は雛形の数式が計算する。
 * 利用者が確かめたいのは Excel に出る値なので、数式ではなく結果を出す。
 *
 * @param {string} customerId
 * @param {string} destinationSpreadsheetId このセッションの転記先
 * @param {Array<string>=} fileIds このセッションで取り込んだファイル。
 *   シートに1行も書かれなかったファイルの漏れを拾うためにある
 *   （シートの行から辿るだけでは、全部漏れたファイルが見えない）。
 */
function webAppFinalReview(customerId, destinationSpreadsheetId, fileIds) {
  return webAppInvoke_(function() {
    webAppAuthorizeCustomer_(customerId, 'WEBAPP:最終確認');
    var base = getCustomerById(String(customerId));
    var destinationId = webAppValidateDestination_(base, destinationSpreadsheetId);
    var customer = Object.assign({}, base, {destinationSpreadsheetId: destinationId});
    var sheet = finalReviewSheet_(customer);
    var reconciliation = finalReviewReconcile_(customer, sheet.rows, fileIds || []);
    // 行ごとの状態（確定済み／要確認）を付ける。表の各行で見分けられるように。
    sheet.rows.forEach(function(row) {
      var status = reconciliation.statusByTxId[row.txId];
      row.status = status || null;
    });
    delete reconciliation.statusByTxId;
    return {
      destinationSpreadsheetId: destinationId,
      headers: sheet.headers,
      amountColumnIndex: sheet.amountColumnIndex,
      rows: sheet.rows,
      reconciliation: reconciliation
    };
  });
}

/**
 * 転記先シートの見出しと、システムが書いた行（取引IDを持つ行）を読む。
 *
 * 表示用（`FORMATTED_VALUE`）と計算用（`UNFORMATTED_VALUE`）で2回読む。
 * 描画指定は要求ごとにしか選べないので1回にはまとまらない。1画面1回の
 * 読取なので、取込の往復予算（読取クォータ）には関わらない。
 */
function finalReviewSheet_(customer) {
  var headerRow = Number(customer.headerRow);
  var lastColumn = Number(customer.rowScanLastColumn);
  var range = quoteSheetName_(customer.destinationSheetName) + '!A' + headerRow + ':' +
    columnLetter_(lastColumn);
  var shown = destinationRangeValues_(customer.destinationSpreadsheetId, range, 'FORMATTED_VALUE');
  var raw = destinationRangeValues_(customer.destinationSpreadsheetId, range, 'UNFORMATTED_VALUE');

  var headers = [];
  var headerCells = shown[0] || [];
  for (var column = 0; column < lastColumn; column += 1) {
    var label = headerCells[column];
    headers.push(label === undefined || label === null ? '' : String(label));
  }

  var txIdIndex = Number(customer.columnMapping.txId) - 1;
  // **金額は M 列である**（71 の `planned`：B日付・F取引先・Iメモ・K摘要・M金額）。
  // freee の列記号で呼ぶので名前から推し量ると取り違える ── 2026-09-23 に
  // 実際に K を金額と読み違え、テストが「転記した合計 0」で捕まえた。
  var amountIndex = Number(customer.columnMapping.M) - 1;
  var rows = [];
  for (var offset = 1; offset < raw.length; offset += 1) {
    var rawRow = raw[offset] || [];
    var txId = rawRow[txIdIndex];
    if (txId === undefined || txId === null || String(txId) === '') continue;
    var shownRow = shown[offset] || [];
    var cells = [];
    for (var index = 0; index < lastColumn; index += 1) {
      var cell = shownRow[index];
      cells.push(cell === undefined || cell === null ? '' : String(cell));
    }
    var amount = rawRow[amountIndex];
    rows.push({
      rowNumber: headerRow + offset,
      txId: String(txId),
      cells: cells,
      amount: typeof amount === 'number' ? amount : null
    });
  }
  return {headers: headers, rows: rows, amountColumnIndex: amountIndex};
}

/** 転記されているはずの状態。`PREPARED`・`WRITING` が残っていれば書き損じである。 */
var FINAL_REVIEW_WRITTEN_STATUSES_ = [
  TX_STATUS.COMMITTED, TX_STATUS.REVIEW_REQUIRED, TX_STATUS.PREPARED, TX_STATUS.WRITING
];
/** 転記しないと決めた状態。明細にはあるが、シートに無くて正しい。 */
var FINAL_REVIEW_EXCLUDED_STATUSES_ = [TX_STATUS.CANCELED, TX_STATUS.DELETED_ACCEPTED];

/**
 * **明細とシートの突き合わせ。**
 *
 * ファイルごとに次が成り立てば、漏れも重複もない：
 *
 *     明細の利用金額の合計 − 除外した分 ＋ 金額修正の差 − 転記した金額の合計 ＝ 0
 *
 * 「転記した金額が明細の合計と一致すること」が、漏れなく重複なく転記された
 * 指標の1つになる（ko-ch さんの説明、2026-09-20）。ただし**正しく除外した
 * 取引**と**担当者が直した金額**の分は、合わなくて正しい。それを差し引いて
 * 残りが0かを見る。残りが0でなければ、取引ごとの検査のどれかが理由を
 * 名指しする。
 *
 * - 明細の利用金額：取引ログ Q列（`originalAmount`）。取り込んだ時の明細の値で、
 *   後から変わらない。**読めない値は0円として計算し、必ず問題として出す**
 *   （黙って外すと過少計上を見逃す。30 の件数・合計の照合と同じ扱い）。
 * - 転記した金額：いまシートにある金額列の値。
 * - 金額修正の差：取引ログ W列（`planned.m`、担当者の修正を反映した予定金額）と
 *   明細の値の差。
 */
function finalReviewReconcile_(customer, rows, requestedFileIds) {
  var problems = [];
  var rowsByTxId = Object.create(null);
  rows.forEach(function(row) {
    if (!rowsByTxId[row.txId]) rowsByTxId[row.txId] = [];
    rowsByTxId[row.txId].push(row);
  });
  var txIds = Object.keys(rowsByTxId);

  // 1. 行が指す取引。そこからファイルを知る。
  var byId = txIds.length ? findRowsByColumnValues_(transactionLogSheet_(), 1, txIds,
    TRANSACTION_LOG_WIDTH_) : {};
  var fileIds = Object.create(null);
  txIds.forEach(function(txId) {
    var found = (byId[txId] || []).map(txLogFromRecord_).filter(function(tx) { return tx.active; });
    if (!found.length) {
      problems.push({kind: 'ORPHAN', txId: txId,
        rowNumbers: rowsByTxId[txId].map(function(row) { return row.rowNumber; })});
      return;
    }
    if (String(found[0].customerId) !== String(customer.customerId)) {
      problems.push({kind: 'FOREIGN_CUSTOMER', txId: txId,
        rowNumbers: rowsByTxId[txId].map(function(row) { return row.rowNumber; })});
      return;
    }
    fileIds[String(found[0].fileId)] = true;
  });
  // このセッションで取り込んだファイルも足す（1行も書かれなかったファイルの漏れを拾う）
  (requestedFileIds || []).forEach(function(fileId) {
    if (fileId !== undefined && fileId !== null && String(fileId) !== '') {
      fileIds[String(fileId)] = true;
    }
  });

  // 2. そのファイルの取引を全部。
  var fileIdList = Object.keys(fileIds);
  var byFile = fileIdList.length ? findRowsByColumnValues_(transactionLogSheet_(), 5, fileIdList,
    TRANSACTION_LOG_WIDTH_) : {};

  var statusByTxId = Object.create(null);
  var files = [];
  fileIdList.forEach(function(fileId) {
    var txs = (byFile[fileId] || []).map(txLogFromRecord_).filter(function(tx) {
      return tx.active && String(tx.customerId) === String(customer.customerId);
    });
    // **この顧客の取引が1件も無いファイルは出さない。**画面から渡された
    // ファイルIDに他の顧客のものが混ざると、取引は上で落ちてもファイル名は
    // 処理ログから引けてしまう ── 名前も明細の一部である。
    if (!txs.length) return;
    var summary = {fileId: fileId, fileName: '', transactions: txs.length,
      statement: 0, excluded: 0, corrected: 0, written: 0, writtenRows: 0, residual: 0};
    txs.forEach(function(tx) {
      statusByTxId[tx.fullTxId] = tx.transactionStatus;
      var original = finalReviewAmount_(tx.originalAmount);
      if (original === null) {
        problems.push({kind: 'UNREADABLE_AMOUNT', txId: tx.fullTxId, fileId: fileId,
          value: String(tx.originalAmount)});
        original = 0;
      }
      summary.statement += original;
      var excluded = FINAL_REVIEW_EXCLUDED_STATUSES_.indexOf(tx.transactionStatus) >= 0;
      var shouldBeWritten = FINAL_REVIEW_WRITTEN_STATUSES_.indexOf(tx.transactionStatus) >= 0;
      var present = rowsByTxId[tx.fullTxId] || [];
      if (excluded) {
        summary.excluded += original;
        if (present.length) {
          problems.push({kind: 'EXCLUDED_BUT_PRESENT', txId: tx.fullTxId, fileId: fileId,
            rowNumbers: present.map(function(row) { return row.rowNumber; })});
        }
        return;
      }
      if (!shouldBeWritten) return;
      var planned = finalReviewAmount_(tx.planned && tx.planned.m);
      if (planned !== null && planned !== original) summary.corrected += planned - original;
      if (!present.length) {
        problems.push({kind: 'MISSING', txId: tx.fullTxId, fileId: fileId,
          status: tx.transactionStatus, amount: planned === null ? original : planned});
        return;
      }
      if (present.length > 1) {
        problems.push({kind: 'DUPLICATE', txId: tx.fullTxId, fileId: fileId,
          rowNumbers: present.map(function(row) { return row.rowNumber; })});
      }
      present.forEach(function(row) {
        summary.writtenRows += 1;
        summary.written += row.amount === null ? 0 : row.amount;
        var expected = planned === null ? original : planned;
        if (row.amount === null || row.amount !== expected) {
          problems.push({kind: 'AMOUNT_MISMATCH', txId: tx.fullTxId, fileId: fileId,
            rowNumber: row.rowNumber, expected: expected, actual: row.amount});
        }
      });
    });
    summary.residual = summary.statement - summary.excluded + summary.corrected - summary.written;
    summary.balanced = summary.residual === 0;
    summary.fileName = finalReviewFileName_(fileId);
    files.push(summary);
  });

  var totals = files.reduce(function(sum, file) {
    ['statement', 'excluded', 'corrected', 'written', 'residual'].forEach(function(key) {
      sum[key] += file[key];
    });
    return sum;
  }, {statement: 0, excluded: 0, corrected: 0, written: 0, residual: 0});
  totals.balanced = totals.residual === 0 && problems.length === 0;

  return {files: files, totals: totals, problems: problems, statusByTxId: statusByTxId};
}

/** 金額を円の整数に。読めなければ null（呼出側が問題として出す）。 */
function finalReviewAmount_(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    return toJpyInteger(value);
  } catch (error) {
    return null;
  }
}

/** 表示用のファイル名。処理ログに無ければファイルIDのまま。 */
function finalReviewFileName_(fileId) {
  var record = getProcessLogRecord_(fileId);
  if (!record) return String(fileId);
  var name = record.values[PROCESS_FIELD_COLUMNS_.originalFileName - 1];
  return name ? String(name) : String(fileId);
}

/** Web 取込の固定した戻り値を作る。 */
function webAppImportResult_(done, total, destinationSpreadsheetId, fileResults,
    stoppedBy, schemaValidation) {
  var result = {
    done: Number(done || 0),
    total: Number(total || 0),
    remaining: Math.max(0, Number(total || 0) - Number(done || 0)),
    fileResults: fileResults || [],
    stoppedBy: stoppedBy || null
  };
  if (destinationSpreadsheetId !== undefined) {
    result.destinationSpreadsheetId = destinationSpreadsheetId || null;
  }
  if (schemaValidation) result.schemaValidation = schemaValidation;
  return result;
}

/** Web 一括確定の初期結果。 */
function webAppResolveOutcome_() {
  return {
    resolved: 0,
    committed: 0,
    unmet: [],
    completedFiles: [],
    rewoundFiles: [],
    deferredCommits: 0,
    skippedByLease: 0,
    notAttempted: 0,
    errors: [],
    maxPerCall: WEBAPP_MAX_PER_CALL_,
    remaining: 0,
    resolvedReviewIds: [],
    skippedByLeaseReviewIds: [],
    deferredByFile: 0
  };
}

/** 件ごとの失敗を結果へ積む。 */
function webAppDecisionError_(outcome, reviewId, code, message) {
  outcome.errors.push({
    reviewId: reviewId === null || reviewId === undefined ? '' : String(reviewId),
    code: code || 'RESOLVE_FAILED',
    message: String(message || '')
  });
}

/** 後始末のファイル単位エラーを結果へ積む。 */
function webAppFileError_(outcome, fileId, error) {
  outcome.errors.push({
    fileId: String(fileId),
    code: error && error.code || null,
    message: menuOperationErrorMessage_(error)
  });
}

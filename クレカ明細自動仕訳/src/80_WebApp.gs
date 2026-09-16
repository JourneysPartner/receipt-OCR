/**
 * Web アプリから呼ぶ関数だけは Apps Script の制約により末尾に `_` を付けない。
 *
 * 次の 3 値は実機受入で測り直す。
 * - WEBAPP_MAX_PER_CALL_
 * - WEBAPP_TRIP_WORST_MS_
 * - WEBAPP_IMPORT_BASE_TRIPS_
 */
var WEBAPP_MAX_DECISIONS_ = 15;
var WEBAPP_MAX_PER_CALL_ = 1;
var WEBAPP_ITEM_TRIPS_ = 74;
var WEBAPP_CLEANUP_TRIPS_ = 62;
var WEBAPP_REVIEW_LIST_LIMIT_ = 15;
var WEBAPP_IMPORT_BASE_TRIPS_ = 164;
var WEBAPP_IMPORT_TRIPS_PER_REVIEW_ = 7;
var WEBAPP_CLONE_TRIPS_ = 3;
var WEBAPP_TRIP_WORST_MS_ = 1600;
var WEBAPP_DEADLINE_MS_ = 300000;

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
        candidates: menuReviewCandidates_(review),
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
      var code = partnerName ? 'ADOPT_EXISTING_PARTNER' : 'RESOLVE_WITHOUT_PARTNER';
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

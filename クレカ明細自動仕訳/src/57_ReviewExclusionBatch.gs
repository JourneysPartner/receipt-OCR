'use strict';

/**
 * 「その他の要確認」を、1 つのファイルの分だけまとめて対象外にする
 * （`work/spec_other_reviews_exclude_batch.md` §2.2）。
 *
 * **なぜ部品 55 に足さず、別の部品にしたか。**第 1 段（計上）は、要確認の
 * 書込・確定の判定・リース・時間の門を 1 か所にまとめるために 55 へ足した。
 * 対象外は確定の判定を持たず（`CANCELED` は終端）、書く表（転記先の行を空に
 * する・取引の状態・要確認の `EXCLUDED`）も監査の形も計上と違う。55 へ足すと
 * 本番で使っている計上・取引先の経路の全段に分かれ目が入るので、別の部品に
 * して 55 を 1 文字も変えないままにする。時間の門・後始末・戻り値の形は 80 が
 * 共通のものを使う。
 *
 * **消す前に行を取引 ID で確かめる理由。**1 件ずつの経路（51 の
 * `excludeTransaction_`）は行番号だけで行を消す。転記先の行が並べ替えなどで
 * 動いていると、**別の取引の行を消す**（帳簿の行が消え、取引ログはその取引が
 * 居ると言い続ける）。まとめると一度に消す行が多いので、消す前に「この行に
 * この取引の ID が入っている」ことを索引で確かめる（§2.2.1）。
 *
 * **行を先に空にし、取引ログ → 要確認の順に書く理由（§2.2.2）。**先に取引を
 * `CANCELED` にして行を消す前に止まると、`CANCELED` の取引の行が帳簿に残り
 * （幽霊行）、取引は終端なので画面からはどの操作も届かない。行を先に消せば、
 * 止まってもやり直せる。取引ログを要確認より先に書くのは、逆にすると
 * 「要確認は `EXCLUDED`・取引は `REVIEW_REQUIRED`・行は空」で止まり得て、
 * 後始末（`commitSettledTransactions_`）が**空の行のまま確定する**からである。
 */

/** この部品が受け付ける操作。前年利用日と 0 円のどちらも、することは同じ。 */
var EXCLUDE_BATCH_OPERATIONS_ = ['EXCLUDE_PRIOR_YEAR', 'EXCLUDE'];

/** この部品だけの文。表に無いコードは `partnerBatchMessage_` の文を使う。 */
function excludeBatchMessage_(code) {
  var messages = {
    DUPLICATE_TRANSACTION: '同じ取引の要確認がほかにも選ばれています。対象外は取引ごとなので、1 件だけ選んでください。',
    FREEE_IMPORTED: 'freee に取り込み済みの取引です。画面からは対象外にできません。管理者へ連絡してください。',
    DESTINATION_ROW_MISMATCH: '転記先の行がこの取引の行と一致しません（行が動いたか、別の取引の行になっています）。管理者へ連絡してください。',
    DESTINATION_VALUE_MISMATCH: '転記行を空にしたあと読み返すと値が残っていました。取引は対象外にしていません。管理者へ連絡してください。'
  };
  return messages[String(code)] || partnerBatchMessage_(code);
}

/** `clearTransactionRows` が空にする列（列対応にあるものだけ）。 */
function excludeBatchClearColumns_(customer) {
  var keys = ['txId', 'b', 'f', 'i', 'k', 'm'];
  if (customer.columnMapping && customer.columnMapping.L) keys.push('l');
  if (customer.columnMapping && customer.columnMapping.C) keys.push('c');
  return keys.map(function(key) {
    return {key: key, column: writeColumnNumber_(customer, key)};
  });
}

/** 索引の行で、消す列がすべて空か（`''`／`null`／`undefined`）。 */
function excludeBatchRowIsClear_(row, columns) {
  if (!row) return false;
  return columns.every(function(entry) {
    var value = row[entry.column - 1];
    return value === '' || value === null || value === undefined;
  });
}

/** 読み返しで空を期待する値（`53` の手順 9 と同じ考え方）。 */
function excludeBatchEmptyValues_(customer) {
  var values = {b: '', f: '', i: '', k: '', m: ''};
  if (customer.columnMapping && customer.columnMapping.C) values.c = '';
  return values;
}

/** 行が転記先に在るか・同じ行か・既に空か、を §2.2.1 の表で決める。 */
function excludeBatchClassifyRow_(customer, index, item) {
  var dr = item.tx.destinationRow;
  var hasRow = !(dr === '' || dr === null || dr === undefined);
  var hit = getRowByTxId(index, item.review.fullTxId);
  var rowNumber = hasRow ? Number(dr) : null;
  var row = hasRow && Number.isInteger(rowNumber) ?
    getAllValuesByRow(index, rowNumber) : null;
  if (hasRow && hit.matchCount === 1 && Number(hit.rowNumber) === rowNumber) {
    return {kind: 'CLEAR', rowNumber: rowNumber};
  }
  if (hasRow && hit.matchCount === 0 && item.recorded &&
      excludeBatchRowIsClear_(row, excludeBatchClearColumns_(customer))) {
    // `recorded` が無い取引は `ALREADY_CLEARED` にしない。旧い行の転記先は
    // 推測でしかないので、行が空でも「前に自分が空にした」とは言えない
    // （推測が外れると 1 行も消せず取引ログだけ `CANCELED` になる）。
    return {kind: 'ALREADY_CLEARED', rowNumber: rowNumber};
  }
  if (!hasRow && hit.matchCount === 0) return {kind: 'NO_ROW', rowNumber: null};
  return {kind: 'MISMATCH', rowNumber: null};
}

/**
 * 1 ファイルの「その他の要確認」をまとめて対象外にする。
 *
 * `decisions` は `{reviewId, operation}` の配列（`EXCLUDE_PRIOR_YEAR` と
 * `EXCLUDE` は同じ呼出しに混ざってよい ── することは同じ）。`options` は
 * `{actor, role, customer}`。戻り値の形は部品 55 と同じで、`decisions` の
 * 1 件は必ず `resolvedReviewIds`・`errors`・`skippedByLeaseReviewIds`・
 * `notAttemptedReviewIds` のどれか 1 つだけに入る。
 *
 * 呼出し側の誤りは何も読まずに `TypeError`。データの状態による失敗は件ごとの
 * `errors` に積み、他の件や他の転記先を止めない（`LEASE_CONFLICT` だけは全体を止める）。
 */
function excludeOtherReviewsBatch(customerId, fileId, decisions, options) {
  var startedAt = partnerBatchClockNow_();
  var readsAtStart = apiReadCount_;

  if (typeof customerId !== 'string' || !customerId.trim()) {
    throw new TypeError('customerId must be a non-empty string');
  }
  if (typeof fileId !== 'string' || !fileId.trim()) {
    throw new TypeError('fileId must be a non-empty string');
  }
  if (!Array.isArray(decisions)) throw new TypeError('decisions must be an array');
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options with actor is required');
  }
  if (typeof options.actor !== 'string' || !options.actor.trim()) {
    throw new TypeError('options.actor must be a non-empty string');
  }
  if (options.role !== undefined && options.role !== null &&
      typeof options.role !== 'string') {
    throw new TypeError('options.role must be a string or null');
  }
  if (options.customer && (typeof options.customer !== 'object' ||
      String(options.customer.customerId || '') !== customerId)) {
    throw new TypeError('options.customer must match customerId');
  }
  decisions.forEach(function(decision) {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      throw new TypeError('each decision must be an object');
    }
    if (typeof decision.reviewId !== 'string' || !decision.reviewId) {
      throw new TypeError('decision.reviewId must be a non-empty string');
    }
    if (EXCLUDE_BATCH_OPERATIONS_.indexOf(decision.operation) < 0) {
      throw new TypeError('unsupported review exclusion operation');
    }
  });

  var operationCodes = [];
  decisions.forEach(function(decision) {
    if (operationCodes.indexOf(decision.operation) < 0) {
      operationCodes.push(decision.operation);
    }
  });

  var result = {
    runId: generateId('XB'), fileId: fileId, customerId: customerId,
    resolvedReviewIds: [], committedReviewIds: [], unmet: [], errors: [],
    skippedByLeaseReviewIds: [], notAttemptedReviewIds: [], leaseConflict: null,
    followUp: null, ms: 0, reads: 0
  };
  var stats = {items: decisions.length, operations: operationCodes,
    destinations: 0, rowsCleared: 0, alreadyCleared: 0, noRow: 0};
  var fileTransactions = null;
  var followUpReviews = null;
  var closedReviewIds = Object.create(null);
  var canceledTxIds = Object.create(null);

  function followUpValue_() {
    if (!fileTransactions) return null;
    var reviews = followUpReviews || [];
    var openTxIds = Object.create(null);
    reviews.forEach(function(review) {
      if ((review.status === 'OPEN' || review.status === 'IN_PROGRESS') &&
          !closedReviewIds[String(review.reviewId)]) {
        openTxIds[String(review.fullTxId)] = true;
      }
    });
    return {orphanCandidates: fileTransactions.filter(function(tx) {
      var key = String(tx.fullTxId);
      return tx.active === true && tx.transactionStatus === TX_STATUS.REVIEW_REQUIRED &&
        !canceledTxIds[key] && !openTxIds[key];
    }).length};
  }

  function finish() {
    if (result.followUp === null) result.followUp = followUpValue_();
    result.ms = partnerBatchClockNow_() - startedAt;
    result.reads = apiReadCount_ - readsAtStart;
    // 数とコードだけ。明細の値・店名・ファイル名・取引先名・転記先の ID は出さない。
    Logger.log('EXCLUDE_BATCH ' + JSON.stringify({runId: result.runId, fileId: fileId,
      items: stats.items, operations: stats.operations,
      excluded: result.resolvedReviewIds.length,
      errors: result.errors.length,
      skippedByLease: result.skippedByLeaseReviewIds.length,
      notAttempted: result.notAttemptedReviewIds.length,
      destinations: stats.destinations, rowsCleared: stats.rowsCleared,
      alreadyCleared: stats.alreadyCleared, noRow: stats.noRow,
      ms: result.ms, reads: result.reads,
      orphanCandidates: result.followUp ? result.followUp.orphanCandidates : null}));
    return result;
  }

  // 手順 1：上限と、同じ ID の 2 回目。
  var maxItems = Math.max(0, Math.floor(Number(PARTNER_BATCH_MAX_ITEMS_) || 0));
  var targets = decisions.slice(0, maxItems);
  result.notAttemptedReviewIds = decisions.slice(maxItems).map(function(item) {
    return item.reviewId;
  });
  var seenReviewIds = Object.create(null);
  var selected = [];
  targets.forEach(function(decision) {
    var reviewId = decision.reviewId;
    if (seenReviewIds[reviewId]) {
      result.errors.push({reviewId: reviewId, code: 'DUPLICATE_DECISION',
        message: excludeBatchMessage_('DUPLICATE_DECISION')});
      return;
    }
    seenReviewIds[reviewId] = true;
    selected.push({decision: decision, reviewId: reviewId,
      operation: decision.operation, failed: null});
  });

  // 手順 2：要確認を 1 回読む（同じ ID が複数行なら最初の行）。
  var reviews = allReviewRecords_();
  followUpReviews = reviews;
  var reviewsById = Object.create(null);
  reviews.forEach(function(review) {
    if (!Object.prototype.hasOwnProperty.call(reviewsById, review.reviewId)) {
      reviewsById[review.reviewId] = review;
    }
  });
  // 同じ取引の 2 件目は書く前に止める。1 件目で取引が `CANCELED` になるので、
  // 1 件ずつの経路なら 2 件目は「取引の状態 CANCELED では不可」で止まり、
  // 要確認は `OPEN` のまま残る。まとめても同じ終わりの状態にする。
  var transactionIds = Object.create(null);
  var eligible = [];
  selected.forEach(function(item) {
    var review = reviewsById[item.reviewId];
    var code = null;
    if (!review) code = 'REVIEW_NOT_FOUND';
    else if (String(review.customerId || '') !== customerId) code = 'REVIEW_CUSTOMER_MISMATCH';
    else if (String(review.fileId || '') !== fileId) code = 'REVIEW_FILE_MISMATCH';
    else if (review.status !== 'OPEN' && review.status !== 'IN_PROGRESS') code = 'ALREADY_SETTLED';
    else if (availableResolveOperations(review.reviewType).indexOf(item.operation) < 0) {
      code = 'OPERATION_NOT_OFFERED';
    } else if (transactionIds[String(review.fullTxId || '')]) {
      code = 'DUPLICATE_TRANSACTION';
    }
    if (code) {
      partnerBatchFail_(result, item, code, excludeBatchMessage_(code));
      return;
    }
    transactionIds[String(review.fullTxId || '')] = true;
    item.review = review;
    eligible.push(item);
  });

  if (!eligible.length) return finish();

  // 手順 3：ファイルのリースを 1 回取る。例外でも必ず返す。
  var leaseId;
  try {
    leaseId = acquireLease(customerId, fileId, result.runId, options.actor,
      LEASE_PURPOSE.WRITE_ONLY);
  } catch (leaseError) {
    if (String(leaseError && leaseError.code || '') !== 'LEASE_CONFLICT') throw leaseError;
    eligible.forEach(function(item) {
      result.skippedByLeaseReviewIds.push(item.reviewId);
    });
    result.leaseConflict = {message: partnerBatchMessage_('LEASE_CONFLICT')};
    return finish();
  }

  try {
    // 手順 4：ファイルの取引を 1 回読む。**リースを持ってから読んだ値**で
    // 状態と freee の状態をもう一度確かめる。
    fileTransactions = getTransactionsForFile_(fileId);
    var txsById = Object.create(null);
    fileTransactions.forEach(function(tx) {
      var key = String(tx.fullTxId);
      if (!txsById[key]) txsById[key] = [];
      txsById[key].push(tx);
    });

    var prepared = [];
    eligible.forEach(function(item) {
      var matches = txsById[String(item.review.fullTxId || '')] || [];
      var code = null;
      if (!matches.length) code = 'TX_NOT_FOUND';
      else if (matches.length > 1) code = 'TRANSACTION_LOG_AMBIGUOUS';
      var tx = matches[0];
      if (!code && tx.transactionStatus !== TX_STATUS.REVIEW_REQUIRED &&
          tx.transactionStatus !== TX_STATUS.COMMITTED) code = 'STATE_TRANSITION';
      if (!code && (tx.freeeStatus === FREEE_IMPORT_STATUS.IMPORTED ||
          tx.freeeStatus === FREEE_IMPORT_STATUS.NEEDS_FREEE_FIX)) code = 'FREEE_IMPORTED';
      if (code) {
        partnerBatchFail_(result, item, code, excludeBatchMessage_(code));
        return;
      }
      item.tx = tx;
      item.from = tx.transactionStatus;
      prepared.push(item);
    });

    // 手順 5：転記先を決める（読まない）。
    var customer = options.customer || getCustomerById(customerId);
    prepared.forEach(function(item) {
      item.destinationCustomer = reviewWriteCustomer_(item.review, customer);
      item.recorded = recordedDestinationOf_(item.tx, customer);
    });
    prepared = prepared.filter(function(item) { return !item.failed; });

    prepared.forEach(function(item) {
      var dest = item.destinationCustomer;
      var recorded = item.recorded;
      if (recorded && (recorded.spreadsheetId !== String(dest.destinationSpreadsheetId) ||
          recorded.sheetName !== String(dest.destinationSheetName))) {
        // 要確認行と取引ログが別の転記先を指している。どちらの行を消すべきか
        // 分からないので消さない（1 件ずつの経路は要確認行の側を消す）。
        partnerBatchFail_(result, item, 'DESTINATION_ROW_MISMATCH',
          excludeBatchMessage_('DESTINATION_ROW_MISMATCH'));
        return;
      }
      var dr = item.tx.destinationRow;
      var hasRow = !(dr === '' || dr === null || dr === undefined);
      if (hasRow && !txHasDestinationRow_(item.tx)) {
        partnerBatchFail_(result, item, 'DESTINATION_ROW_MISSING',
          excludeBatchMessage_('DESTINATION_ROW_MISSING'));
      }
    });
    prepared = prepared.filter(function(item) { return !item.failed; });

    // 2 件以上が同じ (転記先, 行) を指すのは取引ログの壊れ。どれも消さない。
    // 行を持たない件（`NO_ROW`）は行が無いので、同じ転記先でも衝突にしない。
    var rowsByDestination = Object.create(null);
    prepared.forEach(function(item) {
      var dr = item.tx.destinationRow;
      if (dr === '' || dr === null || dr === undefined) return;
      var key = JSON.stringify([String(item.destinationCustomer.destinationSpreadsheetId),
        String(item.destinationCustomer.destinationSheetName), String(dr)]);
      if (!rowsByDestination[key]) rowsByDestination[key] = [];
      rowsByDestination[key].push(item);
    });
    Object.keys(rowsByDestination).forEach(function(key) {
      if (rowsByDestination[key].length > 1) {
        rowsByDestination[key].forEach(function(item) {
          partnerBatchFail_(result, item, 'DESTINATION_ROW_CONFLICT',
            excludeBatchMessage_('DESTINATION_ROW_CONFLICT'));
        });
      }
    });
    prepared = prepared.filter(function(item) { return !item.failed; });

    var destinationGroups = [];
    var groupByKey = Object.create(null);
    prepared.forEach(function(item) {
      var key = JSON.stringify([String(item.destinationCustomer.destinationSpreadsheetId),
        String(item.destinationCustomer.destinationSheetName)]);
      if (!groupByKey[key]) {
        groupByKey[key] = {key: key, customer: item.destinationCustomer, items: []};
        destinationGroups.push(groupByKey[key]);
      }
      groupByKey[key].items.push(item);
    });
    stats.destinations = destinationGroups.length;

    // 手順 6：転記先ごと（1 つの転記先の失敗で他を止めない。LEASE_CONFLICT だけ全体）。
    var leaseLost = false;
    destinationGroups.forEach(function(group) {
      if (leaseLost) return;
      var index;
      try {
        index = buildIndex(group.customer, {valuesOnly: true});
      } catch (readError) {
        var readCode = String(readError && readError.code || 'DESTINATION_READ_FAILED');
        group.items.forEach(function(item) {
          partnerBatchFail_(result, item, readCode, excludeBatchMessage_(readCode));
        });
        if (readCode === 'LEASE_CONFLICT') leaseLost = true;
        return;
      }
      var clearItems = [];
      var clearRows = [];
      try {
        group.items.forEach(function(item) {
          var decision = excludeBatchClassifyRow_(group.customer, index, item);
          if (decision.kind === 'MISMATCH') {
            partnerBatchFail_(result, item, 'DESTINATION_ROW_MISMATCH',
              excludeBatchMessage_('DESTINATION_ROW_MISMATCH'));
            return;
          }
          if (decision.kind === 'CLEAR') {
            item.destinationRowNumber = decision.rowNumber;
            clearItems.push(item);
            if (clearRows.indexOf(decision.rowNumber) < 0) clearRows.push(decision.rowNumber);
          } else if (decision.kind === 'ALREADY_CLEARED') {
            stats.alreadyCleared += 1;
          } else if (decision.kind === 'NO_ROW') {
            stats.noRow += 1;
          }
        });

        if (clearRows.length) {
          clearTransactionRows(group.customer, clearRows, leaseId, fileId);
          var verified = verifyWrittenValues(group.customer, clearRows.map(function(rowNumber) {
            return {rowNumber: rowNumber, fullTxId: null,
              values: excludeBatchEmptyValues_(group.customer)};
          }));
          var byRow = Object.create(null);
          verified.forEach(function(entry) { byRow[entry.rowNumber] = entry; });
          clearItems.forEach(function(item) {
            var check = byRow[item.destinationRowNumber];
            if (!check || !check.ok) {
              // 値が残った行の取引は `CANCELED` にしない。
              partnerBatchFail_(result, item, 'DESTINATION_VALUE_MISMATCH',
                excludeBatchMessage_('DESTINATION_VALUE_MISMATCH'));
            } else {
              stats.rowsCleared += 1;
            }
          });
        }
      } catch (writeError) {
        var writeCode = String(writeError && writeError.code || 'WRITE_FAILED');
        group.items.forEach(function(item) {
          partnerBatchFail_(result, item, writeCode, excludeBatchMessage_(writeCode));
        });
        if (writeCode === 'LEASE_CONFLICT') leaseLost = true;
      }
    });

    if (leaseLost) {
      prepared.forEach(function(item) {
        partnerBatchFail_(result, item, 'LEASE_CONFLICT',
          excludeBatchMessage_('LEASE_CONFLICT'));
      });
    }

    var ready = leaseLost ? [] : prepared.filter(function(item) {
      return !item.failed;
    });

    // 手順 7：取引ログ・要確認・監査を 1 つのロックの中で、この順に書く。
    if (ready.length) {
      withScriptLock_(function() {
        var current = allReviewRecordsAndAuditTail_();
        followUpReviews = current.reviews;
        var currentById = Object.create(null);
        current.reviews.forEach(function(review) {
          if (!Object.prototype.hasOwnProperty.call(currentById, review.reviewId)) {
            currentById[review.reviewId] = review;
          }
        });
        var txById = partnerBatchReadTransactions_(ready);
        var openNow = [];
        ready.forEach(function(item) {
          var review = currentById[item.reviewId];
          if (!review || (review.status !== 'OPEN' && review.status !== 'IN_PROGRESS')) {
            partnerBatchFail_(result, item, 'ALREADY_SETTLED',
              excludeBatchMessage_('ALREADY_SETTLED'));
            return;
          }
          var tx = txById[String(item.review.fullTxId)];
          if (!tx || tx.active !== true || tx.transactionStatus !== item.from) {
            partnerBatchFail_(result, item, 'CONCURRENT_CHANGE',
              excludeBatchMessage_('CONCURRENT_CHANGE'));
            return;
          }
          openNow.push({item: item, review: review, tx: tx});
        });
        if (!openNow.length) return;

        var now = nowIso_();
        var sheetName = transactionLogSheet_().getName();
        var txData = [];
        openNow.forEach(function(entry) {
          // J（10）＝CANCELED、AS（45）＝日時。L 列には絶対に書かない。
          partnerBatchAppendRanges_(txData, sheetName, entry.tx._rowNumber, 10, 10,
            [TX_STATUS.CANCELED]);
          partnerBatchAppendRanges_(txData, sheetName, entry.tx._rowNumber, 45, 45, [now]);
        });
        for (var start = 0; start < txData.length; start += SETTLE_BATCH_RANGES_) {
          Sheets.Spreadsheets.Values.batchUpdate({valueInputOption: 'RAW',
            data: txData.slice(start, start + SETTLE_BATCH_RANGES_)},
          masterSpreadsheet_().getId());
        }

        var reviewSheet = reviewSheet_();
        var reviewWrites = [];
        openNow.forEach(function(entry) {
          var rowNumber = entry.review._rowNumber;
          var detail = entry.review.detail ? jsonCell_(entry.review.detail, {}) : {};
          var merged = Object.assign({}, detail, {previousStatus: entry.item.from});
          reviewWrites.push({range: a1Range_(reviewSheet.getName(), rowNumber, 2, 2),
            values: [['EXCLUDED']]});
          reviewWrites.push({range: a1Range_(reviewSheet.getName(), rowNumber, 28, 30),
            values: [[options.actor, now, entry.item.operation]]});
          if (options.role) {
            reviewWrites.push({range: a1Range_(reviewSheet.getName(), rowNumber, 31, 31),
              values: [[String(options.role)]]});
          }
          reviewWrites.push({range: a1Range_(reviewSheet.getName(), rowNumber, 26, 26),
            values: [[JSON.stringify(merged)]]});
          reviewWrites.push({range: a1Range_(reviewSheet.getName(), rowNumber, 32, 32),
            values: [[REVIEW_EXCLUDE_REASON.REVIEWER_JUDGEMENT]]});
        });
        Sheets.Spreadsheets.Values.batchUpdate({valueInputOption: 'RAW', data: reviewWrites},
          masterSpreadsheet_().getId());

        appendAuditRowsUnlocked_(openNow.map(function(entry) {
          return {type: 'REVIEW_RESOLVE', actor: options.actor,
            targetType: 'TRANSACTION', targetId: entry.item.review.fullTxId,
            before: {transactionStatus: entry.item.from},
            after: {transactionStatus: TX_STATUS.CANCELED,
              excludeReason: REVIEW_EXCLUDE_REASON.REVIEWER_JUDGEMENT}};
        }), current.auditTail);

        openNow.forEach(function(entry) {
          closedReviewIds[String(entry.item.reviewId)] = true;
          canceledTxIds[String(entry.item.review.fullTxId)] = true;
          result.resolvedReviewIds.push(entry.item.reviewId);
        });
      });
    }
  } finally {
    releaseLeaseById(leaseId, 'RESOLVE_DONE');
  }

  return finish();
}

'use strict';

/**
 * 取引先の要確認（`PARTNER`）を、1 つのファイルの分だけまとめて確定する
 * （`work/spec_partner_batch_resolution.md`）。
 *
 * **1 件ずつの `resolveReview`（51）は 1 件で読取枠を 20 回前後使う。**
 * 要確認シート・取引ログ・リース表を、件ごとに・段ごとに読み直すからである。
 * 枠は 60 回/分/ユーザーで引き上げられないので、1 分に 3 件しか確定できず、
 * 新しいカードの初回取込で立つ 250 件を採用すると読取の待ちだけで 80 分を超える。
 * ここでは同じ表を 1 まとまりに 1 回ずつ読み、書込もまとめる ── 読取は件数に
 * 依らず 1 まとまり 13〜15 回である。
 *
 * **結果は 1 件ずつ確定したときと同じでなければならない**（転記先の F・I 列、
 * 取引ログ、要確認行、辞書、監査）。違ってよい点は仕様書 §2.4 に挙げたものだけ。
 */

/** 1 まとまりに入れる件数の上限。超えた分は手を付けずに返す（呼出し側が次へ回す）。 */
var PARTNER_BATCH_MAX_ITEMS_ = 100;
/** 時間の門の見積もりの床と係数（取込の門 `fileStartGate` と同じ考え方）。 */
var PARTNER_BATCH_FLOOR_MS_ = 60000;
var PARTNER_BATCH_FACTOR_ = 2;

/** 門の時計。テストが差し替える。 */
function partnerBatchClockNow_() {
  return Date.now();
}

/**
 * 次のまとまりを始めてよいか。
 *
 * **6 分の実行上限で殺されると、ファイルのリースが残る。**残ったリースは
 * 強制解放の閾値（10 分）までそのファイルの確定を全部止める ── 2026-09-16、
 * 締切を見ない自動採用が実際にこれで 2 回に割れた。だから始める前に、
 * これまでで一番重かったまとまり（**直前の 1 つではない**。重いファイルの後に
 * 軽いファイルが来ても見積もりを軽くしない）の 2 倍、ただし最低 60 秒の 2 倍が
 * 締切までに収まるときだけ始める。最初のまとまりも床で見積もる。
 */
function partnerBatchMayStart_(gate) {
  var predicted = Math.max(Number(gate.floorMs) || 0, Number(gate.maxBatchMs) || 0);
  return (partnerBatchClockNow_() - Number(gate.startedAt)) +
    Number(gate.factor) * predicted <= Number(gate.deadlineMs);
}

function partnerBatchMessage_(code) {
  var messages = {
    DUPLICATE_DECISION: '同じ要確認が複数回指定されています。',
    REVIEW_NOT_FOUND: '要確認が見つかりません。',
    REVIEW_CUSTOMER_MISMATCH: '指定された顧客と要確認が一致しません。',
    REVIEW_FILE_MISMATCH: '指定されたファイルと要確認が一致しません。',
    ALREADY_SETTLED: 'この要確認はすでに処理されています。',
    OPERATION_NOT_OFFERED: 'この要確認では指定の操作を選べません。',
    INVALID_PARTNER_NAME: '取引先名を確認してください。',
    LEARN_PRECONDITION: '取引先を学習できないため、確定できません。',
    TX_NOT_FOUND: '取引情報が見つかりません。',
    TRANSACTION_LOG_AMBIGUOUS: '取引情報が重複しています。',
    STATE_TRANSITION: 'この取引は現在の状態では確定できません。',
    DESTINATION_ROW_MISSING: '転記先の行を特定できません。',
    DESTINATION_ROW_CONFLICT: '複数の要確認が同じ転記行を指しています。',
    DESTINATION_VALUE_MISMATCH: '転記先の読み返し値が一致しません。',
    CONCURRENT_CHANGE: '処理中に取引情報が変更されました。',
    LEASE_CONFLICT: '他の処理がこのファイルを使用しています。',
    LEARN_FAILED: '辞書への学習に失敗しました。',
    WRITE_FAILED: '転記先への書き込みに失敗しました。'
  };
  return messages[String(code)] || 'この要確認を処理できませんでした。';
}

/**
 * 件を失敗にする。**印は件（決定 1 つ）に付け、要確認 ID には付けない。**
 *
 * 同じ要確認が 2 回渡されたとき、2 回目の `DUPLICATE_DECISION` を ID で
 * 記録すると、1 回目まで「失敗した件」として後の段から外れ、確定も失敗の
 * 報告もされないまま消える ── 勘定の恒等式が 1 件ぶん合わなくなる
 * （2026-10-03 の監査で見つけた）。同じ件に 2 つ目の理由は積まない。
 */
function partnerBatchFail_(result, item, code) {
  if (item.failed) return;
  item.failed = String(code || 'WRITE_FAILED');
  result.errors.push({reviewId: item.reviewId, code: item.failed,
    message: partnerBatchMessage_(item.failed)});
}

function partnerBatchRecord_(record) {
  return txLogFromRecord_(record);
}

function partnerBatchReadTransactions_(items) {
  var ids = [];
  var rowNumbers = [];
  items.forEach(function(item) {
    var id = String(item.review.fullTxId || '');
    if (ids.indexOf(id) >= 0) return;
    ids.push(id);
    rowNumbers.push(item.tx._rowNumber);
  });
  var records = readRowsByNumbers_(transactionLogSheet_(), rowNumbers, 1, ids,
    TRANSACTION_LOG_WIDTH_);
  if (!records) return activeTransactionRecordsByIds_(ids);
  var byId = Object.create(null);
  records.forEach(function(record) {
    var tx = partnerBatchRecord_(record);
    if (tx.active) byId[tx.fullTxId] = tx;
  });
  return byId;
}

function partnerBatchAppendRanges_(data, sheetName, rowNumber, firstColumn, lastColumn, values) {
  data.push({range: a1Range_(sheetName, rowNumber, firstColumn, lastColumn),
    values: [values]});
}

function partnerBatchCommitBlocking_(tx, openReviewsForTx) {
  return commitBlockingReasons_({
    hasOpenReview: openReviewsForTx.length > 0,
    plannedB: tx.planned && tx.planned.b,
    partnerResolutionStatus: tx.partnerResolutionStatus
  });
}

/**
 * 1 ファイルの取引先の要確認をまとめて確定する。
 *
 * 呼出し側の誤り（操作コード・`learn` の明示漏れなど）は何も読まずに
 * `TypeError` を投げる。データの状態による失敗は件ごとの `errors` に積み、
 * 他の件を止めない。`decisions` の 1 件は必ず、確定・`errors`・リースで
 * 見送り・上限で未着手のどれか 1 つだけに入る（呼出し側の画面と自動採用が
 * 「どの件が片付いたか」をこれで判定する）。
 *
 * **段の順序を変えてはならない**（仕様書 §2.3）。転記先へ書いて読み返す →
 * 取引ログ → 辞書 → 要確認・監査・確定の順にしてあるので、どこで殺されても
 * 同じまとまりをもう一度呼べば同じ値を書き直して先へ進む。確定（J 列）を
 * 要確認より先に書くと「`COMMITTED` なのに要確認が `OPEN`」が残る。
 */
function resolvePartnerReviewsBatch(customerId, fileId, decisions, options) {
  var startedAt = partnerBatchClockNow_();
  var readsAtStart = apiReadCount_;
  var operations = ['ADOPT_EXISTING_PARTNER', 'RESOLVE_WITHOUT_PARTNER',
    'RESOLVE_PARTNER_UNKNOWN'];

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
    if (operations.indexOf(decision.operation) < 0) {
      throw new TypeError('unsupported partner resolution operation');
    }
    if (decision.operation === 'ADOPT_EXISTING_PARTNER') {
      if (typeof decision.partnerName !== 'string') {
        throw new TypeError('ADOPT_EXISTING_PARTNER requires partnerName');
      }
      if (typeof decision.learn !== 'boolean') {
        throw new TypeError('ADOPT_EXISTING_PARTNER requires an explicit learn boolean');
      }
    }
  });

  var result = {
    runId: generateId('RB'), fileId: fileId, customerId: customerId,
    resolvedReviewIds: [], committedReviewIds: [], unmet: [], errors: [],
    skippedByLeaseReviewIds: [], notAttemptedReviewIds: [], leaseConflict: null,
    learnedDictIds: [], ms: 0, reads: 0
  };
  var logStats = {items: decisions.length, destinations: 0};
  function finish() {
    result.ms = partnerBatchClockNow_() - startedAt;
    result.reads = apiReadCount_ - readsAtStart;
    Logger.log('PARTNER_BATCH ' + JSON.stringify({runId: result.runId, fileId: fileId,
      items: logStats.items, resolved: result.resolvedReviewIds.length,
      committed: result.committedReviewIds.length, errors: result.errors.length,
      skippedByLease: result.skippedByLeaseReviewIds.length,
      notAttempted: result.notAttemptedReviewIds.length,
      destinations: logStats.destinations, ms: result.ms, reads: result.reads}));
    return result;
  }

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
        message: partnerBatchMessage_('DUPLICATE_DECISION')});
      return;
    }
    seenReviewIds[reviewId] = true;
    selected.push({decision: decision, reviewId: reviewId, failed: null});
  });

  var customer = options.customer || getCustomerById(customerId);
  var reviews = allReviewRecords_();
  var reviewsById = Object.create(null);
  reviews.forEach(function(review) {
    if (!Object.prototype.hasOwnProperty.call(reviewsById, review.reviewId)) {
      reviewsById[review.reviewId] = review;
    }
  });
  var eligible = [];
  selected.forEach(function(item) {
    var review = reviewsById[item.reviewId];
    var decision = item.decision;
    var code = null;
    if (!review) code = 'REVIEW_NOT_FOUND';
    else if (String(review.customerId || '') !== customerId) code = 'REVIEW_CUSTOMER_MISMATCH';
    else if (String(review.fileId || '') !== fileId) code = 'REVIEW_FILE_MISMATCH';
    else if (review.status !== 'OPEN' && review.status !== 'IN_PROGRESS') code = 'ALREADY_SETTLED';
    else if (availableResolveOperations(review.reviewType).indexOf(decision.operation) < 0) {
      code = 'OPERATION_NOT_OFFERED';
    } else if (decision.operation === 'ADOPT_EXISTING_PARTNER' &&
        (!decision.partnerName.trim() || isPartnerUnknownLabel(decision.partnerName))) {
      code = 'INVALID_PARTNER_NAME';
    } else if (decision.operation === 'ADOPT_EXISTING_PARTNER' && decision.learn === true &&
        (!review.merchantNormalized ||
         normalizeMerchant(review.merchantOriginal) !== String(review.merchantNormalized))) {
      code = 'LEARN_PRECONDITION';
    }
    if (code) {
      partnerBatchFail_(result, item, code);
      return;
    }
    item.review = review;
    eligible.push(item);
  });

  if (!eligible.length) return finish();

  // **`RESOLVE_WITHOUT_PARTNER` だけのまとまりでもリースを取る。**1 件ずつの経路は
  // この操作でリースを取らず、画面が事前にリース表を見るだけが守りだった。
  // まとめる以上ファイル単位で 1 回取るほうが安全で、読取も 1 回で済む。
  var leaseId;
  try {
    leaseId = acquireLease(customerId, fileId, result.runId, options.actor,
      LEASE_PURPOSE.WRITE_ONLY);
  } catch (error) {
    if (String(error && error.code || '') !== 'LEASE_CONFLICT') throw error;
    eligible.forEach(function(item) { result.skippedByLeaseReviewIds.push(item.reviewId); });
    result.leaseConflict = {message: partnerBatchMessage_('LEASE_CONFLICT')};
    return finish();
  }

  try {
    var fileTransactions = getTransactionsForFile_(fileId);
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
      // 取り消し・除外で空けた行へ F・I 列を書くと、帳簿に居ない取引の行が
      // 転記先に残る（幽霊行）。1 件ずつの自動採用はこれを見ていなかった。
      if (!code && item.decision.operation !== 'RESOLVE_WITHOUT_PARTNER' &&
          tx.transactionStatus !== TX_STATUS.REVIEW_REQUIRED &&
          tx.transactionStatus !== TX_STATUS.COMMITTED) code = 'STATE_TRANSITION';
      if (!code && item.decision.operation !== 'RESOLVE_WITHOUT_PARTNER' &&
          (!Number.isInteger(Number(tx.destinationRow)) || Number(tx.destinationRow) < 1 ||
           tx.destinationRow === '' || tx.destinationRow === null || tx.destinationRow === undefined)) {
        code = 'DESTINATION_ROW_MISSING';
      }
      if (code) {
        partnerBatchFail_(result, item, code);
        return;
      }

      var planned = tx.planned;
      var columns = [];
      if (item.decision.operation === 'ADOPT_EXISTING_PARTNER') {
        planned = Object.assign({}, tx.planned, {f: item.decision.partnerName});
        columns = ['f'];
      } else if (item.decision.operation === 'RESOLVE_PARTNER_UNKNOWN') {
        planned = Object.assign({}, tx.planned, {i: appendMemoTag(
          tx.planned && tx.planned.i, MEMO_TAG_PARTNER_UNKNOWN_)});
        columns = ['i'];
      }
      var destinationCustomer = columns.length ? reviewWriteCustomer_(item.review, customer) : null;
      var rowWrite = columns.length ? buildRowWrite(Number(tx.destinationRow), {
        fullTxId: tx.fullTxId, planned: planned, columns: columns
      }) : null;
      prepared.push(Object.assign(item, {tx: tx, planned: planned,
        destinationCustomer: destinationCustomer, rowWrite: rowWrite, verified: null}));
    });

    // 2 つの要確認が同じ転記行を指すのは取引ログの壊れである。どちらの値が
    // 残るかが書く順で決まってしまうので、両方とも書かずに人へ返す。
    var rowGroups = [];
    var rowsByDestination = Object.create(null);
    prepared.forEach(function(item) {
      if (!item.rowWrite) return;
      var key = JSON.stringify([String(item.destinationCustomer.destinationSpreadsheetId),
        String(item.destinationCustomer.destinationSheetName), Number(item.rowWrite.rowNumber)]);
      if (!rowsByDestination[key]) rowsByDestination[key] = [];
      rowsByDestination[key].push(item);
    });
    Object.keys(rowsByDestination).forEach(function(key) {
      if (rowsByDestination[key].length > 1) {
        rowsByDestination[key].forEach(function(item) {
          partnerBatchFail_(result, item, 'DESTINATION_ROW_CONFLICT');
        });
      }
    });

    prepared = prepared.filter(function(item) {
      return !item.failed;
    });
    prepared.forEach(function(item) {
      if (!item.rowWrite) return;
      var key = JSON.stringify([String(item.destinationCustomer.destinationSpreadsheetId),
        String(item.destinationCustomer.destinationSheetName)]);
      var group = rowGroups.filter(function(candidate) { return candidate.key === key; })[0];
      if (!group) {
        group = {key: key, customer: item.destinationCustomer, items: []};
        rowGroups.push(group);
      }
      group.items.push(item);
    });
    logStats.destinations = rowGroups.length;

    var leaseLost = false;
    rowGroups.forEach(function(group) {
      if (leaseLost) return;
      var rowWrites = group.items.map(function(item) { return item.rowWrite; });
      try {
        applyPlainTextFormat(group.customer, rowWrites.map(function(write) { return write.rowNumber; }));
        writeTransactionRows(group.customer, rowWrites, leaseId, fileId);
        var verified = verifyWrittenValues(group.customer, rowWrites);
        group.items.forEach(function(item, index) {
          if (!verified[index] || !verified[index].ok) {
            partnerBatchFail_(result, item, 'DESTINATION_VALUE_MISMATCH');
          } else {
            item.verified = verified[index].values;
          }
        });
      } catch (error) {
        var code = String(error && error.code || 'WRITE_FAILED');
        group.items.forEach(function(item) { partnerBatchFail_(result, item, code); });
        if (code === 'LEASE_CONFLICT') leaseLost = true;
      }
    });

    if (leaseLost) {
      prepared.forEach(function(item) {
        partnerBatchFail_(result, item, 'LEASE_CONFLICT');
      });
    }

    var ready = leaseLost ? [] : prepared.filter(function(item) {
      return !item.failed;
    });
    // 取引ログは**位置で読み直して鍵を検算してから**、自分の列だけを 1 回で書く。
    // リースを持つあいだこのファイルの取引ログを書く経路は他に無いが、行が
    // 動いていないことは確かめる（外れたら鍵列の走査へ落ちる）。
    if (ready.length) {
      withScriptLock_(function() {
        var currentById = partnerBatchReadTransactions_(ready);
        var updates = [];
        ready.forEach(function(item) {
          var tx = currentById[String(item.review.fullTxId)];
          if (!tx || tx.active !== true) {
            partnerBatchFail_(result, item, 'CONCURRENT_CHANGE');
            return;
          }
          var status = item.decision.operation === 'ADOPT_EXISTING_PARTNER' ?
            PARTNER_STATUS.RESOLVED_WITH_PARTNER : PARTNER_STATUS.RESOLVED_WITHOUT_PARTNER;
          updates.push({item: item, tx: tx, status: status});
        });
        var sheet = transactionLogSheet_();
        var now = nowIso_();
        var data = [];
        updates.forEach(function(update) {
          var item = update.item;
          var rowNumber = update.tx._rowNumber;
          if (item.rowWrite) {
            partnerBatchAppendRanges_(data, sheet.getName(), rowNumber, 19, 28,
              plannedVerifiedArray_(item.planned).concat(plannedVerifiedArray_(item.verified)));
            partnerBatchAppendRanges_(data, sheet.getName(), rowNumber, 46, 47,
              [taxCategoryCell_(item.planned), taxCategoryCell_(item.verified)]);
          }
          partnerBatchAppendRanges_(data, sheet.getName(), rowNumber, 12, 12, [update.status]);
          partnerBatchAppendRanges_(data, sheet.getName(), rowNumber, 45, 45, [now]);
        });
        for (var start = 0; start < data.length; start += SETTLE_BATCH_RANGES_) {
          Sheets.Spreadsheets.Values.batchUpdate({valueInputOption: 'RAW',
            data: data.slice(start, start + SETTLE_BATCH_RANGES_)}, masterSpreadsheet_().getId());
        }
        ready = updates.map(function(update) {
          update.item.currentTx = update.tx;
          update.item.partnerResolutionStatus = update.status;
          return update.item;
        });
      });
    }

    var learningItems = ready.filter(function(item) {
      return item.decision.operation === 'ADOPT_EXISTING_PARTNER' && item.decision.learn === true;
    });
    if (learningItems.length) {
      try {
        var learned = learnFromResolutionBatch(customerId, learningItems.map(function(item) {
          return {original: item.review.merchantOriginal,
            normalized: item.review.merchantNormalized,
            partnerName: item.decision.partnerName};
        }), options.actor);
        (learned.addedDictIds || []).forEach(function(dictId) {
          if (result.learnedDictIds.indexOf(dictId) < 0) result.learnedDictIds.push(dictId);
        });
      } catch (error) {
        learningItems.forEach(function(item) { partnerBatchFail_(result, item, 'LEARN_FAILED'); });
      }
    }

    ready = ready.filter(function(item) {
      return !item.failed;
    });
    // 要確認・監査・確定は 1 つのロックの中で、この順に書く。確定の判定は
    // ロックの中で読んだ要確認を材料にする ── 同じ取引に `DATE` などの別の
    // 要確認が開いていれば確定しない（`commitBlockingReasons_` が唯一の判定器）。
    if (ready.length) withScriptLock_(function() {
      var currentReviews = allReviewRecords_();
      var reviewById = Object.create(null);
      currentReviews.forEach(function(review) { reviewById[review.reviewId] = review; });
      var openNow = [];
      ready.forEach(function(item) {
        var current = reviewById[item.reviewId];
        if (!current || (current.status !== 'OPEN' && current.status !== 'IN_PROGRESS')) {
          partnerBatchFail_(result, item, 'ALREADY_SETTLED');
        } else {
          openNow.push(item);
        }
      });

      var reviewSheet = reviewSheet_();
      var now = nowIso_();
      var reviewWrites = [];
      openNow.forEach(function(item) {
        var rowNumber = reviewById[item.reviewId]._rowNumber;
        var operation = item.decision.operation;
        reviewWrites.push({range: a1Range_(reviewSheet.getName(), rowNumber, 2, 2),
          values: [['RESOLVED']]});
        reviewWrites.push({range: a1Range_(reviewSheet.getName(), rowNumber, 28, 30),
          values: [[options.actor, now, operation]]});
        reviewWrites.push({range: a1Range_(reviewSheet.getName(), rowNumber, 32, 32), values: [['']]});
        if (operation === 'ADOPT_EXISTING_PARTNER') {
          reviewWrites.push({range: a1Range_(reviewSheet.getName(), rowNumber, 18, 18),
            values: [[item.decision.partnerName]]});
        }
      });
      if (reviewWrites.length) {
        Sheets.Spreadsheets.Values.batchUpdate({valueInputOption: 'RAW', data: reviewWrites},
          masterSpreadsheet_().getId());
      }
      appendAuditRowsUnlocked_(openNow.map(function(item) {
        return {type: 'REVIEW_RESOLVE', actor: options.actor, targetType: 'TRANSACTION',
          targetId: item.review.fullTxId, after: {operation: item.decision.operation}};
      }));

      var txById = partnerBatchReadTransactions_(openNow);
      var commitUpdates = [];
      openNow.forEach(function(item) {
        var tx = txById[String(item.review.fullTxId)];
        if (!tx || tx.active !== true) {
          partnerBatchFail_(result, item, 'CONCURRENT_CHANGE');
          return;
        }
        var openForTx = currentReviews.filter(function(review) {
          return String(review.fullTxId || '') === String(item.review.fullTxId) &&
            (review.status === 'OPEN' || review.status === 'IN_PROGRESS') &&
            !openNow.some(function(closed) { return closed.reviewId === review.reviewId; });
        });
        var reasons = partnerBatchCommitBlocking_(tx, openForTx);
        var unmetConditions = [];
        if (tx.transactionStatus !== TX_STATUS.REVIEW_REQUIRED) {
          unmetConditions = ['NOT_REVIEW_REQUIRED'];
        } else if (reasons.length) {
          unmetConditions = reasons;
        } else {
          var allowed = ALLOWED_TX_TRANSITIONS[String(tx.transactionStatus)] || [];
          if (allowed.indexOf(TX_STATUS.COMMITTED) < 0) {
            partnerBatchFail_(result, item, 'STATE_TRANSITION');
            return;
          }
          commitUpdates.push({item: item, tx: tx});
        }
        if (unmetConditions.length) {
          result.unmet.push({reviewId: item.reviewId, unmetConditions: unmetConditions,
            openReviewTypes: openForTx.map(function(review) { return review.reviewType; }),
            transactionStatus: tx.transactionStatus});
        }
      });

      if (commitUpdates.length) {
        var commitNow = nowIso_();
        var commitData = commitUpdates.reduce(function(data, update) {
          partnerBatchAppendRanges_(data, transactionLogSheet_().getName(),
            update.tx._rowNumber, 10, 10, [TX_STATUS.COMMITTED]);
          partnerBatchAppendRanges_(data, transactionLogSheet_().getName(),
            update.tx._rowNumber, 45, 45, [commitNow]);
          return data;
        }, []);
        Sheets.Spreadsheets.Values.batchUpdate({valueInputOption: 'RAW', data: commitData},
          masterSpreadsheet_().getId());
      }

      openNow.forEach(function(item) {
        if (item.failed) return;
        result.resolvedReviewIds.push(item.reviewId);
      });
      commitUpdates.forEach(function(update) {
        if (update.item.failed) return;
        result.committedReviewIds.push(update.item.reviewId);
      });
    });
  } finally {
    releaseLease(fileId, result.runId, 'RESOLVE_DONE');
  }

  return finish();
}

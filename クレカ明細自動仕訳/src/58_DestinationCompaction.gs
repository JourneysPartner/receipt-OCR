'use strict';

/**
 * 対象外で空いた転記行を、上へ詰める
 * （`work/spec_exclude_row_compaction.md` §2.2・§2.3）。
 *
 * **行は削除しない。**削除すると、残高のように前の行を指す式が `#REF!` に
 * なる。動かすのはシステムが書く列（取引 ID・B・F・I・K・M、列対応に
 * L・C・G）だけで、雛形の数式・既定値の列と科目一覧には触れない。
 *
 * **安全に詰められないときは詰めない。**手で直した跡・取引 ID の無い行・
 * 取引ログとの食い違いなどがあれば、転記先・取引ログ・要確認に何も書かずに
 * 理由を返す（例外にしない）。対象外そのものは呼出し側で済んでいる。
 *
 * **印を書いてから動かす。**転記先と取引ログは別のスプレッドシートなので
 * 同時に書けない。動かした後・取引ログの行番号を直す前に止まると、取引ログの
 * AE が別の取引の行を指す。印（Script Properties）が残る間は、その顧客の
 * 転記先への書込を `assertLeaseHeldForWrite` の門で全部止め、次の Web アプリの
 * 呼出しの頭で取引 ID の位置から直す（§2.3・§2.4）。
 */

/** 印のキー。同時に 1 つだけ（ロックの中で書くので重ならない）。 */
var DESTINATION_COMPACTION_MARKER_KEY_ = 'DESTINATION_COMPACTION_PENDING';

/** 1 回の `Spreadsheets.batchUpdate` に載せる要求の上限（§2.2.2）。 */
var DESTINATION_COMPACTION_MAX_REQUESTS_ = 5000;

/** 門（`assertLeaseHeldForWrite`）が返す文。 */
var DESTINATION_COMPACTION_GATE_TEXT_ =
  '転記先の行を詰める処理が途中で止まっています。画面を開き直してから（F5）、' +
  'もう一度押してください。続くときは管理者へ連絡してください。';

/** 詰められない理由の文（§2.2.2）。 */
function destinationCompactionReasonText_(code) {
  var messages = {
    UNKNOWN_ROW_CONTENT: '取引 ID の無い行（手で入れた行など）が間にあります',
    NO_TEMPLATE_ROW_BELOW: '取引の下に空いた雛形の行がありません',
    MANUAL_EDIT: '手で直した跡のある行があります（数式・既定値の列）',
    ROW_LOG_MISMATCH: '転記先の行と取引ログの行番号が合いません',
    LEGACY_LOCATION: '転記先の記録が無い古い取引があります',
    TX_STATE: '取込の途中か、取り消した取引が下にあります',
    FREEE_IMPORTED: 'freee に取り込み済みの取引が下にあります',
    OTHER_LEASE: 'この顧客のほかの処理（取込や確定）が動いています',
    LEASE_LOST: '処理の権利（リース）を失いました',
    TOO_MANY_ROWS: '動かす行が多すぎます',
    COMPACTION_PENDING: '前に行を詰める途中で止まった転記先があります。次の操作のときに直します。続くときは管理者へ連絡してください',
    COMPACTION_FAILED: '転記先を読めないか書けませんでした'
  };
  return messages[String(code)] || null;
}

/**
 * 数式の「形」を作る。行の前に `$` が無い行番号を、`rowNumber` との差に
 * 置き換える（§2.2.4）。例：行 6 の `=N5+L6-M6` と行 7 の `=N6+L7-M7` は
 * どちらも `=N-1+L0-M0` になる。
 *
 * 文字列の中や関数名（`LOG10` など）も置き換わるが、そのときは行ごとに形が
 * 違って `MANUAL_EDIT` になる（詰めない側に倒れる）ので構わない。
 */
function relativeFormula_(formula, rowNumber) {
  var text = formula === null || formula === undefined ? '' : String(formula);
  var row = Number(rowNumber);
  if (!isFinite(row)) return text;
  return text.replace(/(\$?)([A-Z]{1,3})(\$?)([1-9][0-9]*)/g,
    function(match, dollarBeforeColumn, column, dollarBeforeRow, digits) {
      if (dollarBeforeRow === '$') return match;
      return dollarBeforeColumn + column + (Number(digits) - row);
    });
}

/** 1 セルの「形」。数式があれば `F:`、無ければ `V:`（§2.2.4）。 */
function destinationCellShape_(formula, value, rowNumber) {
  var text = formula === null || formula === undefined ? '' : String(formula);
  if (text.charAt(0) === '=') return 'F:' + relativeFormula_(text, rowNumber);
  var cell = value === null || value === undefined ? '' : value;
  return 'V:' + JSON.stringify(cell);
}

/**
 * 印を読む。無ければ `null`。壊れていて読めないときは `{broken: true}`。
 * `PropertiesService` 自体が読めないときは例外のまま（止まる側）。
 */
function readDestinationCompactionMarker_() {
  var raw = PropertiesService.getScriptProperties()
    .getProperty(DESTINATION_COMPACTION_MARKER_KEY_);
  if (raw === null || raw === undefined || String(raw) === '') return null;
  try {
    var parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {broken: true};
    return parsed;
  } catch (error) {
    return {broken: true};
  }
}

function writeDestinationCompactionMarker_(marker) {
  PropertiesService.getScriptProperties().setProperty(
    DESTINATION_COMPACTION_MARKER_KEY_, JSON.stringify(marker));
}

function clearDestinationCompactionMarker_() {
  PropertiesService.getScriptProperties().deleteProperty(DESTINATION_COMPACTION_MARKER_KEY_);
}

/** 行番号の集合を、連続した列のまとまりに分ける（copyPaste の単位）。 */
function destinationColumnGroups_(columns) {
  var sorted = columns.slice().sort(function(a, b) { return a - b; });
  var groups = [];
  sorted.forEach(function(column) {
    var last = groups[groups.length - 1];
    if (last && column === last.end + 1) {
      last.end = column;
      return;
    }
    groups.push({start: column, end: column});
  });
  return groups;
}

function destinationMoveColumns_(customer) {
  var mapping = customer.columnMapping || {};
  var keys = ['txId', 'b', 'f', 'i', 'k', 'm'];
  if (mapping.L) keys.push('l');
  if (mapping.C) keys.push('c');
  if (mapping.G) keys.push('g');
  var columns = [];
  keys.forEach(function(key) {
    var column = writeColumnNumber_(customer, key);
    if (columns.indexOf(column) < 0) columns.push(column);
  });
  return columns.sort(function(a, b) { return a - b; });
}

function destinationCompareColumns_(customer, moveColumns) {
  var mapping = customer.columnMapping || {};
  var excluded = Object.create(null);
  moveColumns.forEach(function(column) { excluded[column] = true; });
  var account = accountListRangeParts_(customer.accountListRange);
  if (account) {
    excluded[account.firstColumn] = true;
    excluded[account.lastColumn] = true;
  }
  var columns = [];
  var lastColumn = Number(customer.rowScanLastColumn);
  for (var column = 1; column <= lastColumn; column += 1) {
    if (!excluded[column]) columns.push(column);
  }
  // 取引 ID 列は必ず動かす列なので、念のため比べる列から外す。
  if (mapping.txId) {
    columns = columns.filter(function(column) { return column !== Number(mapping.txId); });
  }
  return columns;
}

function destinationCellValue_(values, column) {
  if (!values) return undefined;
  return values[Number(column) - 1];
}

function destinationEmpty_(value) {
  return value === '' || value === null || value === undefined;
}

/** 行 r の動かす列（G を除く）がすべて空か。 */
function destinationMoveColumnsClear_(values, moveColumns, gColumn) {
  return moveColumns.every(function(column) {
    if (column === gColumn) return true;
    return destinationEmpty_(destinationCellValue_(values, column));
  });
}

/**
 * 印の転記先で、取引 ID の位置から取引ログの AE・AS と要確認の Y を直し、
 * 印を消す（§2.3）。**ロックを持っている呼出し側から呼ぶ。**
 * 失敗は例外にせず `{ok: false, code}` で返し、印を残す。
 */
function settleDestinationCompaction_(marker, actor) {
  try {
    if (!marker || typeof marker !== 'object' || marker.broken) {
      return {ok: false, code: 'COMPACTION_PENDING'};
    }
    var customerId = String(marker.customerId || '');
    var spreadsheetId = String(marker.spreadsheetId || '');
    var sheetName = String(marker.sheetName || '');
    var firstRow = Number(marker.firstRow);
    var lastRow = Number(marker.lastRow);
    var txCount = Number(marker.txCount);
    if (!customerId || !spreadsheetId || !sheetName ||
        !Number.isInteger(firstRow) || !Number.isInteger(lastRow) ||
        lastRow < firstRow || !Number.isInteger(txCount) || txCount < 0) {
      return {ok: false, code: 'COMPACTION_PENDING'};
    }

    var customer = getCustomerById(customerId);
    var dest = Object.assign({}, customer, {
      destinationSpreadsheetId: spreadsheetId,
      destinationSheetName: sheetName
    });
    var index = buildIndex(dest, {valuesOnly: true, startRow: firstRow, endRow: lastRow});
    var txColumn = Number(dest.columnMapping.txId);
    var rowsById = Object.create(null);
    var ids = [];
    for (var rowNumber = firstRow; rowNumber <= lastRow; rowNumber += 1) {
      var row = getAllValuesByRow(index, rowNumber) || [];
      var txId = row[txColumn - 1];
      if (destinationEmpty_(txId)) continue;
      var key = String(txId);
      if (!rowsById[key]) {
        rowsById[key] = [];
        ids.push(key);
      }
      rowsById[key].push(rowNumber);
    }
    // 同じ取引 ID が 2 行以上ある、または数が印と違う ── どこへ直すか決められない。
    if (ids.length !== txCount) return {ok: false, code: 'COMPACTION_PENDING'};
    for (var indexOfId = 0; indexOfId < ids.length; indexOfId += 1) {
      if (rowsById[ids[indexOfId]].length !== 1) {
        return {ok: false, code: 'COMPACTION_PENDING'};
      }
    }

    var records = findRowsByColumnValues_(
      transactionLogSheet_(), 1, ids, TRANSACTION_LOG_WIDTH_);
    var txById = Object.create(null);
    for (indexOfId = 0; indexOfId < ids.length; indexOfId += 1) {
      var matches = (records[ids[indexOfId]] || []).map(txLogFromRecord_)
        .filter(function(tx) { return tx.active === true; });
      if (matches.length !== 1) return {ok: false, code: 'COMPACTION_PENDING'};
      var recorded = recordedDestinationOf_(matches[0], dest);
      if (!recorded || recorded.spreadsheetId !== spreadsheetId ||
          recorded.sheetName !== sheetName) {
        return {ok: false, code: 'COMPACTION_PENDING'};
      }
      txById[ids[indexOfId]] = matches[0];
    }

    var current = allReviewRecordsAndAuditTail_();
    var now = nowIso_();
    var txSheetName = transactionLogSheet_().getName();
    var txData = [];
    var rowsMoved = 0;
    ids.forEach(function(id) {
      var tx = txById[id];
      var targetRow = rowsById[id][0];
      if (Number(tx.destinationRow) === targetRow) return;
      partnerBatchAppendRanges_(txData, txSheetName, tx._rowNumber, 31, 31, [targetRow]);
      partnerBatchAppendRanges_(txData, txSheetName, tx._rowNumber, 45, 45, [now]);
      rowsMoved += 1;
    });
    for (var start = 0; start < txData.length; start += SETTLE_BATCH_RANGES_) {
      Sheets.Spreadsheets.Values.batchUpdate({valueInputOption: 'RAW',
        data: txData.slice(start, start + SETTLE_BATCH_RANGES_)},
      masterSpreadsheet_().getId());
    }

    var reviewSheetName = reviewSheet_().getName();
    var reviewWrites = [];
    var reviewsMoved = 0;
    current.reviews.forEach(function(review) {
      var key = String(review.fullTxId || '');
      if (!review.fullTxId || !rowsById[key]) return;
      if (String(review.destinationSpreadsheetId || '') !== spreadsheetId) return;
      if (String(review.destinationSheetName || '') !== sheetName) return;
      var targetRow = rowsById[key][0];
      if (Number(review.destinationRow) === targetRow) return;
      reviewWrites.push({range: a1Range_(reviewSheetName, review._rowNumber, 25, 25),
        values: [[targetRow]]});
      reviewsMoved += 1;
    });
    if (reviewWrites.length) {
      Sheets.Spreadsheets.Values.batchUpdate({valueInputOption: 'RAW', data: reviewWrites},
        masterSpreadsheet_().getId());
    }

    appendAuditRowsUnlocked_([{
      type: 'DESTINATION_COMPACT', actor: actor || activeUserEmail_(),
      targetType: 'DESTINATION', targetId: marker.runId, customerId: customerId,
      before: {firstRow: firstRow, lastRow: lastRow},
      after: {rowsMoved: rowsMoved, reviewsMoved: reviewsMoved}
    }], current.auditTail);
    clearDestinationCompactionMarker_();

    var positions = Object.create(null);
    ids.forEach(function(id) { positions[id] = rowsById[id][0]; });
    return {ok: true, rowsMoved: rowsMoved, reviewsMoved: reviewsMoved,
      positions: positions};
  } catch (error) {
    return {ok: false, code: String(error && error.code || 'COMPACTION_PENDING')};
  }
}

/**
 * 対象外で空けた転記先の行を上へ詰める（§2.2）。
 *
 * 戻り値は `{compacted, reason, reasonText, gapsClosed, rowsMoved, ms, reads}`。
 * 詰められないことは例外にしない。呼出し側の誤り（引数の型）だけ `TypeError`。
 */
function compactDestinationAfterExclusion_(dest, context) {
  if (!dest || typeof dest !== 'object') {
    throw new TypeError('dest must be a destination customer');
  }
  if (!context || typeof context !== 'object' || !context.leaseId || !context.fileId) {
    throw new TypeError('context must contain leaseId and fileId');
  }

  var startedAt = partnerBatchClockNow_();
  var readsAtStart = apiReadCount_;
  var outcome = {compacted: false, reason: null, reasonText: null,
    gapsClosed: 0, rowsMoved: 0, ms: 0, reads: 0};
  var logFields = {runId: null, firstRow: null, lastRow: null, valueMismatch: false};

  function finish() {
    outcome.ms = partnerBatchClockNow_() - startedAt;
    outcome.reads = apiReadCount_ - readsAtStart;
    // 転記先の ID・取引 ID・店名・ファイル名・金額は出さない。
    Logger.log('DESTINATION_COMPACT ' + JSON.stringify({
      runId: logFields.runId, compacted: outcome.compacted, reason: outcome.reason,
      gapsClosed: outcome.gapsClosed, rowsMoved: outcome.rowsMoved,
      firstRow: logFields.firstRow, lastRow: logFields.lastRow,
      ms: outcome.ms, reads: outcome.reads, valueMismatch: logFields.valueMismatch
    }));
    return outcome;
  }

  function stop(code) {
    outcome.compacted = false;
    outcome.reason = code || null;
    outcome.reasonText = code ? destinationCompactionReasonText_(code) : null;
    return finish();
  }

  try {
    return withScriptLock_(function() {
      // 手順 0：前の印を直す。直せなければ COMPACTION_PENDING。
      var previous = readDestinationCompactionMarker_();
      if (previous) {
        var settledBefore = settleDestinationCompaction_(previous, context.actor);
        if (!settledBefore.ok) return stop('COMPACTION_PENDING');
      }

      // 手順 1：リース。無ければ書かない。
      try {
        assertLeaseHeldForWrite(context.fileId, context.leaseId);
      } catch (leaseError) {
        if (String(leaseError && leaseError.code) === 'DESTINATION_COMPACTION_PENDING') {
          return stop('COMPACTION_PENDING');
        }
        return stop('LEASE_LOST');
      }

      // 手順 2：索引（数式つき）を作り、D・L・F・T を決める。
      var index = buildIndex(dest);
      var dataStartRow = Number(dest.headerRow) + 1;
      var txColumn = writeColumnNumber_(dest, 'txId');
      var moveColumns = destinationMoveColumns_(dest);
      var gColumn = dest.columnMapping && dest.columnMapping.G ?
        Number(dest.columnMapping.G) : null;
      var compareColumns = destinationCompareColumns_(dest, moveColumns);

      var lastTxRow = 0;
      for (var rowNumber = dataStartRow; rowNumber <= index.rangeEnd; rowNumber += 1) {
        var values = getAllValuesByRow(index, rowNumber);
        if (!values) break;
        if (!destinationEmpty_(destinationCellValue_(values, txColumn))) lastTxRow = rowNumber;
      }
      if (!lastTxRow) return stop(null); // 取引の行が無い

      var firstEmptyRow = null;
      var emptyRows = [];
      var unknownRow = null;
      for (rowNumber = dataStartRow; rowNumber <= lastTxRow; rowNumber += 1) {
        values = getAllValuesByRow(index, rowNumber) || [];
        var hasTx = !destinationEmpty_(destinationCellValue_(values, txColumn));
        var moveClear = destinationMoveColumnsClear_(values, moveColumns, gColumn);
        if (!hasTx && moveClear) {
          emptyRows.push(rowNumber);
          if (firstEmptyRow === null) firstEmptyRow = rowNumber;
        } else if (!hasTx && !moveClear) {
          if (unknownRow === null) unknownRow = rowNumber;
        }
      }
      if (firstEmptyRow === null) return stop(null); // 空き行が無い
      if (unknownRow !== null && unknownRow >= firstEmptyRow) {
        return stop('UNKNOWN_ROW_CONTENT');
      }

      var templateRow = lastTxRow + 1;
      if (templateRow > index.rangeEnd || !isRowEmpty(index, templateRow, dest)) {
        return stop('NO_TEMPLATE_ROW_BELOW');
      }

      // 手順 2 の続き：比べる列の「形」を雛形の行と比べる。
      var templateValues = getAllValuesByRow(index, templateRow) || [];
      var templateFormulas = getFormulasByRow(index, templateRow) || [];
      for (rowNumber = firstEmptyRow; rowNumber <= lastTxRow; rowNumber += 1) {
        values = getAllValuesByRow(index, rowNumber) || [];
        var formulas = getFormulasByRow(index, rowNumber) || [];
        for (var columnIndex = 0; columnIndex < compareColumns.length; columnIndex += 1) {
          var column = compareColumns[columnIndex];
          var shape = destinationCellShape_(formulas[column - 1], values[column - 1], rowNumber);
          var templateShape = destinationCellShape_(templateFormulas[column - 1],
            templateValues[column - 1], templateRow);
          if (shape !== templateShape) return stop('MANUAL_EDIT');
        }
      }

      // 動く取引（F より下の取引の行）と空く行。
      var moving = [];
      for (rowNumber = firstEmptyRow + 1; rowNumber <= lastTxRow; rowNumber += 1) {
        values = getAllValuesByRow(index, rowNumber) || [];
        var txId = destinationCellValue_(values, txColumn);
        if (!destinationEmpty_(txId)) moving.push({txId: String(txId), rowNumber: rowNumber});
      }
      var gapsClosed = emptyRows.length;
      if (!moving.length || !gapsClosed) return stop(null);

      // 手順 3：取引ログ全体と要確認を 1 回ずつ読む（§2.2.6）。
      var logTransactions;
      try {
        logTransactions = readSheetRows_(transactionLogSheet_(), TRANSACTION_LOG_WIDTH_)
          .map(txLogFromRecord_);
      } catch (logError) {
        return stop('COMPACTION_FAILED');
      }
      // 要確認は状態を問わず、手順 3〜4 の中でこの 1 回だけ読む（§2.2.6）。
      var reviewRecords;
      try {
        reviewRecords = allReviewRecords_();
      } catch (reviewError) {
        return stop('COMPACTION_FAILED');
      }
      var reviewsByTx = Object.create(null);
      reviewRecords.forEach(function(review) {
        var reviewTxId = String(review.fullTxId || '');
        if (!reviewTxId) return;
        if (!reviewsByTx[reviewTxId]) reviewsByTx[reviewTxId] = [];
        reviewsByTx[reviewTxId].push(review);
      });
      var activeById = Object.create(null);
      logTransactions.forEach(function(tx) {
        if (tx.active !== true) return;
        var key = String(tx.fullTxId);
        if (!activeById[key]) activeById[key] = [];
        activeById[key].push(tx);
      });
      var recordedCustomer = context.customer || dest;
      for (var movingIndex = 0; movingIndex < moving.length; movingIndex += 1) {
        var movingItem = moving[movingIndex];
        var hit = getRowByTxId(index, movingItem.txId);
        if (hit.matchCount !== 1 || Number(hit.rowNumber) !== movingItem.rowNumber) {
          return stop('ROW_LOG_MISMATCH');
        }
        var matches = activeById[movingItem.txId] || [];
        if (matches.length !== 1) return stop('ROW_LOG_MISMATCH');
        var tx = matches[0];
        var recorded = recordedDestinationOf_(tx, recordedCustomer);
        if (!recorded) return stop('LEGACY_LOCATION');
        if (Number(tx.destinationRow) !== movingItem.rowNumber ||
            recorded.spreadsheetId !== String(dest.destinationSpreadsheetId) ||
            recorded.sheetName !== String(dest.destinationSheetName)) {
          return stop('ROW_LOG_MISMATCH');
        }
        if (tx.transactionStatus !== TX_STATUS.COMMITTED &&
            tx.transactionStatus !== TX_STATUS.REVIEW_REQUIRED) {
          return stop('TX_STATE');
        }
        if (tx.freeeStatus === FREEE_IMPORT_STATUS.IMPORTED ||
            tx.freeeStatus === FREEE_IMPORT_STATUS.NEEDS_FREEE_FIX) {
          return stop('FREEE_IMPORTED');
        }
      }

      // §2.2.6：動く取引のほかに F〜L の行を AE で指す生きた取引があれば詰めない。
      // 詰めると、その取引の AE が別の取引の行を指し、次の解決操作がその行を
      // 上書きしてしまう。取引ログと要確認は手順 3 の 1 回の読取を使う。
      var movingRows = Object.create(null);
      moving.forEach(function(item) { movingRows[item.rowNumber] = item.txId; });
      var liveStatuses = Object.create(null);
      liveStatuses[TX_STATUS.PREPARED] = true;
      liveStatuses[TX_STATUS.WRITING] = true;
      liveStatuses[TX_STATUS.COMMITTED] = true;
      liveStatuses[TX_STATUS.REVIEW_REQUIRED] = true;
      // 転記先の記録（AC）も要確認の M 列も無い取引は、転記先が顧客マスターの
      // 雛形と同じときだけ同じ転記先とみなす（旧い行を雛形そのものと取り違えない）。
      var masterSame = Boolean(context.customer) &&
        String(context.customer.destinationSpreadsheetId || '') ===
          String(dest.destinationSpreadsheetId || '') &&
        String(context.customer.destinationSheetName || '') ===
          String(dest.destinationSheetName || '');
      for (var logIndex = 0; logIndex < logTransactions.length; logIndex += 1) {
        var logTx = logTransactions[logIndex];
        if (logTx.active !== true) continue;
        if (!liveStatuses[String(logTx.transactionStatus)]) continue;
        var logRow = Number(logTx.destinationRow);
        if (!(logRow >= firstEmptyRow && logRow <= lastTxRow)) continue;
        var txReviews = reviewsByTx[String(logTx.fullTxId)] || [];
        var recordedLog = recordedDestinationOf_(logTx, recordedCustomer);
        var sameDestination = false;
        if (recordedLog) {
          sameDestination = recordedLog.spreadsheetId ===
              String(dest.destinationSpreadsheetId) &&
            recordedLog.sheetName === String(dest.destinationSheetName);
        }
        if (!sameDestination) {
          // 解決操作は要確認の M・N 列の転記先へも書く（N が空なら M だけで比べる）。
          sameDestination = txReviews.some(function(review) {
            if (destinationEmpty_(review.destinationSpreadsheetId)) return false;
            if (String(review.destinationSpreadsheetId) !==
                String(dest.destinationSpreadsheetId)) return false;
            return destinationEmpty_(review.destinationSheetName) ||
              String(review.destinationSheetName) === String(dest.destinationSheetName);
          });
        }
        if (!sameDestination) {
          var hasReviewDestination = txReviews.some(function(review) {
            return !destinationEmpty_(review.destinationSpreadsheetId);
          });
          sameDestination = !recordedLog && !hasReviewDestination && masterSame &&
            String(logTx.customerId) === String(context.customer.customerId);
        }
        if (!sameDestination) continue;
        if (movingRows[logRow] !== String(logTx.fullTxId)) {
          return stop('ROW_LOG_MISMATCH');
        }
      }

      // 手順 4：この顧客のほかのリース。
      var leases = activeLeases_();
      var otherLease = leases.some(function(lease) {
        return String(lease.customerId) === String(dest.customerId) &&
          String(lease.leaseId) !== String(context.leaseId);
      });
      if (otherLease) return stop('OTHER_LEASE');

      // 手順 5：要求（copyPaste の並び）を作る。
      var groups = destinationColumnGroups_(moveColumns);
      var sheet = requireSheet_(
        SpreadsheetApp.openById(dest.destinationSpreadsheetId), dest.destinationSheetName);
      var sheetId = sheet.getSheetId();
      function gridRange(row, firstColumn, lastColumnNumber) {
        return {sheetId: sheetId, startRowIndex: row - 1, endRowIndex: row,
          startColumnIndex: firstColumn - 1, endColumnIndex: lastColumnNumber};
      }
      function copyPaste(sourceRow, destinationRow, firstColumn, lastColumnNumber) {
        return {copyPaste: {
          source: gridRange(sourceRow, firstColumn, lastColumnNumber),
          destination: gridRange(destinationRow, firstColumn, lastColumnNumber),
          pasteType: 'PASTE_NORMAL', pasteOrientation: 'NORMAL'
        }};
      }
      var requests = [];
      moving.forEach(function(item, offset) {
        var destinationRow = firstEmptyRow + offset;
        groups.forEach(function(group) {
          requests.push(copyPaste(item.rowNumber, destinationRow, group.start, group.end));
        });
      });
      for (rowNumber = firstEmptyRow + moving.length; rowNumber <= lastTxRow; rowNumber += 1) {
        groups.forEach(function(group) {
          requests.push(copyPaste(templateRow, rowNumber, group.start, group.end));
        });
      }
      if (requests.length > DESTINATION_COMPACTION_MAX_REQUESTS_) {
        return stop('TOO_MANY_ROWS');
      }

      // 手順 6：印を書く。
      var runId = generateId('DC');
      var marker = {runId: runId, customerId: String(dest.customerId),
        spreadsheetId: String(dest.destinationSpreadsheetId),
        sheetName: String(dest.destinationSheetName),
        firstRow: firstEmptyRow, lastRow: lastTxRow,
        txCount: moving.length, at: nowIso_()};
      logFields.runId = runId;
      logFields.firstRow = firstEmptyRow;
      logFields.lastRow = lastTxRow;
      writeDestinationCompactionMarker_(marker);

      // 手順 7：1 回の batchUpdate で動かす。
      var moveError = null;
      try {
        Sheets.Spreadsheets.batchUpdate({requests: requests},
          dest.destinationSpreadsheetId);
      } catch (error) {
        moveError = error;
      }
      try {
        faultInjectionPoint('DESTINATION_COMPACT_AFTER_MOVE', {fileId: context.fileId});
      } catch (error) {
        if (!moveError) moveError = error;
      }

      // 手順 8：必ず後始末する（適用されたかは取引 ID の位置で決める）。
      var settled = settleDestinationCompaction_(marker, context.actor);
      if (!settled.ok) return stop('COMPACTION_PENDING');

      // 手順 9：並びを確かめる。
      var after = buildIndex(dest, {valuesOnly: true,
        startRow: firstEmptyRow, endRow: lastTxRow});
      var arranged = true;
      for (var moveIndex = 0; moveIndex < moving.length; moveIndex += 1) {
        var afterRow = getAllValuesByRow(after, firstEmptyRow + moveIndex) || [];
        if (String(destinationCellValue_(afterRow, txColumn)) !== moving[moveIndex].txId) {
          arranged = false;
          break;
        }
      }
      for (rowNumber = firstEmptyRow + moving.length; rowNumber <= lastTxRow; rowNumber += 1) {
        var vacated = getAllValuesByRow(after, rowNumber) || [];
        if (!destinationMoveColumnsClear_(vacated, moveColumns, gColumn)) {
          arranged = false;
          break;
        }
      }
      if (!arranged) return stop('COMPACTION_FAILED');

      outcome.compacted = true;
      outcome.gapsClosed = gapsClosed;
      outcome.rowsMoved = moving.length;

      // 手順 10：値の確かめ。行の位置は取引 ID で直してあるので、食い違いは
      // ログと監査に残すだけ（整合性チェックが手動変更として拾う）。
      var valueMismatch = false;
      for (moveIndex = 0; moveIndex < moving.length && !valueMismatch; moveIndex += 1) {
        var beforeRow = getAllValuesByRow(index, moving[moveIndex].rowNumber) || [];
        var currentRow = getAllValuesByRow(after, firstEmptyRow + moveIndex) || [];
        for (var moveColumnIndex = 0; moveColumnIndex < moveColumns.length; moveColumnIndex += 1) {
          var moveColumn = moveColumns[moveColumnIndex];
          var beforeValue = destinationCellValue_(beforeRow, moveColumn);
          var currentValue = destinationCellValue_(currentRow, moveColumn);
          if (JSON.stringify(destinationEmpty_(beforeValue) ? '' : beforeValue) !==
              JSON.stringify(destinationEmpty_(currentValue) ? '' : currentValue)) {
            valueMismatch = true;
            break;
          }
        }
      }
      if (valueMismatch) {
        outcome.valueMismatch = true;
        logFields.valueMismatch = true;
        try {
          var tail = allReviewRecordsAndAuditTail_().auditTail;
          appendAuditRowsUnlocked_([{
            type: 'DESTINATION_COMPACT_VALUE_MISMATCH',
            actor: context.actor || activeUserEmail_(),
            targetType: 'DESTINATION', targetId: runId,
            customerId: String(dest.customerId),
            before: {firstRow: firstEmptyRow, lastRow: lastTxRow},
            after: {rowsMoved: moving.length}
          }], tail);
        } catch (auditError) {
          // 値の食い違いはログに残っている。監査の失敗で帳簿を止めない。
        }
      }
      return finish();
    });
  } catch (error) {
    if (String(error && error.code) === 'DESTINATION_COMPACTION_PENDING') {
      return stop('COMPACTION_PENDING');
    }
    if (String(error && error.code) === 'LEASE_CONFLICT') return stop('LEASE_LOST');
    return stop('COMPACTION_FAILED');
  }
}

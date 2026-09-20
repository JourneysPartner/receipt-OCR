'use strict';

function destinationRangeValues_(spreadsheetId, range, renderOption) {
  for (var attempt = 1; attempt <= 3; attempt += 1) {
    try {
      // 読取クォータはこの経路ぶんも減る。数えないとペーシングが狂う（01）。
      var response = sheetsBatchGetPaced_(spreadsheetId, {
        ranges: [range], valueRenderOption: renderOption, dateTimeRenderOption: 'SERIAL_NUMBER', majorDimension: 'ROWS'
      });
      return response.valueRanges && response.valueRanges[0] && response.valueRanges[0].values || [];
    } catch (error) {
      var status = Number(error && (error.code || error.status));
      var transientFailure = status === 429 || status === 500 || status === 503 || /(?:429|500|503)/.test(String(error && error.message));
      if (isSheetsQuotaError_(error)) noteSheetsQuotaExceeded_();
      if (!transientFailure) throw error;
      if (attempt === 3) throw makeCatalogError_('TRANSIENT_SHEETS_ERROR', error.message);
      Utilities.sleep(computeBackoffMs(attempt));
    }
  }
  return [];
}

function padDestinationRows_(rows, count, width, formulas) {
  var result = [];
  for (var row = 0; row < count; row += 1) {
    var source = rows[row] || [];
    var padded = [];
    for (var column = 0; column < width; column += 1) {
      var value = source[column] === undefined ? '' : source[column];
      padded.push(formulas ? (typeof value === 'string' && value.charAt(0) === '=' ? value : '') : value);
    }
    result.push(padded);
  }
  return result;
}

function buildIndex(customer, options) {
  options = options || {};
  var spreadsheet = SpreadsheetApp.openById(customer.destinationSpreadsheetId);
  var sheet = requireSheet_(spreadsheet, customer.destinationSheetName);
  var firstRow = Number(options.startRow || options.rangeStart || 1);
  var lastRow = Number(options.endRow || options.rangeEnd || sheet.getMaxRows());
  var lastColumn = Number(customer.rowScanLastColumn);
  if (!Number.isInteger(firstRow) || !Number.isInteger(lastRow) || firstRow < 1 || lastRow < firstRow ||
      !Number.isInteger(lastColumn) || lastColumn < 1) throw new InputLimitError('Invalid destination index range');
  var valuesByRow = new Map(); var formulasByRow = new Map(); var byTxId = new Map();
  var chunkSize = SETTINGS.DESTINATION_INDEX_MAX_ROWS;
  for (var start = firstRow; start <= lastRow; start += chunkSize) {
    var end = Math.min(lastRow, start + chunkSize - 1);
    var range = quoteSheetName_(sheet.getName()) + '!A' + start + ':' + columnLetter_(lastColumn) + end;
    var values = padDestinationRows_(destinationRangeValues_(spreadsheet.getId(), range, 'UNFORMATTED_VALUE'), end - start + 1, lastColumn, false);
    var formulas = padDestinationRows_(destinationRangeValues_(spreadsheet.getId(), range, 'FORMULA'), end - start + 1, lastColumn, true);
    values.forEach(function(rowValues, offset) {
      var rowNumber = start + offset;
      valuesByRow.set(rowNumber, rowValues); formulasByRow.set(rowNumber, formulas[offset]);
      var txId = rowValues[customer.columnMapping.txId - 1];
      if (txId !== '' && txId !== null && txId !== undefined) {
        var key = String(txId); if (!byTxId.has(key)) byTxId.set(key, []); byTxId.get(key).push(rowNumber);
      }
    });
  }
  return {customerId: customer.customerId, spreadsheetId: customer.destinationSpreadsheetId, sheetName: customer.destinationSheetName,
    firstColumn: 1, lastColumn: lastColumn, rangeStart: firstRow, rangeEnd: lastRow, byTxId: byTxId,
    valuesByRow: valuesByRow, formulasByRow: formulasByRow, builtAt: nowIso_(), valid: true};
}

function requireValidDestinationIndex_(index) {
  if (!index || index.valid === false) throw new Error('Destination index is invalid and must be rebuilt');
}

function getRowByTxId(index, fullTxId) {
  requireValidDestinationIndex_(index);
  var rows = index.byTxId.get(String(fullTxId)) || [];
  return {matchCount: rows.length, rowNumber: rows.length === 1 ? rows[0] : null};
}

function getAllValuesByRow(index, rowNumber) {
  requireValidDestinationIndex_(index);
  var row = index.valuesByRow.get(Number(rowNumber));
  return row ? row.slice() : null;
}

function getFormulasByRow(index, rowNumber) {
  requireValidDestinationIndex_(index);
  var row = index.formulasByRow.get(Number(rowNumber));
  return row ? row.slice() : null;
}

function getValuesByRow(index, rowNumber) {
  var row = getAllValuesByRow(index, rowNumber);
  if (!row) return null;
  var customer = index._customer;
  var mapping = customer ? customer.columnMapping : index.columnMapping;
  if (!mapping) throw new TypeError('Destination index has no column mapping');
  return {b: normalizeReadValue('B', row[mapping.B - 1]), f: normalizeReadValue('F', row[mapping.F - 1]),
    i: normalizeReadValue('I', row[mapping.I - 1]), k: normalizeReadValue('K', row[mapping.K - 1]),
    m: normalizeReadValue('M', row[mapping.M - 1]), txId: normalizeReadValue('INTERNAL_TRANSACTION_ID', row[mapping.txId - 1])};
}

function isRowEmpty(index, rowNumber, customer) {
  var values = getAllValuesByRow(index, rowNumber); var formulas = getFormulasByRow(index, rowNumber);
  if (!values || !formulas) throw new RangeError('Row is outside the destination index');
  return isDestinationRowEmpty(values, formulas, customer.rowScanLastColumn,
    customer.rowScanExcludedColumns);
}

function listOccupiedRows(index, customer) {
  requireValidDestinationIndex_(index);
  var result = [];
  index.valuesByRow.forEach(function(_, rowNumber) { if (!isRowEmpty(index, rowNumber, customer)) result.push(rowNumber); });
  return result.sort(function(a, b) { return a - b; });
}

function invalidate(index) {
  if (index) { index.valid = false; index.valuesByRow.clear(); index.formulasByRow.clear(); index.byTxId.clear(); }
}

/**
 * INV-06/27/30を同時に満たす行予約用のデータアクセス補助。
 * 空き行判定、必要なテンプレート複製、ロック内再読取、ID予約を1排他区間で行う。
 */
function reserveDestinationRows(customer, fullTxIds, fileId, leaseId) {
  if (!Array.isArray(fullTxIds) || !fullTxIds.length) return [];
  return withScriptLock_(function() {
    assertLeaseHeldForWrite(fileId, leaseId);
    var index = buildIndex(customer);
    // 空き行判定は 4.23 の`findEmptyRows`に委ねる。ここで同じ走査を書くと、
    // 判定規則が二重になり、片方だけ直す事故が起きる。
    var candidates = findEmptyRows(customer, fullTxIds.length, index);
    var expandedRows = [];
    var spreadsheet = SpreadsheetApp.openById(customer.destinationSpreadsheetId);
    var sheet = requireSheet_(spreadsheet, customer.destinationSheetName);
    // 拡張の要否と行数は4.23の`planTemplateExpansion`が決める。ここで
    // `<`比較を書くと、判断が二重になり片方だけ直す事故が起きる。
    var plan = planTemplateExpansion({
      requiredCount: fullTxIds.length, emptyRowCount: candidates.length
    });
    if (plan.action === 'STOP') {
      throw new StateTransitionError(plan.code + ': template expansion cannot proceed');
    }
    if (plan.action === 'EXPAND') {
      // 複製元は**数式を持つ空き行**（＝本物のテンプレート行）のうち最後の
      // もの。数式の無い空き行を複製しても勘定科目や消費税式は増えない。
      // 該当が無ければ従来どおり最終行に任せ、手順6の停止条件が守る。
      var templateHint = null;
      candidates.forEach(function(rowNumber) {
        var formulas = getFormulasByRow(index, rowNumber) || [];
        if (formulas.some(function(f) { return f; })) templateHint = rowNumber;
      });
      expandedRows = expandTemplateRows(customer, sheet, plan.rowsToAdd, templateHint);
      expandedRows.forEach(function(rowNumber) { candidates.push(rowNumber); });
      index = buildIndex(customer);   // 拡張後の範囲で読み直す
    }
    // 取引IDと行番号の対応を明示して返す。呼出側が「i番目の取引はi番目の
    // 行」という添字一致に頼ると、空き行が非連続に見つかる場合や順序が
    // 変わった場合に、取引が別の行へ紐づいて二重転記になる。
    //
    // 空き確認と予約は**行ごとに往復しない**。1行につき読取2回・書込1回を
    // 素直に回すと、200件のファイルで600往復になり6分の実行上限に当たる
    // （実機で1件あたり約20秒だった。2026-09-03）。候補行を覆う範囲を
    // 一度だけ読み、取引IDは連続行ごとにまとめて書く。
    var reserved = [];
    var firstRow = Math.min.apply(null, candidates);
    var lastRow = Math.max.apply(null, candidates);
    var block = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, customer.rowScanLastColumn);
    var blockValues = block.getValues();
    var blockFormulas = block.getFormulas();
    candidates.forEach(function(rowNumber, offset) {
      var values = blockValues[rowNumber - firstRow];
      var formulas = blockFormulas[rowNumber - firstRow];
      if (!isDestinationRowEmpty(values, formulas, customer.rowScanLastColumn, customer.rowScanExcludedColumns)) throw leaseConflict_('Reserved row is no longer empty');
      reserved.push({txId: String(fullTxIds[offset]), rowNumber: rowNumber});
    });
    groupConsecutiveRows(reserved.slice().sort(function(a, b) {
      return a.rowNumber - b.rowNumber;
    })).forEach(function(group) {
      sheet.getRange(group.startRow, customer.columnMapping.txId, group.rowWrites.length, 1)
        .setValues(group.rowWrites.map(function(item) { return [item.txId]; }));
    });
    // 予約は SpreadsheetApp で書いた。ロックを解放すると、続く書込ブロックが
    // Sheets API で同じ行へ書く。ここで flush しないと予約が相手から見えず、
    // 別の実行が同じ行を空きと判定して二重に予約する（4.23 flush規則1）。
    SpreadsheetApp.flush();
    // 停止点：予約済み・値書込前の状態を作る（11.3 Step4/5 の再現用）。
    faultInjectionPoint('ROW_RESERVE_AFTER', {fileId: fileId});
    invalidate(index);
    return {reserved: reserved, expanded: expandedRows};
  });
}

// Keep the mapping with the index without changing its public data shape materially.
var buildIndexOriginal_ = buildIndex;
buildIndex = function(customer, options) {
  var index = buildIndexOriginal_(customer, options);
  index.columnMapping = customer.columnMapping;
  return index;
};

'use strict';

/** @param {*} value @return {boolean} */
function isParserBlank_(value) {
  return value === null || value === undefined || value === '';
}

/**
 * §5.3の共通有効明細条件。O列の除外判定を最優先する。
 * @param {!Array<*>} row
 * @param {number} dateColumnIndex 0起算
 * @param {number} amountColumnIndex 0起算
 * @param {boolean} excluded
 * @return {boolean}
 */
function isEffectiveDetailRow(row, dateColumnIndex, amountColumnIndex, excluded) {
  if (!Array.isArray(row) || !Number.isInteger(dateColumnIndex) || !Number.isInteger(amountColumnIndex)) {
    throw new TypeError('isEffectiveDetailRow requires a row and column indexes');
  }
  if (excluded) {
    return false;
  }
  return !isParserBlank_(row[dateColumnIndex]) || !isParserBlank_(row[amountColumnIndex]);
}

/** @param {!Array<*>} row @return {boolean} */
function isCompletelyEmptyParserRow_(row) {
  return Array.isArray(row) && row.every(isParserBlank_);
}

/**
 * 既にメモリへ読み込んだ行配列上で§5.3の停止位置を決める。
 * @param {!Array<!Array<*>>} rows
 * @param {!Object} options
 * @return {{reason:string, stopIndex:number, stopRow:number}}
 */
function findReadStop(rows, options) {
  if (!Array.isArray(rows)) {
    throw new TypeError('findReadStop requires rows');
  }
  var settings = options || {};
  var emptyLimit = settings.consecutiveEmptyRowsToStop;
  if (emptyLimit === null || emptyLimit === undefined) {
    emptyLimit = SETTINGS.CONSECUTIVE_EMPTY_ROWS_TO_STOP;
  }
  if (!Number.isInteger(emptyLimit) || emptyLimit <= 0) {
    throw new TypeError('consecutiveEmptyRowsToStop must be a positive integer');
  }
  var totalRows = Object.create(null);
  (settings.totalRowIndexes || []).forEach(function(index) { totalRows[index] = true; });
  var consecutiveEmpty = 0;

  for (var index = 0; index < rows.length; index += 1) {
    if (totalRows[index]) {
      return {reason: 'TOTAL_ROW', stopIndex: index, stopRow: index + 1};
    }
    if (isCompletelyEmptyParserRow_(rows[index])) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= emptyLimit) {
        return {reason: 'EMPTY_RUN', stopIndex: index, stopRow: index + 1};
      }
    } else {
      consecutiveEmpty = 0;
    }
  }
  var lastIndex = rows.length - 1;
  return {
    reason: settings.inputLimitReached ? 'INPUT_LIMIT' : 'END_OF_LOADED_ROWS',
    stopIndex: lastIndex,
    stopRow: lastIndex + 1
  };
}

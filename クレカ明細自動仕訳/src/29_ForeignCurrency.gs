'use strict';

/** @param {string} column @return {number} */
function foreignColumnNumber_(column) {
  var text = String(column || '').toUpperCase();
  if (!/^[A-Z]+$/.test(text)) return -1;
  var result = 0;
  for (var index = 0; index < text.length; index += 1) {
    result = result * 26 + text.charCodeAt(index) - 64;
  }
  return result;
}

/** @param {!Object|!Array<*>} row @param {string} column @return {*} */
function foreignCell_(row, column) {
  if (Array.isArray(row)) return row[foreignColumnNumber_(column) - 1];
  return row ? row[column] : null;
}

/** @param {*} value @return {?number} */
function optionalDecimal_(value) {
  if (value === null || value === undefined || value === '') return null;
  var text = String(value);
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
  var number = Number(text);
  return isFinite(number) ? number : null;
}

/**
 * §5.13。専用列が定義されている値だけを独立に取得する。
 * @param {!Object|!Array<*>} rowValues
 * @param {!Object} cardFormat
 * @param {number} gridWidth
 * @return {!Object}
 */
function extractForeignCurrency(rowValues, cardFormat, gridWidth) {
  var format = cardFormat || {};
  var result = {
    currencyCode: null,
    localAmount: null,
    exchangeRate: null,
    diagnostics: []
  };
  var definitions = [
    {column: format.foreignCurrencyColumn, field: 'currencyCode', numeric: false},
    {column: format.foreignAmountColumn, field: 'localAmount', numeric: true},
    {column: format.exchangeRateColumn, field: 'exchangeRate', numeric: true}
  ];
  definitions.forEach(function(definition) {
    if (!definition.column) return;
    var column = String(definition.column).toUpperCase();
    if (foreignColumnNumber_(column) < 1 || foreignColumnNumber_(column) > Number(gridWidth)) {
      result.diagnostics.push({
        code: 'FOREIGN_CURRENCY_COLUMN_OUT_OF_GRID',
        column: column,
        retryable: false
      });
      return;
    }
    var raw = foreignCell_(rowValues, column);
    if (definition.numeric) {
      result[definition.field] = optionalDecimal_(raw);
    } else if (raw !== null && raw !== undefined && raw !== '') {
      result[definition.field] = String(raw);
    }
  });
  return result;
}

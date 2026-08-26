'use strict';

/** フェーズ2のシートアクセスで共有する最小限の基盤。 */
function masterSpreadsheet_() {
  if (CONFIG.MASTER_SPREADSHEET_ID) return SpreadsheetApp.openById(CONFIG.MASTER_SPREADSHEET_ID);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('MASTER_SPREADSHEET_ID is not configured');
  return active;
}

function requireSheet_(spreadsheet, name) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw new Error('Required sheet not found: ' + name);
  return sheet;
}

function nowIso_() { return toIso8601(new Date()); }

function activeUserEmail_() {
  var user = Session.getActiveUser();
  return user && user.getEmail ? String(user.getEmail() || '') : '';
}

function makeCatalogError_(code, detail) {
  if (typeof CatalogError === 'function') return new CatalogError(code, detail);
  var error = new Error(detail || code);
  error.code = code;
  return error;
}

function leaseConflict_(detail) { return makeCatalogError_('LEASE_CONFLICT', detail); }

function withScriptLock_(callback) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(SETTINGS.LOCK_TIMEOUT_MS)) throw leaseConflict_('Script lock was not acquired');
  try { return callback(); } finally { lock.releaseLock(); }
}

function readSheetRows_(sheet, columns) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, columns).getValues().map(function(values, offset) {
    return {rowNumber: offset + 2, values: values};
  });
}

function findRowsByColumnValue_(sheet, column, value, width) {
  var matches = [];
  if (sheet.createTextFinder) {
    sheet.createTextFinder(String(value)).matchEntireCell(true).matchCase(true).findAll().forEach(function(range) {
      if (range.getColumn() === column && range.getRow() >= 2) matches.push(range.getRow());
    });
  } else {
    var last = sheet.getLastRow();
    if (last >= 2) {
      sheet.getRange(2, column, last - 1, 1).getValues().forEach(function(row, index) {
        if (String(row[0]) === String(value)) matches.push(index + 2);
      });
    }
  }
  return matches.map(function(rowNumber) {
    return {rowNumber: rowNumber, values: sheet.getRange(rowNumber, 1, 1, width).getValues()[0]};
  });
}

/**
 * 指定行まで行数を広げる。
 *
 * 行挿入は SpreadsheetApp であり、その変更は遅延適用される。**直後に
 * `flush()` しないと、続けて呼ぶ Sheets API から挿入後の行が見えない**
 * （4.23 flush規則1）。見えないまま書くと、書込先の行番号がずれる。
 *
 * flush を呼出側の責任にすると必ずどこかで漏れるので、挿入した本関数が
 * その場で行う。
 */
function ensureRowExists_(sheet, rowNumber) {
  if (rowNumber <= sheet.getMaxRows()) return;
  sheet.insertRowsAfter(sheet.getMaxRows(), rowNumber - sheet.getMaxRows());
  SpreadsheetApp.flush();
}

function quoteSheetName_(name) { return "'" + String(name).replace(/'/g, "''") + "'"; }

function columnLetter_(column) {
  var result = '';
  var value = column;
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function a1Range_(sheetName, row, firstColumn, lastColumn) {
  return quoteSheetName_(sheetName) + '!' + columnLetter_(firstColumn) + row + ':' + columnLetter_(lastColumn) + row;
}

function jsonCell_(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  try { return JSON.parse(String(value)); } catch (error) { throw new TypeError('Invalid JSON cell'); }
}

function csvEmails_(value) {
  return String(value || '').split(',').map(function(item) { return item.trim().toLowerCase(); }).filter(Boolean);
}

function valueOr_(object, names, fallback) {
  for (var index = 0; index < names.length; index += 1) {
    if (object && object[names[index]] !== undefined) return object[names[index]];
  }
  return fallback;
}

function setContiguousValues_(sheet, rowNumber, firstColumn, values) {
  ensureRowExists_(sheet, rowNumber);
  sheet.getRange(rowNumber, firstColumn, 1, values.length).setValues([values]);
}

function updateColumns_(sheet, rowNumber, updates) {
  Object.keys(updates).forEach(function(column) {
    sheet.getRange(rowNumber, Number(column)).setValue(updates[column]);
  });
}


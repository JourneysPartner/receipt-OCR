'use strict';

/**
 * マスタースプレッドシートのIDを解決する。
 *
 * 順序は「設定値 → Script Properties → アクティブなスプレッドシート」。
 * **アクティブなスプレッドシートへのフォールバックはメニュー実行専用である。**
 * 時間主導トリガーと継続トリガーには「アクティブなスプレッドシート」が
 * 存在しないため、そこへ頼る実装は本番の自動実行で必ず落ちる。しかも
 * 落ちる場所はデータアクセスの入口であり、原因が設定不備だと分かりにくい。
 */
function resolveMasterSpreadsheetId_() {
  if (CONFIG.MASTER_SPREADSHEET_ID) return String(CONFIG.MASTER_SPREADSHEET_ID);
  var stored = PropertiesService.getScriptProperties().getProperty('MASTER_SPREADSHEET_ID');
  if (stored) return String(stored);
  return null;
}

/** フェーズ2のシートアクセスで共有する最小限の基盤。 */
function masterSpreadsheet_() {
  var id = resolveMasterSpreadsheetId_();
  if (id) return SpreadsheetApp.openById(id);

  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new MasterDataError(
      'MASTER_SPREADSHEET_ID is not configured. A trigger run has no active ' +
      'spreadsheet to fall back to; set the script property before scheduling.');
  }
  return active;
}

/** マスタースプレッドシートIDを保存する（4.6 設定検証から呼ぶ）。 */
function setMasterSpreadsheetId(spreadsheetId) {
  if (!spreadsheetId) throw new TypeError('setMasterSpreadsheetId requires an id');
  PropertiesService.getScriptProperties()
    .setProperty('MASTER_SPREADSHEET_ID', String(spreadsheetId));
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

/**
 * 指定列の値が一致する行を返す。
 *
 * **対象列だけを1回読む。** 以前は`createTextFinder`でシート全面を検索して
 * から列で絞っていたが、取引ログは45列×数万行になる設計であり、全面検索を
 * 状態遷移1回につき3回以上行っていた（INV-25）。`createTextFinder`は
 * **表示テキスト**で照合するため、数値・真偽値・日付のセルでは書式次第で
 * 一致しないという問題もある ── 取引IDのような文字列でしか正しく動かない。
 */
function findRowsByColumnValue_(sheet, column, value, width) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var target = String(value);
  var columnValues = sheet.getRange(2, column, lastRow - 1, 1).getValues();
  var matches = [];
  for (var offset = 0; offset < columnValues.length; offset += 1) {
    if (String(columnValues[offset][0]) === target) matches.push(offset + 2);
  }
  if (!matches.length) return [];

  // 一致行だけを読む。連続していればまとめて1回で取る。
  return groupConsecutiveRows(matches.map(function(rowNumber) {
    return {rowNumber: rowNumber};
  })).reduce(function(rows, group) {
    var count = group.endRow - group.startRow + 1;
    sheet.getRange(group.startRow, 1, count, width).getValues()
      .forEach(function(values, index) {
        rows.push({rowNumber: group.startRow + index, values: values});
      });
    return rows;
  }, []);
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

/** 1列ぶんの連続した行範囲。連続行の書込を1レンジにまとめるために使う。 */
function a1ColumnRange_(sheetName, column, startRow, endRow) {
  var letter = columnLetter_(column);
  return quoteSheetName_(sheetName) + '!' + letter + startRow + ':' + letter + endRow;
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


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
  // 別のマスターに向け直したら、覚えている行番号は意味を失う（60）。
  forgetFileRowNumbers_();
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

/**
 * マスター系シートの読取はSheets APIで行う（4.23 flush規則2）。
 *
 * 処理ログ・恒久ファイルインデックス等はSheets APIで**書く**が、
 * SpreadsheetApp の読取キャッシュはその書込を即座に反映しない ── 実機で
 * 「直前に作った行が見えない」「古い状態を読んで書き戻す」が実際に起きた。
 * Sheets APIの読取は自らの書込を必ず見る。読取前の`flush()`は、逆方向
 * （appendRow等のSpreadsheetApp書込）をAPIから見える状態にするためにある。
 */
function sheetsReadRanges_(sheet, ranges) {
  SpreadsheetApp.flush();
  var lastError = null;
  for (var attempt = 0; attempt <= 4; attempt += 1) {
    try {
      var response = Sheets.Spreadsheets.Values.batchGet(sheet.getParent().getId(), {
        ranges: ranges,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
        majorDimension: 'ROWS'
      });
      return (response.valueRanges || []).map(function(range) { return range.values || []; });
    } catch (error) {
      lastError = error;
      var status = Number(error && (error.code || error.status));
      var message = String(error && error.message || '');
      var quotaExceeded = status === 429 || /Quota exceeded/i.test(message);
      var transientFailure = quotaExceeded || status === 500 || status === 503 ||
        /(?:^|\D)(?:500|503)(?:\D|$)/.test(message);
      if (!transientFailure || attempt === 4) throw error;
      // 毎分クォータ（読取60件/分/ユーザー）は数秒の指数バックオフでは
      // 回復しない。クォータ超過は分の窓が空くまで長めに待つ ── これが
      // 多段の運用操作を自然に上限内へペーシングする。
      Utilities.sleep(quotaExceeded ? 20000 * (attempt + 1) : computeBackoffMs(attempt + 1));
    }
  }
  throw lastError;
}

function padRowValues_(row, width) {
  var values = [];
  for (var column = 0; column < width; column += 1) {
    values.push(row && row[column] !== undefined ? row[column] : '');
  }
  return values;
}

function rowHasAnyValue_(row) {
  return Array.isArray(row) && row.some(function(value) {
    return value !== '' && value !== null && value !== undefined;
  });
}

function readSheetRows_(sheet, columns) {
  var range = quoteSheetName_(sheet.getName()) + '!A2:' + columnLetter_(columns);
  var rows = sheetsReadRanges_(sheet, [range])[0];
  // 実APIは末尾の空行を返さないが、スタブはグリッド全体を返し得る。
  // 末尾の全空行を落として両者の挙動を揃える。
  var last = rows.length;
  while (last > 0 && !rowHasAnyValue_(rows[last - 1])) last -= 1;
  var result = [];
  for (var offset = 0; offset < last; offset += 1) {
    result.push({rowNumber: offset + 2, values: padRowValues_(rows[offset], columns)});
  }
  return result;
}

/**
 * 追記先の行番号をSheets APIの読取で決める。`getLastRow()`は
 * SpreadsheetAppのキャッシュ越しであり、Sheets APIで足したばかりの行を
 * 数え落として**既存行を上書きする**行番号を返し得る。
 */
function apiLastDataRow_(sheet, columns) {
  var range = quoteSheetName_(sheet.getName()) + '!A1:' + columnLetter_(columns);
  var rows = sheetsReadRanges_(sheet, [range])[0];
  var last = rows.length;
  while (last > 0 && !rowHasAnyValue_(rows[last - 1])) last -= 1;
  return last;
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
  var name = quoteSheetName_(sheet.getName());
  var letter = columnLetter_(column);
  var columnRows = sheetsReadRanges_(sheet, [name + '!' + letter + '2:' + letter])[0];

  var target = String(value);
  var matches = [];
  for (var offset = 0; offset < columnRows.length; offset += 1) {
    var cell = columnRows[offset] ? columnRows[offset][0] : '';
    if (String(cell === undefined ? '' : cell) === target) matches.push(offset + 2);
  }
  if (!matches.length) return [];

  // 一致行だけを読む。連続していればまとめて1回で取る。
  var groups = groupConsecutiveRows(matches.map(function(rowNumber) {
    return {rowNumber: rowNumber};
  }));
  var ranges = groups.map(function(group) {
    return name + '!A' + group.startRow + ':' + columnLetter_(width) + group.endRow;
  });
  var fetched = sheetsReadRanges_(sheet, ranges);
  var rows = [];
  groups.forEach(function(group, index) {
    var values = fetched[index] || [];
    for (var row = group.startRow; row <= group.endRow; row += 1) {
      rows.push({rowNumber: row, values: padRowValues_(values[row - group.startRow], width)});
    }
  });
  return rows;
}

/**
 * 指定列が「複数の値のいずれか」に一致する行を、値ごとにまとめて返す。
 *
 * `findRowsByColumnValue_`を値の数だけ呼ぶと、**キー列の全読みが値の数だけ
 * 走る**。取引ログは1ファイルにつき数百件を扱うので、確定処理が
 * 「1件につき全列走査3回」になり、実機で1件あたり20秒かかっていた
 * （2026-09-03）。読取はキー列1回＋一致行1回の計2回に収める。
 *
 * @return {!Object<string, !Array<{rowNumber:number, values:!Array<*>}>>}
 */
function findRowsByColumnValues_(sheet, column, values, width) {
  var wanted = Object.create(null);
  (values || []).forEach(function(value) { wanted[String(value)] = true; });
  var result = Object.create(null);
  Object.keys(wanted).forEach(function(key) { result[key] = []; });
  if (!Object.keys(wanted).length) return result;

  var name = quoteSheetName_(sheet.getName());
  var letter = columnLetter_(column);
  var columnRows = sheetsReadRanges_(sheet, [name + '!' + letter + '2:' + letter])[0];

  var matches = [];
  for (var offset = 0; offset < columnRows.length; offset += 1) {
    var cell = columnRows[offset] ? columnRows[offset][0] : '';
    var text = String(cell === undefined ? '' : cell);
    if (wanted[text]) matches.push({rowNumber: offset + 2, key: text});
  }
  if (!matches.length) return result;

  var groups = groupConsecutiveRows(matches);
  var ranges = groups.map(function(group) {
    return name + '!A' + group.startRow + ':' + columnLetter_(width) + group.endRow;
  });
  var fetched = sheetsReadRanges_(sheet, ranges);
  var keyByRow = Object.create(null);
  matches.forEach(function(match) { keyByRow[match.rowNumber] = match.key; });
  groups.forEach(function(group, index) {
    var rows = fetched[index] || [];
    for (var row = group.startRow; row <= group.endRow; row += 1) {
      result[keyByRow[row]].push(
        {rowNumber: row, values: padRowValues_(rows[row - group.startRow], width)});
    }
  });
  return result;
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


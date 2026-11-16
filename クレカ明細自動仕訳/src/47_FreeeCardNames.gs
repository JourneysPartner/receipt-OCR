'use strict';

/**
 * 入力用シートの B1（freee のカード名）を、勘定科目 CSV とカードフォルダの
 * 対応から自動で入れる（`work/spec_freee_card_names.md` 版 1.0）。
 *
 * このファイルは仕様の §2.3・§3.1〜§3.7 を担当する。表「freeeカード科目」の
 * 読み書き・勘定科目 CSV の読み取り・Web アプリの 3 つの入口の本体・複製した
 * 転記シートの B1 に書く処理である。
 *
 * **監査を先に書く。** 監査が書けないときは表に 1 セルも書かず、タブも作らない
 * （§3.2・S4）。表への書込は読み返して確かめ、外れたら `WRITE_VERIFY_FAILED`
 * を返す（S6）。CSV の中身と勘定科目の一覧は監査に書かない（S14）。
 */

var FREEE_CARD_NAMES_SHEET_NAME_ = 'freeeカード科目';
var FREEE_CARD_NAME_CELL_ = 'B1';

/** §2.3 の 11 個の見出し（この順・この文字）。 */
var FREEE_CARD_NAMES_HEADERS_ = Object.freeze([
  '顧客ID',
  '勘定科目',
  'カード候補',
  '対応',
  'CSVファイル名',
  'CSVのSHA-256',
  'CSV登録日時',
  'CSV登録者',
  '対応更新日時',
  '対応更新者',
  '版'
]);

var FREEE_CARD_NAMES_WIDTH_ = FREEE_CARD_NAMES_HEADERS_.length;
var FREEE_CARD_NAMES_MAX_CSV_BYTES_ = 1048576;
var FREEE_CARD_NAMES_MAX_BASE64_CHARS_ = 4000000;
var FREEE_CARD_NAMES_MAX_ACCOUNTS_ = 3000;
var FREEE_CARD_NAMES_MAX_JSON_CHARS_ = 45000;
var FREEE_CARD_NAMES_MAX_CHANGES_ = 200;
var FREEE_CARD_NAMES_CONTROL_ = /[\u0000-\u001f\u007f]/;

/** このファイルのコードは表の例外だけを `code` で返す（カタログ外のコード）。 */
function freeeCardNamesError_(code, detail) {
  var error = new Error(String(code));
  error.name = 'FreeeCardNamesError';
  error.code = String(code);
  error.detail = detail === undefined ? null : detail;
  return error;
}

function freeeCardNamesTrim_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function freeeCardNamesNfkc_(value) {
  var text = value === null || value === undefined ? '' : String(value);
  return typeof text.normalize === 'function' ? text.normalize('NFKC') : text;
}

/** フォルダの鍵（§2.1）。前後の空白（全角を含む）を外した名前。 */
function freeeCardNamesFolderKey_(name) {
  return freeeCardNamesTrim_(name);
}

/** 照合の鍵（§2.1）。NFKC・空白を全部外す・英字を小文字にする。 */
function freeeCardNamesNameKey_(name) {
  return freeeCardNamesNfkc_(name).replace(/[\s　]/g, '').toLowerCase();
}

function freeeCardNamesVersionOk_(value, minimum) {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum;
}

/** 表の JSON セルを読む。空は null、壊れていれば undefined。 */
function freeeCardNamesJsonCell_(raw) {
  if (raw === '' || raw === null || raw === undefined) return null;
  try {
    return JSON.parse(String(raw));
  } catch (error) {
    return undefined;
  }
}

function freeeCardNamesRowInvalid_(rowNumber, column, reason) {
  return freeeCardNamesError_('FREEE_CARD_TABLE_INVALID',
    {row: Number(rowNumber) || 0, column: column, reason: reason});
}

/** B 列（勘定科目）の配列を読む（§2.3）。 */
function freeeCardNamesParseNames_(raw, rowNumber) {
  var parsed = freeeCardNamesJsonCell_(raw);
  if (!Array.isArray(parsed)) {
    throw freeeCardNamesRowInvalid_(rowNumber, 'B', 'NOT_ARRAY');
  }
  var seen = Object.create(null);
  return parsed.map(function(value) {
    if (typeof value !== 'string') {
      throw freeeCardNamesRowInvalid_(rowNumber, 'B', 'NOT_STRING');
    }
    if (value === '' || value !== value.trim()) {
      throw freeeCardNamesRowInvalid_(rowNumber, 'B', 'NOT_TRIMMED');
    }
    if (FREEE_CARD_NAMES_CONTROL_.test(value)) {
      throw freeeCardNamesRowInvalid_(rowNumber, 'B', 'CONTROL_CHAR');
    }
    if (seen[value]) {
      throw freeeCardNamesRowInvalid_(rowNumber, 'B', 'DUPLICATE');
    }
    seen[value] = true;
    return value;
  });
}

/** C 列（カード候補）の配列を読む（§2.3）。 */
function freeeCardNamesParseCandidates_(raw, accountNames, rowNumber) {
  var parsed = freeeCardNamesJsonCell_(raw);
  if (!Array.isArray(parsed)) {
    throw freeeCardNamesRowInvalid_(rowNumber, 'C', 'NOT_ARRAY');
  }
  var seen = Object.create(null);
  return parsed.map(function(value) {
    if (typeof value !== 'string') {
      throw freeeCardNamesRowInvalid_(rowNumber, 'C', 'NOT_STRING');
    }
    if (accountNames.indexOf(value) < 0) {
      throw freeeCardNamesRowInvalid_(rowNumber, 'C', 'NOT_IN_ACCOUNTS');
    }
    if (seen[value]) {
      throw freeeCardNamesRowInvalid_(rowNumber, 'C', 'DUPLICATE');
    }
    seen[value] = true;
    return value;
  });
}

/** D 列（対応）のオブジェクトを読む（§2.3）。空は `{}`。 */
function freeeCardNamesParseMappings_(raw, rowNumber) {
  var text = raw === null || raw === undefined ? '' : String(raw);
  if (text === '') return Object.create(null);
  var parsed = freeeCardNamesJsonCell_(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw freeeCardNamesRowInvalid_(rowNumber, 'D', 'NOT_OBJECT');
  }
  var result = Object.create(null);
  Object.keys(parsed).forEach(function(key) {
    if (key === '' || key !== key.trim()) {
      throw freeeCardNamesRowInvalid_(rowNumber, 'D', 'KEY_INVALID');
    }
    if (typeof parsed[key] !== 'string') {
      throw freeeCardNamesRowInvalid_(rowNumber, 'D', 'VALUE_NOT_STRING');
    }
    result[key] = parsed[key];
  });
  return result;
}

/** K 列（版）を読む（§2.3）。1 以上の整数（数値か数字だけの文字列）。 */
function freeeCardNamesParseVersion_(raw, rowNumber) {
  var value;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    value = Number(raw);
  } else {
    throw freeeCardNamesRowInvalid_(rowNumber, 'K', 'NOT_INTEGER');
  }
  if (!Number.isInteger(value) || value < 1) {
    throw freeeCardNamesRowInvalid_(rowNumber, 'K', 'NOT_INTEGER');
  }
  return value;
}

/**
 * §2.3 の 1 行を読む。1 つでも外れたら `FREEE_CARD_TABLE_INVALID`。
 * どの行・どの列かは `detail` に入れる。
 */
function freeeCardNamesParseRow_(values, rowNumber) {
  var row = padRowValues_(values, FREEE_CARD_NAMES_WIDTH_);
  var number = Number(rowNumber) || 0;
  var customerId = freeeCardNamesTrim_(row[0]);
  if (!customerId) throw freeeCardNamesRowInvalid_(number, 'A', 'EMPTY');
  var accountNames = freeeCardNamesParseNames_(row[1], number);
  var candidates = freeeCardNamesParseCandidates_(row[2], accountNames, number);
  var mappings = freeeCardNamesParseMappings_(row[3], number);
  var version = freeeCardNamesParseVersion_(row[10], number);
  return {
    rowNumber: number,
    customerId: customerId,
    accountNames: accountNames,
    candidates: candidates,
    mappings: mappings,
    csvFileName: freeeCardNamesTrim_(row[4]),
    csvSha256: freeeCardNamesTrim_(row[5]),
    csvUploadedAt: freeeCardNamesTrim_(row[6]),
    csvUploadedBy: freeeCardNamesTrim_(row[7]),
    mappingUpdatedAt: freeeCardNamesTrim_(row[8]),
    mappingUpdatedBy: freeeCardNamesTrim_(row[9]),
    version: version
  };
}

function freeeCardNamesHeaderMatches_(header) {
  if (!header || header.length < FREEE_CARD_NAMES_WIDTH_) return false;
  for (var index = 0; index < FREEE_CARD_NAMES_WIDTH_; index += 1) {
    var value = header[index] === null || header[index] === undefined ? '' : String(header[index]);
    if (value !== FREEE_CARD_NAMES_HEADERS_[index]) return false;
  }
  return true;
}

function freeeCardNamesAssertHeader_(header) {
  if (!freeeCardNamesHeaderMatches_(header)) {
    throw freeeCardNamesError_('FREEE_CARD_TABLE_INVALID',
      {row: 1, column: 'A', reason: 'HEADER_MISMATCH'});
  }
}

/**
 * タブを 1 回だけ読む（§2.3 の見出しの確かめも同じ 1 回の中で行う）。
 * 最後の行番号は、値のあるいちばん下の行（見出しが無ければ 1）。
 */
function freeeCardNamesReadTable_(sheet) {
  var values = sheetsReadRanges_(sheet,
    [quoteSheetName_(sheet.getName()) + '!A1:K'])[0] || [];
  var header = padRowValues_(values[0] || [], FREEE_CARD_NAMES_WIDTH_);
  var rows = [];
  var lastRowNumber = 1;
  var anyValue = false;
  for (var index = 0; index < values.length; index += 1) {
    if (!anyValue && rowHasAnyValue_(values[index])) anyValue = true;
    if (index === 0) continue;
    var padded = padRowValues_(values[index] || [], FREEE_CARD_NAMES_WIDTH_);
    if (!rowHasAnyValue_(padded)) continue;
    rows.push({rowNumber: index + 1, values: padded});
    lastRowNumber = index + 1;
  }
  // 中身が全部空のタブは、タブが無いのと同じに扱う（監査 M1）。
  return {header: header, rows: rows, lastRowNumber: lastRowNumber, empty: !anyValue};
}

/**
 * 顧客の行を引く（§2.3）。タブが無ければ `null`（読取 0 回）。
 * 同じ顧客の行が 2 つ以上あれば、どちらが正しいかを決めずに例外にする。
 */
function freeeCardNamesRowFor_(customerId) {
  var sheet = masterSpreadsheet_().getSheetByName(FREEE_CARD_NAMES_SHEET_NAME_);
  if (!sheet) return null;
  var table = freeeCardNamesReadTable_(sheet);
  if (table.empty) return null;
  freeeCardNamesAssertHeader_(table.header);
  var wanted = freeeCardNamesTrim_(customerId);
  var matches = table.rows.filter(function(row) {
    return freeeCardNamesTrim_(row.values[0]) === wanted;
  });
  if (matches.length > 1) {
    throw freeeCardNamesError_('FREEE_CARD_TABLE_INVALID', {
      column: 'A',
      customerId: wanted,
      rows: matches.map(function(row) { return row.rowNumber; })
    });
  }
  if (!matches.length) return null;
  return freeeCardNamesParseRow_(matches[0].values, matches[0].rowNumber);
}

/** 新しい行の行番号（§3.2 の 1）。タブが無い・行が無ければ 2。 */
function freeeCardNamesNextRowNumber_() {
  var sheet = masterSpreadsheet_().getSheetByName(FREEE_CARD_NAMES_SHEET_NAME_);
  if (!sheet) return 2;
  var table = freeeCardNamesReadTable_(sheet);
  if (table.empty) return 2;
  freeeCardNamesAssertHeader_(table.header);
  return table.lastRowNumber + 1;
}

function freeeCardNamesSameCell_(expected, actual) {
  var left = expected === undefined || expected === null ? '' : expected;
  var right = actual === undefined || actual === null ? '' : actual;
  if (left === '' && right === '') return true;
  if (left === right) return true;
  return false;
}

function freeeCardNamesRowMatches_(expected, actual) {
  for (var index = 0; index < FREEE_CARD_NAMES_WIDTH_; index += 1) {
    if (index === 10) {
      // K（版）は数値で返ってもよい（§3.2 の 5）。
      if (Number(expected[index]) !== Number(actual[index])) return false;
    } else if (!freeeCardNamesSameCell_(expected[index], actual[index])) {
      return false;
    }
  }
  return true;
}

/**
 * §3.2 表に 1 行を書く。**監査が先、タブを作るのはその後。**
 * RAW で 1 行だけ書き、読み返して確かめる。外れたら失敗の監査を書こうとし、
 * `{ok:false, code:'WRITE_VERIFY_FAILED', rowNumber}` を返す。
 */
function freeeCardNamesWriteRow_(auth, customerId, newRow, existingRow, audit) {
  var master = masterSpreadsheet_();
  var masterId = String(master.getId());
  var sheetName = FREEE_CARD_NAMES_SHEET_NAME_;
  var rowNumber = existingRow && Number.isInteger(existingRow.rowNumber) &&
    existingRow.rowNumber > 0 ? existingRow.rowNumber : 0;
  var actor = auth && auth.userEmail ? String(auth.userEmail) : '';
  var targetId = String(customerId);

  // **監査を先に書く。** 書けなければ表には 1 セルも書かず、タブも作らない（S4）。
  try {
    appendAuditRowsUnlocked_([audit]);
    SpreadsheetApp.flush();
  } catch (auditError) {
    throw makeCatalogError_('REQUIRED_LOG_WRITE_FAILED',
      auditError && auditError.message ? auditError.message : String(auditError));
  }

  try {
    var sheet = master.getSheetByName(sheetName);
    var needsHeader = false;
    if (!rowNumber) {
      if (!sheet) {
        rowNumber = 2;
        needsHeader = true;
      } else {
        // 中身が全部空のタブは、タブが無いのと同じに扱う（監査 M1）。
        var table = freeeCardNamesReadTable_(sheet);
        if (table.empty) {
          rowNumber = 2;
          needsHeader = true;
        } else {
          freeeCardNamesAssertHeader_(table.header);
          rowNumber = table.lastRowNumber + 1;
        }
      }
    }
    var range = quoteSheetName_(sheetName) + '!A' + rowNumber + ':K' + rowNumber;
    if (!sheet) sheet = master.insertSheet(sheetName);
    if (needsHeader) {
      ensureSheetWidth_(sheet, FREEE_CARD_NAMES_WIDTH_);
      // 見出しを Sheets API で書く前に、作ったタブを確定させる（監査 M1）。
      SpreadsheetApp.flush();
      Sheets.Spreadsheets.Values.update({values: [FREEE_CARD_NAMES_HEADERS_.slice()]},
        masterId, quoteSheetName_(sheetName) + '!A1:K1', {valueInputOption: 'RAW'});
    }
    ensureRowExists_(sheet, rowNumber);
    // **RAW で書く。** USER_ENTERED は `001` を数に、`=1+1` を式にする。
    Sheets.Spreadsheets.Values.update({values: [padRowValues_(newRow, FREEE_CARD_NAMES_WIDTH_)]},
      masterId, range, {valueInputOption: 'RAW'});

    var verify = sheetsReadWithRetry_(function() {
      return sheetsBatchGetPaced_(masterId, {
        ranges: [quoteSheetName_(sheetName) + '!A:A', range],
        valueRenderOption: 'UNFORMATTED_VALUE',
        majorDimension: 'ROWS'
      });
    });
    var ids = (verify && verify.valueRanges && verify.valueRanges[0] &&
      verify.valueRanges[0].values) || [];
    var hits = [];
    ids.forEach(function(values, index) {
      if (freeeCardNamesTrim_(values && values[0]) === targetId) hits.push(index + 1);
    });
    var readRow = padRowValues_(
      (verify && verify.valueRanges && verify.valueRanges[1] &&
        verify.valueRanges[1].values && verify.valueRanges[1].values[0]) || [],
      FREEE_CARD_NAMES_WIDTH_);
    if (hits.length !== 1 || hits[0] !== rowNumber ||
        !freeeCardNamesRowMatches_(padRowValues_(newRow, FREEE_CARD_NAMES_WIDTH_), readRow)) {
      throw freeeCardNamesError_('WRITE_VERIFY_FAILED', {row: rowNumber});
    }
    freeeCardNamesParseRow_(readRow, rowNumber);
    return {ok: true, rowNumber: rowNumber};
  } catch (writeError) {
    var code = writeError && writeError.code === 'REQUIRED_LOG_WRITE_FAILED' ?
      'REQUIRED_LOG_WRITE_FAILED' : 'WRITE_VERIFY_FAILED';
    // 失敗の監査。書けなくても元の失敗を返す（§3.2 の 6）。
    try {
      appendAuditRowsUnlocked_([{
        type: audit && audit.type ? String(audit.type) : 'FREEE_CARD_CSV',
        actor: actor,
        targetType: 'CUSTOMER',
        targetId: targetId,
        customerId: targetId,
        before: '',
        after: {row: rowNumber, failed: code},
        reason: 'WEBAPP_FAILED'
      }]);
    } catch (ignored) {
      // 失敗の監査が書けなくても、元の失敗を返す。
    }
    return {ok: false, code: 'WRITE_VERIFY_FAILED', rowNumber: rowNumber};
  }
}

function freeeCardNamesHeaderKey_(value) {
  return freeeCardNamesNfkc_(value).replace(/[\s　]/g, '');
}

/**
 * §3.3 勘定科目 CSV を読む。表には書かない・監査も書かない。
 * 見出しは名前で探し、UTF-8（BOM 付き）と Shift_JIS の両方を受ける。
 */
function freeeCardNamesParseCsv_(bytes) {
  var length = bytes && typeof bytes.length === 'number' ? Number(bytes.length) : 0;
  if ((!Array.isArray(bytes) && !ArrayBuffer.isView(bytes)) ||
      length < 1 || length > FREEE_CARD_NAMES_MAX_CSV_BYTES_) {
    return {ok: false, code: 'CSV_SIZE'};
  }
  var decoded;
  try {
    decoded = detectEncoding(bytes, ['勘定科目', '表示名']);
  } catch (error) {
    return {ok: false, code: 'CSV_ENCODING', detail: error && error.code || null};
  }
  if (!decoded || decoded.mojibake === true) {
    return {ok: false, code: 'CSV_ENCODING'};
  }
  var parsed;
  try {
    parsed = parseCsv(String(decoded.text || ''));
  } catch (error) {
    return {ok: false, code: 'CSV_ROW_INVALID',
      detail: {row: null, reason: 'CSV_PARSE_FAILED'}};
  }
  var rows = parsed.rows || [];
  var starts = parsed.recordStarts || [];
  if (!rows.length) {
    return {ok: false, code: 'CSV_HEADER',
      detail: {missing: ['勘定科目', '表示名（決算書）'], duplicated: []}};
  }
  var header = rows[0].map(function(value) { return value; });
  header[0] = String(header[0] === null || header[0] === undefined ? '' : header[0])
    .replace(/^\uFEFF/, '');
  var accountColumns = [];
  var displayColumns = [];
  header.forEach(function(value, index) {
    var key = freeeCardNamesHeaderKey_(value);
    if (key === '勘定科目') accountColumns.push(index);
    if (key === '表示名(決算書)') displayColumns.push(index);
  });
  var missing = [];
  var duplicated = [];
  if (!accountColumns.length) missing.push('勘定科目');
  if (!displayColumns.length) missing.push('表示名（決算書）');
  if (accountColumns.length > 1) duplicated.push('勘定科目');
  if (displayColumns.length > 1) duplicated.push('表示名（決算書）');
  if (missing.length || duplicated.length) {
    return {ok: false, code: 'CSV_HEADER', detail: {missing: missing, duplicated: duplicated}};
  }

  var accountColumn = accountColumns[0];
  var displayColumn = displayColumns[0];
  var accountNames = [];
  var candidates = [];
  var seen = Object.create(null);
  var rowCount = 0;
  for (var index = 1; index < rows.length; index += 1) {
    var row = rows[index] || [];
    var empty = row.every(function(value) { return freeeCardNamesTrim_(value) === ''; });
    if (empty) continue;
    rowCount += 1;
    var physicalRow = Number(starts[index]) || (index + 1);
    var name = freeeCardNamesTrim_(row[accountColumn]);
    if (name === '' || FREEE_CARD_NAMES_CONTROL_.test(name)) {
      return {ok: false, code: 'CSV_ROW_INVALID', detail: {row: physicalRow}};
    }
    if (Object.prototype.hasOwnProperty.call(seen, name)) {
      return {ok: false, code: 'CSV_DUPLICATE',
        detail: {name: name, rows: [seen[name], physicalRow]}};
    }
    seen[name] = physicalRow;
    accountNames.push(name);
    var display = freeeCardNamesTrim_(freeeCardNamesNfkc_(row[displayColumn]));
    if (display === '未払金') candidates.push(name);
  }
  if (!accountNames.length) return {ok: false, code: 'CSV_EMPTY'};
  if (accountNames.length > FREEE_CARD_NAMES_MAX_ACCOUNTS_) {
    return {ok: false, code: 'CSV_TOO_MANY'};
  }
  if (JSON.stringify(accountNames).length > FREEE_CARD_NAMES_MAX_JSON_CHARS_) {
    return {ok: false, code: 'CSV_TOO_LARGE'};
  }
  return {
    ok: true,
    accountNames: accountNames,
    candidates: candidates,
    sha256: sha256Hex(bytes),
    rowCount: rowCount
  };
}

/** 顧客の明細フォルダ直下のカードフォルダ（`webAppListFolder` と同じ順）。 */
function freeeCardNamesCardFolders_(customer) {
  var iterator = DriveApp.getFolderById(customer.sourceFolderId).getFolders();
  var folders = [];
  while (iterator.hasNext()) {
    var folder = iterator.next();
    folders.push({folderId: String(folder.getId()), folderName: String(folder.getName() || '')});
  }
  folders.sort(function(left, right) {
    if (left.folderName !== right.folderName) return left.folderName < right.folderName ? -1 : 1;
    return left.folderId < right.folderId ? -1 : (left.folderId > right.folderId ? 1 : 0);
  });
  folders.forEach(function(item) {
    item.folderKey = freeeCardNamesFolderKey_(item.folderName);
  });
  return folders;
}

function freeeCardNamesHasOwn_(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * §3.4 開く。何も書かない。提案は返すだけで保存しない。
 */
function freeeCardNamesStart_(auth, customer) {
  var row = freeeCardNamesRowFor_(customer.customerId);
  var candidates = row ? row.candidates.slice() : [];
  var folders = freeeCardNamesCardFolders_(customer);
  var folderKeys = Object.create(null);
  folders.forEach(function(folder) { folderKeys[folder.folderKey] = true; });
  var resultFolders = folders.map(function(folder) {
    var savedAccountName = row && freeeCardNamesHasOwn_(row.mappings, folder.folderKey) ?
      String(row.mappings[folder.folderKey]) : null;
    var savedValid = savedAccountName !== null && candidates.indexOf(savedAccountName) >= 0;
    var suggestion = null;
    if (savedAccountName === null) {
      var key = freeeCardNamesNameKey_(folder.folderName);
      var matches = candidates.filter(function(name) {
        return freeeCardNamesNameKey_(name) === key;
      });
      if (matches.length === 1) suggestion = matches[0];
    }
    return {folderId: folder.folderId, folderName: folder.folderName,
      savedAccountName: savedAccountName, savedValid: savedValid, suggestion: suggestion};
  });
  var orphans = [];
  if (row) {
    Object.keys(row.mappings).forEach(function(key) {
      if (folderKeys[key]) return;
      var accountName = String(row.mappings[key]);
      orphans.push({folderName: key, accountName: accountName,
        valid: candidates.indexOf(accountName) >= 0});
    });
  }
  var csv = row ? {
    fileName: row.csvFileName,
    uploadedAt: row.csvUploadedAt,
    uploadedBy: row.csvUploadedBy,
    accountCount: row.accountNames.length,
    candidateCount: row.candidates.length
  } : null;
  return {
    ok: true,
    customerId: String(customer.customerId),
    customerName: String(customer.customerName),
    csv: csv,
    candidates: candidates,
    folders: resultFolders,
    orphans: orphans,
    version: row ? row.version : 0
  };
}

/** §3.5 の 2。ファイル名からパス・制御文字を外す。 */
function freeeCardNamesFileName_(value) {
  if (typeof value !== 'string') return '勘定科目.csv';
  var text = value;
  var slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  if (slash >= 0) text = text.slice(slash + 1);
  text = text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (text.length > 200) text = text.slice(0, 200);
  return text === '' ? '勘定科目.csv' : text;
}

/** §3.5 CSV を登録する・差し替える。保存済みの対応は消さない（S8）。 */
function freeeCardNamesUploadCsv_(auth, customer, fileName, base64, expectedVersion) {
  if (!freeeCardNamesVersionOk_(expectedVersion, 0)) {
    return {ok: false, code: 'STALE'};
  }
  var safeName = freeeCardNamesFileName_(fileName);
  if (typeof base64 !== 'string' || base64 === '' ||
      base64.length > FREEE_CARD_NAMES_MAX_BASE64_CHARS_) {
    return {ok: false, code: 'CSV_SIZE'};
  }
  var bytes;
  try {
    bytes = Utilities.base64Decode(base64);
  } catch (error) {
    return {ok: false, code: 'CSV_DECODE'};
  }
  var parsed = freeeCardNamesParseCsv_(bytes);
  if (!parsed || parsed.ok !== true) return parsed;
  var customerId = String(customer.customerId);
  var actor = auth && auth.userEmail ? String(auth.userEmail) : '';

  return withScriptLock_(function() {
    // ロックの中で読み直す（§3.5 の 5-1・S5）。
    var current = freeeCardNamesRowFor_(customerId);
    var currentVersion = current ? current.version : 0;
    if (currentVersion !== expectedVersion) return {ok: false, code: 'STALE'};
    var now = nowIso_();
    var mappings = current ? current.mappings : Object.create(null);
    var newRow = [
      customerId,
      JSON.stringify(parsed.accountNames),
      JSON.stringify(parsed.candidates),
      JSON.stringify(mappings),
      safeName,
      parsed.sha256,
      now,
      actor,
      current ? current.mappingUpdatedAt : '',
      current ? current.mappingUpdatedBy : '',
      currentVersion + 1
    ];
    var invalidMappings = [];
    Object.keys(mappings).forEach(function(key) {
      var accountName = String(mappings[key]);
      if (parsed.candidates.indexOf(accountName) < 0) {
        invalidMappings.push({folderName: key, accountName: accountName});
      }
    });
    var audit = {
      type: 'FREEE_CARD_CSV',
      actor: actor,
      targetType: 'CUSTOMER',
      targetId: customerId,
      customerId: customerId,
      before: current ? {
        version: current.version,
        sha256: current.csvSha256,
        accountCount: current.accountNames.length,
        candidateCount: current.candidates.length
      } : '',
      after: {
        version: currentVersion + 1,
        sha256: parsed.sha256,
        fileName: safeName,
        accountCount: parsed.accountNames.length,
        candidateCount: parsed.candidates.length,
        invalidMappingCount: invalidMappings.length
      },
      reason: 'WEBAPP'
    };
    var written = freeeCardNamesWriteRow_(auth, customerId, newRow, current, audit);
    if (!written.ok) return written;
    return {
      ok: true,
      version: currentVersion + 1,
      csv: {
        fileName: safeName,
        uploadedAt: now,
        uploadedBy: actor,
        accountCount: parsed.accountNames.length,
        candidateCount: parsed.candidates.length
      },
      invalidMappings: invalidMappings
    };
  });
}

/** §3.6 の 2。changes の形を確かめる。 */
function freeeCardNamesParseChanges_(changes) {
  if (!Array.isArray(changes) || changes.length < 1 ||
      changes.length > FREEE_CARD_NAMES_MAX_CHANGES_) {
    return {ok: false, code: 'MAPPING_INVALID',
      detail: {index: null, reason: 'CHANGES_INVALID'}};
  }
  var normalized = [];
  var seen = Object.create(null);
  for (var index = 0; index < changes.length; index += 1) {
    var change = changes[index];
    if (!change || typeof change !== 'object' || Array.isArray(change)) {
      return {ok: false, code: 'MAPPING_INVALID',
        detail: {index: index, reason: 'ENTRY_INVALID'}};
    }
    if (typeof change.folderName !== 'string') {
      return {ok: false, code: 'MAPPING_INVALID',
        detail: {index: index, reason: 'FOLDER_NAME_INVALID'}};
    }
    var folderName = change.folderName.trim();
    if (folderName === '' || FREEE_CARD_NAMES_CONTROL_.test(folderName)) {
      return {ok: false, code: 'MAPPING_INVALID',
        detail: {index: index, reason: 'FOLDER_NAME_INVALID'}};
    }
    if (seen[folderName]) {
      return {ok: false, code: 'MAPPING_INVALID',
        detail: {index: index, reason: 'DUPLICATE_FOLDER'}};
    }
    seen[folderName] = true;
    var accountName = change.accountName;
    if (!(accountName === null || typeof accountName === 'string')) {
      return {ok: false, code: 'MAPPING_INVALID',
        detail: {index: index, reason: 'ACCOUNT_NAME_INVALID'}};
    }
    normalized.push({folderName: folderName, accountName: accountName});
  }
  return {ok: true, changes: normalized};
}

/**
 * §3.6 対応を保存する。カードの候補にある名前だけを、今のカードフォルダの鍵に
 * だけ保存できる（外すのは今の鍵か保存済みの鍵）。1 つでも外れたら何も書かない。
 */
function freeeCardNamesSave_(auth, customer, changes, expectedVersion) {
  if (!freeeCardNamesVersionOk_(expectedVersion, 1)) {
    return {ok: false, code: 'STALE'};
  }
  var parsedChanges = freeeCardNamesParseChanges_(changes);
  if (!parsedChanges.ok) return parsedChanges;
  var customerId = String(customer.customerId);
  // 今のカードフォルダの鍵はロックの外で読んでよい（§3.6 の 3）。
  var folderKeys = Object.create(null);
  freeeCardNamesCardFolders_(customer).forEach(function(folder) {
    folderKeys[folder.folderKey] = true;
  });
  var actor = auth && auth.userEmail ? String(auth.userEmail) : '';

  return withScriptLock_(function() {
    var current = freeeCardNamesRowFor_(customerId);
    if (!current) return {ok: false, code: 'NO_CSV'};
    if (current.version !== expectedVersion) return {ok: false, code: 'STALE'};

    var changes = parsedChanges.changes;
    for (var index = 0; index < changes.length; index += 1) {
      var change = changes[index];
      if (typeof change.accountName === 'string') {
        if (current.candidates.indexOf(change.accountName) < 0) {
          return {ok: false, code: 'MAPPING_INVALID',
            detail: {folderName: change.folderName, reason: 'NOT_CANDIDATE'}};
        }
        if (!folderKeys[change.folderName]) {
          return {ok: false, code: 'MAPPING_INVALID',
            detail: {folderName: change.folderName, reason: 'FOLDER_NOT_FOUND'}};
        }
      } else if (!folderKeys[change.folderName] &&
          !freeeCardNamesHasOwn_(current.mappings, change.folderName)) {
        return {ok: false, code: 'MAPPING_INVALID',
          detail: {folderName: change.folderName, reason: 'FOLDER_NOT_FOUND'}};
      }
    }

    var next = Object.create(null);
    Object.keys(current.mappings).forEach(function(key) {
      next[key] = current.mappings[key];
    });
    var changedKeys = [];
    changes.forEach(function(change) {
      var had = freeeCardNamesHasOwn_(next, change.folderName);
      var beforeValue = had ? next[change.folderName] : null;
      if (change.accountName === null) {
        if (had) delete next[change.folderName];
        if (had && changedKeys.indexOf(change.folderName) < 0) {
          changedKeys.push(change.folderName);
        }
      } else {
        next[change.folderName] = change.accountName;
        if ((!had || beforeValue !== change.accountName) &&
            changedKeys.indexOf(change.folderName) < 0) {
          changedKeys.push(change.folderName);
        }
      }
    });
    if (!changedKeys.length) {
      return {ok: true, version: current.version, changed: 0};
    }

    var beforeMappings = Object.create(null);
    var afterMappings = Object.create(null);
    changedKeys.forEach(function(key) {
      beforeMappings[key] = freeeCardNamesHasOwn_(current.mappings, key) ?
        current.mappings[key] : null;
      afterMappings[key] = freeeCardNamesHasOwn_(next, key) ? next[key] : null;
    });
    var now = nowIso_();
    var newRow = [
      customerId,
      JSON.stringify(current.accountNames),
      JSON.stringify(current.candidates),
      JSON.stringify(next),
      current.csvFileName,
      current.csvSha256,
      current.csvUploadedAt,
      current.csvUploadedBy,
      now,
      actor,
      current.version + 1
    ];
    var audit = {
      type: 'FREEE_CARD_MAPPING',
      actor: actor,
      targetType: 'CUSTOMER',
      targetId: customerId,
      customerId: customerId,
      before: {version: current.version, mappings: beforeMappings},
      after: {version: current.version + 1, mappings: afterMappings},
      reason: 'WEBAPP'
    };
    var written = freeeCardNamesWriteRow_(auth, customerId, newRow, current, audit);
    if (!written.ok) return written;
    return {ok: true, version: current.version + 1, changed: changedKeys.length};
  });
}

/**
 * §3.7 複製した転記シートの入力用シートの B1 に、対応のカード名を書く。
 *
 * **この関数は例外を投げない。** 中で起きた例外は全部 `FAILED` にし、カード名・
 * フォルダ名を入れずにログへ残す。書くのは B1 の 1 セルだけ・RAW。読み返して
 * 同じでなければ `FAILED`（S9・S11）。
 *
 * @param {!Object} customer `destinationSpreadsheetId` が雛形の ID の顧客
 * @param {string} destinationSpreadsheetId この呼出しで複製した転記先
 * @param {string} cardFolderName カードフォルダの名前（鍵は前後の空白を外して作る）
 * @return {{status: string, folderName: string, accountName: (string|undefined)}}
 */
function freeeCardWriteCardName_(customer, destinationSpreadsheetId, cardFolderName) {
  var folderName = freeeCardNamesFolderKey_(cardFolderName);
  var customerId = customer && customer.customerId !== undefined ?
    String(customer.customerId) : '';
  try {
    if (String(destinationSpreadsheetId) === String(customer.destinationSpreadsheetId)) {
      return {status: 'FAILED', folderName: folderName};
    }
    if (Number(customer.headerRow) < 2) {
      return {status: 'TEMPLATE_UNSUPPORTED', folderName: folderName};
    }
    var row = freeeCardNamesRowFor_(customer.customerId);
    if (!row) return {status: 'NO_CSV', folderName: folderName};
    var mapped = freeeCardNamesHasOwn_(row.mappings, folderName) ?
      String(row.mappings[folderName]) : null;
    if (mapped === null) return {status: 'NOT_SET', folderName: folderName};
    if (row.candidates.indexOf(mapped) < 0) {
      return {status: 'NOT_IN_CSV', folderName: folderName, accountName: mapped};
    }
    var range = quoteSheetName_(customer.destinationSheetName) + '!' + FREEE_CARD_NAME_CELL_;
    Sheets.Spreadsheets.Values.update({values: [[mapped]]},
      String(destinationSpreadsheetId), range, {valueInputOption: 'RAW'});
    var verify = sheetsReadWithRetry_(function() {
      return sheetsBatchGetPaced_(String(destinationSpreadsheetId), {
        ranges: [range],
        valueRenderOption: 'UNFORMATTED_VALUE',
        majorDimension: 'ROWS'
      });
    });
    var values = verify && verify.valueRanges && verify.valueRanges[0] &&
      verify.valueRanges[0].values;
    var actual = values && values[0] ? values[0][0] : undefined;
    if (actual !== mapped) return {status: 'FAILED', folderName: folderName};
    return {status: 'WRITTEN', folderName: folderName, accountName: mapped};
  } catch (error) {
    Logger.log('FREEE_CARD_NAME_WRITE_FAILED ' + JSON.stringify({
      customerId: customerId,
      code: (error && (error.code || error.name)) || 'Error'
    }));
    return {status: 'FAILED', folderName: folderName};
  }
}

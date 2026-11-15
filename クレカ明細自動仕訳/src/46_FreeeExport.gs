'use strict';

/**
 * freee 取込用 Excel（値だけ・データの行だけの 1 枚）を作る。
 *
 * 転記シートの「取込用」タブは読むだけで、1 セルも書かない。計算後の値を
 * 確かめ、通ったときだけ作業用フォルダに 1 枚だけの一時スプレッドシートを
 * 作って値を書き、読み返して確かめる（`work/spec_freee_export.md` 版 1.0）。
 */

const FREEE_IMPORT_SHEET_NAME_ = '取込用';

/** 取込用 1 行目の見出し（§2.2。この順・この文字でなければ止める）。 */
const FREEE_IMPORT_HEADERS_ = Object.freeze([
  '日付', '伝票番号', '決算整理仕訳',
  '借方勘定科目', '借方科目コード', '借方補助科目', '借方取引先',
  '借方取引先コード', '借方部門', '借方品目', '借方メモタグ',
  '借方セグメント1', '借方セグメント2', '借方セグメント3',
  '借方金額', '借方税区分', '借方税額',
  '貸方勘定科目', '貸方科目コード', '貸方補助科目', '貸方取引先',
  '貸方取引先コード', '貸方部門', '貸方品目', '貸方メモタグ',
  '貸方セグメント1', '貸方セグメント2', '貸方セグメント3',
  '貸方金額', '貸方税区分', '貸方税額', '摘要'
]);

/** 雛形の入力規則にある、freee に無い名前（表示のための案内だけ。値は直さない）。 */
const FREEE_TAX_ALIASES_ = Object.freeze({
  '不課税': '対象外',
  '課対売上10%': '課税売上10%',
  '課対売上8%（軽）': '課税売上8%（軽）'
});

/**
 * freee の税区分（30）。期間は発生日（A）の両端を含む。
 * `%` は半角（U+0025）、かっこは全角（U+FF08・U+FF09）。
 */
const FREEE_TAX_CATEGORIES_ = Object.freeze([
  {name: '対象外'},
  {name: '対外仕入'},
  {name: '対外売上'},
  {name: '非課仕入'},
  {name: '非課売上'},
  {name: '課対仕入10%'},
  {name: '課対仕入8%（軽）'},
  {name: '非対仕入10%'},
  {name: '非対仕入8%（軽）'},
  {name: '共対仕入10%'},
  {name: '共対仕入8%（軽）'},
  {name: '課対仕返10%'},
  {name: '課対仕返8%（軽）'},
  {name: '課税売上10%'},
  {name: '課税売上8%（軽）'},
  {name: '課税売返10%'},
  {name: '課税売返8%（軽）'},
  {name: '課対輸本'},
  {name: '課対輸税10%'},
  {name: '課対輸税8%（軽）'},
  {name: '地消貨割10%'},
  {name: '地消貨割8%（軽）'},
  {name: '課対仕入（控80）10%', from: '2023-10-01', to: '2026-09-30'},
  {name: '課対仕入（控80）8%（軽）', from: '2023-10-01', to: '2026-09-30'},
  {name: '課対仕入（控70）10%', from: '2026-10-01', to: '2028-09-30'},
  {name: '課対仕入（控70）8%（軽）', from: '2026-10-01', to: '2028-09-30'},
  {name: '課対仕入（控50）10%', from: '2028-10-01', to: '2030-09-30'},
  {name: '課対仕入（控50）8%（軽）', from: '2028-10-01', to: '2030-09-30'},
  {name: '課対仕入（控30）10%', from: '2030-10-01', to: '2031-09-30'},
  {name: '課対仕入（控30）8%（軽）', from: '2030-10-01', to: '2031-09-30'}
]);

const FREEE_EXPORT_MAX_ROW_PROBLEMS_ = 30;
const FREEE_EXPORT_MAX_ROW_NUMBERS_ = 30;
const FREEE_EXPORT_MAX_CLEANUP_FILES_ = 20;
const FREEE_EXPORT_CLEANUP_PAGES_ = 5;
const FREEE_EXPORT_STALE_MS_ = 60 * 60 * 1000;
const FREEE_EXPORT_MIN_SERIAL_ = 36526;   // 2000-01-01
const FREEE_EXPORT_MAX_SERIAL_ = 73050;   // 2099-12-31
const FREEE_EXPORT_MAX_AMOUNT_ = 999999999999;
const FREEE_FORMULA_ERRORS_ = Object.freeze([
  '#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#ERROR!'
]);

var FREEE_TAX_BY_NAME_ = null;

function freeeTaxByName_() {
  if (FREEE_TAX_BY_NAME_) return FREEE_TAX_BY_NAME_;
  var map = Object.create(null);
  FREEE_TAX_CATEGORIES_.forEach(function(category) { map[category.name] = category; });
  FREEE_TAX_BY_NAME_ = map;
  return map;
}

/**
 * 空とみなす値（§2.1）。`undefined`・`null`・`''`・数値の `0`・
 * 空白（半角・全角・タブ・改行）だけの文字列。
 */
function freeeEmptyValue_(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'number' && value === 0) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  return false;
}

/** 見出しの比較用。無いセルは `''`。 */
function freeeHeaderText_(value) {
  return value === undefined || value === null ? '' : String(value);
}

function freeeTruncate_(value, max) {
  var text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

/** シリアル値（1899-12-30 からの日数）を yyyy/MM/dd にする。UTC で数える。 */
function freeeSerialDateText_(serial) {
  var date = new Date(Date.UTC(1899, 11, 30) + Number(serial) * 86400000);
  var year = date.getUTCFullYear();
  var month = String(date.getUTCMonth() + 1).padStart(2, '0');
  var day = String(date.getUTCDate()).padStart(2, '0');
  return year + '/' + month + '/' + day;
}

/** ISO の日付（YYYY-MM-DD）を、1899-12-30 からの日数にする。 */
function freeeIsoToSerial_(iso) {
  var parts = String(iso).split('-').map(Number);
  return Math.round((Date.UTC(parts[0], parts[1] - 1, parts[2]) -
    Date.UTC(1899, 11, 30)) / 86400000);
}

function freeeValidDateSerial_(value) {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= FREEE_EXPORT_MIN_SERIAL_ && value <= FREEE_EXPORT_MAX_SERIAL_;
}

function freeeValidAmount_(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0 &&
    Math.abs(value) <= FREEE_EXPORT_MAX_AMOUNT_;
}

function freeeFiniteNumber_(value) {
  return typeof value === 'number' && isFinite(value);
}

/**
 * 税区分の名前が一覧に無いときの案内（§3.6。表示のためだけ。値は直さない）。
 * 上から順に最初に当たったもの。当たらなければ `null`。
 */
function freeeTaxHint_(value) {
  if (typeof value !== 'string') return null;
  var trimmed = value.trim();
  var map = freeeTaxByName_();
  if (trimmed !== value && map[trimmed]) {
    return {code: 'SPACE', suggestion: trimmed};
  }
  var normalized = value.normalize('NFKC');
  var widthMatch = null;
  FREEE_TAX_CATEGORIES_.some(function(category) {
    if (category.name.normalize('NFKC') === normalized) {
      widthMatch = category.name;
      return true;
    }
    return false;
  });
  if (widthMatch) return {code: 'WIDTH', suggestion: widthMatch};
  if (Object.prototype.hasOwnProperty.call(FREEE_TAX_ALIASES_, value)) {
    return {code: 'ALIAS', suggestion: FREEE_TAX_ALIASES_[value]};
  }
  if (map[value + '10%']) {
    return {code: 'RATE_MISSING', suggestions: [value + '10%', value + '8%（軽）']};
  }
  return null;
}

function freeePreconditionStop_(code, destinationId) {
  return {
    ok: false,
    created: false,
    stage: 'PRECONDITION',
    code: code,
    stops: [{code: code}],
    rowProblems: [],
    rowProblemCount: 0,
    destinationSpreadsheetId: String(destinationId)
  };
}

function freeeExportStop_(stage, code, stops, destinationId, rowProblems) {
  var problems = rowProblems || [];
  return {
    ok: false,
    created: false,
    stage: stage,
    code: code,
    stops: stops,
    rowProblems: problems.slice(0, FREEE_EXPORT_MAX_ROW_PROBLEMS_),
    rowProblemCount: problems.length,
    destinationSpreadsheetId: String(destinationId)
  };
}

/**
 * 転記シートを 1 回だけ読む（§3.3）。
 * 429・500・503 は `destinationRangeValues_` と同じく 3 回まで待って再試行する。
 */
function freeeReadDestination_(destinationId, inputSheetName, headerRow, lastColumn) {
  var ranges = [
    quoteSheetName_(FREEE_IMPORT_SHEET_NAME_) + '!A1:AF',
    quoteSheetName_(inputSheetName) + '!B1',
    quoteSheetName_(inputSheetName) + '!A' + (headerRow + 1) + ':' + columnLetter_(lastColumn)
  ];
  for (var attempt = 1; attempt <= 3; attempt += 1) {
    try {
      var response = sheetsBatchGetPaced_(destinationId, {
        ranges: ranges,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
        majorDimension: 'ROWS'
      });
      var valueRanges = response && response.valueRanges || [];
      return [0, 1, 2].map(function(index) {
        return valueRanges[index] && valueRanges[index].values || [];
      });
    } catch (error) {
      var status = Number(error && (error.code || error.status));
      var transientFailure = status === 429 || status === 500 || status === 503 ||
        /(?:429|500|503)/.test(String(error && error.message));
      if (isSheetsQuotaError_(error)) noteSheetsQuotaExceeded_();
      if (!transientFailure) throw error;
      if (attempt === 3) throw makeCatalogError_('TRANSIENT_SHEETS_ERROR', error.message);
      Utilities.sleep(computeBackoffMs(attempt));
    }
  }
  return [[], [], []];
}

/** 32 セルを、無いセルは `''` にして返す。 */
function freeeImportCells_(row) {
  var cells = [];
  for (var column = 0; column < FREEE_IMPORT_HEADERS_.length; column += 1) {
    var value = row && row[column];
    cells.push(value === undefined || value === null ? '' : value);
  }
  return cells;
}

/** 行ごとの確かめ（§3.5）。1 行に問題がいくつあっても全部記録する。 */
function freeeRowProblems_(importRow, cells) {
  var problems = [];
  var validDate = freeeValidDateSerial_(cells[0]);
  var dateText = validDate ? freeeSerialDateText_(cells[0]) : null;
  var debitAmount = cells[14];
  var creditAmount = cells[28];
  var base = {
    date: dateText,
    amount: typeof debitAmount === 'number' ? debitAmount : null,
    description: typeof cells[31] === 'string' ? freeeTruncate_(cells[31], 30) : ''
  };
  function add(kind, column, extra) {
    var record = {importRow: importRow, kind: kind, column: column, value: null, hint: null};
    Object.assign(record, base);
    if (extra) Object.assign(record, extra);
    problems.push(record);
    return record;
  }

  for (var index = 0; index < cells.length; index += 1) {
    var cell = cells[index];
    if (typeof cell === 'string' &&
        FREEE_FORMULA_ERRORS_.indexOf(cell.trim()) >= 0) {
      add('FORMULA_ERROR', columnLetter_(index + 1),
        {value: freeeTruncate_(cell, 40)});
    }
  }

  if (!validDate) add('DATE_INVALID', 'A');

  var validDebit = freeeValidAmount_(debitAmount);
  if (!validDebit) add('AMOUNT_INVALID', 'O');
  var validCredit = freeeValidAmount_(creditAmount);
  if (!validCredit) add('AMOUNT_INVALID', 'AC');
  if (validDebit && validCredit && debitAmount !== creditAmount) {
    add('DEBIT_CREDIT_MISMATCH', null);
  }

  if (freeeEmptyValue_(cells[3])) add('ACCOUNT_EMPTY', 'D');
  if (freeeEmptyValue_(cells[17])) add('ACCOUNT_EMPTY', 'R');

  var taxColumns = [{index: 15, letter: 'P'}, {index: 29, letter: 'AD'}];
  taxColumns.forEach(function(tax) {
    var value = cells[tax.index];
    if (freeeEmptyValue_(value)) return;
    var known = typeof value === 'string' &&
      Object.prototype.hasOwnProperty.call(freeeTaxByName_(), value);
    if (!known) {
      add('TAX_NAME_UNKNOWN', tax.letter,
        {value: freeeTruncate_(value, 40), hint: freeeTaxHint_(value)});
      return;
    }
    var category = freeeTaxByName_()[value];
    if (category.from && validDate) {
      var from = freeeIsoToSerial_(category.from);
      var to = freeeIsoToSerial_(category.to);
      if (cells[0] < from || cells[0] > to) {
        add('TAX_DATE_MISMATCH', tax.letter, {value: freeeTruncate_(value, 40)});
      }
    }
  });

  [{index: 16, letter: 'Q'}, {index: 30, letter: 'AE'}].forEach(function(tax) {
    var value = cells[tax.index];
    if (!freeeEmptyValue_(value) && !freeeFiniteNumber_(value)) {
      add('TAX_AMOUNT_INVALID', tax.letter);
    }
  });

  return problems;
}

/** 入力用と取込用の照合（§3.7）。 */
function freeeCompareInput_(inputValues, headerRow, mapping, dataRows) {
  var inputProblems = [];
  var inputProblemCount = 0;
  var inputRows = 0;
  var inputTotal = 0;
  var amountInvalid = false;
  var debitIndex = Number(mapping.L) - 1;
  var creditIndex = Number(mapping.M) - 1;
  var debitLetter = columnLetter_(Number(mapping.L));
  var creditLetter = columnLetter_(Number(mapping.M));

  inputValues.forEach(function(row, offset) {
    var values = row || [];
    var debit = values[debitIndex];
    var credit = values[creditIndex];
    if (freeeEmptyValue_(debit) && freeeEmptyValue_(credit)) return;
    inputRows += 1;
    var inputRow = headerRow + 1 + offset;
    var invalid = false;
    if (!freeeEmptyValue_(debit) && !freeeFiniteNumber_(debit)) {
      invalid = true;
      if (inputProblems.length < FREEE_EXPORT_MAX_ROW_PROBLEMS_) {
        inputProblems.push({inputRow: inputRow, column: debitLetter});
      }
      inputProblemCount += 1;
    }
    if (!freeeEmptyValue_(credit) && !freeeFiniteNumber_(credit)) {
      invalid = true;
      if (inputProblems.length < FREEE_EXPORT_MAX_ROW_PROBLEMS_) {
        inputProblems.push({inputRow: inputRow, column: creditLetter});
      }
      inputProblemCount += 1;
    }
    amountInvalid = amountInvalid || invalid;
    if (!invalid) inputTotal += freeeEmptyValue_(debit) ? credit : debit;
  });

  var importTotal = 0;
  var importAmountInvalid = false;
  dataRows.forEach(function(row) {
    var value = row.cells[14];
    if (freeeValidAmount_(value)) importTotal += value;
    else importAmountInvalid = true;
  });

  return {
    inputRows: inputRows,
    importRows: dataRows.length,
    inputTotal: inputTotal,
    importTotal: importTotal,
    inputProblems: inputProblems,
    inputProblemCount: inputProblemCount,
    amountInvalid: amountInvalid || importAmountInvalid
  };
}

/** 行の問題を 1 件ずつ、画面の明細と同じ形（§3.9）。 */
function freeeStopEntry_(code, detail) {
  return Object.assign({code: code}, detail || {});
}

/** 一時ファイルの作成・読み返しに失敗したときの戻り値。 */
function freeeExportFailure_(fileId, destinationId, code, detail) {
  freeeRemoveQuietly_(fileId);
  var stop = freeeStopEntry_(code, detail);
  return {
    ok: false,
    created: false,
    stage: 'CONTENT',
    code: code,
    stops: [stop],
    rowProblems: [],
    rowProblemCount: 0,
    destinationSpreadsheetId: String(destinationId)
  };
}

function freeeRemoveQuietly_(fileId) {
  if (!fileId) return;
  try {
    Drive.Files.remove(String(fileId), {supportsAllDrives: true});
  } catch (error) {
    Logger.log('FREEE_EXPORT cleanup failed for ' + String(fileId) + ': ' +
      String(error && error.message || error));
  }
}

/** 一時ファイルの値を `userEnteredValue` にする。文字列は文字列のまま。 */
function freeeUserEnteredCell_(value) {
  if (freeeEmptyValue_(value)) return {};
  if (typeof value === 'string') return {userEnteredValue: {stringValue: value}};
  if (typeof value === 'number') return {userEnteredValue: {numberValue: value}};
  if (typeof value === 'boolean') return {userEnteredValue: {boolValue: value}};
  return {userEnteredValue: {stringValue: String(value)}};
}

/** 書き出す値（§3.10 の 5）。空とみなす値は空にする。 */
function freeeExportValues_(cells) {
  return cells.map(function(value) { return freeeEmptyValue_(value) ? '' : value; });
}

/** 古い一時ファイルの後片付け（§3.12）。失敗しても作るのは止めない。 */
function freeeCleanupOldExports_(workFolderId) {
  var now = Date.now();
  var removed = 0;
  var pageToken = null;
  for (var page = 0; page < FREEE_EXPORT_CLEANUP_PAGES_; page += 1) {
    var request = {
      q: "'" + workFolderId + "' in parents and trashed = false and " +
        "appProperties has { key='ccExportKind' and value='FREEE_EXPORT' }",
      fields: 'nextPageToken, files(id, mimeType, createdTime, parents, appProperties)',
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    };
    if (pageToken) request.pageToken = pageToken;
    var response;
    try {
      response = Drive.Files.list(request);
    } catch (error) {
      Logger.log('FREEE_EXPORT cleanup list failed: ' +
        String(error && error.message || error));
      return;
    }
    var files = response && response.files || [];
    for (var index = 0; index < files.length; index += 1) {
      if (removed >= FREEE_EXPORT_MAX_CLEANUP_FILES_) break;
      var file = files[index] || {};
      var properties = file.appProperties || {};
      if (String(properties.ccExportKind) !== 'FREEE_EXPORT') continue;
      if (String(file.mimeType) !== 'application/vnd.google-apps.spreadsheet') continue;
      var parents = (file.parents || []).map(String);
      if (parents.indexOf(String(workFolderId)) < 0) continue;
      var created = Date.parse(String(file.createdTime || ''));
      if (!isFinite(created)) continue;
      if (now - created < FREEE_EXPORT_STALE_MS_) continue;
      try {
        Drive.Files.remove(String(file.id), {supportsAllDrives: true});
        removed += 1;
      } catch (error) {
        Logger.log('FREEE_EXPORT cleanup remove failed for ' + String(file.id) +
          ': ' + String(error && error.message || error));
      }
    }
    pageToken = response && response.nextPageToken;
    if (!pageToken || removed >= FREEE_EXPORT_MAX_CLEANUP_FILES_) break;
  }
}

/** 読み返しの 1 セル比較。文字列・数値・真偽は `===`、空は返らないか `''`。 */
function freeeVerifyWritten_(fileId, expectedRows) {
  var response = sheetsBatchGetPaced_(fileId, {
    ranges: [quoteSheetName_(FREEE_IMPORT_SHEET_NAME_) + '!A1:AF'],
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
    majorDimension: 'ROWS'
  });
  var actualRows = response && response.valueRanges && response.valueRanges[0] &&
    response.valueRanges[0].values || [];
  if (actualRows.length !== expectedRows.length) {
    return {row: Math.min(actualRows.length, expectedRows.length) + 1, column: 'A'};
  }
  for (var row = 0; row < expectedRows.length; row += 1) {
    var actualRow = actualRows[row] || [];
    for (var column = 0; column < FREEE_IMPORT_HEADERS_.length; column += 1) {
      var expected = expectedRows[row][column];
      var actual = actualRow[column];
      actual = actual === undefined || actual === null ? '' : actual;
      var same = expected === '' ? actual === '' : actual === expected;
      if (!same) {
        return {row: row + 1, column: columnLetter_(column + 1)};
      }
    }
  }
  return null;
}

/**
 * freee 取込用 Excel を作る本体（§3）。
 *
 * @param {!Object} customer 認可済みの顧客（`destinationSpreadsheetId` を差し替えたもの）
 * @param {string} destinationId このセッションの転記先
 * @param {!Array<string>} fileIds このセッションで取り込んだファイル
 * @param {boolean} acceptUnbalanced `true` のときだけ不一致を承知したとみなす
 * @return {!Object} §3.9 の止めの値、または §3.13 のできた値
 */
function freeeExportCreate_(customer, destinationId, fileIds, acceptUnbalanced) {
  var workFolderId = String(SETTINGS.PARALLEL_WORK_FOLDER_ID || '').trim();
  if (!workFolderId) return freeePreconditionStop_('WORK_FOLDER_MISSING', destinationId);

  var mapping = customer.columnMapping || {};
  if (!mapping.L) return freeePreconditionStop_('TEMPLATE_UNSUPPORTED', destinationId);

  var destination = SpreadsheetApp.openById(destinationId);
  var importSheet = destination.getSheetByName(FREEE_IMPORT_SHEET_NAME_);
  if (!importSheet) return freeePreconditionStop_('IMPORT_SHEET_MISSING', destinationId);

  var headerRow = Number(customer.headerRow);
  var lastColumn = Number(customer.rowScanLastColumn);
  var inputSheetName = String(customer.destinationSheetName);
  var read = freeeReadDestination_(destinationId, inputSheetName, headerRow, lastColumn);
  var importValues = read[0];
  var cardName = read[1] && read[1][0] !== undefined ? read[1][0] : '';
  var inputValues = read[2];

  var headerCells = importValues[0] || [];
  for (var headerIndex = 0; headerIndex < FREEE_IMPORT_HEADERS_.length; headerIndex += 1) {
    var actual = freeeHeaderText_(headerCells[headerIndex]);
    if (actual !== FREEE_IMPORT_HEADERS_[headerIndex]) {
      var mismatch = {
        column: columnLetter_(headerIndex + 1),
        expected: FREEE_IMPORT_HEADERS_[headerIndex],
        actual: actual
      };
      return {
        ok: false,
        created: false,
        stage: 'PRECONDITION',
        code: 'HEADER_MISMATCH',
        stops: [freeeStopEntry_('HEADER_MISMATCH', mismatch)],
        rowProblems: [],
        rowProblemCount: 0,
        destinationSpreadsheetId: String(destinationId)
      };
    }
  }

  // §3.4 行の分け方。
  var dataRows = [];
  for (var rowIndex = 1; rowIndex < importValues.length; rowIndex += 1) {
    var cells = freeeImportCells_(importValues[rowIndex]);
    if (cells.every(freeeEmptyValue_)) continue;
    dataRows.push({importRow: rowIndex + 1, cells: cells});
  }

  // §3.5 行ごとの確かめ。
  var rowProblems = [];
  dataRows.forEach(function(dataRow) {
    rowProblems = rowProblems.concat(freeeRowProblems_(dataRow.importRow, dataRow.cells));
  });

  // §3.7 入力用と取込用の照合。
  var comparison = freeeCompareInput_(inputValues, headerRow, mapping, dataRows);

  // §3.8 最終確認の照合。**同じ読取から作る。**
  var reconcileRows = [];
  inputValues.forEach(function(row, offset) {
    var values = row || [];
    var txId = values[Number(mapping.txId) - 1];
    if (freeeEmptyValue_(txId)) return;
    var amount = null;
    try {
      var signed = signedDestinationAmount_(customer, values);
      if (typeof signed === 'number') amount = signed;
    } catch (ignored) {
      // 読めない金額は §3.7 の INPUT_AMOUNT_INVALID が名指しする。ここでは止めない。
    }
    reconcileRows.push({
      rowNumber: headerRow + 1 + offset,
      txId: String(txId),
      cells: [],
      amount: amount
    });
  });
  var reconciliation = finalReviewReconcile_(customer, reconcileRows, fileIds || []);

  var reviewRowNumbers = [];
  var writeRowNumbers = [];
  reconcileRows.forEach(function(row) {
    var status = reconciliation.statusByTxId[row.txId];
    if (status === 'REVIEW_REQUIRED') reviewRowNumbers.push(row.rowNumber);
    if (status === 'PREPARED' || status === 'WRITING') writeRowNumbers.push(row.rowNumber);
  });
  var foreignRowNumbers = [];
  var foreignCount = 0;
  (reconciliation.problems || []).forEach(function(problem) {
    if (problem.kind !== 'FOREIGN_CUSTOMER') return;
    foreignCount += 1;
    (problem.rowNumbers || []).forEach(function(rowNumber) {
      if (foreignRowNumbers.length < FREEE_EXPORT_MAX_ROW_NUMBERS_) {
        foreignRowNumbers.push(rowNumber);
      }
    });
  });
  var unbalanced = reconciliation.totals.balanced !== true;

  // §3.9 CONTENT の止め（この順で全部）。
  var stops = [];
  var cardText = freeeEmptyValue_(cardName) ? '' : String(cardName);
  if (freeeEmptyValue_(cardName) || cardText.indexOf('○') >= 0 || cardText.indexOf('〇') >= 0) {
    stops.push(freeeStopEntry_('CARD_NAME_PLACEHOLDER'));
  }
  if (!dataRows.length) stops.push(freeeStopEntry_('NO_DATA_ROWS'));
  if (rowProblems.length) {
    stops.push(freeeStopEntry_('ROW_PROBLEMS', {count: rowProblems.length}));
  }
  if (comparison.inputProblemCount) {
    stops.push(freeeStopEntry_('INPUT_AMOUNT_INVALID', {
      count: comparison.inputProblemCount,
      rows: comparison.inputProblems
    }));
  }
  if (comparison.inputRows !== comparison.importRows) {
    stops.push(freeeStopEntry_('ROW_COUNT_MISMATCH', {
      inputRows: comparison.inputRows,
      importRows: comparison.importRows
    }));
  }
  if (!comparison.amountInvalid &&
      comparison.inputTotal !== comparison.importTotal) {
    stops.push(freeeStopEntry_('AMOUNT_TOTAL_MISMATCH', {
      inputTotal: comparison.inputTotal,
      importTotal: comparison.importTotal
    }));
  }
  if (reviewRowNumbers.length) {
    stops.push(freeeStopEntry_('REVIEW_REMAINING', {
      count: reviewRowNumbers.length,
      rowNumbers: reviewRowNumbers.slice(0, FREEE_EXPORT_MAX_ROW_NUMBERS_)
    }));
  }
  if (writeRowNumbers.length) {
    stops.push(freeeStopEntry_('WRITE_IN_PROGRESS', {
      count: writeRowNumbers.length,
      rowNumbers: writeRowNumbers.slice(0, FREEE_EXPORT_MAX_ROW_NUMBERS_)
    }));
  }
  if (foreignCount) {
    stops.push(freeeStopEntry_('FOREIGN_CUSTOMER', {
      count: foreignCount,
      rowNumbers: foreignRowNumbers
    }));
  }
  if (stops.length) {
    return freeeExportStop_('CONTENT', stops[0].code, stops, destinationId, rowProblems);
  }

  // §3.9 CONFIRM：不一致は承知したときだけ作る。
  if (unbalanced && acceptUnbalanced !== true) {
    var kinds = Object.create(null);
    (reconciliation.problems || []).forEach(function(problem) {
      kinds[problem.kind] = (kinds[problem.kind] || 0) + 1;
    });
    var problemKinds = {};
    Object.keys(kinds).forEach(function(key) { problemKinds[key] = kinds[key]; });
    return freeeExportStop_('CONFIRM', 'UNBALANCED', [freeeStopEntry_('UNBALANCED', {
      problemCount: (reconciliation.problems || []).length,
      problemKinds: problemKinds,
      residual: reconciliation.totals.residual
    })], destinationId, rowProblems);
  }

  // §3.10 一時ファイルを作る・読み返す。
  freeeCleanupOldExports_(workFolderId);

  var destinationName = DriveApp.getFileById(destinationId).getName();
  var exportName = String(destinationName) + '_freee取込';
  var exportFileId = null;
  var action = 'create';
  try {
    var created = Drive.Files.create({
      name: exportName,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [workFolderId],
      appProperties: {
        ccExportKind: 'FREEE_EXPORT',
        ccCustomerId: String(customer.customerId),
        ccDestinationId: String(destinationId)
      }
    }, null, {supportsAllDrives: true});
    exportFileId = String(created.id);

    var metadata = Sheets.Spreadsheets.get(exportFileId, {fields: 'sheets.properties'});
    var sheets = metadata && metadata.sheets || [];
    if (sheets.length !== 1 || !sheets[0].properties ||
        !Number.isInteger(Number(sheets[0].properties.sheetId))) {
      action = 'unexpected';
    } else {
      var sheetId = Number(sheets[0].properties.sheetId);
      var exportRows = [FREEE_IMPORT_HEADERS_.slice()];
      dataRows.forEach(function(dataRow) {
        exportRows.push(freeeExportValues_(dataRow.cells));
      });
      var requests = [{
        updateSheetProperties: {
          properties: {
            sheetId: sheetId,
            title: FREEE_IMPORT_SHEET_NAME_,
            gridProperties: {rowCount: exportRows.length, columnCount: 32}
          },
          fields: 'title,gridProperties.rowCount,gridProperties.columnCount'
        }
      }, {
        updateCells: {
          start: {sheetId: sheetId, rowIndex: 0, columnIndex: 0},
          rows: exportRows.map(function(row) {
            return {values: row.map(freeeUserEnteredCell_)};
          }),
          fields: 'userEnteredValue'
        }
      }, {
        repeatCell: {
          range: {
            sheetId: sheetId,
            startRowIndex: 1,
            endRowIndex: exportRows.length,
            startColumnIndex: 0,
            endColumnIndex: 1
          },
          cell: {userEnteredFormat: {
            numberFormat: {type: 'DATE', pattern: 'yyyy/mm/dd'}
          }},
          fields: 'userEnteredFormat.numberFormat'
        }
      }];
      Sheets.Spreadsheets.batchUpdate({requests: requests}, exportFileId);

      var verifyProblem = freeeVerifyWritten_(exportFileId, exportRows);
      if (verifyProblem) {
        return freeeExportFailure_(exportFileId, destinationId,
          'WRITE_VERIFY_FAILED', verifyProblem);
      }

      // §3.11 監査（読み返しの後）。
      var total = 0;
      var emptyTaxRows = 0;
      dataRows.forEach(function(dataRow) {
        if (typeof dataRow.cells[14] === 'number') total += dataRow.cells[14];
        if (freeeEmptyValue_(dataRow.cells[15]) || freeeEmptyValue_(dataRow.cells[29])) {
          emptyTaxRows += 1;
        }
      });
      var unbalancedAccepted = acceptUnbalanced === true && unbalanced;
      appendAudit({
        type: 'FREEE_EXPORT',
        actor: activeUserEmail_(),
        targetType: 'DESTINATION',
        targetId: String(destinationId),
        customerId: String(customer.customerId),
        after: {
          exportFileId: exportFileId,
          rows: dataRows.length,
          total: total,
          emptyTaxRows: emptyTaxRows,
          unbalancedAccepted: unbalancedAccepted,
          problemCount: (reconciliation.problems || []).length
        },
        reason: 'FREEE_EXPORT'
      });

      return {
        ok: true,
        created: true,
        exportSpreadsheetId: exportFileId,
        fileName: exportName + '.xlsx',
        rows: dataRows.length,
        total: total,
        emptyTaxRows: emptyTaxRows,
        unbalancedAccepted: unbalancedAccepted,
        problemCount: (reconciliation.problems || []).length,
        createdAt: nowIso_(),
        destinationSpreadsheetId: String(destinationId)
      };
    }
  } catch (error) {
    freeeRemoveQuietly_(exportFileId);
    throw error;
  }

  if (action === 'unexpected') {
    return freeeExportFailure_(exportFileId, destinationId, 'EXPORT_FILE_UNEXPECTED');
  }
  return freeeExportFailure_(exportFileId, destinationId, 'EXPORT_FILE_UNEXPECTED');
}

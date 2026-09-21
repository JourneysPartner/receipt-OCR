'use strict';

/** @param {string} code @param {string} message @return {!Error} */
function fileReaderError_(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

/** @param {!Array<number>} bytes @return {!Array<number>} */
function signedByteArray_(bytes) {
  if (!Array.isArray(bytes) && !ArrayBuffer.isView(bytes)) {
    throw new TypeError('A byte array is required');
  }
  return Array.prototype.map.call(bytes, function(byte) {
    var unsigned = (Number(byte) + 256) & 0xff;
    return unsigned > 127 ? unsigned - 256 : unsigned;
  });
}

/**
 * @param {!Array<number>} bytes
 * @param {string} charset
 * @return {string}
 */
function decodeBytes_(bytes, charset) {
  return Utilities.newBlob(signedByteArray_(bytes)).getDataAsString(charset);
}

/**
 * 置換文字・制御文字・期待キーワードを解析する。
 * @param {string} text
 * @param {string} encoding
 * @param {!Array<string>} expectedKeywords
 * @return {!Object}
 */
function analyzeDecodedText_(text, encoding, expectedKeywords) {
  var chars = Array.from(text);
  var denominator = Math.max(chars.length, 1);
  var replacements = 0;
  var controls = 0;
  chars.forEach(function(character) {
    var code = character.codePointAt(0);
    if (code === 0xfffd) {
      replacements += 1;
    }
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
        (code >= 0x7f && code <= 0x9f)) {
      controls += 1;
    }
  });
  var replacementRatio = replacements / denominator;
  var controlRatio = controls / denominator;
  var keywords = Array.isArray(expectedKeywords) ? expectedKeywords : [];
  return {
    encoding: encoding,
    text: text,
    replacementRatio: replacementRatio,
    controlRatio: controlRatio,
    replacementExceeded: replacementRatio > SETTINGS.REPLACEMENT_CHAR_RATIO_THRESHOLD,
    controlExceeded: controlRatio > SETTINGS.CONTROL_CHAR_RATIO_THRESHOLD,
    keywordMatched: keywords.some(function(keyword) {
      return typeof keyword === 'string' && keyword !== '' && text.indexOf(keyword) !== -1;
    })
  };
}

/**
 * §5.2の候補選択。判定3は判定1・2で決着しないときだけ用いる。
 * @param {!Array<!Object>} candidates
 * @return {!Object}
 */
function selectEncodingCandidate_(candidates) {
  if (!Array.isArray(candidates) || candidates.length !== 2) {
    throw new TypeError('Exactly two encoding candidates are required');
  }
  var clean = candidates.filter(function(candidate) {
    return !candidate.replacementExceeded && !candidate.controlExceeded;
  });
  if (clean.length === 1) {
    return clean[0];
  }
  if (clean.length === 2) {
    return clean.filter(function(candidate) { return candidate.encoding === 'UTF-8'; })[0] || clean[0];
  }

  var keywordMatches = candidates.filter(function(candidate) { return candidate.keywordMatched; });
  if (keywordMatches.length === 1) {
    return keywordMatches[0];
  }
  throw fileReaderError_(
    'ENCODING_DETECTION_FAILED',
    'Encoding candidates cannot be distinguished'
  );
}

/**
 * UTF-8/Shift_JISを判定する。BOM判定を必ず最初に行う。
 * expectedKeywordsは純粋ロジック試験用にF列のキーワードを受け取る。
 * @param {!Array<number>} bytes
 * @param {!Array<string>=} expectedKeywords
 * @return {!Object}
 */
function detectEncoding(bytes, expectedKeywords) {
  var unsigned = Array.prototype.map.call(bytes, function(byte) {
    return (Number(byte) + 256) & 0xff;
  });
  if ((unsigned[0] === 0xff && unsigned[1] === 0xfe) ||
      (unsigned[0] === 0xfe && unsigned[1] === 0xff)) {
    throw fileReaderError_('ENCODING_DETECTION_FAILED', 'UTF-16 is not supported');
  }
  if (unsigned[0] === 0xef && unsigned[1] === 0xbb && unsigned[2] === 0xbf) {
    var withoutBom = unsigned.slice(3);
    return {
      encoding: 'UTF-8',
      confidence: 1,
      mojibake: false,
      bomRemoved: true,
      headerKeywordMatched: null,
      text: decodeBytes_(withoutBom, 'UTF-8')
    };
  }

  var candidates = [
    analyzeDecodedText_(decodeBytes_(unsigned, 'UTF-8'), 'UTF-8', expectedKeywords),
    analyzeDecodedText_(decodeBytes_(unsigned, 'Shift_JIS'), 'Shift_JIS', expectedKeywords)
  ];
  var selected = selectEncodingCandidate_(candidates);
  return {
    encoding: selected.encoding,
    confidence: (!selected.replacementExceeded && !selected.controlExceeded) ? 1 : 0.5,
    mojibake: selected.replacementExceeded || selected.controlExceeded,
    bomRemoved: false,
    headerKeywordMatched: selected.keywordMatched,
    replacementRatio: selected.replacementRatio,
    controlRatio: selected.controlRatio,
    text: selected.text
  };
}

/**
 * RFC 4180論理レコードと先頭物理行番号を返す。
 * @param {string} text
 * @return {{rows:!Array<!Array<string>>, recordStarts:!Array<number>}}
 */
function parseCsv(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseCsv requires decoded text');
  }
  if (text === '') {
    return {rows: [], recordStarts: []};
  }

  var rows = [];
  var recordStarts = [];
  var row = [];
  var field = '';
  var quoted = false;
  var physicalRow = 1;
  var recordStart = 1;
  var recordTouched = false;
  var endedWithRecordSeparator = false;

  function pushRecord() {
    row.push(field);
    rows.push(row);
    recordStarts.push(recordStart);
    row = [];
    field = '';
    recordTouched = false;
  }

  for (var index = 0; index < text.length; index += 1) {
    var character = text.charAt(index);
    endedWithRecordSeparator = false;
    if (quoted) {
      if (character === '"') {
        if (text.charAt(index + 1) === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else if (character === '\r' || character === '\n') {
        if (character === '\r' && text.charAt(index + 1) === '\n') {
          field += '\r\n';
          index += 1;
        } else {
          field += character;
        }
        physicalRow += 1;
      } else {
        field += character;
      }
      recordTouched = true;
      continue;
    }

    if (character === '"' && field === '') {
      quoted = true;
      recordTouched = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
      recordTouched = true;
    } else if (character === '\r' || character === '\n') {
      pushRecord();
      if (character === '\r' && text.charAt(index + 1) === '\n') {
        index += 1;
      }
      physicalRow += 1;
      recordStart = physicalRow;
      endedWithRecordSeparator = true;
    } else {
      field += character;
      recordTouched = true;
    }
  }

  if (quoted) {
    throw fileReaderError_('CSV_PARSE_FAILED', 'CSV quoted field is not closed');
  }
  if (!endedWithRecordSeparator && (recordTouched || row.length > 0 || field !== '')) {
    pushRecord();
  }
  return {rows: rows, recordStarts: recordStarts};
}

/**
 * 入力容量上限の検査（4.10・仕様23.3）。null/undefinedの引数は
 * 「その値をまだ検査しない」ことを表す ── 読取の段階ごとに分かった値だけを
 * 検査できるようにするため（サイズ→シート数→行数の順に判明する）。
 *
 * @param {string} fileId
 * @param {?number} blobSize
 * @param {?number} sheetCount
 * @param {?number} rowCount 取得済み行数。`MAX_ROWS_PER_FILE`に**達した**時点で
 *   超過とする（5.3 読取終了条件3：達した＝それ以降が読めていない疑い）
 */
function checkInputLimits(fileId, blobSize, sheetCount, rowCount) {
  if (blobSize !== null && blobSize !== undefined &&
      Number(blobSize) > SETTINGS.MAX_FILE_BYTES) {
    throw new InputLimitError('File ' + fileId + ' exceeds MAX_FILE_BYTES: ' + blobSize);
  }
  if (sheetCount !== null && sheetCount !== undefined &&
      Number(sheetCount) > SETTINGS.MAX_SHEETS_PER_FILE) {
    throw new InputLimitError('File ' + fileId + ' exceeds MAX_SHEETS_PER_FILE: ' + sheetCount);
  }
  if (rowCount !== null && rowCount !== undefined &&
      Number(rowCount) >= SETTINGS.MAX_ROWS_PER_FILE) {
    throw new InputLimitError('File ' + fileId + ' reaches MAX_ROWS_PER_FILE: ' + rowCount);
  }
}

/**
 * XLSXを一時的なGoogleスプレッドシートへ変換する（4.10）。
 *
 * 一時ファイルは作業用フォルダへ作り、顧客フォルダへ作らない。
 * **一時ファイルIDを取引ID生成に使ってはならない**（変換のたびに変わる）。
 */
function convertXlsxToTemp(fileId) {
  var resource = {
    mimeType: 'application/vnd.google-apps.spreadsheet',
    name: 'tmp_import_' + String(fileId)
  };
  if (SETTINGS.PARALLEL_WORK_FOLDER_ID) {
    resource.parents = [SETTINGS.PARALLEL_WORK_FOLDER_ID];
  }
  var created = Drive.Files.copy(resource, fileId, {supportsAllDrives: true});
  return {tempFileId: created.id, spreadsheet: SpreadsheetApp.openById(created.id)};
}

/**
 * 一時変換ファイルの削除。例外経路を含め必ず呼ぶ（4.10の契約）。
 * 削除の失敗は元処理の結果を壊さない ── 記録して続行する（一時ファイルの
 * 残存は容量監視 4.37 が拾う）。
 */
function disposeTemp(tempFileId) {
  if (!tempFileId) return;
  try {
    Drive.Files.remove(tempFileId);
  } catch (error) {
    Logger.log('disposeTemp failed for ' + tempFileId + ': ' + (error && error.message));
  }
}

/**
 * CSV／XLSXを論理レコードの配列として読む（4.10）。
 *
 * バイト列の生成は1回に限り、戻り値の`bytes`をハッシュ計算・サイズ検査と
 * 共有する。ファイルバイナリハッシュは**BOMを含む元のバイト列**が対象
 * なので、ここでは除去後のバイト列を返さない。
 *
 * @param {string} fileId
 * @param {string} fileName 拡張子の判定に用いる（元ファイル名）
 * @param {!Object=} options {expectedKeywords: 5.2 判定3用のF列キーワード和集合}
 * @return {{sheets:!Array<{name:?string, rows:!Array<!Array<*>>,
 *   recordStarts:?Array<number>}>, encoding:?string, bomRemoved:boolean,
 *   fileType:string, bytes:!Array<number>}}
 */
function readFile(fileId, fileName, options) {
  var opts = options || {};
  var lower = String(fileName || '').toLowerCase();
  var fileType = /\.csv$/.test(lower) ? 'csv' : (/\.xlsx$/.test(lower) ? 'xlsx' : null);
  if (!fileType) {
    throw new TypeError('readFile supports only .csv/.xlsx: ' + fileName);
  }

  stepAt_ = Date.now();
  var bytes = DriveApp.getFileById(fileId).getBlob().getBytes();
  step_('read:blob');
  checkInputLimits(fileId, bytes.length, null, null);

  if (fileType === 'csv') {
    var detection = detectEncoding(bytes, opts.expectedKeywords || []);
    var parsed = parseCsv(detection.text);
    step_('read:decode');
    checkInputLimits(fileId, null, 1, parsed.rows.length);
    return {
      sheets: [{name: null, rows: parsed.rows, recordStarts: parsed.recordStarts}],
      encoding: detection.encoding,
      bomRemoved: detection.bomRemoved,
      fileType: 'csv',
      bytes: bytes
    };
  }

  var temp = convertXlsxToTemp(fileId);
  step_('read:convert');
  try {
    var sheetObjects = temp.spreadsheet.getSheets();
    checkInputLimits(fileId, null, sheetObjects.length, null);
    var sheets = sheetObjects.map(function(sheet) {
      // M29：1行目・1列目から固定長で読み、配列インデックス＋1＝物理行番号
      // を保つ。要求範囲はグリッドを超えない。
      var rowCount = Math.min(SETTINGS.MAX_ROWS_PER_FILE, sheet.getMaxRows());
      var columnCount = Math.min(SETTINGS.MAX_COLUMNS_PER_FILE, sheet.getMaxColumns());
      var values = sheet.getRange(1, 1, rowCount, columnCount).getValues();
      checkInputLimits(fileId, null, null, values.length);
      return {name: sheet.getName(), rows: values, recordStarts: null};
    });
    step_('read:sheets');
    return {
      sheets: sheets,
      encoding: null,
      bomRemoved: false,
      fileType: 'xlsx',
      bytes: bytes
    };
  } finally {
    disposeTemp(temp.tempFileId);
    step_('read:dispose');
  }
}

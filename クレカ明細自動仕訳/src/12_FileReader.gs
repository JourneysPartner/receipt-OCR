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

'use strict';

const SYSTEM_TIMEZONE = 'Asia/Tokyo';
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 文字列をUTF-8バイト列へ変換する。Unicode正規化は行わない。
 *
 * @param {string} s
 * @return {!Array<number>}
 */
function utf8Bytes(s) {
  if (typeof s !== 'string') {
    throw new TypeError('utf8Bytes requires a string');
  }
  return Utilities.newBlob(s, 'text/plain').getBytes();
}

/** @param {string} s @return {number} */
function utf8Len(s) {
  return utf8Bytes(s).length;
}

/**
 * バイト列のSHA-256を16進小文字64桁で返す。
 * GASのdigestは符号付きバイトを返すため、0〜255へ戻してから変換する。
 *
 * @param {!Array<number>} bytes
 * @return {string}
 */
function sha256Hex(bytes) {
  if (!Array.isArray(bytes) && !ArrayBuffer.isView(bytes)) {
    throw new TypeError('sha256Hex requires a byte array');
  }
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    Array.prototype.slice.call(bytes)
  );
  return digest.map(function(byte) {
    return ((byte < 0 ? byte + 256 : byte) & 0xff).toString(16).padStart(2, '0');
  }).join('');
}

// 呼出側で用いられる一般名。規則はsha256Hexと同一である。
function sha256(bytes) {
  return sha256Hex(bytes);
}

/**
 * シート由来の真偽値を正規化する（INV-02）。
 * @param {*} v
 * @return {boolean}
 */
function toBool(v) {
  if (v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1') {
    return true;
  }
  if (
    v === false || v === 'FALSE' || v === 'false' || v === '' ||
    v === null || v === undefined || v === 0
  ) {
    return false;
  }
  throw new TypeError('Unsupported boolean value: ' + String(v));
}

/** @param {string} prefix @return {string} */
function generateId(prefix) {
  if (typeof prefix !== 'string' || prefix === '') {
    throw new TypeError('generateId requires a non-empty prefix');
  }
  return prefix + '_' + Utilities.getUuid();
}

/**
 * @param {*} value
 * @return {boolean}
 */
function isDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

/**
 * タイムゾーン付きISO 8601文字列を返す。
 * @param {!Date} date
 * @return {string}
 */
function toIso8601(date) {
  if (!isDate_(date) || isNaN(date.getTime())) {
    throw new TypeError('toIso8601 requires a valid Date');
  }
  return Utilities.formatDate(date, SYSTEM_TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/**
 * 指数表記を使わない正準10進文字列へ変換する。
 * @param {number|string|bigint} value
 * @return {string}
 */
function toDecimalString(value) {
  if (typeof value === 'number' && !isFinite(value)) {
    throw new TypeError('Decimal value must be finite');
  }

  var source = String(value);
  var match = source.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!match) {
    throw new TypeError('Invalid decimal value: ' + source);
  }

  var sign = match[1] === '-' ? '-' : '';
  var integerPart = match[2];
  var fractionPart = match[3] || '';
  var exponent = match[4] ? Number(match[4]) : 0;
  if (!Number.isSafeInteger(exponent)) {
    throw new RangeError('Decimal exponent is out of range');
  }

  var digits = integerPart + fractionPart;
  var decimalPosition = integerPart.length + exponent;
  var expanded;
  if (decimalPosition <= 0) {
    expanded = '0.' + '0'.repeat(-decimalPosition) + digits;
  } else if (decimalPosition >= digits.length) {
    expanded = digits + '0'.repeat(decimalPosition - digits.length);
  } else {
    expanded = digits.slice(0, decimalPosition) + '.' + digits.slice(decimalPosition);
  }

  var parts = expanded.split('.');
  var normalizedInteger = parts[0].replace(/^0+(?=\d)/, '');
  var normalizedFraction = (parts[1] || '').replace(/0+$/, '');
  var normalized = normalizedFraction ? normalizedInteger + '.' + normalizedFraction : normalizedInteger;

  if (/^0(?:\.0*)?$/.test(normalized)) {
    sign = '';
  }
  return sign + normalized;
}

/**
 * 整数円を安全なJavaScript整数へ変換する。
 * @param {number|string|bigint} value
 * @return {number}
 */
function toJpyInteger(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError('JPY amount must be a safe integer');
    }
    return Object.is(value, -0) ? 0 : value;
  }

  var source = String(value);
  if (!/^[+-]?(?:\d{1,3}(?:,\d{3})*|\d+)$/.test(source)) {
    throw new TypeError('JPY amount must be an integer: ' + source);
  }
  var integerText = source.replace(/,/g, '');
  var result = Number(integerText);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('JPY amount is outside the safe integer range');
  }
  return Object.is(result, -0) ? 0 : result;
}

/**
 * その年月日が実在するかを返す。Dateの桁上がりを実在とみなさない。
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @return {boolean}
 */
function dateExists(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  var probe = new Date(0);
  probe.setUTCHours(0, 0, 0, 0);
  probe.setUTCFullYear(year, month - 1, day);
  return probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
}

/** @param {number} year @param {number} month @return {number} */
function monthOrdinal(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new TypeError('monthOrdinal requires an integer year and month 1..12');
  }
  return year * 12 + (month - 1);
}

/**
 * Asia/Tokyoの指定日0時を表すDateを作る。
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @param {number=} millisInDay
 * @return {!Date}
 */
function tokyoDate_(year, month, day, millisInDay) {
  if (!dateExists(year, month, day)) {
    throw new RangeError('Date does not exist: ' + year + '-' + month + '-' + day);
  }
  return new Date(Date.UTC(year, month - 1, day) - 9 * 60 * 60 * 1000 + (millisInDay || 0));
}

/**
 * Excel/Sheetsのシリアル値をDateへ変換する。
 * 設計書どおりシリアル0を1899-12-30とする。
 * @param {number|string} serial
 * @return {!Date}
 */
function excelSerialToDate(serial) {
  var numeric = typeof serial === 'number' ? serial : Number(serial);
  if (!isFinite(numeric)) {
    throw new TypeError('Excel serial must be finite');
  }
  var baseTokyoMidnight = Date.UTC(1899, 11, 30) - 9 * 60 * 60 * 1000;
  return new Date(baseTokyoMidnight + numeric * MILLIS_PER_DAY);
}

/**
 * 明示的な日付表現だけをAsia/Tokyo基準のDateへ変換する。
 * @param {*} value
 * @param {string=} timezone
 * @return {!Date}
 */
function parseDate(value, timezone) {
  var zone = timezone || SYSTEM_TIMEZONE;
  if (zone !== SYSTEM_TIMEZONE) {
    throw new RangeError('Unsupported timezone: ' + zone);
  }
  if (isDate_(value)) {
    if (isNaN(value.getTime())) {
      throw new TypeError('Invalid Date');
    }
    return new Date(value.getTime());
  }
  if (typeof value === 'number') {
    return excelSerialToDate(value);
  }
  if (typeof value !== 'string') {
    throw new TypeError('Unsupported date value');
  }

  var dateOnly = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (dateOnly) {
    return tokyoDate_(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
  }
  var compact = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return tokyoDate_(Number(compact[1]), Number(compact[2]), Number(compact[3]));
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && /(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    var parsed = new Date(value);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw new TypeError('Unsupported date string: ' + value);
}

/**
 * DateをAsia/Tokyoの日付文字列へ変換する。
 * @param {!Date} date
 * @return {string}
 */
function toTokyoDateString_(date) {
  return Utilities.formatDate(date, SYSTEM_TIMEZONE, 'yyyy-MM-dd');
}

/**
 * セル値を5.6.2の正準文字列へ変換する。
 * @param {*} value
 * @return {?string}
 */
function cellToCanonicalString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return toDecimalString(value);
  }
  if (isDate_(value)) {
    if (isNaN(value.getTime())) {
      throw new TypeError('Invalid Date');
    }
    return toTokyoDateString_(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  return String(value);
}

/**
 * 5.6.1の逐語定義に従って要素を決定的に直列化する。
 * @param {!Array<*>} elements
 * @return {string}
 */
function serializeDeterministic(elements) {
  if (!Array.isArray(elements)) {
    throw new TypeError('serializeDeterministic requires an array');
  }
  return elements.map(function(element) {
    if (element === null || element === undefined) {
      return '-1:';
    }
    var canonical = cellToCanonicalString(element);
    return String(utf8Len(canonical)) + ':' + canonical;
  }).join('');
}

/**
 * 5.6.3のdataHashを計算する。全セルが空の行は含めない。
 * @param {!Array<!Array<*>>} rows
 * @return {string}
 */
function computeDataHash(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('computeDataHash requires rows');
  }
  var serializedRows = rows.filter(function(row) {
    if (!Array.isArray(row)) {
      throw new TypeError('Each data hash row must be an array');
    }
    return row.some(function(value) {
      return value !== null && value !== undefined && value !== '';
    });
  }).map(function(row) {
    return serializeDeterministic(row.map(cellToCanonicalString));
  });
  var outer = serializeDeterministic([VERSIONS.HASH].concat(serializedRows));
  return sha256Hex(utf8Bytes(outer));
}

/**
 * 5.5の列別規則で読取値を正準化する。
 * @param {string} column
 * @param {*} raw
 * @return {*}
 */
function normalizeReadValue(column, raw) {
  var normalizedColumn = String(column).toUpperCase();
  if (normalizedColumn === 'B') {
    if (raw === null || raw === undefined || raw === '') {
      return '';
    }
    return toTokyoDateString_(parseDate(raw, SYSTEM_TIMEZONE));
  }
  if (
    normalizedColumn === 'F' || normalizedColumn === 'I' ||
    normalizedColumn === 'K' || normalizedColumn === 'INTERNAL_TRANSACTION_ID'
  ) {
    return raw === null || raw === undefined ? '' : String(raw);
  }
  if (normalizedColumn === 'M') {
    return raw === null || raw === undefined || raw === '' ? '' : toJpyInteger(raw);
  }
  return raw;
}

/**
 * 予定値と読取値を§5.5の列別正準化後に比較する。
 * @param {string} column
 * @param {*} planned
 * @param {*} raw
 * @return {boolean}
 */
function canonicalReadValuesEqual(column, planned, raw) {
  var normalizedPlanned = normalizeReadValue(column, planned);
  var normalizedRead = normalizeReadValue(column, raw);
  return normalizedPlanned === normalizedRead;
}

/**
 * B/F/I/K/M列の転記行ハッシュを計算する。
 * @param {!Array<*>|!Object} values
 * @return {string}
 */
function hashRowValues(values) {
  var ordered;
  if (Array.isArray(values)) {
    if (values.length !== 5) {
      throw new RangeError('hashRowValues requires exactly five values');
    }
    ordered = values;
  } else if (values && typeof values === 'object') {
    ordered = [
      values.B !== undefined ? values.B : values.b,
      values.F !== undefined ? values.F : values.f,
      values.I !== undefined ? values.I : values.i,
      values.K !== undefined ? values.K : values.k,
      values.M !== undefined ? values.M : values.m
    ];
  } else {
    throw new TypeError('hashRowValues requires an array or object');
  }

  var canonical = [
    normalizeReadValue('B', ordered[0]),
    normalizeReadValue('F', ordered[1]),
    normalizeReadValue('I', ordered[2]),
    normalizeReadValue('K', ordered[3]),
    normalizeReadValue('M', ordered[4])
  ];
  var serialized = serializeDeterministic([VERSIONS.HASH].concat(canonical));
  return sha256Hex(utf8Bytes(serialized));
}

/**
 * attempt=1..3の指数バックオフとジッターを返す。
 * @param {number} attempt
 * @return {number}
 */
function computeBackoffMs(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 3) {
    throw new RangeError('attempt must be 1, 2, or 3');
  }
  var base = SETTINGS.RETRY_BASE_BACKOFF_MS;
  if (!Number.isInteger(base) || base <= 0) {
    throw new Error('RETRY_BASE_BACKOFF_MS is not configured');
  }
  return base * Math.pow(2, attempt - 1) + Math.floor(Math.random() * base);
}

/**
 * rowまたはrowNumberを持つ書込情報を、入力順の連続行ごとにまとめる。
 * @param {!Array<!Object>} rowWrites
 * @return {!Array<!Object>}
 */
function groupConsecutiveRows(rowWrites) {
  if (!Array.isArray(rowWrites)) {
    throw new TypeError('groupConsecutiveRows requires an array');
  }
  var groups = [];
  rowWrites.forEach(function(write) {
    var row = write && Number.isInteger(write.row) ? write.row : write && write.rowNumber;
    if (!Number.isInteger(row) || row < 1) {
      throw new TypeError('Each row write requires a positive row or rowNumber');
    }
    var last = groups.length ? groups[groups.length - 1] : null;
    if (!last || row !== last.endRow + 1) {
      groups.push({startRow: row, endRow: row, rowWrites: [write]});
    } else {
      last.endRow = row;
      last.rowWrites.push(write);
    }
  });
  return groups;
}

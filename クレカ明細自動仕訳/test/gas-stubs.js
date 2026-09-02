'use strict';

const crypto = require('node:crypto');

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (Array.isArray(data) || ArrayBuffer.isView(data)) {
    return Buffer.from(Array.from(data, (byte) => (Number(byte) + 256) & 0xff));
  }
  return Buffer.from(String(data), 'utf8');
}

function signedBytes(buffer) {
  return Array.from(buffer, (byte) => (byte > 127 ? byte - 256 : byte));
}

function zonedParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  return Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
}

function timezoneOffset(date, timezone, parts) {
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offsetMinutes = Math.round((asUtc - date.getTime()) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function formatDate(date, timezone, pattern) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('Utilities.formatDate requires a valid Date');
  }
  const parts = zonedParts(date, timezone);
  if (pattern === 'yyyy') return parts.year;
  if (pattern === 'yyyy-MM-dd') return `${parts.year}-${parts.month}-${parts.day}`;
  if (pattern === "yyyy-MM-dd'T'HH:mm:ssXXX") {
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${timezoneOffset(date, timezone, parts)}`;
  }
  throw new Error(`Unsupported Utilities.formatDate pattern in test stub: ${pattern}`);
}

function createUtilitiesStub() {
  return Object.freeze({
    DigestAlgorithm: Object.freeze({SHA_256: 'SHA_256'}),
    computeDigest(algorithm, bytes) {
      if (algorithm !== 'SHA_256') throw new Error(`Unsupported digest algorithm: ${algorithm}`);
      return signedBytes(crypto.createHash('sha256').update(toBuffer(bytes)).digest());
    },
    newBlob(data, contentType, name) {
      const buffer = toBuffer(data);
      return Object.freeze({
        getBytes: () => signedBytes(buffer),
        getDataAsString: (charset = 'UTF-8') => {
          if (/^utf-?8$/i.test(charset)) return buffer.toString('utf8');
          if (/^(shift[_-]?jis|windows-31j|cp932)$/i.test(charset)) return new TextDecoder('shift_jis').decode(buffer);
          throw new Error(`Unsupported blob charset in test stub: ${charset}`);
        },
        getContentType: () => contentType || null,
        getName: () => name || null
      });
    },
    formatDate,
    getUuid: () => crypto.randomUUID(),
    sleep: () => {}
  });
}

function columnToNumber(column) {
  let result = 0;
  for (const char of String(column).toUpperCase()) {
    if (char < 'A' || char > 'Z') throw new Error(`Invalid column: ${column}`);
    result = result * 26 + char.charCodeAt(0) - 64;
  }
  return result;
}

function numberToColumn(number) {
  let value = Number(number);
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function unquoteSheetName(name) {
  const text = String(name);
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

function parseA1(a1, defaults = {}) {
  let source = String(a1);
  let sheetName = defaults.sheetName || null;
  const bang = source.lastIndexOf('!');
  if (bang >= 0) { sheetName = unquoteSheetName(source.slice(0, bang)); source = source.slice(bang + 1); }
  const pair = source.split(':');
  const parseCell = (cell, fallbackRow, fallbackColumn) => {
    const match = String(cell || '').match(/^([A-Za-z]+)?(\d+)?$/);
    if (!match) throw new Error(`Unsupported A1 notation: ${a1}`);
    return {row: match[2] ? Number(match[2]) : fallbackRow, column: match[1] ? columnToNumber(match[1]) : fallbackColumn};
  };
  const start = parseCell(pair[0], 1, 1);
  const end = parseCell(pair[1] || pair[0], defaults.maxRows || start.row, defaults.maxColumns || start.column);
  return {sheetName, row: start.row, column: start.column,
    numRows: end.row - start.row + 1, numColumns: end.column - start.column + 1};
}

function cloneCellValue(value) { return value instanceof Date ? new Date(value.getTime()) : value; }

class MemoryRange {
  constructor(sheet, row, column, numRows, numColumns) {
    this.sheet = sheet; this.row = row; this.column = column; this.numRows = numRows; this.numColumns = numColumns;
  }
  getRow() { return this.row; }
  getColumn() { return this.column; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numColumns; }
  getA1Notation() {
    const start = `${numberToColumn(this.column)}${this.row}`;
    const end = `${numberToColumn(this.column + this.numColumns - 1)}${this.row + this.numRows - 1}`;
    return start === end ? start : `${start}:${end}`;
  }
  getValues() { return this.sheet._read(this.row, this.column, this.numRows, this.numColumns, false); }
  getFormulas() { return this.sheet._read(this.row, this.column, this.numRows, this.numColumns, true); }
  getValue() { return this.getValues()[0][0]; }
  getFormula() { return this.getFormulas()[0][0]; }
  setValues(values) {
    if (!Array.isArray(values) || values.length !== this.numRows ||
        values.some((row) => !Array.isArray(row) || row.length !== this.numColumns)) {
      throw new RangeError('setValues dimensions do not match range');
    }
    this.sheet._write(this.row, this.column, values, false); return this;
  }
  setFormulas(values) {
    if (!Array.isArray(values) || values.length !== this.numRows ||
        values.some((row) => !Array.isArray(row) || row.length !== this.numColumns)) {
      throw new RangeError('setFormulas dimensions do not match range');
    }
    this.sheet._write(this.row, this.column, values, true); return this;
  }
  setValue(value) { return this.setValues([[value]]); }
  setFormula(value) { return this.setFormulas([[value]]); }
  getNumberFormats() {
    return Array.from({length: this.numRows}, (_, r) => Array.from({length: this.numColumns},
      (_, c) => this.sheet._format(this.row + r, this.column + c)));
  }
  getNumberFormat() { return this.getNumberFormats()[0][0]; }
  setNumberFormat(format) {
    for (let r = 0; r < this.numRows; r += 1) {
      for (let c = 0; c < this.numColumns; c += 1) {
        this.sheet._setFormat(this.row + r, this.column + c, format);
      }
    }
    return this;
  }
  setNumberFormats(formats) {
    formats.forEach((row, r) => row.forEach((format, c) =>
      this.sheet._setFormat(this.row + r, this.column + c, format)));
    return this;
  }
  clearContent() {
    const blanks = Array.from({length: this.numRows}, () => Array(this.numColumns).fill(''));
    this.sheet._write(this.row, this.column, blanks, false); this.sheet._write(this.row, this.column, blanks, true); return this;
  }
  // 実 Range.copyTo はセルの内容をまとめて複製する。setValues + setFormulas
  // に分解すると、空文字列の数式が直前に書いた値を消してしまう（_write を見よ）。
  // なお実 Sheets は相対参照を移動先へずらすが、ここでは式を字句のまま複製する。
  copyTo(destination) {
    const values = this.getValues();
    const formulas = this.getFormulas();
    values.forEach((row, r) => row.forEach((value, c) => {
      const cell = destination.sheet.getRange(destination.row + r, destination.column + c);
      cell.setValue(value);
      if (formulas[r][c] !== '') cell.setFormula(formulas[r][c]);
    }));
    return destination;
  }
}

class MemorySheet {
  constructor(parent, name, options = {}) {
    this.parent = parent; this.name = name;
    this.maxRows = options.maxRows || Math.max(1000, (options.values || []).length || 1);
    this.maxColumns = options.maxColumns || Math.max(26, Math.max(0, ...(options.values || []).map((r) => r.length)));
    this.values = Array.from({length: this.maxRows}, () => Array(this.maxColumns).fill(''));
    this.formulas = Array.from({length: this.maxRows}, () => Array(this.maxColumns).fill(''));
    this.beforeAppendHook = null;
    if (options.values && options.values.length) {
      const width = Math.max(1, ...options.values.map((r) => r.length));
      this.getRange(1, 1, options.values.length, width).setValues(options.values.map((row) => row.concat(Array(width - row.length).fill(''))));
    }
    if (options.formulas && options.formulas.length) {
      // 初期状態の組み立てであって「数式を書く操作」ではないので、
      // 空数式で値を消す実 Sheets の挙動（_write を見よ）は適用しない。
      options.formulas.forEach((row, r) => row.forEach((formula, c) => {
        if (formula !== '') this.formulas[r][c] = formula;
      }));
    }
  }
  getName() { return this.name; }
  setName(name) { this.name = String(name); return this; }
  getProtections() { return (this.protections || []).slice(); }
  getParent() { return this.parent; }
  getSheetId() { return this.parent.sheets.indexOf(this) + 1; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxColumns; }
  insertColumnsAfter(afterPosition, howMany) {
    const count = Number(howMany);
    if (!Number.isInteger(count) || count < 1) throw new Error('insertColumnsAfter requires a positive count');
    this.maxColumns += count;
    this.values.forEach((row) => { for (let i = 0; i < count; i += 1) row.push(''); });
    this.formulas.forEach((row) => { for (let i = 0; i < count; i += 1) row.push(''); });
    return this;
  }
  getLastRow() {
    for (let row = this.maxRows - 1; row >= 0; row -= 1) {
      if (this.values[row].some((v) => v !== '' && v !== null) || this.formulas[row].some((v) => v !== '')) return row + 1;
    }
    return 0;
  }
  getLastColumn() {
    let result = 0;
    for (let row = 0; row < this.maxRows; row += 1) {
      for (let column = this.maxColumns - 1; column >= 0; column -= 1) {
        if (this.values[row][column] !== '' || this.formulas[row][column] !== '') { result = Math.max(result, column + 1); break; }
      }
    }
    return result;
  }
  getRange(rowOrA1, column, numRows = 1, numColumns = 1) {
    if (typeof rowOrA1 === 'string') {
      const parsed = parseA1(rowOrA1, {sheetName: this.name, maxRows: this.maxRows, maxColumns: this.maxColumns});
      return this.getRange(parsed.row, parsed.column, parsed.numRows, parsed.numColumns);
    }
    const row = Number(rowOrA1);
    if (![row, column, numRows, numColumns].every(Number.isInteger) || row < 1 || column < 1 || numRows < 1 || numColumns < 1) {
      throw new RangeError('Invalid range coordinates');
    }
    this._ensureSize(row + numRows - 1, column + numColumns - 1);
    return new MemoryRange(this, row, column, numRows, numColumns);
  }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  createTextFinder(findText) {
    const sheet = this; let entire = false; let matchCase = false;
    return {
      matchEntireCell(value) { entire = Boolean(value); return this; },
      matchCase(value) { matchCase = Boolean(value); return this; },
      findAll() {
        const wanted = matchCase ? String(findText) : String(findText).toLowerCase();
        const found = [];
        for (let r = 0; r < sheet.getLastRow(); r += 1) {
          for (let c = 0; c < sheet.getLastColumn(); c += 1) {
            const raw = sheet.values[r][c];
            const text = matchCase ? String(raw) : String(raw).toLowerCase();
            if ((entire && text === wanted) || (!entire && text.includes(wanted))) found.push(sheet.getRange(r + 1, c + 1));
          }
        }
        return found;
      }
    };
  }
  appendRow(row) {
    if (this.beforeAppendHook) { const hook = this.beforeAppendHook; this.beforeAppendHook = null; hook(); }
    const target = this.getLastRow() + 1;
    this.getRange(target, 1, 1, Math.max(1, row.length)).setValues([row.length ? row : ['']]); return this;
  }
  insertRowsAfter(afterPosition, howMany) {
    if (!Number.isInteger(afterPosition) || !Number.isInteger(howMany) || howMany < 1) throw new RangeError('Invalid row insertion');
    while (this.maxRows < afterPosition) this._ensureSize(this.maxRows + 1, this.maxColumns);
    const values = Array.from({length: howMany}, () => Array(this.maxColumns).fill(''));
    const formulas = Array.from({length: howMany}, () => Array(this.maxColumns).fill(''));
    this.values.splice(afterPosition, 0, ...values); this.formulas.splice(afterPosition, 0, ...formulas); this.maxRows += howMany; return this;
  }
  deleteRow(rowPosition) {
    if (!Number.isInteger(rowPosition) || rowPosition < 1 || rowPosition > this.maxRows) throw new RangeError('Invalid row deletion');
    this.values.splice(rowPosition - 1, 1); this.formulas.splice(rowPosition - 1, 1); this.maxRows -= 1; return this;
  }
  deleteRows(rowPosition, howMany) { for (let i = 0; i < howMany; i += 1) this.deleteRow(rowPosition); return this; }
  setBeforeAppendHook(hook) { this.beforeAppendHook = hook; }
  _ensureSize(rows, columns) {
    if (columns > this.maxColumns) {
      for (const row of this.values) row.push(...Array(columns - this.maxColumns).fill(''));
      for (const row of this.formulas) row.push(...Array(columns - this.maxColumns).fill(''));
      this.maxColumns = columns;
    }
    while (this.maxRows < rows) {
      this.values.push(Array(this.maxColumns).fill('')); this.formulas.push(Array(this.maxColumns).fill('')); this.maxRows += 1;
    }
  }
  /** 表示形式。既定は自動（'General'）。 */
  _format(row, column) {
    const key = `${row}:${column}`;
    return (this.formats && this.formats[key]) || 'General';
  }
  _setFormat(row, column, format) {
    if (!this.formats) this.formats = {};
    this.formats[`${row}:${column}`] = String(format);
  }
  _read(row, column, numRows, numColumns, formulas) {
    // 走査量を検査できるようにする（INV-25）。スタブ上では全面走査も一瞬で
    // 終わるため、回数と面積で見るしかない。
    if (this.parent && this.parent.counters) {
      this.parent.counters.rangeReads += 1;
      this.parent.counters.cellsRead += numRows * numColumns;
    }
    const source = formulas ? this.formulas : this.values;
    return Array.from({length: numRows}, (_, r) => Array.from({length: numColumns}, (_, c) => cloneCellValue(source[row + r - 1][column + c - 1])));
  }
  _write(row, column, matrix, formulas) {
    this._ensureSize(row + matrix.length - 1, column + matrix[0].length - 1);
    const target = formulas ? this.formulas : this.values;
    matrix.forEach((values, r) => values.forEach((value, c) => {
      target[row + r - 1][column + c - 1] = cloneCellValue(value);
      if (!formulas && value !== '') this.formulas[row + r - 1][column + c - 1] = '';
      // 実 Sheets では setFormulas に空文字列を渡すとセルの内容が消える。
      // 値と数式を別配列に持つ都合でここを省くと、setValues の直後に
      // setFormulas([['', ...]]) を呼ぶ実装が本番でだけ値を失う。
      if (formulas && value === '') this.values[row + r - 1][column + c - 1] = '';
    }));
  }
}

class MemorySpreadsheet {
  constructor(id, options = {}) {
    this.id = String(id); this.name = options.name || this.id; this.sheets = [];
    this.counters = {rangeReads: 0, cellsRead: 0};
    for (const spec of options.sheets || []) this.insertSheet(spec.name, spec);
  }
  getId() { return this.id; }
  getName() { return this.name; }
  getUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}`; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(name) { return this.sheets.find((sheet) => sheet.getName() === name) || null; }
  insertSheet(name, options = {}) {
    if (this.getSheetByName(name)) throw new Error(`Sheet already exists: ${name}`);
    const sheet = new MemorySheet(this, String(name), options); this.sheets.push(sheet); return sheet;
  }
  deleteSheet(sheet) { const index = this.sheets.indexOf(sheet); if (index < 0) throw new Error('Unknown sheet'); this.sheets.splice(index, 1); }
}

class MemoryDriveFile {
  constructor(id, options, utilities) {
    this.id = String(id); this.name = options.name || this.id; this.contentType = options.contentType || 'application/octet-stream';
    this.bytes = toBuffer(options.bytes || options.data || ''); this.utilities = utilities; this.renameAllowed = options.renameAllowed !== false;
    this.lastUpdated = options.lastUpdated || new Date();
    // Drive.Files.copy の変換シミュレーション用。XLSXの中身をシート配列で
    // 持たせる（実DriveはバイナリをGoogleシートへ変換する）。
    this.xlsxSheets = options.xlsxSheets || null;
    this.createdTime = options.createdTime ? new Date(options.createdTime) : this.lastUpdated;
    this.revisionId = options.revisionId || null;
  }
  getId() { return this.id; }
  getName() { return this.name; }
  setName(name) { if (!this.renameAllowed) throw new Error('Drive rename denied'); this.name = String(name); return this; }
  getBlob() { return this.utilities.newBlob(this.bytes, this.contentType, this.name); }
  getSize() { return this.bytes.length; }
  getLastUpdated() { return new Date(this.lastUpdated.getTime()); }
}

class MemoryScriptLock {
  constructor() { this.reset(); }
  tryLock() {
    this.tryCount += 1;
    if (this.results.length && !this.results.shift()) return false;
    if (this.locked) return false;
    this.locked = true; return true;
  }
  releaseLock() { if (this.locked) { this.locked = false; this.releaseCount += 1; } }
  setTryLockResults(results) { this.results = results.slice(); }
  reset() { this.locked = false; this.results = []; this.tryCount = 0; this.releaseCount = 0; }
}

function createGasStubs() {
  const Utilities = createUtilitiesStub();
  const spreadsheets = new Map(); const files = new Map(); const folders = new Map(); const properties = new Map();
  let sheetsBatchGetFailures = [];
  const apiCallCounts = {batchGet: 0, cellsRead: 0, batchUpdate: 0, rangesWritten: 0, cellsWritten: 0};
  const scriptLock = new MemoryScriptLock(); let activeSpreadsheetId = null; let activeUserEmail = 'tester@example.com';
  const openSpreadsheet = (id) => { const value = spreadsheets.get(String(id)); if (!value) throw new Error(`Spreadsheet not found: ${id}`); return value; };
  const sheetAndRange = (spreadsheetId, a1) => {
    const spreadsheet = openSpreadsheet(spreadsheetId); const parsed = parseA1(a1);
    const sheet = parsed.sheetName ? spreadsheet.getSheetByName(parsed.sheetName) : spreadsheet.getSheets()[0];
    if (!sheet) throw new Error(`Sheet not found for range: ${a1}`);
    const resolved = parseA1(a1, {sheetName: sheet.getName(), maxRows: sheet.getMaxRows(), maxColumns: sheet.getMaxColumns()});
    return {sheet, range: sheet.getRange(resolved.row, resolved.column, resolved.numRows, resolved.numColumns)};
  };
  const SpreadsheetApp = {openById: openSpreadsheet, getActiveSpreadsheet: () => activeSpreadsheetId ? openSpreadsheet(activeSpreadsheetId) : null, flush: () => {}, ProtectionType: Object.freeze({RANGE: 'RANGE', SHEET: 'SHEET'})};
  const Sheets = {Spreadsheets: {
    Values: {
      batchGet(spreadsheetId, request) {
        // INV-08（転記先を取引ごとに読まない）を検査できるようにする。
        apiCallCounts.batchGet += 1;
        apiCallCounts.cellsRead += (request.ranges || []).reduce((sum, a1) => {
          const {range} = sheetAndRange(spreadsheetId, a1);
          return sum + range.getNumRows() * range.getNumColumns();
        }, 0);
        if (sheetsBatchGetFailures.length) {
          const failure = sheetsBatchGetFailures.shift();
          const error = new Error(failure.message || `Sheets failure ${failure.code || failure}`);
          error.code = Number(failure.code || failure); throw error;
        }
        // 実 Sheets は UNFORMATTED_VALUE + SERIAL_NUMBER で日付セルを
        // **シリアル値（数値）**として返す。文字列のまま返すと、
        // `normalizeReadValue` のシリアル値経路がどのテストでも走らない。
        const serialize = (value) => {
          if (value instanceof Date &&
              request.dateTimeRenderOption === 'SERIAL_NUMBER' &&
              request.valueRenderOption !== 'FORMULA') {
            const parts = zonedParts(value, 'Asia/Tokyo');
            return Math.round((Date.UTC(Number(parts.year), Number(parts.month) - 1,
              Number(parts.day)) - Date.UTC(1899, 11, 30)) / 86400000);
          }
          return value;
        };
        return {valueRanges: (request.ranges || []).map((a1) => {
          const {range} = sheetAndRange(spreadsheetId, a1); let values;
          if (request.valueRenderOption === 'FORMULA') {
            const formulas = range.getFormulas(); const raw = range.getValues();
            values = formulas.map((row, r) => row.map((formula, c) => formula || raw[r][c]));
          } else values = range.getValues().map((row) => row.map(serialize));
          return {range: a1, majorDimension: 'ROWS', values};
        })};
      },
      batchUpdate(request, spreadsheetId) {
        // 書込レンジ数を検査できるようにする。1セル1レンジだと200件で
        // 1,200レンジになり、リクエストサイズ上限に近づく。
        apiCallCounts.batchUpdate += 1;
        apiCallCounts.rangesWritten += (request.data || []).length;
        // 実 Sheets の USER_ENTERED は値を**解釈して**格納する。
        // '2026-01-02' は日付セルに、'1200' は数値になる。素通しにすると、
        // 読み返しがシリアル値で返る本番の経路をどのテストも通らない。
        const interpret = (value) => {
          if (request.valueInputOption !== 'USER_ENTERED') return value;
          if (typeof value !== 'string') return value;
          if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return new Date(`${value}T00:00:00+09:00`);
          }
          if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
          return value;
        };
        let totalUpdatedCells = 0;
        for (const data of request.data || []) {
          const {range} = sheetAndRange(spreadsheetId, data.range);
          range.setValues(data.values.map((row) => row.map(interpret)));
          totalUpdatedCells += range.getNumRows() * range.getNumColumns();
        }
        apiCallCounts.cellsWritten += totalUpdatedCells;
        return {totalUpdatedCells};
      }
    },
    batchUpdate(request, spreadsheetId) {
      const spreadsheet = openSpreadsheet(spreadsheetId); const replies = [];
      for (const item of request.requests || []) {
        if (item.addSheet) {
          const properties = item.addSheet.properties;
          const sheet = spreadsheet.insertSheet(properties.title, {
            maxRows: properties.gridProperties && properties.gridProperties.rowCount,
            maxColumns: properties.gridProperties && properties.gridProperties.columnCount
          });
          replies.push({addSheet: {properties: {sheetId: sheet.getSheetId(), title: sheet.getName()}}});
        } else if (item.insertDimension || item.deleteDimension) {
          const operation = item.insertDimension || item.deleteDimension; const range = operation.range;
          const sheet = spreadsheet.getSheets().find((candidate) => candidate.getSheetId() === range.sheetId);
          if (range.dimension !== 'ROWS') throw new Error('Stub supports row dimensions only');
          if (item.insertDimension) sheet.insertRowsAfter(range.startIndex, range.endIndex - range.startIndex);
          else sheet.deleteRows(range.startIndex + 1, range.endIndex - range.startIndex);
          replies.push({});
        } else throw new Error(`Unsupported Sheets.batchUpdate request: ${JSON.stringify(item)}`);
      }
      return {replies};
    }
  }};
  const DriveApp = {
    getFileById(id) { const file = files.get(String(id)); if (!file) throw new Error(`File not found: ${id}`); return file; },
    getFolderById(id) {
      const folder = folders.get(String(id)); if (!folder || folder.readAllowed === false) throw new Error(`Folder not found or denied: ${id}`);
      return {getId: () => folder.id, getFiles: () => {
        let index = 0; const selected = folder.fileIds.map((fileId) => files.get(fileId)).filter(Boolean);
        return {hasNext: () => index < selected.length, next: () => selected[index++]};
      }};
    }
  };
  // Drive Advanced Service（v3）。copy はXLSX→Googleシート変換だけを模す。
  let driveCopyCounter = 0;
  let driveListFailures = [];
  const driveFileMeta = (file) => ({
    id: file.id, name: file.name, mimeType: file.contentType,
    createdTime: (file.createdTime || file.lastUpdated).toISOString ?
      (file.createdTime || file.lastUpdated).toISOString() : String(file.createdTime || file.lastUpdated),
    modifiedTime: file.lastUpdated.toISOString(),
    size: file.bytes.length, headRevisionId: file.revisionId || 'rev-1'
  });
  const Drive = {Files: {
    list(request) {
      if (driveListFailures.length) {
        const failure = driveListFailures.shift();
        const error = new Error(`Drive failure ${failure}`); error.code = Number(failure); throw error;
      }
      const match = /^'([^']+)' in parents/.exec(String(request.q || ''));
      if (!match) throw new Error(`Stub supports only parent queries: ${request.q}`);
      const folder = folders.get(match[1]);
      if (!folder || folder.readAllowed === false) throw new Error(`Folder not found or denied: ${match[1]}`);
      const items = []
        .concat((folder.subFolderIds || []).map((id) => ({id, name: id, mimeType: 'application/vnd.google-apps.folder'})))
        .concat(folder.fileIds.map((id) => files.get(id)).filter(Boolean).map(driveFileMeta));
      const pageSize = Number(request.pageSize || 100);
      const start = Number(request.pageToken || 0);
      const page = items.slice(start, start + pageSize);
      const nextStart = start + pageSize;
      return {files: page, nextPageToken: nextStart < items.length ? String(nextStart) : undefined};
    },
    copy(resource, fileId) {
      const file = files.get(String(fileId));
      if (!file) throw new Error(`File not found: ${fileId}`);
      if (!file.xlsxSheets) throw new Error(`Stub cannot convert file without xlsxSheets: ${fileId}`);
      driveCopyCounter += 1;
      const tempId = `tmp_${fileId}_${driveCopyCounter}`;
      spreadsheets.set(tempId, new MemorySpreadsheet(tempId, {sheets: file.xlsxSheets}));
      return {id: tempId, mimeType: resource && resource.mimeType};
    },
    remove(fileId) {
      const id = String(fileId);
      if (!spreadsheets.delete(id) && !files.delete(id)) throw new Error(`File not found: ${id}`);
    }
  }};
  const logLines = [];
  const Logger = {log(message) { logLines.push(String(message)); }};
  const LockService = {getScriptLock: () => scriptLock};
  const Session = {getActiveUser: () => ({getEmail: () => activeUserEmail})};
  const scriptProperties = {
    getProperty: (key) => properties.has(String(key)) ? properties.get(String(key)) : null,
    setProperty(key, value) { properties.set(String(key), String(value)); return scriptProperties; },
    deleteProperty(key) { properties.delete(String(key)); return scriptProperties; },
    getProperties: () => Object.fromEntries(properties),
    deleteAllProperties() { properties.clear(); return scriptProperties; }
  };
  const PropertiesService = {getScriptProperties: () => scriptProperties};
  const control = {
    createSpreadsheet(id, options = {}) { const ss = new MemorySpreadsheet(id, options); spreadsheets.set(String(id), ss); if (!activeSpreadsheetId) activeSpreadsheetId = String(id); return ss; },
    createFile(id, options = {}) { const file = new MemoryDriveFile(id, options, Utilities); files.set(String(id), file); return file; },
    createFolder(id, options = {}) { const folder = {id: String(id), fileIds: (options.fileIds || []).slice(), subFolderIds: (options.subFolderIds || []).slice(), readAllowed: options.readAllowed !== false}; folders.set(String(id), folder); return folder; },
    setDriveListFailures(failures) { driveListFailures = failures.slice(); },
    addProtection(spreadsheetId, sheetName, options = {}) {
      const sheet = openSpreadsheet(spreadsheetId).getSheetByName(sheetName);
      if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);
      if (!sheet.protections) sheet.protections = [];
      sheet.protections.push({
        getRange: () => ({getColumn: () => Number(options.startColumn), getLastColumn: () => Number(options.endColumn || options.startColumn)}),
        isWarningOnly: () => options.warningOnly === true,
        canEdit: () => options.canEdit !== false
      });
    },
    getSpreadsheet: openSpreadsheet,
    getFile: (id) => files.get(String(id)) || null,
    getSpreadsheetIds: () => Array.from(spreadsheets.keys()),
    getLogLines: () => logLines.slice(),
    setActiveSpreadsheet(id) { activeSpreadsheetId = String(id); },
    setActiveUser(email) { activeUserEmail = String(email); },
    setSheetsBatchGetFailures(failures) { sheetsBatchGetFailures = failures.slice(); },
    getScriptLock: () => scriptLock,
    // 読取量の計上。INV-08 の違反はスタブ上では速度に現れないため、
    // 回数で見るしかない。
    getApiCallCounts: () => Object.assign({}, apiCallCounts),
    resetApiCallCounts() { apiCallCounts.batchGet = 0; apiCallCounts.cellsRead = 0; apiCallCounts.batchUpdate = 0; apiCallCounts.rangesWritten = 0; apiCallCounts.cellsWritten = 0; },
    reset() { spreadsheets.clear(); files.clear(); folders.clear(); properties.clear(); scriptLock.reset(); sheetsBatchGetFailures = []; activeSpreadsheetId = null; activeUserEmail = 'tester@example.com'; apiCallCounts.batchGet = 0; apiCallCounts.cellsRead = 0; apiCallCounts.batchUpdate = 0; apiCallCounts.rangesWritten = 0; apiCallCounts.cellsWritten = 0; logLines.length = 0; driveListFailures = []; }
  };
  return {Utilities, SpreadsheetApp, Sheets, DriveApp, Drive, Logger, LockService, Session, PropertiesService, control};
}

module.exports = {createUtilitiesStub, createGasStubs, columnToNumber, numberToColumn, parseA1};

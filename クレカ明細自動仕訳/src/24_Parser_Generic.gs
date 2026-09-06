'use strict';

/** @param {*} value @return {boolean} */
function isParserBlank_(value) {
  return value === null || value === undefined || value === '';
}

/**
 * §5.3の共通有効明細条件。O列の除外判定を最優先する。
 * @param {!Array<*>} row
 * @param {number} dateColumnIndex 0起算
 * @param {number} amountColumnIndex 0起算
 * @param {boolean} excluded
 * @return {boolean}
 */
function isEffectiveDetailRow(row, dateColumnIndex, amountColumnIndex, excluded) {
  if (!Array.isArray(row) || !Number.isInteger(dateColumnIndex) || !Number.isInteger(amountColumnIndex)) {
    throw new TypeError('isEffectiveDetailRow requires a row and column indexes');
  }
  if (excluded) {
    return false;
  }
  return !isParserBlank_(row[dateColumnIndex]) || !isParserBlank_(row[amountColumnIndex]);
}

/** @param {!Array<*>} row @return {boolean} */
function isCompletelyEmptyParserRow_(row) {
  return Array.isArray(row) && row.every(isParserBlank_);
}

/**
 * 既にメモリへ読み込んだ行配列上で§5.3の停止位置を決める。
 * @param {!Array<!Array<*>>} rows
 * @param {!Object} options
 * @return {{reason:string, stopIndex:number, stopRow:number}}
 */
function findReadStop(rows, options) {
  if (!Array.isArray(rows)) {
    throw new TypeError('findReadStop requires rows');
  }
  var settings = options || {};
  var emptyLimit = settings.consecutiveEmptyRowsToStop;
  if (emptyLimit === null || emptyLimit === undefined) {
    emptyLimit = SETTINGS.CONSECUTIVE_EMPTY_ROWS_TO_STOP;
  }
  if (!Number.isInteger(emptyLimit) || emptyLimit <= 0) {
    throw new TypeError('consecutiveEmptyRowsToStop must be a positive integer');
  }
  var totalRows = Object.create(null);
  (settings.totalRowIndexes || []).forEach(function(index) { totalRows[index] = true; });
  var sectionBreaks = Object.create(null);
  (settings.sectionBreakIndexes || []).forEach(function(index) { sectionBreaks[index] = true; });
  var consecutiveEmpty = 0;

  for (var index = 0; index < rows.length; index += 1) {
    if (totalRows[index]) {
      return {reason: 'TOTAL_ROW', stopIndex: index, stopRow: index + 1};
    }
    // 別の列構成を持つ2つ目の明細ブロックの手前で止める。主明細の列で
    // 読むと店名・金額が別の意味になる。
    if (sectionBreaks[index]) {
      return {reason: 'SECTION_BREAK', stopIndex: index, stopRow: index + 1};
    }
    if (isCompletelyEmptyParserRow_(rows[index])) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= emptyLimit) {
        return {reason: 'EMPTY_RUN', stopIndex: index, stopRow: index + 1};
      }
    } else {
      consecutiveEmpty = 0;
    }
  }
  var lastIndex = rows.length - 1;
  return {
    reason: settings.inputLimitReached ? 'INPUT_LIMIT' : 'END_OF_LOADED_ROWS',
    stopIndex: lastIndex,
    stopRow: lastIndex + 1
  };
}

/** @param {string} column @return {number} 0起算。不正は-1 */
function parserColumnIndex_(column) {
  var text = String(column || '').toUpperCase();
  if (!/^[A-Z]+$/.test(text)) return -1;
  var number = 0;
  for (var index = 0; index < text.length; index += 1) {
    number = number * 26 + text.charCodeAt(index) - 64;
  }
  return number - 1;
}

/**
 * §5.1.0 の日付表現の解釈。列挙された表現だけを解釈し、それ以外は
 * 推測せず `{ok:false}` を返す。**年の確定はしない**（規則5・7は4.14）。
 *
 * @param {*} value セル値
 * @return {{ok:boolean, yearDigits:?number, year:?number, month:?number,
 *   day:?number, rawText:string}}
 *   yearDigits: 4＝年あり、2＝2桁年（yearは2桁の生値）、0＝年なし
 */
/**
 * 数値セルの`YYYYMMDD`／`YYMMDD`（実装差戻し#32）。
 *
 * **日付として成立する並びに限る。** `202512`のような年月は月が範囲外に
 * なるので採らず、シリアルとしての解釈へ落ちる。`YYYYMMDD`は実在日で
 * あることまで確かめる ── 確かめないと、`20250230`のような入力を静かに
 * 受け入れて誤った日付を出納帳へ書くことになる。
 *
 * @return {?Object} 日付として読めなければ null（呼出側がシリアルへ落とす）
 */
function interpretCompactNumericDate_(value, rawText) {
  if (!Number.isInteger(value) || value <= 0) return null;
  var text = String(value);
  if (text.length === 8) {
    var year = Number(text.slice(0, 4));
    var month = Number(text.slice(4, 6));
    var day = Number(text.slice(6, 8));
    if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (!dateExists(year, month, day)) return null;
    return {ok: true, yearDigits: 4, year: year, month: month, day: day, rawText: rawText};
  }
  if (text.length === 6) {
    // 2桁年は実在検査をしない（世紀が決まらないため）。年補完（5.1）が
    // 世紀を決めた後に、通常の経路で実在性が検査される。
    var shortMonth = Number(text.slice(2, 4));
    var shortDay = Number(text.slice(4, 6));
    if (shortMonth < 1 || shortMonth > 12 || shortDay < 1 || shortDay > 31) return null;
    return {ok: true, yearDigits: 2, year: Number(text.slice(0, 2)),
      month: shortMonth, day: shortDay, rawText: rawText};
  }
  return null;
}

function interpretDateExpression(value) {
  var rawText = value === null || value === undefined ?
    '' : cellToCanonicalString(value);
  var failed = {ok: false, yearDigits: null, year: null, month: null, day: null,
    rawText: rawText === null ? '' : rawText};

  if (isDate_(value)) {
    if (isNaN(value.getTime())) return failed;
    var parts = toTokyoDateString_(value).split('-').map(Number);
    return {ok: true, yearDigits: 4, year: parts[0], month: parts[1],
      day: parts[2], rawText: rawText};
  }
  // 数値型はExcelシリアル値（表#7）。ただし**数値の`YYYYMMDD`・`YYMMDD`は
  // シリアルではない**（実装差戻し#32）── UCS・コメリはYYYYMMDD、イオン系は
  // YYMMDDを数値セルで持ち、シリアルとして読むと数千年先の日付になる。
  // 衝突しない：実在する日付のシリアルは4〜5桁（2026年で約46000）であり、
  // 6桁は2657年以降、8桁は21万年以降にしか現れない。
  if (typeof value === 'number') {
    if (!isFinite(value)) return failed;
    var compact = interpretCompactNumericDate_(value, rawText);
    if (compact) return compact;
    var serialParts = toTokyoDateString_(excelSerialToDate(value)).split('-').map(Number);
    return {ok: true, yearDigits: 4, year: serialParts[0], month: serialParts[1],
      day: serialParts[2], rawText: rawText};
  }
  if (typeof value !== 'string') return failed;

  // 全角数字・全角区切りはNFKC相当の正規化で半角へ寄せてから照合する。
  var text = String(value).normalize('NFKC').trim();
  if (text === '') return failed;

  function checked(yearDigits, year, month, day) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return failed;
    if (yearDigits === 4 && !dateExists(year, month, day)) return failed;
    return {ok: true, yearDigits: yearDigits, year: year, month: month,
      day: day, rawText: rawText};
  }

  var match = text.match(/^(\d{4})([-\/.])(\d{1,2})\2(\d{1,2})$/);
  if (match) return checked(4, Number(match[1]), Number(match[3]), Number(match[4]));
  match = text.match(/^(\d{4})年\s?(\d{1,2})月\s?(\d{1,2})日?$/);
  if (match) return checked(4, Number(match[1]), Number(match[2]), Number(match[3]));
  match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) return checked(4, Number(match[1]), Number(match[2]), Number(match[3]));
  if (/^\d{4}-\d{2}-\d{2}T/.test(text) && /(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    var iso = new Date(text);
    if (isNaN(iso.getTime())) return failed;
    var isoParts = toTokyoDateString_(iso).split('-').map(Number);
    return {ok: true, yearDigits: 4, year: isoParts[0], month: isoParts[1],
      day: isoParts[2], rawText: rawText};
  }
  match = text.match(/^(\d{2})([\/.])(\d{1,2})\2(\d{1,2})$/);
  if (match) return checked(2, Number(match[1]), Number(match[3]), Number(match[4]));
  match = text.match(/^(\d{2})年\s?(\d{1,2})月\s?(\d{1,2})日?$/);
  if (match) return checked(2, Number(match[1]), Number(match[2]), Number(match[3]));
  match = text.match(/^(\d{1,2})([\/.])(\d{1,2})$/);
  if (match) return checked(0, null, Number(match[1]), Number(match[3]));
  match = text.match(/^(\d{1,2})月\s?(\d{1,2})日?$/);
  if (match) return checked(0, null, Number(match[1]), Number(match[2]));
  return failed;
}

/**
 * 金額セルを整数円へ解釈する（§5.3）。通貨記号・カンマ・空白・全角数字を
 * 除去して整数として解釈できる値だけを受け入れる。
 * @param {*} value
 * @return {{ok:boolean, blank:boolean, amount:?number}}
 */
function interpretAmountCell(value) {
  if (isParserBlank_(value)) return {ok: false, blank: true, amount: null};
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return {ok: false, blank: false, amount: null};
    return {ok: true, blank: false, amount: Object.is(value, -0) ? 0 : value};
  }
  if (typeof value !== 'string') return {ok: false, blank: false, amount: null};
  var text = value.normalize('NFKC').replace(/[\\¥￥\s　]/g, '');
  if (text === '') return {ok: false, blank: true, amount: null};
  if (!/^[+-]?(?:\d{1,3}(?:,\d{3})*|\d+)$/.test(text)) {
    return {ok: false, blank: false, amount: null};
  }
  var amount = Number(text.replace(/,/g, ''));
  if (!Number.isSafeInteger(amount)) return {ok: false, blank: false, amount: null};
  return {ok: true, blank: false, amount: Object.is(amount, -0) ? 0 : amount};
}

/** 2.1.2.3 列構造プロファイルの型判定に用いるセル型検査。 */
function parserCellMatchesType_(value, type) {
  if (type === 'any') return true;
  if (type === 'date') return interpretDateExpression(value).ok;
  if (type === 'number') {
    if (interpretAmountCell(value).ok) return true;
    if (typeof value === 'number') return isFinite(value);
    if (typeof value !== 'string') return false;
    var text = value.normalize('NFKC').replace(/[\\¥￥,\s　]/g, '');
    return /^[+-]?\d+(?:\.\d+)?$/.test(text);
  }
  if (type === 'text') {
    var canonical = value === null || value === undefined ? null : cellToCanonicalString(value);
    return canonical !== null && String(canonical).trim() !== '';
  }
  return false;
}

/** 形式定義の日付列（I列。空欄ならM列）の0起算インデックス。 */
function parserDateColumnIndex_(cardFormat) {
  var format = cardFormat || {};
  if (format.dateColumn) return parserColumnIndex_(format.dateColumn);
  if (format.dateAltColumn) return parserColumnIndex_(format.dateAltColumn);
  return -1;
}

/**
 * 2.1.2.4 除外条件の評価。3基準の論理和で、最初に成立した根拠を返す。
 * @param {!Array<*>} row
 * @param {number} rowNumber 元ファイル上の絶対物理行番号（1起算）
 * @param {!Object} cardFormat
 * @return {{excluded:boolean, ruleId:?string}}
 */
function applyExclusionRules(row, rowNumber, cardFormat) {
  if (!Array.isArray(row) || !Number.isInteger(rowNumber)) {
    throw new TypeError('applyExclusionRules requires a row and its physical row number');
  }
  var format = cardFormat || {};
  var rule = format.exclusionRule;
  if (!rule) return {excluded: false, ruleId: null};

  var ranges = Array.isArray(rule.excludeRowRanges) ? rule.excludeRowRanges : [];
  for (var rangeIndex = 0; rangeIndex < ranges.length; rangeIndex += 1) {
    var range = ranges[rangeIndex] || {};
    if (rowNumber >= Number(range.from) && rowNumber <= Number(range.to)) {
      return {excluded: true, ruleId: '_rowRange'};
    }
  }

  var dateIndex = parserDateColumnIndex_(format);
  var amountIndex = parserColumnIndex_(format.amountColumn);
  var dateBlank = dateIndex < 0 || isParserBlank_(row[dateIndex]);
  var dateUnreadable = dateBlank || !interpretDateExpression(row[dateIndex]).ok;

  var emptyDefault = rule.excludeWhenDateAndAmountEmpty === undefined ?
    true : toBool(rule.excludeWhenDateAndAmountEmpty);
  if (emptyDefault && dateBlank &&
      (amountIndex < 0 || isParserBlank_(row[amountIndex]))) {
    return {excluded: true, ruleId: '_dateAmountEmpty'};
  }

  var rules = Array.isArray(rule.rules) ? rule.rules : [];
  for (var index = 0; index < rules.length; index += 1) {
    var entry = rules[index] || {};
    if (entry.onlyWhenDateEmpty && !dateUnreadable) continue;

    var subject;
    if (entry.target === 'cell') {
      var cellIndex = parserColumnIndex_(entry.column);
      subject = cellIndex < 0 ? null : row[cellIndex];
    } else {
      subject = row.map(function(cell) {
        var canonical = cell === null || cell === undefined ? '' : cellToCanonicalString(cell);
        return canonical === null ? '' : canonical;
      }).join(' ');
    }
    var subjectText = subject === null || subject === undefined ?
      '' : String(cellToCanonicalString(subject));

    if (entry.match === 'empty') {
      if (subjectText.trim() === '') return {excluded: true, ruleId: String(entry.id)};
      continue;
    }
    var wanted = String(entry.value === undefined ? '' : entry.value);
    var normalize = entry.normalize === undefined ? true : toBool(entry.normalize);
    var caseSensitive = toBool(entry.caseSensitive);
    var subjectCompare = normalize ? normalizeMerchant(subjectText) : subjectText;
    var wantedCompare = normalize ? normalizeMerchant(wanted) : wanted;
    if (!caseSensitive && !normalize) {
      subjectCompare = subjectCompare.toUpperCase();
      wantedCompare = wantedCompare.toUpperCase();
    }
    var hit = false;
    if (entry.match === 'equals') {
      hit = subjectCompare === wantedCompare;
    } else if (entry.match === 'contains') {
      hit = subjectCompare.indexOf(wantedCompare) >= 0;
    } else if (entry.match === 'startsWith') {
      hit = subjectCompare.lastIndexOf(wantedCompare, 0) === 0;
    } else if (entry.match === 'regex') {
      hit = new RegExp(String(entry.value), caseSensitive ? '' : 'i').test(subjectCompare);
    }
    if (hit) return {excluded: true, ruleId: String(entry.id)};
  }
  return {excluded: false, ruleId: null};
}

/**
 * 2.1.2.6 請求年月抽出規則の評価。締め年月（利用期間の終了年月）を返す。
 * `null`を返さない（M6）。
 * @param {!Object} sheet {name, rows}
 * @param {string} fileName 恒久ファイルインデックスC列の元ファイル名
 * @param {!Object} cardFormat
 * @return {{status:string, year:?number, month:?number,
 *   sources:!Array<string>, candidates:!Array<!Object>}}
 */
function extractBillingYearMonth(sheet, fileName, cardFormat) {
  var format = cardFormat || {};
  var rule = format.billingRule;
  var sources = rule && Array.isArray(rule.sources) ? rule.sources : [];
  var resolvedValues = [];

  sources.forEach(function(source) {
    if (!source || !source.pattern || !source.groups) return;
    var subject = null;
    if (source.kind === 'fileName') {
      subject = String(fileName || '');
    } else if (source.kind === 'cell') {
      var cellMatch = String(source.cell || '').toUpperCase().match(/^([A-Z]+)(\d+)$/);
      if (!cellMatch || !sheet || !Array.isArray(sheet.rows)) return;
      var cellRow = sheet.rows[Number(cellMatch[2]) - 1];
      var cellValue = cellRow ? cellRow[parserColumnIndex_(cellMatch[1])] : null;
      var canonical = cellValue === null || cellValue === undefined ?
        null : cellToCanonicalString(cellValue);
      subject = canonical === null ? '' : String(canonical);
    } else if (source.kind === 'scanRows') {
      var maxRows = Number.isInteger(source.scanMaxRows) ? source.scanMaxRows : 10;
      var rows = sheet && Array.isArray(sheet.rows) ? sheet.rows.slice(0, maxRows) : [];
      subject = rows.map(function(row) {
        return (Array.isArray(row) ? row : []).map(function(cell) {
          var text = cell === null || cell === undefined ? '' : cellToCanonicalString(cell);
          return text === null ? '' : text;
        }).join(' ');
      }).join('\n');
    } else {
      return;
    }

    var matched;
    try {
      matched = new RegExp(String(source.pattern)).exec(subject);
    } catch (error) {
      throw new FormatDefinitionError('Billing-month pattern is not a valid regular expression: ' + source.id);
    }
    if (!matched) return;

    var groups = source.groups;
    var yearGroup = Number.isInteger(groups.endYear) ? groups.endYear : groups.year;
    var monthGroup = Number.isInteger(groups.endMonth) ? groups.endMonth : groups.month;
    var year = Number(matched[yearGroup]);
    var month = Number(matched[monthGroup]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return;

    // 2桁年は基準となる締め年月がまだ存在しないため、世紀候補
    // {1900+yy, 2000+yy, 2100+yy} を一意に絞る材料がない。規則3の
    // 「解釈が一意にならない場合は当該sourceを無視する」に従い無視する。
    if (Number(source.yearDigits) === 2) return;

    var ordinal = monthOrdinal(year, month);
    if (source.means === 'payment') {
      if (!Number.isInteger(Number(source.offsetMonths))) {
        throw new FormatDefinitionError('means=payment requires offsetMonths: ' + source.id);
      }
      ordinal -= Number(source.offsetMonths);
    } else if (source.means !== 'closing' && source.means !== 'periodEnd') {
      throw new FormatDefinitionError('Unknown billing-month means: ' + String(source.means));
    }
    resolvedValues.push({
      id: String(source.id),
      year: Math.floor(ordinal / 12),
      month: (ordinal % 12) + 1
    });
  });

  if (!resolvedValues.length) {
    return {status: DATE_INFERENCE_STATUS.NOT_FOUND, year: null, month: null,
      sources: [], candidates: []};
  }
  var first = resolvedValues[0];
  var conflicting = resolvedValues.some(function(entry) {
    return entry.year !== first.year || entry.month !== first.month;
  });
  if (conflicting) {
    return {status: DATE_INFERENCE_STATUS.CONFLICT, year: null, month: null,
      sources: [], candidates: resolvedValues};
  }
  return {
    status: DATE_INFERENCE_STATUS.RESOLVED,
    year: first.year, month: first.month,
    sources: resolvedValues.map(function(entry) { return entry.id; }),
    candidates: []
  };
}

/** P列が指す合計行・請求額行の行インデックス（読取終了条件2）。 */
/**
 * 2つ目の明細ブロックの見出し行を探す（0起算）。
 *
 * イオン系の明細は主明細の下に「分割・ボーナス払い明細」を持ち、そこから
 * **列構成が変わる**。見出しを取引行として読むと店名が空欄になり、
 * 区分1でファイルごと顧客へ差し戻される。
 */
function parserSectionBreakIndexes_(rows, cardFormat) {
  var rule = (cardFormat || {}).sectionBreakRule;
  var patterns = rule && Array.isArray(rule.patterns) ? rule.patterns : [];
  if (!patterns.length) return [];
  var dataStart = Number((cardFormat || {}).dataStartRow) >= 1
    ? Number(cardFormat.dataStartRow) : 1;
  var wanted = patterns.map(function(text) { return normalizeMerchant(text); })
    .filter(function(text) { return text !== ''; });
  if (!wanted.length) return [];

  var indexes = [];
  for (var index = dataStart - 1; index < rows.length; index += 1) {
    var row = rows[index];
    if (!Array.isArray(row)) continue;
    // 見出しは行のどこに置かれていてもよい（列位置は明細ごとに揺れる）。
    var hit = row.some(function(cell) {
      if (isParserBlank_(cell)) return false;
      var text = normalizeMerchant(cellToCanonicalString(cell));
      return wanted.indexOf(text) >= 0;
    });
    if (hit) indexes.push(index);
  }
  return indexes;
}

function parserTotalRowIndexes_(rows, cardFormat) {
  var format = cardFormat || {};
  var rule = format.countTotalRule || format.reconciliationRule;
  if (!rule) return [];
  var dataStart = Number(format.dataStartRow) >= 1 ? Number(format.dataStartRow) : 1;
  var indexes = [];
  [rule.count, rule.total].forEach(function(item) {
    if (!item || item.source === 'none' || !item.source) return;
    if (item.source === 'cell') {
      var match = String(item.cell || '').toUpperCase().match(/^[A-Z]+(\d+)$/);
      if (match) {
        var cellIndex = Number(match[1]) - 1;
        if (cellIndex >= dataStart - 1) indexes.push(cellIndex);
      }
      return;
    }
    if (item.source !== 'labeledRow') return;
    var labelIndex = parserColumnIndex_(item.labelColumn);
    if (labelIndex < 0) return;
    var wanted = normalizeMerchant(item.label || '');
    for (var index = dataStart - 1; index < rows.length; index += 1) {
      var row = rows[index];
      if (!Array.isArray(row)) continue;
      var label = row[labelIndex];
      var canonical = label === null || label === undefined ? '' : cellToCanonicalString(label);
      if (normalizeMerchant(canonical === null ? '' : canonical) === wanted) {
        indexes.push(index);
        return;
      }
    }
  });
  return indexes;
}

/**
 * 4.13 汎用パーサー。形式定義（カード形式マスター）に従い
 * `CommonTransaction[]`を返す。**年を確定しない**（4.14へ委ねる）。
 *
 * @param {!Object} sheet {name, rows, recordStarts?} 読取結果の1シート
 * @param {!Object} cardFormat 検証済みの形式定義行（4.11）
 * @param {!Object} context
 *   customerId, fileId, fileNameOriginal, fileRevision, regeneration,
 *   inputLimitReached（4.10の読取が上限で切れたか）
 * @return {{txs:!Array<!Object>, excludedRows:!Array<!Object>,
 *   truncatedAt:?number, remainingCandidateRows:number,
 *   truncation:!Object, stop:!Object}}
 */
function parseFile(sheet, cardFormat, context) {
  if (!sheet || !Array.isArray(sheet.rows)) {
    throw new TypeError('parseFile requires a sheet with rows');
  }
  var format = cardFormat || {};
  var ctx = context || {};
  var rows = sheet.rows;
  var recordStarts = Array.isArray(sheet.recordStarts) ? sheet.recordStarts : null;

  var dateIndex = parserDateColumnIndex_(format);
  var amountIndex = parserColumnIndex_(format.amountColumn);
  var fallbackAmountIndex = format.amountFallbackColumn ?
    parserColumnIndex_(format.amountFallbackColumn) : -1;
  var merchantIndex = parserColumnIndex_(format.merchantColumn);
  var purposeIndex = format.purposeColumn ? parserColumnIndex_(format.purposeColumn) : -1;
  if (dateIndex < 0) {
    throw new FormatDefinitionError('A generic format requires a date column (I) or an alternate date column (M)');
  }
  if (amountIndex < 0 || merchantIndex < 0) {
    throw new FormatDefinitionError('A generic format requires merchant and amount columns');
  }
  var dataStart = Number(format.dataStartRow);
  if (!Number.isInteger(dataStart) || dataStart < 1) {
    throw new FormatDefinitionError('dataStartRow must be a positive integer');
  }

  var stop = findReadStop(rows, {
    totalRowIndexes: parserTotalRowIndexes_(rows, format),
    sectionBreakIndexes: parserSectionBreakIndexes_(rows, format),
    inputLimitReached: ctx.inputLimitReached === true
  });
  // 合計行・セクション見出しそのものは明細でない。空行打切り・末尾到達では
  // 停止行まで読む（停止行は空行または最終行であり、有効明細条件で自然に落ちる）。
  var lastDetailIndex = (stop.reason === 'TOTAL_ROW' || stop.reason === 'SECTION_BREAK')
    ? stop.stopIndex - 1 : stop.stopIndex;

  var txs = [];
  var excludedRows = [];
  var gridWidth = rows.reduce(function(width, row) {
    return Array.isArray(row) && row.length > width ? row.length : width;
  }, 0);

  // 走査は1行目から行う。H列（データ開始行）は「原則」であり（2.1.2.1）、
  // ヘッダー・前置行の排除はO列の除外範囲と有効明細条件（5.3）が担う。
  // データ開始行から走査を始めると、O列の除外実績（excludedRows）が
  // 往復検証C5の除外件数と一致しなくなる。
  for (var index = 0; index <= lastDetailIndex && index < rows.length; index += 1) {
    var row = rows[index];
    if (!Array.isArray(row)) continue;
    var physicalRow = recordStarts ? recordStarts[index] : index + 1;
    var exclusion = applyExclusionRules(row, physicalRow, format);
    if (exclusion.excluded) {
      excludedRows.push({sourceRow: physicalRow, ruleId: exclusion.ruleId});
      continue;
    }
    if (!isEffectiveDetailRow(row, dateIndex, amountIndex, false)) continue;

    var dateCell = row[dateIndex];
    var interpreted = isParserBlank_(dateCell) ?
      null : interpretDateExpression(dateCell);
    // 「ご利用金額」が空欄でも「当月支払額」に金額がある行がある（キャッシュ
    // バック等。カード明細側の仕様）。予備列を宣言した形式に限り、そちらを
    // 見る。値がある行では見ない ── 分割払いは両者が食い違うため。
    var amount = interpretAmountCell(row[amountIndex]);
    if (!amount.ok && fallbackAmountIndex >= 0) {
      var fallback = interpretAmountCell(row[fallbackAmountIndex]);
      if (fallback.ok) amount = fallback;
    }
    var merchantRaw = row[merchantIndex];
    var merchantCanonical = merchantRaw === null || merchantRaw === undefined ?
      '' : cellToCanonicalString(merchantRaw);
    var purposeRaw = purposeIndex < 0 ? null : row[purposeIndex];
    var purposeCanonical = purposeRaw === null || purposeRaw === undefined ?
      '' : String(cellToCanonicalString(purposeRaw)).trim();
    var foreign = extractForeignCurrency(row, format, gridWidth || row.length);

    var tx = {
      customerId: ctx.customerId || null,
      fileId: ctx.fileId || null,
      fileNameOriginal: ctx.fileNameOriginal || null,
      fileRevision: ctx.fileRevision || null,
      sourceSheet: sheet.name || null,
      sourceRow: physicalRow,
      occurrenceIndex: txs.length,
      regeneration: Number.isInteger(ctx.regeneration) ? ctx.regeneration : 0,
      cardType: format.formatId || null,
      formatId: format.formatId || null,
      date: null,
      dateYearDigits: null,
      dateYearMissing: false,
      dateYear: null,
      dateYearRaw: null,
      dateMonthDay: null,
      dateRawText: interpreted ? interpreted.rawText :
        (dateCell === null || dateCell === undefined ? '' : String(cellToCanonicalString(dateCell))),
      dateHashKey: '',
      dateUnreadable: false,
      merchantOriginal: merchantCanonical === null ? '' : String(merchantCanonical),
      amountBillingJpy: amount.ok ? amount.amount : null,
      purpose: purposeCanonical,
      currencyOriginal: foreign.currencyCode,
      amountOriginal: foreign.localAmount,
      exchangeRate: foreign.exchangeRate,
      dateInferenceSource: null,
      dateInferenceBase: null,
      dateTimezone: SYSTEM_TIMEZONE,
      purposeInferred: false,
      purposeInferenceRuleId: null,
      partnerResolutionStatus: PARTNER_STATUS.UNRESOLVED,
      transactionStatus: TX_STATUS.PREPARED,
      transactionIdVersion: VERSIONS.TRANSACTION_ID,
      hashVersion: VERSIONS.HASH
    };

    if (interpreted && interpreted.ok) {
      var pad = function(n) { return (n < 10 ? '0' : '') + n; };
      tx.dateYearDigits = interpreted.yearDigits;
      tx.dateMonthDay = {month: interpreted.month, day: interpreted.day};
      if (interpreted.yearDigits === 4) {
        tx.date = tokyoDate_(interpreted.year, interpreted.month, interpreted.day);
        tx.dateHashKey = interpreted.year + '-' + pad(interpreted.month) + '-' + pad(interpreted.day);
      } else {
        tx.dateHashKey = '--' + pad(interpreted.month) + '-' + pad(interpreted.day);
        if (interpreted.yearDigits === 2) {
          tx.dateYear = interpreted.year;
          tx.dateYearRaw = interpreted.year;
        } else {
          tx.dateYearMissing = true;
        }
      }
    } else {
      // 空欄または列挙外の表記。年補完の対象にせず（4.14が要求する
      // dateMonthDayを持たないため）、取引単位の要確認`DATE`の材料とする。
      tx.dateUnreadable = true;
    }
    txs.push(tx);
  }

  var truncation = checkScanTruncation({
    rows: rows,
    stopIndex: stop.stopIndex,
    stopReason: stop.reason,
    dateColumnIndex: dateIndex,
    amountColumnIndex: amountIndex
  });

  return {
    txs: txs,
    excludedRows: excludedRows,
    truncatedAt: stop.reason === 'EMPTY_RUN' ? stop.stopRow : null,
    remainingCandidateRows: truncation.remainingCandidateRows,
    truncation: truncation,
    stop: stop
  };
}

/**
 * 明細からカード名を取り出す（2.1.2.7）。
 *
 * 年会費のように**明細の店名にカード会社が現れない**取引がある。
 * 「基本カード年会費」という文字列はどのカードでも同じなので、店名で
 * 辞書を作ると全カードの年会費が1つの取引先に潰れる。カード単位で
 * 決めるには、そのファイルがどのカードのものかを知る必要がある。
 *
 * 取得元は形式ごとに違う（フォルダ名・1行目のセル・シート名・ファイル名）。
 * **フォルダ名が最も確実**である ── 顧客はカードごとにフォルダを作って
 * 明細を入れるため、汎用のシート名（「25年12月請求分」）しか持たない形式でも
 * カードが分かる。取れない形式もある ── その場合は`null`を返し、呼出側は
 * 通常どおり要確認へ回す。
 *
 * @return {?string} 取れたカード名（正準化済み）。取れなければ null
 */
function resolveCardName(sheet, cardFormat, context) {
  var rule = cardFormat && cardFormat.cardNameRule;
  var sources = rule && Array.isArray(rule.sources) ? rule.sources : [];
  var rows = sheet && Array.isArray(sheet.rows) ? sheet.rows : [];

  for (var index = 0; index < sources.length; index += 1) {
    var source = sources[index];
    var text = '';
    if (source.kind === 'cell') {
      var row = rows[Number(source.row) - 1];
      var cell = Array.isArray(row) ? row[Number(source.column) - 1] : null;
      text = cell === null || cell === undefined ? '' : cellToCanonicalString(cell);
    } else if (source.kind === 'sheetName') {
      text = String((sheet && sheet.name) || '');
    } else if (source.kind === 'folderName') {
      text = String((context && context.folderName) || '');
    } else if (source.kind === 'fileName') {
      text = String((context && context.fileName) || '');
    } else {
      continue;
    }
    if (source.pattern) {
      var matched = new RegExp(source.pattern).exec(text);
      if (!matched) continue;
      text = matched[Number(source.group) >= 1 ? Number(source.group) : 1] || '';
    }
    text = String(text === null || text === undefined ? '' : text).trim();
    if (text) return text;
  }
  return null;
}

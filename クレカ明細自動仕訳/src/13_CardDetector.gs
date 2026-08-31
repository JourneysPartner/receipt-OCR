'use strict';

/**
 * 4.11 カード形式判定。
 *
 * カード形式マスターの**読取**は本モジュールが担い、`14_FormatRegistry`へ
 * 依存しない（依存の向きは 14 → 13。循環を作らない）。判定規則は
 * `detectFormatWith`の1実装だけであり、4.12.4の判定衝突検査も本処理も
 * 同じ関数を通る（判定規則を二重実装しない）。
 *
 * 判定の材料は 2.1.2 の評価規則で定義された3つに限る：
 *   E列（ファイル種別の包含）→ F列（判定キーワード）→ N列（列構造）。
 * N列が空の形式では列構造の判定を適用しない。
 */

var CARD_FORMAT_COLUMNS_ = 34; // A〜AH

/** @param {string} column @return {number} 0起算。不正は-1 */
function detectorColumnIndex_(column) {
  var text = String(column || '').toUpperCase();
  if (!/^[A-Z]+$/.test(text)) return -1;
  var number = 0;
  for (var index = 0; index < text.length; index += 1) {
    number = number * 26 + text.charCodeAt(index) - 64;
  }
  return number - 1;
}

/** 空欄を許す列記号の検査。 */
function detectorOptionalColumn_(value, label, problems) {
  if (value === '' || value === null || value === undefined) return null;
  if (detectorColumnIndex_(value) < 0) {
    problems.push(label + ' must be a column letter: ' + String(value));
    return null;
  }
  return String(value).toUpperCase();
}

/** 空欄を許す0以上の整数。 */
function detectorOptionalCount_(value, label, problems) {
  if (value === '' || value === null || value === undefined) return null;
  var number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    problems.push(label + ' must be a non-negative integer');
    return null;
  }
  return number;
}

function detectorParseJson_(raw, label, problems) {
  if (raw === '' || raw === null || raw === undefined) return null;
  try {
    return JSON.parse(String(raw));
  } catch (error) {
    problems.push(label + ' is not valid JSON');
    return null;
  }
}

/** 2.1.2.2 F列。下位互換の単純配列は allOf 1条件へ解釈する。 */
function detectorKeywordRule_(raw, headerRow, problems) {
  var parsed = detectorParseJson_(raw, 'F', problems);
  if (parsed === null) {
    problems.push('F (detection keywords) is required');
    return null;
  }
  if (Array.isArray(parsed)) {
    parsed = {allOf: [{
      maxRow: (Number.isInteger(headerRow) ? headerRow : 0) + 1,
      keywords: parsed,
      minMatch: parsed.length
    }]};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    problems.push('F must be an object with allOf/anyOf');
    return null;
  }
  var ok = true;
  ['allOf', 'anyOf'].forEach(function(key) {
    if (parsed[key] === undefined) return;
    if (!Array.isArray(parsed[key])) {
      problems.push('F.' + key + ' must be an array');
      ok = false;
      return;
    }
    parsed[key].forEach(function(condition, index) {
      if (!condition || !Number.isInteger(condition.maxRow) || condition.maxRow < 1 ||
          !Array.isArray(condition.keywords) || !condition.keywords.length ||
          !Number.isInteger(condition.minMatch) || condition.minMatch < 1) {
        problems.push('F.' + key + '[' + index + '] requires maxRow, keywords, minMatch');
        ok = false;
      }
    });
  });
  if (!Array.isArray(parsed.allOf) && !Array.isArray(parsed.anyOf)) {
    problems.push('F requires at least one of allOf/anyOf');
    ok = false;
  }
  return ok ? parsed : null;
}

/** 2.1.2.3 N列。 */
function detectorColumnProfile_(raw, problems) {
  var parsed = detectorParseJson_(raw, 'N', problems);
  if (parsed === null) return null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      !Number.isInteger(parsed.minColumns) || parsed.minColumns < 1 ||
      !Array.isArray(parsed.columns)) {
    problems.push('N requires minColumns and columns');
    return null;
  }
  if (parsed.sampleRows !== undefined &&
      (!Number.isInteger(parsed.sampleRows) || parsed.sampleRows < 1)) {
    problems.push('N.sampleRows must be a positive integer');
    return null;
  }
  var typesOk = parsed.columns.every(function(column) {
    return column && Number.isInteger(column.index) && column.index >= 0 &&
      ['date', 'text', 'number', 'any'].indexOf(column.type) >= 0 &&
      typeof column.required === 'boolean';
  });
  if (!typesOk) {
    problems.push('N.columns entries require index, type, required');
    return null;
  }
  return parsed;
}

/** 2.1.2.4 O列。 */
function detectorExclusionRule_(raw, problems) {
  var parsed = detectorParseJson_(raw, 'O', problems);
  if (parsed === null) return null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    problems.push('O must be an object');
    return null;
  }
  var ok = true;
  (Array.isArray(parsed.excludeRowRanges) ? parsed.excludeRowRanges : []).forEach(function(range, index) {
    if (!range || !Number.isInteger(range.from) || !Number.isInteger(range.to) ||
        range.from < 1 || range.to < range.from) {
      problems.push('O.excludeRowRanges[' + index + '] requires from <= to (1-based)');
      ok = false;
    }
  });
  (Array.isArray(parsed.rules) ? parsed.rules : []).forEach(function(rule, index) {
    var label = 'O.rules[' + index + ']';
    if (!rule || !rule.id || (rule.target !== 'row' && rule.target !== 'cell') ||
        ['equals', 'contains', 'startsWith', 'regex', 'empty'].indexOf(rule.match) < 0) {
      problems.push(label + ' requires id, target, match');
      ok = false;
      return;
    }
    if (rule.target === 'cell' && detectorColumnIndex_(rule.column) < 0) {
      problems.push(label + ' requires a column letter for target=cell');
      ok = false;
    }
    if (rule.match !== 'empty' &&
        (rule.value === undefined || rule.value === null || rule.value === '')) {
      problems.push(label + ' requires value');
      ok = false;
    }
    if (rule.match === 'regex') {
      try {
        void new RegExp(String(rule.value));
      } catch (error) {
        problems.push(label + ' has an invalid regular expression');
        ok = false;
      }
    }
  });
  return ok ? parsed : null;
}

/** 2.1.2.5 P列。 */
function detectorCountTotalRule_(raw, problems) {
  var parsed = detectorParseJson_(raw, 'P', problems);
  if (parsed === null) return null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    problems.push('P must be an object');
    return null;
  }
  var ok = true;
  ['count', 'total'].forEach(function(key) {
    var item = parsed[key];
    if (item === undefined || item === null) return;
    var label = 'P.' + key;
    if (['none', 'cell', 'labeledRow'].indexOf(item.source) < 0) {
      problems.push(label + '.source must be none/cell/labeledRow');
      ok = false;
      return;
    }
    if (item.source === 'cell' && !/^[A-Za-z]+\d+$/.test(String(item.cell || ''))) {
      problems.push(label + ' requires cell in A1 notation');
      ok = false;
    }
    if (item.source === 'labeledRow' &&
        (!item.label || detectorColumnIndex_(item.labelColumn) < 0 ||
         detectorColumnIndex_(item.valueColumn) < 0)) {
      problems.push(label + ' requires label, labelColumn, valueColumn');
      ok = false;
    }
    if (item.tolerance !== undefined &&
        (typeof item.tolerance !== 'number' || item.tolerance < 0)) {
      problems.push(label + '.tolerance must be a non-negative number');
      ok = false;
    }
  });
  if (parsed.totalScope !== undefined &&
      ['all', 'positiveOnly', 'excludeNegative'].indexOf(parsed.totalScope) < 0) {
    problems.push('P.totalScope must be all/positiveOnly/excludeNegative');
    ok = false;
  }
  return ok ? parsed : null;
}

/** 2.1.2.6 Q列。 */
function detectorBillingRule_(raw, problems) {
  var parsed = detectorParseJson_(raw, 'Q', problems);
  if (parsed === null) return null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      !Array.isArray(parsed.sources)) {
    problems.push('Q requires a sources array');
    return null;
  }
  var ok = true;
  parsed.sources.forEach(function(source, index) {
    var label = 'Q.sources[' + index + ']';
    if (!source || !source.id ||
        ['fileName', 'cell', 'scanRows'].indexOf(source.kind) < 0 ||
        !source.pattern || !source.groups ||
        ['closing', 'periodEnd', 'payment'].indexOf(source.means) < 0) {
      problems.push(label + ' requires id, kind, pattern, groups, means');
      ok = false;
      return;
    }
    if (source.kind === 'cell' && !/^[A-Za-z]+\d+$/.test(String(source.cell || ''))) {
      problems.push(label + ' requires cell in A1 notation');
      ok = false;
    }
    if (source.means === 'payment' && !Number.isInteger(source.offsetMonths)) {
      problems.push(label + ' requires integer offsetMonths for means=payment');
      ok = false;
    }
    if (source.yearDigits !== undefined && source.yearDigits !== 2 && source.yearDigits !== 4) {
      problems.push(label + '.yearDigits must be 2 or 4');
      ok = false;
    }
    var hasMainGroups = Number.isInteger(source.groups.year) && Number.isInteger(source.groups.month);
    if (!hasMainGroups) {
      problems.push(label + '.groups requires year and month');
      ok = false;
    }
    try {
      void new RegExp(String(source.pattern));
    } catch (error) {
      problems.push(label + ' has an invalid regular expression');
      ok = false;
    }
  });
  return ok ? parsed : null;
}

/**
 * カード形式マスター1行をFormatRowへ写し、2.1.2の各スキーマで検証する。
 * 不適合でも例外にせず`valid:false`で返す ── 呼出側が
 * `CARD_FORMAT_DEFINITION_INVALID`として記録し、候補から外す
 * （不正な定義を無視して続行しない。A-25）。
 */
function formatRowFromValues_(values, rowNumber) {
  var problems = [];
  var headerRow = Number(values[6]);
  var dataStartRow = Number(values[7]);
  var version = Number(values[18]);

  var row = {
    formatId: String(values[0] || ''),
    formatName: String(values[1] || ''),
    status: String(values[2] || ''),
    enabled: toBool(values[3]),
    fileTypes: [],
    keywordRule: null,
    headerRow: headerRow,
    dataStartRow: dataStartRow,
    dateColumn: null,
    merchantColumn: null,
    amountColumn: null,
    purposeColumn: null,
    dateAltColumn: null,
    columnProfile: null,
    exclusionRule: null,
    countTotalRule: null,
    billingRule: null,
    parserKind: String(values[17] || ''),
    version: version,
    registeredBy: String(values[19] || ''),
    approvedBy: values[20] || null,
    registeredAt: values[21] || null,
    disabledAt: values[22] || null,
    disabledReason: values[23] || null,
    lookbackMonths: null,
    forwardMonths: null,
    sourceSampleId: values[26] || null,
    answers: detectorParseJson_(values[27], 'AB', problems),
    gateResults: detectorParseJson_(values[28], 'AC', problems),
    revisionReason: String(values[29] || ''),
    foreignCurrencyColumn: null,
    foreignAmountColumn: null,
    exchangeRateColumn: null,
    updatedAt: values[33] || null,
    valid: false,
    errorCode: null,
    problems: problems,
    _rowNumber: rowNumber
  };

  if (!/^[a-z0-9_]{1,32}$/.test(row.formatId)) {
    problems.push('A (formatId) must be 1-32 chars of [a-z0-9_]');
  }
  if (['draft', 'active', 'retired'].indexOf(row.status) < 0) {
    problems.push('C (status) must be draft/active/retired');
  }
  if (row.parserKind !== 'generic' && row.parserKind !== 'custom') {
    problems.push('R (parserKind) must be generic or custom');
  }
  if (!Number.isInteger(headerRow) || headerRow < 1) problems.push('G (headerRow) must be a positive integer');
  if (!Number.isInteger(dataStartRow) || dataStartRow < 1) problems.push('H (dataStartRow) must be a positive integer');
  if (!Number.isFinite(version)) problems.push('S (version) must be a number');

  var fileTypes = detectorParseJson_(values[4], 'E', problems);
  if (!Array.isArray(fileTypes) || !fileTypes.length ||
      !fileTypes.every(function(type) { return type === 'csv' || type === 'xlsx'; })) {
    problems.push('E (fileTypes) must be a JSON array of csv/xlsx');
  } else {
    row.fileTypes = fileTypes;
  }

  row.keywordRule = detectorKeywordRule_(values[5], headerRow, problems);
  row.dateColumn = detectorOptionalColumn_(values[8], 'I', problems);
  row.merchantColumn = detectorOptionalColumn_(values[9], 'J', problems);
  row.amountColumn = detectorOptionalColumn_(values[10], 'K', problems);
  row.purposeColumn = detectorOptionalColumn_(values[11], 'L', problems);
  row.dateAltColumn = detectorOptionalColumn_(values[12], 'M', problems);
  if (!row.merchantColumn) problems.push('J (merchant column) is required');
  if (!row.amountColumn) problems.push('K (amount column) is required');
  // I・M両方空は、genericでは日付を組み立てられない（A-19）。
  // customは専用パーサーが日付を組み立てるため両方空でよい（4.12.8）。
  if (row.parserKind === 'generic' && !row.dateColumn && !row.dateAltColumn) {
    problems.push('A generic format requires I (date) or M (alternate date)');
  }

  row.columnProfile = detectorColumnProfile_(values[13], problems);
  row.exclusionRule = detectorExclusionRule_(values[14], problems);
  row.countTotalRule = detectorCountTotalRule_(values[15], problems);
  row.billingRule = detectorBillingRule_(values[16], problems);

  row.lookbackMonths = detectorOptionalCount_(values[24], 'Y', problems);
  row.forwardMonths = detectorOptionalCount_(values[25], 'Z', problems);
  // 4.6 検証項目12と同じ制約。形式ごとの上書き値が12か月以上の窓を作ると、
  // 当該形式でだけ年なし日付が恒常的に全件要確認になる（A-25）。
  if (row.lookbackMonths !== null && row.forwardMonths !== null &&
      row.lookbackMonths + row.forwardMonths >= 12) {
    problems.push('Y + Z must be less than 12 months');
  }
  row.foreignCurrencyColumn = detectorOptionalColumn_(values[30], 'AE', problems);
  row.foreignAmountColumn = detectorOptionalColumn_(values[31], 'AF', problems);
  row.exchangeRateColumn = detectorOptionalColumn_(values[32], 'AG', problems);

  row.valid = problems.length === 0;
  row.errorCode = row.valid ? null : 'CARD_FORMAT_DEFINITION_INVALID';
  return row;
}

/**
 * カード形式マスターを読み、検証済みのFormatRow[]を返す。
 * 不適合の行も`valid:false`のまま含める（呼出側が記録して候補から外す）。
 *
 * @param {!Object=} filter {status, enabled, formatId, version}
 * @return {!Array<!Object>}
 */
function loadFormatDefinitions(filter) {
  var query = filter || {};
  var sheet = requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CARD_FORMAT_MASTER);
  return readSheetRows_(sheet, CARD_FORMAT_COLUMNS_)
    .filter(function(row) {
      return String(row.values[0] || '') !== '';
    })
    .map(function(row) { return formatRowFromValues_(row.values, row.rowNumber); })
    .filter(function(row) {
      if (query.status !== undefined && row.status !== query.status) return false;
      if (query.enabled !== undefined && row.enabled !== query.enabled) return false;
      if (query.formatId !== undefined && row.formatId !== String(query.formatId)) return false;
      if (query.version !== undefined && Number(row.version) !== Number(query.version)) return false;
      return true;
    });
}

/** E列のJSON配列への包含（等値比較しない）。 */
function matchesFileType(formatRow, fileType) {
  var types = formatRow && Array.isArray(formatRow.fileTypes) ? formatRow.fileTypes : [];
  return types.indexOf(String(fileType || '').toLowerCase()) >= 0;
}

/** 先頭maxRow行の正準化・正規化済み連結文字列（条件ごとにキャッシュ）。 */
function detectorJoinedText_(rows, maxRow, cache) {
  if (cache[maxRow] !== undefined) return cache[maxRow];
  var text = rows.slice(0, maxRow).map(function(row) {
    return (Array.isArray(row) ? row : []).map(function(cell) {
      var canonical = cell === null || cell === undefined ? '' : cellToCanonicalString(cell);
      return normalizeMerchant(canonical === null ? '' : canonical);
    }).join(' ');
  }).join(' ');
  cache[maxRow] = text;
  return text;
}

/** 2.1.2.2 の評価。成立可否と一致キーワードを返す。 */
function detectorEvaluateKeywords_(rows, keywordRule) {
  if (!keywordRule) return {ok: false, matchedKeywords: []};
  var cache = Object.create(null);
  var matchedKeywords = [];

  function evaluateCondition(condition) {
    var joined = detectorJoinedText_(rows, condition.maxRow, cache);
    var matched = condition.keywords.filter(function(keyword) {
      return joined.indexOf(normalizeMerchant(String(keyword))) >= 0;
    });
    if (matched.length >= condition.minMatch) {
      matchedKeywords = matchedKeywords.concat(matched);
      return true;
    }
    return false;
  }

  var allOf = Array.isArray(keywordRule.allOf) ? keywordRule.allOf : null;
  var anyOf = Array.isArray(keywordRule.anyOf) ? keywordRule.anyOf : null;
  if (!allOf && !anyOf) return {ok: false, matchedKeywords: []};
  if (allOf && !allOf.every(evaluateCondition)) return {ok: false, matchedKeywords: []};
  if (anyOf && !anyOf.some(evaluateCondition)) return {ok: false, matchedKeywords: []};
  return {ok: true, matchedKeywords: matchedKeywords};
}

/** F列を2.1.2.2の評価規則で判定する。 */
function matchesKeywords(sheet, formatRow) {
  var rows = sheet && Array.isArray(sheet.rows) ? sheet.rows : [];
  return detectorEvaluateKeywords_(rows, formatRow && formatRow.keywordRule).ok;
}

/**
 * N列を2.1.2.3の評価規則で判定する。
 * @return {?boolean} N列が空欄なら判定を適用しない（null）
 */
function matchesColumnProfile(sheet, formatRow) {
  var profile = formatRow && formatRow.columnProfile;
  if (!profile) return null;
  var rows = sheet && Array.isArray(sheet.rows) ? sheet.rows : [];
  var dateIndex = parserDateColumnIndex_(formatRow);
  var amountIndex = detectorColumnIndex_(formatRow.amountColumn);
  var sampleRows = Number.isInteger(profile.sampleRows) ? profile.sampleRows : 5;
  var dataStart = Number(formatRow.dataStartRow);
  var samples = [];
  for (var index = dataStart - 1; index < rows.length && samples.length < sampleRows; index += 1) {
    var row = rows[index];
    if (!Array.isArray(row)) continue;
    var hasDate = dateIndex >= 0 && !isParserBlank_(row[dateIndex]);
    var hasAmount = amountIndex >= 0 && !isParserBlank_(row[amountIndex]);
    if (hasDate || hasAmount) samples.push(row);
  }
  if (!samples.length) return false;
  return samples.every(function(row) {
    if (row.length < profile.minColumns) return false;
    return profile.columns.every(function(column) {
      if (!column.required) return true;
      return parserCellMatchesType_(row[column.index], column.type);
    });
  });
}

/**
 * 1定義×1シートの判定。判定衝突検査（4.12.4）が期待する詳細形。
 * @return {{matched:boolean, matchedStep:?string, matchedKeywords:!Array<string>}}
 */
function evaluateFormatDetection_(formatRow, sheet, fileType) {
  if (!formatRow || formatRow.valid !== true) {
    return {matched: false, matchedStep: null, matchedKeywords: []};
  }
  if (!matchesFileType(formatRow, fileType)) {
    return {matched: false, matchedStep: null, matchedKeywords: []};
  }
  var rows = sheet && Array.isArray(sheet.rows) ? sheet.rows : [];
  var keywords = detectorEvaluateKeywords_(rows, formatRow.keywordRule);
  if (!keywords.ok) {
    return {matched: false, matchedStep: null, matchedKeywords: []};
  }
  var profile = matchesColumnProfile(sheet, formatRow);
  if (profile === false) {
    return {matched: false, matchedStep: null, matchedKeywords: keywords.matchedKeywords};
  }
  return {
    matched: true,
    matchedStep: profile === true ? 'COLUMN_PROFILE' : 'KEYWORDS',
    matchedKeywords: keywords.matchedKeywords
  };
}

/**
 * 与えられた定義集合に対して判定を適用する（4.12.4はこの関数だけを用いる）。
 * @param {!Array<!Object>} definitions
 * @param {!Object} sheet {name, rows}
 * @param {string} fileType 'csv'|'xlsx'
 * @param {string} fileName （現行スキーマの判定材料には含まれない。将来拡張用）
 * @return {!Array<!Object>} Candidate[]
 */
function detectFormatWith(definitions, sheet, fileType, fileName) {
  if (!Array.isArray(definitions)) {
    throw new TypeError('detectFormatWith requires an array of definitions');
  }
  var candidates = [];
  definitions.forEach(function(definition) {
    var outcome = evaluateFormatDetection_(definition, sheet, fileType);
    if (!outcome.matched) return;
    candidates.push({
      formatId: definition.formatId,
      version: definition.version,
      formatRow: definition,
      matchedStep: outcome.matchedStep,
      matchedKeywords: outcome.matchedKeywords
    });
  });
  return candidates;
}

/**
 * 本処理の判定。照合対象は`有効=TRUE`かつ`ステータス=active`の行に限る。
 * 不正な定義は候補から外れる（呼出側は`loadFormatDefinitions`の
 * `valid:false`行を`CARD_FORMAT_DEFINITION_INVALID`として記録すること）。
 */
function detectFormat(sheet, fileType, fileName) {
  var definitions = loadFormatDefinitions({status: 'active', enabled: true})
    .filter(function(row) { return row.valid === true; });
  return detectFormatWith(definitions, sheet, fileType, fileName);
}

/**
 * シート集約の判定（4.11の表）。
 * @param {!Array<!Object>} detections [{sheetName, candidates}]
 * @param {!Object} context A-19の判定文脈 {origin, fileName, fileType, targetSheetName, sourceId}
 * @return {{status:string, sheetName:?string, formatId:?string, formatVersion:?number, detail:?Object}}
 */
function aggregateSheetDetections(detections, context) {
  if (!Array.isArray(detections) || !context) {
    throw new TypeError('aggregateSheetDetections requires detections and a context');
  }
  var target = context.targetSheetName || null;

  // 条件1：担当者指定シートで1つに確定するなら最優先（M19）。
  if (target) {
    var targetDetection = detections.filter(function(entry) {
      return entry.sheetName === target;
    })[0];
    var targetCandidates = targetDetection ? targetDetection.candidates : [];
    if (targetCandidates.length === 1) {
      return {
        status: 'RESOLVED', sheetName: target,
        formatId: targetCandidates[0].formatId,
        formatVersion: targetCandidates[0].version, detail: null
      };
    }
  }

  var matchedSheets = detections.filter(function(entry) {
    return entry.candidates && entry.candidates.length > 0;
  });
  if (!matchedSheets.length) {
    return {status: 'UNKNOWN_CARD_FORMAT', sheetName: null, formatId: null,
      formatVersion: null, detail: null};
  }
  if (matchedSheets.length >= 2) {
    return {
      status: 'MULTI_SHEET_AMBIGUOUS', sheetName: null, formatId: null,
      formatVersion: null,
      detail: {kind: 'MULTI_SHEET', sheets: matchedSheets.map(function(entry) {
        return {name: entry.sheetName, formatId: entry.candidates[0].formatId};
      })}
    };
  }
  var only = matchedSheets[0];
  if (only.candidates.length >= 2) {
    return {
      status: 'AMBIGUOUS_CARD_FORMAT', sheetName: only.sheetName, formatId: null,
      formatVersion: null,
      detail: {candidates: only.candidates.map(function(candidate) {
        return {formatId: candidate.formatId, version: candidate.version};
      })}
    };
  }
  return {
    status: 'RESOLVED', sheetName: only.sheetName,
    formatId: only.candidates[0].formatId,
    formatVersion: only.candidates[0].version, detail: null
  };
}

/**
 * 処理中のファイルが用いる形式定義の版を固定する（INV-39）。
 * 戻り値を保持し、以後マスターを読み直さない。
 */
function pinFormatVersion(formatId, version) {
  var rows = loadFormatDefinitions({formatId: formatId, version: version});
  if (!rows.length) {
    throw new FormatDefinitionError('Format not found: ' + formatId + ' v' + version);
  }
  var row = rows[0];
  if (row.valid !== true) {
    throw new FormatDefinitionError('Format definition is invalid: ' +
      formatId + ' v' + version + ' — ' + row.problems.join('; '));
  }
  return row;
}

/**
 * 継続トリガー起動時・バッチ境界の版検査（INV-39・B-M10）。
 * `有効=TRUE`が別バージョンへ移っていれば`FORMAT_VERSION_CHANGED_DURING_RUN`。
 */
function assertPinnedVersionStillActive(formatId, version) {
  var enabled = loadFormatDefinitions({formatId: formatId, enabled: true});
  var stillActive = enabled.some(function(row) {
    return Number(row.version) === Number(version) && row.status === 'active';
  });
  if (!stillActive) {
    throw makeCatalogError_('FORMAT_VERSION_CHANGED_DURING_RUN',
      'Format ' + formatId + ' is no longer active at version ' + version);
  }
}

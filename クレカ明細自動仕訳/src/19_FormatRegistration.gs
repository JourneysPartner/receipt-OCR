'use strict';

/** 指定形式の有効な全版を止める。停止済みなら書込も監査も行わない。 */
function disableCardFormat_(formatId, reason, actor) {
  var active = loadFormatDefinitions({formatId: formatId, enabled: true});
  var versions = [];
  if (!active.length) return {formatId: formatId, disabledVersions: versions};
  var sheet = requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CARD_FORMAT_MASTER);
  var now = nowIso_();
  active.forEach(function(def) {
    sheet.getRange(def._rowNumber, 4).setValue(false);
    sheet.getRange(def._rowNumber, 23).setValue(now);
    sheet.getRange(def._rowNumber, 24).setValue(reason);
    sheet.getRange(def._rowNumber, 34).setValue(now);
    versions.push(def.version);
    appendAudit({type: 'FORMAT_DISABLE', actor: actor, targetType: 'FORMAT',
      targetId: formatId, after: {version: def.version, reason: reason}});
  });
  return {formatId: formatId, disabledVersions: versions};
}

function formatColumnLetter_(index) {
  var text = '';
  for (var n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    text = String.fromCharCode(65 + (n - 1) % 26) + text;
  }
  return text;
}

/** この型は提案専用。判定と抽出の寛容な型検査には使わない。 */
function formatProposalCellType_(cell) {
  if (cell instanceof Date && !isNaN(cell.getTime())) return 'date';
  if (typeof cell === 'number') {
    if (Number.isInteger(cell) && /^[0-9]{6}(?:[0-9]{2})?$/.test(String(cell)) &&
        interpretCompactNumericDate_(cell, String(cell))) return 'date';
    return 'number';
  }
  if (typeof cell !== 'string' || !cell.trim()) return null;
  if (interpretDateExpression(cell).ok) return 'date';
  if (/^-?[0-9,]+(?:\.[0-9]+)?$/.test(cell.trim())) return 'number';
  return 'text';
}

function formatProposalDetailRow_(row) {
  if (!Array.isArray(row)) return false;
  return row.some(function(cell) { return formatProposalCellType_(cell) === 'date'; }) &&
    row.some(function(cell) { return formatProposalCellType_(cell) === 'number'; });
}

function formatProposalHeaderRow_(sheet, base) {
  var rows = sheet.rows || [];
  if (base && base.headerRow <= rows.length) {
    var proposed = rows[base.headerRow - 1] || [];
    if (proposed.filter(function(cell) { return formatProposalCellType_(cell) === 'text'; }).length >= 2 &&
        proposed.every(function(cell) {
          return isParserBlank_(cell) || formatProposalCellType_(cell) === 'text';
        })) return base.headerRow;
  }
  var best = {row: 1, count: -1};
  for (var i = 0; i < Math.min(rows.length, SETTINGS.SAMPLE_INFER_SCAN_ROWS); i += 1) {
    var row = rows[i] || [];
    if (row.filter(function(cell) { return !isParserBlank_(cell); }).length < 2) continue;
    if (!row.every(function(cell) {
      return isParserBlank_(cell) || formatProposalCellType_(cell) === 'text';
    })) continue;
    var count = rows.slice(i + 1, i + 1 + SETTINGS.SAMPLE_INFER_SAMPLE_ROWS)
      .filter(formatProposalDetailRow_).length;
    if (count >= best.count) best = {row: i + 1, count: count};
  }
  return best.row;
}

function formatProposal_(sheet, fileType, folderName, base, referenceSheet, definitions) {
  var rows = sheet.rows || [];
  var headerRow = formatProposalHeaderRow_(sheet, base);
  var dataStartRow = base && headerRow === base.headerRow ? base.dataStartRow :
    rows.findIndex(function(row, index) {
      return index >= headerRow && formatProposalDetailRow_(row);
    }) + 1;
  if (dataStartRow <= headerRow) dataStartRow = headerRow + 1;
  var detailRows = rows.slice(dataStartRow - 1, dataStartRow - 1 + SETTINGS.SAMPLE_INFER_SAMPLE_ROWS)
    .filter(formatProposalDetailRow_);
  var header = rows[headerRow - 1] || [];
  var width = detectorTableWidth_(rows, headerRow, detailRows);
  var headers = {};
  var roles = {date: {column: null, source: null}, merchant: {column: null, source: null},
    amount: {column: null, source: null}, purpose: {column: null, source: null},
    amountFallback: {column: null, source: null}};
  var amountCandidates = [];
  var normalized = header.map(function(cell) { return normalizeMerchant(String(cell || '')); });
  for (var i = 0; i < width; i += 1) {
    var letter = formatColumnLetter_(i);
    headers[letter] = String(header[i] === undefined || header[i] === null ? '' : header[i]);
    var name = normalized[i] || '';
    var numericCount = detailRows.filter(function(row) {
      return formatProposalCellType_(row[i]) === 'number';
    }).length;
    if (numericCount && /(金額|総額|ご利用金|利用金)/.test(name)) {
      amountCandidates.push({column: letter, header: headers[letter], numericCount: numericCount});
    }
  }
  function uniqueHeader(pattern, exact, requiredType) {
    var found = normalized.map(function(value, index) {
      return (exact ? value === pattern : pattern.test(value)) ? formatColumnLetter_(index) : null;
    }).filter(Boolean);
    if (found.length !== 1) return null;
    if (requiredType) {
      var column = detectorColumnIndex_(found[0]);
      var matching = detailRows.filter(function(row) {
        return formatProposalCellType_(row[column]) === requiredType;
      }).length;
      if (matching * 2 <= detailRows.length) return null;
    }
    return found[0];
  }
  roles.date.column = uniqueHeader(/利用日|利用年月日/, false, 'date');
  roles.merchant.column = uniqueHeader(/店名|利用先|加盟店|利用内容/, false, 'text');
  roles.purpose.column = uniqueHeader(normalizeMerchant('使用用途'), true);
  ['date', 'merchant', 'purpose'].forEach(function(role) {
    if (roles[role].column) roles[role].source = 'HEADER';
  });
  if (amountCandidates.length === 1) {
    roles.amount = {column: amountCandidates[0].column, source: 'HEADER'};
  }
  if (base && referenceSheet) {
    var refHeader = (referenceSheet.rows || [])[base.headerRow - 1] || [];
    var refRoles = {date: base.dateColumn, merchant: base.merchantColumn,
      amount: base.amountColumn, purpose: base.purposeColumn,
      amountFallback: base.amountFallbackColumn};
    Object.keys(refRoles).forEach(function(role) {
      var refIndex = detectorColumnIndex_(refRoles[role]);
      if (refIndex < 0 || isParserBlank_(refHeader[refIndex])) return;
      var wanted = normalizeMerchant(String(refHeader[refIndex]));
      var hits = normalized.map(function(value, index) {
        return value === wanted ? formatColumnLetter_(index) : null;
      }).filter(Boolean);
      if (hits.length === 1) roles[role] = {column: hits[0], source: 'REFERENCE'};
    });
  }
  var id = base ? String(base.formatId).slice(0, 29 - String(width).length) + '_x' + width :
    'new_' + toTokyoDateString_(new Date()).replace(/-/g, '') + '_x' + width;
  var taken = {};
  (definitions || []).forEach(function(def) { taken[def.formatId] = true; });
  var initial = id;
  for (var suffix = 2; taken[id]; suffix += 1) {
    id = initial.slice(0, 31 - String(suffix).length) + '_' + suffix;
  }
  return {baseFormatId: base ? base.formatId : null, formatId: id,
    formatName: base ? base.formatName + '（' + width + '列版）' :
      folderName + ' ' + (fileType === 'csv' ? 'CSV' : 'Excel') + '（' + width + '列）',
    sheetName: sheet.name, headerRow: headerRow, dataStartRow: dataStartRow,
    columns: roles, amountCandidates: amountCandidates, headers: headers};
}

/** 判定の三段階を同じ関数で評価し、説明に要る内訳だけ加える。 */
function formatGap_(def, sheet, fileType) {
  var rows = sheet && Array.isArray(sheet.rows) ? sheet.rows : [];
  var conditions = [];
  ['allOf', 'anyOf'].forEach(function(kind) {
    ((def.keywordRule && def.keywordRule[kind]) || []).forEach(function(condition) {
      var joined = detectorJoinedText_(rows, condition.maxRow, Object.create(null));
      var found = [];
      var missing = [];
      (condition.keywords || []).forEach(function(keyword) {
        (joined.indexOf(normalizeMerchant(String(keyword))) >= 0 ? found : missing).push(keyword);
      });
      conditions.push({kind: kind, maxRow: condition.maxRow, minMatch: condition.minMatch,
        found: found, missing: missing});
    });
  });
  var samples = def.columnProfile ? detectorProfileSamples_(sheet, def) : [];
  var width = detectorTableWidth_(rows, def.headerRow, samples);
  var profile = def.columnProfile;
  var failures = [];
  if (profile) (profile.columns || []).forEach(function(column) {
    if (!column.required) return;
    var bad = samples.filter(function(row) {
      return !parserCellMatchesType_(row[column.index], column.type);
    }).length;
    if (bad) failures.push({index: column.index, type: column.type, bad: bad, of: samples.length});
  });
  var stage = !def.valid ? 'INVALID' : !matchesFileType(def, fileType) ? 'FILE_TYPE' :
    !detectorEvaluateKeywords_(rows, def.keywordRule).ok ? 'KEYWORDS' :
    matchesColumnProfile(sheet, def) === false ? 'COLUMNS' : 'MATCH';
  return {formatId: def.formatId, version: def.version, stage: stage,
    keywords: {conditions: conditions,
      ok: detectorEvaluateKeywords_(rows, def.keywordRule).ok},
    width: {actual: width, min: profile ? profile.minColumns : null,
      max: profile && profile.maxColumns !== undefined ? profile.maxColumns : null},
    samplesFound: samples.length > 0, typeFailures: failures};
}

function formatActiveDefinitions_() {
  return loadFormatDefinitions({status: 'active', enabled: true}).filter(function(def) {
    return def.valid === true;
  });
}

function formatDetectRead_(definitions, read, fileName, fileId) {
  var detections = read.sheets.map(function(sheet) {
    return {sheetName: sheet.name,
      candidates: detectFormatWith(definitions, sheet, read.fileType, fileName)};
  });
  var permanent = getPermanentFileIndexRecord_(fileId);
  var targetSheetName = permanent ? String(permanent.values[12] || '') : '';
  return aggregateSheetDetections(detections, {origin: 'FILE', fileName: fileName,
    fileType: read.fileType, targetSheetName: targetSheetName || null, sourceId: fileId});
}

function formatPurposeGap_(base, gap, sheet) {
  if (!base) return null;
  var conditions = gap.keywords.conditions;
  var missing = [];
  conditions.forEach(function(condition) {
    missing = missing.concat(condition.missing);
  });
  var nonPurpose = missing.filter(function(word) {
    return normalizeMerchant(String(word)) !== normalizeMerchant('使用用途');
  });
  if (nonPurpose.length || !base.purposeColumn) return null;
  var profile = base.columnProfile;
  if (!profile) return null;
  var header = (sheet.rows || [])[base.headerRow - 1] || [];
  var purposeIndex = detectorColumnIndex_(base.purposeColumn);
  var value = header[purposeIndex];
  var text = isParserBlank_(value) ? '' : String(value);
  var normalized = normalizeMerchant(text);
  if (missing.length === 1 && gap.width.actual >= profile.minColumns &&
      (profile.maxColumns === undefined || gap.width.actual <= profile.maxColumns) &&
      text && normalized !== normalizeMerchant('使用用途')) {
    return {kind: 'PURPOSE_HEADER_VALUE', column: base.purposeColumn, headerText: text};
  }
  if (profile.maxColumns !== undefined &&
      gap.width.actual === profile.maxColumns - 1 && purposeIndex === profile.maxColumns - 1 &&
      !header.some(function(cell) {
        return normalizeMerchant(String(cell || '')) === normalizeMerchant('使用用途');
      })) return {kind: 'PURPOSE_COLUMN_ABSENT', column: null, headerText: null};
  return null;
}

function formatGrid_(sheet, headerRow, dataStartRow) {
  var rows = sheet.rows || [];
  var maxRows = Math.min(rows.length, dataStartRow - 1 + WEBAPP_FORMAT_GRID_ROWS_);
  var width = Math.min(WEBAPP_FORMAT_GRID_COLUMNS_,
    detectorTableWidth_(rows, headerRow, rows.slice(dataStartRow - 1, maxRows)));
  var cells = rows.slice(0, maxRows).map(function(row) {
    return Array.from({length: width}, function(_, index) {
      var value = row[index];
      if (value === null || value === undefined) return '';
      if (value instanceof Date) return toTokyoDateString_(value);
      return String(value);
    });
  });
  return {rowNumbers: cells.map(function(_, index) { return index + 1; }),
    columnLetters: Array.from({length: width}, function(_, index) {
      return formatColumnLetter_(index);
    }), cells: cells};
}

function formatNearest_(defs, sheet, fileType, history) {
  return defs.map(function(def) {
    var gap = formatGap_(def, sheet, fileType);
    var matchedWords = gap.keywords.conditions.reduce(function(total, c) {
      return total + c.found.length;
    }, 0);
    var missingAllOf = gap.keywords.conditions.filter(function(c) {
      return c.kind === 'allOf';
    }).reduce(function(total, c) { return total + c.missing.length; }, 0);
    var anyOfOk = gap.keywords.conditions.filter(function(c) {
      return c.kind === 'anyOf';
    }).every(function(c) { return c.found.length >= c.minMatch; });
    if (gap.stage !== 'COLUMNS' && !(gap.stage === 'KEYWORDS' &&
        missingAllOf === 1 && anyOfOk && matchedWords >= 2)) return null;
    var profile = def.columnProfile;
    var widthDistance = profile ? Math.max(profile.minColumns - gap.width.actual,
      profile.maxColumns === undefined ? 0 : gap.width.actual - profile.maxColumns, 0) : 0;
    var record = history[def.formatId] || {count: 0, reference: null};
    return {def: def, gap: gap, matchedWords: matchedWords, widthDistance: widthDistance,
      folderCount: record.count, reference: record.reference};
  }).filter(Boolean).sort(function(a, b) {
    if (a.folderCount !== b.folderCount) return b.folderCount - a.folderCount;
    if (a.gap.stage !== b.gap.stage) return a.gap.stage === 'COLUMNS' ? -1 : 1;
    if (a.matchedWords !== b.matchedWords) return b.matchedWords - a.matchedWords;
    if (a.widthDistance !== b.widthDistance) return a.widthDistance - b.widthDistance;
    return a.def.formatId < b.def.formatId ? -1 : (a.def.formatId > b.def.formatId ? 1 : 0);
  }).slice(0, 3);
}

function formatFolderHistory_(folder, targetFileId, customerId) {
  var files = webAppIteratorToArray_(folder.getFiles());
  var byId = Object.create(null);
  files.forEach(function(file) { byId[String(file.getId())] = file; });
  var blocked = Object.create(null);
  openReviews({}).forEach(function(review) {
    if (String(review.customerId) === String(customerId) &&
        (review.reviewType === 'FORMAT_UNKNOWN' || review.reviewType === 'FORMAT_AMBIGUOUS')) {
      blocked[String(review.fileId)] = true;
    }
  });
  var history = Object.create(null);
  readSheetRows_(processLogSheet_(), PROCESS_LOG_WIDTH_).forEach(function(row) {
    var values = row.values;
    var id = String(values[7] || '');
    var formatId = String(values[14] || '');
    if (!formatId || id === String(targetFileId) || blocked[id] || !byId[id]) return;
    var record = history[formatId] || {count: 0, reference: null, at: ''};
    record.count += 1;
    var at = String(values[1] || '');
    if (!record.reference || at > record.at) {
      record.reference = {fileId: id, fileName: String(byId[id].getName())};
      record.at = at;
    }
    history[formatId] = record;
  });
  return history;
}

function formatExplainUnknown_(context, baseFormatId) {
  var defs = formatActiveDefinitions_();
  var read = readFile(context.fileId, context.fileName,
    {expectedKeywords: detectionKeywordUnion_(defs)});
  var aggregated = formatDetectRead_(defs, read, context.fileName, context.fileId);
  var basic = {ok: true, reviewId: context.review.reviewId,
    fileId: context.fileId, fileName: context.fileName, fileType: read.fileType};
  if (aggregated.status === 'RESOLVED') {
    var matched = defs.filter(function(def) { return def.formatId === aggregated.formatId; })[0];
    basic.verdict = 'MATCHES_ACTIVE';
    basic.matched = {formatId: matched.formatId, formatName: matched.formatName};
    return basic;
  }
  if (aggregated.status === 'AMBIGUOUS_CARD_FORMAT' ||
      aggregated.status === 'MULTI_SHEET_AMBIGUOUS') {
    basic.verdict = 'AMBIGUOUS';
    return basic;
  }
  var sheet = read.sheets[0];
  if (read.sheets.length > 1) {
    sheet = read.sheets.slice().sort(function(a, b) {
      var ah = formatProposalHeaderRow_(a, null);
      var bh = formatProposalHeaderRow_(b, null);
      var ac = a.rows.slice(ah).filter(formatProposalDetailRow_).length;
      var bc = b.rows.slice(bh).filter(formatProposalDetailRow_).length;
      return bc - ac;
    })[0];
  }
  var history = formatFolderHistory_(context.folder, context.fileId, context.customerId);
  var nearest = formatNearest_(defs, sheet, read.fileType, history);
  var selected = nearest[0];
  if (baseFormatId) {
    selected = nearest.filter(function(item) {
      return item.def.formatId === String(baseFormatId);
    })[0] || selected;
  }
  var base = selected ? selected.def : null;
  var referenceInfo = selected && selected.reference;
  var referenceSheet = null;
  var referenceWarning = null;
  if (referenceInfo) {
    try {
      var refRead = readFile(referenceInfo.fileId, referenceInfo.fileName,
        {expectedKeywords: detectionKeywordUnion_(defs)});
      referenceSheet = refRead.sheets.filter(function(item) {
        return item.name === sheet.name;
      })[0] || refRead.sheets[0];
    } catch (error) {
      referenceWarning = {code: 'REFERENCE_UNREADABLE', detail: referenceInfo.fileName};
      referenceInfo = null;
    }
  }
  var proposal = formatProposal_(sheet, read.fileType, context.folder.getName(),
    base, referenceSheet, loadFormatDefinitions({}));
  var purposeGap = base ? formatPurposeGap_(base, selected.gap, sheet) : null;
  basic.verdict = base ? 'NEAR' : 'BLANK';
  basic.sheetName = sheet.name;
  basic.width = detectorTableWidth_(sheet.rows, proposal.headerRow,
    detectorProfileSamples_(sheet, base || {dataStartRow: proposal.dataStartRow,
      dateColumn: proposal.columns.date.column,
      amountColumn: proposal.columns.amount.column}));
  basic.matched = null;
  basic.nearest = nearest.map(function(item) {
    return {formatId: item.def.formatId, formatName: item.def.formatName,
      stage: item.gap.stage,
      gapText: explainFormatVerdict_(item.def, sheet, read.fileType),
       folderCount: item.folderCount,
       reference: item.reference === selected.reference ? referenceInfo : item.reference};
  });
  basic.warnings = referenceWarning ? [referenceWarning] : [];
  basic.purposeGap = purposeGap;
  basic.customerSide = Boolean(purposeGap);
  basic.grid = formatGrid_(sheet, proposal.headerRow, proposal.dataStartRow);
  basic.proposal = proposal;
  return basic;
}

function formatDerivedSpec_(context, read, sheet, answers, base, proposal, purposeGap) {
  var headerRow = Number(answers.headerRow);
  var dataStartRow = Number(answers.dataStartRow);
  var columns = answers.columns || {};
  var header = (sheet.rows || [])[headerRow - 1] || [];
  var seen = Object.create(null);
  var keywords = [];
  header.forEach(function(cell) {
    var original = String(cell === null || cell === undefined ? '' : cell).trim();
    var normalized = normalizeMerchant(original);
    if (!normalized || normalized.length < 2 || /[0-9０-９]/.test(normalized) ||
        seen[normalized] || keywords.length >= 12) return;
    seen[normalized] = true;
    keywords.push(original);
  });
  var pseudo = {dataStartRow: dataStartRow, headerRow: headerRow,
    dateColumn: columns.date, amountColumn: columns.amount,
    columnProfile: {sampleRows: 5}, sectionBreakRule: base && base.sectionBreakRule};
  var samples = detectorProfileSamples_(sheet, pseudo);
  var width = detectorTableWidth_(sheet.rows || [], headerRow, samples);
  var oldRules = base && base.exclusionRule && base.exclusionRule.rules || [];
  var retainedRules = oldRules.filter(function(rule) { return rule.target === 'row'; });
  var droppedRules = oldRules.filter(function(rule) { return rule.target !== 'row'; })
    .map(function(rule) { return rule.id || rule.target; });
  var countTotal = base && base.countTotalRule &&
    base.countTotalRule.count && base.countTotalRule.total &&
    base.countTotalRule.count.source === 'none' &&
    base.countTotalRule.total.source === 'none' ? base.countTotalRule :
    {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'};
  var billingSources = (base && base.billingRule && base.billingRule.sources || [])
    .filter(function(source) {
      return source.kind === 'fileName' || source.kind === 'scanRows';
    });
  var cardSources = base && base.cardNameRule && base.cardNameRule.sources || [];
  var metadata = {origin: 'WEBAPP', baseFormatId: base ? base.formatId : null,
    customerId: context.customerId, sourceFileId: context.fileId,
    sourceFileName: context.fileName, referenceFileId: context.referenceFileId || null,
    purposeGap: purposeGap, purposeHeader: columns.purpose ?
      String(header[detectorColumnIndex_(columns.purpose)] || '') : null,
    acknowledgements: answers.acknowledgements || {},
    amountCandidates: proposal.amountCandidates.map(function(candidate) {
      return candidate.column;
    })};
  return {spec: {formatId: String(answers.formatId || ''),
    formatName: String(answers.formatName || ''), fileTypes: [read.fileType],
    keywordRule: {allOf: [{maxRow: headerRow, keywords: keywords, minMatch: keywords.length}]},
    headerRow: headerRow, dataStartRow: dataStartRow,
    dateColumn: columns.date || '', merchantColumn: columns.merchant || '',
    amountColumn: columns.amount || '', purposeColumn: columns.purpose || '',
    amountFallbackColumn: columns.amountFallback || '',
    columnProfile: {minColumns: width, maxColumns: width, sampleRows: 5,
      columns: [{index: detectorColumnIndex_(columns.date), type: 'date', required: true},
        {index: detectorColumnIndex_(columns.merchant), type: 'text', required: true},
        {index: detectorColumnIndex_(columns.amount), type: 'number', required: true}]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: dataStartRow - 1}],
      excludeWhenDateAndAmountEmpty: true, rules: retainedRules},
    countTotalRule: countTotal,
    billingRule: billingSources.length ? {sources: billingSources} : null,
    cardNameRule: base ? {sources: cardSources.filter(function(source) {
      return ['folderName', 'sheetName', 'fileName'].indexOf(source.kind) >= 0;
    })} : {sources: [{kind: 'folderName'}]},
    sectionBreakRule: base ? base.sectionBreakRule : null,
    lookbackMonths: base && base.lookbackMonths != null ? base.lookbackMonths : undefined,
    forwardMonths: base && base.forwardMonths != null ? base.forwardMonths : undefined,
    parserKind: 'generic', version: 1, revisionReason: 'NEW', answers: metadata},
    droppedRules: droppedRules,
    foreignDropped: Boolean(base && (base.foreignCurrencyColumn ||
      base.foreignAmountColumn || base.exchangeRateColumn))};
}

function formatHashRow_(row, fileId, bytes, acknowledgements) {
  var copy = row.slice();
  [19, 21, 33].forEach(function(index) { copy[index] = ''; });
  if (copy[27]) {
    var answers = JSON.parse(copy[27]);
    delete answers.previewHash;
    copy[27] = JSON.stringify(answers);
  }
  return sha256Hex(utf8Bytes(serializeDeterministic(copy.concat([
    fileId, sha256Hex(bytes),
    acknowledgements.customerSide === true, acknowledgements.amountChoice === true
  ]))));
}

function formatPreviewExtraction_(context, sheet, def) {
  var parsed = parseFile(sheet, def, {customerId: context.customerId,
    fileId: context.fileId, fileNameOriginal: context.fileName,
    fileRevision: '', regeneration: 0});
  var txs = parsed.txs.map(function(tx) {
    var generated = generateTransactionId({customerId: tx.customerId, fileId: tx.fileId,
      sourceSheetName: tx.sourceSheet === null ? '' : tx.sourceSheet,
      sourceRow: tx.sourceRow, generation: tx.regeneration});
    return Object.assign({}, tx, {transactionId: generated.full,
      fullTxId: generated.full, displayTxId: generated.display});
  });
  var originalPurposes = {};
  txs.forEach(function(tx) { originalPurposes[tx.sourceRow] = tx.purpose; });
  var purposeOutcome = resolvePurposes(txs, context.fileName, purposeRulesForRun_());
  txs = purposeOutcome.txs;
  var billing = extractBillingYearMonth(sheet, context.fileName, def);
  var yearlessCount = txs.filter(function(tx) {
    return tx.dateYearMissing === true || tx.dateYearDigits === 2;
  }).length;
  var yearInference = inferYearsForFile(txs, billing, def);
  txs = yearInference.txs;
  var dateTriage = applyDateTriageChecks(txs, billing, new Date());
  var reconcilable = txs.map(function(tx) {
    return tx.amountBillingJpy === null ? Object.assign({}, tx, {amountBillingJpy: 0}) : tx;
  });
  var process = getProcessLogRecord_(context.fileId);
  var countsTotals = verifyCountsAndTotals(reconcilable, def, sheet, process);
  var customer = context.customer;
  var priorYear = checkPriorYearUsage(txs, customer,
    blankedDateTransactionIds(yearInference, dateTriage));
  var validation = {format: {ok: true}, scanTruncation: parsed.truncation,
    effectiveTransactionCount: txs.length,
    purposeResolution: {unresolvedCount: purposeOutcome.unresolvedCount},
    yearInference: yearInference, dateTriage: dateTriage,
    countsTotals: countsTotals, priorYear: priorYear,
    transactionValidation: validateTransactions(txs, {cardFormat: def})};
  var category = classifyValidationResult(validation);
  var rows = txs.map(function(tx) {
    return {sourceRow: tx.sourceRow, date: tx.date ? toTokyoDateString_(tx.date) : null,
      amount: tx.amountBillingJpy, merchant: tx.merchantOriginal,
      purpose: tx.purpose, purposeFilled: !originalPurposes[tx.sourceRow] && Boolean(tx.purpose)};
  });
  var zeroAmountCount = rows.filter(function(row) {
    return row.amount === null || row.amount === 0;
  }).length;
  var excluded = parsed.excludedRows.map(function(item) {
    return {sourceRow: item.sourceRow, ruleId: item.ruleId,
      cells: (sheet.rows[item.sourceRow - 1] || []).map(function(cell) {
        return cell instanceof Date ? toTokyoDateString_(cell) : String(cell || '');
      })};
  });
  return {extraction: {count: txs.length, total: rows.reduce(function(sum, row) {
      return sum + Number(row.amount || 0);
    }, 0), rows: rows.slice(0, WEBAPP_FORMAT_PREVIEW_ROWS_),
    moreRows: Math.max(0, rows.length - WEBAPP_FORMAT_PREVIEW_ROWS_),
    excluded: excluded.filter(function(item) { return item.ruleId !== '_rowRange'; }),
    excludedBeforeStart: excluded.filter(function(item) { return item.ruleId === '_rowRange'; }).length,
    billing: {status: billing.status, yearMonth: billing.status === 'RESOLVED' ?
      String(billing.year) + '-' + ('0' + billing.month).slice(-2) : null},
    year: {yearless: yearlessCount,
      inferred: txs.filter(function(tx) { return Boolean(tx.dateInferenceSource); }).length,
      reviewRows: (yearInference.rowIssues || []).length},
    purposeEmptyCount: rows.filter(function(row) { return !row.purpose; }).length,
    zeroAmountCount: zeroAmountCount,
    category: {category: category.category, code: category.code}},
    validation: validation, reviewEntries: category.reviewEntries,
    allRows: rows, allExcluded: excluded};
}

function formatPreview_(context, answers) {
  var defs = formatActiveDefinitions_();
  var read = readFile(context.fileId, context.fileName,
    {expectedKeywords: detectionKeywordUnion_(defs)});
  var sheet = read.sheets.filter(function(item) {
    return item.name === answers.sheetName;
  })[0];
  var blocking = [];
  var warnings = [];
  function block(code, detail) { blocking.push({code: code, detail: detail || null}); }
  function warn(code, detail) { warnings.push({code: code, detail: detail || null}); }
  if (!sheet) {
    block('DEFINITION_INVALID', '指定シートがありません');
    return {response: {ok: true, blocking: blocking, warnings: warnings, previewHash: null}};
  }
  var history = formatFolderHistory_(context.folder, context.fileId, context.customerId);
  var nearest = formatNearest_(defs, sheet, read.fileType, history);
  var selected = answers.baseFormatId ? nearest.filter(function(item) {
    return item.def.formatId === String(answers.baseFormatId);
  })[0] : null;
  if (answers.baseFormatId && !selected) {
    block('DEFINITION_INVALID', '土台の形式が候補にありません');
  }
  var base = selected ? selected.def : null;
  var reference = base && history[base.formatId] && history[base.formatId].reference;
  var referenceSheet = null;
  if (reference) {
    try {
      var referenceRead = readFile(reference.fileId, reference.fileName,
        {expectedKeywords: detectionKeywordUnion_(defs)});
      referenceSheet = referenceRead.sheets.filter(function(item) {
        return item.name === sheet.name;
      })[0] || referenceRead.sheets[0];
      context.referenceFileId = reference.fileId;
    } catch (error) {
      warn('REFERENCE_UNREADABLE', reference.fileName);
    }
  }
  var proposal = formatProposal_(sheet, read.fileType, context.folder.getName(),
    base, referenceSheet, loadFormatDefinitions({}));
  var purposeGap = base ? formatPurposeGap_(base, formatGap_(base, sheet, read.fileType), sheet) : null;
  var derived = formatDerivedSpec_(context, read, sheet, answers, base, proposal, purposeGap);
  var spec = derived.spec;
  var row = cardFormatRowValues_(spec, 1, nowIso_(), context.actor);
  var def = formatRowFromValues_(row, null);
  if (!def.valid) block('DEFINITION_INVALID', def.problems);
  if (!/^[a-z0-9_]{1,32}$/.test(spec.formatId)) block('FORMAT_ID_INVALID');
  if (loadFormatDefinitions({formatId: spec.formatId}).length) block('FORMAT_ID_TAKEN', spec.formatId);
  if (!spec.formatName || spec.formatName.length > 60 || /^[=+@-]/.test(spec.formatName))
    block('FORMAT_NAME_REQUIRED');
  if (!Number.isInteger(spec.headerRow) || spec.headerRow < 1 || spec.headerRow > sheet.rows.length)
    block('HEADER_ROW_INVALID');
  if (!Number.isInteger(spec.dataStartRow) || spec.dataStartRow <= spec.headerRow ||
      spec.dataStartRow > sheet.rows.length) block('DATA_START_INVALID');
  var roles = ['date', 'merchant', 'amount', 'purpose'];
  var columns = answers.columns || {};
  var width = detectorTableWidth_(sheet.rows, spec.headerRow,
    detectorProfileSamples_(sheet, def));
  var used = {};
  roles.forEach(function(role) {
    var index = detectorColumnIndex_(columns[role]);
    if (columns[role] && index >= width) block('COLUMN_OUT_OF_RANGE', role);
    if (columns[role] && used[columns[role]]) block('COLUMN_ROLE_DUPLICATE',
      used[columns[role]] + '/' + role);
    if (columns[role]) used[columns[role]] = role;
  });
  if (!columns.purpose) block('PURPOSE_COLUMN_REQUIRED');
  if (spec.keywordRule.allOf[0].keywords.length < 2) block('TOO_FEW_KEYWORDS');
  if (derived.droppedRules.length) warn('RULES_NOT_INHERITED', derived.droppedRules);
  if (derived.foreignDropped) warn('FOREIGN_NOT_INHERITED');
  var ack = answers.acknowledgements || {};
  var purposeHeader = columns.purpose ?
    String((sheet.rows[spec.headerRow - 1] || [])[detectorColumnIndex_(columns.purpose)] || '') : '';
  if ((purposeGap || columns.purpose &&
      normalizeMerchant(purposeHeader) !== normalizeMerchant('使用用途')) &&
      ack.customerSide !== true) block('ACK_CUSTOMER_SIDE_REQUIRED');
  if (columns.purpose && normalizeMerchant(purposeHeader) !== normalizeMerchant('使用用途'))
    warn('PURPOSE_HEADER_NOT_STANDARD', purposeHeader);
  if (proposal.amountCandidates.length >= 2 && ack.amountChoice !== true)
    block('ACK_AMOUNT_CHOICE_REQUIRED');
  var onNew = def.valid ? formatDetectRead_([def], read, context.fileName, context.fileId) : null;
  if (!onNew || onNew.status !== 'RESOLVED' || onNew.formatId !== def.formatId) {
    block('NOT_MATCHING_TARGET', def.valid ? formatGap_(def, sheet, read.fileType) : null);
  }
  var all = def.valid ? formatDetectRead_(defs.concat([def]), read,
    context.fileName, context.fileId) : null;
  var others = defs.filter(function(item) {
    return detectFormatWith([item], sheet, read.fileType, context.fileName).length > 0;
  }).map(function(item) { return item.formatId; });
  if (others.length) block('TARGET_AMBIGUOUS', others);
  defs.forEach(function(item) {
    var gap = formatGap_(item, sheet, read.fileType);
    var profile = item.columnProfile;
    if (profile && gap.keywords.ok && gap.width.actual >= profile.minColumns &&
        (profile.maxColumns === undefined || gap.width.actual <= profile.maxColumns) &&
        gap.stage === 'COLUMNS') block('STATIC_COLLISION', item.formatId);
  });
  if (referenceSheet && def.valid &&
      detectFormatWith([def], referenceSheet, read.fileType, reference.fileName).length) {
    block('REFERENCE_COLLISION', reference.fileName);
  }
  var extracted = null;
  if (def.valid && spec.headerRow >= 1 && spec.dataStartRow > spec.headerRow &&
      spec.dataStartRow <= sheet.rows.length && columns.date && columns.merchant && columns.amount) {
    extracted = formatPreviewExtraction_(context, sheet, def);
    if (!extracted.extraction.count) block('NO_TRANSACTIONS');
    if (extracted.extraction.zeroAmountCount * 2 > extracted.extraction.count)
      block('ZERO_AMOUNT_MAJORITY', extracted.extraction.zeroAmountCount);
    if (extracted.extraction.purposeEmptyCount)
      warn('PURPOSE_EMPTY_ROWS', extracted.extraction.purposeEmptyCount);
    if (extracted.extraction.category.category === 2)
      warn('CATEGORY_2', extracted.extraction.category.code);
    if (extracted.extraction.category.category === 3)
      warn('REVIEW_ROWS', extracted.reviewEntries.length);
    if (extracted.extraction.excluded.length)
      warn('EXCLUDED_ROWS', extracted.extraction.excluded.length);
    if (def.billingRule && extracted.extraction.billing.status !== 'RESOLVED')
      warn('BILLING_MONTH_UNRESOLVED');
  }
  var amountComparison = proposal.amountCandidates.map(function(candidate) {
    var index = detectorColumnIndex_(candidate.column);
    var selected = detectorColumnIndex_(columns.amount);
    var total = 0, differsRows = 0;
    (extracted ? extracted.allRows : []).forEach(function(item) {
      var rowValues = sheet.rows[item.sourceRow - 1] || [];
      var amount = interpretAmountCell(rowValues[index]);
      var chosen = interpretAmountCell(rowValues[selected]);
      total += amount.ok ? amount.amount : 0;
      if ((amount.ok ? amount.amount : null) !== (chosen.ok ? chosen.amount : null)) differsRows += 1;
    });
    return {column: candidate.column, header: candidate.header, total: total,
      differsRows: differsRows};
  });
  var previewHash = formatHashRow_(row, context.fileId, read.bytes, ack);
  spec.answers.previewHash = previewHash;
  var response = {ok: true, blocking: blocking, warnings: warnings,
    formatNames: defs.map(function(item) {
      return {formatId: item.formatId, formatName: item.formatName};
    }),
    definition: {formatId: spec.formatId, formatName: spec.formatName,
      keywords: spec.keywordRule.allOf[0].keywords, width: spec.columnProfile.minColumns,
      columns: columns},
    detection: {onTarget: onNew && onNew.status === 'RESOLVED' ?
      (others.length ? 'ALSO_OTHERS' : 'ONLY_NEW') : 'NONE', others: others},
    extraction: extracted ? extracted.extraction : null,
    amountComparison: amountComparison, previewHash: previewHash};
  return {response: response, spec: spec, row: row, def: def, read: read,
    sheet: sheet, extracted: extracted, allDetection: all};
}

function formatReadbackCellsEqual_(expected, actual) {
  var jsonColumns = {4: true, 5: true, 13: true, 14: true, 15: true,
    16: true, 27: true, 28: true, 34: true, 36: true};
  for (var index = 0; index < CARD_FORMAT_COLUMNS_; index += 1) {
    if (index === 19 || index === 21 || index === 33) continue;
    var left = expected[index], right = actual[index];
    if (left == null) left = '';
    if (right == null) right = '';
    if (jsonColumns[index] && left !== '' && right !== '') {
      try {
        left = JSON.parse(left);
        right = typeof right === 'string' ? JSON.parse(right) : right;
      } catch (error) { return false; }
      if (JSON.stringify(left) !== JSON.stringify(right)) return false;
    } else if (String(left) !== String(right)) return false;
  }
  return true;
}

function formatExtractionSignature_(extraction, allRows, allExcluded) {
  return JSON.stringify({count: extraction.count, total: extraction.total,
    rows: allRows.map(function(row) {
      return {sourceRow: row.sourceRow, amount: row.amount, purpose: row.purpose,
        merchant: row.merchant, date: row.date};
    }), excluded: allExcluded, category: extraction.category});
}

function formatSave_(context, answers, previewHash, startedAt) {
  var preview = formatPreview_(context, answers);
  var response = preview.response;
  if (String(response.previewHash) !== String(previewHash))
    return {saved: false, code: 'PREVIEW_STALE'};
  if (response.blocking.length) return {saved: false, blocking: response.blocking};
  var spec = preview.spec;
  var formatId = spec.formatId;
  var installation = withScriptLock_(function() {
    if (loadFormatDefinitions({formatId: formatId}).length)
      return {installed: false};
    return installCardFormat(spec);
  });
  if (!installation.installed) return {saved: false,
    blocking: [{code: 'FORMAT_ID_TAKEN', detail: formatId}]};
  try {
  appendAudit({type: 'FORMAT_REGISTER', actor: context.actor,
    targetType: 'FORMAT', targetId: formatId, customerId: context.customerId,
    after: {formatId: formatId, version: 1,
      baseFormatId: spec.answers.baseFormatId,
      sourceFileId: context.fileId, previewHash: previewHash}});
  var loaded = loadFormatDefinitions({formatId: formatId, version: 1});
  var actualRow = loaded.length === 1 ? readRowByNumber_(
    requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CARD_FORMAT_MASTER),
    loaded[0]._rowNumber, CARD_FORMAT_COLUMNS_) : null;
  var expectedRow = cardFormatRowValues_(spec, 1, nowIso_(), context.actor);
  var cellMatch = actualRow && formatReadbackCellsEqual_(expectedRow, actualRow);
  var extractionMatch = false;
  var detectionMatch = false;
  var after = null;
  if (loaded.length === 1 && loaded[0].valid) {
    var readback = formatPreviewExtraction_(context, preview.sheet, loaded[0]);
    after = {count: readback.extraction.count, total: readback.extraction.total,
      category: readback.extraction.category};
    extractionMatch = preview.extracted &&
      formatExtractionSignature_(preview.extracted.extraction, preview.extracted.allRows,
        preview.extracted.allExcluded) ===
      formatExtractionSignature_(readback.extraction, readback.allRows,
        readback.allExcluded);
    var allDefs = formatActiveDefinitions_();
    var verdict = formatDetectRead_(allDefs, preview.read,
      context.fileName, context.fileId);
    detectionMatch = verdict.status === 'RESOLVED' && verdict.formatId === formatId;
  }
  if (!cellMatch || !extractionMatch || !detectionMatch) {
    var diff = {cells: Boolean(cellMatch), extraction: Boolean(extractionMatch),
      detection: Boolean(detectionMatch), after: after};
    disableCardFormat_(formatId, 'READBACK_MISMATCH', context.actor);
    return {saved: true, formatId: formatId, version: 1,
      readback: 'MISMATCH', disabled: true, diff: diff};
  }
  } catch (error) {
    var disabled = false;
    try {
      disableCardFormat_(formatId, 'READBACK_UNCERTAIN', context.actor);
      disabled = true;
    } catch (disableError) { /* 無効化も失敗した場合は画面で取消しを案内する。 */ }
    return {saved: true, formatId: formatId, version: 1,
      readback: 'UNCERTAIN', disabled: disabled,
      detail: String(error && error.message || error)};
  }
  try {
  var eligible = openReviews({reviewType: 'FORMAT_UNKNOWN'}).filter(function(review) {
    return String(review.customerId) === String(context.customerId) &&
      String(review.fileId) !== String(context.fileId) &&
      (review.status === 'OPEN' || review.status === 'IN_PROGRESS');
  });
  var files = webAppIteratorToArray_(context.folder.getFiles());
  var byId = Object.create(null);
  files.forEach(function(file) { byId[String(file.getId())] = file; });
  eligible = eligible.filter(function(review) {
    return Boolean(byId[String(review.fileId)]);
  }).sort(function(a, b) {
    return String(a.fileId) < String(b.fileId) ? -1 :
      (String(a.fileId) > String(b.fileId) ? 1 : 0);
  });
  var siblings = [], siblingsNotRead = [];
  eligible.forEach(function(review) {
    var fileId = String(review.fileId);
    if (siblings.length >= WEBAPP_FORMAT_SIBLING_LIMIT_ ||
        webAppFormatNowMs_() - startedAt + WEBAPP_FORMAT_FILE_WORST_MS_ >
          WEBAPP_DEADLINE_MS_) {
      siblingsNotRead.push(fileId); return;
    }
    try {
      var fileName = String(byId[fileId].getName());
      var read = readFile(fileId, fileName,
        {expectedKeywords: detectionKeywordUnion_(formatActiveDefinitions_())});
      var result = formatDetectRead_(formatActiveDefinitions_(), read, fileName, fileId);
      siblings.push({fileId: fileId, fileName: fileName, reviewId: review.reviewId,
        verdict: result.status === 'RESOLVED' ?
          (result.formatId === formatId ? 'MATCHES_NEW' : 'MATCHES_OTHER') :
          (result.status === 'UNKNOWN_CARD_FORMAT' ? 'NO_MATCH' : 'AMBIGUOUS')});
    } catch (error) {
      siblingsNotRead.push(fileId);
    }
  });
  return {saved: true, formatId: formatId, version: 1, readback: 'OK',
    after: after, siblings: siblings, siblingsNotRead: siblingsNotRead};
  } catch (error) {
    return {saved: true, formatId: formatId, version: 1, readback: 'OK',
      after: after, siblings: [], siblingsError: true};
  }
}

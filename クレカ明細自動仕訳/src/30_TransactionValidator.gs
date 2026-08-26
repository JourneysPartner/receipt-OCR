'use strict';

/**
 * カード形式ごとの年推定窓を取得する。
 * Y/Z列由来の値が空の場合だけシステム既定値を使う。
 * @param {!Object} cardFormat
 * @return {{lookback:number, forward:number}}
 */
function getYearInferenceWindow_(cardFormat) {
  var format = cardFormat || {};
  var lookback = format.yearInferenceLookbackMonths;
  var forward = format.yearInferenceForwardMonths;
  if (lookback === null || lookback === undefined || lookback === '') {
    lookback = format.lookbackMonths;
  }
  if (forward === null || forward === undefined || forward === '') {
    forward = format.forwardMonths;
  }
  if (lookback === null || lookback === undefined || lookback === '') {
    lookback = SETTINGS.YEAR_INFERENCE_MAX_LOOKBACK_MONTHS;
  }
  if (forward === null || forward === undefined || forward === '') {
    forward = SETTINGS.YEAR_INFERENCE_MAX_FORWARD_MONTHS;
  }
  lookback = Number(lookback);
  forward = Number(forward);
  if (!Number.isInteger(lookback) || lookback < 0 || !Number.isInteger(forward) || forward < 0) {
    throw new TypeError('Year inference window must contain non-negative integers');
  }
  return {lookback: lookback, forward: forward};
}

/** @param {number} value @return {string} */
function pad2_(value) {
  return String(value).padStart(2, '0');
}

/**
 * 年補完の行単位要確認材料を作る。
 * @param {!Object} tx
 * @param {string} code
 * @param {string} status
 * @param {?Object} base
 * @param {!Array<!Object>=} candidates
 * @return {!Object}
 */
function makeDateIssue_(tx, code, status, base, candidates, window) {
  return {
    transactionId: tx.transactionId,
    sourceRow: tx.sourceRow,
    reviewType: REVIEW_TYPE.DATE,
    code: code,
    // キーは2.1.7.1のとおり。担当者が「なぜこの年になったのか」を追えるよう、
    // 許容窓（何か月前後まで見たか）も残す。これが無いと、窓の設定違いで
    // 起きた不一致を後から説明できない。
    detail: {
      kind: 'DATE_INFERENCE',
      status: status,
      baseYearMonth: base && base.status === DATE_INFERENCE_STATUS.RESOLVED ?
        String(base.year) + '-' + pad2_(base.month) : null,
      candidates: candidates || [],
      lookbackMonths: window ? window.lookback : SETTINGS.YEAR_INFERENCE_MAX_LOOKBACK_MONTHS,
      forwardMonths: window ? window.forward : SETTINGS.YEAR_INFERENCE_MAX_FORWARD_MONTHS
    }
  };
}

/**
 * 候補年を推定窓と実在性で絞る。入力順や前後行は参照しない。
 * @param {!Array<number>} candidateYears
 * @param {number} month
 * @param {number} day
 * @param {number} windowStart
 * @param {number} windowEnd
 * @return {{validYears:!Array<number>, details:!Array<!Object>, hadInWindow:boolean}}
 */
function filterDateCandidates_(candidateYears, month, day, windowStart, windowEnd) {
  var validYears = [];
  var hadInWindow = false;
  var details = candidateYears.map(function(year) {
    var inWindow = monthOrdinal(year, month) >= windowStart &&
      monthOrdinal(year, month) <= windowEnd;
    var exists = dateExists(year, month, day);
    if (inWindow) {
      hadInWindow = true;
    }
    if (inWindow && exists) {
      validYears.push(year);
    }
    return {year: year, month: month, day: day, inWindow: inWindow, exists: exists};
  });
  return {validYears: validYears, details: details, hadInWindow: hadInWindow};
}

/**
 * §5.1 規則1〜5・7だけを適用し、処理日に依存しない利用日を導出する。
 * @param {!Array<!Object>} txs
 * @param {!Object} base
 * @param {!Object} cardFormat
 * @return {{txs:!Array<!Object>, ambiguous:boolean, reason:?string, rowIssues:!Array<!Object>}}
 */
function inferYearsForFile(txs, base, cardFormat) {
  if (!Array.isArray(txs) || !base || typeof base.status !== 'string') {
    throw new TypeError('inferYearsForFile requires transactions and a billing-month result');
  }
  var resolved = base.status === DATE_INFERENCE_STATUS.RESOLVED;
  if (resolved && (!Number.isInteger(base.year) || !Number.isInteger(base.month))) {
    throw new TypeError('Resolved billing month requires an integer year and month');
  }

  var window = getYearInferenceWindow_(cardFormat);
  var windowStart = resolved ? monthOrdinal(base.year, base.month) - window.lookback : null;
  var windowEnd = resolved ? monthOrdinal(base.year, base.month) + window.forward : null;
  var source = Array.isArray(base.sources) ? base.sources.join(',') : String(base.sources || '');
  var inferenceBase = resolved ? String(base.year) + '-' + pad2_(base.month) : null;
  var rowIssues = [];
  var fileAmbiguous = false;

  var output = txs.map(function(original) {
    var tx = Object.assign({}, original);
    var isTwoDigitYear = tx.dateYearDigits === 2;
    var needsYearInference = tx.dateYearMissing === true || isTwoDigitYear;
    if (!needsYearInference) {
      return tx;
    }

    if (!resolved) {
      tx.date = null;
      fileAmbiguous = true;
      var unresolvedCode = base.status === DATE_INFERENCE_STATUS.CONFLICT ?
        'BILLING_MONTH_CONFLICT' : 'BILLING_MONTH_NOT_FOUND';
      rowIssues.push(makeDateIssue_(tx, unresolvedCode, base.status, base, [], window));
      return tx;
    }

    var monthDay = tx.dateMonthDay;
    if (!monthDay || !Number.isInteger(monthDay.month) || !Number.isInteger(monthDay.day)) {
      throw new TypeError('A date requiring inference must contain dateMonthDay');
    }
    var candidateYears = isTwoDigitYear ?
      [1900 + tx.dateYear, 2000 + tx.dateYear, 2100 + tx.dateYear] :
      [base.year - 1, base.year, base.year + 1];
    var filtered = filterDateCandidates_(
      candidateYears,
      monthDay.month,
      monthDay.day,
      windowStart,
      windowEnd
    );

    if (filtered.validYears.length !== 1) {
      tx.date = null;
      var code = filtered.hadInWindow && filtered.validYears.length === 0 ?
        'DATE_NOT_EXISTENT' : 'DATE_OUT_OF_EXPECTED_RANGE';
      var status = code === 'DATE_NOT_EXISTENT' ?
        DATE_INFERENCE_STATUS.NOT_EXISTENT :
        (filtered.validYears.length > 1 ? DATE_INFERENCE_STATUS.MULTI_CANDIDATE : DATE_INFERENCE_STATUS.NO_CANDIDATE);
      rowIssues.push(makeDateIssue_(tx, code, status, base, filtered.details, window));
      return tx;
    }

    var year = filtered.validYears[0];
    tx.date = tokyoDate_(year, monthDay.month, monthDay.day);
    tx.dateTimezone = SYSTEM_TIMEZONE;
    tx.dateInferenceSource = source;
    tx.dateInferenceBase = inferenceBase;
    if (isTwoDigitYear) {
      tx.dateHashKey = String(year) + '-' + pad2_(monthDay.month) + '-' + pad2_(monthDay.day);
    }
    return tx;
  });

  return {
    txs: output,
    ambiguous: fileAmbiguous,
    reason: fileAmbiguous ? base.status : null,
    rowIssues: rowIssues
  };
}

/**
 * DateのAsia/Tokyo基準年月日を数値で返す。
 * @param {!Date} date
 * @return {{year:number, month:number, day:number, text:string}}
 */
function tokyoDateParts_(date) {
  var text = toTokyoDateString_(date);
  var parts = text.split('-').map(Number);
  return {year: parts[0], month: parts[1], day: parts[2], text: text};
}

/**
 * §5.1 規則6a〜6dを適用する。導出済みdateは変更しない。
 * @param {!Array<!Object>} txs
 * @param {!Object} base
 * @param {!Date} processingDate
 * @return {{issues:!Array<!Object>, blankDateTxIds:!Array<string>, fileDateInferenceAmbiguous:boolean}}
 */
function applyDateTriageChecks(txs, base, processingDate) {
  if (!Array.isArray(txs) || !base || !isDate_(processingDate) || isNaN(processingDate.getTime())) {
    throw new TypeError('applyDateTriageChecks requires transactions, base, and processingDate');
  }
  var processing = tokyoDateParts_(processingDate);
  var resolved = base.status === DATE_INFERENCE_STATUS.RESOLVED;
  var anchorYear = resolved ? base.year : processing.year;
  var anchorMonth = resolved ? base.month : processing.month;
  var healthyStart = monthOrdinal(anchorYear, anchorMonth) - SETTINGS.DATED_DATE_MAX_LOOKBACK_MONTHS;
  var healthyEnd = monthOrdinal(anchorYear, anchorMonth) + SETTINGS.DATED_DATE_MAX_FORWARD_MONTHS;
  var futureBase = resolved && tokyoDate_(base.year, base.month, 1).getTime() >
    tokyoDate_(processing.year, processing.month, processing.day).getTime();
  var blank = Object.create(null);
  var issueById = Object.create(null);

  function addIssue(tx, status) {
    var id = String(tx.transactionId);
    blank[id] = true;
    if (!issueById[id]) {
      issueById[id] = makeDateIssue_(
        tx,
        'DATE_OUT_OF_EXPECTED_RANGE',
        status,
        base
      );
    }
  }

  txs.forEach(function(tx) {
    if (!tx.date) {
      return;
    }
    var parts = tokyoDateParts_(tx.date);
    var isOriginalDated = tx.dateYearMissing !== true;
    if (isOriginalDated) {
      var ordinal = monthOrdinal(parts.year, parts.month);
      if (ordinal < healthyStart || ordinal > healthyEnd) {
        addIssue(tx, DATE_INFERENCE_STATUS.OUT_OF_RANGE);
      }
    }
    if (parts.text > processing.text) {
      addIssue(tx, DATE_INFERENCE_STATUS.FUTURE);
    }
  });

  if (futureBase) {
    txs.forEach(function(tx) {
      if (tx.dateYearMissing === true) {
        addIssue(tx, DATE_INFERENCE_STATUS.FUTURE);
      }
    });
  }

  return {
    issues: Object.keys(issueById).map(function(id) { return issueById[id]; }),
    blankDateTxIds: Object.keys(blank),
    fileDateInferenceAmbiguous: futureBase && txs.some(function(tx) {
      return tx.dateYearMissing === true;
    })
  };
}

/**
 * §5.3 M11。条件1の打切り後に残る明細候補行を数える。
 * @param {!Object} parseResult
 * @return {{ok:boolean, stopRow:number, remainingCandidateRows:number}}
 */
function checkScanTruncation(parseResult) {
  if (!parseResult || !Array.isArray(parseResult.rows)) {
    throw new TypeError('checkScanTruncation requires an in-memory parse result');
  }
  var stopIndex = parseResult.stopIndex;
  if (!Number.isInteger(stopIndex)) {
    throw new TypeError('checkScanTruncation requires stopIndex');
  }
  var stopRow = stopIndex + 1;
  if (parseResult.stopReason !== 'EMPTY_RUN') {
    return {ok: true, stopRow: stopRow, remainingCandidateRows: 0};
  }
  var dateColumn = parseResult.dateColumnIndex;
  var amountColumn = parseResult.amountColumnIndex;
  var count = parseResult.rows.slice(stopIndex + 1).filter(function(row) {
    var date = row[dateColumn];
    var amount = row[amountColumn];
    return !(date === null || date === undefined || date === '') ||
      !(amount === null || amount === undefined || amount === '');
  }).length;
  return {ok: count === 0, stopRow: stopRow, remainingCandidateRows: count};
}

/** @param {*} value @return {?number} */
function reconciliationNumber_(value) {
  var canonical = cellToCanonicalString(value);
  if (canonical === null || canonical === '' || !/^[+-]?\d+(?:\.\d+)?$/.test(canonical)) {
    return null;
  }
  var number = Number(canonical);
  return isFinite(number) ? number : null;
}

/** @param {string} column @return {number} */
function columnNumber_(column) {
  var text = String(column || '').toUpperCase();
  if (!/^[A-Z]+$/.test(text)) return -1;
  var number = 0;
  for (var index = 0; index < text.length; index += 1) {
    number = number * 26 + text.charCodeAt(index) - 64;
  }
  return number;
}

/** @param {!Object} sheet @param {string} a1 @return {*} */
function reconciliationCell_(sheet, a1) {
  if (sheet && sheet.cells && Object.prototype.hasOwnProperty.call(sheet.cells, a1)) {
    return sheet.cells[a1];
  }
  var match = String(a1 || '').toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!match || !sheet || !Array.isArray(sheet.values)) return null;
  var row = Number(match[2]) - 1;
  var column = columnNumber_(match[1]) - 1;
  return sheet.values[row] && sheet.values[row][column] !== undefined ? sheet.values[row][column] : null;
}

/** @param {!Object} item @param {!Object} sheet @return {{applicable:boolean,value:?number}} */
function reconciliationExpected_(item, sheet) {
  if (!item || item.source === 'none') return {applicable: false, value: null};
  var raw = null;
  if (item.source === 'cell') {
    raw = reconciliationCell_(sheet, item.cell);
  } else if (item.source === 'labeledRow') {
    var rows = sheet && Array.isArray(sheet.rows) ? sheet.rows : [];
    var wanted = normalizeMerchant(item.label || '');
    for (var index = 0; index < rows.length; index += 1) {
      var row = rows[index];
      var label = Array.isArray(row) ? row[columnNumber_(item.labelColumn) - 1] : row[item.labelColumn];
      if (normalizeMerchant(label) === wanted) {
        raw = Array.isArray(row) ? row[columnNumber_(item.valueColumn) - 1] : row[item.valueColumn];
        break;
      }
    }
  } else {
    return {applicable: false, value: null};
  }
  var number = reconciliationNumber_(raw);
  return number === null ? {applicable: false, value: null} : {applicable: true, value: number};
}

/**
 * 許可された字句だけで整数式を評価する。evalは使用しない。
 * @param {string} expression
 * @param {!Object<string,number>} variables
 * @return {number}
 */
function evaluateReconciliationExpression_(expression, variables) {
  var source = String(expression);
  var tokens = [];
  var cursor = 0;
  var tokenPattern = /\s*(SUM_POSITIVE|SUM_NEGATIVE|SUM|COUNT|\d+|[()+\-*\/])/y;
  while (cursor < source.length) {
    tokenPattern.lastIndex = cursor;
    var match = tokenPattern.exec(source);
    if (!match) throw new FormatDefinitionError('Invalid reconciliation expression token');
    tokens.push(match[1]);
    cursor = tokenPattern.lastIndex;
  }
  var position = 0;
  function parsePrimary() {
    var token = tokens[position++];
    if (token === '(') {
      var grouped = parseAdditive();
      if (tokens[position++] !== ')') throw new FormatDefinitionError('Unclosed reconciliation expression group');
      return grouped;
    }
    if (token === '+' || token === '-') {
      var unary = parsePrimary();
      return token === '-' ? -unary : unary;
    }
    if (/^\d+$/.test(token || '')) return Number(token);
    if (Object.prototype.hasOwnProperty.call(variables, token)) return variables[token];
    throw new FormatDefinitionError('Invalid reconciliation expression operand');
  }
  function parseMultiplicative() {
    var value = parsePrimary();
    while (tokens[position] === '*' || tokens[position] === '/') {
      var operator = tokens[position++];
      var right = parsePrimary();
      if (operator === '/') {
        if (right === 0) throw new FormatDefinitionError('Division by zero in reconciliation expression');
        value = Math.trunc(value / right);
      } else {
        value *= right;
      }
    }
    return value;
  }
  function parseAdditive() {
    var value = parseMultiplicative();
    while (tokens[position] === '+' || tokens[position] === '-') {
      var operator = tokens[position++];
      var right = parseMultiplicative();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }
  if (!tokens.length) throw new FormatDefinitionError('Empty reconciliation expression');
  var result = parseAdditive();
  if (position !== tokens.length || !Number.isSafeInteger(result)) {
    throw new FormatDefinitionError('Invalid reconciliation expression result');
  }
  return result;
}

/** @param {!Object} processLogRow @param {string} code @return {boolean} */

/** 処理ログAK列へ保存する承認DTOを作る。 */
/**
 * 区分2解決承認の要素を作る（2.1.8.2）。
 *
 * **スキーマは1つだけである。** 以前は生成側が`{approved, code, contentHash,
 * actor}`、保存側が`approvedBy`／`approvedAt`、判定側が`hashVersion`を
 * 見ており、**生成した承認を保存しても判定側が永遠に偽を返した**。その結果、
 * 担当者が承認しても再検証で同じ区分2が再検出され、`REVIEW_WAIT`へ戻る
 * 無限ループになる（INV-28）。
 */
function createValidationApproval(code, contentHash, hashVersion, approvedBy, options) {
  options = options || {};
  if (!code || !contentHash || !hashVersion || !approvedBy) {
    throw new TypeError(
      'createValidationApproval requires code, contentHash, hashVersion, and approvedBy');
  }
  var approval = {
    code: String(code), contentHash: String(contentHash), hashVersion: String(hashVersion),
    approvedBy: String(approvedBy), approvedAt: options.approvedAt || nowIso_()
  };
  if (options.reason) approval.reason = String(options.reason);
  if (options.evidence) approval.evidence = options.evidence;
  return approval;
}

/**
 * §5.9 / §2.1.2.5。
 */
function verifyCountsAndTotals(txs, cardFormat, sheet, processLogRow) {
  if (!Array.isArray(txs)) throw new TypeError('verifyCountsAndTotals requires transactions');
  if (txs.length === 0) {
    return {ok: false, expected: {}, actual: {count: 0, total: 0}, kind: 'EMPTY', code: 'EMPTY_FILE_CONFIRMATION_REQUIRED'};
  }
  var rawRule = cardFormat && (cardFormat.countTotalRule !== undefined ?
    cardFormat.countTotalRule : cardFormat.reconciliationRule);
  var rule;
  try {
    rule = typeof rawRule === 'string' ? JSON.parse(rawRule) : rawRule;
  } catch (error) {
    return {ok: false, expected: {}, actual: {}, kind: 'DEFINITION', code: 'CARD_FORMAT_DEFINITION_INVALID'};
  }
  if (!rule) rule = {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'};
  var countExpected = reconciliationExpected_(rule.count, sheet || {});
  var totalExpected = reconciliationExpected_(rule.total, sheet || {});
  if (!countExpected.applicable && !totalExpected.applicable) {
    return {ok: true, expected: {}, actual: {}, kind: 'NOT_APPLICABLE'};
  }

  var amounts = txs.map(function(transaction) { return toJpyInteger(transaction.amountBillingJpy); });
  var sum = amounts.reduce(function(total, amount) { return total + amount; }, 0);
  var sumPositive = amounts.filter(function(amount) { return amount > 0; }).reduce(function(total, amount) { return total + amount; }, 0);
  var sumNegative = amounts.filter(function(amount) { return amount < 0; }).reduce(function(total, amount) { return total + amount; }, 0);
  var totalActual = rule.totalScope === 'all' || !rule.totalScope ? sum : sumPositive;
  try {
    if (rule.total && rule.total.expression) {
      totalActual = evaluateReconciliationExpression_(rule.total.expression, {
        SUM: sum,
        SUM_POSITIVE: sumPositive,
        SUM_NEGATIVE: sumNegative,
        COUNT: txs.length
      });
    }
  } catch (error) {
    if (error && error.code === 'CARD_FORMAT_DEFINITION_INVALID') {
      return {ok: false, expected: {}, actual: {}, kind: 'DEFINITION', code: 'CARD_FORMAT_DEFINITION_INVALID'};
    }
    throw error;
  }

  var expected = {};
  var actual = {};
  if (countExpected.applicable) {
    expected.count = countExpected.value;
    actual.count = txs.length;
  }
  if (totalExpected.applicable) {
    expected.total = totalExpected.value;
    actual.total = totalActual;
  }
  var countMismatch = countExpected.applicable &&
    Math.abs(countExpected.value - txs.length) > Number((rule.count && rule.count.tolerance) || 0);
  var totalMismatch = totalExpected.applicable &&
    Math.abs(totalExpected.value - totalActual) > Number((rule.total && rule.total.tolerance) || 0);
  if (!countMismatch && !totalMismatch) {
    return {ok: true, expected: expected, actual: actual, kind: 'MATCH'};
  }
  // 承認済みかの判定は1つの関数に集約する（2.1.8.2 評価規則）。
  if (validationCauseApproved_(processLogRow, 'COUNT_TOTAL_MISMATCH')) {
    return {ok: true, expected: expected, actual: actual, kind: countMismatch ? 'COUNT' : 'TOTAL', approved: true};
  }
  return {
    ok: false,
    expected: expected,
    actual: actual,
    kind: countMismatch ? 'COUNT' : 'TOTAL',
    code: 'COUNT_TOTAL_MISMATCH'
  };
}

/**
 * §5.12。処理日を引数に取らず、対象年度だけで判定する。
 * @param {!Array<!Object>} txs
 * @param {!Object} customer
 * @param {!Array<string>} blankDateTxIds
 * @return {{issues:!Array<!Object>}}
 */
function checkPriorYearUsage(txs, customer, blankDateTxIds) {
  if (!Array.isArray(txs) || !customer || !Array.isArray(blankDateTxIds)) {
    throw new TypeError('checkPriorYearUsage requires transactions, customer, and blank-date ids');
  }
  if (customer.customerCategory === CUSTOMER_CATEGORY.CORPORATE) {
    return {issues: []};
  }
  if (customer.customerCategory !== CUSTOMER_CATEGORY.INDIVIDUAL ||
      !Number.isInteger(customer.fiscalYear) || customer.fiscalYear < 2000 || customer.fiscalYear > 2999) {
    throw new MasterDataError('INDIVIDUAL customer requires fiscalYear 2000..2999');
  }
  var blank = Object.create(null);
  blankDateTxIds.forEach(function(id) { blank[String(id)] = true; });
  var thresholdYear = customer.fiscalYear - 1;
  var issues = [];
  txs.forEach(function(transaction) {
    if (!transaction.date || blank[String(transaction.transactionId)]) return;
    var usageDate = toTokyoDateString_(transaction.date);
    var usageYear = Number(usageDate.slice(0, 4));
    if (usageYear <= thresholdYear) {
      issues.push({
        transactionId: transaction.transactionId,
        reviewType: REVIEW_TYPE.PRIOR_YEAR,
        code: 'PRIOR_YEAR_USAGE_DATE',
        detail: {
          kind: REVIEW_TYPE.PRIOR_YEAR,
          customerCategory: CUSTOMER_CATEGORY.INDIVIDUAL,
          fiscalYear: customer.fiscalYear,
          thresholdYear: thresholdYear,
          usageDate: usageDate
        }
      });
    }
  });
  return {issues: issues};
}

/** テストベクトル用。処理日は更新漏れ通知にだけ用いる。 */
function evaluatePriorYearVector(txs, customer, blankDateTxIds, processingDate) {
  var judgement = checkPriorYearUsage(txs, customer, blankDateTxIds);
  var stale = false;
  if (customer.customerCategory === CUSTOMER_CATEGORY.INDIVIDUAL && isDate_(processingDate)) {
    stale = customer.fiscalYear < tokyoDateParts_(processingDate).year - 1;
  }
  return {
    issues: judgement.issues,
    staleFiscalYearNotification: stale,
    stopProcessing: false
  };
}

/** 前年利用の担当者判断のうち、5.12ケース8で必要な純粋な状態変換。 */
function resolvePriorYearUsage(transaction, operation) {
  var result = Object.assign({}, transaction);
  if (operation === 'EXCLUDE_PRIOR_YEAR') {
    result.transactionStatus = TX_STATUS.CANCELED;
    result.clearDestinationRow = true;
    result.retainTransactionLog = true;
  } else if (operation === 'POST_PRIOR_YEAR') {
    result.transactionStatus = TX_STATUS.COMMITTED;
    result.clearDestinationRow = false;
    result.retainTransactionLog = true;
  } else {
    throw new TypeError('Unsupported prior-year resolution operation');
  }
  return result;
}

/** @param {!Object} input @param {string} code @return {boolean} */
/**
 * 当該要因が承認済みか（2.1.8.2 評価規則）。
 *
 * `contentHash`と`hashVersion`の双方が現在値と一致する場合にのみ有効とする。
 * ハッシュを条件に含めるのは、承認後に顧客が中身の違うファイルを同じ
 * ファイルIDで差し替えたときに、古い承認が新しい内容へ流用されるのを
 * 防ぐためである。
 */
function validationCauseApproved_(input, code) {
  var approvals = (input && input.validationApprovals) || [];
  var currentHash = input && input.contentHash;
  var currentVersion = input && input.hashVersion;
  // 必須キーが欠けている状態を「一致」にしない。undefined 同士を比べると
  // 素通りし、承認していない要因が承認済みとして扱われる。
  if (!currentHash || !currentVersion) return false;
  return approvals.some(function(approval) {
    if (!approval || !approval.contentHash || !approval.hashVersion) return false;
    return String(approval.code) === String(code) &&
      String(approval.contentHash) === String(currentHash) &&
      String(approval.hashVersion) === String(currentVersion);
  });
}

/** @param {string} code @param {string} reviewType @return {!Object} */
function validationReview_(code, reviewType) {
  return {code: code, reviewType: reviewType};
}

/** §5.10。区分2→1→3の順で判定する。 */
/**
 * B列予定値を空欄にする取引ID（INV-33）。
 *
 * **要確認`DATE`が立つ行はすべて対象である。** 由来は2つあり、どちらか
 * 一方だけを見てはならない。
 *   1. 年補完で年が一意に確定しなかった行（`inferYearsForFile`の`rowIssues`）
 *   2. 日付が期待範囲外・未来だった行（`applyDateTriageChecks`の`blankDateTxIds`）
 *
 * 1を落とすと、**年が曖昧で最も信用できない行の推定日付がそのまま顧客の
 * freee出納帳へ出る。** 担当者はそれが推定であることを知らずに取り込む。
 *
 * @return {!Array<string>}
 */
function blankedDateTransactionIds(yearInference, dateTriage) {
  var blank = Object.create(null);
  ((yearInference && yearInference.rowIssues) || []).forEach(function(issue) {
    if (issue && issue.transactionId) blank[String(issue.transactionId)] = true;
  });
  ((dateTriage && dateTriage.blankDateTxIds) || []).forEach(function(id) {
    blank[String(id)] = true;
  });
  return Object.keys(blank);
}

function classifyValidationResult(input) {
  if (!input) throw new TypeError('classifyValidationResult requires all validation results');
  var category2 = [];
  function addCategory2(condition, code, reviewType) {
    if (condition && !validationCauseApproved_(input, code)) {
      category2.push(validationReview_(code, reviewType));
    }
  }
  var format = input.format || {};
  var destination = input.destinationSchema || {};
  var encoding = input.encoding || {};
  addCategory2(format.ok === false && format.code === 'UNKNOWN_CARD_FORMAT', 'UNKNOWN_CARD_FORMAT', REVIEW_TYPE.FORMAT_UNKNOWN);
  addCategory2(format.ok === false && format.code === 'AMBIGUOUS_CARD_FORMAT', 'AMBIGUOUS_CARD_FORMAT', REVIEW_TYPE.FORMAT_AMBIGUOUS);
  addCategory2(format.ok === false && format.code === 'MULTI_SHEET_AMBIGUOUS', 'MULTI_SHEET_AMBIGUOUS', REVIEW_TYPE.MULTI_SHEET);
  addCategory2(
    (format.ok === false && format.code === 'CARD_FORMAT_DEFINITION_INVALID') ||
      (input.countsTotals && input.countsTotals.ok === false && input.countsTotals.code === 'CARD_FORMAT_DEFINITION_INVALID'),
    'CARD_FORMAT_DEFINITION_INVALID',
    REVIEW_TYPE.FORMAT_UNKNOWN
  );
  addCategory2(destination.ok === false && destination.code === 'DESTINATION_SCHEMA_MISMATCH', 'DESTINATION_SCHEMA_MISMATCH', REVIEW_TYPE.DESTINATION_FIX);
  addCategory2(destination.ok === false && destination.code === 'DESTINATION_TEMPLATE_ROW_NOT_EMPTY', 'DESTINATION_TEMPLATE_ROW_NOT_EMPTY', REVIEW_TYPE.DESTINATION_FIX);
  addCategory2(encoding.ok === false && encoding.code === 'ENCODING_DETECTION_FAILED', 'ENCODING_DETECTION_FAILED', REVIEW_TYPE.FORMAT_UNKNOWN);
  addCategory2(encoding.ok === false && encoding.code === 'CSV_PARSE_FAILED', 'CSV_PARSE_FAILED', REVIEW_TYPE.FORMAT_UNKNOWN);
  addCategory2(input.duplicate && input.duplicate.duplicate, 'DUPLICATE_CONTENT', REVIEW_TYPE.DUPLICATE);
  addCategory2(input.purposeRevision && input.purposeRevision.candidate, 'PURPOSE_REVISION_CANDIDATE', REVIEW_TYPE.DUPLICATE);
  addCategory2(input.countsTotals && input.countsTotals.ok === false && input.countsTotals.code === 'COUNT_TOTAL_MISMATCH', 'COUNT_TOTAL_MISMATCH', REVIEW_TYPE.COUNT_TOTAL_MISMATCH);
  addCategory2(input.scanTruncation && input.scanTruncation.ok === false, 'SCAN_TRUNCATION_SUSPECTED', REVIEW_TYPE.SCAN_TRUNCATED);
  addCategory2(input.effectiveTransactionCount === 0, 'EMPTY_FILE_CONFIRMATION_REQUIRED', REVIEW_TYPE.EMPTY_FILE);
  addCategory2(input.inputLimit && input.inputLimit.ok === false, 'INPUT_LIMIT_EXCEEDED', REVIEW_TYPE.INPUT_LIMIT);
  if (category2.length) {
    return {category: 2, code: category2[0].code, reviewEntries: category2, blankDateTxIds: []};
  }

  var transactionIssues = input.transactionValidation && input.transactionValidation.issues || [];
  var customerFix = (input.purposeResolution && input.purposeResolution.unresolvedCount > 0) ||
    transactionIssues.some(function(issue) { return issue.customerFix === true || issue.kind === 'MERCHANT_REQUIRED'; });
  if (customerFix) {
    return {category: 1, code: 'SOURCE_REQUIRES_CUSTOMER_FIX', reviewEntries: [], blankDateTxIds: []};
  }

  var reviews = [];
  transactionIssues.forEach(function(issue) {
    if (!issue.customerFix && issue.kind !== 'MERCHANT_REQUIRED') reviews.push(issue);
  });
  var yearIssues = input.yearInference && input.yearInference.rowIssues || [];
  var dateIssues = input.dateTriage && input.dateTriage.issues || [];
  var priorIssues = input.priorYear && input.priorYear.issues || [];
  reviews = reviews.concat(yearIssues, dateIssues, priorIssues);
  // 年補完の行単位不備と日付選別の双方から求める（INV-33）。
  var blankDateTxIds = blankedDateTransactionIds(input.yearInference, input.dateTriage);
  // foreignCurrency はINV-38により意図的に区分材料へ加えない。
  if (reviews.length) {
    return {category: 3, code: reviews[0].code || null, reviewEntries: reviews, blankDateTxIds: blankDateTxIds.slice()};
  }
  return {category: null, code: null, reviewEntries: [], blankDateTxIds: blankDateTxIds.slice()};
}

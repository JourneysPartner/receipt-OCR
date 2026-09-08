'use strict';

// 46・47列目は相手税区分の予定値・読取確認値。**末尾に足す** ── 予定値の
// ブロック(19〜23)の途中へ挿すと、以降20列分の意味がずれて既存行が壊れる。
const TRANSACTION_LOG_WIDTH_ = 47;
const TX_INDEX_WIDTH_ = 11;

function transactionLogSheet_() { return requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.TRANSACTION_LOG); }

function txIndexSpreadsheet_() {
  if (!SETTINGS.TX_INDEX_SPREADSHEET_ID) throw new LogCapacityError('LOG_CAPACITY_EXCEEDED', 'TX_INDEX_SPREADSHEET_ID is not configured');
  return SpreadsheetApp.openById(SETTINGS.TX_INDEX_SPREADSHEET_ID);
}

function txLogFromRecord_(record) {
  var v = record.values;
  return {fullTxId: String(v[0]), displayTxId: String(v[1]), runId: String(v[2]), customerId: String(v[3]), fileId: String(v[4]),
    sourceSheetName: v[5] || null, sourceRow: Number(v[6]), generation: Number(v[7]), formatId: String(v[8]), transactionStatus: String(v[9]),
    plannedFinalStatus: String(v[10]), partnerResolutionStatus: String(v[11]), freeeStatus: String(v[12]), batchId: v[13] || null,
    originalDate: v[14], originalMerchant: v[15], originalAmount: v[16], originalPurpose: v[17],
    planned: {b: v[18], f: v[19], i: v[20], k: v[21], m: v[22],
      g: v[45] === '' || v[45] === undefined ? undefined : v[45]},
    verified: {b: v[23], f: v[24], i: v[25], k: v[26], m: v[27],
      g: v[46] === '' || v[46] === undefined ? undefined : v[46]},
    destinationSpreadsheetId: v[28], destinationSheetName: v[29], destinationRow: v[30], currency: v[31], amountOriginal: v[32], exchangeRate: v[33],
    dateInferenceSource: v[34], dateInferenceBase: v[35], purposeInferred: toBool(v[36]), purposeRuleId: v[37], identityHash: v[38],
    transactionIdVersion: String(v[39]), hashVersion: String(v[40]), active: toBool(v[41]), invalidationReason: v[42],
    registeredAt: v[43], updatedAt: v[44], _rowNumber: record.rowNumber, _values: v};
}

function activeTransactionRecords_(fullTxId) {
  return findRowsByColumnValue_(transactionLogSheet_(), 1, fullTxId, TRANSACTION_LOG_WIDTH_).map(txLogFromRecord_).filter(function(row) { return row.active; });
}

function getTransaction(fullTxId) {
  var matches = activeTransactionRecords_(fullTxId);
  if (matches.length > 1) throw new IntegrityError('TRANSACTION_LOG_AMBIGUOUS', 'More than one active transaction row');
  return matches.length ? matches[0] : null;
}

function getTransactionsByStatus(fileId, statuses) {
  var wanted = statuses.map(String);
  return findRowsByColumnValue_(transactionLogSheet_(), 5, fileId, TRANSACTION_LOG_WIDTH_).map(txLogFromRecord_).filter(function(row) {
    return row.active && wanted.indexOf(row.transactionStatus) >= 0;
  });
}

function txInput_(tx, names, fallback) { return valueOr_(tx, names, fallback); }

function makeTransactionRow_(tx, runId, now) {
  var id = String(txInput_(tx, ['fullTxId', 'transactionId', 'txId'], ''));
  if (!id) throw new TypeError('Transaction ID is required');
  var planned = tx.planned || {};
  var finalStatus = String(txInput_(tx, ['plannedFinalStatus', 'expectedFinalStatus'], tx.reviewRequired ? TX_STATUS.REVIEW_REQUIRED : TX_STATUS.COMMITTED));
  var row = Array(TRANSACTION_LOG_WIDTH_).fill('');
  row[0] = id; row[1] = String(txInput_(tx, ['displayTxId'], id.slice(0, SETTINGS.DISPLAY_ID_LENGTH)));
  row[2] = String(runId); row[3] = String(tx.customerId); row[4] = String(tx.fileId); row[5] = txInput_(tx, ['sourceSheetName', 'sheetName'], '');
  row[6] = Number(txInput_(tx, ['sourceRow', 'sourceRowNumber', 'startPhysicalRow'], 0)); row[7] = Number(txInput_(tx, ['generation', 'reimportGeneration'], 0));
  row[8] = String(txInput_(tx, ['formatId', 'cardFormatId'], '')); row[9] = TX_STATUS.PREPARED; row[10] = finalStatus;
  row[11] = String(txInput_(tx, ['partnerResolutionStatus'], PARTNER_STATUS.UNRESOLVED)); row[12] = String(txInput_(tx, ['freeeStatus'], FREEE_IMPORT_STATUS.NOT_IMPORTED));
  row[13] = txInput_(tx, ['batchId'], ''); row[14] = txInput_(tx, ['originalDate', 'dateHashKey'], '');
  row[15] = txInput_(tx, ['originalMerchant', 'merchantOriginal'], ''); row[16] = txInput_(tx, ['originalAmount', 'amountBillingJpy'], '');
  row[17] = txInput_(tx, ['originalPurpose', 'purposeOriginal', 'purpose'], '');
  row[18] = txInput_(planned, ['b', 'B'], txInput_(tx, ['plannedB'], '')); row[19] = txInput_(planned, ['f', 'F'], txInput_(tx, ['plannedF'], ''));
  row[20] = txInput_(planned, ['i', 'I'], txInput_(tx, ['plannedI'], '')); row[21] = txInput_(planned, ['k', 'K'], txInput_(tx, ['plannedK'], row[15]));
  row[22] = txInput_(planned, ['m', 'M'], txInput_(tx, ['plannedM'], row[16]));
  row[45] = planned.g === undefined || planned.g === null ? '' : planned.g;
  row[28] = txInput_(tx, ['destinationSpreadsheetId'], ''); row[29] = txInput_(tx, ['destinationSheetName'], ''); row[30] = txInput_(tx, ['destinationRow'], '');
  row[31] = txInput_(tx, ['currency', 'currencyCode'], ''); row[32] = txInput_(tx, ['amountOriginal'], ''); row[33] = txInput_(tx, ['exchangeRate'], '');
  row[34] = txInput_(tx, ['dateInferenceSource'], ''); row[35] = txInput_(tx, ['dateInferenceBase'], '');
  row[36] = Boolean(txInput_(tx, ['purposeInferred'], false)); row[37] = txInput_(tx, ['purposeRuleId', 'purposeInferenceRuleId'], '');
  row[38] = txInput_(tx, ['identityHash', 'transactionIdentityHash'], ''); row[39] = txInput_(tx, ['transactionIdVersion'], VERSIONS.TRANSACTION_ID);
  row[40] = txInput_(tx, ['hashVersion'], VERSIONS.HASH); row[41] = true; row[43] = now; row[44] = now;
  return row;
}

function getTxIndexSheet(customerId, year, createIfMissing) {
  // シート名として安全な文字だけを許す。`C`で始まることを強制しない ──
  // 顧客IDの命名規則ではないので、`C`以外で始まる顧客を1件登録した瞬間に
  // その顧客は取引を1件も登録できなくなる。
  if (!/^[0-9A-Za-z_-]+$/.test(String(customerId))|| !Number.isInteger(Number(year))) throw new TypeError('Invalid TX index partition');
  var spreadsheet = txIndexSpreadsheet_(); var name = CONFIG.TX_INDEX_SHEET_PREFIX + customerId + '_' + year;
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet && createIfMissing) {
    sheet = spreadsheet.insertSheet(name);
    sheet.getRange(1, 1, 1, TX_INDEX_WIDTH_).setValues([['取引ID完全値','顧客ID','ファイルID','出現順','取引同一性ハッシュ','明細内容ハッシュ','hashVersion','freee取込状態','有効','登録日時','最終更新日時']]);
  }
  return sheet;
}

function registerPrepared(txs, runId) {
  if (!Array.isArray(txs)) throw new TypeError('txs must be an array');
  return withScriptLock_(function() {
    var logSheet = transactionLogSheet_();
    var ids = txs.map(function(tx) {
      return String(txInput_(tx, ['fullTxId', 'transactionId', 'txId'], ''));
    });
    // 既存行の照会は1回にまとめる。取引ごとに引くと、取引ログのキー列の
    // 全読みが件数ぶん走る（`settleWrittenTransactions`と同じ理由）。
    var existingById = activeTransactionRecordsByIds_(ids);
    var appends = [];

    txs.forEach(function(tx, position) {
      var id = ids[position];
      var existing = existingById[id] ? [existingById[id]] : [];

      // 再合流時の取引再登録（6.1 step 8-13・A-28）。
      // 再合流は「まだ確定していない取引だけを更新し、確定済みの取引には触れない」。
      if (existing.length) {
        var current = existing[0];
        var status = current.transactionStatus;

        // COMMITTED：更新も再登録もしない。再解析の結果で確定済みを覆さない。
        // CANCELED / DELETED_ACCEPTED：終端状態。再合流で復活させない。
        // 再取込が必要なら6.4の取消し（選択肢A）でsupersedeしてからDISCOVEREDへ戻す。
        if (status === TX_STATUS.COMMITTED || status === TX_STATUS.CANCELED ||
            status === TX_STATUS.DELETED_ACCEPTED) {
          return;
        }

        // PREPARED / WRITING / REVIEW_REQUIRED：既存行を更新する。
        // 元値・予定値・K列を今回の解析結果で上書きし、状態は据え置く
        // （比較更新の対象外）。新しい行を追加しない。
        // REVIEW_REQUIRED の場合、当該取引の OPEN／IN_PROGRESS の要確認は維持する
        // （再検査で解消するとは限らないため）。
        var updatedRow = makeTransactionRow_(tx, runId, current.registeredAt || nowIso_());
        updatedRow[9] = status;                       // 状態は据え置く
        updatedRow[43] = current.registeredAt;        // 登録日時は初回の値を保つ
        updatedRow[44] = nowIso_();
        logSheet.getRange(current._rowNumber, 1, 1, TRANSACTION_LOG_WIDTH_)
          .setValues([updatedRow]);
        return;
      }

      var now = nowIso_(); var row = makeTransactionRow_(tx, runId, now);
      var year = Number(now.slice(0, 4)); var indexSheet = getTxIndexSheet(row[3], year, true);
      var indexRow = [row[0], row[3], row[4], Number(txInput_(tx, ['occurrenceIndex', 'appearanceOrder'], 0)), row[38],
        txInput_(tx, ['contentHash', 'submittedContentHash'], ''), row[40], row[12], true, now, now];
      appends.push({row: row, indexSheet: indexSheet, indexRow: indexRow});
    });

    appendRowsBatched_(logSheet, appends.map(function(a) { return a.row; }),
      TRANSACTION_LOG_WIDTH_);
    // 恒久取引インデックスは顧客×年で分かれる。シートごとにまとめる。
    var byIndexSheet = [];
    appends.forEach(function(append) {
      var bucket = byIndexSheet.filter(function(item) { return item.sheet === append.indexSheet; })[0];
      if (!bucket) { bucket = {sheet: append.indexSheet, rows: []}; byIndexSheet.push(bucket); }
      bucket.rows.push(append.indexRow);
    });
    byIndexSheet.forEach(function(bucket) {
      appendRowsBatched_(bucket.sheet, bucket.rows, TX_INDEX_WIDTH_);
    });
  });
}

/**
 * 複数行を1回の`batchUpdate`で追記する。
 *
 * `appendRow`を行数ぶん呼ぶと書込の往復が行数に比例する。追記先の行番号は
 * `apiLastDataRow_`で決める ── `getLastRow()`はSpreadsheetAppのキャッシュ
 * 越しで、Sheets APIで足したばかりの行を数え落とす。
 */
function appendRowsBatched_(sheet, rows, width) {
  if (!rows || !rows.length) return;
  var startRow = apiLastDataRow_(sheet, width) + 1;
  ensureRowExists_(sheet, startRow + rows.length - 1);
  var values = rows.map(function(row) { return padRowValues_(row, width); });
  Sheets.Spreadsheets.Values.batchUpdate({valueInputOption: 'RAW', data: [{
    range: quoteSheetName_(sheet.getName()) + '!A' + startRow + ':' +
      columnLetter_(width) + (startRow + rows.length - 1),
    values: values
  }]}, sheet.getParent().getId());
}

/**
 * 取引先解決状態（L列）を更新する。
 *
 * 取引状態（J列）とは別の軸である。`EXCLUDE`のような操作は取引を終端へ
 * 送るが解決状態は変えない ── だからこそINV-17の条件2は`COMMITTED`に
 * 限定される（CR-I）。
 */
function updatePartnerResolution(fullTxId, status) {
  if (!PARTNER_STATUS[String(status)]) {
    throw new TypeError('Unsupported partner resolution status: ' + status);
  }
  return withScriptLock_(function() {
    var row = getTransaction(fullTxId);
    if (!row) throw new IntegrityError(null, 'Transaction not found: ' + fullTxId);
    transactionLogSheet_().getRange(row._rowNumber, 12).setValue(String(status));
    transactionLogSheet_().getRange(row._rowNumber, 45).setValue(nowIso_());
  });
}

function updateTransactionStatus(fullTxId, fromStatus, toStatus) {
  var allowed = ALLOWED_TX_TRANSITIONS[String(fromStatus)] || [];
  if (allowed.indexOf(toStatus) < 0) throw new StateTransitionError('Transaction transition is not allowed');
  return withScriptLock_(function() {
    var row = getTransaction(fullTxId);
    if (!row || row.transactionStatus !== String(fromStatus)) throw new StateTransitionError('Transaction compare-and-set failed');
    transactionLogSheet_().getRange(row._rowNumber, 10).setValue(toStatus);
    transactionLogSheet_().getRange(row._rowNumber, 45).setValue(nowIso_());
  });
}

/** 相手税区分のセル値。持たない取引は空欄で残す。 */
function taxCategoryCell_(object) {
  var value = object && object.g;
  return value === undefined || value === null ? '' : value;
}

function plannedVerifiedArray_(object) {
  object = object || {};
  return [valueOr_(object, ['b', 'B'], ''), valueOr_(object, ['f', 'F'], ''), valueOr_(object, ['i', 'I'], ''),
    valueOr_(object, ['k', 'K'], ''), valueOr_(object, ['m', 'M'], '')];
}

function updateWrittenValues(fullTxId, planned, verified) {
  return withScriptLock_(function() {
    var row = getTransaction(fullTxId); if (!row) throw new IntegrityError(null, 'Transaction not found');
    transactionLogSheet_().getRange(row._rowNumber, 19, 1, 10).setValues([[].concat(plannedVerifiedArray_(planned), plannedVerifiedArray_(verified))]);
    transactionLogSheet_().getRange(row._rowNumber, 45).setValue(nowIso_());
    transactionLogSheet_().getRange(row._rowNumber, 46, 1, 2)
      .setValues([[taxCategoryCell_(planned), taxCategoryCell_(verified)]]);
  });
}

/** 取引IDの集合に対する有効行を、キー列1回＋一致行1回の読取で引く。 */
function activeTransactionRecordsByIds_(fullTxIds) {
  var found = findRowsByColumnValues_(transactionLogSheet_(), 1, fullTxIds, TRANSACTION_LOG_WIDTH_);
  var records = Object.create(null);
  Object.keys(found).forEach(function(id) {
    var active = found[id].map(txLogFromRecord_).filter(function(row) { return row.active; });
    if (active.length > 1) {
      throw new IntegrityError('TRANSACTION_LOG_AMBIGUOUS', 'More than one active transaction row');
    }
    if (active.length) records[id] = active[0];
  });
  return records;
}

/**
 * 読取確認を通った取引をまとめて確定させる（6.1 9-7）。
 *
 * `updateWrittenValues` → `updateTransactionLocation` →
 * `updateTransactionStatus` を取引ごとに呼ぶと、**取引ログのキー列の全読みが
 * 1取引につき3回**走る。実機では1件あたり約20秒かかり、7〜8件のファイルで
 * 6分の実行上限に当たった（2026-09-03）。読取をまとめ、書込を1回の
 * `batchUpdate`にまとめて、1ファイルあたりの往復を件数に依らない定数にする。
 *
 * **先に全件を検査してから書く。** 1件ずつ書きながら進むと、途中で状態遷移が
 * 弾かれたときに「一部だけ確定済み」が残り、どこまで進んだかを呼出側が
 * 知る手段がない。
 *
 * @param {!Array<{fullTxId:string, planned:!Object, verified:!Object,
 *   destinationRow:number, fromStatus:string, toStatus:string}>} entries
 */
function settleWrittenTransactions(entries) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  if (!entries.length) return [];
  return withScriptLock_(function() {
    var sheet = transactionLogSheet_();
    var records = activeTransactionRecordsByIds_(entries.map(function(entry) {
      return entry.fullTxId;
    }));

    var updates = entries.map(function(entry) {
      var record = records[String(entry.fullTxId)];
      if (!record) throw new IntegrityError(null, 'Transaction not found: ' + entry.fullTxId);
      var allowed = ALLOWED_TX_TRANSITIONS[String(entry.fromStatus)] || [];
      if (allowed.indexOf(entry.toStatus) < 0) {
        throw new StateTransitionError('Transaction transition is not allowed');
      }
      if (record.transactionStatus !== String(entry.fromStatus)) {
        throw new StateTransitionError('Transaction compare-and-set failed');
      }
      return {rowNumber: record._rowNumber, entry: entry};
    });

    var name = sheet.getName();
    var now = nowIso_();
    var data = [];
    updates.forEach(function(update) {
      var entry = update.entry;
      // 自分が持つ列だけを書く。行全体を書き戻すと、読んだ時点の値で
      // 他の列を巻き戻す（処理ログで実際に起きた事故と同じ形）。
      data.push({range: a1Range_(name, update.rowNumber, 10, 10), values: [[entry.toStatus]]});
      data.push({range: a1Range_(name, update.rowNumber, 19, 28), values: [
        [].concat(plannedVerifiedArray_(entry.planned), plannedVerifiedArray_(entry.verified))
      ]});
      data.push({range: a1Range_(name, update.rowNumber, 31, 31), values: [[entry.destinationRow]]});
      data.push({range: a1Range_(name, update.rowNumber, 45, 45), values: [[now]]});
      data.push({range: a1Range_(name, update.rowNumber, 46, 47), values: [
        [taxCategoryCell_(entry.planned), taxCategoryCell_(entry.verified)]]});
    });
    for (var start = 0; start < data.length; start += SETTLE_BATCH_RANGES_) {
      Sheets.Spreadsheets.Values.batchUpdate(
        {valueInputOption: 'RAW', data: data.slice(start, start + SETTLE_BATCH_RANGES_)},
        masterSpreadsheet_().getId());
    }
    return updates.map(function(update) {
      return {fullTxId: update.entry.fullTxId, rowNumber: update.rowNumber};
    });
  });
}

/** 1回のbatchUpdateへ載せる範囲の上限。1取引あたり4範囲を使う。 */
var SETTLE_BATCH_RANGES_ = 400;

function findTxIndexRecord_(tx) {
  var year = Number(String(tx.registeredAt).slice(0, 4)); var sheet = getTxIndexSheet(tx.customerId, year, false);
  if (!sheet) throw new IntegrityError(null, 'Permanent transaction index partition not found');
  var matches = findRowsByColumnValue_(sheet, 1, tx.fullTxId, TX_INDEX_WIDTH_);
  if (matches.length !== 1) throw new IntegrityError('TRANSACTION_LOG_AMBIGUOUS', 'Permanent transaction index row is not unique');
  return {sheet: sheet, rowNumber: matches[0].rowNumber, values: matches[0].values};
}

function updateFreeeStatus(fullTxId, fromStatus, toStatus, batchId) {
  var allowed = ALLOWED_FREEE_TRANSITIONS[String(fromStatus)] || [];
  if (allowed.indexOf(toStatus) < 0) throw new StateTransitionError('freee transition is not allowed');
  return withScriptLock_(function() {
    var tx = getTransaction(fullTxId);
    if (!tx || tx.freeeStatus !== String(fromStatus)) throw new StateTransitionError('freee compare-and-set failed');
    var index = findTxIndexRecord_(tx); var now = nowIso_();
    transactionLogSheet_().getRange(tx._rowNumber, 13, 1, 2).setValues([[toStatus, batchId || '']]);
    transactionLogSheet_().getRange(tx._rowNumber, 45).setValue(now);
    index.sheet.getRange(index.rowNumber, 8).setValue(toStatus); index.sheet.getRange(index.rowNumber, 11).setValue(now);
  });
}

function supersede(fullTxId, reason, actor) {
  return withScriptLock_(function() {
    var tx = getTransaction(fullTxId); if (!tx) return;
    var index = findTxIndexRecord_(tx); var now = nowIso_();
    transactionLogSheet_().getRange(tx._rowNumber, 42, 1, 2).setValues([[false, reason || 'SUPERSEDED']]);
    transactionLogSheet_().getRange(tx._rowNumber, 45).setValue(now);
    index.sheet.getRange(index.rowNumber, 9).setValue(false); index.sheet.getRange(index.rowNumber, 11).setValue(now);
    appendAuditUnlocked_({type: 'CANCEL', actor: actor, targetType: 'TRANSACTION', targetId: fullTxId,
      customerId: tx.customerId, before: {AP: true}, after: {AP: false}, reason: reason || ''}, false);
  });
}

function validateRequiredFields(row) {
  var values = Array.isArray(row) ? row : row && row._values;
  var named = row || {}; var required = [
    ['J', values ? values[9] : named.transactionStatus], ['K', values ? values[10] : named.plannedFinalStatus],
    ['L', values ? values[11] : named.partnerResolutionStatus], ['M', values ? values[12] : named.freeeStatus],
    ['AN', values ? values[39] : named.transactionIdVersion], ['AO', values ? values[40] : named.hashVersion],
    ['AP', values ? values[41] : named.active]
  ];
  var missing = required.filter(function(item) { return item[1] === '' || item[1] === null || item[1] === undefined; }).map(function(item) { return item[0]; });
  if (!missing.length) { try { toBool(required[6][1]); } catch (error) { missing.push('AP'); } }
  return {ok: missing.length === 0, missing: missing};
}

function queryTxIndex(customerId, filter) {
  filter = filter || {}; var years = [];
  var today = nowIso_().slice(0, 10); var todayParts = today.split('-').map(Number);
  var currentYear = todayParts[0];
  var cutoffOrdinal = monthOrdinal(todayParts[0], todayParts[1]) - SETTINGS.TX_INDEX_LOOKBACK_MONTHS;
  var cutoffYear = Math.floor(cutoffOrdinal / 12); var cutoffMonth = cutoffOrdinal - cutoffYear * 12 + 1;
  var cutoffDay = Math.min(todayParts[2], new Date(Date.UTC(cutoffYear, cutoffMonth, 0)).getUTCDate());
  var lookbackCutoff = [String(cutoffYear).padStart(4, '0'), String(cutoffMonth).padStart(2, '0'), String(cutoffDay).padStart(2, '0')].join('-');
  if (Array.isArray(filter.years) && filter.years.length) years = filter.years.map(Number);
  else if (filter.from && filter.to) {
    var first = Number(String(filter.from).slice(0, 4)); var last = Number(String(filter.to).slice(0, 4));
    for (var year = first; year <= last; year += 1) years.push(year);
  } else if (filter.purpose === 'FREEE_PENDING') {
    years = [currentYear - 1, currentYear];
  } else throw new InputLimitError('queryTxIndex requires an explicit bounded year range');
  var firstAllowedYear = filter.purpose === 'FREEE_PENDING' ? currentYear - 1 : cutoffYear;
  years = years.filter(function(year) { return year >= firstAllowedYear && year <= currentYear; })
    .filter(function(year, index, all) { return all.indexOf(year) === index; });
  if (years.length > Math.ceil(SETTINGS.TX_INDEX_LOOKBACK_MONTHS / 12) + 1) throw new InputLimitError('TX index year range is too wide');
  var result = [];
  years.forEach(function(year) {
    var sheet = getTxIndexSheet(customerId, year, false); if (!sheet) return;
    readSheetRows_(sheet, TX_INDEX_WIDTH_).forEach(function(record) {
      var v = record.values; if (String(v[1]) !== String(customerId)) return;
      var item = {fullTxId: String(v[0]), customerId: String(v[1]), fileId: String(v[2]), occurrenceIndex: Number(v[3]),
        identityHash: v[4], contentHash: v[5], hashVersion: String(v[6]), freeeStatus: String(v[7]), active: toBool(v[8]),
        registeredAt: v[9], updatedAt: v[10]};
      if (filter.from && String(item.registeredAt) < String(filter.from)) return;
      if (filter.to && String(item.registeredAt) > String(filter.to)) return;
      if (filter.purpose !== 'FREEE_PENDING' && String(item.registeredAt).slice(0, 10) < lookbackCutoff) return;
      if (filter.active !== undefined && item.active !== Boolean(filter.active)) return;
      if (filter.purpose === 'FREEE_PENDING' && (!item.active || item.freeeStatus === FREEE_IMPORT_STATUS.IMPORTED)) return;
      result.push(item);
    });
  });
  return result;
}

function measureTxIndexCapacity() {
  var spreadsheet = txIndexSpreadsheet_();
  var cells = spreadsheet.getSheets().reduce(function(sum, sheet) { return sum + sheet.getMaxRows() * sheet.getMaxColumns(); }, 0);
  var limit = SETTINGS.SPREADSHEET_CELL_LIMIT;
  return {cells: cells, limit: limit, percent: limit ? cells / limit * 100 : 0};
}

'use strict';

const PROCESS_LOG_WIDTH_ = 40;
const FILE_INDEX_WIDTH_ = 13;

const PROCESS_FIELD_COLUMNS_ = Object.freeze({
  runId: 1, startedAt: 2, endedAt: 3, startedBy: 4, triggerAccount: 5,
  customerId: 6, customerName: 7, fileId: 8, originalFileName: 9,
  fileUpdatedAt: 10, fileRevision: 11, binaryHash: 12, submittedContentHash: 13,
  currentContentHash: 14, formatId: 15, sourceSheetName: 16, internalState: 17,
  readCount: 18, autoCount: 19, reviewCount: 20, excludedCount: 21, errorCount: 22,
  errors: 23, codeVersion: 24, formatVersion: 25, dictionaryVersion: 26,
  hashVersion: 27, sheetSchemaVersion: 28, leaseId: 29, lastHeartbeat: 30,
  expectedPrefix: 31, renameState: 32, renameRetryCount: 33, billingYearMonth: 34,
  billingEvidence: 35, fileLevelDateBlanked: 36, category2Approvals: 37,
  category2Approver: 38, category2ApprovedAt: 39, emptyFileConfirmed: 40
});

function processLogSheet_() { return requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.PROCESS_LOG); }
function permanentFileIndexSheet_() { return requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.PERMANENT_FILE_INDEX); }

function getProcessLogRecord_(fileId) {
  var matches = findRowsByColumnValue_(processLogSheet_(), 8, fileId, PROCESS_LOG_WIDTH_);
  if (matches.length > 1) throw new IntegrityError('TRANSACTION_LOG_AMBIGUOUS', 'Duplicate process log fileId');
  return matches.length ? {rowNumber: matches[0].rowNumber, values: matches[0].values} : null;
}

function getPermanentFileIndexRecord_(fileId) {
  var matches = findRowsByColumnValue_(permanentFileIndexSheet_(), 1, fileId, FILE_INDEX_WIDTH_);
  if (matches.length > 1) throw new IntegrityError('TRANSACTION_LOG_AMBIGUOUS', 'Duplicate permanent file index fileId');
  return matches.length ? {rowNumber: matches[0].rowNumber, values: matches[0].values} : null;
}

function fileProperty_(file, names, fallback) {
  for (var index = 0; index < names.length; index += 1) {
    var name = names[index];
    if (file && typeof file[name] === 'function') return file[name]();
    if (file && file[name] !== undefined) return file[name];
  }
  return fallback;
}

function createOrUpdateProcessLog(runId, customer, file) {
  var fileId = String(fileProperty_(file, ['getId', 'fileId', 'id'], ''));
  if (!fileId) throw new TypeError('fileId is required');
  return withScriptLock_(function() {
    var processSheet = processLogSheet_();
    var indexSheet = permanentFileIndexSheet_();
    var process = getProcessLogRecord_(fileId);
    var permanent = getPermanentFileIndexRecord_(fileId);
    var now = nowIso_();
    var originalName = String(fileProperty_(file, ['originalFileName', 'getName', 'name'], ''));
    var binaryHash = String(fileProperty_(file, ['binaryHash', 'fileBinaryHash'], ''));
    var hashVersion = String(fileProperty_(file, ['hashVersion'], VERSIONS.HASH));
    var state = String(fileProperty_(file, ['internalState', 'state'], FILE_STATE.DISCOVERED));
    var processRow = process ? process.values.slice() : Array(PROCESS_LOG_WIDTH_).fill('');
    processRow[0] = String(runId); processRow[1] = now; processRow[3] = activeUserEmail_();
    processRow[5] = customer.customerId; processRow[6] = customer.customerName; processRow[7] = fileId;
    if (!process) processRow[8] = originalName;
    processRow[9] = fileProperty_(file, ['updatedAt', 'getLastUpdated'], processRow[9] || '');
    processRow[10] = fileProperty_(file, ['revision'], processRow[10] || '');
    processRow[11] = binaryHash || processRow[11];
    if (!processRow[12]) processRow[12] = fileProperty_(file, ['contentHash', 'submittedContentHash'], '');
    processRow[16] = state; processRow[26] = hashVersion; processRow[30] = STATE_TO_PREFIX[state];
    processRow[31] = processRow[31] || RENAME_STATE.OK; processRow[32] = Number(processRow[32] || 0);
    processRow[35] = processRow[35] === '' ? false : toBool(processRow[35]);
    processRow[39] = processRow[39] === '' ? false : toBool(processRow[39]);

    var indexRow = permanent ? permanent.values.slice() : Array(FILE_INDEX_WIDTH_).fill('');
    indexRow[0] = fileId; indexRow[1] = customer.customerId;
    if (!permanent) indexRow[2] = originalName;
    indexRow[3] = state; indexRow[4] = binaryHash || indexRow[4];
    if (!indexRow[5]) indexRow[5] = processRow[12];
    indexRow[6] = hashVersion; indexRow[7] = processRow[10]; indexRow[8] = processRow[9]; indexRow[9] = String(runId);
    if (!permanent) indexRow[10] = now;
    indexRow[11] = now;

    // 追記行はSheets APIの読取で数える。getLastRow()はSheets APIで足した
    // 行を数え落とし、2ファイル目が1ファイル目の行を上書きし得る。
    var processRowNumber = process ? process.rowNumber : apiLastDataRow_(processSheet, PROCESS_LOG_WIDTH_) + 1;
    var indexRowNumber = permanent ? permanent.rowNumber : apiLastDataRow_(indexSheet, FILE_INDEX_WIDTH_) + 1;
    ensureRowExists_(processSheet, processRowNumber); ensureRowExists_(indexSheet, indexRowNumber);
    Sheets.Spreadsheets.Values.batchUpdate({valueInputOption: 'RAW', data: [
      {range: a1Range_(processSheet.getName(), processRowNumber, 1, PROCESS_LOG_WIDTH_), values: [processRow]},
      {range: a1Range_(indexSheet.getName(), indexRowNumber, 1, FILE_INDEX_WIDTH_), values: [indexRow]}
    ]}, masterSpreadsheet_().getId());
  });
}

/**
 * **指名された列だけを書く。** 以前は行全体を読んで全40列を書き戻して
 * いたが、SpreadsheetApp の読取キャッシュは Sheets API の直前の書込を
 * 反映しないことがあり（4.23 flush規則2）、**古い読取値で無関係な列を
 * 巻き戻す**（実機で処理ログの内部状態だけが古い値へ戻り、恒久ファイル
 * インデックスと食い違って`PERMANENT_INDEX_DESYNC`になった）。
 * 列単位の書込なら、読取が古くても壊れるのは書こうとした列だけである。
 */
function updateProcessLogUnlocked_(fileId, fields) {
    var record = getProcessLogRecord_(fileId);
    if (!record) throw makeCatalogError_('REQUIRED_LOG_WRITE_FAILED', 'Process log not found: ' + fileId);
    var sheetName = processLogSheet_().getName();
    var data = [];
    Object.keys(fields || {}).forEach(function(name) {
      var column = PROCESS_FIELD_COLUMNS_[name];
      if (!column) throw new TypeError('Unknown process log field: ' + name);
      if (name === 'submittedContentHash' && record.values[column - 1] &&
          record.values[column - 1] !== fields[name]) {
        throw new IntegrityError(null, 'Submitted content hash is immutable');
      }
      data.push({range: a1Range_(sheetName, record.rowNumber, column, column),
        values: [[fields[name]]]});
    });
    if (fields.internalState !== undefined) {
      var permanent = getPermanentFileIndexRecord_(fileId);
      if (!permanent) throw makeCatalogError_('REQUIRED_LOG_WRITE_FAILED', 'Permanent file index not found: ' + fileId);
      var indexName = permanentFileIndexSheet_().getName();
      data.push({range: a1Range_(indexName, permanent.rowNumber, 4, 4), values: [[fields.internalState]]});
      data.push({range: a1Range_(indexName, permanent.rowNumber, 12, 12), values: [[nowIso_()]]});
    }
    if (!data.length) return;
    Sheets.Spreadsheets.Values.batchUpdate({valueInputOption: 'RAW', data: data}, masterSpreadsheet_().getId());
}

/**
 * 恒久ファイルインデックスF列（明細内容ハッシュ・提出時点で不変）を書く。
 * 行全体を書き戻さない（上記と同じ理由）。
 */
function syncPermanentContentHash(fileId, contentHash) {
  return withScriptLock_(function() {
    var permanent = getPermanentFileIndexRecord_(fileId);
    if (!permanent) throw makeCatalogError_('REQUIRED_LOG_WRITE_FAILED', 'Permanent file index not found: ' + fileId);
    var current = String(permanent.values[5] || '');
    if (current !== '' && current !== String(contentHash)) {
      throw new IntegrityError(null, 'Submitted content hash is immutable (INV-07)');
    }
    var indexName = permanentFileIndexSheet_().getName();
    Sheets.Spreadsheets.Values.batchUpdate({valueInputOption: 'RAW', data: [
      {range: a1Range_(indexName, permanent.rowNumber, 6, 6), values: [[String(contentHash)]]},
      {range: a1Range_(indexName, permanent.rowNumber, 12, 12), values: [[nowIso_()]]}
    ]}, masterSpreadsheet_().getId());
  });
}

function updateProcessLog(fileId, fields) {
  return withScriptLock_(function() { return updateProcessLogUnlocked_(fileId, fields); });
}

function recordVersions(fileId, versions) {
  updateProcessLog(fileId, {codeVersion: versions.codeVersion || versions.code, formatVersion: versions.formatVersion || versions.format,
    dictionaryVersion: versions.dictionaryVersion || versions.dictionary, hashVersion: versions.hashVersion || versions.hash,
    sheetSchemaVersion: versions.sheetSchemaVersion || versions.sheetSchema});
}

function recordError(fileId, errorRecord) {
  return withScriptLock_(function() {
    var record = getProcessLogRecord_(fileId);
    if (!record) throw makeCatalogError_('REQUIRED_LOG_WRITE_FAILED', 'Process log not found');
    var current = jsonCell_(record.values[22], []);
    if (!Array.isArray(current)) current = [];
    var marker = current.length && current[0] && current[0].truncated ? current.shift() : null;
    current.push(errorRecord);
    var dropped = marker ? Number(marker.droppedCount || 0) : 0;
    var firstDroppedAt = marker ? marker.firstDroppedAt : null;
    while (current.length > SETTINGS.MAX_ERROR_RECORDS_PER_FILE - (dropped > 0 ? 1 : 0)) {
      var removed = current.shift(); dropped += 1; firstDroppedAt = firstDroppedAt || removed.occurredAt || nowIso_();
    }
    if (dropped) current.unshift({truncated: true, droppedCount: dropped, firstDroppedAt: firstDroppedAt});
    updateProcessLogUnlocked_(fileId, {errors: JSON.stringify(current), errorCount: current.filter(function(item) { return !item.truncated; }).length});
  });
}

function appendCategory2Approval(fileId, approval) {
  return withScriptLock_(function() {
    var record = getProcessLogRecord_(fileId);
    if (!record) throw makeCatalogError_('REQUIRED_LOG_WRITE_FAILED', 'Process log not found');
    var approvals = jsonCell_(record.values[36], []);
    if (!Array.isArray(approvals)) approvals = [];
    approvals.push(approval);
    updateProcessLogUnlocked_(fileId, {category2Approvals: JSON.stringify(approvals), category2Approver: approval.approvedBy, category2ApprovedAt: approval.approvedAt});
  });
}

/** AK列に保存された区分2解決承認を読む（2.1.8.2）。 */
function getCategory2Approvals(fileId) {
  var record = getProcessLogRecord_(fileId);
  if (!record) return [];
  var approvals = jsonCell_(record.values[PROCESS_FIELD_COLUMNS_.category2Approvals - 1], []);
  return Array.isArray(approvals) ? approvals : [];
}

/**
 * 当該要因が承認済みか。
 *
 * 判定規則は`validationCauseApproved_`に集約する。ここで条件を書き直すと、
 * 保存した承認を読出側が認識しない状態が再び作れてしまう（INV-28）。
 */
function hasCategory2Approval(fileId, code, contentHash, hashVersion) {
  return validationCauseApproved_({
    validationApprovals: getCategory2Approvals(fileId),
    contentHash: contentHash, hashVersion: hashVersion
  }, code);
}

/**
 * 恒久ファイルインデックスM列（対象シート名）を保存する。
 *
 * 複数シートのXLSXで、どのシートを明細とみなすかを人が選んだ結果である。
 * ここへ保存しないと、再検査のたびに同じ選択を求められる（M19・INV-31）。
 */
function setPermanentIndexTargetSheet(fileId, sheetName) {
  return withScriptLock_(function() {
    var record = getPermanentFileIndexRecord_(fileId);
    if (!record) {
      throw new IntegrityError(null, 'Permanent file index row not found: ' + fileId);
    }
    permanentFileIndexSheet_().getRange(record.rowNumber, 13).setValue(String(sheetName));
  });
}

function setEmptyFileConfirmed(fileId, actor) {
  updateProcessLog(fileId, {emptyFileConfirmed: true});
  appendAudit({type: 'REVIEW_RESOLVE', actor: actor, targetType: 'LOG', targetId: fileId, after: {AN: true}});
}

function getRunCumulativeTransactionCount(runId) {
  return Number(PropertiesService.getScriptProperties().getProperty('RUN_TX_COUNT_' + runId) || 0);
}

function incrementRunTransactionCount(runId, delta) {
  var properties = PropertiesService.getScriptProperties();
  properties.setProperty('RUN_TX_COUNT_' + runId, String(getRunCumulativeTransactionCount(runId) + Number(delta)));
}

/**
 * 実行の終了時にカウンタを片付ける。
 *
 * Script Properties にはキー数と合計サイズの上限がある。実行ごとに1件作って
 * 消さないと、日次実行を続けるうちに溜まり、ある日プロパティ書込が失敗して
 * **実行そのものが止まる**。原因は書込に失敗した処理とは無関係な場所にあり、
 * 追いにくい。
 */
function clearRunTransactionCount(runId) {
  if (!runId) return;
  PropertiesService.getScriptProperties().deleteProperty('RUN_TX_COUNT_' + runId);
}

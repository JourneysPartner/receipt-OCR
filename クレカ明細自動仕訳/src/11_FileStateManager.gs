'use strict';

const ALLOWED_FILE_TRANSITIONS_ = Object.freeze({
  null: Object.freeze([FILE_STATE.DISCOVERED]),
  DISCOVERED: Object.freeze([FILE_STATE.VALIDATING]),
  VALIDATING: Object.freeze([FILE_STATE.WRITING, FILE_STATE.REVIEW_WAIT, FILE_STATE.CUSTOMER_FIX_REQUIRED,
    FILE_STATE.EXCLUDED, FILE_STATE.CANCELED, FILE_STATE.FAILED]),
  WRITING: Object.freeze([FILE_STATE.COMPLETED, FILE_STATE.REVIEW_WAIT, FILE_STATE.EXCLUDED, FILE_STATE.CANCELED, FILE_STATE.FAILED]),
  REVIEW_WAIT: Object.freeze([FILE_STATE.VALIDATING, FILE_STATE.COMPLETED, FILE_STATE.CUSTOMER_FIX_REQUIRED,
    FILE_STATE.EXCLUDED, FILE_STATE.CANCELED, FILE_STATE.FAILED]),
  CUSTOMER_FIX_REQUIRED: Object.freeze([FILE_STATE.VALIDATING, FILE_STATE.EXCLUDED, FILE_STATE.CANCELED]),
  FAILED: Object.freeze([FILE_STATE.VALIDATING, FILE_STATE.CANCELED]),
  COMPLETED: Object.freeze([FILE_STATE.CANCELED]),
  CANCELED: Object.freeze([FILE_STATE.DISCOVERED]),
  EXCLUDED: Object.freeze([FILE_STATE.DISCOVERED])
});

function isAllowedTransition(fromState, toState) {
  var key = fromState === null || fromState === undefined ? 'null' : String(fromState);
  return Boolean(ALLOWED_FILE_TRANSITIONS_[key] && ALLOWED_FILE_TRANSITIONS_[key].indexOf(toState) >= 0);
}

function transitionFileState(fileId, fromState, toState, runId) {
  if (!isAllowedTransition(fromState, toState)) throw new StateTransitionError('File transition is not allowed: ' + fromState + ' -> ' + toState);
  var record = getProcessLogRecord_(fileId);
  if (!record || String(record.values[16]) !== String(fromState)) throw new StateTransitionError('File compare-and-set failed');
  if (runId !== undefined && runId !== null && String(record.values[0]) !== String(runId)) throw new StateTransitionError('Run ID mismatch');
  updateProcessLog(fileId, {internalState: toState, expectedPrefix: STATE_TO_PREFIX[toState]});
  updateFilePrefix(fileId);
  if (toState !== FILE_STATE.VALIDATING && toState !== FILE_STATE.WRITING) releaseLease(fileId, runId, 'STATE_TRANSITION:' + toState);
}

function removableStatePrefixRegex_() {
  var prefixes = Object.keys(STATE_TO_PREFIX).map(function(key) { return STATE_TO_PREFIX[key]; }).filter(Boolean)
    .filter(function(value, index, all) { return all.indexOf(value) === index; })
    .sort(function(a, b) { return b.length - a.length; })
    .map(function(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
  return new RegExp('^(?:' + prefixes.join('|') + ')');
}

function updateFilePrefix(fileId) {
  var process = getProcessLogRecord_(fileId);
  var permanent = getPermanentFileIndexRecord_(fileId);
  if (!process || !permanent) return {ok: false, reason: 'FILE_NOT_REGISTERED'};
  var expected = String(process.values[30] || '');
  var baseName = String(permanent.values[2] || '').replace(removableStatePrefixRegex_(), '');
  try {
    var file = DriveApp.getFileById(fileId);
    var expectedName = expected + baseName;
    if (file.getName() !== expectedName) file.setName(expectedName);
    updateProcessLog(fileId, {renameState: RENAME_STATE.OK, renameRetryCount: Number(process.values[32] || 0)});
    return {ok: true, reason: null};
  } catch (error) {
    var retry = Number(process.values[32] || 0) + 1;
    updateProcessLog(fileId, {renameState: retry >= SETTINGS.MAX_RENAME_RETRIES ? RENAME_STATE.FAILED_MAX_RETRY : RENAME_STATE.PENDING_RETRY,
      renameRetryCount: retry});
    return {ok: false, reason: /not found/i.test(error.message) ? 'FILE_NOT_FOUND' : 'PENDING_RETRY'};
  }
}

function retryPendingRenames(customerId) {
  var sheet = processLogSheet_();
  findRowsByColumnValue_(sheet, 6, customerId, PROCESS_LOG_WIDTH_).forEach(function(record) {
    if (String(record.values[31]) !== RENAME_STATE.PENDING_RETRY || Number(record.values[32] || 0) >= SETTINGS.MAX_RENAME_RETRIES) return;
    try { updateFilePrefix(String(record.values[7])); } catch (ignored) { /* one file must not stop the loop */ }
  });
}

function leaseSheet_() { return requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.PROCESS_LEASE); }

function leaseFromRow_(values, rowNumber) {
  return {leaseId: String(values[0]), customerId: String(values[1]), fileId: String(values[2]), runId: String(values[3]),
    owner: String(values[4]), triggerAccount: values[5] || null, acquiredAt: values[6], lastHeartbeat: values[7],
    state: String(values[8]), purpose: String(values[9]), _rowNumber: rowNumber};
}

function activeLeases_() {
  return readSheetRows_(leaseSheet_(), 10).map(function(row) { return leaseFromRow_(row.values, row.rowNumber); }).filter(function(lease) {
    if (lease.state !== LEASE_STATE.ACTIVE) throw new IntegrityError(null, 'Lease sheet contains a non-ACTIVE row');
    return true;
  });
}

function acquireLease(customerId, fileId, runId, owner, purpose) {
  if (purpose !== LEASE_PURPOSE.PROCESS && purpose !== LEASE_PURPOSE.WRITE_ONLY) throw new TypeError('Invalid lease purpose');
  return withScriptLock_(function() {
    var conflict = activeLeases_().filter(function(lease) { return lease.customerId === customerId && lease.fileId === fileId; })[0];
    if (conflict) throw leaseConflict_('Lease owned by ' + conflict.owner + ' since ' + conflict.acquiredAt);
    var leaseId = generateId('LEASE'); var now = nowIso_();
    leaseSheet_().appendRow([leaseId, customerId, fileId, runId, owner, '', now, now, LEASE_STATE.ACTIVE, purpose]);
    return leaseId;
  });
}

function renewHeartbeat(leaseId) {
  return withScriptLock_(function() {
    var matches = activeLeases_().filter(function(lease) { return lease.leaseId === leaseId; });
    if (matches.length !== 1) throw leaseConflict_('Active lease not found');
    var lease = matches[0]; var process = getProcessLogRecord_(lease.fileId);
    if (!process || [FILE_STATE.VALIDATING, FILE_STATE.WRITING].indexOf(String(process.values[16])) < 0) return;
    var now = nowIso_(); leaseSheet_().getRange(lease._rowNumber, 8).setValue(now);
    processLogSheet_().getRange(process.rowNumber, 30).setValue(now);
  });
}

function releaseLease(fileId, runId, reason) {
  return withScriptLock_(function() {
    var targets = activeLeases_().filter(function(lease) {
      return lease.fileId === String(fileId) && (runId === undefined || runId === null || lease.runId === String(runId));
    });
    if (!targets.length) return;
    targets.forEach(function(lease) {
      appendAuditUnlocked_({type: 'LEASE_RELEASE', actor: lease.owner, targetType: 'LEASE', targetId: lease.leaseId,
        customerId: lease.customerId, before: {state: LEASE_STATE.ACTIVE}, after: {state: null}, reason: reason || ''}, false);
    });
    targets.sort(function(a, b) { return b._rowNumber - a._rowNumber; }).forEach(function(lease) { leaseSheet_().deleteRow(lease._rowNumber); });
  });
}

function verifyActiveLease(leaseId, runId) {
  return activeLeases_().some(function(lease) { return lease.leaseId === leaseId && lease.runId === String(runId); });
}

function assertLeaseHeldForWrite(fileId, leaseId) {
  var matches = activeLeases_().filter(function(lease) { return lease.fileId === String(fileId) && lease.leaseId === String(leaseId); });
  if (matches.length !== 1) throw leaseConflict_('Required write lease is not held');
}

function forceReleaseLease(leaseId, reason, actor) {
  return withScriptLock_(function() {
    var lease = activeLeases_().filter(function(item) { return item.leaseId === String(leaseId); })[0];
    if (!lease) return;
    var process = getProcessLogRecord_(lease.fileId);
    if (!process || [FILE_STATE.VALIDATING, FILE_STATE.WRITING].indexOf(String(process.values[16])) < 0) throw new StateTransitionError('Lease state is not force-releasable');
    var customer = getCustomerById(lease.customerId);
    if (customer.admins.indexOf(String(actor).toLowerCase()) < 0) throw new AuthorizationError('System administrator role is required');
    var elapsed = (Date.now() - new Date(lease.lastHeartbeat).getTime()) / 1000;
    if (!isFinite(elapsed) || elapsed <= SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS) throw new StateTransitionError('Heartbeat has not exceeded the force-release threshold');
    appendAuditUnlocked_({type: 'LEASE_FORCE_RELEASE', actor: actor, targetType: 'LEASE', targetId: lease.leaseId,
      customerId: lease.customerId, before: {state: LEASE_STATE.ACTIVE}, after: {state: null}, reason: reason || ''}, false);
    leaseSheet_().deleteRow(lease._rowNumber);
  });
}

function detectStalledLeases() {
  var now = Date.now();
  return activeLeases_().filter(function(lease) {
    var process = getProcessLogRecord_(lease.fileId);
    var state = process ? String(process.values[16]) : '';
    var elapsed = (now - new Date(lease.lastHeartbeat).getTime()) / 1000;
    return [FILE_STATE.VALIDATING, FILE_STATE.WRITING].indexOf(state) >= 0 && isFinite(elapsed) && elapsed > SETTINGS.HEARTBEAT_TIMEOUT_SECONDS;
  });
}

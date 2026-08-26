'use strict';

const AUDIT_WIDTH_ = 15;

function auditSheet_() { return requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.AUDIT_LOG); }

function auditJson_(value) {
  if (value === undefined || value === null || value === '') return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function auditRowHash_(row) {
  var serialized = serializeDeterministic(row.slice(0, 14).map(function(value) { return cellToCanonicalString(value); }));
  return sha256Hex(utf8Bytes(serialized));
}

function makeAuditRow_(entry, previousHash, forceGenesis) {
  var row = Array(AUDIT_WIDTH_).fill('');
  row[0] = entry.auditId || generateId('AUDIT');
  row[1] = entry.at || nowIso_();
  row[2] = String(entry.type || entry.actionType || 'SETTING');
  row[3] = String(entry.actor || activeUserEmail_());
  row[4] = entry.requester || ''; row[5] = entry.approver || '';
  row[6] = String(entry.targetType || 'LOG'); row[7] = String(entry.targetId || row[0]);
  row[8] = entry.customerId || '';
  row[9] = auditJson_(entry.before); row[10] = auditJson_(entry.after);
  row[11] = entry.reason || ''; row[12] = entry.appliedAt || '';
  row[13] = forceGenesis ? CONFIG.AUDIT_CHAIN_GENESIS : previousHash;
  row[14] = auditRowHash_(row);
  return row;
}

function appendAuditUnlocked_(entry, forceGenesis) {
  var sheet = auditSheet_();
  if (sheet.getLastRow() < 2 && !forceGenesis) {
    var createdAt = nowIso_();
    var genesis = makeAuditRow_({type: 'CHAIN_ANCHOR', actor: entry.actor || activeUserEmail_(), targetType: 'AUDIT',
      targetId: 'GENESIS', after: {kind: 'GENESIS', createdAt: createdAt}}, CONFIG.AUDIT_CHAIN_GENESIS, true);
    sheet.appendRow(genesis);
  }
  var lastRow = sheet.getLastRow();
  var previousHash = lastRow >= 2 ? String(sheet.getRange(lastRow, 15).getValue() || '') : CONFIG.AUDIT_CHAIN_GENESIS;
  var row = makeAuditRow_(entry, previousHash, Boolean(forceGenesis));
  sheet.appendRow(row);
  return row[0];
}

function appendAudit(entry) {
  return withScriptLock_(function() { return appendAuditUnlocked_(entry, false); });
}

function appendAuditBatch(entries) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  return withScriptLock_(function() {
    return entries.map(function(entry) { return appendAuditUnlocked_(entry, false); });
  });
}

/**
 * 直近の連鎖起点（GENESIS）の行を返す。
 *
 * **N列だけを1回読んで後方から探す。** 以前は1行につき`getValue()`を
 * 呼んでおり、起点が無ければ全行を1セルずつ読んでいた。監査ログは年5万行に
 * 達し得る設計であり、`verifyChain('RECENT')`が直近N行だけを検証する意図で
 * 呼ばれても、**その前段のアンカー探索が全域を走っていた**（INV-25）。
 */
function getLastAnchorRow() {
  var sheet = auditSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {rowNumber: null, auditId: null};

  var previousHashes = sheet.getRange(2, 14, lastRow - 1, 1).getValues();
  for (var offset = previousHashes.length - 1; offset >= 0; offset -= 1) {
    if (String(previousHashes[offset][0]) === CONFIG.AUDIT_CHAIN_GENESIS) {
      var rowNumber = offset + 2;
      return {rowNumber: rowNumber, auditId: String(sheet.getRange(rowNumber, 1).getValue())};
    }
  }
  return {rowNumber: null, auditId: null};
}

function verifyChain(scope) {
  var sheet = auditSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {ok: true, brokenAt: null, verifiedRows: 0};
  var anchor = getLastAnchorRow();
  var start = anchor.rowNumber || 2;
  if (scope === 'RECENT') start = Math.max(start, lastRow - SETTINGS.AUDIT_CHAIN_VERIFY_ROWS + 1);
  else if (scope !== 'FULL') throw new TypeError('scope must be RECENT or FULL');
  var rows = sheet.getRange(start, 1, lastRow - start + 1, AUDIT_WIDTH_).getValues();
  var previous = start > 2 ? String(sheet.getRange(start - 1, 15).getValue()) : null;
  for (var index = 0; index < rows.length; index += 1) {
    var row = rows[index];
    var actual = String(row[14] || '');
    var expected = auditRowHash_(row);
    var isOrigin = String(row[13]) === CONFIG.AUDIT_CHAIN_GENESIS;
    var linkOk = isOrigin ? (start + index === anchor.rowNumber) : (previous !== null && String(row[13]) === previous);
    if (actual !== expected || !linkOk) {
      return {ok: false, brokenAt: {rowNumber: start + index, auditId: String(row[0]), expected: expected, actual: actual}, verifiedRows: index};
    }
    previous = actual;
  }
  return {ok: true, brokenAt: null, verifiedRows: rows.length};
}

function appendChainBreak(brokenAt, expected, actual, actor) {
  return withScriptLock_(function() {
    return appendAuditUnlocked_({type: 'CHAIN_BREAK', actor: actor, targetType: 'AUDIT',
      targetId: typeof brokenAt === 'object' ? brokenAt.auditId : String(brokenAt),
      after: {kind: 'BREAK', brokenAtAuditId: typeof brokenAt === 'object' ? brokenAt.auditId : String(brokenAt),
        expectedHash: expected, actualHash: actual, detectedAt: nowIso_()}}, true);
  });
}

function appendChainAnchor(archiveId, tailHash, count, periodStart, periodEnd) {
  return withScriptLock_(function() {
    return appendAuditUnlocked_({type: 'CHAIN_ANCHOR', actor: activeUserEmail_(), targetType: 'AUDIT', targetId: archiveId,
      after: {kind: 'ARCHIVE', tailHash: tailHash, count: count, periodStart: periodStart, periodEnd: periodEnd, archiveId: archiveId}}, true);
  });
}

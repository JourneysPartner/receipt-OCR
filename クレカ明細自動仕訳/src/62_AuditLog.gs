'use strict';

const AUDIT_WIDTH_ = 15;
const AUDIT_TAIL_WINDOW_ = 200;

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

/** 監査行は消さないため、古い末尾を窓の下限として使える。 */
function auditTailRange_(sheet, start) {
  start = start === undefined ? Math.max(2, sheet.getLastRow()) : start;
  return {start: start, range: quoteSheetName_(sheet.getName()) + '!A' + start + ':O' +
    (start + AUDIT_TAIL_WINDOW_ - 1)};
}

function auditTailFromValues_(start, values) {
  var tail = {lastRow: 1, lastHash: null};
  (values || []).forEach(function(row, offset) {
    if (row[0] !== '' && row[0] !== null && row[0] !== undefined) {
      tail = {lastRow: start + offset, lastHash: String(row[14] || '')};
    }
  });
  return tail;
}

/** 相乗りした最初の窓を使い、最後まで埋まっていた場合だけ続きを読む。 */
function readAuditTail_(sheet, window, values) {
  window = window || auditTailRange_(sheet);
  if (values === undefined) values = sheetsReadRanges_(sheet, [window.range])[0];
  var tail = auditTailFromValues_(window.start, values);
  if (tail.lastRow === 1 && window.start > 2) {
    // 本当より大きい末尾は前提外。黙って起点を書かず、A列とO列で確かめ直す。
    var full = sheetsReadRanges_(sheet, [quoteSheetName_(sheet.getName()) + '!A2:A',
      quoteSheetName_(sheet.getName()) + '!O2:O']);
    return auditTailFromValues_(2, (full[0] || []).map(function(row, offset) {
      var value = Array(AUDIT_WIDTH_).fill('');
      value[0] = row[0]; value[14] = (full[1][offset] || [])[0];
      return value;
    }));
  }
  while (tail.lastRow === window.start + AUDIT_TAIL_WINDOW_ - 1) {
    window = auditTailRange_(sheet, window.start + AUDIT_TAIL_WINDOW_);
    var next = auditTailFromValues_(window.start, sheetsReadRanges_(sheet, [window.range])[0]);
    if (next.lastRow === 1) break;
    tail = next;
  }
  return tail;
}

function appendAuditUnlocked_(entry, forceGenesis, knownTail) {
  return writeAuditEntriesUnlocked_([entry], Boolean(forceGenesis), knownTail)[0];
}

/**
 * 監査行の連鎖を手元でつないでまとめて書く。呼出側がロックを持つ。
 * 行ごとにappendAuditUnlocked_を呼ぶと、末尾ハッシュの読取と書込が行数分
 * 繰り返され、同じまとまりの監査記録が途中で割れるため、先に全行を作る。
 */
function appendAuditRowsUnlocked_(entries, knownTail) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  if (!entries.length) return [];
  return writeAuditEntriesUnlocked_(entries, false, knownTail);
}

/** 単件とまとめ書きで、起点・連鎖・追記位置の決め方をそろえる。 */
function writeAuditEntriesUnlocked_(entries, forceGenesis, knownTail) {
  var sheet = auditSheet_();
  var tail = knownTail || readAuditTail_(sheet);
  var rows = [];
  var previousHash = tail.lastRow >= 2 ? tail.lastHash : CONFIG.AUDIT_CHAIN_GENESIS;
  if (tail.lastRow < 2 && !forceGenesis) {
    var createdAt = nowIso_();
    var firstActor = entries[0] && entries[0].actor || activeUserEmail_();
    var genesis = makeAuditRow_({type: 'CHAIN_ANCHOR', actor: firstActor,
      targetType: 'AUDIT', targetId: 'GENESIS',
      after: {kind: 'GENESIS', createdAt: createdAt}}, CONFIG.AUDIT_CHAIN_GENESIS, true);
    rows.push(genesis);
    previousHash = genesis[14];
  }

  var ids = entries.map(function(entry) {
    var row = makeAuditRow_(entry, previousHash, forceGenesis);
    previousHash = row[14];
    rows.push(row);
    return row[0];
  });
  var firstRow = tail.lastRow + 1;
  ensureRowExists_(sheet, firstRow + rows.length - 1);
  sheet.getRange(firstRow, 1, rows.length, AUDIT_WIDTH_).setValues(rows);
  return ids;
}

function appendAudit(entry) {
  return withScriptLock_(function() { return appendAuditUnlocked_(entry, false); });
}

function appendAuditBatch(entries) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  return withScriptLock_(function() { return appendAuditRowsUnlocked_(entries); });
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

'use strict';

const DICTIONARY_WIDTH_ = 18;

function dictionarySheet_(common) {
  return requireSheet_(masterSpreadsheet_(), common ? CONFIG.SHEET_NAMES.COMMON_PARTNER_DICT : CONFIG.SHEET_NAMES.CUSTOMER_PARTNER_DICT);
}

function dictionaryRow_(record) {
  var values = record.values;
  return {dictId: String(values[0]), original: String(values[1]), normalized: String(values[2]), partnerName: String(values[3]),
    matchMethod: String(values[4]), priority: values[5] === '' ? null : Number(values[5]), customerId: values[6] || null,
    validFrom: values[7] || null, validTo: values[8] || null, approved: toBool(values[9]), registeredBy: String(values[10] || ''),
    approver: values[11] || null, registeredAt: values[12], version: Number(values[13]), active: toBool(values[14]),
    conflict: toBool(values[15]), conflictGroupId: values[16] || null, invalidatedAt: values[17] || null, _rowNumber: record.rowNumber};
}

function readDictionary_(common) {
  return readSheetRows_(dictionarySheet_(common), DICTIONARY_WIDTH_).map(dictionaryRow_);
}

function learnFromResolution(customerId, original, normalized, partnerName, actor) {
  var expected = normalizeMerchant(original);
  if (String(normalized) !== expected) throw new MasterDataError('Normalized merchant must equal normalizeMerchant(original)');
  var dictId = generateId('DICT'); var now = nowIso_();
  dictionarySheet_(false).appendRow([dictId, String(original), expected, String(partnerName), 'exact_normalized', '',
    String(customerId), '', '', false, String(actor), '', now, 1, true, false, '', '']);
  appendAudit({type: 'DICT_REGISTER', actor: actor, targetType: 'DICT', targetId: dictId, customerId: customerId,
    before: null, after: {B: String(original), C: expected, D: String(partnerName), E: 'exact_normalized', O: true}});
  return dictId;
}

/**
 * 前方一致・部分一致の辞書規則を登録する（5.7 STEP5）。
 *
 * 完全一致の学習（`learnFromResolution`）では受けられない明細がある ──
 * 楽天のふるさと納税は「熊本県荒尾市　ﾗｸﾃﾝｲﾁﾊﾞ911963」のように寄付ごとの
 * 番号が付き、**同じ文字列が二度と現れない**。1件ずつ完全一致で覚えても
 * 次の明細では当たらないので、パターンで受ける必要がある。
 *
 * `承認済=TRUE`で登録する。STEP5が自動採用するのは承認済のパターンだけで、
 * 未承認は候補提示にとどまる（5.7）。パターンは人が決めるものなので、
 * 実行者が当該顧客の管理者であることを確かめる。
 */
function registerDictionaryPattern(customerId, pattern, partnerName, matchMethod, actor) {
  if (matchMethod !== 'prefix' && matchMethod !== 'partial') {
    throw new TypeError('registerDictionaryPattern supports prefix and partial only');
  }
  if (!partnerName) throw new TypeError('registerDictionaryPattern requires a partner name');
  var normalized = normalizeMerchant(pattern);
  if (!normalized) throw new MasterDataError('Pattern must not be empty after normalization');
  var customer = getCustomerById(customerId);
  if (customer.admins.indexOf(String(actor).toLowerCase()) < 0) {
    throw new AuthorizationError('System administrator role is required');
  }
  var dictId = generateId('DICT');
  var now = nowIso_();
  dictionarySheet_(false).appendRow([dictId, String(pattern), normalized, String(partnerName),
    matchMethod, '', String(customerId), '', '', true, String(actor), String(actor), now, 1,
    true, false, '', '']);
  appendAudit({type: 'DICT_REGISTER', actor: actor, approver: actor, targetType: 'DICT',
    targetId: dictId, customerId: customerId, before: null,
    after: {B: String(pattern), C: normalized, D: String(partnerName), E: matchMethod, J: true, O: true}});
  return dictId;
}

function promoteToCommon(dictId, approver) {
  if (!approver) throw new AuthorizationError('Approver is required');
  var source = readDictionary_(false).filter(function(row) { return row.dictId === String(dictId) && row.active; });
  if (source.length !== 1) throw new IntegrityError(null, 'Active customer dictionary row must be unique');
  var item = source[0]; var existing = readDictionary_(true).filter(function(row) { return row.dictId === String(dictId) && row.active; });
  if (existing.length) return;
  var now = nowIso_();
  dictionarySheet_(true).appendRow([item.dictId, item.original, normalizeMerchant(item.original), item.partnerName, item.matchMethod,
    item.priority === null ? '' : item.priority, '', item.validFrom || '', item.validTo || '', item.approved,
    item.registeredBy, String(approver), now, 1, true, false, '', '']);
  appendAudit({type: 'APPROVE', actor: approver, approver: approver, targetType: 'DICT', targetId: item.dictId,
    before: null, after: {scope: 'COMMON', O: true}});
}

function conflictGroupId_(members) {
  var key = members.map(function(item) { return item.dictId + ':' + item.partnerName; }).sort().join('|');
  return 'CONFLICT_' + sha256Hex(utf8Bytes(key)).slice(0, 16);
}

function detectDictionaryConflicts(scope) {
  var common = scope === 'COMMON';
  var rows = readDictionary_(common).filter(function(row) { return row.active; });
  var groups = [];
  ['original', 'normalized'].forEach(function(field) {
    var byValue = Object.create(null);
    rows.forEach(function(row) { var key = row[field]; if (!byValue[key]) byValue[key] = []; byValue[key].push(row); });
    Object.keys(byValue).forEach(function(key) {
      var members = byValue[key];
      var partners = members.map(function(item) { return item.partnerName; }).filter(function(value, index, all) { return all.indexOf(value) === index; });
      if (key && partners.length > 1) groups.push({kind: field, key: key, groupId: conflictGroupId_(members), rows: members});
    });
  });
  var assignments = Object.create(null);
  groups.forEach(function(group) { group.rows.forEach(function(row) { assignments[row._rowNumber] = group.groupId; }); });
  var sheet = dictionarySheet_(common);
  rows.forEach(function(row) {
    sheet.getRange(row._rowNumber, 16, 1, 2).setValues([[Boolean(assignments[row._rowNumber]), assignments[row._rowNumber] || '']]);
  });
  return groups.map(function(group) { return {kind: group.kind, key: group.key, groupId: group.groupId,
    dictIds: group.rows.map(function(row) { return row.dictId; }), partnerNames: group.rows.map(function(row) { return row.partnerName; })}; });
}

function rollbackDictionary(dictId, approver) {
  if (!approver) throw new AuthorizationError('Approver is required');
  var candidates = readDictionary_(true).filter(function(row) { return row.dictId === String(dictId); }).sort(function(a, b) { return b.version - a.version; });
  if (candidates.length < 2 || !candidates[0].active) return;
  var current = candidates[0]; var previous = candidates[1]; var sheet = dictionarySheet_(true); var now = nowIso_();
  sheet.getRange(current._rowNumber, 15).setValue(false); sheet.getRange(current._rowNumber, 18).setValue(now);
  sheet.getRange(previous._rowNumber, 15).setValue(true); sheet.getRange(previous._rowNumber, 18).setValue('');
  appendAudit({type: 'ROLLBACK', actor: approver, approver: approver, targetType: 'DICT', targetId: dictId,
    before: {version: current.version}, after: {version: previous.version}, reason: 'ROLLBACK'});
}

function invalidateLearnedEntries(dictIds, reason, actor) {
  var wanted = dictIds.map(String); var sheet = dictionarySheet_(false); var now = nowIso_(); var changed = [];
  readDictionary_(false).forEach(function(row) {
    if (wanted.indexOf(row.dictId) >= 0 && row.active) {
      sheet.getRange(row._rowNumber, 15).setValue(false); sheet.getRange(row._rowNumber, 18).setValue(now); changed.push(row.dictId);
    }
  });
  if (changed.length) appendAudit({type: 'DICT_REGISTER', actor: actor, targetType: 'DICT', targetId: changed.join(','),
    before: {O: true}, after: {O: false}, reason: reason || 'CANCEL_REPROCESS'});
}

function levenshtein_(left, right) {
  var previous = Array(right.length + 1).fill(0).map(function(_, index) { return index; });
  for (var i = 1; i <= left.length; i += 1) {
    var current = [i];
    for (var j = 1; j <= right.length; j += 1) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[right.length];
}

function findSimilarPartners(name, limit) {
  var wanted = normalizeMerchant(name);
  return readSheetRows_(requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.COMMON_PARTNER_LIST), 6).map(function(record) {
    var normalized = normalizeMerchant(record.values[1]);
    return {partnerId: String(record.values[0]), partnerName: String(record.values[1]), version: Number(record.values[5]),
      score: levenshtein_(wanted, normalized)};
  }).sort(function(a, b) { return a.score - b.score || a.partnerName.localeCompare(b.partnerName); }).slice(0, Math.max(0, Number(limit) || 0));
}

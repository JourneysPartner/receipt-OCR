'use strict';

/**
 * 4.30 承認申請（2.1.21）。
 *
 * 申請から承認までの間、`requestId`と申請内容を**保存する場所**である
 * （B-M14）。このシートが無いと、申請を送る操作が実装されず、形式の
 * 有効化も新規取引先の作成も、承認を要する操作がすべて宙に浮く。
 *
 * 行は削除しない。申請と承認の履歴は監査の材料であり、期限切れは
 * `EXPIRED`へ遷移させて再申請で置き換える。
 */

var APPROVAL_REQUEST_WIDTH_ = 13;   // A〜M

/** 申請種別ごとの申請内容（I列）必須キー（2.1.21.1）。 */
var REQUEST_PAYLOAD_REQUIRED_KEYS_ = Object.freeze({
  FORMAT_ACTIVATE: ['formatId', 'version', 'answers', 'gateResult'],
  FORMAT_ROLLBACK: ['formatId', 'fromVersion', 'toVersion', 'gateResult'],
  SAMPLE_RETIRE: ['sampleId', 'formatId', 'reason', 'lostCoverage'],
  SAMPLE_REBASELINE: ['sampleIds', 'reason', 'diffSummary', 'diffHash'],
  PARTNER_CREATE: ['partnerName', 'similarPartners', 'customerId']
});

function approvalRequestSheet_() {
  return requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.APPROVAL_REQUEST);
}

function requestFromRecord_(record) {
  var v = record.values;
  return {
    requestId: String(v[0]), requestType: String(v[1]), status: String(v[2]),
    applicant: String(v[3]), submittedAt: v[4],
    targetType: v[5] || null, targetId: v[6] || null, customerId: v[7] || null,
    payload: jsonCell_(v[8], null),
    approvedBy: v[9] || null, decidedAt: v[10] || null,
    rejectReason: v[11] || null, auditId: v[12] || null,
    _rowNumber: record.rowNumber
  };
}

/**
 * 申請を登録する（4.30）。
 *
 * `PENDING`の1行として保存し、`requestId`を返す。**申請内容の必須キーは
 * 入口で検査する** ── 欠けたまま保存すると、承認画面が判断材料を出せず、
 * 承認者は中身の分からない申請を承認するか放置するかの二択になる。
 */
function submitRequest(requestType, payload, applicant) {
  var type = String(requestType);
  if (!REQUEST_TYPE[type]) throw new TypeError('Unknown request type: ' + type);
  if (!applicant) throw new TypeError('submitRequest requires the applicant');

  var required = REQUEST_PAYLOAD_REQUIRED_KEYS_[type] || [];
  var missing = required.filter(function(key) {
    return !payload || payload[key] === undefined;
  });
  if (missing.length) {
    throw new TypeError('Request payload for ' + type +
      ' is missing required keys: ' + missing.join(', '));
  }

  var requestId = generateId('REQ');
  var row = new Array(APPROVAL_REQUEST_WIDTH_).fill('');
  row[0] = requestId;
  row[1] = type;
  row[2] = REQUEST_STATUS.PENDING;
  row[3] = String(applicant);
  row[4] = nowIso_();
  row[5] = payload && payload.targetType ? String(payload.targetType) : type;
  row[6] = payload && (payload.targetId || payload.formatId || payload.sampleId ||
    payload.partnerName) || '';
  row[7] = payload && payload.customerId ? String(payload.customerId) : '';
  row[8] = JSON.stringify(payload || {});

  return withScriptLock_(function() {
    approvalRequestSheet_().appendRow(row);
    appendAuditUnlocked_({
      type: 'REQUEST_SUBMIT', actor: String(applicant), requester: String(applicant),
      targetType: 'REQUEST', targetId: requestId,
      customerId: row[7] || '', after: {requestType: type}
    }, false);
    return requestId;
  });
}

function getRequest(requestId) {
  var matches = findRowsByColumnValue_(approvalRequestSheet_(), 1,
    String(requestId), APPROVAL_REQUEST_WIDTH_);
  return matches.length ? requestFromRecord_(matches[0]) : null;
}

/**
 * 期限切れの`PENDING`を`EXPIRED`にする。
 *
 * 期限切れの申請を承認できないのは、申請内容に含まれるゲート結果や
 * ハッシュが古くなっているためである。`EXPIRED`は再申請で置き換える。
 */
function expireStaleRequests(now) {
  var reference = now ? new Date(now) : new Date();
  var expireDays = Number(SETTINGS.REQUEST_EXPIRE_DAYS || 30);
  var sheet = approvalRequestSheet_();
  var expired = [];
  readSheetRows_(sheet, APPROVAL_REQUEST_WIDTH_).map(requestFromRecord_)
    .forEach(function(request) {
      if (request.status !== REQUEST_STATUS.PENDING) return;
      var age = (reference.getTime() - new Date(request.submittedAt).getTime()) /
        (24 * 3600 * 1000);
      if (age > expireDays) {
        sheet.getRange(request._rowNumber, 3).setValue(REQUEST_STATUS.EXPIRED);
        expired.push(request.requestId);
      }
    });
  return {expired: expired};
}

function decideRequest_(requestId, decision, approver, reason) {
  if (!approver) throw new TypeError('A decision requires the approver');
  return withScriptLock_(function() {
    var request = getRequest(requestId);
    if (!request) throw new IntegrityError(null, 'Request not found: ' + requestId);
    if (request.status !== REQUEST_STATUS.PENDING) {
      throw new StateTransitionError(
        'Request is not pending: ' + requestId + ' (' + request.status + ')');
    }
    var sheet = approvalRequestSheet_();
    sheet.getRange(request._rowNumber, 3).setValue(decision);
    sheet.getRange(request._rowNumber, 10).setValue(String(approver));
    sheet.getRange(request._rowNumber, 11).setValue(nowIso_());
    if (decision === REQUEST_STATUS.REJECTED) {
      if (!reason) throw new TypeError('A rejection requires a reason');
      sheet.getRange(request._rowNumber, 12).setValue(String(reason));
    }
    var auditId = appendAuditUnlocked_({
      type: decision === REQUEST_STATUS.APPROVED ? 'REQUEST_APPROVE' : 'REQUEST_REJECT',
      actor: String(approver), approver: String(approver),
      targetType: 'REQUEST', targetId: requestId,
      customerId: request.customerId || '',
      before: {status: REQUEST_STATUS.PENDING}, after: {status: decision},
      reason: reason || ''
    }, false);
    sheet.getRange(request._rowNumber, 13).setValue(auditId);
    return Object.assign({}, request, {status: decision, approvedBy: String(approver)});
  });
}

function approveRequest(requestId, approver) {
  return decideRequest_(requestId, REQUEST_STATUS.APPROVED, approver);
}

function rejectRequest(requestId, approver, reason) {
  return decideRequest_(requestId, REQUEST_STATUS.REJECTED, approver, reason);
}

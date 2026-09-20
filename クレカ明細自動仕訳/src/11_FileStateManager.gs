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

/** 現在のファイル状態（処理ログQ列）。 */
function getFileState(fileId) {
  var record = getProcessLogRecord_(fileId);
  if (!record) throw new IntegrityError(null, 'Process log not found: ' + fileId);
  return String(record.values[16]);
}

function transitionFileState(fileId, fromState, toState, runId) {
  if (!isAllowedTransition(fromState, toState)) throw new StateTransitionError('File transition is not allowed: ' + fromState + ' -> ' + toState);
  var record = getProcessLogRecord_(fileId);
  if (!record || String(record.values[16]) !== String(fromState)) throw new StateTransitionError('File compare-and-set failed');
  if (runId !== undefined && runId !== null && String(record.values[0]) !== String(runId)) throw new StateTransitionError('Run ID mismatch');
  // いま読んだ行を渡す。比較更新のために読んだばかりで、同じ実行の中で
  // 他者がこの行を書くことはない（ファイルはリースで直列化されている）。
  var written = updateProcessLog(fileId,
    {internalState: toState, expectedPrefix: STATE_TO_PREFIX[toState]}, record);
  updateFilePrefix(fileId, written);
  if (toState !== FILE_STATE.VALIDATING && toState !== FILE_STATE.WRITING) releaseLease(fileId, runId, 'STATE_TRANSITION:' + toState);
}

function removableStatePrefixRegex_() {
  var prefixes = Object.keys(STATE_TO_PREFIX).map(function(key) { return STATE_TO_PREFIX[key]; }).filter(Boolean)
    .filter(function(value, index, all) { return all.indexOf(value) === index; })
    .sort(function(a, b) { return b.length - a.length; })
    .map(function(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
  return new RegExp('^(?:' + prefixes.join('|') + ')');
}

/**
 * @param {Object=} known 直前の書込が返した行（`writtenRecords_`）。
 *   渡されたときは読み直さない。渡さなければ今までどおり自分で読む。
 */
function updateFilePrefix(fileId, known) {
  var process = (known && known.process) || getProcessLogRecord_(fileId);
  var permanent = (known && known.permanent) || getPermanentFileIndexRecord_(fileId);
  if (!process || !permanent) return {ok: false, reason: 'FILE_NOT_REGISTERED'};
  var expected = String(process.values[30] || '');
  var baseName = String(permanent.values[2] || '').replace(removableStatePrefixRegex_(), '');
  try {
    var file = DriveApp.getFileById(fileId);
    var expectedName = expected + baseName;
    if (file.getName() !== expectedName) file.setName(expectedName);
    // **同じ値を書き直さない。**この関数は1ファイルの取込で3回呼ばれ、成功経路は
    // 既に `OK` の行へ `OK` を書いていた ── 書込1往復と、その前の読取1往復を
    // 毎回払っていた。読取クォータ（60回/分）が取込の天井なので、値の変わらない
    // 書込は**速さをそのまま食う**（v1.6）。
    var retryCount = Number(process.values[32] || 0);
    if (String(process.values[31]) !== RENAME_STATE.OK || retryCount !== 0) {
      updateProcessLog(fileId, {renameState: RENAME_STATE.OK, renameRetryCount: retryCount}, process);
    }
    return {ok: true, reason: null};
  } catch (error) {
    var retry = Number(process.values[32] || 0) + 1;
    updateProcessLog(fileId, {renameState: retry >= SETTINGS.MAX_RENAME_RETRIES ? RENAME_STATE.FAILED_MAX_RETRY : RENAME_STATE.PENDING_RETRY,
      renameRetryCount: retry}, process);
    return {ok: false, reason: /not found/i.test(error.message) ? 'FILE_NOT_FOUND' : 'PENDING_RETRY'};
  }
}

function retryPendingRenames(customerId) {
  var sheet = processLogSheet_();
  findRowsByColumnValue_(sheet, 6, customerId, PROCESS_LOG_WIDTH_).forEach(function(record) {
    if (String(record.values[31]) !== RENAME_STATE.PENDING_RETRY || Number(record.values[32] || 0) >= SETTINGS.MAX_RENAME_RETRIES) return;
    // 走査で読んだ処理ログの行をそのまま使う（恒久索引だけ読ませる）。
    try { updateFilePrefix(String(record.values[7]), {process: record}); } catch (ignored) { /* one file must not stop the loop */ }
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
    // 処理ログは Sheets API でしか書かない（01 の `SHEETS_API_ONLY_SHEETS_`）。
    // ここを `setValue` に戻すと、読取前の flush を省いた全経路が古い行を
    // 読み始める。`flush 1` が見張っている。
    Sheets.Spreadsheets.Values.batchUpdate({valueInputOption: 'RAW', data: [{
      range: a1Range_(processLogSheet_().getName(), process.rowNumber, 30, 30),
      values: [[now]]
    }]}, masterSpreadsheet_().getId());
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
    // `PROCESS`リースは取込の途中でだけ持たれるので、ファイルが
    // VALIDATING/WRITINGでないのに残っていたら状態の食い違いであり、
    // 黙って消さず調査対象にする。**`WRITE_ONLY`リースにこの条件を課さない**
    // ── REVIEW_WAIT/COMPLETEDのファイルに取るのが正常な使い方であり、
    // 課すと強制終了で残った行を誰も解放できない。
    if (lease.purpose !== LEASE_PURPOSE.WRITE_ONLY) {
      var process = getProcessLogRecord_(lease.fileId);
      // 処理ログ行が**無い**リースは孤児である。`acquireLease`は
      // `createOrUpdateProcessLog`より先に走るので、その隙に実行が落ちると
      // この形で残る。守るべき取込が存在しないうえ、心拍が閾値を超えている
      // 以上（生きた実行は6分で終わる）持ち主も居ない。ここで拒むと
      // そのファイルは永久に取り込めない。
      // 行が**在って**状態が食い違う場合は従来どおり調査対象として拒む。
      if (process && [FILE_STATE.VALIDATING, FILE_STATE.WRITING].indexOf(String(process.values[16])) < 0) throw new StateTransitionError('Lease state is not force-releasable');
    }
    var customer = getCustomerById(lease.customerId);
    if (customer.admins.indexOf(String(actor).toLowerCase()) < 0) throw new AuthorizationError('System administrator role is required');
    var elapsed = (Date.now() - new Date(lease.lastHeartbeat).getTime()) / 1000;
    if (!isFinite(elapsed) || elapsed <= SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS) throw new StateTransitionError('Heartbeat has not exceeded the force-release threshold');
    appendAuditUnlocked_({type: 'LEASE_FORCE_RELEASE', actor: actor, targetType: 'LEASE', targetId: lease.leaseId,
      customerId: lease.customerId, before: {state: LEASE_STATE.ACTIVE}, after: {state: null}, reason: reason || ''}, false);
    leaseSheet_().deleteRow(lease._rowNumber);
  });
}

/**
 * 心拍が途絶えたリースを検出する。
 *
 * **`WRITE_ONLY`リースはファイル状態を問わず対象にする。** 解決操作・
 * 取消し・復元は`REVIEW_WAIT`/`COMPLETED`のファイルに`WRITE_ONLY`リースを
 * 取り、GASの実行が6分上限で強制終了されると`finally`は走らずACTIVE行が
 * 残る。検出条件を「内部状態がVALIDATING/WRITING」に限ると、この残留は
 * **検出も解放もできず、以後そのファイルの全解決操作がLEASE_CONFLICTに
 * なる** ── INV-20の根拠文が予言した状態そのものである。
 */
/**
 * 停滞リースとして自動で拾える条件。**表示と解放で必ずこれを使うこと。**
 *
 * 以前は同じ判定を2箇所に別々に書いていた ── 一覧は経過時間だけで
 * 「解放可」と出し、解放側は状態も見ていた。その食い違いのせいで、
 * **`COMPLETED` のファイルに残ったリースが「解放可」と表示され続け、
 * 何度解放しても消えない**という形になる（2026-09-21に実機で確認。
 * 運用者は壊れたと読み、別の種を探しに行くことになる）。
 *
 * 拾えない場合は**理由を返す。**「解放できない」とだけ言われても、
 * 次に何をすればよいのか分からない。
 *
 * @param {Object=} knownProcess 呼出側が既に読んだ処理ログの行（読み直さない）。
 */
function leaseStallCheck_(lease, now, knownProcess) {
  var elapsed = (now - new Date(lease.lastHeartbeat).getTime()) / 1000;
  if (!isFinite(elapsed) || elapsed <= SETTINGS.HEARTBEAT_TIMEOUT_SECONDS) {
    return {detectable: false, elapsed: elapsed, blockedReason: null};
  }
  if (lease.purpose === LEASE_PURPOSE.WRITE_ONLY) {
    return {detectable: true, elapsed: elapsed, blockedReason: null};
  }
  var process = knownProcess === undefined ? getProcessLogRecord_(lease.fileId) : knownProcess;
  // 処理ログ行を持たないリースは孤児。見逃すと、そのファイルが止まって
  // いる理由に運用者が辿り着けない（実機で28時間気づけなかった）。
  if (!process) return {detectable: true, elapsed: elapsed, blockedReason: null};
  var state = String(process.values[16]);
  if ([FILE_STATE.VALIDATING, FILE_STATE.WRITING].indexOf(state) >= 0) {
    return {detectable: true, elapsed: elapsed, blockedReason: null};
  }
  return {
    detectable: false, elapsed: elapsed,
    blockedReason: '取込中でない状態（' + state + '）のファイルにリースが残っている。' +
      '状態の食い違いなので自動では解放しない ── 転記先とファイル名を確かめたうえで、' +
      'opsReleaseInvestigatedLease でリースIDを指定して解放すること'
  };
}

function detectStalledLeases() {
  var now = Date.now();
  return activeLeases_().filter(function(lease) {
    return leaseStallCheck_(lease, now).detectable;
  });
}

/**
 * **調べたうえで**、あるべきでないリースを1件だけ解放する。
 *
 * `forceReleaseLease` は取込の途中で持ち主が落ちたリースのためのもので、
 * ファイルが `VALIDATING`/`WRITING` でなければ**わざと拒む** ── 状態の
 * 食い違いを黙って消さないためである。その判断は正しいが、拒むだけだと
 * **調べ終えた運用者に打つ手が無い。**そのファイルは二度と取り込めない。
 *
 * だからこちらは、`forceReleaseLease` が拒む場合**だけ**を受け持つ。
 * 2つは排他であり、どちらも心拍の閾値・管理者・監査記録を要求する。
 * 一括では走らせない ── **リースIDを名指しさせる**ことが「調べた」の証である。
 */
function releaseInvestigatedLease(leaseId, reason, actor) {
  if (!leaseId) throw new TypeError('releaseInvestigatedLease requires a leaseId');
  if (!reason) throw new TypeError('releaseInvestigatedLease requires a reason');
  return withScriptLock_(function() {
    var lease = activeLeases_().filter(function(item) {
      return item.leaseId === String(leaseId);
    })[0];
    if (!lease) throw new StateTransitionError('Lease not found: ' + leaseId);
    if (lease.purpose === LEASE_PURPOSE.WRITE_ONLY) {
      throw new StateTransitionError('WRITE_ONLY leases are released by forceReleaseLease');
    }
    var process = getProcessLogRecord_(lease.fileId);
    if (!process) {
      throw new StateTransitionError('Orphan leases are released by forceReleaseLease');
    }
    var state = String(process.values[16]);
    if ([FILE_STATE.VALIDATING, FILE_STATE.WRITING].indexOf(state) >= 0) {
      throw new StateTransitionError('Lease is still in progress; use forceReleaseLease');
    }
    var customer = getCustomerById(lease.customerId);
    if (customer.admins.indexOf(String(actor).toLowerCase()) < 0) {
      throw new AuthorizationError('System administrator role is required');
    }
    var elapsed = (Date.now() - new Date(lease.lastHeartbeat).getTime()) / 1000;
    if (!isFinite(elapsed) || elapsed <= SETTINGS.LEASE_FORCE_RELEASE_MIN_SECONDS) {
      throw new StateTransitionError('Heartbeat has not exceeded the force-release threshold');
    }
    appendAuditUnlocked_({type: 'LEASE_RELEASE_INVESTIGATED', actor: actor, targetType: 'LEASE',
      targetId: lease.leaseId, customerId: lease.customerId,
      before: {state: LEASE_STATE.ACTIVE, fileState: state}, after: {state: null},
      reason: String(reason)}, false);
    leaseSheet_().deleteRow(lease._rowNumber);
    return {leaseId: lease.leaseId, fileId: lease.fileId, fileState: state, released: true};
  });
}

'use strict';

/**
 * 4.24 整合性チェック。
 *
 * 仕様23.4が求める3者照合（顧客転記先・取引ログ・ファイル状態）を行う。
 * 本モジュールは検出のみを行い、修復はしない。不整合を推測で片付けず、
 * 担当者の判断へ回す（仕様23.4）。
 */

/** 検査結果1件。 */
function integrityFinding_(check, severity, detail) {
  return {check: check, severity: severity, detail: detail};
}

/**
 * 検査1：同一取引IDが転記先に2行以上ないこと（INV-11）。
 * インデックスから引くため、取引ごとにシートを読まない（INV-08）。
 */
function checkDuplicateDestinationRows(index, txLogs) {
  var findings = [];
  txLogs.forEach(function(tx) {
    var hit = getRowByTxId(index, tx.fullTxId);
    if (hit && hit.matchCount >= 2) {
      findings.push(integrityFinding_('DUPLICATE_DESTINATION_ROW', 'STOP', {
        fullTxId: tx.fullTxId, matchCount: hit.matchCount
      }));
    }
  });
  return findings;
}

/**
 * 検査2：`COMMITTED`の取引に転記先の行が存在すること（行欠落）。
 */
function checkMissingDestinationRows(index, txLogs) {
  var findings = [];
  txLogs.forEach(function(tx) {
    if (tx.transactionStatus !== TX_STATUS.COMMITTED) return;
    var hit = getRowByTxId(index, tx.fullTxId);
    if (!hit || !hit.matchCount) {
      findings.push(integrityFinding_('DESTINATION_ROW_MISSING', 'REVIEW', {
        fullTxId: tx.fullTxId, destinationRow: tx.destinationRow
      }));
    }
  });
  return findings;
}

/**
 * 検査3：`COMMITTED`の取引の現在値が読取確認値と一致すること（手動変更の検出）。
 *
 * 比較は5.5の正準化規則を通す（INV-15）。ここで検出したものは仕様17.2の
 * 手動変更フローへ回す。回復処理（4.23）は`PREPARED`／`WRITING`しか見ないため、
 * `COMMITTED`の値ずれを拾えるのは本検査だけである（6.2 手順7が
 * `recoverPartialFailure`より先に置かれている理由）。
 */
function checkManualChanges(index, txLogs) {
  var findings = [];
  txLogs.forEach(function(tx) {
    if (tx.transactionStatus !== TX_STATUS.COMMITTED) return;
    var hit = getRowByTxId(index, tx.fullTxId);
    if (!hit || !hit.matchCount) return;   // 検査2が扱う
    var current = getValuesByRow(index, hit.rowNumber);
    ['b', 'f', 'i', 'k', 'm'].forEach(function(column) {
      if (!canonicalReadValuesEqual(column, tx.verified[column], current[column])) {
        findings.push(integrityFinding_('MANUAL_CHANGE', 'REVIEW', {
          fullTxId: tx.fullTxId, rowNumber: hit.rowNumber, column: column,
          expected: tx.verified[column], actual: current[column]
        }));
      }
    });
  });
  return findings;
}

/**
 * 検査4：ファイル内部状態と取引状態の整合（3者照合の3者目）。
 *
 * `COMPLETED`／`CANCELED`のファイルにINV-17を満たさない有効取引が残っていないか。
 * これは4.28の停止条件を`COMPLETED`側から先回りで検出する唯一の手段である。
 */
function checkFileStateConsistency(fileState, txLogs) {
  var findings = [];
  var terminal = [TX_STATUS.COMMITTED, TX_STATUS.CANCELED, TX_STATUS.DELETED_ACCEPTED];
  if (fileState !== FILE_STATE.COMPLETED && fileState !== FILE_STATE.CANCELED) return findings;
  txLogs.forEach(function(tx) {
    if (terminal.indexOf(tx.transactionStatus) < 0) {
      findings.push(integrityFinding_('FILE_STATE_TX_MISMATCH', 'STOP', {
        fullTxId: tx.fullTxId, fileState: fileState, transactionStatus: tx.transactionStatus
      }));
      return;
    }
    if (tx.transactionStatus === TX_STATUS.COMMITTED &&
        tx.partnerResolutionStatus === PARTNER_STATUS.UNRESOLVED) {
      findings.push(integrityFinding_('FILE_STATE_TX_MISMATCH', 'STOP', {
        fullTxId: tx.fullTxId, fileState: fileState,
        partnerResolutionStatus: tx.partnerResolutionStatus
      }));
    }
  });
  return findings;
}

/**
 * 検査5：処理ログの内部状態と恒久ファイルインデックスの状態が一致すること（INV-05）。
 *
 * 食い違うと、保存期間経過で処理ログ行が消えた後にファイルが「未登録」となり、
 * 全明細が再転記される。
 */
function checkPermanentIndexSync(processLogState, permanentIndexState) {
  if (processLogState === null || processLogState === undefined) return [];
  if (String(processLogState) === String(permanentIndexState)) return [];
  return [integrityFinding_('PERMANENT_INDEX_DESYNC', 'STOP', {
    processLogState: processLogState, permanentIndexState: permanentIndexState
  })];
}

/**
 * 3者照合をまとめて実行する。
 *
 * 仕様23.4の実行時点（処理開始前・再開時・freee取込済み登録前）から呼ばれる。
 * `stop`が真のときは処理を進めず担当者の判断を求める。
 */
function runIntegrityCheck(input) {
  if (!input || !input.index) throw new TypeError('runIntegrityCheck requires a destination index');
  var txLogs = input.txLogs || [];
  var findings = []
    .concat(checkDuplicateDestinationRows(input.index, txLogs))
    .concat(checkMissingDestinationRows(input.index, txLogs))
    .concat(checkManualChanges(input.index, txLogs))
    .concat(checkFileStateConsistency(input.fileState, txLogs))
    .concat(checkPermanentIndexSync(input.processLogState, input.permanentIndexState));
  return {
    ok: findings.length === 0,
    stop: findings.some(function(f) { return f.severity === 'STOP'; }),
    findings: findings
  };
}

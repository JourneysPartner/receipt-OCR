'use strict';

/**
 * §5.6.3 明細内容ハッシュ。
 * @param {!Array<!Object>} txs
 * @param {string} sheetName
 * @return {string}
 */
function generateContentHash(txs, sheetName) {
  if (!Array.isArray(txs) || typeof sheetName !== 'string') {
    throw new TypeError('generateContentHash requires transactions and a sheet name');
  }
  var elements = [VERSIONS.HASH, sheetName];
  txs.slice().sort(function(left, right) {
    return Number(left.occurrenceIndex) - Number(right.occurrenceIndex);
  }).forEach(function(tx) {
    elements.push(tx.dateHashKey);
    elements.push(tx.amountBillingJpy);
    elements.push(tx.merchantOriginal);
    elements.push(tx.purpose);
  });
  return sha256Hex(utf8Bytes(serializeDeterministic(elements)));
}

/**
 * §5.6.3 取引同一性ハッシュ。
 * @param {!Object} tx
 * @return {string}
 */
function generateIdentityHash(tx) {
  if (!tx || tx.customerId === undefined) {
    throw new TypeError('generateIdentityHash requires a transaction with customerId');
  }
  return sha256Hex(utf8Bytes(serializeDeterministic([
    VERSIONS.HASH,
    tx.customerId,
    tx.dateHashKey,
    tx.amountBillingJpy,
    tx.merchantOriginal
  ])));
}

/**
 * 恒久ファイルインデックスだけを検索する。
 * @param {string} customerId
 * @param {string} contentHash
 * @param {string} hashVersion
 * @param {!Array<!Object>=} permanentFileIndex
 * @return {!Object}
 */
function checkDuplicateFile(customerId, contentHash, hashVersion, permanentFileIndex) {
  var rows = Array.isArray(permanentFileIndex) ? permanentFileIndex : [];
  var comparable = false;
  for (var index = 0; index < rows.length; index += 1) {
    var row = rows[index];
    if (String(row.customerId) !== String(customerId) ||
        !toBool(row.active !== undefined ? row.active : row.enabled)) {
      continue;
    }
    if (String(row.hashVersion) !== String(hashVersion)) {
      continue;
    }
    comparable = true;
    if (String(row.contentHash) === String(contentHash)) {
      return {duplicate: true, matchedFileId: row.fileId, code: 'DUPLICATE_CONTENT'};
    }
  }
  return {duplicate: false, matchedFileId: null, comparable: comparable};
}

/** @param {*} value @return {number} */
function duplicateMonthOrdinal_(value) {
  var date = isDate_(value) ? value : parseDate(String(value), SYSTEM_TIMEZONE);
  var text = toTokyoDateString_(date).split('-');
  return Number(text[0]) * 12 + Number(text[1]) - 1;
}

/**
 * 同一顧客・同版・有効・lookback内へ絞る。
 * @param {string} customerId
 * @param {string} hashVersion
 * @param {!Array<!Object>} rows
 * @param {!Object=} options
 * @return {!Array<!Object>}
 */
function filterTransactionIndex_(customerId, hashVersion, rows, options) {
  var config = options || {};
  var lookback = config.lookbackMonths === undefined ? SETTINGS.TX_INDEX_LOOKBACK_MONTHS : Number(config.lookbackMonths);
  var asOfOrdinal = config.asOfDate ? duplicateMonthOrdinal_(config.asOfDate) : null;
  return rows.filter(function(row) {
    if (String(row.customerId) !== String(customerId) ||
        String(row.hashVersion) !== String(hashVersion) ||
        !toBool(row.active !== undefined ? row.active : row.enabled)) {
      return false;
    }
    if (asOfOrdinal === null || !row.registeredAt) {
      return true;
    }
    var age = asOfOrdinal - duplicateMonthOrdinal_(row.registeredAt);
    return age >= 0 && age <= lookback;
  });
}

/** @param {!Array<*>} left @param {!Array<*>} right @return {boolean} */
function identicalSequence_(left, right) {
  return left.length === right.length && left.every(function(value, index) {
    return String(value) === String(right[index]);
  });
}

/**
 * §5.8 使用用途修正版候補。
 * 後半2引数は、フェーズ1bでシート値と基準日を純粋入力として注入する。
 */
function checkPurposeRevisionCandidate(customerId, newIdentityHashSeq, newContentHash, hashVersion, indexRows, options) {
  if (!Array.isArray(newIdentityHashSeq)) {
    throw new TypeError('checkPurposeRevisionCandidate requires an identity-hash sequence');
  }
  var rows = filterTransactionIndex_(customerId, hashVersion, indexRows || [], options);
  var byFile = Object.create(null);
  rows.forEach(function(row) {
    var fileId = String(row.fileId);
    if (!byFile[fileId]) {
      byFile[fileId] = [];
    }
    byFile[fileId].push(row);
  });
  var fileIds = Object.keys(byFile).sort();
  for (var fileIndex = 0; fileIndex < fileIds.length; fileIndex += 1) {
    var fileRows = byFile[fileIds[fileIndex]].slice().sort(function(left, right) {
      return Number(left.occurrenceIndex) - Number(right.occurrenceIndex);
    });
    var sequence = fileRows.map(function(row) { return row.identityHash; });
    var oldContentHash = fileRows.length ? fileRows[0].contentHash : null;
    if (identicalSequence_(sequence, newIdentityHashSeq) && String(oldContentHash) !== String(newContentHash)) {
      return {
        candidate: true,
        fileId: fileIds[fileIndex],
        matchedCount: sequence.length,
        code: 'PURPOSE_REVISION_CANDIDATE',
        hasImportedTransactions: fileRows.some(function(row) {
          return row.freeeImportStatus === FREEE_IMPORT_STATUS.IMPORTED;
        }),
        autoUpdate: false
      };
    }
  }
  return {candidate: false, fileId: null, matchedCount: 0, autoUpdate: false};
}

/**
 * 多重集合の積の件数を返す。これは警告用であり除外には用いない。
 */
function countPartialMatches(customerId, identityHashes, indexRows, hashVersion, options) {
  var rows = filterTransactionIndex_(customerId, hashVersion || VERSIONS.HASH, indexRows || [], options);
  var remaining = Object.create(null);
  rows.forEach(function(row) {
    var key = String(row.identityHash);
    remaining[key] = (remaining[key] || 0) + 1;
  });
  var count = 0;
  identityHashes.forEach(function(hash) {
    var key = String(hash);
    if (remaining[key] > 0) {
      count += 1;
      remaining[key] -= 1;
    }
  });
  return count;
}

/**
 * 処理済みファイル変更検出。保存値は純粋入力として注入する。
 */
function detectProcessedFileChange(fileId, currentRevision, currentBinaryHash, storedRecord) {
  var stored = storedRecord || {};
  if (stored.notFound === true) {
    return {changed: false, reason: 'FILE_NOT_FOUND'};
  }
  if (currentBinaryHash === null || currentBinaryHash === undefined) {
    return {changed: false, reason: null};
  }
  if (String(currentBinaryHash) === String(stored.binaryHash)) {
    return {changed: false, reason: null};
  }
  return {changed: true, reason: 'FILE_CHANGED'};
}

/** 行予約直前の再検査。 */
function guardFileUnchanged(fileId, expectedRevision, expectedBinaryHash, currentRecord) {
  var current = currentRecord || {};
  if (current.notFound === true) {
    return {ok: false, reason: 'FILE_NOT_FOUND', releaseReservedRows: true};
  }
  var revisionChanged = current.revisionId !== undefined && String(current.revisionId) !== String(expectedRevision);
  var hashChanged = current.binaryHash !== undefined && String(current.binaryHash) !== String(expectedBinaryHash);
  return revisionChanged || hashChanged ?
    {ok: false, reason: 'FILE_CHANGED', releaseReservedRows: true} :
    {ok: true, reason: null, releaseReservedRows: false};
}

/**
 * 取引同一性ハッシュの多重集合差分。
 */
function diffByIdentityHash(oldTxs, newTxs) {
  var oldRemaining = Object.create(null);
  oldTxs.forEach(function(tx) {
    var key = String(tx.identityHash);
    if (!oldRemaining[key]) oldRemaining[key] = [];
    oldRemaining[key].push(tx);
  });
  var added = [];
  newTxs.forEach(function(tx) {
    var key = String(tx.identityHash);
    if (oldRemaining[key] && oldRemaining[key].length) {
      oldRemaining[key].pop();
    } else {
      added.push(tx);
    }
  });
  var removed = [];
  Object.keys(oldRemaining).forEach(function(key) {
    removed = removed.concat(oldRemaining[key]);
  });
  var denominator = Math.max(oldTxs.length, newTxs.length, 1);
  return {added: added, removed: removed, ratio: (added.length + removed.length) / denominator};
}

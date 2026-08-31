'use strict';

/**
 * 4.8 ファイル検索。
 *
 * モード1（未処理検索）とモード2（処理済み変更の再走査）の**Drive側**を担う。
 * モード2の判定そのもの（絞込・変更検出・要確認起票）は`10_RescanManager`で
 * あり、本モジュールはメタ情報の一括取得とハッシュ計算だけを供給する。
 *
 * 登録済み判定の根拠は**恒久ファイルインデックスD列**である（INV-05）。
 * 処理ログはアーカイブ対象なので判定に使わない。
 */

var FILE_INDEX_WIDTH_SCANNER_ = 13;
var DRIVE_FOLDER_MIME_ = 'application/vnd.google-apps.folder';
var driveScannerCallCount_ = 0;

/** 4.37への計上材料。実行単位のDrive呼出回数。 */
function getDriveScannerCallCount() { return driveScannerCallCount_; }
function resetDriveScannerCallCount() { driveScannerCallCount_ = 0; }

/**
 * `Files.list`の1ページ取得。TRANSIENT_DRIVE_ERROR（429/500/503）は
 * 4.38のバックオフ算式で最大3回再試行する。
 */
function driveListPage_(query, pageToken) {
  var lastError = null;
  for (var attempt = 0; attempt <= 3; attempt += 1) {
    if (attempt > 0) {
      Utilities.sleep(computeBackoffMs(attempt));
    }
    try {
      driveScannerCallCount_ += 1;
      return Drive.Files.list({
        q: query,
        pageSize: 100,
        pageToken: pageToken || undefined,
        fields: 'nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, size, headRevisionId)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'allDrives'
      });
    } catch (error) {
      var code = Number(error && (error.code || (error.details && error.details.code)));
      if (code !== 429 && code !== 500 && code !== 503) throw error;
      lastError = error;
    }
  }
  throw makeCatalogError_('TRANSIENT_DRIVE_ERROR',
    'Drive list failed after retries: ' + (lastError && lastError.message));
}

/**
 * フォルダ配下を再帰的に列挙する。循環参照（ショートカット等）に備えて
 * 訪問済みフォルダを記録する。
 * @param {string} folderId
 * @return {!Array<!Object>} Driveメタ情報の配列
 */
function listFilesRecursively_(folderId) {
  var visited = Object.create(null);
  var queue = [String(folderId)];
  var found = [];
  while (queue.length) {
    var current = queue.shift();
    if (visited[current]) continue;
    visited[current] = true;
    var pageToken = null;
    do {
      var page = driveListPage_("'" + current + "' in parents and trashed = false", pageToken);
      (page.files || []).forEach(function(file) {
        if (file.mimeType === DRIVE_FOLDER_MIME_) {
          queue.push(String(file.id));
        } else {
          found.push(file);
        }
      });
      pageToken = page.nextPageToken || null;
    } while (pageToken);
  }
  return found;
}

/** 恒久ファイルインデックスを1回読んで行オブジェクトへ写す。 */
function permanentIndexRowsForScan_() {
  return readSheetRows_(permanentFileIndexSheet_(), FILE_INDEX_WIDTH_SCANNER_)
    .filter(function(row) { return String(row.values[0] || '') !== ''; })
    .map(function(row) {
      return {
        fileId: String(row.values[0]),
        customerId: String(row.values[1] || ''),
        originalFileName: String(row.values[2] || ''),
        state: String(row.values[3] || ''),
        binaryHash: String(row.values[4] || ''),
        contentHash: String(row.values[5] || ''),
        hashVersion: String(row.values[6] || ''),
        fileRevision: String(row.values[7] || ''),
        fileModifiedTime: row.values[8] || null,
        targetSheetName: String(row.values[12] || ''),
        _rowNumber: row.rowNumber
      };
    });
}

/**
 * モード1：未処理ファイル検索。
 *
 * フィルタ（4.8の表）：拡張子が.csv/.xlsx、内部状態が`DISCOVERED`または
 * 未登録、最終更新から10分以上経過。整列は仕様6.2
 * （`createdTime`昇順→ファイル名→ファイルID）。
 *
 * @param {string} customerId
 * @param {!Object=} options {now: 判定基準時刻（試験用）}
 * @return {!Array<!Object>} Candidate[]
 */
function scanUnprocessedFiles(customerId, options) {
  var customer = getCustomerById(customerId);
  if (!customer) throw new MasterDataError('Unknown customer: ' + customerId);
  var now = options && options.now ? new Date(options.now) : new Date();
  var stableBefore = now.getTime() - 10 * 60 * 1000;

  var stateByFileId = Object.create(null);
  permanentIndexRowsForScan_().forEach(function(row) {
    stateByFileId[row.fileId] = row.state;
  });

  var candidates = listFilesRecursively_(customer.sourceFolderId)
    .filter(function(file) {
      var lower = String(file.name || '').toLowerCase();
      if (!/\.(csv|xlsx)$/.test(lower)) return false;
      var state = stateByFileId[String(file.id)];
      if (state !== undefined && state !== FILE_STATE.DISCOVERED) return false;
      var modified = file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0;
      return modified <= stableBefore;
    })
    .map(function(file) {
      return {
        fileId: String(file.id),
        name: String(file.name || ''),
        mimeType: String(file.mimeType || ''),
        createdTime: file.createdTime || null,
        modifiedTime: file.modifiedTime || null,
        size: file.size === undefined ? null : Number(file.size),
        revisionId: file.headRevisionId || null,
        registered: stateByFileId[String(file.id)] !== undefined
      };
    });

  candidates.sort(function(a, b) {
    var createdA = a.createdTime ? new Date(a.createdTime).getTime() : 0;
    var createdB = b.createdTime ? new Date(b.createdTime).getTime() : 0;
    if (createdA !== createdB) return createdA - createdB;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.fileId < b.fileId ? -1 : (a.fileId > b.fileId ? 1 : 0);
  });

  // 事後条件：同一ファイルを2回含まない。
  var seen = Object.create(null);
  return candidates.filter(function(candidate) {
    if (seen[candidate.fileId]) return false;
    seen[candidate.fileId] = true;
    return true;
  });
}

/**
 * メタ情報の一括取得（INV-25：1件ずつ取得しない）。
 *
 * Drive APIはID集合での絞込クエリを持たないため、対象フォルダ配下を
 * ページングで一括列挙し、メモリ上で要求IDと突合する（4.8 モード2手順3の
 * 「メモリ上で突合する」に対応）。
 *
 * @param {!Array<string>} fileIds
 * @param {!Object} options {folderIds: 列挙対象フォルダID配列（必須）}
 * @return {!Object<string, !Object>} fileId → メタ情報
 */
function getFileMetadataBatch(fileIds, options) {
  if (!options || !Array.isArray(options.folderIds) || !options.folderIds.length) {
    throw new TypeError('getFileMetadataBatch requires options.folderIds to enumerate');
  }
  var wanted = Object.create(null);
  (fileIds || []).forEach(function(id) { wanted[String(id)] = true; });
  var metaById = Object.create(null);
  options.folderIds.forEach(function(folderId) {
    listFilesRecursively_(folderId).forEach(function(file) {
      if (!wanted[String(file.id)]) return;
      metaById[String(file.id)] = {
        id: String(file.id),
        name: String(file.name || ''),
        modifiedTime: file.modifiedTime || null,
        revisionId: file.headRevisionId || null,
        size: file.size === undefined ? null : Number(file.size)
      };
    });
  });
  return metaById;
}

/**
 * モード2：処理済みファイル変更の再走査プローブ（読取専用）。
 *
 * 内部状態を遷移させず、リースも取得しない。バイナリハッシュは
 * メタ情報が変化した対象についてのみ計算する（INV-24：`null`は「未取得」で
 * あって「不一致」ではない）。
 *
 * @param {string} customerId
 * @param {!Object=} options {now, hasUnimported}
 * @return {{probes:!Array<!Object>, consideredCount:number,
 *   scannedCount:number, deferredCount:number}}
 */
function scanProcessedFilesForChange(customerId, options) {
  var customer = getCustomerById(customerId);
  if (!customer) throw new MasterDataError('Unknown customer: ' + customerId);
  var opts = options || {};

  var indexRows = permanentIndexRowsForScan_().filter(function(row) {
    return row.customerId === String(customerId);
  });
  var selection = selectRescanTargets(indexRows, {
    now: opts.now,
    hasUnimported: opts.hasUnimported
  });
  var metaById = getFileMetadataBatch(
    selection.targets.map(function(row) { return row.fileId; }),
    {folderIds: [customer.sourceFolderId]}
  );
  var probes = detectRescanChanges(selection.targets, metaById, function(fileId) {
    return sha256Hex(DriveApp.getFileById(fileId).getBlob().getBytes());
  });
  return {
    probes: probes,
    consideredCount: selection.consideredCount,
    scannedCount: selection.targets.length,
    deferredCount: selection.deferred
  };
}

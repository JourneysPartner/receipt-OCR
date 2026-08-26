'use strict';

/**
 * 6.5 処理済みファイル変更の再走査（独立フロー）。
 *
 * 通常の処理ループでは到達できない。モード1は`DISCOVERED`または未登録しか
 * 候補にせず、`COMPLETED → VALIDATING`も遷移表に存在しないためである。
 * したがって**内部状態を遷移させない独立フロー**とする。
 *
 * 明示メニュー実行のみで起動する。通常処理の開始前に自動実行しない（INV-25）。
 * 運用2年後に20顧客×1,000ファイルとなると、絞込のない再走査は1回で
 * 20,000回のDrive API呼出になり、通常の取込が毎回クォータで止まる。
 */

/** 再走査の対象になり得る内部状態。行を確保済みのものを含む。 */
var RESCAN_TARGET_STATES_ = Object.freeze([
  FILE_STATE.COMPLETED, FILE_STATE.REVIEW_WAIT, FILE_STATE.WRITING, FILE_STATE.FAILED
]);

/**
 * 再走査対象を絞り込む（手順2）。
 *
 * 絞込は2つの条件のいずれかである。
 *   - 直近 RESCAN_TARGET_DAYS 日以内に更新された
 *   - freee未取込の有効取引を含む
 * さらに1回あたり RESCAN_MAX_FILES_PER_RUN 件を上限とする（INV-25）。
 *
 * @param {!Array<!Object>} indexRows 恒久ファイルインデックスの行
 * @param {!Object} options {now, targetDays, maxFiles, hasUnimported}
 */
function selectRescanTargets(indexRows, options) {
  options = options || {};
  var now = options.now ? new Date(options.now) : new Date();
  var targetDays = Number(options.targetDays || SETTINGS.RESCAN_TARGET_DAYS || 90);
  var maxFiles = Number(options.maxFiles || SETTINGS.RESCAN_MAX_FILES_PER_RUN || 200);
  var hasUnimported = typeof options.hasUnimported === 'function'
    ? options.hasUnimported
    : function() { return false; };
  var cutoff = now.getTime() - targetDays * 24 * 60 * 60 * 1000;

  var eligible = (indexRows || []).filter(function(row) {
    if (RESCAN_TARGET_STATES_.indexOf(String(row.state)) < 0) return false;
    var modified = row.fileModifiedTime ? new Date(row.fileModifiedTime).getTime() : 0;
    if (modified >= cutoff) return true;
    return hasUnimported(row.fileId) === true;
  });

  // 上限で切り捨てる場合、何件を次回へ回したかを必ず返す。
  // 黙って打ち切ると「全件見た」と読めてしまう。
  return {
    targets: eligible.slice(0, maxFiles),
    deferred: Math.max(0, eligible.length - maxFiles),
    consideredCount: (indexRows || []).length
  };
}

/**
 * 変更判定（手順4・5）。
 *
 * メタ情報が変わっていない対象はバイナリハッシュを計算せず`null`のままにする。
 * `null`は「未取得」であって「不一致」ではない（INV-24）。これを混同すると
 * **登録済み全ファイルに毎回`FILE_CHANGED`が起票される**。
 *
 * @param {!Array<!Object>} targets 恒久ファイルインデックスの行
 * @param {!Object} metaById `Files.list`で一括取得したメタ情報
 * @param {function(string):?string} computeHash 変化した対象だけに呼ぶ
 */
function detectRescanChanges(targets, metaById, computeHash) {
  var results = [];
  (targets || []).forEach(function(row) {
    var meta = metaById ? metaById[row.fileId] : null;
    if (!meta) {
      results.push({fileId: row.fileId, changed: false, reason: 'FILE_NOT_FOUND'});
      return;
    }
    var metaChanged = String(meta.modifiedTime || '') !== String(row.fileModifiedTime || '') ||
                      String(meta.revisionId || '') !== String(row.fileRevision || '');
    // 手順4：メタ情報が変わった対象だけハッシュを計算する。
    var currentHash = metaChanged && computeHash ? computeHash(row.fileId) : null;
    var verdict = detectProcessedFileChange(
      row.fileId, meta.revisionId, currentHash,
      {binaryHash: row.binaryHash, revision: row.fileRevision});
    results.push({
      fileId: row.fileId,
      changed: verdict.changed,
      reason: verdict.reason,
      metaChanged: metaChanged,
      hashComputed: currentHash !== null,
      before: {revision: row.fileRevision, binaryHash: row.binaryHash},
      after: {revision: meta.revisionId, binaryHash: currentHash}
    });
  });
  return results;
}

/**
 * 再走査を実行する（手順2〜6）。
 *
 * リースを取得せず、内部状態を遷移させない。処理ログのJ・K・L列も
 * 再処理時まで更新しない。変更を見つけたらファイル単位の抑止キーで
 * `FILE_CHANGED`要確認を起票するだけである。
 */
function runProcessedFileRescan(input) {
  if (!input || !input.customerId) {
    throw new TypeError('runProcessedFileRescan requires a customerId');
  }
  var selection = selectRescanTargets(input.indexRows, input.options);
  var detections = detectRescanChanges(selection.targets, input.metaById, input.computeHash);
  var registered = [];

  detections.filter(function(d) { return d.changed; }).forEach(function(d) {
    var outcome = registerReview({
      reviewType: REVIEW_TYPE.FILE_CHANGED,
      fileId: d.fileId,
      customerId: input.customerId,
      detail: {
        // キー名は2.1.7.1のとおりにする。4.26の解決操作
        // （`APPLY_FILE_DIFF`等）はここから旧リビジョンを読む。名前が違うと
        // `undefined`になり、差分計算が全件差分へ落ちて二重転記になる。
        // JSONなので取り違えても例外は出ない。
        kind: 'FILE_CHANGED',
        detectedAt: input.now || nowIso_(),
        oldRevision: d.before.revision, newRevision: d.after.revision,
        oldBinaryHash: d.before.binaryHash, newBinaryHash: d.after.binaryHash,
        hashVersion: d.hashVersion || VERSIONS.HASH
      }
    });
    if (outcome.registered) registered.push(outcome.reviewId);
  });

  return {
    consideredCount: selection.consideredCount,
    scannedCount: selection.targets.length,
    deferredCount: selection.deferred,
    changedCount: detections.filter(function(d) { return d.changed; }).length,
    registeredReviewIds: registered,
    detections: detections
  };
}

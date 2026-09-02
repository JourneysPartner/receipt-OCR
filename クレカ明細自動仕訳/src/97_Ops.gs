'use strict';

/**
 * エディタ運用の入口（貼り付け不要・プルダウン実行用）。
 *
 * 一時関数の貼り付け→保存は、clasp push後の古いタブから行うと**プロジェクト
 * 全体を古いコードで上書きする**（実機で2回起きた）。日常操作はここへ
 * 恒久関数として置き、エディタでは選んで実行するだけにする。
 */

/** 未解決の要確認を一覧する（読取のみ）。 */
function opsShowOpenReviews() {
  loadSettingsFromProperties();
  var reviews = openReviews({});
  Logger.log(JSON.stringify(reviews.map(function(review) {
    return {
      reviewId: review.reviewId,
      reviewType: review.reviewType,
      status: review.status,
      fileId: review.fileId,
      fileNameOriginal: review.fileNameOriginal,
      fullTxId: review.fullTxId,
      merchantOriginal: review.merchantOriginal,
      registeredAt: review.registeredAt
    };
  }), null, 2));
  return reviews;
}

/**
 * `DESTINATION_FIX`（転記先構成の不一致）を「直した」として閉じ、
 * 当該ファイルを発見からやり直させる。転記先または顧客マスターを
 * 修正した後に実行する。
 */
function opsRetryDestinationFix() {
  loadSettingsFromProperties();
  var targets = openReviews({}).filter(function(review) {
    return review.reviewType === REVIEW_TYPE.DESTINATION_FIX;
  });
  var results = [];
  targets.forEach(function(review) {
    var resolved = resolveFileReview(review.reviewId, 'CONFIRM_DESTINATION_FIXED',
      {role: 'SYSTEM_ADMIN'});
    // 再検査の自動再合流（6.2）は未結線なので、発見からやり直させる。
    // 事前検証は毎回全部やり直されるため、この巻戻しは安全である。
    updateProcessLog(review.fileId, {internalState: FILE_STATE.DISCOVERED});
    results.push({reviewId: review.reviewId, fileId: review.fileId,
      operation: resolved.operation});
  });
  Logger.log(JSON.stringify({retried: results.length, results: results}, null, 2));
  return results;
}

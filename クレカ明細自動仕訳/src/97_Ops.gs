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
 * パイロット顧客（TEST01）の登録・再登録。顧客IDで冪等に上書きする。
 *
 * 実物のfreee出納帳の構造（3行目ヘッダー・4行目仕切り・J列税込既定値・
 * N列残高数式）を反映した確定値。列対応を変えるときはここを直してpushする
 * ── エディタへの貼り付け・保存はプロジェクトを古いコードで上書きし得る
 * ため行わない。
 */
function opsRegisterPilotCustomer() {
  loadSettingsFromProperties();
  var result = registerTestCustomer({
    customerId: 'TEST01',
    customerName: 'テスト顧客',
    sourceFolderId: '1DW1GYXgSe4cRpyCzG51Kpdxwe9P9uX7O',
    destinationSpreadsheetId: '1A4Uyw_fsVQUafagdEPPKvL9s5NnnNytKloJfCsM2Vzo',
    destinationSheetName: '入力用シート',
    partnerListSheetName: '取引先一覧',
    columns: {B: 2, F: 6, I: 9, K: 11, M: 13, txId: 15},
    headerRow: 3,
    dataStartRow: 5,
    rowScanExcludedColumns: [10, 14],
    rowScanLastColumn: 15
  });
  // 書いた行を読み返して要点を確認する（登録の成否を推測にしない）。
  var customer = getCustomerById('TEST01');
  var report = {
    registered: result,
    readBack: {
      headerRow: customer.headerRow,
      rowScanExcludedColumns: customer.rowScanExcludedColumns,
      rowScanLastColumn: customer.rowScanLastColumn,
      txIdColumn: customer.columnMapping.txId
    }
  };
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/**
 * `FAILED`のファイルを発見からやり直させる（パイロット運用の簡易再開。
 * 6.2の再開フローが結線されるまでの代替）。
 */
function opsRetryFailedFiles() {
  loadSettingsFromProperties();
  var retried = [];
  permanentIndexRowsForScan_().forEach(function(row) {
    if (row.state !== FILE_STATE.FAILED) return;
    updateProcessLog(row.fileId, {internalState: FILE_STATE.DISCOVERED});
    retried.push(row.fileId);
  });
  Logger.log(JSON.stringify({retried: retried}, null, 2));
  return retried;
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

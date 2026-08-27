'use strict';

/**
 * 4.14 取引単位の妥当性判定と、実行単位の入力上限検査。
 *
 * ここが返す材料を`classifyValidationResult`が消費する。**転記先へ書き込まない。**
 */

/**
 * 取引単位の不備を判定する（5.10 の区分表）。
 *
 * `customerFix = true` を付けた不備は区分1（顧客が元ファイルを直す）になり、
 * ファイル全体が無書込で差し戻される。付けなければ区分3となり、行を確保して
 * 判明項目を書いたうえで当該項目だけを要確認にする。**この違いは顧客の
 * 手間に直結する**ので、1行の不備でファイル全体を突き返す判断は、その不備が
 * 本当に元ファイルを直さないと解消しない場合に限る。
 *
 * @param {!Array<!Object>} txs
 * @param {!Object} context
 *   cardFormat: 形式定義（`merchantOptional`のとき利用店名空欄を区分3にする）
 * @return {{issues: !Array<!Object>}}
 */
function validateTransactions(txs, context) {
  if (!Array.isArray(txs)) throw new TypeError('validateTransactions requires an array');
  context = context || {};
  var cardFormat = context.cardFormat || {};
  var issues = [];

  txs.forEach(function(tx) {
    var txId = tx.transactionId || tx.fullTxId || null;
    // 取引DTOは経路によって`merchantOriginal`（解析直後）と`originalMerchant`
    // （取引ログ）の両方の名前を持つ。片方しか見ないと、もう片方の経路では
    // 全取引が「利用店名なし」と誤判定され、ファイルが丸ごと顧客へ
    // 差し戻される。`matchPartner`（4.17）と同じ両対応にする。
    var merchant = tx.merchantOriginal === undefined ? tx.originalMerchant : tx.merchantOriginal;
    var amount = tx.amountBillingJpy === undefined ? tx.originalAmount : tx.amountBillingJpy;

    // 利用店名。原則として不足は顧客が直す不備（区分1）だが、形式固有の
    // ルール上は空欄が正当な場合がある（年会費行など）。その場合は区分3とし、
    // 行を確保して要確認だけを立てる。
    if (isBlankValue_(merchant)) {
      if (toBool(cardFormat.merchantOptional)) {
        issues.push({
          transactionId: txId, sourceRow: tx.sourceRow,
          reviewType: REVIEW_TYPE.PARTNER, code: 'MERCHANT_BLANK_ALLOWED',
          detail: {kind: 'MERCHANT', reason: 'FORMAT_ALLOWS_BLANK'}
        });
      } else {
        issues.push({
          transactionId: txId, sourceRow: tx.sourceRow,
          kind: 'MERCHANT_REQUIRED', customerFix: true,
          code: 'MERCHANT_REQUIRED',
          detail: {kind: 'MERCHANT', reason: 'REQUIRED'}
        });
      }
    }

    // 金額。読み取れない値と0円を区別する。
    //
    // 0円は不正ではない ── 全額値引きや無料キャンペーンで実際に起きる。
    // 計上するかどうかの業務判断が残るだけなので、行は書いて`ZERO_AMOUNT`の
    // 要確認を立てる。**取引を落とさない。**
    if (amount === null || amount === undefined || amount === '' ||
        !Number.isFinite(Number(amount))) {
      issues.push({
        transactionId: txId, sourceRow: tx.sourceRow,
        reviewType: REVIEW_TYPE.AMOUNT, code: 'AMOUNT_UNREADABLE',
        detail: {kind: 'AMOUNT', reason: 'UNREADABLE', raw: amount === undefined ? null : amount}
      });
    } else if (Number(amount) === 0) {
      issues.push({
        transactionId: txId, sourceRow: tx.sourceRow,
        reviewType: REVIEW_TYPE.ZERO_AMOUNT, code: 'ZERO_AMOUNT',
        detail: {kind: 'AMOUNT', reason: 'ZERO'}
      });
    }
  });

  return {issues: issues};
}

function isBlankValue_(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/**
 * 実行単位の累積候補明細数を検査する（4.14・4.31）。
 *
 * **永続化された値に対して検査する。** 実行内のメモリ上の数だけを見ると、
 * 継続トリガーで再開したときに0から数え直し、上限がいくらでも超えられる。
 *
 * 超過は区分2（`INPUT_LIMIT_EXCEEDED`）であり、**途中まで処理しない**。
 * 半分だけ転記された状態は、顧客にも担当者にも判別できない。
 */
function checkRunTransactionLimit(runId, additionalCount) {
  if (!runId) throw new TypeError('checkRunTransactionLimit requires a run id');
  var additional = Number(additionalCount);
  if (!Number.isInteger(additional) || additional < 0) {
    throw new TypeError('checkRunTransactionLimit requires a non-negative count');
  }
  var limit = Number(SETTINGS.MAX_TRANSACTIONS_PER_RUN);
  var cumulative = getRunCumulativeTransactionCount(runId) + additional;
  return {
    ok: !Number.isFinite(limit) || cumulative <= limit,
    cumulative: cumulative,
    limit: Number.isFinite(limit) ? limit : null
  };
}

'use strict';

/**
 * 転記先I列（メモタグ）の合成。
 *
 * I列の見出しは「メモタグ（複数指定可、カンマ区切り）」であり、使用用途を
 * 転記したうえで、明細の性質を表す印を足す。**用途は消さない** ── タグで
 * 上書きすると、何に使った支出かが帳簿から失われる。
 */

/** タグの語彙。順序を固定する（毎回入れ替わると差分が読めない）。 */
var MEMO_TAG_CASHBACK_ = 'キャッシュバック';
var MEMO_TAG_FOREIGN_ = '海外決済';

/**
 * 海外決済かどうか。
 *
 * 判定材料は2つある。形式が通貨・現地金額・換算レートの列を持つ場合は
 * そこから取れるが、**オリコ系は摘要そのものに「換算レート／」を埋める**
 * ため列が無い。片方だけを見ると、もう片方の形式を取りこぼす。
 */
function isForeignSettlement(tx) {
  if (!tx) return false;
  if (!isBlankValue_(tx.currencyOriginal)) return true;
  if (!isBlankValue_(tx.exchangeRate)) return true;
  var merchant = tx.merchantOriginal === undefined ? tx.originalMerchant : tx.merchantOriginal;
  if (isBlankValue_(merchant)) return false;
  // 目印そのものも同じ正規化を通す。`normalizeMerchant`は長音符をハイフンへ
  // 寄せるので、生の「換算レート」と突き合わせると永久に一致しない。
  return normalizeMerchant(merchant).indexOf(normalizeMerchant('換算レート')) >= 0;
}

/**
 * 当該取引に付けるタグを、決まった順序で返す。
 *
 * @param {!Object} tx
 * @param {!Object} customer
 * @return {!Array<string>}
 */
function memoTagsForTransaction(tx, customer) {
  var tags = [];
  var merchant = tx && (tx.merchantOriginal === undefined ?
    tx.originalMerchant : tx.merchantOriginal);
  if (isCashbackMerchant(customer, merchant)) tags.push(MEMO_TAG_CASHBACK_);
  if (isForeignSettlement(tx)) tags.push(MEMO_TAG_FOREIGN_);
  return tags;
}

/**
 * 使用用途とタグをI列の1つの値にする。
 *
 * 用途が空のときに先頭のカンマを残さないこと ── freeeはそれを空のタグとして
 * 読む。重複も落とす（用途そのものが「キャッシュバック」である場合がある）。
 *
 * @param {*} purpose
 * @param {!Array<string>} tags
 * @return {string}
 */
function composeMemoTags(purpose, tags) {
  var parts = [];
  var text = purpose === null || purpose === undefined ? '' : String(purpose).trim();
  if (text !== '') parts.push(text);
  (tags || []).forEach(function(tag) {
    var value = String(tag || '').trim();
    if (value === '') return;
    var duplicate = parts.some(function(existing) {
      return normalizeMerchant(existing) === normalizeMerchant(value);
    });
    if (!duplicate) parts.push(value);
  });
  return parts.join(',');
}

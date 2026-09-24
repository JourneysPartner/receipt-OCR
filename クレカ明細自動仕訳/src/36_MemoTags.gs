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
 * 取引先を特定できないまま確定した印（仕様 webapp §15 の 2）。
 *
 * 「取引先なしで確定」（取引先が要らない取引）と転記先で見分けるためにある。
 * どちらも F列は空欄なので、印が無いと後からシートを開いた人には「要らない」と
 * 「分からなかった」の区別が付かない。手作業では同じ語をメモ欄に書いて
 * 完了させていた。
 */
var MEMO_TAG_PARTNER_UNKNOWN_ = '取引先不明';

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

/**
 * 転記済みのI列の値へタグを1つ足す。同じタグが既にあれば値をそのまま返す。
 *
 * `composeMemoTags` は用途を1つの塊として比べるので、用途とタグをカンマで
 * つないだ既存の値へ使うと、同じタグが二重になる。ここでは区切ってから比べる。
 * 書いてある部分は並びも表記も変えない ── 足すのは末尾だけである。
 *
 * @param {*} current いまのI列の予定値
 * @param {string} tag
 * @return {string}
 */
function appendMemoTag(current, tag) {
  var text = current === null || current === undefined ? '' : String(current);
  var value = String(tag || '').trim();
  if (value === '') return text;
  var present = text.split(/[,，]/).some(function(part) {
    return normalizeMerchant(part) === normalizeMerchant(value);
  });
  if (present) return text;
  // 末尾の区切りを残したまま足すと、freee が空のタグとして読む。
  var base = text.replace(/[\s,，]+$/, '');
  return base === '' ? value : base + ',' + value;
}

/**
 * 取引先欄に入った語が「取引先不明」の印そのものか。
 *
 * 空白と全角・半角の違いは見ない。「取引先 不明」のような打ち方を取引先名と
 * して通すと、印ではなく実在しない取引先が F列と辞書に入る。
 */
function isPartnerUnknownLabel(value) {
  var squeezed = normalizeMerchant(value).replace(/ /g, '');
  return squeezed !== '' &&
    squeezed === normalizeMerchant(MEMO_TAG_PARTNER_UNKNOWN_).replace(/ /g, '');
}

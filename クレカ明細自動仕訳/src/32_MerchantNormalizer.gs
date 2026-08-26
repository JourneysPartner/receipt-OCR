'use strict';

/**
 * §4.16 / §5.7。照合専用の店名正規化。元表記は変更しない。
 * @param {*} original
 * @return {string}
 */
function normalizeMerchant(original) {
  if (original === null || original === undefined || original === '') {
    return '';
  }
  var normalized = String(original).normalize('NFKC').toUpperCase();
  normalized = normalized.replace(/[\u3000\t\r\n\f\v ]+/g, ' ');
  normalized = normalized.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u30FC\uFF0D\uFF70\u00AD]/g, '-');
  normalized = normalized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return normalized.trim();
}

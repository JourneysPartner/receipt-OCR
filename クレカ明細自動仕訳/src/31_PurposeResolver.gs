'use strict';

/** @param {!Object} rule @return {*} */
function purposeRuleEnabled_(rule) {
  return rule.enabled !== undefined ? rule.enabled : rule.active;
}

/**
 * 31は12章で90_Utilsへの依存を持たないため、読取DTOの境界でINV-02と
 * 同じ値集合を副作用なく正規化する。
 * @param {*} value
 * @return {boolean}
 */

/** @param {!Object} rule @return {string} */
function purposeRuleKeyword_(rule) {
  return String(rule.keyword !== undefined ? rule.keyword : rule.fileNameKeyword);
}

/** @param {!Object} rule @return {string} */
function purposeRuleValue_(rule) {
  return String(rule.purpose !== undefined ? rule.purpose : rule.complementPurpose);
}

/** @param {!Object} rule @return {string} */
function purposeRuleId_(rule) {
  return String(rule.id !== undefined ? rule.id : rule.ruleId);
}

/**
 * 元ファイル名へ部分一致する有効ルールだけを返す。
 * rulesはフェーズ1aの純粋ロジック入力であり、シート読取は行わない。
 * @param {string} fileNameOriginal
 * @param {!Array<!Object>} rules
 * @return {!Array<!Object>}
 */
function findMatchingRules(fileNameOriginal, rules) {
  if (typeof fileNameOriginal !== 'string' || !Array.isArray(rules)) {
    throw new TypeError('findMatchingRules requires an original file name and rules');
  }
  return rules.filter(function(rule) {
    return toBool(purposeRuleEnabled_(rule)) &&
      purposeRuleKeyword_(rule) !== '' &&
      fileNameOriginal.indexOf(purposeRuleKeyword_(rule)) !== -1;
  });
}

/**
 * §5.4に従い、空欄の使用用途だけを一意な値で補完する。
 * @param {!Array<!Object>} txs
 * @param {string} fileNameOriginal
 * @param {!Array<!Object>} rules
 * @return {{txs:!Array<!Object>, unresolvedCount:number}}
 */
function resolvePurposes(txs, fileNameOriginal, rules) {
  if (!Array.isArray(txs)) {
    throw new TypeError('resolvePurposes requires transactions');
  }
  var matches = findMatchingRules(fileNameOriginal, rules || []);
  var distinct = [];
  matches.forEach(function(rule) {
    var purpose = purposeRuleValue_(rule);
    if (distinct.indexOf(purpose) === -1) {
      distinct.push(purpose);
    }
  });
  var canInfer = distinct.length === 1;
  var ruleIds = matches.map(purposeRuleId_).join(',');
  var unresolved = 0;
  var output = txs.map(function(original) {
    var tx = Object.assign({}, original);
    if (tx.purpose !== null && tx.purpose !== undefined && tx.purpose !== '') {
      return tx;
    }
    if (canInfer) {
      tx.purpose = distinct[0];
      tx.purposeInferred = true;
      tx.purposeInferenceRuleId = ruleIds;
    } else {
      unresolved += 1;
    }
    return tx;
  });
  return {txs: output, unresolvedCount: unresolved};
}

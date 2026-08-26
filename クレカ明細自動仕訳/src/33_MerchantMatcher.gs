'use strict';

/** @param {*} value @return {number} */
function merchantPriority_(value) {
  var number = Number(value);
  return isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}

/** @param {!Object} rule @return {string} */
function merchantRuleId_(rule) {
  return String(rule.ruleId !== undefined ? rule.ruleId : rule.id);
}

/** @param {!Object} rule @return {string} */
function merchantOriginal_(rule) {
  return String(rule.original !== undefined ? rule.original : rule.merchantOriginal || '');
}

/** @param {!Object} rule @return {string} */
function merchantNormalized_(rule) {
  var stored = rule.normalized !== undefined ? rule.normalized : rule.merchantNormalized;
  return normalizeMerchant(stored === null || stored === undefined ? merchantOriginal_(rule) : stored);
}

/** @param {!Object} rule @return {string} */
function merchantPartner_(rule) {
  return String(rule.partnerName !== undefined ? rule.partnerName : rule.freeePartnerName || '');
}

/** @param {!Object} rule @return {string} */
function merchantMethod_(rule) {
  return String(rule.matchMethod !== undefined ? rule.matchMethod : rule.method || '');
}

/**
 * 辞書の有効期間を利用日で評価する。利用日未確定なら除外しない。
 * @param {!Object} rule
 * @param {?Date} usageDate
 * @return {boolean}
 */
function merchantRuleInPeriod_(rule, usageDate) {
  if (!usageDate) {
    return true;
  }
  var usage = toTokyoDateString_(usageDate);
  var from = rule.validFrom !== undefined ? rule.validFrom : rule.effectiveFrom;
  var to = rule.validTo !== undefined ? rule.validTo : rule.effectiveTo;
  var fromText = from === null || from === undefined || from === '' ? null :
    toTokyoDateString_(parseDate(from, SYSTEM_TIMEZONE));
  var toText = to === null || to === undefined || to === '' ? null :
    toTokyoDateString_(parseDate(to, SYSTEM_TIMEZONE));
  return (!fromText || fromText <= usage) && (!toText || usage <= toText);
}

/** @param {!Array<!Object>} rules @return {!Array<!Object>} */
function sortMerchantRules_(rules) {
  return rules.slice().sort(function(left, right) {
    var priorityDifference = merchantPriority_(left.priority) - merchantPriority_(right.priority);
    if (priorityDifference !== 0) {
      return priorityDifference;
    }
    return merchantRuleId_(left).localeCompare(merchantRuleId_(right));
  });
}

/** @param {!Array<!Object>} rules @return {!Array<!Object>} */
function merchantCandidates_(rules) {
  return sortMerchantRules_(rules).map(function(rule) {
    return {
      ruleId: merchantRuleId_(rule),
      partnerName: merchantPartner_(rule),
      priority: merchantPriority_(rule.priority),
      conflict: toBool(rule.conflict !== undefined ? rule.conflict : rule.conflictFlag)
    };
  });
}

/**
 * 固定行集合など、注入された辞書値から純粋なインデックスを作る。
 * @param {string} customerId
 * @param {!Object} source
 * @return {!Object}
 */
function buildDictionaryIndex(customerId, source) {
  if (!source || !Array.isArray(source.customer) || !Array.isArray(source.common)) {
    throw new TypeError('buildDictionaryIndex requires injected customer and common rows in phase 1b');
  }
  return {
    customer: source.customer.filter(function(rule) {
      var id = rule.customerId === undefined ? customerId : String(rule.customerId);
      return id === customerId;
    }).slice(),
    common: source.common.slice(),
    commonPartners: Array.isArray(source.commonPartners) ? source.commonPartners.slice() : []
  };
}

/**
 * §5.7の段階順で候補を返す。要確認の登録自体は行わない。
 * @param {!Object} tx
 * @param {string} customerId
 * @param {!Object} dictIndex
 * @return {!Object}
 */
function matchPartner(tx, customerId, dictIndex) {
  if (!tx || !dictIndex || !Array.isArray(dictIndex.customer) || !Array.isArray(dictIndex.common)) {
    throw new TypeError('matchPartner requires a transaction and dictionary index');
  }
  var original = String(tx.merchantOriginal === undefined ? tx.originalMerchant || '' : tx.merchantOriginal);
  var normalized = normalizeMerchant(original);
  var usageDate = tx.date || null;
  var excludedByPeriod = [];

  function eligible(rules) {
    return rules.filter(function(rule) {
      if (!toBool(rule.active !== undefined ? rule.active : rule.enabled)) {
        return false;
      }
      if (!merchantRuleInPeriod_(rule, usageDate)) {
        excludedByPeriod.push(merchantRuleId_(rule));
        return false;
      }
      return true;
    });
  }

  var customer = eligible(dictIndex.customer);
  var common = eligible(dictIndex.common);
  var selected = [];
  var matchedBy = null;

  selected = customer.filter(function(rule) { return merchantOriginal_(rule) === original; });
  if (selected.length) {
    matchedBy = 'STEP1';
  } else {
    selected = customer.filter(function(rule) { return merchantNormalized_(rule) === normalized; });
    if (selected.length) {
      matchedBy = 'STEP2';
    } else {
      selected = common.filter(function(rule) { return merchantOriginal_(rule) === original; });
      if (selected.length) {
        matchedBy = 'STEP3';
      } else {
        selected = common.filter(function(rule) { return merchantNormalized_(rule) === normalized; });
        if (selected.length) {
          matchedBy = 'STEP4';
        }
      }
    }
  }

  function approvedPatternMatches(rules, approvedOnly) {
    return rules.filter(function(rule) {
      var method = merchantMethod_(rule);
      if (method !== 'prefix' && method !== 'partial') {
        return false;
      }
      var approved = toBool(rule.approved);
      if (approvedOnly ? !approved : approved) {
        return false;
      }
      var pattern = merchantNormalized_(rule);
      return pattern !== '' && (method === 'prefix' ?
        normalized.indexOf(pattern) === 0 : normalized.indexOf(pattern) !== -1);
    });
  }

  if (!selected.length) {
    selected = approvedPatternMatches(customer, true);
    if (!selected.length) {
      selected = approvedPatternMatches(common, true);
    }
    if (selected.length) {
      matchedBy = 'STEP5';
    }
  }

  var suggestionOnly = false;
  if (!selected.length) {
    selected = approvedPatternMatches(customer, false);
    if (!selected.length) {
      selected = approvedPatternMatches(common, false);
    }
    suggestionOnly = selected.length > 0;
  }

  var candidates = merchantCandidates_(selected);
  var conflict = candidates.some(function(candidate) { return candidate.conflict; });
  var partnerNames = [];
  candidates.forEach(function(candidate) {
    if (partnerNames.indexOf(candidate.partnerName) === -1) {
      partnerNames.push(candidate.partnerName);
    }
  });
  var autoConfirm = !suggestionOnly && candidates.length > 0 && partnerNames.length === 1 && !conflict;
  return {
    partnerName: autoConfirm ? partnerNames[0] : null,
    matchedBy: matchedBy,
    matchedRuleId: autoConfirm ? candidates[0].ruleId : null,
    candidates: candidates,
    autoConfirm: autoConfirm,
    conflict: conflict,
    excludedByPeriod: excludedByPeriod,
    partnerResolutionStatus: autoConfirm ? PARTNER_STATUS.RESOLVED_WITH_PARTNER : PARTNER_STATUS.UNRESOLVED
  };
}

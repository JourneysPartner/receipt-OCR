'use strict';

/**
 * 相手科目コード（C 列）の第 1 段。
 *
 * 使用用途を用途科目辞書の言葉に当て、勘定科目一覧でコードを決める。決まった
 * 行だけを C に書く。決まらない行には触らない ── 誤った科目を書くより、
 * 空のまま担当者に渡すほうが安全である（仕様 §14）。
 */

var ACCOUNT_CATEGORY_ = Object.freeze({
  COMMON: '共通',
  INDIVIDUAL: '個人だけ',
  CORPORATE: '法人だけ'
});

var ACCOUNT_RESOLUTION_STATUS_ = Object.freeze({
  MATCHED: 'MATCHED',
  NO_MATCH: 'NO_MATCH',
  AMBIGUOUS: 'AMBIGUOUS',
  INVALID_ENTRY: 'INVALID_ENTRY',
  NOT_IN_SHEET_LIST: 'NOT_IN_SHEET_LIST'
});

/** 用途と辞書の言葉に共通のかぎ。空白はすべて落とす。 */
function usageWordKey_(value) {
  return partnerNameKey_(value).replace(/\s+/g, '');
}

/** マスターの科目コード。数と数字の文字だけを整数として読む。 */
function accountCodeValue_(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    var text = value.trim();
    if (!/^\d+$/.test(text)) return null;
    var number = Number(text);
    return Number.isInteger(number) && number > 0 ? number : null;
  }
  return null;
}

/** 有効・優先の 3 値。空は既定値、解釈できない値は null（誤り）。 */
function accountFlagValue_(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  if (value === true || value === 1 || value === 'TRUE' || value === 'true' || value === '1') return true;
  if (value === false || value === 0 || value === 'FALSE' || value === 'false' || value === '0') return false;
  return null;
}

function accountCategoryValue_(value) {
  var text = String(value === null || value === undefined ? '' : value).trim();
  return text === ACCOUNT_CATEGORY_.COMMON || text === ACCOUNT_CATEGORY_.INDIVIDUAL ||
    text === ACCOUNT_CATEGORY_.CORPORATE ? text : null;
}

function accountTextValue_(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

/**
 * 勘定科目一覧の行を読む（§3.1）。誤りの行も返す。
 * @param {!Array<!Array<*>>} values A2:E の値
 * @return {!Array<!Object>}
 */
function accountListRowsFromValues_(values) {
  var rows = [];
  (values || []).forEach(function(raw, index) {
    var row = raw || [];
    var code = accountCodeValue_(row[0]);
    var name = accountTextValue_(row[1]);
    var category = accountCategoryValue_(row[2]);
    var active = accountFlagValue_(row[3], true);
    var problems = [];
    if (code === null) problems.push('CODE_INVALID');
    if (!name) problems.push('NAME_EMPTY');
    if (category === null) problems.push('CATEGORY_INVALID');
    if (active === null) problems.push('ACTIVE_INVALID');
    rows.push({rowNumber: index + 2, code: code, name: name, category: category,
      active: active === true, valid: problems.length === 0, problems: problems});
  });
  // 同じコードが 2 行あれば、その 2 行とも誤りにする。どちらが正しいかを
  // 決める材料がこのシートには無い。
  var counts = Object.create(null);
  rows.forEach(function(row) {
    if (row.code !== null) counts[String(row.code)] = (counts[String(row.code)] || 0) + 1;
  });
  rows.forEach(function(row) {
    if (row.code !== null && counts[String(row.code)] > 1) {
      if (row.problems.indexOf('DUPLICATE_CODE') < 0) row.problems.push('DUPLICATE_CODE');
      row.valid = false;
    }
  });
  return rows;
}

/**
 * 用途科目辞書の行を読む（§3.2）。誤りの行も返す。
 * @param {!Array<!Array<*>>} values A2:I の値
 * @param {!Array<!Object>} accounts 勘定科目一覧の行
 * @return {!Array<!Object>}
 */
function accountWordRowsFromValues_(values, accounts) {
  var byCode = Object.create(null);
  (accounts || []).forEach(function(account) {
    if (account.valid && account.active) byCode[String(account.code)] = account;
  });
  var rows = [];
  (values || []).forEach(function(raw, index) {
    var row = raw || [];
    var word = accountTextValue_(row[0]);
    var key = usageWordKey_(word);
    var code = accountCodeValue_(row[1]);
    var category = accountCategoryValue_(row[2]);
    var customerId = accountTextValue_(row[3]);
    var priority = accountFlagValue_(row[4], false);
    var active = accountFlagValue_(row[5], true);
    var problems = [];
    // 言葉が空の行は当たらないので候補から外れるが、報告には残す。
    if (!key) problems.push('KEY_EMPTY');
    var account = code === null ? null : byCode[String(code)];
    if (!account) problems.push('ACCOUNT_NOT_FOUND');
    if (category === null) problems.push('CATEGORY_INVALID');
    if (priority === null) problems.push('PRIORITY_INVALID');
    if (active === null) problems.push('ACTIVE_INVALID');
    // 行の対象と科目の対象が合わない行は誤り（共通の行が個人だけの科目を
    // 指す、個人だけの行が法人だけの科目を指す、など）。
    if (account && category !== null && account.category !== ACCOUNT_CATEGORY_.COMMON &&
        category !== account.category) {
      problems.push('CATEGORY_MISMATCH');
    }
    // 有効は 3 値のまま持つ。読めない値（null）を false に丸めると、候補から
    // 外れてほかの言葉が勝ち、誤った科目が入る（§3.2）。
    rows.push({rowNumber: index + 2, word: word, key: key, code: code,
      category: category, customerId: customerId, priority: priority === true,
      active: active, valid: problems.length === 0, problems: problems});
  });
  return rows;
}

function accountMastersFromValues_(accountValues, wordValues) {
  var accounts = accountListRowsFromValues_(accountValues);
  return {accounts: accounts, words: accountWordRowsFromValues_(wordValues, accounts)};
}

function requireAccountSheet_(name) {
  var sheet = masterSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new MasterDataError('ACCOUNT_MASTER_MISSING: ' + name);
  return sheet;
}

/** 勘定科目一覧を 1 回の読取で読む。 */
function readAccountList_() {
  var sheet = requireAccountSheet_(CONFIG.SHEET_NAMES.ACCOUNT_LIST);
  return accountListRowsFromValues_(readSheetRows_(sheet, 5).map(function(row) {
    return row.values;
  }));
}

/** 用途科目辞書を 1 回の読取で読む。 */
function readUsageAccountDict_(accounts) {
  var sheet = requireAccountSheet_(CONFIG.SHEET_NAMES.USAGE_ACCOUNT_DICT);
  return accountWordRowsFromValues_(readSheetRows_(sheet, 9).map(function(row) {
    return row.values;
  }), accounts);
}

/** 1 回の実行の中では同じ表を使い回す（仕様 §7）。 */
function accountMastersForRun_() {
  if (runScopedReads_ && runScopedMasters_.accountMasters) {
    return runScopedMasters_.accountMasters;
  }
  var accounts = readAccountList_();
  var masters = {accounts: accounts, words: readUsageAccountDict_(accounts)};
  if (runScopedReads_) runScopedMasters_.accountMasters = masters;
  return masters;
}

/** 転記シートの科目一覧（§6）。1 回の batchGet で読む。一時的な誤りは読み直す。 */
function readDestinationAccountList_(spreadsheetId, sheetName, listRange) {
  var result = new Map();
  if (!listRange) return result;
  var values = destinationRangeValues_(spreadsheetId,
    quoteSheetName_(sheetName) + '!' + String(listRange), 'UNFORMATTED_VALUE');
  return accountListMapFromValues_(values);
}

/**
 * 転記シートの一覧を Map(コード → 科目名) にする。
 * 文字のコード・0・科目名の空・重複コードは入れない（VLOOKUP が当たらない）。
 */
function accountListMapFromValues_(values) {
  var result = new Map();
  var duplicates = Object.create(null);
  (values || []).forEach(function(row) {
    row = row || [];
    var code = row[0];
    var name = accountTextValue_(row[1]);
    if (typeof code !== 'number' || !Number.isInteger(code) || code <= 0 || !name) return;
    if (result.has(code)) {
      duplicates[String(code)] = true;
      return;
    }
    result.set(code, name);
  });
  Object.keys(duplicates).forEach(function(code) {
    result.delete(Number(code));
  });
  return result;
}

/** 転記先ごとに 1 回だけ読む。同じ実行の 2 本目は覚えた一覧を使う。 */
function destinationAccountListForRun_(customer) {
  if (!customer || !customer.columnMapping || !customer.columnMapping.C || !customer.accountListRange) {
    return null;
  }
  var key = String(customer.customerId) + '\u0000' + String(customer.destinationSpreadsheetId) +
    '\u0000' + String(customer.destinationSheetName) + '\u0000' + String(customer.accountListRange);
  if (runScopedReads_ && runScopedMasters_.accountSheetLists[key]) {
    return runScopedMasters_.accountSheetLists[key];
  }
  var list = readDestinationAccountList_(customer.destinationSpreadsheetId,
    customer.destinationSheetName, customer.accountListRange);
  if (runScopedReads_) runScopedMasters_.accountSheetLists[key] = list;
  return list;
}

function accountCustomerCategory_(customer) {
  return customer && customer.customerCategory === CUSTOMER_CATEGORY.INDIVIDUAL ?
    ACCOUNT_CATEGORY_.INDIVIDUAL : ACCOUNT_CATEGORY_.CORPORATE;
}

function accountRowEligibleForCustomer_(row, customer, customerCategory) {
  if (row.customerId) {
    if (String(row.customerId) !== String(customer.customerId || '')) return false;
  } else if (row.category !== ACCOUNT_CATEGORY_.COMMON &&
      row.category !== customerCategory && row.category !== null) {
    // 対象の値が不正な行は候補に残し、決勝で INVALID_ENTRY にする。
    return false;
  }
  return true;
}

function accountCategoryFitsCustomer_(accountCategory, customerCategory) {
  return accountCategory === ACCOUNT_CATEGORY_.COMMON || accountCategory === customerCategory;
}

function accountListName_(sheetList, code) {
  if (!sheetList) return null;
  if (typeof sheetList.get === 'function') {
    return sheetList.has(code) ? sheetList.get(code) : null;
  }
  var key = String(code);
  return Object.prototype.hasOwnProperty.call(sheetList, key) ? sheetList[key] : null;
}

/**
 * 使用用途から相手科目コードを決める（§4.2）。
 *
 * @param {*} purpose 取引の使用用途（メモタグを付ける前の文字）
 * @param {!Object} customer 顧客マスターの行
 * @param {!Object} masters {accounts, words}
 * @param {?Map<number,string>|?Object} sheetList 転記シートの科目一覧
 * @return {{status:string, code:?number, word:?string}}
 */
function resolveAccountCode_(purpose, customer, masters, sheetList) {
  var key = usageWordKey_(purpose);
  if (!key) return {status: ACCOUNT_RESOLUTION_STATUS_.NO_MATCH, code: null, word: null};

  var words = masters && masters.words || [];
  var customerCategory = accountCustomerCategory_(customer);
  var candidates = words.filter(function(row) {
    // 候補から外すのは有効がはっきり FALSE の行だけ。読めない値は候補に
    // 残し、当たったら誤りの行として INVALID_ENTRY にする（§3.2）。
    if (row.active === false || !row.key) return false;
    return accountRowEligibleForCustomer_(row, customer, customerCategory);
  });

  // 顧客別の行がある鍵は、その鍵の共通の行をすべて外す（顧客の言い方が勝つ）。
  var scopedKeys = Object.create(null);
  candidates.forEach(function(row) {
    if (row.customerId) scopedKeys[row.key] = true;
  });
  candidates = candidates.filter(function(row) {
    return Boolean(row.customerId) || !scopedKeys[row.key];
  });

  var hits = [];
  candidates.forEach(function(row) {
    var position = key.indexOf(row.key);
    if (position >= 0) hits.push({row: row, position: position});
  });
  if (!hits.length) return {status: ACCOUNT_RESOLUTION_STATUS_.NO_MATCH, code: null, word: null};

  // 当たりに誤りの行が 1 つでもあれば決めない（§4.2 手順 3）。優先の
  // 絞り込みより前に見る ── 優先の欄が壊れた私用の行が優先にならず、
  // 先頭の言葉が勝って誤った科目が入るのを防ぐ。
  if (hits.some(function(hit) { return hit.row.valid !== true; })) {
    return {status: ACCOUNT_RESOLUTION_STATUS_.INVALID_ENTRY, code: null, word: null};
  }

  // 私用系の言葉はどこにあっても優先する。
  var preferred = hits.filter(function(hit) { return hit.row.priority === true; });
  if (preferred.length) hits = preferred;

  var firstPosition = Math.min.apply(null, hits.map(function(hit) { return hit.position; }));
  hits = hits.filter(function(hit) { return hit.position === firstPosition; });
  var longest = Math.max.apply(null, hits.map(function(hit) { return hit.row.key.length; }));
  var finalists = hits.filter(function(hit) { return hit.row.key.length === longest; });

  var codes = [];
  finalists.forEach(function(hit) {
    if (codes.indexOf(hit.row.code) < 0) codes.push(hit.row.code);
  });
  if (codes.length !== 1) {
    return {status: ACCOUNT_RESOLUTION_STATUS_.AMBIGUOUS, code: null, word: null};
  }

  var code = codes[0];
  var accounts = masters && masters.accounts || [];
  var account = null;
  accounts.forEach(function(row) {
    if (row.code === code && row.valid && row.active) account = row;
  });
  if (!account || !accountCategoryFitsCustomer_(account.category, customerCategory)) {
    return {status: ACCOUNT_RESOLUTION_STATUS_.INVALID_ENTRY, code: null, word: null};
  }
  var sheetName = accountListName_(sheetList, code);
  if (sheetName === null ||
      normalizeMerchant(sheetName) !== normalizeMerchant(account.name)) {
    return {status: ACCOUNT_RESOLUTION_STATUS_.NOT_IN_SHEET_LIST, code: null, word: null};
  }
  return {status: ACCOUNT_RESOLUTION_STATUS_.MATCHED, code: code,
    word: finalists[0].row.word};
}

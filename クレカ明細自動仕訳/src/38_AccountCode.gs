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
  // 1.2：当て方は決まったが、転記シートの一覧にそのコードの行が無い（同じ
  // 科目名の行も無い）。一覧の空いた行へ足せば D の VLOOKUP が当たる。
  NEEDS_LIST_ENTRY: 'NEEDS_LIST_ENTRY',
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

/** 一覧の範囲（Q5:R49）を行・列に分ける。§5 の検査を通った値だけを渡す。 */
function accountListRangeParts_(listRange) {
  var match = /^([A-Z]{1,3})([1-9][0-9]*):([A-Z]{1,3})([1-9][0-9]*)$/.exec(String(listRange || ''));
  if (!match) return null;
  return {firstColumn: columnNumber_(match[1]), lastColumn: columnNumber_(match[3]),
    startRow: Number(match[2]), endRow: Number(match[4])};
}

/** 転記シートの科目一覧の生の値（§6）。1 回の batchGet。一時的な誤りは読み直す。 */
function readDestinationAccountListValues_(spreadsheetId, sheetName, listRange) {
  return destinationRangeValues_(spreadsheetId,
    quoteSheetName_(sheetName) + '!' + String(listRange), 'UNFORMATTED_VALUE');
}

/** 転記シートの科目一覧（§6・§23.3）。1 回の batchGet で読む。 */
function readDestinationAccountList_(spreadsheetId, sheetName, listRange) {
  if (!listRange) return new Map();
  return accountSheetListFromValues_(
    readDestinationAccountListValues_(spreadsheetId, sheetName, listRange), listRange);
}

/**
 * 転記シートの一覧を Map(コード → 科目名) にし、範囲の行ごとの生の値と行番号も
 * 持たせる（§23.3。ぶつかる行と空いた行を決めるため）。
 *
 * 表は範囲の全行ぶん作る。Sheets API は末尾の空行を返さないので、返ってきた
 * 値だけを行にすると「範囲の下に空いた行がある」ことを見失う。
 *
 * @param {!Array<!Array<*>>} values AS の範囲の値
 * @param {string} listRange AS の範囲（Q5:R49）
 * @return {!Map<number,string>}
 */
function accountSheetListFromValues_(values, listRange) {
  var list = accountListMapFromValues_(values);
  var parts = accountListRangeParts_(listRange);
  var startRow = parts ? parts.startRow : 2;
  var count = parts ? parts.endRow - parts.startRow + 1 : (values || []).length;
  var rows = [];
  for (var index = 0; index < count; index += 1) {
    var raw = (values || [])[index] || [];
    rows.push({rowNumber: startRow + index, code: raw[0],
      codeText: accountTextValue_(raw[0]), name: accountTextValue_(raw[1])});
  }
  list.listRange = parts;
  list.listRows = rows;
  return list;
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

/** 実行の中で一覧を覚えるときの鍵。転記先と範囲が同じなら同じ一覧である。 */
function destinationAccountListKey_(customer) {
  return String(customer.customerId) + '\u0000' + String(customer.destinationSpreadsheetId) +
    '\u0000' + String(customer.destinationSheetName) + '\u0000' + String(customer.accountListRange);
}

/** 転記先ごとに 1 回だけ読む。同じ実行の 2 本目は覚えた一覧を使う。 */
function destinationAccountListForRun_(customer) {
  if (!customer || !customer.columnMapping || !customer.columnMapping.C || !customer.accountListRange) {
    return null;
  }
  var key = destinationAccountListKey_(customer);
  if (runScopedReads_ && runScopedMasters_.accountSheetLists[key]) {
    return runScopedMasters_.accountSheetLists[key];
  }
  var list = readDestinationAccountList_(customer.destinationSpreadsheetId,
    customer.destinationSheetName, customer.accountListRange);
  if (runScopedReads_) runScopedMasters_.accountSheetLists[key] = list;
  return list;
}

/** 覚えている一覧を、足した後の内容に置き換える（§23.4）。 */
function rememberDestinationAccountList_(customer, list) {
  if (!runScopedReads_) return;
  runScopedMasters_.accountSheetLists[destinationAccountListKey_(customer)] = list;
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
 * 転記シートの一覧で、そのコードと科目名をどう扱うかを決める（§23.2 の 9）。
 *
 * ぶつかる行＝コードの欄を文字にして前後の空白を除いたものが同じ行、または
 * 科目名が `normalizeMerchant` で同じ行。コードの行（数）がちょうど 1 つで
 * 科目名も同じなら当たる。どちらの行も無ければ足せば当たる。それ以外は決め
 * ない（同じコードで名前が違う・同じコードが 2 行・コードの欄が文字の同じ
 * 数字・同じ名前でコードが違う）── D の VLOOKUP が別の科目を引くおそれがある。
 *
 * 表を持たない Map（1.1 の呼出し）は、コードと科目名がそろっているかだけを
 * 見る（足す判断に要る「ぶつかる行」が分からないため）。
 *
 * @return {{status:string, name:?string}}
 */
function accountListVerdict_(sheetList, code, name) {
  var status = ACCOUNT_RESOLUTION_STATUS_;
  if (!sheetList) return {status: status.NOT_IN_SHEET_LIST, name: null};
  if (!sheetList.listRows) {
    var listed = accountListName_(sheetList, code);
    return listed !== null && normalizeMerchant(listed) === normalizeMerchant(name) ?
      {status: status.MATCHED, name: null} : {status: status.NOT_IN_SHEET_LIST, name: null};
  }
  var codeText = String(code);
  var nameKey = normalizeMerchant(name);
  var codeRows = [];
  var textRows = [];
  var nameRows = [];
  sheetList.listRows.forEach(function(row) {
    var numeric = typeof row.code === 'number' && Number.isInteger(row.code) && row.code === code;
    if (numeric) codeRows.push(row);
    else if (row.codeText === codeText) textRows.push(row);
    if (row.name && normalizeMerchant(row.name) === nameKey) nameRows.push(row);
  });
  // 文字の同じ数字の行は VLOOKUP が当たらないうえ、数で足すと同じコードが
  // 2 行になる。コードの行がちょうど 1 つ（数）で、科目名も同じときだけ当たる。
  if (codeRows.length === 1 && !textRows.length &&
      normalizeMerchant(codeRows[0].name) === nameKey) {
    return {status: status.MATCHED, name: null};
  }
  if (!codeRows.length && !textRows.length && !nameRows.length) {
    return {status: status.NEEDS_LIST_ENTRY, name: name};
  }
  return {status: status.NOT_IN_SHEET_LIST, name: null};
}

/** 一覧の「正しいコードの行」か（§23.3。0 より大きい整数の数で、科目名がある）。 */
function accountListCodeRow_(row) {
  return typeof row.code === 'number' && Number.isInteger(row.code) && row.code > 0 &&
    Boolean(row.name);
}

/** コードの欄も科目名の欄も空の行か。 */
function accountListRowEmpty_(row) {
  return !row.codeText && !row.name;
}

/**
 * 一覧の空いた行（§23.3）。最後の正しいコードの行より下で、コードも科目名も
 * 空の行。下に値のある行（合計など）があれば、そこから下は空いた行にしない。
 * 正しいコードの行が 1 つも無ければ足さない（`LIST_FULL` と同じ扱い）。
 * @return {!Array<number>}
 */
function accountListFreeRows_(list) {
  var rows = list && list.listRows || [];
  var last = -1;
  rows.forEach(function(row, index) {
    if (accountListCodeRow_(row)) last = index;
  });
  if (last < 0) return [];
  var free = [];
  for (var index = last + 1; index < rows.length; index += 1) {
    if (!accountListRowEmpty_(rows[index])) break;
    free.push(rows[index].rowNumber);
  }
  return free;
}

/** 読み直した一覧の値に、書き足した行の読み戻しを重ねた値を作る。 */
function accountListValuesWithRows_(values, parts, rows) {
  var result = (values || []).slice();
  rows.forEach(function(item) {
    var index = item.row - parts.startRow;
    if (index < 0) return;
    result[index] = item.values.slice();
  });
  return result;
}

/**
 * NEEDS_LIST_ENTRY のコードを、転記シートの科目一覧の空いた行へ書き足す
 * （§23.4）。足すものが無ければ何もしない（読取も書込もしない）。
 *
 * 足すときはロックの中で一覧を読み直し、ぶつかる行と空いた行を決め直す ──
 * 同時の取込が足した行を上書きしないため（§23.7-14）。書いた後は読み戻して
 * 確かめ、違えばそのコードは足せなかったものとして扱う（書いた値は戻さない）。
 * 読む・書くのは一覧の範囲の中だけである（§23.7-13）。
 *
 * @param {!Object} customer 顧客マスターの行
 * @param {string} fileId 取込のファイル ID
 * @param {string} leaseId 取込のリース
 * @param {!Array<{code:number, name:string}>} entries 足す候補（コードごとに 1 つ）
 * @return {{added:!Array<!Object>, matched:!Array<number>, failed:!Array<number>}}
 *   `added` は書き足して読み戻しでも確かめられた行、`matched` は誰かが先に
 *   足していたコード、`failed` は足せなかったコード。
 */
function appendAccountListEntries_(customer, fileId, leaseId, entries) {
  var result = {added: [], matched: [], failed: []};
  var wanted = (entries || []).filter(function(entry) {
    return entry && Number.isInteger(entry.code) && entry.code > 0 && entry.name;
  });
  if (!wanted.length) return result;
  var listRange = customer.accountListRange;
  var parts = accountListRangeParts_(listRange);
  if (!parts) {
    result.failed = wanted.map(function(entry) { return entry.code; });
    return result;
  }
  var written = [];
  try {
    withScriptLock_(function() {
      assertLeaseHeldForWrite(fileId, leaseId);
      var reread = readDestinationAccountListValues_(customer.destinationSpreadsheetId,
        customer.destinationSheetName, listRange);
      var list = accountSheetListFromValues_(reread, listRange);
      var queue = wanted.filter(function(entry) {
        var verdict = accountListVerdict_(list, entry.code, entry.name);
        if (verdict.status === ACCOUNT_RESOLUTION_STATUS_.MATCHED) {
          result.matched.push(entry.code);
          return false;
        }
        if (verdict.status === ACCOUNT_RESOLUTION_STATUS_.NEEDS_LIST_ENTRY) return true;
        result.failed.push(entry.code);
        return false;
      });
      var freeRows = accountListFreeRows_(list);
      var plan = [];
      queue.forEach(function(entry) {
        // 空いた行が足りなければ、入らなかったコードは足さない（§23.7-15）。
        if (plan.length >= freeRows.length) {
          result.failed.push(entry.code);
          return;
        }
        plan.push({row: freeRows[plan.length], code: entry.code, name: entry.name});
      });
      if (!plan.length) return;
      var sheetName = customer.destinationSheetName;
      Sheets.Spreadsheets.Values.batchUpdate({valueInputOption: 'RAW',
        data: plan.map(function(item) {
          return {range: a1Range_(sheetName, item.row, parts.firstColumn, parts.lastColumn),
            values: [[item.code, item.name]]};
        })}, customer.destinationSpreadsheetId);
      // 読み戻して、書いた行のコードと科目名が書いたとおりかを見る。
      var firstRow = plan[0].row;
      var lastRow = plan[plan.length - 1].row;
      var readBack = destinationRangeValues_(customer.destinationSpreadsheetId,
        quoteSheetName_(sheetName) + '!' + columnLetter_(parts.firstColumn) + firstRow + ':' +
        columnLetter_(parts.lastColumn) + lastRow, 'UNFORMATTED_VALUE');
      plan.forEach(function(item) {
        var rowValues = readBack[item.row - firstRow] || [];
        if (rowValues[0] === item.code && accountTextValue_(rowValues[1]) === item.name) {
          result.added.push(item);
        } else {
          // 読み戻しが違う時点で何が起きたか分からない。書いた値は戻さず、
          // そのコードは足せなかったものとして扱う（§23.4-4）。
          result.failed.push(item.code);
        }
        written.push({row: item.row, values: rowValues});
      });
      // 同じ実行の次のファイルは読み直さない・足し直さない（§23.4）。
      rememberDestinationAccountList_(customer, accountSheetListFromValues_(
        accountListValuesWithRows_(reread, parts, written), listRange));
    });
  } catch (error) {
    // リースを失った実行は書かない。取込のほかの書込も同じく止まる。
    if (!(error && error.code === 'LEASE_CONFLICT')) throw error;
    result.matched = [];
    result.added = [];
    result.failed = wanted.map(function(entry) { return entry.code; });
    return result;
  }
  if (result.added.length) {
    try {
      appendAudit({type: 'SETTING', actor: activeUserEmail_(),
        targetType: 'DESTINATION', targetId: String(customer.destinationSpreadsheetId),
        customerId: customer.customerId,
        after: {rows: result.added.map(function(item) {
          return {row: item.row, code: item.code, name: item.name};
        })}, reason: 'ACCOUNT_LIST_APPEND'});
    } catch (error) {
      // 転記先はもう変わっている。ここで投げると取込だけが失敗して足した行は
      // 残るので、記録できなかったことをログに残して続ける。
      Logger.log('ACCOUNT_LIST_APPEND_AUDIT_NOT_RECORDED ' + JSON.stringify({
        fileId: String(fileId),
        code: String((error && error.code) || (error && error.name) || 'Error')}));
    }
  }
  return result;
}

/**
 * 使用用途から相手科目コードを決める（§4.2）。
 *
 * @param {*} purpose 取引の使用用途（メモタグを付ける前の文字）
 * @param {!Object} customer 顧客マスターの行
 * @param {!Object} masters {accounts, words}
 * @param {?Map<number,string>|?Object} sheetList 転記シートの科目一覧
 * @return {{status:string, code:?number, word:?string, name:?string}}
 *   `NEEDS_LIST_ENTRY` のときだけ `code` と `name`（科目一覧の科目名）が入る。
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
  var verdict = accountListVerdict_(sheetList, code, account.name);
  if (verdict.status === ACCOUNT_RESOLUTION_STATUS_.NEEDS_LIST_ENTRY) {
    // 当て方は決まった。あとは一覧に足せば D の VLOOKUP が当たる（§23.2）。
    return {status: verdict.status, code: code, word: finalists[0].row.word,
      name: account.name};
  }
  if (verdict.status !== ACCOUNT_RESOLUTION_STATUS_.MATCHED) {
    return {status: ACCOUNT_RESOLUTION_STATUS_.NOT_IN_SHEET_LIST, code: null, word: null};
  }
  return {status: ACCOUNT_RESOLUTION_STATUS_.MATCHED, code: code,
    word: finalists[0].row.word};
}

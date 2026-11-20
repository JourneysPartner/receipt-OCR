'use strict';

/**
 * 相手税区分（G 列）の第 1 段（`work/spec_tax_category.md` 版 1.0）。
 *
 * §3 の決め方の表・§4 のマスターの 2 つの表の読み方・§5 の決め方を持つ。
 * ここにある関数はすべて純粋である（シート・ファイル・ロック・ログを使わ
 * ない）。表を読むのは呼ぶ側で、このファイルは値を受け取って決めるだけ。
 */

/** 科目ごとの税区分の種類（§3.1）。 */
const TAX_KIND_ = Object.freeze({
  PURCHASE: '課対仕入',
  NON_TAXABLE: '非課仕入',
  OUT_OF_SCOPE: '対象外'
});

/** 取引先の印（§4.1）。 */
const TAX_MARK_ = Object.freeze({
  FLEA: 'フリマ',
  OVERSEAS_GOODS: '海外の物',
  OVERSEAS_SERVICE: '海外のサービス',
  NONE: 'なし'
});

/** 印として読める 4 つの値（§4.1。この順）。 */
const TAX_MARK_VALUES_ = Object.freeze([
  TAX_MARK_.FLEA, TAX_MARK_.OVERSEAS_GOODS, TAX_MARK_.OVERSEAS_SERVICE, TAX_MARK_.NONE
]);

/** 印の候補に誤りの行があるときの戻り値（§4.1 の 4）。 */
const TAX_MARK_INVALID_ = 'MARK_INVALID';

/** 顧客の「少額特例を使えない」の 3 値（§4.2）。 */
const TAX_CUSTOMER_FLAG_ = Object.freeze({
  USABLE: 'USABLE',
  UNUSABLE: 'UNUSABLE',
  INVALID: 'CUSTOMER_FLAG_INVALID'
});

/** 決め方の結果の状態（§5）。 */
const TAX_STATUS_ = Object.freeze({DECIDED: 'DECIDED', UNDECIDED: 'UNDECIDED'});

/**
 * 「取引先の税の印」の見出し（§4.3。この順・この文字）。
 * 見出しより右の列は見ない。
 */
const TAX_PARTNER_MARKS_HEADERS_ = Object.freeze([
  '取引先名', '印', '顧客ID', '有効', '登録日時', '登録者', 'メモ'
]);

/** 「顧客の税の設定」の見出し（§4.3。この順・この文字）。 */
const TAX_CUSTOMER_FLAGS_HEADERS_ = Object.freeze([
  '顧客ID', '少額特例を使えない', '更新日時', '更新者', 'メモ'
]);

/**
 * 科目 → 税区分の種類（§3.1。利用者の決定 2026-11-18）。
 *
 * 表に無いコードは「決めない」（G を空にする）。`exceptions` は §5 の例外
 * （取引先の印・少額特例）を当てるか。`true` は種類が課対仕入の行だけ。
 * 売上高（612）・雑収入（914）は「決めない」なので入れない。
 */
const TAX_ACCOUNT_RULES_ = Object.freeze([
  Object.freeze({code: 712, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 837, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 841, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 842, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 843, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 844, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 846, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 848, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 849, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 851, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 852, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 854, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 856, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 857, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 858, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 859, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 861, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 863, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 864, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 865, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 866, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 869, kind: TAX_KIND_.PURCHASE, exceptions: true}),
  Object.freeze({code: 847, kind: TAX_KIND_.NON_TAXABLE, exceptions: false}),
  Object.freeze({code: 921, kind: TAX_KIND_.NON_TAXABLE, exceptions: false}),
  Object.freeze({code: 836, kind: TAX_KIND_.NON_TAXABLE, exceptions: false}),
  Object.freeze({code: 294, kind: TAX_KIND_.OUT_OF_SCOPE, exceptions: false}),
  Object.freeze({code: 362, kind: TAX_KIND_.OUT_OF_SCOPE, exceptions: false}),
  Object.freeze({code: 853, kind: TAX_KIND_.OUT_OF_SCOPE, exceptions: false}),
  Object.freeze({code: 152, kind: TAX_KIND_.OUT_OF_SCOPE, exceptions: false}),
  Object.freeze({code: 183, kind: TAX_KIND_.OUT_OF_SCOPE, exceptions: false}),
  Object.freeze({code: 312, kind: TAX_KIND_.OUT_OF_SCOPE, exceptions: false}),
  Object.freeze({code: 314, kind: TAX_KIND_.OUT_OF_SCOPE, exceptions: false}),
  Object.freeze({code: 318, kind: TAX_KIND_.OUT_OF_SCOPE, exceptions: false}),
  Object.freeze({code: 832, kind: TAX_KIND_.OUT_OF_SCOPE, exceptions: false}),
  Object.freeze({code: 834, kind: TAX_KIND_.OUT_OF_SCOPE, exceptions: false}),
  Object.freeze({code: 845, kind: TAX_KIND_.OUT_OF_SCOPE, exceptions: false}),
  Object.freeze({code: 941, kind: TAX_KIND_.OUT_OF_SCOPE, exceptions: false})
]);

/**
 * 率（§3.2）。利用日がその率の期間（両端を含む）にちょうど 1 つ当たれば、
 * その末尾を付ける。改正は、今の行の終わりを前日にし、新しい行を足す。
 */
const TAX_RATE_PERIODS_ = Object.freeze([
  Object.freeze({rate: 'STANDARD', suffix: '10%', from: '2019-10-01', to: null}),
  Object.freeze({rate: 'REDUCED', suffix: '8%（軽）', from: '2019-10-01', to: '2027-03-31'})
]);

/** 軽減 8% の言葉（§3.3。利用者の決定 2026-11-18）。 */
const TAX_REDUCED_WORDS_ = Object.freeze(['食品', '食材', '食料品', '食料']);

/** 軽減にしない言葉（§3.3）。 */
const TAX_REDUCED_EXCLUDE_WORDS_ = Object.freeze([
  '酒', 'アルコール', 'ビール', 'ワイン', '外食', 'イートイン'
]);

/** G を決めない言葉（§3.3。課対仕入の行だけに当てる）。 */
const TAX_UNDECIDED_WORDS_ = Object.freeze(['消費税', 'リボ', '分割']);

/** 少額特例（§3.4。税込 1 万円未満。絶対値で見る）。 */
const TAX_SMALL_AMOUNT_ = Object.freeze({
  from: '2023-10-01',
  to: '2029-09-30',
  limit: 10000
});

/**
 * G を空にできる顧客か（§2.3 の 1・§7。純粋な関数）。
 *
 * `columnMapping.G` が 1 以上の整数で、`rowScanExcludedColumns`（AL 列）に
 * 入っていないことだけを見る。表の有る無し・C の有る無しには関係しない。
 *
 * @param {*} customer
 * @return {boolean}
 */
function taxColumnClearable_(customer) {
  var mapping = customer && customer.columnMapping ? customer.columnMapping : null;
  if (!mapping) return false;
  var column = Number(mapping.G);
  if (!Number.isInteger(column) || column < 1) return false;
  var excluded = (customer.rowScanExcludedColumns || []).map(Number);
  return excluded.indexOf(column) < 0;
}

/**
 * 本仕様が効く顧客か（§2.3。純粋な関数）。
 *
 * G を空にできる（§2.3 の 1）うえで、`columnMapping.C` が 1 以上の整数で
 * `accountListRange` が空でない（§2.3 の 2）こと。マスターの 2 つの表の
 * 有る無しはここでは見ない（表が無ければ取込は今のままに動く）。
 *
 * @param {*} customer
 * @return {boolean}
 */
function taxCategoryConfigured_(customer) {
  if (!taxColumnClearable_(customer)) return false;
  var mapping = customer.columnMapping || {};
  var codeColumn = Number(mapping.C);
  if (!Number.isInteger(codeColumn) || codeColumn < 1) return false;
  return accountTextValue_(customer.accountListRange) !== '';
}

/** 見出しの比較用。無いセルは `''`。空白は外さない（§4.3）。 */
function taxHeaderText_(value) {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * 表の 1 行を、表の幅にそろえた配列にする。呼ぶ側は、`taxTablesFromValues_`
 * が返す `{rowNumber, values}` の行と、セルの配列のどちらを渡してもよい。
 *
 * @param {*} row
 * @param {number} width
 * @return {!Array<*>}
 */
function taxRowValues_(row, width) {
  if (Array.isArray(row)) return padRowValues_(row, width);
  if (row && Array.isArray(row.values)) return padRowValues_(row.values, width);
  return padRowValues_([], width);
}

/** 表の幅の中のセルが全部空の行（§4.3。空白だけの文字も空）。 */
function taxRowIsEmpty_(values) {
  return values.every(function(value) {
    if (value === undefined || value === null) return true;
    return typeof value === 'string' && value.trim() === '';
  });
}

/** 1 行目の見出しが、この順・この文字で完全に一致するか（§4.3）。 */
function taxHeaderMatches_(header, headers) {
  if (!Array.isArray(header) || header.length < headers.length) return false;
  for (var index = 0; index < headers.length; index += 1) {
    if (taxHeaderText_(header[index]) !== headers[index]) return false;
  }
  return true;
}

/**
 * A1:? の値から、2 行目から下の行を読む。見出しが違う・値が無いタブは
 * `null`（タブが無いのと同じ）。空の行は飛ばす。
 *
 * @param {*} values
 * @param {!Array<string>} headers
 * @return {?Array<!Object>}
 */
function taxTableRows_(values, headers) {
  var rows = Array.isArray(values) ? values : [];
  if (!rows.length) return null;
  if (!taxHeaderMatches_(rows[0], headers)) return null;
  var result = [];
  for (var index = 1; index < rows.length; index += 1) {
    var padded = taxRowValues_(rows[index], headers.length);
    if (taxRowIsEmpty_(padded)) continue;
    result.push({rowNumber: index + 1, values: padded});
  }
  return result;
}

/**
 * マスターの 2 つの表の値から `{present, marks, flags}` を作る（§4.3）。
 * タブが無いときは呼ぶ側が `null` を渡す。どちらかが見出しと違えば
 * `present: false`（中身は空）。
 *
 * @param {?Array<!Array<*>>} markValues 「取引先の税の印」の A1:G
 * @param {?Array<!Array<*>>} flagValues 「顧客の税の設定」の A1:E
 * @return {!Object}
 */
function taxTablesFromValues_(markValues, flagValues) {
  var marks = taxTableRows_(markValues, TAX_PARTNER_MARKS_HEADERS_);
  var flags = taxTableRows_(flagValues, TAX_CUSTOMER_FLAGS_HEADERS_);
  if (!marks || !flags) return {present: false, marks: [], flags: []};
  return {present: true, marks: marks, flags: flags};
}

/**
 * 取引先の印を引く（§4.1。純粋な関数）。
 *
 * 1. 取引先名の鍵が空なら `なし`。
 * 2. 鍵が同じで、有効がはっきり `FALSE` でない行のうち、顧客 ID が空か
 *    同じ行が候補（読めない値は候補に残す）。
 * 3. 顧客別の行が 1 つでもあれば、共通の行を外す（顧客別の印が勝つ）。
 * 4. 候補が無ければ `なし`。候補に誤りの行が 1 つでもあれば
 *    `MARK_INVALID`。候補の印が 2 種類以上なら `MARK_INVALID`。
 *
 * @param {*} partnerName 取引先名
 * @param {*} customerId 顧客 ID（空でもよい）
 * @param {*} rows `tables.marks`
 * @return {string} 印 4 つのどれか、または `MARK_INVALID`
 */
function taxPartnerMark_(partnerName, customerId, rows) {
  var key = partnerNameKey_(partnerName);
  if (!key) return TAX_MARK_.NONE;
  var wantedCustomerId = accountTextValue_(customerId);
  var groups = {
    own: {count: 0, invalid: false, marks: []},
    common: {count: 0, invalid: false, marks: []}
  };
  (Array.isArray(rows) ? rows : []).forEach(function(row) {
    var values = taxRowValues_(row, TAX_PARTNER_MARKS_HEADERS_.length);
    if (partnerNameKey_(values[0]) !== key) return;
    var active = accountFlagValue_(values[3], true);
    if (active === false) return;
    var rowCustomerId = accountTextValue_(values[2]);
    if (rowCustomerId && rowCustomerId !== wantedCustomerId) return;
    var mark = accountTextValue_(values[1]);
    var group = rowCustomerId ? groups.own : groups.common;
    group.count += 1;
    if (active === null || TAX_MARK_VALUES_.indexOf(mark) < 0) {
      group.invalid = true;
    } else {
      group.marks.push(mark);
    }
  });
  var candidates = groups.own.count ? groups.own : groups.common;
  if (!candidates.count) return TAX_MARK_.NONE;
  if (candidates.invalid) return TAX_MARK_INVALID_;
  var distinct = [];
  candidates.marks.forEach(function(mark) {
    if (distinct.indexOf(mark) < 0) distinct.push(mark);
  });
  return distinct.length === 1 ? distinct[0] : TAX_MARK_INVALID_;
}

/**
 * 顧客の「少額特例を使えない」を引く（§4.2。純粋な関数）。
 *
 * その顧客の行が無ければ「使える」。2 行以上、または値が 3 値のどれでも
 * なければ `CUSTOMER_FLAG_INVALID`。顧客 ID が空のときも
 * `CUSTOMER_FLAG_INVALID`（顧客が決まらないと、その顧客の設定は引けない）。
 * A が空の行は、どの顧客にも当たらない。
 *
 * @param {*} customerId 顧客 ID
 * @param {*} rows `tables.flags`
 * @return {string} `USABLE`・`UNUSABLE`・`CUSTOMER_FLAG_INVALID`
 */
function taxCustomerFlag_(customerId, rows) {
  var wantedCustomerId = accountTextValue_(customerId);
  if (!wantedCustomerId) return TAX_CUSTOMER_FLAG_.INVALID;
  var matches = [];
  (Array.isArray(rows) ? rows : []).forEach(function(row) {
    var values = taxRowValues_(row, TAX_CUSTOMER_FLAGS_HEADERS_.length);
    var rowCustomerId = accountTextValue_(values[0]);
    if (!rowCustomerId || rowCustomerId !== wantedCustomerId) return;
    matches.push(values);
  });
  if (!matches.length) return TAX_CUSTOMER_FLAG_.USABLE;
  if (matches.length > 1) return TAX_CUSTOMER_FLAG_.INVALID;
  var unusable = accountFlagValue_(matches[0][1], false);
  if (unusable === null) return TAX_CUSTOMER_FLAG_.INVALID;
  return unusable ? TAX_CUSTOMER_FLAG_.UNUSABLE : TAX_CUSTOMER_FLAG_.USABLE;
}

/**
 * 利用日を `yyyy-MM-dd` にする（決めたこと 1）。
 *
 * 読むのは `yyyy-MM-dd` と `yyyy/MM/dd` の文字（前後の空白は外す）、または
 * `Date`（東京の日付）。暦に無い日・読めない値は `null`。
 *
 * @param {*} value
 * @return {?string}
 */
function taxDateValue_(value) {
  if (isDate_(value)) {
    return isNaN(value.getTime()) ? null : toTokyoDateString_(value);
  }
  if (typeof value !== 'string') return null;
  var text = value.trim();
  var match = /^(\d{4})([-/])(\d{2})\2(\d{2})$/.exec(text);
  if (!match) return null;
  var year = Number(match[1]);
  var month = Number(match[3]);
  var day = Number(match[4]);
  var date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day) {
    return null;
  }
  return match[1] + '-' + match[3] + '-' + match[4];
}

/**
 * 率の末尾を返す（§3.2）。利用日がその率の期間に当たらなければ `null`。
 *
 * @param {string} rate `STANDARD` か `REDUCED`
 * @param {string} date `yyyy-MM-dd`
 * @return {?string}
 */
function taxRateSuffix_(rate, date) {
  for (var index = 0; index < TAX_RATE_PERIODS_.length; index += 1) {
    var period = TAX_RATE_PERIODS_[index];
    if (period.rate !== rate) continue;
    if (date < period.from) continue;
    if (period.to && date > period.to) continue;
    return period.suffix;
  }
  return null;
}

/** 金額として読める数（有限の数だけ。数字の文字は読まない）。 */
function taxFiniteAmount_(value) {
  return typeof value === 'number' && isFinite(value);
}

/** 少額特例に当たるか（§3.4。金額は絶対値で見る）。 */
function taxSmallAmountApplies_(amount, date) {
  if (!taxFiniteAmount_(amount)) return false;
  if (Math.abs(amount) >= TAX_SMALL_AMOUNT_.limit) return false;
  return date >= TAX_SMALL_AMOUNT_.from && date <= TAX_SMALL_AMOUNT_.to;
}

/**
 * 経過措置の名前を返す（§3.5）。`FREEE_TAX_CATEGORIES_` のうち、名前が
 * `課対仕入（控` で始まり、末尾が率の末尾と同じで、期間に利用日が入るものが
 * ちょうど 1 つならその名前。それ以外は `null`。
 *
 * @param {string} date `yyyy-MM-dd`
 * @param {string} suffix 率の末尾
 * @return {?string}
 */
function taxTransitionName_(date, suffix) {
  var found = null;
  var count = 0;
  FREEE_TAX_CATEGORIES_.forEach(function(category) {
    if (category.name.indexOf('課対仕入（控') !== 0) return;
    if (category.name.slice(category.name.length - suffix.length) !== suffix) return;
    if (!category.from || !category.to) return;
    if (date < category.from || date > category.to) return;
    found = category.name;
    count += 1;
  });
  return count === 1 ? found : null;
}

/**
 * §5 の 7（二重の守り）。決めた名前が `FREEE_TAX_CATEGORIES_` に完全一致
 * し、期間のある名前なら利用日がその中にあることを確かめる。通らなければ
 * `null`。
 *
 * @param {string} name
 * @param {?string} date `yyyy-MM-dd`（期間の無い名前では見ない）
 * @return {?string}
 */
function taxFinalName_(name, date) {
  var category = freeeTaxByName_()[name];
  if (!category) return null;
  if (category.from || category.to) {
    if (!date) return null;
    if (category.from && date < category.from) return null;
    if (category.to && date > category.to) return null;
  }
  return name;
}

/** `TAX_ACCOUNT_RULES_` の行。表に無ければ `null`。 */
function taxAccountRule_(code) {
  for (var index = 0; index < TAX_ACCOUNT_RULES_.length; index += 1) {
    if (TAX_ACCOUNT_RULES_[index].code === code) return TAX_ACCOUNT_RULES_[index];
  }
  return null;
}

/** 用途が言葉のどれかを含むか（§3.3。`usageWordKey_` で見る）。 */
function taxWordsMatch_(purpose, words) {
  var key = usageWordKey_(purpose);
  if (!key) return false;
  return words.some(function(word) {
    var wordKey = usageWordKey_(word);
    return wordKey !== '' && key.indexOf(wordKey) >= 0;
  });
}

function taxUndecided_(reason) {
  return {status: TAX_STATUS_.UNDECIDED, name: null, reason: reason};
}

/**
 * 決めた名前を §5 の 7 に通してから返す。通らなければ `NAME_UNKNOWN`。
 */
function taxDecided_(name, date) {
  if (taxFinalName_(name, date) === null) return taxUndecided_('NAME_UNKNOWN');
  return {status: TAX_STATUS_.DECIDED, name: name, reason: null};
}

/**
 * 相手税区分を決める（§5。純粋な関数）。
 *
 * @param {!Object} input
 *   `{customer, accountCode, purpose, date, amount, partnerName, cashback}`
 * @param {?Object} tables `taxTablesFromValues_` の戻り値
 * @return {!Object} `{status: 'DECIDED' | 'UNDECIDED', name, reason}`
 */
function resolveTaxCategory_(input, tables) {
  var source = input || {};
  // 1. カード会社からの返金は今の作りと同じ「対象外」（表が無くても）。
  if (source.cashback === true) {
    return {status: TAX_STATUS_.DECIDED, name: TAX_KIND_.OUT_OF_SCOPE, reason: null};
  }
  // 2. 表が無い・見出しが違う。
  if (!tables || tables.present !== true) return taxUndecided_('TABLES_MISSING');
  // 3. 相手科目コードが読めない。
  var code = accountCodeValue_(source.accountCode);
  if (code === null) return taxUndecided_('NO_ACCOUNT');
  // 4. 表に無いコード。
  var rule = taxAccountRule_(code);
  if (!rule) return taxUndecided_('ACCOUNT_NOT_IN_TABLE');
  // 5. 対象外・非課仕入は、日付・金額・言葉・印を見ない。
  if (rule.kind !== TAX_KIND_.PURCHASE) return taxDecided_(rule.kind, null);

  // 6. 課対仕入。
  var purpose = source.purpose === null || source.purpose === undefined ?
    '' : String(source.purpose);
  if (taxWordsMatch_(purpose, TAX_UNDECIDED_WORDS_)) return taxUndecided_('UNDECIDED_WORD');
  var reduced = taxWordsMatch_(purpose, TAX_REDUCED_WORDS_);
  var excluded = taxWordsMatch_(purpose, TAX_REDUCED_EXCLUDE_WORDS_);
  if (reduced && excluded) return taxUndecided_('FOOD_AMBIGUOUS');
  var date = taxDateValue_(source.date);
  if (date === null) return taxUndecided_('DATE_INVALID');
  var suffix = taxRateSuffix_(reduced ? 'REDUCED' : 'STANDARD', date);
  if (suffix === null) return taxUndecided_('RATE_PERIOD_MISSING');
  var customerId = source.customer ? source.customer.customerId : '';
  if (!rule.exceptions || !accountTextValue_(source.partnerName)) {
    return taxDecided_(TAX_KIND_.PURCHASE + suffix, date);
  }

  // 6.5. 印。
  var mark = taxPartnerMark_(source.partnerName, customerId, tables.marks);
  if (mark === TAX_MARK_INVALID_) return taxUndecided_('MARK_INVALID');
  if (mark === TAX_MARK_.NONE) return taxDecided_(TAX_KIND_.PURCHASE + suffix, date);
  if (mark === TAX_MARK_.OVERSEAS_GOODS) return taxDecided_('課対輸本', date);
  if (mark !== TAX_MARK_.FLEA && mark !== TAX_MARK_.OVERSEAS_SERVICE) {
    return taxUndecided_('MARK_INVALID');
  }
  if (!taxFiniteAmount_(source.amount)) return taxUndecided_('AMOUNT_INVALID');
  var flag = taxCustomerFlag_(customerId, tables.flags);
  if (flag === TAX_CUSTOMER_FLAG_.INVALID) return taxUndecided_('CUSTOMER_FLAG_INVALID');
  if (flag === TAX_CUSTOMER_FLAG_.USABLE && taxSmallAmountApplies_(source.amount, date)) {
    return taxDecided_(TAX_KIND_.PURCHASE + suffix, date);
  }
  if (mark === TAX_MARK_.FLEA) {
    var transition = taxTransitionName_(date, suffix);
    if (transition === null) return taxUndecided_('TRANSITION_PERIOD_MISSING');
    return taxDecided_(transition, date);
  }
  return taxDecided_(TAX_KIND_.OUT_OF_SCOPE, null);
}

/**
 * 確定の読取に足す税の 2 つの鍵（§6.2）。
 *
 * §2.3 の顧客で、2 つのタブがそろっているときだけ鍵を返す。無いタブを
 * `batchGet` の範囲に入れると読取全体が失敗するので、先に見る。
 * §2.3 でない顧客・タブが無いときは空（読取を増やさない）。
 *
 * @param {*} customer `reviewWriteCustomer_` の結果
 * @return {!Array<string>} `taxMarkRows`・`taxFlagRows` か空
 */
function taxTableMasterKeys_(customer) {
  if (!taxCategoryConfigured_(customer)) return [];
  if (!taxTableSheetsForRun_()) return [];
  return ['taxMarkRows', 'taxFlagRows'];
}

/**
 * `readPartnerResolutionMasters_` で読んだ値から表を作る（§6.2）。
 *
 * 鍵を足していない（タブが無い）ときは `present: false`。§5 の 2 により
 * 「決まらない」になるが、確定では G に触らない
 * （`taxCategoryRecomputed_` が `TABLES_MISSING` を `changed: false` にする）。
 *
 * @param {?Object} masters `readPartnerResolutionMasters_` の戻り値
 * @param {!Array<string>} taxKeys `taxTableMasterKeys_` の戻り値
 * @return {!Object} `taxTablesFromValues_` の戻り値
 */
function taxTablesFromMasterRows_(masters, taxKeys) {
  if (!taxKeys || !taxKeys.length) return taxTablesFromValues_(null, null);
  var rows = masters || {};
  return taxTablesFromValues_(rows.taxMarkRows || null, rows.taxFlagRows || null);
}

/**
 * 確定・日付金額の修正で G を決め直す（§6.2。純粋な関数）。
 *
 * 1. 返金の行（`isCashbackMerchant(customer, tx.originalMerchant)`）は
 *    決め直さない（今の `対象外` のまま）。
 * 2. `resolveTaxCategory_` に、用途は `tx.originalPurpose`・`cashback: false`
 *    で渡す（用途は取込の時点の言葉のまま）。
 * 3. `next`（決まらなければ `''`）と `current`（`tx.planned.g`。`undefined`・
 *    `null` は `''`）を比べる。
 * 4. 変わるときだけ `changed: true` と `g` を返す。**`planned` は書き換えない。**
 *    呼ぶ側が `planned.g = g` にし、書く列に `'g'` を足す。変わらないときは
 *    G に触らない（利用者が手で直した G を消さない）。
 *
 * `planned` には、新しい取引先名（`f`）や直した日付・金額（`b`・`m`）を
 * 入れた後の値を渡す。`g` は必ず文字列か `''` で、`null` は返さない
 * （§6.3 の `43` の `buildRowWrite` が止める）。
 *
 * **利用日がシリアル値のとき**（取引ログの予定値は `61` の
 * `updateWrittenValues` が `setValues` で書くので、`'2026-10-15'` は日付の
 * セルになり、確定の読取（`UNFORMATTED_VALUE`）では `46310` のような数で
 * 返る）、有限の整数が `FREEE_EXPORT_MIN_SERIAL_`〜`FREEE_EXPORT_MAX_SERIAL_`
 * の範囲なら `yyyy-MM-dd` に直してから決める。範囲の外・整数でない数は
 * 今のまま（`DATE_INVALID`）。`taxDateValue_` と `resolveTaxCategory_` は
 * 変えない（取込の道は文字のまま）。
 *
 * **表が無い・見出しが違う**（`TABLES_MISSING`）ときは G に触らない
 * （`changed: false`）。取込も表が無ければ G に触らないので、確定だけが
 * 正しく決めた値（`非課仕入` など）を消さない。ほかの「決まらない」
 * （`MARK_INVALID`・`DATE_INVALID` など）は今のまま空にする側へ倒す。
 *
 * @param {*} customer `reviewWriteCustomer_` の結果
 * @param {*} tx 取引ログの 1 行（`getTransaction` の戻り値）
 * @param {!Object} planned 決め直しの材料を入れた予定値
 * @param {?Object} taxTables `taxTablesFromValues_` の戻り値
 * @return {!Object} `{changed: boolean, g: string}`
 */
function taxCategoryRecomputed_(customer, tx, planned, taxTables) {
  var source = planned || {};
  var old = tx && tx.planned ? tx.planned.g : undefined;
  var current = old === undefined || old === null ? '' : String(old);
  if (!tx) return {changed: false, g: current};
  if (isCashbackMerchant(customer, tx.originalMerchant)) return {changed: false, g: current};
  var date = source.b;
  if (typeof date === 'number' && Number.isInteger(date) &&
      date >= FREEE_EXPORT_MIN_SERIAL_ && date <= FREEE_EXPORT_MAX_SERIAL_) {
    date = toTokyoDateString_(excelSerialToDate(date));
  }
  var resolution = resolveTaxCategory_({
    customer: customer,
    accountCode: source.c,
    purpose: tx.originalPurpose,
    date: date,
    amount: source.m,
    partnerName: source.f,
    cashback: false
  }, taxTables);
  if (resolution.reason === 'TABLES_MISSING') return {changed: false, g: current};
  var next = resolution.status === TAX_STATUS_.DECIDED ? resolution.name : '';
  return {changed: next !== current, g: next};
}

// ================================================================
// §9 運用関数（既定は見るだけ。`apply === true` のときだけ書く）
//
// 共通の手順：`withScriptLock_` の中で読み直す → 検査 → 監査を先に書く
// （`type: 'SETTING'`）→ RAW で書く → 読み返して確かめる。監査が書けなければ
// 何も書かない。止めるときは例外でなく報告の `stoppedBy` で返す。
// 監査には取引の値（店名・金額・用途）を入れない（§10.12）。
// ================================================================

/** 運用関数の報告を、返す前に 1 回だけログへ出す（§9）。 */
function taxOpsFinish_(report) {
  Logger.log(JSON.stringify(report));
  return report;
}

/**
 * ロックの中で監査を 1 行足す。`appendAudit` は同じロックを取り直すので、
 * ここではその中身（`appendAuditUnlocked_`）を呼ぶ。呼ぶ側は必ず
 * `withScriptLock_` の中にいる。
 *
 * @param {!Object} entry
 * @return {string} 監査 ID
 */
function taxOpsAudit_(entry) {
  return appendAuditUnlocked_(entry);
}

/** 顧客マスターの 1 行。無い・重複は `null`（§9.3〜9.5 の引数の確かめ）。 */
function taxOpsCustomer_(customerId) {
  var wanted = accountTextValue_(customerId);
  if (!wanted) return null;
  try {
    return getCustomerById(wanted);
  } catch (error) {
    return null;
  }
}

/** A1 から読んだ値の、見出しを除いた行（行番号は 2 始まり）。 */
function taxOpsRowsFromA2_(values, headers) {
  var rows = [];
  (Array.isArray(values) ? values : []).forEach(function(raw, index) {
    var padded = taxRowValues_(raw, headers.length);
    if (taxRowIsEmpty_(padded)) return;
    rows.push({rowNumber: index + 2, values: padded});
  });
  return rows;
}

/** 表の値が 1 つも無いか（§9.1 の「中身が全部空のタブ」）。 */
function taxOpsValuesAreEmpty_(values) {
  var rows = Array.isArray(values) ? values : [];
  return rows.every(function(row) {
    if (!Array.isArray(row)) return true;
    return row.every(function(value) {
      return value === '' || value === null || value === undefined;
    });
  });
}

/**
 * タブ 1 つの状態（§9.1）。
 *
 * `MISSING`（タブが無い）・`EMPTY`（タブはあるが値が 1 つも無い）・
 * `HEADER_MISMATCH`（中身があるのに見出しが違う）・`OK`。`EMPTY` は
 * 見出しを書く側へ倒す（タブを作った直後に見出しの書込が失敗した残り。
 * `47` の M1 と同じ考え）。
 *
 * @param {?Array<!Array<*>>} values
 * @param {!Array<string>} headers
 * @return {!Object}
 */
function taxOpsTableState_(values, headers) {
  if (values === null || values === undefined) return {status: 'MISSING', rows: []};
  if (taxOpsValuesAreEmpty_(values)) return {status: 'EMPTY', rows: []};
  if (!taxHeaderMatches_(values[0], headers)) return {status: 'HEADER_MISMATCH', rows: []};
  return {status: 'OK', rows: taxTableRows_(values, headers) || []};
}

/** 表の誤りの行（§4.1・§4.2。行番号と理由）。 */
function taxOpsTableProblems_(rows, headers) {
  var marks = headers === TAX_PARTNER_MARKS_HEADERS_;
  var problems = [];
  (Array.isArray(rows) ? rows : []).forEach(function(row) {
    var values = taxRowValues_(row, headers.length);
    var reasons = [];
    if (!accountTextValue_(values[0])) {
      reasons.push(marks ? 'PARTNER_NAME_EMPTY' : 'CUSTOMER_ID_EMPTY');
    }
    if (marks) {
      if (TAX_MARK_VALUES_.indexOf(accountTextValue_(values[1])) < 0) reasons.push('MARK_INVALID');
      if (accountFlagValue_(values[3], true) === null) reasons.push('ACTIVE_INVALID');
    } else if (accountFlagValue_(values[1], false) === null) {
      reasons.push('FLAG_INVALID');
    }
    if (reasons.length) problems.push({row: row.rowNumber, reasons: reasons});
  });
  return problems;
}

/** 表 1 つの報告（§9.1 の見るだけ）。 */
function taxOpsTableReport_(values, headers) {
  var state = taxOpsTableState_(values, headers);
  return {
    status: state.status,
    dataRows: state.rows.length,
    problems: state.status === 'OK' ? taxOpsTableProblems_(state.rows, headers) : []
  };
}

/**
 * §9.1 の見るだけ。2 つのタブの有無・見出し・行数・誤りの行を報告に入れ、
 * 書く必要があるかを返す。`HEADER_MISMATCH` のときは `stoppedBy` を立てる。
 */
function taxOpsSetupInspect_(report) {
  report.stoppedBy = null;
  var master = masterSpreadsheet_();
  var names = [CONFIG.SHEET_NAMES.TAX_PARTNER_MARKS, CONFIG.SHEET_NAMES.TAX_CUSTOMER_FLAGS];
  var headers = [TAX_PARTNER_MARKS_HEADERS_, TAX_CUSTOMER_FLAGS_HEADERS_];
  var sheets = names.map(function(name) { return master.getSheetByName(name); });
  var readingSheet = null;
  var ranges = [];
  sheets.forEach(function(sheet, index) {
    if (!sheet) return;
    if (!readingSheet) readingSheet = sheet;
    ranges.push(quoteSheetName_(sheet.getName()) + '!A1:' + columnLetter_(headers[index].length));
  });
  var values = ranges.length ? sheetsReadRanges_(readingSheet, ranges) : [];
  var cursor = 0;
  var states = sheets.map(function(sheet, index) {
    if (!sheet) return {status: 'MISSING', dataRows: 0, problems: []};
    return taxOpsTableReport_(values[cursor++] || null, headers[index]);
  });
  report.tables = {marks: states[0], flags: states[1]};
  report.willWrite = {marks: states[0].status !== 'OK', flags: states[1].status !== 'OK'};
  report.action = states[0].status === 'OK' && states[1].status === 'OK' ? 'ALREADY_SET' : 'CREATE';
  if (states[0].status === 'HEADER_MISMATCH' || states[1].status === 'HEADER_MISMATCH') {
    report.stoppedBy = 'HEADER_MISMATCH';
  }
  return master;
}

/**
 * §9.1 `opsSetupTaxCategoryTables(apply)`
 *
 * 見るだけ：2 つのタブの有る無しと見出しが正しいか、行数、誤りの行。
 * `apply`：無いタブ・中身が全部空のタブだけ作り、見出しを Sheets API の
 * RAW で書く（中身の行は書かない）。あるタブは触らない（見出しが違えば
 * `HEADER_MISMATCH` で止めて何もしない）。
 *
 * @param {boolean=} apply
 * @return {!Object} 報告（`applied` を持つ）
 */
function opsSetupTaxCategoryTables(apply) {
  loadSettingsFromProperties();
  var actor = activeUserEmail_();
  var report = {
    applied: false,
    stoppedBy: null,
    action: null,
    tables: {
      marks: {status: 'MISSING', dataRows: 0, problems: []},
      flags: {status: 'MISSING', dataRows: 0, problems: []}
    },
    willWrite: {marks: false, flags: false},
    written: {marks: false, flags: false},
    verified: false,
    auditId: null
  };

  taxOpsSetupInspect_(report);
  if (apply !== true || report.stoppedBy) return taxOpsFinish_(report);
  return taxOpsFinish_(withScriptLock_(function() {
    var master = taxOpsSetupInspect_(report);
    if (report.stoppedBy) return report;
    if (report.action === 'ALREADY_SET') return report;
    var names = [CONFIG.SHEET_NAMES.TAX_PARTNER_MARKS, CONFIG.SHEET_NAMES.TAX_CUSTOMER_FLAGS];
    var headers = [TAX_PARTNER_MARKS_HEADERS_, TAX_CUSTOMER_FLAGS_HEADERS_];
    var before = {marks: report.tables.marks.status, flags: report.tables.flags.status};

    // 監査を先に書く。書けなければタブも見出しも書かない。
    try {
      report.auditId = taxOpsAudit_({
        type: 'SETTING',
        actor: actor,
        targetType: 'SETTING',
        targetId: 'TAX_TABLES',
        before: before,
        after: {marks: 'OK', flags: 'OK'},
        reason: 'TAX_TABLES_SETUP'
      });
      SpreadsheetApp.flush();
    } catch (error) {
      report.stoppedBy = 'AUDIT_WRITE_FAILED';
      return report;
    }

    try {
      ['marks', 'flags'].forEach(function(key) {
        if (!report.willWrite[key]) return;
        var index = key === 'marks' ? 0 : 1;
        var sheet = master.getSheetByName(names[index]);
        if (!sheet) sheet = master.insertSheet(names[index]);
        ensureSheetWidth_(sheet, headers[index].length);
        // 作ったタブを確定させてから Sheets API で見出しを書く（47 と同じ順）。
        SpreadsheetApp.flush();
        Sheets.Spreadsheets.Values.update({values: [headers[index].slice()]},
          String(master.getId()),
          quoteSheetName_(names[index]) + '!A1:' + columnLetter_(headers[index].length) + '1',
          {valueInputOption: 'RAW'});
        report.written[key] = true;
      });
    } catch (error) {
      report.stoppedBy = 'WRITE_FAILED';
      return report;
    }

    // 読み返しは 2 つのタブの 1 行目を 1 回の読取で。
    var verify = sheetsReadRanges_(master.getSheetByName(names[0]), [
      quoteSheetName_(names[0]) + '!A1:' + columnLetter_(headers[0].length) + '1',
      quoteSheetName_(names[1]) + '!A1:' + columnLetter_(headers[1].length) + '1'
    ]);
    if (!taxHeaderMatches_((verify[0] || [])[0] || [], headers[0]) ||
        !taxHeaderMatches_((verify[1] || [])[0] || [], headers[1])) {
      report.stoppedBy = 'WRITE_VERIFY_FAILED';
      return report;
    }
    ['marks', 'flags'].forEach(function(key) {
      if (!report.willWrite[key]) return;
      report.tables[key] = {status: 'OK', dataRows: 0, problems: []};
    });
    report.verified = true;
    report.applied = true;
    return report;
  }));
}

/**
 * §9.2 `opsFindPartnerNames(word)`（見るだけ。書く道は無い）
 *
 * 共通取引先一覧と顧客別取引先一覧（全顧客）から、`partnerNameKey_` で
 * `word` の鍵を含む取引先名を最大 50（名前・共通か顧客 ID・状態）。並びは
 * 共通取引先一覧の行順、そのあと顧客別取引先一覧の行順。
 *
 * @param {*} word
 * @return {!Object} 報告（`matches`・`truncated`）
 */
function opsFindPartnerNames(word) {
  loadSettingsFromProperties();
  var report = {
    applied: false,
    stoppedBy: null,
    word: accountTextValue_(word),
    key: '',
    matches: [],
    truncated: false
  };
  report.key = partnerNameKey_(report.word);
  if (!report.key) {
    report.stoppedBy = 'WORD_REQUIRED';
    return taxOpsFinish_(report);
  }
  var masters = readPartnerResolutionMasters_(['partnerListRows', 'commonPartnerRows']);
  var matches = [];
  var seen = Object.create(null);
  function add(name, scope, status) {
    var text = accountTextValue_(name);
    if (!text) return;
    if (partnerNameKey_(text).indexOf(report.key) < 0) return;
    var signature = scope + '\u0000' + status + '\u0000' + text;
    if (seen[signature]) return;
    seen[signature] = true;
    matches.push({name: text, scope: scope, status: status});
  }
  ((masters && masters.commonPartnerRows) || []).forEach(function(row) {
    var values = taxRowValues_(row, 6);
    var active = accountFlagValue_(values[5], true);
    add(values[1], 'COMMON', active === false ? 'RETIRED' : 'ACTIVE');
  });
  customerPartnerRecords_((masters && masters.partnerListRows) || []).forEach(function(record) {
    add(record.partnerName, accountTextValue_(record.customerId),
      record.active === true ? 'ACTIVE' : 'RETIRED');
  });
  report.truncated = matches.length > 50;
  report.matches = matches.slice(0, 50);
  return taxOpsFinish_(report);
}

/** 監査に入れてよい印の行の値（名前・印・顧客 ID だけ。§10.12）。 */
function taxOpsMarkAuditValues_(values) {
  return {
    name: accountTextValue_(values[0]),
    mark: accountTextValue_(values[1]),
    customerId: accountTextValue_(values[2])
  };
}

/** 顧客別取引先一覧の行。 */
function taxOpsPartnerRecords_(masters) {
  return customerPartnerRecords_((masters && masters.partnerListRows) || []);
}

/** 共通取引先一覧の行（`readCommonPartners_` と同じ形）。 */
function taxOpsCommonPartnerRows_(masters) {
  return commonPartnerRowsFromRecords_((masters && masters.commonPartnerRows) || []);
}

/**
 * 名前が取引先一覧にあるかを分類する（§9.3 の決め）。
 *
 * 顧客 ID があるとき：その顧客の一覧と共通一覧の索引で分類する。
 * 顧客 ID が空（共通の印）のとき：共通一覧だけの索引で分類し、`KNOWN` で
 * なければ顧客別一覧のどれかの顧客に同じ文字（前後の空白を外して完全一致）の
 * 有効な名前があれば `KNOWN` とする（その顧客 ID を返す）。
 *
 * @param {string} partnerName
 * @param {string} customerId
 * @param {!Array<!Object>} records `customerPartnerRecords_` の行
 * @param {!Array<!Object>} commonPartners `commonPartnerRowsFromRecords_` の行
 * @return {!Object} `{classification, knownCustomerId}`
 */
function taxOpsPartnerClassification_(partnerName, customerId, records, commonPartners) {
  var wanted = accountTextValue_(customerId);
  var index = buildPartnerNameIndex_(wanted ? records : [], wanted, commonPartners);
  var classification = classifyPartnerName_(index, partnerName);
  if (wanted) {
    return {classification: classification,
      knownCustomerId: classification.kind === 'KNOWN' ? wanted : null};
  }
  if (classification.kind === 'KNOWN') {
    return {classification: classification, knownCustomerId: null};
  }
  var exact = accountTextValue_(partnerName);
  var hits = (records || []).filter(function(record) {
    return record.active === true && accountTextValue_(record.partnerName) === exact;
  });
  if (hits.length) {
    return {classification: {kind: 'KNOWN'}, knownCustomerId: accountTextValue_(hits[0].customerId)};
  }
  return {classification: classification, knownCustomerId: null};
}

/**
 * 同じ鍵・同じ顧客 ID の行のうち、有効がはっきり `FALSE` でない行（§9.3）。
 * 読めない値（`active === null`）も候補に残す。
 */
function taxOpsMarkCandidates_(rows, partnerName, customerId) {
  var key = partnerNameKey_(partnerName);
  var wanted = accountTextValue_(customerId);
  var candidates = [];
  (Array.isArray(rows) ? rows : []).forEach(function(row) {
    var values = taxRowValues_(row, TAX_PARTNER_MARKS_HEADERS_.length);
    if (partnerNameKey_(values[0]) !== key) return;
    if (accountTextValue_(values[2]) !== wanted) return;
    var active = accountFlagValue_(values[3], true);
    if (active === false) return;
    candidates.push({rowNumber: row.rowNumber, values: values, active: active});
  });
  return candidates;
}

/**
 * §9.3 `opsSetPartnerTaxMark(partnerName, mark, customerId, apply)`
 *
 * 見るだけ：同じ鍵・同じ顧客 ID の今の行、名前が取引先一覧にあるか
 * （`KNOWN`・`VARIANT`・`RETIRED`・`NEW`）。`apply`：`KNOWN` でなければ
 * 書かない。同じ鍵・同じ顧客 ID の有効な行が 1 行あれば B・E・F を書き直し、
 * 無ければ末尾に足す（D＝`TRUE`）。2 行以上なら `DUPLICATE_ROWS` で止める。
 *
 * @param {*} partnerName
 * @param {*} mark
 * @param {*} customerId 空なら共通
 * @param {boolean=} apply
 * @return {!Object} 報告（`applied` を持つ）
 */
function opsSetPartnerTaxMark(partnerName, mark, customerId, apply) {
  loadSettingsFromProperties();
  var actor = activeUserEmail_();
  var report = {
    applied: false,
    stoppedBy: null,
    partnerName: accountTextValue_(partnerName),
    mark: mark === undefined || mark === null ? '' : String(mark),
    customerId: accountTextValue_(customerId),
    scope: null,
    classification: null,
    knownCustomerId: null,
    action: null,
    candidates: 0,
    before: null,
    after: null,
    verified: false,
    auditId: null
  };
  report.scope = report.customerId ? report.customerId : 'COMMON';
  if (!report.partnerName) {
    report.stoppedBy = 'PARTNER_NAME_REQUIRED';
    return taxOpsFinish_(report);
  }
  if (TAX_MARK_VALUES_.indexOf(report.mark) < 0) {
    report.stoppedBy = 'MARK_INVALID';
    return taxOpsFinish_(report);
  }
  if (report.customerId && !taxOpsCustomer_(report.customerId)) {
    report.stoppedBy = 'CUSTOMER_NOT_FOUND';
    return taxOpsFinish_(report);
  }

  function inspect() {
    report.stoppedBy = null;
    report.classification = null;
    report.knownCustomerId = null;
    report.action = null;
    report.candidates = 0;
    report.before = null;
    var tables = readTaxTablesDirect_();
    if (!tables.present) {
      report.stoppedBy = 'TABLES_MISSING';
      return null;
    }
    var masters = readPartnerResolutionMasters_(['partnerListRows', 'commonPartnerRows']);
    var found = taxOpsPartnerClassification_(report.partnerName, report.customerId,
      taxOpsPartnerRecords_(masters), taxOpsCommonPartnerRows_(masters));
    report.classification = found.classification;
    report.knownCustomerId = found.knownCustomerId;
    if (found.classification.kind !== 'KNOWN') {
      report.stoppedBy = 'PARTNER_NAME_NOT_KNOWN';
      return null;
    }
    var candidates = taxOpsMarkCandidates_(tables.marks, report.partnerName, report.customerId);
    report.candidates = candidates.length;
    report.action = candidates.length ? 'UPDATE' : 'CREATE';
    if (candidates.length > 1) {
      report.stoppedBy = 'DUPLICATE_ROWS';
      return null;
    }
    if (candidates.length === 1) {
      report.before = taxOpsMarkAuditValues_(candidates[0].values);
      if (candidates[0].active === null) {
        report.stoppedBy = 'ROW_INVALID';
        return null;
      }
    }
    report.after = {name: report.partnerName, mark: report.mark,
      customerId: report.customerId};
    return {candidate: candidates.length ? candidates[0] : null};
  }

  inspect();
  if (apply !== true || report.stoppedBy) return taxOpsFinish_(report);
  return taxOpsFinish_(withScriptLock_(function() {
    var current = inspect();
    if (report.stoppedBy || !current) return report;
    var master = masterSpreadsheet_();
    var sheet = requireSheet_(master, CONFIG.SHEET_NAMES.TAX_PARTNER_MARKS);
    var now = nowIso_();
    var before = report.before;

    // 監査を先に書く。書けなければ表には 1 セルも書かない。
    try {
      report.auditId = taxOpsAudit_({
        type: 'SETTING',
        actor: actor,
        targetType: 'PARTNER',
        targetId: report.partnerName,
        customerId: report.customerId,
        before: before || '',
        after: report.after,
        reason: 'TAX_PARTNER_MARK'
      });
      SpreadsheetApp.flush();
    } catch (error) {
      report.stoppedBy = 'AUDIT_WRITE_FAILED';
      return report;
    }

    try {
      if (current.candidate) {
        var rowNumber = current.candidate.rowNumber;
        Sheets.Spreadsheets.Values.batchUpdate({valueInputOption: 'RAW', data: [
          {range: quoteSheetName_(sheet.getName()) + '!B' + rowNumber, values: [[report.mark]]},
          {range: quoteSheetName_(sheet.getName()) + '!E' + rowNumber, values: [[now]]},
          {range: quoteSheetName_(sheet.getName()) + '!F' + rowNumber, values: [[actor]]}
        ]}, String(master.getId()));
      } else {
        appendRowsBatched_(sheet,
          [[report.partnerName, report.mark, report.customerId, true, now, actor, '']],
          7, 'tax-partner-marks');
      }
    } catch (error) {
      report.stoppedBy = 'WRITE_FAILED';
      return report;
    }

    var values = sheetsReadRanges_(sheet, [quoteSheetName_(sheet.getName()) + '!A2:G'])[0] || [];
    var verify = taxOpsMarkCandidates_(taxOpsRowsFromA2_(values, TAX_PARTNER_MARKS_HEADERS_),
      report.partnerName, report.customerId);
    var expectedActive = current.candidate ? current.candidate.active : true;
    var ok = verify.length === 1 &&
      accountTextValue_(verify[0].values[1]) === report.mark &&
      accountTextValue_(verify[0].values[2]) === report.customerId &&
      accountTextValue_(verify[0].values[4]) === now &&
      accountTextValue_(verify[0].values[5]) === actor &&
      verify[0].active === expectedActive;
    if (!ok) {
      report.stoppedBy = 'WRITE_VERIFY_FAILED';
      return report;
    }
    report.verified = true;
    report.applied = true;
    return report;
  }));
}

/** 顧客の設定の行（A が同じ顧客 ID の行。§9.4）。 */
function taxOpsFlagRows_(rows, customerId) {
  var wanted = accountTextValue_(customerId);
  var matches = [];
  (Array.isArray(rows) ? rows : []).forEach(function(row) {
    var values = taxRowValues_(row, TAX_CUSTOMER_FLAGS_HEADERS_.length);
    if (accountTextValue_(values[0]) !== wanted) return;
    matches.push({rowNumber: row.rowNumber, values: values});
  });
  return matches;
}

/**
 * §9.4 `opsSetCustomerTaxFlag(customerId, smallAmountUnavailable, apply)`
 *
 * 見るだけ：今の値。`apply`：その顧客の行を書き直すか足す（2 行以上なら
 * `DUPLICATE_ROWS` で止める）。`smallAmountUnavailable` は真偽だけ。
 *
 * @param {*} customerId
 * @param {*} smallAmountUnavailable
 * @param {boolean=} apply
 * @return {!Object} 報告（`applied` を持つ）
 */
function opsSetCustomerTaxFlag(customerId, smallAmountUnavailable, apply) {
  loadSettingsFromProperties();
  var actor = activeUserEmail_();
  var report = {
    applied: false,
    stoppedBy: null,
    customerId: accountTextValue_(customerId),
    smallAmountUnavailable: smallAmountUnavailable,
    action: null,
    candidates: 0,
    before: null,
    after: null,
    verified: false,
    auditId: null
  };
  if (!report.customerId) {
    report.stoppedBy = 'CUSTOMER_REQUIRED';
    return taxOpsFinish_(report);
  }
  if (typeof smallAmountUnavailable !== 'boolean') {
    report.stoppedBy = 'ARGUMENT_INVALID';
    return taxOpsFinish_(report);
  }
  if (!taxOpsCustomer_(report.customerId)) {
    report.stoppedBy = 'CUSTOMER_NOT_FOUND';
    return taxOpsFinish_(report);
  }

  function inspect() {
    report.stoppedBy = null;
    report.action = null;
    report.candidates = 0;
    report.before = null;
    var tables = readTaxTablesDirect_();
    if (!tables.present) {
      report.stoppedBy = 'TABLES_MISSING';
      return null;
    }
    var rows = taxOpsFlagRows_(tables.flags, report.customerId);
    report.candidates = rows.length;
    report.action = rows.length ? 'UPDATE' : 'CREATE';
    if (rows.length > 1) {
      report.stoppedBy = 'DUPLICATE_ROWS';
      return null;
    }
    if (rows.length === 1) {
      report.before = {smallAmountUnavailable: accountFlagValue_(rows[0].values[1], false)};
    }
    report.after = {smallAmountUnavailable: report.smallAmountUnavailable};
    return {row: rows.length ? rows[0] : null};
  }

  inspect();
  if (apply !== true || report.stoppedBy) return taxOpsFinish_(report);
  return taxOpsFinish_(withScriptLock_(function() {
    var current = inspect();
    if (report.stoppedBy || !current) return report;
    var master = masterSpreadsheet_();
    var sheet = requireSheet_(master, CONFIG.SHEET_NAMES.TAX_CUSTOMER_FLAGS);
    var now = nowIso_();
    var before = report.before;

    try {
      report.auditId = taxOpsAudit_({
        type: 'SETTING',
        actor: actor,
        targetType: 'CUSTOMER',
        targetId: report.customerId,
        customerId: report.customerId,
        before: before || '',
        after: report.after,
        reason: 'TAX_CUSTOMER_FLAG'
      });
      SpreadsheetApp.flush();
    } catch (error) {
      report.stoppedBy = 'AUDIT_WRITE_FAILED';
      return report;
    }

    try {
      if (current.row) {
        var rowNumber = current.row.rowNumber;
        // B・C・D は続いているので 1 レンジで書く。
        Sheets.Spreadsheets.Values.batchUpdate({valueInputOption: 'RAW', data: [{
          range: quoteSheetName_(sheet.getName()) + '!B' + rowNumber + ':D' + rowNumber,
          values: [[report.smallAmountUnavailable, now, actor]]
        }]}, String(master.getId()));
      } else {
        appendRowsBatched_(sheet,
          [[report.customerId, report.smallAmountUnavailable, now, actor, '']],
          5, 'tax-customer-flags');
      }
    } catch (error) {
      report.stoppedBy = 'WRITE_FAILED';
      return report;
    }

    var values = sheetsReadRanges_(sheet, [quoteSheetName_(sheet.getName()) + '!A2:E'])[0] || [];
    var verify = taxOpsFlagRows_(taxOpsRowsFromA2_(values, TAX_CUSTOMER_FLAGS_HEADERS_),
      report.customerId);
    var ok = verify.length === 1 &&
      accountFlagValue_(verify[0].values[1], false) === report.smallAmountUnavailable &&
      accountTextValue_(verify[0].values[2]) === now &&
      accountTextValue_(verify[0].values[3]) === actor;
    if (!ok) {
      report.stoppedBy = 'WRITE_VERIFY_FAILED';
      return report;
    }
    report.verified = true;
    report.applied = true;
    return report;
  }));
}

/**
 * 入力規則の要約（§9.5。一覧なら値の並び、範囲なら A1 表記）。
 * `getCriteriaType()` か `getCriteriaValues()` が例外なら壊れた規則
 * （消えた範囲を指す `#REF!` など）として、`broken: true` と `values: null`・
 * `rangeA1: null` を返す。`getAllowInvalid()` の例外は `allowInvalid: null`
 * だけにする（壊れた規則にはしない）。
 */
function taxOpsValidationSummary_(validation) {
  if (!validation) {
    return {key: 'NONE', type: null, values: null, rangeA1: null, allowInvalid: null,
      broken: false};
  }
  var broken = false;
  var type = '';
  if (validation.getCriteriaType) {
    try {
      type = String(validation.getCriteriaType());
    } catch (error) {
      type = null;
      broken = true;
    }
  }
  var criteria = [];
  if (validation.getCriteriaValues) {
    try {
      criteria = validation.getCriteriaValues() || [];
    } catch (error) {
      criteria = null;
      broken = true;
    }
  }
  var values = null;
  var rangeA1 = null;
  if (!broken) {
    if (type === 'VALUE_IN_LIST') {
      values = (criteria[0] || []).map(function(value) { return String(value); });
    } else if (type === 'VALUE_IN_RANGE') {
      var target = criteria[0];
      rangeA1 = target === null || target === undefined ? null :
        (typeof target === 'string' ? target :
          (target.getA1Notation ? String(target.getA1Notation()) : String(target)));
    }
  }
  var allowInvalid = null;
  if (validation.getAllowInvalid) {
    try {
      allowInvalid = Boolean(validation.getAllowInvalid());
    } catch (error) {
      allowInvalid = null;
    }
  }
  return {
    key: broken ? JSON.stringify([type, 'BROKEN', allowInvalid]) :
      JSON.stringify([type, values, rangeA1, allowInvalid]),
    type: type,
    values: values,
    rangeA1: rangeA1,
    allowInvalid: allowInvalid,
    broken: broken
  };
}

/**
 * 入力規則を、同じ規則の続く行ごとにまとめる（§9.5。最大 20 組）。
 * あわせて、値のある行と、一覧に無い値（最大 10 個）も返す。
 * 壊れた規則の行は `brokenRows` で数え、`allowInvalid` が読めない行が
 * 1 つでもあれば `allowInvalid` は `true`（ばらばらと同じ扱い）にする。
 */
function taxOpsValidationReport_(range, firstRow) {
  var validations = range.getDataValidations();
  var values = range.getValues();
  var groups = [];
  var allowInvalid = [];
  var valueRows = 0;
  var brokenRows = 0;
  var other = [];
  var otherRows = [];
  validations.forEach(function(row, index) {
    var validation = row && row[0] ? row[0] : null;
    var summary = taxOpsValidationSummary_(validation);
    if (validation) allowInvalid.push(summary.allowInvalid);
    if (summary.broken) brokenRows += 1;
    var last = groups[groups.length - 1];
    if (last && last.key === summary.key) {
      last.to = firstRow + index;
    } else {
      groups.push({key: summary.key, from: firstRow + index, to: firstRow + index,
        type: summary.type, values: summary.values, rangeA1: summary.rangeA1,
        allowInvalid: summary.allowInvalid, broken: summary.broken});
    }
    var cell = values[index] && values[index][0];
    if (cell === '' || cell === null || cell === undefined) return;
    valueRows += 1;
    var text = String(cell);
    var known = FREEE_TAX_CATEGORIES_.some(function(category) {
      return category.name === text;
    });
    if (!known) otherRows.push(firstRow + index);
    if (!known && other.indexOf(text) < 0 && other.length < 10) other.push(text);
  });
  var allow = true;
  if (allowInvalid.length) {
    var unreadable = allowInvalid.some(function(value) { return value === null; });
    allow = !unreadable &&
      allowInvalid.every(function(value) { return value === allowInvalid[0]; }) ?
      allowInvalid[0] : true;
  }
  return {
    groups: groups.slice(0, 20),
    truncated: groups.length > 20,
    rows: validations.length,
    valueRows: valueRows,
    otherValues: other.slice(0, 10),
    otherValueRows: otherRows.slice(0, 20),
    otherValueRowCount: otherRows.length,
    allowInvalid: allow,
    brokenRows: brokenRows,
    values: values
  };
}

/**
 * §9.5 `opsSetTaxCategoryValidation(customerId, apply)`（雛形の G の入力規則）
 *
 * 対象は、その顧客の雛形（`customer.destinationSpreadsheetId`）の入力用
 * シートの G の `headerRow + 1` 行目から最後の行（`getMaxRows()`）まで。
 * 転記シート（複製）・ほかの顧客の雛形には触らない。
 *
 * @param {*} customerId
 * @param {boolean=} apply
 * @return {!Object} 報告（`applied` を持つ）
 */
function opsSetTaxCategoryValidation(customerId, apply) {
  loadSettingsFromProperties();
  var actor = activeUserEmail_();
  var report = {
    applied: false,
    stoppedBy: null,
    customerId: accountTextValue_(customerId),
    templateId: null,
    sheetName: null,
    column: null,
    headerRow: null,
    firstRow: null,
    lastRow: null,
    groups: [],
    truncated: false,
    rows: 0,
    valueRows: 0,
    otherValues: [],
    allowInvalid: null,
    brokenRows: 0,
    verified: false,
    auditId: null
  };
  if (!report.customerId) {
    report.stoppedBy = 'CUSTOMER_REQUIRED';
    return taxOpsFinish_(report);
  }
  var customer = taxOpsCustomer_(report.customerId);
  if (!customer) {
    report.stoppedBy = 'CUSTOMER_NOT_FOUND';
    return taxOpsFinish_(report);
  }
  report.templateId = String(customer.destinationSpreadsheetId || '');
  report.sheetName = String(customer.destinationSheetName || '');
  report.headerRow = Number(customer.headerRow);
  var column = Number(customer.columnMapping && customer.columnMapping.G);
  var excluded = (customer.rowScanExcludedColumns || []).map(Number);
  if (!Number.isInteger(column) || column < 1 || excluded.indexOf(column) >= 0) {
    report.stoppedBy = 'NO_TAX_COLUMN';
    return taxOpsFinish_(report);
  }
  report.column = column;
  if (!Number.isInteger(report.headerRow) || report.headerRow < 1) {
    report.stoppedBy = 'TEMPLATE_INVALID';
    return taxOpsFinish_(report);
  }

  function open() {
    if (!report.templateId || !report.sheetName) {
      report.stoppedBy = 'TEMPLATE_MISSING';
      return null;
    }
    var spreadsheet = null;
    try { spreadsheet = SpreadsheetApp.openById(report.templateId); } catch (error) {
      report.stoppedBy = 'TEMPLATE_MISSING';
      return null;
    }
    var sheet = spreadsheet.getSheetByName(report.sheetName);
    if (!sheet) {
      report.stoppedBy = 'TEMPLATE_MISSING';
      return null;
    }
    var first = report.headerRow + 1;
    var last = Number(sheet.getMaxRows());
    report.firstRow = first;
    report.lastRow = last;
    if (!(last >= first)) {
      report.stoppedBy = 'NO_ROWS';
      return null;
    }
    return {sheet: sheet, range: sheet.getRange(first, column, last - first + 1, 1)};
  }

  function inspect() {
    report.stoppedBy = null;
    var target = open();
    if (!target) return null;
    var summary = taxOpsValidationReport_(target.range, report.firstRow);
    report.groups = summary.groups;
    report.truncated = summary.truncated;
    report.rows = summary.rows;
    report.valueRows = summary.valueRows;
    report.otherValues = summary.otherValues;
    report.allowInvalid = summary.allowInvalid;
    report.brokenRows = summary.brokenRows;
    return target;
  }

  inspect();
  if (apply !== true || report.stoppedBy) return taxOpsFinish_(report);
  return taxOpsFinish_(withScriptLock_(function() {
    var target = inspect();
    if (report.stoppedBy || !target) return report;
    var names = FREEE_TAX_CATEGORIES_.map(function(category) { return category.name; });
    var before = {groups: report.groups, truncated: report.truncated,
      valueRows: report.valueRows};
    var allowInvalid = report.allowInvalid;

    try {
      report.auditId = taxOpsAudit_({
        type: 'SETTING',
        actor: actor,
        targetType: 'TEMPLATE',
        targetId: report.templateId,
        customerId: report.customerId,
        before: before,
        after: {column: columnLetter_(column), firstRow: report.firstRow,
          lastRow: report.lastRow, allowInvalid: allowInvalid, count: names.length},
        reason: 'TAX_VALIDATION'
      });
      SpreadsheetApp.flush();
    } catch (error) {
      report.stoppedBy = 'AUDIT_WRITE_FAILED';
      return report;
    }

    try {
      var validation = SpreadsheetApp.newDataValidation()
        .requireValueInList(names, true)
        .setAllowInvalid(allowInvalid)
        .build();
      target.range.setDataValidation(validation);
    } catch (error) {
      report.stoppedBy = 'WRITE_FAILED';
      return report;
    }

    var verify = target.sheet.getRange(report.firstRow, column,
      report.lastRow - report.firstRow + 1, 1).getDataValidations();
    var expected = JSON.stringify(['VALUE_IN_LIST', names, allowInvalid]);
    var ok = verify.length === report.lastRow - report.firstRow + 1 &&
      verify.every(function(row) {
        var summary = taxOpsValidationSummary_(row && row[0] ? row[0] : null);
        return JSON.stringify([summary.type, summary.values, summary.allowInvalid]) === expected;
      });
    if (!ok) {
      report.stoppedBy = 'WRITE_VERIFY_FAILED';
      return report;
    }
    report.verified = true;
    report.applied = true;
    return report;
  }));
}

/**
 * §9.6 `opsSetCopiesTaxCategoryValidation(customerId, apply, options)`
 * （今ある転記シートの G の入力規則）。
 *
 * 対象は、その顧客の取引ログの有効な取引（`PREPARED`・`WRITING`・
 * `COMMITTED`・`REVIEW_REQUIRED`）が指す転記シートだけ。雛形・ほかの顧客・
 * 取引ログに無い転記シートには触らない。`apply === true` のときだけ、転記
 * シートごとにロックを取り、確かめ直し → 監査 → 規則を 1 回で付ける →
 * 読み返し、の順に書く。値は変えない。
 *
 * @param {*} customerId
 * @param {boolean=} apply
 * @param {{timeBudgetMs: (number|undefined), startAfter: (string|undefined)}=} options
 * @return {!Object} 報告（`applied` を持つ）
 */
function opsSetCopiesTaxCategoryValidation(customerId, apply, options) {
  var startedAt = Date.now();
  loadSettingsFromProperties();
  var actor = activeUserEmail_();
  var budget = taxOpsCopyBudget_(options);
  var startAfter = options && typeof options === 'object' &&
    typeof options.startAfter === 'string' ? options.startAfter : null;
  var report = {
    applied: false,
    stoppedBy: null,
    customerId: accountTextValue_(customerId),
    templateId: null,
    column: null,
    headerRow: null,
    transactions: 0,
    legacyTransactions: 0,
    unreadableTransactions: 0,
    copies: [],
    counts: {alreadySet: 0, needsUpdate: 0, skipped: 0, applied: 0, notReached: 0,
      beforeStart: 0},
    auditIds: [],
    startAfter: startAfter,
    resumeAfter: null
  };
  if (!report.customerId) {
    report.stoppedBy = 'CUSTOMER_REQUIRED';
    return taxOpsFinish_(report);
  }
  var customer = taxOpsCustomer_(report.customerId);
  if (!customer) {
    report.stoppedBy = 'CUSTOMER_NOT_FOUND';
    return taxOpsFinish_(report);
  }
  report.templateId = String(customer.destinationSpreadsheetId || '');
  report.headerRow = Number(customer.headerRow);
  var column = Number(customer.columnMapping && customer.columnMapping.G);
  var excluded = (customer.rowScanExcludedColumns || []).map(Number);
  if (!Number.isInteger(column) || column < 1 || excluded.indexOf(column) >= 0) {
    report.stoppedBy = 'NO_TAX_COLUMN';
    return taxOpsFinish_(report);
  }
  report.column = column;
  if (!Number.isInteger(report.headerRow) || report.headerRow < 1) {
    report.stoppedBy = 'TEMPLATE_INVALID';
    return taxOpsFinish_(report);
  }
  var rule = schemaHeaderRule_(customer);
  if (!rule) {
    report.stoppedBy = 'HEADER_EXPECTATION_MISSING';
    return taxOpsFinish_(report);
  }
  var templateParentId = taxOpsCopyTemplateParent_(report.templateId);
  if (templateParentId === null) {
    report.stoppedBy = 'TEMPLATE_MISSING';
    return taxOpsFinish_(report);
  }
  if (!taxOpsCopyTargets_(report, customer)) return taxOpsFinish_(report);

  var names = FREEE_TAX_CATEGORIES_.map(function(category) { return category.name; });
  taxOpsCopySort_(report.copies);
  if (startAfter !== null) {
    report.copies = report.copies.filter(function(copy) {
      if (copy.spreadsheetId <= startAfter) {
        report.counts.beforeStart += 1;
        return false;
      }
      return true;
    });
  }

  var lastHandledId = startAfter;
  var timeCheckedId = null;
  for (var index = 0; index < report.copies.length; index += 1) {
    var copy = report.copies[index];
    // 時間は同じ ID の最初の組の前でだけ見る（`startAfter` は ID で飛ばすため）。
    if (copy.spreadsheetId !== timeCheckedId) {
      timeCheckedId = copy.spreadsheetId;
      if (Date.now() - startedAt >= budget) {
        report.stoppedBy = 'TIME_BUDGET';
        report.resumeAfter = lastHandledId;
        taxOpsCopyRemaining_(report.copies, index);
        break;
      }
    }
    var checked = taxOpsCopyCheck_(copy, customer, templateParentId, report.headerRow,
      column, names, rule);
    if (!checked || copy.status !== 'NEEDS_UPDATE') {
      lastHandledId = copy.spreadsheetId;
      continue;
    }
    if (apply !== true) {
      lastHandledId = copy.spreadsheetId;
      continue;
    }
    var entered = false;
    var stop = null;
    try {
      stop = withScriptLock_(function() {
        entered = true;
        return taxOpsCopyApply_(copy, customer, templateParentId, report, column, names,
          rule, actor);
      });
    } catch (error) {
      if (!entered) {
        report.stoppedBy = 'LOCK_UNAVAILABLE';
        taxOpsCopyRemaining_(report.copies, index);
        break;
      }
      report.stoppedBy = 'UNEXPECTED_ERROR';
      taxOpsCopyRemaining_(report.copies, index);
      taxOpsFinish_(report);
      throw error;
    }
    if (stop) {
      report.stoppedBy = stop;
      taxOpsCopyRemaining_(report.copies, index + 1);
      break;
    }
    lastHandledId = copy.spreadsheetId;
  }
  taxOpsCopyCounts_(report);
  return taxOpsFinish_(report);
}

/** `options.timeBudgetMs` の読み方（省略時 180000、数でなければ 180000、負なら 0）。 */
function taxOpsCopyBudget_(options) {
  var value = options && typeof options === 'object' ? options.timeBudgetMs : undefined;
  if (typeof value !== 'number' || !isFinite(value)) return 180000;
  if (value < 0) return 0;
  return value;
}

/** Drive の一覧を配列にする（`getParents()` など）。 */
function taxOpsCopyIterator_(iterator) {
  var items = [];
  while (iterator.hasNext()) items.push(iterator.next());
  return items;
}

/** 雛形の親フォルダー 1 つ。読めない・0・2 以上は `null`。 */
function taxOpsCopyTemplateParent_(templateId) {
  if (!templateId) return null;
  try {
    var parents = taxOpsCopyIterator_(DriveApp.getFileById(templateId).getParents());
    return parents.length === 1 ? String(parents[0].getId()) : null;
  } catch (error) {
    return null;
  }
}

/**
 * 取引ログから転記シートの組を作る（§9.6.2）。読めなければ
 * `TRANSACTION_LOG_UNREADABLE` で `false`。
 */
function taxOpsCopyTargets_(report, customer) {
  var records = [];
  try {
    var found = findRowsByColumnValues_(transactionLogSheet_(), 4, [report.customerId],
      TRANSACTION_LOG_WIDTH_);
    records = found[report.customerId] || [];
  } catch (error) {
    report.stoppedBy = 'TRANSACTION_LOG_UNREADABLE';
    return false;
  }
  var statuses = [TX_STATUS.PREPARED, TX_STATUS.WRITING, TX_STATUS.COMMITTED,
    TX_STATUS.REVIEW_REQUIRED];
  var byKey = Object.create(null);
  var order = [];
  records.forEach(function(record) {
    var tx = null;
    try { tx = txLogFromRecord_(record); } catch (error) {
      report.unreadableTransactions += 1;
      return;
    }
    if (!tx || String(tx.customerId) !== report.customerId) return;
    if (tx.active !== true || statuses.indexOf(tx.transactionStatus) < 0) return;
    report.transactions += 1;
    var destination = recordedDestinationOf_(tx, customer);
    if (!destination || destination.spreadsheetId === report.templateId) {
      report.legacyTransactions += 1;
      return;
    }
    var key = destination.spreadsheetId + '\u0000' + destination.sheetName;
    if (!byKey[key]) {
      byKey[key] = {spreadsheetId: destination.spreadsheetId,
        sheetName: destination.sheetName, transactionCount: 0};
      order.push(key);
    }
    byKey[key].transactionCount += 1;
  });
  order.forEach(function(key) {
    var group = byKey[key];
    report.copies.push({
      spreadsheetId: group.spreadsheetId,
      stamp: null,
      sheetName: group.sheetName,
      transactionCount: group.transactionCount,
      status: 'NEEDS_UPDATE',
      problem: null,
      firstRow: null,
      lastRow: null,
      rows: 0,
      groups: [],
      truncated: false,
      valueRows: 0,
      otherValues: [],
      otherValueRows: [],
      otherValueRowCount: 0,
      allowInvalid: null,
      brokenRows: 0,
      verified: false,
      auditId: null
    });
  });
  return true;
}

/** 組を触らない（§9.6.3）。 */
function taxOpsCopySkip_(copy, problem) {
  copy.status = 'SKIPPED';
  copy.problem = problem;
  copy.verified = false;
  return null;
}

/**
 * 組を 1 つ確かめる（§9.6.3）。見るだけでもロックの中でも同じ。
 * 外れたら `SKIPPED` と理由にして `null`、通れば範囲と要約を返す。
 */
function taxOpsCopyCheck_(copy, customer, templateParentId, headerRow, column, names, rule) {
  copy.status = 'NEEDS_UPDATE';
  copy.problem = null;
  copy.stamp = null;
  copy.firstRow = null;
  copy.lastRow = null;
  copy.rows = 0;
  copy.groups = [];
  copy.truncated = false;
  copy.valueRows = 0;
  copy.otherValues = [];
  copy.otherValueRows = [];
  copy.otherValueRowCount = 0;
  copy.allowInvalid = null;
  copy.brokenRows = 0;
  copy.verified = false;
  var file = null;
  try { file = DriveApp.getFileById(copy.spreadsheetId); } catch (error) {
    return taxOpsCopySkip_(copy, 'OPEN_FAILED');
  }
  try {
    if (file.isTrashed()) return taxOpsCopySkip_(copy, 'TRASHED');
    var name = String(file.getName() || '');
    var prefix = String(customer.customerName) + '_';
    var stamp = name.slice(prefix.length);
    if (name.indexOf(prefix) !== 0 || !/^\d{8}-\d{4}$/.test(stamp)) {
      return taxOpsCopySkip_(copy, 'NAME_MISMATCH');
    }
    copy.stamp = stamp;
    var parents = taxOpsCopyIterator_(file.getParents());
    if (parents.length !== 1 || String(parents[0].getId()) !== templateParentId) {
      return taxOpsCopySkip_(copy, 'PARENT_MISMATCH');
    }
    var spreadsheet = null;
    try { spreadsheet = SpreadsheetApp.openById(copy.spreadsheetId); } catch (error) {
      return taxOpsCopySkip_(copy, 'OPEN_FAILED');
    }
    var sheet = spreadsheet.getSheetByName(copy.sheetName);
    if (!sheet) return taxOpsCopySkip_(copy, 'SHEET_MISSING');
    var row = Number.isInteger(rule.row) ? rule.row : headerRow;
    var width = 0;
    rule.cells.forEach(function(cell) {
      width = Math.max(width, Number(cell.column));
    });
    var header = sheet.getRange(row, 1, 1, Math.max(width, 1)).getValues()[0] || [];
    var matches = rule.cells.every(function(cell) {
      return schemaHeaderCellMatches_(header[Number(cell.column) - 1], cell);
    });
    if (!matches) return taxOpsCopySkip_(copy, 'HEADER_MISMATCH');
    var lastRow = Number(sheet.getMaxRows());
    var firstRow = headerRow + 1;
    copy.firstRow = firstRow;
    copy.lastRow = lastRow;
    if (lastRow < firstRow) return taxOpsCopySkip_(copy, 'NO_ROWS');
    var range = sheet.getRange(firstRow, column, lastRow - firstRow + 1, 1);
    var summary = taxOpsValidationReport_(range, firstRow);
    copy.groups = summary.groups;
    copy.truncated = summary.truncated;
    copy.rows = summary.rows;
    copy.valueRows = summary.valueRows;
    copy.otherValues = summary.otherValues;
    copy.otherValueRows = summary.otherValueRows || [];
    copy.otherValueRowCount = summary.otherValueRowCount || 0;
    copy.allowInvalid = summary.allowInvalid;
    copy.brokenRows = summary.brokenRows;
    copy.status = taxOpsCopyAlreadySet_(summary, names, firstRow, lastRow) ?
      'ALREADY_SET' : 'NEEDS_UPDATE';
    return {range: range, summary: summary, values: summary.values};
  } catch (error) {
    return taxOpsCopySkip_(copy, 'READ_FAILED');
  }
}

/** もう 30 個の一覧が 1 組で付いているか（§9.6.3 の `ALREADY_SET`）。 */
function taxOpsCopyAlreadySet_(summary, names, firstRow, lastRow) {
  if (summary.groups.length !== 1) return false;
  var group = summary.groups[0];
  if (group.from !== firstRow || group.to !== lastRow) return false;
  if (group.broken || group.type !== 'VALUE_IN_LIST') return false;
  if (!Array.isArray(group.values) || group.values.length !== names.length) return false;
  for (var index = 0; index < names.length; index += 1) {
    if (group.values[index] !== names[index]) return false;
  }
  // 要約全体の `allowInvalid` は読めない行があると `true` になるので、組の値だけを見る。
  return typeof group.allowInvalid === 'boolean';
}

/** 報告の並び（§9.6.2。転記シートの ID の昇順、同じ ID ならシート名の昇順）。 */
function taxOpsCopySort_(copies) {
  copies.sort(function(a, b) {
    if (a.spreadsheetId === b.spreadsheetId) {
      if (a.sheetName === b.sheetName) return 0;
      return a.sheetName < b.sheetName ? -1 : 1;
    }
    return a.spreadsheetId < b.spreadsheetId ? -1 : 1;
  });
}

/** 報告の件数（§9.6.4）。 */
function taxOpsCopyCounts_(report) {
  var counts = {alreadySet: 0, needsUpdate: 0, skipped: 0, applied: 0, notReached: 0,
    beforeStart: Number(report.counts && report.counts.beforeStart) || 0};
  report.copies.forEach(function(copy) {
    if (copy.status === 'ALREADY_SET') counts.alreadySet += 1;
    else if (copy.status === 'SKIPPED') counts.skipped += 1;
    else if (copy.status === 'APPLIED') counts.applied += 1;
    else if (copy.status === 'NOT_REACHED') counts.notReached += 1;
    else counts.needsUpdate += 1;
  });
  report.counts = counts;
  report.applied = counts.applied > 0 && report.stoppedBy === null;
}

/** まだ書いていない組を `NOT_REACHED` にする（§9.6.5）。 */
function taxOpsCopyRemaining_(copies, from) {
  for (var index = from; index < copies.length; index += 1) {
    if (copies[index].status === 'NEEDS_UPDATE') copies[index].status = 'NOT_REACHED';
  }
}

/**
 * ロックの中の 1 組（§9.6.5 の 2）。確かめ直し → 監査 → 規則 → 読み返し。
 * 続けるときは `null`、全体を止めるときは理由のコードを返す。
 */
function taxOpsCopyApply_(copy, customer, templateParentId, report, column, names, rule, actor) {
  var checked = null;
  try {
    checked = taxOpsCopyCheck_(copy, customer, templateParentId, report.headerRow, column,
      names, rule);
  } catch (error) {
    copy.problem = 'READ_FAILED';
    return null;
  }
  if (!checked || copy.status !== 'NEEDS_UPDATE') return null;
  var range = checked.range;
  // このやり直しで読んだ G の値を控える（読み直さない）。
  var values = checked.values;
  try {
    copy.auditId = taxOpsAudit_({
      type: 'SETTING',
      actor: actor,
      targetType: 'DESTINATION',
      targetId: copy.spreadsheetId,
      customerId: report.customerId,
      before: {sheetName: copy.sheetName, firstRow: copy.firstRow, lastRow: copy.lastRow,
        groups: copy.groups.map(function(group) {
          var plainGroup = {};
          Object.keys(group).forEach(function(key) {
            if (key !== 'key') plainGroup[key] = group[key];
          });
          return plainGroup;
        }),
        truncated: copy.truncated, valueRows: copy.valueRows,
        brokenRows: copy.brokenRows},
      after: {column: columnLetter_(column), firstRow: copy.firstRow, lastRow: copy.lastRow,
        allowInvalid: copy.allowInvalid, count: names.length},
      reason: 'TAX_VALIDATION_COPY'
    });
    SpreadsheetApp.flush();
  } catch (error) {
    copy.problem = 'AUDIT_WRITE_FAILED';
    return 'AUDIT_WRITE_FAILED';
  }
  // 監査が書けたら、その ID をすぐ控える（後に書込・読み返しで止まっても報告に残す）。
  report.auditIds.push(copy.auditId);
  try {
    var validation = SpreadsheetApp.newDataValidation()
      .requireValueInList(names, true)
      .setAllowInvalid(copy.allowInvalid)
      .build();
    range.setDataValidation(validation);
  } catch (error) {
    copy.problem = 'WRITE_FAILED';
    return 'WRITE_FAILED';
  }
  var expected = JSON.stringify(['VALUE_IN_LIST', names, copy.allowInvalid]);
  var validations = null;
  try { validations = range.getDataValidations(); } catch (error) {
    copy.problem = 'WRITE_VERIFY_FAILED';
    return 'WRITE_VERIFY_FAILED';
  }
  var ok = validations.length === copy.lastRow - copy.firstRow + 1 &&
    validations.every(function(row) {
      var summary = taxOpsValidationSummary_(row && row[0] ? row[0] : null);
      return JSON.stringify([summary.type, summary.values, summary.allowInvalid]) === expected;
    });
  if (!ok) {
    copy.problem = 'WRITE_VERIFY_FAILED';
    return 'WRITE_VERIFY_FAILED';
  }
  var afterValues = null;
  try { afterValues = range.getValues(); } catch (error) {
    copy.problem = 'VALUES_CHANGED';
    return 'VALUES_CHANGED';
  }
  if (JSON.stringify(afterValues) !== JSON.stringify(values)) {
    copy.problem = 'VALUES_CHANGED';
    return 'VALUES_CHANGED';
  }
  copy.status = 'APPLIED';
  copy.verified = true;
  return null;
}

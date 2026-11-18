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

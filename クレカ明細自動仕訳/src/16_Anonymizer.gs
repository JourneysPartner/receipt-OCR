'use strict';

/**
 * 4.12.7 匿名化規則 `ANONYMIZE_V1`（仕様20.4・INV-36）。
 *
 * **構造とパーサーの挙動を維持したまま、顧客を識別し得る情報を除去する。**
 * コーパスは全システム管理者の参照先であり、ここを通ったものが恒久的に
 * 残る。除去し損ねた情報は、後から気づいても既に共有された後である。
 *
 * 同時に、**除去対象以外を1文字も変えない**ことが等しく重要である。
 * 利用日・金額・利用店名・見出し・合計行を改変すると、抽出・除外・年補完・
 * 照合式の挙動が実ファイルと変わり、そのサンプルで回帰を取る意味が失われる。
 */

var ANONYMIZE_VERSION_ = '1';

/** 規則1b：短い会員番号を除去する対象とみなす見出し語。 */
var MEMBER_ID_HEADER_WORDS_ = Object.freeze(['会員', '番号', 'ID', 'カードNO', 'お客様']);

/** 規則2：氏名として空欄にする対象とみなす見出し語。 */
var NAME_HEADER_WORDS_ = Object.freeze([
  'カード名称', '氏名', '会員氏名', 'ご本人', 'カード会員', '本人', '名義', 'ご契約者'
]);

/** 同じ文字数の`0`へ置き換える（桁数と列幅を保つため）。 */
function maskDigits_(text) {
  return String(text).replace(/\d/g, '0');
}

/**
 * 規則1：12文字以上の連続する数字（間の`-`・半角空白を含む）。
 *
 * カード番号を除去しつつ桁数と列幅を保つ。区切り文字は残す ── 桁区切りの
 * 形が変わると列幅が変わり、固定長で読む形式の挙動が変わり得る。
 */
function maskLongDigitRuns_(text) {
  return String(text).replace(/\d[\d\-\s]{10,}\d/g, function(run) {
    return (run.match(/\d/g) || []).length >= 12 ? maskDigits_(run) : run;
  });
}

/**
 * 規則1c：メールアドレスの形。列を限定せず全セルを対象とする。
 *
 * `@`と`.`は残す。形が保たれていれば、その列を「メールの列」と判定する
 * 形式定義があっても挙動が変わらない。
 */
function maskEmails_(text) {
  return String(text).replace(/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+/g, function(address) {
    return address.replace(/[A-Za-z0-9_-]/g, 'x');
  });
}

/**
 * 規則1d：電話番号の形（`0`始まり・数字部分が10桁か11桁）。
 *
 * `0570-…`のような番号は利用店名欄にも現れる。列を限定しない。
 */
function maskPhoneNumbers_(text) {
  return String(text).replace(/0[\d\-()\s]{8,}\d/g, function(run) {
    var digits = (run.match(/\d/g) || []).length;
    return digits === 10 || digits === 11 ? maskDigits_(run) : run;
  });
}

/** 規則1b：4〜11桁の連続数字（会員番号列に限る）。 */
function maskShortIdRun_(text) {
  return String(text).replace(/\d{4,11}/g, function(run) {
    return maskDigits_(run);
  });
}

function headerMentions_(headerText, words) {
  var normalized = normalizeMerchant(String(headerText || ''));
  if (!normalized) return false;
  return words.some(function(word) {
    return normalized.indexOf(normalizeMerchant(word)) >= 0;
  });
}

/**
 * 見出し行から、規則1b・規則2の対象列を求める。
 *
 * @return {{memberIdColumns: !Object, nameColumns: !Object}} 列番号をキーとする集合
 */
function classifyAnonymizeColumns(headerCells) {
  var memberIdColumns = {};
  var nameColumns = {};
  (headerCells || []).forEach(function(cell, index) {
    var column = index + 1;
    // 氏名列を先に判定する。「カード会員氏名」は双方の語を含むが、
    // 空欄にするほうが強い除去である。
    if (headerMentions_(cell, NAME_HEADER_WORDS_)) nameColumns[column] = true;
    else if (headerMentions_(cell, MEMBER_ID_HEADER_WORDS_)) memberIdColumns[column] = true;
  });
  return {memberIdColumns: memberIdColumns, nameColumns: nameColumns};
}

/**
 * 1セルへ`ANONYMIZE_V1`を適用する。
 *
 * @param {*} value
 * @param {!Object} context column, memberIdColumns, nameColumns, extraMasks
 * @return {*} 置換後の値。対象外なら入力をそのまま返す。
 */
function anonymizeCell(value, context) {
  context = context || {};
  var column = context.column;

  // 規則2b：操作者が指定した追加マスク。機械規則より優先する ──
  // 操作者は匿名化結果を実際に見たうえで指定している。
  var extra = (context.extraMasks || {})[column];
  if (extra === 'BLANK') return '';
  if (extra === 'ZERO') return maskDigits_(value);

  // 規則2：氏名列は空文字列にする。桁数を保つ意味がない。
  if ((context.nameColumns || {})[column]) return '';

  if (value === null || value === undefined) return value;

  // 数値型セルに入った番号を素通りさせない。XLSX/CSVの取込では番号列が
  // 数値化されることが普通にあり、文字列だけを対象にすると数値型の
  // カード番号・会員番号がそのままコーパスへ入る。型は保つ ── 文字列化
  // すると数値列が文字列列になり、型プロファイルの形式判定が変わる。
  // 数値に先頭ゼロは存在しないので、マスク結果は 0 とする（桁幅より
  // 情報の除去を優先する）。
  if (typeof value === 'number') {
    var digitCount = String(Math.abs(Math.trunc(value))).length;
    if (digitCount >= 12) return 0;                                   // 規則1
    if ((context.memberIdColumns || {})[column] &&
        digitCount >= 4 && digitCount <= 11) return 0;                // 規則1b
    return value;
  }
  if (typeof value !== 'string') return value;

  var text = value;
  text = maskEmails_(text);          // 規則1c
  text = maskPhoneNumbers_(text);    // 規則1d
  text = maskLongDigitRuns_(text);   // 規則1
  if ((context.memberIdColumns || {})[column]) {
    text = maskShortIdRun_(text);    // 規則1b
  }
  return text;
}

/**
 * 表全体へ`ANONYMIZE_V1`を適用する。
 *
 * 見出し行は変更しない ── 見出しは判定材料であり、変えると形式判定と
 * 列の対応が実ファイルと変わる。
 *
 * @param {!Array<!Array>} rows
 * @param {!Object} options headerRows（1始まり）, extraMasks
 * @return {{rows: !Array<!Array>, maskedCells: number}}
 */
function anonymizeRows(rows, options) {
  if (!Array.isArray(rows)) throw new TypeError('anonymizeRows requires rows');
  options = options || {};
  var headerRows = options.headerRows && options.headerRows.length
    ? options.headerRows : [1];
  // 2段ヘッダーでは対象列の名前が上段にあることがある。最終行だけを見ると
  // 「会員番号」が上段にある形式で列判定が漏れ、番号が素通りする。
  // 全ヘッダー行を縦に連結して分類する（列ごとに文字列を繋ぐ）。
  var width = rows.reduce(function(max, cells) {
    return Math.max(max, (cells || []).length);
  }, 0);
  var headerCells = [];
  for (var column = 0; column < width; column += 1) {
    headerCells.push(headerRows.map(function(rowNumber) {
      return String((rows[rowNumber - 1] || [])[column] || '');
    }).join(' '));
  }
  var columns = classifyAnonymizeColumns(headerCells);
  var maskedCells = 0;

  var output = rows.map(function(cells, index) {
    if (headerRows.indexOf(index + 1) >= 0) return (cells || []).slice();
    return (cells || []).map(function(value, offset) {
      var masked = anonymizeCell(value, {
        column: offset + 1,
        memberIdColumns: columns.memberIdColumns,
        nameColumns: columns.nameColumns,
        extraMasks: options.extraMasks
      });
      if (masked !== value) maskedCells += 1;
      return masked;
    });
  });

  return {rows: output, maskedCells: maskedCells, version: ANONYMIZE_VERSION_};
}

/**
 * 匿名化ファイルの名前（規則4）。
 *
 * 元ファイル名部分を改変しない。請求年月抽出と使用用途補完は台帳I列
 * （判定用ファイル名）を使うため、ここで名前を変えると推定が変わる。
 */
function anonymizedFileName(sampleId, originalFileName) {
  if (!sampleId || !originalFileName) {
    throw new TypeError('anonymizedFileName requires a sample id and the original name');
  }
  return String(sampleId) + '__' + String(originalFileName);
}

/**
 * 判定用ファイル名（台帳I列）。
 *
 * 元ファイル名に電話番号やメールアドレスの形が含まれる場合は、そちらにも
 * 同じ置換を適用する（規則4）。ファイル名は台帳に平文で残るため。
 */
function detectionFileName(originalFileName) {
  return maskPhoneNumbers_(maskEmails_(String(originalFileName || '')));
}

/**
 * XLSXの必須検証（A-14）。
 *
 * **置換の前後で抽出結果が一致することを確認する。** XLSXは変換往復を
 * 行わずセル値だけを置換するが、それでも構造が変わっていないことを
 * 実際の抽出で確かめる。一致しなければ匿名化を破棄する ── 構造が変われば
 * 「実構造サンプル」ではなくなり、そのサンプルで取る回帰に意味がない。
 *
 * **元利用店名は照合しない。** 規則2・2bで空になり得るため。
 */
function verifyAnonymizedStructure(before, after) {
  if (!before || !after) {
    throw new TypeError('verifyAnonymizedStructure requires both extractions');
  }
  var differences = [];

  var beforeTxs = before.transactions || [];
  var afterTxs = after.transactions || [];
  if (beforeTxs.length !== afterTxs.length) {
    differences.push({item: 'transactionCount',
      expected: beforeTxs.length, actual: afterTxs.length});
  }
  beforeTxs.forEach(function(tx, index) {
    var other = afterTxs[index] || {};
    ['occurrenceIndex', 'dateHashKey', 'amountBillingJpy', 'purpose'].forEach(function(key) {
      if (String(tx[key]) !== String(other[key])) {
        differences.push({item: key, rowNumber: tx.sourceRow || null,
          expected: tx[key], actual: other[key] === undefined ? null : other[key]});
      }
    });
  });

  var excludedKey = function(result) {
    return (result.excludedRows || []).map(function(row) {
      return row.rowNumber + ':' + row.reason;
    }).sort().join(',');
  };
  if (excludedKey(before) !== excludedKey(after)) {
    differences.push({item: 'excludedRows',
      expected: excludedKey(before), actual: excludedKey(after)});
  }

  var billingBefore = before.billingMonth || {};
  var billingAfter = after.billingMonth || {};
  if (String(billingBefore.status) !== String(billingAfter.status) ||
      String(billingBefore.yearMonth) !== String(billingAfter.yearMonth)) {
    differences.push({item: 'billingMonth',
      expected: billingBefore.status + '/' + billingBefore.yearMonth,
      actual: billingAfter.status + '/' + billingAfter.yearMonth});
  }

  return {
    ok: differences.length === 0,
    code: differences.length ? 'SAMPLE_ANONYMIZE_STRUCTURE_CHANGED' : null,
    differences: differences
  };
}

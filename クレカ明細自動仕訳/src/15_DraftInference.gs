'use strict';

/**
 * 4.12.1 サンプルからの下書き生成。
 *
 * 匿名化サンプル1件から、確認ダイアログの既定値を推定する。
 * **シートへ書き込まない。** 推定できなかった項目は`unresolved`へ入れ、
 * 操作者に必ず答えさせる ── 当て推量を既定値として提示すると、操作者は
 * それを見て「合っている」と判断してしまう。
 */

/**
 * 明細候補行か（4.12.1 用語）。
 *
 * **日付として解釈できるセルと数値として解釈できるセルを1つずつ持つ行。**
 * カード明細の1行は必ずこの2つを持つ、という性質だけに頼る。列位置や
 * 見出し語に頼らないので、未知の形式でも判定できる。
 */
function isDetailCandidateRow_(cells) {
  var hasDate = false;
  var hasNumber = false;
  (cells || []).forEach(function(cell) {
    if (looksLikeDate_(cell)) hasDate = true;
    else if (looksLikeNumber_(cell)) hasNumber = true;
  });
  return hasDate && hasNumber;
}

/** 見出し候補行か。非空セルが2つ以上あり、どれも日付にも数値にも見えない行。 */
function isHeaderCandidateRow_(cells) {
  var nonEmpty = (cells || []).filter(function(cell) {
    return cell !== null && cell !== undefined && String(cell).trim() !== '';
  });
  if (nonEmpty.length < 2) return false;
  return nonEmpty.every(function(cell) {
    return !looksLikeDate_(cell) && !looksLikeNumber_(cell);
  });
}

function looksLikeDate_(cell) {
  if (cell instanceof Date) return true;
  if (cell === null || cell === undefined) return false;
  var text = String(cell).trim();
  if (!text) return false;
  return /^\d{2,4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?$/.test(text) ||
    /^\d{1,2}[-/月.]\d{1,2}日?$/.test(text);
}

function looksLikeNumber_(cell) {
  if (typeof cell === 'number') return Number.isFinite(cell);
  if (cell === null || cell === undefined) return false;
  var text = String(cell).trim().replace(/[,¥￥]/g, '');
  if (!text) return false;
  return /^-?\d+(\.\d+)?$/.test(text);
}

function nonEmptyCount_(cells) {
  return (cells || []).filter(function(cell) {
    return cell !== null && cell !== undefined && String(cell).trim() !== '';
  }).length;
}

/**
 * サンプルから回答候補を推定する。
 *
 * @param {!Object} sample
 *   fileName, sheetName, rows（走査範囲の二次元配列）, registeredKeywords（弁別語の語彙）
 * @return {!Object} 2.1.2.7の回答候補と`unresolved`
 */
function inferDraftFromSample(sample) {
  if (!sample || !Array.isArray(sample.rows)) {
    throw new TypeError('inferDraftFromSample requires a sample with rows');
  }
  var scanRows = Number(SETTINGS.SAMPLE_INFER_SCAN_ROWS || 30);
  var sampleRows = Number(SETTINGS.SAMPLE_INFER_SAMPLE_ROWS || 20);
  var rows = sample.rows.slice(0, scanRows);
  var unresolved = [];

  // 手順1：ファイル種別は拡張子から。同じ発行会社がCSVとXLSXの双方を
  // 出す場合は操作者が質問1で足す。
  var fileTypes = /\.xlsx$/i.test(String(sample.fileName || '')) ? ['xlsx'] : ['csv'];

  // 手順4：ヘッダー行。**「直後に明細が続くこと」を主、「幅が広いこと」を従**
  // とする（B-M8）。逆にすると、下部の注記ブロックが本物のヘッダーより
  // 幅広い形式で注記行が選ばれ、データ開始行がその後ろになり、
  // 明細候補行が1行も見つからず全推定が崩れる。
  var scored = [];
  rows.forEach(function(cells, index) {
    if (!isHeaderCandidateRow_(cells)) return;
    var following = rows.slice(index + 1, index + 1 + sampleRows)
      .filter(isDetailCandidateRow_).length;
    scored.push({
      rowNumber: index + 1,
      score: following * 100 + Math.min(nonEmptyCount_(cells), 99),
      nonEmpty: nonEmptyCount_(cells)
    });
  });

  var headerRows = [];
  var primary = null;
  if (!scored.length) {
    unresolved.push('headerRows');
  } else {
    primary = scored.reduce(function(best, item) {
      if (!best) return item;
      if (item.score > best.score) return item;
      // 同点は行番号の小さい方
      return item.score === best.score && item.rowNumber < best.rowNumber ? item : best;
    }, null);
    headerRows = [primary.rowNumber];
    // 直前の行も見出し候補で、幅が primary 以下なら2段ヘッダーとみなす。
    for (var back = 1; back <= 2; back += 1) {
      var above = scored.filter(function(item) {
        return item.rowNumber === primary.rowNumber - back;
      })[0];
      if (!above || above.nonEmpty > primary.nonEmpty) break;
      headerRows.unshift(above.rowNumber);
    }
  }

  // 手順5：データ開始行はヘッダーより後の最初の明細候補行。
  var headerLast = headerRows.length ? Math.max.apply(null, headerRows) : 0;
  var dataStartRow = null;
  for (var r = headerLast; r < rows.length; r += 1) {
    if (isDetailCandidateRow_(rows[r])) { dataStartRow = r + 1; break; }
  }
  if (!dataStartRow) unresolved.push('dataStartRow');

  // 手順6：列の型。データ開始行以降の明細候補行から求める。
  var detailRows = dataStartRow
    ? rows.slice(dataStartRow - 1).filter(isDetailCandidateRow_).slice(0, sampleRows)
    : [];
  var width = rows.reduce(function(max, cells) {
    return Math.max(max, (cells || []).length);
  }, 0);
  var columnTypes = [];
  for (var column = 0; column < width; column += 1) {
    columnTypes.push({
      column: column + 1,
      type: inferColumnType_(detailRows, column),
      required: false          // 手順6の既定。3列だけ後で真にする（B-M9）
    });
  }

  var dateColumn = firstColumnOfType_(columnTypes, 'date');
  var merchantColumn = firstColumnOfType_(columnTypes, 'text');
  var amountColumn = largestNumberColumn_(columnTypes, detailRows);
  if (!dateColumn) unresolved.push('dateColumn');
  if (!amountColumn) unresolved.push('amountColumn');
  if (!merchantColumn) unresolved.push('merchantColumn');

  // `required` を真にするのは日付・利用店名・金額の3列だけ（B-M9）。
  // 取得した全行でたまたま非空だった列まで必須にすると、過学習した定義に
  // なり、同じ形式の別の月のファイルが「必須列が空」で落ちる。
  [dateColumn, merchantColumn, amountColumn].forEach(function(column) {
    if (!column) return;
    columnTypes[column - 1].required = true;
  });

  var headerCells = headerRows.reduce(function(cells, rowNumber) {
    return cells.concat(rows[rowNumber - 1] || []);
  }, []);
  var purposeColumn = headerColumnMatching_(rows, headerRows, function(text) {
    return text === '使用用途';
  });

  // 手順6'：外貨の3列。**見つからなくても`unresolved`へ入れない**
  // （任意項目であり、取得できないことを問題として提示しない。INV-38）。
  // 見出し語も**同じ正規化を通してから**比べる。4.16は長音記号（ー）を
  // ハイフンへ寄せるので（INV-42）、`換算レート`と書かれた見出しは
  // `換算レ-ト`になる。生の語と突き合わせると永久に一致しない。
  var amountOriginalColumn = headerColumnMatchingAny_(rows, headerRows,
    ['現地通貨額', '海外利用額', '利用金額(現地)']);
  var exchangeRateColumn = headerColumnMatchingAny_(rows, headerRows,
    ['換算レート', '為替レート', 'レート']);
  // 通貨コードは現地通貨額より後に判定する。`現地通貨額`は`現地通貨`を
  // 含むため、先に通貨として拾うと金額列を奪う。
  var currencyColumn = headerColumnMatchingAny_(rows, headerRows,
    ['通貨コード', '通貨', '現地通貨'], [amountOriginalColumn, exchangeRateColumn]);

  // 手順7：判定キーワードはヘッダー行の非空セルから最大8個。
  var keywords = headerCells
    .map(function(cell) { return normalizeMerchant(String(cell || '')); })
    .filter(function(text) { return text.length >= 2; })
    .slice(0, 8);

  // 弁別語は**カード形式マスターF列の登録済み語彙**と重ならない語である
  // （B-M17）。他サンプルの本体を読む定義にすると、入力がサンプル1件で
  // ある前提と矛盾し、コーパスが1件増えるだけで同じサンプルから違う
  // 下書きが出る。
  var known = {};
  (sample.registeredKeywords || []).forEach(function(word) {
    known[normalizeMerchant(String(word))] = true;
  });
  var distinctiveKeywords = [];
  rows.forEach(function(cells) {
    (cells || []).forEach(function(cell) {
      var text = normalizeMerchant(String(cell || ''));
      if (text.length < 2 || known[text]) return;
      if (distinctiveKeywords.indexOf(text) >= 0) return;
      if (distinctiveKeywords.length < 4) distinctiveKeywords.push(text);
    });
  });

  // 手順8：除外範囲は**データ開始行の直前まで**（B-M4）。
  // ヘッダー行までにすると、ヘッダー直後の「前月お支払金額」行が除外されず、
  // 取引として行を確保してしまう。
  var excludeRowRanges = dataStartRow && dataStartRow > 1
    ? [{from: 1, to: dataStartRow - 1}] : [];
  var exclusionLabels = inferExclusionLabels_(rows, dataStartRow, dateColumn);

  // 手順9：合計行。値の列は特定できないので操作者に選ばせる（B-M5）。
  var totalLabel = exclusionLabels.filter(function(item) {
    return item.label.indexOf('合計') >= 0;
  })[0];
  var totalRow = null;
  if (totalLabel) {
    totalRow = {labelColumn: totalLabel.column, valueColumn: null, label: '合計'};
    unresolved.push('totalRow.valueColumn');
  }

  // 手順10：請求年月の取得元。種パターンを id 順に当てる。
  var billingMonthSourceIds = matchBillingMonthSeeds_(sample.fileName, rows);

  return {
    fileTypes: fileTypes,
    sheetName: sample.sheetName || '',
    headerRows: headerRows,
    dataStartRow: dataStartRow,
    columnTypes: columnTypes,
    dateColumn: dateColumn, amountColumn: amountColumn,
    merchantColumn: merchantColumn, purposeColumn: purposeColumn,
    currencyColumn: currencyColumn,
    amountOriginalColumn: amountOriginalColumn,
    exchangeRateColumn: exchangeRateColumn,
    keywords: keywords, keywordMinMatch: keywords.length,
    distinctiveKeywords: distinctiveKeywords,
    exclusionLabels: exclusionLabels, excludeRowRanges: excludeRowRanges,
    totalRow: totalRow,
    billingMonthSourceIds: billingMonthSourceIds,
    billingMonthAbsent: billingMonthSourceIds.length === 0,
    billingMonthCustomSources: [],
    unresolved: unresolved
  };
}

function inferColumnType_(detailRows, columnIndex) {
  if (!detailRows.length) return 'any';
  var cells = detailRows.map(function(row) { return (row || [])[columnIndex]; });
  if (cells.every(looksLikeDate_)) return 'date';
  if (cells.every(looksLikeNumber_)) return 'number';
  var allText = cells.every(function(cell) {
    return cell !== null && cell !== undefined && String(cell).trim() !== '' &&
      !looksLikeDate_(cell) && !looksLikeNumber_(cell);
  });
  return allText ? 'text' : 'any';
}

function firstColumnOfType_(columnTypes, type) {
  var hit = columnTypes.filter(function(item) { return item.type === type; })[0];
  return hit ? hit.column : null;
}

/** 金額列は、数値列のうち**絶対値の合計が最大**の列。同値は最も左。 */
function largestNumberColumn_(columnTypes, detailRows) {
  var best = null;
  columnTypes.forEach(function(item) {
    if (item.type !== 'number') return;
    var total = detailRows.reduce(function(sum, row) {
      var raw = String((row || [])[item.column - 1] || '').replace(/[,¥￥]/g, '');
      return sum + Math.abs(Number(raw) || 0);
    }, 0);
    if (!best || total > best.total) best = {column: item.column, total: total};
  });
  return best ? best.column : null;
}

/**
 * 見出し行から、指定語のいずれかを含む列を探す。
 *
 * 探す語も見出しも4.16で正規化してから比べる。`exclude`に挙げた列は
 * 対象外にする（語の包含関係で列を奪い合うのを防ぐ）。
 */
function headerColumnMatchingAny_(rows, headerRows, words, exclude) {
  var normalized = words.map(function(word) { return normalizeMerchant(word); });
  var skip = (exclude || []).filter(function(column) { return column; });
  return headerColumnMatching_(rows, headerRows, function(text, column) {
    if (skip.indexOf(column) >= 0) return false;
    return normalized.some(function(word) { return text.indexOf(word) >= 0; });
  });
}

function headerColumnMatching_(rows, headerRows, predicate) {
  var found = null;
  headerRows.forEach(function(rowNumber) {
    (rows[rowNumber - 1] || []).forEach(function(cell, index) {
      if (found) return;
      var text = normalizeMerchant(String(cell || ''));
      if (text && predicate(text, index + 1)) found = index + 1;
    });
  });
  return found;
}

/**
 * 除外ラベルを推定する。
 *
 * 対象は**データ開始行以降で日付列が空または日付に見えない行**である。
 * 日付を持つ行は明細なので、そこに「手数料」等の語があっても除外しない。
 */
function inferExclusionLabels_(rows, dataStartRow, dateColumn) {
  if (!dataStartRow) return [];
  var occurrences = {};
  rows.slice(dataStartRow - 1).forEach(function(cells) {
    var dateCell = dateColumn ? (cells || [])[dateColumn - 1] : null;
    if (dateColumn && looksLikeDate_(dateCell)) return;
    (cells || []).forEach(function(cell, index) {
      var text = String(cell || '');
      if (!text.trim()) return;
      EXCLUSION_LABEL_SEEDS.forEach(function(seed) {
        if (text.indexOf(seed) < 0) return;
        if (!occurrences[seed]) occurrences[seed] = {};
        var column = index + 1;
        occurrences[seed][column] = (occurrences[seed][column] || 0) + 1;
      });
    });
  });

  return Object.keys(occurrences).map(function(label) {
    var byColumn = occurrences[label];
    // 同じ列に2回以上現れる語だけ列を固定する。1回きりなら行全体照合に
    // しておく ── たまたまその位置にあっただけの可能性がある。
    var repeated = Object.keys(byColumn).filter(function(column) {
      return byColumn[column] >= 2;
    });
    return {
      label: label,
      column: repeated.length === 1 ? Number(repeated[0]) : null,
      onlyWhenDateEmpty: true
    };
  });
}

/** 種パターンを id 順に当て、一致したものの id を返す。 */
function matchBillingMonthSeeds_(fileName, rows) {
  var scanText = rows.map(function(cells) {
    return (cells || []).map(function(cell) { return String(cell || ''); }).join(' ');
  }).join('\n');

  return BILLING_MONTH_PATTERN_SEEDS.filter(function(seed) {
    var target = seed.kind === 'fileName' ? String(fileName || '') : scanText;
    return new RegExp(seed.pattern).test(target);
  }).map(function(seed) { return seed.id; });
}

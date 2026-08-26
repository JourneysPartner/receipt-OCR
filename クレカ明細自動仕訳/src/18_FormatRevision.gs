'use strict';

/**
 * 4.12.6 形式の改訂（カード会社の出力変更・仕様18.5）。
 *
 * 対応済みの形式について、現在の定義では扱えない新しいサンプルが届いた
 * 場合の経路である。典型はカード会社がエクスポート様式を変えた場合。
 *
 * **改訂が要るかどうかを操作者の印象で決めない。** 6条件のいずれかが
 * 成立するかで決める。要らないのに改訂すると、定義が増えるだけ判定衝突の
 * 危険が上がる。要るのに改訂しないと、顧客のファイルが本番で止まる。
 */

/**
 * 改訂が必要か（4.12.6 の6条件）。
 *
 * @param {!Object} input
 *   detection {matched}, extraction {transactions[], excludedRows[],
 *   reconciliation, billingMonth}, operator（操作者が実ファイルを見て答えた内容）,
 *   formatHasReconciliation（形式のQ列が空欄でないか）
 * @return {{required: boolean, conditions: !Array<!Object>}}
 */
function assessRevisionNeed(input) {
  if (!input || !input.extraction) {
    throw new TypeError('assessRevisionNeed requires an extraction result');
  }
  var extraction = input.extraction;
  var operator = input.operator || {};
  var conditions = [];

  // 条件a：現在の定義で形式判定が成立しない。
  if (!(input.detection && input.detection.matched === true)) {
    conditions.push({code: 'a', item: 'detection',
      detail: 'the current definition no longer matches this file'});
  }

  var transactions = extraction.transactions || [];

  // 条件b：抽出件数が、操作者が数えた明細行数と異なる。
  if (operator.detailRowCount !== undefined && operator.detailRowCount !== null &&
      Number(operator.detailRowCount) !== transactions.length) {
    conditions.push({code: 'b', item: 'transactionCount',
      expected: Number(operator.detailRowCount), actual: transactions.length});
  }

  // 条件c：除外された行に、操作者が取引だと判断した行が含まれる。
  var excludedRowNumbers = (extraction.excludedRows || []).map(function(row) {
    return Number(row.rowNumber);
  });
  (operator.rowsThatAreTransactions || []).forEach(function(rowNumber) {
    if (excludedRowNumbers.indexOf(Number(rowNumber)) >= 0) {
      conditions.push({code: 'c', item: 'excludedRow', rowNumber: Number(rowNumber),
        detail: 'a real transaction was excluded'});
    }
  });

  // 条件d：抽出された取引に、操作者が取引ではないと判断した行が含まれる。
  var extractedRowNumbers = transactions.map(function(tx) { return Number(tx.sourceRow); });
  (operator.rowsThatAreNotTransactions || []).forEach(function(rowNumber) {
    if (extractedRowNumbers.indexOf(Number(rowNumber)) >= 0) {
      conditions.push({code: 'd', item: 'extractedRow', rowNumber: Number(rowNumber),
        detail: 'a total or payment line was booked as a transaction'});
    }
  });

  // 条件e：照合式が不成立、または請求年月が確定しない。
  // **形式のQ列が空欄なら対象外**（請求年月を持たない形式は正常である）。
  var reconciliation = extraction.reconciliation || {};
  if (reconciliation.ok === false) {
    conditions.push({code: 'e', item: 'reconciliation', detail: 'the check expression failed'});
  }
  if (input.formatHasReconciliation !== false) {
    var billing = extraction.billingMonth || {};
    if (String(billing.status) !== 'RESOLVED') {
      conditions.push({code: 'e', item: 'billingMonthStatus', actual: billing.status});
    }
  }

  // 条件f：明細行の値が、操作者が実ファイルで確認した値と異なる。
  (operator.rowValues || []).forEach(function(expected) {
    var actual = transactions.filter(function(tx) {
      return Number(tx.sourceRow) === Number(expected.sourceRow);
    })[0];
    if (!actual) return;   // 件数の不一致は条件bが扱う
    ['date', 'amountBillingJpy', 'merchant', 'purpose'].forEach(function(item) {
      if (expected[item] === undefined) return;
      if (String(expected[item]) === String(actual[item])) return;
      conditions.push({code: 'f', item: item, rowNumber: Number(expected.sourceRow),
        expected: expected[item], actual: actual[item] === undefined ? null : actual[item]});
    });
  });

  return {required: conditions.length > 0, conditions: conditions};
}

/**
 * 改訂の確認ダイアログの初期値を作る（手順3・B-M13）。
 *
 * **最初から13問を答え直させない。** 前回の回答（AB列）を初期値として
 * 提示し、差分だけを答え直してもらう。全問を再入力させると、変わっていない
 * 項目まで打ち直すことになり、そこで生じた打ち間違いが定義に入る。
 *
 * AB列が空欄の行（初期4形式など）は、定義から回答を逆導出して初期値とする。
 */
function buildRevisionAnswers(previousAnswers, definition) {
  var base = previousAnswers && Object.keys(previousAnswers).length
    ? previousAnswers : deriveAnswersFromDefinition(definition);
  return {
    answers: JSON.parse(JSON.stringify(base)),
    source: previousAnswers && Object.keys(previousAnswers).length
      ? 'PREVIOUS_ANSWERS' : 'DERIVED_FROM_DEFINITION'
  };
}

/**
 * 定義から回答を逆導出する（B-M13）。
 *
 * 初期4形式にはAB列（前回の回答）が無い。それらを改訂しようとしたときに
 * 「初期値なし」で13問を全部答え直させると、既存の定義と食い違う回答が
 * 混じる余地が生まれる。定義そのものから導けるものは導く。
 */
function deriveAnswersFromDefinition(definition) {
  var format = definition || {};
  return {
    fileTypes: (format.fileTypes || []).slice(),
    sheetName: format.sheetName || '',
    headerRows: (format.headerRows || []).slice(),
    dataStartRow: format.dataStartRow === undefined ? null : format.dataStartRow,
    columnTypes: JSON.parse(JSON.stringify(format.columnTypes || [])),
    dateColumn: format.dateColumn === undefined ? null : format.dateColumn,
    amountColumn: format.amountColumn === undefined ? null : format.amountColumn,
    merchantColumn: format.merchantColumn === undefined ? null : format.merchantColumn,
    purposeColumn: format.purposeColumn === undefined ? null : format.purposeColumn,
    currencyColumn: format.currencyColumn === undefined ? null : format.currencyColumn,
    amountOriginalColumn: format.amountOriginalColumn === undefined
      ? null : format.amountOriginalColumn,
    exchangeRateColumn: format.exchangeRateColumn === undefined
      ? null : format.exchangeRateColumn,
    keywords: (format.keywords || []).slice(),
    keywordMinMatch: format.keywordMinMatch === undefined ? null : format.keywordMinMatch,
    distinctiveKeywords: (format.distinctiveKeywords || []).slice(),
    exclusionLabels: JSON.parse(JSON.stringify(format.exclusionLabels || [])),
    excludeRowRanges: JSON.parse(JSON.stringify(format.excludeRowRanges || [])),
    totalRow: format.totalRow ? JSON.parse(JSON.stringify(format.totalRow)) : null,
    billingMonthSourceIds: (format.billingMonthSourceIds || []).slice(),
    billingMonthAbsent: Boolean(format.billingMonthAbsent),
    billingMonthCustomSources:
      JSON.parse(JSON.stringify(format.billingMonthCustomSources || []))
  };
}

/**
 * 改訂版の下書き行を作る（手順4）。
 *
 * バージョンは現在の最大 + 1。**旧行はそのまま残す** ── 仕様18.5の
 * 「直前の有効バージョンへ戻せる」がこれで成立する。旧行を書き換えると
 * 戻す先が消える。
 */
function buildRevisionDraft(input) {
  if (!input || !input.formatId) throw new TypeError('buildRevisionDraft requires a formatId');
  var versions = (input.existingVersions || []).map(Number).filter(function(v) {
    return Number.isFinite(v);
  });
  var nextVersion = (versions.length ? Math.max.apply(null, versions) : 0) + 1;
  var reason = input.reason || FORMAT_REVISION_REASON.ISSUER_EXPORT_CHANGED;
  if (!FORMAT_REVISION_REASON[reason]) {
    throw new TypeError('Unsupported revision reason: ' + reason);
  }
  return {
    formatId: String(input.formatId),
    version: nextVersion,
    status: 'draft',
    enabled: false,          // 有効化は3ゲート通過後（INV-34）
    revisionReason: reason,
    answers: input.answers || {},
    createdBy: input.actor || activeUserEmail_(),
    createdAt: nowIso_()
  };
}

/**
 * 旧サンプルが必ず落ちる場合の選択肢（4.12.6 末尾）。
 *
 * **選択肢Bを既定にしない。** 旧様式のファイルが今後も提出され得る限り、
 * 旧サンプルはコーパスに残すべきである。`RETIRED`にしてよいのは、
 * 旧様式がもう提出されないとオーナー管理者が判断した場合に限る。
 */
function revisionFallbackOptions(collisionResult) {
  var missesPrior = (collisionResult && collisionResult.failures || []).some(function(f) {
    return f.reason === 'REVISED_DEF_MISSES_PRIOR_SAMPLE';
  });
  if (!missesPrior) return {applicable: false, options: []};
  return {
    applicable: true,
    // 順序が既定の提示順である。A を先に置く。
    options: [
      {
        code: 'REGISTER_AS_NEW_FORMAT', recommended: true,
        detail: '新様式を別の形式IDとして登録する。旧様式のファイルは引き続き処理できる',
        requires: 'DETECTION_COLLISION_CHECK'
      },
      {
        code: 'RETIRE_PRIOR_SAMPLE', recommended: false,
        detail: '旧サンプルを回帰対象から外す。旧様式がもう提出されないと判断できる場合に限る',
        requires: 'OWNER_APPROVAL',
        warning: '当該形式の旧バージョンへロールバックした場合、回帰で保証される範囲が失われる'
      }
    ]
  };
}

/**
 * 旧サンプルを回帰対象から外せるか（選択肢B・`SAMPLE_LAST_OF_FORMAT`）。
 *
 * **当該形式の回帰対象サンプルが0件になる場合は拒否する。** 0件になると
 * その形式は回帰で何も保証されなくなり、以後の改訂が素通りする。
 */
function canRetireSample(sampleId, samplesOfFormat) {
  var remaining = (samplesOfFormat || []).filter(function(sample) {
    return String(sample.sampleId) !== String(sampleId) &&
      String(sample.status) === SAMPLE_STATUS.ACTIVE;
  });
  if (!remaining.length) {
    return {allowed: false, code: 'SAMPLE_LAST_OF_FORMAT',
      detail: 'confirm the new sample first, so the format keeps at least one regression sample'};
  }
  return {allowed: true, code: null, remaining: remaining.length};
}

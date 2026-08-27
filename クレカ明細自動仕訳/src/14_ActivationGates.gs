'use strict';

/**
 * 4.12.2〜4.12.4 有効化ゲート。
 *
 * 形式を増やしていく運用（仕様8.3）を安全にするための3つの関門である。
 * これがないと、判定衝突と既存形式の破壊が**本番で顧客のファイルとして**
 * 初めて表面化する。壊れた側の顧客には、なぜ壊れたかの手がかりがない。
 */

function gateFailure_(reason, detail) {
  return Object.assign({reason: reason}, detail || {});
}

function roundTripFailure_(conditionNumber, detail) {
  return gateFailure_('ROUNDTRIP_C' + conditionNumber, Object.assign(
    {rowNumber: null, item: null, expected: null, actual: null}, detail || {}));
}

/** 条件5・9・11で使う「保存値と完全一致」。空値は空文字列へ寄せて比べる。 */
function sampleValuesEqual_(expected, actual) {
  var a = expected === null || expected === undefined ? '' : String(expected);
  var b = actual === null || actual === undefined ? '' : String(actual);
  return a === b;
}

/**
 * 4.12.2 往復検証の合格条件1〜11を、1サンプルに対して評価する。
 *
 * **保存済みの期待値と照合する。** 実行時に規則を再適用した結果を期待値と
 * して使うと、検査対象そのものを期待値にすることになり恒真になる（A-5）。
 * 特に条件11の期待導出日は処理日に依存しないため、保存値との完全一致を
 * 要求できる ── これが年補完の規則を壊したときに落ちる唯一の関門である。
 *
 * @param {!Object} input
 *   detection {matched}, definition {valid, errorCode},
 *   extraction {transactions[], excludedRows[], reconciliation, billingMonth,
 *               truncation, yearSummary},
 *   expected   {transactionCount, totalAmount, excludedRows[], excludedCount,
 *               billingMonthStatus, billingYearMonth, rows[], yearSummary}
 * @return {!Array<!Object>} 不合格の一覧。空なら合格。
 */
/**
 * 実測の請求年月`status`を照合用に読み替える（2.1.19.1・B-M16）。
 *
 * `extractBillingYearMonth`は RESOLVED / NOT_FOUND / CONFLICT の3値しか
 * 返さない。**この読み替えが無いと、`billingMonthAbsent`が真の形式は
 * 期待値`ABSENT_BY_ANSWER`と実測`NOT_FOUND`が永久に一致せず、往復検証が
 * 必ず不合格になる。** 請求年月の表記がない明細を出すカード会社は実在し、
 * その形式は登録手順を最後まで通れなかった。
 */
function normalizeBillingStatusForComparison_(measuredStatus, format) {
  if (format && format.billingMonthAbsent === true &&
      format.hasBillingSources !== true &&
      String(measuredStatus) === 'NOT_FOUND') {
    return 'ABSENT_BY_ANSWER';
  }
  return measuredStatus;
}

function verifyDraftAgainstSample(input) {
  if (!input || !input.extraction || !input.expected) {
    throw new TypeError('verifyDraftAgainstSample requires extraction and expected values');
  }
  var extraction = input.extraction;
  var expected = input.expected;
  var failures = [];

  // 条件1：下書き定義だけで形式判定が成立すること。
  if (!(input.detection && input.detection.matched === true)) {
    failures.push(roundTripFailure_(1, {item: 'detection', expected: true, actual: false}));
  }

  // 条件2：定義がスキーマ・制約検査に適合し、抽出中に定義不正が出ないこと。
  if (input.definition && input.definition.valid === false) {
    failures.push(roundTripFailure_(2, {item: 'definition',
      expected: 'VALID', actual: input.definition.errorCode || 'CARD_FORMAT_DEFINITION_INVALID'}));
  }

  var transactions = extraction.transactions || [];

  // 条件3：抽出件数が1以上で、期待取引件数と完全一致すること。
  if (!transactions.length || transactions.length !== Number(expected.transactionCount)) {
    failures.push(roundTripFailure_(3, {item: 'transactionCount',
      expected: expected.transactionCount, actual: transactions.length}));
  }

  // 条件4：金額の総和が期待合計金額と完全一致すること。
  var total = transactions.reduce(function(sum, tx) {
    return sum + Number(tx.amountBillingJpy || 0);
  }, 0);
  if (total !== Number(expected.totalAmount)) {
    failures.push(roundTripFailure_(4, {item: 'totalAmount',
      expected: expected.totalAmount, actual: total}));
  }

  // 条件5：除外行の集合と各行の除外根拠が完全一致すること。
  // **件数の一致では足りない。** 行番号と根拠の組で比べる。
  var actualExcluded = {};
  (extraction.excludedRows || []).forEach(function(row) {
    actualExcluded[String(row.rowNumber)] = String(row.reason);
  });
  var expectedExcluded = {};
  (expected.excludedRows || []).forEach(function(row) {
    expectedExcluded[String(row.rowNumber)] = String(row.reason);
  });
  Object.keys(expectedExcluded).forEach(function(rowNumber) {
    if (actualExcluded[rowNumber] !== expectedExcluded[rowNumber]) {
      failures.push(roundTripFailure_(5, {rowNumber: Number(rowNumber), item: 'excludeReason',
        expected: expectedExcluded[rowNumber], actual: actualExcluded[rowNumber] || null}));
    }
  });
  Object.keys(actualExcluded).forEach(function(rowNumber) {
    if (expectedExcluded[rowNumber] === undefined) {
      failures.push(roundTripFailure_(5, {rowNumber: Number(rowNumber), item: 'excludeReason',
        expected: null, actual: actualExcluded[rowNumber]}));
    }
  });
  // 除外行数は2.1.19 N列とも一致すること。組の照合と独立に数を見るのは、
  // 台帳側のN列だけが改竄・破損した場合を捕まえるためである。
  if (expected.excludedCount !== undefined && expected.excludedCount !== null &&
      (extraction.excludedRows || []).length !== Number(expected.excludedCount)) {
    failures.push(roundTripFailure_(5, {item: 'excludedCount',
      expected: expected.excludedCount, actual: (extraction.excludedRows || []).length}));
  }

  // 条件6：照合式の評価が ok であること（NOT_APPLICABLE を含む）。
  var reconciliation = extraction.reconciliation || {};
  if (reconciliation.ok === false) {
    failures.push(roundTripFailure_(6, {item: 'reconciliation',
      expected: true, actual: false}));
  }

  // 条件7：請求年月。ABSENT_BY_ANSWER は合格、CONFLICT は常に不合格。
  var billing = extraction.billingMonth || {};
  var measuredStatus = normalizeBillingStatusForComparison_(billing.status, input.format);
  if (String(billing.status) === 'CONFLICT') {
    failures.push(roundTripFailure_(7, {item: 'billingMonthStatus',
      expected: expected.billingMonthStatus, actual: 'CONFLICT'}));
  } else if (String(measuredStatus) !== String(expected.billingMonthStatus)) {
    failures.push(roundTripFailure_(7, {item: 'billingMonthStatus',
      expected: expected.billingMonthStatus, actual: measuredStatus}));
  } else if (String(billing.status) === 'RESOLVED' &&
             !sampleValuesEqual_(expected.billingYearMonth, billing.yearMonth)) {
    failures.push(roundTripFailure_(7, {item: 'billingYearMonth',
      expected: expected.billingYearMonth, actual: billing.yearMonth}));
  }

  // 条件8：打切り検査が ok であること。
  // **材料が無ければ「評価なしで合格」にしない。** 検査を走らせ忘れた
  // 抽出が黙って通ると、途中で読取を打ち切ったファイルが台帳へ届く。
  if (!extraction.truncation) {
    failures.push(roundTripFailure_(8, {item: 'truncation',
      expected: true, actual: null}));
  } else if (extraction.truncation.ok === false) {
    failures.push(roundTripFailure_(8, {item: 'truncation', expected: true, actual: false}));
  }

  // 条件9・11：全明細行を1行ずつ照合する。
  //
  // 件数と合計の一致では足りない。2件の取り違えが相殺すると成立する。
  var expectedRows = expected.rows || [];
  expectedRows.forEach(function(row, i) {
    var actual = transactions[i] || {};
    // 条件9：処理日に依存しない項目（C・G〜J列）。
    // `dateHashKey`は同一性ハッシュの材料である。表示値が同じでもキーが
    // ずれていれば、重複判定が静かに壊れて二重計上へつながる。
    ['sourceRow', 'merchant', 'amountBillingJpy', 'purpose', 'occurrenceIndex', 'dateHashKey']
      .forEach(function(item) {
        if (row[item] === undefined) return;
        if (!sampleValuesEqual_(row[item], actual[item])) {
          failures.push(roundTripFailure_(9, {rowNumber: row.sourceRow, item: item,
            expected: row[item], actual: actual[item] === undefined ? null : actual[item]}));
        }
      });
    // 条件11：期待導出日は保存値と完全一致でなければならない（A-5）。
    // 処理日に依存しないため、ここだけは再計算と比べずに済む。
    if (row.derivedDate !== undefined &&
        !sampleValuesEqual_(row.derivedDate, actual.date)) {
      failures.push(roundTripFailure_(11, {rowNumber: row.sourceRow, item: 'derivedDate',
        expected: row.derivedDate, actual: actual.date === undefined ? null : actual.date}));
    }
  });
  if (transactions.length > expectedRows.length) {
    transactions.slice(expectedRows.length).forEach(function(tx) {
      failures.push(roundTripFailure_(9, {rowNumber: tx.sourceRow || null, item: 'unexpectedRow',
        expected: null, actual: tx.sourceRow || null}));
    });
  }

  // 条件10：年補完集計。保存値と完全一致すべきキーだけを比べる。
  var expectedSummary = expected.yearSummary || {};
  var actualSummary = extraction.yearSummary || {};
  ['yearlessRows', 'billingMonthStatus', 'yearInferredRows', 'dateReviewRows', 'fileLevelBlanked']
    .forEach(function(key) {
    if (expectedSummary[key] === undefined) return;
    var actualValue = key === 'billingMonthStatus'
      ? normalizeBillingStatusForComparison_(actualSummary[key], input.format)
      : actualSummary[key];
    if (!sampleValuesEqual_(expectedSummary[key], actualValue)) {
      failures.push(roundTripFailure_(10, {item: 'yearSummary.' + key,
        expected: expectedSummary[key], actual: actualValue}));
    }
  });

  return failures;
}

/**
 * ゲート2：コーパス回帰（4.12.3）。
 *
 * 対象は回帰対象サンプルの**全件**である（INV-35）。変更対象の形式の
 * サンプルだけではない。ある形式の判定キーワードの変更が別の形式の
 * 抽出を壊すことがあり、変更した形式だけを試験するとそれが本番で
 * 別顧客のファイルとして現れる。
 *
 * **分割実行は部分結果を`PASS`にしない。** `progress`は「どこまで終わったか」
 * を記録するだけで、`PASS`は全件を終えたときにだけ書かれる。これを混同すると、
 * 途中まで通っただけの定義が有効化される。
 */
function runCorpusRegression(input) {
  if (!input || !Array.isArray(input.samples)) {
    throw new TypeError('runCorpusRegression requires a sample list');
  }
  // 抽出は転記処理と同じ経路を使う（仕様24.2）。回帰専用の抽出を書くと、
  // 回帰が通っても本番が通らない状態が作れてしまう。
  // 未提供のときは「照合なしで合格」にせず、呼出の誤りとして止める。
  if (input.samples.length && typeof input.extract !== 'function') {
    throw new TypeError('runCorpusRegression requires an extract function');
  }
  var extract = input.extract;
  var runId = input.runId || null;
  var maxPerRun = Number(input.maxPerRun || SETTINGS.MAX_SAMPLES_PER_REGRESSION_RUN || 10);
  var shouldStop = typeof input.shouldContinueLater === 'function'
    ? input.shouldContinueLater : function() { return false; };

  // 手順1：回帰対象サンプルをID昇順に並べる。
  var totalSampleIds = input.samples.map(function(s) { return String(s.sampleId); }).sort();

  // 手順2：継続の判定。対象集合が変わっていたら最初からやり直す。
  var progress = input.progress || {};
  var resumable = progress.runId && String(progress.runId) === String(runId) &&
    Array.isArray(progress.totalSampleIds) &&
    progress.totalSampleIds.length === totalSampleIds.length &&
    progress.totalSampleIds.slice().sort().join(',') === totalSampleIds.join(',');
  var done = resumable ? (progress.doneSampleIds || []).slice() : [];

  var failures = [];
  var processedThisRun = 0;

  for (var i = 0; i < totalSampleIds.length; i += 1) {
    var sampleId = totalSampleIds[i];
    if (done.indexOf(sampleId) >= 0) continue;

    // 手順7：サンプル境界で中断する。中断は NOT_RUN であって PASS ではない。
    if (processedThisRun >= maxPerRun || shouldStop()) {
      return {
        result: GATE_RESULT.NOT_RUN,
        checkedSampleIds: done,
        totalSampleIds: totalSampleIds,
        failures: failures,
        progress: {runId: runId, totalSampleIds: totalSampleIds, doneSampleIds: done},
        interrupted: true
      };
    }

    var sample = input.samples.filter(function(s) {
      return String(s.sampleId) === sampleId;
    })[0];

    // 手順3：匿名化ファイルの実在とハッシュ、期待値の改竄を確認する。
    // 不在・不一致は「飛ばして PASS」にせず failures へ入れる。
    if (sample.fileMissing === true) {
      failures.push(gateFailure_('SAMPLE_FILE_MISSING', {sampleId: sampleId}));
    } else if (sample.storedBinaryHash && sample.currentBinaryHash &&
               String(sample.storedBinaryHash) !== String(sample.currentBinaryHash)) {
      failures.push(gateFailure_('SAMPLE_FILE_MISSING', {sampleId: sampleId,
        expected: sample.storedBinaryHash, actual: sample.currentBinaryHash}));
    } else if (sample.storedDataHash && sample.currentDataHash &&
               String(sample.storedDataHash) !== String(sample.currentDataHash)) {
      failures.push(gateFailure_('SAMPLE_EXPECTED_TAMPERED', {sampleId: sampleId}));
    } else {
      // 手順4：照合対象定義を決める。当該サンプルの形式が評価対象と同じなら
      // 評価対象のバージョンの定義、異なるならその形式の現在の有効な定義。
      // これが「旧サンプルを壊す改訂」をここで必ず落とす仕組みである。
      var definition = String(sample.formatId) === String(input.formatId)
        ? input.definition : sample.activeDefinition;

      // 手順5：合格条件1〜11を評価する。
      verifyDraftAgainstSample({
        detection: sample.detection, definition: sample.definitionValidity,
        extraction: extract(definition, sample),
        expected: sample.expected,
        format: sample.format || input.format || null
      }).forEach(function(failure) {
        failures.push(Object.assign({sampleId: sampleId}, failure));
      });
    }

    done.push(sampleId);
    processedThisRun += 1;
  }

  // 手順8：全件を終えたときにだけ結果を確定する。
  return {
    result: failures.length ? GATE_RESULT.FAIL : GATE_RESULT.PASS,
    checkedSampleIds: done,
    totalSampleIds: totalSampleIds,
    failures: failures,
    progress: {runId: null, totalSampleIds: totalSampleIds, doneSampleIds: done},
    interrupted: false
  };
}

/**
 * ゲート3：判定衝突検査（4.12.4）。
 *
 * 判定は4.11の`detectFormatWith`だけを用いる。**本モジュールが判定規則を
 * 再実装してはならない。** 規則が二重になると、登録時に通って本番で落ちる
 * （またはその逆）ことが起きる。
 *
 * @param {!Object} input
 *   formatId, isRevision, newDefinition, newSampleId,
 *   activeDefinitions[], samples[], detect(definition, sampleId) -> boolean
 */
function runDetectionCollisionCheck(input) {
  if (!input || !input.newDefinition || typeof input.detect !== 'function') {
    throw new TypeError('runDetectionCollisionCheck requires a definition and a detect function');
  }
  var formatId = String(input.formatId);
  var newSampleId = String(input.newSampleId);
  var detect = input.detect;
  var failures = [];

  // 「評価対象形式以外」は改訂対象の形式IDを除いた集合を指す。
  var otherSamples = (input.samples || []).filter(function(s) {
    return String(s.formatId) !== formatId;
  });
  var otherDefinitions = (input.activeDefinitions || []).filter(function(d) {
    return String(d.formatId) !== formatId;
  });

  // 検査1：新定義が他形式のサンプルへ成立しないこと。
  otherSamples.forEach(function(sample) {
    if (detect(input.newDefinition, sample.sampleId)) {
      failures.push(gateFailure_('NEW_DEF_MATCHES_OTHER_SAMPLE', {
        sampleId: sample.sampleId, formatId: sample.formatId,
        matchedStep: sample.matchedStep || null
      }));
    }
  });

  // 検査2：既存定義が新サンプルへ成立しないこと。
  otherDefinitions.forEach(function(definition) {
    if (detect(definition, newSampleId)) {
      failures.push(gateFailure_('EXISTING_DEF_MATCHES_NEW_SAMPLE', {
        sampleId: newSampleId, formatId: definition.formatId,
        formatVersion: definition.version, matchedStep: definition.matchedStep || null
      }));
    }
  });

  // 検査2'：改訂の場合のみ。改訂版が改訂前のサンプルにも成立すること。
  //
  // 改訂前の定義を判定集合から除くと、改訂版が旧サンプルを判定できなく
  // なっても検査1〜3のいずれにも掛からない。その状態で有効化すると、
  // 旧様式のファイルが本番で `UNKNOWN_CARD_FORMAT` になる（A-6）。
  if (input.isRevision === true) {
    var ownSamples = (input.samples || []).filter(function(s) {
      return String(s.formatId) === formatId;
    });
    ownSamples.forEach(function(sample) {
      if (!detect(input.newDefinition, sample.sampleId)) {
        failures.push(gateFailure_('REVISED_DEF_MISSES_PRIOR_SAMPLE', {
          sampleId: sample.sampleId, formatId: formatId
        }));
      }
    });
  }

  // 検査3：新サンプルに成立する定義がちょうど1つ（新定義）であること。
  var matched = otherDefinitions.filter(function(d) { return detect(d, newSampleId); });
  var newMatches = detect(input.newDefinition, newSampleId);
  if (!newMatches || matched.length > 0) {
    failures.push(gateFailure_('NOT_UNIQUE_ON_NEW_SAMPLE', {
      sampleId: newSampleId,
      newDefinitionMatches: newMatches,
      otherMatchCount: matched.length,
      otherFormatIds: matched.map(function(d) { return d.formatId; })
    }));
  }

  return {
    result: failures.length ? GATE_RESULT.FAIL : GATE_RESULT.PASS,
    failures: failures
  };
}

/**
 * 3ゲートをまとめて実行し、AC列へ保存する形の結果を返す（4.12.5）。
 *
 * `scope`が`ACTIVATION`なら3ゲート、`ROLLBACK`なら`ROUNDTRIP`を除く2ゲートを
 * 要求する（INV-34）。ロールバックに往復検証を課すと、改訂の後には必ず
 * 新サンプルが追加されているため旧定義は必ず落ち、**仕様18.5が無条件に
 * 要求する復元能力が構造的に不能になる**。
 */
function runActivationGates(input) {
  var scope = String((input && input.scope) || GATE_SCOPE.ACTIVATION);
  if (scope !== GATE_SCOPE.ACTIVATION && scope !== GATE_SCOPE.ROLLBACK) {
    throw new TypeError('scope must be ACTIVATION or ROLLBACK');
  }
  var gates = {};

  if (scope === GATE_SCOPE.ACTIVATION) {
    gates.ROUNDTRIP = input.roundTrip ||
      {result: GATE_RESULT.NOT_RUN, failures: []};
  }
  gates.CORPUS_REGRESSION = runCorpusRegression(input.corpus || {samples: []});
  gates.DETECTION_COLLISION = runDetectionCollisionCheck(input.collision);

  var required = scope === GATE_SCOPE.ACTIVATION
    ? ['ROUNDTRIP', 'CORPUS_REGRESSION', 'DETECTION_COLLISION']
    : ['CORPUS_REGRESSION', 'DETECTION_COLLISION'];

  var overall = required.every(function(name) {
    return gates[name] && gates[name].result === GATE_RESULT.PASS;
  }) ? GATE_RESULT.PASS : GATE_RESULT.FAIL;

  // 中断は FAIL ではなく NOT_RUN のまま残す。再開できることを表すため。
  if (required.some(function(name) {
    return gates[name] && gates[name].result === GATE_RESULT.NOT_RUN;
  })) {
    overall = GATE_RESULT.NOT_RUN;
  }

  return {
    scope: scope, overall: overall, gates: gates,
    ranAt: nowIso_(), codeVersion: VERSIONS.CODE
  };
}

/**
 * 有効化の可否（INV-34）。
 *
 * `overall = PASS`でないときは有効化しない。ただしロールバックに限り、
 * オーナー管理者が理由を記して明示承認した場合には実行できる。
 * 却下時は**既存の`有効=TRUE`行を一切変更しない**。
 */
function canActivateFormat(gateResult, approval) {
  if (!gateResult) return {allowed: false, reason: 'GATES_NOT_RUN'};
  if (gateResult.overall === GATE_RESULT.PASS) return {allowed: true, reason: null};
  if (gateResult.scope === GATE_SCOPE.ROLLBACK && approval &&
      approval.ownerApproved === true && approval.reason) {
    return {allowed: true, reason: 'OWNER_OVERRIDE', override: true};
  }
  return {
    allowed: false,
    reason: gateResult.overall === GATE_RESULT.NOT_RUN ? 'GATES_NOT_RUN' : 'GATES_FAILED'
  };
}

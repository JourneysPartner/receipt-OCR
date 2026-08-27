'use strict';

/**
 * 4.12.10 期待値の再ベースライン（仕様24.2・CR-7）。
 *
 * **コードの正当な修正によって抽出結果が意図どおり変わった場合に、保存済み
 * 期待値を更新する手段である。** この経路がないと、除外ルールや年補完の
 * バグを正しく直した瞬間に全サンプルが不一致になり、INV-34・INV-35により
 * **以後いかなる形式も有効化できなくなる**。回復には全サンプルを最初から
 * 通し直すしかなく、10.3がリリース前の全件合格を求める以上、それは
 * リリースのたびに起き得た。
 *
 * 同時に、これは**「現在のコードの出力を正解とする」上書き**でもある。
 * 差分の全件提示とオーナー管理者の承認なしに実行できてはならない ──
 * それを許すと回帰そのものが意味を失う。
 */

/**
 * 再ベースラインで変わる内容を全件求める（手順2）。
 *
 * 2.1.19 L〜P列の変更（`rowNumber = null`）と、2.1.20 の行単位の変更の
 * 双方を含む。**件数が多くても省略しない。** 承認者が見るのは差分そのもの
 * であり、要約だけで承認させるとレビューが形骸化する。
 *
 * @param {!Array<!Object>} samples
 *   sampleId, status, expected（保存値）, current（現在のコードの出力）
 * @return {{diffs: !Array<!Object>, sampleIds: !Array<string>, skipped: !Array<!Object>}}
 */
function computeRebaselineDiff(samples) {
  if (!Array.isArray(samples)) throw new TypeError('computeRebaselineDiff requires samples');
  var diffs = [];
  var sampleIds = [];
  var skipped = [];

  samples.forEach(function(sample) {
    // `ACTIVE` のみが対象。`PENDING`は期待値を持たず、`SUPERSEDED`・
    // `RETIRED`は回帰対象ではない。
    if (String(sample.status) !== SAMPLE_STATUS.ACTIVE) {
      skipped.push({sampleId: sample.sampleId, reason: 'NOT_ACTIVE', status: sample.status});
      return;
    }
    sampleIds.push(String(sample.sampleId));
    var expected = sample.expected || {};
    var current = sample.current || {};

    // 2.1.19 L〜P列（ファイル単位の期待値）
    ['transactionCount', 'totalAmount', 'excludedCount',
      'billingYearMonth', 'yearSummary'].forEach(function(item) {
      var before = expected[item];
      var after = current[item];
      if (rebaselineValuesEqual_(before, after)) return;
      diffs.push({
        sampleId: sample.sampleId, rowNumber: null, item: item,
        oldValue: normalizeDiffValue_(before), newValue: normalizeDiffValue_(after)
      });
    });

    // 2.1.20（行単位の期待値）
    var expectedRows = expected.rows || [];
    var currentRows = current.rows || [];
    var maxRows = Math.max(expectedRows.length, currentRows.length);
    for (var index = 0; index < maxRows; index += 1) {
      var before2 = expectedRows[index];
      var after2 = currentRows[index];
      if (!before2 && after2) {
        diffs.push({sampleId: sample.sampleId, rowNumber: after2.sourceRow || null,
          item: 'row', oldValue: null, newValue: normalizeDiffValue_(after2)});
        continue;
      }
      if (before2 && !after2) {
        diffs.push({sampleId: sample.sampleId, rowNumber: before2.sourceRow || null,
          item: 'row', oldValue: normalizeDiffValue_(before2), newValue: null});
        continue;
      }
      Object.keys(before2).forEach(function(item) {
        if (rebaselineValuesEqual_(before2[item], after2[item])) return;
        diffs.push({
          sampleId: sample.sampleId, rowNumber: before2.sourceRow || null, item: item,
          oldValue: normalizeDiffValue_(before2[item]),
          newValue: normalizeDiffValue_(after2[item])
        });
      });
    }
  });

  return {
    diffs: diffs, sampleIds: sampleIds, skipped: skipped,
    diffHash: computeRebaselineDiffHash(diffs, sampleIds)
  };
}

function rebaselineValuesEqual_(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined || b === '';
  if (b === null || b === undefined) return a === '';
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
}

function normalizeDiffValue_(value) {
  if (value === undefined) return null;
  return typeof value === 'object' && value !== null ? JSON.parse(JSON.stringify(value)) : value;
}

/**
 * 差分全体のハッシュ（手順3）。
 *
 * **対象サンプル全体に対して1つである。** 一括再ベースラインを単一承認で
 * 実行できるようにするため ── 1件ずつ承認を求めると、正当なコード修正の
 * 後に最大`MAX_CORPUS_SAMPLES`回の承認が必要になり運用が成り立たない。
 * ただし対象を1件でも変えるとハッシュが変わり、再申請になる。
 */
function computeRebaselineDiffHash(diffs, sampleIds) {
  var elements = [String(VERSIONS.CODE), sampleIds.slice().sort().join(',')];
  diffs.forEach(function(diff) {
    elements.push(String(diff.sampleId));
    elements.push(diff.rowNumber === null || diff.rowNumber === undefined
      ? null : Number(diff.rowNumber));
    elements.push(String(diff.item));
    elements.push(JSON.stringify(diff.oldValue === undefined ? null : diff.oldValue));
    elements.push(JSON.stringify(diff.newValue === undefined ? null : diff.newValue));
  });
  return sha256Hex(utf8Bytes(serializeDeterministic(elements)));
}

/**
 * 再ベースラインを実行する（手順6〜8）。
 *
 * **実行の直前に差分を再計算し、申請時の`diffHash`と一致することを確認する。**
 * これがCR-7の要点である。申請から承認までの間にコードがリリースされて
 * いれば差分は変わる。承認時に見せた差分と異なる内容で期待値を上書きしては
 * ならない ── 承認対象は差分そのものだからである。
 *
 * @param {!Object} input
 *   samples（現在の状態）, request（申請内容）, approver, applicant, persist（書込関数）
 */
function rebaselineSample(input) {
  if (!input || !input.request) throw new TypeError('rebaselineSample requires a request');
  var request = input.request;
  if (!request.approvedBy && !input.approver) {
    throw new StateTransitionError(
      'A rebaseline overwrites the expected values with the current output; ' +
      'it requires owner approval');
  }
  if (!request.reason) {
    throw new TypeError('A rebaseline requires a reason naming the code change');
  }

  // 手順6：実行直前の再計算。
  var recomputed = computeRebaselineDiff(input.samples || []);
  if (String(recomputed.diffHash) !== String(request.diffHash)) {
    throw new IntegrityError('SAMPLE_REBASELINE_DIFF_STALE',
      'The diff changed after approval; the approved diff is no longer what would be written');
  }

  // 対象集合そのものが変わっていた場合も再申請とする。
  var requested = (request.sampleIds || []).slice().sort().join(',');
  if (requested !== recomputed.sampleIds.slice().sort().join(',')) {
    throw new IntegrityError('SAMPLE_REBASELINE_DIFF_STALE',
      'The set of samples changed after approval');
  }

  var updated = [];
  (input.samples || []).forEach(function(sample) {
    if (recomputed.sampleIds.indexOf(String(sample.sampleId)) < 0) return;
    var dataHash = computeSampleDataHash(sample.sampleId, sample.current);
    var before = {
      expected: sample.expected || null,
      dataHash: sample.expectedDataHash || null,
      codeVersion: sample.expectedCodeVersion || null
    };
    var after = {
      expected: sample.current,
      dataHash: dataHash,
      // 手順7：期待値生成コードバージョンを現在値へ。これを更新しないと、
      // 「期待値が古いコードで作られている」という絞込が機能しなくなる。
      codeVersion: VERSIONS.CODE,
      // 最終検証結果は`NOT_RUN`へ戻す。期待値を変えた以上、
      // 直前の合格は当てにならない。
      lastVerification: GATE_RESULT.NOT_RUN
    };
    if (typeof input.persist === 'function') input.persist(sample.sampleId, after);

    // 申請者と承認者を分けて残す。どちらか一方だけでは、
    // 「誰が現在の出力を正解と申し立て、誰がそれを認めたか」が追えない。
    appendAudit({
      type: 'SAMPLE_REBASELINE', actor: input.approver || request.approvedBy,
      requester: input.applicant || request.applicant || '',
      approver: input.approver || request.approvedBy,
      targetType: 'SAMPLE', targetId: sample.sampleId,
      before: before, after: Object.assign({}, after, {diffHash: recomputed.diffHash}),
      reason: request.reason
    });
    updated.push({
      sampleId: sample.sampleId,
      dataHash: dataHash, previousDataHash: before.dataHash
    });
  });

  return {
    updated: updated, diffHash: recomputed.diffHash,
    applicant: input.applicant || request.applicant || null,
    approver: input.approver || request.approvedBy
  };
}

/**
 * 期待値オブジェクトを 2.1.20 の行列（A〜L列）へ変換する。
 *
 * **この変換が正本であり、他の場所で同じ変換を書かない。** AD列のハッシュは
 * この行列に対する`computeDataHash`（5.6.3）であり、4.12.3の改竄検知は
 * 同じ行列から再計算して照合する。表現が2つあると、再ベースラインが書いた
 * ハッシュを改竄検知が読めず、**期待値を更新した瞬間に全サンプルが
 * `SAMPLE_EXPECTED_TAMPERED`になる**（第2回レビュー #16）。
 */
function expectedToLedgerRows(sampleId, expected) {
  var value = expected || {};
  var rows = [];
  (value.rows || []).forEach(function(row) {
    rows.push([
      String(sampleId), row.sourceRow,
      row.occurrenceIndex === undefined ? '' : row.occurrenceIndex,
      'TRANSACTION', '',
      row.plannedB === undefined ? '' : row.plannedB,
      row.dateHashKey === undefined ? '' : row.dateHashKey,
      row.amountBillingJpy === undefined ? '' : row.amountBillingJpy,
      row.merchant === undefined ? '' : row.merchant,
      row.purpose === undefined ? '' : row.purpose,
      row.reviewTypes === undefined ? '' : row.reviewTypes,
      row.derivedDate === undefined ? '' : row.derivedDate
    ]);
  });
  (value.excludedRows || []).forEach(function(row) {
    rows.push([String(sampleId), row.rowNumber, '', 'EXCLUDED',
      String(row.reason), '', '', '', '', '', '', '']);
  });
  return rows.sort(function(a, b) { return Number(a[1]) - Number(b[1]); });
}

/** 2.1.19 AD列（期待値dataHash）。5.6.3の`computeDataHash`へ一本化する。 */
function computeSampleDataHash(sampleId, expected) {
  return computeDataHash(expectedToLedgerRows(sampleId, expected));
}

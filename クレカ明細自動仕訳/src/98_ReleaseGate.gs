'use strict';

/**
 * 10.3 リリースゲートの実行入口（エディタ用）。
 *
 * エディタからの実行では関数の**戻り値が表示されない**ため、結果を
 * 実行ログへ出す。判定そのものは4.39と4.26のベクトル群であり、
 * 本関数は集計と表示だけを行う。
 */
function releaseGateReport() {
  var lines = [];
  var allOk = true;

  // 1) 4.39 の4群（直列化・年補完・取引先照合・前年判定）
  var vectors = runAllVectors();
  Object.keys(vectors.groups).forEach(function(name) {
    var group = vectors.groups[name];
    var failed = group.results.filter(function(r) { return !r.ok; });
    lines.push((group.ok ? 'PASS' : 'FAIL') + '  ' + name +
      '  (' + group.results.length + '件照合)');
    failed.slice(0, 5).forEach(function(r) {
      lines.push('      ✗ ' + r.id + '  expected=' + JSON.stringify(r.expected) +
        '  actual=' + JSON.stringify(r.actual) +
        (r.detail ? '  detail=' + r.detail : ''));
    });
  });
  allOk = allOk && vectors.ok;

  // 2) 再判定ベクトル R1〜R5（4.26.3 の4分岐網羅を含む）
  var rejudge = runPriorYearRejudgementVectors();
  lines.push((rejudge.ok ? 'PASS' : 'FAIL') + '  rejudgement (R1-R5)' +
    '  branches=' + rejudge.coveredBranches.join(','));
  rejudge.results.filter(function(r) { return !r.ok; }).forEach(function(r) {
    lines.push('      ✗ ' + r.id + '  ' + r.problems.join(', '));
  });
  if (rejudge.missingBranches.length) {
    lines.push('      ✗ 未到達分岐: ' + rejudge.missingBranches.join(','));
  }
  allOk = allOk && rejudge.ok;

  // 3) 実機の時刻書式。ISO 8601 文字列は全時刻列の正本であり、
  //    `formatDate` の `XXX` パターンはスタブで検証できていない唯一の箇所。
  var iso = toIso8601(new Date());
  var isoOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(iso);
  lines.push((isoOk ? 'PASS' : 'FAIL') + '  toIso8601  → ' + iso);
  allOk = allOk && isoOk;

  lines.unshift('===== リリースゲート ' + (allOk ? '全通過 =====' : '不合格あり ====='));
  lines.push('コード版: ' + VERSIONS.CODE);
  Logger.log(lines.join('\n'));
  return {ok: allOk, report: lines.join('\n')};
}

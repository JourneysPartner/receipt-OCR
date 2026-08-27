'use strict';

/**
 * 4.39 テストと障害注入。
 *
 * **コードだけで完結する固定値テストベクトルを、実 GAS 上で実行する。**
 * Node のスタブで走る `test/` はこれの代替にならない ── スタブは
 * `Utilities.formatDate` も `Utilities.computeDigest` も Sheets API も
 * 通っていないため、そこで緑でも実機で同じ結果が出るとは限らない。
 * 設計10.3はこれをリリース前の必須ゲートに指定している。
 *
 * ベクトルの定義はここに1つだけ置き、Node 側のテストも同じ定義を参照する。
 * 二重に持つと、片方だけ直した瞬間に両者が別のものを検証し始める。
 */

/**
 * 5.6.1 決定的直列化の固定値ベクトル（CR-M）。
 *
 * 取引IDと全ハッシュの土台であり、**1件でも不一致なら回帰を不合格とする**。
 * 期待値は設計書の表から取った外部の値であって、実装の出力ではない。
 */
var SERIALIZATION_VECTORS_ = Object.freeze([
  {id: 'A', elements: ['A', 'B'], serialized: '1:A1:B',
   hash: '73b87d2d8784fa591d799c5e736d805a7c508790e071635815c5c08aca1d4c98'},
  // 空文字列と null を区別する。ここが崩れるとCSVとXLSXの同じ行が同じIDになる。
  {id: 'B', elements: ['', null], serialized: '0:-1:',
   hash: '6650732948b6ac233c71a46d1676311d975ea87360e86f70a3cf93055e0fe4ef'},
  {id: 'C', elements: ['あ'], serialized: '3:あ',
   hash: '776c23fc591a9b1e973b49634a5594406986cbf9287b868025086d8af6f0e141'},
  // サロゲートペア。UTF-16長は2、UTF-8長は4。長さをUTF-16で数えると崩れる。
  {id: 'D', elements: ['𠮷'], serialized: '4:𠮷',
   hash: 'dd07de04994d96c957e546220165b3780771c686dd10e681b2d11d9d05ed03a7'},
  // 半角カナ。NFKCを適用すると値が変わってしまう。
  {id: 'E', elements: ['ﾄﾞﾝｷ'], serialized: '12:ﾄﾞﾝｷ',
   hash: '3a0b1affcdf25fdb92529eb3521f53169f86d03f76c09c4d3758835267b4a794'},
  // 要素が区切り文字を含む。長さ接頭辞がなければ A と区別できない。
  {id: 'F', elements: ['1:A', 'B'], serialized: '3:1:A1:B',
   hash: 'e3cfda58e00459ff3803bca540249836ff96c772ab9acd59b322d3e06107839b'}
]);

/**
 * 5.1 年補完のベクトル。設計5.1の振る舞い表から取る。
 *
 * ここは代表例を置く。20ケース全件は Node 側の
 * `test/phase1a-date-inference.test.js` が同じ形で持っており、実機では
 * 「規則が実 GAS の `Utilities.formatDate` と `computeDigest` の下でも
 * 同じ結果を出すか」を確かめるのが目的である。
 */
var DATE_INFERENCE_VECTORS_ = Object.freeze([
  {
    id: '5.1-1 締め2026-01・年なし12月と1月',
    base: {status: 'RESOLVED', year: 2026, month: 1, sources: ['HEADER']},
    processingDate: '2026-01-20',
    txs: [
      {transactionId: 'tx1', sourceRow: 2, dateYearMissing: true,
       dateMonthDay: {month: 12, day: 28}},
      {transactionId: 'tx2', sourceRow: 3, dateYearMissing: true,
       dateMonthDay: {month: 1, day: 5}}
    ],
    expectedDerived: ['2025-12-28', '2026-01-05'],
    expectedPlanned: ['2025-12-28', '2026-01-05']
  },
  {
    // 締め年月が確定しないと年を決められない。B列予定値は空欄になる（INV-33）。
    id: '5.1 締め年月が取れない場合は年を決めない',
    base: {status: 'NOT_FOUND', sources: []},
    processingDate: '2026-01-20',
    txs: [{transactionId: 'tx1', sourceRow: 2, dateYearMissing: true,
           dateMonthDay: {month: 12, day: 28}}],
    expectedDerived: [null],
    expectedPlanned: ['']
  },
  {
    // 確定した利用日が処理日より後（規則6c）。値は導出できるが信用しない。
    id: '5.1 規則6c 未来日はB列を空欄にする',
    base: {status: 'RESOLVED', year: 2026, month: 1, sources: ['HEADER']},
    processingDate: '2026-01-03',
    txs: [{transactionId: 'tx1', sourceRow: 2, dateYearMissing: true,
           dateMonthDay: {month: 1, day: 5}}],
    expectedDerived: ['2026-01-05'],
    expectedPlanned: ['']
  }
]);

/** 5.14 取引先照合の辞書フィクスチャ。**本番の辞書を使わない。** */
var PARTNER_MATCHING_FIXTURE_ = null;

/** 5.14 取引先照合のベクトル。フィクスチャ未設定なら空で合格とする。 */
var PARTNER_MATCHING_VECTORS_ = Object.freeze([]);

/**
 * 5.15 前年利用日判定のベクトル（5.12の振る舞い表）。
 *
 * 「前年」の基準は対象年度であって暦年ではない。処理日を暦年またぎで
 * 変えても判定が動かないことを、同じベクトルの中で確かめる。
 */
var PRIOR_YEAR_VECTORS_ = Object.freeze([
  {
    id: '5.12-1 個人・対象年度2026・2025年の利用は前年',
    customerCategory: 'INDIVIDUAL', fiscalYear: 2026,
    txs: [{transactionId: 'TX1', date: '2025-12-28'}],
    expectedIssueCount: 1,
    recheckProcessingDates: ['2026-01-20', '2025-12-15']
  },
  {
    id: '5.12-2 個人・対象年度2025・同じ取引は当年',
    customerCategory: 'INDIVIDUAL', fiscalYear: 2025,
    txs: [{transactionId: 'TX1', date: '2025-12-28'}],
    expectedIssueCount: 0,
    recheckProcessingDates: ['2026-01-20', '2025-12-15']
  },
  {
    // 法人は対象外。対象年度を問わず常に0件。
    id: '5.12-3 法人は前年判定の対象外',
    customerCategory: 'CORPORATE', fiscalYear: 2026,
    txs: [{transactionId: 'TX1', date: '2024-05-01'}],
    expectedIssueCount: 0
  },
  {
    // B列予定値が空欄の行には立てない（INV-40）。日付が信用できないため。
    id: '5.12-4 B列予定値が空欄の行には立てない',
    customerCategory: 'INDIVIDUAL', fiscalYear: 2026,
    txs: [{transactionId: 'TX1', date: '2025-12-28'}],
    blankDateTxIds: ['TX1'],
    expectedIssueCount: 0
  },
  {
    id: '5.12-5 利用日が導出できていない行には立てない',
    customerCategory: 'INDIVIDUAL', fiscalYear: 2026,
    txs: [{transactionId: 'TX1', date: null}],
    expectedIssueCount: 0
  }
]);

/** 2.1.20 形式サンプル期待値の列数。 */
var SAMPLE_EXPECTED_WIDTH_ = 12;

/** 非回帰ベクトル。F と X が同じ直列化になってはならない（CR-M）。 */
var SERIALIZATION_NON_REGRESSION_ = Object.freeze({
  id: 'X', elements: ['1', 'A1', 'B'], serialized: '1:12:A11:B',
  hash: 'e467b82d35ec43039137d442192bcdcd3590d44e553c7a579dc778667371961a'
});

function vectorResult_(id, ok, expected, actual, detail) {
  return {id: id, ok: ok, expected: expected, actual: actual, detail: detail || null};
}

/**
 * 5.6.1 の固定値ベクトルを照合する。
 *
 * 直列化結果とSHA-256の**双方**を見る。ハッシュだけを見ると、直列化を
 * 変えても偶然一致した場合に気づけない ── 起こらないとは言えるが、
 * 不一致のときにどちらが壊れたか分からない。
 */
function runSerializationVectors() {
  var results = [];
  var vectors = SERIALIZATION_VECTORS_.concat([SERIALIZATION_NON_REGRESSION_]);

  vectors.forEach(function(vector) {
    var serialized;
    try {
      serialized = serializeDeterministic(vector.elements);
    } catch (error) {
      results.push(vectorResult_(vector.id, false, vector.serialized, null,
        String(error && error.message)));
      return;
    }
    if (serialized !== vector.serialized) {
      results.push(vectorResult_(vector.id + '.serialized', false,
        vector.serialized, serialized));
      return;
    }
    var hash = sha256Hex(utf8Bytes(serialized));
    results.push(vectorResult_(vector.id + '.hash', hash === vector.hash,
      vector.hash, hash));
  });

  // 区切り文字を含む要素が、別の要素列と衝突しないこと。
  var f = serializeDeterministic(SERIALIZATION_VECTORS_[5].elements);
  var x = serializeDeterministic(SERIALIZATION_NON_REGRESSION_.elements);
  results.push(vectorResult_('F!=X', f !== x, 'different', f === x ? 'same' : 'different'));

  return {ok: results.every(function(r) { return r.ok; }), results: results};
}

/**
 * 5.1 年補完の振る舞い表を照合する。
 *
 * **回帰対象サンプルに依存しない。** 5.1の規則そのものを検証する。
 * コーパスの回帰（4.12.3）に混ぜると、サンプルを1件足しただけで
 * 年補完の検証結果が動く。
 *
 * @param {!Array<!Object>=} vectors 省略時は登録済みベクトル
 */
function runDateInferenceVectors(vectors) {
  var cases = vectors || DATE_INFERENCE_VECTORS_ || [];
  var results = [];

  cases.forEach(function(vector) {
    try {
      var inferred = inferYearsForFile(vector.txs, vector.base, vector.cardFormat || {});
      var triage = applyDateTriageChecks(inferred.txs, vector.base,
        parseDate(vector.processingDate, SYSTEM_TIMEZONE));
      var derived = inferred.txs.map(function(tx) {
        return tx.date ? toTokyoDateString_(tx.date) : null;
      });
      var blank = blankedDateTransactionIds(inferred, triage);
      var planned = inferred.txs.map(function(tx, index) {
        return blank.indexOf(String(tx.transactionId)) >= 0 ? '' : (derived[index] || '');
      });

      var ok = JSON.stringify(derived) === JSON.stringify(vector.expectedDerived) &&
        JSON.stringify(planned) === JSON.stringify(vector.expectedPlanned);
      results.push(vectorResult_(vector.id, ok,
        {derived: vector.expectedDerived, planned: vector.expectedPlanned},
        {derived: derived, planned: planned}));
    } catch (error) {
      results.push(vectorResult_(vector.id, false, null, null, String(error && error.message)));
    }
  });

  return {ok: results.every(function(r) { return r.ok; }), results: results};
}

/**
 * 5.14 取引先照合のベクトルを照合する（A-31）。
 *
 * **本番の辞書シートを一切変更しない。** 辞書フィクスチャをメモリ上に
 * 構築して照合する。試験のために本番の辞書へ書くと、試験を走らせた
 * だけで顧客の照合結果が変わる。
 */
function runPartnerMatchingVectors(fixture, vectors) {
  var dictIndex = fixture || PARTNER_MATCHING_FIXTURE_ || null;
  var cases = vectors || PARTNER_MATCHING_VECTORS_ || [];
  var results = [];

  cases.forEach(function(vector) {
    try {
      var actual = matchPartner(
        {merchantOriginal: vector.merchantOriginal, date: vector.date},
        vector.customerId || 'C1', dictIndex);
      var ok = String(actual.partnerName || '') === String(vector.expectedPartner || '') &&
        Boolean(actual.autoConfirm) === Boolean(vector.expectedAutoConfirm);
      results.push(vectorResult_(vector.id, ok,
        {partnerName: vector.expectedPartner, autoConfirm: vector.expectedAutoConfirm},
        {partnerName: actual.partnerName, autoConfirm: actual.autoConfirm}));
    } catch (error) {
      results.push(vectorResult_(vector.id, false, null, null, String(error && error.message)));
    }
  });

  return {ok: results.every(function(r) { return r.ok; }), results: results};
}

/**
 * 5.15 前年利用日判定のベクトルを照合する（BR-2）。
 *
 * **顧客マスター・設定を1セルも変更しない。** 顧客はメモリ上で組み立てる。
 *
 * 処理日非依存の再実行を含む ── 同じ入力を暦年をまたぐ2つの処理日で
 * 評価し、判定が動かないことを確かめる。「前年」の基準が対象年度であって
 * 暦年でないことが、この差で表れる。
 */
function runPriorYearVectors(vectors) {
  var cases = vectors || PRIOR_YEAR_VECTORS_ || [];
  var results = [];

  cases.forEach(function(vector) {
    try {
      var customer = {
        customerId: vector.customerId || 'C1',
        customerCategory: vector.customerCategory,
        fiscalYear: vector.fiscalYear
      };
      var txs = vector.txs.map(function(tx) {
        return {transactionId: tx.transactionId,
          date: tx.date ? parseDate(tx.date, SYSTEM_TIMEZONE) : null};
      });
      var judgement = checkPriorYearUsage(txs, customer, vector.blankDateTxIds || []);
      var ok = judgement.issues.length === Number(vector.expectedIssueCount);
      results.push(vectorResult_(vector.id, ok,
        vector.expectedIssueCount, judgement.issues.length));

      // 処理日を暦年またぎで変えても判定が動かないこと。
      if (vector.recheckProcessingDates) {
        var counts = vector.recheckProcessingDates.map(function(processingDate) {
          return evaluatePriorYearVector(txs, customer, vector.blankDateTxIds || [],
            parseDate(processingDate, SYSTEM_TIMEZONE)).issues.length;
        });
        var stable = counts.every(function(count) { return count === counts[0]; });
        results.push(vectorResult_(vector.id + '.processingDateIndependent',
          stable, 'stable', counts.join(',')));
      }
    } catch (error) {
      results.push(vectorResult_(vector.id, false, null, null, String(error && error.message)));
    }
  });

  return {ok: results.every(function(r) { return r.ok; }), results: results};
}

/**
 * 4つのベクトル群をまとめて実行する（10.3 リリース手順の必須ゲート）。
 *
 * **1群でも不合格ならリリースしない。** どれが落ちたかを個別に返すのは、
 * 「全体としては落ちたが何が壊れたか分からない」状態を避けるためである。
 */
function runAllVectors() {
  var groups = {
    serialization: runSerializationVectors(),
    dateInference: runDateInferenceVectors(),
    partnerMatching: runPartnerMatchingVectors(),
    priorYear: runPriorYearVectors()
  };
  var failed = Object.keys(groups).filter(function(name) { return !groups[name].ok; });
  return {
    ok: failed.length === 0,
    failedGroups: failed,
    groups: groups,
    codeVersion: VERSIONS.CODE
  };
}

/**
 * 障害注入のシーム。
 *
 * **本番では常に素通りする。** 先頭で本番マスターIDの自己防衛ガードを
 * 行う ── 設定の取り違えで本番へ障害注入が効いてしまうと、原因不明の
 * 停止が顧客のデータに対して起きる。
 */
function faultInjectionPoint(pointId, context) {
  var injection = SETTINGS.FAULT_INJECTION;
  if (!injection) return;

  // 自己防衛：本番のマスターに対しては、設定が何であっても素通りする。
  var production = PropertiesService.getScriptProperties()
    .getProperty('PRODUCTION_MASTER_SPREADSHEET_ID');
  if (production && resolveMasterSpreadsheetId_() === production) return;
  var plan = typeof injection === 'string' ? null : injection[String(pointId)];
  if (!plan) return;

  // 障害注入はエラーカタログの語彙を使わない。カタログのコードは運用者へ
  // 提示する文言と対応者を持つが、これは試験のための人工の停止であって、
  // 運用者が対処すべき事象ではない。
  var error = new Error(
    'Injected fault at ' + pointId + (context ? ' ' + JSON.stringify(context) : ''));
  error.code = 'FAULT_INJECTED';
  error.pointId = String(pointId);
  throw error;
}

/**
 * 形式サンプル期待値（2.1.20）を読む（A-29）。
 *
 * **期待値の読取経路をこの1関数に固定する。** 4.12.2・4.12.3・4.12.10 が
 * これを共有する。呼出元のない関数は実装されないか、別の実装で二重に
 * 書かれる ── Ver.2.2はまさにその状態だった。
 */
function loadExpectedValues(sampleId, sheet) {
  if (!sampleId) throw new TypeError('loadExpectedValues requires a sample id');
  var target = sheet || requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.FORMAT_SAMPLE_EXPECTED);
  return findRowsByColumnValue_(target, 1, String(sampleId), SAMPLE_EXPECTED_WIDTH_)
    .map(function(record) { return record.values; })
    .sort(function(a, b) { return Number(a[1]) - Number(b[1]); });   // B列（元ファイル行番号）昇順
}

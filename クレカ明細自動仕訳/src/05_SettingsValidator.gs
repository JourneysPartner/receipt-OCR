'use strict';

/**
 * 4.6 設定検証。
 *
 * 処理開始時に必須設定を検証し、不明・欠落・矛盾があれば**書込を開始させない**。
 *
 * **検査は`scope`ごとに分ける（CR-5・INV-41）。** ある操作に無関係な設定の
 * 不備でその操作を拒否してはならない。Ver.2.2はコーパスフォルダへの
 * アクセス可否を全処理の必須検証にしており、共有権限がシステム管理者以上に
 * 限定されている以上、**確認担当者は明細を1件も取り込めなかった**。
 * 同型の欠陥（CR-G）が是正済みの箇所とは別の場所で再発したものである。
 */

var VALIDATION_SCOPE = Object.freeze({
  IMPORT: 'IMPORT',
  FORMAT_REGISTRATION: 'FORMAT_REGISTRATION',
  CUSTOMER_MASTER: 'CUSTOMER_MASTER',
  ADMIN: 'ADMIN'
});

/**
 * 検査項目と適用範囲（4.6の表）。
 *
 * 項目13と14を分けたのがCR-5の是正である。**取込処理の安全に必要なのは
 * 「コーパスフォルダが顧客フォルダと別であること」だけ**で、これはID比較で
 * 済み権限を要さない。実際に開けるかどうかは、フォルダを使う経路
 * （形式登録）の入口で検査すれば足りる。
 */
var SETTINGS_CHECKS_ = Object.freeze([
  {id: 1, name: 'masterSpreadsheet', scopes: ['IMPORT', 'FORMAT_REGISTRATION', 'CUSTOMER_MASTER', 'ADMIN']},
  {id: 2, name: 'requiredSheets', scopes: ['IMPORT', 'FORMAT_REGISTRATION', 'CUSTOMER_MASTER', 'ADMIN']},
  {id: 3, name: 'introducedSettings', scopes: ['IMPORT', 'FORMAT_REGISTRATION', 'CUSTOMER_MASTER', 'ADMIN']},
  {id: 4, name: 'timezone', scopes: ['IMPORT', 'FORMAT_REGISTRATION', 'CUSTOMER_MASTER', 'ADMIN']},
  {id: 6, name: 'safetyMargin', scopes: ['IMPORT', 'FORMAT_REGISTRATION', 'CUSTOMER_MASTER', 'ADMIN']},
  {id: 7, name: 'quotaCeilings', scopes: ['IMPORT', 'FORMAT_REGISTRATION', 'CUSTOMER_MASTER', 'ADMIN']},
  {id: 8, name: 'lockSettings', scopes: ['IMPORT', 'FORMAT_REGISTRATION', 'CUSTOMER_MASTER', 'ADMIN']},
  {id: 9, name: 'capacityThresholds', scopes: ['IMPORT', 'FORMAT_REGISTRATION', 'CUSTOMER_MASTER', 'ADMIN']},
  {id: 10, name: 'faultInjectionOffInProduction', scopes: ['IMPORT', 'FORMAT_REGISTRATION', 'CUSTOMER_MASTER', 'ADMIN']},
  {id: 11, name: 'separateSpreadsheets', scopes: ['IMPORT', 'FORMAT_REGISTRATION', 'CUSTOMER_MASTER', 'ADMIN']},
  {id: 12, name: 'inferenceWindows', scopes: ['IMPORT', 'FORMAT_REGISTRATION', 'CUSTOMER_MASTER', 'ADMIN']},
  // 13：ID比較のみ。権限を要さないので取込でも検査する。
  {id: 13, name: 'corpusFolderIsSeparate', scopes: ['IMPORT', 'FORMAT_REGISTRATION', 'ADMIN']},
  // 14：実際にフォルダを開く。権限を要するので、フォルダを使う経路だけで検査する。
  {id: 14, name: 'corpusFolderAccessible', scopes: ['FORMAT_REGISTRATION', 'ADMIN']},
  {id: 15, name: 'corpusLimits', scopes: ['FORMAT_REGISTRATION', 'ADMIN']},
  {id: 16, name: 'requestExpiry', scopes: ['IMPORT', 'FORMAT_REGISTRATION', 'CUSTOMER_MASTER', 'ADMIN']}
]);

function settingsProblem_(check, detail) {
  return {check: check.id, name: check.name, detail: detail};
}

/** 当該`scope`で実行する検査だけを返す。 */
function settingsChecksFor(scope) {
  var name = String(scope);
  if (!VALIDATION_SCOPE[name]) throw new TypeError('Unknown validation scope: ' + scope);
  return SETTINGS_CHECKS_.filter(function(check) {
    return check.scopes.indexOf(name) >= 0;
  });
}

/**
 * 設定を検証する。
 *
 * @param {string} scope
 * @param {!Object=} context 検査に必要な外部情報（顧客フォルダID一覧など）
 * @return {{ok: boolean, problems: !Array<!Object>, scope: string}}
 */
function validateSettings(scope, context) {
  context = context || {};
  var problems = [];

  settingsChecksFor(scope).forEach(function(check) {
    var detail = runSettingsCheck_(check, context);
    if (detail) problems.push(settingsProblem_(check, detail));
  });

  return {ok: problems.length === 0, problems: problems, scope: String(scope)};
}

function runSettingsCheck_(check, context) {
  switch (check.name) {
    case 'masterSpreadsheet':
      return resolveMasterSpreadsheetId_() || context.activeSpreadsheetId
        ? null : 'MASTER_SPREADSHEET_ID is not configured';

    case 'requiredSheets':
      return missingRequiredSheets_(context);

    case 'introducedSettings':
      // `LOG_RETENTION_YEARS`だけは未設定を許容する。未設定の間は自動削除を
      // 行わないだけであり、それ自体は安全側である。
      return SETTINGS.EXECUTION_TIMEOUT_SECONDS === null ||
        SETTINGS.EXECUTION_TIMEOUT_SECONDS === undefined
        ? 'EXECUTION_TIMEOUT_SECONDS is not configured' : null;

    case 'timezone':
      return String(context.timezone || SYSTEM_TIMEZONE) === 'Asia/Tokyo'
        ? null : 'the script timezone must be Asia/Tokyo';

    case 'safetyMargin':
      return Number(SETTINGS.SAFETY_MARGIN_SECONDS) <
        Number(SETTINGS.EXECUTION_TIMEOUT_SECONDS)
        ? null : 'SAFETY_MARGIN_SECONDS must be below EXECUTION_TIMEOUT_SECONDS';

    case 'quotaCeilings':
      return missingNumbers_(['MAX_DRIVE_CALLS_PER_RUN', 'MAX_SHEETS_CALLS_PER_RUN',
        'MAX_TRIGGERS', 'MAX_EMAILS_PER_DAY',
        'MAX_DRIVE_CALLS_PER_MINUTE', 'MAX_SHEETS_CALLS_PER_MINUTE']);

    case 'lockSettings':
      return missingNumbers_(['LOCK_TIMEOUT_MS', 'LEASE_FORCE_RELEASE_MIN_SECONDS']);

    case 'capacityThresholds':
      return capacityThresholdProblem_();

    case 'faultInjectionOffInProduction':
      // 本番で障害注入が有効なら起動を拒否する。素通りするだけでは足りない
      // ── 有効なつもりで置いた設定が黙って無視されるのも困る。
      return isProductionEnvironment() && SETTINGS.FAULT_INJECTION
        ? 'FAULT_INJECTION must not be enabled against the production master' : null;

    case 'separateSpreadsheets':
      return separateSpreadsheetProblem_();

    case 'inferenceWindows':
      return inferenceWindowProblem_();

    case 'corpusFolderIsSeparate':
      return corpusFolderSeparationProblem_(context);

    case 'corpusFolderAccessible':
      return corpusFolderAccessProblem_(context);

    case 'corpusLimits':
      return belowOne_(['MAX_CORPUS_SAMPLES', 'SAMPLE_MAX_ROWS_PER_SAMPLE',
        'SAMPLE_INFER_SCAN_ROWS', 'SAMPLE_INFER_SAMPLE_ROWS',
        'SAMPLE_PENDING_EXPIRE_DAYS', 'MAX_SAMPLES_PER_REGRESSION_RUN']);

    case 'requestExpiry':
      return belowOne_(['REQUEST_EXPIRE_DAYS']);

    default:
      return null;
  }
}

function missingNumbers_(keys) {
  var missing = keys.filter(function(key) {
    var value = SETTINGS[key];
    return value === null || value === undefined || value === '' || !Number.isFinite(Number(value));
  });
  return missing.length ? missing.join(', ') + ' must be configured' : null;
}

function belowOne_(keys) {
  var bad = keys.filter(function(key) { return !(Number(SETTINGS[key]) >= 1); });
  return bad.length ? bad.join(', ') + ' must be at least 1' : null;
}

function capacityThresholdProblem_() {
  var pairs = [
    ['LOG_CAPACITY_WARN_PERCENT', 'LOG_CAPACITY_STOP_PERCENT'],
    ['DRIVE_STORAGE_WARN_PERCENT', 'DRIVE_STORAGE_STOP_PERCENT']
  ];
  var bad = pairs.filter(function(pair) {
    var warn = Number(SETTINGS[pair[0]]);
    var stop = Number(SETTINGS[pair[1]]);
    return !(warn < stop && stop <= 100);
  });
  return bad.length
    ? bad.map(function(p) { return p[0] + ' < ' + p[1] + ' <= 100'; }).join('; ') + ' is violated'
    : null;
}

/**
 * 取引単位インデックスとスナップショットは、マスターとは別のスプレッドシート
 * でなければならない。同じにすると1つのシートの容量上限を3つの用途で
 * 食い合い、どれかが書けなくなった時点で全体が止まる。
 */
function separateSpreadsheetProblem_() {
  var master = resolveMasterSpreadsheetId_();
  var problems = [];
  [['TX_INDEX_SPREADSHEET_ID', SETTINGS.TX_INDEX_SPREADSHEET_ID],
    ['SNAPSHOT_SPREADSHEET_ID', SETTINGS.SNAPSHOT_SPREADSHEET_ID]].forEach(function(pair) {
    if (!pair[1]) { problems.push(pair[0] + ' is not configured'); return; }
    if (master && String(pair[1]) === String(master)) {
      problems.push(pair[0] + ' must differ from the master spreadsheet');
    }
  });
  return problems.length ? problems.join('; ') : null;
}

function inferenceWindowProblem_() {
  var lookback = Number(SETTINGS.YEAR_INFERENCE_MAX_LOOKBACK_MONTHS);
  var forward = Number(SETTINGS.YEAR_INFERENCE_MAX_FORWARD_MONTHS);
  if (!(lookback >= 0) || !(forward >= 0)) {
    return 'the year inference window must be non-negative';
  }
  // 合計が12か月以上だと、年なし日付の候補年が常に2つ以上になり、
  // どのファイルでも年を確定できなくなる。
  if (lookback + forward >= 12) {
    return 'the year inference window must span less than 12 months';
  }
  if (!(Number(SETTINGS.DATED_DATE_MAX_LOOKBACK_MONTHS) >= 0) ||
      !(Number(SETTINGS.DATED_DATE_MAX_FORWARD_MONTHS) >= 0)) {
    return 'the dated-date sanity window must be non-negative';
  }
  return null;
}

/**
 * 検査13：コーパスフォルダが顧客フォルダと別であること。
 *
 * **ID比較だけを行う。フォルダを開かない。** 取込処理の安全に必要なのは
 * この一点であり、これなら権限を要さない ── 確認担当者がコーパスフォルダの
 * 共有権限を持たないことは9.3が定めた通常の状態である。
 */
function corpusFolderSeparationProblem_(context) {
  var corpus = SETTINGS.SAMPLE_CORPUS_FOLDER_ID;
  if (!corpus) return 'SAMPLE_CORPUS_FOLDER_ID is not configured';

  if (SETTINGS.PARALLEL_WORK_FOLDER_ID &&
      String(SETTINGS.PARALLEL_WORK_FOLDER_ID) === String(corpus)) {
    return 'SAMPLE_CORPUS_FOLDER_ID must differ from PARALLEL_WORK_FOLDER_ID';
  }
  var clash = (context.customerFolderIds || []).filter(function(folderId) {
    return String(folderId) === String(corpus);
  });
  return clash.length
    ? 'SAMPLE_CORPUS_FOLDER_ID must not be a customer statement folder'
    : null;
}

/**
 * 検査14：コーパスフォルダを実際に開けること、および顧客フォルダの配下に
 * ないこと（A-21）。
 *
 * **権限を要するので、フォルダを使う経路でのみ検査する。** 取込処理の
 * 必須検証に含めると、確認担当者は1ファイルも処理できなくなる（CR-5）。
 */
function corpusFolderAccessProblem_(context) {
  var corpus = SETTINGS.SAMPLE_CORPUS_FOLDER_ID;
  if (!corpus) return 'SAMPLE_CORPUS_FOLDER_ID is not configured';
  if (context.corpusFolderAccessible === false) {
    return 'the sample corpus folder cannot be read and written';
  }
  if (context.corpusFolderAncestors &&
      (context.customerFolderIds || []).some(function(folderId) {
        return context.corpusFolderAncestors.indexOf(String(folderId)) >= 0;
      })) {
    // 顧客フォルダの配下に置くと、顧客が匿名化前のサンプルを見得る。
    return 'the sample corpus folder must not sit under a customer statement folder';
  }
  return null;
}

function missingRequiredSheets_(context) {
  var provided = context.sheetNames;
  if (!provided) {
    var spreadsheet = resolveMasterSpreadsheetId_()
      ? SpreadsheetApp.openById(resolveMasterSpreadsheetId_())
      : SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) return 'the master spreadsheet cannot be opened';
    provided = spreadsheet.getSheets().map(function(sheet) { return sheet.getName(); });
  }
  var missing = (CONFIG.REQUIRED_SHEET_KEYS || []).filter(function(key) {
    return provided.indexOf(CONFIG.SHEET_NAMES[key]) < 0;
  }).map(function(key) { return CONFIG.SHEET_NAMES[key]; });
  return missing.length ? 'missing sheets: ' + missing.join(', ') : null;
}

/** 本番環境か。4.39の自己防衛ガードと同じ判定を共有する。 */
function isProductionEnvironment() {
  var production = PropertiesService.getScriptProperties()
    .getProperty('PRODUCTION_MASTER_SPREADSHEET_ID');
  return Boolean(production) && resolveMasterSpreadsheetId_() === production;
}

/**
 * 不合格なら例外を送出し、以降の書込を発生させない。
 *
 * **検証してから書く**という順序が要点である。書きながら検証すると、
 * 途中まで書いた状態で止まる。
 */
function assertSafeToWrite(scope, context) {
  var result = validateSettings(scope, context);
  if (result.ok) return result;
  throw new MasterDataError(
    'Settings are not valid for ' + scope + ': ' +
    result.problems.map(function(p) { return '#' + p.check + ' ' + p.detail; }).join('; '));
}

/**
 * Script Properties から設定を読み込む。
 *
 * 第11章の設定を運用者が変更する手段がこれである。読み込んだ結果は
 * **実行開始時に1度だけ**確定させる ── 実行の途中で設定が変わると、
 * 同じ実行の前半と後半で違う規則が適用される。
 *
 * @return {{loaded: !Array<string>, ignored: !Array<string>}}
 */
function loadSettingsFromProperties() {
  var stored = PropertiesService.getScriptProperties().getProperties() || {};
  var loaded = [];
  var ignored = [];

  Object.keys(stored).forEach(function(key) {
    if (!(key in SETTINGS)) { ignored.push(key); return; }
    var raw = stored[key];
    var current = SETTINGS[key];
    var value = raw;
    if (typeof current === 'number' || (current === null && /^-?\d+(\.\d+)?$/.test(raw))) {
      value = Number(raw);
      if (!Number.isFinite(value)) { ignored.push(key); return; }
    } else if (typeof current === 'boolean') {
      value = toBool(raw);
    }
    SETTINGS[key] = value;
    loaded.push(key);
  });

  return {loaded: loaded.sort(), ignored: ignored.sort()};
}

/**
 * 障害注入の設定を実行開始時に1度だけ読む（4.39が共有する）。
 *
 * 毎回読むと、実行の途中で設定が変わったときに一部の停止点だけが有効に
 * なる。再現しない挙動になり、原因を追えない。
 */
var faultInjectionCache_ = {loaded: false, value: null};

function getCachedFaultInjectionConfig() {
  if (!faultInjectionCache_.loaded) {
    var raw = PropertiesService.getScriptProperties().getProperty('FAULT_INJECTION');
    faultInjectionCache_.value = raw ? jsonCell_(raw, null) : null;
    faultInjectionCache_.loaded = true;
  }
  return faultInjectionCache_.value;
}

function resetFaultInjectionCache_() {
  faultInjectionCache_ = {loaded: false, value: null};
}

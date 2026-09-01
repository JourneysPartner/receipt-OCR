'use strict';

/**
 * 導入時の初期化（10.4）。
 *
 * マスタースプレッドシートに必須シート（4.6 検査2の対象）を作る。
 * **既にあるシートには触れない** ── 初期化のやり直しが既存データを消す
 * 事故を、構造的に不可能にしておく。
 *
 * ここで作るのはシートと1行目の見出しラベルだけである。列見出しの完全な
 * 整備は各シートを最初に使う機能が担い、検査2が見るのはシートの存在である。
 */

/**
 * シートごとの幅と先頭列ラベル。
 *
 * 幅はデータアクセス層が読む列数と一致させる（例：取引ログ45列）。
 * まだ読み手のいないシート（※印）は設計2.1の暫定値であり、当該機能の
 * 実装時に確定する。
 */
var MASTER_SHEET_SPECS_ = Object.freeze([
  {key: 'CUSTOMER_MASTER', width: 37, label: '顧客ID'},
  {key: 'COMMON_PARTNER_LIST', width: 6, label: '取引先ID'},
  {key: 'COMMON_PARTNER_DICT', width: 18, label: '辞書ID'},
  {key: 'CUSTOMER_PARTNER_DICT', width: 18, label: '辞書ID'},
  {key: 'PURPOSE_COMPLEMENT', width: 10, label: 'ルールID'},        // ※
  {key: 'CARD_FORMAT_MASTER', width: 35, label: '形式ID'},          // ※
  {key: 'PROCESS_LOG', width: 40, label: '実行ID'},
  {key: 'TRANSACTION_LOG', width: 45, label: '取引ID完全値'},
  {key: 'AUDIT_LOG', width: 15, label: '監査ID'},
  {key: 'REVIEW', width: 32, label: '要確認ID'},
  {key: 'PROCESS_LEASE', width: 10, label: 'リースID'},
  {key: 'PERMANENT_FILE_INDEX', width: 13, label: 'ファイルID'},
  {key: 'APPROVAL_REQUEST', width: 13, label: '申請ID'},
  {key: 'FORMAT_SAMPLE_INDEX', width: 31, label: 'サンプルID'},     // ※
  {key: 'FORMAT_SAMPLE_EXPECTED', width: 12, label: 'サンプルID'},
  {key: 'SYNC_LOG', width: 12, label: '同期ID'},                    // ※
  {key: 'FREEE_IMPORT', width: 12, label: 'バッチID'},              // ※
  {key: 'LOG_ARCHIVE_INDEX', width: 12, label: 'アーカイブID'},     // ※
  {key: 'CAPACITY_PROBE', width: 4, label: 'プローブ'},
  {key: 'SNAPSHOT_INDEX', width: 12, label: 'スナップショットID'}   // ※
]);

/**
 * 必須シートを作る。冪等 ── 既存シートには触れず、無いものだけ作る。
 *
 * @param {string=} spreadsheetId 省略時はマスター（4.6の解決順）
 * @return {{created: !Array<string>, existing: !Array<string>}}
 */
function provisionMasterSheets(spreadsheetId) {
  var spreadsheet = spreadsheetId
    ? SpreadsheetApp.openById(spreadsheetId) : masterSpreadsheet_();
  var created = [];
  var existing = [];

  MASTER_SHEET_SPECS_.forEach(function(spec) {
    var name = CONFIG.SHEET_NAMES[spec.key];
    if (spreadsheet.getSheetByName(name)) {
      existing.push(name);
      return;
    }
    var sheet = spreadsheet.insertSheet(name);
    sheet.getRange(1, 1).setValue(spec.label);
    created.push(name);
  });

  return {created: created, existing: existing};
}

/**
 * 取引単位インデックス・スナップショット用スプレッドシートの初期化。
 *
 * 4.6 検査11は、両者がマスターと**別の**スプレッドシートであり、
 * **容量プローブシートを持つ**ことを要求する。プローブが無いと、
 * 容量監視（INV-04）がそのスプレッドシートを見られない。
 */
function provisionAuxiliarySpreadsheet(spreadsheetId) {
  if (!spreadsheetId) {
    throw new TypeError('provisionAuxiliarySpreadsheet requires a spreadsheet id');
  }
  var master = resolveMasterSpreadsheetId_();
  if (master && String(spreadsheetId) === String(master)) {
    throw new TypeError(
      'The index/snapshot spreadsheet must differ from the master (check 11); ' +
      'sharing one file makes three uses compete for a single cell limit');
  }
  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  var name = CONFIG.SHEET_NAMES.CAPACITY_PROBE;
  if (spreadsheet.getSheetByName(name)) {
    return {created: [], existing: [name]};
  }
  var sheet = spreadsheet.insertSheet(name);
  sheet.getRange(1, 1).setValue('プローブ');
  return {created: [name], existing: []};
}

/**
 * 転記先シートの実ヘッダーを記述する（顧客登録の下調べ用）。
 *
 * エディタから実行し、ログを見て`registerTestCustomer`へ渡す列対応を
 * 決める。**シートには書き込まない。**
 */
function describeDestinationSheet(spreadsheetId, sheetName, headerRow) {
  var sheet = requireSheet_(SpreadsheetApp.openById(spreadsheetId), String(sheetName));
  var row = Number(headerRow) >= 1 ? Number(headerRow) : 1;
  var values = sheet.getRange(row, 1, 1, sheet.getMaxColumns()).getValues()[0] || [];
  var headers = [];
  values.forEach(function(value, index) {
    if (value === '' || value === null || value === undefined) return;
    headers.push({column: index + 1, letter: columnLetter_(index + 1), text: String(value)});
  });
  var report = {
    sheetName: sheet.getName(),
    headerRow: row,
    maxRows: sheet.getMaxRows(),
    maxColumns: sheet.getMaxColumns(),
    headers: headers
  };
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/**
 * テスト顧客を顧客マスターへ登録する（顧客IDで冪等に上書き）。
 *
 * AE列（ヘッダー期待値）は**実物の転記先シートの現在のヘッダー行から生成**
 * する（4.22.1(1)の初期導入手順）。取引ID列はAE期待値に含めない（項目4）。
 *
 * @param {!Object} config
 *   customerId, customerName, sourceFolderId, destinationSpreadsheetId,
 *   destinationSheetName, columns {B,F,I,K,M,txId},
 *   partnerListSheetName?, headerRow?（既定1）, rowScanLastColumn?,
 *   reviewers?, admins?, customerCategory?（既定CORPORATE）, fiscalYear?
 */
function registerTestCustomer(config) {
  if (!config || !config.customerId || !config.customerName || !config.sourceFolderId ||
      !config.destinationSpreadsheetId || !config.destinationSheetName || !config.columns) {
    throw new TypeError('registerTestCustomer requires customerId, customerName, ' +
      'sourceFolderId, destinationSpreadsheetId, destinationSheetName, columns');
  }
  var columns = config.columns;
  ['B', 'F', 'I', 'K', 'M', 'txId'].forEach(function(key) {
    if (!Number.isInteger(columns[key]) || columns[key] < 1) {
      throw new TypeError('columns.' + key + ' must be a positive column number');
    }
  });
  var headerRow = Number.isInteger(config.headerRow) ? config.headerRow : 1;
  var sheet = requireSheet_(
    SpreadsheetApp.openById(config.destinationSpreadsheetId),
    String(config.destinationSheetName));
  var headerValues = sheet.getRange(headerRow, 1, 1, sheet.getMaxColumns()).getValues()[0] || [];
  var lastHeaderColumn = 0;
  var cells = [];
  headerValues.forEach(function(value, index) {
    if (value === '' || value === null || value === undefined) return;
    lastHeaderColumn = index + 1;
    if (index + 1 === columns.txId) return;   // 項目4：取引ID列はAEと重ねない
    cells.push({column: index + 1, text: String(value), match: 'exact'});
  });
  if (!cells.length) {
    throw new MasterDataError('The destination header row ' + headerRow + ' is empty');
  }
  var rowScanLastColumn = Number.isInteger(config.rowScanLastColumn) ?
    config.rowScanLastColumn : Math.max(lastHeaderColumn, columns.txId);
  var operator = activeUserEmail_();
  var category = config.customerCategory || CUSTOMER_CATEGORY.CORPORATE;

  var row = Array(37).fill('');
  row[0] = String(config.customerId);
  row[1] = String(config.customerName);
  row[2] = true;
  row[3] = String(config.sourceFolderId);
  row[5] = String(config.destinationSpreadsheetId);
  row[7] = String(config.destinationSheetName);
  row[8] = String(config.partnerListSheetName || '取引先一覧');
  row[9] = columns.B; row[10] = columns.F; row[11] = columns.I;
  row[12] = columns.K; row[13] = columns.M; row[14] = columns.txId;
  row[15] = VERSIONS.SHEET_SCHEMA;
  row[16] = String(config.reviewers || operator);
  row[17] = String(config.admins || operator);
  row[18] = 0;
  row[20] = CONFIG.REVIEW_SUMMARY.DEFAULT_SHEET_NAME;
  row[21] = '';
  row[23] = 0; row[24] = 0;
  row[29] = headerRow;
  row[30] = JSON.stringify({row: headerRow, allowExtraColumns: true, cells: cells});
  row[31] = '{}';
  row[32] = '{}';
  row[33] = rowScanLastColumn;
  row[34] = String(config.partnerListSheetName || '取引先一覧');
  row[35] = category;
  row[36] = config.fiscalYear === undefined || config.fiscalYear === null ? '' : config.fiscalYear;

  var masterSheet = requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CUSTOMER_MASTER);
  var existing = findRowsByColumnValue_(masterSheet, 1, config.customerId, 37);
  var rowNumber = existing.length ? existing[0].rowNumber : masterSheet.getLastRow() + 1;
  ensureRowExists_(masterSheet, rowNumber);
  masterSheet.getRange(rowNumber, 1, 1, 37).setValues([row]);

  // 登録値そのものが4.3の検証を通ることを確認する（通らない行を残さない）。
  var registered = getCustomerById(String(config.customerId));
  var result = {
    updated: existing.length > 0,
    rowNumber: rowNumber,
    headerExpectation: JSON.parse(row[30]),
    rowScanLastColumn: rowScanLastColumn,
    customerId: registered.customerId
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * カード形式マスターへ形式定義を1行投入する（2.1.2.1 初期投入の経路）。
 *
 * (形式ID, バージョン)で冪等 ── 既にあれば書かない。書く前に4.11の
 * スキーマ検証を通し、不正な定義を投入できないようにする。
 *
 * **AC列（有効化ゲート結果）は空欄のまま投入される。** 初期投入形式の
 * ゲートは10.4（初期サンプル登録後）で実行して埋める。それまでの間は
 * 形式の改訂（4.12.6）に乗せないこと。
 */
function installCardFormat(spec) {
  if (!spec || !spec.formatId) throw new TypeError('installCardFormat requires a formatId');
  var sheet = requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CARD_FORMAT_MASTER);
  var version = Number(spec.version || 1);
  var existing = loadFormatDefinitions({formatId: spec.formatId, version: version});
  if (existing.length) {
    return {installed: false, reason: 'ALREADY_EXISTS', formatId: spec.formatId, version: version};
  }
  var now = nowIso_();
  var row = Array(CARD_FORMAT_COLUMNS_).fill('');
  row[0] = String(spec.formatId);
  row[1] = String(spec.formatName || spec.formatId);
  row[2] = spec.status || 'active';
  row[3] = spec.enabled === undefined ? true : Boolean(spec.enabled);
  row[4] = JSON.stringify(spec.fileTypes || ['csv']);
  row[5] = JSON.stringify(spec.keywordRule);
  row[6] = Number(spec.headerRow);
  row[7] = Number(spec.dataStartRow);
  row[8] = spec.dateColumn || '';
  row[9] = spec.merchantColumn || '';
  row[10] = spec.amountColumn || '';
  row[11] = spec.purposeColumn || '';
  row[12] = spec.dateAltColumn || '';
  row[13] = spec.columnProfile ? JSON.stringify(spec.columnProfile) : '';
  row[14] = spec.exclusionRule ? JSON.stringify(spec.exclusionRule) : '';
  row[15] = spec.countTotalRule ? JSON.stringify(spec.countTotalRule) : '';
  row[16] = spec.billingRule ? JSON.stringify(spec.billingRule) : '';
  row[17] = spec.parserKind || 'generic';
  row[18] = version;
  row[19] = activeUserEmail_();
  row[21] = now;
  row[24] = spec.lookbackMonths === undefined ? '' : spec.lookbackMonths;
  row[25] = spec.forwardMonths === undefined ? '' : spec.forwardMonths;
  row[27] = spec.answers ? JSON.stringify(spec.answers) : '';
  row[29] = spec.revisionReason || 'NEW';
  row[30] = spec.foreignCurrencyColumn || '';
  row[31] = spec.foreignAmountColumn || '';
  row[32] = spec.exchangeRateColumn || '';
  row[33] = now;

  var validated = formatRowFromValues_(row, null);
  if (!validated.valid) {
    throw new FormatDefinitionError('The definition does not pass the 2.1.2 schemas: ' +
      validated.problems.join('; '));
  }
  var rowNumber = sheet.getLastRow() + 1;
  ensureRowExists_(sheet, rowNumber);
  sheet.getRange(rowNumber, 1, 1, CARD_FORMAT_COLUMNS_).setValues([row]);
  return {installed: true, formatId: String(spec.formatId), version: version, rowNumber: rowNumber};
}

/**
 * 三井住友系（家計簿ダウンロード形。氏名行＋日付/店名/金額…）のCSV変種を
 * 初期形式として投入する。samplesのLINEPAYカードCSVがこの形である。
 *
 * 判定は「1行目に氏名行（様）＋明細行の列構造（A日付・C金額）」による。
 * この系はカード名がファイルごとに違うため、内容キーワードだけに頼れない。
 */
function installSmbcCsvFormat() {
  return installCardFormat({
    formatId: 'smbc_family_csv',
    formatName: '三井住友系CSV（氏名行つき7列）',
    fileTypes: ['csv'],
    keywordRule: {allOf: [{maxRow: 1, keywords: ['様'], minMatch: 1}]},
    headerRow: 1,
    dataStartRow: 2,
    dateColumn: 'A', merchantColumn: 'B', amountColumn: 'C', purposeColumn: 'G',
    columnProfile: {minColumns: 7, sampleRows: 5, columns: [
      {index: 0, type: 'date', required: true},
      {index: 1, type: 'text', required: true},
      {index: 2, type: 'number', required: true}
    ]},
    exclusionRule: {
      excludeRowRanges: [{from: 1, to: 1}],
      excludeWhenDateAndAmountEmpty: true,
      rules: [
        {id: 'smbc_deposit', target: 'cell', column: 'B', match: 'contains', value: 'ご入金'},
        {id: 'smbc_total', target: 'row', match: 'contains', value: '合計', onlyWhenDateEmpty: true}
      ]
    },
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    billingRule: {sources: [
      {id: 'fn_ym', kind: 'fileName', pattern: '(20\\d{2})[-_年/]?(0[1-9]|1[0-2])月?',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}
    ]},
    parserKind: 'generic',
    version: 1,
    revisionReason: 'NEW'
  });
}

/**
 * 導入時の設定を Script Properties へまとめて保存する（10.4）。
 *
 * エディタから1回呼ぶための入口。**値の妥当性はここで検証しない** ──
 * 保存後に`validateSettings('ADMIN')`を実行し、その結果に従って直す。
 * 保存と検証を分けるのは、途中まで正しい設定を保存できるようにするため。
 */
function saveInstallationProperties(values) {
  if (!values || typeof values !== 'object') {
    throw new TypeError('saveInstallationProperties requires a settings object');
  }
  var properties = PropertiesService.getScriptProperties();
  var saved = [];
  Object.keys(values).forEach(function(key) {
    properties.setProperty(String(key), String(values[key]));
    saved.push(String(key));
  });
  return {saved: saved.sort()};
}

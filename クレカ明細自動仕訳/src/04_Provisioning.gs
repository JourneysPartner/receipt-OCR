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
  {key: 'CUSTOMER_MASTER', width: 40, label: '顧客ID'},
  {key: 'COMMON_PARTNER_LIST', width: 6, label: '取引先ID'},
  {key: 'COMMON_PARTNER_DICT', width: 18, label: '辞書ID'},
  {key: 'CUSTOMER_PARTNER_DICT', width: 18, label: '辞書ID'},
  {key: 'PURPOSE_COMPLEMENT', width: 10, label: 'ルールID'},        // ※
  {key: 'CARD_FORMAT_MASTER', width: 36, label: '形式ID'},          // ※
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

/** グリッドの列数を仕様幅まで広げる。値・数式には触れない。 */
function ensureSheetWidth_(sheet, width) {
  var current = sheet.getMaxColumns();
  if (current < width) {
    sheet.insertColumnsAfter(current, width - current);
    return true;
  }
  return false;
}

/**
 * 必須シートを作る。冪等 ── 既存シートの**値・数式には触れず**、無いものだけ
 * 作る。ただしグリッドの**列数**は仕様幅まで広げる（右端への空列追加のみ。
 * 縮めない）。実機の`insertSheet`は既定26列であり、広げないと取引ログ
 * （45列）や顧客マスター（38列）への書込が実機でだけ範囲外になる。
 *
 * @param {string=} spreadsheetId 省略時はマスター（4.6の解決順）
 * @return {{created: !Array<string>, existing: !Array<string>, widened: !Array<string>}}
 */
function provisionMasterSheets(spreadsheetId) {
  var spreadsheet = spreadsheetId
    ? SpreadsheetApp.openById(spreadsheetId) : masterSpreadsheet_();
  var created = [];
  var existing = [];
  var widened = [];

  MASTER_SHEET_SPECS_.forEach(function(spec) {
    var name = CONFIG.SHEET_NAMES[spec.key];
    var sheet = spreadsheet.getSheetByName(name);
    if (sheet) {
      existing.push(name);
    } else {
      sheet = spreadsheet.insertSheet(name);
      sheet.getRange(1, 1).setValue(spec.label);
      created.push(name);
    }
    if (ensureSheetWidth_(sheet, spec.width)) widened.push(name);
  });

  return {created: created, existing: existing, widened: widened};
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
 * freeeの実テンプレートのように「ヘッダーの下に入力禁止の仕切り行」がある
 * 場合は`dataStartRow`を渡す。顧客マスターAD列には**データ前最終行**
 * （`dataStartRow - 1`）を保存し、AE列の`row`に実ヘッダー行を保存する
 * （5.11の走査はAD+1から、4.22のヘッダー照合はAE.rowで行われる）。
 *
 * @param {!Object} config
 *   customerId, customerName, sourceFolderId, destinationSpreadsheetId,
 *   destinationSheetName, columns {B,F,I,K,M,txId},
 *   partnerListSheetName?, headerRow?（既定1）, dataStartRow?（既定headerRow+1）,
 *   rowScanExcludedColumns?（空き行判定除外列。既定値・数式が常在する列）,
 *   rowScanLastColumn?, reviewers?, admins?,
 *   partnerExemptPurposes?（取引先を空欄のままにしてよい使用用途。
 *     例 ["私用", "ふるさと納税", "振替"]）,
 *   customerCategory?（既定CORPORATE）, fiscalYear?
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
  var dataStartRow = Number.isInteger(config.dataStartRow) ?
    config.dataStartRow : headerRow + 1;
  if (dataStartRow <= headerRow) {
    throw new TypeError('dataStartRow must be below headerRow');
  }
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

  var row = Array(CUSTOMER_MASTER_COLUMNS_).fill('');
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
  // AD列＝データ前最終行。仕切り行がある場合はその行番号になり、
  // 5.11の空き行走査はその次（dataStartRow）から始まる。
  row[29] = dataStartRow - 1;
  row[30] = JSON.stringify({row: headerRow, allowExtraColumns: true, cells: cells});
  row[31] = '{}';
  row[32] = '{}';
  row[33] = rowScanLastColumn;
  row[34] = String(config.partnerListSheetName || '取引先一覧');
  row[35] = category;
  row[36] = config.fiscalYear === undefined || config.fiscalYear === null ? '' : config.fiscalYear;
  row[37] = config.rowScanExcludedColumns && config.rowScanExcludedColumns.length ?
    JSON.stringify(config.rowScanExcludedColumns) : '';
  row[38] = config.partnerExemptPurposes && config.partnerExemptPurposes.length ?
    JSON.stringify(config.partnerExemptPurposes) : '';
  row[39] = config.cardNamePartnerPurposes && config.cardNamePartnerPurposes.length ?
    JSON.stringify(config.cardNamePartnerPurposes) : '';

  var masterSheet = requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CUSTOMER_MASTER);
  ensureSheetWidth_(masterSheet, CUSTOMER_MASTER_COLUMNS_);
  var existing = findRowsByColumnValue_(masterSheet, 1, config.customerId, CUSTOMER_MASTER_COLUMNS_);
  var rowNumber = existing.length ? existing[0].rowNumber : masterSheet.getLastRow() + 1;
  ensureRowExists_(masterSheet, rowNumber);
  masterSheet.getRange(rowNumber, 1, 1, CUSTOMER_MASTER_COLUMNS_).setValues([row]);

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
  var now = nowIso_();
  var version = Number(spec.version || 1);

  if (spec.supersede === true) {
    // 仕様18.5：旧行は`有効=FALSE`で残し、新バージョン行を追加する。
    var allVersions = loadFormatDefinitions({formatId: spec.formatId});
    version = allVersions.reduce(function(max, row) {
      return Math.max(max, Number(row.version) || 0);
    }, 0) + 1;
    allVersions.filter(function(row) { return row.enabled; }).forEach(function(row) {
      sheet.getRange(row._rowNumber, 4).setValue(false);          // D 有効
      sheet.getRange(row._rowNumber, 23).setValue(now);           // W 無効化日時
      sheet.getRange(row._rowNumber, 24).setValue('SUPERSEDED');  // X 理由
      sheet.getRange(row._rowNumber, 34).setValue(now);           // AH 最終更新
    });
  } else {
    var existing = loadFormatDefinitions({formatId: spec.formatId, version: version});
    if (existing.length) {
      return {installed: false, reason: 'ALREADY_EXISTS', formatId: spec.formatId, version: version};
    }
  }
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
  row[34] = spec.cardNameRule ? JSON.stringify(spec.cardNameRule) : '';
  row[35] = spec.amountFallbackColumn || '';

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
    // C(ご利用金額)が空欄の行はF(当月支払額)を見る。キャッシュバックの
    // 行はカード明細側の仕様でCが空になる。
    amountFallbackColumn: 'F',
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
 * 三井住友系のxlsx変種（8列：G=備考・H=使用用途）を投入する。
 * VisaLINEPay・Amazonマスター・三井住友NL等のExcel版がこの形。
 *
 * 注意：dカード系（9列・用途はI列）もこの判定に一致し得る。dカード用の
 * 変種を登録する時点で判定衝突（AMBIGUOUS）となり人の選択に回る ──
 * それまでの間、dカードのxlsxを流すと用途が全行空欄＝区分1で顧客へ
 * 差し戻される（黙って誤読はしない）。
 */
function installSmbcXlsxFormat() {
  return installCardFormat({
    formatId: 'smbc_family_x8',
    formatName: '三井住友系Excel（氏名行つき8列）',
    fileTypes: ['xlsx'],
    keywordRule: {allOf: [{maxRow: 1, keywords: ['様'], minMatch: 1}]},
    headerRow: 1,
    dataStartRow: 2,
    dateColumn: 'A', merchantColumn: 'B', amountColumn: 'C', purposeColumn: 'H',
    // C(ご利用金額)が空欄の行はF(当月支払額)を見る。キャッシュバックの
    // 行はカード明細側の仕様でCが空になる。
    amountFallbackColumn: 'F',
    columnProfile: {minColumns: 8, sampleRows: 5, columns: [
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
 * 顧客追記済み明細（使用用途列つき）の形式群・第1弾。
 *
 * samplesの実ファイル構造から導出した初期投入データ（2.1.2.1と同じ位置づけ。
 * データであって設計ではない）。同一発行元の幅違い変種は
 * `columnProfile.maxColumns`（実装差戻し#27）で判別する。
 *
 * まだ含めない（理由つき）：イオン系・UCS・コメリ（日付が数値のYYYYMMDD/
 * YYMMDDで、5.1.0の列挙では数値＝Excelシリアルとなり誤読するため、解釈の
 * 設計追加が先）、dカード内訳明細（複数セクション）、コストコ／オリコ
 * （ヘッダーブロックが縦持ち）。
 *
 * 期待する判定結果は`test/phase6-real-samples.test.js`が実サンプルから
 * 生成した固定データで固定している。ここを触ったらそちらも見ること。
 */
var ANNOTATED_FORMAT_SPECS_ = [
  {
    formatId: 'smbc_family_x7', formatName: '三井住友系Excel（7列・用途G）',
    fileTypes: ['xlsx'],
    keywordRule: {allOf: [{maxRow: 1, keywords: ['様'], minMatch: 1}]},
    headerRow: 1, dataStartRow: 2,
    dateColumn: 'A', merchantColumn: 'B', amountColumn: 'C', purposeColumn: 'G',
    // C(ご利用金額)が空欄の行はF(当月支払額)を見る。キャッシュバックの
    // 行はカード明細側の仕様でCが空になる。
    amountFallbackColumn: 'F',
    columnProfile: {minColumns: 7, maxColumns: 7, sampleRows: 5, columns: [
      {index: 0, type: 'date', required: true},
      {index: 1, type: 'text', required: true},
      {index: 2, type: 'number', required: true}
    ]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true,
      rules: [{id: 'deposit', target: 'cell', column: 'B', match: 'contains', value: 'ご入金'},
              {id: 'total', target: 'row', match: 'contains', value: '合計', onlyWhenDateEmpty: true}]},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'cell', row: 1, column: 3}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    billingRule: {sources: [
      {id: 'fn_ym', kind: 'fileName', pattern: '(20\\d{2})[-_年/]?(0[1-9]|1[0-2])月?',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}
    ]}
  },
  {
    formatId: 'smbc_family_x9', formatName: '三井住友系Excel（9列・用途I）',
    fileTypes: ['xlsx'],
    keywordRule: {allOf: [{maxRow: 1, keywords: ['様'], minMatch: 1}]},
    headerRow: 1, dataStartRow: 2,
    dateColumn: 'A', merchantColumn: 'B', amountColumn: 'C', purposeColumn: 'I',
    // C(ご利用金額)が空欄の行はF(当月支払額)を見る。キャッシュバックの
    // 行はカード明細側の仕様でCが空になる。
    amountFallbackColumn: 'F',
    columnProfile: {minColumns: 9, maxColumns: 9, sampleRows: 5, columns: [
      {index: 0, type: 'date', required: true},
      {index: 1, type: 'text', required: true},
      {index: 2, type: 'number', required: true}
    ]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true,
      rules: [{id: 'deposit', target: 'cell', column: 'B', match: 'contains', value: 'ご入金'},
              {id: 'total', target: 'row', match: 'contains', value: '合計', onlyWhenDateEmpty: true}]},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'cell', row: 1, column: 3}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    billingRule: {sources: [
      {id: 'fn_ym', kind: 'fileName', pattern: '(20\\d{2})[-_年/]?(0[1-9]|1[0-2])月?',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}
    ]}
  },
  {
    formatId: 'jcb_family', formatName: 'JCB系Excel（13列・用途M）',
    fileTypes: ['xlsx'],
    keywordRule: {allOf: [{maxRow: 6,
      keywords: ['ご利用者', 'カテゴリ', 'ご利用日', 'ご利用先など', '使用用途'], minMatch: 5}]},
    headerRow: 6, dataStartRow: 7,
    dateColumn: 'C', merchantColumn: 'D', amountColumn: 'E', purposeColumn: 'M',
    columnProfile: {minColumns: 13, maxColumns: 13, sampleRows: 5, columns: [
      {index: 2, type: 'date', required: true},
      {index: 3, type: 'text', required: true},
      {index: 4, type: 'number', required: true}
    ]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 6}], excludeWhenDateAndAmountEmpty: true,
      rules: [{id: 'total', target: 'row', match: 'contains', value: '合計', onlyWhenDateEmpty: true}]},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    billingRule: {sources: [
      {id: 'hdr_pay', kind: 'scanRows', scanMaxRows: 6,
        pattern: '今回のお支払日\\s+(20\\d{2})-(0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}
    ]}
  },
  {
    formatId: 'jal_family', formatName: 'JALカード系Excel（9列・日付シリアル・用途I）',
    fileTypes: ['xlsx'],
    keywordRule: {allOf: [{maxRow: 1,
      keywords: ['確定情報', 'お支払日', 'ご利用店名', 'ご利用日', '使用用途'], minMatch: 5}]},
    headerRow: 1, dataStartRow: 3,
    dateColumn: 'D', merchantColumn: 'C', amountColumn: 'G', purposeColumn: 'I',
    columnProfile: {minColumns: 9, maxColumns: 9, sampleRows: 5, columns: [
      {index: 3, type: 'date', required: true},
      {index: 2, type: 'text', required: true},
      {index: 6, type: 'number', required: true}
    ]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 2}], excludeWhenDateAndAmountEmpty: true,
      rules: [{id: 'tax_total', target: 'row', match: 'contains', value: '消費税課税対象合計',
        onlyWhenDateEmpty: true}]},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    billingRule: null
  },
  {
    formatId: 'amex_6', formatName: 'AMEX系Excel（6列・用途F）',
    fileTypes: ['xlsx'],
    keywordRule: {allOf: [{maxRow: 1,
      keywords: ['ご利用日', 'データ処理日', 'ご利用内容', '金額', '使用用途'], minMatch: 5}]},
    headerRow: 1, dataStartRow: 2,
    dateColumn: 'A', merchantColumn: 'C', amountColumn: 'D', purposeColumn: 'F',
    columnProfile: {minColumns: 6, maxColumns: 6, sampleRows: 5, columns: [
      {index: 0, type: 'date', required: true},
      {index: 2, type: 'text', required: true},
      {index: 3, type: 'number', required: true}
    ]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    billingRule: null
  },
  {
    formatId: 'amex_6_alt', formatName: 'AMEX系Excel（6列・用途を海外通貨列Eに記入）',
    fileTypes: ['xlsx'],
    // amex_7と見出しは同一で、違うのは幅だけ（換算レート列まで6列）。
    // 顧客は見出しの無い右端が無いため「海外通貨利用金額」列へ用途を書く。
    keywordRule: {allOf: [{maxRow: 1,
      keywords: ['ご利用日', 'データ処理日', 'ご利用内容', '金額', '換算レート'], minMatch: 5}]},
    headerRow: 1, dataStartRow: 2,
    dateColumn: 'A', merchantColumn: 'C', amountColumn: 'D', purposeColumn: 'E',
    columnProfile: {minColumns: 6, maxColumns: 6, sampleRows: 5, columns: [
      {index: 0, type: 'date', required: true},
      {index: 2, type: 'text', required: true},
      {index: 3, type: 'number', required: true}
    ]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    billingRule: null
  },
  {
    formatId: 'amex_7', formatName: 'AMEX系Excel（7列・用途G）',
    fileTypes: ['xlsx'],
    keywordRule: {allOf: [{maxRow: 1,
      keywords: ['ご利用日', 'データ処理日', 'ご利用内容', '金額', '換算レート'], minMatch: 5}]},
    headerRow: 1, dataStartRow: 2,
    dateColumn: 'A', merchantColumn: 'C', amountColumn: 'D', purposeColumn: 'G',
    columnProfile: {minColumns: 7, maxColumns: 7, sampleRows: 5, columns: [
      {index: 0, type: 'date', required: true},
      {index: 2, type: 'text', required: true},
      {index: 3, type: 'number', required: true}
    ]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    billingRule: null
  },
  {
    formatId: 'amex_9', formatName: 'AMEX系Excel（9列・会員番号つき・用途I）',
    fileTypes: ['xlsx'],
    keywordRule: {allOf: [{maxRow: 1,
      keywords: ['ご利用日', 'ご利用内容', 'カード会員様名', '会員番号', '金額'], minMatch: 5}]},
    headerRow: 1, dataStartRow: 2,
    dateColumn: 'A', merchantColumn: 'C', amountColumn: 'F', purposeColumn: 'I',
    columnProfile: {minColumns: 9, maxColumns: 9, sampleRows: 5, columns: [
      {index: 0, type: 'date', required: true},
      {index: 2, type: 'text', required: true},
      {index: 5, type: 'number', required: true}
    ]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    billingRule: null
  },
  {
    formatId: 'rakuten_x11', formatName: '楽天カード系Excel（11列・用途K）',
    fileTypes: ['xlsx'],
    keywordRule: {allOf: [{maxRow: 1,
      keywords: ['利用日', '利用店名・商品名', '利用金額', '新規サイン', '使用用途'], minMatch: 5}]},
    headerRow: 1, dataStartRow: 2,
    dateColumn: 'A', merchantColumn: 'B', amountColumn: 'E', purposeColumn: 'K',
    columnProfile: {minColumns: 11, maxColumns: 11, sampleRows: 5, columns: [
      {index: 0, type: 'date', required: true},
      {index: 1, type: 'text', required: true},
      {index: 4, type: 'number', required: true}
    ]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true,
      rules: [{id: 'deposit', target: 'row', match: 'contains', value: 'ご入金', onlyWhenDateEmpty: true}]},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    billingRule: {sources: [
      {id: 'fn_enavi', kind: 'fileName', pattern: 'enavi(20\\d{2})(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}
    ]}
  },
  {
    formatId: 'rakuten_x12', formatName: '楽天カード系Excel（12列・支払月・用途L）',
    fileTypes: ['xlsx'],
    keywordRule: {allOf: [{maxRow: 1,
      keywords: ['利用日', '利用店名・商品名', '利用金額', '支払月'], minMatch: 4}]},
    headerRow: 1, dataStartRow: 2,
    dateColumn: 'A', merchantColumn: 'B', amountColumn: 'E', purposeColumn: 'L',
    columnProfile: {minColumns: 12, maxColumns: 12, sampleRows: 5, columns: [
      {index: 0, type: 'date', required: true},
      {index: 1, type: 'text', required: true},
      {index: 4, type: 'number', required: true}
    ]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true,
      rules: [{id: 'deposit', target: 'row', match: 'contains', value: 'ご入金', onlyWhenDateEmpty: true}]},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    billingRule: null
  },
  {
    formatId: 'saison_x8', formatName: 'セゾン系Excel（8列・用途H）',
    fileTypes: ['xlsx'],
    keywordRule: {allOf: [
      {maxRow: 5, keywords: ['利用日', 'ご利用店名及び商品名', '利用金額', '使用用途'], minMatch: 4},
      {maxRow: 5, keywords: ['カード名称'], minMatch: 1}
    ]},
    headerRow: 5, dataStartRow: 7,
    dateColumn: 'A', merchantColumn: 'B', amountColumn: 'F', purposeColumn: 'H',
    // 日付を必須にしない：明細候補行のサンプリングは金額だけの【小計】
    // 【合計】行も拾うため（2.1.2.3の評価規則）、日付必須だと自ファイルで
    // 不成立になる。判別は列数8＋見出しキーワードが担う。
    columnProfile: {minColumns: 8, maxColumns: 8, sampleRows: 5, columns: [
      {index: 1, type: 'text', required: true},
      {index: 5, type: 'number', required: true}
    ]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 6}], excludeWhenDateAndAmountEmpty: true,
      rules: [
        {id: 'subtotal', target: 'row', match: 'contains', value: '小計', onlyWhenDateEmpty: true},
        {id: 'total', target: 'row', match: 'contains', value: '合計', onlyWhenDateEmpty: true},
        {id: 'deposit', target: 'cell', column: 'B', match: 'contains', value: 'ご入金'}
      ]},
    countTotalRule: {count: {source: 'none'},
      total: {source: 'labeledRow', labelColumn: 'B', valueColumn: 'F', label: '【合計】', tolerance: 0},
      totalScope: 'all'},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'cell', row: 1, column: 2}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    billingRule: {sources: [
      {id: 'hdr_pay', kind: 'scanRows', scanMaxRows: 4,
        pattern: 'お支払日\\s+(20\\d{2})-(0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}
    ]}
  },
  {
    formatId: 'paypay_family', formatName: 'PayPayカード系Excel（13列・用途M）',
    fileTypes: ['xlsx'],
    keywordRule: {allOf: [{maxRow: 1,
      keywords: ['利用日/キャンセル日', '利用店名・商品名', '決済方法', '支払区分', '利用金額'], minMatch: 5}]},
    headerRow: 1, dataStartRow: 2,
    dateColumn: 'A', merchantColumn: 'B', amountColumn: 'F', purposeColumn: 'M',
    columnProfile: {minColumns: 13, maxColumns: 13, sampleRows: 5, columns: [
      {index: 0, type: 'date', required: true},
      {index: 1, type: 'text', required: true},
      {index: 5, type: 'number', required: true}
    ]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    billingRule: null
  },
  {
    formatId: 'aupay_family', formatName: 'au PAYカード系Excel（7列・用途G）',
    fileTypes: ['xlsx'],
    keywordRule: {allOf: [{maxRow: 1,
      keywords: ['ご利用者', '支払区分', '利用日', '利用店名', '利用金額'], minMatch: 5}]},
    headerRow: 1, dataStartRow: 2,
    dateColumn: 'C', merchantColumn: 'D', amountColumn: 'E', purposeColumn: 'G',
    columnProfile: {minColumns: 7, maxColumns: 7, sampleRows: 5, columns: [
      {index: 2, type: 'date', required: true},
      {index: 3, type: 'text', required: true},
      {index: 4, type: 'number', required: true}
    ]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    billingRule: null
  },
  {
    formatId: 'ucs_family', formatName: 'UCS系Excel（11列・数値YYYYMMDD・用途K）',
    fileTypes: ['xlsx'],
    keywordRule: {allOf: [{maxRow: 1,
      keywords: ['支払方法コード', '支払方法', '利用日', '加盟店名称', '利用金額'], minMatch: 5}]},
    headerRow: 1, dataStartRow: 2,
    dateColumn: 'C', merchantColumn: 'D', amountColumn: 'E', purposeColumn: 'K',
    columnProfile: {minColumns: 11, maxColumns: 11, sampleRows: 5, columns: [
      {index: 2, type: 'date', required: true},
      {index: 3, type: 'text', required: true},
      {index: 4, type: 'number', required: true}
    ]},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    billingRule: {sources: [
      {id: 'fn_ym', kind: 'fileName', pattern: '(20\\d{2})[-_]?(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}
    ]}
  },
  {
    formatId: 'komeri_family', formatName: 'コメリ系Excel（11列・数値YYYYMMDD・用途K）',
    fileTypes: ['xlsx'],
    keywordRule: {allOf: [{maxRow: 1,
      keywords: ['ご利用日', 'ご利用先など', 'ご利用金額', '今回のご請求額', '使用用途'], minMatch: 5}]},
    headerRow: 1, dataStartRow: 2,
    dateColumn: 'A', merchantColumn: 'C', amountColumn: 'D', purposeColumn: 'K',
    columnProfile: {minColumns: 11, maxColumns: 11, sampleRows: 5, columns: [
      {index: 0, type: 'date', required: true},
      {index: 2, type: 'text', required: true},
      {index: 3, type: 'number', required: true}
    ]},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    billingRule: {sources: [
      // 月は2桁の枝を先に置く。`0?[1-9]`を先に書くと"11"の先頭だけが
      // 食われて月=1になる（後ろに必須の文字が続かないので後戻りしない）。
      {id: 'fn_ym', kind: 'fileName', pattern: '(20\\d{2})[-_](1[0-2]|0?[1-9])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}
    ]}
  },
  {
    formatId: 'aeon_x8', formatName: 'イオン系Excel（8列・数値YYMMDD・用途H）',
    fileTypes: ['xlsx'],
    // 明細ブロックは8行目から始まる（1〜7行目は請求額・口座の見出し）。
    keywordRule: {allOf: [{maxRow: 8,
      keywords: ['ご利用カード', 'ご利用明細', 'ご利用日', 'ご利用先', 'ご利用金額'], minMatch: 5}]},
    headerRow: 8, dataStartRow: 9,
    dateColumn: 'A', merchantColumn: 'C', amountColumn: 'G', purposeColumn: 'H',
    columnProfile: {minColumns: 8, maxColumns: 8, sampleRows: 5, columns: [
      {index: 0, type: 'date', required: true},
      {index: 2, type: 'text', required: true},
      {index: 6, type: 'number', required: true}
    ]},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'cell', row: 1, column: 2}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 8}], excludeWhenDateAndAmountEmpty: true, rules: []},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    billingRule: {sources: [
      {id: 'fn_ym', kind: 'fileName', pattern: '(20\\d{2})[-_]?(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}
    ]}
  },
  {
    formatId: 'aeon_x9', formatName: 'イオン系Excel（9列・数値YYMMDD・用途I）',
    fileTypes: ['xlsx'],
    keywordRule: {allOf: [{maxRow: 8,
      keywords: ['ご利用カード', 'ご利用明細', 'ご利用日', 'ご利用先', 'ご利用金額'], minMatch: 5}]},
    headerRow: 8, dataStartRow: 9,
    dateColumn: 'A', merchantColumn: 'C', amountColumn: 'G', purposeColumn: 'I',
    columnProfile: {minColumns: 9, maxColumns: 9, sampleRows: 5, columns: [
      {index: 0, type: 'date', required: true},
      {index: 2, type: 'text', required: true},
      {index: 6, type: 'number', required: true}
    ]},
    cardNameRule: {sources: [{kind: 'folderName'}, {kind: 'cell', row: 1, column: 2}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
    exclusionRule: {excludeRowRanges: [{from: 1, to: 8}], excludeWhenDateAndAmountEmpty: true, rules: []},
    countTotalRule: {count: {source: 'none'}, total: {source: 'none'}, totalScope: 'all'},
    billingRule: {sources: [
      {id: 'fn_ym', kind: 'fileName', pattern: '(20\\d{2})[-_]?(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}
    ]}
  }
];

/** 既存形式へカード名の取得元（AI列）を後付けする。 */
var CARD_NAME_RULE_PATCHES_ = Object.freeze({
  smbc_family_csv: {sources: [{kind: 'folderName'}, {kind: 'cell', row: 1, column: 3}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]},
  smbc_family_x8: {sources: [{kind: 'folderName'}, {kind: 'cell', row: 1, column: 3}, {kind: 'sheetName', pattern: '^([^0-9]+?)\\s*[0-9]{4,}'}]}
});

/**
 * 第1弾の形式群を一括投入する。冪等 ── 既にある(形式ID, 版)は書かない。
 * あわせて`smbc_family_x8`へ列数上限（maxColumns=8）が無ければ、
 * 上限つきの新バージョンで置き換える（旧版は`有効=FALSE`で残る）。
 */
function installAnnotatedFormatsBatch1() {
  var results = ANNOTATED_FORMAT_SPECS_.map(function(spec) {
    return installCardFormat(Object.assign({parserKind: 'generic', version: 1,
      revisionReason: 'NEW'}, spec));
  });

  var x8 = loadFormatDefinitions({formatId: 'smbc_family_x8', enabled: true})[0];
  if (x8 && x8.valid && (!x8.columnProfile || x8.columnProfile.maxColumns === undefined)) {
    var upgraded = Object.assign({}, {
      formatId: 'smbc_family_x8', formatName: x8.formatName,
      fileTypes: x8.fileTypes, keywordRule: x8.keywordRule,
      headerRow: x8.headerRow, dataStartRow: x8.dataStartRow,
      dateColumn: x8.dateColumn, merchantColumn: x8.merchantColumn,
      amountColumn: x8.amountColumn, purposeColumn: x8.purposeColumn,
      columnProfile: Object.assign({}, x8.columnProfile || {minColumns: 8}, {maxColumns: 8}),
      exclusionRule: x8.exclusionRule, countTotalRule: x8.countTotalRule,
      billingRule: x8.billingRule, parserKind: x8.parserKind,
      revisionReason: 'DEFECT_FIX', supersede: true
    });
    results.push(installCardFormat(upgraded));
  }
  Logger.log(JSON.stringify(results, null, 2));
  return results;
}

/**
 * 既に投入済みの形式へ、カード名の取得元（AI列）を後付けする。
 *
 * 年会費のように**明細の店名にカード会社が現れない**取引の取引先を、
 * カード名から決めるために要る（実装差戻し#31）。既存の版は
 * `installCardFormat`が(形式ID, 版)で冪等なので上書きされない ── 取得元を
 * 持たない版だけを置き換える（旧版は`有効=FALSE`で履歴として残る）。
 */
function installCardNameRules() {
  var wanted = Object.create(null);
  ANNOTATED_FORMAT_SPECS_.forEach(function(spec) {
    if (spec.cardNameRule) wanted[spec.formatId] = spec.cardNameRule;
  });
  Object.keys(CARD_NAME_RULE_PATCHES_).forEach(function(formatId) {
    wanted[formatId] = CARD_NAME_RULE_PATCHES_[formatId];
  });

  var results = Object.keys(wanted).map(function(formatId) {
    var current = loadFormatDefinitions({formatId: formatId, enabled: true})[0];
    if (!current || !current.valid) {
      return {formatId: formatId, skipped: current ? 'INVALID_DEFINITION' : 'NOT_INSTALLED'};
    }
    // 内容が同じときだけ飛ばす。「取得元があるか」で判定すると、誤った
    // 取得元が入った版を直せない（実機に`\s`を落とした版が入った）。
    if (JSON.stringify(current.cardNameRule) === JSON.stringify(wanted[formatId])) {
      return {formatId: formatId, skipped: 'ALREADY_SET'};
    }
    return installCardFormat({
      formatId: formatId, formatName: current.formatName, fileTypes: current.fileTypes,
      keywordRule: current.keywordRule, headerRow: current.headerRow,
      dataStartRow: current.dataStartRow, dateColumn: current.dateColumn,
      merchantColumn: current.merchantColumn, amountColumn: current.amountColumn,
      purposeColumn: current.purposeColumn, columnProfile: current.columnProfile,
      exclusionRule: current.exclusionRule, countTotalRule: current.countTotalRule,
      billingRule: current.billingRule, parserKind: current.parserKind,
      cardNameRule: wanted[formatId],
      revisionReason: 'ENHANCEMENT', supersede: true
    });
  });
  Logger.log(JSON.stringify(results, null, 2));
  return results;
}

/**
 * 既に投入済みの形式へ、請求年月の規則（AQ列）を後付けで差し替える。
 *
 * 規則の誤りはコードを直しただけでは実機に届かない ── 投入済みの定義が
 * 正だからである。月の枝順を誤った版が実機に入り、`komericard_2025_11`の
 * 締め年月が2024-12と読まれて明細8件が範囲外になった（2026-09-06）。
 * `installCardNameRules`と同じく、内容が違う版だけを置き換える。
 */
function installAmountFallbackColumns() {
  // ANNOTATED_FORMAT_SPECS_ の外で定義される形式（csv・x8）も同じ手当てが要る。
  var wanted = Object.create(null);
  ANNOTATED_FORMAT_SPECS_.forEach(function(spec) {
    if (spec.amountFallbackColumn) wanted[spec.formatId] = spec.amountFallbackColumn;
  });
  wanted.smbc_family_csv = 'F';
  wanted.smbc_family_x8 = 'F';

  var results = Object.keys(wanted).map(function(formatId) {
    var spec = {formatId: formatId, amountFallbackColumn: wanted[formatId]};
    var current = loadFormatDefinitions({formatId: formatId, enabled: true})[0];
    if (!current || !current.valid) {
      return {formatId: formatId, skipped: current ? 'INVALID_DEFINITION' : 'NOT_INSTALLED'};
    }
    if (String(current.amountFallbackColumn || '') === String(spec.amountFallbackColumn)) {
      return {formatId: formatId, skipped: 'ALREADY_SET'};
    }
    return installCardFormat({
      formatId: formatId, formatName: current.formatName, fileTypes: current.fileTypes,
      keywordRule: current.keywordRule, headerRow: current.headerRow,
      dataStartRow: current.dataStartRow, dateColumn: current.dateColumn,
      merchantColumn: current.merchantColumn, amountColumn: current.amountColumn,
      purposeColumn: current.purposeColumn, columnProfile: current.columnProfile,
      exclusionRule: current.exclusionRule, countTotalRule: current.countTotalRule,
      billingRule: current.billingRule, cardNameRule: current.cardNameRule,
      parserKind: current.parserKind,
      amountFallbackColumn: spec.amountFallbackColumn,
      revisionReason: 'ENHANCEMENT', supersede: true
    });
  });
  Logger.log(JSON.stringify(results, null, 2));
  return results;
}

function installBillingRules() {
  var results = ANNOTATED_FORMAT_SPECS_.filter(function(spec) {
    return !!spec.billingRule;
  }).map(function(spec) {
    var formatId = spec.formatId;
    var current = loadFormatDefinitions({formatId: formatId, enabled: true})[0];
    if (!current || !current.valid) {
      return {formatId: formatId, skipped: current ? 'INVALID_DEFINITION' : 'NOT_INSTALLED'};
    }
    if (JSON.stringify(current.billingRule) === JSON.stringify(spec.billingRule)) {
      return {formatId: formatId, skipped: 'ALREADY_SET'};
    }
    return installCardFormat({
      formatId: formatId, formatName: current.formatName, fileTypes: current.fileTypes,
      keywordRule: current.keywordRule, headerRow: current.headerRow,
      dataStartRow: current.dataStartRow, dateColumn: current.dateColumn,
      merchantColumn: current.merchantColumn, amountColumn: current.amountColumn,
      purposeColumn: current.purposeColumn, columnProfile: current.columnProfile,
      exclusionRule: current.exclusionRule, countTotalRule: current.countTotalRule,
      cardNameRule: current.cardNameRule, parserKind: current.parserKind,
      billingRule: spec.billingRule,
      revisionReason: 'DEFECT_FIX', supersede: true
    });
  });
  Logger.log(JSON.stringify(results, null, 2));
  return results;
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

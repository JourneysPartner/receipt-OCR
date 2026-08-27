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

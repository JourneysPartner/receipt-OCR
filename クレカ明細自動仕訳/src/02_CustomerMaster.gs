'use strict';

const CUSTOMER_MASTER_COLUMNS_ = 40;

function parseCustomerJson_(raw, label, allowEmpty) {
  if ((raw === '' || raw === null || raw === undefined) && allowEmpty) return {};
  var value;
  try { value = JSON.parse(String(raw)); } catch (error) {
    throw makeCatalogError_('DESTINATION_SCHEMA_MISMATCH', label + ' is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw makeCatalogError_('DESTINATION_SCHEMA_MISMATCH', label + ' must be a JSON object');
  }
  return value;
}

function customerFromRow_(values, rowNumber) {
  var category = String(values[35] || '');
  var fiscal = values[36] === '' || values[36] === null ? null : values[36];
  var customer = {
    customerId: String(values[0] || ''), customerName: String(values[1] || ''), isActive: toBool(values[2]),
    sourceFolderId: String(values[3] || ''), destinationSpreadsheetId: String(values[5] || ''),
    destinationSheetName: String(values[7] || ''), partnerListSheetName: String(values[8] || ''),
    columnMapping: {B: Number(values[9]), F: Number(values[10]), I: Number(values[11]), K: Number(values[12]), M: Number(values[13]), txId: Number(values[14])},
    schemaVersion: String(values[15] || ''), reviewers: csvEmails_(values[16]), admins: csvEmails_(values[17]),
    reviewCount: Number(values[18] || 0), reviewSummarySheetName: String(values[20] || CONFIG.REVIEW_SUMMARY.DEFAULT_SHEET_NAME),
    parallelState: String(values[21] || ''), parallelStartedOn: values[22] || null,
    parallelTransactionCount: Number(values[23] || 0), parallelCriticalMissCount: Number(values[24] || 0),
    parallelApprover: values[25] || null, parallelApprovedAt: values[26] || null, lastRescanAt: values[27] || null,
    headerRow: Number(values[29]), expectedHeader: parseCustomerJson_(values[30], 'AE', false),
    requiredFormulas: parseCustomerJson_(values[31], 'AF', true), expectedProtections: parseCustomerJson_(values[32], 'AG', true),
    rowScanLastColumn: Number(values[33]), parallelReferenceSheetName: String(values[34] || values[8] || ''),
    customerCategory: category, fiscalYear: fiscal,
    // AL列：空き行判定から除外する列番号（実装差戻し#16）。freeeテンプレは
    // 未入力行にも税計算区分の既定値と残高数式が入っており、除外しないと
    // 空き行が1行も見つからない。
    rowScanExcludedColumns: parseExcludedColumns_(values[37]),
    // AM列：取引先を空欄のままにしてよい使用用途（実装差戻し#30）。
    // 「私用」「ふるさと納税」「振替」のように相手取引先を立てない仕訳があり、
    // これらに取引先要確認を立てると、担当者が毎回「取引先なしで解決」を
    // 押すだけの作業になる。顧客ごとに増やせるようデータで持つ。
    partnerExemptPurposes: parsePurposeExemptions_(values[38], 'AM'),
    // AN列：取引先をカード名で決める使用用途（実装差戻し#31）。
    // 年会費のように、明細の店名にカード会社が現れない取引のためにある。
    cardNamePartnerPurposes: parsePurposeExemptions_(values[39], 'AN'),
    _rowNumber: rowNumber
  };
  return customer;
}

/**
 * AM列（取引先不要の使用用途）を読む。照合は正規化して行う ── 顧客の
 * 記入は全角・半角・空白が揺れるので、字面の一致に頼ると取りこぼす。
 * @param {*} raw @return {!Array<string>} 正規化済みの用途
 */
function parsePurposeExemptions_(raw, label) {
  if (raw === '' || raw === null || raw === undefined) return [];
  var parsed;
  try { parsed = JSON.parse(String(raw)); } catch (error) {
    throw new MasterDataError((label || 'AM') + ' (purpose list) is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new MasterDataError((label || 'AM') + ' (purpose list) must be a JSON array');
  }
  var exemptions = [];
  parsed.forEach(function(value) {
    var normalized = normalizeMerchant(value);
    if (!normalized) {
      throw new MasterDataError((label || 'AM') + ' (purpose list) must not contain empty values');
    }
    if (exemptions.indexOf(normalized) < 0) exemptions.push(normalized);
  });
  return exemptions;
}

function purposeInList_(list, purpose) {
  if (!list || !list.length) return false;
  var normalized = normalizeMerchant(purpose === null || purpose === undefined ? '' : purpose);
  return normalized !== '' && list.indexOf(normalized) >= 0;
}

/** 当該用途が「取引先を立てない」対象か（AM列）。 */
function isPartnerExemptPurpose(customer, purpose) {
  return purposeInList_(customer && customer.partnerExemptPurposes, purpose);
}

/** 当該用途が「取引先をカード名で決める」対象か（AN列）。 */
function isCardNamePartnerPurpose(customer, purpose) {
  return purposeInList_(customer && customer.cardNamePartnerPurposes, purpose);
}

/** @param {*} raw @return {!Array<number>} */
function parseExcludedColumns_(raw) {
  if (raw === '' || raw === null || raw === undefined) return [];
  var parsed;
  try { parsed = JSON.parse(String(raw)); } catch (error) {
    throw new MasterDataError('AL (excluded columns) is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new MasterDataError('AL (excluded columns) must be a JSON array');
  }
  return parsed.map(Number);
}

function validateCustomerValues_(customer) {
  if (!customer.customerId || !customer.customerName || !customer.sourceFolderId || !customer.destinationSpreadsheetId ||
      !customer.destinationSheetName || !customer.partnerListSheetName || !customer.schemaVersion ||
      !Number.isInteger(customer.headerRow) || customer.headerRow < 1 ||
      !Number.isInteger(customer.rowScanLastColumn) || customer.rowScanLastColumn < customer.columnMapping.txId) {
    throw new MasterDataError('CUSTOMER_MASTER_INVALID');
  }
  if (customer.customerCategory !== CUSTOMER_CATEGORY.CORPORATE && customer.customerCategory !== CUSTOMER_CATEGORY.INDIVIDUAL) {
    throw new MasterDataError('AJ must be CORPORATE or INDIVIDUAL');
  }
  if (customer.customerCategory === CUSTOMER_CATEGORY.INDIVIDUAL &&
      (!Number.isInteger(customer.fiscalYear) || customer.fiscalYear < 2000 || customer.fiscalYear > 2999)) {
    throw new MasterDataError('AK must be an integer from 2000 through 2999');
  }
  // AL列：除外できるのはシステムが書かない列だけ。B/F/I/K/M/取引ID列を
  // 除外すると、使用中の行が空き行に見えて顧客の入力を上書きする。
  var systemColumns = [customer.columnMapping.B, customer.columnMapping.F,
    customer.columnMapping.I, customer.columnMapping.K, customer.columnMapping.M,
    customer.columnMapping.txId];
  customer.rowScanExcludedColumns.forEach(function(column) {
    if (!Number.isInteger(column) || column < 1) {
      throw new MasterDataError('AL entries must be positive column numbers: CUSTOMER_MASTER_INVALID');
    }
    if (systemColumns.indexOf(column) >= 0) {
      throw new MasterDataError('AL must not contain a system-owned column (' + column + '): CUSTOMER_MASTER_INVALID');
    }
  });
  return customer;
}

function customerMasterRows_() {
  return readSheetRows_(requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CUSTOMER_MASTER), CUSTOMER_MASTER_COLUMNS_);
}

function getActiveCustomers() {
  var result = [];
  customerMasterRows_().forEach(function(row) {
    if (!toBool(row.values[2])) return;
    var customer = customerFromRow_(row.values, row.rowNumber);
    result.push(validateCustomerValues_(customer));
  });
  return result;
}

function getCustomerById(customerId) {
  var sheet = requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CUSTOMER_MASTER);
  var matches = findRowsByColumnValue_(sheet, 1, customerId, CUSTOMER_MASTER_COLUMNS_);
  if (matches.length !== 1) throw new MasterDataError(matches.length ? 'Duplicate customerId' : 'Customer not found: ' + customerId);
  return validateCustomerValues_(customerFromRow_(matches[0].values, matches[0].rowNumber));
}

function getAuthorizedCustomers(userEmail) {
  var wanted = String(userEmail || '').trim().toLowerCase();
  return getActiveCustomers().filter(function(customer) {
    return customer.reviewers.indexOf(wanted) >= 0 || customer.admins.indexOf(wanted) >= 0;
  });
}

function validateCustomerAccess(customerId) {
  var customer = getCustomerById(customerId);
  try {
    var folder = DriveApp.getFolderById(customer.sourceFolderId);
    var files = folder.getFiles();
    if (files.hasNext()) { var file = files.next(); file.setName(file.getName()); }
    var destination = SpreadsheetApp.openById(customer.destinationSpreadsheetId);
    var input = destination.getSheetByName(customer.destinationSheetName);
    var partners = destination.getSheetByName(customer.partnerListSheetName);
    if (!input || !partners) throw new Error('Destination sheets are missing');
    var writeProbe = input.getRange(1, 1);
    writeProbe.setValue(writeProbe.getValue());
    partners.getRange(1, 1).getValue();
    if (!destination.getSheetByName(customer.reviewSummarySheetName)) destination.insertSheet(customer.reviewSummarySheetName);
  } catch (error) {
    throw new AuthorizationError(error.message);
  }
}

function updateMasterReviewCount(customerId, count) {
  var customer = getCustomerById(customerId);
  setContiguousValues_(requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CUSTOMER_MASTER), customer._rowNumber, 19, [Number(count), nowIso_()]);
}

function updateParallelComparisonStats(customerId, delta) {
  var customer = getCustomerById(customerId);
  var sheet = requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CUSTOMER_MASTER);
  sheet.getRange(customer._rowNumber, 24, 1, 2).setValues([[
    customer.parallelTransactionCount + Number(valueOr_(delta, ['transactions', 'transactionCount'], 0)),
    customer.parallelCriticalMissCount + Number(valueOr_(delta, ['criticalMisses', 'criticalMissCount'], 0))
  ]]);
}

function setParallelComparisonEnded(customerId, approver) {
  var customer = getCustomerById(customerId);
  var sheet = requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CUSTOMER_MASTER);
  updateColumns_(sheet, customer._rowNumber, {22: PARALLEL_STATE.ENDED, 26: String(approver), 27: nowIso_()});
}

function updateLastRescanAt(customerId, at) {
  var customer = getCustomerById(customerId);
  requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CUSTOMER_MASTER).getRange(customer._rowNumber, 28).setValue(at || nowIso_());
}

function setCustomerFiscalYear(customerId, fiscalYear, actor, reason) {
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2999) throw new MasterDataError('Invalid fiscal year');
  var customer = getCustomerById(customerId);
  var before = customer.fiscalYear;
  if (before === fiscalYear) return {before: before, after: fiscalYear, changed: false, auditId: null};
  var auditEntry = {type: 'FISCAL_YEAR_CHANGE', actor: actor, targetType: 'CUSTOMER', targetId: customerId,
    customerId: customerId, before: {AK: before}, after: {AK: fiscalYear}, reason: reason || ''};
  var auditId;
  try { auditId = appendAudit(auditEntry); }
  catch (error) { throw makeCatalogError_('REQUIRED_LOG_WRITE_FAILED', error.message); }
  try {
    requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CUSTOMER_MASTER).getRange(customer._rowNumber, 37).setValue(fiscalYear);
  } catch (updateError) {
    try {
      appendAudit({type: 'FISCAL_YEAR_CHANGE', actor: actor, targetType: 'CUSTOMER', targetId: customerId,
        customerId: customerId, before: {AK: before}, after: {AK: before}, reason: 'AK_UPDATE_FAILED:' + auditId});
    } catch (cancelError) { throw makeCatalogError_('REQUIRED_LOG_WRITE_FAILED', cancelError.message); }
    return {before: before, after: before, changed: false, auditId: auditId};
  }
  return {before: before, after: fiscalYear, changed: true, auditId: auditId};
}

'use strict';

const CUSTOMER_MASTER_COLUMNS_ = 37;

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
    customerCategory: category, fiscalYear: fiscal, _rowNumber: rowNumber
  };
  return customer;
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

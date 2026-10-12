'use strict';

const CUSTOMER_PARTNER_LIST_WIDTH_ = 10;
const CUSTOMER_PARTNER_LIST_HEADER_ = Object.freeze([
  '取引先ID', '顧客ID', '取引先名', '状態', '寄せ先', '登録元', '登録者', '登録日時', '更新者', '更新日時'
]);

function customerPartnerListSheet_() {
  return requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CUSTOMER_PARTNER_LIST);
}

var customerPartnerListCache_ = {rows: null};

function forgetCustomerPartnerListCache_() {
  customerPartnerListCache_ = {rows: null};
}

/** 一覧を書く取得口。書く前に実行中の読み覚えを捨てる。 */
function customerPartnerListWriteSheet_() {
  forgetCustomerPartnerListCache_();
  return customerPartnerListSheet_();
}

function readCustomerPartnerRows_() {
  var rows = runScopedReads_ ? customerPartnerListCache_.rows : null;
  if (!rows) {
    rows = readSheetRows_(customerPartnerListSheet_(), CUSTOMER_PARTNER_LIST_WIDTH_);
    if (runScopedReads_) customerPartnerListCache_.rows = rows;
  }
  // 呼出側が値を直しても実行中に覚えた行が変わらないよう複製する。
  return rows.map(function(row) {
    return {rowNumber: row.rowNumber, values: row.values.slice()};
  });
}

/** 一覧の値は人が直接直すため、状態がACTIVE以外ならすべて使わない扱いにする。 */
function customerPartnerRecords_(rawRows) {
  return (Array.isArray(rawRows) ? rawRows : []).map(function(row) {
    var values = Array.isArray(row && row.values) ? row.values : [];
    var partnerId = String(values[0] === null || values[0] === undefined ? '' : values[0]).trim();
    var partnerName = String(values[2] === null || values[2] === undefined ? '' : values[2]).trim();
    if (!partnerId || !partnerName) return null;
    var state = String(values[3] === null || values[3] === undefined ? '' : values[3])
      .trim().toUpperCase();
    return {
      partnerId: partnerId,
      customerId: String(values[1] === null || values[1] === undefined ? '' : values[1]).trim(),
      partnerName: partnerName,
      active: state === 'ACTIVE',
      canonicalName: String(values[4] === null || values[4] === undefined ? '' : values[4]).trim(),
      source: String(values[5] === null || values[5] === undefined ? '' : values[5]).trim(),
      _rowNumber: Number(row.rowNumber) || 0
    };
  }).filter(Boolean);
}

/** 1つでもRETIRED等の行がある名前は有効名へ戻さない。 */
function buildPartnerNameIndex_(records, customerId) {
  var wantedCustomerId = String(customerId || '');
  var customerRecords = (Array.isArray(records) ? records : []).filter(function(record) {
    return String(record.customerId || '') === wantedCustomerId;
  });
  var activeRecords = [];
  var retiredRecords = [];
  var activeExact = Object.create(null);
  var retiredExact = Object.create(null);
  customerRecords.forEach(function(record) {
    if (record.active === true) {
      activeRecords.push(record);
    } else {
      retiredRecords.push(record);
      if (!Object.prototype.hasOwnProperty.call(retiredExact, record.partnerName)) {
        retiredExact[record.partnerName] = record.canonicalName || '';
      }
    }
  });

  var activeByKey = Object.create(null);
  activeRecords.forEach(function(record) {
    if (Object.prototype.hasOwnProperty.call(retiredExact, record.partnerName)) return;
    activeExact[record.partnerName] = true;
    var key = normalizeMerchant(record.partnerName);
    if (!key) return;
    if (!activeByKey[key]) activeByKey[key] = [];
    activeByKey[key].push({partnerId: record.partnerId, partnerName: record.partnerName});
  });

  var retiredByKey = Object.create(null);
  retiredRecords.forEach(function(record) {
    var key = normalizeMerchant(record.partnerName);
    if (!key) return;
    if (!retiredByKey[key]) retiredByKey[key] = [];
    retiredByKey[key].push({partnerName: record.partnerName, canonicalName: record.canonicalName || ''});
  });
  return {activeExact: activeExact, activeByKey: activeByKey,
    retiredExact: retiredExact, retiredByKey: retiredByKey};
}

function classifyPartnerName_(index, name) {
  var normalizedName = String(name === null || name === undefined ? '' : name).trim();
  var key = normalizeMerchant(normalizedName);
  var partnerIndex = index || {};
  if (partnerIndex.activeExact && Object.prototype.hasOwnProperty.call(partnerIndex.activeExact,
      normalizedName)) return {kind: 'KNOWN'};
  var active = key && partnerIndex.activeByKey && partnerIndex.activeByKey[key] || [];
  if (active.length) {
    var existing = [];
    active.forEach(function(record) {
      var partnerName = String(record.partnerName || '').trim();
      if (partnerName && existing.indexOf(partnerName) < 0) existing.push(partnerName);
    });
    if (existing.length) return {kind: 'VARIANT', existing: existing};
  }
  var retired = key && partnerIndex.retiredByKey && partnerIndex.retiredByKey[key] || [];
  if (retired.length) return {kind: 'RETIRED', name: normalizedName,
    canonical: String(retired[0].canonicalName || '').trim()};
  return {kind: 'NEW', name: normalizedName};
}

function partnerNameIssueMessage_(name, classification) {
  var partnerName = String(name === null || name === undefined ? '' : name).trim();
  var result = classification || {};
  if (result.kind === 'RETIRED') {
    var canonical = String(result.canonical || '').trim();
    return canonical ? '「' + partnerName + '」は使わない取引先名です。「' + canonical + '」を使ってください。' :
      '「' + partnerName + '」は使わない取引先名です。顧客別取引先一覧を確認してください。';
  }
  if (result.kind === 'VARIANT') {
    var names = [];
    (result.existing || []).forEach(function(existing) {
      var current = String(existing || '').trim();
      if (current && names.indexOf(current) < 0) names.push(current);
    });
    var quoted = names.map(function(existing) { return '「' + existing + '」'; }).join('');
    return '「' + partnerName + '」は登録済みの' + quoted +
      'と同じ名前です（全角・半角や大文字・小文字などの違いだけ）。' +
      (names.length > 1 ? 'どちらかを使ってください。' : quoted + 'を使ってください。');
  }
  return '';
}

function customerPartnerId_(customerId, partnerName) {
  return 'PTN_' + sha256Hex(utf8Bytes(JSON.stringify([
    String(customerId || ''), String(partnerName || '').trim()
  ])));
}

function registerCustomerPartnerNames_(customerId, names, actor, source) {
  if (!Array.isArray(names)) throw new TypeError('names must be an array');
  var wantedCustomerId = String(customerId || '');
  var requested = [];
  names.forEach(function(value) {
    var partnerName = String(value === null || value === undefined ? '' : value).trim();
    if (!partnerName || isPartnerUnknownLabel(partnerName) || partnerName === NO_PARTNER_MARKER_ ||
        requested.indexOf(partnerName) >= 0) return;
    requested.push(partnerName);
  });
  if (!requested.length) return [];

  return withScriptLock_(function() {
    var sheet = customerPartnerListWriteSheet_();
    var current = customerPartnerRecords_(readCustomerPartnerRows_());
    var existing = Object.create(null);
    current.forEach(function(record) {
      if (record.customerId !== wantedCustomerId) return;
      if (!existing[record.partnerName]) existing[record.partnerName] = true;
    });
    var newNames = requested.filter(function(partnerName) {
      return !existing[partnerName];
    });
    if (!newNames.length) return [];

    var registeredBy = String(actor || activeUserEmail_());
    var registeredSource = String(source || '');
    var now = nowIso_();
    var auditRows = [];
    var added = newNames.map(function(partnerName) {
      var partnerId = customerPartnerId_(wantedCustomerId, partnerName);
      auditRows.push({type: 'DICT_REGISTER', actor: registeredBy, targetType: 'PARTNER',
        targetId: partnerId, customerId: wantedCustomerId, before: null,
        after: {C: partnerName, D: 'ACTIVE', F: registeredSource}});
      return {partnerId: partnerId, partnerName: partnerName,
        row: [partnerId, wantedCustomerId, partnerName, 'ACTIVE', '', registeredSource,
          registeredBy, now, '', '']};
    });
    appendRowsBatched_(sheet, added.map(function(item) { return item.row; }),
      CUSTOMER_PARTNER_LIST_WIDTH_, 'partner-list');
    appendAuditRowsUnlocked_(auditRows);
    forgetCustomerPartnerListCache_();
    return added.map(function(item) {
      return {partnerId: item.partnerId, partnerName: item.partnerName};
    });
  });
}

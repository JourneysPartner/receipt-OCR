'use strict';

/**
 * 「設定」タブの「顧客一覧への登録」のサーバー側
 * （`work/spec_customer_registration.md` 版 1.0）。
 *
 * **画面から来た値は信じない。** 顧客フォルダ・明細フォルダ・顧客 ID・
 * 顧客名はすべて、Drive と別表をサーバーで読み直して確かめ直す。
 *
 * **有効（C が TRUE）で不正な行を作らない。** `getActiveCustomers()` は
 * 有効な行が 1 つでも不正だと例外になり、全顧客の画面と取込が止まる。
 * だから C は FALSE で書き、読み返した 45 個が書いた値と同じで
 * `validateCustomerValues_` を通った後だけ TRUE にする。
 *
 * **この画面は顧客の Drive に書かない。** 読むのはフォルダの一覧と親だけ。
 * 明細ファイルは開かない（S2）。
 */

/** プロファイルの 24 列（§2.4）。多すぎても少なすぎても PROFILE_INVALID。 */
var REGISTRATION_PROFILE_COLUMNS_ = Object.freeze([
  'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'U',
  'AD', 'AE', 'AF', 'AG', 'AH', 'AI',
  'AL', 'AM', 'AN', 'AO', 'AP', 'AQ', 'AR', 'AS'
]);

/** 列の添字（0 始まり）。§2.3 の対応表と同じ。 */
var REGISTRATION_COLUMN_INDEX_ = Object.freeze({
  A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6,
  H: 7, I: 8, J: 9, K: 10, L: 11, M: 12, N: 13, O: 14, P: 15,
  Q: 16, R: 17, S: 18, T: 19, U: 20,
  V: 21, W: 22, X: 23, Y: 24, Z: 25, AA: 26, AB: 27, AC: 28,
  AD: 29, AE: 30, AF: 31, AG: 32, AH: 33, AI: 34,
  AJ: 35, AK: 36, AL: 37, AM: 38, AN: 39, AO: 40,
  AP: 41, AQ: 42, AR: 43, AS: 44
});

var REGISTRATION_OPERATION_ = Object.freeze({
  START: 'WEBAPP:顧客登録の一覧',
  INSPECT: 'WEBAPP:顧客登録の下調べ',
  REGISTER: 'WEBAPP:顧客の登録'
});

var REGISTRATION_KEY_PROPERTIES_ = Object.freeze({
  ROOT_FOLDER: 'CUSTOMER_ROOT_FOLDER_ID',
  PROFILE: 'CUSTOMER_TEMPLATE_PROFILE_INDIVIDUAL',
  PROFILE_CORPORATE: 'CUSTOMER_TEMPLATE_PROFILE_CORPORATE',
  CONTRACT: 'CUSTOMER_ID_SOURCE_SPREADSHEET_ID',
  PRODUCTION_MASTER: 'PRODUCTION_MASTER_SPREADSHEET_ID'
});

var REGISTRATION_STAGE_PATTERNS_ = Object.freeze({
  shared: /資料共有/,
  year: /^令和(\d{1,2})年分$/,
  accounting: /経費|経理/,
  statement: /クレジット|クレカ|カード/
});

var REGISTRATION_STAGE_LABELS_ = Object.freeze({
  shared: '資料共有',
  year: '年',
  accounting: '経費',
  statement: '明細'
});

/** 登録に使うスクリプトプロパティ。SETTINGS には足さない（§2.2）。 */
function registrationProperty_(key) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  return value === null || value === undefined ? '' : String(value);
}

function registrationError_(code) {
  var error = new Error(String(code));
  error.name = 'RegistrationError';
  error.code = String(code);
  return error;
}

/** 読取の枠を数える（01 のペーサーと同じ口を通す）。 */
function registrationValuesGet_(spreadsheetId, range, options) {
  paceSheetsRead_();
  apiReadCount_ += 1;
  return Sheets.Spreadsheets.Values.get(spreadsheetId, range, options);
}

function registrationTrim_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function registrationNfkc_(value) {
  var text = value === null || value === undefined ? '' : String(value);
  return typeof text.normalize === 'function' ? text.normalize('NFKC') : text;
}

/** 名前の照合の鍵（§3.3）。別表・B 列・一覧の「登録済み」で共通に使う。 */
function registrationNameKey_(value) {
  return registrationNfkc_(registrationDisplayName_(value)).replace(/[\s　]/g, '');
}

/** 表示名の案（§3.3）。頭の【…】を続けて外し、前後の空白を除く。 */
function registrationDisplayName_(folderName) {
  var text = folderName === null || folderName === undefined ? '' : String(folderName);
  return text.replace(/^(?:[\s　]*【[^】]*】)+/, '').trim();
}

/** マスターの全行（有効・無効を問わない）の B と比べる（§3.3）。 */
function registrationNameProblem_(name, masterRows) {
  var trimmed = registrationTrim_(name);
  if (!trimmed) return 'NAME_EMPTY';
  if (trimmed.length > 50) return 'NAME_TOO_LONG';
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return 'NAME_INVALID_CHAR';
  if (/_\d{8}-\d{4}$/.test(trimmed)) return 'NAME_RESERVED_SUFFIX';
  var key = registrationNameKey_(trimmed);
  var duplicate = (masterRows || []).some(function(row) {
    return registrationNameKey_(row.values[REGISTRATION_COLUMN_INDEX_.B]) === key;
  });
  if (duplicate) return 'NAME_DUPLICATE';
  return null;
}

/** マスターの全行。ロックの外の下調べに使う。 */
function registrationMasterRows_() {
  return customerMasterRows_();
}

/**
 * ロックの中で読み直すマスター（§3.8 の 1）。
 * `SpreadsheetApp` の控えではなく Sheets API で A:AS を読む。
 */
function registrationMasterRowsFresh_() {
  var sheet = requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CUSTOMER_MASTER);
  var response = registrationValuesGet_(sheet.getParent().getId(),
    quoteSheetName_(sheet.getName()) + '!A:AS',
    {valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER',
      majorDimension: 'ROWS'});
  var values = response && response.values ? response.values : [];
  var rows = [];
  for (var index = 1; index < values.length; index += 1) {
    rows.push({rowNumber: index + 1, values: padRowValues_(values[index], CUSTOMER_MASTER_COLUMNS_)});
  }
  return {rows: rows, rowCount: values.length};
}

/** §2.4 のプロファイルを読む。空なら null、不正なら PROFILE_INVALID。 */
function registrationProfile_() {
  var raw = registrationTrim_(registrationProperty_(REGISTRATION_KEY_PROPERTIES_.PROFILE));
  if (!raw) return null;
  var profile;
  try {
    profile = JSON.parse(raw);
  } catch (error) {
    throw registrationError_('PROFILE_INVALID');
  }
  registrationValidateProfile_(profile);
  return profile;
}

function registrationValidateProfile_(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw registrationError_('PROFILE_INVALID');
  }
  if (profile.version !== 1 || profile.category !== 'INDIVIDUAL') {
    throw registrationError_('PROFILE_INVALID');
  }
  if (typeof profile.templateId !== 'string' || !profile.templateId) {
    throw registrationError_('PROFILE_INVALID');
  }
  var columns = profile.columns;
  if (!columns || typeof columns !== 'object' || Array.isArray(columns)) {
    throw registrationError_('PROFILE_INVALID');
  }
  var keys = Object.keys(columns);
  if (keys.length !== REGISTRATION_PROFILE_COLUMNS_.length) {
    throw registrationError_('PROFILE_INVALID');
  }
  for (var index = 0; index < REGISTRATION_PROFILE_COLUMNS_.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(columns, REGISTRATION_PROFILE_COLUMNS_[index])) {
      throw registrationError_('PROFILE_INVALID');
    }
  }
  var row;
  try {
    row = registrationBuildRow_(profile, {
      customerId: 'K9001', customerName: '架空 太郎',
      sourceFolderId: 'fixture-customer-folder', statementFolderId: 'fixture-statement-folder',
      fiscalYear: 2026, actor: 'fixture@example.invalid'
    });
    validateCustomerValues_(customerFromRow_(row, 0));
  } catch (error) {
    throw registrationError_('PROFILE_INVALID');
  }
  return profile;
}

/** TEST01 の行の 24 列からプロファイルを組み立てる（§3.13 の 3 でも使う）。 */
function registrationProfileFromRow_(values, templateId, sourceCustomerId) {
  var columns = {};
  REGISTRATION_PROFILE_COLUMNS_.forEach(function(key) {
    var index = REGISTRATION_COLUMN_INDEX_[key];
    var value = values[index];
    columns[key] = value === undefined || value === null ? '' : value;
  });
  return {
    version: 1,
    category: 'INDIVIDUAL',
    templateId: String(templateId),
    sourceCustomerId: String(sourceCustomerId === undefined || sourceCustomerId === null ? 'TEST01' : sourceCustomerId),
    capturedAt: nowIso_(),
    columns: columns
  };
}

/** §2.3 の 45 列を組む。C は常に false（有効化は書込の後）。 */
function registrationBuildRow_(profile, context) {
  var row = Array(CUSTOMER_MASTER_COLUMNS_).fill('');
  var columns = profile.columns;
  row[REGISTRATION_COLUMN_INDEX_.A] = String(context.customerId);
  row[REGISTRATION_COLUMN_INDEX_.B] = registrationTrim_(context.customerName);
  row[REGISTRATION_COLUMN_INDEX_.C] = false;
  row[REGISTRATION_COLUMN_INDEX_.D] = String(context.statementFolderId);
  row[REGISTRATION_COLUMN_INDEX_.E] = '';
  row[REGISTRATION_COLUMN_INDEX_.F] = String(profile.templateId);
  row[REGISTRATION_COLUMN_INDEX_.G] = '';
  ['H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'].forEach(function(key) {
    row[REGISTRATION_COLUMN_INDEX_[key]] = columns[key];
  });
  row[REGISTRATION_COLUMN_INDEX_.Q] = String(context.actor);
  row[REGISTRATION_COLUMN_INDEX_.R] = String(context.actor);
  row[REGISTRATION_COLUMN_INDEX_.S] = 0;
  row[REGISTRATION_COLUMN_INDEX_.T] = '';
  row[REGISTRATION_COLUMN_INDEX_.U] = columns.U;
  row[REGISTRATION_COLUMN_INDEX_.V] = '';
  row[REGISTRATION_COLUMN_INDEX_.W] = '';
  row[REGISTRATION_COLUMN_INDEX_.X] = 0;
  row[REGISTRATION_COLUMN_INDEX_.Y] = 0;
  row[REGISTRATION_COLUMN_INDEX_.Z] = '';
  row[REGISTRATION_COLUMN_INDEX_.AA] = '';
  row[REGISTRATION_COLUMN_INDEX_.AB] = '';
  row[REGISTRATION_COLUMN_INDEX_.AC] = '';
  ['AD', 'AE', 'AF', 'AG', 'AH', 'AI'].forEach(function(key) {
    row[REGISTRATION_COLUMN_INDEX_[key]] = columns[key];
  });
  row[REGISTRATION_COLUMN_INDEX_.AJ] = 'INDIVIDUAL';
  row[REGISTRATION_COLUMN_INDEX_.AK] = Number(context.fiscalYear);
  ['AL', 'AM', 'AN', 'AO', 'AP', 'AQ', 'AR', 'AS'].forEach(function(key) {
    row[REGISTRATION_COLUMN_INDEX_[key]] = columns[key];
  });
  return row;
}

/** 準備ができているか（§3.2）。足りないものは全部返す。 */
function registrationReadiness_() {
  var missing = [];
  var rootId = registrationTrim_(registrationProperty_(REGISTRATION_KEY_PROPERTIES_.ROOT_FOLDER));
  if (!rootId) {
    missing.push('CUSTOMER_ROOT_FOLDER_ID');
  } else {
    try {
      var root = DriveApp.getFolderById(rootId);
      if (registrationChildren_(root).filter(function(folder) {
        return registrationNameKey_(folder.getName()) === '個人';
      }).length !== 1) {
        missing.push('CATEGORY_FOLDER');
      }
    } catch (error) {
      missing.push('CATEGORY_FOLDER');
    }
  }
  var parallel = registrationTrim_(SETTINGS.PARALLEL_WORK_FOLDER_ID);
  var samples = registrationTrim_(SETTINGS.SAMPLE_CORPUS_FOLDER_ID);
  if (!parallel || (samples && parallel === samples)) {
    missing.push('PARALLEL_WORK_FOLDER_ID');
  }
  var profileRaw = registrationTrim_(registrationProperty_(REGISTRATION_KEY_PROPERTIES_.PROFILE));
  if (!profileRaw) {
    missing.push('CUSTOMER_TEMPLATE_PROFILE_INDIVIDUAL');
  } else {
    try {
      registrationProfile_();
    } catch (error) {
      missing.push('PROFILE_INVALID');
    }
  }
  if (!registrationTrim_(registrationProperty_(REGISTRATION_KEY_PROPERTIES_.CONTRACT))) {
    missing.push('CUSTOMER_ID_SOURCE_SPREADSHEET_ID');
  }
  return {ready: missing.length === 0, missing: missing};
}

/** Drive の反復子を配列へ。 */
function registrationChildren_(folder) {
  var folders = [];
  var iterator = folder.getFolders();
  while (iterator.hasNext()) folders.push(iterator.next());
  return folders;
}

function registrationCompareFolders_(left, right) {
  var leftName = String(left.getName());
  var rightName = String(right.getName());
  if (leftName !== rightName) return leftName < rightName ? -1 : 1;
  var leftId = String(left.getId());
  var rightId = String(right.getId());
  return leftId < rightId ? -1 : (leftId > rightId ? 1 : 0);
}

function registrationSortedFolders_(folders) {
  return (folders || []).slice().sort(registrationCompareFolders_);
}

/** 仕様が名前を挙げる 97 の部品と同じ考え方の小さな関数（97 は呼ばない）。 */
function registrationDiagChooseChildFolder_(parent, folderId, pattern) {
  var children = registrationSortedFolders_(registrationChildren_(parent));
  var choices = children.map(function(folder) {
    return {id: String(folder.getId()), name: String(folder.getName())};
  });
  var matched = children.filter(function(folder) {
    return pattern.test(registrationNameKey_(folder.getName()));
  });
  var chosen = null;
  if (folderId !== null && folderId !== undefined && String(folderId) !== '') {
    var wanted = String(folderId);
    chosen = children.filter(function(folder) { return String(folder.getId()) === wanted; })[0] || null;
  } else if (matched.length === 1) {
    chosen = matched[0];
  }
  return {chosen: chosen, children: children, matched: matched, choices: choices};
}

function registrationRootFolder_() {
  var rootId = registrationTrim_(registrationProperty_(REGISTRATION_KEY_PROPERTIES_.ROOT_FOLDER));
  if (!rootId) return null;
  return DriveApp.getFolderById(rootId);
}

function registrationCategoryFolder_() {
  var root = registrationRootFolder_();
  if (!root) return {folder: null, ambiguous: false};
  var matched = registrationChildren_(root).filter(function(folder) {
    return registrationNameKey_(folder.getName()) === '個人';
  });
  return {folder: matched.length === 1 ? matched[0] : null, ambiguous: matched.length > 1};
}

/** §3.4 顧客フォルダの一覧。中のファイルは読まない。 */
function registrationCustomerFolders_() {
  var category = registrationCategoryFolder_();
  if (!category.folder) return [];
  var keys = Object.create(null);
  registrationMasterRows_().forEach(function(row) {
    keys[registrationNameKey_(row.values[REGISTRATION_COLUMN_INDEX_.B])] = true;
  });
  return registrationSortedFolders_(registrationChildren_(category.folder)).map(function(folder) {
    var displayName = registrationDisplayName_(folder.getName());
    return {
      folderId: String(folder.getId()),
      folderName: String(folder.getName()),
      displayName: displayName,
      registered: Boolean(keys[registrationNameKey_(displayName)])
    };
  });
}

/** 個人の直下にある顧客フォルダだけを返す（無ければ null）。 */
function registrationFindCustomerFolder_(folderId) {
  var category = registrationCategoryFolder_();
  if (!category.folder) return null;
  var wanted = String(folderId);
  var matched = registrationChildren_(category.folder).filter(function(folder) {
    return String(folder.getId()) === wanted;
  });
  return matched.length === 1 ? matched[0] : null;
}

function registrationStageChoice_(parent, stage, picks) {
  var pattern = REGISTRATION_STAGE_PATTERNS_[stage];
  var result = registrationDiagChooseChildFolder_(parent,
    picks ? picks[stage] : null, pattern);
  return result;
}

/** §3.5 明細フォルダの探し方。1 段ずつ直下の子だけから選ぶ。 */
function registrationResolveStatementFolder_(customerFolder, picks) {
  var options = picks || {};
  var path = [];
  var pathIds = [];
  var current = customerFolder;

  // 資料共有の段：型に当たる子が 0 ならこの段は無いものとして次へ。
  var sharedPick = options.shared;
  var shared = registrationStageChoice_(current, 'shared', options);
  if (sharedPick !== null && sharedPick !== undefined && String(sharedPick) !== '') {
    if (!shared.chosen || shared.matched.indexOf(shared.chosen) < 0) {
      return {status: 'STOPPED', code: 'FOLDER_STRUCTURE', path: path};
    }
  }
  if (shared.chosen) {
    current = shared.chosen;
    path.push(String(current.getName()));
    pathIds.push(String(current.getId()));
  } else if (!sharedPick && shared.matched.length > 1) {
    return registrationNeedChoice_('shared', path, shared.matched);
  } else if (!sharedPick && shared.matched.length === 0 && !shared.children.length) {
    // 顧客フォルダに子が 1 つも無ければ、この先へ進めない。
    return {status: 'STOPPED', code: 'NO_CHILD_FOLDERS', path: path, childNames: []};
  }

  var year = registrationStageChoice_(current, 'year', options);
  if (year.chosen === null) {
    if (!year.children.length) {
      return {status: 'STOPPED', code: 'NO_CHILD_FOLDERS', path: path, childNames: []};
    }
    if (String(options.year || '') !== '') {
      return {status: 'STOPPED', code: 'FOLDER_STRUCTURE', path: path};
    }
    if (!year.matched.length) {
      return {status: 'STOPPED', code: 'YEAR_FOLDER_NOT_FOUND', path: path,
        childNames: year.children.map(function(folder) { return String(folder.getName()); })};
    }
    return registrationNeedChoice_('year', path, year.matched);
  }
  if (String(options.year || '') !== '' && year.matched.indexOf(year.chosen) < 0) {
    return {status: 'STOPPED', code: 'FOLDER_STRUCTURE', path: path};
  }
  var yearNameKey = registrationNameKey_(year.chosen.getName());
  var yearMatch = REGISTRATION_STAGE_PATTERNS_.year.exec(yearNameKey);
  if (!yearMatch) {
    return {status: 'STOPPED', code: 'FOLDER_STRUCTURE', path: path};
  }
  var reiwaYear = Number(yearMatch[1]);
  current = year.chosen;
  path.push(String(current.getName()));
  pathIds.push(String(current.getId()));

  var accounting = registrationStageChoice_(current, 'accounting', options);
  if (accounting.chosen === null) {
    if (!accounting.children.length) {
      return {status: 'STOPPED', code: 'NO_CHILD_FOLDERS', path: path, childNames: []};
    }
    if (String(options.accounting || '') !== '') {
      return {status: 'STOPPED', code: 'FOLDER_STRUCTURE', path: path};
    }
    return registrationNeedChoice_('accounting', path, accounting.children);
  }
  current = accounting.chosen;
  path.push(String(current.getName()));
  pathIds.push(String(current.getId()));

  var statement = registrationStageChoice_(current, 'statement', options);
  if (statement.chosen === null) {
    if (!statement.children.length) {
      return {status: 'STOPPED', code: 'NO_CHILD_FOLDERS', path: path, childNames: []};
    }
    if (String(options.statement || '') !== '') {
      return {status: 'STOPPED', code: 'FOLDER_STRUCTURE', path: path};
    }
    return registrationNeedChoice_('statement', path, statement.children);
  }
  current = statement.chosen;
  path.push(String(current.getName()));
  var statementId = String(current.getId());

  var cardFolders = registrationSortedFolders_(registrationChildren_(current))
    .slice(0, 50).map(function(folder) { return String(folder.getName()); });
  // 重なりの検査に使う「D より上」の ID。顧客フォルダ・個人・共通まで含める。
  pathIds.push(String(customerFolder.getId()));
  var category = registrationCategoryFolder_();
  if (category.folder) pathIds.push(String(category.folder.getId()));
  var root = registrationRootFolder_();
  if (root) pathIds.push(String(root.getId()));
  var result = {
    status: 'READY',
    path: path,
    pathIds: pathIds,
    statementFolderId: statementId,
    yearFolderId: String(year.chosen.getId()),
    reiwaYear: reiwaYear,
    fiscalYear: reiwaYear + 2018,
    cardFolders: cardFolders
  };
  if (!cardFolders.length) result.cardFolderWarning = 'NO_CARD_FOLDERS';
  return result;
}

function registrationNeedChoice_(stage, path, folders) {
  return {
    status: 'NEED_CHOICE',
    stage: stage,
    stageLabel: REGISTRATION_STAGE_LABELS_[stage],
    path: path,
    choices: registrationSortedFolders_(folders).map(function(folder) {
      return {id: String(folder.getId()), name: String(folder.getName())};
    })
  };
}

/** §3.7 の 4・5。下調べの `folderProblem`。 */
function registrationFolderProblem_(statementFolderId, pathIds, masterRows) {
  var id = String(statementFolderId);
  var duplicate = (masterRows || []).some(function(row) {
    return String(row.values[REGISTRATION_COLUMN_INDEX_.D]) === id;
  });
  if (duplicate) return 'FOLDER_ALREADY_REGISTERED';
  var overlap = (masterRows || []).some(function(row) {
    var value = String(row.values[REGISTRATION_COLUMN_INDEX_.D]);
    return value !== '' && (pathIds || []).map(String).indexOf(value) >= 0;
  });
  if (overlap) return 'FOLDER_OVERLAPS';
  var samples = registrationTrim_(SETTINGS.SAMPLE_CORPUS_FOLDER_ID);
  var parallel = registrationTrim_(SETTINGS.PARALLEL_WORK_FOLDER_ID);
  if ((samples && id === samples) || (parallel && id === parallel)) {
    return 'FOLDER_STRUCTURE';
  }
  return null;
}

function registrationCell_(row, index) {
  var value = row ? row[index] : '';
  return value === null || value === undefined ? '' : value;
}

/** §3.6 別表から顧客 ID を引く。名簿は返すが、Logger・監査・例外には出さない。 */
function registrationContractEntries_(reiwaYear, customerNameKey) {
  var spreadsheetId = registrationTrim_(registrationProperty_(REGISTRATION_KEY_PROPERTIES_.CONTRACT));
  if (!spreadsheetId) {
    return {status: 'CONTRACT_UNREADABLE', tabName: null, entries: []};
  }
  var wantedKey = registrationNameKey_('R' + Number(reiwaYear) + '.契約内容');
  var metadata;
  try {
    metadata = Sheets.Spreadsheets.get(spreadsheetId, {fields: 'sheets.properties(title)'});
  } catch (error) {
    return {status: 'CONTRACT_UNREADABLE', tabName: null, entries: []};
  }
  var tabNames = (metadata && metadata.sheets || []).map(function(sheet) {
    return String(sheet && sheet.properties && sheet.properties.title || '');
  }).filter(function(name) {
    return name !== '' && registrationNameKey_(name) === wantedKey;
  });
  if (tabNames.length !== 1) {
    return {status: 'CONTRACT_TAB_NOT_FOUND', tabName: null, entries: []};
  }
  var tabName = tabNames[0];
  var response;
  try {
    response = registrationValuesGet_(spreadsheetId,
      quoteSheetName_(tabName) + '!B:C',
      {valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS'});
  } catch (error) {
    return {status: 'CONTRACT_UNREADABLE', tabName: tabName, entries: []};
  }
  var rows = response && response.values ? response.values : [];
  var headerIndex = -1;
  for (var index = 0; index < Math.min(30, rows.length); index += 1) {
    if (registrationNameKey_(registrationCell_(rows[index], 0)) === '取引先コード') {
      headerIndex = index;
      break;
    }
  }
  if (headerIndex < 0) {
    return {status: 'CONTRACT_HEADER_NOT_FOUND', tabName: tabName, entries: []};
  }
  var raw = [];
  for (var rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    var rawId = registrationCell_(rows[rowIndex], 0);
    if (registrationTrim_(rawId) === '') continue;
    raw.push({
      customerId: registrationTrim_(registrationNfkc_(rawId)),
      name: registrationTrim_(registrationCell_(rows[rowIndex], 1))
    });
  }
  var counts = Object.create(null);
  raw.forEach(function(entry) {
    var key = entry.customerId.toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
  });
  var masterIds = Object.create(null);
  registrationMasterRows_().forEach(function(row) {
    var value = registrationTrim_(registrationNfkc_(row.values[REGISTRATION_COLUMN_INDEX_.A]));
    if (value) masterIds[value.toLowerCase()] = true;
  });
  var entries = raw.map(function(entry) {
    var problem = null;
    if (!/^[0-9A-Za-z][0-9A-Za-z_-]{0,31}$/.test(entry.customerId)) {
      problem = 'ID_FORMAT';
    } else if (counts[entry.customerId.toLowerCase()] > 1) {
      problem = 'ID_REPEATED_IN_CONTRACT';
    } else if (masterIds[entry.customerId.toLowerCase()]) {
      problem = 'ID_DUPLICATE';
    }
    return {customerId: entry.customerId, name: entry.name,
      usable: problem === null, problem: problem};
  });
  var matched = entries.filter(function(entry) {
    return entry.usable && customerNameKey !== null && customerNameKey !== undefined &&
      registrationNameKey_(entry.name) === String(customerNameKey);
  });
  var status = matched.length === 0 ? 'NONE' : (matched.length === 1 ? 'MATCHED' : 'MULTIPLE');
  return {
    status: status,
    tabName: tabName,
    matchedCustomerId: status === 'MATCHED' ? matched[0].customerId : null,
    entries: entries
  };
}

/**
 * D から親をたどり、§3.7 の 2 つの道のどちらかにちょうど当たるかを見る。
 * 道の ID は D より上だけを返す。
 */
function registrationTraverseStatementFolder_(statementFolderId) {
  var rootId = registrationTrim_(registrationProperty_(REGISTRATION_KEY_PROPERTIES_.ROOT_FOLDER));
  if (!rootId) return {ok: false, code: 'NOT_READY'};
  var folder;
  try {
    folder = DriveApp.getFolderById(String(statementFolderId));
  } catch (error) {
    return {ok: false, code: 'FOLDER_STRUCTURE'};
  }
  var chain = [];
  var current = folder;
  var guard = 0;
  var reachedRoot = false;
  while (guard < 12) {
    guard += 1;
    var parents = [];
    try {
      var iterator = current.getParents();
      while (iterator.hasNext()) parents.push(iterator.next());
    } catch (error) {
      return {ok: false, code: 'FOLDER_STRUCTURE'};
    }
    if (parents.length !== 1) return {ok: false, code: 'FOLDER_STRUCTURE'};
    var parent = parents[0];
    chain.push(parent);
    if (String(parent.getId()) === rootId) { reachedRoot = true; break; }
    current = parent;
  }
  if (!reachedRoot) return {ok: false, code: 'FOLDER_STRUCTURE'};

  var customer = null;
  var individual = null;
  var year = null;
  var shared = null;
  if (chain.length === 6) {
    year = chain[1];
    shared = chain[2];
    customer = chain[3];
    individual = chain[4];
  } else if (chain.length === 5) {
    year = chain[1];
    customer = chain[2];
    individual = chain[3];
  } else {
    return {ok: false, code: 'FOLDER_STRUCTURE'};
  }
  if (registrationNameKey_(individual.getName()) !== '個人') {
    return {ok: false, code: 'FOLDER_STRUCTURE'};
  }
  if (shared && !REGISTRATION_STAGE_PATTERNS_.shared.test(registrationNameKey_(shared.getName()))) {
    return {ok: false, code: 'FOLDER_STRUCTURE'};
  }
  var yearMatch = REGISTRATION_STAGE_PATTERNS_.year.exec(registrationNameKey_(year.getName()));
  if (!yearMatch) return {ok: false, code: 'FOLDER_STRUCTURE'};
  // **1 段深い「カードのフォルダ」を D にされたら止める。** そのとき
  // 「経費の段」の位置には明細フォルダ（クレジット…）が入る。名前で
  // 経費の段を縛らない仕様なので、ここだけは深さの取り違えを名前で見る。
  if (REGISTRATION_STAGE_PATTERNS_.statement.test(registrationNameKey_(chain[0].getName()))) {
    return {ok: false, code: 'FOLDER_STRUCTURE'};
  }
  return {
    ok: true,
    customerFolderId: String(customer.getId()),
    customerFolderName: String(customer.getName()),
    fiscalYear: Number(yearMatch[1]) + 2018,
    reiwaYear: Number(yearMatch[1]),
    pathIds: chain.map(function(item) { return String(item.getId()); })
  };
}

/** §3.7 登録の要求をサーバーで確かめ直す。 */
function registrationVerifyRequest_(request, actorEmail) {
  if (!request || typeof request !== 'object') throw new TypeError('request must be an object');
  ['category', 'customerFolderId', 'statementFolderId', 'customerId', 'customerName'].forEach(function(key) {
    if (typeof request[key] !== 'string') throw new TypeError(key + ' must be a string');
  });
  if (request.category !== 'INDIVIDUAL') {
    return {ok: false, code: 'CATEGORY_NOT_AVAILABLE'};
  }
  var readiness = registrationReadiness_();
  if (!readiness.ready) {
    // プロファイルだけが壊れているときは、より具体的なコードを返す（reg 17）。
    if (readiness.missing.length === 1 && readiness.missing[0] === 'PROFILE_INVALID') {
      return {ok: false, code: 'PROFILE_INVALID'};
    }
    return {ok: false, code: 'NOT_READY', missing: readiness.missing};
  }

  var customerFolder = registrationFindCustomerFolder_(request.customerFolderId);
  if (!customerFolder) return {ok: false, code: 'FOLDER_STRUCTURE'};

  var traverse = registrationTraverseStatementFolder_(request.statementFolderId);
  if (!traverse.ok) return {ok: false, code: traverse.code};
  if (traverse.customerFolderId !== String(request.customerFolderId)) {
    return {ok: false, code: 'FOLDER_STRUCTURE'};
  }
  var masterRows = registrationMasterRows_();
  var contract = registrationContractEntries_(traverse.reiwaYear,
    registrationNameKey_(customerFolder.getName()));
  if (contract.status === 'CONTRACT_UNREADABLE' || contract.status === 'CONTRACT_TAB_NOT_FOUND' ||
      contract.status === 'CONTRACT_HEADER_NOT_FOUND') {
    return {ok: false, code: contract.status};
  }
  var wantedId = registrationTrim_(registrationNfkc_(request.customerId));
  var entry = null;
  var caseInsensitiveDuplicate = null;
  (contract.entries || []).forEach(function(candidate) {
    if (candidate.customerId === wantedId) entry = candidate;
    if (!caseInsensitiveDuplicate &&
        candidate.customerId.toLowerCase() === wantedId.toLowerCase() &&
        candidate.problem === 'ID_DUPLICATE') {
      caseInsensitiveDuplicate = candidate;
    }
  });
  if (!entry) entry = caseInsensitiveDuplicate;
  if (!entry) return {ok: false, code: 'ID_NOT_IN_CONTRACT'};

  // A が既にある要求は、ロックの中の §3.9（2 回目か ID_DUPLICATE か）に
  // 決めさせる。ここで D の重複として止めると、通信の切れた再送が
  // 失敗として返ってしまう。
  var idAlreadyInMaster = registrationHasId_(masterRows, entry.customerId);
  if (!entry.usable && !(entry.problem === 'ID_DUPLICATE' && idAlreadyInMaster)) {
    return {ok: false, code: entry.problem};
  }
  if (!idAlreadyInMaster) {
    var folderProblem = registrationFolderProblem_(request.statementFolderId,
      traverse.pathIds, masterRows);
    if (folderProblem) return {ok: false, code: folderProblem};
  }

  var nameProblem = idAlreadyInMaster ? null :
    registrationNameProblem_(request.customerName, masterRows);
  if (nameProblem) return {ok: false, code: nameProblem};

  var profile;
  try {
    profile = registrationProfile_();
  } catch (error) {
    return {ok: false, code: 'PROFILE_INVALID'};
  }
  if (!profile) return {ok: false, code: 'NOT_READY'};
  var customerName = registrationTrim_(request.customerName);
  var row = registrationBuildRow_(profile, {
    customerId: entry.customerId,
    customerName: customerName,
    statementFolderId: String(request.statementFolderId),
    fiscalYear: traverse.fiscalYear,
    actor: actorEmail === null || actorEmail === undefined ? '' : String(actorEmail)
  });
  try {
    validateCustomerValues_(customerFromRow_(row, 0));
  } catch (error) {
    return {ok: false, code: 'PROFILE_INVALID'};
  }
  return {
    ok: true,
    row: row,
    customerId: entry.customerId,
    customerName: customerName,
    statementFolderId: String(request.statementFolderId),
    fiscalYear: traverse.fiscalYear,
    reiwaYear: traverse.reiwaYear,
    pathIds: traverse.pathIds,
    templateId: String(profile.templateId)
  };
}

function registrationSameCell_(expected, actual) {
  var left = expected === undefined || expected === null ? '' : expected;
  var right = actual === undefined || actual === null ? '' : actual;
  if (left === '' && right === '') return true;
  if (typeof left !== typeof right) return false;
  if (left instanceof Date || right instanceof Date) {
    return String(left) === String(right);
  }
  return left === right;
}

function registrationRowsMatch_(expected, actual) {
  for (var index = 0; index < CUSTOMER_MASTER_COLUMNS_; index += 1) {
    if (!registrationSameCell_(expected[index], actual[index])) return false;
  }
  return true;
}

/** §3.9 同じ要求の 2 回目か。 */
function registrationAlreadyRegistered_(rows, customerId, expected) {
  var matches = (rows || []).filter(function(row) {
    var value = registrationTrim_(registrationNfkc_(row.values[REGISTRATION_COLUMN_INDEX_.A]));
    return value.toLowerCase() === String(customerId).toLowerCase();
  });
  if (matches.length !== 1) return {matched: false, duplicate: matches.length > 1};
  var row = matches[0];
  var same = row.values[REGISTRATION_COLUMN_INDEX_.C] === true &&
    String(row.values[REGISTRATION_COLUMN_INDEX_.B]) === expected.customerName &&
    String(row.values[REGISTRATION_COLUMN_INDEX_.D]) === expected.statementFolderId &&
    String(row.values[REGISTRATION_COLUMN_INDEX_.F]) === expected.templateId &&
    String(row.values[REGISTRATION_COLUMN_INDEX_.AJ]) === 'INDIVIDUAL' &&
    Number(row.values[REGISTRATION_COLUMN_INDEX_.AK]) === Number(expected.fiscalYear);
  return {matched: same, duplicate: false, rowNumber: row.rowNumber, row: row.values};
}

function registrationHasId_(rows, customerId) {
  return (rows || []).some(function(row) {
    return registrationTrim_(registrationNfkc_(row.values[REGISTRATION_COLUMN_INDEX_.A]))
      .toLowerCase() === String(customerId).toLowerCase();
  });
}

/**
 * §3.8 書く手順。Drive と別表の読みはロックの外で済ませる。
 * 監査 → 行（C は false）→ 読み返し → C を true、の順を守る。
 */
function registerCustomer_(request) {
  var auth = authorizeOwner(REGISTRATION_OPERATION_.REGISTER);
  loadSettingsFromProperties();
  var verified = registrationVerifyRequest_(request, auth.normalizedEmail);
  if (!verified.ok) return verified;

  return withScriptLock_(function() {
    var fresh = registrationMasterRowsFresh_();
    var rows = fresh.rows;
    // ロックの中で今の行を確かめ直す（§3.8 の 1・S4）。
    if (registrationHasId_(rows, verified.customerId)) {
      var repeat = registrationAlreadyRegistered_(rows, verified.customerId, {
        customerName: verified.customerName,
        statementFolderId: verified.statementFolderId,
        templateId: verified.templateId,
        fiscalYear: verified.fiscalYear
      });
      if (repeat.matched) {
        return {ok: true, customerId: verified.customerId, customerName: verified.customerName,
          rowNumber: repeat.rowNumber, alreadyRegistered: true};
      }
      return {ok: false, code: 'ID_DUPLICATE'};
    }
    var folderProblem = registrationFolderProblem_(verified.statementFolderId,
      verified.pathIds, rows);
    if (folderProblem) return {ok: false, code: folderProblem};
    var nameProblem = registrationNameProblem_(verified.customerName, rows);
    if (nameProblem) return {ok: false, code: nameProblem};

    var master = requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.CUSTOMER_MASTER);
    var rowNumber = fresh.rowCount + 1;
    ensureSheetWidth_(master, CUSTOMER_MASTER_COLUMNS_);
    ensureRowExists_(master, rowNumber);

    // **監査を先に書く。** 書けなければマスターには 1 セルも書かない（S5）。
    try {
      appendAuditRowsUnlocked_([{
        type: 'CUSTOMER_REGISTER',
        actor: auth.userEmail,
        targetType: 'CUSTOMER',
        targetId: verified.customerId,
        customerId: verified.customerId,
        before: '',
        after: {row: rowNumber, A: verified.customerId, B: verified.customerName,
          D: verified.statementFolderId, F: verified.templateId,
          AJ: 'INDIVIDUAL', AK: verified.fiscalYear},
        reason: 'WEBAPP'
      }]);
      SpreadsheetApp.flush();
    } catch (auditError) {
      throw makeCatalogError_('REQUIRED_LOG_WRITE_FAILED',
        auditError && auditError.message ? auditError.message : String(auditError));
    }

    var spreadsheetId = master.getParent().getId();
    var sheetName = master.getName();
    var rowRange = quoteSheetName_(sheetName) + '!A' + rowNumber + ':AS' + rowNumber;
    try {
      // **RAW で書く。** USER_ENTERED は '0012' を数値 12 にしてしまう（R6）。
      Sheets.Spreadsheets.Values.update({values: [verified.row]}, spreadsheetId,
        rowRange, {valueInputOption: 'RAW'});

      var readBack = sheetsReadWithRetry_(function() {
        return sheetsBatchGetPaced_(spreadsheetId, {
          ranges: [quoteSheetName_(sheetName) + '!A:A', rowRange],
          valueRenderOption: 'UNFORMATTED_VALUE',
          dateTimeRenderOption: 'SERIAL_NUMBER',
          majorDimension: 'ROWS'
        });
      });
      var idColumn = (readBack && readBack.valueRanges && readBack.valueRanges[0] &&
        readBack.valueRanges[0].values) || [];
      var hits = [];
      idColumn.forEach(function(values, index) {
        var value = registrationTrim_(registrationNfkc_(values && values[0]));
        if (value.toLowerCase() === String(verified.customerId).toLowerCase()) {
          hits.push(index + 1);
        }
      });
      var readRow = padRowValues_(
        (readBack && readBack.valueRanges && readBack.valueRanges[1] &&
          readBack.valueRanges[1].values && readBack.valueRanges[1].values[0]) || [],
        CUSTOMER_MASTER_COLUMNS_);
      if (hits.length !== 1 || hits[0] !== rowNumber ||
          !registrationRowsMatch_(verified.row, readRow)) {
        throw registrationError_('WRITE_VERIFY_FAILED');
      }
      validateCustomerValues_(customerFromRow_(readRow, rowNumber));

      // C だけを true にする。読み返して true でなければ失敗（S3）。
      var cRange = quoteSheetName_(sheetName) + '!C' + rowNumber;
      Sheets.Spreadsheets.Values.update({values: [[true]]}, spreadsheetId,
        cRange, {valueInputOption: 'RAW'});
      var cRead = registrationValuesGet_(spreadsheetId, cRange,
        {valueRenderOption: 'UNFORMATTED_VALUE'});
      var cValue = cRead && cRead.values && cRead.values[0] ? cRead.values[0][0] : '';
      if (cValue !== true) throw registrationError_('WRITE_VERIFY_FAILED');
      return {ok: true, customerId: verified.customerId, customerName: verified.customerName,
        rowNumber: rowNumber, alreadyRegistered: false};
    } catch (writeError) {
      var code = writeError && writeError.code === 'REQUIRED_LOG_WRITE_FAILED' ?
        'REQUIRED_LOG_WRITE_FAILED' : 'WRITE_VERIFY_FAILED';
      try {
        appendAuditRowsUnlocked_([{
          type: 'CUSTOMER_REGISTER',
          actor: auth.userEmail,
          targetType: 'CUSTOMER',
          targetId: verified.customerId,
          customerId: verified.customerId,
          before: '',
          after: {row: rowNumber, failed: code},
          reason: 'WEBAPP_FAILED'
        }]);
      } catch (ignored) {
        // 失敗の監査が書けなくても、元の失敗を返す。
      }
      return {ok: false, code: 'WRITE_VERIFY_FAILED', rowNumber: rowNumber};
    }
  });
}

/** §3.12 雛形へ直接書く取込を止める。両方のプロファイルが空なら今のまま。 */
function registrationTemplateGuard_(templateId) {
  var raws = [
    registrationTrim_(registrationProperty_(REGISTRATION_KEY_PROPERTIES_.PROFILE)),
    registrationTrim_(registrationProperty_(REGISTRATION_KEY_PROPERTIES_.PROFILE_CORPORATE))
  ];
  var nonEmpty = raws.filter(function(raw) { return raw !== ''; });
  if (!nonEmpty.length) return null;
  var wanted = String(templateId === null || templateId === undefined ? '' : templateId);
  for (var index = 0; index < nonEmpty.length; index += 1) {
    var profile;
    try {
      profile = JSON.parse(nonEmpty[index]);
    } catch (error) {
      return 'TEMPLATE_PROFILE_UNREADABLE';
    }
    if (!profile || typeof profile.templateId !== 'string' || !profile.templateId) {
      return 'TEMPLATE_PROFILE_UNREADABLE';
    }
    if (profile.templateId === wanted) return 'TEMPLATE_DIRECT_WRITE';
  }
  return null;
}

// ---------------------------------------------------------------------------
// §3.13 準備用の関数
// ---------------------------------------------------------------------------

function registrationReportBytes_(text) {
  try {
    return utf8Len(text);
  } catch (error) {
    return String(text).length;
  }
}

function registrationAncestorNames_(folder, limit) {
  var names = [];
  var current = folder;
  for (var depth = 0; depth < limit; depth += 1) {
    var parents = [];
    try {
      var iterator = current.getParents();
      while (iterator.hasNext()) parents.push(iterator.next());
    } catch (error) {
      return names;
    }
    if (parents.length !== 1) return names;
    current = parents[0];
    names.push(String(current.getName()));
  }
  return names;
}

/**
 * 作業用フォルダの親が顧客フォルダの中かを調べる。
 * **分からないときは止める側**にする（F3）。返す値は `'inside'`・
 * `'outside'`・`'unknown'`。親が 0（いちばん上に着いた）なら外、
 * 親が 2 つ以上・`getParents` の例外・10 段で上に着かないなら分からない。
 */
function registrationInsideCustomerRoot_(folder) {
  var rootId = registrationTrim_(registrationProperty_(REGISTRATION_KEY_PROPERTIES_.ROOT_FOLDER));
  if (!rootId) return 'unknown';
  var current = folder;
  for (var depth = 0; depth < 10; depth += 1) {
    var parents = [];
    try {
      var iterator = current.getParents();
      while (iterator.hasNext()) parents.push(iterator.next());
    } catch (error) {
      return 'unknown';
    }
    if (parents.length === 0) return 'outside';
    if (parents.length !== 1) return 'unknown';
    current = parents[0];
    if (String(current.getId()) === rootId) return depth >= 1 ? 'inside' : 'outside';
  }
  return 'unknown';
}

function registrationFileParent_(file) {
  var parents = [];
  try {
    var iterator = file.getParents();
    while (iterator.hasNext()) parents.push(iterator.next());
  } catch (error) {
    return null;
  }
  return parents.length === 1 ? parents[0] : null;
}

function registrationParseExcludedColumns_(raw) {
  if (raw === '' || raw === null || raw === undefined) return [];
  try {
    var parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch (error) {
    return [];
  }
}

function registrationAccountListColumns_(raw) {
  if (!raw) return [];
  var match = /^([A-Z]{1,3})[0-9]+:([A-Z]{1,3})[0-9]+$/.exec(String(raw));
  if (!match) return [];
  var first = columnNumber_(match[1]);
  var last = columnNumber_(match[2]);
  var columns = [];
  for (var value = first; value <= last; value += 1) columns.push(value);
  return columns;
}

/** 入力用シートの列ごとの「空でないセルの数」と札（値は出さない）。 */
function registrationInputSheetReport_(sheet, sourceRow) {
  var headerRowBefore = Number(sourceRow[REGISTRATION_COLUMN_INDEX_.AD]);
  var lastRow = Number(sheet.getLastRow());
  var lastColumn = Number(sheet.getLastColumn());
  var firstDataRow = headerRowBefore + 1;
  var rows = Math.max(0, lastRow - firstDataRow + 1);
  var counts = [];
  if (rows > 0 && lastColumn > 0) {
    var values = sheet.getRange(firstDataRow, 1, rows, lastColumn).getValues();
    for (var column = 0; column < lastColumn; column += 1) {
      var nonEmpty = 0;
      for (var row = 0; row < values.length; row += 1) {
        var value = values[row][column];
        if (value !== '' && value !== null && value !== undefined) nonEmpty += 1;
      }
      counts.push(nonEmpty);
    }
  }
  var excluded = registrationParseExcludedColumns_(sourceRow[REGISTRATION_COLUMN_INDEX_.AL]);
  var accountList = registrationAccountListColumns_(sourceRow[REGISTRATION_COLUMN_INDEX_.AS]);
  var system = [];
  // J〜O 列が転記先の B・F・I・K・M・取引ID の列番号（design §2.1.1）。
  [9, 10, 11, 12, 13, 14].forEach(function(index) {
    system.push(Number(sourceRow[index]));
  });
  if (sourceRow[REGISTRATION_COLUMN_INDEX_.AQ] !== '' && sourceRow[REGISTRATION_COLUMN_INDEX_.AQ] !== null) {
    system.push(Number(sourceRow[REGISTRATION_COLUMN_INDEX_.AQ]));
  }
  if (sourceRow[REGISTRATION_COLUMN_INDEX_.AR] !== '' && sourceRow[REGISTRATION_COLUMN_INDEX_.AR] !== null) {
    system.push(Number(sourceRow[REGISTRATION_COLUMN_INDEX_.AR]));
  }
  if (sourceRow[REGISTRATION_COLUMN_INDEX_.AP] !== '' && sourceRow[REGISTRATION_COLUMN_INDEX_.AP] !== null &&
      excluded.indexOf(Number(sourceRow[REGISTRATION_COLUMN_INDEX_.AP])) < 0) {
    system.push(Number(sourceRow[REGISTRATION_COLUMN_INDEX_.AP]));
  }
  var columns = [];
  for (var index = 0; index < lastColumn; index += 1) {
    var number = index + 1;
    var tag = 'other';
    if (excluded.indexOf(number) >= 0) tag = 'excluded';
    else if (system.indexOf(number) >= 0) tag = 'system';
    else if (accountList.indexOf(number) >= 0) tag = 'accountList';
    columns.push({column: number, letter: columnLetter_(number), tag: tag,
      nonEmpty: counts[index] || 0});
  }
  return {name: String(sheet.getName()), headerRowBefore: headerRowBefore,
    lastRow: lastRow, dataRows: rows, columns: columns};
}

function registrationOtherTabsReport_(spreadsheet, inputSheetName) {
  var tabs = [];
  spreadsheet.getSheets().forEach(function(sheet) {
    if (String(sheet.getName()) === String(inputSheetName)) return;
    tabs.push({name: String(sheet.getName()), lastRow: Number(sheet.getLastRow()),
      lastColumn: Number(sheet.getLastColumn())});
  });
  return tabs;
}

function registrationContractStats_(spreadsheetId) {
  var stats = [];
  var metadata;
  try {
    metadata = Sheets.Spreadsheets.get(spreadsheetId, {fields: 'sheets.properties(title)'});
  } catch (error) {
    return null;
  }
  var tabNames = (metadata && metadata.sheets || []).map(function(sheet) {
    return String(sheet && sheet.properties && sheet.properties.title || '');
  }).filter(function(name) {
    return /^R\d+\.契約内容$/.test(registrationNameKey_(name));
  });
  tabNames.forEach(function(tabName) {
    var response;
    try {
      response = registrationValuesGet_(spreadsheetId,
        quoteSheetName_(tabName) + '!B:C',
        {valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS'});
    } catch (error) {
      return;
    }
    var rows = response && response.values ? response.values : [];
    var headerIndex = -1;
    for (var index = 0; index < Math.min(30, rows.length); index += 1) {
      if (registrationNameKey_(registrationCell_(rows[index], 0)) === '取引先コード') {
        headerIndex = index;
        break;
      }
    }
    var dataRows = 0, idFormat = 0, emptyNames = 0;
    var counts = Object.create(null);
    for (var rowIndex = headerIndex + 1; headerIndex >= 0 && rowIndex < rows.length; rowIndex += 1) {
      var rawId = registrationCell_(rows[rowIndex], 0);
      if (registrationTrim_(rawId) === '') continue;
      dataRows += 1;
      var customerId = registrationTrim_(registrationNfkc_(rawId));
      if (!/^[0-9A-Za-z][0-9A-Za-z_-]{0,31}$/.test(customerId)) idFormat += 1;
      counts[customerId.toLowerCase()] = (counts[customerId.toLowerCase()] || 0) + 1;
      if (registrationTrim_(registrationCell_(rows[rowIndex], 1)) === '') emptyNames += 1;
    }
    var repeated = Object.keys(counts).filter(function(key) { return counts[key] > 1; }).length;
    stats.push({tabName: tabName, headerRow: headerIndex >= 0 ? headerIndex + 1 : null,
      dataRows: dataRows, idFormat: idFormat, repeatedIds: repeated, emptyNames: emptyNames});
  });
  return stats;
}

/**
 * §3.13 準備用の関数。既定は見るだけ。`apply === true` のときだけ書く。
 * 認可は呼ばない（実行 API は MYSELF。他の運用関数と同じ）。
 */
function opsPrepareCustomerRegistration(options, apply) {
  loadSettingsFromProperties();
  var opts = options || {};
  var actor = activeUserEmail_();
  var sourceCustomerId = opts.sourceCustomerId === undefined || opts.sourceCustomerId === null ||
    String(opts.sourceCustomerId) === '' ? 'TEST01' : String(opts.sourceCustomerId);
  var report = {
    applied: false,
    stoppedBy: null,
    workFolder: null,
    template: null,
    profile: null,
    contract: null,
    rootFolder: null,
    productionMaster: null,
    plan: {}
  };

  var master = masterSpreadsheet_();
  var masterId = String(master.getId());
  var rows = registrationMasterRows_();
  var sourceRows = rows.filter(function(row) {
    return String(row.values[REGISTRATION_COLUMN_INDEX_.A]) === sourceCustomerId;
  });
  var sourceRow = sourceRows.length === 1 ? sourceRows[0].values : null;

  // 1. 作業用フォルダ
  var parent = null;
  try { parent = DriveApp.getFolderById(String(opts.workParentFolderId)); } catch (error) { parent = null; }
  var workChildren = parent ? registrationSortedFolders_(registrationChildren_(parent)) : [];
  var workFolders = workChildren.filter(function(folder) {
    return registrationNameKey_(folder.getName()) === '作業用';
  });
  var currentWork = registrationTrim_(SETTINGS.PARALLEL_WORK_FOLDER_ID);
  var workLocation = parent ? registrationInsideCustomerRoot_(parent) : 'unknown';
  var insideCustomer = workLocation === 'inside';
  var locationUnknown = workLocation === 'unknown';
  var currentMatchesWork = currentWork !== '' && workFolders.length === 1 &&
    String(workFolders[0].getId()) === currentWork;
  var workAction;
  if (!parent || insideCustomer || locationUnknown) workAction = 'CONFLICT';
  else if (currentWork) workAction = currentMatchesWork ? 'ALREADY_SET' : 'CONFLICT';
  else if (workFolders.length === 1) workAction = 'REUSE';
  else if (workFolders.length === 0) workAction = 'CREATE';
  else workAction = 'CONFLICT';
  var plannedWorkId = workAction === 'REUSE' ? String(workFolders[0].getId()) :
    (workAction === 'ALREADY_SET' ? currentWork : null);
  var samples = registrationTrim_(SETTINGS.SAMPLE_CORPUS_FOLDER_ID);
  if (plannedWorkId && samples && plannedWorkId === samples) workAction = 'CONFLICT';
  report.workFolder = {
    parentName: parent ? String(parent.getName()) : null,
    ancestors: parent ? registrationAncestorNames_(parent, 10) : [],
    parentInsideCustomerRoot: insideCustomer,
    parentLocationUnknown: locationUnknown,
    workFolderCount: workFolders.length,
    currentWorkFolder: {empty: currentWork === '', matchesWorkFolder: currentMatchesWork,
      pointsElsewhere: currentWork !== '' && !currentMatchesWork},
    equalsSampleCorpus: Boolean(plannedWorkId && samples && plannedWorkId === samples)
  };
  report.plan.workFolder = workAction;

  // 2. 雛形
  var templateFolder = null;
  try { templateFolder = DriveApp.getFolderById(String(opts.templateFolderId)); } catch (error) { templateFolder = null; }
  var templateFolderFiles = templateFolder ? registrationFolderFiles_(templateFolder) : [];
  var templateCopyCount = templateFolderFiles.filter(function(file) {
    return registrationNameKey_(file.getName()) === registrationNameKey_('雛形（個人）');
  }).length;
  var sourceTemplateId = sourceRow ? String(sourceRow[REGISTRATION_COLUMN_INDEX_.F]) : '';
  var templateFile = null;
  try { templateFile = sourceTemplateId ? DriveApp.getFileById(sourceTemplateId) : null; } catch (error) { templateFile = null; }
  var templateParent = templateFile ? registrationFileParent_(templateFile) : null;
  var inputSheet = null;
  var otherTabs = [];
  if (sourceTemplateId) {
    try {
      var templateSpreadsheet = SpreadsheetApp.openById(sourceTemplateId);
      var sheetName = sourceRow ? String(sourceRow[REGISTRATION_COLUMN_INDEX_.H]) : '';
      inputSheet = templateSpreadsheet.getSheetByName(sheetName);
      if (inputSheet) {
        inputSheet = registrationInputSheetReport_(inputSheet, sourceRow);
      }
      otherTabs = registrationOtherTabsReport_(templateSpreadsheet, sheetName);
    } catch (error) {
      inputSheet = null;
      otherTabs = [];
    }
  }
  var currentProfileRaw = registrationTrim_(registrationProperty_(REGISTRATION_KEY_PROPERTIES_.PROFILE));
  var currentProfile = null;
  var currentProfileValid = false;
  if (currentProfileRaw) {
    try {
      currentProfile = registrationProfile_();
      currentProfileValid = Boolean(currentProfile);
    } catch (error) {
      currentProfileValid = false;
    }
  }
  var profileFilePresent = false;
  if (currentProfileValid && currentProfile && templateFolder) {
    profileFilePresent = templateFolderFiles.some(function(file) {
      return String(file.getId()) === String(currentProfile.templateId);
    });
  }
  var templateAction;
  if (!templateFolder || !sourceTemplateId || !templateFile) templateAction = 'CONFLICT';
  else if (currentProfileRaw) templateAction = currentProfileValid && profileFilePresent ?
    'ALREADY_SET' : 'CONFLICT';
  else templateAction = templateCopyCount ? 'CONFLICT' : 'CREATE';
  report.template = {
    templateName: templateFile ? String(templateFile.getName()) : null,
    templateParentName: templateParent ? String(templateParent.getName()) : null,
    parentIsTemplateFolder: Boolean(templateParent && templateFolder &&
      String(templateParent.getId()) === String(templateFolder.getId())),
    templateFolderFileCount: templateFolderFiles.length,
    templateCopyCount: templateCopyCount,
    profile: {empty: currentProfileRaw === '', templateFilePresent: profileFilePresent},
    inputSheet: inputSheet,
    otherTabs: otherTabs
  };
  report.plan.template = templateAction;

  // 3. プロファイル（見るだけの報告では組み立てた結果を検査する）
  var builtProfile = sourceRow ? registrationProfileFromRow_(sourceRow, sourceTemplateId, sourceCustomerId) : null;
  var builtBytes = builtProfile ? registrationReportBytes_(JSON.stringify(builtProfile)) : 0;
  var builtValid = false;
  if (builtProfile) {
    try { registrationValidateProfile_(builtProfile); builtValid = true; } catch (error) { builtValid = false; }
  }
  report.profile = {bytes: builtBytes, ok: builtValid, code: builtValid ? null : 'PROFILE_INVALID'};
  if (!currentProfileRaw) {
    report.plan.profile = builtValid && templateAction !== 'CONFLICT' && builtBytes <= 8000 ?
      'CREATE' : 'CONFLICT';
  } else {
    report.plan.profile = currentProfileValid && profileFilePresent ? 'ALREADY_SET' : 'CONFLICT';
  }

  // 4. 別表
  var contractId = registrationTrim_(registrationProperty_(REGISTRATION_KEY_PROPERTIES_.CONTRACT));
  var contractStats = opts.contractSpreadsheetId ?
    registrationContractStats_(String(opts.contractSpreadsheetId)) : null;
  report.contract = contractStats;
  var contractAction;
  if (!opts.contractSpreadsheetId || contractStats === null) contractAction = 'CONFLICT';
  else if (!contractId) contractAction = 'CREATE';
  else contractAction = contractId === String(opts.contractSpreadsheetId) ? 'ALREADY_SET' : 'CONFLICT';
  report.plan.contract = contractAction;

  // 5. 本番マスター
  var production = registrationTrim_(registrationProperty_(REGISTRATION_KEY_PROPERTIES_.PRODUCTION_MASTER));
  report.productionMaster = {empty: production === '', same: production === masterId,
    different: production !== '' && production !== masterId};
  report.plan.productionMaster = !production ? 'CREATE' :
    (production === masterId ? 'ALREADY_SET' : 'CONFLICT');

  // 6. ルート
  var rootId = registrationTrim_(registrationProperty_(REGISTRATION_KEY_PROPERTIES_.ROOT_FOLDER));
  var category = registrationCategoryFolder_();
  report.rootFolder = {configured: rootId !== '', categoryFolderResolved: Boolean(category.folder)};

  var conflicts = Object.keys(report.plan).filter(function(key) {
    return report.plan[key] === 'CONFLICT';
  });
  if (!conflicts.length) {
    Logger.log(JSON.stringify(report));
    if (apply !== true) return report;
    return registrationApplyPreparation_(report, opts, actor, sourceRow, master, masterId);
  }
  Logger.log(JSON.stringify(report));
  report.stoppedBy = 'CONFLICT';
  return report;
}

function registrationFolderFiles_(folder) {
  var files = [];
  var iterator = folder.getFiles();
  while (iterator.hasNext()) files.push(iterator.next());
  return files;
}

function registrationAuditSetting_(actor, targetId, after) {
  appendAudit({
    type: 'SETTING',
    actor: actor,
    targetType: 'SETTING',
    targetId: targetId,
    before: '',
    after: after,
    reason: 'PREPARE_CUSTOMER_REGISTRATION'
  });
}

function registrationApplyPreparation_(report, opts, actor, sourceRow, master, masterId) {
  // **写しの ID を TEST01 の雛形で代用しない（F4）。** プロファイルを CREATE
  // するのに写しを作らない計画なら、何も書く前に例外で止める。
  if (report.plan.profile === 'CREATE' && report.plan.template !== 'CREATE') {
    throw registrationError_('TEMPLATE_COPY_MISSING');
  }
  var props = PropertiesService.getScriptProperties();
  var workId = null;

  if (report.plan.workFolder === 'REUSE' || report.plan.workFolder === 'CREATE') {
    registrationAuditSetting_(actor, 'PARALLEL_WORK_FOLDER_ID',
      {key: 'PARALLEL_WORK_FOLDER_ID', action: report.plan.workFolder});
    if (report.plan.workFolder === 'CREATE') {
      workId = String(DriveApp.getFolderById(String(opts.workParentFolderId))
        .createFolder('作業用').getId());
    } else {
      var parent = DriveApp.getFolderById(String(opts.workParentFolderId));
      var existing = registrationSortedFolders_(registrationChildren_(parent)).filter(function(folder) {
        return registrationNameKey_(folder.getName()) === '作業用';
      });
      workId = String(existing[0].getId());
    }
    props.setProperty('PARALLEL_WORK_FOLDER_ID', workId);
    SETTINGS.PARALLEL_WORK_FOLDER_ID = workId;
    report.applied = true;
  }

  var templateId = null;
  if (report.plan.template === 'CREATE') {
    registrationAuditSetting_(actor, 'TEMPLATE_COPY', {kind: 'CUSTOMER_TEMPLATE'});
    var sourceTemplateId = String(sourceRow[REGISTRATION_COLUMN_INDEX_.F]);
    var copies = registrationFolderFiles_(DriveApp.getFolderById(String(opts.templateFolderId)));
    var templateFile = DriveApp.getFileById(sourceTemplateId);
    var copy = templateFile.makeCopy('雛形（個人）', DriveApp.getFolderById(String(opts.templateFolderId)));
    templateId = String(copy.getId());
    var templateSpreadsheet = SpreadsheetApp.openById(templateId);
    var inputSheet = templateSpreadsheet.getSheetByName(String(sourceRow[REGISTRATION_COLUMN_INDEX_.H]));
    if (inputSheet) {
      var firstDataRow = Number(sourceRow[REGISTRATION_COLUMN_INDEX_.AD]) + 1;
      var lastRow = Number(inputSheet.getLastRow());
      var owned = registrationOwnedColumns_(sourceRow);
      if (lastRow >= firstDataRow) {
        owned.forEach(function(number) {
          inputSheet.getRange(firstDataRow, number, lastRow - firstDataRow + 1, 1).clearContent();
        });
      }
    }
    report.applied = true;
  }

  if (report.plan.profile === 'CREATE') {
    // **写しの ID を TEST01 の雛形で代用しない（F4）。** 代用すると全顧客の
    // 登録が TEST01 の雛形を指し、§3.12 のガードが TEST01 の取込を止める。
    if (!templateId) throw registrationError_('TEMPLATE_COPY_MISSING');
    var profile = registrationProfileFromRow_(sourceRow, templateId,
      String(opts.sourceCustomerId || 'TEST01'));
    registrationValidateProfile_(profile);
    var serialized = JSON.stringify(profile);
    if (registrationReportBytes_(serialized) > 8000) {
      report.stoppedBy = 'PROFILE_TOO_LARGE';
      return report;
    }
    registrationAuditSetting_(actor, REGISTRATION_KEY_PROPERTIES_.PROFILE,
      {key: REGISTRATION_KEY_PROPERTIES_.PROFILE});
    props.setProperty(REGISTRATION_KEY_PROPERTIES_.PROFILE, serialized);
    report.applied = true;
  }

  if (report.plan.contract === 'CREATE') {
    registrationAuditSetting_(actor, REGISTRATION_KEY_PROPERTIES_.CONTRACT,
      {key: REGISTRATION_KEY_PROPERTIES_.CONTRACT});
    props.setProperty(REGISTRATION_KEY_PROPERTIES_.CONTRACT, String(opts.contractSpreadsheetId));
    report.applied = true;
  }

  if (report.plan.productionMaster === 'CREATE') {
    registrationAuditSetting_(actor, REGISTRATION_KEY_PROPERTIES_.PRODUCTION_MASTER,
      {key: REGISTRATION_KEY_PROPERTIES_.PRODUCTION_MASTER});
    props.setProperty(REGISTRATION_KEY_PROPERTIES_.PRODUCTION_MASTER, String(masterId));
    report.applied = true;
  }
  return report;
}

/** 雛形の写しで空にするシステム列（`webAppCloneDestination_` と同じ規則）。 */
function registrationOwnedColumns_(sourceRow) {
  var owned = [];
  // J〜O 列が転記先の B・F・I・K・M・取引ID の列番号（design §2.1.1）。
  [9, 10, 11, 12, 13, 14].forEach(function(index) {
    owned.push(Number(sourceRow[index]));
  });
  if (sourceRow[REGISTRATION_COLUMN_INDEX_.AQ] !== '' && sourceRow[REGISTRATION_COLUMN_INDEX_.AQ] !== null) {
    owned.push(Number(sourceRow[REGISTRATION_COLUMN_INDEX_.AQ]));
  }
  if (sourceRow[REGISTRATION_COLUMN_INDEX_.AR] !== '' && sourceRow[REGISTRATION_COLUMN_INDEX_.AR] !== null) {
    owned.push(Number(sourceRow[REGISTRATION_COLUMN_INDEX_.AR]));
  }
  var excluded = registrationParseExcludedColumns_(sourceRow[REGISTRATION_COLUMN_INDEX_.AL]);
  var taxColumn = Number(sourceRow[REGISTRATION_COLUMN_INDEX_.AP]);
  if (Number.isInteger(taxColumn) && taxColumn >= 1 && excluded.indexOf(taxColumn) < 0) {
    owned.push(taxColumn);
  }
  return owned;
}

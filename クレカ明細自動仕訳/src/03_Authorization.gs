'use strict';

// 読込時の失敗は定期取込まで止めるため、他ファイルの定数や関数を参照せず
// リテラルだけで定義する。ROLE との一致は認可テスト I-40 で固定する。
var ROLE_RANK_ = {
  REVIEWER: 1,
  SYSTEM_ADMIN: 2,
  OWNER_ADMIN: 3
};

var ROLE_LABELS_ = {
  REVIEWER: '確認担当者',
  SYSTEM_ADMIN: 'システム管理者',
  OWNER_ADMIN: 'オーナー管理者'
};

var AUTH_REASON_ = {
  ACTOR_UNKNOWN: 'ACTOR_UNKNOWN',
  NO_CUSTOMER_ACCESS: 'NO_CUSTOMER_ACCESS',
  ROLE_INSUFFICIENT: 'ROLE_INSUFFICIENT',
  CUSTOMER_NOT_ACTIVE: 'CUSTOMER_NOT_ACTIVE'
};

// 未知の操作を既定値で通すと、新しい操作を足したとき認可だけが抜けるため、
// 実装済みの解決操作を過不足なく列挙する。
var OPERATION_ROLES_ = {
  ADOPT_EXISTING_PARTNER: 'REVIEWER',
  REQUEST_NEW_PARTNER: 'REVIEWER',
  RESOLVE_WITHOUT_PARTNER: 'REVIEWER',
  RESOLVE_PARTNER_UNKNOWN: 'REVIEWER',
  FIX_DATE_AMOUNT: 'REVIEWER',
  POST_ZERO_AMOUNT: 'REVIEWER',
  POST_PRIOR_YEAR: 'REVIEWER',
  EXCLUDE_PRIOR_YEAR: 'REVIEWER',
  EXCLUDE: 'REVIEWER',
  ACCEPT_MANUAL_CHANGE: 'REVIEWER',
  REVERT_TO_SYSTEM_VALUE: 'REVIEWER',
  RESTORE_ROW: 'OWNER_ADMIN',
  ACCEPT_DELETION: 'REVIEWER',
  CONFIRM_FREEE_FIXED: 'REVIEWER',
  CONFIRM_INTEGRITY_RESOLVED: 'SYSTEM_ADMIN',
  REGISTER_FORMAT: 'SYSTEM_ADMIN',
  SELECT_TARGET_SHEET: 'SYSTEM_ADMIN',
  CANCEL_FILE: 'REVIEWER',
  IMPORT_AS_NEW_FILE: 'REVIEWER',
  UPDATE_PURPOSE: 'REVIEWER',
  KEEP_ORIGINAL_RESULT: 'REVIEWER',
  APPLY_FILE_DIFF: 'REVIEWER',
  ADOPT_AS_NEW_TRANSACTION: 'REVIEWER',
  APPROVE_COUNT_MISMATCH: 'REVIEWER',
  REJECT_COUNT_MISMATCH: 'REVIEWER',
  CONFIRM_EMPTY_FILE: 'REVIEWER',
  RESIZE_INPUT: 'OWNER_ADMIN',
  CONFIRM_DESTINATION_FIXED: 'SYSTEM_ADMIN',
  APPROVE_SCAN_TRUNCATION: 'SYSTEM_ADMIN'
};

/**
 * 役割と顧客範囲を同じ時点の顧客マスターで検査する唯一の入口。
 * 許可顧客を別関数で読み直すと判定間でマスターが変わり得るうえ、対話操作の
 * 往復が倍になるため、有効顧客は一度だけ読む。
 */
function authorize(requiredRole, customerId, options) {
  if (!Object.prototype.hasOwnProperty.call(ROLE_RANK_, requiredRole)) {
    throw new TypeError('Unknown required role: ' + requiredRole);
  }
  if (customerId !== null && customerId !== undefined && typeof customerId !== 'string') {
    throw new TypeError('customerId must be a string or null');
  }

  var normalizedCustomerId = customerId === null || customerId === undefined || customerId === '' ?
    null : customerId;
  var operation = options && options.operation ? String(options.operation) : '';
  var actor = resolveActor_();
  var context = {
    userEmail: actor.raw,
    requiredRole: requiredRole,
    actualRole: null,
    customerId: normalizedCustomerId,
    operation: operation
  };
  if (!actor.normalized) {
    throw denyAuthorization_(AUTH_REASON_.ACTOR_UNKNOWN, context);
  }

  var ownerEmail = masterOwnerEmail_();
  var isOwner = Boolean(ownerEmail) && ownerEmail === actor.normalized;
  var activeCustomers = getActiveCustomers();
  var selectedCustomer = null;
  if (normalizedCustomerId !== null) {
    for (var selectedIndex = 0; selectedIndex < activeCustomers.length; selectedIndex += 1) {
      if (activeCustomers[selectedIndex].customerId === normalizedCustomerId) {
        selectedCustomer = activeCustomers[selectedIndex];
        break;
      }
    }
    if (!selectedCustomer) {
      throw denyAuthorization_(AUTH_REASON_.CUSTOMER_NOT_ACTIVE, context);
    }
  }

  var roleByActiveCustomerId = {};
  var allowedCustomers = [];
  activeCustomers.forEach(function(customer) {
    var customerRole = roleForCustomer_(actor.normalized, isOwner, customer);
    roleByActiveCustomerId[customer.customerId] = customerRole;
    if (customerRole !== null) allowedCustomers.push(customer);
  });

  var actualRole = normalizedCustomerId === null ?
    aggregateRole_(actor.normalized, isOwner, activeCustomers) :
    roleByActiveCustomerId[normalizedCustomerId];
  context.actualRole = actualRole;
  if (actualRole === null) {
    throw denyAuthorization_(AUTH_REASON_.NO_CUSTOMER_ACCESS, context);
  }
  if (!hasRole(actualRole, requiredRole)) {
    throw denyAuthorization_(AUTH_REASON_.ROLE_INSUFFICIENT, context);
  }
  if (normalizedCustomerId === null && allowedCustomers.length === 0) {
    throw denyAuthorization_(AUTH_REASON_.NO_CUSTOMER_ACCESS, context);
  }

  var customers = normalizedCustomerId === null ? allowedCustomers : [selectedCustomer];
  var customerIds = [];
  var rolesByCustomerId = {};
  customers.forEach(function(customer) {
    customerIds.push(customer.customerId);
    rolesByCustomerId[customer.customerId] = roleByActiveCustomerId[customer.customerId];
  });
  return {
    userEmail: actor.raw,
    role: actualRole,
    isOwner: isOwner,
    ownerEmail: ownerEmail,
    customerId: normalizedCustomerId,
    customers: customers,
    customerIds: customerIds,
    rolesByCustomerId: rolesByCustomerId
  };
}

/**
 * 表示や候補絞込みでも認可入口と同じ規則を使わないと、入口では拒否される
 * 顧客を先に見せてしまうため、共通の顧客別判定を使う。
 */
function getUserRole(userEmail, customerId) {
  var normalizedEmail = normalizeAuthorizationEmail_(userEmail);
  if (!normalizedEmail) return null;
  var normalizedCustomerId = customerId === null || customerId === undefined || customerId === '' ?
    null : String(customerId);
  var ownerEmail = masterOwnerEmail_();
  var isOwner = Boolean(ownerEmail) && ownerEmail === normalizedEmail;
  var customers = getActiveCustomers();
  if (normalizedCustomerId === null) {
    return aggregateRole_(normalizedEmail, isOwner, customers);
  }
  for (var index = 0; index < customers.length; index += 1) {
    if (customers[index].customerId === normalizedCustomerId) {
      return roleForCustomer_(normalizedEmail, isOwner, customers[index]);
    }
  }
  return null;
}

/** 必要役割の綴り間違いを「全員拒否」として隠さない。 */
function hasRole(role, requiredRole) {
  if (!Object.prototype.hasOwnProperty.call(ROLE_RANK_, requiredRole)) {
    throw new TypeError('Unknown required role: ' + requiredRole);
  }
  if (!Object.prototype.hasOwnProperty.call(ROLE_RANK_, role)) return false;
  return ROLE_RANK_[role] >= ROLE_RANK_[requiredRole];
}

/**
 * 定期取込の既存関数とはオーナー特例の有無が意図的に違うため、既存関数を
 * 変更せず、同じ Q/R 述語へメニュー用のオーナー特例だけを重ねる。
 */
function getAuthorizedCustomerIds(userEmail) {
  var normalizedEmail = normalizeAuthorizationEmail_(userEmail);
  if (!normalizedEmail) return [];
  var ownerEmail = masterOwnerEmail_();
  var isOwner = Boolean(ownerEmail) && ownerEmail === normalizedEmail;
  return getActiveCustomers().filter(function(customer) {
    return roleForCustomer_(normalizedEmail, isOwner, customer) !== null;
  }).map(function(customer) { return customer.customerId; });
}

/** 操作コードを役割へ変換してから、顧客別の認可入口へ必ず合流させる。 */
function authorizeOperation(operationCode, customerId, options) {
  var requiredRole = requiredRoleForOperation_(operationCode, options);
  if (customerId === null || customerId === undefined || customerId === '') {
    throw new TypeError('authorizeOperation requires a customerId');
  }
  return authorize(requiredRole, customerId, {operation: String(operationCode)});
}

/**
 * コーパス許可リストだけでは確認担当者を管理者へ昇格させてしまうため、
 * 顧客マスター由来の集約役割も同時に要求する。
 */
function isCorpusAdmin(userEmail) {
  var normalizedEmail = normalizeAuthorizationEmail_(userEmail);
  if (!normalizedEmail) return false;
  var ownerEmail = masterOwnerEmail_();
  var isOwner = Boolean(ownerEmail) && ownerEmail === normalizedEmail;
  if (isOwner) return true;
  var role = aggregateRole_(normalizedEmail, false, getActiveCustomers());
  return hasRole(role, ROLE.SYSTEM_ADMIN) &&
    csvEmails_(SETTINGS.CORPUS_ADMIN_EMAILS).indexOf(normalizedEmail) >= 0;
}

/** 役割不明を空欄にすると表示の欠落を正常な状態と誤読するため明示する。 */
function roleLabel(role) {
  return ROLE_LABELS_[role] || '（役割なし）';
}

/**
 * active user が取れない文脈を別人の資格で埋めるとウェブアプリ化時に全員が
 * 所有者として通るため、例外も空値として拒否側へ倒す。
 */
function resolveActor_() {
  var raw;
  try {
    raw = activeUserEmail_();
  } catch (ignored) {
    return {raw: '', normalized: ''};
  }
  if (typeof raw !== 'string') return {raw: '', normalized: ''};
  return {raw: raw, normalized: normalizeAuthorizationEmail_(raw)};
}

/** Google 側の所有者という単一の根拠が取れなければ、推測せず無権限に倒す。 */
function masterOwnerEmail_() {
  try {
    var owner = masterSpreadsheet_().getOwner();
    if (!owner || typeof owner.getEmail !== 'function') return '';
    return normalizeAuthorizationEmail_(owner.getEmail());
  } catch (ignored) {
    return '';
  }
}

function normalizeAuthorizationEmail_(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

/** R列を Q列より先に見ることで、両方に載る人の管理者権限を失わせない。 */
function roleForCustomer_(normalizedEmail, isOwner, customer) {
  if (isOwner) return ROLE.OWNER_ADMIN;
  if (customer.admins.indexOf(normalizedEmail) >= 0) return ROLE.SYSTEM_ADMIN;
  if (customer.reviewers.indexOf(normalizedEmail) >= 0) return ROLE.REVIEWER;
  return null;
}

/** 顧客横断操作だけが各顧客の最大役割を使い、顧客固有操作には流用しない。 */
function aggregateRole_(normalizedEmail, isOwner, customers) {
  if (isOwner) return ROLE.OWNER_ADMIN;
  var aggregate = null;
  (customers || []).forEach(function(customer) {
    var role = roleForCustomer_(normalizedEmail, false, customer);
    if (role !== null && (aggregate === null || ROLE_RANK_[role] > ROLE_RANK_[aggregate])) {
      aggregate = role;
    }
  });
  return aggregate;
}

/**
 * 監査の書込に失敗しても拒否そのものは失わせない。逆に実行者不明は監査行へ
 * 帰属できないため Logger だけに残す。
 */
function denyAuthorization_(reason, context) {
  Logger.log('[auth] DENIED reason=' + reason +
    ' actor=' + context.userEmail +
    ' required=' + context.requiredRole +
    ' actual=' + (context.actualRole === null ? 'null' : context.actualRole) +
    ' customer=' + (context.customerId === null ? '-' : context.customerId) +
    ' op=' + (context.operation || '-'));
  if (reason !== AUTH_REASON_.ACTOR_UNKNOWN) {
    try {
      appendAudit({
        type: 'PERMISSION',
        actor: context.userEmail,
        targetType: context.customerId === null ? 'SETTING' : 'CUSTOMER',
        targetId: context.customerId === null ? 'SYSTEM' : context.customerId,
        customerId: context.customerId || '',
        before: '',
        after: {
          decision: 'DENIED',
          reason: reason,
          requiredRole: context.requiredRole,
          actualRole: context.actualRole,
          operation: context.operation || ''
        },
        reason: reason,
        appliedAt: ''
      });
    } catch (auditError) {
      Logger.log('[auth] audit write failed: ' +
        (auditError && auditError.stack ? auditError.stack : String(auditError)));
    }
  }
  var error = new AuthorizationError(authorizationDetail_(reason, context));
  error.reason = reason;
  error.context = {
    userEmail: context.userEmail,
    requiredRole: context.requiredRole,
    actualRole: context.actualRole,
    customerId: context.customerId,
    operation: context.operation || ''
  };
  return error;
}

/** 画面文言を一か所に閉じ、理由コードや内部情報を利用者へ露出させない。 */
function authorizationDetail_(reason, context) {
  if (reason === AUTH_REASON_.ACTOR_UNKNOWN) {
    return '実行者のメールアドレスを取得できないため表示できません（仕様 §20.5）。' +
      'スクリプトの承認が済んでいるか確認してください。';
  }
  if (reason === AUTH_REASON_.CUSTOMER_NOT_ACTIVE) {
    return '顧客 ' + context.customerId + ' は顧客マスターに無いか、無効になっています。';
  }
  if (reason === AUTH_REASON_.NO_CUSTOMER_ACCESS) {
    if (context.customerId === null) {
      return '閲覧を許可された顧客がありません。実行者: ' + context.userEmail + '。' +
        '顧客マスターの Q列（確認担当者）または R列（システム管理者）にこのアドレスを登録してください。';
    }
    return '顧客 ' + context.customerId + ' に対する権限がありません。実行者: ' +
      context.userEmail + '。顧客マスターの Q列（確認担当者）または R列（システム管理者）に' +
      'このアドレスを登録してください。';
  }
  return 'この操作には' + roleLabel(context.requiredRole) + 'の権限が必要です。実行者: ' +
    context.userEmail + '（' + (context.customerId === null ? '全体' : '顧客 ' + context.customerId) +
    'に対する役割: ' + roleLabel(context.actualRole) + '）。';
}

/**
 * 省略された入力が緩い役割へ落ちないよう、入力上限だけは厳しい基本値から
 * 顧客への分割依頼が明示された場合に限って格下げする。
 */
function requiredRoleForOperation_(operationCode, options) {
  var code = String(operationCode);
  if (!Object.prototype.hasOwnProperty.call(OPERATION_ROLES_, code)) {
    throw new TypeError('Unknown operation code: ' + code);
  }
  var opts = options || {};
  if ((code === 'CANCEL_FILE' || code === 'EXCLUDE') && opts.allowImported === true) {
    return ROLE.SYSTEM_ADMIN;
  }
  if (code === 'RESIZE_INPUT' && opts.askCustomerToSplit === true) {
    return ROLE.REVIEWER;
  }
  if (OPERATION_ROLES_[code] === ROLE.REVIEWER) return ROLE.REVIEWER;
  if (OPERATION_ROLES_[code] === ROLE.SYSTEM_ADMIN) return ROLE.SYSTEM_ADMIN;
  return ROLE.OWNER_ADMIN;
}

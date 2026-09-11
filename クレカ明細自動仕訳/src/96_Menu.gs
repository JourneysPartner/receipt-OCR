'use strict';

/**
 * 設計 §4.2 `01_Menu.gs` の参照系部分の暫定実装。
 * `03_Authorization.gs` 実装まで操作系を含めない。
 *
 * 読込時の例外は定期取込まで止めるため、トップレベルには関数宣言と
 * リテラルだけで作る定数以外を置かない。
 */

var MENU_FILE_STATE_LABELS_ = {
  DISCOVERED: '未処理（取込待ち）',
  VALIDATING: '処理中（読取・検証中）',
  WRITING: '処理中（転記中）',
  REVIEW_WAIT: '要確認待ち',
  CUSTOMER_FIX_REQUIRED: '要修正（顧客の修正待ち）',
  COMPLETED: '完了',
  CANCELED: '取消済',
  EXCLUDED: '対象外',
  FAILED: '失敗'
};

var MENU_FILE_STATE_PRIORITY_ = {
  FAILED: 0,
  CUSTOMER_FIX_REQUIRED: 1,
  VALIDATING: 2,
  WRITING: 2,
  REVIEW_WAIT: 3,
  DISCOVERED: 4,
  COMPLETED: 5,
  CANCELED: 6,
  EXCLUDED: 7
};

var MENU_REVIEW_TYPE_LABELS_ = {
  PARTNER: '取引先',
  DATE: '日付',
  AMOUNT: '金額',
  ZERO_AMOUNT: '金額0',
  INTEGRITY: '整合性',
  PRIOR_YEAR: '前年利用日',
  FORMAT_UNKNOWN: '形式不明',
  FORMAT_AMBIGUOUS: '形式曖昧',
  MULTI_SHEET: '複数シート',
  DUPLICATE: '重複',
  FILE_CHANGED: 'ファイル変更',
  COUNT_TOTAL_MISMATCH: '件数・合計不一致',
  EMPTY_FILE: '空ファイル',
  INPUT_LIMIT: '入力上限',
  DESTINATION_FIX: '転記先の是正',
  SCAN_TRUNCATED: '走査打切り'
};

var MENU_REVIEW_HANDLER_LABELS_ = {
  PARTNER: '確認担当者',
  DATE: '確認担当者',
  AMOUNT: '確認担当者',
  ZERO_AMOUNT: '確認担当者',
  INTEGRITY: 'システム管理者',
  PRIOR_YEAR: '確認担当者',
  FORMAT_UNKNOWN: 'システム管理者',
  FORMAT_AMBIGUOUS: 'システム管理者',
  MULTI_SHEET: 'システム管理者',
  DUPLICATE: '確認担当者',
  FILE_CHANGED: 'システム管理者',
  COUNT_TOTAL_MISMATCH: '確認担当者',
  EMPTY_FILE: '確認担当者',
  INPUT_LIMIT: 'システム管理者',
  DESTINATION_FIX: 'システム管理者',
  SCAN_TRUNCATED: 'システム管理者'
};

var MENU_LEASE_PURPOSE_LABELS_ = {
  PROCESS: '取込',
  WRITE_ONLY: '書込のみ（解決・取消し）'
};

function onOpen(e) {
  var ui = menuUi_();
  var diagnostics = ui.createMenu('診断')
    .addItem('リースの状況', 'menuShowLeases')
    .addItem('設定の検査', 'menuCheckSettings')
    .addItem('タグ付き取引を検索', 'menuFindTaggedTransactions')
    .addItem('タグ遡及の対象ファイル', 'menuShowTagBackfillTargets')
    .addItem('このメニューについて', 'menuShowAbout');
  ui.createMenu('クレカ自動処理')
    .addItem('取込の状況', 'menuShowImportStatus')
    .addItem('ファイル一覧', 'menuShowFileList')
    .addItem('要確認を開く', 'menuOpenReview')
    .addItem('処理ログを開く', 'menuOpenLog')
    .addSeparator()
    .addSubMenu(diagnostics)
    .addToUi();
}

function menuShowImportStatus() {
  runMenuAction_('取込の状況', function(scope, now) {
    var collected = collectImportStatus_({now: now});
    var triggers = ScriptApp.getProjectTriggers();
    var triggerCount = triggers.filter(function(trigger) {
      return trigger.getHandlerFunction() === SCHEDULED_IMPORT_HANDLER_;
    }).length;
    var watchdogCount = triggers.filter(function(trigger) {
      return trigger.getHandlerFunction() === NOTIFICATION_WATCHDOG_HANDLER_;
    }).length;
    var notificationState = null;
    var watch = null;
    var notificationLines;
    try {
      notificationState = readNotificationState_();
      watch = readNotificationWatch_(notificationState);
      notificationLines = notificationStatusLines_(notificationState.global, now, watchdogCount);
    } catch (ignored) {
      notificationLines = ['■ メール通知: (状態を取得できません)'];
    }
    var view = buildImportStatusView_(collected, scope, now, triggerCount, watch);
    view.text += '\n' + notificationLines.join('\n');
    return {kind: 'alert', title: '取込の状況', text: view.text};
  });
}

function menuShowFileList() {
  runMenuAction_('ファイル一覧', function(scope, now) {
    var built = buildFileListRows_(collectImportStatus_({now: now}), scope, now);
    var footer = built.omitted ?
      ['他 ' + built.omitted + ' 件は表示していません（完了・取消済・対象外から順に省いています）'] : [];
    return {
      kind: 'modal', title: 'ファイル一覧', width: 960, height: 600,
      html: renderMenuTable_(menuHeaderLines_(scope, now).concat([built.summaryLine]),
        built.columns, built.rows, footer, [])
    };
  });
}

function menuOpenReview() {
  runMenuAction_('要確認を開く', function(scope, now) {
    var built = buildReviewRows_(openReviews({}), scope, now);
    var target = reviewSheet_();
    var footer = built.omitted ? ['他 ' + built.omitted + ' 件は表示していません'] : [];
    return {
      kind: 'modal', title: '要確認を開く', width: 960, height: 600,
      html: renderMenuTable_(menuHeaderLines_(scope, now).concat([built.summaryLine]),
        built.columns, built.rows, footer, [{
          label: '要確認シートを開く',
          url: target.getParent().getUrl() + '#gid=' + target.getSheetId()
        }])
    };
  });
}

function menuOpenLog() {
  runMenuAction_('処理ログを開く', function(scope, now) {
    var masterSheet = processLogSheet_();
    var header = menuHeaderLines_(scope, now);
    var footer = [];
    if (masterSheet.isSheetHidden()) {
      footer.push('処理ログシートは非表示になっています。管理者に再表示を依頼してください');
    }
    var fallback = renderMenuTable_(header, [], [], footer, [{
      label: 'クレカ処理ログを開く',
      url: masterSheet.getParent().getUrl() + '#gid=' + masterSheet.getSheetId()
    }]);
    return {
      kind: 'navigate', title: '処理ログを開く',
      sheetName: CONFIG.SHEET_NAMES.PROCESS_LOG,
      masterSheet: masterSheet,
      fallbackHtml: fallback
    };
  });
}

function menuShowLeases() {
  runMenuAction_('リースの状況', function(scope, now) {
    var built = buildLeaseRows_(collectLeaseStatus_({now: now}), scope, now);
    var header = menuHeaderLines_(scope, now);
    if (!built.rows.length) header.push('有効なリースはありません');
    var footer = built.omitted ? ['他 ' + built.omitted + ' 件は表示していません'] : [];
    return {
      kind: 'modal', title: 'リースの状況', width: 960, height: 600,
      html: renderMenuTable_(header, built.rows.length ? built.columns : [],
        built.rows, footer, [])
    };
  });
}

function menuCheckSettings() {
  runMenuAction_('設定の検査', function(scope, now) {
    var context = {
      customerFolderIds: scope.customers.map(function(customer) { return customer.sourceFolderId; }),
      corpusFolderAccessible: true,
      corpusFolderAncestors: []
    };
    var result = validateSettings(VALIDATION_SCOPE.IMPORT, context);
    var loaded = loadSettingsFromProperties();
    return {
      kind: 'alert', title: '設定の検査',
      text: menuHeaderLines_(scope, now).join('\n') + '\n\n' +
        buildSettingsCheckText_(result, loaded)
    };
  });
}

function menuFindTaggedTransactions() {
  runMenuAction_('タグ付き取引を検索', function(scope, now) {
    var ui = menuUi_();
    var response = ui.prompt('クレカ自動処理 ― タグ付き取引を検索',
      'メモタグを入力してください（例：海外決済、キャッシュバック）。空欄なら「海外決済」',
      ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return {kind: 'none'};
    var tag = String(response.getResponseText() || '').trim() || '海外決済';
    var built = buildTaggedTransactionRows_(collectTaggedTransactions_(tag), scope, tag);
    var header = menuHeaderLines_(scope, now).concat([built.summaryLine]);
    if (!built.rows.length) header.push('該当なし');
    var footer = built.omitted ? ['他 ' + built.omitted + ' 件は表示していません'] : [];
    return {
      kind: 'modal', title: 'タグ付き取引を検索', width: 960, height: 600,
      html: renderMenuTable_(header, built.rows.length ? built.columns : [],
        built.rows, footer, [])
    };
  });
}

function menuShowTagBackfillTargets() {
  runMenuAction_('タグ遡及の対象ファイル', function(scope, now) {
    var built = buildBackfillRows_(collectTagBackfillTargets_(), scope);
    var header = menuHeaderLines_(scope, now).concat([built.summaryLine]);
    if (!built.rows.length) header.push('対象はありません（すべて現行の規則どおりです）');
    var footer = [];
    if (built.omitted) footer.push('他 ' + built.omitted + ' 件は表示していません');
    footer.push('取り込み直しは管理者が opsBackfillMemoTags で行います');
    return {
      kind: 'modal', title: 'タグ遡及の対象ファイル', width: 960, height: 600,
      html: renderMenuTable_(header, built.rows.length ? built.columns : [],
        built.rows, footer, [])
    };
  });
}

/**
 * 拒否理由そのものが接続確認の材料なので、この項目だけ共通骨組みより内側で
 * 閲覧範囲の例外を捕捉し、コンテナとマスターの情報を補う。
 */
function menuShowAbout() {
  var ui = menuUi_();
  var actionName = 'このメニューについて';
  try {
    loadSettingsFromProperties();
    var now = new Date();
    var scope;
    try {
      scope = menuViewerScope_();
    } catch (scopeError) {
      if (scopeError instanceof AuthorizationError) {
        presentMenuError_(ui, actionName, scopeError, menuBindingLines_());
        return;
      }
      throw scopeError;
    }
    var master = masterSpreadsheet_();
    var configuredMasterId = resolveMasterSpreadsheetId_();
    var active = SpreadsheetApp.getActiveSpreadsheet();
    var activeId = active ? active.getId() : null;
    var customers = menuCustomerSummary_(scope.customers, false);
    var text = menuHeaderLines_(scope, now).join('\n') + '\n\n' +
      '実行者: ' + scope.email + '（オーナー: ' + (scope.isOwner ? 'はい' : 'いいえ') + '）\n' +
      '閲覧できる顧客: ' + customers + '\n' +
      'マスタースプレッドシート: ' + (configuredMasterId || '(未設定。アクティブなスプレッドシートを使用)') + '\n' +
      'このスプレッドシート: ' + (activeId || '(なし)') + '\n' +
      '両者の関係: ' + (activeId && activeId === master.getId() ? '一致' : '不一致') + '\n' +
      'コード版: ' + VERSIONS.CODE + '\n' +
      'このメニューは参照専用です。取込・確定・取消しなどの操作は含みません（認可モジュール実装まで）。';
    presentMenuResult_(ui, {kind: 'alert', title: actionName, text: text});
  } catch (error) {
    presentMenuError_(ui, actionName, error, []);
  }
}

function menuUi_() { return SpreadsheetApp.getUi(); }

function runMenuAction_(actionName, fn) {
  var ui = menuUi_();
  try {
    loadSettingsFromProperties();
    var now = new Date();
    var scope = menuViewerScope_();
    presentMenuResult_(ui, fn(scope, now));
  } catch (error) {
    presentMenuError_(ui, actionName, error, []);
  }
}

function presentMenuResult_(ui, result) {
  if (!result || result.kind === 'none') return;
  var title = 'クレカ自動処理 ― ' + result.title;
  if (result.kind === 'alert') {
    ui.alert(title, result.text, ui.ButtonSet.OK);
    return;
  }
  if (result.kind === 'modal') {
    ui.showModalDialog(HtmlService.createHtmlOutput(result.html)
      .setWidth(result.width).setHeight(result.height), title);
    return;
  }
  if (result.kind !== 'navigate') return;
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active && active.getId() === result.masterSheet.getParent().getId()) {
    var target = active.getSheetByName(result.sheetName);
    if (target && !target.isSheetHidden()) {
      active.setActiveSheet(target);
      return;
    }
  }
  ui.showModalDialog(HtmlService.createHtmlOutput(result.fallbackHtml)
    .setWidth(520).setHeight(200), title);
}

function presentMenuError_(ui, actionName, error, extraLines) {
  Logger.log('[menu] ' + actionName + ' failed: ' +
    (error && error.stack ? error.stack : String(error)));
  var classified = classifyMenuError_(error);
  if (classified.rethrow) throw error;
  var lines = [actionName + ' を表示できませんでした。'].concat(classified.lines || []);
  if (extraLines && extraLines.length) lines = lines.concat(extraLines);
  ui.alert('クレカ自動処理 ― エラー', lines.join('\n'), ui.ButtonSet.OK);
}

/**
 * 参照専用の暫定範囲であり、書込を伴う操作に流用しない。
 * 実行者が不明なまま全顧客へ広げると、拒否すべき人に情報を見せてしまう。
 */
function menuViewerScope_() {
  var email = activeUserEmail_();
  if (!email) {
    throw new AuthorizationError(
      '実行者のメールアドレスを取得できないため表示できません（仕様 §20.5）。スクリプトの承認が済んでいるか確認してください。');
  }
  var spreadsheet = masterSpreadsheet_();
  var owner = spreadsheet.getOwner();
  var ownerEmail = owner && owner.getEmail ? String(owner.getEmail() || '') : '';
  var isOwner = Boolean(ownerEmail) && ownerEmail.toLowerCase() === String(email).toLowerCase();
  var customers = isOwner ? getActiveCustomers() : getAuthorizedCustomers(email);
  if (!customers.length) {
    throw new AuthorizationError('閲覧を許可された顧客がありません。実行者: ' + email +
      '。顧客マスターの Q列（確認担当者）または R列（システム管理者）にこのアドレスを登録してください。');
  }
  var customerIds = [];
  var customerNameById = {};
  customers.forEach(function(customer) {
    customerIds.push(customer.customerId);
    customerNameById[customer.customerId] = customer.customerName;
  });
  return {
    email: email,
    isOwner: isOwner,
    customers: customers,
    customerIds: customerIds,
    customerNameById: customerNameById
  };
}

function menuHeaderLines_(scope, now) {
  return [
    '実行者: ' + scope.email + (scope.isOwner ? '（オーナー）' : ''),
    '対象顧客: ' + menuCustomerSummary_(scope.customers, true) +
      '　取得: ' + formatMenuTimestamp_(now)
  ];
}

function menuCustomerSummary_(customers, shorten) {
  var list = (customers || []).map(function(customer) {
    return String(customer.customerName || '（顧客不明）') + '(' + String(customer.customerId || '') + ')';
  });
  if (shorten && list.length > 5) return list.slice(0, 5).join('、') + '、ほか' + (list.length - 5) + '社';
  return list.join('、');
}

function buildImportStatusView_(collected, scope, now, triggerCount, watch) {
  var files = filterByScope_(collected.files || [], scope);
  var leases = filterByScope_(collected.leases || [], scope);
  var reviews = filterByScope_(collected.reviews || [], scope);
  var stateOrder = ['FAILED', 'CUSTOMER_FIX_REQUIRED', 'VALIDATING', 'WRITING',
    'REVIEW_WAIT', 'DISCOVERED', 'COMPLETED', 'CANCELED', 'EXCLUDED'];
  var assessment = assessImportStatus_({files: files, leases: leases,
    lastActivityAt: collected.lastActivityAt}, now, watch);
  var stateCounts = assessment.stateCounts;
  var stuckFiles = assessment.stuckFiles;
  var stalledLeases = assessment.stalledLeases;
  var warnings = assessment.findings.map(function(finding) { return finding.line; });
  var lastActivity = collected.lastActivityAt;
  if (!warnings.length) warnings.push('異常は見つかりませんでした');

  var totals = {read: 0, auto: 0, review: 0, excluded: 0, error: 0};
  files.forEach(function(file) {
    totals.read += Number(file.readCount || 0);
    totals.auto += Number(file.autoCount || 0);
    totals.review += Number(file.reviewCount || 0);
    totals.excluded += Number(file.excludedCount || 0);
    totals.error += Number(file.errorCount || 0);
  });
  var reviewCounts = menuCountBy_(reviews, 'reviewType', MENU_REVIEW_TYPE_LABELS_);
  var lines = menuHeaderLines_(scope, now).concat(['']).concat(warnings).concat([
    '',
    '■ ファイル（合計 ' + files.length + '）'
  ]);
  stateOrder.forEach(function(state) {
    lines.push('  ' + menuFileStateLabel_(state) + ': ' + stateCounts[state]);
  });
  lines.push('  処理中で停止の疑い: ' + stuckFiles.length);
  lines.push('■ 明細（累計）');
  lines.push('  読取 ' + totals.read + ' / 自動確定 ' + totals.auto + ' / 要確認 ' + totals.review +
    ' / 除外 ' + totals.excluded + ' / エラー ' + totals.error);
  lines.push('■ 未解決の要確認: ' + reviews.length +
    (reviewCounts.length ? '（' + reviewCounts.join('、') + '）' : ''));
  lines.push('■ リース: 有効 ' + leases.length + ' / 停滞 ' + stalledLeases.length);
  lines.push('■ 最終活動: ' + formatMenuTimestamp_(lastActivity) +
    (lastActivity ? '（' + describeAge_(lastActivity, now) + '）' : ''));
  lines.push('■ 定期取込トリガー（この操作者が作成した分）: ' + Number(triggerCount || 0) + ' 件');
  lines.push('  ※ 他の人が作成したトリガーはここに出ません');
  return {text: lines.join('\n'), stateCounts: stateCounts, stuckSuspects: stuckFiles.length};
}

function buildFileListRows_(collected, scope, now) {
  var files = filterByScope_(collected.files || [], scope).slice();
  files.sort(function(left, right) {
    var leftPriority = MENU_FILE_STATE_PRIORITY_[left.state];
    var rightPriority = MENU_FILE_STATE_PRIORITY_[right.state];
    leftPriority = leftPriority === undefined ? 8 : leftPriority;
    rightPriority = rightPriority === undefined ? 8 : rightPriority;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    var leftCustomer = scope.customerNameById[left.customerId] || '（顧客不明）';
    var rightCustomer = scope.customerNameById[right.customerId] || '（顧客不明）';
    var customerOrder = String(leftCustomer).localeCompare(String(rightCustomer), 'ja');
    if (customerOrder) return customerOrder;
    var leftStarted = menuDateMilliseconds_(left.startedAt);
    var rightStarted = menuDateMilliseconds_(right.startedAt);
    if (!isFinite(leftStarted)) leftStarted = -Infinity;
    if (!isFinite(rightStarted)) rightStarted = -Infinity;
    if (leftStarted !== rightStarted) return rightStarted - leftStarted;
    return String(left.fileName || '').localeCompare(String(right.fileName || ''), 'ja');
  });
  var stateCounts = {};
  Object.keys(MENU_FILE_STATE_LABELS_).forEach(function(state) { stateCounts[state] = 0; });
  files.forEach(function(file) {
    if (stateCounts[file.state] !== undefined) stateCounts[file.state] += 1;
  });
  var summaryOrder = ['FAILED', 'CUSTOMER_FIX_REQUIRED', 'VALIDATING', 'WRITING',
    'REVIEW_WAIT', 'DISCOVERED', 'COMPLETED', 'CANCELED', 'EXCLUDED'];
  var summaryParts = summaryOrder.map(function(state) {
    return menuFileStateLabel_(state) + ' ' + stateCounts[state];
  });
  var omitted = Math.max(0, files.length - 300);
  var rows = files.slice(0, 300).map(function(file) {
    var stuck = (file.state === 'VALIDATING' || file.state === 'WRITING') &&
      (!file.lease || file.lease.stalled);
    var lease = '-';
    if (file.lease) {
      lease = menuLeasePurposeLabel_(file.lease.purpose) + ' 心拍から ' +
        describeAge_(file.lease.lastHeartbeat, now) + (file.lease.stalled ? '（停滞）' : '');
    }
    return [
      menuFileStateLabel_(file.state) + (stuck ? '（停止の疑い）' : ''),
      String(file.fileName || '').replace(removableStatePrefixRegex_(), ''),
      scope.customerNameById[file.customerId] || '（顧客不明）',
      file.formatId || '-',
      '読取 ' + Number(file.readCount || 0) + ' / 自動 ' + Number(file.autoCount || 0) +
        ' / 要確認 ' + Number(file.reviewCount || 0) + ' / 除外 ' +
        Number(file.excludedCount || 0) + ' / エラー ' + Number(file.errorCount || 0),
      formatMenuTimestamp_(file.startedAt),
      formatMenuTimestamp_(file.endedAt),
      lease,
      file.lastError || '-'
    ];
  });
  return {
    summaryLine: 'ファイル 合計 ' + files.length + ': ' + summaryParts.join('、'),
    columns: ['状態', 'ファイル名', '顧客', '形式', '件数', '開始', '終了', 'リース', '最後のエラー'],
    rows: rows,
    omitted: omitted
  };
}

function buildReviewRows_(reviews, scope, now) {
  var filtered = filterByScope_(reviews || [], scope).slice();
  filtered.sort(function(left, right) {
    var timeOrder = menuDateMilliseconds_(left.registeredAt) - menuDateMilliseconds_(right.registeredAt);
    if (isFinite(timeOrder) && timeOrder) return timeOrder;
    return String(left.reviewId || '').localeCompare(String(right.reviewId || ''), 'en');
  });
  var counts = menuCountBy_(filtered, 'reviewType', MENU_REVIEW_TYPE_LABELS_);
  var omitted = Math.max(0, filtered.length - 200);
  var rows = filtered.slice(0, 200).map(function(review) {
    var date = formatMenuTimestamp_(review.originalDate);
    return [
      menuReviewTypeLabel_(review.reviewType),
      MENU_REVIEW_HANDLER_LABELS_[review.reviewType] || 'システム管理者',
      review.status === 'OPEN' ? '未着手' : review.status === 'IN_PROGRESS' ? '対応中' : review.status,
      review.customerName || scope.customerNameById[review.customerId] || '（顧客不明）',
      review.fileNameOriginal || '-',
      review.merchantOriginal || '-',
      (date === '-' ? '-' : date.slice(0, 10)) + ' / ' +
        (review.originalAmount === '' || review.originalAmount === null ||
          review.originalAmount === undefined ? '-' : String(review.originalAmount)),
      formatMenuTimestamp_(review.registeredAt)
    ];
  });
  return {
    summaryLine: '未解決 ' + filtered.length + ' 件' +
      (counts.length ? '（' + counts.join('、') + '）' : ''),
    columns: ['種別', '担当', '状態', '顧客', 'ファイル名', '店名（元表記）', '利用日 / 金額', '登録'],
    rows: rows,
    omitted: omitted
  };
}

function buildLeaseRows_(leases, scope, now) {
  var filtered = filterByScope_(leases || [], scope).slice();
  filtered.sort(function(left, right) { return Number(right.ageSeconds) - Number(left.ageSeconds); });
  var omitted = Math.max(0, filtered.length - 100);
  return {
    columns: ['ファイル名', '顧客', '内部状態', '用途', '所有者', '心拍から', '検出', '解放', 'ファイルID'],
    rows: filtered.slice(0, 100).map(function(lease) {
      return [
        lease.fileName || '(不明)',
        scope.customerNameById[lease.customerId] || '（顧客不明）',
        menuFileStateLabel_(lease.fileState),
        menuLeasePurposeLabel_(lease.purpose),
        lease.owner || '-',
        describeAge_(lease.lastHeartbeat, now),
        lease.detectable ? '可' : '不可',
        lease.releasable ? '可' : '不可',
        lease.fileId
      ];
    }),
    omitted: omitted
  };
}

function buildSettingsCheckText_(result, loaded) {
  var problems = {};
  (result.problems || []).forEach(function(problem) { problems[problem.check] = problem.detail; });
  var lines = ['設定検査（scope = IMPORT）: ' + (result.ok ? '合格' : '不合格')];
  settingsChecksFor(VALIDATION_SCOPE.IMPORT).forEach(function(check) {
    lines.push('  #' + check.id + ' ' + check.name + ': ' +
      (problems[check.id] ? 'NG ── ' + problems[check.id] : 'OK'));
  });
  lines.push('Script Properties から読み込んだ設定: ' + (loaded.loaded || []).length +
    ' 件（無視した不明キー: ' + (loaded.ignored || []).length + ' 件）');
  return lines.join('\n');
}

function buildTaggedTransactionRows_(records, scope, tag) {
  var filtered = filterByScope_(records || [], scope);
  var omitted = Math.max(0, filtered.length - 200);
  return {
    summaryLine: 'タグ「' + tag + '」: ' + filtered.length + ' 件',
    columns: ['店名', '顧客', 'メモタグ', '税区分 予定', '税区分 確認', '転記行', '取引ID'],
    rows: filtered.slice(0, 200).map(function(record) {
      return [String(record.merchant || '').slice(0, 28),
        scope.customerNameById[record.customerId] || '（顧客不明）',
        record.memo || '-', record.taxPlanned || '-', record.taxVerified || '-',
        record.destinationRow || '-', String(record.fullTxId || '').slice(0, 12)];
    }),
    omitted: omitted
  };
}

function buildBackfillRows_(detail, scope) {
  var filtered = filterByScope_(detail || [], scope);
  var omitted = Math.max(0, filtered.length - 100);
  return {
    summaryLine: '取り込み直しが必要なファイル: ' + filtered.length + ' 件',
    columns: ['ファイル名', '顧客', '内部状態', '提出時ハッシュ', '遅れている取引数', '例'],
    rows: filtered.slice(0, 100).map(function(file) {
      return [file.fileName || '(不明)',
        scope.customerNameById[file.customerId] || '（顧客不明）',
        menuFileStateLabel_(file.state), file.contentHash || 'なし',
        (file.stale || []).length, (file.stale || []).slice(0, 2).join('\n')];
    }),
    omitted: omitted
  };
}

function renderMenuTable_(headerLines, columns, rows, footerLines, links) {
  var html = '<!DOCTYPE html><html><head><base target="_blank"><style>' +
    'table {border-collapse: collapse; font-size: 13px}' +
    'th, td {border: 1px solid #ccc; padding: 2px 6px; vertical-align: top}' +
    'th {background: #f3f3f3; position: sticky; top: 0}' +
    'body {font-family: sans-serif} .line {margin: 2px 0} button {margin-top: 12px}' +
    '</style></head><body>';
  (headerLines || []).forEach(function(line) {
    html += '<div class="line">' + escapeHtml_(line) + '</div>';
  });
  if ((columns || []).length) {
    html += '<table><thead><tr>';
    columns.forEach(function(column) { html += '<th>' + escapeHtml_(column) + '</th>'; });
    html += '</tr></thead><tbody>';
    (rows || []).forEach(function(row) {
      html += '<tr>';
      row.forEach(function(cell) {
        html += '<td>' + escapeHtml_(cell).replace(/\n/g, '<br>') + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
  }
  (footerLines || []).forEach(function(line) {
    html += '<div class="line">' + escapeHtml_(line) + '</div>';
  });
  (links || []).forEach(function(link) {
    html += '<div class="line"><a href="' + escapeHtml_(link.url) +
      '" target="_blank" rel="noopener">' + escapeHtml_(link.label) + '</a></div>';
  });
  html += '<button onclick="google.script.host.close()">閉じる</button></body></html>';
  return html;
}

function escapeHtml_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMenuTimestamp_(value) {
  if (value === '' || value === null || value === undefined) return '-';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return toIso8601(value).slice(0, 16).replace('T', ' ');
  }
  if (typeof value === 'number') {
    return toIso8601(excelSerialToDate(value)).slice(0, 16).replace('T', ' ');
  }
  if (typeof value === 'string') return value.slice(0, 16).replace('T', ' ');
  return String(value);
}

function describeAge_(fromValue, now) {
  var from = menuDateMilliseconds_(fromValue);
  var current = menuDateMilliseconds_(now);
  if (!isFinite(from) || !isFinite(current)) return '(不明)';
  var seconds = Math.floor((current - from) / 1000);
  if (seconds < 60) return 'たった今';
  if (seconds < 60 * 60) return Math.floor(seconds / 60) + '分前';
  if (seconds < 48 * 60 * 60) return Math.floor(seconds / 3600) + '時間前';
  return Math.floor(seconds / (24 * 3600)) + '日前';
}

function menuDateMilliseconds_(value) {
  if (value === '' || value === null || value === undefined) return NaN;
  if (Object.prototype.toString.call(value) === '[object Date]') return value.getTime();
  if (typeof value === 'number') return excelSerialToDate(value).getTime();
  return new Date(String(value)).getTime();
}

function filterByScope_(items, scope) {
  return (items || []).filter(function(item) {
    var customerId = String(item.customerId || '');
    if (!customerId) return scope.isOwner;
    return scope.customerIds.indexOf(customerId) >= 0;
  });
}

function classifyMenuError_(error) {
  var message = String(error && error.message || error || '');
  if (error instanceof AuthorizationError) {
    return {title: 'エラー', lines: [error.detail || message]};
  }
  if (error && error.code === 'CUSTOMER_MASTER_INVALID' &&
      message.indexOf('MASTER_SPREADSHEET_ID') >= 0) {
    return {title: 'エラー', lines: [
      'マスタースプレッドシートが設定されていません。管理者が Script Properties の MASTER_SPREADSHEET_ID を設定してください。'
    ]};
  }
  if (error && error.code === 'CUSTOMER_MASTER_INVALID') {
    return {title: 'エラー', lines: [
      '顧客マスターの内容に不備があります: ' + message +
      '。管理者へ連絡してください（対象年度の未設定などは顧客マスターの是正が必要です）。'
    ]};
  }
  var missing = /Required sheet not found: (.+)/.exec(message);
  if (missing) {
    return {title: 'エラー', lines: [
      'マスタースプレッドシートに必要なシート「' + missing[1] + '」がありません。管理者へ連絡してください。'
    ]};
  }
  if (error instanceof ReferenceError && message.indexOf('Sheets is not defined') >= 0) {
    return {title: 'エラー', lines: [
      'Sheets API サービスが有効になっていません（appsscript.json の enabledAdvancedServices）。管理者へ連絡してください。'
    ]};
  }
  if ((error && Number(error.code) === 429) || /Quota exceeded/i.test(message)) {
    return {title: 'エラー', lines: [
      '読取の割当（1分あたりの上限）を超えました。1分ほど待ってから再実行してください。'
    ]};
  }
  if (/Cannot call SpreadsheetApp\.getUi/.test(message)) {
    return {title: 'エラー', lines: [], rethrow: true};
  }
  var lines = ['エラー: ' + String(error && error.name || 'Error') + ': ' + message];
  if (error && error.code) lines.push('コード: ' + error.code);
  lines.push('管理者へ連絡してください。詳細は Apps Script の実行ログにあります。');
  return {title: 'エラー', lines: lines};
}

function menuBindingLines_() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  return [
    'このスプレッドシート: ' + (active ? active.getId() : '(なし)'),
    'マスター: ' + (resolveMasterSpreadsheetId_() || '(未設定。アクティブなスプレッドシートを使用)')
  ];
}

function menuFileStateLabel_(state) {
  var code = String(state || '(不明)');
  return MENU_FILE_STATE_LABELS_[code] ? MENU_FILE_STATE_LABELS_[code] + ' (' + code + ')' : code;
}

function menuReviewTypeLabel_(type) {
  var code = String(type || '(不明)');
  return MENU_REVIEW_TYPE_LABELS_[code] ? MENU_REVIEW_TYPE_LABELS_[code] + ' (' + code + ')' : code;
}

function menuLeasePurposeLabel_(purpose) {
  var code = String(purpose || '(不明)');
  return MENU_LEASE_PURPOSE_LABELS_[code] ? MENU_LEASE_PURPOSE_LABELS_[code] + ' (' + code + ')' : code;
}

function menuCountBy_(items, property, labels) {
  var counts = {};
  (items || []).forEach(function(item) {
    var key = String(item[property] || '');
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.keys(counts).sort(function(left, right) {
    return counts[right] - counts[left] || String(labels[left] || left).localeCompare(String(labels[right] || right), 'ja');
  }).map(function(key) { return String(labels[key] || key) + ' ' + counts[key]; });
}

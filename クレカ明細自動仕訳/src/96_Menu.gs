'use strict';

/**
 * 設計 §4.2 `01_Menu.gs` の参照系部分。
 * 操作系は次段階で追加し、閲覧範囲は `03_Authorization.gs` の認可で決める。
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

var MENU_REVIEW_STATUS_LABELS_ = {
  OPEN: '未対応',
  IN_PROGRESS: '対応中',
  RESOLVED: '解決済み',
  EXCLUDED: '対象外',
  NOT_FOUND: '見つかりません'
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

// 実機の往復単価を受入12で測るまでは、安全側の計測値と1件上限を使う。
var MENU_RESOLVE_LIST_LIMIT_ = 15;
var MENU_RESOLVE_DEADLINE_MS_ = 300000;
var MENU_RESOLVE_TRIP_WORST_MS_ = 1600;
var MENU_RESOLVE_ITEM_TRIPS_ = 60;
var MENU_RESOLVE_CLEANUP_TRIPS_ = 62;
var MENU_RESOLVE_MAX_PER_ACTION_ = 1;
var MENU_RESOLVE_MAX_ORPHAN_COMMITS_ = 2;

var MENU_RESOLVE_OPERATIONS_ = {
  ADOPT_EXISTING_PARTNER: {label: '既存の取引先名を採用する', kinds: ['PARTNER'], unit: 'GROUP', extras: ['partnerName'], rewind: false, clearsRow: false, requiresNoLiveTransactions: false},
  RESOLVE_WITHOUT_PARTNER: {label: '取引先なしで確定する', kinds: ['PARTNER'], unit: 'GROUP', extras: [], rewind: false, clearsRow: false, requiresNoLiveTransactions: false},
  FIX_DATE_AMOUNT: {label: '日付・金額を修正して確定する', kinds: ['DATE', 'AMOUNT'], unit: 'SINGLE', extras: ['correctedDate', 'correctedAmount'], rewind: false, clearsRow: false, requiresNoLiveTransactions: false},
  POST_ZERO_AMOUNT: {label: '0 円取引として計上する', kinds: ['ZERO_AMOUNT'], unit: 'SINGLE', extras: [], rewind: false, clearsRow: false, requiresNoLiveTransactions: false},
  EXCLUDE: {label: '対象外にする（転記行を空にします）', kinds: ['PARTNER', 'DATE', 'AMOUNT', 'ZERO_AMOUNT'], unit: 'SINGLE', extras: ['reviewId'], rewind: false, clearsRow: true, requiresNoLiveTransactions: false},
  POST_PRIOR_YEAR: {label: '前年の利用分として計上する', kinds: ['PRIOR_YEAR'], unit: 'SINGLE', extras: [], rewind: false, clearsRow: false, requiresNoLiveTransactions: false},
  EXCLUDE_PRIOR_YEAR: {label: '前年の利用分として対象外にする（転記行を空にします）', kinds: ['PRIOR_YEAR'], unit: 'SINGLE', extras: [], rewind: false, clearsRow: true, requiresNoLiveTransactions: false},
  CONFIRM_EMPTY_FILE: {label: '0 件で正しいと確認して完了にする', kinds: ['EMPTY_FILE'], unit: 'FILE', extras: [], rewind: false, clearsRow: false, requiresNoLiveTransactions: false},
  APPROVE_COUNT_MISMATCH: {label: '件数・合計の不一致を承認して再検査する', kinds: ['COUNT_TOTAL_MISMATCH'], unit: 'FILE', extras: [], rewind: true, clearsRow: false, requiresNoLiveTransactions: false},
  REJECT_COUNT_MISMATCH: {label: '顧客に差し戻す（要修正にする）', kinds: ['COUNT_TOTAL_MISMATCH'], unit: 'FILE', extras: [], rewind: false, clearsRow: false, requiresNoLiveTransactions: false},
  KEEP_ORIGINAL_RESULT: {label: '元の処理結果を維持する（この新しいファイルは対象外にする）', kinds: ['DUPLICATE'], unit: 'FILE', extras: [], rewind: false, clearsRow: false, requiresNoLiveTransactions: false},
  RESIZE_INPUT: {label: '顧客にファイル分割を依頼する（要修正にする）', kinds: ['INPUT_LIMIT'], unit: 'FILE', extras: [], rewind: false, clearsRow: false, requiresNoLiveTransactions: false},
  APPROVE_SCAN_TRUNCATION: {label: '読取の打切りを承認して再検査する', kinds: ['SCAN_TRUNCATED'], unit: 'FILE', extras: [], rewind: true, clearsRow: false, requiresNoLiveTransactions: false},
  REGISTER_FORMAT: {label: '登録済みの形式で再検査する', kinds: ['FORMAT_UNKNOWN', 'FORMAT_AMBIGUOUS', 'MULTI_SHEET', 'SCAN_TRUNCATED'], unit: 'FILE', extras: [], rewind: true, clearsRow: false, requiresNoLiveTransactions: false},
  CONFIRM_DESTINATION_FIXED: {label: '転記先の是正が済んだので再検査する', kinds: ['DESTINATION_FIX'], unit: 'FILE', extras: [], rewind: true, clearsRow: false, requiresNoLiveTransactions: false},
  CANCEL_FILE: {label: 'このファイルを取り消す（【取消済】にする）', kinds: ['FORMAT_UNKNOWN', 'FORMAT_AMBIGUOUS', 'MULTI_SHEET', 'DUPLICATE', 'COUNT_TOTAL_MISMATCH', 'EMPTY_FILE', 'INPUT_LIMIT', 'DESTINATION_FIX', 'SCAN_TRUNCATED'], unit: 'FILE', extras: [], rewind: false, clearsRow: false, requiresNoLiveTransactions: true}
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
    .addItem('要確認を確定', 'menuResolveReview')
    .addItem('要修正ファイルを再検査', 'menuRecheck')
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
      scope = menuViewerScope_(actionName);
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
    var customerRoles = scope.customers.map(function(customer) {
      return String(customer.customerName || '（顧客不明）') + '(' + customer.customerId + ')=' +
        roleLabel(scope.rolesByCustomerId[customer.customerId]);
    }).join('、');
    var text = menuHeaderLines_(scope, now).join('\n') + '\n\n' +
      '実行者: ' + scope.email + '（オーナー: ' + (scope.isOwner ? 'はい' : 'いいえ') + '）\n' +
      '役割: ' + roleLabel(scope.role) + '\n' +
      '顧客ごとの役割: ' + customerRoles + '\n' +
      'マスターのオーナー: ' + (scope.ownerEmail || '(取得不能)') + '\n' +
      '閲覧できる顧客: ' + customers + '\n' +
      'マスタースプレッドシート: ' + (configuredMasterId || '(未設定。アクティブなスプレッドシートを使用)') + '\n' +
      'このスプレッドシート: ' + (activeId || '(なし)') + '\n' +
      '両者の関係: ' + (activeId && activeId === master.getId() ? '一致' : '不一致') + '\n' +
      'コード版: ' + VERSIONS.CODE + '\n' +
      'このメニューから、要確認の確定と要修正ファイルの再検査を実行できます。' +
      '取込の開始・取消し・復元・形式登録・freee取込済み登録は含みません。';
    presentMenuResult_(ui, {kind: 'alert', title: actionName, text: text});
  } catch (error) {
    presentMenuError_(ui, actionName, error, []);
  }
}

function menuResolveReview() {
  runMenuAction_('要確認を確定', function(scope, now) {
    var ui = menuUi_();
    var startedAt = Date.now();
    var maxPerAction = MENU_RESOLVE_MAX_PER_ACTION_;
    var built = buildResolveTargets_(openReviews({}), scope);
    if (!built.items.length) {
      var noTargets = menuHeaderLines_(scope, now).concat(['', '画面から確定できる要確認はありません。']);
      if (built.unsupported.integrity || built.unsupported.fileChanged || built.unsupported.noCustomer) {
        noTargets.push(menuUnsupportedReviewLine_(built.unsupported));
      }
      return {kind: 'alert', title: '要確認を確定', text: noTargets.join('\n')};
    }

    var targetResponse = ui.prompt('クレカ自動処理 ― 要確認を確定',
      renderResolveTargetPrompt_(built, scope, now), ui.ButtonSet.OK_CANCEL);
    if (targetResponse.getSelectedButton() !== ui.Button.OK) return {kind: 'none'};
    var targetNumber = parseMenuSelection_(targetResponse.getResponseText(), built.items.length);
    if (targetNumber === null) {
      return menuAlertResult_('要確認を確定', menuHeaderLines_(scope, now),
        '番号が正しくありません: ' + targetResponse.getResponseText() + '。1〜' + built.items.length + ' の数字を入力してください。');
    }

    var item = built.items[targetNumber - 1];
    var lastReviewStatus = 'NOT_FOUND';
    while (item.reviews.length) {
      var current = getReviewById(item.reviews[0].reviewId);
      if (current && (current.status === 'OPEN' || current.status === 'IN_PROGRESS')) {
        item.reviews[0] = current;
        break;
      }
      lastReviewStatus = current ? current.status : 'NOT_FOUND';
      if (item.kind !== 'PARTNER_GROUP') {
        return menuStateChangedResult_(scope, now, lastReviewStatus, null, menuReviewStatusLabel_);
      }
      item.reviews.shift();
    }
    if (!item.reviews.length) return menuStateChangedResult_(scope, now, lastReviewStatus, null, menuReviewStatusLabel_);

    var firstReview = item.reviews[0];
    var currentLive;
    if (item.kind === 'FILE') {
      currentLive = {liveTransactionCount: getTransactionsByStatus(firstReview.fileId,
        [TX_STATUS.PREPARED, TX_STATUS.WRITING, TX_STATUS.COMMITTED, TX_STATUS.REVIEW_REQUIRED]).length};
    } else {
      currentLive = getTransaction(firstReview.fullTxId);
      if (!currentLive) {
        return menuAlertResult_('要確認を確定', menuHeaderLines_(scope, now),
          '取引ログに対応する取引がありません（' + firstReview.fullTxId + '）。管理者へ連絡してください。');
      }
    }

    var optionRows = resolveOptionsFor_(item, scope.rolesByCustomerId[item.customerId], currentLive);
    var optionResponse = ui.prompt('クレカ自動処理 ― 要確認を確定：操作',
      renderResolveOptionPrompt_(item, optionRows, {live: currentLive, maxPerAction: maxPerAction}, scope, now),
      ui.ButtonSet.OK_CANCEL);
    if (optionResponse.getSelectedButton() !== ui.Button.OK) return {kind: 'none'};
    var optionNumber = parseMenuSelection_(optionResponse.getResponseText(), optionRows.length);
    if (optionNumber === null) {
      return menuAlertResult_('要確認を確定', menuHeaderLines_(scope, now),
        '番号が正しくありません: ' + optionResponse.getResponseText() + '。1〜' + optionRows.length + ' の数字を入力してください。');
    }
    var selectedOption = optionRows[optionNumber - 1];
    if (!selectedOption.enabled) {
      return menuAlertResult_('要確認を確定', menuHeaderLines_(scope, now),
        'この操作は選べません: ' + selectedOption.disabledReason);
    }

    var inputs = {reviewId: firstReview.reviewId};
    var extras = {live: currentLive, partnerKnown: null, maxPerAction: maxPerAction};
    var code = selectedOption.code;
    if (code === 'ADOPT_EXISTING_PARTNER') {
      var candidates = menuReviewCandidates_(firstReview);
      var partnerPromptLines = menuHeaderLines_(scope, now).concat(['',
        '候補の番号または取引先名を入力してください。']);
      if (candidates.length) partnerPromptLines.push('候補: ' + menuPartnerCandidatesText_(candidates));
      var partnerResponse = ui.prompt('クレカ自動処理 ― 要確認を確定：取引先名',
        partnerPromptLines.join('\n'),
        ui.ButtonSet.OK_CANCEL);
      if (partnerResponse.getSelectedButton() !== ui.Button.OK) return {kind: 'none'};
      var partnerText = String(partnerResponse.getResponseText() || '').trim();
      var candidateNumber = parseMenuSelection_(partnerText, candidates.length);
      inputs.partnerName = candidateNumber === null ? partnerText : candidates[candidateNumber - 1].partnerName;
      if (!inputs.partnerName) {
        return menuAlertResult_('要確認を確定', menuHeaderLines_(scope, now), '取引先名を入力してください。');
      }
      var customer = getCustomerById(item.customerId);
      var known = null;
      try {
        known = knownPartnerNames_(customer);
      } catch (ignored) {
        // 一覧を読めなかったことを「未登録」と表示すると、新規登録されるという誤案内になる。
        known = null;
      }
      extras.partnerKnown = known === null ? null : !!known[inputs.partnerName];
    } else if (code === 'FIX_DATE_AMOUNT') {
      var dateResponse = ui.prompt('クレカ自動処理 ― 要確認を確定：修正日付',
        menuHeaderLines_(scope, now).concat(['',
          '修正日付を入力してください（例: 2026-01-05）。変えない場合は空欄。']).join('\n'),
        ui.ButtonSet.OK_CANCEL);
      if (dateResponse.getSelectedButton() !== ui.Button.OK) return {kind: 'none'};
      var amountResponse = ui.prompt('クレカ自動処理 ― 要確認を確定：修正金額',
        menuHeaderLines_(scope, now).concat(['',
          '修正金額を整数で入力してください。変えない場合は空欄。']).join('\n'),
        ui.ButtonSet.OK_CANCEL);
      if (amountResponse.getSelectedButton() !== ui.Button.OK) return {kind: 'none'};
      inputs.correctedDate = parseCorrectedDate_(dateResponse.getResponseText(), now);
      inputs.correctedAmount = parseCorrectedAmount_(amountResponse.getResponseText());
      if (inputs.correctedDate === null) {
        return menuAlertResult_('要確認を確定', menuHeaderLines_(scope, now),
          '日付の形式が正しくありません: ' + dateResponse.getResponseText() + '。例: 2026-01-05');
      }
      if (inputs.correctedAmount === null) {
        return menuAlertResult_('要確認を確定', menuHeaderLines_(scope, now),
          '金額は整数で入力してください: ' + amountResponse.getResponseText());
      }
      if (item.reviewType === 'DATE' && inputs.correctedDate === '') {
        return menuAlertResult_('要確認を確定', menuHeaderLines_(scope, now), '日付を入力してください。');
      }
      if (item.reviewType === 'AMOUNT' && inputs.correctedAmount === '') {
        return menuAlertResult_('要確認を確定', menuHeaderLines_(scope, now), '金額を入力してください。');
      }
    } else if (code === 'EXCLUDE' && item.kind === 'PARTNER_GROUP') {
      var excludeLines = item.reviews.slice(0, MENU_RESOLVE_LIST_LIMIT_).map(function(review, index) {
        return ' ' + (index + 1) + ') ' + menuReviewSingleIdentity_(review, null);
      });
      var excludeResponse = ui.prompt('クレカ自動処理 ― 要確認を確定：対象外にする取引',
        menuHeaderLines_(scope, now).concat(['', '対象外にする取引の番号を入力してください。']).concat(excludeLines).join('\n'),
        ui.ButtonSet.OK_CANCEL);
      if (excludeResponse.getSelectedButton() !== ui.Button.OK) return {kind: 'none'};
      var excludeNumber = parseMenuSelection_(excludeResponse.getResponseText(), excludeLines.length);
      if (excludeNumber === null) {
        return menuAlertResult_('要確認を確定', menuHeaderLines_(scope, now),
          '番号が正しくありません: ' + excludeResponse.getResponseText() + '。1〜' + excludeLines.length + ' の数字を入力してください。');
      }
      var excludeReview = item.reviews[excludeNumber - 1];
      var excludeLive = getTransaction(excludeReview.fullTxId);
      if (!excludeLive) {
        return menuAlertResult_('要確認を確定', menuHeaderLines_(scope, now),
          '取引ログに対応する取引がありません（' + excludeReview.fullTxId + '）。管理者へ連絡してください。');
      }
      var checked = resolveOptionsFor_(item, scope.rolesByCustomerId[item.customerId], excludeLive).filter(function(option) {
        return option.code === 'EXCLUDE';
      })[0];
      if (!checked || !checked.enabled) {
        return menuAlertResult_('要確認を確定', menuHeaderLines_(scope, now),
          'この操作は選べません: ' + (checked ? checked.disabledReason : '一覧を開き直してください。'));
      }
      inputs.reviewId = excludeReview.reviewId;
      extras.live = excludeLive;
    }

    var confirmation = buildResolveConfirmationText_(item, code, inputs, extras, scope, now);
    if (ui.alert('クレカ自動処理 ― 要確認を確定：確認', confirmation,
        ui.ButtonSet.YES_NO) !== ui.Button.YES) return {kind: 'none'};
    var outcome = applyResolveDecision_(item, code, inputs, {startedAt: startedAt, maxPerAction: maxPerAction});
    return {kind: 'alert', title: '要確認を確定',
      text: buildResolveResultText_(item, code, inputs, outcome, scope, new Date())};
  }, {verb: '実行'});
}

function menuRecheck() {
  runMenuAction_('要修正ファイルを再検査', function(scope, now) {
    var ui = menuUi_();
    var built = buildRecheckTargets_(collectImportStatus_({now: now}), scope);
    if (!built.items.length) {
      return menuAlertResult_('要修正ファイルを再検査', menuHeaderLines_(scope, now), '要修正のファイルはありません。');
    }
    var response = ui.prompt('クレカ自動処理 ― 要修正ファイルを再検査',
      renderRecheckPrompt_(built, scope, now), ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return {kind: 'none'};
    var selected = parseMenuSelection_(response.getResponseText(), built.items.length);
    if (selected === null) {
      return menuAlertResult_('要修正ファイルを再検査', menuHeaderLines_(scope, now),
        '番号が正しくありません: ' + response.getResponseText() + '。1〜' + built.items.length + ' の数字を入力してください。');
    }
    var file = built.items[selected - 1];
    var state = getFileState(file.fileId);
    if (state !== FILE_STATE.CUSTOMER_FIX_REQUIRED) {
      return menuStateChangedResult_(scope, now, state, '要修正ファイルを再検査');
    }
    if (ui.alert('クレカ自動処理 ― 要修正ファイルを再検査：確認',
        buildRecheckConfirmationText_(file, scope, now), ui.ButtonSet.YES_NO) !== ui.Button.YES) return {kind: 'none'};
    try {
      var result = applyRecheck_(file, {});
      return menuAlertResult_('要修正ファイルを再検査', menuHeaderLines_(scope, new Date()),
        menuDisplayFileName_(file) + ' を' + menuFileStateLabel_(result.fileState) + ' に戻しました。' +
        'Drive 上のファイル名は次の取込で【要修正】が外れます（正本は内部状態です）。');
    } catch (error) {
      if (error instanceof StateTransitionError && error.detail &&
          String(error.detail).indexOf('状態が変わっています') === 0) {
        return menuAlertResult_('要修正ファイルを再検査', menuHeaderLines_(scope, new Date()), error.detail);
      }
      throw error;
    }
  }, {verb: '実行'});
}

function menuAlertResult_(title, header, message) {
  return {kind: 'alert', title: title, text: (header || []).concat(['', message]).join('\n')};
}

function menuStateChangedResult_(scope, now, state, title, labeler) {
  labeler = labeler || menuFileStateLabel_;
  return menuAlertResult_(title || '要確認を確定', menuHeaderLines_(scope, now),
    '状態が変わっています（現在: ' + labeler(state) + '）。一覧を開き直してください。');
}

function buildResolveTargets_(reviews, scope) {
  var unsupported = {integrity: 0, fileChanged: 0, noCustomer: 0};
  var eligible = [];
  (reviews || []).forEach(function(review) {
    var customerId = String(review.customerId || '');
    var visible = scope.isOwner || (!!customerId && scope.customerIds.indexOf(customerId) >= 0);
    if (review.reviewType === 'INTEGRITY') {
      if (!customerId || visible) unsupported.integrity += 1;
      return;
    }
    if (review.reviewType === 'FILE_CHANGED') {
      if (!customerId || visible) unsupported.fileChanged += 1;
      return;
    }
    if (!customerId) {
      unsupported.noCustomer += 1;
      return;
    }
    if (visible) eligible.push(review);
  });

  var groups = Object.create(null);
  var items = [];
  eligible.forEach(function(review) {
    if (review.reviewType !== 'PARTNER') {
      items.push(menuResolveItem_(isTransactionScopedReviewType(review.reviewType) ? 'TRANSACTION' : 'FILE', [review]));
      return;
    }
    var normalized = normalizeMerchant(review.merchantOriginal);
    // 空店名をまとめると無関係な行のF列へ同じ名前が広がるため、要確認IDで分離する。
    var key = String(review.customerId) + '\u0000' +
      (normalized ? 'MERCHANT\u0000' + normalized : 'EMPTY\u0000' + review.reviewId);
    if (!groups[key]) groups[key] = [];
    groups[key].push(review);
  });
  Object.keys(groups).forEach(function(key) { items.push(menuResolveItem_('PARTNER_GROUP', groups[key])); });
  items.sort(function(left, right) {
    var leftClass = left.kind === 'PARTNER_GROUP' ? 0 : left.kind === 'TRANSACTION' ? 1 : 2;
    var rightClass = right.kind === 'PARTNER_GROUP' ? 0 : right.kind === 'TRANSACTION' ? 1 : 2;
    if (leftClass !== rightClass) return leftClass - rightClass;
    if (leftClass === 0 && left.reviews.length !== right.reviews.length) return right.reviews.length - left.reviews.length;
    return menuDateMilliseconds_(left.reviews[0].registeredAt) - menuDateMilliseconds_(right.reviews[0].registeredAt);
  });
  var omitted = Math.max(0, items.length - MENU_RESOLVE_LIST_LIMIT_);
  return {items: items.slice(0, MENU_RESOLVE_LIST_LIMIT_), omitted: omitted, unsupported: unsupported};
}

function menuResolveItem_(kind, reviews) {
  reviews = reviews.slice().sort(function(a, b) {
    return menuDateMilliseconds_(a.registeredAt) - menuDateMilliseconds_(b.registeredAt);
  });
  var first = reviews[0];
  var merchantOriginal = normalizeMerchant(first.merchantOriginal) ? first.merchantOriginal : '（店名なし）';
  return {kind: kind, reviewType: first.reviewType, customerId: first.customerId,
    customerName: first.customerName, merchantOriginal: merchantOriginal, reviews: reviews};
}

function renderResolveTargetPrompt_(built, scope, now) {
  var lines = menuHeaderLines_(scope, now).concat(['',
    '確定する対象の番号を入力してください（1〜' + built.items.length + '）。取り消すときは「キャンセル」。']);
  built.items.forEach(function(item, index) {
    var review = item.reviews[0];
    var parts = [(index + 1) + ') ' + (MENU_REVIEW_TYPE_LABELS_[item.reviewType] || item.reviewType),
      item.customerName || '（顧客不明）'];
    if (item.kind === 'PARTNER_GROUP') {
      parts.push(menuShortText_(item.merchantOriginal, 24));
      parts.push(item.reviews.length + ' 件');
      parts.push('例: ' + menuReviewSingleIdentity_(review, null));
    } else if (item.kind === 'TRANSACTION') {
      parts.push(menuReviewStoredIdentity_(review));
    } else {
      parts.push(menuShortText_(review.fileNameOriginal, 24));
    }
    lines.push(' ' + parts.join(' | '));
  });
  if (built.omitted) lines.push('（他 ' + built.omitted + ' 件は表示していません。表示分を片付けると出てきます）');
  if (built.unsupported.integrity || built.unsupported.fileChanged || built.unsupported.noCustomer) {
    lines.push(menuUnsupportedReviewLine_(built.unsupported));
  }
  return lines.join('\n');
}

function menuUnsupportedReviewLine_(unsupported) {
  return '画面から確定できない要確認: 整合性 ' + unsupported.integrity + ' 件、ファイル変更 ' +
    unsupported.fileChanged + ' 件、顧客 ID なし ' + unsupported.noCustomer + ' 件（管理者へ）';
}

function parseMenuSelection_(text, max) {
  var normalized = String(text === null || text === undefined ? '' : text).trim()
    .replace(/[０-９]/g, function(character) { return String.fromCharCode(character.charCodeAt(0) - 0xFEE0); });
  if (!/^\d+$/.test(normalized)) return null;
  var value = Number(normalized);
  return value >= 1 && value <= Number(max) ? value : null;
}

function resolveOptionsFor_(item, roleForCustomer, live) {
  var source = item.kind === 'FILE' ? availableFileResolveOperations(item.reviewType) :
    availableResolveOperations(item.reviewType);
  return source.filter(function(code) {
    var definition = MENU_RESOLVE_OPERATIONS_[code];
    return definition && definition.kinds.indexOf(item.reviewType) >= 0;
  }).map(function(code) {
    var definition = MENU_RESOLVE_OPERATIONS_[code];
    var disabledReason = null;
    var authOptions = menuOperationAuthOptions_(code);
    if (!hasRole(roleForCustomer, requiredRoleForOperation_(code, authOptions))) {
      disabledReason = '（システム管理者のみ）';
    } else if ((code === 'EXCLUDE' || code === 'EXCLUDE_PRIOR_YEAR') && live &&
        (live.freeeStatus === FREEE_IMPORT_STATUS.IMPORTED || live.freeeStatus === FREEE_IMPORT_STATUS.NEEDS_FREEE_FIX)) {
      disabledReason = '（freee取込済みのため画面から不可。管理者へ）';
    } else if (definition.unit !== 'FILE' && live && live.transactionStatus &&
        [TX_STATUS.REVIEW_REQUIRED, TX_STATUS.COMMITTED].indexOf(live.transactionStatus) < 0) {
      disabledReason = '（取引の状態 ' + live.transactionStatus + ' では不可。管理者へ）';
    } else if (code === 'CANCEL_FILE' && live && Number(live.liveTransactionCount || 0) > 0) {
      disabledReason = '（転記済みの取引があるため画面から不可。取消しは管理者へ）';
    }
    return {code: code, label: definition.label, enabled: !disabledReason, disabledReason: disabledReason};
  });
}

function renderResolveOptionPrompt_(item, options, extras, scope, now) {
  extras = extras || {};
  var targetCount = item.reviews.length;
  var typeLabel = MENU_REVIEW_TYPE_LABELS_[item.reviewType] || item.reviewType;
  var customerLabel = (item.customerName || '（顧客不明）') + '(' + item.customerId + ')';
  var optionTarget = typeLabel + ' | ' + customerLabel + ' | ';
  if (item.kind === 'PARTNER_GROUP') {
    optionTarget += (item.merchantOriginal || '（店名なし）') + ' | ' + targetCount + ' 件（未着手 ' + targetCount + '）';
  } else if (item.kind === 'FILE') {
    optionTarget += menuDisplayFileName_(item.reviews[0]);
  } else {
    optionTarget += menuReviewSingleIdentity_(item.reviews[0], extras.live);
  }
  var lines = menuHeaderLines_(scope, now).concat(['', '対象: ' + optionTarget]);
  if (item.kind === 'PARTNER_GROUP') {
    lines.push('  例: ' + menuPartnerExample_(item.reviews[0], extras.live));
    var candidates = menuReviewCandidates_(item.reviews[0]);
    if (candidates.length) {
      lines.push('  候補: ' + menuPartnerCandidatesText_(candidates));
    }
  }
  lines.push('', '操作の番号を入力してください（1〜' + options.length + '）。');
  options.forEach(function(option, index) {
    var definition = MENU_RESOLVE_OPERATIONS_[option.code];
    var prefix = option.code === 'EXCLUDE' && item.kind === 'PARTNER_GROUP' ? '1 件だけ選んで' : '';
    var suffix = definition.unit === 'GROUP' ? '（未解決 ' + targetCount + ' 件のうち ' +
      Math.min(Number(extras.maxPerAction), targetCount) + ' 件。残りは次回）' : '';
    lines.push(' ' + (index + 1) + ') ' + prefix + option.label + suffix + (option.enabled ? '' : option.disabledReason));
  });
  return lines.join('\n');
}

function parseCorrectedDate_(text, now) {
  var value = String(text === null || text === undefined ? '' : text).trim();
  if (!value) return '';
  var compact = value.replace(/\//g, '-');
  if (/^\d{8}$/.test(compact)) compact = compact.slice(0, 4) + '-' + compact.slice(4, 6) + '-' + compact.slice(6);
  var matched = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(compact);
  if (!matched) return null;
  var year = Number(matched[1]); var month = Number(matched[2]); var day = Number(matched[3]);
  var date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  var normalized = matched[1] + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  var todayParts = toTokyoDateString_(now || new Date()).split('-').map(Number);
  var upperDate = new Date(Date.UTC(todayParts[0] + 1, todayParts[1] - 1, todayParts[2]));
  var upper = upperDate.getUTCFullYear() + '-' + String(upperDate.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(upperDate.getUTCDate()).padStart(2, '0');
  return normalized >= '2000-01-01' && normalized <= upper ? normalized : null;
}

function parseCorrectedAmount_(text) {
  var value = String(text === null || text === undefined ? '' : text).trim();
  if (!value) return '';
  value = value.replace(/[０-９]/g, function(character) { return String.fromCharCode(character.charCodeAt(0) - 0xFEE0); })
    .replace(/[，,]/g, '').replace(/[−－―ー]/g, '-');
  if (!/^-?\d+$/.test(value)) return null;
  var amount = Number(value);
  return Math.abs(amount) < 100000000 ? amount : null;
}

function buildResolveConfirmationText_(item, code, inputs, extras, scope, now) {
  var definition = MENU_RESOLVE_OPERATIONS_[code];
  extras = extras || {};
  var selected = item.reviews.filter(function(review) {
    return String(review.reviewId) === String(inputs && inputs.reviewId);
  })[0] || item.reviews[0];
  var target;
  if (definition.unit === 'GROUP') {
    target = (item.merchantOriginal || '（店名なし）') + ' の未解決 ' + item.reviews.length + ' 件のうち ' +
      Math.min(Number(extras.maxPerAction), item.reviews.length) + ' 件（1 回の上限）。残りは次回';
  } else if (definition.unit === 'FILE') {
    target = menuDisplayFileName_(selected);
  } else {
    target = menuReviewSingleIdentity_(selected, extras.live);
  }
  var lines = menuHeaderLines_(scope, now).concat(['', '次の操作を実行します。',
    '  操作: ' + definition.label,
    '  顧客: ' + (item.customerName || '（顧客不明）') + '(' + item.customerId + ')',
    '  対象: ' + target]);
  if (code === 'ADOPT_EXISTING_PARTNER') {
    lines.push('  取引先名: ' + inputs.partnerName);
    if (extras && extras.partnerKnown === false) lines.push('  ※ 取引先一覧に無い名前です（freee 取込時に新規登録されます）');
    lines.push('', '転記先 F列に取引先名を書き、辞書に学習します（次回から自動確定されます）。',
      'この操作は画面から取り消せません（戻すには管理者の操作が必要です）。');
  } else if (code === 'FIX_DATE_AMOUNT') {
    if (inputs.correctedDate !== '' && inputs.correctedDate !== undefined && inputs.correctedDate !== null) {
      lines.push('  修正後の利用日: ' + inputs.correctedDate);
    }
    if (inputs.correctedAmount !== '' && inputs.correctedAmount !== undefined && inputs.correctedAmount !== null) {
      lines.push('  修正後の金額: ' + menuAmountText_(inputs.correctedAmount));
    }
    lines.push('', '入力した利用日・金額だけを転記先 B列・M列へ書きます。',
      'この操作は画面から取り消せません（戻すには管理者の操作が必要です）。');
  } else if (definition.clearsRow) {
    lines.push('', '転記先の行 ' + menuDestinationRow_(extras.live, selected) +
      ' の B・F・I・K・M列と取引 ID を空にし、取引を対象外（CANCELED）にします。' +
      'この操作は画面から取り消せません。戻すには管理者による再取込が必要です');
  } else if (definition.rewind) {
    lines.push('', 'ファイルを取込待ちに戻します。次回の定期取込（10 分以内）で再検査されます。転記先には何も書きません');
  } else if (code === 'CANCEL_FILE') {
    lines.push('', 'ファイルを【取消済】にします。転記先に行はありません。' +
      'この操作は画面から取り消せません（戻すには管理者の操作が必要です）');
  } else if (code === 'KEEP_ORIGINAL_RESULT') {
    lines.push('', 'このファイルを【対象外】にします。既に取り込まれている元のファイルの結果は変わりません',
      'この操作は画面から取り消せません（戻すには管理者の操作が必要です）。');
  } else if (code === 'REJECT_COUNT_MISMATCH' || code === 'RESIZE_INPUT') {
    lines.push('', 'ファイルを【要修正】にします。顧客に修正を依頼してください',
      'この操作は「要修正ファイルを再検査」で取込待ちへ戻せます。');
  } else {
    if (code === 'RESOLVE_WITHOUT_PARTNER') lines.push('', '取引先を空のまま確定します。転記先 F列は変えません。');
    else if (code === 'POST_ZERO_AMOUNT' || code === 'POST_PRIOR_YEAR') {
      lines.push('', '要確認を確定し、現在の転記行の内容を維持します。');
    } else if (code === 'CONFIRM_EMPTY_FILE') {
      lines.push('', '0 件で正しいことを処理ログへ記録し、ファイルを【完了】にします。転記先に行はありません。');
    }
    lines.push('この操作は画面から取り消せません（戻すには管理者の操作が必要です）。');
  }
  if (definition.unit === 'GROUP') {
    lines.push('1 回の実行では時間の都合で ' + Math.min(Number(extras.maxPerAction), item.reviews.length) +
      ' 件までで止まることがあります。残りは同じ手順でもう一度実行してください。');
  }
  lines.push('', '実行しますか？');
  return lines.join('\n');
}

function applyResolveDecision_(item, code, inputs, options) {
  options = options || {};
  var clock = options.clock || Date.now;
  var startedAt = options.startedAt === undefined ? clock() : Number(options.startedAt);
  var deadlineMs = options.deadlineMs === undefined ? MENU_RESOLVE_DEADLINE_MS_ : Number(options.deadlineMs);
  var tripWorstMs = options.tripWorstMs === undefined ? MENU_RESOLVE_TRIP_WORST_MS_ : Number(options.tripWorstMs);
  var itemTrips = options.itemTrips === undefined ? MENU_RESOLVE_ITEM_TRIPS_ : Number(options.itemTrips);
  var cleanupTrips = options.cleanupTrips === undefined ? MENU_RESOLVE_CLEANUP_TRIPS_ : Number(options.cleanupTrips);
  var maxPerAction = options.maxPerAction === undefined ? MENU_RESOLVE_MAX_PER_ACTION_ : Number(options.maxPerAction);
  var readLeases = options.readLeases || activeLeases_;
  var definition = MENU_RESOLVE_OPERATIONS_[code];
  if (!definition) throw new TypeError('Unknown menu operation: ' + code);

  var authOptions = menuOperationAuthOptions_(code);
  var auth = authorizeOperation(code, item.customerId, authOptions);
  var customer = getCustomerById(item.customerId);
  var fileReview = item.reviews[0];
  if (definition.unit === 'FILE') menuAssertNoLease_(fileReview.fileId, readLeases);

  var ordered = item.reviews.slice().sort(function(a, b) {
    return menuDateMilliseconds_(a.registeredAt) - menuDateMilliseconds_(b.registeredAt);
  });
  var targetCount = definition.unit === 'GROUP' ? ordered.length : 1;
  if (definition.unit !== 'GROUP') {
    var wantedId = inputs && inputs.reviewId ? String(inputs.reviewId) : String(ordered[0].reviewId);
    ordered = ordered.filter(function(review) { return String(review.reviewId) === wantedId; }).slice(0, 1);
    if (!ordered.length) throw new StateTransitionError('Review not found in selected target: ' + wantedId);
  }
  var work = definition.unit === 'GROUP' ? ordered.slice(0, maxPerAction) : ordered;
  var outcome = {resolved: 0, committed: 0, unmet: [], completedFiles: [], rewoundFiles: [],
    deferredCommits: 0, skippedByLease: 0, notAttempted: Math.max(0, targetCount - work.length),
    errors: [], maxPerAction: maxPerAction};
  var fileIds = [];
  work.forEach(function(review) {
    if (fileIds.indexOf(String(review.fileId)) < 0) fileIds.push(String(review.fileId));
  });
  var cleanupWorst = cleanupTrips * fileIds.length * tripWorstMs;
  var touched = Object.create(null);
  var transactionTouched = Object.create(null);
  var nextStateByFile = Object.create(null);
  var leaseResults = Object.create(null);
  var leaseBlocked = Object.create(null);
  var learned = false;

  if (definition.requiresNoLiveTransactions) {
    var active = getTransactionsByStatus(fileReview.fileId,
      [TX_STATUS.PREPARED, TX_STATUS.WRITING, TX_STATUS.COMMITTED, TX_STATUS.REVIEW_REQUIRED]);
    if (active.length) {
      throw new StateTransitionError('転記済みの取引があるため画面からは取り消せません。取消しは管理者へ連絡してください。');
    }
  }

  for (var index = 0; index < work.length; index += 1) {
    var review = work[index];
    var fileId = String(review.fileId);
    if (leaseBlocked[fileId]) {
      outcome.skippedByLease += 1;
      continue;
    }
    var elapsed = Number(clock()) - startedAt;
    if (elapsed + itemTrips * tripWorstMs + cleanupWorst > deadlineMs) {
      outcome.notAttempted += work.length - index;
      break;
    }
    try {
      if (code === 'RESOLVE_WITHOUT_PARTNER' || code === 'POST_ZERO_AMOUNT' || code === 'POST_PRIOR_YEAR') {
        if (!Object.prototype.hasOwnProperty.call(leaseResults, fileId)) {
          leaseResults[fileId] = menuLeaseForFile_(fileId, readLeases());
        }
        if (leaseResults[fileId]) {
          leaseBlocked[fileId] = true;
          outcome.errors.push({reviewId: review.reviewId, code: 'LEASE_CONFLICT',
            message: menuLeaseConflictText_(leaseResults[fileId])});
          continue;
        }
      }

      var input = {actor: auth.userEmail, role: auth.role, runId: null};
      if (inputs && inputs.partnerName !== undefined) input.partnerName = inputs.partnerName;
      if (inputs && inputs.correctedDate !== undefined && inputs.correctedDate !== '') input.correctedDate = inputs.correctedDate;
      if (inputs && inputs.correctedAmount !== undefined && inputs.correctedAmount !== '') input.correctedAmount = inputs.correctedAmount;
      if (code === 'RESIZE_INPUT') input.askCustomerToSplit = true;
      if (code === 'CANCEL_FILE') input.choice = 'CANCELED';
      if (code === 'ADOPT_EXISTING_PARTNER') {
        var txForAdopt = getTransaction(review.fullTxId);
        var transactionStatus = txForAdopt && txForAdopt.transactionStatus;
        if ([TX_STATUS.REVIEW_REQUIRED, TX_STATUS.COMMITTED].indexOf(transactionStatus) < 0) {
          outcome.errors.push({reviewId: review.reviewId, code: 'STATE_TRANSITION',
            message: '取引の状態 ' + (transactionStatus || '不明') +
              ' では確定できません。管理者へ連絡してください。'});
          continue;
        }
        input.learn = false;
        if (!learned) {
          if (!isCardNamePartnerPurpose(customer, txForAdopt && txForAdopt.planned ? txForAdopt.planned.i : '')) {
            input.learn = true;
          }
        }
      }

      touched[fileId] = true;
      if (definition.unit !== 'FILE') transactionTouched[fileId] = true;
      var result = definition.unit === 'FILE' ? resolveFileReview(review.reviewId, code, input) :
        resolveReview(review.reviewId, code, input);
      if (code === 'ADOPT_EXISTING_PARTNER' && input.learn === true) learned = true;
      outcome.resolved += 1;
      if (definition.unit === 'FILE') {
        nextStateByFile[fileId] = result.nextState;
      } else {
        if (result.committed) outcome.committed += 1;
        if (result.unmetConditions && result.unmetConditions.length) {
          outcome.unmet.push({reviewId: review.reviewId,
            unmetConditions: result.unmetConditions.slice(),
            openReviewTypes: (result.openReviewTypes || []).slice(),
            transactionStatus: result.transactionStatus || TX_STATUS.REVIEW_REQUIRED});
        }
      }
    } catch (error) {
      outcome.errors.push({reviewId: review.reviewId, code: error && error.code || null,
        message: menuOperationErrorMessage_(error)});
      if (error && error.code === 'LEASE_CONFLICT') leaseBlocked[fileId] = true;
    }
  }

  Object.keys(touched).forEach(function(fileId) {
    if (definition.unit === 'FILE' && nextStateByFile[fileId] === FILE_STATE.VALIDATING) {
      try {
        rewindFileForReimportAudited_(fileId, auth.userEmail,
          {from: FILE_STATE.VALIDATING, operation: code, customerId: item.customerId});
        outcome.rewoundFiles.push(fileId);
      } catch (error) {
        outcome.errors.push({fileId: fileId, code: error && error.code || null,
          message: menuOperationErrorMessage_(error)});
      }
    }
    if (!transactionTouched[fileId]) return;
    try {
      var committed = commitSettledTransactions_(fileId, {maxOrphanCommits: options.maxOrphanCommits});
      outcome.deferredCommits += Number(committed.deferred || 0);
    } catch (error) {
      outcome.errors.push({fileId: fileId, code: error && error.code || null,
        message: menuOperationErrorMessage_(error)});
    }
    try {
      outcome.completedFiles.push(completeFileIfFullyResolved_(fileId, {readLeases: readLeases}));
    } catch (error) {
      outcome.errors.push({fileId: fileId, code: error && error.code || null,
        message: menuOperationErrorMessage_(error)});
    }
  });
  return outcome;
}

function buildResolveResultText_(item, code, inputs, outcome, scope, now) {
  var definition = MENU_RESOLVE_OPERATIONS_[code];
  var targetCount = definition.unit === 'GROUP' ? item.reviews.length : 1;
  var n = Math.min(Number(outcome.maxPerAction), targetCount);
  var operation = definition.label + (inputs && inputs.partnerName ? '（' + inputs.partnerName + '）' : '');
  var targetItem = item;
  if (definition.unit === 'SINGLE' && inputs && inputs.reviewId) {
    var selected = item.reviews.filter(function(review) {
      return String(review.reviewId) === String(inputs.reviewId);
    })[0];
    if (selected) {
      targetItem = {kind: 'TRANSACTION', reviewType: item.reviewType, customerId: item.customerId,
        customerName: item.customerName, merchantOriginal: item.merchantOriginal, reviews: [selected]};
    }
  }
  var lines = menuHeaderLines_(scope, now).concat(['', '■ 実行した操作: ' + operation,
    '■ 対象: ' + menuResolveTargetIdentity_(targetItem, null) +
      (definition.unit === 'GROUP' ? ' / ' + targetCount + ' 件のうち ' + n + ' 件（この押下の上限）' : ''),
    '  確定した要確認: ' + outcome.resolved + ' 件' +
      (definition.unit === 'FILE' ? '' : '（取引が確定: ' + outcome.committed + ' 件' +
        (outcome.unmet.length ? '、未確定: ' + outcome.unmet.length + ' 件 ── ' + menuUnmetText_(outcome.unmet[0]) : '') + '）')]);
  (outcome.completedFiles || []).forEach(function(completed) {
    if (completed.skipped === 'LEASE') lines.push('  完了判定を見送った（リースあり）: ' + completed.fileId);
    else if (completed.completed) lines.push('  ファイルの完了: ' + menuFileNameForId_(item, completed.fileId) + ' → ' + menuFileStateLabel_(completed.state));
  });
  (outcome.rewoundFiles || []).forEach(function(fileId) {
    lines.push('  再検査へ戻したファイル: ' + menuFileNameForId_(item, fileId));
  });
  if (outcome.deferredCommits) lines.push('  確定の再評価を見送った取引: ' + outcome.deferredCommits + ' 件');
  if (outcome.skippedByLease) lines.push('  他の処理と重なって飛ばした: ' + outcome.skippedByLease + ' 件（そのファイルは次回）');
  if (outcome.notAttempted) lines.push('  処理しなかった: ' + outcome.notAttempted + ' 件（1 回の上限 ' + n +
    ' 件に達したか、時間の予算が尽きたため）。もう一度「要確認を確定」を実行してください');
  if (outcome.errors && outcome.errors.length) {
    lines.push('■ エラー: ' + outcome.errors.length + ' 件');
    outcome.errors.forEach(function(error) { lines.push('  ' + (error.reviewId || error.fileId) + ': ' + error.message); });
  }
  if (!outcome.resolved) {
    if (outcome.notAttempted && !outcome.errors.length && !outcome.skippedByLease) {
      lines.push(outcome.notAttempted === targetCount ?
        '操作に時間がかかりすぎたため実行しませんでした。もう一度最初からやり直してください。' :
        '1 回の上限に達したため、この押下では確定しませんでした。');
    } else if (outcome.skippedByLease) {
      lines.push('他の処理と重なったため、1 件も確定できませんでした。10 分ほど待ってからもう一度実行してください。');
    } else if (outcome.errors.length) {
      lines.push('対象がすべて失敗したため、1 件も確定できませんでした。エラーの内容を確認してください。');
    }
  }
  return lines.join('\n');
}

function buildRecheckTargets_(collected, scope) {
  var items = filterByScope_((collected && collected.files) || [], scope).filter(function(file) {
    return String(file.state) === FILE_STATE.CUSTOMER_FIX_REQUIRED;
  }).sort(function(left, right) {
    return menuDateMilliseconds_(right.startedAt) - menuDateMilliseconds_(left.startedAt) ||
      menuDisplayFileName_(left).localeCompare(menuDisplayFileName_(right), 'ja');
  });
  return {items: items.slice(0, MENU_RESOLVE_LIST_LIMIT_), omitted: Math.max(0, items.length - MENU_RESOLVE_LIST_LIMIT_)};
}

function renderRecheckPrompt_(built, scope, now) {
  var lines = menuHeaderLines_(scope, now).concat(['',
    '取込待ちに戻すファイルの番号を入力してください（1〜' + built.items.length +
      '）。元ファイルの修正が済んでいるものだけを選んでください。']);
  built.items.forEach(function(file, index) {
    lines.push(' ' + (index + 1) + ') ' + (scope.customerNameById[file.customerId] || '（顧客不明）') + ' | ' +
      menuShortText_(menuDisplayFileName_(file), 24) + ' | 要修正になった日時 ' +
      formatMenuTimestamp_(file.endedAt) + ' | 最後のエラー: ' + menuLastErrorText_(file.lastError));
  });
  if (built.omitted) lines.push('（他 ' + built.omitted + ' 件は表示していません。表示分を片付けると出てきます）');
  return lines.join('\n');
}

function buildRecheckConfirmationText_(file, scope, now) {
  return menuHeaderLines_(scope, now).concat(['', '次の操作を実行します。',
    '  操作: 要修正ファイルを再検査',
    '  対象: ファイル ' + menuDisplayFileName_(file) + '（顧客 ' + (scope.customerNameById[file.customerId] || '（顧客不明）') +
      '(' + file.customerId + ')）を取込待ちに戻します。次回の定期取込（10 分以内）で再検査されます。' +
      '修正が不十分なら再び【要修正】になります。転記先には何も書きません。' +
      'Drive 上の最終更新から 10 分以上経ってから取り込まれます。実行しますか？']).join('\n');
}

function applyRecheck_(file, options) {
  options = options || {};
  var auth = authorize(ROLE.REVIEWER, String(file.customerId), {operation: 'MENU:要修正ファイルを再検査'});
  var readLeases = options.readLeases || activeLeases_;
  menuAssertNoLease_(file.fileId, readLeases);
  var state = getFileState(file.fileId);
  if (state !== FILE_STATE.CUSTOMER_FIX_REQUIRED) {
    throw new StateTransitionError('状態が変わっています（現在: ' + menuFileStateLabel_(state) + '）。一覧を開き直してください。');
  }
  rewindFileForReimportAudited_(file.fileId, auth.userEmail,
    {from: FILE_STATE.CUSTOMER_FIX_REQUIRED, operation: 'RECHECK', customerId: file.customerId});
  return {fileId: file.fileId, fileState: FILE_STATE.DISCOVERED};
}

function menuOperationAuthOptions_(code) {
  return code === 'RESIZE_INPUT' ? {askCustomerToSplit: true} : {};
}

function menuLeaseForFile_(fileId, leases) {
  return (leases || []).filter(function(lease) { return String(lease.fileId) === String(fileId); })[0] || null;
}

function menuAssertNoLease_(fileId, readLeases) {
  var lease = menuLeaseForFile_(fileId, readLeases());
  if (lease) throw leaseConflict_('Lease owned by ' + lease.owner + ' since ' + lease.acquiredAt);
}

function menuLeaseConflictText_(lease) {
  return 'このファイルは別の処理（定期取込または他の担当者の操作）が使用中のため、今回は書き込みませんでした。' +
    '10 分ほど待ってから再実行してください。長く続く場合は「診断 ▸ リースの状況」で所有者を確認し、管理者へ連絡してください。' +
    (lease ? '\nLease owned by ' + lease.owner + ' since ' + lease.acquiredAt : '');
}

function menuOperationErrorMessage_(error) {
  var message = String(error && error.message || error || '');
  if (error && error.code === 'LEASE_CONFLICT') return menuLeaseConflictText_(null) + (error.detail ? '\n' + error.detail : '');
  if (error && error.code === 'FAULT_INJECTED') return '試験用の障害注入で停止しました（' + (error.pointId || '') + '）。本番のマスターでは起きません。';
  if (error instanceof StateTransitionError) {
    if (message.indexOf('Review is already settled') >= 0) return '既に解決済みです（他の人が先に確定しました）';
    if (message.indexOf('Operation ') >= 0 && message.indexOf(' is not offered') >= 0) {
      return 'この操作はこの要確認には提供されていません。一覧を開き直してください。';
    }
    if (message.indexOf('Exclusion is not offered while the transaction is ') >= 0) {
      return '取引の状態 ' + message.split('Exclusion is not offered while the transaction is ').pop() +
        ' では対象外にできません。管理者へ連絡してください。';
    }
    if (message.indexOf('freee-imported transactions require') >= 0) {
      return 'freee 取込済みの取引のため、画面からは変更できません。管理者へ連絡してください。';
    }
  }
  var classified = classifyMenuError_(error);
  return classified.lines && classified.lines.length ? classified.lines.join('\n') : message;
}

function menuUnmetText_(unmet) {
  var reasons = [];
  (unmet.unmetConditions || []).forEach(function(condition) {
    if (condition === 'PARTNER_UNRESOLVED') reasons.push('取引先が未解決');
    else if (condition === 'PLANNED_B_EMPTY') reasons.push('利用日が未確定');
    else if (condition === 'OPEN_REVIEW_REMAINS') reasons.push('残る要確認: ' +
      (unmet.openReviewTypes || []).map(function(type) { return MENU_REVIEW_TYPE_LABELS_[type] || type; }).join('、'));
    else if (condition === 'NOT_REVIEW_REQUIRED') reasons.push('取引は既に確定済みまたは終端（状態: ' + unmet.transactionStatus + '）');
  });
  return reasons.join('、');
}

function menuResolveTargetIdentity_(item, live) {
  if (item.kind === 'PARTNER_GROUP') {
    return (item.customerName || '（顧客不明）') + '(' + item.customerId + ') / ' +
      (item.merchantOriginal || '（店名なし）');
  }
  if (item.kind === 'FILE') return (item.customerName || '（顧客不明）') + '(' + item.customerId + ') / ' +
    menuDisplayFileName_(item.reviews[0]);
  return (item.customerName || '（顧客不明）') + '(' + item.customerId + ') / ' +
    menuReviewSingleIdentity_(item.reviews[0], live);
}

function menuReviewSingleIdentity_(review, live) {
  if (!live) return menuReviewStoredIdentity_(review);
  var date = live.planned ? live.planned.b : null;
  var amount = live.planned ? live.planned.m : null;
  var purpose = live.planned ? live.planned.i : null;
  var liveMerchant = normalizeMerchant(live.originalMerchant) ? live.originalMerchant :
    (live.planned && normalizeMerchant(live.planned.k) ? live.planned.k : '（店名なし）');
  var row = menuDestinationRow_(live, review);
  return menuResolveDateText_(date) + ' / ' + String(liveMerchant) + ' / ' +
    menuAmountText_(amount) + ' / ' + String(purpose || '-') + ' / 転記行 ' + (row || '-');
}

function menuPartnerExample_(review, live) {
  if (!live) return menuReviewStoredIdentity_(review);
  var planned = live.planned || {};
  return menuResolveDateText_(planned.b) + ' / ' + menuAmountText_(planned.m) +
    ' / ' + String(planned.i || '-') + ' / ' + menuDisplayFileName_(review) +
    ' / 転記行 ' + (menuDestinationRow_(live, review) || '-');
}

function menuReviewStoredIdentity_(review) {
  review = review || {};
  var merchantOriginal = normalizeMerchant(review.merchantOriginal) ? review.merchantOriginal : '（店名なし）';
  var parts = [merchantOriginal];
  var fileName = menuDisplayFileName_(review);
  if (fileName) parts.push(fileName);
  if (review.sourceRow !== '' && review.sourceRow !== null && review.sourceRow !== undefined) {
    var rowText = review.sourceRow + ' 行目';
    if (fileName) parts[parts.length - 1] += ' ' + rowText;
    else parts.push(rowText);
  }
  var txId = review.displayTxId || review.fullTxId;
  if (txId) parts[parts.length - 1] += '（' + txId + '）';
  return parts.join(' / ');
}

function menuResolveDateText_(value) {
  return value === '' || value === null || value === undefined ? '(不明)' : formatMenuTimestamp_(value).slice(0, 10);
}

function menuDestinationRow_(live, review) {
  return live && live.destinationRow ? live.destinationRow : review && review.destinationRow;
}

function menuReviewCandidates_(review) {
  try {
    var parsed = jsonCell_(review.candidates, []);
    return Array.isArray(parsed) ? parsed.filter(function(candidate) { return candidate && candidate.partnerName; }) : [];
  } catch (ignored) {
    return [];
  }
}

function menuPartnerCandidatesText_(candidates) {
  return (candidates || []).map(function(candidate, index) {
    return (index + 1) + ') ' + candidate.partnerName;
  }).join('  ');
}

function menuAmountText_(value) {
  if (value === '' || value === null || value === undefined) return '-';
  return Number(value).toLocaleString('ja-JP');
}

function menuShortText_(value, max) {
  var text = String(value === null || value === undefined ? '' : value);
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function menuDisplayFileName_(file) {
  return String(file.fileNameOriginal || file.fileName || '').replace(removableStatePrefixRegex_(), '');
}

function menuLastErrorText_(lastError) {
  if (!lastError) return '-';
  if (typeof lastError === 'string') return lastError;
  return String(lastError.code || lastError.message || lastError);
}

function menuFileNameForId_(item, fileId) {
  var found = item.reviews.filter(function(review) { return String(review.fileId) === String(fileId); })[0];
  return found ? menuDisplayFileName_(found) : String(fileId);
}

function menuUi_() { return SpreadsheetApp.getUi(); }

function runMenuAction_(actionName, fn, options) {
  options = options || {};
  var ui = menuUi_();
  try {
    loadSettingsFromProperties();
    var now = new Date();
    var scope = menuViewerScope_(actionName);
    presentMenuResult_(ui, fn(scope, now));
  } catch (error) {
    presentMenuError_(ui, actionName, error, [], options);
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

function presentMenuError_(ui, actionName, error, extraLines, options) {
  Logger.log('[menu] ' + actionName + ' failed: ' +
    (error && error.stack ? error.stack : String(error)));
  var classified = classifyMenuError_(error);
  if (classified.rethrow) throw error;
  var verb = options && options.verb ? String(options.verb) : '表示';
  var lines = [actionName + ' を' + verb + 'できませんでした。'].concat(classified.lines || []);
  if (extraLines && extraLines.length) lines = lines.concat(extraLines);
  ui.alert('クレカ自動処理 ― エラー', lines.join('\n'), ui.ButtonSet.OK);
}

/**
 * 閲覧範囲の取得。操作系メニューは一覧表示時の結果を流用せず、書込直前に
 * 対象顧客ごとの認可を呼び直す。
 */
function menuViewerScope_(actionName) {
  var authorized = authorize(ROLE.REVIEWER, null, {operation: 'MENU:' + actionName});
  var customerIds = [];
  var customerNameById = {};
  authorized.customers.forEach(function(customer) {
    customerIds.push(customer.customerId);
    customerNameById[customer.customerId] = customer.customerName;
  });
  return {
    email: authorized.userEmail,
    role: authorized.role,
    isOwner: authorized.isOwner,
    ownerEmail: authorized.ownerEmail,
    customers: authorized.customers,
    customerIds: customerIds,
    customerNameById: customerNameById,
    rolesByCustomerId: authorized.rolesByCustomerId
  };
}

function menuHeaderLines_(scope, now) {
  return [
    '実行者: ' + scope.email + '（' + roleLabel(scope.role) + '）',
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
  if (error && error.code === 'LEASE_CONFLICT') {
    var leaseLines = ['このファイルは別の処理（定期取込または他の担当者の操作）が使用中のため、今回は書き込みませんでした。' +
      '10 分ほど待ってから再実行してください。長く続く場合は「診断 ▸ リースの状況」で所有者を確認し、管理者へ連絡してください。'];
    if (error.detail) leaseLines.push(String(error.detail));
    return {title: 'エラー', lines: leaseLines};
  }
  if (error && error.code === 'FAULT_INJECTED') {
    return {title: 'エラー', lines: [
      '試験用の障害注入で停止しました（' + String(error.pointId || '') + '）。本番のマスターでは起きません。'
    ]};
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

function menuReviewStatusLabel_(status) {
  var code = String(status || 'NOT_FOUND');
  return MENU_REVIEW_STATUS_LABELS_[code] || '見つかりません';
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

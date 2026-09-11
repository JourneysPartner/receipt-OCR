'use strict';

/**
 * 設計 §4.5 `04_Notifications.gs` の暫定実装。継続トリガー（4.35）・
 * メトリクス（4.36）・クォータ管理（4.37）実装まで、定期取込と状態監視の
 * 通知だけを扱う。事象ごとの押し出し型ではなく、所見を集めて抑制する型に
 * したのは、2026-09-09 の事故を必ず鳴らしつつ、10分ごとの洪水を防ぐためである。
 *
 * 読込時に他モジュールへ触れると通知以外も起動不能になるため、トップレベルは
 * 関数宣言とリテラル定数だけに限る。
 */

var NOTIFY_STATE_PROPERTY_ = 'NOTIFY_STATE_V1';
var NOTIFY_BUCKET_PROPERTY_PREFIX_ = 'NOTIFY_BUCKET_V1|';
var NOTIFY_MAX_MAILS_PER_EVALUATION_ = 3;
var NOTIFY_MAX_WATCH_ENTRIES_ = 40;
var NOTIFY_REPEAT_MINUTES_ = {CRITICAL: 360, WARNING: 1440, INFO: 0};
var NOTIFY_SEVERITY_LABELS_ = {CRITICAL: '要対応', WARNING: '注意', INFO: '情報'};
var NOTIFY_SUBJECT_PREFIX_ = '[クレカ自動処理]';
var NOTIFY_SENDER_NAME_ = 'クレカ自動処理';
var NOTIFY_MAX_LISTED_IDS_ = 10;
var NOTIFY_MAX_FINGERPRINT_ELEMENTS_ = 10;
var NOTIFY_ELEMENT_KEY_LENGTH_ = 12;
var NOTIFY_FINGERPRINT_HASH_LENGTH_ = 16;
var NOTIFY_STATE_MAX_BYTES_ = 8500;
var NOTIFY_ESCALATE_ON_REPEAT_ = {INTERRUPTION_RECOVERED: true};
var NOTIFICATION_WATCHDOG_HANDLER_ = 'notificationWatchdogTick';

function notificationGlobalInitial_() {
  return {version: 1, day: null, sentToday: 0, lastSent: null, lastFailure: null, quota: null};
}

function notificationBucketInitial_() {
  return {version: 1, episodes: {}, watch: {}};
}

function notificationClone_(value) {
  return JSON.parse(JSON.stringify(value));
}

function notificationIso_(value) {
  var date = Object.prototype.toString.call(value) === '[object Date]' ? value : new Date(value);
  return toIso8601(date);
}

function notificationMinute_(value) {
  if (!value) return '-';
  try { return notificationIso_(value).slice(0, 16).replace('T', ' '); }
  catch (ignored) { return String(value).slice(0, 16).replace('T', ' '); }
}

function notificationSeverityRank_(severity) {
  return severity === 'CRITICAL' ? 3 : severity === 'WARNING' ? 2 : severity === 'INFO' ? 1 : 0;
}

function notificationSafeCode_(error) {
  return String((error && error.code) || (error && error.name) || 'Error');
}

function notificationUniqueSorted_(values) {
  var seen = {};
  return (values || []).map(function(value) { return String(value); }).filter(function(value) {
    if (seen[value]) return false;
    seen[value] = true;
    return true;
  }).sort();
}

function notificationFingerprint_(elements) {
  var values = notificationUniqueSorted_(elements);
  var joined = values.join('\n');
  var keys = values.length <= NOTIFY_MAX_FINGERPRINT_ELEMENTS_ ? values.map(function(value) {
    return sha256Hex(utf8Bytes(value)).slice(0, NOTIFY_ELEMENT_KEY_LENGTH_);
  }).sort() : [];
  return {
    fingerprint: keys,
    fingerprintHash: sha256Hex(utf8Bytes(joined)).slice(0, NOTIFY_FINGERPRINT_HASH_LENGTH_),
    elementCount: values.length,
    elementKeys: values.map(function(value) {
      return sha256Hex(utf8Bytes(value)).slice(0, NOTIFY_ELEMENT_KEY_LENGTH_);
    })
  };
}

function notificationRepeatMilliseconds_(severity) {
  return Number(NOTIFY_REPEAT_MINUTES_[severity] || 0) * 60 * 1000;
}

function notificationEpisodeExpired_(episode, now) {
  if (!episode || !episode.lastSeenAt) return true;
  var seen = new Date(episode.lastSeenAt).getTime();
  var current = now.getTime();
  if (!isFinite(seen) || !isFinite(current)) return true;
  return current - seen > notificationRepeatMilliseconds_(episode.severity || 'CRITICAL');
}

function notificationCriticalInterruptionLine_(count) {
  return '⚠ 同じファイルが繰り返し中断しています（' + count +
    ' 件）。6 分の実行上限に当たっている可能性があります';
}

function evaluateEpisodes_(buckets, findings, now) {
  var current = notificationClone_(buckets || {});
  var due = [];
  var continuing = [];
  var touched = {};
  var at = notificationIso_(now);

  (findings || []).forEach(function(sourceFinding) {
    var finding = notificationClone_(sourceFinding);
    var bucket = String(finding.bucket || 'SYSTEM');
    if (!current[bucket] || current[bucket].version !== 1) current[bucket] = notificationBucketInitial_();
    if (!current[bucket].episodes || typeof current[bucket].episodes !== 'object') current[bucket].episodes = {};
    if (!current[bucket].watch || typeof current[bucket].watch !== 'object') current[bucket].watch = {};
    var previous = current[bucket].episodes[finding.kind] || null;
    if (previous && notificationEpisodeExpired_(previous, now)) previous = null;
    var fingerprint = notificationFingerprint_(finding.elements || []);
    var episode;
    var shouldSend = false;

    if (!previous) {
      episode = {
        fingerprint: fingerprint.fingerprint,
        fingerprintHash: fingerprint.fingerprintHash,
        elementCount: fingerprint.elementCount,
        severity: finding.severity,
        firstSeenAt: at,
        lastSeenAt: at,
        lastSentAt: null,
        seenCount: 1,
        sentCount: 0
      };
      shouldSend = true;
    } else {
      episode = notificationClone_(previous);
      var effectiveSeverity = episode.severity || finding.severity;
      var previousKeys = Array.isArray(episode.fingerprint) ? episode.fingerprint : [];
      var overlaps = previousKeys.length ? fingerprint.elementKeys.some(function(key) {
        return previousKeys.indexOf(key) >= 0;
      }) : fingerprint.fingerprintHash === episode.fingerprintHash;
      var hasNewElement = previousKeys.length ? fingerprint.elementKeys.some(function(key) {
        return previousKeys.indexOf(key) < 0;
      }) : fingerprint.fingerprintHash !== episode.fingerprintHash &&
        fingerprint.elementCount > Number(episode.elementCount || 0);
      var wasCritical = episode.severity === 'CRITICAL';
      if (NOTIFY_ESCALATE_ON_REPEAT_[finding.kind] && overlaps) {
        effectiveSeverity = 'CRITICAL';
        if (!wasCritical) shouldSend = true;
      }
      if (notificationSeverityRank_(finding.severity) > notificationSeverityRank_(effectiveSeverity)) {
        effectiveSeverity = finding.severity;
      }
      if (hasNewElement) shouldSend = true;
      if (!episode.lastSentAt || now.getTime() - new Date(episode.lastSentAt).getTime() >=
          notificationRepeatMilliseconds_(effectiveSeverity)) shouldSend = true;
      episode.lastSeenAt = at;
      episode.seenCount = Number(episode.seenCount || 0) + 1;
      finding.severity = effectiveSeverity;
    }

    if (finding.kind === 'SCHEDULE_STOPPED') shouldSend = true;
    finding.severity = notificationSeverityRank_(episode.severity) > notificationSeverityRank_(finding.severity) ?
      episode.severity : finding.severity;
    if (finding.kind === 'INTERRUPTION_RECOVERED' && finding.severity === 'CRITICAL') {
      finding.line = notificationCriticalInterruptionLine_(finding.count);
    }
    current[bucket].episodes[finding.kind] = episode;
    touched[bucket] = true;
    (shouldSend ? due : continuing).push(finding);
  });

  return {buckets: current, due: due, continuing: continuing, touched: Object.keys(touched)};
}

function stateFindingsFromCollected_(collected, customersById, now, buckets) {
  var sourceBuckets = buckets || {};
  var ids = {};
  Object.keys(customersById || {}).forEach(function(id) { ids[String(id)] = true; });
  // 顧客停止やファイル削除後も古い監視値を残すと、メニューが存在しない
  // ファイルを比較基準にし続けるため、保存済みバケットも空集合として評価する。
  Object.keys(sourceBuckets).forEach(function(id) { ids[String(id)] = true; });
  (collected.files || []).concat(collected.leases || []).forEach(function(item) {
    var id = String(item && item.customerId || '');
    if (id) ids[id] = true;
  });
  var bucketIds = Object.keys(ids).sort();
  var hasSystem = (collected.files || []).concat(collected.leases || []).some(function(item) {
    return !String(item && item.customerId || '');
  });
  if (hasSystem && bucketIds.indexOf('SYSTEM') < 0) bucketIds.push('SYSTEM');
  var findings = [];
  var watchByBucket = {};

  bucketIds.forEach(function(bucket) {
    var scoped = filterCollectedByCustomer_(collected, bucket);
    var prior = sourceBuckets[bucket] && sourceBuckets[bucket].watch || {};
    var assessment = assessImportStatus_(scoped, now, prior);
    assessment.findings.forEach(function(item) {
      var finding = notificationClone_(item);
      finding.bucket = bucket;
      findings.push(finding);
    });
    var watch = notificationClone_(prior);
    var present = {};
    scoped.files.forEach(function(item) {
      var id = String(item.fileId || '');
      if (!id) return;
      present[id] = true;
      var total = fileErrorTotal_(item);
      if (item.state === 'DISCOVERED' && total >= 1) watch[id] = total;
      else if (item.state !== 'VALIDATING' && item.state !== 'WRITING') delete watch[id];
    });
    Object.keys(watch).forEach(function(id) { if (!present[id]) delete watch[id]; });
    watchByBucket[bucket] = watch;
  });
  return {findings: findings, watchByBucket: watchByBucket};
}

function housekeepingFindings_(housekeeping, customerIdByFileId) {
  if (!housekeeping) return [];
  var findings = [];
  if (housekeeping.error) {
    var code = notificationSafeCode_(housekeeping.error);
    findings.push({kind: 'HOUSEKEEPING_FAILED', severity: 'CRITICAL', bucket: 'SYSTEM', count: 1,
      elements: [code],
      line: '⚠ 定期取込の後始末（リース解放・回復）が失敗しました（' + code + '）',
      action: 'Apps Script の実行ログを確認してください。後始末が失敗し続けると、止まったファイルが永久に拾われません'});
  }
  var allIds = notificationUniqueSorted_(housekeeping.fileIds || []);
  if (!allIds.length) return findings;
  var releasedIds = notificationUniqueSorted_(housekeeping.releasedFileIds || []);
  var recoveredIds = notificationUniqueSorted_(housekeeping.recoveredFileIds || []);
  var grouped = {};
  allIds.forEach(function(id) {
    var bucket = String(customerIdByFileId && customerIdByFileId[id] || 'SYSTEM');
    if (!grouped[bucket]) grouped[bucket] = [];
    grouped[bucket].push(id);
  });
  Object.keys(grouped).sort().forEach(function(bucket) {
    var ids = notificationUniqueSorted_(grouped[bucket]);
    var released = releasedIds.length ? ids.filter(function(id) { return releasedIds.indexOf(id) >= 0; }).length :
      (Object.keys(grouped).length === 1 ? Number(housekeeping.released || 0) : 0);
    var recovered = recoveredIds.length ? ids.filter(function(id) { return recoveredIds.indexOf(id) >= 0; }).length :
      (Object.keys(grouped).length === 1 ? Number(housekeeping.recovered || 0) : 0);
    findings.push({kind: 'INTERRUPTION_RECOVERED', severity: 'WARNING', bucket: bucket,
      count: ids.length, elements: ids, releasedCount: released, recoveredCount: recovered,
      line: '△ 前回の実行が途中で止まっていたため、リース解放 ' + released + ' 件・回復 ' + recovered + ' 件を行いました',
      action: 'opsInspectStuckFiles で、どのファイルがどこまで書けているかを確認してください。同じファイルで毎回起きる場合は、そのファイルを opsImportOneFile で単独に取り込むか、分割を検討してください'});
  });
  return findings;
}

function runFindingsFromReport_(report, scheduleStopped) {
  if (!report) return [];
  var findings = [];
  (report.customers || []).forEach(function(customer) {
    var failed = (customer.files || []).filter(function(item) { return item.outcome === 'FAILED'; });
    if (failed.length) {
      var elements = failed.map(function(item) {
        return String(item.fileId || '') + '|' + String(item.errorCode || item.errorName || 'Error');
      });
      findings.push({kind: 'RUN_FILE_FAILED', severity: 'CRITICAL', bucket: String(customer.customerId || 'SYSTEM'),
        count: failed.length, elements: notificationUniqueSorted_(elements),
        line: '⚠ 取込に失敗したファイルが ' + failed.length + ' 件あります（この実行）',
        action: '処理ログの W列（エラー）で詳細を確認してください。同じファイルが毎回失敗している場合、状態が取込待ちに戻っていても取込は前に進んでいません'});
    }
    if (customer.skipped !== null && customer.skipped !== undefined) {
      var skipped = String(customer.skipped);
      findings.push({kind: 'RUN_CUSTOMER_SKIPPED', severity: 'CRITICAL', bucket: String(customer.customerId || 'SYSTEM'),
        count: 1, elements: [skipped], reason: skipped,
        line: '⚠ この顧客の取込を開始できませんでした（理由: ' + skipped + '）',
        action: 'INTEGRITY_STOP なら整合性検査の所見を、それ以外は Apps Script の実行ログを確認してください'});
    }
  });
  if (report.stoppedBy) {
    var stopped = String(report.stoppedBy);
    var elements = [stopped];
    var targets = [];
    if (stopped === 'SETTINGS_INVALID') {
      elements = (report.settingsProblems || []).map(function(problem) {
        return 'SETTINGS_INVALID#' + String(problem.check);
      });
      targets = (report.settingsProblems || []).map(function(problem) {
        return {check: problem.check, name: String(problem.name || '')};
      });
      if (!elements.length) elements = [stopped];
    }
    findings.push({kind: 'RUN_STOPPED', severity: 'CRITICAL', bucket: 'SYSTEM', count: 1,
      elements: notificationUniqueSorted_(elements), reason: stopped, targets: targets,
      line: '⚠ 定期取込が実行前に停止しました（理由: ' + stopped + '）',
      action: 'NO_AUTHORIZED_CUSTOMER: 実行者（定期取込ではトリガー作成者）が顧客マスターの Q/R 列に無い。SETTINGS_INVALID: 「診断 ▸ 設定の検査」で不合格の項目を確認。LOG_CAPACITY_EXCEEDED: 保存先の容量'});
  }
  if ((report.customers || []).some(function(customer) {
    return customer.auditChain === 'BROKEN_NOTIFY_ONLY';
  })) {
    findings.push({kind: 'AUDIT_CHAIN_BROKEN', severity: 'WARNING', bucket: 'SYSTEM', count: 1,
      elements: ['BROKEN'], line: '△ 監査ログの連鎖ハッシュが壊れています（処理は止めていません。設計 INV-29）',
      action: "verifyChain('ALL') で破損位置を特定してください"});
  }
  if (scheduleStopped) {
    findings.push({kind: 'SCHEDULE_STOPPED', severity: 'INFO', bucket: 'SYSTEM', count: 1, elements: [],
      line: '定期取込は残件がなくなったため自動停止しました。新しいファイルを置いたら opsStartScheduledImport を実行してください',
      action: '新しいファイルを置いたら opsStartScheduledImport を実行してください'});
  }
  return findings;
}

function notificationStatusFailureFinding_(error) {
  var code = notificationSafeCode_(error);
  return {kind: 'STATUS_CHECK_FAILED', severity: 'CRITICAL', bucket: 'SYSTEM', count: 1,
    elements: [code], line: '⚠ 取込の状態を確認できませんでした（' + code + '）。マスタースプレッドシートを読めていない可能性があります',
    action: '「診断 ▸ 設定の検査」と「このメニューについて」で、マスターと必須シートを確認してください'};
}

function notificationCustomersById_(customers) {
  var result = {};
  (customers || []).forEach(function(customer) {
    if (customer && customer.customerId) result[String(customer.customerId)] = customer;
  });
  return result;
}

function notificationLinks_() {
  try {
    var master = masterSpreadsheet_();
    return {
      processLog: master.getUrl() + '#gid=' + processLogSheet_().getSheetId(),
      review: master.getUrl() + '#gid=' + reviewSheet_().getSheetId()
    };
  } catch (ignored) { return null; }
}

function notifyImportState_(options) {
  try {
    var opts = options || {};
    var now = opts.now || new Date();
    var snapshot = readNotificationState_();
    var customerMasterUnavailable = opts.customers === null;
    var customerList = Array.isArray(opts.customers) ? opts.customers : null;
    var customerReadError = null;
    if (opts.customers === undefined) {
      try { customerList = getActiveCustomers(); }
      catch (readError) { customerMasterUnavailable = true; customerReadError = readError; }
    }
    var customersById = notificationCustomersById_(customerList);
    var findings = [];
    var watchByBucket = {};
    var collected = null;
    var collectError = null;
    try { collected = collectImportStatus_({now: now}); }
    catch (error) { collectError = error; }
    if (collected) {
      (collected.files || []).forEach(function(item) {
        var id = String(item.customerId || '');
        if (id && !customersById[id]) customersById[id] = {customerId: id, customerName: id, admins: []};
      });
      var state = stateFindingsFromCollected_(collected, customersById, now, snapshot.buckets);
      findings = findings.concat(state.findings);
      watchByBucket = state.watchByBucket;
    }
    if (collectError || customerMasterUnavailable) {
      findings.push(notificationStatusFailureFinding_(collectError || customerReadError || {name: 'CustomerMasterError'}));
    }
    var customerIdByFileId = {};
    if (collected) (collected.files || []).forEach(function(item) {
      if (item.fileId) customerIdByFileId[String(item.fileId)] = String(item.customerId || '');
    });
    findings = findings.concat(housekeepingFindings_(opts.housekeeping, customerIdByFileId));
    return dispatchNotifications_(findings, {now: now, source: opts.source || 'TICK', runId: null,
      customersById: customerMasterUnavailable ? null : customersById,
      effectiveUser: effectiveUserEmail_(), watchByBucket: watchByBucket,
      links: notificationLinks_(), customerMasterUnavailable: customerMasterUnavailable});
  } catch (error) {
    Logger.log('[notify] notifyImportState_ failed: ' + (error && error.stack ? error.stack : String(error)));
    return {sent: 0, skipped: 0, failed: 1, deferred: 0};
  }
}

function notifyRunReport_(report, options) {
  try {
    var opts = options || {};
    var customerMasterUnavailable = opts.customers === null;
    var customerList = Array.isArray(opts.customers) ? opts.customers : null;
    if (opts.customers === undefined) {
      try { customerList = getActiveCustomers(); }
      catch (ignored) { customerMasterUnavailable = true; }
    }
    return dispatchNotifications_(runFindingsFromReport_(report, Boolean(opts.scheduleStopped)), {
      now: opts.now || new Date(), source: 'TICK', runId: report && report.runId || null,
      customersById: customerMasterUnavailable ? null : notificationCustomersById_(customerList),
      effectiveUser: effectiveUserEmail_(), watchByBucket: {}, links: notificationLinks_(),
      customerMasterUnavailable: customerMasterUnavailable
    });
  } catch (error) {
    Logger.log('[notify] notifyRunReport_ failed: ' + (error && error.stack ? error.stack : String(error)));
    return {sent: 0, skipped: 0, failed: 1, deferred: 0};
  }
}

function notificationRecipients_(bucket, customersById, effectiveUser) {
  var values = [];
  function append(value) {
    if (Array.isArray(value)) value.forEach(append);
    else String(value || '').split(',').forEach(function(part) { values.push(part); });
  }
  if (bucket === 'SYSTEM') Object.keys(customersById || {}).sort().forEach(function(id) {
    append(customersById[id] && customersById[id].admins);
  });
  else append(customersById && customersById[bucket] && customersById[bucket].admins);
  append(effectiveUser);
  var seen = {};
  return values.map(function(value) { return String(value || '').trim().toLowerCase(); }).filter(function(value) {
    if (value.indexOf('@') < 0 || seen[value]) return false;
    seen[value] = true;
    return true;
  });
}

function notificationSummary_(finding) {
  var count = Number(finding.count || 0);
  if (finding.kind === 'RUN_FILE_FAILED') return '取込エラー ' + count + '件';
  if (finding.kind === 'RUN_CUSTOMER_SKIPPED') return '取込開始不可 ' + String(finding.reason || '');
  if (finding.kind === 'RUN_STOPPED') return '定期取込停止 ' + String(finding.reason || '');
  if (finding.kind === 'HOUSEKEEPING_FAILED') return '後始末失敗';
  if (finding.kind === 'STATUS_CHECK_FAILED') return '状態確認不可';
  if (finding.kind === 'FAILED_FILES') return '失敗ファイル ' + count + '件';
  if (finding.kind === 'REPEATED_FAILURE') return '取込失敗を繰り返すファイル ' + count + '件';
  if (finding.kind === 'STALLED') return '停止中ファイル ' + count + '件';
  if (finding.kind === 'IMPORT_IDLE') return '取込待ちが止まっています ' + count + '件';
  if (finding.kind === 'CUSTOMER_FIX') return '顧客修正待ち ' + count + '件';
  if (finding.kind === 'ERROR_RECORDS') return 'エラー記録あり ' + count + '件';
  if (finding.kind === 'INTERRUPTION_RECOVERED') return finding.severity === 'CRITICAL' ?
    '繰り返し中断 ' + count + '件' : '中断から回復 ' + count + '件';
  if (finding.kind === 'AUDIT_CHAIN_BROKEN') return '監査ログ連鎖破損';
  if (finding.kind === 'SCHEDULE_STOPPED') return '定期取込を自動停止';
  return String(finding.kind || '通知');
}

function notificationIdsForMail_(finding) {
  if (finding.kind === 'RUN_FILE_FAILED') return (finding.elements || []).map(function(element) {
    var value = String(element); var split = value.lastIndexOf('|');
    return split < 0 ? value : value.slice(0, split);
  });
  if (['FAILED_FILES', 'REPEATED_FAILURE', 'STALLED', 'CUSTOMER_FIX', 'IMPORT_IDLE',
      'ERROR_RECORDS', 'INTERRUPTION_RECOVERED'].indexOf(finding.kind) >= 0) return finding.elements || [];
  return [];
}

function notificationErrorCounts_(finding) {
  var counts = {};
  (finding.elements || []).forEach(function(element) {
    var value = String(element); var split = value.lastIndexOf('|');
    var code = split < 0 ? 'Error' : value.slice(split + 1);
    counts[code] = (counts[code] || 0) + 1;
  });
  return Object.keys(counts).sort().map(function(code) { return code + ' ' + counts[code]; }).join('、');
}

function composeNotificationMail_(bucket, dueFindings, continuingFindings, context) {
  var due = dueFindings || [];
  var continuing = continuingFindings || [];
  var severity = due.reduce(function(best, finding) {
    return notificationSeverityRank_(finding.severity) > notificationSeverityRank_(best) ? finding.severity : best;
  }, 'INFO');
  var summaries = due.map(notificationSummary_);
  if (summaries.length > 3) summaries = summaries.slice(0, 3).concat(['ほか' + (summaries.length - 3) + '件']);
  var target = bucket === 'SYSTEM' ? 'システム' : String(context.customerName || bucket) + '(' + bucket + ')';
  var subject = NOTIFY_SUBJECT_PREFIX_ + ' ' + NOTIFY_SEVERITY_LABELS_[severity] + ' ' +
    target + ': ' + summaries.join('、');
  var source = context.source === 'WATCHDOG' ? '監視トリガー' :
    '定期取込' + (context.runId ? ' ' + context.runId : '');
  var lines = ['クレカ自動処理からの自動通知です。', '',
    '宛先: ' + (bucket === 'SYSTEM' ? 'システム全体' : target),
    '検知: ' + notificationMinute_(context.now) + '（' + source + '）',
    'コード版: ' + String(context.codeVersion || ''), '', '■ 新しく検知した異常'];
  due.forEach(function(finding) {
    var episode = context.episodes && context.episodes[finding.kind] || {};
    lines.push(finding.line);
    if (!episode.lastSentAt) lines.push('  状態: 新規');
    else lines.push('  状態: 継続中（最初の検知 ' + notificationMinute_(episode.firstSeenAt) + '、' +
      Number(episode.seenCount || 0) + ' 回目、前回の通知 ' + notificationMinute_(episode.lastSentAt) + '）');
    if (bucket !== 'SYSTEM') {
      var ids = [];
      var seen = {};
      notificationIdsForMail_(finding).forEach(function(id) {
        id = String(id || '');
        if (id && !seen[id]) { seen[id] = true; ids.push(id); }
      });
      if (ids.length) {
        var listed = ids.slice(0, NOTIFY_MAX_LISTED_IDS_);
        var suffix = ids.length > listed.length ? '（ほか ' + (ids.length - listed.length) + ' 件）' : '';
        lines.push('  対象: fileId ' + listed.join(', ') + suffix);
      }
    }
    if (finding.kind === 'RUN_FILE_FAILED') lines.push('  エラー: ' + notificationErrorCounts_(finding));
    if (finding.kind === 'RUN_STOPPED' && finding.reason === 'SETTINGS_INVALID') {
      (finding.targets || []).forEach(function(targetItem) {
        lines.push('  対象: 検査 #' + String(targetItem.check) + ' ' + String(targetItem.name || ''));
      });
    }
    if (finding.action) lines.push('  対処: ' + finding.action);
  });
  if (continuing.length) {
    lines.push('', '■ 継続中の異常（前回通知済み）');
    continuing.forEach(function(finding) {
      var episode = context.episodes && context.episodes[finding.kind] || {};
      lines.push(finding.line + '（最初の検知 ' + notificationMinute_(episode.firstSeenAt) + '）');
    });
  }
  lines.push('', '■ リンク');
  if (context.links) {
    lines.push('処理ログ: ' + context.links.processLog);
    lines.push('要確認:   ' + context.links.review);
    lines.push('（スプレッドシートを開いて「クレカ自動処理 ▸ 取込の状況」でも確認できます）');
  } else lines.push('（マスターを開けないため省略）');
  lines.push('', '■ この通知について');
  // 抑制なしを「0分は再送しません」と書くと、日本語として壊れるうえ意味が逆に
  // 読める。INFOに抑制を置かないのは意図である ── 「定期取込を自動停止」は
  // `opsStartScheduledImport`の実行を促す通知で、抑制すると次のバッチで取込が
  // 止まったままになる。文言のほうを事実に合わせる。
  var repeatMinutes = Number(NOTIFY_REPEAT_MINUTES_[severity] || 0);
  lines.push(repeatMinutes === 0 ?
    '同じ事象でも毎回通知します（要対応: 6時間、注意: 24時間は再送しません）。解消しても通知しません。' :
    '同じ事象は ' + String(repeatMinutes / 60) +
      ' 時間は再送しません（要対応: 6時間、注意: 24時間）。解消しても通知しません。');
  if (Number(context.quotaSkipped || 0) > 0) {
    lines.push('前回までにクォータ上限で ' + Number(context.quotaSkipped) + ' 件の通知を送れませんでした。');
  }
  if (context.customerMasterUnavailable) {
    lines.push('顧客マスターを読めなかったため、管理者宛てを省略しました。');
  }
  return {subject: subject, body: lines.join('\n')};
}

function notificationLineForKind_(kind, count, severity) {
  if (kind === 'RUN_FILE_FAILED') return '⚠ 取込に失敗したファイルが ' + count + ' 件あります（この実行）';
  if (kind === 'FAILED_FILES') return '⚠ 失敗したファイルが ' + count + ' 件あります。';
  if (kind === 'REPEATED_FAILURE') return '⚠ 取込に繰り返し失敗して取込待ちに戻っているファイルが ' + count + ' 件あります。';
  if (kind === 'INTERRUPTION_RECOVERED' && severity === 'CRITICAL') return notificationCriticalInterruptionLine_(count);
  return String(kind) + '（' + count + ' 件）';
}

function notificationStoredContinuing_(bucketState, excludedKinds, now) {
  var result = [];
  Object.keys(bucketState.episodes || {}).forEach(function(kind) {
    if (excludedKinds[kind] || kind === 'SCHEDULE_STOPPED') return;
    var episode = bucketState.episodes[kind];
    if (!episode.lastSentAt || notificationEpisodeExpired_(episode, now)) return;
    result.push({kind: kind, severity: episode.severity, bucket: null,
      count: Number(episode.elementCount || 0), elements: [],
      line: notificationLineForKind_(kind, Number(episode.elementCount || 0), episode.severity), action: ''});
  });
  return result;
}

function sendNotificationMail_(recipients, mail) {
  try {
    MailApp.sendEmail({to: recipients.join(','), subject: mail.subject, body: mail.body,
      name: NOTIFY_SENDER_NAME_});
    return {sent: true};
  } catch (error) {
    return {sent: false, reason: 'MAIL_SEND_FAILED', detail: String(error && error.message).slice(0, 200)};
  }
}

function dispatchNotifications_(findings, options) {
  var opts = options || {};
  var now = opts.now || new Date();
  try {
    return withScriptLock_(function() {
      var state = readNotificationState_();
      var day = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
      if (state.global.day !== day) {
        state.global.day = day;
        state.global.sentToday = 0;
      }
      var evaluated = evaluateEpisodes_(state.buckets, findings || [], now);
      state.buckets = evaluated.buckets;
      Object.keys(opts.watchByBucket || {}).forEach(function(bucket) {
        if (!state.buckets[bucket]) state.buckets[bucket] = notificationBucketInitial_();
        state.buckets[bucket].watch = notificationClone_(opts.watchByBucket[bucket] || {});
      });
      var byBucket = {};
      evaluated.due.forEach(function(finding) {
        var bucket = String(finding.bucket || 'SYSTEM');
        if (!byBucket[bucket]) byBucket[bucket] = [];
        byBucket[bucket].push(finding);
      });
      var candidates = Object.keys(byBucket).map(function(bucket) {
        var highest = byBucket[bucket].reduce(function(best, finding) {
          return Math.max(best, notificationSeverityRank_(finding.severity));
        }, 0);
        var first = byBucket[bucket].reduce(function(oldest, finding) {
          var episode = state.buckets[bucket].episodes[finding.kind] || {};
          var value = new Date(episode.firstSeenAt || now).getTime();
          return Math.min(oldest, isFinite(value) ? value : now.getTime());
        }, Infinity);
        return {bucket: bucket, findings: byBucket[bucket], severity: highest, firstSeenAt: first};
      }).sort(function(left, right) {
        return right.severity - left.severity || left.firstSeenAt - right.firstSeenAt ||
          left.bucket.localeCompare(right.bucket);
      });
      var selected = candidates.slice(0, NOTIFY_MAX_MAILS_PER_EVALUATION_);
      var result = {sent: 0, skipped: 0, failed: 0,
        deferred: Math.max(0, candidates.length - selected.length)};
      var customersById = opts.customersById || {};
      var at = notificationIso_(now);

      selected.forEach(function(candidate) {
        var recipients = notificationRecipients_(candidate.bucket, customersById, opts.effectiveUser || '');
        if (!recipients.length) {
          state.global.lastFailure = {at: at, reason: 'NO_RECIPIENT'};
          result.failed += 1;
          return;
        }
        var limit = Number(SETTINGS.MAX_EMAILS_PER_DAY) || 80;
        var remaining = 0;
        try { remaining = Number(MailApp.getRemainingDailyQuota()); }
        catch (ignored) { remaining = 0; }
        if (Number(state.global.sentToday || 0) + recipients.length > limit || remaining < recipients.length) {
          var skippedBefore = state.global.quota && Number(state.global.quota.skipped || 0) || 0;
          state.global.quota = {exhaustedAt: at, skipped: skippedBefore + 1};
          result.skipped += 1;
          Logger.log('[notify] skipped: quota (' + (remaining < recipients.length ? 'remaining' : 'daily') + ')');
          return;
        }
        var excluded = {};
        candidate.findings.forEach(function(item) { excluded[item.kind] = true; });
        var currentContinuing = evaluated.continuing.filter(function(item) {
          return String(item.bucket || 'SYSTEM') === candidate.bucket;
        });
        // 現在の所見は元の文言で載せる。保存済みの要約まで足すと同じ kind が
        // 2 行になり、件数の増加と誤読されるため、両方を除外対象にする。
        currentContinuing.forEach(function(item) { excluded[item.kind] = true; });
        var continuing = currentContinuing.concat(
          notificationStoredContinuing_(state.buckets[candidate.bucket], excluded, now));
        var customer = customersById[candidate.bucket] || {};
        var quotaSkipped = state.global.quota && Number(state.global.quota.skipped || 0) || 0;
        var mail = composeNotificationMail_(candidate.bucket, candidate.findings, continuing, {
          customerName: customer.customerName || candidate.bucket,
          now: now, source: opts.source || 'TICK', runId: opts.runId || null,
          links: opts.links || null, episodes: state.buckets[candidate.bucket].episodes,
          quotaSkipped: quotaSkipped,
          customerMasterUnavailable: Boolean(opts.customerMasterUnavailable || opts.customersById === null),
          codeVersion: VERSIONS.CODE
        });
        var sent = sendNotificationMail_(recipients, mail);
        if (!sent.sent) {
          state.global.lastFailure = {at: at, reason: sent.reason, detail: sent.detail};
          result.failed += 1;
          return;
        }
        candidate.findings.forEach(function(item) {
          var episode = state.buckets[candidate.bucket].episodes[item.kind];
          var fingerprint = notificationFingerprint_(item.elements || []);
          episode.fingerprint = fingerprint.fingerprint;
          episode.fingerprintHash = fingerprint.fingerprintHash;
          episode.elementCount = fingerprint.elementCount;
          episode.severity = item.severity;
          episode.lastSentAt = at;
          episode.sentCount = Number(episode.sentCount || 0) + 1;
        });
        state.global.sentToday = Number(state.global.sentToday || 0) + recipients.length;
        state.global.lastSent = {at: at, subject: mail.subject.slice(0, 120)};
        if (quotaSkipped) state.global.quota = null;
        result.sent += 1;
      });
      writeNotificationState_(state, now);
      return result;
    });
  } catch (error) {
    if (error && error.code === 'LEASE_CONFLICT') {
      Logger.log('[notify] skipped: lock');
      return {sent: 0, skipped: 0, failed: 0, deferred: 0};
    }
    Logger.log('[notify] dispatchNotifications_ failed: ' + (error && error.stack ? error.stack : String(error)));
    return {sent: 0, skipped: 0, failed: 1, deferred: 0};
  }
}

function readNotificationState_() {
  var values = PropertiesService.getScriptProperties().getProperties();
  var global = notificationGlobalInitial_();
  var buckets = {};
  var raw = {};
  var rawGlobal = values[NOTIFY_STATE_PROPERTY_] || null;
  if (rawGlobal) {
    try {
      var parsedGlobal = JSON.parse(rawGlobal);
      if (parsedGlobal && parsedGlobal.version === 1) global = Object.assign(global, parsedGlobal);
      else Logger.log('[notify] invalid state: ' + NOTIFY_STATE_PROPERTY_);
    } catch (error) { Logger.log('[notify] invalid state: ' + NOTIFY_STATE_PROPERTY_); }
  }
  Object.keys(values).forEach(function(key) {
    if (key.indexOf(NOTIFY_BUCKET_PROPERTY_PREFIX_) !== 0) return;
    var bucket = key.slice(NOTIFY_BUCKET_PROPERTY_PREFIX_.length);
    raw[bucket] = values[key];
    try {
      var parsed = JSON.parse(values[key]);
      if (parsed && parsed.version === 1) {
        if (!parsed.episodes || typeof parsed.episodes !== 'object') parsed.episodes = {};
        if (!parsed.watch || typeof parsed.watch !== 'object') parsed.watch = {};
        buckets[bucket] = parsed;
      } else {
        buckets[bucket] = notificationBucketInitial_();
        Logger.log('[notify] invalid state: ' + key);
      }
    } catch (error) {
      buckets[bucket] = notificationBucketInitial_();
      Logger.log('[notify] invalid state: ' + key);
    }
  });
  return {global: global, buckets: buckets, raw: raw, rawGlobal: rawGlobal};
}

function writeNotificationState_(state, now) {
  var properties = PropertiesService.getScriptProperties();
  var buckets = state.buckets || {};
  Object.keys(buckets).sort().forEach(function(bucket) {
    var collected = garbageCollectNotificationState_(buckets[bucket], now, bucket);
    buckets[bucket] = collected;
    var hasEpisodes = collected.episodes && Object.keys(collected.episodes).length;
    var hasWatch = collected.watch && Object.keys(collected.watch).length;
    var key = NOTIFY_BUCKET_PROPERTY_PREFIX_ + bucket;
    if (!hasEpisodes && !hasWatch) {
      if (state.raw && state.raw[bucket] !== undefined) properties.deleteProperty(key);
      return;
    }
    var serialized = JSON.stringify(collected);
    if (!state.raw || state.raw[bucket] !== serialized) properties.setProperty(key, serialized);
  });
  Object.keys(state.raw || {}).forEach(function(bucket) {
    if (buckets[bucket]) return;
    properties.deleteProperty(NOTIFY_BUCKET_PROPERTY_PREFIX_ + bucket);
  });
  var global = Object.assign(notificationGlobalInitial_(), state.global || {});
  global.version = 1;
  if (global.lastSent) global.lastSent = {at: global.lastSent.at || null,
    subject: String(global.lastSent.subject || '').slice(0, 120)};
  if (global.lastFailure) {
    global.lastFailure = {at: global.lastFailure.at || null,
      reason: String(global.lastFailure.reason || '')};
    if (state.global.lastFailure.detail !== undefined) {
      global.lastFailure.detail = String(state.global.lastFailure.detail || '').slice(0, 200);
    }
  }
  // 日本語は1文字3バイトなので文字数上限だけでは1KBを越え得る。全体キーを
  // 常に小さく保つため、診断用detailだけを末尾から縮める。
  while (utf8Bytes(JSON.stringify(global)).length >= 1024 && global.lastFailure &&
      global.lastFailure.detail) {
    global.lastFailure.detail = global.lastFailure.detail.slice(0, -1);
  }
  properties.setProperty(NOTIFY_STATE_PROPERTY_, JSON.stringify(global));
}

function garbageCollectNotificationState_(bucketState, now, bucket) {
  var state = notificationClone_(bucketState || notificationBucketInitial_());
  state.version = 1;
  if (!state.episodes || typeof state.episodes !== 'object') state.episodes = {};
  if (!state.watch || typeof state.watch !== 'object') state.watch = {};
  var nowMs = now.getTime();
  Object.keys(state.episodes).forEach(function(kind) {
    var episode = state.episodes[kind] || {};
    var lastSeen = new Date(episode.lastSeenAt).getTime();
    var twice = notificationRepeatMilliseconds_(episode.severity || 'CRITICAL') * 2;
    if (!isFinite(lastSeen) || nowMs - lastSeen > twice) delete state.episodes[kind];
  });
  var watchKeys = Object.keys(state.watch).sort(function(left, right) {
    return Number(state.watch[right] || 0) - Number(state.watch[left] || 0) || left.localeCompare(right);
  });
  watchKeys.slice(NOTIFY_MAX_WATCH_ENTRIES_).forEach(function(key) { delete state.watch[key]; });

  function bytes() { return utf8Bytes(JSON.stringify(state)).length; }
  if (bytes() <= NOTIFY_STATE_MAX_BYTES_) return state;
  Object.keys(state.episodes).map(function(kind) {
    return {kind: kind, at: new Date(state.episodes[kind].lastSeenAt).getTime()};
  }).filter(function(item) { return isFinite(item.at) && item.at < nowMs; })
    .sort(function(left, right) { return left.at - right.at; }).some(function(item) {
      delete state.episodes[item.kind];
      return bytes() <= NOTIFY_STATE_MAX_BYTES_;
    });
  if (bytes() <= NOTIFY_STATE_MAX_BYTES_) return state;
  Object.keys(state.episodes).forEach(function(kind) { state.episodes[kind].fingerprint = []; });
  if (bytes() <= NOTIFY_STATE_MAX_BYTES_) return state;
  var minimal = {};
  Object.keys(state.episodes).forEach(function(kind) {
    var episode = state.episodes[kind];
    if (!episode.lastSentAt) return;
    minimal[kind] = {
      fingerprintHash: episode.fingerprintHash,
      elementCount: episode.elementCount,
      severity: episode.severity,
      lastSentAt: episode.lastSentAt,
      firstSeenAt: episode.firstSeenAt,
      lastSeenAt: episode.lastSeenAt
    };
  });
  state = {version: 1, episodes: minimal};
  Logger.log('[notify] bucket ' + String(bucket || '') + ' reduced to minimal form');
  return state;
}

function readNotificationWatch_(state) {
  try {
    var source = state || readNotificationState_();
    var result = {};
    Object.keys(source.buckets || {}).forEach(function(bucket) {
      Object.keys(source.buckets[bucket].watch || {}).forEach(function(id) {
        result[id] = Number(source.buckets[bucket].watch[id] || 0);
      });
    });
    return result;
  } catch (error) {
    Logger.log('[notify] readNotificationWatch_ failed: ' + (error && error.stack ? error.stack : String(error)));
    return null;
  }
}

function effectiveUserEmail_() {
  try {
    var user = Session.getEffectiveUser();
    return user && user.getEmail ? String(user.getEmail() || '') : '';
  } catch (ignored) { return ''; }
}

function notificationStatusLines_(globalState, now, triggerCount) {
  var state = globalState || notificationGlobalInitial_();
  var first = '■ メール通知: ';
  if (state.lastSent) {
    var subject = String(state.lastSent.subject || '');
    var colon = subject.indexOf(': ');
    first += '最終送信 ' + notificationMinute_(state.lastSent.at) + '（' +
      (colon >= 0 ? subject.slice(colon + 2) : subject) + '）';
  } else first += '最終送信 なし';
  first += '／ 監視トリガー: ' + Number(triggerCount || 0) + ' 件';
  var second = '  直近の失敗: ' + (state.lastFailure ?
    notificationMinute_(state.lastFailure.at) + ' ' + String(state.lastFailure.reason || '') : 'なし');
  if (state.quota) second += '／ クォータ上限で ' + Number(state.quota.skipped || 0) + ' 件を送れていません';
  return [first, second];
}

function notificationWatchdogTick() {
  try {
    loadSettingsFromProperties();
    return notifyImportState_({now: new Date(), source: 'WATCHDOG'});
  } catch (error) {
    Logger.log('[notify] notificationWatchdogTick failed: ' + (error && error.stack ? error.stack : String(error)));
    return {sent: 0, skipped: 0, failed: 1, deferred: 0};
  }
}

function removeNotificationWatchdogTriggers_() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() !== NOTIFICATION_WATCHDOG_HANDLER_) return;
    ScriptApp.deleteTrigger(trigger);
    removed += 1;
  });
  return removed;
}

function opsStartNotificationWatchdog() {
  loadSettingsFromProperties();
  var removed = removeNotificationWatchdogTriggers_();
  var trigger = ScriptApp.newTrigger(NOTIFICATION_WATCHDOG_HANDLER_).timeBased().everyHours(1).create();
  var result = {started: true, removedExisting: removed, triggerId: trigger.getUniqueId()};
  Logger.log(JSON.stringify(result));
  return result;
}

function opsStopNotificationWatchdog() {
  var result = {stopped: true, removed: removeNotificationWatchdogTriggers_()};
  Logger.log(JSON.stringify(result));
  return result;
}

function opsSendTestNotification() {
  var to = effectiveUserEmail_();
  var now = new Date();
  var result;
  if (!to) result = {sent: false, to: '', remainingQuota: 0, error: 'NO_RECIPIENT'};
  else {
    var sent = sendNotificationMail_([to], {subject: NOTIFY_SUBJECT_PREFIX_ + ' テスト送信',
      body: '時刻: ' + notificationMinute_(now) + '\nコード版: ' + VERSIONS.CODE});
    var remaining = 0;
    try { remaining = Number(MailApp.getRemainingDailyQuota()); } catch (ignored) { remaining = 0; }
    result = sent.sent ? {sent: true, to: to, remainingQuota: remaining} :
      {sent: false, to: to, remainingQuota: remaining, error: sent.detail || sent.reason};
  }
  Logger.log(JSON.stringify(result));
  return result;
}

function opsShowNotificationState() {
  var state = readNotificationState_();
  var out = {global: state.global, buckets: state.buckets};
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

function opsResetNotificationState() {
  var properties = PropertiesService.getScriptProperties();
  var all = properties.getProperties();
  var deleted = 0;
  Object.keys(all).forEach(function(key) {
    if (key !== NOTIFY_STATE_PROPERTY_ && key.indexOf(NOTIFY_BUCKET_PROPERTY_PREFIX_) !== 0) return;
    properties.deleteProperty(key);
    deleted += 1;
  });
  var result = {deleted: deleted};
  Logger.log(JSON.stringify(result));
  return result;
}

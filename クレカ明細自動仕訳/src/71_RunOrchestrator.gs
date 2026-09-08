'use strict';

/**
 * 6.1 明細取込の実行結線（ステップ1〜8-10と、状態遷移・後始末）。
 *
 * 区分判定と書込は`70_ImportFlow`（8-11〜9-8）に委ね、本モジュールは
 * **材料集め**だけを行う：発見（4.8）→読取（4.10）→判定（4.11）→
 * 抽出（4.13）→補完（4.15）→検証材料（4.14）→転記先検証（4.22)→
 * 重複（4.21）→取引ID（4.20）→取引先判定（4.17）。
 *
 * まだ結線していないもの（正直な残り）：
 *   - 継続トリガー（4.35）。時間上限に達したら新規ファイルを開始せず、
 *     残りを`DISCOVERED`のまま報告して終える（再実行で続きが処理される）。
 *   - 通知（4.5）・メトリクス（4.36）・並行比較（8-12）。
 */

/** 4.37 仕様23.6：セル数で容量を測る。 */
function measureSpreadsheetCells_(spreadsheetId) {
  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  var cells = spreadsheet.getSheets().reduce(function(sum, sheet) {
    return sum + sheet.getMaxRows() * sheet.getMaxColumns();
  }, 0);
  var limit = SETTINGS.SPREADSHEET_CELL_LIMIT;
  return {cells: cells, limit: limit, percent: limit ? cells / limit * 100 : 0};
}

/** 6.1 step 3：3スプレッドシートを個別に判定する。 */
function checkLogCapacityForRun_() {
  var targets = [
    {name: 'master', id: masterSpreadsheet_().getId()},
    {name: 'txIndex', id: SETTINGS.TX_INDEX_SPREADSHEET_ID},
    {name: 'snapshot', id: SETTINGS.SNAPSHOT_SPREADSHEET_ID}
  ];
  var exceeded = [];
  targets.forEach(function(target) {
    if (!target.id) return;
    var usage = measureSpreadsheetCells_(target.id);
    if (usage.percent >= SETTINGS.LOG_CAPACITY_STOP_PERCENT) {
      exceeded.push({name: target.name, percent: usage.percent});
    }
  });
  return {ok: exceeded.length === 0, exceeded: exceeded};
}

/** 使用用途補完マスターを読む（2.1.3）。 */
function purposeRulesForRun_() {
  return readSheetRows_(
    requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.PURPOSE_COMPLEMENT), 10)
    .filter(function(row) { return String(row.values[0] || '') !== ''; })
    .map(function(row) {
      return {ruleId: String(row.values[0]), keyword: String(row.values[1] || ''),
        purpose: String(row.values[2] || ''), enabled: row.values[3]};
    });
}

/** 共通取引先一覧を読む（2.1.4）。 */
function commonPartnersForRun_() {
  return readSheetRows_(
    requireSheet_(masterSpreadsheet_(), CONFIG.SHEET_NAMES.COMMON_PARTNER_LIST), 6)
    .filter(function(row) { return String(row.values[0] || '') !== ''; })
    .map(function(row) {
      return {partnerId: String(row.values[0]), partnerName: String(row.values[1] || '')};
    });
}

/** 有効な形式定義のF列キーワードの和集合（5.2 判定3の材料）。 */
function detectionKeywordUnion_(definitions) {
  var keywords = [];
  definitions.forEach(function(definition) {
    if (!definition.valid || !definition.keywordRule) return;
    ['allOf', 'anyOf'].forEach(function(key) {
      (definition.keywordRule[key] || []).forEach(function(condition) {
        (condition.keywords || []).forEach(function(keyword) {
          if (keywords.indexOf(keyword) < 0) keywords.push(keyword);
        });
      });
    });
  });
  return keywords;
}

/** 6.1 step 4：事前整合性チェック（顧客単位・ファイルごとの3者照合）。 */
function runCustomerIntegrityCheck_(customer, index) {
  var findings = [];
  permanentIndexRowsForScan_()
    .filter(function(row) { return row.customerId === customer.customerId; })
    .forEach(function(row) {
      var txLogs = getTransactionsByStatus(row.fileId, [
        TX_STATUS.PREPARED, TX_STATUS.WRITING, TX_STATUS.COMMITTED,
        TX_STATUS.REVIEW_REQUIRED
      ]);
      var processRecord = getProcessLogRecord_(row.fileId);
      var outcome = runIntegrityCheck({
        index: index,
        txLogs: txLogs,
        fileState: row.state,
        processLogState: processRecord ?
          String(processRecord.values[PROCESS_FIELD_COLUMNS_.internalState - 1]) : null,
        permanentIndexState: row.state
      });
      findings = findings.concat(outcome.findings);
    });
  return {ok: findings.length === 0,
    stop: findings.some(function(f) { return f.severity === 'STOP'; }),
    findings: findings};
}

/**
 * 実行の入口（6.1 step 1〜7'）。
 *
 * @param {!Object=} options
 *   {customerIds, fileIds, maxFilesPerCustomer, now}
 * @return {!Object} 実行レポート
 */
function runImport(options) {
  var opts = options || {};
  var runId = generateId('RUN');
  var startedAt = Date.now();
  var report = {runId: runId, customers: [], stoppedBy: null};

  // Script Propertiesの導入設定を読む。GASの実行はグローバルを保持しない
  // ため、**毎実行の最初に読み直さないと`SETTINGS`は既定値のまま**であり、
  // 設定検証（step 2）が「未設定」で必ず落ちる。
  loadSettingsFromProperties();

  // step 1：認可。メニュー実行者が担当する顧客だけを対象にする。
  var user = activeUserEmail_();
  var customers = getAuthorizedCustomers(user);
  if (Array.isArray(opts.customerIds) && opts.customerIds.length) {
    customers = customers.filter(function(customer) {
      return opts.customerIds.indexOf(customer.customerId) >= 0;
    });
  }
  if (!customers.length) {
    report.stoppedBy = 'NO_AUTHORIZED_CUSTOMER';
    return report;
  }

  // step 2：設定検証（IMPORTスコープ。無関係な検査で止めない。CR-5）。
  var settings = validateSettings(VALIDATION_SCOPE.IMPORT, {
    customerFolderIds: customers.map(function(c) { return c.sourceFolderId; }),
    corpusFolderAccessible: true,
    corpusFolderAncestors: []
  });
  if (!settings.ok) {
    report.stoppedBy = 'SETTINGS_INVALID';
    report.settingsProblems = settings.problems;
    return report;
  }

  // step 3：容量チェック。停止閾値超なら書込を始めない。
  var capacity = checkLogCapacityForRun_();
  if (!capacity.ok) {
    report.stoppedBy = 'LOG_CAPACITY_EXCEEDED';
    report.capacity = capacity.exceeded;
    return report;
  }

  // 実行時間の予算。上限接近後は新規ファイルを開始しない（step 10の縮退。
  // 継続トリガーは未結線であり、残りは`DISCOVERED`のまま次回実行に委ねる）。
  var budgetSeconds = Number(SETTINGS.EXECUTION_TIMEOUT_SECONDS);
  var deadline = Number.isFinite(budgetSeconds) && budgetSeconds > 0 ?
    startedAt + Math.max(1, budgetSeconds - Number(SETTINGS.SAFETY_MARGIN_SECONDS || 0)) * 1000 :
    null;

  customers.forEach(function(customer) {
    var customerReport = {customerId: customer.customerId, files: [], skipped: null};
    report.customers.push(customerReport);
    try {
      // step 7：名称変更の再試行。1件の例外で顧客ループを中断しない。
      retryPendingRenames(customer.customerId);

      // step 4：事前整合性チェック（監査ログ連鎖は通知のみ。INV-29）。
      var index = buildIndex(customer, {});
      var integrity = runCustomerIntegrityCheck_(customer, index);
      customerReport.integrity = integrity;
      var audit = verifyChain('RECENT');
      if (audit && audit.ok === false) {
        customerReport.auditChain = 'BROKEN_NOTIFY_ONLY';
      }
      if (integrity.stop) {
        customerReport.skipped = 'INTEGRITY_STOP';
        return;
      }

      // step 5：未処理ファイル検索（モード1）。
      var candidates = scanUnprocessedFiles(customer.customerId, {now: opts.now});
      // step 6：担当者のファイル選択（メニュー）。指定があれば絞る。
      if (Array.isArray(opts.fileIds) && opts.fileIds.length) {
        candidates = candidates.filter(function(candidate) {
          return opts.fileIds.indexOf(candidate.fileId) >= 0;
        });
      }
      var maxFiles = Number(opts.maxFilesPerCustomer);
      if (Number.isInteger(maxFiles) && maxFiles > 0) {
        candidates = candidates.slice(0, maxFiles);
      }

      // step 8以降：ファイルループ。
      candidates.forEach(function(candidate) {
        if (deadline && Date.now() >= deadline) {
          customerReport.files.push({fileId: candidate.fileId, outcome: 'DEFERRED_TIME_BUDGET'});
          return;
        }
        // 1ファイルの所要時間を報告に残す。6分上限に当たったとき、どの
        // ファイルのどの段階で溶けたのかを知る材料がこれしかない。
        var fileStartedAt = Date.now();
        var fileOutcome = processDiscoveredFile_(runId, customer, candidate, opts);
        fileOutcome.elapsedMs = Date.now() - fileStartedAt;
        customerReport.files.push(fileOutcome);
      });
    } catch (error) {
      customerReport.skipped = (error && error.code) || 'CUSTOMER_ERROR';
      customerReport.error = String(error && error.message);
    }
  });

  return report;
}

/**
 * ファイル1件の処理（6.1 step 8-1〜9-13の結線）。
 *
 * 材料を集めて`processFile`（70）へ渡し、返った`nextState`に従って
 * 状態を遷移させる。例外は`FAILED`へ落としてリースを解放し、呼出側の
 * ループを止めない。
 */
function processDiscoveredFile_(runId, customer, candidate, options) {
  var fileId = candidate.fileId;
  var fileName = candidate.name;
  var outcome = {fileId: fileId, fileName: fileName, outcome: null, nextState: null};
  var leaseId = null;
  var stateNow = null;

  try {
    // 8-1：リース取得。
    leaseId = acquireLease(customer.customerId, fileId, runId,
      activeUserEmail_(), LEASE_PURPOSE.PROCESS);
  } catch (error) {
    outcome.outcome = 'LEASE_CONFLICT';
    return outcome;
  }

  try {
    var definitions = loadFormatDefinitions({status: 'active', enabled: true});
    var validDefinitions = definitions.filter(function(row) { return row.valid === true; });
    var invalidDefinitions = definitions.filter(function(row) { return row.valid !== true; });

    // 8-2：読取。失敗コードは区分2の材料として`processFile`へ渡す。
    var read = null;
    var readFailure = null;
    try {
      read = readFile(fileId, fileName, {
        expectedKeywords: detectionKeywordUnion_(validDefinitions)
      });
    } catch (error) {
      var code = error && error.code;
      if (code === 'INPUT_LIMIT_EXCEEDED' || code === 'ENCODING_DETECTION_FAILED' ||
          code === 'CSV_PARSE_FAILED') {
        readFailure = code;
      } else {
        throw error;
      }
    }
    var binaryHash = read ? sha256Hex(read.bytes) : '';

    // 処理ログ・恒久ファイルインデックスへ登録し、`VALIDATING`にする。
    var existing = getProcessLogRecord_(fileId);
    createOrUpdateProcessLog(runId, customer, {
      id: fileId,
      originalFileName: fileName,
      binaryHash: binaryHash,
      hashVersion: VERSIONS.HASH,
      state: FILE_STATE.VALIDATING,
      revision: candidate.revisionId || '',
      updatedAt: candidate.modifiedTime || ''
    });
    stateNow = FILE_STATE.VALIDATING;
    updateFilePrefix(fileId);

    var validation = {};
    var transactions = [];
    var cardFormat = null;
    var parsed = null;
    var resolvedSheet = null;

    if (readFailure) {
      if (readFailure === 'INPUT_LIMIT_EXCEEDED') {
        validation.inputLimit = {ok: false, cumulative: null, limit: null};
      } else {
        validation.encoding = {ok: false, code: readFailure};
      }
    } else {
      // 8-3：形式判定（全シート個別→集約→版ピン留め）。
      var permanent = getPermanentFileIndexRecord_(fileId);
      var targetSheetName = permanent ? String(permanent.values[12] || '') : '';
      var detections = read.sheets.map(function(sheet) {
        return {
          sheetName: sheet.name,
          candidates: detectFormatWith(validDefinitions, sheet, read.fileType, fileName)
        };
      });
      var aggregated = aggregateSheetDetections(detections, {
        origin: 'FILE', fileName: fileName, fileType: read.fileType,
        targetSheetName: targetSheetName || null, sourceId: fileId
      });
      if (invalidDefinitions.length) {
        recordError(fileId, {code: 'CARD_FORMAT_DEFINITION_INVALID',
          detail: invalidDefinitions.map(function(row) { return row.formatId; }).join(',')});
      }

      if (aggregated.status !== 'RESOLVED') {
        validation.format = {ok: false, code: aggregated.status, detail: aggregated.detail};
      } else {
        validation.format = {ok: true, code: null};
        cardFormat = pinFormatVersion(aggregated.formatId, aggregated.formatVersion);
        resolvedSheet = read.sheets.filter(function(sheet) {
          return sheet.name === aggregated.sheetName;
        })[0] || read.sheets[0];

        // 8-4：抽出と打切り検証。
        parsed = parseFile(resolvedSheet, cardFormat, {
          customerId: customer.customerId, fileId: fileId,
          fileNameOriginal: fileName,
          fileRevision: candidate.revisionId || '', regeneration: 0
        });
        validation.scanTruncation = parsed.truncation;
        validation.effectiveTransactionCount = parsed.txs.length;

        // 取引IDの生成（8-9の前倒し）。IDの生成要素（ファイルID・シート名・
        // 物理行番号・世代）は日付・年補完に依存しないため、8-6の要確認が
        // 取引IDで宛先を持てるようにここで確定する（INV-23に影響しない）。
        var pairs = [];
        transactions = parsed.txs.map(function(tx) {
          var generated = generateTransactionId({
            customerId: tx.customerId, fileId: tx.fileId,
            sourceSheetName: tx.sourceSheet === null ? '' : tx.sourceSheet,
            sourceRow: tx.sourceRow, generation: tx.regeneration
          });
          pairs.push({full: generated.full, display: generated.display});
          return Object.assign({}, tx, {
            transactionId: generated.full,
            fullTxId: generated.full,
            displayTxId: generated.display
          });
        });
        var collisions = detectDisplayIdCollision(customer, pairs);
        if (collisions.length) {
          throw makeCatalogError_('TRANSACTION_ID_COLLISION',
            'Display id collision: ' + collisions[0].display);
        }

        // 8-5：使用用途補完（元ファイル名で判定する。5.4）。
        var purposeOutcome = resolvePurposes(transactions, fileName, purposeRulesForRun_());
        transactions = purposeOutcome.txs;
        validation.purposeResolution = {unresolvedCount: purposeOutcome.unresolvedCount};

        // 8-6：締め年月→年補完→日付選別→件数合計照合。
        var billing = extractBillingYearMonth(resolvedSheet, fileName, cardFormat);
        var yearInference = inferYearsForFile(transactions, billing, cardFormat);
        transactions = yearInference.txs;
        validation.yearInference = yearInference;
        var processingDate = options && options.now ? new Date(options.now) : new Date();
        validation.dateTriage = applyDateTriageChecks(transactions, billing, processingDate);

        // 金額を読めなかった行は0円として照合し、差分はCOUNT_TOTAL_MISMATCH
        // として管理者へ出す（黙って照合を外すと過少計上を検出できない）。
        var reconcilable = transactions.map(function(tx) {
          return tx.amountBillingJpy === null ?
            Object.assign({}, tx, {amountBillingJpy: 0}) : tx;
        });
        validation.countsTotals = verifyCountsAndTotals(
          reconcilable, cardFormat, resolvedSheet, getProcessLogRecord_(fileId));

        // 8-6'：前年利用日（INDIVIDUALのみ。空欄化対象を除外する。INV-40）。
        validation.priorYear = checkPriorYearUsage(transactions, customer,
          blankedDateTransactionIds(yearInference, validation.dateTriage));

        // 8-8：重複・修正版候補。
        var contentHash = generateContentHash(transactions,
          resolvedSheet.name === null ? '' : String(resolvedSheet.name));
        var indexRows = permanentIndexRowsForScan_()
          .filter(function(row) { return row.fileId !== fileId; })
          .map(function(row) {
            return {customerId: row.customerId, fileId: row.fileId,
              contentHash: row.contentHash, hashVersion: row.hashVersion, active: true};
          });
        validation.duplicate = checkDuplicateFile(
          customer.customerId, contentHash, VERSIONS.HASH, indexRows);
        transactions = transactions.map(function(tx) {
          return Object.assign({}, tx, {
            identityHash: generateIdentityHash(tx),
            contentHash: contentHash
          });
        });
        try {
          validation.purposeRevision = checkPurposeRevisionCandidate(
            customer.customerId,
            transactions.map(function(tx) { return tx.identityHash; }),
            contentHash, VERSIONS.HASH,
            queryTxIndex(customer.customerId, {purpose: 'FREEE_PENDING'}), {});
        } catch (error) {
          // 取引インデックスのシートが未作成の初回実行では候補なしとする。
          validation.purposeRevision = {candidate: false};
        }
        updateProcessLog(fileId, {
          formatId: cardFormat.formatId,
          sourceSheetName: resolvedSheet.name === null ? '' : String(resolvedSheet.name),
          submittedContentHash: contentHash,
          currentContentHash: contentHash,
          billingYearMonth: billing.status === DATE_INFERENCE_STATUS.RESOLVED ?
            billing.year + '-' + (billing.month < 10 ? '0' : '') + billing.month : '',
          billingEvidence: JSON.stringify(billing),
          excludedCount: parsed.excludedRows.length,
          readCount: parsed.txs.length
        });
        recordVersions(fileId, {codeVersion: VERSIONS.CODE, formatVersion: cardFormat.version,
          hashVersion: VERSIONS.HASH, sheetSchemaVersion: VERSIONS.SHEET_SCHEMA});
        // 恒久ファイルインデックスF列（明細内容ハッシュ・提出時点で不変）を
        // 同期する。ここが空のままだと、同一内容の再提出が重複として
        // 検出できない（仕様12.2は本シートだけで完結する。INV-05）。
        syncPermanentContentHash(fileId, contentHash);

        // 8-7：転記先構成検証（`WRITING`遷移前）。
        var destinationIndex = buildIndex(customer, {});
        validation.destinationSchema = validateDestinationSchema(customer, destinationIndex);

        // 8-10：店名正規化・取引先判定（メモリ上のみ。登録は9-8）。
        var dictionary = buildDictionaryIndex(customer.customerId, {
          customer: readDictionary_(false),
          common: readDictionary_(true),
          commonPartners: commonPartnersForRun_()
        });
        // 年会費のように、明細の店名にカード会社が現れない取引がある
        // （実装差戻し#31）。そのファイルがどのカードのものかは形式が知って
        // いるので、1度だけ解決して照合キーに使う。取れない形式では null。
        var cardName = resolveCardName(resolvedSheet, cardFormat,
          {fileName: fileName, folderName: candidate.folderName || null});

        transactions = transactions.map(function(tx) {
          // 顧客マスターAM列の用途は取引先を立てない（実装差戻し#30）。
          // 照合もしない ── 結果を使わないうえ、辞書の件数ぶん無駄に回る。
          // カード会社からの返金（AO列）にも相手取引先は無い。
          var cashback = isCashbackMerchant(customer, tx.merchantOriginal);
          var exempt = cashback || isPartnerExemptPurpose(customer, tx.purpose);
          // AN列の用途は、店名ではなくカード名で取引先を照合する。
          // 「基本カード年会費」はどのカードでも同じ文字列なので、店名で
          // 辞書を作ると全カードの年会費が1つの取引先へ潰れる。
          var matchKey = !exempt && cardName &&
            isCardNamePartnerPurpose(customer, tx.purpose) ? cardName : null;
          var forMatching = matchKey
            ? Object.assign({}, tx, {merchantOriginal: matchKey, originalMerchant: matchKey})
            : tx;
          var match = exempt ? null : matchPartner(forMatching, customer.customerId, dictionary);
          var resolved = !exempt && match && match.autoConfirm === true;
          var planned = {
            b: tx.date ? toTokyoDateString_(tx.date) : '',
            f: resolved ? String(match.partnerName) : '',
            i: composeMemoTags(tx.purpose, memoTagsForTransaction(tx, customer)),
            k: tx.merchantOriginal || '',
            m: tx.amountBillingJpy
          };
          return Object.assign({}, tx, {
            partnerResolutionStatus: exempt ? PARTNER_STATUS.RESOLVED_WITHOUT_PARTNER :
              (resolved ? PARTNER_STATUS.RESOLVED_WITH_PARTNER : PARTNER_STATUS.UNRESOLVED),
            partnerMatch: match,
            // 照合キーが店名と違う場合、要確認にもそれを見せる ── 担当者が
            // 判断するのは「このカードの取引先は何か」であって、「基本カード
            // 年会費」という文字列ではない。K列へ書く元店名は変えない。
            partnerMatchKey: matchKey,
            merchantNormalized: normalizeMerchant(matchKey || tx.merchantOriginal || ''),
            planned: planned,
            originalDate: tx.dateRawText,
            originalMerchant: tx.merchantOriginal,
            originalAmount: tx.amountBillingJpy,
            originalPurpose: tx.purpose
          });
        });
      }
    }

    // 8-11以降は70へ。9-1（VALIDATING→WRITING）はフックで遷移させる。
    var result = processFile({
      customer: customer,
      file: {id: fileId, name: fileName, originalFileName: fileName},
      runId: runId,
      leaseId: leaseId,
      cardFormat: cardFormat,
      transactions: transactions,
      validation: validation,
      fetchFileRecord: function(id) {
        return {binaryHash: sha256Hex(DriveApp.getFileById(id).getBlob().getBytes())};
      },
      beforeWriteBlock: function() {
        transitionFileState(fileId, FILE_STATE.VALIDATING, FILE_STATE.WRITING, runId);
        stateNow = FILE_STATE.WRITING;
      }
    });

    // 9-12・9-13：`nextState`へ遷移（遷移がリース解放と名称変更を行う）。
    if (result.nextState && result.nextState !== stateNow) {
      transitionFileState(fileId, stateNow, result.nextState, runId);
      stateNow = result.nextState;
    }
    updateProcessLog(fileId, {endedAt: nowIso_(),
      reviewCount: (result.preValidation.pendingReviews || []).length,
      autoCount: (result.write && result.write.written || []).length});

    outcome.outcome = result.wroteToDestination ? 'WRITTEN' : 'NO_WRITE';
    outcome.nextState = stateNow;
    outcome.category = result.preValidation.category;
    outcome.code = result.preValidation.code;
    outcome.written = result.write ? result.write.written.length : 0;
    outcome.reviews = (result.reviewsRegistered || (result.write && result.write.reviewsRegistered) || []).length;
    return outcome;
  } catch (error) {
    // 例外＝`FAILED`。リースを解放し、ループを止めない（6.1の帰着）。
    outcome.outcome = 'FAILED';
    outcome.error = String((error && error.code) || (error && error.message) || error);
    try {
      recordError(fileId, {code: (error && error.code) || 'UNEXPECTED_ERROR',
        detail: String(error && error.message)});
    } catch (ignored) { /* 記録失敗でFAILED遷移を妨げない */ }
    try {
      if (stateNow === FILE_STATE.VALIDATING || stateNow === FILE_STATE.WRITING) {
        transitionFileState(fileId, stateNow, FILE_STATE.FAILED, runId);
        outcome.nextState = FILE_STATE.FAILED;
      }
    } catch (ignored2) { /* 遷移できない場合もリースだけは返す */ }
    try { releaseLease(fileId, runId, 'RUN_FAILURE'); } catch (ignored3) { }
    return outcome;
  }
}

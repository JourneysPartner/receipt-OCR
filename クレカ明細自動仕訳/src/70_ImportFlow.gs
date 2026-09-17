'use strict';

/**
 * 6.1 明細取込（メイン処理フロー）の結線。
 *
 * このモジュールの存在理由は**ブロック境界を1箇所で守ること**である（INV-14）。
 * 事前検証がすべて完了するまで転記先へ1セルも書かない。途中行まで書いた後で
 * 使用用途不足を発見する実装にしない。
 *
 * 区分判定の正本は5.10（`classifyValidationResult`）であり、本モジュールは
 * 判定しない。判定材料を集め、結果に従って書込ブロックへ進むか止まるかを
 * 決めるだけである。
 */

/** 事前検証ブロックの結果。転記先への書込は一切含まない。 */
function preValidationResult_(category, code, transactions, pendingReviews, detail) {
  return {
    category: category,             // 1 | 2 | 3 | null（いずれにも該当しない）
    code: code || null,
    transactions: transactions || [],
    pendingReviews: pendingReviews || [],
    detail: detail || {},
    wroteToDestination: false       // 事前検証ブロックは常に false
  };
}

/**
 * 事前検証ブロック（8-1〜8-13）。
 *
 * **転記先スプレッドシートへ書き込まない。** 取引ログへの`PREPARED`登録
 * （8-13）は行うが、これは転記先ではなくマスター側である。
 *
 * @param {!Object} input
 *   customer, file, runId, leaseId, validation（判定材料一式）, transactions
 * @return {!Object}
 */
function runPreValidationBlock(input) {
  if (!input || !input.customer || !input.file) {
    throw new TypeError('runPreValidationBlock requires customer and file');
  }

  // 8-11：区分判定。区分2 → 区分1 → 区分3の順で評価する（INV-14）。
  // 区分1を先に評価すると、管理者側の構成不備が顧客への差戻しに隠れて
  // 是正されない。
  //
  // 既に承認された区分2要因を判定材料へ供給する（INV-28）。供給しないと、
  // 担当者が承認しても再検証で同じ要因が再検出され、`REVIEW_WAIT`へ戻る
  // 無限ループになる。
  var validation = Object.assign({}, input.validation || {});
  if (validation.validationApprovals === undefined) {
    validation.validationApprovals = getCategory2Approvals(input.file.id);
  }
  // 8-8：取引単位の妥当性判定。8-9：実行単位の入力上限。
  //
  // **呼出側任せにしない。** 材料を呼出側が渡す形だと、渡し忘れたまま
  // 動く期間ができ、その間は検査が存在しないのと同じになる ── 上限は
  // いくらでも超えられ、利用店名の無い行がそのまま流れる。
  if (validation.transactionValidation === undefined) {
    validation.transactionValidation =
      validateTransactions(input.transactions || [], {cardFormat: input.cardFormat});
  }
  if (validation.inputLimit === undefined && input.runId) {
    validation.inputLimit =
      checkRunTransactionLimit(input.runId, (input.transactions || []).length);
  }
  var classification = classifyValidationResult(validation);
  var category = classification.category;

  // 区分1・区分2は無書込で差し戻す。取引ログへも登録しない。
  // ここで登録すると、転記行を持たない孤児の取引ログ行が残る。
  if (category === 1 || category === 2) {
    return preValidationResult_(category, classification.code, [],
      classification.reviewEntries || [], {classification: classification});
  }

  // 区分3以降。要確認の宛先を取引IDで引ける形へ正規化する。
  // 判定材料の`issue`は`transactionId`を持ち、要確認シートは`fullTxId`で
  // 引くため、ここで橋渡ししないと登録が宛先なしになる。
  var pendingReviews = (classification.reviewEntries || []).map(function(entry) {
    var txId = entry.transactionId || entry.fullTxId || null;
    return Object.assign({}, entry, {fullTxId: txId});
  });

  // 8-10の結果を要確認`PARTNER`のエントリへ変換する（9-8で登録される）。
  //
  // これが無いと、辞書に一致しなかった取引は`REVIEW_REQUIRED`かつ
  // `UNRESOLVED`のまま、**解決すべき要確認行が存在しない**。担当者は
  // `ADOPT_EXISTING_PARTNER`も`RESOLVE_WITHOUT_PARTNER`も起動できず、
  // 取引は永久に確定不能になる。
  //
  // **再合流では、辞書が自動確定できるようになっていても要確認を作り直す。**
  // 取引ログに既に`REVIEW_REQUIRED`かつ`UNRESOLVED`で載っている取引は、
  // 前回の実行が9-8の前で殺されたものである（転記行は持つ）。ここで
  // 自動確定扱いにして要確認を作らないと、その取引は書込対象でもない
  // （9-3が書くのはPREPARED/WRITINGだけ）ので、**F列も確定も誰も行わない**
  // ── 2026-09-17、辞書を直した直後の再取込がこの形で止まった。要確認を
  // 作り直せば、採用操作が同じ行へF列を書いて確定する（既存の経路）。
  // 既にOPENの要確認があれば`registerReview`が同じ鍵で抑止するので冪等。
  //
  // 既存行の照会は1回にまとめ、8-13の`registerPrepared`にも渡す（二重読みを
  // 避ける）。ロックの外で引くが、同じファイルの取引IDを作れるのは同じ
  // ファイルの取込だけで、それはファイルのリースが直列化している。
  var parsedIds = (input.transactions || []).map(function(tx) {
    return String(tx.fullTxId || tx.transactionId || '');
  }).filter(function(id) { return id !== ''; });
  var existingById = parsedIds.length ?
    activeTransactionRecordsByIds_(parsedIds) : Object.create(null);
  (input.transactions || []).forEach(function(tx) {
    var existing = existingById[String(tx.fullTxId || tx.transactionId || '')];
    var rejoinedUnresolved = Boolean(existing) &&
      existing.transactionStatus === TX_STATUS.REVIEW_REQUIRED &&
      existing.partnerResolutionStatus === PARTNER_STATUS.UNRESOLVED;
    if (tx.partnerResolutionStatus !== PARTNER_STATUS.UNRESOLVED && !rejoinedUnresolved) return;
    var match = tx.partnerMatch || {};
    pendingReviews.push({
      reviewType: REVIEW_TYPE.PARTNER,
      fullTxId: String(tx.fullTxId || tx.transactionId),
      displayTxId: tx.displayTxId || null,
      sourceRow: tx.sourceRow,
      merchantOriginal: tx.partnerMatchKey || tx.merchantOriginal || tx.originalMerchant || null,
      merchantNormalized: tx.merchantNormalized ||
        normalizeMerchant(String(tx.partnerMatchKey || tx.merchantOriginal ||
          tx.originalMerchant || '')),
      // Q列の候補は2.1.7の形（partnerName / dictId / matchMethod）へ写す。
      // `ruleId`のまま流すと、採用操作が`dictId`を取れず辞書学習と結び付かない。
      candidates: (match.candidates || []).map(function(candidate) {
        return {
          partnerName: candidate.partnerName,
          dictId: candidate.dictId || candidate.ruleId || null,
          matchMethod: candidate.matchMethod || null
        };
      }),
      // Z列は2.1.7.1の必須キーどおり。解決操作がここから判断材料を読む。
      detail: {
        kind: 'PARTNER',
        matchedBy: match.matchedBy === undefined ? null : match.matchedBy,
        candidates: (match.candidates || []).map(function(candidate) {
          return {
            partnerName: candidate.partnerName,
            dictId: candidate.dictId || candidate.ruleId || null,
            matchMethod: candidate.matchMethod || null
          };
        }),
        conflict: Boolean(match.conflict)
      }
    });
  });
  var reviewedTxIds = {};
  pendingReviews.forEach(function(entry) {
    if (entry.fullTxId && isTransactionScopedReviewType(entry.reviewType)) {
      reviewedTxIds[String(entry.fullTxId)] = true;
    }
  });
  var blankDate = {};
  (classification.blankDateTxIds || []).forEach(function(id) { blankDate[String(id)] = true; });

  // 8-12：予定B列値の空欄化（INV-33）と予定最終状態の導出。
  //
  // **システムが確定できなかった日付を顧客のfreee出納帳へ出さない。**
  // 推定値を書いてしまうと、担当者はそれが推定であることを知らずに
  // freeeへ取り込む。空欄なら必ず気づく。
  var transactions = (input.transactions || []).map(function(tx) {
    var txId = String(tx.fullTxId || tx.transactionId);
    var planned = Object.assign({}, tx.planned || {});
    if (blankDate[txId]) planned.b = '';
    return Object.assign({}, tx, {
      planned: planned,
      plannedFinalStatus: derivePlannedFinalStatus({
        hasOpenReview: reviewedTxIds[txId] === true,
        plannedB: planned.b,
        partnerResolutionStatus: tx.partnerResolutionStatus
      })
    });
  });

  // 8-13：取引ログへ`PREPARED`で一括登録し、実行単位の累積件数へ加算する。
  // 既存行の扱いは「再合流時の取引再登録」に従う（A-28。61_TransactionLog）。
  // 加算を永続化しないと、継続トリガーで再開したときに0から数え直し、
  // 上限がいくらでも超えられる（4.31）。
  if (transactions.length) {
    registerPrepared(transactions, input.runId, existingById);
    if (input.runId) incrementRunTransactionCount(input.runId, transactions.length);
  }

  return preValidationResult_(category, classification.code, transactions,
    pendingReviews, {classification: classification});
}

/**
 * 9-2 のファイル変更ガードを評価する。
 *
 * 現在のDriveメタ情報の取得だけを注入可能にする（`input.currentFileRecord`
 * または `input.fetchFileRecord(fileId)`）。判定そのものは4.21の
 * `guardFileUnchanged`が行う。取得手段を持たない場合は、ガードを
 * 「通過」にせず**呼出の誤り**として扱う ── 黙って素通りさせると、
 * 変更されたファイルの内容が予約済み行へ書かれる。
 */
function evaluateFileGuard_(input) {
  var fileId = input.file.id;
  var expected = input.processLog;
  if (!expected) {
    var record = getProcessLogRecord_(fileId);
    if (!record) throw new IntegrityError(null, 'Process log not found for file: ' + fileId);
    expected = {
      fileRevision: record.values[PROCESS_FIELD_COLUMNS_.fileRevision - 1],
      binaryHash: record.values[PROCESS_FIELD_COLUMNS_.binaryHash - 1]
    };
  }
  var current = input.currentFileRecord;
  if (!current && typeof input.fetchFileRecord === 'function') {
    current = input.fetchFileRecord(fileId);
  }
  if (!current) {
    throw new TypeError(
      'runWriteBlock requires currentFileRecord or fetchFileRecord for the 9-2 guard');
  }
  return guardFileUnchanged(fileId, expected.fileRevision, expected.binaryHash, current);
}

/**
 * 書込ブロック（9-1〜9-13）。
 *
 * **事前検証が区分3または区分なしで完了した場合にのみ呼ぶ。** 呼出側が
 * 誤って区分1・区分2で呼んだ場合は、書く前に拒否する（INV-14の二重の歯止め）。
 */
function runWriteBlock(input) {
  if (!input || !input.customer || !input.file || !input.preValidation) {
    throw new TypeError('runWriteBlock requires customer, file, and preValidation');
  }
  var category = input.preValidation.category;
  if (category === 1 || category === 2) {
    throw new StateTransitionError(
      'write block must not run for category ' + category + ' (INV-14)');
  }

  var customer = input.customer;
  var fileId = input.file.id;
  var leaseId = input.leaseId;
  var result = {
    written: [], verified: [], failed: [], reviewsRegistered: [],
    fileChanged: false, wroteToDestination: false
  };

  // 9-2：ファイル変更ガード。**行予約の前に実行する**（M17）。
  // 予約後に中止すると、取引ID列だけ入った行が空き行へ戻らず死ぬ。
  //
  // 判定は4.21の`guardFileUnchanged`に委ねる。呼出側が用意した真偽値を
  // 信じる形にすると、呼出側が未実装のあいだガードが存在しないまま動く。
  var guard = evaluateFileGuard_(input);
  if (guard && guard.ok === false) {
    result.fileChanged = true;
    result.guardReason = guard.reason;
    return result;
  }

  // 書くものが無くても**要確認登録（9-8）まで進む**。ここで戻ってはならない。
  //
  // 再合流したファイルは、既存取引が`REVIEW_REQUIRED`等の終端側にあるため
  // 書込対象が0件になり得る。ここで戻ると9-8へ到達せず、**欠けている要確認を
  // 作り直す機会が永久に来ない**。実機では、取引が`REVIEW_REQUIRED`なのに
  // 要確認が1件も無く転記行も持たないファイルが、再取込しても直らなくなった
  // （2026-09-03）。担当者は解決操作を起動できず、ファイルは完了しない
  // ── 8-10の橋渡しが防ごうとしている状態そのものである。
  var targets = getTransactionsByStatus(fileId, [TX_STATUS.PREPARED, TX_STATUS.WRITING]);
  var batchSize = Number(SETTINGS.WRITE_BATCH_SIZE || 200);
  for (var offset = 0; offset < targets.length; offset += batchSize) {
    var batch = targets.slice(offset, offset + batchSize);

    // 9-3：空き行判定・テンプレート拡張・行予約を単一の排他区間で行う（INV-06）。
    var reservation = reserveDestinationRows(customer,
      batch.map(function(tx) { return tx.fullTxId; }), fileId, leaseId);

    // 取引IDで引く。添字一致に頼ると、空き行が非連続に見つかったときに
    // 取引が別の行へ紐づく。
    var rowByTxId = {};
    reservation.reserved.forEach(function(item) {
      rowByTxId[item.txId] = item.rowNumber;
    });
    var rowWrites = batch.map(function(tx) {
      var rowNumber = rowByTxId[String(tx.fullTxId)];
      if (!rowNumber) {
        throw new IntegrityError(null, 'No row was reserved for ' + tx.fullTxId);
      }
      return buildRowWrite(Number(rowNumber), tx);
    });

    // 確定に至らなかった予約行の扱いは**3段階で違う**（M17・11.3）。
    //   1. 値書込の前に中止：取引ID列だけ消して空き行へ戻す
    //      （`releaseReservedRows`）。
    //   2. 値書込の**途中**で例外：**何も消さない。** 11.3 Step4 は
    //      「同じ行へ書き直す」設計であり、取引ID列が残っていることが
    //      回復の前提である。ここで消すと回復が Step5 で別の行を確保し、
    //      RAWだけ書けた行が無名のまま出納帳に残る。
    //   3. 読取確認に失敗：全列をクリアする（`clearTransactionRows`）。
    //      値が入ったまま取引IDだけ消すと、誰からも引けない死に行になる。
    var settled = {};
    var writeStarted = false;
    var valuesWritten = false;
    try {
      // 9-4・9-5：プレーンテキスト書式（F/I/K列）→ 値書込。
      //
      // **書式が先**である。値を書いてから書式を変えても、`0570-…`が
      // 既に電話番号として解釈されてしまった後では元に戻らない。
      // 4.23 flush規則3の順序（複製→flush→書式→値書込→読取確認）に従う。
      applyPlainTextFormat(customer, rowWrites.map(function(w) { return w.rowNumber; }));
      writeStarted = true;
      writeTransactionRows(customer, rowWrites, leaseId, fileId);
      valuesWritten = true;
      result.wroteToDestination = true;

      // 9-6：読取確認。取引ごとに個別照合する（仕様11.4）。
      var verified = verifyWrittenValues(customer, rowWrites);
      var toSettle = [];
      verified.forEach(function(v, i) {
        var tx = batch[i];
        if (!v.ok) {
          result.failed.push({
            fullTxId: tx.fullTxId, rowNumber: v.rowNumber, mismatches: v.mismatches
          });
          return;
        }
        // 9-7：K列（予定最終状態）へ更新し、予定値・読取確認値を同時に保存する。
        // `tx`は取引ログから読んだ行なので、8-12で空欄化した予定値が反映済み。
        toSettle.push({
          fullTxId: tx.fullTxId, planned: tx.planned, verified: v.values,
          destinationRow: v.rowNumber, fromStatus: tx.transactionStatus,
          toStatus: tx.plannedFinalStatus
        });
      });

      // 確定は全件まとめて1回で行う（件数に依らない往復数にするため）。
      // **成功してから`settled`を立てる** ── 確定が弾かれたとき、書いた行は
      // どの取引からも指されていないので、`finally`が空き行へ戻すのが正しい。
      settleWrittenTransactions(toSettle);
      toSettle.forEach(function(entry) {
        settled[entry.destinationRow] = true;
        result.written.push(entry.fullTxId);
        result.verified.push(entry.destinationRow);
      });
    } finally {
      var orphaned = rowWrites
        .map(function(w) { return w.rowNumber; })
        .filter(function(rowNumber) { return !settled[rowNumber]; });
      if (orphaned.length) {
        if (valuesWritten) {
          // 段階3：読取確認に失敗した行。全列をクリアして空き行へ戻す。
          clearTransactionRows(customer, orphaned, leaseId, fileId);
          result.released = (result.released || []).concat(orphaned);
        } else if (!writeStarted) {
          // 段階1：値書込前の中止。取引ID列だけ消せば空き行へ戻る。
          releaseReservedRows(customer, orphaned, leaseId, fileId);
          result.released = (result.released || []).concat(orphaned);
        }
        // 段階2（writeStarted && !valuesWritten）：書込途中の例外。
        // 行を残し、`recoverPartialFailure`（11.3 Step4）に委ねる。
      }
    }
  }

  // 9-8：要確認登録。**登録はこのステップだけで行う**（A-23）。
  if (input.preValidation.pendingReviews && input.preValidation.pendingReviews.length) {
    // 要確認一覧が「どの顧客のどのファイルか」「どこへ転記したか」を
    // 表示できるよう、2.1.7が必須とする列を揃えて渡す。
    var outcome = registerPendingReviews(input.preValidation.pendingReviews.map(function(entry) {
      return Object.assign({
        fileId: fileId,
        customerId: customer.customerId,
        customerName: customer.customerName,
        fileNameOriginal: input.file.originalFileName || input.file.name || null,
        destinationSpreadsheetId: customer.destinationSpreadsheetId,
        destinationSheetName: customer.destinationSheetName
      }, entry);
    }));
    result.reviewsRegistered = outcome.registered;
  }

  return result;
}

/**
 * ファイル1件の処理（8-1〜9-13）。
 *
 * ブロック境界の遵守がこの関数の責務である。事前検証が区分1・区分2を
 * 返した場合、書込ブロックへ進まない。
 */
function processFile(input) {
  var pre = runPreValidationBlock(input);

  if (pre.category === 1 || pre.category === 2) {
    // 無書込で差し戻す。転記先にも取引ログにも触れない。
    //
    // ただし区分2は**ファイル単位の要確認を登録してから**`REVIEW_WAIT`へ
    // 送る（6.1 step 8-11）。登録しないと、落ちたファイルに要確認行が無く、
    // `resolveFileReview`はreviewIdを必須とするので**誰もそのファイルを
    // 動かせない** ── INV-31が保証するはずの出口が実在しなくなる。
    // A-23が禁じるのは取引単位の孤児要確認であって、これではない。
    // 取引単位種別は取引ログ行を持たないここでは登録しない。
    var registered = [];
    if (pre.category === 2) {
      var fileScoped = (pre.pendingReviews || []).filter(function(entry) {
        return !isTransactionScopedReviewType(entry.reviewType);
      });
      if (fileScoped.length) {
        registered = registerPendingReviews(fileScoped.map(function(entry) {
          return Object.assign({
            fileId: input.file.id,
            customerId: input.customer.customerId,
            customerName: input.customer.customerName,
            fileNameOriginal: input.file.originalFileName || input.file.name || null
          }, entry);
        })).registered;
      }
    }
    return {
      preValidation: pre, write: null,
      wroteToDestination: false,
      reviewsRegistered: registered,
      nextState: pre.category === 1 ? FILE_STATE.CUSTOMER_FIX_REQUIRED : FILE_STATE.REVIEW_WAIT
    };
  }

  // 9-1：`VALIDATING → WRITING`の遷移は呼出側（6.1の結線）が担う。
  // 区分判定の後・書込の前というこの位置でしか正しく起動できないため、
  // フックとして受け取る。ここに置かないと、呼出側は書込ブロックの
  // 開始位置を外から知る手段がない。
  if (typeof input.beforeWriteBlock === 'function') {
    input.beforeWriteBlock(pre);
  }
  var write = runWriteBlock(Object.assign({}, input, {preValidation: pre}));

  // 9-12：INV-17の3条件で判定する。**要確認の件数では判定しない。**
  var nextState;
  if (write.fileChanged) {
    nextState = FILE_STATE.REVIEW_WAIT;
  } else if (write.failed.length) {
    // 読取確認に失敗した取引が残る。完了させず、人の確認へ回す。
    nextState = FILE_STATE.REVIEW_WAIT;
  } else {
    nextState = isFileFullyResolved(input.file.id)
      ? FILE_STATE.COMPLETED : FILE_STATE.REVIEW_WAIT;
  }
  return {
    preValidation: pre, write: write,
    wroteToDestination: write.wroteToDestination,
    nextState: nextState
  };
}

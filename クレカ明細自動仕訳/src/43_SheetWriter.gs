'use strict';

/** §5.11のセル空判定。 */
function isDestinationCellEmpty(value, formula) {
  var valueEmpty = value === '' || value === null || value === undefined;
  var formulaText = formula === null || formula === undefined ? '' : String(formula);
  if (formulaText === '') return valueEmpty;
  if (formulaText.charAt(0) === '=') return valueEmpty;
  return false;
}

/**
 * ヘッダー定義範囲の全列を検査する。
 *
 * `excludedColumns`（顧客マスターAL列・1起算）は判定から除く。freeeの
 * 実テンプレートは未入力行にも税計算区分の既定値・残高数式（非空の表示値）
 * を持ち、除外なしでは空き行が1行も存在しない（実装差戻し#16）。
 * 除外できる列はシステムが書かない列に限る（4.3が検証する）。
 */
function isDestinationRowEmpty(values, formulas, lastColumn, excludedColumns) {
  if (!Array.isArray(values) || !Array.isArray(formulas) || !Number.isInteger(lastColumn) || lastColumn < 1) {
    throw new TypeError('isDestinationRowEmpty requires values, formulas, and lastColumn');
  }
  var excluded = Object.create(null);
  (excludedColumns || []).forEach(function(column) { excluded[Number(column)] = true; });
  for (var column = 0; column < lastColumn; column += 1) {
    if (excluded[column + 1]) continue;
    if (!isDestinationCellEmpty(values[column], formulas[column])) return false;
  }
  return true;
}

/**
 * フェーズ1bでは4.25の一括取得済みインデックスを純粋入力として受け取る。
 */
/**
 * 空き行を先頭から`count`件まで探す（5.11・INV-27）。
 *
 * 判定範囲はヘッダー行の次からで、最終列は顧客マスターAH列
 * （`rowScanLastColumn`）である。**同じ概念に2つの名前を持たせない。**
 * 以前は`headerLastColumn`という別名を読んでいて、実際の顧客オブジェクトにも
 * 実際のインデックスにもその名前が無いため、テスト用の作り物でしか動かなかった。
 */
function findEmptyRows(customer, count, index) {
  if (!Number.isInteger(count) || count < 0 || !index || !index.valuesByRow) {
    throw new TypeError('findEmptyRows requires a count and a destination index');
  }
  var lastColumn = Number(customer.rowScanLastColumn);
  if (!Number.isInteger(lastColumn) || lastColumn < 1) {
    throw new TypeError('rowScanLastColumn must be configured');
  }
  var startRow = Math.max(Number(index.rangeStart || 1), Number(customer.headerRow || 0) + 1);
  var rows = [];
  for (var rowNumber = startRow; rowNumber <= index.rangeEnd && rows.length < count; rowNumber += 1) {
    if (isRowEmpty(index, rowNumber, customer)) rows.push(rowNumber);
  }
  return rows;
}

/** テンプレート複製の要否と停止条件だけを決める。実コピーは次フェーズ。 */
function planTemplateExpansion(input) {
  if (!input || !Number.isInteger(input.requiredCount) || !Number.isInteger(input.emptyRowCount)) {
    throw new TypeError('planTemplateExpansion requires integer row counts');
  }
  var missing = Math.max(0, input.requiredCount - input.emptyRowCount);
  if (missing === 0) return {action: 'NONE', rowsToAdd: 0, code: null};
  if (input.templateSourceValid === false) {
    return {action: 'STOP', rowsToAdd: 0, code: 'INVALID_TEMPLATE_SOURCE', retry: false};
  }
  if (input.expandedRowsValid === false) {
    return {
      action: 'STOP',
      rowsToAdd: 0,
      code: 'DESTINATION_TEMPLATE_ROW_NOT_EMPTY',
      retry: false
    };
  }
  return {action: 'EXPAND', rowsToAdd: missing, code: null};
}

/** 複製先で値を残してはならない列だけを空にする。 */
function clearTemplateValueCells(row) {
  var result = Object.assign({}, row || {});
  ['B', 'F', 'I', 'K', 'M', 'INTERNAL_TRANSACTION_ID'].forEach(function(column) {
    result[column] = '';
  });
  return result;
}

/** 複製後の各行が空き行であることを検証する。 */
/**
 * テンプレート行を複製して転記先を広げる（4.23 M30・INV-06）。
 *
 * 転記先は顧客のfreee出納帳であり、B/F/I/K/M以外の列には勘定科目の既定値や
 * 消費税の計算式が入っている。`setValues`と`setFormulas`で個別に書くと、
 * **実 Sheets では空文字列の数式がセルの内容を消す**ため、それらが失われる。
 * `copyTo`で行ごと複製し、そのあとシステムが所有する列だけを消す。
 *
 * 手順6の停止条件が無限ループの遮断点である。最終行が非空（顧客が最下行に
 * 合計を入れている等）だと、複製した行がすべて使用中と判定され、拡張しても
 * 空き行が増えないまま拡張を繰り返す。
 *
 * @return {!Array<number>} 追加された行番号。
 */
function expandTemplateRows(customer, sheet, shortage, templateSourceRow) {
  if (!Number.isInteger(shortage) || shortage <= 0) return [];
  var lastColumn = customer.rowScanLastColumn;

  // 手順1：複製元は「検証済みの直前行」＝**最初の空きテンプレート行**である。
  // `getMaxRows()`を複製元にすると、実際の顧客シートではグリッドが既定
  // 1000行等でデータ域より下に**書式も数式も無い空行**が続くため、空行を
  // 複製してしまい、勘定科目の既定値・消費税式が新しい行に入らない ──
  // この関数が存在する理由そのものが満たされない。テストのシートは
  // maxRowsをデータ行ぴったりに作りがちで、その差はスタブでは出ない。
  var templateRow = Number.isInteger(templateSourceRow) && templateSourceRow >= 1
    ? templateSourceRow : sheet.getMaxRows();
  // 勘定科目の既定値や消費税の計算式が入っているのが**正しい**テンプレートで
  // ある。複製元として不適なのは、取引が転記済みの行を複製してしまう場合。
  var sourceValues = sheet.getRange(templateRow, 1, 1, lastColumn).getValues();
  if (!systemOwnedColumnsAreEmpty_(customer, sourceValues[0])) {
    throw new StateTransitionError(
      'INVALID_TEMPLATE_SOURCE: the template row still carries a transaction');
  }

  // 手順2：行ごと複製する。数式は相対参照が移動する。
  // 追加は常にシート末尾へ行う（途中挿入は既存の行番号参照を全部ずらす）。
  var insertAfter = sheet.getMaxRows();
  sheet.insertRowsAfter(insertAfter, shortage);
  var added = [];
  var source = sheet.getRange(templateRow, 1, 1, lastColumn);
  for (var offset = 1; offset <= shortage; offset += 1) {
    var addedRow = insertAfter + offset;
    source.copyTo(sheet.getRange(addedRow, 1, 1, lastColumn));
    added.push(addedRow);
  }

  // 手順3：システムが所有する列だけを空にする。他の列には触れない。
  var ownedColumns = [customer.columnMapping.B, customer.columnMapping.F,
    customer.columnMapping.I, customer.columnMapping.K,
    customer.columnMapping.M, customer.columnMapping.txId];
  added.forEach(function(rowNumber) {
    ownedColumns.forEach(function(column) {
      sheet.getRange(rowNumber, column).clearContent();
    });
  });

  // 手順4：Sheets API から見えるようにする。
  SpreadsheetApp.flush();

  // 手順5・6：拡張した行が本当に空き行になったかを確認し、
  // なっていなければ停止する。ここが無限ループの遮断点である。
  var check = validateExpandedRows(
    added.map(function(r) { return sheet.getRange(r, 1, 1, lastColumn).getValues()[0]; }),
    added.map(function(r) { return sheet.getRange(r, 1, 1, lastColumn).getFormulas()[0]; }),
    lastColumn, customer.rowScanExcludedColumns);
  if (!check.ok) {
    throw new StateTransitionError(
      'DESTINATION_TEMPLATE_ROW_NOT_EMPTY: expanding did not produce usable empty rows');
  }
  return added;
}

/** システムが所有する列がすべて空か。空なら複製元として使える。 */
function systemOwnedColumnsAreEmpty_(customer, values) {
  return [customer.columnMapping.B, customer.columnMapping.F, customer.columnMapping.I,
    customer.columnMapping.K, customer.columnMapping.M, customer.columnMapping.txId]
    .every(function(column) {
      var value = values[column - 1];
      return value === '' || value === null || value === undefined;
    });
}

function validateExpandedRows(values, formulas, lastColumn, excludedColumns) {
  if (!Array.isArray(values) || !Array.isArray(formulas)) {
    throw new TypeError('validateExpandedRows requires values and formulas');
  }
  return {
    ok: values.every(function(row, index) {
      return isDestinationRowEmpty(row || [], formulas[index] || [], lastColumn, excludedColumns);
    })
  };
}

/** 列キー → 顧客マスターの列番号。 */
function writeColumnNumber_(customer, key) {
  var mapping = customer.columnMapping || {};
  var map = {
    b: mapping.B, f: mapping.F, i: mapping.I,
    k: mapping.K, m: mapping.M, txId: mapping.txId
  };
  var column = Number(map[key]);
  if (!Number.isInteger(column) || column < 1) {
    throw new TypeError('column mapping is missing for ' + key);
  }
  return column;
}

/**
 * 転記行の書込。
 *
 * B/F/I/K/M列は非連続であり、単一レンジの書込は間の列の数式・書式を破壊する
 * （仕様10.2）。列ごとのレンジへ分割し、`values.batchUpdate`へ束ねる。
 *
 * `valueInputOption`はリクエスト単位のフィールドであってレンジごとには指定
 * できないため、**文字列群（RAW）と数値・日付群（USER_ENTERED）で2リクエスト**に
 * なる。取引ID列を含むRAW群を先に送り、途中停止しても行の帰属が判別できる
 * ようにする。RAW成功／USER_ENTERED失敗という部分書込は実在し、仕様11.3
 * Step4が回復する。
 */
function writeTransactionRows(customer, rowWrites, leaseId, fileId) {
  if (!Array.isArray(rowWrites) || !rowWrites.length) return [];
  // 書込の直前に、自らが当該ファイルの有効なリース所有者であることを確認する（INV-30）。
  assertLeaseHeldForWrite(fileId, leaseId);

  var groups = [
    {option: 'RAW', keys: ['txId', 'f', 'i', 'k']},
    {option: 'USER_ENTERED', keys: ['b', 'm']}
  ];
  var sheetName = customer.destinationSheetName;

  // 行番号順に並べてから、列ごとに連続行をまとめる。1セル1レンジだと
  // 200件で1,200レンジになり、リクエストサイズ上限と実行時間の双方に近づく。
  var sorted = rowWrites.slice().sort(function(a, b) { return a.rowNumber - b.rowNumber; });

  groups.forEach(function(group) {
    var data = [];
    group.keys.forEach(function(key) {
      // 当該列に書く対象だけを集める。`values`に含まれないキーの列には触れない
      // ── 要確認の解決はF列だけを更新するので、他列を巻き込むと担当者が
      // 手で直した値が消える。
      var targets = sorted.filter(function(write) {
        var value = key === 'txId' ? write.fullTxId : (write.values || {})[key];
        return value !== undefined;
      });
      if (!targets.length) return;

      var column = writeColumnNumber_(customer, key);
      groupConsecutiveRows(targets).forEach(function(chunk) {
        data.push({
          range: a1ColumnRange_(sheetName, column, chunk.startRow, chunk.endRow),
          values: chunk.rowWrites.map(function(write) {
            var value = key === 'txId' ? write.fullTxId : (write.values || {})[key];
            return [value === null ? '' : value];
          })
        });
      });
    });
    if (!data.length) return;
    // 障害注入の停止点（4.39）。RAWとUSER_ENTEREDの分割点で止められる
    // ことが、仕様11.3 Step4（RAWだけ成功した部分失敗）を実機で再現する
    // 唯一の手段である。本番では素通りする。
    faultInjectionPoint(group.option === 'RAW'
      ? 'SHEET_WRITE_RAW_BEFORE' : 'SHEET_WRITE_USER_ENTERED_BEFORE',
      {fileId: fileId});
    Sheets.Spreadsheets.Values.batchUpdate(
      {valueInputOption: group.option, data: data},
      customer.destinationSpreadsheetId
    );
  });

  return rowWrites.map(function(write) {
    return {rowNumber: write.rowNumber, fullTxId: write.fullTxId, ok: true};
  });
}

/** B/F/I/K/M列と内部取引ID列だけを空にする。他列に触れない。 */
function clearTransactionRows(customer, rowNumbers, leaseId, fileId) {
  if (!Array.isArray(rowNumbers) || !rowNumbers.length) return [];
  assertLeaseHeldForWrite(fileId || null, leaseId);
  var data = [];
  rowNumbers.forEach(function(rowNumber) {
    ['txId', 'b', 'f', 'i', 'k', 'm'].forEach(function(key) {
      data.push({
        range: a1Range_(customer.destinationSheetName, rowNumber, writeColumnNumber_(customer, key), writeColumnNumber_(customer, key)),
        values: [['']]
      });
    });
  });
  Sheets.Spreadsheets.Values.batchUpdate(
    {valueInputOption: 'RAW', data: data}, customer.destinationSpreadsheetId);
  return rowNumbers.map(function(rowNumber) { return {rowNumber: rowNumber, ok: true}; });
}

/**
 * F/I/K列のみをプレーンテキスト表示形式にする（仕様20.3）。
 * B列・M列には適用しない。既存書式を壊すため（仕様3 原則6）。
 */
/**
 * F・I・K列をプレーンテキストにする（仕様20.3）。
 *
 * これをしないと `0570-…` のような店名が電話番号や数式として解釈され、
 * 読取確認が不一致になるか、値が静かに変わる。
 *
 * SpreadsheetApp の `Range.setNumberFormat` を使う（4.23のAPI使い分け表）。
 * Sheets API 側に表示形式を扱う簡潔な手段が揃っていないうえ、以前の実装は
 * `customer.destinationSheetId` に依存していて**常に何もせず戻っていた**。
 *
 * 書式は値を書く**前**に適用する。後から変えても、既に解釈されてしまった
 * 値は戻らない。呼出後に`flush()`してから Sheets API の書込へ進む。
 */
function applyPlainTextFormat(customer, rowNumbers) {
  if (!Array.isArray(rowNumbers) || !rowNumbers.length) return;
  var sheet = requireSheet_(
    SpreadsheetApp.openById(customer.destinationSpreadsheetId), customer.destinationSheetName);

  // 連続行はまとめて1レンジにする。1セル1リクエストだと200件で600回になり、
  // 実行時間上限とAPIクォータの両方に近づく。
  var sorted = rowNumbers.slice().sort(function(a, b) { return a - b; })
    .map(function(rowNumber) { return {rowNumber: Number(rowNumber)}; });
  groupConsecutiveRows(sorted).forEach(function(group) {
    var count = group.endRow - group.startRow + 1;
    ['f', 'i', 'k'].forEach(function(key) {
      var column = writeColumnNumber_(customer, key);
      sheet.getRange(group.startRow, column, count, 1).setNumberFormat('@');
    });
  });

  // SpreadsheetApp の変更は遅延適用される。Sheets API を呼ぶ前に反映させる
  // （4.23 flush規則1）。
  SpreadsheetApp.flush();
}

/**
 * 書込後の読取確認。
 *
 * 取引ごとに個別に照合し、未確認取引を一括で`COMMITTED`にしない（仕様11.4）。
 * 読取と比較の正準化は5.5の単一の規則に従う（INV-15）。
 */
/**
 * 書いた値を読み返して照合する（6.1 step 9-6・仕様11.4）。
 *
 * **転記先シートの読取を取引ごとに行わない**（INV-08）。以前は呼出のたびに
 * シート全体のインデックスを組み直しており、200件の回復で全シート読取が
 * 400回発生していた。5,000行のシートでは実行時間上限とAPIクォータの
 * 両方に当たる。対象行だけを1回のリクエストで読む。
 *
 * @param {!Object=} index 既に構築済みのインデックス。あれば再構築しない。
 */
function verifyWrittenValues(customer, rowWrites, index) {
  if (!Array.isArray(rowWrites) || !rowWrites.length) return [];
  var rows = readDestinationRows_(customer, rowWrites.map(function(w) {
    return w.rowNumber;
  }), index);
  return rowWrites.map(function(write) {
    var current = rows[write.rowNumber];
    var mismatches = [];
    ['b', 'f', 'i', 'k', 'm'].forEach(function(key) {
      var planned = (write.values || {})[key];
      if (planned === undefined) return;
      if (!canonicalReadValuesEqual(key, planned, current[key])) {
        mismatches.push({column: key, expected: planned, actual: current[key]});
      }
    });
    return {
      rowNumber: write.rowNumber, fullTxId: write.fullTxId,
      ok: mismatches.length === 0, mismatches: mismatches, values: current
    };
  });
}

/** 予約後・値書込前に中止する場合に、予約した取引ID列だけを空へ戻す（M17）。 */
function releaseReservedRows(customer, rowNumbers, leaseId, fileId) {
  if (!Array.isArray(rowNumbers) || !rowNumbers.length) return;
  assertLeaseHeldForWrite(fileId || null, leaseId);
  var data = rowNumbers.map(function(rowNumber) {
    return {
      range: a1Range_(customer.destinationSheetName, rowNumber, writeColumnNumber_(customer, 'txId'), writeColumnNumber_(customer, 'txId')),
      values: [['']]
    };
  });
  Sheets.Spreadsheets.Values.batchUpdate(
    {valueInputOption: 'RAW', data: data}, customer.destinationSpreadsheetId);
}

/** 取引ログの転記先行番号（AE列）を更新する。 */
function updateTransactionLocation(fullTxId, rowNumber) {
  return withScriptLock_(function() {
    var row = getTransaction(fullTxId);
    if (!row) throw new IntegrityError(null, 'Transaction not found: ' + fullTxId);
    transactionLogSheet_().getRange(row._rowNumber, 31).setValue(rowNumber);
    transactionLogSheet_().getRange(row._rowNumber, 45).setValue(nowIso_());
  });
}

/** 取引ログの予定値と取引ID完全値から書込指示1件を組み立てる。 */
/**
 * 書込指示を作る。
 *
 * `txLog.columns`を与えると、その列だけを書く。要確認の解決はF列だけ、
 * あるいはB・M列だけを更新する（4.23の呼出経路表）。全列を書き直すと、
 * 解決とは無関係な列まで上書きされ、担当者が手で直した値が消える。
 */
function buildRowWrite(rowNumber, txLog) {
  var all = {
    b: txLog.planned.b, f: txLog.planned.f, i: txLog.planned.i,
    k: txLog.planned.k, m: txLog.planned.m
  };
  var values = all;
  if (Array.isArray(txLog.columns) && txLog.columns.length) {
    values = {};
    txLog.columns.forEach(function(key) { values[key] = all[key]; });
  }
  return {rowNumber: rowNumber, fullTxId: txLog.fullTxId, values: values};
}

/** 4.25のインデックスから読む。取引ごとにシートを読まない（INV-08）。 */
/**
 * 指定した行だけを読む。転記先シート全体は読まない（INV-08）。
 *
 * 読取は Sheets API で行う。SpreadsheetApp 側には独自のキャッシュがあり、
 * Sheets API の書込を即座に反映しないことがある（4.23 flush規則2）。
 * 表示形式に依らない値を得るため、レンダリング指定は5.5の表で固定する。
 */
function readDestinationRows_(customer, rowNumbers, index) {
  var unique = [];
  rowNumbers.forEach(function(rowNumber) {
    if (unique.indexOf(rowNumber) < 0) unique.push(Number(rowNumber));
  });

  // 既に構築済みのインデックスがあれば、それを使う（再読込しない）。
  if (index) {
    var fromIndex = {};
    unique.forEach(function(rowNumber) {
      fromIndex[rowNumber] = getValuesByRow(index, rowNumber);
    });
    return fromIndex;
  }

  var columns = {b: customer.columnMapping.B, f: customer.columnMapping.F,
    i: customer.columnMapping.I, k: customer.columnMapping.K, m: customer.columnMapping.M};
  var ranges = unique.map(function(rowNumber) {
    return a1Range_(customer.destinationSheetName, rowNumber, 1, customer.rowScanLastColumn);
  });
  var response = Sheets.Spreadsheets.Values.batchGet(customer.destinationSpreadsheetId, {
    ranges: ranges,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER'
  });

  var result = {};
  unique.forEach(function(rowNumber, i) {
    var values = ((response.valueRanges || [])[i] || {}).values || [[]];
    var row = values[0] || [];
    var cells = {};
    Object.keys(columns).forEach(function(key) {
      var value = row[columns[key] - 1];
      cells[key] = value === undefined ? '' : value;
    });
    result[rowNumber] = cells;
  });
  return result;
}

function readRowValues(index, txLog) {
  var hit = getRowByTxId(index, txLog.fullTxId);
  if (!hit || !hit.matchCount) return null;
  return getValuesByRow(index, hit.rowNumber);
}

/** 現在値が予定値と一致するか。比較は5.5の正準化規則を通す（INV-15）。 */
function plannedValuesMatch_(planned, current) {
  if (!current) return false;
  return ['b', 'f', 'i', 'k', 'm'].every(function(column) {
    return canonicalReadValuesEqual(column, planned[column], current[column]);
  });
}

/**
 * 仕様11.3の部分失敗からの回復（Step0〜6）。
 *
 * 対象は`PREPARED`／`WRITING`かつ`有効=TRUE`の取引だけである（Step1）。
 * `COMMITTED`の値ずれはここでは扱わない。それは4.24 検査3が「手動変更」として
 * 検出し、仕様17.2のフローへ回す。6.2 手順7が本関数より先に整合性チェックを
 * 置いているのはこのためである。
 *
 * 最終状態は取引ログK列（予定最終状態）が決める。回復の時点で要確認の有無を
 * 数え直さない。
 */
function recoverPartialFailure(fileId, runId, index, leaseId, options) {
  options = options || {};
  var result = {recovered: [], reserved: [], stopped: null, fileChanged: false};

  // Step 0: 元ファイルが解析時点から変わっていないことを確認する（M17）。
  // 変わっていれば回復しない。変更後の内容を予約済み行へ書き込んでしまうため。
  if (options.fileGuard) {
    var guard = options.fileGuard;
    if (guard.unchanged === false) {
      result.fileChanged = true;
      result.stopped = {code: 'FILE_CHANGED', fullTxId: null};
      return result;
    }
  }

  // Step 1: 対象取引の抽出（INV-03。有効=TRUEのみ）。
  var targets = getTransactionsByStatus(fileId, [TX_STATUS.PREPARED, TX_STATUS.WRITING]);

  for (var n = 0; n < targets.length; n += 1) {
    var tx = targets[n];

    // Step 2: インデックスから取引ID完全値で行を引く（INV-08・INV-11）。
    var hit = getRowByTxId(index, tx.fullTxId);
    var matchCount = hit ? hit.matchCount : 0;

    // Step 6: 2行以上は自動修復しない。
    if (matchCount >= 2) {
      result.stopped = {code: 'TRANSACTION_ID_COLLISION', fullTxId: tx.fullTxId, matchCount: matchCount};
      throw new IntegrityError('TRANSACTION_ID_COLLISION',
        'Transaction ' + tx.fullTxId + ' occupies ' + matchCount + ' destination rows');
    }

    if (matchCount === 1) {
      var current = getValuesByRow(index, hit.rowNumber);
      if (plannedValuesMatch_(tx.planned, current)) {
        // Step 3: 一致。追記せずK列の状態へ補正する。
        //
        // 読取確認値も必ず保存する（INV-01）。ここを省くと取引ログの
        // X〜AB列が空のまま COMMITTED になり、次回の4.24検査3が
        // 「予定値あり・読取確認値なし」を手動変更と誤検知して、
        // 回復した取引を全件、処理開始前に止める。
        updateWrittenValues(tx.fullTxId, tx.planned, current);
        updateTransactionStatus(tx.fullTxId, tx.transactionStatus, tx.plannedFinalStatus);
        result.recovered.push({fullTxId: tx.fullTxId, step: 3, rowNumber: hit.rowNumber});
      } else {
        // Step 4: 不一致（行予約のみ、RAWのみ成功等）。
        // 新しい行を追加せず、その予約済みの同じ行へ書き直す。
        // 書式は値を書く**前**に適用する（20.3）。後から変えても、既に
        // 電話番号として解釈された値は戻らない。順序を経路ごとに変えると、
        // USER_ENTEREDへ列を足した瞬間に片側だけ壊れる。
        applyPlainTextFormat(options.customer, [hit.rowNumber]);
        writeTransactionRows(options.customer, [buildRowWrite(hit.rowNumber, tx)], leaseId, fileId);
        var verified4 = verifyWrittenValues(options.customer, [buildRowWrite(hit.rowNumber, tx)]);
        if (!verified4[0] || !verified4[0].ok) {
          result.stopped = {code: 'DESTINATION_VALUE_MISMATCH', fullTxId: tx.fullTxId};
          throw new IntegrityError('DESTINATION_VALUE_MISMATCH',
            'Read-back verification failed for ' + tx.fullTxId);
        }
        updateWrittenValues(tx.fullTxId, tx.planned, verified4[0].values);
        updateTransactionStatus(tx.fullTxId, tx.transactionStatus, tx.plannedFinalStatus);
        result.recovered.push({fullTxId: tx.fullTxId, step: 4, rowNumber: hit.rowNumber});
      }
      continue;
    }

    // Step 5: 行が存在しない。有効なリースを確認してから確保する。
    assertLeaseHeldForWrite(fileId, leaseId);
    // reserveDestinationRows は取引IDと行番号の対応を返す（4.25）。
    var reservation = reserveDestinationRows(options.customer, [tx.fullTxId], fileId, leaseId);
    var entry = (reservation.reserved || [])[0];
    var rowNumber = entry ? Number(entry.rowNumber) : null;
    if (!rowNumber) {
      result.stopped = {code: 'DESTINATION_SCHEMA_MISMATCH', fullTxId: tx.fullTxId};
      throw new IntegrityError('DESTINATION_SCHEMA_MISMATCH',
        'No empty row could be reserved for ' + tx.fullTxId);
    }
    applyPlainTextFormat(options.customer, [rowNumber]);
    writeTransactionRows(options.customer, [buildRowWrite(rowNumber, tx)], leaseId, fileId);
    var verified5 = verifyWrittenValues(options.customer, [buildRowWrite(rowNumber, tx)]);
    if (!verified5[0] || !verified5[0].ok) {
      result.stopped = {code: 'DESTINATION_VALUE_MISMATCH', fullTxId: tx.fullTxId};
      throw new IntegrityError('DESTINATION_VALUE_MISMATCH',
        'Read-back verification failed for ' + tx.fullTxId);
    }
    updateWrittenValues(tx.fullTxId, tx.planned, verified5[0].values);
    updateTransactionLocation(tx.fullTxId, rowNumber);
    updateTransactionStatus(tx.fullTxId, tx.transactionStatus, tx.plannedFinalStatus);
    result.recovered.push({fullTxId: tx.fullTxId, step: 5, rowNumber: rowNumber});
    result.reserved.push(rowNumber);
  }

  return result;
}

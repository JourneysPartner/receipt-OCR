'use strict';

/**
 * 4.22 転記先構成検証。
 *
 * 不合格＝`DESTINATION_SCHEMA_MISMATCH`は書込の全面停止なので、判定基準は
 * 4.22.1のとおり具体的に固定する。**保護の不在は停止条件にしない** ──
 * 停止させるのは「実行者を除外する保護」だけである（INV-22）。
 * テンプレート行の存在も必須要件にしない（仕様3原則6：既存の顧客シートを
 * 壊さない・止めない）。
 */

function schemaProblem_(item, code, detail) {
  return {item: item, code: code, detail: detail || null};
}

/** AE/AF/AGのJSONを取り出す。customerFromRow_で解析済みのオブジェクト。 */
function schemaHeaderRule_(customer) {
  var rule = customer.expectedHeader;
  if (!rule || typeof rule !== 'object' || !Array.isArray(rule.cells) || !rule.cells.length) {
    return null;
  }
  return rule;
}

/** 4.22.1(1) のセル照合（正準化＋4.16正規化）。 */
function schemaHeaderCellMatches_(actual, expected) {
  var canonical = actual === null || actual === undefined ? '' : cellToCanonicalString(actual);
  var subject = normalizeMerchant(canonical === null ? '' : canonical);
  var wanted = normalizeMerchant(String(expected.text === undefined ? '' : expected.text));
  if (expected.match === 'contains') return subject.indexOf(wanted) >= 0;
  return subject === wanted;
}

/**
 * 転記先スプレッドシートの構成検証（仕様10.6の8項目）。
 *
 * @param {!Object} customer 顧客マスター行（4.3のCustomer型）
 * @param {!Object} index 4.25のインデックス（同じ転記先から構築済みのもの)
 * @return {{ok:boolean, code:?string, problems:!Array<!Object>,
 *   warnings:!Array<!Object>}}
 */
function validateDestinationSchema(customer, index) {
  if (!customer || !index) {
    throw new TypeError('validateDestinationSchema requires a customer and a destination index');
  }
  var problems = [];
  var warnings = [];
  var mapping = customer.columnMapping || {};

  // 項目1：転記先シート名の完全一致。
  var spreadsheet = SpreadsheetApp.openById(customer.destinationSpreadsheetId);
  var sheet = spreadsheet.getSheetByName(customer.destinationSheetName);
  if (!sheet) {
    problems.push(schemaProblem_(1, 'SHEET_NOT_FOUND', customer.destinationSheetName));
  }

  // 項目2：ヘッダー行の構成（AE列）。期待値が保存されていない転記先へは
  // 書き込まない（4.22.1(1)）。
  var headerRule = schemaHeaderRule_(customer);
  var headerRowNumber = null;
  var headerValues = null;
  if (!headerRule) {
    problems.push(schemaProblem_(2, 'HEADER_EXPECTATION_MISSING',
      'AE列にヘッダー期待値が保存されていない'));
  } else {
    headerRowNumber = Number.isInteger(headerRule.row) ? headerRule.row : customer.headerRow;
    headerValues = getAllValuesByRow(index, headerRowNumber);
    if (!headerValues) {
      problems.push(schemaProblem_(2, 'HEADER_ROW_OUT_OF_RANGE', headerRowNumber));
    } else {
      headerRule.cells.forEach(function(cell) {
        var actual = headerValues[Number(cell.column) - 1];
        if (!schemaHeaderCellMatches_(actual, cell)) {
          problems.push(schemaProblem_(2, 'HEADER_CELL_MISMATCH', {
            column: cell.column, expected: cell.text,
            actual: actual === undefined ? null : actual
          }));
        }
      });
    }
  }

  // 項目3：B・F・I・K・M列の位置が正の整数で、互いに重複しないこと。
  var mappedColumns = ['B', 'F', 'I', 'K', 'M'].map(function(key) {
    return {key: key, column: Number(mapping[key])};
  });
  var seenColumns = Object.create(null);
  mappedColumns.forEach(function(entry) {
    if (!Number.isInteger(entry.column) || entry.column < 1) {
      problems.push(schemaProblem_(3, 'COLUMN_MAPPING_INVALID', entry.key));
      return;
    }
    if (seenColumns[entry.column]) {
      problems.push(schemaProblem_(3, 'COLUMN_MAPPING_DUPLICATE',
        entry.key + '=' + entry.column));
    }
    seenColumns[entry.column] = true;
  });

  // 項目4：内部取引ID列。存在し、AE列のcellsが指す列と重複しないこと。
  var txColumn = Number(mapping.txId);
  if (!Number.isInteger(txColumn) || txColumn < 1) {
    problems.push(schemaProblem_(4, 'TX_ID_COLUMN_INVALID', mapping.txId));
  } else if (headerRule && headerRule.cells.some(function(cell) {
    return Number(cell.column) === txColumn;
  })) {
    problems.push(schemaProblem_(4, 'TX_ID_COLUMN_OVERLAPS_HEADER', txColumn));
  }

  // 項目5：必要数式（AF列）。空欄なら合格。既存データ行が0行でも合格
  // （新規の空シートを停止させない）。
  var formulaRule = customer.requiredFormulas;
  var formulaDefs = formulaRule && Array.isArray(formulaRule.formulas) ? formulaRule.formulas : [];
  if (formulaDefs.length) {
    var occupied = listOccupiedRows(index, customer)
      .filter(function(rowNumber) { return rowNumber !== headerRowNumber; })
      .slice(0, SETTINGS.SCHEMA_SAMPLE_ROWS);
    if (occupied.length) {
      formulaDefs.forEach(function(definition) {
        var prefix = String(definition.requiredPrefix || '=');
        var minRatio = Number(definition.minPresentRatio);
        var present = 0;
        occupied.forEach(function(rowNumber) {
          var formulas = getFormulasByRow(index, rowNumber) || [];
          var cell = formulas[Number(definition.column) - 1];
          if (typeof cell === 'string' && cell.lastIndexOf(prefix, 0) === 0) present += 1;
        });
        if (present / occupied.length < minRatio) {
          problems.push(schemaProblem_(5, 'REQUIRED_FORMULA_MISSING', {
            column: definition.column, presentRatio: present / occupied.length,
            minPresentRatio: minRatio
          }));
        }
      });
    }
  }

  // 項目6：保護範囲（AG列）。空欄なら合格。「無い」は警告、
  // 「実行者を除外する保護が有る」だけを不合格とする（INV-22）。
  var protectionRule = customer.expectedProtections;
  var protectionDefs = protectionRule && Array.isArray(protectionRule.ranges) ? protectionRule.ranges : [];
  if (protectionDefs.length && sheet) {
    var protections = typeof sheet.getProtections === 'function' && SpreadsheetApp.ProtectionType ?
      sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE) : [];
    protectionDefs.forEach(function(definition) {
      var columns = (definition.columns || []).map(Number);
      var covering = protections.filter(function(protection) {
        var range = protection.getRange();
        var first = range.getColumn();
        var last = typeof range.getLastColumn === 'function' ? range.getLastColumn() : first;
        return columns.some(function(column) { return column >= first && column <= last; });
      });
      if (!covering.length) {
        if (definition.mustExist === true) {
          warnings.push(schemaProblem_(6, 'PROTECTION_MISSING', columns));
        }
        return;
      }
      if (definition.mustBeWarningOnly === true) {
        covering.forEach(function(protection) {
          if (protection.isWarningOnly()) return;
          if (!protection.canEdit()) {
            problems.push(schemaProblem_(6, 'PROTECTION_EXCLUDES_EXECUTOR', columns));
          }
        });
      }
    });
  }

  // 項目7：シート構成バージョンの一致。実機のセルは「1.0」を数値1として
  // 保存するため、両辺が10進数として解釈できる場合は数値として比較する
  // （文字列比較だと '1' ≠ '1.0' で、正しい構成が恒久的に不一致になる）。
  var expectedVersion = String(VERSIONS.SHEET_SCHEMA);
  var actualVersion = String(customer.schemaVersion);
  var decimalPattern = /^\d+(\.\d+)?$/;
  var versionMatches = decimalPattern.test(expectedVersion) && decimalPattern.test(actualVersion) ?
    Number(expectedVersion) === Number(actualVersion) :
    expectedVersion === actualVersion;
  if (!versionMatches) {
    problems.push(schemaProblem_(7, 'SCHEMA_VERSION_MISMATCH', {
      expected: VERSIONS.SHEET_SCHEMA, actual: customer.schemaVersion
    }));
  }

  // 項目8：空き行判定最終列 AH ≧ max(ヘッダー最終非空列, 取引ID列)（INV-27）。
  // インデックスはAH列までしか持たないため、ヘッダー行だけは**シートから
  // 直接**全幅を読む。AHより右に実ヘッダーが伸びている構成は、空き行判定が
  // その列の値を見落とし、使用中の行を空きと誤認する。
  var lastHeaderColumn = 0;
  if (sheet && headerRowNumber !== null) {
    var fullHeader = sheet.getRange(headerRowNumber, 1, 1, sheet.getMaxColumns()).getValues()[0] || [];
    for (var column = fullHeader.length - 1; column >= 0; column -= 1) {
      var value = fullHeader[column];
      if (value !== '' && value !== null && value !== undefined) {
        lastHeaderColumn = column + 1;
        break;
      }
    }
  }
  var required = Math.max(lastHeaderColumn, Number.isInteger(txColumn) ? txColumn : 0);
  if (Number(customer.rowScanLastColumn) < required) {
    problems.push(schemaProblem_(8, 'ROW_SCAN_LAST_COLUMN_TOO_SMALL', {
      rowScanLastColumn: customer.rowScanLastColumn, required: required
    }));
  }

  return {
    ok: problems.length === 0,
    code: problems.length ? 'DESTINATION_SCHEMA_MISMATCH' : null,
    problems: problems,
    warnings: warnings
  };
}

/**
 * テンプレート行拡張の直前検証。複製元の行が5.11の空き行であることを
 * 確認する（値の入った行を複製すると、その値が新しい行へ複写される）。
 */
function validateTemplateSourceRow(customer, rowNumber, index) {
  var problems = [];
  var values = getAllValuesByRow(index, rowNumber);
  if (!values) {
    problems.push(schemaProblem_('template', 'TEMPLATE_ROW_OUT_OF_RANGE', rowNumber));
  } else if (!isRowEmpty(index, rowNumber, customer)) {
    problems.push(schemaProblem_('template', 'DESTINATION_TEMPLATE_ROW_NOT_EMPTY', rowNumber));
  }
  return {
    ok: problems.length === 0,
    code: problems.length ? 'DESTINATION_TEMPLATE_ROW_NOT_EMPTY' : null,
    problems: problems,
    warnings: []
  };
}

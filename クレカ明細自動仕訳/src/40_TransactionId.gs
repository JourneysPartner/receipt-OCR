'use strict';

/**
 * 4.20 取引ID（仕様11.1・INV-11・INV-13・INV-23・INV-26）。
 *
 * 取引IDは**生成要素から決定的に導出する**。「新しい取引ID」を恣意的に
 * 作らない。別取引としての採用は再取込世代番号によって導出する（INV-23）。
 * これを乱数や時刻で作ると、再合流や回復のたびに同じ明細が別取引になり、
 * 顧客の出納帳へ二重に転記される。
 */

/**
 * 取引ID完全値・表示ID・版を作る。
 *
 * 生成要素は5つ（4.20 生成要素の表）。
 *   1. 顧客ID
 *   2. **元ファイル**のDriveファイルID（XLSXの一時変換ファイルではない）
 *   3. 元シート名（CSVは空文字列。`null`ではない）
 *   4. 元ファイル行番号（変換前の絶対物理行番号。CSVは論理レコードの開始行）
 *   5. 再取込世代番号（既定0）
 *
 * 3の「空文字列と`null`の区別」は直列化規則が保証する（5.6.1のケースB）。
 * ここを取り違えると、CSVとXLSXで同じ行が同じIDになる。
 */
function generateTransactionId(tx) {
  if (!tx) throw new TypeError('generateTransactionId requires a transaction');
  var customerId = tx.customerId;
  var fileId = txInput_(tx, ['fileId', 'sourceFileId'], null);
  if (!customerId || !fileId) {
    throw new TypeError('generateTransactionId requires customerId and fileId');
  }

  // シート名はCSVで空文字列。未指定を`null`のまま渡すと別のIDになる。
  var sheetName = tx.sourceSheetName;
  if (sheetName === null || sheetName === undefined) sheetName = '';

  var sourceRow = Number(txInput_(tx, ['sourceRow', 'sourceRowNumber', 'startPhysicalRow'], NaN));
  if (!Number.isInteger(sourceRow) || sourceRow < 1) {
    throw new TypeError('generateTransactionId requires a positive source row number');
  }

  var generation = Number(txInput_(tx, ['generation', 'reimportGeneration'], 0));
  if (!Number.isInteger(generation) || generation < 0) {
    throw new TypeError('Re-import generation must be a non-negative integer');
  }

  var full = 'TX_' + sha256Hex(utf8Bytes(serializeDeterministic(
    [String(customerId), String(fileId), String(sheetName), sourceRow, generation])));

  return {full: full, display: toDisplayId(full), version: VERSIONS.TRANSACTION_ID};
}

/**
 * 表示ID。完全値の先頭から`DISPLAY_ID_LENGTH`**文字**を取る。
 *
 * **突合には使わない**（INV-11）。短縮値は衝突し得るため、これで取引を
 * 引き当てると別の取引を書き換える。画面・要確認シート・通知の表示専用。
 */
function toDisplayId(fullId) {
  if (!fullId) throw new TypeError('toDisplayId requires a full transaction id');
  return String(fullId).slice(0, Number(SETTINGS.DISPLAY_ID_LENGTH));
}

/**
 * 表示IDの衝突を検出する（4.20）。
 *
 * 同一顧客・同一転記先で表示IDが一致し、完全値が異なる組を返す。
 * **行予約の直前に実行する。** 衝突したまま進むと、担当者が画面で見る
 * 表示IDがどちらの取引を指すか決まらない。
 */
function detectDisplayIdCollision(customer, pairs) {
  if (!Array.isArray(pairs)) throw new TypeError('detectDisplayIdCollision requires an array');
  var byDisplay = Object.create(null);
  var collisions = [];
  pairs.forEach(function(pair) {
    var display = String(pair.display);
    var full = String(pair.full);
    if (!byDisplay[display]) {
      byDisplay[display] = full;
      return;
    }
    if (byDisplay[display] !== full) {
      collisions.push({
        display: display, fullIds: [byDisplay[display], full],
        customerId: customer && customer.customerId
      });
    }
  });
  return collisions;
}

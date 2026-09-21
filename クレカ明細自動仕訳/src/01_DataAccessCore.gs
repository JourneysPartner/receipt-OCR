'use strict';

/**
 * マスタースプレッドシートのIDを解決する。
 *
 * 順序は「設定値 → Script Properties → アクティブなスプレッドシート」。
 * **アクティブなスプレッドシートへのフォールバックはメニュー実行専用である。**
 * 時間主導トリガーと継続トリガーには「アクティブなスプレッドシート」が
 * 存在しないため、そこへ頼る実装は本番の自動実行で必ず落ちる。しかも
 * 落ちる場所はデータアクセスの入口であり、原因が設定不備だと分かりにくい。
 */
function resolveMasterSpreadsheetId_() {
  if (CONFIG.MASTER_SPREADSHEET_ID) return String(CONFIG.MASTER_SPREADSHEET_ID);
  var stored = PropertiesService.getScriptProperties().getProperty('MASTER_SPREADSHEET_ID');
  if (stored) return String(stored);
  return null;
}

/** フェーズ2のシートアクセスで共有する最小限の基盤。 */
function masterSpreadsheet_() {
  var id = resolveMasterSpreadsheetId_();
  if (id) return SpreadsheetApp.openById(id);

  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new MasterDataError(
      'MASTER_SPREADSHEET_ID is not configured. A trigger run has no active ' +
      'spreadsheet to fall back to; set the script property before scheduling.');
  }
  return active;
}

/**
 * **実行中に変わらないマスターを覚えてよい区間。**
 *
 * 使用用途補完・共通取引先一覧・カード形式・取引先辞書は、取込のあいだ
 * 変わらない。ファイルごとに読み直すと12ファイルで数十回ぶんの枠を
 * これだけに使う（読取60回/分/ユーザーが取込の天井、v1.7）。
 *
 * **覚えてよいのは取込のあいだだけである。**画面からの操作やメニューの
 * 個別処理では覚えない ── そちらは人がマスターを直した直後に走ることが
 * あり、古い表で判断すると**直したはずの設定が効かない。**取込は1回の
 * 押下のあいだ同じ表で通すほうが筋が通る（ファイルごとに規則が変わらない）。
 *
 * 区間の外では常に読み直す。だから「覚えた表が残っていて次の操作に
 * 効いてしまう」ことが起きない。
 */
var runScopedReads_ = false;

function forgetRunScopedReads_() {
  runScopedMasters_ = {purposeRules: null, commonPartners: null};
  forgetFormatDefinitions_();
  forgetDictionaryCache_();
  forgetAppendedTxRows_();
  forgetDestinationSchema_();
}

function beginRunScopedReads_() {
  forgetRunScopedReads_();
  runScopedReads_ = true;
}

function endRunScopedReads_() {
  runScopedReads_ = false;
  forgetRunScopedReads_();
}

/** マスタースプレッドシートIDを保存する（4.6 設定検証から呼ぶ）。 */
function setMasterSpreadsheetId(spreadsheetId) {
  if (!spreadsheetId) throw new TypeError('setMasterSpreadsheetId requires an id');
  PropertiesService.getScriptProperties()
    .setProperty('MASTER_SPREADSHEET_ID', String(spreadsheetId));
  // 別のマスターに向け直したら、覚えている行番号も表も意味を失う（60・71）。
  forgetFileRowNumbers_();
  forgetRunScopedReads_();
}

function requireSheet_(spreadsheet, name) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw new Error('Required sheet not found: ' + name);
  return sheet;
}

function nowIso_() { return toIso8601(new Date()); }

function activeUserEmail_() {
  var user = Session.getActiveUser();
  return user && user.getEmail ? String(user.getEmail() || '') : '';
}

function makeCatalogError_(code, detail) {
  if (typeof CatalogError === 'function') return new CatalogError(code, detail);
  var error = new Error(detail || code);
  error.code = code;
  return error;
}

function leaseConflict_(detail) { return makeCatalogError_('LEASE_CONFLICT', detail); }

function withScriptLock_(callback) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(SETTINGS.LOCK_TIMEOUT_MS)) throw leaseConflict_('Script lock was not acquired');
  try { return callback(); } finally { lock.releaseLock(); }
}

/**
 * **SpreadsheetApp では書かないと決めたシート。**読取前のflushを省ける。
 *
 * ここへ足すのは「そのシートへの `setValue`／`setValues`／`appendRow` が
 * `src/` に1つも無い」と確かめた場合だけである。`flush 1` がそれを機械で
 * 確かめ続ける。
 */
var SHEETS_API_ONLY_SHEETS_ = Object.freeze([
  CONFIG.SHEET_NAMES.PROCESS_LOG,
  CONFIG.SHEET_NAMES.PERMANENT_FILE_INDEX
]);

/**
 * マスター系シートの読取はSheets APIで行う（4.23 flush規則2）。
 *
 * 処理ログ・恒久ファイルインデックス等はSheets APIで**書く**が、
 * SpreadsheetApp の読取キャッシュはその書込を即座に反映しない ── 実機で
 * 「直前に作った行が見えない」「古い状態を読んで書き戻す」が実際に起きた。
 * Sheets APIの読取は自らの書込を必ず見る。読取前の`flush()`は、逆方向
 * （appendRow等のSpreadsheetApp書込）をAPIから見える状態にするためにある。
 *
 * **そのSpreadsheetApp書込が存在しないシートでは、flushは払い損である。**
 * `flush()`は保留中の書込を全部吐き出させ、転記先の残高数式まで再計算
 * させる。処理ログと恒久ファイルインデックスは1ファイルの取込で合わせて
 * 30回前後読まれるので、そのたびの再計算が往復の4割を占めていた
 * （2026-09-20の計測：1ファイル120往復のうち読取59・flush50）。
 *
 * この2枚は Sheets API でしか書かない（`SHEETS_API_ONLY_SHEETS_`）。
 * 唯一の例外は `ensureRowExists_` の `insertRowsAfter` だが、あれは
 * **自分で直後にflushする**ので、戻った時点で API から見えている。
 * 不変条件は `flush 1` が守る ── 破ると古い行を読んで書き戻す
 * （2026-09-02の実機事故と同型）。
 */
/** 再試行と先回りで待った時間。実行ごとに初期化される（GASのグローバル）。 */
var apiBackoff_ = {count: 0, quotaCount: 0, ms: 0, paceCount: 0, paceMs: 0, paceWorstMs: 0};

function resetApiBackoff_() {
  apiBackoff_ = {count: 0, quotaCount: 0, ms: 0, paceCount: 0, paceMs: 0, paceWorstMs: 0};
}

/**
 * **上限に当たる前に、自分から待つ。**
 *
 * Sheets API の読取は60回/分/ユーザーで、これが取込の天井である（v1.6）。
 * いまは上限へ突っ込んでから罰として眠っていた ── `sheetsReadRanges_` の
 * 再試行は20秒・40秒・60秒と待つ。**当たってから待つのは、当たる前に待つより
 * ずっと高い。**実機のAmazonカード11ヶ月は81分かかったが、読取回数から出る
 * 下限は11.5分だった。7倍の差はほぼ全部この罰である（実働16%）。
 *
 * 直前1分に出した要求の時刻を覚えておき、枠に近づいたら**最も古い要求が
 * 1分の窓から出るまで**待つ。連続して測りながら進むので、待ちは数秒ずつの
 * 小さなものになる ── 貯めてから60秒眠るのとは総量が違う。
 *
 * 数えられるのは**この実行が出した要求だけ**である。前の実行や他の利用者ぶんは
 * 見えないので、枠は上限より低く取る。それでも当たったときは、枠を実測に
 * 合わせて下げる（`READ_QUOTA_FLOOR_` まで）。
 */
var READ_QUOTA_PER_MINUTE_ = 60;
var READ_QUOTA_FLOOR_ = 20;
var apiReadWindow_ = [];
var apiReadBudget_ = 55;
var apiReadLastAt_ = 0;
/**
 * この実行で先回りに待った合計。**窓と同じ寿命**である ── `apiBackoff_` は
 * ファイルごとに初期化されるので（PHASES はファイル単位で見る）、実行全体の
 * 待ち時間をあちらに置くと、2ファイル目で0に戻ってしまう。
 */
var apiReadPacedTotalMs_ = 0;

/**
 * **取込のあいだは1回ずつ間隔を空ける。**
 *
 * 窓の上限だけを見ると、枠を使い切るまで全速で走り、そこで**1回だけ長く**
 * 眠ることになる（実測：1ファイル56回の読取で、56回目に22秒）。取込は
 * 1ファイルで1分ぶんの枠をほぼ使い切るので、この長い眠りは**ファイルの
 * 途中に落ちる** ── 書込の最中に眠れば、6分の実行上限に当たって中断される。
 * 待つなら、細かく、均して待つ。
 *
 * 総時間は変わらない（枠で決まる）。変わるのは**1回の待ちの長さ**である。
 * 均せば1.1秒ずつになり、中断の危険が消える。
 *
 * 画面から呼ぶ操作では**切っておく。**Webアプリの1回の呼出しは読取8回
 * 程度で、枠には遠い。そこで1.1秒ずつ待たせたら操作が使い物にならない
 * （§3.2 の往復予算）。上限に当たりそうなときだけ窓が止める。
 */
var apiReadSmoothing_ = false;

function setReadQuotaSmoothing_(on) {
  apiReadSmoothing_ = Boolean(on);
}

/**
 * 窓を空にする。**本番では呼ばない** ── GASの実行ごとにグローバルは
 * 初期化されるので、実行の頭では既に空である。ファイルごとに初期化しては
 * ならない（`resetApiBackoff_` とは寿命が違う）。窓は1回の押下のあいだ
 * 続かなければ、直前1分を数えたことにならない。テストのためにある。
 */
/**
 * ペーサーの時計。**待ちの長さを検証するにはここを差し替えるしかない。**
 * 実際に眠って測るテストは、1ファイルぶんで1分かかる。
 */
function apiClockNow_() { return Date.now(); }

function resetApiReadWindow_() {
  apiReadWindow_ = [];
  apiReadBudget_ = 55;
  apiReadLastAt_ = 0;
  apiReadPacedTotalMs_ = 0;
  apiReadSmoothing_ = false;
}

function trimApiReadWindow_(now) {
  var cutoff = now - 60000;
  while (apiReadWindow_.length && apiReadWindow_[0] <= cutoff) apiReadWindow_.shift();
}

/**
 * 読取要求を1回出す前に呼ぶ。枠が埋まっていれば空くまで待つ。
 * @return {number} 待ったミリ秒（0なら待っていない）。
 */
function paceSheetsRead_() {
  var now = apiClockNow_();
  trimApiReadWindow_(now);
  var waitMs = 0;

  // 均し：前回から一定の間隔を空ける（取込のあいだだけ）。
  if (apiReadSmoothing_ && apiReadLastAt_) {
    var interval = Math.ceil(60000 / Math.max(1, apiReadBudget_));
    var earliest = apiReadLastAt_ + interval;
    if (earliest > now) waitMs = earliest - now;
  }

  // 窓の上限：均しを切っていても、ここは必ず守る。
  // 最も古い要求が窓から出れば1枠空く。250msは時計のずれの余白。
  if (apiReadWindow_.length >= apiReadBudget_) {
    var clearMs = (apiReadWindow_[0] + 60000) - now + 250;
    if (clearMs > waitMs) waitMs = clearMs;
  }

  var waited = 0;
  if (waitMs > 0) {
    apiBackoff_.paceCount += 1;
    apiBackoff_.paceMs += waitMs;
    // **最悪の1回**を残す。合計だけでは「均せているか」が分からない ──
    // 総時間は枠で決まるのでどちらも同じになり、違うのは1回の長さだけである。
    if (waitMs > apiBackoff_.paceWorstMs) apiBackoff_.paceWorstMs = waitMs;
    apiReadPacedTotalMs_ += waitMs;
    Utilities.sleep(waitMs);
    waited = waitMs;
    now = apiClockNow_();
    trimApiReadWindow_(now);
  }
  apiReadWindow_.push(now);
  apiReadLastAt_ = now;
  return waited;
}

/**
 * クォータに当たったことを記録する。**当たったのなら窓が実態を映していない。**
 * 枠を下げて、残りの実行では手前で止まるようにする。
 */
function noteSheetsQuotaExceeded_() {
  apiReadBudget_ = Math.max(READ_QUOTA_FLOOR_, apiReadBudget_ - 5);
}

/**
 * Sheets API の読取はすべてここを通る。**数えられていない読取があると
 * ペーシングは意味を失う** ── 枠を守っている側だけが待たされ、
 * 当たるのは避けられない。
 */
function sheetsBatchGetPaced_(spreadsheetId, request) {
  paceSheetsRead_();
  return Sheets.Spreadsheets.Values.batchGet(spreadsheetId, request);
}

/** 読取クォータに当たった種類のエラーか。 */
function isSheetsQuotaError_(error) {
  var status = Number(error && (error.code || error.status));
  return status === 429 || /Quota exceeded/i.test(String(error && error.message || ''));
}

function sheetsReadRanges_(sheet, ranges) {
  if (SHEETS_API_ONLY_SHEETS_.indexOf(String(sheet.getName())) < 0) SpreadsheetApp.flush();
  var lastError = null;
  for (var attempt = 0; attempt <= 4; attempt += 1) {
    try {
      var response = sheetsBatchGetPaced_(sheet.getParent().getId(), {
        ranges: ranges,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
        majorDimension: 'ROWS'
      });
      return (response.valueRanges || []).map(function(range) { return range.values || []; });
    } catch (error) {
      lastError = error;
      var status = Number(error && (error.code || error.status));
      var message = String(error && error.message || '');
      var quotaExceeded = isSheetsQuotaError_(error);
      if (quotaExceeded) noteSheetsQuotaExceeded_();
      var transientFailure = quotaExceeded || status === 500 || status === 503 ||
        /(?:^|\D)(?:500|503)(?:\D|$)/.test(message);
      if (!transientFailure || attempt === 4) throw error;
      // 毎分クォータ（読取60件/分/ユーザー）は数秒の指数バックオフでは
      // 回復しない。クォータ超過は分の窓が空くまで長めに待つ ── これが
      // 多段の運用操作を自然に上限内へペーシングする。
      var waitMs = quotaExceeded ? 20000 * (attempt + 1) : computeBackoffMs(attempt + 1);
      // **待った時間を記録する。**段階ごとの計時は壁時計なので、クォータ待ちが
      // そのまま「その処理が重い」ように見える ── 2026-09-20、99.6秒を
      // `getTxIndexSheet` のせいだと読み違えかけた。読取は1ファイル約59回で、
      // 60回/分の割当をほぼ使い切るため、連続取込では必ず当たる。
      apiBackoff_.count += 1;
      apiBackoff_.ms += waitMs;
      if (quotaExceeded) apiBackoff_.quotaCount += 1;
      Utilities.sleep(waitMs);
    }
  }
  throw lastError;
}

function padRowValues_(row, width) {
  var values = [];
  for (var column = 0; column < width; column += 1) {
    values.push(row && row[column] !== undefined ? row[column] : '');
  }
  return values;
}

function rowHasAnyValue_(row) {
  return Array.isArray(row) && row.some(function(value) {
    return value !== '' && value !== null && value !== undefined;
  });
}

function readSheetRows_(sheet, columns) {
  var range = quoteSheetName_(sheet.getName()) + '!A2:' + columnLetter_(columns);
  var rows = sheetsReadRanges_(sheet, [range])[0];
  // 実APIは末尾の空行を返さないが、スタブはグリッド全体を返し得る。
  // 末尾の全空行を落として両者の挙動を揃える。
  var last = rows.length;
  while (last > 0 && !rowHasAnyValue_(rows[last - 1])) last -= 1;
  var result = [];
  for (var offset = 0; offset < last; offset += 1) {
    result.push({rowNumber: offset + 2, values: padRowValues_(rows[offset], columns)});
  }
  return result;
}

/**
 * 追記先の行番号をSheets APIの読取で決める。`getLastRow()`は
 * SpreadsheetAppのキャッシュ越しであり、Sheets APIで足したばかりの行を
 * 数え落として**既存行を上書きする**行番号を返し得る。
 */
function apiLastDataRow_(sheet, columns) {
  return apiLastDataRows_([{sheet: sheet, columns: columns}])[0];
}

/**
 * 複数のシートの末尾データ行を**1回の要求で**そろえる。
 *
 * クォータが数えるのは読んだ行数でも範囲の数でもなく、**要求の回数**である
 * （読取60回/分/ユーザー、v1.7）。同じスプレッドシートの範囲は1回の
 * `batchGet` にまとめれば枠は1つしか減らない。処理ログと恒久ファイル
 * インデックスは**必ず一緒に追記する**ので、別々に数えると往復を1つ損する。
 *
 * まとめられるのは同じスプレッドシート内だけ。違うものが混ざっていたら
 * 分けて読む（呼出側が気にしなくてよいように、ここで面倒を見る）。
 */
function apiLastDataRows_(targets) {
  var bySpreadsheet = [];
  targets.forEach(function(target, index) {
    var id = target.sheet.getParent().getId();
    var group = null;
    for (var i = 0; i < bySpreadsheet.length; i += 1) {
      if (bySpreadsheet[i].id === id) { group = bySpreadsheet[i]; break; }
    }
    if (!group) { group = {id: id, sheet: target.sheet, items: []}; bySpreadsheet.push(group); }
    group.items.push({index: index, target: target});
  });
  var out = [];
  bySpreadsheet.forEach(function(group) {
    var ranges = group.items.map(function(item) {
      return quoteSheetName_(item.target.sheet.getName()) + '!A1:' +
        columnLetter_(item.target.columns);
    });
    var read = sheetsReadRanges_(group.sheet, ranges);
    group.items.forEach(function(item, position) {
      var rows = read[position] || [];
      var last = rows.length;
      while (last > 0 && !rowHasAnyValue_(rows[last - 1])) last -= 1;
      out[item.index] = last;
    });
  });
  return out;
}

/**
 * 指定列の値が一致する行を返す。
 *
 * **対象列だけを1回読む。** 以前は`createTextFinder`でシート全面を検索して
 * から列で絞っていたが、取引ログは45列×数万行になる設計であり、全面検索を
 * 状態遷移1回につき3回以上行っていた（INV-25）。`createTextFinder`は
 * **表示テキスト**で照合するため、数値・真偽値・日付のセルでは書式次第で
 * 一致しないという問題もある ── 取引IDのような文字列でしか正しく動かない。
 */
function findRowsByColumnValue_(sheet, column, value, width) {
  var name = quoteSheetName_(sheet.getName());
  var letter = columnLetter_(column);
  var columnRows = sheetsReadRanges_(sheet, [name + '!' + letter + '2:' + letter])[0];

  var target = String(value);
  var matches = [];
  for (var offset = 0; offset < columnRows.length; offset += 1) {
    var cell = columnRows[offset] ? columnRows[offset][0] : '';
    if (String(cell === undefined ? '' : cell) === target) matches.push(offset + 2);
  }
  if (!matches.length) return [];

  // 一致行だけを読む。連続していればまとめて1回で取る。
  var groups = groupConsecutiveRows(matches.map(function(rowNumber) {
    return {rowNumber: rowNumber};
  }));
  var ranges = groups.map(function(group) {
    return name + '!A' + group.startRow + ':' + columnLetter_(width) + group.endRow;
  });
  var fetched = sheetsReadRanges_(sheet, ranges);
  var rows = [];
  groups.forEach(function(group, index) {
    var values = fetched[index] || [];
    for (var row = group.startRow; row <= group.endRow; row += 1) {
      rows.push({rowNumber: row, values: padRowValues_(values[row - group.startRow], width)});
    }
  });
  return rows;
}

/**
 * 指定列が「複数の値のいずれか」に一致する行を、値ごとにまとめて返す。
 *
 * `findRowsByColumnValue_`を値の数だけ呼ぶと、**キー列の全読みが値の数だけ
 * 走る**。取引ログは1ファイルにつき数百件を扱うので、確定処理が
 * 「1件につき全列走査3回」になり、実機で1件あたり20秒かかっていた
 * （2026-09-03）。読取はキー列1回＋一致行1回の計2回に収める。
 *
 * @return {!Object<string, !Array<{rowNumber:number, values:!Array<*>}>>}
 */
/**
 * **覚えた行番号だけを読む。**鍵列の全走査を省くための口。
 *
 * `findRowsByColumnValue_` は鍵列の走査と一致行の取得で**2往復**かかる。
 * 位置が分かっているなら走査は要らず、1往復で済む ── 読取クォータ
 * （60回/分/ユーザー）が取込の天井なので、これがそのまま速さである（v1.7）。
 *
 * **読んだ行の鍵列を必ず検算する。**覚えた位置が誤っていたら、呼出側は
 * そこへ書く。1行でも食い違ったら`null`を返し、呼出側は全走査へ落ちる。
 *
 * 検算できるのは「その位置に何があるか」だけで、「他に無いか」ではない。
 * **取りこぼしの心配が無い場面でしか使ってはならない** ── いま使っているのは
 * 自分が追記した行を自分で読み直すところだけで、同じファイルへ追記できるのは
 * リースを持つこの実行だけである。
 *
 * @return {?Array<{rowNumber: number, values: Array}>} 検算に通れば行、外れたら null
 */
function readRowsByNumbers_(sheet, rowNumbers, keyColumn, expectedKeys, width) {
  if (!rowNumbers || !rowNumbers.length) return [];
  var sorted = rowNumbers.slice().sort(function(a, b) { return a - b; });
  var groups = groupConsecutiveRows(sorted.map(function(rowNumber) {
    return {rowNumber: rowNumber};
  }));
  var name = quoteSheetName_(sheet.getName());
  var ranges = groups.map(function(group) {
    return name + '!A' + group.startRow + ':' + columnLetter_(width) + group.endRow;
  });
  var fetched = sheetsReadRanges_(sheet, ranges);
  var wanted = Object.create(null);
  (expectedKeys || []).forEach(function(key) { wanted[String(key)] = true; });
  var byRow = Object.create(null);
  groups.forEach(function(group, index) {
    var rows = fetched[index] || [];
    for (var row = group.startRow; row <= group.endRow; row += 1) {
      byRow[row] = padRowValues_(rows[row - group.startRow], width);
    }
  });
  var out = [];
  for (var i = 0; i < sorted.length; i += 1) {
    var values = byRow[sorted[i]];
    if (!values || !wanted[String(values[keyColumn - 1])]) return null;
    out.push({rowNumber: sorted[i], values: values});
  }
  return out;
}

function findRowsByColumnValues_(sheet, column, values, width) {
  var wanted = Object.create(null);
  (values || []).forEach(function(value) { wanted[String(value)] = true; });
  var result = Object.create(null);
  Object.keys(wanted).forEach(function(key) { result[key] = []; });
  if (!Object.keys(wanted).length) return result;

  var name = quoteSheetName_(sheet.getName());
  var letter = columnLetter_(column);
  var columnRows = sheetsReadRanges_(sheet, [name + '!' + letter + '2:' + letter])[0];

  var matches = [];
  for (var offset = 0; offset < columnRows.length; offset += 1) {
    var cell = columnRows[offset] ? columnRows[offset][0] : '';
    var text = String(cell === undefined ? '' : cell);
    if (wanted[text]) matches.push({rowNumber: offset + 2, key: text});
  }
  if (!matches.length) return result;

  var groups = groupConsecutiveRows(matches);
  var ranges = groups.map(function(group) {
    return name + '!A' + group.startRow + ':' + columnLetter_(width) + group.endRow;
  });
  var fetched = sheetsReadRanges_(sheet, ranges);
  var keyByRow = Object.create(null);
  matches.forEach(function(match) { keyByRow[match.rowNumber] = match.key; });
  groups.forEach(function(group, index) {
    var rows = fetched[index] || [];
    for (var row = group.startRow; row <= group.endRow; row += 1) {
      result[keyByRow[row]].push(
        {rowNumber: row, values: padRowValues_(rows[row - group.startRow], width)});
    }
  });
  return result;
}

/**
 * 指定行まで行数を広げる。
 *
 * 行挿入は SpreadsheetApp であり、その変更は遅延適用される。**直後に
 * `flush()` しないと、続けて呼ぶ Sheets API から挿入後の行が見えない**
 * （4.23 flush規則1）。見えないまま書くと、書込先の行番号がずれる。
 *
 * flush を呼出側の責任にすると必ずどこかで漏れるので、挿入した本関数が
 * その場で行う。
 */
function ensureRowExists_(sheet, rowNumber) {
  if (rowNumber <= sheet.getMaxRows()) return;
  sheet.insertRowsAfter(sheet.getMaxRows(), rowNumber - sheet.getMaxRows());
  SpreadsheetApp.flush();
}

function quoteSheetName_(name) { return "'" + String(name).replace(/'/g, "''") + "'"; }

function columnLetter_(column) {
  var result = '';
  var value = column;
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function a1Range_(sheetName, row, firstColumn, lastColumn) {
  return quoteSheetName_(sheetName) + '!' + columnLetter_(firstColumn) + row + ':' + columnLetter_(lastColumn) + row;
}

/** 1列ぶんの連続した行範囲。連続行の書込を1レンジにまとめるために使う。 */
function a1ColumnRange_(sheetName, column, startRow, endRow) {
  var letter = columnLetter_(column);
  return quoteSheetName_(sheetName) + '!' + letter + startRow + ':' + letter + endRow;
}

function jsonCell_(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  try { return JSON.parse(String(value)); } catch (error) { throw new TypeError('Invalid JSON cell'); }
}

function csvEmails_(value) {
  return String(value || '').split(',').map(function(item) { return item.trim().toLowerCase(); }).filter(Boolean);
}

function valueOr_(object, names, fallback) {
  for (var index = 0; index < names.length; index += 1) {
    if (object && object[names[index]] !== undefined) return object[names[index]];
  }
  return fallback;
}

function setContiguousValues_(sheet, rowNumber, firstColumn, values) {
  ensureRowExists_(sheet, rowNumber);
  sheet.getRange(rowNumber, firstColumn, 1, values.length).setValues([values]);
}

function updateColumns_(sheet, rowNumber, updates) {
  Object.keys(updates).forEach(function(column) {
    sheet.getRange(rowNumber, Number(column)).setValue(updates[column]);
  });
}


'use strict';

/**
 * 1ファイルの取込にかかる**サーバー往復回数**を固定する。
 *
 * 実行が6分の上限に当たるかどうかを決めるのは計算量ではなく往復回数である
 * （実機で往復1回はおよそ0.5〜0.8秒）。2026-09-03、取引1件あたり25往復
 * かかっており、7〜8件の明細で6分を使い切って強制終了された。原因は
 * 取引ログ・処理ログ・行予約を**取引ごとに**読み書きしていたこと。
 *
 * ここで固定するのは「**往復回数が明細の件数に比例して増えないこと**」で
 * ある。総量の上限も置くが、主眼は比例しないこと ── 比例していれば、
 * 大きなファイルはいつか必ず上限に当たる。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const blank = (n) => Array(n).fill('');
  const sheetHeader = (n, label) => { const r = blank(n); r[0] = label; return r; };
  const AE = JSON.stringify({row: 1, cells: [{column: 2, text: '利用日', match: 'exact'}]});

  function customerRow() {
    const row = blank(37);
    Object.assign(row, {
      0: 'C001', 1: '顧客A', 2: 'TRUE', 3: 'folder1', 5: 'dest1', 7: '入力用シート', 8: '取引先一覧',
      9: 2, 10: 3, 11: 4, 12: 5, 13: 6, 14: 7, 15: '1.0',
      16: 'reviewer@example.com', 17: 'admin@example.com', 18: 0, 20: 'システム情報', 21: '',
      23: 0, 24: 0, 29: 1, 30: AE, 31: '{}', 32: '{}', 33: 8,
      34: '取引先一覧', 35: 'CORPORATE', 36: ''
    });
    return row;
  }

  function formatRow() {
    const row = blank(34);
    Object.assign(row, {
      0: 'smbc_family', 1: '三井住友系', 2: 'active', 3: 'TRUE', 4: '["csv"]',
      5: JSON.stringify({allOf: [{maxRow: 1, keywords: ['利用日', '利用店名', '金額', '使用用途'], minMatch: 4}]}),
      6: 1, 7: 2, 8: 'A', 9: 'B', 10: 'C', 11: 'D', 12: '',
      14: JSON.stringify({excludeRowRanges: [{from: 1, to: 1}], excludeWhenDateAndAmountEmpty: true, rules: []}),
      16: JSON.stringify({sources: [{id: 'fn', kind: 'fileName', pattern: '(20\\d{2})(0[1-9]|1[0-2])',
        groups: {year: 1, month: 2}, yearDigits: 4, means: 'payment', offsetMonths: 1}]}),
      17: 'generic', 18: 1, 19: 'admin@example.com', 21: '2026-01-01T00:00:00+09:00',
      29: 'NEW', 33: '2026-01-01T00:00:00+09:00'
    });
    return row;
  }

  function dictRow() {
    const row = blank(18);
    Object.assign(row, {
      0: 'DICT_1', 1: 'ローソン', 2: 'ローソン', 3: '株式会社ローソン',
      4: 'exact_original', 5: 1, 6: '', 7: '', 8: '', 9: 'TRUE',
      10: 'admin@example.com', 12: '2026-01-01T00:00:00+09:00', 13: 1,
      14: 'TRUE', 15: 'FALSE'
    });
    return row;
  }

  /** 明細`txCount`件のCSV1本を取り込み、その実行で使った往復回数を返す。 */
  function measure(txCount, fileCount) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [sheetHeader(37, '顧客ID'), customerRow()]},
      {name: 'カード形式マスター', values: [sheetHeader(34, '形式ID'), formatRow()]},
      {name: '使用用途補完マスター', values: [sheetHeader(10, 'ルールID'),
        Object.assign(blank(10), {0: 'PR1', 1: '仕入', 2: '仕入れ', 3: 'TRUE'})]},
      {name: '共通取引先辞書', values: [sheetHeader(18, '辞書ID'), dictRow()]}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.stubs.createSpreadsheet('dest1', {sheets: [
      {name: '入力用シート',
       values: [['', '利用日', 'freee取引先名', '摘要', '金額', 'メモ', '内部ID', '']],
       maxRows: 4 + txCount * 3, maxColumns: 8},
      {name: '取引先一覧', values: [['取引先']]}
    ]});
    gas.stubs.createSpreadsheet('txidx', {sheets: []});
    gas.stubs.createSpreadsheet('snap', {sheets: []});
    gas.evaluate(`
      SETTINGS.EXECUTION_TIMEOUT_SECONDS = 300;
      SETTINGS.SAFETY_MARGIN_SECONDS = 60;
      SETTINGS.TX_INDEX_SPREADSHEET_ID = 'txidx';
      SETTINGS.SNAPSHOT_SPREADSHEET_ID = 'snap';
      SETTINGS.SAMPLE_CORPUS_FOLDER_ID = 'corpus';
      SETTINGS.PARALLEL_WORK_FOLDER_ID = '';
      SETTINGS.FAULT_INJECTION = null;
    `);
    gas.stubs.setActiveUser('admin@example.com');

    let csv = '利用日,利用店名,金額,使用用途\n';
    for (let i = 0; i < txCount; i += 1) {
      csv += `2025/12/${String((i % 28) + 1).padStart(2, '0')},ローソン,${1000 + i},仕入れ\n`;
    }
    const fileIds = [];
    for (let f = 0; f < (fileCount || 1); f += 1) {
      const id = f === 0 ? 'fileA' : 'file' + f;
      gas.stubs.createFile(id, {
        name: `三井住友カード2026${String(f + 1).padStart(2, '0')}.csv`,
        bytes: Buffer.from(csv, 'utf8'),
        lastUpdated: new Date(Date.now() - 3600 * 1000),
        createdTime: '2026-08-01T00:00:00Z', contentType: 'text/csv'
      });
      fileIds.push(id);
    }
    gas.stubs.createFolder('folder1', {fileIds: fileIds});

    gas.stubs.resetRoundTrips();
    const report = plain(gas.call('runImport', [{}]));
    const trips = gas.stubs.roundTrips();
    const file = report.customers[0].files[0];
    assert.equal(file.outcome, 'WRITTEN', JSON.stringify(file));
    if (!fileCount || fileCount === 1) assert.equal(file.written, txCount);
    return trips.rangeReads + trips.rangeWrites + trips.flushes;
  }

  test('a file costs the same number of server round trips whatever its size', () => {
    const few = measure(2);
    const many = measure(22);
    assert.equal(many, few,
      `2件で${few}往復、22件で${many}往復。件数に比例して増えている ── ` +
      '大きなファイルは必ず6分の実行上限に当たる。取引ごとの読み書きを' +
      'まとめる経路（settleWrittenTransactions・registerPrepared・行予約）を見よ。');
  });

  test('partner matching does not redo per-rule work for every transaction', () => {
    // 照合は「取引 × 辞書規則」の二重ループである。規則ごとに正規化や
    // タイムゾーン変換をやり直すと、実運用規模（顧客辞書3,870件）で
    // 往復を全部潰した後でも実機の数十秒をここで使う（2026-09-03）。
    gas.stubs.reset();
    const rules = [];
    for (let i = 0; i < 3000; i += 1) {
      rules.push({ruleId: 'D' + i, dictId: 'D' + i, customerId: 'C001',
        original: 'ﾃｽﾄ店舗' + i + '　支店', normalized: '', partnerName: '株式会社テスト' + i,
        matchMethod: 'exact_original', priority: 1, active: true, approved: true, conflict: false});
    }
    gas.context.__rules = rules;
    const index = gas.evaluate(
      'buildDictionaryIndex("C001", {customer: __rules, common: [], commonPartners: []})');
    const txs = [];
    for (let i = 0; i < 50; i += 1) {
      txs.push({merchantOriginal: 'ﾃｽﾄ店舗' + (i * 7) + '　支店',
        date: new Date('2025-12-01T00:00:00Z')});
    }
    gas.context.__txs = txs;
    gas.context.__index = index;
    const started = Date.now();
    gas.evaluate('__txs.forEach(function(tx) { matchPartner(tx, "C001", __index); });');
    const elapsed = Date.now() - started;
    delete gas.context.__rules; delete gas.context.__txs; delete gas.context.__index;
    // 規則ごとに変換をやり直す実装だと、同じ条件でおよそ6,000msかかる。
    assert.ok(elapsed < 1500,
      `50取引×辞書3,000件の照合に${elapsed}ms。規則ごとの変換をやり直していないか` +
      '（merchantNormalized_・merchantRuleInPeriod_の記憶化を見よ）');
  });

  test('the fixed cost of one file stays within budget', () => {
    // 実機の往復1回はおよそ0.5〜0.8秒。200往復＝2分強で、6分の上限に対して
    // 1実行で複数ファイルを扱う余地が要る。上限を上げる前に、増えた理由を疑うこと。
    const trips = measure(3);
    assert.ok(trips <= 200, `1ファイルの固定往復が${trips}回。予算200回を超えた`);
  });

  /** 前検査（step 4）が何件のファイルを見たかだけを数える。 */
  function countPreflightChecks(fn) {
    let calls = 0;
    const real = gas.context.runIntegrityCheck;
    gas.context.runIntegrityCheck = function() { calls += 1; return real.apply(this, arguments); };
    try { fn(); } finally { gas.context.runIntegrityCheck = real; }
    return calls;
  }

  /** 恒久索引と処理ログの状態を揃えて動かす（片方だけだと同期検査が鳴る）。 */
  function setFileState(fileId, state) {
    const master = gas.stubs.getSpreadsheet('master');
    [['恒久ファイルインデックス', 1, 4], ['クレカ処理ログ', 8, 17]].forEach(
      ([name, idColumn, stateColumn]) => {
        const sheet = master.getSheetByName(name);
        const values = sheet.getDataRange().getValues();
        const index = values.findIndex((row) => String(row[idColumn - 1]) === String(fileId));
        assert.ok(index > 0, `${name} に ${fileId} が無い`);
        sheet.getRange(index + 1, stateColumn).setValue(state);
      });
  }

  test('scope 1: the pre-flight check looks at what this call can touch, not the whole history', () => {
    // 顧客の全履歴を毎回見ていた ── 実機で47ファイル、固定費221秒
    // （2026-09-20 実測）。ファイルは増える一方なので、使うほど遅くなる。
    // 見るのは「今回の候補」＋「終端でないファイル」だけでよい。
    // **絞りすぎてもいけない** ── 今回触るファイルと、書きかけで残った
    // ファイルを外したら、壊れた転記先へ書き足す。
    measure(3);
    setFileState('fileA', 'DISCOVERED');   // 取り込み直す ＝ 今回の候補になる
    gas.call('clearSubmittedContentHash', ['fileA']);
    assert.equal(countPreflightChecks(() => gas.call('runImport', [{}])), 1,
      '今回取り込むファイルを前検査から外している');
  });

  test('scope 3: a file left unfinished is checked even when this run does not touch it', () => {
    // 書きかけで残ったファイルは、次に同じ転記先へ書くときの危険そのもの。
    // 「今回の候補だけ」に絞ると、これを見落とす。
    measure(3);
    setFileState('fileA', 'REVIEW_WAIT');
    assert.equal(
      countPreflightChecks(() => gas.call('runImport', [{fileIds: ['NO_SUCH_FILE']}])), 1,
      '終端に至っていないファイルを前検査から外している');
  });

  test('scope 2: a completed file the run does not touch is not re-checked', () => {
    // 完了済みで今回触らないファイルは、この実行では壊しようがない。
    // 見続けると、ファイル数に比例して取込が遅くなる。
    measure(3);   // fileA を取り込んで終端まで進める

    const scanned = [];
    const real = gas.context.getTransactionsByStatus;
    gas.context.getTransactionsByStatus = function(fileId) {
      scanned.push(String(fileId));
      return real.apply(this, arguments);
    };
    try {
      // 候補が1件も無い実行。前検査だけが走る。
      gas.call('runImport', [{fileIds: ['NO_SUCH_FILE']}]);
    } finally {
      gas.context.getTransactionsByStatus = real;
    }
    assert.deepEqual(scanned.filter((id) => id === 'fileA'), [],
      '完了済みで今回触らないファイルを、取込のたびに読み直している');
  });

  test('round trips 3: opening spreadsheets does not scale with the number of transactions', () => {
    // **`SpreadsheetApp.openById` は実機ではサーバー往復で、実測 約2.9秒。**
    // ところが**この計器はそれを数えていなかった** ── スタブでは Map の検索
    // なので `rangeReads/Writes/flushes` のどれにも現れない。そのせいで
    // 「往復は件数に比例しない」という上のテストが通り続けたまま、
    // `registerPrepared` が取引ごとに取引インデックスを開いていた
    // （34件のファイルで99.6秒、取込全体の64%。2026-09-20 実測）。
    //
    // 数え落としている往復があるなら、それを数えるテストを足すしかない。
    function opens(txCount) {
      let count = 0;
      const real = gas.context.SpreadsheetApp.openById;
      gas.context.SpreadsheetApp.openById = function(id) {
        count += 1;
        return real.apply(this, arguments);
      };
      try { measure(txCount); } finally { gas.context.SpreadsheetApp.openById = real; }
      return count;
    }
    const few = opens(2);
    const many = opens(22);
    assert.ok(many <= few + 2,
      `2件で${few}回、22件で${many}回 openById している。件数に比例して開いている ── ` +
      '実機では1回あたり数秒かかるので、大きなファイルは必ず6分の上限に当たる。' +
      '取引ごとに開いている箇所（getTxIndexSheet・masterSpreadsheet_）を見よ。');
  });

  test('flush 1: the sheets that skip the pre-read flush are never written through SpreadsheetApp', () => {
    // `sheetsReadRanges_` は `SHEETS_API_ONLY_SHEETS_` のシートで
    // 読取前の `flush()` を省く。省ける根拠は「そのシートを
    // SpreadsheetApp で書く箇所が1つも無い」ことだけである。
    // 1行でも `setValue` を足すと、**flushを省いた全経路が古い行を読み始め**、
    // 古い値を書き戻す（2026-09-02 の実機事故と同型）。人の記憶では守れない。
    const fs = require('node:fs');
    const path = require('node:path');
    const srcDir = path.join(process.cwd(), 'src');
    const accessors = {
      'クレカ処理ログ': 'processLogSheet_',
      '恒久ファイルインデックス': 'permanentFileIndexSheet_'
    };
    // **宣言したシートは必ず検査対象にする。**この確認が無いと、
    // `SHEETS_API_ONLY_SHEETS_` へ1枚足すだけで、そのシートは
    // 「flushを省くのに誰も見張らない」状態になる。
    (gas.context.SHEETS_API_ONLY_SHEETS_ || []).forEach((name) => {
      assert.ok(accessors[name],
        `${name} の取得関数がこの表に無い。SHEETS_API_ONLY_SHEETS_ へ足すなら、` +
        'その書込を機械で見張れるようにここへも足すこと');
    });
    const offenders = [];
    fs.readdirSync(srcDir).filter((name) => name.endsWith('.gs')).forEach((name) => {
      const text = fs.readFileSync(path.join(srcDir, name), 'utf8');
      text.split('\n').forEach((line, index) => {
        Object.values(accessors).forEach((accessor) => {
          if (line.indexOf(accessor + '()') < 0) return;
          if (!/\.(setValue|setValues|appendRow|insertRowBefore|insertRowsAfter|deleteRow|clear)\s*\(/.test(line)) return;
          offenders.push(`${name}:${index + 1}  ${line.trim().slice(0, 90)}`);
        });
      });
    });
    assert.deepEqual(offenders, [],
      'flushを省いたシートへ SpreadsheetApp で書いている。' +
      'Sheets API（Sheets.Spreadsheets.Values.batchUpdate）へ寄せるか、' +
      '01 の SHEETS_API_ONLY_SHEETS_ から外すこと:\n' + offenders.join('\n'));
  });

  test('flush 2: reading the process log no longer forces a recalculation', () => {
    // 効果の実測。1ファイルの取込で処理ログと恒久索引は合わせて30回前後
    // 読まれ、以前はそのたびに flush していた（往復の4割）。
    measure(3);
    const after = gas.stubs.roundTrips();

    const saved = gas.context.SHEETS_API_ONLY_SHEETS_;
    gas.context.SHEETS_API_ONLY_SHEETS_ = [];
    try {
      measure(3);
    } finally {
      gas.context.SHEETS_API_ONLY_SHEETS_ = saved;
    }
    const before = gas.stubs.roundTrips();

    assert.equal(after.rangeReads, before.rangeReads, '読取の回数は変えていない');
    assert.ok(after.flushes < before.flushes - 20,
      `flushが${before.flushes}回から${after.flushes}回にしかならない。` +
      '省けているか（SHEETS_API_ONLY_SHEETS_ が効いているか）を見よ');
  });

  /**
   * 状態記帳の読取を数える。
   *
   * 処理ログと恒久ファイルインデックスの行を読むのは
   * `cachedFileRecord_` だけなので、そこを通った読取を数えれば
   * 「1ファイルの取込で状態の行を何回読んだか」がそのまま出る。
   */
  function bookkeepingReads(txCount) {
    let inside = 0;
    gas.stubs.onRoundTrip((kind) => {
      if (kind !== 'rangeReads') return;
      if (/cachedFileRecord_/.test((new Error()).stack)) inside += 1;
    });
    try { measure(txCount); } finally { gas.stubs.onRoundTrip(null); }
    return inside;
  }

  test('reads 1: the state rows are not read again once they have been written', () => {
    // 読取クォータ（60回/分/ユーザー）が取込の天井である。1ファイルの読取は
    // 約59回で、1分ぶんの枠をほぼ使い切る ── 12ファイル連続なら必ず
    // バックオフに当たり、当たれば20秒以上眠る（v1.6）。だから
    // **同じ行を読み直さないことが、そのまま速さである。**
    //
    // この仕掛けで実測（2026-09-20）：**28回 → 15回**。
    // `transitionFileState` → `updateProcessLog` → `updateFilePrefix` が
    // 同じ2行を読み直していた分である。
    const reads = bookkeepingReads(3);
    assert.ok(reads <= 16,
      `状態の行を${reads}回読んでいる（上限16、この仕掛けを入れる前は28回）。` +
      '書いた行を呼出側へ返して読み直しを省く経路' +
      '（writtenRecords_・createOrUpdateProcessLogの戻り値・updateFilePrefixのknown）' +
      'が切れていないかを見よ。読取はクォータ60回/分の枠をそのまま食う。');
    assert.ok(reads >= 1, '数えられていない。onRoundTripの掛け方を見よ');
  });

  test('reads 2: the state rows do not get read more often for a bigger file', () => {
    // 件数に比例したら、大きなファイルはいつか必ずクォータに当たる。
    assert.equal(bookkeepingReads(20), bookkeepingReads(3),
      '明細の件数で状態の読取が変わる');
  });

  test('prefix 1: the rename after a transition uses the new prefix, not the one it replaced', () => {
    // `updateFilePrefix` は書込の戻り値を受け取って読み直しを省く。
    // 戻り値が**書いた値を当てていなければ**、古い接頭辞で改名してしまう
    // ── 読み直しを省いた代償が、状態と名前の食い違いになる。
    measure(2);
    gas.context.__out = gas.evaluate(
      '(function() {' +
      '  var before = DriveApp.getFileById("fileA").getName();' +
      '  var record = getProcessLogRecord_("fileA");' +
      '  var written = updateProcessLog("fileA", {expectedPrefix: "【新】"}, record);' +
      '  updateFilePrefix("fileA", written);' +
      '  return {before: before, after: DriveApp.getFileById("fileA").getName()};' +
      '})()');
    const out = plain(gas.context.__out);
    assert.equal(out.before, '【済】三井住友カード202601.csv', out.before);
    assert.equal(out.after, '【新】三井住友カード202601.csv',
      `改名が「${out.after}」になっている。書込の戻り値が古い行のままで、` +
      'いま書いた接頭辞が反映されていない（writtenRecords_ を見よ）');
  });

  test('prefix 2: a rename that still needs repair is repaired', () => {
    // 成功経路では `OK` の行へ `OK` を書き直さない（往復の無駄）。
    // その代わり、**まだ `OK` でない行は必ず直す**こと。
    measure(2);
    gas.context.__out = gas.evaluate(
      '(function() {' +
      '  updateProcessLog("fileA", {renameState: RENAME_STATE.PENDING_RETRY, renameRetryCount: 2});' +
      '  updateFilePrefix("fileA");' +
      '  var after = getProcessLogRecord_("fileA");' +
      '  return {state: String(after.values[31]), count: Number(after.values[32])};' +
      '})()');
    const out = plain(gas.context.__out);
    assert.equal(out.state, 'OK',
      `改名待ちの行が「${out.state}」のまま直っていない。` +
      '同じ値を書き直さない条件が、直すべき行まで飛ばしている');
    // 回数は0へ戻さず**そのまま書き戻す**（元からの挙動）。だから
    // 「状態がOKで回数が0でない行」が残り得る ── 同じ値を書き直さない
    // 条件が回数も見ているのはそのためである。
    assert.equal(out.count, 2, '再試行回数は直した後もそのまま残る');
  });

  test('hash 1: the submitted content hash stays immutable even when the caller hands over a row', () => {
    // 呼出側が読んだ行を渡せるようにしたが、**INV-07 の判定にだけは
    // 渡された行を使わない**。あの不変条件は「現在の値が空か、同じ値か」で
    // 判定するので、空だった頃の行で判定すれば書き換えを通してしまう。
    measure(2);
    gas.context.__out = gas.evaluate(
      '(function() {' +
      '  clearSubmittedContentHash("fileA");' +
      '  var stale = getProcessLogRecord_("fileA");' +   // ハッシュが空の頃の行
      '  updateProcessLog("fileA", {submittedContentHash: "HASH_A"});' +
      '  try {' +
      '    updateProcessLog("fileA", {submittedContentHash: "HASH_B"}, stale);' +
      '    return {threw: false, value: String(getProcessLogRecord_("fileA").values[12])};' +
      '  } catch (error) {' +
      '    return {threw: true, value: String(getProcessLogRecord_("fileA").values[12])};' +
      '  }' +
      '})()');
    const out = plain(gas.context.__out);
    assert.equal(out.threw, true,
      '古い行を渡すと提出時点の内容ハッシュを書き換えられてしまう（INV-07）');
    assert.equal(out.value, 'HASH_A', 'ハッシュが書き換わっている');
  });

  test('masters 1: a table that cannot change during a run is read once, not once per file', () => {
    // 使用用途補完マスターと共通取引先一覧は取込が書く先ではない（書くのは
    // 初期設定だけ）。それでもファイルごとに読み直していた ── 12ファイルなら
    // 同じ表を12回読む。読取クォータ（60回/分/ユーザー）が取込の天井なので、
    // これはそのまま待ち時間になる。
    measure(2);
    // 覚えるのは取込のあいだだけなので、その区間を開いてから測る。
    gas.evaluate('beginRunScopedReads_();');

    gas.stubs.resetRoundTrips();
    gas.context.__cold = gas.evaluate(
      '[purposeRulesForRun_(), commonPartnersForRun_()]');
    const cold = gas.stubs.roundTrips().rangeReads;

    gas.stubs.resetRoundTrips();
    gas.context.__warm = gas.evaluate(
      '[purposeRulesForRun_(), commonPartnersForRun_()]');
    const warm = gas.stubs.roundTrips().rangeReads;

    assert.equal(cold, 2, `初回に${cold}回読んでいる（2つの表で2回のはず）`);
    assert.equal(warm, 0,
      `2回目にも${warm}回読んでいる。実行のあいだ変わらない表を` +
      'ファイルごとに読み直している（71 の runScopedMasters_ を見よ）');
    assert.deepEqual(plain(gas.context.__warm), plain(gas.context.__cold),
      '覚えた値が読み直した値と食い違う');
  });

  test('masters 2: pointing at another master throws the remembered tables away', () => {
    // 覚えるのは1回の押下の中だけだが、マスターを向け直したら無効である。
    measure(2);
    gas.evaluate('beginRunScopedReads_();');
    gas.evaluate('purposeRulesForRun_(); commonPartnersForRun_();');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.stubs.resetRoundTrips();
    gas.evaluate('purposeRulesForRun_(); commonPartnersForRun_();');
    assert.equal(gas.stubs.roundTrips().rangeReads, 2,
      '向け直したのに古い表を使っている');
  });


  /**
   * **枠を消費する読取だけを数える。**
   *
   * 読取には2種類ある ── `Sheets.Spreadsheets.Values.batchGet` は
   * `Read requests per minute per user`（60回/分）を消費し、`SpreadsheetApp`
   * の読取は消費しない。取込の天井を決めるのは前者だけなので、往復の総数では
   * なくこちらを見る（v1.7）。
   */
  function apiReads(body) {
    let count = 0;
    gas.stubs.onRoundTrip((kind) => {
      if (kind !== 'rangeReads') return;
      if (/batchGet/.test((new Error()).stack)) count += 1;
    });
    try { body(); } finally { gas.stubs.onRoundTrip(null); }
    return count;
  }

  /**
   * 枠を消費する読取を**シート別に**数える。
   *
   * 合計だけを見ていると、1〜2回の増減は上限の余白に隠れてしまう ──
   * 「実行中に変わらない表を読み直していないか」は、その表を何回読んだかで
   * 見るしかない。読取は `sheetsBatchGetPaced_` に一本化されているので、
   * そこを包めば範囲がそのまま取れる。
   */
  function apiRangeCounts(body) {
    gas.evaluate(
      '__ranges = [];' +
      '__realPacedForTest = sheetsBatchGetPaced_;' +
      'sheetsBatchGetPaced_ = function(id, req) {' +
      '  __ranges.push((req.ranges || [])[0] || "");' +
      '  return __realPacedForTest(id, req);' +
      '};');
    try { body(); } finally {
      gas.evaluate('sheetsBatchGetPaced_ = __realPacedForTest;');
    }
    const counts = {};
    plain(gas.evaluate('__ranges')).forEach((range) => {
      const sheet = String(range).split('!')[0].replace(/'/g, '');
      counts[sheet] = (counts[sheet] || 0) + 1;
    });
    return counts;
  }

  test('budget 1: the quota-consuming reads per file stay within budget', () => {
    // 12ヶ月の取込にかかる時間を決めるのは**1ファイル増やすごとの費用**である
    // （固定費は1回きり）。2026-09-20 実測：固定費12回＋1ファイル37回。
    // 12ファイル＝456回、60回/分なので**7.6分がクォータだけで要る。**
    const one = apiReads(() => measure(20, 1));
    const two = apiReads(() => measure(20, 2));
    const perFile = two - one;
    const twelve = one + perFile * 11;
    assert.ok(perFile <= 38,
      `1ファイル増やすごとに枠を${perFile}回消費している（上限40）。` +
      `12ファイルなら${twelve}回＝${(twelve / 60).toFixed(1)}分がクォータだけで要る`);
  });

  test('budget 2: the quota-consuming reads do not grow with the number of transactions', () => {
    assert.equal(apiReads(() => measure(40, 1)), apiReads(() => measure(4, 1)),
      '明細の件数で枠の消費が変わる。大きなファイルほどクォータに当たる');
  });

  test('cache 1: within one import the unchanging masters are read once, not once per file', () => {
    // カード形式マスター・取引先辞書・使用用途補完・共通取引先一覧は、
    // 取込が書く先ではない。それでもファイルごとに読み直していた
    // （1ファイルあたり6回）。12ファイルなら72回ぶんの枠をこれだけに使う。
    const counts = apiRangeCounts(() => measure(20, 4));
    const once = ['カード形式マスター', '共通取引先辞書', '顧客別取引先辞書',
      '使用用途補完マスター', '共通取引先一覧'];
    const offenders = once.filter((name) => (counts[name] || 0) > 1)
      .map((name) => `${name}=${counts[name]}回`);
    assert.deepEqual(offenders, [],
      '4ファイルの取込で、実行のあいだ変わらない表を複数回読んでいる: ' +
      offenders.join(', ') + '（1回のはず）');
    assert.ok((counts['カード形式マスター'] || 0) === 1,
      'カード形式マスターを一度も読んでいない。数え方が壊れている');
  });

  test('cache 2: outside an import nothing is remembered, so a master edit takes effect at once', () => {
    // 画面からの操作やメニューの個別処理は、人がマスターを直した直後に
    // 走ることがある。古い表で判断すると**直したはずの設定が効かない。**
    measure(2);
    gas.evaluate('endRunScopedReads_();');
    const before = plain(gas.evaluate('loadFormatDefinitions({}).length'));

    const row = blank(34);
    Object.assign(row, {0: 'another_format', 1: '別形式', 2: 'active', 3: 'TRUE', 4: '["csv"]',
      6: 1, 7: 2, 8: 'A', 9: 'B', 10: 'C', 11: 'D', 17: 'generic', 18: 1,
      19: 'admin@example.com', 21: '2026-01-01T00:00:00+09:00', 29: 'NEW',
      33: '2026-01-01T00:00:00+09:00'});
    gas.context.__row = row;
    gas.evaluate(
      'SpreadsheetApp.openById("master").getSheetByName("カード形式マスター")' +
      '.appendRow(__row)');

    assert.equal(plain(gas.evaluate('loadFormatDefinitions({}).length')), before + 1,
      '取込の外なのに古い形式定義を使っている。直した設定が効かない');
  });

  test('dict 1: every dictionary write goes through the accessor that forgets the cache', () => {
    // 辞書は取込のあいだ覚えるが、**書く経路がある**（学習・パターン登録・
    // 共通への昇格・巻き戻し・無効化）。読みのほうの取得口で書くと、
    // 覚えた行が古いまま残る。人の記憶では守れない。
    const fs = require('node:fs');
    const path = require('node:path');
    const srcDir = path.join(process.cwd(), 'src');
    const offenders = [];
    fs.readdirSync(srcDir).filter((name) => name.endsWith('.gs')).forEach((name) => {
      fs.readFileSync(path.join(srcDir, name), 'utf8').split('\n').forEach((line, index) => {
        if (line.indexOf('dictionarySheet_(') < 0) return;
        if (/function dictionar(y|yWrite)Sheet_/.test(line)) return;
        if (line.indexOf('dictionaryWriteSheet_(') >= 0) return;
        if (!/\.(setValue|setValues|appendRow|insertRow|deleteRow|clear)\s*\(/.test(line) &&
            !/var sheet = dictionarySheet_/.test(line)) return;
        offenders.push(`${name}:${index + 1}  ${line.trim().slice(0, 90)}`);
      });
    });
    assert.deepEqual(offenders, [],
      '辞書を読みの取得口で書いている。dictionaryWriteSheet_ を使うこと' +
      '（覚えた行を捨てる）:\n' + offenders.join('\n'));
  });

  test('tx 1: deciding whether a file is fully resolved reads its transactions once', () => {
    // `findRowsByColumnValue_` は鍵列の走査と一致行の取得で2往復かかる。
    // 状態違いで2度呼べば同じ行を2度読む ── 1ファイルで4往復だった。
    measure(4);
    gas.context.__fid = 'fileA';
    const reads = apiReads(() => gas.evaluate('isFileFullyResolved(__fid)'));
    assert.ok(reads <= 2,
      `解決済みかの判定に${reads}往復かかっている（2往復のはず）。` +
      '状態ごとに読み直している');
  });


  test('dict 2: writing the dictionary during an import makes the next read see it', () => {
    // 取込のあいだ辞書を覚えるが、**書く経路がある。**捨て忘れると、
    // 学習した取引先がその押下のあいだ効かない。
    measure(2);
    gas.evaluate('beginRunScopedReads_();');
    try {
      const before = plain(gas.evaluate('readDictionary_(false).length'));
      gas.evaluate(
        'learnFromResolution("C001", "ﾆｭｰﾃﾝﾎ", normalizeMerchant("ﾆｭｰﾃﾝﾎ"),' +
        ' "株式会社ニュー店舗", "admin@example.com")');
      const after = plain(gas.evaluate('readDictionary_(false).length'));
      assert.equal(after, before + 1,
        '書いた辞書がその押下のあいだ見えない。覚えた行を捨てていない');
    } finally {
      gas.evaluate('endRunScopedReads_();');
    }
  });

  test('tx 2: transactions that are no longer active are not counted', () => {
    // 1回の読取にまとめたとき、有効行の絞り込みを落とすと
    // 取消済みの取引まで「未解決」に数えてしまい、ファイルが完了しなくなる。
    measure(4);
    gas.context.__out = gas.evaluate(
      '(function() {' +
      '  var all = getTransactionsForFile_("fileA");' +
      '  var sheet = transactionLogSheet_();' +
      '  var first = findRowsByColumnValue_(sheet, 5, "fileA", TRANSACTION_LOG_WIDTH_)[0];' +
      '  sheet.getRange(first.rowNumber, 42, 1, 1).setValues([[false]]);' +  // 有効フラグ
      '  return {before: all.length, after: getTransactionsForFile_("fileA").length};' +
      '})()');
    const out = plain(gas.context.__out);
    assert.equal(out.after, out.before - 1,
      `有効でない取引が数に残っている（${out.before}→${out.after}）`);
  });

  test('pace 1: every Sheets read goes through the pacer', () => {
    // 数えられていない読取が1つでもあれば、ペーシングは意味を失う ──
    // 枠を守っている経路だけが待たされ、上限に当たるのは避けられない。
    // 読取の経路は3つある（01・43・45）。人の記憶では守れない。
    const fs = require('node:fs');
    const path = require('node:path');
    const srcDir = path.join(process.cwd(), 'src');
    const offenders = [];
    fs.readdirSync(srcDir).filter((name) => name.endsWith('.gs')).forEach((name) => {
      fs.readFileSync(path.join(srcDir, name), 'utf8').split('\n').forEach((line, index) => {
        if (line.indexOf('Sheets.Spreadsheets.Values.batchGet') < 0) return;
        // 通し場所（01 の sheetsBatchGetPaced_）だけが直接呼んでよい
        if (/function sheetsBatchGetPaced_/.test(line)) return;
        if (name === '01_DataAccessCore.gs' &&
            /return Sheets\.Spreadsheets\.Values\.batchGet\(spreadsheetId, request\);/.test(line)) return;
        offenders.push(`${name}:${index + 1}  ${line.trim().slice(0, 90)}`);
      });
    });
    assert.deepEqual(offenders, [],
      'Sheets API の読取をペーサーを通さずに呼んでいる。' +
      'sheetsBatchGetPaced_ 経由にすること（01）:\n' + offenders.join('\n'));
  });

  test('pace 2: the pacer waits before the quota is spent, not after', () => {
    // 当たってから待つのは、当たる前に待つよりずっと高い ──
    // 再試行は20秒・40秒・60秒と眠る。実機のAmazonカード11ヶ月は81分
    // かかったが、読取回数から出る下限は11.5分だった（実働16%）。
    gas.evaluate('resetApiReadWindow_(); resetApiBackoff_();');

    // 枠の手前までは待たない
    gas.context.__a = gas.evaluate(
      '(function() { var waits = []; for (var i = 0; i < apiReadBudget_; i += 1) ' +
      '{ waits.push(paceSheetsRead_()); } return waits; })()');
    const before = plain(gas.context.__a);
    assert.deepEqual(before.filter((w) => w > 0), [],
      `枠の手前で待っている（${before.filter((w) => w > 0).length}回）`);

    // 枠に達したら待つ。待つのは「最も古い要求が1分の窓から出るまで」
    const wait = gas.evaluate('paceSheetsRead_()');
    assert.ok(wait > 55000 && wait <= 61000,
      `枠に達しても${wait}msしか待たない。1分の窓が空くまで待つはず`);
    assert.equal(plain(gas.evaluate('apiBackoff_.paceCount')), 1, '先回りの待ちが数えられていない');
  });

  test('pace 3: requests older than a minute stop counting', () => {
    // 窓は「直前1分」である。1分より前の要求を数え続けたら、
    // 何もしていない実行でも待ち始める。
    gas.evaluate('resetApiReadWindow_(); resetApiBackoff_();');
    gas.evaluate(
      '(function() { var old = Date.now() - 61000;' +
      '  for (var i = 0; i < apiReadBudget_ + 5; i += 1) apiReadWindow_.push(old); })()');
    assert.equal(plain(gas.evaluate('paceSheetsRead_()')), 0,
      '1分より前の要求で待たされている');
    assert.equal(plain(gas.evaluate('apiReadWindow_.length')), 1,
      '古い要求が窓から落ちていない');
  });

  test('pace 4: actually hitting the quota lowers the budget, down to a floor', () => {
    // 当たったのなら窓が実態を映していない（前の実行や他の利用者ぶんは
    // 見えない）。枠を実測へ寄せる。ただし下限は置く ── 0まで下がったら
    // 何も読めなくなる。
    gas.evaluate('resetApiReadWindow_();');
    const start = plain(gas.evaluate('apiReadBudget_'));
    gas.evaluate('noteSheetsQuotaExceeded_()');
    assert.equal(plain(gas.evaluate('apiReadBudget_')), start - 5, '枠が下がっていない');
    gas.evaluate('for (var i = 0; i < 50; i += 1) noteSheetsQuotaExceeded_();');
    assert.equal(plain(gas.evaluate('apiReadBudget_')), plain(gas.evaluate('READ_QUOTA_FLOOR_')),
      '下限を割っている');
  });

  /**
   * 仮想時計。**待った分だけ進む。**
   *
   * ハーネスの `Utilities.sleep` は何もしないので、実時計のままでは
   * 「眠ったあと枠が空く」ことを再現できない。ペーサーが記録した待ち時間
   * （`apiBackoff_.paceMs`）を時計の進みとして使えば、眠った通りに時間が
   * 経った世界になる ── 実際に眠らせるテストは1ファイルぶんで1分かかる。
   */
  function withVirtualClock(body) {
    const saved = gas.context.apiClockNow_;
    // 進めるのは**実行全体の**待ち合計で数える。`apiBackoff_` はファイルごとに
    // 初期化されるので、あれを使うと2ファイル目で時計が巻き戻る。
    gas.evaluate('apiClockNow_ = function() { return 1000000 + apiReadPacedTotalMs_; };');
    try { return body(); } finally { gas.context.apiClockNow_ = saved; }
  }

  function pacedWaits(count, smoothing) {
    gas.evaluate('resetApiReadWindow_(); resetApiBackoff_();');
    gas.evaluate('setReadQuotaSmoothing_(' + (smoothing ? 'true' : 'false') + ');');
    gas.context.__waits = gas.evaluate(
      '(function() { var waits = [];' +
      '  for (var i = 0; i < ' + count + '; i += 1) waits.push(paceSheetsRead_());' +
      '  return waits; })()');
    return plain(gas.context.__waits).map(Number);
  }

  test('pace 5: while importing, no single wait is long enough to lose a write', () => {
    // 均さないと、枠を使い切るまで全速で走って**1回だけ長く**眠る。その眠りは
    // ファイルの途中に落ちる ── 書込の最中に眠れば6分の実行上限に当たって
    // 中断され、書きかけが残る。総時間は枠で決まるので変わらない。
    // 変えるのは**1回の待ちの長さ**である。
    withVirtualClock(() => {
      const smoothed = pacedWaits(200, true).filter((w) => w > 0);
      const bursty = pacedWaits(200, false).filter((w) => w > 0);
      assert.ok(smoothed.length > 0 && bursty.length > 0, '待ちが1回も出ていない');

      const interval = Math.ceil(60000 / plain(gas.evaluate('apiReadBudget_')));
      const worstSmoothed = Math.max(...smoothed);
      const worstBursty = Math.max(...bursty);

      assert.ok(worstSmoothed <= interval + 250,
        `均しても1回${worstSmoothed}msまで待っている（間隔${interval}ms）。` +
        'ファイルの途中で長く眠れば6分の上限に当たる');
      assert.ok(worstBursty > 10000,
        `均さない場合の最悪が${worstBursty}msしかない。` +
        'この差がペーシングの効き目なので、無くなったなら測り方が壊れている');

      // 総量は枠で決まる ── 均しても遅くならない（速くもならない）。
      const sum = (list) => list.reduce((a, b) => a + b, 0);
      const ratio = sum(smoothed) / sum(bursty);
      assert.ok(ratio > 0.8 && ratio < 1.25,
        `均すと総待ち時間が${(ratio * 100).toFixed(0)}%になる。` +
        '枠で決まるはずなので、どちらかの数え方が違う');
    });
  });

  test('pace 6: screen operations are not slowed down by the pacer', () => {
    // Webアプリの1回の呼出しは読取8回程度で枠には遠い。ここで1.1秒ずつ
    // 待たせたら操作が使い物にならない（§3.2 の往復予算）。
    withVirtualClock(() => {
      assert.deepEqual(pacedWaits(8, false).filter((w) => w > 0), [],
        '画面の操作で待たされている');
    });
  });


  test('pace 8: one file is not slowed down; two files are smoothed', () => {
    // 1ファイルの読取は約47回でクォータ（60回/分）に収まる ── 待つ理由が無い。
    // 均してしまうと1ファイルの取込に50秒の無駄な待ちが乗る（実測）。
    // 2ファイル以上なら必ず超えるので、そこからは均す。
    //
    // **見るのは待ちの合計ではなく最悪の1回である。**合計は枠で決まるので
    // 均しても均さなくても同じになる（約10分）。違うのは1回の長さだけで、
    // 均さないと60秒眠り、それがファイルの途中に落ちて6分の上限に当たる。
    withVirtualClock(() => {
      gas.evaluate('resetApiReadWindow_(); resetApiBackoff_();');
      measure(20, 1);
      assert.equal(plain(gas.evaluate('apiBackoff_.paceCount')), 0,
        '1ファイルの取込で待っている。枠に収まるのに均している');

      gas.evaluate('resetApiReadWindow_(); resetApiBackoff_();');
      measure(20, 2);
      const worst = plain(gas.evaluate('apiBackoff_.paceWorstMs'));
      assert.ok(worst > 0, '2ファイルの取込で一度も待っていない');
      // 実測（2026-09-20）：均して 9.0秒、均さないと 60.3秒。
      //
      // 均しても0にはならない。ファイル数が分かるのは走査のあとなので、
      // 走査・前検査・監査連鎖の約9回は均さずに走る ── その分を窓から
      // 追い出すのに一度だけ待つ。1ファイルの取込に10秒の無駄を足すより、
      // ここで9秒待つほうが安い（1ファイルが普段の使い方である）。
      //
      // 上限は安全余裕（SAFETY_MARGIN_SECONDS=60秒）に対して十分小さい値を
      // 置く。書込の途中で眠っても6分の上限には当たらない長さであること。
      assert.ok(worst <= 15000,
        `2ファイルの取込で1回${worst}msまで待っている。` +
        '均していないので枠を使い切った瞬間に60秒眠る ── ' +
        'それがファイルの途中に落ちれば6分の実行上限に当たり、書きかけが残る');
    });
  });

  test('pace 7: the import turns smoothing off again when it is done', () => {
    // 切り忘れたら、次の画面操作が1.1秒刻みになる。
    // **均しが入る取込で確かめること** ── 1ファイルでは元から切れているので、
    // 戻し忘れがあっても分からない。
    withVirtualClock(() => {
      gas.evaluate('resetApiReadWindow_(); resetApiBackoff_();');
      measure(20, 2);
      assert.equal(plain(gas.evaluate('apiReadSmoothing_')), false,
        '取込のあと均しが切れていない。次の画面操作が1.1秒刻みになる');
    });
  });
};

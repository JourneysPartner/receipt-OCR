'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 実サンプルによる判定の検証。
 *
 * `test/fixtures/samples/` は `samples/` の実xlsxから機械生成した固定データで、
 * **実機の読取結果と同じ形**を持つ ── 全行が同じ長さの矩形（末尾の空白は
 * 切り詰められない）、日付書式のセルはDate、空セルは''。
 * 手書きの標本ではこの3点を取り違え、ハーネスが緑のまま実機が
 * `UNKNOWN_CARD_FORMAT`を返す事故を起こした（2026-09-03）。以後、判定の
 * 検証はこの固定データを正とする。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'samples');

  /** {__date__} 印を実Dateへ戻す。JSONはDateを持てないため。 */
  const reviveCell = (cell) =>
    cell && typeof cell === 'object' && cell.__date__ ? new Date(cell.__date__) : cell;

  function loadFixture(slug) {
    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, slug + '.json'), 'utf8'));
    raw.sheets = raw.sheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows.map((row) => row.map(reviveCell))
    }));
    return raw;
  }

  /**
   * 期待する判定結果。`null` は「まだ形式を用意していない」＝一致ゼロが正しい。
   * 取りこぼしと誤判定は別物なので、未対応も明示的に固定する。
   */
  const EXPECTED = {
    'AMEX__202512': 'amex_6_alt',
    'ANA_JCB_GOLD__25年12月請求分': 'jcb_family',
    'ANA_アメリカン・エキスプレス・ゴールド__25年2月請求分': 'amex_7',
    'ANAソラチカGOLD__25年5月請求分': 'jcb_family',
    'Amazonマスターカード__202512': 'smbc_family_x8',
    'JAL_CLUB-A_ゴールドカード_JCB__25年10月請求分': 'jcb_family',
    'JAL_アメリカン・エキスプレス・プラチナ__25年7月請求分': 'jal_family',
    'JALカード_ゴールド__25年11月請求分': 'jal_family',
    'JALカード東急__25年12月請求分': 'jal_family',
    'JCBカードＷ__202512meisai': 'jcb_family',
    'Olive_ゴールド__25年12月請求分': 'smbc_family_x7',
    'SPGカード__25年10月請求分': 'amex_9',
    'USCカード__202512': 'ucs_family',
    'VisaLinePayカード__202502': 'smbc_family_x8',
    'aupayカード__11月引き落とし分': 'aupay_family',
    'dカード__202505': 'smbc_family_x9',
    'dカード__ご利用内訳明細_キャッシングご返済明細_20251010': 'docomo_family',
    'アメリカン・エキスプレス⁠・ビジネス・ゴールドカード__25年_10月請求分': 'amex_6',
    'アメリカン・エキスプレス・ゴールド・プリファード__25年12月請求分': 'amex_7',
    'イオンカード__202512': 'aeon_x8',
    'コジマビックカメラカード__meisai202509': 'aeon_x9',
    'コストコカード(オリコ)__202601': 'orico_family',
    'コメリカード__komericard_2025_11': 'komeri_family',
    'ゴールドポイントカード__202511': 'smbc_family_x8',
    'セゾンプラチナビジネス・アメリカンエキスプレスカード__25年11月請求分': 'saison_x8',
    'セゾンプラチナビジネス・アメリカンエキスプレスカード__SAISON_2511': 'saison_x8',
    'ヒルトン・オナーズ_アメリカン・_エキスプレス・プレミアム・カード__25年11月請求分': 'amex_9',
    'ペイペイカード__202512': 'paypay_family',
    'ペイペイカードゴールド__25年11月請求分': 'paypay_family',
    '三井住友ｶｰﾄﾞVISA(NL)__25年3月請求': 'smbc_family_x8',
    '楽天カード__202511': 'rakuten_x12',
    '楽天カード__enavi202511(0000)': 'rakuten_x11',
    '楽天プレミアムカード__25年10月請求分': 'rakuten_x11'
  };

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.call('installSmbcCsvFormat', []);
    gas.call('installSmbcXlsxFormat', []);
    gas.call('installAnnotatedFormatsBatch1', []);
    return gas.call('loadFormatDefinitions', [{status: 'active', enabled: true}]);
  }

  /** 1ファイル分の判定を、実機と同じくシートごとに走らせて集約する。 */
  function detect(defs, fixture, transformRows) {
    const detections = fixture.sheets.map((sheet) => ({
      sheetName: sheet.name,
      candidates: plain(gas.call('detectFormatWith',
        [defs, {name: sheet.name, rows: transformRows ? transformRows(sheet.rows) : sheet.rows},
          fixture.fileType, fixture.fileName]))
    }));
    return {
      detections: detections,
      result: plain(gas.call('aggregateSheetDetections', [detections,
        {origin: 'DISCOVERY', fileName: fixture.fileName, fileType: fixture.fileType,
          targetSheetName: null, sourceId: 'f1'}]))
    };
  }

  test('every fixture slug in the directory has a recorded expectation', () => {
    const slugs = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'index.json'), 'utf8'));
    const missing = slugs.filter((slug) => !(slug in EXPECTED));
    assert.deepEqual(missing, [], 'a new sample must be classified, not silently ignored');
  });

  test('real samples: each file resolves to its expected format', () => {
    const defs = setup();
    const wrong = [];
    Object.keys(EXPECTED).forEach((slug) => {
      const fixture = loadFixture(slug);
      const outcome = detect(defs, fixture);
      const got = outcome.result.status === 'RESOLVED' ? outcome.result.formatId : null;
      const all = outcome.detections.reduce((acc, d) =>
        acc.concat(d.candidates.map((c) => c.formatId)), []);
      if (got !== EXPECTED[slug]) {
        wrong.push(`${slug}: expected ${EXPECTED[slug]}, got ${got}` +
          ` (status=${outcome.result.status}, candidates=[${all.join(', ')}])`);
      }
    });
    assert.deepEqual(wrong, []);
  });

  test('numeric dates parse as dates, not as Excel serials', () => {
    // UCS・コメリはYYYYMMDD、イオン系はYYMMDDを**数値セル**で持つ。
    // シリアルとして読むと数千年先の日付になり、静かに誤った日付が
    // 出納帳へ入る（実装差戻し#32）。
    setup();
    const cases = [
      // YYYYMMDD は年まで確定する。
      {slug: 'USCカード__202512', formatId: 'ucs_family', hashKey: '2025-10-31'},
      {slug: 'コメリカード__komericard_2025_11', formatId: 'komeri_family', hashKey: '2025-10-08'},
      // YYMMDD は月日だけ確定し、**年は補完（5.1）へ委ねる**。ここで年を
      // 決めないのが正しい ── 抽出器は年を作らない。
      {slug: 'イオンカード__202512', formatId: 'aeon_x8',
        yearDigits: 2, year: 25, monthDay: {month: 10, day: 11}, billingMonth: 11},
      {slug: 'コジマビックカメラカード__meisai202509', formatId: 'aeon_x9',
        yearDigits: 2, year: 25, monthDay: {month: 7, day: 12}, billingMonth: 8}
    ];
    cases.forEach((item) => {
      const fixture = loadFixture(item.slug);
      const format = gas.call('pinFormatVersion', [item.formatId, 1]);
      const sheet = {name: fixture.sheets[0].name, rows: fixture.sheets[0].rows};
      const parsed = plain(gas.call('parseFile', [sheet, format,
        {customerId: 'C001', fileId: 'f1', fileNameOriginal: fixture.fileName}]));
      assert.ok(parsed.txs.length > 0, item.slug + ': 明細が1件も取れていない');
      const first = parsed.txs[0];
      assert.ok(first.purpose, item.slug + ': 使用用途が取れていない');
      if (item.hashKey) {
        assert.equal(first.dateHashKey, item.hashKey, item.slug + ': ' + JSON.stringify(first));
      } else {
        assert.equal(first.dateYearDigits, item.yearDigits, item.slug);
        assert.equal(first.dateYear, item.year,
          item.slug + ': シリアルとして読むと数千年先になる ' + JSON.stringify(first));
        assert.deepEqual(first.dateMonthDay, item.monthDay, item.slug);
        // 年補完の基準（締め年月）がファイル名から取れること。
        const billing = plain(gas.call('extractBillingYearMonth',
          [sheet, fixture.fileName, format]));
        assert.equal(billing.status, 'RESOLVED', item.slug + ': ' + JSON.stringify(billing));
        assert.equal(billing.month, item.billingMonth, item.slug);
      }
    });
  });

  test('the column profile needs a majority of sampled rows, not a lucky one', () => {
    const defs = setup();
    const format = plain(defs).filter((d) => d.formatId === 'aupay_family')[0];
    // 見出しは一致するが中身は別物、という表。1行だけ形が合う。
    const rows = (conformingCount) => {
      const header = ['ご利用者', '支払区分', '利用日', '利用店名', '利用金額', '摘要', '使用用途'];
      const good = ['本人', '通常払い', new Date('2025-10-10T00:00:00Z'), 'ＵＱｍｏｂｉｌｅ', 13092, '', '通信費'];
      const bad = ['本人', '通常払い', new Date('2025-10-10T00:00:00Z'), '', 550, '', '通信費'];
      const body = [];
      for (let i = 0; i < 5; i += 1) body.push(i < conformingCount ? good.slice() : bad.slice());
      return [header].concat(body);
    };
    assert.equal(gas.call('matchesColumnProfile', [{name: 'S', rows: rows(1)}, format]), false,
      'one conforming row out of five must not carry the match');
    assert.equal(gas.call('matchesColumnProfile', [{name: 'S', rows: rows(3)}, format]), true,
      'a majority must, so that adjustment and refund rows do not break a real file');
  });

  test('the table width counts the header row, not only the data rows', () => {
    const defs = setup();
    // AMEXの6列変種は、データ行の右端（換算レート）が常に空で、見出し行だけが
    // 6列目を持つ。幅を標本行だけで測ると5列になり、この形式が消える。
    const fixture = loadFixture('AMEX__202512');
    const dataOnly = fixture.sheets[0].rows.slice(1);
    const widths = dataOnly.map((row) => {
      let last = 0;
      row.forEach((cell, index) => { if (cell !== '' && cell !== null) last = index + 1; });
      return last;
    });
    assert.ok(Math.max.apply(null, widths) < 6,
      'the fixture must really have short data rows, or this test proves nothing');
    const format = plain(defs).filter((d) => d.formatId === 'amex_6_alt')[0];
    assert.equal(gas.call('matchesColumnProfile', [{name: 'S', rows: fixture.sheets[0].rows}, format]),
      true);
  });

  test('the dCard fixture parses without reading its total row or cashing section', () => {
    // 判定が通っても、合計行や第2セクションを取引にしていたら意味がない。
    // 実ファイルの中身で確かめる。
    const defs = setup();
    const fixture = loadFixture('dカード__ご利用内訳明細_キャッシングご返済明細_20251010');
    const format = plain(defs).filter((d) => d.formatId === 'docomo_family')[0];
    const parsed = plain(gas.call('parseFile', [
      {name: fixture.sheets[0].name, rows: fixture.sheets[0].rows}, format,
      {customerId: 'C001', fileId: 'f1', fileNameOriginal: fixture.fileName}]));

    // 3〜30行目が明細（28件）。31行目の合計、32行目以降のキャッシングは入らない。
    assert.equal(parsed.txs.length, 28, JSON.stringify(parsed.txs.length));
    assert.equal(parsed.stop.reason, 'SECTION_BREAK');
    assert.ok(parsed.txs.every((tx) => String(tx.merchantOriginal).trim() !== ''),
      '店名が空欄の取引を作らない（区分1で差し戻される）');
    assert.equal(parsed.txs[0].merchantOriginal, 'ｄ払いＢ／カワチ薬品福島さくら店');
    assert.equal(parsed.txs[0].amountBillingJpy, 3624);
    assert.equal(parsed.txs[0].purpose, '仕入れ');
    assert.equal(parsed.txs[0].dateHashKey, '2025-08-16');
    // 返品行は負の金額のまま残す。
    const refund = parsed.txs.filter((tx) => tx.amountBillingJpy < 0);
    assert.equal(refund.length, 1);
    assert.equal(refund[0].amountBillingJpy, -81540);
    assert.equal(refund[0].purpose, '返品');
  });

  test('the dCard cashing section reports nothing when it holds no transactions', () => {
    // 打切りの取り残し検査は「見出しの下に本物の取引があるか」を推定する。
    // dカードのキャッシング欄は空でも `[null,null,"合計",0,0,0]` を必ず持ち、
    // 数値0はExcelシリアルとして1899年の日付に化ける。毎月これで警告が出ると
    // 担当者は警告を読まなくなり、**本当に取引が残っている月を見落とす**。
    const defs = setup();
    const fixture = loadFixture('dカード__ご利用内訳明細_キャッシングご返済明細_20251010');
    const format = plain(defs).filter((d) => d.formatId === 'docomo_family')[0];
    const parsed = plain(gas.call('parseFile', [
      {name: fixture.sheets[0].name, rows: fixture.sheets[0].rows}, format,
      {customerId: 'C001', fileId: 'f1', fileNameOriginal: fixture.fileName}]));

    const truncation = plain(gas.call('checkScanTruncation', [{
      rows: fixture.sheets[0].rows, stopIndex: parsed.stop.stopIndex,
      stopReason: parsed.stop.reason, dateColumnIndex: 3, amountColumnIndex: 5
    }]));
    assert.equal(truncation.remainingCandidateRows, 0,
      '合計行だけの空のセクションで警告を出さない');
    assert.equal(truncation.ok, true);
  });

  test('the Orico fixture parses its yen-string amounts and serial dates', () => {
    const defs = setup();
    const fixture = loadFixture('コストコカード(オリコ)__202601');
    const format = plain(defs).filter((d) => d.formatId === 'orico_family')[0];
    const parsed = plain(gas.call('parseFile', [
      {name: fixture.sheets[0].name, rows: fixture.sheets[0].rows}, format,
      {customerId: 'C001', fileId: 'f1', fileNameOriginal: fixture.fileName}]));

    // 11〜30行目が明細（20件）。1〜10行目の縦持ち見出しは入らない。
    assert.equal(parsed.txs.length, 20, JSON.stringify(parsed.txs.length));
    assert.ok(parsed.txs.every((tx) => String(tx.merchantOriginal).trim() !== ''));
    assert.equal(parsed.txs[0].merchantOriginal, 'カブシキガイシヤカプセルゼツト');
    assert.equal(parsed.txs[0].amountBillingJpy, 4290, '"\\4,290" を金額として読む');
    assert.equal(parsed.txs[0].purpose, 'ツール代');
    assert.ok(parsed.txs[0].dateHashKey, 'シリアル値の日付が読めること');
  });

  test('detection does not depend on the converted grid being trimmed', () => {
    // 実機の読取は getMaxColumns() 幅の矩形。変換後のグリッドがデータより
    // 広いことは普通にあるので、右側の空列で判定が変わってはならない。
    const defs = setup();
    const padTo26 = (rows) => rows.map((row) => {
      const out = row.slice();
      while (out.length < 26) out.push('');
      return out;
    });
    const wrong = [];
    Object.keys(EXPECTED).forEach((slug) => {
      const fixture = loadFixture(slug);
      const outcome = detect(defs, fixture, padTo26);
      const got = outcome.result.status === 'RESOLVED' ? outcome.result.formatId : null;
      if (got !== EXPECTED[slug]) {
        wrong.push(`${slug}: padded to 26 columns changed the verdict to ${got}` +
          ` (status=${outcome.result.status})`);
      }
    });
    assert.deepEqual(wrong, []);
  });

  function kf1Amex(purpose, rate) {
    setup();
    const fixture = loadFixture('AMEX__202512');
    const format = gas.call('pinFormatVersion', ['amex_6_alt', 1]);
    const sheet = {name: fixture.sheets[0].name,
      rows: fixture.sheets[0].rows.map((row) => row.slice())};
    sheet.rows[3][4] = purpose;
    sheet.rows[3][5] = rate;
    const context = {customerId: 'C001', fileId: 'f1', fileNameOriginal: fixture.fileName};
    return {fixture, format, sheet, context,
      parsed: plain(gas.call('parseFile', [sheet, format, context]))};
  }

  test('kf1 1: foreign amount shape accepts only the specified whole uppercase form', () => {
    const yes = ['3,000 KRW', '55,800 KRW', '12.99 USD', '-12.99 USD',
      '3000KRW', '３，０００　ＫＲＷ', '1,234.56 EUR', '+3000KRW', '−12.99 USD'];
    const no = ['仕入れ', '年会費', 'KRW', '3,000', '3,000 円', 'USD 12.99',
      '3,000 KRW 仕入れ', '仕入れ 3,000 KRW', '10 kg', '3,000 Krw',
      '3,000 KRWX', '12,34 USD', null, undefined, 3000, ''];
    yes.forEach((value) => assert.equal(gas.call('isForeignAmountShapedPurpose_', [value]),
      true, String(value)));
    no.forEach((value) => assert.equal(gas.call('isForeignAmountShapedPurpose_', [value]),
      false, String(value)));
  });

  test('kf1 2: AMEX foreign amount purpose becomes empty while other purposes stay', () => {
    const {fixture, format, sheet, context, parsed} = kf1Amex('3,000 KRW', 0.11);
    const original = plain(gas.call('parseFile', [
      {name: fixture.sheets[0].name, rows: fixture.sheets[0].rows}, format, context]));
    assert.equal(parsed.txs.length, original.txs.length);
    parsed.txs.forEach((tx, index) => {
      assert.equal(tx.purpose, tx.sourceRow === 4 ? '' : original.txs[index].purpose,
        `source row ${tx.sourceRow}`);
    });
    assert.equal(sheet.rows[3][5], 0.11);
    assert.ok(parsed.txs.some((tx) => tx.purpose === '年会費'));
    assert.ok(parsed.txs.some((tx) => tx.purpose === '仕入れ'));
  });

  test('kf1 3: a corrected AMEX purpose stays even when the rate remains', () => {
    const {parsed} = kf1Amex('仕入れ', 0.11);
    assert.equal(parsed.txs.find((tx) => tx.sourceRow === 4).purpose, '仕入れ');
  });

  test('kf1 4: every supported real sample retains its raw purpose', () => {
    const defs = setup();
    let fixtureCount = 0;
    let rowCount = 0;
    const byFormat = Object.create(null);
    Object.entries(EXPECTED).forEach(([slug, formatId]) => {
      if (formatId === null) return;
      fixtureCount += 1;
      const fixture = loadFixture(slug);
      const format = plain(defs).find((entry) => entry.formatId === formatId);
      assert.ok(format, `${slug}: missing format ${formatId}`);
      const column = format.purposeColumn.charCodeAt(0) - 65;
      fixture.sheets.forEach((sheet) => {
        const parsed = plain(gas.call('parseFile', [sheet, format,
          {customerId: 'C001', fileId: 'f1', fileNameOriginal: fixture.fileName}]));
        parsed.txs.forEach((tx) => {
          const rawCell = sheet.rows[tx.sourceRow - 1][column];
          const raw = rawCell === null || rawCell === undefined ? '' :
            String(gas.call('cellToCanonicalString', [rawCell])).trim();
          const shaped = /^[+\-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*[A-Z]{3}$/
            .test(raw.normalize('NFKC'));
          assert.equal(shaped, false, `${slug} row ${tx.sourceRow}: ${raw}`);
          assert.equal(tx.purpose, raw, `${slug} row ${tx.sourceRow}`);
          rowCount += 1;
          byFormat[formatId] = (byFormat[formatId] || 0) + 1;
        });
      });
    });
    assert.ok(fixtureCount > 0 && rowCount > 0);
    console.log(`KF1_REAL_SAMPLES ${fixtureCount} fixtures, ${rowCount} rows, ` +
      JSON.stringify(byFormat));
  });

  test('kf1 5: unresolved foreign amount purpose is category 1 customer fix', () => {
    const {fixture, parsed} = kf1Amex('3,000 KRW', 0.11);
    const resolved = plain(gas.call('resolvePurposes', [parsed.txs, fixture.fileName, []]));
    assert.equal(resolved.unresolvedCount, 1);
    const classified = plain(gas.call('classifyValidationResult', [{
      format: {ok: true}, destinationSchema: {ok: true}, encoding: {ok: true},
      effectiveTransactionCount: parsed.txs.length, purposeResolution: resolved
    }]));
    assert.equal(classified.category, 1);
    assert.equal(classified.code, 'SOURCE_REQUIRES_CUSTOMER_FIX');
  });

  test('kf1 6: a filename rule infers purpose for the emptied AMEX row', () => {
    const {fixture, parsed} = kf1Amex('3,000 KRW', 0.11);
    const resolved = plain(gas.call('resolvePurposes', [parsed.txs, fixture.fileName,
      [{id: 'KF1_RULE', keyword: '202512', purpose: '仕入れ', enabled: true}]]));
    assert.equal(resolved.unresolvedCount, 0);
    const target = resolved.txs.find((tx) => tx.sourceRow === 4);
    assert.equal(target.purpose, '仕入れ');
    assert.equal(target.purposeInferred, true);
    assert.equal(target.purposeInferenceRuleId, 'KF1_RULE');
  });

  function kf7Aeon(change) {
    setup();
    const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures',
      'member-discount', 'イオンゴールドカード__meisai202506_(1).json'), 'utf8'));
    const format = gas.call('pinFormatVersion', ['aeon_x9', 1]);
    const sheet = {name: fixture.sheets[0].name,
      rows: fixture.sheets[0].rows.map((row) => row.map(reviveCell))};
    if (change) change(sheet.rows);
    const rawParsed = gas.call('parseFile', [sheet, format,
      {customerId: 'C001', fileId: 'kf7', fileNameOriginal: fixture.fileName}]);
    const parsed = plain(rawParsed);
    return {fixture, format, sheet, parsed, rawParsed};
  }

  test('kf7 1: actual Aeon discounts keep their own text and amount with the parent date', () => {
    const {parsed, sheet, rawParsed} = kf7Aeon();
    assert.equal(parsed.txs.length, 28);
    const byRow = new Map(parsed.txs.map((tx) => [tx.sourceRow, tx]));
    const discountRows = [12, 14, 16, 18, 20, 22, 24, 26, 29, 31, 34];
    discountRows.forEach((row) => {
      const tx = byRow.get(row);
      const parent = byRow.get(row - 1);
      assert.ok(tx && parent, `row ${row}`);
      assert.equal(tx.dateUnreadable, false, `row ${row}`);
      ['dateMonthDay', 'dateYear', 'dateYearDigits', 'dateHashKey', 'date',
        'dateYearRaw', 'dateYearMissing'].forEach((key) =>
        assert.deepEqual(tx[key], parent[key], `row ${row} ${key}`));
      assert.equal(tx.merchantOriginal, sheet.rows[row - 1][2], `row ${row}`);
      assert.ok(tx.amountBillingJpy < 0, `row ${row}`);
      assert.equal(tx.dateRawText, '', `row ${row}`);
      assert.deepEqual(tx.discountOf,
        {sourceRow: parent.sourceRow, merchantOriginal: parent.merchantOriginal}, `row ${row}`);
      const rawChild = rawParsed.txs.find((item) => item.sourceRow === row);
      const rawParent = rawParsed.txs.find((item) => item.sourceRow === row - 1);
      assert.notStrictEqual(rawChild.dateMonthDay, rawParent.dateMonthDay, `row ${row} date copy`);
    });
    assert.equal(parsed.txs.filter((tx) => !discountRows.includes(tx.sourceRow) &&
      !('discountOf' in tx)).length, 17);
    assert.equal(parsed.txs.reduce((sum, tx) => sum + tx.amountBillingJpy, 0), 395265);
  });

  test('kf7 2: billing-year inference and validation give discounts their parent date', () => {
    const {fixture, format, sheet, parsed} = kf7Aeon();
    const base = plain(gas.call('extractBillingYearMonth', [sheet, fixture.fileName, format]));
    const inferred = plain(gas.call('inferYearsForFile', [parsed.txs, base, format]));
    const issues = plain(gas.call('validateTransactions', [inferred.txs, {cardFormat: format}])).issues;
    assert.equal(issues.filter((issue) => issue.code === 'DATE_UNREADABLE').length, 0);
    const byRow = new Map(inferred.txs.map((tx) => [tx.sourceRow, tx]));
    [12, 14, 16, 18, 20, 22, 24, 26, 29, 31, 34].forEach((row) =>
      assert.equal(byRow.get(row).date, byRow.get(row - 1).date, `row ${row}`));
    assert.equal(gas.call('toTokyoDateString_', [new Date(byRow.get(12).date)]), '2025-04-19');
  });

  test('kf7 3: mismatches, gaps, exclusion, dates, text, and chained discounts stay unreadable', () => {
    const cases = [
      ['amount mismatch', (r) => { r[11][2] = r[11][2].replace('５，４５６', '５，４５７'); }, 12],
      ['blank gap', (r) => { r.splice(11, 0, Array(9).fill('')); }, 13],
      ['excluded parent', (r) => {
        r[9][6] = 5456;
        r[10][0] = '';
        r[10][6] = '';
      }, 12],
      ['positive discount', (r) => { r[11][6] = 273; }, 12],
      ['unreadable discount date', (r) => { r[11][0] = '不明'; }, 12],
      ['unreadable parent date', (r) => { r[10][0] = '不明'; }, 12],
      ['bare text', (r) => { r[11][2] = '会員値引'; }, 12],
      ['different prefix', (r) => { r[11][2] = 'ポイント値引（１回払い　￥５，４５６分）'; }, 12],
      ['trailing text', (r) => { r[11][2] += 'おまけ'; }, 12],
      ['chained discounts', (r) => { r.splice(12, 0, r[11].slice()); }, 13],
      ['first detail', (r) => { r.splice(8, 0, r[11].slice()); }, 9]
    ];
    cases.forEach(([name, change, row]) => {
      const {parsed, format} = kf7Aeon(change);
      const tx = parsed.txs.find((item) => item.sourceRow === row);
      assert.ok(tx, name);
      assert.equal(tx.dateUnreadable, true, name);
      assert.equal('discountOf' in tx, false, name);
      const issues = plain(gas.call('validateTransactions', [parsed.txs, {cardFormat: format}])).issues;
      assert.ok(issues.some((issue) => issue.sourceRow === row &&
        issue.code === 'DATE_UNREADABLE'), name);
    });
  });

  test('kf7 4: discount purpose inherits only when blank after foreign-amount cleanup', () => {
    const cases = [
      ['inherited', '', '仕入', '仕入'],
      ['own purpose', '雑費', '仕入', '雑費'],
      ['both blank', '', '', ''],
      ['foreign-shaped parent', '', '3,000 KRW', '']
    ];
    cases.forEach(([name, childPurpose, parentPurpose, wanted]) => {
      const {parsed} = kf7Aeon((r) => {
        r[10][8] = parentPurpose;
        r[11][8] = childPurpose;
      });
      const parent = parsed.txs.find((tx) => tx.sourceRow === 11);
      const child = parsed.txs.find((tx) => tx.sourceRow === 12);
      assert.equal(child.purpose, wanted, name);
      if (name === 'both blank' || name === 'foreign-shaped parent')
        assert.equal(parent.purpose, '', name + ' parent');
    });
  });

  test('kf7 5: NFKC, whitespace, and a three-digit source amount match', () => {
    ['会員値引(1回払い ¥5,456分)', '会員値引（１回払い￥５，４５６分）'].forEach((label) => {
      const {parsed} = kf7Aeon((r) => { r[11][2] = label; });
      const child = parsed.txs.find((tx) => tx.sourceRow === 12);
      assert.equal(child.dateUnreadable, false, label);
      assert.equal(child.merchantOriginal, label, label);
    });
    const {parsed, fixture, format} = kf7Aeon();
    assert.equal(parsed.txs.find((tx) => tx.sourceRow === 26).dateUnreadable, false);
    const logicalCsv = plain(gas.call('parseFile', [{name: 'logical CSV',
      rows: [fixture.sheets[0].rows[10], fixture.sheets[0].rows[11]],
      recordStarts: [11, 14]}, format, {customerId: 'C001', fileId: 'kf7-csv'}]));
    assert.equal(logicalCsv.txs.length, 2);
    assert.deepEqual(logicalCsv.txs[1].discountOf,
      {sourceRow: 11, merchantOriginal: logicalCsv.txs[0].merchantOriginal});
  });

  // 固定データのイオンは年2桁の日付なので、`date`（年4桁で解析時に決まる）と
  // `dateYearMissing`（年なしで補完の対象になる）の写し漏れを見ない。漏れると
  // 値引の行は日付なし・要確認なしで通る（B列空欄のまま誰にも捕捉されない）。
  test('kf7 11: four-digit and year-less parent dates reach the discount after inference', () => {
    [['four-digit year', '2025/04/19'], ['year-less', '4/19']].forEach(([name, cell]) => {
      const {fixture, format, sheet, parsed} = kf7Aeon((r) => { r[10][0] = cell; });
      const base = plain(gas.call('extractBillingYearMonth', [sheet, fixture.fileName, format]));
      const inferred = plain(gas.call('inferYearsForFile', [parsed.txs, base, format]));
      const parent = inferred.txs.find((tx) => tx.sourceRow === 11);
      const child = inferred.txs.find((tx) => tx.sourceRow === 12);
      assert.ok(parent.date, name + ' parent date');
      assert.equal(child.date, parent.date, name);
      assert.equal(child.dateHashKey, parent.dateHashKey, name);
      assert.equal(gas.call('toTokyoDateString_', [new Date(child.date)]), '2025-04-19', name);
      const issues = plain(gas.call('validateTransactions', [inferred.txs, {cardFormat: format}])).issues;
      assert.equal(issues.filter((issue) => issue.sourceRow === 12).length, 0, name);
    });
  });
};

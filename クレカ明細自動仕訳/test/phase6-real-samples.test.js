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
};

'use strict';

/**
 * 形式第1弾（顧客追記済み明細の主要ファミリー）。
 *
 * 核心は**衝突マトリクス**：登録済みの全形式に対して、各ファミリーの
 * 構造が「ちょうど1形式」に一致すること。1つも一致しなければ取りこぼし、
 * 2つ以上なら全ファイルが人の選択に回る（AMBIGUOUS）。
 * 幅違い変種の判別は`maxColumns`（実装差戻し#27）が担う。
 *
 * **ここの標本は手書きであり、実ファイルの正ではない。** 手書き標本は
 * 末尾の空セルを詰め、日付を文字列で書いてしまうため、実機の読取結果
 * （矩形・Date）とずれる。判定の正は`phase6-real-samples.test.js`が
 * 実xlsxから生成した固定データにある。こちらは文字列日付・詰めた行
 * （＝CSV経路に近い形）での退行検知として残す。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const blank = (n) => Array(n).fill('');

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [{name: '仮', values: [['x']]}]});
    gas.stubs.setActiveSpreadsheet('master');
    gas.call('setMasterSpreadsheetId', ['master']);
    gas.call('provisionMasterSheets', []);
    gas.call('installSmbcCsvFormat', []);
    gas.call('installSmbcXlsxFormat', []);
    gas.call('installAnnotatedFormatsBatch1', []);
  }

  // samplesの実ファイル構造を圧縮したファミリー標本。
  const FAMILIES = [
    {expect: 'smbc_family_csv', fileType: 'csv', fileName: '三井住友カード202602.csv', rows: [
      ['〇〇　〇〇　様', '4980-00**-****-****', '三井住友ゴールドＶＩＳＡ（ＮＬ）', '', '', '', ''],
      ['2025/12/16', 'ローソン', '10800', '1', '1', '10800', '仕入れ'],
      ['', '', '', '', '', '58100', '']
    ]},
    {expect: 'smbc_family_x7', fileType: 'xlsx', fileName: '25年12月請求分.xlsx', rows: [
      ['〇〇　〇〇　様', '4980-00**-****-****', 'Ｏｌｉｖｅゴールド／クレジット', '', '', '', '使用用途'],
      ['2025/11/01', 'ＳＱ＊３６５日', 5105, '１', '１', 5105, '私用'],
      ['2025/11/02', 'セブン−イレブン', 318, '１', '１', 318, '私用']
    ]},
    {expect: 'smbc_family_x8', fileType: 'xlsx', fileName: '202502.xlsx', rows: [
      ['〇〇　〇〇　様', '4537-25**-****-****', 'ＶｉｓａＬＩＮＥＰａｙカード', '', '', '', '', '使用用途'],
      ['2025/01/04', 'ｆｒｅｅｅ（ＢtoＢ）', 3278, '１', '１', 3278, '', 'ツール月額使用料'],
      ['2025/01/15', 'クロスマ', 16280, '１', '１', 16280, '', 'ツール月額使用料']
    ]},
    {expect: 'smbc_family_x9', fileType: 'xlsx', fileName: '202505.xlsx', rows: [
      ['〇〇　〇〇　様', '5302-42**-****-0000', 'ｄカードＧＯＬＤ', '', '', '', '', '', '使用用途'],
      ['2025/03/16', 'ｄ払いＢ／ケーズデンキ', 452, '１', '１', 452, 'ｄ払いＢ／ケーズデンキ相馬店', '', '仕入れ'],
      ['2025/03/17', 'ｄ払いＢ／カワチ薬品', 4224, '１', '１', 4224, '', '', '仕入れ']
    ]},
    {expect: 'jcb_family', fileType: 'xlsx', fileName: '202512meisai.xlsx', rows: [
      ['', '', '今回のお支払日', '2025-12-10', '', '', '', '', '', '', '', '', ''],
      ['', '', '今回のお支払金額合計(￥)', 159208, '', '', '', '', '', '', '', '', ''],
      ['', '', ' うち国内ご利用金額合計(￥)', 159208, '', '', '', '', '', '', '', '', ''],
      ['', '', ' うち海外ご利用金額合計(￥)', 0, '', '', '', '', '', '', '', '', ''],
      ['【ご利用明細】', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['ご利用者', 'カテゴリ', 'ご利用日', 'ご利用先など', 'ご利用金額(￥)', '支払区分', '今回回数',
        '訂正サイン', 'お支払い金額(￥)', '国内／海外', '摘要', '備考', '使用用途'],
      ['****-****-****-1314　ＪＣＢ', '≪ショッピング取組（国内）≫', '2025/10/17',
        'ホームセンター　山新日和田店', 880, '１回', '', '', 880, '国内', '', '* 2', '梱包材'],
      ['****-****-****-1314　ＪＣＢ', '≪ショッピング取組（国内）≫', '2025/10/18',
        'ＥＮＥＯＳ−ＳＳ', 4175, '１回', '', '', 4175, '国内', '', '* 2', 'ガソリン代']
    ]},
    {expect: 'jal_family', fileType: 'xlsx', fileName: '25年11月請求分.xlsx', rows: [
      ['確定情報', 'お支払日', 'ご利用店名（海外ご利用店名／海外都市名）', 'ご利用日', '支払回数',
        '何回目', 'ご利用金額（円）', '現地通貨額・通貨名称・換算レート', '使用用途'],
      ['', '', '【〇〇　〇〇　様】', '', '', '', '', '', ''],
      ['確定', 45971, 'ＡＰＰＬＥ．ＣＯＭ／ＪＰ', 45917, '　１', '', 214800, '', '仕入'],
      ['確定', 45971, 'ドコモご利用料金　１０月分', 45930, '　１', '', 552, '', '通信費']
    ]},
    {expect: 'amex_6', fileType: 'xlsx', fileName: '25年 10月請求分.xlsx', rows: [
      ['ご利用日', 'データ処理日', 'ご利用内容', '金額', '海外通貨利用金額', '使用用途'],
      ['2025/08/31', '2025/09/09', 'ソフトバンクＭ　東京都　港区', 994, '', '通信費'],
      ['2025/08/29', '2025/08/29', 'Ａｍａｚｏｎ　プライム会費', 5900, '', '諸会費']
    ]},
    {expect: 'amex_7', fileType: 'xlsx', fileName: '25年12月請求分.xlsx', rows: [
      ['ご利用日', 'データ処理日', 'ご利用内容', '金額', '海外通貨利用金額', '換算レート', '使用用途'],
      ['2025/11/23', '2025/11/24', 'アマゾン　シーオージェーピー', 5460, '', '', '仕入'],
      ['2025/11/22', '2025/11/25', 'AGODA*AGODA.COM', 115769, '', '', '私用']
    ]},
    {expect: 'amex_9', fileType: 'xlsx', fileName: '25年10月請求分.xlsx', rows: [
      ['ご利用日', 'データ処理日', 'ご利用内容', 'カード会員様名', '会員番号 #', '金額',
        '海外通貨利用金額', '換算レート', '使用用途'],
      ['2025/09/21', '2025/09/22', 'リソルの森　千葉県　長生郡', 'TOMO NAKAI', -21004, 21480, '', '', '私用'],
      ['2025/09/19', '2025/09/21', 'アップルストア　オンライン', 'TOMO NAKAI', -21004, 159800, '', '', '仕入']
    ]},
    {expect: 'rakuten_x11', fileType: 'xlsx', fileName: 'enavi202511(0000).xlsx', rows: [
      ['利用日', '利用店名・商品名', '利用者', '支払方法', '利用金額', '手数料/利息', '支払総額',
        '11月支払金額', '12月繰越残高', '新規サイン', '使用用途'],
      ['2025/10/24', '楽天ビック（ビックカメラ×楽天', '本人', '1回払い', 7623, 0, 7623, 7623, 0, '*', '仕入れ'],
      ['2025/10/20', '楽天ブックス', '本人', '1回払い', 61972, 0, 61972, 61972, 0, '*', '仕入れ']
    ]},
    {expect: 'rakuten_x12', fileType: 'xlsx', fileName: '202511.xlsx', rows: [
      ['利用日', '利用店名・商品名', '利用者', '支払方法', '利用金額', '支払手数料', '支払総額',
        '支払月', '11月支払金額', '12月繰越残高', '12月以降支払金額', ''],
      ['2025/10/24', 'ゲオ幕張店', '本人', '1回払い', 2750, 0, 2750, '11月', 2750, 0, '', '仕入れ'],
      ['2025/10/16', 'ファミリーマート', '本人', '1回払い', 2900, 0, 2900, '11月', 2900, 0, '', '仕入れ']
    ]},
    {expect: 'saison_x8', fileType: 'xlsx', fileName: 'SAISON_2511.xlsx', rows: [
      ['カード名称', 'セゾンプラチナビジネス・アメリカンエキスプレスカード', '', '', '', '', '', ''],
      ['お支払日', '2025-11-04', '', '', '', '', '', ''],
      ['今回ご請求額', 743414, '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', ''],
      ['利用日', 'ご利用店名及び商品名', '本人・家族区分', '支払区分名称', '締前入金区分', '利用金額', '備考', '使用用途'],
      ['', 'ご利用者名:〇〇 〇〇     様', '', '', '', '', '', ''],
      ['2025/09/11', 'AmazonPay提携サイト', '', '1回', '', 6750, '', '仕入れ'],
      ['2025/09/12', 'アップルストア オンライン', '', '1回', '', 736664, '', '仕入れ'],
      ['', '【小計】', '', '', '', 743414, '', ''],
      ['', '【合計】', '', '', '', 743414, '', '']
    ]},
    {expect: 'paypay_family', fileType: 'xlsx', fileName: '25年11月請求分.xlsx', rows: [
      ['利用日/キャンセル日', '利用店名・商品名', '利用者', '決済方法', '支払区分', '利用金額', '手数料',
        '支払総額', '当月支払金額', '翌月以降繰越金額', '調整額', '当月お支払日', '使用用途'],
      ['2025/09/18', 'アップルジャパン', '本人*', 'Apple Pay', '1回', 179800, 0, 179800, 179800, 0, 0,
        '2025/11/27', '仕入'],
      ['2025/09/30', 'ソフトバンクМ', '本人*', 'PayPayカード ゴールド', '1回', 18628, 0, 18628, 18628,
        0, 0, '2025/11/27', '通信費']
    ]},
    {expect: 'aupay_family', fileType: 'xlsx', fileName: '11月引き落とし分.xlsx', rows: [
      ['ご利用者', '支払区分', '利用日', '利用店名', '利用金額', '摘要', '使用用途'],
      ['本人(1084)', '通常払い', '2025/10/10', 'ＵＱｍｏｂｉｌｅご利用料金', 13092, '', '携帯電話'],
      ['本人(1084)', '通常払い', '2025/10/10', 'ａｕかんたん決済（サービス）', 550, '', '携帯電話オプション料']
    ]}
  ];

  test('collision matrix: every family matches exactly one registered format', () => {
    setup();
    const defs = gas.call('loadFormatDefinitions', [{status: 'active', enabled: true}]);
    assert.equal(plain(defs).filter((d) => !d.valid).length, 0,
      'every installed definition must pass the 2.1.2 schemas');

    FAMILIES.forEach((family) => {
      const sheet = {name: family.expect, rows: family.rows};
      const hits = plain(gas.call('detectFormatWith',
        [defs, sheet, family.fileType, family.fileName]));
      assert.equal(hits.length, 1,
        `${family.expect}: expected exactly one match, got [${hits.map((h) => h.formatId).join(', ')}]`);
      assert.equal(hits[0].formatId, family.expect);
    });
  });

  test('the x8 width cap supersedes v1 and keeps the history row', () => {
    setup();
    const rows = plain(gas.call('loadFormatDefinitions', [{formatId: 'smbc_family_x8'}]));
    const enabled = rows.filter((r) => r.enabled);
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0].version, 2);
    assert.equal(enabled[0].columnProfile.maxColumns, 8);
    const superseded = rows.filter((r) => !r.enabled);
    assert.equal(superseded.length, 1);
    assert.equal(superseded[0].disabledReason, 'SUPERSEDED');

    const again = plain(gas.call('installAnnotatedFormatsBatch1', []));
    const stillEnabled = plain(gas.call('loadFormatDefinitions', [{formatId: 'smbc_family_x8', enabled: true}]));
    assert.equal(stillEnabled.length, 1);
    assert.equal(stillEnabled[0].version, 2, 'a re-run must not stack new versions');
    assert.ok(again.every((r) => r.installed === false || r.formatId === undefined || r.installed !== undefined));
  });

  test('parse smoke: JAL serial dates become real dates and purposes come from I', () => {
    setup();
    const family = FAMILIES.filter((f) => f.expect === 'jal_family')[0];
    const format = gas.call('pinFormatVersion', ['jal_family', 1]);
    const parsed = plain(gas.call('parseFile', [{name: 'S', rows: family.rows}, format,
      {customerId: 'C001', fileId: 'f1', fileNameOriginal: family.fileName}]));
    assert.equal(parsed.txs.length, 2);
    assert.equal(parsed.txs[0].dateHashKey, '2025-09-17', 'serial 45917 is 2025-09-17');
    assert.equal(parsed.txs[0].merchantOriginal, 'ＡＰＰＬＥ．ＣＯＭ／ＪＰ');
    assert.equal(parsed.txs[0].amountBillingJpy, 214800);
    assert.equal(parsed.txs[0].purpose, '仕入');
  });

  test('parse smoke: the saison total row stops the read and reconciles', () => {
    setup();
    const family = FAMILIES.filter((f) => f.expect === 'saison_x8')[0];
    const format = gas.call('pinFormatVersion', ['saison_x8', 1]);
    const sheet = {name: 'S', rows: family.rows};
    const parsed = gas.call('parseFile', [sheet, format,
      {customerId: 'C001', fileId: 'f1', fileNameOriginal: family.fileName}]);
    const parsedPlain = plain(parsed);
    assert.equal(parsedPlain.txs.length, 2, JSON.stringify(parsedPlain.excludedRows));
    assert.equal(parsedPlain.stop.reason, 'TOTAL_ROW');

    const reconcile = plain(gas.call('verifyCountsAndTotals',
      [parsed.txs, format, sheet, null]));
    assert.equal(reconcile.ok, true, JSON.stringify(reconcile));

    const billing = plain(gas.call('extractBillingYearMonth', [sheet, family.fileName, format]));
    assert.equal(billing.status, 'RESOLVED');
    assert.equal(billing.year, 2025);
    assert.equal(billing.month, 10, 'payment 2025-11 minus one month');
  });

  test('parse smoke: rakuten 12-column purposes come from the headerless L column', () => {
    setup();
    const family = FAMILIES.filter((f) => f.expect === 'rakuten_x12')[0];
    const format = gas.call('pinFormatVersion', ['rakuten_x12', 1]);
    const parsed = plain(gas.call('parseFile', [{name: 'S', rows: family.rows}, format,
      {customerId: 'C001', fileId: 'f1', fileNameOriginal: family.fileName}]));
    assert.equal(parsed.txs.length, 2);
    assert.equal(parsed.txs[0].purpose, '仕入れ');
    assert.equal(parsed.txs[0].amountBillingJpy, 2750);
  });

  test('parse smoke: JCB reads from row 7 with the summary block excluded', () => {
    setup();
    const family = FAMILIES.filter((f) => f.expect === 'jcb_family')[0];
    const format = gas.call('pinFormatVersion', ['jcb_family', 1]);
    const sheet = {name: 'S', rows: family.rows};
    const parsed = plain(gas.call('parseFile', [sheet, format,
      {customerId: 'C001', fileId: 'f1', fileNameOriginal: family.fileName}]));
    assert.equal(parsed.txs.length, 2);
    assert.equal(parsed.txs[0].sourceRow, 7);
    assert.equal(parsed.txs[0].merchantOriginal, 'ホームセンター　山新日和田店');
    assert.equal(parsed.txs[0].purpose, '梱包材');

    const billing = plain(gas.call('extractBillingYearMonth', [sheet, family.fileName, format]));
    assert.equal(billing.status, 'RESOLVED');
    assert.equal(billing.month, 11, 'payment 2025-12 minus one month');
  });
};

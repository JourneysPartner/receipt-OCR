'use strict';

/**
 * 4.12.1 サンプルからの下書き生成。
 *
 * 設計レビューが検出した2つの欠陥を固定する。どちらも
 * **導出規則が自身の模範を再現できない**という形をしていた。
 *   B-M8  ヘッダー行のスコア式で第2項が構造的に順位を変えられなかった
 *   B-M4  除外範囲の導出が saison の初期値を再現できなかった
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));

  function setup() {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: []});
    gas.stubs.setActiveSpreadsheet('master');
  }

  const infer = (sample) => plain(gas.call('inferDraftFromSample', [sample]));

  /** 素直な明細。ヘッダー1行＋明細3行。 */
  const PLAIN_SAMPLE = {
    fileName: '明細_2026年1月締.csv',
    rows: [
      ['利用日', '利用店名', '利用金額', '使用用途'],
      ['2026/01/05', 'コンビニA', '1200', '消耗品'],
      ['2026/01/08', 'ガソリンB', '5400', '車両費'],
      ['2026/01/12', '書店C', '980', '新聞図書費']
    ]
  };

  // ================= 基本の推定 =================

  test('4.12.1: a straightforward sample resolves every required answer', () => {
    setup();
    const draft = infer(PLAIN_SAMPLE);
    assert.deepEqual(draft.headerRows, [1]);
    assert.equal(draft.dataStartRow, 2);
    assert.equal(draft.dateColumn, 1);
    assert.equal(draft.merchantColumn, 2);
    assert.equal(draft.amountColumn, 3);
    assert.equal(draft.purposeColumn, 4);
    assert.deepEqual(draft.unresolved, []);
  });

  test('4.12.1: the file type comes from the extension', () => {
    setup();
    assert.deepEqual(infer(PLAIN_SAMPLE).fileTypes, ['csv']);
    assert.deepEqual(infer(Object.assign({}, PLAIN_SAMPLE,
      {fileName: '明細.xlsx'})).fileTypes, ['xlsx']);
  });

  // ---- B-M9：required にするのは3列だけ ----
  //
  // 取得した全行でたまたま非空だった列まで必須にすると、過学習した定義に
  // なり、同じ形式の別の月のファイルが「必須列が空」で落ちる。
  test('B-M9: only the date, merchant and amount columns are marked required', () => {
    setup();
    const draft = infer(PLAIN_SAMPLE);
    const required = draft.columnTypes.filter((c) => c.required).map((c) => c.column);
    assert.deepEqual(required.sort((a, b) => a - b), [1, 2, 3],
      'the purpose column was filled in every sampled row, but must not become required');
  });

  test('4.12.1: the amount column is the numeric column with the largest magnitude', () => {
    setup();
    const draft = infer({
      fileName: 'x.csv',
      rows: [
        ['利用日', '店名', '手数料', '利用金額'],
        ['2026/01/05', 'A', '10', '1200'],
        ['2026/01/08', 'B', '20', '5400']
      ]
    });
    assert.equal(draft.amountColumn, 4,
      'a fee column is numeric too - magnitude is what distinguishes the real amount');
  });

  // ================= B-M8：ヘッダー行のスコア式 =================
  //
  // 下部の注記ブロックが本物のヘッダーより幅広い形式。旧式は
  // 「非空セル数 × 100 + 直後の明細数」であり、第2項の最大値(20)が
  // 第1項の刻み(100)を越えられず、実質「最も幅広い行」を選ぶだけだった。
  // 注記行が選ばれると dataStartRow がその後ろになり、明細候補行が
  // 1行も見つからず全推定が崩れる。
  test('B-M8: the header is the row that detail rows follow, not the widest row', () => {
    setup();
    const draft = infer({
      fileName: 'x.csv',
      rows: [
        ['利用日', '利用店名', '利用金額'],          // 本物のヘッダー（3列）
        ['2026/01/05', 'コンビニA', '1200'],
        ['2026/01/08', 'ガソリンB', '5400'],
        ['2026/01/12', '書店C', '980'],
        ['ご注意', 'この明細は', '確定前の', 'ものであり', '変更される', '場合があります']
      ]
    });

    assert.deepEqual(draft.headerRows, [1],
      'the wider note block must not win - nothing follows it');
    assert.equal(draft.dataStartRow, 2);
    assert.equal(draft.dateColumn, 1, 'picking the note row would break every later step');
  });

  test('B-M8: a two-row header is recognised when the upper row is not wider', () => {
    setup();
    const draft = infer({
      fileName: 'x.csv',
      rows: [
        ['ご利用内容', '金額欄'],
        ['利用日', '利用店名', '利用金額'],
        ['2026/01/05', 'コンビニA', '1200'],
        ['2026/01/08', 'ガソリンB', '5400']
      ]
    });
    assert.deepEqual(draft.headerRows, [1, 2]);
    assert.equal(draft.dataStartRow, 3);
  });

  // ================= B-M4：除外範囲 =================
  //
  // saison 形式の模範：ヘッダーが5行目、データ開始が7行目、6行目に
  // 「前月お支払金額」がある。除外範囲を `to: headerRow` にすると6行目が
  // 除外されず、取引として行を確保してしまう。
  test('B-M4: the excluded range reaches the row before the data starts', () => {
    setup();
    const draft = infer({
      fileName: 'saison_2026.csv',
      rows: [
        ['クレジットカード ご利用明細'],
        [''],
        ['カード番号', '****-1234'],
        [''],
        ['ご利用日', 'ご利用先', 'ご利用金額'],       // 5行目：ヘッダー
        ['前月お支払金額', '', '48000'],              // 6行目：明細ではない
        ['2026/01/05', 'コンビニA', '1200'],          // 7行目：データ開始
        ['2026/01/08', 'ガソリンB', '5400']
      ]
    });

    assert.deepEqual(draft.headerRows, [5]);
    assert.equal(draft.dataStartRow, 7);
    assert.deepEqual(draft.excludeRowRanges, [{from: 1, to: 6}],
      'the derivation must reproduce its own worked example');
  });

  test('B-M4: a carried-forward balance row becomes an exclusion label', () => {
    setup();
    const draft = infer({
      fileName: 'x.csv',
      rows: [
        ['利用日', '利用店名', '利用金額'],
        ['2026/01/05', 'コンビニA', '1200'],
        ['2026/01/08', 'ガソリンB', '5400'],
        ['', 'お繰越残高', '48000'],
        ['', '合計', '54600']
      ]
    });
    const labels = draft.exclusionLabels.map((item) => item.label);
    assert.ok(labels.indexOf('合計') >= 0);
    assert.ok(labels.some((label) => /繰越|残高/.test(label)),
      'a carried-forward row must not be booked as a transaction');
    draft.exclusionLabels.forEach((item) => {
      assert.equal(item.onlyWhenDateEmpty, true,
        'a real transaction at a shop named 合同会社… must not be excluded');
    });
  });

  test('4.12.1: a total row leaves its value column for the operator to choose', () => {
    setup();
    const draft = infer({
      fileName: 'x.csv',
      rows: [
        ['利用日', '利用店名', '利用金額'],
        ['2026/01/05', 'コンビニA', '1200'],
        ['', '合計', '1200']
      ]
    });
    assert.equal(draft.totalRow.label, '合計');
    assert.equal(draft.totalRow.valueColumn, null);
    assert.ok(draft.unresolved.indexOf('totalRow.valueColumn') >= 0,
      'guessing the value column would be presented to the operator as settled');
  });

  // ================= 弁別語（B-M17） =================
  //
  // 語彙はカード形式マスターF列の登録済みキーワードから取る。他サンプルの
  // 本体を読む定義にすると、入力がサンプル1件である前提と矛盾し、
  // コーパスが1件増えるだけで同じサンプルから違う下書きが出る。
  test('B-M17: distinctive keywords exclude words already registered by other formats', () => {
    setup();
    const sample = {
      fileName: 'x.csv',
      registeredKeywords: ['利用日', '利用店名', '利用金額'],
      rows: [
        ['利用日', '利用店名', '利用金額', 'エヌティティ'],
        ['2026/01/05', 'コンビニA', '1200', '']
      ]
    };
    const draft = infer(sample);
    assert.ok(draft.distinctiveKeywords.indexOf('利用日') < 0,
      'a word every format uses cannot distinguish this one');
    assert.ok(draft.distinctiveKeywords.length > 0,
      'something must remain to tell this format apart');
  });

  test('B-M17: the same sample yields the same draft regardless of corpus size', () => {
    setup();
    const sample = Object.assign({}, PLAIN_SAMPLE, {registeredKeywords: ['利用日']});
    assert.deepEqual(infer(sample), infer(sample),
      'inference must depend only on the sample and the registered vocabulary');
  });

  // ================= 請求年月の種パターン =================

  test('4.12.1: the closing-month pattern in a file name is detected', () => {
    setup();
    assert.ok(infer(PLAIN_SAMPLE).billingMonthSourceIds.indexOf('fn_ym_closing') >= 0);
    assert.equal(infer(PLAIN_SAMPLE).billingMonthAbsent, false);
  });

  // 楽天は enavi 形式。この種パターンが欠けていると楽天を新規登録できない。
  test('A-18: the enavi file-name pattern is present, so Rakuten can be registered', () => {
    setup();
    const draft = infer({fileName: 'enavi202601(1234).csv', rows: PLAIN_SAMPLE.rows});
    assert.ok(draft.billingMonthSourceIds.indexOf('fn_enavi') >= 0,
      'without this seed a Rakuten sample cannot infer its billing month at all');
  });

  test('4.12.1: a sample with no billing month asks the operator to confirm that', () => {
    setup();
    const draft = infer({
      fileName: 'meisai.csv',
      rows: [
        ['利用日', '利用店名', '利用金額'],
        ['2026/01/05', 'コンビニA', '1200']
      ]
    });
    assert.deepEqual(draft.billingMonthSourceIds, []);
    assert.equal(draft.billingMonthAbsent, true,
      'the operator must confirm the absence rather than have it assumed');
  });

  // ================= 推定できないものは答えさせる =================

  test('4.12.1: a sample with no header row leaves it unresolved', () => {
    setup();
    const draft = infer({
      fileName: 'x.csv',
      rows: [
        ['2026/01/05', 'コンビニA', '1200'],
        ['2026/01/08', 'ガソリンB', '5400']
      ]
    });
    assert.ok(draft.unresolved.indexOf('headerRows') >= 0,
      'a guessed header would be shown to the operator as if it were inferred');
  });

  // ---- INV-38：外貨は取得できなくても問題として扱わない ----
  test('INV-38: missing foreign-currency columns are not raised as unresolved', () => {
    setup();
    const draft = infer(PLAIN_SAMPLE);
    assert.equal(draft.currencyColumn, null);
    assert.equal(draft.amountOriginalColumn, null);
    ['currencyColumn', 'amountOriginalColumn', 'exchangeRateColumn'].forEach((key) => {
      assert.ok(draft.unresolved.indexOf(key) < 0,
        `${key} is optional - asking for it would imply the file is deficient`);
    });
  });

  test('4.12.1: foreign-currency columns are picked up when the header names them', () => {
    setup();
    const draft = infer({
      fileName: 'x.csv',
      rows: [
        ['利用日', '利用店名', '利用金額', '通貨コード', '現地通貨額', '換算レート'],
        ['2026/01/05', 'SHOP', '15000', 'USD', '100.00', '150.0']
      ]
    });
    assert.equal(draft.currencyColumn, 4);
    assert.equal(draft.amountOriginalColumn, 5);
    assert.equal(draft.exchangeRateColumn, 6);
  });

  // ---- INV-42：見出し語の照合も正規化を通す ----
  //
  // 4.16 は長音記号（ー）をハイフンへ寄せる。`換算レート` と書かれた見出しは
  // 正規化後 `換算レ-ト` になるので、生の語と突き合わせると永久に一致しない。
  // 日本語のカード明細では長音記号を含む見出しが普通にある。
  test('INV-42: header words containing a long vowel mark still match', () => {
    setup();
    ['換算レート', '為替レート', 'レート'].forEach((headerWord) => {
      const draft = infer({
        fileName: 'x.csv',
        rows: [
          ['利用日', '利用店名', '利用金額', headerWord],
          ['2026/01/05', 'SHOP', '15000', '150.0']
        ]
      });
      assert.equal(draft.exchangeRateColumn, 4,
        `"${headerWord}" must be recognised after normalisation`);
    });
  });

  test('4.12.1: a local-amount column is not stolen by the currency matcher', () => {
    setup();
    // `現地通貨額` は `現地通貨` を含む。素朴に順番へ当てると通貨列が奪う。
    const draft = infer({
      fileName: 'x.csv',
      rows: [
        ['利用日', '利用店名', '利用金額', '現地通貨額', '通貨'],
        ['2026/01/05', 'SHOP', '15000', '100.00', 'USD']
      ]
    });
    assert.equal(draft.amountOriginalColumn, 4);
    assert.equal(draft.currencyColumn, 5);
  });

  test('4.12.1: inference writes nothing to any sheet', () => {
    setup();
    const before = gas.stubs.getSpreadsheet('master').getSheets().length;
    infer(PLAIN_SAMPLE);
    assert.equal(gas.stubs.getSpreadsheet('master').getSheets().length, before);
  });
};

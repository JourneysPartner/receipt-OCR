### 2.1.2 カード形式マスター

同一形式IDについて履歴を保持する（仕様18.5）。更新時は既存行を`有効=FALSE`のまま残し、新しいバージョンの行を追加する。`有効=TRUE`の行は形式IDごとに常に1行のみとする。

| 列 | 項目名 | 型 | 必須 | 説明 |
|---|---|---|---|---|
| A | 形式ID | 文字列 | 必須 | `amazon_mc`, `dcard`, `saison`, `rakuten`等 |
| B | 形式名 | 文字列 | 必須 | 表示用名称 |
| C | ステータス | 文字列 | 必須 | `draft` / `active` / `retired` |
| D | 有効 | 真偽値 | 必須 | TRUE＝現行バージョン。形式IDごとに1行のみTRUE |
| E | ファイル種別 | 文字列 | 必須 | **JSON配列**。`["csv"]` / `["xlsx"]` / `["csv","xlsx"]`。判定は配列への包含で行い、等値比較しない |
| F | 判定キーワード | 文字列 | 必須 | JSON配列。スキーマと評価規則は2.1.2.2 |
| G | ヘッダー行 | 数値 | 必須 | ヘッダー行番号 |
| H | データ開始行 | 数値 | 必須 | 明細データ開始行番号 |
| I | 日付列 | 文字列 | **条件付き必須** | 元ファイルの列記号。**I列とM列の少なくとも一方が必須**。利用日列を持たない形式ではI列を空欄にしてM列を用いる（仕様9.3） |
| J | 利用店名列 | 文字列 | 必須 | 元ファイルの列記号 |
| K | 金額列 | 文字列 | 必須 | 元ファイルの列記号 |
| L | 使用用途列 | 文字列 | - | 元ファイルの列記号 |
| M | 日付代替列 | 文字列 | 条件付き必須 | I列が空の場合に限り必須かつ使用する（仕様9.3） |
| N | 列構造プロファイル | 文字列 | - | JSON。スキーマと評価規則は2.1.2.3。空欄なら判定ステップ3を適用しない |
| O | 除外条件 | 文字列 | - | JSON。スキーマと評価規則は2.1.2.4 |
| P | 照合式 | 文字列 | - | JSON。スキーマと評価規則は2.1.2.5 |
| Q | 請求年月抽出規則 | 文字列 | - | JSON。スキーマと評価規則は2.1.2.6 |
| R | パーサー種別 | 文字列 | 必須 | `generic` / `custom` |
| S | バージョン | 数値 | 必須 | 形式定義のバージョン |
| T | 登録者 | 文字列 | 必須 | メールアドレス |
| U | 承認者 | 文字列 | - | 有効化時の承認者 |
| V | 登録日時 | 日時 | 必須 | ISO 8601 |
| W | 無効化日時 | 日時 | - | 旧バージョン行へ設定 |
| X | 無効化理由 | 文字列 | - | `SUPERSEDED` / `ROLLBACK` / `RETIRED` |
| Y | 遡り許容月数 | 数値 | - | 5.1の許容窓の下側。空欄なら`SETTINGS.YEAR_INFERENCE_MAX_LOOKBACK_MONTHS` |
| Z | 先行許容月数 | 数値 | - | 5.1の許容窓の上側。空欄なら`SETTINGS.YEAR_INFERENCE_MAX_FORWARD_MONTHS` |
| AA | 生成元サンプルID | 文字列 | - | 下書きの生成に用いたサンプル（2.1.19 A列）。手書きで作成した定義では空欄 |
| AB | 登録回答 | 文字列 | - | JSON。操作者が確認・上書きした回答の記録。スキーマと評価規則は2.1.2.7 |
| AC | 有効化ゲート結果 | 文字列 | - | JSON。往復検証・コーパス回帰・判定衝突検査の結果。スキーマと評価規則は2.1.2.8 |
| AD | 改訂理由 | 文字列 | 必須 | `NEW` / `ISSUER_EXPORT_CHANGED` / `DEFECT_FIX` / `ROLLBACK`（4.1 `FORMAT_REVISION_REASON`） |
| **AE** | **通貨コード列** | 文字列 | - | **任意**。元ファイルの列記号。当該形式が現地通貨コードの専用列を持つ場合にのみ設定する（仕様9.4・BR-3・5.13） |
| **AF** | **現地通貨額列** | 文字列 | - | **任意**。元ファイルの列記号。同上 |
| **AG** | **換算レート列** | 文字列 | - | **任意**。元ファイルの列記号。同上 |
| **AH** | **最終更新日時** | 日時 | **必須** | ISO 8601。**当該行のいずれかのセルを変更した時点の日時**。2.1.2.8の評価規則が「AC列のゲート結果が当該行の最終更新以降か」を判定する材料であり、この列がないと当該判定は計算不能である（B-M1） |

**N・O・P・Q列のいずれかが空でなく、かつJSONとして解析できない、または本節のスキーマに適合しない場合は、当該形式定義を使用せず`CARD_FORMAT_DEFINITION_INVALID`（区分2・対応者＝システム管理者）とする。** 不正な定義を「無視して続行」してはならない。無視すると除外行が取引として行を確保し、照合式が沈黙して過少計上を検出できなくなる。

**AB・AC列はVer.2.2で追加した列である。** AB列は「操作者が何を確認したか」を保存し、形式の改訂時に前回の回答を初期値として再提示するために用いる。AC列は「有効化の前にゲートを通ったこと」の証跡であり、**オーナー管理者が承認する対象の一部**である（4.12.5・INV-34）。AC列が空欄、または`overall`が`PASS`でない行を`有効=TRUE`にしてはならない（ロールバックの例外は4.12.9）。

**AE〜AH列はVer.2.3で追加した列である。** AE〜AG列は仕様9.4の補足情報（現地通貨額・通貨コード・換算レート）の取得元であり、**3列すべてが任意である**。空欄であることは形式定義の不備ではなく、当該形式ではこれらを取得しないことを意味する（5.13・INV-38）。AH列は形式定義行の最終更新日時であり、**AC列のゲート結果の鮮度判定に必須**である（2.1.2.8・B-M1）。

**Y列（遡り許容月数）・Z列（先行許容月数）の制約検査**（A-25）：いずれも空欄または0以上の整数とし、双方が非空のとき`Y + Z < 12`であること。違反する値は`CARD_FORMAT_DEFINITION_INVALID`とする。この制約は4.6の検証項目12がSETTINGSの既定値に課すものと同一であり、**形式ごとの上書き値にも同じ制約が掛からないと、上書きした形式でだけ年なし日付が恒常的に全件要確認になる**。検査は`loadFormatDefinitions`（4.11）が行う。**AE〜AG列の制約検査**：値が非空の場合、元ファイル上の列記号として解釈できること。3列のうち一部のみが非空であってよい（`通貨コード列`だけを持つ形式が実在するため）。

### 2.1.2.1 カード形式マスター初期投入データ（仕様8.4）

初期リリース時に次の4行を`ステータス=active`・`有効=TRUE`・`バージョン=1`・`パーサー種別=custom`で投入する。列記号は元ファイル上の列を指す。

| 形式ID | 形式名 | ファイル種別（E） | ヘッダー行（G） | データ開始行（H） | 日付列（I） | 利用店名列（J） | 金額列（K） | 使用用途列（L） | 日付代替列（M） | 遡り（Y） | 先行（Z） |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `amazon_mc` | Amazon Mastercard系 | `["csv","xlsx"]` | 1 | 2 | A | B | C | G | （空欄） | 3 | 1 |
| `dcard` | dカード系 | `["csv","xlsx"]` | 2 | 3 | D | E | F | K | （空欄） | 3 | 1 |
| `saison` | セゾンカード系 | `["csv","xlsx"]` | 5 | 7 | A | B | F | H | （空欄） | 3 | 1 |
| `rakuten` | 楽天カード系 | `["csv","xlsx"]` | 1 | 2 | A | B | E | K | （空欄） | 3 | 1 |

ヘッダー行・データ開始行は「原則」であり、実際の判定は有効明細条件（日付または金額が存在する行）で検証する（5.3）。

初期投入4行のAD列（改訂理由）は`NEW`とする。AA列（生成元サンプルID）とAB列（登録回答）は10.4で初期サンプルを登録し逆導出した時点で埋め、AC列（有効化ゲート結果）は10.4のゲート実行結果で埋める。AE〜AG列（通貨コード列・現地通貨額列・換算レート列）は**4形式とも空欄**とする。初期4形式のいずれも現地通貨の専用列を持たないためであり、これは不備ではない（5.13）。AH列（最終更新日時）は投入時刻を設定する。**初期4形式も、コーパス回帰と判定衝突検査の対象から除外しない**（INV-35）。

**初期投入4行はAB列（登録回答）を持たないまま運用を開始してはならない**（B-M13）。AB列が空の形式は4.12.6の改訂経路（前回の回答を初期値として差分だけ答え直す）に乗らず、11問（Ver.2.3では13問）を最初から答え直すことになる。その結果、2.1.2.1が定める4〜5件の除外ルールとQ列の2系統の取得元を操作者が再現できず、既存サンプルが落ちて改訂が不採用となる。**最も改訂の必要が高い4形式が事実上改訂できない状態になる。** 10.4の手順4'（N・O・P・Q列からAB列を逆導出して保存する）を運用開始の前提条件とする。

**本節のN・O・P・Q列の初期値は、仕様8.4の記述と匿名化サンプルの構造に基づく初期値である。** これらはデータであって設計ではない。仕様24.2の回帰テストで実サンプルと突き合わせ、一致しない場合はカード形式マスターの当該セルのみを更新する（本書の改訂を要しない）。ただし**スキーマ（2.1.2.2〜2.1.2.6）は設計であり、変更には本書の改訂を要する。**

#### F列 判定キーワード 初期値

| 形式ID | F列の値 |
|---|---|
| `amazon_mc` | `{"anyOf":[{"maxRow":2,"keywords":["Amazonマスター","Amazonマスターカード"],"minMatch":1}],"allOf":[{"maxRow":2,"keywords":["使用用途"],"minMatch":1}]}` |
| `dcard` | `{"allOf":[{"maxRow":3,"keywords":["ご利用年月日","利用店名","利用金額","使用用途"],"minMatch":4}]}` |
| `saison` | `{"allOf":[{"maxRow":6,"keywords":["利用日","ご利用店名及び商品名","利用金額","使用用途"],"minMatch":4},{"maxRow":6,"keywords":["カード名称","セゾン"],"minMatch":1}]}` |
| `rakuten` | `{"allOf":[{"maxRow":2,"keywords":["利用日","利用店名・商品名","利用金額","使用用途"],"minMatch":4}]}` |

#### N列 列構造プロファイル 初期値

| 形式ID | N列の値 |
|---|---|
| `amazon_mc` | `{"minColumns":7,"sampleRows":5,"columns":[{"index":0,"type":"date","required":true},{"index":1,"type":"text","required":true},{"index":2,"type":"number","required":true},{"index":6,"type":"any","required":false}]}` |
| `dcard` | `{"minColumns":11,"sampleRows":5,"columns":[{"index":3,"type":"date","required":true},{"index":4,"type":"text","required":true},{"index":5,"type":"number","required":true},{"index":10,"type":"any","required":false}]}` |
| `saison` | `{"minColumns":8,"sampleRows":5,"columns":[{"index":0,"type":"date","required":true},{"index":1,"type":"text","required":true},{"index":5,"type":"number","required":true},{"index":7,"type":"any","required":false}]}` |
| `rakuten` | `{"minColumns":11,"sampleRows":5,"columns":[{"index":0,"type":"date","required":true},{"index":1,"type":"text","required":true},{"index":4,"type":"number","required":true},{"index":10,"type":"any","required":false}]}` |

#### O列 除外条件 初期値

| 形式ID | O列の値 |
|---|---|
| `amazon_mc` | `{"excludeRowRanges":[{"from":1,"to":1}],"excludeWhenDateAndAmountEmpty":true,"rules":[{"id":"amz_total","target":"row","match":"contains","value":"合計","onlyWhenDateEmpty":true},{"id":"amz_billing","target":"row","match":"contains","value":"ご請求","onlyWhenDateEmpty":true},{"id":"amz_payment","target":"row","match":"contains","value":"お支払","onlyWhenDateEmpty":true},{"id":"amz_deposit","target":"cell","column":"B","match":"contains","value":"ご入金"}]}` |
| `dcard` | `{"excludeRowRanges":[{"from":1,"to":2}],"excludeWhenDateAndAmountEmpty":true,"rules":[{"id":"dc_deposit","target":"cell","column":"E","match":"contains","value":"ご入金"},{"id":"dc_total","target":"cell","column":"E","match":"contains","value":"合計"},{"id":"dc_subtotal","target":"cell","column":"E","match":"contains","value":"小計"},{"id":"dc_cashing","target":"cell","column":"E","match":"contains","value":"キャッシング"},{"id":"dc_billing","target":"row","match":"contains","value":"ご請求","onlyWhenDateEmpty":true}]}` |
| `saison` | `{"excludeRowRanges":[{"from":1,"to":6}],"excludeWhenDateAndAmountEmpty":true,"rules":[{"id":"sa_deposit","target":"cell","column":"B","match":"contains","value":"ご入金"},{"id":"sa_cashing","target":"cell","column":"B","match":"contains","value":"キャッシング"},{"id":"sa_total","target":"row","match":"contains","value":"合計","onlyWhenDateEmpty":true},{"id":"sa_billing","target":"row","match":"contains","value":"ご請求","onlyWhenDateEmpty":true}]}` |
| `rakuten` | `{"excludeRowRanges":[{"from":1,"to":1}],"excludeWhenDateAndAmountEmpty":true,"rules":[{"id":"rk_deposit","target":"cell","column":"B","match":"contains","value":"ご入金"},{"id":"rk_total","target":"row","match":"contains","value":"合計","onlyWhenDateEmpty":true},{"id":"rk_billing","target":"row","match":"contains","value":"ご請求","onlyWhenDateEmpty":true},{"id":"rk_payment","target":"row","match":"contains","value":"お支払","onlyWhenDateEmpty":true}]}` |

M12の指摘（`saison`／`rakuten`／`amazon_mc`に合計行・ご入金行の除外がなく、合計行が取引として行を確保して取引IDまで書かれる）は本初期値で解消する。`onlyWhenDateEmpty`は、正当な利用店名に「合計」等が含まれる取引を誤除外しないための限定である（2.1.2.4）。

#### P列 照合式 初期値

| 形式ID | P列の値 |
|---|---|
| `amazon_mc` | `{"count":{"source":"none"},"total":{"source":"none"},"totalScope":"all"}` |
| `dcard` | `{"count":{"source":"none"},"total":{"source":"labeledRow","labelColumn":"E","valueColumn":"F","label":"合計","tolerance":0},"totalScope":"all"}` |
| `saison` | `{"count":{"source":"none"},"total":{"source":"labeledRow","labelColumn":"B","valueColumn":"F","label":"合計","tolerance":0},"totalScope":"all"}` |
| `rakuten` | `{"count":{"source":"none"},"total":{"source":"none"},"totalScope":"all"}` |

`source = "none"`および`labeledRow`で該当行が見つからない場合は、当該項目を照合対象外とする（5.9 ケース1）。照合材料を持たない形式で過少計上を検出する手段は、照合式ではなく読取打切りの検査（5.3・`SCAN_TRUNCATION_SUSPECTED`）が担う。

#### Q列 請求年月抽出規則 初期値

**「請求年月」は締め年月（当該ファイルの明細が属する利用期間の終了年月）と定義する**（2.1.2.6）。初期4形式はいずれもファイル名またはヘッダーから支払年月を得られるため、`means:"payment"`と`offsetMonths`で締め年月へ正規化する。

| 形式ID | Q列の値 |
|---|---|
| `amazon_mc` | `{"sources":[{"id":"hdr_period","kind":"scanRows","scanMaxRows":3,"pattern":"ご利用期間[^0-9]{0,8}(20\\d{2})[/年](0?[1-9]\|1[0-2])[/月](?:0?[1-9]\|[12]\\d\|3[01])日?[^0-9]{0,4}[~〜\\-][^0-9]{0,4}(20\\d{2})[/年](0?[1-9]\|1[0-2])[/月]","groups":{"year":1,"month":2,"endYear":3,"endMonth":4},"yearDigits":4,"means":"periodEnd"},{"id":"fn_ym","kind":"fileName","pattern":"(20\\d{2})[-_年/]?(0?[1-9]\|1[0-2])月?","groups":{"year":1,"month":2},"yearDigits":4,"means":"payment","offsetMonths":1}]}` |
| `dcard` | `{"sources":[{"id":"hdr_pay","kind":"scanRows","scanMaxRows":2,"pattern":"(20\\d{2})年\\s*(0?[1-9]\|1[0-2])月\\s*(?:お)?支払(?:い)?分","groups":{"year":1,"month":2},"yearDigits":4,"means":"payment","offsetMonths":1},{"id":"fn_ym","kind":"fileName","pattern":"(20\\d{2})[-_年/]?(0?[1-9]\|1[0-2])月?","groups":{"year":1,"month":2},"yearDigits":4,"means":"payment","offsetMonths":1}]}` |
| `saison` | `{"sources":[{"id":"hdr_pay","kind":"scanRows","scanMaxRows":6,"pattern":"(20\\d{2})年\\s*(0?[1-9]\|1[0-2])月\\s*お支払い?分","groups":{"year":1,"month":2},"yearDigits":4,"means":"payment","offsetMonths":1},{"id":"fn_ym","kind":"fileName","pattern":"(20\\d{2})[-_年/]?(0?[1-9]\|1[0-2])月?","groups":{"year":1,"month":2},"yearDigits":4,"means":"payment","offsetMonths":1}]}` |
| `rakuten` | `{"sources":[{"id":"fn_enavi","kind":"fileName","pattern":"enavi(20\\d{2})(0[1-9]\|1[0-2])","groups":{"year":1,"month":2},"yearDigits":4,"means":"payment","offsetMonths":1},{"id":"hdr_pay","kind":"scanRows","scanMaxRows":2,"pattern":"(20\\d{2})年\\s*(0?[1-9]\|1[0-2])月\\s*(?:お)?支払(?:い)?分","groups":{"year":1,"month":2},"yearDigits":4,"means":"payment","offsetMonths":1}]}` |

表中の`\|`はMarkdownの表セル区切りとの衝突を避けるためのエスケープ表記であり、シートへ格納する実値は`|`（正規表現の選択）である。

### 2.1.2.2 F列 判定キーワードのスキーマと評価規則

```text
{
  "allOf": [ 条件 ... ],      // 省略可。すべて成立が必要
  "anyOf": [ 条件 ... ]       // 省略可。1つ以上成立が必要
}
条件 = { "maxRow": 数値, "keywords": [文字列 ...], "minMatch": 数値 }
```

| キー | 型 | 必須 | 内容 |
|---|---|---|---|
| `allOf` | 条件の配列 | - | 全条件が成立しなければ判定不成立 |
| `anyOf` | 条件の配列 | - | いずれか1条件の成立で足りる |
| `maxRow` | 数値 | 必須 | 先頭から何行目までを走査対象にするか（1起算・物理行） |
| `keywords` | 文字列配列 | 必須 | 照合する文字列 |
| `minMatch` | 数値 | 必須 | `keywords`のうち何件一致すれば条件成立とするか |

**評価規則**：先頭から`maxRow`行の全セル値を`cellToCanonicalString`（5.6）で正準化し、さらに4.16の正規化（NFKC・大文字化・空白統一・前後空白除去）を適用したうえで1本の文字列へ連結する。`keywords`の各要素にも同じ正規化を適用し、連結文字列に**部分一致で含まれる**件数を数える。件数が`minMatch`以上なら当該条件は成立。`allOf`の全条件が成立し、かつ`anyOf`が存在する場合は`anyOf`のいずれか1条件が成立するとき、判定ステップ1（特徴的ヘッダー）を成立とする。`allOf`・`anyOf`がともに省略された場合は不成立とする。

**下位互換**：F列が単純なJSON配列（例：`["利用日","利用金額"]`）である場合は、`{"allOf":[{"maxRow":G列の値+1,"keywords":当該配列,"minMatch":配列の要素数}]}` と解釈する。

### 2.1.2.3 N列 列構造プロファイルのスキーマと評価規則

```text
{
  "minColumns": 数値,
  "sampleRows": 数値,
  "columns": [ { "index": 数値, "type": "date"|"text"|"number"|"any", "required": 真偽 } ]
}
```

| キー | 型 | 必須 | 内容 |
|---|---|---|---|
| `minColumns` | 数値 | 必須 | 明細行が持つべき最小列数 |
| `sampleRows` | 数値 | - | 照合に用いる明細候補行数。既定5 |
| `columns[].index` | 数値 | 必須 | **0起算**の列位置（A列＝0） |
| `columns[].type` | 文字列 | 必須 | 期待するデータ型 |
| `columns[].required` | 真偽 | 必須 | 真のとき型不適合で不成立 |

**型の判定**：`date` はパーサーの日付解釈規則（Excelシリアル値・`YYYY/M/D`・`M/D`・`YY/M/D`等）で日付または月日として解釈できること。`number` はカンマ・通貨記号・前後空白・全角数字を除去・正規化したうえで整数または小数として解釈できること。`text` は正準化後に空でない文字列であること。`any` は常に適合（空欄を含む）。

**評価規則**：データ開始行（H列）以降から、日付列または金額列に値がある行を最大`sampleRows`行取得する。取得できた行が0行なら**不成立**。取得できた各行について、(1) 行の列数が`minColumns`以上、(2) `columns`のうち`required=true`の全要素について当該位置のセルが`type`に適合、の両方を満たすことを確認する。**取得できた全行が満たす場合にのみ判定ステップ3を成立**とする。N列が空欄の場合、判定ステップ3は適用しない（成立・不成立のいずれとも扱わず、他のステップの結果に委ねる）。

### 2.1.2.4 O列 除外条件のスキーマと評価規則

```text
{
  "excludeRowRanges": [ { "from": 数値, "to": 数値 } ],
  "excludeWhenDateAndAmountEmpty": 真偽,
  "rules": [ {
      "id": 文字列, "target": "row"|"cell", "column": 列記号,
      "match": "equals"|"contains"|"startsWith"|"regex"|"empty",
      "value": 文字列, "caseSensitive": 真偽,
      "normalize": 真偽, "onlyWhenDateEmpty": 真偽
  } ]
}
```

| キー | 型 | 必須 | 既定 | 内容 |
|---|---|---|---|---|
| `excludeRowRanges` | 配列 | - | `[]` | 除外する物理行番号の区間（1起算・両端を含む） |
| `excludeWhenDateAndAmountEmpty` | 真偽 | - | `true` | 日付列・金額列がともに空の行を除外する |
| `rules[].id` | 文字列 | 必須 | - | 一意識別子。除外理由としてログへ記録する |
| `rules[].target` | 文字列 | 必須 | - | `cell`＝`column`が指すセル、`row`＝行の全セルを正準化して連結した文字列 |
| `rules[].column` | 列記号 | `target=cell`のとき必須 | - | 元ファイル上の列記号 |
| `rules[].match` | 文字列 | 必須 | - | 照合方法 |
| `rules[].value` | 文字列 | `match=empty`以外で必須 | - | 照合値 |
| `rules[].caseSensitive` | 真偽 | - | `false` | 偽のとき大文字小文字を区別しない |
| `rules[].normalize` | 真偽 | - | `true` | 真のとき照合対象・照合値の双方へ4.16の正規化を適用する |
| `rules[].onlyWhenDateEmpty` | 真偽 | - | `false` | 真のとき、日付列が空または日付として解釈できない行にのみ当該ルールを適用する |

**評価規則**：行 r は次のいずれか1つでも成立すれば除外する（**論理和**）。

1. `excludeRowRanges`のいずれかの区間に r が含まれる。
2. `excludeWhenDateAndAmountEmpty`が真で、日付列（I列。空欄ならM列）と金額列がともに空である。
3. `rules`のいずれか1つに該当する。`onlyWhenDateEmpty`が真のルールは、r の日付列が空または日付として解釈できない場合にのみ評価する。

`regex`はECMAScript正規表現とし、フラグは`caseSensitive`が偽のとき`i`のみを付す。`m`・`g`・`s`を付さない。除外した行は`CommonTransaction`として出力しない。したがって行も取引IDも確保されない（5.3）。

### 2.1.2.5 P列 照合式のスキーマと評価規則

```text
{
  "count": 項目, "total": 項目,
  "totalScope": "all"|"positiveOnly"|"excludeNegative"
}
項目 = {
  "source": "none"|"cell"|"labeledRow",
  "cell": "A1形式",
  "label": 文字列, "labelColumn": 列記号, "valueColumn": 列記号,
  "expression": 文字列, "tolerance": 数値
}
```

| キー | 型 | 必須 | 既定 | 内容 |
|---|---|---|---|---|
| `source` | 文字列 | 必須 | - | `none`＝当該項目は照合対象外 |
| `cell` | 文字列 | `source=cell`で必須 | - | 期待値を持つセル |
| `label`／`labelColumn`／`valueColumn` | 文字列 | `source=labeledRow`で必須 | - | ラベル列がラベルと一致する最初の行の値列を期待値とする |
| `expression` | 文字列 | - | なし | 実測値の算出式（`total`のみ） |
| `tolerance` | 数値 | - | `0` | 許容差の絶対値 |
| `totalScope` | 文字列 | - | `all` | 実測合計の算出範囲 |

**評価規則**：

1. `count.source`と`total.source`がともに`none`なら`{ok:true, kind:'NOT_APPLICABLE'}`を返す（5.9 ケース1）。
2. 期待値の取得。`cell`は当該セル値を`cellToCanonicalString`で正準化し10進数として解釈する。`labeledRow`は`labelColumn`の値を4.16で正規化した結果が`label`（同じ正規化を適用）と**完全一致**する最初の行を探し、その`valueColumn`の値を同様に解釈する。**該当行が存在しない場合、その項目は照合対象外**とする（停止させない）。数値として解釈できない場合は`CARD_FORMAT_DEFINITION_INVALID`ではなく当該項目を照合対象外とし、その旨を処理ログへ記録する。
3. 実測値の算出。件数＝出力した`CommonTransaction`の件数。合計＝`totalScope`に従い、`all`は全取引の`amountBillingJpy`の総和、`positiveOnly`は正数のみの総和、`excludeNegative`は負数を0として扱った総和。いずれも整数円で計算する。
4. `expression`が与えられた場合は、実測合計に代えて式を評価する。使用できる項は`SUM`／`SUM_POSITIVE`／`SUM_NEGATIVE`／`COUNT`および10進整数リテラル、演算子は`+ - * /`と丸括弧に限る。**これ以外の字句を含む式は`CARD_FORMAT_DEFINITION_INVALID`とする。** 除算は整数除算とし、余りを切り捨てる。
5. 照合対象である全項目について`|期待値 − 実測値| ≦ tolerance`が成立するとき`{ok:true}`。1項目でも成立しなければ`{ok:false, expected, actual, kind:'COUNT'|'TOTAL'}`を返す。

### 2.1.2.6 Q列 請求年月抽出規則のスキーマと評価規則

**定義：請求年月とは、当該ファイルの明細が属する利用期間の終了年月＝締め年月である。** 支払年月でも利用月でもない。支払年月しか得られない形式は`offsetMonths`で締め年月へ正規化する。

```text
{
  "sources": [ {
      "id": 文字列,
      "kind": "fileName"|"cell"|"scanRows",
      "cell": "A1形式", "scanMaxRows": 数値,
      "pattern": 文字列,
      "groups": { "year": 数値, "month": 数値, "endYear": 数値, "endMonth": 数値 },
      "yearDigits": 2|4,
      "means": "closing"|"periodEnd"|"payment",
      "offsetMonths": 数値
  } ]
}
```

| キー | 型 | 必須 | 既定 | 内容 |
|---|---|---|---|---|
| `id` | 文字列 | 必須 | - | 一意識別子。確定時に根拠として記録する |
| `kind` | 文字列 | 必須 | - | 照合対象の取得元 |
| `cell` | 文字列 | `kind=cell`で必須 | - | 対象セル |
| `scanMaxRows` | 数値 | - | 10 | `kind=scanRows`で走査する先頭行数 |
| `pattern` | 文字列 | 必須 | - | ECMAScript正規表現。捕獲グループで年・月を取り出す |
| `groups` | オブジェクト | 必須 | - | 捕獲グループ番号（1起算）の対応 |
| `yearDigits` | 数値 | - | 4 | 2のとき5.1の2桁年規則で解釈する |
| `means` | 文字列 | 必須 | - | 取り出した年月の意味 |
| `offsetMonths` | 数値 | `means=payment`で必須 | - | 締め年月 ＝ 支払年月 − `offsetMonths`（月序数で減算） |

**評価規則**：

1. 照合対象文字列を作る。`fileName`は恒久ファイルインデックスC列「元ファイル名」（接頭辞除去後の不変値。INV-12）。`cell`は当該セルの`cellToCanonicalString`。`scanRows`は先頭から`scanMaxRows`行の全セルを`cellToCanonicalString`で正準化し、区切りとして`"\n"`を挟んで連結した文字列。いずれにも4.16の正規化は適用しない（正規表現が全角・半角を明示するため）。
2. `sources`を配列順に評価する。`pattern`が一致しない`source`は「値を返さなかった」として無視し、**矛盾の材料にしない**。
3. 一致した`source`について、`groups.endYear`／`groups.endMonth`が定義されていればそれを、なければ`groups.year`／`groups.month`を用いる。`yearDigits=2`のときは5.1の2桁年規則で年を解釈し、解釈が一意にならない場合は当該`source`を無視する。
4. `means`に従って締め年月へ正規化する。`closing`・`periodEnd`はそのまま。`payment`は月序数から`offsetMonths`を減じる。
5. 値を返した`source`が1つ以上あり、**正規化後の締め年月がすべて同一**である場合、`{status:'RESOLVED', year, month, sources:[id...]}`を返す。**同一性の判定は正規化後の締め年月に対して行う**（正規化前の値が異なることは矛盾ではない）。
6. 正規化後の締め年月が1つでも異なる場合は`{status:'CONFLICT', candidates:[{id, year, month}...]}`を返す。
7. 値を返した`source`が0件、または`sources`が空、またはQ列が空欄の場合は`{status:'NOT_FOUND'}`を返す。

**規則5がVer.2.0からの実質的な変更点である。** Ver.2.0は「1つでも異なる値を示した場合は確定しない」としていたが、日本のカード明細は「ファイル名＝支払月／ヘッダー＝利用期間」の組合せが常態であり、両者は必ず異なる`(year, month)`を返す。正規化前の値で比較すると**ほぼ全ファイルが曖昧**になり、dカード・セゾンでは実質的に全明細が手作業へ戻る。正規化後に比較することでこの常態が正しく確定する。

### 2.1.2.7 AB列 登録回答のスキーマと評価規則

**本節は「操作者が何を確認したか」の保存形式である。** 操作者はこのJSONを直接編集しない。4.12.1のダイアログの回答からシステムが組み立て、N・O・P・Q列を導出する（4.12.1の導出表）。保存する理由は、形式の改訂時（4.12.6）に前回の回答を初期値として再提示し、操作者に同じ確認を最初からやり直させないためである。

```text
{
  "answerVersion": 2,
  "parserKind": "generic"|"custom",
  "sampleId": 文字列,
  "fileTypes": [ "csv"|"xlsx" ... ],
  "sheetName": 文字列,
  "headerRows": [ 数値 ... ],
  "dataStartRow": 数値,
  "dateColumn": 列記号|null,
  "dateFallbackColumn": 列記号|null,
  "merchantColumn": 列記号,
  "amountColumn": 列記号,
  "purposeColumn": 列記号|null,
  "currencyColumn": 列記号|null,
  "amountOriginalColumn": 列記号|null,
  "exchangeRateColumn": 列記号|null,
  "columnTypes": [ { "column": 列記号,
                     "type": "date"|"text"|"number"|"any",
                     "required": 真偽 } ],
  "keywords": [ 文字列 ... ],
  "keywordMinMatch": 数値,
  "distinctiveKeywords": [ 文字列 ... ],
  "exclusionLabels": [ { "label": 文字列, "column": 列記号|null,
                         "onlyWhenDateEmpty": 真偽 } ],
  "excludeRowRanges": [ { "from": 数値, "to": 数値 } ],
  "totalRow": { "labelColumn": 列記号, "valueColumn": 列記号,
                "label": 文字列 } | null,
  "billingMonthSourceIds": [ 文字列 ... ],
  "billingMonthCustomSources": [ source ... ],
  "billingMonthAbsent": 真偽,
  "lookbackMonths": 数値|null,
  "forwardMonths": 数値|null,
  "derivedFromDefinition": 真偽,
  "answeredBy": 文字列,
  "answeredAt": ISO8601
}
```

| キー | 型 | 必須 | 内容 |
|---|---|---|---|
| `answerVersion` | 数値 | 必須 | 本スキーマの版。**現在は`2`のみ**（Ver.2.3で`1`から更新）。`1`の行を読んだ場合は下記の**移行規則**で`2`へ読み替える |
| **`parserKind`** | 文字列 | 必須 | `generic`＝4.12.1の下書き生成手順で作られた定義。**`custom`＝専用パーサーを要する形式**（4.12.8）。カード形式マスターR列と一致すること |
| `sampleId` | 文字列 | 必須 | 回答の対象サンプル（2.1.19 A列） |
| **`fileTypes`** | 文字列配列 | 必須 | **1要素以上。カード形式マスターE列になる**（B-M2）。CSVとXLSXの両方を出す発行会社では`["csv","xlsx"]`とする。**両者を別形式に分けると見出しも列構造も同一であるため判定衝突検査（4.12.4）に必ず落ちる** |
| `sheetName` | 文字列 | 必須 | 判定対象シート。CSVでは空文字列とする |
| **`headerRows`** | 数値配列 | 必須 | **1要素以上、昇順、1起算の物理行番号**（B-M8）。複数行ヘッダーを表現する。カード形式マスターG列には**最小値**を書き、F列の`maxRow`には**最大値 + 1**を用いる |
| `dataStartRow` | 数値 | 必須 | 1起算の物理行番号。カード形式マスターH列になる。`max(headerRows) < dataStartRow`であること |
| `dateColumn` / `dateFallbackColumn` | 列記号 or `null` | 必須 | I・M列になる。**両方`null`は`parserKind = "generic"`では不可**（A-19）。`custom`では両方`null`を許す（年月日が別列の形式など。4.12.8） |
| `merchantColumn` / `amountColumn` | 列記号 | 必須 | J・K列になる |
| `purposeColumn` | 列記号 or `null` | 必須 | L列になる |
| **`currencyColumn` / `amountOriginalColumn` / `exchangeRateColumn`** | 列記号 or `null` | 必須 | **カード形式マスターAE・AF・AG列になる。3つとも`null`でよく、`null`であることは不備ではない**（仕様9.4・BR-3・5.13） |
| `columnTypes` | 配列 | 必須 | N列の`columns`になる。`column`は列記号で保持し、N列へは0起算の`index`へ変換する。**`required = true` を立ててよいのは`dateColumn`／`merchantColumn`／`amountColumn`が指す列に限る**（B-M9） |
| `keywords` | 文字列配列 | 必須 | **1要素以上。** F列`allOf`の`keywords`になる。**質問12で操作者が編集する**（CR-6） |
| **`keywordMinMatch`** | 数値 | 必須 | **F列`allOf`の`minMatch`になる。`1 ≦ keywordMinMatch ≦ keywords.length`。** 質問12で操作者が指定する。既定値は`keywords.length`（CR-6） |
| `distinctiveKeywords` | 文字列配列 | 必須 | F列`anyOf`の`keywords`になる。空配列なら`anyOf`をF列に置かない。**質問13で操作者が候補から選ぶか自由入力する**（CR-6） |
| `exclusionLabels` | 配列 | 必須 | O列`rules`になる。`column`が`null`なら`target:"row"`、非`null`なら`target:"cell"` |
| `excludeRowRanges` | 配列 | 必須 | O列`excludeRowRanges`になる |
| `totalRow` | オブジェクト or `null` | 必須 | P列`total`になる。`null`なら`{"source":"none"}`。**`valueColumn`は質問10で操作者が合計金額のセルを選択して決める**（B-M5） |
| `billingMonthSourceIds` | 文字列配列 | 必須 | 採用した種パターン（4.12.1の種パターン表）の`id`。Q列`sources`の並び順の前半になる |
| **`billingMonthCustomSources`** | 配列 | 必須 | **操作者がプレビュー上で年月の書かれたセルを選択した結果から、システムが生成した`source`定義**（2.1.2.6のスキーマに適合する完全な要素）。Q列`sources`の並び順の後半になる。**操作者が`kind`／`pattern`／`groups`を手入力する経路を設けない**（A-2・仕様8.3「形式定義の内部表現を人が直接記述する手順にしない」）。空配列可 |
| `billingMonthAbsent` | 真偽 | 必須 | 真＝このファイルには請求年月の表記がないと操作者が明示した。**真のときQ列を空欄とし、期待年補完集計の`billingMonthStatus`を`ABSENT_BY_ANSWER`とする**（2.1.19.1・4.12.2 合格条件7・10） |
| `lookbackMonths` / `forwardMonths` | 数値 or `null` | 必須 | Y・Z列になる。`null`なら空欄（`SETTINGS`の既定値を使う）。**年なし日付の推定窓だけを上書きする。年あり日付の健全性窓（5.1 規則6b）は形式ごとに上書きできない** |
| **`derivedFromDefinition`** | 真偽 | 必須 | **真＝N〜Q列から逆導出して作った回答である**（10.4 手順4'・B-M13）。**真のとき4.12.5の再導出照合を行わない**（逆導出は完全な往復を保証しないため）。通常の登録・改訂では偽 |
| `answeredBy` / `answeredAt` | 文字列 | 必須 | 回答者と回答日時。**逆導出の場合は逆導出の実行者と実行日時** |

**`answerVersion = 1` からの移行規則**：`fileType`（単数）→`fileTypes: [値]`、`headerRow`→`headerRows: [値]`、`keywordMinMatch`＝`keywords.length`、`parserKind`＝カード形式マスターR列の値、`currencyColumn`／`amountOriginalColumn`／`exchangeRateColumn`／`billingMonthCustomSources`＝`null`／`[]`、`derivedFromDefinition`＝`false`。**移行は読取時に行い、次回の`saveDraftAnswers`で`answerVersion = 2`として保存する。** 版`1`のまま保存された行を不正としない（Ver.2.2で保存された下書きが読めなくなることを避けるため）。

**評価規則**：AB列が空でなく、かつJSONとして解析できない、または本節のスキーマ（移行規則の適用後）に適合しない場合は`CARD_FORMAT_DEFINITION_INVALID`とする。**AB列は下書きの生成と改訂の入力にのみ用い、明細の抽出・判定に用いない。** 抽出・判定の正本はN・O・P・Q列である。AB列とN〜Q列が食い違っていても抽出結果は変わらないが、4.12.5の有効化は**`parserKind = "generic"`かつ`derivedFromDefinition`が偽の場合に限り**AB列からN〜Q列を再導出し、カード形式マスターの現在値と一致することを確認してから行う（不一致は`FORMAT_SAMPLE_ROUNDTRIP_FAILED`）。**`parserKind = "custom"`の行では再導出照合を行わない**（N〜Q列が下書き生成手順の出力ではないため。4.12.8）。**`derivedFromDefinition`が真の行でも再導出照合を行わない**（逆導出は完全な往復を保証しないため。10.4 手順4'・B-M13）。

### 2.1.2.8 AC列 有効化ゲート結果のスキーマと評価規則

```text
{
  "gateVersion": 2,
  "scope": "ACTIVATION"|"ROLLBACK",
  "overall": "PASS"|"FAIL"|"NOT_RUN",
  "ranAt": ISO8601,
  "ranBy": 文字列,
  "codeVersion": 文字列,
  "corpusFingerprint": 16進64桁,
  "gates": {
    "ROUNDTRIP": 結果,
    "CORPUS_REGRESSION": 結果,
    "DETECTION_COLLISION": 結果
  },
  "progress": { "totalSampleIds": [ 文字列 ... ],
                "doneSampleIds": [ 文字列 ... ],
                "runId": 文字列|null }
}
結果 = {
  "result": "PASS"|"FAIL"|"NOT_RUN"|"NOT_APPLICABLE",
  "checkedSampleIds": [ 文字列 ... ],
  "failures": [ { "sampleId": 文字列, "reason": 文字列,
                  "rowNumber": 数値|null, "item": 文字列|null,
                  "expected": 文字列|数値|null,
                  "actual": 文字列|数値|null,
                  "collidedFormatId": 文字列|null,
                  "collidedFormatVersion": 数値|null,
                  "matchedStep": 1|2|3|4|null } ]
}
```

| キー | 型 | 必須 | 内容 |
|---|---|---|---|
| `gateVersion` | 数値 | 必須 | 本スキーマの版。**現在は`2`のみ**（Ver.2.3で`1`から更新）。版`1`の結果は**鮮度不足として扱い、`activateFormat`が受理しない**（再実行を要する） |
| **`scope`** | 文字列 | 必須 | **`ACTIVATION`＝新規登録・改訂の有効化。3ゲートすべてを実行する。`ROLLBACK`＝直前バージョンへの復元。`CORPUS_REGRESSION`と`DETECTION_COLLISION`の2ゲートのみを実行し、`ROUNDTRIP`は`NOT_APPLICABLE`とする**（A-3・4.12.9） |
| `overall` | 文字列 | 必須 | **`scope`が要求する全ゲートが`PASS`のときのみ`PASS`**（`NOT_APPLICABLE`は`PASS`とみなす）。1つでも`FAIL`なら`FAIL`、それ以外（未実行を含む）は`NOT_RUN` |
| `ranAt` / `ranBy` / `codeVersion` | 文字列 | 必須 | 実行日時・実行者・実行時の`VERSIONS.CODE` |
| **`corpusFingerprint`** | 文字列 | 必須 | **ゲート実行時点のコーパスと判定集合の指紋**（16進64桁）。算出規則は本節末尾。有効化の直前に再計算し、一致しない場合はゲートをやり直す（B-M1） |
| `gates.<ゲート名>` | オブジェクト | 必須 | ゲート名は4.1 `ACTIVATION_GATE`の3値。3つとも必ず存在する |
| `結果.result` | 文字列 | 必須 | 4.1 `GATE_RESULT`の4値。`NOT_APPLICABLE`は`scope = ROLLBACK`の`ROUNDTRIP`にのみ現れる |
| `結果.checkedSampleIds` | 文字列配列 | 必須 | 実際に照合したサンプルID。**`CORPUS_REGRESSION`では、この配列が2.1.19の「回帰対象サンプル」の全集合と一致しなければ`result`を`PASS`にできない**（INV-35。回帰対象の定義は同条件） |
| `結果.failures` | 配列 | 必須 | 不合格の内訳。`result = PASS`のときは空配列 |
| `failures[].reason` | 文字列 | 必須 | 満たさなかった条件の識別子。許容値は次の2群に限る。**(a) `ROUNDTRIP`・`CORPUS_REGRESSION`のとき**：`ROUNDTRIP_C1`〜`ROUNDTRIP_C11`（4.12.2の合格条件の番号に対応）、`SAMPLE_FILE_MISSING`（4.12.3 手順3）、`SAMPLE_EXPECTED_TAMPERED`（9.1・A-20）。**(b) `DETECTION_COLLISION`のとき**：`NEW_DEF_MATCHES_OTHER_SAMPLE` / `EXISTING_DEF_MATCHES_NEW_SAMPLE` / `NOT_UNIQUE_ON_NEW_SAMPLE` / **`REVISED_DEF_MISSES_PRIOR_SAMPLE`**（4.12.4の検査1・2・3・2'に対応） |
| **`failures[].rowNumber` / `item`** | 数値・文字列 or `null` | 必須 | **不一致が起きた元ファイル行番号と項目名**（`date`／`amount`／`merchant`／`purpose`／`judgement`／`exclusionRule`／`derivedDate`）。操作者へ「どのサンプルの、どの明細行の、どの項目が、どう変わったか」を提示するために必須である。行単位でない不一致（件数・合計等）では`null` |
| `failures[].collidedFormatId` / `collidedFormatVersion` / `matchedStep` | 文字列・数値 or `null` | 必須 | `DETECTION_COLLISION`のときは非`null`（`matchedStep`は仕様8.1の判定ステップ1〜4）。他のゲートでは`null` |
| **`progress`** | オブジェクト | 必須 | **コーパス回帰の分割実行の中間状態**（A-13・4.12.3）。`totalSampleIds`は対象全件、`doneSampleIds`は照合済み、`runId`は継続トリガーの実行ID。`overall = PASS`のときは`doneSampleIds`が`totalSampleIds`と一致し、`runId`は`null`である |

**`corpusFingerprint`の算出規則**（B-M1）：次の2群を`serializeDeterministic`（5.6.1）で直列化しSHA-256を取る。

| 群 | 内容 |
|---|---|
| 1 | 2.1.19の**回帰対象サンプル**の各行について`[サンプルID, 形式ID, 匿名化ファイルのバイナリハッシュ(G列), 期待値dataHash(AD列)]`を、サンプルID昇順に並べたもの |
| 2 | カード形式マスターの**`ステータス=active`かつ`有効=TRUE`**の各行について`[形式ID, バージョン, E列, F列, G列, H列, I列, J列, K列, L列, M列, N列, O列, P列, Q列, Y列, Z列, AE列, AF列, AG列]`を、形式ID昇順に並べたもの |

先頭要素に`gateVersion`を置く。**この指紋は「別の形式が有効化された」「別のサンプルが追加・失効した」「期待値が再ベースラインされた」のいずれによっても変化する。** Ver.2.2のAC列は`ranAt`と当該行の最終更新の前後関係だけを見ていたが、**当該行が変わらなくてもコーパスと判定集合は変わり得る**ため、鮮度判定として機能していなかった（B-M1）。

**評価規則**：`activateFormat`（4.12.5）は、AC列を解析して次の**すべて**を満たす場合にのみ有効化を実行できる。

| # | 条件 |
|---|---|
| 1 | `gateVersion = 2` |
| 2 | `scope = "ACTIVATION"` |
| 3 | `overall = "PASS"` |
| 4 | `ranAt`が当該行の**AH列（最終更新日時）以降**である |
| 5 | `codeVersion`が現在の`VERSIONS.CODE`と一致する |
| 6 | **`corpusFingerprint`が、有効化の直前に再計算した値と一致する** |

いずれかを満たさない場合は`FORMAT_CORPUS_REGRESSION_FAILED`（未実行・古い結果の使い回し・コーパスの変化を含む）として有効化を却下し、**`runActivationGates`のやり直しを促す**。`rollbackCardFormat`（4.12.9）は条件2を`scope = "ROLLBACK"`と読み替え、条件3をオーナー管理者の明示承認で代替できる。**古いゲート結果を再利用しない**のは、定義またはコーパスがゲート実行後に変わっている可能性を排するためである。

### 2.1.3 使用用途補完マスター
### 2.1.19 形式サンプル台帳

仕様20.4「自動テストには構造を維持した匿名化コピーを使用する」と仕様24.2「匿名化した実構造サンプルの全明細について期待値と照合する」を、**形式が増え続ける前提で自動実行できる形にするための台帳**である（Ver.2.2・4.12.3）。

**サンプルファイルの実体は`SETTINGS.SAMPLE_CORPUS_FOLDER_ID`が指すDriveフォルダに保管し、本シートはその識別情報と集計期待値だけを持つ。** 明細1行ごとの期待値は2.1.20へ持つ。

| 列 | 項目名 | 型 | 必須 | 説明 |
|---|---|---|---|---|
| A | サンプルID | 文字列 | 必須 | `SMP_`接頭辞。一意キー |
| B | 形式ID | 文字列 | 必須 | カード形式マスターA列 |
| C | 期待値生成バージョン | 数値 | 必須 | 期待値（本シートL〜P列・2.1.20）を生成した時点のカード形式定義バージョン（カード形式マスターS列）。**照合に用いるバージョンではない**（4.12.3） |
| D | 表示名 | 文字列 | 必須 | 一覧表示用。カード会社名と入手時期がわかる名称 |
| E | 匿名化ファイルID | 文字列 | 必須 | DriveファイルID。`SAMPLE_CORPUS_FOLDER_ID`配下にあること |
| F | ファイル種別 | 文字列 | 必須 | `csv` / `xlsx` |
| G | 匿名化ファイルのバイナリハッシュ | 文字列 | 必須 | SHA-256（16進64桁）。**照合前に必ず再計算して一致を確認する**（不一致は`SAMPLE_FILE_MISSING`） |
| H | hashVersion | 文字列 | 必須 | G列を生成した規則 |
| I | 判定用ファイル名 | 文字列 | 必須 | 請求年月抽出（2.1.2.6 `kind:"fileName"`）と使用用途補完（5.4）の入力として用いる文字列。**Drive上の現在のファイル名ではなく本列を用いる**（匿名化でファイル名を改めるため） |
| J | 匿名化方式 | 文字列 | 必須 | **`ANONYMIZE`**（4.12.7に定義）。他の値を認めない。**版はZ列に持つ**（A-9） |
| K | 状態 | 文字列 | 必須 | **`PENDING` / `ACTIVE` / `SUPERSEDED` / `RETIRED`**（4.1 `SAMPLE_STATUS`）。**回帰の対象は`ACTIVE`のみ**（回帰対象の厳密な定義は本節末尾） |
| L | 期待取引件数 | 数値 | 条件付き必須 | 抽出される`CommonTransaction`の件数。**`状態=PENDING`の行では空欄**（期待値未確定） |
| M | 期待合計金額 | 数値 | 条件付き必須 | 抽出取引の`amountBillingJpy`の総和（整数円）。同上 |
| N | 期待除外行数 | 数値 | 条件付き必須 | 2.1.2.4により除外された行の件数。同上 |
| O | 期待請求年月 | 文字列 | - | `YYYY-MM`（締め年月）。AB列（登録回答）の`billingMonthAbsent`が真の形式では空欄 |
| P | 期待年補完集計 | 文字列 | 条件付き必須 | JSON。スキーマは2.1.19.1。**`状態=PENDING`の行では空欄** |
| Q | 登録者 | 文字列 | 必須 | メールアドレス（システム管理者以上） |
| R | 登録日時 | 日時 | 必須 | ISO 8601。**台帳へ行を作った日時**（採取日時ではない。A-9） |
| S | 最終検証日時 | 日時 | - | 最後に4.12.3の照合を実行した日時 |
| T | 最終検証結果 | 文字列 | 必須 | `PASS` / `FAIL` / `NOT_RUN` / `NOT_APPLICABLE`（4.1 `GATE_RESULT`）。既定は`NOT_RUN` |
| U | 無効化日時 | 日時 | - | K列を`SUPERSEDED`／`RETIRED`にした日時 |
| V | 無効化理由 | 文字列 | - | `SUPERSEDED_BY_REVISION` / `RETIRED_BY_OWNER` / **`RETIRED_BY_EXPIRY`**（4.1 `SAMPLE_RETIRE_REASON`） |
| W | 無効化承認者 | 文字列 | - | `RETIRED`にしたオーナー管理者のメールアドレス（4.12.6）。`RETIRED_BY_EXPIRY`では空欄 |
| **X** | **採取日時** | 日時 | **必須** | ISO 8601。**元ファイルを顧客から入手した（Driveで検出した）日時**。仕様20.4が明示的に要求する記録項目であり、R列（台帳登録日時）とは別である（A-9） |
| **Y** | **採取元顧客ID** | 文字列 | **必須** | 顧客マスターA列。**このサンプルの元となった明細を提出した顧客**。`registerSample`はこの顧客に対する認可を実行者へ要求する（B-M12・9.3） |
| **Z** | **匿名化版** | 数値 | **必須** | J列の方式の版。**現在は`1`のみ**。方式と版を分けることで、匿名化規則を改訂したときに旧版のサンプルを識別して再匿名化の対象にできる（A-9・INV-36） |
| **AA** | **匿名化確認者** | 文字列 | 条件付き必須 | **匿名化結果を目視確認して確定したシステム管理者のメールアドレス**（CR-1・判断#20）。`状態=ACTIVE`の行では必須 |
| **AB** | **匿名化確認日時** | 日時 | 条件付き必須 | ISO 8601。同上 |
| **AC** | **期待値生成コードバージョン** | 文字列 | 条件付き必須 | **L〜P列と2.1.20の期待値を生成した時点の`VERSIONS.CODE`**。現在の`VERSIONS.CODE`と異なるサンプルは再ベースラインの候補として一覧に表示する（CR-7・4.12.10）。`状態=PENDING`の行では空欄 |
| **AD** | **期待値dataHash** | 文字列 | 条件付き必須 | **2.1.20の当該サンプルの全行に対する`dataHash`**（5.6.3）。期待値が改竄・欠落していないことの照合と、`corpusFingerprint`（2.1.2.8）の入力に用いる。**スナップショットの対象から2.1.20を外す代わりに、この列で期待値の同一性を担保する**（B-M7）。`状態=PENDING`の行では空欄 |
| **AE** | **回帰進捗** | 文字列 | - | JSON。分割実行中のコーパス回帰の中間結果。`{"runId": 文字列, "result": "PASS"\|"FAIL", "failures": [ … ], "at": ISO8601}`。**完了時に空欄へ戻す**（A-13・4.12.3） |

#### 回帰対象サンプルの定義（INV-35・CR-4・A-8）

**「回帰対象サンプル」とは、次の3条件をすべて満たす2.1.19の行をいう。** コーパス回帰（4.12.3）と`corpusFingerprint`（2.1.2.8）は、この集合だけを対象とする。

| # | 条件 |
|---|---|
| 1 | K列（状態）が`ACTIVE`である |
| 2 | L〜P列（期待値）と2.1.20の当該サンプルの行が存在する（期待値確定済み） |
| 3 | B列（形式ID）がカード形式マスターに存在し、その形式IDに`有効=TRUE`の行が1行ある |

**条件1により、登録の途中で中断して期待値が確定していないサンプル（`PENDING`）は回帰の対象にならない**（CR-4）。Ver.2.2はコーパスへの登録を段階2（下書き生成の前）で行い、その時点で`ACTIVE`としていた。段階4以降で操作者が「このファイルは扱えない」と気づいて中断すると、**形式を持たず期待値も空のサンプルが`ACTIVE`のまま残り、以後すべての形式有効化のコーパス回帰が対象定義も期待値も決まらないまま`PASS`にならなくなる**。Ver.2.3は登録時の状態を`PENDING`とし、`confirmExpectedValues`の成功時にのみ`ACTIVE`へ遷移させる（4.12.11）。

**条件3により、形式が一度も有効化されなかったサンプルも回帰の対象にならない。** 新規登録の途中で放棄された下書きは`ステータス=draft`のまま残り、`有効=TRUE`の行を持たない。

**有効な形式には回帰対象サンプルが常に1件以上存在しなければならない**（仕様24.2・INV-35）。`retireSample`は、当該操作の結果として対象形式の回帰対象サンプルが0件になる場合、`SAMPLE_LAST_OF_FORMAT`として実行を拒否する。**回帰の裏付けを完全に失った形式が`有効=TRUE`のまま残ることを許さない。**

#### 状態遷移（K列）

| 遷移 | 契機 | 実行者 |
|---|---|---|
| （なし）→ `PENDING` | `registerSample`（4.12） | システム管理者 |
| `PENDING` → `ACTIVE` | `confirmExpectedValues`の成功（期待値の確定） | システム管理者 |
| `PENDING` → `RETIRED`（理由`RETIRED_BY_EXPIRY`） | **登録日時（R列）から`SETTINGS.SAMPLE_PENDING_EXPIRE_DAYS`（既定14）を超えても`ACTIVE`にならなかった場合の自動失効**（CR-4） | システム（`expirePendingSamples`。4.12） |
| `PENDING` → `RETIRED`（理由`RETIRED_BY_OWNER`） | `retireSample`（中断した登録の明示的な破棄） | オーナー管理者 |
| `ACTIVE` → `SUPERSEDED` | 同一形式の新しいサンプルが同一の様式を置き換えた場合（4.12.6） | システム管理者 |
| `ACTIVE` → `RETIRED`（理由`RETIRED_BY_OWNER`） | `retireSample`（仕様24.2の除外規定） | オーナー管理者 |

`RETIRED`・`SUPERSEDED`からの復帰は行わない。同じファイルを再び回帰対象にする場合は`registerSample`で新しいサンプルとして登録する。

#### 容量の上限

**`状態`が`ACTIVE`または`PENDING`の行数の合計を`SETTINGS.MAX_CORPUS_SAMPLES`（既定50）の上限とする**（INV-25）。上限に達した状態で新しいサンプルを登録しようとした場合は`SAMPLE_CORPUS_LIMIT_EXCEEDED`とし、オーナー管理者が不要なサンプルを`RETIRED`にするまで登録できない。**`PENDING`を上限に算入するのは、中断した登録が上限枠を占有し続けることを防ぐためである**（自動失効と併せて枠が戻る）。

2.1.20の行数は1サンプルあたり`SETTINGS.SAMPLE_MAX_ROWS_PER_SAMPLE`（**既定1,000**）を上限とし、超える明細を持つファイルはサンプルにできない。**Ver.2.2の既定200行は法人カードの月次明細の規模を下回っており、実運用の代表的な明細をサンプルにできなかった**（B-M6）。**「上限内へ切り出したものを登録する」という運用は廃止する。** 切り出したファイルは合計行・件数行との整合が失われ、往復検証の合格条件6（照合式）と条件8（打切り検査）が本物のファイルに対する検証にならないためである。上限を超えるファイルは`SAMPLE_TOO_LARGE`とし、**`SAMPLE_MAX_ROWS_PER_SAMPLE`の引上げをオーナー管理者が承認する**（引上げ時は下記の容量への影響を再評価する）。

**`SUPERSEDED`・`RETIRED`へ遷移させた時点で、2.1.20の当該サンプルIDの全行を削除する**（B-M7）。削除しないと、2.1.20は失効サンプルの分だけ単調に増え続け、「両シートのセル数は上限が定まる」という主張が成立しない。削除の直前に当該行群の`dataHash`を監査ログ（`SAMPLE_RETIRE`／`SAMPLE`）のJ列（変更前値）へ記録し、削除の事実と範囲を追跡可能にする。**2.1.19の行そのものは削除しない**（採取・匿名化・失効の履歴として残す）。

この規律により、2.1.20の行数は`MAX_CORPUS_SAMPLES × SAMPLE_MAX_ROWS_PER_SAMPLE`＝既定`50 × 1,000 = 50,000`行で上限が定まる（4.37 指標1に算入する。11章の注記参照）。

#### 2.1.19.1 期待年補完集計JSON（P列）のスキーマ

```text
{
  "yearlessRows": 数値,
  "yearInferredRows": 数値,
  "dateReviewRows": 数値,
  "fileLevelBlanked": 真偽,
  "billingMonthStatus": "RESOLVED"|"NOT_FOUND"|"CONFLICT"|"ABSENT_BY_ANSWER"
}
```

| キー | 型 | 必須 | 内容 |
|---|---|---|---|
| `yearlessRows` | 数値 | 必須 | 年を含まない日付を持つ取引の件数 |
| `yearInferredRows` | 数値 | 必須 | 5.1の規則5で年が一意に確定し、**B列予定値が非空**となった取引の件数 |
| `dateReviewRows` | 数値 | 必須 | 要確認`DATE`が立ち、**B列予定値が空欄**となった取引の件数（INV-33） |
| `fileLevelBlanked` | 真偽 | 必須 | 処理ログAJ列の期待値。真＝規則4または規則6dによりファイル単位で空欄化される |
| `billingMonthStatus` | 文字列 | 必須 | 2.1.2.6の`status`の期待値。`ABSENT_BY_ANSWER`は登録回答の`billingMonthAbsent`が真でQ列を持たない形式を表す |

**実測値の正規化（B-M16）**：`extractBillingYearMonth`（4.13）が返す`status`は`RESOLVED`／`NOT_FOUND`／`CONFLICT`の3値だけであり、`ABSENT_BY_ANSWER`を返さない。したがって照合の前に次の読み替えを行う。

| 条件 | 照合に用いる実測値 |
|---|---|
| **カード形式マスターQ列が空欄であり、かつ当該形式のAB列の`billingMonthAbsent`が真**で、実測`status`が`NOT_FOUND` | **`ABSENT_BY_ANSWER`** |
| 上記以外 | 実測`status`をそのまま用いる |

**この読み替えがないと、`billingMonthAbsent`が真の形式は期待値`ABSENT_BY_ANSWER`と実測値`NOT_FOUND`が永久に一致せず、往復検証の合格条件10が必ず不合格になる。** 請求年月の表記がない明細を出すカード会社は実在し、その形式は登録手順を最後まで通れなかった。

**本JSONの5キーは、処理日への依存の有無で照合方法が2つに分かれる。**

| キー | 処理日への依存 | 回帰での照合方法 |
|---|---|---|
| `yearlessRows` | なし | **保存値と完全一致** |
| `billingMonthStatus` | なし | **保存値と完全一致** |
| `yearInferredRows` | **あり**（規則6c・6dでB列が空欄になると減る） | **保存値ではなく、実行時の処理日で5.1を適用した結果と一致** |
| `dateReviewRows` | **あり**（同上） | 同上 |
| `fileLevelBlanked` | **あり**（規則6d） | 同上 |

サンプルの明細日付は`ANONYMIZE_V1`で改変しないため不変だが、処理日は日々進む。**処理日依存の3キーを保存値と突き合わせると、登録の翌月に必ず不合格になる。** これらの保存値は「登録時点でINV-33がどう作用したか」の参考記録として保持し、照合の期待値としては用いない。

**処理日依存の照合方法を必要とするのは、本JSONの3キーと2.1.20のF・K列だけである。** 他のすべての期待値（本シートのL・M・N・O列、**2.1.20のC・D・E・G・H・I・J・L列**）は処理日に依存しないため、**保存値との完全一致**を合格条件とする（4.12.3）。**とりわけ2.1.20 L列（期待導出日）は、年補完の導出結果そのものを処理日非依存の形で保存したものであり、規則1〜5・7の全体を回帰で保護する**（A-5）。

### 2.1.20 形式サンプル期待値

仕様24.2が要求する「全明細について、日付、金額、利用店名、使用用途、除外判定を期待値と照合する」の期待値本体である。**1サンプルの1物理行につき1行**とする。

| 列 | 項目名 | 型 | 必須 | 説明 |
|---|---|---|---|---|
| A | サンプルID | 文字列 | 必須 | 2.1.19 A列 |
| B | 元ファイル行番号 | 数値 | 必須 | 元シート上の絶対物理行番号（CSVは`recordStarts[i]`。INV-12）。A列との組で一意キー |
| C | 出現順 | 数値 | - | ファイル内の有効明細の出現順（0起算）。D列が`EXCLUDED`のときは空欄 |
| D | 判定 | 文字列 | 必須 | `TRANSACTION` / `EXCLUDED`（4.1 `SAMPLE_ROW_JUDGEMENT`） |
| E | 除外根拠 | 文字列 | 条件付き必須 | D列が`EXCLUDED`のとき必須。2.1.2.4の`rules[].id`、または`__ROW_RANGE__`（`excludeRowRanges`による除外）、または`__EMPTY__`（`excludeWhenDateAndAmountEmpty`による除外） |
| F | 期待B列予定値 | 文字列 | - | `YYYY-MM-DD`または空文字列。**空文字列＝INV-33によりB列へ書かないことが期待される行**。D列が`EXCLUDED`のときは空欄。**処理日に依存するため、照合の期待値としては用いない**（下記） |
| G | 期待dateHashKey | 文字列 | - | `YYYY-MM-DD`または`--MM-DD`（5.6.3）。**処理日に依存しない** |
| H | 期待金額 | 数値 | - | 整数円。符号を含む |
| I | 期待元利用店名 | 文字列 | - | 正規化前の値。空欄も期待値になり得るため、I〜J列は「空欄であること」も照合対象とする |
| J | 期待使用用途 | 文字列 | - | 顧客入力値。補完前の値を記録する |
| K | 期待要確認種別 | 文字列 | - | 当該取引に立つことが期待される要確認種別をカンマ区切りで列挙（`DATE` / `AMOUNT` / `ZERO_AMOUNT`）。**`PARTNER`と`PRIOR_YEAR`は本列に含めない**（前者は辞書の状態、後者は顧客区分と対象年度に依存するため） |
| **L** | **期待導出日** | 文字列 | - | **`YYYY-MM-DD`または空文字列。5.1の規則1〜5・7が導出した`CommonTransaction.date`の期待値**（規則6のサニティ検査を適用する**前**の値）。空文字列＝年を一意に確定できず`null`となることが期待される行。D列が`EXCLUDED`のときは空欄。**処理日に依存しないため、保存値との完全一致を要求する**（A-5） |

#### 処理日への依存と照合方法（A-5）

| 列 | 処理日への依存 | 回帰での照合方法 |
|---|---|---|
| C・D・E・G・H・I・J | なし | **保存値と完全一致** |
| **L（期待導出日）** | **なし** | **保存値と完全一致** |
| F（期待B列予定値） | あり（規則6b'・6c・6d） | **保存値ではなく、L列に5.1の規則6を実行時の処理日で適用した結果と一致** |
| K（期待要確認種別） | あり（同上） | 同上 |

**L列の新設がA-5の是正である。** Ver.2.2の回帰は、処理日に依存する期待値（F・K列と2.1.19.1の3キー）を「実行時に5.1を再適用した結果」と比較していた。**これは検査対象そのものを期待値として使う自己参照であり、恒真である。** 加えて、年補完の結果そのもの（`CommonTransaction.date`）はどこにも期待値として保存されていなかった。したがって規則5b（許容窓）・5c（実在性）・5d（一意性）・規則7（2桁年）のいずれをどう壊しても、回帰は合格した。**年補完はこのシステムで最も壊れやすく、壊れたときの被害（誤った日付の自動確定）が最も大きい箇所である。**

L列は処理日に依存しない（5.1「導出と書込の分離」）ため、**保存値との完全一致を要求できる**。これにより規則1〜5・7の全体が回帰で保護される。F列は「L列へ規則6を適用した結果」として導出されるため、L列が守られていれば規則6の実装だけが実行時比較の対象として残る。**規則6は「窓の外か」「処理日より後か」という単純な比較であり、規則5の候補年選択に比べて誤りが混入する余地が小さい。**

F列を保存しておくのは、**登録時点でINV-33がどの行に作用したかを人が確認できるようにするため**である。回帰の期待値としては用いない。

`PARTNER`を期待値に含めないのは、取引先判定が辞書の状態に依存し、辞書は日々変わるためである。**カード形式の回帰が辞書の変更で落ちてはならない。** 取引先判定の回帰は5.14の**辞書フィクスチャ**に対する`runPartnerMatchingVectors()`（4.39）が担う（A-31）。`PRIOR_YEAR`を含めないのは、判定が顧客区分（顧客マスターAJ列）と対象年度（AK列）に依存し、サンプルが特定の顧客に固定されないためである。5.12の回帰は5.15のテストベクトルが担う。

### 2.1.21 承認申請

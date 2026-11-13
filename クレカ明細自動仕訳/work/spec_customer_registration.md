# 「設定」タブの「顧客一覧への登録」と本番の準備 仕様書

作成日：2026-11-12
版：1.0
読者：本仕様だけを読んで実装する実装者（AI を含む）。書いてあることは変えない。書いていないことは安全側で決め、決めたことは全部報告する。
前提：`work/spec_customer_name_from_folder.md`（顧客名を顧客フォルダ名から決める運用関数。本番 `gas-push-127`）。顧客マスターの列は `design_document.md` §2.1.1。

改訂履歴：
- 1.0（2026-11-12）：初版。利用者の依頼と決定（2026-11-12、§1.1）。§10 の 1（別表のタブの年）は利用者の答え「はい」で決定済み。
- 1.1（2026-11-13）：§3.11 に「調べている間の表示」と「止まったときの文言」を足した（利用者の依頼「直して」、2026-11-13。§11 の 9）。§6.2 に regu 15〜17、§7 に R25〜R28。regu 5 の止まる段の確かめを新しい文言に替える。

**この仕様書と、実装・テストには、実在の顧客名・顧客 ID・Drive の ID を書かない。**リポジトリは公開である。テストの名前と ID はすべて架空にする（例：`【代※現金シート】架空 太郎`、`K9001`）。本番の ID は実行時の引数とスクリプトプロパティにだけ置く。

---

## 1. 何を作るか

### 1.1 背景（利用者の依頼と決定、2026-11-12）

- 画面の左「1. 顧客選定」の一覧は顧客マスターの行（C 列が TRUE のもの）である。これは変えない。**足りないのは、顧客マスターへ行を足す画面である。**今は行を足す手段がエディタの関数（`registerTestCustomer`）しかない。
- **依頼：**上のタブ「設定」（今は `81` の `data-coming-soon` のボタン）に「顧客一覧への登録」を作る。**使えるのはオーナーだけ。**
- **雛形は全顧客で 1 つ**（テスト顧客 TEST01 と同じもの）。列の対応・見出し行・用途の一覧・科目の範囲は TEST01 の値を使う。転記シートは雛形と同じフォルダにできるので、全顧客の転記シートが 1 か所（利用者が決めたフォルダ）に集まる。
- **明細ファイルの名前の頭（【済】【要修正】など）は変えてよい。中身は一切変えてはならない。**Excel は一時コピーへ変換して読む（`12_FileReader.gs` `convertXlsxToTemp`）。`PARALLEL_WORK_FOLDER_ID` が空だと、このコピーが顧客フォルダにできる。→ 本番の前に事務所だけの作業用フォルダを設定する（§3.13）。
- **顧客 ID は事務所が決めた ID を使う。**別のスプレッドシート（以下「別表」）の、年度ごとのタブ「R{N}.契約内容」（令和 N 年度）にある。**B 列「取引先コード」＝顧客 ID、C 列＝顧客名。**見出しの行は決まっていない。**使うタブは明細と同じ年のもの**（令和 N 年分の明細 → `R{N}.契約内容`。翌年 1〜3 月に令和 N 年分を登録する時も `R{N}`。2026-11-12 利用者「はい」）。
- 表示名（B 列）は、顧客フォルダ名から頭の【…】を外したもの。
- 個人だけを先に作る。法人は法人用の雛形ができてから（画面では選べるように見せて、押せなくする）。

### 1.2 本仕様がすること

1. **オーナーだけの認可の入口** `authorizeOwner(operation)` を `03` に足す（§3.1）。今の `authorize` は、有効な顧客が 0 件だとオーナーでも拒む。
2. **登録の部品**を新しいファイル `src/59_CustomerRegistration.gs` に作る（§3.2〜§3.9）。
   - 顧客フォルダの一覧（共通フォルダ → 個人 → 顧客フォルダ）。
   - 明細フォルダを決まった道（☆資料共有フォルダ → 令和N年分 → 経費 → クレジットカード支払い分…）で自動で探し、1 つに決まらない段だけ利用者に選ばせる。
   - 別表から顧客 ID を引く。
   - 登録の要求を**サーバーで全部確かめ直してから**、顧客マスターへ 1 行を書く。
3. **Web アプリの入口 3 つ**を `80` に足す（§3.10）。
4. **画面**：「設定」タブに登録の画面を作る（§3.11）。
5. **雛形へ直接書く取込を止める**（`71`、§3.12）。雛形を全顧客で共有すると、転記先の複製を渡さない取込（定期取込・運用関数）が雛形へ直接書き、顧客の取引が 1 冊に混ざる。
6. **準備用の関数** `opsPrepareCustomerRegistration(options, apply)` を `59` に作る（§3.13）：既定は見るだけ。`apply === true` のときだけ、作業用フォルダを作って設定し、TEST01 の雛形を本番の置き場へ写してシステム列を空にし、登録に使う値（プロファイル）をスクリプトプロパティへ書く。

### 1.3 変えないもの・しないこと

- 顧客一覧（`webAppBootstrap`）の出し方。マスターの行だけが出る。
- 顧客マスターの読み方（`02` の `customerFromRow_`・`validateCustomerValues_` は 1 文字も変えない。**使うだけ**）。
- 登録した後の B 列（顧客名）の変更。**画面からは変えられない**（転記シート名 `<B>_yyyyMMdd-HHmm` の照合に使うため、design_document §2.1.1 の B 行）。
- 法人の登録・年度の切り替え（D 列を翌年の明細フォルダへ付け替える）・登録の取消し。本仕様の外。
- **`97_Ops.gs` は開かない・書かない**（文字列の中に生の NUL バイトがある）。`97` の関数を呼ぶこともしない（§9 の 11）。
- `02`・`04`・`05`・`43`・`61`・`design_document.md`（文書は Claude が後で直す）。
- 顧客フォルダ・明細フォルダ・明細ファイルへの書込。**登録の画面は顧客の Drive を読むだけ**（§4 の S2）。

---

## 2. 言葉と前提

### 2.1 Drive の階層（本番で確かめたもの。名前は架空）

```
共通フォルダ（スクリプトプロパティ CUSTOMER_ROOT_FOLDER_ID）
├ 個人                                   ← 区分のフォルダ
│ ├ 【代※現金シート】架空 太郎            ← 顧客フォルダ（表示名「架空 太郎」）
│ │ └ ☆資料共有フォルダ                   ← 資料共有の段（無い顧客もある）
│ │   ├ 令和8年分                          ← 年の段（横に 過年度分・年末調整 など）
│ │   │ ├ 経費                             ← 経費の段（横に 収入・決算 など）
│ │   │ │ └ クレジットカード支払い分※カード毎にフォルダを作成してください。  ← 明細フォルダ（D 列）
│ │   │ │   ├ AUPAY                         ← カードのフォルダ（取込が読む）
│ │   │ │   └ …
└ 法人
```

- **明細フォルダ（D 列）の直下のフォルダがカードとして読まれる。**だから D は必ず「経費の段の子」でなければならない。年の段や経費の段を D にすると、収入・決算などのフォルダの明細までカードとして読む（§3.5 で深さを固定する理由）。
- 年の段の `N` から対象年度（AK）を決める：**AK ＝ N ＋ 2018**（令和 8 年分 → 2026）。

### 2.2 新しく使うスクリプトプロパティ

`SETTINGS`（`00`）には足さない。`CUSTOMER_ROOT_FOLDER_ID` と同じく `PropertiesService.getScriptProperties().getProperty(…)` で直接読む。

| キー | 中身 | 書くもの |
|---|---|---|
| `CUSTOMER_TEMPLATE_PROFILE_INDIVIDUAL` | 個人の登録に使う値（プロファイル）。JSON（§2.4） | 準備用の関数（§3.13） |
| `CUSTOMER_ID_SOURCE_SPREADSHEET_ID` | 別表のスプレッドシート ID | 準備用の関数 |
| `PARALLEL_WORK_FOLDER_ID`（既存のキー。`SETTINGS` にある） | 作業用フォルダの ID | 準備用の関数 |
| `PRODUCTION_MASTER_SPREADSHEET_ID`（既存のキー） | 今のマスターの ID。効き目は障害注入の自己防衛（`99` `faultInjectionPoint`・`05` 検査 10）だけ | 準備用の関数 |

`CUSTOMER_TEMPLATE_PROFILE_CORPORATE` は将来の法人用に名前だけ取っておく（§3.12 のガードは両方を見る）。

### 2.3 顧客マスターに書く 1 行（45 列）

| 列 | 添字 | 書く値 | 出どころ |
|---|---|---|---|
| A | 0 | 顧客 ID（文字列） | 別表の B 列（§3.6）。NFKC にして前後の空白を除いたもの |
| B | 1 | 顧客名（文字列） | 顧客フォルダ名から頭の【…】を外した名前。登録の時だけ利用者が直せる（§3.3） |
| C | 2 | **まず `false`、確かめた後に `true`**（真偽値） | §3.8 |
| D | 3 | 明細フォルダの ID | §3.5 で決め、§3.7 で確かめ直したもの |
| E | 4 | `''` | — |
| F | 5 | 雛形の ID | プロファイルの `templateId` |
| G | 6 | `''` | — |
| H・I・J〜O・P | 7〜15 | プロファイルの値 | TEST01 の行の写し |
| Q・R | 16・17 | 実行者（オーナー）のメールアドレス（前後の空白を除き小文字） | `authorizeOwner` の戻り値 |
| S | 18 | `0` | `registerTestCustomer` と同じ |
| T | 19 | `''` | |
| U | 20 | プロファイルの値 | |
| V〜AC | 21〜28 | V `''`・W `''`・X `0`・Y `0`・Z `''`・AA `''`・AB `''`・AC `''` | `registerTestCustomer` と同じ |
| AD〜AI | 29〜34 | プロファイルの値 | |
| AJ | 35 | `'INDIVIDUAL'` | 区分は個人だけ |
| AK | 36 | `N + 2018`（**数値**） | 年の段の名前（§3.5） |
| AL〜AS | 37〜44 | プロファイルの値 | |

### 2.4 プロファイル（`CUSTOMER_TEMPLATE_PROFILE_INDIVIDUAL` の JSON）

```json
{
  "version": 1,
  "category": "INDIVIDUAL",
  "templateId": "<本番の雛形の ID>",
  "sourceCustomerId": "TEST01",
  "capturedAt": "<ISO 8601>",
  "columns": {"H": …, "I": …, "J": …, "K": …, "L": …, "M": …, "N": …, "O": …, "P": …,
              "U": …, "AD": …, "AE": …, "AF": …, "AG": …, "AH": …, "AI": …,
              "AL": …, "AM": …, "AN": …, "AO": …, "AP": …, "AQ": …, "AR": …, "AS": …}
}
```

- `columns` の鍵は**ちょうどこの 24 個**。値は TEST01 の行のセルの値そのまま（数値は数値、JSON の列は文字列、空は `''`）。
- 読むときの検査（`registrationProfile_()`）：JSON として読める・`version === 1`・`category === 'INDIVIDUAL'`・`templateId` が空でない文字列・`columns` の鍵が 24 個ちょうど（多くても少なくても不正）。さらに、§2.3 の行を架空の A・B・D・AK で組み、`customerFromRow_` → `validateCustomerValues_` を通ること。どれかが駄目なら `PROFILE_INVALID`。
- 文字列の長さは 8000 バイト以下（スクリプトプロパティの 1 値の上限 9 KB の手前）。超えたら準備用の関数が書かずに止まる。

---

## 3. 設計

### 3.1 オーナーだけの認可 `authorizeOwner(operation)`（`src/03_Authorization.gs` に足す）

```
function authorizeOwner(operation)
  → {userEmail, normalizedEmail, ownerEmail}
```

1. `resolveActor_()` で実行者を取る。取れなければ `denyAuthorization_(ACTOR_UNKNOWN, …)` を投げる。
2. `masterOwnerEmail_()` と比べる。オーナーが取れない、または違えば `denyAuthorization_(ROLE_INSUFFICIENT, context)` を投げる。`context` は `{userEmail, requiredRole: 'OWNER_ADMIN', actualRole: null, customerId: null, operation}`。
3. **有効な顧客の数を見ない**（`getActiveCustomers` を呼ばない）。1 人目を登録する時にマスターの有効な行が 0 件でも使える。
4. 既存の `authorize`・`getUserRole`・`OPERATION_ROLES_` などは変えない。

### 3.2 準備ができているか `registrationReadiness_()`（59）

次を順に見て、足りないものを全部 `missing`（コードの配列）に入れて返す。1 つでもあれば登録の画面は一覧も出さず、登録の要求は何も書かずに `NOT_READY` で返る。

| コード | 条件 |
|---|---|
| `CUSTOMER_ROOT_FOLDER_ID` | プロパティが空 |
| `CATEGORY_FOLDER` | 共通フォルダの直下に、名前の鍵（§3.3）が `個人` の子がちょうど 1 つ無い（開けないときも） |
| `PARALLEL_WORK_FOLDER_ID` | `loadSettingsFromProperties()` の後の `SETTINGS.PARALLEL_WORK_FOLDER_ID` が空、または `SETTINGS.SAMPLE_CORPUS_FOLDER_ID` と同じ |
| `CUSTOMER_TEMPLATE_PROFILE_INDIVIDUAL` | プロパティが空 |
| `PROFILE_INVALID` | プロパティはあるが §2.4 の検査に通らない |
| `CUSTOMER_ID_SOURCE_SPREADSHEET_ID` | プロパティが空 |

### 3.3 名前の扱い

- **表示名の案** `registrationDisplayName_(folderName)`：頭にある `【…】` を（続けていくつあっても）外し、前後の空白（全角を含む）を除く。`/^(?:[\s　]*【[^】]*】)+/` を消してから trim。例：`【代※現金シート】架空 太郎` → `架空 太郎`。中の空白や字の幅は変えない。
- **照合の鍵** `registrationNameKey_(value)`：表示名の案にしてから `normalize('NFKC')`、空白（全角を含む）を全部除く。用途は 3 つ：別表の名前との照合（§3.6）・B 列の重複の検査・一覧の「登録済み」の印。
- **B 列に書く名前の検査** `registrationNameProblem_(name, masterRows)`（登録の時に利用者が直した名前にも同じ検査をする）。前後の空白を除いた値で：

| コード | 条件 |
|---|---|
| `NAME_EMPTY` | 空 |
| `NAME_TOO_LONG` | 50 文字を超える |
| `NAME_INVALID_CHAR` | 制御文字（U+0000〜U+001F・U+007F）を含む |
| `NAME_RESERVED_SUFFIX` | `/_\d{8}-\d{4}$/` に当たる（転記シート名の形と紛れる） |
| `NAME_DUPLICATE` | マスターのどれかの行（有効・無効を問わない）の B と、照合の鍵が同じ |

### 3.4 顧客フォルダの一覧

共通フォルダ → 区分のフォルダ（§3.2 の `個人`）の直下のフォルダを全部、名前・ID の順に並べて返す（`diagSortedEntries_` と同じ並べ方。ただし `97` は呼ばないので 59 に同じ働きの関数を書く）。1 件ずつ：

```
{folderId, folderName（元の名前）, displayName（§3.3 の案）, registered}
```

`registered`：照合の鍵がマスターのどれかの行の B の鍵と同じなら `true`（画面では選べない）。中のファイルは読まない。

### 3.5 明細フォルダの探し方 `registrationResolveStatementFolder_(customerFolder, picks)`

`picks` は `{shared, year, accounting, statement}`（どれも省略可。値はフォルダ ID の文字列）。顧客フォルダから 1 段ずつ、**直下の子だけ**から選ぶ（`diagChooseChildFolder_` と同じ考え方）。名前の比べ方はどれも照合の鍵（NFKC・空白なし）。

| 段 | 名前の型 | 型に当たる子が 0 | 1 | 2 以上 | `picks` で選べるもの |
|---|---|---|---|---|---|
| 資料共有 `shared` | `/資料共有/` | **この段は無い**として、顧客フォルダのまま次の段へ | 自動で入る | `NEED_CHOICE`（型に当たる子だけを選ばせる） | 型に当たる直下の子だけ |
| 年 `year` | `/^令和(\d{1,2})年分$/` | `STOPPED`・`YEAR_FOLDER_NOT_FOUND`（子の名前を返す） | 自動で入る | `NEED_CHOICE`（型に当たる子だけ） | 型に当たる直下の子だけ |
| 経費 `accounting` | `/経費\|経理/` | `NEED_CHOICE`（全部の子） | 自動で入る | `NEED_CHOICE`（全部の子） | 直下の子どれでも |
| 明細 `statement` | `/クレジット\|クレカ\|カード/` | `NEED_CHOICE`（全部の子） | 自動で入る | `NEED_CHOICE`（全部の子） | 直下の子どれでも |

- `picks` に値があれば、その段は型より `picks` を先に使う。`picks` の ID がその段の直下の子に無い、または「選べるもの」に当たらなければ `STOPPED`・`FOLDER_STRUCTURE`。
- 子が 1 つも無い段は `STOPPED`・`NO_CHILD_FOLDERS`。
- **年の段の `N` は、選んだフォルダの名前からだけ取る。**型に当たらないフォルダを年として選ぶ道は無い（AK を推測しない）。
- 年の段が自動で 1 つに決まったときも、画面の確認で「令和 N 年分（YYYY 年）」を大きく見せる（§3.11）。
- 決まったら：`{status: 'READY', path: [段の名前…], statementFolderId, yearFolderId, reiwaYear: N, fiscalYear: N + 2018, cardFolders: [明細フォルダの直下のフォルダ名。名前順、最大 50]}`。カードのフォルダが 0 なら `cardFolderWarning: 'NO_CARD_FOLDERS'` を付ける（止めない）。

### 3.6 別表から顧客 ID を引く `registrationContractEntries_(reiwaYear)`

1. タブ名は `'R' + N + '.契約内容'`（例 `R8.契約内容`）。別表の各タブの名前を照合の鍵（NFKC・空白なし）にして比べ、ちょうど 1 つ当たるタブを使う。0 なら `CONTRACT_TAB_NOT_FOUND`、2 以上も `CONTRACT_TAB_NOT_FOUND`。開けなければ `CONTRACT_UNREADABLE`。
2. そのタブの B:C を **`FORMATTED_VALUE`** で 1 回で読む（`Sheets.Spreadsheets.Values.get`。画面に見えている形で読む ── 先頭の 0 を失わない）。
3. 上から 30 行のうち、B の照合の鍵が `取引先コード` の最初の行を見出しとする。無ければ `CONTRACT_HEADER_NOT_FOUND`。
4. 見出しより下の行のうち、B が空でない行を 1 件ずつ：`{customerId: NFKC して前後の空白を除いた B, name: C（前後の空白を除く）, rowNumber}`。
5. 1 件ずつ使えるかを決める（`usable` と `problem`）：

| `problem` | 条件 |
|---|---|
| `ID_FORMAT` | `customerId` が `/^[0-9A-Za-z][0-9A-Za-z_-]{0,31}$/` に当たらない |
| `ID_REPEATED_IN_CONTRACT` | 同じ `customerId`（大文字小文字を区別しない）が別表のこのタブに 2 行以上 |
| `ID_DUPLICATE` | マスターのどれかの行の A と同じ（NFKC・前後の空白を除き、大文字小文字を区別しない） |

6. 名前の照合：顧客フォルダの照合の鍵と、`name` の照合の鍵が同じ行。**使える行が**ちょうど 1 つなら `MATCHED`、0 なら `NONE`、2 以上なら `MULTIPLE`。
7. 返す形：`{status, tabName, matchedCustomerId（MATCHED のときだけ）, entries: [{customerId, name, usable, problem}]}`。`entries` は全部（画面で選び直せるように）。**Logger にも監査にも `entries` を出さない**（事務所の顧客名簿である）。

### 3.7 登録の要求をサーバーで確かめ直す `registrationVerifyRequest_(request)`

画面から来る値は信じない。`request = {category, customerFolderId, statementFolderId, customerId, customerName}`。どれも文字列でなければ `TypeError`。

1. `category === 'INDIVIDUAL'` でなければ `CATEGORY_NOT_AVAILABLE`。
2. §3.2 が揃っていなければ `NOT_READY`。
3. **D から親をたどって道を確かめる**（`getParents()` が親を 1 つだけ返すこと。2 つ以上なら `FOLDER_STRUCTURE`）。たどった並びが、次の 2 つのどちらかと**ちょうど**同じでなければ `FOLDER_STRUCTURE`：
   - D → 経費の段 → 年の段 → 資料共有の段 → 顧客フォルダ → 個人 → 共通フォルダ
   - D → 経費の段 → 年の段 → 顧客フォルダ → 個人 → 共通フォルダ
   確かめること：顧客フォルダの ID が `request.customerFolderId`・個人の段の鍵が `個人`・共通フォルダの ID が `CUSTOMER_ROOT_FOLDER_ID`・年の段の名前が年の型に当たる（ここで `N` を決める）・資料共有の段があればその名前が `/資料共有/` に当たる。経費の段と D の名前は問わない（利用者が選び直せるため）。
4. D の重複：マスターのどれかの行（有効・無効を問わない）の D が同じなら `FOLDER_ALREADY_REGISTERED`。3 でたどった道の ID（D より上の全部）に、どれかの行の D が入っていれば `FOLDER_OVERLAPS`（既に登録した顧客の明細フォルダの中を、別の顧客として登録させない）。
5. D が `SETTINGS.SAMPLE_CORPUS_FOLDER_ID` または `SETTINGS.PARALLEL_WORK_FOLDER_ID` と同じなら `FOLDER_STRUCTURE`。
6. 顧客 ID：§3.6 を `N` で引き直し、`request.customerId` を NFKC・前後の空白を除いた値と、大文字小文字を区別して同じ `customerId` の行を探す。無ければ `ID_NOT_IN_CONTRACT`。その行が `usable` でなければその `problem`。**手で打った ID は通らない**（別表にある ID だけ）。
7. 顧客名：§3.3 の `registrationNameProblem_`。
8. プロファイルで §2.3 の行を組み、`customerFromRow_(row, 0)` → `validateCustomerValues_` を通す。通らなければ `PROFILE_INVALID`。

返す値：`{ok: true, row（45 個）, customerId, customerName, statementFolderId, fiscalYear, reiwaYear}` または `{ok: false, code}`。

### 3.8 書く手順 `registerCustomer_(request)`（全部を 1 つの `withScriptLock_` の中で）

ロックの外：`authorizeOwner('WEBAPP:顧客の登録')`・`loadSettingsFromProperties()`・§3.7（Drive と別表の読みはロックの外で済ませ、ロックを短くする）。

ロックの中：

1. マスターの行を **Sheets API で**読み直す（`Sheets.Spreadsheets.Values.get` で `'顧客マスター'!A:AS` を `UNFORMATTED_VALUE`。ロックの外で `SpreadsheetApp` が読んだ値を使い回さないため）。§3.7 の 4（D の重複・重なり。重なりは 3 でたどった道の ID を使い回す）・6 のうち `ID_DUPLICATE`・7 のうち `NAME_DUPLICATE` を**今の行で**もう一度確かめる。外で確かめた後に別の登録が入っていれば、ここで止まる。
2. §3.9（同じ要求の 2 回目）に当たれば、何も書かずに返す。
3. 書く行の番号 = 1 で読んだ値の行数 + 1（Sheets API は右下の空の行を返さない。1 行目は見出し）。`ensureSheetWidth_(sheet, 45)`・`ensureRowExists_(sheet, rowNumber)`。
4. **監査を先に書く**：`appendAuditRowsUnlocked_([{type: 'CUSTOMER_REGISTER', actor, targetType: 'CUSTOMER', targetId: customerId, customerId, before: '', after: {row: rowNumber, A, B, D, F, AJ, AK}, reason: 'WEBAPP'}])` → `SpreadsheetApp.flush()`。監査が書けなければ例外（`REQUIRED_LOG_WRITE_FAILED`）で止まり、マスターには何も書かない。
5. 行を **C 列 `false`** で書く：`Sheets.Spreadsheets.Values.update({values: [row]}, masterId, "'顧客マスター'!A{n}:AS{n}", {valueInputOption: 'RAW'})`。**`RAW` で書く**（`SpreadsheetApp` の `setValues` は文字列を解釈し、`0012` を数値 12 にする）。
6. **読み返して確かめる。読み返しも Sheets API で行う**（`Sheets.Spreadsheets.Values.batchGet` で `A:A` と `A{n}:AS{n}` を `UNFORMATTED_VALUE` で 1 回。1 で `SpreadsheetApp` が読んだ値を、同じ実行の中で読み直すと古い値が返りうるため）：A 列で `customerId`（NFKC・大文字小文字を区別しない）の行がちょうど 1 つで、それが `rowNumber`・45 個のセルが書いた値と同じ（数値は数値、真偽値は真偽値、文字列は文字列として比べる。返ってこない右端のセル・`''`・未定義は同じとみなす）・読み返した 45 個を `customerFromRow_` → `validateCustomerValues_` に通せる。どれか駄目なら `WRITE_VERIFY_FAILED`（C は `false` のまま。§4 の S3）。
7. C 列だけを `true` にする（`RAW`、`'顧客マスター'!C{n}`）。Sheets API で読み返して `true` でなければ `WRITE_VERIFY_FAILED`。
8. 返す：`{ok: true, customerId, customerName, rowNumber, alreadyRegistered: false}`。

5〜7 で例外・`WRITE_VERIFY_FAILED` になったら、監査をもう 1 行だけ試す（`type: 'CUSTOMER_REGISTER'`・`after: {row, failed: コード}`・`reason: 'WEBAPP_FAILED'`。これが書けなくても元のエラーを返す）。返す値は `{ok: false, code: 'WRITE_VERIFY_FAILED', rowNumber}`。**書きかけの行を消したり直したりはしない**（無効のまま残す。利用者に知らせる）。

### 3.9 同じ要求の 2 回目

通信が切れて画面が同じ要求を送り直すことがある。ロックの中の 1 で、A が同じ行が 1 つだけあり、その行が「C `true`・B・D・F・AJ・AK が今回の値と同じ」なら、**何も書かずに** `{ok: true, customerId, customerName, rowNumber, alreadyRegistered: true}` を返す。A が同じでもどれかが違えば `ID_DUPLICATE`。

### 3.10 Web アプリの入口（`src/80_WebApp.gs`）

どれも `webAppInvoke_` で包み、最初に `authorizeOwner(…)` を呼ぶ（認可に落ちたら例外のまま。画面は既存のとおり文言を出す）。中身は 59 の関数を呼ぶだけにする。

| 関数 | 引数 | 返す値 |
|---|---|---|
| `webAppRegistrationStart()` | なし | `{ready, missing: [コード…], categories: [{key: 'INDIVIDUAL', label: '個人', enabled: true}, {key: 'CORPORATE', label: '法人', enabled: false}], customerFolders: [§3.4 の形…]}`。`ready === false` のとき `customerFolders` は `[]` |
| `webAppRegistrationInspect(customerFolderId, picks)` | 顧客フォルダの ID・§3.5 の `picks` | 顧客フォルダが個人の直下に無ければ `{status: 'STOPPED', code: 'FOLDER_STRUCTURE'}`。それ以外は §3.5 の結果。`READY` のときはさらに `proposedName`（§3.3 の案）・`nameProblem`（`registrationNameProblem_` の結果か `null`）・`folderProblem`（§3.7 の 4・5 のコードか `null`）・`contract`（§3.6 の結果。別表のエラーは `contract.status` にコードを入れる）を付ける |
| `webAppRegisterCustomer(request)` | §3.7 の `request` | §3.8 の結果。`{ok: false, code}` は例外にしない（画面がコードで文言を出す） |

`authorizeOwner` に渡す `operation`：`'WEBAPP:顧客登録の一覧'`・`'WEBAPP:顧客登録の下調べ'`・`'WEBAPP:顧客の登録'`。

`webAppRegistrationStart`・`webAppRegistrationInspect` は**何も書かない**（マスター・監査・Drive・プロパティのどれにも）。拒否のときの監査（`denyAuthorization_` の `PERMISSION`）だけは既存のとおり書かれる。

### 3.11 画面（`src/81_WebAppUi.html`）

**ナビ：**「クレカ取込・記帳」に `id="nav-import"`、「設定」に `id="nav-settings"` を付け、「設定」から `data-coming-soon` を外す（ほかの 3 つは今のまま）。`bootstrap()` で `state.isOwner = result.isOwner === true` を持つ。

- 「設定」を押す：`isMutationBusy()` なら何もしない。オーナーでなければ `showNotice('この画面はオーナーだけが使えます。', 'info')` だけ（サーバーを呼ばない）。オーナーなら `.steps` と `main.workspace` を隠し、`#settings-panel` を出して「設定」に `active` を付ける。開くたびに `webAppRegistrationStart` を 1 回呼ぶ。
- 「クレカ取込・記帳」を押す、またはパネルの［クレカ取込・記帳へ戻る］：パネルを隠して元に戻す。登録の呼出しの最中は戻れない（ボタンを押せなくする）。

**パネル `#settings-panel`（`class="panel"`、見出し「顧客一覧への登録」）の中身。上から順に、前の段が決まるまで次の段は出さない：**

1. **区分**：ラジオ「個人」（選択済み）・「法人」（押せない。横に「法人用の雛形ができてから使えます。」）。
2. **顧客フォルダ**：検索欄（表示名・元の名前の部分一致。照合の鍵で比べる）と一覧。行は表示名を大きく、元の名前を小さく。`registered` の行は押せず「登録済み」と出す。件数を出す。
3. **明細フォルダ**：顧客フォルダを選ぶと `webAppRegistrationInspect(folderId, {})` を呼ぶ。
   - `NEED_CHOICE`：「<段の名前>を選んでください」と、ここまでの道・選択肢を出す。選ぶと、それまでの `picks` に足して呼び直す。
   - `STOPPED`：下の「止まったときの文言」のとおりに出す。先へ進めない。
   - 返事を待つ間：下の「調べている間の表示」のとおり「調べています…」を出す。
   - `READY`：道を「☆資料共有フォルダ › 令和8年分 › 経費 › クレジットカード支払い分…」の形で出し、**「対象年度：令和 N 年分（YYYY 年）」を大きく**出す。カードのフォルダ名を並べる（0 なら「カードのフォルダがまだありません。登録はできますが、取込むものがありません。」）。`folderProblem` があればその文言を出して先へ進めない。
4. **顧客 ID**：`contract.status` が
   - `MATCHED`：「別表の <タブ名> から：<ID>　<名前>」を出す。［選び直す］で 5 の一覧を開ける。
   - `NONE`・`MULTIPLE`：「別表で 1 つに決まりませんでした。選んでください。」と一覧（検索欄つき。`usable` でない行は押せず理由を出す）。
   - エラーのコード：その文言を出して先へ進めない。
5. **顧客名（表示名）**：入力欄。初めは `proposedName`。下に「登録した後は変えられません（転記シートの名前に使うため）。」。入力のたびに §3.3 の検査のうち `NAME_DUPLICATE` 以外を画面でも行い、文言を出す（正はサーバー）。`nameProblem` が `NAME_DUPLICATE` なら、その文言を出す（名前を変えれば消す。重複の正否はサーバーが決める）。
6. **［登録する］**：区分が個人・3 が `READY` で `folderProblem` なし・4 で使える ID が 1 つ決まっている・5 に画面の検査の問題なし、のときだけ押せる。押すと既存の `formatConfirm(title, text)` で確かめる（題「顧客を登録する」。本文に 顧客名・顧客 ID・区分 個人・対象年度 令和 N 年分（YYYY 年）・明細フォルダの道・「登録した後は顧客名を変えられません。」）。［はい］で `webAppRegisterCustomer({category: 'INDIVIDUAL', customerFolderId, statementFolderId, customerId, customerName})` を**1 回だけ**呼ぶ（呼出し中はパネルの入力とボタンを全部押せなくする）。
   - `ok: true`：`showNotice('「<名前>」を顧客一覧に登録しました（顧客 ID <ID>）。', 'success')`。`alreadyRegistered` なら「既に登録されていました。」を足す。`bootstrap()` を呼んで左の一覧を読み直し、パネルを 2 の状態に戻して `webAppRegistrationStart` を呼び直す。
   - `ok: false`：コードの文言を出す。`WRITE_VERIFY_FAILED` は行番号も出す。
   - 例外：`failureMessage(error)` を出す。

**呼出し中の印：**`state.registrationBusy` を 3 つの入口の呼出し中だけ `true` にし、`isMutationBusy()` の条件に足す（登録の最中に取込などを始めない）。

**古い返事を捨てる：**`state.registrationGeneration` を、顧客フォルダを選び直す・パネルを開き直すたびに 1 増やし、返ってきた返事の世代が今と違えば捨てる。

**表示は全部 `textContent`**（フォルダ名・別表の名前に `<` などがあってもそのまま字として出す。`innerHTML` に名前を入れない）。

**調べている間の表示（1.1。利用者の依頼、2026-11-13）：**下調べは本番で 3〜5 秒かかり、その間に何も出ないと「選べるけど登録できない」に見えた（§11 の 9）。文言は `TEXT.registration.checking = '調べています…'` の 1 つ。

1. **パネルを開いて `webAppRegistrationStart` の返事を待つ間：**`#registration-missing` を出し（`hidden = false`）、中身を「調べています…」の 1 行だけにする。2〜5 の段（`#registration-folders-section`・`#registration-statement-section`・`#registration-contract-section`・`#registration-name-section`）は隠し、`#registration-folder-list` は空、［登録する］は押せない。**前に開いたときの一覧（`state.registrationReady` が `true` のまま）でも同じ**（古い一覧を押させない）。返事か例外が来たら今までどおりの表示に戻る。
2. **`webAppRegistrationInspect` の返事を待つ間**（顧客フォルダを選んだ後・段を選んだ後のどちらも）：`#registration-statement-section` を出し、`#registration-statement-message` を「調べています…」の 1 行だけにする（class は `muted`）。道・年度・カード・選択肢（`#registration-statement-path`・`-year`・`-cards`・`-choices`）は空。4・5 の段は隠れ、［登録する］は押せない。返事か例外が来たら今までどおりの表示に戻る（例外のときは「調べています…」を残さない）。
3. **待っているかは世代で持つ。**`state.registrationStartingGeneration`・`state.registrationInspectingGeneration`（初めは `null`）に、呼び出したときの `state.registrationGeneration` を入れる。「調べています…」を出すのは、その値が今の `state.registrationGeneration` と同じときだけ。返事・例外の `finally` では、**値が自分の世代と同じときだけ** `null` に戻す（顧客フォルダ A の下調べ中に B を選び、A の返事が後から来ても、B の「調べています…」を消さない）。
4. 2〜5 の段の中のボタン（顧客フォルダの一覧・段の選択肢）は、下調べの間も今までどおり押せる（選び直せる。古い返事は世代で捨てる）。

**止まったときの文言（1.1。利用者の依頼、2026-11-13）：**`STOPPED` の表示だけを次に替える。`TEXT.registrationCodes` の表（下）は変えない（登録の `ok: false` など、ほかの所は今の表の文言のまま）。全部 `textContent`。

1. **1 行目**（`#registration-statement-message`。`STOPPED` のときだけ class を `settings-warning` にし、ほかのときは `muted` に戻す）：
   - `YEAR_FOLDER_NOT_FOUND`：道（`path`）が空なら「この顧客フォルダの中に「令和N年分」のフォルダがありません。」。道があれば「「<道の最後の名前>」の中に「令和N年分」のフォルダがありません。」。
   - `NO_CHILD_FOLDERS`：道が空なら「この顧客フォルダの中にフォルダがありません。」。道があれば「「<道の最後の名前>」の中にフォルダがありません。」。
   - ほかのコード：今の表の文言（`registrationCodeText(code, {reiwaYear})`）。
2. **2 行目**（`childNames` が 1 つ以上のとき。`#registration-statement-choices` に `muted` の 1 行）：「直下にあるフォルダ：<名前を「、」でつないだもの>」。名前を 1 行ずつ並べる今の表示は、この 1 行に替える。
3. **3 行目**（`YEAR_FOLDER_NOT_FOUND`・`NO_CHILD_FOLDERS` のとき。`#registration-statement-choices` に `muted` の 1 行）：「明細フォルダは、顧客フォルダの中を「（☆資料共有フォルダ ›）令和N年分 › 経費 › クレジットカード…」の順にたどって探します。この形になっていないフォルダは登録できません。」
4. `missing`（`NOT_READY` のとき）は、今までどおり 1 つずつ文言を並べる（2 行目・3 行目より前）。
5. 文言は `TEXT.registration` にまとめる（例：`stoppedYear(lastName)`・`stoppedNoChild(lastName)`・`childList(names)`・`stoppedHint`。`lastName` が空なら「この顧客フォルダ」の文）。

**`gasCall` に 3 行足す**（`webAppRegistrationStart`・`webAppRegistrationInspect(args[0], args[1])`・`webAppRegisterCustomer(args[0])`）。

**文言（`TEXT` にまとめる）：**

| コード | 文言 |
|---|---|
| `CUSTOMER_ROOT_FOLDER_ID` | 共通フォルダの場所が設定されていません。 |
| `CATEGORY_FOLDER` | 共通フォルダの下に「個人」フォルダが 1 つに決まりません。 |
| `PARALLEL_WORK_FOLDER_ID` | 作業用フォルダが設定されていません（Excel の一時コピーが顧客フォルダにできてしまうため、登録できません）。 |
| `CUSTOMER_TEMPLATE_PROFILE_INDIVIDUAL` | 個人用の雛形が準備されていません。 |
| `PROFILE_INVALID` | 個人用の雛形の設定が壊れています。 |
| `CUSTOMER_ID_SOURCE_SPREADSHEET_ID` | 顧客 ID の別表が設定されていません。 |
| `NOT_READY` | 登録の準備が済んでいません。 |
| `CATEGORY_NOT_AVAILABLE` | この区分はまだ登録できません。 |
| `FOLDER_STRUCTURE` | 選んだフォルダの場所が想定と違います。選び直してください。 |
| `YEAR_FOLDER_NOT_FOUND` | 「令和N年分」のフォルダが見つかりません。 |
| `NO_CHILD_FOLDERS` | この段にフォルダがありません。 |
| `FOLDER_ALREADY_REGISTERED` | この明細フォルダは別の顧客で登録済みです。 |
| `FOLDER_OVERLAPS` | この明細フォルダは、登録済みの顧客の明細フォルダの中にあります。 |
| `CONTRACT_UNREADABLE` | 顧客 ID の別表を開けません。 |
| `CONTRACT_TAB_NOT_FOUND` | 別表に、この年度のタブ（R{N}.契約内容）が 1 つに決まりません。 |
| `CONTRACT_HEADER_NOT_FOUND` | 別表のタブの B 列に「取引先コード」の見出しが見つかりません。 |
| `ID_NOT_IN_CONTRACT` | この顧客 ID は別表にありません。 |
| `ID_REPEATED_IN_CONTRACT` | この顧客 ID は別表に 2 回以上あります。別表を直してください。 |
| `ID_FORMAT` | この顧客 ID は使えない形です（英数字・ハイフン・下線だけ、32 文字まで）。 |
| `ID_DUPLICATE` | この顧客 ID は顧客一覧に登録済みです。 |
| `NAME_EMPTY` | 顧客名を入れてください。 |
| `NAME_TOO_LONG` | 顧客名は 50 文字までです。 |
| `NAME_INVALID_CHAR` | 顧客名に使えない文字が入っています。 |
| `NAME_RESERVED_SUFFIX` | 顧客名の最後を「_8桁の数字-4桁の数字」の形にはできません。 |
| `NAME_DUPLICATE` | 同じ顧客名が顧客一覧にあります。 |
| `WRITE_VERIFY_FAILED` | 顧客マスターへの書込を確かめられませんでした。顧客マスターの {行} 行目は無効のまま残っています。管理者へ連絡してください。 |

### 3.12 雛形へ直接書く取込を止める（`src/71_RunOrchestrator.gs`）

`runImport` の顧客ごとの処理（`customers.forEach(function(customer) {` の `try {` の先頭、`retryPendingRenames` より前）に足す：

```
if (opts.prepareOnly !== true && !opts.destinationSpreadsheetId &&
    registrationTemplateGuard_(customer.destinationSpreadsheetId) !== null) {
  customerReport.skipped = <その戻り値>;   // 'TEMPLATE_DIRECT_WRITE' か 'TEMPLATE_PROFILE_UNREADABLE'
  return;
}
```

`registrationTemplateGuard_(templateId)`（59）：

- `CUSTOMER_TEMPLATE_PROFILE_INDIVIDUAL` と `CUSTOMER_TEMPLATE_PROFILE_CORPORATE` を読む。どちらも空なら `null`（今の TEST01 だけの運用は変わらない）。
- 空でない方が JSON として読めない・`templateId` が無いなら `'TEMPLATE_PROFILE_UNREADABLE'`（分からないときは止める側）。
- どれかの `templateId` が `templateId` と同じなら `'TEMPLATE_DIRECT_WRITE'`。それ以外は `null`。

**Web アプリの取込は必ず複製を渡す**（`destinationSpreadsheetId`）か `prepareOnly` なので、このガードに当たらない。当たるのは転記先を渡さない取込（`scheduledImportTick`・`97` の運用の取込・`98` のリリースゲート）だけで、それらは登録した顧客を飛ばし、TEST01（雛形が別）は今のまま動く。

### 3.13 準備用の関数 `opsPrepareCustomerRegistration(options, apply)`（59。エディタ・`clasp run-function` から呼ぶ）

`options = {workParentFolderId, templateFolderId, contractSpreadsheetId, sourceCustomerId}`（`sourceCustomerId` の既定は `'TEST01'`）。**ID は呼ぶ時の引数でだけ渡す**（コードにもテストにも本番の ID を書かない）。他の運用関数と同じく、認可は呼ばない（実行 API の `access` は `MYSELF`）。実行者は `activeUserEmail_()` で監査に残す。`loadSettingsFromProperties()` を最初に呼ぶ。

**既定（`apply !== true`）は見るだけ。**何も書かない（フォルダ・ファイル・プロパティ・監査・マスターのどれにも）。報告（`Logger.log` と戻り値）：

| 項目 | 中身 |
|---|---|
| `workFolder` | 親の名前・親から上へ 10 段までの名前・親が `CUSTOMER_ROOT_FOLDER_ID` の 2 段以上下（顧客フォルダの中）か・親の直下の「作業用」の数・今の `PARALLEL_WORK_FOLDER_ID` が空か／その「作業用」と同じか／別のものか・`SAMPLE_CORPUS_FOLDER_ID` と同じになるか |
| `template` | `sourceCustomerId` の行の F（雛形）の名前と親のフォルダ名・親が `templateFolderId` と同じか・置き場の直下のファイルの数・置き場に「雛形（個人）」が何本あるか・今のプロファイルのプロパティが空か／その `templateId` のファイルが置き場にあるか |
| `template.inputSheet` | 雛形の入力用シート（H）の名前・AD・最終行・データ行（AD＋1〜最終行）の列ごとの「空でないセルの数」。列には `system`（B・F・I・K・M・取引 ID・L・C・G〔AL に無いとき〕）・`excluded`（AL）・`accountList`（AS の範囲）・`other` の札を付ける。**セルの値は出さない** |
| `template.otherTabs` | 入力用シート以外のタブの名前・最終行・最終列（値は出さない） |
| `profile` | 組んだプロファイルのバイト数・§2.4 の検査の結果 |
| `contract` | 別表のタブのうち、照合の鍵が `/^R\d+\.契約内容$/` のものの名前。それぞれ：見出しの行・データの行数・`ID_FORMAT` の数・繰り返す ID の数・名前が空の数。**ID と名前は出さない** |
| `rootFolder` | `CUSTOMER_ROOT_FOLDER_ID` が設定済みか・`個人` が 1 つに決まるか |
| `productionMaster` | `PRODUCTION_MASTER_SPREADSHEET_ID` が空か／今のマスターと同じか／別か |
| `plan` | `apply` で行うこと（各項目 `CREATE`・`REUSE`・`ALREADY_SET`・`CONFLICT`） |

**`apply === true`**：見るだけと同じ検査をしてから、次を順に行う。`CONFLICT` が 1 つでもあれば**何もせずに**止まる（`stoppedBy: 'CONFLICT'`）。

1. **作業用フォルダ**：親が顧客フォルダの中（`CUSTOMER_ROOT_FOLDER_ID` の 2 段以上下）なら `CONFLICT`。今の `PARALLEL_WORK_FOLDER_ID` が「親の直下の『作業用』」と同じなら `ALREADY_SET`。空なら、親の直下の「作業用」が 1 本なら使い（`REUSE`）、0 本なら作る（`CREATE`）、2 本以上は `CONFLICT`。空でなく別のものを指していれば `CONFLICT`（黙って上書きしない）。`SAMPLE_CORPUS_FOLDER_ID` と同じになるなら `CONFLICT`。
2. **雛形**：今のプロファイルがあり、その `templateId` のファイルが置き場（`templateFolderId`）にあれば `ALREADY_SET`（写し直さない）。プロファイルが無ければ：置き場に「雛形（個人）」が既にあれば `CONFLICT`。無ければ TEST01 の F を置き場へ `makeCopy('雛形（個人）', 置き場)` し、写しの入力用シートのデータ行（AD＋1〜最終行）で **`webAppCloneDestination_` と同じシステム列だけ**を `clearContent()` する（B・F・I・K・M・取引 ID、列対応にあれば L・C、G は AL に無いときだけ）。他の列・他のタブには触れない。
3. **プロファイル**：TEST01 の行の §2.4 の 24 列と、2 の写しの ID で組み、§2.4 の検査を通してから `CUSTOMER_TEMPLATE_PROFILE_INDIVIDUAL` へ書く。
4. **別表**：`contractSpreadsheetId` を開けなければ `CONFLICT`。`CUSTOMER_ID_SOURCE_SPREADSHEET_ID` が空なら書く、同じなら `ALREADY_SET`、別なら `CONFLICT`。
5. **本番マスター**：`PRODUCTION_MASTER_SPREADSHEET_ID` が空なら今のマスターの ID を書く、同じなら `ALREADY_SET`、別なら `CONFLICT`。

1〜5 で書いた（または作った・写した）ものごとに監査を 1 行（`type: 'SETTING'`・`targetType: 'SETTING'`・`targetId: キー名またはファイルの種類`・`before`・`after`・`reason: 'PREPARE_CUSTOMER_REGISTRATION'`）。**プロパティの書込より先に監査を書く**。2 回目の `apply` は全部 `ALREADY_SET` になり、何も書かない。

---

## 4. 安全の条件（テストで確かめる）

| # | 条件 |
|---|---|
| S1 | 登録の 3 つの入口は、オーナー以外を必ず拒む（Q・R 列に載っている確認担当者・システム管理者も）。拒否は監査に `PERMISSION` で残る。オーナーは、有効な顧客が 0 件でも通る |
| S2 | **登録の画面は顧客の Drive に書かない。**3 つの入口のどれを通っても、Drive のファイル・フォルダへの書込（名前の変更・作成・複写・移動・ごみ箱・中身の更新・共有の変更）が 0 回。明細ファイルは開かない |
| S3 | **有効（C が `true`）で不正な行を作らない。**`getActiveCustomers()` は有効な行が 1 つでも不正だと例外になり、全顧客の画面と取込が止まる。C を `true` にするのは、読み返した 45 個のセルが書いた値と同じで、`validateCustomerValues_` が通った後だけ |
| S4 | A（大文字小文字・NFKC を区別しない）・B（照合の鍵）・D は、マスターの全行（無効を含む）で重ならない。ロックの中の今の行で確かめる |
| S5 | 監査の書込が先。監査が書けなければマスターに何も書かない |
| S6 | 準備が足りなければ（§3.2）登録は何も書かない |
| S7 | 雛形を共有する顧客について、転記先の複製を渡さない取込は雛形に 1 セルも書かない（§3.12） |
| S8 | 顧客 ID は別表にある ID だけ。AK は、サーバーがたどって確かめた年の段の名前からだけ決まる |
| S9 | 明細フォルダ D は、§3.7 の 3 の 2 つの道のどちらかにちょうど当たる（経費の段の子）。画面から来た ID がそれ以外を指しても登録しない |
| S10 | 別表の名簿（ID と名前）を Logger・監査・例外の文に出さない。見るだけの準備用の関数も数だけを出す |
| S11 | 準備用の関数は、既定（見るだけ）では何も書かない。`apply` で既にある設定を黙って上書きしない（`CONFLICT` で全体を止める） |
| S12 | 雛形の写しで空にするのはシステム列だけ（除外列 AL・科目一覧 AS・他の列・他のタブの値と数式は写しのまま） |

---

## 5. 変えてよいファイル

- `src/59_CustomerRegistration.gs`（新規。§3.2〜§3.9・§3.12 の `registrationTemplateGuard_`・§3.13）
- `src/03_Authorization.gs`（`authorizeOwner` を足すだけ。既存の関数・表は変えない）
- `src/71_RunOrchestrator.gs`（§3.12 の数行だけ）
- `src/80_WebApp.gs`（§3.10 の 3 つの入口を足すだけ）
- `src/81_WebAppUi.html`（§3.11）
- `test/gas-stubs.js`（足りない模型を足す。既存の振る舞いは変えない）
- `test/phase10-customer-registration.test.js`（新規）・`test/customer-registration-ui.test.js`（新規）

これ以外は変えない。特に `97`（開かない）・`02`・`04`・`05`。既存のテストを緩めない・消さない。

---

## 6. テスト

架空の Drive の木（共通フォルダ → 個人・法人 → 顧客フォルダ → …）と架空の別表で作る。既存の `test/phase6-customer-name-from-folder.test.js`（Drive の木）と `test/phase8-webapp.test.js`（Web アプリ）、`test/kw26-ui-helpers.js`（画面）の作り方に合わせる。

### 6.1 サーバー（`reg N: …`、`test/phase10-customer-registration.test.js`）

1. **認可**：確認担当者・システム管理者（Q・R に載っている）で 3 つの入口を呼ぶと `AuthorizationError`、監査に `PERMISSION` が 1 行ずつ。オーナーは有効な顧客 0 件のマスターでも `webAppRegistrationStart` が通る（S1）。
2. **準備の不足**：§3.2 の 6 つのコードを 1 つずつ作り、`ready: false`・`missing` にそのコード・`customerFolders: []`。`webAppRegisterCustomer` は `NOT_READY` でマスター・監査の行数が変わらない（S6）。`PARALLEL_WORK_FOLDER_ID` がコーパスと同じときも `PARALLEL_WORK_FOLDER_ID`。
3. **顧客フォルダの一覧**：個人の直下だけが出る（法人の子は出ない）。表示名から【…】が外れる（2 つ続く【…】も）。マスターの B と鍵が同じフォルダは `registered: true`（全角の空白・半角の違いがあっても）。名前・ID の順。
4. **自動で決まる**：§2.1 の形で `READY`・道・`reiwaYear 8`・`fiscalYear 2026`・カードのフォルダ名。資料共有の段が無い顧客でも `READY`。
5. **選ばせる段**：経費の段・明細の段で型に当たる子が 0・2 の時に `NEED_CHOICE`（全部の子）。資料共有・年の段で 2 の時は型に当たる子だけ。選ぶと先へ進む。直下に無い ID・年の型に当たらない子を年として選ぶと `STOPPED`・`FOLDER_STRUCTURE`。
6. **年の段が無い**：`YEAR_FOLDER_NOT_FOUND` と子の名前。
7. **別表**：見出しが 3 行目にあるタブで `MATCHED`。名前の照合（【…】・全角の空白・半角）。0 件 `NONE`・2 件 `MULTIPLE`。`ID_FORMAT`・`ID_REPEATED_IN_CONTRACT`・`ID_DUPLICATE` の行は `usable: false`、`MATCHED` の数に入らない。タブが無い・2 つ当たる → `CONTRACT_TAB_NOT_FOUND`、見出しが無い → `CONTRACT_HEADER_NOT_FOUND`、開けない → `CONTRACT_UNREADABLE`。表示が `0012` のセル（数値 12・書式 `0000`）は `customerId: '0012'` になる（`FORMATTED_VALUE` で読む）。
8. **登録の成功**：書かれた行の 45 個の値が §2.3 の表どおり（A は文字列 `'0012'` のまま・AK は数値 2026・C は最後に `true`・Q と R は実行者・プロファイルの 24 列は TEST01 と同じ）。`valueInputOption` が `RAW`。監査 `CUSTOMER_REGISTER` がマスターの書込より先（順番を記録して確かめる）。その後 `getCustomerById`・`webAppBootstrap` に新しい顧客が出る。
9. **書き順**：C を `false` で書き、読み返し、C を `true` にする順（呼出しの記録で確かめる）。
10. **改ざんした要求**（どれも何も書かない・S9）：D が顧客フォルダの外／別の顧客フォルダの中／年の段そのもの／経費の段そのもの／カードのフォルダ（1 段深い）／年の型に当たらない段の下／親が 2 つ／顧客フォルダが法人の下／共通フォルダの外／D がコーパス・作業用フォルダ。
11. **ID**：別表に無い ID（手で打った ID）→ `ID_NOT_IN_CONTRACT`。`ID_FORMAT`・`ID_REPEATED_IN_CONTRACT`・マスターに既にある（大文字小文字・全角の違いだけ）→ `ID_DUPLICATE`。
12. **名前**：§3.3 の表の 5 つのコード。`NAME_DUPLICATE` は無効の行の B とも比べる。
13. **D**：別の行（無効を含む）と同じ D → `FOLDER_ALREADY_REGISTERED`。登録済みの D の中の明細フォルダ → `FOLDER_OVERLAPS`。
14. **2 回目**：同じ要求を 2 回 → 2 回目は `alreadyRegistered: true`、行も監査も増えない（§3.9）。A が同じで D が違う → `ID_DUPLICATE`。
15. **途中の失敗**：監査の書込が失敗 → マスターの行が増えない（S5）。行の書込が失敗・読み返しの値が違う（模型で 1 セル変える）→ `WRITE_VERIFY_FAILED`・C は `false`・`getActiveCustomers()` は例外にならず他の顧客を返す（S3）・失敗の監査が 1 行。C の書込の後の読み返しが `false` → `WRITE_VERIFY_FAILED`。
16. **ロックの中の確かめ直し**：外の確かめの後・ロックの前に、同じ ID の行を模型で足す → `ID_DUPLICATE`、行は増えない（S4）。同じ名前・同じ D でも同じく止まる。
17. **プロファイル**：鍵が 23 個・25 個・AE が JSON でない・`templateId` が空 → `PROFILE_INVALID`、何も書かない。
18. **Drive に書かない**：1〜17 のすべての入口の呼出しで、模型の Drive の書込の数が 0（S2）。
19. **名簿を出さない**：別表の架空の名前・ID が、`Logger` の出力・監査の行・例外の文に現れない（S10）。
20. **取込のガード**（`runImport`）：プロファイルの `templateId` を F に持つ顧客は、転記先を渡さない `runImport({})` で `skipped: 'TEMPLATE_DIRECT_WRITE'`、雛形への書込が 0・ファイルの状態も変わらない。同じ顧客でも `destinationSpreadsheetId` を渡せば今のまま取込む。`prepareOnly` は今のまま。F が別の顧客（TEST01 の形）は今のまま。プロファイルのプロパティが壊れている → `TEMPLATE_PROFILE_UNREADABLE`。どちらのプロファイルも空 → 今のまま（S7）。
21. **準備用の関数・見るだけ**：何も書かない（プロパティ・Drive・監査・マスターの書込が 0）。報告に値・名前・ID が出ない（列ごとの数・タブの名前・数だけ）（S10・S11）。
22. **準備用の関数・apply**：作業用フォルダを作り（または 1 本あれば使い）、プロパティ 4 つを書き、雛形を写してシステム列だけ空にする（AL の列・AS の範囲・他のタブ・他の列の値と数式は写す前と同じ）（S12）。監査がプロパティの書込より先。2 回目は全部 `ALREADY_SET` で何も書かない。`PARALLEL_WORK_FOLDER_ID` が別のもの・作業用の親が顧客フォルダの中・置き場に「雛形（個人）」が既にある・作業用がコーパスと同じ → `CONFLICT` で何も書かない。

### 6.2 画面（`regu N: …`、`test/customer-registration-ui.test.js`）

1. オーナーでない：「設定」で文言だけ出て、サーバーを呼ばない。
2. オーナー：「設定」でパネルが出て `.steps`・`main.workspace` が隠れ、`webAppRegistrationStart` が 1 回。［戻る］で元に戻る。取込の最中（`isMutationBusy()`）は開かない。
3. `ready: false`：足りないものの文言が並び、一覧が出ない。
4. 一覧の検索（表示名・元の名前・全角の空白の違い）。`registered` の行は押せない。
5. 顧客フォルダを選ぶ → `webAppRegistrationInspect(id, {})`。`NEED_CHOICE` で選ぶと `picks` を足して呼び直す。`STOPPED` で先へ進めない。`READY` で道・対象年度・カードの名前。
6. 顧客 ID：`MATCHED` の表示・［選び直す］・`NONE`/`MULTIPLE` の一覧（`usable: false` は押せない）。
7. 顧客名の画面の検査（空・51 文字・制御文字・末尾 `_20261112-1200`）で［登録する］が押せない。
8. ［登録する］→ 確認 → `webAppRegisterCustomer` に §3.11 の 5 つの値ちょうど。二度押しでも呼出しは 1 回。呼出し中は戻れない。
9. 成功 → `bootstrap()`（`webAppBootstrap`）と `webAppRegistrationStart` が呼び直され、文言が出る。`alreadyRegistered` の文言。
10. `ok: false` の各コードの文言。`WRITE_VERIFY_FAILED` に行番号。
11. 古い返事：顧客フォルダ A の下調べの返事が、B を選んだ後に返ってきても画面を変えない。
12. フォルダ名・別表の名前に `<img src=x onerror=…>` があっても字のまま出る（`innerHTML` を使っていない）。
13. 確認の窓 `#confirm-intro` に `white-space: pre-line` があり、登録の確認文が行に分かれて出る（`\n` を含む）。
14. CSS に `.steps[hidden]`・`.workspace[hidden]` の `display: none` があり、「設定」を開くと進み具合の帯と 3 つの欄が実際に隠れる（`display: grid` が `[hidden]` に勝つため、`hidden` の値だけでは隠れない）。
15. **開くときの「調べています…」（1.1）：**`webAppRegistrationStart` を待たせると、`#registration-missing` が出て中身がちょうど「調べています…」、2〜5 の段が隠れ、一覧が空、［登録する］が押せない。返事で一覧が出て「調べています…」が消える。一度開いて一覧が出た後に閉じ、開き直して待たせても、前の一覧は出ず「調べています…」だけ。例外でも「調べています…」が残らない。
16. **下調べの「調べています…」（1.1）：**下調べを待たせると、3 の段が出て `#registration-statement-message` がちょうど「調べています…」、道・年度・カード・選択肢が空、4・5 の段が隠れ、［登録する］が押せない。待っている間に別の顧客フォルダを選んで（これも待たせる）、前の返事を先に返しても「調べています…」のまま。後の返事（`READY`）で消えて道が出る。`NEED_CHOICE` で段を選んだ後の呼び直しを待たせても「調べています…」が出る。下調べが例外のときは「調べています…」が残らない。
17. **止まったときの文言（1.1）：**`YEAR_FOLDER_NOT_FOUND`（道が空・子が 2 つ）で 1 行目がちょうど「この顧客フォルダの中に「令和N年分」のフォルダがありません。」、class が `settings-warning`、選択肢の欄に「直下にあるフォルダ：<子 1>、<子 2>」と 3 行目の文がある。道が `['☆資料共有フォルダ']` なら「「☆資料共有フォルダ」の中に「令和N年分」のフォルダがありません。」。`NO_CHILD_FOLDERS`（道が空・道が 2 つ）で「この顧客フォルダの中にフォルダがありません。」・「「<道の最後>」の中にフォルダがありません。」、子が空なら「直下にあるフォルダ：」の行は無い。`FOLDER_STRUCTURE` は表の文言で 3 行目が無い。`NOT_READY` は `missing` の文言が並ぶ。子の名前が `<img src=x onerror=…>` でも字のまま出る。どの場合も［登録する］は押せない。`STOPPED` の後に `READY` を返すと 1 行目の class が `muted` に戻る。

regu 5 の止まる段の確かめ（`「令和N年分」のフォルダが見つかりません。` を探していたもの）は、regu 17 と同じ新しい文言に替える（確かめを弱めない）。

### 6.3 既存のテスト

全部そのまま通ること。`runImport` を呼ぶ既存のテストは、プロファイルのプロパティが空なので §3.12 に当たらない。

---

## 7. 変異（入れて回し、赤になるテストを記録して戻す）

| # | 入れる変異 | 赤になるはずのテスト |
|---|---|---|
| R1 | 3 つの入口の `authorizeOwner` を外す | reg 1 |
| R2 | `authorizeOwner` で `getActiveCustomers` を通す（`authorize(OWNER_ADMIN, null)` に替える） | reg 1（0 件のマスター） |
| R3 | §3.7 の 3 の道の確かめを外す（画面の ID を信じる） | reg 10 |
| R4 | 道の長さを問わない（年の段・経費の段を D にできる） | reg 10 |
| R5 | C を最初から `true` で書く | reg 9・reg 15 |
| R6 | `RAW` を `USER_ENTERED` に替える | reg 8（`'0012'`） |
| R7 | ロックの中の確かめ直しを外す | reg 16 |
| R8 | 監査を行の書込の後にする | reg 8・reg 15 |
| R9 | 別表を `UNFORMATTED_VALUE` で読む | reg 7 |
| R10 | 別表に無い ID を通す | reg 11 |
| R11 | 名前の重複を字面だけで比べる | reg 12・reg 3 |
| R12 | `NAME_RESERVED_SUFFIX` を外す | reg 12・regu 7 |
| R13 | §3.12 のガードを外す | reg 20 |
| R14 | ガードで `prepareOnly` も止める | reg 20（`prepareOnly`）・既存の Web アプリの取込のテスト |
| R15 | 準備用の関数の見るだけで監査を書く | reg 21 |
| R16 | 雛形の写しで AL の列も空にする | reg 22 |
| R17 | `apply` で `CONFLICT` でもプロパティを上書きする | reg 22 |
| R18 | 画面で名前を `innerHTML` で出す | regu 12 |
| R19 | 古い返事を捨てない | regu 11 |
| R20 | §3.9 を外す（2 回目も書く） | reg 14 |
| R21 | 59 に `function diagSortedEntries_(` を戻す（`97` と同じ名前） | reg 23 |
| R22 | 下調べから D のたどる確かめを外す | reg 24 |
| R23 | `#confirm-intro { white-space: pre-line; }` を消す | regu 13 |
| R24 | `.steps[hidden], .workspace[hidden] { display: none; }` を消す | regu 14 |
| R25 | 下調べの待ちの世代を入れない（「調べています…」を出さない） | regu 16 |
| R26 | 下調べの `finally` で待ちの世代を無条件に `null` へ戻す | regu 16 |
| R27 | 開くときの待ちで、前の一覧（`registrationReady` が `true`）を出したままにする | regu 15 |
| R28 | 止まったときの 1 行目を表の文言に戻す | regu 17・regu 5 |

---

## 8. 本番での手順と受入

### 8.1 手順（Claude が行う。書く段は利用者の許可を得てから）

1. 実装・監査・全テスト → main へ取り込み → `clasp push`（本番反映。タグ `gas-push-N`）。
2. **準備の見るだけ**：`opsPrepareCustomerRegistration({workParentFolderId: …, templateFolderId: …, contractSpreadsheetId: …}, false)`。ID は利用者から聞いたもの（会話とメモリにだけある）。報告を利用者へ見せる。特に `template.inputSheet` の `other` の列と `template.otherTabs`（テスト顧客の中身が雛形に残っていないか）、`contract`（ID の形・繰り返し）。
3. 利用者の許可 → 同じ引数で `apply` を `true`。もう一度見るだけで全部 `ALREADY_SET` を確かめる。
4. 利用者が画面から 1 人目を登録する（個人・令和 8 年分）。
5. Claude が読むだけで確かめる：`getCustomerById(<ID>)` が通る・D・F・AK・Q・R。
6. 最初の記帳は AUPAY（利用者）。

**注意：**登録した顧客に `opsSetCustomerNamesFromFolders(…, true)` を使わない。この関数は【…】を外さないので、転記シートができる前なら B を元のフォルダ名（【…】つき）へ書き換える。定期取込（`opsStartScheduledImport`）は本番で始めない（§3.12 で登録した顧客を飛ばすので、そのファイルが取込待ちのまま残り、空振りの判定に届かず 10 分ごとの実行が止まらない）。

### 8.2 受入（利用者）

1. 「設定」を押すと「顧客一覧への登録」が出る。顧客フォルダの一覧に、頭の【…】が外れた名前が並ぶ。
2. 1 人目を選ぶと、明細フォルダの道とカードのフォルダ名が自動で出る。対象年度が「令和 8 年分（2026 年）」。
3. 顧客 ID が別表から出る（違えば選び直せる）。
4. ［登録する］で、左の「1. 顧客選定」の一覧に出る。
5. AUPAY の記帳ができる。転記シートが共有の置き場に `<顧客名>_日時` の名前でできる。
6. 記帳の後、顧客のフォルダに一時コピーなどのファイルが増えていない（Excel の一時コピーは作業用フォルダにできて消える）。明細ファイルは名前の頭だけが変わっている。

---

## 9. Claude の判断の記録（利用者の決定ではないもの）

1. **TEST01 の値はスクリプトプロパティへ 1 回だけ写す（プロファイル）。**登録のたびに TEST01 の行を読むと、TEST01 を直した・無効にした時に本番の登録が黙って変わる。コードに定数で書くと、雛形の ID（公開してはならない）をコードに置くことになる。
2. **明細フォルダの深さを固定する（経費の段の子）。**D の直下のフォルダがカードとして読まれるので、浅い D は収入・決算などの明細まで取込む。名前は選び直せるが、深さは選べない。違う深さの顧客が出たら、その時に仕様を足す。
3. **C を `false` で書いてから `true` にする。**`getActiveCustomers()` は有効な不正行 1 つで例外になり、全顧客の画面と取込が止まる（`authorize` も通らない）。書きかけで止まっても無効の行が残るだけにする。
4. **雛形へ直接書く取込を止める（71）。**利用者の決定「雛形は 1 つ」により、転記先を渡さない取込が全顧客の取引を雛形 1 冊へ書く。以前、運用の取込が TEST01 の雛形へ書いた跡（「対象外」だけの行）が実際に残っていた（`webAppCloneDestination_` の注釈）。
5. **`authorizeOwner` を足す。**`authorize(OWNER_ADMIN, null)` は有効な顧客 0 件だとオーナーでも `NO_CUSTOMER_ACCESS` で拒む。
6. **顧客 ID は別表から選ぶだけ（手入力なし）。**利用者の決定「事務所が決めた ID を使う」を守る。
7. **ID の形を英数字・`-`・`_` の 32 文字までにする。**ID はシート名（`TXIDX_<ID>_<年>`）などに入る。本物の取引先コードの形は準備の見るだけで数える（§8.1 の 2）。合わなければ、その時に決め直す。
8. **名前の重複は照合の鍵で比べる。**見た目が同じ名前（全角・半角の空白の違い）を別の顧客にしない。
9. **名前の末尾 `_yyyyMMdd-HHmm` を禁じる。**転記シート名 `<B>_yyyyMMdd-HHmm` の照合で、別の顧客の転記シートと紛れる形を作らない。
10. **同じ要求の 2 回目は成功で返す。**`google.script.run` は通信が切れると、サーバーが書き終えていても失敗として返ることがある。
11. **`97` の関数を呼ばない。**`diagChooseChildFolder_` などは運用の関数の部品で、運用の都合で変わりうる。59 に同じ働きの小さな関数を書く。
12. **年の段は、1 つに決まる時だけ自動、2 つ以上なら既定を置かず利用者が選ぶ。**AK（前年の判定の基準）を取り違えると、前年分が要確認にならない無音の失敗になる。
13. **別表は `FORMATTED_VALUE` で読む。**先頭の 0 のある取引先コードを、表示どおりの文字列で持つ。
14. **雛形の写しで空にするのはシステム列だけ。**他のタブ（取引先一覧など）にテスト顧客の中身があるかは、見るだけで数えて利用者に見せ、消すかは利用者が決める（§10 の 2）。
15. **ロックの中の読み直しと読み返しは Sheets API で行う。**行を Sheets API（`RAW`）で書くので、同じ実行の中で先に `SpreadsheetApp` で読んだ値を読み直すと、古い値が返りうる。確かめ直しが古い値を見ると、重複の検査が素通りする。
16. **準備用の関数は他の運用関数と同じく認可を呼ばない。**実行 API は `MYSELF` で、`clasp run-function` の実行者の取り方が Web アプリと違う。代わりに既定を見るだけにし、`apply` で既にある設定を上書きしない。

## 10. 利用者に確かめること

1. ~~別表のタブの年~~ → **決定済み（2026-11-12 利用者「はい」）**：明細の「令和 N 年分」と同じ N のタブ（`R{N}.契約内容`）から引く。§1.1・§3.6 のとおり。
2. **雛形の写しの他のタブ：**準備の見るだけ（§8.1 の 2）で、雛形の他のタブや入力用シートの `other` の列に中身があれば、消すかどうか。（TEST01 は実際の明細で試したので、取引先一覧などに実在の店名・人名が残っている恐れがある。全顧客の転記シートに写るので、残すなら全顧客に見える。）

## 11. 実装と監査の記録（2026-11-12〜13）

1. **実装は OpenCode（Go）で 3 回。**1 回目＝サーバー側（59・03・71・80・スタブ・reg 1〜22・R1〜R17・R20、`54e12cd`）。2 回目＝1 回目の直し F1〜F5 と画面（81・regu 1〜12・R18・R19・R21・R22、`b88c810`）。3 回目＝確認の窓の改行（81 の CSS 1 行・regu 13・R23）。変異 R1〜R23 はすべて赤を確かめて戻した。
2. **1 回目の直し（Claude の監査で見つけたもの）：**F1 59 に `97` と同じ名前の関数（`diagSortedEntries_`・`diagChooseChildFolder_`）があった → 消した（reg 23）。F2 下調べは D のたどる確かめをせず、画面は READY なのに登録で `FOLDER_STRUCTURE` になりえた → 下調べも同じ確かめ（reg 24）。F3 作業用の親の場所が分からないときに「顧客フォルダの外」扱い → `CONFLICT`（reg 22b）。F4 プロファイルの雛形の ID に TEST01 の F を代用していた → 例外で止める。F5 スタブの Drive 書込の一覧に記録されない名前があった → 直した。
3. **受け入れた仕様からの外れ：**(a) A（顧客 ID）が既にマスターにある要求は、D・B の検査をロックの中の §3.9 に任せる（書かない道だけ）。(b) プロファイルだけが壊れているときは `NOT_READY` でなく `PROFILE_INVALID` を返す。(c) 「経費の段の位置の名前が明細の型なら止める」確かめは登録と下調べの両方でする（経費の段の無い木でカードを D にさせない）。
4. **記録だけで直さないもの（範囲外）：**`webAppBootstrap` は `authorize` を呼ぶので、有効な顧客が 0 件だと「設定」も開けない（今は TEST01 があるので起きない）。
5. **2 回目の監査で記録した低（3 回目で直した）：**確認の窓 `#confirm-intro` に `white-space` の指定が無く、登録の確認文の改行が効かず 1 行に詰まっていた。
6. **全テスト：**worktree（`test/fixtures/` 無し）では 2011/2108（落ちるのは fixtures が無いための ENOENT 97 件だけ）。fixtures 込みの全テストは main へ取り込んだ後に main のフォルダーで流す（fixtures を worktree へ写す操作は自動判定で拒まれるため）。
7. **本番の受入で見つけたもの（2026-11-13）：**「設定」を開いても進み具合の帯と 3 つの欄が隠れず、登録の欄がその下に出た。`setSettingsVisible` は `hidden` を付けていたが、`.steps`・`.workspace` の `display: grid` が `[hidden]` に勝っていた（regu 2 は `hidden` の値しか見ずにすり抜けた）。`.steps[hidden], .workspace[hidden] { display: none; }` を足し、regu 14・R24 で見張る（OpenCode 4 回目）。利用者の指示「設定の画面にこれは表示させる必要はない」。
8. **記録だけ（直していない）：**読み込み（`webAppBootstrap`）が終わる前に「設定」を押すと、`state.isOwner` がまだ false なので「この画面はオーナーだけが使えます」と出る（待ってから押せば開く）。直すなら「読み込み中です」の文言にするか、読み込み後に開く。
9. **本番の受入で見つけたもの（2026-11-13 夕）：**利用者「テスト３を選べるが登録できない」。不具合ではなかった：テスト用の顧客フォルダ 4 つは、直下にカードのフォルダがあり「令和N年分」の段が無いので、下調べが `YEAR_FOLDER_NOT_FOUND` で止まる（§3.5 のとおり。本番の下調べを読むだけで呼んで確かめた）。ただし下調べは 3〜5 秒かかり、その間に画面に何も出ず、止まった後の文言も「「令和N年分」のフォルダが見つかりません。」と子の名前の羅列だけで分かりにくかった。利用者の指示「直して」で、§3.11 の「調べている間の表示」「止まったときの文言」を足した（1.1。開くときの `webAppRegistrationStart` の待ちも同じ表示にしたのは Claude の判断：同じく数秒何も出ないため）。本番の顧客フォルダ 23 のうち、すぐ登録できる 12・ID を選ぶ 2・年度を選ぶ 3・明細フォルダを選ぶ 1・止まる 5（テスト用 4 と、「令和N年分」の無い顧客 1）。実装は OpenCode 5 回目（`a011d56`。81 と画面テストだけ、`.gs` は変えていない）：regu 15〜17 を足し、regu 5 の止まる段は新しい文言にちょうど一致する確かめへ替えた。R25〜R28 はすべて赤を確かめて戻した（R25・R26→regu 16、R27→regu 15、R28→regu 17・regu 5）。worktree 2024/2121（ENOENT 97 だけ）、main で全テスト 2121/2121。

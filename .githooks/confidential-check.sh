# pre-commit と pre-push が読み込む共通部品（単体では実行しない）。
# このリポジトリは公開する。秘密情報（gitleaks）、公開してはならない語（顧客名・
# 実物の ID など）、入れてはならないファイルを、コミット時と push 時に止める。

# gitleaks を探して GL に入れる。見つからなければ止める（fail-closed）。
# 導入: winget install --id Gitleaks.Gitleaks
confidential_find_gitleaks() {
  GL="$(command -v gitleaks 2>/dev/null)"
  if [ -z "$GL" ] && [ -n "$LOCALAPPDATA" ]; then
    for p in "$LOCALAPPDATA"/Microsoft/WinGet/Packages/Gitleaks.Gitleaks_*/gitleaks.exe; do
      if [ -x "$p" ]; then GL="$p"; break; fi
    done
  fi
  if [ -z "$GL" ]; then
    echo "gitleaks が見つかりません。導入するか、利用者に確認してから回避してください。" >&2
    return 1
  fi
}

# 標準入力のファイル名（1 行 1 つ）に、リポジトリへ入れてはならないものがあれば止める。
# 実明細（xlsx・csv・pdf など）、実明細から生成した固定データ、Codex の全記録、鍵や
# 認証情報のファイル。gitleaks の既定は xlsx・pdf などを検査の対象外にするので、ここで見る。
confidential_path_check() {
  bad="$(grep -E -i \
      -e '(^|/)(samples|テスト用クレカ明細|test/fixtures)/' \
      -e '\.(xlsx|xlsm|xls|csv|pdf|zip)$' \
      -e '(^|/)tools/codex-logs/err-' \
      -e '(^|/)client_secret[^/]*\.json$' \
      -e '(^|/)\.clasp(rc)?\.json$' \
      -e '\.(pem|p12|pfx)$' \
      -e '(^|/)\.env($|\.)' | grep -v -E '(^|/)\.env\.example$')"
  if [ -n "$bad" ]; then
    echo "$1 に、リポジトリへ入れてはならないファイルがあります:" >&2
    printf '%s\n' "$bad" | head -10 >&2
    return 1
  fi
}

# 標準入力の差分の「追加行」に、公開してはならない語が含まれていたら止める。
# 語の一覧は一覧そのものが機密なので、リポジトリではなくこの PC の
# .git/info/confidential-denylist.txt に置く（1 行 1 語、# で始まる行は注釈、
# 大文字小文字は区別しない）。一覧が無い・空のときも止める（fail-closed）。
confidential_denylist_check() {
  list="$(git rev-parse --git-common-dir)/info/confidential-denylist.txt"
  if [ ! -s "$list" ]; then
    echo "$list がありません（公開してはならない語の一覧）。作ってから再実行してください。" >&2
    return 1
  fi
  patterns="$(grep -v -e '^#' -e '^[[:space:]]*$' "$list" | tr -d '\r')"
  if [ -z "$patterns" ]; then
    echo "$list に語が 1 つもありません。" >&2
    return 1
  fi
  hits="$(grep -e '^+' | grep -v -e '^+++ ' | grep -F -i -e "$patterns")"
  if [ -n "$hits" ]; then
    echo "$1 に公開してはならない語が含まれています（$(printf '%s\n' "$hits" | wc -l | tr -d ' ') 行）:" >&2
    printf '%s\n' "$hits" | head -5 | cut -c1-120 >&2
    return 1
  fi
}

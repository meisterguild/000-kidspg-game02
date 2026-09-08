#!/usr/bin/env bash
# 作業の節目をスマホへ通知する（terms-extra の送信口を経由）。
#
#   bash tools/notify.sh "見出し" "本文" [優先度 1-4] [タグ]
#
# 🔴 **ntfy を直接叩かないこと。** terms-extra の `POST /api/notify` を通す。
#    ⚠️ 以前このスクリプトは ntfy へ直接 POST していたが、**本文にバイト数の上限が無く**、
#       長い報告が **4096 バイトを超えて通知ごと添付ファイル（attachment.txt）に化けていた**
#       ―― スマホでは中身を落とさないと読めない状態だった（2026-09-04 に判明）。
#    ⚠️ 見出しも生の UTF-8 をヘッダへ入れていたが、**それでは通らない**（文字化けする）。
# 🔵 本文の上限（安全側に切る）と見出しの包み方（RFC 2047）は
#    **terms-extra の中の 1 か所だけ**が正しく持っている。だからそこを通す。
# 🔴 **通知先 ID（トピック）はもう読まない。** 事実上のパスワードなので、
#    触らないのがいちばん安全（送信口を通せば知る必要が無い）。
set -uo pipefail

TITLE="${1:-KidsPG}"
BODY="${2:-}"
PRIORITY="${3:-3}"
TAGS="${4:-hammer_and_wrench}"

if [ -z "$BODY" ]; then
  echo "notify: 本文が空です。使い方: bash tools/notify.sh \"見出し\" \"本文\" [優先度] [タグ]" >&2
  exit 2
fi

# LOCALAPPDATA は Windows 形式で来るので Git Bash 形式へ直す
STATE="${TERMS_EXTRA_HOME:-${LOCALAPPDATA:-$HOME/AppData/Local}/terms-extra}"
STATE="$(cygpath -u "$STATE" 2>/dev/null || printf '%s' "$STATE")"
RUNTIME="${STATE}/runtime.json"

if [ ! -f "$RUNTIME" ]; then
  echo "notify: terms-extra が動いていません（${RUNTIME} が無い）。送りませんでした" >&2
  exit 1
fi

TOKEN="$(tr -d ' \n' < "$RUNTIME" | sed 's/.*"token":"\([^"]*\)".*/\1/')"
PORT="$(tr -d ' \n' < "$RUNTIME" | sed 's/.*"port":\([0-9]*\).*/\1/')"

if [ -z "$TOKEN" ] || [ -z "$PORT" ]; then
  echo "notify: runtime.json からポートかトークンを読めませんでした" >&2
  exit 1
fi

RESP="$(mktemp)"
PAYLOAD="$(mktemp)"
trap 'rm -f "$RESP" "$PAYLOAD"' EXIT

# ⚠️ **JSON の組み立ては node に任せる**（引用符・改行・バックスラッシュを自分で
#    エスケープすると必ずどこかで壊れる）。このリポジトリは Node 前提なので在る。
# 🔴 **本文と見出しは環境変数で node へ渡し、JSON はファイルへ書く。**
#    ⚠️ **`curl` の引数に日本語を置いてはいけない** ―― `curl.exe` は Windows の
#    ネイティブ実行ファイルで、Git Bash から引数を渡すときに **UTF-8 が latin-1 として
#    読み直され、1 文字が 2 文字に化ける**（実測 / 2026-09-04: 3,600 バイトの本文が
#    core 側で **7,200 バイト**＝ ちょうど 2 倍になった。⚠️ ASCII だけなら化けないので
#    **日本語で試さないと気づけない**）。⇒ 引数には**ファイル名（ASCII）だけ**を置く。
TITLE="$TITLE" BODY="$BODY" PRIORITY="$PRIORITY" TAGS="$TAGS" node -e '
const n = Number(process.env.PRIORITY);
process.stdout.write(JSON.stringify({
  title: process.env.TITLE,
  body: process.env.BODY,
  // 優先度は 1〜4（terms-extra 側でも丸めるが、ここでも素直な値を送る）
  priority: Number.isFinite(n) ? Math.min(4, Math.max(1, Math.floor(n))) : 3,
  tags: process.env.TAGS,
}));
' > "$PAYLOAD"

# ⚠️ **URL とトークンは標準入力から渡す**（`--config -`）。引数に置くと `ps` や
#    `tasklist` から読めてしまい、同じ PC の誰でも API を叩けるようになる。
code="$(
  {
    printf 'url = "http://127.0.0.1:%s/api/notify"\n' "$PORT"
    printf 'header = "x-terms-extra-token: %s"\n' "$TOKEN"
    printf 'header = "content-type: application/json"\n'
  } | curl -s -o "$RESP" -w '%{http_code}' --max-time 10 \
    -X POST --data-binary "@${PAYLOAD}" --config -
)"

if [ "$code" = "404" ]; then
  echo "notify: terms-extra に送信口がありません（core の再起動が要ります）" >&2
  exit 1
fi
if [ "$code" != "200" ]; then
  echo "notify: 送信に失敗しました http=${code}" >&2
  exit 1
fi

# 🔴 **「届いた」とは言わない。** 投げっぱなしなので、届いたかは分からない
if grep -q '"tried":true' "$RESP"; then
  echo "notify: 送りました（届いたかはスマホで確かめてください / ${TITLE}）"
else
  reason="$(sed -n 's/.*"reason":"\([^"]*\)".*/\1/p' "$RESP")"
  echo "notify: 送りませんでした（${reason:-理由不明}）" >&2
  exit 1
fi

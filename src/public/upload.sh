#!/usr/bin/env bash
#
# Upload a file to a gh-upload server.
#
#   ./upload.sh <file> [server-url]
#
# Server URL may also come from GH_UPLOAD_URL, and the access token from
# GH_UPLOAD_TOKEN. The file's size decides the route: small files go up in one
# request, larger ones are split here and sent piecewise, because a single
# larger body is rejected at the CDN edge with a 413 before it reaches the
# server.
#
# Prints the download URL on success. Exits non-zero with a message on failure.
#
# Requires: curl, dd, and either jq or python3 for JSON.

set -euo pipefail

FILE="${1:-}"
BASE="${2:-${GH_UPLOAD_URL:-}}"
TOKEN="${GH_UPLOAD_TOKEN:-}"

if [ -z "$FILE" ]; then
  echo "usage: $0 <file> [server-url]   (or set GH_UPLOAD_URL)" >&2
  exit 2
fi
if [ ! -f "$FILE" ]; then
  echo "error: no such file: $FILE" >&2
  exit 2
fi
if [ -z "$BASE" ]; then
  echo "error: server URL required as arg 2 or GH_UPLOAD_URL" >&2
  exit 2
fi
BASE="${BASE%/}"

# Writes need the credential when the server has one configured; reads (the
# download URL) deliberately never do, so whoever receives a link can open it.
#
# The flag list is expanded unquoted below. An empty array would be an error
# under `set -u` on bash 3.2, which macOS still ships, so it is built as a
# plain string that simply expands to nothing when there is no token.
AUTH=""
if [ -n "$TOKEN" ]; then
  AUTH="Authorization: Bearer $TOKEN"
fi

# ---- JSON helpers: prefer jq, fall back to python3 ----
if command -v jq >/dev/null 2>&1; then
  json_get()  { jq -r "$1"; }
  json_arr()  { jq -c "$1"; }
  json_has_jq=1
elif command -v python3 >/dev/null 2>&1; then
  json_get()  { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {"d": d}))' "$1"; }
  json_arr()  { python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps([eval(sys.argv[1], {"x": x}) for x in d]))' "$1"; }
  json_has_jq=0
else
  echo "error: need jq or python3 to parse JSON responses" >&2
  exit 2
fi

# ---- discover the server's limits rather than assuming them ----
CONFIG=$(curl -sS --fail "$BASE/api/v1/config") || {
  echo "error: cannot reach $BASE/api/v1/config" >&2
  exit 1
}
CHUNK=$(printf '%s' "$CONFIG" | json_get 'd["data"]["chunk_size"]')
MAX_SIMPLE=$(printf '%s' "$CONFIG" | json_get 'd["data"]["max_simple_upload"]')
CHUNK="${CHUNK:-16777216}"
MAX_SIMPLE="${MAX_SIMPLE:-$CHUNK}"

# Portable file size.
size_of() {
  wc -c < "$1" | tr -d ' '
}
SIZE=$(size_of "$FILE")
NAME=$(basename "$FILE")

echo "file:   $NAME ($SIZE bytes)" >&2
echo "server: $BASE (chunk size $CHUNK)" >&2

# ---- small file: one multipart request ----
if [ "$SIZE" -le "$MAX_SIMPLE" ]; then
  echo "route:  single request" >&2
  if [ -n "$AUTH" ]; then
    RESP=$(curl -sS --fail -H "$AUTH" -F "file=@$FILE" "$BASE/api/v1/files")
  else
    RESP=$(curl -sS --fail -F "file=@$FILE" "$BASE/api/v1/files")
  fi || {
    echo "error: upload failed (is GH_UPLOAD_TOKEN set and correct?)" >&2
    exit 1
  }
  printf '%s' "$RESP" | json_get 'd["data"]["download_url"]'
  exit 0
fi

# ---- large file: split locally and send piecewise ----
TOTAL=$(( (SIZE + CHUNK - 1) / CHUNK ))
echo "route:  chunked ($TOTAL chunks)" >&2

# A per-attempt session label. The server derives the file's real id from
# content, so this only needs to be unique-ish; retries reuse it.
UPLOAD_ID=$( (head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n') 2>/dev/null || printf '%032d' "$$" )

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Upload one chunk with retries. 503 is the server shedding load — retry it,
# since chunks are content-addressed and stateless.
send_chunk() {
  local idx="$1" file="$2" attempt=0 max=5 out
  while :; do
    attempt=$((attempt + 1))
    local code
    if [ -n "$AUTH" ]; then
      code=$(curl -sS -o "$TMP/resp.json" -w '%{http_code}' \
        -H "$AUTH" \
        --data-binary "@$file" \
        -H "Content-Type: application/octet-stream" \
        "$BASE/api/v1/files/chunks?upload_id=$UPLOAD_ID&index=$idx&total=$TOTAL") || code=000
    else
      code=$(curl -sS -o "$TMP/resp.json" -w '%{http_code}' \
        --data-binary "@$file" \
        -H "Content-Type: application/octet-stream" \
        "$BASE/api/v1/files/chunks?upload_id=$UPLOAD_ID&index=$idx&total=$TOTAL") || code=000
    fi
    case "$code" in
      200)
        printf '%s' "$(json_get 'd["data"]["blob_sha"]' < "$TMP/resp.json")"
        return 0
        ;;
      401|403)
        echo "error: not authorized (HTTP $code). Set GH_UPLOAD_TOKEN to the server's access token." >&2
        return 1
        ;;
      503|429|000)
        if [ "$attempt" -ge "$max" ]; then
          echo "error: chunk $idx still refused after $max attempts" >&2
          return 1
        fi
        sleep "$attempt"
        ;;
      *)
        echo "error: chunk $idx failed (HTTP $code): $(cat "$TMP/resp.json" 2>/dev/null)" >&2
        return 1
        ;;
    esac
  done
}

# Split with dd: one full chunk per piece, no reliance on `split --bytes`.
BLOBS=""
I=1
while [ "$I" -le "$TOTAL" ]; do
  dd if="$FILE" of="$TMP/part" bs="$CHUNK" skip=$((I - 1)) count=1 2>/dev/null
  SHA=$(send_chunk "$I" "$TMP/part") || exit 1
  if [ -z "$BLOBS" ]; then BLOBS="\"$SHA\""; else BLOBS="$BLOBS,\"$SHA\""; fi
  printf '  chunk %s/%s done\n' "$I" "$TOTAL" >&2
  rm -f "$TMP/part"
  I=$((I + 1))
done

# The server derives the file's identity from these ids, so nothing else about
# the content needs to be sent.
BODY="{\"original_name\":\"$NAME\",\"size\":$SIZE,\"total_chunks\":$TOTAL,\"chunks\":[$BLOBS]}"

if [ -n "$AUTH" ]; then
  RESP=$(curl -sS -X POST -H "$AUTH" -H "Content-Type: application/json" \
    --data-binary "$BODY" "$BASE/api/v1/files/complete")
else
  RESP=$(curl -sS -X POST -H "Content-Type: application/json" \
    --data-binary "$BODY" "$BASE/api/v1/files/complete")
fi || {
  echo "error: finalize failed" >&2
  exit 1
}

printf '%s' "$RESP" | json_get 'd["data"]["download_url"]'

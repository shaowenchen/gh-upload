#!/usr/bin/env bash
#
# Upload a file to a gh-upload server.
#
#   ./upload.sh <file> [server-url]
#
# Server URL may also come from GH_UPLOAD_URL. The file's size decides the
# route: small files go up in one request, larger ones are split here and sent
# piecewise, because a single larger body is rejected at the CDN edge with a
# 413 before it reaches the server. Chunks go up several at a time, bounded by
# what the server says it can process.
#
# Prints the download URL on success. Exits non-zero with a message on failure.
#
# Requires: curl, dd, and either jq or python3 for JSON.

set -euo pipefail

FILE="${1:-}"
BASE="${2:-${GH_UPLOAD_URL:-}}"

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
PARALLEL=$(printf '%s' "$CONFIG" | json_get 'd["data"]["max_chunk_concurrency"]')
CHUNK="${CHUNK:-8388608}"
MAX_SIMPLE="${MAX_SIMPLE:-$CHUNK}"
# Bounded by what the server will actually process: sending more than it admits
# only earns 503s and retries, which is slower than staying within it.
PARALLEL="${PARALLEL:-4}"

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
  RESP=$(curl -sS --fail -F "file=@$FILE" "$BASE/api/v1/files") || {
    echo "error: upload failed" >&2
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

# Upload one chunk with retries, then write the blob id to $TMP/sha.$idx.
#
# 503 is the server shedding load — retry it, since chunks are content-addressed
# and stateless. The id goes to a file rather than to stdout because several of
# these run as background jobs at once, and their output would interleave.
send_chunk() {
  local idx="$1" file="$2" attempt=0 max=6
  local resp="$TMP/resp.$idx.json"
  while :; do
    attempt=$((attempt + 1))
    local code
    code=$(curl -sS -o "$resp" -w '%{http_code}' \
      --data-binary "@$file" \
      -H "Content-Type: application/octet-stream" \
      "$BASE/api/v1/files/chunks?upload_id=$UPLOAD_ID&index=$idx&total=$TOTAL") || code=000
    case "$code" in
      200)
        json_get 'd["data"]["blob_sha"]' < "$resp" > "$TMP/sha.$idx"
        return 0
        ;;
      503|429|000)
        if [ "$attempt" -ge "$max" ]; then
          echo "error: chunk $idx still refused after $max attempts" >&2
          break
        fi
        sleep "$attempt"
        ;;
      *)
        echo "error: chunk $idx failed (HTTP $code): $(cat "$resp" 2>/dev/null)" >&2
        break
        ;;
    esac
  done
  return 1
}

# Send the chunks $PARALLEL at a time. Sending them strictly one after another
# made each chunk's round-trip latency additive, and at small chunk sizes that
# latency — not bandwidth — is what dominates the upload.
#
# The batch is sliced just before it is sent and cleared once it is reaped, so
# the temporary copy on disk stays near $PARALLEL chunks rather than growing to
# the size of the whole file.
I=1
FAILED=0
while [ "$I" -le "$TOTAL" ]; do
  pids=""
  batch=0
  while [ "$batch" -lt "$PARALLEL" ] && [ "$I" -le "$TOTAL" ]; do
    dd if="$FILE" of="$TMP/part.$I" bs="$CHUNK" skip=$((I - 1)) count=1 2>/dev/null
    send_chunk "$I" "$TMP/part.$I" &
    pids="$pids $!"
    I=$((I + 1))
    batch=$((batch + 1))
  done
  # Wait on this batch's pids specifically. A bare `wait` returns 0 whatever the
  # jobs did once any of them is reaped, so it would let a failed chunk pass.
  for pid in $pids; do
    wait "$pid" || FAILED=1
  done
  rm -f "$TMP"/part.*
done

if [ "$FAILED" -ne 0 ]; then
  echo "error: one or more chunks failed to upload" >&2
  exit 1
fi

# Ordered by index: the server reconstructs the file from this order, so it is
# read back per chunk rather than accumulated as the jobs finish, which would be
# completion order instead.
BLOBS=""
I=1
while [ "$I" -le "$TOTAL" ]; do
  SHA=$(cat "$TMP/sha.$I")
  if [ -z "$BLOBS" ]; then BLOBS="\"$SHA\""; else BLOBS="$BLOBS,\"$SHA\""; fi
  I=$((I + 1))
done

echo "  uploaded $TOTAL chunks" >&2

# The server derives the file's identity from these ids, so nothing else about
# the content needs to be sent. chunk_size is the split actually used above, so
# the server can reconstruct the file even if its own configured size has
# changed since this script read the config.
BODY="{\"original_name\":\"$NAME\",\"size\":$SIZE,\"total_chunks\":$TOTAL,\"chunk_size\":$CHUNK,\"chunks\":[$BLOBS]}"

RESP=$(curl -sS -X POST -H "Content-Type: application/json" \
  --data-binary "$BODY" "$BASE/api/v1/files/complete") || {
  echo "error: finalize failed" >&2
  exit 1
}

printf '%s' "$RESP" | json_get 'd["data"]["download_url"]'

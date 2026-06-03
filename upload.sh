#!/bin/bash
# Upload a file to gh-upload server
# Usage: ./upload.sh <file> [server_url]

set -e

FILE="$1"
if [ -z "$FILE" ]; then
  echo "Usage: ./upload.sh <file> [server_url]"
  echo "  server_url defaults to http://localhost:3000"
  exit 1
fi

if [ ! -f "$FILE" ]; then
  echo "Error: file not found: $FILE"
  exit 1
fi

SERVER="${2:-http://localhost:3000}"

curl -s -X POST -F "file=@$FILE" "$SERVER/api/v1/files"

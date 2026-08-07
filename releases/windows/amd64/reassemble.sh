#!/usr/bin/env bash
# Join split Windows standalone zip parts into one archive.
set -euo pipefail
cd "$(dirname "$0")"
OUT="forge-database-manager-1.0.0-windows-x86_64-standalone.zip"
PARTS=(forge-database-manager-1.0.0-windows-x86_64-standalone.part-*)
if [[ ! -f "${PARTS[0]}" ]]; then
  echo "No .part-* files found in $(pwd)" >&2
  exit 1
fi
cat "${PARTS[@]}" > "$OUT"
echo "Wrote $OUT ($(du -h "$OUT" | awk '{print $1}'))"
if command -v shasum >/dev/null 2>&1 && [[ -f SHA256SUMS.txt ]]; then
  EXPECTED="$(awk 'NR==1 {print $1}' SHA256SUMS.txt)"
  ACTUAL="$(shasum -a 256 "$OUT" | awk '{print $1}')"
  if [[ "$EXPECTED" == "$ACTUAL" ]]; then
    echo "SHA-256 OK"
  else
    echo "SHA-256 mismatch (expected $EXPECTED, got $ACTUAL)" >&2
    exit 1
  fi
fi

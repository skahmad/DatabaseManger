#!/usr/bin/env bash
# Split the Windows standalone zip into <100 MB parts so it can be pushed to GitHub,
# and refresh releases/windows/amd64 (parts, SHA256SUMS.txt, reassemble scripts).
#
# Usage:
#   ./scripts/build-windows-standalone.sh      # builds binary/windows/amd64/*-standalone.zip
#   ./scripts/split-windows-release.sh         # splits it into releases/windows/amd64
#   ./scripts/split-windows-release.sh --build # build + split in one go
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "${1:-}" == "--build" ]]; then
  "$ROOT/scripts/build-windows-standalone.sh"
fi

APP_VERSION="$(sed -n 's:.*<version>\(.*\)</version>.*:\1:p' pom.xml | head -1)"
BASE="forge-database-manager-${APP_VERSION}-windows-x86_64-standalone"
ZIP="$ROOT/binary/windows/amd64/${BASE}.zip"
OUT_DIR="$ROOT/releases/windows/amd64"
PART_SIZE=$(( ${PART_SIZE_MB:-90} * 1024 * 1024 ))   # 90 MiB default — safely under GitHub's 100 MB limit

if [[ ! -f "$ZIP" ]]; then
  echo "Not found: $ZIP" >&2
  echo "Run ./scripts/build-windows-standalone.sh first (or pass --build)." >&2
  exit 1
fi

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

mkdir -p "$OUT_DIR"
# Remove old parts (any version) so stale pieces never get reassembled.
find "$OUT_DIR" -maxdepth 1 -name 'forge-database-manager-*-standalone.part-*' -exec rm -f {} +

echo "==> Splitting $(basename "$ZIP") into ${PART_SIZE_MB:-90} MB parts"
# Portable split (BSD/macOS split lacks -d on older versions): letters, then renumber 00, 01, …
TMP_SPLIT="$(mktemp -d)"
trap 'rm -rf "$TMP_SPLIT"' EXIT
split -b "$PART_SIZE" -a 3 "$ZIP" "$TMP_SPLIT/chunk-"
i=0
for chunk in $(ls "$TMP_SPLIT" | sort); do
  mv "$TMP_SPLIT/$chunk" "$OUT_DIR/${BASE}.part-$(printf '%02d' "$i")"
  i=$((i + 1))
done
PARTS=()
while IFS= read -r p; do PARTS+=("$(basename "$p")"); done \
  < <(find "$OUT_DIR" -maxdepth 1 -name "${BASE}.part-*" | sort)

echo "==> Writing SHA256SUMS.txt"
{
  echo "$(sha256 "$ZIP")  ${BASE}.zip"
  echo
  echo "# Split parts (reassemble with ./reassemble.sh or reassemble.bat):"
  for p in "${PARTS[@]}"; do echo "$(sha256 "$OUT_DIR/$p")  $p"; done
} > "$OUT_DIR/SHA256SUMS.txt"

echo "==> Updating reassemble scripts"
cat > "$OUT_DIR/reassemble.sh" <<SH
#!/usr/bin/env bash
# Join split Windows standalone zip parts into one archive.
set -euo pipefail
cd "\$(dirname "\$0")"
OUT="${BASE}.zip"
PARTS=(${BASE}.part-*)
if [[ ! -f "\${PARTS[0]}" ]]; then
  echo "No .part-* files found in \$(pwd)" >&2
  exit 1
fi
cat "\${PARTS[@]}" > "\$OUT"
echo "Wrote \$OUT (\$(du -h "\$OUT" | awk '{print \$1}'))"
if command -v shasum >/dev/null 2>&1 && [[ -f SHA256SUMS.txt ]]; then
  EXPECTED="\$(awk 'NR==1 {print \$1}' SHA256SUMS.txt)"
  ACTUAL="\$(shasum -a 256 "\$OUT" | awk '{print \$1}')"
  if [[ "\$EXPECTED" == "\$ACTUAL" ]]; then
    echo "SHA-256 OK"
  else
    echo "SHA-256 mismatch (expected \$EXPECTED, got \$ACTUAL)" >&2
    exit 1
  fi
fi
SH
chmod +x "$OUT_DIR/reassemble.sh"

COPY_ARGS="$(printf ' + %s' "${PARTS[@]}")"
COPY_ARGS="${COPY_ARGS# + }"
cat > "$OUT_DIR/reassemble.bat" <<BAT
@echo off
setlocal
cd /d "%~dp0"
set "OUT=${BASE}.zip"
echo Assembling %OUT% ...
copy /b ${COPY_ARGS} "%OUT%" >nul
if errorlevel 1 (
  echo Failed to assemble parts.
  pause
  exit /b 1
)
echo Done: %OUT%
echo Unzip it, then run "DB Pilot.vbs".
pause
endlocal
BAT
perl -pi -e 's/\r?\n/\r\n/' "$OUT_DIR/reassemble.bat" 2>/dev/null || true

# Keep the version in the release README in sync.
if [[ -f "$OUT_DIR/README.md" ]]; then
  perl -pi -e "s/forge-database-manager-[0-9][^-]*-windows-x86_64-standalone/${BASE}/g" "$OUT_DIR/README.md"
fi

echo
echo "Release parts ready in releases/windows/amd64:"
ls -lh "$OUT_DIR" | awk 'NR>1 {print "  " $5 "\t" $9}'
echo
echo "Commit them with:"
echo "  git add releases/windows/amd64 && git commit -m \"Refresh Windows standalone release parts.\""

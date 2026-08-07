#!/usr/bin/env bash
# Build a Windows installable / portable binary for DB Pilot.
# Must run on Windows (Git Bash / MSYS) with JDK 21+ (jpackage).
# Cross-building from macOS/Linux is not supported by jpackage.
#
# Usage:
#   ./scripts/build-windows.sh
#   ./scripts/build-windows.sh --type=exe
#   ./scripts/build-windows.sh --type=msi
#   ./scripts/build-windows.sh --type=app-image
#
# Default: app-image (portable folder + zip). exe/msi need WiX Toolset.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PACKAGE_TYPE="${PACKAGE_TYPE:-app-image}"

for arg in "$@"; do
  case "$arg" in
    --type=*) PACKAGE_TYPE="${arg#--type=}" ;;
    --help|-h)
      cat <<'EOF'
Usage: ./scripts/build-windows.sh [options]

Options:
  --type=app-image   Portable app folder + zip (default, no WiX needed)
  --type=exe         Windows installer (.exe) — requires WiX Toolset
  --type=msi         Windows installer (.msi) — requires WiX Toolset

Requires Windows + JDK 21+ with jpackage on PATH (or JAVA_HOME set).
On macOS/Linux, run this script inside a Windows VM or CI runner.
EOF
      exit 0
      ;;
  esac
done

OS="$(uname -s 2>/dev/null || echo unknown)"
case "$OS" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) ;;
  *)
    if [[ -n "${WINDIR:-}" || -n "${SystemRoot:-}" ]]; then
      :
    else
      echo "Windows packages must be built on Windows (jpackage cannot cross-compile)." >&2
      echo "On a Windows machine with JDK 21+:" >&2
      echo "  ./scripts/build-windows.sh" >&2
      echo "  # or" >&2
      echo "  powershell -File scripts/build-windows.ps1" >&2
      exit 1
    fi
    ;;
esac

case "$PACKAGE_TYPE" in
  app-image|exe|msi) ;;
  *) echo "Unsupported package type: $PACKAGE_TYPE (use app-image, exe, or msi)" >&2; exit 1 ;;
esac

if [[ -z "${JAVA_HOME:-}" ]]; then
  for candidate in \
    "/c/Program Files/Java"/jdk-21* \
    "/c/Program Files/Eclipse Adoptium"/jdk-21* \
    "/c/Program Files/Microsoft"/jdk-21* \
    "$HOME/.local/jdks"/jdk-21*
  do
    if [[ -x "${candidate}/bin/jpackage.exe" || -x "${candidate}/bin/jpackage" ]]; then
      export JAVA_HOME="$candidate"
      break
    fi
  done
fi
[[ -n "${JAVA_HOME:-}" ]] && export PATH="$JAVA_HOME/bin:$PATH"

if ! command -v jpackage >/dev/null 2>&1 && ! command -v jpackage.exe >/dev/null 2>&1; then
  echo "jpackage not found. Install JDK 21+ and set JAVA_HOME." >&2
  exit 1
fi

ARCH="$(uname -m 2>/dev/null || echo x86_64)"
case "$ARCH" in
  aarch64|arm64)
    JFX_PLATFORM="win-aarch64"
    ARCH_DIR="arm64"
    ;;
  *)
    JFX_PLATFORM="win"
    ARCH_DIR="amd64"
    ARCH="x86_64"
    ;;
esac

APP_NAME="DB Pilot"
APP_VERSION="1.0.0"
MAIN_CLASS="com.forgesystem.dbmanager.Launcher"
VENDOR="Forge System"
SRC_ICON="$ROOT/src/main/resources/icons/app-icon.png"
# Fallback if resources icon missing (built copy)
[[ -f "$SRC_ICON" ]] || SRC_ICON="$ROOT/target/classes/icons/app-icon.png"
WIN_ICON="$ROOT/packaging/windows/AppIcon.ico"
INPUT_DIR="$ROOT/target/jpackage-input"
DIST_DIR="$ROOT/dist/windows/$ARCH_DIR"

echo "==> Target arch: $ARCH_DIR ($ARCH)"
echo "==> JavaFX platform: $JFX_PLATFORM"
echo "==> Package type: $PACKAGE_TYPE"
echo "==> Building application jars"

mvn -q -DskipTests clean package \
  -Djavafx.platform="$JFX_PLATFORM" \
  -Dshade.skip=true

echo "==> Assembling jpackage input"
rm -rf "$INPUT_DIR"
mkdir -p "$INPUT_DIR"
cp "$ROOT/target/database-manager-${APP_VERSION}.jar" "$INPUT_DIR/"
mvn -q dependency:copy-dependencies \
  -Djavafx.platform="$JFX_PLATFORM" \
  -DoutputDirectory="$INPUT_DIR" \
  -DincludeScope=runtime

echo "==> Preparing Windows icon"
mkdir -p "$ROOT/packaging/windows"
ICON_ARGS=()
if [[ -f "$SRC_ICON" ]]; then
  if command -v magick >/dev/null 2>&1; then
    magick "$SRC_ICON" -define icon:auto-resize=256,128,64,48,32,16 "$WIN_ICON"
  elif command -v convert >/dev/null 2>&1; then
    convert "$SRC_ICON" -define icon:auto-resize=256,128,64,48,32,16 "$WIN_ICON"
  elif [[ -f "$WIN_ICON" ]]; then
    echo "    Using existing $WIN_ICON"
  else
    echo "    Warning: ImageMagick not found; building without custom .ico"
    echo "    Install ImageMagick or place AppIcon.ico in packaging/windows/"
  fi
  [[ -f "$WIN_ICON" ]] && ICON_ARGS=(--icon "$WIN_ICON")
fi

echo "==> Creating Windows package with jpackage"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

JPACKAGE=(jpackage)
command -v jpackage.exe >/dev/null 2>&1 && JPACKAGE=(jpackage.exe)

YEAR="$(date +%Y 2>/dev/null || echo 2026)"

JPACKAGE_ARGS=(
  --type "$PACKAGE_TYPE"
  --name "$APP_NAME"
  --app-version "$APP_VERSION"
  --vendor "$VENDOR"
  --copyright "Copyright (c) $YEAR $VENDOR"
  --description "Desktop database manager with embedded HTML UI"
  --input "$INPUT_DIR"
  --main-jar "database-manager-${APP_VERSION}.jar"
  --main-class "$MAIN_CLASS"
  --dest "$DIST_DIR"
  --java-options "-Dfile.encoding=UTF-8"
)
if [[ ${#ICON_ARGS[@]} -gt 0 ]]; then
  JPACKAGE_ARGS+=("${ICON_ARGS[@]}")
fi
if [[ "$PACKAGE_TYPE" == "exe" || "$PACKAGE_TYPE" == "msi" ]]; then
  JPACKAGE_ARGS+=(--win-menu --win-shortcut)
fi

"${JPACKAGE[@]}" "${JPACKAGE_ARGS[@]}"

if [[ "$PACKAGE_TYPE" == "app-image" ]]; then
  echo "==> Creating portable zip"
  (
    cd "$DIST_DIR"
    APP_DIR="$(find . -maxdepth 1 -type d ! -name . | head -1)"
    if command -v zip >/dev/null 2>&1; then
      zip -r -q "forge-database-manager-${APP_VERSION}-windows-${ARCH}.zip" "$APP_DIR"
    else
      echo "    zip not found; skipping archive (app-image folder still available)"
    fi
  )
fi

BINARY_DIR="$ROOT/binary/windows/$ARCH_DIR"
mkdir -p "$BINARY_DIR"
shopt -s nullglob
for artifact in "$DIST_DIR"/*.{exe,msi,zip}; do
  [[ -f "$artifact" ]] && cp "$artifact" "$BINARY_DIR/"
done
if [[ "$PACKAGE_TYPE" == "app-image" ]]; then
  for dir in "$DIST_DIR"/*/; do
    [[ -d "$dir" ]] || continue
    base="$(basename "$dir")"
    rm -rf "$BINARY_DIR/$base"
    cp -R "$dir" "$BINARY_DIR/"
  done
fi
shopt -u nullglob

echo
echo "Windows $ARCH_DIR package(s) created in:"
echo "  $BINARY_DIR"
ls -lh "$BINARY_DIR" 2>/dev/null | sed 's/^/  /' || ls -la "$BINARY_DIR"
echo
echo "Run the app from the app-image folder, or install the .exe / .msi if built."
echo "For exe/msi installers, install WiX Toolset 3.x then re-run with --type=exe"

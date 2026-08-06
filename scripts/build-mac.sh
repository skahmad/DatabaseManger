#!/usr/bin/env bash
# Build a macOS .app + .dmg installable for Forge Database Manager.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -z "${JAVA_HOME:-}" ]]; then
  for candidate in \
    "$HOME/.local/jdks/jdk-21.0.12+8/Contents/Home" \
    "$HOME/.local/jdks"/jdk-21*/Contents/Home
  do
    if [[ -x "${candidate}/bin/jpackage" ]]; then
      export JAVA_HOME="$candidate"
      break
    fi
  done
fi
[[ -n "${JAVA_HOME:-}" ]] && export PATH="$JAVA_HOME/bin:$PATH"

if ! command -v jpackage >/dev/null; then
  echo "jpackage not found. Install JDK 21+ and set JAVA_HOME." >&2
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) JFX_PLATFORM="mac-aarch64" ;;
  x86_64)        JFX_PLATFORM="mac" ;;
  *) echo "Unsupported Mac arch: $ARCH" >&2; exit 1 ;;
esac

APP_NAME="Forge Database Manager"
APP_VERSION="1.0.0"
MAIN_CLASS="com.forgesystem.dbmanager.Launcher"
VENDOR="Forge System"
BUNDLE_ID="com.forgesystem.databasemanager"

ICONSET="$ROOT/packaging/macos/AppIcon.iconset"
ICNS="$ROOT/packaging/macos/AppIcon.icns"
SRC_ICON="$ROOT/src/main/resources/icons/app-icon.png"
INPUT_DIR="$ROOT/target/jpackage-input"
DIST_DIR="$ROOT/dist"

echo "==> JavaFX platform: $JFX_PLATFORM"
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

echo "==> Preparing Mac icon"
mkdir -p "$ROOT/packaging/macos"
rm -rf "$ICONSET" "$ICNS"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$SRC_ICON" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  if [[ "$double" -le 1024 ]]; then
    sips -z "$double" "$double" "$SRC_ICON" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  fi
done
# 1024@2x not required; include 512@2x (=1024)
cp "$SRC_ICON" "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$ICNS"
rm -rf "$ICONSET"

echo "==> Creating macOS .dmg with jpackage"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

jpackage \
  --type dmg \
  --name "$APP_NAME" \
  --app-version "$APP_VERSION" \
  --vendor "$VENDOR" \
  --copyright "Copyright © $(date +%Y) $VENDOR" \
  --description "Desktop database manager with embedded HTML UI" \
  --input "$INPUT_DIR" \
  --main-jar "database-manager-${APP_VERSION}.jar" \
  --main-class "$MAIN_CLASS" \
  --dest "$DIST_DIR" \
  --icon "$ICNS" \
  --mac-package-identifier "$BUNDLE_ID" \
  --mac-package-name "Forge DB Manager" \
  --java-options "-Dfile.encoding=UTF-8" \
  --java-options "--enable-native-access=ALL-UNNAMED" \
  --java-options "-Djdk.gtk.version=3"

DMG="$(ls -1 "$DIST_DIR"/*.dmg | head -1)"
BINARY_DIR="$ROOT/binary/mac"
mkdir -p "$BINARY_DIR"
cp "$DMG" "$BINARY_DIR/"
BINARY_DMG="$BINARY_DIR/$(basename "$DMG")"

echo
echo "Installable created:"
echo "  $BINARY_DMG"
ls -lh "$BINARY_DMG"
echo
echo "Open the DMG and drag \"$APP_NAME\" into Applications."
echo "If Gatekeeper blocks it: right-click the app → Open (once)."

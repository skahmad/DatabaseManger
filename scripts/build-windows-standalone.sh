#!/usr/bin/env bash
# Build a standalone Windows x64 package with a bundled JRE (no system Java required).
# Can run on macOS/Linux — downloads a Windows JRE and packs jars + launcher.
#
# Usage:
#   ./scripts/build-windows-standalone.sh
#
# Output:
#   binary/windows/amd64/forge-database-manager-*-windows-x86_64-standalone.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_NAME="DB Pilot"
APP_VERSION="1.0.0"
MAIN_CLASS="com.forgesystem.dbmanager.Launcher"
JFX_PLATFORM="win"
ARCH="x86_64"
ARCH_DIR="amd64"

OUT_DIR="$ROOT/binary/windows/$ARCH_DIR"
PORTABLE_DIR="$OUT_DIR/$APP_NAME"
CACHE_DIR="$ROOT/.cache/windows-jre"
JRE_ZIP="$CACHE_DIR/OpenJDK21U-jre_x64_windows_hotspot.zip"
ADOPTIUM_URL="https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse?project=jdk"

if [[ -z "${JAVA_HOME:-}" ]]; then
  for candidate in \
    "$HOME/.local/jdks"/jdk-21*/Contents/Home \
    "$HOME/.local/jdks"/jdk-21* \
    "/Library/Java/JavaVirtualMachines"/jdk-21*.jdk/Contents/Home
  do
    if [[ -x "${candidate}/bin/java" ]]; then
      export JAVA_HOME="$candidate"
      break
    fi
  done
fi
[[ -n "${JAVA_HOME:-}" ]] && export PATH="$JAVA_HOME/bin:$PATH"

if ! command -v java >/dev/null 2>&1; then
  echo "JDK 21+ required to build (java not found)." >&2
  exit 1
fi

echo "==> Building application jars (JavaFX platform: $JFX_PLATFORM)"
mvn -q -DskipTests clean package \
  -Djavafx.platform="$JFX_PLATFORM" \
  -Dshade.skip=true

echo "==> Fetching Windows x64 JRE 21 (cached under .cache/windows-jre)"
mkdir -p "$CACHE_DIR"
if [[ ! -f "$JRE_ZIP" ]]; then
  curl -fsSL -L -o "$JRE_ZIP.partial" "$ADOPTIUM_URL"
  mv "$JRE_ZIP.partial" "$JRE_ZIP"
fi
ls -lh "$JRE_ZIP"

echo "==> Assembling standalone package"
rm -rf "$PORTABLE_DIR"
mkdir -p "$PORTABLE_DIR/lib" "$PORTABLE_DIR/runtime"

cp "$ROOT/target/database-manager-${APP_VERSION}.jar" "$PORTABLE_DIR/lib/"
mvn -q dependency:copy-dependencies \
  -Djavafx.platform="$JFX_PLATFORM" \
  -DoutputDirectory="$PORTABLE_DIR/lib" \
  -DincludeScope=runtime

if [[ -f "$ROOT/src/main/resources/icons/app-icon.png" ]]; then
  cp "$ROOT/src/main/resources/icons/app-icon.png" "$PORTABLE_DIR/"
fi

# Unpack JRE into runtime/ (zip top-level is usually jdk-21.x.x+y-jre/)
TMP_JRE="$(mktemp -d)"
trap 'rm -rf "$TMP_JRE"' EXIT
unzip -q "$JRE_ZIP" -d "$TMP_JRE"
JAVA_EXE="$(find "$TMP_JRE" -type f -name 'java.exe' | head -1)"
if [[ -z "$JAVA_EXE" ]]; then
  echo "Could not locate java.exe in downloaded JRE zip." >&2
  exit 1
fi
JRE_ROOT="$(cd "$(dirname "$JAVA_EXE")/.." && pwd)"
if [[ ! -f "$JRE_ROOT/bin/java.exe" ]]; then
  echo "Unexpected JRE layout under: $JRE_ROOT" >&2
  exit 1
fi
cp -R "$JRE_ROOT"/. "$PORTABLE_DIR/runtime/"

# GUI launcher (no console): .vbs is the primary entry; .bat kept for debugging
cat > "$PORTABLE_DIR/${APP_NAME}.vbs" <<EOF
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
javaw = dir & "\runtime\bin\javaw.exe"
If Not fso.FileExists(javaw) Then
  MsgBox "Bundled Java runtime not found. Re-download the standalone package.", vbCritical, "${APP_NAME}"
  WScript.Quit 1
End If
' WindowStyle 0 = hidden (no console); WaitOnReturn = False
sh.CurrentDirectory = dir
sh.Run """" & javaw & """ -Dfile.encoding=UTF-8 -cp ""lib\*"" com.forgesystem.dbmanager.Launcher", 0, False
EOF
perl -pi -e 's/\r?\n/\r\n/' "$PORTABLE_DIR/${APP_NAME}.vbs" 2>/dev/null || true

# Optional console launcher for troubleshooting startup errors
cat > "$PORTABLE_DIR/${APP_NAME}.bat" <<EOF
@echo off
setlocal
cd /d "%~dp0"
set "JAVA_EXE=%~dp0runtime\bin\java.exe"
if not exist "%JAVA_EXE%" (
  echo Bundled Java runtime not found. Re-download the standalone package.
  pause
  exit /b 1
)
echo Starting ${APP_NAME}...
"%JAVA_EXE%" -Dfile.encoding=UTF-8 -cp "lib\*" com.forgesystem.dbmanager.Launcher
if errorlevel 1 pause
endlocal
EOF
perl -pi -e 's/\r?\n/\r\n/' "$PORTABLE_DIR/${APP_NAME}.bat" 2>/dev/null || true

# Convenience: double-click "Start.vbs" or the main .vbs — no black console window
cp "$PORTABLE_DIR/${APP_NAME}.vbs" "$PORTABLE_DIR/Start.vbs"

ZIP_NAME="forge-database-manager-${APP_VERSION}-windows-${ARCH}-standalone.zip"
rm -f "$OUT_DIR/$ZIP_NAME"
mkdir -p "$OUT_DIR"
(
  cd "$OUT_DIR"
  zip -r -q "$ZIP_NAME" "$APP_NAME" -x "*.DS_Store" -x "__MACOSX*"
)

echo
echo "Standalone Windows x64 package created:"
echo "  $OUT_DIR/$ZIP_NAME"
ls -lh "$OUT_DIR/$ZIP_NAME"
echo
echo "On Windows: unzip and run \"${APP_NAME}.vbs\" (or Start.vbs) — no console, no system Java."
echo "Use \"${APP_NAME}.bat\" only to debug startup errors in a console."

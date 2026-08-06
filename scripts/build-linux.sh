#!/usr/bin/env bash
# Build a Linux installable package for Forge Database Manager.
# On macOS/Windows, builds inside Docker (JDK 21 + jpackage).
# On Linux, builds natively.
#
# IMPORTANT: package arch must match the install machine.
#   Intel/AMD Linux PC  → amd64  (./scripts/build-linux.sh --platform=linux/amd64)
#   ARM Linux (Pi, etc.) → arm64  (./scripts/build-linux.sh --platform=linux/arm64)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_NAME="Forge Database Manager"
APP_VERSION="1.0.0"
MAIN_CLASS="com.forgesystem.dbmanager.Launcher"
VENDOR="Forge System"
SRC_ICON="$ROOT/src/main/resources/icons/app-icon.png"
INPUT_DIR="$ROOT/target/jpackage-input"
LINUX_ICON="$ROOT/packaging/linux/AppIcon.png"

IN_CONTAINER=false
PACKAGE_TYPE="${PACKAGE_TYPE:-deb}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-}"
BUILD_ALL=false

for arg in "$@"; do
  case "$arg" in
    --in-container) IN_CONTAINER=true ;;
    --type=*) PACKAGE_TYPE="${arg#--type=}" ;;
    --platform=*) DOCKER_PLATFORM="${arg#--platform=}" ;;
    --all) BUILD_ALL=true ;;
    --help|-h)
      cat <<'EOF'
Usage: ./scripts/build-linux.sh [options]

Options:
  --platform=linux/amd64   Build for Intel/AMD Linux (most PCs/VMs)
  --platform=linux/arm64   Build for ARM Linux
  --all                    Build both amd64 and arm64 (via Docker)
  --type=deb|rpm|app-image Package format (default: deb)

Match the package arch to the machine you install on:
  dpkg --print-architecture   # debian/ubuntu → amd64 or arm64
  uname -m                    # x86_64 → amd64, aarch64 → arm64

When not running on Linux, Docker is used automatically.
From macOS, default target is linux/amd64 (typical Linux desktop/server).
EOF
      exit 0
      ;;
  esac
done

run_docker_build() {
  local platform="$1"
  echo "==> Building Linux package via Docker ($platform, type=$PACKAGE_TYPE)"
  docker run --rm \
    --platform "$platform" \
    -v "$ROOT:/work" \
    -w /work \
    -e PACKAGE_TYPE="$PACKAGE_TYPE" \
    -e HOST_UID="$(id -u)" \
    -e HOST_GID="$(id -g)" \
    maven:3.9.9-eclipse-temurin-21 \
    bash -lc '
      set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq fakeroot rpm binutils >/dev/null
      bash scripts/build-linux.sh --in-container --type='"$PACKAGE_TYPE"'
      chown -R "${HOST_UID}:${HOST_GID}" /work/dist /work/binary /work/target /work/packaging/linux || true
    '
}

# Re-exec inside Docker when not on Linux (and not already in container)
if [[ "$(uname -s)" != "Linux" && "$IN_CONTAINER" != "true" ]]; then
  if ! command -v docker >/dev/null; then
    echo "Docker is required to build Linux packages from $(uname -s)." >&2
    echo "Install Docker, or run this script on a Linux machine." >&2
    exit 1
  fi

  if [[ "$BUILD_ALL" == "true" ]]; then
    run_docker_build "linux/amd64"
    run_docker_build "linux/arm64"
    echo
    echo "Both architectures built under binary/linux/amd64 and binary/linux/arm64"
    exit 0
  fi

  if [[ -z "$DOCKER_PLATFORM" ]]; then
    # Default to amd64 when cross-building: most Linux desktops/servers are x86_64.
    DOCKER_PLATFORM="linux/amd64"
    echo "==> No --platform set; defaulting to linux/amd64 (use --platform=linux/arm64 for ARM Linux)"
  fi

  run_docker_build "$DOCKER_PLATFORM"
  exit $?
fi

if [[ -z "${JAVA_HOME:-}" ]]; then
  for candidate in \
    "/opt/java/openjdk" \
    "$HOME/.local/jdks"/jdk-21* \
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
  aarch64|arm64)
    JFX_PLATFORM="linux-aarch64"
    ARCH_DIR="arm64"
    ;;
  x86_64|amd64)
    JFX_PLATFORM="linux"
    ARCH_DIR="amd64"
    ARCH="x86_64"
    ;;
  *) echo "Unsupported Linux arch: $ARCH" >&2; exit 1 ;;
esac

DIST_DIR="$ROOT/dist/linux/$ARCH_DIR"

case "$PACKAGE_TYPE" in
  deb|rpm|app-image) ;;
  *) echo "Unsupported package type: $PACKAGE_TYPE (use deb, rpm, or app-image)" >&2; exit 1 ;;
esac

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

echo "==> Preparing Linux icon"
mkdir -p "$ROOT/packaging/linux"
cp "$SRC_ICON" "$LINUX_ICON"

echo "==> Creating Linux package with jpackage"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

JPACKAGE_ARGS=(
  --type "$PACKAGE_TYPE"
  --name "$APP_NAME"
  --app-version "$APP_VERSION"
  --vendor "$VENDOR"
  --copyright "Copyright © $(date +%Y) $VENDOR"
  --description "Desktop database manager with embedded HTML UI"
  --input "$INPUT_DIR"
  --main-jar "database-manager-${APP_VERSION}.jar"
  --main-class "$MAIN_CLASS"
  --dest "$DIST_DIR"
  --icon "$LINUX_ICON"
  --linux-package-name "forge-database-manager"
  --linux-app-category "Development"
  --java-options "-Dfile.encoding=UTF-8"
  --java-options "-Djdk.gtk.version=3"
)

if [[ "$PACKAGE_TYPE" == "deb" || "$PACKAGE_TYPE" == "rpm" ]]; then
  JPACKAGE_ARGS+=(--linux-menu-group "Development;Database;")
fi

jpackage "${JPACKAGE_ARGS[@]}"

if [[ "$PACKAGE_TYPE" == "deb" || "$PACKAGE_TYPE" == "rpm" ]]; then
  echo "==> Also creating portable app-image tarball"
  APP_IMAGE_DIR="$DIST_DIR/app-image"
  mkdir -p "$APP_IMAGE_DIR"
  jpackage \
    --type app-image \
    --name "$APP_NAME" \
    --app-version "$APP_VERSION" \
    --vendor "$VENDOR" \
    --description "Desktop database manager with embedded HTML UI" \
    --input "$INPUT_DIR" \
    --main-jar "database-manager-${APP_VERSION}.jar" \
    --main-class "$MAIN_CLASS" \
    --dest "$APP_IMAGE_DIR" \
    --icon "$LINUX_ICON" \
    --java-options "-Dfile.encoding=UTF-8" \
    --java-options "-Djdk.gtk.version=3"
  (
    cd "$APP_IMAGE_DIR"
    tar -czf "$DIST_DIR/forge-database-manager-${APP_VERSION}-linux-${ARCH}.tar.gz" *
  )
fi

BINARY_DIR="$ROOT/binary/linux/$ARCH_DIR"
mkdir -p "$BINARY_DIR"
# Copy installers only (skip app-image/ build tree)
shopt -s nullglob
for artifact in "$DIST_DIR"/*.{deb,rpm,tar.gz}; do
  [[ -f "$artifact" ]] && cp "$artifact" "$BINARY_DIR/"
done
shopt -u nullglob

echo
echo "Linux $ARCH_DIR package(s) created in:"
echo "  $BINARY_DIR"
ls -lh "$BINARY_DIR" | sed 's/^/  /'
echo
echo "On the Linux machine, confirm arch first:"
echo "  dpkg --print-architecture   # expect: $ARCH_DIR"
echo "Then install:"
echo "  sudo apt install ./binary/linux/$ARCH_DIR/*.deb"

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# ── Java for this project ───────────────────────────────────────────────
# DB Pilot is built and run with Java 21. This script always uses a Java 21 JDK,
# whatever JAVA_HOME your shell has. It only affects this script's process;
# the Java used by the rest of your Mac is unchanged.
#
# Pinned JDK for this project (override for one run with DBPILOT_JAVA_HOME=...).
PROJECT_JAVA_HOME="${DBPILOT_JAVA_HOME:-$HOME/.local/jdks/jdk-21.0.12+8/Contents/Home}"
REQUIRED_JAVA=21

java_major() {
  local home="$1" v
  [[ -x "$home/bin/java" ]] || return 1
  if [[ -f "$home/release" ]]; then
    v="$(sed -n 's/^JAVA_VERSION="\([^"]*\)".*/\1/p' "$home/release")"
  else
    v="$("$home/bin/java" -version 2>&1 | sed -n 's/.*version "\([^"]*\)".*/\1/p' | head -1)"
  fi
  v="${v#1.}"
  echo "${v%%[.+-]*}"
}

is_required_java() {
  local m
  m="$(java_major "$1" 2>/dev/null)" || return 1
  [[ "$m" == "$REQUIRED_JAVA" ]]
}

# A pinned JDK must be Java 21 — fail rather than silently picking another one.
if [[ -n "${DBPILOT_JAVA_HOME:-}" ]] && ! is_required_java "$PROJECT_JAVA_HOME"; then
  echo "PROJECT_JAVA_HOME is not a Java $REQUIRED_JAVA JDK: $PROJECT_JAVA_HOME" >&2
  exit 1
fi
candidates=()
[[ -n "$PROJECT_JAVA_HOME" ]] && candidates+=("$PROJECT_JAVA_HOME")
if [[ -x /usr/libexec/java_home ]]; then
  jh="$(/usr/libexec/java_home -v "$REQUIRED_JAVA" 2>/dev/null || true)"
  [[ -n "$jh" ]] && candidates+=("$jh")
fi
candidates+=(
  "$HOME/.local/jdks"/jdk-"$REQUIRED_JAVA"*/Contents/Home
  "$HOME/.local/jdks"/jdk-"$REQUIRED_JAVA"*
  /opt/homebrew/opt/openjdk@"$REQUIRED_JAVA"/libexec/openjdk.jdk/Contents/Home
  /usr/local/opt/openjdk@"$REQUIRED_JAVA"/libexec/openjdk.jdk/Contents/Home
  /Library/Java/JavaVirtualMachines/*"$REQUIRED_JAVA"*/Contents/Home
  /usr/lib/jvm/*"$REQUIRED_JAVA"*
)

FOUND=""
for candidate in "${candidates[@]}"; do
  if is_required_java "$candidate"; then
    FOUND="$candidate"
    break
  fi
done

if [[ -z "$FOUND" ]]; then
  echo "DB Pilot needs Java $REQUIRED_JAVA, but no Java $REQUIRED_JAVA JDK was found." >&2
  echo "Install one with:  brew install openjdk@$REQUIRED_JAVA" >&2
  echo "or set PROJECT_JAVA_HOME at the top of run.sh to its path." >&2
  exit 1
fi

export JAVA_HOME="$FOUND"
export PATH="$JAVA_HOME/bin:$PATH"
echo "Using Java $(java_major "$JAVA_HOME") at $JAVA_HOME"

echo "Starting DB Pilot (desktop + embedded HTML UI)"
exec mvn -q javafx:run

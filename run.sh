#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ -z "${JAVA_HOME:-}" ]]; then
  for candidate in \
    "$HOME/.local/jdks/jdk-21.0.12+8/Contents/Home" \
    "$HOME/.local/jdks"/jdk-21*/Contents/Home
  do
    if [[ -x "${candidate}/bin/java" ]]; then
      export JAVA_HOME="$candidate"
      break
    fi
  done
fi
[[ -n "${JAVA_HOME:-}" ]] && export PATH="$JAVA_HOME/bin:$PATH"

echo "Starting DB Pilot (desktop + embedded HTML UI)"
exec mvn -q javafx:run

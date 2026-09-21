#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V2_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$V2_DIR"

for name in OUTPUT_ONLY VISUAL_ONLY BOTTOM_TAIL_ONLY DYNAMIC_ONLY RELIABILITY_ONLY COMPLEX_ONLY NESTED_ONLY ADAPTIVE_ONLY PROOF_ONLY FULL_NESTED_ONLY DIAGNOSTICS_ONLY POLICY_ONLY NATIVE_DPR; do
  unset "$name" || true
done

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found (Node 22+ required)." >&2
  exit 2
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 22 )); then
  echo "ERROR: Node 22+ required; found $(node -v)." >&2
  exit 2
fi

if [[ -z "${CHROME_EXECUTABLE:-}" && -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  export CHROME_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
fi

if ! node -e "require.resolve('playwright'); require.resolve('pngjs')" >/dev/null 2>&1; then
  echo "ERROR: Playwright and pngjs must be resolvable. Set NODE_PATH to the directory that contains them." >&2
  exit 2
fi

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/long-page-screenshot-v2-final-XXXXXX")"
SUMMARY="$LOG_DIR/summary.txt"
: > "$SUMMARY"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "branch=$(git branch --show-current)" | tee -a "$SUMMARY"
  echo "head=$(git rev-parse HEAD)" | tee -a "$SUMMARY"
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "ERROR: working tree is not clean; final regression requires a clean checkout." | tee -a "$SUMMARY" >&2
    exit 2
  fi
fi

echo "node=$(node -v)" | tee -a "$SUMMARY"
echo "chrome=${CHROME_EXECUTABLE:-playwright-default}" | tee -a "$SUMMARY"
echo "logs=$LOG_DIR" | tee -a "$SUMMARY"

run_group() {
  local label="$1"
  shift
  local log="$LOG_DIR/${label}.log"
  echo "" | tee -a "$SUMMARY"
  echo "=== RUN $label ===" | tee -a "$SUMMARY"
  if "$@" 2>&1 | tee "$log"; then
    echo "PASS $label" | tee -a "$SUMMARY"
  else
    local rc="${PIPESTATUS[0]}"
    echo "FAIL $label (exit=$rc)" | tee -a "$SUMMARY" >&2
    echo "See: $log" >&2
    exit "$rc"
  fi
}

run_group node-all node --test tests/*.test.mjs
run_group chrome-base node tests/browser.mjs
run_group chrome-output env OUTPUT_ONLY=1 node tests/browser.mjs
run_group chrome-policy env POLICY_ONLY=1 node tests/browser.mjs
run_group chrome-visual env VISUAL_ONLY=1 node tests/browser.mjs
run_group chrome-bottom-tail env BOTTOM_TAIL_ONLY=1 node tests/browser.mjs
run_group chrome-adaptive env ADAPTIVE_ONLY=1 node tests/browser.mjs
run_group chrome-proof env PROOF_ONLY=1 node tests/browser.mjs
run_group chrome-full-nested env FULL_NESTED_ONLY=1 node tests/browser.mjs
run_group chrome-diagnostics env DIAGNOSTICS_ONLY=1 node tests/browser.mjs
run_group chrome-dynamic-region env DYNAMIC_ONLY=1 node tests/browser.mjs
run_group chrome-nested-region env NESTED_ONLY=1 node tests/browser.mjs
run_group chrome-csdn-like env RELIABILITY_ONLY=csdn node tests/browser.mjs
run_group chrome-chat-like env RELIABILITY_ONLY=chat node tests/browser.mjs
run_group chrome-complex env COMPLEX_ONLY=1 node tests/browser.mjs
run_group chrome-retina-2x env NATIVE_DPR=2 node tests/browser.mjs

echo "" | tee -a "$SUMMARY"
echo "FINAL REGRESSION PASS" | tee -a "$SUMMARY"
echo "Summary: $SUMMARY"

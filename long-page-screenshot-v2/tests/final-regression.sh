#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# Each group is a fresh browser process/profile; no fixture state is shared.
ALL_GROUPS=(node-all chrome-base chrome-output chrome-policy chrome-visual chrome-bottom-tail chrome-adaptive chrome-proof chrome-full-nested chrome-diagnostics chrome-dynamic-region chrome-nested-region chrome-csdn-like chrome-chat-like chrome-complex chrome-retina-2x)
FULL=0
if (( $# == 0 )); then GROUPS_TO_RUN=("${ALL_GROUPS[@]}"); FULL=1; else GROUPS_TO_RUN=("$@"); fi
for group in "${GROUPS_TO_RUN[@]}"; do
  valid=0
  for known in "${ALL_GROUPS[@]}"; do [[ "$group" != "$known" ]] || valid=1; done
  if (( valid == 0 )); then echo "ERROR: unknown regression group: $group" >&2; exit 2; fi
done
for name in OUTPUT_ONLY VISUAL_ONLY BOTTOM_TAIL_ONLY DYNAMIC_ONLY RELIABILITY_ONLY COMPLEX_ONLY NESTED_ONLY ADAPTIVE_ONLY PROOF_ONLY FULL_NESTED_ONLY DIAGNOSTICS_ONLY POLICY_ONLY NATIVE_DPR SITE_URL REGION_EDGES EXTRA_ONLY; do unset "$name" || true; done
command -v node >/dev/null || { echo 'ERROR: Node 22+ required.' >&2; exit 2; }
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( NODE_MAJOR >= 22 )) || { echo "ERROR: Node 22+ required; found $(node -v)." >&2; exit 2; }
if [[ -z "${CHROME_EXECUTABLE:-}" && -x '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' ]]; then export CHROME_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; fi
if [[ " ${GROUPS_TO_RUN[*]} " != ' node-all ' ]]; then
  node -e "require.resolve('playwright'); require.resolve('pngjs')" >/dev/null 2>&1 || { echo 'ERROR: Playwright and pngjs must be resolvable. Set NODE_PATH.' >&2; exit 2; }
fi
if [[ -n "${REGRESSION_LOG_DIR:-}" ]]; then LOG_DIR="$REGRESSION_LOG_DIR"; mkdir -p "$LOG_DIR"; else LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/long-page-screenshot-v2-final-XXXXXX")"; fi
SUMMARY="$LOG_DIR/summary.txt"
: > "$SUMMARY"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "branch=$(git branch --show-current)" | tee -a "$SUMMARY"
  echo "head=$(git rev-parse HEAD)" | tee -a "$SUMMARY"
  [[ -z "$(git status --porcelain)" ]] || { echo 'ERROR: final regression requires a clean checkout.' | tee -a "$SUMMARY" >&2; exit 2; }
fi
printf 'node=%s\nchrome=%s\ngroups=%s\nlogs=%s\n' "$(node -v)" "${CHROME_EXECUTABLE:-playwright-default}" "${GROUPS_TO_RUN[*]}" "$LOG_DIR" | tee -a "$SUMMARY"
run_group() {
  local label="$1"; shift
  echo "=== RUN $label ===" | tee -a "$SUMMARY"
  if "$@" 2>&1 | tee "$LOG_DIR/$label.log"; then
    echo "PASS $label" | tee -a "$SUMMARY"
  else
    local rc="${PIPESTATUS[0]}"
    echo "FAIL $label (exit=$rc)" | tee -a "$SUMMARY" >&2
    exit "$rc"
  fi
}
for group in "${GROUPS_TO_RUN[@]}"; do
  case "$group" in
    node-all) run_group "$group" node --test tests/*.test.mjs ;;
    chrome-base) run_group "$group" node tests/browser.mjs ;;
    chrome-output) run_group "$group" env OUTPUT_ONLY=1 node tests/browser.mjs ;;
    chrome-policy) run_group "$group" env POLICY_ONLY=1 node tests/browser.mjs ;;
    chrome-visual) run_group "$group" env VISUAL_ONLY=1 node tests/browser.mjs ;;
    chrome-bottom-tail) run_group "$group" env BOTTOM_TAIL_ONLY=1 node tests/browser.mjs ;;
    chrome-adaptive) run_group "$group" env ADAPTIVE_ONLY=1 node tests/browser.mjs ;;
    chrome-proof) run_group "$group" env PROOF_ONLY=1 node tests/browser.mjs ;;
    chrome-full-nested) run_group "$group" env FULL_NESTED_ONLY=1 node tests/browser.mjs ;;
    chrome-diagnostics) run_group "$group" env DIAGNOSTICS_ONLY=1 node tests/browser.mjs ;;
    chrome-dynamic-region) run_group "$group" env DYNAMIC_ONLY=1 node tests/browser.mjs ;;
    chrome-nested-region) run_group "$group" env NESTED_ONLY=1 node tests/browser.mjs ;;
    chrome-csdn-like) run_group "$group" env RELIABILITY_ONLY=csdn node tests/browser.mjs ;;
    chrome-chat-like) run_group "$group" env RELIABILITY_ONLY=chat node tests/browser.mjs ;;
    chrome-complex) run_group "$group" env COMPLEX_ONLY=1 node tests/browser.mjs ;;
    chrome-retina-2x) run_group "$group" env NATIVE_DPR=2 node tests/browser.mjs ;;
  esac
done
if (( FULL )); then echo 'FINAL REGRESSION PASS' | tee -a "$SUMMARY"; else echo 'SELECTED GROUPS PASS (not a full-gate result)' | tee -a "$SUMMARY"; fi
echo "Summary: $SUMMARY"

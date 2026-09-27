#!/usr/bin/env bash
# Diagnostic-only: six fixed arrival-probe cases in one owned xvfb-run, a fresh app per case.
# Order is I,U,U,I on child 400 worktree 0ms, then the instrumented child 100 control, then
# instrumented child 400 at 800ms idle. No retries, no repeat-each, every outcome preserved.
set -uo pipefail

evidence="$GITHUB_WORKSPACE/probe-evidence"
printf 'display=%s\n' "${DISPLAY:-unset}" >> "$evidence/outcomes.txt"
xdpyinfo -display "$DISPLAY" > "$evidence/xdpyinfo.txt" 2>&1 || true

instrumented='tests/e2e/sidebar-lineage-arrival-probe.spec.ts'
maintained='tests/e2e/sidebar-lineage-scroll-regressions.spec.ts'
suffix='idle keeps the inactive descendant mounted until its title lands$'

run_case() {
  local label="$1" spec="$2" pattern="$3"
  local out="$evidence/$label"
  mkdir -p "$out"
  env SKIP_BUILD=1 ORCA_E2E_FORWARD_APP_LOGS=1 ORCA_E2E_WEB_CLIENT=1 \
    ORCA_E2E_SIDEBAR_MOTION_XVFB=1 \
    "ORCA_RELAY_PATH=$GITHUB_WORKSPACE/out/relay" \
    "ORCA_E2E_ARRIVAL_CASE=$label" \
    pnpm exec playwright test "$spec" \
      --config tests/playwright.config.ts --project=electron-headless \
      --workers=1 --repeat-each=1 --retries=0 --max-failures=0 \
      --grep "$pattern" --output="$out" > "$evidence/logs/$label.log" 2>&1
  local status=$?
  printf 'case=%s exit=%s spec=%s\n' "$label" "$status" "$spec" >> "$evidence/outcomes.txt"
  return 0
}

run_case case-1-I-child400-worktree-0ms   "$instrumented" "arrival probe: smooth worktree reveal child 400 after 0ms $suffix"
run_case case-2-U-child400-worktree-0ms   "$maintained"   "smooth worktree reveal child 400 after 0ms $suffix"
run_case case-3-U-child400-worktree-0ms   "$maintained"   "smooth worktree reveal child 400 after 0ms $suffix"
run_case case-4-I-child400-worktree-0ms   "$instrumented" "arrival probe: smooth worktree reveal child 400 after 0ms $suffix"
run_case case-5-I-child100-worktree-0ms   "$instrumented" "arrival probe: smooth worktree reveal child 100 after 0ms $suffix"
run_case case-6-I-child400-worktree-800ms "$instrumented" "arrival probe: smooth worktree reveal child 400 after 800ms $suffix"

printf 'cases_completed=6\n' >> "$evidence/outcomes.txt"

#!/usr/bin/env bash
# Diagnostic-only: twelve fixed sidebar motion cases in one owned xvfb-run, fresh app per case.
set -uo pipefail

evidence="$GITHUB_WORKSPACE/capture-evidence"
printf 'display=%s\n' "${DISPLAY:-unset}" >> "$evidence/outcomes.txt"
xdpyinfo -display "$DISPLAY" > "$evidence/xdpyinfo.txt" 2>&1 || true

run_case() {
  local idx="$1" arm="$2" spec="$3" pattern="$4" trace="$5"
  local out="$evidence/case-${idx}-${arm}"
  mkdir -p "$out"
  local -a case_env=(
    "SKIP_BUILD=1"
    "ORCA_E2E_FORWARD_APP_LOGS=1"
    "ORCA_E2E_WEB_CLIENT=1"
    "ORCA_RELAY_PATH=$GITHUB_WORKSPACE/out/relay"
    "ORCA_E2E_SIDEBAR_CASE=${idx}-${arm}"
  )
  if [ "$arm" = 'mapped' ]; then
    case_env+=("ORCA_E2E_SIDEBAR_MOTION_XVFB=1")
  fi
  if [ "$trace" = 'trace' ]; then
    case_env+=("ORCA_E2E_SIDEBAR_TRACE=1")
  fi
  env "${case_env[@]}" pnpm exec playwright test "$spec" \
    --config tests/playwright.config.ts --project=electron-headless \
    --workers=1 --repeat-each=1 --retries=0 --max-failures=0 \
    --grep "$pattern" --output="$out" > "$out/case.log" 2>&1
  local status=$?
  printf 'case=%s arm=%s spec=%s trace=%s exit=%s\n' "$idx" "$arm" "$spec" "$trace" "$status" >> "$evidence/outcomes.txt"
  return 0
}

continuity='tests/e2e/sidebar-reveal-continuity.spec.ts'
lineage='tests/e2e/sidebar-lineage-scroll-regressions.spec.ts'
rename='tests/e2e/sidebar-rename-readiness.spec.ts'
controls='tests/e2e/sidebar-capture-stall-controls.spec.ts'

continuity_pattern='native reveal continuity: up$'
lineage_pattern='smooth worktree reveal child 150 after 0ms idle keeps the inactive descendant mounted until its title lands$'
rename_pattern='untyped distant rename keeps native motion after early focus$'
stationary_pattern='stationary event-loop control$'
moving_pattern='moving event-loop control$'

run_case 01 hidden "$continuity" "$continuity_pattern" trace
run_case 02 mapped "$continuity" "$continuity_pattern" trace
run_case 03 mapped "$continuity" "$continuity_pattern" plain
run_case 04 hidden "$continuity" "$continuity_pattern" plain
run_case 05 hidden "$lineage" "$lineage_pattern" plain
run_case 06 mapped "$lineage" "$lineage_pattern" plain
run_case 07 mapped "$rename" "$rename_pattern" trace
run_case 08 hidden "$rename" "$rename_pattern" trace
run_case 09 hidden "$controls" "$stationary_pattern" plain
run_case 10 mapped "$controls" "$stationary_pattern" plain
run_case 11 mapped "$controls" "$moving_pattern" plain
run_case 12 hidden "$controls" "$moving_pattern" plain

printf 'cases_completed=12\n' >> "$evidence/outcomes.txt"

#!/usr/bin/env bash
set -euo pipefail
arms=(A B B A A B B A)
paired_failed=0
for leg in "${!arms[@]}"; do
  arm="${arms[$leg]}"
  rm -rf out
  cp -a "$RUNNER_TEMP/sidebar-paired-builds/$arm" out
  python3 tests/sidebar-paired-build-manifest.py out "paired-evidence/restored-$leg-$arm.json"
  cmp "paired-evidence/build-$arm.json" "paired-evidence/restored-$leg-$arm.json"
  leg_status=0
  ORCA_REVEAL_ARM="$arm" ORCA_REVEAL_LEG="$leg" SKIP_BUILD=1 ORCA_E2E_FORWARD_APP_LOGS=1 ORCA_RELAY_PATH="$GITHUB_WORKSPACE/out/relay" \
    pnpm exec playwright test --config tests/playwright.matched-motion.config.ts --workers=1 \
    --output="paired-evidence/leg-$leg-$arm" > "paired-evidence/leg-$leg-$arm.log" 2>&1 || leg_status=$?
  printf '%s\t%s\t%s\n' "$leg" "$arm" "$leg_status" >> paired-evidence/outcomes.tsv
  if [ "$leg_status" -ne 0 ]; then paired_failed=1; fi
done
exit "$paired_failed"

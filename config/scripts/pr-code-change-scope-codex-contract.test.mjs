import { describe, expect, it } from 'vitest'
import { classifyPrJobs, PR_CHECK_JOBS } from './pr-code-change-scope.mjs'

const CODEX_CONTRACT_JOBS = [
  'static_analysis',
  'typecheck',
  'test',
  'codex_index_heal_contract',
  'package',
  'package_windows'
]

// Keep the real-binary gate live when a transport, launch or hook-approval dependency changes.
describe('Codex real-binary contract routing', () => {
  it.each([
    'src/main/codex/codex-hook-trust-derivation.ts',
    'src/main/codex/codex-real-home-hook-install.ts',
    'src/main/codex/config-toml-hook-trust-edit.ts',
    'src/main/codex-cli/codex-read-only-app-server-args.ts',
    'src/main/codex/codex-app-server-capability-signal.ts',
    'src/main/provider-process/provider-process-exit-deadline.ts',
    'src/main/provider-process/provider-process-launch.ts',
    'src/main/provider-process/provider-record-reader.ts',
    'src/main/codex/codex-session-backfill.ts',
    'src/main/codex/codex-session-index-heal-state.ts',
    'src/main/codex-cli/command.ts',
    'src/main/win32-utils.ts',
    'src/shared/node-cli-command-resolution.ts',
    'src/shared/windows-batch-spawn.ts'
  ])('runs the Codex real-binary contract job when %s changes', (file) => {
    expect(classifyPrJobs([file])).toMatchObject({
      should_run: true,
      ...Object.fromEntries(PR_CHECK_JOBS.map((job) => [job, CODEX_CONTRACT_JOBS.includes(job)]))
    })
  })
})

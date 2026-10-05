import { resolve } from 'node:path'
import { afterEach } from 'vitest'
import {
  armTopologyWriteGuardForTests,
  takeTopologyWriteGuardReport
} from '../../src/main/persistence/terminal-topology/terminal-topology-write-guard'
import { UNROUTED_TOPOLOGY_WRITERS } from '../../src/main/persistence/terminal-topology/terminal-topology-unrouted-writers'

/**
 * Why: a tripwire behind the boundary ratchet (terminal-topology-boundary-ratchet.test.ts). Every
 * unit test fails on a sink write that changes class-(a) terminal topology from a writer not on
 * the allowlist. Freeze stays off suite-wide until the in-place writers (P1, P10–P12) return new
 * sessions.
 */
armTopologyWriteGuardForTests({
  allowedWriters: new Set(Object.keys(UNROUTED_TOPOLOGY_WRITERS)),
  freeze: false,
  // Why not new URL(): under happy-dom the global URL is not Node's, and fileURLToPath rejects it.
  repoRoot: resolve(import.meta.dirname, '../..')
})

afterEach(() => {
  const { violations } = takeTopologyWriteGuardReport()
  if (violations.length > 0) {
    const lines = violations.map(
      (violation) => `  ${violation.writer}: ${violation.changes.slice(0, 5).join(', ')}`
    )
    throw new Error(
      [
        'Terminal topology changed outside terminal-topology-commit.ts:',
        ...lines,
        'Route the writer through the commit module, or list it in terminal-topology-unrouted-writers.ts',
        "with the PR that routes it. A write made after a test ends is blamed on the file's next test."
      ].join('\n')
    )
  }
})

import { afterEach } from 'vitest'
import {
  armTopologyWriteGuardForTests,
  takeTopologyWriteGuardReport
} from '../../src/main/persistence/terminal-topology/terminal-topology-write-guard'
import { UNROUTED_TOPOLOGY_WRITERS } from '../../src/main/persistence/terminal-topology/terminal-topology-unrouted-writers'

/**
 * Why: main's class-(a) terminal topology may change only through the commit module. Every unit
 * test reports, and fails on, a sink write that changes it from a writer not on the allowlist.
 * Freeze stays off suite-wide until the in-place writers (P1, P10–P12) return new sessions.
 */
armTopologyWriteGuardForTests({
  allowedWriters: new Set(Object.keys(UNROUTED_TOPOLOGY_WRITERS)),
  freeze: false
})

afterEach(() => {
  const { violations } = takeTopologyWriteGuardReport()
  if (violations.length > 0) {
    throw new Error(
      `Terminal topology changed outside terminal-topology-commit.ts:\n${violations
        .map((violation) => `  ${violation.writer}: ${violation.changes.slice(0, 5).join(', ')}`)
        .join('\n')}\nRoute the writer through the commit module, or list it in ` +
        'terminal-topology-unrouted-writers.ts with the PR that routes it.'
    )
  }
})

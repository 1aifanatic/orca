import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { topologyClassAChanges } from './terminal-topology-class-a-diff'
import {
  attributeTopologyWriter,
  captureSinkWriteStack,
  TEST_SEED_WRITER
} from './terminal-topology-writer-attribution'

/**
 * Test-only tripwire for class-(a) terminal topology writes that bypass the commit module.
 * Production never arms it, so each sink pays one global lookup.
 */

export type TopologyWriteViolation = {
  /** Repo-relative file of the first frame outside the session sinks, or `unknown`. */
  writer: string
  /** Changed class-(a) slices, e.g. `tab:<id>.root` or `revision`. */
  changes: string[]
}

export type TopologyWriteGuardOptions = {
  /** Writers allowed to change class (a) outside a commit, keyed by repo-relative path. */
  allowedWriters: ReadonlySet<string>
  /** Deep-freeze each published session so a later in-place write throws at the writer. */
  freeze: boolean
  /** Absolute repo root; stack frames are attributed relative to it. */
  repoRoot: string
}

type TopologyWriteGuardState = TopologyWriteGuardOptions & {
  commitDepth: number
  violations: TopologyWriteViolation[]
  allowed: TopologyWriteViolation[]
}

declare global {
  // Why global: a test's `vi.resetModules()` must not load an unarmed copy of this module.
  var __orcaTerminalTopologyWriteGuard: TopologyWriteGuardState | undefined
}

function guardState(): TopologyWriteGuardState | undefined {
  return globalThis.__orcaTerminalTopologyWriteGuard
}

export function armTopologyWriteGuardForTests(options: TopologyWriteGuardOptions): void {
  globalThis.__orcaTerminalTopologyWriteGuard = {
    ...options,
    commitDepth: 0,
    violations: [],
    allowed: []
  }
}

export function disarmTopologyWriteGuardForTests(): void {
  globalThis.__orcaTerminalTopologyWriteGuard = undefined
}

/** Drains what the armed guard saw: `violations` fail a test, `allowed` are the ratchet's report. */
export function takeTopologyWriteGuardReport(): {
  violations: TopologyWriteViolation[]
  allowed: TopologyWriteViolation[]
} {
  const state = guardState()
  if (!state) {
    return { violations: [], allowed: [] }
  }
  const report = { violations: state.violations, allowed: state.allowed }
  state.violations = []
  state.allowed = []
  return report
}

/** Marks the synchronous body of a commit function as inside the boundary. */
export function withTopologyCommit<T>(fn: () => T): T {
  const state = guardState()
  if (!state) {
    return fn()
  }
  state.commitDepth += 1
  try {
    return fn()
  } finally {
    state.commitDepth -= 1
  }
}

/** Called by every session sink with the partition's prior and published sessions. */
export function observeTopologySinkWrite(
  prior: WorkspaceSessionState | undefined,
  next: WorkspaceSessionState
): void {
  const state = guardState()
  if (!state) {
    return
  }
  if (state.freeze) {
    deepFreeze(next)
  }
  if (state.commitDepth > 0) {
    return
  }
  const changes = topologyClassAChanges(prior, next)
  if (changes.length === 0) {
    return
  }
  const writer = attributeTopologyWriter(captureSinkWriteStack(), state.repoRoot)
  if (writer === TEST_SEED_WRITER || RENDERER_SAVE_ENTRY_FILES.has(writer)) {
    return
  }
  const violation = { writer, changes }
  if (state.allowedWriters.has(writer)) {
    state.allowed.push(violation)
  } else {
    state.violations.push(violation)
  }
}

// Why exempt: the renderer save (R1–R4) is class-(a)'s other author until the presentation-only save.
const RENDERER_SAVE_ENTRY_FILES: ReadonlySet<string> = new Set([
  'src/main/ipc/session.ts',
  'src/main/ipc/renderer-shutdown-checkpoint.ts'
])

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return
  }
  Object.freeze(value)
  for (const child of Object.values(value)) {
    deepFreeze(child)
  }
}

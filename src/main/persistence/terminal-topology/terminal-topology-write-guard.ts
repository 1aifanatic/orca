import { isDeepStrictEqual } from 'node:util'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

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
}

type TopologyWriteGuardState = TopologyWriteGuardOptions & {
  commitDepth: number
  violations: TopologyWriteViolation[]
  allowed: TopologyWriteViolation[]
}

declare global {
  // Why global: a test's `vi.resetModules()` must not load an unarmed copy of this module.
  // oxlint-disable-next-line no-var -- a global declaration has to be a var.
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
  // Why 30: the sinks and their funnels alone can fill the default 10 frames.
  const stackTraceLimit = Error.stackTraceLimit
  Error.stackTraceLimit = 30
  const writer = attributeTopologyWriter(new Error('topology sink write').stack)
  Error.stackTraceLimit = stackTraceLimit
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

export const TEST_SEED_WRITER = 'test-seed'

// The sinks and their pass-through funnels; the writer is the first frame outside them.
const SINK_FILES: ReadonlySet<string> = new Set([
  'src/main/persistence/terminal-topology/terminal-topology-write-guard.ts',
  'src/main/persistence/loading-store/workspace-session-partition-commit.ts',
  'src/main/persistence/loading-store/session-snapshot-operations.ts',
  'src/main/persistence/loading-store/workspace-session-snapshot-publication.ts',
  'src/main/persistence/loading-store/session-host-partitions.ts',
  'src/main/runtime/runtime-workspace-session-controller.ts',
  'src/main/runtime/orca-runtime-get-runtime-id.ts'
])

const TEST_FILE_PATTERN =
  /(\.test\.tsx?|\.spec\.tsx?|fixtures?\.ts|test-harness[^/]*\.ts)$|\/__fixtures__\//

/** The repo-relative file of the first frame outside the sinks; test files read as seeding. */
export function attributeTopologyWriter(stack: string | undefined): string {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    const file = repoRelativeSourceFile(line)
    if (!file || SINK_FILES.has(file)) {
      continue
    }
    return TEST_FILE_PATTERN.test(file) ? TEST_SEED_WRITER : file
  }
  return 'unknown'
}

function repoRelativeSourceFile(frame: string): string | null {
  const match = /\(?(?:file:\/\/)?([^()\s]+\.[cm]?[jt]sx?):\d+:\d+\)?\s*$/.exec(frame)
  if (!match || match[1].includes('/node_modules/')) {
    return null
  }
  const path = match[1].replaceAll('\\', '/')
  const srcIndex = path.lastIndexOf('/src/')
  return srcIndex === -1 ? null : path.slice(srcIndex + 1)
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return
  }
  Object.freeze(value)
  for (const child of Object.values(value)) {
    deepFreeze(child)
  }
}

type TabTopology = {
  owners: string[]
  ptyId: string | null | undefined
  root: unknown
  ptyIdsByLeafId: unknown
  titlesByLeafId: unknown
  remoteSessionId: string | undefined
  closedTombstone: unknown
  incarnations: Record<string, unknown>
  sleeping: Record<string, unknown>
  surfaceTombstones: Record<string, unknown>
}

const TAB_TOPOLOGY_FIELDS = [
  'owners',
  'ptyId',
  'root',
  'ptyIdsByLeafId',
  'titlesByLeafId',
  'remoteSessionId',
  'closedTombstone',
  'incarnations',
  'sleeping',
  'surfaceTombstones'
] as const satisfies readonly (keyof TabTopology)[]

function emptyTabTopology(): TabTopology {
  return {
    owners: [],
    ptyId: undefined,
    root: undefined,
    ptyIdsByLeafId: undefined,
    titlesByLeafId: undefined,
    remoteSessionId: undefined,
    closedTombstone: undefined,
    incarnations: {},
    sleeping: {},
    surfaceTombstones: {}
  }
}

/** Class (a) only (design §5.5); buffers, scrollback and presentation never count. */
export function topologyClassAChanges(
  prior: WorkspaceSessionState | undefined,
  next: WorkspaceSessionState
): string[] {
  const priorTabs = topologyByTab(prior)
  const nextTabs = topologyByTab(next)
  const changes: string[] = []
  for (const tabId of new Set([...priorTabs.keys(), ...nextTabs.keys()])) {
    const before = priorTabs.get(tabId) ?? emptyTabTopology()
    const after = nextTabs.get(tabId) ?? emptyTabTopology()
    for (const field of TAB_TOPOLOGY_FIELDS) {
      if (!isDeepStrictEqual(before[field], after[field])) {
        changes.push(`tab:${tabId}.${field}`)
      }
    }
  }
  if (
    !isDeepStrictEqual(
      prior?.terminalTopologyRevisionByRepoId ?? {},
      next.terminalTopologyRevisionByRepoId ?? {}
    )
  ) {
    changes.push('revision')
  }
  if (
    !isDeepStrictEqual(
      prior?.defaultTerminalTabsAppliedByWorktreeId ?? {},
      next.defaultTerminalTabsAppliedByWorktreeId ?? {}
    )
  ) {
    changes.push('default_applied')
  }
  return changes
}

function topologyByTab(session: WorkspaceSessionState | undefined): Map<string, TabTopology> {
  const tabs = new Map<string, TabTopology>()
  const tab = (tabId: string): TabTopology => {
    let entry = tabs.get(tabId)
    if (!entry) {
      entry = emptyTabTopology()
      tabs.set(tabId, entry)
    }
    return entry
  }
  const paneKeyed = (
    field: 'incarnations' | 'sleeping' | 'surfaceTombstones',
    record: Record<string, unknown> | undefined
  ): void => {
    for (const [paneKey, value] of Object.entries(record ?? {})) {
      const separator = paneKey.indexOf(':')
      tab(separator > 0 ? paneKey.slice(0, separator) : paneKey)[field][paneKey] = value
    }
  }
  if (!session) {
    return tabs
  }
  for (const [worktreeId, rows] of Object.entries(session.tabsByWorktree ?? {})) {
    for (const row of rows ?? []) {
      const entry = tab(row.id)
      entry.owners.push(worktreeId)
      entry.ptyId = row.ptyId
    }
  }
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const entry = tab(tabId)
    entry.root = layout?.root ?? null
    entry.ptyIdsByLeafId = layout?.ptyIdsByLeafId
    entry.titlesByLeafId = layout?.titlesByLeafId
  }
  for (const [tabId, sessionId] of Object.entries(session.remoteSessionIdsByTabId ?? {})) {
    tab(tabId).remoteSessionId = sessionId
  }
  for (const [tabId, tombstone] of Object.entries(
    session.closedTerminalTabTombstonesByTabId ?? {}
  )) {
    tab(tabId).closedTombstone = tombstone
  }
  paneKeyed('incarnations', session.terminalPtyIncarnationsByPaneKey)
  paneKeyed('sleeping', session.sleepingAgentSessionsByPaneKey)
  paneKeyed('surfaceTombstones', session.terminalSurfaceTombstonesByPaneKey)
  return tabs
}

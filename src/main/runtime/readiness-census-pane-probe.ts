// Reads what tui-idle callers observe off a runtime pane: the ranked verdict and a wait's outcome.
import { vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import {
  evaluateTuiIdle,
  leafTuiIdleEvidence,
  type TuiIdleEvidenceSource,
  type TuiIdleVerdict
} from './tui-idle-evidence'

/** The runtime members the probe reads; every tui-idle site evaluates through the same two. */
type CensusRuntimeInternals = {
  tuiIdleEvidenceSource: TuiIdleEvidenceSource
  getLiveLeafForHandle(handle: string): { leaf: RuntimeLeafRecord }
  getLivePtyForHandle(handle: string): unknown
  ptysById: Map<string, { lastOutputAt: number | null }>
}

function internalsOf(runtime: OrcaRuntimeService): CensusRuntimeInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: protected members of OrcaRuntimeService, read-only, named exactly as declared in orca-runtime-runtime-id.ts and orca-runtime-build-pty-terminal-summary.ts.
  return runtime as unknown as CensusRuntimeInternals
}

export function verdictLabel(verdict: TuiIdleVerdict): string {
  switch (verdict.kind) {
    case 'blocked':
      return `blocked:${verdict.reason}`
    case 'pending':
      return `pending:${verdict.quietForeground}`
    case 'ready-strong':
    case 'ready-weak':
    case 'working':
      return verdict.kind
  }
}

/** The verdict `RuntimeTerminalWait` evaluates for a leaf handle (runtime-terminal-wait.ts). */
export function evaluatePaneVerdict(runtime: OrcaRuntimeService, handle: string): string {
  const internals = internalsOf(runtime)
  // Why the leaf branch only: createTerminal's handles are leaf handles; a `pty:` handle is not.
  if (internals.getLivePtyForHandle(handle) !== null) {
    throw new Error('census panes are leaf handles')
  }
  const { leaf } = internals.getLiveLeafForHandle(handle)
  const waitText = buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
  return verdictLabel(
    evaluateTuiIdle(leafTuiIdleEvidence(internals.tuiIdleEvidenceSource, leaf, () => waitText))
  )
}

// Why several turns: the poll tick awaits the emulator's write chain, then the foreground probe.
const FLUSH_TURNS = 3

async function flushUntil(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < FLUSH_TURNS && !done(); turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/**
 * What `terminal wait --for tui-idle` does when started now: settle at once, or after the first
 * poll tick (one interval later), or not by then. Needs fake `Date` and `setInterval`.
 */
export async function probePaneWait(runtime: OrcaRuntimeService, handle: string): Promise<string> {
  const abort = new AbortController()
  let outcome = 'pending'
  const settled = runtime
    .waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 3_600_000, signal: abort.signal })
    .then(
      (result) => {
        outcome = result.blockedReason
          ? `blocked:${result.blockedReason}`
          : result.satisfied
            ? 'ready'
            : 'unsatisfied'
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        if (message !== 'request_aborted') {
          outcome = `error:${message}`
        }
      }
    )
  const isSettled = (): boolean => outcome !== 'pending'
  await flushUntil(isSettled)
  if (!isSettled()) {
    await vi.advanceTimersByTimeAsync(CENSUS_POLL_INTERVAL_MS)
    await flushUntil(isSettled)
  }
  abort.abort()
  await settled
  return outcome
}

/**
 * Runs `read` as a pane with no output clock: a restored or daemon-adopted pane holding the same
 * tail and screen. Why mutate the live records: the wait re-reads them, so a copy would not reach it.
 */
export async function asClocklessPane<T>(
  runtime: OrcaRuntimeService,
  handle: string,
  ptyId: string,
  read: () => Promise<T>
): Promise<T> {
  const internals = internalsOf(runtime)
  const { leaf } = internals.getLiveLeafForHandle(handle)
  const pty = internals.ptysById.get(ptyId)
  const leafClock = leaf.lastOutputAt
  const ptyClock = pty?.lastOutputAt ?? null
  leaf.lastOutputAt = null
  if (pty) {
    pty.lastOutputAt = null
  }
  try {
    return await read()
  } finally {
    internals.getLiveLeafForHandle(handle).leaf.lastOutputAt = leafClock
    if (pty) {
      pty.lastOutputAt = ptyClock
    }
  }
}

// Why literals, not TUI_IDLE_QUIESCENCE_MS / TUI_IDLE_POLL_INTERVAL_MS: a changed window or poll
// interval must surface as changed verdicts. The edge read sits 1 ms inside today's window.
export const CENSUS_QUIET_MS = 3_000
export const CENSUS_QUIET_EDGE_MS = CENSUS_QUIET_MS - 1
const CENSUS_POLL_INTERVAL_MS = 2_000

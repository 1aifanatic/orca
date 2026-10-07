import type { TerminalTopologySlice } from '../../../shared/terminal-topology-slice'

type TerminalTopologySource = {
  onTerminalTopologyChanged: (callback: (slice: TerminalTopologySlice) => void) => () => void
  getTerminalTopologySlices: () => Promise<TerminalTopologySlice[]>
}

/**
 * Subscribes, then pulls: a push sent before the subscription is in the pull, and one racing the
 * pull is ordered by publishSeq. Follows pushes until `signal` aborts.
 */
export async function followTerminalTopology(
  source: TerminalTopologySource,
  apply: (slice: TerminalTopologySlice) => void,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) {
    return
  }
  signal.addEventListener('abort', source.onTerminalTopologyChanged(apply), { once: true })
  try {
    for (const slice of await source.getTerminalTopologySlices()) {
      apply(slice)
    }
  } catch (error) {
    // The hydrated session came from the same store, so the window stays usable; pushes still apply.
    console.warn('[terminal-topology] Startup pull failed:', error)
  }
}

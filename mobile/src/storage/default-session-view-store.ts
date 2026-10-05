import { useEffect, useSyncExternalStore } from 'react'
import {
  DEFAULT_SESSION_VIEW,
  loadDefaultSessionView,
  saveDefaultSessionView,
  type MobileSessionView
} from './session-view-preferences'
import {
  readDefaultSessionViewState,
  writeDefaultSessionViewState,
  type DefaultSessionViewState
} from './default-session-view-state'

export type { DefaultSessionViewState }

const INITIAL_STATE: DefaultSessionViewState = { value: DEFAULT_SESSION_VIEW, settled: false }
let mutationRevision = 0
let loadStarted = false
const listeners = new Set<() => void>()

function publish(next: DefaultSessionViewState): void {
  const state = readState()
  if (next.value === state.value && next.settled === state.settled) {
    return
  }
  writeDefaultSessionViewState(next)
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// One owner per JS context, so Settings and every mounted session read the same value.
function readState(): DefaultSessionViewState {
  return readDefaultSessionViewState() ?? INITIAL_STATE
}

/** Re-reads storage; a change written by the other JS context of a hybrid page lands here. */
export function refreshDefaultSessionView(): Promise<void> {
  loadStarted = true
  const revision = mutationRevision
  return loadDefaultSessionView()
    .catch(() => DEFAULT_SESSION_VIEW)
    .then((value) => {
      // Why: a choice made during the read is newer than what the read saw.
      if (mutationRevision === revision) {
        publish({ value, settled: true })
      }
    })
}

export function setDefaultSessionView(view: MobileSessionView): void {
  const revision = mutationRevision + 1
  mutationRevision = revision
  publish({ value: view, settled: true })
  // Why: persistence owns a shared queue, so invoking it at event time preserves mutation order.
  void saveDefaultSessionView(view).catch(async () => {
    const persisted = await loadDefaultSessionView().catch(() => DEFAULT_SESSION_VIEW)
    if (mutationRevision === revision) {
      publish({ value: persisted, settled: true })
    }
  })
}

export function useDefaultSessionView(): DefaultSessionViewState {
  useEffect(() => {
    if (!loadStarted) {
      void refreshDefaultSessionView()
    }
  }, [])
  return useSyncExternalStore(subscribe, readState, readState)
}

export function resetDefaultSessionViewStoreForTests(): void {
  writeDefaultSessionViewState(null)
  mutationRevision = 0
  loadStarted = false
  listeners.clear()
}

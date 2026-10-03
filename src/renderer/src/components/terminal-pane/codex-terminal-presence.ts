import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

// Why three sources: Orca-launched tabs, hook-reported agents (SSH too), and a typed `codex` seen locally.
function hasCodexTerminal(state: AppState): boolean {
  return (
    Object.values(state.tabsByWorktree).some((tabs) =>
      tabs.some((tab) => tab.launchAgent === 'codex')
    ) ||
    Object.values(state.agentStatusByPaneKey).some((entry) => entry.agentType === 'codex') ||
    Object.values(state.paneForegroundAgentByPaneKey).some((entry) => entry.agent === 'codex')
  )
}

// Why persistedUIReady and settings: an `isDue` may read them.
function didInputsChange(state: AppState, previous: AppState): boolean {
  return (
    state.persistedUIReady !== previous.persistedUIReady ||
    state.settings !== previous.settings ||
    state.tabsByWorktree !== previous.tabsByWorktree ||
    state.agentStatusByPaneKey !== previous.agentStatusByPaneKey ||
    state.paneForegroundAgentByPaneKey !== previous.paneForegroundAgentByPaneKey
  )
}

/** Calls `onAppear` once, as soon as a Codex terminal exists while `isDue` holds. Returns the unsubscribe. */
export function whenCodexTerminalAppears(
  onAppear: () => void,
  isDue: (state: AppState) => boolean = () => true
): () => void {
  const isMet = (state: AppState): boolean => isDue(state) && hasCodexTerminal(state)
  if (isMet(useAppStore.getState())) {
    onAppear()
    return () => {}
  }
  // Why a filtered subscription: a selector would rescan every tab on each store write.
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (didInputsChange(state, previous) && isMet(state)) {
      unsubscribe()
      onAppear()
    }
  })
  return unsubscribe
}

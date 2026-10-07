/**
 * Keeps an SSH host's terminal tabs open across "Move to managed server". The move stops the
 * relay shells; without this their exits read as the user's own `exit` and closed the tabs, so
 * the conversion carried over only the tabs whose exit happened to be lost.
 */
import type { SshManagedServerMoveResult } from '../../../shared/ssh-managed-server-move'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'

type RelayTerminalBinding = { tabId: string; ptyId: string }

type TerminalBindingState = Pick<
  AppState,
  'tabsByWorktree' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId'
>

export function collectSshTargetTerminalBindings(
  state: TerminalBindingState,
  targetId: string
): RelayTerminalBinding[] {
  const bindings = new Map<string, RelayTerminalBinding>()
  for (const tabs of Object.values(state.tabsByWorktree)) {
    for (const tab of tabs) {
      const ptyIds = [
        tab.ptyId,
        ...(state.ptyIdsByTabId[tab.id] ?? []),
        ...Object.values(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {})
      ]
      for (const ptyId of ptyIds) {
        if (ptyId && parseAppSshPtyId(ptyId)?.connectionId === targetId) {
          bindings.set(ptyId, { tabId: tab.id, ptyId })
        }
      }
    }
  }
  return [...bindings.values()]
}

export async function moveKeepingTerminalTabs(
  targetId: string,
  move: () => Promise<SshManagedServerMoveResult>
): Promise<SshManagedServerMoveResult> {
  const bindings = collectSshTargetTerminalBindings(useAppStore.getState(), targetId)
  for (const { ptyId } of bindings) {
    useAppStore.getState().suppressPtyExit(ptyId)
  }
  let moved = false
  try {
    const result = await move()
    moved = result.outcome === 'moved'
    return result
  } finally {
    settleMovedTerminalTabs(bindings, moved)
  }
}

function settleMovedTerminalTabs(bindings: readonly RelayTerminalBinding[], moved: boolean): void {
  // Why keep the suppressions after a move: the host's server owns these tabs now, and a late
  // exit for a stopped relay shell must not close the row it hands over.
  if (moved) {
    return
  }
  const store = useAppStore.getState()
  const restartTabIds = new Set<string>()
  for (const { tabId, ptyId } of bindings) {
    // Still suppressed means no exit arrived: the shell may be running, so its real exit decides.
    if (!store.consumeSuppressedPtyExit(ptyId)) {
      restartTabIds.add(tabId)
    }
  }
  // The host stayed on the relay, so a tab whose shell stopped restarts there, as the offer said.
  for (const tabId of restartTabIds) {
    store.remountTerminalTabForRecovery(tabId)
  }
}

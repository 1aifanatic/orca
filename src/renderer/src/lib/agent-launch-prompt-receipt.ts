import type { TuiAgent } from '../../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { resolveDraftPasteReadyTimeoutMs } from '../../../shared/draft-paste-ready-timeout'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { waitForAgentDraftInputReady } from './agent-draft-readiness'
import { getSettingsForAgentTabRuntimeOwner, PTY_SPAWN_TIMEOUT_MS } from './agent-paste-draft'

type AppState = ReturnType<typeof useAppStore.getState>

export type LaunchPromptReceipt = 'delivered' | 'not-delivered' | 'unconfirmed'

/** How long a hook turn may still arrive after a read that could not tell. */
const HOOK_GRACE_AFTER_UNKNOWN_READ_MS = 2000

function hookReportedTurnOnTab(state: AppState, tabId: string, launchedAt: number): boolean {
  return Object.entries(state.agentStatusByPaneKey).some(
    ([paneKey, entry]) => parsePaneKey(paneKey)?.tabId === tabId && entry.updatedAt >= launchedAt
  )
}

function tabExists(state: AppState, tabId: string): boolean {
  return Object.values(state.tabsByWorktree).some((tabs) => tabs?.some((tab) => tab.id === tabId))
}

async function readLaunchedAgentForeground(
  ptyId: string,
  agent: TuiAgent
): Promise<'agent' | 'shell' | 'unknown'> {
  // A paired host's process reads do not reach this client.
  if (isRemoteRuntimePtyId(ptyId)) {
    return 'unknown'
  }
  return window.api.pty.readLaunchedAgentForeground(ptyId, agent).catch(() => 'unknown' as const)
}

/**
 * Whether a prompt that rode an agent's launch command reached the agent, proven the way #24257's
 * crash guard proves an agent before a paste. Delivered on the agent's own hook turn on the tab, or
 * a fresh read on the execution host that finds the launched agent, not its shell, in front of the
 * terminal (`readLaunchedAgentForeground`). A ready signal never counts on its own: it only times
 * that read, and bracketed paste turned off (`2004l`) revokes it. Not delivered when the PTY never
 * spawns (a refused launch file included), exits first, the tab closes, or the read finds the
 * shell. Unconfirmed when nothing proves either, as on a Windows host without hooks.
 */
export function waitForLaunchPromptReceipt(args: {
  tabId: string
  agent: TuiAgent
  launchedAt: number
}): Promise<LaunchPromptReceipt> {
  const { tabId, agent, launchedAt } = args
  return new Promise((resolve) => {
    let settled = false
    let boundPtyId: string | null = null
    let unsubscribe: (() => void) | null = null
    const timers: number[] = []
    const finish = (receipt: LaunchPromptReceipt): void => {
      if (settled) {
        return
      }
      settled = true
      unsubscribe?.()
      timers.forEach((timer) => window.clearTimeout(timer))
      resolve(receipt)
    }
    const readAfterReadiness = (ptyId: string): void => {
      const config = TUI_AGENT_CONFIG[agent]
      void waitForAgentDraftInputReady(
        ptyId,
        resolveDraftPasteReadyTimeoutMs(agent),
        config.draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste',
        getSettingsForAgentTabRuntimeOwner(tabId),
        { revokeOnBracketedPasteOff: true }
      )
        .then(() => readLaunchedAgentForeground(ptyId, agent))
        .then((foreground) => {
          if (foreground === 'agent') {
            finish('delivered')
          } else if (foreground === 'shell') {
            finish('not-delivered')
          } else {
            timers.push(
              window.setTimeout(() => finish('unconfirmed'), HOOK_GRACE_AFTER_UNKNOWN_READ_MS)
            )
          }
        })
        .catch(() => finish('unconfirmed'))
    }
    let scannedStatus: AppState['agentStatusByPaneKey'] | null = null
    const observe = (state: AppState): void => {
      // Why the identity check: the store writes often and replaces this map only when it changes.
      if (state.agentStatusByPaneKey !== scannedStatus) {
        scannedStatus = state.agentStatusByPaneKey
        if (hookReportedTurnOnTab(state, tabId, launchedAt)) {
          finish('delivered')
          return
        }
      }
      const ptyId = state.ptyIdsByTabId[tabId]?.[0]
      if (ptyId && !boundPtyId) {
        boundPtyId = ptyId
        readAfterReadiness(ptyId)
      } else if ((boundPtyId && !ptyId) || !tabExists(state, tabId)) {
        finish('not-delivered')
      }
    }
    unsubscribe = useAppStore.subscribe(observe)
    timers.push(
      window.setTimeout(() => {
        if (!boundPtyId) {
          finish('not-delivered')
        }
      }, PTY_SPAWN_TIMEOUT_MS)
    )
    observe(useAppStore.getState())
  })
}

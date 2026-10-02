import type { TuiAgent } from '../../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { resolveDraftPasteReadyTimeoutMs } from '../../../shared/draft-paste-ready-timeout'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { waitForAgentReady } from './agent-ready-wait'
import {
  getSettingsForAgentTabRuntimeOwner,
  PTY_SPAWN_TIMEOUT_MS,
  waitForAgentDraftInputReadyOnTab
} from './agent-paste-draft'

type AppState = ReturnType<typeof useAppStore.getState>

function hookReportedTurnOnTab(state: AppState, tabId: string, launchedAt: number): boolean {
  return Object.entries(state.agentStatusByPaneKey).some(
    ([paneKey, entry]) => parsePaneKey(paneKey)?.tabId === tabId && entry.updatedAt >= launchedAt
  )
}

function tabExists(state: AppState, tabId: string): boolean {
  return Object.values(state.tabsByWorktree).some((tabs) => tabs?.some((tab) => tab.id === tabId))
}

/**
 * Whether a prompt that rode an agent's launch command reached the agent. True at the first real
 * signal: the agent's own hook reports a turn on the tab, or the agent shows the composer a paste
 * would have waited for. False when the PTY never spawns (a refused launch file included), exits
 * first, or the tab closes. Never "the tab exists".
 */
export function waitForLaunchPromptReceipt(args: {
  tabId: string
  agent: TuiAgent
  launchedAt: number
  /** The agent process was seen, but neither its hook nor its composer. */
  onUnconfirmedDelivery?: () => void
}): Promise<boolean> {
  const { tabId, agent, launchedAt } = args
  return new Promise((resolve) => {
    let settled = false
    let sawPty = false
    let unsubscribe: (() => void) | null = null
    const finish = (delivered: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      unsubscribe?.()
      resolve(delivered)
    }
    let scannedStatus: AppState['agentStatusByPaneKey'] | null = null
    const observe = (state: AppState): void => {
      // Why the identity check: the store writes often and replaces this map only when it changes.
      if (state.agentStatusByPaneKey !== scannedStatus) {
        scannedStatus = state.agentStatusByPaneKey
        if (hookReportedTurnOnTab(state, tabId, launchedAt)) {
          finish(true)
          return
        }
      }
      if ((state.ptyIdsByTabId[tabId]?.length ?? 0) > 0) {
        sawPty = true
      } else if (sawPty || !tabExists(state, tabId)) {
        finish(false)
      }
    }
    unsubscribe = useAppStore.subscribe(observe)
    observe(useAppStore.getState())
    const config = TUI_AGENT_CONFIG[agent]
    void waitForAgentDraftInputReadyOnTab({
      tabId,
      spawnTimeoutMs: PTY_SPAWN_TIMEOUT_MS,
      readinessTimeoutMs: resolveDraftPasteReadyTimeoutMs(agent),
      readySignal: config.draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste',
      settings: getSettingsForAgentTabRuntimeOwner(tabId)
    }).then(
      async (readiness) => {
        if (settled) {
          return
        }
        if (!readiness) {
          finish(false)
          return
        }
        if (readiness.ready) {
          finish(true)
          return
        }
        const fallback = await waitForAgentReady(tabId, config.expectedProcess, { timeoutMs: 1000 })
        if (fallback.ready && !settled) {
          args.onUnconfirmedDelivery?.()
        }
        finish(fallback.ready)
      },
      () => finish(false)
    )
  })
}

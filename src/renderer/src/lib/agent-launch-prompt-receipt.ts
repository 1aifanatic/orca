import type { TuiAgent } from '../../../shared/tui-agent'
import {
  isExpectedAgentProcess,
  recognizeAgentProcess
} from '../../../shared/agent-process-recognition'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { resolveDraftPasteReadyTimeoutMs } from '../../../shared/draft-paste-ready-timeout'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { waitForAgentDraftInputReady } from './agent-draft-readiness'
import { getSettingsForAgentTabRuntimeOwner, PTY_SPAWN_TIMEOUT_MS } from './agent-paste-draft'

type AppState = ReturnType<typeof useAppStore.getState>

export type LaunchPromptReceipt = 'delivered' | 'not-delivered' | 'agent-exited' | 'unconfirmed'

/** How long a hook turn may still arrive after a read that could not tell. */
const HOOK_GRACE_AFTER_UNKNOWN_READ_MS = 2000
/** How often what holds the terminal is read until the receipt settles. */
const FOREGROUND_POLL_MS = 250
/** How long after the ready signal the shell may stay in front before the launch line runs: a
 *  slow shell startup can draw its prompt, and look ready, before it types the line. */
const LAUNCH_LINE_WAIT_AFTER_READY_MS = 30_000

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

/** Whether the host names the launched agent itself in front: proof it started, which a read of
 *  "not the shell" is not (a slow shell startup runs its own commands in front first). */
async function launchedAgentNamedInFront(ptyId: string, agent: TuiAgent): Promise<boolean> {
  if (isRemoteRuntimePtyId(ptyId)) {
    return false
  }
  const name = await window.api.pty.getForegroundProcess(ptyId).catch(() => null)
  return (
    name !== null &&
    (recognizeAgentProcess(name)?.agent === agent ||
      isExpectedAgentProcess(name, TUI_AGENT_CONFIG[agent].expectedProcess))
  )
}

/**
 * Whether a prompt that rode an agent's launch command reached the agent, proven the way #24257's
 * crash guard proves an agent before a paste. Delivered on the agent's own hook turn on the tab, or
 * a fresh read on the execution host that finds the launched agent, not its shell, in front of the
 * terminal (`readLaunchedAgentForeground`). A ready signal never counts on its own: it only times
 * that read, and bracketed paste turned off (`2004l`) revokes it. Not delivered when the PTY never
 * spawns (a refused launch file included) or the tab closes. Agent exited only on proof it ran and
 * ended: the agent itself was named in front, then the shell came back or the PTY exited. A shell
 * in front before then is a launch line not yet run (a slow shell startup), so the reads go on.
 * Unconfirmed when nothing proves either, as on a Windows host without hooks.
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
    let agentSeen = false
    const watchForeground = (ptyId: string): void => {
      const config = TUI_AGENT_CONFIG[agent]
      let readyAt: number | null = null
      let graceArmed = false
      void waitForAgentDraftInputReady(
        ptyId,
        resolveDraftPasteReadyTimeoutMs(agent),
        config.draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste',
        getSettingsForAgentTabRuntimeOwner(tabId),
        { revokeOnBracketedPasteOff: true }
      )
        .then(() => {
          readyAt = Date.now()
        })
        .catch(() => finish('unconfirmed'))
      const read = async (): Promise<void> => {
        const [foreground, named] = await Promise.all([
          readLaunchedAgentForeground(ptyId, agent),
          agentSeen ? Promise.resolve(true) : launchedAgentNamedInFront(ptyId, agent)
        ])
        if (settled) {
          return
        }
        agentSeen ||= named && foreground === 'agent'
        if (foreground === 'agent' && readyAt !== null) {
          finish('delivered')
        } else if (foreground === 'shell' && agentSeen) {
          finish('agent-exited')
        } else if (readyAt !== null && Date.now() - readyAt >= LAUNCH_LINE_WAIT_AFTER_READY_MS) {
          finish('unconfirmed')
        } else {
          if (foreground === 'unknown' && readyAt !== null && !graceArmed) {
            graceArmed = true
            timers.push(
              window.setTimeout(() => finish('unconfirmed'), HOOK_GRACE_AFTER_UNKNOWN_READ_MS)
            )
          }
          timers.push(window.setTimeout(() => void read(), FOREGROUND_POLL_MS))
        }
      }
      void read().catch(() => finish('unconfirmed'))
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
        watchForeground(ptyId)
      } else if (!tabExists(state, tabId)) {
        finish('not-delivered')
      } else if (boundPtyId && !ptyId) {
        finish(agentSeen ? 'agent-exited' : 'unconfirmed')
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

import {
  waitForAgentReadyEvidence,
  type AgentReadyResult
} from '../../../shared/agent-ready-evidence'
export type { AgentReadyReason, AgentReadyResult } from '../../../shared/agent-ready-evidence'
import { useAppStore } from '@/store'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'

function resolvePrimaryPtyId(tabId: string): string | null {
  const state = useAppStore.getState()
  const ptyIds = state.ptyIdsByTabId[tabId]
  return ptyIds?.[0] ?? null
}

function readReadyTitles(tabId: string): string[] {
  const state = useAppStore.getState()
  const paneTitles = state.runtimePaneTitlesByTabId[tabId]
  const titles: string[] = []
  if (paneTitles) {
    for (const title of Object.values(paneTitles)) {
      if (title) {
        titles.push(title)
      }
    }
  }
  // Why: fall back to the persisted tab.title when runtime pane titles haven't
  // been populated yet (e.g. the TerminalPane has not mounted a title handler
  // for this tab). Finding the tab by id walks every worktree, which is fine
  // at poll rates — the map is small.
  if (titles.length === 0) {
    for (const tabs of Object.values(state.tabsByWorktree)) {
      const tab = tabs.find((t) => t.id === tabId)
      if (tab?.title) {
        titles.push(tab.title)
        break
      }
    }
  }
  return titles
}

/**
 * Wait until the agent we launched on `tabId` is ready to accept typed input.
 *
 * Checks, in order of preference:
 *   1. Terminal title reports an idle agent status.
 *   2. Foreground process name matches `expectedProcess`.
 *   3. PTY has at least one non-shell child process (after a brief grace
 *      period so we don't accept the shell's own transient children).
 *
 * Resolves early on the first match, or after `timeoutMs` with
 * `{ ready: false, reason: 'timeout' }`. Never rejects.
 */
export async function waitForAgentReady(
  tabId: string,
  expectedProcess: string,
  opts?: { timeoutMs?: number }
): Promise<AgentReadyResult> {
  return waitForAgentReadyEvidence(
    {
      readTitles: () => readReadyTitles(tabId),
      inspectProcess: async () => {
        const ptyId = resolvePrimaryPtyId(tabId)
        return ptyId ? inspectRuntimeTerminalProcess(useAppStore.getState().settings, ptyId) : null
      }
    },
    expectedProcess,
    opts?.timeoutMs ?? 5000
  )
}

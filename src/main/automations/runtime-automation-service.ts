/**
 * The AutomationService a runtime host executes schedules with. Shared by Electron startup and
 * orcad so both hosts dispatch through the same headless path.
 */
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { AutomationService } from './service'
import { observeHeadlessRunCompletion } from './headless-run-completion'
import { buildHeadlessAutomationWorktreeCreateArgs } from './headless-workspace-create'
import { createRuntimeAutomationRunTerminalObserver } from './runtime-terminal-run-observer'

export function createRuntimeAutomationService(input: {
  store: Store
  runtime: OrcaRuntimeService
  claudeUsage?: ClaudeUsageStore
  codexUsage?: CodexUsageStore
  /** A server process: it executes remote_host_service-owned schedules and dispatches headlessly. */
  headless: boolean
}): AutomationService {
  const { store, runtime, claudeUsage, codexUsage } = input
  const service = new AutomationService(store, {
    claudeUsage,
    codexUsage,
    terminalObserver: createRuntimeAutomationRunTerminalObserver(runtime),
    onAutomationsChanged: (payload) => runtime.notifyAutomationsChanged(payload),
    allowRemoteHostScheduling: input.headless,
    headlessDispatcher: input.headless
      ? async ({ automation, run, target }) => {
          const dispatchedAt = Date.now()
          let terminalHandle: string
          let terminalSessionId: string | null = null
          let terminalPaneKey: string | null = null
          let terminalPtyId: string | null = null
          let workspaceId: string
          let workspaceDisplayName: string | null = null
          if (automation.workspaceMode === 'new_per_run') {
            const created = await runtime.createManagedWorktree(
              buildHeadlessAutomationWorktreeCreateArgs({ automation, run, repo: target.repo })
            )
            terminalHandle = created.startupTerminal?.handle ?? ''
            terminalSessionId = created.startupTerminal?.tabId ?? null
            terminalPaneKey = created.startupTerminal?.paneKey ?? null
            terminalPtyId = created.startupTerminal?.ptyId ?? null
            workspaceId = created.worktree.id
            workspaceDisplayName = created.worktree.displayName ?? null
            if (!terminalHandle) {
              throw new Error(
                created.warning ||
                  'Automation workspace was created, but no agent terminal started.'
              )
            }
          } else {
            if (!automation.workspaceId) {
              throw new Error('The target workspace is no longer available.')
            }
            const terminal = await runtime.launchAgentTerminal(`id:${automation.workspaceId}`, {
              agent: automation.agentId,
              prompt: automation.prompt,
              title: run.title
            })
            terminalHandle = terminal.handle
            terminalSessionId = terminal.tabId ?? null
            terminalPaneKey = terminal.paneKey ?? null
            terminalPtyId = terminal.ptyId ?? null
            workspaceId = terminal.worktreeId
            const worktree = await runtime.showManagedWorktree(`id:${workspaceId}`)
            workspaceDisplayName = worktree.displayName ?? null
          }
          const completion = observeHeadlessRunCompletion(runtime, {
            handle: terminalHandle,
            paneKey: terminalPaneKey,
            dispatchedAt
          })
          return {
            workspaceId,
            workspaceDisplayName,
            terminalSessionId,
            terminalPaneKey,
            terminalPtyId,
            completion
          }
        }
      : undefined
  })
  runtime.setAutomationService(service)
  return service
}

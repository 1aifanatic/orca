import { isShellProcess } from '../../shared/agent-detection'
import { isExpectedAgentProcess } from '../../shared/agent-process-recognition'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'
import { watchAgentComposerReady, type AgentComposerReadyWatch } from './agent-composer-ready-watch'
import type { OrcaRuntimeService } from './orca-runtime'
import { TUI_IDLE_POLL_INTERVAL_MS, TUI_IDLE_QUIESCENCE_MS } from './orca-runtime-postlude'
import { deliverTerminalAgentLaunchPrompt } from './terminal-agent-prompt-delivery'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'

const FOLLOWUP_POLL_ATTEMPTS = 30
const FOLLOWUP_POLL_INTERVAL_MS = 150
const BRACKETED_PASTE_BEGIN = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const BRACKETED_PASTE_QUIET_MS = 1500
// Why: tui-idle confirms composer evidence after its own quiet window and on the next poll, so the
// budget grows by exactly that extra latency: the latest paste stays as late after the agent settles.
const DRAFT_READY_CONFIRMATION_LATENCY_MS =
  TUI_IDLE_QUIESCENCE_MS + TUI_IDLE_POLL_INTERVAL_MS - BRACKETED_PASTE_QUIET_MS

export type WorktreeStartupReadinessHost = Pick<
  OrcaRuntimeService,
  'waitForTerminal' | 'sendTerminalAgentPrompt'
> & {
  getPtyId: (handle: string) => string | null
  getForegroundProcess: (ptyId: string) => Promise<string | null>
  hasChildProcesses?: (ptyId: string) => Promise<boolean>
  subscribeToData: (ptyId: string, listener: (data: string) => void) => () => void
  readRecentOutput: (ptyId: string) => string | undefined
  write: (ptyId: string, data: string) => void
}

/**
 * Each startup delivery has one decision point: when its base mechanism fires, the launch-readiness
 * wait decides instead only if the agent declares its composer evidence and its command owns the
 * PTY (OSC 133;C). A shell that writes OSC 133 marks gets until the end of the base budget for that
 * mark, then the base delivery. Undeclared agents and shells that write no OSC 133 marks at all
 * keep the base delivery exactly.
 */
function watchLaunchOwnership(
  host: WorktreeStartupReadinessHost,
  handle: string,
  agent: TuiAgent
): AgentComposerReadyWatch | null {
  const ptyId = host.getPtyId(handle)
  return ptyId
    ? watchAgentComposerReady(agent, {
        subscribeToData: (listener) => host.subscribeToData(ptyId, listener),
        readRecentOutput: () => host.readRecentOutput(ptyId)
      })
    : null
}

/** `deadlineAt`: the end of the base mechanism's own budget. */
async function launchWaitDecides(
  ownership: AgentComposerReadyWatch | null,
  deadlineAt: number
): Promise<boolean> {
  if (ownership === null || ownership.signal() !== 'unowned') {
    return ownership !== null
  }
  if (!ownership.shellMarksCommands()) {
    return false
  }
  // Why wait: a shell that marked its prompt marks the command start too, and daemon output can reach
  // Orca after the OS already reports the agent in the foreground.
  return ownership.waitForOwnership(deadlineAt - Date.now())
}

export function pasteWorktreeStartupDraftWhenReady(
  host: WorktreeStartupReadinessHost,
  handle: string,
  draft: WorktreeStartupDraftPaste
): void {
  const startedAt = Date.now()
  const ownership = watchLaunchOwnership(host, handle, draft.agent)
  void waitForWorktreeStartupDraft(host, handle, draft.agent)
    .then(async (ptyId) => {
      if (!ptyId) {
        console.warn('[worktree-create] agent did not become ready for draft paste')
        return
      }
      if (
        await launchWaitDecides(ownership, startedAt + resolveDraftPasteReadyTimeoutMs(draft.agent))
      ) {
        const wait = await host.waitForTerminal(handle, {
          condition: 'tui-idle',
          // Why the draft's own budget: unsent text pasted long after start can land mid-typing.
          timeoutMs:
            startedAt +
            resolveDraftPasteReadyTimeoutMs(draft.agent) +
            DRAFT_READY_CONFIRMATION_LATENCY_MS -
            Date.now(),
          acceptComposerReady: true
        })
        if (!wait.satisfied) {
          console.warn('[worktree-create] agent did not become ready for draft paste')
          return
        }
      }
      host.write(ptyId, `${BRACKETED_PASTE_BEGIN}${draft.content}${BRACKETED_PASTE_END}`)
    })
    .catch((error) => console.warn('[worktree-create] failed to paste startup draft:', error))
    .finally(() => ownership?.dispose())
}

export function sendWorktreeStartupFollowupWhenReady(
  host: WorktreeStartupReadinessHost,
  handle: string,
  followup: WorktreeStartupFollowup
): void {
  const startedAt = Date.now()
  const ownership = watchLaunchOwnership(host, handle, followup.agent)
  void waitForWorktreeStartupFollowup(host, handle, followup.expectedProcess)
    .then(async (ptyId) => {
      if (!ptyId) {
        console.warn('[worktree-create] agent did not become ready for follow-up prompt')
        return
      }
      const deadlineAt = startedAt + FOLLOWUP_POLL_ATTEMPTS * FOLLOWUP_POLL_INTERVAL_MS
      if (!(await launchWaitDecides(ownership, deadlineAt))) {
        host.write(ptyId, `${followup.prompt}\r`)
        return
      }
      // Why the shared deliverer: a typed `prompt\r` submits at the first newline, and a
      // process-name match is not a composer that can take input.
      const delivered = await deliverTerminalAgentLaunchPrompt({
        runtime: host,
        handle,
        text: followup.prompt,
        terminalLaunched: true
      })
      if (!delivered) {
        console.warn('[worktree-create] agent did not take its startup follow-up prompt')
      }
    })
    .catch((error) =>
      console.warn('[worktree-create] failed to send startup follow-up prompt:', error)
    )
    .finally(() => ownership?.dispose())
}

export async function waitForWorktreeStartupFollowup(
  host: WorktreeStartupReadinessHost,
  handle: string,
  expectedProcess: string
): Promise<string | null> {
  const ptyId = host.getPtyId(handle)
  if (!ptyId) {
    return null
  }
  for (let attempt = 0; attempt < FOLLOWUP_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, FOLLOWUP_POLL_INTERVAL_MS))
    }
    try {
      const foregroundProcess = await host.getForegroundProcess(ptyId)
      if (isExpectedAgentProcess(foregroundProcess, expectedProcess)) {
        return ptyId
      }
      if (attempt >= 4 && !isShellProcess(foregroundProcess ?? '')) {
        if ((await host.hasChildProcesses?.(ptyId).catch(() => false)) ?? false) {
          return ptyId
        }
      }
    } catch {
      // Ignore transient PTY inspection failures and keep polling.
    }
  }
  return null
}

export function waitForWorktreeStartupDraft(
  host: WorktreeStartupReadinessHost,
  handle: string,
  agent: TuiAgent
): Promise<string | null> {
  const ptyId = host.getPtyId(handle)
  if (!ptyId) {
    return Promise.resolve(null)
  }
  const signal =
    TUI_AGENT_CONFIG[agent].draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
  return new Promise((resolve) => {
    let settled = false
    const scanner = createDraftPasteReadyScanner(signal)
    let quietTimer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null
    let unsubscribe: (() => void) | null = null
    const finish = (value: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (quietTimer) {
        clearTimeout(quietTimer)
      }
      if (hardTimer) {
        clearTimeout(hardTimer)
      }
      unsubscribe?.()
      resolve(value)
    }
    const observe = (data: string): void => {
      const result = scanner.observe(data)
      if (result.ready) {
        return finish(ptyId)
      }
      if (result.armQuietTimer) {
        if (quietTimer) {
          clearTimeout(quietTimer)
        }
        quietTimer = setTimeout(() => finish(ptyId), BRACKETED_PASTE_QUIET_MS)
      }
    }
    unsubscribe = host.subscribeToData(ptyId, observe)
    const replay = host.readRecentOutput(ptyId)
    if (replay) {
      observe(replay)
    }
    hardTimer = setTimeout(() => finish(null), resolveDraftPasteReadyTimeoutMs(agent))
  })
}

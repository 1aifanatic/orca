import { isShellProcess } from '../../shared/agent-detection'
import { isExpectedAgentProcess } from '../../shared/agent-process-recognition'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'
import { agentDeclaresLaunchReadiness } from './agent-composer-ready-watch'
import type { OrcaRuntimeService } from './orca-runtime'
import { TUI_IDLE_POLL_INTERVAL_MS, TUI_IDLE_QUIESCENCE_MS } from './orca-runtime-postlude'
import { deliverTerminalAgentLaunchPrompt } from './terminal-agent-prompt-delivery'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'

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
  /** Whether Orca's shell integration marks this pane's startup command (OSC 133), as decided when
   *  the pane was spawned. */
  startupCommandMarked: (handle: string) => boolean
  getForegroundProcess: (ptyId: string) => Promise<string | null>
  hasChildProcesses?: (ptyId: string) => Promise<boolean>
  subscribeToData: (ptyId: string, listener: (data: string) => void) => () => void
  readRecentOutput: (ptyId: string) => string | undefined
  write: (ptyId: string, data: string) => void
}

/**
 * The one decision per startup delivery, made before anything is written: the launch-readiness wait
 * delivers only for an agent that declares its composer evidence, in a pane whose own shell
 * integration marks the startup command, so the wait can prove the agent owns the PTY. Everything
 * else keeps the base delivery exactly.
 */
function launchReadinessDelivers(
  host: WorktreeStartupReadinessHost,
  handle: string,
  agent: TuiAgent
): boolean {
  return agentDeclaresLaunchReadiness(agent) && host.startupCommandMarked(handle)
}

export function pasteWorktreeStartupDraftWhenReady(
  host: WorktreeStartupReadinessHost,
  handle: string,
  draft: WorktreeStartupDraftPaste
): void {
  const paste = `${BRACKETED_PASTE_BEGIN}${draft.content}${BRACKETED_PASTE_END}`
  if (launchReadinessDelivers(host, handle, draft.agent)) {
    void pasteDraftAfterLaunchReadiness(host, handle, draft.agent, paste).catch((error) =>
      console.warn('[worktree-create] failed to paste startup draft:', error)
    )
    return
  }
  void waitForWorktreeStartupDraft(host, handle, draft.agent)
    .then((ptyId) => {
      if (!ptyId) {
        console.warn('[worktree-create] agent did not become ready for draft paste')
        return
      }
      host.write(ptyId, paste)
    })
    .catch((error) => console.warn('[worktree-create] failed to paste startup draft:', error))
}

async function pasteDraftAfterLaunchReadiness(
  host: WorktreeStartupReadinessHost,
  handle: string,
  agent: TuiAgent,
  paste: string
): Promise<void> {
  const ptyId = host.getPtyId(handle)
  const wait = ptyId
    ? await host.waitForTerminal(handle, {
        condition: 'tui-idle',
        // Why the draft's own budget: unsent text pasted long after start can land mid-typing.
        timeoutMs: resolveDraftPasteReadyTimeoutMs(agent) + DRAFT_READY_CONFIRMATION_LATENCY_MS,
        acceptComposerReady: true
      })
    : null
  if (!ptyId || !wait?.satisfied) {
    console.warn('[worktree-create] agent did not become ready for draft paste')
    return
  }
  host.write(ptyId, paste)
}

export function sendWorktreeStartupFollowupWhenReady(
  host: WorktreeStartupReadinessHost,
  handle: string,
  followup: WorktreeStartupFollowup
): void {
  if (launchReadinessDelivers(host, handle, followup.agent)) {
    // Why the shared deliverer: a typed `prompt\r` submits at the first newline, and a
    // process-name match is not a composer that can take input.
    void deliverTerminalAgentLaunchPrompt({
      runtime: host,
      handle,
      text: followup.prompt,
      terminalLaunched: true
    }).then((delivered) => {
      if (!delivered) {
        console.warn('[worktree-create] agent did not take its startup follow-up prompt')
      }
    })
    return
  }
  void waitForWorktreeStartupFollowup(host, handle, followup.expectedProcess)
    .then((ptyId) => {
      if (!ptyId) {
        console.warn('[worktree-create] agent did not become ready for follow-up prompt')
        return
      }
      host.write(ptyId, `${followup.prompt}\r`)
    })
    .catch((error) =>
      console.warn('[worktree-create] failed to send startup follow-up prompt:', error)
    )
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
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 150))
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

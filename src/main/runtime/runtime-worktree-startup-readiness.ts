import { isShellProcess } from '../../shared/agent-detection'
import { isExpectedAgentProcess } from '../../shared/agent-process-recognition'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'

const BRACKETED_PASTE_BEGIN = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const BRACKETED_PASTE_QUIET_MS = 1500
// Why: an interactive shell turns bracketed paste on at its prompt and off when it runs the typed
// command (`zsh-prompt-runs-command.txt`), so a 2004 before the last `?2004l` is the shell's.
const DECRST_BRACKETED_PASTE = '\x1b[?2004l'
// Each check is a process-table scan; this pace keeps an 8 s wait to a few dozen of them.
const AGENT_OWNERSHIP_POLL_MS = 250
/** Output held until the agent owns the terminal; the ready signal reads only its recent tail. */
const PRE_OWNERSHIP_OUTPUT_CHARS = 64 * 1024

export type WorktreeStartupReadinessHost = {
  getPtyId: (handle: string) => string | null
  getForegroundProcess: (ptyId: string) => Promise<string | null>
  hasChildProcesses?: (ptyId: string) => Promise<boolean>
  subscribeToData: (ptyId: string, listener: (data: string) => void) => () => void
  readRecentOutput: (ptyId: string) => string | undefined
  write: (ptyId: string, data: string, inputKind: TerminalInputKind) => void
}

export function pasteWorktreeStartupDraftWhenReady(
  host: WorktreeStartupReadinessHost,
  handle: string,
  draft: WorktreeStartupDraftPaste
): void {
  void waitForWorktreeStartupDraft(host, handle, draft.agent)
    .then((ptyId) => {
      if (!ptyId) {
        console.warn('[worktree-create] agent did not become ready for draft paste')
        return
      }
      host.write(ptyId, `${BRACKETED_PASTE_BEGIN}${draft.content}${BRACKETED_PASTE_END}`, 'launch')
    })
    .catch((error) => console.warn('[worktree-create] failed to paste startup draft:', error))
}

export function sendWorktreeStartupFollowupWhenReady(
  host: WorktreeStartupReadinessHost,
  handle: string,
  followup: WorktreeStartupFollowup
): void {
  void waitForWorktreeStartupFollowup(host, handle, followup.expectedProcess)
    .then((ptyId) => {
      if (!ptyId) {
        console.warn('[worktree-create] agent did not become ready for follow-up prompt')
        return
      }
      host.write(ptyId, `${followup.prompt}\r`, 'launch')
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

export type StartupDraftReadinessOptions = {
  timeoutMs?: number
  requireComposerMarker?: boolean
  signal?: AbortSignal
  /** Vetoes a ready signal whose screen still holds something the input must not answer; the
   *  scan continues, so the agent's next marker or quiet window asks again. */
  accept?: (ptyId: string) => boolean | Promise<boolean>
  /**
   * Whether the launched agent, not the shell, owns the terminal. Until it does, output is held
   * rather than scanned, and once it does only what followed the shell's hand-off counts: the
   * shell's own prompt enables bracketed paste too, and read as the agent's it pasted into an
   * agent still starting, or into the shell after the agent exited.
   */
  agentOwnsTerminal?: (ptyId: string) => Promise<boolean>
}

/** The output after the shell last turned bracketed paste off to run a command. */
function outputSinceShellHandoff(held: string): string {
  const handoff = held.lastIndexOf(DECRST_BRACKETED_PASTE)
  return handoff === -1 ? held : held.slice(handoff + DECRST_BRACKETED_PASTE.length)
}

export function waitForWorktreeStartupDraft(
  host: WorktreeStartupReadinessHost,
  handle: string,
  agent: TuiAgent,
  options: StartupDraftReadinessOptions = {}
): Promise<string | null> {
  const ptyId = host.getPtyId(handle)
  if (!ptyId || options.signal?.aborted) {
    return Promise.resolve(null)
  }
  const signal =
    TUI_AGENT_CONFIG[agent].draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
  return new Promise((resolve) => {
    let settled = false
    const scanner = createDraftPasteReadyScanner(signal)
    let quietTimer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null
    let ownershipTimer: NodeJS.Timeout | null = null
    let unsubscribe: (() => void) | null = null
    let heldOutput: string | null = options.agentOwnsTerminal ? '' : null
    const onAbort = (): void => finish(null)
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
      if (ownershipTimer) {
        clearTimeout(ownershipTimer)
      }
      unsubscribe?.()
      options.signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const finishIfAccepted = (): void => {
      if (!options.accept) {
        return finish(ptyId)
      }
      void Promise.resolve(options.accept(ptyId)).then(
        (accepted) => {
          if (accepted) {
            finish(ptyId)
          }
        },
        () => {}
      )
    }
    const observe = (data: string): void => {
      if (settled) {
        return
      }
      if (heldOutput !== null) {
        heldOutput = (heldOutput + data).slice(-PRE_OWNERSHIP_OUTPUT_CHARS)
        return
      }
      const result = scanner.observe(data)
      if (result.ready) {
        return finishIfAccepted()
      }
      if (result.armQuietTimer && !options.requireComposerMarker) {
        if (quietTimer) {
          clearTimeout(quietTimer)
        }
        quietTimer = setTimeout(finishIfAccepted, BRACKETED_PASTE_QUIET_MS)
      }
    }
    options.signal?.addEventListener('abort', onAbort)
    unsubscribe = host.subscribeToData(ptyId, observe)
    hardTimer = setTimeout(
      () => finish(null),
      options.timeoutMs ?? resolveDraftPasteReadyTimeoutMs(agent)
    )
    const replay = host.readRecentOutput(ptyId)
    if (replay) {
      observe(replay)
    }
    const agentOwnsTerminal = options.agentOwnsTerminal
    if (agentOwnsTerminal) {
      const checkOwnership = (): void => {
        void agentOwnsTerminal(ptyId)
          .catch(() => false)
          .then((owns) => {
            if (settled) {
              return
            }
            if (!owns) {
              ownershipTimer = setTimeout(checkOwnership, AGENT_OWNERSHIP_POLL_MS)
              return
            }
            const held = heldOutput ?? ''
            heldOutput = null
            const fromAgent = outputSinceShellHandoff(held)
            if (fromAgent) {
              observe(fromAgent)
            }
          })
      }
      checkOwnership()
    }
  })
}

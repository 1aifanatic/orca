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
// A foreground read can cost a process-table scan; this pace keeps an 8 s wait to a few dozen.
const AGENT_FOREGROUND_RETRY_MS = 250
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

/** Who is in the terminal's foreground: the launched agent, the shell, or it could not be read. */
export type LaunchedAgentForeground = 'agent' | 'shell' | 'unknown'

export type StartupDraftReadinessOptions = {
  timeoutMs?: number
  requireComposerMarker?: boolean
  signal?: AbortSignal
  /** Vetoes a ready signal whose screen still holds something the input must not answer; the
   *  scan continues, so the agent's next marker or quiet window asks again. */
  accept?: (ptyId: string) => boolean | Promise<boolean>
  /**
   * Who owns the terminal. With it, output is held rather than scanned until the shell hands the
   * terminal over (its `?2004l`), or failing that until the agent is seen in front, and only what
   * followed the hand-off counts: the shell's own prompt enables bracketed paste too. A ready
   * signal then settles only once the agent is seen in front; it is kept, not dropped, while that
   * is not yet so, since an idle agent may never signal again.
   */
  readAgentForeground?: (ptyId: string) => Promise<LaunchedAgentForeground>
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
  const readAgentForeground = options.readAgentForeground
  return new Promise((resolve) => {
    let settled = false
    const scanner = createDraftPasteReadyScanner(signal)
    let quietTimer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null
    let foregroundTimer: NodeJS.Timeout | null = null
    let unsubscribe: (() => void) | null = null
    let heldOutput: string | null = readAgentForeground ? '' : null
    let checking = false
    let checkAgain = false
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
      if (foregroundTimer) {
        clearTimeout(foregroundTimer)
      }
      unsubscribe?.()
      options.signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const retryForeground = (check: () => void): void => {
      if (foregroundTimer) {
        clearTimeout(foregroundTimer)
      }
      foregroundTimer = setTimeout(check, AGENT_FOREGROUND_RETRY_MS)
    }
    /** Settles a fired signal once its screen is clear and the agent is in front. */
    const settleSignal = async (): Promise<void> => {
      if (checking) {
        checkAgain = true
        return
      }
      checking = true
      try {
        if (options.accept && !(await options.accept(ptyId))) {
          return
        }
        const foreground = readAgentForeground ? await readAgentForeground(ptyId) : 'agent'
        if (foreground === 'agent') {
          finish(ptyId)
        } else if (!settled) {
          retryForeground(() => void settleSignal())
        }
      } catch {
        if (!settled) {
          retryForeground(() => void settleSignal())
        }
      } finally {
        checking = false
        if (checkAgain && !settled) {
          checkAgain = false
          void settleSignal()
        }
      }
    }
    const onSignal = (): void => {
      void settleSignal()
    }
    const release = (): void => {
      const held = heldOutput ?? ''
      heldOutput = null
      if (foregroundTimer) {
        clearTimeout(foregroundTimer)
        foregroundTimer = null
      }
      const fromAgent = outputSinceShellHandoff(held)
      if (fromAgent) {
        observe(fromAgent)
      }
    }
    const observe = (data: string): void => {
      if (settled) {
        return
      }
      if (heldOutput !== null) {
        heldOutput = (heldOutput + data).slice(-PRE_OWNERSHIP_OUTPUT_CHARS)
        if (data.includes(DECRST_BRACKETED_PASTE)) {
          release()
        }
        return
      }
      const result = scanner.observe(data)
      if (result.ready) {
        return onSignal()
      }
      if (result.armQuietTimer && !options.requireComposerMarker) {
        if (quietTimer) {
          clearTimeout(quietTimer)
        }
        quietTimer = setTimeout(onSignal, BRACKETED_PASTE_QUIET_MS)
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
    // A shell that never enables bracketed paste never hands over in the stream; ask who is in front.
    if (readAgentForeground && heldOutput !== null) {
      const checkHandoff = (): void => {
        void readAgentForeground(ptyId)
          .catch((): LaunchedAgentForeground => 'unknown')
          .then((foreground) => {
            if (settled || heldOutput === null) {
              return
            }
            if (foreground === 'agent') {
              release()
            } else {
              retryForeground(checkHandoff)
            }
          })
      }
      retryForeground(checkHandoff)
    }
  })
}

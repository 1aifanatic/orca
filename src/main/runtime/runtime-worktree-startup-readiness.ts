import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import type { OrcaRuntimeService } from './orca-runtime'
import { TUI_IDLE_POLL_INTERVAL_MS, TUI_IDLE_QUIESCENCE_MS } from './orca-runtime-postlude'
import { deliverTerminalAgentLaunchPrompt } from './terminal-agent-prompt-delivery'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'

const BRACKETED_PASTE_BEGIN = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
// The quiet window the per-agent draft budgets were sized for.
const DRAFT_BUDGET_QUIET_MS = 1500
// Why: tui-idle confirms composer evidence after its own quiet window and on the next poll, so the
// budget grows by exactly that extra latency: the latest paste stays as late after the agent settles.
const DRAFT_READY_CONFIRMATION_LATENCY_MS =
  TUI_IDLE_QUIESCENCE_MS + TUI_IDLE_POLL_INTERVAL_MS - DRAFT_BUDGET_QUIET_MS

export type WorktreeStartupReadinessHost = Pick<
  OrcaRuntimeService,
  'waitForTerminal' | 'sendTerminalAgentPrompt'
> & {
  getPtyId: (handle: string) => string | null
  write: (ptyId: string, data: string) => void
}

export function pasteWorktreeStartupDraftWhenReady(
  host: WorktreeStartupReadinessHost,
  handle: string,
  draft: WorktreeStartupDraftPaste
): void {
  void host
    .waitForTerminal(handle, {
      condition: 'tui-idle',
      // Why the draft's own budget: unsent text pasted long after start can land mid-typing.
      timeoutMs: resolveDraftPasteReadyTimeoutMs(draft.agent) + DRAFT_READY_CONFIRMATION_LATENCY_MS,
      acceptComposerReady: true
    })
    .then((wait) => {
      const ptyId = host.getPtyId(handle)
      if (!wait.satisfied || !ptyId) {
        console.warn('[worktree-create] agent did not become ready for draft paste')
        return
      }
      // Why no submit: a draft stays editable in the agent's composer.
      host.write(ptyId, `${BRACKETED_PASTE_BEGIN}${draft.content}${BRACKETED_PASTE_END}`)
    })
    .catch((error) => console.warn('[worktree-create] failed to paste startup draft:', error))
}

export function sendWorktreeStartupFollowupWhenReady(
  host: WorktreeStartupReadinessHost,
  handle: string,
  followup: WorktreeStartupFollowup
): void {
  // Why the shared deliverer: a typed `prompt\r` submits at the first newline, and a process-name
  // match is not a composer that can take input.
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
}

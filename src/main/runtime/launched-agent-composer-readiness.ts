/**
 * The one answer to "has the agent Orca just launched opened its composer?", shared by every host
 * path that writes a first input into a fresh agent: `agent.launch`'s terminal prompt and an
 * orchestration worker's first dispatch.
 *
 * The signal is the one the desktop's own paste used: bracketed paste turned on (DECSET 2004) plus
 * the agent's `draftPasteReadySignal` (its composer marker, or a quiet render after 2004), read by
 * the shared `draft-paste-ready-scanner`. That signal cannot tell a composer from a startup dialog
 * drawn in the same mode, so it counts only while the pane shows no startup dialog and no Codex
 * provisional header (`isFreshComposerClear`).
 *
 * Windows ConPTY never forwards DECSET 2004, so there the signal never fires. The `tui-idle`
 * evidence ranking (idle titles, known ready screens) runs beside it as the floor, and it is also
 * what reports a dialog left up. A few agents show readiness only in their composer, which that
 * ranking cannot read: ZCode paints no title and repaints its banner forever, DSH's idle hook fires
 * only after a turn, and Grok's only title is its bare name. They wait for their marker alone.
 */

import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeTerminalWait } from '../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from './orca-runtime'
import { isCodexProvisionalStartupText } from './codex-terminal-readiness'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'

/**
 * Agents whose launch readiness is a composer marker pinned by a captured transcript
 * (`zcode-readiness-transcript.test.ts`, `dsh-readiness-transcript.test.ts`,
 * `draft-paste-ready-scanner-grok-trace-replay.test.ts`). Grok is here because its only other
 * evidence is its bare name, which a shell auto-title also writes, and its screen never quiets.
 */
const COMPOSER_MARKER_READINESS_AGENTS: ReadonlySet<TuiAgent> = new Set(['zcode', 'dsh', 'grok'])

/**
 * Composer-marker agents that can also render inline, where the marker's alternate-screen anchor
 * never arrives (`grok-inline-startup-pty-trace.ts`). The quiet window after bracketed paste stays
 * armed for them as the floor, as the desktop's own paste and worktree.create's draft paste use it.
 */
const INLINE_RENDERING_COMPOSER_AGENTS: ReadonlySet<TuiAgent> = new Set(['grok'])

export type LaunchedAgentReadinessRuntime = Pick<
  OrcaRuntimeService,
  'waitForTerminal' | 'waitForFreshWorkerComposer'
>

/**
 * Whether a ready signal may be trusted: no startup dialog in the pane's text or on its screen, and
 * not Codex 0.157's provisional `model: loading` header, which discards input typed behind it.
 */
export function isFreshComposerClear(
  waitText: string,
  screenLines: readonly string[] | null
): boolean {
  return (
    detectTerminalWaitBlockedReason(waitText) === null &&
    (screenLines === null || detectTerminalWaitBlockedReason(screenLines.join('\n')) === null) &&
    !isCodexProvisionalStartupText(waitText.toLowerCase())
  )
}

/**
 * Resolves `undefined` once the composer signal fires on a clear screen, else the `tui-idle` wait's
 * result (ready, or a dialog still up); throws when neither settles within the budget.
 */
export async function waitForLaunchedAgentComposer(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  agent: TuiAgent,
  timeoutMs: number
): Promise<RuntimeTerminalWait | undefined> {
  if (COMPOSER_MARKER_READINESS_AGENTS.has(agent)) {
    await runtime.waitForFreshWorkerComposer(handle, agent, timeoutMs, {
      requireComposerMarker: !INLINE_RENDERING_COMPOSER_AGENTS.has(agent)
    })
    return undefined
  }
  const stop = new AbortController()
  // A signal that never fires (ConPTY) or fails leaves the floor to decide.
  const composer = new Promise<undefined>((resolve) => {
    runtime
      .waitForFreshWorkerComposer(handle, agent, timeoutMs, {
        requireComposerMarker: false,
        signal: stop.signal
      })
      .then(
        () => resolve(undefined),
        () => {}
      )
  })
  // An agent that shows no readiness evidence comes back unsatisfied, so the caller keeps its text.
  const idle = runtime.waitForTerminal(handle, {
    condition: 'tui-idle',
    timeoutMs,
    launchReadiness: true,
    signal: stop.signal
  })
  try {
    return await Promise.race([composer, idle])
  } finally {
    stop.abort()
  }
}

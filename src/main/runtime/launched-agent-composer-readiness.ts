/**
 * The one answer to "has the agent Orca just launched opened its composer?", shared by every host
 * path that writes a first input into a fresh agent: `agent.launch`'s terminal prompt and, through
 * `waitForWorkerStartComposer`, an orchestration worker's first dispatch.
 *
 * The signal is the one the desktop's own paste used: bracketed paste turned on (DECSET 2004) plus
 * the agent's `draftPasteReadySignal` (its composer marker, or a quiet render after 2004), read by
 * the shared `draft-paste-ready-scanner`, within the same per-agent budget. That signal cannot tell
 * a composer from a startup dialog drawn in the same mode, so it counts only while the pane shows no
 * startup dialog and no Codex provisional header (`readFreshComposerHold`). Unlike the desktop's
 * paste it reads only output after the shell's last `?2004l`, and drops a signal while a shell is
 * proven in front (`readLaunchedAgentForeground`). A signal is never proof by itself: a shell back
 * at its prompt turns bracketed paste on too, so the write still needs the agent found in front.
 *
 * Desktop launches use its positive title/process/child fallback after the composer budget. Other
 * callers use the `tui-idle` evidence ranking, which also reports a dialog left up. Agents
 * whose composer marker a captured boot proves (`composerReadyCaptures`) wait for their marker alone.
 */

import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeTerminalWait } from '../../shared/runtime-terminal-contracts'
import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { draftPasteReadySignalHasMarker } from '../../shared/draft-paste-ready-scanner'
import { nameOnlyIdleNeedsCorroboration } from './tui-idle-evidence'
import type { OrcaRuntimeService } from './orca-runtime'
import { showsHoldAnchor } from './agent-state-rules/agent-state-text-anchors'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'

export type LaunchedAgentReadinessLane = 'composer-marker' | 'tui-idle'

export function getLaunchedAgentReadinessLane(agent: TuiAgent): LaunchedAgentReadinessLane {
  return TUI_AGENT_CONFIG[agent].composerReadyCaptures?.length ? 'composer-marker' : 'tui-idle'
}

export type LaunchedAgentReadinessRuntime = Pick<
  OrcaRuntimeService,
  'waitForTerminal' | 'waitForFreshWorkerComposer'
>

export type LaunchedAgentLaunchReadinessRuntime = LaunchedAgentReadinessRuntime &
  Pick<OrcaRuntimeService, 'waitForAgentLaunchFallback'>

/**
 * What keeps a ready signal from counting: a startup dialog in the pane's text or on its screen, or
 * a rule file's hold anchor (Codex 0.157's provisional `model: loading` header, which discards input).
 */
export function readFreshComposerHold(
  waitText: string,
  screenLines: readonly string[] | null
): 'dialog' | 'starting' | null {
  if (
    detectTerminalWaitBlockedReason(waitText) !== null ||
    (screenLines !== null && detectTerminalWaitBlockedReason(screenLines.join('\n')) !== null)
  ) {
    return 'dialog'
  }
  return showsHoldAnchor(waitText.toLowerCase()) ? 'starting' : null
}

/**
 * A fresh orchestration worker's first dispatch. Marker agents wait for their marker, as a launch
 * does; every other agent takes main's cue for this path, `tui-idle`, which settles on the agent's
 * own ready title instead of a quiet window after it. That dispatch waits for the render to settle
 * before Enter, so it never needed the desktop paste's later cue.
 */
export async function waitForWorkerStartComposer(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  agent: TuiAgent,
  timeoutMs: number
): Promise<RuntimeTerminalWait> {
  if (getLaunchedAgentReadinessLane(agent) === 'composer-marker') {
    return runtime.waitForFreshWorkerComposer(handle, agent, timeoutMs)
  }
  if (!workerStartReadsComposerMarker(agent)) {
    return runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      timeoutMs,
      launchReadiness: true
    })
  }
  const stop = new AbortController()
  try {
    return await firstAnswer(
      runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs,
        launchReadiness: true,
        signal: stop.signal
      }),
      runtime.waitForFreshWorkerComposer(handle, agent, timeoutMs, {
        requireComposerMarker: true,
        signal: stop.signal
      })
    )
  } finally {
    stop.abort()
  }
}

/**
 * An agent whose only rest signal is its bare name, which a launch holds to quiet output, and whose
 * composer draws a marker: that marker answers first. Grok draws its glyph at 0.6 s, then animates
 * its logo for ten.
 */
export function workerStartReadsComposerMarker(agent: TuiAgent): boolean {
  const signal = TUI_AGENT_CONFIG[agent].draftPasteReadySignal
  return (
    signal !== undefined &&
    draftPasteReadySignalHasMarker(signal) &&
    !nameOnlyIdleNeedsCorroboration(agent)
  )
}

/** The first wait to answer; a failure counts only once both failed, and then as the idle wait's. */
function firstAnswer(
  idle: Promise<RuntimeTerminalWait>,
  marker: Promise<RuntimeTerminalWait>
): Promise<RuntimeTerminalWait> {
  return new Promise((resolve, reject) => {
    let failures = 0
    let idleError: unknown
    const fail = (error: unknown, fromIdle: boolean): void => {
      if (fromIdle) {
        idleError = error
      }
      failures += 1
      if (failures === 2) {
        reject(idleError ?? error)
      }
    }
    idle.then(resolve, (error: unknown) => fail(error, true))
    marker.then(resolve, (error: unknown) => fail(error, false))
  })
}

export function waitForWorkerAgentReady(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  args: { agent: TuiAgent | undefined; reusesTerminal: boolean; timeoutMs: number }
): Promise<RuntimeTerminalWait> {
  // A caller-supplied terminal was not freshly launched, so its composer marker may be long gone.
  return args.agent && !args.reusesTerminal
    ? waitForWorkerStartComposer(runtime, handle, args.agent, args.timeoutMs)
    : runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: args.timeoutMs })
}

/**
 * The composer signal's wait, then — if it did not settle within the desktop paste's budget, or a
 * startup dialog is up — the `tui-idle` wait for what is left of `timeoutMs`, whose result says
 * ready, blocked by a dialog, or not ready. Throws when that runs out too.
 */
export async function waitForLaunchedAgentComposer(
  runtime: LaunchedAgentLaunchReadinessRuntime,
  handle: string,
  agent: TuiAgent,
  timeoutMs: number,
  /** The desktop qualifies a timed-out composer with positive fallback evidence; never Codex. */
  { desktopFallback = false }: { desktopFallback?: boolean } = {}
): Promise<RuntimeTerminalWait | 'fallback-ready'> {
  const markerLane = getLaunchedAgentReadinessLane(agent) === 'composer-marker'
  if (markerLane && !desktopFallback) {
    return runtime.waitForFreshWorkerComposer(handle, agent, timeoutMs)
  }
  const startedAt = Date.now()
  try {
    return await runtime.waitForFreshWorkerComposer(
      handle,
      agent,
      Math.min(timeoutMs, resolveDraftPasteReadyTimeoutMs(agent)),
      { requireComposerMarker: markerLane, stopOnDialog: true }
    )
  } catch (error) {
    // Out of budget, a dialog up, or a pane it could not read: the idle wait answers each, and
    // throws for a handle that is gone.
    if (desktopFallback && error instanceof Error && error.message === 'timeout') {
      if (agent !== 'codex' && (await runtime.waitForAgentLaunchFallback(handle, agent)).ready) {
        return 'fallback-ready'
      }
      return notReadyInBudget(handle)
    }
  }
  if (markerLane) {
    // A dialog ended the budget wait: the marker is still the only signal, for what is left.
    return runtime.waitForFreshWorkerComposer(
      handle,
      agent,
      Math.max(1, timeoutMs - (Date.now() - startedAt))
    )
  }
  // Other callers retain the idle wait for the remaining launch budget.
  return runtime.waitForTerminal(handle, {
    condition: 'tui-idle',
    timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)),
    launchReadiness: true
  })
}

function notReadyInBudget(handle: string): RuntimeTerminalWait {
  return { handle, condition: 'tui-idle', satisfied: false, status: 'running', exitCode: null }
}

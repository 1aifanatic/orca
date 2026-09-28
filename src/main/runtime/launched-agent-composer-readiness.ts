/**
 * The one answer to "has the agent Orca just launched opened its composer?", shared by every host
 * path that writes a first input into a fresh agent: `agent.launch`'s terminal prompt and an
 * orchestration worker's first dispatch.
 *
 * Most agents show readiness through the `tui-idle` evidence ranking (an idle title, a known ready
 * screen, a name-only title held to quiet). A few show it only in their composer, which that ranking
 * cannot read — ZCode paints no title and repaints its banner forever, and DSH's idle hook fires only
 * after a turn — so for them the captured composer marker is the readiness signal.
 */

import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeTerminalWait } from '../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from './orca-runtime'

/** Agents whose only launch readiness is a composer marker pinned by a captured transcript
 *  (`zcode-readiness-transcript.test.ts`, `dsh-readiness-transcript.test.ts`). */
const COMPOSER_MARKER_READINESS_AGENTS: ReadonlySet<TuiAgent> = new Set(['zcode', 'dsh'])

/**
 * What a launch does for an agent that shows no readiness evidence within its budget.
 *
 * The single decision point for that case: `report-not-ready` hands back the unsatisfied wait, so
 * the caller keeps its text (`agent.launch` answers `not-delivered`; a worker start fails). Any
 * other readiness for such agents is a new arm here, which the switch below forces to be handled.
 */
export type LaunchReadinessWithoutEvidence = 'report-not-ready'
export const LAUNCH_READINESS_WITHOUT_EVIDENCE: LaunchReadinessWithoutEvidence = 'report-not-ready'

function settleWithoutReadinessEvidence(wait: RuntimeTerminalWait): RuntimeTerminalWait {
  switch (LAUNCH_READINESS_WITHOUT_EVIDENCE) {
    case 'report-not-ready':
      return wait
  }
}

export type LaunchedAgentReadinessRuntime = Pick<
  OrcaRuntimeService,
  'waitForTerminal' | 'waitForFreshWorkerComposer'
>

/**
 * Resolves `undefined` once a composer-marker agent's composer is up, else the `tui-idle` wait;
 * throws when a composer marker never appears, as `waitForFreshWorkerComposer` always has.
 */
export async function waitForLaunchedAgentComposer(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  agent: TuiAgent,
  timeoutMs: number
): Promise<RuntimeTerminalWait | undefined> {
  if (COMPOSER_MARKER_READINESS_AGENTS.has(agent)) {
    await runtime.waitForFreshWorkerComposer(handle, agent, timeoutMs)
    return undefined
  }
  const wait = await runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs })
  // A blocked prompt and an exited agent are evidence; only a silent timeout is its absence.
  return wait && !wait.satisfied && !wait.blockedReason && wait.status === 'running'
    ? settleWithoutReadinessEvidence(wait)
    : wait
}

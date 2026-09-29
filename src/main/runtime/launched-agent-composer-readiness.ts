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

/**
 * Agents whose launch readiness is a composer marker pinned by a captured transcript
 * (`zcode-readiness-transcript.test.ts`, `dsh-readiness-transcript.test.ts`,
 * `draft-paste-ready-scanner-grok-trace-replay.test.ts`). Grok is here because its only other
 * evidence is its bare name, which a shell auto-title also writes, and its screen never quiets.
 */
const COMPOSER_MARKER_READINESS_AGENTS: ReadonlySet<TuiAgent> = new Set(['zcode', 'dsh', 'grok'])

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
  // An agent that shows no readiness evidence comes back unsatisfied, so the caller keeps its text.
  return runtime.waitForTerminal(handle, {
    condition: 'tui-idle',
    timeoutMs,
    launchReadiness: true
  })
}

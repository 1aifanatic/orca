import type { AgentLaunchIntent, AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import type { AgentLaunchPaneVerdict } from '../../../../shared/agent-launch-pane-verdict'
import {
  trackTerminalSpawnDispatch,
  type TerminalSpawnDispatch
} from '../../../agent-launch/agent-launch-not-started'
import type { RpcContext } from '../core'
import type { AgentLaunchParams } from './agent-launch-schemas'
import type { AgentLaunchView } from './agent-launch-tab-publication'
import { resolveUnlaunchedIntent } from './agent-launch-intent-resolution'
import {
  agentLaunchFailureCode,
  launchFailureWithoutEffectsCode
} from './agent-launch-failure-code'
import {
  AgentLaunchExecutionError,
  settleLaunchWhoseTabWasClosed,
  withEarlyTab
} from './agent-launch-execution-outcome'

/** A definite capacity refusal continues within this request, retaining its original pane owner. */
export function runDesktopCapacityFallback(
  params: AgentLaunchParams,
  context: RpcContext,
  view: AgentLaunchView,
  execute: (
    intent: AgentLaunchIntent,
    terminalSpawn: TerminalSpawnDispatch
  ) => Promise<AgentLaunchResult>
): Promise<AgentLaunchResult> {
  view.early?.executing()
  return withEarlyTab(view.early, async () => {
    let intent: AgentLaunchIntent
    try {
      intent = await resolveUnlaunchedIntent(params, context.runtime, view.early)
    } catch (error) {
      view.early?.finish({ kind: 'not-started', code: agentLaunchFailureCode(error) })
      throw new AgentLaunchExecutionError(error, true)
    }
    const terminalSpawn = trackTerminalSpawnDispatch()
    let result: AgentLaunchResult
    try {
      result = await execute(intent, terminalSpawn)
    } catch (error) {
      if (view.early?.closedByUser()) {
        view.early.finish({ kind: 'withdrawn' })
        await settleLaunchWhoseTabWasClosed(context, view.early)
      }
      const code = launchFailureWithoutEffectsCode(error, intent.target.kind, terminalSpawn)
      const verdict: AgentLaunchPaneVerdict = code
        ? { kind: 'not-started', code }
        : { kind: 'unconfirmed' }
      view.early?.finish(verdict)
      throw new AgentLaunchExecutionError(error, code !== null)
    }
    if (view.early?.closedByUser()) {
      view.early.finish({ kind: 'withdrawn' })
      await settleLaunchWhoseTabWasClosed(context, view.early)
    }
    return { ...result, recorded: false }
  })
}

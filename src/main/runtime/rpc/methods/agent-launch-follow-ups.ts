/**
 * `agent.takeLaunchFollowUps`: the calling client takes the follow-ups its own launches recorded
 * (`agent-launch-follow-up-record`). Scoped by the connection's caller identity, so a phone or the
 * CLI can never see, or take, the desktop's.
 */

import { AgentTakeLaunchFollowUps } from '../../../../shared/rpc-contract/agent-launch-params'
import type { AgentLaunchFollowUpTake } from '../../../../shared/agent-launch-follow-up'
import {
  listSettledLaunchFollowUps,
  takeLaunchFollowUpsInto
} from '../../agent-launch-follow-up-record'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod } from '../core'
import { hasPersistedLaunchObligation } from '../../agent-launch-persisted-obligations'
import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import { DESKTOP_RPC_CALLER, rpcCallerOperationKey } from '../rpc-caller-identity'
import { activeAgentLaunchesFor } from './agent-launch-active-operations'
import { agentLaunchOperationCallerKey } from './agent-launch-replay'

/**
 * Tells the desktop window which of its recorded follow-ups now wait only on it, so a window that
 * reloaded mid-launch takes each as its prompt settles, not at its next start. Only the desktop
 * records follow-ups. One the window is not waiting on is ignored there.
 */
export function announceSettledLaunchFollowUps(
  runtime: Pick<OrcaRuntimeService, 'openedAgentSessionRecordStore'> &
    Partial<Pick<OrcaRuntimeService, 'reportAgentLaunchPromptSettled'>>
): void {
  try {
    const store = runtime.openedAgentSessionRecordStore()
    if (!store) {
      return
    }
    const desktop = rpcCallerOperationKey(DESKTOP_RPC_CALLER)
    for (const operationId of listSettledLaunchFollowUps(
      store.listOperationRows(),
      desktop,
      Date.now(),
      (operationKey) => activeAgentLaunchesFor(runtime).has(operationKey)
    )) {
      runtime.reportAgentLaunchPromptSettled?.(operationId)
    }
  } catch (error) {
    // Bookkeeping: a missed word leaves the follow-up for the window's next look.
    console.warn('[agent-launch] could not announce settled launch follow-ups', error)
  }
}

export const AGENT_LAUNCH_FOLLOW_UP_METHODS = [
  defineMethod({
    name: 'agent.takeLaunchFollowUps',
    params: AgentTakeLaunchFollowUps,
    handler: async (params, context): Promise<AgentLaunchFollowUpTake> => {
      const callerKey = agentLaunchOperationCallerKey(context)
      // Every window load asks: a profile whose launches recorded none must not open the store at
      // startup, nor create its database.
      const store =
        context.runtime.openedAgentSessionRecordStore() ??
        (hasPersistedLaunchObligation(getProfileUserDataPath(), 'launchFollowUp')
          ? await context.runtime.openAgentSessionRecordStore()
          : null)
      if (!store) {
        return { taken: [], pending: [] }
      }
      const active = activeAgentLaunchesFor(context.runtime)
      return store.transactOperations((draft) =>
        takeLaunchFollowUpsInto(draft, {
          callerKey,
          ...(params.operationId ? { operationId: params.operationId } : {}),
          now: Date.now(),
          isLaunchRunning: (operationKey) => active.has(operationKey)
        })
      )
    }
  })
]

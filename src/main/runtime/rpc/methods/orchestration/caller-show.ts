import type {
  OrchestrationCallerAddress,
  OrchestrationCallerShowResult,
  OrchestrationSessionAddressResult
} from '../../../../../shared/orchestration-caller-status'
import type { OrchestrationCompatibilityEvidence } from '../../../../../shared/orchestration-compatibility-evidence'
import { isOrcaSessionId } from '../../../../../shared/orca-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../../../shared/orchestration-session-caller-codes'
import { SessionAddressParams } from '../../../../../shared/rpc-contract/orchestration-params'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { resolveOrcaSessionParty } from '../../../orchestration/orchestration-party'
import { defineMethod } from '../../core'

export const ORCHESTRATION_CALLER_METHODS = [
  defineMethod({
    name: 'orchestration.callerShow',
    params: null,
    // Why no params: the answer comes from the identity the caller's environment carries, which the
    // dispatch entry already resolved (a session) or the envelope evidence names (a terminal).
    // A session the entry cannot admit never reaches here: its refusal is the answer.
    handler: (
      _params,
      { runtime, orchestrationCaller, orchestrationCompatibilityEvidence }
    ): OrchestrationCallerShowResult => {
      if (orchestrationCaller) {
        return { caller: { address: orchestrationCaller.address, live: true } }
      }
      return { caller: resolveTerminalCaller(runtime, orchestrationCompatibilityEvidence) }
    }
  }),
  defineMethod({
    name: 'orchestration.sessionAddress',
    params: SessionAddressParams,
    // Why host-side: the party resolver derives it from the session records, which only the host
    // holds, exactly as it binds a verb acting as that session: a chat's lineage root's address.
    handler: (params, { runtime }): OrchestrationSessionAddressResult => {
      if (!isOrcaSessionId(params.sessionId)) {
        throw new OrchestrationError(
          CODES.unknown,
          `${params.sessionId} is not an Orca agent session id.`,
          { effectsApplied: false }
        )
      }
      const party = resolveOrcaSessionParty(params.sessionId, runtime.getOrchestrationDb())
      return { address: party.address }
    }
  })
]

/**
 * The handle the mailbox verbs (`check`, `send`, `ask`) act as: the one the environment carries,
 * live or not, since they do not remint. Without one they only guess the active terminal.
 */
function resolveTerminalCaller(
  runtime: OrcaRuntimeService,
  evidence: OrchestrationCompatibilityEvidence | undefined
): OrchestrationCallerAddress | null {
  const handle = evidence?.terminalHandle
  return handle ? { address: handle, live: runtime.resolveTerminalIdentity(handle).live } : null
}

import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import { getRemoteRuntimeTerminalHandle } from '@/runtime/runtime-terminal-stream'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { admitRemoteForegroundEvidence } from '../../../../shared/remote-foreground-evidence-admission'
import { isClientOnlyUnverifiableInspection } from '../../../../shared/terminal-process-inspection'
import type { RemoteForegroundEvidence } from '../../../../shared/foreground-process-evidence'
import {
  judgeForegroundAgent,
  observeHostInspection,
  type ForegroundAgentJudgement,
  type ForegroundAgentObservation
} from '../../../../shared/foreground-agent-verdict'

type ForegroundReader = (
  ptyId: string,
  options?: { expectedIncarnationId?: string }
) => Promise<string | null | RuntimeTerminalProcessInspection>

export function createPaneForegroundProcessReader(deps: {
  readForegroundProcess: ForegroundReader
  confirmForegroundProcess?: ForegroundReader
  isRemotePtyId?: (ptyId: string) => boolean
  getExpectedIncarnationId?: () => string | null
}) {
  let authorityGeneration: string | null = null
  let observationEpoch = -1
  let bindingKey: string | null = null
  const knownAuthorityGenerations = new Set<string>()

  return async (
    ptyId: string,
    requiresConfirmation: boolean
  ): Promise<{
    judgement: ForegroundAgentJudgement
    expectedIncarnationId: string | null
    remote: boolean
  }> => {
    const expectedIncarnationId = deps.getExpectedIncarnationId?.() ?? null
    const options = expectedIncarnationId ? { expectedIncarnationId } : undefined
    const requestStartedAtMonotonic = performance.now()
    const remote = deps.isRemotePtyId?.(ptyId) === true
    if (remote) {
      const nextBindingKey = `${ptyId}\0${expectedIncarnationId ?? ''}`
      if (bindingKey !== nextBindingKey) {
        bindingKey = nextBindingKey
        authorityGeneration = null
        observationEpoch = -1
        knownAuthorityGenerations.clear()
      }
    }
    const admit = (evidence: unknown): RemoteForegroundEvidence | null => {
      const admitted = admitRemoteForegroundEvidence(evidence, {
        expectedPtyId:
          parseAppSshPtyId(ptyId)?.relayPtyId ?? getRemoteRuntimeTerminalHandle(ptyId) ?? ptyId,
        expectedIncarnationId,
        requestStartedAtMonotonic,
        receivedAtMonotonic: performance.now(),
        lastAuthorityGeneration: authorityGeneration,
        lastObservationEpoch: observationEpoch,
        knownAuthorityGenerations
      })
      if (admitted) {
        authorityGeneration = admitted.authorityGeneration
        observationEpoch = admitted.observationEpoch
        knownAuthorityGenerations.add(admitted.authorityGeneration)
      }
      return admitted
    }
    let observation: ForegroundAgentObservation
    try {
      const reader = requiresConfirmation
        ? (deps.confirmForegroundProcess ?? deps.readForegroundProcess)
        : deps.readForegroundProcess
      const inspection = await (options ? reader(ptyId, options) : reader(ptyId))
      if (remote) {
        observation = observeHostInspection(inspection, admit)
      } else if (isClientOnlyUnverifiableInspection(inspection)) {
        // A client-only result is never shell evidence, even for a local
        // adapter that lost its provider while the pane stayed mounted.
        observation = { kind: 'unavailable' }
      } else {
        observation = {
          kind: 'process-name',
          processName:
            typeof inspection === 'string' || inspection === null
              ? inspection
              : inspection.foregroundProcess
        }
      }
    } catch {
      // The reader adapter is deliberately conservative for injected/legacy
      // providers: no answer is still an unverifiable verdict.
      observation = { kind: 'unavailable' }
    }
    return { judgement: judgeForegroundAgent(observation), expectedIncarnationId, remote }
  }
}

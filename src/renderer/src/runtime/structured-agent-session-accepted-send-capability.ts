import { useLayoutEffect, useRef, type RefObject } from 'react'
import { AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeClientTarget } from './runtime-client-target'
import {
  structuredAgentSessionHostKey,
  useStructuredAgentSessionHostCapabilityState,
  type StructuredAgentSessionHostCapabilityState
} from './structured-agent-session-host-capability'

/**
 * Whether the host answers a send at acceptance and never refuses one because its agent could not
 * start. Such a host records every send before it starts anything, so nothing about a moved fence
 * calls for a resend. `unknown` until the host has said so, and after a failed probe.
 */
export function useStructuredAgentSessionHostAcceptedSendState(
  target: RuntimeClientTarget
): StructuredAgentSessionHostCapabilityState {
  return useStructuredAgentSessionHostCapabilityState(
    target,
    AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY
  )
}

/**
 * When an outbox treats its owner as changed. An older host restarts the agent inside the send and
 * refuses it, unrecorded, when that fails, so a new fence is its only word that another try may
 * land. A host that accepts first records every send before it starts anything, so a moved fence
 * means nothing there, and only a Retry or a new send goes out.
 */
export function useStructuredAgentSessionOutboxOwnerChange(
  target: RuntimeClientTarget,
  fence: number | null
): {
  /** Resends a send in flight under the same id and drops its answer; any host not known to
   *  accept first is handled as an older one, as nothing it says is lost that way. */
  ownerChange: number | null
  /** Releases a message the host refused, which was shown as not sent: only a host known to be
   *  older, so one not yet heard from never sends it without its Retry. */
  refusalOwner: number | null
  /** Whether the host is known to be older, so a refusal it gave for want of an owner goes out
   *  again on its next one. */
  olderHost: boolean
  attached: boolean
  fenceRef: RefObject<number | null>
  targetKey: string
} {
  const acceptedSend = useStructuredAgentSessionHostAcceptedSendState(target)
  // Read by effects that run on an owner change, not on every fence move.
  const fenceRef = useRef(fence)
  useLayoutEffect(() => {
    fenceRef.current = fence
  }, [fence])
  return {
    ownerChange: acceptedSend === 'supported' ? null : fence,
    refusalOwner: acceptedSend === 'unsupported' ? fence : null,
    olderHost: acceptedSend === 'unsupported',
    attached: fence !== null,
    fenceRef,
    targetKey: structuredAgentSessionHostKey(target)
  }
}

import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../src/shared/structured-agent-session-outbox'
import {
  structuredAgentSessionDomainFingerprint,
  structuredAgentSessionPayloadFingerprint
} from '../../../src/shared/structured-agent-session-mutation'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import {
  requestStructuredAgentSessionMutation,
  timeoutForDeadline
} from './mobile-structured-agent-session-rpc'
import { structuredSessionOperationId } from './structured-session-operation-id'
import { mobileStructuredSendDelivery } from './mobile-structured-send-delivery'
import {
  clearMobileStructuredSendOperation,
  getOrCreateMobileStructuredSendOperation,
  mobileStructuredSendOperationKey
} from './mobile-structured-send-operation-journal'

export async function sendMobileStructuredAgentSessionMessage(input: {
  client: RpcClient
  sessionId: string
  sessionKey: string
  callerIdentity: string
  expectedRuntimeFence: number
  text: string
  attachments: readonly (StructuredAgentSessionAttachment & { contentFingerprint?: string })[]
  /** Sent only when the host advertises `agent-session.queued-messages.v1`. */
  delivery?: 'queue-if-active'
  deadline?: number
  onError: (message: string) => void
  /** Internal: the one fresh-id resend after a withdrawn replay. */
  resendingAfterWithdrawal?: true
  /** Internal: that resend when the withdrawn id's record could not be cleared. It bypasses the
   *  record, so failing storage never blocks the send, and is unrecorded, so its own lost answer
   *  cannot be replayed. */
  bypassRetainedRecord?: true
}): Promise<MobileNativeChatSendOutcome> {
  const timeoutMs = timeoutForDeadline(input.deadline)
  if (timeoutMs === null) {
    input.onError('Message not sent')
    return 'rejected'
  }
  const requestedBody = structuredAgentSessionSendBody(input.text, input.attachments)
  const requestedPayloadFingerprint = structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: input.sessionId,
    fields: { body: requestedBody }
  })
  const intentFields = {
    text: input.text.trimEnd(),
    attachments: input.attachments.map(
      (attachment) =>
        attachment.contentFingerprint ??
        structuredAgentSessionDomainFingerprint({
          domain: 'mobile.nativeChat.image.preview',
          sessionId: '',
          fields: { previewUri: attachment.previewUri }
        })
    )
  }
  // `delivery` is part of the intent key, never a stored journal field: the
  // immediate key is exactly today's, so an older build still reads the journal.
  const operationKeyFor = (delivery: 'queue-if-active' | undefined): string =>
    mobileStructuredSendOperationKey({
      sessionKey: input.sessionKey,
      intentFingerprint: structuredAgentSessionDomainFingerprint({
        domain: 'mobile.agentSession.send.intent',
        sessionId: input.sessionKey,
        fields: delivery ? { ...intentFields, delivery } : intentFields
      })
    })
  const queuedOperationKey = operationKeyFor('queue-if-active')
  const immediateOperationKey = operationKeyFor(undefined)
  let operation: Awaited<ReturnType<typeof getOrCreateMobileStructuredSendOperation>>
  try {
    operation = input.bypassRetainedRecord
      ? {
          operationKey: input.delivery ? queuedOperationKey : immediateOperationKey,
          operationId: structuredSessionOperationId(),
          retained: false,
          payloadFingerprint: requestedPayloadFingerprint,
          attachmentPaths: input.attachments.map((attachment) => attachment.path)
        }
      : await getOrCreateMobileStructuredSendOperation({
          operationKey: input.delivery ? queuedOperationKey : immediateOperationKey,
          // A retained id replays exactly as first sent, whatever the capability says now;
          // a host that refuses that request shape retires it, so the next send goes out fresh.
          alternateOperationKey: input.delivery ? immediateOperationKey : queuedOperationKey,
          callerIdentity: input.callerIdentity,
          payloadFingerprint: requestedPayloadFingerprint,
          attachmentPaths: input.attachments.map((attachment) => attachment.path),
          createOperationId: structuredSessionOperationId
        })
  } catch {
    input.onError('Message not sent')
    return 'rejected'
  }
  const operationKey = operation.operationKey
  const delivery = operationKey === queuedOperationKey ? 'queue-if-active' : undefined
  const body = structuredAgentSessionSendBody(
    input.text,
    operation.attachmentPaths.map((path) => ({ path, previewUri: '' }))
  )
  const payloadFingerprint = structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: input.sessionId,
    fields: { body }
  })
  if (payloadFingerprint !== operation.payloadFingerprint) {
    input.onError('Message not sent')
    return 'rejected'
  }
  const result = await requestStructuredAgentSessionMutation<AgentSessionSendResult>({
    client: input.client,
    method: 'agentSession.send',
    fingerprintMethod: 'agentSession.send',
    sessionId: input.sessionId,
    expectedRuntimeFence: input.expectedRuntimeFence,
    // `delivery` joins the wire fields — and so the operation fingerprint — but
    // never the journal's body-only fingerprint the submission echo recomputes.
    fields: { body, ...(delivery ? { delivery } : {}) },
    clientOperationId: operation.operationId,
    timeoutMs
  })
  const outcome = mobileStructuredSendDelivery(result, operation.retained)
  let released = false
  if (outcome.operationIdSpent) {
    try {
      await clearMobileStructuredSendOperation({
        operationKey,
        operationId: operation.operationId
      })
      released = true
    } catch {
      // A retained settled id can suppress a later identical send, never
      // duplicate this one; the next replay gets another clear chance.
    }
  }
  const withdrawnReplay =
    result.status === 'accepted' &&
    'queued' in result.value &&
    result.value.queued?.state === 'withdrawn'
  if (withdrawnReplay && operation.retained && !input.resendingAfterWithdrawal) {
    // The retained id's draft was withdrawn, so it never reached the agent:
    // this identical message is a new one, not a replay to swallow. A record
    // storage would not clear is bookkeeping: it is reported, never allowed to
    // block the send.
    const resent = await sendMobileStructuredAgentSessionMessage({
      ...input,
      resendingAfterWithdrawal: true,
      ...(released ? {} : { bypassRetainedRecord: true as const })
    })
    if (!released && resent !== 'rejected') {
      input.onError("Sent, but this phone couldn't update its record of sent messages.")
    }
    return resent
  }
  if (withdrawnReplay) {
    // Not resent: no card and no bubble holds the text, so it goes back to the
    // composer rather than vanishing.
    input.onError('Message not sent')
    return 'rejected'
  }
  if (outcome.error !== null) {
    input.onError(outcome.error)
  }
  return outcome.outcome
}

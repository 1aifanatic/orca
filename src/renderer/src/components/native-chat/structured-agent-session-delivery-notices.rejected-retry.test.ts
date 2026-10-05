// Which message the host recorded and then rejected has a Retry: only one no agent ever took, on a
// host that can queue that same message again. Every other one is drawn where it was rejected, in
// the host's words, and sending it again is a new message.

import { describe, expect, it, vi } from 'vitest'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import type { SubmissionRejectionFact } from '../../../../shared/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

const ID = 'op-message'
const KEY = agentJournalSubmissionKey(ID)
const ITEM: AgentJournalRenderItem = {
  itemId: KEY,
  revision: 0,
  sequence: 5,
  observedAt: 5,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
}

function rejected(
  fact: SubmissionRejectionFact,
  patch: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId: ID,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'rejected',
    providerItemId: null,
    submittedAt: 4,
    resolvedAt: 7,
    handoverRecorded: true,
    ...agentSessionFailureWords(fact, { surface: 'rejection', agentName: 'Codex' }),
    ...patch
  }
}

function noticeOn(submission: AgentJournalSubmission, retriesInPlace: boolean) {
  const retry = vi.fn()
  const notice = structuredAgentSessionDeliveryNotices(
    [],
    'Codex',
    retry,
    [submission],
    [],
    new Set(),
    [],
    new Set(),
    [],
    retriesInPlace
  ).get(KEY)
  return { notice, retry }
}

describe('a message the host recorded and then rejected', () => {
  it("is drawn in place with the host's words and no Retry, even on a host that retries in place", () => {
    // Handed to the agent, which never got it: the agent may have seen it, so no Retry.
    const undelivered = rejected({ kind: 'notDelivered' }, { handedOverAt: 5 })

    expect(projectStructuredAgentSessionMessages([ITEM], [], [undelivered], [])).toEqual([
      expect.objectContaining({ id: KEY, unsent: true })
    ])
    const { notice } = noticeOn(undelivered, true)
    expect(notice).toEqual({ text: 'This message was not delivered. Send it again to continue.' })
  })
})

describe('a failed start no agent took', () => {
  const failedStart = rejected({ kind: 'providerStartFailed' })

  it('gets Retry in place when the host advertises retry-message', () => {
    const { notice, retry } = noticeOn(failedStart, true)
    expect(notice?.text).toBe('Codex stopped before it finished starting.')
    notice?.onRetry?.()
    expect(retry).toHaveBeenCalledExactlyOnceWith(ID)
  })

  it('gets no Retry on a host that does not advertise retry-message', () => {
    expect(noticeOn(failedStart, false).notice).not.toHaveProperty('onRetry')
  })
})

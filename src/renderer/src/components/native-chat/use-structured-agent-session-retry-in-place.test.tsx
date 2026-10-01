// @vitest-environment happy-dom

// Which Retry a press takes: the same message queued again on a host that can, a new copy from the
// outbox where the host cannot, and nothing yet while the host has not said which.

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubmissionRejectionFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'

const capability = vi.hoisted(() => ({
  state: 'supported' as 'supported' | 'unsupported' | 'unknown'
}))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => capability.state
}))

const { useStructuredAgentSessionRetryInPlace } =
  await import('./use-structured-agent-session-retry-in-place')

const ID = '1759312345678-0123456789abcdef0123456789abcdef'

function rejected(
  fact: SubmissionRejectionFact,
  extra: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId: ID,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'rejected',
    providerItemId: null,
    submittedAt: 4,
    resolvedAt: 7,
    handoverRecorded: true,
    ...agentSessionFailureWords(fact, { surface: 'rejection', agentName: 'Codex' }),
    ...extra
  }
}

let mutate = vi.fn()
let outboxRetry = vi.fn()

beforeEach(() => {
  mutate = vi.fn(async () => null)
  outboxRetry = vi.fn()
  capability.state = 'supported'
})

function render(submissions: AgentJournalSubmission[]) {
  return renderHook(() =>
    useStructuredAgentSessionRetryInPlace({
      target: { kind: 'local' },
      mutate,
      submissions,
      outboxRetry
    })
  )
}

const QUEUE_AGAIN = [
  'agentSession.retryMessage',
  'agentSession.retryMessage',
  { clientMessageId: ID }
]

describe('a Retry press', () => {
  it.each([
    ['a failed start', rejected({ kind: 'providerStartFailed' })],
    ["Orca's fault before any agent took it", rejected({ kind: 'hostFault' })]
  ])('queues the same message again for %s, on a host that can', (_case, submission) => {
    const { result } = render([submission])
    result.current.retry(ID)
    expect(mutate).toHaveBeenCalledWith(...QUEUE_AGAIN)
    expect(outboxRetry).not.toHaveBeenCalled()
  })

  it.each([
    ['a refusal of what it says', [rejected({ kind: 'providerRejected' })]],
    ['a message an agent took', [rejected({ kind: 'hostFault' }, { handedOverAt: 6 })]],
    ['a message the journal does not hold yet', []]
  ])('sends a new copy for %s', (_case, submissions) => {
    const { result } = render(submissions)
    result.current.retry(ID)
    expect(mutate).not.toHaveBeenCalled()
    expect(outboxRetry).toHaveBeenCalledWith(ID)
  })

  it('sends a new copy on a host known not to queue it again, and offers no Retry elsewhere', () => {
    capability.state = 'unsupported'
    const { result } = render([rejected({ kind: 'providerStartFailed' })])
    result.current.retry(ID)
    expect(outboxRetry).toHaveBeenCalledWith(ID)
    expect(mutate).not.toHaveBeenCalled()
    expect(result.current.retryInPlace).toBeUndefined()
  })

  // A new copy sent before the answer would leave the original with a live Retry once the host
  // says it can: the same words delivered twice.
  it.each([
    ['can', 'supported', true],
    ['cannot', 'unsupported', false]
  ] as const)(
    'waits while the host has not answered, then does what a host that %s takes',
    (_answer, answered, inPlace) => {
      capability.state = 'unknown'
      const { result, rerender } = render([rejected({ kind: 'providerStartFailed' })])

      result.current.retry(ID)
      result.current.retry(ID)
      expect(mutate).not.toHaveBeenCalled()
      expect(outboxRetry).not.toHaveBeenCalled()
      expect(result.current.retryInPlace).toBeUndefined()

      capability.state = answered
      act(() => rerender())

      expect(mutate).toHaveBeenCalledTimes(inPlace ? 1 : 0)
      expect(outboxRetry).toHaveBeenCalledTimes(inPlace ? 0 : 1)
    }
  )
})

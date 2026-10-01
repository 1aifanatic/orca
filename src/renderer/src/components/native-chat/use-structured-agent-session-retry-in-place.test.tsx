// @vitest-environment happy-dom

// Which Retry a press takes: the same message queued again on a host that can, a new copy from the
// outbox where the host cannot, and nothing yet while the host has not said which.

import '@testing-library/jest-dom/vitest'
import {
  act,
  cleanup,
  fireEvent,
  render as renderUi,
  renderHook,
  screen
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubmissionRejectionFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'

const capability = vi.hoisted(() => ({
  state: 'supported' as 'supported' | 'unsupported' | 'unknown'
}))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => capability.state
}))

const { useStructuredAgentSessionRetryInPlace } =
  await import('./use-structured-agent-session-retry-in-place')
const { withHeldRetries } = await import('./use-structured-agent-session-delivery-notices')
const { MessageRow } = await import('./NativeChatMessageRow')

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

afterEach(cleanup)

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

      act(() => result.current.retry(ID))
      act(() => result.current.retry(ID))
      expect(mutate).not.toHaveBeenCalled()
      expect(outboxRetry).not.toHaveBeenCalled()
      expect(result.current.retryInPlace).toBeUndefined()
      // Shown as pending meanwhile, so it reads as taken rather than dead.
      expect([...result.current.retryHeld]).toEqual([ID])

      capability.state = answered
      act(() => rerender())

      expect(mutate).toHaveBeenCalledTimes(inPlace ? 1 : 0)
      expect(outboxRetry).toHaveBeenCalledTimes(inPlace ? 0 : 1)
      expect(result.current.retryHeld.size).toBe(0)
    }
  )
})

describe('the notice of a held Retry', () => {
  it('keeps its Retry, shown as pending, and leaves every other notice as it was', () => {
    const onRetry = vi.fn()
    const notices = new Map([
      [agentJournalSubmissionKey(ID), { text: 'Codex stopped.', onRetry }],
      [agentJournalSubmissionKey('other'), { text: 'Codex stopped.', onRetry }]
    ])

    const marked = withHeldRetries(notices, new Set([ID]))

    expect(marked.get(agentJournalSubmissionKey(ID))).toEqual({
      text: 'Codex stopped.',
      onRetry,
      retryPending: true
    })
    expect(marked.get(agentJournalSubmissionKey('other'))).toEqual({
      text: 'Codex stopped.',
      onRetry
    })
    expect(withHeldRetries(notices, new Set())).toBe(notices)
  })
})

describe('a Retry pressed before the host has answered', () => {
  function Chat({ submissions }: { submissions: AgentJournalSubmission[] }) {
    const { retry, retryHeld } = useStructuredAgentSessionRetryInPlace({
      target: { kind: 'local' },
      mutate,
      submissions,
      outboxRetry
    })
    const key = agentJournalSubmissionKey(ID)
    const notices = withHeldRetries(
      new Map([[key, { text: 'Codex stopped.', onRetry: () => retry(ID) }]]),
      retryHeld
    )
    return (
      <MessageRow
        message={{
          id: key,
          role: 'user',
          timestamp: 0,
          source: 'transcript',
          blocks: [{ type: 'text', text: 'hello' }]
        }}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
        deliveryNotice={notices.get(key)}
      />
    )
  }

  it('shows the button pending and disabled, then queues the message again once the host can', () => {
    capability.state = 'unknown'
    const submissions = [rejected({ kind: 'providerStartFailed' })]
    const { rerender } = renderUi(<Chat submissions={submissions} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    const pending = screen.getByRole('button', { name: 'Retry' })
    expect(pending).toBeDisabled()
    expect(pending).toHaveAttribute('aria-busy', 'true')
    expect(mutate).not.toHaveBeenCalled()
    expect(outboxRetry).not.toHaveBeenCalled()

    capability.state = 'supported'
    act(() => rerender(<Chat submissions={submissions} />))

    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith(...QUEUE_AGAIN)
    expect(outboxRetry).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })
})

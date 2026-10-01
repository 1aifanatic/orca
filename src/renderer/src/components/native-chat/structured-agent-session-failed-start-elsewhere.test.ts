// A message this client did not send — the host's own restart continuation, a phone's, an
// orchestration worker's first — whose start failed for good still shows in the chat, saying why.

import { describe, expect, it, vi } from 'vitest'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { SubmissionRejectionFact } from '../../../../shared/agent-session-failure'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import { resendableFailedStartsSentElsewhere } from '../../../../shared/structured-agent-session-failed-start-elsewhere'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'

const ID = '1759312345678-0123456789abcdef0123456789abcdef'
const KEY = agentJournalSubmissionKey(ID)

function item(body: AgentJournalMessageItem): AgentJournalRenderItem {
  return { itemId: KEY, revision: 0, sequence: 5, observedAt: 5, body }
}
const TEXT = item({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Continue where you left off' }]
})

function rejected(fact: SubmissionRejectionFact): AgentJournalSubmission {
  return {
    clientMessageId: ID,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'rejected',
    providerItemId: null,
    submittedAt: 4,
    resolvedAt: 7,
    handoverRecorded: true,
    ...agentSessionFailureWords(fact, { surface: 'rejection', agentName: 'Codex' })
  }
}

describe('a message sent from elsewhere whose start failed for good', () => {
  it.each([
    [{ kind: 'providerStartFailed' }, 'Codex stopped before it finished starting.'],
    [{ kind: 'hostFault' }, "Orca ran into a problem, so this didn't go through."],
    [{ kind: 'notSignedIn' }, 'Codex is not signed in for the selected account. Sign in first.']
  ] as const)('shows as unsent, says why %j, and offers a Retry', (fact, why) => {
    const submissions = [rejected(fact)]
    const retry = vi.fn()
    const resendable = resendableFailedStartsSentElsewhere([TEXT], submissions, [])

    expect(projectStructuredAgentSessionMessages([TEXT], [], submissions)).toEqual([
      expect.objectContaining({ id: KEY, unsent: true })
    ])
    const notice = structuredAgentSessionDeliveryNotices(
      [],
      'Codex',
      retry,
      submissions,
      [],
      new Set(),
      (id) => resendable.has(id)
    ).get(KEY)
    expect(notice?.text).toBe(why)
    notice?.onRetry?.()
    expect(retry).toHaveBeenCalledWith(ID)
    expect(resendable.get(ID)).toBe('Continue where you left off')
  })

  it('stays hidden when it failed for anything but its start, as before', () => {
    expect(
      projectStructuredAgentSessionMessages([TEXT], [], [rejected({ kind: 'queueFull' })])
    ).toEqual([])
  })

  it('offers no Retry for one with images, whose files are not on this client', () => {
    const withImage = item({
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'look' },
        { type: 'image-ref', url: 'orca-image://img-1' }
      ]
    })
    const submissions = [rejected({ kind: 'providerStartFailed' })]
    const resendable = resendableFailedStartsSentElsewhere([withImage], submissions, [])
    expect(resendable.size).toBe(0)
    const notice = structuredAgentSessionDeliveryNotices(
      [],
      'Codex',
      vi.fn(),
      submissions,
      [],
      new Set(),
      (id) => resendable.has(id)
    ).get(KEY)
    expect(notice).toEqual({
      text: 'Codex stopped before it finished starting. Send your message to try again.'
    })
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  readAgentSessionFailureFact,
  type UnreadAgentSessionFailureFact
} from '../../../../shared/agent-session-failure'
import { isAdmissibleAgentJournalRenderItem } from '../../../../shared/agent-session-journal-schemas'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionMessages as projectSharedMessages } from '../../../../shared/structured-agent-session-message-projection'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'
import {
  structuredAgentSessionDeliveryNotices,
  structuredAgentSessionStartFailureFacts
} from './structured-agent-session-delivery-notices'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

function startRow(
  failure: UnreadAgentSessionFailureFact,
  agentName: string
): AgentJournalRenderItem {
  const known = readAgentSessionFailureFact(failure)
  const row = {
    itemId: agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('open-time')),
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'status',
      tone: 'error',
      ...(known
        ? agentSessionFailureWords(known, { agentName, surface: 'row' })
        : { text: `${agentName} isn't installed on the computer running this chat.`, failure })
    }
  }
  if (!isAdmissibleAgentJournalRenderItem(row)) {
    throw new Error('Invalid start-failure fixture')
  }
  return row
}

describe('desktop start rows for a sign-in or missing CLI', () => {
  it.each(['Claude', 'Codex'])(
    'keeps %s rows in the journal and off the desktop transcript, whatever Send shows',
    (agentName) => {
      for (const kind of ['notSignedIn', 'cliMissing'] as const) {
        const row = startRow({ kind }, agentName)
        const original = structuredClone(row)
        expect(projectStructuredAgentSessionMessages([row], [], [])).toEqual([])
        expect(projectSharedMessages([row], [], [], { rejectedInPlace: false })).toMatchObject([
          { id: row.itemId, role: 'system' }
        ])
        expect(row).toEqual(original)
      }
    }
  )

  it.each(['startFailed', 'providerStartFailed'] as const)(
    'keeps other typed start failures visible: %s',
    (kind) => {
      const row = startRow({ kind }, 'Claude')
      expect(projectStructuredAgentSessionMessages([row], [], [])).toMatchObject([
        { id: row.itemId }
      ])
    }
  )

  it('keeps a newer host’s custom-command failure as its fallback line', () => {
    const row = startRow({ kind: 'customCommandUnsupported' }, 'Claude')
    expect(projectStructuredAgentSessionMessages([row], [], [])).toMatchObject([{ id: row.itemId }])
  })

  it('does not hide ordinary provider status rows or infer the reason from text', () => {
    const ordinary = { ...startRow({ kind: 'notSignedIn' }, 'Claude'), itemId: 'provider-status' }
    const untyped: AgentJournalRenderItem = {
      ...startRow({ kind: 'notSignedIn' }, 'Claude'),
      body: { kind: 'status', text: "Claude isn't signed in.", tone: 'error' }
    }
    expect(
      projectStructuredAgentSessionMessages([ordinary, untyped], [], []).map(({ id }) => id)
    ).toEqual([ordinary.itemId, untyped.itemId])
  })

  it.each(['notSignedIn', 'cliMissing'] as const)(
    'keeps the full post-send %s rejection on the unsent message when the start row is hidden',
    (kind) => {
      const failure: UnreadAgentSessionFailureFact = { kind }
      const row = startRow(failure, 'Claude')
      const message: AgentJournalRenderItem = {
        itemId: agentJournalSubmissionKey('sent'),
        revision: 1,
        sequence: 2,
        observedAt: 2,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
      }
      const submission: AgentJournalSubmission = {
        clientMessageId: 'sent',
        fence: 1,
        payloadFingerprint: 'sent',
        dispatchState: 'rejected',
        providerItemId: null,
        reason: row.body.kind === 'status' ? row.body.text : '',
        rejection: failure,
        submittedAt: 2,
        resolvedAt: 3
      }
      expect(projectStructuredAgentSessionMessages([row, message], [], [submission])).toMatchObject(
        [{ id: message.itemId, unsent: true }]
      )
      const notices = structuredAgentSessionDeliveryNotices(
        [],
        'Claude',
        vi.fn(),
        [submission],
        structuredAgentSessionStartFailureFacts([row]),
        new Set()
      )
      expect(notices.get(message.itemId)).toEqual({
        text: row.body.kind === 'status' ? row.body.text : ''
      })
    }
  )
})

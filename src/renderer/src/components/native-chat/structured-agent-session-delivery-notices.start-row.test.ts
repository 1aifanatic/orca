// A message rejected by a start whose row says why says only that it was not sent. A row covers
// the rejections its start wrote it after, so an equal failure in another start's row never hushes
// a message.

import { describe, expect, it } from 'vitest'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'
import { structuredAgentSessionStartFailureFacts } from './structured-agent-session-delivery-notices'
import { entry, texts } from './structured-agent-session-delivery-notices-test-fixtures'

// Matched on the typed fact of a row found by its identity, never on either sentence.
describe('a message rejected by a start whose row already says why', () => {
  const startFailed: AgentSessionFailureFact = {
    kind: 'startFailed',
    refusal: { code: 'agent_session_identity_required', details: { reason: 'recordMissing' } }
  }
  const rejected = (id: string, fact: AgentSessionFailureFact) =>
    entry(id, {
      state: 'rejected',
      lastFailure: {
        kind: 'rejected',
        reason: 'Written by the host.',
        rejection: { kind: fact.kind }
      }
    })
  const recorded = (id: string, fact: AgentSessionFailureFact): AgentJournalSubmission => ({
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: id,
    dispatchState: 'rejected',
    providerItemId: null,
    reason: 'Written by the host.',
    rejection: fact,
    submittedAt: 1,
    resolvedAt: 1
  })
  const statusRow = (
    itemId: string,
    fact: AgentSessionFailureFact,
    sequence = 1
  ): AgentJournalRenderItem => ({
    itemId,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'status',
      tone: 'error',
      ...agentSessionFailureWords(fact, { agentName: 'Claude', surface: 'row' })
    }
  })
  /** A message placed where the journal put it: a rejected one where it was rejected. */
  const messageAt = (id: string, sequence: number): AgentJournalRenderItem => ({
    itemId: agentJournalSubmissionKey(id),
    revision: 0,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] }
  })
  const rowKey = (startKey: string) =>
    agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity(startKey))
  const startRowKey = rowKey('gen')

  it('reads only the start-failure rows, each covering the rejections its start wrote it after', () => {
    expect(
      structuredAgentSessionStartFailureFacts(
        [
          messageAt('first', 1),
          statusRow(startRowKey, startFailed, 2),
          statusRow(agentJournalSubmissionKey('exit-row'), { kind: 'providerExited' }, 3)
        ],
        [recorded('first', startFailed)]
      )
    ).toEqual([
      { itemId: startRowKey, fact: startFailed, covers: [agentJournalSubmissionKey('first')] }
    ])
  })

  // An older host rejected every queued message, then wrote the start's one row after them.
  it('says only that each was not sent, and words any other rejection in full', () => {
    const otherRefusal: AgentSessionFailureFact = {
      kind: 'startFailed',
      refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } }
    }
    const submissions = [
      recorded('first', startFailed),
      recorded('second', startFailed),
      recorded('other', otherRefusal)
    ]
    const facts = structuredAgentSessionStartFailureFacts(
      [
        messageAt('first', 1),
        messageAt('second', 2),
        statusRow(startRowKey, startFailed, 3),
        messageAt('other', 4)
      ],
      submissions
    )
    expect(
      texts(
        [
          rejected('first', startFailed),
          rejected('second', startFailed),
          rejected('other', otherRefusal)
        ],
        submissions,
        facts
      )
    ).toEqual({
      [agentJournalSubmissionKey('first')]: 'Your message was not sent.',
      [agentJournalSubmissionKey('second')]: 'Your message was not sent.',
      [agentJournalSubmissionKey('other')]:
        "Claude couldn't start. This chat is still open in a terminal agent. Quit that agent to continue the chat here."
    })
  })

  it('keeps the full notice when the rejection is not loaded, or no start row states it', () => {
    const shown = "Claude couldn't start. Start a new chat to continue."
    const stated = {
      itemId: startRowKey,
      fact: startFailed,
      covers: [agentJournalSubmissionKey('first')]
    }
    expect(texts([rejected('first', startFailed)], [], [stated])).toEqual({
      [agentJournalSubmissionKey('first')]: 'Written by the host.'
    })
    expect(texts([rejected('first', startFailed)], [recorded('first', startFailed)], [])).toEqual({
      [agentJournalSubmissionKey('first')]: shown
    })
  })

  // An equal failure in an older row is another start's: the later message keeps its words.
  it("words in full a later failure equal to an older start's row", () => {
    const submissions = [
      recorded('first', startFailed),
      { ...recorded('sent', startFailed), dispatchState: 'accepted' as const },
      recorded('later', startFailed)
    ]
    const facts = structuredAgentSessionStartFailureFacts(
      [
        messageAt('first', 1),
        statusRow(startRowKey, startFailed, 2),
        messageAt('sent', 3),
        messageAt('later', 5)
      ],
      submissions
    )
    expect(
      texts([rejected('first', startFailed), rejected('later', startFailed)], submissions, facts)
    ).toEqual({
      [agentJournalSubmissionKey('first')]: 'Your message was not sent.',
      [agentJournalSubmissionKey('later')]: "Claude couldn't start. Start a new chat to continue."
    })
  })

  // A message that went through, then a rejection with no row of its own, then a later start's
  // row: that row is not the rejection's.
  it('lets no row speak for a rejection a message that went through came after', () => {
    const submissions = [
      recorded('unrowed', startFailed),
      { ...recorded('sent', startFailed), dispatchState: 'accepted' as const },
      recorded('later', startFailed)
    ]
    const facts = structuredAgentSessionStartFailureFacts(
      [
        messageAt('unrowed', 1),
        messageAt('sent', 2),
        messageAt('later', 3),
        statusRow(rowKey('later'), startFailed, 4)
      ],
      submissions
    )
    expect(
      texts([rejected('unrowed', startFailed), rejected('later', startFailed)], submissions, facts)
    ).toEqual({
      [agentJournalSubmissionKey('unrowed')]:
        "Claude couldn't start. Start a new chat to continue.",
      [agentJournalSubmissionKey('later')]: 'Your message was not sent.'
    })
  })

  // An older host's exit rejected the messages handed to its child, then wrote the row in a write
  // of its own, a moment after.
  it("hushes the messages an older host's exit rejected before writing their row", () => {
    const submissions = [
      { ...recorded('handed-1', startFailed), resolvedAt: 10 },
      { ...recorded('handed-2', startFailed), resolvedAt: 11 }
    ]
    const facts = structuredAgentSessionStartFailureFacts(
      [
        messageAt('handed-1', 10),
        messageAt('handed-2', 11),
        statusRow(startRowKey, startFailed, 12)
      ],
      submissions
    )
    expect(
      texts(
        [rejected('handed-1', startFailed), rejected('handed-2', startFailed)],
        submissions,
        facts
      )
    ).toEqual({
      [agentJournalSubmissionKey('handed-1')]: 'Your message was not sent.',
      [agentJournalSubmissionKey('handed-2')]: 'Your message was not sent.'
    })
  })
})

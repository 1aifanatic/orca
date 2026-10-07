// A message rejected by a start whose row says why says only that it was not sent. A row keyed by
// the message is its own start's and speaks for it alone; a chat an older host wrote has one row for
// a batch, so a message with no row of its own takes any loaded row with the same failure.

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

const startFailed: AgentSessionFailureFact = {
  kind: 'startFailed',
  refusal: { code: 'agent_session_identity_required', details: { reason: 'recordMissing' } }
}
const otherRefusal: AgentSessionFailureFact = {
  kind: 'startFailed',
  refusal: { code: 'agent_session_conflict', details: { reason: 'claimConflicted' } }
}
const NOT_SENT = 'Your message was not sent.'
const START_FAILED_WORDS = "Claude couldn't start. Start a new chat to continue."

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
const row = (
  startKey: string,
  fact: AgentSessionFailureFact,
  sequence: number
): AgentJournalRenderItem => ({
  itemId: rowKey(startKey),
  revision: 1,
  sequence,
  observedAt: sequence,
  body: {
    kind: 'status',
    tone: 'error',
    ...agentSessionFailureWords(fact, { agentName: 'Claude', surface: 'row' })
  }
})
/** A rejected message where the journal placed it: where it was rejected. */
const messageAt = (id: string, sequence: number): AgentJournalRenderItem => ({
  itemId: agentJournalSubmissionKey(id),
  revision: 0,
  sequence,
  observedAt: sequence,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] }
})
function rowKey(startKey: string): string {
  return agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity(startKey))
}

function noticesFor(
  ids: readonly [string, AgentSessionFailureFact][],
  items: readonly AgentJournalRenderItem[]
): Record<string, string> {
  return texts(
    ids.map(([id, fact]) => rejected(id, fact)),
    ids.map(([id, fact]) => recorded(id, fact)),
    structuredAgentSessionStartFailureFacts(items)
  )
}

const key = agentJournalSubmissionKey

// Matched on the typed fact of a row found by its identity, never on either sentence.
describe('a message rejected by a start whose row already says why', () => {
  it('reads only the start-failure rows', () => {
    expect(
      structuredAgentSessionStartFailureFacts([
        row('gen', startFailed, 2),
        { ...row('gen', { kind: 'providerExited' }, 3), itemId: key('exit-row') }
      ])
    ).toEqual([{ itemId: rowKey('gen'), fact: startFailed, ofCommand: false }])
  })

  // This host: each failed start rejects its message and writes the row keyed by it, in one write.
  it('hushes a message by its own row, and only by its own', () => {
    expect(
      noticesFor(
        [
          ['first', startFailed],
          ['later', startFailed]
        ],
        [
          messageAt('first', 1),
          row('first', startFailed, 2),
          messageAt('later', 5),
          row('later', otherRefusal, 6)
        ]
      )
    ).toEqual({
      [key('first')]: NOT_SENT,
      // Its own row states another failure: an equal failure in another message's row is not its.
      [key('later')]: START_FAILED_WORDS
    })
  })

  // v1.4.221: the row first, keyed by the oldest queued message, then every queued message rejected.
  it("hushes a released host's batch, its row written before the rejections", () => {
    expect(
      noticesFor(
        [
          ['oldest', startFailed],
          ['second', startFailed],
          ['other', otherRefusal]
        ],
        [
          row('oldest', startFailed, 1),
          messageAt('oldest', 2),
          messageAt('second', 3),
          messageAt('other', 9)
        ]
      )
    ).toEqual({
      [key('oldest')]: NOT_SENT,
      [key('second')]: NOT_SENT,
      [key('other')]:
        "Claude couldn't start. This chat is still open in a terminal agent. Quit that agent to continue the chat here."
    })
  })

  // Unreleased main: every queued message rejected, then the row keyed by the start's generation.
  it('hushes a batch whose row was written after its rejections', () => {
    expect(
      noticesFor(
        [
          ['first', startFailed],
          ['second', startFailed]
        ],
        [messageAt('first', 1), messageAt('second', 2), row('generation-1', startFailed, 3)]
      )
    ).toEqual({ [key('first')]: NOT_SENT, [key('second')]: NOT_SENT })
  })

  // This host: a run of starts that fail alike writes only its first message's row.
  it('hushes the messages of a run under its one row, and not one that failed otherwise', () => {
    expect(
      noticesFor(
        [
          ['first', startFailed],
          ['second', startFailed],
          ['third', startFailed],
          ['other', otherRefusal]
        ],
        [
          messageAt('first', 1),
          row('first', startFailed, 2),
          messageAt('second', 3),
          messageAt('third', 4),
          messageAt('other', 5)
        ]
      )
    ).toEqual({
      [key('first')]: NOT_SENT,
      [key('second')]: NOT_SENT,
      [key('third')]: NOT_SENT,
      [key('other')]:
        "Claude couldn't start. This chat is still open in a terminal agent. Quit that agent to continue the chat here."
    })
  })

  // A log diagnostic's text is not the failure: a CLI's stderr can carry a timestamp per attempt.
  it('hushes a message under a row whose log diagnostic differs, not one whose words for a person do', () => {
    const exited = (text: string, audience: 'log' | 'person'): AgentSessionFailureFact => ({
      kind: 'providerStartFailed',
      detail: { text, audience }
    })
    expect(
      noticesFor(
        [
          ['first', exited('01:02:03 ERROR config', 'log')],
          ['logged', exited('01:02:09 ERROR config', 'log')]
        ],
        [
          messageAt('first', 1),
          row('first', exited('01:02:03 ERROR config', 'log'), 2),
          messageAt('logged', 3)
        ]
      )
    ).toEqual({ [key('first')]: NOT_SENT, [key('logged')]: NOT_SENT })
    expect(
      noticesFor(
        [
          ['first', exited('no rollout for t-1', 'person')],
          ['worded', exited('no rollout for t-2', 'person')]
        ],
        [
          messageAt('first', 1),
          row('first', exited('no rollout for t-1', 'person'), 2),
          messageAt('worded', 3)
        ]
      )[key('worded')]
    ).not.toBe(NOT_SENT)
  })

  // A command's row says to run the command again: never the next step for a message.
  it("hushes a /compact under its own row, and never a message under the command's row", () => {
    const compactAt = (id: string, sequence: number): AgentJournalRenderItem => ({
      ...messageAt(id, sequence),
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '/compact' }],
        command: { name: 'compact' }
      }
    })
    expect(
      noticesFor(
        [
          ['compacted', startFailed],
          ['later', startFailed]
        ],
        [compactAt('compacted', 1), row('compacted', startFailed, 2), messageAt('later', 3)]
      )
    ).toEqual({ [key('compacted')]: NOT_SENT, [key('later')]: START_FAILED_WORDS })
  })

  it('keeps the full notice when the rejection is not loaded, or no start row states it', () => {
    const stated = { itemId: rowKey('first'), fact: startFailed, ofCommand: false }
    expect(texts([rejected('first', startFailed)], [], [stated])).toEqual({
      [key('first')]: 'Written by the host.'
    })
    expect(texts([rejected('first', startFailed)], [recorded('first', startFailed)], [])).toEqual({
      [key('first')]: START_FAILED_WORDS
    })
  })
})

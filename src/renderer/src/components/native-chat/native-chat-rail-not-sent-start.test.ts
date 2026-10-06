// The rail's lit tick for a chat whose last message was recorded, then not sent because the agent
// failed to start: three delivered prompts with replies, the not-sent message, then the start's
// row at the bottom. Built through the renderer's own path from journal items to rail slots.

import { describe, expect, it } from 'vitest'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { nativeChatTurnMembership } from '../../../../shared/native-chat-turn-membership'
import { nativeChatRowsInDrawOrder } from '../../../../shared/native-chat-turn-grouping'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'
import { findActiveNativeChatRailItem } from './native-chat-active-rail-item'
import { buildNativeChatRailItems } from './native-chat-message-rail-items'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'
import type { NativeChatResolvedPrompt } from './native-chat-resolution-receipt'
import { projectNativeChatTaskListFrames } from './native-chat-task-list-frames'
import { omitNativeChatThreadGoalRows } from './native-chat-thread-goal-rows'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import type { NativeChatTurnDiff } from './native-chat-turn-diffs'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

const START_FAILED: AgentSessionFailureFact = { kind: 'providerStartFailed' }
const NOT_SENT = agentJournalSubmissionKey('fourth')
const ROW_PX = 100

type Scope = AgentJournalRenderItem['turnScope']

function row(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body'],
  turnScope: Scope
): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    sequence,
    observedAt: 1000 + sequence,
    body,
    ...(turnScope ? { turnScope } : {})
  }
}

function submission(
  id: string,
  dispatchState: AgentJournalSubmission['dispatchState']
): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: id,
    dispatchState,
    providerItemId: null,
    reason: null,
    ...(dispatchState === 'rejected' ? { rejection: START_FAILED } : {}),
    submittedAt: 1,
    resolvedAt: 1
  }
}

/** With `scoped`, the host states each row's turn and writes a record per turn; without, an older
 *  host's journal is grouped by order. */
function journal(scoped: boolean): {
  items: AgentJournalRenderItem[]
  submissions: AgentJournalSubmission[]
} {
  const items: AgentJournalRenderItem[] = []
  const submissions: AgentJournalSubmission[] = []
  let sequence = 0
  for (const n of [1, 2, 3]) {
    const user = agentJournalSubmissionKey(`m${n}`)
    const turn = `turn-${n}`
    const inTurn: Scope = scoped ? { kind: 'turn', turnItemId: turn } : undefined
    if (scoped) {
      items.push(
        row(
          turn,
          (sequence += 1),
          {
            kind: 'turn',
            turnId: turn,
            state: 'completed',
            outcome: 'success',
            userItemId: user
          },
          { kind: 'thread' }
        )
      )
    }
    items.push(
      row(
        user,
        (sequence += 1),
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `message ${n}` }] },
        inTurn
      ),
      row(
        `reply-${n}`,
        (sequence += 1),
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `reply ${n}` }] },
        inTurn
      )
    )
    submissions.push(submission(`m${n}`, 'accepted'))
  }
  const thread: Scope = scoped ? { kind: 'thread' } : undefined
  items.push(
    row(
      NOT_SENT,
      (sequence += 1),
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'fourth message after exit' }]
      },
      thread
    ),
    row(
      agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('start-1')),
      (sequence += 1),
      {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(START_FAILED, { agentName: 'Claude', surface: 'row' })
      },
      thread
    )
  )
  submissions.push(submission('fourth', 'rejected'))
  return { items, submissions }
}

/** The renderer's path from the journal to the transcript's slots, as the message list runs it. */
function slotsOf(scoped: boolean) {
  const { items, submissions } = journal(scoped)
  const projected = createNativeChatMessageListProjection()(
    projectStructuredAgentSessionMessages(items, [], submissions, [])
  ).conversation
  const messages = omitNativeChatThreadGoalRows(projectNativeChatTaskListFrames(projected))
  const membership = nativeChatTurnMembership(messages, { items, submissions })
  return buildNativeChatTranscriptSlots({
    messages: nativeChatRowsInDrawOrder(messages, membership.drawOrder),
    turnKeys: nativeChatRowsInDrawOrder(membership.turnKeys, membership.drawOrder),
    liveTurnKey: membership.liveTurnKey,
    receipts: new Map<string, NativeChatResolvedPrompt>(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map<string, NativeChatTurnDiff>(),
    expandedTurnKeys: new Set<string>(),
    isWorking: false,
    lifecycleWorking: false
  })
}

describe("the rail below a message not sent because the agent's start failed", () => {
  for (const scoped of [true, false]) {
    describe(scoped ? 'host-stated turns' : 'turns by journal order', () => {
      const slots = slotsOf(scoped)
      const third = agentJournalSubmissionKey('m3')
      const virtualItems = slots.map((_slot, index) => ({
        index,
        start: index * ROW_PX,
        end: (index + 1) * ROW_PX
      }))
      const read = (scrollTop: number, clientHeight: number, scrollHeight: number) =>
        findActiveNativeChatRailItem({
          slots,
          virtualItems,
          scrollTop,
          clientHeight,
          scrollHeight,
          previousActiveId: null
        })
      const indexOf = (find: (slot: (typeof slots)[number]) => boolean): number =>
        slots.findIndex(find)

      it('draws the not-sent message then the start row last, with three ticks', () => {
        const notSent = indexOf((slot) => slot.kind === 'message' && slot.message.id === NOT_SENT)
        expect(notSent).toBe(slots.length - 2)
        const last = slots.at(-1)
        expect(last?.kind === 'message' && last.message.role).not.toBe('user')
        expect(buildNativeChatRailItems(slots).map((item) => item.id)).toEqual([
          agentJournalSubmissionKey('m1'),
          agentJournalSubmissionKey('m2'),
          third
        ])
      })

      it('lights the third message when the whole chat fits, pinned to the bottom', () => {
        const height = slots.length * ROW_PX
        expect(read(0, height + 400, height)).toBe(third)
      })

      it('lights the third message with the not-sent row or the start row at the fold', () => {
        const scrollHeight = slots.length * ROW_PX + 2000
        expect(read((slots.length - 2) * ROW_PX, 300, scrollHeight)).toBe(third)
        expect(read((slots.length - 1) * ROW_PX, 300, scrollHeight)).toBe(third)
      })
    })
  }
})

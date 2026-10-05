// The status feed's per-journal projection, cached per commit: what a session's journal says its
// row is, and the user's newest send the provider accepted.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { deriveJournalAsyncQuestions } from '../../../shared/native-chat-async-question-facts'
import {
  nativeChatAsyncQuestionsFieldsEqual,
  publishNativeChatAsyncQuestions,
  type NativeChatAsyncQuestionsField
} from '../../../shared/native-chat-async-questions'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { newestAcceptedSendKey } from './structured-agent-session-status-child-work'

export type StructuredAgentSessionStatusState = ReturnType<
  typeof projectStructuredAgentSessionStatusState
>

export type StructuredAgentSessionJournalProjection = {
  epoch: string
  sequence: number
  readOnly: boolean
  fence: number | undefined
  state: StructuredAgentSessionStatusState
  /** Null for an unreadable journal, which says nothing about the user's turns. */
  acceptedSendKey: string | null
}

export class StructuredAgentSessionJournalProjections {
  // Task progress must not sort and scan an unchanged conversation. Journal identity owns cleanup.
  private readonly byJournal = new WeakMap<
    AgentSessionJournal,
    StructuredAgentSessionJournalProjection
  >()

  read(
    journal: AgentSessionJournal,
    record: AgentSessionRecord | null
  ): StructuredAgentSessionJournalProjection {
    // An unreadable journal projects as "no turn": the chat itself shows the reset.
    const cursor = journal.cursor()
    const readOnly = journal.isReadOnly
    // The conversation's fence, which a child's end moves: its unanswered sends stop counting.
    const fence = record?.lease.runtimeFence
    let projection = this.byJournal.get(journal)
    if (
      !projection ||
      projection.epoch !== cursor.epoch ||
      projection.sequence !== cursor.sequence ||
      projection.readOnly !== readOnly ||
      projection.fence !== fence
    ) {
      // A journalled submission bumps `lastSequence`, so the send-time working
      // signal reaches the cache; the lease fence does not, hence the extra key.
      const snapshot = readOnly ? null : journal.snapshot()
      projection = {
        ...cursor,
        readOnly,
        fence,
        state: projectStructuredAgentSessionStatusState(
          snapshot?.items ?? [],
          snapshot?.submissions ?? [],
          fence
        ),
        acceptedSendKey: snapshot
          ? newestAcceptedSendKey(cursor.epoch, snapshot.submissions ?? [])
          : null
      }
      this.byJournal.set(journal, projection)
    }
    return projection
  }
}

const NO_ASYNC_QUESTIONS: NativeChatAsyncQuestionsField = { state: 'ready', questions: [] }

type AsyncQuestionsProjection = {
  epoch: string
  sequence: number
  readOnly: boolean
  field: NativeChatAsyncQuestionsField
}

// One derivation per journal commit, shared by every subscriber of the session.
const asyncQuestionsByJournal = new WeakMap<AgentSessionJournal, AsyncQuestionsProjection>()

function journalHasAsyncQuestions(journal: AgentSessionJournal): boolean {
  let found = false
  journal.visitItems((_itemId, _sequence, body) => {
    found ||=
      body.kind === 'message' &&
      body.blocks.some((block) => block.type === 'text' && block.asyncQuestions !== undefined)
  })
  return found
}

/** The pending Codex async questions the whole journal records, as published. Identity is
 *  stable while the set is unchanged, so subscribers can deduplicate it by reference. */
export function readStructuredAgentSessionAsyncQuestions(
  journal: AgentSessionJournal
): NativeChatAsyncQuestionsField {
  const cursor = journal.cursor()
  const readOnly = journal.isReadOnly
  const cached = asyncQuestionsByJournal.get(journal)
  if (
    cached &&
    cached.epoch === cursor.epoch &&
    cached.sequence === cursor.sequence &&
    cached.readOnly === readOnly
  ) {
    return cached.field
  }
  let field = NO_ASYNC_QUESTIONS
  // Most journals never asked one; skip the sorted snapshot for them.
  if (!readOnly && journalHasAsyncQuestions(journal)) {
    const snapshot = journal.snapshot()
    field = publishNativeChatAsyncQuestions(
      deriveJournalAsyncQuestions(snapshot.items, snapshot.submissions)
    )
  }
  if (cached && nativeChatAsyncQuestionsFieldsEqual(cached.field, field)) {
    field = cached.field
  }
  asyncQuestionsByJournal.set(journal, { ...cursor, readOnly, field })
  return field
}

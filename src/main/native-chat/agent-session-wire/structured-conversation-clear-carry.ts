// The clear record, destination journal, carried cards and source withdrawal share one commit.

import { randomUUID } from 'node:crypto'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session-wire'
import { agentSessionOperationKey } from '../../../shared/agent-session-operation-ledger'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import {
  insertQueuedMessage,
  withdrawQueuedMessages,
  type QueuedMessageRow
} from '../agent-session-journal/queued-message-table'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { unsettledQueuedMessages } from './structured-agent-session-queued-stop'
import { queuePauseHolding } from '../agent-session-journal/queued-message-pause'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'
import { writeNewJournalEpoch } from '../agent-session-journal/journal-epoch-rollover'
import { buildJournalQueueReopenRow } from '../agent-session-journal/journal-stop-and-resume-rows'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import { applyJournalRow } from '../agent-session-journal/journal-reducer'
import { journalIdentityFor } from './structured-agent-session-attach'
import { attachParamsForRecord } from './structured-agent-session-conversation-open'
import { claimAgentSessionAttachmentsInTransaction } from '../agent-session-attachments/agent-session-attachment-claims'

export const STRUCTURED_AGENT_SESSION_CLEAR_COMMAND = 'clear'

/** What the queue's drain needs to run a /clear card itself. */
export type QueuedClearDrainDeps = {
  /** The card's turn, inside the drain's step; true once the clear committed. A card waiting on
   *  background tasks or a handoff stays waiting; their ending wakes the drain. */
  run: (sessionId: string, card: QueuedMessageRow) => Promise<boolean>
  /** What follows a committed clear, outside the step: it closes the source, which serializes. */
  after: (sessionId: string) => Promise<void>
}

/** A /clear the queue holds: run by the host when its turn comes, never handed to the agent. */
export function isQueuedClearCard(row: Pick<QueuedMessageRow, 'body'>): boolean {
  return row.body.command?.name === STRUCTURED_AGENT_SESSION_CLEAR_COMMAND
}

/** The committed /clear that superseded this conversation; null while it is current. */
export function committedClearOf(
  record: AgentSessionRecord | null
):
  | (NonNullable<AgentSessionRecord['conversationCommand']> & { replacementSessionId: string })
  | null {
  const command = record?.conversationCommand
  return command?.command === 'clear' &&
    command.phase === 'committed' &&
    command.replacementSessionId
    ? { ...command, replacementSessionId: command.replacementSessionId }
    : null
}

/** Cards after the clear keep running in order; earlier message cards stay paused, and earlier
 *  commands disappear. A copy failure rolls back the clear too, leaving its card available to retry. */
export function commitClearWithQueuedMessages(
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'journal'>,
  input: {
    replacement: AgentSessionRecord
    stateDirectory: string
    callerKey: string
    operationId: string
    now: number
    receipt: JournalOperationReceipt
  }
): Promise<boolean> {
  return ctx.journal.queuedMessages.transact(
    (db) => {
      const rows = unsettledQueuedMessages(ctx.journal)
      const clearCard = ctx.journal.queuedMessages.get(input.operationId)
      const behind = clearCard && isQueuedClearCard(clearCard) ? clearCard.position : Infinity
      const carried = rows.filter(
        (row) => row.messageId !== input.operationId && (row.position > behind || !row.body.command)
      )
      const reopened = structuredQueuePauses(ctx.journal).filter(
        (pause) => pause.reason === 'restarted'
      )
      const replacementId = input.replacement.sessionId
      const params = attachParamsForRecord(input.replacement, {
        clientOperationId: input.operationId,
        expectedRuntimeFence: input.replacement.lease.runtimeFence
      })
      const { state } = writeNewJournalEpoch(db, {
        identity: journalIdentityFor(input.replacement, params),
        epoch: randomUUID(),
        reason: 'session_created',
        fence: 0,
        now: input.now
      })
      if (carried.some((row) => queuePauseHolding(reopened, row))) {
        const mark = buildJournalQueueReopenRow({
          state,
          seq: state.lastSequence + 1,
          fence: input.replacement.lease.runtimeFence,
          ts: input.now
        })
        insertJournalRow(db, replacementId, mark)
        applyJournalRow(state, mark)
      }
      for (const row of carried) {
        claimAgentSessionAttachmentsInTransaction(db, {
          stateDirectory: input.stateDirectory,
          sessionId: replacementId,
          body: row.body,
          required: false,
          now: input.now
        })
        insertQueuedMessage(db, {
          sessionId: replacementId,
          messageId: row.messageId,
          body: row.body,
          fingerprint: agentSessionSendBodyFingerprint(replacementId, row.body),
          hostInstance: row.hostInstance,
          now: input.now,
          queuedAt: queuePauseHolding(reopened, row)
            ? (row.queuedAt ?? ctx.journal.cursor())
            : { epoch: state.epoch, sequence: state.lastSequence },
          ...(row.position > behind ? {} : { carriedFrom: ctx.sessionId }),
          ...(row.holdReason === QUEUED_MESSAGE_PAUSED_SEND_FAILED
            ? { holdReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED }
            : {})
        })
      }
      withdrawQueuedMessages(db, {
        sessionId: ctx.sessionId,
        messageIds: rows.map((row) => row.messageId),
        settledByOp: agentSessionOperationKey(input.callerKey, input.operationId),
        now: input.now
      })
      input.receipt.write(db)
      return carried.length > 0
    },
    () => true,
    input.receipt.committed
  )
}

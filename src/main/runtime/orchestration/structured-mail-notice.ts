/**
 * The mail notice the structured lane sends a chat, and the queue's judgement of it as it leaves the
 * chat's queue. Both read the same owed batch, so a notice is judged by the selection it was built
 * from.
 */

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import type { QueuedAgentCardVerdict } from '../../native-chat/agent-session-wire/structured-agent-session-queued-agent-card'
import type { OrchestrationCliCommand } from './cli-command'
import type { OrchestrationDb } from './db'
import { formatMessagePointer } from './formatter'
import {
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type { StructuredPointerTarget } from './structured-mailbox-pointer-delivery'
import { structuredPointerSource, type PointerBatchMessage } from './structured-pointer-source'

/**
 * The rows a pointer may count right now. A consumer still holding an unacknowledged batch is owed
 * none: the lookup is keyed on the exact handle being nudged, so a coordinator's own `run:`
 * delivery is invisible to a worker's `dispatch:` gate and cannot suppress the nudges a
 * coordinator sends its workers. Worth more here than in the PTY lane: a structured nudge costs a
 * whole provider turn.
 */
export function owedPointerBatch(
  db: OrchestrationDb,
  mailboxHandle: string,
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined,
  reservedTypes: ReadonlySet<string> | undefined
): readonly PointerBatchMessage[] {
  return db.hasOutstandingMailboxDelivery?.(mailboxHandle)
    ? []
    : selectOrchestrationPointerBatch({ db, mailboxHandle, waiters, reservedTypes })
}

export function mailNoticeBody(
  mailboxHandle: string,
  count: number,
  cli: OrchestrationCliCommand
): AgentJournalMessageItem {
  const text = formatMessagePointer(count, mailboxHandle, cli).trim()
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

/**
 * A mail notice is about to leave a chat's queue, in the drain's serialized step: send it if it
 * still counts the mail owed, restate it if the owed mail changed, withdraw it if none is owed or
 * the mailbox now reaches another session or none (whose own notice the lane sends). One
 * synchronous read of orchestration's database, by the same selection the lane points from.
 */
export function judgeMailNotice(
  deps: {
    db: OrchestrationDb | null
    /** Whether a host is there to resolve the session's mail through. */
    hostCanResolve: (sessionId: string) => boolean
    resolveStructuredTarget: (mailboxHandle: string) => StructuredPointerTarget | null
    getMessageWaiters: (
      mailboxHandle: string
    ) => ReadonlySet<OrchestrationMessageWaiter> | undefined
    getCliCommand: () => OrchestrationCliCommand
  },
  input: { sessionId: string; source: AgentMessageSource }
): QueuedAgentCardVerdict {
  const { db } = deps
  const notice = input.source.orchestration
  // No database, or no host to resolve the mailbox through (Orca is quitting): not looking is no
  // evidence about the mail, so the card waits for a step that can look.
  if (!db || !deps.hostCanResolve(input.sessionId)) {
    return { kind: 'defer' }
  }
  switch (notice.message) {
    case 'mail-notice': {
      if (deps.resolveStructuredTarget(notice.mailbox)?.sessionId !== input.sessionId) {
        return { kind: 'withdraw' }
      }
      const owed = owedPointerBatch(
        db,
        notice.mailbox,
        deps.getMessageWaiters(notice.mailbox),
        undefined
      )
      if (owed.length === 0) {
        return { kind: 'withdraw' }
      }
      if (owed.map((message) => message.id).join('\n') === notice.messageIds.join('\n')) {
        return { kind: 'send' }
      }
      return {
        kind: 'restate',
        body: mailNoticeBody(notice.mailbox, owed.length, deps.getCliCommand()),
        source: structuredPointerSource({
          db,
          mailboxHandle: notice.mailbox,
          dispatchId: notice.dispatchId,
          batch: owed
        })
      }
    }
  }
}

import {
  agentSessionFailureFact,
  MAX_PROVIDER_DIAGNOSTIC_CHARS,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { partitionJournalLifecycleMutations } from '../agent-session-journal/journal-lifecycle-batch-partition'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import {
  endedUnseenMessageBody,
  runningCallEnd,
  terminalAgentJournalBody
} from '../agent-session-journal/journal-terminal-settlement'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import { structuredAgentSessionStartFailure } from './structured-agent-session-failure-text'
import {
  hasStructuredAgentSessionStartFailureRow,
  structuredAgentSessionStartFailureRow
} from './structured-agent-session-start-failure-row'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import {
  runningTurnLifecycleRevisions,
  watchedExitRevisions,
  type StructuredAgentSessionTurnVerdict,
  type StructuredAgentSessionWatchedExit
} from './structured-agent-session-stale-turn-verdict'
import { exitedRootTurnScope } from './structured-agent-session-exit-turn-scope'
import {
  appendGoneGenerationSettlement,
  planGoneGenerationSettlement
} from './structured-agent-session-open-settlement'
import {
  hasUnfinishedStructuredAgentSessionWork,
  type DeadGenerationJournal
} from './structured-agent-session-unfinished-work'
import { withdrawCodexSendsNoTurnOpenedFor } from './structured-agent-session-unopened-send-withdrawal'

/** Bounds the exit reason the lease keeps as log evidence; a provider diagnostic is held to the
 *  same cap. */
export const MAX_UNEXPECTED_EXIT_REASON_CHARS = MAX_PROVIDER_DIAGNOSTIC_CHARS

/** Whether the settlement was written, and what stopped it when it was not. */
export type StructuredAgentSessionDeadGenerationSettlement =
  | { ok: true }
  | { ok: false; error: unknown }

export async function settleStructuredAgentSessionDeadGeneration(input: {
  journal: DeadGenerationJournal
  sessionId: string
  fence: number
  settlementId: string
  verdict: StructuredAgentSessionTurnVerdict
  pendingSubmissionReason: string
  showUnexpectedExitOutcome?: boolean
  /** Why the provider stopped, as the adapter told it; the row's sentence is this fact's. */
  exitFailure?: SubmissionRejectionFact
  /** Who a failed start's sentence names. */
  failureTextContext?: AgentSessionFailureWordsContext
  /** The provider never finished starting: the start that failed, keyed by the child's
   *  generation. Its row is the one the delivery loop writes for the same start. */
  exitedDuringStartup?: { generation: string | null }
  /** The exit, watched: what that child's own translator could only end `unverifiable` (its stream
   *  closed before the exit was proven) is revised in this batch. */
  exit?: StructuredAgentSessionWatchedExit
  /** A person's Stop ended a starting child before what it was handed could run: each is rejected so. */
  unrunRejection?: SubmissionRejectionFact
}): Promise<StructuredAgentSessionDeadGenerationSettlement> {
  try {
    const hasUnfinishedWork = hasUnfinishedStructuredAgentSessionWork(input.journal, input.exit)
    const showUnexpectedExitOutcome = input.showUnexpectedExitOutcome ?? hasUnfinishedWork
    if (!showUnexpectedExitOutcome && !hasUnfinishedWork) {
      return { ok: true }
    }
    // A queued message is the delivery loop's to settle: it was never handed to this child. A send
    // a child still starting was handed and never echoed did not run, and its root is gone: it is
    // rejected, with the child's own diagnostic or as the Stop that ended it. A proven child's
    // handed-over sends stay in doubt.
    const startupFailure = input.exitedDuringStartup
      ? structuredAgentSessionStartFailure({ exit: input.exitFailure }, input.failureTextContext)
      : null
    const closed = input.unrunRejection
    const unrun =
      startupFailure ?? (closed && agentSessionFailureWords(closed, { surface: 'rejection' }))
    if (!unrun) {
      await withdrawCodexSendsNoTurnOpenedFor(input.journal, input.fence)
    }
    await (unrun
      ? input.journal.rejectPendingSubmissions(input.fence, unrun)
      : input.journal.markPendingSubmissionsUnknown(input.fence, input.pendingSubmissionReason))
    const items = input.journal.snapshot().items
    const proven = watchedExitRevisions(items, input.exit, input.journal)
    const mutations: JournalLifecycleMutationInput[] = []
    if (showUnexpectedExitOutcome && input.exitedDuringStartup && startupFailure) {
      const startKey = input.exitedDuringStartup.generation ?? input.settlementId
      // A start a message waited on is the delivery loop's to record, before or after this exit,
      // in the words it rejected the message with; this row is for a command, goal or rewind start.
      // A row already written stays: rejected is terminal, so its words are not reworded.
      const recordedByDeliveryLoop =
        input.journal.submissions?.().some(isQueuedAgentJournalSubmission) ||
        hasStructuredAgentSessionStartFailureRow(items, startKey)
      if (!recordedByDeliveryLoop) {
        mutations.push(structuredAgentSessionStartFailureRow(startKey, startupFailure))
      }
    } else if (showUnexpectedExitOutcome) {
      // The turn the exit ended, and an error so no fold ever hides why it stopped.
      mutations.push({
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: input.settlementId },
        body: {
          kind: 'status',
          ...agentSessionFailureWords(
            input.exitFailure ?? agentSessionFailureFact('providerExited'),
            {
              ...input.failureTextContext,
              surface: 'row'
            }
          ),
          tone: 'error'
        },
        turnScope: exitedRootTurnScope(withRevisions(items, proven), input.verdict)
      })
    }
    const bodies = new Map(items.map((item) => [item.itemId, item.body]))
    for (const item of items) {
      const identity = parseAgentJournalItemKey(item.itemId)
      // Ended as its turn is: a proven death cuts a running call short. An open reasoning row is
      // ended too, but is not unfinished work: its running turn already says so.
      const end = runningCallEnd(item.turnScope, (id) => bodies.get(id), input.verdict.state)
      const body = endedUnseenMessageBody(item.body) ?? terminalAgentJournalBody(item.body, end)
      if (identity && body) {
        mutations.push({
          kind: 'item',
          identity,
          body,
          turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
        })
      }
    }
    mutations.push(...runningTurnLifecycleRevisions(items, input.verdict), ...proven)
    const batchId = `dead-generation:${input.settlementId}`
    for (const chunk of partitionJournalLifecycleMutations(batchId, mutations)) {
      await input.journal.appendLifecycleBatch({
        settlementId: chunk.settlementId,
        fence: input.fence,
        recovered: true,
        mutations: chunk.mutations
      })
    }
    return { ok: true }
  } catch (error) {
    // Returned rather than logged: each caller logs it under its own scope.
    return { ok: false, error }
  }
}

/**
 * Settles whatever a generation with no child in this process left running, against the
 * generation an acquisition just took (see `planGoneGenerationSettlement`, the open's own rule).
 * Must run before a new child's buffered events land, or a live turn would be judged.
 */
export async function settleStaleStructuredAgentSessionState(input: {
  journal: AgentSessionJournal
  sessionId: string
  fence: number
  acquisitionGeneration: string | null
  deathEvidence: AgentSessionDeathEvidence | null
  /** Who the exit row names. */
  failureTextContext?: AgentSessionFailureWordsContext
}): Promise<number> {
  const { journal } = input
  const settlement = planGoneGenerationSettlement({
    items: journal.snapshot().items,
    journal,
    sessionId: input.sessionId,
    fence: input.fence,
    // Per attempt: a retry re-partitions only what is left, and a reused chunk id would skip it.
    generation: input.acquisitionGeneration ?? `seq-${journal.cursor().sequence}`,
    deathEvidence: input.deathEvidence,
    failureTextContext: input.failureTextContext
  })
  await appendGoneGenerationSettlement(journal, settlement, input.fence)
  return settlement.mutations.length
}

function withRevisions(
  items: readonly AgentJournalRenderItem[],
  revisions: readonly JournalLifecycleMutationInput[]
): AgentJournalRenderItem[] {
  const bodies = new Map(
    revisions.flatMap((revision): [string, AgentJournalItemBody][] =>
      revision.kind === 'item' ? [[agentJournalItemKey(revision.identity), revision.body]] : []
    )
  )
  return items.map((item) => ({ ...item, body: bodies.get(item.itemId) ?? item.body }))
}

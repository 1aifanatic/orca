import { conversationCommandInFlight } from './structured-conversation-command-admission'
import { sendStructuredAgentSessionTurn } from './structured-agent-session-host-mutations'
import {
  runStructuredConversationCommand,
  type ConversationCommandParams
} from './structured-conversation-command'
import { runStructuredCompaction } from './structured-conversation-compaction'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

export class StructuredConversationCommandController {
  /** Held only by a clear, which replaces the conversation a send would land in. A compaction is
   *  a queued message, and sends accepted behind it wait for it in the queue. */
  readonly pending = new Map<string, { key: string; count: number }>()
  constructor(
    private readonly context: () => StructuredAgentSessionMutationContext,
    private readonly host: Pick<StructuredAgentSessionHost, 'waitForSendSettlement' | 'close'>
  ) {}
  /** Whether a clear is in flight is read as the send arrives; it refuses only a first run, so an
   *  id with a recorded answer by the send's turn gets that answer, behind the clear. */
  send = (
    caller: StructuredAgentSessionCaller,
    params: Parameters<typeof sendStructuredAgentSessionTurn>[2]
  ): ReturnType<typeof sendStructuredAgentSessionTurn> =>
    sendStructuredAgentSessionTurn(this.context(), caller, params, {
      clearInFlight: this.pending.has(params.envelope.sessionId)
    })

  run = (caller: StructuredAgentSessionCaller, params: ConversationCommandParams) => {
    if (params.command === 'compact') {
      return runStructuredCompaction(this.context(), this.host, caller, params)
    }
    const key = JSON.stringify([caller.callerKey, params.envelope.clientOperationId])
    const pending = this.pending.get(params.envelope.sessionId)
    if (pending && pending.key !== key) {
      return Promise.resolve({ ok: false as const, refusal: conversationCommandInFlight() })
    }
    const entry = pending ?? { key, count: 0 }
    entry.count++
    this.pending.set(params.envelope.sessionId, entry)
    return runStructuredConversationCommand(this.context(), caller, params)
      .then(async (result) => {
        if (result.ok && result.value.command === 'clear' && result.value.replacementSessionId) {
          await this.afterClear(params.envelope.sessionId)
        }
        return result
      })
      .finally(() => {
        if (--entry.count === 0 && this.pending.get(params.envelope.sessionId) === entry) {
          this.pending.delete(params.envelope.sessionId)
        }
        // A clear can settle with no journal commit (a refusal), and drafts held behind it
        // would otherwise wait for an unrelated commit.
        this.context().wakeQueuedDrain?.(params.envelope.sessionId)
      })
  }

  /**
   * What follows a committed /clear, wherever it ran — the command, the queue's drain, or a card's
   * Send: the tab snapshot that moves clients to the replacement, then the source closed as the
   * user closing it. Outside the source's serialize, which the close takes. Both re-derive from
   * the record (`replacements`), so a repeat, or one a crash skipped, changes nothing.
   */
  afterClear = async (sourceSessionId: string): Promise<void> => {
    const replacement = this.replacements().find(
      (entry) => entry.sourceSessionId === sourceSessionId
    )
    try {
      if (replacement) {
        this.context().deps.onConversationReplaced?.(replacement)
      }
      await this.host.close(sourceSessionId, 'user-close')
    } catch (error) {
      // The clear stands; the next snapshot store and the next restore re-derive the move.
      this.context().deps.logger.warn('moving clients off a cleared chat failed', {
        scope: 'clear-tab-move',
        sessionId: sourceSessionId,
        error
      })
    }
  }

  replacements = () => {
    const store = this.context().deps.store
    const records = store.listRecords()
    const visible = new Set(store.listVisibleSessionIds())
    const byId = new Map(records.map((record) => [record.sessionId, record]))
    const destinations = new Map<string, string | null>()
    const destination = (source: string): string | null => {
      const path = new Set<string>()
      let current = source
      while (!destinations.has(current) && !path.has(current)) {
        path.add(current)
        const command = byId.get(current)?.conversationCommand
        if (
          command?.command !== 'clear' ||
          command.phase !== 'committed' ||
          !command.replacementSessionId
        ) {
          destinations.set(current, current)
          break
        }
        current = command.replacementSessionId
      }
      const target = destinations.get(current) ?? null
      for (const id of path) {
        destinations.set(id, target)
      }
      return target
    }
    return records.flatMap((record) => {
      const target = destination(record.sessionId)
      const sessionId = target !== record.sessionId ? target : null
      // Explicit history reveals remain readable; closed replacements stay closed.
      return sessionId && visible.has(sessionId) && !visible.has(record.sessionId)
        ? [
            {
              sourceSessionId: record.sessionId,
              sessionId,
              workspaceId: record.location.workspaceId,
              agent: record.provider
            }
          ]
        : []
    })
  }
}

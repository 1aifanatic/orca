import { claudeResultOutcome } from '../../claude/claude-result-outcome'
import { isRootClaudeFrame } from '../../claude/claude-turn-opening'

/** How a conversation command the provider ran ended, from the provider's own frames. */
export type StructuredSessionCompactionResult = {
  outcome: 'success' | 'failure' | 'cancellation'
  error?: string
}

type PendingCompaction = {
  identity: string
  /** The host's command turn: its `turnId`, and its journal key. */
  commandTurnId: string
  commandTurnItemId: string
  /** Claude: the uuid of the `/compact` input, which the result answering it names. */
  sentUuid?: string
  /** The provider turn that carries the command out, once the provider opened one. */
  turnId?: string
  error?: string
  compacted: boolean
  resolve: (result: StructuredSessionCompactionResult) => void
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export function isCodexCompactionComplete(method: string, params: unknown): boolean {
  return (
    method === 'thread/compacted' ||
    (method === 'item/completed' && record(record(params).item).type === 'contextCompaction')
  )
}

/** The command one provider child is running. It lives on that child's session, so the child's end
 *  ends it with no release; otherwise only the provider's terminal frame for its own input does.
 *  There is no deadline, and Stop only asks the provider or the child to end it. */
export class StructuredSessionCompaction {
  private pending: PendingCompaction | null = null

  /** The entry is registered before `invoke` sends anything, so the provider turn it opens is
   *  claimed as the command's. */
  async run(
    identity: string,
    invoke: () => Promise<unknown>,
    command: { turnId: string; turnItemId: string; sentUuid?: string }
  ): Promise<StructuredSessionCompactionResult> {
    // The delivery loop hands nothing over while a command runs, so this never happens.
    if (this.pending) {
      throw new Error('Compaction is already running.')
    }
    const completion = new Promise<StructuredSessionCompactionResult>((resolve) => {
      this.pending = {
        identity,
        commandTurnId: command.turnId,
        commandTurnItemId: command.turnItemId,
        ...(command.sentUuid ? { sentUuid: command.sentUuid } : {}),
        compacted: false,
        resolve
      }
    })
    try {
      const admission = record(await invoke())
      if (typeof admission.error === 'string') {
        this.finish({ outcome: 'failure', error: admission.error })
      }
    } catch (error) {
      this.pending = null
      throw error
    }
    return completion
  }

  get running(): boolean {
    return this.pending !== null
  }

  ownsTurn(turnId: string): boolean {
    return this.pending?.commandTurnId === turnId
  }

  providerTurnId(turnId: string): string | undefined {
    return this.ownsTurn(turnId) ? this.pending?.turnId : turnId
  }

  /** The command's journal key when the provider turn starting on `threadId` carries it out. The
   *  single writer of the claim, and idempotent per provider turn so a refused frame's retry gets
   *  the same answer. */
  claimTurn(threadId: string, providerTurnId: string): string | null {
    const pending = this.pending
    if (!pending || pending.identity !== threadId) {
      return null
    }
    pending.turnId ??= providerTurnId
    return pending.turnId === providerTurnId ? pending.commandTurnItemId : null
  }

  codex(method: string, value: unknown): void {
    const pending = this.pending
    const params = record(value)
    if (!pending || params.threadId !== pending.identity) {
      return
    }
    if (isCodexCompactionComplete(method, params)) {
      pending.compacted = true
    }
    const turn = record(params.turn)
    if (method === 'turn/completed' && pending.turnId !== undefined && turn.id === pending.turnId) {
      const error = record(turn.error).message
      this.finish(
        turn.status === 'interrupted'
          ? { outcome: 'cancellation' }
          : turn.status === 'completed' && pending.compacted
            ? { outcome: 'success' }
            : {
                outcome: 'failure',
                error: typeof error === 'string' ? error : 'Compaction did not complete.'
              }
      )
    }
  }

  claude(message: Record<string, unknown>): void {
    const pending = this.pending
    if (!pending || message.session_id !== pending.identity) {
      return
    }
    if (message.compact_result === 'failed') {
      pending.error =
        typeof message.compact_error === 'string' ? message.compact_error : 'Compaction failed.'
    }
    if (message.compact_result === 'success' || message.subtype === 'compact_boundary') {
      pending.compacted = true
    }
    // A result that names another input answers that input. One without a name can only be this
    // command's: nothing else is handed over while it runs.
    const answers = message.user_message_uuid
    if (
      message.type !== 'result' ||
      !isRootClaudeFrame(message) ||
      (typeof answers === 'string' && answers !== pending.sentUuid)
    ) {
      return
    }
    const outcome = claudeResultOutcome(message)
    if (outcome === 'cancellation') {
      this.finish({ outcome })
      return
    }
    const error =
      outcome === 'failure'
        ? (pending.error ?? 'Compaction did not complete.')
        : (pending.error ??
          (pending.compacted ? undefined : 'Compaction was not confirmed by the provider.'))
    this.finish(error ? { outcome: 'failure', error } : { outcome: 'success' })
  }

  private finish(result: StructuredSessionCompactionResult): void {
    const pending = this.pending
    this.pending = null
    pending?.resolve(result)
  }
}

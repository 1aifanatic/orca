import { z } from 'zod'
import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { BoundedMap } from '../../shared/bounded-map'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpDialect } from './acp-dialects/acp-dialect'

const promptErrorSchema = z.looseObject({ message: z.string() })
/** Ends the provider failed, rather than ones it chose (a refusal, a token limit). */
const FAILED_STOP_REASONS = ['error', 'rate_limit']

export function acpStopReasonFailed(stopReason: string): boolean {
  return FAILED_STOP_REASONS.includes(stopReason)
}

/** The provider's words in its error answer to `session/prompt`. */
export function acpPromptErrorDetail(dialect: AcpDialect, error: unknown): string | undefined {
  return dialect.promptErrorDetail?.(error) ?? promptErrorSchema.safeParse(error).data?.message
}

/** One status row per failed turn, in Orca's rejection words with the provider's reason. Providers
 *  send that reason several times (beside the end, after it, in the prompt's error answer), so a
 *  later copy only adds a reason the row still lacks. */
export class AcpTurnFailures {
  /** The reason each failed turn's row holds; '' for none yet. */
  private readonly rows = new BoundedMap<string, string>({ maxEntries: 128 })

  constructor(private readonly sessionId: string) {}

  has(turn: string): boolean {
    return this.rows.has(turn)
  }

  row(turn: string, text: string | undefined): ProviderTimelineEvent[] {
    const written = this.rows.peek(turn)
    const detail = text === undefined ? undefined : providerDiagnostic(text, 'person')
    if (written !== undefined && (written !== '' || !detail)) {
      return []
    }
    this.rows.set(turn, detail?.text ?? '')
    return [
      {
        type: 'item.update',
        item: `turn-failure:${turn}`,
        body: {
          kind: 'status',
          tone: 'error',
          ...agentSessionFailureWords(
            agentSessionFailureFact('providerRejected', detail ? { detail } : {}),
            { surface: 'row' }
          )
        },
        join: { thread: this.sessionId, turn }
      }
    ]
  }
}

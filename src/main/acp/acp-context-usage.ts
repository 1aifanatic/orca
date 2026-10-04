import { z } from 'zod'
import type { AgentSessionContextUsage } from '../../shared/agent-session-context-usage'
import type { UsageUpdate } from './generated/acp-protocol.generated'

export function acpWindowUsage(update: UsageUpdate, at: number): AgentSessionContextUsage {
  return {
    window: { tokens: update.size, capturedAt: at },
    used: {
      kind: 'estimate',
      capturedAt: at,
      usage: {
        inputTokens: update.used,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0
      }
    }
  }
}

export const acpNotificationEnvelopeSchema = z.looseObject({
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() }),
  _meta: z.looseObject({ isReplay: z.boolean().optional() }).nullish()
})

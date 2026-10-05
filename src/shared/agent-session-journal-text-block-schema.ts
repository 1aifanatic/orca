import { z } from 'zod'

export const BoundedPayload = z.object({
  head: z.string(),
  byteLength: z.number(),
  digest: z.string(),
  truncated: z.boolean()
})

export const ProviderFrame = z.object({
  provider: z.string(),
  kind: z.string(),
  payload: BoundedPayload
})

/** What a Codex async message asked; persisted so the host can re-derive pending questions. */
const AsyncQuestions = z.object({
  providerItemId: z.string().optional(),
  questions: z.array(z.object({ title: z.string(), options: z.array(z.string()).optional() }))
})

/** The journal's prose block. Unknown keys pass (see agent-session-journal-schemas.ts). */
export const TextBlock = z.object({
  type: z.literal('text'),
  text: z.string(),
  presentation: z.string().optional(),
  tone: z.string().optional(),
  providerFrame: ProviderFrame.optional(),
  asyncQuestions: AsyncQuestions.optional()
})

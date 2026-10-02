// The typed facts a journal row carries beside the text older clients print: a thread goal, a
// failure, and a Stop's answer. Open like the rest of the render model (see
// agent-session-journal-schemas.ts): a vocabulary a newer build writes must not turn a row malformed.

import { z } from 'zod'

const ThreadGoal = z.object({
  objective: z.string(),
  status: z.string().min(1),
  tokenBudget: z.number().finite().nullable(),
  tokensUsed: z.number().finite(),
  timeUsedSeconds: z.number().finite(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite()
})

/** Like blocks: an unknown `state` stays admissible, a known one with a broken payload does not. */
export const AgentJournalThreadGoalStateSchema = z.union([
  z.discriminatedUnion('state', [
    z.object({ state: z.literal('set'), goal: ThreadGoal }),
    z.object({ state: z.literal('cleared') })
  ]),
  z.object({ state: z.string() }).refine((value) => !['set', 'cleared'].includes(value.state))
])

/** Open like `state`: a kind, audience or refusal detail a newer host writes must not turn the row
 *  malformed; the fact reader is where an unplaceable one is dropped. */
export const AgentJournalFailureFactSchema = z.object({
  kind: z.string().min(1),
  detail: z.object({ text: z.string(), audience: z.string().min(1) }).optional(),
  refusal: z.object({ code: z.string().min(1), details: z.looseObject({}).optional() }).optional()
})

/** Open like the failure fact: an answer a newer host writes must not turn the row malformed;
 *  `readAgentJournalStopAnswer` reads an unknown one as no answer. */
export const AgentJournalStopNoteAnswerSchema = z.object({
  answer: z.string().min(1),
  eventAt: z.number().finite().optional()
})

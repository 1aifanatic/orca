// ─── Canonical runtime schemas for the journal render model ─────────────────
// The journal admits JSON it did not just write — persisted rows re-enter from
// SQLite on replay and are republished to clients — while the reducer, the
// shared projection, and the prompt surfaces dereference nested fields without
// guards. These schemas are the single deep validators for that render model:
// admission must reject a JSON-valid but structurally wrong item (a question
// whose `options` are null, a prompt without its `resolution`) so the row is
// rejected at replay, where a repair can delete it, instead of throwing
// mid-render.
//
// Discriminants (`kind`, known block `type`s) are validated deeply. Open string
// fields (roles, dispatch/tool states) stay type-checked, never enum-checked,
// and unknown object keys pass — a same-version row written by a slightly
// newer build must not be misread as malformed (see journal-row-schema.ts).
//
// What a persisted body this build cannot fully read means is decided per field, here: a body
// `kind` it does not know is a newer build's, so the chat reads read-only; every optional field
// is declared droppable or must-understand (agent-session-journal-optional-facts.ts); a required
// field that fails is damage. A new optional field picks its policy; changing what a field holds
// is a new key, never a new type under the old one.

import { z } from 'zod'
import { AgentSessionContextUsageSchema } from './agent-session-context-usage-schema'
import { droppableFact, mustUnderstandFact } from './agent-session-journal-optional-facts'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalResolution,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'

const BoundedPayload = z.object({
  head: z.string(),
  byteLength: z.number(),
  digest: z.string(),
  truncated: z.boolean()
})

const ProviderFrame = z.object({
  provider: z.string(),
  kind: z.string(),
  payload: BoundedPayload
})

const ToolMetadata = {
  mcpIdentity: droppableFact(z.object({ server: z.string(), tool: z.string() })),
  exitCode: droppableFact(z.number().int()),
  durationMs: droppableFact(z.number().nonnegative()),
  webSearchResults: droppableFact(z.array(z.object({ title: z.string(), url: z.string() })))
}

const KNOWN_BLOCK_TYPES = new Set([
  'text',
  'tool-call',
  'tool-result',
  'image-ref',
  'subagent-group',
  'background-task'
])

/** Provider IDs are opaque; reject all-whitespace values without rewriting valid IDs. */
const ProviderCallId = z
  .string()
  .refine((value) => value.trim().length > 0, 'callId must contain a non-whitespace character')

/** Child-agent lifecycle stays an open string for the same reason tool states
 *  do: a state a newer build writes must not turn the row malformed. */
const SubagentEntry = z.object({
  id: z.string(),
  label: z.string(),
  state: z.string().min(1),
  tokens: droppableFact(z.number()),
  startedAt: droppableFact(z.number()),
  settledAt: droppableFact(z.number())
})

/** Renderers select blocks by `type` equality and skip what they cannot draw,
 *  so an unknown block type stays admissible; a known type with a broken
 *  payload does not. */
const Block = z.union([
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('text'),
      text: z.string(),
      presentation: droppableFact(z.string()),
      tone: droppableFact(z.string()),
      providerFrame: droppableFact(ProviderFrame)
    }),
    // `input: undefined` loses its key under JSON.stringify, so a persisted
    // canonical tool call may lack it entirely.
    z.object({
      type: z.literal('tool-call'),
      name: z.string(),
      input: droppableFact(z.unknown()),
      callId: droppableFact(ProviderCallId),
      ...ToolMetadata
    }),
    z.object({
      type: z.literal('tool-result'),
      output: z.string(),
      isError: droppableFact(z.boolean())
    }),
    z.object({
      type: z.literal('image-ref'),
      path: droppableFact(z.string()),
      url: droppableFact(z.string()),
      alt: droppableFact(z.string())
    }),
    z.object({
      type: z.literal('subagent-group'),
      groupId: z.string(),
      agents: z.array(SubagentEntry)
    }),
    // `kind` and `state` stay open strings for the same reason a child's
    // lifecycle does: a vocabulary a newer build writes must not turn the row
    // malformed. The renderer falls back on anything it cannot name.
    z.object({
      type: z.literal('background-task'),
      taskId: z.string().min(1),
      kind: z.string().min(1),
      label: z.string(),
      state: z.string().min(1),
      parentToolUseId: droppableFact(z.string()),
      summary: droppableFact(z.string()),
      error: droppableFact(z.string()),
      outputFile: droppableFact(z.string()),
      tokens: droppableFact(z.number()),
      startedAt: droppableFact(z.number()),
      settledAt: droppableFact(z.number())
    })
  ]),
  z.object({ type: z.string() }).refine((block) => !KNOWN_BLOCK_TYPES.has(block.type))
])

const PromptOption = z.object({
  id: z.string(),
  label: z.string(),
  description: droppableFact(z.string())
})

const Question = z.object({
  id: z.string(),
  question: z.string(),
  header: droppableFact(z.string()),
  multiSelect: z.boolean(),
  options: z.array(PromptOption),
  // Where an answer's free text goes: dropped, it would go under no question.
  freeTextQuestionId: mustUnderstandFact(z.string())
})

const Resolution = z.object({
  state: z.string().min(1),
  selectedOptionId: z.string().nullable(),
  answers: droppableFact(
    z.array(
      z.object({
        questionId: z.string(),
        optionIds: z.array(z.string()),
        other: z.string().optional()
      })
    )
  ),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.number().nullable()
})

const ApprovalMatchedAskRule = z.object({
  source: z.string(),
  toolName: z.string(),
  ruleContent: z.string().optional()
})

const ApprovalSubject = z.object({
  kind: z.literal('plan'),
  text: z.string().min(1),
  filePath: droppableFact(z.string())
})

export const AgentJournalMessageBodySchema = z.object({
  kind: z.literal('message'),
  role: z.string().min(1),
  blocks: z.array(Block),
  // Open like roles: a send mode a newer build writes must not turn the row malformed.
  sentAs: droppableFact(z.string().min(1)),
  command: droppableFact(z.object({ name: z.string().min(1) }))
})

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
const ThreadGoalState = z.union([
  z.discriminatedUnion('state', [
    z.object({ state: z.literal('set'), goal: ThreadGoal }),
    z.object({ state: z.literal('cleared') })
  ]),
  z.object({ state: z.string() }).refine((value) => !['set', 'cleared'].includes(value.state))
])

/** Open like `state`: a kind, audience or refusal detail a newer host writes must not turn the row
 *  malformed; the fact reader is where an unplaceable one is dropped. */
const FailureFact = z.object({
  kind: z.string().min(1),
  detail: z.object({ text: z.string(), audience: z.string().min(1) }).optional(),
  refusal: z.object({ code: z.string().min(1), details: z.looseObject({}).optional() }).optional()
})

export const AgentJournalItemBodySchema = z.discriminatedUnion('kind', [
  AgentJournalMessageBodySchema,
  z.object({
    kind: z.literal('tool-call'),
    ...ToolMetadata,
    name: z.string(),
    // See the tool-call block: the key itself is lost when `input` is undefined.
    input: droppableFact(z.unknown()),
    callId: droppableFact(ProviderCallId),
    state: z.string().min(1),
    output: droppableFact(BoundedPayload)
  }),
  z.object({ kind: z.literal('diff'), path: z.string(), patch: BoundedPayload }),
  z.object({
    kind: z.literal('approval'),
    title: z.string(),
    displayName: droppableFact(z.string()),
    description: droppableFact(z.string()),
    decisionReason: droppableFact(z.string()),
    blockedPath: droppableFact(z.string()),
    matchedAskRule: droppableFact(ApprovalMatchedAskRule),
    // The plan being approved: approving without it would approve what the person never saw.
    subject: mustUnderstandFact(ApprovalSubject),
    detail: z.string().nullable(),
    options: z.array(PromptOption),
    resolution: Resolution
  }),
  z.object({
    kind: z.literal('question'),
    question: z.string(),
    options: z.array(PromptOption),
    // What an answer is shaped by: dropped, an answer would go to questions nobody was asked.
    questions: mustUnderstandFact(z.array(Question)),
    freeTextQuestionId: mustUnderstandFact(z.string()),
    resolution: Resolution
  }),
  z.object({
    kind: z.literal('status'),
    text: z.string(),
    presentation: droppableFact(z.string()),
    tone: droppableFact(z.string()),
    // A turn's start or end and a goal's change: the host settles turns and answers goal edits
    // from them, so a fold without one would write from a wrong state.
    turnLifecycle: mustUnderstandFact(
      z.object({
        turnId: z.string(),
        state: z.string().min(1),
        outcome: droppableFact(z.string().min(1)),
        userItemId: droppableFact(z.string().min(1)),
        startedAt: droppableFact(z.number().finite().positive()),
        requestedAt: droppableFact(z.number().finite().positive()),
        completedAt: droppableFact(z.number().finite().positive()),
        durationMs: droppableFact(z.number().finite().nonnegative())
      })
    ),
    providerFrame: droppableFact(ProviderFrame),
    threadGoal: mustUnderstandFact(ThreadGoalState),
    failure: droppableFact(FailureFact)
  }),
  z.object({
    kind: z.literal('turn'),
    turnId: z.string(),
    state: z.string().min(1),
    // Open like `state`: a verdict a newer build writes must not turn the row
    // malformed. `readAgentJournalTurnOutcome` is where an unplaceable one
    // becomes unknown rather than an arm a caller would act on.
    outcome: droppableFact(z.string().min(1)),
    userItemId: droppableFact(z.string().min(1)),
    startedAt: droppableFact(z.number().finite().positive()),
    requestedAt: droppableFact(z.number().finite().positive()),
    completedAt: droppableFact(z.number().finite().positive()),
    durationMs: droppableFact(z.number().finite().nonnegative()),
    contextUsage: droppableFact(AgentSessionContextUsageSchema),
    providerTurnId: droppableFact(z.string().min(1))
  })
])

/** Producer linkage as it rides a render item across the process boundary.
 *  `producerKind` stays an open string for the reason the header gives: a host
 *  that learns a third kind must not make its rows unreadable to this client. */
export const AgentJournalProducerLinkageFields = {
  // `.min(1)` on every id: an EMPTY string is present, and the reader that
  // scopes a parent's surfaces tests presence, not truthiness. `agentId: ''`
  // would read as a subagent and hide the row from its own author for good.
  agentId: z.string().min(1).optional(),
  parentAgentId: z.string().min(1).optional(),
  providerParentRef: z.string().min(1).optional(),
  producerKind: z.string().min(1).optional(),
  attempt: z.number().int().optional()
} as const

/** Open like the other persisted vocabularies: a scope kind a newer host states must not turn
 *  the row malformed. A reader places only `turn` with an id; anything else reads as `thread`. */
export const AgentJournalTurnScopeSchema = z.object({
  kind: z.string().min(1),
  turnItemId: z.string().min(1).optional()
})

export const AgentJournalRenderItemSchema = z.object({
  itemId: z.string().min(1),
  revision: z.number().int(),
  body: AgentJournalItemBodySchema,
  sequence: z.number().int(),
  sequenceIndex: z.number().int().nonnegative().optional(),
  observedAt: z.number(),
  recovered: z.literal(true).optional(),
  recoveredAt: z.number().optional(),
  turnScope: AgentJournalTurnScopeSchema.optional(),
  ...AgentJournalProducerLinkageFields
})

export const AgentJournalSubmissionSchema = z.object({
  clientMessageId: z.string().min(1),
  fence: z.number().int(),
  payloadFingerprint: z.string(),
  dispatchState: z.string().min(1),
  providerItemId: z.string().nullable(),
  reason: z.string().nullable(),
  submittedAt: z.number(),
  resolvedAt: z.number().nullable(),
  recovered: z.literal(true).optional(),
  handoverRecorded: z.literal(true).optional(),
  handedOverAt: z.number().optional(),
  rejection: FailureFact.optional(),
  // Listed, or the parse strips it: this schema drops unknown keys.
  queuedMessageId: z.string().min(1).optional()
})

export function isAgentJournalResolution(value: unknown): value is AgentJournalResolution {
  return Resolution.safeParse(value).success
}

export function isAdmissibleAgentJournalItemBody(value: unknown): value is AgentJournalItemBody {
  return AgentJournalItemBodySchema.safeParse(value).success
}

/** Submission rows may only carry a user-authored message body. */
export function isAdmissibleAgentJournalMessageBody(
  value: unknown
): value is AgentJournalMessageItem {
  return AgentJournalMessageBodySchema.safeParse(value).success
}

export function isAdmissibleAgentJournalRenderItem(
  value: unknown
): value is AgentJournalRenderItem {
  return AgentJournalRenderItemSchema.safeParse(value).success
}

export function isAdmissibleAgentJournalSubmission(
  value: unknown
): value is AgentJournalSubmission {
  return AgentJournalSubmissionSchema.safeParse(value).success
}

/** Compile-time proof that every canonical value is admissible, so replay can
 *  never reject a row a writer in this build produced. The schemas are
 *  deliberately wider on open string fields, so only this direction holds. */
type Admits<T extends true> = T
export type CanonicalJournalTypesAreAdmissible = [
  Admits<AgentJournalItemBody extends z.input<typeof AgentJournalItemBodySchema> ? true : false>,
  Admits<
    AgentJournalMessageItem extends z.input<typeof AgentJournalMessageBodySchema> ? true : false
  >,
  Admits<
    AgentJournalRenderItem extends z.input<typeof AgentJournalRenderItemSchema> ? true : false
  >,
  Admits<AgentJournalSubmission extends z.input<typeof AgentJournalSubmissionSchema> ? true : false>
]

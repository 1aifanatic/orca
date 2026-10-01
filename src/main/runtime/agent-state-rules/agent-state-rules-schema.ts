import { z } from 'zod'
import type { RuntimeTerminalWaitBlockedReason } from '../../../shared/runtime-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { findUnsafePatternReason } from './agent-state-rule-pattern-safety'

/**
 * One file per agent (`<agent>.json` beside this schema). Every object is strict, so a misspelled
 * field rejects the file instead of silently dropping a condition. Adding a region, predicate or
 * answer bumps `engineVersion`.
 */
const AGENT_STATE_RULES_ENGINE_VERSION = 1

const MAX_PATTERN_LENGTH = 200
const MAX_RULES = 32
const MAX_ROWS = 12
const MAX_TERMS = 8

const Literal = z.string().min(1).max(MAX_PATTERN_LENGTH)

const SafeRegex = Literal.superRefine((pattern, ctx) => {
  const reason = findUnsafePatternReason(pattern)
  if (reason) {
    ctx.addIssue({ code: 'custom', message: `pattern ${reason}` })
  }
})

const TextTermSchema = z.union([
  z.object({ regex: SafeRegex, ignoreCase: z.boolean().optional() }).strict(),
  z.object({ contains: Literal }).strict()
])

const Terms = z.array(TextTermSchema).min(1).max(MAX_TERMS)

/** A test on one row or one text segment: a single term, or every `all`, some `any`, no `none`. */
const TextTestSchema = z.union([
  TextTermSchema,
  z
    .object({ all: Terms.optional(), any: Terms.optional(), none: Terms.optional() })
    .strict()
    .refine((test) => Boolean(test.all ?? test.any ?? test.none), 'needs all, any or none')
])

const RowSchema = z.union([TextTestSchema, z.object({ optional: TextTestSchema }).strict()])

/**
 * Consecutive trimmed screen rows, top-down. The block ends at the bottom-most row, among the last
 * `endsWithinBottom`, that passes the final test; a row above the screen reads as empty.
 */
const ScreenRowsSchema = z
  .object({
    rows: z.array(RowSchema).min(1).max(MAX_ROWS),
    endsWithinBottom: z.number().int().min(1).max(MAX_ROWS).optional(),
    noneAbove: TextTestSchema.optional()
  })
  .strict()
  .refine((block) => !('optional' in (block.rows.at(-1) ?? {})), 'the last row cannot be optional')

/** The evidence behind a rule, since JSON carries no comments. */
const Why = z.string().max(600).optional()

const RuleBase = {
  id: Literal,
  why: Why,
  /** Highest first; ties keep file order. */
  priority: z.number().int().min(0).max(1000),
  // Why screen only: title, text and status regions arrive with the agents that need them.
  region: z.literal('screen'),
  /** Absent, the rule fires whenever its region is readable. */
  match: ScreenRowsSchema.optional()
}

const AgentStateRuleSchema = z.discriminatedUnion('state', [
  z
    .object({
      ...RuleBase,
      state: z.literal('idle'),
      /** Strong settles a wait at once; weak only on the poll, once nothing stronger spoke. */
      strength: z.enum(['strong', 'weak']),
      /** Believed only after the output clock has been quiet (agents paint this mid-turn too). */
      requiresQuiet: z.boolean()
    })
    .strict(),
  // Why hold: the agent's own evidence was readable and said "not ready", which must also shut
  // the weak lanes (a name-only title or quiet process cannot see what the screen refused).
  z.object({ ...RuleBase, state: z.literal('hold') }).strict()
])

const NAMED_TEXT_ANCHORS = ['antigravity-text-composer'] as const

const AGENT_BLOCKED_REASONS = [
  'agent-update-prompt',
  'agent-trust-workspace',
  'agent-cwd-prompt',
  'agent-hooks-review-prompt',
  'agent-interactive-prompt',
  'agent-approval-prompt'
] as const satisfies readonly RuntimeTerminalWaitBlockedReason[]

const WithinLastLines = z.number().int().min(1).max(64).optional()

/**
 * Anchors read the lowercased text tail of every pane, whatever agent it runs: today a tail can
 * show another agent's dialog or prompt (an adopted pane has no known agent at all). They are
 * arbitrated by position, so each yields the index where it starts.
 */
const TextAnchorSchema = z.discriminatedUnion('state', [
  z
    .object({
      id: Literal,
      why: Why,
      state: z.literal('blocked'),
      reason: z.enum(AGENT_BLOCKED_REASONS),
      /** Lines counted from the end of the blocked layer's live window. */
      withinLastLines: WithinLastLines,
      lastOf: Literal,
      /** Over the window's lines, trailing blank lines dropped. */
      lines: z
        .object({
          atLeast: z.number().int().min(1).max(MAX_ROWS),
          includingLast: z.boolean(),
          test: TextTestSchema
        })
        .strict()
        .optional()
    })
    .strict(),
  z
    .object({
      id: Literal,
      why: Why,
      state: z.literal('idle'),
      find: z.union([
        z.object({ lastOf: Literal, followedBy: Literal.optional() }).strict(),
        z.object({ predicate: z.enum(NAMED_TEXT_ANCHORS) }).strict()
      ]),
      /** The prompt is live but busy when the text after it passes this test. */
      workingIfAfter: TextTestSchema.optional()
    })
    .strict()
])

export const AgentStateRulesFileSchema = z
  .object({
    id: z.custom<TuiAgent>(isTuiAgent, 'not a known agent'),
    engineVersion: z.literal(AGENT_STATE_RULES_ENGINE_VERSION),
    /** Text whose presence in a pane's tail makes a tui-idle wait read its visible screen once. */
    screenProbeBanner: Literal.optional(),
    textAnchors: z.array(TextAnchorSchema).max(MAX_RULES),
    rules: z.array(AgentStateRuleSchema).max(MAX_RULES)
  })
  .strict()

export type TextTest = z.infer<typeof TextTestSchema>
export type ScreenRows = z.infer<typeof ScreenRowsSchema>
export type AgentStateRule = z.infer<typeof AgentStateRuleSchema>
export type TextAnchor = z.infer<typeof TextAnchorSchema>
export type NamedTextAnchor = (typeof NAMED_TEXT_ANCHORS)[number]
export type AgentStateRulesFile = z.infer<typeof AgentStateRulesFileSchema>

// Reading a persisted body by the extension rule in agent-session-journal-schemas.ts: it parses
// (a body or block of a kind this build does not know included), or it holds a value outside a
// closed set this build knows (a newer build's), or it is damage.

import type { z } from 'zod'
import {
  AGENT_JOURNAL_ITEM_BODY_KINDS,
  AgentJournalItemBodySchema,
  isAdmissibleAgentJournalMessageBody
} from './agent-session-journal-schemas'

/** `unreadable` is never damage: the caller keeps the row and stops writing, as for a newer `v`. */
export type AgentJournalContentVerdict = 'readable' | 'unreadable' | 'malformed'

export function readAgentJournalItemBody(body: unknown): AgentJournalContentVerdict {
  return readAgentJournalContent(AgentJournalItemBodySchema, body)
}

/** The verdict for `value` against any journal schema, by the rule above. */
export function readAgentJournalContent(
  schema: z.ZodType,
  value: unknown
): AgentJournalContentVerdict {
  const parsed = schema.safeParse(value, { reportInput: true })
  if (parsed.success) {
    return 'readable'
  }
  // A newer build's value anywhere wins over damage beside it: never delete what it wrote.
  return parsed.error.issues.some(isOutsideClosedSet) ? 'unreadable' : 'malformed'
}

/** The same for a submission's body, which only a user message may be. What was sent stays a
 *  closed set: a kind this build does not know is a newer build's, never sent again here. */
export function readAgentJournalMessageBody(body: unknown): AgentJournalContentVerdict {
  const verdict = readAgentJournalItemBody(body)
  if (verdict !== 'readable' || isAdmissibleAgentJournalMessageBody(body)) {
    return verdict
  }
  const kind = typeof body === 'object' && body !== null && 'kind' in body ? body.kind : undefined
  return typeof kind === 'string' && kind !== '' && !AGENT_JOURNAL_ITEM_BODY_KINDS.has(kind)
    ? 'unreadable'
    : 'malformed'
}

/** A new string where a closed set of strings expects one of its own: the set's type, so never a
 *  changed one. zod reports every branch of a plain union only when each branch aborts; the body
 *  schemas' plain unions pair a discriminated union with an aborting open fallback
 *  (`openDiscriminatedUnion`), whose own failure is never a closed-set one. */
function isOutsideClosedSet(issue: z.core.$ZodIssue): boolean {
  if (issue.code === 'invalid_value') {
    return (
      issue.values.some((known) => typeof known === 'string') && isNewClosedSetValue(issue.input)
    )
  }
  if (issue.code === 'invalid_union') {
    if (issue.discriminator !== undefined) {
      return isPlainObject(issue.input) && isNewClosedSetValue(issue.input[issue.discriminator])
    }
    return issue.errors.some((branch) => branch.some(isOutsideClosedSet))
  }
  if (issue.code === 'invalid_key' || issue.code === 'invalid_element') {
    return issue.issues.some(isOutsideClosedSet)
  }
  return false
}

function isNewClosedSetValue(value: unknown): boolean {
  return typeof value === 'string' && value !== ''
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

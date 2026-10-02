// Reading a persisted item body, by the per-field rule in agent-session-journal-schemas.ts: a body
// is readable (perhaps less an annotation it could not parse), unreadable (a newer build's), or
// damage.

import { z } from 'zod'
import {
  dropUnreadableOptionalFacts,
  type AgentJournalOptionalFactPolicy
} from './agent-session-journal-optional-facts'
import {
  AgentJournalItemBodySchema,
  AgentJournalMessageBodySchema
} from './agent-session-journal-schemas'

/** `unreadable` is never damage: the caller keeps the row and stops writing, as for a newer `v`. */
export type AgentJournalContentVerdict = 'readable' | 'unreadable' | 'malformed'

/** Every body kind this build knows, read off the schema so the two can never disagree. */
const KNOWN_BODY_KINDS: ReadonlySet<string> = new Set(
  AgentJournalItemBodySchema.options.flatMap((option) => [...option.shape.kind.values])
)

const DROPPABLE: ReadonlySet<AgentJournalOptionalFactPolicy> = new Set(['droppable'])
const ANY_OPTIONAL: ReadonlySet<AgentJournalOptionalFactPolicy> = new Set([
  'droppable',
  'must-understand'
])

/** Reads an item body in place: an unparseable droppable fact is removed from it. */
export function readAgentJournalItemBody(body: unknown): AgentJournalContentVerdict {
  return readBody(AgentJournalItemBodySchema, body)
}

/** The same for a submission's body, which only a user message may be. */
export function readAgentJournalMessageBody(body: unknown): AgentJournalContentVerdict {
  return readBody(AgentJournalMessageBodySchema, body)
}

function readBody(schema: z.core.$ZodType, body: unknown): AgentJournalContentVerdict {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !('kind' in body)) {
    return 'malformed'
  }
  const { kind } = body
  if (typeof kind !== 'string' || kind === '') {
    return 'malformed'
  }
  if (!KNOWN_BODY_KINDS.has(kind)) {
    return 'unreadable'
  }
  if (z.safeParse(schema, body).success) {
    return 'readable'
  }
  dropUnreadableOptionalFacts(schema, body, DROPPABLE)
  if (z.safeParse(schema, body).success) {
    return 'readable'
  }
  // Without its must-understand facts it would read: only they failed, so it is a newer build's.
  const probe = structuredClone(body)
  dropUnreadableOptionalFacts(schema, probe, ANY_OPTIONAL)
  return z.safeParse(schema, probe).success ? 'unreadable' : 'malformed'
}

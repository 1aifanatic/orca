// What a persisted body does with an optional fact this build cannot parse. Every optional field
// of a journal body schema states it where the field is declared:
//
// - droppable: an annotation (a time, a display detail, a typed copy of what the row also says in
//   words). An unparseable one is removed from the row in memory, and the row reads as one written
//   before the field existed, which every reader already handles because older rows lack it.
// - must-understand: a fact a reader acts on (a prompt's questions, a turn's lifecycle). An
//   unparseable one makes the row unreadable: the chat latches read-only, as for a newer schema
//   version, and nothing is deleted.
//
// A required field that fails is damage, repaired as before. A key this build does not know is
// ignored and kept. `unclassifiedOptionalFacts` lets a test hold every optional field reachable
// from a body schema to one of the two policies.

import { z } from 'zod'

export type AgentJournalOptionalFactPolicy = 'droppable' | 'must-understand'

const POLICY_BY_FIELD = new WeakMap<object, AgentJournalOptionalFactPolicy>()

function classifiedFact<T extends z.ZodType>(
  schema: T,
  policy: AgentJournalOptionalFactPolicy
): z.ZodOptional<T> {
  const field = schema.optional()
  POLICY_BY_FIELD.set(field, policy)
  return field
}

/** An optional annotation: unparseable, it is dropped and the row keeps the rest. */
export function droppableFact<T extends z.ZodType>(schema: T): z.ZodOptional<T> {
  return classifiedFact(schema, 'droppable')
}

/** An optional fact a reader acts on: unparseable, it makes the row unreadable. */
export function mustUnderstandFact<T extends z.ZodType>(schema: T): z.ZodOptional<T> {
  return classifiedFact(schema, 'must-understand')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The union members `value` takes: a discriminated union's by its discriminator. A plain union's
 *  object members cannot be told apart, so only its discriminated members are walked. */
function unionMembersFor(schema: z.ZodUnion, value: unknown): readonly z.core.$ZodType[] {
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const discriminator = schema.def.discriminator
    if (!isPlainObject(value)) {
      return []
    }
    return schema.options.filter(
      (option) =>
        option instanceof z.ZodObject &&
        z.safeParse(option.shape[discriminator], value[discriminator]).success
    )
  }
  return schema.options.filter((option) => option instanceof z.ZodDiscriminatedUnion)
}

/**
 * Removes, in place, every optional fact under `schema` whose policy is in `policies` and whose
 * value fails its own schema. A droppable fact is judged whole; required fields and must-understand
 * facts are walked into first, so a broken annotation inside one goes and the fact stays.
 */
export function dropUnreadableOptionalFacts(
  schema: z.core.$ZodType,
  value: unknown,
  policies: ReadonlySet<AgentJournalOptionalFactPolicy>
): void {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    dropUnreadableOptionalFacts(schema.unwrap(), value, policies)
    return
  }
  if (schema instanceof z.ZodArray) {
    for (const element of Array.isArray(value) ? value : []) {
      dropUnreadableOptionalFacts(schema.element, element, policies)
    }
    return
  }
  if (schema instanceof z.ZodUnion) {
    for (const member of unionMembersFor(schema, value)) {
      dropUnreadableOptionalFacts(member, value, policies)
    }
    return
  }
  if (!(schema instanceof z.ZodObject) || !isPlainObject(value)) {
    return
  }
  for (const [key, field] of Object.entries(schema.shape)) {
    if (value[key] === undefined) {
      continue
    }
    const policy = POLICY_BY_FIELD.get(field)
    if (policy !== 'droppable') {
      dropUnreadableOptionalFacts(field, value[key], policies)
    }
    if (policy !== undefined && policies.has(policy) && !z.safeParse(field, value[key]).success) {
      delete value[key]
    }
  }
}

/** Paths of optional fields under `schema` that state no policy. Droppable facts are judged whole,
 *  so the fields inside one need none. */
export function unclassifiedOptionalFacts(schema: z.core.$ZodType, path = ''): string[] {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return unclassifiedOptionalFacts(schema.unwrap(), path)
  }
  if (schema instanceof z.ZodArray) {
    return unclassifiedOptionalFacts(schema.element, `${path}[]`)
  }
  if (schema instanceof z.ZodUnion) {
    return schema.options.flatMap((option, index) =>
      unclassifiedOptionalFacts(option, `${path}|${index}`)
    )
  }
  if (!(schema instanceof z.ZodObject)) {
    return []
  }
  return Object.entries(schema.shape).flatMap(([key, field]) => {
    const policy = POLICY_BY_FIELD.get(field)
    const fieldPath = path ? `${path}.${key}` : key
    if (policy === 'droppable') {
      return []
    }
    const inner = unclassifiedOptionalFacts(field, fieldPath)
    return field instanceof z.ZodOptional && policy === undefined ? [fieldPath, ...inner] : inner
  })
}

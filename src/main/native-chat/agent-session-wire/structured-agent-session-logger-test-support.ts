import type {
  StructuredAgentSessionLogFields,
  StructuredAgentSessionLogger
} from './structured-agent-session-logger'

export type RecordedStructuredAgentSessionLog = {
  level: keyof StructuredAgentSessionLogger
  message: string
  fields: StructuredAgentSessionLogFields
}

/** A logger that keeps every entry, for tests that assert a failure was reported. */
export function recordingStructuredAgentSessionLogger(): {
  logger: StructuredAgentSessionLogger
  entries: RecordedStructuredAgentSessionLog[]
  scopes: () => string[]
} {
  const entries: RecordedStructuredAgentSessionLog[] = []
  return {
    logger: {
      warn: (message, fields) => entries.push({ level: 'warn', message, fields }),
      error: (message, fields) => entries.push({ level: 'error', message, fields })
    },
    entries,
    scopes: () => entries.map((entry) => entry.fields.scope)
  }
}

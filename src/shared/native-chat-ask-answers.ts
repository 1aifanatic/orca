// Reads what a question tool recorded as data: each question's id and secrecy from
// the call, and the reader's answers from the result. Anything else yields no
// answers, so the ask row shows the questions alone rather than a guess.

const CODEX_NOTE_PREFIX = 'user_note: '

/**
 * Codex answers `request_user_input` with a JSON string keyed by each question's
 * id: `{"answers":{"<id>":{"answers":["<label>", "user_note: <typed>"]}}}`. A
 * refusal or an abort is plain text, and parses to null. A question the reader
 * left unanswered (an empty list) has no entry.
 */
export function codexAskAnswers(output: string): Map<string, string[]> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }
  const answers = isRecord(parsed) ? parsed.answers : null
  if (!isRecord(answers)) {
    return null
  }
  const byId = new Map<string, string[]>()
  for (const [id, entry] of Object.entries(answers)) {
    const list = isRecord(entry) ? entry.answers : null
    if (!Array.isArray(list)) {
      continue
    }
    const parts = list
      .filter((part): part is string => typeof part === 'string')
      // The prefix is Codex's marker for typed text; the reader never wrote it.
      .map((part) =>
        part.startsWith(CODEX_NOTE_PREFIX) ? part.slice(CODEX_NOTE_PREFIX.length) : part
      )
      .filter((part) => part.trim().length > 0)
    if (parts.length > 0) {
      byId.set(id, parts)
    }
  }
  return byId
}

/** The question objects of a call's payload, decoded as the card's parser does:
 *  Codex delivers its arguments as a JSON string. */
export function askPayloadQuestions(input: unknown): Record<string, unknown>[] {
  let decoded = input
  if (typeof input === 'string') {
    try {
      decoded = JSON.parse(input)
    } catch {
      return []
    }
  }
  const list = isRecord(decoded) ? decoded.questions : null
  return Array.isArray(list) ? list.filter(isRecord) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

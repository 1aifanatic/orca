// A provider's words for a person, quoted inside one of Orca's failure sentences: bounded so the
// sentence stays one, and never with a second stop after words that already end a sentence.

import type { ProviderDiagnostic } from './agent-session-failure'
import type {
  AgentSessionFailureCopyId,
  AgentSessionFailureCopyValues,
  AgentSessionFailureSay
} from './agent-session-failure-copy'

/** Person-facing provider text is quoted, but bounded so the sentence stays one. */
const MAX_QUOTED_DETAIL_CHARS = 512
const ENDS_A_SENTENCE = /[!?\u2026\u3002\uff01\uff1f\uff0e]$/

export function quotingPersonDetail(
  say: AgentSessionFailureSay,
  lead: AgentSessionFailureCopyId,
  quotedLead: AgentSessionFailureCopyId,
  detail: ProviderDiagnostic | undefined,
  values: AgentSessionFailureCopyValues = {}
): string {
  const quoted =
    detail?.audience === 'person'
      ? detail.text
          .slice(0, MAX_QUOTED_DETAIL_CHARS)
          .trim()
          .replace(/[.\s]+$/, '')
      : ''
  if (!quoted) {
    return say(lead, values)
  }
  const sentence = say(quotedLead, { ...values, detail: quoted })
  // A detail that already ends a sentence (or was cut short) takes no stop of the lead's after it.
  return ENDS_A_SENTENCE.test(quoted) && sentence.endsWith(`${quoted}${sentence.at(-1)}`)
    ? sentence.slice(0, -1)
    : sentence
}

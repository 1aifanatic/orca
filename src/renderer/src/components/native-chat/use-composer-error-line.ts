import { useCallback, useState } from 'react'
import type { StructuredAgentSessionCommandRefusalCause } from '../../../../shared/structured-agent-session-composer'
import type { StructuredConversationCommandCauses } from './structured-conversation-command-send'

type ComposerErrorLine = {
  text: string
  refusedWhile: StructuredAgentSessionCommandRefusalCause | undefined
}

/** The line under the composer. A command's refusal names what the chat shows it waiting on, so
 *  it goes once that is gone; any other error stays until the next send. */
export function useComposerErrorLine(
  causes: StructuredConversationCommandCauses
): [
  string | null,
  (text: string | null, refusedWhile?: StructuredAgentSessionCommandRefusalCause) => void
] {
  const [line, setLine] = useState<ComposerErrorLine | null>(null)
  const set = useCallback(
    (text: string | null, refusedWhile?: StructuredAgentSessionCommandRefusalCause) =>
      setLine(text === null ? null : { text, refusedWhile }),
    []
  )
  const stands = line !== null && (line.refusedWhile === undefined || causes[line.refusedWhile])
  // Dropped, not hidden: the cause coming back later is not what this refusal was about.
  if (line !== null && !stands) {
    setLine(null)
  }
  return [stands ? line.text : null, set]
}

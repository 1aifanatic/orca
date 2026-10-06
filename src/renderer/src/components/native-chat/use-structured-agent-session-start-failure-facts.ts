import { useEffect, useMemo, useRef } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import {
  sameAgentSessionFailureFact,
  structuredAgentSessionStartFailureFacts,
  type StatedStartFailure
} from './structured-agent-session-delivery-notices'

const NO_FACTS: readonly StatedStartFailure[] = []

/** What the loaded start-failure rows state, read only while `enabled`. Held while unchanged, so a
 *  streaming turn does not rebuild every row's delivery notice. */
export function useStructuredAgentSessionStartFailureFacts(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  enabled: boolean
): readonly StatedStartFailure[] {
  const facts = useMemo(
    () => (enabled ? structuredAgentSessionStartFailureFacts(items, submissions) : NO_FACTS),
    [enabled, items, submissions]
  )
  const previousRef = useRef<readonly StatedStartFailure[]>(NO_FACTS)
  const previous = previousRef.current
  const stable =
    previous.length === facts.length &&
    previous.every((stated, index) => {
      const next = facts[index]
      return (
        next !== undefined &&
        stated.itemId === next.itemId &&
        stated.covers.join('\n') === next.covers.join('\n') &&
        sameAgentSessionFailureFact(stated.fact, next.fact)
      )
    })
      ? previous
      : facts
  // Written after commit, so render stays pure.
  useEffect(() => {
    previousRef.current = stable
  }, [stable])
  return stable
}

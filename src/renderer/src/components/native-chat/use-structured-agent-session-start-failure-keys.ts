import { useEffect, useMemo, useRef } from 'react'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionStartFailureKeys } from './structured-agent-session-delivery-notices'

const NO_KEYS: readonly string[] = []

/** The starts the loaded start-failure rows are for, read only while `enabled`. Held while
 *  unchanged, so a streaming turn does not rebuild every row's delivery notice. */
export function useStructuredAgentSessionStartFailureKeys(
  items: readonly AgentJournalRenderItem[],
  enabled: boolean
): readonly string[] {
  const keys = useMemo(
    () => (enabled ? structuredAgentSessionStartFailureKeys(items) : NO_KEYS),
    [enabled, items]
  )
  const previousRef = useRef<readonly string[]>(NO_KEYS)
  const previous = previousRef.current
  const stable =
    previous.length === keys.length && previous.every((key, index) => key === keys[index])
      ? previous
      : keys
  // Written after commit, so render stays pure.
  useEffect(() => {
    previousRef.current = stable
  }, [stable])
  return stable
}

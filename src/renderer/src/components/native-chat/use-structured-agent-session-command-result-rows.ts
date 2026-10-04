import { useMemo } from 'react'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionCommandResultRows } from '../../../../shared/structured-agent-session-command-entry'

const NO_ROWS: ReadonlySet<string> = new Set()

/** The commands whose result row is loaded, read only while `enabled`. Held while unchanged, so a
 *  streaming turn does not rebuild every row's delivery notice. */
export function useStructuredAgentSessionCommandResultRows(
  items: readonly AgentJournalRenderItem[],
  enabled: boolean
): ReadonlySet<string> {
  const key = useMemo(
    () => (enabled ? [...structuredAgentSessionCommandResultRows(items)].sort().join('\0') : ''),
    [enabled, items]
  )
  return useMemo(() => (key === '' ? NO_ROWS : new Set(key.split('\0'))), [key])
}

import type { TerminalTab } from './terminal-tab-types'
import type { TerminalTopologyTabRow } from './terminal-topology-slice'

const OPTIONAL_ROW_FIELDS = [
  'launchAgent',
  'defaultTitle',
  'shellOverride',
  'startupCwd',
  'forceHostRuntime',
  'quickCommandLabel'
] as const satisfies readonly (keyof TerminalTopologyTabRow)[]

type _UnlistedRowField = Exclude<
  keyof TerminalTopologyTabRow,
  'id' | 'ptyId' | 'worktreeId' | 'createdAt' | (typeof OPTIONAL_ROW_FIELDS)[number]
>
void (true satisfies [_UnlistedRowField] extends [never] ? true : never)

/** `tab` with main's row fields; an optional one the row lacks is dropped, not kept from `tab`. */
export function withTopologyRow(tab: TerminalTab, row: TerminalTopologyTabRow): TerminalTab {
  const next: TerminalTab = { ...tab, ...row }
  for (const field of OPTIONAL_ROW_FIELDS) {
    if (!(field in row)) {
      delete next[field]
    }
  }
  return next
}

// The row kinds this build knows, and what a build that predates each does with it. When a kind
// may be declared skippable is the contract in `journal-row-schema.ts`'s header.

import type { JournalRow } from './journal-row-schema'

/** What a row's writer declares, as `ifUnknown`, a build that does not know its kind does with it.
 *  Persisted: never rename a value. */
export const JOURNAL_ROW_IF_UNKNOWN = ['skip', 'carry'] as const
/** `skip`: read past it, and a rewrite drops it. `carry`: read past it, and a rewrite carries it. */
export type JournalRowIfUnknown = (typeof JOURNAL_ROW_IF_UNKNOWN)[number]

/** How each kind reads on an older supported build: `read` (every supported build knows it), its
 *  rows' declared `ifUnknown`, or `read-only`. A new kind must say. */
const JOURNAL_ROW_KIND_ON_OLDER_BUILDS: Record<
  JournalRow['kind'],
  'read' | 'read-only' | JournalRowIfUnknown
> = {
  epoch: 'read',
  item: 'read',
  tombstone: 'read',
  submission: 'read',
  dispatch: 'read',
  'lifecycle-batch': 'read'
}

export const JOURNAL_ROW_KINDS: ReadonlySet<string> = new Set(
  Object.keys(JOURNAL_ROW_KIND_ON_OLDER_BUILDS)
)

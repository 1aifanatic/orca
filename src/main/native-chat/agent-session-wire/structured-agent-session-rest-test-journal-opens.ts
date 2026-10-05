// Each rest rig's journal opens, seen at the store's open: the open counter the rest tests read, and
// a hook a test can hold to hold the open.

import { resolve } from 'node:path'
import { vi } from 'vitest'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'

// Each rig's open hook, by its state directory: one spy on the store's open serves every rig.
const openHooks = new Map<string, (sessionId: string) => Promise<void>>()

/** Where a journal opens: its chat and the state directory of its database. */
type JournalOpenSite = { sessionId: string; directory: string }

/** The store keeps both privately; read as the plain fields they are at runtime. */
function journalOpenSite(journal: unknown): JournalOpenSite | null {
  if (
    typeof journal !== 'object' ||
    journal === null ||
    !('identity' in journal) ||
    !('database' in journal)
  ) {
    return null
  }
  const { identity, database } = journal
  if (
    typeof identity !== 'object' ||
    identity === null ||
    !('sessionId' in identity) ||
    typeof identity.sessionId !== 'string' ||
    typeof database !== 'object' ||
    database === null ||
    !('stateDirectory' in database) ||
    typeof database.stateDirectory !== 'string'
  ) {
    return null
  }
  return { sessionId: identity.sessionId, directory: database.stateDirectory }
}

export function watchRestTestJournalOpens(
  root: string,
  hook: (sessionId: string) => Promise<void>
): void {
  openHooks.set(resolve(root), hook)
  if (vi.isMockFunction(AgentSessionJournal.prototype.open)) {
    return
  }
  const open = AgentSessionJournal.prototype.open
  vi.spyOn(AgentSessionJournal.prototype, 'open').mockImplementation(async function (
    this: AgentSessionJournal
  ) {
    const site = journalOpenSite(this)
    const hook = site ? openHooks.get(resolve(site.directory)) : undefined
    if (site && hook) {
      await hook(site.sessionId)
    }
    return open.call(this)
  })
}

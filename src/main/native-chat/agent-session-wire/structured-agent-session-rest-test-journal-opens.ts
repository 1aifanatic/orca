// Each rest rig's journal opens, seen at the store's open: the open counter the rest tests read, and
// a hook a test can hold to hold the open.

import { resolve } from 'node:path'
import { vi } from 'vitest'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'

// Each rig's open hook, by its state directory: one spy on the store's open serves every rig.
const openHooks = new Map<string, (sessionId: string) => Promise<void>>()

function stringField(value: unknown, key: string): string | null {
  const field: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, key) : null
  return typeof field === 'string' ? field : null
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
    const directory = stringField(Reflect.get(this, 'database'), 'stateDirectory')
    const sessionId = stringField(Reflect.get(this, 'identity'), 'sessionId')
    const hook = directory === null ? undefined : openHooks.get(resolve(directory))
    if (hook && sessionId !== null) {
      await hook(sessionId)
    }
    return open.call(this)
  })
}

// Damage SQLite reports in the middle of a session: the write that meets it fails and says the
// chat cannot be loaded, the agent can still be stopped, and nothing is renamed or rebuilt.

import { readdir } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import { hostTestMessage } from './structured-agent-session-host-test-data'

let root: string
let host: StructuredAgentSessionHost
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>

beforeEach(() => {
  ;({ root, host, cancelTurn } = hostTestState())
})

afterEach(() => vi.restoreAllMocks())

// T-corrupt-midsession.
it('refuses a send as corrupt when SQLite reports damage, and still stops the agent', async () => {
  await attach()
  const files = await readdir(root, { recursive: true })
  const damaged = Object.assign(new Error('database disk image is malformed'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 11
  })
  // The damage is in the history's pages; the ownership rows beside it still read and write.
  const database = openTestJournalHostDatabase(root)
  const transaction = database.transaction.bind(database)
  vi.spyOn(database, 'transaction').mockImplementation(<T>(run: (db: Database.Database) => T) =>
    transaction((db) =>
      run(
        new Proxy(db, {
          get: (target, property) =>
            property === 'prepare'
              ? (sql: string) => {
                  if (!sql.includes('agent_session_')) {
                    throw damaged
                  }
                  return target.prepare(sql)
                }
              : Reflect.get(target, property, target)
        })
      )
    )
  )
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  const body = hostTestMessage('after the damage')
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })

  expect(sent).toMatchObject({
    ok: false,
    refusal: {
      code: 'agent_session_journal_unreadable',
      message: 'Unable to load this chat.',
      details: { reason: 'journalCorrupt' }
    }
  })
  // Stop reaches the agent before it writes anything; the note it then cannot record is the
  // error the caller sees, after the fact.
  await expect(
    host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', { turnId: 'turn-1' }),
      turnId: 'turn-1'
    })
  ).rejects.toBe(damaged)
  expect(cancelTurn).toHaveBeenCalledTimes(1)
  // A recovery-offer read still in flight holds its lock for a moment; nothing else may appear.
  await vi.waitFor(async () => expect(await readdir(root, { recursive: true })).toEqual(files))
})

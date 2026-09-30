// A Stop's interrupt never waits on the journal. Its withdrawal and its queue pause are bookkeeping:
// one that throws is reported and the Stop still interrupts. Its writes may wait behind owed work;
// they are issued, and the interrupt goes out before they land.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'

let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>
let warned: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  ;({ host, acquire, cancelTurn } = hostTestState())
  warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function runningTurn(): Promise<AgentSessionJournal> {
  await attach()
  acquire.mock.calls
    .at(-1)![0]
    .events!.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 900 },
      { kind: 'turn', turnId: 'turn-1', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  const journal = host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!journal) {
    throw new Error('no open journal')
  }
  // The turn row landed when the provider's event was handed over.
  expect(journal.activeTurnId()).toBe('turn-1')
  return journal
}

function stop(fields: { turnId?: string }) {
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', fields), ...fields })
}

const MALFORMED = 'database disk image is malformed'

describe.each([
  ['naming no turn', {}],
  ['naming its turn', { turnId: 'turn-1' }]
])('a Stop %s', (_label, fields) => {
  it('interrupts when withdrawing the queued sends throws, and reports it', async () => {
    const journal = await runningTurn()
    vi.spyOn(journal, 'rejectQueuedSubmissions').mockImplementation(() => {
      throw new Error(MALFORMED)
    })

    expect(await stop(fields)).toMatchObject({ ok: true })
    expect(cancelTurn).toHaveBeenCalledOnce()
    expect(warned).toHaveBeenCalledWith(
      "[agent-session] Stop's withdrawal skipped:",
      expect.objectContaining({ error: MALFORMED })
    )
  })

  it('interrupts when recording its queue pause throws, and reports it', async () => {
    const journal = await runningTurn()
    vi.spyOn(journal.queuedMessages, 'recordPause').mockImplementation(() => {
      throw new Error(MALFORMED)
    })

    expect(await stop(fields)).toMatchObject({ ok: true })
    expect(cancelTurn).toHaveBeenCalledOnce()
    expect(warned).toHaveBeenCalledWith(
      "[agent-session] Stop's queue pause skipped:",
      expect.objectContaining({ error: MALFORMED })
    )
  })

  // The open pays an import owed before the Stop, so the work falls owed at the Stop's first write:
  // the one moment the Stop's own writes can wait behind it.
  it('interrupts before owed work its writes wait behind is paid', async () => {
    const journal = await runningTurn()
    const owed = Promise.withResolvers<void>()
    const withdraw = journal.rejectQueuedSubmissions.bind(journal)
    vi.spyOn(journal, 'rejectQueuedSubmissions').mockImplementation((...args) => {
      journal['queue'].owe(() => owed.promise)
      return withdraw(...args)
    })
    let answered = false
    const stopping = stop(fields).finally(() => {
      answered = true
    })
    try {
      await vi.waitFor(() => expect(cancelTurn).toHaveBeenCalledOnce())
      expect(journal.importPending).toBe(true)
      expect(answered).toBe(false)
    } finally {
      owed.resolve()
    }
    expect(await stopping).toMatchObject({ ok: true })
    expect(journal.importPending).toBe(false)
  })
})

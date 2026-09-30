// A /compact pressed again under its own id, as every press now is, is answered from the /compact
// it repeats: joined while that one waits or runs, answered once it compacted, and run again only
// once anything newer happened or that one did not compact.

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  adapter,
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { startAgent } from './structured-agent-session-restart-interruption-test-harness'

let state: ReturnType<typeof hostTestState>
let compact: Mock<NonNullable<StructuredAgentSessionAdapter['compact']>>

beforeEach(() => {
  state = hostTestState()
  compact = vi.fn(async () => ({ state: 'accepted' as const, providerIdentity: null }))
  Object.assign(state.host.deps.adapter, { compact, closeSession: vi.fn(async () => true) })
})

const compactPress = () => ({
  command: 'compact' as const,
  envelope: envelope('agentSession.conversationCommand', { command: 'compact' })
})

/** The provider ends the command, as its translator writes it. */
function finish(outcome: 'success' | 'failure'): void {
  const { command } = compact.mock.calls.at(-1)![0]
  const events = state.acquire.mock.calls.at(-1)![0].events!
  const turnScope = { kind: 'turn' as const, turnItemId: agentJournalItemKey(command.identity) }
  events.appendLifecycleBatch!(
    `turn-completed:${command.clientMessageId}`,
    [
      {
        kind: 'item',
        identity: command.resultIdentity,
        body:
          outcome === 'success'
            ? { kind: 'status', text: 'Context compacted', presentation: 'compaction' }
            : { kind: 'status', text: 'Compaction failed.', tone: 'error' },
        turnScope
      },
      {
        kind: 'item',
        identity: command.identity,
        body: { ...command.running, state: 'completed', outcome, completedAt: HOST_TEST_NOW },
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ],
    { lifecycle: true }
  )
}

/** The command's turn as the journal reads it. */
async function commandTurnState(): Promise<string | undefined> {
  const { command } = compact.mock.calls.at(-1)![0]
  const items = (await state.host.journalSnapshot(SESSION)).items
  return readAgentJournalTurn(
    items.find((item) => item.itemId === agentJournalItemKey(command.identity))?.body
  )?.state
}

async function ended(outcome: 'success' | 'failure'): Promise<void> {
  finish(outcome)
  await vi.waitFor(async () => expect(await commandTurnState()).toBe('completed'))
}

async function compacted(): Promise<void> {
  expect(await state.host.conversationCommand(CALLER, compactPress())).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce())
  await ended('success')
}

/** Long enough for the delivery loop to have handed a /compact over, had it accepted one. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

describe('a /compact pressed again', () => {
  it('while the first is still on its way, joins it: one run and no refusal', async () => {
    await attach()
    const [first, second] = await Promise.all([
      state.host.conversationCommand(CALLER, compactPress()),
      state.host.conversationCommand(CALLER, compactPress())
    ])
    expect(first).toMatchObject({ ok: true, value: { command: 'compact', state: 'completed' } })
    expect(second).toMatchObject({ ok: true, value: { command: 'compact', state: 'completed' } })
    await settle()
    expect(compact).toHaveBeenCalledOnce()
  })

  it('while the first runs, answers with it instead of refusing', async () => {
    await attach()
    await state.host.conversationCommand(CALLER, compactPress())
    await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce())

    expect(await state.host.conversationCommand(CALLER, compactPress())).toMatchObject({
      ok: true,
      value: { command: 'compact', state: 'completed' }
    })
    await settle()
    expect(compact).toHaveBeenCalledOnce()
  })

  it('after the first compacted with nothing newer, answers with it and runs nothing', async () => {
    await attach()
    await compacted()

    expect(await state.host.conversationCommand(CALLER, compactPress())).toMatchObject({
      ok: true,
      value: { command: 'compact', state: 'completed' }
    })
    await settle()
    expect(compact).toHaveBeenCalledOnce()
  })

  it('reads the earlier /compact from the journal, so a restarted host answers the same', async () => {
    const { root, store } = state
    await attach()
    await compacted()
    await store.renewLeases([])
    const relaunchedStore = await openTestAgentSessionRecordStore(root)
    const relaunched = new StructuredAgentSessionHost({
      store: relaunchedStore,
      adapter: { ...adapter(), compact },
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-next',
      probeOwner: async () => ({ outcome: 'pid-absent' }),
      now: () => HOST_TEST_NOW + 1
    })
    await relaunched.reconcileRestartLeases()
    replaceHostTestState({ store: relaunchedStore, host: relaunched })
    await startAgent({ host: relaunched, store: relaunchedStore })

    expect(await relaunched.conversationCommand(CALLER, compactPress())).toMatchObject({
      ok: true,
      value: { command: 'compact', state: 'completed' }
    })
    await settle()
    expect(compact).toHaveBeenCalledOnce()
  })

  it('runs again once a newer message was sent', async () => {
    await attach()
    await compacted()
    const body = hostTestMessage('after the compaction')
    await state.host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    await vi.waitFor(() => expect(state.dispatch).toHaveBeenCalledOnce())

    expect(await state.host.conversationCommand(CALLER, compactPress())).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(2))
  })

  it('runs again when the first did not compact', async () => {
    await attach()
    expect(await state.host.conversationCommand(CALLER, compactPress())).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce())
    await ended('failure')

    expect(await state.host.conversationCommand(CALLER, compactPress())).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(2))
  })

  it("does not join another window's /compact, or a /clear pressed while one runs", async () => {
    await attach()
    await state.host.conversationCommand(CALLER, compactPress())
    await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce())

    expect(
      await state.host.conversationCommand({ callerKey: 'mobile' }, compactPress())
    ).toMatchObject({ ok: false, refusal: { details: { reason: 'turnActive' } } })
    expect(
      await state.host.conversationCommand(CALLER, {
        command: 'clear',
        envelope: envelope('agentSession.conversationCommand', { command: 'clear' })
      })
    ).toMatchObject({ ok: false, refusal: { details: { reason: 'turnActive' } } })
    expect(compact).toHaveBeenCalledOnce()
  })
})

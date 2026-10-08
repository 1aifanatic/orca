import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import { codexStreamingJournalItem } from '../../codex/codex-structured-item-translation'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  completedStructuredAgentTurnSeconds,
  selectStructuredAgentTurnTimings
} from '../../../shared/structured-agent-session-turn-timing'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { HOST_TEST_NOW, hostTestAttachParams } from './structured-agent-session-host-test-data'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  restTestSend,
  REST_TEST_SESSION as SESSION,
  REST_TEST_THREAD as THREAD,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'

const LAST_CHUNK_AT = HOST_TEST_NOW + 5_500
const RESTARTED_AT = HOST_TEST_NOW + 3_600_000
const TURN = { provider: 'codex' as const, threadId: THREAD, turnId: 'stream-turn', ordinal: 0 }
const REPLY = { ...TURN, ordinal: 1 }
const TURN_SCOPE = { kind: 'turn' as const, turnItemId: agentJournalItemKey(TURN) }

let rig: RestTestRig

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rig.dispose()
  closeTestJournalHostDatabases()
})

/** Drops the old host without an exit callback or graceful turn settlement. */
async function restartAfterCrash(): Promise<void> {
  const old = rig.host
  old.stopDelivery()
  const { lifetime, runtimeState, sessions } = old.collaboratorsForTests()
  lifetime.idleSweep.dispose()
  await runtimeState.stopLeaseRenewal()
  runtimeState.currentEventSink(SESSION)?.close()
  await sessions.get(SESSION)?.journal.close()
  closeTestJournalHostDatabases()
  rig.store = await openTestAgentSessionRecordStore(rig.root)
  rig.host = new StructuredAgentSessionHost({
    ...old.deps,
    store: rig.store,
    journalDatabase: openTestJournalHostDatabase(rig.root),
    now: () => RESTARTED_AT
  })
}

async function beginTurn() {
  const attached = await rig.host.attach(REST_TEST_CALLER, hostTestAttachParams(null))
  if (!attached.ok) {
    throw new Error('attach refused')
  }
  const sent = await rig.host.send(REST_TEST_CALLER, restTestSend('review', attached.fence))
  if (!sent.ok) {
    throw new Error('send refused')
  }
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
  const events = rig.adapter.acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('event sink absent')
  }
  events.appendItem(
    TURN,
    { kind: 'turn', turnId: TURN.turnId, state: 'running', startedAt: HOST_TEST_NOW },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE, observedAt: HOST_TEST_NOW }
  )
  return events
}

async function expectInterruptedOutput(): Promise<void> {
  await restartAfterCrash()
  await rig.host.restoreReadableSessions()
  const snapshot = await rig.host.journalSnapshot(SESSION)
  const turn = snapshot.items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)
  expect(turn).toMatchObject({ state: 'interrupted', completedAt: LAST_CHUNK_AT })
}

describe('provider output survives host restart', () => {
  it.each([
    ['agentMessage', 'item/agentMessage/delta'],
    ['fileChange', 'item/fileChange/outputDelta'],
    ['plan', 'item/plan/delta'],
    ['reasoning', 'item/reasoning/textDelta'],
    ['commandExecution', 'item/commandExecution/outputDelta']
  ] as const)('times actual Codex %s deltas rather than item start', async (type, method) => {
    const events = await beginTurn()
    let receivedAt = HOST_TEST_NOW
    vi.spyOn(Date, 'now').mockImplementation(() => receivedAt)
    const translator = createCodexJournalTranslator({
      sink: events,
      primaryThreadId: () => THREAD,
      now: () => receivedAt,
      schedule: () => () => {}
    })
    translator.handle({
      type: 'notification',
      sessionId: SESSION,
      threadId: THREAD,
      method: 'turn/started',
      params: { turn: { id: TURN.turnId } },
      observedAt: receivedAt
    })
    translator.handle({
      type: 'notification',
      sessionId: SESSION,
      threadId: THREAD,
      method: 'item/started',
      params: {
        turnId: TURN.turnId,
        item: {
          id: 'actual-reply',
          type,
          text: '',
          command: 'echo stream',
          status: 'inProgress',
          changes: [{ path: 'file.ts' }]
        }
      },
      observedAt: receivedAt
    })
    for (let chunk = 1; chunk <= 11; chunk += 1) {
      receivedAt = HOST_TEST_NOW + chunk * 500
      expect(
        translator.handle({
          type: 'notification',
          sessionId: SESSION,
          threadId: THREAD,
          method,
          params: {
            turnId: TURN.turnId,
            itemId: 'actual-reply',
            delta: `actual chunk ${chunk} `.repeat(4)
          },
          observedAt: receivedAt
        })
      ).toMatchObject({ accepted: true })
      translator.flush()
      await rig.host.flushStreamedEvents(SESSION)
    }
    translator.dispose()
    const before = await rig.host.journalSnapshot(SESSION)
    const output = before.items.find((item) =>
      JSON.stringify(item.body).includes('actual chunk 11')
    )
    expect(output?.observedAt).toBe(HOST_TEST_NOW)
    await restartAfterCrash()
    await rig.host.restoreReadableSessions()
    const snapshot = await rig.host.journalSnapshot(SESSION)
    const turn = snapshot.items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)
    expect(turn).toMatchObject({ state: 'interrupted', completedAt: LAST_CHUNK_AT })
  })

  it('counts streamed file-change output as later proof of provider life', async () => {
    const events = await beginTurn()
    for (let chunk = 1; chunk <= 11; chunk += 1) {
      const translated = codexStreamingJournalItem(
        { id: 'file-change-1', type: 'fileChange', changes: [{ path: 'file.ts' }] },
        `patch chunk ${chunk}`
      )
      if (!translated.body) {
        throw new Error('file change was not translated')
      }
      events.appendItem(REPLY, translated.body, {
        turnScope: TURN_SCOPE,
        observedAt: HOST_TEST_NOW + chunk * 500
      })
      await rig.host.flushStreamedEvents(SESSION)
    }
    expect(rig.store.getRecord(SESSION)?.lease.lastRenewedAt).toBe(HOST_TEST_NOW)
    await restartAfterCrash()
    await rig.host.restoreReadableSessions()
    const snapshot = await rig.host.journalSnapshot(SESSION)
    const turn = snapshot.items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)
    expect(turn).toMatchObject({ state: 'interrupted', completedAt: LAST_CHUNK_AT })
  })

  it('keeps a delayed first checkpoint at item start without counting a later flush', async () => {
    const events = await beginTurn()
    const translator = createCodexJournalTranslator({
      sink: events,
      primaryThreadId: () => THREAD,
      schedule: () => () => {}
    })
    translator.handle({
      type: 'notification',
      sessionId: SESSION,
      threadId: THREAD,
      method: 'turn/started',
      params: { turn: { id: TURN.turnId } },
      observedAt: HOST_TEST_NOW
    })
    translator.handle({
      type: 'notification',
      sessionId: SESSION,
      threadId: THREAD,
      method: 'item/started',
      params: { turnId: TURN.turnId, item: { id: 'late-first', type: 'agentMessage', text: '' } },
      observedAt: HOST_TEST_NOW
    })
    translator.handle({
      type: 'notification',
      sessionId: SESSION,
      threadId: THREAD,
      method: 'item/agentMessage/delta',
      params: { turnId: TURN.turnId, itemId: 'late-first', delta: 'first durable output' },
      observedAt: LAST_CHUNK_AT
    })
    vi.spyOn(Date, 'now').mockReturnValue(RESTARTED_AT - 1_000)
    translator.flush()
    await rig.host.flushStreamedEvents(SESSION)
    translator.dispose()
    const before = await rig.host.journalSnapshot(SESSION)
    expect(
      before.items.find((item) => JSON.stringify(item.body).includes('first durable output'))
        ?.observedAt
    ).toBe(HOST_TEST_NOW)
    await expectInterruptedOutput()
  })

  it.each(['text_delta', 'thinking_delta'] as const)(
    'times delayed Claude %s checkpoints',
    async (type) => {
      const events = await beginTurn()
      const translator = createClaudeJournalTranslator({ sink: events, schedule: () => () => {} })
      for (let chunk = 0; chunk <= 11; chunk += 1) {
        translator.handle({
          type: 'message',
          sessionId: SESSION,
          observedAt: HOST_TEST_NOW + chunk * 500,
          message: {
            type: 'stream_event',
            uuid: 'stream-frame',
            session_id: 'claude-provider',
            parent_tool_use_id: null,
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type, text: `text chunk ${chunk} `, thinking: `thought chunk ${chunk} ` }
            }
          }
        })
      }
      vi.spyOn(Date, 'now').mockReturnValue(RESTARTED_AT - 1_000)
      translator.flush()
      await rig.host.flushStreamedEvents(SESSION)
      translator.dispose()
      const before = await rig.host.journalSnapshot(SESSION)
      const output = before.items.find((item) => JSON.stringify(item.body).includes('chunk 11'))
      expect(output).toBeDefined()
      if (type === 'thinking_delta') {
        expect(output?.observedAt).toBe(HOST_TEST_NOW)
      }
      await expectInterruptedOutput()
    }
  )

  it('counts a synthetic provider fallback while excluding a later host notice', async () => {
    const events = await beginTurn()
    events.appendItem(
      { provider: 'orca', clientMessageId: 'provider-fallback' },
      { kind: 'status', text: 'provider output' },
      { turnScope: TURN_SCOPE, providerObservedAt: LAST_CHUNK_AT }
    )
    await rig.host.flushStreamedEvents(SESSION)
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
    if (!journal) {
      throw new Error('journal absent')
    }
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'host-notice' },
      { kind: 'status', text: 'host notice' },
      { fence: 1, turnScope: TURN_SCOPE, observedAt: RESTARTED_AT - 1_000 }
    )
    await expectInterruptedOutput()
  })

  it('counts a pending approval with no assistant output before the crash', async () => {
    const events = await beginTurn()
    events.appendItem(
      REPLY,
      {
        kind: 'approval',
        title: 'Run?',
        detail: null,
        options: [],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { turnScope: TURN_SCOPE, observedAt: LAST_CHUNK_AT }
    )
    await rig.host.flushStreamedEvents(SESSION)
    await restartAfterCrash()
    await rig.host.restoreReadableSessions()
    const snapshot = await rig.host.journalSnapshot(SESSION)
    const turn = snapshot.items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)
    expect(turn).toMatchObject({ state: 'interrupted', completedAt: LAST_CHUNK_AT })
    expect(snapshot.items.find((item) => item.body.kind === 'approval')?.body).toMatchObject({
      resolution: { state: 'cancelled' }
    })
    const [timing] = selectStructuredAgentTurnTimings(snapshot.items).values()
    expect(completedStructuredAgentTurnSeconds(timing)).toBe(5)
  })

  it('cannot record interruption from a surviving owner before exit proof', async () => {
    const events = await beginTurn()
    events.appendItem(
      REPLY,
      { kind: 'status', text: 'working' },
      { turnScope: TURN_SCOPE, observedAt: LAST_CHUNK_AT }
    )
    await rig.host.flushStreamedEvents(SESSION)
    await restartAfterCrash()
    rig.host.deps.probeOwner = async () => ({
      outcome: 'identity-matched',
      matchedOn: ['process-start-time']
    })
    const stopOwnerProcess = vi.fn()
    rig.host.deps.stopOwnerProcess = stopOwnerProcess
    await rig.host.reconcileRestartLeases()
    const snapshot = await rig.host.journalSnapshot(SESSION)
    const turn = snapshot.items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)
    expect(turn?.state).toBe('unverifiable')
    expect(turn?.completedAt).toBeUndefined()
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(rig.store.getRecord(SESSION)?.lease.deathEvidence).toBeFalsy()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { JsonlRpcTimelineLane } from '../../jsonl-rpc/timeline-lane'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createProviderTimelineAssembler } from '../agent-session-timeline/provider-timeline-assembler'
import { refusingSink } from '../agent-session-timeline/provider-timeline-assembler-test-support'
import { providerTimelineSink } from '../agent-session-timeline/provider-timeline-plan'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { HOST_TEST_NOW, hostTestAttachParams } from './structured-agent-session-host-test-data'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  restTestSend,
  REST_TEST_SESSION as SESSION,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'

const LAST_OUTPUT_AT = HOST_TEST_NOW + 5_500
const FLUSHED_AT = HOST_TEST_NOW + 60_000
const RESTARTED_AT = HOST_TEST_NOW + 3_600_000
let rig: RestTestRig

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rig.dispose()
  closeTestJournalHostDatabases()
})

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

async function providerSink() {
  const attached = await rig.host.attach(REST_TEST_CALLER, hostTestAttachParams(null))
  if (!attached.ok) {
    throw new Error('attach refused')
  }
  const sent = await rig.host.send(REST_TEST_CALLER, restTestSend('stream', attached.fence))
  if (!sent.ok) {
    throw new Error('send refused')
  }
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
  const events = rig.adapter.acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('provider sink missing')
  }
  const sink = providerTimelineSink(events)
  if (!sink) {
    throw new Error('timeline sink missing')
  }
  return sink
}

async function expectInterruptedAt(at: number): Promise<void> {
  await restartAfterCrash()
  await rig.host.restoreReadableSessions()
  const snapshot = await rig.host.journalSnapshot(SESSION)
  const turn = snapshot.items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)
  expect(turn).toMatchObject({ state: 'interrupted', completedAt: at })
}

describe('shared provider timeline receipt before coalescing', () => {
  it.each([
    ['assistant', 'flush'],
    ['reasoning', 'flush'],
    ['assistant', 'window'],
    ['reasoning', 'window']
  ] as const)(
    'ends a crashed %s stream at its last delta rather than a delayed %s',
    async (channel, trigger) => {
      const sink = await providerSink()
      let receivedAt = HOST_TEST_NOW
      vi.spyOn(Date, 'now').mockImplementation(() => receivedAt)
      let window = () => {}
      const timeline = createProviderTimelineAssembler({
        sink,
        sessionId: SESSION,
        agent: 'opencode',
        generation: 'review-generation',
        namespace: 'review-acp',
        schedule: (run) => {
          window = run
          return () => {}
        }
      })
      expect(
        timeline.apply({ type: 'turn.open', turn: 'timeline-turn', at: HOST_TEST_NOW })
      ).toMatchObject({ admission: { accepted: true } })
      await rig.host.flushStreamedEvents(SESSION)
      for (let chunk = 1; chunk <= 11; chunk += 1) {
        receivedAt = HOST_TEST_NOW + chunk * 500
        expect(
          timeline.apply({
            type: 'text.delta',
            item: { stream: 'reply' },
            channel,
            text: `chunk ${chunk} `,
            join: { turn: 'timeline-turn' }
          })
        ).toMatchObject({ admission: { accepted: true } })
      }
      receivedAt = FLUSHED_AT
      if (trigger === 'window') {
        window()
      } else {
        timeline.flush()
      }
      await rig.host.flushStreamedEvents(SESSION)
      timeline.dispose()
      const before = await rig.host.journalSnapshot(SESSION)
      const reply = before.items.find((item) => JSON.stringify(item.body).includes('chunk 11'))
      expect(reply?.observedAt).toBe(HOST_TEST_NOW + 500)
      expect(rig.store.getRecord(SESSION)?.lease.lastRenewedAt).toBe(HOST_TEST_NOW)

      await expectInterruptedAt(LAST_OUTPUT_AT)
    }
  )

  it.each(['assistant', 'reasoning'] as const)(
    'retains held %s delta receipts across lane and coalescer retries',
    async (channel) => {
      const sink = await providerSink()
      let receivedAt = HOST_TEST_NOW
      vi.spyOn(Date, 'now').mockImplementation(() => receivedAt)
      let blocked = true
      const lane = new JsonlRpcTimelineLane({
        sink: refusingSink(sink, () => blocked),
        sessionId: SESSION,
        agent: 'pi',
        generation: 'receipt-generation',
        namespace: 'receipt-pi',
        pauseReading: vi.fn(),
        resumeReading: vi.fn(),
        onInputAccepted: vi.fn(),
        onFailed: vi.fn()
      })
      try {
        lane.apply([{ type: 'turn.open', turn: 'held-turn', at: HOST_TEST_NOW }])
        for (let chunk = 1; chunk <= 11; chunk += 1) {
          receivedAt = HOST_TEST_NOW + chunk * 500
          lane.apply([
            {
              type: 'text.delta',
              item: { stream: 'reply' },
              channel,
              text: `held chunk ${chunk} `,
              join: { turn: 'held-turn' }
            }
          ])
        }
        receivedAt = FLUSHED_AT
        blocked = false
        lane.retry()
        blocked = true
        lane.flush()
        await rig.host.flushStreamedEvents(SESSION)
        const refused = await rig.host.journalSnapshot(SESSION)
        expect(refused.items.some((item) => JSON.stringify(item.body).includes('held chunk'))).toBe(
          false
        )
        receivedAt += 60_000
        blocked = false
        lane.flush()
        await rig.host.flushStreamedEvents(SESSION)
        const before = await rig.host.journalSnapshot(SESSION)
        const reply = before.items.find((item) =>
          JSON.stringify(item.body).includes('held chunk 11')
        )
        expect(reply?.observedAt).toBe(HOST_TEST_NOW + 500)
      } finally {
        lane.dispose()
      }
      await expectInterruptedAt(LAST_OUTPUT_AT)
    }
  )

  it('keeps a held turn start separate from its receipt and later admission', async () => {
    const sink = await providerSink()
    vi.spyOn(Date, 'now').mockReturnValue(LAST_OUTPUT_AT)
    let blocked = true
    const lane = new JsonlRpcTimelineLane({
      sink: refusingSink(sink, () => blocked),
      sessionId: SESSION,
      agent: 'opencode',
      generation: 'held-open-generation',
      namespace: 'held-open-acp',
      pauseReading: vi.fn(),
      resumeReading: vi.fn(),
      onInputAccepted: vi.fn(),
      onFailed: vi.fn()
    })
    try {
      lane.apply([{ type: 'turn.open', turn: 'held-turn', at: HOST_TEST_NOW }])
      vi.spyOn(Date, 'now').mockReturnValue(FLUSHED_AT)
      blocked = false
      lane.retry()
      await rig.host.flushStreamedEvents(SESSION)
    } finally {
      lane.dispose()
    }
    await expectInterruptedAt(LAST_OUTPUT_AT)
  })

  it('records a held final text snapshot at its receipt rather than the lane retry', async () => {
    const sink = await providerSink()
    let receivedAt = HOST_TEST_NOW
    vi.spyOn(Date, 'now').mockImplementation(() => receivedAt)
    let blocked = false
    const lane = new JsonlRpcTimelineLane({
      sink: refusingSink(sink, () => blocked),
      sessionId: SESSION,
      agent: 'pi',
      generation: 'final-generation',
      namespace: 'final-pi',
      pauseReading: vi.fn(),
      resumeReading: vi.fn(),
      onInputAccepted: vi.fn(),
      onFailed: vi.fn()
    })
    try {
      lane.apply([{ type: 'turn.open', turn: 'held-turn', at: HOST_TEST_NOW }])
      receivedAt += 500
      lane.apply([
        {
          type: 'text.delta',
          item: { stream: 'reply' },
          channel: 'assistant',
          text: 'partial'
        }
      ])
      lane.flush()
      await rig.host.flushStreamedEvents(SESSION)
      receivedAt = LAST_OUTPUT_AT
      blocked = true
      lane.apply([{ type: 'text.close', item: { stream: 'reply' }, text: 'final reply' }])
      receivedAt = FLUSHED_AT
      blocked = false
      lane.retry()
      await rig.host.flushStreamedEvents(SESSION)
      const before = await rig.host.journalSnapshot(SESSION)
      const reply = before.items.find((item) => JSON.stringify(item.body).includes('final reply'))
      expect(reply?.observedAt).toBe(HOST_TEST_NOW + 500)
    } finally {
      lane.dispose()
    }
    await expectInterruptedAt(LAST_OUTPUT_AT)
  })
})

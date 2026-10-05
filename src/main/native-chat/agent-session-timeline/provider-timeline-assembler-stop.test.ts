import { afterEach, describe, expect, it } from 'vitest'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentJournalTurnBody } from '../../../shared/agent-session-turn-record'
import { MAX_PROVIDER_TIMELINE_OPEN_ENTRIES } from './provider-timeline-budget'
import {
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig,
  openUnboundProviderTimelineAssembler,
  pendingApproval,
  providerItemId,
  providerTurnItemId,
  runningTool,
  type ProviderTimelineRig
} from './provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

/** A person's Stop, settled by the host on the journal, with no word to the assembler. */
async function stop(rig: ProviderTimelineRig, turnKey: string, at = 2_000): Promise<void> {
  const running = await rig.turn(turnKey)
  const identity = parseAgentJournalItemKey(providerTurnItemId(turnKey))
  if (!running || !identity) {
    throw new Error('the turn row is written')
  }
  await rig.journal.appendItem(
    identity,
    agentJournalTurnBody({ ...running, state: 'interrupted', completedAt: at }),
    { fence: 1, turnScope: { kind: 'thread' } }
  )
}

async function texts(rig: ProviderTimelineRig): Promise<unknown[]> {
  return (await rig.rows()).flatMap((row) => {
    const text = messageText(row.body)
    return text === undefined || row.body.kind !== 'message' || row.body.role === 'user'
      ? []
      : [[row.turnScope, text]]
  })
}

describe('a turn another writer settled ends as the provider end would end it', () => {
  it("settles the turn's running tool and pending prompt, then takes the provider's own end", async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'item.open', item: 'call', body: runningTool('read') })
    rig.assembler.apply({ type: 'request.open', request: '7', body: pendingApproval })
    await stop(rig, 't1')

    // The provider's trailing end of the turn it was asked to stop, and its withdrawal.
    expect(
      rig.assembler.apply({ type: 'turn.end', turn: 't1', at: 2_100, state: 'interrupted' })
    ).toEqual({ admission: { accepted: true } })
    expect(rig.assembler.apply({ type: 'request.withdrawn', request: '7' })).toEqual({
      admission: { accepted: true }
    })
    expect((await rig.row(providerItemId('item', 'call')))?.body).toMatchObject({
      state: 'failed'
    })
    expect((await rig.row(providerItemId('request', '7')))?.body).toMatchObject({
      resolution: { state: 'cancelled' }
    })
    // The Stop's row stands.
    expect(await rig.turn('t1')).toMatchObject({ state: 'interrupted', completedAt: 2_000 })
    expect(rig.assembler.openTurnId).toBeNull()
  })

  it('settles the same work when the provider end lands before the Stop', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'item.open', item: 'call', body: runningTool('read') })
    rig.assembler.apply({ type: 'request.open', request: '7', body: pendingApproval })
    rig.assembler.apply({ type: 'turn.end', turn: 't1', at: 2_100, state: 'interrupted' })
    expect((await rig.row(providerItemId('item', 'call')))?.body).toMatchObject({
      state: 'failed'
    })
    expect((await rig.row(providerItemId('request', '7')))?.body).toMatchObject({
      resolution: { state: 'cancelled' }
    })
    expect(await rig.turn('t1')).toMatchObject({ state: 'interrupted', completedAt: 2_100 })
  })

  it('settles the work even when the next event is one that writes nothing', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'item.open', item: 'call', body: runningTool('read') })
    await stop(rig, 't1')
    expect(rig.assembler.apply({ type: 'activity', text: 'Thinking' }).dropped).toBe('no-turn')
    expect((await rig.row(providerItemId('item', 'call')))?.body).toMatchObject({
      state: 'failed'
    })
  })

  it('never fills the open budget with the streams of turns a person stopped', async () => {
    const rig = await openProviderTimelineRig()
    for (let n = 1; n <= MAX_PROVIDER_TIMELINE_OPEN_ENTRIES + 12; n += 1) {
      const turn = `t${n}`
      rig.assembler.apply({ type: 'turn.open', turn, at: n * 10 })
      // Named messages with no close, as a provider that never closes its text sends them.
      expect(
        rig.assembler.apply({
          type: 'text.delta',
          item: { id: `msg-${n}` },
          channel: 'assistant',
          text: `reply ${n}`,
          join: { turn }
        }).admission
      ).toEqual({ accepted: true })
      await stop(rig, turn, n * 10 + 5)
      rig.assembler.apply({ type: 'turn.end', turn, at: n * 10 + 6, state: 'interrupted' })
    }
    expect(messageText((await rig.row(providerItemId('item', 'msg-140')))?.body)).toBe('reply 140')
  })

  it('frees a stream whose turn another writer settled before refusing for the budget', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'turn.open', turn: 't2', at: 1_100 })
    // Streams joined to turn t1, which is not the open one, so no turn end of this run frees them.
    for (let n = 1; n < MAX_PROVIDER_TIMELINE_OPEN_ENTRIES; n += 1) {
      rig.assembler.apply({
        type: 'text.delta',
        item: { id: `old-${n}` },
        channel: 'assistant',
        text: 'x',
        join: { turn: 't1' }
      })
    }
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'now' },
      channel: 'assistant',
      text: 'a'
    })
    expect(
      rig.assembler.apply({ type: 'item.open', item: 'call', body: runningTool('read') }).admission
    ).toEqual({ accepted: true })
  })
})

describe('text after a person stopped its turn never lands outside that turn', () => {
  it('drops the rest of an anonymous stream', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 'a' },
      channel: 'assistant',
      text: 'Hel'
    })
    await stop(rig, 't1')
    const delta = { type: 'text.delta', item: { stream: 'a' }, channel: 'assistant' } as const
    expect(rig.assembler.apply({ ...delta, text: 'lo' }).dropped).toBe('turn-settled')
    expect(rig.assembler.apply({ ...delta, text: ' world' }).dropped).toBe('turn-settled')
    expect(await texts(rig)).toEqual([
      [{ kind: 'turn', turnItemId: providerTurnItemId('t1') }, 'Hel']
    ])
  })

  it('drops the rest of a named stream whose first write found the turn stopped', async () => {
    const rig = await openProviderTimelineRig({ schedule: () => () => {} })
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'm' },
      channel: 'assistant',
      text: 'Hel'
    })
    await stop(rig, 't1')
    rig.assembler.flush()
    expect(
      rig.assembler.apply({
        type: 'text.delta',
        item: { id: 'm' },
        channel: 'assistant',
        text: 'lo'
      }).dropped
    ).toBe('turn-settled')
    rig.assembler.flush()
    expect(await texts(rig)).toEqual([])
  })

  it('drops a stopped stream admitted before the sink bound once its write found the turn over', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    await stop(rig, 't1')
    const { assembler, bind } = openUnboundProviderTimelineAssembler(rig.journal)
    assembler.apply({
      type: 'text.delta',
      item: { stream: 'a' },
      channel: 'assistant',
      text: 'Hel',
      join: { turn: 't1' }
    })
    assembler.flush()
    await bind()
    expect(
      assembler.apply({
        type: 'text.delta',
        item: { stream: 'a' },
        channel: 'assistant',
        text: 'lo',
        join: { turn: 't1' }
      }).dropped
    ).toBe('turn-settled')
    expect(await texts(rig)).toEqual([])
  })

  it('starts a new message for the same stream once the next turn opens', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 'a' },
      channel: 'assistant',
      text: 'A'
    })
    await stop(rig, 't1')
    rig.assembler.apply({ type: 'turn.open', turn: 't2', at: 3_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 'a' },
      channel: 'assistant',
      text: 'B'
    })
    expect(await texts(rig)).toEqual([
      [{ kind: 'turn', turnItemId: providerTurnItemId('t1') }, 'A'],
      [{ kind: 'turn', turnItemId: providerTurnItemId('t2') }, 'B']
    ])
  })
})

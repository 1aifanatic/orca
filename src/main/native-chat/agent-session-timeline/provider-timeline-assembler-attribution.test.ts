// Where a request, a send or a background task belongs is decided from the turn the event names
// and the journal as it stands, not from what an earlier event left in memory.

import { afterEach, describe, expect, it } from 'vitest'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentJournalTurnBody } from '../../../shared/agent-session-turn-record'
import { createCodexProviderTimelineIdentityScheme } from '../../codex/codex-provider-timeline-identity'
import {
  assistantText,
  backgroundTask,
  backgroundTaskState,
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig,
  openUnboundProviderTimelineAssembler,
  pendingApproval,
  providerItemId,
  providerTurnItemId,
  SESSION,
  type ProviderTimelineRig
} from './provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

const answered = {
  ...pendingApproval,
  resolution: {
    state: 'resolved' as const,
    selectedOptionId: 'allow',
    resolvedBy: 'phone',
    resolvedAt: 1_500
  }
}

function identityOf(itemId: string) {
  const identity = parseAgentJournalItemKey(itemId)
  if (!identity) {
    throw new Error(`${itemId} did not parse`)
  }
  return identity
}

/** `p1` opened in `t1` and answered by a client, `t1` over, `t2` running. */
async function answeredInAnEarlierTurn(): Promise<ProviderTimelineRig> {
  const rig = await openProviderTimelineRig()
  rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
  rig.assembler.apply({ type: 'request.open', request: 'p1', body: pendingApproval })
  await rig.journal.appendItem(identityOf(providerItemId('request', 'p1')), answered, {
    fence: 1,
    turnScope: { kind: 'turn', turnItemId: providerTurnItemId('t1') }
  })
  rig.assembler.apply({ type: 'turn.end', turn: 't1', at: 2_000, state: 'completed' })
  rig.assembler.apply({ type: 'turn.open', turn: 't2', at: 3_000 })
  await rig.rows()
  return rig
}

const second = providerItemId('request', 'p1', { incarnation: 2 })

describe('a request key reused in another turn', () => {
  it('opens a new prompt in the live turn it names after a withdrawn one', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'request.open', request: 'p1', body: pendingApproval })
    rig.assembler.apply({ type: 'request.withdrawn', request: 'p1' })
    rig.assembler.apply({ type: 'turn.end', turn: 't1', at: 2_000, state: 'completed' })
    rig.assembler.apply({ type: 'turn.open', turn: 't2', at: 3_000 })
    await rig.rows()
    const opened = rig.assembler.apply({
      type: 'request.open',
      request: 'p1',
      body: pendingApproval,
      join: { turn: 't2' }
    })
    expect(opened.dropped).toBeUndefined()
    expect(await rig.row(second)).toMatchObject({
      body: { resolution: { state: 'pending' } },
      turnScope: { kind: 'turn', turnItemId: providerTurnItemId('t2') }
    })
    expect((await rig.row(providerItemId('request', 'p1')))?.body).toMatchObject({
      resolution: { state: 'cancelled' }
    })
  })

  it('opens a new prompt in the open turn after an answered one, leaving the answer', async () => {
    const rig = await answeredInAnEarlierTurn()
    expect(
      rig.assembler.apply({ type: 'request.open', request: 'p1', body: pendingApproval }).dropped
    ).toBeUndefined()
    expect((await rig.row(second))?.body).toMatchObject({ resolution: { state: 'pending' } })
    expect((await rig.row(providerItemId('request', 'p1')))?.body).toMatchObject({
      resolution: { state: 'resolved', selectedOptionId: 'allow' }
    })
  })

  it('is a replay when it names the turn that is over', async () => {
    const rig = await answeredInAnEarlierTurn()
    expect(
      rig.assembler.apply({
        type: 'request.open',
        request: 'p1',
        body: pendingApproval,
        join: { turn: 't1' }
      }).dropped
    ).toBe('request-replayed')
    expect(await rig.row(second)).toBeUndefined()
  })

  it('decides at execution: queued before bind, a replay of the old turn writes nothing', async () => {
    const rig = await answeredInAnEarlierTurn()
    const { assembler, bind } = openUnboundProviderTimelineAssembler(rig.journal)
    const join = { turn: 't1' }
    expect(
      assembler.apply({ type: 'request.open', request: 'p1', body: pendingApproval, join }).dropped
    ).toBeUndefined()
    await bind()
    expect(await rig.row(second)).toBeUndefined()
    expect((await rig.row(providerItemId('request', 'p1')))?.body).toMatchObject({
      resolution: { state: 'resolved' }
    })
  })

  it('decides at execution: queued before bind, a new prompt in the live turn opens', async () => {
    const rig = await answeredInAnEarlierTurn()
    const { assembler, bind } = openUnboundProviderTimelineAssembler(rig.journal)
    const join = { turn: 't2' }
    assembler.apply({ type: 'request.open', request: 'p1', body: pendingApproval, join })
    await bind()
    expect((await rig.row(second))?.body).toMatchObject({ resolution: { state: 'pending' } })
  })

  it('decides at execution: a turn another writer ended while it was queued takes no prompt', async () => {
    const rig = await answeredInAnEarlierTurn()
    const { assembler, bind } = openUnboundProviderTimelineAssembler(rig.journal)
    const join = { turn: 't2' }
    assembler.apply({ type: 'request.open', request: 'p1', body: pendingApproval, join })
    const running = await rig.turn('t2')
    if (!running) {
      throw new Error('t2 is running')
    }
    await rig.journal.appendItem(
      identityOf(providerTurnItemId('t2')),
      agentJournalTurnBody({ ...running, state: 'interrupted', completedAt: 4_000 }),
      { fence: 1, turnScope: { kind: 'thread' } }
    )
    await bind()
    expect(await rig.row(second)).toBeUndefined()
  })
})

describe('a send that names its turn', () => {
  it('opens the turn it names when that turn opens later', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({
      type: 'input.accepted',
      clientMessageId: 'send1',
      requestedAt: 900,
      join: { turn: 't1' }
    })
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    expect(await rig.turn('t1')).toMatchObject({ userItemId: 'orca:send1', requestedAt: 900 })
  })

  it('never replaces an opener another writer gave the running turn', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    const running = await rig.turn('t1')
    if (!running) {
      throw new Error('t1 is running')
    }
    await rig.journal.appendItem(
      identityOf(providerTurnItemId('t1')),
      agentJournalTurnBody({ ...running, userItemId: 'orca:first', requestedAt: 800 }),
      { fence: 1, turnScope: { kind: 'thread' } }
    )
    rig.assembler.apply({ type: 'input.accepted', clientMessageId: 'later', requestedAt: 900 })
    expect(await rig.turn('t1')).toMatchObject({ userItemId: 'orca:first', requestedAt: 800 })
  })

  it('waits for its own turn rather than the next one to open', async () => {
    const rig = await openProviderTimelineRig()
    for (const [send, turn] of [
      ['send-b', 't2'],
      ['send-a', 't1']
    ] as const) {
      rig.assembler.apply({
        type: 'input.accepted',
        clientMessageId: send,
        requestedAt: 900,
        join: { turn }
      })
    }
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed' })
    rig.assembler.apply({ type: 'turn.open', turn: 't3', at: 3_000 })
    rig.assembler.apply({ type: 'turn.end', at: 4_000, state: 'completed' })
    rig.assembler.apply({ type: 'turn.open', turn: 't2', at: 5_000 })
    expect((await rig.turn('t1'))?.userItemId).toBe('orca:send-a')
    // A turn no send named opens as the provider's own.
    expect((await rig.turn('t3'))?.userItemId).toBe(providerTurnItemId('t3'))
    expect((await rig.turn('t2'))?.userItemId).toBe('orca:send-b')
  })
})

describe('a background task', () => {
  it('outlives its turn after a restart, and settles on its own update', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'item.open', item: 'bg', body: backgroundTask('bg', 'working') })
    await rig.rows()
    const restarted = rig.restart({ generation: 'gen-2' })
    restarted.apply({ type: 'turn.end', turn: 't1', at: 2_000, state: 'completed' })
    expect(await backgroundTaskState(rig, 'bg')).toBe('working')
    expect(
      restarted.apply({ type: 'item.close', item: 'bg', body: backgroundTask('bg', 'done') })
        .dropped
    ).toBeUndefined()
    expect(await backgroundTaskState(rig, 'bg')).toBe('done')
    // A straggler progress report never re-lights it.
    expect(
      restarted.apply({ type: 'item.update', item: 'bg', body: backgroundTask('bg', 'working') })
        .dropped
    ).toBe('item-settled')
    expect(await backgroundTaskState(rig, 'bg')).toBe('done')
  })

  it('is left unverifiable, not exited, when the session ends with it in flight', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'item.open', item: 'bg', body: backgroundTask('bg', 'working') })
    rig.assembler.apply({ type: 'item.open', item: 'ran', body: backgroundTask('ran', 'working') })
    rig.assembler.apply({ type: 'item.close', item: 'ran', body: backgroundTask('ran', 'done') })
    rig.assembler.apply({ type: 'session.ended', verdict: { state: 'unverifiable' } })
    expect((await rig.row(providerItemId('item', 'bg')))?.body).toEqual(
      backgroundTask('bg', 'unverifiable')
    )
    expect(await backgroundTaskState(rig, 'ran')).toBe('done')
  })
})

describe('message places after a restart', () => {
  it('continues past the highest place the journal holds, not the first gap', async () => {
    const rig = await openProviderTimelineRig({
      scheme: createCodexProviderTimelineIdentityScheme({
        sessionId: SESSION,
        primaryThreadId: () => 'root'
      }),
      ownThread: () => 'root'
    })
    await rig.journal.appendItem(
      { provider: 'codex', threadId: 'root', turnId: 't1', ordinal: 2 },
      assistantText('old'),
      { fence: 1, turnScope: { kind: 'thread' }, providerItemRef: 'item:old' }
    )
    const restarted = rig.restart({ generation: 'gen-2' })
    restarted.apply({
      type: 'item.close',
      item: 'new',
      body: assistantText('new'),
      join: { thread: 'root', turn: 't1' }
    })
    const placed = (await rig.rows()).find((row) => messageText(row.body) === 'new')
    expect(placed?.itemId).toBe('codex:root:t1:3')
  })
})

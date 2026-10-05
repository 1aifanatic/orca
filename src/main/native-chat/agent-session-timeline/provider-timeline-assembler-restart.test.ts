// A new provider child is a new assembler. Its events can be admitted before its sink binds, and
// the dead-generation sweep for the previous child lands before they are written, so every write
// decides from the journal the sweep left.

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { settleStaleStructuredAgentSessionState } from '../agent-session-wire/structured-agent-session-dead-generation-settlement'
import {
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig,
  openUnboundProviderTimelineAssembler,
  pendingApproval,
  providerItemId,
  providerTurnItemId,
  runningTool,
  SESSION,
  type ProviderTimelineRig
} from './provider-timeline-assembler-test-support'
import type { ProviderTimelineEvent } from './provider-timeline-event'

afterEach(closeProviderTimelineRigs)

const userText = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

/** A provider's saved history of one prompt, as an adapter adopting the session replays it. */
const history: ProviderTimelineEvent[] = [
  { type: 'input.history', item: 'u1', body: userText('Fix it'), join: { turn: 'p1' } },
  { type: 'turn.open', turn: 'p1', at: 1_000 },
  {
    type: 'text.delta',
    item: { id: 'a1' },
    channel: 'assistant',
    text: 'Looking',
    join: { turn: 'p1' }
  },
  { type: 'text.close', item: { id: 'a1' }, join: { turn: 'p1' } },
  { type: 'item.open', item: 'call-1', body: runningTool('read'), join: { turn: 'p1' } },
  {
    type: 'item.close',
    item: 'call-1',
    body: { ...runningTool('read'), state: 'completed' },
    join: { turn: 'p1' }
  },
  { type: 'turn.end', turn: 'p1', at: 2_000, state: 'completed', outcome: 'success' }
]

async function revisions(rig: ProviderTimelineRig): Promise<[string, number][]> {
  return (await rig.rows()).map((row) => [row.itemId, row.revision])
}

describe('an adopted session', () => {
  it('lands the provider history as rows keyed by its own ids, opened by its saved message', async () => {
    const rig = await openProviderTimelineRig()
    history.forEach((event) => rig.assembler.apply(event))
    rig.assembler.flush()

    const user = await rig.row(providerItemId('item', 'u1'))
    expect(user).toMatchObject({
      body: userText('Fix it'),
      turnScope: { kind: 'turn', turnItemId: providerTurnItemId('p1') }
    })
    expect(await rig.turn('p1')).toMatchObject({
      state: 'completed',
      outcome: 'success',
      userItemId: user?.itemId
    })
    expect(messageText((await rig.row(providerItemId('item', 'a1')))?.body)).toBe('Looking')
    expect((await rig.row(providerItemId('item', 'call-1')))?.body).toMatchObject({
      state: 'completed'
    })

    // Adoption run again by the next child (its first try was interrupted): nothing new lands.
    const before = await revisions(rig)
    const again = await rig.restart()
    history.forEach((event) => again.apply(event))
    again.flush()
    expect(await revisions(rig)).toEqual(before)
  })

  it('re-runs an adoption a crash cut midway without a second copy or a regressed row', async () => {
    const rig = await openProviderTimelineRig()
    history.slice(0, 5).forEach((event) => rig.assembler.apply(event))
    rig.assembler.flush()
    await rig.rows()
    // The child died with the turn and its tool running; the next acquisition sweeps them.
    await rig.restart()
    const swept = await rig.turn('p1')
    expect(swept?.state).not.toBe('running')
    const before = (await rig.rows()).length

    // The new child replays the whole history before its sink binds: only the writes can see it.
    const { assembler, bind } = openUnboundProviderTimelineAssembler(rig.journal, {
      generation: 'gen-3'
    })
    history.forEach((event) => expect(assembler.apply(event).dropped).toBeUndefined())
    assembler.flush()
    await bind()

    expect(await rig.rows()).toHaveLength(before)
    expect(await rig.turn('p1')).toEqual(swept)
    expect((await rig.row(providerItemId('item', 'call-1')))?.body).toMatchObject({
      state: 'failed'
    })
    expect(messageText((await rig.row(providerItemId('item', 'a1')))?.body)).toBe('Looking')
  })

  // Temporary limit, for the adoption work to lift: the sweep settled the cut turn as the dead
  // child's work, so the re-run cannot finish it.
  it('leaves the turn a crash cut as the sweep settled it when the adoption re-runs', async () => {
    const rig = await openProviderTimelineRig()
    const reply: ProviderTimelineEvent[] = [
      {
        type: 'text.delta',
        item: { id: 'a2' },
        channel: 'assistant',
        text: 'Done',
        join: { turn: 'p1' }
      },
      { type: 'text.close', item: { id: 'a2' }, join: { turn: 'p1' } }
    ]
    const full = [...history.slice(0, -1), ...reply, ...history.slice(-1)]
    full.slice(0, 5).forEach((event) => rig.assembler.apply(event))
    await rig.restart()
    const { assembler, bind } = openUnboundProviderTimelineAssembler(rig.journal, {
      generation: 'gen-3'
    })
    full.forEach((event) => assembler.apply(event))
    assembler.flush()
    await bind()

    expect((await rig.turn('p1'))?.state).toBe('unverifiable')
    expect((await rig.row(providerItemId('item', 'call-1')))?.body).toMatchObject({
      state: 'failed'
    })
    expect(await rig.row(providerItemId('item', 'a2'))).toBeUndefined()
  })
})

describe('a resumed session', () => {
  it('decides events admitted before bind against the journal the sweep left', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'old', at: 1_000 })
    rig.assembler.apply({ type: 'item.open', item: 'call-a', body: runningTool('read') })
    rig.assembler.apply({ type: 'request.open', request: '0', body: pendingApproval })
    await rig.rows()

    // The next child's events are admitted while its sink is unbound.
    const { assembler, bind } = openUnboundProviderTimelineAssembler(rig.journal, {
      generation: 'gen-2'
    })
    const late = { type: 'item.update', item: 'call-a', body: runningTool('read') } as const
    assembler.apply({ ...late, join: { turn: 'old' } })
    assembler.apply({
      type: 'item.open',
      item: 'call-b',
      body: runningTool('grep'),
      join: { turn: 'old' }
    })
    assembler.apply({ type: 'turn.open', turn: 'new', at: 3_000 })
    assembler.apply({ type: 'request.open', request: '0', body: pendingApproval })
    // The sweep for the dead child lands before the drain.
    await settleStaleStructuredAgentSessionState({
      journal: rig.journal,
      sessionId: SESSION,
      fence: 1,
      acquisitionGeneration: 'gen-2',
      deathEvidence: null
    })
    await bind()

    expect((await rig.turn('old'))?.state).not.toBe('running')
    // The swept tool is not relit by a running report that was admitted before the sweep.
    expect((await rig.row(providerItemId('item', 'call-a')))?.body).toMatchObject({
      state: 'failed'
    })
    // Nor does new running work land in a turn the sweep ended: nothing would ever settle it.
    expect(await rig.row(providerItemId('item', 'call-b'))).toBeUndefined()
    expect((await rig.row(providerItemId('request', '0')))?.body).toMatchObject({
      resolution: { state: 'cancelled' }
    })
    expect(await rig.turn('new')).toMatchObject({ state: 'running', startedAt: 3_000 })
    expect(await rig.row(providerItemId('request', '0', { generation: 'gen-2' }))).toMatchObject({
      body: { resolution: { state: 'pending' } },
      turnScope: { kind: 'turn', turnItemId: providerTurnItemId('new') }
    })
  })
})

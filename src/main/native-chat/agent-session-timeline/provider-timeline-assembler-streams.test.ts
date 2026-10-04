import { afterEach, describe, expect, it } from 'vitest'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentJournalTurnBody } from '../../../shared/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig,
  openUnboundProviderTimelineAssembler,
  providerItemId,
  providerTurnItemId,
  type ProviderTimelineRig
} from './provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

/** A journal that already holds a settled `old` turn and a running `live` one. */
async function oldAndLiveTurns(): Promise<ProviderTimelineRig> {
  const rig = await openProviderTimelineRig()
  rig.assembler.apply({ type: 'turn.open', turn: 'old', at: 1_000 })
  rig.assembler.apply({ type: 'turn.end', turn: 'old', at: 2_000, state: 'completed' })
  rig.assembler.apply({ type: 'turn.open', turn: 'live', at: 3_000 })
  await rig.rows()
  return rig
}

async function messages(rig: ProviderTimelineRig): Promise<(string | undefined)[]> {
  return (await rig.rows())
    .filter((row) => row.body.kind === 'message')
    .map((row) => messageText(row.body))
}

describe('a stream follows the row it resolved to, not the one planning expected', () => {
  it('stops at the end of the turn its row landed in, though planning expected another', async () => {
    const rig = await oldAndLiveTurns()
    const { assembler, bind, drained } = openUnboundProviderTimelineAssembler(rig.journal)
    // Planned before bind, so planning expects `old` to be open; it is a replay of a settled turn.
    assembler.apply({ type: 'turn.open', turn: 'old', at: 1_000 })
    assembler.apply({ type: 'text.delta', item: { id: 'm' }, channel: 'assistant', text: 'Hel' })
    await bind()
    assembler.flush()
    await drained()
    expect((await rig.row(providerItemId('item', 'm')))?.turnScope).toEqual({
      kind: 'turn',
      turnItemId: providerTurnItemId('live')
    })

    assembler.apply({ type: 'turn.end', turn: 'live', at: 4_000, state: 'completed' })
    await drained()
    expect(await rig.turn('live')).toMatchObject({ state: 'completed' })
    assembler.apply({ type: 'text.delta', item: { id: 'm' }, channel: 'assistant', text: 'lo' })
    assembler.flush()
    await drained()
    expect(messageText((await rig.row(providerItemId('item', 'm')))?.body)).toBe('Hel')
  })

  it('writes nothing more once another writer of the journal settled its turn', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'm' },
      channel: 'assistant',
      text: 'Hel'
    })
    const running = await rig.turn('t1')
    const identity = parseAgentJournalItemKey(providerTurnItemId('t1'))
    if (!running || !identity) {
      throw new Error('the turn row is written')
    }
    // A person's Stop, settled by the host on the journal, with no word to the assembler.
    await rig.journal.appendItem(
      identity,
      agentJournalTurnBody({ ...running, state: 'interrupted', completedAt: 2_000 }),
      { fence: 1, turnScope: { kind: 'thread' } }
    )
    rig.assembler.apply({ type: 'text.delta', item: { id: 'm' }, channel: 'assistant', text: 'lo' })
    rig.assembler.flush()
    expect(messageText((await rig.row(providerItemId('item', 'm')))?.body)).toBe('Hel')

    // The open turn is over for the assembler too: new work is no longer that turn's.
    expect(rig.assembler.openTurnId).toBeNull()
  })

  it('still takes the provider final full snapshot of a message whose turn settled', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'm' },
      channel: 'assistant',
      text: 'Hel'
    })
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed' })
    rig.assembler.apply({
      type: 'item.close',
      item: 'm',
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Hello.' }] }
    })
    expect(messageText((await rig.row(providerItemId('item', 'm')))?.body)).toBe('Hello.')
  })
})

describe('a message boundary is the journal decision', () => {
  it('keeps an anonymous message whole across a queued open the journal held as a replay', async () => {
    const rig = await oldAndLiveTurns()
    const { assembler, bind } = openUnboundProviderTimelineAssembler(rig.journal)
    assembler.apply({ type: 'turn.open', turn: 'live', at: 3_000 })
    assembler.apply({
      type: 'text.delta',
      item: { stream: 'reply' },
      channel: 'assistant',
      text: 'Hel'
    })
    assembler.apply({ type: 'turn.open', turn: 'old', at: 1_000 })
    assembler.apply({
      type: 'text.delta',
      item: { stream: 'reply' },
      channel: 'assistant',
      text: 'lo'
    })
    assembler.apply({ type: 'text.close', item: { stream: 'reply' } })
    await bind()
    expect(await messages(rig)).toEqual(['Hello'])
  })

  it('still splits an anonymous message at a turn the journal really opened', async () => {
    const rig = await oldAndLiveTurns()
    const { assembler, bind } = openUnboundProviderTimelineAssembler(rig.journal)
    assembler.apply({
      type: 'text.delta',
      item: { stream: 'reply' },
      channel: 'assistant',
      text: 'One'
    })
    assembler.apply({ type: 'turn.open', turn: 'next', at: 4_000 })
    assembler.apply({
      type: 'text.delta',
      item: { stream: 'reply' },
      channel: 'assistant',
      text: 'Two'
    })
    assembler.apply({ type: 'text.close', item: { stream: 'reply' } })
    await bind()
    expect(await messages(rig)).toEqual(['One', 'Two'])
  })

  it('resumes a named message after a queued open the journal held as a replay', async () => {
    const rig = await oldAndLiveTurns()
    const { assembler, bind } = openUnboundProviderTimelineAssembler(rig.journal)
    assembler.apply({ type: 'text.delta', item: { id: 'm' }, channel: 'assistant', text: 'Hel' })
    assembler.apply({ type: 'turn.open', turn: 'old', at: 1_000 })
    assembler.apply({ type: 'text.delta', item: { id: 'm' }, channel: 'assistant', text: 'lo' })
    assembler.apply({ type: 'text.close', item: { id: 'm' } })
    await bind()
    expect(await messages(rig)).toEqual(['Hello'])
    expect((await rig.row(providerItemId('item', 'm')))?.turnScope).toEqual({
      kind: 'turn',
      turnItemId: providerTurnItemId('live')
    })
  })
})

describe('the open budget counts every provider string a stream keeps', () => {
  it('refuses a stream whose thread alone is past the budget', async () => {
    const rig = await openProviderTimelineRig({ schedule: () => () => {} })
    const thread = 't'.repeat(1024 * 1024 + 1)
    expect(
      rig.assembler.apply({
        type: 'text.delta',
        item: { id: 'm' },
        channel: 'assistant',
        text: 'x',
        join: { thread }
      }).admission
    ).toEqual({ accepted: false, reason: 'failed' })
  })
})

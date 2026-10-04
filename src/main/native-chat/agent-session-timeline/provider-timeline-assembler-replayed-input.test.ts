import { afterEach, describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  assistantText,
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig,
  openUnboundProviderTimelineAssembler,
  type ProviderTimelineRig
} from './provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

const user = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

async function userMessages(rig: ProviderTimelineRig): Promise<(string | undefined)[]> {
  return (await rig.rows())
    .filter((row) => row.body.kind === 'message' && row.body.role === 'user')
    .map((row) => messageText(row.body))
}

/** Orca's send `m1`, journaled, opening turn `t1`; the child then went without ending it. */
async function sendOpenedTurn(rig: ProviderTimelineRig): Promise<void> {
  rig.eventSink.appendItem({ provider: 'orca', clientMessageId: 'm1' }, user('hello'), {
    turnScope: { kind: 'thread' }
  })
  rig.assembler.apply({
    type: 'input.accepted',
    clientMessageId: 'm1',
    requestedAt: 900,
    join: { turn: 't1' }
  })
  rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
  rig.assembler.apply({ type: 'session.ended', verdict: { state: 'unverifiable' } })
  await rig.rows()
}

describe('a replayed user message is decided against the journal at the write', () => {
  it('writes nothing for a turn the send opened, through a sink bound only after the load', async () => {
    const rig = await openProviderTimelineRig()
    await sendOpenedTurn(rig)
    const load = openUnboundProviderTimelineAssembler(rig.journal)
    // A copy the provider names by its own id, so only the turn's opener says it is the send.
    load.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    load.assembler.apply({
      type: 'input.replayed',
      item: 'replay-user:t1:provider-message-7',
      body: user('hello'),
      join: { turn: 't1' }
    })
    await load.bind()
    expect(await userMessages(rig)).toEqual(['hello'])
  })

  it('makes the journaled send the opener of a turn that never named it', async () => {
    const rig = await openProviderTimelineRig()
    rig.eventSink.appendItem({ provider: 'orca', clientMessageId: 'm1' }, user('hello'), {
      turnScope: { kind: 'thread' }
    })
    // The turn opened, then the host went before the send's echo reached it.
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    await rig.rows()
    const load = openUnboundProviderTimelineAssembler(rig.journal)
    load.assembler.apply({
      type: 'input.replayed',
      item: 'replay-user:t1:',
      body: user('hello'),
      clientMessageId: 'm1',
      join: { turn: 't1' }
    })
    await load.bind()
    expect(await userMessages(rig)).toEqual(['hello'])
    expect(await rig.turn('t1')).toMatchObject({ userItemId: agentJournalSubmissionKey('m1') })
  })

  it('writes the message of a turn that has none, and grows that row as it is resent', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    for (const text of ['hel', 'hello']) {
      rig.assembler.apply({
        type: 'input.replayed',
        item: 'replay-user:t1:',
        body: user(text),
        join: { turn: 't1' }
      })
    }
    expect(await userMessages(rig)).toEqual(['hello'])
  })

  it('leaves a turn the provider completed exactly as the journal holds it', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'item.update', item: 'reply', body: assistantText('short') })
    rig.assembler.apply({ type: 'turn.end', turn: 't1', at: 2_000, state: 'completed' })
    const before = await rig.rows()
    const load = openUnboundProviderTimelineAssembler(rig.journal)
    load.assembler.apply({
      type: 'input.replayed',
      item: 'replay-user:t1:',
      body: user('hello'),
      join: { turn: 't1' }
    })
    load.assembler.apply({
      type: 'item.update',
      item: 'reply',
      body: assistantText('the provider saved more'),
      join: { turn: 't1' },
      replay: true
    })
    await load.bind()
    expect(await rig.rows()).toEqual(before)
  })

  it('takes a reply the journal lacks once, and leaves it as it is on the next replay', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'item.update', item: 'reply', body: assistantText('part') })
    rig.assembler.apply({ type: 'session.ended', verdict: { state: 'unverifiable' } })
    await rig.rows()
    const replay = {
      type: 'item.update',
      item: 'reply',
      body: assistantText('part and the rest'),
      join: { turn: 't1' },
      replay: true
    } as const
    const first = openUnboundProviderTimelineAssembler(rig.journal)
    first.assembler.apply(replay)
    await first.bind()
    const recovered = await rig.rows()
    expect(recovered.map((row) => messageText(row.body))).toContain('part and the rest')
    const second = openUnboundProviderTimelineAssembler(rig.journal)
    second.assembler.apply(replay)
    await second.bind()
    expect(await rig.rows()).toEqual(recovered)
  })
})

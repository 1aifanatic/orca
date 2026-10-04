// Memory is a cache: what the assembler forgot (a restart, an evicted entry, a write the journal
// rejected, an event the sink refused) never changes which row an event lands on or what it says.

import { afterEach, describe, expect, it } from 'vitest'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { createCodexProviderTimelineIdentityScheme } from '../../codex/codex-provider-timeline-identity'
import { createDeferredStructuredAgentSessionEventSink } from '../agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../agent-session-wire/structured-agent-session-logger-test-support'
import { createProviderTimelineAssembler } from './provider-timeline-assembler'
import {
  AGENT,
  assistantText,
  closeProviderTimelineRigs,
  messageText,
  NAMESPACE,
  openProviderTimelineRig,
  pendingApproval,
  providerItemId,
  providerTurnId,
  providerTurnItemId,
  refusingSink,
  runningTool,
  SESSION
} from './provider-timeline-assembler-test-support'
import { providerTimelineSink } from './provider-timeline-plan'

afterEach(closeProviderTimelineRigs)

const codexRig = () =>
  openProviderTimelineRig({
    scheme: createCodexProviderTimelineIdentityScheme({
      sessionId: SESSION,
      primaryThreadId: () => 'root'
    }),
    ownThread: () => 'root'
  })

const messages = async (rig: Awaited<ReturnType<typeof openProviderTimelineRig>>) =>
  (await rig.rows()).filter((row) => row.body.kind === 'message')

describe('a forgotten join finds its original row', () => {
  it('finishes an in-flight message after a restart without overwriting an earlier one', async () => {
    const rig = await codexRig()
    const join = { thread: 'root', turn: 't1' }
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'item.close', item: 'm0', body: assistantText('First'), join })
    rig.assembler.apply({ type: 'item.open', item: 'm1', body: assistantText('Partial'), join })
    await rig.rows()

    const restarted = rig.restart({ generation: 'gen-2' })
    restarted.apply({ type: 'item.close', item: 'm1', body: assistantText('Second'), join })
    restarted.apply({ type: 'item.close', item: 'm2', body: assistantText('Third'), join })

    expect((await messages(rig)).map((row) => [row.itemId, messageText(row.body)])).toEqual([
      ['codex:root:t1:0', 'First'],
      ['codex:root:t1:1', 'Second'],
      ['codex:root:t1:2', 'Third']
    ])
  })

  it('resumes an in-flight streamed message after a restart from the text it already holds', async () => {
    const rig = await codexRig()
    const join = { thread: 'root', turn: 't1' }
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'm0' },
      channel: 'assistant',
      text: 'Hel',
      join
    })
    await rig.rows()

    const restarted = rig.restart({ generation: 'gen-2' })
    restarted.apply({
      type: 'text.delta',
      item: { id: 'm0' },
      channel: 'assistant',
      text: 'lo',
      join
    })
    restarted.apply({ type: 'text.close', item: { id: 'm0' }, join })

    expect((await messages(rig)).map((row) => [row.itemId, messageText(row.body)])).toEqual([
      ['codex:root:t1:0', 'Hello']
    ])
  })

  it('reaches a message in its own turn after its join was evicted', async () => {
    const rig = await codexRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'item.close',
      item: 'old-message',
      body: assistantText('Old'),
      join: { thread: 'root' }
    })
    rig.assembler.apply({ type: 'turn.end', turn: 't1', at: 2_000, state: 'completed' })
    rig.assembler.apply({ type: 'turn.open', turn: 't2', at: 3_000 })
    for (let index = 0; index < 1_025; index += 1) {
      rig.assembler.apply({
        type: 'item.close',
        item: `m-${index}`,
        body: assistantText('small'),
        join: { thread: 'root' }
      })
      if (index % 32 === 31) {
        await rig.rows()
      }
    }
    rig.assembler.apply({
      type: 'item.close',
      item: 'old-message',
      body: assistantText('Old'),
      join: { thread: 'root' }
    })

    const old = (await rig.rows()).filter((row) => messageText(row.body) === 'Old')
    expect(old.map((row) => row.itemId)).toEqual(['codex:root:t1:0'])
  })

  it('keeps a late tool close in the turn it opened in after its join was evicted', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'item.open',
      item: 'background-tool',
      body: runningTool('background'),
      outlivesTurn: true
    })
    rig.assembler.apply({ type: 'turn.end', turn: 't1', at: 2_000, state: 'completed' })
    rig.assembler.apply({ type: 'turn.open', turn: 't2', at: 3_000 })
    for (let index = 0; index < 1_025; index += 1) {
      rig.assembler.apply({ type: 'item.close', item: `m-${index}`, body: assistantText('small') })
      if (index % 32 === 31) {
        await rig.rows()
      }
    }
    rig.assembler.apply({
      type: 'item.close',
      item: 'background-tool',
      body: { ...runningTool('background'), state: 'completed' }
    })

    expect((await rig.row(providerItemId('item', 'background-tool')))?.turnScope).toEqual({
      kind: 'turn',
      turnItemId: providerTurnItemId('t1')
    })
  })

  it('withdraws the request incarnation a previous run opened', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'request.open', request: 'p1', body: pendingApproval })
    rig.assembler.apply({ type: 'request.withdrawn', request: 'p1' })
    rig.assembler.apply({ type: 'request.open', request: 'p1', body: pendingApproval })
    await rig.rows()

    rig.restart({ generation: 'gen-2' }).apply({ type: 'request.withdrawn', request: 'p1' })

    expect(
      (await rig.row(providerItemId('request', 'p1', { incarnation: 2 })))?.body
    ).toMatchObject({ resolution: { state: 'cancelled' } })
  })
})

describe('streamed text has the same lifecycle as the item it streams into', () => {
  it('keeps interleaved same-id streams on separate threads apart', async () => {
    const rig = await codexRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'm1' },
      channel: 'assistant',
      text: 'Root',
      join: { thread: 'root', turn: 't1' }
    })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'm1' },
      channel: 'assistant',
      text: 'Child',
      join: { thread: 'child', turn: 'child-turn' }
    })
    rig.assembler.apply({ type: 'turn.end', turn: 't1', at: 2_000, state: 'completed' })

    expect((await messages(rig)).map((row) => [row.itemId, messageText(row.body)])).toEqual([
      ['codex:root:t1:0', 'Root'],
      ['codex:child:child-turn:0', 'Child']
    ])
  })

  it('never lets replayed text replace a message its settled turn completed', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'item.close', item: 'm1', body: assistantText('Full final text') })
    rig.assembler.apply({ type: 'turn.end', turn: 't1', at: 2_000, state: 'completed' })
    await rig.rows()

    const restarted = rig.restart({ generation: 'gen-2' })
    expect(
      restarted.apply({
        type: 'text.delta',
        item: { id: 'm1' },
        channel: 'assistant',
        text: 'Full',
        join: { turn: 't1' }
      }).dropped
    ).toBe('item-settled')
    restarted.flush()

    expect(messageText((await rig.row(providerItemId('item', 'm1')))?.body)).toBe('Full final text')
  })

  it('settles a message on text.close, so a late delta cannot erase what it said', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'm1' },
      channel: 'assistant',
      text: 'Prefix'
    })
    rig.assembler.apply({ type: 'text.close', item: { id: 'm1' } })
    expect(
      rig.assembler.apply({
        type: 'text.delta',
        item: { id: 'm1' },
        channel: 'assistant',
        text: 'Suffix'
      }).dropped
    ).toBe('item-settled')
    rig.assembler.flush()

    expect(messageText((await rig.row(providerItemId('item', 'm1')))?.body)).toBe('Prefix')
  })
})

describe('a write the journal rejects changes nothing the assembler knows', () => {
  it('keeps a running tool open when a replayed supersede it planned before bind lands as nothing', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'old', at: 1_000 })
    rig.assembler.apply({ type: 'turn.end', turn: 'old', at: 2_000, state: 'completed' })
    rig.assembler.apply({ type: 'turn.open', turn: 'live', at: 3_000 })
    await rig.rows()

    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    const sink = providerTimelineSink(deferred.sink)
    if (!sink) {
      throw new Error('the deferred sink offers transitions')
    }
    const assembler = createProviderTimelineAssembler({
      sink,
      sessionId: SESSION,
      agent: AGENT,
      generation: 'gen-2',
      namespace: NAMESPACE
    })
    // Planned before bind: nothing tells the planner the journal already holds both turns.
    assembler.apply({ type: 'turn.open', turn: 'live', at: 3_000 })
    assembler.apply({ type: 'item.open', item: 'tool', body: runningTool('read') })
    assembler.apply({ type: 'turn.open', turn: 'old', at: 1_000 })
    deferred.bind({ journal: rig.journal, fence: 1, publish: () => {} })
    await deferred.drained()
    expect(await rig.turn('live')).toMatchObject({ state: 'running' })
    expect(assembler.openTurnId).toBe(providerTurnId('live'))

    const closed = assembler.apply({
      type: 'item.close',
      item: 'tool',
      body: { ...runningTool('read'), state: 'completed' }
    })
    expect(closed.dropped).toBeUndefined()
    await deferred.drained()
    expect((await rig.row(providerItemId('item', 'tool')))?.body).toMatchObject({
      state: 'completed'
    })
    deferred.close()
    assembler.dispose()
  })

  it('takes no message ordinal for an event the sink refused', async () => {
    const rig = await codexRig()
    let refusing = false
    const assembler = rig.restart({ sink: refusingSink(rig.sink, () => refusing) })
    const join = { thread: 'root', turn: 't1' }
    assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    refusing = true
    expect(
      assembler.apply({ type: 'item.close', item: 'refused', body: assistantText('No'), join })
        .admission
    ).toEqual({ accepted: false, reason: 'backpressure' })
    refusing = false
    assembler.apply({ type: 'item.close', item: 'accepted', body: assistantText('Yes'), join })

    expect((await messages(rig)).map((row) => row.itemId)).toEqual(['codex:root:t1:0'])
  })
})

describe('reset settles the old session whatever the assembler remembers', () => {
  it('writes text a reset interrupts, though nothing else was open', async () => {
    const rig = await openProviderTimelineRig({ schedule: () => () => {} })
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 'reply' },
      channel: 'assistant',
      text: 'Before reset'
    })
    rig.assembler.apply({ type: 'session.reset', namespace: 'provider-session-2' })

    expect((await messages(rig)).map((row) => messageText(row.body))).toEqual(['Before reset'])
  })

  it('settles the journal work of a previous run as lost', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'item.open', item: 'tool', body: runningTool('read') })
    await rig.rows()

    rig.restart({ generation: 'gen-2' }).apply({
      type: 'session.reset',
      namespace: 'provider-session-2'
    })

    expect(await rig.turn('t1')).toMatchObject({ state: 'unverifiable' })
    expect((await rig.row(providerItemId('item', 'tool')))?.body).toMatchObject({
      state: 'failed'
    })
  })
})

describe('the budget counts the work actually open', () => {
  it('frees an answered request incarnation without waiting for its turn to end', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    for (let incarnation = 1; incarnation <= 129; incarnation += 1) {
      expect(
        rig.assembler.apply({ type: 'request.open', request: 'approval', body: pendingApproval })
          .admission
      ).toEqual({ accepted: true })
      await rig.rows()
      const identity = parseAgentJournalItemKey(
        providerItemId('request', 'approval', { incarnation })
      )
      if (!identity) {
        throw new Error('the request has a journal key')
      }
      // A client answers it, through the journal.
      await rig.journal.appendItem(
        identity,
        {
          ...pendingApproval,
          resolution: {
            state: 'resolved',
            selectedOptionId: 'allow',
            resolvedBy: 'phone',
            resolvedAt: 1_100
          }
        },
        { fence: 1, turnScope: { kind: 'turn', turnItemId: providerTurnItemId('t1') } }
      )
    }
  })

  it('keeps a streamed message counted while its stream is open, whatever its snapshots say', async () => {
    const rig = await openProviderTimelineRig({ schedule: () => () => {} })
    for (let index = 0; index < 128; index += 1) {
      rig.assembler.apply({
        type: 'text.delta',
        item: { id: `stream-${index}` },
        channel: 'assistant',
        text: 'x'
      })
      rig.assembler.apply({
        type: 'item.update',
        item: `stream-${index}`,
        body: assistantText('x')
      })
      if (index % 32 === 31) {
        await rig.rows()
      }
    }
    expect(
      rig.assembler.apply({
        type: 'text.delta',
        item: { id: 'overflow' },
        channel: 'assistant',
        text: 'x'
      }).admission
    ).toEqual({ accepted: false, reason: 'failed' })
  })

  it('refuses a provider key larger than the whole budget', () =>
    openProviderTimelineRig({ schedule: () => () => {} }).then((rig) => {
      expect(
        rig.assembler.apply({
          type: 'text.delta',
          item: { id: 'x'.repeat(1024 * 1024 + 1) },
          channel: 'assistant',
          text: 'tiny'
        }).admission
      ).toEqual({ accepted: false, reason: 'failed' })
    }))
})

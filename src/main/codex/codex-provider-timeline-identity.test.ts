// The migration contract for moving Codex onto the shared timeline assembler: the assembler with
// the Codex identity scheme lands the same rows Codex's own translator lands today — the same keys
// (live messages, history restored on resume, a late item naming its own turn, interleaved
// subagent threads) and the same row contents.

import { afterEach, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { ProviderTurnMessageOrdinals } from '../native-chat/agent-session-timeline/provider-turn-message-ordinals'
import { createCodexProviderTimelineIdentityScheme } from './codex-provider-timeline-identity'
import {
  codexItemIdentity,
  codexJournalItem,
  type CodexThreadItem
} from './codex-structured-item-translation'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

afterEach(closeProviderTimelineRigs)

const THREAD = 'thread-abc'
const CHILD = 'thread-child'

async function codexRig() {
  return openProviderTimelineRig({
    scheme: createCodexProviderTimelineIdentityScheme({
      sessionId: SESSION,
      primaryThreadId: () => THREAD
    }),
    ownThread: () => THREAD
  })
}

function body(item: CodexThreadItem, started?: CodexThreadItem) {
  const translated = codexJournalItem(item, undefined, started).body
  if (
    !translated ||
    translated.kind === 'turn' ||
    translated.kind === 'approval' ||
    translated.kind === 'question'
  ) {
    throw new Error(`no item body for ${item.type}`)
  }
  return translated
}

const keys = (rows: AgentJournalRenderItem[]) =>
  rows.filter((row) => row.body.kind !== 'turn').map((row) => row.itemId)

/** What a client renders from a row; sequence, revision and receipt time are the journal's own. */
const content = (rows: AgentJournalRenderItem[]) =>
  JSON.stringify(
    rows.map(
      ({
        itemId,
        body,
        turnScope,
        agentId,
        parentAgentId,
        providerParentRef,
        producerKind,
        attempt
      }) => ({
        itemId,
        body,
        turnScope,
        agentId,
        parentAgentId,
        providerParentRef,
        producerKind,
        attempt
      })
    )
  )

function liveTranslator(rig: Awaited<ReturnType<typeof openProviderTimelineRig>>) {
  return createCodexJournalTranslator({
    sink: rig.eventSink,
    sessionId: SESSION,
    primaryThreadId: () => THREAD,
    now: () => 1_000,
    schedule: (run) => {
      run()
      return () => {}
    }
  })
}

function notify(method: string, params: unknown): CodexStructuredSessionEvent {
  return { type: 'notification', sessionId: SESSION, threadId: THREAD, method, params }
}

describe('Codex identities through the shared assembler', () => {
  it('keys messages by turn and message ordinal, and a message outside any turn by its item id', async () => {
    const rig = await codexRig()
    const message = (
      id: string,
      text: string,
      join?: { turn?: string }
    ): ProviderTimelineEvent => ({
      type: 'item.close',
      item: id,
      body: body({ type: 'agentMessage', id, text }),
      join: { thread: THREAD, ...join }
    })
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply(message('item-0', 'one'))
    rig.assembler.apply({ type: 'turn.end', turn: 'turn-1', at: 2_000, state: 'completed' })
    rig.assembler.apply(message('item-1', 'orphan'))
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-2', at: 3_000 })
    rig.assembler.apply(message('item-2', 'two'))
    // A message naming another turn joins that turn, whatever is open.
    rig.assembler.apply(message('item-3', 'late', { turn: 'turn-9' }))

    // The keys Codex's own translator writes for the same frames.
    expect(keys(await rig.rows())).toEqual([
      'codex:thread-abc:turn-1:0',
      'orca:codex-item%3Athread-abc%3Aitem-1',
      'codex:thread-abc:turn-2:0',
      'codex:thread-abc:turn-9:0'
    ])
  })

  it('keeps interleaved subagent threads apart while their rows join the open turn', async () => {
    const rig = await codexRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({
      type: 'item.close',
      item: 'item-0',
      body: body({ type: 'agentMessage', id: 'item-0', text: 'root' }),
      join: { thread: THREAD }
    })
    rig.assembler.apply({
      type: 'item.close',
      item: 'item-0',
      body: body({ type: 'agentMessage', id: 'item-0', text: 'child' }),
      join: { thread: CHILD, turn: 'turn-child' }
    })
    rig.assembler.apply({
      type: 'item.close',
      item: 'item-1',
      body: body({ type: 'agentMessage', id: 'item-1', text: 'still root' }),
      join: { thread: THREAD }
    })
    const rows = (await rig.rows()).filter((row) => row.body.kind !== 'turn')
    expect(rows.map((row) => row.itemId)).toEqual([
      'codex:thread-abc:turn-1:0',
      'codex:thread-child:turn-child:0',
      'codex:thread-abc:turn-1:1'
    ])
    expect(new Set(rows.map((row) => JSON.stringify(row.turnScope))).size).toBe(1)
  })

  it('counts an echoed send in its turn’s message ordinals, as resume history does', async () => {
    const rig = await codexRig()
    const ordinals = new ProviderTurnMessageOrdinals()
    const oracle = (item: CodexThreadItem) =>
      agentJournalItemKey(codexItemIdentity({ threadId: THREAD, turnId: 'turn-1', item, ordinals }))
    const echo: CodexThreadItem = { type: 'userMessage', id: 'item-0', content: [] }
    const reasoning: CodexThreadItem = { type: 'reasoning', id: 'item-1', summary: ['why'] }
    const answer: CodexThreadItem = { type: 'agentMessage', id: 'item-2', text: 'answer' }
    const expected = [oracle(echo), oracle(reasoning), oracle(answer)]

    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({
      type: 'input.accepted',
      clientMessageId: 'send-1',
      requestedAt: 900,
      join: { thread: THREAD, turn: 'turn-1', item: 'item-0' }
    })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'item-1' },
      channel: 'reasoning',
      text: 'why',
      join: { thread: THREAD }
    })
    rig.assembler.apply({
      type: 'item.close',
      item: 'item-2',
      body: body(answer),
      join: { thread: THREAD }
    })
    rig.assembler.apply({ type: 'turn.end', turn: 'turn-1', at: 2_000, state: 'completed' })

    expect(keys(await rig.rows())).toEqual(expected.slice(1))
    expect(expected[2]).toBe('codex:thread-abc:turn-1:1')
  })
})

describe('Codex rows through the shared assembler', () => {
  it('lands the same rows as the Codex translator for a live turn', async () => {
    const codex = await openProviderTimelineRig()
    let clock = 1_000
    const translator = createCodexJournalTranslator({
      sink: codex.eventSink,
      sessionId: SESSION,
      primaryThreadId: () => THREAD,
      now: () => clock,
      schedule: (run) => {
        run()
        return () => {}
      }
    })
    const notify = (method: string, params: unknown): CodexStructuredSessionEvent => ({
      type: 'notification',
      sessionId: SESSION,
      threadId: THREAD,
      method,
      params
    })
    const started: CodexThreadItem = {
      type: 'commandExecution',
      id: 'exec-1',
      command: 'ls',
      status: 'inProgress'
    }
    const finished: CodexThreadItem = {
      ...started,
      status: 'completed',
      exitCode: 0,
      aggregatedOutput: 'ok'
    }
    const reply: CodexThreadItem = { type: 'agentMessage', id: 'item-1', text: 'Hello' }
    translator.handle(notify('turn/started', { turn: { id: 'turn-1' } }))
    translator.handle(notify('item/started', { item: { ...reply, text: '' } }))
    translator.handle(notify('item/agentMessage/delta', { itemId: 'item-1', delta: 'Hello' }))
    translator.handle(notify('item/completed', { item: reply }))
    translator.handle(notify('item/started', { item: started }))
    translator.handle(notify('item/completed', { item: finished }))
    clock = 2_000
    translator.handle(
      notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', durationMs: 900 } })
    )

    const shared = await codexRig()
    const join = { thread: THREAD, turn: 'turn-1' }
    shared.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    shared.assembler.apply({
      type: 'text.delta',
      item: { id: 'item-1' },
      channel: 'assistant',
      text: 'Hello',
      join
    })
    shared.assembler.apply({ type: 'item.close', item: 'item-1', body: body(reply), join })
    shared.assembler.apply({ type: 'item.open', item: 'exec-1', body: body(started), join })
    shared.assembler.apply({
      type: 'item.close',
      item: 'exec-1',
      body: body(finished, started),
      join
    })
    shared.assembler.apply({
      type: 'turn.end',
      turn: 'turn-1',
      at: 2_000,
      state: 'completed',
      outcome: 'success',
      durationMs: 900
    })

    expect(content(await shared.rows())).toBe(content(await codex.rows()))
  })

  it('lands the same rows as the Codex translator for a turn restored from history', async () => {
    const turn = {
      id: 'turn-1',
      status: 'completed',
      startedAt: 1_700_000_000,
      completedAt: 1_700_000_050,
      items: [
        { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'ask' }] },
        { type: 'reasoning', id: 'think-1', summary: ['why'] },
        { type: 'agentMessage', id: 'interim-1', text: 'looking' },
        { type: 'commandExecution', id: 'exec-1', command: 'ls', status: 'completed', exitCode: 0 },
        { type: 'agentMessage', id: 'answer-1', text: 'answer' }
      ]
    }
    const codex = await openProviderTimelineRig()
    const translator = createCodexJournalTranslator({
      sink: codex.eventSink,
      sessionId: SESSION,
      primaryThreadId: () => THREAD
    })
    expect(translator.restoreThread(THREAD, { turns: [turn] })).toEqual({ accepted: true })

    const shared = await codexRig()
    const join = { thread: THREAD, turn: 'turn-1' }
    shared.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: turn.startedAt * 1000 })
    for (const item of turn.items) {
      const translated = codexJournalItem(item).body
      if (
        translated &&
        translated.kind !== 'turn' &&
        translated.kind !== 'approval' &&
        translated.kind !== 'question'
      ) {
        shared.assembler.apply({ type: 'item.close', item: item.id, body: translated, join })
      }
    }
    shared.assembler.apply({
      type: 'turn.end',
      turn: 'turn-1',
      at: turn.completedAt * 1000,
      state: 'completed',
      outcome: 'success'
    })

    expect(content(await shared.rows())).toBe(content(await codex.rows()))
  })

  it('lands the same rows across a restart in the middle of a streamed message', async () => {
    const codex = await openProviderTimelineRig()
    const translator = liveTranslator(codex)
    const first: CodexThreadItem = { type: 'agentMessage', id: 'item-1', text: 'First' }
    const second: CodexThreadItem = { type: 'agentMessage', id: 'item-2', text: 'Second' }
    translator.handle(notify('turn/started', { turn: { id: 'turn-1' } }))
    translator.handle(notify('item/completed', { item: first }))
    translator.handle(notify('item/started', { item: { ...second, text: '' } }))
    translator.handle(notify('item/agentMessage/delta', { itemId: 'item-2', delta: 'Sec' }))
    translator.handle(notify('item/agentMessage/delta', { itemId: 'item-2', delta: 'ond' }))
    translator.handle(notify('item/completed', { item: second }))

    const shared = await codexRig()
    const join = { thread: THREAD, turn: 'turn-1' }
    shared.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    shared.assembler.apply({ type: 'item.close', item: 'item-1', body: body(first), join })
    shared.assembler.apply({
      type: 'text.delta',
      item: { id: 'item-2' },
      channel: 'assistant',
      text: 'Sec',
      join
    })
    await shared.rows()
    // The host restarts while Codex is still streaming item-2.
    const restarted = shared.restart({ generation: 'gen-2' })
    restarted.apply({
      type: 'text.delta',
      item: { id: 'item-2' },
      channel: 'assistant',
      text: 'ond',
      join
    })
    restarted.apply({ type: 'item.close', item: 'item-2', body: body(second), join })

    const rows = await shared.rows()
    expect(content(rows)).toBe(content(await codex.rows()))
    // Codex message rows carry the item id their ordinal identity cannot spell.
    expect(
      rows.filter((row) => row.body.kind === 'message').map((row) => row.providerItemRef)
    ).toEqual([expect.stringContaining('item-1'), expect.stringContaining('item-2')])
  })

  it('lands the same rows, and no second copy, when a late repeat outlives the join cache', async () => {
    const codex = await openProviderTimelineRig()
    const translator = liveTranslator(codex)
    const shared = await codexRig()
    const old: CodexThreadItem = { type: 'agentMessage', id: 'old-1', text: 'Old' }
    translator.handle(notify('turn/started', { turn: { id: 'turn-1' } }))
    translator.handle(notify('item/completed', { item: old }))
    translator.handle(notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } }))
    translator.handle(notify('turn/started', { turn: { id: 'turn-2' } }))
    shared.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    shared.assembler.apply({
      type: 'item.close',
      item: 'old-1',
      body: body(old),
      join: { thread: THREAD }
    })
    shared.assembler.apply({
      type: 'turn.end',
      turn: 'turn-1',
      at: 1_000,
      state: 'completed',
      outcome: 'success'
    })
    shared.assembler.apply({ type: 'turn.open', turn: 'turn-2', at: 1_000 })
    for (let index = 0; index < 1_025; index += 1) {
      const item: CodexThreadItem = { type: 'agentMessage', id: `item-${index}`, text: 'small' }
      translator.handle(notify('item/completed', { item }))
      shared.assembler.apply({
        type: 'item.close',
        item: item.id,
        body: body(item),
        join: { thread: THREAD }
      })
      if (index % 32 === 31) {
        await Promise.all([codex.rows(), shared.rows()])
      }
    }
    // Long after its join left memory, Codex repeats the old message with no turn of its own.
    shared.assembler.apply({
      type: 'item.close',
      item: 'old-1',
      body: body(old),
      join: { thread: THREAD }
    })

    expect(content(await shared.rows())).toBe(content(await codex.rows()))
  })
})

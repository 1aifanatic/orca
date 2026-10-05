// A /compact asked to wait (`delivery`) while the agent works: held as a card like a queued
// send, answered at once, run when the queue drains it. Without the opt-in, today's refusal.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { ConversationCommandParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

function compact(delivery?: 'queue-if-active', clientOperationId = hostTestOperationId()) {
  const fields = { command: 'compact' as const, ...(delivery ? { delivery } : {}) }
  return {
    id: clientOperationId,
    result: rig.host.conversationCommand(CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', clientOperationId),
      ...fields
    })
  }
}

function clear() {
  const fields = { command: 'clear' as const }
  return rig.host.conversationCommand(CALLER, {
    envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
    ...fields
  })
}

async function queuedCompact(): Promise<string> {
  const { id, result } = compact('queue-if-active')
  expect(await result).toMatchObject({
    ok: true,
    value: { command: 'compact', state: 'completed', queued: { messageId: id, state: 'waiting' } }
  })
  return id
}

function prompt(state: 'pending' | 'resolved') {
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  return journal.appendItem(
    { provider: 'orca', clientMessageId: 'prompt-1' },
    {
      kind: 'approval',
      title: 'Allow the tool?',
      detail: null,
      options: [],
      resolution:
        state === 'pending'
          ? { state, selectedOptionId: null, resolvedBy: null, resolvedAt: null }
          : { state, selectedOptionId: 'allow', resolvedBy: 'client-1', resolvedAt: 1 }
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

const settleMs = () => new Promise((resolve) => setTimeout(resolve, 150))

describe('a /compact that waits in line', () => {
  it('behind an unanswered message: a card at once, run once that message is answered', async () => {
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    expect(await rig.drafts()).toEqual([{ messageId: compactId, state: 'waiting' }])
    await settleMs()
    expect(rig.compact).not.toHaveBeenCalled()
    await rig.settleAccepted(working, 'a')
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
    expect((await rig.handoff(compactId))?.handedOverAt).toBeDefined()
    expect(await rig.drafts()).toEqual([])
  })

  it('behind a running command turn: waits for that turn to end', async () => {
    expect(await compact().result).toMatchObject({ ok: true, value: { state: 'completed' } })
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
    const second = await queuedCompact()
    await settleMs()
    expect(rig.compact).toHaveBeenCalledOnce()
    rig.finishCompact()
    await eventually(() => expect(rig.compact).toHaveBeenCalledTimes(2))
    expect((await rig.handoff(second))?.handedOverAt).toBeDefined()
  })

  it('behind a pending question or approval: waits for its answer', async () => {
    await prompt('pending')
    const compactId = await queuedCompact()
    await settleMs()
    expect(rig.compact).not.toHaveBeenCalled()
    await prompt('resolved')
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
    expect(await rig.handoff(compactId)).toBeDefined()
  })

  it('behind a message the agent refuses: still runs, nothing strands', async () => {
    const working = await rig.workingSend()
    await queuedCompact()
    await rig.settleRejected(working, 'provider refused this payload')
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
  })

  it('a resent id answers from its card, then from the submission it became; one run', async () => {
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    expect(await compact('queue-if-active', compactId).result).toMatchObject({
      ok: true,
      value: { queued: { messageId: compactId, state: 'waiting' } }
    })
    expect(await rig.drafts()).toHaveLength(1)
    await rig.settleAccepted(working, 'a')
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
    const resent = await compact('queue-if-active', compactId).result
    expect(resent).toMatchObject({ ok: true, value: { command: 'compact', state: 'completed' } })
    expect(resent.ok && resent.value.queued).toBeFalsy()
    await settleMs()
    expect(rig.compact).toHaveBeenCalledOnce()
    expect(
      (await rig.host.journalSnapshot(SESSION)).submissions.filter(
        (entry) => entry.queuedMessageId === compactId
      )
    ).toHaveLength(1)
  })

  it('never steers: Send-now on its card mid-turn is refused and it keeps waiting', async () => {
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    expect(await rig.sendNow(compactId)).toMatchObject({
      ok: false,
      refusal: { message: 'This command runs once the agent finishes.' }
    })
    expect(await rig.handoff(compactId)).toBeUndefined()
    await rig.settleAccepted(working, 'a')
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
  })

  it('a later send waits behind it, in the order sent', async () => {
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    const later = await rig.send('sent after the compact', 'queue-if-active').result
    if (!later.ok || !('queued' in later.value)) {
      throw new Error('expected a queued receipt')
    }
    const laterId = later.value.queued.messageId
    await rig.settleAccepted(working, 'a')
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
    // The compaction's turn runs, so the later card still waits.
    await settleMs()
    expect(await rig.handoff(laterId)).toBeUndefined()
    rig.finishCompact()
    await eventually(async () => expect(await rig.handoff(laterId)).toBeDefined())
    expect(
      (await rig.host.journalSnapshot(SESSION)).submissions.flatMap((entry) =>
        entry.queuedMessageId ? [entry.queuedMessageId] : []
      )
    ).toEqual([compactId, laterId])
  })

  it('at rest, runs at once as before', async () => {
    const { result } = compact('queue-if-active')
    const answer = await result
    expect(answer).toMatchObject({ ok: true, value: { command: 'compact', state: 'completed' } })
    expect(answer.ok && answer.value.queued).toBeFalsy()
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
    expect(await rig.drafts()).toEqual([])
  })

  it('without the opt-in (an older client), is refused while a message is unanswered, as today', async () => {
    await rig.workingSend()
    expect(await compact().result).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'messagesUnsettled' } }
    })
    expect(await rig.drafts()).toEqual([])
  })

  it('Delete takes it back: it never runs', async () => {
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    expect(await rig.deleteQueued(compactId)).toMatchObject({ ok: true, value: { deleted: true } })
    await rig.settleAccepted(working, 'a')
    await settleMs()
    expect(rig.compact).not.toHaveBeenCalled()
    expect(await rig.drafts()).toEqual([])
  })

  it('Stop pauses it with the queue, and Resume runs it', async () => {
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    await settleMs()
    expect(rig.compact).not.toHaveBeenCalled()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(await rig.drafts()).toEqual([{ messageId: compactId, state: 'waiting' }])
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
  })

  it('a /clear drops a waiting command card instead of carrying it to the new chat', async () => {
    const working = await rig.workingSend()
    await queuedCompact()
    const draft = await rig.send('carried draft', 'queue-if-active').result
    if (!draft.ok || !('queued' in draft.value)) {
      throw new Error('expected a queued receipt')
    }
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    const cleared = await clear()
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    if (!replacementId) {
      throw new Error('expected a replacement session')
    }
    expect(await rig.drafts()).toEqual([])
    expect(await rig.drafts(replacementId)).toEqual([
      { messageId: draft.value.queued.messageId, state: 'waiting' }
    ])
    expect(rig.compact).not.toHaveBeenCalled()
  })

  it('a /clear with only a command card waiting opens no replacement conversation for it', async () => {
    const working = await rig.workingSend()
    await queuedCompact()
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    const cleared = await clear()
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    if (!replacementId) {
      throw new Error('expected a replacement session')
    }
    expect(await rig.drafts()).toEqual([])
    expect(rig.host.collaboratorsForTests().sessions.has(replacementId)).toBe(false)
  })
})

it('only a /compact may ask to wait; a /clear never queues', () => {
  const base = { envelope: rig.envelope({}, 'agentSession.conversationCommand', 'op-schema') }
  const parse = (fields: Record<string, unknown>) =>
    ConversationCommandParams.safeParse({ ...base, ...fields }).success
  expect(parse({ command: 'compact', delivery: 'queue-if-active' })).toBe(true)
  expect(parse({ command: 'clear', delivery: 'queue-if-active' })).toBe(false)
  expect(parse({ command: 'compact', delivery: 'now' })).toBe(false)
})

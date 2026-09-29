// The one queue gate: admission, the drain step and Send-now consume a single
// typed hold decision, so the lists cannot drift — pinned here with the
// late-result /compact journey, Send-now's override set, and the
// replay-preference rule for a refused draft.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StructuredSessionCompactionResult } from './structured-session-compaction'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig
let host: QueuedMessageTestRig['host']
let store: QueuedMessageTestRig['store']
let compact: QueuedMessageTestRig['compact']

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
  ;({ host, store, compact } = rig)
})

afterEach(() => rig.dispose())

const envelope: QueuedMessageTestRig['envelope'] = (...args) => rig.envelope(...args)
const send: QueuedMessageTestRig['send'] = (...args) => rig.send(...args)
const sendNow: QueuedMessageTestRig['sendNow'] = (...args) => rig.sendNow(...args)
const submission: QueuedMessageTestRig['submission'] = (...args) => rig.submission(...args)
const drafts: QueuedMessageTestRig['drafts'] = () => rig.drafts()
const workingSend: QueuedMessageTestRig['workingSend'] = () => rig.workingSend()
const settleAccepted: QueuedMessageTestRig['settleAccepted'] = (...args) =>
  rig.settleAccepted(...args)
const settleRejected: QueuedMessageTestRig['settleRejected'] = (...args) =>
  rig.settleRejected(...args)

describe('the one queue gate', () => {
  /** A /compact whose request failed but whose result arrives later: the record
   *  holds `phase: 'prepared'` with no journal commit until the late result. */
  async function compactWithLateResult(): Promise<
    (result: StructuredSessionCompactionResult) => Promise<void>
  > {
    let late: ((result: StructuredSessionCompactionResult) => Promise<void>) | undefined
    compact.mockImplementationOnce(async (input) => {
      late = input.onLateResult
      throw new Error('compact request timed out')
    })
    const operationId = hostTestOperationId()
    await host
      .conversationCommand(CALLER, {
        envelope: envelope({ command: 'compact' }, 'agentSession.conversationCommand', operationId),
        command: 'compact'
      })
      .catch(() => undefined)
    expect(store.getRecord(SESSION)?.conversationCommand).toMatchObject({
      command: 'compact',
      phase: 'prepared',
      state: 'unknown'
    })
    if (!late) {
      throw new Error('compact never offered a late result')
    }
    return late
  }

  it('a capable send during a late-result compact queues, and drains once the result lands (PLAN §3.1)', async () => {
    const late = await compactWithLateResult()
    const queued = await send('sent during the compact', 'queue-if-active').result
    expect(queued).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    // Nothing drains while the command is in doubt.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await submission(draftId)).toBeUndefined()
    await late({ outcome: 'compacted' })
    await eventually(async () => expect(await submission(draftId)).toBeDefined())
    expect(await drafts()).toHaveLength(0)
  })

  it("Send-now refuses on a command in flight — it overrides only the queue's own policy", async () => {
    const late = await compactWithLateResult()
    const queued = await send('queued behind the compact', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    expect(await sendNow(draftId)).toMatchObject({
      ok: false,
      refusal: { message: expect.stringContaining('conversation operation') }
    })
    await late({ outcome: 'compacted' })
    await eventually(async () => expect(await submission(draftId)).toBeDefined())
  })

  it('Send-now refuses on a pending prompt and overrides a running turn', async () => {
    const working = await workingSend()
    const queued = await send('queued mid-turn', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'prompt-1' },
      {
        kind: 'approval',
        title: 'Allow the tool?',
        detail: null,
        options: [],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { fence: 1 }
    )
    expect(await sendNow(draftId)).toMatchObject({
      ok: false,
      refusal: { message: expect.stringContaining('pending request') }
    })
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'prompt-1' },
      {
        kind: 'approval',
        title: 'Allow the tool?',
        detail: null,
        options: [],
        resolution: {
          state: 'resolved',
          selectedOptionId: 'allow',
          resolvedBy: 'client-1',
          resolvedAt: 1
        }
      },
      { fence: 1 }
    )
    // The turn still runs (`working`), which Send-now alone may override.
    expect(await submission(working)).toMatchObject({ dispatchState: 'pending' })
    expect(await sendNow(draftId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
  })
})

describe('replay preference', () => {
  it('a replayed send whose draft was refused answers with the returned card, never the rejected submission', async () => {
    const working = await workingSend()
    const body = hostTestMessage('refused later')
    const clientOperationId = hostTestOperationId()
    const params = {
      envelope: envelope(
        { body, delivery: 'queue-if-active' },
        'agentSession.send',
        clientOperationId
      ),
      body,
      delivery: 'queue-if-active' as const
    }
    expect(await host.send(CALLER, params)).toMatchObject({
      ok: true,
      value: { queued: { state: 'waiting' } }
    })
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await submission(clientOperationId)).toBeDefined())
    await settleRejected(clientOperationId, 'provider refused this payload')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([{ messageId: clientOperationId, state: 'returned' }])
    )
    // The original reply was lost; the retry must agree with the card, or the
    // same text renders twice — once on a Retry row, once on the card.
    const replay = await host.send(CALLER, params)
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      value: { queued: { messageId: clientOperationId, state: 'returned' } }
    })
    if (replay.ok && 'submission' in replay.value) {
      throw new Error('replay answered with the rejected submission')
    }
  })
})

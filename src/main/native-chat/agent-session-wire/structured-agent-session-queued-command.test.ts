// Queued drafts across conversation commands: a capable send during a /compact
// in flight becomes a card held by the queue gate's `command` hold and drains
// once the compaction settles, while Delete and Send-now answer at once; a /clear in flight admits no draft onto the
// source it is superseding; and a draft /clear carries to its replacement is
// fingerprinted for the replacement, so the provider's echo folds into its
// sent bubble.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

const WAIT_REFUSAL = {
  ok: false,
  refusal: {
    code: 'agent_session_operation_invalid',
    details: { reason: 'conversationCommandInFlight' },
    message: 'Wait for the conversation operation to finish.'
  }
}

function command(name: 'compact' | 'clear') {
  const fields = { command: name }
  return rig.host.conversationCommand(CALLER, {
    envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
    ...fields
  })
}

function sendBody(body: AgentJournalMessageItem, delivery?: 'queue-if-active') {
  const fields = { body, ...(delivery ? { delivery } : {}) }
  return rig.host.send(CALLER, {
    envelope: rig.envelope(fields, 'agentSession.send', hostTestOperationId()),
    body,
    ...(delivery ? { delivery } : {}),
    userSend: true
  })
}

async function queuedId(
  result: ReturnType<QueuedMessageTestRig['send']>['result']
): Promise<string> {
  const queued = await result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

describe('a /compact in flight', () => {
  /** A compaction whose provider request is still out: the command holds the
   *  session's lane with its record `prepared` until `finish` answers it. */
  async function compactInFlight(): Promise<{
    finish: () => void
    settled: ReturnType<typeof command>
  }> {
    let finish: (() => void) | undefined
    rig.compact.mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<NonNullable<StructuredAgentSessionAdapter['compact']>>>>(
          (resolve) => {
            finish = () => resolve({ outcome: 'compacted' })
          }
        )
    )
    const settled = command('compact')
    await eventually(() => {
      expect(rig.store.getRecord(SESSION)?.conversationCommand).toMatchObject({
        command: 'compact',
        phase: 'prepared'
      })
      expect(finish).toBeDefined()
    })
    return { finish: () => finish?.(), settled }
  }

  it('admits a capable send as a held card at once, and drains it once the compaction settles', async () => {
    const { finish, settled } = await compactInFlight()
    // Answered while the compaction still holds the session's lane.
    const draftId = await queuedId(rig.send('sent while compacting', 'queue-if-active').result)
    expect(await rig.drafts()).toEqual([{ messageId: draftId, state: 'waiting' }])
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await rig.handoff(draftId)).toBeUndefined()
    finish()
    expect(await settled).toMatchObject({ ok: true, value: { command: 'compact' } })
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    expect(await rig.drafts()).toHaveLength(0)
  })

  it('a capable send admitted beside it that the compaction outlives is refused, never dispatched', async () => {
    const { finish, settled } = await compactInFlight()
    const { conversationDelivery } = rig.host.collaboratorsForTests()
    const open = conversationDelivery.open
    let release: (() => void) | undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const spy = vi.spyOn(conversationDelivery, 'open').mockImplementationOnce(async (sessionId) => {
      await released
      return open(sessionId)
    })
    try {
      // Admitted on the compaction's side lane, then parked until the compaction settles.
      const late = rig.send('sent as the compaction ends', 'queue-if-active')
      await eventually(() => expect(spy).toHaveBeenCalled())
      finish()
      expect(await settled).toMatchObject({ ok: true, value: { command: 'compact' } })
      release?.()
      expect(await late.result).toEqual(WAIT_REFUSAL)
      expect(await rig.submission(late.id)).toBeUndefined()
      expect(await rig.drafts()).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('Delete answers and Send-now refuses while it holds the lane; the drain still waits for it', async () => {
    const { finish, settled } = await compactInFlight()
    const deletedId = await queuedId(rig.send('deleted while compacting', 'queue-if-active').result)
    const keptId = await queuedId(rig.send('kept while compacting', 'queue-if-active').result)
    const hung = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000))
    try {
      // Both answer before the compaction does, never after it.
      expect(await Promise.race([rig.deleteQueued(deletedId), hung])).toMatchObject({
        ok: true,
        value: { deleted: true }
      })
      expect(await Promise.race([rig.sendNow(keptId), hung])).toMatchObject({
        ok: false,
        refusal: { message: 'Wait for the conversation operation to finish.' }
      })
      expect(await rig.drafts()).toEqual([{ messageId: keptId, state: 'waiting' }])
      expect(await rig.handoff(keptId)).toBeUndefined()
    } finally {
      finish()
    }
    expect(await settled).toMatchObject({ ok: true, value: { command: 'compact' } })
    await eventually(async () => expect(await rig.handoff(keptId)).toBeDefined())
  })

  it('Send-now is refused before any lane, never queued behind a side-lane Stop to run after the compaction', async () => {
    const { finish, settled } = await compactInFlight()
    const keptId = await queuedId(rig.send('queued while compacting', 'queue-if-active').result)
    // A Stop on the side lane, parked inside its withdrawal step.
    let releaseStop: () => void = () => undefined
    const stopParked = new Promise<void>((resolve) => (releaseStop = resolve))
    const withdraw = AgentSessionJournal.prototype.rejectQueuedSubmissions
    const parked = vi
      .spyOn(AgentSessionJournal.prototype, 'rejectQueuedSubmissions')
      .mockImplementation(async function (this: AgentSessionJournal, ...args) {
        if (args[1].rejection.kind === 'cancelled') {
          await stopParked
        }
        return withdraw.apply(this, args)
      })
    const stopped = rig.stop()
    try {
      await eventually(() => expect(parked).toHaveBeenCalled())
      const hung = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000))
      expect(await Promise.race([rig.sendNow(keptId), hung])).toEqual(WAIT_REFUSAL)
    } finally {
      finish()
      await settled
      releaseStop()
      await stopped
      parked.mockRestore()
    }
    expect(await rig.handoff(keptId)).toBeUndefined()
  })

  it('an immediate or image send keeps the refusal it gets today', async () => {
    const { finish, settled } = await compactInFlight()
    expect(await rig.send('immediate while compacting').result).toEqual(WAIT_REFUSAL)
    const image: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'image-ref', path: '/tmp/shot.png' }]
    }
    expect(await sendBody(image, 'queue-if-active')).toEqual(WAIT_REFUSAL)
    expect(await rig.drafts()).toHaveLength(0)
    finish()
    await settled
    expect((await rig.host.journalSnapshot(SESSION)).submissions).toHaveLength(0)
  })
})

describe('/clear', () => {
  it('in flight, refuses a capable send as today: no card lands on the source it supersedes', async () => {
    const attach = rig.host.attach.bind(rig.host)
    let release: (() => void) | undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const spy = vi.spyOn(rig.host, 'attach').mockImplementationOnce(async (...args) => {
      await released
      return attach(...args)
    })
    try {
      const cleared = command('clear')
      await eventually(() =>
        expect(rig.store.getRecord(SESSION)?.conversationCommand).toMatchObject({
          command: 'clear',
          phase: 'prepared',
          replacementSessionId: expect.any(String)
        })
      )
      expect(await rig.send('sent while clearing', 'queue-if-active').result).toEqual(WAIT_REFUSAL)
      release?.()
      const done = await cleared
      const replacementId = done.ok ? done.value.replacementSessionId : undefined
      if (!replacementId) {
        throw new Error('expected a replacement session')
      }
      expect(await rig.drafts()).toHaveLength(0)
      expect(await rig.drafts(replacementId)).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  it("a carried draft sent on the replacement: the provider's echo folds into its one bubble", async () => {
    const working = await rig.workingSend()
    const draftId = await queuedId(rig.send('carried text', 'queue-if-active').result)
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    const cleared = await command('clear')
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    if (!replacementId) {
      throw new Error('expected a replacement session')
    }
    expect(await rig.sendNow(draftId, hostTestOperationId(), replacementId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
    const journal = rig.host.collaboratorsForTests().sessions.get(replacementId)?.journal
    const sent = journal?.submissions().findLast((entry) => entry.queuedMessageId === draftId)
    if (!journal || !sent) {
      throw new Error('expected the carried draft sent on the replacement')
    }
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-echo', ordinal: 0 },
      hostTestMessage('carried text'),
      { fence: sent.fence }
    )
    const snapshot = await rig.host.journalSnapshot(replacementId)
    const userBubbles = snapshot.items.filter(
      (item) => item.body.kind === 'message' && item.body.role === 'user'
    )
    expect(userBubbles).toHaveLength(1)
    expect(snapshot.submissions.find((entry) => entry.queuedMessageId === draftId)).toMatchObject({
      dispatchState: 'accepted'
    })
  })
})

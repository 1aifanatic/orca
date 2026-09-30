// A Stop's event, through the real host: written in the Stop's serialized step once it takes
// effect, before the interrupt and before anything that ends the child, naming the turn and who
// asked; never by a Stop that stopped nothing.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JournalStopEvent } from '../agent-session-journal/journal-row-schema'
import { HOST_TEST_SESSION, hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

/** Every Stop event in the live epoch, oldest first. */
function stopEvents(): JournalStopEvent[] {
  const since = journal().readSince({ epoch: journal().epoch, sequence: 0 })
  if (!since.ok) {
    throw new Error(`expected rows, got reset ${since.reset}`)
  }
  return since.rows.flatMap((row) =>
    row.kind === 'tombstone' && row.stopEvent ? [row.stopEvent] : []
  )
}

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error(`expected a queued receipt: ${JSON.stringify(queued)}`)
  }
  return queued.value.queued.messageId
}

/** Holds every start until the returned release. */
function holdStart(): () => void {
  let release: () => void = () => undefined
  rig.awaitStarted.mockImplementation(
    () => new Promise<undefined>((resolve) => (release = () => resolve(undefined)))
  )
  return () => release()
}

describe("a Stop's event", () => {
  it('reaches the journal before the interrupt, naming the turn it stopped and who asked', async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    let atInterrupt: JournalStopEvent[] = []
    rig.cancelTurn.mockImplementationOnce(async () => {
      atInterrupt = stopEvents()
      return { cancelled: true }
    })
    const fields = { turnId: 'turn-named' }
    const stopped = await rig.host.cancel(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(fields, 'agentSession.cancel', hostTestOperationId()),
      ...fields
    })
    expect(stopped).toMatchObject({ ok: true })
    expect(rig.cancelTurn).toHaveBeenCalledTimes(1)
    expect(atInterrupt).toEqual([
      {
        reason: 'user-stop',
        turnId: 'turn-named',
        caller: QUEUED_RIG_CALLER.callerKey,
        at: expect.any(Number)
      }
    ])
  })

  it('at an agent still starting, reaches the journal before the start is ended, and holds a card queued before it', async () => {
    rig = await createQueuedMessageTestRig({ starting: true, restartable: true })
    const release = holdStart()
    rig.send('work on this')
    const held = await queuedDraft('queued while it starts')
    let atEnd: JournalStopEvent[] | undefined
    rig.closeSession.mockImplementationOnce(async () => {
      atEnd = stopEvents()
      return true
    })
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    release()
    expect(rig.closeSession).toHaveBeenCalledTimes(1)
    expect(atEnd).toEqual([
      { reason: 'user-stop', caller: QUEUED_RIG_CALLER.callerKey, at: expect.any(Number) }
    ])
    expect(rig.cancelTurn).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await rig.handoff(held)).toBeUndefined()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  })

  it('is written by an idle Stop only when it withdrew a send', async () => {
    rig = await createQueuedMessageTestRig()
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(stopEvents()).toEqual([])
    const release = holdStart()
    const waiting = rig.send('waits for the start')
    await eventually(async () => expect(await rig.submission(waiting.id)).toBeDefined())
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    release()
    expect(rig.cancelTurn).not.toHaveBeenCalled()
    expect(stopEvents()).toEqual([
      { reason: 'user-stop', caller: QUEUED_RIG_CALLER.callerKey, at: expect.any(Number) }
    ])
  })

  it("holds a card when it lands between the queue's pick and its claim", async () => {
    rig = await createQueuedMessageTestRig()
    const working = await rig.workingSend()
    const draftId = await queuedDraft('picked by the drain')
    const open = journal()
    const appendSubmission = open.appendSubmission.bind(open)
    let injected = false
    // Stop and the drain share one serialized lane, so this interleaving is forced: a pause
    // written after the drain chose the card must still hold it in the claim's transaction.
    vi.spyOn(open, 'appendSubmission').mockImplementation(async (input, consume) => {
      if (consume?.yieldsToPause && !injected) {
        injected = true
        await open.appendStopEvent({ reason: 'user-stop' }, input.fence)
      }
      return appendSubmission(input, consume)
    })
    await rig.settleAccepted(working, 'working')
    await eventually(() => expect(injected).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await rig.handoff(draftId)).toBeUndefined()
    expect(await rig.drafts()).toEqual([{ messageId: draftId, state: 'waiting' }])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  })
})

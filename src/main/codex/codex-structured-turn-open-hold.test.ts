// A cold Codex send's dispatch, which the session queue and so a Stop wait behind, lasts until
// Codex opens the turn it answered, or provably will not. The fake keeps Codex 0.157's turn
// bookkeeping: it answers before it opens the turn, and refuses an interrupt until then.

import { describe, expect, it, vi } from 'vitest'
import { classifyDispatchRejection } from '../../shared/structured-agent-session-dispatch-rejection'
import {
  CODEX_TEST_THREAD_ID,
  codexTurnLifecycleRig,
  settledWithin
} from './codex-structured-dispatch-test-support'

const ADMITTED = { state: 'admitted' }

async function answeredColdSend(rig: Awaited<ReturnType<typeof codexTurnLifecycleRig>>) {
  const sending = rig.send('client-1')
  await vi.waitFor(() => expect(rig.turns.turnId).toBe('turn-1'))
  // Read the answer: without the hold, the dispatch settles here.
  expect(await settledWithin(sending)).toBe('held')
  // Wrapped: an async function returning the promise itself would wait for it.
  return { sending }
}

describe("a cold Codex send's handover", () => {
  it('lasts until Codex opens the turn it answered', async () => {
    const rig = await codexTurnLifecycleRig()
    const { sending } = await answeredColdSend(rig)

    rig.turns.start()

    expect(await settledWithin(sending)).toEqual(ADMITTED)
  })

  it('does not wait when Codex opened the turn before its answer was read', async () => {
    const rig = await codexTurnLifecycleRig()
    const release = rig.turns.holdNextAnswer()
    const sending = rig.send('client-1')
    await vi.waitFor(() => expect(rig.turns.turnId).toBe('turn-1'))
    rig.turns.start()

    release()

    expect(await settledWithin(sending)).toEqual(ADMITTED)
  })

  it('does not wait for a send Codex steered into the running turn', async () => {
    const rig = await codexTurnLifecycleRig()
    const { sending: opening } = await answeredColdSend(rig)
    rig.turns.start()
    await opening

    expect(await settledWithin(rig.send('client-2'))).toEqual(ADMITTED)
    expect(rig.turns.turnId).toBe('turn-1')
  })

  it('ends when the turn it answered ends without opening, which settles the send', async () => {
    const rig = await codexTurnLifecycleRig()
    const { sending } = await answeredColdSend(rig)

    rig.turns.end('interrupted')

    expect(await settledWithin(sending)).toEqual(ADMITTED)
    const [settlement] = rig.settlements
    expect(settlement && 'state' in settlement && classifyDispatchRejection(settlement)).toEqual(
      expect.objectContaining({ category: 'withdrawn' })
    )
  })

  it('ends when Codex reports the thread not running', async () => {
    const rig = await codexTurnLifecycleRig()
    const { sending } = await answeredColdSend(rig)

    rig.notify('thread/status/changed', {
      threadId: CODEX_TEST_THREAD_ID,
      status: { type: 'idle' }
    })

    expect(await settledWithin(sending)).toEqual(ADMITTED)
  })

  it('does not end for a child thread that stops running', async () => {
    const rig = await codexTurnLifecycleRig()
    const { sending } = await answeredColdSend(rig)

    rig.notify('thread/status/changed', { threadId: 'thread-child', status: { type: 'idle' } })

    expect(await settledWithin(sending)).toBe('held')
  })

  it('ends when the child exits', async () => {
    const rig = await codexTurnLifecycleRig()
    const { sending } = await answeredColdSend(rig)

    rig.codex.connections[0]!.handlers.onExit?.(new Error('codex app-server exited'))

    expect(await settledWithin(sending)).toEqual(ADMITTED)
  })

  it('ends by the turn/start deadline, counted from the send', async () => {
    const rig = await codexTurnLifecycleRig({ requestTimeoutMs: 150 })
    const { sending } = await answeredColdSend(rig)

    expect(await settledWithin(sending, 400)).toEqual(ADMITTED)
  })
})

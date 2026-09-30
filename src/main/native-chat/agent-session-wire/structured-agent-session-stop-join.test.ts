// A Stop naming its turn or task while a Stop of that same target is still on its way joins
// it, from any client: one interrupt, and every press answered with that Stop's result.
// Each press still passes its own admission and replays from its own receipt.

import { beforeEach, describe, expect, it, type Mock } from 'vitest'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'

let host: StructuredAgentSessionHost
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>

beforeEach(() => {
  ;({ host, cancelTurn } = hostTestState())
})

function stopTurn(
  turnId: string,
  caller = CALLER,
  overrides: Partial<AgentSessionMutationEnvelope> = {}
) {
  return host.cancel(caller, {
    envelope: envelope('agentSession.cancel', { turnId }, overrides),
    turnId
  })
}

/** The provider holds the first interrupt until the test lets it answer. */
function holdFirstInterrupt(): () => void {
  const answer = Promise.withResolvers<undefined>()
  cancelTurn.mockImplementationOnce(async () => {
    await answer.promise
    return { cancelled: true }
  })
  return () => answer.resolve(undefined)
}

describe('a second Stop of the same turn while the first is on its way', () => {
  it('joins it: one interrupt, and both presses answered with its result', async () => {
    await attach()
    const release = holdFirstInterrupt()
    const first = stopTurn('turn-1')
    const second = stopTurn('turn-1', { callerKey: 'client-2' })
    release()

    expect(await first).toMatchObject({ ok: true, value: { turnId: 'turn-1', cancelled: true } })
    expect(await second).toMatchObject({
      ok: true,
      replayed: false,
      value: { turnId: 'turn-1', cancelled: true }
    })
    expect(cancelTurn).toHaveBeenCalledOnce()
  })

  it("replays a joined press's own id from its receipt, without interrupting again", async () => {
    await attach()
    const release = holdFirstInterrupt()
    const joinedEnvelope = envelope('agentSession.cancel', { turnId: 'turn-1' })
    const first = stopTurn('turn-1')
    const joined = host.cancel(CALLER, { envelope: joinedEnvelope, turnId: 'turn-1' })
    release()
    await first
    expect(await joined).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(await host.cancel(CALLER, { envelope: joinedEnvelope, turnId: 'turn-1' })).toMatchObject(
      { ok: true, replayed: true }
    )
    expect(cancelTurn).toHaveBeenCalledOnce()
  })

  it('still refuses a joined press its own admission turns away', async () => {
    await attach()
    const release = holdFirstInterrupt()
    const first = stopTurn('turn-1')
    const mismatched = stopTurn('turn-1', CALLER, { payloadFingerprint: 'not-this-stop' })
    release()

    expect(await first).toMatchObject({ ok: true })
    expect(await mismatched).toMatchObject({ ok: false })
    expect(cancelTurn).toHaveBeenCalledOnce()
  })

  it('answers an older client that sends both presses under one kept id with one interrupt', async () => {
    await attach()
    const release = holdFirstInterrupt()
    const kept = envelope('agentSession.cancel', { turnId: 'turn-1' })
    const presses = [1, 2].map(() => host.cancel(CALLER, { envelope: kept, turnId: 'turn-1' }))
    release()

    const [first, second] = await Promise.all(presses)
    expect(first).toMatchObject({ ok: true, replayed: false, value: { cancelled: true } })
    // The kept id replays from the first press's receipt, as it always has.
    expect(second).toMatchObject({ ok: true, replayed: true })
    expect(cancelTurn).toHaveBeenCalledOnce()
  })

  it('does not join a Stop of a different turn', async () => {
    await attach()
    const release = holdFirstInterrupt()
    const first = stopTurn('turn-1')
    const other = stopTurn('turn-2')
    release()
    await Promise.all([first, other])

    expect(cancelTurn.mock.calls.map(([input]) => input.turnId)).toEqual(['turn-1', 'turn-2'])
  })
})

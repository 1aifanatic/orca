// A Grok start the host aborts — at quit, by a close, or by an admitted Stop — through the one
// signal the host owns, with a scripted Grok, the real record store and an on-disk journal.

import { afterEach, describe, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { waitFor } from './acp-structured-adapter.test-support'
import { attachParams, openHostRig, send, stop } from './acp-structured-host.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const STALLED = Symbol('stalled')
const within = <T>(promise: Promise<T>, ms: number): Promise<T | typeof STALLED> =>
  Promise.race([
    promise,
    new Promise<typeof STALLED>((resolve) => setTimeout(resolve, ms, STALLED))
  ])

/** Runs `atEnd` once, right before the host ends an attach's controller: after its commit. */
function beforeAttachEnds(host: StructuredAgentSessionHost, atEnd: () => void): void {
  const aborts = host.collaboratorsForTests().runtimeState.acquireAborts
  const begin = aborts.begin.bind(aborts)
  let fired = false
  aborts.begin = (sessionId) => {
    const started = begin(sessionId)
    return {
      signal: started.signal,
      end: () => {
        if (!fired) {
          fired = true
          atEnd()
        }
        started.end()
      }
    }
  }
}

/** Runs `during` once, while the attach is still probing the previous owner, before any launch. */
function duringOwnerProbe(host: StructuredAgentSessionHost, during: () => void): void {
  const state = host.collaboratorsForTests().runtimeState
  const probe = state.probeOwner.bind(state)
  let fired = false
  state.probeOwner = async (sessionId) => {
    if (!fired) {
      fired = true
      during()
    }
    return probe(sessionId)
  }
}

describe('a Grok start the host aborts', () => {
  it('quits promptly while Grok never answers its handshake, and stops the child', async () => {
    const { rig, host } = await openHostRig({
      script: (agent) => agent.on('initialize', () => {}),
      deps: { startupTimeoutMs: 60_000 }
    })
    const attaching = host.attach(CALLER, attachParams())
    await rig.frame('initialize')
    // Well inside the start's own bound: the quit is what ends it.
    expect(await within(host.flushAllStreamedEvents({ trigger: 'quit' }), 2_000)).not.toBe(STALLED)
    expect((await attaching).ok).toBe(false)
    expect(rig.child().exited).toBe(true)
    await rig.adapter.closeAll()
  })

  it('closes a chat whose start already returned as a close Orca asked for, not a crash', async () => {
    const { rig, host, store } = await openHostRig()
    const ended: unknown[] = []
    const handle = host.handleAdapterEvent.bind(host)
    host.handleAdapterEvent = (event) => {
      if (event.type === 'ended') {
        ended.push(event)
      }
      return handle(event)
    }
    let closing: Promise<void> | undefined
    beforeAttachEnds(host, () => {
      closing = host.close(SESSION, 'user-close')
    })
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await closing
    expect(rig.child().exited).toBe(true)
    expect(ended).toMatchObject([{ cause: 'requested-close' }])
    expect(store.getRecord(SESSION)?.lease.deathEvidence?.detail).not.toContain('exited')
  })

  it('never launches Grok for a chat closed while its attach was still reconciling', async () => {
    const { rig, host } = await openHostRig({
      script: (agent) => agent.on('initialize', () => {}),
      deps: { startupTimeoutMs: 60_000 }
    })
    let closing: Promise<void> | undefined
    duringOwnerProbe(host, () => {
      closing = host.close(SESSION, 'user-close')
    })
    expect(
      await host.attach(CALLER, attachParams()).catch((error: unknown) => error)
    ).toMatchObject({ name: 'AgentSessionPreSpawnError' })
    expect(await within(closing!, 2_000)).not.toBe(STALLED)
    expect(rig.spawned).not.toContain('spawn')
  })

  it('never launches Grok for a start a Stop reached while its attach was still reconciling', async () => {
    const { rig, host } = await openHostRig()
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    // The chat closes; the next send has to start Grok again.
    await host.close(SESSION, 'user-close')
    let stopping: ReturnType<typeof stop> | undefined
    duringOwnerProbe(host, () => {
      stopping = stop(host)
    })
    await send(host, 'hello')
    await waitFor(() => expect(stopping).toBeDefined())
    expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
    await host.flushStreamedEvents(SESSION)
    expect(rig.spawned.filter((step) => step === 'spawn')).toHaveLength(1)
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    expect(journal.submissions()).toMatchObject([
      { dispatchState: 'rejected', rejection: { kind: 'cancelled' } }
    ])
  })
})

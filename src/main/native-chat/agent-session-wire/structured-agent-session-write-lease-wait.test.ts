// Startup no longer waits for the lease check, so a write can reach a chat whose lease the previous
// app run left unadjudicated. Every write waits for that chat's check (or runs it) before it acts,
// so none is admitted against the old lease and none starts a second agent.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { closeTestJournalHostDatabases } from '../agent-session-journal/journal-host-database-test-support'
import { hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  createStartupRig,
  STARTUP_CALLER,
  type StartupRig
} from './structured-agent-session-startup-listing-test-rig'

let rig: StartupRig
// A failed assertion must not leave teardown waiting on a held probe.
let releaseProbe = (): void => undefined

beforeEach(async () => {
  rig = await createStartupRig()
})

afterEach(async () => {
  releaseProbe()
  await rig.dispose()
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
})

/** Boots over a crashed run and starts the startup lease check with its owner probe held. */
async function bootWithSlowLeaseCheck() {
  await rig.chat('session-a', { message: 'before the restart' })
  await rig.crash()
  const probe = Promise.withResolvers<void>()
  const probing = Promise.withResolvers<void>()
  releaseProbe = probe.resolve
  rig.probeOwner.mockImplementation(async () => {
    probing.resolve()
    await probe.promise
    return { outcome: 'pid-absent' }
  })
  const host = await rig.boot()
  // What startup does now: start the check, and wait for nothing.
  const startupCheck = host.reconcileRestartLeases()
  await probing.promise
  // Every admission, with the lease it was admitted against.
  const admittedUnreconciled: boolean[] = []
  const admit = rig.store.admitMutationOperation
  vi.spyOn(rig.store, 'admitMutationOperation').mockImplementation(async (args) => {
    const admitted = await admit(args)
    admittedUnreconciled.push(admitted?.record.lease.unreconciled ?? true)
    return admitted
  })
  return { host, probe, startupCheck, admittedUnreconciled }
}

/** Long enough for an unheld write to open its chat and be admitted. */
function settleTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 200))
}

describe('a write during a slow startup lease check', () => {
  it('lands a send after the chat’s check, and starts one agent (REQUIRED)', async () => {
    const { probe, startupCheck, admittedUnreconciled } = await bootWithSlowLeaseCheck()

    let answered = false
    const sent = rig.send('session-a', 'after the restart').then((result) => {
      answered = true
      return result
    })
    await settleTasks()
    expect(answered).toBe(false)
    expect(admittedUnreconciled).toEqual([])

    probe.resolve()
    await expect(sent).resolves.toMatchObject({ ok: true })
    await startupCheck
    await vi.waitFor(() => expect(rig.dispatch).toHaveBeenCalledOnce())

    expect(admittedUnreconciled).toEqual([false])
    expect(rig.acquire).toHaveBeenCalledOnce()
  })

  it('holds a Stop until the chat’s check has run', async () => {
    const { host, probe, startupCheck, admittedUnreconciled } = await bootWithSlowLeaseCheck()

    const fields = {}
    const stopped = host.cancel(STARTUP_CALLER, {
      envelope: {
        sessionId: 'session-a',
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: null,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.cancel',
          sessionId: 'session-a',
          fields
        })
      }
    })
    await settleTasks()
    expect(admittedUnreconciled).toEqual([])

    probe.resolve()
    await expect(stopped).resolves.toMatchObject({ ok: true })
    await startupCheck
    expect(admittedUnreconciled).toEqual([false])
    expect(rig.acquire).not.toHaveBeenCalled()
  })
})

import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'

// A chat whose journal this build keeps read-only (a newer Orca's) is not offered for resume and
// not counted as failed, and its offer is kept for an updated Orca to act on.

afterEach(() => vi.restoreAllMocks())

function journalsReadOnly() {
  return vi.spyOn(AgentSessionJournal.prototype, 'isReadOnly', 'get').mockReturnValue(true)
}

it('offers and runs nothing for a read-only chat, keeps its offer, and offers it again once writable', async () => {
  const { host, root, acquire } = await interruptedRestart()
  const readOnly = journalsReadOnly()

  expect(await host.restartResume.list()).toEqual([])
  const action = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(action.continued).toEqual([])
  expect(acquire).not.toHaveBeenCalled()
  expect(await host.restartResume.listFailures()).toEqual([])
  expect((await new AgentSessionRecoveryCapsule(root).list(NOW)).map((m) => m.sessionId)).toEqual([
    SESSION
  ])

  readOnly.mockRestore()
  expect((await host.restartResume.list()).map((candidate) => candidate.sessionId)).toEqual([
    SESSION
  ])
})

it('keeps a failure already filed for a chat that is now read-only, but does not show it', async () => {
  const { host, acquire } = await interruptedRestart()
  await host.restartResume.list()
  acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(await host.restartResume.listFailures()).toMatchObject([{ sessionId: SESSION }])

  const readOnly = journalsReadOnly()
  expect(await host.restartResume.listFailures()).toEqual([])
  readOnly.mockRestore()
  expect(await host.restartResume.listFailures()).toMatchObject([
    { sessionId: SESSION, retryable: true }
  ])
})

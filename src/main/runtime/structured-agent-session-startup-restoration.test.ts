// The host's own startup step, run from `prepare` whether or not any client ever lists a tab: a
// headless host has its seeded statuses and its settled crashed chats, and no failure in the step
// (the lease check, one chat's open, one chat's settlement) costs startup or the other chats.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { readJournalSessionState } from '../native-chat/agent-session-journal/journal-session-state'
import { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  createRestTestRig,
  latestRestTestStatus,
  restTestChat,
  restTestOpens,
  type RestTestRig
} from '../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { OrcaRuntimeService } from './orca-runtime'

type PrepareInternals = {
  store: { getWorkspaceSession: () => unknown }
  hasPersistedStructuredAgentSessionStore(): boolean
  refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
  ensureStructuredAgentSessionHost(): Promise<void>
}

let rig: RestTestRig

beforeEach(async () => {
  rig = await createRestTestRig()
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
})

/** A restarted runtime over the rig's host, with nothing but `prepare` ever called on it. */
function restartedRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these members exist on the runtime; they are protected, not absent.
  const internal = runtime as unknown as PrepareInternals
  internal.store = { getWorkspaceSession: () => null }
  internal.hasPersistedStructuredAgentSessionStore = () => true
  internal.refreshMobileSessionPtyRecords = async () => new Set()
  internal.ensureStructuredAgentSessionHost = async () => {
    setStructuredAgentSessionHost(rig.host)
  }
  return runtime
}

async function crashMidSend(sessionId: string, listed = true): Promise<void> {
  rig.adapter.dispatch.mockResolvedValueOnce({ state: 'admitted' })
  await restTestChat(rig, sessionId, { message: `asked ${sessionId}`, listed })
}

function owes(sessionId: string): boolean | undefined {
  return readJournalSessionState(openTestJournalHostDatabase(rig.root).db, sessionId)?.owesWork
}

it('seeds and settles on a host no client ever lists (T8)', async () => {
  await restTestChat(rig, 'session-settled', { message: 'done' })
  await crashMidSend('session-crashed')
  await crashMidSend('session-crashed-closed', false)
  await rig.crash()
  await rig.boot()
  const runtime = restartedRuntime()

  await runtime.prepareStructuredAgentSessionStartupRestoration()

  expect(latestRestTestStatus(rig, 'session-settled')).toMatchObject({ status: 'idle' })
  await vi.waitFor(() => {
    expect(owes('session-crashed')).toBe(false)
    expect(owes('session-crashed-closed')).toBe(false)
  })
  expect(rig.host.hasSession('session-crashed')).toBe(true)
  expect(rig.host.hasSession('session-crashed-closed')).toBe(false)
  expect(restTestOpens(rig, 'session-settled')).toBe(0)
})

it('never fails startup: each failure is logged by chat and the rest still settle (T18)', async () => {
  await restTestChat(rig, 'session-settled', { message: 'done' })
  for (const sessionId of ['session-open-fails', 'session-settle-fails', 'session-fine']) {
    await crashMidSend(sessionId)
  }
  await rig.crash()
  await rig.boot()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const leaseCheck = new Error('lease check failed')
  vi.spyOn(rig.host, 'reconcileRestartLeases').mockRejectedValueOnce(leaseCheck)
  rig.adapter.historyFilePath.mockImplementation(async (sessionId) => {
    if (sessionId === 'session-open-fails') {
      throw new Error('EACCES: permission denied')
    }
    return null
  })
  const markUnknown = AgentSessionJournal.prototype.markPendingSubmissionsUnknown
  vi.spyOn(AgentSessionJournal.prototype, 'markPendingSubmissionsUnknown').mockImplementation(
    function (this: AgentSessionJournal, ...args) {
      if (this.snapshot().sessionId === 'session-settle-fails') {
        return Promise.reject(new Error('settlement append failed'))
      }
      return markUnknown.apply(this, args)
    }
  )
  const runtime = restartedRuntime()

  // The lease check's failure is still the step's answer, unchanged.
  await expect(runtime.prepareStructuredAgentSessionStartupRestoration()).rejects.toBe(leaseCheck)

  expect(latestRestTestStatus(rig, 'session-settled')).toMatchObject({ status: 'idle' })
  await vi.waitFor(() => expect(owes('session-fine')).toBe(false))
  expect(owes('session-open-fails')).toBe(true)
  expect(owes('session-settle-fails')).toBe(true)
  expect(warn).toHaveBeenCalledWith(
    '[structured-agent-session] restoring a chat for reading failed',
    expect.objectContaining({ sessionId: 'session-open-fails' })
  )
})

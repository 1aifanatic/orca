// The host's own startup step, run from `prepare` whether or not any client ever lists a tab: a
// headless host has its seeded statuses and its settled crashed chats, and no failure in the step
// (one chat's open, one chat's settlement) costs startup or the other chats.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  closeTestJournalHostDatabases,
  readTestJournalSessionStatus
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { isUnsettledJournalSessionStatus } from '../native-chat/agent-session-journal/journal-session-state'
import { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  createRestTestRig,
  latestRestTestStatus,
  restTestChat,
  restTestOpens,
  type RestTestRig
} from '../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { OrcaRuntimeService } from './orca-runtime'
import { StructuredAgentSessionStartupGate } from './structured-agent-session-startup-gate'

type PrepareInternals = {
  structuredAgentSessionStartupGate: StructuredAgentSessionStartupGate
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

function internals(runtime: OrcaRuntimeService): PrepareInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these members exist on the runtime; they are protected, not absent.
  return runtime as unknown as PrepareInternals
}

/** A restarted runtime over the rig's host, with nothing but `prepare` ever called on it. */
function restartedRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  const internal = internals(runtime)
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
  const stored = readTestJournalSessionStatus(rig.root, sessionId)
  return stored ? isUnsettledJournalSessionStatus(stored) : undefined
}

it('holds chat commands until the startup settle ends, and then lets them through', async () => {
  await crashMidSend('session-crashed')
  await rig.crash()
  await rig.boot()
  const runtime = restartedRuntime()
  const gate = internals(runtime).structuredAgentSessionStartupGate
  const timing = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  runtime.holdStructuredAgentSessionCommandsForStartup()
  expect(gate.ready()).not.toBeNull()

  await runtime.prepareStructuredAgentSessionStartupRestoration()
  await vi.waitFor(() => expect(owes('session-crashed')).toBe(false))

  await vi.waitFor(() => expect(gate.ready()).toBeNull())
  expect(timing).toHaveBeenCalledWith(
    expect.stringMatching(/step started \+\d+ ms, ended \+\d+ ms; opened \+\d+ ms by settle ended$/)
  )
})

it('opens the gate when the startup step fails, never stranding a command', async () => {
  await rig.crash()
  await rig.boot()
  const runtime = restartedRuntime()
  const gate = internals(runtime).structuredAgentSessionStartupGate
  internals(runtime).ensureStructuredAgentSessionHost = async () => {
    throw new Error('host refused')
  }
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  runtime.holdStructuredAgentSessionCommandsForStartup()

  const timing = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  await runtime.prepareStructuredAgentSessionStartupRestoration().catch(() => undefined)

  expect(gate.ready()).toBeNull()
  expect(timing).toHaveBeenCalledWith(expect.stringMatching(/by step failed$/))
})

it('logs one timing line per launch, naming the ceiling when it opened the gate first', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const timing = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const gate = new StructuredAgentSessionStartupGate(5)
  gate.hold()
  gate.stepStarted()
  let endSettle = () => {}
  gate.openWhen(new Promise<void>((resolve) => (endSettle = resolve)))
  await vi.waitFor(() => expect(gate.ready()).toBeNull())
  // Written once the step is over too, so it carries both times.
  expect(timing).not.toHaveBeenCalled()

  endSettle()
  await vi.waitFor(() => expect(timing).toHaveBeenCalledOnce())
  expect(timing).toHaveBeenCalledWith(
    expect.stringMatching(/ended \+\d+ ms; opened \+\d+ ms by ceiling$/)
  )
})

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

  await runtime.prepareStructuredAgentSessionStartupRestoration()

  expect(latestRestTestStatus(rig, 'session-settled')).toMatchObject({ status: 'idle' })
  await vi.waitFor(() => expect(owes('session-fine')).toBe(false))
  expect(owes('session-open-fails')).toBe(true)
  expect(owes('session-settle-fails')).toBe(true)
  expect(warn).toHaveBeenCalledWith(
    '[structured-agent-session] restoring a chat for reading failed',
    expect.objectContaining({ sessionId: 'session-open-fails' })
  )
})

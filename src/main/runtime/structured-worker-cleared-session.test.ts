/**
 * A structured worker the user `/clear`ed carries on in a successor session. Every worker-level
 * reader and actor must reach the session running it now, and say `unverifiable` — never `exited`
 * — when it cannot find that session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { readStructuredWorkerTerminal } = await import('./structured-worker-terminal-read')
const { observeStructuredWorker, resolveStructuredWorkerAuthority } =
  await import('./structured-worker-authority')
const { structuredSessionMailTarget, structuredSessionOwnedMailboxes } =
  await import('./orchestration/structured-session-mail-target')
const { stopStructuredWorker, readStructuredWorkerJournal, captureStructuredWorkerArchive } =
  await import('./rpc/methods/orchestration-structured-worker-lifecycle')
const { releaseStructuredWorkerSession } =
  await import('./rpc/methods/orchestration-structured-worker-session')
const { inspectWorkerTerminal } =
  await import('./rpc/methods/orchestration/worker/worker-observation')
const { listAddressableStructuredWorkers } =
  await import('./orchestration/structured-worker-group-addressing')
const { structuredSessionChildIdentityEnv } =
  await import('./structured-session-child-identity-env')
const { OrcaRuntimeService } = await import('./orca-runtime')
const { OrchestrationDb } = await import('./orchestration/db')
const { structuredWorkerOwesWork } = await import('./structured-worker-custody')
const { AGENT_SESSION_NOT_ATTACHED } =
  await import('../native-chat/agent-session-wire/structured-agent-session-mutation-admission')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('./structured-worker-identity')

type Db = InstanceType<typeof OrchestrationDb>

const MINTED = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SUCCESSOR = 'clear-a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const SECOND = 'clear-ffeeddccbbaa99887766554433221100ffeeddcc'
const LOCAL_SCOPE = { kind: 'local', hostId: 'local' } as const

/** Opens the protected mail resolver and the orchestration database a real runtime holds. */
class RuntimeProbe extends OrcaRuntimeService {
  withDb(db: Db | null): this {
    this._orchestrationDb = db
    return this
  }

  mailTarget(mailboxHandle: string): unknown {
    return this.resolveStructuredMailboxTarget(mailboxHandle)
  }
}

function message(id: string, text: string): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    observedAt: 1,
    sequence: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }
}

type SessionState = 'live' | 'at-rest' | 'exited'

function record(
  sessionId: string,
  state: SessionState,
  clearedInto: string | null = null
): AgentSessionRecord {
  const base = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId,
      claimStatus: state === 'live' ? 'live' : 'released',
      deathEvidence:
        state === 'exited' ? { kind: 'exit-observed', detail: 'closed', observedAt: 2 } : null
    })
  )
  return {
    ...base,
    location: { ...base.location, workspaceId: 'wt_1' },
    ...(clearedInto
      ? {
          conversationCommand: {
            command: 'clear',
            runtimeFence: 7,
            operationId: `op-clear-${sessionId}`,
            callerKey: 'renderer',
            phase: 'committed',
            state: 'completed',
            replacementSessionId: clearedInto
          }
        }
      : {})
  }
}

const records = new Map<string, AgentSessionRecord>()
let visibleTabs: string[] = []
let historyFailure: Error | null = null
/** Set to commit a /clear of the minted session while its close waits behind it. */
let clearDuringClose = false
const closed: string[] = []
const historyAsked: string[] = []
const journalAsked: string[] = []

/**
 * As `/clear` leaves a worker: the minted session stopped by the clear and pointing at its
 * successor, and the chat tab renamed to the successor.
 */
function installClearedWorker(successor: 'live' | 'at-rest' = 'live'): void {
  records.clear()
  records.set(MINTED, record(MINTED, 'exited', SUCCESSOR))
  records.set(SUCCESSOR, record(SUCCESSOR, successor))
  visibleTabs = [SUCCESSOR]
  installHost()
}

function installHost(): void {
  hostRef.current = {
    deps: {
      store: {
        getRecord: (id: string) => records.get(id) ?? null,
        listRecords: () => [...records.values()],
        getVisibleSessionTabIndex: () => ({ present: true, sessionIds: visibleTabs }),
        getSessionTabId: () => null
      },
      logger: { warn: () => {} }
    },
    hasSession: (id: string) => records.get(id)?.lease.claimStatus === 'live',
    getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: visibleTabs }),
    journalSnapshot: async (id: string) => {
      journalAsked.push(id)
      if (!records.has(id)) {
        throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
      }
      return { items: [message(`${id}-1`, 'idle')], submissions: [] }
    },
    setSessionTabVisibility: async () => {},
    close: async (id: string) => {
      closed.push(id)
      if (clearDuringClose && id === MINTED) {
        // The clear held the session's lock first: it commits, then this close runs.
        clearDuringClose = false
        records.set(MINTED, record(MINTED, 'exited', SUCCESSOR))
        records.set(SUCCESSOR, record(SUCCESSOR, 'live'))
        visibleTabs = [SUCCESSOR]
        return
      }
      const prior = records.get(id)
      if (prior) {
        records.set(id, { ...prior, lease: { ...prior.lease, claimStatus: 'released' } })
      }
    },
    history: async ({ sessionId }: { sessionId: string }) => {
      historyAsked.push(sessionId)
      if (historyFailure) {
        throw historyFailure
      }
      const text = sessionId === MINTED ? 'PRE-CLEAR (stale)' : 'POST-CLEAR (live work)'
      return { page: { items: [message(`${sessionId}-1`, text)], hasOlder: false } }
    }
  }
}

function registerWorker() {
  return structuredWorkerIdentities.register({
    handle: mintStructuredWorkerHandle(),
    sessionId: MINTED,
    agent: 'claude',
    paneKey: mintStructuredWorkerPaneKey(MINTED),
    processIncarnation: structuredWorkerProcessIncarnation(MINTED),
    worktreeId: 'wt_1',
    hostScope: LOCAL_SCOPE
  })
}

/** A ready worker Dispatch owning the worker's terminal resource, as worker-start leaves it. */
function startWorkerDispatch(db: Db, identity: ReturnType<typeof registerWorker>): string {
  const runId = db.createRun({
    objective: 'cleared worker',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  }).id
  const task = db.createTask({ runId, spec: 'work' })
  const { dispatch } = db.createStartingWorkerDispatch({
    taskId: task.id,
    startOptions: {},
    creator: { kind: 'system' },
    maxDepth: 9
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: identity.handle,
    paneKey: identity.paneKey,
    processIncarnation: identity.processIncarnation,
    worktreeId: 'wt_1',
    effects: [],
    setupState: 'not_configured',
    hostScope: JSON.stringify(LOCAL_SCOPE),
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(dispatch.id)
  return dispatch.id
}

function readJournal(identity: ReturnType<typeof registerWorker>) {
  return readStructuredWorkerJournal({
    identity,
    dispatchId: 'ctx_1',
    workerState: 'ready',
    liveness: 'live',
    agent: 'claude'
  })
}

const CLEARED_WARNING = 'Earlier conversation from before a /clear is not included.'

let db: Db

beforeEach(() => {
  structuredWorkerIdentities.clear()
  closed.length = 0
  historyAsked.length = 0
  journalAsked.length = 0
  historyFailure = null
  clearDuringClose = false
  db = new OrchestrationDb(':memory:')
})

afterEach(() => {
  db.close()
  hostRef.current = null
})

describe.each(['live', 'at-rest'] as const)(
  'a /clear-ed structured worker whose successor is %s',
  (successor) => {
    beforeEach(() => installClearedWorker(successor))

    it('keeps its authority, judged on and naming the successor', () => {
      const identity = registerWorker()
      expect(resolveStructuredWorkerAuthority(identity.handle, null)?.record.sessionId).toBe(
        SUCCESSOR
      )
    })

    it('is observed on the successor, never as the exited minted session', () => {
      const identity = registerWorker()
      const expected = successor === 'live' ? 'live' : 'unverifiable'
      expect(observeStructuredWorker(identity).status).toBe(expected)
      // The settlement probe holds only the incarnation, and no registry entry.
      structuredWorkerIdentities.clear()
      return expect(
        new OrcaRuntimeService().inspectTerminalProcessIncarnationLiveness(
          structuredWorkerProcessIncarnation(MINTED),
          JSON.stringify(LOCAL_SCOPE)
        )
      ).resolves.toBe(expected)
    })

    it("serves terminal read from the successor's journal", async () => {
      const identity = registerWorker()
      const read = await readStructuredWorkerTerminal({ handle: identity.handle, db: null })
      expect(historyAsked).toEqual([SUCCESSOR])
      expect(JSON.stringify(read)).toContain('POST-CLEAR')
    })

    it('serves worker-read from the successor and says the earlier conversation is left out', async () => {
      const read = await readJournal(registerWorker())
      expect(historyAsked).toEqual([SUCCESSOR])
      expect(JSON.stringify(read.transcript)).toContain('POST-CLEAR')
      expect(read.warnings).toContain(CLEARED_WARNING)
    })

    it('freezes the successor into the release archive, with the same warning', async () => {
      const archive = await captureStructuredWorkerArchive(registerWorker(), 'claude')
      expect(JSON.stringify(archive.messages)).toContain('POST-CLEAR')
      expect(archive.warnings).toContain(CLEARED_WARNING)
    })

    it("retains the worker when the successor's journal cannot be read", async () => {
      historyFailure = new Error('journal busy')
      await expect(
        captureStructuredWorkerArchive(registerWorker(), 'claude')
      ).rejects.toMatchObject({ code: 'archive_failed' })
      expect(historyAsked).toEqual([SUCCESSOR])
    })

    it('shows the worker through the successor in worker-show', async () => {
      const identity = registerWorker()
      const dispatchId = startWorkerDispatch(db, identity)
      const shown = await inspectWorkerTerminal(new OrcaRuntimeService(), db, dispatchId)
      expect(shown).toMatchObject({
        exact: true,
        status: successor === 'live' ? 'live' : 'unverifiable',
        addressable: true
      })
    })

    it('stops the worker by closing the successor', async () => {
      const stop = await stopStructuredWorker(registerWorker(), 'ctx_1')
      expect(closed).toEqual([SUCCESSOR])
      expect(stop.stopped).toBe(true)
    })

    it("reports the successor's status to @idle", async () => {
      const identity = registerWorker()
      await expect(new OrcaRuntimeService().getAgentStatusForHandle(identity.handle)).resolves.toBe(
        'idle'
      )
      expect(journalAsked).toEqual([SUCCESSOR])
    })

    it('stays a group-address recipient', () => {
      const identity = registerWorker()
      startWorkerDispatch(db, identity)
      expect(listAddressableStructuredWorkers(db)).toEqual([
        { handle: identity.handle, worktreeId: 'wt_1', agentIdentity: 'claude' }
      ])
    })

    it('routes direct and Dispatch mail to the successor', () => {
      const identity = registerWorker()
      const dispatchId = startWorkerDispatch(db, identity)
      const runtime = new RuntimeProbe().withDb(db)
      expect(runtime.mailTarget(identity.handle)).toEqual({ sessionId: SUCCESSOR, dispatchId })
      expect(runtime.mailTarget(`dispatch:${dispatchId}`)).toEqual({
        sessionId: SUCCESSOR,
        dispatchId
      })
    })

    it("re-derives the worker's Dispatch mailbox on the successor's idle edge", () => {
      const identity = registerWorker()
      const dispatchId = startWorkerDispatch(db, identity)
      expect(structuredSessionOwnedMailboxes(SUCCESSOR, db)).toContain(`dispatch:${dispatchId}`)
    })

    it("gives the successor's child the worker's handle", () => {
      const identity = registerWorker()
      expect(structuredSessionChildIdentityEnv(SUCCESSOR, {}).ORCA_TERMINAL_HANDLE).toBe(
        identity.handle
      )
    })

    it("records the user's takeover when they type into the successor", () => {
      const identity = registerWorker()
      expect(new RuntimeProbe().withDb(db).getStructuredWorkerPaneKeyForSession(SUCCESSOR)).toBe(
        identity.paneKey
      )
    })

    it("keeps the successor running for the worker's open Dispatch", () => {
      startWorkerDispatch(db, registerWorker())
      expect(structuredWorkerOwesWork(db, records.get(SUCCESSOR)!)).toBe(true)
    })

    it('finds the worker from its durable row after a restart', () => {
      const identity = registerWorker()
      startWorkerDispatch(db, identity)
      structuredWorkerIdentities.clear()
      expect(new RuntimeProbe().withDb(db).getStructuredWorkerPaneKeyForSession(SUCCESSOR)).toBe(
        identity.paneKey
      )
      structuredWorkerIdentities.clear()
      expect(resolveStructuredWorkerAuthority(identity.handle, db)?.record.sessionId).toBe(
        SUCCESSOR
      )
    })
  }
)

describe('stopping a worker while a /clear commits', () => {
  it('closes the successor the clear handed the worker to', async () => {
    records.clear()
    records.set(MINTED, record(MINTED, 'live'))
    visibleTabs = [MINTED]
    installHost()
    clearDuringClose = true
    const stop = await stopStructuredWorker(registerWorker(), 'ctx_1')
    expect(closed).toEqual([MINTED, SUCCESSOR])
    expect(stop.stopped).toBe(true)
  })
})

describe('a worker cleared twice', () => {
  beforeEach(() => {
    records.clear()
    records.set(MINTED, record(MINTED, 'exited', SUCCESSOR))
    records.set(SUCCESSOR, record(SUCCESSOR, 'exited', SECOND))
    records.set(SECOND, record(SECOND, 'live'))
    visibleTabs = [SECOND]
    installHost()
  })

  it('is read and stopped through the newest session', async () => {
    const identity = registerWorker()
    expect(resolveStructuredWorkerAuthority(identity.handle, null)?.record.sessionId).toBe(SECOND)
    expect(JSON.stringify((await readJournal(identity)).transcript)).toContain('POST-CLEAR')
    expect(historyAsked).toEqual([SECOND])
    await stopStructuredWorker(identity, 'ctx_1')
    expect(closed).toEqual([SECOND])
  })

  it('forgets parked mail on every session of the lineage at settlement, binding or not', () => {
    const forgetStructuredSessionMail = vi.fn()
    // No binding: what a restarted runtime holds when the worker settles.
    releaseStructuredWorkerSession('ctx_after_restart', { forgetStructuredSessionMail }, MINTED)
    expect(forgetStructuredSessionMail.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      MINTED,
      SUCCESSOR,
      SECOND
    ])
  })
})

describe('a running session that cannot be verified is refused, never declared exited', () => {
  async function expectRefused(identity: ReturnType<typeof registerWorker>, code: string) {
    await expect(readJournal(identity)).rejects.toMatchObject({ code })
    await expect(captureStructuredWorkerArchive(identity, 'claude')).rejects.toMatchObject({
      code
    })
    await expect(
      readStructuredWorkerTerminal({ handle: identity.handle, db: null })
    ).rejects.toMatchObject({ code })
    const stop = await stopStructuredWorker(identity, 'ctx_1')
    expect(stop).toMatchObject({ stopped: false, closeAttempted: false })
    expect(stop.reason).toContain('No effects were applied')
    expect(historyAsked).toEqual([])
    expect(closed).toEqual([])
  }

  it('when the clear names a successor with no record', async () => {
    records.clear()
    records.set(MINTED, record(MINTED, 'exited', SUCCESSOR))
    visibleTabs = [SUCCESSOR]
    installHost()
    const identity = registerWorker()
    expect(observeStructuredWorker(identity).status).toBe('unverifiable')
    await expect(
      new OrcaRuntimeService().inspectTerminalProcessIncarnationLiveness(
        identity.processIncarnation,
        JSON.stringify(LOCAL_SCOPE)
      )
    ).resolves.toBe('unverifiable')
    await expectRefused(identity, 'session_caller_not_live')
  })

  it('when the lineage loops back on itself', async () => {
    records.clear()
    records.set(MINTED, record(MINTED, 'exited', SUCCESSOR))
    records.set(SUCCESSOR, record(SUCCESSOR, 'live', MINTED))
    visibleTabs = [SUCCESSOR]
    installHost()
    const identity = registerWorker()
    expect(observeStructuredWorker(identity).status).toBe('unverifiable')
    expect(structuredSessionMailTarget(MINTED, null)).toBeNull()
    await expectRefused(identity, 'session_caller_not_live')
  })

  it('when the structured host is not installed', async () => {
    hostRef.current = null
    const identity = registerWorker()
    await expect(readJournal(identity)).rejects.toMatchObject({ code: 'session_caller_not_live' })
    await expect(captureStructuredWorkerArchive(identity, 'claude')).rejects.toMatchObject({
      code: 'session_caller_not_live'
    })
  })

  it('with the host-boundary refusal when the successor runs on another host', async () => {
    installClearedWorker()
    const successor = records.get(SUCCESSOR)!
    records.set(SUCCESSOR, {
      ...successor,
      location: { ...successor.location, executionHostId: 'ssh:box' }
    })
    const identity = registerWorker()
    expect(observeStructuredWorker(identity).status).toBe('unverifiable')
    await expectRefused(identity, 'session_caller_host_boundary')
  })
})

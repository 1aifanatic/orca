// Real hosts over one real record store and journal database, booted in turn the way app runs
// follow each other, for the tests of what a restarted host lists and owes before anyone opens a
// chat. Every journal open calls the adapter's `historyFilePath` once, so that is the open counter,
// and holding it holds the open.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionStatusEvent
} from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_NOW,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

export const STARTUP_CALLER = { callerKey: 'client-1' }

export type StartupRig = {
  root: string
  store: AgentSessionRecordStore
  host: StructuredAgentSessionHost
  acquire: Mock<StructuredAgentSessionAdapter['acquire']>
  dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
  /** Called once per journal open, with the session id; replace its implementation to hold one. */
  historyFilePath: Mock<(sessionId: string) => Promise<string | null>>
  probeOwner: Mock<(record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>>
  /** Workspaces this host's adapter does not serve, as a platform gate would. */
  unsupportedWorkspaceIds: Set<string>
  statusEvents: AgentSessionStatusEvent[]
  /** Creates the chat, lists its tab unless told not to, and sends `message` when one is given,
   *  waiting for its dispatch. */
  chat: (
    sessionId: string,
    options?: { workspaceId?: string; listed?: boolean; message?: string }
  ) => Promise<void>
  send: (sessionId: string, text: string) => ReturnType<StructuredAgentSessionHost['send']>
  opensOf: (sessionId: string) => number
  /** A crash: nothing settles or flushes; the process's timers and handles simply stop. */
  crash: () => Promise<void>
  /** A new app run over the same files; the counters and status stream start empty. */
  boot: (deps?: Partial<StructuredAgentSessionHostDeps>) => Promise<StructuredAgentSessionHost>
  dispose: () => Promise<void>
}

export function startupSendEnvelope(
  sessionId: string,
  body: ReturnType<typeof hostTestMessage>
): AgentSessionMutationEnvelope {
  return {
    sessionId,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: null,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId,
      fields: { body }
    })
  }
}

function startupAttachParams(
  sessionId: string,
  workspaceId: string,
  fence: number | null
): AgentSessionAttachParams {
  return hostTestAttachParams(fence, {
    envelope: {
      sessionId,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: fence,
      payloadFingerprint: ''
    },
    location: { ...HOST_TEST_LOCATION, workspaceId },
    providerHandle: { kind: 'codex', threadId: `thread-${sessionId}` }
  })
}

export async function createStartupRig(
  root?: string,
  deps: Partial<StructuredAgentSessionHostDeps> = {}
): Promise<StartupRig> {
  resetHostTestOperationIds()
  const stateRoot = root ?? (await mkdtemp(join(tmpdir(), 'orca-startup-listing-')))
  const directory = join(stateRoot, 'store')
  const statusEvents: AgentSessionStatusEvent[] = []
  const historyFilePath = vi.fn(async (_sessionId: string): Promise<string | null> => null)
  const probeOwner: StartupRig['probeOwner'] = vi.fn(async () => ({ outcome: 'pid-absent' }))
  const unsupportedWorkspaceIds = new Set<string>()
  let ordinal = 0
  const acquire: StartupRig['acquire'] = vi.fn(async ({ fence, spawnToken, identity }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    link: {
      linkId: `link-${identity.sessionId}-${fence}`,
      handle: { provider: 'codex' as const, threadId: `thread-${identity.sessionId}` },
      origin: rig.store.getRecord(identity.sessionId)?.providerHandleChain.length
        ? ('resumed' as const)
        : ('created' as const),
      mintedAtFence: fence,
      observedAt: HOST_TEST_NOW
    }
  }))
  const dispatch: StartupRig['dispatch'] = vi.fn(async (input) => {
    ordinal += 1
    return {
      state: 'accepted',
      providerIdentity: {
        provider: 'codex',
        threadId: `thread-${input.sessionId}`,
        turnId: `turn-${ordinal}`,
        ordinal
      }
    }
  })
  const open = async (overrides: Partial<StructuredAgentSessionHostDeps>) => {
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    const host = new StructuredAgentSessionHost({
      store,
      adapter: {
        acquire,
        dispatch,
        closeSession: vi.fn(async () => true),
        releaseAcquisition: vi.fn(async () => true),
        cancelTurn: async () => ({ cancelled: true }),
        answerPrompt: async ({ commit }) => commit(),
        setOption: async () => undefined,
        historyFilePath: ({ identity }) => historyFilePath(identity.sessionId),
        supportsCreate: (location, agent) =>
          agent === 'codex' && !unsupportedWorkspaceIds.has(location.workspaceId)
      },
      journalDatabase: openTestJournalHostDatabase(stateRoot),
      claimKeyId: 'key-1',
      mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
      probeOwner,
      now: () => HOST_TEST_NOW,
      ...deps,
      ...overrides
    })
    host.subscribeStatus({ id: 'status', emit: (event) => statusEvents.push(event) })
    return { store, host }
  }
  const first = await open({})
  const rig: StartupRig = {
    root: stateRoot,
    ...first,
    acquire,
    dispatch,
    historyFilePath,
    probeOwner,
    unsupportedWorkspaceIds,
    statusEvents,
    chat: async (sessionId, options = {}) => {
      const attached = await rig.host.attach(
        STARTUP_CALLER,
        startupAttachParams(
          sessionId,
          options.workspaceId ?? 'workspace-1',
          rig.store.getRecord(sessionId)?.lease.runtimeFence ?? null
        )
      )
      if (!attached.ok) {
        throw new Error(`attach refused: ${attached.refusal.code}`)
      }
      if (options.listed !== false) {
        await rig.store.setSessionTabVisibility(sessionId, true)
      }
      if (options.message === undefined) {
        return
      }
      const dispatched = dispatch.mock.calls.length
      const sent = await rig.send(sessionId, options.message)
      if (!sent.ok) {
        throw new Error(`send refused: ${sent.refusal.code}`)
      }
      await vi.waitFor(() => expect(dispatch.mock.calls.length).toBeGreaterThan(dispatched))
    },
    send: (sessionId, text) => {
      const body = hostTestMessage(text)
      return rig.host.send(STARTUP_CALLER, { body, envelope: startupSendEnvelope(sessionId, body) })
    },
    opensOf: (sessionId) => historyFilePath.mock.calls.filter(([id]) => id === sessionId).length,
    crash: async () => {
      const { runtimeState, lifetime, sessions } = rig.host.collaboratorsForTests()
      await runtimeState.stopLeaseRenewal()
      lifetime.dispose()
      for (const session of sessions.values()) {
        await session.journal.close()
      }
      sessions.clear()
    },
    boot: async (overrides = {}) => {
      // What the new run saw, and nothing the previous one did.
      historyFilePath.mockClear()
      acquire.mockClear()
      dispatch.mockClear()
      probeOwner.mockClear()
      statusEvents.length = 0
      const next = await open(overrides)
      rig.store = next.store
      rig.host = next.host
      return next.host
    },
    dispose: async () => {
      await rig.host.flushAllStreamedEvents().catch(() => undefined)
      if (!root) {
        await rm(stateRoot, { recursive: true, force: true })
      }
    }
  }
  return rig
}

/** The newest row the status stream carried for a session. */
export function latestStatus(rig: StartupRig, sessionId: string) {
  for (const event of rig.statusEvents.toReversed()) {
    if (event.type === 'status' && event.session.sessionId === sessionId) {
      return event.session
    }
    if (event.type === 'snapshot') {
      const found = event.sessions.find((session) => session.sessionId === sessionId)
      if (found) {
        return found
      }
    }
  }
  return undefined
}

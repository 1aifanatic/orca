// A profile whose chat records a newer Orca wrote opens read-only. The startup reconcile cannot
// write there, which is bookkeeping: startup must still finish rather than put the whole app into
// its degraded "Session restore failed" mode, and the file must be left exactly as it was.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type * as FileTransactionLock from '../file-transaction-lock'
import { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import { journalIdentityFor } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { attachParamsForRecord } from '../native-chat/agent-session-wire/structured-agent-session-conversation-open'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  AGENT_SESSION_STORE_SCHEMA_VERSION,
  agentSessionStorePath
} from './agent-session-record-store-file'
import { OrcaRuntimeService } from './orca-runtime'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const lock = vi.hoisted(() => ({ failing: false }))

vi.mock('../file-transaction-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof FileTransactionLock>()
  return {
    ...actual,
    withFileTransactionLock: (...args: Parameters<typeof actual.withFileTransactionLock>) =>
      lock.failing
        ? // What proper-lockfile throws once its retries give up.
          Promise.reject(
            Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' })
          )
        : actual.withFileTransactionLock(...args)
  }
})

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-startup-reconcile-'))
})

afterEach(async () => {
  lock.failing = false
  await stopStructuredAgentSessionRuntime().catch(() => undefined)
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

const PROMPT = 'add a retry'

/** A profile's record store with one chat in it; one a newer Orca wrote opens read-only here. */
async function seedStore(options: { newer: boolean; visible?: boolean }) {
  const storeDirectory = join(root, 'agent-sessions')
  const path = agentSessionStorePath(storeDirectory)
  const record = agentSessionRecordFixture()
  await mkdir(storeDirectory, { recursive: true })
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: AGENT_SESSION_STORE_SCHEMA_VERSION + (options.newer ? 1 : 0),
      hostId: 'local',
      records: { [record.sessionId]: record },
      operations: {},
      retiredClaimKeys: [],
      unusableRecords: {},
      ...(options.visible ? { visibleSessionIds: [record.sessionId] } : {})
    })
  )
  return { storeDirectory, path, record, sessionId: record.sessionId }
}

/** The chat's history as the last run left it: one prompt, accepted. */
async function seedHistory(record: AgentSessionRecord): Promise<void> {
  const fence = record.lease.runtimeFence
  const database = JournalHostDatabase.open(root)
  const journal = await openAgentSessionJournal({
    identity: journalIdentityFor(
      record,
      attachParamsForRecord(record, { clientOperationId: 'seed', expectedRuntimeFence: fence })
    ),
    database
  })
  await journal.appendSubmission({
    clientMessageId: 'client-1',
    payloadFingerprint: 'fp-1',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: PROMPT }] },
    fence,
    handoverRecorded: true
  })
  await journal.resolveDispatch({
    clientMessageId: 'client-1',
    fence,
    state: 'accepted',
    providerIdentity: null
  })
  await journal.close()
  database.close()
}

function startupRuntime(
  onError?: (input: { scope: string; error: unknown }) => void,
  afterInstall?: () => void
) {
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the runtime's own protected members; the test roots the host at `root` and stubs the PTY daemon.
  const internal = runtime as unknown as {
    hasPersistedStructuredAgentSessionStore(): boolean
    ensureStructuredAgentSessionHost(): Promise<unknown>
    refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
    mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  }
  internal.hasPersistedStructuredAgentSessionStore = () => true
  internal.ensureStructuredAgentSessionHost = async () => {
    const installed = await ensureStructuredAgentSessionHost({
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root,
      resolveEnvironment: async () => ({}),
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
      ...(onError ? { onError } : {})
    })
    afterInstall?.()
    return installed
  }
  internal.refreshMobileSessionPtyRecords = async () => new Set<string>()
  return { runtime, publishedTabs: () => internal.mobileSessionTabsByWorktree.get('workspace-1') }
}

it('finishes startup over records a newer Orca wrote, reports it, and writes nothing', async () => {
  const { storeDirectory, path, sessionId } = await seedStore({ newer: true })
  const bytes = await readFile(path)
  const files = await readdir(storeDirectory)
  const onError = vi.fn()
  const { runtime } = startupRuntime(onError)

  // What the renderer's startup awaits through `app:prepareTerminalStartupRestoration`.
  await expect(runtime.prepareStructuredAgentSessionStartupRestoration()).resolves.toBeUndefined()

  // Startup does not wait for the check; its failure is reported when it lands.
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
  expect(onError).toHaveBeenCalledWith({
    scope: 'structured-agent-session-lease-reconcile',
    error: expect.objectContaining({ message: 'agent_session_legacy_required' })
  })
  expect(getStructuredAgentSessionHost()?.sessionAgent(sessionId)).toBe('claude')
  await stopStructuredAgentSessionRuntime()
  expect(await readFile(path)).toEqual(bytes)
  expect(await readdir(storeDirectory)).toEqual(files)
})

// The desktop installs its host with no error sink, so the failure is logged rather than dropped.
it('logs the failure when the host has no error sink', async () => {
  await seedStore({ newer: true })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  await expect(
    startupRuntime().runtime.prepareStructuredAgentSessionStartupRestoration()
  ).resolves.toBeUndefined()

  await vi.waitFor(() =>
    expect(warn).toHaveBeenCalledWith(
      '[structured-agent-session] reconciling chat leases failed',
      expect.objectContaining({ message: 'agent_session_legacy_required' })
    )
  )
})

// With native chat on, the renderer's startup also awaits the chat tab restore (`session.tabs.listAll`),
// which reads every chat whose tab was open at quit. That read must not wait on the lease bookkeeping.
describe('restoring the chat tabs open at quit', () => {
  async function expectChatRestored(
    runtime: OrcaRuntimeService,
    publishedTabs: () => RuntimeMobileSessionTabsSnapshot | undefined,
    sessionId: string
  ) {
    await expect(runtime.restoreStructuredAgentSessionTabs()).resolves.toBeUndefined()
    expect(publishedTabs()?.tabs.map((tab) => tab.id)).toEqual([`agent-session:${sessionId}`])
    const host = getStructuredAgentSessionHost()
    // History opens after the tabs are listed; this joins that restore rather than running another.
    await host!.restoreReadableSessions([sessionId])
    expect(JSON.stringify((await host!.journalSnapshot(sessionId)).items)).toContain(PROMPT)
  }

  /** The reconcile failure once, though startup and the read both ran it; the tab write per chat. */
  function expectReported(
    onError: ReturnType<typeof vi.fn>,
    warn: ReturnType<typeof vi.spyOn>,
    sessionId: string,
    failure: Record<string, unknown>
  ) {
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith({
      scope: 'structured-agent-session-lease-reconcile',
      error: expect.objectContaining(failure)
    })
    expect(warn).toHaveBeenCalledWith(
      '[structured-agent-session] recording a restored chat tab failed',
      { sessionId, error: expect.objectContaining(failure) }
    )
  }

  it('lists and reads a chat from records a newer Orca wrote, and writes nothing', async () => {
    const { storeDirectory, path, record } = await seedStore({ newer: true, visible: true })
    await seedHistory(record)
    const bytes = await readFile(path)
    const files = await readdir(storeDirectory)
    const onError = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { runtime, publishedTabs } = startupRuntime(onError)

    await expectChatRestored(runtime, publishedTabs, record.sessionId)

    expectReported(onError, warn, record.sessionId, { message: 'agent_session_legacy_required' })
    await stopStructuredAgentSessionRuntime()
    expect(await readFile(path)).toEqual(bytes)
    expect(await readdir(storeDirectory)).toEqual(files)
  })

  it('lists and reads a chat while the record store lock keeps failing', async () => {
    const { record } = await seedStore({ newer: false, visible: true })
    await seedHistory(record)
    const onError = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // Free when the store opens, then held for good: every later write gives up.
    const { runtime, publishedTabs } = startupRuntime(onError, () => {
      lock.failing = true
    })

    await expectChatRestored(runtime, publishedTabs, record.sessionId)

    expectReported(onError, warn, record.sessionId, { code: 'ELOCKED' })
    lock.failing = false
  })
})

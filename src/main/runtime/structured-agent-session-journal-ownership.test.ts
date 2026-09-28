// One Orca process owns a profile's structured chats. Another on the same profile is refused
// with words that say what to do, is never advertised to the CLI, and takes over when the owner
// quits. An owner whose journal will not open refuses every chat and leaves the file alone.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAgentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import { JOURNAL_DB_SCHEMA_VERSION } from '../native-chat/agent-session-journal/journal-database-schema'
import {
  JournalHostDatabase,
  journalDatabasePath
} from '../native-chat/agent-session-journal/journal-host-database'
import { JOURNAL_OWNER_LOCK_FILE } from '../native-chat/agent-session-journal/journal-owner-lock'
import {
  holdJournalOwnerLockInChild,
  probeJournalOwnerLockInChild,
  type JournalOwnerLockHolder
} from '../native-chat/agent-session-journal/journal-owner-lock-test-support'
import { JOURNAL_NEWER_SCHEMA_MESSAGE } from '../native-chat/agent-session-journal/journal-open-failure'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import Database from '../sqlite/sync-database'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { OrcaRuntimeService } from './orca-runtime'
import { requireStructuredCleanupHost } from './rpc/methods/structured-agent-session-gate'
import { assertLegacyAiVaultResumeCommandAllowed } from '../ai-vault/structured-session-ownership'
import type { RpcContext } from './rpc/core'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import {
  JOURNAL_OWNER_REFUSAL_MESSAGES,
  onStructuredAgentSessionJournalOwned,
  releaseStructuredAgentSessionJournal,
  setJournalOwnerProcessKind,
  type JournalOwnerProcessKind
} from './structured-agent-session-journal-ownership'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

let root: string
let holder: JournalOwnerLockHolder | null = null
// A refused startup waits for ownership; a later test's claim must not wake an earlier runtime.
const stopAwaitingOwnership: (() => void)[] = []

// An in-process caller: the same build as the host, so the gate asks it for no capability.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the cleanup gate reads only `clientKind` and `clientCapabilities`.
const IN_PROCESS = {} as RpcContext

function install(): ReturnType<typeof ensureStructuredAgentSessionHost> {
  return ensureStructuredAgentSessionHost({
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveEnvironment: async () => ({}),
    reapOrphanChildren: async () => [],
    resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true })
  })
}

/** The refusal as the gate throws it for every structured request. */
function gateRefusal(): { reason: unknown; message: string } {
  try {
    requireStructuredCleanupHost(IN_PROCESS)
  } catch (error) {
    if (isAgentSessionRefusalError(error)) {
      return { reason: error.refusal.details?.reason, message: error.refusal.message }
    }
    throw error
  }
  throw new Error('the gate admitted the request')
}

async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-ownership-'))
})

afterEach(async () => {
  stopAwaitingOwnership.splice(0).forEach((stop) => stop())
  await holder?.kill()
  holder = null
  await stopStructuredAgentSessionRuntime().catch(() => undefined)
  releaseStructuredAgentSessionJournal()
  setJournalOwnerProcessKind('packaged')
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('a second process on the same profile', () => {
  // T-dev-refusal, in its dev, packaged and orcad variants.
  it.each<JournalOwnerProcessKind>(['dev-desktop', 'packaged', 'orcad'])(
    'is refused with the %s words, and never opens the database',
    async (kind) => {
      holder = await holdJournalOwnerLockInChild(root)
      setJournalOwnerProcessKind(kind)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      await expect(install()).rejects.toMatchObject({
        refusal: {
          code: 'agent_session_journal_unreadable',
          message: JOURNAL_OWNER_REFUSAL_MESSAGES[kind],
          details: { reason: 'journalOwnedElsewhere', processKind: kind }
        }
      })
      expect(gateRefusal()).toEqual({
        reason: 'journalOwnedElsewhere',
        message: JOURNAL_OWNER_REFUSAL_MESSAGES[kind]
      })
      expect(getStructuredAgentSessionHost()).toBeNull()
      expect(existsSync(journalDatabasePath(root))).toBe(false)
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('agent-session-journal.owner; structured chats are read-refused')
      )
    }
  )

  // T-B1 / N-R3.3: when the owner dies, the refused process takes the lock itself and its next
  // request runs the full install — not a flag flip.
  it('takes over once the owner dies, with a full install', async () => {
    holder = await holdJournalOwnerLockInChild(root)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(install()).rejects.toMatchObject({
      refusal: { details: { reason: 'journalOwnedElsewhere' } }
    })

    await holder.kill()
    holder = null

    // Its retry took the lock: no process refuses it any more, and nothing is installed yet.
    await vi.waitFor(() => expect(gateRefusal().reason).toBe('hostDisabled'), { timeout: 10_000 })
    await expect(install()).resolves.toBeDefined()
    expect(getStructuredAgentSessionHost()).not.toBeNull()
    expect(existsSync(journalDatabasePath(root))).toBe(true)
    expect(await probeJournalOwnerLockInChild(root)).toBe('refused')
  })

  // Discovery points the CLI only at the process that owns the chats.
  it('is not published to the CLI until it owns the chats', async () => {
    holder = await holdJournalOwnerLockInChild(root)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath: root,
      journalStateDirectory: root
    })
    try {
      await server.start()
      expect(readRuntimeMetadata(root)).toBeNull()

      await holder.kill()
      holder = null
      await vi.waitFor(() => expect(readRuntimeMetadata(root)?.pid).toBe(process.pid), {
        timeout: 10_000
      })
    } finally {
      await server.stop()
    }
  })

  // Not opening the lock file proves no ownership: the process that does own the chats stays the
  // one the CLI finds, until this one's retry takes the lock.
  it('does not publish over the owner while its lock file will not open', async () => {
    const lockPath = join(root, JOURNAL_OWNER_LOCK_FILE)
    await writeFile(lockPath, 'not a database '.repeat(512))
    const metadataPath = getRuntimeMetadataPath(root)
    await writeFile(metadataPath, JSON.stringify({ pid: 999_999, runtimeId: 'the-owner' }))
    const before = await digest(metadataPath)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath: root,
      journalStateDirectory: root
    })
    try {
      await server.start()
      expect(await digest(metadataPath)).toBe(before)

      await unlink(lockPath)
      await vi.waitFor(() => expect(readRuntimeMetadata(root)?.pid).toBe(process.pid), {
        timeout: 10_000
      })
    } finally {
      await server.stop()
    }
  })
})

describe('the owner, when its journal will not open', () => {
  // T-corrupt-open: the error surfaces, every chat says it cannot be loaded, and nothing is
  // renamed, deleted or rebuilt.
  it('refuses every chat and leaves a damaged file exactly as it is', async () => {
    const path = journalDatabasePath(root)
    await writeFile(path, 'not a database '.repeat(512))
    const before = await digest(path)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(install()).rejects.toMatchObject({
      refusal: { message: 'Unable to load this chat.', details: { reason: 'journalCorrupt' } }
    })
    expect(gateRefusal()).toEqual({
      reason: 'journalCorrupt',
      message: 'Unable to load this chat.'
    })
    expect(await digest(path)).toBe(before)
    expect(existsSync(`${path}-wal`)).toBe(false)
    expect(existsSync(`${path}-shm`)).toBe(false)

    // Once a person moves the file aside, the next request installs.
    await unlink(path)
    await expect(install()).resolves.toBeDefined()
    expect(gateRefusal).toThrow('the gate admitted the request')
  })

  // T5: a newer build's database is refused as one that can clear, and left byte-identical.
  it('refuses a database a newer Orca wrote, and leaves it byte-identical', async () => {
    const path = journalDatabasePath(root)
    const seeded = new Database(path)
    seeded.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`)
    seeded.close()
    const before = await digest(path)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(install()).rejects.toMatchObject({
      refusal: { message: JOURNAL_NEWER_SCHEMA_MESSAGE, details: { reason: 'journalUnavailable' } }
    })
    expect(gateRefusal()).toEqual({
      reason: 'journalUnavailable',
      message: JOURNAL_NEWER_SCHEMA_MESSAGE
    })
    expect(await digest(path)).toBe(before)
  })
})

describe('logging a journal that will not open', () => {
  const OPEN_FAILED = '[structured-agent-session] opening the chat journal database failed'

  async function writeJunkJournal(): Promise<void> {
    const path = journalDatabasePath(root)
    await rm(`${path}-wal`, { force: true })
    await rm(`${path}-shm`, { force: true })
    await writeFile(path, 'not a database '.repeat(512))
  }

  // Every chat request retries the open; the same failure each time is one log, not one per request.
  it('logs a repeated failure once, with its stack, and again after an open succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const openFailureLogs = () => warn.mock.calls.filter(([message]) => message === OPEN_FAILED)
    await install()
    await stopStructuredAgentSessionRuntime()
    await writeJunkJournal()

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(install()).rejects.toMatchObject({
        refusal: { details: { reason: 'journalCorrupt' } }
      })
    }
    expect(openFailureLogs()).toHaveLength(1)
    expect(openFailureLogs()[0]?.[1]).toBeInstanceOf(Error)
    expect(openFailureLogs()[0]?.[1]).toHaveProperty('stack', expect.stringContaining('\n'))

    await unlink(journalDatabasePath(root))
    await install()
    await stopStructuredAgentSessionRuntime()
    await writeJunkJournal()
    await expect(install()).rejects.toMatchObject({
      refusal: { details: { reason: 'journalCorrupt' } }
    })
    expect(openFailureLogs()).toHaveLength(2)
  })
})

// A refused host is a no-host state for startup: the app restores terminals and tabs as usual,
// and only structured requests are refused.
describe('startup and other non-chat work without a structured host', () => {
  function startupRuntime(ensureHost: () => Promise<unknown> = install) {
    const runtime = new OrcaRuntimeService()
    const refreshPtyRecords = vi.fn(async () => new Set<string>())
    const hydrateTabs = vi.fn(() => new Set<string>())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the runtime's own protected members; the test roots the host at `root` and stubs the PTY daemon.
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      ensureStructuredAgentSessionHost(): Promise<unknown>
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      getKnownWorkspaceSessionWorktreeIds(): Set<string>
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string>
      stopAwaitingStructuredAgentSessionJournal: (() => void) | null
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.ensureStructuredAgentSessionHost = ensureHost
    internal.refreshMobileSessionPtyRecords = refreshPtyRecords
    internal.getKnownWorkspaceSessionWorktreeIds = () => new Set(['workspace-1'])
    internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = hydrateTabs
    stopAwaitingOwnership.push(() => internal.stopAwaitingStructuredAgentSessionJournal?.())
    return { runtime, refreshPtyRecords, hydrateTabs }
  }

  async function expectStartupWithoutHost(runtime: OrcaRuntimeService): Promise<void> {
    await expect(runtime.prepareStructuredAgentSessionStartupRestoration()).resolves.toBeUndefined()
    // What `session.tabs.list` awaits before it answers a paired client.
    await expect(runtime.restoreStructuredAgentSessionTabs()).resolves.toBeUndefined()
    expect(getStructuredAgentSessionHost()).toBeNull()
  }

  it('goes ahead while another process owns the chats', async () => {
    holder = await holdJournalOwnerLockInChild(root)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { runtime, refreshPtyRecords, hydrateTabs } = startupRuntime()

    await expectStartupWithoutHost(runtime)

    expect(refreshPtyRecords).toHaveBeenCalledOnce()
    expect(hydrateTabs).toHaveBeenCalledWith('workspace-1', {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    expect(gateRefusal().reason).toBe('journalOwnedElsewhere')
  })

  it('goes ahead when the owner cannot open its journal', async () => {
    await writeFile(journalDatabasePath(root), 'not a database '.repeat(512))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { runtime, refreshPtyRecords, hydrateTabs } = startupRuntime()

    await expectStartupWithoutHost(runtime)

    expect(refreshPtyRecords).toHaveBeenCalledOnce()
    expect(hydrateTabs).toHaveBeenCalledWith('workspace-1', {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    expect(gateRefusal()).toEqual({
      reason: 'journalCorrupt',
      message: 'Unable to load this chat.'
    })
  })

  // Not a database, as a sync or restore tool can leave it: SQLite answers errcode 26 on its claim.
  it('goes ahead when the owner lock file cannot be opened', async () => {
    await writeFile(join(root, JOURNAL_OWNER_LOCK_FILE), 'not a database '.repeat(512))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { runtime, refreshPtyRecords } = startupRuntime()

    await expectStartupWithoutHost(runtime)

    expect(refreshPtyRecords).toHaveBeenCalledOnce()
    expect(gateRefusal()).toEqual({
      reason: 'journalCorrupt',
      message: 'Unable to load this chat.'
    })

    // The claim keeps retrying; once the file opens, the takeover installs as it does after an owner quits.
    await unlink(join(root, JOURNAL_OWNER_LOCK_FILE))
    await vi.waitFor(() => expect(getStructuredAgentSessionHost()).not.toBeNull(), {
      timeout: 10_000
    })
  })

  function heldOnce(mock: ReturnType<typeof vi.fn>): () => void {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    mock.mockImplementationOnce(async () => {
      await held
      return new Set<string>()
    })
    return release
  }

  // The inventory must say "cannot tell", never "no chats": a client culls what an answer omits,
  // and the desktop then saves its chat tabs away.
  describe('the session-tabs inventory', () => {
    /** The worktree's frame as the renderer's own graph publication leaves it: no chat rows. */
    const WORKTREE_FRAME: RuntimeMobileSessionTabsResult = {
      worktree: 'workspace-1',
      publicationEpoch: 'renderer-epoch',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }

    function publishWorktreeFrame(runtime: OrcaRuntimeService): void {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime's own protected store, called as its graph publication does.
      const internal = runtime as unknown as {
        storeMobileSessionSnapshot(worktreeId: string, snapshot: unknown): unknown
      }
      internal.storeMobileSessionSnapshot('workspace-1', WORKTREE_FRAME)
    }

    async function listInventory(runtime: OrcaRuntimeService) {
      await runtime.restoreStructuredAgentSessionTabs()
      return runtime.listAllMobileSessionTabs()
    }

    it('marks chats unverifiable while another process owns them', async () => {
      holder = await holdJournalOwnerLockInChild(root)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { runtime } = startupRuntime()
      publishWorktreeFrame(runtime)

      const frames = await listInventory(runtime)

      expect(frames).toEqual([
        expect.objectContaining({ worktree: 'workspace-1', agentSessionsUnverifiable: true })
      ])
    })

    it('marks chats unverifiable when the owner cannot open its journal', async () => {
      await writeFile(journalDatabasePath(root), 'not a database '.repeat(512))
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { runtime } = startupRuntime()
      publishWorktreeFrame(runtime)

      const frames = await listInventory(runtime)

      expect(frames).toEqual([
        expect.objectContaining({ worktree: 'workspace-1', agentSessionsUnverifiable: true })
      ])
    })

    // A tap's reply goes straight back to the tapping client, not through the list.
    it.each<RuntimeNavigationTarget>(['caller', 'clients'])(
      'marks a %s navigation reply unverifiable while another process owns the chats',
      async (navigation) => {
        holder = await holdJournalOwnerLockInChild(root)
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const { runtime } = startupRuntime()
        publishWorktreeFrame(runtime)
        await listInventory(runtime)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime's own protected navigation step, called as `session.tabs.activate` does.
        const internal = runtime as unknown as {
          applyMobileSessionTabNavigation(
            snapshot: RuntimeMobileSessionTabsResult,
            activeTabId: string,
            navigation: RuntimeNavigationTarget,
            clientNavigationId?: string
          ): RuntimeMobileSessionTabsResult
        }

        const reply = internal.applyMobileSessionTabNavigation(
          WORKTREE_FRAME,
          'agent-session:claude-1',
          navigation,
          'phone-1'
        )

        expect(reply).toMatchObject({ worktree: 'workspace-1', agentSessionsUnverifiable: true })
      }
    )

    it('lists no chats as a real answer once the owner has a host', async () => {
      const { runtime } = startupRuntime()
      publishWorktreeFrame(runtime)

      const frames = await listInventory(runtime)

      expect(frames).toHaveLength(1)
      expect(frames[0]).not.toHaveProperty('agentSessionsUnverifiable')
      expect(getStructuredAgentSessionHost()).not.toBeNull()
    })

    it('restores on its own after a takeover, pushing the chats without the mark', async () => {
      holder = await holdJournalOwnerLockInChild(root)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const reconciled = vi.fn(async () => undefined)
      // The real install; its host's open conversations stand in for the chats its readable
      // restore reopens.
      const { runtime, refreshPtyRecords } = startupRuntime(async () => {
        const host = await install()
        vi.spyOn(host, 'listSessionTabs').mockReturnValue([
          { workspaceId: 'workspace-1', sessionId: 'claude-1', agent: 'claude' },
          { workspaceId: 'workspace-1', sessionId: 'codex-1', agent: 'codex' }
        ])
        vi.spyOn(host, 'setSessionTabVisibility').mockResolvedValue(undefined)
        vi.spyOn(host, 'reconcileRestartLeases').mockImplementation(reconciled)
        return host
      })
      publishWorktreeFrame(runtime)
      expect((await listInventory(runtime))[0]).toMatchObject({ agentSessionsUnverifiable: true })
      // A paired phone's subscription: nothing on the desktop lists or opens a chat after this.
      const pushed: RuntimeMobileSessionTabsResult[] = []
      const unsubscribe = runtime.onMobileSessionTabsChanged((frame) => pushed.push(frame))

      await holder.kill()
      holder = null

      const chats = [
        expect.objectContaining({ type: 'agent-session', sessionId: 'claude-1', agent: 'claude' }),
        expect.objectContaining({ type: 'agent-session', sessionId: 'codex-1', agent: 'codex' })
      ]
      await vi.waitFor(() => expect(pushed.at(-1)?.tabs).toEqual(chats), { timeout: 10_000 })
      unsubscribe()
      expect(pushed.at(-1)).not.toHaveProperty('agentSessionsUnverifiable')
      expect(getStructuredAgentSessionHost()).not.toBeNull()
      expect(reconciled).toHaveBeenCalledOnce()
      expect(refreshPtyRecords).toHaveBeenCalledTimes(2)
      const frames = await runtime.listAllMobileSessionTabs()
      expect(frames).toEqual([expect.objectContaining({ tabs: chats })])
      expect(frames[0]).not.toHaveProperty('agentSessionsUnverifiable')
      expect(reconciled).toHaveBeenCalledOnce()
    })

    /** A startup whose host has a Claude chat once the takeover installs it. */
    function takeoverRuntime() {
      const reconciled = vi.fn(async () => undefined)
      const started = startupRuntime(async () => {
        const host = await install()
        vi.spyOn(host, 'listSessionTabs').mockReturnValue([
          { workspaceId: 'workspace-1', sessionId: 'claude-1', agent: 'claude' }
        ])
        vi.spyOn(host, 'setSessionTabVisibility').mockResolvedValue(undefined)
        vi.spyOn(host, 'reconcileRestartLeases').mockImplementation(reconciled)
        return host
      })
      publishWorktreeFrame(started.runtime)
      return { ...started, reconciled }
    }

    const CLAUDE_CHAT = expect.objectContaining({ type: 'agent-session', sessionId: 'claude-1' })

    it('pushes the chats when a list lands during the refused startup, after the takeover', async () => {
      holder = await holdJournalOwnerLockInChild(root)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { runtime, refreshPtyRecords, reconciled } = takeoverRuntime()
      const releaseRefresh = heldOnce(refreshPtyRecords)
      const pushed: RuntimeMobileSessionTabsResult[] = []
      const unsubscribe = runtime.onMobileSessionTabsChanged((frame) => pushed.push(frame))
      const startup = runtime.prepareStructuredAgentSessionStartupRestoration()
      await vi.waitFor(() => expect(refreshPtyRecords).toHaveBeenCalledOnce())

      await holder.kill()
      holder = null
      await vi.waitFor(() => expect(gateRefusal().reason).toBe('hostDisabled'), { timeout: 10_000 })
      // Still on the refused startup's memo, so this list cannot tell.
      const listed = listInventory(runtime)
      releaseRefresh()
      await startup

      expect((await listed)[0]).toMatchObject({ agentSessionsUnverifiable: true, tabs: [] })
      await vi.waitFor(() => expect(pushed.at(-1)?.tabs).toEqual([CLAUDE_CHAT]), {
        timeout: 10_000
      })
      unsubscribe()
      expect(pushed.at(-1)).not.toHaveProperty('agentSessionsUnverifiable')
      expect(reconciled).toHaveBeenCalledOnce()
    })

    it('pushes the chats when a list heals them during the takeover install', async () => {
      holder = await holdJournalOwnerLockInChild(root)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { runtime, refreshPtyRecords } = takeoverRuntime()
      expect((await listInventory(runtime))[0]).toMatchObject({ agentSessionsUnverifiable: true })
      const releaseRefresh = heldOnce(refreshPtyRecords)
      const pushed: RuntimeMobileSessionTabsResult[] = []
      const unsubscribe = runtime.onMobileSessionTabsChanged((frame) => pushed.push(frame))

      await holder.kill()
      holder = null
      // The takeover's own startup restoration is refreshing PTYs, with its host installed.
      await vi.waitFor(() => expect(refreshPtyRecords).toHaveBeenCalledTimes(2), {
        timeout: 10_000
      })
      const listed = listInventory(runtime)
      releaseRefresh()

      expect((await listed)[0]?.tabs).toEqual([CLAUDE_CHAT])
      await vi.waitFor(() => expect(pushed.at(-1)?.tabs).toEqual([CLAUDE_CHAT]), {
        timeout: 10_000
      })
      unsubscribe()
      expect(pushed.at(-1)).not.toHaveProperty('agentSessionsUnverifiable')
    })
  })

  describe('quitting while refused', () => {
    function holdCatalogFlush(): () => void {
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      vi.spyOn(agentModelCatalogStore, 'flushPersistence').mockImplementationOnce(() => held)
      return release
    }

    it('does not take the lock once the stop has begun', async () => {
      holder = await holdJournalOwnerLockInChild(root)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { runtime } = startupRuntime()
      await runtime.prepareStructuredAgentSessionStartupRestoration()
      const owned = vi.fn()
      stopAwaitingOwnership.push(onStructuredAgentSessionJournalOwned(owned))
      const releaseFlush = holdCatalogFlush()
      const stopping = stopStructuredAgentSessionRuntime()

      await holder.kill()
      holder = null
      // Past the longest retry delay: a retry still scheduled would have taken the lock by now.
      await new Promise((resolve) => setTimeout(resolve, 5_500))
      releaseFlush()
      await stopping

      expect(owned).not.toHaveBeenCalled()
      expect(getStructuredAgentSessionHost()).toBeNull()
      expect(existsSync(journalDatabasePath(root))).toBe(false)
    })

    it('tears down a takeover install that lands during the stop', async () => {
      holder = await holdJournalOwnerLockInChild(root)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { runtime, refreshPtyRecords } = startupRuntime(async () => {
        const host = await install()
        vi.spyOn(host, 'reconcileRestartLeases').mockResolvedValue(undefined)
        return host
      })
      const releaseRefresh = heldOnce(refreshPtyRecords)
      const startup = runtime.prepareStructuredAgentSessionStartupRestoration()
      await vi.waitFor(() => expect(refreshPtyRecords).toHaveBeenCalledOnce())
      await holder.kill()
      holder = null
      // Taken before the quit: the takeover waits on the refused startup's PTY refresh.
      await vi.waitFor(() => expect(gateRefusal().reason).toBe('hostDisabled'), { timeout: 10_000 })
      const closed = vi.spyOn(JournalHostDatabase.prototype, 'close')
      const releaseFlush = holdCatalogFlush()
      const stopping = stopStructuredAgentSessionRuntime()

      releaseRefresh()
      await startup
      await vi.waitFor(() => expect(getStructuredAgentSessionHost()).not.toBeNull(), {
        timeout: 10_000
      })
      releaseFlush()
      await stopping

      expect(getStructuredAgentSessionHost()).toBeNull()
      expect(closed).toHaveBeenCalledOnce()
    })

    // An install that finishes after a later pass cleared the registry registers the host that pass
    // then tears down: no request after the stop may be handed that host.
    it('leaves no host registered when a takeover install spans a teardown pass', async () => {
      holder = await holdJournalOwnerLockInChild(root)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { runtime, refreshPtyRecords } = startupRuntime(async () => {
        const host = await install()
        vi.spyOn(host, 'reconcileRestartLeases').mockResolvedValue(undefined)
        return host
      })
      const releaseRefresh = heldOnce(refreshPtyRecords)
      const startup = runtime.prepareStructuredAgentSessionStartupRestoration()
      await vi.waitFor(() => expect(refreshPtyRecords).toHaveBeenCalledOnce())
      // Only the takeover's install opens the record store, and it waits there.
      const openStore = AgentSessionRecordStore.open.bind(AgentSessionRecordStore)
      let releaseOpen!: () => void
      const openHeld = new Promise<void>((resolve) => (releaseOpen = resolve))
      const opened = vi
        .spyOn(AgentSessionRecordStore, 'open')
        .mockImplementationOnce(async (input) => {
          await openHeld
          return openStore(input)
        })
      await holder.kill()
      holder = null
      await vi.waitFor(() => expect(gateRefusal().reason).toBe('hostDisabled'), { timeout: 10_000 })
      const closed = vi.spyOn(JournalHostDatabase.prototype, 'close')
      const releaseFlush = holdCatalogFlush()
      const stopping = stopStructuredAgentSessionRuntime()

      releaseRefresh()
      await startup
      await vi.waitFor(() => expect(opened).toHaveBeenCalled(), { timeout: 10_000 })
      releaseFlush()
      // The second pass clears the registry and waits on the install, which then registers its host.
      await new Promise((resolve) => setTimeout(resolve, 50))
      releaseOpen()
      await stopping

      expect(closed).toHaveBeenCalledOnce()
      expect(getStructuredAgentSessionHost()).toBeNull()
    })
  })

  it('lets a terminal resume command through while another process owns the chats', async () => {
    holder = await holdJournalOwnerLockInChild(root)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    // The check `terminal.send` and `session.tabs.createTerminal` run before typing a resume.
    await expect(
      assertLegacyAiVaultResumeCommandAllowed('claude --resume 0f9c1d2e', async () => {
        await install()
      })
    ).resolves.toBeUndefined()
    await expect(
      assertLegacyAiVaultResumeCommandAllowed('claude --resume 0f9c1d2e', async () => {
        throw new Error('the record store would not open')
      })
    ).rejects.toThrow('the record store would not open')
    expect(gateRefusal().reason).toBe('journalOwnedElsewhere')
  })

  it('still fails on an install error that refuses nothing', async () => {
    const { runtime, refreshPtyRecords } = startupRuntime(async () => {
      throw new Error('the record store would not open')
    })

    await expect(runtime.prepareStructuredAgentSessionStartupRestoration()).rejects.toThrow(
      'the record store would not open'
    )
    expect(refreshPtyRecords).not.toHaveBeenCalled()
  })
})

describe('releasing ownership', () => {
  it('lets another process take the chats only after a clean stop', async () => {
    await install()
    expect(await probeJournalOwnerLockInChild(root)).toBe('refused')

    await stopStructuredAgentSessionRuntime()

    expect(await probeJournalOwnerLockInChild(root)).toBe('acquired')
  })

  it('keeps the chats until a journal close that failed is retried and goes through', async () => {
    await install()
    const close = JournalHostDatabase.prototype.close
    let connectionClose: ReturnType<typeof vi.fn> | null = null
    const journalClose = vi
      .spyOn(JournalHostDatabase.prototype, 'close')
      .mockImplementation(function (this: JournalHostDatabase) {
        // The connection's first close fails, as a native close can before it completes.
        connectionClose ??= vi.spyOn(this.db, 'close').mockImplementationOnce(() => {
          throw new Error('unable to close due to unfinalized statements')
        })
        close.call(this)
      })
    const journal = () => journalClose.mock.contexts[0]

    await expect(stopStructuredAgentSessionRuntime()).rejects.toThrow('unable to close')
    expect(journal()).toHaveProperty('isClosed', false)
    expect(await probeJournalOwnerLockInChild(root)).toBe('refused')

    await stopStructuredAgentSessionRuntime()
    expect(connectionClose).toHaveBeenCalledTimes(2)
    expect(journal()).toHaveProperty('isClosed', true)
    expect(await probeJournalOwnerLockInChild(root)).toBe('acquired')
  })
})

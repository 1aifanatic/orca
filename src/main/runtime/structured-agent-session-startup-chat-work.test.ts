// The runtime's startup chat work, which the background copy of old chat files waits for: startup
// restoration until its first try settles, tab listings, and the owed history restore until it has
// started. Each signal on its own holds the copy, and each clears.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { PerChatFileCopyStart } from '../native-chat/agent-session-wire/structured-agent-session-per-chat-file-copy-control'
import { OrcaRuntimeService } from './orca-runtime'
import { StructuredAgentSessionStartupChatWork } from './structured-agent-session-startup-chat-work'

afterEach(() => setStructuredAgentSessionHost(null))

/** Chat work whose restoration has settled, so each test sees only its own signal. */
async function preparedChatWork(): Promise<StructuredAgentSessionStartupChatWork> {
  const work = new StructuredAgentSessionStartupChatWork()
  await work.trackRestorationPrepare(async () => undefined)
  return work
}

const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('the startup chat work the background copy waits for (R3M-2)', () => {
  it('holds until startup restoration’s first try settles, resolved or not', async () => {
    const resolved = new StructuredAgentSessionStartupChatWork()
    expect(resolved.isActive()).toBe(true)
    const prepare = Promise.withResolvers<void>()
    const done = resolved.trackRestorationPrepare(() => prepare.promise)
    expect(resolved.isActive()).toBe(true)
    prepare.resolve()
    await done
    expect(resolved.isActive()).toBe(false)

    const rejected = new StructuredAgentSessionStartupChatWork()
    await expect(
      rejected.trackRestorationPrepare(async () => {
        throw new Error('the terminal records refresh failed')
      })
    ).rejects.toThrow('refresh failed')
    expect(rejected.isActive()).toBe(false)
  })

  it('holds while a listing runs', async () => {
    const work = await preparedChatWork()
    const listing = Promise.withResolvers<void>()
    const done = work.trackListing(() => listing.promise)
    expect(work.isActive()).toBe(true)
    listing.resolve()
    await done
    expect(work.isActive()).toBe(false)
  })

  it('holds while a history restore is owed, and until it has started on the next macrotask', async () => {
    const work = await preparedChatWork()
    const start = vi.fn()
    work.oweRestore(start)
    expect(work.isActive()).toBe(true)

    work.startOwedRestoreSoon()
    expect(start).not.toHaveBeenCalled()
    expect(work.isActive()).toBe(true)
    await nextMacrotask()

    expect(start).toHaveBeenCalledOnce()
    expect(work.isActive()).toBe(false)
    // Started once: nothing is owed any more.
    work.startOwedRestoreSoon()
    await nextMacrotask()
    expect(start).toHaveBeenCalledOnce()
  })
})

describe('the copy waits for startup restoration on a desktop launch (R3M-1)', () => {
  it('waits for restoration, which the first listing waits for, however long it takes', async () => {
    const runtime = new OrcaRuntimeService()
    const refresh = Promise.withResolvers<Set<string>>()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test replaces only these protected startup members, which the runtime calls by name.
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.refreshMobileSessionPtyRecords = () => refresh.promise
    internal.ensureStructuredAgentSessionHost = async () => undefined
    const copy: { start?: PerChatFileCopyStart } = {}
    const host = {
      reconcileRestartLeases: async () => undefined,
      seedStoredStatuses: (ids: readonly string[]) => [...ids],
      settleOwedSessions: async () => undefined,
      startPerChatFileCopy: (input: PerChatFileCopyStart) => {
        copy.start = input
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup step reaches only these host members.
    setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)

    // The step runs once the shell PATH is ready, long before the first window's services.
    await runtime.startStructuredAgentSessionStartup()
    expect(copy.start?.isRuntimeChatWorkActive()).toBe(true)

    // Restoration: after the first window's services, or their timeout.
    const prepared = runtime.prepareStructuredAgentSessionStartupRestoration()
    expect(copy.start?.isRuntimeChatWorkActive()).toBe(true)
    refresh.resolve(new Set())
    await prepared
    expect(copy.start?.isRuntimeChatWorkActive()).toBe(false)
  })
})

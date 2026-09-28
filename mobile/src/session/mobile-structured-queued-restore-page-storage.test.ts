import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The queued-draft restore journal against the page's own store, which the session screen uses
 * when it is served as a page. An unlisted key there reads back empty and its write is dropped
 * without a rejection, so a Stop would hold a handle no store kept and its settle would find
 * nothing — the withdrawn text never reaching the composer. Driven through the real adapter.
 */
vi.mock('@react-native-async-storage/async-storage', async () => ({
  default: (await import('../mobile-web-shell/bridge/page-async-storage')).default
}))

const { publishPageStorage } = await import('../mobile-web-shell/bridge/page-async-storage')
const { pageStorageEntriesForInit, pageStorageKeysForRoute } =
  await import('../mobile-web-shell/page-storage-keys')
const { readMirroredStorage } = await import('../storage/mirrored-storage-keys')
const {
  getOrCreateQueuedRestoreOperation,
  queuedRestoreEntryKey,
  resetQueuedRestoreJournalForTests,
  restoreQueuedTextOnce
} = await import('./mobile-structured-queued-restore-journal')

const HOST_ID = 'host-1'
const SESSION_ROUTE = '/h/host-1/session/wt-1'
const JOURNAL = 'orca:mobileStructuredQueuedRestore:v1'

let delivered = true
const posted: string[] = []

function publish(held: Record<string, string>): void {
  const { entries, oversize } = pageStorageEntriesForInit(held)
  publishPageStorage(
    entries,
    (key) => {
      posted.push(key)
      return delivered
    },
    HOST_ID,
    SESSION_ROUTE,
    oversize
  )
}

function claimStop() {
  const fields = { turnId: 'turn-1' }
  return getOrCreateQueuedRestoreOperation({
    entryKey: queuedRestoreEntryKey({
      sessionKey: 'chat-a',
      method: 'agentSession.cancel',
      fields
    }),
    sessionId: 'session-1',
    sessionKey: 'chat-a',
    draftKey: 'host\0worktree\0tab',
    method: 'agentSession.cancel',
    fields,
    createOperationId: () => `${String(Date.now())}-${'a'.repeat(32)}`
  })
}

beforeEach(() => {
  resetQueuedRestoreJournalForTests()
  delivered = true
  posted.length = 0
  publish({})
})

describe('the queued restore journal against the page store', () => {
  it('is a key the session route hands the page', () => {
    expect(pageStorageKeysForRoute(HOST_ID, SESSION_ROUTE)).toContain(JOURNAL)
  })

  it('keeps a Stop handle in the page, mirrors it for init, and restores its text once', async () => {
    const operation = await claimStop()
    expect(posted).toEqual([JOURNAL])
    expect(readMirroredStorage([JOURNAL])[JOURNAL]).toContain(operation.operationId)
    const entryKey = queuedRestoreEntryKey({
      sessionKey: 'chat-a',
      method: 'agentSession.cancel',
      fields: { turnId: 'turn-1' }
    })
    const restore = vi.fn()
    const handle = { entryKey, operationId: operation.operationId }
    await restoreQueuedTextOnce(handle, restore)
    await restoreQueuedTextOnce(handle, restore)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(readMirroredStorage([JOURNAL])[JOURNAL]).toBeUndefined()
  })

  it('refuses a handle the shell did not take, so the caller restores directly', async () => {
    delivered = false
    await expect(claimStop()).rejects.toThrow(/did not keep/)
  })
})

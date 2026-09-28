import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS } from '../../../src/shared/agent-session-host-authority'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import {
  discardQueuedRestoreOperation,
  getOrCreateQueuedRestoreOperation,
  listQueuedRestoreOperations,
  queuedRestoreEntryKey,
  resetQueuedRestoreJournalForTests,
  settleQueuedRestoreOperation
} from './mobile-structured-queued-restore-journal'

const NOW = 1_900_000_000_000
const STORAGE_KEY = 'orca:mobileStructuredQueuedRestore:v1'

function operationIdAt(timestamp: number): string {
  return `${timestamp}-${'a'.repeat(32)}`
}

describe('mobile structured queued restore journal', () => {
  let values: Map<string, string>

  beforeEach(() => {
    vi.clearAllMocks()
    resetQueuedRestoreJournalForTests()
    values = new Map()
    asyncStorage.getItem.mockImplementation(async (key: string) => values.get(key) ?? null)
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      values.set(key, value)
    })
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      values.delete(key)
    })
  })

  function stopEntryInput(turnId = 'turn-1') {
    const entryKey = queuedRestoreEntryKey({
      sessionKey: 'chat-a',
      method: 'agentSession.cancel',
      fields: { turnId }
    })
    return {
      entryKey,
      sessionId: 'session-1',
      sessionKey: 'chat-a',
      draftKey: 'host\0worktree\0tab',
      method: 'agentSession.cancel' as const,
      fields: { turnId },
      createOperationId: () => operationIdAt(NOW),
      now: NOW
    }
  }

  it('persists the operation identity before any request can be issued', async () => {
    const created = await getOrCreateQueuedRestoreOperation(stopEntryInput())
    expect(created.retained).toBe(false)
    expect(values.has(STORAGE_KEY)).toBe(true)
    const retained = await getOrCreateQueuedRestoreOperation(stopEntryInput())
    expect(retained).toEqual({ operationId: created.operationId, retained: true })
  })

  it('settles a restoration exactly once, keeping the entry until restore ran', async () => {
    const { operationId } = await getOrCreateQueuedRestoreOperation(stopEntryInput())
    const { entryKey } = stopEntryInput()
    const restored: string[] = []
    let entryDuringRestore: string | undefined
    const first = await settleQueuedRestoreOperation({
      entryKey,
      operationId,
      restore: (entry) => {
        entryDuringRestore = values.get(STORAGE_KEY)
        restored.push(entry.draftKey)
      }
    })
    expect(first).toBe(true)
    // A crash mid-restore keeps the handle: the entry leaves storage only after.
    expect(entryDuringRestore).toContain(operationId)
    expect(values.has(STORAGE_KEY)).toBe(false)
    const second = await settleQueuedRestoreOperation({
      entryKey,
      operationId,
      restore: (entry) => {
        restored.push(entry.draftKey)
      }
    })
    expect(second).toBe(false)
    expect(restored).toEqual(['host\0worktree\0tab'])
  })

  it('discards a definitively answered entry and prunes expired handles on read', async () => {
    const { operationId } = await getOrCreateQueuedRestoreOperation(stopEntryInput())
    await discardQueuedRestoreOperation({ entryKey: stopEntryInput().entryKey, operationId })
    expect(
      await listQueuedRestoreOperations({ draftKey: 'host\0worktree\0tab', now: NOW })
    ).toEqual([])

    await getOrCreateQueuedRestoreOperation(stopEntryInput('turn-2'))
    const expired = NOW + AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS + 1
    expect(
      await listQueuedRestoreOperations({ draftKey: 'host\0worktree\0tab', now: expired })
    ).toEqual([])
  })

  it('lists only the named pane and survives an unreadable journal', async () => {
    await getOrCreateQueuedRestoreOperation(stopEntryInput())
    expect(
      (await listQueuedRestoreOperations({ draftKey: 'host\0worktree\0tab', now: NOW })).map(
        (entry) => entry.draftKey
      )
    ).toEqual(['host\0worktree\0tab'])
    expect(await listQueuedRestoreOperations({ draftKey: 'other-pane', now: NOW })).toEqual([])
    values.set(STORAGE_KEY, 'not json')
    // Unreadable bookkeeping must not gate a Stop: start over instead of throwing.
    const recreated = await getOrCreateQueuedRestoreOperation(stopEntryInput())
    expect(recreated.retained).toBe(false)
  })
})

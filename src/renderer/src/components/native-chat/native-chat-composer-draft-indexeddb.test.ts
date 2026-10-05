// A write counts as saved only once IndexedDB has committed it (the transaction's `complete`), not
// when its `put` is queued: a crash in between would otherwise lose a draft reported as saved.
import { describe, expect, it } from 'vitest'
import { createIndexedDbNativeChatComposerDraftStorage } from './native-chat-composer-draft-indexeddb'

type FakeTransaction = {
  oncomplete: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  error: Error | null
  objectStore: () => FakeStore
  commit: () => void
}
type FakeStore = {
  put: (value: unknown, key: string) => object
  delete: (key: string) => object
  get: (key: string) => { result: unknown; onsuccess: (() => void) | null }
}

function fakeDatabase(): {
  factory: IDBFactory
  transactions: FakeTransaction[]
  puts: unknown[]
} {
  const transactions: FakeTransaction[] = []
  const puts: unknown[] = []
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const store: FakeStore = {
        put: (value) => {
          puts.push(value)
          return {}
        },
        delete: () => ({}),
        get: () => {
          const request: { result: unknown; onsuccess: (() => void) | null } = {
            result: undefined,
            onsuccess: null
          }
          queueMicrotask(() => request.onsuccess?.())
          return request
        }
      }
      const transaction: FakeTransaction = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
        objectStore: () => store,
        commit: () => {}
      }
      transactions.push(transaction)
      return transaction
    }
  }
  const factory = {
    open: () => {
      const request: { result: typeof database; onsuccess: (() => void) | null } = {
        result: database,
        onsuccess: null
      }
      queueMicrotask(() => request.onsuccess?.())
      return request
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stand-in exposing only the calls the adapter makes.
  return { factory: factory as unknown as IDBFactory, transactions, puts }
}

const DRAFT = { text: 'unsent', images: [], savedAt: 1 }
const settledYet = async (promise: Promise<void>): Promise<boolean> => {
  let settled = false
  void promise.then(() => (settled = true))
  await new Promise((resolve) => setTimeout(resolve, 0))
  return settled
}

describe('the IndexedDB draft storage', () => {
  it('settles a write only when its transaction completes', async () => {
    const { factory, transactions, puts } = fakeDatabase()
    const write = createIndexedDbNativeChatComposerDraftStorage(factory).write('scope', DRAFT)

    expect(await settledYet(write)).toBe(false)
    expect(puts).toEqual([DRAFT])
    transactions[0]!.oncomplete?.()
    await expect(write).resolves.toBeUndefined()
  })

  it('settles a read-modify-write only when its transaction completes', async () => {
    const { factory, transactions, puts } = fakeDatabase()
    const update = createIndexedDbNativeChatComposerDraftStorage(factory).update(
      'scope',
      () => DRAFT
    )

    expect(await settledYet(update)).toBe(false)
    expect(puts).toEqual([DRAFT])
    transactions[0]!.oncomplete?.()
    await expect(update).resolves.toBeUndefined()
  })

  it('rejects a write whose transaction aborts, as on a full disk', async () => {
    const { factory, transactions } = fakeDatabase()
    const write = createIndexedDbNativeChatComposerDraftStorage(factory).write('scope', DRAFT)
    await new Promise((resolve) => setTimeout(resolve, 0))
    transactions[0]!.error = new Error('QuotaExceededError')
    transactions[0]!.onabort?.()

    await expect(write).rejects.toThrow('QuotaExceededError')
  })
})

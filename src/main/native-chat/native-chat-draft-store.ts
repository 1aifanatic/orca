// Composer drafts kept by the main process, one sidecar file per chat. A clear deletes the file
// and a write renames a temp file over it, so once either returned it survives the app being
// killed. No fsync: a power loss can still lose the last seconds, as browser storage would.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { removeStaleDurableWriteTempFiles } from '../durable-file-write'
import {
  readSidecarSnapshot,
  removeSidecarSnapshot,
  sidecarSnapshotFile,
  withSidecarSnapshotQueue,
  writeSidecarSnapshot
} from '../sidecar-snapshot-file'
import {
  isEmptyNativeChatDraft,
  parseNativeChatDraft,
  type NativeChatDraftStoreResult,
  type PersistedNativeChatDraft,
  type SavedNativeChatDraft
} from '../../shared/native-chat-draft-record'

const FILE_VERSION = 1
// Why a cap at load: drafts die with their chat; this bounds those whose end this client missed.
const MAX_SAVED_DRAFTS = 128

type Saved = { draft: PersistedNativeChatDraft; savedAt: number }

export type NativeChatDraftStore = {
  /** Every saved draft, oldest first, once the writes already asked for have landed. */
  load: () => Promise<SavedNativeChatDraft[]>
  /** The same without waiting, for a renderer that needs drafts before an async load returned. */
  loadSync: () => SavedNativeChatDraft[]
  /** Resolves once the file op returned. Writes for one chat apply in the order they arrived. */
  write: (
    scopeKey: string,
    draft: PersistedNativeChatDraft | null
  ) => Promise<NativeChatDraftStoreResult>
  /** Waits for every write asked for so far. */
  drain: () => Promise<void>
}

function draftFile(root: string, scopeKey: string): string {
  // Why hashed: a pane key holds ':', which Windows refuses in a file name.
  return sidecarSnapshotFile(root, `${createHash('sha256').update(scopeKey).digest('hex')}.json`)
}

function parseDraftFile(value: unknown): ({ scopeKey: string } & Saved) | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const v = 'v' in value ? value.v : undefined
  const scopeKey = 'scopeKey' in value ? value.scopeKey : undefined
  const savedAt = 'savedAt' in value ? value.savedAt : undefined
  const draft = parseNativeChatDraft(value)
  return v === FILE_VERSION && typeof scopeKey === 'string' && draft
    ? { scopeKey, draft, savedAt: typeof savedAt === 'number' ? savedAt : 0 }
    : null
}

function oldestFirst(saved: Iterable<[string, Saved]>): SavedNativeChatDraft[] {
  return Array.from(saved)
    .sort((left, right) => left[1].savedAt - right[1].savedAt)
    .map(([scopeKey, { draft }]) => ({ scopeKey, draft }))
}

export function createNativeChatDraftStore(root: string): NativeChatDraftStore {
  const saved = new Map<string, Saved>()
  const written = new Set<string>()
  const pending = new Set<Promise<unknown>>()
  let loaded = false

  const ready = (async () => {
    const found: ({ scopeKey: string; file: string } & Saved)[] = []
    const names = await readdir(root).catch(() => [])
    // Temp files a killed run left mid-write; this run's own are never swept.
    const interrupted = new Set(
      names.filter((name) => name.endsWith('.tmp')).map((name) => name.split('.json.')[0])
    )
    await Promise.all(
      Array.from(interrupted, (hash) =>
        removeStaleDurableWriteTempFiles(join(root, `${hash}.json`))
      )
    )
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const file = join(root, name)
      const parsed = parseDraftFile(await readSidecarSnapshot(file))
      if (parsed) {
        found.push({ ...parsed, file })
      } else {
        await rm(file, { force: true }).catch(() => {})
      }
    }
    found.sort((left, right) => left.savedAt - right.savedAt)
    for (const [index, entry] of found.entries()) {
      if (index < found.length - MAX_SAVED_DRAFTS) {
        await rm(entry.file, { force: true }).catch(() => {})
      } else if (!written.has(entry.scopeKey)) {
        saved.set(entry.scopeKey, { draft: entry.draft, savedAt: entry.savedAt })
      }
    }
    loaded = true
  })()

  const apply = async (
    scopeKey: string,
    draft: PersistedNativeChatDraft | null
  ): Promise<NativeChatDraftStoreResult> => {
    const file = draftFile(root, scopeKey)
    if (!draft || isEmptyNativeChatDraft(draft)) {
      await removeSidecarSnapshot(file)
      saved.delete(scopeKey)
      return 'persisted'
    }
    const savedAt = Date.now()
    await mkdir(root, { recursive: true, mode: 0o700 })
    await writeSidecarSnapshot(
      file,
      { v: FILE_VERSION, scopeKey, savedAt, ...draft },
      { durability: 'process' }
    )
    saved.set(scopeKey, { draft, savedAt })
    return 'persisted'
  }

  const drain = async (): Promise<void> => {
    await Promise.all(pending)
  }

  return {
    load: async () => {
      await ready
      await drain()
      return oldestFirst(saved)
    },
    loadSync: () => {
      if (loaded) {
        return oldestFirst(saved)
      }
      const found: [string, Saved][] = []
      try {
        for (const name of readdirSync(root).filter((entry) => entry.endsWith('.json'))) {
          const parsed = parseDraftFile(JSON.parse(readFileSync(join(root, name), 'utf8')))
          if (parsed) {
            found.push([parsed.scopeKey, parsed])
          }
        }
      } catch {
        // Unreadable: start from what was read rather than block the renderer.
      }
      return oldestFirst(found).slice(-MAX_SAVED_DRAFTS)
    },
    write: (scopeKey, draft) => {
      written.add(scopeKey)
      // Why queued per chat: a typing write still in flight must never land after the clear behind it.
      const result = withSidecarSnapshotQueue(draftFile(root, scopeKey), () =>
        apply(scopeKey, draft)
      ).catch((): NativeChatDraftStoreResult => 'failed')
      pending.add(result)
      void result.then(() => pending.delete(result))
      return result
    },
    drain
  }
}

import { load, records, unverifiedScopes } from './native-chat-composer-draft-memory'
import {
  nativeChatComposerDraftStorage,
  parseStoredNativeChatComposerDraft,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

export type NativeChatDraftTransferSnapshot = {
  readonly draft: StoredNativeChatComposerDraft
  readonly unverified: boolean
}

/** Capture before later history writes, rather than rereading its scope when loading finishes. */
export async function captureNativeChatDraftTransfer(
  scopeKey: string
): Promise<NativeChatDraftTransferSnapshot> {
  const current = records.get(scopeKey) ?? { text: '', images: [], savedAt: 0 }
  if (load.hydrated || load.editedBeforeLoad.has(scopeKey)) {
    return { draft: current, unverified: unverifiedScopes.has(scopeKey) }
  }
  const appends = [...(load.appendsBeforeLoad.get(scopeKey) ?? [])]
  const stored = parseStoredNativeChatComposerDraft(
    await nativeChatComposerDraftStorage().read(scopeKey)
  )
  if (!stored) {
    return { draft: current, unverified: unverifiedScopes.has(scopeKey) }
  }
  const draft = appends.reduce(
    (held, entry) => (entry.committed ? held : entry.append(held)),
    stored
  )
  return { draft, unverified: true }
}

/** A later history draft can have identical content and still be a different write. */
export function nativeChatDraftTransferSourceUnchanged(
  scopeKey: string,
  snapshot: NativeChatDraftTransferSnapshot
): boolean {
  return records.get(scopeKey)?.savedAt === snapshot.draft.savedAt
}

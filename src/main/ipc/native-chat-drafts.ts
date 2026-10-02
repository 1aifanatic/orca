import { ipcMain } from 'electron'
import {
  parseNativeChatDraft,
  type NativeChatDraftStoreResult,
  type SavedNativeChatDraft
} from '../../shared/native-chat-draft-record'
import {
  createNativeChatDraftStore,
  type NativeChatDraftStore
} from '../native-chat/native-chat-draft-store'
import { isTrustedUIRenderer } from './ui'

let store: NativeChatDraftStore | null = null

/** Drafts are the app window's own; no other renderer may read or write them. */
export function registerNativeChatDraftHandlers(root: string): void {
  const drafts = createNativeChatDraftStore(root)
  store = drafts
  ipcMain.removeHandler('nativeChat:drafts:load')
  ipcMain.removeHandler('nativeChat:drafts:write')
  ipcMain.removeAllListeners('nativeChat:drafts:loadSync')
  ipcMain.handle(
    'nativeChat:drafts:load',
    (event): Promise<SavedNativeChatDraft[]> | SavedNativeChatDraft[] =>
      isTrustedUIRenderer(event.sender) ? drafts.load() : []
  )
  ipcMain.on('nativeChat:drafts:loadSync', (event) => {
    event.returnValue = isTrustedUIRenderer(event.sender) ? drafts.loadSync() : []
  })
  ipcMain.handle(
    'nativeChat:drafts:write',
    (event, args: unknown): Promise<NativeChatDraftStoreResult> | NativeChatDraftStoreResult => {
      if (!isTrustedUIRenderer(event.sender) || typeof args !== 'object' || args === null) {
        return 'failed'
      }
      const scopeKey = 'scopeKey' in args ? args.scopeKey : undefined
      if (typeof scopeKey !== 'string' || scopeKey === '') {
        return 'failed'
      }
      // A cleared draft is null; anything unreadable is treated as cleared, never written.
      return drafts.write(scopeKey, 'draft' in args ? parseNativeChatDraft(args.draft) : null)
    }
  )
}

/** Lets drafts written just before quitting land before the app exits. */
export function drainNativeChatDrafts(): Promise<void> {
  return store?.drain() ?? Promise.resolve()
}

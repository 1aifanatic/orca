import { useSyncExternalStore } from 'react'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '@/store'
import { restoreLocalStructuredSessionTabsOnce } from './local-structured-session-tabs-sync/inventory-refresh'

// Whether THIS machine's runtime holds structured chats, as its host says: the host is built only
// when saved chats were restored at startup or a client created one here. The chat setting picks
// what new launches open as, so the chats that exist show whatever it says; a machine that never
// held one pays for no chat mirror. The browser client has no runtime of its own.

let hostInstalled = false
const listeners = new Set<() => void>()
let stopListening: (() => void) | null = null

function markHostInstalled(): void {
  if (hostInstalled) {
    return
  }
  hostInstalled = true
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Why optional: a window without the desktop bridge has no runtime to hold chats.
  const app = typeof window === 'undefined' ? undefined : window.api?.app
  if (!stopListening && app && !isWebClientLocation()) {
    stopListening = app.onStructuredAgentSessionHostInstalled(markHostInstalled)
    void readLocalStructuredAgentSessionHostInstalled()
  }
  return () => {
    listeners.delete(listener)
  }
}

/** Asks this machine's runtime whether its structured host is built. */
export async function readLocalStructuredAgentSessionHostInstalled(): Promise<boolean> {
  if (isWebClientLocation()) {
    return false
  }
  try {
    if (await window.api?.app?.hasStructuredAgentSessionHost()) {
      markHostInstalled()
    }
  } catch {
    // An unanswered query is not an answer; the install event still arrives.
  }
  return hostInstalled
}

/** This machine's runtime holds structured chats. */
export function useLocalStructuredAgentSessionHostInstalled(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hostInstalled,
    () => false
  )
}

type StructuredChatSettings = Pick<GlobalSettings, 'experimentalStructuredNativeChat'> | null

function chatsInUse(settings: StructuredChatSettings | undefined, installed: boolean): boolean {
  return (
    !isWebClientLocation() && (settings?.experimentalStructuredNativeChat === true || installed)
  )
}

/** Structured chats can exist on this machine: the setting launches them, or the runtime holds some. */
export function useLocalStructuredChatsInUse(): boolean {
  const installed = useLocalStructuredAgentSessionHostInstalled()
  const setting = useAppStore((state) => state.settings?.experimentalStructuredNativeChat === true)
  return chatsInUse({ experimentalStructuredNativeChat: setting }, installed)
}

/** The same answer for one-shot startup work, asked of the host rather than read from the renderer. */
export async function localStructuredChatsInUse(
  settings: StructuredChatSettings | undefined
): Promise<boolean> {
  if (isWebClientLocation()) {
    return false
  }
  return chatsInUse(settings, await readLocalStructuredAgentSessionHostInstalled())
}

/**
 * Startup's restore of this machine's chats. Existing chats come back whatever the chat setting
 * says; a machine that holds none, or the browser client, runs no session-tab census for them.
 */
export async function restoreLocalStructuredChatsAtStartup(
  settings: StructuredChatSettings | undefined,
  runStep: (restore: () => Promise<void>) => Promise<unknown>
): Promise<void> {
  if (await localStructuredChatsInUse(settings)) {
    await runStep(() => restoreLocalStructuredSessionTabsOnce())
  }
}

/** @internal - tests need a clean module between cases. */
export function resetLocalStructuredChatsForTests(): void {
  stopListening?.()
  stopListening = null
  hostInstalled = false
  listeners.clear()
}

import { createContext, useContext, useLayoutEffect, useSyncExternalStore } from 'react'

/**
 * Which dialogs are on screen, counted by the shared dialog primitive itself, so a dialog that
 * opens by itself can wait for any other dialog without each one registering by hand. Kept out of
 * the app store so the primitive stays usable wherever the store is not.
 */

const openDialogs = new Set<symbol>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getOpenDialogCount(): number {
  return openDialogs.size
}

/** Set around a dialog that opens by itself, so its own dialog never counts as another one. */
export const AutomaticPromptDialogScope = createContext(false)

/** Rendered inside the primitive's content, which mounts only while the dialog is open. */
export function DialogPresenceMarker(): null {
  const ownedByAutomaticPrompt = useContext(AutomaticPromptDialogScope)
  // Layout effect: a prompt already showing steps aside before this dialog's first paint.
  useLayoutEffect(() => {
    if (ownedByAutomaticPrompt) {
      return
    }
    const entry = Symbol('dialog')
    openDialogs.add(entry)
    emit()
    return () => {
      openDialogs.delete(entry)
      emit()
    }
  }, [ownedByAutomaticPrompt])
  return null
}

export function useOtherDialogOpen(): boolean {
  return useSyncExternalStore(subscribe, getOpenDialogCount, getOpenDialogCount) > 0
}

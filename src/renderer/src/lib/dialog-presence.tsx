import { createContext, Suspense, useContext, useLayoutEffect } from 'react'

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

export function subscribeDialogPresence(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A dialog other than an automatic prompt's own is on screen. */
export function isOtherDialogOpen(): boolean {
  return openDialogs.size > 0
}

const failedModalSurfaces = new Set<symbol>()

/** A modal surface's error fallback is showing, so the modal slot it held renders no dialog. */
export function isModalSurfaceFailed(): boolean {
  return failedModalSurfaces.size > 0
}

/** Rendered by a modal surface's error fallback, for exactly as long as that fallback shows. */
export function FailedModalSurfaceMarker(): null {
  useLayoutEffect(() => {
    const entry = Symbol('failed-modal-surface')
    failedModalSurfaces.add(entry)
    emit()
    return () => {
      failedModalSurfaces.delete(entry)
      emit()
    }
  }, [])
  return null
}

const AutomaticPromptScopeContext = createContext(false)

/**
 * Wraps a dialog the app opened by itself: its own dialogs, and any it opens, never count as another
 * dialog, so they never hold it back. `automatic` is false for the same dialog opened by the user,
 * which counts like any other.
 */
export function AutomaticPromptDialogScope({
  automatic = true,
  children
}: {
  automatic?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <AutomaticPromptScopeContext.Provider value={automatic}>
      {children}
    </AutomaticPromptScopeContext.Provider>
  )
}

/** Inside an automatic prompt's own tree. */
export function useInsideAutomaticPrompt(): boolean {
  return useContext(AutomaticPromptScopeContext)
}

/** Rendered inside the primitive's content, which mounts only while the dialog is open. */
export function DialogPresenceMarker(): null {
  const ownedByAutomaticPrompt = useInsideAutomaticPrompt()
  // Layout effect: counted before this dialog's first paint, so no prompt starts under it.
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

/**
 * Wraps dialogs the user opens whose code loads on first use: while loading they already count as
 * on screen, so an automatic prompt never starts in that gap. A dialog that fails to load renders
 * its error boundary's fallback instead, which counts as nothing.
 */
export function DialogLoadingSuspense({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return <Suspense fallback={<DialogPresenceMarker />}>{children}</Suspense>
}

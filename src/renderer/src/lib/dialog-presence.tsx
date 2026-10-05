import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore
} from 'react'

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

function subscribeNowhere(): () => void {
  return () => {}
}

function notOpen(): boolean {
  return false
}

/** Subscribes only while `enabled`, so callers that do not need it never re-render on it. */
export function useOtherDialogOpen(enabled = true): boolean {
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? subscribeDialogPresence(listener) : subscribeNowhere()),
    [enabled]
  )
  const getSnapshot = enabled ? isOtherDialogOpen : notOpen
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

type AutomaticPromptScopeValue = Readonly<{ steppedAside: boolean }>

const AutomaticPromptScopeContext = createContext<AutomaticPromptScopeValue | null>(null)

/**
 * Wraps a dialog the app opened by itself. Its own dialogs, and any it opens, never count as
 * another dialog; while another dialog is up it steps aside, hidden but still mounted, so whatever
 * it holds (typed notes, a send in flight, a running terminal) survives until it comes back.
 * `automatic` is false for the same dialog opened by the user, which counts like any other.
 */
export function AutomaticPromptDialogScope({
  automatic = true,
  children
}: {
  automatic?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const otherDialogOpen = useOtherDialogOpen(automatic)
  const value = useMemo(
    () => (automatic ? { steppedAside: otherDialogOpen } : null),
    [automatic, otherDialogOpen]
  )
  return (
    <AutomaticPromptScopeContext.Provider value={value}>
      {children}
    </AutomaticPromptScopeContext.Provider>
  )
}

/** Non-null inside an automatic prompt's own tree. */
export function useAutomaticPromptScope(): AutomaticPromptScopeValue | null {
  return useContext(AutomaticPromptScopeContext)
}

/** Rendered inside the primitive's content, which mounts only while the dialog is open. */
export function DialogPresenceMarker(): null {
  const ownedByAutomaticPrompt = useAutomaticPromptScope() !== null
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

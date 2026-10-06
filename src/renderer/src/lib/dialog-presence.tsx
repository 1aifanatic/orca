import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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

/**
 * The content ref for a dialog inside an automatic prompt: when the dialog over it closes, focus
 * returns to where it was in the prompt. Radix hands it back to the element that opened the closing
 * dialog, which for one nothing opened (an SSH prompt) leaves it on the page body. Outside a prompt
 * the forwarded ref passes through untouched.
 */
export function usePromptContentRef<T extends HTMLElement>(
  forwardedRef: React.Ref<T> | undefined
): React.Ref<T> | undefined {
  const scope = useAutomaticPromptScope()
  const steppedAside = scope?.steppedAside === true
  const [node, setNode] = useState<T | null>(null)
  const lastFocusedRef = useRef<HTMLElement | null>(null)
  const wasSteppedAsideRef = useRef(false)

  useEffect(() => {
    if (!node) {
      return
    }
    const remember = (target: EventTarget | null): void => {
      if (target instanceof HTMLElement && node.contains(target)) {
        lastFocusedRef.current = target
      }
    }
    // Radix's open autofocus runs before this effect, so start from where it put focus.
    remember(document.activeElement)
    const track = (event: FocusEvent): void => remember(event.target)
    node.addEventListener('focusin', track)
    return () => node.removeEventListener('focusin', track)
  }, [node])

  useEffect(() => {
    if (steppedAside) {
      wasSteppedAsideRef.current = true
      return
    }
    if (!wasSteppedAsideRef.current || !node) {
      return
    }
    wasSteppedAsideRef.current = false
    // After the closing dialog's own focus restore, which Radix runs on the next task.
    const timer = setTimeout(() => {
      const active = document.activeElement
      if (active !== null && active !== document.body) {
        return
      }
      const last = lastFocusedRef.current
      ;(last && node.contains(last) ? last : node).focus()
    }, 0)
    return () => clearTimeout(timer)
  }, [node, steppedAside])

  const promptRef = useCallback(
    (element: T | null) => {
      setRef(forwardedRef, element)
      setNode(element)
    },
    [forwardedRef]
  )
  return scope !== null ? promptRef : forwardedRef
}

function setRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') {
    ref(value)
  } else if (ref) {
    ref.current = value
  }
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

/**
 * Wraps dialogs the user opens whose code loads on first use: while loading they already count as
 * on screen, so an automatic prompt never shows in that gap only to step aside a moment later. A
 * dialog that fails to load renders its error boundary's fallback instead, which counts as nothing.
 */
export function DialogLoadingSuspense({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return <Suspense fallback={<DialogPresenceMarker />}>{children}</Suspense>
}

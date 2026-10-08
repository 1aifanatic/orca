import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { isEditableTarget } from '@/lib/editable-target'
import { useAppStore } from '../../store'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'

/** The chat's find: open state and query live with the chat, so a reopen keeps the last query. */
export type NativeChatFind = {
  isOpen: boolean
  query: string
  setQuery: (query: string) => void
  close: () => void
  rootRef: RefObject<HTMLDivElement | null>
  barRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLInputElement | null>
  /** Brings a match into the transcript's view as a reader step would. */
  revealMatch: (match: Range) => void
}

/** A composer whose suggestion list is open spends its own Escape closing that list. */
function ownsEscape(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    isEditableTarget(target) &&
    target.getAttribute('aria-expanded') === 'true'
  )
}

function focusInput(input: HTMLInputElement): void {
  input.focus()
  input.select()
}

/** Mod+F inside the focused chat opens find over its transcript. */
export function useNativeChatFind(
  enabled: boolean,
  rootRef: RefObject<HTMLDivElement | null>,
  composerRef: RefObject<Pick<NativeChatComposerHandle, 'focus'> | null>,
  messageListRef: RefObject<Pick<NativeChatMessageListHandle, 'revealFindMatch'> | null>
): NativeChatFind {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const barRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const focusBeforeOpenRef = useRef<HTMLElement | null>(null)

  const close = useCallback(() => {
    const root = rootRef.current
    const active = root?.ownerDocument.activeElement ?? null
    // Focus the user moved elsewhere stays there; only focus the bar held goes back.
    const focusInBar =
      active === null || active === root?.ownerDocument.body || barRef.current?.contains(active)
    setIsOpen(false)
    if (!focusInBar || !root) {
      return
    }
    const previous = focusBeforeOpenRef.current
    focusBeforeOpenRef.current = null
    if (
      previous?.isConnected &&
      root.contains(previous) &&
      !previous.closest('[hidden], [inert]')
    ) {
      previous.focus({ preventScroll: true })
      return
    }
    if (!composerRef.current?.focus()) {
      root.focus({ preventScroll: true })
    }
  }, [composerRef, rootRef])

  useEffect(() => {
    if (!enabled) {
      return
    }
    const platform = getShortcutPlatform()
    const onKeyDown = (e: KeyboardEvent): void => {
      const root = rootRef.current
      if (e.defaultPrevented || !root || !(e.target instanceof Node) || !root.contains(e.target)) {
        return
      }
      if (!keybindingMatchesAction('chat.find', e, platform, useAppStore.getState().keybindings)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) {
        return
      }
      // A mounted input means the bar is open: refocus it, keeping the current match.
      if (inputRef.current) {
        focusInput(inputRef.current)
        return
      }
      const active = root.ownerDocument.activeElement
      focusBeforeOpenRef.current = active instanceof HTMLElement ? active : null
      setIsOpen(true)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [enabled, rootRef])

  useEffect(() => {
    const root = rootRef.current
    if (!isOpen || !root) {
      return
    }
    // On the root, not the window: popovers and cards that close on Escape at the document claim it first.
    const onEscape = (e: KeyboardEvent): void => {
      if (
        e.key !== 'Escape' ||
        e.defaultPrevented ||
        e.isComposing ||
        e.keyCode === 229 ||
        ownsEscape(e.target)
      ) {
        return
      }
      // Consumed, so the composer's Escape does not also interrupt the turn.
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    root.addEventListener('keydown', onEscape, { capture: true })
    return () => root.removeEventListener('keydown', onEscape, { capture: true })
  }, [close, isOpen, rootRef])

  const revealMatch = useCallback(
    (match: Range) => messageListRef.current?.revealFindMatch(match),
    [messageListRef]
  )

  return { isOpen, query, setQuery, close, rootRef, barRef, inputRef, revealMatch }
}

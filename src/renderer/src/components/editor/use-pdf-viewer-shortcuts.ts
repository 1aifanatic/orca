import { useEffect, type RefObject } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'

/** Find belongs to this PDF when focus is in it, or nowhere in particular while it is on screen. */
export function pdfViewerOwnsFind(root: HTMLElement | null, target: EventTarget | null): boolean {
  if (!root || !(target instanceof Node)) {
    return false
  }
  if (root.contains(target)) {
    return true
  }
  const unfocused = target === root.ownerDocument.body || target === root.ownerDocument
  return (
    unfocused &&
    (typeof root.checkVisibility !== 'function' ||
      root.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
  )
}

export function usePdfViewerShortcuts({
  rootRef,
  keybindings,
  openFind,
  zoomIn,
  zoomOut,
  zoomReset
}: {
  rootRef: RefObject<HTMLElement | null>
  keybindings: KeybindingOverrides | undefined
  openFind: () => void
  zoomIn: () => void
  zoomOut: () => void
  zoomReset: () => void
}): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const platform = getShortcutPlatform()
      if (keybindingMatchesAction('editor.find', e, platform, keybindings)) {
        // Why: a PDF stays mounted in a hidden worktree or another split; it must not take
        // Mod+F from the surface the user is in (a chat, a preview).
        if (!pdfViewerOwnsFind(rootRef.current, e.target)) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        openFind()
        return
      }
      if (keybindingMatchesAction('zoom.in', e, platform, keybindings)) {
        e.preventDefault()
        zoomIn()
      } else if (keybindingMatchesAction('zoom.out', e, platform, keybindings)) {
        e.preventDefault()
        zoomOut()
      } else if (keybindingMatchesAction('zoom.reset', e, platform, keybindings)) {
        e.preventDefault()
        zoomReset()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [keybindings, openFind, rootRef, zoomIn, zoomOut, zoomReset])
}

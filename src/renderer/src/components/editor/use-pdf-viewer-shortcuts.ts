import { useEffect, type RefObject } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { isEditableTarget } from '@/lib/editable-target'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'

/**
 * Find is this PDF's when the key comes from inside it, or when it owns the panel's chords (the
 * active tab of the focused group, as the browser pane decides) and the key is not typed into a
 * text field. Its own tab, header and the file explorer keep the group focused; a chat, terminal
 * or browser in another split focuses its own group.
 */
export function pdfViewerOwnsFind(
  root: HTMLElement | null,
  target: EventTarget | null,
  ownsShortcuts: boolean
): boolean {
  if (!root || !(target instanceof Node)) {
    return false
  }
  if (root.contains(target)) {
    return true
  }
  return ownsShortcuts && !isEditableTarget(target instanceof Element ? target : null)
}

export function usePdfViewerShortcuts({
  rootRef,
  ownsShortcuts,
  keybindings,
  openFind,
  zoomIn,
  zoomOut,
  zoomReset
}: {
  rootRef: RefObject<HTMLElement | null>
  ownsShortcuts: boolean
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
        if (!pdfViewerOwnsFind(rootRef.current, e.target, ownsShortcuts)) {
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
  }, [keybindings, openFind, ownsShortcuts, rootRef, zoomIn, zoomOut, zoomReset])
}

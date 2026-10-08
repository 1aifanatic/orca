import { useEffect, type RefObject } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { isEditableTarget } from '@/lib/editable-target'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'

const GROUP_BODY_SELECTOR = '[data-tab-group-body-id]'
const GROUP_STRIP_SELECTOR = '[data-tab-group-strip-id]'

/**
 * Find belongs to this PDF unless the key came from another content surface (a chat, terminal or
 * editor in some group's body), another group's tab strip, or a text field. Its own tab, the file
 * explorer and other app chrome leave it to the PDF on screen.
 */
export function pdfViewerOwnsFind(root: HTMLElement | null, target: EventTarget | null): boolean {
  if (!root || !(target instanceof Node)) {
    return false
  }
  if (root.contains(target)) {
    return true
  }
  if (
    typeof root.checkVisibility === 'function' &&
    !root.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  ) {
    return false
  }
  const element = target instanceof Element ? target : target.parentElement
  if (element?.closest(GROUP_BODY_SELECTOR) || isEditableTarget(element)) {
    return false
  }
  const strip = element?.closest<HTMLElement>(GROUP_STRIP_SELECTOR)
  const group = root.closest<HTMLElement>(GROUP_BODY_SELECTOR)?.dataset.tabGroupBodyId
  return !strip || strip.dataset.tabGroupStripId === group
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

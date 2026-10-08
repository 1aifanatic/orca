import { useEffect, type RefObject } from 'react'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import type { WindowFindOpenRequest } from '../../../../shared/window-find-bar-contract'
import { isWebClientLocation } from '@/lib/web-client-location'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useAppStore } from '../../store'

/** Anchors the find bar to the chat's top-right corner, not the window's, so side panels stay clear. */
export function nativeChatWindowFindAnchor(
  rect: Pick<DOMRect, 'top' | 'right'>,
  viewportWidth: number
): WindowFindOpenRequest {
  return {
    top: Math.max(0, rect.top),
    rightInset: Math.max(0, viewportWidth - rect.right)
  }
}

/** Mod+F inside the focused chat opens find in window. */
export function useNativeChatWindowFind(
  enabled: boolean,
  rootRef: RefObject<HTMLDivElement | null>
): void {
  useEffect(() => {
    // The web client has no find bar of its own; the browser's find already covers it.
    if (!enabled || isWebClientLocation()) {
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
      if (!e.repeat) {
        window.api.app.openWindowFind(
          nativeChatWindowFindAnchor(root.getBoundingClientRect(), window.innerWidth)
        )
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [enabled, rootRef])
}

import { useCallback, useEffect, useId, useLayoutEffect } from 'react'
import { useAutomaticPromptScope } from '@/lib/dialog-presence'
import { useAppStore } from '@/store'
import {
  selectAutomaticPromptTurnHeld,
  type AutomaticPromptId
} from '@/store/slices/ui/automatic-prompt-turns'

/**
 * Asks for a turn while `wanted` and returns whether this prompt is the one to render now, plus the
 * call that records it as on screen.
 *
 * `wanted` must be false whenever the owner could not render the prompt, so a request never holds a
 * turn nobody sees. Turning it off, closing, and unmounting all release the turn; a new `key` (the
 * next item an owner queues) is a new request, so each item takes its own turn and is rendered only
 * once its own request holds it.
 *
 * Once shown, the prompt stays rendered while another dialog is up: render it inside
 * AutomaticPromptDialogScope, which hides it until that dialog closes. Before it is shown it is not
 * rendered at all while another dialog is up.
 *
 * Call `markShown` from the committed dialog content, never on being granted: a lazy surface may
 * not have rendered yet, and only a prompt on screen keeps its turn against later arrivals.
 */
export function useAutomaticPromptTurn(
  id: AutomaticPromptId,
  wanted: boolean,
  key?: string
): [visible: boolean, markShown: () => void] {
  const itemKey = key ?? null
  const requestAutomaticPrompt = useAppStore((s) => s.requestAutomaticPrompt)
  const releaseAutomaticPrompt = useAppStore((s) => s.releaseAutomaticPrompt)
  const markAutomaticPromptShown = useAppStore((s) => s.markAutomaticPromptShown)
  const visible = useAppStore((s) => wanted && selectAutomaticPromptTurnHeld(s, id, itemKey))

  useEffect(() => {
    if (!wanted) {
      return
    }
    requestAutomaticPrompt(id, itemKey)
    return () => releaseAutomaticPrompt(id, itemKey)
  }, [id, itemKey, wanted, requestAutomaticPrompt, releaseAutomaticPrompt])

  const markShown = useCallback(
    () => markAutomaticPromptShown(id, itemKey),
    [id, itemKey, markAutomaticPromptShown]
  )
  return [visible, markShown]
}

/**
 * Registers a dialog the user opened, or one answering something in flight, while it is visible.
 * It is never delayed: prompts not yet shown and tours wait behind it. One already showing steps
 * aside through the shared dialog primitive's presence marker, not through this.
 * Inside an automatic prompt's own tree it is part of that prompt, so it registers nothing.
 */
export function usePromptBlockingDialog(name: string, visible: boolean): void {
  const setPromptBlockingDialogVisible = useAppStore((s) => s.setPromptBlockingDialogVisible)
  const insidePrompt = useAutomaticPromptScope() !== null
  // Per instance, so two copies of one dialog never clear each other's entry.
  const id = `${name}:${useId()}`
  const registered = visible && !insidePrompt
  // Layout effect: registered before this dialog's first paint, so nothing starts over it.
  useLayoutEffect(() => {
    if (!registered) {
      return
    }
    setPromptBlockingDialogVisible(id, true)
    return () => setPromptBlockingDialogVisible(id, false)
  }, [id, registered, setPromptBlockingDialogVisible])
}

import { useCallback, useEffect, useId, useLayoutEffect } from 'react'
import { useOtherDialogOpen } from '@/lib/dialog-presence'
import { useAppStore } from '@/store'
import {
  selectVisibleAutomaticPromptId,
  type AutomaticPromptId
} from '@/store/slices/ui/automatic-prompt-turns'

/**
 * Asks for a turn while `wanted` and returns whether this prompt is the one to show now, plus the
 * call that records it as on screen.
 *
 * `wanted` must be false whenever the owner could not render the prompt, so a request never holds a
 * turn nobody sees. Turning it off, closing, and unmounting all release the turn; a new `key` (the
 * next item an owner queues) releases and asks again, so each item takes its own turn.
 *
 * Call `markShown` from the committed dialog content, never on being granted: a lazy surface may
 * not have rendered yet, and only a prompt on screen keeps its turn against later arrivals.
 */
export function useAutomaticPromptTurn(
  id: AutomaticPromptId,
  wanted: boolean,
  key?: string
): [visible: boolean, markShown: () => void] {
  const requestAutomaticPrompt = useAppStore((s) => s.requestAutomaticPrompt)
  const releaseAutomaticPrompt = useAppStore((s) => s.releaseAutomaticPrompt)
  const markAutomaticPromptShown = useAppStore((s) => s.markAutomaticPromptShown)
  const selected = useAppStore((s) => wanted && selectVisibleAutomaticPromptId(s) === id)
  // Any other dialog on screen, including ones the store does not track, holds this one back.
  const otherDialogOpen = useOtherDialogOpen()

  useEffect(() => {
    if (!wanted) {
      return
    }
    requestAutomaticPrompt(id)
    return () => releaseAutomaticPrompt(id)
  }, [id, key, wanted, requestAutomaticPrompt, releaseAutomaticPrompt])

  const markShown = useCallback(() => markAutomaticPromptShown(id), [id, markAutomaticPromptShown])
  return [selected && !otherDialogOpen, markShown]
}

/**
 * Registers a dialog the user opened, or one answering something in flight, while it is visible.
 * It is never delayed; automatic prompts wait behind it, and one already showing steps aside.
 */
export function usePromptBlockingDialog(name: string, visible: boolean): void {
  const setPromptBlockingDialogVisible = useAppStore((s) => s.setPromptBlockingDialogVisible)
  // Per instance, so two copies of one dialog never clear each other's entry.
  const id = `${name}:${useId()}`
  // Layout effect: a prompt already showing steps aside before this dialog's first paint.
  useLayoutEffect(() => {
    if (!visible) {
      return
    }
    setPromptBlockingDialogVisible(id, true)
    return () => setPromptBlockingDialogVisible(id, false)
  }, [id, visible, setPromptBlockingDialogVisible])
}

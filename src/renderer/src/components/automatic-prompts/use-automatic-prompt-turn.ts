import { useEffect, useId, useLayoutEffect } from 'react'
import { useAppStore } from '@/store'
import {
  selectVisibleAutomaticPromptId,
  type AutomaticPromptId
} from '@/store/slices/ui/automatic-prompt-turns'

/**
 * Asks for a turn while `wanted` and returns whether this prompt is the one to show now.
 *
 * `wanted` must be false whenever the owner could not render the prompt, so a request never holds a
 * turn nobody sees. Turning it off, closing, and unmounting all release the turn.
 */
export function useAutomaticPromptTurn(id: AutomaticPromptId, wanted: boolean): boolean {
  const requestAutomaticPrompt = useAppStore((s) => s.requestAutomaticPrompt)
  const releaseAutomaticPrompt = useAppStore((s) => s.releaseAutomaticPrompt)
  const markAutomaticPromptShown = useAppStore((s) => s.markAutomaticPromptShown)
  const visible = useAppStore((s) => wanted && selectVisibleAutomaticPromptId(s) === id)

  useEffect(() => {
    if (!wanted) {
      return
    }
    requestAutomaticPrompt(id)
    return () => releaseAutomaticPrompt(id)
  }, [id, wanted, requestAutomaticPrompt, releaseAutomaticPrompt])

  useEffect(() => {
    if (visible) {
      markAutomaticPromptShown(id)
    }
  }, [id, visible, markAutomaticPromptShown])

  return visible
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

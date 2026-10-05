import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useAutomaticPromptTurn } from '@/components/automatic-prompts/use-automatic-prompt-turn'
import { AUTOMATIC_PROMPT_MODAL_KEY } from '@/store/slices/ui/automatic-prompt-turns'
import { MODAL_DISMISSED_KEY } from '@/store/slices/modal-slot-dismissal'
import type { FeatureTipId } from '../../../../shared/feature-tips'
import {
  trackCmdJPaletteFeatureTipShown,
  trackOrcaCliFeatureTipShown
} from './feature-tip-telemetry'

function closeOwnTip(): void {
  const state = useAppStore.getState()
  // Only the tip's own entry; a modal the user opened in its place stays.
  if (state.modalData[AUTOMATIC_PROMPT_MODAL_KEY] === 'feature-tip') {
    state.closeModal()
  }
}

/**
 * The app-open feature tip, waiting for its turn among the dialogs that open by themselves.
 * Returns the call that queues a tip. It is marked seen by the dialog once on screen, not here.
 */
export function useAppOpenFeatureTip(): (tipId: FeatureTipId) => void {
  const [pendingTipId, setPendingTipId] = useState<FeatureTipId | null>(null)
  const openedTipIdRef = useRef<FeatureTipId | null>(null)
  // The tip opens in the modal slot, so it can render only while the slot is free or already its own;
  // asking for a turn while a user's modal holds it (even one still loading) would replace that modal.
  const slotAvailable = useAppStore(
    (s) => s.activeModal === 'none' || s.modalData[AUTOMATIC_PROMPT_MODAL_KEY] === 'feature-tip'
  )
  const [tipTurn] = useAutomaticPromptTurn('feature-tip', pendingTipId !== null && slotAvailable)
  const openModal = useAppStore((s) => s.openModal)

  useEffect(() => {
    if (!tipTurn || pendingTipId === null || openedTipIdRef.current === pendingTipId) {
      return
    }
    openedTipIdRef.current = pendingTipId
    const tipId = pendingTipId
    openModal('feature-tips', {
      source: 'app_open',
      tipId,
      [AUTOMATIC_PROMPT_MODAL_KEY]: 'feature-tip',
      [MODAL_DISMISSED_KEY]: () => {
        const { activeModal, featureTipsSeenIds } = useAppStore.getState()
        // Replaced by a modal the user opened before it was ever on screen: it gives up its turn
        // while that modal holds the slot and asks again afterwards. Closed, or already seen, it is done.
        if (activeModal !== 'none' && !featureTipsSeenIds.includes(tipId)) {
          openedTipIdRef.current = null
          return
        }
        setPendingTipId(null)
      }
    })
  }, [openModal, pendingTipId, tipTurn])

  // The owner going away ends its tip's turn with it.
  useEffect(() => closeOwnTip, [])

  return useCallback((tipId: FeatureTipId) => setPendingTipId(tipId), [])
}

/** Called by the tip dialog once its content is on screen. */
export function useAppOpenFeatureTipShown(args: {
  visible: boolean
  tipId: FeatureTipId | undefined
  automatic: boolean
}): void {
  const { visible, tipId, automatic } = args
  const markFeatureTipsSeen = useAppStore((s) => s.markFeatureTipsSeen)
  const markAutomaticPromptShown = useAppStore((s) => s.markAutomaticPromptShown)
  const shownTipIdRef = useRef<FeatureTipId | null>(null)
  useEffect(() => {
    if (!visible || !automatic || !tipId || shownTipIdRef.current === tipId) {
      return
    }
    shownTipIdRef.current = tipId
    if (tipId === 'orca-cli') {
      trackOrcaCliFeatureTipShown('app_open')
    } else if (tipId === 'cmd-j-palette') {
      trackCmdJPaletteFeatureTipShown('app_open')
    }
    // Why: mark seen on show so a quit/crash before dismiss doesn't reappear it next launch.
    markFeatureTipsSeen([tipId])
    markAutomaticPromptShown('feature-tip')
  }, [automatic, markAutomaticPromptShown, markFeatureTipsSeen, tipId, visible])
}

/** Rendered in place of a tip whose dialog failed: ends its turn rather than holding every later
 *  prompt back. The boundary still reports the error. */
export function FailedFeatureTip(): null {
  useEffect(closeOwnTip, [])
  return null
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { onOnboardingReopened } from '../components/onboarding/show-onboarding-event'
import { shouldShowOnboarding } from '../components/onboarding/should-show-onboarding'
import {
  getFeatureTipsAppOpenDecision,
  isCliFeatureTipCompleted
} from '../components/feature-tips/feature-tip-startup-gate'
import {
  trackCmdJPaletteFeatureTipShown,
  trackOrcaCliFeatureTipShown
} from '../components/feature-tips/feature-tip-telemetry'
import { useAppStore } from '../store'
import { isWebClientLocation } from '../lib/web-client-location'
import { useAutomaticPromptTurn } from '../components/automatic-prompts/use-automatic-prompt-turn'
import { AUTOMATIC_PROMPT_MODAL_KEY } from '../store/slices/ui/automatic-prompt-turns'
import { MODAL_DISMISSED_KEY } from '../store/slices/modal-slot-dismissal'
import type { OnboardingState } from '../../../shared/onboarding-state-types'
import type { FeatureTipId } from '../../../shared/feature-tips'

export type OnboardingGate = ReturnType<typeof useOnboardingAndFeatureTips>

/**
 * Owns first-run education: the onboarding flow's visibility plus the one-per-session
 * feature-tip prompt, which stays suppressed until onboarding's state is known.
 */
export function useOnboardingAndFeatureTips() {
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null)
  const [onboardingLoaded, setOnboardingLoaded] = useState(false)
  const [featureTipCliInstalled, setFeatureTipCliInstalled] = useState<boolean | null>(null)
  const promptedThisSessionRef = useRef(false)
  // The app-open tip, chosen and waiting for its turn among dialogs that open by themselves.
  const [pendingTipId, setPendingTipId] = useState<FeatureTipId | null>(null)
  const shownTipIdRef = useRef<FeatureTipId | null>(null)
  const tipTurn = useAutomaticPromptTurn('feature-tip', pendingTipId !== null)
  const suppressedByOnboardingThisSessionRef = useRef(false)

  const activeModal = useAppStore((s) => s.activeModal)
  const settings = useAppStore((s) => s.settings)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const featureTipsSeenIds = useAppStore((s) => s.featureTipsSeenIds)
  const featureInteractions = useAppStore((s) => s.featureInteractions)
  const contextualToursAutoEligible = useAppStore((s) => s.contextualToursAutoEligible)
  const actions = useAppStore(
    useShallow((s) => ({
      openModal: s.openModal,
      markFeatureTipsSeen: s.markFeatureTipsSeen,
      setContextualToursAutoEligible: s.setContextualToursAutoEligible,
      setContextualToursOnboardingVisible: s.setContextualToursOnboardingVisible
    }))
  )

  const applyStartupOnboardingState = useCallback((state: OnboardingState): void => {
    setOnboarding(state)
    setOnboardingLoaded(true)
  }, [])

  useEffect(() => {
    return onOnboardingReopened(setOnboarding)
  }, [])

  useEffect(() => {
    // Why: suppress tours until onboarding state is known (null = loading) so a first-run user can't mark a tour seen before onboarding appears.
    const suppressTours = !onboardingLoaded || shouldShowOnboarding(onboarding)
    actions.setContextualToursOnboardingVisible(suppressTours)
  }, [actions, onboarding, onboardingLoaded])

  useEffect(() => {
    if (!persistedUIReady || !onboardingLoaded || contextualToursAutoEligible !== null) {
      return
    }
    // Why: rollout targets first-run onboarding users; existing profiles are classified once and never auto-toured.
    actions.setContextualToursAutoEligible(shouldShowOnboarding(onboarding))
  }, [actions, contextualToursAutoEligible, onboarding, onboardingLoaded, persistedUIReady])

  useEffect(() => {
    if (!persistedUIReady) {
      return
    }

    let cancelled = false
    void window.api.cli
      .getInstallStatus()
      .then((status) => {
        if (cancelled) {
          return
        }
        setFeatureTipCliInstalled(isCliFeatureTipCompleted(status))
      })
      .catch(() => {
        if (!cancelled) {
          setFeatureTipCliInstalled(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [persistedUIReady])

  useEffect(() => {
    const featureTipsDecision = getFeatureTipsAppOpenDecision({
      activeModal,
      cliInstalled: featureTipCliInstalled,
      featureTipsSeenIds,
      featureInteractions,
      onboarding,
      persistedUIReady,
      promptedThisSession: promptedThisSessionRef.current,
      settings,
      suppressedByOnboardingThisSession: suppressedByOnboardingThisSessionRef.current,
      webClient: isWebClientLocation()
    })

    if (featureTipsDecision.kind === 'suppress-for-onboarding') {
      // Why: first-run users should finish onboarding without a second education modal in the same session.
      suppressedByOnboardingThisSessionRef.current = true
      return
    }

    if (featureTipsDecision.kind !== 'open') {
      return
    }

    promptedThisSessionRef.current = true
    setPendingTipId(featureTipsDecision.tipId)
  }, [
    activeModal,
    actions,
    featureTipCliInstalled,
    featureInteractions,
    featureTipsSeenIds,
    onboarding,
    persistedUIReady,
    settings
  ])

  useEffect(() => {
    if (!tipTurn || pendingTipId === null || shownTipIdRef.current === pendingTipId) {
      return
    }
    shownTipIdRef.current = pendingTipId
    if (pendingTipId === 'orca-cli') {
      trackOrcaCliFeatureTipShown('app_open')
    } else if (pendingTipId === 'cmd-j-palette') {
      trackCmdJPaletteFeatureTipShown('app_open')
    }
    // Why: mark seen on show so a quit/crash before dismiss doesn't reappear it next launch.
    actions.markFeatureTipsSeen([pendingTipId])
    actions.openModal('feature-tips', {
      source: 'app_open',
      tipId: pendingTipId,
      [AUTOMATIC_PROMPT_MODAL_KEY]: 'feature-tip',
      // Closing it, or a modal the user opens replacing it, ends its turn. It was shown, so it is
      // not raised again.
      [MODAL_DISMISSED_KEY]: () => setPendingTipId(null)
    })
  }, [actions, pendingTipId, tipTurn])

  return {
    applyStartupOnboardingState,
    onboarding,
    setOnboarding,
    shouldRender: onboarding !== null && shouldShowOnboarding(onboarding)
  }
}

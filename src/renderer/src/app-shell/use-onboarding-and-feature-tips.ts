import { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { onOnboardingReopened } from '../components/onboarding/show-onboarding-event'
import { shouldShowOnboarding } from '../components/onboarding/should-show-onboarding'
import {
  getFeatureTipsAppOpenDecision,
  isCliFeatureTipCompleted
} from '../components/feature-tips/feature-tip-startup-gate'
import { useAppStore } from '../store'
import { useDialogRegistry } from '../store/dialog-registry'
import { isWebClientLocation } from '../lib/web-client-location'
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
  const [appOpenTipId, setAppOpenTipId] = useState<FeatureTipId | null>(null)
  // Read early by startup for the tip check, before startup shows onboarding itself.
  const [tipCheckOnboarding, setTipCheckOnboarding] = useState<OnboardingState | null>(null)
  const promptedThisSessionRef = useRef(false)
  const suppressedByOnboardingThisSessionRef = useRef(false)

  const settings = useAppStore((s) => s.settings)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const featureTipsSeenIds = useAppStore((s) => s.featureTipsSeenIds)
  const featureInteractions = useAppStore((s) => s.featureInteractions)
  const contextualToursAutoEligible = useAppStore((s) => s.contextualToursAutoEligible)
  const actions = useAppStore(
    useShallow((s) => ({
      setContextualToursAutoEligible: s.setContextualToursAutoEligible,
      setContextualToursOnboardingVisible: s.setContextualToursOnboardingVisible
    }))
  )

  const applyStartupOnboardingState = useCallback((state: OnboardingState): void => {
    setOnboarding(state)
    setOnboardingLoaded(true)
  }, [])

  const applyStartupTipCheckInputs = useCallback((state: OnboardingState | null): void => {
    if (state === null) {
      // Settings or onboarding could not be read: no tip this launch, and nothing waits on one.
      useDialogRegistry.getState().settleStartupSource('feature-tip', 'unavailable')
      return
    }
    setTipCheckOnboarding(state)
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
      cliInstalled: featureTipCliInstalled,
      featureTipsSeenIds,
      featureInteractions,
      onboarding: onboarding ?? tipCheckOnboarding,
      persistedUIReady,
      promptedThisSession: promptedThisSessionRef.current,
      settings,
      suppressedByOnboardingThisSession: suppressedByOnboardingThisSessionRef.current,
      webClient: isWebClientLocation()
    })

    if (featureTipsDecision.kind === 'pending') {
      return
    }

    if (featureTipsDecision.kind === 'suppress-for-onboarding') {
      // Why: first-run users should finish onboarding without a second education modal in the same session.
      suppressedByOnboardingThisSessionRef.current = true
    }

    if (featureTipsDecision.kind !== 'open') {
      // A tip already decided answers through its host, once queued.
      if (!promptedThisSessionRef.current) {
        useDialogRegistry.getState().settleStartupSource('feature-tip', 'none')
      }
      return
    }

    promptedThisSessionRef.current = true
    // Its host queues it and answers the tip check once it is queued.
    setAppOpenTipId(featureTipsDecision.tipId)
  }, [
    featureTipCliInstalled,
    featureInteractions,
    featureTipsSeenIds,
    onboarding,
    persistedUIReady,
    settings,
    tipCheckOnboarding
  ])

  return {
    applyStartupOnboardingState,
    applyStartupTipCheckInputs,
    appOpenTipId,
    onboarding,
    setOnboarding,
    shouldRender: onboarding !== null && shouldShowOnboarding(onboarding)
  }
}

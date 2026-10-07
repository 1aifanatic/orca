import { useCallback, useEffect, useRef, useState } from 'react'
import { readStartupDiscovery } from '../startup/startup-discovery-read'
import { useDialogDisposal } from '../lib/dialog-registry-entry'
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

  const tipSource = useDialogRegistry((s) => s.startupSources['feature-tip'])
  const abandonTip = useCallback(() => {
    useDialogRegistry.getState().settleStartupSource('feature-tip', 'unavailable')
  }, [])
  useDialogDisposal('feature-tip-discovery', abandonTip)

  const settings = useAppStore((s) => s.settings)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const featureTipsSeenIds = useAppStore((s) => s.featureTipsSeenIds)
  const featureInteractions = useAppStore((s) => s.featureInteractions)
  const contextualToursAutoEligible = useAppStore((s) => s.contextualToursAutoEligible)
  const setContextualToursAutoEligible = useAppStore((s) => s.setContextualToursAutoEligible)

  const applyStartupOnboardingState = useCallback((state: OnboardingState): void => {
    setOnboarding(state)
    setOnboardingLoaded(true)
  }, [])

  const applyStartupTipCheckInputs = useCallback((state: OnboardingState | null): void => {
    if (useDialogRegistry.getState().startupSources['feature-tip'] !== 'pending') {
      return
    }
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
    if (!persistedUIReady || !onboardingLoaded || contextualToursAutoEligible !== null) {
      return
    }
    // Why: rollout targets first-run onboarding users; existing profiles are classified once and never auto-toured.
    setContextualToursAutoEligible(shouldShowOnboarding(onboarding))
  }, [
    contextualToursAutoEligible,
    onboarding,
    onboardingLoaded,
    persistedUIReady,
    setContextualToursAutoEligible
  ])

  useEffect(() => {
    if (!persistedUIReady) {
      return
    }

    let cancelled = false
    void readStartupDiscovery(window.api.cli.getInstallStatus()).then((status) => {
      if (cancelled) {
        return
      }
      if (status === null) {
        abandonTip()
      } else {
        setFeatureTipCliInstalled(isCliFeatureTipCompleted(status))
      }
    })

    return () => {
      cancelled = true
    }
  }, [abandonTip, persistedUIReady])

  useEffect(() => {
    if (tipSource !== 'pending') {
      return
    }
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
    tipCheckOnboarding,
    tipSource
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

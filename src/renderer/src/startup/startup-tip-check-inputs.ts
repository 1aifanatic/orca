import { useAppStore } from '../store'
import type { OnboardingState } from '../../../shared/onboarding-state-types'

/**
 * Hands the feature-tip startup check its startup inputs as soon as onboarding is read, not when
 * startup later shows onboarding: dialogs after the tip wait on this answer. Null when settings or
 * onboarding could not be read: no tip can be decided this launch. Marks the read handled.
 */
export function answerTipCheckOnOnboardingRead(
  onboardingRead: Promise<OnboardingState>,
  answer: { readonly current: (onboarding: OnboardingState | null) => void }
): void {
  onboardingRead.then(
    // Settings were fetched and published before this read started; none now means it failed.
    (onboarding) => answer.current(useAppStore.getState().settings === null ? null : onboarding),
    () => answer.current(null)
  )
}

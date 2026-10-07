import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { translate } from '@/i18n/i18n'
import { AdoptDialogEntry, DialogEntryRoot, useHostDialogEntry } from '@/lib/dialog-registry-entry'
import { RecoverableRenderErrorBoundary } from '../components/error-boundaries/RecoverableRenderErrorBoundary'
import type { OnboardingGate } from './use-onboarding-and-feature-tips'

// Why: lazy so onboarding's step modules + assets aren't fetched for users past first-launch.
const OnboardingFlow = lazy(() => import('../components/onboarding/OnboardingFlow'))

const ONBOARDING_DIALOG_TOKEN = 'onboarding'

/** First-run onboarding: a modal surface of its own, so it reserves its dialog entry here. */
export function OnboardingSurface({ gate }: { gate: OnboardingGate }): React.JSX.Element | null {
  const onboarding = gate.shouldRender ? gate.onboarding : null
  useHostDialogEntry(ONBOARDING_DIALOG_TOKEN, 'onboarding', 'user', onboarding !== null)
  if (onboarding === null) {
    return null
  }
  return (
    <AdoptDialogEntry token={ONBOARDING_DIALOG_TOKEN}>
      <Suspense fallback={null}>
        <RecoverableRenderErrorBoundary
          boundaryId="modal.onboarding"
          surface="modal"
          title={translate('auto.App.f02d37278a', 'Onboarding hit an error.')}
          description={translate(
            'auto.App.221a95ba38',
            'Retry onboarding or close it and continue in the app.'
          )}
        >
          {/* Not a Dialog: this stands in for its root, so dialogs opened inside onboarding
              register as its children. */}
          <DialogEntryRoot open>
            <OnboardingFlow onboarding={onboarding} onOnboardingChange={gate.setOnboarding} />
          </DialogEntryRoot>
        </RecoverableRenderErrorBoundary>
      </Suspense>
    </AdoptDialogEntry>
  )
}

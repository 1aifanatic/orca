import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

const TOAST_ID = 'profile-state-save-delay'

export function useProfileStateSaveDelayNotice(): void {
  useEffect(() => {
    const app = window.api?.app
    if (!app?.onProfileStateSaveDelayChanged || !app.isProfileStateSaveDelayed) {
      return
    }
    let disposed = false
    let receivedChange = false
    const present = (delayed: boolean): void => {
      if (disposed) {
        return
      }
      if (!delayed) {
        toast.dismiss(TOAST_ID)
        return
      }
      toast.warning(translate('app.saving.delayedTitle', 'Saving is taking longer than usual'), {
        id: TOAST_ID,
        description: translate(
          'app.saving.delayedDescription',
          'Recent changes haven’t been confirmed saved yet. Orca is still trying.'
        ),
        duration: Infinity,
        dismissible: false,
        closeButton: false
      })
    }
    const unsubscribe = app.onProfileStateSaveDelayChanged((delayed) => {
      receivedChange = true
      present(delayed)
    })
    void app
      .isProfileStateSaveDelayed()
      .then((delayed) => {
        // A pushed change is newer than the initial snapshot read.
        if (!receivedChange) {
          present(delayed)
        }
      })
      .catch((error: unknown) => console.warn('[persistence] Could not read saving status:', error))
    return () => {
      disposed = true
      unsubscribe()
      toast.dismiss(TOAST_ID)
    }
  }, [])
}

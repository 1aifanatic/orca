import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import type { ZcodePlanCredentialsStatus } from '../../../../shared/zcode-plan-sites'

export function useZcodePlanCredentials(updatedAt: number | undefined) {
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [status, setStatus] = useState<ZcodePlanCredentialsStatus | null>(null)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [credentialBusy, setCredentialBusy] = useState(false)
  const generation = useRef(0)
  const mutationPending = useRef(false)

  useEffect(() => {
    if (mutationPending.current) {
      return
    }
    const request = ++generation.current
    void window.api.zcodePlanCredentials.getStatus().then(
      (next) => {
        if (request === generation.current) {
          setStatus(next)
        }
      },
      () => {
        if (request === generation.current) {
          setStatus(null)
        }
      }
    )
    return () => {
      generation.current += 1
    }
  }, [updatedAt])

  const updateCredential = async (action: 'save' | 'clear'): Promise<void> => {
    const request = ++generation.current
    mutationPending.current = true
    setCredentialBusy(true)
    try {
      const next =
        action === 'save'
          ? await window.api.zcodePlanCredentials.saveApiKey(apiKeyDraft.trim())
          : await window.api.zcodePlanCredentials.clearApiKey()
      if (request === generation.current) {
        setStatus(next)
      }
      setApiKeyDraft('')
      recordFeatureInteraction('usage-tracking')
      if (action === 'save') {
        toast.success(
          translate(
            'auto.components.settings.ZcodePlanAccountsSection.keySaved',
            'GLM Coding Plan API key saved.'
          )
        )
      }
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.ZcodePlanAccountsSection.keySaveFailed',
          'GLM Coding Plan credential update failed.'
        ),
        { description: error instanceof Error ? error.message : String(error) }
      )
    } finally {
      mutationPending.current = false
      setCredentialBusy(false)
    }
  }

  return {
    status,
    apiKeyDraft,
    setApiKeyDraft,
    credentialBusy,
    saveApiKey: () => updateCredential('save'),
    clearApiKey: () => updateCredential('clear')
  }
}

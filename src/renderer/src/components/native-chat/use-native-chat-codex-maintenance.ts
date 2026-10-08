import { useLayoutEffect, useRef } from 'react'
import { translate } from '@/i18n/i18n'
import { useCodexMaintenance } from '@/hooks/useCodexMaintenance'
import type { CodexMaintenanceTarget } from '@/lib/codex-maintenance-client'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { useNativeChatProvisionalLaunch } from './use-native-chat-provisional-launch'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'

export function useNativeChatCodexMaintenance(input: {
  agent: string
  sessionId: string
  target: CodexMaintenanceTarget
  launch: ReturnType<typeof useNativeChatProvisionalLaunch>
  startFailures: readonly AgentSessionFailureFact[]
  retryQueued: () => Promise<boolean>
}) {
  const { launch, startFailures, sessionId, retryQueued } = input
  const refused =
    launch.lifecycle === 'failed' &&
    launch.failure?.code === 'agent_session_operation_invalid' &&
    Boolean(launch.failure.details?.codexInstallation)
  const processless =
    refused &&
    launch.failure?.code === 'agent_session_operation_invalid' &&
    !launch.failure.details?.argumentProblem
  const historical = startFailures.some(
    (fact) =>
      fact.refusal?.code === 'agent_session_operation_invalid' &&
      fact.refusal.details?.codexInstallation
  )
  const maintenance = useCodexMaintenance(
    input.agent === 'codex' && (refused || historical) ? input.target : null
  )
  const ready = maintenance.installation?.status === 'ready'
  const recoveryKey = ready
    ? JSON.stringify([
        sessionId,
        maintenance.state?.evidence?.configurationId,
        maintenance.installation?.version,
        maintenance.state?.job?.id
      ])
    : null
  const attempted = useRef<string | null>(null)
  const { retry } = launch
  const status = maintenance.installation?.status
  useLayoutEffect(() => {
    if (status === 'missing' || status === 'unsupported') {
      attempted.current = null
    }
    if (!processless || !recoveryKey || attempted.current === recoveryKey) {
      return
    }
    // A directory/account mismatch must not turn one ready check into a retry loop.
    attempted.current = recoveryKey
    retry()
  }, [recoveryKey, processless, retry, status])
  const updated: NativeChatComposerNotice | null = ready
    ? {
        key: 'codex-installation',
        kind: 'error',
        text: translate('codex.maintenance.updatedRetry', 'Codex is updated. Retry.'),
        action: {
          label: translate('auto.components.native.chat.NativeChatLaunchRetry.retry', 'Retry'),
          onClick: refused
            ? retry
            : () => {
                void retryQueued()
              }
        }
      }
    : null
  return {
    ...maintenance,
    blocked: refused && maintenance.blocked,
    notice: maintenance.notice ?? updated
  }
}

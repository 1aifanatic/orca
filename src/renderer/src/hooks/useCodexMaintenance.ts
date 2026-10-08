import { createContext, useLayoutEffect, useSyncExternalStore } from 'react'
import { codexMaintenanceHostIsReachable } from '@/lib/codex-maintenance-host-contact'
import { observeCodexMaintenance } from '@/lib/codex-maintenance-observation'
import {
  codexMaintenanceTargetKey,
  type CodexMaintenanceTarget
} from '@/lib/codex-maintenance-client'
import {
  getCodexMaintenanceEntry,
  getCodexMaintenanceHostBusy,
  refreshCodexMaintenance,
  startCodexMaintenance,
  subscribeCodexMaintenance
} from '@/lib/codex-maintenance-store'
import {
  codexMaintenanceLabel,
  codexMaintenanceReason,
  codexMaintenanceTitle,
  codexMaintenanceCommandText
} from '@/components/native-chat/codex-maintenance-copy'
import type { NativeChatComposerNotice } from '@/components/native-chat/native-chat-composer-notice'

export const NativeChatCodexMaintenanceContext = createContext<NativeChatComposerNotice | null>(
  null
)

export function useCodexMaintenance(target: CodexMaintenanceTarget | null) {
  const key = target ? codexMaintenanceTargetKey(target) : ''
  const snapshot = () => getCodexMaintenanceEntry(key)
  const entry = useSyncExternalStore(subscribeCodexMaintenance, snapshot, snapshot)
  const busySnapshot = () => Boolean(target && getCodexMaintenanceHostBusy(target))
  const hostBusy = useSyncExternalStore(subscribeCodexMaintenance, busySnapshot, busySnapshot)
  const kind = target?.kind
  const identifier =
    target?.kind === 'environment'
      ? target.environmentId
      : target?.kind === 'ssh'
        ? target.connectionId
        : null
  const cwd = target?.cwd
  useLayoutEffect(() => {
    const host: CodexMaintenanceTarget | null =
      kind === 'local'
        ? { kind }
        : kind === 'environment' && identifier
          ? { kind, environmentId: identifier }
          : kind === 'ssh' && identifier
            ? { kind, connectionId: identifier }
            : null
    if (!host) {
      return
    }
    const context = { ...host, ...(cwd ? { cwd } : {}) }
    const unsubscribeContact = observeCodexMaintenance(context)
    void refreshCodexMaintenance(context)
    const onFocus = (): void => {
      void refreshCodexMaintenance(context)
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      unsubscribeContact()
    }
  }, [kind, identifier, cwd])
  const installation =
    entry.verification === 'current' && target && codexMaintenanceHostIsReachable(target)
      ? entry.state?.installation
      : undefined
  const blocked = installation?.status === 'missing' || installation?.status === 'unsupported'
  const busy = hostBusy || entry.starting
  const action =
    installation &&
    target &&
    entry.state?.action &&
    entry.state.action.kind !== 'unknown' &&
    entry.state.canRun
      ? {
          label: codexMaintenanceLabel(entry.state.action.kind === 'update', busy),
          disabled: busy,
          busy,
          onClick: () => startCodexMaintenance(target)
        }
      : undefined
  const notice: NativeChatComposerNotice | null =
    blocked && installation
      ? {
          key: 'codex-installation',
          kind: 'error',
          title: codexMaintenanceTitle(installation),
          text: codexMaintenanceReason(installation),
          action,
          ...(!entry.state?.canRun && entry.state?.action
            ? {
                errorText: codexMaintenanceCommandText(
                  entry.state.action,
                  installation.minimumVersion
                )
              }
            : {})
        }
      : null
  return { ...entry, installation, blocked, busy, action, notice }
}

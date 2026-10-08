import { createContext, useEffect, useSyncExternalStore } from 'react'
import {
  codexMaintenanceTargetKey,
  type CodexMaintenanceTarget
} from '@/lib/codex-maintenance-client'
import {
  getCodexMaintenanceEntry,
  refreshCodexMaintenance,
  startCodexMaintenance,
  subscribeCodexMaintenance
} from '@/lib/codex-maintenance-store'
import {
  codexMaintenanceLabel,
  codexMaintenanceReason,
  codexMaintenanceTitle
} from '@/components/native-chat/codex-maintenance-copy'
import type { NativeChatComposerNotice } from '@/components/native-chat/native-chat-composer-notice'

export const NativeChatCodexMaintenanceContext =
  createContext<NativeChatComposerNotice['action']>(undefined)

export function useCodexMaintenance(target: CodexMaintenanceTarget | null) {
  const key = target ? codexMaintenanceTargetKey(target) : ''
  const snapshot = () => getCodexMaintenanceEntry(key)
  const entry = useSyncExternalStore(subscribeCodexMaintenance, snapshot, snapshot)
  const kind = target?.kind
  const identifier =
    target?.kind === 'environment'
      ? target.environmentId
      : target?.kind === 'ssh'
        ? target.connectionId
        : null
  useEffect(() => {
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
    void refreshCodexMaintenance(host)
    const onFocus = (): void => {
      void refreshCodexMaintenance(host)
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
    }
  }, [kind, identifier])
  const installation = entry.state?.installation
  const blocked = installation?.status === 'missing' || installation?.status === 'unsupported'
  const busy =
    entry.starting ||
    (!entry.error &&
      Boolean(
        entry.state?.job &&
        (entry.state.job.phase === 'queued' || entry.state.job.phase === 'running')
      ))
  const action =
    target && entry.state?.action && entry.state.action.kind !== 'unknown' && entry.state.canRun
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
            ? { errorText: entry.state.action.command }
            : {})
        }
      : null
  return { ...entry, blocked, busy, action, notice }
}

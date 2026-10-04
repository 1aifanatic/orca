import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import {
  runtimeHostConnectionStateForEntry,
  type RuntimeHostConnectionState
} from '@/runtime/runtime-host-connection-state'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

export type NativeChatHostOutageKind = 'reconnecting' | 'offline'

export type NativeChatHostOutage = {
  kind: NativeChatHostOutageKind
  environmentId: string
  hostLabel: string
  /** Sends keep queuing in the outbox, which delivers them once the host answers again. */
  composerPlaceholder: string
}

/** A blip shorter than this says nothing; an offline host is said at once. */
export const NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS = 2_000

export function nativeChatHostOutageKind(
  state: RuntimeHostConnectionState
): NativeChatHostOutageKind | null {
  // A closed workspace window still answers; only work that needs that window waits.
  switch (state) {
    case 'connected':
    case 'workspace-window-closed':
      return null
    // Refused, retired by Disconnect, or never reached: no transport is coming back on its own.
    case 'disconnected':
      return 'offline'
    // Still retrying; 'runtime-unavailable' is also published on every recovery, before the probe.
    case 'checking':
    case 'reconnecting':
    case 'runtime-unavailable':
      return 'reconnecting'
  }
}

/** The chat's host outage, read from the host's connection state and never the chat's own stream. */
export function useNativeChatHostOutage(target: RuntimeClientTarget): NativeChatHostOutage | null {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const kind = useAppStore((s) =>
    environmentId === null
      ? null
      : nativeChatHostOutageKind(
          runtimeHostConnectionStateForEntry(s.runtimeStatusByEnvironmentId.get(environmentId))
        )
  )
  const settings = useAppStore((s) => s.settings)
  const environmentName = useAppStore((s) =>
    environmentId === null
      ? null
      : (s.runtimeEnvironments.find((environment) => environment.id === environmentId)?.name ??
        null)
  )
  // What this outage has earned so far; it ends with the outage or a change of host.
  const [earned, setEarned] = useState<{
    environmentId: string
    kind: NativeChatHostOutageKind
  } | null>(null)
  const earnedHere = earned?.environmentId === environmentId ? earned.kind : null
  // Held to the outage's end, so a retry's probe doesn't flip it to reconnecting and back.
  if (kind === 'offline' && environmentId !== null && earnedHere !== 'offline') {
    setEarned({ environmentId, kind: 'offline' })
  }
  const inOutage = kind !== null
  useEffect(() => {
    if (environmentId === null || !inOutage) {
      return
    }
    const timer = setTimeout(() => {
      setEarned((current) =>
        current?.environmentId === environmentId ? current : { environmentId, kind: 'reconnecting' }
      )
    }, NATIVE_CHAT_HOST_RECONNECTING_GRACE_MS)
    return () => {
      clearTimeout(timer)
      setEarned((current) => (current?.environmentId === environmentId ? null : current))
    }
  }, [environmentId, inOutage])
  const shown = kind === 'offline' ? 'offline' : kind === null ? null : earnedHere
  const hostLabel =
    environmentId === null || shown === null
      ? null
      : getHostDisplayLabelOverrides(settings).get(toRuntimeExecutionHostId(environmentId)) ||
        environmentName ||
        environmentId
  return useMemo(
    () =>
      environmentId === null || shown === null || hostLabel === null
        ? null
        : {
            kind: shown,
            environmentId,
            hostLabel,
            composerPlaceholder: translate(
              'components.native-chat.hostOutage.placeholder',
              'Messages send when {{hostName}} reconnects',
              { hostName: hostLabel }
            )
          },
    [environmentId, hostLabel, shown]
  )
}

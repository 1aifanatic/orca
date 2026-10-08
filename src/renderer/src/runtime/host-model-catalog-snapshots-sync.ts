import { useEffect } from 'react'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  forgetHostModelCatalogSnapshots,
  hostModelCatalogSnapshotAgents,
  preloadHostModelCatalogSnapshots
} from './host-model-catalog-snapshots'
import { subscribeLocalRuntimeCapabilitiesKnown } from './local-runtime-capabilities'
import { localStructuredChatsInUse } from './local-structured-chats'
import { subscribeRuntimeHostContactRegained } from './runtime-host-contact-regained'

// The settings that change which account (or binary) a new chat lists under, as the host reads them.
const ACCOUNT_SETTINGS = [
  'activeCodexManagedAccountId',
  'activeCodexManagedAccountIdsByRuntime',
  'codexManagedAccounts',
  'activeClaudeManagedAccountId',
  'activeClaudeManagedAccountIdsByRuntime',
  'claudeManagedAccounts',
  'agentDefaultEnv',
  'agentCmdOverrides'
] as const satisfies readonly (keyof GlobalSettings)[]

const LOCAL = { kind: 'local' } as const

/** Agents this machine's chats were used with: a saved pick says so without starting any CLI. */
function localAgentsInUse(settings: AppState['settings']): string[] {
  return Object.entries(settings?.nativeChatSessionOptions ?? {})
    .filter(([, entry]) => typeof entry?.model === 'string' && entry.model.trim() !== '')
    .map(([agent]) => agent)
}

async function preloadLocal(): Promise<void> {
  const { settings } = useAppStore.getState()
  if (await localStructuredChatsInUse(settings)) {
    await preloadHostModelCatalogSnapshots(LOCAL, localAgentsInUse(settings))
  }
}

function accountSettingsChanged(state: AppState, previous: AppState): boolean {
  return (
    state.settings !== previous.settings &&
    ACCOUNT_SETTINGS.some((key) => state.settings?.[key] !== previous.settings?.[key])
  )
}

/**
 * Loads each host's saved model lists into the renderer before a chat pane asks: this machine's
 * once its runtime answers, for the agents its chats were used with, and a paired host's again each
 * time this client regains contact. An account or launch setting change drops this machine's
 * lists, so the next chat waits for the host's answer rather than show another account's list.
 * Returns the unsubscribe.
 */
export function installHostModelCatalogSnapshotsSync(): () => void {
  void preloadLocal()
  const stopLocal = subscribeLocalRuntimeCapabilitiesKnown(() => void preloadLocal())
  const contactStops = new Map<string, () => void>()
  const watchPairedHosts = (statuses: AppState['runtimeStatusByEnvironmentId']): void => {
    for (const environmentId of statuses.keys()) {
      if (!contactStops.has(environmentId)) {
        const target = { kind: 'environment', environmentId } as const
        contactStops.set(
          environmentId,
          subscribeRuntimeHostContactRegained(environmentId, () => {
            const agents = hostModelCatalogSnapshotAgents(target)
            forgetHostModelCatalogSnapshots(target)
            void preloadHostModelCatalogSnapshots(target, agents)
          })
        )
      }
    }
  }
  watchPairedHosts(useAppStore.getState().runtimeStatusByEnvironmentId)
  const stopStore = useAppStore.subscribe((state, previous) => {
    if (state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId) {
      watchPairedHosts(state.runtimeStatusByEnvironmentId)
    }
    if (accountSettingsChanged(state, previous)) {
      forgetHostModelCatalogSnapshots(LOCAL)
    }
  })
  return () => {
    stopLocal()
    stopStore()
    contactStops.forEach((stop) => stop())
  }
}

export function useHostModelCatalogSnapshotsSync(): void {
  useEffect(() => installHostModelCatalogSnapshotsSync(), [])
}

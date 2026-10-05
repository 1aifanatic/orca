/** The connect path's managed-server step: decide the host's server, and publish a managed connect. */
import { getAppEnvironment } from '../../shared/app-environment'
import type {
  SshConnectionState,
  SshManagedServerServingNote,
  SshManagedServerUpdateNote,
  SshTarget
} from '../../shared/ssh-types'
import type { HostServerOnConnectResult } from '../ssh/ssh-host-server-on-connect'
import { relayServerStatus, shouldToastManagedServerMove } from '../ssh/ssh-host-server-move-offer'
import { clearSshHostServerStatus, setSshHostServerStatus } from '../ssh/ssh-host-server-status'
import { trackSshHostServerMove } from '../ssh/ssh-host-server-telemetry'
import { knownSshHostPlatform } from '../ssh/ssh-host-platform-memo'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { allowsDirectSshRelay } from '../ssh/ssh-connection-store'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'
import {
  broadcastSshState,
  clearRelayStateOverride,
  getPublicSshState
} from './ssh-renderer-broadcast'
import { isAuthError } from '../ssh/ssh-connection-utils'

/** Resolves null when the decision couldn't run on a host that may still use the relay. */
export async function decideHostServer(
  target: SshTarget
): Promise<HostServerOnConnectResult | null> {
  try {
    // Why lazy: the managed-server graph (deploy, migration, tunnel) loads only when a host connects.
    const [{ resolveHostServerOnConnect }, { hostServerOnConnectDeps }] = await Promise.all([
      import('../ssh/ssh-host-server-on-connect'),
      import('./ssh-host-server-on-connect-wiring')
    ])
    return await resolveHostServerOnConnect(
      target,
      hostServerOnConnectDeps(getAppEnvironment().getPath('userData'))
    )
  } catch (error) {
    // A host with no relay fallback surfaces the real failure (auth, unreachable), not a generic one.
    if (!allowsDirectSshRelay(getSshTargetRegistryStore()?.getTarget(target.id) ?? target)) {
      throw error
    }
    console.warn('[ssh] Could not decide the managed Orca server for this host:', error)
    return null
  }
}

/**
 * A host only its managed server reaches failed to set up: leave 'connecting' and the 'setting
 * up' status for the error, as a failed transport connect does.
 */
export function publishHostServerDecisionFailure(targetId: string, error: unknown): void {
  const failure = error instanceof Error ? error : new Error(String(error))
  clearSshHostServerStatus(targetId)
  clearRelayStateOverride(targetId)
  broadcastSshState(getCurrentMainWindow, targetId, {
    targetId,
    status: isAuthError(failure) ? 'auth-failed' : 'error',
    error: failure.message,
    reconnectAttempt: 0
  })
}

export function publishManagedServerConnect(
  targetId: string,
  environmentId: string,
  update?: SshManagedServerUpdateNote,
  serving?: SshManagedServerServingNote
): SshConnectionState {
  const managedServer = {
    kind: 'managed' as const,
    environmentId,
    ...(update ? { update } : {}),
    ...(serving ? { serving } : {})
  }
  setSshHostServerStatus(targetId, managedServer)
  const state: SshConnectionState = {
    ...(connectionManager!.getState(targetId) ?? { targetId, reconnectAttempt: 0 }),
    targetId,
    status: 'connected',
    error: null,
    managedServer
  }
  broadcastSshState(getCurrentMainWindow, targetId, state)
  return getPublicSshState(targetId) ?? state
}

/** Records why the host keeps the relay; the first live-terminals stop this version offers a move. */
export function recordRelayDecision(
  target: SshTarget,
  decision: Extract<HostServerOnConnectResult, { route: 'relay' }>
): void {
  const appVersion = getAppEnvironment().getVersion()
  const offerMove = shouldToastManagedServerMove(target, decision, appVersion)
  if (offerMove) {
    getSshTargetRegistryStore()!.updateTarget(target.id, {
      managedServerMoveOffered: { appVersion }
    })
    trackSshHostServerMove('offered', knownSshHostPlatform(target.id))
  }
  setSshHostServerStatus(target.id, relayServerStatus(decision, offerMove))
}

/** After the relay session is up, a terminal the first decision could not ask about may prove live. */
export async function refineRelayTerminalDecision(
  target: SshTarget,
  decision: HostServerOnConnectResult | null,
  isCurrent: () => boolean
): Promise<void> {
  try {
    const [
      { relayTerminalsOnceConnected },
      { orcadMigrationRelayPtyLister },
      { censusHostRelayTerminalsFor }
    ] = await Promise.all([
      import('../ssh/ssh-host-relay-terminals-once-connected'),
      import('../ssh/orcad-migration-relay-pty-lister'),
      import('../ssh/ssh-host-relay-census-for-target')
    ])
    const refined = await relayTerminalsOnceConnected({
      store: getSshTargetRegistryStore()!.getOrcadMigrationSource(),
      targetId: target.id,
      decision,
      listRelayPtyIds: orcadMigrationRelayPtyLister(target.id),
      censusHost: censusHostRelayTerminalsFor(target),
      isCurrent
    })
    if (refined && isCurrent()) {
      recordRelayDecision(target, refined)
    }
  } catch (error) {
    // The first decision's status stands; it already keeps the host on the relay.
    console.warn('[ssh] Could not re-check relay terminals after connecting:', error)
  }
}

/** A move that stopped short: the status line shows what the census found now, not a stale count. */
export function publishRelayTerminalsStatus(
  target: SshTarget,
  census: { verdict: 'live' | 'unverifiable'; count: number }
): void {
  recordRelayDecision(target, {
    route: 'relay',
    reason: census.verdict === 'live' ? 'relay_terminals_live' : 'relay_terminals_unverifiable',
    terminals: census.count
  })
  const state = getPublicSshState(target.id)
  if (state) {
    broadcastSshState(getCurrentMainWindow, target.id, state)
  }
}

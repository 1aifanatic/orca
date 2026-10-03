/** When a connect that kept the relay offers to move the host now, restarting its terminals. */
import type { SshManagedServerStatus, SshTarget } from '../../shared/ssh-types'
import type { HostServerOnConnectResult } from './ssh-host-server-on-connect'

type RelayDecision = Extract<HostServerOnConnectResult, { route: 'relay' }>

/** Only live terminals: an unverifiable census can't be fixed by stopping them from here. */
export function canOfferManagedServerMove(decision: Pick<RelayDecision, 'reason'>): boolean {
  return decision.reason === 'relay_terminals_live'
}

/** The toast shows once per host per app version; the SSH Hosts action stays regardless. */
export function shouldToastManagedServerMove(
  target: Pick<SshTarget, 'managedServerMoveOffered'>,
  decision: Pick<RelayDecision, 'reason'>,
  appVersion: string
): boolean {
  return (
    canOfferManagedServerMove(decision) &&
    target.managedServerMoveOffered?.appVersion !== appVersion
  )
}

export function relayServerStatus(
  decision: RelayDecision,
  offerMove: boolean
): Extract<SshManagedServerStatus, { kind: 'relay' }> {
  return {
    kind: 'relay',
    reason: decision.reason,
    ...(decision.detail ? { detail: decision.detail } : {}),
    ...(decision.terminals !== undefined ? { terminals: decision.terminals } : {}),
    ...(offerMove ? { offerMove: true } : {})
  }
}

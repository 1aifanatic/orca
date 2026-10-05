/**
 * A connect decides its server before any relay session exists, so a lease this desktop left
 * detached reads unverifiable then: nothing can be asked. Once the relay session is up, the relay
 * holding the PTY answers, and a terminal it still runs is reported live. On Windows, where the
 * host's relay endpoints cannot be listed, this is the only way that answer is ever heard.
 */
import type { Store } from '../persistence'
import type { HostServerOnConnectResult } from './ssh-host-server-on-connect'
import {
  assessOrcadMigrationTerminals,
  type ListRelayPtyIds
} from './orcad-migration-terminal-gate'

type RelayDecision = Extract<HostServerOnConnectResult, { route: 'relay' }>

/** The live decision the connected relay proves, or null when the first decision stands. */
export async function relayTerminalsOnceConnected(args: {
  store: Pick<Store, 'getSshRemotePtyLeases'>
  targetId: string
  decision: HostServerOnConnectResult | null
  listRelayPtyIds: ListRelayPtyIds | null
}): Promise<RelayDecision | null> {
  if (
    args.decision?.route !== 'relay' ||
    args.decision.reason !== 'relay_terminals_unverifiable' ||
    !args.listRelayPtyIds
  ) {
    return null
  }
  const proof = await assessOrcadMigrationTerminals(args.store, args.targetId, args.listRelayPtyIds)
  // Exited is left for the next connect to act on; this connect already runs the relay.
  return proof.verdict === 'live'
    ? { route: 'relay', reason: 'relay_terminals_live', terminals: proof.ptyIds.length }
    : null
}

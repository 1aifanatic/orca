import type { SshTarget } from '../../shared/ssh-types'
import type { CensusHostRelayTerminals } from './orcad-migration-terminal-gate'
import { requireManagedOrcadInfrastructure } from './orcad-managed-runtime-context'
import {
  censusSshHostRelaysBeforeSession,
  hostTerminalProofFromCensus
} from './ssh-host-relay-terminals-on-connect'

/** The host census a terminal proof falls back to when no relay session can be asked. */
export function censusHostRelayTerminalsFor(target: SshTarget): CensusHostRelayTerminals {
  return async () =>
    hostTerminalProofFromCensus(
      await censusSshHostRelaysBeforeSession(
        await requireManagedOrcadInfrastructure().connectionManager.connect(target),
        target.id
      )
    )
}

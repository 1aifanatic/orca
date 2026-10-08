import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isOwnerlessAgentSessionReservation } from '../../runtime/agent-session-lease-transitions'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from './structured-agent-session-send-settlement'

// Beyond the cold-start wait plus scheduling margin, an unheld reservation cannot control work.
export const STRUCTURED_AGENT_SESSION_OWNERLESS_RESERVATION_MAX_AGE_MS =
  STRUCTURED_AGENT_SESSION_START_WAIT_MS + 30_000

export function ownerlessReservationPastRetirementDeadline(
  record: AgentSessionRecord,
  platform: NodeJS.Platform,
  now: number
): boolean {
  return (
    (platform === 'darwin' || platform === 'win32') &&
    isOwnerlessAgentSessionReservation(record) &&
    now - record.lease.lastRenewedAt >= STRUCTURED_AGENT_SESSION_OWNERLESS_RESERVATION_MAX_AGE_MS
  )
}

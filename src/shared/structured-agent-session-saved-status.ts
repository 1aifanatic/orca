// A chat's last settled listing status, saved beside its journal so a restarted host can list it
// without replaying the journal.
//
// Only an idle or no-turn projection is saved, keyed by the journal position it was computed at.
// A reader trusts it only where the journal still stands exactly there; anything else is a miss
// and the journal is opened, so a saved copy can go stale but can never be shown stale.

import type { StructuredAgentSessionStatusProjection } from './structured-agent-session-projection'

/** Bump whenever the projection or the reducer changes what an idle or no-turn chat projects. */
export const STRUCTURED_AGENT_SESSION_STATUS_PROJECTION_VERSION = 1

export type StructuredAgentSessionSavedStatus = {
  v: number
  projection: StructuredAgentSessionStatusProjection
  /** The journal's `lastActivityAt()` at that position, which dates the row. */
  lastActivityAt: number
}

/** Whether a projection is one a saved copy may hold: settled, so no fence can change it. */
export function isSavableStructuredAgentSessionProjection(
  projection: StructuredAgentSessionStatusProjection
): boolean {
  return projection.status === null || projection.status === 'idle'
}

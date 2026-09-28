// Whether a queued draft is held from auto-sending. The hold FACT lives on the
// draft row (`hold_reason`, written through the journal's draft store), so it
// survives handle eviction and restart and dies with the session's journal.
// What lives here is only the per-process instance id that derives the restart
// hold: a draft written by another instance never auto-sends.

import { randomUUID } from 'node:crypto'

/** A per-process id, minted once per host process like the runtime's own
 *  `runtimeId` (`orca-runtime-runtime-id.ts`); a draft written by another
 *  instance publishes as paused rather than auto-sending after a restart. */
let hostInstance = randomUUID()

export function structuredAgentSessionHostInstance(): string {
  return hostInstance
}

/** Simulates a host-process restart. Tests only. */
export function rotateStructuredAgentSessionHostInstanceForTests(): string {
  hostInstance = randomUUID()
  return hostInstance
}

/** Held from auto-sending: a stored hold on the row, or a row written by
 *  another host instance (a restart) — the one derived component. */
export function queuedMessageHeld(row: {
  holdReason: string | null
  hostInstance: string
}): boolean {
  return row.holdReason !== null || row.hostInstance !== hostInstance
}

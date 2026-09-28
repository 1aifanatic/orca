/**
 * Where a host-created agent tab goes, recorded by the caller before it asks the host to launch.
 *
 * The host reveal is the only tab creator, and it knows nothing about placement: which tab group the
 * user launched from, whether the tab takes focus. The caller mints the tab id (the `paneKey` it
 * sends), records its placement here under that id, and the reveal reads it when the tab arrives.
 * Placement never crosses the wire.
 *
 * Renderer memory only, and every entry dies: the reveal consumes it, the caller releases it once
 * the launch settles either way, and an entry nobody consumed or released expires. A window reload
 * drops all of them, and a reveal that finds none uses the default placement.
 */

/** Longer than the launch's readiness budget plus spawn, so a slow but live launch keeps its entry. */
export const AGENT_LAUNCH_TAB_RESERVATION_TTL_MS = 120_000

export type AgentLaunchTabReservation = {
  worktreeId: string
  groupId?: string
  /** Whether the tab takes focus as it appears, as a launch from a button does. */
  focus: boolean
  viewMode?: 'terminal' | 'chat'
  /** Runs once the tab exists, before the launch reply arrives. */
  onRevealed?: (tabId: string) => void
}

type Entry = { reservation: AgentLaunchTabReservation; expiresAt: number }

const reservations = new Map<string, Entry>()

function sweepExpired(now: number): void {
  for (const [tabId, entry] of reservations) {
    if (entry.expiresAt <= now) {
      reservations.delete(tabId)
    }
  }
}

/** Records the placement and returns its release, which is safe to call after the reveal took it. */
export function reserveAgentLaunchTab(
  tabId: string,
  reservation: AgentLaunchTabReservation,
  now = Date.now()
): () => void {
  sweepExpired(now)
  const entry: Entry = { reservation, expiresAt: now + AGENT_LAUNCH_TAB_RESERVATION_TTL_MS }
  reservations.set(tabId, entry)
  return () => {
    if (reservations.get(tabId) === entry) {
      reservations.delete(tabId)
    }
  }
}

/** Consumes the reservation for a tab the host is revealing, if one is live for that workspace. */
export function takeAgentLaunchTabReservation(
  tabId: string,
  worktreeId: string,
  now = Date.now()
): AgentLaunchTabReservation | null {
  sweepExpired(now)
  const entry = reservations.get(tabId)
  if (!entry || entry.reservation.worktreeId !== worktreeId) {
    return null
  }
  reservations.delete(tabId)
  return entry.reservation
}

export function agentLaunchTabReservationCountForTests(): number {
  return reservations.size
}

import type { CodexAppServerHostKey } from './codex-app-server-capability-cache'

// Why: a transiently hung app-server must not block launch prep on every pane.
// The legacy lane remains available while a short, host-scoped cooldown runs.
export const CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS = 5 * 60_000
// Why seconds: a background grant blocks no launch, and a long latch at boot
// keeps ~/.codex off its hooks long after the app-server recovers.
export const CODEX_BACKGROUND_TRUST_GRANT_RETRY_INTERVAL_MS = 10_000
const MAX_TRANSIENT_TRUST_COOLDOWNS = 256

type CooldownLane = { background?: boolean }

const retryAfterByLane = new Map<string, number>()

// Why per lane: a background failure's short retry must not let inline grants
// pay their launch-path timeout every few seconds.
function laneKey(lane: CooldownLane, hostKey: CodexAppServerHostKey): string {
  return lane.background ? `${hostKey}#background` : hostKey
}

export function isCodexTrustGrantCoolingDown(
  lane: CooldownLane,
  hostKey: CodexAppServerHostKey
): boolean {
  const key = laneKey(lane, hostKey)
  const retryAfter = retryAfterByLane.get(key)
  if (retryAfter === undefined) {
    return false
  }
  if (Date.now() < retryAfter) {
    return true
  }
  retryAfterByLane.delete(key)
  return false
}

export function startCodexTrustGrantCooldown(
  lane: CooldownLane,
  hostKey: CodexAppServerHostKey
): void {
  const key = laneKey(lane, hostKey)
  retryAfterByLane.delete(key)
  retryAfterByLane.set(
    key,
    Date.now() +
      (lane.background
        ? CODEX_BACKGROUND_TRUST_GRANT_RETRY_INTERVAL_MS
        : CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS)
  )
  while (retryAfterByLane.size > MAX_TRANSIENT_TRUST_COOLDOWNS) {
    const oldest = retryAfterByLane.keys().next().value
    if (oldest === undefined) {
      break
    }
    retryAfterByLane.delete(oldest)
  }
}

/** A success or a proven-missing surface ends both lanes' cooldowns for the host. */
export function clearCodexTrustGrantCooldowns(hostKey: CodexAppServerHostKey): void {
  retryAfterByLane.delete(laneKey({}, hostKey))
  retryAfterByLane.delete(laneKey({ background: true }, hostKey))
}

export function resetCodexTrustGrantCooldowns(): void {
  retryAfterByLane.clear()
}

export function countCodexTrustGrantCooldowns(): number {
  return retryAfterByLane.size
}

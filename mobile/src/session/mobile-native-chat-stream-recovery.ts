// Why: two screens holding one chat on the same connection evict each other on the host, so an
// unconditional immediate reopen would bounce the chat stream between them forever.
const NATIVE_CHAT_RESUBSCRIBE_FIRST_BACKOFF_MS = 1_000
const NATIVE_CHAT_RESUBSCRIBE_MAX_BACKOFF_MS = 30_000
// Longer than the cap, so a peer that evicts every capped retry never earns a reset.
const NATIVE_CHAT_STREAM_STABLE_MS = 60_000

/** Paces reopening a chat stream the host ended while the screen still wanted it: the first
 *  reopen is immediate, repeats back off exponentially to a cap, and the count resets once a
 *  reopened stream has stayed live past the stability window. */
export class NativeChatStreamRecoveryBackoff {
  private consecutiveEnds = 0
  private liveSince: number | null = null

  noteSnapshot(now: number): void {
    this.liveSince ??= now
  }

  nextDelayMs(now: number): number {
    if (this.liveSince !== null && now - this.liveSince >= NATIVE_CHAT_STREAM_STABLE_MS) {
      this.consecutiveEnds = 0
    }
    this.liveSince = null
    const delay =
      this.consecutiveEnds === 0
        ? 0
        : Math.min(
            NATIVE_CHAT_RESUBSCRIBE_MAX_BACKOFF_MS,
            NATIVE_CHAT_RESUBSCRIBE_FIRST_BACKOFF_MS * 2 ** (this.consecutiveEnds - 1)
          )
    this.consecutiveEnds += 1
    return delay
  }
}

// The background copy takes no main-thread time while any chat works: a turn running (a prompt it
// waits on included), or a send in flight (the projection behind the host's status feed says
// which, for every provider). It starts no chat then, nor
// until the chats have been quiet for a while, and a chat whose copy is under way when one starts
// working stops at its next batch, publishing nothing and staying owed.

/** How long the chats stay quiet before the copy goes on: past the moments after a turn when a
 *  user reads its answer and sends again, short enough that an idle host soon resumes. */
export const PER_CHAT_FILE_COPY_QUIET_MS = 5_000

/** The host's chats' work, from the projection's `owesWork` behind its status feed. */
export type StructuredAgentSessionChatWork = {
  /** A chat this host holds open has a turn running, even under a prompt, or a send in flight. */
  live: () => boolean
  /** Calls `listener` each time one starts or stops working; returns the unsubscribe. */
  onWork: (listener: () => void) => () => void
}

/** One chat's copy: its signal stops it at quit, or the moment a chat starts working. */
export type PerChatFileCopyChat = {
  signal: AbortSignal
  /** Stopped because a chat started working, not for quit: no failure, and still owed. */
  stoppedByWork: () => boolean
  release: () => void
}

export class StructuredAgentSessionPerChatFileCopyActivity {
  /** When a chat was last seen working: a tick saw it, or it started or stopped. */
  private lastWorkAt = Number.NEGATIVE_INFINITY
  private chat: AbortController | null = null
  private readonly unsubscribe: () => void

  constructor(
    private readonly deps: { chatWork: StructuredAgentSessionChatWork; now: () => number }
  ) {
    this.unsubscribe = deps.chatWork.onWork(() => {
      this.lastWorkAt = deps.now()
      this.chat?.abort()
    })
  }

  /** No chat works now, and none has for the quiet period: re-derived at every call. */
  quiet(): boolean {
    const now = this.deps.now()
    if (this.deps.chatWork.live()) {
      this.lastWorkAt = now
      return false
    }
    return now - this.lastWorkAt >= PER_CHAT_FILE_COPY_QUIET_MS
  }

  forChat(quit: AbortSignal): PerChatFileCopyChat {
    const work = new AbortController()
    this.chat = work
    // Work that started since the gate let this chat through.
    if (!this.quiet()) {
      work.abort()
    }
    return {
      signal: AbortSignal.any([quit, work.signal]),
      stoppedByWork: () => work.signal.aborted && !quit.aborted,
      release: () => {
        if (this.chat === work) {
          this.chat = null
        }
      }
    }
  }

  dispose(): void {
    this.unsubscribe()
  }
}

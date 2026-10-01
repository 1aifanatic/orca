import type { AgentProcessVerdict } from '../../shared/agent-process-presence'

type CommandEndAgentExitDeps = {
  /** The PTY's pane keys whose host row is live (not a resume remnant), each with that row's
   *  `receivedAt`: the anchor a verdict may act on. */
  readLiveRowAnchors(ptyId: string): Map<string, number>
  /** The hook presence check: the row's own agent pid and start time. An `exited` answer has
   *  already cleared that row; null when no hook identified a process. */
  checkHookAgentPresence(paneKey: string): Promise<AgentProcessVerdict | null>
  /** The PTY's spawned shell owns the foreground with no job stopped; false when its host cannot say. */
  confirmShellOwnsForeground(ptyId: string): Promise<boolean>
  /** Clears a pane whose agent exited, unless its row changed after `armedRowReceivedAt`. */
  reconcileEndedProcess(paneKey: string, armedRowReceivedAt: number): void
}

/**
 * Whether the agent behind a command end (OSC 133;D) exited. A full-screen agent's nested shells
 * leak their own 133;D, so the mark alone proves nothing. A live agent pid wins; then the spawned
 * shell owning the foreground with nothing stopped proves the exit. Anything else keeps the row.
 */
export async function verifyCommandEndAgentExit(
  ptyId: string,
  paneKeys: Iterable<string>,
  deps: Pick<CommandEndAgentExitDeps, 'checkHookAgentPresence' | 'confirmShellOwnsForeground'>
): Promise<AgentProcessVerdict> {
  const verdicts = await Promise.all(
    Array.from(paneKeys, (paneKey) => deps.checkHookAgentPresence(paneKey).catch(() => null))
  )
  if (verdicts.includes('live')) {
    return 'live'
  }
  return (await deps.confirmShellOwnsForeground(ptyId).catch(() => false))
    ? 'exited'
    : 'unverifiable'
}

/**
 * Re-derives every command end, for every PTY whose panes hold a live row, whether its agent exited.
 * Nothing is latched: a row a verdict kept is asked about again at the PTY's next command end.
 */
export class CommandEndAgentExitVerifier {
  /** Per PTY: whether another command end arrived while a verdict was in flight. */
  private readonly running = new Map<string, { rerun: boolean }>()

  constructor(private readonly deps: CommandEndAgentExitDeps) {}

  onCommandEnd(ptyId: string): void {
    const running = this.running.get(ptyId)
    if (running) {
      // Why rerun, not skip: this mark may be the real exit, after the in-flight read saw the agent.
      running.rerun = true
      return
    }
    void this.run(ptyId)
  }

  private async run(ptyId: string): Promise<void> {
    const state = { rerun: true }
    this.running.set(ptyId, state)
    try {
      while (state.rerun) {
        state.rerun = false
        await this.verifyOnce(ptyId)
      }
    } finally {
      this.running.delete(ptyId)
    }
  }

  private async verifyOnce(ptyId: string): Promise<void> {
    const anchors = this.deps.readLiveRowAnchors(ptyId)
    if (anchors.size === 0) {
      return
    }
    if ((await verifyCommandEndAgentExit(ptyId, anchors.keys(), this.deps)) !== 'exited') {
      return
    }
    for (const [paneKey, receivedAt] of anchors) {
      this.deps.reconcileEndedProcess(paneKey, receivedAt)
    }
  }
}

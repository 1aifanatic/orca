import type { AgentProcessVerdict } from '../../shared/agent-process-presence'
import type { ShellForegroundProof } from '../providers/shell-foreground-proof'

type CommandEndAgentExitDeps = {
  /** The PTY's pane keys whose host row is live (not a resume remnant), each with that row's
   *  `receivedAt`: the anchor a verdict may act on. */
  readLiveRowAnchors(ptyId: string): Map<string, number>
  /** The hook presence check: the row's own agent pid and start time. An `exited` answer has
   *  already cleared that row; null when no hook identified a process. */
  checkHookAgentPresence(paneKey: string): Promise<AgentProcessVerdict | null>
  /** The execution host's answer on the pane's own shell; rejects when the host cannot be reached. */
  proveShellForeground(ptyId: string): Promise<ShellForegroundProof>
  /** Clears a pane whose agent exited, unless its row changed after `armedRowReceivedAt`. */
  reconcileEndedProcess(paneKey: string, armedRowReceivedAt: number): void
}

/**
 * Whether the agent behind a command end (OSC 133;D) exited. A full-screen agent's nested shells
 * leak their own 133;D, so the mark alone proves nothing where the host can look:
 * 1. a live agent pid keeps the row;
 * 2. the pane's own shell proven back in front means it exited;
 * 3. something else in front keeps the row;
 * 4. a host that cannot be reached keeps it (loss of contact is never evidence of an exit);
 * 5. a host that answered but cannot tell (WSL, Windows, a host without foreground evidence)
 *    leaves the mark as the only evidence, so it stands as the exit, as on the desktop pane.
 */
export async function verifyCommandEndAgentExit(
  ptyId: string,
  paneKeys: Iterable<string>,
  deps: Pick<CommandEndAgentExitDeps, 'checkHookAgentPresence' | 'proveShellForeground'>
): Promise<AgentProcessVerdict> {
  const verdicts = await Promise.all(
    Array.from(paneKeys, (paneKey) => deps.checkHookAgentPresence(paneKey).catch(() => null))
  )
  if (verdicts.includes('live')) {
    return 'live'
  }
  let proof: ShellForegroundProof
  try {
    proof = await deps.proveShellForeground(ptyId)
  } catch {
    return 'unverifiable'
  }
  // Why TEMPORARY for `unprovable`: a nested shell's mark under a live TUI there drops its row.
  return proof === 'other' ? 'unverifiable' : 'exited'
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
    this.run(ptyId).catch((error: unknown) => {
      console.error('[agent-status] command-end exit check failed', { ptyId, error })
    })
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
      try {
        this.deps.reconcileEndedProcess(paneKey, receivedAt)
      } catch (error) {
        // Why per pane: one pane's failed clear must not strand its siblings' rows.
        console.error('[agent-status] command-end exit clear failed', { ptyId, paneKey, error })
      }
    }
  }
}

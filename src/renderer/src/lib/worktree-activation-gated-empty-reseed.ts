import {
  gateWorktreeAgentActivation,
  type WorktreeAgentActivationOutcome
} from './worktree-agent-activation-gate'
import {
  reseedGatedEmptyWorkspace,
  type GatedEmptyWorkspaceReseedIntent
} from './worktree-initial-terminal-seeding'
import {
  emptyWorkspaceDefaultChatAwaitsDetection,
  loadEmptyWorkspaceDefaultChatDetection
} from './empty-workspace-default-agent-chat'
import {
  claimEmptyWorkspaceDefaultSurface,
  releaseEmptyWorkspaceDefaultSurface
} from './empty-workspace-default-surface-claims'

const latestReseedIntentByGate = new WeakMap<
  Promise<WorktreeAgentActivationOutcome>,
  GatedEmptyWorkspaceReseedIntent
>()

export function gateAndReseedEmptyWorkspace(
  workspaceKey: string,
  intent: GatedEmptyWorkspaceReseedIntent
): void {
  const gate = gateWorktreeAgentActivation(workspaceKey)
  latestReseedIntentByGate.set(gate, intent)
  void gate.then((outcome) => {
    if (latestReseedIntentByGate.get(gate) !== intent) {
      return
    }
    latestReseedIntentByGate.delete(gate)
    if (outcome !== 'empty') {
      return
    }
    if (!intent.seedUserDefaultSurface || !emptyWorkspaceDefaultChatAwaitsDetection(workspaceKey)) {
      reseedGatedEmptyWorkspace(workspaceKey, intent)
      return
    }
    // Why: the default agent depends on the host's list; seeding before it loads locks in a shell.
    if (!claimEmptyWorkspaceDefaultSurface(workspaceKey)) {
      return
    }
    const settle = (): void => {
      releaseEmptyWorkspaceDefaultSurface(workspaceKey)
      // Re-checks the active workspace, host, and emptiness the wait may have changed.
      reseedGatedEmptyWorkspace(workspaceKey, intent)
    }
    void loadEmptyWorkspaceDefaultChatDetection(workspaceKey).then(settle, settle)
  })
}

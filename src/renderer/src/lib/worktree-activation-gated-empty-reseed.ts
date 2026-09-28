import {
  gateWorktreeAgentActivation,
  type WorktreeAgentActivationOutcome
} from './worktree-agent-activation-gate'
import {
  reseedGatedEmptyWorkspace,
  type GatedEmptyWorkspaceReseedIntent
} from './worktree-initial-terminal-seeding'

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
    if (outcome === 'empty') {
      reseedGatedEmptyWorkspace(workspaceKey, intent)
    }
  })
}

import { _settlePendingWorktreeRemovalsForTests } from '../worktree-background-removal'
import type { WorktreeRemovalOutcome } from '../../shared/worktree/removal-outcome'
import { handlers } from './worktrees-test-ipc-surface'

type Handler = (event: unknown, args: unknown) => unknown

/** Last background-removal outcome the harness runtime published, per worktree id. */
export const harnessRemovalOutcomes = new Map<string, WorktreeRemovalOutcome>()

function readWorktreeId(args: unknown): string | undefined {
  return typeof args === 'object' && args !== null && 'worktreeId' in args
    ? String(args.worktreeId)
    : undefined
}

/**
 * Registers an IPC handler on the harness. `worktrees:remove` resolves when its background delete
 * ends, the way the renderer's delete flow does, so tests of what the delete does keep asserting
 * on its finished state and error.
 */
export function registerHarnessHandler(channel: string, handler: Handler): void {
  handlers[channel] = channel === 'worktrees:remove' ? waitForOutcome(handler) : handler
}

function waitForOutcome(handler: Handler): Handler {
  return async (event, args) => {
    const accepted = await handler(event, args)
    const worktreeId = readWorktreeId(args)
    if (
      typeof accepted !== 'object' ||
      accepted === null ||
      !('removing' in accepted) ||
      !worktreeId
    ) {
      return accepted
    }
    await _settlePendingWorktreeRemovalsForTests()
    const outcome = harnessRemovalOutcomes.get(worktreeId)
    if (!outcome) {
      return accepted
    }
    if (outcome.status === 'failed') {
      throw new Error(outcome.error)
    }
    const { removing: _removing, ...rest } = accepted
    return {
      ...rest,
      ...(outcome.preservedBranch ? { preservedBranch: outcome.preservedBranch } : {}),
      ...(outcome.catalogVersion ? { catalogVersion: outcome.catalogVersion } : {})
    }
  }
}

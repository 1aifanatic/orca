import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { WorktreeRemovalOutcome } from '../../shared/worktree/removal-outcome'
import { _settlePendingWorktreeRemovalsForTests } from '../worktree-background-removal'

type RemovalRuntimePrototype = {
  removeManagedWorktree: (...args: never[]) => Promise<RemoveWorktreeResult>
  publishWorktreeRemovalChange: (repoId: string, outcome?: WorktreeRemovalOutcome) => void
}

/**
 * Makes `removeManagedWorktree` resolve when its background delete ends, the way a client that
 * waits for the outcome sees it, so suites about what the delete does keep asserting its end state.
 */
export function awaitBackgroundRemovalsInRuntimeTests(prototype: RemovalRuntimePrototype): void {
  const remove = prototype.removeManagedWorktree
  const publish = prototype.publishWorktreeRemovalChange
  const outcomes: WorktreeRemovalOutcome[] = []
  prototype.publishWorktreeRemovalChange = function (repoId, outcome) {
    if (outcome) {
      outcomes.push(outcome)
    }
    return publish.call(this, repoId, outcome)
  }
  prototype.removeManagedWorktree = async function (...args) {
    const startedAt = outcomes.length
    const accepted = await remove.apply(this, args)
    if (!accepted.removing) {
      return accepted
    }
    await _settlePendingWorktreeRemovalsForTests()
    const selector = String(args[0])
    const published = outcomes.slice(startedAt)
    const outcome =
      published.find((candidate) => selector.includes(candidate.worktreeId)) ?? published.at(-1)
    if (!outcome) {
      return accepted
    }
    if (outcome.status === 'failed') {
      throw new Error(outcome.error)
    }
    const { removing: _removing, ...rest } = accepted
    return {
      ...rest,
      ...(outcome.preservedBranch ? { preservedBranch: outcome.preservedBranch } : {})
    }
  }
}

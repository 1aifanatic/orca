import { createGitOperationExecutor } from './command-runner/git-operation-executor'
import { runWithLocalWorktreeCreateHold } from './local-worktree-create-activity'

export const worktreeCreateGit = createGitOperationExecutor('interactive')

/** A local create: interactive git priority, and background work held off until it settles. */
export function runLocalWorktreeCreate<T>(operation: () => Promise<T>): Promise<T> {
  return runWithLocalWorktreeCreateHold(() => worktreeCreateGit.run(operation))
}

import {
  classifyWorktreeContentOrigin,
  isNamedWorktreeBase,
  ORCA_FORK_REMOTE_CONFIG_ARGS,
  type OrcaCreationContentOrigin
} from '../../shared/worktree/content-origin'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { GitRemoteExec } from './worktree-push-target-cleanup'

/** Classifies a new worktree's content, reading the repo's fork remotes only for a named base. */
export async function resolveWorktreeContentOrigin(args: {
  execGit: GitRemoteExec
  repoPath: string
  baseBranch: string | undefined
  pushTarget: GitPushTarget | undefined
}): Promise<OrcaCreationContentOrigin> {
  const forkRemoteConfig = isNamedWorktreeBase(args.baseBranch)
    ? await args
        .execGit(ORCA_FORK_REMOTE_CONFIG_ARGS, args.repoPath)
        .then(({ stdout }) => stdout)
        .catch(() => null)
    : ''
  return classifyWorktreeContentOrigin({
    baseBranch: args.baseBranch,
    pushTarget: args.pushTarget,
    forkRemoteConfig
  })
}

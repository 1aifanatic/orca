export type GitBranchBaseRunner = (argv: string[]) => Promise<{ stdout: string }>

const COMMIT_OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/i

async function readTrimmedStdout(runGit: GitBranchBaseRunner, argv: string[]): Promise<string> {
  try {
    return (await runGit(argv)).stdout.trim()
  } catch {
    return ''
  }
}

// Why refs only: a bare commit id keeps nothing reachable once the branch is gone.
async function qualifyBaseRef(runGit: GitBranchBaseRunner, base: string): Promise<string> {
  if (!base || base.startsWith('-')) {
    return ''
  }
  if (base.startsWith('refs/')) {
    return base
  }
  return readTrimmedStdout(runGit, ['rev-parse', '--symbolic-full-name', base])
}

/**
 * Refs whose history a removed workspace's branch was cut from: its saved creation base, the
 * remote's default branch, and the main checkout's HEAD. Local reads only; nothing is fetched.
 */
export async function readBranchBaseRefs(
  runGit: GitBranchBaseRunner,
  branchName: string
): Promise<string[]> {
  const savedBase = await qualifyBaseRef(
    runGit,
    await readTrimmedStdout(runGit, ['config', '--get', `branch.${branchName}.base`])
  )
  const remoteDefault = await readTrimmedStdout(runGit, [
    'symbolic-ref',
    '--quiet',
    'refs/remotes/origin/HEAD'
  ])
  // Why HEAD: with an upstream set, `branch -d` compares against the upstream only.
  const candidates = [savedBase, remoteDefault, 'HEAD']
  const ownRef = `refs/heads/${branchName}`
  return candidates.filter(
    (ref, index) =>
      ref && !ref.startsWith('-') && ref !== ownRef && candidates.indexOf(ref) === index
  )
}

/**
 * True when `head` is in the history of a ref the branch was cut from, so deleting the branch
 * drops no commit. Orca creates workspace branches with `--no-track`, which makes `branch -d`
 * compare against the main checkout's HEAD instead: a workspace with no commits of its own is
 * refused when that HEAD is behind its base or on another branch.
 */
export async function isBranchHeadInBaseHistory(
  runGit: GitBranchBaseRunner,
  branchName: string,
  head: string
): Promise<boolean> {
  if (!COMMIT_OID.test(head)) {
    return false
  }
  for (const ref of await readBranchBaseRefs(runGit, branchName)) {
    try {
      // Exit 1 (not an ancestor) and a missing ref both throw.
      await runGit(['merge-base', '--is-ancestor', head, ref])
      return true
    } catch {
      // Try the next ref.
    }
  }
  return false
}

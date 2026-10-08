import { encodeGitPathspecs } from './git-pathspec-stdin'

/**
 * Host-side "stage everything" for a Source Control listing that hit the status
 * cap: the renderer only holds the first rows, so it cannot name every path.
 * `all` stages tracked and untracked changes; `tracked` stages only tracked ones.
 */
export type GitStageWorktreeScope = 'all' | 'tracked'

export function parseGitStageWorktreeScope(value: unknown): GitStageWorktreeScope | undefined {
  return value === 'all' || value === 'tracked' ? value : undefined
}

type GitStageRunner = (args: string[], stdin?: string) => Promise<{ stdout: string }>

function nulSeparatedPaths(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean)
}

export async function stageGitWorktreeScope(
  scope: GitStageWorktreeScope,
  runGit: GitStageRunner
): Promise<void> {
  // Why: --relative keeps a folder workspace inside a larger repo from staging outside its folder.
  const unresolved = nulSeparatedPaths(
    (await runGit(['diff', '--name-only', '--relative', '-z', '--diff-filter=U'])).stdout
  )
  if (unresolved.length === 0) {
    await runGit(['add', scope === 'all' ? '--all' : '--update', '--', '.'])
    return
  }
  // Why: `git add` resolves an unmerged path even under an exclude pathspec, so name the rest instead.
  const unresolvedSet = new Set(unresolved)
  const tracked = nulSeparatedPaths(
    (await runGit(['diff', '--name-only', '--relative', '-z'])).stdout
  ).filter((path) => !unresolvedSet.has(path))
  const untracked =
    scope === 'all'
      ? nulSeparatedPaths(
          (await runGit(['ls-files', '-z', '--others', '--exclude-standard'])).stdout
        )
      : []
  const paths = [...new Set([...tracked, ...untracked])]
  if (paths.length === 0) {
    return
  }
  await runGit(
    ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
    encodeGitPathspecs(paths.map((path) => `:(literal)${path}`))
  )
}

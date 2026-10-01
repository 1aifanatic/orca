import { describe, expect, it } from 'vitest'
import { buildResolvePullRequestConflictsPrompt } from './SourceControl'

describe('buildResolvePullRequestConflictsPrompt', () => {
  it('names the base branch and repository and leaves listing the conflicted files to Git', () => {
    const prompt = buildResolvePullRequestConflictsPrompt({
      worktreePath: '/repo/worktree',
      baseRef: 'main',
      baseRepository: { owner: 'acme', repo: 'widgets', host: 'github.com' }
    })

    expect(prompt).toContain('Resolve the merge conflicts reported for this pull request')
    expect(prompt).toContain(
      '- Conflict source: pull request mergeability check (the local worktree may not have MERGE_HEAD yet).'
    )
    expect(prompt).toContain('- PR base: branch "main" of repository "acme/widgets"')
    expect(prompt).toContain('- Operation to create locally: merge')
    expect(prompt).toContain('do not treat the handoff as stale')
    expect(prompt).toContain(
      '- Conflicted files: Git lists them once the merge below stops; read them with git status'
    )
    expect(prompt).toContain('git fetch <remote> main')
    expect(prompt).toContain('git merge --no-ff --no-edit FETCH_HEAD')
    expect(prompt).toContain(
      '- Edit the conflicted files only unless correctness requires another file.'
    )
    expect(prompt).not.toContain('Resolve the current merge conflicts')
    expect(prompt).not.toContain('listed files')
  })

  it('fetches from the remote that matches the base repository, not assuming origin, for fork checkouts', () => {
    const prompt = buildResolvePullRequestConflictsPrompt({
      worktreePath: '/repo/worktree',
      baseRef: 'main',
      baseRepository: { owner: 'upstream-org', repo: 'widgets' }
    })

    expect(prompt).toContain('Find the remote whose URL points at "upstream-org/widgets"')
    expect(prompt).toContain('often "upstream", not "origin"')
    expect(prompt).not.toContain('git fetch origin')
    expect(prompt).not.toContain('origin/main')
  })

  it('includes a non-github.com host in the repository name', () => {
    const prompt = buildResolvePullRequestConflictsPrompt({
      worktreePath: '/repo/worktree',
      baseRef: 'main',
      baseRepository: { owner: 'acme', repo: 'widgets', host: 'git.example.com' }
    })

    expect(prompt).toContain('of repository "git.example.com/acme/widgets"')
  })

  it('reads a refreshed non-base upstream before fetching the base, without stopping on it', () => {
    const prompt = buildResolvePullRequestConflictsPrompt({
      worktreePath: '/repo/worktree',
      baseRef: 'main',
      baseRepository: { owner: 'acme', repo: 'widgets' }
    })
    const upstreamLine =
      '- Before fetching the base (that fetch sets FETCH_HEAD), if the current branch has an upstream (git rev-parse --abbrev-ref @{upstream}) whose branch name is not "main", fetch that branch from its remote and note from git status -sb whether it is ahead or behind. Do not stop or pull because of it.'

    expect(prompt).toContain(upstreamLine)
    expect(prompt.indexOf(upstreamLine)).toBeLessThan(prompt.indexOf('- Fetch branch "main"'))
    expect(prompt.indexOf(upstreamLine)).toBeLessThan(prompt.indexOf('git merge --no-ff'))
  })

  it('reads any upstream when the base branch is unknown', () => {
    const prompt = buildResolvePullRequestConflictsPrompt({ worktreePath: '/repo/worktree' })

    expect(prompt).toContain(
      '(git rev-parse --abbrev-ref @{upstream}), fetch that branch from its remote'
    )
  })

  it('reports behind, then ahead, then a possibly stale host for a clean merge, and never pushes', () => {
    const prompt = buildResolvePullRequestConflictsPrompt({
      worktreePath: '/repo/worktree',
      baseRef: 'main',
      baseRepository: { owner: 'acme', repo: 'widgets' }
    })

    expect(prompt).toContain(
      "- If the merge completes with no conflicts or is already up to date: if the branch was behind that upstream, say the pull request head has commits this worktree lacks, which must be pulled before pushing; else if it was ahead, say its unpushed commits appear to already resolve the conflicts and pushing will update the pull request; otherwise say merging the pull request's actual base is clean, so the host's conflict report may be stale. Do not push in any case."
    )
    expect(prompt).toContain(
      'Reply with decisions by file, validation run, the final git status, and anything left unsafe; if the branch was behind that upstream, add that the pull request head has commits to pull before pushing.'
    )
  })

  it('names a merge request in the upstream and clean-merge rules for GitLab', () => {
    const prompt = buildResolvePullRequestConflictsPrompt({
      worktreePath: '/repo/worktree',
      baseRef: 'main',
      reviewKind: 'MR'
    })

    expect(prompt).toContain('say the merge request head has commits this worktree lacks')
    expect(prompt).toContain('pushing will update the merge request; otherwise')
    expect(prompt).toContain("merging the merge request's actual base is clean")
    expect(prompt).toContain('add that the merge request head has commits to pull before pushing')
  })

  it('does not emit unquoted git commands for option-looking base branches', () => {
    const prompt = buildResolvePullRequestConflictsPrompt({
      worktreePath: '/repo/worktree',
      baseRef: '-upload-pack=sh'
    })

    expect(prompt).toContain('- PR base branch: "-upload-pack=sh"')
    expect(prompt).toContain('quoting the ref exactly for the current shell')
    expect(prompt).not.toContain('git fetch <remote> -upload-pack=sh')
    expect(prompt).not.toContain('origin/-upload-pack=sh')
  })

  it('uses merge request wording and the hosting remote for GitLab, which has no base name', () => {
    const prompt = buildResolvePullRequestConflictsPrompt({
      reviewKind: 'MR',
      worktreePath: '/repo/worktree'
    })

    expect(prompt).toContain('reported for this merge request')
    expect(prompt).toContain('- Conflict source: merge request mergeability check')
    expect(prompt).toContain('- MR base branch: unavailable')
    expect(prompt).toContain('Use the remote that hosts this merge request.')
    expect(prompt).toContain('Identify the merge request base branch from the MR metadata')
    expect(prompt).not.toContain('pull request')
  })
})

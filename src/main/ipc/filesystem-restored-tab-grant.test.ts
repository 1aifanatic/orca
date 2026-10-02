import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type * as RepoWorktrees from '../repo-worktrees'
import type { Repo } from '../../shared/repo-types'
import { authorizeExternalPathOutsideAllowedRoots, resolveAuthorizedPath } from './filesystem-auth'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'

vi.mock('../repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktrees>('../repo-worktrees')
  return { ...actual, listRepoWorktreeGraph: vi.fn(async () => []) }
})

function makeStore(repoPath: string): Store {
  const repo = {
    id: 'repo-local',
    path: repoPath,
    displayName: 'project',
    badgeColor: '#000',
    addedAt: 0
  } satisfies Repo
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these Store members.
  return {
    getRepos: () => [{ ...repo }],
    getProjects: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
  } as unknown as Store
}

// Why: creating a symlink on Windows needs elevation or Developer Mode.
describe.skipIf(process.platform === 'win32')('authorizeExternalPathOutsideAllowedRoots', () => {
  let base: string
  let project: string
  let alias: string
  let outside: string
  let secret: string

  beforeEach(async () => {
    invalidateAuthorizedRootsCache()
    base = await mkdtemp(join(await realpath(tmpdir()), 'orca-restored-grant-'))
    project = join(base, 'real', 'project')
    alias = join(base, 'alias-project')
    outside = join(base, 'outside')
    await mkdir(project, { recursive: true })
    await mkdir(outside)
    await symlink(project, alias)
    secret = join(outside, 'secret.txt')
    await writeFile(secret, 'secret\n')
    await writeFile(join(project, 'notes.md'), 'notes\n')
    await symlink(secret, join(project, 'escape.txt'))
    await symlink(outside, join(project, 'dir-link'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('grants a restored floating-workspace file outside every project', async () => {
    const store = makeStore(project)
    const notes = join(base, 'home-notes.txt')
    await writeFile(notes, 'home\n')
    await expect(resolveAuthorizedPath(notes, store)).rejects.toThrow('Access denied')

    await authorizeExternalPathOutsideAllowedRoots(notes, store)

    await expect(resolveAuthorizedPath(notes, store)).resolves.toBe(notes)
  })

  // The project is in main's store even before the renderer has listed its worktrees.
  it.each([
    ['a leaf symlink', 'escape.txt'],
    ['a directory symlink', join('dir-link', 'secret.txt')]
  ])('never grants the outside target of %s inside a project', async (_label, relativePath) => {
    const store = makeStore(project)

    await authorizeExternalPathOutsideAllowedRoots(join(project, relativePath), store)

    await expect(resolveAuthorizedPath(join(project, relativePath), store)).rejects.toThrow(
      'Access denied'
    )
    await expect(resolveAuthorizedPath(secret, store)).rejects.toThrow('Access denied')
  })

  it.each([
    ['registered through an alias, named canonically', 'alias', 'project'],
    ['registered canonically, named through an alias', 'project', 'alias']
  ])(
    'treats a project %s as inside it: symlink targets stay denied, files stay readable',
    async (_label, registeredAs, namedAs) => {
      const store = makeStore(registeredAs === 'alias' ? alias : project)
      const namedRoot = namedAs === 'alias' ? alias : project

      await authorizeExternalPathOutsideAllowedRoots(join(namedRoot, 'escape.txt'), store)
      await authorizeExternalPathOutsideAllowedRoots(join(namedRoot, 'notes.md'), store)

      await expect(resolveAuthorizedPath(join(namedRoot, 'escape.txt'), store)).rejects.toThrow(
        'Access denied'
      )
      await expect(resolveAuthorizedPath(secret, store)).rejects.toThrow('Access denied')
      await expect(resolveAuthorizedPath(join(namedRoot, 'notes.md'), store)).resolves.toBe(
        join(project, 'notes.md')
      )
    }
  )
})

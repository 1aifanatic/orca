import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type * as RepoWorktrees from '../repo-worktrees'
import { authorizeExternalPathOutsideAllowedRoots, resolveAuthorizedPath } from './filesystem-auth'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'

vi.mock('../repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktrees>('../repo-worktrees')
  return { ...actual, listRepoWorktreeGraph: vi.fn(async () => []) }
})

type Registration = { repoPath?: string; folderPath?: string }

function makeStore({ repoPath, folderPath }: Registration): Store {
  const repos = repoPath
    ? [{ id: 'repo-local', path: repoPath, displayName: 'project', badgeColor: '#000', addedAt: 0 }]
    : []
  const folders = folderPath ? [{ id: 'folder', folderPath, projectGroupId: 'none' }] : []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these Store members.
  return {
    getRepos: () => repos.map((repo) => ({ ...repo })),
    getProjects: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => folders.map((folder) => ({ ...folder })),
    getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
  } as unknown as Store
}

async function isReadable(path: string, store: Store): Promise<boolean> {
  return resolveAuthorizedPath(path, store).then(
    () => true,
    () => false
  )
}

let base: string

beforeEach(async () => {
  invalidateAuthorizedRootsCache()
  base = await mkdtemp(join(await realpath(tmpdir()), 'orca-restored-grant-'))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('authorizeExternalPathOutsideAllowedRoots', () => {
  it('grants a restored floating-workspace file outside every project', async () => {
    const project = join(base, 'project')
    await mkdir(project)
    const store = makeStore({ repoPath: project })
    const notes = join(base, 'home-notes.txt')
    await writeFile(notes, 'home\n')
    expect(await isReadable(notes, store)).toBe(false)

    await authorizeExternalPathOutsideAllowedRoots(notes, store)

    expect(await isReadable(notes, store)).toBe(true)
  })
})

// Why: creating a symlink on Windows needs elevation or Developer Mode.
describe.skipIf(process.platform === 'win32')('restore grants and project symlinks', () => {
  let project: string
  let alias: string
  let alias2: string
  let privateBase: string
  let varAlias: string
  let secret: string

  beforeEach(async () => {
    // Mirrors macOS /var -> /private/var: an alias of an ancestor above the project root.
    privateBase = join(base, 'private')
    varAlias = join(base, 'var')
    project = join(privateBase, 'real', 'project')
    alias = join(base, 'alias-project')
    alias2 = join(base, 'alias2-project')
    const outside = join(base, 'outside')
    await mkdir(join(project, 'sub'), { recursive: true })
    await mkdir(outside)
    await symlink(privateBase, varAlias)
    await symlink(project, alias)
    await symlink(project, alias2)
    secret = join(outside, 'secret.txt')
    await writeFile(secret, 'secret\n')
    await writeFile(join(project, 'notes.md'), 'notes\n')
    await symlink(secret, join(project, 'escape.txt'))
    await symlink(outside, join(project, 'dir-link'))
    await symlink(outside, join(project, 'sub', 'deep-link'))
  })

  const viaDirLink = (root: string): string => join(root, 'dir-link', 'secret.txt')

  // Each spelling must still read as inside the project, or the full grant exposes the target.
  it.each<[string, () => Registration, () => string]>([
    [
      'a leaf symlink named as registered',
      () => ({ repoPath: project }),
      () => join(project, 'escape.txt')
    ],
    [
      'a directory symlink named as registered',
      () => ({ repoPath: project }),
      () => viaDirLink(project)
    ],
    [
      'a directory symlink named through an alias',
      () => ({ repoPath: project }),
      () => viaDirLink(alias)
    ],
    [
      'a directory symlink, registered and named through two aliases',
      () => ({ repoPath: alias }),
      () => viaDirLink(alias2)
    ],
    [
      'a directory symlink, registered via alias and named canonically',
      () => ({ folderPath: alias }),
      () => viaDirLink(project)
    ],
    [
      'a deep directory symlink in a folder workspace',
      () => ({ folderPath: project }),
      () => join(alias, 'sub', 'deep-link', 'secret.txt')
    ],
    [
      'a directory symlink named with `..`',
      () => ({ repoPath: project }),
      () => join(alias, 'sub', '..', 'dir-link', 'secret.txt')
    ],
    [
      'a directory symlink named through an ancestor alias',
      () => ({ repoPath: project }),
      () => viaDirLink(project.replace(privateBase, varAlias))
    ],
    [
      'a leaf symlink named through an ancestor alias',
      () => ({ repoPath: project }),
      () => join(project.replace(privateBase, varAlias), 'escape.txt')
    ]
  ])('never grants the outside target of %s', async (_label, registration, namedPath) => {
    const store = makeStore(registration())

    await authorizeExternalPathOutsideAllowedRoots(namedPath(), store)

    expect(await isReadable(secret, store)).toBe(false)
    expect(await isReadable(namedPath(), store)).toBe(false)
  })

  it('never grants the outside target of a case-variant spelling on a case-insensitive disk', async (ctx) => {
    const caseVariant = project.replace(`${privateBase}/real`, `${privateBase}/REAL`)
    const caseInsensitive = await stat(caseVariant).then(
      () => true,
      () => false
    )
    if (!caseInsensitive) {
      ctx.skip()
    }
    const store = makeStore({ repoPath: project })

    await authorizeExternalPathOutsideAllowedRoots(viaDirLink(caseVariant), store)

    expect(await isReadable(secret, store)).toBe(false)
  })

  it.each([
    ['registered through an alias, named canonically', 'alias', 'project'],
    ['registered canonically, named through an alias', 'project', 'alias']
  ])('keeps a project file %s readable', async (_label, registeredAs, namedAs) => {
    const store = makeStore({ folderPath: registeredAs === 'alias' ? alias : project })
    const named = join(namedAs === 'alias' ? alias : project, 'notes.md')

    await authorizeExternalPathOutsideAllowedRoots(named, store)

    await expect(resolveAuthorizedPath(named, store)).resolves.toBe(join(project, 'notes.md'))
  })
})

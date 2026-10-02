import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type * as RepoWorktrees from '../repo-worktrees'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'

type Handler = (event: unknown, args: unknown) => Promise<unknown>

const { handlers, userData } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  userData: { path: '' }
}))

vi.mock('electron', () => ({
  app: { getPath: () => userData.path },
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }
}))
vi.mock('../repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktrees>('../repo-worktrees')
  return { ...actual, listRepoWorktreeGraph: vi.fn(async () => []) }
})

import { registerFilesystemMutationHandlers } from './filesystem-mutations'

let projectPaths: string[] = []

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these Store members.
const STORE = {
  getRepos: () =>
    projectPaths.map((path, index) => ({
      id: `repo-${index}`,
      path,
      displayName: 'project',
      badgeColor: '#000',
      addedAt: 0
    })),
  getProjects: () => [],
  getProjectGroups: () => [],
  getFolderWorkspaces: () => [],
  getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
} as unknown as Store

const documentFolder = (documentPath: string) => ({ kind: 'document-folder', documentPath })

async function settles(promise: Promise<unknown>): Promise<'ok' | 'denied'> {
  return promise.then(
    () => 'ok',
    () => 'denied'
  )
}

function call(channel: string, args: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }
  return handler(null, args)
}

let base: string
let docFolder: string
let note: string

beforeEach(async () => {
  invalidateAuthorizedRootsCache()
  handlers.clear()
  base = await mkdtemp(join(await realpath(tmpdir()), 'orca-document-folder-'))
  userData.path = join(base, 'user-data')
  docFolder = join(base, 'notes')
  note = join(docFolder, 'note.md')
  await mkdir(join(userData.path, 'floating-workspace'), { recursive: true })
  await mkdir(docFolder)
  await writeFile(note, '# note\n')
  await writeFile(join(base, 'shot.png'), 'png')
  projectPaths = []
  registerFilesystemMutationHandlers(STORE)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('renaming a document the user opened outside every project', () => {
  it('renames it within its own folder', async () => {
    const renamed = join(docFolder, 'renamed.md')

    await call('fs:rename', { oldPath: note, newPath: renamed, access: documentFolder(note) })

    expect(await readdir(docFolder)).toEqual(['renamed.md'])
  })

  it('refuses a move out of its folder, another file, and a request with no access', async () => {
    await writeFile(join(docFolder, 'other.md'), 'other')

    expect(
      await settles(
        call('fs:rename', {
          oldPath: note,
          newPath: join(base, 'note.md'),
          access: documentFolder(note)
        })
      )
    ).toBe('denied')
    expect(
      await settles(
        call('fs:rename', {
          oldPath: join(docFolder, 'other.md'),
          newPath: join(docFolder, 'moved.md'),
          access: documentFolder(note)
        })
      )
    ).toBe('denied')
    expect(
      await settles(call('fs:rename', { oldPath: note, newPath: join(docFolder, 'plain.md') }))
    ).toBe('denied')
    expect((await readdir(docFolder)).sort()).toEqual(['note.md', 'other.md'])
  })

  it('undoes a rename with the renamed file declared as the document', async () => {
    const renamed = join(docFolder, 'renamed.md')
    await call('fs:rename', { oldPath: note, newPath: renamed, access: documentFolder(note) })

    await call('fs:rename', { oldPath: renamed, newPath: note, access: documentFolder(renamed) })

    expect(await readdir(docFolder)).toEqual(['note.md'])
  })

  it('refuses a rename into a subfolder, whose Undo could not come back', async () => {
    await mkdir(join(docFolder, 'archive'))

    expect(
      await settles(
        call('fs:rename', {
          oldPath: note,
          newPath: join(docFolder, 'archive', 'note.md'),
          access: documentFolder(note)
        })
      )
    ).toBe('denied')
    expect(await readdir(join(docFolder, 'archive'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a new name through a linked subfolder that leads out',
    async () => {
      await mkdir(join(base, 'elsewhere'))
      await symlink(join(base, 'elsewhere'), join(docFolder, 'linked'))

      expect(
        await settles(
          call('fs:rename', {
            oldPath: note,
            newPath: join(docFolder, 'linked', 'note.md'),
            access: documentFolder(note)
          })
        )
      ).toBe('denied')
      expect(await readdir(join(base, 'elsewhere'))).toEqual([])
    }
  )
})

describe('inserting an image into a document the user opened outside every project', () => {
  it('copies the image into the document folder', async () => {
    const outcome = await call('fs:importExternalPaths', {
      sourcePaths: [join(base, 'shot.png')],
      destDir: docFolder,
      access: documentFolder(note)
    })

    expect(outcome).toMatchObject({ results: [{ status: 'imported' }] })
    expect((await readdir(docFolder)).sort()).toEqual(['note.md', 'shot.png'])
  })

  it('copies the image into a subfolder of the document folder', async () => {
    await mkdir(join(docFolder, 'images'))

    await call('fs:importExternalPaths', {
      sourcePaths: [join(base, 'shot.png')],
      destDir: join(docFolder, 'images'),
      access: documentFolder(note)
    })

    expect(await readdir(join(docFolder, 'images'))).toEqual(['shot.png'])
  })

  it.skipIf(process.platform === 'win32')(
    'refuses an import through a linked subfolder that leads out',
    async () => {
      await mkdir(join(base, 'elsewhere'))
      await symlink(join(base, 'elsewhere'), join(docFolder, 'linked'))

      expect(
        await settles(
          call('fs:importExternalPaths', {
            sourcePaths: [join(base, 'shot.png')],
            destDir: join(docFolder, 'linked'),
            access: documentFolder(note)
          })
        )
      ).toBe('denied')
      expect(await readdir(join(base, 'elsewhere'))).toEqual([])
    }
  )

  it('refuses the parent folder, and any outside folder without access', async () => {
    const importInto = (destDir: string, access?: unknown) =>
      settles(
        call('fs:importExternalPaths', {
          sourcePaths: [join(base, 'shot.png')],
          destDir,
          access
        })
      )

    expect(await importInto(base, documentFolder(note))).toBe('denied')
    expect(await importInto(docFolder)).toBe('denied')
    expect(await readdir(docFolder)).toEqual(['note.md'])
  })
})

describe('a project file opened by its full path', () => {
  it('renames into a subfolder of the project, which the project check allows', async () => {
    const project = join(base, 'project')
    await mkdir(join(project, 'docs', 'old'), { recursive: true })
    await writeFile(join(project, 'docs', 'plan.md'), '# plan\n')
    projectPaths = [project]
    invalidateAuthorizedRootsCache()
    const plan = join(project, 'docs', 'plan.md')

    await call('fs:rename', {
      oldPath: plan,
      newPath: join(project, 'docs', 'old', 'plan.md'),
      access: documentFolder(plan)
    })

    expect(await readdir(join(project, 'docs', 'old'))).toEqual(['plan.md'])
  })

  it('renames into another folder of the same project, as with no declared access', async () => {
    const project = join(base, 'project')
    await mkdir(join(project, 'docs'), { recursive: true })
    await mkdir(join(project, 'archive'))
    await writeFile(join(project, 'docs', 'plan.md'), '# plan\n')
    projectPaths = [project]
    invalidateAuthorizedRootsCache()
    const plan = join(project, 'docs', 'plan.md')

    await call('fs:rename', {
      oldPath: plan,
      newPath: join(project, 'archive', 'plan.md'),
      access: documentFolder(plan)
    })

    expect(await readdir(join(project, 'archive'))).toEqual(['plan.md'])
    expect(await readdir(join(project, 'docs'))).toEqual([])
  })
})

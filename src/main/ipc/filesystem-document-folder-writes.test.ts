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

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these Store members; no project is registered.
const NO_PROJECTS = {
  getRepos: () => [],
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
  registerFilesystemMutationHandlers(NO_PROJECTS)
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

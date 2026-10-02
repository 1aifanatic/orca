import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as NodePath from 'node:path'
import type { Store } from '../persistence'

// Why win32 paths on every host: a UNC image in a document is a Windows credential leak, and the
// guarantee is that its path text is refused before any filesystem call can reach the network.
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof NodePath>('node:path')
  return { ...actual.win32, default: actual.win32 }
})

const { fsCalls } = vi.hoisted(() => {
  const calls: string[] = []
  return { fsCalls: calls }
})

vi.mock('node:fs/promises', () => {
  const record = (name: string) =>
    vi.fn(async (target: unknown) => {
      fsCalls.push(`${name} ${String(target)}`)
      return name === 'realpath' ? target : { isFile: () => true, isDirectory: () => false }
    })
  return { realpath: record('realpath'), stat: record('stat'), open: record('open') }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    statSync: vi.fn((target: unknown) => {
      fsCalls.push(`statSync ${String(target)}`)
      throw new Error('statSync is not expected')
    })
  }
})
vi.mock('electron', () => ({ app: { getPath: () => 'C:\\Users\\me\\AppData\\Roaming\\Orca' } }))
vi.mock('../repo-worktrees', () => ({ listRepoWorktreeGraph: vi.fn(async () => []) }))

import { resolveLocalFileRequestPath } from './filesystem-request-shape'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these Store members.
const store = {
  getRepos: () => [
    { id: 'repo', path: 'C:\\repo', displayName: 'repo', badgeColor: '#000', addedAt: 0 }
  ],
  getProjects: () => [],
  getProjectGroups: () => [],
  getFolderWorkspaces: () => [],
  getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
} as unknown as Store

const networkTargets = [
  '\\\\attacker.example\\share\\x.png',
  '//attacker.example/share/x.png',
  '\\\\?\\UNC\\attacker.example\\share\\x.png'
]

describe('document images on a network share', () => {
  beforeEach(() => {
    fsCalls.length = 0
  })

  it.each(networkTargets)(
    'refuses %s from a project document without touching it',
    async (target) => {
      await expect(
        resolveLocalFileRequestPath(
          target,
          { kind: 'document-resource', documentPath: 'C:\\repo\\README.md' },
          store
        )
      ).rejects.toThrow('Access denied')
      expect(fsCalls.filter((call) => call.includes('attacker'))).toEqual([])
    }
  )

  it.each(networkTargets)(
    'refuses %s from a document outside every project without touching it',
    async (target) => {
      await expect(
        resolveLocalFileRequestPath(
          target,
          { kind: 'document-resource', documentPath: 'C:\\Users\\me\\notes\\todo.md' },
          store
        )
      ).rejects.toThrow('Access denied')
      expect(fsCalls.filter((call) => call.includes('attacker'))).toEqual([])
    }
  )

  it('refuses it with no shape too', async () => {
    await expect(resolveLocalFileRequestPath(networkTargets[0], undefined, store)).rejects.toThrow(
      'Access denied'
    )
    expect(fsCalls.filter((call) => call.includes('attacker'))).toEqual([])
  })
})

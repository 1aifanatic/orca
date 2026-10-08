import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  TerminalTopologyPublisher,
  type TerminalTopologyOwners
} from '../runtime/terminal-topology-publisher'
import {
  renameWorktreeFolderOnFirstWork,
  type FirstWorkFolderRenameDeps
} from './first-work-folder-rename'

const REPO = { id: 'repo1', path: '/repos/orca', connectionId: null } as unknown as Repo
const SETTINGS = { nestWorkspaces: false, workspaceDir: '/ws' } as unknown as GlobalSettings
const OLD_ID = 'repo1::/ws/cunner'
const FOLDER_WORKSPACE_ID = 'repo1::/ws/cunner::workspace:12345678-1234-1234-1234-123456789abc'

function makeDeps(overrides: Partial<FirstWorkFolderRenameDeps> = {}): FirstWorkFolderRenameDeps {
  return {
    getRepo: vi.fn(() => REPO),
    getSettings: vi.fn(() => SETTINGS),
    migrateWorktreeIdentity: vi.fn(),
    notifyWorktreeRenamed: vi.fn(),
    pathExists: vi.fn(async () => false),
    moveWorktree: vi.fn(async () => {}),
    ...overrides
  }
}

describe('renameWorktreeFolderOnFirstWork', () => {
  const originalPlatform = process.platform
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('moves the folder and migrates identity on the happy path', async () => {
    const deps = makeDeps()
    const result = await renameWorktreeFolderOnFirstWork(OLD_ID, 'worktree-creation-spinner', deps)
    expect(result).toBe(true)
    expect(deps.moveWorktree).toHaveBeenCalledWith(
      '/repos/orca',
      '/ws/cunner',
      '/ws/worktree-creation-spinner'
    )
    expect(deps.migrateWorktreeIdentity).toHaveBeenCalledWith(
      OLD_ID,
      'repo1::/ws/worktree-creation-spinner'
    )
    expect(deps.notifyWorktreeRenamed).toHaveBeenCalledWith(
      'repo1',
      OLD_ID,
      'repo1::/ws/worktree-creation-spinner'
    )
  })

  it('preserves the folder-workspace instance suffix in the migrated identity', async () => {
    const deps = makeDeps()
    const result = await renameWorktreeFolderOnFirstWork(
      FOLDER_WORKSPACE_ID,
      'worktree-creation-spinner',
      deps
    )
    expect(result).toBe(true)
    expect(deps.migrateWorktreeIdentity).toHaveBeenCalledWith(
      FOLDER_WORKSPACE_ID,
      'repo1::/ws/worktree-creation-spinner::workspace:12345678-1234-1234-1234-123456789abc'
    )
    expect(deps.notifyWorktreeRenamed).toHaveBeenCalledWith(
      'repo1',
      FOLDER_WORKSPACE_ID,
      'repo1::/ws/worktree-creation-spinner::workspace:12345678-1234-1234-1234-123456789abc'
    )
  })

  it('skips (no move) when the destination already exists', async () => {
    const deps = makeDeps({ pathExists: vi.fn(async () => true) })
    expect(await renameWorktreeFolderOnFirstWork(OLD_ID, 'taken', deps)).toBe(false)
    expect(deps.moveWorktree).not.toHaveBeenCalled()
    expect(deps.migrateWorktreeIdentity).not.toHaveBeenCalled()
  })

  it('skips remote worktrees without moving', async () => {
    const deps = makeDeps({ getRepo: vi.fn(() => ({ ...REPO, connectionId: 'ssh1' })) })
    expect(await renameWorktreeFolderOnFirstWork(OLD_ID, 'fix-auth', deps)).toBe(false)
    expect(deps.moveWorktree).not.toHaveBeenCalled()
  })

  it('skips runtime-owned worktrees without moving', async () => {
    const deps = makeDeps({
      getRepo: vi.fn(() => ({ ...REPO, executionHostId: 'runtime:gpu-vm' as const }))
    })
    expect(await renameWorktreeFolderOnFirstWork(OLD_ID, 'fix-auth', deps)).toBe(false)
    expect(deps.moveWorktree).not.toHaveBeenCalled()
  })

  it('returns false when the repo is unknown', async () => {
    const deps = makeDeps({ getRepo: vi.fn(() => undefined) })
    expect(await renameWorktreeFolderOnFirstWork(OLD_ID, 'fix-auth', deps)).toBe(false)
    expect(deps.moveWorktree).not.toHaveBeenCalled()
  })

  it("tells the window about the rename before main pushes either id's topology", async () => {
    const NEW_ID = 'repo1::/ws/worktree-creation-spinner'
    const tab = (worktreeId: string) => ({
      id: 'tab',
      ptyId: 'pty',
      worktreeId,
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    })
    const ownedBy = (worktreeId: string): TerminalTopologyOwners =>
      new Map([
        [
          worktreeId,
          {
            hostId: 'local',
            session: {
              ...getDefaultWorkspaceSession(),
              tabsByWorktree: { [worktreeId]: [tab(worktreeId)] }
            }
          }
        ]
      ])
    let owners = ownedBy(OLD_ID)
    const order: string[] = []
    const publisher = new TerminalTopologyPublisher(
      () => owners,
      (slice) => order.push(`${slice.worktreeId}: ${slice.tabs.length} tab(s)`)
    )
    publisher.snapshot()
    order.length = 0

    const deps = makeDeps({
      migrateWorktreeIdentity: vi.fn(() => {
        owners = ownedBy(NEW_ID)
        publisher.markDirty()
      }),
      notifyWorktreeRenamed: vi.fn(() => order.push('renamed'))
    })
    await renameWorktreeFolderOnFirstWork(OLD_ID, 'worktree-creation-spinner', deps)
    await Promise.resolve()

    // The window re-keys its tabs first, so the old id's empty slice finds none to drop.
    expect(order).toEqual(['renamed', `${OLD_ID}: 0 tab(s)`, `${NEW_ID}: 1 tab(s)`])
  })
})

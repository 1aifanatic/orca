import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { CLAUDE_PROFILE_MISSING_MESSAGE, ClaudeProfileRouter } from './claude-profile-router'
import {
  claudeProfileHistoryDirs,
  installClaudeProfileRouter
} from './claude-profile-installed-router'

const roots: string[] = []
afterEach(() => {
  installClaudeProfileRouter(undefined)
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function fixture(env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claude-router-'))
  roots.push(root)
  const userHome = join(root, 'personal')
  const dataRoot = join(root, 'data')
  mkdirSync(join(userHome, '.claude'), { recursive: true })
  const account = (id: string): ClaudeManagedAccount => ({
    id,
    email: `${id}@example.test`,
    authMethod: 'subscription-oauth',
    managedAuthPath: '/unused-legacy',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  })
  const settings = {
    claudeManagedAccounts: [account('a'), account('b')],
    activeClaudeManagedAccountId: 'a' as string | null,
    activeClaudeManagedAccountIdsByRuntime: undefined,
    // Hooks off: setup must not probe or touch a real Claude here.
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const router = new ClaudeProfileRouter({ getSettings: () => settings, dataRoot, userHome, env })
  const home = (id: string) => join(dataRoot, 'claude-profiles', id, 'home')
  return { root, userHome, dataRoot, settings, router, home }
}

describe('ClaudeProfileRouter', () => {
  it('publishes the selected folder, System default as empty, and no file without accounts', async () => {
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    await f.router.publish()
    expect(readFileSync(f.router.pointerPath, 'utf8')).toBe(f.home('a'))
    // Setup ran: it writes the ownership marker beside the folder.
    expect(existsSync(join(f.dataRoot, 'claude-profiles', 'a', 'profile.json'))).toBe(true)

    f.settings.activeClaudeManagedAccountId = null
    await f.router.publish()
    expect(readFileSync(f.router.pointerPath, 'utf8')).toBe('')

    f.settings.claudeManagedAccounts = []
    await f.router.publish()
    expect(existsSync(f.router.pointerPath)).toBe(false)
  })

  it('names a never-signed-in folder without creating it, and refuses to launch it', async () => {
    const f = fixture()
    f.settings.activeClaudeManagedAccountId = 'b'
    await f.router.publish()
    expect(readFileSync(f.router.pointerPath, 'utf8')).toBe(f.home('b'))
    expect(existsSync(f.home('b'))).toBe(false)
    expect(() => f.router.preparation()).toThrow(CLAUDE_PROFILE_MISSING_MESSAGE)
    // A terminal still opens; its claude function refuses from the pointer instead.
    expect(f.router.terminalEnv()).toEqual({ ORCA_CLAUDE_PROFILE_POINTER: f.router.pointerPath })
  })

  it('injects the account with its twin, and nothing over the user’s own System default', () => {
    const f = fixture({ CLAUDE_CONFIG_DIR: '/user/own' })
    mkdirSync(f.home('a'), { recursive: true })
    expect(f.router.preparation()).toMatchObject({
      configDir: f.home('a'),
      stripAuthEnv: true,
      envPatch: {
        ORCA_CLAUDE_PROFILE_POINTER: f.router.pointerPath,
        CLAUDE_CONFIG_DIR: f.home('a'),
        ORCA_CLAUDE_INJECTED_CONFIG_DIR: f.home('a')
      }
    })
    f.settings.activeClaudeManagedAccountId = null
    expect(f.router.preparation()).toMatchObject({
      configDir: '/user/own',
      stripAuthEnv: false,
      envPatch: { ORCA_CLAUDE_PROFILE_POINTER: f.router.pointerPath }
    })
    expect(f.router.preparation().envPatch).not.toHaveProperty('CLAUDE_CONFIG_DIR')
  })

  it('treats a CLAUDE_CONFIG_DIR an outer Orca injected as not the user’s', () => {
    const f = fixture({
      CLAUDE_CONFIG_DIR: '/outer/profile',
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/outer/profile'
    })
    expect(f.router.systemDefaultHome()).toBe(join(f.userHome, '.claude'))
  })

  // Why not win32: creating the link needs privileges there.
  it.skipIf(process.platform === 'win32')(
    'lists account history the System default cannot see, skipping linked folders',
    () => {
      const f = fixture()
      expect(claudeProfileHistoryDirs('projects')).toEqual([])
      installClaudeProfileRouter(f.router)
      mkdirSync(join(f.home('a'), 'projects'), { recursive: true })
      mkdirSync(f.home('b'), { recursive: true })
      symlinkSync(join(f.userHome, '.claude'), join(f.home('b'), 'projects'))
      // The pointer file sits among the account folders and must not read as one.
      writeFileSync(join(f.dataRoot, 'claude-profiles', 'selected-host'), '')
      expect(claudeProfileHistoryDirs('projects')).toEqual([join(f.home('a'), 'projects')])
    }
  )
})

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeClaudeProfileRouting } from './claude-profile-native-owner'
import { describeClaudeProfile, prepareClaudeProfileDirectory } from './claude-profile-paths'
import { publishClaudeProfilePointer, readClaudeProfilePointer } from './claude-profile-pointer'
import { requireClaudeProfileRoutingCapability } from '../../shared/claude-profile-routing'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'profile-routing-'))
  roots.push(root)
  const home = join(root, 'personal')
  const dataRoot = join(root, 'data')
  mkdirSync(home)
  mkdirSync(dataRoot)
  const accounts: ClaudeManagedAccount[] = ['a', 'b'].map((id) => ({
    id,
    email: `${id}@example.test`,
    authMethod: 'subscription-oauth',
    managedAuthPath: '/unused-legacy',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }))
  const settings: {
    claudeManagedAccounts: ClaudeManagedAccount[]
    activeClaudeManagedAccountId: string | null
  } = { claudeManagedAccounts: accounts, activeClaudeManagedAccountId: 'a' }
  const worker = {
    prepare: vi.fn(async () => ({ outcome: 'prepared' as const, warnings: [], surfaces: {} }))
  }
  const routing = createNativeClaudeProfileRouting({
    store: {
      getSettings: () => ({ ...settings, agentStatusHooksEnabled: true, disabledTuiAgents: [] })
    },
    dataRoot,
    userHome: home,
    worker,
    claudeVersion: async () => '2.1.261'
  })
  const profiles = ['a', 'b'].map((id) =>
    describeClaudeProfile(dataRoot, id, { runtime: 'host', executionHostId: 'local' })
  )
  profiles.forEach((profile) => prepareClaudeProfileDirectory(dataRoot, profile, home))
  return { root, home, dataRoot, settings, worker, routing, profiles }
}
describe('native Claude profile authority', () => {
  it('re-derives the pointer at startup and selection, passes the version to the worker, and preserves an immutable launch', async () => {
    const f = fixture()
    const launchA = await f.routing.prepare()
    expect(readClaudeProfilePointer(f.routing.pointerPath())).toBe(f.profiles[0].home)
    f.settings.activeClaudeManagedAccountId = 'b'
    await f.routing.startup()
    expect(readClaudeProfilePointer(f.routing.pointerPath())).toBe(f.profiles[1].home)
    expect(launchA.envPatch.CLAUDE_CONFIG_DIR).toBe(f.profiles[0].home)
    expect(f.worker.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ claudeVersion: '2.1.261', hooksEnabled: true })
    )
    f.settings.activeClaudeManagedAccountId = null
    const system = await f.routing.prepare()
    expect(readFileSync(f.routing.pointerPath(), 'utf8')).toBe('')
    expect(system.stripAuthEnv).toBe(false)
    expect(system.envPatch.CLAUDE_CONFIG_DIR).toBe('')
  })
  it('never manufactures missing profiles or silently uses default for a missing selection', async () => {
    const f = fixture()
    rmSync(f.profiles[0].home, { recursive: true })
    await expect(f.routing.prepare()).rejects.toThrow()
    expect(existsSync(f.profiles[0].home)).toBe(false)
    expect(f.worker.prepare).not.toHaveBeenCalled()
    f.settings.activeClaudeManagedAccountId = 'unknown'
    expect(() => f.routing.resolve()).toThrow('unavailable')
  })
  it('refuses escaped, wrong-owner and unavailable profiles', () => {
    const f = fixture()
    writeFileSync(
      join(f.dataRoot, 'claude-profiles/a/profile.json'),
      '{"version":1,"accountId":"b","runtime":"host"}'
    )
    expect(() => f.routing.resolve()).toThrow()
    f.settings.activeClaudeManagedAccountId = 'b'
    rmSync(f.profiles[1].home, { recursive: true })
    symlinkSync(f.home, f.profiles[1].home, 'dir')
    expect(() => f.routing.resolve()).toThrow()
  })
  it('does not publish a stale selection after asynchronous preparation', async () => {
    const f = fixture()
    f.worker.prepare.mockImplementationOnce(async () => {
      f.settings.activeClaudeManagedAccountId = 'b'
      return { outcome: 'prepared', surfaces: {}, warnings: [] }
    })
    await expect(f.routing.prepare()).rejects.toThrow('changed')
    expect(existsSync(f.routing.pointerPath())).toBe(false)
  })
  it('surfaces atomic publication failure and can recover from the authoritative selection', async () => {
    const f = fixture()
    mkdirSync(f.routing.pointerPath())
    await expect(f.routing.startup()).rejects.toThrow()
    rmSync(f.routing.pointerPath(), { recursive: true })
    await f.routing.startup()
    expect(readClaudeProfilePointer(f.routing.pointerPath())).toBe(f.profiles[0].home)
  })
  it('requires host capability and refuses WSL until the guest step, without host fallback', async () => {
    const f = fixture()
    expect(() => requireClaudeProfileRoutingCapability([])).toThrow('Update')
    await expect(f.routing.prepare({ runtime: 'wsl', wslDistro: 'Ubuntu' })).rejects.toThrow('WSL')
    expect(f.worker.prepare).not.toHaveBeenCalled()
    const second = fixture()
    second.settings.activeClaudeManagedAccountId = 'b'
    await second.routing.startup()
    expect(second.routing.resolve().configHome).not.toBe(f.routing.resolve().configHome)
  })
  it('distinguishes explicit default from missing, malformed and missing-directory pointers', () => {
    const f = fixture()
    const pointer = f.routing.pointerPath()
    expect(() => readClaudeProfilePointer(pointer)).toThrow()
    publishClaudeProfilePointer(pointer, null)
    expect(readClaudeProfilePointer(pointer)).toBe(null)
    for (const value of ['\n', '/missing-directory', 'relative', `${f.profiles[0].home}\n`]) {
      writeFileSync(pointer, value)
      expect(() => readClaudeProfilePointer(pointer)).toThrow()
    }
  })
})

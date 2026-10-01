import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => state.home
}))
vi.mock('electron', () => ({ app: { getPath: () => state.home } }))
import { ClaudeHookService } from './hook-service'
import { provisionClaudeProfile } from '../claude-accounts/claude-profile-provisioning'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
const CURRENT = { claudeVersion: '2.1.261' }
function fixture() {
  state.home = mkdtempSync(join(tmpdir(), 'claude-profile-hooks-'))
  roots.push(state.home)
  const defaultDir = join(state.home, '.claude')
  const profile = join(state.home, 'profile')
  mkdirSync(defaultDir)
  mkdirSync(profile)
  const settings = (dir: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  const edit = (dir: string, change: (value: Record<string, unknown>) => void): void => {
    const value = settings(dir)
    change(value)
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(value))
  }
  const service = new ClaudeHookService()
  const installProfile = () => service.install({ ...CURRENT, configDir: profile })
  const provision = () => provisionClaudeProfile({ profileHome: profile, userHome: state.home })
  return { defaultDir, profile, settings, edit, service, installProfile, provision }
}

describe('Claude hooks at an explicit profile', () => {
  it('installs identical managed hooks at a profile without editing default settings', () => {
    const f = fixture()
    writeFileSync(join(f.defaultDir, 'settings.json'), '{"model":"default"}')
    writeFileSync(join(f.profile, 'settings.json'), '{"model":"profile"}')
    expect(f.service.install(CURRENT).state).toBe('installed')
    const before = readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')
    const result = f.installProfile()
    expect(result.configPath).toBe(join(f.profile, 'settings.json'))
    expect(result.state).toBe('installed')
    expect(readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')).toBe(before)
    const settings = f.settings(f.profile)
    expect(settings.model).toBe('profile')
    expect(settings.hooks).toEqual(JSON.parse(before).hooks)
    expect(settings.statusLine).toEqual(JSON.parse(before).statusLine)
  })
  it('retires only the profile statusline marker for an old Claude', () => {
    const f = fixture()
    f.service.install(CURRENT)
    f.installProfile()
    expect(existsSync(join(f.profile, '.orca-statusline.installed'))).toBe(true)
    f.service.install({ claudeVersion: '1.0.0', configDir: f.profile })
    expect(f.settings(f.profile).statusLine).toBeUndefined()
    expect(existsSync(join(f.profile, '.orca-statusline.installed'))).toBe(false)
    expect(existsSync(join(state.home, '.orca/agent-hooks/claude-statusline.installed'))).toBe(true)
  })
  it('keeps a profile opt-out across re-provision and reinstall', async () => {
    const f = fixture()
    f.service.install(CURRENT)
    await f.provision()
    f.installProfile()
    expect(f.settings(f.profile).statusLine).toEqual(f.settings(f.defaultDir).statusLine)
    f.edit(f.profile, (value) => delete value.statusLine)
    await f.provision()
    f.installProfile()
    expect(f.settings(f.profile).statusLine).toBeUndefined()
  })
  it('carries a default-home opt-out to every profile', async () => {
    const f = fixture()
    f.service.install(CURRENT)
    f.installProfile()
    f.edit(f.defaultDir, (value) => delete value.statusLine)
    f.service.install(CURRENT)
    await f.provision()
    f.installProfile()
    expect(f.settings(f.defaultDir).statusLine).toBeUndefined()
    expect(f.settings(f.profile).statusLine).toBeUndefined()
  })
  it('shares a custom default statusline into a profile that had Orca line', async () => {
    const f = fixture()
    f.service.install(CURRENT)
    f.installProfile()
    const custom = { type: 'command', command: 'my-statusline' }
    f.edit(f.defaultDir, (value) => {
      value.statusLine = custom
    })
    await f.provision()
    f.installProfile()
    expect(f.settings(f.profile).statusLine).toEqual(custom)
  })
  it('creates the marker in a profile directory that did not exist yet', () => {
    const f = fixture()
    f.service.install(CURRENT)
    const fresh = join(state.home, 'fresh')
    f.service.install({ ...CURRENT, configDir: fresh })
    expect(existsSync(join(fresh, '.orca-statusline.installed'))).toBe(true)
  })
  it('removes Orca hooks, statusline and marker from a profile only', () => {
    const f = fixture()
    f.service.install(CURRENT)
    f.installProfile()
    const before = readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')
    expect(f.service.remove({ configDir: f.profile }).state).toBe('not_installed')
    expect(f.settings(f.profile)).toEqual({ hooks: {} })
    expect(existsSync(join(f.profile, '.orca-statusline.installed'))).toBe(false)
    expect(readFileSync(join(f.defaultDir, 'settings.json'), 'utf8')).toBe(before)
    expect(f.service.getStatus(CURRENT).state).toBe('installed')
  })
  it('keeps profile destinations off the remote installer', () => {
    type RemoteOptions = Parameters<ClaudeHookService['installRemote']>[2]
    // @ts-expect-error -- remote settings live at the remote default home only
    const remote: RemoteOptions = { configDir: '/profile' }
    expect(remote).toBeDefined()
  })
})

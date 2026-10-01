import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => state.home
}))
vi.mock('electron', () => ({ app: { getPath: () => state.home } }))
import { ClaudeHookService } from './hook-service'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

it('installs identical managed hooks at an explicit profile without editing default settings or inheriting its opt-out marker', () => {
  state.home = mkdtempSync(join(tmpdir(), 'claude-profile-hooks-'))
  roots.push(state.home)
  const defaultDir = join(state.home, '.claude')
  const profile = join(state.home, 'profile')
  mkdirSync(defaultDir)
  mkdirSync(profile)
  writeFileSync(join(defaultDir, 'settings.json'), '{"model":"default"}')
  writeFileSync(join(profile, 'settings.json'), '{"model":"profile"}')
  const service = new ClaudeHookService()
  const options = { claudeVersion: '2.1.261' }
  expect(service.install(options).state).toBe('installed')
  const before = readFileSync(join(defaultDir, 'settings.json'), 'utf8')
  const result = service.install({ ...options, configDir: profile })
  expect(result.configPath).toBe(join(profile, 'settings.json'))
  expect(result.state).toBe('installed')
  expect(readFileSync(join(defaultDir, 'settings.json'), 'utf8')).toBe(before)
  const settings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))
  expect(settings.model).toBe('profile')
  expect(settings.hooks).toEqual(JSON.parse(before).hooks)
  expect(settings.statusLine).toEqual(JSON.parse(before).statusLine)
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { CodexHookService } from './hook-service'

const homes = setupCodexHookHomes(homedirMock, getPathMock)

// Why a retired form: the sweep removes only commands no current build writes.
function retiredManagedHookCommand(): string {
  if (process.platform === 'win32') {
    return join(homes.userDataDir, 'agent-hooks', 'codex-hook.cmd')
  }
  const quoted = `'${join(homes.tmpHome, '.orca', 'agent-hooks', 'codex-hook.sh')}'`
  return `if [ -x ${quoted} ]; then /bin/sh ${quoted}; fi`
}

type HooksFile = { hooks: Record<string, { hooks?: { command?: string }[] }[]> }

function seedRetiredEntryAheadOfUserHook(): { hooksPath: string; tomlPath: string; toml: string } {
  const systemCodexHome = join(homes.tmpHome, '.codex')
  const hooksPath = join(systemCodexHome, 'hooks.json')
  const tomlPath = join(systemCodexHome, 'config.toml')
  mkdirSync(systemCodexHome, { recursive: true })
  writeFileSync(
    hooksPath,
    `${JSON.stringify(
      {
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: retiredManagedHookCommand() }] },
            { hooks: [{ type: 'command', command: 'user-stop-hook', timeout: 30 }] }
          ]
        }
      },
      null,
      2
    )}\n`,
    'utf-8'
  )
  // Why `model =`: a hand-broken line no repair may touch, so every config.toml write is refused.
  const toml = [
    'model =',
    '',
    `[hooks.state."${hooksPath.replaceAll('\\', '\\\\')}:stop:1:0"]`,
    'trusted_hash = "sha256:user"',
    ''
  ].join('\n')
  writeFileSync(tomlPath, toml, 'utf-8')
  return { hooksPath, tomlPath, toml }
}

function moveRefusalWarnings(warn: ReturnType<typeof vi.spyOn>): unknown[][] {
  return warn.mock.calls.filter(
    ([message]) =>
      typeof message === 'string' && message.includes('Skipped moving shifted user hook trust')
  )
}

// Why: the managed mirror copies a hand-broken ~/.codex/config.toml, so its trust
// write is refused first; that refusal must not skip the sweep of ~/.codex/hooks.json.
describe('CodexHookService legacy sweep after a refused trust write', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it.each([
    ['hooks on', true],
    ['hooks off', false]
  ])(
    'with %s, removes the retired entry and refuses the trust move once',
    async (_label, hooksEnabled) => {
      const { hooksPath, tomlPath, toml } = seedRetiredEntryAheadOfUserHook()
      const service = new CodexHookService()

      const first = await service.prepareRuntimeHomeForLaunch(undefined, undefined, hooksEnabled)

      expect(first.state).toBe('error')
      expect(first.detail).not.toContain('..')
      expect(first.detail).not.toContain('Run /hooks')
      const hooks = JSON.parse(readFileSync(hooksPath, 'utf-8')) as HooksFile
      expect(hooks.hooks.Stop).toEqual([
        { hooks: [{ type: 'command', command: 'user-stop-hook', timeout: 30 }] }
      ])
      expect(readFileSync(tomlPath, 'utf-8')).toBe(toml)
      expect(moveRefusalWarnings(warn)).toHaveLength(1)

      seedRetiredEntryAheadOfUserHook()
      await service.prepareRuntimeHomeForLaunch(undefined, undefined, hooksEnabled)

      expect(moveRefusalWarnings(warn)).toHaveLength(1)
    }
  )
})

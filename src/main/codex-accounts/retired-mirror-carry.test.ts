import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { syncSystemConfigIntoManagedCodexHome } from '../codex/codex-config-mirror'
import type * as CodexAccountFs from './fs-utils'
import type * as SettingsPromotion from '../codex/config-settings-promotion'
import { carryRetiredMirror } from './retired-mirror-carry'

const { homedirMock, concurrentEdit } = vi.hoisted(() => {
  const edit: { configToml: string | null; failSettings: boolean } = {
    configToml: null,
    failSettings: false
  }
  return { homedirMock: vi.fn<() => string>(), concurrentEdit: edit }
})

vi.mock('../codex/config-settings-promotion', async (importOriginal) => {
  const actual = await importOriginal<typeof SettingsPromotion>()
  return {
    ...actual,
    promoteCodexRuntimeSettingsToSystem: (
      ...args: Parameters<typeof actual.promoteCodexRuntimeSettingsToSystem>
    ) => (concurrentEdit.failSettings ? null : actual.promoteCodexRuntimeSettingsToSystem(...args))
  }
})

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: homedirMock
}))

// Why: lands a write on ~/.codex/config.toml between the carry's read and its guarded write.
vi.mock('./fs-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof CodexAccountFs>()
  return {
    ...actual,
    writeFileAtomicallyIfUnchanged: (
      ...args: Parameters<typeof actual.writeFileAtomicallyIfUnchanged>
    ) => {
      if (concurrentEdit.configToml !== null && args[0].endsWith('config.toml')) {
        writeFileSync(args[0], concurrentEdit.configToml)
        concurrentEdit.configToml = null
      }
      return actual.writeFileAtomicallyIfUnchanged(...args)
    }
  }
})

let root = ''
let runtimeHomePath = ''
let systemHomePath = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-mirror-carry-'))
  homedirMock.mockReturnValue(join(root, 'user'))
  runtimeHomePath = join(root, 'orca', 'codex-runtime-home', 'home')
  systemHomePath = join(root, 'user', '.codex')
  mkdirSync(runtimeHomePath, { recursive: true })
  concurrentEdit.failSettings = false
  concurrentEdit.configToml = null
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function carry(carryCredentials: () => boolean = () => true): boolean {
  return carryRetiredMirror({ runtimeHomePath, systemHomePath }, markerPath(), carryCredentials)
}

function markerPath(): string {
  return join(root, 'orca', 'codex-runtime-home', 'retired-mirror-carry-v1.json')
}

function completedSteps(): unknown {
  return JSON.parse(readFileSync(markerPath(), 'utf-8')).completed
}

function readSystem(file: string): string {
  return readFileSync(join(systemHomePath, file), 'utf-8')
}

describe('carryRetiredMirror', () => {
  it('carries mirror-only project trust and MCP servers, leaving the mirror intact', () => {
    mkdirSync(systemHomePath, { recursive: true })
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5"\n')
    const mirrorConfig = [
      'model = "gpt-5"',
      '',
      '[projects."C:\\\\work\\\\app"]',
      'trust_level = "trusted"',
      '',
      '[mcp_servers.docs]',
      'command = "docs-mcp"',
      '',
      '[mcp_servers.docs.env]',
      'TOKEN_FILE = "x"',
      ''
    ].join('\n')
    writeFileSync(join(runtimeHomePath, 'config.toml'), mirrorConfig)

    expect(carry()).toBe(true)
    // Additive, so a second run changes nothing.
    expect(carry()).toBe(true)

    const config = readSystem('config.toml')
    expect(config).toContain('model = "gpt-5"')
    expect(
      config.match(/\[projects\."C:\\\\work\\\\app"\]\ntrust_level = "trusted"/g)
    ).toHaveLength(1)
    expect(config).toContain('[mcp_servers.docs]\ncommand = "docs-mcp"')
    expect(config).toContain('[mcp_servers.docs.env]')
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toBe(mirrorConfig)
  })

  it('seeds a missing ~/.codex from the mirror, which was the only config', () => {
    writeFileSync(
      join(runtimeHomePath, 'config.toml'),
      [
        'model_provider = "lab"',
        '',
        '[model_providers.lab]',
        'base_url = "https://lab.example.test/v1"',
        '',
        '[projects."C:\\\\work"]',
        'trust_level = "trusted"',
        ''
      ].join('\n')
    )

    expect(carry()).toBe(true)

    const config = readSystem('config.toml')
    expect(config).toContain('model_provider = "lab"')
    expect(config).toContain('[model_providers.lab]')
    expect(config).toContain('[projects."C:\\\\work"]\ntrust_level = "trusted"')
  })

  it('never overrides what ~/.codex already decided', () => {
    mkdirSync(systemHomePath, { recursive: true })
    const systemConfig = [
      '[projects."C:\\\\work\\\\app"]',
      'trust_level = "untrusted"',
      '',
      '[mcp_servers.docs]',
      'command = "user-docs"',
      ''
    ].join('\n')
    writeFileSync(join(systemHomePath, 'config.toml'), systemConfig)
    writeFileSync(
      join(runtimeHomePath, 'config.toml'),
      [
        '[projects."C:\\\\work\\\\app"]',
        'trust_level = "trusted"',
        '',
        '[mcp_servers.docs]',
        'command = "mirror-docs"',
        ''
      ].join('\n')
    )

    expect(carry()).toBe(true)

    expect(readSystem('config.toml')).toBe(systemConfig)
  })

  it('respects a project ~/.codex declares inline, keeping the file valid TOML', () => {
    mkdirSync(systemHomePath, { recursive: true })
    const systemConfig = 'projects.\'C:\\work\' = { trust_level = "untrusted" }\n'
    writeFileSync(join(systemHomePath, 'config.toml'), systemConfig)
    writeFileSync(
      join(runtimeHomePath, 'config.toml'),
      '[projects.\'C:\\work\']\ntrust_level = "trusted"\n'
    )

    expect(carry()).toBe(true)

    expect(readSystem('config.toml')).toBe(systemConfig)
  })

  it('leaves out an MCP server the mirror copied from ~/.codex and the user removed there', () => {
    mkdirSync(systemHomePath, { recursive: true })
    writeFileSync(join(systemHomePath, 'config.toml'), '[mcp_servers.docs]\ncommand = "server"\n')
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toContain(
      '[mcp_servers.docs]'
    )
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5"\n')

    expect(carry()).toBe(true)

    expect(readSystem('config.toml')).toBe('model = "gpt-5"\n')
  })

  // Why both: a baseline from before MCP ownership was recorded owned the whole MCP root.
  it.each([
    { version: 1, settings: {} },
    { version: 3, settings: {}, mcpServers: [], mcpServerRoot: true }
  ])('respects whole-root MCP ownership in baseline %j', (baseline) => {
    mkdirSync(systemHomePath, { recursive: true })
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5"\n')
    writeFileSync(join(runtimeHomePath, 'config.toml'), '[mcp_servers.docs]\ncommand = "server"\n')
    writeFileSync(
      join(runtimeHomePath, '.orca-config-settings-baseline.json'),
      JSON.stringify(baseline)
    )

    expect(carry()).toBe(true)

    expect(readSystem('config.toml')).toBe('model = "gpt-5"\n')
  })

  it('reruns only the steps still owed, so a landed table removed later stays removed', () => {
    mkdirSync(systemHomePath, { recursive: true })
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5"\n')
    writeFileSync(join(runtimeHomePath, 'config.toml'), '[mcp_servers.docs]\ncommand = "server"\n')
    const carryCredentials = vi.fn(() => carryCredentials.mock.calls.length > 1)

    expect(carry(carryCredentials)).toBe(false)
    expect(completedSteps()).toEqual(['settings', 'hooks', 'tables', 'files'])
    expect(readSystem('config.toml')).toContain('[mcp_servers.docs]')
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5"\n')

    expect(carry(carryCredentials)).toBe(true)
    expect(carryCredentials).toHaveBeenCalledTimes(2)
    expect(completedSteps()).toEqual(['settings', 'hooks', 'tables', 'credentials', 'files'])
    expect(readSystem('config.toml')).toBe('model = "gpt-5"\n')
    expect(carry(carryCredentials)).toBe(true)
    expect(carryCredentials).toHaveBeenCalledTimes(2)
  })

  it('keeps a failing settings step pending while the other steps land', () => {
    writeFileSync(join(runtimeHomePath, 'config.toml'), '[mcp_servers.docs]\ncommand = "server"\n')
    concurrentEdit.failSettings = true

    expect(carry()).toBe(false)
    expect(completedSteps()).toEqual(['hooks', 'tables', 'credentials', 'files'])
    expect(readSystem('config.toml')).toContain('[mcp_servers.docs]')

    concurrentEdit.failSettings = false
    const carryCredentials = vi.fn(() => true)
    expect(carry(carryCredentials)).toBe(true)
    expect(carryCredentials).not.toHaveBeenCalled()
    expect(completedSteps()).toEqual(['settings', 'hooks', 'tables', 'credentials', 'files'])
  })

  it.each(['{not json', '"just a string"', '{}'])(
    'treats an unreadable marker (%s) as done rather than rerunning landed steps',
    (marker) => {
      mkdirSync(systemHomePath, { recursive: true })
      writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5"\n')
      writeFileSync(
        join(runtimeHomePath, 'config.toml'),
        '[mcp_servers.docs]\ncommand = "server"\n'
      )
      writeFileSync(markerPath(), marker)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const carryCredentials = vi.fn(() => true)

      expect(carry(carryCredentials)).toBe(true)

      expect(carryCredentials).not.toHaveBeenCalled()
      expect(readSystem('config.toml')).toBe('model = "gpt-5"\n')
    }
  )

  it('retries tables after a concurrent ~/.codex write refuses the guarded write', () => {
    mkdirSync(systemHomePath, { recursive: true })
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5"\n')
    writeFileSync(join(runtimeHomePath, 'config.toml'), '[mcp_servers.docs]\ncommand = "server"\n')
    concurrentEdit.configToml = 'model = "concurrent"\n'

    expect(carry()).toBe(false)
    expect(readSystem('config.toml')).toBe('model = "concurrent"\n')
    expect(completedSteps()).toEqual(['settings', 'hooks', 'credentials', 'files'])

    expect(carry()).toBe(true)
    expect(readSystem('config.toml')).toBe(
      'model = "concurrent"\n\n[mcp_servers.docs]\ncommand = "server"\n'
    )
  })

  it.each(['', '  \n\t\n'])('seeds an empty ~/.codex config (%j) from the mirror', (empty) => {
    mkdirSync(systemHomePath, { recursive: true })
    writeFileSync(join(systemHomePath, 'config.toml'), empty)
    writeFileSync(
      join(runtimeHomePath, 'config.toml'),
      'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "server"\n'
    )

    expect(carry()).toBe(true)

    expect(readSystem('config.toml')).toBe(
      'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "server"\n'
    )
  })

  it('leaves mirror MCP servers out when ~/.codex declares the whole table inline', () => {
    mkdirSync(systemHomePath, { recursive: true })
    const systemConfig = 'mcp_servers = { user = { command = "user-mcp" } }\n'
    writeFileSync(join(systemHomePath, 'config.toml'), systemConfig)
    writeFileSync(join(runtimeHomePath, 'config.toml'), '[mcp_servers.docs]\ncommand = "server"\n')

    expect(carry()).toBe(true)

    expect(readSystem('config.toml')).toBe(systemConfig)
  })
})

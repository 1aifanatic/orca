import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { syncSystemConfigIntoManagedCodexHome } from '../codex/codex-config-mirror'
import { carryRetiredMirrorConfig } from './retired-mirror-carry'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: homedirMock
}))

let root = ''
let runtimeHomePath = ''
let systemHomePath = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-mirror-carry-'))
  homedirMock.mockReturnValue(join(root, 'user'))
  runtimeHomePath = join(root, 'orca', 'codex-runtime-home', 'home')
  systemHomePath = join(root, 'user', '.codex')
  mkdirSync(runtimeHomePath, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function carry(): boolean {
  return carryRetiredMirrorConfig({ runtimeHomePath, systemHomePath })
}

function readSystem(file: string): string {
  return readFileSync(join(systemHomePath, file), 'utf-8')
}

describe('carryRetiredMirrorConfig', () => {
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
})

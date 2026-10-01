import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { carryRetiredMirrorSettings } from './retired-mirror-carry'

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

function carry(carryMcpCredentials = true): boolean {
  return carryRetiredMirrorSettings({ runtimeHomePath, systemHomePath }, { carryMcpCredentials })
}

function readSystem(file: string): string {
  return readFileSync(join(systemHomePath, file), 'utf-8')
}

describe('carryRetiredSystemDefaultMirror', () => {
  it('carries mirror-only project trust, MCP servers and MCP credentials', () => {
    mkdirSync(systemHomePath, { recursive: true })
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5"\n')
    writeFileSync(
      join(runtimeHomePath, 'config.toml'),
      [
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
    )
    writeFileSync(join(runtimeHomePath, '.credentials.json'), '{"docs":{}}\n')

    expect(carry()).toBe(true)

    const config = readSystem('config.toml')
    expect(config).toContain('model = "gpt-5"')
    expect(config).toContain('[projects."C:\\\\work\\\\app"]\ntrust_level = "trusted"')
    expect(config).toContain('[mcp_servers.docs]\ncommand = "docs-mcp"')
    expect(config).toContain('[mcp_servers.docs.env]')
    expect(readSystem('.credentials.json')).toBe('{"docs":{}}\n')
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
    writeFileSync(join(systemHomePath, '.credentials.json'), 'user-mcp')
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
    writeFileSync(join(runtimeHomePath, '.credentials.json'), 'mirror-mcp')

    carry()

    expect(readSystem('config.toml')).toBe(systemConfig)
    expect(readSystem('.credentials.json')).toBe('user-mcp')
  })

  it("leaves a managed account's MCP credentials out of ~/.codex", () => {
    writeFileSync(join(runtimeHomePath, '.credentials.json'), 'managed-mcp')

    carry(false)

    expect(existsSync(join(systemHomePath, '.credentials.json'))).toBe(false)
  })
})

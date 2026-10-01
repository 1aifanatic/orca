import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import {
  carryRetiredSystemDefaultMirror,
  RETIRED_MIRROR_CARRY_MARKER
} from './retired-mirror-carry'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: homedirMock
}))

let root = ''
let runtimeHomePath = ''
let systemHomePath = ''
let metadataDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-mirror-carry-'))
  homedirMock.mockReturnValue(join(root, 'user'))
  runtimeHomePath = join(root, 'orca', 'codex-runtime-home', 'home')
  systemHomePath = join(root, 'user', '.codex')
  metadataDir = join(root, 'orca', 'codex-runtime-home')
  mkdirSync(runtimeHomePath, { recursive: true })
  mkdirSync(systemHomePath, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function carry(mirrorAuthOwnedBySystemDefault = true): void {
  carryRetiredSystemDefaultMirror({
    runtimeHomePath,
    systemHomePath,
    metadataDir,
    mirrorAuthOwnedBySystemDefault
  })
}

function readSystem(file: string): string {
  return readFileSync(join(systemHomePath, file), 'utf-8')
}

describe('carryRetiredSystemDefaultMirror', () => {
  it('carries mirror-only project trust, MCP servers and a login, once', () => {
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
    writeFileSync(join(runtimeHomePath, 'auth.json'), '{"tokens":{}}\n')

    carry()

    const config = readSystem('config.toml')
    expect(config).toContain('model = "gpt-5"')
    expect(config).toContain('[projects."C:\\\\work\\\\app"]\ntrust_level = "trusted"')
    expect(config).toContain('[mcp_servers.docs]\ncommand = "docs-mcp"')
    expect(config).toContain('[mcp_servers.docs.env]')
    expect(readSystem('auth.json')).toBe('{"tokens":{}}\n')
    expect(existsSync(join(metadataDir, RETIRED_MIRROR_CARRY_MARKER))).toBe(true)

    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "user-edit"\n')
    carry()
    expect(readSystem('config.toml')).toBe('model = "user-edit"\n')
  })

  it('never overrides what ~/.codex already decided', () => {
    const systemConfig = [
      '[projects."C:\\\\work\\\\app"]',
      'trust_level = "untrusted"',
      '',
      '[mcp_servers.docs]',
      'command = "user-docs"',
      ''
    ].join('\n')
    writeFileSync(join(systemHomePath, 'config.toml'), systemConfig)
    writeFileSync(join(systemHomePath, 'auth.json'), 'user-auth')
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
    writeFileSync(join(runtimeHomePath, 'auth.json'), 'mirror-auth')

    carry()

    expect(readSystem('config.toml')).toBe(systemConfig)
    expect(readSystem('auth.json')).toBe('user-auth')
  })

  it("leaves a managed account's mirror credentials out of ~/.codex", () => {
    writeFileSync(join(runtimeHomePath, 'auth.json'), 'managed-auth')
    writeFileSync(join(runtimeHomePath, '.credentials.json'), 'managed-mcp')

    carry(false)

    expect(existsSync(join(systemHomePath, 'auth.json'))).toBe(false)
    expect(existsSync(join(systemHomePath, '.credentials.json'))).toBe(false)
  })
})

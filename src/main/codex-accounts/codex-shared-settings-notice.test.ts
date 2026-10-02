import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCodexSettingsBaselinePath } from '../codex/config-settings-baseline'
import { resolveCodexSharedSettingsNotice } from './codex-shared-settings-notice'

let root: string
let runtimeHomePath: string
let systemHomePath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-shared-settings-notice-'))
  runtimeHomePath = join(root, 'runtime')
  systemHomePath = join(root, 'system')
  mkdirSync(runtimeHomePath)
  mkdirSync(systemHomePath)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function writeRuntimeConfig(config: string): void {
  writeFileSync(join(runtimeHomePath, 'config.toml'), config)
}

function writeBaseline(mcpServers?: string[]): void {
  writeFileSync(
    getCodexSettingsBaselinePath(runtimeHomePath),
    JSON.stringify({ version: mcpServers ? 3 : 2, settings: {}, mcpServers })
  )
}

describe('resolveCodexSharedSettingsNotice', () => {
  it('is null for a managed home Codex never ran in', () => {
    mkdirSync(join(runtimeHomePath, 'sessions'))

    expect(resolveCodexSharedSettingsNotice(runtimeHomePath, systemHomePath)).toBeNull()
  })

  it('is due with no servers when only sessions show the home was used', () => {
    mkdirSync(join(runtimeHomePath, 'sessions', '2026'), { recursive: true })

    expect(resolveCodexSharedSettingsNotice(runtimeHomePath, systemHomePath)).toEqual({
      mcpServerNames: []
    })
  })

  it('names only the servers that exist nowhere but the managed home', () => {
    writeRuntimeConfig(
      [
        '[mcp_servers.shared]',
        'command = "a"',
        '[mcp_servers.removed]',
        'command = "b"',
        '[mcp_servers.orca_only]',
        'command = "c"',
        '[mcp_servers.orca_only.env]',
        'TOKEN = "secret"'
      ].join('\n')
    )
    writeFileSync(join(systemHomePath, 'config.toml'), '[mcp_servers.shared]\ncommand = "a"\n')
    writeBaseline(['shared', 'removed'])

    expect(resolveCodexSharedSettingsNotice(runtimeHomePath, systemHomePath)).toEqual({
      mcpServerNames: ['orca_only']
    })
  })

  it.each([
    ['~/.codex owns the whole MCP table inline', () => writeBaseline([]), 'mcp_servers = {}\n'],
    ['the baseline predates MCP ownership', () => writeBaseline(), '']
  ])('names no servers when %s', (_case, arrange, systemConfig) => {
    writeRuntimeConfig('[mcp_servers.orca_only]\ncommand = "c"\n')
    writeFileSync(join(systemHomePath, 'config.toml'), systemConfig)
    arrange()

    expect(resolveCodexSharedSettingsNotice(runtimeHomePath, systemHomePath)).toEqual({
      mcpServerNames: []
    })
  })
})

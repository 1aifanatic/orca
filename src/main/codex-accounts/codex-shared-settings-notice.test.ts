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

describe('resolveCodexSharedSettingsNotice', () => {
  it('is null for a config.toml Orca wrote at startup, with no sessions or own servers', () => {
    writeRuntimeConfig('[features]\nhooks = true\n')
    mkdirSync(join(runtimeHomePath, 'sessions'))

    expect(resolveCodexSharedSettingsNotice(runtimeHomePath, systemHomePath)).toBeNull()
  })

  it('is due with no servers when only sessions show the home was used', () => {
    mkdirSync(join(runtimeHomePath, 'sessions', '2026'), { recursive: true })

    expect(resolveCodexSharedSettingsNotice(runtimeHomePath, systemHomePath)).toEqual({
      mcpServerNames: []
    })
  })

  it('leaves out a server ~/.codex has', () => {
    writeRuntimeConfig(
      '[mcp_servers.shared]\ncommand = "a"\n[mcp_servers.orca_only]\ncommand = "b"\n'
    )
    writeFileSync(join(systemHomePath, 'config.toml'), '[mcp_servers.shared]\ncommand = "a"\n')

    expect(resolveCodexSharedSettingsNotice(runtimeHomePath, systemHomePath)).toEqual({
      mcpServerNames: ['orca_only']
    })
  })

  it('leaves out a server the last mirror copied from ~/.codex', () => {
    writeRuntimeConfig(
      '[mcp_servers.removed]\ncommand = "a"\n[mcp_servers.orca_only]\ncommand = "b"\n'
    )
    writeFileSync(
      getCodexSettingsBaselinePath(runtimeHomePath),
      JSON.stringify({ version: 3, settings: {}, mcpServers: ['removed'] })
    )

    expect(resolveCodexSharedSettingsNotice(runtimeHomePath, systemHomePath)).toEqual({
      mcpServerNames: ['orca_only']
    })
  })
})

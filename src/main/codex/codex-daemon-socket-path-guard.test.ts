import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('tests pass explicit homes')
    }
  }
}))

import {
  applyCodexDaemonSocketGuard,
  CODEX_DAEMON_OVERRIDE_MARKER,
  codexDaemonSocketPath,
  codexDaemonSocketPathExceedsLimit,
  stripCodexDaemonOverride
} from './codex-daemon-socket-path-guard'
import {
  syncSystemConfigIntoLegacySharedCodexHome,
  syncSystemConfigIntoManagedCodexHome
} from './codex-config-mirror'
import { ensureCodexDaemonSocketGuard } from './codex-owned-home-daemon-guard'
import { getCodexConfigSyncStatus } from './config-sync-stall'
import { getCodexSettingsBaselinePath } from './config-settings-baseline'
import { extractOrdinaryCodexSettings } from './config-toml-runtime-owned-sections'

const UUID = '9dd962e2-449d-44c4-9733-0633f255064a'
const MAC_MANAGED_HOME = `/Users/john/Library/Application Support/orca/codex-accounts/${UUID}/home`
const OVERRIDE_LINE = `daemon_auto_start = false ${CODEX_DAEMON_OVERRIDE_MARKER}`
const LEGACY_OVERRIDE_LINE =
  'daemon_auto_start = false # orca: CODEX_HOME too long for the daemon socket'
const WINDOWS_MANAGED_HOME = 'C:\\Users\\neil\\AppData\\Roaming\\orca\\codex-runtime-home\\home'

// The socket suffix is 43 bytes: sun_path 104 (macOS) / 108 (Linux) leaves 60 / 64 for the home.
function homeOfLength(length: number): string {
  return `/${'a'.repeat(length - 1)}`
}

describe('codexDaemonSocketPathExceedsLimit', () => {
  it('matches the reproduced Codex ceiling on macOS and Linux', () => {
    expect(codexDaemonSocketPathExceedsLimit(homeOfLength(60), 'darwin')).toBe(false)
    expect(codexDaemonSocketPathExceedsLimit(homeOfLength(61), 'darwin')).toBe(true)
    expect(codexDaemonSocketPathExceedsLimit(homeOfLength(64), 'linux')).toBe(false)
    expect(codexDaemonSocketPathExceedsLimit(homeOfLength(65), 'linux')).toBe(true)
  })

  it('flags the reported per-account macOS home', () => {
    expect(codexDaemonSocketPath(MAC_MANAGED_HOME, 'darwin')).toBe(
      `${MAC_MANAGED_HOME}/app-server-control/app-server-control.sock`
    )
    expect(codexDaemonSocketPathExceedsLimit(MAC_MANAGED_HOME, 'darwin')).toBe(true)
  })

  it('counts bytes, not characters', () => {
    const home = `/${'é'.repeat(30)}`
    expect(home.length).toBe(31)
    expect(codexDaemonSocketPathExceedsLimit(home, 'darwin')).toBe(true)
  })

  it('measures WSL homes by their Linux path and limit', () => {
    const shortWsl = '\\\\wsl.localhost\\Ubuntu\\home\\u\\.codex-orca'
    expect(codexDaemonSocketPath(shortWsl, 'win32')).toBe(
      '/home/u/.codex-orca/app-server-control/app-server-control.sock'
    )
    expect(codexDaemonSocketPathExceedsLimit(shortWsl, 'win32')).toBe(false)
    const managedWsl = `\\\\wsl.localhost\\Ubuntu\\home\\u\\.local\\share\\orca\\codex-accounts\\${UUID}\\home`
    expect(codexDaemonSocketPathExceedsLimit(managedWsl, 'win32')).toBe(true)
  })

  it('flags the Windows managed home against the 108-byte uds_windows limit', () => {
    const home = `C:\\Users\\neil\\AppData\\Roaming\\orca\\codex-accounts\\${UUID}\\home`
    expect(codexDaemonSocketPathExceedsLimit(home, 'win32')).toBe(true)
    expect(codexDaemonSocketPathExceedsLimit('C:\\Users\\neil\\.codex', 'win32')).toBe(false)
  })
})

describe('applyCodexDaemonSocketGuard', () => {
  it('appends a [features] table when none exists and strips back to the original', () => {
    const config = 'model = "gpt-5"\n\n[tui]\ntheme = "dark"\n'
    const guarded = applyCodexDaemonSocketGuard(config, MAC_MANAGED_HOME, 'darwin')
    expect(guarded).toBe(`${config}\n[features]\n${OVERRIDE_LINE}\n`)
    expect(applyCodexDaemonSocketGuard(guarded, MAC_MANAGED_HOME, 'darwin')).toBe(guarded)
    expect(stripCodexDaemonOverride(guarded)).toBe(config)
  })

  it('writes into an existing [features] table and overrides an explicit true', () => {
    const config = '[features]\nhooks = true\ndaemon_auto_start = true\n\n[tui]\ntheme = "dark"\n'
    const guarded = applyCodexDaemonSocketGuard(config, MAC_MANAGED_HOME, 'darwin')
    expect(guarded).toBe(`[features]\nhooks = true\n${OVERRIDE_LINE}\n\n[tui]\ntheme = "dark"\n`)
    expect(stripCodexDaemonOverride(guarded)).toBe(
      '[features]\nhooks = true\n\n[tui]\ntheme = "dark"\n'
    )
  })

  it('uses a dotted key beside dotted features keys so the table is not defined twice', () => {
    const config = 'features.hooks = true\n\n[tui]\ntheme = "dark"\n'
    expect(applyCodexDaemonSocketGuard(config, MAC_MANAGED_HOME, 'darwin')).toBe(
      `features.hooks = true\nfeatures.${OVERRIDE_LINE}\n\n[tui]\ntheme = "dark"\n`
    )
  })

  it('creates a config for an empty home and keeps CRLF files CRLF', () => {
    expect(applyCodexDaemonSocketGuard('', MAC_MANAGED_HOME, 'darwin')).toBe(
      `[features]\n${OVERRIDE_LINE}\n`
    )
    const crlf = 'model = "gpt-5"\r\n'
    const guarded = applyCodexDaemonSocketGuard(crlf, MAC_MANAGED_HOME, 'darwin')
    expect(guarded).toBe(`model = "gpt-5"\r\n\r\n[features]\r\n${OVERRIDE_LINE}\r\n`)
    expect(stripCodexDaemonOverride(guarded)).toBe(crlf)
  })

  it('turns auto-start off in homes whose socket path fits, too', () => {
    expect(codexDaemonSocketPathExceedsLimit(WINDOWS_MANAGED_HOME, 'win32')).toBe(false)
    expect(applyCodexDaemonSocketGuard('model = "m"\n', WINDOWS_MANAGED_HOME, 'win32')).toBe(
      `model = "m"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
    const guarded = applyCodexDaemonSocketGuard('model = "m"\n', MAC_MANAGED_HOME, 'darwin')
    expect(applyCodexDaemonSocketGuard(guarded, homeOfLength(20), 'darwin')).toBe(guarded)
  })

  it("overrides the user's explicit true in every TOML form Orca can extend, and says so once", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = homeOfLength(20)
    expect(
      applyCodexDaemonSocketGuard('[features]\ndaemon_auto_start = true\n', home, 'linux')
    ).toBe(`[features]\n${OVERRIDE_LINE}\n`)
    expect(applyCodexDaemonSocketGuard('features.daemon_auto_start = true\n', home, 'linux')).toBe(
      `features.${OVERRIDE_LINE}\n`
    )
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('daemon_auto_start = true')
    expect(String(warn.mock.calls[0]?.[0])).toContain(home)
    warn.mockRestore()
  })

  it("marks a user's explicit false as Orca's without warning about an override", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = `${homeOfLength(20)}-false`
    expect(
      applyCodexDaemonSocketGuard('[features]\ndaemon_auto_start = false\n', home, 'linux')
    ).toBe(`[features]\n${OVERRIDE_LINE}\n`)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('ignores a same-named key outside [features] or inside a multiline string', () => {
    const config =
      '[tui]\ndaemon_auto_start = true\nnote = """\n[features]\ndaemon_auto_start = true\n"""\n'
    expect(applyCodexDaemonSocketGuard(config, homeOfLength(20), 'linux')).toBe(
      `${config}\n[features]\n${OVERRIDE_LINE}\n`
    )
  })

  it('rewrites a line marked by an older Orca in place and strips it like its own', () => {
    const legacy = `model = "m"\n\n[features]\n${LEGACY_OVERRIDE_LINE}\n`
    expect(applyCodexDaemonSocketGuard(legacy, homeOfLength(20), 'linux')).toBe(
      `model = "m"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
    expect(stripCodexDaemonOverride(legacy)).toBe('model = "m"\n')
    expect(extractOrdinaryCodexSettings(legacy)).toBe('model = "m"')
  })

  it('warns once instead of failing silently when inline features block the override', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = `${MAC_MANAGED_HOME}-inline`
    const config = 'features = { hooks = true }\n'
    expect(applyCodexDaemonSocketGuard(config, home, 'darwin')).toBe(config)
    applyCodexDaemonSocketGuard(config, home, 'darwin')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('Could not turn off Codex daemon auto-start')
    expect(String(warn.mock.calls[0]?.[0])).toContain('as a [features] table')
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('add daemon_auto_start = false')
    const alreadyOff = 'features = { daemon_auto_start = false }\n'
    applyCodexDaemonSocketGuard(alreadyOff, `${home}-off`, 'darwin')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('never promotes the override into a seeded ~/.codex', () => {
    const guarded = applyCodexDaemonSocketGuard('model = "m"\n', MAC_MANAGED_HOME, 'darwin')
    expect(extractOrdinaryCodexSettings(guarded)).toBe('model = "m"')
  })
})

describe('syncSystemConfigIntoManagedCodexHome daemon guard', () => {
  let root: string
  let systemHomePath: string

  beforeEach(() => {
    // Why: /tmp keeps the short home under every sun_path limit on POSIX hosts.
    root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cx-'))
    systemHomePath = join(root, 's')
    mkdirSync(systemHomePath)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function makeHome(name: string): string {
    const home = join(root, name)
    mkdirSync(home, { recursive: true })
    return home
  }

  const longHome = (): string =>
    makeHome(join('Library', 'Application Support', 'orca', 'codex-accounts', UUID, 'home'))

  it('turns daemon auto-start off in a long managed home without touching ~/.codex', () => {
    const systemConfig = 'model = "gpt-5"\n'
    writeFileSync(join(systemHomePath, 'config.toml'), systemConfig)
    const runtimeHomePath = longHome()

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    const first = readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')
    expect(first).toBe(`model = "gpt-5"\n\n[features]\n${OVERRIDE_LINE}\n`)

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toBe(first)
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).toBe(systemConfig)
  })

  it('still guards a long home when the user has no ~/.codex/config.toml', () => {
    const runtimeHomePath = longHome()
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toBe(
      `[features]\n${OVERRIDE_LINE}\n`
    )
    // A guard-only runtime config withholds no settings, so it must not raise the missing-source warning.
    expect(getCodexConfigSyncStatus({ runtimeHomePath, systemHomePath }).state).toBe('synced')
  })

  it('still guards an existing home when a stalled settings write-back skips the mirror', () => {
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5"\n')
    const runtimeHomePath = longHome()
    writeFileSync(join(runtimeHomePath, 'config.toml'), 'model = "runtime"\n')
    // An unreadable baseline makes promotion refuse, so no mirror pass runs.
    mkdirSync(getCodexSettingsBaselinePath(runtimeHomePath))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    warn.mockRestore()
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toBe(
      `model = "runtime"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).toBe('model = "gpt-5"\n')
  })

  it('mirrors a later-created ~/.codex/config.toml into a guard-only home', () => {
    const runtimeHomePath = longHome()
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toBe(
      `model = "gpt-5"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).toBe('model = "gpt-5"\n')
  })

  it('still reports a real stall when the runtime holds user settings and the source is gone', () => {
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5"\n')
    const runtimeHomePath = longHome()
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    rmSync(join(systemHomePath, 'config.toml'))
    expect(getCodexConfigSyncStatus({ runtimeHomePath, systemHomePath })).toMatchObject({
      state: 'stalled',
      reason: 'missing-source'
    })
  })

  it('keeps the guard in the legacy shared home when a system launch refreshes it', () => {
    writeFileSync(join(systemHomePath, 'config.toml'), 'model = "gpt-5"\n')
    const runtimeHomePath = longHome()
    writeFileSync(
      join(runtimeHomePath, 'config.toml'),
      `model = "old"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
    syncSystemConfigIntoLegacySharedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toContain(OVERRIDE_LINE)
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toContain('model = "gpt-5"')
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).toBe('model = "gpt-5"\n')
  })

  it('turns auto-start off in a short managed home too, leaving ~/.codex untouched', () => {
    const systemConfig = 'model = "gpt-5"\n'
    writeFileSync(join(systemHomePath, 'config.toml'), systemConfig)
    const runtimeHomePath = makeHome('h')
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toBe(
      `model = "gpt-5"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).toBe(systemConfig)
    expect(getCodexConfigSyncStatus({ runtimeHomePath, systemHomePath }).state).toBe('synced')
  })

  it('overrides an explicit true from ~/.codex in a short managed home, leaving ~/.codex untouched', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const systemConfig = 'model = "gpt-5"\n\n[features]\ndaemon_auto_start = true\n'
    writeFileSync(join(systemHomePath, 'config.toml'), systemConfig)
    const runtimeHomePath = makeHome('h')
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toBe(
      `model = "gpt-5"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).toBe(systemConfig)
    expect(
      warn.mock.calls.filter(([m]) => String(m).includes('daemon_auto_start = true'))
    ).toHaveLength(1)
    warn.mockRestore()
  })

  it("refuses the user's own home as the target even when its spelling differs", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const systemConfig = 'model = "gpt-5"\n'
    writeFileSync(join(systemHomePath, 'config.toml'), systemConfig)
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath: `${systemHomePath}/`, systemHomePath })
    ensureCodexDaemonSocketGuard(`${systemHomePath}//`, systemHomePath)
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).toBe(systemConfig)
    // Refused before any disk access, so an unreachable distro path is safe here.
    syncSystemConfigIntoManagedCodexHome({
      runtimeHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\.codex',
      systemHomePath: '\\\\wsl$\\ubuntu\\home\\u\\.codex'
    })
    const refusals = warn.mock.calls.filter(([m]) => String(m).includes('Refusing to write'))
    expect(refusals).toHaveLength(2)
    warn.mockRestore()
  })

  it('still overrides an explicit true where the socket cannot be bound at all', () => {
    writeFileSync(
      join(systemHomePath, 'config.toml'),
      'model = "gpt-5"\n\n[features]\ndaemon_auto_start = true\n'
    )
    const runtimeHomePath = longHome()
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    expect(readFileSync(join(runtimeHomePath, 'config.toml'), 'utf-8')).toBe(
      `model = "gpt-5"\n\n[features]\n${OVERRIDE_LINE}\n`
    )
  })
})

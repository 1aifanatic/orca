import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexPaneAccountRecord } from './codex-pane-account-registry-types'
import type { CodexPathObservation } from './codex-path-observation'

const mocks = vi.hoisted(() => ({
  getCodexPaneAccount: vi.fn<(ptyId: string) => CodexPaneAccountRecord | null>(),
  probeCodexSharedServer: vi.fn<(home: string) => Promise<'live' | 'absent' | 'unknown'>>(),
  getProcessTableSnapshot: vi.fn(),
  readWindowsProcessTable: vi.fn(),
  observeAgentStateFile: vi.fn<(path: string) => CodexPathObservation<string>>()
}))
vi.mock('./codex-path-observation', () => ({
  observeAgentStateFile: mocks.observeAgentStateFile
}))
vi.mock('./codex-pane-account-registry', () => ({
  getCodexPaneAccount: mocks.getCodexPaneAccount
}))
vi.mock('./codex-shared-server-probe', () => ({
  probeCodexSharedServer: mocks.probeCodexSharedServer
}))
vi.mock('./codex-home-paths', () => ({
  getSystemCodexHomePath: () => '/home/me/.codex',
  resolveOrcaManagedCodexHomePath: () => '/data/orca/codex-runtime-home/home'
}))
vi.mock('../../shared/process-table-snapshot-reader', () => ({
  getProcessTableSnapshot: mocks.getProcessTableSnapshot
}))
vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessTable: mocks.readWindowsProcessTable
}))

import {
  findPaneCodexCommandLine,
  isPaneCodexOnSharedServer,
  resolveCodexPaneHome,
  resolveCodexPaneSettingsHome
} from './codex-shared-server-pane'

const SHELL = 100

function row(pid: number, ppid: number, command: string) {
  return { pid, ppid, stat: 'S+', command }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('findPaneCodexCommandLine', () => {
  it('takes the launcher line, which carries the argv, over its native child', () => {
    const rows = [
      row(SHELL, 1, '-bash'),
      row(101, SHELL, 'node /usr/lib/node_modules/@openai/codex/bin/codex.js --no-daemon'),
      row(102, 101, '/usr/lib/node_modules/@openai/codex/vendor/codex --no-daemon')
    ]
    expect(findPaneCodexCommandLine(rows, SHELL)).toBe(
      'node /usr/lib/node_modules/@openai/codex/bin/codex.js --no-daemon'
    )
  })

  it('ignores the shared server a Windows Codex spawns as its own child', () => {
    const rows = [
      row(SHELL, 1, 'cmd.exe'),
      row(101, SHELL, 'C:\\npm\\codex.exe'),
      row(102, 101, '"C:\\h\\codex.exe" app-server --listen unix:// --managed-daemon'),
      row(103, 101, '"C:\\h\\codex.exe" app-server daemon pid-update-loop')
    ]
    expect(findPaneCodexCommandLine(rows, SHELL)).toBe('C:\\npm\\codex.exe')
  })

  it('ignores Codex outside this pane and non-Codex children', () => {
    const rows = [row(SHELL, 1, '-zsh'), row(101, SHELL, 'vim'), row(201, 1, 'codex')]
    expect(findPaneCodexCommandLine(rows, SHELL)).toBeNull()
  })
})

describe('resolveCodexPaneHome', () => {
  it.each([
    [{ selectionKey: 'host', accountId: null, homeRoute: 'real-home' }, '/home/me/.codex'],
    [
      {
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'real-home',
        environmentHomeOverride: { codexHome: '/custom/codex' }
      },
      '/custom/codex'
    ],
    [
      {
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'custom-home',
        shellStartupHomeOverride: { home: '/home/me', codexHome: '/rc/codex' }
      },
      '/rc/codex'
    ],
    [{ selectionKey: 'host', accountId: null, homeRoute: 'custom-home' }, null],
    [
      { selectionKey: 'host', accountId: null, homeRoute: 'shared-home' },
      '/data/orca/codex-runtime-home/home'
    ],
    [{ selectionKey: 'host', accountId: 'acct', homeRoute: 'account-home' }, null],
    [{ selectionKey: 'wsl:Ubuntu', accountId: null, homeRoute: 'real-home' }, null],
    [{ selectionKey: 'host', accountId: null }, null]
  ] satisfies [CodexPaneAccountRecord, string | null][])(
    'resolves %o to %s',
    (record, expected) => {
      mocks.getCodexPaneAccount.mockReturnValue(record)
      expect(resolveCodexPaneHome('pty')).toBe(expected)
    }
  )

  it('names no home for a pane with no launch record', () => {
    mocks.getCodexPaneAccount.mockReturnValue(null)
    expect(resolveCodexPaneHome('pty')).toBeNull()
  })
})

describe('resolveCodexPaneSettingsHome', () => {
  it.each([
    [{ selectionKey: 'host', accountId: null, homeRoute: 'real-home' }, '/home/me/.codex'],
    [
      {
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'real-home',
        environmentHomeOverride: { codexHome: '/custom/codex' }
      },
      '/custom/codex'
    ],
    // Why: Orca re-mirrors its shared home from ~/.codex on every launch.
    [{ selectionKey: 'host', accountId: null, homeRoute: 'shared-home' }, '/home/me/.codex'],
    [{ selectionKey: 'host', accountId: null, homeRoute: 'custom-home' }, null],
    [{ selectionKey: 'wsl:Ubuntu', accountId: null, homeRoute: 'shared-home' }, null]
  ] satisfies [CodexPaneAccountRecord, string | null][])(
    'resolves %o to %s',
    (record, expected) => {
      mocks.getCodexPaneAccount.mockReturnValue(record)
      mocks.observeAgentStateFile.mockReturnValue({ kind: 'present', value: 'model = "x"\n' })
      expect(resolveCodexPaneSettingsHome('pty')).toBe(expected)
    }
  )

  it("reads no config for a pane on the user's own home", () => {
    mocks.getCodexPaneAccount.mockReturnValue({
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'real-home'
    })
    expect(resolveCodexPaneSettingsHome('pty')).toBe('/home/me/.codex')
    expect(mocks.observeAgentStateFile).not.toHaveBeenCalled()
  })

  // Why: the mirror skips a missing or blank ~/.codex/config.toml, so only then does the mirror home keep it.
  it.each([
    ['missing', { kind: 'absent' }, '/data/orca/codex-runtime-home/home'],
    ['blank', { kind: 'present', value: ' \n' }, '/data/orca/codex-runtime-home/home'],
    ['unreadable', { kind: 'indeterminate', error: new Error('EACCES') }, null]
  ] satisfies [string, CodexPathObservation<string>, string | null][])(
    "keeps a shared-home pane's setting in the mirror when ~/.codex/config.toml is %s",
    (_label, observation, expected) => {
      mocks.getCodexPaneAccount.mockReturnValue({
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'shared-home'
      })
      mocks.observeAgentStateFile.mockReturnValue(observation)
      expect(resolveCodexPaneSettingsHome('pty')).toBe(expected)
      expect(mocks.observeAgentStateFile).toHaveBeenCalledWith(
        join('/home/me/.codex', 'config.toml')
      )
    }
  )
})

describe('isPaneCodexOnSharedServer', () => {
  beforeEach(() => {
    mocks.getCodexPaneAccount.mockReturnValue({
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'real-home'
    })
    mocks.probeCodexSharedServer.mockResolvedValue('live')
    const rows = [row(SHELL, 1, '-bash'), row(101, SHELL, 'codex')]
    mocks.getProcessTableSnapshot.mockResolvedValue(rows)
    mocks.readWindowsProcessTable.mockResolvedValue(rows)
  })

  it('is true for a typed codex while its home has a live server', async () => {
    await expect(isPaneCodexOnSharedServer('pty', SHELL)).resolves.toBe(true)
    expect(mocks.probeCodexSharedServer).toHaveBeenCalledWith('/home/me/.codex')
  })

  it.each(['absent', 'unknown'] as const)(
    'is false when the pane home server is %s',
    async (state) => {
      mocks.probeCodexSharedServer.mockResolvedValue(state)
      await expect(isPaneCodexOnSharedServer('pty', SHELL)).resolves.toBe(false)
    }
  )

  it('is false when Codex runs with --no-daemon, without probing', async () => {
    mocks.getProcessTableSnapshot.mockResolvedValue([
      row(SHELL, 1, '-bash'),
      row(101, SHELL, 'codex --no-daemon')
    ])
    mocks.readWindowsProcessTable.mockResolvedValue([
      row(SHELL, 1, 'cmd.exe'),
      row(101, SHELL, 'codex --no-daemon')
    ])
    await expect(isPaneCodexOnSharedServer('pty', SHELL)).resolves.toBe(false)
    expect(mocks.probeCodexSharedServer).not.toHaveBeenCalled()
  })

  it('is false when the pane home cannot be named, without reading processes', async () => {
    mocks.getCodexPaneAccount.mockReturnValue(null)
    await expect(isPaneCodexOnSharedServer('pty', SHELL)).resolves.toBe(false)
    expect(mocks.getProcessTableSnapshot).not.toHaveBeenCalled()
    expect(mocks.readWindowsProcessTable).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, args: { id: string }) => Promise<boolean>
type Session = { id: string; rootProcessId?: number; wslDistro?: string }

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  sessions: new Array<Session>(),
  hasProvider: vi.fn<(id: string) => boolean>(),
  isPaneCodexOnSharedServer: vi.fn<(id: string, rootPid: number) => Promise<boolean>>(),
  resolveCodexPaneHome: vi.fn<(id: string) => string | null>(),
  resolveCodexPaneSettingsHome: vi.fn<(id: string) => string | null>(),
  disable: vi.fn<(paneHome: string, settingsHome: string) => Promise<boolean>>(),
  stop: vi.fn<(home: string) => Promise<boolean>>()
}))
vi.mock('../../pty-host-bindings', () => ({
  getPtyIpc: () => ({
    handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler)
  })
}))
vi.mock('../../../codex/codex-shared-server-pane', () => ({
  isPaneCodexOnSharedServer: mocks.isPaneCodexOnSharedServer,
  resolveCodexPaneHome: mocks.resolveCodexPaneHome,
  resolveCodexPaneSettingsHome: mocks.resolveCodexPaneSettingsHome
}))
vi.mock('../../../codex/codex-shared-server-fix', () => ({
  disableCodexSharedServerAutoStart: mocks.disable,
  stopCodexSharedServer: mocks.stop
}))
vi.mock('../provider/registry', () => ({
  hasPtyProviderForInspection: mocks.hasProvider,
  getProviderForPty: () => ({ listProcesses: () => Promise.resolve(mocks.sessions) })
}))

import { toAppSshPtyId } from '../../../providers/ssh-pty-id'
import { ptyOwnership } from '../provider/ownership-state'
import { installPtyCodexSharedServerIpcHandler } from './codex-shared-server'

const CHANNELS = [
  'pty:isCodexOnSharedServer',
  'pty:disableCodexSharedServerAutoStart',
  'pty:stopCodexSharedServer'
] as const

function invoke(channel: string, id: string): Promise<boolean> {
  const handler = mocks.handlers.get(channel)
  if (!handler) {
    throw new Error(`missing ${channel}`)
  }
  return handler({}, { id })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  ptyOwnership.clear()
  mocks.sessions = [{ id: 'local-1', rootProcessId: 100 }]
  mocks.hasProvider.mockReturnValue(true)
  mocks.isPaneCodexOnSharedServer.mockResolvedValue(true)
  mocks.resolveCodexPaneHome.mockReturnValue('/home/me/.codex')
  mocks.resolveCodexPaneSettingsHome.mockReturnValue('/home/me/.codex')
  mocks.disable.mockResolvedValue(true)
  mocks.stop.mockResolvedValue(true)
  installPtyCodexSharedServerIpcHandler({ getLocalPtyProviderStartupPromise: () => undefined })
})

describe('Codex shared-server IPC', () => {
  it.each(CHANNELS)('%s answers for a local pane', async (channel) => {
    expect(await invoke(channel, 'local-1')).toBe(true)
  })

  it('runs the fix against the pane home', async () => {
    await invoke('pty:disableCodexSharedServerAutoStart', 'local-1')
    await invoke('pty:stopCodexSharedServer', 'local-1')
    expect(mocks.resolveCodexPaneHome).toHaveBeenCalledWith('local-1')
    expect(mocks.disable).toHaveBeenCalledWith('/home/me/.codex', '/home/me/.codex')
    expect(mocks.stop).toHaveBeenCalledWith('/home/me/.codex')
  })

  it("persists the setting in the mirror's source but stops the pane home's server", async () => {
    mocks.resolveCodexPaneHome.mockReturnValue('/data/orca/codex-runtime-home/home')
    await invoke('pty:disableCodexSharedServerAutoStart', 'local-1')
    await invoke('pty:stopCodexSharedServer', 'local-1')
    expect(mocks.disable).toHaveBeenCalledWith(
      '/data/orca/codex-runtime-home/home',
      '/home/me/.codex'
    )
    expect(mocks.stop).toHaveBeenCalledWith('/data/orca/codex-runtime-home/home')
  })

  const refusals: [string, string, () => void][] = [
    ['a remote runtime pane', 'remote:local-1', () => {}],
    ['an SSH pane', toAppSshPtyId('conn-1', 'local-1'), () => {}],
    ['a pane routed to an SSH connection', 'local-1', () => ptyOwnership.set('local-1', 'conn-1')],
    [
      'a WSL pane',
      'local-1',
      () => (mocks.sessions = [{ id: 'local-1', rootProcessId: 100, wslDistro: 'Ubuntu' }])
    ],
    ['a pane with no root pid', 'local-1', () => (mocks.sessions = [{ id: 'local-1' }])],
    ['a pane no provider holds', 'local-1', () => mocks.hasProvider.mockReturnValue(false)]
  ]

  it.each(CHANNELS.flatMap((channel) => refusals.map((refusal) => [channel, ...refusal] as const)))(
    '%s refuses %s',
    async (channel, _label, id, arrange) => {
      arrange()
      expect(await invoke(channel, id)).toBe(false)
      expect(mocks.isPaneCodexOnSharedServer).not.toHaveBeenCalled()
      expect(mocks.disable).not.toHaveBeenCalled()
      expect(mocks.stop).not.toHaveBeenCalled()
    }
  )

  it.each(CHANNELS.slice(1))('%s runs nothing when the pane has no Codex home', async (channel) => {
    mocks.resolveCodexPaneHome.mockReturnValue(null)
    mocks.resolveCodexPaneSettingsHome.mockReturnValue(null)
    expect(await invoke(channel, 'local-1')).toBe(false)
    expect(mocks.disable).not.toHaveBeenCalled()
    expect(mocks.stop).not.toHaveBeenCalled()
  })
})

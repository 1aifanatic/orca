import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../core'

const {
  installForRuntimeHomeSerializedMock,
  realpathMock,
  supportsNative,
  supportsWsl,
  resolveTerminal,
  getMux,
  request
} = vi.hoisted(() => ({
  installForRuntimeHomeSerializedMock: vi.fn(),
  realpathMock: vi.fn(),
  supportsNative: vi.fn(),
  supportsWsl: vi.fn(),
  resolveTerminal: vi.fn(),
  getMux: vi.fn(),
  request: vi.fn()
}))

vi.mock('../../../codex/codex-native-terminal-capability', () => ({
  codexExecutableCapability: { supportsNoDaemon: supportsNative }
}))
vi.mock('../../../codex/codex-wsl-terminal-capability', () => ({
  supportsWslCodexNoDaemon: supportsWsl
}))
vi.mock('../../../ssh/ssh-target-registry', () => ({ getActiveMultiplexer: getMux }))

vi.mock('../../../codex/hook-service', () => ({
  codexHookService: { installForRuntimeHomeSerialized: installForRuntimeHomeSerializedMock }
}))
vi.mock('node:fs/promises', () => ({ realpath: realpathMock }))

import { RPC_PARAMS_BY_METHOD } from '../../../../shared/rpc-contract/rpc-params-catalog.generated'
import { AGENT_HOOK_METHODS } from './agent-hooks'
import {
  _internals as managedWslHomeRegistryInternals,
  recordManagedWslCodexHome
} from '../../../codex/managed-wsl-codex-home-registry'

const LINUX_HOME = '/home/jin/.local/share/orca/codex-runtime-home/home'
const RUNTIME_HOME =
  '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\.local\\share\\orca\\codex-runtime-home\\home'

function prepareMethod(name = 'agentHooks.prepareCodexForWslPane') {
  const method = eraseRpcMethods(AGENT_HOOK_METHODS).find((candidate) => candidate.name === name)
  if (!method || isStreamingMethod(method)) {
    throw new Error('Missing agentHooks.prepareCodexForWslPane request method')
  }
  return method
}

function runtimeWithSettings(enabled = true, disabledTuiAgents: string[] = []): OrcaRuntimeService {
  const runtime = {
    resolveTerminalContext: resolveTerminal,
    getClientSettings: vi.fn(() => ({
      agentStatusHooksEnabled: enabled,
      disabledTuiAgents
    }))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These handlers only call the two methods supplied by this runtime stub.
  return runtime as unknown as OrcaRuntimeService
}

describe('agent hook RPC methods', () => {
  beforeEach(() => {
    installForRuntimeHomeSerializedMock.mockReset()
    realpathMock.mockReset()
    realpathMock.mockImplementation(async (path: string) => path)
    managedWslHomeRegistryInternals.clearRecordedManagedWslCodexHomes()
    recordManagedWslCodexHome('Ubuntu-24.04', RUNTIME_HOME)
  })

  describe('execution-host Codex capability', () => {
    beforeEach(() => {
      resolveTerminal
        .mockReset()
        .mockReturnValue({ worktreeId: 'folder::workspace', connectionId: null })
      supportsNative.mockReset().mockResolvedValue(true)
      supportsWsl.mockReset().mockResolvedValue(true)
      request.mockReset().mockResolvedValue({ supported: true })
      getMux.mockReset().mockReturnValue({ isDisposed: () => false, request })
    })
    async function query(wslDistro?: string) {
      const method = prepareMethod('agentHooks.codexTerminalLaunchCapability')
      return method.handler(
        method.params!.parse({
          executablePath: '/opt/codex',
          terminalHandle: 'term-a',
          ...(wslDistro ? { wslDistro } : {})
        }),
        { runtime: runtimeWithSettings() }
      )
    }
    it('publishes the same capability schema in the generated client catalog', () => {
      expect(RPC_PARAMS_BY_METHOD['agentHooks.codexTerminalLaunchCapability']).toBe(
        prepareMethod('agentHooks.codexTerminalLaunchCapability').params
      )
    })
    it('checks the exact local path independently of hook settings or folder type', async () => {
      expect(await query()).toEqual({ supported: true })
      expect(supportsNative).toHaveBeenCalledExactlyOnceWith('/opt/codex')
      expect(request).not.toHaveBeenCalled()
    })
    it('routes a remote path exclusively to its owning connection', async () => {
      resolveTerminal.mockReturnValue({ worktreeId: 'folder::workspace', connectionId: 'ssh-b' })
      expect(await query()).toEqual({ supported: true })
      expect(getMux).toHaveBeenCalledWith('ssh-b')
      expect(request).toHaveBeenCalledExactlyOnceWith('preflight.codexTerminalLaunchCapability', {
        executablePath: '/opt/codex'
      })
      expect(supportsNative).not.toHaveBeenCalled()
    })
    it('keeps a WSL path inside the named guest', async () => {
      expect(await query('Ubuntu')).toEqual({ supported: true })
      expect(supportsWsl).toHaveBeenCalledExactlyOnceWith('/opt/codex', 'Ubuntu')
      expect(supportsNative).not.toHaveBeenCalled()
    })
    it('does not fall back locally when terminal or remote ownership is unavailable', async () => {
      resolveTerminal.mockReturnValue(null)
      expect(await query()).toEqual({ supported: false })
      resolveTerminal.mockReturnValue({ worktreeId: 'folder::workspace', connectionId: 'ssh-b' })
      getMux.mockReturnValue(null)
      expect(await query()).toEqual({ supported: false })
      getMux.mockReturnValue({ isDisposed: () => true, request })
      expect(await query()).toEqual({ supported: false })
      expect(supportsNative).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
    })
  })

  it('installs the pane-selected WSL home once and returns its status', async () => {
    const status = { agent: 'codex', state: 'installed' }
    installForRuntimeHomeSerializedMock.mockResolvedValue(status)
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: LINUX_HOME,
      orcaCodexHome: LINUX_HOME,
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(method.handler(params, { runtime: runtimeWithSettings() })).resolves.toBe(status)
    expect(installForRuntimeHomeSerializedMock).toHaveBeenCalledExactlyOnceWith(RUNTIME_HOME, {
      runtime: 'wsl',
      wslDistro: 'Ubuntu-24.04'
    })
  })

  it.each([
    [false, []],
    [true, ['codex']]
  ])('does not install when hooks are disabled (%s, %j)', async (enabled, disabledTuiAgents) => {
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(
      method.handler(params, { runtime: runtimeWithSettings(enabled, disabledTuiAgents) })
    ).resolves.toBeNull()
    expect(installForRuntimeHomeSerializedMock).not.toHaveBeenCalled()
  })

  it.each(['runtime', 'mobile'] as const)('rejects non-local %s callers', async (clientKind) => {
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(
      method.handler(params, {
        runtime: runtimeWithSettings(),
        clientKind
      } as RpcContext)
    ).rejects.toThrow(/only available to the local Orca CLI/)
    expect(installForRuntimeHomeSerializedMock).not.toHaveBeenCalled()
  })

  it('propagates an attempted installer failure', async () => {
    installForRuntimeHomeSerializedMock.mockRejectedValue(new Error('install failed'))
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(method.handler(params, { runtime: runtimeWithSettings() })).rejects.toThrow(
      'install failed'
    )
    expect(installForRuntimeHomeSerializedMock).toHaveBeenCalledOnce()
  })

  it('rejects a managed-looking home that resolves through a symlink', async () => {
    realpathMock.mockResolvedValue(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\outside-managed-home'
    )
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: LINUX_HOME,
      orcaCodexHome: LINUX_HOME,
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(method.handler(params, { runtime: runtimeWithSettings() })).resolves.toBeNull()
    expect(installForRuntimeHomeSerializedMock).not.toHaveBeenCalled()
  })

  it('rejects malformed distro names at the RPC schema', () => {
    const method = prepareMethod()

    expect(() =>
      method.params!.parse({
        codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
        orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
        wslDistro: 'Ubuntu\\..\\host'
      })
    ).toThrow()
  })
})

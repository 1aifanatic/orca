import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../core'

const { installForLaunchPrepMock, installForRuntimeHomeSerializedMock, realpathMock, appPaths } =
  vi.hoisted(() => ({
    installForLaunchPrepMock: vi.fn(),
    installForRuntimeHomeSerializedMock: vi.fn(),
    realpathMock: vi.fn(),
    appPaths: { userData: '' }
  }))

vi.mock('../../../codex/hook-service', () => ({
  codexHookService: {
    installForLaunchPrep: installForLaunchPrepMock,
    installForRuntimeHomeSerialized: installForRuntimeHomeSerializedMock
  }
}))
vi.mock('node:fs/promises', () => ({ realpath: realpathMock }))
vi.mock('../../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => appPaths.userData })
}))

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
    throw new Error(`Missing ${name} request method`)
  }
  return method
}

function runtimeWithSettings(enabled = true, disabledTuiAgents: string[] = []): OrcaRuntimeService {
  return {
    getClientSettings: vi.fn(() => ({
      agentStatusHooksEnabled: enabled,
      disabledTuiAgents
    }))
  } as unknown as OrcaRuntimeService
}

describe('agent hook RPC methods', () => {
  beforeEach(() => {
    installForRuntimeHomeSerializedMock.mockReset()
    realpathMock.mockReset()
    realpathMock.mockImplementation(async (path: string) => path)
    managedWslHomeRegistryInternals.clearRecordedManagedWslCodexHomes()
    recordManagedWslCodexHome('Ubuntu-24.04', RUNTIME_HOME)
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

describe('agentHooks.prepareCodexForPane', () => {
  let userDataPath: string

  beforeEach(() => {
    installForLaunchPrepMock.mockReset()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-prepare-codex-pane-'))
    appPaths.userData = userDataPath
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function paneParams(codexHome: string) {
    return prepareMethod('agentHooks.prepareCodexForPane').params!.parse({
      codexHome,
      orcaCodexHome: codexHome
    })
  }

  it("installs the pane's home in the app when this app's userData owns it", async () => {
    const home = join(userDataPath, 'codex-runtime-home', 'home')
    mkdirSync(home, { recursive: true })
    const status = { agent: 'codex', state: 'installed' }
    installForLaunchPrepMock.mockResolvedValue(status)

    await expect(
      prepareMethod('agentHooks.prepareCodexForPane').handler(paneParams(home), {
        runtime: runtimeWithSettings()
      })
    ).resolves.toBe(status)
    expect(installForLaunchPrepMock).toHaveBeenCalledExactlyOnceWith(home)
  })

  it("refuses a home outside this app's userData", async () => {
    const outside = mkdtempSync(join(tmpdir(), 'orca-prepare-codex-other-app-'))
    const home = join(outside, 'codex-runtime-home', 'home')
    mkdirSync(home, { recursive: true })
    try {
      await expect(
        prepareMethod('agentHooks.prepareCodexForPane').handler(paneParams(home), {
          runtime: runtimeWithSettings()
        })
      ).resolves.toBeNull()
      expect(installForLaunchPrepMock).not.toHaveBeenCalled()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it.each([
    [false, []],
    [true, ['codex']]
  ])('does not install when hooks are disabled (%s, %j)', async (enabled, disabledTuiAgents) => {
    const home = join(userDataPath, 'codex-runtime-home', 'home')
    mkdirSync(home, { recursive: true })

    await expect(
      prepareMethod('agentHooks.prepareCodexForPane').handler(paneParams(home), {
        runtime: runtimeWithSettings(enabled, disabledTuiAgents)
      })
    ).resolves.toBeNull()
    expect(installForLaunchPrepMock).not.toHaveBeenCalled()
  })

  it.each(['runtime', 'mobile'] as const)('rejects non-local %s callers', async (clientKind) => {
    await expect(
      prepareMethod('agentHooks.prepareCodexForPane').handler(paneParams('/tmp/home'), {
        runtime: runtimeWithSettings(),
        clientKind
      })
    ).rejects.toThrow(/only available to the local Orca CLI/)
  })
})

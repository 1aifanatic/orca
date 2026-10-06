import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { supportsPiRpcLaunch } from './rpc-create-support'
import { probePiRpcVersion, resolvePiRpcCommand } from './rpc-version'

vi.mock('../startup/login-shell-environment', () => ({ resolveLoginShellEnvironment: vi.fn() }))
vi.mock('./rpc-version', () => ({ probePiRpcVersion: vi.fn(), resolvePiRpcCommand: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveLoginShellEnvironment).mockResolvedValue({
    PATH: '/host/bin',
    HOME: '/host/home',
    PI_CODING_AGENT_DIR: '/host/inherited-account'
  })
  vi.mocked(resolvePiRpcCommand).mockReturnValue('/host/bin/pi')
  vi.mocked(probePiRpcVersion).mockResolvedValue(true)
})

describe('Pi launch support before session creation', () => {
  it('uses the same shell policy and Pi launch overlay as acquisition', async () => {
    await expect(
      supportsPiRpcLaunch({
        settings: {
          agentDefaultEnv: { pi: { PATH: '/custom/bin', PI_CODING_AGENT_DIR: '/custom/account' } }
        },
        cwd: '/host/folder'
      })
    ).resolves.toBe(true)
    expect(resolvePiRpcCommand).toHaveBeenCalledWith({
      PATH: '/custom/bin',
      HOME: '/host/home',
      PI_CODING_AGENT_DIR: '/custom/account'
    })
    expect(probePiRpcVersion).toHaveBeenCalledWith({
      program: '/host/bin/pi',
      cwd: '/host/folder',
      env: {
        PATH: '/custom/bin',
        HOME: '/host/home',
        PI_CODING_AGENT_DIR: '/custom/account'
      }
    })
  })

  it('reports unsupported instead of creating a session with an older binary', async () => {
    vi.mocked(probePiRpcVersion).mockResolvedValue(false)
    await expect(supportsPiRpcLaunch({ settings: {}, cwd: '/host/folder' })).resolves.toBe(false)
  })
})

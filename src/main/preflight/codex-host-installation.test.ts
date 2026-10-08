import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../../shared/codex-cli-installation'
import { detectCodexInstallationOnHost } from './codex-host-installation'

const { execWsl, local, mux, request } = vi.hoisted(() => ({
  execWsl: vi.fn(),
  local: vi.fn(),
  mux: vi.fn(),
  request: vi.fn()
}))
vi.mock('../ipc/preflight-command-exec', () => ({
  execCommandInWslOrThrow: execWsl,
  shellQuote: (value: string) => `'${value.replace(/'/g, "'\\''")}'`
}))
vi.mock('../ssh/ssh-target-registry', () => ({ getActiveMultiplexer: mux }))
vi.mock('./codex-cli-installation', () => ({ readCodexCliInstallation: local }))
vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCodexCommand: () => '/native/codex'
}))

const platform = process.platform
beforeEach(() => {
  execWsl.mockReset()
  local.mockReset()
  mux.mockReset()
  request.mockReset()
  mux.mockReturnValue({ isDisposed: () => false, request })
})
afterEach(() => Object.defineProperty(process, 'platform', { value: platform }))

function inWindows(): void {
  Object.defineProperty(process, 'platform', { value: 'win32' })
}

describe('Codex installation execution host ownership', () => {
  it('reads the same native binary the structured resolver selects', async () => {
    local.mockResolvedValue(codexCliInstallation(true, '0.136.0'))
    expect((await detectCodexInstallationOnHost()).status).toBe('ready')
    expect(local).toHaveBeenCalledWith({ program: '/native/codex' })
    expect(execWsl).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('probes and caches the guest binary separately for each WSL distro and update', async () => {
    inWindows()
    let stamp = 'first'
    execWsl.mockImplementation(async (target: { distro: string }, command: string) => ({
      stdout: command.endsWith('--version')
        ? target.distro === 'version-A'
          ? '0.135.0'
          : '0.136.0'
        : `__ORCA_CODEX_PATH__/guest/codex\n__ORCA_CODEX_STAMP__${stamp}\n`,
      stderr: ''
    }))
    expect(
      (await detectCodexInstallationOnHost({ context: { wslDistro: 'version-A' } })).status
    ).toBe('unsupported')
    expect(
      (await detectCodexInstallationOnHost({ context: { wslDistro: 'version-B' } })).status
    ).toBe('ready')
    await detectCodexInstallationOnHost({ context: { wslDistro: 'version-A' } })
    expect(execWsl.mock.calls.filter(([, script]) => script.endsWith('--version'))).toHaveLength(2)
    stamp = 'updated'
    await detectCodexInstallationOnHost({ context: { wslDistro: 'version-A' } })
    expect(execWsl.mock.calls.filter(([, script]) => script.endsWith('--version'))).toHaveLength(3)
    expect(execWsl.mock.calls[0]?.[1]).toContain('/proc/mounts')
    expect(local).not.toHaveBeenCalled()
  })

  it('keeps WSL missing, malformed output and contact loss distinct', async () => {
    inWindows()
    execWsl.mockResolvedValueOnce({ stdout: '__ORCA_CODEX_MISSING__\n' })
    expect(
      (await detectCodexInstallationOnHost({ context: { wslDistro: 'missing' } })).status
    ).toBe('missing')
    execWsl.mockResolvedValueOnce({ stdout: 'distro banner\n' })
    expect(
      (await detectCodexInstallationOnHost({ context: { wslDistro: 'malformed' } })).status
    ).toBe('unknown')
    execWsl.mockRejectedValueOnce(new Error('connection lost'))
    expect(
      (await detectCodexInstallationOnHost({ context: { wslDistro: 'unreachable' } })).status
    ).toBe('unknown')
  })

  it('asks the relay for the version on that SSH host and tolerates older peers', async () => {
    request.mockResolvedValueOnce({ agents: ['codex'], versions: { codex: '0.135.0' } })
    expect((await detectCodexInstallationOnHost({ connectionId: 'ssh-old' })).status).toBe(
      'unsupported'
    )
    request.mockResolvedValueOnce({ agents: ['codex'], versions: { codex: '0.136.0' } })
    expect((await detectCodexInstallationOnHost({ connectionId: 'ssh-new' })).status).toBe('ready')
    request.mockResolvedValueOnce({ agents: ['codex'] })
    expect((await detectCodexInstallationOnHost({ connectionId: 'ssh-older-relay' })).status).toBe(
      'unknown'
    )
    expect(request).toHaveBeenCalledWith('preflight.detectAgents', {
      commands: [{ id: 'codex', cmd: 'codex', reportVersion: true }]
    })
    expect(local).not.toHaveBeenCalled()
    expect(execWsl).not.toHaveBeenCalled()
  })

  it('does not interpret SSH contact loss as a missing or old install', async () => {
    request.mockRejectedValueOnce(new Error('disconnected'))
    expect((await detectCodexInstallationOnHost({ connectionId: 'ssh-disconnected' })).status).toBe(
      'unknown'
    )
    mux.mockReturnValueOnce(null)
    expect((await detectCodexInstallationOnHost({ connectionId: 'ssh-absent' })).status).toBe(
      'unknown'
    )
  })
})
